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

const TINY_PNG_B64 =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

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
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text };
  }
  return { status: res.status, body, headers: res.headers };
}

test('M05 Contract Creation & Activation 7-Item Fix Suite', async (t) => {
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

  const createdContractIds = [];
  const createdApartmentIds = [];
  const createdBuildingIds = [];
  const createdPersonIds = [];

  t.after(async () => {
    try {
      for (const cId of createdContractIds) {
        await adminPool.query(
          'DELETE FROM invoice_line WHERE invoice_id IN (SELECT id FROM invoice WHERE contract_id = $1)',
          [cId]
        );
        await adminPool.query('DELETE FROM receivable WHERE contract_id = $1', [cId]).catch(() => {});
        await adminPool.query('DELETE FROM invoice WHERE contract_id = $1', [cId]);
        const cleanClient = await adminPool.connect();
        try {
          await cleanClient.query('BEGIN');
          await cleanClient.query("SET LOCAL app.allow_test_cleanup = 'true'");
          await cleanClient.query(
            'DELETE FROM deposit_transaction WHERE deposit_id IN (SELECT id FROM deposit WHERE contract_id = $1)',
            [cId]
          );
          await cleanClient.query('DELETE FROM deposit WHERE contract_id = $1', [cId]);
          await cleanClient.query('COMMIT');
        } catch {
          await cleanClient.query('ROLLBACK').catch(() => {});
        } finally {
          cleanClient.release();
        }
        await adminPool.query('DELETE FROM service_subscription WHERE contract_id = $1', [cId]).catch(() => {});
        await adminPool.query('DELETE FROM attachment WHERE owner_entity = $1 AND owner_id = $2', ['contract', cId]);
        await adminPool.query('DELETE FROM contract_version WHERE contract_id = $1', [cId]);
        await adminPool.query('DELETE FROM contract_request WHERE contract_id = $1', [cId]);
        await adminPool.query('DELETE FROM contract_service_price WHERE contract_id = $1', [cId]).catch(() => {});
        await adminPool.query('DELETE FROM contract_occupant WHERE contract_id = $1', [cId]).catch(() => {});
        await adminPool.query('DELETE FROM contract WHERE id = $1', [cId]);
      }
      for (const aptId of createdApartmentIds) {
        await adminPool.query('DELETE FROM reservation WHERE apartment_id = $1', [aptId]).catch(() => {});
        await adminPool.query('DELETE FROM apartment WHERE id = $1', [aptId]);
      }
      for (const bId of createdBuildingIds) {
        await adminPool.query('DELETE FROM floor WHERE building_id = $1', [bId]);
        await adminPool.query('DELETE FROM user_role WHERE building_id = $1', [bId]);
        await adminPool.query('DELETE FROM building WHERE id = $1', [bId]);
      }
      for (const pId of createdPersonIds) {
        await adminPool.query('DELETE FROM notification WHERE user_id IN (SELECT id FROM app_user WHERE person_id = $1)', [pId]).catch(() => {});
        await adminPool.query('DELETE FROM user_role WHERE user_id IN (SELECT id FROM app_user WHERE person_id = $1)', [pId]).catch(() => {});
        await adminPool.query('DELETE FROM app_user WHERE person_id = $1', [pId]).catch(() => {});
        await adminPool.query('DELETE FROM tenant WHERE person_id = $1', [pId]).catch(() => {});
        await adminPool.query('DELETE FROM person WHERE id = $1', [pId]).catch(() => {});
      }
    } finally {
      await adminPool.end();
      await appPool.end();
    }
  });

  const [sysAdmin, mgrVopA, ownerVop, ownerVsc] = await Promise.all([
    login('admin@resihub.vn', 'Admin@123456'),
    login('manager.vop.a@resihub.vn', 'Demo@123456'),
    login('owner.vop@resihub.vn', 'Demo@123456'),
    login('owner.vsc@resihub.vn', 'Demo@123456'),
  ]);

  const vopARes = await adminPool.query(`SELECT id, org_id FROM building WHERE code = 'VOP-A' LIMIT 1`);
  const vopAId = vopARes.rows[0].id;
  const orgId = vopARes.rows[0].org_id;
  const floorRes = await adminPool.query(`SELECT id FROM floor WHERE building_id = $1 LIMIT 1`, [vopAId]);
  const floorId = floorRes.rows[0].id;

  async function createTestApartment(bldgId, flrId, suffix, baseRent = 10000000) {
    const code = `CF-${suffix}-${Date.now().toString().slice(-5)}`;
    const ins = await adminPool.query(
      `INSERT INTO apartment (building_id, floor_id, code, area_m2, bedrooms, base_rent, status)
       VALUES ($1, $2, $3, 65, 2, $4, 'AVAILABLE') RETURNING *`,
      [bldgId, flrId, code, baseRent]
    );
    createdApartmentIds.push(ins.rows[0].id);
    return ins.rows[0];
  }

  function makeUniqueTenant(tag) {
    const rand = String(Math.floor(10000000 + Math.random() * 89999999));
    return {
      full_name: `Cư Dân Test ${tag}`,
      phone: `09${rand}`,
      id_number: `0790${rand}`,
      email: `test.${tag.toLowerCase()}.${rand}@resihub.vn`,
    };
  }

  await t.test('Task 1: SYS_ADMIN is R-only on contracts; building OWNER approves/rejects discounted contracts (with ownerless fallback)', async () => {
    const apt1 = await createTestApartment(vopAId, floorId, 'T1A', 10000000);
    const tenant1 = makeUniqueTenant('T1A');

    // Create discounted contract (< 90% of 10,000,000 => 8,000,000)
    const createRes = await apiFetch('/api/v1/contracts', mgrVopA.token, {
      method: 'POST',
      body: JSON.stringify({
        apartment_id: apt1.id,
        new_tenant: tenant1,
        start_date: '2027-01-01',
        end_date: '2028-01-01',
        rent_amount: 8000000,
        deposit_amount: 8000000,
      }),
    });
    assert.equal(createRes.status, 201, `Create failed: ${JSON.stringify(createRes.body)}`);
    const contractId = createRes.body.data.id;
    createdContractIds.push(contractId);
    if (createRes.body.created_tenant?.person_id) {
      createdPersonIds.push(createRes.body.created_tenant.person_id);
    }

    // SYS_ADMIN is R-only: blocked from service-prices (403)
    const sysPriceTry = await apiFetch(`/api/v1/contracts/${contractId}/service-prices`, sysAdmin.token, {
      method: 'POST',
      body: JSON.stringify({ service_code: 'INTERNET', unit_price: 200000 }),
    });
    assert.equal(sysPriceTry.status, 403, 'SYS_ADMIN must be R-only and get 403 on POST /:id/service-prices');

    // Upload scan & activate -> enters PENDING_APPROVAL
    const scanRes = await apiFetch(`/api/v1/contracts/${contractId}/scan`, mgrVopA.token, {
      method: 'POST',
      body: JSON.stringify({ image_base64: TINY_PNG_B64 }),
    });
    assert.equal(scanRes.status, 201);

    const actRes = await apiFetch(`/api/v1/contracts/${contractId}/activate`, mgrVopA.token, {
      method: 'POST',
    });
    assert.equal(actRes.status, 409);
    assert.equal(actRes.body.code, 'PRICE_NEEDS_APPROVAL');
    assert.equal(actRes.body.data.status, 'PENDING_APPROVAL');

    // GET /:id exposes has_building_owner = true on VOP-A
    const detailRes = await apiFetch(`/api/v1/contracts/${contractId}`, ownerVop.token);
    assert.equal(detailRes.status, 200);
    assert.equal(detailRes.body.data.has_building_owner, true);

    // SYS_ADMIN blocked from approving when building has an active OWNER
    const sysApproveTry = await apiFetch(`/api/v1/contracts/${contractId}/approve`, sysAdmin.token, {
      method: 'POST',
    });
    assert.equal(sysApproveTry.status, 403, 'SYS_ADMIN must NOT approve when building has active OWNER');
    assert.equal(sysApproveTry.body.code, 'FORBIDDEN_NOT_BUILDING_OWNER');

    // MANAGER blocked from approving discounted contract
    const mgrApproveTry = await apiFetch(`/api/v1/contracts/${contractId}/approve`, mgrVopA.token, {
      method: 'POST',
    });
    assert.equal(mgrApproveTry.status, 403, 'MANAGER must NOT approve price-deviated contracts');

    // Cross-building OWNER (owner.vsc@resihub.vn) blocked 403 + ACCESS_DENIED audit_log (Review Focus #1)
    const beforeAudit = await adminPool.query(
      `SELECT COUNT(*)::int AS cnt FROM audit_log WHERE actor_id = $1 AND action = 'ACCESS_DENIED' AND entity = 'contract' AND entity_id = $2`,
      [ownerVsc.user.sub || ownerVsc.user.id, contractId]
    );
    const crossOwnerApprove = await apiFetch(`/api/v1/contracts/${contractId}/approve`, ownerVsc.token, {
      method: 'POST',
    });
    assert.equal(crossOwnerApprove.status, 403, 'Cross-building OWNER must get 403');
    const afterAudit = await adminPool.query(
      `SELECT COUNT(*)::int AS cnt FROM audit_log WHERE actor_id = $1 AND action = 'ACCESS_DENIED' AND entity = 'contract' AND entity_id = $2`,
      [ownerVsc.user.sub || ownerVsc.user.id, contractId]
    );
    assert.ok(afterAudit.rows[0].cnt >= beforeAudit.rows[0].cnt + 1, 'Cross-building OWNER attempt must write ACCESS_DENIED');

    // Building OWNER (owner.vop@resihub.vn) rejects -> returns to DRAFT
    const ownerRejectRes = await apiFetch(`/api/v1/contracts/${contractId}/reject`, ownerVop.token, {
      method: 'POST',
      body: JSON.stringify({ reason: 'Cần bổ sung ghi chú ưu đãi khách dài hạn' }),
    });
    assert.equal(ownerRejectRes.status, 200, `Owner reject failed: ${JSON.stringify(ownerRejectRes.body)}`);
    assert.equal(ownerRejectRes.body.data.status, 'DRAFT');

    // Re-submit and building OWNER approves -> ACTIVE + deposit ledger opened
    const reAct = await apiFetch(`/api/v1/contracts/${contractId}/activate`, mgrVopA.token, { method: 'POST' });
    assert.equal(reAct.status, 409);
    assert.equal(reAct.body.data.status, 'PENDING_APPROVAL');

    const ownerApproveRes = await apiFetch(`/api/v1/contracts/${contractId}/approve`, ownerVop.token, {
      method: 'POST',
    });
    assert.equal(ownerApproveRes.status, 200, `Owner approve failed: ${JSON.stringify(ownerApproveRes.body)}`);
    assert.equal(ownerApproveRes.body.data.status, 'ACTIVE');

    const depCheck = await adminPool.query('SELECT * FROM deposit WHERE contract_id = $1', [contractId]);
    assert.equal(depCheck.rows.length, 1, 'Deposit ledger must open on OWNER approval');

    // SYS_ADMIN is also blocked from terminating ACTIVE contracts (403)
    const sysTermTry = await apiFetch(`/api/v1/contracts/${contractId}/terminate`, sysAdmin.token, {
      method: 'POST',
      body: JSON.stringify({ reason: 'SysAdmin try terminate' }),
    });
    assert.equal(sysTermTry.status, 403, 'SYS_ADMIN must get 403 on POST /:id/terminate');

    // Review Focus #2: Building with owner_id = NULL -> SYS_ADMIN fallback can approve
    const bldgCode = `OWNLESS-${Date.now().toString().slice(-5)}`;
    const bIns = await adminPool.query(
      `INSERT INTO building (org_id, owner_id, name, code, address, status)
       VALUES ($1, NULL, 'Tòa Chưa Gắn Chủ', $2, 'Test Addr', 'ACTIVE') RETURNING id`,
      [orgId, bldgCode]
    );
    const ownerlessBldgId = bIns.rows[0].id;
    createdBuildingIds.push(ownerlessBldgId);

    const mgrRole = await adminPool.query(`SELECT id FROM role WHERE code = 'MANAGER' LIMIT 1`);
    await adminPool.query(
      `INSERT INTO user_role (user_id, role_id, building_id) VALUES ($1, $2, $3)`,
      [mgrVopA.user.sub || mgrVopA.user.id, mgrRole.rows[0].id, ownerlessBldgId]
    );
    const fIns = await adminPool.query(
      `INSERT INTO floor (building_id, level, name) VALUES ($1, 1, 'Tầng 1') RETURNING id`,
      [ownerlessBldgId]
    );
    const apt2 = await createTestApartment(ownerlessBldgId, fIns.rows[0].id, 'T1B', 10000000);
    const tenant2 = makeUniqueTenant('T1B');

    const c2Res = await apiFetch('/api/v1/contracts', mgrVopA.token, {
      method: 'POST',
      body: JSON.stringify({
        apartment_id: apt2.id,
        new_tenant: tenant2,
        start_date: '2027-02-01',
        end_date: '2028-02-01',
        rent_amount: 8000000,
        deposit_amount: 8000000,
      }),
    });
    assert.equal(c2Res.status, 201);
    const c2Id = c2Res.body.data.id;
    createdContractIds.push(c2Id);
    if (c2Res.body.created_tenant?.person_id) {
      createdPersonIds.push(c2Res.body.created_tenant.person_id);
    }

    await apiFetch(`/api/v1/contracts/${c2Id}/scan`, mgrVopA.token, {
      method: 'POST',
      body: JSON.stringify({ image_base64: TINY_PNG_B64 }),
    });
    const act2 = await apiFetch(`/api/v1/contracts/${c2Id}/activate`, mgrVopA.token, { method: 'POST' });
    assert.equal(act2.status, 409);
    assert.equal(act2.body.code, 'PRICE_NEEDS_APPROVAL');

    const detail2 = await apiFetch(`/api/v1/contracts/${c2Id}`, sysAdmin.token);
    assert.equal(detail2.body.data.has_building_owner, false);

    const fallbackApprove = await apiFetch(`/api/v1/contracts/${c2Id}/approve`, sysAdmin.token, {
      method: 'POST',
    });
    assert.equal(fallbackApprove.status, 200, `Ownerless fallback approve failed: ${JSON.stringify(fallbackApprove.body)}`);
    assert.equal(fallbackApprove.body.data.status, 'ACTIVE');
  });
});
