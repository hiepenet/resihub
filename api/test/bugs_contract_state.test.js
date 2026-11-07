import test from 'node:test';
import assert from 'node:assert/strict';
// Test logic contract mà không cần DB
import { isDiscountedPrice, mapPgError } from '../src/services/contractGuards.js';
import { expiryAlertDates, refundDeadline } from '../src/services/deadlines.js';
import { getMonthBoundsYmd, addDaysYmd, diffDaysYmd, toDateOnlyYmd } from '../src/services/serviceBilling.js';

// ===========================================================================
// BUG-HUNT STATE1 — Hợp đồng overlap (mapPgError)
// ===========================================================================
test('BUG-HUNT STATE1 — mapPgError: PostgreSQL overlap error 23P01', async (t) => {
  await t.test('23P01 → {status:409, code:OVERLAP_CONTRACT}', () => {
    // BUG TIỀM NĂNG: Code có thể không map đúng hoặc trả về object khác
    const result = mapPgError({ code: '23P01' });
    assert.ok(result !== null, 'Phải trả object (không phải null)');
    assert.equal(result.status, 409, 'status phải là 409');
    assert.equal(result.code, 'OVERLAP_CONTRACT', 'code phải là OVERLAP_CONTRACT');
  });

  await t.test('23505 (unique violation) → null (không phải overlap)', () => {
    // BUG TIỀM NĂNG: Code có thể nhầm 23505 với 23P01
    const result = mapPgError({ code: '23505' });
    assert.equal(result, null, '23505 phải trả null');
  });

  await t.test('23503 (foreign key violation) → null', () => {
    // BUG TIỀM NĂNG: Có thể map nhầm FK violation thành overlap
    const result = mapPgError({ code: '23503' });
    assert.equal(result, null, '23503 phải trả null');
  });

  await t.test('err=null → null', () => {
    // BUG TIỀM NĂNG: Có thể throw khi err=null
    const result = mapPgError(null);
    assert.equal(result, null, 'null input phải trả null');
  });

  await t.test('err={} (không có code) → null', () => {
    // BUG TIỀM NĂNG: Truy cập err.code khi không tồn tại có thể gây lỗi
    const result = mapPgError({});
    assert.equal(result, null, 'Object rỗng không có code phải trả null');
  });

  await t.test('err với code=23P01 + thêm message → vẫn map đúng', () => {
    // BUG TIỀM NĂNG: Các trường phụ có thể làm logic sai
    const result = mapPgError({ code: '23P01', message: 'exclusion constraint violation' });
    assert.ok(result !== null, 'Phải trả object');
    assert.equal(result.status, 409);
    assert.equal(result.code, 'OVERLAP_CONTRACT');
  });
});

