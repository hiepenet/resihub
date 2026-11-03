import test from 'node:test';
import assert from 'node:assert/strict';

import {
  roundVND,
  calcProrata,
  calcUtility,
} from '../src/services/pricing.js';

import {
  todayVietnamYmd,
  currentVietnamPeriod,
  getCanonicalServiceAliases,
  resolveServiceUnitPrice,
  resolveUtilityUnitPrice,
  computeSubscriptionPeriodCharge,
  computeContractRentPeriodCharge,
  resolveBillingDaysForDate,
  computeNextVietnamDailyRunMs,
  computeLateFeeAccrual,
  evaluateMeterReadingAnomaly,
} from '../src/services/serviceBilling.js';

test('Task 1.1 — roundVND, calcProrata & calcUtility (FR-063, PRD 10.3 & 18.1)', async (t) => {
  await t.test('roundVND rounds to nearest 1,000 VND including negatives and non-finite inputs', () => {
    assert.equal(roundVND(0), 0);
    assert.equal(roundVND(499), 0);
    assert.equal(roundVND(500), 1000);
    assert.equal(roundVND(3225806.45), 3226000);
    assert.equal(roundVND(-333333.33), -333000);
    assert.equal(roundVND(Number.NaN), 0);
    assert.equal(roundVND(Number.POSITIVE_INFINITY), 0);
  });

  await t.test('calcProrata handles 0 days, full month, leap Feb 29, and same-day 1-day stay', () => {
    assert.equal(calcProrata({ monthlyPrice: 10000000, activeDays: 0, daysInMonth: 30 }), 0);
    assert.equal(calcProrata({ monthlyPrice: 10000000, activeDays: -2, daysInMonth: 30 }), 0);
    assert.equal(calcProrata({ monthlyPrice: 10000000, activeDays: 10, daysInMonth: 0 }), 0);
    assert.equal(calcProrata({ monthlyPrice: 10000000, quantity: 2, activeDays: 30, daysInMonth: 30 }), 20000000);
    assert.equal(calcProrata({ monthlyPrice: 10000000, activeDays: 15, daysInMonth: 29 }), 5172000);
    assert.equal(calcProrata({ monthlyPrice: 9000000, activeDays: 1, daysInMonth: 30 }), 300000);
  });

  await t.test('calcUtility computes rounded VND consumption and rejects backward readings', () => {
    assert.equal(calcUtility({ previousReading: 1000, currentReading: 1200, unitPrice: 3853 }), 771000);
    assert.equal(calcUtility({ previousReading: 55.5, currentReading: 55.5, unitPrice: 22000 }), 0);
    assert.throws(
      () => calcUtility({ previousReading: 1050, currentReading: 1000, unitPrice: 3800 }),
      (err) => err instanceof RangeError && err.message.includes('INVALID_READING')
    );
  });
});

test('Task 1.2 — Vietnam midnight timezone window (Review Focus #1, NFR-017)', () => {
  // 2026-10-31T17:05:00Z === 2026-11-01 00:05:00 Asia/Ho_Chi_Minh (+07:00)
  const nov1MidnightVn = new Date('2026-10-31T17:05:00.000Z');
  assert.equal(todayVietnamYmd(nov1MidnightVn), '2026-11-01');
  assert.equal(currentVietnamPeriod(nov1MidnightVn), '2026-11');
});

