import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
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

test('Unit: notificationService enriches missing routing IDs, rewrites legacy links, ignores invalid UUIDs, and scopes org seed rows', async () => {
  const {
    isUuid,
    filterNotificationsSqlClause,
    enrichNotificationsContext,
    notifyBuildingManagers,
    notifyBuildingFourEyesApprovers,
    notifyUser,
  } = await import('../src/services/notificationService.js');

  assert.equal(isUuid('11111111-1111-4111-8111-111111111111'), true);
  assert.equal(isUuid('not-a-uuid'), false);
  assert.equal(isUuid(null), false);

  // Role scoping SQL clause
  const residentClause = filterNotificationsSqlClause(['RESIDENT']);
  assert.match(residentClause, /user_id IS NOT NULL/i);
  assert.match(residentClause, /\/admin%/);
  assert.equal(filterNotificationsSqlClause(['MANAGER']), '');
  assert.equal(filterNotificationsSqlClause(['RESIDENT', 'MANAGER']), '');
  assert.equal(filterNotificationsSqlClause(['OWNER']), '');
  assert.equal(filterNotificationsSqlClause(['SYS_ADMIN']), '');

  const orgId = '00000000-0000-4000-8000-000000000001';
  const ids = {
    payment: '10000000-0000-4000-8000-000000000001',
    invoice: '10000000-0000-4000-8000-000000000002',
    credit: '10000000-0000-4000-8000-000000000003',
    deposit: '10000000-0000-4000-8000-000000000004',
    sr: '10000000-0000-4000-8000-000000000005',
    sub: '10000000-0000-4000-8000-000000000006',
    rsv: '10000000-0000-4000-8000-000000000007',
    contract: '10000000-0000-4000-8000-000000000008',
    tenant: '10000000-0000-4000-8000-000000000009',
    req: '10000000-0000-4000-8000-000000000010',
    building: '20000000-0000-4000-8000-000000000001',
    apartment: '30000000-0000-4000-8000-000000000001',
  };

  const seenQueries = [];
  const mockQueryFn = async (sql, params) => {
    seenQueries.push({ sql, params });
    for (const arr of params.slice(1)) {
      if (Array.isArray(arr)) {
        for (const item of arr) {
          assert.equal(isUuid(item), true, `Non-UUID passed to SQL ANY(): ${item}`);
        }
      }
    }
    if (/FROM payment p/i.test(sql)) {
      return {
        rows: [
          {
            id: ids.payment,
            invoice_id: ids.invoice,
            contract_id: ids.contract,
            building_id: ids.building,
            apartment_id: ids.apartment,
          },
        ],
      };
    }
    if (/FROM invoice i/i.test(sql)) {
      return {
        rows: [
          {
            id: ids.invoice,
            contract_id: ids.contract,
            building_id: ids.building,
            apartment_id: ids.apartment,
          },
        ],
      };
    }
    if (/FROM credit_balance cb/i.test(sql)) {
      return {
        rows: [
          {
            id: ids.credit,
            contract_id: ids.contract,
            building_id: ids.building,
            apartment_id: ids.apartment,
          },
        ],
      };
    }
    if (/FROM deposit d/i.test(sql)) {
      return {
        rows: [
          {
            id: ids.deposit,
            contract_id: ids.contract,
            building_id: ids.building,
            apartment_id: ids.apartment,
          },
        ],
      };
    }
    if (/FROM service_request sr/i.test(sql)) {
      return {
        rows: [
          {
            id: ids.sr,
            contract_id: ids.contract,
            building_id: ids.building,
            apartment_id: ids.apartment,
          },
        ],
      };
    }
    if (/FROM service_subscription ss/i.test(sql)) {
      return {
        rows: [
          {
            id: ids.sub,
            contract_id: ids.contract,
            building_id: ids.building,
            apartment_id: ids.apartment,
          },
        ],
      };
    }
    if (/FROM reservation r/i.test(sql)) {
      return {
        rows: [
          {
            id: ids.rsv,
            building_id: ids.building,
            apartment_id: ids.apartment,
          },
        ],
      };
    }
    if (/FROM contract c/i.test(sql)) {
      return {
        rows: [
          {
            id: ids.contract,
            building_id: ids.building,
            apartment_id: ids.apartment,
          },
        ],
      };
    }
    if (/FROM contract_request cr/i.test(sql)) {
      return {
        rows: [
          {
            id: ids.req,
            contract_id: ids.contract,
            building_id: ids.building,
            apartment_id: ids.apartment,
          },
        ],
      };
    }
    if (/FROM tenant t/i.test(sql)) {
      return {
        rows: [
          {
            id: ids.tenant,
            building_id: ids.building,
            apartment_id: ids.apartment,
          },
        ],
      };
    }
    return { rows: [] };
  };

  const inputRows = [
    { id: 'n1', type: 'PAYMENT_REJECTED', payload: { payment_id: ids.payment } },
    { id: 'n2', type: 'INVOICE_ISSUED', payload: { invoice_id: ids.invoice } },
    { id: 'n3', type: 'CREDIT_REFUNDED', payload: { credit_id: ids.credit } },
    { id: 'n4', type: 'SETTLEMENT_STATEMENT_READY', payload: { deposit_id: ids.deposit } },
    {
      id: 'n5',
      type: 'SERVICE_REQUEST_SLA_BREACH',
      payload: { service_request_id: ids.sr, link: '/admin/service-requests' },
    },
    { id: 'n6', type: 'SERVICE_UPDATE', payload: { subscription_id: ids.sub } },
    { id: 'n7', type: 'RESERVATION_NEW', payload: { reservation_id: ids.rsv } },
    { id: 'n8', type: 'CONTRACT_EXPIRY', payload: { contract_id: ids.contract } },
    { id: 'n9', type: 'CONTRACT_REQUEST_SUBMITTED', payload: { request_id: ids.req } },
    { id: 'n10', type: 'TENANT_APPLICATION', payload: { tenant_id: ids.tenant } },
    {
      id: 'n11',
      type: 'INVOICE_ISSUED',
      payload: { invoice_id: 'bad-id-not-uuid', contract_id: '' },
    },
    { id: 'n12', type: 'SYSTEM', payload: null },
  ];

  const enriched = await enrichNotificationsContext(inputRows, orgId, { queryFn: mockQueryFn });
  assert.equal(enriched.length, inputRows.length);
  assert.equal(enriched[0].payload.invoice_id, ids.invoice);
  assert.equal(enriched[0].payload.contract_id, ids.contract);
  assert.equal(enriched[0].payload.building_id, ids.building);
  assert.equal(enriched[1].payload.contract_id, ids.contract);
  assert.equal(enriched[2].payload.building_id, ids.building);
  assert.equal(enriched[3].payload.contract_id, ids.contract);
  assert.equal(enriched[4].payload.link, '/admin/maintenance');
  assert.equal(enriched[4].payload.contract_id, ids.contract);
  assert.equal(enriched[5].payload.contract_id, ids.contract);
  assert.equal(enriched[6].payload.apartment_id, ids.apartment);
  assert.equal(enriched[7].payload.building_id, ids.building);
  assert.equal(enriched[8].payload.contract_id, ids.contract);
  assert.equal(enriched[9].payload.building_id, ids.building);
  assert.equal(enriched[10].payload.invoice_id, 'bad-id-not-uuid');
  assert.deepEqual(enriched[11].payload, {});

  // Test emitter helpers deduplicate and fall back properly
  const inserts = [];
  const emitQueryFn = async (sql, params) => {
    if (/INSERT INTO notification/i.test(sql)) {
      inserts.push(params);
      return { rows: [] };
    }
    if (/r\.code = 'MANAGER'/i.test(sql)) {
      return { rows: [{ user_id: '40000000-0000-4000-8000-000000000001' }] };
    }
    if (/r\.code = 'OWNER'/i.test(sql)) {
      return { rows: [{ user_id: '50000000-0000-4000-8000-000000000001' }] };
    }
    return { rows: [] };
  };

  const mgrRecipients = await notifyBuildingManagers(
    orgId,
    ids.building,
    { title: 'T1', content: 'C1', type: 'PAYMENT_REPORTED', payload: { payment_id: ids.payment } },
    { queryFn: emitQueryFn }
  );
  assert.deepEqual(mgrRecipients, ['40000000-0000-4000-8000-000000000001']);

  const approverRecipients = await notifyBuildingFourEyesApprovers(
    orgId,
    ids.building,
    '40000000-0000-4000-8000-000000000001',
    { title: 'T2', content: 'C2', type: 'PENDING_CREDIT_REFUND', payload: { credit_id: ids.credit } },
    { queryFn: emitQueryFn }
  );
  assert.deepEqual(approverRecipients, ['50000000-0000-4000-8000-000000000001']);

  const okUser = await notifyUser(
    orgId,
    '60000000-0000-4000-8000-000000000001',
    { title: 'T3', content: 'C3', type: 'CREDIT_REFUND_PENDING', payload: { credit_id: ids.credit } },
    { queryFn: emitQueryFn }
  );
  assert.equal(okUser, true);
  assert.equal(inserts.length, 3);
});

