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
  return { status: res.status, body };
}

test('6-Point Business Logic & RBAC Upgrade Suite (Cross-Building Resident, Shared Profile Lock, Multi-Contract Switcher, Pro-Rata Batch Invoices, Pre-Move-In Termination & OWNER Read-Only, Back-to-Back Contracts)', async (t) => {
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
  const createdPersonIds = [];

  t.after(async () => {
    try {
      for (const cId of createdContractIds) {
        await adminPool.query(
          'DELETE FROM invoice_line WHERE invoice_id IN (SELECT id FROM invoice WHERE contract_id = $1)',
          [cId]
        );
        await adminPool.query('DELETE FROM payment WHERE invoice_id IN (SELECT id FROM invoice WHERE contract_id = $1)', [cId]).catch(() => {});
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
        await adminPool.query('DELETE FROM attachment WHERE owner_entity = $1 AND owner_id = $2', ['contract', cId]);
        await adminPool.query('DELETE FROM contract_version WHERE contract_id = $1', [cId]);
        await adminPool.query('DELETE FROM contract_request WHERE contract_id = $1', [cId]);
        await adminPool.query('DELETE FROM contract_service_price WHERE contract_id = $1', [cId]).catch(() => {});
        await adminPool.query('DELETE FROM contract_occupant WHERE contract_id = $1', [cId]).catch(() => {});
        await adminPool.query('DELETE FROM apartment_service WHERE contract_id = $1', [cId]).catch(() => {});
        await adminPool.query('DELETE FROM contract WHERE id = $1', [cId]);
      }

      for (const aId of createdApartmentIds) {
        await adminPool.query(
          'DELETE FROM invoice_line WHERE invoice_id IN (SELECT id FROM invoice WHERE apartment_id = $1)',
          [aId]
        );
        await adminPool.query('DELETE FROM invoice WHERE apartment_id = $1', [aId]);
        await adminPool.query('DELETE FROM service_request WHERE apartment_id = $1', [aId]);
        await adminPool.query('DELETE FROM meter_reading WHERE apartment_id = $1', [aId]).catch(() => {});
        await adminPool.query('DELETE FROM apartment WHERE id = $1', [aId]);
      }

      for (const pId of createdPersonIds) {
        await adminPool.query(
          'DELETE FROM user_role WHERE user_id IN (SELECT id FROM app_user WHERE person_id = $1)',
          [pId]
        );
        await adminPool.query('DELETE FROM tenant WHERE person_id = $1', [pId]);
        const hasAudit = await adminPool.query(
          `SELECT 1 FROM audit_log WHERE actor_id IN (SELECT id FROM app_user WHERE person_id = $1) LIMIT 1`,
          [pId]
        );
        if (hasAudit.rows.length === 0) {
          await adminPool.query('DELETE FROM app_user WHERE person_id = $1', [pId]);
          await adminPool.query('DELETE FROM person WHERE id = $1', [pId]);
        }
      }
    } finally {
      await adminPool.end();
      await appPool.end();
    }
  });

  // Resolve actors across 2 buildings of 2 different owners (VOP-A and VSC-A)
  const sysAdmin = await login('admin@resihub.vn', 'Admin@123456');
  const mgrA = await login('manager.vop.a@resihub.vn', 'Demo@123456');
  const ownerVop = await login('owner.vop@resihub.vn', 'Demo@123456');

  const vscMgrRow = await adminPool.query(
    `SELECT p.email, b.id AS building_id, b.code AS building_code
     FROM app_user au
     JOIN person p ON p.id = au.person_id
     JOIN user_role ur ON ur.user_id = au.id
     JOIN role r ON r.id = ur.role_id
     JOIN building b ON b.id = ur.building_id
     WHERE r.code = 'MANAGER' AND b.code = 'VSC-A'
     LIMIT 1`
  );
  assert.equal(vscMgrRow.rows.length, 1, 'VSC-A manager must exist');
  const mgrB = await login(vscMgrRow.rows[0].email, 'Demo@123456');

  // Verify R-01: Creating deprecated ACCOUNTANT / STAFF roles is rejected with 400 INVALID_ROLE
  const deprecatedRoleTry = await apiFetch('/api/v1/admin/users', sysAdmin.token, {
    method: 'POST',
    body: JSON.stringify({
      full_name: 'Vai Trò Đã Lược Bỏ',
      email: `deprecated.role.${Date.now().toString().slice(-6)}@resihub.vn`,
      phone: `0944${Date.now().toString().slice(-6)}`,
      password: 'Demo@123456',
      roles: [{ role_code: 'ACCOUNTANT', building_id: null }],
    }),
  });
  assert.equal(deprecatedRoleTry.status, 400, 'Deprecated ACCOUNTANT role must be rejected with 400');

  // Helper to create a clean temporary apartment in a building
  async function createTempApartment(buildingCode, codeSuffix, baseRent = 10000000) {
    const bRow = await adminPool.query(
      `SELECT b.id AS building_id, f.id AS floor_id
       FROM building b
       JOIN floor f ON f.building_id = b.id
       WHERE b.code = $1
       ORDER BY f.level ASC
       LIMIT 1`,
      [buildingCode]
    );
    assert.equal(bRow.rows.length, 1);
    const { building_id, floor_id } = bRow.rows[0];
    const aptCode = `T6P-${codeSuffix}-${Date.now().toString().slice(-4)}`;
    const res = await apiFetch('/api/v1/apartments', sysAdmin.token, {
      method: 'POST',
      body: JSON.stringify({
        building_id,
        floor_id,
        code: aptCode,
        area_m2: 55,
        bedrooms: 2,
        base_rent: baseRent,
        status: 'AVAILABLE',
      }),
    });
    assert.equal(res.status, 201, `Create temp apartment failed: ${JSON.stringify(res.body)}`);
    createdApartmentIds.push(res.body.data.id);
    return res.body.data;
  }

  async function uploadScanAndActivate(contractId, token) {
    const scanRes = await apiFetch(`/api/v1/contracts/${contractId}/scan`, token, {
      method: 'POST',
      body: JSON.stringify({ image_base64: TINY_PNG_B64 }),
    });
    assert.equal(scanRes.status, 201, `Upload scan failed: ${JSON.stringify(scanRes.body)}`);
    return apiFetch(`/api/v1/contracts/${contractId}/activate`, token, {
      method: 'POST',
      body: JSON.stringify({}),
    });
  }

  const todayRow = await adminPool.query(`SELECT CURRENT_DATE::text AS today`);
  const todayStr = todayRow.rows[0].today;

  let sharedTenantId = null;
  let sharedResidentEmail = null;
  let contractAId = null;
  let contractBId = null;
  let aptA = null;
  let aptB = null;

  await t.test('1. Điểm 1 + Điểm 2 + Điểm 3: Cross-building resident lookup & linking, shared profile lock, and multi-apartment switcher', async () => {
    aptA = await createTempApartment('VOP-A', 'A1', 10000000);
    aptB = await createTempApartment('VSC-A', 'B1', 12000000);

    const uniqueDigits = Date.now().toString().slice(-7);
    const resPhone = `097${uniqueDigits}`;
    const resCccd = `07920${uniqueDigits}`;
    sharedResidentEmail = `multi.res.${uniqueDigits}@resihub.vn`;

    // 1.1 Manager A (VOP-A, Owner VOP) creates & activates Contract A with inline new resident
    const createARes = await apiFetch('/api/v1/contracts', mgrA.token, {
      method: 'POST',
      body: JSON.stringify({
        apartment_id: aptA.id,
        new_tenant: {
          full_name: 'Nguyễn Đa Tòa Nhà',
          phone: resPhone,
          id_number: resCccd,
          email: sharedResidentEmail,
          password: 'Demo@123456',
        },
        start_date: todayStr,
        end_date: '2027-06-01',
        rent_amount: 10000000,
        deposit_amount: 10000000,
      }),
    });
    assert.equal(createARes.status, 201, `Create Contract A failed: ${JSON.stringify(createARes.body)}`);
    contractAId = createARes.body.data.id;
    sharedTenantId = createARes.body.data.primary_tenant_id;
    createdContractIds.push(contractAId);

    const tRow = await adminPool.query('SELECT person_id FROM tenant WHERE id = $1', [sharedTenantId]);
    createdPersonIds.push(tRow.rows[0].person_id);

    const actARes = await uploadScanAndActivate(contractAId, mgrA.token);
    assert.equal(actARes.status, 200, `Activate Contract A failed: ${JSON.stringify(actARes.body)}`);

    // 1.2 Manager B (VSC-A, Owner VSC) looks up resident by exact phone -> masked preview, zero VOP-A leak
    const lookupB = await apiFetch(`/api/v1/tenants/lookup?identifier=${resPhone}`, mgrB.token);
    assert.equal(lookupB.status, 200);
    assert.equal(lookupB.body.found, true);
    assert.equal(lookupB.body.cross_building_link, true);
    assert.equal(lookupB.body.tenant.id, sharedTenantId);
    assert.equal(lookupB.body.tenant.full_name, undefined);
    assert.doesNotMatch(JSON.stringify(lookupB.body), /Nguyễn Đa Tòa Nhà/);
    assert.doesNotMatch(JSON.stringify(lookupB.body), /VOP-A/);

    // 1.3 Manager B creates & activates Contract B on VSC-A using sharedTenantId
    const createBRes = await apiFetch('/api/v1/contracts', mgrB.token, {
      method: 'POST',
      body: JSON.stringify({
        apartment_id: aptB.id,
        primary_tenant_id: sharedTenantId,
        start_date: todayStr,
        end_date: '2027-08-01',
        rent_amount: 12000000,
        deposit_amount: 12000000,
      }),
    });
    assert.equal(createBRes.status, 201, `Create Contract B failed: ${JSON.stringify(createBRes.body)}`);
    contractBId = createBRes.body.data.id;
    createdContractIds.push(contractBId);

    const actBRes = await uploadScanAndActivate(contractBId, mgrB.token);
    assert.equal(actBRes.status, 200, `Activate Contract B failed: ${JSON.stringify(actBRes.body)}`);

    // 1.4 Điểm 2: Shared Profile Lock — Manager B (and Manager A) CANNOT overwrite core identity fields (409 SHARED_PROFILE_LOCKED)
    const patchLockedByMgrB = await apiFetch(`/api/v1/tenants/${sharedTenantId}`, mgrB.token, {
      method: 'PATCH',
      body: JSON.stringify({ full_name: 'Bị Đổi Tên Từ Tòa Khác' }),
    });
    assert.equal(patchLockedByMgrB.status, 409);
    assert.equal(patchLockedByMgrB.body.code, 'SHARED_PROFILE_LOCKED');

    const patchPhoneByMgrA = await apiFetch(`/api/v1/tenants/${sharedTenantId}`, mgrA.token, {
      method: 'PATCH',
      body: JSON.stringify({ phone: '0981112233' }),
    });
    assert.equal(patchPhoneByMgrA.status, 409);
    assert.equal(patchPhoneByMgrA.body.code, 'SHARED_PROFILE_LOCKED');

    // Non-core contact field (address) CAN still be updated, and SYS_ADMIN CAN update core fields
    const patchAddrByMgrB = await apiFetch(`/api/v1/tenants/${sharedTenantId}`, mgrB.token, {
      method: 'PATCH',
      body: JSON.stringify({ address: 'TP. Thủ Đức, TP.HCM' }),
    });
    assert.equal(patchAddrByMgrB.status, 200);

    const detailMgrB = await apiFetch(`/api/v1/tenants/${sharedTenantId}`, mgrB.token);
    assert.equal(detailMgrB.status, 200);
    assert.equal(detailMgrB.body.data.is_shared_profile, true);
    // Manager B must ONLY see VSC-A contract in tenant detail, never VOP-A contract!
    assert.ok(
      detailMgrB.body.data.contracts.every((c) => c.id === contractBId),
      'Manager B must never see Building A contracts in shared tenant detail'
    );

    const patchByAdmin = await apiFetch(`/api/v1/tenants/${sharedTenantId}`, sysAdmin.token, {
      method: 'PATCH',
      body: JSON.stringify({ full_name: 'Nguyễn Đa Tòa Nhà (Verified)' }),
    });
    assert.equal(patchByAdmin.status, 200);

    // 1.5 Điểm 3: Resident logs in with ONE account and switches between Contract A (VOP-A) and Contract B (VSC-A)
    const resident = await login(sharedResidentEmail, 'Demo@123456');

    const ovDefault = await apiFetch('/api/v1/resident/overview', resident.token);
    assert.equal(ovDefault.status, 200);
    assert.equal(ovDefault.body.data.active_contracts.length, 2, 'Resident must see both active contracts');

    const ovA = await apiFetch(`/api/v1/resident/overview?contract_id=${contractAId}`, resident.token);
    assert.equal(ovA.status, 200);
    assert.equal(ovA.body.data.selected_contract_id, contractAId);
    assert.equal(ovA.body.data.active_contract.apartment_id, aptA.id);

    const ovB = await apiFetch(`/api/v1/resident/overview?contract_id=${contractBId}`, resident.token);
    assert.equal(ovB.status, 200);
    assert.equal(ovB.body.data.selected_contract_id, contractBId);
    assert.equal(ovB.body.data.active_contract.apartment_id, aptB.id);

    // Create a maintenance service request on Contract B -> isolated from Contract A
    const srCreateB = await apiFetch('/api/v1/resident/service-requests', resident.token, {
      method: 'POST',
      body: JSON.stringify({
        contract_id: contractBId,
        category: 'ELECTRICAL',
        priority: 'NORMAL',
        title: 'Đèn ban công căn B nhấp nháy',
        description: 'Kiểm tra đèn ban công tại căn hộ tòa VSC-A',
      }),
    });
    assert.equal(srCreateB.status, 201);

    const srListA = await apiFetch(`/api/v1/resident/service-requests?contract_id=${contractAId}`, resident.token);
    const srListB = await apiFetch(`/api/v1/resident/service-requests?contract_id=${contractBId}`, resident.token);
    assert.equal(srListA.body.data.length, 0, 'Contract A must have 0 service requests');
    assert.equal(srListB.body.data.length, 1, 'Contract B must have 1 service request');

    const depA = await apiFetch(`/api/v1/resident/deposit-transactions?contract_id=${contractAId}`, resident.token);
    const depB = await apiFetch(`/api/v1/resident/deposit-transactions?contract_id=${contractBId}`, resident.token);
    assert.equal(depA.body.data.contract.id, contractAId);
    assert.equal(depB.body.data.contract.id, contractBId);
  });

  await t.test('2. Điểm 4 + Điểm 6 + Điểm 5a: Back-to-back contracts on OCCUPIED/MAINTENANCE, future invoice skip & pro-rata rent, and pre-move-in termination', async () => {
    // 2.1 Điểm 6: aptA is currently OCCUPIED (until 2027-06-01). Manager A creates & activates a back-to-back contract (2027-06-01 -> 2027-12-01)
    const b2bCreate = await apiFetch('/api/v1/contracts', mgrA.token, {
      method: 'POST',
      body: JSON.stringify({
        apartment_id: aptA.id,
        primary_tenant_id: sharedTenantId,
        start_date: '2027-06-01',
        end_date: '2027-12-01',
        rent_amount: 10500000,
        deposit_amount: 10500000,
      }),
    });
    assert.equal(b2bCreate.status, 201, `Back-to-back draft on OCCUPIED apt failed: ${JSON.stringify(b2bCreate.body)}`);
    const b2bContractId = b2bCreate.body.data.id;
    createdContractIds.push(b2bContractId);

    const b2bAct = await uploadScanAndActivate(b2bContractId, mgrA.token);
    assert.equal(b2bAct.status, 200, `Back-to-back activate on OCCUPIED apt failed: ${JSON.stringify(b2bAct.body)}`);

    // aptA MUST remain OCCUPIED (must NOT regress to RESERVED!)
    const aptAAfterB2B = await apiFetch(`/api/v1/apartments/${aptA.id}`, mgrA.token);
    assert.equal(aptAAfterB2B.body.data.status, 'OCCUPIED', 'OCCUPIED apartment must stay OCCUPIED when future contract is activated');

    // Overlapping contract on aptA (e.g. 2027-05-15 -> 2027-09-01) MUST still be rejected!
    const overlapAttempt = await apiFetch('/api/v1/contracts', mgrA.token, {
      method: 'POST',
      body: JSON.stringify({
        apartment_id: aptA.id,
        primary_tenant_id: sharedTenantId,
        start_date: '2027-05-15',
        end_date: '2027-09-01',
        rent_amount: 10000000,
      }),
    });
    assert.ok([409, 422].includes(overlapAttempt.status), 'Overlapping contract period must be rejected');

    // 2.2 Future contract on clean apartment -> RESERVED, skipped for earlier months, pro-rata for mid-month start!
    const aptFuture = await createTempApartment('VOP-A', 'FUT', 31000000);
    const vopABldgId = aptFuture.building_id;

    const futCreate = await apiFetch('/api/v1/contracts', mgrA.token, {
      method: 'POST',
      body: JSON.stringify({
        apartment_id: aptFuture.id,
        primary_tenant_id: sharedTenantId,
        start_date: '2029-05-16',
        end_date: '2029-11-01',
        rent_amount: 31000000,
        deposit_amount: 31000000,
      }),
    });
    assert.equal(futCreate.status, 201);
    const futContractId = futCreate.body.data.id;
    createdContractIds.push(futContractId);

    const futAct = await uploadScanAndActivate(futContractId, mgrA.token);
    assert.equal(futAct.status, 200);

    const aptFutCheck = await apiFetch(`/api/v1/apartments/${aptFuture.id}`, mgrA.token);
    assert.equal(aptFutCheck.body.data.status, 'RESERVED', 'Future contract on AVAILABLE apt must set status to RESERVED');

    // Simulate MAINTENANCE -> AVAILABLE transition when future contract exists -> syncs back to RESERVED!
    await adminPool.query(`UPDATE apartment SET status = 'MAINTENANCE' WHERE id = $1`, [aptFuture.id]);
    const finishMaint = await apiFetch(`/api/v1/apartments/${aptFuture.id}`, mgrA.token, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'AVAILABLE' }),
    });
    assert.equal(finishMaint.status, 200);
    assert.equal(finishMaint.body.data.status, 'RESERVED', 'Finishing MAINTENANCE with active future contract must sync to RESERVED');

    // Điểm 4: Batch invoice for 2029-04 (before 2029-05-16) MUST skip futContractId!
    const batchBefore = await apiFetch('/api/v1/invoices/generate-batch', mgrA.token, {
      method: 'POST',
      body: JSON.stringify({
        building_id: vopABldgId,
        period: '2029-04',
      }),
    });
    assert.equal(batchBefore.status, 201, `Batch 2029-04 failed: ${JSON.stringify(batchBefore.body)}`);
    assert.ok(batchBefore.body.skipped_future_count >= 1, 'Future contract must increment skipped_future_count');
    const invBeforeDb = await adminPool.query(
      `SELECT id FROM invoice WHERE contract_id = $1 AND period = '2029-04'`,
      [futContractId]
    );
    assert.equal(invBeforeDb.rows.length, 0, 'Zero invoices may be generated before contract start_date');

    // Điểm 4: Batch invoice for 2029-05 (31 days; active 2029-05-16..2029-05-31 = 16 days) -> Pro-rata 31,000,000 * 16 / 31 = 16,000,000!
    const batchMay = await apiFetch('/api/v1/invoices/generate-batch', mgrA.token, {
      method: 'POST',
      body: JSON.stringify({
        building_id: vopABldgId,
        period: '2029-05',
      }),
    });
    assert.equal(batchMay.status, 201);
    const invMayDb = await adminPool.query(
      `SELECT i.id, i.total_amount, il.amount AS rent_line_amount, il.description
       FROM invoice i
       JOIN invoice_line il ON il.invoice_id = i.id AND il.item_type = 'RENT'
       WHERE i.contract_id = $1 AND i.period = '2029-05'`,
      [futContractId]
    );
    assert.equal(invMayDb.rows.length, 1, 'Invoice must be generated for 2029-05');
    assert.equal(Number(invMayDb.rows[0].rent_line_amount), 16000000, 'Pro-rata rent for 16/31 days of 31M must be 16,000,000');
    assert.match(invMayDb.rows[0].description, /16\/31 ngày/);

    // Clean up any invoices created on other VOP-A contracts for far-future test periods 2029-04 / 2029-05
    await adminPool.query(
      `DELETE FROM invoice_line WHERE invoice_id IN (SELECT id FROM invoice WHERE building_id = $1 AND period IN ('2029-04', '2029-05'))`,
      [vopABldgId]
    );
    await adminPool.query(
      `DELETE FROM receivable WHERE invoice_id IN (SELECT id FROM invoice WHERE building_id = $1 AND period IN ('2029-04', '2029-05'))`,
      [vopABldgId]
    );
    await adminPool.query(
      `DELETE FROM invoice WHERE building_id = $1 AND period IN ('2029-04', '2029-05')`,
      [vopABldgId]
    );

    // 2.3 Điểm 5a: Pre-move-in early termination (today < 2029-05-16) -> Direct 1-step TERMINATED, skips MAINTENANCE -> AVAILABLE!
    const termFutRes = await apiFetch(`/api/v1/contracts/${futContractId}/terminate`, mgrA.token, {
      method: 'POST',
      body: JSON.stringify({
        terminated_date: todayStr,
        reason: 'Khách hủy kế hoạch chuyển đến trước ngày nhận phòng',
      }),
    });
    assert.equal(termFutRes.status, 200, `Pre-move-in terminate failed: ${JSON.stringify(termFutRes.body)}`);
    assert.equal(termFutRes.body.data.status, 'TERMINATED');

    const aptAfterPreTerm = await apiFetch(`/api/v1/apartments/${aptFuture.id}`, mgrA.token);
    assert.equal(
      aptAfterPreTerm.body.data.status,
      'AVAILABLE',
      'Pre-move-in termination must return apartment directly to AVAILABLE (skipping MAINTENANCE)'
    );

    const depAfterTerm = await adminPool.query(
      `SELECT refund_due_date FROM deposit WHERE contract_id = $1`,
      [futContractId]
    );
    assert.ok(depAfterTerm.rows[0]?.refund_due_date, 'Terminated contract deposit must set 5-day refund_due_date');
  });

  await t.test('3. Điểm 5b: OWNER is 100% Read-Only (API + RLS) and Internal Four-Eyes works for Discounted Contracts & Deposit Settlements', async () => {
    const aptDisc = await createTempApartment('VOP-A', 'DSC', 10000000);

    // 3.1 Manager A creates a discounted contract (8,000,000 < 90% of 10,000,000) -> PENDING_APPROVAL
    const discCreate = await apiFetch('/api/v1/contracts', mgrA.token, {
      method: 'POST',
      body: JSON.stringify({
        apartment_id: aptDisc.id,
        primary_tenant_id: sharedTenantId,
        start_date: todayStr,
        end_date: '2027-07-01',
        rent_amount: 8000000,
        deposit_amount: 8000000,
      }),
    });
    assert.equal(discCreate.status, 201);
    const discContractId = discCreate.body.data.id;
    createdContractIds.push(discContractId);

    const discAct = await uploadScanAndActivate(discContractId, mgrA.token);
    assert.equal(discAct.status, 409);
    assert.equal(discAct.body.code, 'PRICE_NEEDS_APPROVAL');

    // 3.2 OWNER VOP can READ contracts/deposits, gets 403 on operational endpoints, and is the designated approver for discounted contracts on VOP-A!
    const ownerReadContracts = await apiFetch('/api/v1/contracts', ownerVop.token);
    assert.equal(ownerReadContracts.status, 200);
    const ownerReadDeposits = await apiFetch('/api/v1/deposits', ownerVop.token);
    assert.equal(ownerReadDeposits.status, 200);

    const ownerTerminateTry = await apiFetch(`/api/v1/contracts/${contractAId}/terminate`, ownerVop.token, {
      method: 'POST',
      body: JSON.stringify({ terminated_date: todayStr, reason: 'Owner try' }),
    });
    assert.equal(ownerTerminateTry.status, 403, 'OWNER must be blocked (403) from terminating contracts');

    const ownerNotifTry = await apiFetch('/api/v1/notifications', ownerVop.token, {
      method: 'POST',
      body: JSON.stringify({
        target_scope: 'BUILDING',
        building_id: aptDisc.building_id,
        type: 'ANNOUNCEMENT',
        title: 'Owner test',
        content: 'Owner should be read-only',
      }),
    });
    assert.equal(ownerNotifTry.status, 403, 'OWNER must be blocked (403) from sending notifications');

    // 3.3 Discounted Contract Approval: Creator (Manager A) and SYS_ADMIN (when building has active OWNER) get 403; Building OWNER (ownerVop) approves (200 -> ACTIVE)
    const selfApproveTry = await apiFetch(`/api/v1/contracts/${discContractId}/approve`, mgrA.token, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    assert.equal(selfApproveTry.status, 403);

    const sysAdminApproveTry = await apiFetch(`/api/v1/contracts/${discContractId}/approve`, sysAdmin.token, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    assert.equal(sysAdminApproveTry.status, 403);
    assert.equal(sysAdminApproveTry.body.code, 'FORBIDDEN_NOT_BUILDING_OWNER');

    const ownerApproveRes = await apiFetch(`/api/v1/contracts/${discContractId}/approve`, ownerVop.token, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    assert.equal(ownerApproveRes.status, 200, `Building OWNER approve failed: ${JSON.stringify(ownerApproveRes.body)}`);
    assert.equal(ownerApproveRes.body.data.status, 'ACTIVE');

    // 3.4PostgreSQL RLS check: OWNER VOP cannot UPDATE contract or deposit at raw SQL level
    const rlsClient = await appPool.connect();
    try {
      await rlsClient.query(`SELECT set_config('app.current_user_id', $1, false)`, [ownerVop.user.id || ownerVop.user.sub]);
      const updContract = await rlsClient.query(
        `UPDATE contract SET note = 'Owner hacked' WHERE id = $1 RETURNING id`,
        [discContractId]
      );
      assert.equal(updContract.rowCount, 0, 'PostgreSQL RLS must block OWNER from updating contract');

      const updDeposit = await rlsClient.query(
        `UPDATE deposit SET status = 'REFUNDED' WHERE contract_id = $1 RETURNING id`,
        [discContractId]
      );
      assert.equal(updDeposit.rowCount, 0, 'PostgreSQL RLS must block OWNER from updating deposit');
    } finally {
      await rlsClient.query('RESET app.current_user_id').catch(() => {});
      rlsClient.release();
    }

    // 3.5 Terminate discContractId (1-step by Manager A), collect deposit & submit settlement by MANAGER, block OWNER/self-approve, approve by SYS_ADMIN!
    const depRow = await adminPool.query(`SELECT id FROM deposit WHERE contract_id = $1`, [discContractId]);
    const depositId = depRow.rows[0].id;

    // OWNER blocked from deposit transaction
    const ownerCollectTry = await apiFetch(`/api/v1/deposits/${depositId}/transactions`, ownerVop.token, {
      method: 'POST',
      body: JSON.stringify({ type: 'collect', amount: 8000000, method: 'BANK_TRANSFER' }),
    });
    assert.equal(ownerCollectTry.status, 403, 'OWNER must be blocked (403) from recording deposit transactions');

    // MANAGER collects deposit (8,000,000)
    const mgrCollectRes = await apiFetch(`/api/v1/deposits/${depositId}/transactions`, mgrA.token, {
      method: 'POST',
      body: JSON.stringify({
        type: 'collect',
        amount: 8000000,
        method: 'BANK_TRANSFER',
        description: 'Thu đủ cọc hợp đồng ưu đãi',
      }),
    });
    assert.equal(mgrCollectRes.status, 201, `MANAGER collect deposit failed: ${JSON.stringify(mgrCollectRes.body)}`);

    // Manager A terminates active contract directly -> TERMINATED, apartment -> MAINTENANCE
    const termDiscRes = await apiFetch(`/api/v1/contracts/${discContractId}/terminate`, mgrA.token, {
      method: 'POST',
      body: JSON.stringify({
        terminated_date: todayStr,
        reason: 'Thanh lý hợp đồng để kiểm thử tất toán cọc nội bộ',
      }),
    });
    assert.equal(termDiscRes.status, 200);
    assert.equal(termDiscRes.body.data.status, 'TERMINATED');

    // Manager A submits deposit settlement -> PENDING_APPROVAL
    const settleSubmit = await apiFetch(`/api/v1/deposits/${depositId}/settlement`, mgrA.token, {
      method: 'POST',
      body: JSON.stringify({
        outstanding_debt: 0,
        items: [
          {
            category: 'CLEANING',
            amount: 500000,
            description: 'Phí tổng vệ sinh bàn giao phòng',
            evidence: [TINY_PNG_B64],
          },
        ],
        inspection_evidence: [TINY_PNG_B64],
        refund_method: 'BANK_TRANSFER',
        bank_info: {
          bank_name: 'Vietcombank',
          account_number: '0011009999999',
          account_holder: 'NGUYEN DA TOA NHA',
        },
      }),
    });
    assert.equal(settleSubmit.status, 200, `Submit settlement failed: ${JSON.stringify(settleSubmit.body)}`);

    // SYS_ADMIN blocked from approving settlement on VOP-A when active OWNER exists (403)
    const sysSettleApprove = await apiFetch(`/api/v1/deposits/${depositId}/settlement/approve`, sysAdmin.token, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    assert.equal(sysSettleApprove.status, 403, 'SYS_ADMIN must be blocked (403) from approving deposit settlement on owned building');

    // Creator (Manager A) blocked by Four-eyes self-approval (403)
    const mgrSelfSettleApprove = await apiFetch(`/api/v1/deposits/${depositId}/settlement/approve`, mgrA.token, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    assert.equal(mgrSelfSettleApprove.status, 403, 'Settlement creator must be blocked by Four-eyes');

    // Active building OWNER approves settlement -> 200 APPROVED_PENDING_PAYOUT, then MANAGER executes payout -> PARTIALLY_REFUNDED
    const ownerSettleApprove = await apiFetch(`/api/v1/deposits/${depositId}/settlement/approve`, ownerVop.token, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    assert.equal(ownerSettleApprove.status, 200, `OWNER settlement approve failed: ${JSON.stringify(ownerSettleApprove.body)}`);
    assert.equal(ownerSettleApprove.body.data.status, 'APPROVED_PENDING_PAYOUT');

    const mgrPayout = await apiFetch(`/api/v1/deposits/${depositId}/payout`, mgrA.token, {
      method: 'POST',
      body: JSON.stringify({
        evidence: [TINY_PNG_B64],
        reference_code: 'UNC-MGR-A',
      }),
    });
    assert.equal(mgrPayout.status, 200, `MANAGER payout failed: ${JSON.stringify(mgrPayout.body)}`);
    assert.equal(mgrPayout.body.data.status, 'PARTIALLY_REFUNDED');
  });
});

