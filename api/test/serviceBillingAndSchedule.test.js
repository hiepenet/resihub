import test from 'node:test';
import assert from 'node:assert/strict';
import {
  todayVietnamYmd,
  currentVietnamPeriod,
  toDateOnlyYmd,
  addDaysYmd,
  diffDaysYmd,
  getMonthBoundsYmd,
  normalizeSubscriptionStatusInput,
  normalizeInvoiceStatusInput,
  resolveServiceUnitPrice,
  resolveSubscriptionEffectiveWindow,
  computeSubscriptionPeriodCharge,
  resolveContractLastActiveDay,
  computeContractRentPeriodCharge,
} from '../src/services/serviceBilling.js';
import { buildExpectedInvoiceSchedule } from '../src/services/invoiceSchedule.js';
import { buildContractTemplateServiceRows } from '../src/services/contractTemplate.js';
import { roundVND } from '../src/services/pricing.js';

test('1. Date helpers: Vietnam timezone, bounds, add/diff days', () => {
  // 18:00 UTC on Nov 2 is 01:00 UTC+7 on Nov 3 in Vietnam
  const utcDate = new Date('2026-11-02T18:00:00.000Z');
  assert.equal(todayVietnamYmd(utcDate), '2026-11-03');
  assert.equal(currentVietnamPeriod(utcDate), '2026-11');

  assert.equal(toDateOnlyYmd('2026-11-03T15:30:00Z'), '2026-11-03');
  assert.equal(toDateOnlyYmd(null), '');

  assert.equal(addDaysYmd('2026-11-03', 1), '2026-11-04');
  assert.equal(addDaysYmd('2028-06-15', -1), '2028-06-14');
  // Leap year Feb
  assert.equal(addDaysYmd('2028-02-28', 1), '2028-02-29');

  assert.equal(diffDaysYmd('2026-11-10', '2026-11-20'), 10);
  assert.equal(diffDaysYmd('2026-12-01', '2026-12-01'), 0);

  const boundsNov = getMonthBoundsYmd('2026-11');
  assert.deepEqual(boundsNov, {
    monthStart: '2026-11-01',
    monthEnd: '2026-11-30',
    daysInMonth: 30,
  });

  const boundsFebLeap = getMonthBoundsYmd('2028-02');
  assert.deepEqual(boundsFebLeap, {
    monthStart: '2028-02-01',
    monthEnd: '2028-02-29',
    daysInMonth: 29,
  });
});

test('2. Status normalizers: subscription and invoice status inputs', () => {
  assert.equal(normalizeSubscriptionStatusInput('CANCELLED'), 'TERMINATED');
  assert.equal(normalizeSubscriptionStatusInput('cancelled'), 'TERMINATED');
  assert.equal(normalizeSubscriptionStatusInput('ACTIVE'), 'ACTIVE');
  assert.equal(normalizeSubscriptionStatusInput('PENDING_APPROVAL'), 'PENDING_APPROVAL');
  assert.equal(normalizeSubscriptionStatusInput('CANCELLATION_PENDING'), 'CANCELLATION_PENDING');
  assert.equal(normalizeSubscriptionStatusInput('TERMINATED'), 'TERMINATED');
  assert.equal(normalizeSubscriptionStatusInput('REJECTED'), 'REJECTED');

  assert.equal(normalizeInvoiceStatusInput('CANCELLED'), 'VOID');
  assert.equal(normalizeInvoiceStatusInput('cancelled'), 'VOID');
  assert.equal(normalizeInvoiceStatusInput('DRAFT'), 'DRAFT');
  assert.equal(normalizeInvoiceStatusInput('ISSUED'), 'ISSUED');
  assert.equal(normalizeInvoiceStatusInput('PARTIALLY_PAID'), 'PARTIALLY_PAID');
  assert.equal(normalizeInvoiceStatusInput('PAID'), 'PAID');
  assert.equal(normalizeInvoiceStatusInput('OVERDUE'), 'OVERDUE');
  assert.equal(normalizeInvoiceStatusInput('ADJUSTED'), 'ADJUSTED');
  assert.equal(normalizeInvoiceStatusInput('VOID'), 'VOID');
});

