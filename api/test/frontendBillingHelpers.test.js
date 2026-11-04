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
  evaluateClientMeterAnomaly,
  summarizeSkippedContracts,
  resolveBatchConfirmFeedback,
  resolveResidentInvoiceLineMeterImage,
  resolveResidentInvoiceTotalsSummary,
  resolveAnomalyThresholdPct,
  computeMeterEstimatedAmount,
  buildContractServiceCodeOptions,
} from '../../frontend/src/utils/billing.js';
import { getCurrentPeriod } from '../../frontend/src/utils/format.js';

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

test('7. getCurrentPeriod resolves YYYY-MM in Asia/Ho_Chi_Minh across UTC midnight boundary (Review Focus #1)', () => {
  // 2026-10-31T17:05:00Z is 2026-11-01 00:05:00 in Vietnam (+07:00) -> '2026-11'
  assert.equal(getCurrentPeriod(new Date('2026-10-31T17:05:00.000Z')), '2026-11');
  // 2026-10-31T16:59:59Z is 2026-10-31 23:59:59 in Vietnam (+07:00) -> '2026-10'
  assert.equal(getCurrentPeriod(new Date('2026-10-31T16:59:59.000Z')), '2026-10');
});

test('8. evaluateClientMeterAnomaly handles 3-period baselineAvg, strict >30% threshold, invalid decrease & cold start', () => {
  // Exact +30% is NOT abnormal (strict > 30%)
  const exact30 = evaluateClientMeterAnomaly({
    prevReading: 100,
    currentReading: 230,
    baselineAvg: 100,
    thresholdPct: 30,
  });
  assert.equal(exact30.isInvalid, false);
  assert.equal(exact30.consumption, 130);
  assert.equal(exact30.diffPct, 30);
  assert.equal(exact30.isAbnormal, false);

  // +31% IS abnormal
  const over30 = evaluateClientMeterAnomaly({
    prevReading: 100,
    currentReading: 231,
    baselineAvg: 100,
    thresholdPct: 30,
  });
  assert.equal(over30.consumption, 131);
  assert.equal(over30.diffPct, 31);
  assert.equal(over30.isAbnormal, true);

  // Negative consumption (current < prev) -> invalid
  const invalid = evaluateClientMeterAnomaly({
    prevReading: 100,
    currentReading: 95,
    baselineAvg: 100,
  });
  assert.equal(invalid.isInvalid, true);
  assert.equal(invalid.consumption, null);
  assert.equal(invalid.isAbnormal, false);

  // Cold start (baselineAvg = null) -> never flagged abnormal
  const coldStart = evaluateClientMeterAnomaly({
    prevReading: 100,
    currentReading: 500,
    baselineAvg: null,
  });
  assert.equal(coldStart.isInvalid, false);
  assert.equal(coldStart.consumption, 400);
  assert.equal(coldStart.diffPct, null);
  assert.equal(coldStart.isAbnormal, false);
});

test('9. summarizeSkippedContracts separates MISSING_CONFIRMED_METER_READING vs ZERO_BILLABLE_AMOUNT', () => {
  const empty = summarizeSkippedContracts([]);
  assert.equal(empty.totalSkipped, 0);
  assert.equal(empty.missingMeterCount, 0);
  assert.equal(empty.zeroBillableCount, 0);
  assert.equal(empty.message, '');

  const summary = summarizeSkippedContracts([
    {
      contract_id: 'c-1',
      apartment_code: 'A-101',
      reason_code: 'MISSING_CONFIRMED_METER_READING',
      missing_meter_types: ['ELECTRICITY'],
    },
    {
      contract_id: 'c-2',
      apartment_code: 'A-102',
      reason_code: 'MISSING_CONFIRMED_METER_READING',
      missing_meter_types: ['WATER'],
    },
    {
      contract_id: 'c-3',
      apartment_code: 'B-205',
      reason_code: 'ZERO_BILLABLE_AMOUNT',
    },
  ]);
  assert.equal(summary.totalSkipped, 3);
  assert.equal(summary.missingMeterCount, 2);
  assert.deepEqual(summary.missingMeterApartments, ['A-101', 'A-102']);
  assert.equal(summary.zeroBillableCount, 1);
  assert.deepEqual(summary.zeroBillableApartments, ['B-205']);
  assert.match(summary.message, /A-101, A-102/);
  assert.match(summary.message, /B-205/);
});

