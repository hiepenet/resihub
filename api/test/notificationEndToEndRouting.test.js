import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { enrichNotificationsContext } from '../src/services/notificationService.js';
import { resolveNotificationAction } from '../../frontend/src/utils/notificationNavigation.js';

dotenv.config({ path: fileURLToPath(new URL('../.env', import.meta.url)) });
dotenv.config();

const ADMIN_DB_URL =
  process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5433/resihub';
const adminPool = new pg.Pool({ connectionString: ADMIN_DB_URL });

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

function readRel(relPath) {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

test.after(async () => {
  await adminPool.end().catch(() => {});
});

test('ContractsPage, ContractDetailPage, ApartmentDetailPage, and TenantDetailPage auto-open deep-link modals and clean URL', () => {
  const contractsSrc = readRel('frontend/src/pages/admin/contracts/ContractsPage.jsx');
  assert.match(contractsSrc, /stripNotificationTriggerParams/, 'ContractsPage must strip trigger params');
  assert.match(contractsSrc, /request_id/, 'ContractsPage must consume request_id');
  assert.match(contractsSrc, /reviewRequestTarget/, 'ContractsPage must render Contract Request Review Modal');
  assert.match(contractsSrc, /replace:\s*true/, 'ContractsPage must clean URL with replace: true');

  const detailSrc = readRel('frontend/src/pages/admin/contracts/ContractDetailPage.jsx');
  assert.match(detailSrc, /stripNotificationTriggerParams/, 'ContractDetailPage must strip trigger params');
  assert.match(detailSrc, /modal\s*===\s*['"]auto['"]/, 'ContractDetailPage must consume modal=auto');
  assert.match(detailSrc, /approvalReviewOpen/, 'ContractDetailPage must render Approval / Summary Review Modal');
  assert.match(detailSrc, /replace:\s*true/, 'ContractDetailPage must clean URL with replace: true');

  const aptSrc = readRel('frontend/src/pages/admin/apartments/ApartmentDetailPage.jsx');
  assert.match(aptSrc, /stripNotificationTriggerParams/, 'ApartmentDetailPage must strip trigger params');
  assert.match(aptSrc, /reservation_id/, 'ApartmentDetailPage must consume reservation_id');
  assert.match(aptSrc, /reviewReservationModal/, 'ApartmentDetailPage must render Reservation Proof / Detail Modal');
  assert.match(aptSrc, /replace:\s*true/, 'ApartmentDetailPage must clean URL with replace: true');

  const tenantSrc = readRel('frontend/src/pages/admin/tenants/TenantDetailPage.jsx');
  assert.match(tenantSrc, /stripNotificationTriggerParams/, 'TenantDetailPage must strip trigger params');
  assert.match(tenantSrc, /modal\s*===\s*['"]approval['"]/, 'TenantDetailPage must consume modal=approval');
  assert.match(tenantSrc, /applicationReviewOpen/, 'TenantDetailPage must render Tenant Application / Identity Review Modal');
  assert.match(tenantSrc, /replace:\s*true/, 'TenantDetailPage must clean URL with replace: true');
});

test('End-to-end DB enrichment -> resolveNotificationAction routes all 4 new operational handoffs across all 4 roles', async () => {
  const { rows: contractRows } = await adminPool.query(
    `SELECT c.id AS contract_id, c.apartment_id, c.building_id, b.org_id, a.code AS apartment_code
       FROM contract c
       JOIN building b ON b.id = c.building_id
       JOIN apartment a ON a.id = c.apartment_id
      LIMIT 1`
  );
  assert.ok(contractRows.length > 0, 'Seeded contract fixture must exist');
  const fx = contractRows[0];

  const fakePayId = '00000000-0000-4000-8000-000000000901';
  const fakeInvId = '00000000-0000-4000-8000-000000000902';
  const fakeSubId = '00000000-0000-4000-8000-000000000903';
  const fakeReqId = '00000000-0000-4000-8000-000000000904';
  const fakeCreditId = '00000000-0000-4000-8000-000000000905';

  // Legacy-sparse notifications (only contract_id + entity id) to prove backend enrichment + frontend resolver work end-to-end
  const rawList = [
    {
      id: 'notif-pay-rep',
      type: 'PAYMENT_REPORTED',
      payload: { payment_id: fakePayId, invoice_id: fakeInvId, contract_id: fx.contract_id },
    },
    {
      id: 'notif-svc-sub',
      type: 'SERVICE_SUBSCRIPTION_REQUESTED',
      payload: { subscription_id: fakeSubId, contract_id: fx.contract_id },
    },
    {
      id: 'notif-cnt-req',
      type: 'CONTRACT_REQUEST_SUBMITTED',
      payload: { request_id: fakeReqId, contract_id: fx.contract_id },
    },
    {
      id: 'notif-crd-ref',
      type: 'PENDING_CREDIT_REFUND',
      payload: { credit_id: fakeCreditId, contract_id: fx.contract_id },
    },
    {
      id: 'notif-crd-res',
      type: 'CREDIT_REFUND_PENDING',
      payload: { credit_id: fakeCreditId, contract_id: fx.contract_id },
    },
    {
      id: 'notif-meter',
      type: 'MISSING_METER_READING',
      payload: { period: '2026-11', contract_id: fx.contract_id },
    },
    {
      id: 'notif-ai-cap',
      type: 'AI_BUDGET_EXCEEDED',
      payload: { period: '2026-11' },
    },
  ];

  const enriched = await enrichNotificationsContext(rawList, fx.org_id, {
    queryFn: (sql, params) => adminPool.query(sql, params),
  });
  assert.equal(enriched.length, rawList.length);

  const byId = Object.fromEntries(enriched.map((n) => [n.id, n]));
  assert.equal(String(byId['notif-pay-rep'].payload.building_id), String(fx.building_id));
  assert.equal(String(byId['notif-pay-rep'].payload.apartment_id), String(fx.apartment_id));

  // 1. PAYMENT_REPORTED -> MANAGER & OWNER open payment review modal, buildingId synced
  for (const role of ['MANAGER', 'OWNER', 'SYS_ADMIN']) {
    const act = resolveNotificationAction(byId['notif-pay-rep'], { role });
    assert.equal(act.kind, 'navigate');
    assert.equal(String(act.buildingId), String(fx.building_id));
    assert.equal(act.url, `/admin/payments?tab=transactions&payment_id=${fakePayId}&modal=review`);
  }

  // 2. SERVICE_SUBSCRIPTION_REQUESTED -> MANAGER & OWNER open subscription review modal; RESIDENT opens service detail modal
  const mgrSvc = resolveNotificationAction(byId['notif-svc-sub'], { role: 'MANAGER' });
  assert.equal(mgrSvc.url, `/admin/services/subscriptions?subscription_id=${fakeSubId}&modal=review`);
  assert.equal(String(mgrSvc.buildingId), String(fx.building_id));

  const resSvc = resolveNotificationAction(byId['notif-svc-sub'], { role: 'RESIDENT' });
  assert.equal(
    resSvc.url,
    `/resident?tab=services&target_contract_id=${fx.contract_id}&subscription_id=${fakeSubId}&modal=detail`
  );

  // 3. CONTRACT_REQUEST_SUBMITTED -> MANAGER opens contract request review modal; RESIDENT opens contract view
  const mgrCntReq = resolveNotificationAction(byId['notif-cnt-req'], { role: 'MANAGER' });
  assert.equal(mgrCntReq.url, `/admin/contracts?tab=requests&request_id=${fakeReqId}&modal=request`);
  assert.equal(String(mgrCntReq.buildingId), String(fx.building_id));

  const resCntReq = resolveNotificationAction(byId['notif-cnt-req'], { role: 'RESIDENT' });
  assert.equal(
    resCntReq.url,
    `/resident?tab=contract&target_contract_id=${fx.contract_id}&modal=contract_view`
  );

  // 4. Four-Eyes Credit Refund -> OWNER/MANAGER open admin credit modal; RESIDENT opens resident credit modal
  const ownerCredit = resolveNotificationAction(byId['notif-crd-ref'], { role: 'OWNER' });
  assert.equal(ownerCredit.url, `/admin/payments?tab=credits&credit_id=${fakeCreditId}&modal=credit`);
  assert.equal(String(ownerCredit.buildingId), String(fx.building_id));

  const resCredit = resolveNotificationAction(byId['notif-crd-res'], { role: 'RESIDENT' });
  assert.equal(
    resCredit.url,
    `/resident?tab=invoices&target_contract_id=${fx.contract_id}&credit_id=${fakeCreditId}&modal=credit`
  );

  // 5. METER_UNRECORDED_ALERT -> MANAGER opens single meter modal for period + contract
  const mgrMeter = resolveNotificationAction(byId['notif-meter'], { role: 'MANAGER' });
  assert.equal(mgrMeter.url, `/admin/meters?period=2026-11&contract_id=${fx.contract_id}&modal=record`);

  // 6. AI_BUDGET_EXCEEDED -> SYS_ADMIN opens Settings AI modal; MANAGER safely falls back to info modal
  const sysAi = resolveNotificationAction(byId['notif-ai-cap'], { role: 'SYS_ADMIN' });
  assert.equal(sysAi.url, '/admin/settings?modal=ai');
  const mgrAi = resolveNotificationAction(byId['notif-ai-cap'], { role: 'MANAGER' });
  assert.equal(mgrAi.kind, 'detail_modal');
});
