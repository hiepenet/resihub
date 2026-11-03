import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AI_TASK_TYPES,
  AI_SUGGESTION_STATUSES,
  CLOSED_TICKET_CATEGORIES,
  CLOSED_TICKET_PRIORITIES,
  DEFAULT_AI_CONFIG,
  normalizeAiConfig,
  evaluateBudgetGate,
  parseDataUriPayload,
  buildExtractionDbPayload,
  computeFieldAcceptanceDiff,
  postValidateMeterOcr,
  postValidateTicketTriage,
  estimateGeminiCostVnd,
  buildGeminiPromptAndSchema,
} from '../src/services/aiRules.js';

const VALID_PNG_BASE64 =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

const VALID_JPEG_BASE64 =
  'data:image/jpeg;base64,' + Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]).toString('base64');

const VALID_PDF_BASE64 =
  'data:application/pdf;base64,' + Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF', 'ascii').toString('base64');

test('normalizeAiConfig merges defaults and rejects invalid thresholds, model slugs, or budgets', () => {
  const merged = normalizeAiConfig({ meter_ocr_threshold: 0.85, monthly_budget_vnd: '750000' });
  assert.equal(merged.enabled, true);
  assert.equal(merged.meter_ocr_threshold, 0.85);
  assert.equal(merged.monthly_budget_vnd, 750000);
  assert.equal(merged.model, DEFAULT_AI_CONFIG.model);

  for (const bad of [
    { confidence_threshold: 1.5 },
    { confidence_threshold: 0 },
    { monthly_budget_vnd: -100 },
    { warn_percent: 120 },
    { model: '../bad-slug' },
  ]) {
    assert.throws(
      () => normalizeAiConfig(bad),
      (err) => err.status === 400 && err.code === 'VALIDATION_ERROR'
    );
  }
});

test('evaluateBudgetGate enforces global kill switch, task toggle, monthly cap, and 80% warning', () => {
  const baseCfg = normalizeAiConfig({});

  const globalOff = evaluateBudgetGate({
    aiConfig: { ...baseCfg, enabled: false },
    taskType: 'METER_OCR',
    monthlyTokensUsed: 0,
    monthlyCostVnd: 0,
  });
  assert.equal(globalOff.allowed, false);
  assert.equal(globalOff.code, 'AI_DISABLED');

  const taskOff = evaluateBudgetGate({
    aiConfig: { ...baseCfg, meter_ocr_enabled: false },
    taskType: 'METER_OCR',
    monthlyTokensUsed: 0,
    monthlyCostVnd: 0,
  });
  assert.equal(taskOff.allowed, false);
  assert.equal(taskOff.code, 'AI_TASK_DISABLED');

  const overCost = evaluateBudgetGate({
    aiConfig: baseCfg,
    taskType: 'METER_OCR',
    monthlyTokensUsed: 1000,
    monthlyCostVnd: baseCfg.monthly_budget_vnd,
  });
  assert.equal(overCost.allowed, false);
  assert.equal(overCost.code, 'AI_BUDGET_EXCEEDED');

  const overTokens = evaluateBudgetGate({
    aiConfig: baseCfg,
    taskType: 'CCCD_EXTRACT',
    monthlyTokensUsed: baseCfg.monthly_token_limit,
    monthlyCostVnd: 1000,
  });
  assert.equal(overTokens.allowed, false);
  assert.equal(overTokens.code, 'AI_BUDGET_EXCEEDED');

  const warnState = evaluateBudgetGate({
    aiConfig: baseCfg,
    taskType: 'TICKET_TRIAGE',
    monthlyTokensUsed: 1000,
    monthlyCostVnd: Math.ceil(baseCfg.monthly_budget_vnd * 0.82),
  });
  assert.equal(warnState.allowed, true);
  assert.equal(warnState.warning80Pct, true);
});

test('parseDataUriPayload verifies magic bytes for JPEG, PNG, and PDF', () => {
  const png = parseDataUriPayload(VALID_PNG_BASE64, { allowPdf: false });
  assert.equal(png.valid, true);
  assert.equal(png.mimeType, 'image/png');
  assert.equal(png.sha256Hex.length, 64);

  const jpg = parseDataUriPayload(VALID_JPEG_BASE64, { allowPdf: false });
  assert.equal(jpg.valid, true);
  assert.equal(jpg.mimeType, 'image/jpeg');

  const pdfDenied = parseDataUriPayload(VALID_PDF_BASE64, { allowPdf: false });
  assert.equal(pdfDenied.valid, false);
  assert.equal(pdfDenied.code, 'VALIDATION_ERROR');

  const pdfAllowed = parseDataUriPayload(VALID_PDF_BASE64, { allowPdf: true });
  assert.equal(pdfAllowed.valid, true);
  assert.equal(pdfAllowed.mimeType, 'application/pdf');

  const fakePdf = parseDataUriPayload('data:application/pdf;base64,SGVsbG8=', { allowPdf: true });
  assert.equal(fakePdf.valid, false);
  assert.equal(fakePdf.code, 'VALIDATION_ERROR');
});