test('3. Pre-start cancellation: activeDays = 0, amount = 0; single-day activeDays = 1', () => {
  // Pre-start: start_date = 2026-12-01, end_date = 2026-11-30, status = TERMINATED
  const preSub = {
    service_code: 'CLEANING',
    start_date: '2026-12-01',
    end_date: '2026-11-30',
    status: 'TERMINATED',
    unit_price: 300000,
    quantity: 1,
  };
  const preWin = resolveSubscriptionEffectiveWindow(preSub);
  assert.equal(preWin.billable, false);

  const preCharge = computeSubscriptionPeriodCharge({
    subscription: preSub,
    periodYm: '2026-12',
  });
  assert.equal(preCharge.activeDays, 0);
  assert.equal(preCharge.amount, 0);
  assert.equal(preCharge.rawAmount, 0);
  assert.equal(preCharge.overlapStart, null);
  assert.equal(preCharge.overlapEnd, null);
  assert.deepEqual(preCharge.formulaMeta, {
    billing_mode: 'FULL',
    price_source: 'DEFAULT_CATALOG',
    unit_price: 300000,
    quantity: 1,
    active_days: 0,
    days_in_month: 31,
    overlap_start: null,
    overlap_end: null,
    raw_amount: 0,
    rounded_amount: 0,
  });

  // Single-day: start_date = 2026-12-01, end_date = 2026-12-01, status = TERMINATED
  const singleSub = {
    service_code: 'CLEANING',
    start_date: '2026-12-01',
    end_date: '2026-12-01',
    status: 'TERMINATED',
    unit_price: 310000,
    quantity: 1,
    is_price_locked: true,
  };
  const singleWin = resolveSubscriptionEffectiveWindow(singleSub);
  assert.equal(singleWin.billable, true);
  assert.equal(singleWin.effectiveStart, '2026-12-01');
  assert.equal(singleWin.effectiveEnd, '2026-12-01');

  const singleCharge = computeSubscriptionPeriodCharge({
    subscription: singleSub,
    periodYm: '2026-12',
  });
  assert.equal(singleCharge.activeDays, 1);
  assert.equal(singleCharge.daysInMonth, 31);
  assert.equal(singleCharge.isProrated, true);
  assert.equal(singleCharge.unitPrice, 310000);
  assert.equal(singleCharge.priceSource, 'SUBSCRIPTION_LOCKED');
  assert.equal(singleCharge.amount, roundVND((310000 * 1) / 31));
  assert.equal(singleCharge.amount, 10000);
  assert.equal(singleCharge.overlapStart, '2026-12-01');
  assert.equal(singleCharge.overlapEnd, '2026-12-01');
  assert.deepEqual(singleCharge.formulaMeta, {
    billing_mode: 'PRORATED',
    price_source: 'SUBSCRIPTION_LOCKED',
    unit_price: 310000,
    quantity: 1,
    active_days: 1,
    days_in_month: 31,
    overlap_start: '2026-12-01',
    overlap_end: '2026-12-01',
    raw_amount: (310000 * 1) / 31,
    rounded_amount: 10000,
  });
});

test('4. Mid-month subscribe + same-month cancel: 10/11 -> 20/11 (activeDays = 11, amount = 110_000, NOT 200_000)', () => {
  const sub = {
    service_code: 'INTERNET',
    service_name: 'Gói Internet Wifi',
    start_date: '2026-11-10',
    end_date: '2026-11-20',
    status: 'TERMINATED',
    unit_price: 300000,
    quantity: 1,
    is_price_locked: true,
  };

  const charge = computeSubscriptionPeriodCharge({
    subscription: sub,
    periodYm: '2026-11',
  });

  // 2026-11-10 to 2026-11-20 inclusive is 11 days (Nov has 30 days)
  assert.equal(charge.activeDays, 11);
  assert.equal(charge.daysInMonth, 30);
  assert.equal(charge.isProrated, true);
  assert.equal(charge.unitPrice, 300000);
  assert.equal(charge.quantity, 1);
  assert.equal(charge.rawAmount, 110000);
  assert.equal(charge.amount, 110000);
  assert.notEqual(charge.amount, 200000);
  assert.equal(charge.overlapStart, '2026-11-10');
  assert.equal(charge.overlapEnd, '2026-11-20');
  assert.equal(charge.formulaMeta.active_days, 11);
  assert.equal(charge.formulaMeta.rounded_amount, 110000);
  assert.equal(charge.formulaMeta.billing_mode, 'PRORATED');
});

