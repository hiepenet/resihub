import test from 'node:test';
import assert from 'node:assert/strict';

import {
  roundVND,
  todayVietnamYmd,
  previewSubscriptionProrata,
  canConfirmInvoiceVoid,
  canActorApproveInvoiceAdjustment,
  canActorApproveCreditRefund,
  resolvePrdAgingBucket,
  createIdempotencyKey,
  withIdempotency,
  resolveSettlementPayoutSummary,
} from '../../frontend/src/utils/billing.js';

import {
  SUBSCRIPTION_STATUS,
  INVOICE_STATUS,
  INVOICE_ADJUSTMENT_STATUS,
  CREDIT_BALANCE_STATUS,
  ALL_STATUS_MAPS,
} from '../../frontend/src/constants/statuses.js';

test('1. All new status maps exist with CANCELLED display fallback; billing.js re-exports createIdempotencyKey', () => {
  // SUBSCRIPTION_STATUS includes TERMINATED and CANCELLED
  assert.ok(SUBSCRIPTION_STATUS.TERMINATED, 'SUBSCRIPTION_STATUS.TERMINATED must exist');
  assert.equal(SUBSCRIPTION_STATUS.TERMINATED.label, 'Đã chấm dứt');
  assert.ok(SUBSCRIPTION_STATUS.CANCELLED, 'SUBSCRIPTION_STATUS.CANCELLED must exist');

  // INVOICE_STATUS includes ADJUSTED and VOID
  assert.ok(INVOICE_STATUS.ADJUSTED, 'INVOICE_STATUS.ADJUSTED must exist');
  assert.equal(INVOICE_STATUS.ADJUSTED.label, 'Đã điều chỉnh');
  assert.ok(INVOICE_STATUS.VOID, 'INVOICE_STATUS.VOID must exist');
  assert.equal(INVOICE_STATUS.VOID.label, 'Đã hủy');

  // INVOICE_ADJUSTMENT_STATUS has required statuses + CANCELLED display fallback
  assert.ok(INVOICE_ADJUSTMENT_STATUS, 'INVOICE_ADJUSTMENT_STATUS must exist');
  assert.ok(INVOICE_ADJUSTMENT_STATUS.PENDING_APPROVAL);
  assert.ok(INVOICE_ADJUSTMENT_STATUS.APPROVED);
  assert.ok(INVOICE_ADJUSTMENT_STATUS.REJECTED);
  assert.ok(INVOICE_ADJUSTMENT_STATUS.CANCELLED, 'INVOICE_ADJUSTMENT_STATUS must have CANCELLED fallback');

  // CREDIT_BALANCE_STATUS has required statuses + CANCELLED display fallback
  assert.ok(CREDIT_BALANCE_STATUS, 'CREDIT_BALANCE_STATUS must exist');
  assert.ok(CREDIT_BALANCE_STATUS.AVAILABLE);
  assert.ok(CREDIT_BALANCE_STATUS.PARTIALLY_APPLIED);
  assert.ok(CREDIT_BALANCE_STATUS.APPLIED);
  assert.ok(CREDIT_BALANCE_STATUS.PENDING_DIRECT_REFUND);
  assert.ok(CREDIT_BALANCE_STATUS.REFUNDED_DIRECT);
  assert.ok(CREDIT_BALANCE_STATUS.PENDING_SETTLEMENT_PAYOUT);
  assert.ok(CREDIT_BALANCE_STATUS.REFUNDED_IN_SETTLEMENT);
  assert.ok(CREDIT_BALANCE_STATUS.TRANSFERRED);
  assert.ok(CREDIT_BALANCE_STATUS.VOID);
  assert.ok(CREDIT_BALANCE_STATUS.CANCELLED, 'CREDIT_BALANCE_STATUS must have CANCELLED fallback');

  // ALL_STATUS_MAPS registration
  assert.equal(ALL_STATUS_MAPS.invoice_adjustment, INVOICE_ADJUSTMENT_STATUS);
  assert.equal(ALL_STATUS_MAPS.credit_balance, CREDIT_BALANCE_STATUS);

  // billing.js re-exports createIdempotencyKey & withIdempotency from idempotency.js
  assert.equal(typeof createIdempotencyKey, 'function');
  const key1 = createIdempotencyKey();
  const key2 = createIdempotencyKey();
  assert.ok(key1 && typeof key1 === 'string' && key1.length > 5);
  assert.notEqual(key1, key2);

  assert.equal(typeof withIdempotency, 'function');
  const wrapped = withIdempotency({ url: '/api/v1/invoices' });
  assert.ok(wrapped.headers && wrapped.headers['Idempotency-Key']);
});

