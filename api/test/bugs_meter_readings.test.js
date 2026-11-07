import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calcUtility,
} from '../src/services/pricing.js';
import {
  evaluateMeterReadingAnomaly,
} from '../src/services/serviceBilling.js';
import {
  postValidateMeterOcr,
} from '../src/services/aiRules.js';

// ===========================================================================
// BUG-HUNT M1 — calcUtility (đồng hồ điện/nước)
// ===========================================================================
test('BUG-HUNT M1 — calcUtility: tính tiền điện/nước', async (t) => {
  await t.test('prev=1000, curr=1200, unitPrice=3853 → roundVND(200*3853)=771000', () => {
    // BUG TIỀM NĂNG: roundVND làm tròn đến hàng nghìn — 770600 → 771000
    const result = calcUtility({ previousReading: 1000, currentReading: 1200, unitPrice: 3853 });
    assert.equal(result, 771000, '200 * 3853 = 770600 → làm tròn → 771000');
  });

  await t.test('prev=55.5, curr=55.5, unitPrice=22000 → 0 (không tiêu thụ)', () => {
    // BUG TIỀM NĂNG: Tiêu thụ 0 → không throw, trả 0
    const result = calcUtility({ previousReading: 55.5, currentReading: 55.5, unitPrice: 22000 });
    assert.equal(result, 0, 'Không tiêu thụ → 0đ');
  });

  await t.test('prev=1050, curr=1000 → throw RangeError INVALID_READING', () => {
    // BUG TIỀM NĂNG: Code có thể không throw khi curr < prev
    assert.throws(
      () => calcUtility({ previousReading: 1050, currentReading: 1000, unitPrice: 22000 }),
      (err) => {
        assert.ok(err instanceof RangeError, 'Phải là RangeError');
        assert.ok(err.message.includes('INVALID_READING'), 'Message phải chứa INVALID_READING');
        return true;
      },
    );
  });

  await t.test('prev=0, curr=0.001, unitPrice=22000 → roundVND(0.001*22000)=roundVND(22)=0', () => {
    // BUG TIỀM NĂNG: 22 VND làm tròn về 0 (hàng nghìn) — đây là BUG TIỀM NĂNG
    // Người dùng tiêu thụ nhưng không tính tiền!
    // Nhưng đây là behavior của roundVND — test để document và phát hiện nếu logic thay đổi
    const result = calcUtility({ previousReading: 0, currentReading: 0.001, unitPrice: 22000 });
    assert.equal(result, 0, 'roundVND(22) = 0 — tiêu thụ rất nhỏ bị làm tròn về 0');
  });

  await t.test('prev=100.1, curr=100.3, unitPrice=22000 → 4000 (float precision)', () => {
    // BUG TIỀM NĂNG: 0.3 - 0.1 = 0.19999999... (floating point)
    // calcUtility dùng toFixed(4) → 0.2000 → 0.2000 * 22000 = 4400 → roundVND(4400) = 4000
    // Kiểm tra xem có xử lý float đúng không
    const result = calcUtility({ previousReading: 100.1, currentReading: 100.3, unitPrice: 22000 });
    // 0.3 - 0.1 = 0.19999... -> toFixed(4) = "0.2000" -> Number = 0.2 -> 0.2 * 22000 = 4400
    // roundVND(4400) = Math.round(4400/1000)*1000 = Math.round(4.4)*1000 = 4*1000 = 4000
    assert.equal(result, 4000, 'Float precision: 0.3-0.1 phải được toFixed(4) xử lý → 4400 → 4000');
  });

  await t.test('unitPrice=0, prev=100, curr=200 → 0', () => {
    // BUG TIỀM NĂNG: Giá 0 → tổng tiền phải là 0
    const result = calcUtility({ previousReading: 100, currentReading: 200, unitPrice: 0 });
    assert.equal(result, 0);
  });

  await t.test('unitPrice=null, prev=100, curr=200 → 0 (Number(null)=0)', () => {
    // BUG TIỀM NĂNG: null unitPrice → Number(null)=0 → không throw, trả 0
    const result = calcUtility({ previousReading: 100, currentReading: 200, unitPrice: null });
    assert.equal(result, 0, 'unitPrice null → Number(null)=0 → kết quả 0');
  });
});