test('5. 5-month usage + mid-month-6 cancel (2026-01-01 .. 2026-06-15): months 1..5 full, month 6 15/30 pro-rata, month 7 0₫, and buildExpectedInvoiceSchedule preserves months 1..5', () => {
  const sub = {
    id: 'sub-gym',
    service_code: 'GYM_MEMBERSHIP',
    service_name: 'Thẻ Gym',
    billing_type: 'FIXED',
    start_date: '2026-01-01',
    end_date: '2026-06-15',
    status: 'TERMINATED',
    unit_price: 600000,
    quantity: 1,
    is_price_locked: true,
  };

  // Check month 1..5 full charges
  for (const m of ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05']) {
    const charge = computeSubscriptionPeriodCharge({
      subscription: sub,
      periodYm: m,
    });
    assert.equal(charge.isProrated, false, `Month ${m} should be full`);
    assert.equal(charge.amount, 600000, `Month ${m} should be 600,000`);
    assert.equal(charge.activeDays, charge.daysInMonth);
  }

  // Check month 6: June has 30 days, June 1..15 is 15 active days
  const chargeM6 = computeSubscriptionPeriodCharge({
    subscription: sub,
    periodYm: '2026-06',
  });
  assert.equal(chargeM6.activeDays, 15);
  assert.equal(chargeM6.daysInMonth, 30);
  assert.equal(chargeM6.isProrated, true);
  assert.equal(chargeM6.amount, 300000); // 600,000 * 15 / 30

  // Check month 7: 0 active days, 0₫
  const chargeM7 = computeSubscriptionPeriodCharge({
    subscription: sub,
    periodYm: '2026-07',
  });
  assert.equal(chargeM7.activeDays, 0);
  assert.equal(chargeM7.amount, 0);

  // Now verify buildExpectedInvoiceSchedule preserves historical periods 1..5
  const contract = {
    id: 'contract-5m',
    status: 'ACTIVE',
    start_date: '2026-01-01',
    end_date: '2026-08-01',
    rent_amount: 10000000,
    billing_cycle: 'monthly',
    billing_day: 1,
    payment_due_days: 5,
  };

  const schedule = buildExpectedInvoiceSchedule({
    contract,
    subscriptions: [sub],
    servicePrices: [],
    existingInvoices: [],
  });

  assert.equal(schedule.length, 7); // Jan..Jul (7 months)
  // Months 1..5 have full fixed service charges
  for (let i = 0; i < 5; i++) {
    assert.equal(schedule[i].expected_fixed_services, 600000, `Schedule month ${i + 1} expected_fixed_services must be 600,000`);
    assert.equal(schedule[i].expected_total, 10600000);
  }
  // Month 6 (June) has 15/30 pro-rated service = 300,000
  assert.equal(schedule[5].billing_period, '2026-06');
  assert.equal(schedule[5].expected_fixed_services, 300000);
  assert.equal(schedule[5].expected_total, 10300000);

  // Month 7 (July) has 0 service charges
  assert.equal(schedule[6].billing_period, '2026-07');
  assert.equal(schedule[6].expected_fixed_services, 0);
  assert.equal(schedule[6].expected_total, 10000000);
});