test('2. previewSubscriptionProrata returns 0 ₫ when endDate < startDate and 11/30 days (roundVND) for 10/11 -> 20/11', () => {
  // roundVND unit checks
  assert.equal(roundVND(123456), 123000);
  assert.equal(roundVND(123500), 124000);
  assert.equal(roundVND(-123600), -124000);
  assert.equal(roundVND(0), 0);

  // todayVietnamYmd returns YYYY-MM-DD
  const todayStr = todayVietnamYmd();
  assert.match(todayStr, /^\d{4}-\d{2}-\d{2}$/);

  // When endDate < startDate: returns 0 ₫
  const negativeRange = previewSubscriptionProrata({
    unitPrice: 300000,
    quantity: 1,
    startDate: '2026-11-20',
    endDate: '2026-11-10',
    periodYm: '2026-11',
  });
  assert.equal(negativeRange.amount, 0);
  assert.equal(negativeRange.activeDays, 0);
  assert.match(String(negativeRange), /0\s*₫/);
  assert.match(negativeRange.formattedAmount, /0\s*₫/);

  // Positional signature: previewSubscriptionProrata(unitPrice, quantity, startDate, endDate)
  const posNegative = previewSubscriptionProrata(300000, 1, '2026-11-20', '2026-11-10');
  assert.equal(posNegative.amount, 0);
  assert.match(String(posNegative), /0\s*₫/);

  // When zeroUsage is true: returns 0 ₫
  const zeroUsage = previewSubscriptionProrata({
    unitPrice: 300000,
    quantity: 1,
    startDate: '2026-11-01',
    endDate: '2026-11-20',
    zeroUsage: true,
  });
  assert.equal(zeroUsage.amount, 0);
  assert.match(String(zeroUsage), /0\s*₫/);

  // For 10/11 -> 20/11: November has 30 days, active = 11 days (10 to 20 inclusive)
  // expected = roundVND((300000 * 1 * 11) / 30) = 110000
  const prorata11 = previewSubscriptionProrata({
    unitPrice: 300000,
    quantity: 1,
    startDate: '2026-11-10',
    endDate: '2026-11-20',
    periodYm: '2026-11',
  });
  assert.equal(prorata11.activeDays, 11);
  assert.equal(prorata11.daysInMonth, 30);
  assert.equal(prorata11.amount, 110000);
  assert.match(prorata11.formattedAmount, /110[.,]000\s*₫/);
  assert.equal(prorata11.daysRatio, '11/30');

  // Positional signature for 10/11 -> 20/11
  const posProrata11 = previewSubscriptionProrata(300000, 1, '2026-11-10', '2026-11-20');
  assert.equal(posProrata11.activeDays, 11);
  assert.equal(posProrata11.daysInMonth, 30);
  assert.equal(posProrata11.amount, 110000);
});

