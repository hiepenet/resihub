import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';

dotenv.config({ path: fileURLToPath(new URL('../.env', import.meta.url)) });
dotenv.config();
if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = 'postgres://postgres:postgres@127.0.0.1:5433/resihub';
}
if (!process.env.APP_DATABASE_URL) {
  process.env.APP_DATABASE_URL =
    'postgres://resihub_app:resihub_app_secret@127.0.0.1:5433/resihub';
}

function getTodayVn() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Ho_Chi_Minh',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function shiftDays(ymd, deltaDays) {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + deltaDays));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(
    dt.getUTCDate()
  ).padStart(2, '0')}`;
}

function shiftMonthsPeriod(ym, deltaMonths) {
  const [y, m] = ym.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1 + deltaMonths, 1));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}`;
}

function periodEnd(ym) {
  const [y, m] = ym.split('-').map(Number);
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${ym}-${String(lastDay).padStart(2, '0')}`;
}

test('Week 8 M14 Dashboard Charts API: revenue_by_source, PRD receivables_aging, occupancy_12m & RBAC isolation', async (t) => {
  const { adminPool, appPool } = await import('../src/db/client.js');
  const { default: authRoute } = await import('../src/routes/auth.js');
  const { default: reportsRoute } = await import('../src/routes/reports.js');

  const app = express();
  app.use(cors());
  app.use(express.json());
  app.use('/api/v1/auth', authRoute);
  app.use('/api/v1/reports', reportsRoute);

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const API_BASE = `http://127.0.0.1:${server.address().port}`;

  async function apiFetch(urlPath, token, options = {}) {
    const headers = {
      'Content-Type': 'application/json',
      'Idempotency-Key': crypto.randomUUID(),
      ...(options.headers || {}),
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(`${API_BASE}${urlPath}`, { ...options, headers });
    const text = await res.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = { raw: text };
    }
    return { status: res.status, body };
  }

  const suffix = `${Date.now().toString().slice(-6)}_${Math.floor(Math.random() * 1000)}`;
  const cleanup = {
    orgIds: [],
    buildingIds: [],
    apartmentIds: [],
    contractIds: [],
    tenantIds: [],
    userIds: [],
    personIds: [],
    ownerIds: [],
    invoiceIds: [],
  };

  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    const cleanClient = await adminPool.connect();
    try {
      await cleanClient.query("SET app.allow_test_cleanup = 'true'");
      for (const oId of cleanup.orgIds) {
        await cleanClient.query('DELETE FROM invoice_line WHERE invoice_id IN (SELECT id FROM invoice WHERE org_id = $1)', [oId]).catch(() => {});
        await cleanClient.query('DELETE FROM credit_balance WHERE org_id = $1', [oId]).catch(() => {});
        await cleanClient.query('DELETE FROM invoice_adjustment WHERE org_id = $1', [oId]).catch(() => {});
        await cleanClient.query('DELETE FROM receivable WHERE org_id = $1', [oId]).catch(() => {});
        await cleanClient.query('DELETE FROM payment WHERE org_id = $1', [oId]).catch(() => {});
        await cleanClient.query('DELETE FROM invoice WHERE org_id = $1', [oId]).catch(() => {});
      }
      for (const bId of cleanup.buildingIds) {
        await cleanClient.query('DELETE FROM contract WHERE building_id = $1', [bId]).catch(() => {});
        await cleanClient.query('DELETE FROM apartment WHERE building_id = $1', [bId]).catch(() => {});
      }
      for (const uId of cleanup.userIds) {
        await cleanClient.query('DELETE FROM audit_log WHERE actor_id = $1', [uId]).catch(() => {});
        await cleanClient.query('DELETE FROM user_role WHERE user_id = $1', [uId]).catch(() => {});
      }
      for (const bId of cleanup.buildingIds) {
        await cleanClient.query('UPDATE building SET owner_id = NULL WHERE id = $1', [bId]).catch(() => {});
      }
      for (const oId of cleanup.orgIds) {
        await cleanClient.query('DELETE FROM owner WHERE org_id = $1', [oId]).catch(() => {});
        await cleanClient.query('DELETE FROM tenant WHERE org_id = $1', [oId]).catch(() => {});
      }
      for (const uId of cleanup.userIds) {
        await cleanClient.query('DELETE FROM app_user WHERE id = $1', [uId]).catch(() => {});
      }
      for (const pId of cleanup.personIds) {
        await cleanClient.query('DELETE FROM person WHERE id = $1', [pId]).catch(() => {});
      }
      for (const oId of cleanup.orgIds) {
        await cleanClient.query('DELETE FROM system_setting WHERE org_id = $1', [oId]).catch(() => {});
        await cleanClient.query('DELETE FROM building WHERE org_id = $1', [oId]).catch(() => {});
        await cleanClient.query('DELETE FROM organization WHERE id = $1', [oId]).catch(() => {});
      }
    } finally {
      await cleanClient.query('RESET app.allow_test_cleanup').catch(() => {});
      cleanClient.release();
      await adminPool.end().catch(() => {});
      await appPool.end().catch(() => {});
    }
  });

  const orgRes = await adminPool.query(
    `INSERT INTO organization (name) VALUES ($1) RETURNING id`,
    [`Org_W8_${suffix}`]
  );
  const orgId = orgRes.rows[0].id;
  cleanup.orgIds.push(orgId);

  const bldgARes = await adminPool.query(
    `INSERT INTO building (org_id, name, code, address, status)
     VALUES ($1, $2, $3, '10 A St', 'ACTIVE') RETURNING id`,
    [orgId, `BldgA_W8_${suffix}`, `BA_${suffix}`]
  );
  const bldgAId = bldgARes.rows[0].id;
  cleanup.buildingIds.push(bldgAId);

  const bldgBRes = await adminPool.query(
    `INSERT INTO building (org_id, name, code, address, status)
     VALUES ($1, $2, $3, '20 B St', 'ACTIVE') RETURNING id`,
    [orgId, `BldgB_W8_${suffix}`, `BB_${suffix}`]
  );
  const bldgBId = bldgBRes.rows[0].id;
  cleanup.buildingIds.push(bldgBId);

  const bldgEmptyRes = await adminPool.query(
    `INSERT INTO building (org_id, name, code, address, status)
     VALUES ($1, $2, $3, '30 Empty St', 'ACTIVE') RETURNING id`,
    [orgId, `BldgEmpty_W8_${suffix}`, `BE_${suffix}`]
  );
  const bldgEmptyId = bldgEmptyRes.rows[0].id;
  cleanup.buildingIds.push(bldgEmptyId);

  const passwordHash = await bcrypt.hash('Secret123!', 10);
  async function createUser(email, fullName, roleCode, assignedBuildingId = null) {
    const pRes = await adminPool.query(
      `INSERT INTO person (org_id, full_name, email, phone)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [orgId, fullName, email, `091${String(Math.floor(Math.random() * 10000000)).padStart(7, '0')}`]
    );
    const personId = pRes.rows[0].id;
    cleanup.personIds.push(personId);

    const uRes = await adminPool.query(
      `INSERT INTO app_user (person_id, auth_uid, password_hash, status)
       VALUES ($1, $2, $3, 'ACTIVE') RETURNING id`,
      [personId, email, passwordHash]
    );
    const userId = uRes.rows[0].id;
    cleanup.userIds.push(userId);

    const roleRes = await adminPool.query('SELECT id FROM role WHERE code = $1 LIMIT 1', [roleCode]);
    await adminPool.query(
      `INSERT INTO user_role (user_id, role_id, building_id) VALUES ($1, $2, $3)`,
      [userId, roleRes.rows[0].id, assignedBuildingId]
    );

    const loginRes = await apiFetch('/api/v1/auth/login', null, {
      method: 'POST',
      body: JSON.stringify({ email, password: 'Secret123!' }),
    });
    assert.equal(loginRes.status, 200);
    return { userId, personId, token: loginRes.body.accessToken };
  }

  const sysAdmin = await createUser(`admin_w8_${suffix}@test.com`, 'Admin W8', 'SYS_ADMIN', null);
  const ownerA = await createUser(`ownerA_w8_${suffix}@test.com`, 'Owner A W8', 'OWNER', bldgAId);
  const managerA = await createUser(`mgrA_w8_${suffix}@test.com`, 'Manager A W8', 'MANAGER', bldgAId);
  const residentA = await createUser(`resA_w8_${suffix}@test.com`, 'Resident A W8', 'RESIDENT', bldgAId);

  const ownerRow = await adminPool.query(
    `INSERT INTO owner (org_id, person_id, full_name, email) VALUES ($1, $2, 'Owner A W8', $3) RETURNING id`,
    [orgId, ownerA.personId, `ownerA_w8_${suffix}@test.com`]
  );
  cleanup.ownerIds.push(ownerRow.rows[0].id);
  await adminPool.query('UPDATE building SET owner_id = $1 WHERE id = $2', [ownerRow.rows[0].id, bldgAId]);

  const tenantRes = await adminPool.query(
    `INSERT INTO tenant (org_id, person_id, type, status) VALUES ($1, $2, 'primary', 'APPROVED') RETURNING id`,
    [orgId, residentA.personId]
  );
  const tenantId = tenantRes.rows[0].id;
  cleanup.tenantIds.push(tenantId);

  // Apartments on Bldg A: 4 exploitable (2 OCCUPIED, 2 AVAILABLE) + 1 INACTIVE
  const aptIds = [];
  const aptStatuses = ['OCCUPIED', 'OCCUPIED', 'AVAILABLE', 'AVAILABLE', 'INACTIVE'];
  for (let i = 0; i < aptStatuses.length; i += 1) {
    const r = await adminPool.query(
      `INSERT INTO apartment (building_id, code, status) VALUES ($1, $2, $3) RETURNING id`,
      [bldgAId, `A10${i + 1}_${suffix}`, aptStatuses[i]]
    );
    aptIds.push(r.rows[0].id);
    cleanup.apartmentIds.push(r.rows[0].id);
  }

  // Bldg B apartment + contract (for cross-building leakage test)
  const aptBRes = await adminPool.query(
    `INSERT INTO apartment (building_id, code, status) VALUES ($1, $2, 'OCCUPIED') RETURNING id`,
    [bldgBId, `B201_${suffix}`]
  );
  const aptBId = aptBRes.rows[0].id;
  cleanup.apartmentIds.push(aptBId);

  const todayVn = getTodayVn();
  const curPeriod = todayVn.slice(0, 7);
  const pMinus1 = shiftMonthsPeriod(curPeriod, -1);
  const pMinus2 = shiftMonthsPeriod(curPeriod, -2);

  // Historical contracts on Bldg A:
  // pMinus2: 3 apartments occupied (aptIds[0], aptIds[1], aptIds[2]) + 1 contract on INACTIVE aptIds[4] (must be excluded!)
  // pMinus1: 1 apartment occupied (aptIds[0])
  const c0 = await adminPool.query(
    `INSERT INTO contract (building_id, apartment_id, primary_tenant_id, start_date, end_date, status, rent_amount, deposit_amount, billing_day)
     VALUES ($1, $2, $3, $4, $5, 'ACTIVE', 6000000, 6000000, 5) RETURNING id`,
    [bldgAId, aptIds[0], tenantId, `${pMinus2}-01`, shiftDays(todayVn, 90)]
  );
  const c1 = await adminPool.query(
    `INSERT INTO contract (building_id, apartment_id, primary_tenant_id, start_date, end_date, terminated_at, status, rent_amount, deposit_amount, billing_day)
     VALUES ($1, $2, $3, $4, $5, $5, 'TERMINATED', 5000000, 5000000, 5) RETURNING id`,
    [bldgAId, aptIds[1], tenantId, `${pMinus2}-01`, periodEnd(pMinus2)]
  );
  const cActive2 = await adminPool.query(
    `INSERT INTO contract (building_id, apartment_id, primary_tenant_id, start_date, end_date, status, rent_amount, deposit_amount, billing_day)
     VALUES ($1, $2, $3, $4, $5, 'ACTIVE', 5000000, 5000000, 5) RETURNING id`,
    [bldgAId, aptIds[1], tenantId, `${curPeriod}-01`, shiftDays(todayVn, 90)]
  );
  const c2 = await adminPool.query(
    `INSERT INTO contract (building_id, apartment_id, primary_tenant_id, start_date, end_date, status, rent_amount, deposit_amount, billing_day)
     VALUES ($1, $2, $3, $4, $5, 'EXPIRED', 5000000, 5000000, 5) RETURNING id`,
    [bldgAId, aptIds[2], tenantId, `${pMinus2}-01`, periodEnd(pMinus2)]
  );
  const cInactive = await adminPool.query(
    `INSERT INTO contract (building_id, apartment_id, primary_tenant_id, start_date, end_date, status, rent_amount, deposit_amount, billing_day)
     VALUES ($1, $2, $3, $4, $5, 'EXPIRED', 5000000, 5000000, 5) RETURNING id`,
    [bldgAId, aptIds[4], tenantId, `${pMinus2}-01`, periodEnd(pMinus2)]
  );
  const cB = await adminPool.query(
    `INSERT INTO contract (building_id, apartment_id, primary_tenant_id, start_date, end_date, status, rent_amount, deposit_amount, billing_day)
     VALUES ($1, $2, $3, $4, $5, 'ACTIVE', 20000000, 20000000, 5) RETURNING id`,
    [bldgBId, aptBId, tenantId, `${pMinus2}-01`, shiftDays(todayVn, 90)]
  );
  cleanup.contractIds.push(c0.rows[0].id, c1.rows[0].id, cActive2.rows[0].id, c2.rows[0].id, cInactive.rows[0].id, cB.rows[0].id);

  // Invoices on Bldg A in curPeriod:
  // 1) PAID invoice on c0: RENT 6M, ELECTRICITY 800k, WATER 200k, SERVICE 400k, LATE_FEE 100k = 7.5M
  const invPaid = await adminPool.query(
    `INSERT INTO invoice (org_id, building_id, apartment_id, contract_id, tenant_id, invoice_code, period, due_date, subtotal_amount, total_amount, paid_amount, credit_offset_amount, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 7500000, 7500000, 7500000, 0, 'PAID') RETURNING id`,
    [orgId, bldgAId, aptIds[0], c0.rows[0].id, tenantId, `INV_P_${suffix}`, curPeriod, todayVn]
  );
  await adminPool.query(
    `INSERT INTO invoice_line (invoice_id, item_type, description, quantity, unit, unit_price, amount)
     VALUES ($1, 'RENT', 'Tiền phòng', 1, 'tháng', 6000000, 6000000),
            ($1, 'ELECTRICITY', 'Điện', 200, 'kWh', 4000, 800000),
            ($1, 'WATER', 'Nước', 10, 'm3', 20000, 200000),
            ($1, 'SERVICE', 'Dịch vụ', 1, 'tháng', 400000, 400000),
            ($1, 'LATE_FEE', 'Phí trễ hạn', 1, 'lần', 100000, 100000)`,
    [invPaid.rows[0].id]
  );

  // 2) ADJUSTED invoice on cActive2 with negative spill + realistic credit_offset line (credit_id) + approved invoice_adjustment (adjustment_target='SERVICE'):
  // RENT 5M, SERVICE 500k, approved invoice_adjustment -1.5M on SERVICE (formula_meta='{}'), plus credit_offset line -1M (credit_id) -> gross billed = 4M (total_amount 3M + credit_offset 1M)
  // Expected buckets: service = 0, rent = 4M, other = 0 (credit_offset line must NOT fabricate 'other'!)
  const invAdj = await adminPool.query(
    `INSERT INTO invoice (org_id, building_id, apartment_id, contract_id, tenant_id, invoice_code, period, due_date, subtotal_amount, adjustment_amount, total_amount, paid_amount, credit_offset_amount, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 5500000, -1500000, 3000000, 0, 1000000, 'ADJUSTED') RETURNING id`,
    [orgId, bldgAId, aptIds[1], cActive2.rows[0].id, tenantId, `INV_ADJ_${suffix}`, curPeriod, todayVn]
  );
  const adjRow = await adminPool.query(
    `INSERT INTO invoice_adjustment (org_id, building_id, invoice_id, adjustment_target, action_type, delta_amount, reason, status, created_by, approved_by, approved_at)
     VALUES ($1, $2, $3, 'SERVICE', 'ADJUST', -1500000, 'Giảm trừ DV đã duyệt', 'APPROVED', $4, $5, NOW()) RETURNING id`,
    [orgId, bldgAId, invAdj.rows[0].id, managerA.userId, ownerA.userId]
  );
  const credRow = await adminPool.query(
    `INSERT INTO credit_balance (org_id, building_id, contract_id, tenant_id, reason_type, amount, applied_amount, status, description, created_by)
     VALUES ($1, $2, $3, $4, 'OVERPAYMENT', 1000000, 1000000, 'APPLIED', 'Bù trừ dư thanh toán kỳ trước', $5) RETURNING id`,
    [orgId, bldgAId, cActive2.rows[0].id, tenantId, managerA.userId]
  );
  await adminPool.query(
    `INSERT INTO invoice_line (invoice_id, item_type, description, quantity, unit, unit_price, amount, formula_meta, adjustment_id, credit_id)
     VALUES ($1, 'RENT', 'Tiền phòng', 1, 'tháng', 5000000, 5000000, NULL, NULL, NULL),
            ($1, 'SERVICE', 'Dịch vụ', 1, 'tháng', 500000, 500000, NULL, NULL, NULL),
            ($1, 'ADJUSTMENT', 'Giảm trừ DV', 1, 'lần', -1500000, -1500000, '{}'::jsonb, $2, NULL),
            ($1, 'ADJUSTMENT', 'Bù trừ số dư tín dụng hợp đồng', 1, 'lần', -1000000, -1000000, NULL, NULL, $3)`,
    [invAdj.rows[0].id, adjRow.rows[0].id, credRow.rows[0].id]
  );

  // 3) DRAFT (in pMinus1) & VOID (in curPeriod) invoices on Bldg A -> must be ignored
  const invDraft = await adminPool.query(
    `INSERT INTO invoice (org_id, building_id, apartment_id, contract_id, tenant_id, invoice_code, period, due_date, subtotal_amount, total_amount, paid_amount, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 9000000, 9000000, 0, 'DRAFT') RETURNING id`,
    [orgId, bldgAId, aptIds[0], c0.rows[0].id, tenantId, `INV_DR_${suffix}`, pMinus1, periodEnd(pMinus1)]
  );
  await adminPool.query(
    `INSERT INTO invoice_line (invoice_id, item_type, description, quantity, unit, unit_price, amount)
     VALUES ($1, 'RENT', 'Draft Rent', 1, 'tháng', 9000000, 9000000)`,
    [invDraft.rows[0].id]
  );
  const invVoid = await adminPool.query(
    `INSERT INTO invoice (org_id, building_id, apartment_id, contract_id, tenant_id, invoice_code, period, due_date, subtotal_amount, total_amount, paid_amount, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 8000000, 8000000, 0, 'VOID') RETURNING id`,
    [orgId, bldgAId, aptIds[0], c0.rows[0].id, tenantId, `INV_VD_${suffix}`, curPeriod, todayVn]
  );
  await adminPool.query(
    `INSERT INTO invoice_line (invoice_id, item_type, description, quantity, unit, unit_price, amount)
     VALUES ($1, 'RENT', 'Void Rent', 1, 'tháng', 8000000, 8000000)`,
    [invVoid.rows[0].id]
  );

  // 4) Invoice & receivable on Bldg B (50M) -> must NOT leak to Manager A or Owner A
  const invB = await adminPool.query(
    `INSERT INTO invoice (org_id, building_id, apartment_id, contract_id, tenant_id, invoice_code, period, due_date, subtotal_amount, total_amount, paid_amount, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 50000000, 50000000, 0, 'ISSUED') RETURNING id`,
    [orgId, bldgBId, aptBId, cB.rows[0].id, tenantId, `INV_B_${suffix}`, curPeriod, todayVn]
  );
  await adminPool.query(
    `INSERT INTO invoice_line (invoice_id, item_type, description, quantity, unit, unit_price, amount)
     VALUES ($1, 'RENT', 'Bldg B Rent', 1, 'tháng', 50000000, 50000000)`,
    [invB.rows[0].id]
  );
  cleanup.invoiceIds.push(invPaid.rows[0].id, invAdj.rows[0].id, invDraft.rows[0].id, invVoid.rows[0].id, invB.rows[0].id);

  // Receivables on Bldg A across all 5 PRD buckets + 1 PAID + 1 on Bldg B
  await adminPool.query(
    `INSERT INTO receivable (org_id, building_id, contract_id, tenant_id, type, amount, paid_amount, due_date, status)
     VALUES ($1, $2, $3, $4, 'INVOICE_DEBT', 1000000, 0, $5::date, 'OPEN'),
            ($1, $2, $3, $4, 'INVOICE_DEBT', 2500000, 500000, $6::date, 'PARTIALLY_PAID'),
            ($1, $2, $3, $4, 'INVOICE_DEBT', 3000000, 0, $7::date, 'OPEN'),
            ($1, $2, $3, $4, 'INVOICE_DEBT', 4000000, 0, $8::date, 'OPEN'),
            ($1, $2, $3, $4, 'INVOICE_DEBT', 5000000, 0, $9::date, 'OPEN'),
            ($1, $2, $3, $4, 'INVOICE_DEBT', 8000000, 8000000, $9::date, 'PAID'),
            ($1, $10, $11, $4, 'INVOICE_DEBT', 50000000, 0, $8::date, 'OPEN')`,
    [
      orgId,
      bldgAId,
      c0.rows[0].id,
      tenantId,
      shiftDays(todayVn, 4), // current_not_due: 1M
      shiftDays(todayVn, -10), // 0_15: 2M
      shiftDays(todayVn, -20), // 16_30: 3M
      shiftDays(todayVn, -45), // 31_60: 4M
      shiftDays(todayVn, -75), // over_60: 5M
      bldgBId,
      cB.rows[0].id,
    ]
  );

  await t.test('1. Enriched chart datasets, negative spill reconciliation & months filter', async () => {
    const badMonths = await apiFetch('/api/v1/reports/dashboard?months=0', managerA.token);
    assert.equal(badMonths.status, 400);
    assert.equal(badMonths.body.code, 'VALIDATION_ERROR');

    const res6 = await apiFetch(`/api/v1/reports/dashboard?building_id=${bldgAId}&months=6`, managerA.token);
    assert.equal(res6.status, 200);
    const d = res6.body.data;
    assert.equal(d.selected_months, 6);
    assert.ok(typeof d.generated_at === 'string' && d.generated_at.length > 10);
    assert.equal(d.revenue_12m.length, 6);
    assert.equal(d.revenue_by_source.length, 6);
    assert.equal(d.occupancy_12m.length, 6);

    // Revenue by source for curPeriod:
    // invPaid (6M rent, 800k elec, 200k water, 400k service, 100k other) + invAdj (4M rent, 0 service)
    // Total billed = 7.5M + 4M = 11.5M
    const curSrc = d.revenue_by_source.find((r) => r.period === curPeriod);
    assert.ok(curSrc);
    assert.equal(curSrc.rent, 10_000_000);
    assert.equal(curSrc.electricity, 800_000);
    assert.equal(curSrc.water, 200_000);
    assert.equal(curSrc.service, 400_000);
    assert.equal(curSrc.other, 100_000);
    assert.equal(curSrc.total_billed, 11_500_000);
    assert.equal(curSrc.total_billed, d.kpis.monthly_billed);

    // Receivables aging 5 PRD buckets
    assert.equal(d.receivables_aging.total_debt, 15_000_000);
    assert.equal(d.receivables_aging.overdue_debt, 14_000_000);
    assert.equal(d.receivables_aging.total_debt, d.kpis.unpaid_debt);
    assert.deepEqual(
      d.receivables_aging.buckets.map((b) => ({ key: b.key, amount: b.amount, count: b.count })),
      [
        { key: 'current_not_due', amount: 1_000_000, count: 1 },
        { key: '0_15', amount: 2_000_000, count: 1 },
        { key: '16_30', amount: 3_000_000, count: 1 },
        { key: '31_60', amount: 4_000_000, count: 1 },
        { key: 'over_60', amount: 5_000_000, count: 1 },
      ]
    );

    // Monthly occupancy trend (INACTIVE excluded -> exploitable = 4)
    const occM2 = d.occupancy_12m.find((o) => o.period === pMinus2);
    const occM1 = d.occupancy_12m.find((o) => o.period === pMinus1);
    const occCur = d.occupancy_12m.find((o) => o.period === curPeriod);
    assert.deepEqual(occM2, { period: pMinus2, occupied: 3, exploitable: 4, occupancy_rate: 75 });
    assert.deepEqual(occM1, { period: pMinus1, occupied: 1, exploitable: 4, occupancy_rate: 25 });
    assert.deepEqual(occCur, { period: curPeriod, occupied: 2, exploitable: 4, occupancy_rate: 50 });
    assert.equal(occCur.occupancy_rate, d.kpis.occupancy_rate);
  });

  await t.test('2. Empty building returns 0% occupancy without NaN and 4-role RBAC prevents cross-building leakage', async () => {
    const emptyRes = await apiFetch(`/api/v1/reports/dashboard?building_id=${bldgEmptyId}`, sysAdmin.token);
    assert.equal(emptyRes.status, 200);
    assert.equal(emptyRes.body.data.occupancy_12m.length, 12);
    assert.ok(emptyRes.body.data.occupancy_12m.every((o) => o.occupancy_rate === 0 && o.exploitable === 0));

    // Unscoped Manager A & Owner A MUST NOT see Bldg B's 50M invoice or 50M receivable
    for (const actor of [managerA, ownerA]) {
      const unscoped = await apiFetch('/api/v1/reports/dashboard', actor.token);
      assert.equal(unscoped.status, 200);
      assert.equal(unscoped.body.data.kpis.monthly_billed, 11_500_000);
      assert.equal(unscoped.body.data.receivables_aging.total_debt, 15_000_000);

      const forbiddenB = await apiFetch(`/api/v1/reports/dashboard?building_id=${bldgBId}`, actor.token);
      assert.equal(forbiddenB.status, 403);
      assert.equal(forbiddenB.body.code, 'ACCESS_DENIED');
    }

    // RESIDENT gets 403
    const resForbidden = await apiFetch('/api/v1/reports/dashboard', residentA.token);
    assert.equal(resForbidden.status, 403);
  });
});
