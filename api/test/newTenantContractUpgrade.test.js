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
