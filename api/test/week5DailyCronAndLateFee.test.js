import { test } from 'node:test';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import pg from 'pg';
import bcrypt from 'bcryptjs';

dotenv.config();

const ADMIN_DB_URL =
  process.env.DATABASE_URL ||
  'postgres://postgres:postgres@127.0.0.1:5433/resihub';
const APP_DB_URL =
  process.env.APP_DATABASE_URL ||
  'postgres://resihub_app:resihub_app_secret@127.0.0.1:5433/resihub';

process.env.APP_DATABASE_URL = APP_DB_URL;

test('Week 5 Daily Cron Scheduler (FR-066), Advisory Lock + 3x Retry (PRD 14.5) & Row-Locked Late Fee (FR-064)', async (t) => {
  const adminPool = new pg.Pool({ connectionString: ADMIN_DB_URL });

  const { adminPool: appAdminPool, appPool } = await import('../src/db/client.js');
  const { runDailyJobs, DAILY_JOB_ADVISORY_LOCK_KEY } = await import('../src/jobs/daily.js');

  const suffix = `${Date.now().toString().slice(-6)}${Math.floor(Math.random() * 90 + 10)}`;
  const cleanup = {
    meterIds: [],
    invoiceIds: [],
    contractIds: [],
    apartmentIds: [],
    floorIds: [],
    buildingIds: [],
    ownerIds: [],
    tenantIds: [],
    userIds: [],
    personIds: [],
    runDates: ['2028-02-28', '2028-02-29', '2028-03-15', '2028-03-16', '2028-03-17', '2028-03-18', '2028-05-06', '2028-05-09', '2028-05-10', '2028-05-25', '2028-05-30'],
    origBillingConfig: null,
    testStartedAt: new Date().toISOString(),
  };

  const orgRes = await adminPool.query(`SELECT org_id FROM building WHERE code = 'VOP-A' LIMIT 1`);
  const orgId = orgRes.rows[0].org_id;

  const origBcRes = await adminPool.query(
    `SELECT value FROM system_setting WHERE org_id = $1 AND key = 'billing_config' LIMIT 1`,
    [orgId]
  );
  cleanup.origBillingConfig = origBcRes.rows[0]?.value || null;

  t.after(async () => {
    const c = await adminPool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.allow_test_cleanup', 'true', true)`);

      if (cleanup.origBillingConfig) {
        await c.query(
          `UPDATE system_setting SET value = $1::jsonb WHERE org_id = $2 AND key = 'billing_config'`,
          [JSON.stringify(cleanup.origBillingConfig), orgId]
        );
      }

      await c.query(
        `DELETE FROM cron_job_run WHERE run_date = ANY($1::date[]) AND started_at >= $2::timestamptz`,
        [cleanup.runDates, cleanup.testStartedAt]
      );
      await c.query(
        `DELETE FROM notification
         WHERE type IN ('MISSING_METER_READING', 'CRON_JOB_FAILED')
           AND created_at >= $1::timestamptz`,
        [cleanup.testStartedAt]
      );

      if (cleanup.contractIds.length > 0 || cleanup.invoiceIds.length > 0) {
        await c.query(
          `DELETE FROM audit_log
           WHERE entity = 'invoice'
             AND (entity_id = ANY($1::uuid[])
               OR entity_id IN (SELECT id FROM invoice WHERE contract_id = ANY($2::uuid[])))`,
          [cleanup.invoiceIds, cleanup.contractIds]
        );
        await c.query(
          `DELETE FROM receivable
           WHERE invoice_id = ANY($1::uuid[]) OR contract_id = ANY($2::uuid[])`,
          [cleanup.invoiceIds, cleanup.contractIds]
        );
        await c.query(
          `DELETE FROM invoice_line
           WHERE invoice_id = ANY($1::uuid[])
              OR invoice_id IN (SELECT id FROM invoice WHERE contract_id = ANY($2::uuid[]))`,
          [cleanup.invoiceIds, cleanup.contractIds]
        );
        await c.query(
          `DELETE FROM invoice WHERE id = ANY($1::uuid[]) OR contract_id = ANY($2::uuid[])`,
          [cleanup.invoiceIds, cleanup.contractIds]
        );
      }
      if (cleanup.meterIds.length > 0) {
        await c.query(`DELETE FROM meter_reading WHERE meter_id = ANY($1::uuid[])`, [cleanup.meterIds]);
        await c.query(`DELETE FROM meter WHERE id = ANY($1::uuid[])`, [cleanup.meterIds]);
      }
      if (cleanup.contractIds.length > 0) {
        await c.query(`DELETE FROM notification WHERE payload::text LIKE ANY($1::text[])`, [
          cleanup.contractIds.map((id) => `%${id}%`),
        ]);
        await c.query(`DELETE FROM contract WHERE id = ANY($1::uuid[])`, [cleanup.contractIds]);
      }
      if (cleanup.apartmentIds.length > 0) {
        await c.query(`DELETE FROM apartment WHERE id = ANY($1::uuid[])`, [cleanup.apartmentIds]);
      }
      if (cleanup.floorIds.length > 0) {
        await c.query(`DELETE FROM floor WHERE id = ANY($1::uuid[])`, [cleanup.floorIds]);
      }
      if (cleanup.buildingIds.length > 0) {
        await c.query(`DELETE FROM building WHERE id = ANY($1::uuid[])`, [cleanup.buildingIds]);
      }
      if (cleanup.ownerIds.length > 0) {
        await c.query(`DELETE FROM owner WHERE id = ANY($1::uuid[])`, [cleanup.ownerIds]);
      }
      if (cleanup.tenantIds.length > 0) {
        await c.query(`DELETE FROM tenant WHERE id = ANY($1::uuid[])`, [cleanup.tenantIds]);
      }
      if (cleanup.userIds.length > 0) {
        await c.query(`DELETE FROM notification WHERE user_id = ANY($1::uuid[])`, [cleanup.userIds]);
        await c.query(`DELETE FROM user_role WHERE user_id = ANY($1::uuid[])`, [cleanup.userIds]);
        await c.query(`DELETE FROM app_user WHERE id = ANY($1::uuid[])`, [cleanup.userIds]);
      }
      if (cleanup.personIds.length > 0) {
        await c.query(`DELETE FROM person WHERE id = ANY($1::uuid[])`, [cleanup.personIds]);
      }

      await c.query('COMMIT');
    } catch (err) {
      await c.query('ROLLBACK');
      console.error('[Week5 Cron Test Cleanup Error]:', err.message);
    } finally {
      c.release();
      await adminPool.end().catch(() => {});
      await appPool.end().catch(() => {});
      await appAdminPool.end().catch(() => {});
    }
  });

  const pwHash = await bcrypt.hash('Demo@123456', 10);
  const rolesRes = await adminPool.query(
    `SELECT code, id FROM role WHERE org_id = $1 AND code IN ('OWNER', 'MANAGER', 'RESIDENT')`,
    [orgId]
  );
  const roleMap = Object.fromEntries(rolesRes.rows.map((r) => [r.code, r.id]));

  // Isolated building + OWNER + MANAGER
  const ownP = await adminPool.query(
    `INSERT INTO person (org_id, full_name, phone, email)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [orgId, `Owner W5 ${suffix}`, `0951${suffix.slice(0, 6)}`, `own.w5.${suffix}@resihub.test`]
  );
  cleanup.personIds.push(ownP.rows[0].id);
  const ownRec = await adminPool.query(
    `INSERT INTO owner (org_id, person_id, full_name, phone, email)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [orgId, ownP.rows[0].id, `Owner W5 ${suffix}`, `0951${suffix.slice(0, 6)}`, `own.w5.${suffix}@resihub.test`]
  );
  cleanup.ownerIds.push(ownRec.rows[0].id);

  const bldRes = await adminPool.query(
    `INSERT INTO building (org_id, owner_id, code, name, address)
     VALUES ($1, $2, $3, $4, 'W5 Cron Street') RETURNING id, code`,
    [orgId, ownRec.rows[0].id, `W5B-${suffix.slice(-4)}`, `Tòa W5 ${suffix}`]
  );
  const testBuildingId = bldRes.rows[0].id;
  cleanup.buildingIds.push(testBuildingId);

  const flrRes = await adminPool.query(
    `INSERT INTO floor (building_id, level, name) VALUES ($1, 1, 'Tầng 1') RETURNING id`,
    [testBuildingId]
  );
  const testFloorId = flrRes.rows[0].id;
  cleanup.floorIds.push(testFloorId);

  const mgrP = await adminPool.query(
    `INSERT INTO person (org_id, full_name, phone, email)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [orgId, `Mgr W5 ${suffix}`, `0952${suffix.slice(0, 6)}`, `mgr.w5.${suffix}@resihub.test`]
  );
  cleanup.personIds.push(mgrP.rows[0].id);
  const mgrU = await adminPool.query(
    `INSERT INTO app_user (person_id, password_hash, status) VALUES ($1, $2, 'ACTIVE') RETURNING id`,
    [mgrP.rows[0].id, pwHash]
  );
  const mgrUserId = mgrU.rows[0].id;
  cleanup.userIds.push(mgrUserId);
  await adminPool.query(
    `INSERT INTO user_role (user_id, role_id, building_id) VALUES ($1, $2, $3)`,
    [mgrUserId, roleMap.MANAGER, testBuildingId]
  );

  async function createContractUnit(tag, billingDay, rentAmount = 10000000) {
    const apt = await adminPool.query(
      `INSERT INTO apartment (building_id, floor_id, code, area_m2, base_rent, status)
       VALUES ($1, $2, $3, 50, $4, 'OCCUPIED') RETURNING id, code`,
      [testBuildingId, testFloorId, `${tag}-${suffix.slice(-4)}`, rentAmount]
    );
    cleanup.apartmentIds.push(apt.rows[0].id);

    const p = await adminPool.query(
      `INSERT INTO person (org_id, full_name, phone, email)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [orgId, `Res ${tag} ${suffix}`, `0953${tag.slice(-2)}${suffix.slice(0, 4)}`, `res.${tag.toLowerCase()}.${suffix}@resihub.test`]
    );
    cleanup.personIds.push(p.rows[0].id);
    const u = await adminPool.query(
      `INSERT INTO app_user (person_id, password_hash, status) VALUES ($1, $2, 'ACTIVE') RETURNING id`,
      [p.rows[0].id, pwHash]
    );
    cleanup.userIds.push(u.rows[0].id);
    await adminPool.query(
      `INSERT INTO user_role (user_id, role_id, building_id) VALUES ($1, $2, $3)`,
      [u.rows[0].id, roleMap.RESIDENT, testBuildingId]
    );
    const tRec = await adminPool.query(
      `INSERT INTO tenant (org_id, person_id, type, status) VALUES ($1, $2, 'primary', 'APPROVED') RETURNING id`,
      [orgId, p.rows[0].id]
    );
    cleanup.tenantIds.push(tRec.rows[0].id);

    const ctr = await adminPool.query(
      `INSERT INTO contract (
         building_id, apartment_id, primary_tenant_id,
         start_date, end_date, rent_amount, deposit_amount, billing_day, status
       )
       VALUES ($1, $2, $3, '2027-01-01', '2029-12-31', $4, $4, $5, 'ACTIVE')
       RETURNING id`,
      [testBuildingId, apt.rows[0].id, tRec.rows[0].id, rentAmount, billingDay]
    );
    cleanup.contractIds.push(ctr.rows[0].id);
    return {
      aptId: apt.rows[0].id,
      aptCode: apt.rows[0].code,
      contractId: ctr.rows[0].id,
      tenantId: tRec.rows[0].id,
    };
  }

  const c15 = await createContractUnit('D15', 15, 9000000);
  const c31 = await createContractUnit('D31', 31, 10000000);

  await t.test('1. Short-month & leap-year billing_day cron generation (FR-066, Review Focus #4)', async () => {
    // Leap year Feb 28 (2028-02-28): NOT last day of Feb 2028 -> 0 invoices for billing_day 15 & 31
    const r28 = await runDailyJobs({ asOfDate: '2028-02-28', buildingId: testBuildingId });
    assert.equal(r28.skipped, false);
    const inv28 = await adminPool.query(
      `SELECT * FROM invoice WHERE building_id = $1 AND period = '2028-02'`,
      [testBuildingId]
    );
    assert.equal(inv28.rows.length, 0, 'Feb 28 in leap year 2028 must NOT trigger billing_day 31');

    // Leap year Feb 29 (2028-02-29): last day of Feb 2028 -> generates DRAFT invoice ONLY for billing_day = 31
    const r29 = await runDailyJobs({ asOfDate: '2028-02-29', buildingId: testBuildingId });
    assert.equal(r29.skipped, false);
    const inv29 = await adminPool.query(
      `SELECT * FROM invoice WHERE building_id = $1 AND period = '2028-02'`,
      [testBuildingId]
    );
    assert.equal(inv29.rows.length, 1);
    assert.equal(inv29.rows[0].contract_id, c31.contractId);
    assert.equal(inv29.rows[0].status, 'DRAFT');
    assert.equal(String(inv29.rows[0].issue_date).slice(0, 10), '2028-02-29');

    // Re-running on 2028-02-29 is idempotent (0 new invoices) and logs SUCCEEDED in cron_job_run
    const r29Again = await runDailyJobs({ asOfDate: '2028-02-29', buildingId: testBuildingId });
    assert.equal(r29Again.autoCreatedInvoices, 0);

    const runLog = await adminPool.query(
      `SELECT * FROM cron_job_run WHERE run_date = '2028-02-29' AND status = 'SUCCEEDED' ORDER BY started_at DESC LIMIT 1`
    );
    assert.equal(runLog.rows.length, 1);
    assert.ok(Number(runLog.rows[0].duration_ms) >= 0);
  });

  await t.test('2. AC-015.1 Manager Notification on Cron Skip when active meter lacks CONFIRMED reading', async () => {
    const mRes = await adminPool.query(
      `INSERT INTO meter (org_id, building_id, apartment_id, meter_type, meter_code, unit, unit_price, initial_reading, status, created_at)
       VALUES ($1, $2, $3, 'ELECTRICITY', $4, 'kWh', 3800, 100, 'ACTIVE', '2028-01-01T00:00:00+07:00')
       RETURNING id`,
      [orgId, testBuildingId, c15.aptId, `EL-W5-${suffix}`]
    );
    cleanup.meterIds.push(mRes.rows[0].id);

    const rMar15 = await runDailyJobs({ asOfDate: '2028-03-15', buildingId: testBuildingId });
    assert.equal(rMar15.skipped, false);
    assert.ok(rMar15.skippedMeterContracts >= 1);

    const invMar = await adminPool.query(
      `SELECT * FROM invoice WHERE contract_id = $1 AND period = '2028-03'`,
      [c15.contractId]
    );
    assert.equal(invMar.rows.length, 0, 'Contract missing confirmed meter reading must be skipped');

    const notif1 = await adminPool.query(
      `SELECT * FROM notification
       WHERE user_id = $1 AND type = 'MISSING_METER_READING' AND payload->>'contract_id' = $2`,
      [mgrUserId, c15.contractId]
    );
    assert.equal(notif1.rows.length, 1, 'Building MANAGER must receive 1 MISSING_METER_READING notification');

    // Re-running on 2028-03-15 does NOT duplicate notification
    await runDailyJobs({ asOfDate: '2028-03-15', buildingId: testBuildingId });
    const notif2 = await adminPool.query(
      `SELECT * FROM notification
       WHERE user_id = $1 AND type = 'MISSING_METER_READING' AND payload->>'contract_id' = $2`,
      [mgrUserId, c15.contractId]
    );
    assert.equal(notif2.rows.length, 1, 'MISSING_METER_READING notification must be idempotent');
  });

  await t.test('3. PostgreSQL Advisory Lock (73918205) & 3-Attempt Retry + SYS_ADMIN Alert (PRD 14.5)', async () => {
    assert.equal(DAILY_JOB_ADVISORY_LOCK_KEY, 73918205);

    const lockConn = await adminPool.connect();
    try {
      await lockConn.query('SELECT pg_advisory_lock($1)', [DAILY_JOB_ADVISORY_LOCK_KEY]);
      const lockedRun = await runDailyJobs({ asOfDate: '2028-03-16', buildingId: testBuildingId });
      assert.equal(lockedRun.skipped, true);
      assert.equal(lockedRun.reason, 'LOCK_HELD');
    } finally {
      await lockConn.query('SELECT pg_advisory_unlock($1)', [DAILY_JOB_ADVISORY_LOCK_KEY]).catch(() => {});
      lockConn.release();
    }

    const unlockedRun = await runDailyJobs({ asOfDate: '2028-03-16', buildingId: testBuildingId });
    assert.equal(unlockedRun.skipped, false);

    // Transient failure on attempts 1 & 2 -> succeeds on attempt 3
    let transientCalls = 0;
    const retryOk = await runDailyJobs({
      asOfDate: '2028-03-17',
      buildingId: testBuildingId,
      maxRetries: 3,
      retryDelaysMs: [5, 10, 20],
      stepHookForTest: (attempt) => {
        transientCalls += 1;
        if (attempt < 3) {
          throw new Error(`Simulated transient failure #${attempt}`);
        }
      },
    });
    assert.equal(transientCalls, 3);
    assert.equal(retryOk.skipped, false);
    assert.equal(retryOk.attempts, 3);

    const retryLog = await adminPool.query(
      `SELECT * FROM cron_job_run WHERE run_date = '2028-03-17' ORDER BY started_at DESC LIMIT 1`
    );
    assert.equal(retryLog.rows[0].status, 'SUCCEEDED');
    assert.equal(Number(retryLog.rows[0].attempt_count), 3);

    // Persistent failure across all 3 attempts -> records FAILED in cron_job_run + CRON_JOB_FAILED notification to SYS_ADMIN
    await assert.rejects(
      () =>
        runDailyJobs({
          asOfDate: '2028-03-18',
          buildingId: testBuildingId,
          maxRetries: 3,
          retryDelaysMs: [5, 10, 20],
          stepHookForTest: (attempt) => {
            throw new Error(`Simulated persistent DB outage attempt #${attempt}`);
          },
        }),
      /Simulated persistent DB outage/
    );

    const failLog = await adminPool.query(
      `SELECT * FROM cron_job_run WHERE run_date = '2028-03-18' ORDER BY started_at DESC LIMIT 1`
    );
    assert.equal(failLog.rows[0].status, 'FAILED');
    assert.equal(Number(failLog.rows[0].attempt_count), 3);

    const sysAlert = await adminPool.query(
      `SELECT n.* FROM notification n
       JOIN user_role ur ON ur.user_id = n.user_id
       JOIN role r ON r.id = ur.role_id
       WHERE r.code = 'SYS_ADMIN'
         AND n.type = 'CRON_JOB_FAILED'
         AND n.created_at >= $1::timestamptz`,
      [cleanup.testStartedAt]
    );
    assert.ok(sysAlert.rows.length >= 1, 'SYS_ADMIN must receive CRON_JOB_FAILED system alert');
  });

  await t.test('4. Configurable Late Fee 100.000 ₫/day, Waiver Preservation, Cap & Principal-Settled Stop (FR-064, Review Focus #3)', async () => {
    // Ensure clean default billing_config for late fee test
    await adminPool.query(
      `UPDATE system_setting
       SET value = COALESCE(value, '{}'::jsonb) || '{"late_fee_grace_days": 5, "late_fee_per_day": 100000, "late_fee_cap": null}'::jsonb
       WHERE org_id = $1 AND key = 'billing_config'`,
      [orgId]
    );

    const invRes = await adminPool.query(
      `INSERT INTO invoice (
         org_id, building_id, apartment_id, contract_id, tenant_id,
         invoice_code, period, issue_date, due_date,
         subtotal_amount, adjustment_amount, total_amount, paid_amount, status
       )
       VALUES ($1, $2, $3, $4, $5, $6, '2028-05', '2028-04-26', '2028-05-01', 10000000, 0, 10000000, 0, 'ISSUED')
       RETURNING id`,
      [orgId, testBuildingId, c31.aptId, c31.contractId, c31.tenantId, `INV-LF-${suffix}`]
    );
    const invId = invRes.rows[0].id;
    cleanup.invoiceIds.push(invId);

    await adminPool.query(
      `INSERT INTO invoice_line (invoice_id, item_type, description, quantity, unit, unit_price, amount)
       VALUES ($1, 'RENT', 'Tiền thuê phòng kỳ 2028-05', 1, 'tháng', 10000000, 10000000)`,
      [invId]
    );
    await adminPool.query(
      `INSERT INTO receivable (org_id, building_id, contract_id, tenant_id, invoice_id, type, amount, paid_amount, due_date, status, description)
       VALUES ($1, $2, $3, $4, $5, 'INVOICE_DEBT', 10000000, 0, '2028-05-01', 'OPEN', 'Công nợ kỳ 2028-05')`,
      [orgId, testBuildingId, c31.contractId, c31.tenantId, invId]
    );

    // 4a. asOfDate = 2028-05-06 (overdueDays = 5, within 5 grace days): status -> OVERDUE, late fee = 0
    await runDailyJobs({ asOfDate: '2028-05-06', buildingId: testBuildingId });
    let cur = (await adminPool.query(`SELECT * FROM invoice WHERE id = $1`, [invId])).rows[0];
    assert.equal(cur.status, 'OVERDUE');
    assert.equal(Number(cur.total_amount), 10000000);

    // 4b. asOfDate = 2028-05-09 (overdueDays = 8 -> 3 * 100.000 = 300.000 ₫)
    await runDailyJobs({ asOfDate: '2028-05-09', buildingId: testBuildingId });
    cur = (await adminPool.query(`SELECT * FROM invoice WHERE id = $1`, [invId])).rows[0];
    assert.equal(Number(cur.total_amount), 10300000);
    let rec = (await adminPool.query(`SELECT * FROM receivable WHERE invoice_id = $1`, [invId])).rows[0];
    assert.equal(Number(rec.amount), 10300000);

    // 4c. Simulate approved -200.000 ₫ LATE_FEE waiver -> total = 10.100.000 ₫; run 2028-05-10 -> deltaFee = 100.000 ₫ -> total = 10.200.000 ₫
    await adminPool.query(
      `INSERT INTO invoice_line (invoice_id, item_type, description, quantity, unit, unit_price, amount, formula_meta)
       VALUES ($1, 'ADJUSTMENT', 'Miễn giảm phí phạt chậm', 1, 'lần', -200000, -200000, '{"adjusts_item_type":"LATE_FEE"}'::jsonb)`,
      [invId]
    );
    await adminPool.query(
      `UPDATE invoice SET adjustment_amount = -200000, total_amount = 10100000 WHERE id = $1`,
      [invId]
    );
    await adminPool.query(`UPDATE receivable SET amount = 10100000 WHERE invoice_id = $1`, [invId]);

    await runDailyJobs({ asOfDate: '2028-05-10', buildingId: testBuildingId });
    cur = (await adminPool.query(`SELECT * FROM invoice WHERE id = $1`, [invId])).rows[0];
    assert.equal(Number(cur.total_amount), 10200000, 'Must append only deltaFee = 100.000 ₫, preserving -200.000 ₫ waiver');

    // 4d. Set late_fee_cap = 500000, run 2028-05-25 -> gross LATE_FEE caps at 500.000 ₫ (deltaFee = 100.000 ₫ -> total = 10.300.000 ₫)
    await adminPool.query(
      `UPDATE system_setting
       SET value = COALESCE(value, '{}'::jsonb) || '{"late_fee_cap": 500000}'::jsonb
       WHERE org_id = $1 AND key = 'billing_config'`,
      [orgId]
    );
    await runDailyJobs({ asOfDate: '2028-05-25', buildingId: testBuildingId });
    cur = (await adminPool.query(`SELECT * FROM invoice WHERE id = $1`, [invId])).rows[0];
    assert.equal(Number(cur.total_amount), 10300000, 'Late fee must cap at 500.000 ₫ gross (10.300.000 ₫ net after -200k waiver)');

    // 4e. Tenant pays 10.000.000 ₫ (100% principal settled, 300.000 ₫ net late fee remaining), clear cap, run 2028-05-30 -> deltaFee = 0!
    await adminPool.query(
      `UPDATE invoice SET paid_amount = 10000000, status = 'PARTIALLY_PAID' WHERE id = $1`,
      [invId]
    );
    await adminPool.query(
      `UPDATE system_setting
       SET value = COALESCE(value, '{}'::jsonb) || '{"late_fee_cap": null}'::jsonb
       WHERE org_id = $1 AND key = 'billing_config'`,
      [orgId]
    );
    await runDailyJobs({ asOfDate: '2028-05-30', buildingId: testBuildingId });
    cur = (await adminPool.query(`SELECT * FROM invoice WHERE id = $1`, [invId])).rows[0];
    assert.equal(Number(cur.total_amount), 10300000, 'Must stop accruing late fees once principal is 100% settled (no penalty-on-penalty)');
  });

  await t.test('5. Credit-offset principal stop condition without double counting (Review Important #1, FR-064)', async () => {
    // Subcase A: Header credit_offset_amount = 2.000.000 ₫ + RENT line 10.000.000 ₫ (net receivable 8.000.000 ₫)
    const invARes = await adminPool.query(
      `INSERT INTO invoice (
         org_id, building_id, apartment_id, contract_id, tenant_id,
         invoice_code, period, issue_date, due_date,
         subtotal_amount, adjustment_amount, credit_offset_amount, total_amount, paid_amount, status
       )
       VALUES ($1, $2, $3, $4, $5, $6, '2028-06', '2028-05-26', '2028-06-01', 10000000, 0, 2000000, 8000000, 0, 'ISSUED')
       RETURNING id`,
      [orgId, testBuildingId, c31.aptId, c31.contractId, c31.tenantId, `INV-LF-CRA-${suffix}`]
    );
    const invAId = invARes.rows[0].id;
    cleanup.invoiceIds.push(invAId);

    await adminPool.query(
      `INSERT INTO invoice_line (invoice_id, item_type, description, quantity, unit, unit_price, amount)
       VALUES ($1, 'RENT', 'Tiền thuê phòng kỳ 2028-06', 1, 'tháng', 10000000, 10000000)`,
      [invAId]
    );
    await adminPool.query(
      `INSERT INTO receivable (org_id, building_id, contract_id, tenant_id, invoice_id, type, amount, paid_amount, due_date, status, description)
       VALUES ($1, $2, $3, $4, $5, 'INVOICE_DEBT', 8000000, 0, '2028-06-01', 'OPEN', 'Công nợ kỳ 2028-06')`,
      [orgId, testBuildingId, c31.contractId, c31.tenantId, invAId]
    );

    // 2028-06-08 (overdueDays = 7 -> 200.000 ₫ late fee -> total = 8.200.000 ₫)
    await runDailyJobs({ asOfDate: '2028-06-08', buildingId: testBuildingId });
    let curA = (await adminPool.query(`SELECT * FROM invoice WHERE id = $1`, [invAId])).rows[0];
    assert.equal(Number(curA.total_amount), 8200000);

    // Tenant pays 8.000.000 ₫ cash -> paid_amount (8M) + credit_offset_amount (2M) = 10M >= principal (10M)
    await adminPool.query(
      `UPDATE invoice SET paid_amount = 8000000, status = 'PARTIALLY_PAID' WHERE id = $1`,
      [invAId]
    );
    await runDailyJobs({ asOfDate: '2028-06-12', buildingId: testBuildingId });
    curA = (await adminPool.query(`SELECT * FROM invoice WHERE id = $1`, [invAId])).rows[0];
    assert.equal(
      Number(curA.total_amount),
      8200000,
      'Must recognize paid_amount + credit_offset_amount >= principalAmount and stop accruing late fees'
    );

    // Subcase B: Credit applied via credit_balance + negative ADJUSTMENT line (credit_id IS NOT NULL) must NOT double-count credit
    const cbRes = await adminPool.query(
      `INSERT INTO credit_balance (org_id, building_id, contract_id, tenant_id, amount, applied_amount, status, reason_type, description)
       VALUES ($1, $2, $3, $4, 2000000, 2000000, 'APPLIED', 'OVERPAYMENT', 'Credit test')
       RETURNING id`,
      [orgId, testBuildingId, c15.contractId, c15.tenantId]
    );
    const cbId = cbRes.rows[0].id;

    const invBRes = await adminPool.query(
      `INSERT INTO invoice (
         org_id, building_id, apartment_id, contract_id, tenant_id,
         invoice_code, period, issue_date, due_date,
         subtotal_amount, adjustment_amount, credit_offset_amount, total_amount, paid_amount, status
       )
       VALUES ($1, $2, $3, $4, $5, $6, '2028-06', '2028-05-26', '2028-06-01', 10000000, 0, 2000000, 8000000, 6000000, 'PARTIALLY_PAID')
       RETURNING id`,
      [orgId, testBuildingId, c15.aptId, c15.contractId, c15.tenantId, `INV-LF-CRB-${suffix}`]
    );
    const invBId = invBRes.rows[0].id;
    cleanup.invoiceIds.push(invBId);

    await adminPool.query(
      `INSERT INTO invoice_line (invoice_id, item_type, description, quantity, unit, unit_price, amount)
       VALUES ($1, 'RENT', 'Tiền thuê phòng kỳ 2028-06', 1, 'tháng', 10000000, 10000000)`,
      [invBId]
    );
    await adminPool.query(
      `INSERT INTO invoice_line (invoice_id, item_type, description, quantity, unit, unit_price, amount, credit_id)
       VALUES ($1, 'ADJUSTMENT', 'Bù trừ số dư tín dụng hợp đồng', 1, 'lần', -2000000, -2000000, $2)`,
      [invBId, cbId]
    );

    // Tenant paid only 6M cash + 2M credit = 8M < 10M gross principal -> still owes 2M principal, MUST accrue on 2028-06-08 (200k)
    await runDailyJobs({ asOfDate: '2028-06-08', buildingId: testBuildingId });
    let curB = (await adminPool.query(`SELECT * FROM invoice WHERE id = $1`, [invBId])).rows[0];
    assert.equal(Number(curB.total_amount), 8200000, 'Must not double-count credit_id line and credit_offset_amount when 2M principal remains unpaid');

    // Now tenant pays remaining 2M principal (paid_amount = 8M) -> 8M + 2M = 10M -> stops accruing on 2028-06-12
    await adminPool.query(`UPDATE invoice SET paid_amount = 8000000 WHERE id = $1`, [invBId]);
    await runDailyJobs({ asOfDate: '2028-06-12', buildingId: testBuildingId });
    curB = (await adminPool.query(`SELECT * FROM invoice WHERE id = $1`, [invBId])).rows[0];
    assert.equal(Number(curB.total_amount), 8200000, 'Once 8M cash + 2M credit = 10M gross principal, accrual stops');

    await adminPool.query(`DELETE FROM invoice_line WHERE credit_id = $1`, [cbId]);
    await adminPool.query(`DELETE FROM credit_balance WHERE id = $1`, [cbId]);
  });
});

