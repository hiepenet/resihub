/**
 * BUG-HUNT: Pricing & Deposit Settlement Edge Cases
 * Tests designed to find bugs, NOT to verify happy path.
 * Run: node --test api/test/bugs_pricing_edge_cases.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { roundVND, calcProrata, calcUtility } from '../src/services/pricing.js';
import {
  isPositiveSafeIntegerVnd,
  validateDeduction,
  computeRefund,
  resolvePostSettlementStatus,
  validateRefundBankInfo,
  computeSuggestedCancelSplit,
  computeFinalSettlementWithCredit,
  getTodayVnDateStr,
  splitDepositOpening,
  isSettlementSnapshotStale,
  normalizeOpenInvoiceSnapshot,
} from '../src/services/depositSettlement.js';

// ─────────────────────────────────────────────────────────────────────────────
// GROUP A1 — roundVND
// BUG TIỀM NĂNG:
//   - `Number(null || 0)` = 0, nhưng `Number(undefined || 0)` cũng = 0 → OK
//   - `Number("1500abc")` = NaN, `NaN || 0` = 0 → code nên trả 0
//   - Infinity: `Number(Infinity || 0)` = Infinity, nhưng isFinite check sẽ bắt → trả 0
//   - Negative: code dùng sign * Math.round(|x|/1000)*1000 → round half-away-from-zero (đúng hướng âm)
//   - roundVND(999): |999|/1000 = 0.999 → Math.round = 1 → 1*1000 = 1000. BUG TIỀM NĂNG: có thể code trả 0!
// ─────────────────────────────────────────────────────────────────────────────
test('BUG-HUNT A1: roundVND edge cases', async (t) => {

  await t.test('null → 0 (không throw)', () => {
    // BUG: `Number(null || 0)` = 0, early return 0 expected
    assert.doesNotThrow(() => roundVND(null));
    assert.equal(roundVND(null), 0);
  });

  await t.test('undefined → 0', () => {
    // BUG: `Number(undefined || 0)` = 0 expected
    assert.doesNotThrow(() => roundVND(undefined));
    assert.equal(roundVND(undefined), 0);
  });

  await t.test('"1500abc" (chuỗi lẫn chữ) → 0', () => {
    // BUG: Number("1500abc") = NaN, NaN || 0 = 0, isFinite(0) check → 0
    // Nếu code dùng Number("1500abc" || 0) thì vẫn NaN
    assert.equal(roundVND('1500abc'), 0);
  });

  await t.test('-500 → 0 hay -1000? (documenting boundary behavior)', () => {
    // Math.round(500/1000) = Math.round(0.5) = 1 (JS banker's rounding? No: Math.round rounds half-up)
    // => sign=-1, Math.round(0.5)=1, result = -1 * 1 * 1000 = -1000
    // BUG TIỀM NĂNG: developer mong đợi -500 → 0 (tức là làm tròn về 0) nhưng code trả -1000
    const result = roundVND(-500);
    // Documenting expected behavior: -500 → -1000 (round half AWAY from zero for negatives)
    assert.equal(result, -1000, 'BUG: -500 nên round thành -1000 (half-away-from-zero), không phải 0');
  });

  await t.test('-1500 → -2000 (round toward negative infinity for negative halfway)', () => {
    // sign=-1, Math.round(1500/1000)=Math.round(1.5)=2, result=-2000
    assert.equal(roundVND(-1500), -2000);
  });

  await t.test('Infinity → 0', () => {
    // Number.isFinite(Infinity) = false → early return 0
    assert.equal(roundVND(Number.POSITIVE_INFINITY), 0);
  });

  await t.test('NaN → 0', () => {
    // Number(NaN || 0) = 0 → early return 0
    assert.equal(roundVND(Number.NaN), 0);
  });

  await t.test('999 → 1000 (không phải 0!)', () => {
    // BUG TIỀM NĂNG: developer nhầm Math.round(0.999) = 1 → 1000, không phải 0
    // `Number(999 || 0)` = 999, isFinite=true, sign=1, Math.round(999/1000)=Math.round(0.999)=1 → 1000
    assert.equal(roundVND(999), 1000, 'BUG: 999 phải round thành 1000, không phải 0');
  });

  await t.test('1001 → 1000', () => {
    // Math.round(1001/1000) = Math.round(1.001) = 1 → 1000
    assert.equal(roundVND(1001), 1000);
  });

  await t.test('1500 → 2000 (round up tại exact halfway)', () => {
    // Math.round(1.5) = 2 → 2000
    assert.equal(roundVND(1500), 2000);
  });

  await t.test('"1000" (string số) → 1000', () => {
    // Number("1000" || 0) = 1000 → 1000
    assert.equal(roundVND('1000'), 1000);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GROUP A2 — calcProrata
// BUG TIỀM NĂNG:
//   - activeDays > daysInMonth sẽ trả full price (code có guard: if active >= totalDays return roundVND(price*qty))
//   - quantity=0: Number(0??1)=0, 0*price=0 → trả 0 (nhưng guard check là qty??1, nếu qty=0 thì vẫn 0??1=0)
//     Thực ra: `const qty = Number(quantity ?? 1)` → quantity=0 → qty=0 → trả 0 (BUG: defaulting không giúp)
//   - quantity="2": Number("2")=2, hợp lệ
//   - daysInMonth=0: guard check totalDays <= 0 → return 0
//   - activeDays < 0: active || 0 = 0 (nếu dùng ||) → guard active <= 0 → return 0
// ─────────────────────────────────────────────────────────────────────────────
test('BUG-HUNT A2: calcProrata edge cases', async (t) => {

  await t.test('activeDays > daysInMonth không tính vượt full price', () => {
    // 35 ngày trong tháng 31 → trả full price = 10M
    const result = calcProrata({ monthlyPrice: 10_000_000, activeDays: 35, daysInMonth: 31 });
    assert.equal(result, 10_000_000, 'activeDays > daysInMonth phải = full price');
  });

  await t.test('quantity = 0 → 0', () => {
    // BUG TIỀM NĂNG: quantity=0, code: Number(0??1) = 0 (không phải 1 vì 0 không phải null/undefined)
    const result = calcProrata({ monthlyPrice: 1_000_000, quantity: 0, activeDays: 15, daysInMonth: 30 });
    assert.equal(result, 0, 'quantity=0 → 0');
  });

  await t.test('quantity = "2" (string) → 2x price', () => {
    // Number("2") = 2, nên result = roundVND(1M * 2 * 30/30) = 2M
    const result = calcProrata({ monthlyPrice: 1_000_000, quantity: '2', activeDays: 30, daysInMonth: 30 });
    assert.equal(result, 2_000_000, 'quantity string "2" → 2 lần giá');
  });

  await t.test('daysInMonth = 0 → 0 (không div-by-zero)', () => {
    assert.doesNotThrow(() => calcProrata({ monthlyPrice: 1_000_000, activeDays: 5, daysInMonth: 0 }));
    assert.equal(calcProrata({ monthlyPrice: 1_000_000, activeDays: 5, daysInMonth: 0 }), 0);
  });

  await t.test('activeDays < 0 → 0', () => {
    // `const active = Number(activeDays || 0)` → -5 || 0 = -5 (truthy)
    // But guard: active <= 0 → return 0. BUG TIỀM NĂNG: -5 || 0 = -5, isFinite(-5) = true, -5 <= 0 → return 0 ✓
    const result = calcProrata({ monthlyPrice: 1_000_000, activeDays: -5, daysInMonth: 30 });
    assert.equal(result, 0, 'activeDays < 0 → 0');
  });

  await t.test('tháng 2 nhuận 2024 (29 ngày): activeDays=15 → roundVND(10M*15/29)', () => {
    const expected = roundVND(10_000_000 * 15 / 29);
    const result = calcProrata({ monthlyPrice: 10_000_000, activeDays: 15, daysInMonth: 29 });
    assert.equal(result, expected, `Tháng 2 nhuận: 10M*15/29 = ${expected}`);
  });

  await t.test('full month activeDays === daysInMonth=31 → full price', () => {
    const result = calcProrata({ monthlyPrice: 10_000_000, activeDays: 31, daysInMonth: 31 });
    assert.equal(result, 10_000_000, 'Full month → full price');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GROUP A3 — calcUtility
// BUG TIỀM NĂNG:
//   - float precision: 100.3 - 100.1 = 0.19999... → code dùng toFixed(4) để bù
//   - curr < prev → throw RangeError('INVALID_READING')
//   - unitPrice=0 → 0
//   - rất nhỏ: 0.001 kWh × 22000 = 22 → roundVND(22) = 0
// ─────────────────────────────────────────────────────────────────────────────
test('BUG-HUNT A3: calcUtility edge cases', async (t) => {

  await t.test('float precision: prev=100.1, curr=100.3, unitPrice=22000 → không âm', () => {
    // 100.3 - 100.1 = 0.19999999... (float) → code dùng toFixed(4) → 0.2000 → roundVND(0.2*22000) = roundVND(4400) = 4000
    const result = calcUtility({ previousReading: 100.1, currentReading: 100.3, unitPrice: 22000 });
    assert.ok(result >= 0, `BUG: kết quả phải >= 0, nhận được ${result}`);
  });

  await t.test('curr === prev → 0', () => {
    const result = calcUtility({ previousReading: 150, currentReading: 150, unitPrice: 22000 });
    assert.equal(result, 0);
  });

  await t.test('curr < prev → throw RangeError với INVALID_READING', () => {
    assert.throws(
      () => calcUtility({ previousReading: 200, currentReading: 150, unitPrice: 22000 }),
      (err) => {
        assert.ok(err instanceof RangeError, 'Phải là RangeError');
        assert.ok(err.message.includes('INVALID_READING'), 'Message phải chứa INVALID_READING');
        return true;
      }
    );
  });

  await t.test('unitPrice = 0 → 0', () => {
    const result = calcUtility({ previousReading: 100, currentReading: 200, unitPrice: 0 });
    assert.equal(result, 0);
  });

  await t.test('chỉ số rất nhỏ: prev=0, curr=0.001, unitPrice=22000 → roundVND(22) = 0', () => {
    // 0.001 * 22000 = 22 → roundVND(22) = 0 (22 < 500)
    const result = calcUtility({ previousReading: 0, currentReading: 0.001, unitPrice: 22000 });
    assert.equal(result, 0, 'BUG: 0.001 đơn vị × 22000 = 22đ → làm tròn về 0');
  });

  await t.test('NaN input → throw (currentReading=NaN)', () => {
    // curr = NaN, !isFinite → throw
    assert.throws(() => calcUtility({ previousReading: 0, currentReading: NaN, unitPrice: 22000 }));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GROUP A4 — validateDeduction
// BUG TIỀM NĂNG:
//   - category='RENT' bị block TRƯỚC khi check amount/evidence → thứ tự quan trọng
//   - category='rent' (lowercase): ĐÃ FIX — normalize toUpperCase() → RENT_DEDUCTION_FORBIDDEN
//   - evidence=[] → EVIDENCE_REQUIRED
//   - evidence không phải array → EVIDENCE_REQUIRED
//   - amount=1.5 (float) → isPositiveSafeIntegerVnd(1.5) = Number.isSafeInteger(1.5) = false → INVALID_AMOUNT
//   - amount="1000" (string số) → isPositiveSafeIntegerVnd("1000") checks /^[1-9]\d*$/.test("1000") = true → ok
//   - description="   " (whitespace) → description.trim() = "" → INVALID_DESCRIPTION
// ─────────────────────────────────────────────────────────────────────────────
test('BUG-HUNT A4: validateDeduction edge cases', async (t) => {

  const baseValid = {
    category: 'DAMAGE',
    amount: 500_000,
    description: 'Vỡ kính cửa sổ',
    evidence: ['img1.jpg'],
  };

  await t.test('category="RENT" → RENT_DEDUCTION_FORBIDDEN', () => {
    const r = validateDeduction({ ...baseValid, category: 'RENT' });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'RENT_DEDUCTION_FORBIDDEN');
  });

  await t.test('category="rent" (lowercase) → RENT_DEDUCTION_FORBIDDEN [FIXED: normalize toUpperCase]', () => {
    // FIX BP-002: validateDeduction giờ normalize category sang uppercase
    // 'rent' → 'RENT' → bị block đúng nghiệp vụ FR-068
    const r = validateDeduction({ ...baseValid, category: 'rent' });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'RENT_DEDUCTION_FORBIDDEN',
      'FIXED: "rent" lowercase phải được block giống "RENT" (case-insensitive)');
  });

  await t.test('evidence=[] → EVIDENCE_REQUIRED', () => {
    const r = validateDeduction({ ...baseValid, evidence: [] });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'EVIDENCE_REQUIRED');
  });

  await t.test('evidence không phải array (string) → EVIDENCE_REQUIRED', () => {
    const r = validateDeduction({ ...baseValid, evidence: 'img1.jpg' });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'EVIDENCE_REQUIRED');
  });

  await t.test('evidence=null → EVIDENCE_REQUIRED', () => {
    const r = validateDeduction({ ...baseValid, evidence: null });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'EVIDENCE_REQUIRED');
  });

  await t.test('amount=0 → INVALID_AMOUNT', () => {
    const r = validateDeduction({ ...baseValid, amount: 0 });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'INVALID_AMOUNT');
  });

  await t.test('amount=-1000 → INVALID_AMOUNT', () => {
    const r = validateDeduction({ ...baseValid, amount: -1000 });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'INVALID_AMOUNT');
  });

  await t.test('amount=1.5 (số thực) → INVALID_AMOUNT (phải là integer)', () => {
    // BUG TIỀM NĂNG: 1.5 vượt qua Number(1.5)>0 nhưng Number.isSafeInteger(1.5)=false → reject
    const r = validateDeduction({ ...baseValid, amount: 1.5 });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'INVALID_AMOUNT', 'BUG: float amount phải bị reject');
  });

  await t.test('amount="1000" (string số) → chấp nhận vì isPositiveSafeIntegerVnd hỗ trợ string', () => {
    // isPositiveSafeIntegerVnd("1000"): /^[1-9]\d*$/.test("1000") = true, Number("1000")=1000, isSafeInteger → true
    const r = validateDeduction({ ...baseValid, amount: '1000' });
    // BUG TIỀM NĂNG: spec có thể không muốn nhận string
    assert.equal(r.ok, true, 'BUG TIỀM NĂNG: string "1000" bị accept bởi isPositiveSafeIntegerVnd');
  });

  await t.test('description="" → INVALID_DESCRIPTION', () => {
    const r = validateDeduction({ ...baseValid, description: '' });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'INVALID_DESCRIPTION');
  });

  await t.test('description="   " (whitespace only) → INVALID_DESCRIPTION', () => {
    // BUG TIỀM NĂNG: `!description.trim()` = `!""` = true → reject ✓
    const r = validateDeduction({ ...baseValid, description: '   ' });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'INVALID_DESCRIPTION');
  });

  await t.test('valid input → ok=true', () => {
    const r = validateDeduction(baseValid);
    assert.equal(r.ok, true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GROUP A5 — computeRefund
// BUG TIỀM NĂNG:
//   - Dùng BigInt → không xử lý float amount trong items (sẽ throw nếu float)
//   - items undefined → code dùng (items || []) → ok
//   - amount string trong item: code trim và BigInt("1000000") → ok
// ─────────────────────────────────────────────────────────────────────────────
test('BUG-HUNT A5: computeRefund edge cases', async (t) => {

  await t.test('cơ bản: deposit=10M, debt=1.2M, items=[{amount:800k}] → refund=8M, shortfall=0', () => {
    const r = computeRefund({
      depositAmount: 10_000_000,
      outstandingDebt: 1_200_000,
      items: [{ amount: 800_000 }],
    });
    assert.equal(r.refund, 8_000_000n);
    assert.equal(r.shortfall, 0n);
  });

  await t.test('khấu trừ > cọc: deposit=5M, debt=0, items=[{amount:7M}] → refund=0, shortfall=2M', () => {
    const r = computeRefund({
      depositAmount: 5_000_000,
      outstandingDebt: 0,
      items: [{ amount: 7_000_000 }],
    });
    assert.equal(r.refund, 0n);
    assert.equal(r.shortfall, 2_000_000n);
  });

  await t.test('deposit=0 → refund=0, shortfall=debt', () => {
    const r = computeRefund({ depositAmount: 0, outstandingDebt: 500_000, items: [] });
    assert.equal(r.refund, 0n);
    assert.equal(r.shortfall, 500_000n);
  });

  await t.test('items với amount=string "1000000" → phải xử lý được', () => {
    // BUG TIỀM NĂNG: BigInt("1000000") ok, nhưng BigInt("1000000.5") sẽ throw
    assert.doesNotThrow(() => {
      const r = computeRefund({
        depositAmount: 5_000_000,
        outstandingDebt: 0,
        items: [{ amount: '1000000' }],
      });
      assert.equal(r.refund, 4_000_000n);
    });
  });

  await t.test('items undefined → không throw', () => {
    // BUG TIỀM NĂNG: items=undefined → (undefined || []) → ok
    assert.doesNotThrow(() => {
      const r = computeRefund({ depositAmount: 5_000_000, outstandingDebt: 0, items: undefined });
      assert.equal(r.refund, 5_000_000n);
    });
  });

  await t.test('items với amount float → KHÔNG throw, tự làm tròn [FIXED: safeVndToBigInt]', () => {
    // FIX BUG-001: computeRefund giờ dùng Math.round() trước BigInt → không còn throw TypeError
    // 1500.5 → Math.round(1500.5) = 1501 → BigInt(1501) = OK
    assert.doesNotThrow(
      () => {
        const r = computeRefund({
          depositAmount: 5_000_000,
          outstandingDebt: 0,
          items: [{ amount: 1500.5 }],
        });
        // 5_000_000 - round(1500.5)=1501 → refund = 4_998_499n
        assert.equal(r.refund, 4_998_499n, 'FIXED: float amount tự động làm tròn, không crash');
      },
      'FIXED: float amount trong items không còn throw TypeError'
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GROUP A6 — resolvePostSettlementStatus
// BUG TIỀM NĂNG:
//   - refund=0, deductions=0 → phải là 'REFUNDED' (không phải DEDUCTED_FULL!)
//   - Logic: code check `refund === 0n && (totalDeductions > 0n || sf > 0n)` → DEDUCTED_FULL
//     Nếu deductions=0 và shortfall=0: totalDeductions=0, sf=0 → không vào DEDUCTED_FULL → trả REFUNDED ✓
// ─────────────────────────────────────────────────────────────────────────────
test('BUG-HUNT A6: resolvePostSettlementStatus logic', async (t) => {

  await t.test('refund=0, deductions=0, shortfall=0 → "REFUNDED" (không phải DEDUCTED_FULL!)', () => {
    // BUG TIỀM NĂNG: developer nhầm refund=0 → DEDUCTED_FULL, nhưng spec nói khi không có khấu trừ → REFUNDED
    const status = resolvePostSettlementStatus({
      refundAmount: 0,
      outstandingDebt: 0,
      items: [],
      shortfall: 0,
    });
    assert.equal(status, 'REFUNDED', 'BUG: deposit=0 không khấu trừ gì → REFUNDED không phải DEDUCTED_FULL');
  });

  await t.test('refund=5M, deductions=0, shortfall=0 → "REFUNDED"', () => {
    const status = resolvePostSettlementStatus({
      refundAmount: 5_000_000,
      outstandingDebt: 0,
      items: [],
      shortfall: 0,
    });
    assert.equal(status, 'REFUNDED');
  });

  await t.test('refund=0, deductions=1M, shortfall=0 → "DEDUCTED_FULL"', () => {
    const status = resolvePostSettlementStatus({
      refundAmount: 0,
      outstandingDebt: 1_000_000,
      items: [],
      shortfall: 0,
    });
    assert.equal(status, 'DEDUCTED_FULL');
  });

  await t.test('refund=5M, deductions=1M (items) → "PARTIALLY_REFUNDED"', () => {
    const status = resolvePostSettlementStatus({
      refundAmount: 5_000_000,
      outstandingDebt: 0,
      items: [{ amount: 1_000_000 }],
      shortfall: 0,
    });
    assert.equal(status, 'PARTIALLY_REFUNDED');
  });

  await t.test('refund=0, shortfall=2M (cọc không đủ) → "DEDUCTED_FULL"', () => {
    const status = resolvePostSettlementStatus({
      refundAmount: 0,
      outstandingDebt: 0,
      items: [],
      shortfall: 2_000_000,
    });
    assert.equal(status, 'DEDUCTED_FULL');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GROUP A7 — validateRefundBankInfo
// BUG TIỀM NĂNG:
//   - refundAmount=0 + BANK_TRANSFER không cần bank info (refundBig = 0n → skip check)
//   - method='CRYPTO' → INVALID_REFUND_METHOD
//   - account_number có dấu gạch '1234-5678' → pattern /^[A-Za-z0-9]{4,25}$/ sẽ fail → INVALID_ACCOUNT_NUMBER
//   - Nhưng thiếu bankName/accountHolder trước khi check format → BANK_INFO_REQUIRED trước
// ─────────────────────────────────────────────────────────────────────────────
test('BUG-HUNT A7: validateRefundBankInfo edge cases', async (t) => {

  const fullBankInfo = {
    bank_name: 'Vietcombank',
    account_number: '1234567890',
    account_holder: 'Nguyen Van A',
  };

  await t.test('BANK_TRANSFER + refund=1M + bankInfo đầy đủ → ok:true', () => {
    const r = validateRefundBankInfo({
      refundAmount: 1_000_000,
      refundMethod: 'BANK_TRANSFER',
      bankInfo: fullBankInfo,
    });
    assert.equal(r.ok, true);
  });

  await t.test('BANK_TRANSFER + refund=1M + thiếu account_number → BANK_INFO_REQUIRED', () => {
    const r = validateRefundBankInfo({
      refundAmount: 1_000_000,
      refundMethod: 'BANK_TRANSFER',
      bankInfo: { bank_name: 'VCB', account_holder: 'A' },
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'BANK_INFO_REQUIRED');
  });

  await t.test('account_number="1234-5678" (có dấu gạch) → INVALID_ACCOUNT_NUMBER', () => {
    // BUG TIỀM NĂNG: Nếu thiếu bank_name/holder thì sẽ bị BANK_INFO_REQUIRED trước
    // Cần đủ bank_name và holder để reach INVALID_ACCOUNT_NUMBER
    const r = validateRefundBankInfo({
      refundAmount: 1_000_000,
      refundMethod: 'BANK_TRANSFER',
      bankInfo: { bank_name: 'VCB', account_number: '1234-5678', account_holder: 'A' },
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'INVALID_ACCOUNT_NUMBER', 'BUG: account_number có dấu gạch ngang phải bị reject');
  });

  await t.test('refundAmount=0 + BANK_TRANSFER + không có bank info → ok (vì refund=0)', () => {
    // BUG TIỀM NĂNG: refundBig = 0n → `0n > 0n` = false → skip bank info check → ok
    const r = validateRefundBankInfo({
      refundAmount: 0,
      refundMethod: 'BANK_TRANSFER',
      bankInfo: {},
    });
    assert.equal(r.ok, true, 'BUG TIỀM NĂNG: refund=0 không cần bank info?');
  });

  await t.test('method="CASH" → không cần bank info → ok', () => {
    const r = validateRefundBankInfo({
      refundAmount: 5_000_000,
      refundMethod: 'CASH',
      bankInfo: {},
    });
    assert.equal(r.ok, true);
  });

  await t.test('method="CRYPTO" → INVALID_REFUND_METHOD', () => {
    const r = validateRefundBankInfo({
      refundAmount: 1_000_000,
      refundMethod: 'CRYPTO',
      bankInfo: fullBankInfo,
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'INVALID_REFUND_METHOD');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GROUP A8 — computeSuggestedCancelSplit
// BUG TIỀM NĂNG:
//   - holdAmount=0 → {refunded_amount:0, forfeited_amount:0}
//   - daysLeft >= full_refund_before_days (default 3): 5>=3 → hoàn 100%
//   - 0 <= daysLeft < 3: hoàn 50% làm tròn 1000
//   - daysLeft < 0: hoàn 0, forfeit 100%
//   - Khi holdUntil không cung cấp → daysLeft = -1 → hoàn 0
// ─────────────────────────────────────────────────────────────────────────────
test('BUG-HUNT A8: computeSuggestedCancelSplit logic', async (t) => {

  // Dùng todayStr cố định để test deterministric
  const today = '2026-11-07';

  await t.test('daysLeft=5 (>= full_refund_before_days=3) → hoàn 100%', () => {
    // holdUntil = today + 5 ngày = '2026-11-12'
    const r = computeSuggestedCancelSplit({
      holdAmount: 2_000_000,
      holdUntil: '2026-11-12',
      todayStr: today,
    });
    assert.equal(r.refunded_amount, 2_000_000, 'daysLeft=5 → hoàn toàn bộ');
    assert.equal(r.forfeited_amount, 0);
  });

  await t.test('daysLeft=2 (trong 0..2) → hoàn 50% làm tròn 1000', () => {
    // holdUntil = today + 2 = '2026-11-09'
    const r = computeSuggestedCancelSplit({
      holdAmount: 2_000_000,
      holdUntil: '2026-11-09',
      todayStr: today,
    });
    // 50% của 2M = 1M → roundVndToThousand(1M) = 1M
    assert.equal(r.refunded_amount, 1_000_000, 'daysLeft=2 → hoàn 50%');
    assert.equal(r.forfeited_amount, 1_000_000);
  });

  await t.test('daysLeft=0 → hoàn 50%', () => {
    // holdUntil = today + 0 = today itself
    const r = computeSuggestedCancelSplit({
      holdAmount: 2_000_000,
      holdUntil: today,
      todayStr: today,
    });
    assert.equal(r.refunded_amount, 1_000_000, 'daysLeft=0 → hoàn 50%');
  });

  await t.test('daysLeft=-1 → hoàn 0, forfeit 100%', () => {
    // holdUntil đã qua → daysLeft < 0
    const r = computeSuggestedCancelSplit({
      holdAmount: 2_000_000,
      holdUntil: '2026-11-06', // yesterday
      todayStr: today,
    });
    assert.equal(r.refunded_amount, 0, 'daysLeft=-1 → forfeit toàn bộ');
    assert.equal(r.forfeited_amount, 2_000_000);
  });

  await t.test('holdAmount=0 → {refunded_amount:0, forfeited_amount:0}', () => {
    const r = computeSuggestedCancelSplit({ holdAmount: 0, holdUntil: '2026-11-30', todayStr: today });
    assert.deepEqual(r, { refunded_amount: 0, forfeited_amount: 0 });
  });

  await t.test('BUG: holdAmount là odd số lẻ → partial refund làm tròn không vượt quá holdAmount', () => {
    // holdAmount=999_999, partial=50% = 499999.5 → roundVndToThousand(499999.5) = 500000
    // min(999999, 500000) = 500000 → forfeited = 999999 - 500000 = 499999
    const r = computeSuggestedCancelSplit({
      holdAmount: 999_999,
      holdUntil: '2026-11-09',
      todayStr: today,
    });
    assert.ok(r.refunded_amount + r.forfeited_amount === 999_999,
      'BUG: refunded + forfeited phải bằng holdAmount');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GROUP A9 — computeFinalSettlementWithCredit
// BUG TIỀM NĂNG:
//   - Cọc KHÔNG dùng để trừ rent (spec: credit → RENT, cọc → damages + remaining_service_debt)
//   - Thứ tự: credit → RENT → SERVICE → damages shortfall
//   - Shortfall khi tổng nợ > cọc + credit
// ─────────────────────────────────────────────────────────────────────────────
test('BUG-HUNT A9: computeFinalSettlementWithCredit logic', async (t) => {

  await t.test('credit > rent debt: credit phủ hết rent, phần dư phủ service', () => {
    const r = computeFinalSettlementWithCredit({
      heldBefore: 10_000_000,
      availableCredit: 3_000_000,
      rentDebt: 2_000_000,
      serviceDebt: 500_000,
      items: [],
    });
    assert.equal(r.credit_applied_to_rent, 2_000_000, 'Credit phủ hết rent');
    assert.equal(r.remaining_rent_debt, 0, 'Remaining rent debt = 0');
    assert.equal(r.credit_applied_to_service, 500_000, 'Credit dư phủ service');
    assert.equal(r.remaining_service_debt, 0);
  });

  await t.test('cọc KHÔNG dùng để trừ rent (cọc chỉ dùng cho damages + remaining_service_debt)', () => {
    // rentDebt=5M, không có credit → rent không được trừ từ cọc
    // covered_service_debt từ deposit phủ remaining_service_debt (không phải rent)
    const r = computeFinalSettlementWithCredit({
      heldBefore: 10_000_000,
      availableCredit: 0,
      rentDebt: 5_000_000,
      serviceDebt: 0,
      items: [],
    });
    // BUG TIỀM NĂNG: remaining_rent_debt = 5M (credit=0, không phủ được)
    // deposit không cover rent → remaining_rent_debt = 5M
    assert.equal(r.remaining_rent_debt, 5_000_000, 'BUG: Cọc không được dùng để trừ rent!');
    // deposit = 10M, damages=0 → remainingDepositAfterItems = 10M
    // covered_service_debt = min(10M, 0) = 0 → deposit_refund = 10M
    assert.equal(r.deposit_refund_amount, 10_000_000, 'Toàn bộ cọc được hoàn vì không có damages/service debt');
  });

  await t.test('thứ tự ưu tiên: credit → RENT → SERVICE → damages shortfall', () => {
    const r = computeFinalSettlementWithCredit({
      heldBefore: 5_000_000,
      availableCredit: 3_000_000,
      rentDebt: 2_000_000,
      serviceDebt: 2_000_000,
      items: [{ amount: 8_000_000 }], // damages > held
    });
    // credit: 2M → rent → 1M dư → service (cover 1M of 2M service)
    assert.equal(r.credit_applied_to_rent, 2_000_000);
    assert.equal(r.credit_applied_to_service, 1_000_000);
    // remaining_service_debt = 1M, damages=8M, held=5M
    // rawItemsShortfall = max(0, 8M-5M) = 3M
    // credit dư sau service = 0 → credit_applied_to_damages = 0
    assert.equal(r.credit_applied_to_damages, 0);
    // uncovered_items_shortfall = 3M
    assert.equal(r.uncovered_items_shortfall, 3_000_000);
    // deposit_refund = max(0, 5M-8M) = 0 → then covered_service_debt = min(0, 1M) = 0
    assert.equal(r.deposit_refund_amount, 0);
  });

  await t.test('shortfall khi tổng nợ > cọc + credit', () => {
    const r = computeFinalSettlementWithCredit({
      heldBefore: 2_000_000,
      availableCredit: 1_000_000,
      rentDebt: 0,
      serviceDebt: 0,
      items: [{ amount: 5_000_000 }], // damages 5M, nhưng chỉ có 3M (held+credit)
    });
    // rawItemsShortfall = max(0, 5M-2M) = 3M (damages - held)
    // credit_applied_to_damages = min(1M, 3M) = 1M
    // uncovered_items_shortfall = 2M
    assert.ok(r.shortfall > 0, 'Phải có shortfall khi tổng nợ > tổng nguồn');
    assert.equal(r.uncovered_items_shortfall, 2_000_000);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GROUP A10 — isSettlementSnapshotStale
// BUG TIỀM NĂNG:
//   - serviceDebt thay đổi → true (outstanding_debt thay đổi)
//   - open_invoice_snapshot thứ tự khác → false (vì normalize sort by id)
//   - Snapshot khớp → false
// ─────────────────────────────────────────────────────────────────────────────
test('BUG-HUNT A10: isSettlementSnapshotStale logic', async (t) => {

  const baseSettlement = {
    outstanding_debt: 500_000,
    rent_debt: 0,
    deposit_held_before_settlement: 10_000_000,
    available_credit: 0,
    open_invoice_snapshot: [
      { id: 'INV-001', remaining: 300_000, service_unpaid: 300_000, rent_unpaid: 0 },
      { id: 'INV-002', remaining: 200_000, service_unpaid: 200_000, rent_unpaid: 0 },
    ],
  };

  await t.test('serviceDebt thay đổi → true', () => {
    const stale = isSettlementSnapshotStale(baseSettlement, {
      serviceDebt: 999_999, // khác với outstanding_debt: 500_000
      rentDebt: 0,
      heldAmount: 10_000_000,
      openInvoices: baseSettlement.open_invoice_snapshot,
    });
    assert.equal(stale, true, 'serviceDebt thay đổi → snapshot stale');
  });

  await t.test('open_invoice_snapshot thứ tự khác → false (vì normalize sort by id)', () => {
    // BUG TIỀM NĂNG: nếu không sort thì thứ tự khác → stale. Code normalizeOpenInvoiceSnapshot sorts by id.
    const reversedInvoices = [
      { id: 'INV-002', remaining: 200_000, service_unpaid: 200_000, rent_unpaid: 0 },
      { id: 'INV-001', remaining: 300_000, service_unpaid: 300_000, rent_unpaid: 0 },
    ];
    const stale = isSettlementSnapshotStale(baseSettlement, {
      serviceDebt: 500_000,
      rentDebt: 0,
      heldAmount: 10_000_000,
      openInvoices: reversedInvoices,
    });
    assert.equal(stale, false, 'BUG TIỀM NĂNG: thứ tự khác nhưng normalize sort → không stale');
  });

  await t.test('snapshot khớp hoàn toàn → false', () => {
    const stale = isSettlementSnapshotStale(baseSettlement, {
      serviceDebt: 500_000,
      rentDebt: 0,
      heldAmount: 10_000_000,
      openInvoices: baseSettlement.open_invoice_snapshot,
    });
    assert.equal(stale, false, 'Snapshot khớp → không stale');
  });

  await t.test('savedSettlement null/undefined → false (không throw)', () => {
    assert.doesNotThrow(() => {
      assert.equal(isSettlementSnapshotStale(null, { serviceDebt: 0 }), false);
      assert.equal(isSettlementSnapshotStale(undefined, {}), false);
    });
  });

  await t.test('available_credit thay đổi → true', () => {
    const settlementWithCredit = { ...baseSettlement, available_credit: 1_000_000 };
    const stale = isSettlementSnapshotStale(settlementWithCredit, {
      serviceDebt: 500_000,
      rentDebt: 0,
      heldAmount: 10_000_000,
      availableCredit: 500_000, // khác với 1_000_000
    });
    assert.equal(stale, true, 'available_credit thay đổi → stale');
  });
});