test('3. resolvePrdAgingBucket(daysOverdue) maps <= 0 -> current_not_due, 1..15 -> 0_15, 16..30 -> 16_30, 31..60 -> 31_60, > 60 -> over_60 (AC-016.1)', () => {
  // <= 0
  assert.equal(resolvePrdAgingBucket(0), 'current_not_due');
  assert.equal(resolvePrdAgingBucket(-1), 'current_not_due');
  assert.equal(resolvePrdAgingBucket(-45), 'current_not_due');
  assert.equal(resolvePrdAgingBucket(null), 'current_not_due');
  assert.equal(resolvePrdAgingBucket(undefined), 'current_not_due');

  // 1..15
  assert.equal(resolvePrdAgingBucket(1), '0_15');
  assert.equal(resolvePrdAgingBucket(7), '0_15');
  assert.equal(resolvePrdAgingBucket(15), '0_15');

  // 16..30
  assert.equal(resolvePrdAgingBucket(16), '16_30');
  assert.equal(resolvePrdAgingBucket(25), '16_30');
  assert.equal(resolvePrdAgingBucket(30), '16_30');

  // 31..60
  assert.equal(resolvePrdAgingBucket(31), '31_60');
  assert.equal(resolvePrdAgingBucket(45), '31_60');
  assert.equal(resolvePrdAgingBucket(60), '31_60');

  // > 60
  assert.equal(resolvePrdAgingBucket(61), 'over_60');
  assert.equal(resolvePrdAgingBucket(90), 'over_60');
  assert.equal(resolvePrdAgingBucket(180), 'over_60');
});

test('4. canConfirmInvoiceVoid, canActorApproveInvoiceAdjustment, and canActorApproveCreditRefund enforce 2-step invoice_code + non-empty reason and 4-eyes / SYS_ADMIN fallback rules', () => {
  // 2-step VOID validation:
  const inv = { invoice_code: 'INV-202611-0042' };

  // valid
  assert.equal(
    canConfirmInvoiceVoid({ invoice: inv, typedInvoiceCode: 'INV-202611-0042', reason: 'Dịch vụ đã hủy trước kỳ' }),
    true
  );
  // positional
  assert.equal(canConfirmInvoiceVoid('INV-202611-0042', 'INV-202611-0042', 'Lý do hủy hợp lệ'), true);

  // invalid: mismatch code
  assert.equal(
    canConfirmInvoiceVoid({ invoice: inv, typedInvoiceCode: 'INV-WRONG', reason: 'Lý do' }),
    false
  );
  // invalid: empty reason
  assert.equal(
    canConfirmInvoiceVoid({ invoice: inv, typedInvoiceCode: 'INV-202611-0042', reason: '' }),
    false
  );
  assert.equal(
    canConfirmInvoiceVoid({ invoice: inv, typedInvoiceCode: 'INV-202611-0042', reason: '   ' }),
    false
  );
  // invalid: missing code
  assert.equal(canConfirmInvoiceVoid({ invoice: null, typedInvoiceCode: 'INV-001', reason: 'Lý do' }), false);

  // 4-eyes rule: canActorApproveInvoiceAdjustment
  const creatorUser = { id: 'user-manager-1', role: 'MANAGER' };
  const secondManager = { id: 'user-manager-2', role: 'MANAGER' };
  const ownerUser = { id: 'user-owner-1', role: 'OWNER' };
  const sysAdminUser = { id: 'user-sysadmin-1', role: 'SYS_ADMIN' };
  const residentUser = { id: 'user-resident-1', role: 'RESIDENT' };

  const adjustment = { id: 'adj-1', created_by: 'user-manager-1', building_id: 'bldg-1' };

  // Self-approval denied by default
  assert.equal(
    canActorApproveInvoiceAdjustment({
      actor: creatorUser,
      record: adjustment,
      buildingHasActiveOwner: true,
    }),
    false,
    'Creator must not approve their own adjustment'
  );

  // Self-approval permitted only when allowSelfApproval = true
  assert.equal(
    canActorApproveInvoiceAdjustment({
      actor: creatorUser,
      record: adjustment,
      buildingHasActiveOwner: true,
      allowSelfApproval: true,
    }),
    true
  );

  // 2nd Manager from same building can approve
  assert.equal(
    canActorApproveInvoiceAdjustment({
      actor: secondManager,
      record: adjustment,
      buildingHasActiveOwner: true,
    }),
    true
  );

  // Owner can approve
  assert.equal(
    canActorApproveInvoiceAdjustment({
      actor: ownerUser,
      record: adjustment,
      buildingHasActiveOwner: true,
    }),
    true
  );

  // SYS_ADMIN: blocked if building has active owner
  assert.equal(
    canActorApproveInvoiceAdjustment({
      actor: sysAdminUser,
      record: adjustment,
      buildingHasActiveOwner: true,
    }),
    false,
    'SYS_ADMIN should not approve if building has active owner'
  );

  // SYS_ADMIN: allowed as fallback when building has NO active owner
  assert.equal(
    canActorApproveInvoiceAdjustment({
      actor: sysAdminUser,
      record: adjustment,
      buildingHasActiveOwner: false,
    }),
    true,
    'SYS_ADMIN should approve as fallback when building has no active owner'
  );

  // Resident cannot approve
  assert.equal(
    canActorApproveInvoiceAdjustment({
      actor: residentUser,
      record: adjustment,
      buildingHasActiveOwner: false,
    }),
    false
  );

  // 4-eyes rule: canActorApproveCreditRefund (exact same rules)
  const creditRecord = { id: 'cr-1', created_by: 'user-manager-1', building_id: 'bldg-1' };

  assert.equal(
    canActorApproveCreditRefund({
      actor: creatorUser,
      record: creditRecord,
      buildingHasActiveOwner: true,
    }),
    false
  );
  assert.equal(
    canActorApproveCreditRefund({
      actor: secondManager,
      record: creditRecord,
      buildingHasActiveOwner: true,
    }),
    true
  );
  assert.equal(
    canActorApproveCreditRefund({
      actor: ownerUser,
      record: creditRecord,
      buildingHasActiveOwner: true,
    }),
    true
  );
  assert.equal(
    canActorApproveCreditRefund({
      actor: sysAdminUser,
      record: creditRecord,
      buildingHasActiveOwner: true,
    }),
    false
  );
  assert.equal(
    canActorApproveCreditRefund({
      actor: sysAdminUser,
      record: creditRecord,
      buildingHasActiveOwner: false,
    }),
    true
  );
});