test('buildExtractionDbPayload masks raw CCCD/phone while computeFieldAcceptanceDiff tracks KPI G6', () => {
  const extracted = {
    full_name: 'Nguyễn Văn A',
    id_number: '001099012345',
    phone: '0901234567',
    dob: '1999-05-20',
  };
  const confidences = {
    full_name: 0.98,
    id_number: 0.95,
    phone: 0.91,
    dob: 0.89,
  };

  const dbPayload = buildExtractionDbPayload('CCCD_EXTRACT', extracted, confidences);
  assert.equal(dbPayload.totalFieldsCount, 4);
  assert.equal(JSON.stringify(dbPayload.redactedOutput).includes('001099012345'), false);
  assert.equal(JSON.stringify(dbPayload.redactedOutput).includes('0901234567'), false);
  assert.ok(dbPayload.redactedOutput.id_number.endsWith('2345'));

  const exactDiff = computeFieldAcceptanceDiff({
    fieldHashes: dbPayload.fieldHashes,
    finalValues: { ...extracted },
  });
  assert.deepEqual(exactDiff, {
    acceptedFieldsCount: 4,
    totalFieldsCount: 4,
    status: 'ACCEPTED',
  });

  const editedDiff = computeFieldAcceptanceDiff({
    fieldHashes: dbPayload.fieldHashes,
    finalValues: { ...extracted, dob: '1999-05-21' },
  });
  assert.deepEqual(editedDiff, {
    acceptedFieldsCount: 3,
    totalFieldsCount: 4,
    status: 'EDITED_ACCEPTED',
  });
});

test('postValidateMeterOcr enforces AC-014.1 null on low confidence and PRD 12.3 post-checks', () => {
  const blurry = postValidateMeterOcr({
    rawModelJson: { reading: 1234, confidence: 0.65, reason: 'Mặt kính đồng hồ bị mờ' },
    previousValue: 1200,
    baselineAvgConsumption: 100,
    anomalyThresholdPct: 30,
    confidenceThreshold: 0.8,
  });
  assert.equal(blurry.reading, null);
  assert.equal(blurry.needsHumanReview, true);
  assert.ok(blurry.warnings.includes('LOW_CONFIDENCE_OR_UNREADABLE'));

  const lowerThanPrev = postValidateMeterOcr({
    rawModelJson: { reading: 1200, confidence: 0.95, reason: 'Đọc rõ' },
    previousValue: 1250,
    baselineAvgConsumption: 100,
    anomalyThresholdPct: 30,
    confidenceThreshold: 0.8,
  });
  assert.equal(lowerThanPrev.reading, 1200);
  assert.equal(lowerThanPrev.needsHumanReview, true);
  assert.ok(lowerThanPrev.warnings.includes('READING_LOWER_THAN_PREVIOUS'));

  const highAnomaly = postValidateMeterOcr({
    rawModelJson: { reading: 1500, confidence: 0.95, reason: 'Đọc rõ' },
    previousValue: 1200,
    baselineAvgConsumption: 150,
    anomalyThresholdPct: 30,
    confidenceThreshold: 0.8,
  });
  assert.equal(highAnomaly.reading, 1500);
  assert.equal(highAnomaly.needsHumanReview, true);
  assert.ok(highAnomaly.warnings.includes('CONSUMPTION_ANOMALY_HIGH'));

  const clean = postValidateMeterOcr({
    rawModelJson: { reading: 1320, confidence: 0.94, reason: 'Đọc rõ 5 chữ số' },
    previousValue: 1200,
    baselineAvgConsumption: 110,
    anomalyThresholdPct: 30,
    confidenceThreshold: 0.8,
  });
  assert.equal(clean.reading, 1320);
  assert.equal(clean.needsHumanReview, false);
  assert.deepEqual(clean.warnings, []);
});

