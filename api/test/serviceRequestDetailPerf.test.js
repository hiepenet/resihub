import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import express from 'express';
import jwt from 'jsonwebtoken';
import { JWT_SECRET } from '../src/config/env.js';
import { pool, adminPool, appPool } from '../src/db/client.js';
import serviceRequestsRoute from '../src/routes/service-requests.js';

function signToken({ sub, orgId, role }) {
  return jwt.sign({ sub, org_id: orgId, role, roles: [role] }, JWT_SECRET, { expiresIn: '1h' });
}

test('GET /api/v1/service-requests/:id — responds under 500ms under RLS with audit_timeline actor names', async (t) => {
  let server;
  let baseUrl;
  let orgId;
  let assignedMgrId;
  let assignedMgrName;
  let otherMgrId;
  let testBuildingId;
  let testSrId;

  t.before(async () => {
    const orgRes = await adminPool.query('SELECT id FROM organization ORDER BY created_at ASC LIMIT 1');
    orgId = orgRes.rows[0].id;

    const mgrRes = await adminPool.query(
      `SELECT DISTINCT u.id, p.full_name
       FROM app_user u
       JOIN person p ON p.id = u.person_id
       JOIN user_role ur ON ur.user_id = u.id
       JOIN role r ON r.id = ur.role_id
       WHERE r.org_id = $1 AND r.code = 'MANAGER'
       ORDER BY u.id ASC
       LIMIT 2`,
      [orgId]
    );
    assert.ok(mgrRes.rows.length >= 2, 'Need at least 2 MANAGER users');
    assignedMgrId = mgrRes.rows[0].id;
    assignedMgrName = mgrRes.rows[0].full_name;
    otherMgrId = mgrRes.rows[1].id;

    await adminPool.query(`DELETE FROM building WHERE code LIKE 'TSRP-%'`);

    testBuildingId = crypto.randomUUID();
    const bCode = `TSRP-${Date.now().toString(36).toUpperCase().slice(-6)}`;
    await adminPool.query(
      `INSERT INTO building (id, org_id, name, code, address, status)
       VALUES ($1, $2, 'Tòa kiểm thử SR Detail Perf', $3, '123 Perf St', 'ACTIVE')`,
      [testBuildingId, orgId, bCode]
    );

    const mgrRoleRes = await adminPool.query(
      `SELECT id FROM role WHERE org_id = $1 AND code = 'MANAGER' LIMIT 1`,
      [orgId]
    );
    await adminPool.query(
      `INSERT INTO user_role (user_id, role_id, building_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [assignedMgrId, mgrRoleRes.rows[0].id, testBuildingId]
    );

    const floorRes = await adminPool.query(
      `INSERT INTO floor (building_id, level, name) VALUES ($1, 1, 'Tầng 1') RETURNING id`,
      [testBuildingId]
    );
    const aptRes = await adminPool.query(
      `INSERT INTO apartment (building_id, floor_id, code, area_m2, type, bedrooms, base_rent, status)
       VALUES ($1, $2, 'P101', 45, '1PN', 1, 7000000, 'OCCUPIED')
       RETURNING id`,
      [testBuildingId, floorRes.rows[0].id]
    );

    testSrId = crypto.randomUUID();
    const trackingCode = `SR-PERF-${Date.now().toString().slice(-6)}`;
    await adminPool.query(
      `INSERT INTO service_request (
         id, org_id, building_id, apartment_id, tracking_code,
         category, priority, status, title, description, created_by
       ) VALUES (
         $1, $2, $3, $4, $5,
         'PLUMBING', 'HIGH', 'IN_PROGRESS', 'Rỉ nước bồn rửa', 'Nước rỉ dưới gầm tủ bếp', $6
       )`,
      [testSrId, orgId, testBuildingId, aptRes.rows[0].id, trackingCode, assignedMgrId]
    );

    for (let i = 1; i <= 5; i += 1) {
      await adminPool.query(
        `INSERT INTO audit_log (actor_id, action, entity, entity_id, after)
         VALUES ($1, $2, 'service_request', $3, $4::jsonb)`,
        [
          assignedMgrId,
          i === 1 ? 'CREATE' : 'UPDATE_STATUS',
          testSrId,
          JSON.stringify({ step: i, status: i === 1 ? 'NEW' : 'IN_PROGRESS' }),
        ]
      );
    }

    const app = express();
    app.use(express.json());
    app.use('/api/v1/service-requests', serviceRequestsRoute);

    await new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        baseUrl = `http://127.0.0.1:${server.address().port}`;
        resolve();
      });
    });

    // Warm connection pool once so test measures query plan latency rather than TCP handshake
    const warmToken = signToken({ sub: otherMgrId, orgId, role: 'MANAGER' });
    await fetch(`${baseUrl}/api/v1/service-requests/${testSrId}`, {
      headers: { Authorization: `Bearer ${warmToken}` },
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

  await t.test('Unassigned MANAGER receives 403 ACCESS_DENIED', async () => {
    const token = signToken({ sub: otherMgrId, orgId, role: 'MANAGER' });
    const res = await fetch(`${baseUrl}/api/v1/service-requests/${testSrId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 403);
  });

  await t.test('Assigned MANAGER fetches detail + 5 audit logs in < 500ms with actor_name intact', async () => {
    const token = signToken({ sub: assignedMgrId, orgId, role: 'MANAGER' });
    const t0 = performance.now();
    const res = await fetch(`${baseUrl}/api/v1/service-requests/${testSrId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = await res.json();
    const elapsedMs = performance.now() - t0;

    assert.equal(res.status, 200);
    assert.equal(body.data.id, testSrId);
    assert.ok(body.data.audit_timeline.length >= 5);
    const ownLog = body.data.audit_timeline.find((l) => l.actor_id === assignedMgrId);
    assert.equal(ownLog?.actor_name, assignedMgrName);
    assert.ok(
      Number(body.data.audit_timeline[0].id) >
        Number(body.data.audit_timeline[body.data.audit_timeline.length - 1].id),
      'audit_timeline must be sorted newest id first (DESC)'
    );
    assert.ok(
      elapsedMs < 500,
      `Expected GET /api/v1/service-requests/:id < 500ms, got ${Math.round(elapsedMs)}ms`
    );
  });
});