test('Integration: GET /api/v1/notifications hides /admin* org seed rows from pure RESIDENT and enriches INVOICE_ISSUED payload', async () => {
  const localAdminPool = new pg.Pool({
    connectionString: ADMIN_DB_URL,
    options: '-c timezone=Asia/Ho_Chi_Minh',
  });
  const createdNotificationIds = [];

  try {
    const { JWT_SECRET } = await import('../src/config/env.js');
    const { default: notificationsRoute } = await import('../src/routes/notifications.js');

    // Pick an active RESIDENT user who is NOT an admin/manager/owner, and an existing invoice
    const resUserQ = await localAdminPool.query(
      `SELECT au.id AS user_id, p.org_id
       FROM app_user au
       JOIN person p ON p.id = au.person_id
       WHERE au.status = 'ACTIVE'
         AND EXISTS (
           SELECT 1 FROM user_role ur JOIN role r ON r.id = ur.role_id
           WHERE ur.user_id = au.id AND r.code = 'RESIDENT'
         )
         AND NOT EXISTS (
           SELECT 1 FROM user_role ur JOIN role r ON r.id = ur.role_id
           WHERE ur.user_id = au.id AND r.code IN ('SYS_ADMIN', 'OWNER', 'MANAGER')
         )
       LIMIT 1`
    );
    assert.ok(resUserQ.rows.length > 0, 'Expected at least one pure RESIDENT user in DB');
    const { user_id: residentUserId, org_id: orgId } = resUserQ.rows[0];

    const invQ = await localAdminPool.query(
      `SELECT id, contract_id, building_id, apartment_id
       FROM invoice
       WHERE org_id = $1 AND contract_id IS NOT NULL
       LIMIT 1`,
      [orgId]
    );
    assert.ok(invQ.rows.length > 0, 'Expected at least one invoice in org');
    const sampleInv = invQ.rows[0];

    // Insert 1 org-wide /admin seed row (user_id IS NULL) + 1 bare INVOICE_ISSUED row for resident
    const seedIns = await localAdminPool.query(
      `INSERT INTO notification (org_id, user_id, title, content, type, payload)
       VALUES ($1, NULL, 'Test Admin Seed', 'Internal admin seed', 'CONTRACT_EXPIRING', $2)
       RETURNING id`,
      [orgId, JSON.stringify({ link: '/admin/contracts' })]
    );
    createdNotificationIds.push(seedIns.rows[0].id);

    const invNotifIns = await localAdminPool.query(
      `INSERT INTO notification (org_id, user_id, title, content, type, payload)
       VALUES ($1, $2, 'Test Bare Invoice Notif', 'Bare payload test', 'INVOICE_ISSUED', $3)
       RETURNING id`,
      [orgId, residentUserId, JSON.stringify({ invoice_id: sampleInv.id })]
    );
    createdNotificationIds.push(invNotifIns.rows[0].id);

    const app = express();
    app.use(express.json());
    app.use('/api/v1/notifications', notificationsRoute);
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;

    try {
      const residentToken = jwt.sign(
        { sub: residentUserId, org_id: orgId, roles: ['RESIDENT'], role: 'RESIDENT' },
        JWT_SECRET,
        { expiresIn: '10m' }
      );

      const resp = await fetch(`http://127.0.0.1:${port}/api/v1/notifications`, {
        headers: { Authorization: `Bearer ${residentToken}` },
      });
      assert.equal(resp.status, 200);
      const body = await resp.json();

      // 1. Seed row with user_id IS NULL + /admin link MUST NOT appear for pure RESIDENT
      const leakedAdminSeed = body.data.find((n) => n.id === seedIns.rows[0].id);
      assert.equal(leakedAdminSeed, undefined, 'Pure RESIDENT must not see /admin* org seed row');

      // 2. Bare INVOICE_ISSUED row MUST be enriched with contract_id, building_id, apartment_id
      const enrichedInvNotif = body.data.find((n) => n.id === invNotifIns.rows[0].id);
      assert.ok(enrichedInvNotif, 'Expected inserted INVOICE_ISSUED notification in response');
      assert.equal(enrichedInvNotif.payload.contract_id, sampleInv.contract_id);
      assert.equal(enrichedInvNotif.payload.building_id, sampleInv.building_id);
      assert.equal(enrichedInvNotif.payload.apartment_id, sampleInv.apartment_id);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  } finally {
    if (createdNotificationIds.length > 0) {
      await localAdminPool.query(`DELETE FROM notification WHERE id = ANY($1::uuid[])`, [
        createdNotificationIds,
      ]);
    }
    await localAdminPool.end();
    const { adminPool, appPool } = await import('../src/db/client.js');
    await adminPool.end().catch(() => {});
    await appPool.end().catch(() => {});
  }
});
