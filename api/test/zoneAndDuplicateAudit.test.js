import { test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import dotenv from 'dotenv';

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

test('Integration — FR-007 Khu (Zone) lifecycle & FR-021 Chặn trùng + Gộp hồ sơ có Audit', async (t) => {
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

  const phoneA = '0971110001';
  const phoneB = '0971110002';
  const phoneC = '0971110003';
  const cccdShared = '079200888999';
  const createdPersonIds = new Set();
  let createdZoneId = null;
  let testedAptId = null;
  let originalAptZoneId = null;

  async function cleanup() {
    if (testedAptId) {
      await adminPool.query('UPDATE apartment SET zone_id = $1 WHERE id = $2', [
        originalAptZoneId,
        testedAptId,
      ]);
    }
    if (createdZoneId) {
      await adminPool.query('UPDATE apartment SET zone_id = NULL WHERE zone_id = $1', [createdZoneId]);
      await adminPool.query('DELETE FROM zone WHERE id = $1', [createdZoneId]);
    }

    const pRes = await adminPool.query(
      `SELECT id FROM person
       WHERE phone = ANY($1::text[])
          OR id_number = $2
          OR id = ANY($3::uuid[])`,
      [[phoneA, phoneB, phoneC], cccdShared, Array.from(createdPersonIds)]
    );

    for (const row of pRes.rows) {
      const uRes = await adminPool.query('SELECT id FROM app_user WHERE person_id = $1', [row.id]);
      for (const u of uRes.rows) {
        await adminPool.query('DELETE FROM user_role WHERE user_id = $1', [u.id]);
        await adminPool.query('DELETE FROM app_user WHERE id = $1', [u.id]);
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

  const admin = await login('admin@resihub.vn', 'Admin@123456');
  const mgr = await login('manager.vop.a@resihub.vn', 'Demo@123456');

  await t.test('1. FR-007: Tạo Khu (Zone), gán căn hộ hiện hữu vào Khu, xem trên Floor Map, gỡ Khu và kiểm tra quyền Xóa Khu (RBAC 6.2)', async () => {
    const bList = await apiFetch('/api/v1/buildings', mgr.token);
    assert.equal(bList.status, 200);
    const vopA = bList.body.data[0];
    assert.ok(vopA, 'MANAGER VOP-A phải thấy tòa nhà được giao');

    // Tạo Khu mới
    const zoneCode = 'ZONE-AUDIT-E';
    await adminPool.query('DELETE FROM zone WHERE building_id = $1 AND code = $2', [vopA.id, zoneCode]);
    const zCreate = await apiFetch(`/api/v1/buildings/${vopA.id}/zones`, mgr.token, {
      method: 'POST',
      body: JSON.stringify({ code: zoneCode, name: 'Khu Đông Kiểm thử' }),
    });
    assert.equal(zCreate.status, 201, `Create zone failed: ${JSON.stringify(zCreate.body)}`);
    createdZoneId = zCreate.body.data.id;

    // Lấy 1 căn hộ hiện hữu trong tòa và gán vào Khu
    const aptList = await apiFetch(`/api/v1/apartments?building_id=${vopA.id}`, mgr.token);
    assert.equal(aptList.status, 200);
    const apt = aptList.body.data[0];
    testedAptId = apt.id;
    originalAptZoneId = apt.zone_id || null;

    const assignRes = await apiFetch(`/api/v1/apartments/${apt.id}`, mgr.token, {
      method: 'PATCH',
      body: JSON.stringify({ zone_id: createdZoneId }),
    });
    assert.equal(assignRes.status, 200);
    assert.equal(assignRes.body.data.zone_id, createdZoneId);

    // Kiểm tra GET /apartments/:id trả về zone_code & zone_name
    const aptDetail = await apiFetch(`/api/v1/apartments/${apt.id}`, mgr.token);
    assert.equal(aptDetail.status, 200);
    assert.equal(aptDetail.body.data.zone_code, zoneCode);

    // Kiểm tra GET /buildings/:id/floor-map cũng đính kèm zone_code cho căn hộ
    const fmRes = await apiFetch(`/api/v1/buildings/${vopA.id}/floor-map`, mgr.token);
    assert.equal(fmRes.status, 200);
    const flatApts = fmRes.body.data.flatMap((f) => f.apartments || []);
    const mappedApt = flatApts.find((a) => a.id === apt.id);
    assert.ok(mappedApt, 'Căn hộ phải xuất hiện trên sơ đồ tầng');
    assert.equal(mappedApt.zone_code, zoneCode, 'Floor map phải trả về zone_code của căn hộ');

    // SYS_ADMIN không thể xóa Khu khi đang chứa căn hộ
    const delNonEmpty = await apiFetch(`/api/v1/buildings/${vopA.id}/zones/${createdZoneId}`, admin.token, {
      method: 'DELETE',
    });
    assert.equal(delNonEmpty.status, 400);
    assert.equal(delNonEmpty.body.code, 'ZONE_HAS_APARTMENTS');

    // Gỡ phân khu khỏi căn hộ (zone_id: null)
    const unassignRes = await apiFetch(`/api/v1/apartments/${apt.id}`, mgr.token, {
      method: 'PATCH',
      body: JSON.stringify({ zone_id: null }),
    });
    assert.equal(unassignRes.status, 200);
    assert.equal(unassignRes.body.data.zone_id, null, 'PATCH zone_id: null phải gỡ được phân khu khỏi căn hộ');

    // Khôi phục zone gốc nếu có
    if (originalAptZoneId) {
      await apiFetch(`/api/v1/apartments/${apt.id}`, mgr.token, {
        method: 'PATCH',
        body: JSON.stringify({ zone_id: originalAptZoneId }),
      });
    }

    // MANAGER cố xóa Khu trống -> 403 DELETE_PROHIBITED (CRU only theo PRD 6.2)
    const mgrDel = await apiFetch(`/api/v1/buildings/${vopA.id}/zones/${createdZoneId}`, mgr.token, {
      method: 'DELETE',
    });
    assert.equal(mgrDel.status, 403);
    assert.equal(mgrDel.body.code, 'DELETE_PROHIBITED');

    // SYS_ADMIN xóa Khu trống -> 200 OK
    const adminDel = await apiFetch(`/api/v1/buildings/${vopA.id}/zones/${createdZoneId}`, admin.token, {
      method: 'DELETE',
    });
    assert.equal(adminDel.status, 200);
    createdZoneId = null;
  });

  await t.test('2. FR-021 & Mục 7.5: Chặn tạo mới khi trùng SĐT / CCCD, gộp hồ sơ có CCCD không lỗi 23505, bắt buộc lý do & lưu Audit Log', async () => {
    // Tạo hồ sơ A (chưa có CCCD -> PENDING)
    const resA = await apiFetch('/api/v1/tenants', mgr.token, {
      method: 'POST',
      body: JSON.stringify({
        full_name: 'Nguyễn Hồ Sơ Chính',
        phone: phoneA,
      }),
    });
    assert.equal(resA.status, 201);
    const tenantA = resA.body.data;
    createdPersonIds.add(tenantA.person_id);
    assert.equal(tenantA.status, 'PENDING');

    // Cố tình tạo mới cư dân trùng SĐT A (kể cả định dạng +84) -> PHẢI BỊ CHẶN 409 DUPLICATE_PHONE, KHÔNG được ghi đè tên
    const dupPhoneAttempt = await apiFetch('/api/v1/tenants', mgr.token, {
      method: 'POST',
      body: JSON.stringify({
        full_name: 'Kẻ Ghi Đè Tên Sai Nghiệp Vụ',
        phone: '+84 971-110-001',
      }),
    });
    assert.equal(dupPhoneAttempt.status, 409, 'Trùng SĐT phải bị chặn 409 theo PRD 7.5 & FR-021');
    assert.equal(dupPhoneAttempt.body.code, 'DUPLICATE_PHONE');
    assert.equal(dupPhoneAttempt.body.existing_person?.tenant_id, tenantA.id);

    // Đảm bảo tên gốc của Hồ Sơ A không bị ghi đè
    const checkA = await apiFetch(`/api/v1/tenants/${tenantA.id}`, mgr.token);
    assert.equal(checkA.body.data.full_name, 'Nguyễn Hồ Sơ Chính');

    // Tạo hồ sơ B (SĐT khác, nhưng có CCCD -> giả lập trường hợp khách đổi SĐT tạo thành 2 hồ sơ)
    const resB = await apiFetch('/api/v1/tenants', mgr.token, {
      method: 'POST',
      body: JSON.stringify({
        full_name: 'Nguyễn Hồ Sơ Trùng',
        phone: phoneB,
        id_number: cccdShared,
      }),
    });
    assert.equal(resB.status, 201);
    const tenantB = resB.body.data;
    createdPersonIds.add(tenantB.person_id);
    assert.equal(tenantB.status, 'APPROVED');

    // Cố tình tạo mới hồ sơ C trùng số CCCD của B -> PHẢI BỊ CHẶN 409 DUPLICATE_ID_NUMBER
    const dupIdAttempt = await apiFetch('/api/v1/tenants', mgr.token, {
      method: 'POST',
      body: JSON.stringify({
        full_name: 'Người Khác Trùng CCCD',
        phone: phoneC,
        id_number: cccdShared,
      }),
    });
    assert.equal(dupIdAttempt.status, 409);
    assert.equal(dupIdAttempt.body.code, 'DUPLICATE_ID_NUMBER');

    // Gộp hồ sơ thiếu lý do -> 400 REASON_REQUIRED (PRD 14.3: merge cần lý do + audit)
    const mergeNoReason = await apiFetch('/api/v1/tenants/merge', mgr.token, {
      method: 'POST',
      body: JSON.stringify({
        source_tenant_id: tenantB.id,
        target_tenant_id: tenantA.id,
        reason: '   ',
      }),
    });
    assert.equal(mergeNoReason.status, 400);
    assert.equal(mergeNoReason.body.code, 'REASON_REQUIRED');

    // Gộp hồ sơ B (có CCCD) vào hồ sơ A (chưa có CCCD) kèm lý do kiểm toán -> 200 OK (không dính lỗi 23505!)
    const mergeOk = await apiFetch('/api/v1/tenants/merge', mgr.token, {
      method: 'POST',
      body: JSON.stringify({
        source_tenant_id: tenantB.id,
        target_tenant_id: tenantA.id,
        reason: 'Khách thuê đổi SĐT nên phát sinh 2 hồ sơ, hợp nhất về hồ sơ chính',
      }),
    });
    assert.equal(mergeOk.status, 200, `Merge failed: ${JSON.stringify(mergeOk.body)}`);

    // Kiểm tra hồ sơ A đã nhận CCCD và tự lên APPROVED; hồ sơ B chuyển sang MERGED
    const afterA = await apiFetch(`/api/v1/tenants/${tenantA.id}`, mgr.token);
    assert.equal(afterA.body.data.id_number, cccdShared);
    assert.equal(afterA.body.data.status, 'APPROVED');

    const afterB = await apiFetch(`/api/v1/tenants/${tenantB.id}`, mgr.token);
    assert.equal(afterB.body.data.status, 'MERGED');

    // Kiểm tra check-dup với SĐT cũ của hồ sơ B đã gộp -> không còn báo trùng ảo
    const dupCheckOldPhone = await apiFetch(`/api/v1/tenants/check-dup?phone=${phoneB}`, mgr.token);
    assert.equal(dupCheckOldPhone.status, 200);
    assert.equal(dupCheckOldPhone.body.isDuplicate, false);

    // Kiểm tra audit_log bất biến ghi nhận MERGE_TENANT + lý do
    const auditRes = await adminPool.query(
      `SELECT * FROM audit_log WHERE entity = 'tenant' AND entity_id = $1 AND action = 'MERGE_TENANT' ORDER BY id DESC LIMIT 1`,
      [tenantA.id]
    );
    assert.equal(auditRes.rows.length, 1, 'Phải ghi nhận MERGE_TENANT vào audit_log');
    assert.match(JSON.stringify(auditRes.rows[0].after), /Khách thuê đổi SĐT/);
  });
});
