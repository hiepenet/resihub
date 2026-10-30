import { test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const API_BASE = process.env.TEST_API_BASE || 'http://127.0.0.1:5000';
const ADMIN_DB_URL =
  process.env.DATABASE_URL ||
  'postgres://postgres:postgres@127.0.0.1:5433/resihub';
const APP_DB_URL =
  process.env.APP_DATABASE_URL ||
  'postgres://resihub_app:resihub_app_secret@127.0.0.1:5433/resihub';

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
  const body = await res.json();
  return { status: res.status, body };
}

test('Security & Privacy Audit — Owner Lookup Confidentiality & Cross-Building Resident PII Isolation', async (t) => {
  let healthOk = false;
  try {
    const h = await fetch(`${API_BASE}/api/health`);
    healthOk = h.ok;
  } catch {
    healthOk = false;
  }
  if (!healthOk) {
    t.skip('API server not reachable');
    return;
  }

  const adminPool = new pg.Pool({ connectionString: ADMIN_DB_URL });
  const appPool = new pg.Pool({ connectionString: APP_DB_URL });

  const createdBuildingIds = [];
  const createdPersonIds = [];

  t.after(async () => {
    for (const bId of createdBuildingIds) {
      await adminPool.query('DELETE FROM user_role WHERE building_id = $1', [bId]);
      await adminPool.query('DELETE FROM building WHERE id = $1', [bId]);
    }
    for (const pId of createdPersonIds) {
      await adminPool.query(
        'DELETE FROM user_role WHERE user_id IN (SELECT id FROM app_user WHERE person_id = $1)',
        [pId]
      );
      await adminPool.query('DELETE FROM app_user WHERE person_id = $1', [pId]);
      await adminPool.query('DELETE FROM tenant WHERE person_id = $1', [pId]);
      await adminPool.query('DELETE FROM person WHERE id = $1', [pId]);
    }
    await adminPool.end();
    await appPool.end();
  });

  await t.test('1. Owner Confidentiality: RLS blocks MANAGER SELECT on owner; lookup-owner validates & masks PII', async () => {
    const mgrA = await login('manager.vop.a@resihub.vn', 'Demo@123456');

    // 1.1 Public list /api/v1/buildings/owners MUST return 403 for MANAGER
    const listRes = await apiFetch('/api/v1/buildings/owners', mgrA.token);
    assert.equal(listRes.status, 403, 'MANAGER must receive 403 on /api/v1/buildings/owners');

    // 1.2 PostgreSQL RLS: direct SELECT on owner as MANAGER returns 0 rows
    const rlsClient = await appPool.connect();
    try {
      await rlsClient.query(`SELECT set_config('app.current_user_id', $1, false)`, [mgrA.user.id]);
      const rlsOwn = await rlsClient.query('SELECT * FROM owner');
      assert.equal(rlsOwn.rows.length, 0, 'PostgreSQL RLS on owner must return 0 rows for MANAGER');
    } finally {
      await rlsClient.query('RESET app.current_user_id').catch(() => {});
      rlsClient.release();
    }

    // 1.3 Invalid email & phone formats -> 422
    const badEmail = await apiFetch('/api/v1/buildings/lookup-owner?identifier=sai-email@khongcocham', mgrA.token);
    assert.equal(badEmail.status, 422);
    assert.equal(badEmail.body.code, 'INVALID_EMAIL_FORMAT');

    const badPhone = await apiFetch('/api/v1/buildings/lookup-owner?identifier=09123', mgrA.token);
    assert.equal(badPhone.status, 422);
    assert.equal(badPhone.body.code, 'INVALID_PHONE_FORMAT');

    // 1.4 Unknown email -> 200 found: false
    const notFound = await apiFetch('/api/v1/buildings/lookup-owner?identifier=khongtontai.cdt@resihub.vn', mgrA.token);
    assert.equal(notFound.status, 200);
    assert.equal(notFound.body.found, false);
    assert.equal(notFound.body.owner, null);

    // 1.5 Exact owner email & phone -> 200 found: true, masked PII only (no raw email/phone)
    const ownerDb = await adminPool.query(
      "SELECT id, full_name, email, phone FROM owner WHERE LOWER(email) = 'owner.vop@resihub.vn' LIMIT 1"
    );
    assert.equal(ownerDb.rows.length, 1);
    const realOwner = ownerDb.rows[0];

    const byEmail = await apiFetch('/api/v1/buildings/lookup-owner?identifier=owner.vop@resihub.vn', mgrA.token);
    assert.equal(byEmail.status, 200);
    assert.equal(byEmail.body.found, true);
    assert.equal(byEmail.body.owner.id, realOwner.id);
    assert.equal(byEmail.body.owner.email, undefined, 'Must not expose raw email');
    assert.equal(byEmail.body.owner.phone, undefined, 'Must not expose raw phone');
    assert.equal(byEmail.body.owner.full_name, undefined, 'Must not expose raw full_name');
    assert.ok(byEmail.body.owner.masked_email.includes('***'));
    assert.ok(byEmail.body.owner.masked_phone.includes('****'));

    if (realOwner.phone) {
      const byPhone = await apiFetch(
        `/api/v1/buildings/lookup-owner?identifier=${encodeURIComponent(realOwner.phone)}`,
        mgrA.token
      );
      assert.equal(byPhone.status, 200);
      assert.equal(byPhone.body.found, true);
      assert.equal(byPhone.body.owner.id, realOwner.id);
    }

    // 1.6 Building create without owner -> attach owner once -> block changing existing owner by MANAGER
    const otherOwnerDb = await adminPool.query(
      'SELECT id FROM owner WHERE id <> $1 LIMIT 1',
      [realOwner.id]
    );
    const secondOwnerId = otherOwnerDb.rows[0]?.id;

    const code = `PRV-${Date.now().toString().slice(-6)}`;
    let bId = null;
    try {
      const createRes = await apiFetch('/api/v1/buildings', mgrA.token, {
        method: 'POST',
        body: JSON.stringify({
          name: 'Tòa Kiểm Thử Bảo Mật Owner',
          code,
          address: '88 Đường Bảo Mật',
        }),
      });
      assert.equal(createRes.status, 201);
      bId = createRes.body.data.id;
      assert.equal(createRes.body.data.owner_id, null);

      // Attach owner when currently null -> 200 OK
      const attachRes = await apiFetch(`/api/v1/buildings/${bId}`, mgrA.token, {
        method: 'PATCH',
        body: JSON.stringify({ owner_id: realOwner.id }),
      });
      assert.equal(attachRes.status, 200);
      assert.equal(attachRes.body.data.owner_id, realOwner.id);

      // Attempt to change or clear owner once already set -> 403 FORBIDDEN_OWNER_CHANGE
      if (secondOwnerId) {
        const hijackRes = await apiFetch(`/api/v1/buildings/${bId}`, mgrA.token, {
          method: 'PATCH',
          body: JSON.stringify({ owner_id: secondOwnerId }),
        });
        assert.equal(hijackRes.status, 403);
        assert.equal(hijackRes.body.code, 'FORBIDDEN_OWNER_CHANGE');
      }
    } finally {
      if (bId) {
        await adminPool.query('DELETE FROM user_role WHERE building_id = $1', [bId]);
        await adminPool.query('DELETE FROM building WHERE id = $1', [bId]);
      }
    }
  });

  await t.test('2. Resident PII Confidentiality: Cross-building isolation on uncontracted tenants, lookup & check-dup', async () => {
    const mgrA = await login('manager.vop.a@resihub.vn', 'Demo@123456');

    // Find another manager from a different building (e.g. VOP-B or VSC-A)
    const otherMgrDb = await adminPool.query(
      `SELECT p.email
       FROM app_user au
       JOIN person p ON p.id = au.person_id
       JOIN user_role ur ON ur.user_id = au.id
       JOIN role r ON r.id = ur.role_id
       WHERE r.code = 'MANAGER' AND LOWER(p.email) <> 'manager.vop.a@resihub.vn'
       ORDER BY p.email ASC
       LIMIT 1`
    );
    assert.equal(otherMgrDb.rows.length, 1);
    const mgrB = await login(otherMgrDb.rows[0].email, 'Demo@123456');

    // Clean up test phone/cccd if leftover
    const secretPhone = '0968887766';
    const secretCccd = '001200998877';
    await adminPool.query(
      'DELETE FROM tenant WHERE person_id IN (SELECT id FROM person WHERE phone = $1 OR id_number = $2)',
      [secretPhone, secretCccd]
    );
    await adminPool.query('DELETE FROM person WHERE phone = $1 OR id_number = $2', [secretPhone, secretCccd]);

    // 2.1 Manager A creates an uncontracted resident
    const createTenantA = await apiFetch('/api/v1/tenants', mgrA.token, {
      method: 'POST',
      body: JSON.stringify({
        full_name: 'Trần Bảo Mật Nội Bộ A',
        phone: secretPhone,
        id_number: secretCccd,
      }),
    });
    assert.equal(createTenantA.status, 201);
    const tenantIdA = createTenantA.body.data.id;
    createdPersonIds.push(createTenantA.body.data.person_id);

    // 2.2 Manager A CAN lookup & see masked preview; raw CCCD/phone NOT returned
    const lookupByMgrA = await apiFetch(`/api/v1/tenants/lookup?identifier=${secretPhone}`, mgrA.token);
    assert.equal(lookupByMgrA.status, 200);
    assert.equal(lookupByMgrA.body.found, true);
    assert.equal(lookupByMgrA.body.tenant.id, tenantIdA);
    assert.ok(lookupByMgrA.body.tenant.masked_phone.includes('****'));
    assert.ok(lookupByMgrA.body.tenant.masked_id_number.includes('****'));
    assert.equal(lookupByMgrA.body.tenant.phone, undefined);
    assert.equal(lookupByMgrA.body.tenant.id_number, undefined);

    // 2.3 Manager B MUST NOT see Manager A's uncontracted resident in GET /api/v1/tenants or PostgreSQL RLS
    const listMgrB = await apiFetch('/api/v1/tenants', mgrB.token);
    assert.equal(listMgrB.status, 200);
    assert.equal(
      listMgrB.body.data.some((t) => t.id === tenantIdA),
      false,
      'Uncontracted tenant created by Manager A must NOT leak to Manager B'
    );

    const rlsClientB = await appPool.connect();
    try {
      await rlsClientB.query(`SELECT set_config('app.current_user_id', $1, false)`, [mgrB.user.id]);
      const rlsTenB = await rlsClientB.query('SELECT * FROM tenant WHERE id = $1', [tenantIdA]);
      assert.equal(rlsTenB.rows.length, 0, 'RLS on tenant must block Manager B from reading Manager A uncontracted tenant');
    } finally {
      await rlsClientB.query('RESET app.current_user_id').catch(() => {});
      rlsClientB.release();
    }

    // 2.4 Manager B looking up secretCccd via Know-Before-You-Link gets ONLY masked preview (cross_building_link: true) & ZERO raw PII!
    const lookupByMgrB = await apiFetch(`/api/v1/tenants/lookup?identifier=${secretCccd}`, mgrB.token);
    assert.equal(lookupByMgrB.status, 200);
    assert.equal(lookupByMgrB.body.found, true);
    assert.equal(lookupByMgrB.body.cross_building_link, true);
    assert.equal(lookupByMgrB.body.tenant?.id, tenantIdA);
    assert.equal(lookupByMgrB.body.tenant?.cross_building_link, true);
    assert.equal(lookupByMgrB.body.tenant?.full_name, undefined);
    assert.equal(lookupByMgrB.body.tenant?.phone, undefined);
    assert.equal(lookupByMgrB.body.tenant?.id_number, undefined);
    assert.ok(lookupByMgrB.body.tenant?.masked_name?.includes('*'));
    assert.doesNotMatch(JSON.stringify(lookupByMgrB.body), /Trần Bảo Mật/);

    // 2.4a Internal staff / OWNER phones MUST NEVER be linkable as tenants
    const ownerPhoneRow = await adminPool.query(
      `SELECT p.phone FROM person p JOIN owner o ON o.person_id = p.id WHERE p.phone IS NOT NULL LIMIT 1`
    );
    if (ownerPhoneRow.rows[0]?.phone) {
      const lookupOwnerAsTenant = await apiFetch(
        `/api/v1/tenants/lookup?identifier=${encodeURIComponent(ownerPhoneRow.rows[0].phone)}`,
        mgrB.token
      );
      assert.equal(lookupOwnerAsTenant.status, 200);
      assert.equal(lookupOwnerAsTenant.body.found, false);
    }

    const checkDupByMgrB = await apiFetch(`/api/v1/tenants/check-dup?phone=${secretPhone}`, mgrB.token);
    assert.equal(checkDupByMgrB.status, 200);
    assert.equal(checkDupByMgrB.body.isDuplicate, true);
    assert.equal(checkDupByMgrB.body.inScope, false);
    assert.equal(checkDupByMgrB.body.canLinkCrossBuilding, true);
    assert.equal(checkDupByMgrB.body.duplicates.length, 0);
    assert.doesNotMatch(JSON.stringify(checkDupByMgrB.body), /Trần Bảo Mật/);

    // 2.5 Manager B attempting to create duplicate with secretPhone gets 409 WITHOUT PII leak
    const dupPostByMgrB = await apiFetch('/api/v1/tenants', mgrB.token, {
      method: 'POST',
      body: JSON.stringify({
        full_name: 'Thử Dò Quét Từ Tòa Khác',
        phone: secretPhone,
      }),
    });
    assert.equal(dupPostByMgrB.status, 409);
    assert.equal(dupPostByMgrB.body.code, 'DUPLICATE_PHONE');
    assert.equal(dupPostByMgrB.body.existing_person?.in_scope, false);
    assert.doesNotMatch(JSON.stringify(dupPostByMgrB.body), /Trần Bảo Mật/);

    // 2.6 Manager B CAN link verified existing resident tenantIdA to a new contract in Building B (Điểm 1)
    const aptMgrB = await apiFetch('/api/v1/apartments?status=AVAILABLE', mgrB.token);
    const availAptB = aptMgrB.body.data?.[0];
    if (availAptB) {
      const linkedContract = await apiFetch('/api/v1/contracts', mgrB.token, {
        method: 'POST',
        body: JSON.stringify({
          apartment_id: availAptB.id,
          primary_tenant_id: tenantIdA,
          start_date: '2028-01-01',
          end_date: '2028-12-31',
          rent_amount: 9000000,
        }),
      });
      assert.equal(linkedContract.status, 201);
      if (linkedContract.body.data?.id) {
        await adminPool.query('DELETE FROM contract WHERE id = $1', [linkedContract.body.data.id]);
      }
    }
  });
});