test('6. Review Focus #3: FR-065 3-tier pricing resolution, is_price_locked symmetry & bidirectional aliases', () => {
  const catalogItems = [
    { code: 'INTERNET', unit_price: 150000, building_id: null },
    { code: 'COMMON_SERVICE', unit_price: 150000, building_id: 'bld-1' },
    { code: 'MOTORBIKE_PARKING', unit_price: 100000, building_id: null },
  ];

  const contractServicePrices = [
    { service_code: 'INTERNET', unit_price: 120000, effective_from: '2026-11-01' },
    { service_code: 'MANAGEMENT_FEE', unit_price: 130000, effective_from: '2026-11-01' },
    { service_code: 'PARKING_MOTO', unit_price: 80000, effective_from: '2026-12-01' }, // not effective in Nov
  ];

  // A. is_price_locked === false resolves default catalog (150_000) when no override
  const subUnlocked = {
    service_code: 'INTERNET_FIBER',
    unit_price: 250000,
    is_price_locked: false,
  };
  // With contract override effective in Nov, CONTRACT_OVERRIDE takes precedence:
  const resOverride = resolveServiceUnitPrice({
    subscription: subUnlocked,
    contractBuildingId: 'bld-1',
    periodEndYmd: '2026-11-30',
    contractServicePrices,
    catalogItems,
  });
  assert.equal(resOverride.priceSource, 'CONTRACT_OVERRIDE');
  assert.equal(resOverride.unitPrice, 120000);

  // B. When no contract override matches, is_price_locked === false resolves catalog:
  const resCatalogDefault = resolveServiceUnitPrice({
    subscription: subUnlocked,
    contractBuildingId: 'bld-1',
    periodEndYmd: '2026-10-31', // before effective_from of contractServicePrices
    contractServicePrices,
    catalogItems,
  });
  assert.equal(resCatalogDefault.priceSource, 'DEFAULT_CATALOG');
  assert.equal(resCatalogDefault.unitPrice, 150000);

  // C. Building catalog override matches building_id and alias COMMON_SERVICE <-> MANAGEMENT_FEE
  const subMgmtUnlocked = {
    service_code: 'MANAGEMENT_FEE',
    unit_price: 200000,
    is_price_locked: false,
  };
  const resCatalogBuilding = resolveServiceUnitPrice({
    subscription: subMgmtUnlocked,
    contractBuildingId: 'bld-1',
    periodEndYmd: '2026-10-31', // before contract override
    contractServicePrices,
    catalogItems,
  });
  assert.equal(resCatalogBuilding.priceSource, 'BUILDING_CATALOG');
  assert.equal(resCatalogBuilding.unitPrice, 150000);

  // D. is_price_locked === true preserves sub.unit_price when no contract override
  const subLocked = {
    service_code: 'INTERNET_FIBER',
    unit_price: 250000,
    is_price_locked: true,
  };
  const resLocked = resolveServiceUnitPrice({
    subscription: subLocked,
    contractBuildingId: 'bld-1',
    periodEndYmd: '2026-10-31',
    contractServicePrices,
    catalogItems,
  });
  assert.equal(resLocked.priceSource, 'SUBSCRIPTION_LOCKED');
  assert.equal(resLocked.unitPrice, 250000);

  // E. Bidirectional aliases: PARKING_MOTO <-> MOTORBIKE_PARKING
  // Contract has PARKING_MOTO effective 2026-12-01. Sub has MOTORBIKE_PARKING.
  const subParking = {
    service_code: 'MOTORBIKE_PARKING',
    unit_price: 110000,
    is_price_locked: true,
  };
  // In Dec: contract override is active
  const resParkingDec = resolveServiceUnitPrice({
    subscription: subParking,
    contractBuildingId: 'bld-1',
    periodEndYmd: '2026-12-31',
    contractServicePrices,
    catalogItems,
  });
  assert.equal(resParkingDec.priceSource, 'CONTRACT_OVERRIDE');
  assert.equal(resParkingDec.unitPrice, 80000);

  // In Nov: contract override not yet active, locked price wins
  const resParkingNov = resolveServiceUnitPrice({
    subscription: subParking,
    contractBuildingId: 'bld-1',
    periodEndYmd: '2026-11-30',
    contractServicePrices,
    catalogItems,
  });
  assert.equal(resParkingNov.priceSource, 'SUBSCRIPTION_LOCKED');
  assert.equal(resParkingNov.unitPrice, 110000);
});