test('Task 1.3 — computeContractRentPeriodCharge pro-rata matrix (PRD 18.1, AC-015.3)', () => {
  // Full month
  const full = computeContractRentPeriodCharge({
    contract: { start_date: '2026-01-01', end_date: '2027-01-01', rent_amount: 10000000 },
    periodYm: '2026-11',
  });
  assert.equal(full.activeDays, 30);
  assert.equal(full.isProrated, false);
  assert.equal(full.amount, 10000000);

  // Mid-month move-in on 31-day month (May 16..31 = 16 days)
  const midIn = computeContractRentPeriodCharge({
    contract: { start_date: '2026-05-16', end_date: '2027-05-16', rent_amount: 31000000 },
    periodYm: '2026-05',
  });
  assert.equal(midIn.activeDays, 16);
  assert.equal(midIn.daysInMonth, 31);
  assert.equal(midIn.amount, 16000000);

  // Early move-out day 10 on 30-day month (AC-015.3: 10/30 of 30M = 10M)
  const earlyOut = computeContractRentPeriodCharge({
    contract: { start_date: '2026-01-01', end_date: '2026-12-31', rent_amount: 30000000 },
    periodYm: '2026-04',
    lastActiveDayYmd: '2026-04-10',
  });
  assert.equal(earlyOut.activeDays, 10);
  assert.equal(earlyOut.amount, 10000000);

  // Same-day move-in & termination = 1 active day
  const sameDay = computeContractRentPeriodCharge({
    contract: { start_date: '2026-04-10', end_date: '2026-10-10', rent_amount: 30000000 },
    periodYm: '2026-04',
    lastActiveDayYmd: '2026-04-10',
  });
  assert.equal(sameDay.activeDays, 1);
  assert.equal(sameDay.amount, 1000000);

  // Leap year Feb 2028 (29 days: Feb 15..29 = 15 days -> roundVND(10M * 15 / 29) = 5,172,000)
  const leapFeb = computeContractRentPeriodCharge({
    contract: { start_date: '2028-02-15', end_date: '2029-02-15', rent_amount: 10000000 },
    periodYm: '2028-02',
  });
  assert.equal(leapFeb.daysInMonth, 29);
  assert.equal(leapFeb.activeDays, 15);
  assert.equal(leapFeb.amount, 5172000);

  // Non-leap Feb 2026 (28 days: Feb 15..28 = 14 days -> 5,000,000)
  const normalFeb = computeContractRentPeriodCharge({
    contract: { start_date: '2026-02-15', end_date: '2027-02-15', rent_amount: 10000000 },
    periodYm: '2026-02',
  });
  assert.equal(normalFeb.daysInMonth, 28);
  assert.equal(normalFeb.activeDays, 14);
  assert.equal(normalFeb.amount, 5000000);

  // Future contract -> 0
  const fut = computeContractRentPeriodCharge({
    contract: { start_date: '2026-12-01', end_date: '2027-12-01', rent_amount: 10000000 },
    periodYm: '2026-11',
  });
  assert.equal(fut.activeDays, 0);
  assert.equal(fut.amount, 0);
});

