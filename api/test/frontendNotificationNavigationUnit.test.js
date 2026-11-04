import { test } from 'node:test';
import assert from 'node:assert/strict';

test('Unit: resolveNotificationAction covers 100% of RESIDENT notification types & modals', async () => {
  const {
    resolveNotificationAction,
    stripNotificationTriggerParams,
  } = await import('../../frontend/src/utils/notificationNavigation.js');

  const cid = '11111111-1111-4111-8111-111111111111';
  const iid = '22222222-2222-4222-8222-222222222222';
  const crid = '33333333-3333-4333-8333-333333333333';
  const did = '44444444-4444-4444-8444-444444444444';
  const srid = '55555555-5555-4555-8555-555555555555';
  const subid = '66666666-6666-4666-8666-666666666666';
  const rsvid = '77777777-7777-4777-8777-777777777777';

  // 1. Invoice pay group
  for (const type of ['INVOICE_ISSUED', 'PAYMENT_REMINDER', 'PAYMENT_REJECTED']) {
    const act = resolveNotificationAction(
      { type, payload: { contract_id: cid, invoice_id: iid } },
      { role: 'RESIDENT', isAdminPortal: false }
    );
    assert.equal(act.kind, 'navigate');
    assert.equal(
      act.url,
      `/resident?tab=invoices&target_contract_id=${cid}&invoice_id=${iid}&modal=pay`
    );
    assert.equal(act.contractId, cid);
  }

  // 2. Invoice detail vs Credit detail
  const paidAct = resolveNotificationAction(
    { type: 'PAYMENT_CONFIRMED', payload: { contract_id: cid, invoice_id: iid } },
    { role: 'RESIDENT', isAdminPortal: false }
  );
  assert.equal(
    paidAct.url,
    `/resident?tab=invoices&target_contract_id=${cid}&invoice_id=${iid}&modal=detail`
  );

  const creditAct = resolveNotificationAction(
    { type: 'CREDIT_REFUND_PENDING', payload: { contract_id: cid, credit_id: crid } },
    { role: 'RESIDENT', isAdminPortal: false }
  );
  assert.equal(
    creditAct.url,
    `/resident?tab=invoices&target_contract_id=${cid}&credit_id=${crid}&modal=credit`
  );

  // 3. Settlement & Bank & Contract & Deposit view
  const settleAct = resolveNotificationAction(
    { type: 'SETTLEMENT_STATEMENT_READY', payload: { contract_id: cid, deposit_id: did } },
    { role: 'RESIDENT', isAdminPortal: false }
  );
  assert.equal(
    settleAct.url,
    `/resident?tab=contract&target_contract_id=${cid}&deposit_id=${did}&modal=settlement`
  );

  const bankAct = resolveNotificationAction(
    { type: 'SETTLEMENT_READY_FOR_PAYOUT', payload: { contract_id: cid, deposit_id: did } },
    { role: 'RESIDENT', isAdminPortal: false }
  );
  assert.equal(
    bankAct.url,
    `/resident?tab=contract&target_contract_id=${cid}&deposit_id=${did}&modal=bank`
  );

  const renewAct = resolveNotificationAction(
    { type: 'CONTRACT_EXPIRY', payload: { contract_id: cid } },
    { role: 'RESIDENT', isAdminPortal: false }
  );
  assert.equal(renewAct.url, `/resident?tab=contract&target_contract_id=${cid}&modal=renew`);

  const cViewAct = resolveNotificationAction(
    { type: 'CONTRACT_ACTIVATED', payload: { contract_id: cid } },
    { role: 'RESIDENT', isAdminPortal: false }
  );
  assert.equal(
    cViewAct.url,
    `/resident?tab=contract&target_contract_id=${cid}&modal=contract_view`
  );

  const dViewAct = resolveNotificationAction(
    { type: 'DEPOSIT_PAYOUT_COMPLETED', payload: { contract_id: cid, deposit_id: did } },
    { role: 'RESIDENT', isAdminPortal: false }
  );
  assert.equal(
    dViewAct.url,
    `/resident?tab=contract&target_contract_id=${cid}&deposit_id=${did}&modal=deposit_view`
  );

  // 4. Maintenance, Services, Onboarding/Reservation, Broadcasts
  const srAct = resolveNotificationAction(
    { type: 'MAINTENANCE_UPDATE', payload: { contract_id: cid, service_request_id: srid } },
    { role: 'RESIDENT', isAdminPortal: false }
  );
  assert.equal(
    srAct.url,
    `/resident?tab=maintenance&target_contract_id=${cid}&request_id=${srid}&modal=detail`
  );

  const subAct = resolveNotificationAction(
    { type: 'SERVICE_TERMINATED', payload: { contract_id: cid, subscription_id: subid } },
    { role: 'RESIDENT', isAdminPortal: false }
  );
  assert.equal(
    subAct.url,
    `/resident?tab=services&target_contract_id=${cid}&subscription_id=${subid}&modal=detail`
  );

  const rejAppAct = resolveNotificationAction(
    { type: 'TENANT_APPLICATION_REJECTED', payload: {} },
    { role: 'RESIDENT', isAdminPortal: false }
  );
  assert.equal(rejAppAct.url, `/resident?tab=overview&modal=apply`);

  const rsvAct = resolveNotificationAction(
    { type: 'RESERVATION_PAYMENT_CONFIRMED', payload: { reservation_id: rsvid } },
    { role: 'RESIDENT', isAdminPortal: false }
  );
  assert.equal(rsvAct.url, `/resident?tab=overview&reservation_id=${rsvid}&modal=reservation`);

  for (const bType of [
    'ANNOUNCEMENT',
    'UTILITY_INTERRUPTION',
    'MAINTENANCE_NOTICE',
    'HOUSE_RULES',
    'SECURITY_ALERT',
    'SYSTEM',
  ]) {
    const bAct = resolveNotificationAction(
      { type: bType, payload: {} },
      { role: 'RESIDENT', isAdminPortal: false }
    );
    assert.equal(bAct.kind, 'detail_modal');
  }

  // 5. stripNotificationTriggerParams preserves persistent params and removes one-shot params
  const sp = new URLSearchParams(
    'tab=invoices&contract_id=abc&target_contract_id=def&invoice_id=123&modal=pay&period=2026-11'
  );
  const cleaned = stripNotificationTriggerParams(sp);
  assert.equal(cleaned.get('tab'), 'invoices');
  assert.equal(cleaned.get('contract_id'), 'abc');
  assert.equal(cleaned.get('period'), '2026-11');
  assert.equal(cleaned.has('target_contract_id'), false);
  assert.equal(cleaned.has('invoice_id'), false);
  assert.equal(cleaned.has('modal'), false);
});

