import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import pg from 'pg';
import bcrypt from 'bcryptjs';
import { computeSubscriptionPeriodCharge } from '../src/services/serviceBilling.js';

dotenv.config();

const ADMIN_DB_URL =
  process.env.DATABASE_URL ||
  'postgres://postgres:postgres@127.0.0.1:5433/resihub';
const APP_DB_URL =
  process.env.APP_DATABASE_URL ||
  'postgres://resihub_app:resihub_app_secret@127.0.0.1:5433/resihub';

process.env.APP_DATABASE_URL = APP_DB_URL;

test('M09 Invoice Generation Engine — 3-Tier Catalog Fallback (FR-065), AC-015.1 Confirmed Meter Gate & Vietnam Pro-Rata', async (t) => {
  const adminPool = new pg.Pool({ connectionString: ADMIN_DB_URL });

  const { adminPool: appAdminPool, appPool } = await import('../src/db/client.js');
  const { default: authRoute } = await import('../src/routes/auth.js');
  const { default: contractsRoute } = await import('../src/routes/contracts.js');
  const { default: metersRoute } = await import('../src/routes/meters.js');
  const { default: invoicesRoute } = await import('../src/routes/invoices.js');
  const {
    default: servicesRoute,
    serviceCatalogRouter,
    serviceSubscriptionsRouter,
  } = await import('../src/routes/services.js');
  const { default: residentRoute } = await import('../src/routes/resident.js');

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
  app.use('/api/v1/contracts', contractsRoute);
  app.use('/api/v1/meters', metersRoute);
  app.use('/api/v1/invoices', invoicesRoute);
  app.use('/api/v1/services', servicesRoute);
  app.use('/api/v1/service-catalog', serviceCatalogRouter);
  app.use('/api/v1/service-subscriptions', serviceSubscriptionsRouter);
  app.use('/api/v1/resident', residentRoute);

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
    return { status: res.status, headers: res.headers, body };
  }

  async function loginEmail(email, password) {
    const res = await apiFetch('/api/v1/auth/login', null, {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
    assert.equal(res.status, 200, `Login failed for ${email}: ${JSON.stringify(res.body)}`);
    return { token: res.body.accessToken, user: res.body.user };
  }

  const suffix = `${Date.now().toString().slice(-6)}${Math.floor(Math.random() * 90 + 10)}`;
  const cleanup = {
    catalogIds: [],
    subscriptionIds: [],
    meterIds: [],
    contractIds: [],
    apartmentIds: [],
    floorIds: [],
    buildingIds: [],
    ownerIds: [],
    tenantIds: [],
    userIds: [],
    personIds: [],
  };

  const orgRes = await adminPool.query(`SELECT org_id FROM building WHERE code = 'VOP-A' LIMIT 1`);
  const orgId = orgRes.rows[0].org_id;

  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    const c = await adminPool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.allow_test_cleanup', 'true', true)`);

      if (cleanup.contractIds.length > 0) {
        await c.query(
          `DELETE FROM audit_log WHERE entity IN ('invoice', 'invoice_line', 'service_subscription', 'contract_service_price')
             AND (entity_id IN (SELECT id FROM invoice WHERE contract_id = ANY($1::uuid[]))
               OR entity_id IN (SELECT id FROM service_subscription WHERE contract_id = ANY($1::uuid[]))
               OR entity_id IN (SELECT id FROM contract_service_price WHERE contract_id = ANY($1::uuid[])))`,
          [cleanup.contractIds]
        );
        await c.query(`DELETE FROM receivable WHERE contract_id = ANY($1::uuid[])`, [cleanup.contractIds]);
        await c.query(
          `DELETE FROM invoice_line WHERE invoice_id IN (SELECT id FROM invoice WHERE contract_id = ANY($1::uuid[]))`,
          [cleanup.contractIds]
        );
        await c.query(`DELETE FROM invoice WHERE contract_id = ANY($1::uuid[])`, [cleanup.contractIds]);
        await c.query(`DELETE FROM contract_service_price WHERE contract_id = ANY($1::uuid[])`, [cleanup.contractIds]);
        await c.query(`DELETE FROM service_subscription WHERE contract_id = ANY($1::uuid[])`, [cleanup.contractIds]);
      }
      if (cleanup.meterIds.length > 0) {
        await c.query(
          `DELETE FROM audit_log WHERE entity IN ('meter', 'meter_reading')
             AND (entity_id = ANY($1::uuid[])
               OR entity_id IN (SELECT id FROM meter_reading WHERE meter_id = ANY($1::uuid[])))`,
          [cleanup.meterIds]
        );
        await c.query(`DELETE FROM meter_reading WHERE meter_id = ANY($1::uuid[])`, [cleanup.meterIds]);
        await c.query(`DELETE FROM meter WHERE id = ANY($1::uuid[])`, [cleanup.meterIds]);
      }
      if (cleanup.catalogIds.length > 0) {
        await c.query(`DELETE FROM audit_log WHERE entity = 'service_catalog' AND entity_id = ANY($1::uuid[])`, [cleanup.catalogIds]);
        await c.query(`DELETE FROM service_catalog WHERE id = ANY($1::uuid[])`, [cleanup.catalogIds]);
      }
      if (cleanup.contractIds.length > 0) {
        await c.query(`DELETE FROM contract WHERE id = ANY($1::uuid[])`, [cleanup.contractIds]);
      }
      if (cleanup.apartmentIds.length > 0) {
        await c.query(`DELETE FROM apartment WHERE id = ANY($1::uuid[])`, [cleanup.apartmentIds]);
      }
      if (cleanup.floorIds.length > 0) {
        await c.query(`DELETE FROM floor WHERE id = ANY($1::uuid[])`, [cleanup.floorIds]);
      }
      if (cleanup.buildingIds.length > 0) {
        await c.query(`DELETE FROM building WHERE id = ANY($1::uuid[])`, [cleanup.buildingIds]);
      }
      if (cleanup.ownerIds.length > 0) {
        await c.query(`DELETE FROM owner WHERE id = ANY($1::uuid[])`, [cleanup.ownerIds]);
      }
      if (cleanup.tenantIds.length > 0) {
        await c.query(`DELETE FROM tenant WHERE id = ANY($1::uuid[])`, [cleanup.tenantIds]);
      }
      if (cleanup.userIds.length > 0) {
        await c.query(`DELETE FROM notification WHERE user_id = ANY($1::uuid[])`, [cleanup.userIds]);
        await c.query(`DELETE FROM idempotency_key WHERE actor_id = ANY($1::uuid[])`, [cleanup.userIds]);
        await c.query(`DELETE FROM audit_log WHERE actor_id = ANY($1::uuid[])`, [cleanup.userIds]);
        await c.query(`DELETE FROM user_role WHERE user_id = ANY($1::uuid[])`, [cleanup.userIds]);
        await c.query(`DELETE FROM app_user WHERE id = ANY($1::uuid[])`, [cleanup.userIds]);
      }
      if (cleanup.personIds.length > 0) {
        await c.query(`DELETE FROM person WHERE id = ANY($1::uuid[])`, [cleanup.personIds]);
      }
      await c.query('COMMIT');
    } catch (err) {
      await c.query('ROLLBACK');
      console.error('[M09 Test Cleanup Error]:', err.message);
    } finally {
      c.release();
      await adminPool.end().catch(() => {});
      await appPool.end().catch(() => {});
      await appAdminPool.end().catch(() => {});
    }
  });

  const pwHash = await bcrypt.hash('Demo@123456', 10);
  const rolesRes = await adminPool.query(
    `SELECT code, id FROM role WHERE org_id = $1 AND code IN ('OWNER', 'MANAGER', 'RESIDENT')`,
    [orgId]
  );
  const roleMap = Object.fromEntries(rolesRes.rows.map((r) => [r.code, r.id]));

  // Dedicated isolated building B1 with OWNER & MANAGER
  const ownP = await adminPool.query(
    `INSERT INTO person (org_id, full_name, phone, email)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [orgId, `Owner M09 ${suffix}`, `0941${suffix.slice(0, 6)}`, `own.m09.${suffix}@resihub.test`]
  );
  cleanup.personIds.push(ownP.rows[0].id);
  const ownRec = await adminPool.query(
    `INSERT INTO owner (org_id, person_id, full_name, phone, email)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [orgId, ownP.rows[0].id, `Owner M09 ${suffix}`, `0941${suffix.slice(0, 6)}`, `own.m09.${suffix}@resihub.test`]
  );
  cleanup.ownerIds.push(ownRec.rows[0].id);

  const b1Res = await adminPool.query(
    `INSERT INTO building (org_id, owner_id, code, name, address)
     VALUES ($1, $2, $3, $4, 'M09 Test Ave') RETURNING id, code`,
    [orgId, ownRec.rows[0].id, `M09B-${suffix.slice(-4)}`, `Tòa M09 ${suffix}`]
  );
  const b1Id = b1Res.rows[0].id;
  cleanup.buildingIds.push(b1Id);

  const flrRes = await adminPool.query(
    `INSERT INTO floor (building_id, level, name) VALUES ($1, 1, 'Tầng 1') RETURNING id`,
    [b1Id]
  );
  const flrId = flrRes.rows[0].id;
  cleanup.floorIds.push(flrId);

  const mgrP = await adminPool.query(
    `INSERT INTO person (org_id, full_name, phone, email)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [orgId, `Mgr M09 ${suffix}`, `0942${suffix.slice(0, 6)}`, `mgr.m09.${suffix}@resihub.test`]
  );
  cleanup.personIds.push(mgrP.rows[0].id);
  const mgrU = await adminPool.query(
    `INSERT INTO app_user (person_id, password_hash, status) VALUES ($1, $2, 'ACTIVE') RETURNING id`,
    [mgrP.rows[0].id, pwHash]
  );
  cleanup.userIds.push(mgrU.rows[0].id);
  await adminPool.query(
    `INSERT INTO user_role (user_id, role_id, building_id) VALUES ($1, $2, $3)`,
    [mgrU.rows[0].id, roleMap.MANAGER, b1Id]
  );
  const mgrB1 = await loginEmail(`mgr.m09.${suffix}@resihub.test`, 'Demo@123456');

  async function createApartmentContractResident(tag, rentAmount = 8000000) {
    const aptR = await adminPool.query(
      `INSERT INTO apartment (building_id, floor_id, code, area_m2, base_rent, status)
       VALUES ($1, $2, $3, 50, $4, 'OCCUPIED') RETURNING id, code`,
      [b1Id, flrId, `${tag}-${suffix.slice(-4)}`, rentAmount]
    );
    const aptId = aptR.rows[0].id;
    cleanup.apartmentIds.push(aptId);

    const email = `res.${tag.toLowerCase()}.${suffix}@resihub.test`;
    const pR = await adminPool.query(
      `INSERT INTO person (org_id, full_name, phone, email)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [orgId, `Res ${tag} ${suffix}`, `0943${tag.slice(-1)}${suffix.slice(0, 5)}`, email]
    );
    cleanup.personIds.push(pR.rows[0].id);
    const uR = await adminPool.query(
      `INSERT INTO app_user (person_id, password_hash, status) VALUES ($1, $2, 'ACTIVE') RETURNING id`,
      [pR.rows[0].id, pwHash]
    );
    cleanup.userIds.push(uR.rows[0].id);
    await adminPool.query(
      `INSERT INTO user_role (user_id, role_id, building_id) VALUES ($1, $2, $3)`,
      [uR.rows[0].id, roleMap.RESIDENT, b1Id]
    );
    const tR = await adminPool.query(
      `INSERT INTO tenant (org_id, person_id, type, status) VALUES ($1, $2, 'primary', 'APPROVED') RETURNING id`,
      [orgId, pR.rows[0].id]
    );
    cleanup.tenantIds.push(tR.rows[0].id);

    const cR = await adminPool.query(
      `INSERT INTO contract (
         building_id, apartment_id, primary_tenant_id,
         start_date, end_date, rent_amount, deposit_amount, billing_day, status
       )
       VALUES ($1, $2, $3, '2026-01-01', '2028-12-31', $4, $4, 1, 'ACTIVE')
       RETURNING id`,
      [b1Id, aptId, tR.rows[0].id, rentAmount]
    );
    cleanup.contractIds.push(cR.rows[0].id);

    const resAuth = await loginEmail(email, 'Demo@123456');
    return { aptId, contractId: cR.rows[0].id, tenantId: tR.rows[0].id, resAuth };
  }

  const u1 = await createApartmentContractResident('A1', 8000000);
  const u2 = await createApartmentContractResident('A2', 7000000);

  let orgPkgId = null;
  const pkgCode = `PARKING_MOTO_${suffix}`;
  let u1ElMeterId = null;
  let u1MayReadingId = null;

  await t.test('1. 3-Tier Subscription & Utility Pricing (FR-065, Review Focus #2 & AC-003.1)', async () => {
    // Org default PARKING_MOTO = 150.000, Building B1 override = 200.000
    const orgCat = await adminPool.query(
      `INSERT INTO service_catalog (org_id, building_id, code, name, category, billing_type, unit, unit_price, is_active)
       VALUES ($1, NULL, $2, 'Gửi xe máy toàn hệ thống', 'PARKING', 'QUANTITY', 'xe', 150000, TRUE)
       RETURNING id`,
      [orgId, pkgCode]
    );
    orgPkgId = orgCat.rows[0].id;
    cleanup.catalogIds.push(orgPkgId);

    const b1Cat = await adminPool.query(
      `INSERT INTO service_catalog (org_id, building_id, code, name, category, billing_type, unit, unit_price, is_active)
       VALUES ($1, $2, $3, 'Gửi xe máy tòa B1', 'PARKING', 'QUANTITY', 'xe', 200000, TRUE)
       RETURNING id`,
      [orgId, b1Id, pkgCode]
    );
    cleanup.catalogIds.push(b1Cat.rows[0].id);

    // Building B1 ELECTRICITY catalog override = 4.100 ₫/kWh
    const b1ElecCat = await adminPool.query(
      `INSERT INTO service_catalog (org_id, building_id, code, name, category, billing_type, unit, unit_price, is_active)
       VALUES ($1, $2, 'ELECTRICITY', 'Điện sinh hoạt B1', 'ELECTRICITY', 'METERED', 'kWh', 4100, TRUE)
       RETURNING id`,
      [orgId, b1Id]
    );
    cleanup.catalogIds.push(b1ElecCat.rows[0].id);

    // Unlocked subscription on C1 referencing org catalog (initial unit_price = 150000, is_price_locked = false)
    const subIns = await adminPool.query(
      `INSERT INTO service_subscription (
         org_id, building_id, apartment_id, contract_id, service_id,
         quantity, unit_price, is_price_locked, start_date, prorata_amount, status, vehicle_plates
       )
       VALUES ($1, $2, $3, $4, $5, 1, 150000, FALSE, '2026-01-01', 150000, 'ACTIVE', ARRAY['29A-11111'])
       RETURNING id`,
      [orgId, b1Id, u1.aptId, u1.contractId, orgPkgId]
    );
    cleanup.subscriptionIds.push(subIns.rows[0].id);

    // Meter on A1 (meter.unit_price = 3800, but B1 catalog ELECTRICITY = 4100) + CONFIRMED reading in 2028-05 (500 -> 600 = 100 kWh)
    const mRes = await apiFetch('/api/v1/meters', mgrB1.token, {
      method: 'POST',
      body: JSON.stringify({
        apartment_id: u1.aptId,
        meter_type: 'ELECTRICITY',
        unit_price: 3800,
        initial_reading: 500,
      }),
    });
    assert.equal(mRes.status, 201, JSON.stringify(mRes.body));
    u1ElMeterId = mRes.body.data.id;
    cleanup.meterIds.push(u1ElMeterId);

    const readRes = await apiFetch(`/api/v1/meters/${u1ElMeterId}/readings`, mgrB1.token, {
      method: 'POST',
      body: JSON.stringify({ period: '2028-05', current_reading: 600 }),
    });
    assert.equal(readRes.status, 201);
    u1MayReadingId = readRes.body.data.id;

    // Verify GET /api/v1/contracts/:id expected invoice_schedule reflects BUILDING_CATALOG (200.000 ₫)
    const ctrDetail = await apiFetch(`/api/v1/contracts/${u1.contractId}`, mgrB1.token);
    assert.equal(ctrDetail.status, 200);
    const maySched = ctrDetail.body.data.invoice_schedule.find((s) => s.billing_period === '2028-05');
    assert.ok(maySched, 'Expected 2028-05 slice in invoice_schedule');
    assert.equal(
      Number(maySched.expected_fixed_services ?? maySched.expectedFixedServices ?? maySched.service_amount),
      200000,
      `Expected invoice_schedule to reflect BUILDING_CATALOG 200000, got ${JSON.stringify(maySched)}`
    );

    // Generate batch for B1 in 2028-05
    const gen1 = await apiFetch('/api/v1/invoices/generate-batch', mgrB1.token, {
      method: 'POST',
      body: JSON.stringify({ building_id: b1Id, period: '2028-05', auto_issue: false }),
    });
    assert.equal(gen1.status, 201, JSON.stringify(gen1.body));
    const c1Inv = gen1.body.data.find((i) => i.contract_id === u1.contractId);
    assert.ok(c1Inv, 'Invoice for C1 should be generated');
    assert.equal(c1Inv.status, 'DRAFT');

    const det1 = await apiFetch(`/api/v1/invoices/${c1Inv.id}`, mgrB1.token);
    assert.equal(det1.status, 200);
    const svcLine1 = det1.body.data.lines.find((l) => l.item_type === 'SERVICE');
    const elLine1 = det1.body.data.lines.find((l) => l.item_type === 'ELECTRICITY');
    assert.equal(Number(svcLine1.unit_price), 200000);
    assert.equal(Number(svcLine1.amount), 200000);
    assert.equal(svcLine1.formula_meta.price_source, 'BUILDING_CATALOG');

    assert.equal(Number(elLine1.unit_price), 4100, 'Utility should pick BUILDING_CATALOG 4100 over meter.unit_price 3800');
    assert.equal(Number(elLine1.amount), 410000);
    assert.equal(elLine1.formula_meta.meter_id, u1ElMeterId);
    assert.equal(elLine1.formula_meta.reading_id, u1MayReadingId);
    assert.equal(elLine1.formula_meta.previous_reading, 500);
    assert.equal(elLine1.formula_meta.current_reading, 600);
    assert.equal(elLine1.formula_meta.consumption, 100);
    assert.equal(elLine1.formula_meta.price_source, 'BUILDING_CATALOG');

    // Add contract_service_price overrides (PARKING_MOTO = 120000, ELEC alias = 4500) and refresh DRAFT
    await adminPool.query(
      `INSERT INTO contract_service_price (contract_id, service_code, unit_price, effective_from)
       VALUES ($1, $2, 120000, '2028-05-01'), ($1, 'ELEC', 4500, '2028-05-10')`,
      [u1.contractId, pkgCode]
    );

    const gen2 = await apiFetch('/api/v1/invoices/generate-batch', mgrB1.token, {
      method: 'POST',
      body: JSON.stringify({ building_id: b1Id, contract_id: u1.contractId, period: '2028-05', auto_issue: false }),
    });
    assert.equal(gen2.status, 201);
    assert.ok(gen2.body.updated_draft_count >= 1);

    const det2 = await apiFetch(`/api/v1/invoices/${c1Inv.id}`, mgrB1.token);
    const svcLine2 = det2.body.data.lines.find((l) => l.item_type === 'SERVICE');
    const elLine2 = det2.body.data.lines.find((l) => l.item_type === 'ELECTRICITY');
    assert.equal(Number(svcLine2.unit_price), 120000);
    assert.equal(Number(svcLine2.amount), 120000);
    assert.equal(svcLine2.formula_meta.price_source, 'CONTRACT_OVERRIDE');
    assert.equal(Number(elLine2.unit_price), 4500);
    assert.equal(Number(elLine2.amount), 450000);
    assert.equal(elLine2.formula_meta.price_source, 'CONTRACT_OVERRIDE');
  });

  await t.test('2. AC-015.1 Missing / Unconfirmed Active Meter Gate & AC-003.2 Resident Draft Hiding', async () => {
    // Confirm C1 2028-06 reading so C1 is ready
    const p6C1 = await apiFetch(`/api/v1/meters/${u1ElMeterId}/readings`, mgrB1.token, {
      method: 'POST',
      body: JSON.stringify({ period: '2028-06', current_reading: 650 }),
    });
    assert.equal(p6C1.status, 201);

    // Create ACTIVE ELECTRICITY meter on A2 (C2), NO reading in 2028-06 yet
    const m2Res = await apiFetch('/api/v1/meters', mgrB1.token, {
      method: 'POST',
      body: JSON.stringify({
        apartment_id: u2.aptId,
        meter_type: 'ELECTRICITY',
        unit_price: 3800,
        initial_reading: 200,
      }),
    });
    assert.equal(m2Res.status, 201);
    const u2ElMeterId = m2Res.body.data.id;
    cleanup.meterIds.push(u2ElMeterId);

    // Case 2a: No reading in 2028-06 -> C2 skipped with MISSING_CONFIRMED_METER_READING, C1 generated!
    const gen2a = await apiFetch('/api/v1/invoices/generate-batch', mgrB1.token, {
      method: 'POST',
      body: JSON.stringify({ building_id: b1Id, period: '2028-06', auto_issue: false }),
    });
    assert.equal(gen2a.status, 201, JSON.stringify(gen2a.body));
    assert.ok(gen2a.body.data.some((i) => i.contract_id === u1.contractId), 'Sibling C1 with confirmed meter must be billed');
    assert.ok(!gen2a.body.data.some((i) => i.contract_id === u2.contractId), 'C2 without reading must NOT be billed');
    const skip2a = gen2a.body.skipped_contracts.find((s) => s.contract_id === u2.contractId);
    assert.ok(skip2a, `Expected C2 in skipped_contracts, got ${JSON.stringify(gen2a.body.skipped_contracts)}`);
    assert.equal(skip2a.reason_code, 'MISSING_CONFIRMED_METER_READING');
    assert.deepEqual(skip2a.missing_meter_types, ['ELECTRICITY']);

    // Case 2b: Record DRAFT reading on A2 in 2028-06 -> STILL skipped!
    const draftRead = await apiFetch(`/api/v1/meters/${u2ElMeterId}/readings`, mgrB1.token, {
      method: 'POST',
      body: JSON.stringify({ period: '2028-06', current_reading: 280, status: 'DRAFT' }),
    });
    assert.equal(draftRead.status, 201);
    assert.equal(draftRead.body.data.status, 'DRAFT');
    const draftReadingId = draftRead.body.data.id;

    const gen2b = await apiFetch('/api/v1/invoices/generate-batch', mgrB1.token, {
      method: 'POST',
      body: JSON.stringify({ building_id: b1Id, period: '2028-06', auto_issue: false }),
    });
    assert.equal(gen2b.status, 201);
    assert.ok(!gen2b.body.data.some((i) => i.contract_id === u2.contractId));
    const skip2b = gen2b.body.skipped_contracts.find((s) => s.contract_id === u2.contractId);
    assert.ok(skip2b);
    assert.equal(skip2b.reason_code, 'MISSING_CONFIRMED_METER_READING');

    // Case 2c: Confirm A2 reading -> generates DRAFT invoice with RENT + ELECTRICITY; resident sees 0 drafts (AC-003.2)
    const confRes = await apiFetch(`/api/v1/meters/readings/${draftReadingId}/confirm`, mgrB1.token, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    assert.equal(confRes.status, 200);

    const gen2c = await apiFetch('/api/v1/invoices/generate-batch', mgrB1.token, {
      method: 'POST',
      body: JSON.stringify({ building_id: b1Id, period: '2028-06', auto_issue: false }),
    });
    assert.equal(gen2c.status, 201);
    const c2Inv = gen2c.body.data.find((i) => i.contract_id === u2.contractId);
    assert.ok(c2Inv, 'C2 DRAFT invoice must be created once meter reading is CONFIRMED');
    assert.equal(c2Inv.status, 'DRAFT');

    const det2c = await apiFetch(`/api/v1/invoices/${c2Inv.id}`, mgrB1.token);
    const c2Rent = det2c.body.data.lines.find((l) => l.item_type === 'RENT');
    const c2Elec = det2c.body.data.lines.find((l) => l.item_type === 'ELECTRICITY');
    assert.equal(Number(c2Rent.amount), 7000000);
    assert.equal(Number(c2Elec.amount), 80 * 4100);

    const resInvList = await apiFetch('/api/v1/resident/invoices', u2.resAuth.token);
    assert.equal(resInvList.status, 200);
    assert.equal(resInvList.body.data.length, 0, 'AC-003.2: Resident must not see DRAFT invoices');
  });

  await t.test('3. Vietnam Timezone Subscription Pro-Rata (services.js & resident.js) & AC-015.2 Idempotency', async () => {
    const wifiCat = await adminPool.query(
      `INSERT INTO service_catalog (org_id, building_id, code, name, category, billing_type, unit, unit_price, is_active)
       VALUES ($1, $2, $3, 'Internet tốc độ cao', 'INTERNET', 'FIXED', 'tháng', 300000, TRUE)
       RETURNING id, code, category, unit_price`,
      [orgId, b1Id, `WIFI_M09_${suffix}`]
    );
    const wifiId = wifiCat.rows[0].id;
    cleanup.catalogIds.push(wifiId);

    // Mid-month subscription on 2028-04-16 (15/30 days = 150.000 ₫) via Resident & Manager
    const resSub = await apiFetch('/api/v1/resident/services', u2.resAuth.token, {
      method: 'POST',
      body: JSON.stringify({
        contract_id: u2.contractId,
        service_id: wifiId,
        quantity: 1,
        start_date: '2028-04-16',
      }),
    });
    assert.equal(resSub.status, 201, JSON.stringify(resSub.body));
    cleanup.subscriptionIds.push(resSub.body.data.id);

    const expectedResCharge = computeSubscriptionPeriodCharge({
      subscription: {
        ...resSub.body.data,
        service_code: wifiCat.rows[0].code,
        service_category: 'INTERNET',
        status: 'ACTIVE',
      },
      periodYm: '2028-04',
      contractBuildingId: b1Id,
      catalogItems: [wifiCat.rows[0]],
    });
    assert.equal(Number(resSub.body.data.prorata_amount), expectedResCharge.amount);
    assert.equal(Number(resSub.body.data.prorata_amount), 150000);

    const mgrSub = await apiFetch('/api/v1/service-subscriptions', mgrB1.token, {
      method: 'POST',
      body: JSON.stringify({
        contract_id: u1.contractId,
        service_id: wifiId,
        quantity: 1,
        start_date: '2028-04-11',
      }),
    });
    assert.equal(mgrSub.status, 201, JSON.stringify(mgrSub.body));
    cleanup.subscriptionIds.push(mgrSub.body.data.id);
    assert.equal(Number(mgrSub.body.data.prorata_amount), 200000); // 20/30 days * 300.000 = 200.000

    // Terminate mgrSub on 2028-04-20 (11..20 inclusive = 10/30 days = 100.000 ₫, NOT 20/30!)
    const termSub = await apiFetch(`/api/v1/service-subscriptions/${mgrSub.body.data.id}`, mgrB1.token, {
      method: 'PATCH',
      body: JSON.stringify({
        status: 'TERMINATED',
        end_date: '2028-04-20',
      }),
    });
    assert.equal(termSub.status, 200, JSON.stringify(termSub.body));
    assert.equal(
      Number(termSub.body.data.prorata_amount),
      100000,
      'Terminating 2028-04-11..2028-04-20 (10/30 days) must match computeSubscriptionPeriodCharge = 100.000 ₫'
    );

    // AC-015.2 Idempotency: re-running generate-batch for 2028-06 after issuing invoices creates 0 duplicates
    const beforeCnt = await adminPool.query(
      `SELECT COUNT(*)::int AS cnt FROM invoice WHERE building_id = $1 AND period = '2028-06'`,
      [b1Id]
    );
    const rerun = await apiFetch('/api/v1/invoices/generate-batch', mgrB1.token, {
      method: 'POST',
      body: JSON.stringify({ building_id: b1Id, period: '2028-06', auto_issue: false }),
    });
    assert.equal(rerun.status, 201);
    const afterCnt = await adminPool.query(
      `SELECT COUNT(*)::int AS cnt FROM invoice WHERE building_id = $1 AND period = '2028-06'`,
      [b1Id]
    );
    assert.equal(afterCnt.rows[0].cnt, beforeCnt.rows[0].cnt, 'AC-015.2: Must not create duplicate invoices');
  });
});
