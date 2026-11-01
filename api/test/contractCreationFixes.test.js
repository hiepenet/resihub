import { test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import dotenv from 'dotenv';
import { saveBase64Image } from '../src/services/imageUpload.js';

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
        await adminPool.query("DELETE FROM notification WHERE payload->>'contract_id' = $1", [cId]).catch(() => {});
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

  await t.test('Task 2: Persist billing_cycle, payment_due_days, billing_day 1-31 on POST/PATCH and check TERMINATION_PENDING overlap on draft PATCH', async () => {
    const apt = await createTestApartment(vopAId, floorId, 'T2A', 12000000);
    const tenantA = makeUniqueTenant('T2A');

    // Validation errors on POST /api/v1/contracts
    const badDay = await apiFetch('/api/v1/contracts', mgrVopA.token, {
      method: 'POST',
      body: JSON.stringify({
        apartment_id: apt.id,
        new_tenant: tenantA,
        start_date: '2027-05-01',
        end_date: '2028-05-01',
        rent_amount: 12000000,
        billing_day: 32,
      }),
    });
    assert.equal(badDay.status, 422);
    assert.equal(badDay.body.code, 'INVALID_BILLING_DAY');

    const badDue = await apiFetch('/api/v1/contracts', mgrVopA.token, {
      method: 'POST',
      body: JSON.stringify({
        apartment_id: apt.id,
        new_tenant: tenantA,
        start_date: '2027-05-01',
        end_date: '2028-05-01',
        rent_amount: 12000000,
        payment_due_days: 0,
      }),
    });
    assert.equal(badDue.status, 422);
    assert.equal(badDue.body.code, 'INVALID_PAYMENT_DUE_DAYS');

    const badCycle = await apiFetch('/api/v1/contracts', mgrVopA.token, {
      method: 'POST',
      body: JSON.stringify({
        apartment_id: apt.id,
        new_tenant: tenantA,
        start_date: '2027-05-01',
        end_date: '2028-05-01',
        rent_amount: 12000000,
        billing_cycle: 'yearly',
      }),
    });
    assert.equal(badCycle.status, 422);
    assert.equal(badCycle.body.code, 'INVALID_BILLING_CYCLE');

    // Atomic POST /api/v1/contracts persists billing_cycle='quarterly', billing_day=31, payment_due_days=10
    const c1Res = await apiFetch('/api/v1/contracts', mgrVopA.token, {
      method: 'POST',
      body: JSON.stringify({
        apartment_id: apt.id,
        new_tenant: tenantA,
        start_date: '2027-05-01',
        end_date: '2028-05-01',
        rent_amount: 12000000,
        deposit_amount: 12000000,
        billing_cycle: 'quarterly',
        billing_day: 31,
        payment_due_days: 10,
      }),
    });
    assert.equal(c1Res.status, 201, `Create c1 failed: ${JSON.stringify(c1Res.body)}`);
    const c1Id = c1Res.body.data.id;
    createdContractIds.push(c1Id);
    if (c1Res.body.created_tenant?.person_id) createdPersonIds.push(c1Res.body.created_tenant.person_id);

    assert.equal(c1Res.body.data.billing_cycle, 'quarterly');
    assert.equal(Number(c1Res.body.data.billing_day), 31);
    assert.equal(Number(c1Res.body.data.payment_due_days), 10);

    // Activate c1 and put it into TERMINATION_PENDING ending effectively on 2027-06-15
    await apiFetch(`/api/v1/contracts/${c1Id}/scan`, mgrVopA.token, {
      method: 'POST',
      body: JSON.stringify({ image_base64: TINY_PNG_B64 }),
    });
    const act1 = await apiFetch(`/api/v1/contracts/${c1Id}/activate`, mgrVopA.token, { method: 'POST' });
    assert.equal(act1.status, 200);

    await adminPool.query(
      `UPDATE contract SET status = 'TERMINATION_PENDING', terminated_at = '2027-06-15' WHERE id = $1`,
      [c1Id]
    );

    // Create back-to-back DRAFT starting 2027-06-20 (after terminated_at 2027-06-15) -> 201
    const tenantB = makeUniqueTenant('T2B');
    const c2Res = await apiFetch('/api/v1/contracts', mgrVopA.token, {
      method: 'POST',
      body: JSON.stringify({
        apartment_id: apt.id,
        new_tenant: tenantB,
        start_date: '2027-06-20',
        end_date: '2028-06-20',
        rent_amount: 12000000,
        deposit_amount: 12000000,
      }),
    });
    assert.equal(c2Res.status, 201, `Create back-to-back draft failed: ${JSON.stringify(c2Res.body)}`);
    const c2Id = c2Res.body.data.id;
    createdContractIds.push(c2Id);
    if (c2Res.body.created_tenant?.person_id) createdPersonIds.push(c2Res.body.created_tenant.person_id);

    // PATCH /:id shifting start_date to 2027-06-10 overlaps TERMINATION_PENDING [2027-05-01, 2027-06-15) -> 409 OVERLAP_CONTRACT + conflicts
    const overlapPatch = await apiFetch(`/api/v1/contracts/${c2Id}`, mgrVopA.token, {
      method: 'PATCH',
      body: JSON.stringify({ start_date: '2027-06-10' }),
    });
    assert.equal(overlapPatch.status, 409, 'Draft PATCH overlapping TERMINATION_PENDING must return 409');
    assert.equal(overlapPatch.body.code, 'OVERLAP_CONTRACT');
    assert.ok(Array.isArray(overlapPatch.body.conflicts) && overlapPatch.body.conflicts.length >= 1, 'Must return conflicts array');

    // PATCH /:id updating payment_due_days = 7, billing_day = 30, billing_cycle = 'quarterly' -> 200
    const okPatch = await apiFetch(`/api/v1/contracts/${c2Id}`, mgrVopA.token, {
      method: 'PATCH',
      body: JSON.stringify({
        payment_due_days: 7,
        billing_day: 30,
        billing_cycle: 'quarterly',
      }),
    });
    assert.equal(okPatch.status, 200, `Draft PATCH billing fields failed: ${JSON.stringify(okPatch.body)}`);
    assert.equal(Number(okPatch.body.data.payment_due_days), 7);
    assert.equal(Number(okPatch.body.data.billing_day), 30);
    assert.equal(okPatch.body.data.billing_cycle, 'quarterly');
  });

  await t.test('Task 3: Signed contract scan supports PDF (FR-020), inline viewing, magic-header check, and 10MB cap', async () => {
    const apt = await createTestApartment(vopAId, floorId, 'T3A', 9000000);
    const tenant = makeUniqueTenant('T3A');

    const cRes = await apiFetch('/api/v1/contracts', mgrVopA.token, {
      method: 'POST',
      body: JSON.stringify({
        apartment_id: apt.id,
        new_tenant: tenant,
        start_date: '2027-07-01',
        end_date: '2028-07-01',
        rent_amount: 9000000,
        deposit_amount: 9000000,
      }),
    });
    assert.equal(cRes.status, 201);
    const contractId = cRes.body.data.id;
    createdContractIds.push(contractId);
    if (cRes.body.created_tenant?.person_id) createdPersonIds.push(cRes.body.created_tenant.person_id);

    const validPdfBytes = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n', 'ascii');
    const validPdfB64 = `data:application/pdf;base64,${validPdfBytes.toString('base64')}`;

    // 1. Upload valid PDF scan -> 201 + application/pdf + .pdf extension
    const scanOk = await apiFetch(`/api/v1/contracts/${contractId}/scan`, mgrVopA.token, {
      method: 'POST',
      body: JSON.stringify({ image_base64: validPdfB64 }),
    });
    assert.equal(scanOk.status, 201, `Valid PDF upload failed: ${JSON.stringify(scanOk.body)}`);
    assert.equal(scanOk.body.data.mime, 'application/pdf');
    assert.ok(String(scanOk.body.data.storage_path).endsWith('.pdf'), 'Storage path must end with .pdf');

    // 2. View PDF scan -> 200 + Content-Type application/pdf + Content-Disposition inline + READ audit_log
    const attId = scanOk.body.data.id;
    const viewRes = await fetch(`${API_BASE}/api/v1/attachments/${attId}/view`, {
      headers: { Authorization: `Bearer ${mgrVopA.token}` },
    });
    assert.equal(viewRes.status, 200);
    assert.match(viewRes.headers.get('content-type') || '', /application\/pdf/i);
    assert.match(viewRes.headers.get('content-disposition') || '', /inline/i);
    const downloadedBuf = Buffer.from(await viewRes.arrayBuffer());
    assert.equal(downloadedBuf.subarray(0, 5).toString('ascii'), '%PDF-');

    const auditRead = await adminPool.query(
      `SELECT COUNT(*)::int AS cnt FROM audit_log WHERE entity = 'attachment' AND entity_id = $1 AND action = 'READ'`,
      [attId]
    );
    assert.ok(auditRead.rows[0].cnt >= 1, 'Viewing PDF scan must record READ in audit_log');

    // 3. Review Focus #3: Fake PDF without %PDF- magic header -> 400 VALIDATION_ERROR
    const fakePdfB64 = `data:application/pdf;base64,${Buffer.from('HELLO_NOT_A_PDF_FILE').toString('base64')}`;
    const fakeRes = await apiFetch(`/api/v1/contracts/${contractId}/scan`, mgrVopA.token, {
      method: 'POST',
      body: JSON.stringify({ image_base64: fakePdfB64 }),
    });
    assert.equal(fakeRes.status, 400);
    assert.equal(fakeRes.body.code, 'VALIDATION_ERROR');

    // 4. Review Focus #3: Oversized PDF (> 10MB) -> 400 VALIDATION_ERROR
    const bigBuf = Buffer.alloc(10 * 1024 * 1024 + 256, 0x20);
    bigBuf.write('%PDF-1.4\n', 0, 'ascii');
    const bigPdfB64 = `data:application/pdf;base64,${bigBuf.toString('base64')}`;
    const bigRes = await apiFetch(`/api/v1/contracts/${contractId}/scan`, mgrVopA.token, {
      method: 'POST',
      body: JSON.stringify({ image_base64: bigPdfB64 }),
    });
    assert.equal(bigRes.status, 400, `Oversized PDF must return 400, got ${bigRes.status}`);
    assert.equal(bigRes.body.code, 'VALIDATION_ERROR');

    // 5. Default saveBase64Image (allowPdf = false, e.g. CCCD/avatar) still rejects PDF
    const nonPdfBlocked = await saveBase64Image({
      imageBase64: validPdfB64,
      folder: 'person',
      entityId: contractId,
      entity: 'person',
      ownerId: contractId,
      req: { user: { sub: mgrVopA.user.sub || mgrVopA.user.id } },
      query: () => {
        throw new Error('Should not reach DB query');
      },
    });
    assert.ok(nonPdfBlocked.error, 'Non-contract uploads must reject PDF when allowPdf is false');
    assert.equal(nonPdfBlocked.error.code, 'VALIDATION_ERROR');
  });

  await t.test('Task 4: Accompanying services[], custom service_prices[], activation notifications, initial contract_version, and expected invoice_schedule', async () => {
    const apt = await createTestApartment(vopAId, floorId, 'T4A', 12000000);
    const aptCancel = await createTestApartment(vopAId, floorId, 'T4C', 12000000);
    const aptDisc = await createTestApartment(vopAId, floorId, 'T4D', 12000000);

    const catRes = await apiFetch('/api/v1/services/catalog?active_only=true', mgrVopA.token);
    assert.equal(catRes.status, 200);
    const catalog = catRes.body.data || [];
    const internetSvc = catalog.find((s) => s.code === 'INTERNET_FIBER') || catalog.find((s) => s.billing_type === 'FIXED');
    const bikeSvc = catalog.find((s) => s.code === 'MOTORBIKE_PARKING') || catalog.find((s) => s.billing_type === 'QUANTITY');
    assert.ok(internetSvc && bikeSvc, 'Seeded service catalog must include FIXED and QUANTITY services');

    // 1. Draft creation with services[] + custom_unit_price + service_prices[]
    const tenant1 = makeUniqueTenant('T4A');
    const occ1 = makeUniqueTenant('T4OCC');
    const createRes = await apiFetch('/api/v1/contracts', mgrVopA.token, {
      method: 'POST',
      body: JSON.stringify({
        apartment_id: apt.id,
        new_tenant: tenant1,
        occupants: [{ full_name: occ1.full_name, phone: occ1.phone, id_number: occ1.id_number, relationship: 'spouse' }],
        start_date: '2027-08-01',
        end_date: '2027-11-01',
        rent_amount: 12000000,
        deposit_amount: 12000000,
        billing_cycle: 'monthly',
        billing_day: 5,
        payment_due_days: 7,
        services: [
          { service_id: internetSvc.id, quantity: 1, custom_unit_price: 185000 },
          { service_id: bikeSvc.id, quantity: 2, vehicle_plates: ['59A1-111.11', '59A1-222.22'] },
        ],
        service_prices: [{ service_code: 'ELECTRICITY', unit_price: 3600 }],
      }),
    });
    assert.equal(createRes.status, 201, `Create with services[] failed: ${JSON.stringify(createRes.body)}`);
    const cId = createRes.body.data.id;
    createdContractIds.push(cId);
    if (createRes.body.created_tenant?.person_id) createdPersonIds.push(createRes.body.created_tenant.person_id);
    for (const o of createRes.body.created_occupants || []) {
      if (o.personId) createdPersonIds.push(o.personId);
    }

    assert.equal(createRes.body.created_services?.length, 2, 'POST /contracts must return created_services');
    assert.ok(createRes.body.created_service_prices?.length >= 2, 'POST /contracts must return created_service_prices');

    // Review Focus #4: While DRAFT, service_subscription must stay PENDING_APPROVAL (not prematurely ACTIVE)
    const draftSubs = await adminPool.query(
      'SELECT status FROM service_subscription WHERE contract_id = $1',
      [cId]
    );
    assert.equal(draftSubs.rows.length, 2);
    for (const r of draftSubs.rows) {
      assert.equal(r.status, 'PENDING_APPROVAL', 'Draft contract subscriptions must be PENDING_APPROVAL');
    }

    // GET /:id returns service_subscriptions and invoice_schedule preview
    const draftDetail = await apiFetch(`/api/v1/contracts/${cId}`, mgrVopA.token);
    assert.equal(draftDetail.status, 200);
    assert.equal(draftDetail.body.data.service_subscriptions?.length, 2);
    assert.equal(draftDetail.body.data.invoice_schedule?.length, 3);
    // Expected monthly total = 12,000,000 + 185,000 + 2 * bikeSvc.unit_price
    const expectedSvcTotal = 185000 + 2 * Number(bikeSvc.unit_price);
    assert.equal(draftDetail.body.data.invoice_schedule[0].expected_fixed_services, expectedSvcTotal);
    assert.equal(draftDetail.body.data.invoice_schedule[0].expected_total, 12000000 + expectedSvcTotal);
    assert.equal(draftDetail.body.data.invoice_schedule[0].issue_date, '2027-08-05');
    assert.equal(draftDetail.body.data.invoice_schedule[0].due_date, '2027-08-12');

    // 2. Cancelling a draft cancels its PENDING_APPROVAL service_subscription rows
    const tenantCancel = makeUniqueTenant('T4C');
    const cCancelRes = await apiFetch('/api/v1/contracts', mgrVopA.token, {
      method: 'POST',
      body: JSON.stringify({
        apartment_id: aptCancel.id,
        new_tenant: tenantCancel,
        start_date: '2027-08-01',
        end_date: '2028-08-01',
        rent_amount: 12000000,
        services: [{ service_id: internetSvc.id, quantity: 1 }],
      }),
    });
    assert.equal(cCancelRes.status, 201);
    const cCancelId = cCancelRes.body.data.id;
    createdContractIds.push(cCancelId);
    if (cCancelRes.body.created_tenant?.person_id) createdPersonIds.push(cCancelRes.body.created_tenant.person_id);

    const cancelRes = await apiFetch(`/api/v1/contracts/${cCancelId}/cancel`, mgrVopA.token, {
      method: 'POST',
      body: JSON.stringify({ reason: 'Khách đổi ý không ký nữa' }),
    });
    assert.equal(cancelRes.status, 200);
    const cancelledSubs = await adminPool.query(
      'SELECT status FROM service_subscription WHERE contract_id = $1',
      [cCancelId]
    );
    assert.equal(cancelledSubs.rows[0]?.status, 'CANCELLED');

    // 3. Activating cId flips subscriptions to ACTIVE, creates initial contract_version #1, sends notifications, and returns invoice_schedule
    const pdfContent = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n', 'ascii');
    await apiFetch(`/api/v1/contracts/${cId}/scan`, mgrVopA.token, {
      method: 'POST',
      body: JSON.stringify({ file_base64: `data:application/pdf;base64,${pdfContent.toString('base64')}` }),
    });

    const actRes = await apiFetch(`/api/v1/contracts/${cId}/activate`, mgrVopA.token, { method: 'POST' });
    assert.equal(actRes.status, 200, `Activate cId failed: ${JSON.stringify(actRes.body)}`);
    assert.equal(actRes.body.invoice_schedule?.length, 3, 'Activate response must include invoice_schedule');

    const activeSubs = await adminPool.query(
      'SELECT status FROM service_subscription WHERE contract_id = $1',
      [cId]
    );
    for (const r of activeSubs.rows) {
      assert.equal(r.status, 'ACTIVE', 'Activated contract subscriptions must flip to ACTIVE');
    }

    const verRes = await adminPool.query(
      'SELECT version_no FROM contract_version WHERE contract_id = $1 ORDER BY version_no ASC',
      [cId]
    );
    assert.ok(verRes.rows.some((r) => Number(r.version_no) === 1), 'Initial contract_version #1 must be created upon activation');

    const notifsRes = await adminPool.query(
      `SELECT type, user_id, title, content FROM notification WHERE payload->>'contract_id' = $1`,
      [cId]
    );
    const notifTypes = notifsRes.rows.map((r) => r.type);
    assert.ok(notifTypes.includes('CONTRACT_ACTIVATED'), 'Must send CONTRACT_ACTIVATED notification to resident(s)');
    assert.ok(notifTypes.includes('CONTRACT_BILLING_SCHEDULED'), 'Must send CONTRACT_BILLING_SCHEDULED notification to building manager(s)');

    // 4. Discounted contract -> PENDING_APPROVAL notifies OWNER, and OWNER reject notifies MANAGER
    const tenantDisc = makeUniqueTenant('T4D');
    const cDiscRes = await apiFetch('/api/v1/contracts', mgrVopA.token, {
      method: 'POST',
      body: JSON.stringify({
        apartment_id: aptDisc.id,
        new_tenant: tenantDisc,
        start_date: '2027-09-01',
        end_date: '2028-09-01',
        rent_amount: 10000000, // < 90% of 12,000,000
        services: [{ service_id: internetSvc.id, quantity: 1 }],
      }),
    });
    assert.equal(cDiscRes.status, 201);
    const cDiscId = cDiscRes.body.data.id;
    createdContractIds.push(cDiscId);
    if (cDiscRes.body.created_tenant?.person_id) createdPersonIds.push(cDiscRes.body.created_tenant.person_id);

    await apiFetch(`/api/v1/contracts/${cDiscId}/scan`, mgrVopA.token, {
      method: 'POST',
      body: JSON.stringify({ image_base64: TINY_PNG_B64 }),
    });

    const actDisc = await apiFetch(`/api/v1/contracts/${cDiscId}/activate`, mgrVopA.token, { method: 'POST' });
    assert.equal(actDisc.status, 409);
    assert.equal(actDisc.body.code, 'PRICE_NEEDS_APPROVAL');

    const ownerNotifs = await adminPool.query(
      `SELECT type, user_id FROM notification WHERE payload->>'contract_id' = $1 AND type = 'CONTRACT_PENDING_APPROVAL'`,
      [cDiscId]
    );
    assert.ok(ownerNotifs.rows.length >= 1, 'Discounted contract must notify building OWNER');

    const rejDisc = await apiFetch(`/api/v1/contracts/${cDiscId}/reject`, ownerVop.token, {
      method: 'POST',
      body: JSON.stringify({ reason: 'Giá thấp hơn khung tối thiểu của tòa' }),
    });
    assert.equal(rejDisc.status, 200);

    const rejNotifs = await adminPool.query(
      `SELECT type, user_id FROM notification WHERE payload->>'contract_id' = $1 AND type = 'CONTRACT_PRICE_REJECTED'`,
      [cDiscId]
    );
    assert.ok(rejNotifs.rows.length >= 1, 'OWNER rejection must notify building MANAGER');
  });

  await t.test('Review Regression: UI unit_price payload, DRAFT PATCH service sync, Resident INITIAL_SNAPSHOT filter, and contract_occupant RLS', async () => {
    const apt = await createTestApartment(vopAId, floorId, 'TRV', 12000000);
    const catRes = await apiFetch('/api/v1/services/catalog?active_only=true', mgrVopA.token);
    const catalog = catRes.body.data || [];
    const internetSvc = catalog.find((s) => s.code === 'INTERNET_FIBER') || catalog.find((s) => s.billing_type === 'FIXED');
    const bikeSvc = catalog.find((s) => s.code === 'MOTORBIKE_PARKING') || catalog.find((s) => s.billing_type === 'QUANTITY');

    const resTenant = { ...makeUniqueTenant('TRV'), password: 'ResidentPassword@123' };
    const occ = makeUniqueTenant('TRVOCC');

    // 1. UI Step 4 sends { service_id, quantity, unit_price } (Critical #1)
    const createRes = await apiFetch('/api/v1/contracts', mgrVopA.token, {
      method: 'POST',
      body: JSON.stringify({
        apartment_id: apt.id,
        new_tenant: resTenant,
        occupants: [{ full_name: occ.full_name, phone: occ.phone, id_number: occ.id_number, relationship: 'spouse' }],
        start_date: '2027-08-01',
        end_date: '2027-11-01',
        rent_amount: 12000000,
        deposit_amount: 12000000,
        services: [
          { service_id: internetSvc.id, quantity: 1, unit_price: 175000 },
          { service_id: bikeSvc.id, quantity: 2, unit_price: Number(bikeSvc.unit_price), vehicle_plates: ['59A1-333.33', '59A1-444.44'] },
        ],
      }),
    });
    assert.equal(createRes.status, 201, `Create TRV contract failed: ${JSON.stringify(createRes.body)}`);
    const cId = createRes.body.data.id;
    createdContractIds.push(cId);
    if (createRes.body.created_tenant?.person_id) createdPersonIds.push(createRes.body.created_tenant.person_id);
    for (const o of createRes.body.created_occupants || []) {
      if (o.personId) createdPersonIds.push(o.personId);
    }

    const subCheck1 = await adminPool.query(
      'SELECT service_id, unit_price, prorata_amount, start_date::text AS start_date FROM service_subscription WHERE contract_id = $1',
      [cId]
    );
    const internetSub1 = subCheck1.rows.find((r) => r.service_id === internetSvc.id);
    assert.equal(Number(internetSub1.unit_price), 175000, 'Step 4 unit_price must persist to service_subscription.unit_price');
    assert.equal(Number(internetSub1.prorata_amount), 0, 'Day-1 start must have prorata_amount = 0');

    const cspCheck1 = await adminPool.query(
      'SELECT service_code, unit_price, effective_from::text AS effective_from FROM contract_service_price WHERE contract_id = $1',
      [cId]
    );
    assert.equal(cspCheck1.rows.length, 1, 'Only overridden service price (not unchanged default catalog price) should create contract_service_price');
    assert.equal(Number(cspCheck1.rows[0].unit_price), 175000);
    assert.equal(cspCheck1.rows[0].effective_from, '2027-08-01');

    // 2. PATCH /:id on DRAFT shifting start_date -> syncs service_subscription & contract_service_price (Important #4)
    const patchRes = await apiFetch(`/api/v1/contracts/${cId}`, mgrVopA.token, {
      method: 'PATCH',
      body: JSON.stringify({
        start_date: '2027-08-16',
        end_date: '2027-11-16',
      }),
    });
    assert.equal(patchRes.status, 200);

    const subCheck2 = await adminPool.query(
      'SELECT service_id, prorata_amount, start_date::text AS start_date FROM service_subscription WHERE contract_id = $1',
      [cId]
    );
    const internetSub2 = subCheck2.rows.find((r) => r.service_id === internetSvc.id);
    assert.equal(internetSub2.start_date, '2027-08-16', 'PATCH draft start_date must sync service_subscription.start_date');
    assert.ok(Number(internetSub2.prorata_amount) > 0, 'Mid-month draft shift must recalculate prorata_amount > 0');

    const cspCheck2 = await adminPool.query(
      'SELECT effective_from::text AS effective_from FROM contract_service_price WHERE contract_id = $1',
      [cId]
    );
    assert.equal(cspCheck2.rows[0].effective_from, '2027-08-16', 'PATCH draft start_date must shift contract_service_price.effective_from');

    // 3. Direct DB RLS blocks SYS_ADMIN from deleting/modifying contract_occupant (Important #3)
    const rlsClient = await appPool.connect();
    try {
      await rlsClient.query('BEGIN');
      await rlsClient.query(`SELECT set_config('app.current_user_id', $1, true)`, [String(sysAdmin.user.sub || sysAdmin.user.id)]);
      await rlsClient.query(`SELECT set_config('app.current_org_id', $1, true)`, [String(orgId)]);
      await rlsClient.query(`SELECT set_config('app.current_roles', 'SYS_ADMIN', true)`);
      const delOcc = await rlsClient.query('DELETE FROM contract_occupant WHERE contract_id = $1 RETURNING id', [cId]);
      assert.equal(delOcc.rowCount, 0, 'RLS must block SYS_ADMIN from deleting contract_occupant rows');
      await rlsClient.query('ROLLBACK');
    } finally {
      rlsClient.release();
    }

    // 4. Activate contract and verify Resident overview does NOT leak INITIAL_SNAPSHOT as an amendment (Important #2)
    await apiFetch(`/api/v1/contracts/${cId}/scan`, mgrVopA.token, {
      method: 'POST',
      body: JSON.stringify({ image_base64: TINY_PNG_B64 }),
    });
    const actRes = await apiFetch(`/api/v1/contracts/${cId}/activate`, mgrVopA.token, { method: 'POST' });
    assert.equal(actRes.status, 200);

    const resAuth = await login(resTenant.email, 'ResidentPassword@123');
    const overviewRes = await apiFetch('/api/v1/resident/overview', resAuth.token);
    assert.equal(overviewRes.status, 200);
    const resAmendments = overviewRes.body.data?.amendments || [];
    assert.ok(
      !resAmendments.some((a) => a.diff?.status === 'INITIAL_SNAPSHOT'),
      'Resident overview amendments must exclude INITIAL_SNAPSHOT version #1'
    );
  });
});
