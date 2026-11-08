import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import express from 'express';
import jwt from 'jsonwebtoken';
import { JWT_SECRET } from '../src/config/env.js';
import { pool, adminPool, appPool } from '../src/db/client.js';
import buildingsRoute from '../src/routes/buildings.js';
import apartmentsRoute from '../src/routes/apartments.js';

function signToken({ sub, orgId, role }) {
  return jwt.sign(
    {
      sub,
      org_id: orgId,
      role,
      roles: [role],
    },
    JWT_SECRET,
    { expiresIn: '1h' }
  );
}

test('POST /api/v1/buildings/:id/floors/bulk — RBAC, dry_run, atomic commit, conflicts, skip_existing & audit', async (t) => {
  let server;
  let baseUrl;
  let orgId;
  let sysAdminId;
  let assignedMgrId;
  let otherMgrId;
  let ownerUserId;
  let testBuildingId;

  t.before(async () => {
    // Pick existing seeded users from org so RLS policies (app_user + user_role) resolve authentically
    const orgRes = await adminPool.query('SELECT id FROM organization ORDER BY created_at ASC LIMIT 1');
    assert.ok(orgRes.rows.length > 0, 'Cần có ít nhất 1 organization trong DB để chạy integration test');
    orgId = orgRes.rows[0].id;

    const adminRes = await adminPool.query(
      `SELECT u.id FROM app_user u
       JOIN user_role ur ON ur.user_id = u.id
       JOIN role r ON r.id = ur.role_id
       WHERE r.org_id = $1 AND r.code = 'SYS_ADMIN'
       LIMIT 1`,
      [orgId]
    );
    assert.ok(adminRes.rows.length > 0, 'Cần có tài khoản SYS_ADMIN');
    sysAdminId = adminRes.rows[0].id;

    const mgrRes = await adminPool.query(
      `SELECT DISTINCT u.id FROM app_user u
       JOIN user_role ur ON ur.user_id = u.id
       JOIN role r ON r.id = ur.role_id
       WHERE r.org_id = $1 AND r.code = 'MANAGER'
       ORDER BY u.id ASC
       LIMIT 2`,
      [orgId]
    );
    assert.ok(mgrRes.rows.length >= 2, 'Cần có ít nhất 2 tài khoản MANAGER để kiểm tra phân quyền chéo tòa');
    assignedMgrId = mgrRes.rows[0].id;
    otherMgrId = mgrRes.rows[1].id;

    const ownerRes = await adminPool.query(
      `SELECT u.id FROM app_user u
       JOIN user_role ur ON ur.user_id = u.id
       JOIN role r ON r.id = ur.role_id
       WHERE r.org_id = $1 AND r.code = 'OWNER'
       LIMIT 1`,
      [orgId]
    );
    assert.ok(ownerRes.rows.length > 0, 'Cần có tài khoản OWNER');
    ownerUserId = ownerRes.rows[0].id;

    // Clean up any leftover temporary buildings from interrupted runs
    await adminPool.query(`DELETE FROM building WHERE code LIKE 'TBULK-%'`);

    // Create an isolated temporary building and assign ONLY assignedMgrId to it
    testBuildingId = crypto.randomUUID();
    const bCode = `TBULK-${Date.now().toString(36).toUpperCase().slice(-6)}`;
    await adminPool.query(
      `INSERT INTO building (id, org_id, name, code, address, status)
       VALUES ($1, $2, 'Tòa kiểm thử Bulk Floor', $3, '123 Test St', 'ACTIVE')`,
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

    const app = express();
    app.use(express.json());
    app.use('/api/v1/buildings', buildingsRoute);
    app.use('/api/v1/apartments', apartmentsRoute);

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
    if (testBuildingId) {
      await adminPool.query('DELETE FROM building WHERE id = $1', [testBuildingId]).catch(() => {});
    }
    await Promise.allSettled([pool.end(), appPool.end(), adminPool.end()]);
  });

  async function postBulk(buildingId, token, body) {
    const resp = await fetch(`${baseUrl}/api/v1/buildings/${buildingId}/floors/bulk`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
    const json = await resp.json().catch(() => ({}));
    return { status: resp.status, body: json };
  }

  await t.test('1. RBAC: OWNER gets 403 and unassigned MANAGER gets 403 ACCESS_DENIED before payload validation', async () => {
    const ownerToken = signToken({ sub: ownerUserId, orgId, role: 'OWNER' });
    const otherMgrToken = signToken({ sub: otherMgrId, orgId, role: 'MANAGER' });

    const rOwner = await postBulk(testBuildingId, ownerToken, { from_level: 1, to_level: 3 });
    assert.equal(rOwner.status, 403);

    // Unassigned manager sends invalid empty body — must still get 403 ACCESS_DENIED, not 422!
    const rOtherMgr = await postBulk(testBuildingId, otherMgrToken, {});
    assert.equal(rOtherMgr.status, 403);
    assert.equal(rOtherMgr.body.code, 'ACCESS_DENIED');

    const deniedAudit = await adminPool.query(
      `SELECT COUNT(*)::int AS cnt FROM audit_log
       WHERE action = 'ACCESS_DENIED' AND entity = 'building' AND entity_id = $1 AND actor_id = $2`,
      [testBuildingId, otherMgrId]
    );
    assert.ok(deniedAudit.rows[0].cnt >= 1, 'Phải ghi audit_log ACCESS_DENIED cho MANAGER trái thẩm quyền');
  });

  await t.test('2. Non-existent building returns 404', async () => {
    const adminToken = signToken({ sub: sysAdminId, orgId, role: 'SYS_ADMIN' });
    const fakeId = '99999999-9999-4999-8999-999999999999';
    const res = await postBulk(fakeId, adminToken, { from_level: 1, to_level: 3 });
    assert.equal(res.status, 404);
  });

  await t.test('3. Duplicate level in payload returns 422 DUPLICATE_LEVEL_IN_PAYLOAD', async () => {
    const mgrToken = signToken({ sub: assignedMgrId, orgId, role: 'MANAGER' });
    const res = await postBulk(testBuildingId, mgrToken, {
      floors: [
        { level: 2, name: 'Tầng 2' },
        { level: 2, name: 'Tầng 2B' },
      ],
    });
    assert.equal(res.status, 422);
    assert.equal(res.body.code, 'DUPLICATE_LEVEL_IN_PAYLOAD');
  });

  await t.test('4. dry_run: true returns preview and writes zero rows / zero audit logs', async () => {
    const mgrToken = signToken({ sub: assignedMgrId, orgId, role: 'MANAGER' });
    const res = await postBulk(testBuildingId, mgrToken, {
      from_level: -1,
      to_level: 2,
      include_zero: false,
      dry_run: true,
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.valid, true);
    assert.equal(res.body.total, 3);
    assert.deepEqual(
      res.body.data.map((f) => ({ level: f.level, name: f.name })),
      [
        { level: -1, name: 'Tầng hầm B1' },
        { level: 1, name: 'Tầng 1' },
        { level: 2, name: 'Tầng 2' },
      ]
    );

    const dbCount = await adminPool.query(
      'SELECT COUNT(*)::int AS cnt FROM floor WHERE building_id = $1',
      [testBuildingId]
    );
    assert.equal(dbCount.rows[0].cnt, 0);

    const dryAuditCount = await adminPool.query(
      `SELECT COUNT(*)::int AS cnt FROM audit_log
       WHERE entity = 'floor' AND action = 'CREATE' AND (after->>'building_id') = $1`,
      [testBuildingId]
    );
    assert.equal(dryAuditCount.rows[0].cnt, 0);
  });

  await t.test('5. Commit creates floors atomically under RLS and writes audit_log per floor', async () => {
    const mgrToken = signToken({ sub: assignedMgrId, orgId, role: 'MANAGER' });
    const res = await postBulk(testBuildingId, mgrToken, {
      floors: [
        { level: -1 },
        { level: 1 },
        { level: 2 },
        { level: 3, name: 'Tầng 3A' },
      ],
    });

    assert.equal(res.status, 201);
    assert.equal(res.body.created_count, 4);
    assert.equal(res.body.skipped_count, 0);
    assert.deepEqual(
      res.body.data.map((f) => ({ level: f.level, name: f.name })),
      [
        { level: -1, name: 'Tầng hầm B1' },
        { level: 1, name: 'Tầng 1' },
        { level: 2, name: 'Tầng 2' },
        { level: 3, name: 'Tầng 3A' },
      ]
    );

    const auditRes = await adminPool.query(
      `SELECT COUNT(*)::int AS cnt FROM audit_log
       WHERE entity = 'floor' AND action = 'CREATE' AND actor_id = $1
         AND (after->>'building_id') = $2`,
      [assignedMgrId, testBuildingId]
    );
    assert.equal(auditRes.rows[0].cnt, 4);
  });

  await t.test('6. Conflict with skip_existing=false returns 409 FLOOR_EXISTS and inserts nothing', async () => {
    const mgrToken = signToken({ sub: assignedMgrId, orgId, role: 'MANAGER' });
    const res = await postBulk(testBuildingId, mgrToken, {
      from_level: 1,
      to_level: 5,
      skip_existing: false,
    });

    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'FLOOR_EXISTS');
    assert.deepEqual(
      res.body.conflicts.map((c) => c.level),
      [1, 2, 3]
    );

    const dbCount = await adminPool.query(
      'SELECT COUNT(*)::int AS cnt FROM floor WHERE building_id = $1',
      [testBuildingId]
    );
    assert.equal(dbCount.rows[0].cnt, 4);
  });

  await t.test('7. skip_existing=true creates only missing floors, and returns 200 when all already exist', async () => {
    const mgrToken = signToken({ sub: assignedMgrId, orgId, role: 'MANAGER' });
    const res1 = await postBulk(testBuildingId, mgrToken, {
      from_level: 1,
      to_level: 5,
      skip_existing: true,
    });

    assert.equal(res1.status, 201);
    assert.equal(res1.body.created_count, 2);
    assert.equal(res1.body.skipped_count, 3);
    assert.deepEqual(
      res1.body.data.map((f) => f.level),
      [4, 5]
    );

    const res2 = await postBulk(testBuildingId, mgrToken, {
      from_level: 1,
      to_level: 5,
      skip_existing: true,
    });
    assert.equal(res2.status, 200);
    assert.equal(res2.body.created_count, 0);
    assert.equal(res2.body.skipped_count, 5);
  });

  await t.test('8. GET /api/v1/buildings/:id/floor-map returns floors ordered from lowest to highest level (ASC)', async () => {
    const mgrToken = signToken({ sub: assignedMgrId, orgId, role: 'MANAGER' });
    await postBulk(testBuildingId, mgrToken, {
      floors: [{ level: 13 }],
    });

    const res = await fetch(`${baseUrl}/api/v1/buildings/${testBuildingId}/floor-map`, {
      headers: { Authorization: `Bearer ${mgrToken}` },
    });
    const body = await res.json();

    assert.equal(res.status, 200);
    assert.deepEqual(
      body.data.map((f) => f.level),
      [-1, 1, 2, 3, 4, 5, 13]
    );
  });

  await t.test('9. GET /api/v1/apartments orders apartments from lowest floor level to highest (e.g. level 2 before level 13)', async () => {
    const mgrToken = signToken({ sub: assignedMgrId, orgId, role: 'MANAGER' });
    const floorsRes = await adminPool.query(
      'SELECT id, level FROM floor WHERE building_id = $1 AND level IN (2, 13)',
      [testBuildingId]
    );
    const byLvl = new Map(floorsRes.rows.map((r) => [Number(r.level), r.id]));

    await adminPool.query(
      `INSERT INTO apartment (building_id, floor_id, code, area_m2, type, bedrooms, base_rent, status)
       VALUES
         ($1, $2, 'A1301', 45, '1PN', 1, 8000000, 'AVAILABLE'),
         ($1, $3, 'A201', 45, '1PN', 1, 7000000, 'AVAILABLE')`,
      [testBuildingId, byLvl.get(13), byLvl.get(2)]
    );

    const res = await fetch(`${baseUrl}/api/v1/apartments?building_id=${testBuildingId}`, {
      headers: { Authorization: `Bearer ${mgrToken}` },
    });
    const body = await res.json();

    assert.equal(res.status, 200);
    assert.deepEqual(
      body.data.map((a) => ({ code: a.code, floor_level: a.floor_level })),
      [
        { code: 'A201', floor_level: 2 },
        { code: 'A1301', floor_level: 13 },
      ]
    );
  });
});