test('postValidateTicketTriage enforces closed taxonomy, strips cost_bearer, and escalates safety hazards', () => {
  const invented = postValidateTicketTriage({
    rawModelJson: {
      category: 'ELEVATOR_REPAIR',
      priority: 'HIGH',
      suggested_assignee_id: '11111111-1111-1111-1111-111111111111',
      summary: 'Thang máy kêu',
      confidence: 0.92,
      cost_bearer: 'TENANT',
    },
    description: 'Thang máy tầng 3 kêu to',
    allowedAssigneeIds: ['11111111-1111-1111-1111-111111111111'],
    confidenceThreshold: 0.7,
  });
  assert.equal(invented.category, null);
  assert.equal(invented.triageStatus, 'NEEDS_MANUAL_REVIEW');
  assert.equal(invented.needsHumanReview, true);
  assert.equal('cost_bearer' in invented, false);

  const invalidAssignee = postValidateTicketTriage({
    rawModelJson: {
      category: 'PLUMBING',
      priority: 'NORMAL',
      suggested_assignee_id: '99999999-9999-9999-9999-999999999999',
      summary: 'Vòi nước rỉ nhẹ ở bồn rửa',
      confidence: 0.88,
    },
    description: 'Vòi nước bồn rửa rỉ nhẹ',
    allowedAssigneeIds: ['11111111-1111-1111-1111-111111111111'],
    confidenceThreshold: 0.7,
  });
  assert.equal(invalidAssignee.category, 'PLUMBING');
  assert.equal(invalidAssignee.suggestedAssigneeId, null);
  assert.equal(invalidAssignee.triageStatus, 'SUGGESTED');

  const safetyEscalated = postValidateTicketTriage({
    rawModelJson: {
      category: 'ELECTRICAL',
      priority: 'NORMAL',
      suggested_assignee_id: '11111111-1111-1111-1111-111111111111',
      summary: 'Ổ cắm phòng ngủ phóng tia lửa',
      confidence: 0.9,
      cost_bearer: 'LANDLORD',
    },
    description: 'Ổ cắm phòng ngủ bị rò điện đánh tia lửa khét lẹt',
    allowedAssigneeIds: ['11111111-1111-1111-1111-111111111111'],
    confidenceThreshold: 0.7,
  });
  assert.equal(safetyEscalated.priority, 'URGENT');
  assert.ok(safetyEscalated.warnings.includes('SAFETY_HAZARD_ESCALATED'));
  assert.equal('cost_bearer' in safetyEscalated, false);
});

test('estimateGeminiCostVnd and buildGeminiPromptAndSchema cover all 4 task types', () => {
  assert.equal(AI_TASK_TYPES.length, 4);
  assert.ok(AI_SUGGESTION_STATUSES.includes('EDITED_ACCEPTED'));
  assert.equal(CLOSED_TICKET_CATEGORIES.length, 8);
  assert.equal(CLOSED_TICKET_PRIORITIES.length, 4);

  const cost = estimateGeminiCostVnd({ inputTokens: 1500, outputTokens: 300, model: 'gemini-2.5-flash' });
  assert.ok(Number.isInteger(cost) && cost > 0);

  for (const taskType of AI_TASK_TYPES) {
    const built = buildGeminiPromptAndSchema(taskType, {
      meterType: 'ELECTRICITY',
      previousValue: 1200,
      apartmentCode: 'A101',
      description: 'Hỏng vòi nước',
      recentHistory: [],
      assignees: [{ id: '11111111-1111-1111-1111-111111111111', full_name: 'Kỹ thuật A' }],
    });
    assert.ok(built.systemInstruction.length > 20);
    assert.ok(built.userPrompt.length > 10);
    assert.equal(built.responseSchema.type, 'OBJECT');
  }
});

test('Final Review Fix #2: normalizeAiConfig maps Frontend tasks & threshold aliases bidirectionally', () => {
  const savedFromUi = normalizeAiConfig({
    enabled: true,
    model: 'gemini-2.5-pro',
    tasks: {
      cccd_extract: false,
      contract_extract: true,
      meter_ocr: false,
      ticket_triage: true,
    },
    ocr_threshold: 0.91,
    extract_threshold: 0.82,
    triage_threshold: 0.74,
    monthly_budget_vnd: 900000,
    monthly_token_limit: 3000000,
  });

  assert.equal(savedFromUi.cccd_extract_enabled, false);
  assert.equal(savedFromUi.meter_ocr_enabled, false);
  assert.equal(savedFromUi.contract_extract_enabled, true);
  assert.equal(savedFromUi.ticket_triage_enabled, true);
  assert.equal(savedFromUi.meter_ocr_threshold, 0.91);
  assert.equal(savedFromUi.confidence_threshold, 0.82);
  assert.equal(savedFromUi.ocr_threshold, 0.91);
  assert.equal(savedFromUi.extract_threshold, 0.82);
  assert.deepEqual(savedFromUi.tasks, {
    cccd_extract: false,
    contract_extract: true,
    meter_ocr: false,
    ticket_triage: true,
  });

  // Budget gate honors the UI-saved per-task kill switch!
  const gateCccd = evaluateBudgetGate({
    aiConfig: savedFromUi,
    taskType: 'CCCD_EXTRACT',
    monthlyTokensUsed: 0,
    monthlyCostVnd: 0,
  });
  assert.equal(gateCccd.allowed, false);
  assert.equal(gateCccd.code, 'AI_TASK_DISABLED');
});