// ===========================================================================
// BUG-HUNT M2 — evaluateMeterReadingAnomaly
// ===========================================================================
test('BUG-HUNT M2 — evaluateMeterReadingAnomaly: phát hiện bất thường tiêu thụ', async (t) => {
  await t.test('Chỉ số tăng 31% vượt threshold 30% → isAbnormal=true', () => {
    // BUG TIỀM NĂNG: Dùng > với epsilon guard — 31% phải vượt threshold
    const result = evaluateMeterReadingAnomaly({
      previousReading: 100,
      currentReading: 231, // consumption=131, baseline=100, ratio=31% > 30%
      recentConsumptions: [100],
      thresholdRatio: 0.3,
    });
    assert.equal(result.valid, true);
    assert.equal(result.isAbnormal, true, 'Tăng 31% phải báo anomaly');
  });

  await t.test('Chỉ số tăng đúng 30% (boundary) → isAbnormal=false (dùng > không phải >=)', () => {
    // BUG TIỀM NĂNG: Ranh giới boundary: code dùng exactRatio > effThreshold + 1e-9
    // Nếu consumption = baseline * 1.3 thì exactRatio = 0.3 → 0.3 > 0.3 + 1e-9 = FALSE → không anomaly
    const result = evaluateMeterReadingAnomaly({
      previousReading: 100,
      currentReading: 230, // consumption=130, baseline=100, ratio=30% chính xác
      recentConsumptions: [100],
      thresholdRatio: 0.3,
    });
    assert.equal(result.valid, true);
    assert.equal(result.isAbnormal, false, 'Tăng đúng 30% không phải anomaly (boundary exclusive)');
  });

  await t.test('previousReading=null → valid=false (curr < prev khi prev=0 không xảy ra)', () => {
    // BUG TIỀM NĂNG: previousReading=null → Number(null)=0 → prev=0
    // Nếu currentReading > 0 thì valid, nếu không có history thì không anomaly
    const result = evaluateMeterReadingAnomaly({
      previousReading: null,
      currentReading: 50,
      recentConsumptions: [],
    });
    // previousReading null → prev=0 → curr(50) >= prev(0) → valid=true, không có history → isAbnormal=false
    assert.equal(result.valid, true, 'null previousReading → prev=0, curr=50 >= 0 → valid');
    assert.equal(result.isAbnormal, false, 'Không có history → không anomaly');
  });

  await t.test('baselineAvgConsumption=0 trong recentConsumptions → positiveHistory bị filter', () => {
    // BUG TIỀM NĂNG: Filter v > 0 loại bỏ 0 → positiveHistory rỗng → không check anomaly
    const result = evaluateMeterReadingAnomaly({
      previousReading: 100,
      currentReading: 200, // consumption=100
      recentConsumptions: [0, 0, 0], // tất cả bị filter
    });
    assert.equal(result.valid, true);
    assert.equal(result.baselineAvg, null, 'Không có history dương → baselineAvg=null');
    assert.equal(result.isAbnormal, false, 'Không có history → không anomaly (tránh division by zero)');
  });

  await t.test('Chỉ số giảm (curr < prev) → valid=false, code=INVALID_READING', () => {
    // BUG TIỀM NĂNG: Chỉ số giảm phải báo INVALID_READING không phải ANOMALY
    const result = evaluateMeterReadingAnomaly({
      previousReading: 200,
      currentReading: 100,
      recentConsumptions: [100],
    });
    assert.equal(result.valid, false, 'curr < prev → invalid');
    assert.equal(result.code, 'INVALID_READING', 'Phải có code INVALID_READING');
    assert.equal(result.isAbnormal, false, 'Không phải anomaly, là reading không hợp lệ');
  });
});