test('6. resolveSettlementPayoutSummary separates deposit vs credit refunds and flags requiresUncPayout', () => {
  // Case 1: Both deposit and credit refunds > 0
  const both = resolveSettlementPayoutSummary({
    deposit_refund_amount: 1500000,
    credit_refund_amount: 500000,
    total_payout_amount: 2000000,
  });
  assert.deepEqual(both, {
    depositRefund: 1500000,
    creditRefund: 500000,
    totalPayout: 2000000,
    requiresUncPayout: true,
  });

  // Case 2: Zero deposit refund but positive credit refund (critical M06 invariant)
  const creditOnly = resolveSettlementPayoutSummary({
    deposit_refund_amount: 0,
    credit_refund_amount: 800000,
    total_payout_amount: 800000,
  });
  assert.deepEqual(creditOnly, {
    depositRefund: 0,
    creditRefund: 800000,
    totalPayout: 800000,
    requiresUncPayout: true,
  });

  // Case 3: Positive deposit refund but zero credit refund
  const depositOnly = resolveSettlementPayoutSummary({
    deposit_refund_amount: 2000000,
    credit_refund_amount: 0,
  });
  assert.deepEqual(depositOnly, {
    depositRefund: 2000000,
    creditRefund: 0,
    totalPayout: 2000000,
    requiresUncPayout: true,
  });

  // Case 4: Neither refund (both 0 or empty object) -> requiresUncPayout: false
  const zeroPayout = resolveSettlementPayoutSummary({
    deposit_refund_amount: 0,
    credit_refund_amount: 0,
    total_payout_amount: 0,
  });
  assert.deepEqual(zeroPayout, {
    depositRefund: 0,
    creditRefund: 0,
    totalPayout: 0,
    requiresUncPayout: false,
  });

  const emptyPayout = resolveSettlementPayoutSummary({});
  assert.deepEqual(emptyPayout, {
    depositRefund: 0,
    creditRefund: 0,
    totalPayout: 0,
    requiresUncPayout: false,
  });

  const nullPayout = resolveSettlementPayoutSummary(null);
  assert.deepEqual(nullPayout, {
    depositRefund: 0,
    creditRefund: 0,
    totalPayout: 0,
    requiresUncPayout: false,
  });
});

