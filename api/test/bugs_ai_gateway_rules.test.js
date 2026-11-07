/**
 * BUG-HUNT Tests: aiRules.js
 * Mục đích: TÌM LỖI trong logic AI gateway/budget/validation.
 * Chạy: node --test api/test/bugs_ai_gateway_rules.test.js
 *
 * Lưu ý: parseDataUriPayload import MAX_IMAGE_BYTES từ imageUpload.js (side-effect import),
 * nếu module đó cần DB/env thì một số test có thể fail ở import — xem comment inline.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeAiConfig,
  evaluateBudgetGate,
  parseDataUriPayload,
  postValidateMeterOcr,
  postValidateTicketTriage,
  estimateGeminiCostVnd,
  buildGeminiPromptAndSchema,
  resolveSupportedGeminiModel,
  CLOSED_TICKET_CATEGORIES,
  CLOSED_TICKET_PRIORITIES,
  DEFAULT_AI_CONFIG,
} from '../src/services/aiRules.js';

// ─────────────────────────────────────────────
// BUG-HUNT AI1 — evaluateBudgetGate
// ─────────────────────────────────────────────

test('AI1-01: enabled=false → {allowed:false, code:"AI_DISABLED"}', () => {
  const result = evaluateBudgetGate({ aiConfig: { enabled: false }, taskType: 'METER_OCR' });
  assert.equal(result.allowed, false);
  assert.equal(result.code, 'AI_DISABLED');
});

test('AI1-02: meter_ocr_enabled=false, taskType="METER_OCR" → {allowed:false, code:"AI_TASK_DISABLED"}', () => {
  const result = evaluateBudgetGate({
    aiConfig: { meter_ocr_enabled: false },
    taskType: 'METER_OCR',
  });
  assert.equal(result.allowed, false);
  assert.equal(result.code, 'AI_TASK_DISABLED');
});

test('AI1-03: cccd_extract_enabled=false, taskType="CCCD_EXTRACT" → AI_TASK_DISABLED', () => {
  const result = evaluateBudgetGate({
    aiConfig: { cccd_extract_enabled: false },
    taskType: 'CCCD_EXTRACT',
  });
  assert.equal(result.allowed, false);
  assert.equal(result.code, 'AI_TASK_DISABLED');
});

test('AI1-04: Budget vượt 100% (cost >= monthly_budget_vnd) → AI_BUDGET_EXCEEDED', () => {
  const result = evaluateBudgetGate({
    aiConfig: { monthly_budget_vnd: 100000 },
    taskType: 'METER_OCR',
    monthlyCostVnd: 100000, // cost === budget
  });
  assert.equal(result.allowed, false);
  assert.equal(result.code, 'AI_BUDGET_EXCEEDED');
});

test('AI1-05: Token vượt 100% (tokens >= monthly_token_limit) → AI_BUDGET_EXCEEDED', () => {
  const result = evaluateBudgetGate({
    aiConfig: { monthly_token_limit: 1000000 },
    taskType: 'METER_OCR',
    monthlyTokensUsed: 1000000, // tokens === limit
  });
  assert.equal(result.allowed, false);
  assert.equal(result.code, 'AI_BUDGET_EXCEEDED');
});

test('AI1-06: Cost vượt budget → AI_BUDGET_EXCEEDED (cost > budget)', () => {
  const result = evaluateBudgetGate({
    aiConfig: { monthly_budget_vnd: 100000 },
    taskType: 'METER_OCR',
    monthlyCostVnd: 100001,
  });
  assert.equal(result.allowed, false);
  assert.equal(result.code, 'AI_BUDGET_EXCEEDED');
});

test('AI1-07: Budget 80% → {allowed:true, warning80Pct:true}', () => {
  // cost = 0.8 * budget = 80000, warn_percent=80 → costPct=80 >= 80 → warning=true
  const result = evaluateBudgetGate({
    aiConfig: { monthly_budget_vnd: 100000, warn_percent: 80 },
    taskType: 'METER_OCR',
    monthlyCostVnd: 80000,
  });
  assert.equal(result.allowed, true);
  assert.equal(result.warning80Pct, true, 'BUG: 80% phải trigger warning80Pct=true');
});

test('AI1-08: Budget 79% → {allowed:true, warning80Pct:false}', () => {
  const result = evaluateBudgetGate({
    aiConfig: { monthly_budget_vnd: 100000, warn_percent: 80 },
    taskType: 'METER_OCR',
    monthlyCostVnd: 79000,
  });
  assert.equal(result.allowed, true);
  assert.equal(result.warning80Pct, false, 'BUG: 79% không được trigger warning');
});

test('AI1-09: Budget 0 usage → allowed=true, warning80Pct=false', () => {
  const result = evaluateBudgetGate({
    aiConfig: {},
    taskType: 'METER_OCR',
    monthlyCostVnd: 0,
    monthlyTokensUsed: 0,
  });
  assert.equal(result.allowed, true);
  assert.equal(result.warning80Pct, false);
});

test('AI1-10: BUG boundary CHÍNH XÁC tại 80% — cost = 0.8 × budget → warning=true', () => {
  // costPct = (80000 / 100000) * 100 = 80 >= 80 → warning=true
  const budget = 500000;
  const cost = budget * 0.8; // = 400000
  const result = evaluateBudgetGate({
    aiConfig: { monthly_budget_vnd: budget, warn_percent: 80 },
    taskType: 'TICKET_TRIAGE',
    monthlyCostVnd: cost,
  });
  assert.equal(result.allowed, true, 'Chưa vượt budget nên phải allowed');
  assert.equal(result.warning80Pct, true, 'BUG: đúng 80% phải trigger warning (>= warn_percent)');
});

// ─────────────────────────────────────────────
// BUG-HUNT AI2 — normalizeAiConfig
// ─────────────────────────────────────────────

test('AI2-01: Model có "/" → throw validation error', () => {
  assert.throws(
    () => normalizeAiConfig({ model: 'gemini/pro' }),
    (err) => {
      assert.equal(err.code, 'VALIDATION_ERROR');
      return true;
    }
  );
});

test('AI2-02: Model có ".." → throw validation error', () => {
  assert.throws(
    () => normalizeAiConfig({ model: 'gemini..pro' }),
    (err) => err.code === 'VALIDATION_ERROR'
  );
});

test('AI2-03: confidence_threshold=0 → throw (phải > 0)', () => {
  assert.throws(
    () => normalizeAiConfig({ confidence_threshold: 0 }),
    (err) => err.code === 'VALIDATION_ERROR'
  );
});

test('AI2-04: confidence_threshold=1.1 → throw (phải <= 1)', () => {
  assert.throws(
    () => normalizeAiConfig({ confidence_threshold: 1.1 }),
    (err) => err.code === 'VALIDATION_ERROR'
  );
});

test('AI2-05: confidence_threshold=1 → hợp lệ (boundary <= 1)', () => {
  // val <= 1 → không throw
  assert.doesNotThrow(() => normalizeAiConfig({ confidence_threshold: 1 }));
});

test('AI2-06: monthly_budget_vnd=0 → throw (phải > 0)', () => {
  assert.throws(
    () => normalizeAiConfig({ monthly_budget_vnd: 0 }),
    (err) => err.code === 'VALIDATION_ERROR'
  );
});

test('AI2-07: warn_percent=0 → throw (phải 1-100)', () => {
  assert.throws(
    () => normalizeAiConfig({ warn_percent: 0 }),
    (err) => err.code === 'VALIDATION_ERROR'
  );
});

test('AI2-08: warn_percent=101 → throw (phải <= 100)', () => {
  assert.throws(
    () => normalizeAiConfig({ warn_percent: 101 }),
    (err) => err.code === 'VALIDATION_ERROR'
  );
});

test('AI2-09: warn_percent=100 → hợp lệ (boundary)', () => {
  assert.doesNotThrow(() => normalizeAiConfig({ warn_percent: 100 }));
});

test('AI2-10: suggestion_ttl_hours=0 → throw (phải >= 1)', () => {
  assert.throws(
    () => normalizeAiConfig({ suggestion_ttl_hours: 0 }),
    (err) => err.code === 'VALIDATION_ERROR'
  );
});

test('AI2-11: suggestion_ttl_hours=721 → throw (phải <= 720)', () => {
  assert.throws(
    () => normalizeAiConfig({ suggestion_ttl_hours: 721 }),
    (err) => err.code === 'VALIDATION_ERROR'
  );
});

test('AI2-12: suggestion_ttl_hours=720 → hợp lệ (boundary)', () => {
  assert.doesNotThrow(() => normalizeAiConfig({ suggestion_ttl_hours: 720 }));
});

test('AI2-13: Model "gemini-2.5-flash" → map sang "gemini-3.8-flash"', () => {
  const result = normalizeAiConfig({ model: 'gemini-2.5-flash' });
  assert.equal(result.model, 'gemini-3.8-flash', 'BUG: gemini-2.5-flash phải được map sang gemini-3.8-flash');
});

test('AI2-14: tasks.cccd_extract=false override flat cccd_extract_enabled', () => {
  // inc.tasks.cccd_extract có độ ưu tiên thấp hơn inc.cccd_extract_enabled
  // resolveTaskToggle: inc[flatKey] = undefined → check inc.tasks.cccd_extract = false
  const result = normalizeAiConfig({ tasks: { cccd_extract: false } });
  assert.equal(result.cccd_extract_enabled, false, 'BUG: tasks.cccd_extract=false phải disable cccd_extract_enabled');
});

test('AI2-15: flat cccd_extract_enabled=false > tasks.cccd_extract=true (flat wins)', () => {
  // inc.cccd_extract_enabled=false → resolveTaskToggle trả false (inc[flatKey] có trước)
  const result = normalizeAiConfig({ cccd_extract_enabled: false, tasks: { cccd_extract: true } });
  assert.equal(result.cccd_extract_enabled, false, 'BUG: flat key phải có độ ưu tiên cao hơn tasks.*');
});

test('AI2-16: Merge — incoming có cccd_extract_enabled=false, existing có cccd_extract_enabled=true → false wins', () => {
  const result = normalizeAiConfig(
    { cccd_extract_enabled: false },
    { cccd_extract_enabled: true }
  );
  assert.equal(result.cccd_extract_enabled, false, 'BUG: incoming phải override existing');
});

// ─────────────────────────────────────────────
// BUG-HUNT AI3 — parseDataUriPayload
// ─────────────────────────────────────────────

// Helper: tạo JPEG stub hợp lệ
function makeJpegDataUri() {
  // Magic bytes: ff d8 ff e0 (JPEG SOI + APP0)
  const jpegMagic = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00]);
  return `data:image/jpeg;base64,${jpegMagic.toString('base64')}`;
}

function makePngDataUri() {
  // Magic bytes: 89 50 4e 47 0d 0a 1a 0a (PNG signature)
  const pngMagic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
  return `data:image/png;base64,${pngMagic.toString('base64')}`;
}

function makePdfDataUri() {
  const pdfMagic = Buffer.from('%PDF-1.4\n%%EOF');
  return `data:application/pdf;base64,${pdfMagic.toString('base64')}`;
}

test('AI3-01: Không phải data URI → {valid:false}', () => {
  const result = parseDataUriPayload('https://example.com/img.jpg');
  assert.equal(result.valid, false);
  assert.equal(result.code, 'VALIDATION_ERROR');
});

test('AI3-02: MIME type không được phép (image/gif) → {valid:false}', () => {
  const gifB64 = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39]).toString('base64');
  const result = parseDataUriPayload(`data:image/gif;base64,${gifB64}`);
  assert.equal(result.valid, false);
  assert.equal(result.code, 'VALIDATION_ERROR');
});

test('AI3-03: Base64 rỗng (data URI hợp lệ nhưng payload trống) → {valid:false}', () => {
  const result = parseDataUriPayload('data:image/jpeg;base64,');
  // Buffer.from('', 'base64').length = 0 → invalid
  assert.equal(result.valid, false);
  assert.equal(result.code, 'VALIDATION_ERROR');
});

test('AI3-04: JPEG magic bytes sai → {valid:false, code:"VALIDATION_ERROR"}', () => {
  // Bytes không phải ff d8 ff
  const fakeBytes = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x00]);
  const result = parseDataUriPayload(`data:image/jpeg;base64,${fakeBytes.toString('base64')}`);
  assert.equal(result.valid, false);
  assert.equal(result.code, 'VALIDATION_ERROR');
});

test('AI3-05: Fake JPEG — declare image/jpeg nhưng header là PNG → reject (magic mismatch)', () => {
  // PNG magic declared as image/jpeg
  const pngMagic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const result = parseDataUriPayload(`data:image/jpeg;base64,${pngMagic.toString('base64')}`);
  assert.equal(result.valid, false, 'BUG: Fake JPEG phải bị reject do magic mismatch');
  assert.equal(result.code, 'VALIDATION_ERROR');
});

test('AI3-06: allowPdf=true → chấp nhận application/pdf', () => {
  const result = parseDataUriPayload(makePdfDataUri(), { allowPdf: true });
  assert.equal(result.valid, true, 'BUG: allowPdf=true phải cho phép PDF hợp lệ');
  assert.equal(result.mimeType, 'application/pdf');
});

test('AI3-07: allowPdf=false (default) → reject application/pdf', () => {
  const result = parseDataUriPayload(makePdfDataUri(), { allowPdf: false });
  assert.equal(result.valid, false, 'BUG: allowPdf=false phải reject PDF');
});

test('AI3-08: BUG — file vượt maxBytes → reject với code VALIDATION_ERROR', () => {
  const bigBuf = Buffer.alloc(10); // small buffer để test, dùng maxBytes=5
  const jpegMagic = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
  const result = parseDataUriPayload(
    `data:image/jpeg;base64,${jpegMagic.toString('base64')}`,
    { maxBytes: 3 } // maxBytes rất nhỏ → trigger size check
  );
  assert.equal(result.valid, false, 'BUG: vượt maxBytes phải reject');
  assert.equal(result.code, 'VALIDATION_ERROR');
  assert.ok(result.message.includes('MB') || result.message.includes('giới hạn'), 'Message phải đề cập dung lượng');
});

test('AI3-09: Valid JPEG stub (magic bytes ff d8 ff e0) → {valid:true}', () => {
  const result = parseDataUriPayload(makeJpegDataUri());
  assert.equal(result.valid, true, 'BUG: JPEG stub hợp lệ phải pass');
  assert.equal(result.mimeType, 'image/jpeg');
  assert.ok(result.sha256Hex, 'Phải có sha256Hex');
  assert.ok(result.byteLength > 0);
});

test('AI3-10: Valid PNG stub → {valid:true}', () => {
  const result = parseDataUriPayload(makePngDataUri());
  assert.equal(result.valid, true, 'BUG: PNG stub hợp lệ phải pass');
  assert.equal(result.mimeType, 'image/png');
});

// ─────────────────────────────────────────────
// BUG-HUNT AI4 — postValidateMeterOcr
// ─────────────────────────────────────────────

test('AI4-01: Confidence thấp (0.5 < threshold=0.8) → {reading:null, needsHumanReview:true}', () => {
  const result = postValidateMeterOcr({
    rawModelJson: { reading: 100, confidence: 0.5 },
    confidenceThreshold: 0.8,
  });
  assert.equal(result.reading, null);
  assert.equal(result.needsHumanReview, true);
  assert.ok(result.warnings.includes('LOW_CONFIDENCE_OR_UNREADABLE'));
});

test('AI4-02: Chỉ số âm → {reading:null, needsHumanReview:true}', () => {
  const result = postValidateMeterOcr({
    rawModelJson: { reading: -1, confidence: 0.95 },
  });
  assert.equal(result.reading, null, 'BUG: Chỉ số âm phải bị reject');
  assert.equal(result.needsHumanReview, true);
});

test('AI4-03: Reading < previousValue → warnings includes "READING_LOWER_THAN_PREVIOUS", needsHumanReview=true', () => {
  const result = postValidateMeterOcr({
    rawModelJson: { reading: 50, confidence: 0.95 },
    previousValue: 100,
    confidenceThreshold: 0.8,
  });
  assert.ok(result.warnings.includes('READING_LOWER_THAN_PREVIOUS'), 'BUG: phải flag READING_LOWER_THAN_PREVIOUS');
  assert.equal(result.needsHumanReview, true);
});

test('AI4-04: Tiêu thụ > 30% baseline → warnings includes "CONSUMPTION_ANOMALY_HIGH"', () => {
  // reading=200, prev=100 → consumption=100; baseline=70 → maxExpected=70*1.3=91 < 100 → anomaly
  const result = postValidateMeterOcr({
    rawModelJson: { reading: 200, confidence: 0.95 },
    previousValue: 100,
    baselineAvgConsumption: 70,
    anomalyThresholdPct: 30,
    confidenceThreshold: 0.8,
  });
  assert.ok(result.warnings.includes('CONSUMPTION_ANOMALY_HIGH'), 'BUG: tiêu thụ cao phải flag CONSUMPTION_ANOMALY_HIGH');
  assert.equal(result.needsHumanReview, true);
});

test('AI4-05: Tiêu thụ đúng 30% (boundary) → không flag anomaly', () => {
  // reading=191, prev=100, baseline=70 → consumption=91; maxExpected=70*1.3=91 → NOT > 91 → no anomaly
  const result = postValidateMeterOcr({
    rawModelJson: { reading: 191, confidence: 0.95 },
    previousValue: 100,
    baselineAvgConsumption: 70,
    anomalyThresholdPct: 30,
    confidenceThreshold: 0.8,
  });
  assert.ok(!result.warnings.includes('CONSUMPTION_ANOMALY_HIGH'), 'BUG boundary: đúng 30% không được flag anomaly (strict >)');
});

test('AI4-06: Meter type mismatch (expected=ELECTRICITY, detected=WATER) → warnings includes "METER_TYPE_MISMATCH"', () => {
  const result = postValidateMeterOcr({
    rawModelJson: { reading: 100, confidence: 0.95, detected_meter_type: 'WATER' },
    expectedMeterType: 'ELECTRICITY',
    confidenceThreshold: 0.8,
  });
  assert.ok(result.warnings.includes('METER_TYPE_MISMATCH'), 'BUG: type mismatch phải flag METER_TYPE_MISMATCH');
  assert.equal(result.needsHumanReview, true);
});

test('AI4-07: Confidence cao, không có previousValue → {needsHumanReview:false}', () => {
  const result = postValidateMeterOcr({
    rawModelJson: { reading: 500, confidence: 0.99 },
    previousValue: null,
    confidenceThreshold: 0.8,
  });
  assert.equal(result.needsHumanReview, false, 'BUG: không có cảnh báo thì phải needsHumanReview=false');
  assert.equal(result.reading, 500);
});

test('AI4-08: BUG — null previousValue không trigger READING_LOWER_THAN_PREVIOUS', () => {
  // previousValue=null → condition `previousValue !== null` false → skip lower check
  const result = postValidateMeterOcr({
    rawModelJson: { reading: 0, confidence: 0.95 },
    previousValue: null,
    confidenceThreshold: 0.8,
  });
  assert.ok(
    !result.warnings.includes('READING_LOWER_THAN_PREVIOUS'),
    'BUG: null previousValue không được trigger READING_LOWER_THAN_PREVIOUS'
  );
});

test('AI4-09: Reading=0, confidence cao, no previous → valid reading=0', () => {
  const result = postValidateMeterOcr({
    rawModelJson: { reading: 0, confidence: 0.95 },
    confidenceThreshold: 0.8,
  });
  // reading=0 >= 0 (not < 0), confidence >= threshold → không trigger low confidence branch
  assert.equal(result.reading, 0, 'BUG: reading=0 không phải âm, phải valid');
  assert.equal(result.needsHumanReview, false);
});

// ─────────────────────────────────────────────
// BUG-HUNT AI5 — postValidateTicketTriage
// ─────────────────────────────────────────────

test('AI5-01: Category ngoài CLOSED_TICKET_CATEGORIES → category=null, triageStatus="NEEDS_MANUAL_REVIEW"', () => {
  const result = postValidateTicketTriage({
    rawModelJson: { category: 'INVALID_CAT', priority: 'NORMAL', confidence: 0.9 },
    confidenceThreshold: 0.7,
  });
  assert.equal(result.category, null, 'BUG: category lạ phải bị null');
  assert.equal(result.triageStatus, 'NEEDS_MANUAL_REVIEW');
  assert.ok(result.warnings.includes('OUT_OF_TAXONOMY_CATEGORY'));
});

test('AI5-02: Priority ngoài CLOSED_TICKET_PRIORITIES → priority=null (khi không có safety hazard)', () => {
  const result = postValidateTicketTriage({
    rawModelJson: { category: 'ELECTRICAL', priority: 'MEGA_URGENT', confidence: 0.9 },
    description: 'Bình thường',
    confidenceThreshold: 0.7,
  });
  // validPrio=null → branch NEEDS_MANUAL_REVIEW, hasSafetyHazard=false → safePriority=null
  assert.equal(result.priority, null, 'BUG: priority lạ và không có safety hazard → null');
  assert.ok(result.warnings.includes('OUT_OF_TAXONOMY_PRIORITY'));
});

test('AI5-03: Confidence < threshold (0.6 < 0.7) → NEEDS_MANUAL_REVIEW', () => {
  const result = postValidateTicketTriage({
    rawModelJson: { category: 'ELECTRICAL', priority: 'NORMAL', confidence: 0.6 },
    confidenceThreshold: 0.7,
  });
  assert.equal(result.triageStatus, 'NEEDS_MANUAL_REVIEW');
  assert.ok(result.warnings.includes('LOW_CONFIDENCE_TRIAGE'));
});

test('AI5-04: Từ khóa "rò điện" → priority="URGENT", warnings includes "SAFETY_HAZARD_ESCALATED"', () => {
  const result = postValidateTicketTriage({
    rawModelJson: { category: 'ELECTRICAL', priority: 'NORMAL', confidence: 0.95 },
    description: 'Có hiện tượng rò điện ở ổ cắm',
    confidenceThreshold: 0.7,
  });
  assert.equal(result.priority, 'URGENT', 'BUG: rò điện phải escalate lên URGENT');
  assert.ok(result.warnings.includes('SAFETY_HAZARD_ESCALATED'));
});

test('AI5-05: Từ khóa "bốc khói" → URGENT dù confidence thấp', () => {
  const result = postValidateTicketTriage({
    rawModelJson: { category: 'ELECTRICAL', priority: 'NORMAL', confidence: 0.4 },
    description: 'Điều hòa đang bốc khói',
    confidenceThreshold: 0.7,
  });
  // confidence < threshold → NEEDS_MANUAL_REVIEW nhưng hasSafetyHazard=true → safePriority='URGENT'
  assert.equal(result.priority, 'URGENT', 'BUG: bốc khói phải force URGENT dù confidence thấp');
  assert.ok(result.warnings.includes('SAFETY_HAZARD_ESCALATED'));
});

test('AI5-06: Từ khóa "cháy nổ" → URGENT', () => {
  const result = postValidateTicketTriage({
    rawModelJson: { category: 'ELECTRICAL', priority: 'NORMAL', confidence: 0.95 },
    description: 'Nguy cơ cháy nổ trong phòng điện',
    confidenceThreshold: 0.7,
  });
  assert.equal(result.priority, 'URGENT');
  assert.ok(result.warnings.includes('SAFETY_HAZARD_ESCALATED'));
});

test('AI5-07: "ngập nước" → URGENT (kiểm tra SAFETY_HAZARD_RE)', () => {
  const result = postValidateTicketTriage({
    rawModelJson: { category: 'PLUMBING', priority: 'HIGH', confidence: 0.9 },
    description: 'Phòng bị ngập nước từ ống vỡ',
    confidenceThreshold: 0.7,
  });
  assert.equal(result.priority, 'URGENT', 'BUG: ngập nước phải trigger SAFETY_HAZARD_ESCALATED');
  assert.ok(result.warnings.includes('SAFETY_HAZARD_ESCALATED'));
});

test('AI5-08: "rò gas" → URGENT', () => {
  const result = postValidateTicketTriage({
    rawModelJson: { category: 'PLUMBING', priority: 'HIGH', confidence: 0.9 },
    description: 'Có mùi rò gas trong bếp',
    confidenceThreshold: 0.7,
  });
  assert.equal(result.priority, 'URGENT', 'BUG: rò gas phải trigger URGENT');
  assert.ok(result.warnings.includes('SAFETY_HAZARD_ESCALATED'));
});

test('AI5-09: suggested_assignee_id không trong allowedAssigneeIds → null', () => {
  const result = postValidateTicketTriage({
    rawModelJson: {
      category: 'ELECTRICAL',
      priority: 'NORMAL',
      confidence: 0.9,
      suggested_assignee_id: 'user-999',
    },
    allowedAssigneeIds: ['user-1', 'user-2'],
    confidenceThreshold: 0.7,
  });
  assert.equal(result.suggestedAssigneeId, null, 'BUG: assignee ngoài danh sách phải bị null');
});

test('AI5-10: suggested_assignee_id trong allowedAssigneeIds → được gán', () => {
  const result = postValidateTicketTriage({
    rawModelJson: {
      category: 'ELECTRICAL',
      priority: 'NORMAL',
      confidence: 0.9,
      suggested_assignee_id: 'user-1',
    },
    allowedAssigneeIds: ['user-1', 'user-2'],
    confidenceThreshold: 0.7,
  });
  assert.equal(result.suggestedAssigneeId, 'user-1', 'BUG: assignee trong danh sách phải được gán');
});

test('AI5-11: Priority "HIGH" nhưng có "rò gas" → escalate lên "URGENT"', () => {
  const result = postValidateTicketTriage({
    rawModelJson: { category: 'PLUMBING', priority: 'HIGH', confidence: 0.95 },
    description: 'Rò gas bếp',
    confidenceThreshold: 0.7,
  });
  assert.equal(result.priority, 'URGENT', 'BUG: rò gas phải escalate từ HIGH lên URGENT');
});

// ─────────────────────────────────────────────
// BUG-HUNT AI6 — buildGeminiPromptAndSchema
// ─────────────────────────────────────────────

test('AI6-01: taskType không hợp lệ → throw validation error', () => {
  assert.throws(
    () => buildGeminiPromptAndSchema('INVALID_TASK'),
    (err) => err.code === 'VALIDATION_ERROR'
  );
});

test('AI6-02: CCCD_EXTRACT — schema có required: ["full_name", "id_number", "dob", "confidence"]', () => {
  const { responseSchema } = buildGeminiPromptAndSchema('CCCD_EXTRACT');
  assert.ok(Array.isArray(responseSchema.required), 'required phải là array');
  assert.ok(responseSchema.required.includes('full_name'));
  assert.ok(responseSchema.required.includes('id_number'));
  assert.ok(responseSchema.required.includes('dob'));
  assert.ok(responseSchema.required.includes('confidence'));
});

test('AI6-03: METER_OCR — schema có reading với nullable=true', () => {
  const { responseSchema } = buildGeminiPromptAndSchema('METER_OCR');
  assert.ok(responseSchema.properties.reading, 'Phải có trường reading');
  assert.equal(responseSchema.properties.reading.nullable, true, 'BUG: reading phải nullable=true');
});

test('AI6-04: TICKET_TRIAGE — category enum = CLOSED_TICKET_CATEGORIES', () => {
  const { responseSchema } = buildGeminiPromptAndSchema('TICKET_TRIAGE');
  const enumValues = responseSchema.properties.category.enum;
  assert.deepEqual(
    [...enumValues].sort(),
    [...CLOSED_TICKET_CATEGORIES].sort(),
    'BUG: category enum phải khớp CLOSED_TICKET_CATEGORIES'
  );
});

test('AI6-05: BUG — TICKET_TRIAGE schema không cho phép category mới ngoài closed taxonomy', () => {
  const { responseSchema } = buildGeminiPromptAndSchema('TICKET_TRIAGE');
  const enumValues = responseSchema.properties.category.enum;
  // AI không thể tự đặt category ngoài enum list
  assert.ok(!enumValues.includes('CUSTOM_CAT'), 'BUG: enum không được có category mới ngoài taxonomy');
  assert.ok(!enumValues.includes('UNKNOWN'), 'BUG: enum không được có UNKNOWN');
  assert.equal(enumValues.length, CLOSED_TICKET_CATEGORIES.length, 'Số category phải đúng');
});

test('AI6-06: CCCD_EXTRACT có systemInstruction và userPrompt', () => {
  const result = buildGeminiPromptAndSchema('CCCD_EXTRACT');
  assert.ok(typeof result.systemInstruction === 'string' && result.systemInstruction.length > 0);
  assert.ok(typeof result.userPrompt === 'string' && result.userPrompt.length > 0);
});

test('AI6-07: CONTRACT_EXTRACT — schema có confidence trong required', () => {
  const { responseSchema } = buildGeminiPromptAndSchema('CONTRACT_EXTRACT');
  assert.ok(responseSchema.required.includes('confidence'));
});

// ─────────────────────────────────────────────
// BUG-HUNT AI7 — estimateGeminiCostVnd
// ─────────────────────────────────────────────

test('AI7-01: inputTokens=0, outputTokens=0 → 0 (không có gọi → không tính phí)', () => {
  assert.equal(estimateGeminiCostVnd({ inputTokens: 0, outputTokens: 0 }), 0);
});

test('AI7-02: inputTokens=1, outputTokens=0 → ít nhất 1 (ceil)', () => {
  // rawVnd = (1/1_000_000) * 8000 = 0.008 → ceil(0.008) = 1
  const result = estimateGeminiCostVnd({ inputTokens: 1, outputTokens: 0, model: 'gemini-3.8-flash' });
  assert.ok(result >= 1, `BUG: 1 input token phải tính ít nhất 1 VND (ceil), got ${result}`);
});

test('AI7-03: Pro model đắt hơn Flash model (cùng tokens)', () => {
  const proResult = estimateGeminiCostVnd({
    inputTokens: 100000,
    outputTokens: 10000,
    model: 'gemini-3.8-pro',
  });
  const flashResult = estimateGeminiCostVnd({
    inputTokens: 100000,
    outputTokens: 10000,
    model: 'gemini-3.8-flash',
  });
  assert.ok(proResult > flashResult, `BUG: Pro (${proResult}) phải đắt hơn Flash (${flashResult})`);
});

test('AI7-04: inputTokens=1_000_000, model="gemini-3.8-flash" → 8000 VND', () => {
  // rawVnd = (1_000_000 / 1_000_000) * 8000 = 8000
  const result = estimateGeminiCostVnd({
    inputTokens: 1_000_000,
    outputTokens: 0,
    model: 'gemini-3.8-flash',
  });
  assert.equal(result, 8000, `BUG: 1M input tokens flash = 8000 VND, got ${result}`);
});

test('AI7-05: outputTokens=1_000_000, model="gemini-3.8-flash" → 64000 VND', () => {
  // outRatePerMillionVnd = 64000
  const result = estimateGeminiCostVnd({
    inputTokens: 0,
    outputTokens: 1_000_000,
    model: 'gemini-3.8-flash',
  });
  assert.equal(result, 64000, `BUG: 1M output tokens flash = 64000 VND, got ${result}`);
});

test('AI7-06: model chứa "pro" → dùng pro rate', () => {
  // inRatePerMillionVnd = 32000 cho pro
  const result = estimateGeminiCostVnd({
    inputTokens: 1_000_000,
    outputTokens: 0,
    model: 'gemini-ultra-pro',
  });
  assert.equal(result, 32000, `BUG: pro model 1M input = 32000 VND, got ${result}`);
});

test('AI7-07: BUG — số âm tokens được clamp về 0', () => {
  // Math.max(0, ...) clamp
  const result = estimateGeminiCostVnd({ inputTokens: -100, outputTokens: -50 });
  assert.equal(result, 0, 'BUG: tokens âm phải được clamp về 0');
});