// ===========================================================================
// BUG-HUNT STATE2 — Cảnh báo hợp đồng sắp hết hạn (expiryAlertDates FR-018)
// ===========================================================================
test('BUG-HUNT STATE2 — expiryAlertDates: boundary milestones 60/30/15 ngày', async (t) => {
  // Helper: tính endDate dựa vào today + days
  function dateAfter(today, days) {
    const [y, m, d] = today.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d + days));
    return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
  }

  const today = '2026-11-01';

  await t.test('Còn chính xác 60 ngày → ["60"]', () => {
    // BUG TIỀM NĂNG: Off-by-one; diffDays có thể sai timezone
    const endDate = dateAfter(today, 60);
    assert.deepEqual(expiryAlertDates(endDate, today), ['60']);
  });

  await t.test('Còn chính xác 30 ngày → ["30"]', () => {
    // BUG TIỀM NĂNG: Milestone 30 ngày có thể không được include
    const endDate = dateAfter(today, 30);
    assert.deepEqual(expiryAlertDates(endDate, today), ['30']);
  });

  await t.test('Còn chính xác 15 ngày → ["15"]', () => {
    // BUG TIỀM NĂNG: Milestone 15 ngày có thể không được include
    const endDate = dateAfter(today, 15);
    assert.deepEqual(expiryAlertDates(endDate, today), ['15']);
  });

  await t.test('Còn 61 ngày → []', () => {
    // BUG TIỀM NĂNG: 61 ngày có thể bị bắt nhầm thành 60
    const endDate = dateAfter(today, 61);
    assert.deepEqual(expiryAlertDates(endDate, today), []);
  });

  await t.test('Còn 59 ngày → []', () => {
    // BUG TIỀM NĂNG: 59 ngày có thể bị match milestone 60
    const endDate = dateAfter(today, 59);
    assert.deepEqual(expiryAlertDates(endDate, today), []);
  });

  await t.test('Còn 31 ngày → []', () => {
    // BUG TIỀM NĂNG: Ranh giới 31 vs 30
    const endDate = dateAfter(today, 31);
    assert.deepEqual(expiryAlertDates(endDate, today), []);
  });

  await t.test('Còn 29 ngày → []', () => {
    // BUG TIỀM NĂNG: Ranh giới 29 vs 30
    const endDate = dateAfter(today, 29);
    assert.deepEqual(expiryAlertDates(endDate, today), []);
  });

  await t.test('Còn 16 ngày → []', () => {
    // BUG TIỀM NĂNG: Ranh giới 16 vs 15
    const endDate = dateAfter(today, 16);
    assert.deepEqual(expiryAlertDates(endDate, today), []);
  });

  await t.test('Còn 14 ngày → []', () => {
    // BUG TIỀM NĂNG: Ranh giới 14 vs 15
    const endDate = dateAfter(today, 14);
    assert.deepEqual(expiryAlertDates(endDate, today), []);
  });

  await t.test('Còn 0 ngày (hôm nay hết hạn) → []', () => {
    // BUG TIỀM NĂNG: 0 ngày không phải milestone — có thể bị match nhầm?
    assert.deepEqual(expiryAlertDates(today, today), []);
  });

  await t.test('Hết hạn 1 ngày trước (diffDays=-1) → []', () => {
    // BUG TIỀM NĂNG: diffDays âm không được trigger milestone
    const endDate = dateAfter(today, -1);
    assert.deepEqual(expiryAlertDates(endDate, today), []);
  });

  await t.test("endDate='' (rỗng), today='2026-11-01' → []", () => {
    // BUG TIỀM NĂNG: Input rỗng có thể gây NaN hoặc throw
    assert.deepEqual(expiryAlertDates('', '2026-11-01'), []);
  });
});

// ===========================================================================
// BUG-HUNT STATE3 — Deadline hoàn cọc (refundDeadline FR-068)
// ===========================================================================
test('BUG-HUNT STATE3 — refundDeadline: tính dueAt và warnAt', async (t) => {
  await t.test('terminatedAt=2026-11-01, refundDays=5 → dueAt=2026-11-06, warnAt=2026-11-04', () => {
    // BUG TIỀM NĂNG: Tính sai warnAt = due - 2 ngày
    const { dueAt, warnAt } = refundDeadline('2026-11-01', 5);
    assert.equal(dueAt, '2026-11-06', 'dueAt = terminatedAt + 5 ngày');
    assert.equal(warnAt, '2026-11-04', 'warnAt = dueAt - 2 ngày = terminatedAt + 3');
  });

  await t.test('refundDays=3 → dueAt=2026-11-04, warnAt=2026-11-02', () => {
    // BUG TIỀM NĂNG: warnDays = max(0, 3-2) = 1 → warnAt = terminatedAt + 1
    const { dueAt, warnAt } = refundDeadline('2026-11-01', 3);
    assert.equal(dueAt, '2026-11-04');
    assert.equal(warnAt, '2026-11-02');
  });

  await t.test('refundDays=1 → dueAt=2026-11-02, warnAt=2026-11-01 (warnDays=max(0,1-2)=0)', () => {
    // BUG TIỀM NĂNG: Khi refundDays < 2, warnAt phải bằng terminatedAt chứ không phải âm
    const { dueAt, warnAt } = refundDeadline('2026-11-01', 1);
    assert.equal(dueAt, '2026-11-02', 'dueAt = terminatedAt + 1');
    assert.equal(warnAt, '2026-11-01', 'warnAt = terminatedAt + 0 = chính ngày chấm dứt');
  });

  await t.test('refundDays=0 → fallback 5 ngày (giá trị 0 không hợp lệ)', () => {
    // BUG TIỀM NĂNG: Điều kiện >= 1 nghĩa là 0 phải fallback về 5
    const { dueAt } = refundDeadline('2026-11-01', 0);
    assert.equal(dueAt, '2026-11-06', 'refundDays=0 fallback 5 ngày');
  });

  await t.test('refundDays=null → fallback 5 ngày', () => {
    // BUG TIỀM NĂNG: null input có thể gây NaN, không fallback
    const { dueAt } = refundDeadline('2026-11-01', null);
    assert.equal(dueAt, '2026-11-06', 'refundDays=null fallback 5 ngày');
  });

  await t.test("refundDays='abc' → fallback 5 ngày", () => {
    // BUG TIỀM NĂNG: String không hợp lệ có thể pass Number.isFinite('abc') = false
    const { dueAt } = refundDeadline('2026-11-01', 'abc');
    assert.equal(dueAt, '2026-11-06', "refundDays='abc' fallback 5 ngày");
  });

  await t.test('Cuối tháng: terminatedAt=2026-01-31, refundDays=5 → dueAt=2026-02-05', () => {
    // BUG TIỀM NĂNG: Tràn tháng có thể bị tính sai (ví dụ 2026-01-36 không tự normalize)
    const { dueAt } = refundDeadline('2026-01-31', 5);
    assert.equal(dueAt, '2026-02-05', 'Phải vượt tháng đúng');
  });

  await t.test('Cuối năm: terminatedAt=2026-12-31, refundDays=5 → dueAt=2027-01-05', () => {
    // BUG TIỀM NĂNG: Tràn năm (2026-12-36 → 2027-01-05)
    const { dueAt } = refundDeadline('2026-12-31', 5);
    assert.equal(dueAt, '2027-01-05', 'Phải vượt năm đúng');
  });
});

