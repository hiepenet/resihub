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

test('Task 1: Auto-provision ELECTRICITY & WATER meters on ACTIVE contract & migration 053 backfill', async (t) => {
  const { ACTIVE_CONTRACT_STATUSES, buildDefaultMeterCode } = await import(
    '../src/services/meterProvisioning.js'
  );
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
      await adminPool.query('UPDATE contract SET parent_contract_id = NULL WHERE parent_contract_id = $1', [cId]).catch(() => {});
      await adminPool.query('DELETE FROM contract WHERE id = $1', [cId]).catch(() => {});
    }
    for (const aId of cleanup.apartmentIds) {
      await adminPool.query(
        `DELETE FROM audit_log WHERE entity = 'meter' AND entity_id IN (SELECT id FROM meter WHERE apartment_id = $1)`,
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

  await t.test('1. Pure helpers: ACTIVE_CONTRACT_STATUSES & buildDefaultMeterCode', () => {
    assert.deepEqual(ACTIVE_CONTRACT_STATUSES, ['ACTIVE', 'RENEWAL_PENDING', 'TERMINATION_PENDING']);
    assert.equal(buildDefaultMeterCode('ELECTRICITY', 'VOP-D', 'A002'), 'EL-VOP-D-A002');
    assert.equal(buildDefaultMeterCode('WATER', 'VOP-D', 'A002'), 'WT-VOP-D-A002');
    assert.equal(buildDefaultMeterCode('ELECTRICITY', 'VOP-D', 'A002', 'ab12cd'), 'EL-VOP-D-A002-AB12CD');
  });

  const sysAdmin = await loginEmail('admin@resihub.vn', 'Admin@123456');
  const pwHash = await bcrypt.hash('Demo@123456', 10);
  const rolesRes = await adminPool.query(
    `SELECT code, id FROM role WHERE org_id = $1 AND code IN ('OWNER', 'MANAGER')`,
    [orgId]
  );
  const roleMap = Object.fromEntries(rolesRes.rows.map((r) => [r.code, r.id]));

  const ownerEmail = `amp.owner.${suffix}@resihub.test`;
  const ownerPhone = `0941${suffix.slice(0, 6)}`;
  const ownerPersonRes = await adminPool.query(
    `INSERT INTO person (org_id, full_name, phone, email, id_number)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [orgId, `Chủ Tòa AMP ${suffix}`, ownerPhone, ownerEmail, `07991${suffix.slice(0, 7)}`]
  );
  cleanup.personIds.push(ownerPersonRes.rows[0].id);
  const ownerRecRes = await adminPool.query(
    `INSERT INTO owner (org_id, person_id, full_name, phone, email) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [orgId, ownerPersonRes.rows[0].id, `Chủ Tòa AMP ${suffix}`, ownerPhone, ownerEmail]
  );
  cleanup.ownerIds.push(ownerRecRes.rows[0].id);
  const ownerUserRes = await adminPool.query(
    `INSERT INTO app_user (person_id, password_hash, status) VALUES ($1, $2, 'ACTIVE') RETURNING id`,
    [ownerPersonRes.rows[0].id, pwHash]
  );
  cleanup.userIds.push(ownerUserRes.rows[0].id);
  await adminPool.query(`INSERT INTO user_role (user_id, role_id) VALUES ($1, $2)`, [
    ownerUserRes.rows[0].id,
    roleMap.OWNER,
  ]);

  const bldCode = `AMP-${suffix}`;
  const bldRes = await adminPool.query(
    `INSERT INTO building (org_id, owner_id, code, name, address)
     VALUES ($1, $2, $3, $4, '100 Auto Meter St') RETURNING id`,
    [orgId, ownerRecRes.rows[0].id, bldCode, `Tòa AMP ${suffix}`]
  );
  const testBuildingId = bldRes.rows[0].id;
  cleanup.buildingIds.push(testBuildingId);

  const flrRes = await adminPool.query(
    `INSERT INTO floor (building_id, level, name) VALUES ($1, 1, 'Tầng 1') RETURNING id`,
    [testBuildingId]
  );
  const testFloorId = flrRes.rows[0].id;
  cleanup.floorIds.push(testFloorId);

  const mgrEmail = `amp.mgr.${suffix}@resihub.test`;
  const mgrPhone = `0942${suffix.slice(0, 6)}`;
  const mgrPersonRes = await adminPool.query(
    `INSERT INTO person (org_id, full_name, phone, email, id_number)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [orgId, `Quản lý AMP ${suffix}`, mgrPhone, mgrEmail, `07992${suffix.slice(0, 7)}`]
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

  const ownerAuth = await loginEmail(ownerEmail, 'Demo@123456');
  const mgrAuth = await loginEmail(mgrEmail, 'Demo@123456');

  async function createApt(codeTag, baseRent = 10000000) {
    const r = await apiFetch('/api/v1/apartments', sysAdmin.token, {
      method: 'POST',
      body: JSON.stringify({
        building_id: testBuildingId,
        floor_id: testFloorId,
        code: codeTag,
        area_m2: 50,
        bedrooms: 1,
        type: '1PN',
        base_rent: baseRent,
      }),
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    cleanup.apartmentIds.push(r.body.data.id);
    return r.body.data;
  }

  async function trackResidentByPhone(phone) {
    const pRes = await adminPool.query(`SELECT id FROM person WHERE phone = $1`, [phone]);
    for (const row of pRes.rows) {
      cleanup.personIds.push(row.id);
      const tRes = await adminPool.query(`SELECT id FROM tenant WHERE person_id = $1`, [row.id]);
      for (const tr of tRes.rows) cleanup.tenantIds.push(tr.id);
      const uRes = await adminPool.query(`SELECT id FROM app_user WHERE person_id = $1`, [row.id]);
      for (const ur of uRes.rows) cleanup.userIds.push(ur.id);
    }
  }

  async function createDraftContractWithScan({ aptId, rentAmount, tag }) {
    const phone = `0943${tag}${suffix.slice(0, 5)}`;
    const cRes = await apiFetch('/api/v1/contracts', mgrAuth.token, {
      method: 'POST',
      body: JSON.stringify({
        apartment_id: aptId,
        start_date: todayStr,
        end_date: isoDaysFromToday(180),
        rent_amount: rentAmount,
        deposit_amount: 0,
        billing_day: 1,
        new_tenant: {
          full_name: `Cư dân AMP ${tag} ${suffix}`,
          phone,
          email: `amp.res.${tag}.${suffix}@resihub.test`,
          id_number: `07993${tag}${suffix.slice(0, 6)}`,
          password: 'Password@123',
        },
      }),
    });
    assert.equal(cRes.status, 201, JSON.stringify(cRes.body));
    const cId = cRes.body.data.id;
    cleanup.contractIds.push(cId);
    await trackResidentByPhone(phone);

    const scanRes = await apiFetch(`/api/v1/contracts/${cId}/scan`, mgrAuth.token, {
      method: 'POST',
      body: JSON.stringify({ image_base64: TINY_PNG_B64 }),
    });
    assert.equal(scanRes.status, 201, JSON.stringify(scanRes.body));
    return cId;
  }

  await t.test('2. MANAGER direct contract activation creates ELECTRICITY & WATER meters while empty apartment stays at 0 meters', async () => {
    const aptEmpty = await createApt('E001', 10000000);
    const apt1 = await createApt('A101', 10000000);

    const beforeMeters = await adminPool.query(
      `SELECT * FROM meter WHERE apartment_id = ANY($1::uuid[])`,
      [[aptEmpty.id, apt1.id]]
    );
    assert.equal(beforeMeters.rows.length, 0, 'Fresh AVAILABLE apartments must have 0 meters');

    const cId = await createDraftContractWithScan({ aptId: apt1.id, rentAmount: 10000000, tag: '1' });
    const draftMeters = await adminPool.query(`SELECT * FROM meter WHERE apartment_id = $1`, [apt1.id]);
    assert.equal(draftMeters.rows.length, 0, 'DRAFT contract must not auto-create meters yet');

    const actRes = await apiFetch(`/api/v1/contracts/${cId}/activate`, mgrAuth.token, { method: 'POST' });
    assert.equal(actRes.status, 200, JSON.stringify(actRes.body));

    const afterMeters = await adminPool.query(
      `SELECT * FROM meter WHERE apartment_id = $1 ORDER BY meter_type ASC`,
      [apt1.id]
    );
    assert.equal(afterMeters.rows.length, 2, 'Activating contract must create 2 meters');
    assert.equal(afterMeters.rows[0].meter_type, 'ELECTRICITY');
    assert.equal(afterMeters.rows[0].meter_code, `EL-${bldCode}-A101`);
    assert.equal(afterMeters.rows[0].unit, 'kWh');
    assert.equal(Number(afterMeters.rows[0].initial_reading), 0);
    assert.equal(afterMeters.rows[0].status, 'ACTIVE');

    assert.equal(afterMeters.rows[1].meter_type, 'WATER');
    assert.equal(afterMeters.rows[1].meter_code, `WT-${bldCode}-A101`);
    assert.equal(afterMeters.rows[1].unit, 'm³');
    assert.equal(Number(afterMeters.rows[1].initial_reading), 0);
    assert.equal(afterMeters.rows[1].status, 'ACTIVE');

    const emptyStillZero = await adminPool.query(`SELECT * FROM meter WHERE apartment_id = $1`, [aptEmpty.id]);
    assert.equal(emptyStillZero.rows.length, 0, 'Empty apartment without contract must still have 0 meters');

    const auditRes = await adminPool.query(
      `SELECT action FROM audit_log WHERE entity = 'meter' AND entity_id = ANY($1::uuid[])`,
      [afterMeters.rows.map((m) => m.id)]
    );
    assert.equal(auditRes.rows.length, 2);
    assert.ok(auditRes.rows.every((r) => r.action === 'AUTO_CREATE_METER'));
  });

  await t.test('3. OWNER approval of discounted contract creates meters cleanly under FORCE RLS (Review Focus #1)', async () => {
    const apt2 = await createApt('A102', 10000000);
    const cId = await createDraftContractWithScan({ aptId: apt2.id, rentAmount: 8500000, tag: '2' });

    const subRes = await apiFetch(`/api/v1/contracts/${cId}/activate`, mgrAuth.token, { method: 'POST' });
    assert.equal(subRes.status, 409, 'Discounted contract should enter PENDING_APPROVAL');
    assert.equal(subRes.body.code, 'PRICE_NEEDS_APPROVAL');

    const pendingMeters = await adminPool.query(`SELECT * FROM meter WHERE apartment_id = $1`, [apt2.id]);
    assert.equal(pendingMeters.rows.length, 0, 'PENDING_APPROVAL must not create meters before approval');

    const appRes = await apiFetch(`/api/v1/contracts/${cId}/approve`, ownerAuth.token, { method: 'POST' });
    assert.equal(appRes.status, 200, `OWNER approve failed: ${JSON.stringify(appRes.body)}`);

    const meters = await adminPool.query(
      `SELECT meter_type, meter_code, status FROM meter WHERE apartment_id = $1 ORDER BY meter_type ASC`,
      [apt2.id]
    );
    assert.equal(meters.rows.length, 2);
    assert.deepEqual(
      meters.rows.map((m) => m.meter_type),
      ['ELECTRICITY', 'WATER']
    );
  });

  await t.test('4. Idempotency on existing meters/readings & meter_code collision fallback (Review Focus #2 & #3)', async () => {
    const aptCollisionHolder = await createApt('A103X', 10000000);
    const apt3 = await createApt('A103', 10000000);

    // Pre-claim EL-<bldCode>-A103 on a different apartment in the same building
    await adminPool.query(
      `INSERT INTO meter (org_id, building_id, apartment_id, meter_type, meter_code, unit, unit_price, initial_reading)
       VALUES ($1, $2, $3, 'ELECTRICITY', $4, 'kWh', 3800, 0)`,
      [orgId, testBuildingId, aptCollisionHolder.id, `EL-${bldCode}-A103`]
    );

    const c3Id = await createDraftContractWithScan({ aptId: apt3.id, rentAmount: 10000000, tag: '3' });
    const act3 = await apiFetch(`/api/v1/contracts/${c3Id}/activate`, mgrAuth.token, { method: 'POST' });
    assert.equal(act3.status, 200, `Collision fallback failed: ${JSON.stringify(act3.body)}`);

    const m3 = await adminPool.query(
      `SELECT meter_type, meter_code FROM meter WHERE apartment_id = $1 ORDER BY meter_type ASC`,
      [apt3.id]
    );
    assert.equal(m3.rows.length, 2);
    assert.equal(
      m3.rows[0].meter_code,
      `EL-${bldCode}-A103-${apt3.id.slice(0, 6).toUpperCase()}`
    );
    assert.equal(m3.rows[1].meter_code, `WT-${bldCode}-A103`);

    // Partial existing meter + historical reading + successor contract
    const apt4 = await createApt('A104', 10000000);
    const preEl = await apiFetch('/api/v1/meters', mgrAuth.token, {
      method: 'POST',
      body: JSON.stringify({
        apartment_id: apt4.id,
        meter_type: 'ELECTRICITY',
        unit_price: 4200,
        initial_reading: 1250,
      }),
    });
    assert.equal(preEl.status, 201);
    const origElId = preEl.body.data.id;

    const read1 = await apiFetch(`/api/v1/meters/${origElId}/readings`, mgrAuth.token, {
      method: 'POST',
      body: JSON.stringify({ period: '2026-10', current_reading: 1300 }),
    });
    assert.equal(read1.status, 201);

    const c4aId = await createDraftContractWithScan({ aptId: apt4.id, rentAmount: 10000000, tag: '4' });
    const act4a = await apiFetch(`/api/v1/contracts/${c4aId}/activate`, mgrAuth.token, { method: 'POST' });
    assert.equal(act4a.status, 200, JSON.stringify(act4a.body));

    const m4AfterFirst = await adminPool.query(
      `SELECT * FROM meter WHERE apartment_id = $1 ORDER BY meter_type ASC`,
      [apt4.id]
    );
    assert.equal(m4AfterFirst.rows.length, 2);
    assert.equal(m4AfterFirst[0]?.id || m4AfterFirst.rows[0].id, origElId);
    assert.equal(Number(m4AfterFirst.rows[0].initial_reading), 1250);
    assert.equal(Number(m4AfterFirst.rows[0].unit_price), 4200);

    const rCheck = await adminPool.query(
      `SELECT current_reading FROM meter_reading WHERE meter_id = $1`,
      [origElId]
    );
    assert.equal(rCheck.rows.length, 1);
    assert.equal(Number(rCheck.rows[0].current_reading), 1300);

    // Terminate c4a and activate successor contract c4b on apt4 (already has BOTH meters)
    const termRes = await apiFetch(`/api/v1/contracts/${c4aId}/terminate`, mgrAuth.token, {
      method: 'POST',
      body: JSON.stringify({ reason: 'Kết thúc hợp đồng thử nghiệm idempotent meter' }),
    });
    assert.equal(termRes.status, 200, JSON.stringify(termRes.body));

    const reopenApt = await apiFetch(`/api/v1/apartments/${apt4.id}`, mgrAuth.token, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'AVAILABLE' }),
    });
    assert.equal(reopenApt.status, 200, JSON.stringify(reopenApt.body));

    const c4bId = await createDraftContractWithScan({ aptId: apt4.id, rentAmount: 10000000, tag: '5' });
    const act4b = await apiFetch(`/api/v1/contracts/${c4bId}/activate`, mgrAuth.token, { method: 'POST' });
    assert.equal(act4b.status, 200, JSON.stringify(act4b.body));

    const m4AfterSecond = await adminPool.query(
      `SELECT id FROM meter WHERE apartment_id = $1 ORDER BY meter_type ASC`,
      [apt4.id]
    );
    assert.equal(m4AfterSecond.rows.length, 2, 'Must keep exact 2 meters without error');
    assert.equal(m4AfterSecond.rows[0].id, origElId);
  });

  await t.test('5. Migration 053 backfill: zero active-contract apartments in DB lack ELECTRICITY or WATER meters', async () => {
    const missingRes = await adminPool.query(`
      SELECT a.id, b.code AS building_code, a.code AS apartment_code
      FROM apartment a
      JOIN building b ON b.id = a.building_id
      WHERE EXISTS (
        SELECT 1 FROM contract c
        WHERE c.apartment_id = a.id
          AND c.status IN ('ACTIVE', 'RENEWAL_PENDING', 'TERMINATION_PENDING')
      )
      AND (
        NOT EXISTS (SELECT 1 FROM meter m WHERE m.apartment_id = a.id AND m.meter_type = 'ELECTRICITY')
        OR NOT EXISTS (SELECT 1 FROM meter m WHERE m.apartment_id = a.id AND m.meter_type = 'WATER')
      )
    `);
    assert.deepEqual(
      missingRes.rows,
      [],
      `Expected 0 active-contract apartments missing meters, found: ${JSON.stringify(missingRes.rows)}`
    );
  });
});
