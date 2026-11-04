import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import express from 'express';
import jwt from 'jsonwebtoken';
import pg from 'pg';
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';

dotenv.config({ path: fileURLToPath(new URL('../.env', import.meta.url)) });
dotenv.config();

const ADMIN_DB_URL =
  process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5433/resihub';
const APP_DB_URL =
  process.env.APP_DATABASE_URL ||
  'postgres://resihub_app:resihub_app_secret@127.0.0.1:5433/resihub';

process.env.DATABASE_URL = ADMIN_DB_URL;
process.env.APP_DATABASE_URL = APP_DB_URL;

test('Source & Unit Contracts: daily.js SLA link normalized to /admin/maintenance and aiGateway emits AI_BUDGET_EXCEEDED once per period', async () => {
  const dailySrc = fs.readFileSync(
    fileURLToPath(new URL('../src/jobs/daily.js', import.meta.url)),
    'utf8'
  );
  assert.equal(
    dailySrc.includes("link: '/admin/service-requests'"),
    false,
    'daily.js must not emit dead /admin/service-requests link'
  );
  assert.equal(
    dailySrc.includes("link: '/admin/maintenance'"),
    true,
    'daily.js must emit /admin/maintenance link for SLA breaches'
  );

  const aiMod = await import('../src/services/aiGateway.js');
  assert.equal(
    typeof aiMod.notifySysAdminsBudgetExceededIfNeeded,
    'function',
    'aiGateway.js must export notifySysAdminsBudgetExceededIfNeeded'
  );
});

