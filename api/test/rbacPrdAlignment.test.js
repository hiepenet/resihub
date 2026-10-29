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

    // PRD FR-007 / US-008 / 6.2 (CRU) & Bảo mật danh tính OWNER:
    // - MANAGER KHÔNG được lấy danh sách công khai /api/v1/buildings/owners (403)
    // - MANAGER tra cứu chính xác bằng Email qua /api/v1/buildings/lookup-owner (masked PII)
    const ownersPublicRes = await apiFetch('/api/v1/buildings/owners', token);
    assert.strictEqual(ownersPublicRes.status, 403, 'MANAGER must NOT be allowed to list all org owners publicly');

    const lookupOwnerRes = await apiFetch('/api/v1/buildings/lookup-owner?identifier=owner.vop@resihub.vn', token);
    assert.strictEqual(lookupOwnerRes.status, 200);
    assert.strictEqual(lookupOwnerRes.body.found, true);
    assert.ok(lookupOwnerRes.body.owner?.id, 'Exact owner email lookup must return owner id');
    assert.ok(lookupOwnerRes.body.owner?.masked_email?.includes('***'), 'Owner email must be masked');

    const { token: adminToken } = await login('admin@resihub.vn', 'Admin@123456');
    const uniqueCode = `MGR-${Date.now().toString().slice(-6)}`;
    let createdBuildingId = null;

    try {
      const postBldg = await apiFetch('/api/v1/buildings', token, {
        method: 'POST',
        body: JSON.stringify({
          name: 'Tòa Khởi Tạo Bởi Manager',
          code: uniqueCode,
          address: '123 Đường Kiểm Thử FR-007',
          owner_id: lookupOwnerRes.body.owner.id,
        }),
      });
      assert.strictEqual(postBldg.status, 201, `Expected 201 when MANAGER creates building, got ${postBldg.status}: ${JSON.stringify(postBldg.body)}`);
      createdBuildingId = postBldg.body.data.id;
      assert.ok(createdBuildingId, 'Created building must return id');

      // Manager immediately sees 2 buildings (VOP-A + newly created building)
      const bAfter = await apiFetch('/api/v1/buildings', token);
      assert.strictEqual(bAfter.status, 200);
      assert.ok(
        bAfter.body.data.some((b) => b.id === createdBuildingId && b.code === uniqueCode),
        'Newly created building must be immediately accessible in MANAGER scope'
      );

      // US-008: Manager can immediately create Zone & Floor inside the newly created building
      const zRes = await apiFetch(`/api/v1/buildings/${createdBuildingId}/zones`, token, {
        method: 'POST',
        body: JSON.stringify({ code: 'KHU-A', name: 'Phân khu A' }),
      });
      assert.strictEqual(zRes.status, 201, 'MANAGER must be able to create Zone inside newly created building');

      const fRes = await apiFetch(`/api/v1/buildings/${createdBuildingId}/floors`, token, {
        method: 'POST',
        body: JSON.stringify({ level: 1, name: 'Tầng 1' }),
      });
      assert.strictEqual(fRes.status, 201, 'MANAGER must be able to create Floor inside newly created building');

      // Manager CANNOT delete building (CRU only, no D)
      const mgrDelBldg = await apiFetch(`/api/v1/buildings/${createdBuildingId}`, token, {
        method: 'DELETE',
      });
      assert.strictEqual(mgrDelBldg.status, 403, 'MANAGER must be blocked from deleting building (CRU only)');

      // Clean up child zone & floor as SYS_ADMIN, then delete empty building via SYS_ADMIN API (CRUD)
      await apiFetch(`/api/v1/buildings/${createdBuildingId}/zones/${zRes.body.data.id}`, adminToken, { method: 'DELETE' });
      await apiFetch(`/api/v1/buildings/${createdBuildingId}/floors/${fRes.body.data.id}`, adminToken, { method: 'DELETE' });

      const adminDelBldg = await apiFetch(`/api/v1/buildings/${createdBuildingId}`, adminToken, {
        method: 'DELETE',
      });
      assert.strictEqual(adminDelBldg.status, 200, 'SYS_ADMIN must be able to delete empty building (CRUD)');
      createdBuildingId = null;

      // Verify user_role scope cleaned up so manager is back to 1 building (VOP-A)
      const bRestored = await apiFetch('/api/v1/buildings', token);
      assert.strictEqual(bRestored.body.data.length, 1);
    } finally {
      if (createdBuildingId) {
        await adminPool.query('DELETE FROM user_role WHERE building_id = $1', [createdBuildingId]);
        await adminPool.query('DELETE FROM building WHERE id = $1', [createdBuildingId]);
      }
    }
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

      // (b2) Anti-privilege-escalation at RLS layer: MANAGER CANNOT self-assign VOP-B or SYS_ADMIN in user_role directly
      const vopBRow = await adminPool.query(`SELECT id, org_id FROM building WHERE code = 'VOP-B' LIMIT 1`);
      const mgrRoleRow = await adminPool.query(`SELECT id FROM role WHERE code = 'MANAGER' LIMIT 1`);
      const adminRoleRow = await adminPool.query(`SELECT id FROM role WHERE code = 'SYS_ADMIN' LIMIT 1`);

      await assert.rejects(
        () =>
          client.query(
            `INSERT INTO user_role (user_id, role_id, building_id) VALUES ($1, $2, $3)`,
            [idByEmail['manager.vop.a@resihub.vn'], mgrRoleRow.rows[0].id, vopBRow.rows[0].id]
          ),
        /row-level security/i,
        'RLS must block MANAGER from self-assigning an existing unassigned building (VOP-B)'
      );

      await assert.rejects(
        () =>
          client.query(
            `INSERT INTO user_role (user_id, role_id, building_id) VALUES ($1, $2, NULL)`,
            [idByEmail['manager.vop.a@resihub.vn'], adminRoleRow.rows[0].id]
          ),
        /row-level security/i,
        'RLS must block MANAGER from self-escalating to SYS_ADMIN'
      );

      // (b3) RLS allows MANAGER to INSERT a new building in their org, auto-assigns MANAGER role via trigger, and blocks DELETE
      const rlsCode = `RLS-${Date.now().toString().slice(-6)}`;
      let rlsBldgId = null;
      try {
        await client.query(
          `INSERT INTO building (org_id, name, code, address, status) VALUES ($1, 'RLS Mgr Bldg', $2, 'RLS Addr', 'ACTIVE')`,
          [vopBRow.rows[0].org_id, rlsCode]
        );
        const selNew = await client.query(`SELECT id, code FROM building WHERE code = $1`, [rlsCode]);
        assert.strictEqual(selNew.rowCount, 1, 'MANAGER must immediately SELECT newly created building via trigger-assigned user_role');
        rlsBldgId = selNew.rows[0].id;

        const delNew = await client.query(`DELETE FROM building WHERE id = $1 RETURNING id`, [rlsBldgId]);
        assert.strictEqual(delNew.rowCount, 0, 'RLS must block MANAGER from deleting building');
      } finally {
        if (rlsBldgId) {
          await adminPool.query(`DELETE FROM user_role WHERE building_id = $1`, [rlsBldgId]);
          await adminPool.query(`DELETE FROM building WHERE id = $1`, [rlsBldgId]);
        }
      }

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
