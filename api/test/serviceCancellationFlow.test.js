import { test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';

dotenv.config({ path: fileURLToPath(new URL('../.env', import.meta.url)) });
dotenv.config();

const API_BASE = process.env.API_BASE || 'http://127.0.0.1:5000';
const ADMIN_DB_URL =
  process.env.DATABASE_URL ||
  process.env.ADMIN_DATABASE_URL ||
  'postgres://postgres:postgres@127.0.0.1:5433/resihub';

const adminPool = new pg.Pool({
  connectionString: ADMIN_DB_URL,
  options: '-c timezone=Asia/Ho_Chi_Minh',
});

async function apiJson(urlPath, token, options = {}) {
  const headers = {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(options.headers || {}),
  };
  const res = await fetch(`${API_BASE}${urlPath}`, {
    ...options,
    headers,
  });
  let body = null;
  const rawText = await res.text();
  try {
    body = JSON.parse(rawText);
  } catch {
    body = { raw: rawText };
  }
  return {
    status: res.status,
    headers: res.headers,
    body,
    rawText,
  };
}

async function login(email, password = 'Demo@123456') {
  const res = await apiJson('/api/v1/auth/login', null, {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
  assert.equal(res.status, 200, `Login failed for ${email}: ${JSON.stringify(res.body)}`);
  return { token: res.body.accessToken, user: res.body.user };
}

test('Task 4: Service Catalog Multi-Building Guard & FORCE RLS-Safe Resident Routes', async (t) => {
  const suffix = String(Date.now()).slice(-6);

  const cleanup = {
    catalogIds: [],
    subscriptionIds: [],
    contractPriceIds: [],
    invoiceIds: [],
    paymentIds: [],
    creditIds: [],
    adjustmentIds: [],
  };

  t.after(async () => {
    try {
      if (cleanup.paymentIds.length > 0) {
        await adminPool.query('DELETE FROM payment WHERE id = ANY($1::uuid[])', [cleanup.paymentIds]).catch(() => {});
      }
      if (cleanup.adjustmentIds.length > 0) {
        await adminPool.query('DELETE FROM invoice_adjustment WHERE id = ANY($1::uuid[])', [cleanup.adjustmentIds]).catch(() => {});
      }
      if (cleanup.invoiceIds.length > 0) {
        await adminPool.query('DELETE FROM invoice_line WHERE invoice_id = ANY($1::uuid[])', [cleanup.invoiceIds]).catch(() => {});
        await adminPool.query('DELETE FROM invoice WHERE id = ANY($1::uuid[])', [cleanup.invoiceIds]).catch(() => {});
      }
      if (cleanup.subscriptionIds.length > 0) {
        await adminPool.query('DELETE FROM notification WHERE payload->>\'subscription_id\' = ANY($1::text[])', [cleanup.subscriptionIds]).catch(() => {});
        await adminPool.query('DELETE FROM service_subscription WHERE id = ANY($1::uuid[])', [cleanup.subscriptionIds]).catch(() => {});
      }
      if (cleanup.contractPriceIds.length > 0) {
        await adminPool.query('DELETE FROM contract_service_price WHERE id = ANY($1::uuid[])', [cleanup.contractPriceIds]).catch(() => {});
      }
      if (cleanup.creditIds.length > 0) {
        await adminPool.query('DELETE FROM credit_balance WHERE id = ANY($1::uuid[])', [cleanup.creditIds]).catch(() => {});
      }
      if (cleanup.catalogIds.length > 0) {
        await adminPool.query('DELETE FROM service_catalog WHERE id = ANY($1::uuid[])', [cleanup.catalogIds]).catch(() => {});
      }
    } finally {
      await adminPool.end();
    }
  });

  // Fetch building references
  const vopARes = await adminPool.query("SELECT id, org_id FROM building WHERE code = 'VOP-A' LIMIT 1");
  const vopBRes = await adminPool.query("SELECT id, org_id FROM building WHERE code = 'VOP-B' LIMIT 1");
  assert.ok(vopARes.rows.length > 0, 'Building VOP-A must exist');
  assert.ok(vopBRes.rows.length > 0, 'Building VOP-B must exist');
  const vopAId = vopARes.rows[0].id;
  const vopBId = vopBRes.rows[0].id;
  const orgId = vopARes.rows[0].org_id;

  // Logins
  const sysAdmin = await login('admin@resihub.vn', 'Admin@123456');
  const managerVopA = await login('manager.vop.a@resihub.vn', 'Demo@123456');
  const resident = await login('tenant1@resihub.vn', 'Demo@123456');

  // Find resident active contract in VOP-A
  const residentContractRes = await adminPool.query(`
    SELECT c.id, c.apartment_id, c.building_id, c.primary_tenant_id, t.person_id
    FROM contract c
    JOIN tenant t ON t.id = c.primary_tenant_id
    JOIN person p ON p.id = t.person_id
    WHERE p.email = 'tenant1@resihub.vn' AND c.status = 'ACTIVE' AND c.building_id = $1
    LIMIT 1
  `, [vopAId]);
  assert.ok(residentContractRes.rows.length > 0, 'tenant1 must have active contract in VOP-A');
  const residentContract = residentContractRes.rows[0];

  // =========================================================================
  // SUBTEST 1: SYS_ADMIN role restriction, MANAGER audit_log, building scoping,
  // and FR-070 multi-building org-default catalog guard
  // =========================================================================
  await t.test('1. SYS_ADMIN 403 on catalog POST & subscription PATCH; MANAGER audit_log, building scoping & FR-070 guard', async () => {
    // 1a. SYS_ADMIN gets 403 on POST /api/v1/service-catalog (PRD 6.2)
    const sysAdminPostCat = await apiJson('/api/v1/service-catalog', sysAdmin.token, {
      method: 'POST',
      body: JSON.stringify({
        code: `SVC_SA_${suffix}`,
        name: 'Service by SysAdmin',
        category: 'UTILITY',
        billing_type: 'FIXED',
        unit: 'tháng',
        unit_price: 100000,
      }),
    });
    assert.equal(
      sysAdminPostCat.status,
      403,
      `SYS_ADMIN must receive 403 on POST /api/v1/service-catalog (got ${sysAdminPostCat.status})`
    );

    // Create a dummy subscription to test SYS_ADMIN PATCH
    const dummyCatRes = await adminPool.query(`
      INSERT INTO service_catalog (org_id, building_id, code, name, category, billing_type, unit, unit_price)
      VALUES ($1, $2, $3, 'Dummy Cat', 'UTILITY', 'FIXED', 'tháng', 50000)
      RETURNING id
    `, [orgId, vopAId, `SVC_DUMMY_${suffix}`]);
    cleanup.catalogIds.push(dummyCatRes.rows[0].id);

    const dummySubRes = await adminPool.query(`
      INSERT INTO service_subscription (
        org_id, building_id, apartment_id, contract_id, service_id,
        quantity, unit_price, start_date, status
      )
      VALUES ($1, $2, $3, $4, $5, 1, 50000, '2026-06-01', 'ACTIVE')
      RETURNING id
    `, [orgId, vopAId, residentContract.apartment_id, residentContract.id, dummyCatRes.rows[0].id]);
    cleanup.subscriptionIds.push(dummySubRes.rows[0].id);

    // 1b. SYS_ADMIN gets 403 on PATCH /api/v1/service-subscriptions/:id (PRD 6.2)
    const sysAdminPatchSub = await apiJson(`/api/v1/service-subscriptions/${dummySubRes.rows[0].id}`, sysAdmin.token, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'TERMINATED' }),
    });
    assert.equal(
      sysAdminPatchSub.status,
      403,
      `SYS_ADMIN must receive 403 on PATCH /api/v1/service-subscriptions/:id (got ${sysAdminPatchSub.status})`
    );

    // 1c. MANAGER VOP-A gets 403 on unassigned building (VOP-B) for POST /api/v1/service-catalog
    const mgrPostUnassigned = await apiJson('/api/v1/service-catalog', managerVopA.token, {
      method: 'POST',
      body: JSON.stringify({
        code: `SVC_UNASSIGNED_${suffix}`,
        name: 'Service in VOP-B',
        category: 'UTILITY',
        billing_type: 'FIXED',
        unit: 'tháng',
        unit_price: 150000,
        building_id: vopBId,
      }),
    });
    assert.equal(
      mgrPostUnassigned.status,
      403,
      `MANAGER must receive 403 when creating catalog item in unassigned building (got ${mgrPostUnassigned.status})`
    );

    // Verify ACCESS_DENIED in audit_log
    const auditDenyRes = await adminPool.query(`
      SELECT * FROM audit_log
      WHERE actor_id = $1 AND action = 'ACCESS_DENIED' AND entity = 'service_catalog'
      ORDER BY at DESC LIMIT 1
    `, [managerVopA.user.sub]);
    assert.ok(auditDenyRes.rows.length > 0, 'ACCESS_DENIED must be logged in audit_log for unauthorized building');

    // 1d. MANAGER VOP-A successfully creates catalog item for VOP-A with audit_log
    const mgrPostAssigned = await apiJson('/api/v1/service-catalog', managerVopA.token, {
      method: 'POST',
      headers: { 'Idempotency-Key': `idem-cat-create-${suffix}` },
      body: JSON.stringify({
        code: `SVC_VOPA_${suffix}`,
        name: 'VOP-A Service',
        category: 'CLEANING',
        billing_type: 'FIXED',
        unit: 'lần',
        unit_price: 80000,
        building_id: vopAId,
      }),
    });
    assert.equal(mgrPostAssigned.status, 201, `MANAGER must get 201 creating assigned catalog item: ${JSON.stringify(mgrPostAssigned.body)}`);
    const createdCat = mgrPostAssigned.body.data;
    cleanup.catalogIds.push(createdCat.id);

    // Verify CREATE_SERVICE_CATALOG audit_log
    const auditCreateRes = await adminPool.query(`
      SELECT * FROM audit_log
      WHERE actor_id = $1 AND action = 'CREATE_SERVICE_CATALOG' AND entity_id = $2
    `, [managerVopA.user.sub, createdCat.id]);
    assert.ok(auditCreateRes.rows.length > 0, 'CREATE_SERVICE_CATALOG audit_log must be written');

    // 1e. FR-070: Shared org-default catalog item (building_id IS NULL)
    // Create an org-default service catalog item
    const orgDefCode = `SVC_SHARED_${suffix}`;
    const orgDefCatRes = await adminPool.query(`
      INSERT INTO service_catalog (org_id, building_id, code, name, category, billing_type, unit, unit_price)
      VALUES ($1, NULL, $2, 'Shared Org Default Svc', 'UTILITY', 'FIXED', 'tháng', 200000)
      RETURNING id
    `, [orgId, orgDefCode]);
    const orgDefCatId = orgDefCatRes.rows[0].id;
    cleanup.catalogIds.push(orgDefCatId);

    // Create an apartment in VOP-B and subscription referencing orgDefCatId in VOP-B (unassigned to managerVopA)
    const vopBAptRes = await adminPool.query(`
      SELECT a.id FROM apartment a WHERE a.building_id = $1 LIMIT 1
    `, [vopBId]);
    assert.ok(vopBAptRes.rows.length > 0, 'Must have apartment in VOP-B');
    const vopBAptId = vopBAptRes.rows[0].id;

    const subVopBRes = await adminPool.query(`
      INSERT INTO service_subscription (
        org_id, building_id, apartment_id, service_id,
        quantity, unit_price, start_date, status
      )
      VALUES ($1, $2, $3, $4, 1, 200000, '2026-06-01', 'ACTIVE')
      RETURNING id
    `, [orgId, vopBId, vopBAptId, orgDefCatId]);
    cleanup.subscriptionIds.push(subVopBRes.rows[0].id);

    // Manager VOP-A attempts to PATCH the org-default row -> 403 ORG_DEFAULT_SHARED_ACROSS_BUILDINGS
    const patchSharedRes = await apiJson(`/api/v1/service-catalog/${orgDefCatId}`, managerVopA.token, {
      method: 'PATCH',
      headers: { 'Idempotency-Key': `idem-patch-shared-${suffix}` },
      body: JSON.stringify({ unit_price: 250000 }),
    });
    assert.equal(
      patchSharedRes.status,
      403,
      `Shared org-default PATCH must be rejected with 403 (got ${patchSharedRes.status}: ${JSON.stringify(patchSharedRes.body)})`
    );
    assert.equal(
      patchSharedRes.body.code,
      'ORG_DEFAULT_SHARED_ACROSS_BUILDINGS',
      `Error code must be ORG_DEFAULT_SHARED_ACROSS_BUILDINGS (got ${patchSharedRes.body.code})`
    );

    // 1f. Now create a building override for VOP-B so the org-default is NO LONGER unshared across buildings without override
    const vopBOverrideRes = await adminPool.query(`
      INSERT INTO service_catalog (org_id, building_id, code, name, category, billing_type, unit, unit_price, is_active)
      VALUES ($1, $2, $3, 'VOP-B Specific Override', 'UTILITY', 'FIXED', 'tháng', 210000, TRUE)
      RETURNING id
    `, [orgId, vopBId, orgDefCode]);
    cleanup.catalogIds.push(vopBOverrideRes.rows[0].id);

    // Now Manager VOP-A attempts PATCH again -> should SUCCEED with 200!
    const patchUnsharedRes = await apiJson(`/api/v1/service-catalog/${orgDefCatId}`, managerVopA.token, {
      method: 'PATCH',
      headers: { 'Idempotency-Key': `idem-patch-unshared-${suffix}` },
      body: JSON.stringify({ unit_price: 220000, name: 'Shared Org Default Svc Updated' }),
    });
    assert.equal(
      patchUnsharedRes.status,
      200,
      `Unshared org-default PATCH must return 200 (got ${patchUnsharedRes.status}: ${JSON.stringify(patchUnsharedRes.body)})`
    );
    assert.equal(Number(patchUnsharedRes.body.data.unit_price), 220000);

    // Verify UPDATE_SERVICE_CATALOG audit_log with before and after
    const auditUpdateRes = await adminPool.query(`
      SELECT * FROM audit_log
      WHERE actor_id = $1 AND action = 'UPDATE_SERVICE_CATALOG' AND entity_id = $2
    `, [managerVopA.user.sub, orgDefCatId]);
    assert.ok(auditUpdateRes.rows.length > 0, 'UPDATE_SERVICE_CATALOG audit_log must be written');
    assert.ok(auditUpdateRes.rows[0].before, 'audit_log must contain before snapshot');
    assert.ok(auditUpdateRes.rows[0].after, 'audit_log must contain after snapshot');
  });

  // =========================================================================
  // SUBTEST 2: Pre-start_date cancel, Idempotency-Key replay, withdraw-cancel
  // and Manager 0 VND termination
  // =========================================================================
  await t.test('2. Pre-start_date cancel + Idempotency-Key replay + withdraw-cancel + Manager TERMINATED (0 VND)', async () => {
    // Create a service catalog item
    const preCatRes = await adminPool.query(`
      INSERT INTO service_catalog (org_id, building_id, code, name, category, billing_type, unit, unit_price)
      VALUES ($1, $2, $3, 'Pre-start Gym Access', 'UTILITY', 'FIXED', 'tháng', 300000)
      RETURNING id
    `, [orgId, vopAId, `SVC_PRE_${suffix}`]);
    const preCatId = preCatRes.rows[0].id;
    cleanup.catalogIds.push(preCatId);

    // Future start_date: 2026-12-01
    const futureStartDate = '2026-12-01';

    // 2a. Resident subscribes via POST /api/v1/resident/services
    const subReq = await apiJson('/api/v1/resident/services', resident.token, {
      method: 'POST',
      headers: { 'Idempotency-Key': `idem-res-sub-${suffix}` },
      body: JSON.stringify({
        service_id: preCatId,
        quantity: 1,
        start_date: futureStartDate,
        contract_id: residentContract.id,
      }),
    });
    assert.equal(subReq.status, 201, `Resident subscription must be created with 201: ${JSON.stringify(subReq.body)}`);
    const subId = subReq.body.data.id;
    cleanup.subscriptionIds.push(subId);
    assert.equal(subReq.body.data.status, 'PENDING_APPROVAL');

    // 2b. Manager approves subscription -> ACTIVE
    const mgrApprove = await apiJson(`/api/v1/service-subscriptions/${subId}`, managerVopA.token, {
      method: 'PATCH',
      headers: { 'Idempotency-Key': `idem-mgr-approve-${suffix}` },
      body: JSON.stringify({ status: 'ACTIVE' }),
    });
    assert.equal(mgrApprove.status, 200);
    assert.equal(mgrApprove.body.data.status, 'ACTIVE');

    // 2c. Pre-start cancellation by resident
    // Resident calls PATCH /api/v1/resident/services/:id/cancel
    const idemKeyCancel = `idem-res-cancel-${suffix}`;
    const cancelRes = await apiJson(`/api/v1/resident/services/${subId}/cancel`, resident.token, {
      method: 'PATCH',
      headers: { 'Idempotency-Key': idemKeyCancel },
      body: JSON.stringify({ note: 'Plans changed before start' }),
    });
    assert.equal(cancelRes.status, 200, `Pre-start cancel must return 200: ${JSON.stringify(cancelRes.body)}`);
    assert.equal(cancelRes.body.data.status, 'CANCELLATION_PENDING');
    assert.equal(Number(cancelRes.body.data.prorata_amount), 0, 'Pre-start cancel prorata must be 0 VND');
    assert.equal(cancelRes.body.data.end_date, '2026-11-30', 'Pre-start cancel end_date must be addDaysYmd(start_date, -1)');

    // 2d. Idempotency replay verification
    const cancelReplay = await apiJson(`/api/v1/resident/services/${subId}/cancel`, resident.token, {
      method: 'PATCH',
      headers: { 'Idempotency-Key': idemKeyCancel },
      body: JSON.stringify({ note: 'Plans changed before start' }),
    });
    assert.equal(cancelReplay.status, 200);
    assert.equal(
      cancelReplay.headers.get('idempotent-replayed') || cancelReplay.headers.get('Idempotent-Replayed'),
      'true',
      'Replay must contain Idempotent-Replayed: true header'
    );
    assert.equal(cancelReplay.body.data.id, subId);

    // 2e. Resident withdraws cancellation via PATCH /api/v1/resident/services/:id/withdraw-cancel
    const withdrawRes = await apiJson(`/api/v1/resident/services/${subId}/withdraw-cancel`, resident.token, {
      method: 'PATCH',
      headers: { 'Idempotency-Key': `idem-res-withdraw-${suffix}` },
    });
    assert.equal(withdrawRes.status, 200, `Withdraw cancel must return 200: ${JSON.stringify(withdrawRes.body)}`);
    assert.equal(withdrawRes.body.data.status, 'ACTIVE');
    assert.equal(withdrawRes.body.data.end_date, null, 'end_date must be cleared on withdraw-cancel');

    // 2f. Manager terminates subscription with zero_usage / pre-start -> TERMINATED (0 VND)
    const mgrTerminate = await apiJson(`/api/v1/service-subscriptions/${subId}`, managerVopA.token, {
      method: 'PATCH',
      headers: { 'Idempotency-Key': `idem-mgr-term-${suffix}` },
      body: JSON.stringify({ status: 'TERMINATED', zero_usage: true }),
    });
    assert.equal(mgrTerminate.status, 200, `Manager terminate must return 200: ${JSON.stringify(mgrTerminate.body)}`);
    assert.equal(mgrTerminate.body.data.status, 'TERMINATED');
    assert.equal(Number(mgrTerminate.body.data.prorata_amount), 0, 'Terminated pre-start prorata must be 0 VND');
    assert.ok(mgrTerminate.body.invoice_sync, 'Response must include invoice_sync object');

    // 2g. Mutating a TERMINATED subscription must return 409 INVALID_STATUS
    const mutateTerminated = await apiJson(`/api/v1/service-subscriptions/${subId}`, managerVopA.token, {
      method: 'PATCH',
      body: JSON.stringify({ quantity: 2 }),
    });
    assert.equal(mutateTerminated.status, 409, 'Mutating TERMINATED subscription must return 409');
    assert.equal(mutateTerminated.body.code, 'INVALID_STATUS');
  });

  // =========================================================================
  // SUBTEST 3: Mid-term 3 scenarios (UNBILLED, DRAFT, PAID) +
  // Review Focus #1 Pin: RESIDENT payments/report 201 under FORCE RLS
  // =========================================================================
  await t.test('3. Mid-term 3 scenarios & Review Focus #1: RESIDENT payments/report 201 under FORCE RLS', async () => {
    // Create catalog item for mid-term tests
    const midCatRes = await adminPool.query(`
      INSERT INTO service_catalog (org_id, building_id, code, name, category, billing_type, unit, unit_price)
      VALUES ($1, $2, $3, 'Fiber Internet 100M', 'INTERNET', 'FIXED', 'tháng', 250000)
      RETURNING id
    `, [orgId, vopAId, `INTERNET_FIBER_${suffix}`]);
    const midCatId = midCatRes.rows[0].id;
    cleanup.catalogIds.push(midCatId);

    // Scenario 1: UNBILLED period
    // Create active subscription starting 2026-01-01
    const subUnbilledRes = await adminPool.query(`
      INSERT INTO service_subscription (
        org_id, building_id, apartment_id, contract_id, service_id,
        quantity, unit_price, start_date, status, is_price_locked
      )
      VALUES ($1, $2, $3, $4, $5, 1, 250000, '2026-01-01', 'ACTIVE', FALSE)
      RETURNING *
    `, [orgId, vopAId, residentContract.apartment_id, residentContract.id, midCatId]);
    const subUnbilled = subUnbilledRes.rows[0];
    cleanup.subscriptionIds.push(subUnbilled.id);

    // Manager terminates subscription mid-month 2026-07-15 where no invoice exists for 2026-07
    const mgrTermUnbilled = await apiJson(`/api/v1/service-subscriptions/${subUnbilled.id}`, managerVopA.token, {
      method: 'PATCH',
      headers: { 'Idempotency-Key': `idem-term-unbilled-${suffix}` },
      body: JSON.stringify({ status: 'TERMINATED', end_date: '2026-07-15' }),
    });
    assert.equal(mgrTermUnbilled.status, 200);
    assert.equal(mgrTermUnbilled.body.data.status, 'TERMINATED');
    assert.equal(mgrTermUnbilled.body.invoice_sync.scenario, 'UNBILLED');

    // Scenario 2: DRAFT invoice exists for period
    // Create subscription for draft scenario
    const subDraftRes = await adminPool.query(`
      INSERT INTO service_subscription (
        org_id, building_id, apartment_id, contract_id, service_id,
        quantity, unit_price, start_date, status, is_price_locked
      )
      VALUES ($1, $2, $3, $4, $5, 1, 250000, '2026-01-01', 'ACTIVE', FALSE)
      RETURNING *
    `, [orgId, vopAId, residentContract.apartment_id, residentContract.id, midCatId]);
    const subDraft = subDraftRes.rows[0];
    cleanup.subscriptionIds.push(subDraft.id);

    // Create DRAFT invoice for 2026-08
    const draftInvRes = await adminPool.query(`
      INSERT INTO invoice (
        org_id, building_id, apartment_id, contract_id, tenant_id,
        invoice_code, period, status, total_amount, paid_amount, subtotal_amount, issue_date, due_date
      )
      VALUES ($1, $2, $3, $4, $5, $6, '2026-08', 'DRAFT', 250000, 0, 250000, '2026-08-01', '2026-08-10')
      RETURNING *
    `, [orgId, vopAId, residentContract.apartment_id, residentContract.id, residentContract.primary_tenant_id, `INV-DRAFT-${suffix}`]);
    const draftInv = draftInvRes.rows[0];
    cleanup.invoiceIds.push(draftInv.id);

    await adminPool.query(`
      INSERT INTO invoice_line (
        invoice_id, item_type, description, quantity, unit, unit_price, amount, subscription_id
      )
      VALUES ($1, 'SERVICE', 'Fiber Internet kỳ 2026-08', 1, 'tháng', 250000, 250000, $2)
    `, [draftInv.id, subDraft.id]);

    // Verify DRAFT hiding from RESIDENT (AC-003.2):
    // 1. GET /api/v1/resident/overview does NOT show draftInv in latest_invoice
    const resOverview = await apiJson('/api/v1/resident/overview', resident.token);
    assert.equal(resOverview.status, 200);
    assert.notEqual(resOverview.body.data.latest_invoice?.id, draftInv.id, 'DRAFT invoice must NOT be exposed in resident overview');
    assert.ok('available_credit_balance' in resOverview.body.data, 'Overview must expose available_credit_balance');

    // 2. GET /api/v1/resident/invoices does NOT return draftInv
    const resInvoices = await apiJson('/api/v1/resident/invoices', resident.token);
    assert.equal(resInvoices.status, 200);
    const foundDraft = resInvoices.body.data.find((i) => i.id === draftInv.id);
    assert.equal(foundDraft, undefined, 'DRAFT invoice must NOT appear in resident invoices list');

    // 3. POST /api/v1/resident/payments/report on DRAFT invoice returns 404 (or 409 INVALID_STATUS)
    const resPayDraft = await apiJson('/api/v1/resident/payments/report', resident.token, {
      method: 'POST',
      body: JSON.stringify({
        invoice_id: draftInv.id,
        amount: 250000,
        method: 'BANK_TRANSFER',
      }),
    });
    assert.ok(
      [404, 409].includes(resPayDraft.status),
      `POST /payments/report on DRAFT invoice must be rejected with 404 or 409 (got ${resPayDraft.status})`
    );

    // Scenario 3 & Review Focus #1 Pin:
    // Create an ISSUED invoice for period 2026-06
    const issuedInvRes = await adminPool.query(`
      INSERT INTO invoice (
        org_id, building_id, apartment_id, contract_id, tenant_id,
        invoice_code, period, status, total_amount, paid_amount, subtotal_amount, issue_date, due_date
      )
      VALUES ($1, $2, $3, $4, $5, $6, '2026-06', 'ISSUED', 500000, 0, 500000, '2026-06-01', '2026-06-10')
      RETURNING *
    `, [orgId, vopAId, residentContract.apartment_id, residentContract.id, residentContract.primary_tenant_id, `INV-ISSUED-${suffix}`]);
    const issuedInv = issuedInvRes.rows[0];
    cleanup.invoiceIds.push(issuedInv.id);

    await adminPool.query(`
      INSERT INTO invoice_line (
        invoice_id, item_type, description, quantity, unit, unit_price, amount, subscription_id
      )
      VALUES ($1, 'SERVICE', 'Fiber Internet kỳ 2026-06', 1, 'tháng', 250000, 250000, $2)
    `, [issuedInv.id, subUnbilled.id]);

    // *** REVIEW FOCUS #1 PIN ***
    // RESIDENT calling POST /api/v1/resident/payments/report on an ISSUED invoice
    // MUST succeed with 201 (PENDING_CONFIRMATION) under FORCE ROW LEVEL SECURITY (never returning 404!)
    const reportPayRes = await apiJson('/api/v1/resident/payments/report', resident.token, {
      method: 'POST',
      headers: { 'Idempotency-Key': `idem-res-report-pay-${suffix}` },
      body: JSON.stringify({
        invoice_id: issuedInv.id,
        amount: 500000,
        method: 'BANK_TRANSFER',
        reference_code: `REF-${suffix}`,
      }),
    });
    assert.equal(
      reportPayRes.status,
      201,
      `Review Focus #1: Resident payment report on ISSUED invoice under FORCE RLS must return 201 (got ${reportPayRes.status}: ${JSON.stringify(reportPayRes.body)})`
    );
    assert.equal(reportPayRes.body.data.status, 'PENDING_CONFIRMATION');
    assert.equal(reportPayRes.body.data.invoice_id, issuedInv.id);
    cleanup.paymentIds.push(reportPayRes.body.data.id);

    // Verify payment exists in database
    const dbPay = await adminPool.query('SELECT * FROM payment WHERE id = $1', [reportPayRes.body.data.id]);
    assert.equal(dbPay.rows.length, 1);
    assert.equal(dbPay.rows[0].status, 'PENDING_CONFIRMATION');

    // 3b. Verify rejecting payments on VOID invoices with 409 INVALID_STATUS
    const voidInvRes = await adminPool.query(`
      INSERT INTO invoice (
        org_id, building_id, apartment_id, contract_id, tenant_id,
        invoice_code, period, status, total_amount, paid_amount, subtotal_amount, issue_date, due_date
      )
      VALUES ($1, $2, $3, $4, $5, $6, '2026-05', 'VOID', 200000, 0, 200000, '2026-05-01', '2026-05-10')
      RETURNING *
    `, [orgId, vopAId, residentContract.apartment_id, residentContract.id, residentContract.primary_tenant_id, `INV-VOID-${suffix}`]);
    const voidInv = voidInvRes.rows[0];
    cleanup.invoiceIds.push(voidInv.id);

    const payVoidRes = await apiJson('/api/v1/resident/payments/report', resident.token, {
      method: 'POST',
      body: JSON.stringify({
        invoice_id: voidInv.id,
        amount: 200000,
        method: 'BANK_TRANSFER',
      }),
    });
    assert.equal(payVoidRes.status, 409, `Payment on VOID invoice must return 409 (got ${payVoidRes.status})`);
    assert.equal(payVoidRes.body.code, 'INVALID_STATUS');

    // 3c. Verify rejecting payments on fully paid invoices with 409 ALREADY_PAID
    const paidInvRes = await adminPool.query(`
      INSERT INTO invoice (
        org_id, building_id, apartment_id, contract_id, tenant_id,
        invoice_code, period, status, total_amount, paid_amount, subtotal_amount, issue_date, due_date
      )
      VALUES ($1, $2, $3, $4, $5, $6, '2026-04', 'PAID', 300000, 300000, 300000, '2026-04-01', '2026-04-10')
      RETURNING *
    `, [orgId, vopAId, residentContract.apartment_id, residentContract.id, residentContract.primary_tenant_id, `INV-PAID-${suffix}`]);
    const paidInv = paidInvRes.rows[0];
    cleanup.invoiceIds.push(paidInv.id);

    const payAlreadyPaidRes = await apiJson('/api/v1/resident/payments/report', resident.token, {
      method: 'POST',
      body: JSON.stringify({
        invoice_id: paidInv.id,
        amount: 300000,
        method: 'BANK_TRANSFER',
      }),
    });
    assert.equal(payAlreadyPaidRes.status, 409, `Payment on fully paid invoice must return 409 (got ${payAlreadyPaidRes.status})`);
    assert.equal(payAlreadyPaidRes.body.code, 'ALREADY_PAID');

    // 3d. Mid-term termination on Month 6 PAID invoice creating PENDING_APPROVAL invoice_adjustment
    // while keeping Months 1..5 intact!
    const subMidPaidRes = await adminPool.query(`
      INSERT INTO service_subscription (
        org_id, building_id, apartment_id, contract_id, service_id,
        quantity, unit_price, start_date, status, is_price_locked
      )
      VALUES ($1, $2, $3, $4, $5, 1, 250000, '2026-01-01', 'ACTIVE', FALSE)
      RETURNING *
    `, [orgId, vopAId, residentContract.apartment_id, residentContract.id, midCatId]);
    const subMidPaid = subMidPaidRes.rows[0];
    cleanup.subscriptionIds.push(subMidPaid.id);

    // Create Month 5 invoice (PAID) for 2026-09 and Month 6 invoice (PAID) for 2026-10
    const m5InvRes = await adminPool.query(`
      INSERT INTO invoice (
        org_id, building_id, apartment_id, contract_id, tenant_id,
        invoice_code, period, status, total_amount, paid_amount, subtotal_amount, issue_date, due_date
      )
      VALUES ($1, $2, $3, $4, $5, $6, '2026-09', 'PAID', 250000, 250000, 250000, '2026-09-01', '2026-09-10')
      RETURNING *
    `, [orgId, vopAId, residentContract.apartment_id, residentContract.id, residentContract.primary_tenant_id, `INV-M05-${suffix}`]);
    const m5Inv = m5InvRes.rows[0];
    cleanup.invoiceIds.push(m5Inv.id);

    await adminPool.query(`
      INSERT INTO invoice_line (invoice_id, item_type, description, quantity, unit, unit_price, amount, subscription_id)
      VALUES ($1, 'SERVICE', 'Fiber Internet kỳ 2026-09', 1, 'tháng', 250000, 250000, $2)
    `, [m5Inv.id, subMidPaid.id]);

    const m6InvRes = await adminPool.query(`
      INSERT INTO invoice (
        org_id, building_id, apartment_id, contract_id, tenant_id,
        invoice_code, period, status, total_amount, paid_amount, subtotal_amount, issue_date, due_date
      )
      VALUES ($1, $2, $3, $4, $5, $6, '2026-10', 'PAID', 250000, 250000, 250000, '2026-10-01', '2026-10-10')
      RETURNING *
    `, [orgId, vopAId, residentContract.apartment_id, residentContract.id, residentContract.primary_tenant_id, `INV-M06-${suffix}`]);
    const m6Inv = m6InvRes.rows[0];
    cleanup.invoiceIds.push(m6Inv.id);

    await adminPool.query(`
      INSERT INTO invoice_line (invoice_id, item_type, description, quantity, unit, unit_price, amount, subscription_id)
      VALUES ($1, 'SERVICE', 'Fiber Internet kỳ 2026-10', 1, 'tháng', 250000, 250000, $2)
    `, [m6Inv.id, subMidPaid.id]);

    // Manager terminates subMidPaid on 2026-10-15 (mid month 6)
    const termPaidSubRes = await apiJson(`/api/v1/service-subscriptions/${subMidPaid.id}`, managerVopA.token, {
      method: 'PATCH',
      headers: { 'Idempotency-Key': `idem-term-m6-${suffix}` },
      body: JSON.stringify({ status: 'TERMINATED', end_date: '2026-10-15' }),
    });
    assert.equal(termPaidSubRes.status, 200);
    assert.equal(termPaidSubRes.body.invoice_sync?.scenario, 'ADJUSTMENT_CREATED');
    assert.equal(termPaidSubRes.body.invoice_sync.createdAdjustments.length, 1);
    const createdAdj = termPaidSubRes.body.invoice_sync.createdAdjustments[0];
    cleanup.adjustmentIds.push(createdAdj.id);
    assert.equal(createdAdj.invoice_id, m6Inv.id);
    assert.equal(createdAdj.status, 'PENDING_APPROVAL');
    assert.equal(createdAdj.adjustment_target, 'SERVICE');
    assert.ok(Number(createdAdj.delta_amount) < 0, 'Delta amount must be negative adjustment');

    // Months 1..5 remain intact: no adjustment for m5Inv
    const m5AdjRes = await adminPool.query('SELECT * FROM invoice_adjustment WHERE invoice_id = $1', [m5Inv.id]);
    assert.equal(m5AdjRes.rows.length, 0, 'Past months (Month 1..5) must remain intact without adjustments');
  });
});