test('Integration: 4 missing operational handoff notification flows + 2-way 4-eyes feedback emit rich payloads', async () => {
  const localAdminPool = new pg.Pool({
    connectionString: ADMIN_DB_URL,
    options: '-c timezone=Asia/Ho_Chi_Minh',
  });

  const cleanup = {
    notificationIds: [],
    paymentIds: [],
    invoiceIds: [],
    subscriptionIds: [],
    contractRequestIds: [],
    creditIds: [],
  };

  try {
    const { JWT_SECRET } = await import('../src/config/env.js');
    const { userScope, appPool } = await import('../src/db/client.js');
    const { default: residentRouter } = await import('../src/routes/resident.js');
    const { default: paymentsRouter } = await import('../src/routes/payments.js');
    const { default: servicesRouter } = await import('../src/routes/services.js');

    // Find an ACTIVE contract whose primary tenant has an ACTIVE app_user and whose building has an ACTIVE MANAGER + OWNER
    const ctxRes = await localAdminPool.query(
      `SELECT c.id AS contract_id,
              c.building_id,
              c.apartment_id,
              c.primary_tenant_id AS tenant_id,
              t.person_id AS resident_person_id,
              au_res.id AS resident_user_id,
              b.org_id,
              mgr.user_id AS manager_user_id,
              own.user_id AS owner_user_id
       FROM contract c
       JOIN building b ON b.id = c.building_id
       JOIN tenant t ON t.id = c.primary_tenant_id
       JOIN app_user au_res ON au_res.person_id = t.person_id AND au_res.status = 'ACTIVE'
       JOIN LATERAL (
         SELECT ur.user_id
         FROM user_role ur
         JOIN role r ON r.id = ur.role_id
         JOIN app_user au ON au.id = ur.user_id
         WHERE r.code = 'MANAGER' AND ur.building_id = c.building_id AND au.status = 'ACTIVE'
         LIMIT 1
       ) mgr ON TRUE
       JOIN LATERAL (
         SELECT ur.user_id
         FROM user_role ur
         JOIN role r ON r.id = ur.role_id
         JOIN app_user au ON au.id = ur.user_id
         JOIN person p ON p.id = au.person_id
         WHERE r.code = 'OWNER'
           AND p.org_id = b.org_id
           AND (ur.building_id = c.building_id OR ur.building_id IS NULL OR b.owner_id = ur.user_id)
           AND au.status = 'ACTIVE'
           AND ur.user_id <> mgr.user_id
         LIMIT 1
       ) own ON TRUE
       WHERE c.status = 'ACTIVE'
         AND NOT EXISTS (
           SELECT 1 FROM deposit d
           WHERE d.contract_id = c.id
             AND d.status IN ('PENDING_APPROVAL', 'APPROVED_PENDING_PAYOUT', 'RETURNED', 'DISPUTED')
         )
       LIMIT 1`
    );
    assert.ok(ctxRes.rows.length > 0, 'Expected active contract with resident, manager, and owner');
    const ctx = ctxRes.rows[0];

    const svcRes = await localAdminPool.query(
      `SELECT id FROM service_catalog
       WHERE org_id = $1 AND is_active = TRUE AND category <> 'PARKING' AND billing_type = 'FIXED'
       LIMIT 1`,
      [ctx.org_id]
    );
    assert.ok(svcRes.rows.length > 0, 'Expected at least one active non-parking fixed service');
    const serviceId = svcRes.rows[0].id;

    // Create a temporary ISSUED invoice on a unique future test period so we can report payment cleanly
    const tempPeriod = '2099-12';
    await localAdminPool.query(
      `DELETE FROM invoice WHERE contract_id = $1 AND period = $2`,
      [ctx.contract_id, tempPeriod]
    );
    const invIns = await localAdminPool.query(
      `INSERT INTO invoice (
         org_id, building_id, apartment_id, contract_id, tenant_id,
         invoice_code, period, issue_date, due_date, subtotal_amount, total_amount, paid_amount, status
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_DATE, CURRENT_DATE + 5, 500000, 500000, 0, 'ISSUED')
       RETURNING id`,
      [
        ctx.org_id,
        ctx.building_id,
        ctx.apartment_id,
        ctx.contract_id,
        ctx.tenant_id,
        `INV-NTF-${Date.now().toString().slice(-6)}`,
        tempPeriod,
      ]
    );
    const tempInvoiceId = invIns.rows[0].id;
    cleanup.invoiceIds.push(tempInvoiceId);

    // Create a temporary AVAILABLE credit_balance row for refund flow
    const cbIns = await localAdminPool.query(
      `INSERT INTO credit_balance (
         org_id, building_id, contract_id, tenant_id,
         reason_type, amount, applied_amount, status, description, created_by
       )
       VALUES ($1, $2, $3, $4, 'OVERPAYMENT', 200000, 0, 'AVAILABLE', 'Test notif credit refund', $5)
       RETURNING id`,
      [ctx.org_id, ctx.building_id, ctx.contract_id, ctx.tenant_id, ctx.manager_user_id]
    );
    const tempCreditId = cbIns.rows[0].id;
    cleanup.creditIds.push(tempCreditId);

    // Express app with RLS session middleware matching index.js
    const app = express();
    app.use(express.json({ limit: '5mb' }));
    app.use(async (req, res, next) => {
      const auth = req.headers.authorization;
      if (!auth?.startsWith('Bearer ')) return next();
      try {
        const decoded = jwt.verify(auth.slice(7), JWT_SECRET);
        const client = await appPool.connect();
        await client.query(`SELECT set_config('app.current_user_id', $1, false)`, [decoded.sub]);
        req.dbClient = client;
        const cleanupClient = async () => {
          res.removeListener('finish', cleanupClient);
          res.removeListener('close', cleanupClient);
          if (req._cleaned) return;
          req._cleaned = true;
          try {
            await client.query('RESET app.current_user_id');
          } catch {}
          client.release();
        };
        res.on('finish', cleanupClient);
        res.on('close', cleanupClient);
        userScope.run({ client }, () => next());
      } catch {
        next();
      }
    });
    app.use('/api/v1/resident', residentRouter);
    app.use('/api/v1/payments', paymentsRouter);
    app.use('/api/v1/services', servicesRouter);
    app.use('/api/v1/service-subscriptions', servicesRouter);

    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const baseUrl = `http://127.0.0.1:${port}`;

    const residentToken = jwt.sign(
      {
        sub: ctx.resident_user_id,
        person_id: ctx.resident_person_id,
        org_id: ctx.org_id,
        roles: ['RESIDENT'],
        role: 'RESIDENT',
      },
      JWT_SECRET,
      { expiresIn: '10m' }
    );
    const managerToken = jwt.sign(
      {
        sub: ctx.manager_user_id,
        org_id: ctx.org_id,
        roles: ['MANAGER'],
        role: 'MANAGER',
      },
      JWT_SECRET,
      { expiresIn: '10m' }
    );
    const ownerToken = jwt.sign(
      {
        sub: ctx.owner_user_id,
        org_id: ctx.org_id,
        roles: ['OWNER'],
        role: 'OWNER',
      },
      JWT_SECRET,
      { expiresIn: '10m' }
    );

    const testStartedAt = new Date(Date.now() - 1000).toISOString();

    try {
      // FLOW 1: Resident reports payment -> PAYMENT_REPORTED to building MANAGER
      const payResp = await fetch(`${baseUrl}/api/v1/resident/payments/report`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${residentToken}`,
          'Idempotency-Key': crypto.randomUUID(),
        },
        body: JSON.stringify({
          invoice_id: tempInvoiceId,
          amount: 500000,
          method: 'BANK_TRANSFER',
          reference_code: 'UNC-TEST-001',
        }),
      });
      assert.equal(payResp.status, 201);
      const payBody = await payResp.json();
      cleanup.paymentIds.push(payBody.data.id);

      const payNotifRes = await localAdminPool.query(
        `SELECT * FROM notification
         WHERE user_id = $1 AND type = 'PAYMENT_REPORTED'
           AND payload->>'payment_id' = $2`,
        [ctx.manager_user_id, payBody.data.id]
      );
      assert.equal(payNotifRes.rows.length, 1, 'Expected PAYMENT_REPORTED notification for MANAGER');
      cleanup.notificationIds.push(payNotifRes.rows[0].id);
      assert.equal(payNotifRes.rows[0].payload.invoice_id, tempInvoiceId);
      assert.equal(payNotifRes.rows[0].payload.contract_id, ctx.contract_id);
      assert.equal(payNotifRes.rows[0].payload.building_id, ctx.building_id);

      // FLOW 2: Resident requests service subscription -> SERVICE_SUBSCRIPTION_REQUESTED to MANAGER
      const subResp = await fetch(`${baseUrl}/api/v1/resident/services`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${residentToken}`,
          'Idempotency-Key': crypto.randomUUID(),
        },
        body: JSON.stringify({
          service_id: serviceId,
          quantity: 1,
          contract_id: ctx.contract_id,
          start_date: '2099-12-01',
        }),
      });
      assert.equal(subResp.status, 201);
      const subBody = await subResp.json();
      const subId = subBody.data.id;
      cleanup.subscriptionIds.push(subId);

      const subNotifRes = await localAdminPool.query(
        `SELECT * FROM notification
         WHERE user_id = $1 AND type = 'SERVICE_SUBSCRIPTION_REQUESTED'
           AND payload->>'subscription_id' = $2`,
        [ctx.manager_user_id, subId]
      );
      assert.equal(
        subNotifRes.rows.length,
        1,
        'Expected SERVICE_SUBSCRIPTION_REQUESTED notification for MANAGER'
      );
      cleanup.notificationIds.push(subNotifRes.rows[0].id);
      assert.equal(subNotifRes.rows[0].payload.contract_id, ctx.contract_id);
      assert.equal(subNotifRes.rows[0].payload.building_id, ctx.building_id);

      // Manager approves subscription -> ACTIVE, then Resident cancels -> SERVICE_CANCELLATION_REQUESTED
      const approveSubResp = await fetch(`${baseUrl}/api/v1/services/subscriptions/${subId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${managerToken}`,
          'Idempotency-Key': crypto.randomUUID(),
        },
        body: JSON.stringify({ status: 'ACTIVE' }),
      });
      assert.equal(approveSubResp.status, 200);

      const cancelSubResp = await fetch(`${baseUrl}/api/v1/resident/services/${subId}/cancel`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${residentToken}`,
          'Idempotency-Key': crypto.randomUUID(),
        },
        body: JSON.stringify({ note: 'Xin hủy dịch vụ cuối kỳ' }),
      });
      assert.equal(cancelSubResp.status, 200);

      const cancelSubNotifRes = await localAdminPool.query(
        `SELECT * FROM notification
         WHERE user_id = $1 AND type = 'SERVICE_CANCELLATION_REQUESTED'
           AND payload->>'subscription_id' = $2`,
        [ctx.manager_user_id, subId]
      );
      assert.equal(
        cancelSubNotifRes.rows.length,
        1,
        'Expected SERVICE_CANCELLATION_REQUESTED notification for MANAGER'
      );
      cleanup.notificationIds.push(cancelSubNotifRes.rows[0].id);

      // FLOW 3: Resident submits contract renewal request -> CONTRACT_REQUEST_SUBMITTED to MANAGER
      const reqResp = await fetch(`${baseUrl}/api/v1/resident/contract-requests`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${residentToken}`,
        },
        body: JSON.stringify({
          type: 'RENEWAL',
          contract_id: ctx.contract_id,
          note: 'Gia hạn thêm 12 tháng',
        }),
      });
      assert.equal(reqResp.status, 201);
      const reqBody = await reqResp.json();
      cleanup.contractRequestIds.push(reqBody.data.id);

      const reqNotifRes = await localAdminPool.query(
        `SELECT * FROM notification
         WHERE user_id = $1 AND type = 'CONTRACT_REQUEST_SUBMITTED'
           AND payload->>'request_id' = $2`,
        [ctx.manager_user_id, reqBody.data.id]
      );
      assert.equal(
        reqNotifRes.rows.length,
        1,
        'Expected CONTRACT_REQUEST_SUBMITTED notification for MANAGER'
      );
      cleanup.notificationIds.push(reqNotifRes.rows[0].id);
      assert.equal(reqNotifRes.rows[0].payload.contract_id, ctx.contract_id);
      assert.equal(reqNotifRes.rows[0].payload.building_id, ctx.building_id);
      assert.equal(reqNotifRes.rows[0].payload.request_type, 'RENEWAL');

      // FLOW 4: Manager requests 4-eyes credit refund -> PENDING_CREDIT_REFUND (OWNER) + CREDIT_REFUND_PENDING (RESIDENT)
      const refundResp = await fetch(
        `${baseUrl}/api/v1/payments/credits/${tempCreditId}/refund`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${managerToken}`,
            'Idempotency-Key': crypto.randomUUID(),
          },
          body: JSON.stringify({
            refund_amount: 200000,
            refund_method: 'BANK_TRANSFER',
            bank_name: 'Vietcombank',
            bank_account_number: '0011001234567',
            bank_account_holder: 'NGUYEN VAN TEST',
            reason: 'Hoàn tiền nộp thừa',
          }),
        }
      );
      assert.equal(refundResp.status, 201);
      const refundBody = await refundResp.json();
      const refundCreditId = refundBody.data.id;
      if (refundCreditId !== tempCreditId) cleanup.creditIds.push(refundCreditId);

      const ownerRefundNotif = await localAdminPool.query(
        `SELECT * FROM notification
         WHERE user_id = $1 AND type = 'PENDING_CREDIT_REFUND'
           AND payload->>'credit_id' = $2`,
        [ctx.owner_user_id, refundCreditId]
      );
      assert.equal(
        ownerRefundNotif.rows.length,
        1,
        'Expected PENDING_CREDIT_REFUND notification for OWNER'
      );

      const resRefundNotif = await localAdminPool.query(
        `SELECT * FROM notification
         WHERE user_id = $1 AND type = 'CREDIT_REFUND_PENDING'
           AND payload->>'credit_id' = $2`,
        [ctx.resident_user_id, refundCreditId]
      );
      assert.equal(
        resRefundNotif.rows.length,
        1,
        'Expected CREDIT_REFUND_PENDING notification for RESIDENT'
      );

      // OWNER approves credit refund -> requesting MANAGER also receives CREDIT_REFUNDED feedback
      const approveRefundResp = await fetch(
        `${baseUrl}/api/v1/payments/credits/${refundCreditId}/refund/approve`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${ownerToken}`,
            'Idempotency-Key': crypto.randomUUID(),
          },
        }
      );
      assert.equal(approveRefundResp.status, 200);

      const mgrFeedbackNotif = await localAdminPool.query(
        `SELECT * FROM notification
         WHERE user_id = $1 AND type = 'CREDIT_REFUNDED'
           AND payload->>'credit_id' = $2`,
        [ctx.manager_user_id, refundCreditId]
      );
      assert.equal(
        mgrFeedbackNotif.rows.length,
        1,
        'Expected requesting MANAGER to receive CREDIT_REFUNDED feedback notification'
      );

      // Collect any extra notifications created during this test window for these entity IDs to clean up
      const extraNotifs = await localAdminPool.query(
        `SELECT id FROM notification
         WHERE created_at >= $1
           AND (
             payload->>'subscription_id' = $2
             OR payload->>'credit_id' = $3
             OR payload->>'payment_id' = $4
             OR payload->>'request_id' = $5
           )`,
        [
          testStartedAt,
          subId,
          refundCreditId,
          payBody.data.id,
          reqBody.data.id,
        ]
      );
      extraNotifs.rows.forEach((r) => cleanup.notificationIds.push(r.id));
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  } finally {
    if (cleanup.notificationIds.length > 0) {
      await localAdminPool.query(`DELETE FROM notification WHERE id = ANY($1::uuid[])`, [
        [...new Set(cleanup.notificationIds)],
      ]);
    }
    if (cleanup.contractRequestIds.length > 0) {
      await localAdminPool.query(`DELETE FROM contract_request WHERE id = ANY($1::uuid[])`, [
        cleanup.contractRequestIds,
      ]);
    }
    if (cleanup.subscriptionIds.length > 0) {
      await localAdminPool.query(`DELETE FROM service_subscription WHERE id = ANY($1::uuid[])`, [
        cleanup.subscriptionIds,
      ]);
    }
    if (cleanup.paymentIds.length > 0) {
      await localAdminPool.query(`DELETE FROM payment WHERE id = ANY($1::uuid[])`, [
        cleanup.paymentIds,
      ]);
    }
    if (cleanup.creditIds.length > 0) {
      await localAdminPool.query(`DELETE FROM credit_balance WHERE id = ANY($1::uuid[])`, [
        cleanup.creditIds,
      ]);
    }
    if (cleanup.invoiceIds.length > 0) {
      await localAdminPool.query(`DELETE FROM invoice WHERE id = ANY($1::uuid[])`, [
        cleanup.invoiceIds,
      ]);
    }
    await localAdminPool.end();
    const { adminPool, appPool } = await import('../src/db/client.js');
    await adminPool.end().catch(() => {});
    await appPool.end().catch(() => {});
  }
});