test('7. Review Focus #3: buildContractTemplateServiceRows Điều 5 deduplication with TERMINATED subscription', () => {
  // A TERMINATED INTERNET_FIBER subscription + contract_service_price for INTERNET
  // MUST omit the terminated service from Điều 5!
  const rows = buildContractTemplateServiceRows({
    contractStartDate: '2026-11-01',
    subscriptions: [
      {
        service_code: 'INTERNET_FIBER',
        service_name: 'Internet Cáp Quang',
        billing_type: 'FIXED',
        unit_price: 200000,
        status: 'TERMINATED', // terminated!
      },
      {
        service_code: 'MOTORBIKE_PARKING',
        service_name: 'Gửi xe máy',
        billing_type: 'QUANTITY',
        unit_price: 120000,
        quantity: 1,
        status: 'ACTIVE',
      },
    ],
    servicePrices: [
      { service_code: 'INTERNET', unit_price: 180000, effective_from: '2026-11-01' },
    ],
    meters: [],
    utilityCatalog: [],
  });

  // Only MOTORBIKE_PARKING should appear. INTERNET / INTERNET_FIBER must be omitted!
  const internetRow = rows.find((r) => r.code === 'INTERNET' || r.code === 'INTERNET_FIBER');
  assert.equal(internetRow, undefined, 'Terminated INTERNET_FIBER must not appear in Điều 5 even with INTERNET price override');

  const parkingRow = rows.find((r) => r.code === 'MOTORBIKE_PARKING');
  assert.ok(parkingRow, 'Active MOTORBIKE_PARKING must be present');
});

test('8. Review Focus #3: Future room-transfer cutoff ignores clamped terminated_at in resolveContractLastActiveDay AND buildExpectedInvoiceSchedule', () => {
  // Contract has terminated_at = 2026-11-03 (clamped to today by M06)
  // roomTransferChildStartDate = 2028-06-15
  const contract = {
    id: 'old-contract-123',
    status: 'TERMINATED',
    start_date: '2026-06-15',
    end_date: '2028-06-15',
    terminated_at: '2026-11-03', // clamped!
    rent_amount: 12000000,
    billing_cycle: 'monthly',
    billing_day: 1,
    payment_due_days: 5,
  };

  // A. resolveContractLastActiveDay must return 2028-06-14 (ignoring 2026-11-03)
  const resLastActive = resolveContractLastActiveDay(contract, {
    roomTransferChildStartDate: '2028-06-15',
    isRoomTransfer: true,
  });
  assert.equal(resLastActive.movedIn, true);
  assert.equal(resLastActive.lastActiveDayYmd, '2028-06-14');

  // Also when passed via explicitEndYmd with isRoomTransfer: true
  const resExplicit = resolveContractLastActiveDay(contract, {
    explicitEndYmd: '2028-06-15',
    isRoomTransfer: true,
  });
  assert.equal(resExplicit.lastActiveDayYmd, '2028-06-14');

  // computeContractRentPeriodCharge for 2028-06: 14 active days out of 30
  const rentJune = computeContractRentPeriodCharge({
    contract,
    periodYm: '2028-06',
    lastActiveDayYmd: resLastActive.lastActiveDayYmd,
  });
  assert.equal(rentJune.activeDays, 14);
  assert.equal(rentJune.daysInMonth, 30);
  assert.equal(rentJune.isProrated, true);
  assert.equal(rentJune.amount, roundVND((12000000 * 14) / 30));
  assert.equal(rentJune.amount, 5600000);
  assert.deepEqual(rentJune.formulaMeta, {
    billing_mode: 'PRORATED',
    price_source: 'CONTRACT_RENT',
    unit_price: 12000000,
    quantity: 1,
    active_days: 14,
    days_in_month: 30,
    overlap_start: '2028-06-01',
    overlap_end: '2028-06-14',
    raw_amount: (12000000 * 14) / 30,
    rounded_amount: 5600000,
  });

  // B. buildExpectedInvoiceSchedule must produce periods up to 2028-06, and 2028-06 must have 14/30 active days
  const schedule = buildExpectedInvoiceSchedule({
    contract,
    roomTransferChildStartDate: '2028-06-15',
    subscriptions: [],
    servicePrices: [],
    existingInvoices: [],
  });

  assert.ok(schedule.length > 0, 'Schedule must not be empty');
  const lastSlice = schedule[schedule.length - 1];
  assert.equal(lastSlice.billing_period, '2028-06');
  assert.equal(lastSlice.period_start, '2028-06-01');
  assert.equal(lastSlice.period_end, '2028-06-14');
  assert.equal(lastSlice.is_prorated, true);
  assert.equal(lastSlice.expected_rent, 5600000);
});

