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

test('Task 2: Untouched meter initial_reading update & GET /api/v1/meters active_contract filter', async (t) => {
  const { adminPool, appPool } = await import('../src/db/client.js');
  const { default: authRoute } = await import('../src/routes/auth.js');
  const { default: apartmentsRoute } = await import('../src/routes/apartments.js');
  const { default: contractsRoute } = await import('../src/routes/contracts.js');
  const { default: metersRoute } = await import('../src/routes/meters.js');

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
  app.use('/api/v1/meters', metersRoute);

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

  async function loginEmail(email, password) {
    const res = await apiFetch('/api/v1/auth/login', null, {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
    assert.equal(res.status, 200, `Login failed for ${email}: ${JSON.stringify(res.body)}`);
    return { token: res.body.accessToken, user: res.body.user };
  }

  const suffix = `${String(Date.now()).slice(-6)}${Math.floor(Math.random() * 90 + 10)}`;
  const todayStr = isoDaysFromToday(0);

  const cleanup = {
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
    for (const cId of cleanup.contractIds) {
      await adminPool.query('DELETE FROM contract_occupant WHERE contract_id = $1', [cId]).catch(() => {});
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
      await adminPool.query('DELETE FROM contract WHERE id = $1', [cId]).catch(() => {});
    }
    for (const aId of cleanup.apartmentIds) {
      await adminPool.query(
        `DELETE FROM audit_log WHERE entity IN ('meter', 'meter_reading') AND (entity_id IN (SELECT id FROM meter WHERE apartment_id = $1) OR entity_id IN (SELECT mr.id FROM meter_reading mr JOIN meter m ON m.id = mr.meter_id WHERE m.apartment_id = $1))`,
        [aId]
      ).catch(() => {});
      await adminPool.query('DELETE FROM meter_reading WHERE meter_id IN (SELECT id FROM meter WHERE apartment_id = $1)', [aId]).catch(() => {});
      await adminPool.query('DELETE FROM meter WHERE apartment_id = $1', [aId]).catch(() => {});
      await adminPool.query('DELETE FROM apartment WHERE id = $1', [aId]).catch(() => {});
    }
    for (const fId of cleanup.floorIds) {
      await adminPool.query('DELETE FROM floor WHERE id = $1', [fId]).catch(() => {});
    }
    for (const bId of cleanup.buildingIds) {
      await adminPool.query('DELETE FROM user_role WHERE building_id = $1', [bId]).catch(() => {});
      await adminPool.query('DELETE FROM building WHERE id = $1', [bId]).catch(() => {});
    }
    for (const oId of cleanup.ownerIds) {
      await adminPool.query('DELETE FROM owner WHERE id = $1', [oId]).catch(() => {});
    }
    for (const tId of cleanup.tenantIds) {
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

  const sysAdmin = await loginEmail('admin@resihub.vn', 'Admin@123456');
  const pwHash = await bcrypt.hash('Demo@123456', 10);
  const rolesRes = await adminPool.query(
    `SELECT code, id FROM role WHERE org_id = $1 AND code IN ('OWNER', 'MANAGER')`,
    [orgId]
  );
  const roleMap = Object.fromEntries(rolesRes.rows.map((r) => [r.code, r.id]));

  const ownerEmail = `mfl.owner.${suffix}@resihub.test`;
  const ownerPhone = `0951${suffix.slice(0, 6)}`;
  const ownerPersonRes = await adminPool.query(
    `INSERT INTO person (org_id, full_name, phone, email, id_number)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [orgId, `Chủ Tòa MFL ${suffix}`, ownerPhone, ownerEmail, `07971${suffix.slice(0, 7)}`]
  );
  cleanup.personIds.push(ownerPersonRes.rows[0].id);
  const ownerRecRes = await adminPool.query(
    `INSERT INTO owner (org_id, person_id, full_name, phone, email) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [orgId, ownerPersonRes.rows[0].id, `Chủ Tòa MFL ${suffix}`, ownerPhone, ownerEmail]
  );
  cleanup.ownerIds.push(ownerRecRes.rows[0].id);

  const bldCode = `MFL-${suffix}`;
  const bldRes = await adminPool.query(
    `INSERT INTO building (org_id, owner_id, code, name, address)
     VALUES ($1, $2, $3, $4, '200 Filter St') RETURNING id`,
    [orgId, ownerRecRes.rows[0].id, bldCode, `Tòa MFL ${suffix}`]
  );
  const testBuildingId = bldRes.rows[0].id;
  cleanup.buildingIds.push(testBuildingId);

  const flrRes = await adminPool.query(
    `INSERT INTO floor (building_id, level, name) VALUES ($1, 1, 'Tầng 1') RETURNING id`,
    [testBuildingId]
  );
  const testFloorId = flrRes.rows[0].id;
  cleanup.floorIds.push(testFloorId);

  const mgrEmail = `mfl.mgr.${suffix}@resihub.test`;
  const mgrPhone = `0952${suffix.slice(0, 6)}`;
  const mgrPersonRes = await adminPool.query(
    `INSERT INTO person (org_id, full_name, phone, email, id_number)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [orgId, `Quản lý MFL ${suffix}`, mgrPhone, mgrEmail, `07972${suffix.slice(0, 7)}`]
  );
  cleanup.personIds.push(mgrPersonRes.rows[0].id);
  const mgrUserRes = await adminPool.query(
    `INSERT INTO app_user (person_id, password_hash, status) VALUES ($1, $2, 'ACTIVE') RETURNING id`,
    [mgrPersonRes.rows[0].id, pwHash]
  );
  cleanup.userIds.push(mgrUserRes.rows[0].id);
  await adminPool.query(
    `INSERT INTO user_role (user_id, role_id, building_id) VALUES ($1, $2, $3)`,
    [mgrUserRes.rows[0].id, roleMap.MANAGER, testBuildingId]
  );

  const mgrAuth = await loginEmail(mgrEmail, 'Demo@123456');

  async function createApt(codeTag) {
    const r = await apiFetch('/api/v1/apartments', sysAdmin.token, {
      method: 'POST',
      body: JSON.stringify({
        building_id: testBuildingId,
        floor_id: testFloorId,
        code: codeTag,
        area_m2: 45,
        bedrooms: 1,
        type: '1PN',
        base_rent: 9000000,
      }),
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    cleanup.apartmentIds.push(r.body.data.id);
    return r.body.data;
  }

  async function createRawTenantAndContract(aptId, status, tag) {
    const pRes = await adminPool.query(
      `INSERT INTO person (org_id, full_name, phone, email, id_number)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [orgId, `Khách MFL ${tag}`, `0953${tag}${suffix.slice(0, 5)}`, `mfl.t.${tag}.${suffix}@resihub.test`, `07973${tag}${suffix.slice(0, 6)}`]
    );
    cleanup.personIds.push(pRes.rows[0].id);
    const tRes = await adminPool.query(
      `INSERT INTO tenant (org_id, person_id, type, status) VALUES ($1, $2, 'primary', 'APPROVED') RETURNING id`,
      [orgId, pRes.rows[0].id]
    );
    cleanup.tenantIds.push(tRes.rows[0].id);
    const cRes = await adminPool.query(
      `INSERT INTO contract (building_id, apartment_id, primary_tenant_id, start_date, end_date, rent_amount, deposit_amount, billing_day, status, terminated_at)
       VALUES ($1, $2, $3, $4, $5, 9000000, 0, 1, $6, $7) RETURNING id`,
      [
        testBuildingId,
        aptId,
        tRes.rows[0].id,
        todayStr,
        isoDaysFromToday(180),
        status,
        status === 'TERMINATED' ? todayStr : null,
      ]
    );
    cleanup.contractIds.push(cRes.rows[0].id);
    return cRes.rows[0].id;
  }

  await t.test('1. POST /api/v1/meters updates untouched (0 readings) meter cleanly, then rejects with 409 once a reading exists or meter_code collides (Review Focus #4)', async () => {
    const aptA = await createApt('F101');
    const aptB = await createApt('F102');

    // Create initial meter on aptA & aptB
    const initA = await apiFetch('/api/v1/meters', mgrAuth.token, {
      method: 'POST',
      body: JSON.stringify({
        apartment_id: aptA.id,
        meter_type: 'ELECTRICITY',
        unit_price: 3800,
        initial_reading: 0,
      }),
    });
    assert.equal(initA.status, 201);
    const meterAId = initA.body.data.id;

    const initB = await apiFetch('/api/v1/meters', mgrAuth.token, {
      method: 'POST',
      body: JSON.stringify({
        apartment_id: aptB.id,
        meter_type: 'ELECTRICITY',
        meter_code: `CUSTOM-EL-${suffix}`,
        unit_price: 3800,
        initial_reading: 50,
      }),
    });
    assert.equal(initB.status, 201);

    // Updating untouched meterA (0 readings) succeeds with 201 and keeps same meterAId
    const updUntouched = await apiFetch('/api/v1/meters', mgrAuth.token, {
      method: 'POST',
      body: JSON.stringify({
        apartment_id: aptA.id,
        meter_type: 'ELECTRICITY',
        unit_price: 4100,
        initial_reading: 1500,
      }),
    });
    assert.equal(updUntouched.status, 201, `Expected 201 on untouched meter update, got ${JSON.stringify(updUntouched.body)}`);
    assert.equal(updUntouched.body.data.id, meterAId);
    assert.equal(Number(updUntouched.body.data.initial_reading), 1500);
    assert.equal(Number(updUntouched.body.data.unit_price), 4100);

    // Colliding meter_code with aptB returns 409 DUPLICATE_METER
    const codeCollision = await apiFetch('/api/v1/meters', mgrAuth.token, {
      method: 'POST',
      body: JSON.stringify({
        apartment_id: aptA.id,
        meter_type: 'ELECTRICITY',
        meter_code: `CUSTOM-EL-${suffix}`,
        unit_price: 4100,
        initial_reading: 1500,
      }),
    });
    assert.equal(codeCollision.status, 409);
    assert.equal(codeCollision.body.code, 'DUPLICATE_METER');

    // Record a DRAFT reading on meterA -> subsequent POST /api/v1/meters must fail 409 DUPLICATE_METER
    const draftRead = await apiFetch(`/api/v1/meters/${meterAId}/readings`, mgrAuth.token, {
      method: 'POST',
      body: JSON.stringify({ period: '2026-11', current_reading: 1550, status: 'DRAFT' }),
    });
    assert.equal(draftRead.status, 201);

    const blockedAfterRead = await apiFetch('/api/v1/meters', mgrAuth.token, {
      method: 'POST',
      body: JSON.stringify({
        apartment_id: aptA.id,
        meter_type: 'ELECTRICITY',
        unit_price: 4500,
        initial_reading: 2000,
      }),
    });
    assert.equal(blockedAfterRead.status, 409);
    assert.equal(blockedAfterRead.body.code, 'DUPLICATE_METER');

    const dbMeterA = await adminPool.query(`SELECT initial_reading, unit_price FROM meter WHERE id = $1`, [meterAId]);
    assert.equal(Number(dbMeterA.rows[0].initial_reading), 1500);
    assert.equal(Number(dbMeterA.rows[0].unit_price), 4100);
  });

  await t.test('2. GET /api/v1/meters supports active_contract=true|false and exposes has_active_contract (Review Focus #5)', async () => {
    const aptActive = await createApt('C201');
    const aptRenewal = await createApt('C202');
    const aptEnded = await createApt('C203');

    await createRawTenantAndContract(aptActive.id, 'ACTIVE', 'A');
    await createRawTenantAndContract(aptRenewal.id, 'RENEWAL_PENDING', 'R');
    await createRawTenantAndContract(aptEnded.id, 'TERMINATED', 'T');

    for (const apt of [aptActive, aptRenewal, aptEnded]) {
      for (const mType of ['ELECTRICITY', 'WATER']) {
        const res = await apiFetch('/api/v1/meters', mgrAuth.token, {
          method: 'POST',
          body: JSON.stringify({ apartment_id: apt.id, meter_type: mType, initial_reading: 0 }),
        });
        assert.equal(res.status, 201);
      }
    }

    const filterC2xx = (rows) =>
      rows.filter((r) => ['C201', 'C202', 'C203'].includes(r.apartment_code));

    const allRes = await apiFetch(`/api/v1/meters?building_id=${testBuildingId}`, mgrAuth.token);
    assert.equal(allRes.status, 200);
    const allC2 = filterC2xx(allRes.body.data);
    assert.equal(allC2.length, 6);
    assert.ok(allC2.filter((r) => r.apartment_code === 'C201').every((r) => r.has_active_contract === true));
    assert.ok(allC2.filter((r) => r.apartment_code === 'C202').every((r) => r.has_active_contract === true));
    assert.ok(allC2.filter((r) => r.apartment_code === 'C203').every((r) => r.has_active_contract === false));

    const onlyActiveRes = await apiFetch(
      `/api/v1/meters?building_id=${testBuildingId}&active_contract=true`,
      mgrAuth.token
    );
    assert.equal(onlyActiveRes.status, 200);
    const activeC2 = filterC2xx(onlyActiveRes.body.data);
    assert.equal(activeC2.length, 4);
    assert.deepEqual(
      [...new Set(activeC2.map((r) => r.apartment_code))].sort(),
      ['C201', 'C202']
    );

    const onlyInactiveRes = await apiFetch(
      `/api/v1/meters?building_id=${testBuildingId}&active_contract=false`,
      mgrAuth.token
    );
    assert.equal(onlyInactiveRes.status, 200);
    const inactiveC2 = filterC2xx(onlyInactiveRes.body.data);
    assert.equal(inactiveC2.length, 2);
    assert.deepEqual([...new Set(inactiveC2.map((r) => r.apartment_code))], ['C203']);

    // Invalid active_contract value safely ignored
    const invalidParamRes = await apiFetch(
      `/api/v1/meters?building_id=${testBuildingId}&active_contract=invalid`,
      mgrAuth.token
    );
    assert.equal(invalidParamRes.status, 200);
    assert.equal(filterC2xx(invalidParamRes.body.data).length, 6);
  });
});