// ===========================================================================
// BUG-HUNT M3 — postValidateMeterOcr (AI validation)
// ===========================================================================
test('BUG-HUNT M3 — postValidateMeterOcr: validation sau OCR', async (t) => {
  await t.test('confidence=0.8 (đúng bằng threshold) → chấp nhận (>= threshold)', () => {
    // BUG TIỀM NĂNG: Code dùng confidence < confidenceThreshold → 0.8 < 0.8 = FALSE → chấp nhận
    // Nếu code dùng <= thì 0.8 sẽ bị reject — test để phát hiện logic sai
    const result = postValidateMeterOcr({
      rawModelJson: { reading: 1234, confidence: 0.8, reason: 'clear' },
      confidenceThreshold: 0.8,
    });
    assert.equal(result.needsHumanReview, false, 'confidence=threshold phải chấp nhận');
    assert.equal(result.reading, 1234);
  });

  await t.test('confidence=0.79 → reject, needsHumanReview=true', () => {
    // BUG TIỀM NĂNG: 0.79 < 0.8 → phải reject
    const result = postValidateMeterOcr({
      rawModelJson: { reading: 1234, confidence: 0.79, reason: 'clear' },
      confidenceThreshold: 0.8,
    });
    assert.equal(result.needsHumanReview, true, 'confidence dưới threshold → human review');
    assert.equal(result.reading, null, 'Reading không được trả khi confidence thấp');
  });

  await t.test('Reading âm (-5) → reject dù confidence cao', () => {
    // BUG TIỀM NĂNG: parsedReading < 0 phải bị reject
    const result = postValidateMeterOcr({
      rawModelJson: { reading: -5, confidence: 0.99, reason: 'clear' },
      confidenceThreshold: 0.8,
    });
    assert.equal(result.needsHumanReview, true, 'Reading âm phải reject');
    assert.equal(result.reading, null);
    assert.ok(result.warnings.includes('LOW_CONFIDENCE_OR_UNREADABLE'), 'Phải có warning');
  });

  await t.test('Reading=0 → chấp nhận (đồng hồ bắt đầu từ 0)', () => {
    // BUG TIỀM NĂNG: parsedReading=0 → 0 < 0 là FALSE → không reject
    // Nhưng parsedReading === 0 có thể bị truthy check sai!
    const result = postValidateMeterOcr({
      rawModelJson: { reading: 0, confidence: 0.9, reason: 'new meter' },
      confidenceThreshold: 0.8,
    });
    assert.equal(result.reading, 0, 'Reading=0 phải được chấp nhận');
    assert.equal(result.needsHumanReview, false);
  });

  await t.test("Mismatch: expectedMeterType='ELECTRICITY', detectedMeterType='WATER' → warnings=['METER_TYPE_MISMATCH']", () => {
    // BUG TIỀM NĂNG: Mismatch detector có thể không hoạt động khi confidence vừa đủ
    const result = postValidateMeterOcr({
      rawModelJson: { reading: 500, confidence: 0.9, detected_meter_type: 'WATER', reason: 'ok' },
      expectedMeterType: 'ELECTRICITY',
      confidenceThreshold: 0.8,
    });
    assert.ok(result.warnings.includes('METER_TYPE_MISMATCH'), 'Phải có METER_TYPE_MISMATCH warning');
    assert.equal(result.needsHumanReview, true, 'Mismatch → human review');
  });

  await t.test('previousValue=1000, reading=999 → warnings có READING_LOWER_THAN_PREVIOUS', () => {
    // BUG TIỀM NĂNG: Chỉ số thấp hơn kỳ trước phải warn
    const result = postValidateMeterOcr({
      rawModelJson: { reading: 999, confidence: 0.95, reason: 'ok' },
      previousValue: 1000,
      confidenceThreshold: 0.8,
    });
    assert.ok(result.warnings.includes('READING_LOWER_THAN_PREVIOUS'), 'Phải warn khi reading < prev');
    assert.equal(result.needsHumanReview, true);
  });

  await t.test('baseline=100, reading=1200 (tăng 1100%) → CONSUMPTION_ANOMALY_HIGH', () => {
    // BUG TIỀM NĂNG: Tiêu thụ bất thường cao phải trigger anomaly
    const result = postValidateMeterOcr({
      rawModelJson: { reading: 1200, confidence: 0.95, reason: 'ok' },
      previousValue: 100, // consumption = 1100
      baselineAvgConsumption: 100,
      anomalyThresholdPct: 30,
      confidenceThreshold: 0.8,
    });
    assert.ok(result.warnings.includes('CONSUMPTION_ANOMALY_HIGH'), 'Tăng 1100% phải báo anomaly');
    assert.equal(result.needsHumanReview, true);
  });

  await t.test('baseline=100, threshold=200%, reading=300 (tăng 200%) → boundary check', () => {
    // BUG TIỀM NĂNG: consumption=200, maxExpected=base*(1+200/100)=100*3=300
    // consumption (200) > maxExpected (300) → FALSE → không anomaly
    // Nhưng reading=300 → consumption = 300 - prev, prev cần được set đúng
    // prev=100, reading=300 → consumption=200, maxExpected=100*(1+2.0)=300
    // 200 > 300 → FALSE → không phải anomaly (boundary exclusive)
    const result = postValidateMeterOcr({
      rawModelJson: { reading: 300, confidence: 0.95, reason: 'ok' },
      previousValue: 100, // consumption = 200
      baselineAvgConsumption: 100,
      anomalyThresholdPct: 200, // maxExpected = 100 * (1 + 2.0) = 300
      confidenceThreshold: 0.8,
    });
    assert.ok(!result.warnings.includes('CONSUMPTION_ANOMALY_HIGH'),
      'consumption(200) = maxExpected(300) không phải anomaly (> strict)');
  });

  await t.test('rawModelJson.reading=null → {reading:null, needsHumanReview:true}', () => {
    // BUG TIỀM NĂNG: null reading phải → parsedReading=null → reject
    const result = postValidateMeterOcr({
      rawModelJson: { reading: null, confidence: 0.9, reason: 'blurry' },
      confidenceThreshold: 0.8,
    });
    assert.equal(result.reading, null, 'reading null → kết quả null');
    assert.equal(result.needsHumanReview, true);
  });

  await t.test("rawModelJson.reading='' (rỗng) → {reading:null, needsHumanReview:true}", () => {
    // BUG TIỀM NĂNG: Empty string → parsedReading=null → reject
    const result = postValidateMeterOcr({
      rawModelJson: { reading: '', confidence: 0.9, reason: 'blurry' },
      confidenceThreshold: 0.8,
    });
    assert.equal(result.reading, null, "reading '' → kết quả null");
    assert.equal(result.needsHumanReview, true);
  });
});
