import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import zlib from 'node:zlib';
import jwt from 'jsonwebtoken';
import { appPool, adminPool } from '../src/db/client.js';
import { generateInvoicesCore } from '../src/routes/invoices.js';

const API_BASE = process.env.API_BASE_URL || 'http://localhost:5000';
const JWT_SECRET = process.env.JWT_SECRET || 'resihub_secret_key_2026';

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const VOP1_ID = '33333333-3333-4333-8333-000000000001'; // 64 active contracts
const VOP2_ID = '33333333-3333-4333-8333-000000000002'; // 57 active contracts
const VOP3_ID = '33333333-3333-4333-8333-000000000003'; // 50 active contracts

const ADMIN_ID = '22222222-2222-4222-8222-000000000001';
const OWNER_ID = '22222222-2222-4222-8222-000000000002';
const MGR_VOP1_ID = '22222222-2222-4222-8222-000000000011';
const MGR_VOP3_ID = '22222222-2222-4222-8222-000000000013';

function signToken(sub, role, buildingIds = []) {
  return jwt.sign(
    {
      sub,
      org_id: ORG_ID,
      role,
      roles: [role],
      building_ids: buildingIds,
    },
    JWT_SECRET,
    { expiresIn: '2h' }
  );
}

const tokens = {
  admin: signToken(ADMIN_ID, 'SYS_ADMIN'),
  owner: signToken(OWNER_ID, 'OWNER', [VOP1_ID, VOP2_ID, VOP3_ID]),
  mgrVop1: signToken(MGR_VOP1_ID, 'MANAGER', [VOP1_ID]),
  mgrVop3: signToken(MGR_VOP3_ID, 'MANAGER', [VOP3_ID]),
};

async function cleanupNov2026Invoices() {
  await adminPool.query(`
    DELETE FROM payment
    WHERE invoice_id IN (SELECT id FROM invoice WHERE period = '2026-11')
  `);
  await adminPool.query(`
    DELETE FROM receivable
    WHERE invoice_id IN (SELECT id FROM invoice WHERE period = '2026-11')
  `);
  await adminPool.query(`
    DELETE FROM invoice_line
    WHERE invoice_id IN (SELECT id FROM invoice WHERE period = '2026-11')
  `);
  await adminPool.query(`
    SELECT fn_sync_late_fee_trackers_on_invoice_void(id)
    FROM invoice
    WHERE period = '2026-11'
  `);
  await adminPool.query(`
    DELETE FROM invoice
    WHERE period = '2026-11'
  `);
}

