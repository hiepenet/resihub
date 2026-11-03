import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import pg from 'pg';
import bcrypt from 'bcryptjs';

dotenv.config();

const ADMIN_DB_URL =
  process.env.DATABASE_URL ||
  'postgres://postgres:postgres@127.0.0.1:5433/resihub';

const TINY_PNG_B64 =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

test('Task 5 — Invoices DRAFT Line CRUD, Four-Eyes Approvals, Credit Balance & Payments', async (t) => {
  const adminPool = new pg.Pool({ connectionString: ADMIN_DB_URL });

  // Import application routes
  const { default: authRoute } = await import('../src/routes/auth.js');
  const { default: invoicesRoute } = await import('../src/routes/invoices.js');
  const { default: paymentsRoute, receivablesRouter } = await import('../src/routes/payments.js');
  const { default: attachmentsRoute } = await import('../src/routes/attachments.js');
  const { default: tenantsRoute } = await import('../src/routes/tenants.js');

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
  app.use('/api/v1/invoices', invoicesRoute);
  app.use('/api/v1/payments', paymentsRoute);
  app.use('/api/v1/receivables', receivablesRouter);
  app.use('/api/v1/attachments', attachmentsRoute);
  app.use('/api/v1/tenants', tenantsRoute);

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const API_BASE = `http://127.0.0.1:${server.address().port}`;

  async function apiFetch(path, token, options = {}) {
    const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(`${API_BASE}${path}`, { ...options, headers });
    const contentType = res.headers.get('content-type') || '';
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

  async function loginEmail(email, password) {
    const res = await apiFetch('/api/v1/auth/login', null, {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
    assert.equal(res.status, 200, `Login failed for ${email}: ${JSON.stringify(res.body)}`);
    return { token: res.body.accessToken, user: res.body.user };
  }

  // Setup standard users & cleanup tracking
  const sysAdmin = await loginEmail('admin@resihub.vn', 'Admin@123456');
  const ownerVop = await loginEmail('owner.vop@resihub.vn', 'Demo@123456');
  const mgrVopA = await loginEmail('manager.vop.a@resihub.vn', 'Demo@123456');
  const resident1 = await loginEmail('tenant1@resihub.vn', 'Demo@123456');

  // Query metadata for VOP-A building and org
  const bldgRes = await adminPool.query(
    `SELECT b.id, b.org_id FROM building b WHERE b.code = 'VOP-A' LIMIT 1`
  );
  assert.ok(bldgRes.rows.length > 0, 'Building VOP-A must exist');
  const vopAId = bldgRes.rows[0].id;
  const orgId = bldgRes.rows[0].org_id;

  // Create a second manager for VOP-A for 4-eyes cross-approval
  const suffix = `${String(Date.now()).slice(-6)}`;
  const mgr2Email = `mgr2.vop.a.${suffix}@resihub.vn`;
  const pwdHash = await bcrypt.hash('Demo@123456', 10);
  const p2Res = await adminPool.query(
    `INSERT INTO person (org_id, full_name, email, phone)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [orgId, `Manager 2 VOP-A ${suffix}`, mgr2Email, `091${suffix.slice(0, 7)}`]
  );
  const u2Res = await adminPool.query(
    `INSERT INTO app_user (person_id, password_hash, status)
     VALUES ($1, $2, 'ACTIVE')
     RETURNING id`,
    [p2Res.rows[0].id, pwdHash]
  );
  const roleMgrRes = await adminPool.query(`SELECT id FROM role WHERE code = 'MANAGER' LIMIT 1`);
  await adminPool.query(
    `INSERT INTO user_role (user_id, role_id, building_id) VALUES ($1, $2, $3)`,
    [u2Res.rows[0].id, roleMgrRes.rows[0].id, vopAId]
  );
  const mgr2VopA = await loginEmail(mgr2Email, 'Demo@123456');

  const cleanups = {
    invoices: [],
    adjustments: [],
    payments: [],
    credits: [],
    receivables: [],
    contracts: [],
    apartments: [],
    tenants: [],
  };

  t.after(async () => {
    if (cleanups.credits.length > 0) {
      await adminPool.query(`DELETE FROM credit_balance WHERE id = ANY($1)`, [cleanups.credits]).catch(() => {});
    }
    if (cleanups.receivables.length > 0) {
      await adminPool.query(`DELETE FROM receivable WHERE id = ANY($1)`, [cleanups.receivables]).catch(() => {});
    }
    if (cleanups.payments.length > 0) {
      await adminPool.query(`DELETE FROM payment WHERE id = ANY($1)`, [cleanups.payments]).catch(() => {});
    }
    if (cleanups.adjustments.length > 0) {
      await adminPool.query(`DELETE FROM invoice_adjustment WHERE id = ANY($1)`, [cleanups.adjustments]).catch(() => {});
    }
    if (cleanups.invoices.length > 0) {
      await adminPool.query(`DELETE FROM invoice_line WHERE invoice_id = ANY($1)`, [cleanups.invoices]).catch(() => {});
      await adminPool.query(`DELETE FROM invoice WHERE id = ANY($1)`, [cleanups.invoices]).catch(() => {});
    }
    if (cleanups.contracts.length > 0) {
      await adminPool.query(`DELETE FROM contract_service_price WHERE contract_id = ANY($1)`, [cleanups.contracts]).catch(() => {});
      await adminPool.query(`DELETE FROM contract WHERE id = ANY($1)`, [cleanups.contracts]).catch(() => {});
    }
    if (cleanups.apartments.length > 0) {
      await adminPool.query(`DELETE FROM meter_reading WHERE apartment_id = ANY($1)`, [cleanups.apartments]).catch(() => {});
      await adminPool.query(`DELETE FROM apartment WHERE id = ANY($1)`, [cleanups.apartments]).catch(() => {});
    }
    await new Promise((resolve) => server.close(resolve));
    await adminPool.end().catch(() => {});
  });

  // =========================================================================
  // Subtest 1: DRAFT line CRUD, credit line preservation, paid_amount > 0 ALREADY_PAID,
  //            skipped_contracts on 0 billable, and existing DRAFT refresh
  // =========================================================================
  await t.test('1. DRAFT line CRUD, credit line preservation, ALREADY_PAID guard, skipped_contracts & DRAFT refresh', async () => {
    // 1a. Create test apartment and tenant for isolated testing
    const aptRes = await adminPool.query(
      `INSERT INTO apartment (building_id, code, status, area_m2)
       VALUES ($1, $2, 'OCCUPIED', 45)
       RETURNING id, code`,
      [vopAId, `T5-A1-${suffix}`]
    );
    const aptId = aptRes.rows[0].id;
    cleanups.apartments.push(aptId);

    const tenantRes = await adminPool.query(
      `SELECT t.id, t.person_id FROM tenant t
       JOIN contract c ON c.primary_tenant_id = t.id
       WHERE c.building_id = $1 LIMIT 1`,
      [vopAId]
    );
    const tenantId = tenantRes.rows[0].id;

    // Create contract
    const contractRes = await adminPool.query(
      `INSERT INTO contract (
         building_id, apartment_id, primary_tenant_id,
         start_date, end_date, rent_amount, deposit_amount, status, billing_day
       ) VALUES ($1, $2, $3, '2026-01-01', '2026-12-31', 8000000, 8000000, 'ACTIVE', 1)
       RETURNING id`,
      [vopAId, aptId, tenantId]
    );
    const contractId = contractRes.rows[0].id;
    cleanups.contracts.push(contractId);

    // Create DRAFT invoice
    const draftRes = await adminPool.query(
      `INSERT INTO invoice (
         org_id, building_id, apartment_id, contract_id, tenant_id,
         invoice_code, period, due_date, subtotal_amount, adjustment_amount,
         total_amount, paid_amount, status
       ) VALUES (
         $1, $2, $3, $4, $5,
         $6, '2026-11', CURRENT_DATE + 5, 8000000, 0, 8000000, 0, 'DRAFT'
       ) RETURNING id, invoice_code`,
      [orgId, vopAId, aptId, contractId, tenantId, `INV-DRAFT-${suffix}`]
    );
    const draftId = draftRes.rows[0].id;
    cleanups.invoices.push(draftId);

    // Initial RENT line
    await adminPool.query(
      `INSERT INTO invoice_line (invoice_id, item_type, description, quantity, unit, unit_price, amount)
       VALUES ($1, 'RENT', 'Tiền thuê tháng 11/2026', 1, 'tháng', 8000000, 8000000)`,
      [draftId]
    );

    // 1b. POST /api/v1/invoices/:id/lines (Manager adds a line)
    const addLineRes = await apiFetch(`/api/v1/invoices/${draftId}/lines`, mgrVopA.token, {
      method: 'POST',
      headers: { 'Idempotency-Key': `idem-line-add-${suffix}` },
      body: JSON.stringify({
        item_type: 'OTHER',
        description: 'Phí gửi xe phụ',
        quantity: 1,
        unit: 'xe',
        unit_price: 150000,
        amount: 150000,
      }),
    });
    assert.equal(addLineRes.status, 201, `Add line failed: ${JSON.stringify(addLineRes.body)}`);
    const lineId = addLineRes.body.data?.line?.id || addLineRes.body.data?.id;
    assert.ok(lineId, 'Line ID must be returned');

    // Check recalculated totals on invoice: subtotal = 8150000, total = 8150000
    const invCheck1 = await adminPool.query('SELECT subtotal_amount, total_amount FROM invoice WHERE id = $1', [draftId]);
    assert.equal(Number(invCheck1.rows[0].subtotal_amount), 8150000);
    assert.equal(Number(invCheck1.rows[0].total_amount), 8150000);

    // 1c. PATCH /api/v1/invoices/:id/lines/:lineId
    const patchLineRes = await apiFetch(`/api/v1/invoices/${draftId}/lines/${lineId}`, mgrVopA.token, {
      method: 'PATCH',
      headers: { 'Idempotency-Key': `idem-line-patch-${suffix}` },
      body: JSON.stringify({
        amount: 200000,
        unit_price: 200000,
      }),
    });
    assert.equal(patchLineRes.status, 200, `Patch line failed: ${JSON.stringify(patchLineRes.body)}`);
    const invCheck2 = await adminPool.query('SELECT subtotal_amount, total_amount FROM invoice WHERE id = $1', [draftId]);
    assert.equal(Number(invCheck2.rows[0].subtotal_amount), 8200000);
    assert.equal(Number(invCheck2.rows[0].total_amount), 8200000);

    // 1d. DELETE /api/v1/invoices/:id/lines/:lineId
    const delLineRes = await apiFetch(`/api/v1/invoices/${draftId}/lines/${lineId}`, mgrVopA.token, {
      method: 'DELETE',
      headers: { 'Idempotency-Key': `idem-line-del-${suffix}` },
    });
    assert.equal(delLineRes.status, 200, `Delete line failed: ${JSON.stringify(delLineRes.body)}`);
    const invCheck3 = await adminPool.query('SELECT subtotal_amount, total_amount FROM invoice WHERE id = $1', [draftId]);
    assert.equal(Number(invCheck3.rows[0].subtotal_amount), 8000000);
    assert.equal(Number(invCheck3.rows[0].total_amount), 8000000);

    // 1e. Preservation of credit_id IS NOT NULL line on PATCH status { adjustment_amount }
    // Insert a credit offset line on the draft invoice
    const creditSeed = await adminPool.query(
      `INSERT INTO credit_balance (org_id, building_id, contract_id, tenant_id, reason_type, amount, applied_amount, status, description)
       VALUES ($1, $2, $3, $4, 'OVERPAYMENT', 500000, 500000, 'APPLIED', 'Seed credit for preservation test')
       RETURNING id`,
      [orgId, vopAId, contractId, tenantId]
    );
    const creditId = creditSeed.rows[0].id;
    cleanups.credits.push(creditId);

    const crLineRes = await adminPool.query(
      `INSERT INTO invoice_line (invoice_id, item_type, description, quantity, unit, unit_price, amount, credit_id)
       VALUES ($1, 'ADJUSTMENT', 'Bù trừ số dư tín dụng', 1, 'lần', -500000, -500000, $2)
       RETURNING id`,
      [draftId, creditId]
    );
    await adminPool.query(
      `UPDATE invoice SET credit_offset_amount = 500000, total_amount = 7500000 WHERE id = $1`,
      [draftId]
    );

    // Now call PATCH /api/v1/invoices/:id/status with manual adjustment_amount: -100000
    const patchAdjRes = await apiFetch(`/api/v1/invoices/${draftId}/status`, mgrVopA.token, {
      method: 'PATCH',
      headers: { 'Idempotency-Key': `idem-adj-status-${suffix}` },
      body: JSON.stringify({
        adjustment_amount: -100000,
        adjustment_reason: 'Chiết khấu thủ công đợt 1',
      }),
    });
    assert.equal(patchAdjRes.status, 200, `Patch adjustment failed: ${JSON.stringify(patchAdjRes.body)}`);

    // Verify credit_id IS NOT NULL line is STILL PRESENT in invoice_line
    const crLineCheck = await adminPool.query(
      `SELECT * FROM invoice_line WHERE invoice_id = $1 AND credit_id = $2`,
      [draftId, creditId]
    );
    assert.equal(crLineCheck.rows.length, 1, 'Credit offset line MUST NOT be deleted when applying manual adjustment');
    assert.equal(Number(crLineCheck.rows[0].amount), -500000);

    // 1f. Check #1 on PATCH /api/v1/invoices/:id/status: paid_amount > 0 returns 409 ALREADY_PAID FIRST
    // Create an invoice with paid_amount > 0 and try to VOID/CANCEL
    const paidInvRes = await adminPool.query(
      `INSERT INTO invoice (
         org_id, building_id, apartment_id, contract_id, tenant_id,
         invoice_code, period, due_date, subtotal_amount, adjustment_amount,
         total_amount, paid_amount, status
       ) VALUES (
         $1, $2, $3, $4, $5,
         $6, '2026-10', CURRENT_DATE - 10, 5000000, 0, 5000000, 2000000, 'PARTIALLY_PAID'
       ) RETURNING id`,
      [orgId, vopAId, aptId, contractId, tenantId, `INV-PAID-GUARD-${suffix}`]
    );
    const paidInvId = paidInvRes.rows[0].id;
    cleanups.invoices.push(paidInvId);

    const voidPaidAttempt = await apiFetch(`/api/v1/invoices/${paidInvId}/status`, mgrVopA.token, {
      method: 'PATCH',
      headers: { 'Idempotency-Key': `idem-void-paid-${suffix}` },
      body: JSON.stringify({ status: 'CANCELLED' }), // or 'VOID'
    });
    assert.equal(voidPaidAttempt.status, 409, 'Must return 409 when attempting to cancel partially paid invoice');
    assert.equal(voidPaidAttempt.body.code, 'ALREADY_PAID', 'Must return code ALREADY_PAID even before 4-eyes check');

    // 1g. Check #2: non-DRAFT invoice without payments returns 409 REQUIRES_FOUR_EYES_ADJUSTMENT on direct VOID or adjustment_amount
    const issuedUnpaidRes = await adminPool.query(
      `INSERT INTO invoice (
         org_id, building_id, apartment_id, contract_id, tenant_id,
         invoice_code, period, due_date, subtotal_amount, adjustment_amount,
         total_amount, paid_amount, status
       ) VALUES (
         $1, $2, $3, $4, $5,
         $6, '2026-09', CURRENT_DATE + 5, 5000000, 0, 5000000, 0, 'ISSUED'
       ) RETURNING id`,
      [orgId, vopAId, aptId, contractId, tenantId, `INV-ISSUED-GUARD-${suffix}`]
    );
    const issuedUnpaidId = issuedUnpaidRes.rows[0].id;
    cleanups.invoices.push(issuedUnpaidId);

    const directVoidAttempt = await apiFetch(`/api/v1/invoices/${issuedUnpaidId}/status`, mgrVopA.token, {
      method: 'PATCH',
      headers: { 'Idempotency-Key': `idem-four-eyes-void-${suffix}` },
      body: JSON.stringify({ status: 'CANCELLED' }),
    });
    assert.equal(directVoidAttempt.status, 409, 'Must return 409 on direct cancellation of issued invoice');
    assert.equal(directVoidAttempt.body.code, 'REQUIRES_FOUR_EYES_ADJUSTMENT');

    // 1h. POST /api/v1/invoices/generate-batch returns skipped_contracts array (AC-015.1)
    // Create a contract with 0 rent amount and no billable services
    const aptZeroRes = await adminPool.query(
      `INSERT INTO apartment (building_id, code, status, area_m2)
       VALUES ($1, $2, 'OCCUPIED', 30)
       RETURNING id`,
      [vopAId, `T5-ZERO-${suffix}`]
    );
    cleanups.apartments.push(aptZeroRes.rows[0].id);

    const cZeroRes = await adminPool.query(
      `INSERT INTO contract (
         building_id, apartment_id, primary_tenant_id,
         start_date, end_date, rent_amount, deposit_amount, status, billing_day
       ) VALUES ($1, $2, $3, '2026-01-01', '2030-12-31', 0, 0, 'ACTIVE', 1)
       RETURNING id`,
      [vopAId, aptZeroRes.rows[0].id, tenantId]
    );
    cleanups.contracts.push(cZeroRes.rows[0].id);

    const batchRes = await apiFetch('/api/v1/invoices/generate-batch', mgrVopA.token, {
      method: 'POST',
      headers: { 'Idempotency-Key': `idem-batch-zero-${suffix}` },
      body: JSON.stringify({
        building_id: vopAId,
        period: '2029-11',
      }),
    });
    assert.equal(batchRes.status, 201, `Generate batch failed: ${JSON.stringify(batchRes.body)}`);
    assert.ok(Array.isArray(batchRes.body.skipped_contracts), 'skipped_contracts must be an array (AC-015.1)');
    const skippedZero = batchRes.body.skipped_contracts.find((s) => s.contract_id === cZeroRes.rows[0].id);
    assert.ok(skippedZero, 'Contract with 0 charges must be listed in skipped_contracts');

    // 1i. Existing DRAFT in-place refresh when { contract_id, period } is passed
    // Check draftId from earlier in period 2026-11 for contractId
    const refreshBatchRes = await apiFetch('/api/v1/invoices/generate-batch', mgrVopA.token, {
      method: 'POST',
      headers: { 'Idempotency-Key': `idem-refresh-batch-${suffix}` },
      body: JSON.stringify({
        building_id: vopAId,
        contract_id: contractId,
        period: '2026-11',
      }),
    });
    assert.equal(refreshBatchRes.status, 201, `Refresh batch failed: ${JSON.stringify(refreshBatchRes.body)}`);
    assert.ok(
      Number(refreshBatchRes.body.updated_draft_count || 0) >= 1,
      'Must increment updated_draft_count when refreshing existing DRAFT'
    );
  });

  // =========================================================================
  // Subtest 2: Four-Eyes RBAC & FR-064 LATE_FEE waiver matrix
  // =========================================================================
  await t.test('2. Four-eyes RBAC & FR-064 LATE_FEE waiver matrix (403 SELF_APPROVAL, SYS_ADMIN 403 on VOP-A, OWNER & mgr2VopA 200)', async () => {
    // Clean up any stray pending adjustments on VOP-A from aborted prior runs
    await adminPool.query(
      `DELETE FROM invoice_adjustment WHERE building_id = $1 AND status = 'PENDING_APPROVAL' AND reason LIKE '%05/11%'`,
      [vopAId]
    );

    // Pick an existing ISSUED/OVERDUE invoice in VOP-A
    const invRes = await adminPool.query(
      `SELECT id, building_id, invoice_code, total_amount FROM invoice
       WHERE building_id = $1 AND status IN ('ISSUED', 'OVERDUE')
         AND NOT EXISTS (
           SELECT 1 FROM invoice_adjustment ia
           WHERE ia.invoice_id = invoice.id AND ia.status = 'PENDING_APPROVAL'
         )
       LIMIT 1`,
      [vopAId]
    );
    assert.ok(invRes.rows.length > 0, 'Need an issued/overdue invoice for 4-eyes test');
    const targetInv = invRes.rows[0];

    // 2a. mgrVopA creates a LATE_FEE waiver adjustment request via POST /api/v1/invoices/:id/adjust
    const adjCreateRes = await apiFetch(`/api/v1/invoices/${targetInv.id}/adjust`, mgrVopA.token, {
      method: 'POST',
      headers: { 'Idempotency-Key': `idem-create-adj-${suffix}` },
      body: JSON.stringify({
        adjustment_target: 'LATE_FEE',
        action_type: 'WAIVE',
        delta_amount: -50000,
        reason: 'Miễn giảm phí trễ hạn do lỗi chuyển khoản ngân hàng ngày 05/11',
      }),
    });
    assert.equal(adjCreateRes.status, 201, `Create adjustment failed: ${JSON.stringify(adjCreateRes.body)}`);
    const adjId = adjCreateRes.body.data?.id;
    assert.ok(adjId, 'Adjustment ID must be returned');
    cleanups.adjustments.push(adjId);

    // 2b. GET /api/v1/invoices/adjustments: lists pending adjustments
    const adjListRes = await apiFetch(`/api/v1/invoices/adjustments?building_id=${vopAId}&status=PENDING_APPROVAL`, mgrVopA.token);
    assert.equal(adjListRes.status, 200);
    assert.ok(Array.isArray(adjListRes.body.data));
    const foundAdj = adjListRes.body.data.find((a) => a.id === adjId);
    assert.ok(foundAdj, 'Created adjustment must appear in adjustments list');

    // 2c. mgrVopA attempts SELF-APPROVAL -> must receive 403 SELF_APPROVAL
    const selfApproveRes = await apiFetch(`/api/v1/invoices/${targetInv.id}/adjustments/${adjId}/approve`, mgrVopA.token, {
      method: 'POST',
      headers: { 'Idempotency-Key': `idem-self-approve-${suffix}` },
    });
    assert.equal(selfApproveRes.status, 403, 'Self-approval must be forbidden (403)');
    assert.equal(selfApproveRes.body.code, 'SELF_APPROVAL');

    // 2d. SYS_ADMIN attempts to approve on VOP-A -> must receive 403 (because VOP-A has an active owner!)
    const sysAdminApproveRes = await apiFetch(`/api/v1/invoices/${targetInv.id}/adjustments/${adjId}/approve`, sysAdmin.token, {
      method: 'POST',
      headers: { 'Idempotency-Key': `idem-sys-approve-${suffix}` },
    });
    assert.equal(sysAdminApproveRes.status, 403, 'SYS_ADMIN must not approve when building has active owner');

    // 2e. OWNER of VOP-A approves -> must succeed 200
    const ownerApproveRes = await apiFetch(`/api/v1/invoices/${targetInv.id}/adjustments/${adjId}/approve`, ownerVop.token, {
      method: 'POST',
      headers: { 'Idempotency-Key': `idem-owner-approve-${suffix}` },
    });
    assert.equal(ownerApproveRes.status, 200, `Owner approval failed: ${JSON.stringify(ownerApproveRes.body)}`);
    assert.equal(ownerApproveRes.body.data?.status || ownerApproveRes.body.status, 'APPROVED');

    // 2f. Create second adjustment and let second manager (mgr2VopA) approve
    const adj2CreateRes = await apiFetch(`/api/v1/invoices/${targetInv.id}/adjust`, mgrVopA.token, {
      method: 'POST',
      headers: { 'Idempotency-Key': `idem-create-adj2-${suffix}` },
      body: JSON.stringify({
        adjustment_target: 'AMOUNT',
        action_type: 'DECREASE',
        delta_amount: -20000,
        reason: 'Điều chỉnh nhỏ số tiền dịch vụ',
      }),
    });
    assert.equal(adj2CreateRes.status, 201);
    const adj2Id = adj2CreateRes.body.data?.id;
    cleanups.adjustments.push(adj2Id);

    const mgr2ApproveRes = await apiFetch(`/api/v1/invoices/${targetInv.id}/adjustments/${adj2Id}/approve`, mgr2VopA.token, {
      method: 'POST',
      headers: { 'Idempotency-Key': `idem-mgr2-approve-${suffix}` },
    });
    assert.equal(mgr2ApproveRes.status, 200, `Cross manager approval failed: ${JSON.stringify(mgr2ApproveRes.body)}`);

    // 2g. GET /api/v1/invoices/:id/audit-logs: tab Lịch sử / Kiểm toán PRD 8.2
    const auditLogsRes = await apiFetch(`/api/v1/invoices/${targetInv.id}/audit-logs`, mgrVopA.token);
    assert.equal(auditLogsRes.status, 200);
    assert.ok(Array.isArray(auditLogsRes.body.data));
  });

  // =========================================================================
  // Subtest 3: Order A vs Order B commutativity, standalone receivable overpayment,
  //            payment rejection audit log, and aging_summary_prd (AC-016.1)
  // =========================================================================
  await t.test('3. Order A/B commutativity, standalone receivable overpayment, REJECT_PAYMENT audit log, and aging_summary_prd (AC-016.1)', async () => {
    // 3a. Standalone receivable overpayment minting credit_balance ('OVERPAYMENT')
    const contractRes = await adminPool.query(
      `SELECT c.id, c.building_id, c.primary_tenant_id FROM contract c
       WHERE c.building_id = $1 AND c.status = 'ACTIVE' LIMIT 1`,
      [vopAId]
    );
    const c = contractRes.rows[0];

    const recRes = await adminPool.query(
      `INSERT INTO receivable (
         org_id, building_id, contract_id, tenant_id, invoice_id,
         type, amount, paid_amount, due_date, status, description
       ) VALUES (
         $1, $2, $3, $4, NULL,
         'RECEIVABLE_AFTER_MOVE_OUT', 400000, 0, CURRENT_DATE + 3, 'OPEN', 'Khoản bù phát sinh sau chuyển phòng'
       ) RETURNING id`,
      [orgId, vopAId, c.id, c.primary_tenant_id]
    );
    const recId = recRes.rows[0].id;
    cleanups.receivables.push(recId);

    // Pay 500,000 on the 400,000 receivable -> overpayment = 100,000
    const payRes = await apiFetch('/api/v1/payments', mgrVopA.token, {
      method: 'POST',
      headers: { 'Idempotency-Key': `idem-rec-pay-${suffix}` },
      body: JSON.stringify({
        receivable_id: recId,
        amount: 500000,
        method: 'BANK_TRANSFER',
        reference_code: `REF-REC-${suffix}`,
      }),
    });
    assert.equal(payRes.status, 201, `Pay standalone receivable failed: ${JSON.stringify(payRes.body)}`);
    const paymentId = payRes.body.data?.id;
    cleanups.payments.push(paymentId);
    assert.equal(Number(payRes.body.data?.overpayment_amount), 100000);

    // Check minted credit_balance row
    const cbCheck = await adminPool.query(
      `SELECT * FROM credit_balance WHERE source_payment_id = $1`,
      [paymentId]
    );
    assert.equal(cbCheck.rows.length, 1, 'Must mint credit_balance row on standalone receivable overpayment');
    assert.equal(cbCheck.rows[0].reason_type, 'OVERPAYMENT');
    assert.equal(Number(cbCheck.rows[0].amount), 100000);
    assert.equal(cbCheck[0]?.status || cbCheck.rows[0].status, 'AVAILABLE');
    cleanups.credits.push(cbCheck.rows[0].id);

    // 3b. Order B confirmation overpayment commutativity:
    // Create an invoice with total_amount = 500,000, paid_amount = 0
    const orderBPeriod = `2038-${String(1 + (Number(suffix.slice(-2)) % 12)).padStart(2, '0')}`;
    const oldInvRes = await adminPool.query('SELECT id FROM invoice WHERE contract_id = $1 AND period = $2', [c.id, orderBPeriod]);
    if (oldInvRes.rows.length > 0) {
      const oldInvId = oldInvRes.rows[0].id;
      await adminPool.query('DELETE FROM credit_balance WHERE source_payment_id IN (SELECT id FROM payment WHERE invoice_id = $1)', [oldInvId]);
      await adminPool.query('DELETE FROM payment WHERE invoice_id = $1', [oldInvId]);
      await adminPool.query('DELETE FROM invoice_line WHERE invoice_id = $1', [oldInvId]);
      await adminPool.query('DELETE FROM invoice WHERE id = $1', [oldInvId]);
    }
    const invOrderBRes = await adminPool.query(
      `INSERT INTO invoice (
         org_id, building_id, apartment_id, contract_id, tenant_id,
         invoice_code, period, due_date, subtotal_amount, adjustment_amount,
         total_amount, paid_amount, status
       ) VALUES (
         $1, $2, (SELECT apartment_id FROM contract WHERE id = $3), $3, $4,
         $5, $6, CURRENT_DATE + 5, 500000, 0, 500000, 0, 'ISSUED'
       ) RETURNING id`,
      [orgId, vopAId, c.id, c.primary_tenant_id, `INV-ORDERB-${suffix}`, orderBPeriod]
    );
    const invOrderBId = invOrderBRes.rows[0].id;
    cleanups.invoices.push(invOrderBId);

    // Create a pending payment of 600,000 targeting invOrderBId (excess 100,000)
    const pendingOrderBPay = await adminPool.query(
      `INSERT INTO payment (
         org_id, building_id, contract_id, tenant_id, invoice_id, payment_code,
         amount, method, status
       ) VALUES (
         $1, $2, $3, $4, $5, $6,
         600000, 'BANK_TRANSFER', 'PENDING_CONFIRMATION'
       ) RETURNING id`,
      [orgId, vopAId, c.id, c.primary_tenant_id, invOrderBId, `PAY-ORDERB-${suffix}`]
    );
    const orderBPayId = pendingOrderBPay.rows[0].id;
    cleanups.payments.push(orderBPayId);

    // Manager confirms payment via PATCH /api/v1/payments/:id/confirm
    const confirmRes = await apiFetch(`/api/v1/payments/${orderBPayId}/confirm`, mgrVopA.token, {
      method: 'PATCH',
      headers: { 'Idempotency-Key': `idem-confirm-orderb-${suffix}` },
    });
    assert.equal(confirmRes.status, 200, `Confirm payment failed: ${JSON.stringify(confirmRes.body)}`);

    // Verify invoice paid_amount capped at total_amount (500,000)
    const invOrderBAfter = await adminPool.query('SELECT paid_amount, total_amount, status FROM invoice WHERE id = $1', [invOrderBId]);
    assert.equal(Number(invOrderBAfter.rows[0].paid_amount), 500000);
    assert.equal(invOrderBAfter.rows[0].status, 'PAID');

    // Verify overpayment 100,000 minted in credit_balance linked to source_payment_id
    const cbOrderB = await adminPool.query(
      'SELECT * FROM credit_balance WHERE source_payment_id = $1',
      [orderBPayId]
    );
    assert.equal(cbOrderB.rows.length, 1, 'Order B confirm must mint credit_balance for excess');
    assert.equal(cbOrderB.rows[0].reason_type, 'OVERPAYMENT');
    assert.equal(Number(cbOrderB.rows[0].amount), 100000);
    assert.equal(cbOrderB.rows[0].status, 'AVAILABLE');
    cleanups.credits.push(cbOrderB.rows[0].id);

    // Idempotent re-confirm must not duplicate credit_balance
    await apiFetch(`/api/v1/payments/${orderBPayId}/confirm`, mgrVopA.token, {
      method: 'PATCH',
      headers: { 'Idempotency-Key': `idem-confirm-orderb-2-${suffix}` },
    });
    const cbOrderB2 = await adminPool.query(
      'SELECT COUNT(*)::int AS cnt FROM credit_balance WHERE source_payment_id = $1',
      [orderBPayId]
    );
    assert.equal(cbOrderB2.rows[0].cnt, 1, 'Idempotent confirm must not duplicate credit balance');

    // 3c. PATCH /api/v1/payments/:id/reject writes REJECT_PAYMENT audit_log
    const pendingPayRes = await adminPool.query(
      `INSERT INTO payment (
         org_id, building_id, contract_id, tenant_id, payment_code,
         amount, method, status
       ) VALUES (
         $1, $2, $3, $4, $5,
         250000, 'BANK_TRANSFER', 'PENDING_CONFIRMATION'
       ) RETURNING id`,
      [orgId, vopAId, c.id, c.primary_tenant_id, `PAY-REJ-${suffix}`]
    );
    const pendingPayId = pendingPayRes.rows[0].id;
    cleanups.payments.push(pendingPayId);

    const rejRes = await apiFetch(`/api/v1/payments/${pendingPayId}/reject`, mgrVopA.token, {
      method: 'PATCH',
      headers: { 'Idempotency-Key': `idem-pay-rej-${suffix}` },
      body: JSON.stringify({ reason: 'Ủy nhiệm chi bị mờ không đọc được mã giao dịch' }),
    });
    assert.equal(rejRes.status, 200, `Reject payment failed: ${JSON.stringify(rejRes.body)}`);
    assert.equal(rejRes.body.data?.status, 'REJECTED');

    const rejAuditCheck = await adminPool.query(
      `SELECT * FROM audit_log WHERE entity = 'payment' AND entity_id = $1 AND action = 'REJECT_PAYMENT'`,
      [pendingPayId]
    );
    assert.equal(rejAuditCheck.rows.length, 1, 'REJECT_PAYMENT audit_log row must be created');

    // 3c. GET /api/v1/receivables returns aging_summary_prd (AC-016.1)
    const recListRes = await apiFetch('/api/v1/receivables', mgrVopA.token);
    assert.equal(recListRes.status, 200);
    assert.ok(recListRes.body.aging_summary, 'Must return legacy aging_summary');
    assert.ok(recListRes.body.aging_summary_prd, 'Must return aging_summary_prd (AC-016.1)');
    const prd = recListRes.body.aging_summary_prd;
    assert.ok(prd.current_not_due !== undefined);
    assert.ok(prd.bucket_0_15 !== undefined);
    assert.ok(prd.bucket_16_30 !== undefined);
    assert.ok(prd.bucket_31_60 !== undefined);
    assert.ok(prd.bucket_over_60 !== undefined);
    assert.ok(prd.total_overdue_balance !== undefined);
    assert.ok(prd.total_balance !== undefined);
  });

  // =========================================================================
  // Subtest 4: 4-eyes credit_balance refund with proof_image, DISPUTED guard,
  //            and tenant merge sync (FR-021)
  // =========================================================================
  await t.test('4. 4-eyes credit refund with proof_image attachment RLS, DISPUTED guard, split/reject, and tenant merge (FR-021)', async () => {
    // 4a. Setup available credit balance for refund
    const contractRes = await adminPool.query(
      `SELECT c.id, c.building_id, c.primary_tenant_id FROM contract c
       JOIN tenant t ON t.id = c.primary_tenant_id
       JOIN person p ON p.id = t.person_id
       WHERE c.building_id = $1 AND c.status = 'ACTIVE' AND p.email = 'tenant1@resihub.vn' LIMIT 1`,
      [vopAId]
    );
    const c = contractRes.rows[0];

    const creditRes = await adminPool.query(
      `INSERT INTO credit_balance (
         org_id, building_id, contract_id, tenant_id, reason_type,
         amount, applied_amount, status, description
       ) VALUES (
         $1, $2, $3, $4, 'OVERPAYMENT',
         1500000, 0, 'AVAILABLE', 'Số dư thừa cần hoàn trả cho cư dân'
       ) RETURNING id`,
      [orgId, vopAId, c.id, c.primary_tenant_id]
    );
    const creditId = creditRes.rows[0].id;
    cleanups.credits.push(creditId);

    // 4b. Request refund with base64 proof_image: POST /api/v1/payments/credits/:id/refund
    const refundReqRes = await apiFetch(`/api/v1/payments/credits/${creditId}/refund`, mgrVopA.token, {
      method: 'POST',
      headers: { 'Idempotency-Key': `idem-cred-ref-${suffix}` },
      body: JSON.stringify({
        refund_amount: 500000,
        bank_name: 'Vietcombank',
        bank_account_number: '1234567890',
        bank_account_holder: 'NGUYEN VAN A',
        reason: 'Cư dân đề nghị hoàn tiền thừa về tài khoản cá nhân',
        proof_image: TINY_PNG_B64,
      }),
    });
    assert.equal(refundReqRes.status, 201, `Refund request failed: ${JSON.stringify(refundReqRes.body)}`);
    const childCreditId = refundReqRes.body.data?.id;
    assert.ok(childCreditId, 'Refund child credit row ID must be returned');
    cleanups.credits.push(childCreditId);

    const childRow = await adminPool.query('SELECT * FROM credit_balance WHERE id = $1', [childCreditId]);
    assert.equal(childRow.rows[0].status, 'PENDING_DIRECT_REFUND');
    const proofUrl = childRow.rows[0].refund_meta?.proof_image;
    assert.ok(proofUrl, 'proof_image URL must be saved in refund_meta');
    assert.match(proofUrl, /^\/api\/v1\/attachments\/[a-f0-9-]+\/view/);

    // Extract attachment ID
    const attIdMatch = proofUrl.match(/\/attachments\/([a-f0-9-]+)\/view/);
    const attId = attIdMatch[1];

    // 4c. Attachment RLS check for credit_balance:
    // OWNER should be allowed (200)
    const ownerAttRes = await apiFetch(`/api/v1/attachments/${attId}/view`, ownerVop.token);
    assert.equal(ownerAttRes.status, 200, 'OWNER must be able to view credit_balance attachment');

    // MANAGER assigned to VOP-A should be allowed (200)
    const mgrAttRes = await apiFetch(`/api/v1/attachments/${attId}/view`, mgrVopA.token);
    assert.equal(mgrAttRes.status, 200, 'Assigned MANAGER must be able to view credit_balance attachment');

    // RESIDENT on the contract should be allowed (200)
    const resAttRes = await apiFetch(`/api/v1/attachments/${attId}/view`, resident1.token);
    assert.equal(resAttRes.status, 200, 'RESIDENT on contract must be able to view credit_balance attachment');

    // Unassigned MANAGER (manager.vop.b@resihub.vn) must be blocked (403)
    const mgrVopB = await loginEmail('manager.vop.b@resihub.vn', 'Demo@123456');
    const unassignedAttRes = await apiFetch(`/api/v1/attachments/${attId}/view`, mgrVopB.token);
    assert.equal(unassignedAttRes.status, 403, 'Unassigned MANAGER must be blocked from viewing attachment');

    // 4d. Split / Reject merge-back via POST /api/v1/payments/credits/:id/refund/reject
    const rejectRefundRes = await apiFetch(`/api/v1/payments/credits/${childCreditId}/refund/reject`, ownerVop.token, {
      method: 'POST',
      headers: { 'Idempotency-Key': `idem-ref-rej-${suffix}` },
      body: JSON.stringify({ reason: 'Thông tin số tài khoản chưa khớp với tên người thụ hưởng' }),
    });
    assert.equal(rejectRefundRes.status, 200, `Reject refund failed: ${JSON.stringify(rejectRefundRes.body)}`);

    // Verify child status becomes VOID and parent applied_amount is restored
    const childAfterRej = await adminPool.query('SELECT status FROM credit_balance WHERE id = $1', [childCreditId]);
    assert.equal(childAfterRej.rows[0].status, 'VOID');
    const parentAfterRej = await adminPool.query('SELECT applied_amount, status FROM credit_balance WHERE id = $1', [creditId]);
    assert.equal(Number(parentAfterRej.rows[0].applied_amount), 0);
    assert.equal(parentAfterRej.rows[0].status, 'AVAILABLE');

    // 4e. DISPUTED uncommitted deposit guard
    // Create a deposit with status DISPUTED and no accounting_committed_at
    const depDisputeRes = await adminPool.query(
      `INSERT INTO deposit (
         contract_id, amount_held, status, settlement
       ) VALUES (
         $1, 10000000, 'DISPUTED', '{"dispute_status": "OPEN"}'::jsonb
       ) RETURNING id`,
      [c.id]
    );
    const depDisputeId = depDisputeRes.rows[0].id;

    const blockedRefundRes = await apiFetch(`/api/v1/payments/credits/${creditId}/refund`, mgrVopA.token, {
      method: 'POST',
      headers: { 'Idempotency-Key': `idem-dispute-block-${suffix}` },
      body: JSON.stringify({
        refund_amount: 200000,
        bank_name: 'Techcombank',
        bank_account_number: '987654321',
        bank_account_holder: 'NGUYEN VAN A',
        reason: 'Thử hoàn tiền khi đang có khiếu nại cọc',
      }),
    });
    assert.equal(blockedRefundRes.status, 409, 'Must block credit refund when contract has disputed uncommitted deposit');
    assert.equal(blockedRefundRes.body.code, 'SETTLEMENT_IN_PROGRESS');

    // Clean up disputed deposit
    await adminPool.query('DELETE FROM deposit WHERE id = $1', [depDisputeId]);

    // 4f. Tenant merge migrating credit_balance.tenant_id (FR-021)
    // Create two tenants under the same org
    const pSrc = await adminPool.query(
      `INSERT INTO person (org_id, full_name, email, phone)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [orgId, `Source Person ${suffix}`, `src.${suffix}@resihub.vn`, `092${suffix.slice(0, 7)}`]
    );
    const tSrc = await adminPool.query(
      `INSERT INTO tenant (org_id, person_id, type, status, desired_building_id) VALUES ($1, $2, 'primary', 'APPROVED', $3) RETURNING id`,
      [orgId, pSrc.rows[0].id, vopAId]
    );
    const pTgt = await adminPool.query(
      `INSERT INTO person (org_id, full_name, email, phone)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [orgId, `Target Person ${suffix}`, `tgt.${suffix}@resihub.vn`, `093${suffix.slice(0, 7)}`]
    );
    const tTgt = await adminPool.query(
      `INSERT INTO tenant (org_id, person_id, type, status, desired_building_id) VALUES ($1, $2, 'primary', 'APPROVED', $3) RETURNING id`,
      [orgId, pTgt.rows[0].id, vopAId]
    );

    const cbMergeSeed = await adminPool.query(
      `INSERT INTO credit_balance (
         org_id, building_id, contract_id, tenant_id, reason_type, amount, applied_amount, status, description
       ) VALUES (
         $1, $2, $3, $4, 'OVERPAYMENT', 300000, 0, 'AVAILABLE', 'Merge migration test'
       ) RETURNING id`,
      [orgId, vopAId, c.id, tSrc.rows[0].id]
    );
    const cbMergeId = cbMergeSeed.rows[0].id;
    cleanups.credits.push(cbMergeId);

    // Call POST /api/v1/tenants/merge (FR-021)
    const mergeRes = await apiFetch('/api/v1/tenants/merge', mgrVopA.token, {
      method: 'POST',
      headers: { 'Idempotency-Key': `idem-tenant-merge-${suffix}` },
      body: JSON.stringify({
        source_tenant_id: tSrc.rows[0].id,
        target_tenant_id: tTgt.rows[0].id,
        reason: 'Gộp hồ sơ trùng khách thuê',
      }),
    });
    assert.equal(mergeRes.status, 200, `Tenant merge failed: ${JSON.stringify(mergeRes.body)}`);

    const cbAfterMerge = await adminPool.query('SELECT tenant_id FROM credit_balance WHERE id = $1', [cbMergeId]);
    assert.equal(cbAfterMerge.rows[0].tenant_id, tTgt.rows[0].id, 'credit_balance.tenant_id must be updated to target_tenant_id');
  });

  // =========================================================================
  // Subtest 5: FIFO credit auto-offset, 0 ₫ issuance -> PAID with zero receivable,
  //            and DRAFT -> VOID restoring credit_balance
  // =========================================================================
  await t.test('5. FIFO credit offset, 0 ₫ invoice issuance -> PAID with zero receivable, and DRAFT -> VOID credit restoration', async () => {
    // 5a. Create apartment & contract for zero-issuance and FIFO test
    const aptRes = await adminPool.query(
      `INSERT INTO apartment (building_id, code, status, area_m2)
       VALUES ($1, $2, 'OCCUPIED', 35)
       RETURNING id, code`,
      [vopAId, `T5-FIFO-${suffix}`]
    );
    const aptId = aptRes.rows[0].id;
    cleanups.apartments.push(aptId);

    const tenantRes = await adminPool.query(
      `SELECT t.id FROM tenant t JOIN contract c ON c.primary_tenant_id = t.id WHERE c.building_id = $1 LIMIT 1`,
      [vopAId]
    );
    const tenantId = tenantRes.rows[0].id;

    const contractRes = await adminPool.query(
      `INSERT INTO contract (
         building_id, apartment_id, primary_tenant_id,
         start_date, end_date, rent_amount, deposit_amount, status, billing_day
       ) VALUES ($1, $2, $3, '2026-01-01', '2030-12-31', 2000000, 2000000, 'ACTIVE', 1)
       RETURNING id`,
      [vopAId, aptId, tenantId]
    );
    const contractId = contractRes.rows[0].id;
    cleanups.contracts.push(contractId);

    // Seed available credit balance: 2,000,000 ₫
    const crRes = await adminPool.query(
      `INSERT INTO credit_balance (
         org_id, building_id, contract_id, tenant_id, reason_type,
         amount, applied_amount, status, description
       ) VALUES (
         $1, $2, $3, $4, 'OVERPAYMENT',
         2000000, 0, 'AVAILABLE', 'Số dư tín dụng cho bù trừ kỳ mới'
       ) RETURNING id`,
      [orgId, vopAId, contractId, tenantId]
    );
    const crId = crRes.rows[0].id;
    cleanups.credits.push(crId);

    // Generate batch invoice for this contract: period 2029-08
    const genRes = await apiFetch('/api/v1/invoices/generate-batch', mgrVopA.token, {
      method: 'POST',
      headers: { 'Idempotency-Key': `idem-gen-fifo-${suffix}` },
      body: JSON.stringify({
        building_id: vopAId,
        contract_id: contractId,
        period: '2029-08',
      }),
    });
    assert.equal(genRes.status, 201, `Batch generation failed: ${JSON.stringify(genRes.body)}`);
    const invData = genRes.body.data?.[0];
    assert.ok(invData, 'Invoice data must be returned');
    cleanups.invoices.push(invData.id);

    // Verify FIFO applied: subtotal = 2000000, credit_offset = 2000000, total_amount = 0
    const invInDb = await adminPool.query(
      'SELECT subtotal_amount, credit_offset_amount, total_amount, status FROM invoice WHERE id = $1',
      [invData.id]
    );
    assert.equal(Number(invInDb.rows[0].subtotal_amount), 2000000);
    assert.equal(Number(invInDb.rows[0].credit_offset_amount), 2000000);
    assert.equal(Number(invInDb.rows[0].total_amount), 0);
    assert.equal(invInDb.rows[0].status, 'DRAFT');

    // 5b. Issue the 0 ₫ draft invoice via POST /api/v1/invoices/:id/issue
    const issueRes = await apiFetch(`/api/v1/invoices/${invData.id}/issue`, mgrVopA.token, {
      method: 'POST',
      headers: { 'Idempotency-Key': `idem-issue-zero-${suffix}` },
    });
    assert.equal(issueRes.status, 200, `Issue 0 VND invoice failed: ${JSON.stringify(issueRes.body)}`);
    assert.equal(issueRes.body.data?.status, 'PAID', '0 VND invoice must transition directly to PAID status');

    // Confirm ZERO receivable was created
    const recCheck = await adminPool.query('SELECT * FROM receivable WHERE invoice_id = $1', [invData.id]);
    assert.equal(recCheck.rows.length, 0, 'NO receivable row must be created for 0 VND invoice');

    // 5c. DRAFT -> VOID restoring credit_balance
    // Create another DRAFT with applied credit
    const cr2Res = await adminPool.query(
      `INSERT INTO credit_balance (
         org_id, building_id, contract_id, tenant_id, reason_type,
         amount, applied_amount, status, description
       ) VALUES (
         $1, $2, $3, $4, 'OVERPAYMENT',
         1000000, 1000000, 'APPLIED', 'Credit to be restored on VOID'
       ) RETURNING id`,
      [orgId, vopAId, contractId, tenantId]
    );
    const cr2Id = cr2Res.rows[0].id;
    cleanups.credits.push(cr2Id);

    const draft2Res = await adminPool.query(
      `INSERT INTO invoice (
         org_id, building_id, apartment_id, contract_id, tenant_id,
         invoice_code, period, due_date, subtotal_amount, adjustment_amount,
         total_amount, credit_offset_amount, paid_amount, status
       ) VALUES (
         $1, $2, $3, $4, $5,
         $6, '2029-09', CURRENT_DATE + 5, 2000000, 0, 1000000, 1000000, 0, 'DRAFT'
       ) RETURNING id, invoice_code`,
      [orgId, vopAId, aptId, contractId, tenantId, `INV-RESTORE-${suffix}`]
    );
    const draft2Id = draft2Res.rows[0].id;
    cleanups.invoices.push(draft2Id);

    await adminPool.query(
      `INSERT INTO invoice_line (invoice_id, item_type, description, quantity, unit, unit_price, amount, credit_id)
       VALUES ($1, 'ADJUSTMENT', 'Bù trừ số dư', 1, 'lần', -1000000, -1000000, $2)`,
      [draft2Id, cr2Id]
    );

    // Call PATCH /api/v1/invoices/:id/status to VOID
    const voidDraftRes = await apiFetch(`/api/v1/invoices/${draft2Id}/status`, mgrVopA.token, {
      method: 'PATCH',
      headers: { 'Idempotency-Key': `idem-void-restore-${suffix}` },
      body: JSON.stringify({ status: 'VOID' }),
    });
    assert.equal(voidDraftRes.status, 200, `Void draft failed: ${JSON.stringify(voidDraftRes.body)}`);

    // Verify credit_balance is restored to AVAILABLE with applied_amount = 0
    const cr2AfterVoid = await adminPool.query('SELECT status, applied_amount FROM credit_balance WHERE id = $1', [cr2Id]);
    assert.equal(cr2AfterVoid.rows[0].status, 'AVAILABLE', 'Credit status must be restored to AVAILABLE');
    assert.equal(Number(cr2AfterVoid.rows[0].applied_amount), 0, 'applied_amount must be restored to 0');
  });
});
