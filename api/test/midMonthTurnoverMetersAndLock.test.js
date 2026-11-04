import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import pg from 'pg';
import bcrypt from 'bcryptjs';

dotenv.config();

const ADMIN_DB_URL =
  process.env.DATABASE_URL ||
  'postgres://postgres:postgres@127.0.0.1:5433/resihub';
const APP_DB_URL =
  process.env.APP_DATABASE_URL ||
  'postgres://resihub_app:resihub_app_secret@127.0.0.1:5433/resihub';

process.env.APP_DATABASE_URL = APP_DB_URL;

test('Task 2: Meter Turnover Slots, Billed Lock, Successor Cascade & DRAFT Invoice Sync', async (t) => {
  const adminPool = new pg.Pool({ connectionString: ADMIN_DB_URL });

  const { adminPool: appAdminPool, appPool } = await import('../src/db/client.js');
  const { default: authRoute } = await import('../src/routes/auth.js');
  const { default: metersRoute } = await import('../src/routes/meters.js');
  const { default: invoicesRoute } = await import('../src/routes/invoices.js');
  const { default: apartmentsRoute } = await import('../src/routes/apartments.js');

  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '10mb' }));
  app.use('/api/v1/auth', authRoute);
  app.use('/api/v1/meters', metersRoute);
  app.use('/api/v1/invoices', invoicesRoute);
  app.use('/api/v1/apartments', apartmentsRoute);

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const API_BASE = `http://127.0.0.1:${server.address().port}`;

  async function apiFetch(path, token, options = {}) {
    const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(`${API_BASE}${path}`, { ...options, headers });
    const text = await res.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = { raw: text };
    }
    return { status: res.status, body };
  }

  const suffix = `${Date.now().toString().slice(-6)}${Math.floor(Math.random() * 90 + 10)}`;
  const cleanup = {
    invoiceIds: [],
    meterIds: [],
    depositIds: [],
    contractIds: [],
    apartmentIds: [],
    tenantIds: [],
    userIds: [],
    personIds: [],
  };

  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    const c = await adminPool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.allow_test_cleanup', 'true', true)`);
      if (cleanup.invoiceIds.length > 0) {
        await c.query(`DELETE FROM audit_log WHERE entity = 'invoice' AND entity_id = ANY($1::uuid[])`, [cleanup.invoiceIds]);
        await c.query(`DELETE FROM receivable WHERE invoice_id = ANY($1::uuid[])`, [cleanup.invoiceIds]);
        await c.query(`DELETE FROM invoice_line WHERE invoice_id = ANY($1::uuid[])`, [cleanup.invoiceIds]);
        await c.query(`DELETE FROM invoice WHERE id = ANY($1::uuid[])`, [cleanup.invoiceIds]);
      }
      if (cleanup.meterIds.length > 0) {
        await c.query(
          `DELETE FROM audit_log WHERE entity IN ('meter', 'meter_reading')
             AND (entity_id = ANY($1::uuid[]) OR entity_id IN (SELECT id FROM meter_reading WHERE meter_id = ANY($1::uuid[])))`,
          [cleanup.meterIds]
        );
        await c.query(`DELETE FROM meter_reading WHERE meter_id = ANY($1::uuid[])`, [cleanup.meterIds]);
        await c.query(`DELETE FROM meter WHERE id = ANY($1::uuid[])`, [cleanup.meterIds]);
      }
      if (cleanup.depositIds.length > 0) {
        await c.query(`DELETE FROM deposit WHERE id = ANY($1::uuid[])`, [cleanup.depositIds]);
      }
      if (cleanup.contractIds.length > 0) {
        await c.query(`DELETE FROM contract WHERE id = ANY($1::uuid[])`, [cleanup.contractIds]);
      }
      if (cleanup.apartmentIds.length > 0) {
        await c.query(`DELETE FROM apartment WHERE id = ANY($1::uuid[])`, [cleanup.apartmentIds]);
      }
      if (cleanup.tenantIds.length > 0) {
        await c.query(`DELETE FROM tenant WHERE id = ANY($1::uuid[])`, [cleanup.tenantIds]);
      }
      if (cleanup.userIds.length > 0) {
        await c.query(`DELETE FROM app_user WHERE id = ANY($1::uuid[])`, [cleanup.userIds]);
      }
      if (cleanup.personIds.length > 0) {
        await c.query(`DELETE FROM person WHERE id = ANY($1::uuid[])`, [cleanup.personIds]);
      }
      await c.query('COMMIT');
    } finally {
      c.release();
      await adminPool.end();
      await appPool.end().catch(() => {});
      await appAdminPool.end().catch(() => {});
    }
  });

  const bldgRes = await adminPool.query(`SELECT id, org_id FROM building WHERE code = 'VOP-A' LIMIT 1`);
  const vopAId = bldgRes.rows[0].id;
  const orgId = bldgRes.rows[0].org_id;

  const loginRes = await apiFetch('/api/v1/auth/login', null, {
    method: 'POST',
    body: JSON.stringify({ email: 'manager.vop.a@resihub.vn', password: 'Demo@123456' }),
  });
  assert.equal(loginRes.status, 200, JSON.stringify(loginRes.body));
  const mgrToken = loginRes.body.accessToken;

  const aptIns = await adminPool.query(
    `INSERT INTO apartment (building_id, code, area_m2, base_rent, status)
     VALUES ($1, $2, 50, 9000000, 'OCCUPIED') RETURNING id`,
    [vopAId, `T2M-${suffix}`]
  );
  const aptId = aptIns.rows[0].id;
  cleanup.apartmentIds.push(aptId);

  async function createContractSeed({ tag, startYmd, endYmd, status = 'ACTIVE', termYmd = null }) {
    const p = await adminPool.query(
      `INSERT INTO person (org_id, full_name, phone, email)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [orgId, `Khach ${tag}`, `096${tag}${suffix.slice(0, 6)}`, `khach_${tag}_${suffix}@test.vn`]
    );
    cleanup.personIds.push(p.rows[0].id);

    const tn = await adminPool.query(
      `INSERT INTO tenant (org_id, person_id, type, status)
       VALUES ($1, $2, 'primary', 'APPROVED') RETURNING id`,
      [orgId, p.rows[0].id]
    );
    cleanup.tenantIds.push(tn.rows[0].id);

    const c = await adminPool.query(
      `INSERT INTO contract (
         building_id, apartment_id, primary_tenant_id, start_date, end_date,
         rent_amount, deposit_amount, billing_day, status, terminated_at
       )
       VALUES ($1, $2, $3, $4, $5, 9000000, 9000000, 1, $6, $7) RETURNING id`,
      [vopAId, aptId, tn.rows[0].id, startYmd, endYmd, status, termYmd]
    );
    cleanup.contractIds.push(c.rows[0].id);
    const contractId = c.rows[0].id;
    const expectedCode = `HĐ-${contractId.slice(0, 8).toUpperCase()}`;

    const dep = await adminPool.query(
      `INSERT INTO deposit (contract_id, amount_held, status)
       VALUES ($1, 9000000, 'HELD') RETURNING id`,
      [contractId]
    );
    cleanup.depositIds.push(dep.rows[0].id);

    return { contractId, contractCode: expectedCode, tenantId: tn.rows[0].id, depositId: dep.rows[0].id };
  }

  const cA = await createContractSeed({
    tag: '1',
    startYmd: '2028-11-01',
    endYmd: '2029-11-01',
    status: 'TERMINATED',
    termYmd: '2028-12-15',
  });
  const cB = await createContractSeed({
    tag: '2',
    startYmd: '2028-12-20',
    endYmd: '2029-12-20',
    status: 'ACTIVE',
  });

  // Create ELECTRICITY (initial 900) and WATER (initial 50) meters via API (backdate created_at to 2028-01-01)
  const elCreate = await apiFetch('/api/v1/meters', mgrToken, {
    method: 'POST',
    body: JSON.stringify({
      apartment_id: aptId,
      meter_type: 'ELECTRICITY',
      unit_price: 3800,
      initial_reading: 900,
    }),
  });
  assert.equal(elCreate.status, 201, JSON.stringify(elCreate.body));
  const elMeterId = elCreate.body.data.id;
  cleanup.meterIds.push(elMeterId);

  const wtCreate = await apiFetch('/api/v1/meters', mgrToken, {
    method: 'POST',
    body: JSON.stringify({
      apartment_id: aptId,
      meter_type: 'WATER',
      unit_price: 22000,
      initial_reading: 50,
    }),
  });
  assert.equal(wtCreate.status, 201, JSON.stringify(wtCreate.body));
  const wtMeterId = wtCreate.body.data.id;
  cleanup.meterIds.push(wtMeterId);

  await adminPool.query(
    `UPDATE meter SET created_at = '2028-01-01T00:00:00Z' WHERE id = ANY($1::uuid[])`,
    [[elMeterId, wtMeterId]]
  );

  await t.test('1. Turnover slot progression, 409 READING_ALREADY_BILLED (single + batch rollback), and 0-m3 lock', async () => {
    // 30/11 readings for Contract A
    const novEl = await apiFetch(`/api/v1/meters/${elMeterId}/readings`, mgrToken, {
      method: 'POST',
      body: JSON.stringify({ period: '2028-11', current_reading: 1000, status: 'CONFIRMED' }),
    });
    assert.equal(novEl.status, 201, JSON.stringify(novEl.body));
    assert.equal(novEl.body.data.contract_id, cA.contractId);

    const novWt = await apiFetch(`/api/v1/meters/${wtMeterId}/readings`, mgrToken, {
      method: 'POST',
      body: JSON.stringify({ period: '2028-11', current_reading: 50, status: 'CONFIRMED' }),
    });
    assert.equal(novWt.status, 201);

    // Before Contract A 2028-12 invoice is issued, GET /meters?period=2028-12 targets Contract A (Slot 1/2)
    const listBefore = await apiFetch(`/api/v1/meters?building_id=${vopAId}&period=2028-12&search=T2M-${suffix}`, mgrToken);
    assert.equal(listBefore.status, 200);
    const elRow1 = listBefore.body.data.find((m) => m.id === elMeterId);
    assert.equal(elRow1.target_contract_id, cA.contractId);
    assert.equal(elRow1.period_slot_index, 1);
    assert.equal(elRow1.period_total_slots, 2);
    assert.equal(Number(elRow1.last_known_reading), 1000);

    // Record Contract A move-out readings on 15/12: Electricity 1100 (+100), Water 50 (+0 m3)
    const decElA = await apiFetch(`/api/v1/meters/${elMeterId}/readings`, mgrToken, {
      method: 'POST',
      body: JSON.stringify({ period: '2028-12', current_reading: 1100, status: 'CONFIRMED' }),
    });
    assert.equal(decElA.status, 201, JSON.stringify(decElA.body));
    assert.equal(decElA.body.data.contract_id, cA.contractId);
    assert.equal(Number(decElA.body.data.consumption), 100);

    const decWtA = await apiFetch(`/api/v1/meters/${wtMeterId}/readings`, mgrToken, {
      method: 'POST',
      body: JSON.stringify({ period: '2028-12', current_reading: 50, status: 'CONFIRMED' }),
    });
    assert.equal(decWtA.status, 201, JSON.stringify(decWtA.body));
    assert.equal(Number(decWtA.body.data.consumption), 0);

    // Issue Contract A's 2028-12 invoice (Rent + Electricity only; 0 m3 water produces no invoice_line)
    const genA = await apiFetch('/api/v1/invoices/generate-batch', mgrToken, {
      method: 'POST',
      body: JSON.stringify({ contract_id: cA.contractId, period: '2028-12', auto_issue: true }),
    });
    assert.equal(genA.status, 201, JSON.stringify(genA.body));
    for (const inv of genA.body.data || []) cleanup.invoiceIds.push(inv.id);

    // Overwriting Contract A's billed electricity reading MUST fail 409 READING_ALREADY_BILLED
    const overwriteA = await apiFetch(`/api/v1/meters/${elMeterId}/readings`, mgrToken, {
      method: 'POST',
      body: JSON.stringify({
        period: '2028-12',
        contract_id: cA.contractId,
        current_reading: 1120,
        status: 'CONFIRMED',
      }),
    });
    assert.equal(overwriteA.status, 409, JSON.stringify(overwriteA.body));
    assert.equal(overwriteA.body.code, 'READING_ALREADY_BILLED');

    // Overwriting Contract A's 0-m3 confirmed water reading MUST ALSO fail 409 READING_ALREADY_BILLED
    const overwriteZeroWt = await apiFetch(`/api/v1/meters/${wtMeterId}/readings`, mgrToken, {
      method: 'POST',
      body: JSON.stringify({
        period: '2028-12',
        contract_id: cA.contractId,
        current_reading: 52,
        status: 'CONFIRMED',
      }),
    });
    assert.equal(overwriteZeroWt.status, 409, JSON.stringify(overwriteZeroWt.body));
    assert.equal(overwriteZeroWt.body.code, 'READING_ALREADY_BILLED');

    // Batch containing a locked reading MUST roll back the entire batch with 409 (Review Focus #1)
    const batchFail = await apiFetch('/api/v1/meters/readings/batch', mgrToken, {
      method: 'POST',
      body: JSON.stringify({
        period: '2028-12',
        status: 'CONFIRMED',
        readings: [
          { meter_id: wtMeterId, current_reading: 55 }, // valid Slot 2 water
          { meter_id: elMeterId, contract_id: cA.contractId, current_reading: 1120 }, // locked Slot 1 electricity
        ],
      }),
    });
    assert.equal(batchFail.status, 409, JSON.stringify(batchFail.body));
    assert.equal(batchFail.body.code, 'READING_ALREADY_BILLED');

    // Verify wtMeterId Slot 2 was NOT partially saved due to rollback
    const listAfterRollback = await apiFetch(`/api/v1/meters?building_id=${vopAId}&period=2028-12&search=T2M-${suffix}`, mgrToken);
    const elRow2 = listAfterRollback.body.data.find((m) => m.id === elMeterId);
    const wtRow2 = listAfterRollback.body.data.find((m) => m.id === wtMeterId);
    assert.equal(elRow2.target_contract_id, cB.contractId, 'GET /meters must auto-advance to Contract B');
    assert.equal(elRow2.period_slot_index, 2);
    assert.equal(elRow2.period_reading_id, null);
    assert.equal(Number(elRow2.last_known_reading), 1100, 'Contract B baseline must chain directly from 1100');
    assert.equal(wtRow2.period_reading_id, null, 'Rolled-back batch must not leave partial water reading');

    // Record Contract B end-of-month reading (without explicit contract_id): 1185 -> consumption = 85
    const decElB = await apiFetch(`/api/v1/meters/${elMeterId}/readings`, mgrToken, {
      method: 'POST',
      body: JSON.stringify({
        period: '2028-12',
        current_reading: 1185,
        abnormal_note: 'Khách mới vào từ 20/12',
        status: 'CONFIRMED',
      }),
    });
    assert.equal(decElB.status, 201, JSON.stringify(decElB.body));
    assert.equal(decElB.body.data.contract_id, cB.contractId);
    assert.equal(Number(decElB.body.data.previous_reading), 1100);
    assert.equal(Number(decElB.body.data.consumption), 85);

    // Verify GET /apartments/:id latest_reading = 1185 and GET /meters/:id/readings includes contract_code ordered 1185 -> 1100
    const aptDetail = await apiFetch(`/api/v1/apartments/${aptId}`, mgrToken);
    assert.equal(aptDetail.status, 200);
    const aptElMeter = aptDetail.body.data.meters.find((m) => m.id === elMeterId);
    assert.equal(Number(aptElMeter.latest_reading), 1185);

    const histRes = await apiFetch(`/api/v1/meters/${elMeterId}/readings`, mgrToken);
    assert.equal(histRes.status, 200);
    const decHist = histRes.body.data.filter((h) => h.period === '2028-12');
    assert.equal(decHist.length, 2);
    assert.equal(Number(decHist[0].current_reading), 1185);
    assert.equal(decHist[0].contract_code, cB.contractCode);
    assert.equal(Number(decHist[1].current_reading), 1100);
    assert.equal(decHist[1].contract_code, cA.contractCode);
  });

  await t.test('2. DRAFT invoice utility-line auto-sync on confirm & edit (Review Focus #4)', async () => {
    // Generate DRAFT invoice for Contract B in 2029-01 BEFORE recording 2029-01 meter readings (allow_missing_meter_readings: true)
    const genDraft = await apiFetch('/api/v1/invoices/generate-batch', mgrToken, {
      method: 'POST',
      body: JSON.stringify({
        contract_id: cB.contractId,
        period: '2029-01',
        auto_issue: false,
        allow_missing_meter_readings: true,
      }),
    });
    assert.equal(genDraft.status, 201, JSON.stringify(genDraft.body));
    const draftInvId = genDraft.body.data[0].id;
    cleanup.invoiceIds.push(draftInvId);

    // Save DRAFT reading 1250 (1185 -> 1250 = 65 kWh) -> still DRAFT reading, so DRAFT invoice has no ELECTRICITY line yet
    const rDraft = await apiFetch(`/api/v1/meters/${elMeterId}/readings`, mgrToken, {
      method: 'POST',
      body: JSON.stringify({
        period: '2029-01',
        current_reading: 1250,
        abnormal_note: 'Ghi nháp tháng 1',
        status: 'DRAFT',
      }),
    });
    assert.equal(rDraft.status, 201, JSON.stringify(rDraft.body));

    // Confirm reading via POST /meters/readings/:readingId/confirm -> must auto-add ELECTRICITY line (65 * 3800 = 247,000) to DRAFT invoice!
    const confRes = await apiFetch(`/api/v1/meters/readings/${rDraft.body.data.id}/confirm`, mgrToken, {
      method: 'POST',
      body: JSON.stringify({ abnormal_note: 'Xác nhận tháng 1' }),
    });
    assert.equal(confRes.status, 200, JSON.stringify(confRes.body));

    const invAfterConfirm = await apiFetch(`/api/v1/invoices/${draftInvId}`, mgrToken);
    const elLine1 = invAfterConfirm.body.data.lines.find((l) => l.item_type === 'ELECTRICITY');
    assert.ok(elLine1, 'Confirming reading must sync ELECTRICITY line onto existing DRAFT invoice');
    assert.equal(Number(elLine1.quantity), 65);
    assert.equal(Number(elLine1.amount), 65 * 3800);

    // Edit CONFIRMED reading to 1285 (1185 -> 1285 = 100 kWh) while invoice is still DRAFT -> must update DRAFT invoice line to 100 kWh!
    const editRes = await apiFetch(`/api/v1/meters/${elMeterId}/readings`, mgrToken, {
      method: 'POST',
      body: JSON.stringify({
        period: '2029-01',
        current_reading: 1285,
        status: 'CONFIRMED',
      }),
    });
    assert.equal(editRes.status, 201, JSON.stringify(editRes.body));

    const invAfterEdit = await apiFetch(`/api/v1/invoices/${draftInvId}`, mgrToken);
    const elLine2 = invAfterEdit.body.data.lines.find((l) => l.item_type === 'ELECTRICITY');
    assert.equal(Number(elLine2.quantity), 100);
    assert.equal(Number(elLine2.amount), 100 * 3800);
  });

  await t.test('3. Unlocked successor cascade, decimal precision & FLAGGED downgrade when baseline shifts', async () => {
    // Record 2029-02 (1385 = 100 kWh) and 2029-03 (1485.25 = 100.25 kWh) so 3-period avg ~ 100.08 kWh
    await apiFetch(`/api/v1/meters/${elMeterId}/readings`, mgrToken, {
      method: 'POST',
      body: JSON.stringify({ period: '2029-02', current_reading: 1385, status: 'CONFIRMED' }),
    });
    await apiFetch(`/api/v1/meters/${elMeterId}/readings`, mgrToken, {
      method: 'POST',
      body: JSON.stringify({ period: '2029-03', current_reading: 1485.25, status: 'CONFIRMED' }),
    });

    // Terminate cB on 2029-04-12 and add cC starting 2029-04-16
    await adminPool.query(
      `UPDATE contract SET status = 'TERMINATED', terminated_at = '2029-04-12' WHERE id = $1`,
      [cB.contractId]
    );
    const cC = await createContractSeed({
      tag: '3',
      startYmd: '2029-04-16',
      endYmd: '2030-04-16',
      status: 'ACTIVE',
    });

    // Record unbilled Slot 1 (cB): 1485.25 -> 1565.50 (80.25 kWh, within 30% of ~100 -> CONFIRMED without note)
    const rSlot1 = await apiFetch(`/api/v1/meters/${elMeterId}/readings`, mgrToken, {
      method: 'POST',
      body: JSON.stringify({
        period: '2029-04',
        contract_id: cB.contractId,
        current_reading: 1565.5,
        status: 'CONFIRMED',
      }),
    });
    assert.equal(rSlot1.status, 201, JSON.stringify(rSlot1.body));

    // Record unbilled Slot 2 (cC) explicitly before Slot 1 is invoiced: 1565.50 -> 1650.75 (85.25 kWh -> CONFIRMED without note)
    const rSlot2 = await apiFetch(`/api/v1/meters/${elMeterId}/readings`, mgrToken, {
      method: 'POST',
      body: JSON.stringify({
        period: '2029-04',
        contract_id: cC.contractId,
        current_reading: 1650.75,
        status: 'CONFIRMED',
      }),
    });
    assert.equal(rSlot2.status, 201, JSON.stringify(rSlot2.body));
    assert.equal(rSlot2.body.data.status, 'CONFIRMED');
    assert.equal(Number(rSlot2.body.data.consumption), 85.25);

    // Lower Slot 1 (cB) to 1500.25 -> Slot 2 (cC) cascades to 1500.25 -> 1650.75 = 150.5 kWh (>30% above ~100 without note -> FLAGGED!)
    const editSlot1 = await apiFetch(`/api/v1/meters/${elMeterId}/readings`, mgrToken, {
      method: 'POST',
      body: JSON.stringify({
        period: '2029-04',
        contract_id: cB.contractId,
        current_reading: 1500.25,
        abnormal_note: 'Điều chỉnh số chốt bàn giao',
        status: 'CONFIRMED',
      }),
    });
    assert.equal(editSlot1.status, 201, JSON.stringify(editSlot1.body));

    const checkSlot2 = await adminPool.query(
      `SELECT previous_reading, current_reading, consumption, is_abnormal, status
       FROM meter_reading WHERE id = $1`,
      [rSlot2.body.data.id]
    );
    assert.equal(Number(checkSlot2.rows[0].previous_reading), 1500.25);
    assert.equal(Number(checkSlot2.rows[0].consumption), 150.5);
    assert.equal(checkSlot2.rows[0].is_abnormal, true);
    assert.equal(checkSlot2.rows[0].status, 'FLAGGED', 'Cascaded abnormal reading without note must downgrade to FLAGGED');
  });
});