test('Task 1.4 — 3-Tier Service & Utility Pricing + Canonical Aliases (FR-065, Review Focus #2)', async (t) => {
  await t.test('canonical aliases match ELECTRICITY/ELEC, INTERNET_FIBER/INTERNET/WIFI, WATER/DOMESTIC_WATER', () => {
    assert.ok(getCanonicalServiceAliases('ELECTRICITY').includes('ELEC'));
    assert.ok(getCanonicalServiceAliases('ELEC').includes('ELECTRICITY'));
    assert.ok(getCanonicalServiceAliases('WIFI').includes('INTERNET_FIBER'));
    assert.ok(getCanonicalServiceAliases('DOMESTIC_WATER').includes('WATER'));
  });

  await t.test('resolveServiceUnitPrice & computeSubscriptionPeriodCharge honor 3-tier priority & is_active', () => {
    const catalogItems = [
      { code: 'INTERNET_FIBER', building_id: null, unit_price: 220000, is_active: true },
      { code: 'INTERNET_FIBER', building_id: 'bldg-a', unit_price: 260000, is_active: true },
      { code: 'INTERNET_FIBER', building_id: 'bldg-inactive', unit_price: 999000, is_active: false },
    ];

    // Unlocked subscription in bldg-a picks BUILDING_CATALOG (260,000) over stale unit_price (220,000)
    const bldgPrice = computeSubscriptionPeriodCharge({
      subscription: {
        service_code: 'WIFI',
        service_name: 'Internet',
        status: 'ACTIVE',
        start_date: '2026-01-01',
        quantity: 1,
        unit_price: 220000,
        is_price_locked: false,
      },
      periodYm: '2026-11',
      contractBuildingId: 'bldg-a',
      catalogItems,
    });
    assert.equal(bldgPrice.priceSource, 'BUILDING_CATALOG');
    assert.equal(bldgPrice.amount, 260000);

    // Inactive building catalog row is ignored -> falls back to DEFAULT_CATALOG (220,000)
    const inactiveFallback = resolveServiceUnitPrice({
      subscription: { service_code: 'INTERNET', unit_price: 190000, is_price_locked: false },
      contractBuildingId: 'bldg-inactive',
      periodEndYmd: '2026-11-30',
      catalogItems,
    });
    assert.equal(inactiveFallback.priceSource, 'DEFAULT_CATALOG');
    assert.equal(inactiveFallback.unitPrice, 220000);

    // Locked subscription beats BUILDING_CATALOG
    const lockedPrice = resolveServiceUnitPrice({
      subscription: { service_code: 'INTERNET_FIBER', unit_price: 200000, is_price_locked: true },
      contractBuildingId: 'bldg-a',
      periodEndYmd: '2026-11-30',
      catalogItems,
    });
    assert.equal(lockedPrice.priceSource, 'SUBSCRIPTION_LOCKED');
    assert.equal(lockedPrice.unitPrice, 200000);

    // Contract override beats SUBSCRIPTION_LOCKED & BUILDING_CATALOG, handles missing effective_from safely, and ignores future effective_from
    const overridePrice = resolveServiceUnitPrice({
      subscription: { service_code: 'INTERNET_FIBER', unit_price: 200000, is_price_locked: true },
      contractBuildingId: 'bldg-a',
      periodEndYmd: '2026-11-30',
      contractServicePrices: [
        { service_code: 'WIFI', unit_price: 170000 }, // missing effective_from null-safe
        { service_code: 'INTERNET', unit_price: 180000, effective_from: '2026-11-01' },
        { service_code: 'INTERNET', unit_price: 150000, effective_from: '2026-12-01' }, // future
      ],
      catalogItems,
    });
    assert.equal(overridePrice.priceSource, 'CONTRACT_OVERRIDE');
    assert.equal(overridePrice.unitPrice, 180000);
  });

  await t.test('resolveUtilityUnitPrice honors CONTRACT_OVERRIDE -> BUILDING_CATALOG -> METER_CONFIG -> DEFAULT_CATALOG', () => {
    const catalog = [
      { code: 'ELECTRICITY', building_id: null, unit_price: 3800, is_active: true },
      { code: 'ELECTRICITY', building_id: 'bldg-a', unit_price: 4100, is_active: true },
    ];

    // 1. CONTRACT_OVERRIDE (matches alias ELEC)
    assert.deepEqual(
      resolveUtilityUnitPrice({
        meterType: 'ELECTRICITY',
        meterUnitPrice: 4000,
        contractBuildingId: 'bldg-a',
        periodEndYmd: '2026-11-30',
        contractServicePrices: [{ service_code: 'ELEC', unit_price: 4500, effective_from: '2026-01-01' }],
        catalogItems: catalog,
      }),
      { unitPrice: 4500, priceSource: 'CONTRACT_OVERRIDE' }
    );

    // 2. BUILDING_CATALOG beats meterUnitPrice
    assert.deepEqual(
      resolveUtilityUnitPrice({
        meterType: 'ELECTRICITY',
        meterUnitPrice: 4000,
        contractBuildingId: 'bldg-a',
        periodEndYmd: '2026-11-30',
        contractServicePrices: [],
        catalogItems: catalog,
      }),
      { unitPrice: 4100, priceSource: 'BUILDING_CATALOG' }
    );

    // 3. METER_CONFIG beats org DEFAULT_CATALOG when building has no override
    assert.deepEqual(
      resolveUtilityUnitPrice({
        meterType: 'ELECTRICITY',
        meterUnitPrice: 4000,
        contractBuildingId: 'bldg-other',
        periodEndYmd: '2026-11-30',
        contractServicePrices: [],
        catalogItems: catalog,
      }),
      { unitPrice: 4000, priceSource: 'METER_CONFIG' }
    );

    // 4. DEFAULT_CATALOG when meterUnitPrice is 0/null
    assert.deepEqual(
      resolveUtilityUnitPrice({
        meterType: 'ELECTRICITY',
        meterUnitPrice: 0,
        contractBuildingId: 'bldg-other',
        periodEndYmd: '2026-11-30',
        contractServicePrices: [],
        catalogItems: catalog,
      }),
      { unitPrice: 3800, priceSource: 'DEFAULT_CATALOG' }
    );
  });
});

