import { test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import dotenv from 'dotenv';
import { resolvePostSettlementStatus } from '../src/services/depositSettlement.js';

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
  return { token: body.accessToken, refreshToken: body.refreshToken, user: body.user };
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
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return { status: res.status, body: json };
}

test('Sprint 1 Bug 3 — resolvePostSettlementStatus phân biệt chuẩn REFUNDED vs PARTIALLY_REFUNDED', () => {
  // Hoàn đủ 100% cọc (không khấu trừ, không nợ) -> REFUNDED
  assert.equal(
    resolvePostSettlementStatus({
      refundAmount: 10000000n,
      outstandingDebt: 0n,
      items: [],
      shortfall: 0n,
    }),
    'REFUNDED'
  );

  // Hoàn một phần (cọc 10tr, khấu trừ hư hỏng 2tr, hoàn 8tr) -> PARTIALLY_REFUNDED
  assert.equal(
    resolvePostSettlementStatus({
      refundAmount: 8000000n,
      outstandingDebt: 0n,
      items: [{ amount: 2000000n }],
      shortfall: 0n,
    }),
    'PARTIALLY_REFUNDED'
  );

  // Hoàn 0đ (khấu trừ vượt cọc, shortfall > 0) -> REFUNDED (đã tất toán hết cọc, phần thiếu chuyển sang receivable)
  assert.equal(
    resolvePostSettlementStatus({
      refundAmount: 0n,
      outstandingDebt: 3000000n,
      items: [{ amount: 4000000n }],
      shortfall: 2000000n,
    }),
    'REFUNDED'
  );
});

