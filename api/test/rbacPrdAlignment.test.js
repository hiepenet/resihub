import { test } from 'node:test';
import assert from 'node:assert';
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
  assert.strictEqual(res.status, 200, `Login failed for ${email}: ${JSON.stringify(body)}`);
  return { token: body.accessToken, user: body.user };
}

async function apiFetch(path, token, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return { status: res.status, body: json };
}

test('PRD v2.0 RBAC & Multi-Building Isolation (API + PostgreSQL RLS + AC-019.1 Audit)', async (t) => {
  // Kiểm tra kết nối API trước khi chạy integration suite
  let healthOk = false;
  try {
    const h = await fetch(`${API_BASE}/api/health`);
    healthOk = h.ok;
  } catch {
    healthOk = false;
  }
  if (!healthOk) {
    t.skip('API server is not reachable on TEST_API_BASE');
    return;
  }

  const adminPool = new pg.Pool({ connectionString: ADMIN_DB_URL });
  const appPool = new pg.Pool({ connectionString: APP_DB_URL });

  t.after(async () => {
    await adminPool.end();
    await appPool.end();
  });

  await t.test('1. SYS_ADMIN sees all 9 buildings & 450 apartments, R-only on contracts', async () => {
    const { token } = await login('admin@resihub.vn', 'Admin@123456');

    const bRes = await apiFetch('/api/v1/buildings', token);
    assert.strictEqual(bRes.status, 200);
    assert.strictEqual(bRes.body.data.length, 9, 'SYS_ADMIN must see all 9 tower buildings');

    const aRes = await apiFetch('/api/v1/apartments', token);
    assert.strictEqual(aRes.status, 200);
    assert.strictEqual(aRes.body.data.length, 450, 'SYS_ADMIN must see all 450 apartments');

    const cRes = await apiFetch('/api/v1/contracts', token);
    assert.strictEqual(cRes.status, 200);
    assert.ok(cRes.body.data.length > 100, 'SYS_ADMIN must be able to read contracts org-wide');

    // SYS_ADMIN không được tạo hợp đồng (PRD 6.2: Hợp đồng = R)
    const createContractRes = await apiFetch('/api/v1/contracts', token, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    assert.strictEqual(createContractRes.status, 403);
  });

  await t.test('2. MANAGER VOP-A sees ONLY VOP-A (1 building, 50 apts) and non-zero contracts/tenants/deposits', async () => {
    const { token } = await login('manager.vop.a@resihub.vn', 'Demo@123456');

    const bRes = await apiFetch('/api/v1/buildings', token);
    assert.strictEqual(bRes.status, 200);
    assert.strictEqual(bRes.body.data.length, 1, 'Manager VOP-A must only see 1 assigned building');
    assert.strictEqual(bRes.body.data[0].code, 'VOP-A');

    const aRes = await apiFetch('/api/v1/apartments', token);
    assert.strictEqual(aRes.status, 200);
    assert.strictEqual(aRes.body.data.length, 50, 'Manager VOP-A must only see 50 apartments of VOP-A');

    // Regression check for 021 RLS bug: Manager must see contracts, tenants, deposits of VOP-A
    const cRes = await apiFetch('/api/v1/contracts', token);
    assert.strictEqual(cRes.status, 200);
    assert.ok(cRes.body.data.length >= 15, `Expected >=15 contracts for VOP-A, got ${cRes.body.data.length}`);

    const tRes = await apiFetch('/api/v1/tenants', token);
    assert.strictEqual(tRes.status, 200);
    assert.ok(tRes.body.data.length >= 15, `Expected >=15 tenants for VOP-A, got ${tRes.body.data.length}`);

    const dRes = await apiFetch('/api/v1/deposits', token);
    assert.strictEqual(dRes.status, 200);
    assert.ok(dRes.body.data.length >= 15, `Expected >=15 deposits for VOP-A, got ${dRes.body.data.length}`);

    // Manager CANNOT create a new building (PRD v0.2: only SYS_ADMIN creates buildings)
    const postBldg = await apiFetch('/api/v1/buildings', token, {
      method: 'POST',
      body: JSON.stringify({ name: 'Tòa Trái Phép', code: 'HACK-01' }),
    });
    assert.strictEqual(postBldg.status, 403);
  });

  await t.test('3. AC-019.1: MANAGER VOP-A accessing VOP-B directly receives 403 and writes ACCESS_DENIED audit_log', async () => {
    const { token, user } = await login('manager.vop.a@resihub.vn', 'Demo@123456');

    const vopBRes = await adminPool.query(`SELECT id FROM building WHERE code = 'VOP-B' LIMIT 1`);
    assert.strictEqual(vopBRes.rows.length, 1, 'VOP-B building must exist');
    const vopBId = vopBRes.rows[0].id;

    const beforeAudit = await adminPool.query(
      `SELECT COUNT(*)::int AS cnt FROM audit_log WHERE actor_id = $1 AND action = 'ACCESS_DENIED' AND entity_id = $2`,
      [user.sub, vopBId]
    );

    const floorMapRes = await apiFetch(`/api/v1/buildings/${vopBId}/floor-map`, token);
    assert.strictEqual(floorMapRes.status, 403, 'Direct URL access to unassigned building must return 403');

    const aptQueryRes = await apiFetch(`/api/v1/apartments?building_id=${vopBId}`, token);
    assert.strictEqual(aptQueryRes.status, 403, 'Querying apartments of unassigned building must return 403');

    const contractQueryRes = await apiFetch(`/api/v1/contracts?building_id=${vopBId}`, token);
    assert.strictEqual(contractQueryRes.status, 403, 'Querying contracts of unassigned building must return 403');

    const afterAudit = await adminPool.query(
      `SELECT COUNT(*)::int AS cnt FROM audit_log WHERE actor_id = $1 AND action = 'ACCESS_DENIED' AND entity_id = $2`,
      [user.sub, vopBId]
    );
    assert.ok(
      afterAudit.rows[0].cnt >= beforeAudit.rows[0].cnt + 3,
      'Unauthorized building access must write ACCESS_DENIED audit_log entries'
    );
  });

  await t.test('4. OWNER VOP sees 3 buildings (VOP-A/B/C = 150 apts), R-only on real estate/tenants/reservations', async () => {
    const { token } = await login('owner.vop@resihub.vn', 'Demo@123456');

    const bRes = await apiFetch('/api/v1/buildings', token);
    assert.strictEqual(bRes.status, 200);
    const codes = bRes.body.data.map((b) => b.code).sort();
    assert.deepStrictEqual(codes, ['VOP-A', 'VOP-B', 'VOP-C']);

    const aRes = await apiFetch('/api/v1/apartments', token);
    assert.strictEqual(aRes.status, 200);
    assert.strictEqual(aRes.body.data.length, 150);

    // Owner cannot mutate buildings, apartments, tenants, reservations
    const postApt = await apiFetch('/api/v1/apartments', token, {
      method: 'POST',
      body: JSON.stringify({ building_id: bRes.body.data[0].id, code: 'A999' }),
    });
    assert.strictEqual(postApt.status, 403);

    const mergeTenant = await apiFetch('/api/v1/tenants/merge', token, {
      method: 'POST',
      body: JSON.stringify({ source_tenant_id: '00000000-0000-0000-0000-000000000001', target_tenant_id: '00000000-0000-0000-0000-000000000002' }),
    });
    assert.strictEqual(mergeTenant.status, 403);

    const postRsv = await apiFetch('/api/v1/reservations', token, {
      method: 'POST',
      body: JSON.stringify({ apartment_id: aRes.body.data[0].id, prospect_name: 'Test', phone: '0911111111', hold_until: '2026-12-01' }),
    });
    assert.strictEqual(postRsv.status, 403);

    // Owner VOP accessing VSC-A gets 403 + audit
    const vscARes = await adminPool.query(`SELECT id FROM building WHERE code = 'VSC-A' LIMIT 1`);
    const vscAId = vscARes.rows[0].id;
    const crossOwnerRes = await apiFetch(`/api/v1/buildings/${vscAId}`, token);
    assert.strictEqual(crossOwnerRes.status, 403);
  });

  await t.test('5. PostgreSQL RLS Layer: Enforce strict read/write boundaries even on raw SQL', async () => {
    const usersRes = await adminPool.query(`
      SELECT u.id, p.email
      FROM app_user u JOIN person p ON p.id = u.person_id
      WHERE p.email IN ('owner.vop@resihub.vn', 'manager.vop.a@resihub.vn', 'tenant1@resihub.vn')
    `);
    const idByEmail = Object.fromEntries(usersRes.rows.map((r) => [r.email, r.id]));

    const client = await appPool.connect();
    try {
      // (a) OWNER VOP cannot UPDATE their own building at RLS layer (OWNER = R on building/apartment)
      await client.query(`SELECT set_config('app.current_user_id', $1, false)`, [idByEmail['owner.vop@resihub.vn']]);
      const ownerUpd = await client.query(`UPDATE building SET address = 'Hacked' WHERE code = 'VOP-A' RETURNING id`);
      assert.strictEqual(ownerUpd.rowCount, 0, 'RLS must block OWNER from updating building');

      const ownerSeeVsc = await client.query(`SELECT id FROM building WHERE code = 'VSC-A'`);
      assert.strictEqual(ownerSeeVsc.rowCount, 0, 'RLS must block OWNER VOP from seeing VSC-A');

      // (b) MANAGER VOP-A only sees VOP-A via RLS, CAN see VOP-A tenants/persons, CANNOT see VOP-B contracts
      await client.query(`SELECT set_config('app.current_user_id', $1, false)`, [idByEmail['manager.vop.a@resihub.vn']]);
      const mgrBldgs = await client.query(`SELECT id, code FROM building`);
      assert.deepStrictEqual(mgrBldgs.rows.map((r) => r.code), ['VOP-A']);

      const mgrTenants = await client.query(`SELECT id FROM tenant`);
      assert.ok(mgrTenants.rowCount >= 15, 'RLS must allow MANAGER VOP-A to see tenants of VOP-A');

      const mgrPersons = await client.query(`SELECT id FROM person`);
      assert.ok(mgrPersons.rowCount >= 15, 'RLS must allow MANAGER VOP-A to see persons of VOP-A without recursion');

      const mgrCrossContracts = await client.query(
        `SELECT c.id FROM contract c WHERE c.building_id <> $1`,
        [mgrBldgs.rows[0].id]
      );
      assert.strictEqual(mgrCrossContracts.rowCount, 0, 'RLS must hide contracts of all other buildings from MANAGER VOP-A');

      // (c) RESIDENT cannot UPDATE their own deposit at RLS layer
      await client.query(`SELECT set_config('app.current_user_id', $1, false)`, [idByEmail['tenant1@resihub.vn']]);
      const resDepUpd = await client.query(`UPDATE deposit SET amount_held = 0 RETURNING id`);
      assert.strictEqual(resDepUpd.rowCount, 0, 'RLS must block RESIDENT from modifying deposit');
    } finally {
      await client.query('RESET app.current_user_id');
      client.release();
    }
  });
});