test('Task 1.5 — resolveBillingDaysForDate & computeNextVietnamDailyRunMs (FR-066, Review Focus #4)', () => {
  assert.deepEqual(resolveBillingDaysForDate('2026-02-28'), [28, 29, 30, 31]);
  assert.deepEqual(resolveBillingDaysForDate('2028-02-28'), [28]);
  assert.deepEqual(resolveBillingDaysForDate('2028-02-29'), [29, 30, 31]);
  assert.deepEqual(resolveBillingDaysForDate('2026-04-30'), [30, 31]);
  assert.deepEqual(resolveBillingDaysForDate('2026-05-31'), [31]);
  assert.deepEqual(resolveBillingDaysForDate('2026-05-15'), [15]);

  // 2026-11-03T17:00:00Z = 2026-11-04 00:00:00 ICT -> 5 minutes until 00:05 ICT
  assert.equal(computeNextVietnamDailyRunMs(new Date('2026-11-03T17:00:00.000Z'), 0, 5), 5 * 60 * 1000);
  // 2026-11-03T17:10:00Z = 2026-11-04 00:10:00 ICT -> 23h55m until next 00:05 ICT
  assert.equal(computeNextVietnamDailyRunMs(new Date('2026-11-03T17:10:00.000Z'), 0, 5), (23 * 60 + 55) * 60 * 1000);
});

test('Task 1.6 — computeLateFeeAccrual grace days, waiver preservation, principal stop & cap (FR-064, Review Focus #3)', () => {
  // On due date (overdueDays = 0) -> not overdue
  const onDue = computeLateFeeAccrual({
    dueDateYmd: '2028-05-01',
    asOfDateYmd: '2028-05-01',
    totalAmount: 10000000,
    paidAmount: 0,
  });
  assert.equal(onDue.isOverdue, false);
  assert.equal(onDue.overdueDays, 0);
  assert.equal(onDue.deltaFee, 0);

  // Within 5 grace days (overdueDays = 5) -> overdue, 0 fee
  const graceDay5 = computeLateFeeAccrual({
    dueDateYmd: '2028-05-01',
    asOfDateYmd: '2028-05-06',
    totalAmount: 10000000,
    paidAmount: 0,
  });
  assert.equal(graceDay5.isOverdue, true);
  assert.equal(graceDay5.overdueDays, 5);
  assert.equal(graceDay5.chargeableDays, 0);
  assert.equal(graceDay5.expectedTotalLateFee, 0);
  assert.equal(graceDay5.deltaFee, 0);

  // Overdue day 6 -> 1 chargeable day = 100,000
  const day6 = computeLateFeeAccrual({
    dueDateYmd: '2028-05-01',
    asOfDateYmd: '2028-05-07',
    totalAmount: 10000000,
    paidAmount: 0,
  });
  assert.equal(day6.chargeableDays, 1);
  assert.equal(day6.expectedTotalLateFee, 100000);
  assert.equal(day6.deltaFee, 100000);

  // Overdue day 10 -> 5 chargeable days = 500,000 (PRD 18.1)
  const day10 = computeLateFeeAccrual({
    dueDateYmd: '2028-05-01',
    asOfDateYmd: '2028-05-11',
    totalAmount: 10000000,
    paidAmount: 0,
  });
  assert.equal(day10.chargeableDays, 5);
  assert.equal(day10.expectedTotalLateFee, 500000);

  // Partial payment still accrues; full payment stops
  const partial = computeLateFeeAccrual({
    dueDateYmd: '2028-05-01',
    asOfDateYmd: '2028-05-08',
    principalAmount: 10000000,
    totalAmount: 10000000,
    paidAmount: 3000000,
  });
  assert.equal(partial.expectedTotalLateFee, 200000);
  assert.equal(partial.deltaFee, 200000);

  const fullPaid = computeLateFeeAccrual({
    dueDateYmd: '2028-05-01',
    asOfDateYmd: '2028-05-15',
    principalAmount: 10000000,
    totalAmount: 10000000,
    paidAmount: 10000000,
  });
  assert.equal(fullPaid.isOverdue, false);
  assert.equal(fullPaid.deltaFee, 0);

  // Principal settled (10M principal paid, 200k prior late fee unpaid) -> never compounds penalty on penalty
  const principalDone = computeLateFeeAccrual({
    dueDateYmd: '2028-05-01',
    asOfDateYmd: '2028-05-13',
    principalAmount: 10000000,
    grossAccruedLateFee: 200000,
    totalAmount: 10200000,
    paidAmount: 10000000,
  });
  assert.equal(principalDone.principalSettled, true);
  assert.equal(principalDone.deltaFee, 0);

  // Approved 4-eyes waiver preserved: grossAccruedLateFee = 300k, -200k waiver, day 9 (expected 400k) -> delta = 100k
  const afterWaiverDay9 = computeLateFeeAccrual({
    dueDateYmd: '2028-05-01',
    asOfDateYmd: '2028-05-10',
    principalAmount: 10000000,
    totalAmount: 10100000,
    paidAmount: 0,
    grossAccruedLateFee: 300000,
  });
  assert.equal(afterWaiverDay9.expectedTotalLateFee, 400000);
  assert.equal(afterWaiverDay9.deltaFee, 100000);

  // Day 7 with grossAccruedLateFee = 300k (expected 200k < 300k) -> delta = 0
  const afterWaiverDay7 = computeLateFeeAccrual({
    dueDateYmd: '2028-05-01',
    asOfDateYmd: '2028-05-08',
    principalAmount: 10000000,
    totalAmount: 10100000,
    paidAmount: 0,
    grossAccruedLateFee: 300000,
  });
  assert.equal(afterWaiverDay7.deltaFee, 0);

  // Optional cap = 500,000 on overdueDays = 20
  const capped = computeLateFeeAccrual({
    dueDateYmd: '2028-05-01',
    asOfDateYmd: '2028-05-21',
    totalAmount: 10000000,
    paidAmount: 0,
    grossAccruedLateFee: 400000,
    maxLateFeeCap: 500000,
  });
  assert.equal(capped.capped, true);
  assert.equal(capped.expectedTotalLateFee, 500000);
  assert.equal(capped.deltaFee, 100000);
});