test('Sprint 1 & 2 Integration — Anti-enumeration OTP, ServiceRequest table, M01/M07/M08/M09/M10/M14 APIs', async (t) => {
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

  try {
    // 1. Bug 2: OTP cho SĐT lạ trả thông điệp trung lập, KHÔNG tự động tạo person/app_user, KHÔNG rò rỉ devOtp
    const unknownPhone = '0987654399';
    await adminPool.query('DELETE FROM person WHERE phone = $1', [unknownPhone]);

    const otpUnknownRes = await apiFetch('/api/v1/auth/otp/request', null, {
      method: 'POST',
      body: JSON.stringify({ phone: unknownPhone }),
    });
    assert.equal(otpUnknownRes.status, 200);
    assert.equal(otpUnknownRes.body.devOtp, undefined, 'Không được trả devOtp cho SĐT không tồn tại');

    const checkCreated = await adminPool.query('SELECT 1 FROM person WHERE phone = $1', [unknownPhone]);
    assert.equal(checkCreated.rows.length, 0, 'SĐT lạ không được tự tạo bản ghi person');

    // 2. Đăng nhập các role chuẩn
    const sysAdmin = await login('admin@resihub.vn', 'Admin@123456');
    const ownerVop = await login('owner.vop@resihub.vn', 'Demo@123456');
    const mgrVopA = await login('manager.vop.a@resihub.vn', 'Demo@123456');
    const resident1 = await login('tenant1@resihub.vn', 'Demo@123456');

    // Kiểm tra /auth/refresh trả roles đầy đủ dạng object { code, name, building_id }
    const refreshRes = await apiFetch('/api/v1/auth/refresh', null, {
      method: 'POST',
      body: JSON.stringify({ refreshToken: mgrVopA.refreshToken }),
    });
    assert.equal(refreshRes.status, 200);
    assert.ok(Array.isArray(refreshRes.body.user.roles));
    assert.equal(typeof refreshRes.body.user.roles[0], 'object');
    assert.equal(refreshRes.body.user.roles[0].code, 'MANAGER');

    // 3. Bug 1: Cư dân tạo yêu cầu báo hỏng -> ghi vào bảng service_request (có tracking_code SR-...), không ghi giả vào audit_log
    const uniqueTitle = `Kiểm tra bản lề tủ bếp test ${Date.now()}`;
    const srCreate = await apiFetch('/api/v1/resident/service-requests', resident1.token, {
      method: 'POST',
      body: JSON.stringify({
        title: uniqueTitle,
        category: 'FURNITURE',
        priority: 'NORMAL',
        description: 'Bản lề cửa tủ bếp hơi lỏng cần vặn lại.',
      }),
    });
    assert.equal(srCreate.status, 201, `Create SR failed: ${JSON.stringify(srCreate.body)}`);
    const createdSr = srCreate.body.data;
    assert.ok(createdSr.id);
    assert.match(createdSr.tracking_code, /^SR-\d{8}-\d+$/);

    const dbSrCheck = await adminPool.query('SELECT * FROM service_request WHERE id = $1', [createdSr.id]);
    assert.equal(dbSrCheck.rows.length, 1, 'Phải lưu thực tế vào bảng service_request');

    // Kiểm tra cảnh báo trùng lặp AC-004.2
    const srDup = await apiFetch('/api/v1/resident/service-requests', resident1.token, {
      method: 'POST',
      body: JSON.stringify({
        title: 'Báo lần 2 cùng danh mục',
        category: 'FURNITURE',
        priority: 'NORMAL',
        description: 'Test duplicate warning',
      }),
    });
    assert.equal(srDup.status, 409);
    assert.equal(srDup.body.code, 'DUPLICATE_SERVICE_REQUEST');

    // Dọn bản ghi test SR để giữ sạch dữ liệu demo
    await adminPool.query('DELETE FROM service_request WHERE id = $1', [createdSr.id]);

    // 4. Kiểm tra các API Sprint 2 (M01, M07, M08, M09, M10, M11, M14) + phân quyền
    const [totalAptRow, mgrAptRow, ownerBldgRow] = await Promise.all([
      adminPool.query('SELECT COUNT(*)::int AS cnt FROM apartment'),
      adminPool.query(
        `SELECT COUNT(*)::int AS cnt FROM apartment
         WHERE building_id IN (
           SELECT ur.building_id FROM user_role ur
           JOIN role r ON r.id = ur.role_id
           WHERE ur.user_id = $1 AND r.code = 'MANAGER' AND ur.building_id IS NOT NULL
         )`,
        [mgrVopA.user.sub]
      ),
      adminPool.query(
        `SELECT COUNT(*)::int AS cnt FROM building b
         JOIN owner o ON o.id = b.owner_id
         JOIN app_user u ON u.person_id = o.person_id
         WHERE u.id = $1`,
        [ownerVop.user.sub]
      ),
    ]);

    const dashAdmin = await apiFetch('/api/v1/reports/dashboard', sysAdmin.token);
    assert.equal(dashAdmin.status, 200);
    assert.equal(dashAdmin.body.data.revenue_12m.length, 12, 'Biểu đồ doanh thu phải đủ 12 tháng (AC-018)');
    assert.equal(dashAdmin.body.data.kpis.total_apartments, totalAptRow.rows[0].cnt);

    const dashMgr = await apiFetch('/api/v1/reports/dashboard', mgrVopA.token);
    assert.equal(dashMgr.status, 200);
    assert.equal(dashMgr.body.data.kpis.total_apartments, mgrAptRow.rows[0].cnt, 'MANAGER VOP-A chỉ thấy đúng căn thuộc tòa được gán');

    const summaryOwner = await apiFetch('/api/v1/reports/summary', ownerVop.token);
    assert.equal(summaryOwner.status, 200);
    assert.equal(summaryOwner.body.data.occupancy_by_building.length, ownerBldgRow.rows[0].cnt, 'OWNER VOP chỉ thấy các tòa của mình');

    const metersMgr = await apiFetch('/api/v1/meters', mgrVopA.token);
    assert.equal(metersMgr.status, 200);
    assert.ok(metersMgr.body.data.length > 0, 'Có đồng hồ điện/nước cho các căn đang thuê');

    const abnormalReadings = await apiFetch('/api/v1/meters/readings?abnormal_only=true', sysAdmin.token);
    assert.equal(abnormalReadings.status, 200);
    assert.ok(abnormalReadings.body.data.length > 0, 'Có dữ liệu cảnh báo sản lượng bất thường >30% (FR-031)');

    const catalogRes = await apiFetch('/api/v1/service-catalog', mgrVopA.token);
    assert.equal(catalogRes.status, 200);
    assert.ok(catalogRes.body.data.length >= 7);

    const subsRes = await apiFetch('/api/v1/service-subscriptions', mgrVopA.token);
    assert.equal(subsRes.status, 200);
    assert.ok(Array.isArray(subsRes.body.data));

    const invRes = await apiFetch('/api/v1/invoices', mgrVopA.token);
    assert.equal(invRes.status, 200);
    assert.ok(invRes.body.data.length > 0);

    const recRes = await apiFetch('/api/v1/receivables', sysAdmin.token);
    assert.equal(recRes.status, 200);
    assert.ok(recRes.body.aging_summary !== undefined);

    const payRes = await apiFetch('/api/v1/payments', sysAdmin.token);
    assert.equal(payRes.status, 200);
    assert.ok(payRes.body.data.length > 0);

    const usersAdmin = await apiFetch('/api/v1/admin/users', sysAdmin.token);
    assert.equal(usersAdmin.status, 200);
    assert.ok(usersAdmin.body.data.length >= 10);

    const usersMgrForbidden = await apiFetch('/api/v1/admin/users', mgrVopA.token);
    assert.equal(usersMgrForbidden.status, 403, 'MANAGER không được phép truy cập /admin/users');

    const settingsRes = await apiFetch('/api/v1/settings', sysAdmin.token);
    assert.equal(settingsRes.status, 200);
    assert.ok(settingsRes.body.data.billing_config);
    assert.ok(settingsRes.body.data.sla_config);
    assert.ok(settingsRes.body.data.contact_config);

    // Kiểm tra Resident Portal APIs mới
    const resOverview = await apiFetch('/api/v1/resident/overview', resident1.token);
    assert.equal(resOverview.status, 200);
    assert.ok(resOverview.body.data.current_amount_due !== undefined, 'Cổng cư dân P1 phải có current_amount_due (AC-002.1)');

    const resInvoices = await apiFetch('/api/v1/resident/invoices', resident1.token);
    assert.equal(resInvoices.status, 200);
    assert.ok(Array.isArray(resInvoices.body.data));
  } finally {
    await adminPool.end();
  }
});
