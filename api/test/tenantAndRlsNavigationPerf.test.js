import { test } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
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

async function apiFetch(path, token) {
  const t0 = performance.now();
  const res = await fetch(`${API_BASE}${path}`, {
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  const body = await res.json();
  const elapsedMs = performance.now() - t0;
  return { status: res.status, body, elapsedMs };
}

test('Task 1.1 — Migration 054 indexes & set-based RLS EXPLAIN latency under MANAGER', async (t) => {
  const adminPool = new pg.Pool({ connectionString: ADMIN_DB_URL });
  const appPool = new pg.Pool({ connectionString: APP_DB_URL });

  t.after(async () => {
    await adminPool.end();
    await appPool.end();
  });

  const idxRes = await adminPool.query(
    `SELECT indexname
     FROM pg_indexes
     WHERE schemaname = 'public'
       AND indexname = ANY($1::text[])`,
    [[
      'idx_app_user_person_id',
      'idx_contract_occupant_contract_id',
      'idx_contract_occupant_tenant_id',
      'idx_contract_parent_contract_id',
    ]]
  );
  const foundIndexes = new Set(idxRes.rows.map((r) => r.indexname));
  for (const expectedIdx of [
    'idx_app_user_person_id',
    'idx_contract_occupant_contract_id',
    'idx_contract_occupant_tenant_id',
    'idx_contract_parent_contract_id',
  ]) {
    assert.ok(foundIndexes.has(expectedIdx), `Missing expected index: ${expectedIdx}`);
  }

  const mgrRes = await adminPool.query(
    `SELECT au.id AS user_id
     FROM app_user au
     JOIN person p ON p.id = au.person_id
     WHERE LOWER(p.email) = 'manager.vop.a@resihub.vn'
     LIMIT 1`
  );
  assert.equal(mgrRes.rows.length, 1, 'Seed manager.vop.a@resihub.vn must exist');
  const mgrUserId = mgrRes.rows[0].user_id;

  const client = await appPool.connect();
  try {
    // Default-deny when app.current_user_id is unset/empty
    await client.query(`RESET app.current_user_id`);
    const denyPerson = await client.query(`SELECT COUNT(*)::int AS cnt FROM person`);
    const denyTenant = await client.query(`SELECT COUNT(*)::int AS cnt FROM tenant`);
    assert.equal(denyPerson.rows[0].cnt, 0, 'person RLS must default-deny when unset');
    assert.equal(denyTenant.rows[0].cnt, 0, 'tenant RLS must default-deny when unset');

    // Set MANAGER session & measure EXPLAIN ANALYZE on person + tenant scan
    await client.query(`SELECT set_config('app.current_user_id', $1, false)`, [mgrUserId]);
    // Warm plan cache once
    await client.query(`SELECT p.id FROM person p`);
    const explainRes = await client.query(
      `EXPLAIN (ANALYZE, FORMAT JSON) SELECT p.id FROM person p`
    );
    const execTimeMs = explainRes.rows[0]['QUERY PLAN'][0]['Execution Time'];
    assert.ok(
      execTimeMs < 50,
      `Expected person RLS scan Execution Time < 50ms for MANAGER, got ${execTimeMs.toFixed(2)}ms`
    );
  } finally {
    await client.query(`RESET app.current_user_id`).catch(() => {});
    client.release();
  }
});

test('Task 1.2 — RLS INSERT ... RETURNING * parity & cross-building isolation for MANAGER', async (t) => {
  const adminPool = new pg.Pool({ connectionString: ADMIN_DB_URL });
  const appPool = new pg.Pool({ connectionString: APP_DB_URL });
  let createdPersonId = null;
  let createdTenantId = null;

  t.after(async () => {
    if (createdTenantId) {
      await adminPool.query(`DELETE FROM tenant WHERE id = $1`, [createdTenantId]);
    }
    if (createdPersonId) {
      await adminPool.query(`DELETE FROM person WHERE id = $1`, [createdPersonId]);
    }
    await adminPool.end();
    await appPool.end();
  });

  const mgrRows = await adminPool.query(
    `SELECT LOWER(p.email) AS email, au.id AS user_id, p.org_id,
            ARRAY_AGG(DISTINCT ur.building_id) FILTER (WHERE ur.building_id IS NOT NULL) AS building_ids
     FROM app_user au
     JOIN person p ON p.id = au.person_id
     JOIN user_role ur ON ur.user_id = au.id
     JOIN role rl ON rl.id = ur.role_id
     WHERE rl.code = 'MANAGER' AND au.status = 'ACTIVE'
     GROUP BY LOWER(p.email), au.id, p.org_id`
  );
  const mgrA = mgrRows.rows.find((r) => r.email === 'manager.vop.a@resihub.vn') || mgrRows.rows[0];
  const mgrASet = new Set(mgrA?.building_ids || []);
  const mgrOther = mgrRows.rows.find(
    (r) => r.user_id !== mgrA?.user_id && !(r.building_ids || []).some((bid) => mgrASet.has(bid))
  );
  assert.ok(mgrA && mgrOther, 'Two active MANAGER accounts on disjoint buildings must exist');

  const clientA = await appPool.connect();
  try {
    await clientA.query(`SELECT set_config('app.current_user_id', $1, false)`, [mgrA.user_id]);
    const uniquePhone = `099${String(Date.now()).slice(-7)}`;
    const insPerson = await clientA.query(
      `INSERT INTO person (org_id, full_name, phone, created_by)
       VALUES ($1, 'Test Perf RLS Manager Insert', $2, $3)
       RETURNING id, full_name, created_by`,
      [mgrA.org_id, uniquePhone, mgrA.user_id]
    );
    assert.equal(insPerson.rows.length, 1, 'MANAGER A must receive row from INSERT INTO person ... RETURNING *');
    createdPersonId = insPerson.rows[0].id;

    // Review Focus #1: INSERT INTO tenant with NULL created_by relying on person.created_by = mgrA.user_id
    const insTenant = await clientA.query(
      `INSERT INTO tenant (org_id, person_id, status, type, created_by)
       VALUES ($1, $2, 'PENDING', 'primary', NULL)
       RETURNING id, person_id, status`,
      [mgrA.org_id, createdPersonId]
    );
    assert.equal(insTenant.rows.length, 1, 'MANAGER A must receive row from INSERT INTO tenant (NULL created_by) ... RETURNING *');
    createdTenantId = insTenant.rows[0].id;
  } finally {
    await clientA.query(`RESET app.current_user_id`).catch(() => {});
    clientA.release();
  }

  const clientOther = await appPool.connect();
  try {
    await clientOther.query(`SELECT set_config('app.current_user_id', $1, false)`, [mgrOther.user_id]);
    const leakPerson = await clientOther.query(`SELECT id FROM person WHERE id = $1`, [createdPersonId]);
    const leakTenant = await clientOther.query(`SELECT id FROM tenant WHERE id = $1`, [createdTenantId]);
    assert.equal(leakPerson.rows.length, 0, 'Unassigned MANAGER from another building must NOT see uncontracted person');
    assert.equal(leakTenant.rows.length, 0, 'Unassigned MANAGER from another building must NOT see uncontracted tenant');
  } finally {
    await clientOther.query(`RESET app.current_user_id`).catch(() => {});
    clientOther.release();
  }
});

test('Task 1.3 — GET /api/v1/tenants latency (<200ms), building_id scoping & OWNER PII masking', async () => {
  const [sysAdmin, ownerVop, mgrA] = await Promise.all([
    login('admin@resihub.vn', 'Admin@123456'),
    login('owner.vop@resihub.vn', 'Demo@123456'),
    login('manager.vop.a@resihub.vn', 'Demo@123456'),
  ]);

  // Warm once after potential server reload
  await apiFetch('/api/v1/tenants', sysAdmin.token);

  const sysRes = await apiFetch('/api/v1/tenants', sysAdmin.token);
  const ownerRes = await apiFetch('/api/v1/tenants', ownerVop.token);
  const mgrRes = await apiFetch('/api/v1/tenants', mgrA.token);

  assert.equal(sysRes.status, 200);
  assert.equal(ownerRes.status, 200);
  assert.equal(mgrRes.status, 200);

  assert.ok(sysRes.elapsedMs < 200, `SYS_ADMIN GET /tenants took ${sysRes.elapsedMs.toFixed(1)}ms (expected < 200ms)`);
  assert.ok(ownerRes.elapsedMs < 200, `OWNER GET /tenants took ${ownerRes.elapsedMs.toFixed(1)}ms (expected < 200ms)`);
  assert.ok(mgrRes.elapsedMs < 200, `MANAGER GET /tenants took ${mgrRes.elapsedMs.toFixed(1)}ms (expected < 200ms)`);

  // Verify row structure (active_contract + boolean has_past_contract)
  assert.ok(sysRes.body.data.length > 0, 'SYS_ADMIN should see seeded tenants');
  const sampleWithActive = sysRes.body.data.find((r) => r.active_contract !== null);
  assert.ok(sampleWithActive, 'At least one tenant must have active_contract populated');
  assert.ok(
    ['primary', 'occupant'].includes(sampleWithActive.active_contract.member_role),
    'active_contract.member_role must be primary or occupant'
  );
  assert.equal(typeof sampleWithActive.has_past_contract, 'boolean');

  // Verify OWNER PII masking
  const ownerWithId = ownerRes.body.data.find((r) => r.id_number);
  if (ownerWithId) {
    assert.equal(ownerWithId.id_number_masked_for_owner, true);
    assert.ok(String(ownerWithId.id_number).includes('*'), 'OWNER id_number must be masked');
  }

  // Verify building_id server-side filtering & Review Focus #2 (out-of-scope / non-UUID)
  const bldListRes = await apiFetch('/api/v1/buildings', sysAdmin.token);
  assert.equal(bldListRes.status, 200);
  const mgrBuildingsRes = await apiFetch('/api/v1/buildings', mgrA.token);
  const mgrBldIds = new Set(mgrBuildingsRes.body.data.map((b) => b.id));
  const inScopeBldId = [...mgrBldIds][0];
  const outOfScopeBld = bldListRes.body.data.find((b) => !mgrBldIds.has(b.id));
  assert.ok(inScopeBldId && outOfScopeBld, 'Both in-scope and out-of-scope buildings must exist for MANAGER');

  const scopedRes = await apiFetch(`/api/v1/tenants?building_id=${inScopeBldId}`, sysAdmin.token);
  assert.equal(scopedRes.status, 200);
  assert.ok(
    scopedRes.body.data.length < sysRes.body.data.length,
    `GET /tenants?building_id=${inScopeBldId} must filter to building subset (${scopedRes.body.data.length} vs ${sysRes.body.data.length})`
  );

  const mgrOutScopeRes = await apiFetch(`/api/v1/tenants?building_id=${outOfScopeBld.id}`, mgrA.token);
  assert.equal(mgrOutScopeRes.status, 200);
  assert.deepEqual(mgrOutScopeRes.body.data, [], 'Out-of-scope building_id for MANAGER must return empty array');

  const invalidUuidRes = await apiFetch('/api/v1/tenants?building_id=not-a-uuid', mgrA.token);
  assert.equal(invalidUuidRes.status, 200);
  assert.deepEqual(invalidUuidRes.body.data, [], 'Invalid non-UUID building_id must return empty array without 500');
});