test('10. resolveBatchConfirmFeedback warns when skipped_abnormal_without_note is integer > 0 or non-empty array (Review Important #2)', () => {
  // Integer skipped count from POST /api/v1/meters/readings/confirm-batch
  const intWarn = resolveBatchConfirmFeedback({
    confirmed_count: 4,
    skipped_abnormal_without_note: 3,
    message: 'Đã xác nhận chốt 4 chỉ số.',
  });
  assert.equal(intWarn.level, 'warning');
  assert.equal(intWarn.skippedCount, 3);
  assert.equal(intWarn.confirmedCount, 4);
  assert.match(intWarn.message, /Còn 3 đồng hồ bất thường/);

  // Array fallback
  const arrWarn = resolveBatchConfirmFeedback({
    confirmed_count: 2,
    skipped_abnormal_without_note: ['r1', 'r2'],
  });
  assert.equal(arrWarn.level, 'warning');
  assert.equal(arrWarn.skippedCount, 2);

  // Zero skipped -> success
  const ok = resolveBatchConfirmFeedback({
    confirmed_count: 5,
    skipped_abnormal_without_note: 0,
  });
  assert.equal(ok.level, 'success');
  assert.equal(ok.skippedCount, 0);
  assert.equal(ok.confirmedCount, 5);
  assert.match(ok.message, /5 chỉ số/);
});

test('11. resolveResidentInvoiceLineMeterImage & resolveResidentInvoiceTotalsSummary support FR-032 photo & credit_offset_amount', () => {
  // Meter image extraction only for ELECTRICITY / WATER
  assert.equal(
    resolveResidentInvoiceLineMeterImage({
      item_type: 'ELECTRICITY',
      meter_image_url: '/api/v1/attachments/11111111-1111-1111-1111-111111111111/view',
    }),
    '/api/v1/attachments/11111111-1111-1111-1111-111111111111/view'
  );
  assert.equal(
    resolveResidentInvoiceLineMeterImage({
      item_type: 'WATER',
      formula_meta: { image_url: '/api/v1/attachments/22222222-2222-2222-2222-222222222222/view' },
    }),
    '/api/v1/attachments/22222222-2222-2222-2222-222222222222/view'
  );
  assert.equal(
    resolveResidentInvoiceLineMeterImage({
      item_type: 'RENT',
      meter_image_url: '/api/v1/attachments/should-ignore/view',
    }),
    null
  );
  assert.equal(
    resolveResidentInvoiceLineMeterImage({
      item_type: 'ELECTRICITY',
      meter_image_url: '   ',
      formula_meta: {},
    }),
    null
  );

  // Totals summary with credit_offset_amount & adjustment_amount
  const summaryWithCredit = resolveResidentInvoiceTotalsSummary({
    status: 'ISSUED',
    subtotal_amount: 10525000,
    adjustment_amount: -200000,
    credit_offset_amount: 1500000,
    total_amount: 8825000,
    paid_amount: 3000000,
  });
  assert.equal(summaryWithCredit.subtotalAmount, 10525000);
  assert.equal(summaryWithCredit.adjustmentAmount, -200000);
  assert.equal(summaryWithCredit.creditOffsetAmount, 1500000);
  assert.equal(summaryWithCredit.totalAmount, 8825000);
  assert.equal(summaryWithCredit.paidAmount, 3000000);
  assert.equal(summaryWithCredit.remainingAmount, 5825000);
  assert.equal(summaryWithCredit.showPreTotalBreakdown, true);

  const plainSummary = resolveResidentInvoiceTotalsSummary({
    status: 'VOID',
    subtotal_amount: 5000000,
    adjustment_amount: 0,
    credit_offset_amount: 0,
    total_amount: 5000000,
    paid_amount: 0,
  });
  assert.equal(plainSummary.showPreTotalBreakdown, false);
  assert.equal(plainSummary.remainingAmount, 0);
});

