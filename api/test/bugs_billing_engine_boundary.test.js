/**
 * BUG-HUNT: Billing Engine Boundary Tests
 * Tests designed to find bugs in serviceBilling.js edge cases.
 * Run: node --test api/test/bugs_billing_engine_boundary.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  todayVietnamYmd,
  getMonthBoundsYmd,
  addDaysYmd,
  diffDaysYmd,
  resolveServiceUnitPrice,
  resolveSubscriptionEffectiveWindow,
  computeSubscriptionPeriodCharge,
  computeContractRentPeriodCharge,
  computeLateFeeAccrual,
  evaluateMeterReadingAnomaly,
  resolveBillingDaysForDate,
} from '../src/services/serviceBilling.js';
import {
  syncSubscriptionTerminationInvoicesInTx,
  syncSubscriptionActivationInvoicesInTx,
  collectPriorUnbilledSubscriptionArrearsLinesInTx,
} from '../src/services/invoiceLifecycle.js';

// ─────────────────────────────────────────────────────────────────────────────
// GROUP B1 — getMonthBoundsYmd
// BUG TIỀM NĂNG:
//   - 2024 là năm nhuận → tháng 2 có 29 ngày
//   - 2023 không nhuận → tháng 2 có 28 ngày
//   - Code dùng: new Date(Date.UTC(y, m, 0)).getUTCDate() → đây là ngày cuối của tháng m-1 → sai???
//     Thực ra: Date.UTC(y, m, 0) = ngày 0 của tháng m = ngày cuối của tháng m-1 = ngày cuối của tháng thực
//     Vì m = 2 → tháng 2 (0-indexed), Date.UTC(y, 2, 0) = ngày cuối tháng 1 (0-indexed) = ngày cuối tháng 2 (1-indexed) ✓
//   - Falsy input → dùng currentVietnamPeriod()
// ─────────────────────────────────────────────────────────────────────────────
test('BUG-HUNT B1: getMonthBoundsYmd leap year & boundary', async (t) => {

  await t.test('"2024-02" → daysInMonth=29 (năm nhuận)', () => {
    const { daysInMonth, monthStart, monthEnd } = getMonthBoundsYmd('2024-02');
    assert.equal(daysInMonth, 29, 'BUG: 2024 là năm nhuận, tháng 2 phải có 29 ngày');
    assert.equal(monthStart, '2024-02-01');
    assert.equal(monthEnd, '2024-02-29');
  });

  await t.test('"2023-02" → daysInMonth=28 (không nhuận)', () => {
    const { daysInMonth, monthEnd } = getMonthBoundsYmd('2023-02');
    assert.equal(daysInMonth, 28, 'BUG: 2023 không nhuận, tháng 2 phải có 28 ngày');
    assert.equal(monthEnd, '2023-02-28');
  });

  await t.test('"2026-01" → daysInMonth=31', () => {
    const { daysInMonth } = getMonthBoundsYmd('2026-01');
    assert.equal(daysInMonth, 31);
  });

  await t.test('"2026-04" → daysInMonth=30', () => {
    const { daysInMonth } = getMonthBoundsYmd('2026-04');
    assert.equal(daysInMonth, 30);
  });

  await t.test('falsy input → không throw, dùng current period', () => {
    assert.doesNotThrow(() => {
      const r = getMonthBoundsYmd(null);
      assert.ok(r.daysInMonth >= 28 && r.daysInMonth <= 31, 'daysInMonth phải trong [28,31]');
    });
    assert.doesNotThrow(() => getMonthBoundsYmd(''));
    assert.doesNotThrow(() => getMonthBoundsYmd(undefined));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GROUP B2 — addDaysYmd
// BUG TIỀM NĂNG:
//   - Tháng lẻ → tự động roll over sang tháng tiếp
//   - '2026-12-31' + 1 → '2027-01-01' (năm mới)
//   - Số ngày âm → tính ngược
//   - Falsy input → ''
// ─────────────────────────────────────────────────────────────────────────────
test('BUG-HUNT B2: addDaysYmd boundary', async (t) => {

  await t.test('"2026-01-31" + 1 → "2026-02-01"', () => {
    assert.equal(addDaysYmd('2026-01-31', 1), '2026-02-01');
  });

  await t.test('"2026-02-28" + 1 (không nhuận) → "2026-03-01"', () => {
    assert.equal(addDaysYmd('2026-02-28', 1), '2026-03-01');
  });

  await t.test('"2026-12-31" + 1 → "2027-01-01"', () => {
    assert.equal(addDaysYmd('2026-12-31', 1), '2027-01-01');
  });

  await t.test('"" + 5 → ""', () => {
    // BUG TIỀM NĂNG: `if (!ymd) return ''` → ok
    assert.equal(addDaysYmd('', 5), '');
  });

  await t.test('addDaysYmd("2026-01-15", -15) → "2025-12-31"', () => {
    // 2026-01-15 - 15 ngày = 2025-12-31
    assert.equal(addDaysYmd('2026-01-15', -15), '2025-12-31');
  });

  await t.test('"2024-02-28" + 1 (nhuận) → "2024-02-29"', () => {
    assert.equal(addDaysYmd('2024-02-28', 1), '2024-02-29');
  });

  await t.test('"2024-02-29" + 1 (sau ngày cuối tháng 2 nhuận) → "2024-03-01"', () => {
    assert.equal(addDaysYmd('2024-02-29', 1), '2024-03-01');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GROUP B3 — computeContractRentPeriodCharge
// BUG TIỀM NĂNG:
//   - Full month: activeDays = diffDaysYmd(overlapStart, overlapEnd) + 1 → phải = daysInMonth
//   - Mid-month move-in: start=16/5, period 05/2026 (31 ngày) → activeDays = 31-16+1 = 16
//   - Move-out ngày 10: lastActiveDayYmd='2026-06-10' → overlapEnd = min('2026-06-10','2026-06-30') = '2026-06-10'
//   - Contract END trước kỳ: overlapStart > overlapEnd → activeDays=0
//   - Contract START sau kỳ: same guard
//   - lastActiveDayYmd override: thay contract.terminated_at bằng custom date
// ─────────────────────────────────────────────────────────────────────────────
test('BUG-HUNT B3: computeContractRentPeriodCharge pro-rata boundary', async (t) => {

  await t.test('Full month: start trước kỳ, end sau kỳ → activeDays=30, amount=10M', () => {
    // Kỳ 2026-11 (30 ngày), contract từ 2026-01-01 đến 2027-01-01
    // overlapStart = max('2026-01-01','2026-11-01') = '2026-11-01'
    // overlapEnd = min('2026-12-31','2026-11-30') = '2026-11-30'
    // activeDays = diffDays('2026-11-01','2026-11-30')+1 = 29+1 = 30 = daysInMonth → not prorated
    const r = computeContractRentPeriodCharge({
      contract: { start_date: '2026-01-01', end_date: '2027-01-01', rent_amount: 10_000_000 },
      periodYm: '2026-11',
      lastActiveDayYmd: '2026-12-31', // contract still active
    });
    assert.equal(r.activeDays, 30);
    assert.equal(r.amount, 10_000_000, 'Full month → full price không pro-rata');
    assert.equal(r.isProrated, false);
  });

  await t.test('Mid-month move-in: start=2026-05-16, period=2026-05 (31 ngày) → activeDays=16', async () => {
    // overlapStart = max('2026-05-16','2026-05-01') = '2026-05-16'
    // overlapEnd = min(lastActiveDay, '2026-05-31') = '2026-05-31'
    // activeDays = diffDays('2026-05-16','2026-05-31')+1 = 15+1 = 16
    const rent = 31_000_000;
    const r = computeContractRentPeriodCharge({
      contract: { start_date: '2026-05-16', rent_amount: rent },
      periodYm: '2026-05',
      lastActiveDayYmd: '2027-05-15', // contract còn hạn
    });
    assert.equal(r.activeDays, 16);
    assert.equal(r.daysInMonth, 31);
    // expected = roundVND(31M * 16/31)
    const { roundVND } = await import('../src/services/pricing.js');
    const expected = roundVND(rent * 16 / 31);
    assert.equal(r.amount, expected, `BUG: amount phải = roundVND(${rent}*16/31) = ${expected}`);
  });

  await t.test('Move-out ngày 10/6 (30 ngày): lastActiveDayYmd=2026-06-10 → activeDays=10', async () => {
    // overlapStart = max('2026-01-01','2026-06-01') = '2026-06-01'
    // overlapEnd = min('2026-06-10','2026-06-30') = '2026-06-10'
    // activeDays = diffDays('2026-06-01','2026-06-10')+1 = 9+1 = 10
    const rent = 10_000_000;
    const r = computeContractRentPeriodCharge({
      contract: { start_date: '2026-01-01', rent_amount: rent },
      periodYm: '2026-06',
      lastActiveDayYmd: '2026-06-10',
    });
    assert.equal(r.activeDays, 10);
    assert.equal(r.daysInMonth, 30);
    const { roundVND } = await import('../src/services/pricing.js');
    const expected = roundVND(rent * 10 / 30);
    assert.equal(r.amount, expected);
  });

  await t.test('Contract END trước kỳ: end=2026-04-30, period=2026-05 → activeDays=0, amount=0', () => {
    // lastActiveDayYmd = '2026-04-30' < monthStart '2026-05-01' → overlapStart > overlapEnd → 0
    const r = computeContractRentPeriodCharge({
      contract: { start_date: '2026-01-01', rent_amount: 10_000_000 },
      periodYm: '2026-05',
      lastActiveDayYmd: '2026-04-30',
    });
    assert.equal(r.activeDays, 0);
    assert.equal(r.amount, 0, 'Contract đã kết thúc trước kỳ → amount=0');
  });

  await t.test('Contract START sau kỳ: start=2026-07-01, period=2026-05 → amount=0', () => {
    // startYmd = '2026-07-01' > monthEnd '2026-05-31' → overlapStart > overlapEnd → 0
    const r = computeContractRentPeriodCharge({
      contract: { start_date: '2026-07-01', rent_amount: 10_000_000 },
      periodYm: '2026-05',
      lastActiveDayYmd: '2027-06-30',
    });
    assert.equal(r.activeDays, 0);
    assert.equal(r.amount, 0, 'Contract chưa bắt đầu trong kỳ → amount=0');
  });

  await t.test('1 ngày duy nhất: start=end=2026-11-15, period=2026-11', () => {
    // activeDays = diffDays('2026-11-15','2026-11-15')+1 = 0+1 = 1
    const rent = 10_000_000;
    const r = computeContractRentPeriodCharge({
      contract: { start_date: '2026-11-15', rent_amount: rent },
      periodYm: '2026-11',
      lastActiveDayYmd: '2026-11-15',
    });
    assert.equal(r.activeDays, 1);
    assert.ok(r.amount > 0, 'BUG: 1 ngày phải có amount > 0');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GROUP B4 — resolveServiceUnitPrice (3-tier priority)
// BUG TIỀM NĂNG:
//   - CONTRACT_OVERRIDE phải thắng BUILDING_CATALOG và DEFAULT_CATALOG
//   - effective_from trong tương lai (> periodEndYmd) KHÔNG được áp dụng
//   - effective_from = periodEndYmd được áp dụng (<= periodEndYmd)
//   - is_price_locked=true → SUBSCRIPTION_LOCKED nếu không có CONTRACT_OVERRIDE
//   - is_active=false bị bỏ qua
//   - 'ELECTRICITY' và 'ELEC' là alias → cùng được match
// ─────────────────────────────────────────────────────────────────────────────
test('BUG-HUNT B4: resolveServiceUnitPrice 3-tier priority', async (t) => {

  const baseSub = { service_code: 'ELECTRICITY', unit_price: 3000, is_price_locked: false };

  await t.test('CONTRACT_OVERRIDE > BUILDING_CATALOG > DEFAULT_CATALOG', () => {
    const r = resolveServiceUnitPrice({
      subscription: baseSub,
      contractBuildingId: 'bld-1',
      periodEndYmd: '2026-11-30',
      contractServicePrices: [
        { service_code: 'ELECTRICITY', unit_price: 5000, effective_from: '2026-01-01' },
      ],
      catalogItems: [
        { code: 'ELECTRICITY', unit_price: 4000, building_id: 'bld-1', is_active: true },
        { code: 'ELECTRICITY', unit_price: 3500, building_id: null, is_active: true },
      ],
    });
    assert.equal(r.priceSource, 'CONTRACT_OVERRIDE', 'CONTRACT_OVERRIDE phải thắng');
    assert.equal(r.unitPrice, 5000);
  });

  await t.test('effective_from trong tương lai → KHÔNG áp dụng CONTRACT_OVERRIDE', () => {
    // periodEndYmd = '2026-11-30', effective_from = '2026-12-01' > '2026-11-30' → bị loại
    const r = resolveServiceUnitPrice({
      subscription: baseSub,
      periodEndYmd: '2026-11-30',
      contractServicePrices: [
        { service_code: 'ELECTRICITY', unit_price: 9000, effective_from: '2026-12-01' }, // future!
      ],
      catalogItems: [
        { code: 'ELECTRICITY', unit_price: 3500, building_id: null, is_active: true },
      ],
    });
    assert.notEqual(r.priceSource, 'CONTRACT_OVERRIDE',
      'BUG: effective_from tương lai không được áp dụng!');
    assert.equal(r.unitPrice, 3500, 'Phải dùng catalog');
  });

  await t.test('effective_from === periodEndYmd được áp dụng (<=)', () => {
    // periodEndYmd = '2026-11-30', effective_from = '2026-11-30' → eff <= periodEndYmd → OK
    const r = resolveServiceUnitPrice({
      subscription: baseSub,
      periodEndYmd: '2026-11-30',
      contractServicePrices: [
        { service_code: 'ELECTRICITY', unit_price: 7000, effective_from: '2026-11-30' },
      ],
      catalogItems: [],
    });
    assert.equal(r.priceSource, 'CONTRACT_OVERRIDE',
      'BUG: effective_from = periodEndYmd phải được áp dụng');
    assert.equal(r.unitPrice, 7000);
  });

  await t.test('is_price_locked=true → SUBSCRIPTION_LOCKED nếu không có CONTRACT_OVERRIDE', () => {
    const lockedSub = { ...baseSub, is_price_locked: true, unit_price: 8000 };
    const r = resolveServiceUnitPrice({
      subscription: lockedSub,
      periodEndYmd: '2026-11-30',
      contractServicePrices: [],
      catalogItems: [
        { code: 'ELECTRICITY', unit_price: 3500, building_id: null, is_active: true },
      ],
    });
    assert.equal(r.priceSource, 'SUBSCRIPTION_LOCKED',
      'BUG: is_price_locked → SUBSCRIPTION_LOCKED phải thắng catalog');
    assert.equal(r.unitPrice, 8000);
  });

  await t.test('Catalog item is_active=false bị bỏ qua', () => {
    const r = resolveServiceUnitPrice({
      subscription: { ...baseSub, unit_price: 2000 },
      periodEndYmd: '2026-11-30',
      contractServicePrices: [],
      catalogItems: [
        { code: 'ELECTRICITY', unit_price: 9999, building_id: null, is_active: false }, // inactive!
      ],
    });
    // Không có active catalog → fallback to subscription unit_price
    assert.notEqual(r.unitPrice, 9999, 'BUG: is_active=false phải bị bỏ qua!');
  });

  await t.test('Alias: "ELECTRICITY" và "ELEC" là cùng service', () => {
    // subscription dùng service_code='ELEC', contractServicePrices dùng 'ELECTRICITY'
    const r = resolveServiceUnitPrice({
      subscription: { service_code: 'ELEC', unit_price: 3000, is_price_locked: false },
      periodEndYmd: '2026-11-30',
      contractServicePrices: [
        { service_code: 'ELECTRICITY', unit_price: 6000, effective_from: '2026-01-01' },
      ],
      catalogItems: [],
    });
    assert.equal(r.priceSource, 'CONTRACT_OVERRIDE',
      'BUG: ELEC và ELECTRICITY phải được alias thành nhau');
    assert.equal(r.unitPrice, 6000);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GROUP B5 — computeLateFeeAccrual
// BUG TIỀM NĂNG:
//   - Code: chargeableDays = max(0, overdueDays - grace) = max(0, overdueDays - 5)
//     → Phí bắt đầu từ ngày thứ 6 (after 5 days grace), tính từ ngày 6 trở đi
//   - 6 ngày overdue → chargeableDays = 1 → fee = 100k (1 ngày)
//   - 5 ngày overdue → chargeableDays = 0 → fee = 0 (vẫn trong grace period)
//   - 0 ngày overdue → không overdue → fee = 0
//   - double-count: grossAccruedLateFee giúp tính delta
// ─────────────────────────────────────────────────────────────────────────────
test('BUG-HUNT B5: computeLateFeeAccrual grace period boundary', async (t) => {

  const baseParams = {
    totalAmount: 2_000_000,
    paidAmount: 0,
    graceDays: 5,
    lateFeePerDay: 100_000,
    grossAccruedLateFee: 0,
  };

  await t.test('OVERDUE 6 ngày → chargeableDays=1, fee=100k (phí bắt đầu ngày 6)', () => {
    // BUG TIỀM NĂNG: developer nhầm 6 ngày × 100k = 600k, nhưng code tính max(0, 6-5) = 1 ngày × 100k = 100k
    const r = computeLateFeeAccrual({
      ...baseParams,
      dueDateYmd: '2026-10-01',
      asOfDateYmd: '2026-10-07', // 6 ngày sau due
    });
    assert.equal(r.isOverdue, true);
    assert.equal(r.overdueDays, 6);
    assert.equal(r.chargeableDays, 1, 'BUG: 6 ngày overdue - 5 grace = 1 ngày tính phí');
    assert.equal(r.expectedTotalLateFee, 100_000, 'BUG: 1 ngày × 100k = 100k (không phải 600k!)');
  });

  await t.test('OVERDUE 5 ngày → chargeableDays=0, fee=0 (vẫn trong grace period)', () => {
    const r = computeLateFeeAccrual({
      ...baseParams,
      dueDateYmd: '2026-10-01',
      asOfDateYmd: '2026-10-06', // 5 ngày sau due
    });
    assert.equal(r.overdueDays, 5);
    assert.equal(r.chargeableDays, 0, 'BUG: 5 ngày = đúng bằng grace → không tính phí');
    assert.equal(r.expectedTotalLateFee, 0);
    assert.equal(r.deltaFee, 0);
  });

  await t.test('OVERDUE 0 ngày (hôm nay = due date) → không overdue', () => {
    const r = computeLateFeeAccrual({
      ...baseParams,
      dueDateYmd: '2026-10-07',
      asOfDateYmd: '2026-10-07',
    });
    assert.equal(r.isOverdue, false);
    assert.equal(r.overdueDays, 0);
    assert.equal(r.deltaFee, 0);
  });

  await t.test('Đã có grossAccruedLateFee=100k → delta=0 (không double-count)', () => {
    // BUG TIỀM NĂNG: nếu không tính delta đúng, sẽ charge lại phí đã có
    const r = computeLateFeeAccrual({
      ...baseParams,
      dueDateYmd: '2026-10-01',
      asOfDateYmd: '2026-10-07', // 6 ngày → expectedTotal = 100k
      grossAccruedLateFee: 100_000, // đã accrued rồi
    });
    assert.equal(r.expectedTotalLateFee, 100_000);
    assert.equal(r.deltaFee, 0, 'BUG: đã accrued đủ → delta phải = 0 (không double-count)');
  });

  await t.test('Đã có grossAccruedLateFee=0, overdue=10 ngày → delta=500k', () => {
    // chargeableDays = 10-5 = 5, fee = 5×100k = 500k
    const r = computeLateFeeAccrual({
      ...baseParams,
      dueDateYmd: '2026-10-01',
      asOfDateYmd: '2026-10-11', // 10 ngày
      grossAccruedLateFee: 0,
    });
    assert.equal(r.chargeableDays, 5);
    assert.equal(r.expectedTotalLateFee, 500_000);
    assert.equal(r.deltaFee, 500_000);
  });

  await t.test('Hóa đơn đã paid đủ → không overdue (paid >= total)', () => {
    const r = computeLateFeeAccrual({
      ...baseParams,
      dueDateYmd: '2026-10-01',
      asOfDateYmd: '2026-10-20',
      paidAmount: 2_000_000, // paid = total
    });
    assert.equal(r.isOverdue, false, 'Đã thanh toán đủ → không tính late fee');
    assert.equal(r.deltaFee, 0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GROUP B6 — evaluateMeterReadingAnomaly
// BUG TIỀM NĂNG:
//   - Code dùng exactRatio > effThreshold + 1e-9 → đúng bằng threshold KHÔNG phải anomaly
//   - 30% tăng = threshold → isAbnormal = false (boundary: > không phải >=)
//   - 31% tăng → isAbnormal = true
//   - previousReading null/undefined → không flag anomaly (no history)
// ─────────────────────────────────────────────────────────────────────────────
test('BUG-HUNT B6: evaluateMeterReadingAnomaly threshold boundary', async (t) => {

  await t.test('tăng 150% so với average → isAbnormal=true (ANOMALY_HIGH)', () => {
    // baseline = [100, 100, 100] avg = 100
    // current consumption = 250 (150% cao hơn average)
    const r = evaluateMeterReadingAnomaly({
      previousReading: 0,
      currentReading: 250,
      recentConsumptions: [100, 100, 100],
      thresholdRatio: 0.3,
    });
    assert.equal(r.valid, true);
    assert.equal(r.isAbnormal, true, 'Tăng 150% so với avg phải là anomaly');
  });

  await t.test('tăng đúng 30% (bằng threshold) → isAbnormal=false (boundary: > không phải >=)', () => {
    // baseline = [100] avg = 100, consumption = 130 (30% cao hơn)
    // exactRatio = |130-100|/100 = 0.3, effThreshold = 0.3
    // isAbnormal = 0.3 > 0.3 + 1e-9 = false → NOT anomaly
    const r = evaluateMeterReadingAnomaly({
      previousReading: 0,
      currentReading: 130,
      recentConsumptions: [100],
      thresholdRatio: 0.3,
    });
    assert.equal(r.isAbnormal, false,
      'BUG: đúng 30% threshold không phải anomaly (strict >)');
  });

  await t.test('tăng 30.0001% (vừa vượt threshold) → isAbnormal=true', () => {
    // consumption = 130.0001, avg = 100 → ratio = 0.300001 > 0.3+1e-9 → true
    const r = evaluateMeterReadingAnomaly({
      previousReading: 0,
      currentReading: 130.1,
      recentConsumptions: [100],
      thresholdRatio: 0.3,
    });
    assert.equal(r.isAbnormal, true, 'Vừa vượt threshold → anomaly');
  });

  await t.test('previousReading null → valid=false, không flag anomaly', () => {
    // curr = NaN → code returns INVALID_READING block: valid=false, isAbnormal=false
    // Nhưng previousReading=null → prev = Number(null??0) = 0 (vì ?? 0 trả 0)
    // Thực ra: previousReading=null → Number(null??0) = Number(0) = 0 → không NaN
    // Vậy nếu không có history (recentConsumptions=[]) → valid=true, isAbnormal=false
    const r = evaluateMeterReadingAnomaly({
      previousReading: null,
      currentReading: 150,
      recentConsumptions: [], // không có history → không flag
      thresholdRatio: 0.3,
    });
    assert.equal(r.isAbnormal, false,
      'BUG TIỀM NĂNG: Không có history → không thể phát hiện anomaly');
  });

  await t.test('previousReading undefined → không throw, không flag anomaly', () => {
    assert.doesNotThrow(() => {
      const r = evaluateMeterReadingAnomaly({
        previousReading: undefined,
        currentReading: 100,
        recentConsumptions: [],
      });
      assert.equal(r.isAbnormal, false);
    });
  });

  await t.test('giảm (curr < prev) → valid=false', () => {
    const r = evaluateMeterReadingAnomaly({
      previousReading: 200,
      currentReading: 100,
      recentConsumptions: [50],
    });
    assert.equal(r.valid, false, 'curr < prev → INVALID_READING');
    assert.equal(r.isAbnormal, false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GROUP B7 — todayVietnamYmd timezone
// BUG TIỀM NĂNG:
//   - UTC+7: UTC 17:00 = VN 00:00 ngày hôm sau
//   - UTC 16:59 = VN 23:59 cùng ngày
//   - Quan trọng: ranh giới ngày phải đúng
// ─────────────────────────────────────────────────────────────────────────────
test('BUG-HUNT B7: todayVietnamYmd timezone boundary', async (t) => {

  await t.test('UTC 17:00 ngày 31/10 = VN 00:00 ngày 01/11 → "2026-11-01"', () => {
    // 2026-10-31T17:00:00Z = 2026-11-01T00:00:00+07:00
    const utcDate = new Date('2026-10-31T17:00:00Z');
    const result = todayVietnamYmd(utcDate);
    assert.equal(result, '2026-11-01',
      'BUG: UTC 17:00 = VN midnight → phải trả ngày VN tiếp theo');
  });

  await t.test('UTC 16:59 ngày 31/10 = VN 23:59 ngày 31/10 → "2026-10-31"', () => {
    // 2026-10-31T16:59:00Z = 2026-10-31T23:59:00+07:00
    const utcDate = new Date('2026-10-31T16:59:00Z');
    const result = todayVietnamYmd(utcDate);
    assert.equal(result, '2026-10-31',
      'BUG: UTC 16:59 = VN 23:59 → phải trả cùng ngày VN');
  });

  await t.test('UTC 00:00 ngày 01/01 = VN 07:00 ngày 01/01 → "2027-01-01"', () => {
    const utcDate = new Date('2027-01-01T00:00:00Z');
    const result = todayVietnamYmd(utcDate);
    assert.equal(result, '2027-01-01');
  });

  await t.test('invalid date input → fallback, không throw', () => {
    // Code: if (isNaN(dt.getTime())) dt = new Date()
    assert.doesNotThrow(() => {
      const result = todayVietnamYmd(new Date('invalid-date'));
      assert.ok(typeof result === 'string' && result.length === 10,
        'Invalid date phải fallback về today, không throw');
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GROUP B8 — computeSubscriptionPeriodCharge (Mid-month service cancellation pro-rata)
// KỊCH BẢN NGHIỆP VỤ:
//   - Sử dụng dịch vụ từ đầu tháng (hoặc trước đó) tới giữa tháng rồi bất ngờ hủy
//     (status = 'TERMINATED', 'CANCELLED', hoặc 'CANCELLATION_PENDING' có end_date giữa tháng)
//     → Phải tính đúng activeDays, isProrated = true, và số tiền làm tròn roundVND
//   - Đăng ký dịch vụ giữa tháng rồi hủy luôn trước cuối tháng (start_date và end_date cùng trong tháng)
//   - Dịch vụ đã hủy từ tháng trước → tháng này phải 0 ngày, 0 đồng
//   - Dịch vụ hủy cùng ngày bắt đầu (dùng đúng 1 ngày) → activeDays = 1
//   - Dịch vụ TERMINATED nhưng thiếu end_date hoặc end_date < start_date → billable = false, amount = 0
//   - Rút lại yêu cầu hủy (CANCELLATION_PENDING → ACTIVE, xóa end_date) → quay lại tính full tháng
// ─────────────────────────────────────────────────────────────────────────────
test('BUG-HUNT B8: computeSubscriptionPeriodCharge mid-month cancellation pro-rata', async (t) => {
  const { roundVND } = await import('../src/services/pricing.js');

  await t.test('Dùng dịch vụ từ đầu tháng tới giữa tháng (15/11) rồi hủy (TERMINATED) → tính đúng pro-rata 15/30 ngày', () => {
    // Kỳ 2026-11 (30 ngày), gói Internet 300,000đ/tháng, dùng từ 2026-01-01, hủy ngày 2026-11-15
    const r = computeSubscriptionPeriodCharge({
      subscription: {
        service_code: 'INTERNET_FIBER',
        service_name: 'Internet Cáp Quang',
        status: 'TERMINATED',
        start_date: '2026-01-01',
        end_date: '2026-11-15',
        unit_price: 300_000,
        quantity: 1,
        is_price_locked: true,
      },
      periodYm: '2026-11',
    });

    assert.equal(r.daysInMonth, 30);
    assert.equal(r.activeDays, 15, 'Hủy ngày 15/11 phải tính đúng 15 ngày sử dụng (01/11 → 15/11)');
    assert.equal(r.isProrated, true, 'Hủy giữa tháng phải đánh dấu isProrated = true');
    assert.equal(r.overlapStart, '2026-11-01');
    assert.equal(r.overlapEnd, '2026-11-15');
    assert.equal(r.amount, 150_000, '300,000 * 15 / 30 = 150,000đ');
    assert.equal(r.formulaMeta.billing_mode, 'PRORATED');
  });

  await t.test('Status = "CANCELLED" (alias của TERMINATED) hủy ngày 10 trong tháng 31 ngày (quantity=2) → pro-rata chuẩn', () => {
    // Kỳ 2026-05 (31 ngày), gửi 2 xe máy * 150,000đ = 300,000đ/tháng, hủy ngày 10/05/2026
    const r = computeSubscriptionPeriodCharge({
      subscription: {
        service_code: 'PARKING_MOTO',
        service_name: 'Gửi xe máy',
        status: 'CANCELLED',
        start_date: '2026-03-01',
        end_date: '2026-05-10',
        unit_price: 150_000,
        quantity: 2,
        is_price_locked: true,
      },
      periodYm: '2026-05',
    });

    const expected = roundVND((150_000 * 2 * 10) / 31); // 96,774.19 -> 97,000
    assert.equal(r.daysInMonth, 31);
    assert.equal(r.activeDays, 10);
    assert.equal(r.isProrated, true);
    assert.equal(r.amount, expected, `Phải làm tròn chuẩn VND: ${expected}`);
  });

  await t.test('Cư dân vừa bấm yêu cầu hủy giữa tháng (CANCELLATION_PENDING có end_date=2026-11-18) → preview pro-rata 18/30 ngày', () => {
    const r = computeSubscriptionPeriodCharge({
      subscription: {
        service_code: 'PARKING_CAR',
        service_name: 'Gửi ô tô',
        status: 'CANCELLATION_PENDING',
        start_date: '2026-01-01',
        end_date: '2026-11-18',
        unit_price: 1_200_000,
        quantity: 1,
        is_price_locked: true,
      },
      periodYm: '2026-11',
    });

    assert.equal(r.activeDays, 18);
    assert.equal(r.daysInMonth, 30);
    assert.equal(r.isProrated, true);
    assert.equal(r.amount, roundVND((1_200_000 * 18) / 30)); // 720,000
  });

  await t.test('Đăng ký giữa tháng (10/11) rồi bất ngờ hủy luôn giữa tháng (20/11) → tính đúng 11 ngày (10/11 → 20/11)', () => {
    const r = computeSubscriptionPeriodCharge({
      subscription: {
        service_code: 'GYM',
        service_name: 'Thẻ Gym',
        status: 'TERMINATED',
        start_date: '2026-11-10',
        end_date: '2026-11-20',
        unit_price: 600_000,
        quantity: 1,
        is_price_locked: true,
      },
      periodYm: '2026-11',
    });

    assert.equal(r.activeDays, 11, 'Từ 10/11 đến 20/11 (inclusive) là 11 ngày');
    assert.equal(r.overlapStart, '2026-11-10');
    assert.equal(r.overlapEnd, '2026-11-20');
    assert.equal(r.isProrated, true);
    assert.equal(r.amount, roundVND((600_000 * 11) / 30)); // 220,000
  });

  await t.test('Dùng đúng 1 ngày trong tháng rồi hủy ngay (start_date = end_date = 2026-11-15) → activeDays = 1', () => {
    const r = computeSubscriptionPeriodCharge({
      subscription: {
        service_code: 'CLEANING',
        service_name: 'Dọn phòng định kỳ',
        status: 'TERMINATED',
        start_date: '2026-11-15',
        end_date: '2026-11-15',
        unit_price: 900_000,
        quantity: 1,
        is_price_locked: true,
      },
      periodYm: '2026-11',
    });

    assert.equal(r.activeDays, 1);
    assert.equal(r.isProrated, true);
    assert.equal(r.amount, 30_000);
  });

  await t.test('Hủy giữa tháng trước (2026-10-15) → sang kỳ tháng này (2026-11) không bị tính tiền (amount = 0)', () => {
    const r = computeSubscriptionPeriodCharge({
      subscription: {
        service_code: 'INTERNET_FIBER',
        status: 'TERMINATED',
        start_date: '2026-01-01',
        end_date: '2026-10-15',
        unit_price: 300_000,
        quantity: 1,
        is_price_locked: true,
      },
      periodYm: '2026-11',
    });

    assert.equal(r.activeDays, 0);
    assert.equal(r.amount, 0, 'Đã hủy từ tháng trước thì kỳ này phải bằng 0');
    assert.equal(r.isProrated, false);
  });

  await t.test('Hợp đồng kết thúc sớm (boundEndYmd) trước ngày hủy dịch vụ → bị chặn bởi boundEndYmd', () => {
    // Dịch vụ hủy ngày 25/11 nhưng hợp đồng đã thanh lý ngày 12/11 (boundEndYmd = 2026-11-12)
    const r = computeSubscriptionPeriodCharge({
      subscription: {
        service_code: 'INTERNET_FIBER',
        status: 'TERMINATED',
        start_date: '2026-01-01',
        end_date: '2026-11-25',
        unit_price: 300_000,
        quantity: 1,
        is_price_locked: true,
      },
      periodYm: '2026-11',
      boundStartYmd: '2026-11-01',
      boundEndYmd: '2026-11-12',
    });

    assert.equal(r.activeDays, 12, 'Không được tính vượt quá ngày hiệu lực hợp đồng (boundEndYmd)');
    assert.equal(r.overlapEnd, '2026-11-12');
    assert.equal(r.amount, 120_000);
  });

  await t.test('TERMINATED nhưng thiếu end_date hoặc end_date < start_date → không tính phí (billable=false)', () => {
    const noEnd = computeSubscriptionPeriodCharge({
      subscription: {
        service_code: 'INTERNET_FIBER',
        status: 'TERMINATED',
        start_date: '2026-11-01',
        end_date: null,
        unit_price: 300_000,
        is_price_locked: true,
      },
      periodYm: '2026-11',
    });
    assert.equal(noEnd.activeDays, 0);
    assert.equal(noEnd.amount, 0);

    const invalidEnd = resolveSubscriptionEffectiveWindow({
      status: 'TERMINATED',
      start_date: '2026-11-15',
      end_date: '2026-11-10',
    });
    assert.equal(invalidEnd.billable, false);
  });

  await t.test('Rút lại yêu cầu hủy (CANCELLATION_PENDING → ACTIVE, end_date = null) → tính lại full tháng', () => {
    const r = computeSubscriptionPeriodCharge({
      subscription: {
        service_code: 'INTERNET_FIBER',
        status: 'ACTIVE',
        start_date: '2026-01-01',
        end_date: null,
        unit_price: 300_000,
        quantity: 1,
        is_price_locked: true,
      },
      periodYm: '2026-11',
    });

    assert.equal(r.activeDays, 30);
    assert.equal(r.isProrated, false);
    assert.equal(r.amount, 300_000);
    assert.equal(r.formulaMeta.billing_mode, 'FULL');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GROUP B9 — syncSubscriptionTerminationInvoicesInTx (Đã sinh hóa đơn rồi mới hủy dịch vụ giữa tháng)
// KIỂM THỬ 3 KỊCH BẢN TRONG invoiceLifecycle.js:
//   1. Kịch bản 1 (UNBILLED): Chưa sinh hóa đơn cho kỳ hủy (chỉ có hóa đơn kỳ quá khứ)
//      → Hóa đơn quá khứ giữ nguyên, trả về scenario = 'UNBILLED'.
//   2. Kịch bản 2 (DRAFT_UPDATED): Đã sinh hóa đơn NHÁP (DRAFT) cả tháng (300,000đ),
//      sau đó cư dân hủy dịch vụ giữa tháng (15/11)
//      → Cập nhật trực tiếp dòng invoice_line từ 300,000đ xuống 150,000đ (pro-rata 15/30 ngày),
//      → Tính lại subtotal_amount & total_amount của hóa đơn DRAFT giảm đúng 150,000đ.
//      → Nếu hóa đơn DRAFT chỉ có duy nhất dịch vụ đó và hủy trước ngày bắt đầu (0đ) → tự động VOID hóa đơn DRAFT.
//   3. Kịch bản 3 (ADJUSTMENT_CREATED): Đã phát hành hóa đơn (ISSUED hoặc PAID) cả tháng (300,000đ),
//      sau đó cư dân hủy dịch vụ giữa tháng (15/11)
//      → Giữ nguyên dòng invoice_line gốc (bất biến kế toán),
//      → Tự động tạo bản ghi invoice_adjustment (status = 'PENDING_APPROVAL', action_type = 'ADJUST',
//        adjustment_target = 'SERVICE', delta_amount = -150,000đ) và bắn thông báo phê duyệt.
// ─────────────────────────────────────────────────────────────────────────────
function createMockInvoiceTxClient({ invoices = [], lines = [], adjustments = [] } = {}) {
  const state = {
    invoices: invoices.map((inv) => ({ ...inv })),
    lines: lines.map((l) => ({ ...l })),
    adjustments: adjustments.map((a) => ({ ...a })),
    auditLogs: [],
    notifications: [],
  };

  const client = {
    state,
    async query(sql, params = []) {
      const norm = sql.replace(/\s+/g, ' ').trim();

      // 1. Query invoices in termination period or later
      if (norm.startsWith('SELECT * FROM invoice WHERE contract_id = $1 AND status <> \'VOID\'')) {
        const [contractId, endPeriod] = params;
        const rows = state.invoices
          .filter(
            (inv) =>
              inv.contract_id === contractId &&
              inv.status !== 'VOID' &&
              (!endPeriod || inv.period >= endPeriod)
          )
          .sort((a, b) => a.period.localeCompare(b.period));
        return { rows };
      }

      // 2. Query invoice_line by invoice_id and subscription_id
      if (norm.startsWith('SELECT * FROM invoice_line WHERE invoice_id = $1 AND subscription_id = $2')) {
        const [invoiceId, subId] = params;
        const rows = state.lines.filter(
          (l) => l.invoice_id === invoiceId && l.subscription_id === subId
        );
        return { rows };
      }

      // 3. Delete invoice_line when newAmt === 0 on DRAFT
      if (norm.startsWith('DELETE FROM invoice_line WHERE id = $1')) {
        const [lineId] = params;
        state.lines = state.lines.filter((l) => l.id !== lineId);
        return { rowCount: 1, rows: [] };
      }

      // 4. Update invoice_line on DRAFT with pro-rata charge
      if (norm.startsWith('UPDATE invoice_line SET description = $1, quantity = $2, unit_price = $3, amount = $4, formula_meta = $5 WHERE id = $6')) {
        const [description, quantity, unitPrice, amount, formulaMetaJson, lineId] = params;
        const idx = state.lines.findIndex((l) => l.id === lineId);
        if (idx !== -1) {
          state.lines[idx] = {
            ...state.lines[idx],
            description,
            quantity,
            unit_price: unitPrice,
            amount,
            formula_meta: JSON.parse(formulaMetaJson),
          };
        }
        return { rowCount: idx !== -1 ? 1 : 0, rows: [] };
      }

      // 5. Select invoice by id (FOR UPDATE or plain)
      if (norm.startsWith('SELECT * FROM invoice WHERE id = $1')) {
        const [invoiceId] = params;
        const inv = state.invoices.find((i) => i.id === invoiceId);
        return { rows: inv ? [{ ...inv }] : [] };
      }

      // 6. Select all lines of an invoice
      if (norm.startsWith('SELECT * FROM invoice_line WHERE invoice_id = $1 ORDER BY created_at ASC')) {
        const [invoiceId] = params;
        const rows = state.lines.filter((l) => l.invoice_id === invoiceId);
        return { rows };
      }

      // 7. Auto-void late fee tracker sync
      if (norm.startsWith('SELECT fn_sync_late_fee_trackers_on_invoice_void')) {
        return { rows: [] };
      }

      // 8. Auto-void DRAFT invoice when subtotal === 0
      if (norm.startsWith('UPDATE invoice SET status = \'VOID\'')) {
        const [invoiceId] = params;
        const idx = state.invoices.findIndex((i) => i.id === invoiceId);
        if (idx !== -1) {
          state.invoices[idx] = {
            ...state.invoices[idx],
            status: 'VOID',
            subtotal_amount: 0,
            adjustment_amount: 0,
            total_amount: 0,
            credit_offset_amount: 0,
          };
        }
        return { rowCount: 1, rows: [] };
      }

      // 9. Update DRAFT invoice recalculated totals
      if (norm.startsWith('UPDATE invoice SET subtotal_amount = $1, adjustment_amount = $2, total_amount = $3, credit_offset_amount = $4')) {
        const [subtotal, adj, total, creditOffset, invoiceId] = params;
        const idx = state.invoices.findIndex((i) => i.id === invoiceId);
        if (idx !== -1) {
          state.invoices[idx] = {
            ...state.invoices[idx],
            subtotal_amount: subtotal,
            adjustment_amount: adj,
            total_amount: total,
            credit_offset_amount: creditOffset,
          };
        }
        return { rowCount: 1, rows: [] };
      }

      // 10. Insert audit_log
      if (norm.startsWith('INSERT INTO audit_log')) {
        state.auditLogs.push({ params });
        return { rowCount: 1, rows: [] };
      }

      // 11. Check existing PENDING_APPROVAL invoice_adjustment
      if (norm.startsWith('SELECT * FROM invoice_adjustment WHERE invoice_id = $1 AND subscription_id = $2 AND status = \'PENDING_APPROVAL\'')) {
        const [invoiceId, subId] = params;
        const rows = state.adjustments.filter(
          (a) =>
            a.invoice_id === invoiceId &&
            a.subscription_id === subId &&
            a.status === 'PENDING_APPROVAL'
        );
        return { rows };
      }

      // 12. Insert new PENDING_APPROVAL invoice_adjustment
      if (norm.startsWith('INSERT INTO invoice_adjustment')) {
        const [orgId, buildingId, invoiceId, subId, deltaAmount, reason, formulaMetaJson, actorId] = params;
        const newAdj = {
          id: `adj-${state.adjustments.length + 1}`,
          org_id: orgId,
          building_id: buildingId,
          invoice_id: invoiceId,
          subscription_id: subId,
          adjustment_target: 'SERVICE',
          action_type: 'ADJUST',
          delta_amount: deltaAmount,
          reason,
          formula_meta: JSON.parse(formulaMetaJson),
          status: 'PENDING_APPROVAL',
          created_by: actorId,
          updated_by: actorId,
        };
        state.adjustments.push(newAdj);
        return { rows: [newAdj] };
      }

      // 13. Update existing PENDING_APPROVAL invoice_adjustment
      if (norm.startsWith('UPDATE invoice_adjustment SET delta_amount = $1')) {
        const [deltaAmount, formulaMetaJson, reason, actorId, adjId] = params;
        const idx = state.adjustments.findIndex((a) => a.id === adjId);
        if (idx !== -1) {
          state.adjustments[idx] = {
            ...state.adjustments[idx],
            delta_amount: deltaAmount,
            formula_meta: JSON.parse(formulaMetaJson),
            reason,
            updated_by: actorId,
          };
          return { rows: [state.adjustments[idx]] };
        }
        return { rows: [] };
      }

      // 14. Notify finance actors
      if (norm.startsWith('SELECT fn_notify_building_finance_actors')) {
        state.notifications.push({
          buildingId: params[0],
          type: params[1],
          title: params[2],
          message: params[3],
          metadata: JSON.parse(params[4]),
        });
        return { rows: [] };
      }

      // 15. Insert new SERVICE invoice_line on DRAFT invoice
      if (norm.startsWith('INSERT INTO invoice_line ( invoice_id, item_type, description, quantity, unit, unit_price, amount, subscription_id, formula_meta )')) {
        const [invoiceId, description, quantity, unit, unitPrice, amount, subscriptionId, formulaMetaJson] = params;
        const newLine = {
          id: `line-${state.lines.length + 1}`,
          invoice_id: invoiceId,
          item_type: 'SERVICE',
          description,
          quantity,
          unit,
          unit_price: unitPrice,
          amount,
          subscription_id: subscriptionId,
          formula_meta: JSON.parse(formulaMetaJson),
        };
        state.lines.push(newLine);
        return { rowCount: 1, rows: [newLine] };
      }

      // 16. Query prior non-VOID, non-DRAFT invoices before targetPeriodYm
      if (norm.startsWith('SELECT id, period, status FROM invoice WHERE contract_id = $1 AND status NOT IN (\'VOID\', \'CANCELLED\', \'DRAFT\') AND period < $2')) {
        const [contractId, targetPeriodYm] = params;
        const rows = state.invoices
          .filter(
            (inv) =>
              inv.contract_id === contractId &&
              !['VOID', 'CANCELLED', 'DRAFT'].includes(inv.status) &&
              inv.period < targetPeriodYm
          )
          .sort((a, b) => a.period.localeCompare(b.period));
        return { rows };
      }

      // 17. Query all subscription invoice_line rows across non-VOID invoices of a contract
      if (norm.startsWith('SELECT il.invoice_id, i.period AS invoice_period, i.status AS invoice_status, il.subscription_id, il.amount, il.formula_meta FROM invoice_line il JOIN invoice i ON i.id = il.invoice_id')) {
        const [contractId] = params;
        const rows = [];
        for (const l of state.lines) {
          if (!l.subscription_id) continue;
          const inv = state.invoices.find((i) => i.id === l.invoice_id);
          if (!inv || inv.contract_id !== contractId || ['VOID', 'CANCELLED'].includes(inv.status)) continue;
          rows.push({
            invoice_id: l.invoice_id,
            invoice_period: inv.period,
            invoice_status: inv.status,
            subscription_id: l.subscription_id,
            amount: l.amount,
            formula_meta: l.formula_meta,
          });
        }
        return { rows };
      }

      throw new Error(`Unhandled SQL in mock client: ${norm}`);
    },
  };

  return client;
}

test('BUG-HUNT B9: syncSubscriptionTerminationInvoicesInTx — 3 kịch bản khi đã/chưa sinh hóa đơn mà hủy dịch vụ giữa tháng', async (t) => {
  const baseContract = {
    id: 'contract-1',
    org_id: 'org-1',
    building_id: 'bld-1',
    start_date: '2026-01-01',
    end_date: '2027-01-01',
    rent_amount: 10_000_000,
  };

  const terminatedMidMonthSub = {
    id: 'sub-internet-1',
    org_id: 'org-1',
    building_id: 'bld-1',
    contract_id: 'contract-1',
    service_code: 'INTERNET_FIBER',
    service_name: 'Internet Cáp Quang',
    status: 'TERMINATED',
    start_date: '2026-01-01',
    end_date: '2026-11-15', // Hủy giữa tháng 11 (15/30 ngày)
    unit_price: 300_000,
    quantity: 1,
    is_price_locked: true,
  };

  await t.test('Kịch bản 1 (UNBILLED): Chưa sinh hóa đơn kỳ 2026-11 (chỉ có hóa đơn kỳ cũ 2026-10) → scenario="UNBILLED", bảo toàn kỳ cũ', async () => {
    const mockClient = createMockInvoiceTxClient({
      invoices: [
        {
          id: 'inv-oct',
          org_id: 'org-1',
          building_id: 'bld-1',
          contract_id: 'contract-1',
          period: '2026-10',
          status: 'PAID',
          subtotal_amount: 10_300_000,
          total_amount: 10_300_000,
          paid_amount: 10_300_000,
        },
      ],
      lines: [
        {
          id: 'line-oct-sub',
          invoice_id: 'inv-oct',
          subscription_id: 'sub-internet-1',
          item_type: 'SERVICE',
          unit_price: 300_000,
          quantity: 1,
          amount: 300_000,
        },
      ],
    });

    const res = await syncSubscriptionTerminationInvoicesInTx(mockClient, {
      subscription: terminatedMidMonthSub,
      contract: baseContract,
      actorId: 'mgr-1',
      reason: 'Khách hủy Internet giữa tháng 11',
    });

    assert.equal(res.scenario, 'UNBILLED', 'Chưa có hóa đơn kỳ 2026-11 → phải trả về UNBILLED');
    assert.equal(res.updatedDraftInvoiceIds.length, 0);
    assert.equal(res.createdAdjustments.length, 0);
    // Hóa đơn tháng 10 giữ nguyên 300,000đ
    assert.equal(mockClient.state.lines[0].amount, 300_000, 'Hóa đơn kỳ trước (2026-10) không được bị sửa');
  });

  await t.test('Kịch bản 2A (DRAFT_UPDATED): Đã sinh hóa đơn DRAFT kỳ 2026-11 cả tháng (300k) rồi hủy ngày 15/11 → sửa trực tiếp dòng DRAFT về 150k & cập nhật tổng hóa đơn', async () => {
    const mockClient = createMockInvoiceTxClient({
      invoices: [
        {
          id: 'inv-nov-draft',
          org_id: 'org-1',
          building_id: 'bld-1',
          contract_id: 'contract-1',
          invoice_code: 'INV-202611-01',
          period: '2026-11',
          status: 'DRAFT',
          subtotal_amount: 10_300_000,
          adjustment_amount: 0,
          credit_offset_amount: 0,
          total_amount: 10_300_000,
          paid_amount: 0,
        },
      ],
      lines: [
        {
          id: 'line-rent',
          invoice_id: 'inv-nov-draft',
          subscription_id: null,
          item_type: 'RENT',
          description: 'Tiền thuê phòng (2026-11)',
          unit_price: 10_000_000,
          quantity: 1,
          amount: 10_000_000,
        },
        {
          id: 'line-sub',
          invoice_id: 'inv-nov-draft',
          subscription_id: 'sub-internet-1',
          item_type: 'SERVICE',
          description: 'Internet Cáp Quang (2026-11)',
          unit_price: 300_000,
          quantity: 1,
          amount: 300_000, // Đã tính full tháng lúc tạo nháp
        },
      ],
    });

    const res = await syncSubscriptionTerminationInvoicesInTx(mockClient, {
      subscription: terminatedMidMonthSub,
      contract: baseContract,
      actorId: 'mgr-1',
      reason: 'Hủy dịch vụ giữa tháng',
    });

    assert.equal(res.scenario, 'DRAFT_UPDATED');
    assert.deepEqual(res.updatedDraftInvoiceIds, ['inv-nov-draft']);
    assert.equal(res.createdAdjustments.length, 0, 'Hóa đơn DRAFT sửa trực tiếp, không tạo invoice_adjustment');

    const updatedSubLine = mockClient.state.lines.find((l) => l.id === 'line-sub');
    assert.equal(updatedSubLine.amount, 150_000, 'Dòng dịch vụ trên DRAFT phải giảm từ 300,000đ xuống 150,000đ (15/30 ngày)');
    assert.equal(updatedSubLine.formula_meta.billing_mode, 'PRORATED');
    assert.equal(updatedSubLine.formula_meta.active_days, 15);
    assert.equal(updatedSubLine.formula_meta.days_in_month, 30);

    const updatedInv = mockClient.state.invoices[0];
    assert.equal(updatedInv.subtotal_amount, 10_150_000, 'Subtotal hóa đơn nháp phải giảm từ 10.3M xuống 10.15M');
    assert.equal(updatedInv.total_amount, 10_150_000, 'Total hóa đơn nháp phải giảm từ 10.3M xuống 10.15M');
  });

  await t.test('Kịch bản 2B (DRAFT_UPDATED — Auto VOID): Hóa đơn DRAFT chỉ chứa duy nhất dịch vụ vừa hủy với số tiền 0đ → xóa dòng & tự động VOID hóa đơn DRAFT', async () => {
    // Ví dụ hóa đơn nháp kỳ 2026-12 đã lỡ tạo trước, nhưng dịch vụ hủy từ 15/11/2026 -> sang kỳ 2026-12 phí = 0đ
    const mockClient = createMockInvoiceTxClient({
      invoices: [
        {
          id: 'inv-dec-draft',
          org_id: 'org-1',
          building_id: 'bld-1',
          contract_id: 'contract-1',
          period: '2026-12',
          status: 'DRAFT',
          subtotal_amount: 300_000,
          adjustment_amount: 0,
          credit_offset_amount: 0,
          total_amount: 300_000,
          paid_amount: 0,
        },
      ],
      lines: [
        {
          id: 'line-dec-sub',
          invoice_id: 'inv-dec-draft',
          subscription_id: 'sub-internet-1',
          item_type: 'SERVICE',
          unit_price: 300_000,
          quantity: 1,
          amount: 300_000,
        },
      ],
    });

    const res = await syncSubscriptionTerminationInvoicesInTx(mockClient, {
      subscription: terminatedMidMonthSub,
      contract: baseContract,
      actorId: 'mgr-1',
    });

    assert.equal(res.scenario, 'DRAFT_UPDATED');
    assert.deepEqual(res.voidedDraftInvoiceIds, ['inv-dec-draft'], 'Hóa đơn nháp về 0đ phải tự động VOID');
    assert.equal(mockClient.state.lines.length, 0, 'Dòng dịch vụ 0đ trên DRAFT phải bị xóa');
    assert.equal(mockClient.state.invoices[0].status, 'VOID');
    assert.equal(mockClient.state.invoices[0].total_amount, 0);
  });

  await t.test('Kịch bản 3A (ADJUSTMENT_CREATED — Hóa đơn ISSUED): Đã phát hành hóa đơn cả tháng (300k), hủy ngày 15/11 → giữ nguyên line gốc, tạo invoice_adjustment delta = -150,000đ', async () => {
    const mockClient = createMockInvoiceTxClient({
      invoices: [
        {
          id: 'inv-nov-issued',
          org_id: 'org-1',
          building_id: 'bld-1',
          contract_id: 'contract-1',
          invoice_code: 'INV-202611-ISSUED',
          period: '2026-11',
          status: 'ISSUED',
          subtotal_amount: 10_300_000,
          total_amount: 10_300_000,
          paid_amount: 0,
        },
      ],
      lines: [
        {
          id: 'line-issued-sub',
          invoice_id: 'inv-nov-issued',
          subscription_id: 'sub-internet-1',
          item_type: 'SERVICE',
          unit_price: 300_000,
          quantity: 1,
          amount: 300_000,
        },
      ],
    });

    const res = await syncSubscriptionTerminationInvoicesInTx(mockClient, {
      subscription: terminatedMidMonthSub,
      contract: baseContract,
      actorId: 'mgr-1',
      reason: 'Hủy Internet ngày 15/11',
    });

    assert.equal(res.scenario, 'ADJUSTMENT_CREATED');
    assert.equal(res.createdAdjustments.length, 1);

    // Dòng gốc trên hóa đơn ISSUED không được bị sửa (Immutability)
    assert.equal(mockClient.state.lines[0].amount, 300_000, 'Dòng invoice_line gốc trên hóa đơn ISSUED phải bất biến');

    // Kiểm tra phiếu điều chỉnh được sinh ra
    const adj = res.createdAdjustments[0];
    assert.equal(adj.invoice_id, 'inv-nov-issued');
    assert.equal(adj.subscription_id, 'sub-internet-1');
    assert.equal(adj.adjustment_target, 'SERVICE');
    assert.equal(adj.action_type, 'ADJUST');
    assert.equal(adj.status, 'PENDING_APPROVAL');
    assert.equal(adj.delta_amount, -150_000, 'Phải giảm trừ đúng -150,000đ (pro-rata 150k - đã thu 300k)');
    assert.equal(adj.formula_meta.billing_mode, 'PRORATED');
    assert.equal(adj.formula_meta.active_days, 15);
    assert.equal(adj.formula_meta.rounded_amount, 150_000);

    // Đã bắn thông báo cho người phê duyệt
    assert.equal(mockClient.state.notifications.length, 1);
    assert.equal(mockClient.state.notifications[0].type, 'INVOICE_ADJUSTMENT_PENDING');
    assert.equal(mockClient.state.notifications[0].metadata.delta_amount, -150_000);
  });

  await t.test('Kịch bản 3B (ADJUSTMENT_CREATED — Hóa đơn PAID & cập nhật lại ngày hủy khi đang chờ duyệt): Cập nhật delta_amount trên phiếu PENDING_APPROVAL hiện có', async () => {
    // Hóa đơn đã PAID cả tháng (310,000đ cho kỳ tháng 5 có 31 ngày).
    // Ban đầu tạo adjustment ở ngày 20/05 (200k -> delta = -110k), sau đó sửa lại ngày hủy thành 10/05 (100k -> delta = -210k)
    const mockClient = createMockInvoiceTxClient({
      invoices: [
        {
          id: 'inv-may-paid',
          org_id: 'org-1',
          building_id: 'bld-1',
          contract_id: 'contract-1',
          invoice_code: 'INV-202605-PAID',
          period: '2026-05',
          status: 'PAID',
          subtotal_amount: 310_000,
          total_amount: 310_000,
          paid_amount: 310_000,
        },
      ],
      lines: [
        {
          id: 'line-paid-sub',
          invoice_id: 'inv-may-paid',
          subscription_id: 'sub-parking-1',
          item_type: 'SERVICE',
          unit_price: 310_000,
          quantity: 1,
          amount: 310_000,
        },
      ],
      adjustments: [
        {
          id: 'adj-existing-1',
          org_id: 'org-1',
          building_id: 'bld-1',
          invoice_id: 'inv-may-paid',
          subscription_id: 'sub-parking-1',
          adjustment_target: 'SERVICE',
          action_type: 'ADJUST',
          delta_amount: -110_000,
          status: 'PENDING_APPROVAL',
        },
      ],
    });

    const subCancelledDay10 = {
      id: 'sub-parking-1',
      org_id: 'org-1',
      building_id: 'bld-1',
      contract_id: 'contract-1',
      service_code: 'PARKING_MOTO',
      service_name: 'Gửi xe máy',
      status: 'TERMINATED',
      start_date: '2026-01-01',
      end_date: '2026-05-10', // Dùng 10/31 ngày -> phí pro-rata = 100,000đ -> delta = -210,000đ
      unit_price: 310_000,
      quantity: 1,
      is_price_locked: true,
    };

    const res = await syncSubscriptionTerminationInvoicesInTx(mockClient, {
      subscription: subCancelledDay10,
      contract: baseContract,
      actorId: 'mgr-1',
      reason: 'Cập nhật lại ngày hủy 10/05',
    });

    assert.equal(res.scenario, 'ADJUSTMENT_CREATED');
    assert.equal(mockClient.state.adjustments.length, 1, 'Không được tạo trùng dòng PENDING_APPROVAL thứ 2');
    assert.equal(mockClient.state.adjustments[0].delta_amount, -210_000, 'Phải cập nhật delta_amount thành -210,000đ (100k pro-rata - 310k đã đóng)');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GROUP B10 — Đăng ký dịch vụ bất ngờ giữa tháng (Phương án A)
// KIỂM THỬ 3 KỊCH BẢN (syncSubscriptionActivationInvoicesInTx & collectPriorUnbilledSubscriptionArrearsLinesInTx):
//   1. Kịch bản 1 (UNBILLED): Đăng ký giữa tháng (16/11) khi chưa sinh hóa đơn tháng 11
//      → Trả về scenario="UNBILLED", khi sinh hóa đơn tháng 11 tính đúng pro-rata 15/30 ngày = 150,000đ.
//   2. Kịch bản 2 (DRAFT_UPDATED): Đã sinh hóa đơn NHÁP (DRAFT) tháng 11, sau đó đăng ký/duyệt dịch vụ ngày 16/11
//      → Tự động chèn dòng SERVICE pro-rata 150,000đ vào hóa đơn DRAFT tháng 11 và cộng vào tổng hóa đơn.
//   3. Kịch bản 3 (DEFERRED_TO_NEXT_PERIOD — Phương án A): Hóa đơn tháng 11 đã ISSUED / PAID rồi mới đăng ký ngày 16/11
//      → Giữ nguyên hóa đơn tháng 11 (không mở lại hóa đơn PAID, không tạo invoice_adjustment trên tháng 11),
//      → Trả về scenario="DEFERRED_TO_NEXT_PERIOD", deferredPeriods=["2026-11"], deferredAmount=150,000đ,
//      → Sang kỳ tháng 12 (2026-12), khi sinh hóa đơn tháng 12, collectPriorUnbilledSubscriptionArrearsLinesInTx
//        tự động sinh dòng "Truy thu kỳ 2026-11: ... (15/30 ngày)" = 150,000đ cộng vào hóa đơn tháng 12,
//      → Và sang tháng 01/2027 không bị thu trùng lần 2.
// ─────────────────────────────────────────────────────────────────────────────
test('BUG-HUNT B10: Đăng ký dịch vụ bất ngờ giữa tháng — Phương án A (UNBILLED, DRAFT_UPDATED, DEFERRED_TO_NEXT_PERIOD)', async (t) => {
  const baseContract = {
    id: 'contract-1',
    org_id: 'org-1',
    building_id: 'bld-1',
    start_date: '2026-01-01',
    end_date: '2027-06-01',
    rent_amount: 10_000_000,
  };

  // Đăng ký ngày 16/11/2026 -> dùng từ 16/11 đến 30/11 = 15/30 ngày -> pro-rata = 150,000đ
  const midMonthNewSub = {
    id: 'sub-new-internet',
    org_id: 'org-1',
    building_id: 'bld-1',
    contract_id: 'contract-1',
    service_code: 'INTERNET_FIBER',
    service_name: 'Internet Cáp Quang',
    unit: 'tháng',
    billing_type: 'FIXED',
    status: 'ACTIVE',
    start_date: '2026-11-16',
    end_date: null,
    unit_price: 300_000,
    quantity: 1,
    is_price_locked: true,
  };

  await t.test('Kịch bản 1 (UNBILLED): Đăng ký ngày 16/11 khi chưa sinh hóa đơn tháng 11 → scenario="UNBILLED", phí pro-rata kỳ 2026-11 = 150,000đ (15/30 ngày)', async () => {
    const mockClient = createMockInvoiceTxClient({ invoices: [], lines: [] });

    const syncRes = await syncSubscriptionActivationInvoicesInTx(mockClient, {
      subscription: midMonthNewSub,
      contract: baseContract,
      actorId: 'mgr-1',
    });

    assert.equal(syncRes.scenario, 'UNBILLED');
    assert.equal(syncRes.updatedDraftInvoiceIds.length, 0);
    assert.equal(syncRes.deferredPeriods.length, 0);

    // Khi tới kỳ sinh hóa đơn 2026-11:
    const chargeNov = computeSubscriptionPeriodCharge({
      subscription: midMonthNewSub,
      periodYm: '2026-11',
      contractBuildingId: baseContract.building_id,
    });
    assert.equal(chargeNov.activeDays, 15, 'Từ 16/11 đến 30/11 là 15 ngày');
    assert.equal(chargeNov.daysInMonth, 30);
    assert.equal(chargeNov.isProrated, true);
    assert.equal(chargeNov.amount, 150_000, '300,000 * 15 / 30 = 150,000đ');
  });

  await t.test('Kịch bản 2 (DRAFT_UPDATED): Hóa đơn tháng 11 đang là DRAFT (10M tiền thuê), đăng ký dịch vụ ngày 16/11 → tự động chèn dòng 150k vào DRAFT, tổng thành 10.15M', async () => {
    const mockClient = createMockInvoiceTxClient({
      invoices: [
        {
          id: 'inv-nov-draft',
          org_id: 'org-1',
          building_id: 'bld-1',
          contract_id: 'contract-1',
          period: '2026-11',
          status: 'DRAFT',
          subtotal_amount: 10_000_000,
          adjustment_amount: 0,
          credit_offset_amount: 0,
          total_amount: 10_000_000,
          paid_amount: 0,
        },
      ],
      lines: [
        {
          id: 'line-rent-nov',
          invoice_id: 'inv-nov-draft',
          subscription_id: null,
          item_type: 'RENT',
          description: 'Tiền thuê phòng (2026-11)',
          unit_price: 10_000_000,
          quantity: 1,
          amount: 10_000_000,
        },
      ],
    });

    const syncRes = await syncSubscriptionActivationInvoicesInTx(mockClient, {
      subscription: midMonthNewSub,
      contract: baseContract,
      actorId: 'mgr-1',
    });

    assert.equal(syncRes.scenario, 'DRAFT_UPDATED');
    assert.deepEqual(syncRes.updatedDraftInvoiceIds, ['inv-nov-draft']);
    assert.equal(mockClient.state.lines.length, 2, 'Phải thêm 1 dòng SERVICE mới vào hóa đơn DRAFT');

    const insertedLine = mockClient.state.lines.find((l) => l.subscription_id === 'sub-new-internet');
    assert.ok(insertedLine, 'Dòng dịch vụ mới phải gắn subscription_id');
    assert.equal(insertedLine.amount, 150_000, 'Số tiền dòng mới trên DRAFT phải đúng 150,000đ (pro-rata 15/30 ngày)');
    assert.equal(insertedLine.formula_meta.billing_mode, 'PRORATED');
    assert.equal(insertedLine.formula_meta.active_days, 15);

    const updatedInv = mockClient.state.invoices[0];
    assert.equal(updatedInv.subtotal_amount, 10_150_000);
    assert.equal(updatedInv.total_amount, 10_150_000);
  });

  await t.test('Kịch bản 3A (DEFERRED_TO_NEXT_PERIOD — Phương án A): Hóa đơn tháng 11 đã PAID (10M), ngày 16/11 đăng ký dịch vụ → giữ nguyên tháng 11 PAID, truy thu 150k vào hóa đơn tháng 12', async () => {
    const mockClient = createMockInvoiceTxClient({
      invoices: [
        {
          id: 'inv-nov-paid',
          org_id: 'org-1',
          building_id: 'bld-1',
          contract_id: 'contract-1',
          invoice_code: 'INV-202611-01',
          period: '2026-11',
          status: 'PAID',
          subtotal_amount: 10_000_000,
          total_amount: 10_000_000,
          paid_amount: 10_000_000,
        },
      ],
      lines: [
        {
          id: 'line-rent-nov',
          invoice_id: 'inv-nov-paid',
          subscription_id: null,
          item_type: 'RENT',
          unit_price: 10_000_000,
          quantity: 1,
          amount: 10_000_000,
        },
      ],
    });

    // Bước 1: Duyệt dịch vụ mới ngày 16/11 khi hóa đơn tháng 11 đã PAID
    const syncRes = await syncSubscriptionActivationInvoicesInTx(mockClient, {
      subscription: midMonthNewSub,
      contract: baseContract,
      actorId: 'mgr-1',
    });

    assert.equal(syncRes.scenario, 'DEFERRED_TO_NEXT_PERIOD', 'Tháng 11 đã PAID → phải dồn sang kỳ kế tiếp');
    assert.deepEqual(syncRes.deferredPeriods, ['2026-11']);
    assert.equal(syncRes.deferredAmount, 150_000, 'Số tiền chờ truy thu sang tháng 12 là 150,000đ');
    assert.equal(mockClient.state.adjustments.length, 0, 'Phương án A: Không tạo invoice_adjustment làm biến đổi hóa đơn tháng 11 đã PAID');
    assert.equal(mockClient.state.invoices[0].status, 'PAID', 'Hóa đơn tháng 11 vẫn giữ nguyên PAID');

    // Bước 2: Sang kỳ 2026-12, sinh hóa đơn tháng 12 → thu cả tháng 12 (300k) + dòng truy thu tháng 11 (150k)
    const decRegularCharge = computeSubscriptionPeriodCharge({
      subscription: midMonthNewSub,
      periodYm: '2026-12',
      contractBuildingId: baseContract.building_id,
    });
    assert.equal(decRegularCharge.amount, 300_000, 'Phí chính thức tháng 12 là full tháng 300,000đ');

    const decArrearsLines = await collectPriorUnbilledSubscriptionArrearsLinesInTx(mockClient, {
      contract: baseContract,
      subscriptions: [midMonthNewSub],
      targetPeriodYm: '2026-12',
    });

    assert.equal(decArrearsLines.length, 1, 'Phải sinh đúng 1 dòng truy thu cho kỳ 2026-11');
    const arrLine = decArrearsLines[0];
    assert.equal(arrLine.item_type, 'SERVICE');
    assert.equal(arrLine.subscription_id, 'sub-new-internet');
    assert.equal(arrLine.amount, 150_000, 'Dòng truy thu kỳ 2026-11 phải đúng 150,000đ');
    assert.ok(arrLine.description.includes('Truy thu kỳ 2026-11'), 'Mô tả phải ghi rõ Truy thu kỳ 2026-11');
    assert.equal(arrLine.formula_meta.carry_forward_arrears, true);
    assert.equal(arrLine.formula_meta.arrears_for_period, '2026-11');

    // Bước 3: Giả lập hóa đơn tháng 12 đã lưu dòng truy thu này, sang tháng 01/2027 kiểm tra chống thu trùng
    mockClient.state.invoices.push({
      id: 'inv-dec-issued',
      org_id: 'org-1',
      building_id: 'bld-1',
      contract_id: 'contract-1',
      period: '2026-12',
      status: 'ISSUED',
      subtotal_amount: 10_450_000,
      total_amount: 10_450_000,
      paid_amount: 0,
    });
    mockClient.state.lines.push(
      {
        id: 'line-dec-reg',
        invoice_id: 'inv-dec-issued',
        subscription_id: 'sub-new-internet',
        item_type: 'SERVICE',
        amount: 300_000,
        formula_meta: decRegularCharge.formulaMeta,
      },
      {
        id: 'line-dec-arrears',
        invoice_id: 'inv-dec-issued',
        subscription_id: 'sub-new-internet',
        item_type: 'SERVICE',
        amount: arrLine.amount,
        formula_meta: arrLine.formula_meta,
      }
    );

    const janArrearsLines = await collectPriorUnbilledSubscriptionArrearsLinesInTx(mockClient, {
      contract: baseContract,
      subscriptions: [midMonthNewSub],
      targetPeriodYm: '2027-01',
    });
    assert.equal(janArrearsLines.length, 0, 'Sang tháng 01/2027 không được thu trùng khoản truy thu tháng 11 nữa');
  });

  await t.test('Kịch bản 3B: Hóa đơn tháng 11 đã ISSUED/PAID VÀ hóa đơn tháng 12 đã tạo sẵn bản DRAFT → tự động gắn luôn dòng truy thu tháng 11 (150k) + dòng tháng 12 (300k) vào DRAFT tháng 12', async () => {
    const mockClient = createMockInvoiceTxClient({
      invoices: [
        {
          id: 'inv-nov-issued',
          org_id: 'org-1',
          building_id: 'bld-1',
          contract_id: 'contract-1',
          period: '2026-11',
          status: 'ISSUED',
          subtotal_amount: 10_000_000,
          total_amount: 10_000_000,
          paid_amount: 0,
        },
        {
          id: 'inv-dec-draft',
          org_id: 'org-1',
          building_id: 'bld-1',
          contract_id: 'contract-1',
          period: '2026-12',
          status: 'DRAFT',
          subtotal_amount: 10_000_000,
          adjustment_amount: 0,
          credit_offset_amount: 0,
          total_amount: 10_000_000,
          paid_amount: 0,
        },
      ],
      lines: [
        {
          id: 'line-rent-nov',
          invoice_id: 'inv-nov-issued',
          subscription_id: null,
          item_type: 'RENT',
          amount: 10_000_000,
        },
        {
          id: 'line-rent-dec',
          invoice_id: 'inv-dec-draft',
          subscription_id: null,
          item_type: 'RENT',
          amount: 10_000_000,
        },
      ],
    });

    const syncRes = await syncSubscriptionActivationInvoicesInTx(mockClient, {
      subscription: midMonthNewSub,
      contract: baseContract,
      actorId: 'mgr-1',
    });

    assert.equal(syncRes.scenario, 'DRAFT_UPDATED');
    assert.deepEqual(syncRes.updatedDraftInvoiceIds, ['inv-dec-draft']);

    const decLines = mockClient.state.lines.filter((l) => l.invoice_id === 'inv-dec-draft');
    assert.equal(decLines.length, 3, 'DRAFT tháng 12 phải có: RENT (10M) + SERVICE tháng 12 (300k) + Truy thu tháng 11 (150k)');

    const decInv = mockClient.state.invoices.find((i) => i.id === 'inv-dec-draft');
    assert.equal(decInv.total_amount, 10_450_000, 'Tổng hóa đơn DRAFT tháng 12 = 10M + 300k + 150k = 10,450,000đ');
  });
});
