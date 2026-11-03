import { test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';

dotenv.config({ path: fileURLToPath(new URL('../.env', import.meta.url)) });
dotenv.config();

if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = 'postgres://postgres:postgres@127.0.0.1:5433/resihub';
}
if (!process.env.APP_DATABASE_URL) {
  process.env.APP_DATABASE_URL =
    'postgres://resihub_app:resihub_app_secret@127.0.0.1:5433/resihub';
}

import {
  applyAvailableCreditsInTx,
  releaseInvoiceCreditsInTx,
  recalculateDraftInvoiceTotalsInTx,
  syncSubscriptionTerminationInvoicesInTx,
  closeContractBillingAndSubscriptionsInTx,
  transferContractCreditsInTx,
  notifyBuildingInvoiceAdjustmentApprovers,
} from '../src/services/invoiceLifecycle.js';

const adminPool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  options: '-c timezone=Asia/Ho_Chi_Minh',
});

const appPool = new pg.Pool({
  connectionString: process.env.APP_DATABASE_URL,
  options: '-c timezone=Asia/Ho_Chi_Minh',
});

async function asManagerTx(mgrId, fn) {
  const client = await appPool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.current_user_id', $1, true)", [String(mgrId)]);
    const res = await fn(client);
    await client.query('COMMIT');
    return res;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function asAdminTx(fn) {
  const client = await adminPool.connect();
  try {
    await client.query('BEGIN');
    const res = await fn(client);
    await client.query('COMMIT');
    return res;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

test('Invoice Lifecycle, 3-Scenario Sync, 6A Contract Closure & Credit Balance Ledger', async (t) => {
  // Query baseline actors and entities
  const mgrRes = await adminPool.query(`
    SELECT au.id, ur.building_id, b.org_id, b.code AS building_code
    FROM app_user au
    JOIN user_role ur ON ur.user_id = au.id
    JOIN role r ON r.id = ur.role_id
    JOIN building b ON b.id = ur.building_id
    WHERE r.code = 'MANAGER' AND ur.building_id IS NOT NULL AND au.status = 'ACTIVE'
    LIMIT 1
  `);
  assert.ok(mgrRes.rows.length > 0, 'Must have active manager');
  const mgrId = mgrRes.rows[0].id;
  const buildingId = mgrRes.rows[0].building_id;
  const orgId = mgrRes.rows[0].org_id;

  const contractRes = await adminPool.query(`
    SELECT c.*, a.code AS apartment_code
    FROM contract c
    JOIN apartment a ON a.id = c.apartment_id
    WHERE c.building_id = $1 AND c.status = 'ACTIVE'
    LIMIT 1
  `, [buildingId]);
  assert.ok(contractRes.rows.length > 0, 'Must have active contract');
  const contract = contractRes.rows[0];

  const catRes = await adminPool.query(`
    SELECT * FROM service_catalog
    WHERE org_id = $1 AND (building_id IS NULL OR building_id = $2)
    LIMIT 1
  `, [orgId, buildingId]);
  assert.ok(catRes.rows.length > 0, 'Must have service catalog item');
  const serviceCatalogItem = catRes.rows[0];

  const cleanups = {
    invoices: [],
    adjustments: [],
    credits: [],
    subscriptions: [],
    contracts: [],
    auditLogs: [],
    notifications: [],
  };

  t.after(async () => {
    try {
      if (cleanups.notifications.length > 0) {
        await adminPool.query('DELETE FROM notification WHERE id = ANY($1)', [cleanups.notifications]).catch(() => {});
      }
      if (cleanups.auditLogs.length > 0) {
        await adminPool.query('DELETE FROM audit_log WHERE id = ANY($1)', [cleanups.auditLogs]).catch(() => {});
      }
      if (cleanups.adjustments.length > 0) {
        await adminPool.query('DELETE FROM invoice_adjustment WHERE id = ANY($1)', [cleanups.adjustments]).catch(() => {});
      }
      if (cleanups.credits.length > 0) {
        await adminPool.query('DELETE FROM credit_balance WHERE id = ANY($1)', [cleanups.credits]).catch(() => {});
      }
      if (cleanups.invoices.length > 0) {
        await adminPool.query('DELETE FROM invoice_line WHERE invoice_id = ANY($1)', [cleanups.invoices]).catch(() => {});
        await adminPool.query('DELETE FROM invoice WHERE id = ANY($1)', [cleanups.invoices]).catch(() => {});
      }
      if (cleanups.subscriptions.length > 0) {
        await adminPool.query('DELETE FROM service_subscription WHERE id = ANY($1)', [cleanups.subscriptions]).catch(() => {});
      }
      if (cleanups.contracts.length > 0) {
        await adminPool.query('DELETE FROM contract WHERE id = ANY($1)', [cleanups.contracts]).catch(() => {});
      }
    } finally {
      await adminPool.end();
      await appPool.end();
    }
  });

  // =========================================================================
  // SUBTEST 1: applyAvailableCreditsInTx & releaseInvoiceCreditsInTx
  // =========================================================================
  await t.test('1. applyAvailableCreditsInTx (FIFO) & releaseInvoiceCreditsInTx status bounds', async () => {
    // Seed 2 credits: 200,000 (earlier) and 500,000 (later)
    const cr1Res = await adminPool.query(`
      INSERT INTO credit_balance (
        org_id, building_id, contract_id, tenant_id, reason_type, amount, applied_amount, status, description, created_by
      ) VALUES ($1, $2, $3, $4, 'OVERPAYMENT', 200000, 0, 'AVAILABLE', 'Test credit 1', $5)
      RETURNING *
    `, [orgId, buildingId, contract.id, contract.primary_tenant_id, mgrId]);
    const cr1 = cr1Res.rows[0];
    cleanups.credits.push(cr1.id);

    // Ensure distinct created_at timestamp for FIFO order
    const cr2Res = await adminPool.query(`
      INSERT INTO credit_balance (
        org_id, building_id, contract_id, tenant_id, reason_type, amount, applied_amount, status, description, created_by, created_at
      ) VALUES ($1, $2, $3, $4, 'OVERPAYMENT', 500000, 0, 'AVAILABLE', 'Test credit 2', $5, NOW() + INTERVAL '1 second')
      RETURNING *
    `, [orgId, buildingId, contract.id, contract.primary_tenant_id, mgrId]);
    const cr2 = cr2Res.rows[0];
    cleanups.credits.push(cr2.id);

    // Also seed a credit with status = 'REFUNDED_DIRECT' to verify it is NOT mutated
    const crRefundedRes = await adminPool.query(`
      INSERT INTO credit_balance (
        org_id, building_id, contract_id, tenant_id, reason_type, amount, applied_amount, status, description, created_by
      ) VALUES ($1, $2, $3, $4, 'OVERPAYMENT', 300000, 300000, 'REFUNDED_DIRECT', 'Test refunded credit', $5)
      RETURNING *
    `, [orgId, buildingId, contract.id, contract.primary_tenant_id, mgrId]);
    const crRefunded = crRefundedRes.rows[0];
    cleanups.credits.push(crRefunded.id);

    // Create a DRAFT invoice with subtotal 350,000
    const invRes = await adminPool.query(`
      INSERT INTO invoice (
        org_id, building_id, apartment_id, contract_id, tenant_id,
        invoice_code, period, issue_date, due_date,
        subtotal_amount, adjustment_amount, total_amount, paid_amount, credit_offset_amount,
        status, created_by
      ) VALUES (
        $1, $2, $3, $4, $5,
        $6, '2029-12', CURRENT_DATE, CURRENT_DATE + INTERVAL '5 days',
        350000, 0, 350000, 0, 0,
        'DRAFT', $7
      ) RETURNING *
    `, [
      orgId, buildingId, contract.apartment_id, contract.id, contract.primary_tenant_id,
      `INV-TEST-CR-${Date.now().toString().slice(-6)}`, mgrId,
    ]);
    const inv = invRes.rows[0];
    cleanups.invoices.push(inv.id);

    // Apply credits via asManagerTx: subtotal 350,000 should use 200,000 from cr1 and 150,000 from cr2
    const applyResult = await asManagerTx(mgrId, async (client) => {
      return applyAvailableCreditsInTx(client, {
        contractId: contract.id,
        invoiceId: inv.id,
        subtotalAmount: 350000,
        actorId: mgrId,
      });
    });

    assert.equal(applyResult.totalCreditUsed, 350000);
    assert.equal(applyResult.appliedItems.length, 2);
    assert.equal(applyResult.appliedItems[0].creditId, cr1.id);
    assert.equal(applyResult.appliedItems[0].amount, 200000);
    assert.equal(applyResult.appliedItems[1].creditId, cr2.id);
    assert.equal(applyResult.appliedItems[1].amount, 150000);

    // Verify DB states of credits
    const cr1Check = await adminPool.query('SELECT * FROM credit_balance WHERE id = $1', [cr1.id]);
    assert.equal(Number(cr1Check.rows[0].applied_amount), 200000);
    assert.equal(cr1Check.rows[0].status, 'APPLIED');

    const cr2Check = await adminPool.query('SELECT * FROM credit_balance WHERE id = $1', [cr2.id]);
    assert.equal(Number(cr2Check.rows[0].applied_amount), 150000);
    assert.equal(cr2Check.rows[0].status, 'PARTIALLY_APPLIED');

    // Verify invoice totals updated
    const invCheck = await adminPool.query('SELECT * FROM invoice WHERE id = $1', [inv.id]);
    assert.equal(Number(invCheck.rows[0].credit_offset_amount), 350000);
    assert.equal(Number(invCheck.rows[0].total_amount), 0);

    // Partial release: release 100,000 (LIFO from cr2)
    const relResult1 = await asManagerTx(mgrId, async (client) => {
      return releaseInvoiceCreditsInTx(client, {
        invoiceId: inv.id,
        maxReleaseAmount: 100000,
        actorId: mgrId,
      });
    });
    assert.equal(relResult1.releasedAmount, 100000);
    assert.equal(relResult1.remainingCreditOffset, 250000);

    // cr2 should have dropped applied_amount from 150,000 to 50,000 (still PARTIALLY_APPLIED)
    const cr2Check2 = await adminPool.query('SELECT * FROM credit_balance WHERE id = $1', [cr2.id]);
    assert.equal(Number(cr2Check2.rows[0].applied_amount), 50000);
    assert.equal(cr2Check2.rows[0].status, 'PARTIALLY_APPLIED');

    // Release remainder (releaseInvoiceCreditsInTx with no maxReleaseAmount)
    const relResult2 = await asManagerTx(mgrId, async (client) => {
      return releaseInvoiceCreditsInTx(client, {
        invoiceId: inv.id,
        maxReleaseAmount: null,
        actorId: mgrId,
      });
    });
    assert.equal(relResult2.releasedAmount, 250000);
    assert.equal(relResult2.remainingCreditOffset, 0);

    // Both credits should now be AVAILABLE with applied_amount = 0
    const cr1Check3 = await adminPool.query('SELECT * FROM credit_balance WHERE id = $1', [cr1.id]);
    assert.equal(Number(cr1Check3.rows[0].applied_amount), 0);
    assert.equal(cr1Check3.rows[0].status, 'AVAILABLE');

    const cr2Check3 = await adminPool.query('SELECT * FROM credit_balance WHERE id = $1', [cr2.id]);
    assert.equal(Number(cr2Check3.rows[0].applied_amount), 0);
    assert.equal(cr2Check3.rows[0].status, 'AVAILABLE');

    // crRefunded must remain untouched
    const crRefundedCheck = await adminPool.query('SELECT * FROM credit_balance WHERE id = $1', [crRefunded.id]);
    assert.equal(crRefundedCheck.rows[0].status, 'REFUNDED_DIRECT');
    assert.equal(Number(crRefundedCheck.rows[0].applied_amount), 300000);
  });

  // =========================================================================
  // SUBTEST 2: Scenario 1 (UNBILLED) & Scenario 2 (DRAFT updated + audit_log + surplus credit release)
  // =========================================================================
  await t.test('2. Scenario 1 (UNBILLED) & Scenario 2 (DRAFT updated + audit_log + surplus credit release + past periods intact)', async () => {
    // Clean any invoices for 2029-01..2029-06
    await adminPool.query(`DELETE FROM invoice_line WHERE invoice_id IN (SELECT id FROM invoice WHERE contract_id = $1 AND period LIKE '2029-0%')`, [contract.id]);
    await adminPool.query(`DELETE FROM invoice WHERE contract_id = $1 AND period LIKE '2029-0%'`, [contract.id]);

    // Create an active service subscription starting 2029-01-01
    const subRes = await adminPool.query(`
      INSERT INTO service_subscription (
        org_id, building_id, apartment_id, contract_id, service_id, unit_price, quantity,
        start_date, end_date, status, is_price_locked
      ) VALUES ($1, $2, $3, $4, $5, 300000, 1, '2029-01-01', NULL, 'ACTIVE', false)
      RETURNING *
    `, [orgId, buildingId, contract.apartment_id, contract.id, serviceCatalogItem.id]);
    const sub = subRes.rows[0];
    cleanups.subscriptions.push(sub.id);

    // 2.1 Scenario 1 (UNBILLED): Terminate subscription when no invoice exists for 2029-03
    const unbilledSub = { ...sub, status: 'TERMINATED', end_date: '2029-03-10' };
    const syncUnbilled = await asManagerTx(mgrId, async (client) => {
      return syncSubscriptionTerminationInvoicesInTx(client, {
        subscription: unbilledSub,
        contract,
        actorId: mgrId,
        reason: 'Khách yêu cầu hủy dịch vụ',
      });
    });

    assert.equal(syncUnbilled.scenario, 'UNBILLED');
    assert.equal(syncUnbilled.updatedDraftInvoiceIds.length, 0);
    assert.equal(syncUnbilled.createdAdjustments.length, 0);

    // 2.2 Scenario 2 (DRAFT updated):
    // Seed Month 1..5 as PAID invoices to verify they remain UNTOUCHED!
    const pastInvoiceIds = [];
    for (let m = 1; m <= 5; m++) {
      const period = `2029-0${m}`;
      const invPastRes = await adminPool.query(`
        INSERT INTO invoice (
          org_id, building_id, apartment_id, contract_id, tenant_id,
          invoice_code, period, issue_date, due_date,
          subtotal_amount, adjustment_amount, total_amount, paid_amount, credit_offset_amount,
          status, created_by
        ) VALUES (
          $1, $2, $3, $4, $5,
          $6, $7, CURRENT_DATE, CURRENT_DATE + INTERVAL '5 days',
          300000, 0, 300000, 300000, 0,
          'PAID', $8
        ) RETURNING *
      `, [
        orgId, buildingId, contract.apartment_id, contract.id, contract.primary_tenant_id,
        `INV-PAID-${period}-${Date.now().toString().slice(-4)}`, period, mgrId,
      ]);
      pastInvoiceIds.push(invPastRes.rows[0].id);
      cleanups.invoices.push(invPastRes.rows[0].id);

      await adminPool.query(`
        INSERT INTO invoice_line (invoice_id, item_type, description, quantity, unit, unit_price, amount, subscription_id)
        VALUES ($1, 'SERVICE', 'Dịch vụ tháng ' || $2, 1, 'tháng', 300000, 300000, $3)
      `, [invPastRes.rows[0].id, m, sub.id]);
    }

    // Now seed Month 6 as DRAFT invoice with full 300,000 charge and 300,000 credit_offset
    const crMonth6Res = await adminPool.query(`
      INSERT INTO credit_balance (
        org_id, building_id, contract_id, tenant_id, reason_type, amount, applied_amount, status, description, created_by
      ) VALUES ($1, $2, $3, $4, 'OVERPAYMENT', 300000, 300000, 'APPLIED', 'Credit applied to M6 draft', $5)
      RETURNING *
    `, [orgId, buildingId, contract.id, contract.primary_tenant_id, mgrId]);
    const crMonth6 = crMonth6Res.rows[0];
    cleanups.credits.push(crMonth6.id);

    const draftM6Res = await adminPool.query(`
      INSERT INTO invoice (
        org_id, building_id, apartment_id, contract_id, tenant_id,
        invoice_code, period, issue_date, due_date,
        subtotal_amount, adjustment_amount, total_amount, paid_amount, credit_offset_amount,
        status, created_by
      ) VALUES (
        $1, $2, $3, $4, $5,
        $6, '2029-06', CURRENT_DATE, CURRENT_DATE + INTERVAL '5 days',
        300000, 0, 0, 0, 300000,
        'DRAFT', $7
      ) RETURNING *
    `, [
      orgId, buildingId, contract.apartment_id, contract.id, contract.primary_tenant_id,
      `INV-DRAFT-2029-06-${Date.now().toString().slice(-4)}`, mgrId,
    ]);
    const draftM6 = draftM6Res.rows[0];
    cleanups.invoices.push(draftM6.id);

    await adminPool.query(`
      INSERT INTO invoice_line (invoice_id, item_type, description, quantity, unit, unit_price, amount, subscription_id)
      VALUES ($1, 'SERVICE', 'Dịch vụ tiện ích (2029-06)', 1, 'tháng', 300000, 300000, $2)
      RETURNING *
    `, [draftM6.id, sub.id]);

    await adminPool.query(`
      INSERT INTO invoice_line (invoice_id, item_type, description, quantity, unit, unit_price, amount, credit_id)
      VALUES ($1, 'ADJUSTMENT', 'Bù trừ số dư tín dụng', 1, 'lần', -300000, -300000, $2)
    `, [draftM6.id, crMonth6.id]);

    // Mid-month termination in Month 6: ended 2029-06-10 (10/30 days = 100,000 VND)
    const terminatedSub = {
      ...sub,
      status: 'TERMINATED',
      end_date: '2029-06-10',
      is_price_locked: true,
    };

    const syncDraft = await asManagerTx(mgrId, async (client) => {
      return syncSubscriptionTerminationInvoicesInTx(client, {
        subscription: terminatedSub,
        contract,
        actorId: mgrId,
        reason: 'Hủy dịch vụ giữa tháng 6',
      });
    });

    assert.equal(syncDraft.scenario, 'DRAFT_UPDATED');
    assert.ok(syncDraft.updatedDraftInvoiceIds.includes(draftM6.id));

    // Verify DRAFT line updated to pro-rata 100,000 VND
    const updatedLineRes = await adminPool.query(
      'SELECT * FROM invoice_line WHERE invoice_id = $1 AND subscription_id = $2',
      [draftM6.id, sub.id]
    );
    assert.equal(updatedLineRes.rows.length, 1);
    assert.equal(Number(updatedLineRes.rows[0].amount), 100000);
    assert.ok(updatedLineRes.rows[0].formula_meta);
    assert.equal(updatedLineRes.rows[0].formula_meta.active_days, 10);

    // Verify surplus credit balance (300,000 - 100,000 = 200,000) was RELEASED back to credit_balance!
    const crMonth6Check = await adminPool.query('SELECT * FROM credit_balance WHERE id = $1', [crMonth6.id]);
    assert.equal(Number(crMonth6Check.rows[0].applied_amount), 100000);
    assert.equal(crMonth6Check.rows[0].status, 'PARTIALLY_APPLIED');

    // Verify invoice totals updated
    const draftM6Check = await adminPool.query('SELECT * FROM invoice WHERE id = $1', [draftM6.id]);
    assert.equal(Number(draftM6Check.rows[0].subtotal_amount), 100000);
    assert.equal(Number(draftM6Check.rows[0].credit_offset_amount), 100000);
    assert.equal(Number(draftM6Check.rows[0].total_amount), 0);

    // Verify UPDATE_DRAFT_INVOICE_LINES audit log was created
    const auditRes = await adminPool.query(`
      SELECT * FROM audit_log
      WHERE entity = 'invoice' AND entity_id = $1 AND action = 'UPDATE_DRAFT_INVOICE_LINES'
      ORDER BY id DESC LIMIT 1
    `, [draftM6.id]);
    assert.ok(auditRes.rows.length > 0, 'Must write UPDATE_DRAFT_INVOICE_LINES audit log');
    cleanups.auditLogs.push(auditRes.rows[0].id);

    // Verify Months 1..5 remain 100% UNTOUCHED
    for (const pastId of pastInvoiceIds) {
      const pastCheck = await adminPool.query('SELECT * FROM invoice WHERE id = $1', [pastId]);
      assert.equal(pastCheck.rows[0].status, 'PAID');
      assert.equal(Number(pastCheck.rows[0].total_amount), 300000);
      assert.equal(Number(pastCheck.rows[0].paid_amount), 300000);
    }
  });

  // =========================================================================
  // SUBTEST 3: Scenario 3 (Post-ISSUED immutable invoice_line + PENDING_APPROVAL invoice_adjustment + notification)
  // =========================================================================
  await t.test('3. Scenario 3 (Post-ISSUED immutable invoice_line + PENDING_APPROVAL invoice_adjustment + notification on both pools)', async () => {
    // Clean any invoice for 2029-07
    await adminPool.query(`DELETE FROM invoice_line WHERE invoice_id IN (SELECT id FROM invoice WHERE contract_id = $1 AND period = '2029-07')`, [contract.id]);
    await adminPool.query(`DELETE FROM invoice WHERE contract_id = $1 AND period = '2029-07'`, [contract.id]);

    // Create subscription
    const subRes = await adminPool.query(`
      INSERT INTO service_subscription (
        org_id, building_id, apartment_id, contract_id, service_id, unit_price, quantity,
        start_date, end_date, status, is_price_locked
      ) VALUES ($1, $2, $3, $4, $5, 600000, 1, '2029-07-01', NULL, 'ACTIVE', true)
      RETURNING *
    `, [orgId, buildingId, contract.apartment_id, contract.id, serviceCatalogItem.id]);
    const sub = subRes.rows[0];
    cleanups.subscriptions.push(sub.id);

    // Seed an ISSUED invoice for 2029-07 with 600,000 VND
    const issuedRes = await adminPool.query(`
      INSERT INTO invoice (
        org_id, building_id, apartment_id, contract_id, tenant_id,
        invoice_code, period, issue_date, due_date,
        subtotal_amount, adjustment_amount, total_amount, paid_amount, credit_offset_amount,
        status, created_by, issued_by, issued_at
      ) VALUES (
        $1, $2, $3, $4, $5,
        $6, '2029-07', CURRENT_DATE, CURRENT_DATE + INTERVAL '5 days',
        600000, 0, 600000, 0, 0,
        'ISSUED', $7, $7, NOW()
      ) RETURNING *
    `, [
      orgId, buildingId, contract.apartment_id, contract.id, contract.primary_tenant_id,
      `INV-ISSUED-2029-07-${Date.now().toString().slice(-4)}`, mgrId,
    ]);
    const issuedInv = issuedRes.rows[0];
    cleanups.invoices.push(issuedInv.id);

    const lineRes = await adminPool.query(`
      INSERT INTO invoice_line (invoice_id, item_type, description, quantity, unit, unit_price, amount, subscription_id)
      VALUES ($1, 'SERVICE', 'Dịch vụ cao cấp', 1, 'tháng', 600000, 600000, $2)
      RETURNING *
    `, [issuedInv.id, sub.id]);
    const lineId = lineRes.rows[0].id;

    // Terminate mid-month on 2029-07-15 (15/31 days = roundVND(600000 * 15 / 31) = 290000)
    // Delta = 290000 - 600000 = -310000
    const termSub = {
      ...sub,
      status: 'TERMINATED',
      end_date: '2029-07-15',
      is_price_locked: true,
    };

    // Run syncSubscriptionTerminationInvoicesInTx inside appPool as MANAGER
    const syncRes = await asManagerTx(mgrId, async (client) => {
      return syncSubscriptionTerminationInvoicesInTx(client, {
        subscription: termSub,
        contract,
        actorId: mgrId,
        reason: 'Hủy dịch vụ cao cấp giữa kỳ đã phát hành',
      });
    });

    assert.equal(syncRes.scenario, 'ADJUSTMENT_CREATED');
    assert.equal(syncRes.createdAdjustments.length, 1);
    const adj = syncRes.createdAdjustments[0];
    cleanups.adjustments.push(adj.id);

    assert.equal(adj.invoice_id, issuedInv.id);
    assert.equal(adj.subscription_id, sub.id);
    assert.equal(adj.adjustment_target, 'SERVICE');
    assert.equal(adj.action_type, 'ADJUST');
    assert.equal(adj.status, 'PENDING_APPROVAL');
    assert.equal(Number(adj.delta_amount), -310000);

    // CRITICAL: invoice_line on ISSUED invoice must be 100% IMMUTABLE!
    const lineCheck = await adminPool.query('SELECT * FROM invoice_line WHERE id = $1', [lineId]);
    assert.equal(Number(lineCheck.rows[0].amount), 600000);
    assert.equal(lineCheck.rows[0].description, 'Dịch vụ cao cấp');

    // Test notifyBuildingInvoiceAdjustmentApprovers succeeds on BOTH appPool (as MANAGER) and adminPool (internal session)
    await asManagerTx(mgrId, async (client) => {
      await notifyBuildingInvoiceAdjustmentApprovers(client, {
        orgId,
        buildingId,
        invoiceId: issuedInv.id,
        invoiceCode: issuedInv.invoice_code,
        adjustmentId: adj.id,
        actionType: 'ADJUST',
        deltaAmount: -310000,
        actorId: mgrId,
      });
    });

    await asAdminTx(async (client) => {
      await notifyBuildingInvoiceAdjustmentApprovers(client, {
        orgId,
        buildingId,
        invoiceId: issuedInv.id,
        invoiceCode: issuedInv.invoice_code,
        adjustmentId: adj.id,
        actionType: 'ADJUST',
        deltaAmount: -310000,
        actorId: null,
      });
    });

    // Check notifications recorded
    const notifRes = await adminPool.query(
      `SELECT id FROM notification WHERE payload->>'adjustment_id' = $1`,
      [adj.id]
    );
    assert.ok(notifRes.rows.length >= 2, 'Notifications should be recorded from both pools');
    for (const r of notifRes.rows) {
      cleanups.notifications.push(r.id);
    }
  });

  // =========================================================================
  // SUBTEST 4: Option 6A Contract Closure (Pre-move-in, Mid-month, Ad-hoc untouched, Idempotent)
  // =========================================================================
  await t.test('4. Option 6A closeContractBillingAndSubscriptionsInTx: pre-move-in, mid-month, ad-hoc preservation, idempotency', async () => {
    // 4.1 Pre-move-in cancellation (!movedIn):
    // Create future contract starting 2030-01-01
    const futureContractRes = await adminPool.query(`
      INSERT INTO contract (
        building_id, apartment_id, primary_tenant_id, billing_day,
        start_date, end_date, rent_amount, deposit_amount, status, created_by
      ) VALUES (
        $1, $2, $3, 1,
        '2030-01-01', '2030-12-31', 5000000, 5000000, 'ACTIVE', $4
      ) RETURNING *
    `, [
      buildingId, contract.apartment_id, contract.primary_tenant_id, mgrId,
    ]);
    const futureContract = futureContractRes.rows[0];
    cleanups.contracts.push(futureContract.id);

    // Create DRAFT invoice for 2030-01 (rent 5,000,000)
    const draftFutRes = await adminPool.query(`
      INSERT INTO invoice (
        org_id, building_id, apartment_id, contract_id, tenant_id,
        invoice_code, period, issue_date, due_date,
        subtotal_amount, adjustment_amount, total_amount, paid_amount, credit_offset_amount,
        status, created_by
      ) VALUES (
        $1, $2, $3, $4, $5,
        $6, '2030-01', CURRENT_DATE, CURRENT_DATE + INTERVAL '5 days',
        5000000, 0, 5000000, 0, 0,
        'DRAFT', $7
      ) RETURNING *
    `, [
      orgId, buildingId, futureContract.apartment_id, futureContract.id, futureContract.primary_tenant_id,
      `INV-FUT-DRAFT-${Date.now().toString().slice(-4)}`, mgrId,
    ]);
    const draftFut = draftFutRes.rows[0];
    cleanups.invoices.push(draftFut.id);

    await adminPool.query(`
      INSERT INTO invoice_line (invoice_id, item_type, description, quantity, unit, unit_price, amount)
      VALUES ($1, 'RENT', 'Tiền thuê phòng 2030-01', 1, 'tháng', 5000000, 5000000)
    `, [draftFut.id]);

    // Create unpaid ISSUED invoice for 2030-02
    const issuedFutRes = await adminPool.query(`
      INSERT INTO invoice (
        org_id, building_id, apartment_id, contract_id, tenant_id,
        invoice_code, period, issue_date, due_date,
        subtotal_amount, adjustment_amount, total_amount, paid_amount, credit_offset_amount,
        status, created_by, issued_by, issued_at
      ) VALUES (
        $1, $2, $3, $4, $5,
        $6, '2030-02', CURRENT_DATE, CURRENT_DATE + INTERVAL '5 days',
        5000000, 0, 5000000, 0, 0,
        'ISSUED', $7, $7, NOW()
      ) RETURNING *
    `, [
      orgId, buildingId, futureContract.apartment_id, futureContract.id, futureContract.primary_tenant_id,
      `INV-FUT-ISSUED-${Date.now().toString().slice(-4)}`, mgrId,
    ]);
    const issuedFut = issuedFutRes.rows[0];
    cleanups.invoices.push(issuedFut.id);

    await adminPool.query(`
      INSERT INTO invoice_line (invoice_id, item_type, description, quantity, unit, unit_price, amount)
      VALUES ($1, 'RENT', 'Tiền thuê phòng 2030-02', 1, 'tháng', 5000000, 5000000)
    `, [issuedFut.id]);

    // Execute closeContractBillingAndSubscriptionsInTx on futureContract terminated before move-in
    const preMoveInRes = await asManagerTx(mgrId, async (client) => {
      return closeContractBillingAndSubscriptionsInTx(client, {
        contract: futureContract,
        explicitEndYmd: '2029-12-15', // Ended before start_date (2030-01-01)
        actorId: mgrId,
        reason: 'Hủy hợp đồng trước ngày vào ở',
      });
    });

    assert.equal(preMoveInRes.movedIn, false);
    // DRAFT invoice should be auto-VOIDed
    assert.ok(preMoveInRes.voidedDraftInvoiceIds.includes(draftFut.id));
    const draftFutCheck = await adminPool.query('SELECT * FROM invoice WHERE id = $1', [draftFut.id]);
    assert.equal(draftFutCheck.rows[0].status, 'VOID');

    // Unpaid ISSUED invoice should have PENDING_APPROVAL VOID adjustment created
    const voidAdj = preMoveInRes.createdAdjustments.find((a) => a.invoice_id === issuedFut.id);
    assert.ok(voidAdj, 'Must create VOID adjustment on unpaid ISSUED invoice');
    cleanups.adjustments.push(voidAdj.id);
    assert.equal(voidAdj.action_type, 'VOID');
    assert.equal(voidAdj.status, 'PENDING_APPROVAL');

    // Mark cancelled in DB like contracts.js:3842
    await adminPool.query("UPDATE contract SET status = 'CANCELLED' WHERE id = $1", [futureContract.id]);

    // 4.2 Mid-month contract closure with ad-hoc line preservation & idempotency:
    // Contract active from 2035-01-01 to 2035-12-31, rent = 6,000,000 VND
    const midContractRes = await adminPool.query(`
      INSERT INTO contract (
        building_id, apartment_id, primary_tenant_id, billing_day,
        start_date, end_date, rent_amount, deposit_amount, status, created_by
      ) VALUES (
        $1, $2, $3, 1,
        '2035-01-01', '2035-12-31', 6000000, 6000000, 'ACTIVE', $4
      ) RETURNING *
    `, [
      buildingId, contract.apartment_id, contract.primary_tenant_id, mgrId,
    ]);
    const midContract = midContractRes.rows[0];
    cleanups.contracts.push(midContract.id);

    // Active subscription on midContract
    const midSubRes = await adminPool.query(`
      INSERT INTO service_subscription (
        org_id, building_id, apartment_id, contract_id, service_id, unit_price, quantity,
        start_date, end_date, status, is_price_locked
      ) VALUES ($1, $2, $3, $4, $5, 200000, 1, '2035-01-01', NULL, 'ACTIVE', true)
      RETURNING *
    `, [orgId, buildingId, midContract.apartment_id, midContract.id, serviceCatalogItem.id]);
    const midSub = midSubRes.rows[0];
    cleanups.subscriptions.push(midSub.id);

    // Seed Month 8 DRAFT invoice:
    // Has RENT (6,000,000), SERVICE (200,000), and an ad-hoc line with subscription_id IS NULL (e.g. ELECTRICITY 450,000)
    const midDraftRes = await adminPool.query(`
      INSERT INTO invoice (
        org_id, building_id, apartment_id, contract_id, tenant_id,
        invoice_code, period, issue_date, due_date,
        subtotal_amount, adjustment_amount, total_amount, paid_amount, credit_offset_amount,
        status, created_by
      ) VALUES (
        $1, $2, $3, $4, $5,
        $6, '2035-08', CURRENT_DATE, CURRENT_DATE + INTERVAL '5 days',
        6650000, 0, 6650000, 0, 0,
        'DRAFT', $7
      ) RETURNING *
    `, [
      orgId, buildingId, midContract.apartment_id, midContract.id, midContract.primary_tenant_id,
      `INV-MID-DRAFT-${Date.now().toString().slice(-4)}`, mgrId,
    ]);
    const midDraft = midDraftRes.rows[0];
    cleanups.invoices.push(midDraft.id);

    await adminPool.query(`
      INSERT INTO invoice_line (invoice_id, item_type, description, quantity, unit, unit_price, amount)
      VALUES ($1, 'RENT', 'Tiền thuê phòng 2035-08', 1, 'tháng', 6000000, 6000000)
    `, [midDraft.id]);

    await adminPool.query(`
      INSERT INTO invoice_line (invoice_id, item_type, description, quantity, unit, unit_price, amount, subscription_id)
      VALUES ($1, 'SERVICE', 'Dịch vụ mạng 2035-08', 1, 'tháng', 200000, 200000, $2)
    `, [midDraft.id, midSub.id]);

    const adhocLineRes = await adminPool.query(`
      INSERT INTO invoice_line (invoice_id, item_type, description, quantity, unit, unit_price, amount, subscription_id)
      VALUES ($1, 'ELECTRICITY', 'Tiền điện sinh hoạt kỳ 2035-08', 150, 'kWh', 3000, 450000, NULL)
      RETURNING *
    `, [midDraft.id]);
    const adhocLine = adhocLineRes.rows[0];

    // Seed Month 9 ISSUED invoice with RENT 6,000,000
    const midIssuedRes = await adminPool.query(`
      INSERT INTO invoice (
        org_id, building_id, apartment_id, contract_id, tenant_id,
        invoice_code, period, issue_date, due_date,
        subtotal_amount, adjustment_amount, total_amount, paid_amount, credit_offset_amount,
        status, created_by, issued_by, issued_at
      ) VALUES (
        $1, $2, $3, $4, $5,
        $6, '2035-09', CURRENT_DATE, CURRENT_DATE + INTERVAL '5 days',
        6000000, 0, 6000000, 0, 0,
        'ISSUED', $7, $7, NOW()
      ) RETURNING *
    `, [
      orgId, buildingId, midContract.apartment_id, midContract.id, midContract.primary_tenant_id,
      `INV-MID-ISSUED-${Date.now().toString().slice(-4)}`, mgrId,
    ]);
    const midIssued = midIssuedRes.rows[0];
    cleanups.invoices.push(midIssued.id);

    await adminPool.query(`
      INSERT INTO invoice_line (invoice_id, item_type, description, quantity, unit, unit_price, amount)
      VALUES ($1, 'RENT', 'Tiền thuê phòng 2035-09', 1, 'tháng', 6000000, 6000000)
    `, [midIssued.id]);

    // Close contract mid-month on 2035-08-15 (August has 31 days)
    // RENT for 15 days = roundVND(6000000 * 15 / 31) = 2903000
    // SERVICE for 15 days = roundVND(200000 * 15 / 31) = 97000
    // Ad-hoc line (450,000) must be preserved!
    // Total subtotal for M8 = 2903000 + 97000 + 450000 = 3450000
    // M9 ISSUED is past lastActiveDayYmd (2035-08-15) -> rent is 0 VND (delta = -6,000,000)
    const midClosure1 = await asManagerTx(mgrId, async (client) => {
      return closeContractBillingAndSubscriptionsInTx(client, {
        contract: midContract,
        explicitEndYmd: '2035-08-15',
        actorId: mgrId,
        reason: 'Khách trả phòng trước hạn',
      });
    });

    assert.equal(midClosure1.movedIn, true);
    assert.equal(midClosure1.lastActiveDayYmd, '2035-08-15');
    assert.ok(midClosure1.updatedDraftInvoiceIds.includes(midDraft.id));

    // Verify ad-hoc line is UNTOUCHED
    const adhocCheck = await adminPool.query('SELECT * FROM invoice_line WHERE id = $1', [adhocLine.id]);
    assert.equal(adhocCheck.rows.length, 1);
    assert.equal(Number(adhocCheck.rows[0].amount), 450000);

    // Verify M8 DRAFT lines and subtotal
    const m8LinesRes = await adminPool.query('SELECT * FROM invoice_line WHERE invoice_id = $1', [midDraft.id]);
    const m8Rent = m8LinesRes.rows.find((l) => l.item_type === 'RENT');
    const m8Sub = m8LinesRes.rows.find((l) => l.item_type === 'SERVICE');
    assert.equal(Number(m8Rent.amount), 2903000);
    assert.equal(Number(m8Sub.amount), 97000);

    const m8DraftCheck = await adminPool.query('SELECT * FROM invoice WHERE id = $1', [midDraft.id]);
    assert.equal(Number(m8DraftCheck.rows[0].subtotal_amount), 3450000);

    // Verify M9 adjustment created on ISSUED invoice
    const m9Adj = midClosure1.createdAdjustments.find((a) => a.invoice_id === midIssued.id);
    assert.ok(m9Adj, 'Must create RENT adjustment for M9');
    cleanups.adjustments.push(m9Adj.id);
    assert.equal(Number(m9Adj.delta_amount), -6000000);
    assert.equal(m9Adj.adjustment_target, 'RENT');

    // 4.3 Idempotent Second Call:
    // Calling closeContractBillingAndSubscriptionsInTx again should produce delta === 0 and 0 duplicate adjustments
    const midClosure2 = await asManagerTx(mgrId, async (client) => {
      return closeContractBillingAndSubscriptionsInTx(client, {
        contract: midContract,
        explicitEndYmd: '2035-08-15',
        actorId: mgrId,
        reason: 'Khách trả phòng trước hạn (lần 2)',
      });
    });

    assert.equal(midClosure2.createdAdjustments.length, 0, 'Second call must NOT produce duplicate adjustments');
  });

  // =========================================================================
  // SUBTEST 5: transferContractCreditsInTx (Retain amount & excess transfer)
  // =========================================================================
  await t.test('5. transferContractCreditsInTx retains retainAmount and transfers only excess', async () => {
    // Contract A (source)
    const ctrARes = await adminPool.query(`
      INSERT INTO contract (
        building_id, apartment_id, primary_tenant_id, billing_day,
        start_date, end_date, rent_amount, deposit_amount, status, created_by
      ) VALUES (
        $1, $2, $3, 1,
        '2031-01-01', '2031-12-31', 4000000, 4000000, 'ACTIVE', $4
      ) RETURNING *
    `, [
      buildingId, contract.apartment_id, contract.primary_tenant_id, mgrId,
    ]);
    const ctrA = ctrARes.rows[0];
    cleanups.contracts.push(ctrA.id);

    // Contract B (destination, e.g. room transfer)
    const ctrBRes = await adminPool.query(`
      INSERT INTO contract (
        building_id, apartment_id, primary_tenant_id, billing_day,
        start_date, end_date, rent_amount, deposit_amount, status, created_by
      ) VALUES (
        $1, $2, $3, 1,
        '2032-01-01', '2032-12-31', 4500000, 4500000, 'ACTIVE', $4
      ) RETURNING *
    `, [
      buildingId, contract.apartment_id, contract.primary_tenant_id, mgrId,
    ]);
    const ctrB = ctrBRes.rows[0];
    cleanups.contracts.push(ctrB.id);

    // Seed 2 credits on Contract A:
    // crA1 = 500,000, crA2 = 700,000 (total = 1,200,000 available)
    const crA1Res = await adminPool.query(`
      INSERT INTO credit_balance (
        org_id, building_id, contract_id, tenant_id, reason_type, amount, applied_amount, status, description, created_by
      ) VALUES ($1, $2, $3, $4, 'OVERPAYMENT', 500000, 0, 'AVAILABLE', 'Credit A1', $5)
      RETURNING *
    `, [orgId, buildingId, ctrA.id, ctrA.primary_tenant_id, mgrId]);
    cleanups.credits.push(crA1Res.rows[0].id);

    const crA2Res = await adminPool.query(`
      INSERT INTO credit_balance (
        org_id, building_id, contract_id, tenant_id, reason_type, amount, applied_amount, status, description, created_by, created_at
      ) VALUES ($1, $2, $3, $4, 'OVERPAYMENT', 700000, 0, 'AVAILABLE', 'Credit A2', $5, NOW() + INTERVAL '1 second')
      RETURNING *
    `, [orgId, buildingId, ctrA.id, ctrA.primary_tenant_id, mgrId]);
    cleanups.credits.push(crA2Res.rows[0].id);

    // Transfer with retainAmount = 400,000:
    // Total available = 1,200,000. Retained = 400,000. Transferred = 800,000.
    const xferResult = await asManagerTx(mgrId, async (client) => {
      return transferContractCreditsInTx(client, {
        fromContractId: ctrA.id,
        toContractId: ctrB.id,
        toBuildingId: buildingId,
        retainAmount: 400000,
        actorId: mgrId,
        reason: 'Chuyển phòng sang phòng mới',
      });
    });

    assert.equal(xferResult.transferredTotal, 800000);
    assert.equal(xferResult.retainedTotal, 400000);

    // Verify Contract B received 800,000 credit
    const crBRes = await adminPool.query(
      `SELECT * FROM credit_balance WHERE contract_id = $1 AND reason_type = 'TRANSFERRED_IN'`,
      [ctrB.id]
    );
    assert.ok(crBRes.rows.length > 0);
    const sumB = crBRes.rows.reduce((s, r) => s + Number(r.amount), 0);
    assert.equal(sumB, 800000);
    for (const r of crBRes.rows) cleanups.credits.push(r.id);

    // Verify Contract A remaining available balance is exact 400,000
    const crAResAfter = await adminPool.query(
      `SELECT * FROM credit_balance WHERE contract_id = $1 AND status IN ('AVAILABLE', 'PARTIALLY_APPLIED')`,
      [ctrA.id]
    );
    const sumAAvail = crAResAfter.rows.reduce((s, r) => s + (Number(r.amount) - Number(r.applied_amount)), 0);
    assert.equal(sumAAvail, 400000);
  });
});
