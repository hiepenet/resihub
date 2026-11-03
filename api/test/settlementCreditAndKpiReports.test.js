import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';

dotenv.config({ path: fileURLToPath(new URL('../.env', import.meta.url)) });
dotenv.config();
if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = 'postgres://postgres:postgres@127.0.0.1:5433/resihub';
}
if (!process.env.APP_DATABASE_URL) {
  process.env.APP_DATABASE_URL =
    'postgres://resihub_app:resihub_app_secret@127.0.0.1:5433/resihub';
}

const TINY_PNG_B64 =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

function getTodayVn() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Ho_Chi_Minh',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

test('Task 7: M06 Two-Step Deposit Settlement & KPI / RP-08 XLSX Reports', async (t) => {
  const { adminPool, appPool } = await import('../src/db/client.js');
  const {
    computeFinalSettlementWithCredit,
    isSettlementSnapshotStale,
  } = await import('../src/services/depositSettlement.js');

  const { default: authRoute } = await import('../src/routes/auth.js');
  const { default: depositsRoute } = await import('../src/routes/deposits.js');
  const { default: reportsRoute } = await import('../src/routes/reports.js');
  const { default: auditLogsRoute } = await import('../src/routes/admin/audit-logs.js');
  const { default: invoicesRoute } = await import('../src/routes/invoices.js');
  const { default: contractsRoute } = await import('../src/routes/contracts.js');
  const { default: apartmentsRoute } = await import('../src/routes/apartments.js');
  const { default: paymentsRoute, receivablesRouter } = await import('../src/routes/payments.js');
  const { default: residentRoute } = await import('../src/routes/resident.js');

  // Test 1: Pure Unit Tests for computeFinalSettlementWithCredit & isSettlementSnapshotStale
  await t.test('1. computeFinalSettlementWithCredit & isSettlementSnapshotStale logic', () => {
    // Case A1: held 5M, credit 1.5M, serviceDebt 1.5M, rentDebt 0, items []
    const resA1 = computeFinalSettlementWithCredit({
      heldBefore: 5000000,
      availableCredit: 1500000,
      serviceDebt: 1500000,
      rentDebt: 0,
      items: [],
    });

    assert.equal(resA1.credit_applied_to_rent, 0);
    assert.equal(resA1.credit_applied_to_service, 1500000);
    assert.equal(resA1.remaining_service_debt, 0);
    assert.equal(resA1.covered_service_debt, 0);
    assert.equal(resA1.deposit_refund_amount, 5000000);
    assert.equal(resA1.credit_refund_amount, 0);
    assert.equal(resA1.total_payout_amount, 5000000);
    assert.equal(resA1.refund_amount, 5000000);
    assert.equal(resA1.shortfall, 0);

    // Case B: held 2M, credit 1.8M, items 2M damage, serviceDebt 0, rentDebt 0
    const resB = computeFinalSettlementWithCredit({
      heldBefore: 2000000,
      availableCredit: 1800000,
      serviceDebt: 0,
      rentDebt: 0,
      items: [{ amount: 2000000, category: 'DAMAGE' }],
    });

    assert.equal(resB.deposit_refund_amount, 0);
    assert.equal(resB.credit_refund_amount, 1800000);
    assert.equal(resB.total_payout_amount, 1800000);
    assert.equal(resB.refund_amount, 1800000);
    assert.equal(resB.covered_service_debt, 0);
    assert.equal(resB.remaining_service_debt, 0);
    assert.equal(resB.uncovered_items_shortfall, 0);

    // Stale test when available_credit changes
    const saved = {
      outstanding_debt: 1000000,
      rent_debt: 0,
      deposit_held_before_settlement: 3000000,
      available_credit: 500000,
      open_invoice_snapshot: [],
    };
    assert.equal(
      isSettlementSnapshotStale(saved, {
        serviceDebt: 1000000,
        rentDebt: 0,
        heldAmount: 3000000,
        availableCredit: 500000,
        openInvoices: [],
      }),
      false
    );
    assert.equal(
      isSettlementSnapshotStale(saved, {
        serviceDebt: 1000000,
        rentDebt: 0,
        heldAmount: 3000000,
        availableCredit: 200000, // credit changed!
        openInvoices: [],
      }),
      true
    );
  });

  // Mount express app on ephemeral port
  const app = express();
  app.use(
    cors({
      origin: '*',
      methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key'],
      exposedHeaders: ['Idempotent-Replayed'],
    })
  );
  app.use(express.json({ limit: '20mb' }));
  app.use('/api/v1/auth', authRoute);
  app.use('/api/v1/apartments', apartmentsRoute);
  app.use('/api/v1/contracts', contractsRoute);
  app.use('/api/v1/deposits', depositsRoute);
  app.use('/api/v1/invoices', invoicesRoute);
  app.use('/api/v1/payments', paymentsRoute);
  app.use('/api/v1/receivables', receivablesRouter);
  app.use('/api/v1/reports', reportsRoute);
  app.use('/api/v1/audit-logs', auditLogsRoute);
  app.use('/api/v1/resident', residentRoute);

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const API_BASE = `http://127.0.0.1:${server.address().port}`;

  async function apiFetch(urlPath, token, options = {}) {
    const headers = {
      'Content-Type': 'application/json',
      'Idempotency-Key': crypto.randomUUID(),
      ...(options.headers || {}),
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(`${API_BASE}${urlPath}`, { ...options, headers });
    const contentType = res.headers.get('content-type') || '';
    if (options.rawBuffer) {
      const arrayBuf = await res.arrayBuffer();
      const buffer = Buffer.from(arrayBuf);
      return { status: res.status, headers: res.headers, contentType, buffer };
    }
    const text = await res.text();
    let body = null;
    if (contentType.includes('application/json')) {
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = { raw: text };
      }
    } else {
      body = { raw: text };
    }
    return { status: res.status, headers: res.headers, contentType, body };
  }

  const suffix = `${Date.now().toString().slice(-6)}_${Math.floor(Math.random() * 1000)}`;
  const cleanup = {
    orgIds: [],
    buildingIds: [],
    apartmentIds: [],
    contractIds: [],
    tenantIds: [],
    userIds: [],
    personIds: [],
    depositIds: [],
    invoiceIds: [],
  };

  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    const cleanClient = await adminPool.connect();
    try {
      await cleanClient.query('BEGIN');
      await cleanClient.query("SET LOCAL app.allow_test_cleanup = 'true'");

      for (const dId of cleanup.depositIds) {
        await cleanClient.query('DELETE FROM deposit_transaction WHERE deposit_id = $1', [dId]).catch(() => {});
        await cleanClient.query("DELETE FROM attachment WHERE owner_entity = 'deposit' AND owner_id = $1", [dId]).catch(() => {});
        await cleanClient.query('DELETE FROM deposit WHERE id = $1', [dId]).catch(() => {});
      }
      for (const cId of cleanup.contractIds) {
        await cleanClient.query('DELETE FROM credit_balance WHERE contract_id = $1', [cId]).catch(() => {});
        await cleanClient.query('DELETE FROM receivable WHERE contract_id = $1', [cId]).catch(() => {});
        await cleanClient.query('DELETE FROM invoice_adjustment WHERE invoice_id IN (SELECT id FROM invoice WHERE contract_id = $1)', [cId]).catch(() => {});
        await cleanClient.query('DELETE FROM invoice_line WHERE invoice_id IN (SELECT id FROM invoice WHERE contract_id = $1)', [cId]).catch(() => {});
        await cleanClient.query('DELETE FROM payment WHERE contract_id = $1', [cId]).catch(() => {});
        await cleanClient.query('DELETE FROM invoice WHERE contract_id = $1', [cId]).catch(() => {});
        await cleanClient.query('DELETE FROM contract_occupant WHERE contract_id = $1', [cId]).catch(() => {});
        await cleanClient.query('DELETE FROM deposit WHERE contract_id = $1', [cId]).catch(() => {});
        await cleanClient.query('DELETE FROM contract WHERE id = $1', [cId]).catch(() => {});
      }
      for (const aId of cleanup.apartmentIds) {
        await cleanClient.query('DELETE FROM meter_reading WHERE meter_id IN (SELECT id FROM meter WHERE apartment_id = $1)', [aId]).catch(() => {});
        await cleanClient.query('DELETE FROM meter WHERE apartment_id = $1', [aId]).catch(() => {});
        await cleanClient.query('DELETE FROM apartment WHERE id = $1', [aId]).catch(() => {});
      }
      for (const bId of cleanup.buildingIds) {
        await cleanClient.query('DELETE FROM building WHERE id = $1', [bId]).catch(() => {});
      }
      for (const uId of cleanup.userIds) {
        await cleanClient.query('DELETE FROM idempotency_key WHERE actor_id = $1', [uId]).catch(() => {});
        await cleanClient.query('DELETE FROM user_role WHERE user_id = $1', [uId]).catch(() => {});
        await cleanClient.query('DELETE FROM app_user WHERE id = $1', [uId]).catch(() => {});
      }
      for (const pId of cleanup.personIds) {
        await cleanClient.query('DELETE FROM tenant WHERE person_id = $1', [pId]).catch(() => {});
        await cleanClient.query('DELETE FROM person WHERE id = $1', [pId]).catch(() => {});
      }
      for (const oId of cleanup.orgIds) {
        await cleanClient.query('DELETE FROM system_setting WHERE org_id = $1', [oId]).catch(() => {});
        await cleanClient.query('DELETE FROM organization WHERE id = $1', [oId]).catch(() => {});
      }
      await cleanClient.query('COMMIT');
    } catch (e) {
      await cleanClient.query('ROLLBACK').catch(() => {});
    } finally {
      cleanClient.release();
    }
  });

  // Create isolated organization
  const orgRes = await adminPool.query(
    `INSERT INTO organization (name)
     VALUES ($1)
     RETURNING id`,
    [`Org_Task7_${suffix}`]
  );
  const orgId = orgRes.rows[0].id;
  cleanup.orgIds.push(orgId);

  // Use existing canonical system roles (R-01)

  // CRITICAL Isolation: billing_config late_fee_enabled: false, late_fee_grace_days: 9999
  await adminPool.query(
    `INSERT INTO system_setting (org_id, key, value)
     VALUES ($1, 'billing_config', '{"late_fee_enabled": false, "late_fee_grace_days": 9999}'::jsonb),
            ($1, 'approval_config', '{"allow_self_approval": false}'::jsonb)`,
    [orgId]
  );

  // Create building
  const bldgRes = await adminPool.query(
    `INSERT INTO building (org_id, name, code, address, status)
     VALUES ($1, $2, $3, '123 Test St', 'ACTIVE')
     RETURNING id`,
    [orgId, `Bldg_Task7_${suffix}`, `B_${suffix}`]
  );
  const buildingId = bldgRes.rows[0].id;
  cleanup.buildingIds.push(buildingId);

  // Helper to create user
  const passwordHash = await bcrypt.hash('Secret123!', 10);
  async function createUser(email, fullName, roleCode, assignedBuildingId = null) {
    const pRes = await adminPool.query(
      `INSERT INTO person (org_id, full_name, email, phone)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [orgId, fullName, email, `090${String(Math.floor(Math.random() * 10000000)).padStart(7, '0')}`]
    );
    const personId = pRes.rows[0].id;
    cleanup.personIds.push(personId);

    const uRes = await adminPool.query(
      `INSERT INTO app_user (person_id, auth_uid, password_hash, status)
       VALUES ($1, $2, $3, 'ACTIVE')
       RETURNING id`,
      [personId, email, passwordHash]
    );
    const userId = uRes.rows[0].id;
    cleanup.userIds.push(userId);

    const roleRes = await adminPool.query('SELECT id FROM role WHERE code = $1 LIMIT 1', [roleCode]);
    const roleId = roleRes.rows[0].id;

    await adminPool.query(
      `INSERT INTO user_role (user_id, role_id, building_id)
       VALUES ($1, $2, $3)`,
      [userId, roleId, assignedBuildingId]
    );

    const loginRes = await apiFetch('/api/v1/auth/login', null, {
      method: 'POST',
      body: JSON.stringify({ email, password: 'Secret123!' }),
    });
    assert.equal(loginRes.status, 200, `Login failed for ${email}`);
    return { userId, personId, token: loginRes.body.accessToken };
  }

  const ownerUser = await createUser(`owner_${suffix}@test.com`, 'Owner Task7', 'OWNER', buildingId);
  const managerUser = await createUser(`mgr_${suffix}@test.com`, 'Manager Task7', 'MANAGER', buildingId);
  const residentUser = await createUser(`res_${suffix}@test.com`, 'Resident Task7', 'RESIDENT', buildingId);

  // Link owner to building
  const ownerTableRes = await adminPool.query(
    `INSERT INTO owner (org_id, person_id, full_name, email)
     VALUES ($1, $2, 'Owner Task7', $3)
     RETURNING id`,
    [orgId, ownerUser.personId, `owner_${suffix}@test.com`]
  );
  await adminPool.query('UPDATE building SET owner_id = $1 WHERE id = $2', [ownerTableRes.rows[0].id, buildingId]);

  // Create Apartment
  const aptRes = await adminPool.query(
    `INSERT INTO apartment (building_id, code, status)
     VALUES ($1, $2, 'AVAILABLE')
     RETURNING id`,
    [buildingId, `APT_${suffix}`]
  );
  const aptId = aptRes.rows[0].id;
  cleanup.apartmentIds.push(aptId);

  // Create Tenant for resident
  const tenantRes = await adminPool.query(
    `INSERT INTO tenant (org_id, person_id, type, status)
     VALUES ($1, $2, 'primary', 'APPROVED')
     RETURNING id`,
    [orgId, residentUser.personId]
  );
  const tenantId = tenantRes.rows[0].id;
  cleanup.tenantIds.push(tenantId);

  // Test 2: Preconditions, 409 PENDING_INVOICE_ADJUSTMENT, 409 PENDING_CREDIT_REFUND, unbilled_final_period, STALE
  await t.test('2. checkSettlementPreconditions: blocking 409s, unbilled_final_period & snapshot stale', async () => {
    // Create contract that is terminated
    const contRes = await adminPool.query(
      `INSERT INTO contract (building_id, apartment_id, primary_tenant_id, start_date, end_date, terminated_at, status, rent_amount, deposit_amount, billing_day)
       VALUES ($1, $2, $3, '2026-01-01', '2026-05-31', '2026-05-31', 'TERMINATED', 10000000, 10000000, 5)
       RETURNING id`,
      [buildingId, aptId, tenantId]
    );
    const contractId = contRes.rows[0].id;
    cleanup.contractIds.push(contractId);

    const depRes = await adminPool.query(
      `INSERT INTO deposit (contract_id, amount_held, status)
       VALUES ($1, 10000000, 'HELD')
       RETURNING id`,
      [contractId]
    );
    const depositId = depRes.rows[0].id;
    cleanup.depositIds.push(depositId);

    // Initial check: unbilled_final_period should have has_unbilled_period: true because period 2026-05 has active days but no invoice
    const preCheckRes = await apiFetch(`/api/v1/deposits/${depositId}/settlement`, managerUser.token);
    assert.equal(preCheckRes.status, 200);
    assert.equal(preCheckRes.body.data.preconditions.unbilled_final_period.has_unbilled_period, true);
    assert.equal(preCheckRes.body.data.preconditions.unbilled_final_period.period, '2026-05');
    assert.equal(preCheckRes.body.data.preconditions.unbilled_final_period.active_days, 31);

    // Seed pending invoice adjustment
    const invRes = await adminPool.query(
      `INSERT INTO invoice (org_id, building_id, apartment_id, contract_id, tenant_id, invoice_code, period, due_date, subtotal_amount, total_amount, paid_amount, status)
       VALUES ($1, $2, $3, $4, $5, $6, '2026-05', '2026-05-10', 5000000, 5000000, 0, 'ISSUED')
       RETURNING id`,
      [orgId, buildingId, aptId, contractId, tenantId, `INV_PRE_${suffix}`]
    );
    const invId = invRes.rows[0].id;
    cleanup.invoiceIds.push(invId);

    const adjRes = await adminPool.query(
      `INSERT INTO invoice_adjustment (org_id, building_id, invoice_id, created_by, action_type, delta_amount, reason, status)
       VALUES ($1, $2, $3, $4, 'ADJUST', -500000, 'Test pending adjustment', 'PENDING_APPROVAL')
       RETURNING id`,
      [orgId, buildingId, invId, managerUser.userId]
    );
    const adjId = adjRes.rows[0].id;

    // Try submitting settlement -> should return 409 PENDING_INVOICE_ADJUSTMENT
    const submitWithAdj = await apiFetch(`/api/v1/deposits/${depositId}/settlement`, managerUser.token, {
      method: 'POST',
      body: JSON.stringify({
        items: [],
        refund_method: 'CASH',
        inspection_evidence: [TINY_PNG_B64],
      }),
    });
    assert.equal(submitWithAdj.status, 409);
    assert.equal(submitWithAdj.body.code, 'PENDING_INVOICE_ADJUSTMENT');

    // Remove pending adjustment
    await adminPool.query('DELETE FROM invoice_adjustment WHERE id = $1', [adjId]);

    // Seed pending credit refund
    const crRes = await adminPool.query(
      `INSERT INTO credit_balance (org_id, building_id, contract_id, tenant_id, amount, applied_amount, reason_type, status, description, created_by)
       VALUES ($1, $2, $3, $4, 1000000, 0, 'OVERPAYMENT', 'PENDING_DIRECT_REFUND', 'Pending refund test', $5)
       RETURNING id`,
      [orgId, buildingId, contractId, tenantId, managerUser.userId]
    );
    const crId = crRes.rows[0].id;

    // Try submitting settlement -> should return 409 PENDING_CREDIT_REFUND
    const submitWithCr = await apiFetch(`/api/v1/deposits/${depositId}/settlement`, managerUser.token, {
      method: 'POST',
      body: JSON.stringify({
        items: [],
        refund_method: 'CASH',
        inspection_evidence: [TINY_PNG_B64],
      }),
    });
    assert.equal(submitWithCr.status, 409);
    assert.equal(submitWithCr.body.code, 'PENDING_CREDIT_REFUND');

    // Set credit to AVAILABLE so it can be used
    await adminPool.query("UPDATE credit_balance SET status = 'AVAILABLE' WHERE id = $1", [crId]);

    // Now submit settlement -> succeeds
    const submitOk = await apiFetch(`/api/v1/deposits/${depositId}/settlement`, managerUser.token, {
      method: 'POST',
      body: JSON.stringify({
        items: [],
        refund_method: 'CASH',
        inspection_evidence: [TINY_PNG_B64],
      }),
    });
    assert.equal(submitOk.status, 200);

    // Stale test: mutate credit_balance (add another credit row)
    await adminPool.query(
      `INSERT INTO credit_balance (org_id, building_id, contract_id, tenant_id, amount, applied_amount, reason_type, status, description, created_by)
       VALUES ($1, $2, $3, $4, 500000, 0, 'OVERPAYMENT', 'AVAILABLE', 'Mutated extra credit', $5)`,
      [orgId, buildingId, contractId, tenantId, managerUser.userId]
    );

    // Approve should fail with 409 SETTLEMENT_SNAPSHOT_STALE
    const approveStale = await apiFetch(`/api/v1/deposits/${depositId}/settlement/approve`, ownerUser.token, {
      method: 'POST',
    });
    assert.equal(approveStale.status, 409);
    assert.equal(approveStale.body.code, 'SETTLEMENT_SNAPSHOT_STALE');
  });

  // Test 3: Review Focus #1 & #2 Pins: Case A0, Case A1 (Zero UTILITY_DEBT double deduction + OWNER FORCE RLS approve), Case A, Case B
  await t.test('3. Review Focus #1 & #2: Case A0, Case A1, Case A, Case B', async () => {
    // -------------------------------------------------------------
    // Case A0: 'ADJUSTED' mixed RENT + SERVICE debt split & cross-bucket negative spill
    //          Exact match between JS preview and SQL fn_apply_deposit_settlement_accounting
    // -------------------------------------------------------------
    const contA0 = await adminPool.query(
      `INSERT INTO contract (building_id, apartment_id, primary_tenant_id, start_date, end_date, terminated_at, status, rent_amount, deposit_amount, billing_day)
       VALUES ($1, $2, $3, '2026-01-01', '2026-04-30', '2026-04-30', 'TERMINATED', 4000000, 5000000, 5)
       RETURNING id`,
      [buildingId, aptId, tenantId]
    );
    const contractA0Id = contA0.rows[0].id;
    cleanup.contractIds.push(contractA0Id);

    const depA0 = await adminPool.query(
      `INSERT INTO deposit (contract_id, amount_held, status)
       VALUES ($1, 5000000, 'HELD')
       RETURNING id`,
      [contractA0Id]
    );
    const depositA0Id = depA0.rows[0].id;
    cleanup.depositIds.push(depositA0Id);

    // Seed 'ADJUSTED' invoice with RENT 4M, SERVICE 1M, and negative adjustment -2M on SERVICE
    // raw_service = 1M - 2M = -1M < 0 -> negative spill to raw_rent = 4M - 1M = 3M, raw_service = 0
    // total = 3M, rentDebt = 3M, serviceDebt = 0
    const invA0 = await adminPool.query(
      `INSERT INTO invoice (org_id, building_id, apartment_id, contract_id, tenant_id, invoice_code, period, due_date, subtotal_amount, adjustment_amount, total_amount, paid_amount, status)
       VALUES ($1, $2, $3, $4, $5, $6, '2026-04', '2026-04-10', 5000000, -2000000, 3000000, 0, 'ADJUSTED')
       RETURNING id`,
      [orgId, buildingId, aptId, contractA0Id, tenantId, `INV_A0_${suffix}`]
    );
    cleanup.invoiceIds.push(invA0.rows[0].id);

    await adminPool.query(
      `INSERT INTO invoice_line (invoice_id, item_type, description, quantity, unit, unit_price, amount)
       VALUES ($1, 'RENT', 'Tiền phòng', 1, 'tháng', 4000000, 4000000),
              ($1, 'SERVICE', 'Dịch vụ tiện ích', 1, 'tháng', 1000000, 1000000)`,
      [invA0.rows[0].id]
    );

    // Negative adjustment line: adjusts SERVICE by -2,000,000
    await adminPool.query(
      `INSERT INTO invoice_line (invoice_id, item_type, description, quantity, unit, unit_price, amount, formula_meta)
       VALUES ($1, 'ADJUSTMENT', 'Giảm trừ phí dịch vụ kỳ cuối', 1, 'lần', -2000000, -2000000, $2::jsonb)`,
      [invA0.rows[0].id, JSON.stringify({ adjusts_item_type: 'SERVICE' })]
    );

    // Available credit of 1,000,000 VND
    const cbA0 = await adminPool.query(
      `INSERT INTO credit_balance (org_id, building_id, contract_id, tenant_id, amount, applied_amount, reason_type, status, description, created_by)
       VALUES ($1, $2, $3, $4, 1000000, 0, 'OVERPAYMENT', 'AVAILABLE', 'Số dư thừa đối trừ tiền thuê', $5)
       RETURNING id`,
      [orgId, buildingId, contractA0Id, tenantId, managerUser.userId]
    );

    // Manager submits settlement
    const subA0 = await apiFetch(`/api/v1/deposits/${depositA0Id}/settlement`, managerUser.token, {
      method: 'POST',
      body: JSON.stringify({
        items: [],
        refund_method: 'BANK_TRANSFER',
        bank_info: {
          bank_name: 'Vietcombank',
          account_number: '0123456789',
          account_holder: 'NGUYEN VAN A',
        },
        inspection_evidence: [TINY_PNG_B64],
      }),
    });
    assert.equal(subA0.status, 200, `Submit A0 failed: ${JSON.stringify(subA0.body)}`);

    // Verify JS preview in settlement:
    const sA0 = subA0.body.data.settlement;
    assert.equal(Number(sA0.rent_debt), 3000000, 'Case A0: Negative spill must reduce rent_debt to 3M');
    assert.equal(Number(sA0.service_debt), 0, 'Case A0: Negative spill must leave service_debt at 0');
    assert.equal(Number(sA0.credit_applied_to_rent), 1000000, 'Case A0: Credit 1M pays RENT');
    assert.equal(Number(sA0.credit_applied_to_service), 0);
    assert.equal(Number(sA0.remaining_rent_debt), 2000000, 'Case A0: Remaining rent debt 2M');
    assert.equal(Number(sA0.covered_service_debt), 0);
    assert.equal(Number(sA0.deposit_refund_amount), 5000000, 'Case A0: Full deposit 5M refunded (rent debt not deducted)');
    assert.equal(Number(sA0.total_payout_amount), 5000000);

    // Owner approves settlement under FORCE RLS -> APPROVED_PENDING_PAYOUT
    const appA0 = await apiFetch(`/api/v1/deposits/${depositA0Id}/settlement/approve`, ownerUser.token, {
      method: 'POST',
    });
    assert.equal(appA0.status, 200, `Approve A0 failed: ${JSON.stringify(appA0.body)}`);
    assert.equal(appA0.body.data.status, 'APPROVED_PENDING_PAYOUT');

    // Manager executes payout -> commits settlement accounting in SQL via fn_apply_deposit_settlement_accounting
    const payA0 = await apiFetch(`/api/v1/deposits/${depositA0Id}/payout`, managerUser.token, {
      method: 'POST',
      body: JSON.stringify({
        refund_method: 'BANK_TRANSFER',
        bank_info: {
          bank_name: 'Vietcombank',
          account_number: '0123456789',
          account_holder: 'NGUYEN VAN A',
        },
        evidence: [TINY_PNG_B64],
      }),
    });
    assert.equal(payA0.status, 200, `Payout A0 failed: ${JSON.stringify(payA0.body)}`);
    assert.equal(payA0.body.data.status, 'REFUNDED');

    // Verify exact match between JS preview and SQL accounting execution:
    const postInvA0 = await adminPool.query(
      `SELECT credit_offset_amount, paid_amount, total_amount FROM invoice WHERE id = $1`,
      [invA0.rows[0].id]
    );
    assert.equal(Number(postInvA0.rows[0].credit_offset_amount), 1000000, 'SQL: credit_offset_amount must match JS credit_applied_to_rent (1M)');
    const sqlRemainingDebt = Number(postInvA0.rows[0].total_amount) - Number(postInvA0.rows[0].paid_amount);
    assert.equal(sqlRemainingDebt, 2000000, 'SQL remaining debt must match JS remaining_rent_debt (2M)');

    const postCbA0 = await adminPool.query(
      `SELECT applied_amount, status FROM credit_balance WHERE id = $1`,
      [cbA0.rows[0].id]
    );
    assert.equal(Number(postCbA0.rows[0].applied_amount), 1000000, 'SQL: Credit applied_amount must be 1M');
    assert.equal(postCbA0.rows[0].status, 'APPLIED');

    // Deposit status and no UTILITY_DEBT deduct row
    const depPostA0 = await adminPool.query(`SELECT status, amount_held FROM deposit WHERE id = $1`, [depositA0Id]);
    assert.equal(depPostA0.rows[0].status, 'REFUNDED');
    assert.equal(Number(depPostA0.rows[0].amount_held), 0);

    const txA0 = await adminPool.query(`SELECT * FROM deposit_transaction WHERE deposit_id = $1`, [depositA0Id]);
    assert.equal(txA0.rows.filter(r => r.category === 'UTILITY_DEBT').length, 0, 'No UTILITY_DEBT deduct row when serviceDebt is 0');
    assert.equal(txA0.rows.filter(r => r.type === 'refund').length, 1);
    assert.equal(Number(txA0.rows.find(r => r.type === 'refund').amount), 5000000);

    // -------------------------------------------------------------
    // Case A1: heldBefore = 5M, credit = 1.5M, serviceDebt = 1.5M, rentDebt = 0, items = []
    // -------------------------------------------------------------
    const contA1 = await adminPool.query(
      `INSERT INTO contract (building_id, apartment_id, primary_tenant_id, start_date, end_date, terminated_at, status, rent_amount, deposit_amount, billing_day)
       VALUES ($1, $2, $3, '2026-01-01', '2026-04-30', '2026-04-30', 'TERMINATED', 5000000, 5000000, 5)
       RETURNING id`,
      [buildingId, aptId, tenantId]
    );
    const contractA1Id = contA1.rows[0].id;
    cleanup.contractIds.push(contractA1Id);

    const depA1 = await adminPool.query(
      `INSERT INTO deposit (contract_id, amount_held, status)
       VALUES ($1, 5000000, 'HELD')
       RETURNING id`,
      [contractA1Id]
    );
    const depositA1Id = depA1.rows[0].id;
    cleanup.depositIds.push(depositA1Id);

    // Invoice with 1.5M serviceDebt
    const invA1 = await adminPool.query(
      `INSERT INTO invoice (org_id, building_id, apartment_id, contract_id, tenant_id, invoice_code, period, due_date, subtotal_amount, total_amount, paid_amount, status)
       VALUES ($1, $2, $3, $4, $5, $6, '2026-04', '2026-04-10', 1500000, 1500000, 0, 'ISSUED')
       RETURNING id`,
      [orgId, buildingId, aptId, contractA1Id, tenantId, `INV_A1_${suffix}`]
    );
    cleanup.invoiceIds.push(invA1.rows[0].id);

    await adminPool.query(
      `INSERT INTO invoice_line (invoice_id, item_type, description, quantity, unit, unit_price, amount)
       VALUES ($1, 'SERVICE', 'Dịch vụ tiện ích', 1, 'tháng', 1500000, 1500000)`,
      [invA1.rows[0].id]
    );

    // Available credit of 1.5M
    await adminPool.query(
      `INSERT INTO credit_balance (org_id, building_id, contract_id, tenant_id, amount, applied_amount, reason_type, status, description, created_by)
       VALUES ($1, $2, $3, $4, 1500000, 0, 'OVERPAYMENT', 'AVAILABLE', 'Số dư thừa đối trừ dịch vụ', $5)`,
      [orgId, buildingId, contractA1Id, tenantId, managerUser.userId]
    );

    // Manager submits settlement
    const subA1 = await apiFetch(`/api/v1/deposits/${depositA1Id}/settlement`, managerUser.token, {
      method: 'POST',
      body: JSON.stringify({
        items: [],
        refund_method: 'BANK_TRANSFER',
        bank_info: {
          bank_name: 'Vietcombank',
          account_number: '0123456789',
          account_holder: 'NGUYEN VAN A',
        },
        inspection_evidence: [TINY_PNG_B64],
      }),
    });
    assert.equal(subA1.status, 200, `Submit A1 failed: ${JSON.stringify(subA1.body)}`);

    // OWNER calls POST /api/v1/deposits/:id/settlement/approve under FORCE RLS
    const appA1 = await apiFetch(`/api/v1/deposits/${depositA1Id}/settlement/approve`, ownerUser.token, {
      method: 'POST',
    });
    assert.equal(appA1.status, 200, `Owner approve A1 failed: ${JSON.stringify(appA1.body)}`);
    assert.equal(appA1.body.data.status, 'APPROVED_PENDING_PAYOUT');

    // MANAGER calls POST /:id/payout
    const payA1 = await apiFetch(`/api/v1/deposits/${depositA1Id}/payout`, managerUser.token, {
      method: 'POST',
      body: JSON.stringify({
        refund_method: 'BANK_TRANSFER',
        bank_info: {
          bank_name: 'Vietcombank',
          account_number: '0123456789',
          account_holder: 'NGUYEN VAN A',
        },
        evidence: [TINY_PNG_B64],
      }),
    });
    assert.equal(payA1.status, 200, `Payout A1 failed: ${JSON.stringify(payA1.body)}`);

    // Check deposit_transaction: MUST HAVE ZERO UTILITY_DEBT deduct rows!
    const txA1 = await adminPool.query(
      `SELECT * FROM deposit_transaction WHERE deposit_id = $1 ORDER BY created_at ASC`,
      [depositA1Id]
    );
    const utilityDeductRows = txA1.rows.filter(
      (r) => r.type === 'deduct' && r.category === 'UTILITY_DEBT'
    );
    assert.equal(utilityDeductRows.length, 0, 'CRITICAL RP-07 FAILURE: UTILITY_DEBT was double deducted!');

    const refundRows = txA1.rows.filter((r) => r.type === 'refund');
    assert.equal(refundRows.length, 1);
    assert.equal(Number(refundRows[0].amount), 5000000);

    // Check deposit ledger report RP-07 has closing_held === 0
    const ledgerA1 = await apiFetch(`/api/v1/reports/deposit-ledger?building_id=${buildingId}`, managerUser.token);
    assert.equal(ledgerA1.status, 200);
    const ledgerRow = ledgerA1.body.data.rows.find((r) => r.deposit_id === depositA1Id);
    if (ledgerRow) {
      assert.equal(Number(ledgerRow.closing_held), 0);
    }

    // -------------------------------------------------------------
    // Case A: total_payout_amount === 0 approved by OWNER
    // -------------------------------------------------------------
    const contA = await adminPool.query(
      `INSERT INTO contract (building_id, apartment_id, primary_tenant_id, start_date, end_date, terminated_at, status, rent_amount, deposit_amount, billing_day)
       VALUES ($1, $2, $3, '2026-01-01', '2026-04-30', '2026-04-30', 'TERMINATED', 3000000, 3000000, 5)
       RETURNING id`,
      [buildingId, aptId, tenantId]
    );
    const contractAId = contA.rows[0].id;
    cleanup.contractIds.push(contractAId);

    const depA = await adminPool.query(
      `INSERT INTO deposit (contract_id, amount_held, status)
       VALUES ($1, 3000000, 'HELD')
       RETURNING id`,
      [contractAId]
    );
    const depositAId = depA.rows[0].id;
    cleanup.depositIds.push(depositAId);

    // Submit settlement with 3M damage items -> refund 0, total_payout 0
    const subA = await apiFetch(`/api/v1/deposits/${depositAId}/settlement`, managerUser.token, {
      method: 'POST',
      body: JSON.stringify({
        items: [{ amount: 3000000, category: 'DAMAGE', description: 'Hỏng sofa', evidence: [TINY_PNG_B64] }],
        refund_method: 'CASH',
        inspection_evidence: [TINY_PNG_B64],
      }),
    });
    assert.equal(subA.status, 200);

    // OWNER approves -> since total_payout === 0, status directly transitions to DEDUCTED_FULL
    const appA = await apiFetch(`/api/v1/deposits/${depositAId}/settlement/approve`, ownerUser.token, {
      method: 'POST',
    });
    assert.equal(appA.status, 200);
    assert.equal(appA.body.data.status, 'DEDUCTED_FULL');
    assert.equal(Number(appA.body.data.amount_held), 0);

    // -------------------------------------------------------------
    // Case B: deposit_refund_amount = 0, credit_refund_amount = 1.8M > 0
    // -> APPROVED_PENDING_PAYOUT -> bank-info -> pdf -> payout -> DEDUCTED_FULL (0 refund tx)
    // -> payout-returned -> RETURNED -> payout reissue
    // -------------------------------------------------------------
    const contB = await adminPool.query(
      `INSERT INTO contract (building_id, apartment_id, primary_tenant_id, start_date, end_date, terminated_at, status, rent_amount, deposit_amount, billing_day)
       VALUES ($1, $2, $3, '2026-01-01', '2026-04-30', '2026-04-30', 'TERMINATED', 2000000, 2000000, 5)
       RETURNING id`,
      [buildingId, aptId, tenantId]
    );
    const contractBId = contB.rows[0].id;
    cleanup.contractIds.push(contractBId);

    const depB = await adminPool.query(
      `INSERT INTO deposit (contract_id, amount_held, status)
       VALUES ($1, 2000000, 'HELD')
       RETURNING id`,
      [contractBId]
    );
    const depositBId = depB.rows[0].id;
    cleanup.depositIds.push(depositBId);

    // Seed 1.8M credit
    await adminPool.query(
      `INSERT INTO credit_balance (org_id, building_id, contract_id, tenant_id, amount, applied_amount, reason_type, status, description, created_by)
       VALUES ($1, $2, $3, $4, 1800000, 0, 'OVERPAYMENT', 'AVAILABLE', 'Credit for refund test', $5)`,
      [orgId, buildingId, contractBId, tenantId, managerUser.userId]
    );

    // Submit with 2M damages (wiping held deposit to 0, leaving 1.8M credit refund)
    const subB = await apiFetch(`/api/v1/deposits/${depositBId}/settlement`, managerUser.token, {
      method: 'POST',
      body: JSON.stringify({
        items: [{ amount: 2000000, category: 'DAMAGE', description: 'Hỏng điều hòa', evidence: [TINY_PNG_B64] }],
        refund_method: 'BANK_TRANSFER',
        bank_info: {
          bank_name: 'Techcombank',
          account_number: '1903333333',
          account_holder: 'TRAN VAN B',
        },
        inspection_evidence: [TINY_PNG_B64],
      }),
    });
    assert.equal(subB.status, 200);

    // Owner approves -> APPROVED_PENDING_PAYOUT because credit_refund > 0
    const appB = await apiFetch(`/api/v1/deposits/${depositBId}/settlement/approve`, ownerUser.token, {
      method: 'POST',
    });
    assert.equal(appB.status, 200);
    assert.equal(appB.body.data.status, 'APPROVED_PENDING_PAYOUT');

    // Update bank info via resident/manager
    const bankUpdateB = await apiFetch(`/api/v1/deposits/${depositBId}/refund-bank-info`, managerUser.token, {
      method: 'PATCH',
      body: JSON.stringify({
        bank_info: {
          bank_name: 'Techcombank Updated',
          account_number: '1909999999',
          account_holder: 'TRAN VAN B',
        },
      }),
    });
    assert.equal(bankUpdateB.status, 200);

    // PDF view returns 200
    const pdfB = await apiFetch(`/api/v1/deposits/${depositBId}/settlement/pdf`, residentUser.token);
    assert.equal(pdfB.status, 200);
    assert.ok(pdfB.contentType.includes('text/html'));

    // Manager executes payout
    const payB = await apiFetch(`/api/v1/deposits/${depositBId}/payout`, managerUser.token, {
      method: 'POST',
      body: JSON.stringify({
        refund_method: 'BANK_TRANSFER',
        evidence: [TINY_PNG_B64],
      }),
    });
    assert.equal(payB.status, 200);
    // Since deposit_refund_amount = 0, status is DEDUCTED_FULL!
    assert.equal(payB.body.data.status, 'DEDUCTED_FULL');

    // Verify 0 deposit_transaction 'refund' rows!
    const txB = await adminPool.query(
      `SELECT * FROM deposit_transaction WHERE deposit_id = $1 AND type = 'refund'`,
      [depositBId]
    );
    assert.equal(txB.rows.length, 0, 'Expected 0 refund transactions when deposit_refund_amount is 0!');

    // Payout returned
    const retB = await apiFetch(`/api/v1/deposits/${depositBId}/payout-returned`, managerUser.token, {
      method: 'POST',
      body: JSON.stringify({
        reason: 'Sai số tài khoản nhận tiền',
      }),
    });
    assert.equal(retB.status, 200);
    assert.equal(retB.body.data.status, 'RETURNED');

    // Verify credit_balance is restored to PENDING_SETTLEMENT_PAYOUT
    const crCheck = await adminPool.query(
      `SELECT status FROM credit_balance WHERE contract_id = $1`,
      [contractBId]
    );
    assert.equal(crCheck.rows[0].status, 'PENDING_SETTLEMENT_PAYOUT');

    // Reissue payout
    const reissueB = await apiFetch(`/api/v1/deposits/${depositBId}/payout`, managerUser.token, {
      method: 'POST',
      body: JSON.stringify({
        refund_method: 'BANK_TRANSFER',
        evidence: [TINY_PNG_B64],
      }),
    });
    assert.equal(reissueB.status, 200);
    assert.equal(reissueB.body.data.status, 'DEDUCTED_FULL');

    const crRecommit = await adminPool.query(
      `SELECT status FROM credit_balance WHERE contract_id = $1`,
      [contractBId]
    );
    assert.equal(crRecommit.rows[0].status, 'REFUNDED_IN_SETTLEMENT');
  });

  // Test 4: KPI Reports (/dashboard & /summary) & xlsx buffer
  await t.test('4. KPI Reports: billed, collected, invoice_settled, 4-eyes counts & format=xlsx', async () => {
    const curPeriod = getTodayVn().slice(0, 7);

    // Contract for KPI test
    const contKpi = await adminPool.query(
      `INSERT INTO contract (building_id, apartment_id, primary_tenant_id, start_date, end_date, status, rent_amount, deposit_amount, billing_day)
       VALUES ($1, $2, $3, '2026-01-01', '2026-12-31', 'ACTIVE', 8000000, 8000000, 5)
       RETURNING id`,
      [buildingId, aptId, tenantId]
    );
    cleanup.contractIds.push(contKpi.rows[0].id);

    // Invoice: total_amount 8M, paid_amount 8M, credit_offset_amount 2M -> billed = 10M, invoice_settled = 10M
    const invKpi = await adminPool.query(
      `INSERT INTO invoice (org_id, building_id, apartment_id, contract_id, tenant_id, invoice_code, period, due_date, subtotal_amount, total_amount, paid_amount, credit_offset_amount, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, '2026-11-10', 8000000, 8000000, 8000000, 2000000, 'PAID')
       RETURNING id`,
      [orgId, buildingId, aptId, contKpi.rows[0].id, tenantId, `INV_KPI_${suffix}`, curPeriod]
    );
    cleanup.invoiceIds.push(invKpi.rows[0].id);

    // Payment: 9M confirmed
    await adminPool.query(
      `INSERT INTO payment (org_id, building_id, contract_id, tenant_id, invoice_id, payment_code, amount, status, paid_at)
       VALUES ($1, $2, $3, $4, $5, $6, 9000000, 'CONFIRMED', NOW())`,
      [orgId, buildingId, contKpi.rows[0].id, tenantId, invKpi.rows[0].id, `PAY_KPI_${suffix}`]
    );

    // Credit direct refund: 1M
    await adminPool.query(
      `INSERT INTO credit_balance (org_id, building_id, contract_id, tenant_id, amount, applied_amount, reason_type, status, refunded_at, description, created_by)
       VALUES ($1, $2, $3, $4, 1000000, 1000000, 'OVERPAYMENT', 'REFUNDED_DIRECT', NOW(), 'Direct refund', $5)`,
      [orgId, buildingId, contKpi.rows[0].id, tenantId, managerUser.userId]
    );

    // Credit settlement refund: 0.5M
    await adminPool.query(
      `INSERT INTO credit_balance (org_id, building_id, contract_id, tenant_id, amount, applied_amount, settlement_refund_amount, reason_type, status, refunded_at, description, created_by)
       VALUES ($1, $2, $3, $4, 500000, 500000, 500000, 'OVERPAYMENT', 'REFUNDED_IN_SETTLEMENT', NOW(), 'Settlement refund', $5)`,
      [orgId, buildingId, contKpi.rows[0].id, tenantId, managerUser.userId]
    );

    // Receivables for aging buckets
    await adminPool.query(
      `INSERT INTO receivable (org_id, building_id, contract_id, tenant_id, type, amount, paid_amount, due_date, status)
       VALUES ($1, $2, $3, $4, 'INVOICE_DEBT', 1000000, 0, CURRENT_DATE + 5, 'OPEN'),
              ($1, $2, $3, $4, 'INVOICE_DEBT', 2000000, 0, CURRENT_DATE - 10, 'OPEN'),
              ($1, $2, $3, $4, 'INVOICE_DEBT', 3000000, 0, CURRENT_DATE - 20, 'OPEN'),
              ($1, $2, $3, $4, 'INVOICE_DEBT', 4000000, 0, CURRENT_DATE - 40, 'OPEN'),
              ($1, $2, $3, $4, 'INVOICE_DEBT', 5000000, 0, CURRENT_DATE - 70, 'OPEN')`,
      [orgId, buildingId, contKpi.rows[0].id, tenantId]
    );

    // 1 pending adjustment & 1 pending credit refund for dashboard counts
    await adminPool.query(
      `INSERT INTO invoice_adjustment (org_id, building_id, invoice_id, created_by, action_type, delta_amount, reason, status)
       VALUES ($1, $2, $3, $4, 'ADJUST', -100000, 'Dashboard test pending adjustment', 'PENDING_APPROVAL')`,
      [orgId, buildingId, invKpi.rows[0].id, managerUser.userId]
    );

    await adminPool.query(
      `INSERT INTO credit_balance (org_id, building_id, contract_id, tenant_id, amount, applied_amount, reason_type, status, description, created_by)
       VALUES ($1, $2, $3, $4, 200000, 0, 'OVERPAYMENT', 'PENDING_DIRECT_REFUND', 'Dashboard test pending credit', $5)`,
      [orgId, buildingId, contKpi.rows[0].id, tenantId, managerUser.userId]
    );

    // GET /api/v1/reports/dashboard
    const dashRes = await apiFetch(`/api/v1/reports/dashboard?building_id=${buildingId}`, managerUser.token);
    assert.equal(dashRes.status, 200);
    const kpis = dashRes.body.data.kpis;
    assert.equal(kpis.pending_invoice_adjustments, 1);
    assert.equal(kpis.pending_credit_refunds, 1);
    assert.equal(kpis.monthly_billed, 10000000);
    assert.equal(kpis.monthly_revenue, 5700000); // 9M - 1M - 0.5M - 1.8M from Case B

    const curMonthRev = dashRes.body.data.revenue_12m.find((r) => r.period === curPeriod);
    assert.ok(curMonthRev);
    assert.equal(curMonthRev.invoice_settled, 10000000);

    // GET /api/v1/reports/summary?section=aging&format=xlsx
    const agingXlsx = await apiFetch(
      `/api/v1/reports/summary?building_id=${buildingId}&section=aging&format=xlsx`,
      managerUser.token,
      { rawBuffer: true }
    );
    assert.equal(agingXlsx.status, 200);
    assert.ok(agingXlsx.contentType.includes('spreadsheetml'));
    assert.equal(agingXlsx.buffer[0], 0x50); // 'P'
    assert.equal(agingXlsx.buffer[1], 0x4b); // 'K'

    // GET /api/v1/reports/summary?section=revenue&format=csv
    const revCsv = await apiFetch(
      `/api/v1/reports/summary?building_id=${buildingId}&section=revenue&format=csv`,
      managerUser.token
    );
    assert.equal(revCsv.status, 200);
    assert.ok(revCsv.contentType.includes('text/csv'));
  });

  // Test 5: RP-08 12-Entity Audit Logs & format=xlsx
  await t.test('5. RP-08: 12-entity FINANCIAL_AUDIT_ENTITIES, MANAGER permissions, format=xlsx', async () => {
    // Unscoped audit-logs returns 403 for MANAGER
    const unscopedMgr = await apiFetch('/api/v1/audit-logs', managerUser.token);
    assert.equal(unscopedMgr.status, 403, 'Unscoped /audit-logs should return 403 for MANAGER');

    // Scoped financial returns 200 for MANAGER
    const scopedMgr = await apiFetch('/api/v1/audit-logs?scope=financial', managerUser.token);
    assert.equal(scopedMgr.status, 200, 'scope=financial should return 200 for MANAGER');

    // Scoped financial returns 200 for OWNER
    const scopedOwner = await apiFetch('/api/v1/audit-logs?scope=financial', ownerUser.token);
    assert.equal(scopedOwner.status, 200);

    // Export CSV returns 200
    const csvRes = await apiFetch('/api/v1/audit-logs?scope=financial&format=csv', managerUser.token);
    assert.equal(csvRes.status, 200);
    assert.ok(csvRes.contentType.includes('text/csv'));

    // Export XLSX returns valid buffer (0x50 0x4B PK zip header)
    const xlsxRes = await apiFetch(
      '/api/v1/audit-logs?scope=financial&format=xlsx',
      managerUser.token,
      { rawBuffer: true }
    );
    assert.equal(xlsxRes.status, 200);
    assert.ok(xlsxRes.contentType.includes('spreadsheetml'));
    assert.equal(xlsxRes.buffer[0], 0x50);
    assert.equal(xlsxRes.buffer[1], 0x4b);
  });
});
