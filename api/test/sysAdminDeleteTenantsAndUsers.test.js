import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import express from 'express';
import jwt from 'jsonwebtoken';
import { JWT_SECRET } from '../src/config/env.js';
import { pool, adminPool, appPool } from '../src/db/client.js';
import tenantsRoute from '../src/routes/tenants.js';
import adminUsersRoute from '../src/routes/admin/users.js';

// 1x1 transparent PNG base64
const TINY_PNG_BASE64 =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

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

test('SYS_ADMIN Delete — Tenants & CCCD Images (M04) + Users & Roles (M01)', async (t) => {
  let server;
  let baseUrl;
  let orgId;
  let sysAdminId;
  let mgrUserId;
  let mgrPersonId;
  let testBuildingId;
  let testApartmentId;
  const cleanupPersonIds = new Set();

  t.before(async () => {
    const orgRes = await adminPool.query('SELECT id FROM organization ORDER BY created_at ASC LIMIT 1');
    assert.ok(orgRes.rows.length > 0);
    orgId = orgRes.rows[0].id;

    const adminRes = await adminPool.query(
      `SELECT u.id, u.person_id FROM app_user u
       JOIN user_role ur ON ur.user_id = u.id
       JOIN role r ON r.id = ur.role_id
       WHERE r.org_id = $1 AND r.code = 'SYS_ADMIN' AND u.status = 'ACTIVE'
       LIMIT 1`,
      [orgId]
    );
    assert.ok(adminRes.rows.length > 0);
    sysAdminId = adminRes.rows[0].id;

    const mgrRes = await adminPool.query(
      `SELECT u.id, u.person_id FROM app_user u
       JOIN user_role ur ON ur.user_id = u.id
       JOIN role r ON r.id = ur.role_id
       WHERE r.org_id = $1 AND r.code = 'MANAGER' AND u.status = 'ACTIVE'
       LIMIT 1`,
      [orgId]
    );
    assert.ok(mgrRes.rows.length > 0);
    mgrUserId = mgrRes.rows[0].id;
    mgrPersonId = mgrRes.rows[0].person_id;

    testBuildingId = crypto.randomUUID();
    testApartmentId = crypto.randomUUID();
    await adminPool.query(
      `INSERT INTO building (id, org_id, name, code, status)
       VALUES ($1, $2, 'Tòa Test Tenant/User Delete', $3, 'ACTIVE')`,
      [testBuildingId, orgId, `TTU-${Date.now().toString(36).slice(-6)}`]
    );
    await adminPool.query(
      `INSERT INTO apartment (id, building_id, code, status)
       VALUES ($1, $2, 'TU-101', 'AVAILABLE')`,
      [testApartmentId, testBuildingId]
    );

    const app = express();
    app.use(express.json({ limit: '5mb' }));
    app.use('/api/v1/tenants', tenantsRoute);
    app.use('/api/v1/admin/users', adminUsersRoute);

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
    await adminPool.query('DELETE FROM building WHERE id = $1', [testBuildingId]).catch(() => {});
    for (const pid of cleanupPersonIds) {
      const client = await adminPool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`SELECT set_config('app.allow_test_cleanup', 'true', true)`);
        await client.query('DELETE FROM audit_log WHERE actor_id IN (SELECT id FROM app_user WHERE person_id = $1)', [pid]);
        await client.query('DELETE FROM owner WHERE person_id = $1', [pid]);
        await client.query('DELETE FROM person WHERE id = $1', [pid]);
        await client.query('COMMIT');
      } catch {
        await client.query('ROLLBACK').catch(() => {});
      } finally {
        client.release();
      }
    }
    await Promise.allSettled([pool.end(), appPool.end(), adminPool.end()]);
  });

  async function apiReq(method, path, token, body) {
    const headers = { Authorization: `Bearer ${token}` };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const resp = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const json = await resp.json().catch(() => ({}));
    return { status: resp.status, body: json };
  }

  await t.test('1. Tenant & CCCD Image Delete: MANAGER 403, CCCD delete, companion RESIDENT + person cleanup freeing Phone/CCCD, reservation block, shared internal person preserved', async () => {
    const adminToken = signToken({ sub: sysAdminId, orgId, role: 'SYS_ADMIN' });
    const mgrToken = signToken({ sub: mgrUserId, orgId, role: 'MANAGER', personId: mgrPersonId });

    const uniqueSuffix = String(Date.now()).slice(-7);
    const phone = `098${uniqueSuffix}`;
    const idNumber = `07909${uniqueSuffix}`;

    const createRes = await apiReq('POST', '/api/v1/tenants', adminToken, {
      full_name: 'Cư Dân Nhập Nhầm',
      phone,
      id_number: idNumber,
      email: `mistake.${uniqueSuffix}@test.local`,
    });
    assert.equal(createRes.status, 201, JSON.stringify(createRes.body));
    const tenantId = createRes.body.data.id;
    const personId = createRes.body.data.person_id;
    cleanupPersonIds.add(personId);

    // Verify ensureResidentAccount created an app_user(RESIDENT)
    const uBefore = await adminPool.query('SELECT COUNT(*)::int AS cnt FROM app_user WHERE person_id = $1', [personId]);
    assert.equal(uBefore.rows[0].cnt, 1);

    // Upload a CCCD image
    const uploadRes = await apiReq('POST', `/api/v1/tenants/${tenantId}/id-images`, adminToken, {
      side: 'front',
      image_base64: TINY_PNG_BASE64,
    });
    assert.equal(uploadRes.status, 201);
    const attId = uploadRes.body.data.attachment_id;

    // MANAGER cannot delete CCCD image or tenant -> 403 DELETE_PROHIBITED
    const mgrDelImg = await apiReq('DELETE', `/api/v1/tenants/${tenantId}/id-images/${attId}`, mgrToken);
    assert.equal(mgrDelImg.status, 403);
    assert.equal(mgrDelImg.body.code, 'DELETE_PROHIBITED');

    const mgrDelTenant = await apiReq('DELETE', `/api/v1/tenants/${tenantId}`, mgrToken);
    assert.equal(mgrDelTenant.status, 403);
    assert.equal(mgrDelTenant.body.code, 'DELETE_PROHIBITED');

    // SYS_ADMIN deletes CCCD image -> 200 & list is empty
    const adminDelImg = await apiReq('DELETE', `/api/v1/tenants/${tenantId}/id-images/${attId}`, adminToken);
    assert.equal(adminDelImg.status, 200);
    const listImgs = await apiReq('GET', `/api/v1/tenants/${tenantId}/id-images`, adminToken);
    assert.equal(listImgs.body.data.length, 0);

    // Add a phone-linked reservation -> must block DELETE /api/v1/tenants/:id with 409 TENANT_HAS_HISTORY
    const rsvId = crypto.randomUUID();
    await adminPool.query(
      `INSERT INTO reservation (id, org_id, building_id, apartment_id, prospect_name, phone, hold_amount, status)
       VALUES ($1, $2, $3, $4, 'Cư Dân Nhập Nhầm', $5, 2000000, 'EXPIRED')`,
      [rsvId, orgId, testBuildingId, testApartmentId, phone]
    );
    const blockedByRsv = await apiReq('DELETE', `/api/v1/tenants/${tenantId}`, adminToken);
    assert.equal(blockedByRsv.status, 409);
    assert.equal(blockedByRsv.body.code, 'TENANT_HAS_HISTORY');
    await adminPool.query('DELETE FROM reservation WHERE id = $1', [rsvId]);

    // SYS_ADMIN deletes tenant -> deletes tenant + auto-provisioned RESIDENT user + person!
    const delTenant = await apiReq('DELETE', `/api/v1/tenants/${tenantId}`, adminToken);
    assert.equal(delTenant.status, 200, JSON.stringify(delTenant.body));
    assert.equal(delTenant.body.person_deleted, true);
    assert.equal(delTenant.body.resident_user_deleted, true);

    // Re-creating tenant with identical phone + id_number succeeds 201 (unique indexes freed!)
    const recreateRes = await apiReq('POST', '/api/v1/tenants', adminToken, {
      full_name: 'Cư Dân Nhập Lại Chuẩn',
      phone,
      id_number: idNumber,
    });
    assert.equal(recreateRes.status, 201, JSON.stringify(recreateRes.body));
    cleanupPersonIds.add(recreateRes.body.data.person_id);

    // Cross-org SYS_ADMIN cannot delete tenant in orgId -> 404 & row survives
    const foreignOrgId = crypto.randomUUID();
    const foreignAdminToken = signToken({ sub: crypto.randomUUID(), orgId: foreignOrgId, role: 'SYS_ADMIN' });
    const crossOrgTenantDel = await apiReq('DELETE', `/api/v1/tenants/${recreateRes.body.data.id}`, foreignAdminToken);
    assert.equal(crossOrgTenantDel.status, 404);

    // Upload CCCD image onto recreated tenant, then delete tenant WITH active attachment -> cleans up attachment under RLS!
    const uploadOnRecreated = await apiReq('POST', `/api/v1/tenants/${recreateRes.body.data.id}/id-images`, adminToken, {
      side: 'back',
      image_base64: TINY_PNG_BASE64,
    });
    assert.equal(uploadOnRecreated.status, 201);
    const recreatedAttId = uploadOnRecreated.body.data.attachment_id;

    const cleanupRecreated = await apiReq('DELETE', `/api/v1/tenants/${recreateRes.body.data.id}`, adminToken);
    assert.equal(cleanupRecreated.status, 200);
    const attAfterTenantDel = await adminPool.query('SELECT 1 FROM attachment WHERE id = $1', [recreatedAttId]);
    assert.equal(attAfterTenantDel.rows.length, 0);

    // Shared internal person test: attach a temporary tenant row to mgrPersonId
    const sharedTenantId = crypto.randomUUID();
    await adminPool.query(
      `INSERT INTO tenant (id, person_id, org_id, type, status)
       VALUES ($1, $2, $3, 'occupant', 'PENDING')`,
      [sharedTenantId, mgrPersonId, orgId]
    );
    const delSharedTenant = await apiReq('DELETE', `/api/v1/tenants/${sharedTenantId}`, adminToken);
    assert.equal(delSharedTenant.status, 200);
    assert.equal(delSharedTenant.body.person_deleted, false);
    assert.equal(delSharedTenant.body.resident_user_deleted, false);

    // Verify MANAGER user & person still exist!
    const mgrStillAlive = await adminPool.query('SELECT 1 FROM app_user WHERE id = $1', [mgrUserId]);
    assert.equal(mgrStillAlive.rows.length, 1);
  });

  await t.test('2. Admin User Delete & Role Protection: MANAGER 403, self-delete/self-demote 409, OWNER user cleanup vs building/audit history 409', async () => {
    const adminToken = signToken({ sub: sysAdminId, orgId, role: 'SYS_ADMIN' });
    const mgrToken = signToken({ sub: mgrUserId, orgId, role: 'MANAGER' });

    const suffix = String(Date.now()).slice(-7);
    const email = `owner.mistake.${suffix}@test.local`;
    const phone = `097${suffix}`;

    // Self-delete prohibited -> 409
    const selfDel = await apiReq('DELETE', `/api/v1/admin/users/${sysAdminId}`, adminToken);
    assert.equal(selfDel.status, 409);
    assert.equal(selfDel.body.code, 'SELF_DELETE_PROHIBITED');

    // Self-suspension via PATCH prohibited -> 409
    const selfLock = await apiReq('PATCH', `/api/v1/admin/users/${sysAdminId}`, adminToken, {
      status: 'SUSPENDED',
    });
    assert.equal(selfLock.status, 409);
    assert.equal(selfLock.body.code, 'SELF_LOCK_PROHIBITED');

    // Self-removal of SYS_ADMIN role via PATCH prohibited -> 409
    const selfDemote = await apiReq('PATCH', `/api/v1/admin/users/${sysAdminId}`, adminToken, {
      roles: [{ role_code: 'MANAGER', building_id: testBuildingId }],
    });
    assert.equal(selfDemote.status, 409);

    // Create mistaken OWNER user (also inserts into owner table)
    const createOwnerUser = await apiReq('POST', '/api/v1/admin/users', adminToken, {
      full_name: 'Chủ Đầu Tư Nhập Nhầm',
      email,
      phone,
      password: 'Password123!',
      roles: [{ role_code: 'OWNER', building_id: null }],
    });
    assert.equal(createOwnerUser.status, 201, JSON.stringify(createOwnerUser.body));
    const ownerUserId = createOwnerUser.body.data.id;
    const ownerPersonId = createOwnerUser.body.data.person_id;
    cleanupPersonIds.add(ownerPersonId);

    // MANAGER cannot delete user -> 403
    const mgrDelUser = await apiReq('DELETE', `/api/v1/admin/users/${ownerUserId}`, mgrToken);
    assert.equal(mgrDelUser.status, 403);

    // Assign owner to testBuilding -> must block DELETE with 409 USER_HAS_HISTORY
    const ownRowRes = await adminPool.query('SELECT id FROM owner WHERE person_id = $1 AND org_id = $2', [
      ownerPersonId,
      orgId,
    ]);
    assert.equal(ownRowRes.rows.length, 1);
    const ownerRecordId = ownRowRes.rows[0].id;
    await adminPool.query('UPDATE building SET owner_id = $1 WHERE id = $2', [ownerRecordId, testBuildingId]);

    const blockedOwnerDel = await apiReq('DELETE', `/api/v1/admin/users/${ownerUserId}`, adminToken);
    assert.equal(blockedOwnerDel.status, 409);
    assert.equal(blockedOwnerDel.body.code, 'USER_HAS_HISTORY');

    // Unassign owner from building -> DELETE cleans up app_user + owner + person!
    await adminPool.query('UPDATE building SET owner_id = NULL WHERE id = $1', [testBuildingId]);
    const okOwnerDel = await apiReq('DELETE', `/api/v1/admin/users/${ownerUserId}`, adminToken);
    assert.equal(okOwnerDel.status, 200, JSON.stringify(okOwnerDel.body));
    assert.equal(okOwnerDel.body.owner_deleted, true);
    assert.equal(okOwnerDel.body.person_deleted, true);

    // Re-create user with same email + phone -> 201!
    const recreateUser = await apiReq('POST', '/api/v1/admin/users', adminToken, {
      full_name: 'Nhân Sự Tạo Lại',
      email,
      phone,
      password: 'Password123!',
      roles: [{ role_code: 'MANAGER', building_id: testBuildingId }],
    });
    assert.equal(recreateUser.status, 201, JSON.stringify(recreateUser.body));
    const recreatedUserId = recreateUser.body.data.id;
    cleanupPersonIds.add(recreateUser.body.data.person_id);

    // Cross-org SYS_ADMIN cannot delete user in orgId -> 404 & user survives
    const foreignAdminToken = signToken({ sub: crypto.randomUUID(), orgId: crypto.randomUUID(), role: 'SYS_ADMIN' });
    const crossOrgUserDel = await apiReq('DELETE', `/api/v1/admin/users/${recreatedUserId}`, foreignAdminToken);
    assert.equal(crossOrgUserDel.status, 404);

    // Stripping all roles (roles: []) on a non-self user via PATCH succeeds 200
    const stripRolesRes = await apiReq('PATCH', `/api/v1/admin/users/${recreatedUserId}`, adminToken, {
      roles: [],
    });
    assert.equal(stripRolesRes.status, 200, JSON.stringify(stripRolesRes.body));
    const remainingRoles = await adminPool.query('SELECT COUNT(*)::int AS cnt FROM user_role WHERE user_id = $1', [
      recreatedUserId,
    ]);
    assert.equal(remainingRoles.rows[0].cnt, 0);

    // Insert 1 audit_log entry with actor_id = recreatedUserId -> must block with 409 USER_HAS_HISTORY (never crash 500 on immutable audit_log trigger!)
    await adminPool.query(
      `INSERT INTO audit_log (actor_id, action, entity, entity_id, after)
       VALUES ($1, 'ACCESS_DENIED', 'building', $2, '{}'::jsonb)`,
      [recreatedUserId, testBuildingId]
    );
    const blockedByAudit = await apiReq('DELETE', `/api/v1/admin/users/${recreatedUserId}`, adminToken);
    assert.equal(blockedByAudit.status, 409);
    assert.equal(blockedByAudit.body.code, 'USER_HAS_HISTORY');
  });
});
