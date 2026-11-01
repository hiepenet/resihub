import { test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import dotenv from 'dotenv';
import { normalizeVnPhone } from '../src/services/residentAccount.js';

dotenv.config();

const API_BASE = process.env.TEST_API_BASE || 'http://127.0.0.1:5000';
const ADMIN_DB_URL =
  process.env.DATABASE_URL ||
  'postgres://postgres:postgres@127.0.0.1:5433/resihub';

async function login(email, password) {
  const res = await fetch(`${API_BASE}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const body = await res.json();
  assert.equal(res.status, 200, `Login failed for ${email}: ${JSON.stringify(body)}`);
  return { token: body.accessToken, user: body.user };
}

async function apiFetch(path, token, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {}),
    },
  });
  const body = await res.json();
  return { status: res.status, body };
}

test('Unit — normalizeVnPhone chuẩn hóa SĐT Việt Nam sang 10 số bắt đầu bằng 0', () => {
  assert.equal(normalizeVnPhone('+84912345678'), '0912345678');
  assert.equal(normalizeVnPhone('84912345678'), '0912345678');
  assert.equal(normalizeVnPhone('0912 345-678'), '0912345678');
});

test('Integration — Tạo hợp đồng trực tiếp cho cư dân mới (inline new_tenant) + tự cấp tài khoản RESIDENT', async (t) => {
  let healthOk = false;
  try {
    const h = await fetch(`${API_BASE}/api/health`);
    healthOk = h.ok;
  } catch {
    healthOk = false;
  }
  if (!healthOk) {
    t.skip('API server not reachable');
    return;
  }

  const adminPool = new pg.Pool({ connectionString: ADMIN_DB_URL });
  const testPhone1 = '0968991122';
  const testEmail1 = 'new.resident.inline@resihub.vn';
  const testCccd1 = '001202991122';

  const testPhone2 = '0968993344';
  const testEmail2 = 'new.resident.direct@resihub.vn';
  const testCccd2 = '001202993344';

  let createdContractId = null;

  async function cleanup() {
    if (createdContractId) {
      await adminPool.query('DELETE FROM contract WHERE id = $1', [createdContractId]);
    }
    const pRes = await adminPool.query(
      'SELECT id FROM person WHERE phone = ANY($1::text[]) OR email = ANY($2::text[])',
      [[testPhone1, testPhone2], [testEmail1, testEmail2]]
    );
    for (const row of pRes.rows) {
      await adminPool.query(
        'DELETE FROM contract WHERE primary_tenant_id IN (SELECT id FROM tenant WHERE person_id = $1)',
        [row.id]
      );
      const uRes = await adminPool.query('SELECT id FROM app_user WHERE person_id = $1', [row.id]);
      for (const u of uRes.rows) {
        await adminPool.query('DELETE FROM user_role WHERE user_id = $1', [u.id]);
        await adminPool.query('DELETE FROM app_user WHERE id = $1', [u.id]);
      }
      await adminPool.query('DELETE FROM tenant WHERE person_id = $1', [row.id]);
      await adminPool.query('DELETE FROM person WHERE id = $1', [row.id]);
    }
  }

  try {
    await cleanup();

    const mgr = await login('manager.vop.a@resihub.vn', 'Demo@123456');

    // Lấy 1 căn hộ AVAILABLE không có hợp đồng tương lai ở VOP-A
    const aptsRes = await apiFetch('/api/v1/apartments?status=AVAILABLE&limit=20', mgr.token);
    assert.equal(aptsRes.status, 200);
    const targetApt = aptsRes.body.data[0];
    assert.ok(targetApt, 'Cần ít nhất 1 căn AVAILABLE tại VOP-A');

    // 1. Tạo hợp đồng nháp kèm thông tin cư dân mới trong 1 bước duy nhất
    const createContractRes = await apiFetch('/api/v1/contracts', mgr.token, {
      method: 'POST',
      body: JSON.stringify({
        apartment_id: targetApt.id,
        building_id: targetApt.building_id,
        new_tenant: {
          full_name: 'Nguyễn Minh Cư Dân Mới',
          phone: '+84 968 991 122',
          id_number: testCccd1,
          email: testEmail1,
          nationality: 'Việt Nam',
          address: 'Số 10 Đại Cồ Việt, Hà Nội',
          password: 'Resident@123',
        },
        start_date: '2027-06-01',
        end_date: '2028-06-01',
        rent_amount: Number(targetApt.base_rent || 8000000),
        deposit_amount: Number(targetApt.base_rent || 8000000),
        billing_day: 5,
        note: 'Tạo hợp đồng trực tiếp cho cư dân mới chưa có trong hệ thống',
      }),
    });

    assert.equal(
      createContractRes.status,
      201,
      `Tạo HĐ với new_tenant thất bại: ${JSON.stringify(createContractRes.body)}`
    );
    createdContractId = createContractRes.body.data.id;
    assert.equal(createContractRes.body.data.status, 'DRAFT');
    assert.ok(createContractRes.body.data.primary_tenant_id);
    assert.equal(createContractRes.body.created_tenant?.status, 'APPROVED');

    // Kiểm tra DB đã có sẵn app_user ACTIVE + role RESIDENT ngay lập tức
    const dbCheck1 = await adminPool.query(
      `SELECT p.phone, au.id AS user_id, au.status, r.code AS role_code
       FROM person p
       JOIN app_user au ON au.person_id = p.id
       JOIN user_role ur ON ur.user_id = au.id
       JOIN role r ON r.id = ur.role_id
       WHERE p.phone = $1`,
      [testPhone1]
    );
    assert.ok(dbCheck1.rows.length >= 1, 'Phải tự động tạo app_user và user_role cho cư dân mới');
    assert.equal(dbCheck1.rows[0].status, 'ACTIVE');
    assert.equal(dbCheck1.rows[0].role_code, 'RESIDENT');

    // Cư dân mới đăng nhập được ngay bằng Email + Mật khẩu ban đầu
    const emailLoginRes = await login(testEmail1, 'Resident@123');
    assert.ok(emailLoginRes.token);
    assert.ok(emailLoginRes.user.roles.some((r) => r.code === 'RESIDENT'));

    // Cư dân mới đăng nhập được ngay bằng SĐT + OTP
    const otpReq = await apiFetch('/api/v1/auth/otp/request', null, {
      method: 'POST',
      body: JSON.stringify({ phone: testPhone1 }),
    });
    assert.equal(otpReq.status, 200);
    assert.ok(otpReq.body.devOtp, 'Cư dân mới đã đăng ký phải nhận được mã OTP');

    const otpVerify = await apiFetch('/api/v1/auth/otp/verify', null, {
      method: 'POST',
      body: JSON.stringify({ phone: testPhone1, otp: otpReq.body.devOtp }),
    });
    assert.equal(otpVerify.status, 200);
    assert.ok(otpVerify.body.accessToken);

    // 2. Tạo hồ sơ trực tiếp qua POST /api/v1/tenants cũng chuẩn hóa SĐT & tự tạo tài khoản RESIDENT
    const directTenantRes = await apiFetch('/api/v1/tenants', mgr.token, {
      method: 'POST',
      body: JSON.stringify({
        full_name: 'Trần Thị Khách Mới',
        phone: '+84968993344',
        id_number: testCccd2,
        email: testEmail2,
      }),
    });
    assert.equal(directTenantRes.status, 201);

    const dbCheck2 = await adminPool.query(
      `SELECT p.phone, au.status, r.code AS role_code
       FROM person p
       JOIN app_user au ON au.person_id = p.id
       JOIN user_role ur ON ur.user_id = au.id
       JOIN role r ON r.id = ur.role_id
       WHERE p.phone = $1`,
      [testPhone2]
    );
    assert.ok(dbCheck2.rows.length >= 1, 'POST /tenants cũng phải tự tạo app_user + role RESIDENT');
    assert.equal(dbCheck2.rows[0].role_code, 'RESIDENT');
  } finally {
    await cleanup();
    await adminPool.end();
  }
});

test('Task 5 — Occupant lifecycle in contracts: PENDING without CCCD, upgrade to APPROVED, 409 duplicate CCCD, inline occupants[] & RESIDENT PII masking', async (t) => {
  let healthOk = false;
  try {
    const h = await fetch(`${API_BASE}/api/health`);
    healthOk = h.ok;
  } catch {
    healthOk = false;
  }
  if (!healthOk) {
    t.skip('API server not reachable');
    return;
  }

  const adminPool = new pg.Pool({ connectionString: ADMIN_DB_URL });
  const primaryPhone = '0961050001';
  const primaryCccd = '001205050001';
  const occNoIdPhone = '0961050002';
  const occNoIdLaterCccd = '001205050002';
  const occWithIdPhone = '0961050003';
  const occWithIdCccd = '001205050003';
  const conflictPhone = '0961050004';

  const allPhones = [primaryPhone, occNoIdPhone, occWithIdPhone, conflictPhone];
  const allCccds = [primaryCccd, occNoIdLaterCccd, occWithIdCccd];
  const createdContractIds = [];

  async function cleanup() {
    for (const cId of createdContractIds) {
      await adminPool.query('DELETE FROM contract_occupant WHERE contract_id = $1', [cId]);
      await adminPool.query('DELETE FROM contract WHERE id = $1', [cId]);
    }
    const pRes = await adminPool.query(
      'SELECT id FROM person WHERE phone = ANY($1::text[]) OR id_number = ANY($2::text[])',
      [allPhones, allCccds]
    );
    for (const row of pRes.rows) {
      await adminPool.query(
        'DELETE FROM contract_occupant WHERE tenant_id IN (SELECT id FROM tenant WHERE person_id = $1)',
        [row.id]
      );
      await adminPool.query(
        'DELETE FROM contract WHERE primary_tenant_id IN (SELECT id FROM tenant WHERE person_id = $1)',
        [row.id]
      );
      const uRes = await adminPool.query('SELECT id FROM app_user WHERE person_id = $1', [row.id]);
      for (const u of uRes.rows) {
        await adminPool.query('DELETE FROM user_role WHERE user_id = $1', [u.id]);
        const hasAudit = await adminPool.query('SELECT 1 FROM audit_log WHERE actor_id = $1 LIMIT 1', [u.id]);
        if (hasAudit.rows.length === 0) {
          await adminPool.query('DELETE FROM app_user WHERE id = $1', [u.id]);
        } else {
          await adminPool.query('UPDATE app_user SET person_id = NULL, auth_uid = $2 WHERE id = $1', [
            u.id,
            `archived_${u.id}`,
          ]);
        }
      }
      await adminPool.query('DELETE FROM tenant WHERE person_id = $1', [row.id]);
      await adminPool.query('DELETE FROM person WHERE id = $1', [row.id]);
    }
  }

  t.after(async () => {
    await cleanup();
    await adminPool.end();
  });

  await cleanup();

  const mgr = await login('manager.vop.a@resihub.vn', 'Demo@123456');
  const ownerVop = await login('owner.vop@resihub.vn', 'Demo@123456');

  const aptsRes = await apiFetch('/api/v1/apartments?status=AVAILABLE&limit=20', mgr.token);
  assert.equal(aptsRes.status, 200);
  const apt1 = aptsRes.body.data[0];
  const apt2 = aptsRes.body.data[1] || apt1;
  assert.ok(apt1, 'Need at least 1 AVAILABLE apartment');

  // 1. Create contract WITH inline occupants[] (one WITHOUT id_number -> PENDING, one WITH id_number -> APPROVED)
  const createContractRes = await apiFetch('/api/v1/contracts', mgr.token, {
    method: 'POST',
    body: JSON.stringify({
      apartment_id: apt1.id,
      building_id: apt1.building_id,
      new_tenant: {
        full_name: 'Khách Chính Task 5',
        phone: primaryPhone,
        id_number: primaryCccd,
      },
      occupants: [
        {
          full_name: 'Thành Viên Chưa Có CCCD',
          phone: occNoIdPhone,
          relationship: 'spouse',
        },
        {
          full_name: 'Thành Viên Có Đủ CCCD',
          phone: occWithIdPhone,
          relationship: 'roommate',
          id_number: occWithIdCccd,
        },
      ],
      start_date: '2029-01-01',
      end_date: '2029-12-31',
      rent_amount: Number(apt1.base_rent || 8000000),
      deposit_amount: Number(apt1.base_rent || 8000000),
    }),
  });
  assert.equal(createContractRes.status, 201, `Create contract failed: ${JSON.stringify(createContractRes.body)}`);
  const contractId = createContractRes.body.data.id;
  createdContractIds.push(contractId);

  // Verify both inline occupants were created & attached with proper statuses (PENDING vs APPROVED)
  const occListMgr = await apiFetch(`/api/v1/contracts/${contractId}/occupants`, mgr.token);
  assert.equal(occListMgr.status, 200);
  assert.equal(occListMgr.body.data.length, 2, 'POST /contracts with occupants[] must attach 2 occupants');

  const occNoIdRow = occListMgr.body.data.find((o) => o.phone === occNoIdPhone);
  const occWithIdRow = occListMgr.body.data.find((o) => o.phone === occWithIdPhone);
  assert.ok(occNoIdRow, 'Occupant without CCCD must be attached');
  assert.ok(occWithIdRow, 'Occupant with CCCD must be attached');

  const dbStatuses1 = await adminPool.query(
    `SELECT p.phone, t.status
     FROM tenant t JOIN person p ON p.id = t.person_id
     WHERE t.id = ANY($1::uuid[])`,
    [[occNoIdRow.tenant_id, occWithIdRow.tenant_id]]
  );
  const statusMap1 = Object.fromEntries(dbStatuses1.rows.map((r) => [r.phone, r.status]));
  assert.equal(statusMap1[occNoIdPhone], 'PENDING', 'Occupant without id_number must have status = PENDING');
  assert.equal(statusMap1[occWithIdPhone], 'APPROVED', 'Occupant with id_number must have status = APPROVED');

  // 2. Adding an occupant via POST /:id/occupants with duplicate id_number of another person -> 409 DUPLICATE_ID_NUMBER (not 500)
  const dupIdAdd = await apiFetch(`/api/v1/contracts/${contractId}/occupants`, mgr.token, {
    method: 'POST',
    body: JSON.stringify({
      full_name: 'Người Khác Trùng CCCD',
      phone: conflictPhone,
      relationship: 'friend',
      id_number: primaryCccd,
    }),
  });
  assert.equal(dupIdAdd.status, 409, `Expected 409 on duplicate CCCD, got ${dupIdAdd.status}: ${JSON.stringify(dupIdAdd.body)}`);
  assert.equal(dupIdAdd.body.code, 'DUPLICATE_ID_NUMBER');

  // 3. Adding an occupant via POST /:id/occupants WITHOUT id_number on a second contract -> status = PENDING,
  //    and re-linking occNoIdPhone WITH id_number upgrades status from PENDING -> APPROVED
  const createContract2 = await apiFetch('/api/v1/contracts', mgr.token, {
    method: 'POST',
    body: JSON.stringify({
      apartment_id: apt2.id,
      building_id: apt2.building_id,
      primary_tenant_id: createContractRes.body.data.primary_tenant_id,
      start_date: '2030-01-01',
      end_date: '2030-12-31',
      rent_amount: Number(apt2.base_rent || 8000000),
    }),
  });
  assert.equal(createContract2.status, 201);
  const contractId2 = createContract2.body.data.id;
  createdContractIds.push(contractId2);

  // Add brand-new occupant without id_number via POST /:id/occupants
  const addNewNoId = await apiFetch(`/api/v1/contracts/${contractId2}/occupants`, mgr.token, {
    method: 'POST',
    body: JSON.stringify({
      full_name: 'Bạn Mới Chưa Đem CCCD',
      phone: conflictPhone,
      relationship: 'friend',
    }),
  });
  assert.equal(addNewNoId.status, 201);
  const dbNewNoId = await adminPool.query('SELECT status FROM tenant WHERE id = $1', [addNewNoId.body.data.tenant_id]);
  assert.equal(dbNewNoId.rows[0].status, 'PENDING', 'POST /:id/occupants without id_number must set status = PENDING');

  // Re-use occNoIdPhone on contract2 while supplying occNoIdLaterCccd -> upgrades tenant status to APPROVED
  const upgradeOcc = await apiFetch(`/api/v1/contracts/${contractId2}/occupants`, mgr.token, {
    method: 'POST',
    body: JSON.stringify({
      full_name: 'Thành Viên Chưa Có CCCD',
      phone: occNoIdPhone,
      relationship: 'spouse',
      id_number: occNoIdLaterCccd,
    }),
  });
  assert.equal(upgradeOcc.status, 201);
  const dbUpgraded = await adminPool.query('SELECT status FROM tenant WHERE id = $1', [occNoIdRow.tenant_id]);
  assert.equal(dbUpgraded.rows[0].status, 'APPROVED', 'Supplying id_number for PENDING occupant must upgrade status to APPROVED');

  // 4. RESIDENT (and OWNER) calling GET /api/v1/contracts/:id/occupants:
  //    - Primary resident sees masked id_number for other occupants
  //    - Occupant resident sees FULL id_number for self, but MASKED id_number for roommate
  //    - OWNER sees masked id_number for all occupants (PRD 13.5)
  const otpReqPrimary = await apiFetch('/api/v1/auth/otp/request', null, {
    method: 'POST',
    body: JSON.stringify({ phone: primaryPhone }),
  });
  const otpVerPrimary = await apiFetch('/api/v1/auth/otp/verify', null, {
    method: 'POST',
    body: JSON.stringify({ phone: primaryPhone, otp: otpReqPrimary.body.devOtp }),
  });
  assert.equal(otpVerPrimary.status, 200);

  const occListAsPrimary = await apiFetch(`/api/v1/contracts/${contractId}/occupants`, otpVerPrimary.body.accessToken);
  assert.equal(occListAsPrimary.status, 200);
  const roommateSeenByPrimary = occListAsPrimary.body.data.find((o) => o.phone === occWithIdPhone);
  assert.ok(roommateSeenByPrimary);
  assert.notEqual(roommateSeenByPrimary.id_number, occWithIdCccd, 'Primary resident must NOT see raw id_number of roommate');
  assert.ok(roommateSeenByPrimary.id_number.endsWith('0003') && roommateSeenByPrimary.id_number.includes('*'));

  const otpReqOcc = await apiFetch('/api/v1/auth/otp/request', null, {
    method: 'POST',
    body: JSON.stringify({ phone: occWithIdPhone }),
  });
  assert.equal(otpReqOcc.status, 200, 'Inline occupant must also get OTP RESIDENT account');
  const otpVerOcc = await apiFetch('/api/v1/auth/otp/verify', null, {
    method: 'POST',
    body: JSON.stringify({ phone: occWithIdPhone, otp: otpReqOcc.body.devOtp }),
  });
  assert.equal(otpVerOcc.status, 200);

  const occListAsOcc = await apiFetch(`/api/v1/contracts/${contractId}/occupants`, otpVerOcc.body.accessToken);
  assert.equal(occListAsOcc.status, 200);
  const selfRow = occListAsOcc.body.data.find((o) => o.phone === occWithIdPhone);
  const otherOccRow = occListAsOcc.body.data.find((o) => o.phone === occNoIdPhone);
  assert.equal(selfRow.id_number, occWithIdCccd, 'Occupant must see own full id_number');
  assert.notEqual(otherOccRow.id_number, occNoIdLaterCccd, 'Occupant must NOT see raw id_number of another occupant');
  assert.ok(otherOccRow.id_number.endsWith('0002') && otherOccRow.id_number.includes('*'));

  const occListAsOwner = await apiFetch(`/api/v1/contracts/${contractId}/occupants`, ownerVop.token);
  assert.equal(occListAsOwner.status, 200);
  const occSeenByOwner = occListAsOwner.body.data.find((o) => o.phone === occWithIdPhone);
  assert.notEqual(occSeenByOwner.id_number, occWithIdCccd, 'OWNER must NOT see raw occupant id_number');
  assert.ok(occSeenByOwner.id_number.endsWith('0003') && occSeenByOwner.id_number.includes('*'));
});
