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
  const { default: invoicesRoute } = await import('../src/routes/invoices.js');
  const { default: depositsRoute } = await import('../src/routes/deposits.js');
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

    // 4b. Step 7: LATE_FEE append-only & waiver preservation across Day 8 -> Day 9
    // Due 8 days ago (penalty 8 - 5 = 3 days -> 300,000)
    const invLateRes = await adminPool.query(
      `INSERT INTO invoice (
         org_id, building_id, apartment_id, contract_id, invoice_code, period, status,
         subtotal_amount, total_amount, paid_amount, due_date
       )
       VALUES ($1, $2, $3, $4, $5, '2026-01', 'OVERDUE', 5100000, 5100000, 0, (CURRENT_DATE - INTERVAL '8 days')::date)
       RETURNING id`,
      [orgId, buildingId, cARes.rows[0].apartment_id, cARes.rows[0].id, `INV-LATE-${suffix}`]
    );
    cleanup.invoiceIds.push(invLateRes.rows[0].id);
    const lateInvId = invLateRes.rows[0].id;

    await adminPool.query(
      `INSERT INTO invoice_line (invoice_id, item_type, description, quantity, unit, unit_price, amount, formula_meta)
       VALUES ($1, 'RENT', 'Tiền thuê', 1, 'tháng', 5000000, 5000000, '{}'::jsonb),
              ($1, 'LATE_FEE', 'Phạt chậm nộp ngày thứ 8', 3, 'ngày', 100000, 300000, '{}'::jsonb),
              ($1, 'ADJUSTMENT', 'Miễn giảm phạt chậm (FR-064)', 1, 'lần', -200000, -200000,
               jsonb_build_object('adjusts_item_type', 'LATE_FEE'))`,
      [lateInvId]
    );

    // Now advance due_date to 9 days ago (Day 9 -> expected fee = 4 days = 400,000, delta = 100,000)
    await adminPool.query(
      `UPDATE invoice SET due_date = (CURRENT_DATE - INTERVAL '9 days')::date WHERE id = $1`,
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

    // Verification 4b (Step 7):
    // Preserves -200,000 waiver across Day 8 -> Day 9: deltaFee = 100,000 appended
    const lateLines = await adminPool.query(
      `SELECT item_type, amount FROM invoice_line WHERE invoice_id = $1 ORDER BY id ASC`,
      [lateInvId]
    );
    const waiverLine = lateLines.rows.find((l) => l.item_type === 'ADJUSTMENT' && Number(l.amount) === -200000);
    assert.ok(waiverLine, 'Waiver adjustment line of -200,000 must be preserved');
    const lateFeeLines = lateLines.rows.filter((l) => l.item_type === 'LATE_FEE');
    assert.equal(lateFeeLines.length, 2, 'Must have original 300,000 + appended 100,000 late fee line');
    const totalLateFee = lateFeeLines.reduce((s, l) => s + Number(l.amount), 0);
    assert.equal(totalLateFee, 400000, 'Total gross late fee = 400,000');

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
});