test('Unit: resolveNotificationAction covers MANAGER, OWNER, SYS_ADMIN routes, RBAC settings guard, and seed fallbacks', async () => {
  const { resolveNotificationAction } = await import(
    '../../frontend/src/utils/notificationNavigation.js'
  );

  const bid = '10101010-1010-4010-8010-101010101010';
  const aid = '20202020-2020-4020-8020-202020202020';
  const cid = '30303030-3030-4030-8030-303030303030';
  const iid = '40404040-4040-4040-8040-404040404040';
  const pid = '50505050-5050-4050-8050-505050505050';
  const crid = '60606060-6060-4060-8060-606060606060';
  const did = '70707070-7070-4070-8070-707070707070';
  const srid = '80808080-8080-4080-8080-808080808080';
  const subid = '90909090-9090-4090-8090-909090909090';
  const rsvid = 'abababab-abab-4bab-8bab-abababababab';
  const reqid = 'cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd';
  const tid = 'efefefef-efef-4fef-8fef-efefefefefef';

  assert.deepEqual(
    {
      sr: resolveNotificationAction(
        { type: 'SERVICE_REQUEST_SLA_BREACH', payload: { service_request_id: srid, building_id: bid } },
        { role: 'MANAGER', isAdminPortal: true }
      ).url,
      pay: resolveNotificationAction(
        { type: 'PAYMENT_REPORTED', payload: { payment_id: pid, building_id: bid } },
        { role: 'MANAGER', isAdminPortal: true }
      ).url,
      cred: resolveNotificationAction(
        { type: 'PENDING_CREDIT_REFUND', payload: { credit_id: crid, building_id: bid } },
        { role: 'OWNER', isAdminPortal: true }
      ).url,
      sub: resolveNotificationAction(
        { type: 'SERVICE_CANCELLATION_REQUESTED', payload: { subscription_id: subid, building_id: bid } },
        { role: 'MANAGER', isAdminPortal: true }
      ).url,
      inv: resolveNotificationAction(
        { type: 'INVOICE_ADJUSTMENT_PENDING', payload: { invoice_id: iid, building_id: bid } },
        { role: 'OWNER', isAdminPortal: true }
      ).url,
      creq: resolveNotificationAction(
        { type: 'CONTRACT_REQUEST_SUBMITTED', payload: { request_id: reqid, building_id: bid } },
        { role: 'MANAGER', isAdminPortal: true }
      ).url,
      con: resolveNotificationAction(
        { type: 'CONTRACT_PENDING_APPROVAL', payload: { contract_id: cid, building_id: bid } },
        { role: 'OWNER', isAdminPortal: true }
      ).url,
      dep: resolveNotificationAction(
        { type: 'SETTLEMENT_PENDING_APPROVAL', payload: { deposit_id: did, building_id: bid } },
        { role: 'OWNER', isAdminPortal: true }
      ).url,
      rsv: resolveNotificationAction(
        {
          type: 'PUBLIC_RESERVATION_PENDING_CONFIRM',
          payload: { apartment_id: aid, reservation_id: rsvid, building_id: bid },
        },
        { role: 'MANAGER', isAdminPortal: true }
      ).url,
      ten: resolveNotificationAction(
        { type: 'TENANT_APPLICATION', payload: { tenant_id: tid, desired_building_id: bid } },
        { role: 'MANAGER', isAdminPortal: true }
      ).url,
      mtr: resolveNotificationAction(
        { type: 'MISSING_METER_READING', payload: { period: '2026-11', contract_id: cid, building_id: bid } },
        { role: 'MANAGER', isAdminPortal: true }
      ).url,
      rep: resolveNotificationAction(
        {
          type: 'MONTHLY_DEPOSIT_REPORT',
          payload: { building_id: bid, from_date: '2026-10-01', to_date: '2026-10-31' },
        },
        { role: 'OWNER', isAdminPortal: true }
      ).url,
    },
    {
      sr: `/admin/maintenance?request_id=${srid}`,
      pay: `/admin/payments?tab=transactions&payment_id=${pid}&modal=review`,
      cred: `/admin/payments?tab=credits&credit_id=${crid}&modal=credit`,
      sub: `/admin/services/subscriptions?subscription_id=${subid}&modal=review`,
      inv: `/admin/invoices/${iid}?modal=auto`,
      creq: `/admin/contracts?tab=requests&request_id=${reqid}&modal=request`,
      con: `/admin/contracts/${cid}?modal=auto`,
      dep: `/admin/deposits?deposit_id=${did}&modal=settlement`,
      rsv: `/admin/apartments/${aid}?reservation_id=${rsvid}&modal=reservation`,
      ten: `/admin/tenants/${tid}?modal=approval`,
      mtr: `/admin/meters?period=2026-11&contract_id=${cid}&modal=record`,
      rep: `/admin/reports?tab=deposit-ledger&building_id=${bid}&from_date=2026-10-01&to_date=2026-10-31&modal=summary`,
    }
  );

  // RBAC Guard: AI_BUDGET_WARNING / AI_BUDGET_EXCEEDED / CRON_JOB_FAILED only navigate to /admin/settings for SYS_ADMIN
  const aiSys = resolveNotificationAction(
    { type: 'AI_BUDGET_EXCEEDED', payload: { period: '2026-11' } },
    { role: 'SYS_ADMIN', isAdminPortal: true }
  );
  assert.equal(aiSys.kind, 'navigate');
  assert.equal(aiSys.url, '/admin/settings?modal=ai');

  const cronSys = resolveNotificationAction(
    { type: 'CRON_JOB_FAILED', payload: {} },
    { role: 'SYS_ADMIN', isAdminPortal: true }
  );
  assert.equal(cronSys.url, '/admin/settings?modal=cron');

  for (const nonSysRole of ['OWNER', 'MANAGER']) {
    const aiNonSys = resolveNotificationAction(
      { type: 'AI_BUDGET_EXCEEDED', payload: {} },
      { role: nonSysRole, isAdminPortal: true }
    );
    assert.equal(aiNonSys.kind, 'detail_modal', `${nonSysRole} must not navigate to /admin/settings`);
  }

  // Seed rows without UUIDs fall back to detail_modal with safe fallbackUrl (never /undefined)
  const seedContract = resolveNotificationAction(
    { type: 'CONTRACT_EXPIRING', user_id: null, payload: { link: '/admin/contracts' } },
    { role: 'MANAGER', isAdminPortal: true }
  );
  assert.equal(seedContract.kind, 'detail_modal');
  assert.equal(seedContract.fallbackUrl, '/admin/contracts');

  const seedRsv = resolveNotificationAction(
    { type: 'RESERVATION_NEW', user_id: null, payload: { link: '/admin/buildings' } },
    { role: 'MANAGER', isAdminPortal: true }
  );
  assert.equal(seedRsv.kind, 'detail_modal');
  assert.equal(seedRsv.fallbackUrl, '/admin/buildings');

  const seedDep = resolveNotificationAction(
    { type: 'DEPOSIT_SECURE', user_id: null, payload: {} },
    { role: 'OWNER', isAdminPortal: true }
  );
  assert.equal(seedDep.kind, 'detail_modal');
  assert.equal(seedDep.fallbackUrl, '/admin/deposits');
});