test('Task 1.7 — evaluateMeterReadingAnomaly 3-period rolling baseline & cold-start/vacant handling (FR-031, Review Focus #5)', () => {
  // Backward reading -> invalid
  const backward = evaluateMeterReadingAnomaly({
    previousReading: 500,
    currentReading: 499,
    recentConsumptions: [100, 100, 100],
  });
  assert.equal(backward.valid, false);
  assert.equal(backward.code, 'INVALID_READING');

  // Cold start (empty or all-zero vacant months) -> baselineAvg = null, isAbnormal = false
  const coldEmpty = evaluateMeterReadingAnomaly({
    previousReading: 0,
    currentReading: 120,
    recentConsumptions: [],
  });
  assert.equal(coldEmpty.valid, true);
  assert.equal(coldEmpty.consumption, 120);
  assert.equal(coldEmpty.baselineAvg, null);
  assert.equal(coldEmpty.isAbnormal, false);

  const coldZeros = evaluateMeterReadingAnomaly({
    previousReading: 100,
    currentReading: 250,
    recentConsumptions: [0, 0],
  });
  assert.equal(coldZeros.baselineAvg, null);
  assert.equal(coldZeros.isAbnormal, false);

  // Vacant month mixed with active months [0, 100, 110] -> mean of positive = 105
  const mixedVacant = evaluateMeterReadingAnomaly({
    previousReading: 500,
    currentReading: 605,
    recentConsumptions: [0, 100, 110],
  });
  assert.equal(mixedVacant.baselineAvg, 105);
  assert.equal(mixedVacant.varianceRatio, 0);
  assert.equal(mixedVacant.isAbnormal, false);

  // Exact +30.0% boundary against [90, 100, 110] (mean = 100) -> NOT abnormal (> 30% strictly)
  const exactBoundary = evaluateMeterReadingAnomaly({
    previousReading: 1000,
    currentReading: 1130,
    recentConsumptions: [90, 100, 110],
    thresholdRatio: 0.3,
  });
  assert.equal(exactBoundary.baselineAvg, 100);
  assert.equal(exactBoundary.isAbnormal, false);

  // +31.0% -> abnormal
  const spike = evaluateMeterReadingAnomaly({
    previousReading: 1000,
    currentReading: 1131,
    recentConsumptions: [90, 100, 110],
    thresholdRatio: 0.3,
  });
  assert.equal(spike.isAbnormal, true);
  assert.equal(spike.diffPct, 31);

  // -31.0% drop -> abnormal
  const drop = evaluateMeterReadingAnomaly({
    previousReading: 1000,
    currentReading: 1069,
    recentConsumptions: [90, 100, 110],
    thresholdRatio: 0.3,
  });
  assert.equal(drop.isAbnormal, true);
  assert.equal(drop.diffPct, -31);
});
