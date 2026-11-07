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
