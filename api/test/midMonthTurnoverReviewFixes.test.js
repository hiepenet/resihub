import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import pg from 'pg';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

const ADMIN_DB_URL =
  process.env.DATABASE_URL ||
  'postgres://postgres:postgres@127.0.0.1:5433/resihub';
const APP_DB_URL =
  process.env.APP_DATABASE_URL ||
  'postgres://resihub_app:resihub_app_secret@127.0.0.1:5433/resihub';

process.env.APP_DATABASE_URL = APP_DB_URL;

const TINY_PNG_DATA_URI =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

test('Final Review Fixes: Finalized Slot Lock, Late Reading Deposit Guard, Orphan Confirm Adoption & Per-Slot OCR', async (t) => {
  const adminPool = new pg.Pool({ connectionString: ADMIN_DB_URL });
  const rlsPool = new pg.Pool({ connectionString: APP_DB_URL });

  const { adminPool: appAdminPool, appPool } = await import('../src/db/client.js');
  const { default: authRoute } = await import('../src/routes/auth.js');
  const { default: metersRoute } = await import('../src/routes/meters.js');
  const { default: invoicesRoute } = await import('../src/routes/invoices.js');
  const { default: depositsRoute } = await import('../src/routes/deposits.js');
  const { default: aiRoute } = await import('../src/routes/ai.js');

  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '10mb' }));
  app.use('/api/v1/auth', authRoute);
  app.use('/api/v1/meters', metersRoute);
  app.use('/api/v1/invoices', invoicesRoute);
  app.use('/api/v1/deposits', depositsRoute);
  app.use('/api/v1/ai', aiRoute);

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const API_BASE = `http://127.0.0.1:${server.address().port}`;

  async function apiFetch(urlPath, token, options = {}) {
    const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
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

  const suffix = `${Date.now().toString().slice(-6)}${Math.floor(Math.random() * 90 + 10)}`;
  const cleanup = {
    invoiceIds: [],
    meterIds: [],
    depositIds: [],
    contractIds: [],
    buildingIds: [],
    apartmentIds: [],
    tenantIds: [],
    personIds: [],
  };

  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    const c = await adminPool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.allow_test_cleanup', 'true', true)`);

      if (cleanup.contractIds.length > 0) {
        const invRows = await c.query(
          `SELECT id FROM invoice WHERE contract_id = ANY($1::uuid[])`,
          [cleanup.contractIds]
        );
        for (const r of invRows.rows) {
          if (!cleanup.invoiceIds.includes(r.id)) cleanup.invoiceIds.push(r.id);
        }
      }

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
        await c.query(`DELETE FROM deposit_transaction WHERE deposit_id = ANY($1::uuid[])`, [cleanup.depositIds]);
        await c.query(`DELETE FROM deposit WHERE id = ANY($1::uuid[])`, [cleanup.depositIds]);
      }

      if (cleanup.contractIds.length > 0) {
        await c.query(`DELETE FROM contract_service_price WHERE contract_id = ANY($1::uuid[])`, [cleanup.contractIds]);
        await c.query(`DELETE FROM contract WHERE id = ANY($1::uuid[])`, [cleanup.contractIds]);
      }

      if (cleanup.apartmentIds.length > 0) {
        await c.query(`DELETE FROM apartment WHERE id = ANY($1::uuid[])`, [cleanup.apartmentIds]);
      }

      if (cleanup.buildingIds.length > 0) {
        await c.query(`DELETE FROM user_role WHERE building_id = ANY($1::uuid[])`, [cleanup.buildingIds]);
        await c.query(`DELETE FROM building WHERE id = ANY($1::uuid[])`, [cleanup.buildingIds]);
      }

      if (cleanup.tenantIds.length > 0) {
        await c.query(`DELETE FROM tenant WHERE id = ANY($1::uuid[])`, [cleanup.tenantIds]);
      }

      if (cleanup.personIds.length > 0) {
        await c.query(`DELETE FROM person WHERE id = ANY($1::uuid[])`, [cleanup.personIds]);
      }

      await c.query('COMMIT');
    } finally {
      c.release();
      await rlsPool.end().catch(() => {});
      await adminPool.end();
      await appPool.end().catch(() => {});
      await appAdminPool.end().catch(() => {});
    }
  });

  const vopRes = await adminPool.query(`SELECT id, org_id FROM building WHERE code = 'VOP-A' LIMIT 1`);
  const orgId = vopRes.rows[0].org_id;

  const mgrUserRes = await adminPool.query(
    `SELECT u.id AS user_id, ur.role_id
     FROM app_user u
     JOIN person p ON p.id = u.person_id
     JOIN user_role ur ON ur.user_id = u.id
     JOIN role r ON r.id = ur.role_id
     WHERE p.email = 'manager.vop.a@resihub.vn' AND r.code = 'MANAGER'
     LIMIT 1`
  );
  const mgrUserId = mgrUserRes.rows[0].user_id;
  const mgrRoleId = mgrUserRes.rows[0].role_id;

  const bldgIns = await adminPool.query(
    `INSERT INTO building (org_id, code, name, address)
     VALUES ($1, $2, $3, 'Test Address') RETURNING id`,
    [orgId, `RFX-${suffix.slice(0, 5)}`, `Toa Review Fix ${suffix}`]
  );
  const bldgId = bldgIns.rows[0].id;
  cleanup.buildingIds.push(bldgId);

  await adminPool.query(
    `INSERT INTO user_role (user_id, role_id, building_id) VALUES ($1, $2, $3)`,
    [mgrUserId, mgrRoleId, bldgId]
  );

  const loginRes = await apiFetch('/api/v1/auth/login', null, {
    method: 'POST',
    body: JSON.stringify({ email: 'manager.vop.a@resihub.vn', password: 'Demo@123456' }),
  });
  assert.equal(loginRes.status, 200);
  const mgrToken = loginRes.body.accessToken;

  async function createApartment(tag) {
    const ins = await adminPool.query(
      `INSERT INTO apartment (building_id, code, area_m2, base_rent, status)
       VALUES ($1, $2, 50, 9000000, 'OCCUPIED') RETURNING id`,
      [bldgId, `${tag}-${suffix.slice(0, 5)}`]
    );
    cleanup.apartmentIds.push(ins.rows[0].id);
    return ins.rows[0].id;
  }

  async function createMeter(apartmentId, tag, initialReading = 1000, unitPrice = 3500) {
    const res = await apiFetch('/api/v1/meters', mgrToken, {
      method: 'POST',
      body: JSON.stringify({
        apartment_id: apartmentId,
        meter_type: 'ELECTRICITY',
        meter_code: `${tag}-${suffix.slice(0, 5)}`,
        unit_price: unitPrice,
        initial_reading: initialReading,
      }),
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const meterId = res.body.data.id;
    cleanup.meterIds.push(meterId);
    await adminPool.query(`UPDATE meter SET created_at = '2026-01-01T00:00:00Z' WHERE id = $1`, [meterId]);
    return meterId;
  }

  async function createContractSeed({ apartmentId, tag, startYmd, endYmd, status = 'ACTIVE', termYmd = null }) {
    const p = await adminPool.query(
      `INSERT INTO person (org_id, full_name, phone)
       VALUES ($1, $2, $3) RETURNING id`,
      [orgId, `RFX ${tag}`, `098${Math.floor(Math.random() * 8999999 + 1000000)}`]
    );
    const personId = p.rows[0].id;
    cleanup.personIds.push(personId);

    const tn = await adminPool.query(
      `INSERT INTO tenant (org_id, person_id, type, status)
       VALUES ($1, $2, 'primary', 'APPROVED') RETURNING id`,
      [orgId, personId]
    );
    const tenantId = tn.rows[0].id;
    cleanup.tenantIds.push(tenantId);

    const c = await adminPool.query(
      `INSERT INTO contract (
         building_id, apartment_id, primary_tenant_id, start_date, end_date,
         rent_amount, deposit_amount, billing_day, status, terminated_at
       )
       VALUES ($1, $2, $3, $4, $5, 9000000, 9000000, 1, $6, $7) RETURNING id`,
      [bldgId, apartmentId, tenantId, startYmd, endYmd, status, termYmd]
    );
    const contractId = c.rows[0].id;
    cleanup.contractIds.push(contractId);

    const dep = await adminPool.query(
      `INSERT INTO deposit (contract_id, amount_held, status)
       VALUES ($1, 9000000, 'HELD') RETURNING id`,
      [contractId]
    );
    cleanup.depositIds.push(dep.rows[0].id);

    return { contractId, depositId: dep.rows[0].id, personId, tenantId };
  }

  await t.test('1. Important #1 + Minor #1: Finalized contract slot blocks new/confirm readings (409) & exposes per-slot effective_unit_price', async () => {
    const apt = await createApartment('RF1');
    const meter = await createMeter(apt, 'ELRF1', 1000, 3500);

    const cA = await createContractSeed({
      apartmentId: apt,
      tag: 'CA',
      startYmd: '2029-02-01',
      endYmd: '2029-12-31',
      status: 'TERMINATED',
      termYmd: '2029-02-12',
    });
    const cB = await createContractSeed({
      apartmentId: apt,
      tag: 'CB',
      startYmd: '2029-02-18',
      endYmd: '2029-12-31',
      status: 'ACTIVE',
    });
    await adminPool.query(
      `INSERT INTO contract_service_price (contract_id, service_code, unit_price, effective_from)
       VALUES ($1, 'ELECTRICITY', 4300, '2029-02-18')`,
      [cB.contractId]
    );

    // Record a DRAFT reading on cA first, then issue cA's invoice with allow_missing_meter_readings: true
    const draftA = await apiFetch(`/api/v1/meters/${meter}/readings`, mgrToken, {
      method: 'POST',
      body: JSON.stringify({
        period: '2029-02',
        contract_id: cA.contractId,
        current_reading: 1080,
        status: 'DRAFT',
      }),
    });
    assert.equal(draftA.status, 201);
    const draftAId = draftA.body.data.id;

    const genA = await apiFetch('/api/v1/invoices/generate-batch', mgrToken, {
      method: 'POST',
      body: JSON.stringify({
        building_id: bldgId,
        contract_id: cA.contractId,
        period: '2029-02',
        allow_missing_meter_readings: true,
        auto_issue: true,
      }),
    });
    assert.equal(genA.status, 201);

    // GET /meters?period=2029-02: Slot 1 (cA) must show is_billed: true, and overlapping_contracts must expose per-slot effective_unit_price
    const listRes = await apiFetch(`/api/v1/meters?building_id=${bldgId}&period=2029-02`, mgrToken);
    assert.equal(listRes.status, 200);
    const mRow = listRes.body.data.find((m) => m.id === meter);
    assert.equal(mRow.target_contract_id, cB.contractId);
    assert.equal(mRow.overlapping_contracts[0].is_billed, true, 'Finalized Slot 1 must be marked is_billed: true');
    assert.equal(Number(mRow.overlapping_contracts[0].effective_unit_price), 3500);
    assert.equal(Number(mRow.overlapping_contracts[1].effective_unit_price), 4300);
    assert.equal(mRow.overlapping_contracts[1].effective_price_source, 'CONTRACT_OVERRIDE');

    // Confirming cA's DRAFT reading after cA's invoice is ISSUED must fail with 409 READING_ALREADY_BILLED
    const confAttempt = await apiFetch(`/api/v1/meters/readings/${draftAId}/confirm`, mgrToken, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    assert.equal(confAttempt.status, 409, JSON.stringify(confAttempt.body));
    assert.equal(confAttempt.body.code, 'READING_ALREADY_BILLED');

    // Delete draftA row directly to simulate cA having NO reading row at all when already finalized:
    await adminPool.query(`DELETE FROM meter_reading WHERE id = $1`, [draftAId]);

    // Recording a brand new reading onto already-finalized cA MUST also fail with 409 READING_ALREADY_BILLED
    const postNewOnFinalized = await apiFetch(`/api/v1/meters/${meter}/readings`, mgrToken, {
      method: 'POST',
      body: JSON.stringify({
        period: '2029-02',
        contract_id: cA.contractId,
        current_reading: 1090,
        status: 'CONFIRMED',
      }),
    });
    assert.equal(postNewOnFinalized.status, 409, JSON.stringify(postNewOnFinalized.body));
    assert.equal(postNewOnFinalized.body.code, 'READING_ALREADY_BILLED');
  });

  await t.test('2. Important #2 + Minor #2: Deposit settlement guards late period > endPeriod unbilled readings, intervening contracts & explicit contract_id prior month', async () => {
    // 2A: Late reading in 2029-04 for contract ending 2029-03-31 (vacant in 2029-04) must still require issued invoice
    const aptLate = await createApartment('RF2A');
    const meterLate = await createMeter(aptLate, 'ELRF2A', 1000, 3500);
    const cLate = await createContractSeed({
      apartmentId: aptLate,
      tag: 'LATE',
      startYmd: '2029-01-01',
      endYmd: '2029-03-31',
      status: 'TERMINATED',
      termYmd: '2029-03-31',
    });

    // Record reading in 2029-04 (vacant -> contract_id IS NULL, consumption 120 > 0)
    const rApr = await apiFetch(`/api/v1/meters/${meterLate}/readings`, mgrToken, {
      method: 'POST',
      body: JSON.stringify({
        period: '2029-04',
        current_reading: 1120,
        status: 'CONFIRMED',
        note: 'Late handover reading recorded on Apr 2',
      }),
    });
    assert.equal(rApr.status, 201);
    assert.equal(rApr.body.data.contract_id, null);

    const preLate = await apiFetch(`/api/v1/deposits/${cLate.depositId}/settlement`, mgrToken);
    assert.equal(preLate.status, 200);
    assert.equal(preLate.body.data.preconditions.final_meters_recorded, true);
    assert.equal(
      preLate.body.data.preconditions.final_invoice_issued,
      false,
      'Late reading with positive consumption must NOT bypass final_invoice_issued'
    );
    assert.deepEqual(preLate.body.data.preconditions.unbilled_meter_types, ['ELECTRICITY']);

    // 2B: Intervening contract M2 prevents M1 from using subsequent vacant reading in 2029-10
    const aptInt = await createApartment('RF2B');
    const meterInt = await createMeter(aptInt, 'ELRF2B', 500, 3500);
    const cM1 = await createContractSeed({
      apartmentId: aptInt,
      tag: 'M1',
      startYmd: '2029-09-01',
      endYmd: '2029-12-31',
      status: 'TERMINATED',
      termYmd: '2029-09-12',
    });
    await createContractSeed({
      apartmentId: aptInt,
      tag: 'M2',
      startYmd: '2029-09-18',
      endYmd: '2029-12-31',
      status: 'TERMINATED',
      termYmd: '2029-09-28',
    });
    await apiFetch(`/api/v1/meters/${meterInt}/readings`, mgrToken, {
      method: 'POST',
      body: JSON.stringify({
        period: '2029-10',
        current_reading: 560,
        status: 'CONFIRMED',
      }),
    });

    const preM1 = await apiFetch(`/api/v1/deposits/${cM1.depositId}/settlement`, mgrToken);
    assert.equal(preM1.status, 200);
    assert.equal(
      preM1.body.data.preconditions.final_meters_recorded,
      false,
      'Intervening contract M2 must block M1 from claiming 2029-10 vacant reading'
    );

    // Minor #2: Explicit contract_id generates missed prior month invoice for contract terminated in next month
    const aptPrior = await createApartment('RF2C');
    const meterPrior = await createMeter(aptPrior, 'ELRF2C', 200, 3500);
    const cPrior = await createContractSeed({
      apartmentId: aptPrior,
      tag: 'PR',
      startYmd: '2029-10-01',
      endYmd: '2030-03-31',
      status: 'TERMINATED',
      termYmd: '2029-11-05',
    });
    await apiFetch(`/api/v1/meters/${meterPrior}/readings`, mgrToken, {
      method: 'POST',
      body: JSON.stringify({
        period: '2029-10',
        contract_id: cPrior.contractId,
        current_reading: 250,
        status: 'CONFIRMED',
      }),
    });
    const genPriorOct = await apiFetch('/api/v1/invoices/generate-batch', mgrToken, {
      method: 'POST',
      body: JSON.stringify({
        building_id: bldgId,
        contract_id: cPrior.contractId,
        period: '2029-10',
      }),
    });
    assert.equal(genPriorOct.status, 201);
    assert.equal(genPriorOct.body.data.length, 1, 'Explicit contract_id must allow billing unbilled prior month');
  });

  await t.test('3. Important #3: Confirming orphan DRAFT reading adopts Slot 1 contract_id, syncs DRAFT invoice & isolates RLS', async () => {
    const apt = await createApartment('RF3');
    const meter = await createMeter(apt, 'ELRF3', 500, 3500);

    // Record DRAFT reading BEFORE S1 exists -> contract_id IS NULL
    const orphanRes = await apiFetch(`/api/v1/meters/${meter}/readings`, mgrToken, {
      method: 'POST',
      body: JSON.stringify({
        period: '2029-07',
        current_reading: 580,
        status: 'DRAFT',
      }),
    });
    assert.equal(orphanRes.status, 201);
    const orphanId = orphanRes.body.data.id;
    assert.equal(orphanRes.body.data.contract_id, null);

    // Now create S1 and generate DRAFT invoice with allow_missing_meter_readings: true
    const cS1 = await createContractSeed({
      apartmentId: apt,
      tag: 'S1',
      startYmd: '2029-07-01',
      endYmd: '2029-12-31',
      status: 'TERMINATED',
      termYmd: '2029-07-15',
    });
    const genDraftS1 = await apiFetch('/api/v1/invoices/generate-batch', mgrToken, {
      method: 'POST',
      body: JSON.stringify({
        building_id: bldgId,
        contract_id: cS1.contractId,
        period: '2029-07',
        allow_missing_meter_readings: true,
        auto_issue: false,
      }),
    });
    assert.equal(genDraftS1.status, 201);
    const draftInvId = genDraftS1.body.data[0].id;

    // Confirm orphan reading via /confirm -> must adopt cS1.contractId and sync DRAFT invoice!
    const confRes = await apiFetch(`/api/v1/meters/readings/${orphanId}/confirm`, mgrToken, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    assert.equal(confRes.status, 200, JSON.stringify(confRes.body));
    assert.equal(confRes.body.data.contract_id, cS1.contractId, 'Confirm must adopt Slot 1 contract_id');

    const syncedLines = await adminPool.query(
      `SELECT item_type, quantity, amount FROM invoice_line WHERE invoice_id = $1`,
      [draftInvId]
    );
    const elecLine = syncedLines.rows.find((l) => l.item_type === 'ELECTRICITY');
    assert.ok(elecLine, 'Adopted confirm must sync ELECTRICITY line onto S1 DRAFT invoice');
    assert.equal(Number(elecLine.quantity), 80);

    // Later S2 moves in; under RLS, S2 cannot see S1's reading
    const cS2 = await createContractSeed({
      apartmentId: apt,
      tag: 'S2',
      startYmd: '2029-07-20',
      endYmd: '2029-12-31',
      status: 'ACTIVE',
    });
    const rlsClient = await rlsPool.connect();
    try {
      await rlsClient.query('BEGIN');
      await rlsClient.query(
        `SELECT set_config('request.jwt.claims', $1, true)`,
        [JSON.stringify({ sub: cS2.personId, org_id: orgId, person_id: cS2.personId, roles: [{ code: 'RESIDENT' }] })]
      );
      const vis = await rlsClient.query(`SELECT id FROM meter_reading WHERE id = $1`, [orphanId]);
      assert.equal(vis.rows.length, 0, 'Resident S2 must not see S1 adopted reading');
      await rlsClient.query('ROLLBACK');
    } finally {
      rlsClient.release();
    }
  });

  await t.test('4. Important #4: /ai/meter-ocr validates explicit contract_id & MeterReadingsPage isolates per-slot OCR state', async () => {
    const apt = await createApartment('RF4');
    const meter = await createMeter(apt, 'ELRF4', 300, 3500);
    await createContractSeed({
      apartmentId: apt,
      tag: 'OA',
      startYmd: '2029-08-01',
      endYmd: '2029-12-31',
      status: 'ACTIVE',
    });

    // Unknown explicit contract_id on /api/v1/ai/meter-ocr must return 400 VALIDATION_ERROR (proving contract_id is wired through)
    const badOcr = await apiFetch('/api/v1/ai/meter-ocr', mgrToken, {
      method: 'POST',
      body: JSON.stringify({
        meter_id: meter,
        period: '2029-08',
        contract_id: '00000000-0000-0000-0000-000000000001',
        image_base64: TINY_PNG_DATA_URI,
      }),
    });
    assert.equal(badOcr.status, 400, JSON.stringify(badOcr.body));
    assert.equal(badOcr.body.code, 'VALIDATION_ERROR');

    const pagePath = path.join(REPO_ROOT, 'frontend', 'src', 'pages', 'admin', 'meters', 'MeterReadingsPage.jsx');
    const src = await fs.readFile(pagePath, 'utf8');
    assert.match(src, /getMeterOcrSlotKey/, 'MeterReadingsPage must key AI OCR state per contract slot');
    assert.match(src, /contract_id:\s*ocrContractId/, 'handleMeterOcrScan must pass contract_id to aiService.ocrMeterReading');
  });
});

