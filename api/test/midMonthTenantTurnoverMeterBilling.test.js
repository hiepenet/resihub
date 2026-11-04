import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
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

test('Task 3: Per-Contract Invoice Generation, Room-Transfer Cutoff, Deposit Preconditions & Resident Portal', async (t) => {
  const adminPool = new pg.Pool({ connectionString: ADMIN_DB_URL });

  const { adminPool: appAdminPool, appPool } = await import('../src/db/client.js');
  const { default: authRoute } = await import('../src/routes/auth.js');
  const { default: metersRoute } = await import('../src/routes/meters.js');
  const { default: invoicesRoute } = await import('../src/routes/invoices.js');
  const { default: depositsRoute } = await import('../src/routes/deposits.js');
  const { default: residentRoute } = await import('../src/routes/resident.js');
  const { default: attachmentsRoute } = await import('../src/routes/attachments.js');

  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '10mb' }));
  app.use('/api/v1/auth', authRoute);
  app.use('/api/v1/meters', metersRoute);
  app.use('/api/v1/invoices', invoicesRoute);
  app.use('/api/v1/deposits', depositsRoute);
  app.use('/api/v1/resident', residentRoute);
  app.use('/api/v1/attachments', attachmentsRoute);

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const API_BASE = `http://127.0.0.1:${server.address().port}`;

  async function apiFetch(urlPath, token, options = {}) {
    const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(`${API_BASE}${urlPath}`, { ...options, headers });
    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      const body = await res.json().catch(() => null);
      return { status: res.status, body };
    }
    const raw = await res.text();
    let body = null;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      body = { raw };
    }
    return { status: res.status, body };
  }

  const suffix = `${Date.now().toString().slice(-6)}${Math.floor(Math.random() * 90 + 10)}`;
  const cleanup = {
    files: [],
    attachmentIds: [],
    invoiceIds: [],
    meterIds: [],
    depositIds: [],
    contractIds: [],
    buildingIds: [],
    apartmentIds: [],
    tenantIds: [],
    userIds: [],
    personIds: [],
  };

  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    for (const f of cleanup.files) {
      await fs.unlink(f).catch(() => {});
    }
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

      if (cleanup.attachmentIds.length > 0) {
        await c.query(`DELETE FROM audit_log WHERE entity = 'attachment' AND entity_id = ANY($1::uuid[])`, [cleanup.attachmentIds]);
        await c.query(`DELETE FROM attachment WHERE id = ANY($1::uuid[])`, [cleanup.attachmentIds]);
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
        // Clear parent_contract_id before deleting contracts to satisfy self-FK
        await c.query(`UPDATE contract SET parent_contract_id = NULL WHERE id = ANY($1::uuid[])`, [cleanup.contractIds]);
        await c.query(`DELETE FROM contract WHERE id = ANY($1::uuid[])`, [cleanup.contractIds]);
      }

      if (cleanup.apartmentIds.length > 0) {
        await c.query(`DELETE FROM apartment WHERE id = ANY($1::uuid[])`, [cleanup.apartmentIds]);
      }

      if (cleanup.userIds.length > 0) {
        await c.query(`DELETE FROM user_role WHERE user_id = ANY($1::uuid[])`, [cleanup.userIds]);
        await c.query(`DELETE FROM app_user WHERE id = ANY($1::uuid[])`, [cleanup.userIds]);
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
      await adminPool.end();
      await appPool.end().catch(() => {});
      await appAdminPool.end().catch(() => {});
    }
  });

  // Create an isolated test building and assign VOP-A manager to it so generate-batch(building_id) only touches our test contracts
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

  const resRoleRes = await adminPool.query(`SELECT id FROM role WHERE code = 'RESIDENT' LIMIT 1`);
  const resRoleId = resRoleRes.rows[0].id;
  const pwdHash = await bcrypt.hash('ResiTest@123', 8);

  const bldgIns = await adminPool.query(
    `INSERT INTO building (org_id, code, name, address)
     VALUES ($1, $2, $3, 'Test Address') RETURNING id`,
    [orgId, `TB3-${suffix.slice(0, 5)}`, `Toa Test Turnover ${suffix}`]
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
  assert.equal(loginRes.status, 200, JSON.stringify(loginRes.body));
  const mgrToken = loginRes.body.accessToken;

  async function createApartment(codeTag) {
    const ins = await adminPool.query(
      `INSERT INTO apartment (building_id, code, area_m2, base_rent, status)
       VALUES ($1, $2, 50, 9300000, 'OCCUPIED') RETURNING id`,
      [bldgId, `${codeTag}-${suffix.slice(0, 5)}`]
    );
    cleanup.apartmentIds.push(ins.rows[0].id);
    return ins.rows[0].id;
  }

  async function createMeter(apartmentId, codeTag, initialReading = 0, unitPrice = 3500) {
    const res = await apiFetch('/api/v1/meters', mgrToken, {
      method: 'POST',
      body: JSON.stringify({
        apartment_id: apartmentId,
        meter_type: 'ELECTRICITY',
        meter_code: `${codeTag}-${suffix.slice(0, 5)}`,
        unit_price: unitPrice,
        initial_reading: initialReading,
      }),
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const meterId = res.body.data.id;
    cleanup.meterIds.push(meterId);
    await adminPool.query(
      `UPDATE meter SET created_at = '2026-01-01T00:00:00Z' WHERE id = $1`,
      [meterId]
    );
    return meterId;
  }

  async function createTenantWithOptionalUser(tag, withResidentUser = false) {
    const email = `res_${tag}_${suffix}@test.vn`;
    const p = await adminPool.query(
      `INSERT INTO person (org_id, full_name, phone, email)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [orgId, `Cu Dan ${tag}`, `097${Math.floor(Math.random() * 8999999 + 1000000)}`, email]
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

    let residentToken = null;
    if (withResidentUser) {
      const u = await adminPool.query(
        `INSERT INTO app_user (person_id, password_hash, status)
         VALUES ($1, $2, 'ACTIVE') RETURNING id`,
        [personId, pwdHash]
      );
      cleanup.userIds.push(u.rows[0].id);
      await adminPool.query(
        `INSERT INTO user_role (user_id, role_id, building_id) VALUES ($1, $2, $3)`,
        [u.rows[0].id, resRoleId, bldgId]
      );
      const rLogin = await apiFetch('/api/v1/auth/login', null, {
        method: 'POST',
        body: JSON.stringify({ email, password: 'ResiTest@123' }),
      });
      assert.equal(rLogin.status, 200, JSON.stringify(rLogin.body));
      residentToken = rLogin.body.accessToken;
    }

    return { personId, tenantId, email, residentToken };
  }

  async function createContract({
    apartmentId,
    tenantId,
    startYmd,
    endYmd,
    rentAmount = 9300000,
    status = 'ACTIVE',
    termYmd = null,
    parentContractId = null,
    isRoomTransfer = false,
    transferDeposit = false,
    depositStatus = 'HELD',
    depositHeld = 9300000,
  }) {
    const c = await adminPool.query(
      `INSERT INTO contract (
         building_id, apartment_id, primary_tenant_id, start_date, end_date,
         rent_amount, deposit_amount, billing_day, status, terminated_at,
         parent_contract_id, is_room_transfer, transfer_deposit
       )
       VALUES ($1, $2, $3, $4, $5, $6, $6, 1, $7, $8, $9, $10, $11)
       RETURNING id`,
      [
        bldgId,
        apartmentId,
        tenantId,
        startYmd,
        endYmd,
        rentAmount,
        status,
        termYmd,
        parentContractId,
        isRoomTransfer,
        transferDeposit,
      ]
    );
    const contractId = c.rows[0].id;
    cleanup.contractIds.push(contractId);

    const dep = await adminPool.query(
      `INSERT INTO deposit (contract_id, amount_held, status)
       VALUES ($1, $2, $3) RETURNING id`,
      [contractId, depositHeld, depositStatus]
    );
    cleanup.depositIds.push(dep.rows[0].id);

    return { contractId, depositId: dep.rows[0].id };
  }

  async function createMeterAttachment(readingId, label) {
    const uploadsDir = path.join(process.cwd(), 'uploads', 'meters');
    await fs.mkdir(uploadsDir, { recursive: true });
    const fileName = `test-meter-${label}-${suffix}.png`;
    const relPath = `uploads/meters/${fileName}`;
    const absPath = path.join(process.cwd(), relPath);
    // Minimal 1x1 PNG buffer
    const pngBuf = Buffer.from(
      '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082',
      'hex'
    );
    await fs.writeFile(absPath, pngBuf);
    cleanup.files.push(absPath);

    const att = await adminPool.query(
      `INSERT INTO attachment (owner_entity, owner_id, storage_path, mime, size_bytes, uploaded_by)
       VALUES ('meter_reading', $1, $2, 'image/png', $3, $4)
       RETURNING id`,
      [readingId, relPath, pngBuf.length, mgrUserId]
    );
    cleanup.attachmentIds.push(att.rows[0].id);
    const viewUrl = `/api/v1/attachments/${att.rows[0].id}/view`;
    await adminPool.query(`UPDATE meter_reading SET image_url = $1 WHERE id = $2`, [viewUrl, readingId]);
    return { attachmentId: att.rows[0].id, viewUrl };
  }

  let sharedTurnoverCtx = {};

  await t.test('1. Full mid-month turnover (30/11 -> 15/12 -> 20/12 -> 31/12 -> 31/01) + 3-contract turnover month', async () => {
    const apt1 = await createApartment('T3A1');
    const meter1 = await createMeter(apt1, 'EL3A1', 900, 3500);

    const resA = await createTenantWithOptionalUser('A1', true);
    const resB = await createTenantWithOptionalUser('B1', true);

    const cA = await createContract({
      apartmentId: apt1,
      tenantId: resA.tenantId,
      startYmd: '2028-01-01',
      endYmd: '2028-12-31',
      rentAmount: 9300000,
      status: 'TERMINATED',
      termYmd: '2028-12-15',
    });

    // 30/11 reading: 1000 kWh
    const rNov = await apiFetch(`/api/v1/meters/${meter1}/readings`, mgrToken, {
      method: 'POST',
      body: JSON.stringify({
        period: '2028-11',
        current_reading: 1000,
        status: 'CONFIRMED',
        note: 'Chot cuoi thang 11',
      }),
    });
    assert.equal(rNov.status, 201, JSON.stringify(rNov.body));

    // Issue Nov invoice for Contract A so Nov is clean
    const genNov = await apiFetch('/api/v1/invoices/generate-batch', mgrToken, {
      method: 'POST',
      body: JSON.stringify({
        building_id: bldgId,
        contract_id: cA.contractId,
        period: '2028-11',
        auto_issue: true,
      }),
    });
    assert.equal(genNov.status, 201, JSON.stringify(genNov.body));

    // 15/12 move-out reading for Contract A: 1100 kWh
    const rDecA = await apiFetch(`/api/v1/meters/${meter1}/readings`, mgrToken, {
      method: 'POST',
      body: JSON.stringify({
        period: '2028-12',
        current_reading: 1100,
        status: 'CONFIRMED',
        note: 'Chot tra phong 15/12',
      }),
    });
    assert.equal(rDecA.status, 201, JSON.stringify(rDecA.body));
    const readingIdA = rDecA.body.data.id;
    assert.equal(rDecA.body.data.contract_id, cA.contractId);
    assert.equal(Number(rDecA.body.data.previous_reading), 1000);
    assert.equal(Number(rDecA.body.data.consumption), 100);
    const attA = await createMeterAttachment(readingIdA, 'rA');

    // Generate & issue Contract A's 2028-12 final invoice
    const genDecA = await apiFetch('/api/v1/invoices/generate-batch', mgrToken, {
      method: 'POST',
      body: JSON.stringify({
        building_id: bldgId,
        contract_id: cA.contractId,
        period: '2028-12',
        auto_issue: true,
      }),
    });
    assert.equal(genDecA.status, 201, JSON.stringify(genDecA.body));
    assert.equal(genDecA.body.data.length, 1);
    const invAId = genDecA.body.data[0].id;

    const invALines = await adminPool.query(
      `SELECT item_type, quantity, unit_price, amount, formula_meta
       FROM invoice_line WHERE invoice_id = $1 ORDER BY item_type`,
      [invAId]
    );
    const elecLineA = invALines.rows.find((l) => l.item_type === 'ELECTRICITY');
    assert.ok(elecLineA, 'Contract A 2028-12 invoice must contain ELECTRICITY line');
    assert.equal(Number(elecLineA.quantity), 100);
    assert.equal(Number(elecLineA.amount), 350000);
    assert.equal(elecLineA.formula_meta.reading_id, readingIdA);
    assert.equal(elecLineA.formula_meta.contract_id, cA.contractId);

    // 20/12: Contract B moves in with custom contract_service_price override 4,200 VND/kWh
    const cB = await createContract({
      apartmentId: apt1,
      tenantId: resB.tenantId,
      startYmd: '2028-12-20',
      endYmd: '2029-12-19',
      rentAmount: 9300000,
      status: 'ACTIVE',
    });
    await adminPool.query(
      `INSERT INTO contract_service_price (contract_id, service_code, unit_price, effective_from)
       VALUES ($1, 'ELECTRICITY', 4200, '2028-12-20')`,
      [cB.contractId]
    );

    // Before recording Contract B's 2028-12 reading, generate-batch MUST skip Contract B with MISSING_CONFIRMED_METER_READING
    const genDecBeforeB = await apiFetch('/api/v1/invoices/generate-batch', mgrToken, {
      method: 'POST',
      body: JSON.stringify({
        building_id: bldgId,
        contract_id: cB.contractId,
        period: '2028-12',
        auto_issue: true,
      }),
    });
    assert.equal(genDecBeforeB.status, 201, JSON.stringify(genDecBeforeB.body));
    assert.equal(genDecBeforeB.body.data.length, 0, 'Must not generate Contract B invoice without Contract B reading');
    const skipB = (genDecBeforeB.body.skipped_contracts || []).find((s) => s.contract_id === cB.contractId);
    assert.ok(skipB, `Expected Contract B in skipped_contracts, got ${JSON.stringify(genDecBeforeB.body)}`);
    assert.equal(skipB.reason_code, 'MISSING_CONFIRMED_METER_READING');
    assert.deepEqual(skipB.missing_meter_types, ['ELECTRICITY']);

    // 31/12: Record Contract B's end-of-month reading 1185 kWh (chains automatically from 1100!)
    const rDecB = await apiFetch(`/api/v1/meters/${meter1}/readings`, mgrToken, {
      method: 'POST',
      body: JSON.stringify({
        period: '2028-12',
        current_reading: 1185,
        status: 'CONFIRMED',
        note: 'Chot cuoi thang 12 khach moi',
      }),
    });
    assert.equal(rDecB.status, 201, JSON.stringify(rDecB.body));
    const readingIdB = rDecB.body.data.id;
    assert.equal(rDecB.body.data.contract_id, cB.contractId);
    assert.equal(Number(rDecB.body.data.previous_reading), 1100);
    assert.equal(Number(rDecB.body.data.consumption), 85);
    const attB = await createMeterAttachment(readingIdB, 'rB');

    // Generate & issue Contract B's 2028-12 invoice
    const genDecB = await apiFetch('/api/v1/invoices/generate-batch', mgrToken, {
      method: 'POST',
      body: JSON.stringify({
        building_id: bldgId,
        period: '2028-12',
        auto_issue: true,
      }),
    });
    assert.equal(genDecB.status, 201, JSON.stringify(genDecB.body));
    const invB = genDecB.body.data.find((i) => i.contract_id === cB.contractId);
    assert.ok(invB, `Expected Contract B invoice to be created, got ${JSON.stringify(genDecB.body)}`);

    const invBLines = await adminPool.query(
      `SELECT item_type, quantity, unit_price, amount, formula_meta
       FROM invoice_line WHERE invoice_id = $1 ORDER BY item_type`,
      [invB.id]
    );
    const elecLineB = invBLines.rows.find((l) => l.item_type === 'ELECTRICITY');
    const rentLineB = invBLines.rows.find((l) => l.item_type === 'RENT');
    assert.ok(elecLineB, 'Contract B 2028-12 invoice must contain ELECTRICITY line');
    assert.equal(Number(elecLineB.quantity), 85);
    assert.equal(Number(elecLineB.unit_price), 4200);
    assert.equal(Number(elecLineB.amount), 357000);
    assert.equal(elecLineB.formula_meta.previous_reading, 1100);
    assert.equal(elecLineB.formula_meta.current_reading, 1185);
    assert.equal(elecLineB.formula_meta.reading_id, readingIdB);
    assert.equal(elecLineB.formula_meta.contract_id, cB.contractId);
    // 20/12..31/12 = 12 days out of 31 -> 9,300,000 * 12 / 31 = 3,600,000
    assert.equal(Number(rentLineB.amount), 3600000);

    // 31/01/2029: Next month reading chains cleanly from 1185 -> 1300 (115 kWh)
    const rJan = await apiFetch(`/api/v1/meters/${meter1}/readings`, mgrToken, {
      method: 'POST',
      body: JSON.stringify({
        period: '2029-01',
        current_reading: 1300,
        status: 'CONFIRMED',
        note: 'Chot thang 01/2029',
      }),
    });
    assert.equal(rJan.status, 201, JSON.stringify(rJan.body));
    assert.equal(Number(rJan.body.data.previous_reading), 1185);
    assert.equal(Number(rJan.body.data.consumption), 115);

    sharedTurnoverCtx = { resA, resB, cA, cB, attA, attB, invAId, invBId: invB.id };

    // Review Focus #5: 3 sequential contracts in the same YYYY-MM period (2029-05)
    const aptTriple = await createApartment('T3TR');
    const meterTriple = await createMeter(aptTriple, 'EL3TR', 2000, 3500);
    const t1 = await createTenantWithOptionalUser('TR1');
    const t2 = await createTenantWithOptionalUser('TR2');
    const t3 = await createTenantWithOptionalUser('TR3');

    const c1 = await createContract({
      apartmentId: aptTriple,
      tenantId: t1.tenantId,
      startYmd: '2029-05-01',
      endYmd: '2029-11-30',
      status: 'TERMINATED',
      termYmd: '2029-05-08',
    });
    const c2 = await createContract({
      apartmentId: aptTriple,
      tenantId: t2.tenantId,
      startYmd: '2029-05-10',
      endYmd: '2029-11-30',
      status: 'TERMINATED',
      termYmd: '2029-05-18',
    });
    const c3 = await createContract({
      apartmentId: aptTriple,
      tenantId: t3.tenantId,
      startYmd: '2029-05-20',
      endYmd: '2029-11-30',
      status: 'ACTIVE',
    });

    for (const [contractObj, readingVal] of [
      [c1, 2040],
      [c2, 2095],
      [c3, 2160],
    ]) {
      const rec = await apiFetch(`/api/v1/meters/${meterTriple}/readings`, mgrToken, {
        method: 'POST',
        body: JSON.stringify({
          period: '2029-05',
          contract_id: contractObj.contractId,
          current_reading: readingVal,
          status: 'CONFIRMED',
          note: '3-slot turnover test',
        }),
      });
      assert.equal(rec.status, 201, JSON.stringify(rec.body));
    }

    const genTriple = await apiFetch('/api/v1/invoices/generate-batch', mgrToken, {
      method: 'POST',
      body: JSON.stringify({
        building_id: bldgId,
        period: '2029-05',
        auto_issue: true,
      }),
    });
    assert.equal(genTriple.status, 201, JSON.stringify(genTriple.body));

    const tripleElecRes = await adminPool.query(
      `SELECT inv.contract_id, il.quantity
       FROM invoice inv
       JOIN invoice_line il ON il.invoice_id = inv.id
       WHERE inv.apartment_id = $1 AND inv.period = '2029-05' AND il.item_type = 'ELECTRICITY'`,
      [aptTriple]
    );
    const qtyByContract = Object.fromEntries(
      tripleElecRes.rows.map((r) => [r.contract_id, Number(r.quantity)])
    );
    assert.equal(qtyByContract[c1.contractId], 40);
    assert.equal(qtyByContract[c2.contractId], 55);
    assert.equal(qtyByContract[c3.contractId], 65);
    assert.equal(
      qtyByContract[c1.contractId] + qtyByContract[c2.contractId] + qtyByContract[c3.contractId],
      160
    );
  });

  await t.test('2. Resident Portal meter_image_url & attachment cross-resident isolation', async () => {
    const { resA, resB, attA, attB, invAId, invBId } = sharedTurnoverCtx;

    const portalA = await apiFetch('/api/v1/resident/invoices?period=2028-12', resA.residentToken);
    assert.equal(portalA.status, 200, JSON.stringify(portalA.body));
    const invAData = (portalA.body.data || []).find((i) => i.id === invAId);
    assert.ok(invAData, 'Resident A must see invA');
    const lineA = (invAData.lines || []).find((l) => l.item_type === 'ELECTRICITY');
    assert.equal(lineA.meter_image_url, attA.viewUrl);

    const portalB = await apiFetch('/api/v1/resident/invoices?period=2028-12', resB.residentToken);
    assert.equal(portalB.status, 200, JSON.stringify(portalB.body));
    const invBData = (portalB.body.data || []).find((i) => i.id === invBId);
    assert.ok(invBData, 'Resident B must see invB');
    const lineB = (invBData.lines || []).find((l) => l.item_type === 'ELECTRICITY');
    assert.equal(lineB.meter_image_url, attB.viewUrl);

    // Resident A can view attA, Resident B MUST be forbidden from viewing attA
    const viewOwn = await apiFetch(attA.viewUrl, resA.residentToken);
    assert.equal(viewOwn.status, 200);

    const viewCross = await apiFetch(attA.viewUrl, resB.residentToken);
    assert.equal(viewCross.status, 403, `Expected 403 cross-resident attachment block, got ${viewCross.status}`);
    assert.equal(viewCross.body?.code, 'FORBIDDEN_ATTACHMENT');
  });

  await t.test('3. Per-contract deposit settlement preconditions prevent piggybacking on prior tenant reading', async () => {
    const aptDep = await createApartment('T3DP');
    const meterDep = await createMeter(aptDep, 'EL3DP', 500, 3500);
    const tD1 = await createTenantWithOptionalUser('DP1');
    const tD2 = await createTenantWithOptionalUser('DP2');

    const cD1 = await createContract({
      apartmentId: aptDep,
      tenantId: tD1.tenantId,
      startYmd: '2029-06-01',
      endYmd: '2029-12-31',
      status: 'TERMINATED',
      termYmd: '2029-06-10',
    });

    // D1 records 540 kWh and issues 2029-06 invoice
    const rD1 = await apiFetch(`/api/v1/meters/${meterDep}/readings`, mgrToken, {
      method: 'POST',
      body: JSON.stringify({
        period: '2029-06',
        contract_id: cD1.contractId,
        current_reading: 540,
        status: 'CONFIRMED',
        note: 'D1 move out',
      }),
    });
    assert.equal(rD1.status, 201);
    const genD1 = await apiFetch('/api/v1/invoices/generate-batch', mgrToken, {
      method: 'POST',
      body: JSON.stringify({
        building_id: bldgId,
        contract_id: cD1.contractId,
        period: '2029-06',
        auto_issue: true,
      }),
    });
    assert.equal(genD1.status, 201);

    // D2 moves in 2029-06-12 and also terminates early on 2029-06-28 WITHOUT recording D2's meter reading yet
    const cD2 = await createContract({
      apartmentId: aptDep,
      tenantId: tD2.tenantId,
      startYmd: '2029-06-12',
      endYmd: '2029-12-31',
      status: 'TERMINATED',
      termYmd: '2029-06-28',
    });

    const getPre1 = await apiFetch(`/api/v1/deposits/${cD2.depositId}/settlement`, mgrToken);
    assert.equal(getPre1.status, 200, JSON.stringify(getPre1.body));
    assert.equal(getPre1.body.data.preconditions.final_meters_recorded, false);
    assert.deepEqual(getPre1.body.data.preconditions.missing_meter_types, ['ELECTRICITY']);

    const postSettle1 = await apiFetch(`/api/v1/deposits/${cD2.depositId}/settlement`, mgrToken, {
      method: 'POST',
      body: JSON.stringify({
        items: [],
        refund_method: 'CASH',
        inspection_evidence: ['https://example.com/inspect-d2.jpg'],
      }),
    });
    assert.equal(postSettle1.status, 409, JSON.stringify(postSettle1.body));
    assert.equal(postSettle1.body.code, 'MISSING_FINAL_METER_READING');

    // Now D2 records 590 kWh (50 kWh > 0), but invoice is NOT issued yet -> UNBILLED_FINAL_METER_READING
    const rD2 = await apiFetch(`/api/v1/meters/${meterDep}/readings`, mgrToken, {
      method: 'POST',
      body: JSON.stringify({
        period: '2029-06',
        contract_id: cD2.contractId,
        current_reading: 590,
        status: 'CONFIRMED',
        note: 'D2 move out',
      }),
    });
    assert.equal(rD2.status, 201);

    const postSettle2 = await apiFetch(`/api/v1/deposits/${cD2.depositId}/settlement`, mgrToken, {
      method: 'POST',
      body: JSON.stringify({
        items: [],
        refund_method: 'CASH',
        inspection_evidence: ['https://example.com/inspect-d2.jpg'],
      }),
    });
    assert.equal(postSettle2.status, 409, JSON.stringify(postSettle2.body));
    assert.equal(postSettle2.body.code, 'UNBILLED_FINAL_METER_READING');

    // Issue D2's 2029-06 invoice -> settlement preconditions become ready when inspection evidence is present
    const genD2 = await apiFetch('/api/v1/invoices/generate-batch', mgrToken, {
      method: 'POST',
      body: JSON.stringify({
        building_id: bldgId,
        contract_id: cD2.contractId,
        period: '2029-06',
        auto_issue: true,
      }),
    });
    assert.equal(genD2.status, 201);

    const getPre3 = await apiFetch(`/api/v1/deposits/${cD2.depositId}/settlement`, mgrToken);
    assert.equal(getPre3.status, 200);
    assert.equal(getPre3.body.data.preconditions.final_meters_recorded, true);
    assert.equal(getPre3.body.data.preconditions.final_invoice_issued, true);
  });

  await t.test('4. Room transfer mid-month (deposit TRANSFERRED) & scheduled future-month room transfer', async () => {
    // Case 4A: Mid-month room transfer AptOld -> AptNew on 2029-08-15 with old deposit = TRANSFERRED
    const aptOld = await createApartment('T3RO');
    const aptNew = await createApartment('T3RN');
    const meterOld = await createMeter(aptOld, 'EL3RO', 1000, 3500);
    const meterNew = await createMeter(aptNew, 'EL3RN', 450, 3500);

    const tTransfer = await createTenantWithOptionalUser('RT1');
    const tIncomingOld = await createTenantWithOptionalUser('RT2');
    const tPriorNew = await createTenantWithOptionalUser('RT3');

    // Old contract on AptOld with deposit already TRANSFERRED (as set by approveRoomTransfer)
    const oldContract = await createContract({
      apartmentId: aptOld,
      tenantId: tTransfer.tenantId,
      startYmd: '2029-01-01',
      endYmd: '2029-12-31',
      rentAmount: 9300000,
      status: 'TERMINATED',
      termYmd: '2029-08-15',
      depositStatus: 'TRANSFERRED',
      depositHeld: 0,
    });

    // Child room-transfer contract on AptNew starting 2029-08-15
    const childContract = await createContract({
      apartmentId: aptNew,
      tenantId: tTransfer.tenantId,
      startYmd: '2029-08-15',
      endYmd: '2029-12-31',
      rentAmount: 9300000,
      status: 'ACTIVE',
      parentContractId: oldContract.contractId,
      isRoomTransfer: true,
      transferDeposit: true,
    });

    // Incoming tenant on AptOld starting 2029-08-20
    const incomingOld = await createContract({
      apartmentId: aptOld,
      tenantId: tIncomingOld.tenantId,
      startYmd: '2029-08-20',
      endYmd: '2030-08-19',
      rentAmount: 9300000,
      status: 'ACTIVE',
    });

    // Prior tenant on AptNew who moved out 2029-08-10 at 500 kWh and already billed
    const priorNew = await createContract({
      apartmentId: aptNew,
      tenantId: tPriorNew.tenantId,
      startYmd: '2029-01-01',
      endYmd: '2029-12-31',
      rentAmount: 9300000,
      status: 'TERMINATED',
      termYmd: '2029-08-10',
    });
    await apiFetch(`/api/v1/meters/${meterNew}/readings`, mgrToken, {
      method: 'POST',
      body: JSON.stringify({
        period: '2029-08',
        contract_id: priorNew.contractId,
        current_reading: 500,
        status: 'CONFIRMED',
        note: 'Prior tenant move out on AptNew',
      }),
    });
    await apiFetch('/api/v1/invoices/generate-batch', mgrToken, {
      method: 'POST',
      body: JSON.stringify({
        building_id: bldgId,
        contract_id: priorNew.contractId,
        period: '2029-08',
        auto_issue: true,
      }),
    });

    // Verify AptOld STILL targets oldContract (Slot 1/2), NOT skipping to incomingOld despite deposit = TRANSFERRED!
    const listMetersAug = await apiFetch(`/api/v1/meters?building_id=${bldgId}&period=2029-08`, mgrToken);
    assert.equal(listMetersAug.status, 200);
    const rowOld = listMetersAug.body.data.find((m) => m.id === meterOld);
    assert.equal(rowOld.target_contract_id, oldContract.contractId);
    assert.equal(rowOld.period_slot_index, 1);
    assert.equal(rowOld.period_total_slots, 2);

    // Verify AptNew targets childContract as Slot 2/2 with baseline 500
    const rowNew = listMetersAug.body.data.find((m) => m.id === meterNew);
    assert.equal(rowNew.target_contract_id, childContract.contractId);
    assert.equal(rowNew.period_slot_index, 2);
    assert.equal(Number(rowNew.last_known_reading), 500);

    // Record AptOld move-out reading (1060) -> issue oldContract -> record incomingOld (1115) & AptNew childContract (575) -> issue batch
    const rOldOut = await apiFetch(`/api/v1/meters/${meterOld}/readings`, mgrToken, {
      method: 'POST',
      body: JSON.stringify({ period: '2029-08', current_reading: 1060, status: 'CONFIRMED', note: 'Transfer out' }),
    });
    assert.equal(rOldOut.status, 201);
    assert.equal(rOldOut.body.data.contract_id, oldContract.contractId);

    const genOld = await apiFetch('/api/v1/invoices/generate-batch', mgrToken, {
      method: 'POST',
      body: JSON.stringify({
        building_id: bldgId,
        contract_id: oldContract.contractId,
        period: '2029-08',
        auto_issue: true,
      }),
    });
    assert.equal(genOld.status, 201);
    assert.equal(genOld.body.data.length, 1);

    await apiFetch(`/api/v1/meters/${meterOld}/readings`, mgrToken, {
      method: 'POST',
      body: JSON.stringify({ period: '2029-08', current_reading: 1115, status: 'CONFIRMED', note: 'Incoming EOM' }),
    });
    await apiFetch(`/api/v1/meters/${meterNew}/readings`, mgrToken, {
      method: 'POST',
      body: JSON.stringify({ period: '2029-08', current_reading: 575, status: 'CONFIRMED', note: 'Child EOM' }),
    });

    const genRestAug = await apiFetch('/api/v1/invoices/generate-batch', mgrToken, {
      method: 'POST',
      body: JSON.stringify({ building_id: bldgId, period: '2029-08', auto_issue: true }),
    });
    assert.equal(genRestAug.status, 201);
    const createdContractIds = genRestAug.body.data.map((i) => i.contract_id);
    assert.ok(createdContractIds.includes(incomingOld.contractId));
    assert.ok(createdContractIds.includes(childContract.contractId));

    const augElecCheck = await adminPool.query(
      `SELECT inv.contract_id, il.quantity
       FROM invoice inv
       JOIN invoice_line il ON il.invoice_id = inv.id
       WHERE inv.period = '2029-08'
         AND inv.contract_id = ANY($1::uuid[])
         AND il.item_type = 'ELECTRICITY'`,
      [[oldContract.contractId, incomingOld.contractId, childContract.contractId]]
    );
    const augQtyByContract = Object.fromEntries(
      augElecCheck.rows.map((r) => [r.contract_id, Number(r.quantity)])
    );
    assert.equal(augQtyByContract[oldContract.contractId], 60);
    assert.equal(augQtyByContract[incomingOld.contractId], 55);
    assert.equal(augQtyByContract[childContract.contractId], 75);

    // Case 4B: Scheduled future-month room transfer (approved in 2029-11 for 2029-12-15 move)
    const aptFutSrc = await createApartment('T3FS');
    const aptFutDst = await createApartment('T3FD');
    const meterFutSrc = await createMeter(aptFutSrc, 'EL3FS', 300, 3500);
    const tFut = await createTenantWithOptionalUser('RTF');

    const parentFut = await createContract({
      apartmentId: aptFutSrc,
      tenantId: tFut.tenantId,
      startYmd: '2029-01-01',
      endYmd: '2029-12-31',
      rentAmount: 9300000,
      status: 'TERMINATED',
      termYmd: '2029-11-20',
      depositStatus: 'TRANSFERRED',
      depositHeld: 0,
    });
    await createContract({
      apartmentId: aptFutDst,
      tenantId: tFut.tenantId,
      startYmd: '2029-12-15',
      endYmd: '2030-06-30',
      rentAmount: 9300000,
      status: 'ACTIVE',
      parentContractId: parentFut.contractId,
      isRoomTransfer: true,
      transferDeposit: true,
    });

    await apiFetch(`/api/v1/meters/${meterFutSrc}/readings`, mgrToken, {
      method: 'POST',
      body: JSON.stringify({
        period: '2029-11',
        contract_id: parentFut.contractId,
        current_reading: 380,
        status: 'CONFIRMED',
        note: 'Nov reading before Dec transfer',
      }),
    });
    await apiFetch(`/api/v1/meters/${meterFutSrc}/readings`, mgrToken, {
      method: 'POST',
      body: JSON.stringify({
        period: '2029-12',
        contract_id: parentFut.contractId,
        current_reading: 420,
        status: 'CONFIRMED',
        note: 'Dec 14 transfer reading',
      }),
    });

    // Building-wide generate-batch for 2029-11 MUST include parentFut (full Nov rent + 80 kWh)
    const genFutNov = await apiFetch('/api/v1/invoices/generate-batch', mgrToken, {
      method: 'POST',
      body: JSON.stringify({ building_id: bldgId, period: '2029-11', auto_issue: true }),
    });
    assert.equal(genFutNov.status, 201, JSON.stringify(genFutNov.body));
    const invFutNov = genFutNov.body.data.find((i) => i.contract_id === parentFut.contractId);
    assert.ok(invFutNov, `Scheduled room-transfer parent must be billed in 2029-11, got ${JSON.stringify(genFutNov.body)}`);

    // Building-wide generate-batch for 2029-12 MUST also include parentFut (01..14 Dec = 14/31 rent + 40 kWh)
    const genFutDec = await apiFetch('/api/v1/invoices/generate-batch', mgrToken, {
      method: 'POST',
      body: JSON.stringify({ building_id: bldgId, period: '2029-12', auto_issue: true }),
    });
    assert.equal(genFutDec.status, 201, JSON.stringify(genFutDec.body));
    const invFutDec = genFutDec.body.data.find((i) => i.contract_id === parentFut.contractId);
    assert.ok(invFutDec, `Scheduled room-transfer parent must be billed in 2029-12, got ${JSON.stringify(genFutDec.body)}`);

    const futDecLines = await adminPool.query(
      `SELECT item_type, quantity, amount FROM invoice_line WHERE invoice_id = $1`,
      [invFutDec.id]
    );
    const futDecRent = futDecLines.rows.find((l) => l.item_type === 'RENT');
    const futDecElec = futDecLines.rows.find((l) => l.item_type === 'ELECTRICITY');
    assert.equal(Number(futDecRent.amount), 4200000); // 9,300,000 * 14 / 31
    assert.equal(Number(futDecElec.quantity), 40);
  });
});
