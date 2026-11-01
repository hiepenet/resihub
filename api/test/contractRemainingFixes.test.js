import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';

dotenv.config({ path: fileURLToPath(new URL('../.env', import.meta.url)) });
dotenv.config();
if (!process.env.APP_DATABASE_URL) {
  process.env.APP_DATABASE_URL =
    'postgres://resihub_app:resihub_app_secret@127.0.0.1:5433/resihub';
}

const TINY_PNG_B64 =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

test('M05 Contract Creation Remaining 4-Item Suite', async (t) => {
  const { adminPool, appPool } = await import('../src/db/client.js');
  const { default: authRoute } = await import('../src/routes/auth.js');
  const { default: contractsRoute } = await import('../src/routes/contracts.js');
  const { default: tenantsRoute } = await import('../src/routes/tenants.js');
  const { default: attachmentsRoute } = await import('../src/routes/attachments.js');

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
  app.use('/api/v1/tenants', tenantsRoute);
  app.use('/api/v1/attachments', attachmentsRoute);

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const API_BASE = `http://127.0.0.1:${addr.port}`;

  const createdContractIds = [];
  const createdApartmentIds = [];
  const createdPersonIds = [];

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
    const text = await res.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = { raw: text };
    }
    return { status: res.status, body, headers: res.headers, rawText: text };
  }

  t.after(async () => {
    try {
      await new Promise((resolve) => server.close(() => resolve()));
      for (const cId of createdContractIds) {
        await adminPool.query(
          'DELETE FROM invoice_line WHERE invoice_id IN (SELECT id FROM invoice WHERE contract_id = $1)',
          [cId]
        );
        await adminPool.query('DELETE FROM receivable WHERE contract_id = $1', [cId]).catch(() => {});
        await adminPool.query('DELETE FROM invoice WHERE contract_id = $1', [cId]);
        const cleanClient = await adminPool.connect();
        try {
          await cleanClient.query('BEGIN');
          await cleanClient.query("SET LOCAL app.allow_test_cleanup = 'true'");
          await cleanClient.query(
            'DELETE FROM deposit_transaction WHERE deposit_id IN (SELECT id FROM deposit WHERE contract_id = $1)',
            [cId]
          );
          await cleanClient.query('DELETE FROM deposit WHERE contract_id = $1', [cId]);
          await cleanClient.query('COMMIT');
        } catch {
          await cleanClient.query('ROLLBACK').catch(() => {});
        } finally {
          cleanClient.release();
        }
        await adminPool.query('DELETE FROM service_subscription WHERE contract_id = $1', [cId]).catch(() => {});
        await adminPool.query("DELETE FROM notification WHERE payload->>'contract_id' = $1", [cId]).catch(() => {});
        await adminPool.query('DELETE FROM attachment WHERE owner_entity = $1 AND owner_id = $2', ['contract', cId]);
        await adminPool.query('DELETE FROM contract_version WHERE contract_id = $1', [cId]);
        await adminPool.query('DELETE FROM contract_request WHERE contract_id = $1', [cId]);
        await adminPool.query('DELETE FROM contract_service_price WHERE contract_id = $1', [cId]).catch(() => {});
        await adminPool.query('DELETE FROM contract_occupant WHERE contract_id = $1', [cId]).catch(() => {});
        await adminPool.query('DELETE FROM contract WHERE id = $1', [cId]);
      }
      for (const aptId of createdApartmentIds) {
        await adminPool.query('DELETE FROM meter WHERE apartment_id = $1', [aptId]).catch(() => {});
        await adminPool.query('DELETE FROM reservation WHERE apartment_id = $1', [aptId]).catch(() => {});
        await adminPool.query('DELETE FROM apartment WHERE id = $1', [aptId]);
      }
      for (const pId of createdPersonIds) {
        await adminPool.query('DELETE FROM attachment WHERE owner_entity = $1 AND owner_id = $2', ['person', pId]).catch(() => {});
        await adminPool.query('DELETE FROM notification WHERE user_id IN (SELECT id FROM app_user WHERE person_id = $1)', [pId]).catch(() => {});
        await adminPool.query('DELETE FROM user_role WHERE user_id IN (SELECT id FROM app_user WHERE person_id = $1)', [pId]).catch(() => {});
        await adminPool.query('DELETE FROM app_user WHERE person_id = $1', [pId]).catch(() => {});
        await adminPool.query('DELETE FROM tenant WHERE person_id = $1', [pId]).catch(() => {});
        await adminPool.query('DELETE FROM person WHERE id = $1', [pId]).catch(() => {});
      }
    } finally {
      await adminPool.end();
      await appPool.end();
    }
  });

  const [mgrVopA, ownerVop] = await Promise.all([
    login('manager.vop.a@resihub.vn', 'Demo@123456'),
    login('owner.vop@resihub.vn', 'Demo@123456'),
  ]);

  const vopARes = await adminPool.query(`SELECT id, org_id FROM building WHERE code = 'VOP-A' LIMIT 1`);
  const vopAId = vopARes.rows[0].id;
  const orgId = vopARes.rows[0].org_id;
  const floorRes = await adminPool.query(`SELECT id FROM floor WHERE building_id = $1 LIMIT 1`, [vopAId]);
  const floorId = floorRes.rows[0].id;

  const catalogRes = await adminPool.query(
    `SELECT id, code, unit_price FROM service_catalog WHERE org_id = $1 AND code IN ('MOTORBIKE_PARKING', 'INTERNET_FIBER')`,
    [orgId]
  );
  const parkingCat = catalogRes.rows.find((r) => r.code === 'MOTORBIKE_PARKING');
  const internetCat = catalogRes.rows.find((r) => r.code === 'INTERNET_FIBER');
  assert.ok(parkingCat && internetCat, 'Expected MOTORBIKE_PARKING and INTERNET_FIBER in service_catalog');

  async function createTestApartment(suffix, baseRent = 10000000) {
    const code = `RF-${suffix}-${Date.now().toString().slice(-5)}-${Math.floor(Math.random() * 90 + 10)}`;
    const ins = await adminPool.query(
      `INSERT INTO apartment (building_id, floor_id, code, area_m2, bedrooms, base_rent, status)
       VALUES ($1, $2, $3, 65, 2, $4, 'AVAILABLE') RETURNING *`,
      [vopAId, floorId, code, baseRent]
    );
    createdApartmentIds.push(ins.rows[0].id);
    return ins.rows[0];
  }

  function makeUniqueTenant(tag) {
    const rand = String(Math.floor(10000000 + Math.random() * 89999999));
    return {
      full_name: `Cư Dân RF ${tag}`,
      phone: `09${rand}`,
      id_number: `0791${rand}`,
      email: `rf.${tag.toLowerCase()}.${rand}@resihub.vn`,
    };
  }

  async function trackTenantPersonByTenantId(tenantId) {
    if (!tenantId) return;
    const tRes = await adminPool.query('SELECT person_id FROM tenant WHERE id = $1', [tenantId]);
    if (tRes.rows[0]?.person_id) {
      createdPersonIds.push(tRes.rows[0].person_id);
    }
  }

  await t.test('Task 1 & Task 2: A4 template service rows/XSS escape & DRAFT PATCH service subscriptions, vehicle notes, and meter overrides under RLS', async () => {
    const apt = await createTestApartment('T2');
    await adminPool.query(
      `INSERT INTO meter (org_id, building_id, apartment_id, meter_type, meter_code, unit, unit_price, status)
       VALUES ($1, $2, $3, 'ELECTRICITY', $4, 'kWh', 3800, 'ACTIVE'),
              ($1, $2, $3, 'WATER', $5, 'm³', 22000, 'ACTIVE')`,
      [orgId, vopAId, apt.id, `EL-${apt.code}`, `WT-${apt.code}`]
    );

    const newTenant = makeUniqueTenant('T2');
    const createRes = await apiFetch('/api/v1/contracts', mgrVopA.token, {
      method: 'POST',
      body: JSON.stringify({
        apartment_id: apt.id,
        new_tenant: newTenant,
        start_date: '2026-12-01',
        end_date: '2027-12-01',
        rent_amount: 10000000,
        deposit_amount: 10000000,
        services: [
          {
            service_id: parkingCat.id,
            quantity: 2,
            note: '59A1-123.45 <script>alert(1)</script>',
          },
          {
            service_id: internetCat.id,
            quantity: 1,
            custom_unit_price: 180000,
            note: 'Gói ưu đãi 12T',
          },
        ],
        service_prices: [
          { service_code: 'ELECTRICITY', unit_price: 3600 },
        ],
      }),
    });

    assert.equal(createRes.status, 201, JSON.stringify(createRes.body));
    const contractId = createRes.body.data.id;
    createdContractIds.push(contractId);
    await trackTenantPersonByTenantId(createRes.body.data.primary_tenant_id);

    // Verify A4 printable HTML template (Task 1 + Review Focus #1 & #2)
    const tplRes = await apiFetch(`/api/v1/contracts/${contractId}/template`, mgrVopA.token);
    assert.equal(tplRes.status, 200);
    assert.match(tplRes.rawText, /59A1-123\.45/);
    assert.match(tplRes.rawText, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.ok(!tplRes.rawText.includes('<script>alert(1)</script>'), 'XSS script tag must be escaped');
    assert.match(tplRes.rawText, /2 xe\/tháng/);
    assert.match(tplRes.rawText, /240\.000/);
    assert.match(tplRes.rawText, /180\.000/);
    assert.match(tplRes.rawText, /3\.600/);

    // Verify note > 500 chars validation on PATCH
    const tooLongRes = await apiFetch(`/api/v1/contracts/${contractId}`, mgrVopA.token, {
      method: 'PATCH',
      body: JSON.stringify({
        services: [
          {
            service_id: parkingCat.id,
            quantity: 1,
            note: 'X'.repeat(501),
          },
        ],
      }),
    });
    assert.equal(tooLongRes.status, 422);
    assert.equal(tooLongRes.body.code, 'INVALID_SERVICE_NOTE');

    // Now MANAGER edits DRAFT services via PATCH: remove INTERNET_FIBER, update MOTORBIKE_PARKING qty=1 + note, and clear ELECTRICITY override (Review Focus #3)
    const patchRes = await apiFetch(`/api/v1/contracts/${contractId}`, mgrVopA.token, {
      method: 'PATCH',
      body: JSON.stringify({
        services: [
          {
            service_id: parkingCat.id,
            quantity: 1,
            note: '59X3-999.99',
          },
        ],
        service_prices: [
          { service_code: 'ELECTRICITY', unit_price: null },
        ],
      }),
    });

    assert.equal(patchRes.status, 200, JSON.stringify(patchRes.body));
    assert.ok(Array.isArray(patchRes.body.service_subscriptions), 'PATCH should return updated service_subscriptions');
    assert.equal(patchRes.body.service_subscriptions.length, 1);
    assert.equal(patchRes.body.service_subscriptions[0].service_code, 'MOTORBIKE_PARKING');
    assert.equal(Number(patchRes.body.service_subscriptions[0].quantity), 1);
    assert.equal(patchRes.body.service_subscriptions[0].note, '59X3-999.99');

    const expectedParkingPrice = Number(parkingCat.unit_price);
    assert.ok(Array.isArray(patchRes.body.invoice_schedule) && patchRes.body.invoice_schedule.length > 0);
    assert.equal(Number(patchRes.body.invoice_schedule[0].expected_fixed_services), expectedParkingPrice);

    const dbSubs = await adminPool.query(
      `SELECT ss.quantity, ss.note, sc.code
       FROM service_subscription ss
       JOIN service_catalog sc ON sc.id = ss.service_id
       WHERE ss.contract_id = $1`,
      [contractId]
    );
    assert.equal(dbSubs.rows.length, 1);
    assert.equal(dbSubs.rows[0].code, 'MOTORBIKE_PARKING');
    assert.equal(Number(dbSubs.rows[0].quantity), 1);
    assert.equal(dbSubs.rows[0].note, '59X3-999.99');

    const dbCsp = await adminPool.query(
      'SELECT service_code, unit_price FROM contract_service_price WHERE contract_id = $1',
      [contractId]
    );
    assert.equal(dbCsp.rows.length, 0, `Expected all overrides cleared, got: ${JSON.stringify(dbCsp.rows)}`);
  });
});