test('Week 11-12 Performance Optimization & Parallel UAT Billing Cycle (2026-11)', async (t) => {
  let residentToken = null;

  t.before(async () => {
    await cleanupNov2026Invoices();
    const resUser = await adminPool.query(`
      SELECT u.id
      FROM app_user u
      JOIN person p ON p.id = u.person_id
      JOIN tenant t ON t.person_id = p.id
      JOIN contract c ON c.primary_tenant_id = t.id
      WHERE c.status = 'ACTIVE' AND c.building_id = $1
      LIMIT 1
    `, [VOP1_ID]);
    assert.ok(resUser.rows.length > 0, 'Phải tìm thấy tài khoản cư dân đang thuê tại VOP-1');
    residentToken = signToken(resUser.rows[0].id, 'RESIDENT', [VOP1_ID]);
  });

  t.after(async () => {
    await cleanupNov2026Invoices();
    await appPool.end();
    await adminPool.end();
  });

  await t.test('P1. HTTP Compression (Gzip) enabled on large JSON endpoints', async () => {
    const rawResp = await new Promise((resolve, reject) => {
      const req = http.request(
        `${API_BASE}/api/v1/invoices`,
        {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${tokens.owner}`,
            'Accept-Encoding': 'gzip, deflate',
          },
        },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () =>
            resolve({
              statusCode: res.statusCode,
              headers: res.headers,
              buffer: Buffer.concat(chunks),
            })
          );
        }
      );
      req.on('error', reject);
      req.end();
    });

    assert.equal(rawResp.statusCode, 200);
    assert.equal(
      rawResp.headers['content-encoding'],
      'gzip',
      `Expected Content-Encoding: gzip on large JSON response, got: ${rawResp.headers['content-encoding']}`
    );
    const decompressed = zlib.gunzipSync(rawResp.buffer).toString('utf8');
    const body = JSON.parse(decompressed);
    assert.ok(Array.isArray(body.data) && body.data.length > 1000, 'Should return full invoice list');
    assert.ok(
      rawResp.buffer.length < Buffer.byteLength(decompressed, 'utf8') * 0.2,
      `Gzip payload (${rawResp.buffer.length}B) should be < 20% of raw JSON (${Buffer.byteLength(decompressed, 'utf8')}B)`
    );
  });

  await t.test('P2. All Core API Endpoints respond in < 500ms across 4 roles (SYS_ADMIN, OWNER, MANAGER, RESIDENT)', async () => {
    const endpoints = [
      { name: 'GET /api/health', path: '/api/health', token: null },
      { name: 'GET /api/v1/reports/dashboard (OWNER)', path: '/api/v1/reports/dashboard?period=2026-10', token: tokens.owner },
      { name: 'GET /api/v1/reports/dashboard (MANAGER VOP-1)', path: `/api/v1/reports/dashboard?building_id=${VOP1_ID}&period=2026-10`, token: tokens.mgrVop1 },
      { name: 'GET /api/v1/reports/summary (OWNER)', path: '/api/v1/reports/summary?period=2026-10', token: tokens.owner },
      { name: 'GET /api/v1/reports/deposit-ledger (OWNER)', path: '/api/v1/reports/deposit-ledger', token: tokens.owner },
      { name: 'GET /api/v1/buildings (OWNER)', path: '/api/v1/buildings', token: tokens.owner },
      { name: 'GET /api/v1/apartments (MANAGER VOP-1)', path: `/api/v1/apartments?building_id=${VOP1_ID}`, token: tokens.mgrVop1 },
      { name: 'GET /api/v1/contracts (MANAGER VOP-1)', path: `/api/v1/contracts?building_id=${VOP1_ID}`, token: tokens.mgrVop1 },
      { name: 'GET /api/v1/tenants (MANAGER VOP-1)', path: `/api/v1/tenants?building_id=${VOP1_ID}`, token: tokens.mgrVop1 },
      { name: 'GET /api/v1/meters (MANAGER VOP-1, 2026-11)', path: `/api/v1/meters?building_id=${VOP1_ID}&period=2026-11`, token: tokens.mgrVop1 },
      { name: 'GET /api/v1/invoices (MANAGER VOP-1, 2026-10)', path: `/api/v1/invoices?building_id=${VOP1_ID}&period=2026-10`, token: tokens.mgrVop1 },
      { name: 'GET /api/v1/invoices (OWNER all buildings)', path: '/api/v1/invoices', token: tokens.owner },
      { name: 'GET /api/v1/payments (MANAGER VOP-1)', path: `/api/v1/payments?building_id=${VOP1_ID}`, token: tokens.mgrVop1 },
      { name: 'GET /api/v1/receivables (MANAGER VOP-1)', path: `/api/v1/receivables?building_id=${VOP1_ID}`, token: tokens.mgrVop1 },
      { name: 'GET /api/v1/deposits (MANAGER VOP-1)', path: `/api/v1/deposits?building_id=${VOP1_ID}`, token: tokens.mgrVop1 },
      { name: 'GET /api/v1/service-requests (MANAGER VOP-1)', path: `/api/v1/service-requests?building_id=${VOP1_ID}`, token: tokens.mgrVop1 },
      { name: 'GET /api/v1/audit-logs (SYS_ADMIN)', path: '/api/v1/audit-logs?limit=100', token: tokens.admin },
      { name: 'GET /api/v1/resident/overview (RESIDENT)', path: '/api/v1/resident/overview', token: residentToken },
    ];

    // Warm-up connection pool once
    await fetch(`${API_BASE}/api/health`);

    for (const ep of endpoints) {
      const headers = { 'Accept-Encoding': 'gzip' };
      if (ep.token) headers.Authorization = `Bearer ${ep.token}`;

      const t0 = performance.now();
      const res = await fetch(`${API_BASE}${ep.path}`, { headers });
      await res.arrayBuffer();
      const elapsedMs = performance.now() - t0;

      assert.equal(res.status, 200, `${ep.name} phải trả về HTTP 200 (nhận ${res.status})`);
      assert.ok(
        elapsedMs < 500,
        `SLA VIOLATION: ${ep.name} mất ${elapsedMs.toFixed(1)}ms (vượt ngưỡng 500ms)`
      );
    }
  });

  await t.test('P3. Batch Invoice Generation Engine < 500ms for VOP-1 (64 active contracts) & VOP-3 (50 active contracts)', async () => {
    // 1. Test VOP-1 (64 active contracts) with autoIssue=false in rolled-back transaction
    const client1 = await appPool.connect();
    try {
      await client1.query('BEGIN');
      await client1.query(`SELECT set_config('app.current_user_id', $1, true)`, [MGR_VOP1_ID]);

      const t0 = performance.now();
      const draftResult = await generateInvoicesCore(client1, {
        orgId: ORG_ID,
        actorId: MGR_VOP1_ID,
        buildingId: VOP1_ID,
        targetPeriod: '2026-11',
        autoIssue: false,
      });
      const draftMs = performance.now() - t0;

      assert.equal(draftResult.created_count, 64, 'VOP-1 phải sinh đủ 64 hóa đơn DRAFT');
      assert.ok(
        draftMs < 500,
        `SLA VIOLATION: generateInvoicesCore(VOP-1, 64 căn, autoIssue=false) mất ${draftMs.toFixed(1)}ms (yêu cầu < 500ms)`
      );
    } finally {
      await client1.query('ROLLBACK');
      client1.release();
    }

    // 2. Test VOP-1 (64 active contracts) with autoIssue=true in rolled-back transaction
    const client2 = await appPool.connect();
    try {
      await client2.query('BEGIN');
      await client2.query(`SELECT set_config('app.current_user_id', $1, true)`, [MGR_VOP1_ID]);

      const t0 = performance.now();
      const issuedResult = await generateInvoicesCore(client2, {
        orgId: ORG_ID,
        actorId: MGR_VOP1_ID,
        buildingId: VOP1_ID,
        targetPeriod: '2026-11',
        autoIssue: true,
      });
      const issuedMs = performance.now() - t0;

      assert.equal(issuedResult.created_count, 64, 'VOP-1 phải sinh và phát hành đủ 64 hóa đơn ISSUED');
      assert.ok(
        issuedMs < 500,
        `SLA VIOLATION: generateInvoicesCore(VOP-1, 64 căn, autoIssue=true) mất ${issuedMs.toFixed(1)}ms (yêu cầu < 500ms)`
      );
    } finally {
      await client2.query('ROLLBACK');
      client2.release();
    }

    // 3. Test VOP-3 (50 active contracts) with autoIssue=true in rolled-back transaction
    const client3 = await appPool.connect();
    try {
      await client3.query('BEGIN');
      await client3.query(`SELECT set_config('app.current_user_id', $1, true)`, [MGR_VOP3_ID]);

      const t0 = performance.now();
      const vop3Result = await generateInvoicesCore(client3, {
        orgId: ORG_ID,
        actorId: MGR_VOP3_ID,
        buildingId: VOP3_ID,
        targetPeriod: '2026-11',
        autoIssue: true,
      });
      const vop3Ms = performance.now() - t0;

      assert.equal(vop3Result.created_count, 50, 'VOP-3 phải sinh và phát hành đủ 50 hóa đơn ISSUED');
      assert.ok(
        vop3Ms < 500,
        `SLA VIOLATION: generateInvoicesCore(VOP-3, 50 căn, autoIssue=true) mất ${vop3Ms.toFixed(1)}ms (yêu cầu < 500ms)`
      );
    } finally {
      await client3.query('ROLLBACK');
      client3.release();
    }
  });

  await t.test('P4. Frontend Page Load & Initial Bundle Delivery < 2000ms', async () => {
    const FRONTEND_BASE = process.env.FRONTEND_BASE_URL || 'http://localhost:3000';
    const t0 = performance.now();
    const [htmlRes, mainRes, appRes, apiRes] = await Promise.all([
      fetch(`${FRONTEND_BASE}/`),
      fetch(`${FRONTEND_BASE}/src/main.jsx`),
      fetch(`${FRONTEND_BASE}/src/App.jsx`),
      fetch(`${ API_BASE }/api/v1/reports/dashboard?period=2026-10`, {
        headers: { Authorization: `Bearer ${tokens.owner}` },
      }),
    ]);
    await Promise.all([htmlRes.text(), mainRes.text(), appRes.text(), apiRes.json()]);
    const totalPageLoadMs = performance.now() - t0;

    assert.equal(htmlRes.status, 200, 'Frontend index.html phải trả về 200');
    assert.equal(mainRes.status, 200, 'Frontend main.jsx phải trả về 200');
    assert.equal(appRes.status, 200, 'Frontend App.jsx phải trả về 200');
    assert.equal(apiRes.status, 200, 'Initial dashboard API phải trả về 200');
    assert.ok(
      totalPageLoadMs < 2000,
      `SLA VIOLATION: Tổng thời gian tải trang Frontend + dữ liệu khởi tạo mất ${totalPageLoadMs.toFixed(1)}ms (vượt ngưỡng 2000ms)`
    );
  });

  await t.test('UAT-2026-11: Closed-Loop Parallel Billing Cycle Run (~50-64 apartments in 1 building)', async () => {
    await cleanupNov2026Invoices();

    // Step 1: Kiểm tra chỉ số điện/nước kỳ 2026-11 của tòa VOP-1 (64 căn đang thuê -> 128 đồng hồ)
    const metersRes = await fetch(
      `${API_BASE}/api/v1/meters?building_id=${VOP1_ID}&period=2026-11`,
      { headers: { Authorization: `Bearer ${tokens.mgrVop1}` } }
    );
    assert.equal(metersRes.status, 200);
    const metersBody = await metersRes.json();
    const confirmedMeters = metersBody.data.filter((m) => m.period_reading_status === 'CONFIRMED');
    assert.equal(
      confirmedMeters.length,
      128,
      `Tòa VOP-1 phải có đủ 128 đồng hồ (64 Điện + 64 Nước) đã chốt CONFIRMED kỳ 2026-11, thực tế: ${confirmedMeters.length}`
    );

    // Step 2: Sinh hóa đơn hàng loạt chế độ DRAFT qua HTTP POST /api/v1/invoices/generate-batch (< 500ms)
    const tGen0 = performance.now();
    const genRes = await fetch(`${API_BASE}/api/v1/invoices/generate-batch`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokens.mgrVop1}`,
      },
      body: JSON.stringify({
        building_id: VOP1_ID,
        period: '2026-11',
        auto_issue: false,
      }),
    });
    const genElapsedMs = performance.now() - tGen0;
    assert.equal(genRes.status, 201, 'POST /api/v1/invoices/generate-batch phải trả về 201');
    const genBody = await genRes.json();
    assert.equal(genBody.created_count, 64, 'Phải sinh đúng 64 hóa đơn DRAFT cho 64 hợp đồng ACTIVE tòa VOP-1');
    assert.equal(genBody.skipped_contracts.length, 0, 'Không có hợp đồng nào bị bỏ qua');
    assert.ok(
      genElapsedMs < 500,
      `HTTP POST /api/v1/invoices/generate-batch mất ${genElapsedMs.toFixed(1)}ms (vượt 500ms)`
    );

    // Step 3: Phát hành toàn bộ 64 hóa đơn từ DRAFT -> ISSUED qua lại API (hoặc generate-batch auto_issue)
    // Kiểm tra phát hành từng hóa đơn đầu tiên qua POST /api/v1/invoices/:id/issue (< 500ms)
    const firstDraftId = genBody.data[0].id;
    const tIssueOne0 = performance.now();
    const issueOneRes = await fetch(`${API_BASE}/api/v1/invoices/${firstDraftId}/issue`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokens.mgrVop1}`,
      },
      body: JSON.stringify({ note: 'UAT 2026-11 phát hành hóa đơn' }),
    });
    const issueOneMs = performance.now() - tIssueOne0;
    assert.equal(issueOneRes.status, 200);
    assert.ok(issueOneMs < 500, `POST /api/v1/invoices/:id/issue mất ${issueOneMs.toFixed(1)}ms`);

    // Phát hành 63 hóa đơn DRAFT còn lại
    const remainingIds = genBody.data.slice(1).map((inv) => inv.id);
    for (const invId of remainingIds) {
      const r = await fetch(`${API_BASE}/api/v1/invoices/${invId}/issue`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokens.mgrVop1}`,
        },
        body: JSON.stringify({}),
      });
      assert.equal(r.status, 200);
    }

    // Xác minh 64 khoản phải thu (receivable) đã được mở cho kỳ 2026-11
    const recCheck = await adminPool.query(`
      SELECT COUNT(*)::int AS rec_count,
             COALESCE(SUM(r.amount), 0)::bigint AS total_receivable,
             COALESCE(SUM(i.total_amount), 0)::bigint AS total_invoiced
      FROM invoice i
      JOIN receivable r ON r.invoice_id = i.id
      WHERE i.building_id = $1 AND i.period = '2026-11' AND i.status = 'ISSUED'
    `, [VOP1_ID]);
    assert.equal(recCheck.rows[0].rec_count, 64, 'Phải tạo đủ 64 bản ghi receivable tương ứng 64 hóa đơn ISSUED');
    assert.equal(
      recCheck.rows[0].total_receivable,
      recCheck.rows[0].total_invoiced,
      'Tổng công nợ gốc trên receivable phải khớp tuyệt đối 100% với tổng tiền hóa đơn ISSUED'
    );

    // Step 4: Gạch nợ / Thanh toán thực tế cho kỳ 2026-11:
    // - 52 căn đầu tiên: Thanh toán đủ 100% (PAID)
    // - 6 căn tiếp theo: Thanh toán 1 phần 50% (PARTIALLY_PAID)
    // - 6 căn cuối: Chưa thanh toán (ISSUED / OPEN receivable)
    const allInvoices = genBody.data;
    let expectedCollected = 0;

    for (let idx = 0; idx < 52; idx++) {
      const inv = allInvoices[idx];
      const payAmt = Number(inv.total_amount);
      expectedCollected += payAmt;
      const pRes = await fetch(`${API_BASE}/api/v1/payments`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokens.mgrVop1}`,
        },
        body: JSON.stringify({
          invoice_id: inv.id,
          amount: payAmt,
          method: 'BANK_TRANSFER',
          reference_code: `UAT-FULL-${idx + 1}`,
          note: 'Thanh toán đủ 100% kỳ 2026-11',
        }),
      });
      assert.equal(pRes.status, 201);
    }

    for (let idx = 52; idx < 58; idx++) {
      const inv = allInvoices[idx];
      const payAmt = Math.round(Number(inv.total_amount) * 0.5);
      expectedCollected += payAmt;
      const pRes = await fetch(`${API_BASE}/api/v1/payments`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokens.mgrVop1}`,
        },
        body: JSON.stringify({
          invoice_id: inv.id,
          amount: payAmt,
          method: 'QR_CODE',
          reference_code: `UAT-PART-${idx + 1}`,
          note: 'Thanh toán 50% kỳ 2026-11',
        }),
      });
      assert.equal(pRes.status, 201);
    }

    // Step 5: Đối soát Công nợ & Báo cáo Tổng hợp kỳ 2026-11
    const reconDb = await adminPool.query(`
      SELECT
        COUNT(*) FILTER (WHERE i.status = 'PAID')::int AS paid_count,
        COUNT(*) FILTER (WHERE i.status = 'PARTIALLY_PAID')::int AS partial_count,
        COUNT(*) FILTER (WHERE i.status = 'ISSUED')::int AS unpaid_count,
        COALESCE(SUM(i.total_amount), 0)::bigint AS total_billed,
        COALESCE(SUM(i.paid_amount), 0)::bigint AS total_paid,
        COALESCE(SUM(i.total_amount - i.paid_amount), 0)::bigint AS total_outstanding,
        (SELECT COALESCE(SUM(r.amount - r.paid_amount), 0)::bigint
         FROM receivable r
         JOIN invoice i2 ON i2.id = r.invoice_id
         WHERE i2.building_id = $1 AND i2.period = '2026-11') AS rec_outstanding
      FROM invoice i
      WHERE i.building_id = $1 AND i.period = '2026-11'
    `, [VOP1_ID]);

    const row = reconDb.rows[0];
    assert.equal(row.paid_count, 52, 'Phải có đúng 52 hóa đơn PAID');
    assert.equal(row.partial_count, 6, 'Phải có đúng 6 hóa đơn PARTIALLY_PAID');
    assert.equal(row.unpaid_count, 6, 'Phải có đúng 6 hóa đơn ISSUED chưa thu');
    assert.equal(Number(row.total_paid), expectedCollected, 'Tổng tiền đã thu trên invoice phải khớp 100% với tổng giao dịch payment');
    assert.equal(row.total_outstanding, row.rec_outstanding, 'Dư nợ còn lại trên invoice và receivable phải khớp tuyệt đối 100%');

    // Kiểm tra báo cáo /api/v1/reports/summary?building_id=VOP1_ID&period=2026-11 (< 500ms)
    const tSum0 = performance.now();
    const sumRes = await fetch(
      `${API_BASE}/api/v1/reports/summary?building_id=${VOP1_ID}&period=2026-11`,
      { headers: { Authorization: `Bearer ${tokens.mgrVop1}` } }
    );
    const sumElapsedMs = performance.now() - tSum0;
    assert.equal(sumRes.status, 200);
    assert.ok(sumElapsedMs < 500, `GET /api/v1/reports/summary mất ${sumElapsedMs.toFixed(1)}ms`);
    const sumBody = await sumRes.json();
    const nov2026Rev = (sumBody.data.revenue_12m || []).find((r) => r.period === '2026-11');
    assert.ok(nov2026Rev, 'Báo cáo summary.revenue_12m phải có mục kỳ 2026-11');
    assert.equal(
      Number(nov2026Rev.billed),
      Number(row.total_billed),
      'Báo cáo summary phải phản ánh chính xác tổng phát hành kỳ 2026-11'
    );
    assert.equal(
      Number(nov2026Rev.collected),
      Number(row.total_paid),
      'Báo cáo summary phải phản ánh chính xác tổng thực thu kỳ 2026-11'
    );
    assert.equal(
      Number(nov2026Rev.outstanding),
      Number(row.total_outstanding),
      'Báo cáo summary phải phản ánh chính xác dư nợ còn lại kỳ 2026-11'
    );
  });
});
