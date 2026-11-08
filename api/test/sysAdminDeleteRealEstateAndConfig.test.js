import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import express from 'express';
import jwt from 'jsonwebtoken';
import { JWT_SECRET } from '../src/config/env.js';
import { pool, adminPool, appPool } from '../src/db/client.js';
import buildingsRoute from '../src/routes/buildings.js';
import apartmentsRoute from '../src/routes/apartments.js';
import settingsRoute from '../src/routes/settings.js';
import zaloGroupsRoute from '../src/routes/zalo-groups.js';

function signToken({ sub, orgId, role, personId = null }) {
  return jwt.sign(
    {
      sub,
      org_id: orgId,
      person_id: personId,
      role,
      roles: [role],
    },
    JWT_SECRET,
    { expiresIn: '1h' }
  );
}

test('SYS_ADMIN Delete — Real Estate (M03) & System Config / Zalo Groups (M01/M13)', async (t) => {
  let server;
  let baseUrl;
  let orgId;
  let otherOrgId;
  let sysAdminId;
  let assignedMgrId;
  let ownerUserId;
  let testBuildingId;
  let otherOrgBuildingId;
  let otherOrgApartmentId;
  let savedSlaRow = null;

  t.before(async () => {
    const orgRes = await adminPool.query('SELECT id FROM organization ORDER BY created_at ASC LIMIT 1');
    assert.ok(orgRes.rows.length > 0, 'Cần có ít nhất 1 organization trong DB');
    orgId = orgRes.rows[0].id;

    const adminRes = await adminPool.query(
      `SELECT u.id FROM app_user u
       JOIN user_role ur ON ur.user_id = u.id
       JOIN role r ON r.id = ur.role_id
       WHERE r.org_id = $1 AND r.code = 'SYS_ADMIN' AND u.status = 'ACTIVE'
       LIMIT 1`,
      [orgId]
    );
    assert.ok(adminRes.rows.length > 0, 'Cần có tài khoản SYS_ADMIN');
    sysAdminId = adminRes.rows[0].id;

    const mgrRes = await adminPool.query(
      `SELECT u.id FROM app_user u
       JOIN user_role ur ON ur.user_id = u.id
       JOIN role r ON r.id = ur.role_id
       WHERE r.org_id = $1 AND r.code = 'MANAGER' AND u.status = 'ACTIVE'
       LIMIT 1`,
      [orgId]
    );
    assert.ok(mgrRes.rows.length > 0, 'Cần có tài khoản MANAGER');
    assignedMgrId = mgrRes.rows[0].id;

    const ownerRes = await adminPool.query(
      `SELECT u.id FROM app_user u
       JOIN user_role ur ON ur.user_id = u.id
       JOIN role r ON r.id = ur.role_id
       WHERE r.org_id = $1 AND r.code = 'OWNER' AND u.status = 'ACTIVE'
       LIMIT 1`,
      [orgId]
    );
    assert.ok(ownerRes.rows.length > 0, 'Cần có tài khoản OWNER');
    ownerUserId = ownerRes.rows[0].id;

    // Save current sla_config so we restore cleanly after test
    const slaBackup = await adminPool.query(
      `SELECT value, description, updated_by FROM system_setting WHERE org_id = $1 AND key = 'sla_config'`,
      [orgId]
    );
    savedSlaRow = slaBackup.rows[0] || null;

    // Setup temporary building in primary org
    testBuildingId = crypto.randomUUID();
    const bCode = `TDEL-${Date.now().toString(36).toUpperCase().slice(-6)}`;
    await adminPool.query(
      `INSERT INTO building (id, org_id, name, code, address, status)
       VALUES ($1, $2, 'Tòa kiểm thử Delete', $3, '99 Test Delete Rd', 'ACTIVE')`,
      [testBuildingId, orgId, bCode]
    );

    const mgrRoleRes = await adminPool.query(
      `SELECT id FROM role WHERE org_id = $1 AND code = 'MANAGER' LIMIT 1`,
      [orgId]
    );
    await adminPool.query(
      `INSERT INTO user_role (user_id, role_id, building_id)
       VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING`,
      [assignedMgrId, mgrRoleRes.rows[0].id, testBuildingId]
    );

    // Setup isolated second org + building + apartment to verify cross-org 404 isolation
    otherOrgId = crypto.randomUUID();
    otherOrgBuildingId = crypto.randomUUID();
    otherOrgApartmentId = crypto.randomUUID();
    await adminPool.query(
      `INSERT INTO organization (id, name) VALUES ($1, 'Other Org Delete Test')`,
      [otherOrgId]
    );
    await adminPool.query(
      `INSERT INTO building (id, org_id, name, code, status)
       VALUES ($1, $2, 'Other Org Bldg', $3, 'ACTIVE')`,
      [otherOrgBuildingId, otherOrgId, `OOB-${Date.now().toString(36).slice(-5)}`]
    );
    await adminPool.query(
      `INSERT INTO apartment (id, building_id, code, status)
       VALUES ($1, $2, 'OO-101', 'AVAILABLE')`,
      [otherOrgApartmentId, otherOrgBuildingId]
    );

    const app = express();
    app.use(express.json());
    app.use('/api/v1/buildings', buildingsRoute);
    app.use('/api/v1/apartments', apartmentsRoute);
    app.use('/api/v1/settings', settingsRoute);
    app.use('/api/v1/zalo-groups', zaloGroupsRoute);

    await new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  t.after(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    if (savedSlaRow) {
      await adminPool
        .query(
          `INSERT INTO system_setting (org_id, key, value, description, updated_by, updated_at)
           VALUES ($1, 'sla_config', $2, $3, $4, NOW())
           ON CONFLICT (org_id, key) DO UPDATE
             SET value = EXCLUDED.value,
                 description = EXCLUDED.description,
                 updated_by = EXCLUDED.updated_by,
                 updated_at = NOW()`,
          [orgId, JSON.stringify(savedSlaRow.value), savedSlaRow.description, savedSlaRow.updated_by]
        )
        .catch(() => {});
    }
    await adminPool.query('DELETE FROM building WHERE id = $1', [testBuildingId]).catch(() => {});
    await adminPool.query('DELETE FROM organization WHERE id = $1', [otherOrgId]).catch(() => {});
    await Promise.allSettled([pool.end(), appPool.end(), adminPool.end()]);
  });

  async function apiReq(method, path, token, body) {
    const headers = {
      Authorization: `Bearer ${token}`,
      'Idempotency-Key': crypto.randomUUID(),
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const resp = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const json = await resp.json().catch(() => ({}));
    return { status: resp.status, body: json };
  }

  await t.test('1. Floor & Apartment Delete: cross-org 404, MANAGER 403, meter-only apartment deletes cleanly, meter_reading/invoice blocks 409', async () => {
    const adminToken = signToken({ sub: sysAdminId, orgId, role: 'SYS_ADMIN' });
    const mgrToken = signToken({ sub: assignedMgrId, orgId, role: 'MANAGER' });

    // Cross-org apartment -> 404 NOT_FOUND (never leak existence across orgs)
    const crossOrgRes = await apiReq('DELETE', `/api/v1/apartments/${otherOrgApartmentId}`, adminToken);
    assert.equal(crossOrgRes.status, 404);

    // Create a floor + 2 apartments (aptClean with auto-created meters, aptHistory with meter_reading)
    const floorCreate = await apiReq('POST', `/api/v1/buildings/${testBuildingId}/floors`, adminToken, {
      level: 1,
      name: 'Tầng 1 Test',
    });
    assert.equal(floorCreate.status, 201);
    const floorId = floorCreate.body.data.id;

    const apt1Create = await apiReq('POST', '/api/v1/apartments', adminToken, {
      building_id: testBuildingId,
      floor_id: floorId,
      code: 'A-101',
      area_m2: 45,
      base_rent: 8000000,
    });
    assert.equal(apt1Create.status, 201);
    const aptCleanId = apt1Create.body.data.id;

    // Ensure auto-provisioned meters exist on aptCleanId (0 readings)
    const mCntBefore = await adminPool.query('SELECT COUNT(*)::int AS cnt FROM meter WHERE apartment_id = $1', [aptCleanId]);
    if (mCntBefore.rows[0].cnt === 0) {
      await adminPool.query(
        `INSERT INTO meter (org_id, building_id, apartment_id, meter_type, meter_code, unit, unit_price)
         VALUES ($1, $2, $3, 'ELECTRICITY', $4, 'kWh', 3800)`,
        [orgId, testBuildingId, aptCleanId, `EL-TDEL-${Date.now()}`]
      );
    }

    // MANAGER cannot delete apartment -> 403 DELETE_PROHIBITED
    const mgrDelApt = await apiReq('DELETE', `/api/v1/apartments/${aptCleanId}`, mgrToken);
    assert.equal(mgrDelApt.status, 403);
    assert.equal(mgrDelApt.body.code, 'DELETE_PROHIBITED');

    // SYS_ADMIN deletes apartment with empty meters -> 200 & cascades meters under RLS + snapshots cascaded_meters in audit_log
    const adminDelApt = await apiReq('DELETE', `/api/v1/apartments/${aptCleanId}`, adminToken);
    assert.equal(adminDelApt.status, 200);
    const mCntAfter = await adminPool.query('SELECT COUNT(*)::int AS cnt FROM meter WHERE apartment_id = $1', [aptCleanId]);
    assert.equal(mCntAfter.rows[0].cnt, 0);
    const aptAudit = await adminPool.query(
      `SELECT before FROM audit_log WHERE entity = 'apartment' AND entity_id = $1 AND action = 'DELETE' ORDER BY id DESC LIMIT 1`,
      [aptCleanId]
    );
    assert.equal(aptAudit.rows.length, 1);
    assert.ok(Array.isArray(aptAudit.rows[0].before?.cascaded_meters), 'audit_log.before phải ghi nhận cascaded_meters');
    assert.ok(aptAudit.rows[0].before.cascaded_meters.length >= 1);

    // Create 2nd apartment and attach a meter_reading -> must block 409 APARTMENT_HAS_HISTORY
    const apt2Create = await apiReq('POST', '/api/v1/apartments', adminToken, {
      building_id: testBuildingId,
      floor_id: floorId,
      code: 'A-102',
      area_m2: 50,
      base_rent: 9000000,
    });
    assert.equal(apt2Create.status, 201);
    const aptHistoryId = apt2Create.body.data.id;

    const meterId = crypto.randomUUID();
    await adminPool.query(
      `INSERT INTO meter (id, org_id, building_id, apartment_id, meter_type, meter_code, unit, unit_price)
       VALUES ($1, $2, $3, $4, 'ELECTRICITY', $5, 'kWh', 3800)
       ON CONFLICT (apartment_id, meter_type) DO UPDATE SET unit_price = EXCLUDED.unit_price
       RETURNING id`,
      [meterId, orgId, testBuildingId, aptHistoryId, `EL-HIST-${Date.now()}`]
    );
    const actualMeterRes = await adminPool.query(
      `SELECT id FROM meter WHERE apartment_id = $1 AND meter_type = 'ELECTRICITY' LIMIT 1`,
      [aptHistoryId]
    );
    const actualMeterId = actualMeterRes.rows[0].id;
    const readingId = crypto.randomUUID();
    await adminPool.query(
      `INSERT INTO meter_reading (id, org_id, building_id, meter_id, apartment_id, period, previous_reading, current_reading, consumption, status)
       VALUES ($1, $2, $3, $4, $5, '2026-10', 0, 100, 100, 'CONFIRMED')`,
      [readingId, orgId, testBuildingId, actualMeterId, aptHistoryId]
    );

    const blockedApt = await apiReq('DELETE', `/api/v1/apartments/${aptHistoryId}`, adminToken);
    assert.equal(blockedApt.status, 409);
    assert.equal(blockedApt.body.code, 'APARTMENT_HAS_HISTORY');

    // Remove meter_reading -> apartment deletes cleanly
    await adminPool.query('DELETE FROM meter_reading WHERE id = $1', [readingId]);
    const delApt2 = await apiReq('DELETE', `/api/v1/apartments/${aptHistoryId}`, adminToken);
    assert.equal(delApt2.status, 200);

    // MANAGER cannot delete empty floor -> 403 DELETE_PROHIBITED; SYS_ADMIN deletes empty floor -> 200
    const mgrDelFloor = await apiReq('DELETE', `/api/v1/buildings/${testBuildingId}/floors/${floorId}`, mgrToken);
    assert.equal(mgrDelFloor.status, 403);
    assert.equal(mgrDelFloor.body.code, 'DELETE_PROHIBITED');

    const adminDelFloor = await apiReq('DELETE', `/api/v1/buildings/${testBuildingId}/floors/${floorId}`, adminToken);
    assert.equal(adminDelFloor.status, 200);
  });

  await t.test('2. Zalo Group CRUD for SYS_ADMIN & DELETE prohibited for MANAGER', async () => {
    const adminToken = signToken({ sub: sysAdminId, orgId, role: 'SYS_ADMIN' });
    const mgrToken = signToken({ sub: assignedMgrId, orgId, role: 'MANAGER' });

    // SYS_ADMIN creates a Zalo group under RLS
    const createZg = await apiReq('POST', '/api/v1/zalo-groups', adminToken, {
      building_id: testBuildingId,
      scope: 'BUILDING',
      name: 'Nhóm Zalo Tòa Test',
      invite_link: 'https://zalo.me/g/resihubtest123',
      note: 'Test group',
    });
    assert.equal(createZg.status, 201, JSON.stringify(createZg.body));
    const zgId = createZg.body.data.id;

    // SYS_ADMIN updates the Zalo group under RLS
    const updateZg = await apiReq('PUT', `/api/v1/zalo-groups/${zgId}`, adminToken, {
      name: 'Nhóm Zalo Tòa Test Đã Sửa',
    });
    assert.equal(updateZg.status, 200);
    assert.equal(updateZg.body.data.name, 'Nhóm Zalo Tòa Test Đã Sửa');

    // Building with Zalo group cannot be deleted yet -> 400 BUILDING_NOT_EMPTY
    const blockedBldgByZg = await apiReq('DELETE', `/api/v1/buildings/${testBuildingId}`, adminToken);
    assert.equal(blockedBldgByZg.status, 400);
    assert.equal(blockedBldgByZg.body.code, 'BUILDING_NOT_EMPTY');

    // MANAGER cannot delete Zalo group -> 403 DELETE_PROHIBITED
    const mgrDelZg = await apiReq('DELETE', `/api/v1/zalo-groups/${zgId}`, mgrToken);
    assert.equal(mgrDelZg.status, 403);
    assert.equal(mgrDelZg.body.code, 'DELETE_PROHIBITED');

    // SYS_ADMIN deletes Zalo group -> 200 + audit_log
    const adminDelZg = await apiReq('DELETE', `/api/v1/zalo-groups/${zgId}`, adminToken);
    assert.equal(adminDelZg.status, 200);

    const auditZg = await adminPool.query(
      `SELECT COUNT(*)::int AS cnt FROM audit_log WHERE entity = 'zalo_group' AND entity_id = $1 AND action = 'DELETE'`,
      [zgId]
    );
    assert.ok(auditZg.rows[0].cnt >= 1);
  });

  await t.test('3. Building Detail counts & Building Delete (malformed UUID 404, cross-org 404, ai_suggestion block 400, empty 200)', async () => {
    const adminToken = signToken({ sub: sysAdminId, orgId, role: 'SYS_ADMIN' });

    // Malformed UUID & Cross-org building -> 404
    const badUuidDel = await apiReq('DELETE', '/api/v1/buildings/not-a-valid-uuid', adminToken);
    assert.equal(badUuidDel.status, 404);
    const crossOrgBldgDel = await apiReq('DELETE', `/api/v1/buildings/${otherOrgBuildingId}`, adminToken);
    assert.equal(crossOrgBldgDel.status, 404);

    // GET /api/v1/buildings/:id returns total_apartments, total_floors, total_zones (even for floorless apartments)
    const floorlessAptId = crypto.randomUUID();
    await adminPool.query(
      `INSERT INTO apartment (id, building_id, floor_id, code, status)
       VALUES ($1, $2, NULL, 'FL-001', 'AVAILABLE')`,
      [floorlessAptId, testBuildingId]
    );
    const bldgDetail = await apiReq('GET', `/api/v1/buildings/${testBuildingId}`, adminToken);
    assert.equal(bldgDetail.status, 200);
    assert.equal(Number(bldgDetail.body.data.total_apartments), 1);
    assert.equal(Number(bldgDetail.body.data.total_floors), 0);
    assert.equal(Number(bldgDetail.body.data.total_zones), 0);
    await adminPool.query('DELETE FROM apartment WHERE id = $1', [floorlessAptId]);

    const aiId = crypto.randomUUID();
    await adminPool.query(
      `INSERT INTO ai_suggestion (id, org_id, building_id, task_type, target_entity, model, prompt_version, status)
       VALUES ($1, $2, $3, 'TICKET_TRIAGE', 'service_request', 'gemini-3.8-flash', 'v1', 'EXPIRED')`,
      [aiId, orgId, testBuildingId]
    );

    const blockedByAi = await apiReq('DELETE', `/api/v1/buildings/${testBuildingId}`, adminToken);
    assert.equal(blockedByAi.status, 400);
    assert.equal(blockedByAi.body.code, 'BUILDING_NOT_EMPTY');

    // Verify ai_suggestion was NOT cascade-deleted!
    const aiStillExists = await adminPool.query('SELECT 1 FROM ai_suggestion WHERE id = $1', [aiId]);
    assert.equal(aiStillExists.rows.length, 1);

    // Create a fresh empty building to test 200 delete
    const emptyBuildingId = crypto.randomUUID();
    await adminPool.query(
      `INSERT INTO building (id, org_id, name, code, status)
       VALUES ($1, $2, 'Tòa Rỗng 100%', $3, 'ACTIVE')`,
      [emptyBuildingId, orgId, `TEMPTY-${Date.now().toString(36).slice(-5)}`]
    );
    const okBldgDel = await apiReq('DELETE', `/api/v1/buildings/${emptyBuildingId}`, adminToken);
    assert.equal(okBldgDel.status, 200);
  });

  await t.test('4. System Setting Reset (DELETE /api/v1/settings/:key) enforces SYS_ADMIN, validates key & restores full defaults on GET/DELETE', async () => {
    const adminToken = signToken({ sub: sysAdminId, orgId, role: 'SYS_ADMIN' });
    const mgrToken = signToken({ sub: assignedMgrId, orgId, role: 'MANAGER' });
    const ownerToken = signToken({ sub: ownerUserId, orgId, role: 'OWNER' });

    const aiBackup = await adminPool.query(
      `SELECT value, description, updated_by FROM system_setting WHERE org_id = $1 AND key = 'ai_config'`,
      [orgId]
    );
    const savedAiRow = aiBackup.rows[0] || null;

    try {
      // Non-SYS_ADMIN blocked with 403
      const mgrReset = await apiReq('DELETE', '/api/v1/settings/sla_config', mgrToken);
      assert.equal(mgrReset.status, 403);
      const ownerReset = await apiReq('DELETE', '/api/v1/settings/sla_config', ownerToken);
      assert.equal(ownerReset.status, 403);

      // Invalid key -> 400 INVALID_SETTING_KEY
      const badKey = await apiReq('DELETE', '/api/v1/settings/unknown_magic_key', adminToken);
      assert.equal(badKey.status, 400);
      assert.equal(badKey.body.code, 'INVALID_SETTING_KEY');

      // Customize sla_config via PUT, then reset via DELETE
      const putCustom = await apiReq('PUT', '/api/v1/settings', adminToken, {
        sla_config: { response_hours: 99, normal_resolve_hours: 120 },
      });
      assert.equal(putCustom.status, 200);
      assert.equal(putCustom.body.data.sla_config.response_hours, 99);

      const resetRes = await apiReq('DELETE', '/api/v1/settings/sla_config', adminToken);
      assert.equal(resetRes.status, 200);
      assert.equal(resetRes.body.key, 'sla_config');
      assert.equal(resetRes.body.default_value.response_hours, 2);
      assert.equal(resetRes.body.default_value.normal_resolve_hours, 24);
      // Resetting removes the DB row from items, while data still serves DEFAULT_SYSTEM_SETTINGS fallback!
      assert.equal(resetRes.body.items.some((r) => r.key === 'sla_config'), false);
      assert.equal(resetRes.body.data.sla_config.response_hours, 2);
      assert.equal(resetRes.body.data.sla_config.reopen_window_days, 3);

      // Reset ai_config -> default_value.enabled === true & model === 'gemini-3.8-flash'
      const resetAi = await apiReq('DELETE', '/api/v1/settings/ai_config', adminToken);
      assert.equal(resetAi.status, 200);
      assert.equal(resetAi.body.default_value.enabled, true);
      assert.equal(resetAi.body.default_value.model, 'gemini-3.8-flash');

      // Subsequent GET /api/v1/settings returns defaults for deleted keys
      const getAfterReset = await apiReq('GET', '/api/v1/settings', adminToken);
      assert.equal(getAfterReset.status, 200);
      assert.equal(getAfterReset.body.data.sla_config.response_hours, 2);
      assert.equal(getAfterReset.body.data.ai_config.enabled, true);
      assert.equal(getAfterReset.body.data.ai_config.model, 'gemini-3.8-flash');

      const auditReset = await adminPool.query(
        `SELECT 1 FROM audit_log
         WHERE entity = 'system_setting' AND entity_id = $1 AND action = 'RESET_SETTING'
         ORDER BY id DESC LIMIT 1`,
        [orgId]
      );
      assert.equal(auditReset.rows.length, 1);
    } finally {
      if (savedAiRow) {
        await adminPool
          .query(
            `INSERT INTO system_setting (org_id, key, value, description, updated_by, updated_at)
             VALUES ($1, 'ai_config', $2, $3, $4, NOW())
             ON CONFLICT (org_id, key) DO UPDATE
               SET value = EXCLUDED.value,
                   description = EXCLUDED.description,
                   updated_by = EXCLUDED.updated_by,
                   updated_at = NOW()`,
            [orgId, JSON.stringify(savedAiRow.value), savedAiRow.description, savedAiRow.updated_by]
          )
          .catch(() => {});
      }
    }
  });
});
