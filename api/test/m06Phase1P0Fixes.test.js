import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cors from 'cors';
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

const TINY_PNG_B64 =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

function isoDaysFromToday(offsetDays) {
  const vnTodayStr = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Ho_Chi_Minh',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  const [y, m, d] = vnTodayStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + offsetDays)).toISOString().slice(0, 10);
}

test('M06 Phase 1 (P0) — Deposit Ceiling, Pre-Payout Notice, Snapshot/Ledger Guards, DEDUCTED_FULL & Idempotency', async (t) => {
  const { adminPool, appPool } = await import('../src/db/client.js');
  const { default: authRoute } = await import('../src/routes/auth.js');
  const { default: apartmentsRoute } = await import('../src/routes/apartments.js');
  const { default: contractsRoute } = await import('../src/routes/contracts.js');
  const { default: depositsRoute } = await import('../src/routes/deposits.js');
  const { default: reservationsRoute } = await import('../src/routes/reservations.js');
  const { default: residentRoute } = await import('../src/routes/resident.js');
  const { default: invoicesRoute } = await import('../src/routes/invoices.js');

  const app = express();
  app.use(
    cors({
      origin: '*',
      methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key'],
      exposedHeaders: ['Idempotent-Replayed'],
    })
  );
  app.use(express.json({ limit: '20mb' }));
  app.use('/api/v1/auth', authRoute);
  app.use('/api/v1/apartments', apartmentsRoute);
  app.use('/api/v1/contracts', contractsRoute);
  app.use('/api/v1/deposits', depositsRoute);
  app.use('/api/v1/reservations', reservationsRoute);
  app.use('/api/v1/resident', residentRoute);
  app.use('/api/v1/invoices', invoicesRoute);

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const API_BASE = `http://127.0.0.1:${server.address().port}`;

  async function apiFetch(path, token, options = {}) {
    const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(`${API_BASE}${path}`, { ...options, headers });
    const contentType = res.headers.get('content-type') || '';
    const text = await res.text();
    let body = null;
    if (contentType.includes('application/json')) {
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = { raw: text };
      }
    } else {
      body = { raw: text };
    }
    return { status: res.status, headers: res.headers, contentType, body };
  }

  async function loginEmail(email, password) {
    const res = await apiFetch('/api/v1/auth/login', null, {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
    assert.equal(res.status, 200, `Login failed for ${email}: ${JSON.stringify(res.body)}`);
    return { token: res.body.accessToken, user: res.body.user };
  }

  const suffix = `${String(Date.now()).slice(-6)}`;
  const cleanup = {
    contractIds: [],
    apartmentIds: [],
    reservationIds: [],
    invoiceIds: [],
    tenantIds: [],
    userIds: [],
    personIds: [],
  };

  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    for (const invId of cleanup.invoiceIds) {
      await adminPool.query('DELETE FROM receivable WHERE invoice_id = $1', [invId]).catch(() => {});
      await adminPool.query('DELETE FROM invoice_line WHERE invoice_id = $1', [invId]).catch(() => {});
      await adminPool.query('DELETE FROM invoice WHERE id = $1', [invId]).catch(() => {});
    }
    for (const cId of cleanup.contractIds) {
      await adminPool.query('DELETE FROM receivable WHERE contract_id = $1', [cId]).catch(() => {});
      await adminPool
        .query('DELETE FROM invoice_line WHERE invoice_id IN (SELECT id FROM invoice WHERE contract_id = $1)', [cId])
        .catch(() => {});
      await adminPool.query('DELETE FROM invoice WHERE contract_id = $1', [cId]).catch(() => {});
      await adminPool.query('DELETE FROM notification WHERE payload::text LIKE $1', [`%${cId}%`]).catch(() => {});
      const depClean = await adminPool.connect();
      try {
        await depClean.query('BEGIN');
        await depClean.query("SET LOCAL app.allow_test_cleanup = 'true'");
        await depClean.query(
          `DELETE FROM attachment WHERE owner_entity = 'deposit' AND owner_id IN (SELECT id FROM deposit WHERE contract_id = $1)`,
          [cId]
        );
        await depClean.query(
          'DELETE FROM deposit_transaction WHERE deposit_id IN (SELECT id FROM deposit WHERE contract_id = $1)',
          [cId]
        );
        await depClean.query('DELETE FROM deposit WHERE contract_id = $1', [cId]);
        await depClean.query('COMMIT');
      } catch {
        await depClean.query('ROLLBACK').catch(() => {});
      } finally {
        depClean.release();
      }
      await adminPool.query("DELETE FROM attachment WHERE owner_entity = 'contract' AND owner_id = $1", [cId]).catch(() => {});
      await adminPool.query('DELETE FROM contract_version WHERE contract_id = $1', [cId]).catch(() => {});
      await adminPool.query('DELETE FROM contract_occupant WHERE contract_id = $1', [cId]).catch(() => {});
      await adminPool.query('UPDATE contract SET parent_contract_id = NULL WHERE parent_contract_id = $1', [cId]).catch(() => {});
      await adminPool.query('DELETE FROM contract WHERE id = $1', [cId]).catch(() => {});
    }
    for (const rId of cleanup.reservationIds) {
      await adminPool.query('DELETE FROM reservation WHERE id = $1', [rId]).catch(() => {});
    }
    for (const aId of cleanup.apartmentIds) {
      await adminPool.query('DELETE FROM reservation WHERE apartment_id = $1', [aId]).catch(() => {});
      await adminPool.query('DELETE FROM apartment WHERE id = $1', [aId]).catch(() => {});
    }
    for (const tId of cleanup.tenantIds) {
      await adminPool.query('DELETE FROM contract_occupant WHERE tenant_id = $1', [tId]).catch(() => {});
      await adminPool.query('DELETE FROM tenant WHERE id = $1', [tId]).catch(() => {});
    }
    for (const uId of cleanup.userIds) {
      await adminPool.query('DELETE FROM notification WHERE user_id = $1', [uId]).catch(() => {});
      await adminPool.query('DELETE FROM idempotency_key WHERE actor_id = $1', [uId]).catch(() => {});
      await adminPool.query('DELETE FROM user_role WHERE user_id = $1', [uId]).catch(() => {});
      await adminPool
        .query(`DELETE FROM app_user WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM audit_log WHERE actor_id = $1)`, [uId])
        .catch(() => {});
    }
    for (const pId of cleanup.personIds) {
      await adminPool.query('DELETE FROM tenant WHERE person_id = $1', [pId]).catch(() => {});
      await adminPool.query('DELETE FROM user_role WHERE user_id IN (SELECT id FROM app_user WHERE person_id = $1)', [pId]).catch(() => {});
      await adminPool
        .query(`DELETE FROM app_user u WHERE u.person_id = $1 AND NOT EXISTS (SELECT 1 FROM audit_log a WHERE a.actor_id = u.id)`, [pId])
        .catch(() => {});
      await adminPool
        .query(`DELETE FROM person WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM app_user WHERE person_id = $1)`, [pId])
        .catch(() => {});
    }
    await appPool.end().catch(() => {});
    await adminPool.end().catch(() => {});
  });

  const bRes = await adminPool.query(
    `SELECT b.id, b.org_id, f.id AS floor_id
     FROM building b
     JOIN floor f ON f.building_id = b.id
     WHERE b.code = 'VOP-A'
     ORDER BY f.level ASC
     LIMIT 1`
  );
  const buildingId = bRes.rows[0].id;
  const orgId = bRes.rows[0].org_id;
  const floorId = bRes.rows[0].floor_id;

  const sysAdmin = await loginEmail('admin@resihub.vn', 'Admin@123456');
  const owner = await loginEmail('owner.vop@resihub.vn', 'Demo@123456');
  const manager = await loginEmail('manager.vop.a@resihub.vn', 'Demo@123456');

  async function createApt(prefix, baseRent = 10000000) {
    const r = await apiFetch('/api/v1/apartments', sysAdmin.token, {
      method: 'POST',
      body: JSON.stringify({
        building_id: buildingId,
        floor_id: floorId,
        code: `${prefix}-${suffix}`,
        area_m2: 48,
        bedrooms: 1,
        type: '1PN',
        base_rent: baseRent,
      }),
    });
    assert.equal(r.status, 201, `Create apt failed: ${JSON.stringify(r.body)}`);
    cleanup.apartmentIds.push(r.body.data.id);
    return r.body.data;
  }

  async function trackPhone(phone) {
    const pRes = await adminPool.query('SELECT id FROM person WHERE phone = $1 LIMIT 1', [phone]);
    if (pRes.rows[0]) {
      const pId = pRes.rows[0].id;
      if (!cleanup.personIds.includes(pId)) cleanup.personIds.push(pId);
      const tRes = await adminPool.query('SELECT id FROM tenant WHERE person_id = $1', [pId]);
      tRes.rows.forEach((r) => !cleanup.tenantIds.includes(r.id) && cleanup.tenantIds.push(r.id));
      const uRes = await adminPool.query('SELECT id FROM app_user WHERE person_id = $1', [pId]);
      uRes.rows.forEach((r) => !cleanup.userIds.includes(r.id) && cleanup.userIds.push(r.id));
    }
  }

  const todayStr = isoDaysFromToday(0);
  const plus7Str = isoDaysFromToday(7);

  // =========================================================================
  // 1-5. Deposit Ceiling, Float/Boolean/Transfer Guards & Idempotency
  // =========================================================================
  await t.test('P0-1..5: Deposit ceiling (including 0 VND & transfer-room & reservation), integer VND, method & idempotency', async () => {
    const aptA = await createApt('P0-APTA', 10000000);
    const aptB = await createApt('P0-APTB', 6000000);
    const aptZero = await createApt('P0-APTZ', 8000000);
    const phoneA = `0971${suffix}`;
    const emailA = `p0.res.a.${suffix}@resihub.test`;

    // Reservation 2M -> attempt contract with deposit_amount = 1M -> 422 DEPOSIT_BELOW_RESERVATION_HOLD
    const rsvLow = await apiFetch('/api/v1/reservations', manager.token, {
      method: 'POST',
      body: JSON.stringify({
        apartment_id: aptA.id,
        prospect_name: `Khách Giữ Chỗ P0 ${suffix}`,
        phone: phoneA,
        hold_amount: 2000000,
        hold_from: todayStr,
        hold_until: plus7Str,
      }),
    });
    assert.equal(rsvLow.status, 201);
    const rsvLowId = rsvLow.body.data.id;
    cleanup.reservationIds.push(rsvLowId);

    const badContractCreate = await apiFetch('/api/v1/contracts', manager.token, {
      method: 'POST',
      body: JSON.stringify({
        apartment_id: aptA.id,
        reservation_id: rsvLowId,
        start_date: todayStr,
        end_date: isoDaysFromToday(180),
        rent_amount: 10000000,
        deposit_amount: 1000000,
        billing_day: 1,
        new_tenant: {
          full_name: `Cư Dân P0 A ${suffix}`,
          phone: phoneA,
          email: emailA,
          id_number: `079301${suffix}`,
          password: 'Password@123',
        },
      }),
    });
    assert.equal(badContractCreate.status, 422);
    assert.equal(badContractCreate.body.code, 'DEPOSIT_BELOW_RESERVATION_HOLD');

    // Also test draft created without reservation_id (matching by phone) with deposit_amount = 1M -> blocked on activate!
    const draftLow = await apiFetch('/api/v1/contracts', manager.token, {
      method: 'POST',
      body: JSON.stringify({
        apartment_id: aptA.id,
        start_date: todayStr,
        end_date: isoDaysFromToday(180),
        rent_amount: 10000000,
        deposit_amount: 1000000,
        billing_day: 1,
        new_tenant: {
          full_name: `Cư Dân P0 A ${suffix}`,
          phone: phoneA,
          email: emailA,
          id_number: `079301${suffix}`,
          password: 'Password@123',
        },
      }),
    });
    assert.equal(draftLow.status, 201);
    cleanup.contractIds.push(draftLow.body.data.id);
    await trackPhone(phoneA);
    await apiFetch(`/api/v1/contracts/${draftLow.body.data.id}/scan`, manager.token, {
      method: 'POST',
      body: JSON.stringify({ image_base64: TINY_PNG_B64 }),
    });
    const badAct = await apiFetch(`/api/v1/contracts/${draftLow.body.data.id}/activate`, manager.token, {
      method: 'POST',
    });
    assert.equal(badAct.status, 422);
    assert.equal(badAct.body.code, 'DEPOSIT_BELOW_RESERVATION_HOLD');
    await adminPool.query(`UPDATE contract SET status = 'CANCELLED' WHERE id = $1`, [draftLow.body.data.id]);

    // Valid contract with deposit_amount = 9.000.000 (transfer 2M from reservation, remaining 7M)
    const cValid = await apiFetch('/api/v1/contracts', manager.token, {
      method: 'POST',
      body: JSON.stringify({
        apartment_id: aptA.id,
        reservation_id: rsvLowId,
        primary_tenant_id: draftLow.body.data.primary_tenant_id,
        start_date: todayStr,
        end_date: isoDaysFromToday(180),
        rent_amount: 10000000,
        deposit_amount: 9000000,
        billing_day: 1,
      }),
    });
    assert.equal(cValid.status, 201);
    const cValidId = cValid.body.data.id;
    cleanup.contractIds.push(cValidId);
    await apiFetch(`/api/v1/contracts/${cValidId}/scan`, manager.token, {
      method: 'POST',
      body: JSON.stringify({ image_base64: TINY_PNG_B64 }),
    });
    const actValid = await apiFetch(`/api/v1/contracts/${cValidId}/activate`, manager.token, {
      method: 'POST',
      body: JSON.stringify({ reservation_id: rsvLowId }),
    });
    assert.equal(actValid.status, 200);

    const depRes = await adminPool.query('SELECT * FROM deposit WHERE contract_id = $1', [cValidId]);
    const depId = depRes.rows[0].id;

    // 1) type = 'transfer' -> 409 TRANSFER_INTERNAL_ONLY
    const badTransfer = await apiFetch(`/api/v1/deposits/${depId}/transactions`, manager.token, {
      method: 'POST',
      body: JSON.stringify({ type: 'transfer', amount: 1000000, method: 'TRANSFER' }),
    });
    assert.equal(badTransfer.status, 409);
    assert.equal(badTransfer.body.code, 'TRANSFER_INTERNAL_ONLY');

    // 2) Float / boolean amount -> 400 INVALID_AMOUNT; invalid method -> 400 INVALID_METHOD
    for (const badAmt of [1000.5, true, '1000.5', '   ']) {
      const r = await apiFetch(`/api/v1/deposits/${depId}/transactions`, manager.token, {
        method: 'POST',
        body: JSON.stringify({ type: 'collect', amount: badAmt, method: 'CASH' }),
      });
      assert.equal(r.status, 400);
      assert.equal(r.body.code, 'INVALID_AMOUNT');
    }
    const badMethod = await apiFetch(`/api/v1/deposits/${depId}/transactions`, manager.token, {
      method: 'POST',
      body: JSON.stringify({ type: 'collect', amount: 1000000, method: 'CRYPTO' }),
    });
    assert.equal(badMethod.status, 400);
    assert.equal(badMethod.body.code, 'INVALID_METHOD');

    // 3) Collect exceeding ceiling (2M + 8M > 9M) -> 422 DEPOSIT_EXCEEDS_CONTRACT_AMOUNT
    const overCollect = await apiFetch(`/api/v1/deposits/${depId}/transactions`, manager.token, {
      method: 'POST',
      body: JSON.stringify({ type: 'collect', amount: 8000000, method: 'CASH' }),
    });
    assert.equal(overCollect.status, 422);
    assert.equal(overCollect.body.code, 'DEPOSIT_EXCEEDS_CONTRACT_AMOUNT');

    // 5) Idempotency: replay exact, conflict on diff amount, and NODE_ENV=production mandatory header
    const idemKey = `idem-collect-${crypto.randomUUID()}`;
    const firstCollect = await apiFetch(`/api/v1/deposits/${depId}/transactions`, manager.token, {
      method: 'POST',
      headers: { 'Idempotency-Key': idemKey },
      body: JSON.stringify({
        type: 'collect',
        amount: ' 7000000 ',
        method: 'BANK_TRANSFER',
        evidence: ['https://example.com/collect-7m.png'],
      }),
    });
    assert.equal(firstCollect.status, 201);

    const replayCollect = await apiFetch(`/api/v1/deposits/${depId}/transactions`, manager.token, {
      method: 'POST',
      headers: { 'Idempotency-Key': idemKey },
      body: JSON.stringify({
        type: 'collect',
        amount: ' 7000000 ',
        method: 'BANK_TRANSFER',
        evidence: ['https://example.com/collect-7m.png'],
      }),
    });
    assert.equal(replayCollect.status, 201);
    assert.equal(replayCollect.headers.get('idempotent-replayed'), 'true');
    assert.equal(replayCollect.body.data.id, firstCollect.body.data.id);

    const conflictCollect = await apiFetch(`/api/v1/deposits/${depId}/transactions`, manager.token, {
      method: 'POST',
      headers: { 'Idempotency-Key': idemKey },
      body: JSON.stringify({
        type: 'collect',
        amount: 1000000,
        method: 'BANK_TRANSFER',
      }),
    });
    assert.equal(conflictCollect.status, 409);
    assert.equal(conflictCollect.body.code, 'IDEMPOTENCY_KEY_CONFLICT');

    // Attachment row created for collect evidence
    const attCollect = await adminPool.query(
      `SELECT * FROM attachment WHERE owner_entity = 'deposit' AND owner_id = $1 AND storage_path = 'https://example.com/collect-7m.png'`,
      [depId]
    );
    assert.equal(attCollect.rows.length, 1);

    // Production NODE_ENV requires Idempotency-Key by default
    const prevNodeEnv = process.env.NODE_ENV;
    const prevReqIdem = process.env.REQUIRE_IDEMPOTENCY_KEY;
    try {
      process.env.NODE_ENV = 'production';
      delete process.env.REQUIRE_IDEMPOTENCY_KEY;
      const missingKeyProd = await apiFetch(`/api/v1/deposits/${depId}/transactions`, manager.token, {
        method: 'POST',
        body: JSON.stringify({ type: 'collect', amount: 100000, method: 'CASH' }),
      });
      assert.equal(missingKeyProd.status, 400);
      assert.equal(missingKeyProd.body.code, 'IDEMPOTENCY_KEY_REQUIRED');
    } finally {
      if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prevNodeEnv;
      if (prevReqIdem === undefined) delete process.env.REQUIRE_IDEMPOTENCY_KEY;
      else process.env.REQUIRE_IDEMPOTENCY_KEY = prevReqIdem;
    }

    // Room transfer (transfer_deposit: true) from 9M held to aptB with deposit_amount = 6M -> 4-step (DRAFT -> scan -> PENDING_APPROVAL -> OWNER approve) -> new gets 6M, old keeps 3M HELD + refund_due_date
    const transferRes = await apiFetch(`/api/v1/contracts/${cValidId}/transfer-room`, manager.token, {
      method: 'POST',
      body: JSON.stringify({
        new_apartment_id: aptB.id,
        new_start_date: todayStr,
        new_end_date: isoDaysFromToday(180),
        new_rent_amount: 6000000,
        new_deposit_amount: 6000000,
        transfer_deposit: true,
        note: 'Chuyển sang phòng nhỏ hơn mức cọc 6M',
      }),
    });
    assert.equal(transferRes.status, 201, `Transfer failed: ${JSON.stringify(transferRes.body)}`);
    const newCId = transferRes.body.data.new_contract.id;
    cleanup.contractIds.push(newCId);
    assert.equal(transferRes.body.data.new_contract.status, 'DRAFT');

    await apiFetch(`/api/v1/contracts/${newCId}/scan`, manager.token, {
      method: 'POST',
      body: JSON.stringify({ image_base64: TINY_PNG_B64 }),
    });
    const actTr = await apiFetch(`/api/v1/contracts/${newCId}/activate`, manager.token, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    assert.equal(actTr.status, 409);
    assert.equal(actTr.body.code, 'TRANSFER_NEEDS_APPROVAL');

    const appTr = await apiFetch(`/api/v1/contracts/${newCId}/approve`, owner.token, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    assert.equal(appTr.status, 200, JSON.stringify(appTr.body));

    const oldDepAfter = await adminPool.query('SELECT amount_held, status, refund_due_date FROM deposit WHERE id = $1', [depId]);
    assert.equal(Number(oldDepAfter.rows[0].amount_held), 3000000, 'Old deposit must retain 3M surplus');
    assert.equal(oldDepAfter.rows[0].status, 'HELD');
    assert.ok(oldDepAfter.rows[0].refund_due_date, 'Old deposit must receive refund_due_date');

    const newDepAfter = await adminPool.query('SELECT amount_held, status FROM deposit WHERE contract_id = $1', [newCId]);
    assert.equal(Number(newDepAfter.rows[0].amount_held), 6000000, 'New deposit must be capped at 6M');
    assert.equal(newDepAfter.rows[0].status, 'HELD');

    // Zero-deposit contract (deposit_amount = 0): if a deposit row exists with 0 held, collect must fail 422 DEPOSIT_EXCEEDS_CONTRACT_AMOUNT
    const phoneZ = `0972${suffix}`;
    const cZero = await apiFetch('/api/v1/contracts', manager.token, {
      method: 'POST',
      body: JSON.stringify({
        apartment_id: aptZero.id,
        start_date: todayStr,
        end_date: isoDaysFromToday(90),
        rent_amount: 8000000,
        deposit_amount: 0,
        billing_day: 1,
        new_tenant: {
          full_name: `Cư Dân Cọc 0 ${suffix}`,
          phone: phoneZ,
          email: `p0.zero.${suffix}@resihub.test`,
          id_number: `079302${suffix}`,
        },
      }),
    });
    assert.equal(cZero.status, 201);
    cleanup.contractIds.push(cZero.body.data.id);
    await trackPhone(phoneZ);
    await apiFetch(`/api/v1/contracts/${cZero.body.data.id}/scan`, manager.token, {
      method: 'POST',
      body: JSON.stringify({ image_base64: TINY_PNG_B64 }),
    });
    await apiFetch(`/api/v1/contracts/${cZero.body.data.id}/activate`, manager.token, { method: 'POST' });
    const zDepIns = await adminPool.query(
      `INSERT INTO deposit (contract_id, amount_held, status) VALUES ($1, 0, 'HELD') RETURNING id`,
      [cZero.body.data.id]
    );
    const collectOnZero = await apiFetch(`/api/v1/deposits/${zDepIns.rows[0].id}/transactions`, manager.token, {
      method: 'POST',
      body: JSON.stringify({ type: 'collect', amount: 1000000, method: 'CASH' }),
    });
    assert.equal(collectOnZero.status, 422);
    assert.equal(collectOnZero.body.code, 'DEPOSIT_EXCEEDS_CONTRACT_AMOUNT');
  });

  // =========================================================================
  // 4, 6, 7, 8, 9. Pre-payout Notice, Bank Validation, Snapshot Stale & Over-Deposit DEDUCTED_FULL
  // =========================================================================
  await t.test('P0-4,6..9: SETTLEMENT_STATEMENT_READY, bank validation, 3 snapshot-stale cases, capped deduct & DEDUCTED_FULL', async () => {
    const aptC = await createApt('P0-APTC', 10000000);
    const aptD = await createApt('P0-APTD', 7000000);
    const phoneC = `0973${suffix}`;
    const emailC = `p0.res.c.${suffix}@resihub.test`;

    const cRes = await apiFetch('/api/v1/contracts', manager.token, {
      method: 'POST',
      body: JSON.stringify({
        apartment_id: aptC.id,
        start_date: todayStr,
        end_date: isoDaysFromToday(180),
        rent_amount: 10000000,
        deposit_amount: 10000000,
        billing_day: 1,
        new_tenant: {
          full_name: `Cư Dân P0 C ${suffix}`,
          phone: phoneC,
          email: emailC,
          id_number: `079303${suffix}`,
          password: 'Password@123',
        },
      }),
    });
    assert.equal(cRes.status, 201);
    const cId = cRes.body.data.id;
    cleanup.contractIds.push(cId);
    await trackPhone(phoneC);

    await apiFetch(`/api/v1/contracts/${cId}/scan`, manager.token, {
      method: 'POST',
      body: JSON.stringify({ image_base64: TINY_PNG_B64 }),
    });
    await apiFetch(`/api/v1/contracts/${cId}/activate`, manager.token, { method: 'POST' });

    const depQ = await adminPool.query('SELECT id FROM deposit WHERE contract_id = $1', [cId]);
    await adminPool.query("UPDATE meter SET status = 'INACTIVE' WHERE apartment_id = $1", [aptC.id]);
    const depId = depQ.rows[0].id;
    await apiFetch(`/api/v1/deposits/${depId}/transactions`, manager.token, {
      method: 'POST',
      body: JSON.stringify({ type: 'collect', amount: 10000000, method: 'BANK_TRANSFER' }),
    });

    const cMeta = await adminPool.query('SELECT primary_tenant_id FROM contract WHERE id = $1', [cId]);
    const tenantId = cMeta.rows[0].primary_tenant_id;

    // Seed initial open service invoice Inv1 = 500,000 VND
    const inv1Q = await adminPool.query(
      `INSERT INTO invoice (
         org_id, building_id, apartment_id, contract_id, tenant_id,
         invoice_code, period, issue_date, due_date,
         subtotal_amount, adjustment_amount, total_amount, paid_amount, status
       ) VALUES ($1, $2, $3, $4, $5, $6, '2026-10', CURRENT_DATE, CURRENT_DATE + 5, 500000, 0, 500000, 0, 'ISSUED')
       RETURNING id`,
      [orgId, buildingId, aptC.id, cId, tenantId, `INV-P0-1-${suffix}`]
    );
    const inv1Id = inv1Q.rows[0].id;
    cleanup.invoiceIds.push(inv1Id);
    await adminPool.query(
      `INSERT INTO invoice_line (invoice_id, item_type, description, quantity, unit, unit_price, amount)
       VALUES ($1, 'SERVICE', 'Phí dịch vụ T10', 1, 'kỳ', 500000, 500000)`,
      [inv1Id]
    );

    await apiFetch(`/api/v1/contracts/${cId}/terminate`, manager.token, {
      method: 'POST',
      body: JSON.stringify({ terminated_date: todayStr, reason: 'Chấm dứt kiểm thử P0' }),
    });

    // Float deduction item -> 422 INVALID_AMOUNT (never 500 RangeError)
    const floatItem = await apiFetch(`/api/v1/deposits/${depId}/settlement`, manager.token, {
      method: 'POST',
      body: JSON.stringify({
        items: [{ category: 'DAMAGE', amount: 1000.5, description: 'Lẻ xu', evidence: ['https://example.com/e1.png'] }],
        refund_method: 'CASH',
      }),
    });
    assert.equal(floatItem.status, 422);
    assert.equal(floatItem.body.code, 'INVALID_AMOUNT');

    // 6) BANK_TRANSFER with refund > 0 missing bank_info or malformed account_number -> 422
    const noBank = await apiFetch(`/api/v1/deposits/${depId}/settlement`, manager.token, {
      method: 'POST',
      body: JSON.stringify({
        items: [],
        inspection_evidence: ['https://example.com/handover-p0.png'],
        refund_method: 'BANK_TRANSFER',
        bank_info: {},
      }),
    });
    assert.equal(noBank.status, 422);
    assert.equal(noBank.body.code, 'BANK_INFO_REQUIRED');

    const badAcc = await apiFetch(`/api/v1/deposits/${depId}/settlement`, manager.token, {
      method: 'POST',
      body: JSON.stringify({
        items: [],
        inspection_evidence: ['https://example.com/handover-p0.png'],
        refund_method: 'BANK_TRANSFER',
        bank_info: { bank_name: 'VCB', account_number: '0011-0099', account_holder: 'CU DAN C' },
      }),
    });
    assert.equal(badAcc.status, 422);
    assert.equal(badAcc.body.code, 'INVALID_ACCOUNT_NUMBER');

    // Valid submit with whitespace integer ' 500000 ' -> normalized to 500000 + attachment + SETTLEMENT_STATEMENT_READY
    const subOk = await apiFetch(`/api/v1/deposits/${depId}/settlement`, manager.token, {
      method: 'POST',
      body: JSON.stringify({
        items: [
          {
            category: 'CLEANING',
            amount: ' 500000 ',
            description: 'Vệ sinh tổng thể',
            evidence: ['https://example.com/clean-p0.png'],
          },
        ],
        inspection_evidence: ['https://example.com/handover-p0.png'],
        refund_method: 'BANK_TRANSFER',
        bank_info: { bank_name: ' Vietcombank ', account_number: ' 001100888999 ', account_holder: ' CU DAN P0 C ' },
      }),
    });
    assert.equal(subOk.status, 200);
    assert.strictEqual(subOk.body.data.settlement.items[0].amount, 500000);
    assert.equal(subOk.body.data.settlement.bank_info.account_number, '001100888999');

    const attItem = await adminPool.query(
      `SELECT 1 FROM attachment WHERE owner_entity = 'deposit' AND owner_id = $1 AND storage_path = 'https://example.com/clean-p0.png'`,
      [depId]
    );
    assert.equal(attItem.rows.length, 1);

    const residentAuth = await loginEmail(emailC, 'Password@123');
    const readyNotif = await adminPool.query(
      `SELECT * FROM notification WHERE user_id = $1 AND type = 'SETTLEMENT_STATEMENT_READY'`,
      [residentAuth.user.sub]
    );
    assert.equal(readyNotif.rows.length, 1, 'Must notify resident immediately when statement is submitted (R-12)');

    // 8a) Issue new service invoice -> 409 SETTLEMENT_SNAPSHOT_STALE
    const inv2Q = await adminPool.query(
      `INSERT INTO invoice (
         org_id, building_id, apartment_id, contract_id, tenant_id,
         invoice_code, period, issue_date, due_date,
         subtotal_amount, adjustment_amount, total_amount, paid_amount, status
       ) VALUES ($1, $2, $3, $4, $5, $6, '2026-11', CURRENT_DATE, CURRENT_DATE + 5, 300000, 0, 300000, 0, 'ISSUED')
       RETURNING id`,
      [orgId, buildingId, aptC.id, cId, tenantId, `INV-P0-2-${suffix}`]
    );
    const inv2Id = inv2Q.rows[0].id;
    cleanup.invoiceIds.push(inv2Id);
    await adminPool.query(
      `INSERT INTO invoice_line (invoice_id, item_type, description, quantity, unit, unit_price, amount)
       VALUES ($1, 'SERVICE', 'Phí phát sinh', 1, 'kỳ', 300000, 300000)`,
      [inv2Id]
    );

    const getStaleA = await apiFetch(`/api/v1/deposits/${depId}/settlement`, manager.token);
    assert.equal(getStaleA.body.data.snapshot_stale, true);

    const appStaleA = await apiFetch(`/api/v1/deposits/${depId}/settlement/approve`, owner.token, { method: 'POST' });
    assert.equal(appStaleA.status, 409);
    assert.equal(appStaleA.body.code, 'SETTLEMENT_SNAPSHOT_STALE');

    // Revert inv2, test 8b) Partial payment on inv1 -> 409 SETTLEMENT_SNAPSHOT_STALE
    await adminPool.query(`UPDATE invoice SET status = 'CANCELLED' WHERE id = $1`, [inv2Id]);
    await adminPool.query(`UPDATE invoice SET paid_amount = 200000, status = 'PARTIALLY_PAID' WHERE id = $1`, [inv1Id]);
    const appStaleB = await apiFetch(`/api/v1/deposits/${depId}/settlement/approve`, owner.token, { method: 'POST' });
    assert.equal(appStaleB.status, 409);
    assert.equal(appStaleB.body.code, 'SETTLEMENT_SNAPSHOT_STALE');

    // Test 8c) Pay off inv1 (500k) AND issue inv3 (500k) -> total serviceDebt stays 500k, but open_invoice_snapshot changed -> 409 SETTLEMENT_SNAPSHOT_STALE!
    await adminPool.query(`UPDATE invoice SET paid_amount = 500000, status = 'PAID' WHERE id = $1`, [inv1Id]);
    const inv3Q = await adminPool.query(
      `INSERT INTO invoice (
         org_id, building_id, apartment_id, contract_id, tenant_id,
         invoice_code, period, issue_date, due_date,
         subtotal_amount, adjustment_amount, total_amount, paid_amount, status
       ) VALUES ($1, $2, $3, $4, $5, $6, '2026-11', CURRENT_DATE, CURRENT_DATE + 5, 500000, 0, 500000, 0, 'ISSUED')
       RETURNING id`,
      [orgId, buildingId, aptC.id, cId, tenantId, `INV-P0-3-${suffix}`]
    );
    const inv3Id = inv3Q.rows[0].id;
    cleanup.invoiceIds.push(inv3Id);
    await adminPool.query(
      `INSERT INTO invoice_line (invoice_id, item_type, description, quantity, unit, unit_price, amount)
       VALUES ($1, 'WATER', 'Nước bổ sung', 1, 'kỳ', 500000, 500000)`,
      [inv3Id]
    );

    const appStaleC = await apiFetch(`/api/v1/deposits/${depId}/settlement/approve`, owner.token, { method: 'POST' });
    assert.equal(appStaleC.status, 409);
    assert.equal(appStaleC.body.code, 'SETTLEMENT_SNAPSHOT_STALE');

    // Reject -> SETTLEMENT_DRAFT -> verify 4) collect on SETTLEMENT_DRAFT returns 409 DEPOSIT_NOT_COLLECTIBLE
    const rej = await apiFetch(`/api/v1/deposits/${depId}/settlement/reject`, owner.token, {
      method: 'POST',
      body: JSON.stringify({ reason: 'Cập nhật lại hóa đơn mở mới nhất' }),
    });
    assert.equal(rej.status, 200);
    assert.equal(rej.body.data.status, 'SETTLEMENT_DRAFT');

    const collectOnDraft = await apiFetch(`/api/v1/deposits/${depId}/transactions`, manager.token, {
      method: 'POST',
      body: JSON.stringify({ type: 'collect', amount: 100000, method: 'CASH' }),
    });
    assert.equal(collectOnDraft.status, 409);
    assert.equal(collectOnDraft.body.code, 'DEPOSIT_NOT_COLLECTIBLE');

    // Resubmit fresh snapshot -> approve -> 200
    const resub = await apiFetch(`/api/v1/deposits/${depId}/settlement`, manager.token, {
      method: 'POST',
      body: JSON.stringify({
        items: [
          {
            category: 'CLEANING',
            amount: 500000,
            description: 'Vệ sinh tổng thể',
            evidence: ['https://example.com/clean-p0.png'],
          },
        ],
        inspection_evidence: ['https://example.com/handover-p0.png'],
        refund_method: 'BANK_TRANSFER',
        bank_info: { bank_name: 'Vietcombank', account_number: '001100888999', account_holder: 'CU DAN P0 C' },
      }),
    });
    assert.equal(resub.status, 200);
    const appOk = await apiFetch(`/api/v1/deposits/${depId}/settlement/approve`, owner.token, { method: 'POST' });
    assert.equal(appOk.status, 200);
    assert.equal(appOk.body.data.status, 'APPROVED_PENDING_PAYOUT');

    const payoutOk = await apiFetch(`/api/v1/deposits/${depId}/payout`, manager.token, {
      method: 'POST',
      body: JSON.stringify({
        evidence: ['https://example.com/unc-p0-c.png'],
        reference_code: 'UNC-P0-C',
      }),
    });
    assert.equal(payoutOk.status, 200);
    assert.equal(payoutOk.body.data.status, 'PARTIALLY_REFUNDED');

    // 9) Over-deposit settlement (held = 5M, DAMAGE = 6.5M -> DEDUCTED_FULL, deduct capped at 5M, PDF & resident overview & dispute)
    const phoneD = `0974${suffix}`;
    const emailD = `p0.res.d.${suffix}@resihub.test`;
    const cDRes = await apiFetch('/api/v1/contracts', manager.token, {
      method: 'POST',
      body: JSON.stringify({
        apartment_id: aptD.id,
        start_date: todayStr,
        end_date: isoDaysFromToday(120),
        rent_amount: 7000000,
        deposit_amount: 5000000,
        billing_day: 1,
        new_tenant: {
          full_name: `Cư Dân P0 D ${suffix}`,
          phone: phoneD,
          email: emailD,
          id_number: `079304${suffix}`,
          password: 'Password@123',
        },
      }),
    });
    assert.equal(cDRes.status, 201);
    const cDId = cDRes.body.data.id;
    cleanup.contractIds.push(cDId);
    await trackPhone(phoneD);
    await apiFetch(`/api/v1/contracts/${cDId}/scan`, manager.token, {
      method: 'POST',
      body: JSON.stringify({ image_base64: TINY_PNG_B64 }),
    });
    await apiFetch(`/api/v1/contracts/${cDId}/activate`, manager.token, { method: 'POST' });
    const depDQ = await adminPool.query('SELECT id FROM deposit WHERE contract_id = $1', [cDId]);
    await adminPool.query("UPDATE meter SET status = 'INACTIVE' WHERE apartment_id = $1", [aptD.id]);
    const depDId = depDQ.rows[0].id;
    await apiFetch(`/api/v1/deposits/${depDId}/transactions`, manager.token, {
      method: 'POST',
      body: JSON.stringify({ type: 'collect', amount: 5000000, method: 'CASH' }),
    });
    await apiFetch(`/api/v1/contracts/${cDId}/terminate`, manager.token, {
      method: 'POST',
      body: JSON.stringify({ terminated_date: todayStr, reason: 'Chấm dứt vượt cọc' }),
    });

    const subD = await apiFetch(`/api/v1/deposits/${depDId}/settlement`, manager.token, {
      method: 'POST',
      body: JSON.stringify({
        items: [
          {
            category: 'DAMAGE',
            amount: 6500000,
            description: 'Hư hỏng tủ bếp & sofa vượt cọc',
            evidence: ['https://example.com/damage-65m.png'],
          },
        ],
        inspection_evidence: ['https://example.com/handover-p0-d.png'],
        refund_method: 'CASH',
      }),
    });
    assert.equal(subD.status, 200);
    const appD = await apiFetch(`/api/v1/deposits/${depDId}/settlement/approve`, owner.token, { method: 'POST' });
    assert.equal(appD.status, 200);
    assert.equal(appD.body.data.status, 'DEDUCTED_FULL');

    const deductSumQ = await adminPool.query(
      `SELECT COALESCE(SUM(amount), 0)::bigint AS total_deduct
       FROM deposit_transaction
       WHERE deposit_id = $1 AND type = 'deduct'`,
      [depDId]
    );
    assert.equal(Number(deductSumQ.rows[0].total_deduct), 5000000, 'Ledger deduct must be capped at heldBefore (5M)');

    const recDQ = await adminPool.query(`SELECT amount, type FROM receivable WHERE deposit_id = $1`, [depDId]);
    assert.equal(recDQ.rows.length, 1);
    assert.equal(recDQ.rows[0].type, 'RECEIVABLE_AFTER_MOVE_OUT');
    assert.equal(Number(recDQ.rows[0].amount), 1500000);

    const pdfD = await apiFetch(`/api/v1/deposits/${depDId}/settlement/pdf`, manager.token);
    assert.equal(pdfD.status, 200);
    assert.match(pdfD.body.raw, /Tiền đặt cọc bảo lưu thực tế[\s\S]*?5\.000\.000\s*₫/);

    const resDAuth = await loginEmail(emailD, 'Password@123');
    const ovD = await apiFetch('/api/v1/resident/overview', resDAuth.token);
    assert.equal(ovD.status, 200);
    const settledInOv = ovD.body.data.deposit_settlements.find((s) => s.deposit_id === depDId);
    assert.ok(settledInOv, 'DEDUCTED_FULL deposit must appear in resident overview deposit_settlements');
    assert.equal(settledInOv.deposit_status, 'DEDUCTED_FULL');

    // Dispute on DEDUCTED_FULL -> 200 DISPUTED; ADJUST -> 409 ALREADY_PAID_OUT; CONFIRM -> DEDUCTED_FULL
    const dispD = await apiFetch(`/api/v1/deposits/${depDId}/dispute`, resDAuth.token, {
      method: 'POST',
      body: JSON.stringify({ reason: 'Xin xem lại bảng giá sửa sofa' }),
    });
    assert.equal(dispD.status, 200);
    assert.equal(dispD.body.data.status, 'DISPUTED');

    const adjD = await apiFetch(`/api/v1/deposits/${depDId}/resolve-dispute`, manager.token, {
      method: 'POST',
      body: JSON.stringify({ resolution: 'ADJUST', reason: 'Thử mở lại' }),
    });
    assert.equal(adjD.status, 409);
    assert.equal(adjD.body.code, 'ALREADY_PAID_OUT');

    const confD = await apiFetch(`/api/v1/deposits/${depDId}/resolve-dispute`, owner.token, {
      method: 'POST',
      body: JSON.stringify({ resolution: 'CONFIRM', reason: 'Đã cung cấp hóa đơn nhà thầu sửa chữa' }),
    });
    assert.equal(confD.status, 200);
    assert.equal(confD.body.data.status, 'DEDUCTED_FULL');
  });

  // =========================================================================
  // Task 3: Reservation Guards (hold_amount > 0, convert blocked, Four-Eyes + reason, EXPIRED cancel, Idempotency)
  // =========================================================================
  await t.test('P0-Task3: Reservation positive hold_amount, convert blocked, Four-Eyes + reason, EXPIRED cancel & idempotency', async () => {
    const { runDailyJobs } = await import('../src/jobs/daily.js');
    const aptR = await createApt('P0-APTR', 9000000);

    // 1) Invalid hold_amount: 0, -500000, 1000.5, omitted -> 400 INVALID_HOLD_AMOUNT
    for (const badHold of [0, -500000, 1000.5, undefined]) {
      const payload = {
        apartment_id: aptR.id,
        prospect_name: `Khách Sai Cọc ${suffix}`,
        phone: `0975${suffix}`,
        hold_from: todayStr,
        hold_until: plus7Str,
      };
      if (badHold !== undefined) payload.hold_amount = badHold;
      const badRsv = await apiFetch('/api/v1/reservations', manager.token, {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      assert.equal(badRsv.status, 400, `Expected 400 for hold_amount=${badHold}, got ${badRsv.status}`);
      assert.equal(badRsv.body.code, 'INVALID_HOLD_AMOUNT');
    }

    // 5) Idempotent POST /api/v1/reservations
    const rsvIdemKey = `idem-rsv-${crypto.randomUUID()}`;
    const rsv1 = await apiFetch('/api/v1/reservations', manager.token, {
      method: 'POST',
      headers: { 'Idempotency-Key': rsvIdemKey },
      body: JSON.stringify({
        apartment_id: aptR.id,
        prospect_name: `Khách Giữ Chỗ Chuẩn ${suffix}`,
        phone: `0976${suffix}`,
        hold_amount: 2000000,
        hold_from: todayStr,
        hold_until: plus7Str,
        note: 'Ghi chú gốc của khách',
      }),
    });
    assert.equal(rsv1.status, 201);
    const rsv1Id = rsv1.body.data.id;
    cleanup.reservationIds.push(rsv1Id);
    await trackPhone(`0976${suffix}`);

    const rsv1Replay = await apiFetch('/api/v1/reservations', manager.token, {
      method: 'POST',
      headers: { 'Idempotency-Key': rsvIdemKey },
      body: JSON.stringify({
        apartment_id: aptR.id,
        prospect_name: `Khách Giữ Chỗ Chuẩn ${suffix}`,
        phone: `0976${suffix}`,
        hold_amount: 2000000,
        hold_from: todayStr,
        hold_until: plus7Str,
        note: 'Ghi chú gốc của khách',
      }),
    });
    assert.equal(rsv1Replay.status, 201);
    assert.equal(rsv1Replay.headers.get('idempotent-replayed'), 'true');
    assert.equal(rsv1Replay.body.data.id, rsv1Id);

    // 2) Manual PATCH /:id/convert -> 409 MUST_CONVERT_VIA_CONTRACT_ACTIVATION (stays HELD)
    const convRes = await apiFetch(`/api/v1/reservations/${rsv1Id}/convert`, manager.token, {
      method: 'PATCH',
    });
    assert.equal(convRes.status, 409);
    assert.equal(convRes.body.code, 'MUST_CONVERT_VIA_CONTRACT_ACTIVATION');
    const stillHeld = await adminPool.query('SELECT status FROM reservation WHERE id = $1', [rsv1Id]);
    assert.equal(stillHeld.rows[0].status, 'HELD');

    // 3) Missing reason -> 400 REASON_REQUIRED; creator self-approve -> 403 FOUR_EYES_VIOLATION; OWNER + reason -> 200 preserving original note
    const noReasonForfeit = await apiFetch(`/api/v1/reservations/${rsv1Id}/forfeit`, owner.token, {
      method: 'PATCH',
      body: JSON.stringify({}),
    });
    assert.equal(noReasonForfeit.status, 400);
    assert.equal(noReasonForfeit.body.code, 'REASON_REQUIRED');

    const selfForfeit = await apiFetch(`/api/v1/reservations/${rsv1Id}/forfeit`, manager.token, {
      method: 'PATCH',
      body: JSON.stringify({ reason: 'Tự duyệt tịch thu' }),
    });
    assert.equal(selfForfeit.status, 403);
    assert.equal(selfForfeit.body.code, 'FOUR_EYES_VIOLATION');

    const okForfeit = await apiFetch(`/api/v1/reservations/${rsv1Id}/forfeit`, owner.token, {
      method: 'PATCH',
      body: JSON.stringify({ reason: 'Khách báo không thuê nữa' }),
    });
    assert.equal(okForfeit.status, 200);
    assert.equal(okForfeit.body.data.status, 'FORFEITED');
    assert.match(okForfeit.body.data.note, /Ghi chú gốc của khách/);
    assert.match(okForfeit.body.data.note, /\[Tịch thu cọc\]: Khách báo không thuê nữa/);

    // 4) EXPIRED reservation after runDailyJobs() still supports refund & forfeit with Four-Eyes + reason
    const rsvExpRefund = await apiFetch('/api/v1/reservations', manager.token, {
      method: 'POST',
      body: JSON.stringify({
        apartment_id: aptR.id,
        prospect_name: `Khách Quá Hạn Hoàn ${suffix}`,
        phone: `0977${suffix}`,
        hold_amount: 1500000,
        hold_from: todayStr,
        hold_until: plus7Str,
        note: 'Phiếu chờ hoàn sau hết hạn',
      }),
    });
    assert.equal(rsvExpRefund.status, 201);
    const rsvExpRefundId = rsvExpRefund.body.data.id;
    cleanup.reservationIds.push(rsvExpRefundId);
    await trackPhone(`0977${suffix}`);

    await adminPool.query(
      `UPDATE reservation SET hold_from = CURRENT_DATE - 5, hold_until = CURRENT_DATE - 1 WHERE id = $1`,
      [rsvExpRefundId]
    );
    await runDailyJobs();

    const expRow = await adminPool.query('SELECT status FROM reservation WHERE id = $1', [rsvExpRefundId]);
    assert.equal(expRow.rows[0].status, 'EXPIRED');

    const noReasonRefund = await apiFetch(`/api/v1/reservations/${rsvExpRefundId}/refund`, owner.token, {
      method: 'PATCH',
      body: JSON.stringify({}),
    });
    assert.equal(noReasonRefund.status, 400);
    assert.equal(noReasonRefund.body.code, 'REASON_REQUIRED');

    const selfRefundExp = await apiFetch(`/api/v1/reservations/${rsvExpRefundId}/refund`, manager.token, {
      method: 'PATCH',
      body: JSON.stringify({ reason: 'Tự hoàn cọc quá hạn' }),
    });
    assert.equal(selfRefundExp.status, 403);
    assert.equal(selfRefundExp.body.code, 'FOUR_EYES_VIOLATION');

    const okRefundExp = await apiFetch(`/api/v1/reservations/${rsvExpRefundId}/refund`, owner.token, {
      method: 'PATCH',
      body: JSON.stringify({ reason: 'Hoàn thiện chí do chủ nhà chậm bàn giao', refund_method: 'CASH' }),
    });
    assert.equal(okRefundExp.status, 200);
    assert.equal(okRefundExp.body.data.status, 'APPROVED_PENDING_PAYOUT');
    assert.match(okRefundExp.body.data.note, /Phiếu chờ hoàn sau hết hạn/);
    assert.match(okRefundExp.body.data.note, /Hoàn thiện chí do chủ nhà chậm bàn giao/);

    const payoutExp = await apiFetch(`/api/v1/reservations/${rsvExpRefundId}/cancel-payout`, manager.token, {
      method: 'POST',
      body: JSON.stringify({ refund_method: 'CASH', note: 'Chi tiền mặt hoàn thiện chí' }),
    });
    assert.equal(payoutExp.status, 200);
    assert.equal(payoutExp.body.data.status, 'REFUNDED');

    const rsvExpForfeit = await apiFetch('/api/v1/reservations', manager.token, {
      method: 'POST',
      body: JSON.stringify({
        apartment_id: aptR.id,
        prospect_name: `Khách Quá Hạn Tịch Thu ${suffix}`,
        phone: `0978${suffix}`,
        hold_amount: 1500000,
        hold_from: todayStr,
        hold_until: plus7Str,
      }),
    });
    assert.equal(rsvExpForfeit.status, 201);
    const rsvExpForfeitId = rsvExpForfeit.body.data.id;
    cleanup.reservationIds.push(rsvExpForfeitId);
    await trackPhone(`0978${suffix}`);

    await adminPool.query(
      `UPDATE reservation SET hold_from = CURRENT_DATE - 5, hold_until = CURRENT_DATE - 1 WHERE id = $1`,
      [rsvExpForfeitId]
    );
    await runDailyJobs();

    const okForfeitExp = await apiFetch(`/api/v1/reservations/${rsvExpForfeitId}/forfeit`, owner.token, {
      method: 'PATCH',
      body: JSON.stringify({ reason: 'Quá hạn giữ chỗ khách không ký HĐ' }),
    });
    assert.equal(okForfeitExp.status, 200);
    assert.equal(okForfeitExp.body.data.status, 'FORFEITED');
  });
});