test('9. Invoice schedule actual_invoice filtering: excludes VOID and CANCELLED, includes ADJUSTED', () => {
  const contract = {
    id: 'contract-inv-filter',
    status: 'ACTIVE',
    start_date: '2026-11-01',
    end_date: '2027-02-01',
    rent_amount: 5000000,
    billing_cycle: 'monthly',
    billing_day: 1,
    payment_due_days: 5,
  };

  const existingInvoices = [
    { id: 'inv-nov', period: '2026-11', status: 'ADJUSTED', total_amount: 4800000 },
    { id: 'inv-dec', period: '2026-12', status: 'VOID', total_amount: 5000000 },
    { id: 'inv-jan', period: '2027-01', status: 'CANCELLED', total_amount: 5000000 },
  ];

  const schedule = buildExpectedInvoiceSchedule({
    contract,
    subscriptions: [],
    servicePrices: [],
    existingInvoices,
  });

  assert.equal(schedule.length, 3);
  // Nov matches ADJUSTED
  assert.equal(schedule[0].billing_period, '2026-11');
  assert.ok(schedule[0].actual_invoice);
  assert.equal(schedule[0].actual_invoice.id, 'inv-nov');
  assert.equal(schedule[0].actual_invoice.status, 'ADJUSTED');

  // Dec had VOID invoice -> should be null
  assert.equal(schedule[1].billing_period, '2026-12');
  assert.equal(schedule[1].actual_invoice, null);

  // Jan had CANCELLED invoice -> should be null
  assert.equal(schedule[2].billing_period, '2027-01');
  assert.equal(schedule[2].actual_invoice, null);
});

test('11. PENDING_APPROVAL subscription is excluded by default in computeSubscriptionPeriodCharge, but included when includePendingApproval: true (projected schedule)', () => {
  const pendingSub = {
    id: 'sub-pending',
    service_code: 'PARKING_CAR',
    service_name: 'Gửi xe ô tô',
    billing_type: 'FIXED',
    start_date: '2026-11-01',
    status: 'PENDING_APPROVAL',
    unit_price: 1200000,
    quantity: 1,
    is_price_locked: true,
  };

  // Default call: includePendingApproval is false
  const defaultCharge = computeSubscriptionPeriodCharge({
    subscription: pendingSub,
    periodYm: '2026-11',
  });
  assert.equal(defaultCharge.amount, 0, 'PENDING_APPROVAL must not be billed on actual invoice by default');
  assert.equal(defaultCharge.activeDays, 0);

  // Projected schedule call: includePendingApproval is true
  const projectedCharge = computeSubscriptionPeriodCharge({
    subscription: pendingSub,
    periodYm: '2026-11',
    includePendingApproval: true,
  });
  assert.equal(projectedCharge.amount, 1200000, 'PENDING_APPROVAL must be included in projected invoice schedule');
  assert.equal(projectedCharge.activeDays, 30);

  // Verify in buildExpectedInvoiceSchedule
  const contract = {
    id: 'contract-pending-sub',
    status: 'ACTIVE',
    start_date: '2026-11-01',
    end_date: '2026-12-01',
    rent_amount: 5000000,
    billing_cycle: 'monthly',
    billing_day: 1,
    payment_due_days: 5,
  };

  const schedule = buildExpectedInvoiceSchedule({
    contract,
    subscriptions: [pendingSub],
    servicePrices: [],
    existingInvoices: [],
  });

  assert.equal(schedule.length, 1);
  assert.equal(schedule[0].expected_fixed_services, 1200000);
  assert.equal(schedule[0].expected_total, 6200000);
});
