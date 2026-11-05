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

const TINY_PDF_B64 =
  'data:application/pdf;base64,' +
  Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n', 'ascii').toString('base64');

test('Task 6: Contract 6A Sync, Future Room-Transfer Cutoff, Renewal Credit Carryover, daily.js Billing & FR-039 Reminders', async (t) => {
  const { adminPool, appPool } = await import('../src/db/client.js');
  const { default: authRoute } = await import('../src/routes/auth.js');
  const { default: apartmentsRoute } = await import('../src/routes/apartments.js');
  const { default: contractsRoute } = await import('../src/routes/contracts.js');
  const { default: invoicesRoute, generateInvoicesCore, issueDraftInvoiceInTx, createLateFeeSettlementInvoiceInTx } = await import('../src/routes/invoices.js');
  const { default: depositsRoute, calculateContractOpenDebts } = await import('../src/routes/deposits.js');
  const { default: attachmentsRoute } = await import('../src/routes/attachments.js');
  const { runDailyJobs } = await import('../src/jobs/daily.js');
  const { todayVietnamYmd, currentVietnamPeriod } = await import('../src/services/serviceBilling.js');

  const app = express();
  app.use(cors({ origin: '*', methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'] }));
  app.use(express.json({ limit: '20mb' }));
  app.use('/api/v1/auth', authRoute);
  app.use('/api/v1/apartments', apartmentsRoute);
  app.use('/api/v1/contracts', contractsRoute);
  app.use('/api/v1/invoices', invoicesRoute);
  app.use('/api/v1/deposits', depositsRoute);
  app.use('/api/v1/attachments', attachmentsRoute);

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
    const text = await res.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    return { status: res.status, body };
  }

  async function loginEmail(email, password) {
    const res = await apiFetch('/api/v1/auth/login', null, {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
    assert.equal(res.status, 200, `Login failed for ${email}: ${JSON.stringify(res.body)}`);
    return { token: res.body.accessToken, user: res.body.user };
  }

  const suffix = `${String(Date.now()).slice(-6)}`;
  const cleanup = {
    contractIds: [],
    apartmentIds: [],
    tenantIds: [],
    userRoleIds: [],
    userIds: [],
    personIds: [],
    invoiceIds: [],
    serviceIds: [],
  };

  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    if (cleanup.invoiceIds.length > 0 || cleanup.contractIds.length > 0) {
      await adminPool.query(
        `DELETE FROM audit_log
         WHERE entity = 'late_fee_accrual_tracker'
           AND (
             entity_id IN (
               SELECT id FROM late_fee_accrual_tracker
               WHERE invoice_id = ANY($1::uuid[]) OR contract_id = ANY($2::uuid[])
             )
             OR (after->>'invoice_id') = ANY($3::text[])
           )`,
        [cleanup.invoiceIds, cleanup.contractIds, cleanup.invoiceIds.map(String)]
      ).catch(() => {});
      await adminPool.query(
        `DELETE FROM late_fee_accrual_tracker
         WHERE invoice_id = ANY($1::uuid[]) OR contract_id = ANY($2::uuid[])`,
        [cleanup.invoiceIds, cleanup.contractIds]
      ).catch(() => {});
    }
    for (const invId of cleanup.invoiceIds) {
      await adminPool.query('DELETE FROM invoice_adjustment WHERE invoice_id = $1', [invId]).catch(() => {});
      await adminPool.query('DELETE FROM invoice_line WHERE invoice_id = $1', [invId]).catch(() => {});
      await adminPool.query('DELETE FROM receivable WHERE invoice_id = $1', [invId]).catch(() => {});
      await adminPool.query('DELETE FROM invoice WHERE id = $1', [invId]).catch(() => {});
    }
    for (const cId of [...cleanup.contractIds].reverse()) {
      await adminPool.query('DELETE FROM notification WHERE payload::text LIKE $1', [`%${cId}%`]).catch(() => {});
      await adminPool.query('DELETE FROM credit_balance WHERE contract_id = $1', [cId]).catch(() => {});
      await adminPool.query('DELETE FROM service_subscription WHERE contract_id = $1', [cId]).catch(() => {});
      await adminPool.query('DELETE FROM contract_service_price WHERE contract_id = $1', [cId]).catch(() => {});
      const depClean = await adminPool.connect();
      try {
        await depClean.query('BEGIN');
        await depClean.query("SET LOCAL app.allow_test_cleanup = 'true'");
        await depClean.query(
          `DELETE FROM deposit_transaction WHERE deposit_id IN (SELECT id FROM deposit WHERE contract_id = $1)`,
          [cId]
        );
        await depClean.query('DELETE FROM deposit WHERE contract_id = $1', [cId]);
        await depClean.query('COMMIT');
      } catch {
        await depClean.query('ROLLBACK').catch(() => {});
      } finally {
        depClean.release();
      }
      await adminPool.query("DELETE FROM attachment WHERE owner_entity = 'contract' AND owner_id = $1", [cId]).catch(() => {});
      await adminPool.query('DELETE FROM contract_version WHERE contract_id = $1', [cId]).catch(() => {});
      await adminPool.query('DELETE FROM contract_occupant WHERE contract_id = $1', [cId]).catch(() => {});
      await adminPool.query('UPDATE contract SET parent_contract_id = NULL WHERE parent_contract_id = $1', [cId]).catch(() => {});
      await adminPool.query('DELETE FROM contract WHERE id = $1', [cId]).catch(() => {});
    }
    for (const aId of cleanup.apartmentIds) {
      await adminPool.query('DELETE FROM apartment WHERE id = $1', [aId]).catch(() => {});
    }
    for (const sId of cleanup.serviceIds) {
      await adminPool.query('DELETE FROM service_catalog WHERE id = $1', [sId]).catch(() => {});
    }
    for (const tId of cleanup.tenantIds) {
      await adminPool.query('DELETE FROM tenant WHERE id = $1', [tId]).catch(() => {});
    }
    for (const urId of cleanup.userRoleIds) {
      await adminPool.query('DELETE FROM user_role WHERE id = $1', [urId]).catch(() => {});
    }
    for (const uId of cleanup.userIds) {
      await adminPool.query('DELETE FROM notification WHERE user_id = $1', [uId]).catch(() => {});
      await adminPool.query('DELETE FROM idempotency_key WHERE actor_id = $1', [uId]).catch(() => {});
      await adminPool.query('DELETE FROM user_role WHERE user_id = $1', [uId]).catch(() => {});
      await adminPool.query('DELETE FROM app_user WHERE id = $1', [uId]).catch(() => {});
    }
    for (const pId of cleanup.personIds) {
      await adminPool.query('DELETE FROM person WHERE id = $1', [pId]).catch(() => {});
    }
    await appPool.end().catch(() => {});
    await adminPool.end().catch(() => {});
  });

  // Base building setup
  const bRes = await adminPool.query(
    `SELECT b.id, b.org_id, f.id AS floor_id
     FROM building b
     JOIN floor f ON f.building_id = b.id
     WHERE b.code = 'VOP-A'
     ORDER BY f.level ASC
     LIMIT 1`
  );
  const buildingId = bRes.rows[0].id;
  const orgId = bRes.rows[0].org_id;
  const floorId = bRes.rows[0].floor_id;

  const mgr = await loginEmail('manager.vop.a@resihub.vn', 'Demo@123456');
  const owner = await loginEmail('owner.vop@resihub.vn', 'Demo@123456');

  const pwHash = await bcrypt.hash('Demo@123456', 4);
  const resRoleRes = await adminPool.query(`SELECT id FROM role WHERE org_id = $1 AND code = 'RESIDENT' LIMIT 1`, [orgId]);
  const residentRoleId = resRoleRes.rows[0].id;

  async function createResident(nameTag) {
    const sfx = `${nameTag}-${suffix}-${Math.floor(Math.random() * 9000 + 1000)}`;
    const p = await adminPool.query(
      `INSERT INTO person (org_id, full_name, phone, email, id_number)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [orgId, `Cư Dân ${sfx}`, `0911${sfx.slice(-6)}`, `res.${sfx}@resihub.test`, `079${sfx.slice(-9)}`]
    );
    cleanup.personIds.push(p.rows[0].id);

    const t = await adminPool.query(
      `INSERT INTO tenant (org_id, person_id, type, status)
       VALUES ($1, $2, 'primary', 'APPROVED') RETURNING id`,
      [orgId, p.rows[0].id]
    );
    cleanup.tenantIds.push(t.rows[0].id);

    const u = await adminPool.query(
      `INSERT INTO app_user (person_id, password_hash, status)
       VALUES ($1, $2, 'ACTIVE') RETURNING id`,
      [p.rows[0].id, pwHash]
    );
    cleanup.userIds.push(u.rows[0].id);

    const ur = await adminPool.query(
      `INSERT INTO user_role (user_id, role_id) VALUES ($1, $2) RETURNING id`,
      [u.rows[0].id, residentRoleId]
    );
    cleanup.userRoleIds.push(ur.rows[0].id);

    const auth = await loginEmail(`res.${sfx}@resihub.test`, 'Demo@123456');
    return { personId: p.rows[0].id, tenantId: t.rows[0].id, userId: u.rows[0].id, auth };
  }

  async function createApartment(codePrefix) {
    const aptCode = `${codePrefix}-${suffix}-${Math.floor(Math.random() * 900 + 100)}`;
    const a = await adminPool.query(
      `INSERT INTO apartment (floor_id, building_id, code, base_rent, status)
       VALUES ($1, $2, $3, 10000000, 'AVAILABLE')
       RETURNING id, code`,
      [floorId, buildingId, aptCode]
    );
    cleanup.apartmentIds.push(a.rows[0].id);
    return a.rows[0];
  }

  // Create a shared fixed test service
  const srvRes = await adminPool.query(
    `INSERT INTO service_catalog (org_id, building_id, code, name, category, billing_type, unit, unit_price, is_active)
     VALUES ($1, $2, $3, $4, 'INTERNET', 'FIXED', 'tháng', 200000, true)
     RETURNING id, code`,
    [orgId, buildingId, `WIFI_${suffix}`, `WiFi Siêu Tốc ${suffix}`]
  );
  cleanup.serviceIds.push(srvRes.rows[0].id);
  const wifiServiceId = srvRes.rows[0].id;

  // =========================================================================
  // Test 1: Pre-move-in & mid-month POST /contracts/:id/terminate (6A Sync)
  // =========================================================================
  await t.test('1. Pre-move-in & mid-month POST /contracts/:id/terminate (6A)', async () => {
    const resident = await createResident('T1');
    const apt1 = await createApartment('A1');

    // 1a. Mid-month termination
    // Contract starts 2026-08-01, ends 2026-10-31 (3 months)
    const cRes = await adminPool.query(
      `INSERT INTO contract (
         apartment_id, building_id, primary_tenant_id,
         start_date, end_date, rent_amount, deposit_amount,
         billing_cycle, billing_day, payment_due_days, status, created_by
       )
       VALUES ($1, $2, $3, '2026-08-01', '2026-10-31', 6000000, 6000000, 'monthly', 1, 5, 'ACTIVE', $4)
       RETURNING *`,
      [apt1.id, buildingId, resident.tenantId, mgr.user.sub]
    );
    cleanup.contractIds.push(cRes.rows[0].id);
    const midContract = cRes.rows[0];

    // Add subscription
    const subRes = await adminPool.query(
      `INSERT INTO service_subscription (org_id, building_id, apartment_id, contract_id, service_id, status, start_date, end_date)
       VALUES ($1, $2, $3, $4, $5, 'ACTIVE', '2026-08-01', '2026-10-31')
       RETURNING id`,
      [orgId, buildingId, apt1.id, midContract.id, wifiServiceId]
    );

    // Existing August invoice: ISSUED & PAID (should be preserved!)
    const invAug = await adminPool.query(
      `INSERT INTO invoice (
         org_id, building_id, apartment_id, contract_id, invoice_code, period, status,
         subtotal_amount, total_amount, paid_amount, due_date
       )
       VALUES ($1, $2, $3, $4, $5, '2026-08', 'PAID', 6200000, 6200000, 6200000, '2026-08-05')
       RETURNING id`,
      [orgId, buildingId, apt1.id, midContract.id, `INV-AUG-${suffix}`]
    );
    cleanup.invoiceIds.push(invAug.rows[0].id);

    // Existing September invoice: DRAFT (6,000,000 rent + 200,000 service)
    const invSep = await adminPool.query(
      `INSERT INTO invoice (
         org_id, building_id, apartment_id, contract_id, invoice_code, period, status,
         subtotal_amount, total_amount, paid_amount, due_date
       )
       VALUES ($1, $2, $3, $4, $5, '2026-09', 'DRAFT', 6200000, 6200000, 0, '2026-09-05')
       RETURNING id`,
      [orgId, buildingId, apt1.id, midContract.id, `INV-SEP-${suffix}`]
    );
    cleanup.invoiceIds.push(invSep.rows[0].id);

    await adminPool.query(
      `INSERT INTO invoice_line (invoice_id, item_type, description, quantity, unit, unit_price, amount, subscription_id)
       VALUES ($1, 'RENT', 'Tiền thuê tháng 9', 1, 'tháng', 6000000, 6000000, NULL),
              ($1, 'SERVICE', 'WiFi tháng 9', 1, 'tháng', 200000, 200000, $2)`,
      [invSep.rows[0].id, subRes.rows[0].id]
    );

    // Terminate mid-month on 2026-09-15
    const termRes = await apiFetch(`/api/v1/contracts/${midContract.id}/terminate`, mgr.token, {
      method: 'POST',
      body: JSON.stringify({
        terminated_date: '2026-09-15',
        reason: 'Khách chuyển công tác đột xuất',
      }),
    });
    assert.equal(termRes.status, 200, `Terminate failed: ${JSON.stringify(termRes.body)}`);

    // Verify contract is TERMINATED
    const cCheck = await adminPool.query('SELECT status, terminated_at FROM contract WHERE id = $1', [midContract.id]);
    assert.equal(cCheck.rows[0].status, 'TERMINATED');

    // Verify subscription status is TERMINATED and end_date = 2026-09-15
    const subCheck = await adminPool.query('SELECT status, end_date FROM service_subscription WHERE id = $1', [subRes.rows[0].id]);
    assert.equal(subCheck.rows[0].status, 'TERMINATED');
    assert.equal(String(subCheck.rows[0].end_date).slice(0, 10), '2026-09-15');

    // Verify August invoice is unchanged
    const augCheck = await adminPool.query('SELECT status, total_amount FROM invoice WHERE id = $1', [invAug.rows[0].id]);
    assert.equal(augCheck.rows[0].status, 'PAID');
    assert.equal(Number(augCheck.rows[0].total_amount), 6200000);

    // Verify September DRAFT invoice was synchronized to 15/30 days
    // 15/30 rent = 3,000,000; 15/30 service = 100,000; total = 3,100,000
    const sepCheck = await adminPool.query('SELECT status, total_amount FROM invoice WHERE id = $1', [invSep.rows[0].id]);
    assert.equal(Number(sepCheck.rows[0].total_amount), 3100000, 'Draft invoice for Sept must be prorated to 15 days');

    // 1b. Pre-move-in termination: contract starting in future
    const aptFuture = await createApartment('AF');
    const cFutRes = await adminPool.query(
      `INSERT INTO contract (
         apartment_id, building_id, primary_tenant_id,
         start_date, end_date, rent_amount, deposit_amount,
         billing_cycle, billing_day, payment_due_days, status, created_by
       )
       VALUES ($1, $2, $3, '2027-01-01', '2027-06-30', 5000000, 5000000, 'monthly', 1, 5, 'ACTIVE', $4)
       RETURNING *`,
      [aptFuture.id, buildingId, resident.tenantId, mgr.user.sub]
    );
    cleanup.contractIds.push(cFutRes.rows[0].id);
    const futContract = cFutRes.rows[0];

    const subFut = await adminPool.query(
      `INSERT INTO service_subscription (org_id, building_id, apartment_id, contract_id, service_id, status, start_date, end_date)
       VALUES ($1, $2, $3, $4, $5, 'ACTIVE', '2027-01-01', '2027-06-30')
       RETURNING id`,
      [orgId, buildingId, aptFuture.id, futContract.id, wifiServiceId]
    );

    const todayVn = todayVietnamYmd();
    const termFutRes = await apiFetch(`/api/v1/contracts/${futContract.id}/terminate`, mgr.token, {
      method: 'POST',
      body: JSON.stringify({
        terminated_date: todayVn,
        reason: 'Hủy trước ngày nhận phòng (pre-move-in)',
      }),
    });
    assert.equal(termFutRes.status, 200, `Terminate pre-move-in failed: ${JSON.stringify(termFutRes.body)}`);

    const subFutCheck = await adminPool.query('SELECT status, end_date FROM service_subscription WHERE id = $1', [subFut.rows[0].id]);
    assert.equal(subFutCheck.rows[0].status, 'TERMINATED');
    // Pre-move-in subscription end_date < start_date (e.g. 2026-12-31)
    assert.ok(String(subFutCheck.rows[0].end_date).slice(0, 10) < '2027-01-01', 'Pre-move-in subscription ends before start_date');
  });

  // =========================================================================
  // Test 2: Review Focus #3 future room-transfer pin & early renewal credit carryover
  // =========================================================================
  await t.test('2. Review Focus #3: future room-transfer cutoff (14/30 & 16/30) & renewal credit carryover', async () => {
    const resident = await createResident('T2');
    const aptOld = await createApartment('A2O');
    const aptNew = await createApartment('A2N');

    // 2a. Old contract: start 2028-01-01, end 2028-12-31, rent 10,000,000, deposit 10,000,000
    const oldCRes = await adminPool.query(
      `INSERT INTO contract (
         apartment_id, building_id, primary_tenant_id,
         start_date, end_date, rent_amount, deposit_amount,
         billing_cycle, billing_day, payment_due_days, status, created_by
       )
       VALUES ($1, $2, $3, '2028-01-01', '2028-12-31', 10000000, 10000000, 'monthly', 1, 5, 'ACTIVE', $4)
       RETURNING *`,
      [aptOld.id, buildingId, resident.tenantId, mgr.user.sub]
    );
    cleanup.contractIds.push(oldCRes.rows[0].id);
    const oldContract = oldCRes.rows[0];

    // Deposit HELD on old contract
    await adminPool.query(
      `INSERT INTO deposit (contract_id, amount_held, status)
       VALUES ($1, 10000000, 'HELD')`,
      [oldContract.id]
    );

    // Seed excess credit_balance on old contract: 500,000 AVAILABLE
    const crRes = await adminPool.query(
      `INSERT INTO credit_balance (
         org_id, building_id, contract_id, tenant_id,
         reason_type, amount, applied_amount, status, description, created_by
       )
       VALUES ($1, $2, $3, $4, 'OVERPAYMENT', 500000, 0, 'AVAILABLE', 'Thanh toán thừa kỳ trước', $5)
       RETURNING id`,
      [orgId, buildingId, oldContract.id, resident.tenantId, mgr.user.sub]
    );

    // Room transfer: new_start_date = '2028-06-15', rent = 12,000,000
    const xferRes = await apiFetch(`/api/v1/contracts/${oldContract.id}/transfer-room`, mgr.token, {
      method: 'POST',
      body: JSON.stringify({
        new_apartment_id: aptNew.id,
        new_start_date: '2028-06-15',
        new_end_date: '2028-12-31',
        new_rent_amount: 12000000,
        new_deposit_amount: 10000000,
        transfer_deposit: true,
      }),
    });
    assert.equal(xferRes.status, 201, `Transfer-room draft failed: ${JSON.stringify(xferRes.body)}`);
    const newContractId = xferRes.body.data.new_contract?.id || xferRes.body.data.id;
    cleanup.contractIds.push(newContractId);

    // Upload signed scan
    const scanRes = await apiFetch(`/api/v1/contracts/${newContractId}/scan`, mgr.token, {
      method: 'POST',
      body: JSON.stringify({ file_base64: TINY_PDF_B64 }),
    });
    assert.equal(scanRes.status, 201, `Scan failed: ${JSON.stringify(scanRes.body)}`);

    // Manager activates -> TRANSFER_NEEDS_APPROVAL (409) -> PENDING_APPROVAL
    const actRes = await apiFetch(`/api/v1/contracts/${newContractId}/activate`, mgr.token, {
      method: 'POST',
    });
    assert.equal(actRes.status, 409);
    assert.equal(actRes.body?.code, 'TRANSFER_NEEDS_APPROVAL');

    // Owner approves (running via adminClient at :3336)
    const appRes = await apiFetch(`/api/v1/contracts/${newContractId}/approve`, owner.token, {
      method: 'POST',
    });
    assert.equal(appRes.status, 200, `Owner approve failed: ${JSON.stringify(appRes.body)}`);

    // Review Focus #3: In DB, oldContract.terminated_at was clamped to today (or todayVn)
    const oldDb = await adminPool.query('SELECT status, terminated_at FROM contract WHERE id = $1', [oldContract.id]);
    assert.equal(oldDb.rows[0].status, 'TERMINATED');

    // BUT GET /api/v1/contracts/:oldId shows June 2028 billed for exact 14/30 days!
    const getOldRes = await apiFetch(`/api/v1/contracts/${oldContract.id}`, mgr.token);
    assert.equal(getOldRes.status, 200);
    const juneScheduleOld = getOldRes.body.data.invoice_schedule.find((s) => (s.billing_period || s.period) === '2028-06');
    assert.ok(juneScheduleOld, 'June 2028 must be in oldContract invoice_schedule');
    assert.equal(juneScheduleOld.period_start, '2028-06-01');
    assert.equal(juneScheduleOld.period_end, '2028-06-14');
    assert.equal(juneScheduleOld.expected_rent, 4667000, 'Old contract 14/30 of 10M roundVND = 4,667,000');

    // And POST /api/v1/invoices/generate-batch for old contract bills exact 14/30 days
    const genOldRes = await apiFetch(`/api/v1/invoices/generate-batch`, mgr.token, {
      method: 'POST',
      body: JSON.stringify({ contract_id: oldContract.id, period: '2028-06', allow_missing_meter_readings: true }),
    });
    assert.equal(genOldRes.status, 201, `Generate old failed: ${JSON.stringify(genOldRes.body)}`);
    const invOldJune = genOldRes.body.data[0];
    cleanup.invoiceIds.push(invOldJune.id);
    const oldLinesRes = await adminPool.query('SELECT * FROM invoice_line WHERE invoice_id = $1', [invOldJune.id]);
    const rentOldLine = oldLinesRes.rows.find((l) => l.item_type === 'RENT');
    assert.equal(Number(rentOldLine.amount), 4667000, 'Old contract generated invoice rent line = 4,667,000');

    // Generate batch for new contract for June 2028: bills 16/30 days (15/06–30/06) = 6,400,000
    const genNewRes = await apiFetch(`/api/v1/invoices/generate-batch`, mgr.token, {
      method: 'POST',
      body: JSON.stringify({ contract_id: newContractId, period: '2028-06', allow_missing_meter_readings: true }),
    });
    assert.equal(genNewRes.status, 201, `Generate new failed: ${JSON.stringify(genNewRes.body)}`);
    const invNewJune = genNewRes.body.data[0];
    cleanup.invoiceIds.push(invNewJune.id);
    const newLinesRes = await adminPool.query('SELECT * FROM invoice_line WHERE invoice_id = $1', [invNewJune.id]);
    const rentNewLine = newLinesRes.rows.find((l) => l.item_type === 'RENT');
    assert.equal(Number(rentNewLine.amount), 6400000, 'New contract generated invoice rent line = 6,400,000 (16/30)');
    // Total days billed across old (14) + new (16) = 30/30 days!

    // Verify 500,000 credit was transferred from oldContract to newContract upon room-transfer approval
    const xferCredits = await adminPool.query(
      `SELECT * FROM credit_balance WHERE contract_id = $1 AND reason_type = 'TRANSFERRED_IN'`,
      [newContractId]
    );
    assert.equal(xferCredits.rows.length, 1, 'Credit must be transferred to new contract');
    assert.equal(Number(xferCredits.rows[0].amount), 500000);

    // 2b. Early-activated renewal keeps credit on oldContract while ACTIVE, then transfers when Step 1b expires it
    const aptRenew = await createApartment('ARN');
    const todayVnStr = todayVietnamYmd();
    const renewOld = await adminPool.query(
      `INSERT INTO contract (
         apartment_id, building_id, primary_tenant_id,
         start_date, end_date, rent_amount, deposit_amount,
         billing_cycle, billing_day, payment_due_days, status, created_by
       )
       VALUES ($1, $2, $3, '2026-01-01', '2026-11-20', 10000000, 10000000, 'monthly', 1, 5, 'ACTIVE', $4)
       RETURNING *`,
      [aptRenew.id, buildingId, resident.tenantId, mgr.user.sub]
    );
    cleanup.contractIds.push(renewOld.rows[0].id);

    // Credit on renewOld
    await adminPool.query(
      `INSERT INTO credit_balance (
         org_id, building_id, contract_id, tenant_id,
         reason_type, amount, applied_amount, status, description, created_by
       )
       VALUES ($1, $2, $3, $4, 'OVERPAYMENT', 300000, 0, 'AVAILABLE', 'Dư tiền gia hạn', $5)`,
      [orgId, buildingId, renewOld.rows[0].id, resident.tenantId, mgr.user.sub]
    );

    // Create renewal child contract
    const renewChildRes = await apiFetch(`/api/v1/contracts/${renewOld.rows[0].id}/renew`, mgr.token, {
      method: 'POST',
      body: JSON.stringify({
        new_end_date: '2027-11-20',
        rent_amount: 10000000,
        deposit_amount: 10000000,
      }),
    });
    assert.equal(renewChildRes.status, 201);
    const renewChildId = renewChildRes.body.data.id;
    cleanup.contractIds.push(renewChildId);

    // Scan & activate renewal child while parent is still ACTIVE
    await apiFetch(`/api/v1/contracts/${renewChildId}/scan`, mgr.token, {
      method: 'POST',
      body: JSON.stringify({ file_base64: TINY_PDF_B64 }),
    });
    const renewActRes = await apiFetch(`/api/v1/contracts/${renewChildId}/activate`, mgr.token, {
      method: 'POST',
    });
    assert.equal(renewActRes.status, 200);

    // While renewOld is ACTIVE, renewChild must NOT have received transferred credit
    const childCrPre = await adminPool.query(
      `SELECT * FROM credit_balance WHERE contract_id = $1 AND reason_type = 'TRANSFERRED_IN'`,
      [renewChildId]
    );
    assert.equal(childCrPre.rows.length, 0, 'Renewal child contract does not receive credit while parent is still ACTIVE');

    // Simulate arrival of parent expiry date
    await adminPool.query(
      `UPDATE contract SET end_date = CURRENT_DATE WHERE id = $1`,
      [renewOld.rows[0].id]
    );

    // Run daily jobs Step 1b
    await runDailyJobs();

    // Verify renewOld is now EXPIRED
    const pExpired = await adminPool.query('SELECT status FROM contract WHERE id = $1', [renewOld.rows[0].id]);
    assert.equal(pExpired.rows[0].status, 'EXPIRED');

    // Verify renewChild has now received the 300,000 credit!
    const childCrPost = await adminPool.query(
      `SELECT * FROM credit_balance WHERE contract_id = $1 AND reason_type = 'TRANSFERRED_IN'`,
      [renewChildId]
    );
    assert.equal(childCrPost.rows.length, 1, 'Renewal child contract receives credit after parent expires in Step 1b');
    assert.equal(Number(childCrPost.rows[0].amount), 300000);
  });

  // =========================================================================
  // Test 3: RESIDENT GET /contracts/:id hides DRAFT/VOID (AC-003.2)
  // =========================================================================
  await t.test('3. RESIDENT GET /contracts/:id hides DRAFT and VOID invoices (AC-003.2)', async () => {
    const resident = await createResident('T3');
    const apt = await createApartment('A3');

    const cRes = await adminPool.query(
      `INSERT INTO contract (
         apartment_id, building_id, primary_tenant_id,
         start_date, end_date, rent_amount, deposit_amount,
         billing_cycle, billing_day, payment_due_days, status, created_by
       )
       VALUES ($1, $2, $3, '2026-05-01', '2026-08-31', 5000000, 5000000, 'monthly', 1, 5, 'ACTIVE', $4)
       RETURNING *`,
      [apt.id, buildingId, resident.tenantId, mgr.user.sub]
    );
    cleanup.contractIds.push(cRes.rows[0].id);
    const contract = cRes.rows[0];

    // Seed 1 ISSUED (2026-05), 1 DRAFT (2026-06), 1 VOID (2026-07)
    const inv1 = await adminPool.query(
      `INSERT INTO invoice (org_id, building_id, apartment_id, contract_id, invoice_code, period, status, subtotal_amount, total_amount, due_date)
       VALUES ($1, $2, $3, $4, $5, '2026-05', 'ISSUED', 5000000, 5000000, '2026-05-05') RETURNING id`,
      [orgId, buildingId, apt.id, contract.id, `INV-ISS-${suffix}`]
    );
    cleanup.invoiceIds.push(inv1.rows[0].id);

    const inv2 = await adminPool.query(
      `INSERT INTO invoice (org_id, building_id, apartment_id, contract_id, invoice_code, period, status, subtotal_amount, total_amount, due_date)
       VALUES ($1, $2, $3, $4, $5, '2026-06', 'DRAFT', 5000000, 5000000, '2026-06-05') RETURNING id`,
      [orgId, buildingId, apt.id, contract.id, `INV-DFT-${suffix}`]
    );
    cleanup.invoiceIds.push(inv2.rows[0].id);

    const inv3 = await adminPool.query(
      `INSERT INTO invoice (org_id, building_id, apartment_id, contract_id, invoice_code, period, status, subtotal_amount, total_amount, due_date)
       VALUES ($1, $2, $3, $4, $5, '2026-07', 'VOID', 5000000, 5000000, '2026-07-05') RETURNING id`,
      [orgId, buildingId, apt.id, contract.id, `INV-VOD-${suffix}`]
    );
    cleanup.invoiceIds.push(inv3.rows[0].id);

    // Seed credit balance and pending adjustment
    await adminPool.query(
      `INSERT INTO credit_balance (org_id, building_id, contract_id, tenant_id, reason_type, amount, applied_amount, status, description, created_by)
       VALUES ($1, $2, $3, $4, 'OVERPAYMENT', 150000, 0, 'AVAILABLE', 'Dư 150k', $5)`,
      [orgId, buildingId, contract.id, resident.tenantId, mgr.user.sub]
    );
    await adminPool.query(
      `INSERT INTO invoice_adjustment (org_id, building_id, invoice_id, action_type, adjustment_target, delta_amount, reason, status, created_by)
       VALUES ($1, $2, $3, 'ADJUST', 'RENT', -100000, 'Giảm giá', 'PENDING_APPROVAL', $4)`,
      [orgId, buildingId, inv1.rows[0].id, mgr.user.sub]
    );

    // As MANAGER: can see DRAFT invoice attached to 2026-06
    const mgrRes = await apiFetch(`/api/v1/contracts/${contract.id}`, mgr.token);
    assert.equal(mgrRes.status, 200);
    const mgrSched = mgrRes.body.data.invoice_schedule;
    const mgrJune = mgrSched.find((s) => (s.billing_period || s.period) === '2026-06');
    assert.ok(mgrJune?.actual_invoice, 'Manager sees actual_invoice for DRAFT period');
    assert.equal(mgrJune.actual_invoice.status, 'DRAFT');
    assert.equal(mgrRes.body.data.available_credit_balance, 150000);
    assert.equal(mgrRes.body.data.pending_invoice_adjustments_count, 1);

    // As RESIDENT: DRAFT and VOID invoices are HIDDEN
    const resRes = await apiFetch(`/api/v1/contracts/${contract.id}`, resident.auth.token);
    assert.equal(resRes.status, 200);
    const resSched = resRes.body.data.invoice_schedule;
    const resMay = resSched.find((s) => (s.billing_period || s.period) === '2026-05');
    const resJune = resSched.find((s) => (s.billing_period || s.period) === '2026-06');
    const resJuly = resSched.find((s) => (s.billing_period || s.period) === '2026-07');

    assert.ok(resMay?.actual_invoice, 'Resident sees ISSUED invoice for May');
    assert.equal(resMay.actual_invoice.status, 'ISSUED');
    assert.equal(resJune?.actual_invoice, null, 'Resident CANNOT see DRAFT actual_invoice for June');
    assert.equal(resJuly?.actual_invoice, null, 'Resident CANNOT see VOID actual_invoice for July');
  });

  // =========================================================================
  // Test 4: Review Focus #5 pins: Step 5 excludeSettledDeposits, Steps 6-7 LATE_FEE, Step 8 FR-039
  // =========================================================================
  await t.test('4. Review Focus #5 pins: Step 5 excludeSettledDeposits, Steps 6-7 LATE_FEE & Step 8 debt reminders', async () => {
    const resident = await createResident('T4');
    const aptA = await createApartment('A4A');
    const aptB = await createApartment('A4B');

    const dbNowRes = await adminPool.query(
      `SELECT EXTRACT(DAY FROM CURRENT_DATE)::int AS day_of_month`
    );
    const todayBillingDay = dbNowRes.rows[0].day_of_month;
    const currentPeriod = currentVietnamPeriod();

    // 4a. Step 5: 2 TERMINATED contracts on today's billing_day
    // Contract A: deposit HELD (unsettled) -> MUST be auto-billed
    const cARes = await adminPool.query(
      `INSERT INTO contract (
         apartment_id, building_id, primary_tenant_id,
         start_date, end_date, terminated_at, rent_amount, deposit_amount,
         billing_cycle, billing_day, payment_due_days, status, created_by
       )
       VALUES ($1, $2, $3, '2026-01-01', '2026-12-31', CURRENT_DATE, 4000000, 4000000, 'monthly', $4, 5, 'TERMINATED', $5)
       RETURNING *`,
      [aptA.id, buildingId, resident.tenantId, todayBillingDay, mgr.user.sub]
    );
    cleanup.contractIds.push(cARes.rows[0].id);
    await adminPool.query(
      `INSERT INTO deposit (contract_id, amount_held, status) VALUES ($1, 4000000, 'HELD')`,
      [cARes.rows[0].id]
    );

    // Contract B: deposit REFUNDED (settled) -> MUST be skipped!
    const cBRes = await adminPool.query(
      `INSERT INTO contract (
         apartment_id, building_id, primary_tenant_id,
         start_date, end_date, terminated_at, rent_amount, deposit_amount,
         billing_cycle, billing_day, payment_due_days, status, created_by
       )
       VALUES ($1, $2, $3, '2026-01-01', '2026-12-31', CURRENT_DATE, 4000000, 4000000, 'monthly', $4, 5, 'TERMINATED', $5)
       RETURNING *`,
      [aptB.id, buildingId, resident.tenantId, todayBillingDay, mgr.user.sub]
    );
    cleanup.contractIds.push(cBRes.rows[0].id);
    await adminPool.query(
      `INSERT INTO deposit (contract_id, amount_held, status) VALUES ($1, 0, 'RETURNED')`,
      [cBRes.rows[0].id]
    );

    // 4b. Step 7 & Step 5: Overdue invoice stays immutable (0 LATE_FEE lines on source), accrues in tracker, and carries to T+1 auto-billed invoice
    const invLateRes = await adminPool.query(
      `INSERT INTO invoice (
         org_id, building_id, apartment_id, contract_id, invoice_code, period, status,
         subtotal_amount, total_amount, paid_amount, due_date
       )
       VALUES ($1, $2, $3, $4, $5, '2026-01', 'OVERDUE', 5000000, 5000000, 0, (CURRENT_DATE - INTERVAL '9 days')::date)
       RETURNING id`,
      [orgId, buildingId, cARes.rows[0].apartment_id, cARes.rows[0].id, `INV-LATE-${suffix}`]
    );
    cleanup.invoiceIds.push(invLateRes.rows[0].id);
    const lateInvId = invLateRes.rows[0].id;

    await adminPool.query(
      `INSERT INTO invoice_line (invoice_id, item_type, description, quantity, unit, unit_price, amount, formula_meta)
       VALUES ($1, 'RENT', 'Tiền thuê', 1, 'tháng', 5000000, 5000000, '{}'::jsonb)`,
      [lateInvId]
    );

    // 4c. Step 8: Multi-stage debt reminders (-3, 0, 3, 7, 15)
    // Seed 5 unpaid issued invoices on contract A
    const reminderStages = [
      { offset: -3, code: 'PRE_DUE_3D', period: '2025-01' },
      { offset: 0, code: 'DUE_TODAY', period: '2025-02' },
      { offset: 3, code: 'OVERDUE_3D', period: '2025-03' },
      { offset: 7, code: 'OVERDUE_7D', period: '2025-04' },
      { offset: 15, code: 'OVERDUE_15D', period: '2025-05' },
    ];
    for (const st of reminderStages) {
      const invR = await adminPool.query(
        `INSERT INTO invoice (
           org_id, building_id, apartment_id, contract_id, invoice_code, period, status,
           subtotal_amount, total_amount, paid_amount, due_date
         )
         VALUES ($1, $2, $3, $4, $5, $6, 'ISSUED', 2000000, 2000000, 0, (CURRENT_DATE - ($7 || ' days')::interval)::date)
         RETURNING id`,
        [orgId, buildingId, cARes.rows[0].apartment_id, cARes.rows[0].id, `INV-REM-${st.code}-${suffix}`, st.period, st.offset]
      );
      cleanup.invoiceIds.push(invR.rows[0].id);
    }

    // RUN DAILY JOBS FIRST TIME
    await runDailyJobs();

    // Verification 4a (Step 5): Contract A auto-billed; Contract B skipped!
    const autoInvsA = await adminPool.query(
      `SELECT id FROM invoice WHERE contract_id = $1 AND period = $2`,
      [cARes.rows[0].id, currentPeriod]
    );
    assert.ok(autoInvsA.rows.length >= 1, 'Contract A (HELD deposit) must be auto-billed on billing_day');
    for (const inv of autoInvsA.rows) cleanup.invoiceIds.push(inv.id);

    const autoInvsB = await adminPool.query(
      `SELECT id FROM invoice WHERE contract_id = $1 AND period = $2`,
      [cBRes.rows[0].id, currentPeriod]
    );
    assert.equal(autoInvsB.rows.length, 0, 'Contract B (REFUNDED deposit) must be skipped by excludeSettledDeposits');

    // Verification 4b (Step 7 + Carry-forward):
    // LATE_FEE lines appear on the NEXT invoice (autoInvsA), NOT on the original OVERDUE invoice (lateInvId)
    const lateInvAfter = await adminPool.query(`SELECT total_amount, subtotal_amount FROM invoice WHERE id = $1`, [lateInvId]);
    assert.equal(Number(lateInvAfter.rows[0].total_amount), 5000000, '4b: original OVERDUE invoice total_amount remains immutable');
    const overdueLines = await adminPool.query(
      `SELECT item_type FROM invoice_line WHERE invoice_id = $1 AND item_type = 'LATE_FEE'`,
      [lateInvId]
    );
    assert.equal(overdueLines.rowCount, 0, '4b: no LATE_FEE lines on original OVERDUE invoice');

    const tracker = await adminPool.query(
      `SELECT accrued_total, carried_to_invoice_id FROM late_fee_accrual_tracker WHERE invoice_id = $1`,
      [lateInvId]
    );
    assert.ok(tracker.rowCount > 0, '4b: tracker row exists for OVERDUE invoice');
    assert.equal(Number(tracker.rows[0].accrued_total), 400000, '4b: Day 9 (4 chargeable days) accrued 400,000 in tracker');
    assert.equal(tracker.rows[0].carried_to_invoice_id, autoInvsA.rows[0].id, '4b: tracker carried to auto-generated T+1 invoice');

    const nextLines = await adminPool.query(
      `SELECT il.amount
       FROM invoice_line il
       JOIN invoice i ON i.id = il.invoice_id
       WHERE i.contract_id = $1 AND il.item_type = 'LATE_FEE' AND i.invoice_type = 'REGULAR'`,
      [cARes.rows[0].id]
    );
    assert.ok(nextLines.rowCount >= 1, '4b: LATE_FEE carry-forward line on T+1 invoice');
    assert.ok(Number(nextLines.rows[0].amount) >= 400000, '4b: T+1 carry-forward includes 400,000 from lateInvId');

    // Verification 4c (Step 8):
    // First run emitted exact 1 PAYMENT_REMINDER notification + 1 SEND_DEBT_REMINDER audit_log per stage
    const notifs = await adminPool.query(
      `SELECT payload->>'reminder_stage' AS stage, COUNT(*)::int AS cnt
       FROM notification
       WHERE user_id = $1 AND type = 'PAYMENT_REMINDER'
       GROUP BY payload->>'reminder_stage'`,
      [resident.userId]
    );
    assert.equal(notifs.rows.length, 5, 'Must have 5 distinct reminder stages');
    for (const row of notifs.rows) {
      assert.equal(row.cnt, 1, `Stage ${row.stage} must have exactly 1 notification`);
    }

    const auditDebtLogs = await adminPool.query(
      `SELECT COUNT(*)::int AS cnt FROM audit_log WHERE action = 'SEND_DEBT_REMINDER' AND entity = 'invoice'`
    );
    assert.ok(auditDebtLogs.rows[0].cnt >= 5, 'Must have at least 5 SEND_DEBT_REMINDER audit logs');

    // RUN DAILY JOBS SECOND TIME: 0 duplicates!
    const notifsBefore = await adminPool.query(
      `SELECT COUNT(*)::int AS cnt FROM notification WHERE user_id = $1 AND type = 'PAYMENT_REMINDER'`,
      [resident.userId]
    );
    const auditBefore = await adminPool.query(
      `SELECT COUNT(*)::int AS cnt FROM audit_log WHERE action = 'SEND_DEBT_REMINDER'`
    );

    await runDailyJobs();

    const notifsAfter = await adminPool.query(
      `SELECT COUNT(*)::int AS cnt FROM notification WHERE user_id = $1 AND type = 'PAYMENT_REMINDER'`,
      [resident.userId]
    );
    const auditAfter = await adminPool.query(
      `SELECT COUNT(*)::int AS cnt FROM audit_log WHERE action = 'SEND_DEBT_REMINDER'`
    );

    assert.equal(notifsAfter.rows[0].cnt, notifsBefore.rows[0].cnt, 'Second run of daily jobs must emit 0 duplicate notifications');
    assert.equal(auditAfter.rows[0].cnt, auditBefore.rows[0].cnt, 'Second run of daily jobs must emit 0 duplicate audit logs');
  });

  // =========================================================================
  // Test 5: Bug #1 — calculateContractOpenDebts counts LATE_FEE in serviceDebt
  // =========================================================================
  await t.test('5. calculateContractOpenDebts: LATE_FEE lines counted in serviceDebt not rentDebt', async () => {
    const resident = await createResident('T5LF');
    const apt5 = await createApartment('A5LF');

    const cRes = await adminPool.query(
      `INSERT INTO contract (
         apartment_id, building_id, primary_tenant_id,
         start_date, end_date, rent_amount, deposit_amount,
         billing_cycle, billing_day, payment_due_days, status, created_by
       )
       VALUES ($1, $2, $3, '2026-08-01', '2026-10-31', 5000000, 10000000, 'monthly', 1, 5, 'TERMINATED', $4)
       RETURNING id`,
      [apt5.id, buildingId, resident.tenantId, mgr.user.sub]
    );
    const testContractId = cRes.rows[0].id;
    cleanup.contractIds.push(testContractId);

    const invRes = await adminPool.query(
      `INSERT INTO invoice (
         org_id, building_id, apartment_id, contract_id, tenant_id,
         invoice_code, period, status, subtotal_amount, total_amount, paid_amount, due_date
       )
       VALUES ($1, $2, $3, $4, $5, $6, '2026-10', 'OVERDUE', 5300000, 5300000, 0, '2026-10-05')
       RETURNING id`,
      [orgId, buildingId, apt5.id, testContractId, resident.tenantId, `INV-LF-BUG1-${suffix}`]
    );
    const invId = invRes.rows[0].id;
    cleanup.invoiceIds.push(invId);

    await adminPool.query(
      `INSERT INTO invoice_line (invoice_id, item_type, description, quantity, unit, unit_price, amount)
       VALUES ($1, 'RENT', 'Tiền thuê tháng 10', 1, 'tháng', 5000000, 5000000),
              ($1, 'LATE_FEE', 'Phí phạt chậm thanh toán kỳ trước (dồn sang kỳ này)', 1, 'kỳ', 300000, 300000)`,
      [invId]
    );

    const result = await calculateContractOpenDebts(adminPool, testContractId);
    assert.ok(result.serviceDebt >= 300000, 'LATE_FEE must be counted in serviceDebt');
    assert.equal(result.serviceDebt, 300000, 'serviceDebt must equal 300,000 LATE_FEE');
    assert.equal(result.rentDebt, 5000000, 'rentDebt must only count RENT lines');
  });

  // =========================================================================
  // Tests 5a–5c: Carry-Forward LATE_FEE Lines into New DRAFT in generateInvoicesCore (FR-064)
  // =========================================================================
  {
    const cfResident = await createResident('T5CF');
    const cfApt = await createApartment('A5CF');
    const cfCRes = await adminPool.query(
      `INSERT INTO contract (
         apartment_id, building_id, primary_tenant_id,
         start_date, end_date, rent_amount, deposit_amount,
         billing_cycle, billing_day, payment_due_days, status
       )
       VALUES ($1, $2, $3, '2028-01-01', '2028-12-31', 7000000, 7000000, 'monthly', 1, 5, 'ACTIVE')
       RETURNING id`,
      [cfApt.id, buildingId, cfResident.tenantId]
    );
    const cfContractId = cfCRes.rows[0].id;
    cleanup.contractIds.push(cfContractId);

    const invTRes = await adminPool.query(
      `INSERT INTO invoice (
         org_id, building_id, apartment_id, contract_id, tenant_id,
         invoice_code, period, issue_date, due_date,
         subtotal_amount, adjustment_amount, total_amount, paid_amount, status
       )
       VALUES ($1, $2, $3, $4, $5, $6, '2028-04', '2028-04-01', '2028-04-06', 7000000, 0, 7000000, 0, 'OVERDUE')
       RETURNING id`,
      [orgId, buildingId, cfApt.id, cfContractId, cfResident.tenantId, `INV-202804-${suffix}`]
    );
    const invTId = invTRes.rows[0].id;
    cleanup.invoiceIds.push(invTId);

    await adminPool.query(
      `INSERT INTO invoice_line (invoice_id, item_type, description, quantity, unit, unit_price, amount)
       VALUES ($1, 'RENT', 'Tiền thuê kỳ 2028-04', 1, 'tháng', 7000000, 7000000)`,
      [invTId]
    );
    await adminPool.query(
      `INSERT INTO late_fee_accrual_tracker (org_id, contract_id, invoice_id, accrued_total, chargeable_days, as_of_date)
       VALUES ($1, $2, $3, 300000, 3, '2028-04-14')`,
      [orgId, cfContractId, invTId]
    );

    let invT1Id = null;

    await t.test('5a: generateInvoicesCore carries pending late_fee_accrual_tracker into new DRAFT', async () => {
      const client = await adminPool.connect();
      try {
        await client.query('BEGIN');
        await generateInvoicesCore(client, {
          orgId,
          contractId: cfContractId,
          targetPeriod: '2028-05',
          issueDateYmd: '2028-05-01',
          allowMissingMeterReadings: true,
        });
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }

      const invRes = await adminPool.query(
        `SELECT id, total_amount, subtotal_amount, status FROM invoice WHERE contract_id = $1 AND period = '2028-05'`,
        [cfContractId]
      );
      assert.equal(invRes.rowCount, 1, '5a: 2028-05 DRAFT created');
      invT1Id = invRes.rows[0].id;
      cleanup.invoiceIds.push(invT1Id);
      assert.equal(Number(invRes.rows[0].total_amount), 7300000, '5a: total_amount = 7,000,000 rent + 300,000 carry LATE_FEE');

      const lines = await adminPool.query(
        `SELECT item_type, amount FROM invoice_line il JOIN invoice i ON i.id = il.invoice_id
         WHERE i.contract_id = $1 AND i.period = '2028-05' AND il.item_type = 'LATE_FEE'`,
        [cfContractId]
      );
      assert.equal(lines.rowCount, 1, '5a: carry-forward LATE_FEE line created in T+1');
      assert.equal(Number(lines.rows[0].amount), 300000, '5a: carry-forward amount = tracker accrued_total');

      const tracker = await adminPool.query(
        `SELECT carried_to_invoice_id FROM late_fee_accrual_tracker WHERE contract_id = $1 AND carried_to_invoice_id IS NOT NULL`,
        [cfContractId]
      );
      assert.equal(tracker.rowCount, 1, '5a: tracker.carried_to_invoice_id set');
      assert.equal(tracker.rows[0].carried_to_invoice_id, invT1Id, '5a: carried_to_invoice_id points to T+1 invoice');
    });

    await t.test('5b: generateInvoicesCore does not carry again if tracker already carried', async () => {
      const client = await adminPool.connect();
      try {
        await client.query('BEGIN');
        await generateInvoicesCore(client, {
          orgId,
          buildingId,
          targetPeriod: '2028-05',
          issueDateYmd: '2028-05-01',
          allowMissingMeterReadings: true,
        });
        await generateInvoicesCore(client, {
          orgId,
          contractId: cfContractId,
          targetPeriod: '2028-05',
          issueDateYmd: '2028-05-01',
          allowMissingMeterReadings: true,
        });
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }

      const lines = await adminPool.query(
        `SELECT COUNT(*)::int AS cnt, COALESCE(SUM(il.amount), 0)::bigint AS sum_amt
         FROM invoice_line il JOIN invoice i ON i.id = il.invoice_id
         WHERE i.contract_id = $1 AND i.period = '2028-05' AND il.item_type = 'LATE_FEE'`,
        [cfContractId]
      );
      assert.equal(Number(lines.rows[0].cnt), 1, '5b: no duplicate LATE_FEE line on re-run');
      assert.equal(Number(lines.rows[0].sum_amt), 300000, '5b: carried LATE_FEE remains 300,000');
    });

    await t.test('5c: rolling carry-forward — T+2 invoice gets T+1 accrual (not T, already carried)', async () => {
      const client = await adminPool.connect();
      try {
        await client.query('BEGIN');
        await issueDraftInvoiceInTx(client, { invoiceId: invT1Id, dueDate: '2028-05-06' });
        await client.query(`UPDATE invoice SET status = 'OVERDUE' WHERE id = $1`, [invT1Id]);
        await client.query(
          `INSERT INTO late_fee_accrual_tracker (org_id, contract_id, invoice_id, accrued_total, chargeable_days, as_of_date)
           VALUES ($1, $2, $3, 200000, 2, '2028-05-13')`,
          [orgId, cfContractId, invT1Id]
        );

        await generateInvoicesCore(client, {
          orgId,
          contractId: cfContractId,
          targetPeriod: '2028-06',
          issueDateYmd: '2028-06-01',
          allowMissingMeterReadings: true,
        });
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }

      const lines = await adminPool.query(
        `SELECT il.amount, i.id AS inv_id, i.total_amount
         FROM invoice_line il JOIN invoice i ON i.id = il.invoice_id
         WHERE i.contract_id = $1 AND i.period = '2028-06' AND il.item_type = 'LATE_FEE'`,
        [cfContractId]
      );
      assert.equal(lines.rowCount, 1, '5c: T+2 has LATE_FEE carry from T+1 only');
      cleanup.invoiceIds.push(lines.rows[0].inv_id);
      assert.equal(Number(lines.rows[0].amount), 200000, '5c: amount = T+1 tracker accrued (not T, already carried)');
      assert.equal(Number(lines.rows[0].total_amount), 7200000, '5c: T+2 total = 7,000,000 rent + 200,000 T+1 late fee');
    });
  }

  // =========================================================================
  // Tests 6b & 6c: 4-eyes LATE_FEE waiver on T+1 (with credit_offset Bug#2) & LATE_FEE_SETTLEMENT
  // =========================================================================
  await t.test('6b: 4-eyes LATE_FEE waiver approved on T+1 invoice correctly adjusts total (Bug#2 fix)', async () => {
    const res6b = await createResident('T6B');
    const apt6b = await createApartment('A6B');
    const cRes = await adminPool.query(
      `INSERT INTO contract (
         apartment_id, building_id, primary_tenant_id,
         start_date, end_date, rent_amount, deposit_amount,
         billing_cycle, billing_day, payment_due_days, status
       )
       VALUES ($1, $2, $3, '2028-01-01', '2028-12-31', 10000000, 10000000, 'monthly', 1, 5, 'ACTIVE')
       RETURNING id`,
      [apt6b.id, buildingId, res6b.tenantId]
    );
    const c6bId = cRes.rows[0].id;
    cleanup.contractIds.push(c6bId);

    const cbRes = await adminPool.query(
      `INSERT INTO credit_balance (org_id, building_id, contract_id, tenant_id, amount, applied_amount, status, reason_type, description)
       VALUES ($1, $2, $3, $4, 200000, 200000, 'APPLIED', 'OVERPAYMENT', 'Credit 200k for 6b')
       RETURNING id`,
      [orgId, buildingId, c6bId, res6b.tenantId]
    );
    const cb6bId = cbRes.rows[0].id;

    // T+1 invoice: subtotal = 10,300,000 (10,000,000 RENT + 300,000 carry LATE_FEE), credit_offset_amount = 200,000 -> total = 10,100,000
    const invRes = await adminPool.query(
      `INSERT INTO invoice (
         org_id, building_id, apartment_id, contract_id, tenant_id,
         invoice_code, period, issue_date, due_date,
         subtotal_amount, adjustment_amount, credit_offset_amount, total_amount, paid_amount, status
       )
       VALUES ($1, $2, $3, $4, $5, $6, '2028-07', '2028-07-01', '2028-07-06', 10300000, 0, 200000, 10100000, 0, 'ISSUED')
       RETURNING id`,
      [orgId, buildingId, apt6b.id, c6bId, res6b.tenantId, `INV-6B-${suffix}`]
    );
    const t1InvoiceId = invRes.rows[0].id;
    cleanup.invoiceIds.push(t1InvoiceId);

    await adminPool.query(
      `INSERT INTO invoice_line (invoice_id, item_type, description, quantity, unit, unit_price, amount, credit_id, formula_meta)
       VALUES ($1, 'RENT', 'Tiền thuê 2028-07', 1, 'tháng', 10000000, 10000000, NULL, '{}'::jsonb),
              ($1, 'LATE_FEE', 'Phí phạt kỳ trước dồn sang', 1, 'kỳ', 300000, 300000, NULL, '{"carry_forward": true}'::jsonb),
              ($1, 'ADJUSTMENT', 'Bù trừ tín dụng 200k', 1, 'lần', -200000, -200000, $2, '{}'::jsonb)`,
      [t1InvoiceId, cb6bId]
    );
    await adminPool.query(
      `INSERT INTO receivable (org_id, building_id, contract_id, tenant_id, invoice_id, type, amount, paid_amount, due_date, status, description)
       VALUES ($1, $2, $3, $4, $5, 'INVOICE_DEBT', 10100000, 0, '2028-07-06', 'OPEN', 'Công nợ 6b')`,
      [orgId, buildingId, c6bId, res6b.tenantId, t1InvoiceId]
    );

    const createAdj = await apiFetch(`/api/v1/invoices/${t1InvoiceId}/adjust`, mgr.token, {
      method: 'POST',
      body: JSON.stringify({
        adjustment_target: 'LATE_FEE',
        action_type: 'WAIVE',
        delta_amount: -300000,
        reason: 'Miễn giảm toàn bộ 300k phí phạt dồn kỳ cho cư dân',
      }),
    });
    assert.equal(createAdj.status, 201, `6b create adjustment failed: ${JSON.stringify(createAdj.body)}`);
    const adjId = createAdj.body.data.id;

    const approveAdj = await apiFetch(`/api/v1/invoices/${t1InvoiceId}/adjustments/${adjId}/approve`, owner.token, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    assert.equal(approveAdj.status, 200, `6b approve adjustment failed: ${JSON.stringify(approveAdj.body)}`);

    const after = await adminPool.query(`SELECT total_amount, credit_offset_amount FROM invoice WHERE id = $1`, [t1InvoiceId]);
    assert.equal(Number(after.rows[0].total_amount), 9800000, '6b: Bug#2 fix — credit_offset deducted from new total (9,800,000)');
    assert.equal(Number(after.rows[0].credit_offset_amount), 200000, '6b: credit_offset_amount preserved');

    const afterRec = await adminPool.query(`SELECT amount FROM receivable WHERE invoice_id = $1`, [t1InvoiceId]);
    assert.equal(Number(afterRec.rows[0].amount), 9800000, '6b: receivable updated to 9,800,000');
  });

  await t.test('6c: 4-eyes LATE_FEE waiver on LATE_FEE_SETTLEMENT invoice reduces receivable', async () => {
    const res6c = await createResident('T6C');
    const apt6c = await createApartment('A6C');
    const cRes = await adminPool.query(
      `INSERT INTO contract (
         apartment_id, building_id, primary_tenant_id,
         start_date, end_date, rent_amount, deposit_amount,
         billing_cycle, billing_day, payment_due_days, status
       )
       VALUES ($1, $2, $3, '2028-01-01', '2028-06-30', 8000000, 8000000, 'monthly', 1, 5, 'EXPIRED')
       RETURNING id`,
      [apt6c.id, buildingId, res6c.tenantId]
    );
    const c6cId = cRes.rows[0].id;
    cleanup.contractIds.push(c6cId);

    const srcInvRes = await adminPool.query(
      `INSERT INTO invoice (
         org_id, building_id, apartment_id, contract_id, tenant_id,
         invoice_code, period, issue_date, due_date,
         subtotal_amount, adjustment_amount, total_amount, paid_amount, status
       )
       VALUES ($1, $2, $3, $4, $5, $6, '2028-06', '2028-06-01', '2028-06-06', 8000000, 0, 8000000, 0, 'OVERDUE')
       RETURNING id`,
      [orgId, buildingId, apt6c.id, c6cId, res6c.tenantId, `INV-6CSRC-${suffix}`]
    );
    const srcInvId = srcInvRes.rows[0].id;
    cleanup.invoiceIds.push(srcInvId);

    const trRes = await adminPool.query(
      `INSERT INTO late_fee_accrual_tracker (org_id, contract_id, invoice_id, accrued_total, chargeable_days, as_of_date)
       VALUES ($1, $2, $3, 300000, 3, '2028-06-14')
       RETURNING id`,
      [orgId, c6cId, srcInvId]
    );
    const trId = trRes.rows[0].id;

    let settlementInvId;
    const txClient = await adminPool.connect();
    try {
      await txClient.query('BEGIN');
      const sInv = await createLateFeeSettlementInvoiceInTx(txClient, {
        contractId: c6cId,
        orgId,
        buildingId,
        apartmentId: apt6c.id,
        tenantId: res6c.tenantId,
        totalAccrual: 300000,
        sourceTrackerIds: [trId],
        effectiveDateYmd: '2028-07-02',
      });
      settlementInvId = sInv.id;
      await txClient.query(
        `UPDATE late_fee_accrual_tracker SET carried_to_invoice_id = $1, carried_at = NOW() WHERE id = $2`,
        [settlementInvId, trId]
      );
      await txClient.query('COMMIT');
    } catch (e) {
      await txClient.query('ROLLBACK');
      throw e;
    } finally {
      txClient.release();
    }
    cleanup.invoiceIds.push(settlementInvId);

    const createAdj = await apiFetch(`/api/v1/invoices/${settlementInvId}/adjust`, mgr.token, {
      method: 'POST',
      body: JSON.stringify({
        adjustment_target: 'LATE_FEE',
        action_type: 'WAIVE',
        delta_amount: -100000,
        reason: 'Giảm 100k phí phạt tất toán kỳ cuối',
      }),
    });
    assert.equal(createAdj.status, 201, `6c create adjustment failed: ${JSON.stringify(createAdj.body)}`);
    const adjId = createAdj.body.data.id;

    const approveAdj = await apiFetch(`/api/v1/invoices/${settlementInvId}/adjustments/${adjId}/approve`, owner.token, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    assert.equal(approveAdj.status, 200, `6c approve adjustment failed: ${JSON.stringify(approveAdj.body)}`);

    const afterInv = await adminPool.query(`SELECT total_amount FROM invoice WHERE id = $1`, [settlementInvId]);
    assert.equal(Number(afterInv.rows[0].total_amount), 200000, '6c: settlement invoice total reduced to 200,000');
    const afterRec = await adminPool.query(`SELECT amount FROM receivable WHERE invoice_id = $1`, [settlementInvId]);
    assert.equal(Number(afterRec.rows[0].amount), 200000, '6c: receivable reduced to 200,000');
    const afterTr = await adminPool.query(`SELECT carried_to_invoice_id FROM late_fee_accrual_tracker WHERE id = $1`, [trId]);
    assert.equal(afterTr.rows[0].carried_to_invoice_id, settlementInvId, '6c: tracker.carried_to_invoice_id unchanged');
  });
});