// ===========================================================================
// BUG-HUNT STATE4 — Date utilities (addDaysYmd, diffDaysYmd)
// ===========================================================================
test('BUG-HUNT STATE4 — addDaysYmd: xử lý biên tháng/năm/ngày nhuận', async (t) => {
  await t.test("addDaysYmd('2026-01-31', 1) → '2026-02-01'", () => {
    // BUG TIỀM NĂNG: Cuối tháng 1 → tháng 2
    assert.equal(addDaysYmd('2026-01-31', 1), '2026-02-01');
  });

  await t.test("addDaysYmd('2026-02-28', 1) [2026 không nhuận] → '2026-03-01'", () => {
    // BUG TIỀM NĂNG: 2026 không nhuận; +1 phải nhảy sang tháng 3
    assert.equal(addDaysYmd('2026-02-28', 1), '2026-03-01');
  });

  await t.test("addDaysYmd('2024-02-28', 1) [2024 nhuận] → '2024-02-29'", () => {
    // BUG TIỀM NĂNG: 2024 là năm nhuận; +1 phải là ngày 29 không phải 01/03
    assert.equal(addDaysYmd('2024-02-28', 1), '2024-02-29');
  });

  await t.test("addDaysYmd('2026-12-31', 1) → '2027-01-01'", () => {
    // BUG TIỀM NĂNG: Cuối năm → đầu năm mới
    assert.equal(addDaysYmd('2026-12-31', 1), '2027-01-01');
  });

  await t.test("addDaysYmd('2026-01-15', -15) → '2025-12-31'", () => {
    // BUG TIỀM NĂNG: Delta âm vượt qua ranh giới năm
    assert.equal(addDaysYmd('2026-01-15', -15), '2025-12-31');
  });

  await t.test("addDaysYmd('', 5) → ''", () => {
    // BUG TIỀM NĂNG: Input rỗng có thể gây lỗi thay vì trả ''
    assert.equal(addDaysYmd('', 5), '');
  });
});

test('BUG-HUNT STATE4 — diffDaysYmd: tính số ngày chênh lệch', async (t) => {
  await t.test("diffDaysYmd('2026-11-01', '2026-11-01') → 0", () => {
    // BUG TIỀM NĂNG: Cùng ngày phải trả 0
    assert.equal(diffDaysYmd('2026-11-01', '2026-11-01'), 0);
  });

  await t.test("diffDaysYmd('2026-11-01', '2026-12-01') → 30", () => {
    // BUG TIỀM NĂNG: Tháng 11 có 30 ngày (không phải 31)
    assert.equal(diffDaysYmd('2026-11-01', '2026-12-01'), 30);
  });

  await t.test("diffDaysYmd('2026-11-01', '2026-10-01') → -31 (âm)", () => {
    // BUG TIỀM NĂNG: end < start phải trả số âm; tháng 10 có 31 ngày
    assert.equal(diffDaysYmd('2026-11-01', '2026-10-01'), -31);
  });
});
