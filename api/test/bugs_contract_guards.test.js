/**
 * BUG-HUNT: Contract Guards & Deadline Edge Cases
 * Tests designed to find bugs in contractGuards.js and deadlines.js.
 * Run: node --test api/test/bugs_contract_guards.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { isDiscountedPrice, mapPgError } from '../src/services/contractGuards.js';
import { refundDeadline, expiryAlertDates } from '../src/services/deadlines.js';

// ─────────────────────────────────────────────────────────────────────────────
// GROUP C1 — isDiscountedPrice
// Spec: Giá < 90% base → yêu cầu duyệt (PENDING_APPROVAL).
// BUG TIỀM NĂNG:
//   - Điều kiện: `Number(rentAmount) < Number(baseRent) * 0.9`
//   - rent = 90% base: 9M < 0.9 × 10M = 9M → 9M < 9M = FALSE (strict <, không <=)
//   - rent = 89.9% base: 8990000 < 9000000 = TRUE
//   - rent = 100% base: 10M < 9M = FALSE
//   - baseRent=0: `!baseRent || Number(0) <= 0` → return false (guard)
//   - baseRent=null: `!null` = true → return false
//   - rentAmount=0, baseRent=1M: 0 < 900000 = TRUE (giá = 0 → discounted)
//   - String input: Number("8000000") và Number("10000000") → hoạt động
// ─────────────────────────────────────────────────────────────────────────────
test('BUG-HUNT C1: isDiscountedPrice boundary', async (t) => {

  await t.test('rent = 90% base → FALSE (không yêu cầu duyệt, vì điều kiện là < 0.9, không phải <=)', () => {
    // 9_000_000 < 10_000_000 * 0.9 = 9_000_000 → 9M < 9M = false
    const result = isDiscountedPrice(9_000_000, 10_000_000);
    assert.equal(result, false,
      'BUG: 90% base chính xác = FALSE (strict <), không yêu cầu duyệt');
  });

  await t.test('rent = 89.9% base → TRUE (yêu cầu duyệt)', () => {
    // 8_990_000 < 10_000_000 * 0.9 = 9_000_000 → TRUE
    const result = isDiscountedPrice(8_990_000, 10_000_000);
    assert.equal(result, true, 'BUG: 89.9% < 90% → yêu cầu duyệt');
  });

  await t.test('rent = 89% base → TRUE', () => {
    const result = isDiscountedPrice(8_900_000, 10_000_000);
    assert.equal(result, true);
  });

  await t.test('rent = 100% base → FALSE', () => {
    const result = isDiscountedPrice(10_000_000, 10_000_000);
    assert.equal(result, false);
  });

  await t.test('baseRent=0 → FALSE (không div-by-zero, guard)', () => {
    // !baseRent = !0 = true → return false
    assert.doesNotThrow(() => {
      const result = isDiscountedPrice(1_000_000, 0);
      assert.equal(result, false, 'baseRent=0 → FALSE (guard chống div-by-zero)');
    });
  });

  await t.test('baseRent=null → FALSE', () => {
    assert.doesNotThrow(() => {
      const result = isDiscountedPrice(1_000_000, null);
      assert.equal(result, false, 'baseRent=null → FALSE');
    });
  });

  await t.test('rentAmount=0 với baseRent=1M → TRUE (0 < 900k)', () => {
    // BUG TIỀM NĂNG: giá = 0 vẫn là discounted price
    const result = isDiscountedPrice(0, 1_000_000);
    assert.equal(result, true,
      'BUG: rentAmount=0 với baseRent=1M → 0 < 900k = TRUE, yêu cầu duyệt');
  });

  await t.test('string input: isDiscountedPrice("8000000", "10000000") → TRUE', () => {
    // Number("8000000") = 8M, Number("10000000") = 10M, 8M < 9M = true
    const result = isDiscountedPrice('8000000', '10000000');
    assert.equal(result, true,
      'BUG TIỀM NĂNG: string input phải được Number() convert → TRUE');
  });

  await t.test('baseRent=undefined → FALSE', () => {
    assert.doesNotThrow(() => {
      const result = isDiscountedPrice(1_000_000, undefined);
      assert.equal(result, false, 'baseRent=undefined → !undefined = true → FALSE');
    });
  });

  await t.test('cả hai là 0 → FALSE', () => {
    // !baseRent = !0 = true → return false
    const result = isDiscountedPrice(0, 0);
    assert.equal(result, false, 'cả hai = 0 → guard baseRent=0 → FALSE');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GROUP C2 — mapPgError
// BUG TIỀM NĂNG:
//   - Chỉ handle '23P01', các code khác (kể cả '23505' unique violation) → null
//   - err=null → null (guard)
//   - err={} không có code → null
// ─────────────────────────────────────────────────────────────────────────────
test('BUG-HUNT C2: mapPgError PostgreSQL error mapping', async (t) => {

  await t.test('err.code="23P01" → {status:409, code:"OVERLAP_CONTRACT"}', () => {
    const result = mapPgError({ code: '23P01', message: 'exclusion constraint violated' });
    assert.ok(result !== null, 'Phải trả object, không phải null');
    assert.equal(result.status, 409);
    assert.equal(result.code, 'OVERLAP_CONTRACT');
  });

  await t.test('err.code="23505" (unique violation) → null (không handle)', () => {
    // BUG TIỀM NĂNG: developer nhầm 23505 cũng được handle
    const result = mapPgError({ code: '23505', message: 'duplicate key' });
    assert.equal(result, null,
      'BUG: 23505 (unique violation) không được handle bởi mapPgError → null');
  });

  await t.test('err=null → null', () => {
    assert.doesNotThrow(() => {
      assert.equal(mapPgError(null), null);
    });
  });

  await t.test('err=undefined → null', () => {
    assert.doesNotThrow(() => {
      // !undefined = true → return null
      assert.equal(mapPgError(undefined), null);
    });
  });

  await t.test('err={} (không có code) → null', () => {
    const result = mapPgError({});
    assert.equal(result, null, 'err không có code → code=undefined !== "23P01" → null');
  });

  await t.test('err.code khác (e.g., "08006" connection failure) → null', () => {
    const result = mapPgError({ code: '08006' });
    assert.equal(result, null);
  });

  await t.test('err.code="23P01" nhưng là lowercase "23p01" → null (strict equality)', () => {
    // BUG TIỀM NĂNG: `err.code === '23P01'` strict, '23p01' !== '23P01' → null
    const result = mapPgError({ code: '23p01' });
    assert.equal(result, null,
      'BUG: code case-sensitive, lowercase "23p01" không match → null');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GROUP C3 — refundDeadline (FR-068)
// Spec:
//   - dueAt = terminatedAt + refundDays ngày
//   - warnAt = terminatedAt + max(0, refundDays - 2) ngày
// BUG TIỀM NĂNG:
//   - refundDays=0 hoặc âm → fallback về 5
//   - refundDays=1 → warnDays = max(0, 1-2) = 0 → warnAt = ngày chấm dứt
//   - refundDays=3 → warnDays = max(0, 3-2) = 1 → warnAt = terminatedAt + 1
// ─────────────────────────────────────────────────────────────────────────────
test('BUG-HUNT C3: refundDeadline deadline calculation', async (t) => {

  await t.test('terminatedAt="2026-11-01", refundDays=5 → dueAt="2026-11-06", warnAt="2026-11-04"', () => {
    // dueAt = 2026-11-01 + 5 = 2026-11-06
    // warnDays = max(0, 5-2) = 3 → warnAt = 2026-11-01 + 3 = 2026-11-04
    const r = refundDeadline('2026-11-01', 5);
    assert.equal(r.dueAt, '2026-11-06', 'dueAt = terminatedAt + 5 ngày');
    assert.equal(r.warnAt, '2026-11-04', 'warnAt = terminatedAt + 3 ngày (5-2=3)');
  });

  await t.test('refundDays=3 → dueAt=ngày+3, warnAt=ngày+1 (warn = due - 2)', () => {
    // dueAt = 2026-11-01 + 3 = 2026-11-04
    // warnDays = max(0, 3-2) = 1 → warnAt = 2026-11-01 + 1 = 2026-11-02
    const r = refundDeadline('2026-11-01', 3);
    assert.equal(r.dueAt, '2026-11-04');
    assert.equal(r.warnAt, '2026-11-02', 'warnAt = terminatedAt + 1 (max(0, 3-2)=1)');
  });

  await t.test('refundDays=0 → fallback về 5', () => {
    // Number.isFinite(0) && 0 >= 1 = false → fallback = 5
    const r = refundDeadline('2026-11-01', 0);
    const rDefault = refundDeadline('2026-11-01', 5);
    assert.deepEqual(r, rDefault, 'BUG: refundDays=0 phải fallback về 5');
  });

  await t.test('refundDays=-1 → fallback về 5', () => {
    // Number.isFinite(-1) && -1 >= 1 = false → fallback = 5
    const r = refundDeadline('2026-11-01', -1);
    const rDefault = refundDeadline('2026-11-01', 5);
    assert.deepEqual(r, rDefault, 'BUG: refundDays=-1 phải fallback về 5');
  });

  await t.test('refundDays=1 → dueAt=ngày+1, warnAt=ngày+0 (max(0, 1-2)=0)', () => {
    // warnDays = max(0, 1-2) = 0 → warnAt = terminatedAt + 0 = terminatedAt itself
    const r = refundDeadline('2026-11-01', 1);
    assert.equal(r.dueAt, '2026-11-02', 'dueAt = terminatedAt + 1');
    assert.equal(r.warnAt, '2026-11-01', 'BUG: warnAt = terminatedAt (max(0,1-2)=0 ngày)');
  });

  await t.test('refundDays=NaN → fallback về 5', () => {
    // Number.isFinite(NaN) = false → fallback = 5
    const r = refundDeadline('2026-11-01', NaN);
    const rDefault = refundDeadline('2026-11-01', 5);
    assert.deepEqual(r, rDefault, 'refundDays=NaN → fallback 5');
  });

  await t.test('cuối tháng: 2026-11-30 + 5 ngày → 2026-12-05', () => {
    const r = refundDeadline('2026-11-30', 5);
    assert.equal(r.dueAt, '2026-12-05', 'Roll over sang tháng tiếp theo');
  });

  await t.test('cuối năm: 2026-12-31 + 5 ngày → 2027-01-05', () => {
    const r = refundDeadline('2026-12-31', 5);
    assert.equal(r.dueAt, '2027-01-05', 'Roll over sang năm mới');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GROUP C4 — expiryAlertDates (FR-018)
// Spec: Cảnh báo tại đúng mốc 60/30/15 ngày trước khi hết hạn.
// BUG TIỀM NĂNG:
//   - Chỉ cảnh báo khi diffDays CHÍNH XÁC là 60, 30, hoặc 15 (không phải <= hoặc >=)
//   - 61 ngày → [] (chưa đến mốc)
//   - 29 ngày → [] (không phải mốc nào)
//   - 0 ngày (hôm nay hết hạn) → [] (hết hạn rồi, không phải mốc)
//   - Âm (đã hết hạn) → []
// ─────────────────────────────────────────────────────────────────────────────
test('BUG-HUNT C4: expiryAlertDates milestone detection', async (t) => {

  // Helper: tính ngày endDate từ today + days
  function addDays(dateStr, days) {
    const [y, m, d] = dateStr.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d + days));
    return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
  }

  const today = '2026-11-07';

  await t.test('còn đúng 60 ngày → ["60"]', () => {
    const endDate = addDays(today, 60); // 60 ngày từ hôm nay
    const result = expiryAlertDates(endDate, today);
    assert.deepEqual(result, ['60'], 'BUG: đúng 60 ngày → phải alert ["60"]');
  });

  await t.test('còn đúng 30 ngày → ["30"]', () => {
    const endDate = addDays(today, 30);
    const result = expiryAlertDates(endDate, today);
    assert.deepEqual(result, ['30'], 'BUG: đúng 30 ngày → phải alert ["30"]');
  });

  await t.test('còn đúng 15 ngày → ["15"]', () => {
    const endDate = addDays(today, 15);
    const result = expiryAlertDates(endDate, today);
    assert.deepEqual(result, ['15'], 'BUG: đúng 15 ngày → phải alert ["15"]');
  });

  await t.test('còn 61 ngày → [] (chưa đến mốc 60)', () => {
    const endDate = addDays(today, 61);
    const result = expiryAlertDates(endDate, today);
    assert.deepEqual(result, [], 'BUG: 61 ngày → không phải mốc nào → []');
  });

  await t.test('còn 29 ngày → [] (giữa mốc 30 và 15)', () => {
    const endDate = addDays(today, 29);
    const result = expiryAlertDates(endDate, today);
    assert.deepEqual(result, [], '29 ngày không phải mốc → []');
  });

  await t.test('còn 0 ngày (hôm nay hết hạn) → []', () => {
    // diffDays = 0, không phải 60/30/15 → []
    const result = expiryAlertDates(today, today);
    assert.deepEqual(result, [],
      'BUG: hôm nay hết hạn (0 ngày) → không phải mốc cảnh báo → []');
  });

  await t.test('âm (đã hết hạn hôm qua) → []', () => {
    const endDate = addDays(today, -1); // hôm qua
    const result = expiryAlertDates(endDate, today);
    assert.deepEqual(result, [], 'Đã hết hạn → []');
  });

  await t.test('endDate=null → []', () => {
    const result = expiryAlertDates(null, today);
    assert.deepEqual(result, [], 'endDate=null → []');
  });

  await t.test('today=null → []', () => {
    const result = expiryAlertDates(addDays(today, 30), null);
    assert.deepEqual(result, [], 'today=null → []');
  });

  await t.test('cả hai milestones không trùng: 45 ngày → []', () => {
    const endDate = addDays(today, 45);
    const result = expiryAlertDates(endDate, today);
    assert.deepEqual(result, [], '45 ngày không phải mốc nào → []');
  });

  await t.test('BUG TIỀM NĂNG: endDate có time component → phải parse đúng (T00:00:00)', () => {
    // Code dùng endDate.split('T')[0] → xử lý được ISO string
    const endDateIso = addDays(today, 60) + 'T00:00:00+07:00';
    const result = expiryAlertDates(endDateIso, today);
    assert.deepEqual(result, ['60'],
      'BUG: endDate ISO với timezone phải vẫn được xử lý đúng');
  });
});
