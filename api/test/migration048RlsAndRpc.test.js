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

const adminPool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  options: '-c timezone=Asia/Ho_Chi_Minh',
});

const appPool = new pg.Pool({
  connectionString: process.env.APP_DATABASE_URL,
  options: '-c timezone=Asia/Ho_Chi_Minh',
});

// Helper to run query as a specific user through appPool with RLS
async function asUserTx(userId, fn) {
  const client = await appPool.connect();
  try {
    await client.query('BEGIN');
    if (userId) {
      await client.query("SELECT set_config('app.current_user_id', $1, true)", [String(userId)]);
    }
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function asUser(userId, fn) {
  const client = await appPool.connect();
  try {
    if (userId) {
      await client.query("SELECT set_config('app.current_user_id', $1, false)", [String(userId)]);
    } else {
      await client.query("SELECT set_config('app.current_user_id', '', false)");
    }
    return await fn(client);
  } finally {
    client.release();
  }
}

test('Migration 048 Schema, FORCE RLS, 4-Eyes & 4-Pass Settlement RPCs Integration', async (t) => {
  // Lookup seeded baseline actors & entities
  const orgRes = await adminPool.query('SELECT id FROM organization LIMIT 1');
  assert.ok(orgRes.rows.length > 0, 'Org must exist');
  const orgId = orgRes.rows[0].id;

  const sysAdminRes = await adminPool.query(`
    SELECT au.id
    FROM app_user au
    JOIN user_role ur ON ur.user_id = au.id
    JOIN role r ON r.id = ur.role_id
    WHERE r.code = 'SYS_ADMIN' AND au.status = 'ACTIVE'
    LIMIT 1
  `);
  const sysAdminId = sysAdminRes.rows[0].id;

  const mgrRes = await adminPool.query(`
    SELECT au.id, ur.building_id
    FROM app_user au
    JOIN user_role ur ON ur.user_id = au.id
    JOIN role r ON r.id = ur.role_id
    WHERE r.code = 'MANAGER' AND ur.building_id IS NOT NULL AND au.status = 'ACTIVE'
    LIMIT 1
  `);
  const mgrId = mgrRes.rows[0].id;
  const buildingId = mgrRes.rows[0].building_id;

  const otherBldgRes = await adminPool.query(`
    SELECT id FROM building WHERE code = 'VSC-A' LIMIT 1
  `);
  const otherBuildingId = otherBldgRes.rows[0].id;

  const ownerRes = await adminPool.query(`
    SELECT au.id
    FROM building b
    JOIN owner o ON o.id = b.owner_id
    JOIN app_user au ON au.person_id = o.person_id
    JOIN user_role ur ON ur.user_id = au.id
    JOIN role r ON r.id = ur.role_id
    WHERE b.id = $1 AND r.code = 'OWNER' AND au.status = 'ACTIVE'
    LIMIT 1
  `, [buildingId]);
  assert.ok(ownerRes.rows.length > 0, 'Building must have active owner');
  const ownerId = ownerRes.rows[0].id;

  const residentRes = await adminPool.query(`
    SELECT au.id, c.id AS contract_id, c.apartment_id, c.primary_tenant_id
    FROM contract c
    JOIN tenant t ON t.id = c.primary_tenant_id
    JOIN person p ON p.id = t.person_id
    JOIN app_user au ON au.person_id = p.id
    WHERE c.building_id = $1 AND c.status = 'ACTIVE' AND au.status = 'ACTIVE'
    LIMIT 1
  `, [buildingId]);
  assert.ok(residentRes.rows.length > 0, 'Must have active resident on building');
  const residentId = residentRes.rows[0].id;
  const contractId = residentRes.rows[0].contract_id;
  const apartmentId = residentRes.rows[0].apartment_id;
  const tenantId = residentRes.rows[0].primary_tenant_id;

  // Cleanup any lingering invoices/credits from previous aborted runs
  await adminPool.query(`
    DELETE FROM invoice_adjustment WHERE reason LIKE '%test%' OR reason LIKE '%Test%' OR reason LIKE '%Second downward adj%' OR reason LIKE '%Upward correction%' OR reason LIKE '%Downward with excess credit offset%' OR reason LIKE '%Miễn 200k phạt%' OR reason LIKE '%Hủy tiền thuê gốc%';
    DELETE FROM credit_balance WHERE description LIKE '%test%' OR description LIKE '%Test%' OR description LIKE '%1M credit for 4-pass test%' OR description LIKE '%Backfill%';
    DELETE FROM invoice WHERE invoice_code LIKE 'INV!_%' ESCAPE '!';
  `);

  // Cleanup helper
  const cleanups = {
    invoices: [],
    adjustments: [],
    credits: [],
    subscriptions: [],
    catalog: [],
    deposits: [],
    attachments: [],
    notifications: [],
    audit_logs: [],
    payments: [],
    receivables: [],
    reservations: [],
  };

  t.after(async () => {
    try {
      await adminPool.query("SET app.allow_test_cleanup = 'true'").catch(() => {});
      if (cleanups.audit_logs.length > 0) {
        await adminPool.query('DELETE FROM audit_log WHERE id = ANY($1)', [cleanups.audit_logs]).catch(() => {});
      }
      if (cleanups.notifications.length > 0) {
        await adminPool.query('DELETE FROM notification WHERE id = ANY($1)', [cleanups.notifications]).catch(() => {});
      }
      if (cleanups.attachments.length > 0) {
        await adminPool.query('DELETE FROM attachment WHERE id = ANY($1)', [cleanups.attachments]).catch(() => {});
      }
      if (cleanups.adjustments.length > 0) {
        await adminPool.query('DELETE FROM invoice_adjustment WHERE id = ANY($1)', [cleanups.adjustments]).catch(() => {});
      }
      if (cleanups.credits.length > 0) {
        await adminPool.query('UPDATE credit_balance SET parent_credit_id = NULL WHERE id = ANY($1)', [cleanups.credits]).catch(() => {});
        await adminPool.query('DELETE FROM credit_balance WHERE id = ANY($1)', [cleanups.credits]).catch(() => {});
      }
      if (cleanups.payments.length > 0) {
        await adminPool.query('DELETE FROM payment WHERE id = ANY($1)', [cleanups.payments]).catch(() => {});
      }
      if (cleanups.receivables.length > 0) {
        await adminPool.query('DELETE FROM receivable WHERE id = ANY($1)', [cleanups.receivables]).catch(() => {});
      }
      if (cleanups.invoices.length > 0) {
        await adminPool.query('DELETE FROM invoice_line WHERE invoice_id = ANY($1)', [cleanups.invoices]).catch(() => {});
        await adminPool.query('DELETE FROM invoice WHERE id = ANY($1)', [cleanups.invoices]).catch(() => {});
      }
      if (cleanups.reservations.length > 0) {
        await adminPool.query('DELETE FROM reservation WHERE id = ANY($1)', [cleanups.reservations]).catch(() => {});
      }
      if (cleanups.subscriptions.length > 0) {
        await adminPool.query('DELETE FROM service_subscription WHERE id = ANY($1)', [cleanups.subscriptions]).catch(() => {});
      }
      if (cleanups.catalog.length > 0) {
        await adminPool.query('DELETE FROM service_catalog WHERE id = ANY($1)', [cleanups.catalog]).catch(() => {});
      }
      if (cleanups.deposits.length > 0) {
        await adminPool.query('DELETE FROM deposit_transaction WHERE deposit_id = ANY($1)', [cleanups.deposits]).catch(() => {});
        await adminPool.query('DELETE FROM deposit WHERE id = ANY($1)', [cleanups.deposits]).catch(() => {});
      }
      await adminPool.query(`
        UPDATE system_setting SET value = '{"allow_self_approval": false}'::jsonb
        WHERE org_id = $1 AND key = 'approval_config'
      `, [orgId]).catch(() => {});
      await adminPool.query("RESET app.allow_test_cleanup").catch(() => {});
    } finally {
      await adminPool.end();
      await appPool.end();
    }
  });

  await t.test('1. Schema DDL, Partial Unique Indexes, Triggers & Superuser Cleanup', async () => {
    // 1a. service_catalog partial unique index check
    const scCode = `TEST_SC_${Date.now()}`;
    const scDefault = await adminPool.query(`
      INSERT INTO service_catalog (org_id, code, name, category, billing_type, unit, unit_price)
      VALUES ($1, $2, 'Default Code Test', 'UTILITY', 'FIXED', 'tháng', 100000)
      RETURNING id
    `, [orgId, scCode]);
    cleanups.catalog.push(scDefault.rows[0].id);

    // Duplicate default code on same org must violate idx_service_catalog_org_default_code
    await assert.rejects(
      async () => {
        await adminPool.query(`
          INSERT INTO service_catalog (org_id, code, name, category, billing_type, unit, unit_price)
          VALUES ($1, $2, 'Duplicate Default', 'UTILITY', 'FIXED', 'tháng', 200000)
        `, [orgId, scCode]);
      },
      (err) => err.code === '23505',
      'Must reject duplicate default service_catalog code'
    );

    // Same code with specific building_id must SUCCEED
    const scBldg = await adminPool.query(`
      INSERT INTO service_catalog (org_id, building_id, code, name, category, billing_type, unit, unit_price)
      VALUES ($1, $2, $3, 'Building Override', 'UTILITY', 'FIXED', 'tháng', 150000)
      RETURNING id
    `, [orgId, buildingId, scCode]);
    cleanups.catalog.push(scBldg.rows[0].id);
    assert.ok(scBldg.rows[0].id, 'Building-level catalog override with same code must succeed');

    // 1b. service_subscription auto-lock trigger & status check
    const subRes = await adminPool.query(`
      INSERT INTO service_subscription (
        org_id, building_id, apartment_id, contract_id, service_id,
        quantity, unit_price, start_date, status
      )
      VALUES ($1, $2, $3, $4, $5, 1, 150000, CURRENT_DATE, 'PENDING_APPROVAL')
      RETURNING id, is_price_locked, status
    `, [orgId, buildingId, apartmentId, contractId, scBldg.rows[0].id]);
    cleanups.subscriptions.push(subRes.rows[0].id);
    assert.strictEqual(subRes.rows[0].is_price_locked, false, 'Auto-lock trigger should set false when matching catalog price');

    // Inserting with CANCELLED should normalize to TERMINATED
    const subNorm = await adminPool.query(`
      INSERT INTO service_subscription (
        org_id, building_id, apartment_id, contract_id, service_id,
        quantity, unit_price, start_date, end_date, status
      )
      VALUES ($1, $2, $3, $4, $5, 1, 999999, CURRENT_DATE - 10, CURRENT_DATE, 'CANCELLED')
      RETURNING id, is_price_locked, status
    `, [orgId, buildingId, apartmentId, contractId, scDefault.rows[0].id]);
    cleanups.subscriptions.push(subNorm.rows[0].id);
    assert.strictEqual(subNorm.rows[0].status, 'TERMINATED', 'Status CANCELLED must normalize to TERMINATED');
    assert.strictEqual(subNorm.rows[0].is_price_locked, true, 'Terminated subscription with price drift must auto-lock');

    // 1c. idx_invoice_unique_active_period: 23505 on duplicate, allowed after VOID
    const testPeriod = '2029-01';
    const inv1 = await adminPool.query(`
      INSERT INTO invoice (
        org_id, building_id, apartment_id, contract_id, tenant_id,
        invoice_code, period, issue_date, due_date, subtotal_amount, total_amount, paid_amount, status
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_DATE, CURRENT_DATE + 5, 1000000, 1000000, 0, 'ISSUED')
      RETURNING id
    `, [orgId, buildingId, apartmentId, contractId, tenantId, `INV_T1_${Date.now()}`, testPeriod]);
    cleanups.invoices.push(inv1.rows[0].id);

    await assert.rejects(
      async () => {
        await adminPool.query(`
          INSERT INTO invoice (
            org_id, building_id, apartment_id, contract_id, tenant_id,
            invoice_code, period, issue_date, due_date, subtotal_amount, total_amount, paid_amount, status
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_DATE, CURRENT_DATE + 5, 2000000, 2000000, 0, 'DRAFT')
        `, [orgId, buildingId, apartmentId, contractId, tenantId, `INV_T2_${Date.now()}`, testPeriod]);
      },
      (err) => err.code === '23505',
      'Must reject duplicate active period invoice on same contract'
    );

    // VOID inv1, then inserting second invoice for testPeriod must succeed
    await adminPool.query(`UPDATE invoice SET status = 'VOID' WHERE id = $1`, [inv1.rows[0].id]);
    const inv2 = await adminPool.query(`
      INSERT INTO invoice (
        org_id, building_id, apartment_id, contract_id, tenant_id,
        invoice_code, period, issue_date, due_date, subtotal_amount, total_amount, paid_amount, status
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_DATE, CURRENT_DATE + 5, 2000000, 2000000, 0, 'DRAFT')
      RETURNING id
    `, [orgId, buildingId, apartmentId, contractId, tenantId, `INV_T2_${Date.now()}`, testPeriod]);
    cleanups.invoices.push(inv2.rows[0].id);
    assert.ok(inv2.rows[0].id, 'New invoice on same period succeeds once prior is VOID');

    // 1d. adminPool DELETE cleanup succeeds with zero trigger errors
    const delInv = await adminPool.query('DELETE FROM invoice WHERE id = $1 RETURNING id', [inv2.rows[0].id]);
    assert.strictEqual(delInv.rowCount, 1, 'adminPool superuser DELETE on invoice must succeed cleanly');
  });

  await t.test('2. Review Focus #1 FORCE RLS Pins', async () => {
    // 2a. RESIDENT SELECT on invoice returns 0 on DRAFT, 1 on ISSUED
    const pD = '2029-02';
    const draftInv = await adminPool.query(`
      INSERT INTO invoice (
        org_id, building_id, apartment_id, contract_id, tenant_id,
        invoice_code, period, issue_date, due_date, subtotal_amount, total_amount, paid_amount, status
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_DATE, CURRENT_DATE + 5, 500000, 500000, 0, 'DRAFT')
      RETURNING id
    `, [orgId, buildingId, apartmentId, contractId, tenantId, `INV_DR_${Date.now()}`, pD]);
    cleanups.invoices.push(draftInv.rows[0].id);

    const resDraftSelect = await asUser(residentId, async (client) => {
      const res = await client.query('SELECT id FROM invoice WHERE id = $1', [draftInv.rows[0].id]);
      return res.rows;
    });
    assert.strictEqual(resDraftSelect.length, 0, 'AC-003.2: RESIDENT SELECT on DRAFT invoice must return 0 rows');

    await adminPool.query(`UPDATE invoice SET status = 'ISSUED' WHERE id = $1`, [draftInv.rows[0].id]);
    const resIssuedSelect = await asUser(residentId, async (client) => {
      const res = await client.query('SELECT id FROM invoice WHERE id = $1', [draftInv.rows[0].id]);
      return res.rows;
    });
    assert.strictEqual(resIssuedSelect.length, 1, 'RESIDENT SELECT on ISSUED invoice must return 1 row');

    // 2b. Locking under FORCE RLS: raw SELECT FOR UPDATE fails or returns 0 rows, fn_lock_invoices_for_authorized_viewer succeeds
    await asUserTx(residentId, async (client) => {
      const rawLock = await client.query('SELECT id FROM invoice WHERE id = $1 FOR UPDATE', [draftInv.rows[0].id]);
      assert.strictEqual(rawLock.rows.length, 0, 'Raw SELECT ... FOR UPDATE as RESIDENT returns 0 rows under FORCE RLS');
    });

    const lockedByResident = await asUserTx(residentId, async (client) => {
      const res = await client.query('SELECT * FROM fn_lock_invoices_for_authorized_viewer(NULL, $1)', [draftInv.rows[0].id]);
      return res.rows;
    });
    assert.strictEqual(lockedByResident.length, 1, 'fn_lock_invoices_for_authorized_viewer must return 1 locked row for RESIDENT');

    const lockedByOwner = await asUserTx(ownerId, async (client) => {
      const res = await client.query('SELECT * FROM fn_lock_invoices_for_authorized_viewer($1, NULL)', [contractId]);
      return res.rows;
    });
    assert.ok(lockedByOwner.length >= 1, 'fn_lock_invoices_for_authorized_viewer must return rows for OWNER');

    // fn_lock returns 0 rows on DRAFT for RESIDENT
    await adminPool.query(`UPDATE invoice SET status = 'DRAFT' WHERE id = $1`, [draftInv.rows[0].id]);
    const lockDraftRes = await asUserTx(residentId, async (client) => {
      const res = await client.query('SELECT * FROM fn_lock_invoices_for_authorized_viewer(NULL, $1)', [draftInv.rows[0].id]);
      return res.rows;
    });
    assert.strictEqual(lockDraftRes.length, 0, 'fn_lock_invoices_for_authorized_viewer must return 0 rows on DRAFT for RESIDENT');
    await adminPool.query(`UPDATE invoice SET status = 'ISSUED' WHERE id = $1`, [draftInv.rows[0].id]);

    // fn_lock returns 0 rows on unassigned building for OWNER/MANAGER
    const lockUnassigned = await asUserTx(ownerId, async (client) => {
      // Create a dummy invoice on otherBuildingId
      const dummyInv = await adminPool.query(`
        INSERT INTO invoice (
          org_id, building_id, apartment_id, invoice_code, period,
          issue_date, due_date, subtotal_amount, total_amount, paid_amount, status
        )
        SELECT $1, $2, id, $3, '2029-03', CURRENT_DATE, CURRENT_DATE + 5, 100000, 100000, 0, 'ISSUED'
        FROM apartment WHERE building_id = $2 LIMIT 1
        RETURNING id
      `, [orgId, otherBuildingId, `INV_OTH_${Date.now()}`]);
      cleanups.invoices.push(dummyInv.rows[0].id);

      const r = await client.query('SELECT * FROM fn_lock_invoices_for_authorized_viewer(NULL, $1)', [dummyInv.rows[0].id]);
      return r.rows;
    });
    assert.strictEqual(lockUnassigned.length, 0, 'fn_lock_invoices_for_authorized_viewer must return 0 rows for unassigned building');

    // 2c. fn_notify_building_finance_actors works both via MANAGER and trusted internal caller
    const notifCountMgr = await asUser(mgrId, async (client) => {
      const res = await client.query(
        `SELECT fn_notify_building_finance_actors($1, 'TEST_NOTIF', 'Title 1', 'Content 1', '{"test":true}'::jsonb, $2) AS cnt`,
        [buildingId, residentId]
      );
      return res.rows[0].cnt;
    });
    assert.ok(Number(notifCountMgr) >= 1, 'MANAGER calling fn_notify_building_finance_actors must insert rows');

    const notifCountInternal = await adminPool.query(
      `SELECT fn_notify_building_finance_actors($1, 'TEST_INTERNAL', 'Title Internal', 'Content Internal', '{"internal":true}'::jsonb, $2) AS cnt`,
      [buildingId, residentId]
    );
    assert.ok(Number(notifCountInternal.rows[0].cnt) >= 1, 'Internal adminPool calling fn_notify_building_finance_actors must succeed');

    // 2d. can_select_attachment rules
    const cbDummy = await adminPool.query(`
      INSERT INTO credit_balance (
        org_id, building_id, contract_id, tenant_id, reason_type, amount, status, description
      )
      VALUES ($1, $2, $3, $4, 'OVERPAYMENT', 100000, 'AVAILABLE', 'Test attachment guard')
      RETURNING id
    `, [orgId, buildingId, contractId, tenantId]);
    cleanups.credits.push(cbDummy.rows[0].id);

    const attRes = await adminPool.query(`
      INSERT INTO attachment (owner_entity, owner_id, storage_path, mime, size_bytes, uploaded_by)
      VALUES ('credit_balance', $1, '/test.pdf', 'application/pdf', 1024, $2)
      RETURNING id
    `, [cbDummy.rows[0].id, mgrId]);
    cleanups.attachments.push(attRes.rows[0].id);

    const canOwnerRead = await asUser(ownerId, async (client) => {
      const r = await client.query('SELECT can_select_attachment($1, $2, $3) AS ok', ['credit_balance', cbDummy.rows[0].id, mgrId]);
      return r.rows[0].ok;
    });
    assert.strictEqual(canOwnerRead, true, 'OWNER must be allowed to read credit_balance attachment');

    const canResidentRead = await asUser(residentId, async (client) => {
      const r = await client.query('SELECT can_select_attachment($1, $2, $3) AS ok', ['credit_balance', cbDummy.rows[0].id, mgrId]);
      return r.rows[0].ok;
    });
    assert.strictEqual(canResidentRead, true, 'Resident on contract must be allowed to read credit_balance attachment');

    // Preserving 046 PII guard: OWNER cannot read 'person' attachment
    const canOwnerReadPerson = await asUser(ownerId, async (client) => {
      const r = await client.query('SELECT can_select_attachment($1, $2, $3) AS ok', ['person', residentId, mgrId]);
      return r.rows[0].ok;
    });
    assert.strictEqual(canOwnerReadPerson, false, '046 guard: OWNER must be BLOCKED from reading person attachments');

    // 2e. SYS_ADMIN and OWNER direct INSERT/UPDATE/DELETE blocked by RLS on financial entities
    await asUser(ownerId, async (client) => {
      const updInv = await client.query('UPDATE invoice SET note = \'Hacked\' WHERE id = $1 RETURNING id', [draftInv.rows[0].id]);
      assert.strictEqual(updInv.rowCount, 0, 'RLS must block OWNER direct UPDATE on invoice');

      const updCb = await client.query('UPDATE credit_balance SET amount = 999999 WHERE id = $1 RETURNING id', [cbDummy.rows[0].id]);
      assert.strictEqual(updCb.rowCount, 0, 'RLS must block OWNER direct UPDATE on credit_balance');
    });

    await asUser(sysAdminId, async (client) => {
      const updInv = await client.query('UPDATE invoice SET note = \'Hacked Admin\' WHERE id = $1 RETURNING id', [draftInv.rows[0].id]);
      assert.strictEqual(updInv.rowCount, 0, 'RLS must block SYS_ADMIN direct UPDATE on invoice');
    });

    // MANAGER can DELETE invoice_line on DRAFT, blocked on ISSUED
    const invLineDraft = await adminPool.query(`
      INSERT INTO invoice_line (invoice_id, item_type, description, quantity, unit, unit_price, amount)
      VALUES ($1, 'SERVICE', 'Draft line', 1, 'tháng', 50000, 50000)
      RETURNING id
    `, [draftInv.rows[0].id]);
    await adminPool.query(`UPDATE invoice SET status = 'DRAFT' WHERE id = $1`, [draftInv.rows[0].id]);

    const delLineDraft = await asUser(mgrId, async (client) => {
      const r = await client.query('DELETE FROM invoice_line WHERE id = $1 RETURNING id', [invLineDraft.rows[0].id]);
      return r.rowCount;
    });
    assert.strictEqual(delLineDraft, 1, 'MANAGER must be able to DELETE invoice_line on DRAFT invoice');

    const invLineIssued = await adminPool.query(`
      INSERT INTO invoice_line (invoice_id, item_type, description, quantity, unit, unit_price, amount)
      VALUES ($1, 'SERVICE', 'Issued line', 1, 'tháng', 50000, 50000)
      RETURNING id
    `, [draftInv.rows[0].id]);
    await adminPool.query(`UPDATE invoice SET status = 'ISSUED' WHERE id = $1`, [draftInv.rows[0].id]);

    const delLineIssued = await asUser(mgrId, async (client) => {
      const r = await client.query('DELETE FROM invoice_line WHERE id = $1 RETURNING id', [invLineIssued.rows[0].id]);
      return r.rowCount;
    });
    assert.strictEqual(delLineIssued, 0, 'MANAGER must be BLOCKED from DELETING invoice_line on ISSUED invoice');

    // 2f. fn_get_finance_resource_scope check on all 11 entities
    const scopeCheck = await asUser(mgrId, async (client) => {
      const res = await client.query('SELECT * FROM fn_get_finance_resource_scope($1, $2)', ['invoice', draftInv.rows[0].id]);
      return res.rows;
    });
    assert.strictEqual(scopeCheck.length, 1, 'fn_get_finance_resource_scope must return 1 row for valid invoice');
    assert.strictEqual(scopeCheck[0].org_id, orgId);
    assert.strictEqual(scopeCheck[0].building_id, buildingId);

    // 2g. 12-entity rls_audit_log_select testing for OWNER and MANAGER
    // Entities: invoice, invoice_line, invoice_adjustment, payment, credit_balance, receivable,
    // deposit, deposit_transaction, reservation, service_subscription, service_catalog, contract_service_price
    const adjAudit = await adminPool.query(`
      INSERT INTO invoice_adjustment (org_id, building_id, invoice_id, adjustment_target, action_type, delta_amount, reason, created_by)
      VALUES ($1, $2, $3, 'MANUAL', 'ADJUST', 10000, 'Audit test', $4)
      RETURNING id
    `, [orgId, buildingId, draftInv.rows[0].id, mgrId]);
    cleanups.adjustments.push(adjAudit.rows[0].id);

    const payAudit = await adminPool.query(`
      INSERT INTO payment (org_id, building_id, invoice_id, payment_code, amount, method, status)
      VALUES ($1, $2, $3, $4, 10000, 'BANK_TRANSFER', 'CONFIRMED')
      RETURNING id
    `, [orgId, buildingId, draftInv.rows[0].id, `PAY_AUD_${Date.now()}`]);
    cleanups.payments.push(payAudit.rows[0].id);

    const recAudit = await adminPool.query(`
      INSERT INTO receivable (org_id, building_id, contract_id, invoice_id, amount, due_date, status)
      VALUES ($1, $2, $3, $4, 10000, CURRENT_DATE + 5, 'OPEN')
      RETURNING id
    `, [orgId, buildingId, contractId, draftInv.rows[0].id]);
    cleanups.receivables.push(recAudit.rows[0].id);

    const depAudit = await adminPool.query(`
      SELECT id FROM deposit WHERE contract_id = $1 LIMIT 1
    `, [contractId]);
    let depositAuditId = depAudit.rows[0]?.id;
    if (!depositAuditId) {
      const dRes = await adminPool.query(`
        INSERT INTO deposit (contract_id, amount_held, status)
        VALUES ($1, 1000000, 'HELD')
        RETURNING id
      `, [contractId]);
      depositAuditId = dRes.rows[0].id;
      cleanups.deposits.push(depositAuditId);
    }

    const dtAudit = await adminPool.query(`
      INSERT INTO deposit_transaction (deposit_id, type, amount, description)
      VALUES ($1, 'collect', 1000000, 'Test transaction')
      RETURNING id
    `, [depositAuditId]);

    const resAudit = await adminPool.query(`
      INSERT INTO reservation (org_id, building_id, apartment_id, prospect_name, phone, hold_amount, hold_until, status)
      VALUES ($1, $2, $3, 'Prospect Test', '0987654321', 1000000, CURRENT_DATE + 5, 'HELD')
      RETURNING id
    `, [orgId, buildingId, apartmentId]);
    cleanups.reservations.push(resAudit.rows[0].id);

    const catAudit = await adminPool.query(`
      SELECT id FROM service_catalog WHERE org_id = $1 AND building_id IS NULL LIMIT 1
    `, [orgId]);
    const catAuditId = catAudit.rows[0].id;

    const subAudit = await adminPool.query(`
      INSERT INTO service_subscription (org_id, building_id, apartment_id, contract_id, service_id, quantity, unit_price, start_date, status, is_price_locked)
      VALUES ($1, $2, $3, $4, $5, 1, 50000, CURRENT_DATE, 'ACTIVE', TRUE)
      RETURNING id
    `, [orgId, buildingId, apartmentId, contractId, catAuditId]);
    cleanups.subscriptions.push(subAudit.rows[0].id);

    const cspAudit = await adminPool.query(`
      INSERT INTO contract_service_price (contract_id, service_code, unit_price, effective_from)
      VALUES ($1, 'INTERNET', 200000, CURRENT_DATE)
      ON CONFLICT (contract_id, service_code, effective_from) DO UPDATE SET unit_price = 200000
      RETURNING id
    `, [contractId]);

    const auditEntities = [
      { entity: 'invoice', id: draftInv.rows[0].id },
      { entity: 'invoice_line', id: invLineIssued.rows[0].id },
      { entity: 'invoice_adjustment', id: adjAudit.rows[0].id },
      { entity: 'payment', id: payAudit.rows[0].id },
      { entity: 'credit_balance', id: cbDummy.rows[0].id },
      { entity: 'receivable', id: recAudit.rows[0].id },
      { entity: 'deposit', id: depositAuditId },
      { entity: 'deposit_transaction', id: dtAudit.rows[0].id },
      { entity: 'reservation', id: resAudit.rows[0].id },
      { entity: 'service_subscription', id: subAudit.rows[0].id },
      { entity: 'service_catalog', id: catAuditId },
      { entity: 'contract_service_price', id: cspAudit.rows[0].id },
    ];

    const seededAuditIds = [];
    for (const ae of auditEntities) {
      const aRes = await adminPool.query(`
        INSERT INTO audit_log (actor_id, action, entity, entity_id)
        VALUES ($1, 'TEST_AUDIT', $2, $3)
        RETURNING id
      `, [sysAdminId, ae.entity, ae.id]);
      seededAuditIds.push(aRes.rows[0].id);
      cleanups.audit_logs.push(aRes.rows[0].id);
    }

    // Also seed an audit_log for an unassigned building
    const unassignedAudit = await adminPool.query(`
      INSERT INTO audit_log (actor_id, action, entity, entity_id)
      VALUES ($1, 'TEST_AUDIT', 'building', $2)
      RETURNING id
    `, [sysAdminId, otherBuildingId]);
    cleanups.audit_logs.push(unassignedAudit.rows[0].id);

    // Assert OWNER can read all 12 entities in assigned building and NOT unassigned
    const ownerAuditRows = await asUser(ownerId, async (client) => {
      const r = await client.query('SELECT entity, entity_id FROM audit_log WHERE id = ANY($1)', [seededAuditIds.concat(unassignedAudit.rows[0].id)]);
      return r.rows;
    });
    assert.strictEqual(ownerAuditRows.length, 12, 'OWNER must be able to read all 12 financial entities in rls_audit_log_select');
    const ownerEntities = new Set(ownerAuditRows.map(r => r.entity));
    for (const ae of auditEntities) {
      assert.ok(ownerEntities.has(ae.entity), `OWNER must see audit_log for entity: ${ae.entity}`);
    }

    // Assert MANAGER can read all 12 entities in assigned building and NOT unassigned
    const mgrAuditRows = await asUser(mgrId, async (client) => {
      const r = await client.query('SELECT entity, entity_id FROM audit_log WHERE id = ANY($1)', [seededAuditIds.concat(unassignedAudit.rows[0].id)]);
      return r.rows;
    });
    assert.strictEqual(mgrAuditRows.length, 12, 'MANAGER must be able to read all 12 financial entities in rls_audit_log_select');
    const mgrEntities = new Set(mgrAuditRows.map(r => r.entity));
    for (const ae of auditEntities) {
      assert.ok(mgrEntities.has(ae.entity), `MANAGER must see audit_log for entity: ${ae.entity}`);
    }
  });

  await t.test('3. Review Focus #4 RPC Pins: fn_resolve_invoice_adjustment & fn_resolve_credit_refund', async () => {
    // 3a. 4-eyes enforcement: SELF_APPROVAL error when false, warning audit_log when true
    const invAdjTest = await adminPool.query(`
      INSERT INTO invoice (
        org_id, building_id, apartment_id, contract_id, tenant_id,
        invoice_code, period, issue_date, due_date, subtotal_amount, total_amount, paid_amount, status
      )
      VALUES ($1, $2, $3, $4, $5, $6, '2029-04', CURRENT_DATE, CURRENT_DATE + 5, 10200000, 10200000, 10200000, 'PAID')
      RETURNING id
    `, [orgId, buildingId, apartmentId, contractId, tenantId, `INV_ADJ_${Date.now()}`]);
    cleanups.invoices.push(invAdjTest.rows[0].id);

    await adminPool.query(`
      INSERT INTO invoice_line (invoice_id, item_type, description, quantity, unit, unit_price, amount)
      VALUES ($1, 'RENT', 'Tiền thuê gốc', 1, 'tháng', 10200000, 10200000)
    `, [invAdjTest.rows[0].id]);

    // Adjustment created by ownerId
    const adjSelf = await adminPool.query(`
      INSERT INTO invoice_adjustment (
        org_id, building_id, invoice_id, adjustment_target, action_type, delta_amount, reason, created_by
      )
      VALUES ($1, $2, $3, 'SERVICE', 'ADJUST', -100000, 'Self approval test', $4)
      RETURNING id
    `, [orgId, buildingId, invAdjTest.rows[0].id, ownerId]);
    cleanups.adjustments.push(adjSelf.rows[0].id);

    // Ensure approval_config has allow_self_approval = false
    await adminPool.query(`
      INSERT INTO system_setting (org_id, key, value, description)
      VALUES ($1, 'approval_config', '{"allow_self_approval": false}'::jsonb, 'Test approval config')
      ON CONFLICT (org_id, key) DO UPDATE SET value = '{"allow_self_approval": false}'::jsonb
    `, [orgId]);

    await assert.rejects(
      async () => {
        await asUserTx(ownerId, async (client) => {
          await client.query('SELECT fn_resolve_invoice_adjustment($1, \'APPROVED\')', [adjSelf.rows[0].id]);
        });
      },
      (err) => err.code === '42501' && err.message.includes('SELF_APPROVAL'),
      'Must reject self-approval when allow_self_approval is false'
    );

    // Block SYS_ADMIN when building_has_active_owner is true
    await assert.rejects(
      async () => {
        await asUserTx(sysAdminId, async (client) => {
          await client.query('SELECT fn_resolve_invoice_adjustment($1, \'APPROVED\')', [adjSelf.rows[0].id]);
        });
      },
      (err) => err.code === '42501',
      'Must block SYS_ADMIN when building has active owner'
    );

    // Now set allow_self_approval = true and test owner approval
    await adminPool.query(`
      UPDATE system_setting SET value = '{"allow_self_approval": true}'::jsonb
      WHERE org_id = $1 AND key = 'approval_config'
    `, [orgId]);

    // Test invalid decision token throws ERRCODE = 22023
    await assert.rejects(
      async () => {
        await asUserTx(ownerId, async (client) => {
          await client.query('SELECT fn_resolve_invoice_adjustment($1, \'MAYBE\')', [adjSelf.rows[0].id]);
        });
      },
      (err) => err.code === '22023' && err.message.includes('INVALID_DECISION'),
      'Must raise 22023 on invalid decision'
    );

    // Downward adjustment 1: -100_000 on 10_200_000 PAID invoice mints 100_000 credit (using 'APPROVE' variant)
    const resAdj1 = await asUserTx(ownerId, async (client) => {
      const r = await client.query('SELECT fn_resolve_invoice_adjustment($1, \'APPROVE\') AS out', [adjSelf.rows[0].id]);
      return r.rows[0].out;
    });
    assert.strictEqual(resAdj1.status, 'APPROVED');

    // Verify invoice paid_amount is clamped to 10_100_000 and total_amount is 10_100_000
    const invAfterAdj1 = await adminPool.query('SELECT total_amount, paid_amount, status FROM invoice WHERE id = $1', [invAdjTest.rows[0].id]);
    assert.strictEqual(Number(invAfterAdj1.rows[0].total_amount), 10100000);
    assert.strictEqual(Number(invAfterAdj1.rows[0].paid_amount), 10100000);

    // Test 'REJECT' variant on invoice adjustment
    const adjRej = await adminPool.query(`
      INSERT INTO invoice_adjustment (
        org_id, building_id, invoice_id, adjustment_target, action_type, delta_amount, reason, created_by
      )
      VALUES ($1, $2, $3, 'SERVICE', 'ADJUST', -50000, 'Test reject variant', $4)
      RETURNING id
    `, [orgId, buildingId, invAdjTest.rows[0].id, mgrId]);
    cleanups.adjustments.push(adjRej.rows[0].id);

    const resRej = await asUserTx(ownerId, async (client) => {
      const r = await client.query('SELECT fn_resolve_invoice_adjustment($1, \'REJECT\', \'Sai số liệu\') AS out', [adjRej.rows[0].id]);
      return r.rows[0].out;
    });
    assert.strictEqual(resRej.status, 'REJECTED');

    // Downward adjustment 2: -5_000_000 on 10_100_000 PAID invoice (using 'APPROVED')
    const adj2 = await adminPool.query(`
      INSERT INTO invoice_adjustment (
        org_id, building_id, invoice_id, adjustment_target, action_type, delta_amount, reason, created_by
      )
      VALUES ($1, $2, $3, 'SERVICE', 'ADJUST', -5000000, 'Second downward adj', $4)
      RETURNING id
    `, [orgId, buildingId, invAdjTest.rows[0].id, mgrId]);
    cleanups.adjustments.push(adj2.rows[0].id);

    await asUserTx(ownerId, async (client) => {
      await client.query('SELECT fn_resolve_invoice_adjustment($1, \'APPROVED\')', [adj2.rows[0].id]);
    });

    const totalCreditsMinted = await adminPool.query(`
      SELECT SUM(amount)::bigint AS sum_amt FROM credit_balance WHERE source_invoice_id = $1
    `, [invAdjTest.rows[0].id]);
    assert.strictEqual(Number(totalCreditsMinted.rows[0].sum_amt), 5100000, 'Sequential downward adjs must mint exact 5,100,000 credit');

    // 3b. +150_000 upward ADJUST on 0 ₫ PAID invoice UPSERTs OPEN receivable
    const invZero = await adminPool.query(`
      INSERT INTO invoice (
        org_id, building_id, apartment_id, contract_id, tenant_id,
        invoice_code, period, issue_date, due_date, subtotal_amount, total_amount, paid_amount, status
      )
      VALUES ($1, $2, $3, $4, $5, $6, '2029-05', CURRENT_DATE, CURRENT_DATE + 5, 0, 0, 0, 'PAID')
      RETURNING id
    `, [orgId, buildingId, apartmentId, contractId, tenantId, `INV_Z_${Date.now()}`]);
    cleanups.invoices.push(invZero.rows[0].id);

    const adjUp = await adminPool.query(`
      INSERT INTO invoice_adjustment (
        org_id, building_id, invoice_id, adjustment_target, action_type, delta_amount, reason, created_by
      )
      VALUES ($1, $2, $3, 'MANUAL', 'ADJUST', 150000, 'Upward correction', $4)
      RETURNING id
    `, [orgId, buildingId, invZero.rows[0].id, mgrId]);
    cleanups.adjustments.push(adjUp.rows[0].id);

    await asUserTx(ownerId, async (client) => {
      await client.query('SELECT fn_resolve_invoice_adjustment($1, \'APPROVED\')', [adjUp.rows[0].id]);
    });

    const recUp = await adminPool.query('SELECT amount, paid_amount, status FROM receivable WHERE invoice_id = $1', [invZero.rows[0].id]);
    assert.strictEqual(recUp.rows.length, 1, 'Upward adjustment must create/update receivable');
    assert.strictEqual(Number(recUp.rows[0].amount), 150000);
    assert.strictEqual(recUp.rows[0].status, 'OPEN');

    // 3c. -400_000 ADJUST on unpaid ISSUED invoice (subtotal = 500_000, credit_offset_amount = 300_000) releases 200_000 back to credit_balance
    const cbForOffset = await adminPool.query(`
      INSERT INTO credit_balance (
        org_id, building_id, contract_id, tenant_id, reason_type, amount, applied_amount, status, description
      )
      VALUES ($1, $2, $3, $4, 'OVERPAYMENT', 300000, 300000, 'APPLIED', 'Credit for offset release test')
      RETURNING id
    `, [orgId, buildingId, contractId, tenantId]);
    cleanups.credits.push(cbForOffset.rows[0].id);

    const invOffset = await adminPool.query(`
      INSERT INTO invoice (
        org_id, building_id, apartment_id, contract_id, tenant_id,
        invoice_code, period, issue_date, due_date, subtotal_amount, total_amount, paid_amount, credit_offset_amount, status
      )
      VALUES ($1, $2, $3, $4, $5, $6, '2029-06', CURRENT_DATE, CURRENT_DATE + 5, 500000, 500000, 0, 300000, 'ISSUED')
      RETURNING id
    `, [orgId, buildingId, apartmentId, contractId, tenantId, `INV_OFF_${Date.now()}`]);
    cleanups.invoices.push(invOffset.rows[0].id);

    // Link subtotal line and credit offset line
    await adminPool.query(`
      INSERT INTO invoice_line (invoice_id, item_type, description, quantity, unit, unit_price, amount)
      VALUES ($1, 'SERVICE', 'Dịch vụ gốc 500k', 1, 'tháng', 500000, 500000)
    `, [invOffset.rows[0].id]);
    await adminPool.query(`
      INSERT INTO invoice_line (invoice_id, item_type, description, quantity, unit, unit_price, amount, credit_id)
      VALUES ($1, 'ADJUSTMENT', 'Credit Offset Line', 1, 'lần', -300000, -300000, $2)
    `, [invOffset.rows[0].id, cbForOffset.rows[0].id]);

    const adjDownOffset = await adminPool.query(`
      INSERT INTO invoice_adjustment (
        org_id, building_id, invoice_id, adjustment_target, action_type, delta_amount, reason, created_by
      )
      VALUES ($1, $2, $3, 'SERVICE', 'ADJUST', -400000, 'Downward with excess credit offset', $4)
      RETURNING id
    `, [orgId, buildingId, invOffset.rows[0].id, mgrId]);
    cleanups.adjustments.push(adjDownOffset.rows[0].id);

    await asUserTx(ownerId, async (client) => {
      await client.query('SELECT fn_resolve_invoice_adjustment($1, \'APPROVED\')', [adjDownOffset.rows[0].id]);
    });

    const cbAfterRelease = await adminPool.query('SELECT amount, applied_amount, status FROM credit_balance WHERE id = $1', [cbForOffset.rows[0].id]);
    assert.strictEqual(Number(cbAfterRelease.rows[0].applied_amount), 100000, 'Credit applied_amount must be reduced to 100,000');
    assert.strictEqual(cbAfterRelease.rows[0].status, 'PARTIALLY_APPLIED', 'Credit status must be PARTIALLY_APPLIED after releasing 200,000');

    // 3d. LATE_FEE waiver (-200_000 on 300_000) & principal-zero neutralization
    const invLate = await adminPool.query(`
      INSERT INTO invoice (
        org_id, building_id, apartment_id, contract_id, tenant_id,
        invoice_code, period, issue_date, due_date, subtotal_amount, total_amount, paid_amount, status
      )
      VALUES ($1, $2, $3, $4, $5, $6, '2029-07', CURRENT_DATE, CURRENT_DATE + 5, 1300000, 1300000, 0, 'ISSUED')
      RETURNING id
    `, [orgId, buildingId, apartmentId, contractId, tenantId, `INV_LF_${Date.now()}`]);
    cleanups.invoices.push(invLate.rows[0].id);

    await adminPool.query(`
      INSERT INTO invoice_line (invoice_id, item_type, description, quantity, unit, unit_price, amount)
      VALUES
        ($1, 'RENT', 'Tiền thuê', 1, 'tháng', 1000000, 1000000),
        ($1, 'ADJUSTMENT', 'Phạt nộp muộn', 1, 'lần', 300000, 300000)
    `, [invLate.rows[0].id]);
    await adminPool.query(`
      UPDATE invoice_line SET formula_meta = '{"adjusts_item_type": "LATE_FEE"}'::jsonb
      WHERE invoice_id = $1 AND description = 'Phạt nộp muộn'
    `, [invLate.rows[0].id]);

    const adjLateWaiver = await adminPool.query(`
      INSERT INTO invoice_adjustment (
        org_id, building_id, invoice_id, adjustment_target, action_type, delta_amount, reason, created_by
      )
      VALUES ($1, $2, $3, 'LATE_FEE', 'ADJUST', -200000, 'Miễn 200k phạt', $4)
      RETURNING id
    `, [orgId, buildingId, invLate.rows[0].id, mgrId]);
    cleanups.adjustments.push(adjLateWaiver.rows[0].id);

    await asUserTx(ownerId, async (client) => {
      await client.query('SELECT fn_resolve_invoice_adjustment($1, \'APPROVED\')', [adjLateWaiver.rows[0].id]);
    });

    const waivedLines = await adminPool.query(`
      SELECT formula_meta FROM invoice_line
      WHERE invoice_id = $1 AND adjustment_id = $2
    `, [invLate.rows[0].id, adjLateWaiver.rows[0].id]);
    assert.strictEqual(waivedLines.rows[0].formula_meta.adjusts_item_type, 'LATE_FEE', 'Must tag adjusts_item_type = LATE_FEE');

    // Now waive entire rent (principal -> 0): remaining 100k late fee must auto-neutralize
    const adjWaiveRent = await adminPool.query(`
      INSERT INTO invoice_adjustment (
        org_id, building_id, invoice_id, adjustment_target, action_type, delta_amount, reason, created_by
      )
      VALUES ($1, $2, $3, 'RENT', 'ADJUST', -1000000, 'Hủy tiền thuê gốc', $4)
      RETURNING id
    `, [orgId, buildingId, invLate.rows[0].id, mgrId]);
    cleanups.adjustments.push(adjWaiveRent.rows[0].id);

    await asUserTx(ownerId, async (client) => {
      await client.query('SELECT fn_resolve_invoice_adjustment($1, \'APPROVED\')', [adjWaiveRent.rows[0].id]);
    });

    const autoNeutLine = await adminPool.query(`
      SELECT amount, formula_meta FROM invoice_line
      WHERE invoice_id = $1 AND formula_meta->>'auto_neutralized' = 'true'
    `, [invLate.rows[0].id]);
    assert.strictEqual(autoNeutLine.rows.length, 1, 'Must auto-neutralize remaining late fee');
    assert.strictEqual(Number(autoNeutLine.rows[0].amount), -100000, 'Auto-neutralized amount must be -100,000');

    // 3e. VOID adjustment resolution emits INVOICE_VOIDED resident notification (Brief Item 5)
    const invVoidTest = await adminPool.query(`
      INSERT INTO invoice (
        org_id, building_id, apartment_id, contract_id, tenant_id,
        invoice_code, period, issue_date, due_date, subtotal_amount, total_amount, paid_amount, status
      )
      VALUES ($1, $2, $3, $4, $5, $6, '2029-12', CURRENT_DATE, CURRENT_DATE + 5, 2000000, 2000000, 0, 'ISSUED')
      RETURNING id, invoice_code
    `, [orgId, buildingId, apartmentId, contractId, tenantId, `INV_VOID_${Date.now()}`]);
    cleanups.invoices.push(invVoidTest.rows[0].id);

    const adjVoid = await adminPool.query(`
      INSERT INTO invoice_adjustment (
        org_id, building_id, invoice_id, adjustment_target, action_type, delta_amount, reason, created_by
      )
      VALUES ($1, $2, $3, 'SERVICE', 'VOID', 0, 'Hủy hóa đơn sai kỳ', $4)
      RETURNING id
    `, [orgId, buildingId, invVoidTest.rows[0].id, mgrId]);
    cleanups.adjustments.push(adjVoid.rows[0].id);

    const resVoid = await asUserTx(ownerId, async (client) => {
      const r = await client.query('SELECT fn_resolve_invoice_adjustment($1, \'APPROVED\') AS out', [adjVoid.rows[0].id]);
      return r.rows[0].out;
    });
    assert.strictEqual(resVoid.status, 'APPROVED');
    assert.strictEqual(resVoid.action_type, 'VOID');

    const invAfterVoid = await adminPool.query('SELECT status FROM invoice WHERE id = $1', [invVoidTest.rows[0].id]);
    assert.strictEqual(invAfterVoid.rows[0].status, 'VOID');

    const notifVoid = await adminPool.query(`
      SELECT id, type, title, content, payload FROM notification
      WHERE user_id = $1 AND type = 'INVOICE_VOIDED' AND (payload->>'adjustment_id')::uuid = $2
    `, [residentId, adjVoid.rows[0].id]);
    assert.strictEqual(notifVoid.rows.length, 1, 'Approving VOID adjustment must insert INVOICE_VOIDED notification for resident');
    assert.ok(notifVoid.rows[0].title.includes('2029-12'));
    cleanups.notifications.push(notifVoid.rows[0].id);

    // 3f. fn_resolve_credit_refund: split, reject merge-back, and approve
    const cbParent = await adminPool.query(`
      INSERT INTO credit_balance (
        org_id, building_id, contract_id, tenant_id, reason_type, amount, applied_amount, status, description
      )
      VALUES ($1, $2, $3, $4, 'OVERPAYMENT', 1000000, 400000, 'PARTIALLY_APPLIED', 'Parent credit for refund test')
      RETURNING id
    `, [orgId, buildingId, contractId, tenantId]);
    cleanups.credits.push(cbParent.rows[0].id);

    // Split child row for 600k refund request
    const cbChild = await adminPool.query(`
      INSERT INTO credit_balance (
        org_id, building_id, contract_id, tenant_id, parent_credit_id, reason_type, amount, applied_amount, status, description, refund_meta
      )
      VALUES ($1, $2, $3, $4, $5, 'OVERPAYMENT', 600000, 0, 'PENDING_DIRECT_REFUND', 'Split child refund', $6)
      RETURNING id
    `, [orgId, buildingId, contractId, tenantId, cbParent.rows[0].id, JSON.stringify({ requested_by: mgrId })]);
    cleanups.credits.push(cbChild.rows[0].id);

    // Reject child: must merge back into parent and set child to VOID (using 'REJECT' variant)
    await asUserTx(ownerId, async (client) => {
      await client.query('SELECT fn_resolve_credit_refund($1, \'REJECT\', \'Chứng từ mờ\')', [cbChild.rows[0].id]);
    });

    const cbChildAfterReject = await adminPool.query('SELECT status, refund_meta FROM credit_balance WHERE id = $1', [cbChild.rows[0].id]);
    assert.strictEqual(cbChildAfterReject.rows[0].status, 'VOID', 'Rejected credit refund child row must be VOID');

    // Create another child for approval
    const cbChild2 = await adminPool.query(`
      INSERT INTO credit_balance (
        org_id, building_id, contract_id, tenant_id, parent_credit_id, reason_type, amount, applied_amount, status, description, refund_meta
      )
      VALUES ($1, $2, $3, $4, $5, 'OVERPAYMENT', 300000, 0, 'PENDING_DIRECT_REFUND', 'Second child for approval', $6)
      RETURNING id
    `, [orgId, buildingId, contractId, tenantId, cbParent.rows[0].id, JSON.stringify({ requested_by: mgrId })]);
    cleanups.credits.push(cbChild2.rows[0].id);

    // Test invalid decision raises 22023 on fn_resolve_credit_refund
    await assert.rejects(
      async () => {
        await asUserTx(ownerId, async (client) => {
          await client.query('SELECT fn_resolve_credit_refund($1, \'INVALID\')', [cbChild2.rows[0].id]);
        });
      },
      (err) => err.code === '22023' && err.message.includes('INVALID_DECISION'),
      'fn_resolve_credit_refund must raise 22023 on invalid decision'
    );

    // Approve child using 'APPROVE' variant
    await asUserTx(ownerId, async (client) => {
      await client.query('SELECT fn_resolve_credit_refund($1, \'APPROVE\')', [cbChild2.rows[0].id]);
    });

    const cbChild2Approved = await adminPool.query('SELECT status, refunded_at, applied_amount FROM credit_balance WHERE id = $1', [cbChild2.rows[0].id]);
    assert.strictEqual(cbChild2Approved.rows[0].status, 'REFUNDED_DIRECT', 'Approved credit refund must be REFUNDED_DIRECT');
    assert.ok(cbChild2Approved.rows[0].refunded_at !== null, 'refunded_at must be populated');
    assert.strictEqual(Number(cbChild2Approved.rows[0].applied_amount), 300000);
  });

  await t.test('4. Review Focus #2 DB Pins: 4-Pass Sequential Accounting & Cross-Bucket Spill', async () => {
    // Find unoccupied apartments in buildingId to avoid contract_no_overlap
    const availApts = await adminPool.query(`
      SELECT id FROM apartment
      WHERE building_id = $1
        AND id NOT IN (SELECT apartment_id FROM contract WHERE status IN ('ACTIVE', 'PENDING_APPROVAL', 'RENEWAL_PENDING'))
      LIMIT 3
    `, [buildingId]);
    assert.ok(availApts.rows.length >= 3, 'Need 3 unoccupied apartments for settlement tests');
    const apt4Id = availApts.rows[0].id;
    const apt5Id = availApts.rows[1].id;
    const apt6Id = availApts.rows[2].id;

    // Create dedicated contract for 4-pass settlement test to ensure 100% isolation of credit balances
    const ctr4Res = await adminPool.query(`
      INSERT INTO contract (apartment_id, building_id, primary_tenant_id, start_date, end_date, rent_amount, billing_day, status)
      VALUES ($1, $2, $3, '2026-01-01', '2026-12-31', 4000000, 1, 'ACTIVE')
      RETURNING id
    `, [apt4Id, buildingId, tenantId]);
    const ctr4Id = ctr4Res.rows[0].id;

    // Create dedicated deposit for 4-pass settlement test
    const depRes = await adminPool.query(`
      INSERT INTO deposit (contract_id, amount_held, status, settlement)
      VALUES ($1, 2000000, 'APPROVED_PENDING_PAYOUT', '{"refund_amount": 1000000}'::jsonb)
      RETURNING id
    `, [ctr4Id]);
    cleanups.deposits.push(depRes.rows[0].id);
    const depId = depRes.rows[0].id;

    // Multi-invoice 4-pass test:
    // Invoice 1: 2026-05, SERVICE = 1M
    // Invoice 2: 2026-06, RENT = 4M
    const invPass1 = await adminPool.query(`
      INSERT INTO invoice (
        org_id, building_id, apartment_id, contract_id, tenant_id,
        invoice_code, period, issue_date, due_date, subtotal_amount, total_amount, paid_amount, status
      )
      VALUES ($1, $2, $3, $4, $5, $6, '2026-05', CURRENT_DATE, CURRENT_DATE + 5, 1000000, 1000000, 0, 'ISSUED')
      RETURNING id
    `, [orgId, buildingId, apt4Id, ctr4Id, tenantId, `INV_P1_${Date.now()}`]);
    cleanups.invoices.push(invPass1.rows[0].id);
    await adminPool.query(`
      INSERT INTO invoice_line (invoice_id, item_type, description, quantity, unit, unit_price, amount)
      VALUES ($1, 'SERVICE', 'Dịch vụ tháng 5', 1, 'tháng', 1000000, 1000000)
    `, [invPass1.rows[0].id]);

    const invPass2 = await adminPool.query(`
      INSERT INTO invoice (
        org_id, building_id, apartment_id, contract_id, tenant_id,
        invoice_code, period, issue_date, due_date, subtotal_amount, total_amount, paid_amount, status
      )
      VALUES ($1, $2, $3, $4, $5, $6, '2026-06', CURRENT_DATE, CURRENT_DATE + 5, 4000000, 4000000, 0, 'ISSUED')
      RETURNING id
    `, [orgId, buildingId, apt4Id, ctr4Id, tenantId, `INV_P2_${Date.now()}`]);
    cleanups.invoices.push(invPass2.rows[0].id);
    await adminPool.query(`
      INSERT INTO invoice_line (invoice_id, item_type, description, quantity, unit, unit_price, amount)
      VALUES ($1, 'RENT', 'Tiền thuê tháng 6', 1, 'tháng', 4000000, 4000000)
    `, [invPass2.rows[0].id]);

    // Available credit = 1M
    const cbPass = await adminPool.query(`
      INSERT INTO credit_balance (
        org_id, building_id, contract_id, tenant_id, reason_type, amount, applied_amount, status, description
      )
      VALUES ($1, $2, $3, $4, 'OVERPAYMENT', 1000000, 0, 'AVAILABLE', '1M credit for 4-pass test')
      RETURNING id
    `, [orgId, buildingId, ctr4Id, tenantId]);
    cleanups.credits.push(cbPass.rows[0].id);

    // Call fn_apply_deposit_settlement_accounting with p_covered_service_debt = 1M
    await asUserTx(ownerId, async (client) => {
      await client.query('SELECT fn_apply_deposit_settlement_accounting($1, 1000000, 0)', [depId]);
    });

    // Pass 1 must apply 1M credit to Invoice 2 RENT:
    const inv2After = await adminPool.query('SELECT paid_amount, credit_offset_amount FROM invoice WHERE id = $1', [invPass2.rows[0].id]);
    assert.strictEqual(Number(inv2After.rows[0].paid_amount), 1000000, 'Pass 1 must apply 1M credit to Invoice 2 RENT');
    assert.strictEqual(Number(inv2After.rows[0].credit_offset_amount), 1000000);

    // Pass 4 must apply 1M deposit to Invoice 1 SERVICE:
    const inv1After = await adminPool.query('SELECT paid_amount, credit_offset_amount FROM invoice WHERE id = $1', [invPass1.rows[0].id]);
    assert.strictEqual(Number(inv1After.rows[0].paid_amount), 1000000, 'Pass 4 must apply 1M deposit to Invoice 1 SERVICE');
    assert.strictEqual(Number(inv1After.rows[0].credit_offset_amount), 0, 'Invoice 1 was covered by deposit, not credit offset');

    // Case B: when available_credit = 1_500_000, RENT = 0, SERVICE = 1_500_000, and p_covered_service_debt = 0 (post-credit remaining_service_debt = 0),
    // Pass 2 pays 1_500_000 SERVICE from credit_balance and Pass 4 deducts 0 from deposit
    const ctr5Res = await adminPool.query(`
      INSERT INTO contract (apartment_id, building_id, primary_tenant_id, start_date, end_date, rent_amount, billing_day, status)
      VALUES ($1, $2, $3, '2026-01-01', '2026-12-31', 3000000, 1, 'ACTIVE')
      RETURNING id
    `, [apt5Id, buildingId, tenantId]);
    const ctr5Id = ctr5Res.rows[0].id;

    const dep5Res = await adminPool.query(`
      INSERT INTO deposit (contract_id, amount_held, status, settlement)
      VALUES ($1, 2000000, 'APPROVED_PENDING_PAYOUT', '{"refund_amount": 2000000}'::jsonb)
      RETURNING id
    `, [ctr5Id]);
    cleanups.deposits.push(dep5Res.rows[0].id);

    const invCaseB = await adminPool.query(`
      INSERT INTO invoice (
        org_id, building_id, apartment_id, contract_id, tenant_id,
        invoice_code, period, issue_date, due_date, subtotal_amount, total_amount, paid_amount, status
      )
      VALUES ($1, $2, $3, $4, $5, $6, '2026-08', CURRENT_DATE, CURRENT_DATE + 5, 1500000, 1500000, 0, 'ISSUED')
      RETURNING id
    `, [orgId, buildingId, apt5Id, ctr5Id, tenantId, `INV_CB_${Date.now()}`]);
    cleanups.invoices.push(invCaseB.rows[0].id);
    await adminPool.query(`
      INSERT INTO invoice_line (invoice_id, item_type, description, quantity, unit, unit_price, amount)
      VALUES ($1, 'SERVICE', 'Dịch vụ 1.5M', 1, 'tháng', 1500000, 1500000)
    `, [invCaseB.rows[0].id]);

    const cbCaseB = await adminPool.query(`
      INSERT INTO credit_balance (
        org_id, building_id, contract_id, tenant_id, reason_type, amount, applied_amount, status, description
      )
      VALUES ($1, $2, $3, $4, 'OVERPAYMENT', 1500000, 0, 'AVAILABLE', '1.5M credit for Case B')
      RETURNING id
    `, [orgId, buildingId, ctr5Id, tenantId]);
    cleanups.credits.push(cbCaseB.rows[0].id);

    await asUserTx(ownerId, async (client) => {
      await client.query('SELECT fn_apply_deposit_settlement_accounting($1, 0, 0)', [dep5Res.rows[0].id]);
    });

    const invCaseBAfter = await adminPool.query('SELECT paid_amount, credit_offset_amount FROM invoice WHERE id = $1', [invCaseB.rows[0].id]);
    assert.strictEqual(Number(invCaseBAfter.rows[0].paid_amount), 1500000, 'Pass 2 must pay 1,500,000 SERVICE from credit_balance');
    assert.strictEqual(Number(invCaseBAfter.rows[0].credit_offset_amount), 1500000, 'Credit offset must be 1,500,000');

    // Test cross-bucket spill: MANUAL -1.5M on SERVICE 0.5M + RENT 10M -> service_effective = 0, rent_effective = 9M
    const invSpill = await adminPool.query(`
      INSERT INTO invoice (
        org_id, building_id, apartment_id, contract_id, tenant_id,
        invoice_code, period, issue_date, due_date, subtotal_amount, total_amount, paid_amount, status
      )
      VALUES ($1, $2, $3, $4, $5, $6, '2026-07', CURRENT_DATE, CURRENT_DATE + 5, 9000000, 9000000, 0, 'ISSUED')
      RETURNING id
    `, [orgId, buildingId, apt4Id, ctr4Id, tenantId, `INV_SPILL_${Date.now()}`]);
    cleanups.invoices.push(invSpill.rows[0].id);

    await adminPool.query(`
      INSERT INTO invoice_line (invoice_id, item_type, description, quantity, unit, unit_price, amount)
      VALUES
        ($1, 'RENT', 'Tiền thuê 10M', 1, 'tháng', 10000000, 10000000),
        ($1, 'SERVICE', 'Dịch vụ 500k', 1, 'tháng', 500000, 500000),
        ($1, 'ADJUSTMENT', 'Giảm thủ công -1.5M', 1, 'lần', -1500000, -1500000)
    `, [invSpill.rows[0].id]);

    const depSpill = await adminPool.query(`
      INSERT INTO deposit (contract_id, amount_held, status, settlement)
      VALUES ($1, 5000000, 'APPROVED_PENDING_PAYOUT', '{"refund_amount": 1000000}'::jsonb)
      RETURNING id
    `, [ctr4Id]);
    cleanups.deposits.push(depSpill.rows[0].id);

    // Call accounting with p_covered_service_debt = 500_000:
    // Because service_effective is 0 after spill, 0 service debt should be paid from deposit!
    await asUserTx(ownerId, async (client) => {
      await client.query('SELECT fn_apply_deposit_settlement_accounting($1, 500000, 0)', [depSpill.rows[0].id]);
    });

    const invSpillAfter = await adminPool.query('SELECT paid_amount FROM invoice WHERE id = $1', [invSpill.rows[0].id]);
    assert.strictEqual(Number(invSpillAfter.rows[0].paid_amount), 0, 'Cross-bucket spill wiped service debt to 0, so deposit covered 0');

    // Case D (Finding 2): Invoice that already has credit offset (credit_offset_amount > 0 + credit_id IS NOT NULL adjustment line)
    // Must NOT have v_raw_service double-reduced by credit offset line
    const ctr6Res = await adminPool.query(`
      INSERT INTO contract (apartment_id, building_id, primary_tenant_id, start_date, end_date, rent_amount, billing_day, status)
      VALUES ($1, $2, $3, '2026-01-01', '2026-12-31', 2000000, 1, 'ACTIVE')
      RETURNING id
    `, [apt6Id, buildingId, tenantId]);
    const ctr6Id = ctr6Res.rows[0].id;

    const dep6Res = await adminPool.query(`
      INSERT INTO deposit (contract_id, amount_held, status, settlement)
      VALUES ($1, 3000000, 'APPROVED_PENDING_PAYOUT', '{"refund_amount": 2500000}'::jsonb)
      RETURNING id
    `, [ctr6Id]);
    cleanups.deposits.push(dep6Res.rows[0].id);

    const cbOffsetDummy = await adminPool.query(`
      INSERT INTO credit_balance (
        org_id, building_id, contract_id, tenant_id, reason_type, amount, applied_amount, status, description
      )
      VALUES ($1, $2, $3, $4, 'OVERPAYMENT', 500000, 500000, 'APPLIED', 'Offset dummy credit')
      RETURNING id
    `, [orgId, buildingId, ctr6Id, tenantId]);
    cleanups.credits.push(cbOffsetDummy.rows[0].id);

    const invCaseD = await adminPool.query(`
      INSERT INTO invoice (
        org_id, building_id, apartment_id, contract_id, tenant_id,
        invoice_code, period, issue_date, due_date, subtotal_amount, total_amount, paid_amount, credit_offset_amount, status
      )
      VALUES ($1, $2, $3, $4, $5, $6, '2026-09', CURRENT_DATE, CURRENT_DATE + 5, 2000000, 1500000, 0, 500000, 'ISSUED')
      RETURNING id
    `, [orgId, buildingId, apt6Id, ctr6Id, tenantId, `INV_CD_${Date.now()}`]);
    cleanups.invoices.push(invCaseD.rows[0].id);

    await adminPool.query(`
      INSERT INTO invoice_line (invoice_id, item_type, description, quantity, unit, unit_price, amount)
      VALUES
        ($1, 'RENT', 'Tiền thuê 1M', 1, 'tháng', 1000000, 1000000),
        ($1, 'SERVICE', 'Dịch vụ 1M', 1, 'tháng', 1000000, 1000000)
    `, [invCaseD.rows[0].id]);

    await adminPool.query(`
      INSERT INTO invoice_line (invoice_id, item_type, description, quantity, unit, unit_price, amount, credit_id)
      VALUES ($1, 'ADJUSTMENT', 'Đã khấu trừ tín dụng 500k', 1, 'lần', -500000, -500000, $2)
    `, [invCaseD.rows[0].id, cbOffsetDummy.rows[0].id]);

    // Accounting call with p_covered_service_debt = 1_000_000:
    // With il.credit_id IS NULL filter, v_raw_rent = 1M, v_raw_service = 1M.
    // v_rem = 1.5M -> v_rent_unpaid = 1.0M, v_service_unpaid = min(1.0M, 1.5M - 1.0M) = 500,000.
    // Pass 4 pays min(v_service_unpaid = 500_000, p_covered_service_debt = 1_000_000) = 500_000 from deposit.
    await asUserTx(ownerId, async (client) => {
      await client.query('SELECT fn_apply_deposit_settlement_accounting($1, 1000000, 0)', [dep6Res.rows[0].id]);
    });

    const invCaseDAfter = await adminPool.query('SELECT paid_amount, credit_offset_amount FROM invoice WHERE id = $1', [invCaseD.rows[0].id]);
    assert.strictEqual(Number(invCaseDAfter.rows[0].paid_amount), 500000, 'Deposit must cover exactly 500,000 remaining service debt');
    assert.strictEqual(Number(invCaseDAfter.rows[0].credit_offset_amount), 500000, 'Existing credit_offset_amount must remain intact');


    // Test fn_update_deposit_refund_bank_info, fn_restore_returned_settlement_credits, and fn_recommit_returned_settlement_credits under FORCE RLS
    await asUserTx(ownerId, async (client) => {
      const updBank = await client.query(`
        SELECT fn_update_deposit_refund_bank_info($1, '{"bank_name": "VCB", "account_no": "123456789"}'::jsonb)
      `, [depId]);
      assert.ok(updBank.rows.length > 0, 'fn_update_deposit_refund_bank_info must succeed under FORCE RLS');
    });

    // Link a settlement credit
    const cbSettlement = await adminPool.query(`
      INSERT INTO credit_balance (
        org_id, building_id, contract_id, tenant_id, settlement_deposit_id, reason_type, amount, applied_amount, status, description, refunded_at
      )
      VALUES ($1, $2, $3, $4, $5, 'OVERPAYMENT', 500000, 500000, 'REFUNDED_IN_SETTLEMENT', 'Settlement credit test', NOW())
      RETURNING id
    `, [orgId, buildingId, ctr4Id, tenantId, depId]);
    cleanups.credits.push(cbSettlement.rows[0].id);

    await asUserTx(ownerId, async (client) => {
      const restoredCnt = await client.query('SELECT fn_restore_returned_settlement_credits($1, \'Khách khiếu nại\') AS cnt', [depId]);
      assert.strictEqual(Number(restoredCnt.rows[0].cnt), 1, 'fn_restore_returned_settlement_credits must restore 1 credit');
    });

    const cbRestored = await adminPool.query('SELECT status, refunded_at FROM credit_balance WHERE id = $1', [cbSettlement.rows[0].id]);
    assert.strictEqual(cbRestored.rows[0].status, 'PENDING_SETTLEMENT_PAYOUT');
    assert.strictEqual(cbRestored.rows[0].refunded_at, null);

    await asUserTx(ownerId, async (client) => {
      const recommittedCnt = await client.query('SELECT fn_recommit_returned_settlement_credits($1) AS cnt', [depId]);
      assert.strictEqual(Number(recommittedCnt.rows[0].cnt), 1, 'fn_recommit_returned_settlement_credits must recommit 1 credit');
    });

    const cbRecommitted = await adminPool.query('SELECT status, refunded_at FROM credit_balance WHERE id = $1', [cbSettlement.rows[0].id]);
    assert.strictEqual(cbRecommitted.rows[0].status, 'REFUNDED_IN_SETTLEMENT');
    assert.ok(cbRecommitted.rows[0].refunded_at !== null);

    // Clean up contracts created
    await adminPool.query('DELETE FROM contract WHERE id IN ($1, $2, $3)', [ctr4Id, ctr5Id, ctr6Id]);
  });

  await t.test('5. Migration 055: fn_resolve_invoice_adjustment LATE_FEE waiver with credit_offset_amount (Bug #2), fn_apply_deposit_settlement_accounting LATE_FEE (Bug #1), and tracker DDL', async () => {
    // 5a. Bug #2: invoice subtotal=1,000,000 (700k RENT + 300k LATE_FEE), credit_offset_amount=200,000, total_amount=800,000
    // Apply LATE_FEE waiver of -300,000 -> expected total = GREATEST(0, 1,000,000 - 300,000 - 200,000) = 500,000
    const cbBug2 = await adminPool.query(`
      INSERT INTO credit_balance (
        org_id, building_id, contract_id, tenant_id, reason_type, amount, applied_amount, status, description
      )
      VALUES ($1, $2, $3, $4, 'OVERPAYMENT', 200000, 200000, 'APPLIED', 'Bug2 test credit 200k')
      RETURNING id
    `, [orgId, buildingId, contractId, tenantId]);
    cleanups.credits.push(cbBug2.rows[0].id);

    const invBug2 = await adminPool.query(`
      INSERT INTO invoice (
        org_id, building_id, apartment_id, contract_id, tenant_id,
        invoice_code, period, issue_date, due_date, subtotal_amount, total_amount, paid_amount, credit_offset_amount, status
      )
      VALUES ($1, $2, $3, $4, $5, $6, '2030-01', CURRENT_DATE, CURRENT_DATE + 5, 1000000, 800000, 0, 200000, 'ISSUED')
      RETURNING id
    `, [orgId, buildingId, apartmentId, contractId, tenantId, `INV_BUG2_${Date.now()}`]);
    const testInvoiceId = invBug2.rows[0].id;
    cleanups.invoices.push(testInvoiceId);

    await adminPool.query(`
      INSERT INTO invoice_line (invoice_id, item_type, description, quantity, unit, unit_price, amount)
      VALUES
        ($1, 'RENT', 'Tiền thuê 700k', 1, 'tháng', 700000, 700000),
        ($1, 'LATE_FEE', 'Phí phạt chậm kỳ trước dồn sang', 1, 'kỳ', 300000, 300000)
    `, [testInvoiceId]);
    await adminPool.query(`
      INSERT INTO invoice_line (invoice_id, item_type, description, quantity, unit, unit_price, amount, credit_id)
      VALUES ($1, 'ADJUSTMENT', 'Bù trừ số dư tín dụng 200k', 1, 'lần', -200000, -200000, $2)
    `, [testInvoiceId, cbBug2.rows[0].id]);

    const adjBug2 = await adminPool.query(`
      INSERT INTO invoice_adjustment (
        org_id, building_id, invoice_id, adjustment_target, action_type, delta_amount, reason, created_by
      )
      VALUES ($1, $2, $3, 'LATE_FEE', 'ADJUST', -300000, 'Test Bug2 LATE_FEE waiver 300k', $4)
      RETURNING id
    `, [orgId, buildingId, testInvoiceId, mgrId]);
    const testAdjId = adjBug2.rows[0].id;
    cleanups.adjustments.push(testAdjId);

    await asUserTx(ownerId, async (client) => {
      await client.query('SELECT fn_resolve_invoice_adjustment($1, \'APPROVE\', NULL) AS result', [testAdjId]);
    });

    const afterBug2 = await adminPool.query(
      'SELECT subtotal_amount, adjustment_amount, credit_offset_amount, total_amount FROM invoice WHERE id = $1',
      [testInvoiceId]
    );
    assert.equal(Number(afterBug2.rows[0].credit_offset_amount), 200000, 'credit_offset_amount stays 200,000');
    assert.equal(Number(afterBug2.rows[0].total_amount), 500000, 'Bug #2: total must deduct credit_offset_amount (500,000 not 700,000)');

    // 5b. Bug #1 SQL: fn_apply_deposit_settlement_accounting counts LATE_FEE line in v_raw_service
    const availAptBug1 = await adminPool.query(`
      SELECT id FROM apartment
      WHERE building_id = $1
        AND id NOT IN (SELECT apartment_id FROM contract WHERE status IN ('ACTIVE', 'PENDING_APPROVAL', 'RENEWAL_PENDING'))
      LIMIT 1
    `, [buildingId]);
    const aptBug1Id = availAptBug1.rows[0].id;
    const ctrBug1 = await adminPool.query(`
      INSERT INTO contract (apartment_id, building_id, primary_tenant_id, start_date, end_date, rent_amount, billing_day, status)
      VALUES ($1, $2, $3, '2026-01-01', '2026-06-30', 1000000, 1, 'TERMINATED')
      RETURNING id
    `, [aptBug1Id, buildingId, tenantId]);
    const ctrBug1Id = ctrBug1.rows[0].id;

    const depBug1 = await adminPool.query(`
      INSERT INTO deposit (contract_id, amount_held, status, settlement)
      VALUES ($1, 1000000, 'APPROVED_PENDING_PAYOUT', '{"refund_amount": 700000}'::jsonb)
      RETURNING id
    `, [ctrBug1Id]);
    cleanups.deposits.push(depBug1.rows[0].id);

    const invBug1 = await adminPool.query(`
      INSERT INTO invoice (
        org_id, building_id, apartment_id, contract_id, tenant_id,
        invoice_code, period, invoice_type, issue_date, due_date, subtotal_amount, total_amount, paid_amount, status
      )
      VALUES ($1, $2, $3, $4, $5, $6, NULL, 'LATE_FEE_SETTLEMENT', CURRENT_DATE, CURRENT_DATE + 7, 300000, 300000, 0, 'ISSUED')
      RETURNING id
    `, [orgId, buildingId, aptBug1Id, ctrBug1Id, tenantId, `INV_LF_SET_${Date.now()}`]);
    cleanups.invoices.push(invBug1.rows[0].id);

    await adminPool.query(`
      INSERT INTO invoice_line (invoice_id, item_type, description, quantity, unit, unit_price, amount)
      VALUES ($1, 'LATE_FEE', 'Phí phạt chậm kỳ cuối', 1, 'kỳ', 300000, 300000)
    `, [invBug1.rows[0].id]);

    await asUserTx(ownerId, async (client) => {
      await client.query('SELECT fn_apply_deposit_settlement_accounting($1, 300000, 0)', [depBug1.rows[0].id]);
    });

    const invBug1After = await adminPool.query('SELECT paid_amount, status FROM invoice WHERE id = $1', [invBug1.rows[0].id]);
    assert.equal(Number(invBug1After.rows[0].paid_amount), 300000, 'Bug #1 SQL: deposit must cover 300,000 LATE_FEE debt');
    assert.equal(invBug1After.rows[0].status, 'PAID', 'LATE_FEE_SETTLEMENT invoice must become PAID');

    await adminPool.query('DELETE FROM contract WHERE id = $1', [ctrBug1Id]);
  });

  await t.test('6. Review Fix Critical #2: source VOID/zero-principal cancels open tracker; destination T+1 zero-principal preserves carried LATE_FEE', async () => {
    // 6a. Source T 4-eyes VOID cancels open late_fee_accrual_tracker row
    const invSrcVoid = await adminPool.query(`
      INSERT INTO invoice (
        org_id, building_id, apartment_id, contract_id, tenant_id,
        invoice_code, period, issue_date, due_date, subtotal_amount, total_amount, paid_amount, status
      )
      VALUES ($1, $2, $3, $4, $5, $6, '2030-02', CURRENT_DATE - 20, CURRENT_DATE - 15, 5000000, 5000000, 0, 'OVERDUE')
      RETURNING id
    `, [orgId, buildingId, apartmentId, contractId, tenantId, `INV_SRCVOID_${Date.now()}`]);
    const srcVoidId = invSrcVoid.rows[0].id;
    cleanups.invoices.push(srcVoidId);

    await adminPool.query(`
      INSERT INTO invoice_line (invoice_id, item_type, description, quantity, unit, unit_price, amount)
      VALUES ($1, 'RENT', 'Tiền thuê T', 1, 'tháng', 5000000, 5000000)
    `, [srcVoidId]);

    await adminPool.query(`
      INSERT INTO late_fee_accrual_tracker (org_id, contract_id, invoice_id, accrued_total, chargeable_days, as_of_date)
      VALUES ($1, $2, $3, 300000, 3, CURRENT_DATE)
    `, [orgId, contractId, srcVoidId]);

    const adjSrcVoid = await adminPool.query(`
      INSERT INTO invoice_adjustment (
        org_id, building_id, invoice_id, action_type, reason, created_by
      )
      VALUES ($1, $2, $3, 'VOID', 'Hủy hóa đơn T gốc', $4)
      RETURNING id
    `, [orgId, buildingId, srcVoidId, mgrId]);
    cleanups.adjustments.push(adjSrcVoid.rows[0].id);

    await asUserTx(ownerId, async (client) => {
      await client.query(`SELECT fn_resolve_invoice_adjustment($1, 'APPROVE', NULL)`, [adjSrcVoid.rows[0].id]);
    });

    const trAfterSrcVoid = await adminPool.query(
      `SELECT * FROM late_fee_accrual_tracker WHERE invoice_id = $1 AND carried_to_invoice_id IS NULL`,
      [srcVoidId]
    );
    assert.equal(trAfterSrcVoid.rowCount, 0, 'Critical #2a: 4-eyes VOID on source invoice T must cancel its open tracker');

    // 6b. Source T2 zero-principal adjustment cancels open late_fee_accrual_tracker row
    const invSrcZero = await adminPool.query(`
      INSERT INTO invoice (
        org_id, building_id, apartment_id, contract_id, tenant_id,
        invoice_code, period, issue_date, due_date, subtotal_amount, total_amount, paid_amount, status
      )
      VALUES ($1, $2, $3, $4, $5, $6, '2030-03', CURRENT_DATE - 20, CURRENT_DATE - 15, 4000000, 4000000, 0, 'OVERDUE')
      RETURNING id
    `, [orgId, buildingId, apartmentId, contractId, tenantId, `INV_SRCZERO_${Date.now()}`]);
    const srcZeroId = invSrcZero.rows[0].id;
    cleanups.invoices.push(srcZeroId);

    await adminPool.query(`
      INSERT INTO invoice_line (invoice_id, item_type, description, quantity, unit, unit_price, amount)
      VALUES ($1, 'RENT', 'Tiền thuê T2', 1, 'tháng', 4000000, 4000000)
    `, [srcZeroId]);

    await adminPool.query(`
      INSERT INTO late_fee_accrual_tracker (org_id, contract_id, invoice_id, accrued_total, chargeable_days, as_of_date)
      VALUES ($1, $2, $3, 200000, 2, CURRENT_DATE)
    `, [orgId, contractId, srcZeroId]);

    const adjSrcZero = await adminPool.query(`
      INSERT INTO invoice_adjustment (
        org_id, building_id, invoice_id, adjustment_target, action_type, delta_amount, reason, created_by
      )
      VALUES ($1, $2, $3, 'RENT', 'ADJUST', -4000000, 'Miễn 100% tiền thuê T2', $4)
      RETURNING id
    `, [orgId, buildingId, srcZeroId, mgrId]);
    cleanups.adjustments.push(adjSrcZero.rows[0].id);

    await asUserTx(ownerId, async (client) => {
      await client.query(`SELECT fn_resolve_invoice_adjustment($1, 'APPROVE', NULL)`, [adjSrcZero.rows[0].id]);
    });

    const trAfterSrcZero = await adminPool.query(
      `SELECT * FROM late_fee_accrual_tracker WHERE invoice_id = $1 AND carried_to_invoice_id IS NULL`,
      [srcZeroId]
    );
    assert.equal(trAfterSrcZero.rowCount, 0, 'Critical #2b: zero-principal adjustment on unpaid source invoice must cancel its open tracker');

    // 6c. Destination T+1 zero-principal adjustment preserves carried_forward LATE_FEE from T
    const invDestZero = await adminPool.query(`
      INSERT INTO invoice (
        org_id, building_id, apartment_id, contract_id, tenant_id,
        invoice_code, period, issue_date, due_date, subtotal_amount, total_amount, paid_amount, status
      )
      VALUES ($1, $2, $3, $4, $5, $6, '2030-04', CURRENT_DATE, CURRENT_DATE + 5, 5300000, 5300000, 0, 'ISSUED')
      RETURNING id
    `, [orgId, buildingId, apartmentId, contractId, tenantId, `INV_DESTZERO_${Date.now()}`]);
    const destZeroId = invDestZero.rows[0].id;
    cleanups.invoices.push(destZeroId);

    await adminPool.query(`
      INSERT INTO invoice_line (invoice_id, item_type, description, quantity, unit, unit_price, amount, formula_meta)
      VALUES
        ($1, 'RENT', 'Tiền thuê T+1', 1, 'tháng', 5000000, 5000000, '{}'::jsonb),
        ($1, 'LATE_FEE', 'Phí phạt kỳ T dồn sang', 1, 'kỳ', 300000, 300000, '{"carry_forward": true}'::jsonb)
    `, [destZeroId]);

    const adjDestZero = await adminPool.query(`
      INSERT INTO invoice_adjustment (
        org_id, building_id, invoice_id, adjustment_target, action_type, delta_amount, reason, created_by
      )
      VALUES ($1, $2, $3, 'RENT', 'ADJUST', -5000000, 'Miễn tiền thuê kỳ T+1 nhưng không miễn phạt kỳ T', $4)
      RETURNING id
    `, [orgId, buildingId, destZeroId, mgrId]);
    cleanups.adjustments.push(adjDestZero.rows[0].id);

    await asUserTx(ownerId, async (client) => {
      await client.query(`SELECT fn_resolve_invoice_adjustment($1, 'APPROVE', NULL)`, [adjDestZero.rows[0].id]);
    });

    const destAfter = await adminPool.query('SELECT total_amount FROM invoice WHERE id = $1', [destZeroId]);
    assert.equal(Number(destAfter.rows[0].total_amount), 300000, 'Critical #2c: zeroing T+1 own principal must NOT auto-erase carried-forward LATE_FEE from T');
  });
});