test('Unit: notificationStore org-wide read persistence merges localStorage per userId without cross-user bleed', async () => {
  const {
    readOrgNotifStorageKey,
    mergeOrgNotificationReadState,
  } = await import('../../frontend/src/utils/notificationNavigation.js');

  const fakeStorage = new Map();
  const storageAdapter = {
    getItem: (k) => (fakeStorage.has(k) ? fakeStorage.get(k) : null),
    setItem: (k, v) => fakeStorage.set(k, v),
  };

  const u1 = 'user-111';
  const u2 = 'user-222';
  assert.equal(readOrgNotifStorageKey(u1), 'resihub:read-org-notifs:user-111');

  const rows = [
    { id: 'org-1', user_id: null, read_at: null },
    { id: 'personal-1', user_id: u1, read_at: null },
  ];

  // Mark org-1 read for u1
  storageAdapter.setItem(readOrgNotifStorageKey(u1), JSON.stringify(['org-1']));

  const mergedU1 = mergeOrgNotificationReadState(rows, u1, storageAdapter);
  assert.ok(mergedU1.notifications[0].read_at, 'org-1 should be marked read for u1');
  assert.equal(mergedU1.notifications[1].read_at, null);
  assert.equal(mergedU1.unreadCount, 1);

  const mergedU2 = mergeOrgNotificationReadState(rows, u2, storageAdapter);
  assert.equal(mergedU2.notifications[0].read_at, null, 'org-1 remains unread for u2');
  assert.equal(mergedU2.unreadCount, 2);
});