test('12. resolveAnomalyThresholdPct & computeMeterEstimatedAmount apply dynamic threshold, 3-tier effective_unit_price & roundVND', () => {
  assert.equal(resolveAnomalyThresholdPct(20), 20);
  assert.equal(resolveAnomalyThresholdPct('45'), 45);
  assert.equal(resolveAnomalyThresholdPct(0), 30);
  assert.equal(resolveAnomalyThresholdPct(null), 30);
  assert.equal(resolveAnomalyThresholdPct('abc'), 30);

  // Custom threshold 20% flags +25% variance (which default 30% would not flag)
  const custom20 = evaluateClientMeterAnomaly({
    prevReading: 100,
    currentReading: 225,
    baselineAvg: 100,
    thresholdPct: resolveAnomalyThresholdPct(20),
  });
  assert.equal(custom20.consumption, 125);
  assert.equal(custom20.diffPct, 25);
  assert.equal(custom20.isAbnormal, true);

  // Contract override effective_unit_price (3500) wins over meter.unit_price (3800) + roundVND to nearest 1.000 ₫
  // 123.3 kWh * 3500 = 431,550 -> roundVND = 432,000
  assert.equal(
    computeMeterEstimatedAmount(123.3, {
      unit_price: 3800,
      effective_unit_price: 3500,
    }),
    432000
  );
  // Fallback to meter.unit_price when effective_unit_price is absent: 10.1 * 3800 = 38,380 -> 38,000
  assert.equal(computeMeterEstimatedAmount(10.1, { unit_price: 3800 }), 38000);
  assert.equal(computeMeterEstimatedAmount(0, { unit_price: 3800 }), 0);
  assert.equal(computeMeterEstimatedAmount(null, { unit_price: 3800 }), null);
});

test('13. buildContractServiceCodeOptions merges standard utility/service codes with custom service_catalog & existing overrides', () => {
  const options = buildContractServiceCodeOptions(
    [
      { code: 'internet', name: 'Internet tốc độ cao', is_active: true },
      { code: 'CAR_PARKING', name: 'Gửi xe ô tô hầm B1', is_active: true },
      { code: 'CLEANING', name: 'Dọn phòng hàng tuần', is_active: true },
      { code: 'OLD_SVC', name: 'Dịch vụ ngừng cung cấp', is_active: false },
    ],
    [{ service_code: 'LEGACY_GYM' }]
  );

  const values = options.map((o) => o.value);
  assert.ok(values.includes('ELECTRICITY'), 'Must keep ELECTRICITY');
  assert.ok(values.includes('WATER'), 'Must keep WATER');
  assert.ok(values.includes('INTERNET'), 'Must keep INTERNET without duplicating lowercase');
  assert.equal(values.filter((v) => v === 'INTERNET').length, 1);
  assert.ok(values.includes('CAR_PARKING'), 'Must include active custom catalog code CAR_PARKING');
  assert.ok(values.includes('CLEANING'), 'Must include active custom catalog code CLEANING');
  assert.ok(!values.includes('OLD_SVC'), 'Inactive catalog service not in existingPrices should be omitted');
  assert.ok(values.includes('LEGACY_GYM'), 'Existing contract override code should remain selectable/displayable');

  const cleaningOpt = options.find((o) => o.value === 'CLEANING');
  assert.match(cleaningOpt.label, /Dọn phòng hàng tuần.*CLEANING/);
});



