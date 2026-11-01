import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { rm, rmdir } from 'node:fs/promises';
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

test('Parking Vehicle Plates & Optional Service Notes — Full API Sync Suite', async (t) => {
  const { adminPool, appPool } = await import('../src/db/client.js');
  const { default: authRoute } = await import('../src/routes/auth.js');
  const { default: contractsRoute } = await import('../src/routes/contracts.js');
  const { default: residentRoute } = await import('../src/routes/resident.js');
  const {
    default: servicesRoute,
    serviceCatalogRouter,
    serviceSubscriptionsRouter,
  } = await import('../src/routes/services.js');

  const app = express();
  app.use(
    cors({
      origin: '*',
      methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key'],
    })
  );
  app.use(express.json({ limit: '20mb' }));
  app.use('/api/v1/auth', authRoute);
  app.use('/api/v1/contracts', contractsRoute);
  app.use('/api/v1/resident', residentRoute);
  app.use('/api/v1/services', servicesRoute);
  app.use('/api/v1/service-catalog', serviceCatalogRouter);
  app.use('/api/v1/service-subscriptions', serviceSubscriptionsRouter);

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const API_BASE = `http://127.0.0.1:${addr.port}`;

  const createdContractIds = [];
  const createdApartmentIds = [];
  const createdPersonIds = [];
  const createdSubscriptionIds = [];
  const createdCatalogIds = [];

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

  async function apiFetch(urlPath, token, options = {}) {
    const res = await fetch(`${API_BASE}${urlPath}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(options.headers || {}),
      },
    });
    const rawText = await res.text();
    let body = null;
    try {
      body = JSON.parse(rawText);
    } catch {
      body = { raw: rawText };
    }
    return { status: res.status, body, rawText };
  }

  t.after(async () => {
    try {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(() => resolve()));

      for (const subId of createdSubscriptionIds) {
        await adminPool
          .query(`DELETE FROM notification WHERE payload->>'subscription_id' = $1`, [subId])
          .catch(() => {});
        await adminPool.query('DELETE FROM service_subscription WHERE id = $1', [subId]).catch(() => {});
      }

      for (const cId of createdContractIds) {
        await adminPool
          .query('DELETE FROM invoice_line WHERE invoice_id IN (SELECT id FROM invoice WHERE contract_id = $1)', [cId])
          .catch(() => {});
        await adminPool.query('DELETE FROM receivable WHERE contract_id = $1', [cId]).catch(() => {});
        await adminPool.query('DELETE FROM invoice WHERE contract_id = $1', [cId]).catch(() => {});

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
        await rm(path.join(process.cwd(), 'uploads', 'contract', cId), { recursive: true, force: true }).catch(() => {});
        await adminPool.query('DELETE FROM attachment WHERE owner_entity = $1 AND owner_id = $2', ['contract', cId]);
        await adminPool.query('DELETE FROM contract_version WHERE contract_id = $1', [cId]);
        await adminPool.query('DELETE FROM contract_request WHERE contract_id = $1', [cId]);
        await adminPool.query('DELETE FROM contract_service_price WHERE contract_id = $1', [cId]).catch(() => {});
        await adminPool.query('DELETE FROM contract_occupant WHERE contract_id = $1', [cId]).catch(() => {});
        await adminPool.query('DELETE FROM contract WHERE id = $1', [cId]);
      }

      for (const catId of createdCatalogIds) {
        await adminPool.query('DELETE FROM service_catalog WHERE id = $1', [catId]).catch(() => {});
      }

      for (const aptId of createdApartmentIds) {
        await adminPool.query('DELETE FROM service_subscription WHERE apartment_id = $1', [aptId]).catch(() => {});
        await adminPool.query('DELETE FROM meter WHERE apartment_id = $1', [aptId]).catch(() => {});
        await adminPool.query('DELETE FROM reservation WHERE apartment_id = $1', [aptId]).catch(() => {});
        await adminPool.query('DELETE FROM apartment WHERE id = $1', [aptId]);
      }

      for (const pId of createdPersonIds) {
        await rm(path.join(process.cwd(), 'uploads', 'person', pId), { recursive: true, force: true }).catch(() => {});
        await adminPool.query('DELETE FROM attachment WHERE owner_entity = $1 AND owner_id = $2', ['person', pId]).catch(() => {});
        await adminPool.query('DELETE FROM notification WHERE user_id IN (SELECT id FROM app_user WHERE person_id = $1)', [pId]).catch(() => {});
        await adminPool.query('DELETE FROM user_role WHERE user_id IN (SELECT id FROM app_user WHERE person_id = $1)', [pId]).catch(() => {});
        await adminPool.query('DELETE FROM app_user WHERE person_id = $1', [pId]).catch(() => {});
        await adminPool.query('DELETE FROM tenant WHERE person_id = $1', [pId]).catch(() => {});
        await adminPool.query('DELETE FROM person WHERE id = $1', [pId]).catch(() => {});
      }

      await rmdir(path.join(process.cwd(), 'uploads', 'contract')).catch(() => {});
      await rmdir(path.join(process.cwd(), 'uploads', 'person')).catch(() => {});
      await rmdir(path.join(process.cwd(), 'uploads')).catch(() => {});
    } finally {
      await adminPool.end();
      await appPool.end();
    }
  });

  const mgrVopA = await login('manager.vop.a@resihub.vn', 'Demo@123456');

  const vopARes = await adminPool.query(`SELECT id, org_id FROM building WHERE code = 'VOP-A' LIMIT 1`);
  const vopAId = vopARes.rows[0].id;
  const orgId = vopARes.rows[0].org_id;
  const floorRes = await adminPool.query(`SELECT id FROM floor WHERE building_id = $1 LIMIT 1`, [vopAId]);
  const floorId = floorRes.rows[0].id;

  const catalogRes = await adminPool.query(
    `SELECT id, code, category, billing_type, unit_price
     FROM service_catalog
     WHERE org_id = $1 AND is_active = TRUE`,
    [orgId]
  );
  const motorbikeCat = catalogRes.rows.find((r) => r.code === 'MOTORBIKE_PARKING');
  const internetCat = catalogRes.rows.find((r) => r.code === 'INTERNET_FIBER');
  assert.ok(motorbikeCat && internetCat, 'Expected MOTORBIKE_PARKING and INTERNET_FIBER in service_catalog');

  let carParkingCat = catalogRes.rows.find((r) => r.code === 'CAR_PARKING' && r.category === 'PARKING');
  if (!carParkingCat) {
    const insCar = await adminPool.query(
      `INSERT INTO service_catalog (org_id, code, name, category, billing_type, unit, unit_price, is_active)
       VALUES ($1, $2, 'Đỗ xe ô tô hầm', 'PARKING', 'QUANTITY', 'xe/tháng', 1500000, TRUE)
       RETURNING *`,
      [orgId, `CAR_PARKING_TEST_${Date.now().toString().slice(-5)}`]
    );
    carParkingCat = insCar.rows[0];
    createdCatalogIds.push(carParkingCat.id);
  }

  let cleaningQtyCat = catalogRes.rows.find((r) => r.category === 'CLEANING' && r.billing_type === 'QUANTITY');
  if (!cleaningQtyCat) {
    const insClean = await adminPool.query(
      `INSERT INTO service_catalog (org_id, code, name, category, billing_type, unit, unit_price, is_active)
       VALUES ($1, $2, 'Dọn vệ sinh theo buổi', 'CLEANING', 'QUANTITY', 'buổi/tháng', 80000, TRUE)
       RETURNING *`,
      [orgId, `CLEANING_QTY_${Date.now().toString().slice(-5)}`]
    );
    cleaningQtyCat = insClean.rows[0];
    createdCatalogIds.push(cleaningQtyCat.id);
  }

  async function createTestApartment(suffix, baseRent = 10000000) {
    const code = `PK-${suffix}-${Date.now().toString().slice(-5)}-${Math.floor(Math.random() * 90 + 10)}`;
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
      full_name: `Cư Dân PK ${tag}`,
      phone: `09${rand}`,
      id_number: `0792${rand}`,
      email: `pk.${tag.toLowerCase()}.${rand}@resihub.vn`,
    };
  }

  async function trackTenantPersonByTenantId(tenantId) {
    if (!tenantId) return;
    const tRes = await adminPool.query('SELECT person_id FROM tenant WHERE id = $1', [tenantId]);
    if (tRes.rows[0]?.person_id) {
      createdPersonIds.push(tRes.rows[0].person_id);
    }
  }

  await t.test('1-3. Draft Contract Create, A4 Template XSS Escaping, Non-Parking Quantity Cleanup & Draft PATCH', async () => {
    const apt = await createTestApartment('DRAFT');
    const tenant = makeUniqueTenant('DRAFT');

    // Scenario 1a: Missing vehicle_plates on PARKING -> 422 VEHICLE_PLATES_REQUIRED
    const missingRes = await apiFetch('/api/v1/contracts', mgrVopA.token, {
      method: 'POST',
      body: JSON.stringify({
        apartment_id: apt.id,
        new_tenant: tenant,
        start_date: '2026-12-01',
        end_date: '2027-12-01',
        rent_amount: 10000000,
        deposit_amount: 10000000,
        services: [{ service_id: motorbikeCat.id, quantity: 2, note: 'Chưa điền biển số' }],
      }),
    });
    if (missingRes.body?.data?.id) {
      createdContractIds.push(missingRes.body.data.id);
      await trackTenantPersonByTenantId(missingRes.body.data.primary_tenant_id);
    }
    assert.equal(missingRes.status, 422);
    assert.equal(missingRes.body.code, 'VEHICLE_PLATES_REQUIRED');

    // Scenario 1b: Mismatched plate count (1 plate for quantity=2) -> 422 INVALID_VEHICLE_PLATES
    const mismatchRes = await apiFetch('/api/v1/contracts', mgrVopA.token, {
      method: 'POST',
      body: JSON.stringify({
        apartment_id: apt.id,
        new_tenant: tenant,
        start_date: '2026-12-01',
        end_date: '2027-12-01',
        rent_amount: 10000000,
        deposit_amount: 10000000,
        services: [
          {
            service_id: motorbikeCat.id,
            quantity: 2,
            vehicle_plates: ['59A1-123.45'],
          },
        ],
      }),
    });
    if (mismatchRes.body?.data?.id) {
      createdContractIds.push(mismatchRes.body.data.id);
      await trackTenantPersonByTenantId(mismatchRes.body.data.primary_tenant_id);
    }
    assert.equal(mismatchRes.status, 422);
    assert.equal(mismatchRes.body.code, 'INVALID_VEHICLE_PLATES');

    // Scenario 2: Valid PARKING (2 plates, including XSS payload + separate note) + INTERNET_FIBER + CLEANING (quantity=12, stray vehicle_plates)
    const createRes = await apiFetch('/api/v1/contracts', mgrVopA.token, {
      method: 'POST',
      body: JSON.stringify({
        apartment_id: apt.id,
        new_tenant: tenant,
        start_date: '2026-12-01',
        end_date: '2027-12-01',
        rent_amount: 10000000,
        deposit_amount: 10000000,
        services: [
          {
            service_id: motorbikeCat.id,
            quantity: 2,
            vehicle_plates: [' 59A1-123.45 ', '59B2-<img src=x onerror=y()>'],
            note: 'Thẻ từ #01, #02',
          },
          {
            service_id: internetCat.id,
            quantity: 1,
            note: 'Gói 300M',
            vehicle_plates: ['IGNORE-ME'],
          },
          {
            service_id: cleaningQtyCat.id,
            quantity: 12,
            note: '3 buổi/tuần',
            vehicle_plates: ['30A-111.11'],
          },
        ],
      }),
    });
    assert.equal(createRes.status, 201, JSON.stringify(createRes.body));
    const contractId = createRes.body.data.id;
    createdContractIds.push(contractId);
    await trackTenantPersonByTenantId(createRes.body.data.primary_tenant_id);

    const createdSubs = createRes.body.created_services;
    const createdBike = createdSubs.find((s) => s.service_id === motorbikeCat.id);
    const createdNet = createdSubs.find((s) => s.service_id === internetCat.id);
    const createdCleaning = createdSubs.find((s) => s.service_id === cleaningQtyCat.id);

    assert.deepEqual(createdBike.vehicle_plates, ['59A1-123.45', '59B2-<img src=x onerror=y()>']);
    assert.equal(createdBike.note, 'Thẻ từ #01, #02');
    assert.deepEqual(createdNet.vehicle_plates, [], 'Non-parking FIXED must store empty vehicle_plates');
    assert.equal(createdNet.note, 'Gói 300M');
    assert.equal(Number(createdCleaning.quantity), 12, 'Non-parking QUANTITY must allow quantity > 10');
    assert.deepEqual(createdCleaning.vehicle_plates, [], 'Non-parking QUANTITY must strip stray vehicle_plates');

    // Verify A4 Printable HTML Template (Review Focus #2)
    const tplRes = await apiFetch(`/api/v1/contracts/${contractId}/template`, mgrVopA.token);
    assert.equal(tplRes.status, 200);
    assert.match(tplRes.rawText, /Biển số xe:/);
    assert.match(tplRes.rawText, /59A1-123\.45/);
    assert.match(tplRes.rawText, /&lt;img src=x onerror=y\(\)&gt;/);
    assert.ok(!tplRes.rawText.includes('<img src=x'), 'XSS img tag in vehicle_plates must be HTML-escaped');
    assert.match(tplRes.rawText, /Thẻ từ #01, #02/);
    assert.ok(!tplRes.rawText.includes('IGNORE-ME'));

    // Scenario 3: PATCH DRAFT contract changing MOTORBIKE_PARKING to quantity=1, non-motorized plate, empty note
    const patchRes = await apiFetch(`/api/v1/contracts/${contractId}`, mgrVopA.token, {
      method: 'PATCH',
      body: JSON.stringify({
        services: [
          {
            service_id: motorbikeCat.id,
            quantity: 1,
            vehicle_plates: ['Xe đạp điện #1'],
            note: '',
          },
        ],
      }),
    });
    assert.equal(patchRes.status, 200, JSON.stringify(patchRes.body));
    assert.equal(patchRes.body.service_subscriptions.length, 1);
    assert.deepEqual(patchRes.body.service_subscriptions[0].vehicle_plates, ['Xe đạp điện #1']);
    assert.equal(patchRes.body.service_subscriptions[0].note, null);
  });

  await t.test('4-6. Manager Standalone Subscription & Resident Subscribe + Cancel Preserves vehicle_plates', async () => {
    const apt = await createTestApartment('ACTIVE');
    const resTenant = { ...makeUniqueTenant('RES'), password: 'ResidentPassword@123' };

    // Create & activate contract so resident can log in and subscribe
    const createRes = await apiFetch('/api/v1/contracts', mgrVopA.token, {
      method: 'POST',
      body: JSON.stringify({
        apartment_id: apt.id,
        new_tenant: resTenant,
        start_date: '2026-10-01',
        end_date: '2027-10-01',
        rent_amount: 10000000,
        deposit_amount: 10000000,
      }),
    });
    assert.equal(createRes.status, 201, JSON.stringify(createRes.body));
    const contractId = createRes.body.data.id;
    createdContractIds.push(contractId);
    await trackTenantPersonByTenantId(createRes.body.data.primary_tenant_id);

    await apiFetch(`/api/v1/contracts/${contractId}/scan`, mgrVopA.token, {
      method: 'POST',
      body: JSON.stringify({ image_base64: TINY_PNG_B64 }),
    });
    const actRes = await apiFetch(`/api/v1/contracts/${contractId}/activate`, mgrVopA.token, {
      method: 'POST',
    });
    assert.equal(actRes.status, 200, JSON.stringify(actRes.body));

    // Scenario 4: Manager POST /api/v1/service-subscriptions for CAR_PARKING
    const mgrMissingRes = await apiFetch('/api/v1/service-subscriptions', mgrVopA.token, {
      method: 'POST',
      body: JSON.stringify({
        apartment_id: apt.id,
        service_id: carParkingCat.id,
        quantity: 1,
        note: 'Ô B2-09',
      }),
    });
    if (mgrMissingRes.body?.data?.id) createdSubscriptionIds.push(mgrMissingRes.body.data.id);
    assert.equal(mgrMissingRes.status, 422);
    assert.equal(mgrMissingRes.body.code, 'VEHICLE_PLATES_REQUIRED');

    const mgrOkRes = await apiFetch('/api/v1/service-subscriptions', mgrVopA.token, {
      method: 'POST',
      body: JSON.stringify({
        apartment_id: apt.id,
        service_id: carParkingCat.id,
        quantity: 1,
        vehicle_plates: [' 51K-888.88 '],
        note: 'Ô B2-09',
      }),
    });
    assert.equal(mgrOkRes.status, 201, JSON.stringify(mgrOkRes.body));
    createdSubscriptionIds.push(mgrOkRes.body.data.id);
    assert.deepEqual(mgrOkRes.body.data.vehicle_plates, ['51K-888.88']);
    assert.equal(mgrOkRes.body.data.note, 'Ô B2-09');

    // Review Fix (Important #3): PATCH /api/v1/service-subscriptions/:id must reject changing PARKING quantity out of sync with vehicle_plates or non-integer quantity
    const mgrBadQtySync = await apiFetch(
      `/api/v1/service-subscriptions/${mgrOkRes.body.data.id}`,
      mgrVopA.token,
      {
        method: 'PATCH',
        body: JSON.stringify({ quantity: 3 }),
      }
    );
    assert.equal(mgrBadQtySync.status, 422);
    assert.equal(mgrBadQtySync.body.code, 'INVALID_VEHICLE_PLATES');

    const mgrBadQtyNaN = await apiFetch(
      `/api/v1/service-subscriptions/${mgrOkRes.body.data.id}`,
      mgrVopA.token,
      {
        method: 'PATCH',
        body: JSON.stringify({ quantity: 'abc' }),
      }
    );
    assert.equal(mgrBadQtyNaN.status, 422);
    assert.equal(mgrBadQtyNaN.body.code, 'INVALID_SERVICE_QUANTITY');

    // Manager cancels standalone subscription with cancellation reason in note -> vehicle_plates stays intact
    const mgrCancelRes = await apiFetch(
      `/api/v1/service-subscriptions/${mgrOkRes.body.data.id}`,
      mgrVopA.token,
      {
        method: 'PATCH',
        body: JSON.stringify({
          status: 'CANCELLED',
          note: 'Khách trả chỗ đỗ ô tô',
        }),
      }
    );
    assert.equal(mgrCancelRes.status, 200);
    assert.equal(mgrCancelRes.body.data.note, 'Khách trả chỗ đỗ ô tô');
    assert.deepEqual(mgrCancelRes.body.data.vehicle_plates, ['51K-888.88']);

    // Scenario 5: Resident POST /api/v1/resident/services
    const resAuth = await login(resTenant.email, 'ResidentPassword@123');

    const resMissing = await apiFetch('/api/v1/resident/services', resAuth.token, {
      method: 'POST',
      body: JSON.stringify({
        contract_id: contractId,
        service_id: motorbikeCat.id,
        quantity: 2,
      }),
    });
    if (resMissing.body?.data?.id) createdSubscriptionIds.push(resMissing.body.data.id);
    assert.equal(resMissing.status, 422);
    assert.equal(resMissing.body.code, 'VEHICLE_PLATES_REQUIRED');

    const resDup = await apiFetch('/api/v1/resident/services', resAuth.token, {
      method: 'POST',
      body: JSON.stringify({
        contract_id: contractId,
        service_id: motorbikeCat.id,
        quantity: 2,
        vehicle_plates: ['29b1-111.11', '  29B1-111.11 '],
      }),
    });
    if (resDup.body?.data?.id) createdSubscriptionIds.push(resDup.body.data.id);
    assert.equal(resDup.status, 422);
    assert.equal(resDup.body.code, 'DUPLICATE_VEHICLE_PLATE');

    const resOk = await apiFetch('/api/v1/resident/services', resAuth.token, {
      method: 'POST',
      body: JSON.stringify({
        contract_id: contractId,
        service_id: motorbikeCat.id,
        quantity: 2,
        vehicle_plates: ['29B1-111.11', '29B1-222.22'],
        note: 'Xe gia đình',
      }),
    });
    assert.equal(resOk.status, 201, JSON.stringify(resOk.body));
    const resSubId = resOk.body.data.id;
    createdSubscriptionIds.push(resSubId);
    assert.deepEqual(resOk.body.data.vehicle_plates, ['29B1-111.11', '29B1-222.22']);
    assert.equal(resOk.body.data.note, 'Xe gia đình');

    // Manager approves resident's parking subscription first so cancel transitions to CANCELLATION_PENDING
    const mgrApprove = await apiFetch(`/api/v1/service-subscriptions/${resSubId}`, mgrVopA.token, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'ACTIVE' }),
    });
    assert.equal(mgrApprove.status, 200);

    // Scenario 6 (Review Focus #3): Resident cancels parking subscription with reason in `note` -> `vehicle_plates` preserved!
    const resCancel = await apiFetch(`/api/v1/resident/services/${resSubId}/cancel`, resAuth.token, {
      method: 'PATCH',
      body: JSON.stringify({
        end_date: '2026-12-20',
        note: 'Bán xe không gửi nữa',
      }),
    });
    assert.equal(resCancel.status, 200, JSON.stringify(resCancel.body));
    assert.equal(resCancel.body.data.status, 'CANCELLATION_PENDING');
    assert.equal(resCancel.body.data.note, 'Bán xe không gửi nữa');
    assert.deepEqual(
      resCancel.body.data.vehicle_plates,
      ['29B1-111.11', '29B1-222.22'],
      'Cancellation reason overwriting note must NOT lose vehicle_plates'
    );

    const resList = await apiFetch(`/api/v1/resident/services?contract_id=${contractId}`, resAuth.token);
    assert.equal(resList.status, 200);
    const listedSub = resList.body.data.subscriptions.find((s) => s.id === resSubId);
    assert.deepEqual(listedSub.vehicle_plates, ['29B1-111.11', '29B1-222.22']);
  });
});
