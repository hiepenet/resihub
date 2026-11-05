import { createHash } from 'node:crypto';
import { maskIdNumber, maskPhone } from '../utils/piiMask.js';
import { MAX_IMAGE_BYTES } from './imageUpload.js';

export const AI_TASK_TYPES = [
  'CCCD_EXTRACT',
  'CONTRACT_EXTRACT',
  'METER_OCR',
  'TICKET_TRIAGE',
];

export const AI_SUGGESTION_STATUSES = [
  'PENDING',
  'ACCEPTED',
  'EDITED_ACCEPTED',
  'REJECTED',
  'EXPIRED',
  'FAILED',
];

export const CLOSED_TICKET_CATEGORIES = [
  'ELECTRICAL',
  'PLUMBING',
  'HVAC',
  'FURNITURE',
  'APPLIANCE',
  'CLEANING',
  'SECURITY',
  'OTHER',
];

export const CLOSED_TICKET_PRIORITIES = [
  'LOW',
  'NORMAL',
  'HIGH',
  'URGENT',
];

export const PROMPT_VERSIONS = {
  CCCD_EXTRACT: 'cccd-v1.0',
  CONTRACT_EXTRACT: 'contract-v1.0',
  METER_OCR: 'meter-v1.0',
  TICKET_TRIAGE: 'triage-v1.0',
};

export const DEFAULT_AI_CONFIG = Object.freeze({
  enabled: true,
  cccd_extract_enabled: true,
  contract_extract_enabled: true,
  meter_ocr_enabled: true,
  ticket_triage_enabled: true,
  model: 'gemini-3.8-flash',
  confidence_threshold: 0.75,
  meter_ocr_threshold: 0.8,
  triage_threshold: 0.7,
  monthly_budget_vnd: 500000,
  monthly_token_limit: 2000000,
  warn_percent: 80,
  suggestion_ttl_hours: 72,
});

export function resolveSupportedGeminiModel(rawModel) {
  const slug = String(rawModel || DEFAULT_AI_CONFIG.model).trim();
  const lower = slug.toLowerCase();
  if (!lower) return DEFAULT_AI_CONFIG.model;
  if (lower === 'gemini-2.5-flash-lite' || lower === 'gemini-2.0-flash-lite') {
    return 'gemini-3.5-flash-lite';
  }
  if (
    lower.startsWith('gemini-2.5-') ||
    lower.startsWith('gemini-2.0-') ||
    lower.startsWith('gemini-1.5-') ||
    lower === 'gemini-3.1-pro-preview'
  ) {
    return 'gemini-3.8-flash';
  }
  return slug;
}

const MODEL_SLUG_RE = /^[a-z0-9][a-z0-9._-]{2,63}$/i;
const DATA_URI_RE = /^data:([a-z0-9.+\-/]+);base64,\s*([A-Za-z0-9+/=\r\n]+)$/i;

const SAFETY_HAZARD_RE =
  /(rò\s*điện|giật\s*điện|đánh\s*tia\s*lửa|phóng\s*tia\s*lửa|chập\s*cháy|chập\s*điện|bốc\s*khói|có\s*khói|cháy\s*nổ|hỏa\s*hoạn|vỡ\s*ống|bể\s*ống|ngập\s*nước|tràn\s*nước\s*mạnh|rò\s*khí\s*gas|rò\s*gas|mùi\s*gas|mắc\s*kẹt\s*thang\s*máy|kẹt\s*khóa\s*cửa\s*ngoài)/i;

function validationError(message) {
  return Object.assign(new Error(message), {
    status: 400,
    code: 'VALIDATION_ERROR',
  });
}

function resolveTaskToggle(inc, ex, flatKey, taskKey, fallback) {
  if (inc[flatKey] !== undefined) return inc[flatKey];
  if (inc.tasks && typeof inc.tasks === 'object' && inc.tasks[taskKey] !== undefined) {
    return inc.tasks[taskKey];
  }
  if (ex[flatKey] !== undefined) return ex[flatKey];
  if (ex.tasks && typeof ex.tasks === 'object' && ex.tasks[taskKey] !== undefined) {
    return ex.tasks[taskKey];
  }
  return fallback;
}

export function normalizeAiConfig(incoming = {}, existing = {}) {
  const ex = existing && typeof existing === 'object' ? existing : {};
  const inc = incoming && typeof incoming === 'object' ? incoming : {};
  const merged = {
    ...DEFAULT_AI_CONFIG,
    ...ex,
    ...inc,
    cccd_extract_enabled: resolveTaskToggle(
      inc,
      ex,
      'cccd_extract_enabled',
      'cccd_extract',
      DEFAULT_AI_CONFIG.cccd_extract_enabled
    ),
    contract_extract_enabled: resolveTaskToggle(
      inc,
      ex,
      'contract_extract_enabled',
      'contract_extract',
      DEFAULT_AI_CONFIG.contract_extract_enabled
    ),
    meter_ocr_enabled: resolveTaskToggle(
      inc,
      ex,
      'meter_ocr_enabled',
      'meter_ocr',
      DEFAULT_AI_CONFIG.meter_ocr_enabled
    ),
    ticket_triage_enabled: resolveTaskToggle(
      inc,
      ex,
      'ticket_triage_enabled',
      'ticket_triage',
      DEFAULT_AI_CONFIG.ticket_triage_enabled
    ),
    confidence_threshold:
      inc.confidence_threshold ??
      inc.extract_threshold ??
      ex.confidence_threshold ??
      ex.extract_threshold ??
      DEFAULT_AI_CONFIG.confidence_threshold,
    meter_ocr_threshold:
      inc.meter_ocr_threshold ??
      inc.ocr_threshold ??
      ex.meter_ocr_threshold ??
      ex.ocr_threshold ??
      DEFAULT_AI_CONFIG.meter_ocr_threshold,
  };

  for (const boolKey of [
    'enabled',
    'cccd_extract_enabled',
    'contract_extract_enabled',
    'meter_ocr_enabled',
    'ticket_triage_enabled',
  ]) {
    merged[boolKey] = Boolean(merged[boolKey]);
  }

  const rawModelStr = String(merged.model ?? DEFAULT_AI_CONFIG.model).trim();
  if (!MODEL_SLUG_RE.test(rawModelStr) || rawModelStr.includes('..') || rawModelStr.includes('/')) {
    throw validationError('Tên model AI không hợp lệ.');
  }
  merged.model = resolveSupportedGeminiModel(rawModelStr);

  for (const threshKey of ['confidence_threshold', 'meter_ocr_threshold', 'triage_threshold']) {
    const val = Number(merged[threshKey]);
    if (!Number.isFinite(val) || val <= 0 || val > 1) {
      throw validationError(`Ngưỡng tự tin (${threshKey}) phải nằm trong khoảng (0, 1].`);
    }
    merged[threshKey] = Math.round(val * 1000) / 1000;
  }

  for (const posIntKey of ['monthly_budget_vnd', 'monthly_token_limit']) {
    const val = Math.round(Number(merged[posIntKey]));
    if (!Number.isFinite(val) || val <= 0) {
      throw validationError(`Hạn mức AI (${posIntKey}) phải là số nguyên dương.`);
    }
    merged[posIntKey] = val;
  }

  const warnPct = Math.round(Number(merged.warn_percent));
  if (!Number.isFinite(warnPct) || warnPct < 1 || warnPct > 100) {
    throw validationError('Ngưỡng cảnh báo ngân sách (warn_percent) phải từ 1 đến 100%.');
  }
  merged.warn_percent = warnPct;

  const ttlHours = Math.round(Number(merged.suggestion_ttl_hours));
  if (!Number.isFinite(ttlHours) || ttlHours < 1 || ttlHours > 720) {
    throw validationError('Thời hạn giữ nháp đề xuất (suggestion_ttl_hours) phải từ 1 đến 720 giờ.');
  }
  merged.suggestion_ttl_hours = ttlHours;

  merged.ocr_threshold = merged.meter_ocr_threshold;
  merged.extract_threshold = merged.confidence_threshold;
  merged.tasks = {
    cccd_extract: merged.cccd_extract_enabled,
    contract_extract: merged.contract_extract_enabled,
    meter_ocr: merged.meter_ocr_enabled,
    ticket_triage: merged.ticket_triage_enabled,
  };

  return merged;
}

const TASK_TOGGLE_KEY = {
  CCCD_EXTRACT: 'cccd_extract_enabled',
  CONTRACT_EXTRACT: 'contract_extract_enabled',
  METER_OCR: 'meter_ocr_enabled',
  TICKET_TRIAGE: 'ticket_triage_enabled',
};

export function evaluateBudgetGate({
  aiConfig,
  taskType,
  monthlyTokensUsed = 0,
  monthlyCostVnd = 0,
}) {
  const cfg = normalizeAiConfig(aiConfig || {});
  if (!cfg.enabled) {
    return {
      allowed: false,
      warning80Pct: false,
      code: 'AI_DISABLED',
      message: 'Tính năng AI đang tạm tắt bởi Quản trị hệ thống (Kill Switch). Vui lòng nhập thủ công.',
    };
  }

  const toggleKey = TASK_TOGGLE_KEY[taskType];
  if (toggleKey && !cfg[toggleKey]) {
    return {
      allowed: false,
      warning80Pct: false,
      code: 'AI_TASK_DISABLED',
      message: `Tác vụ AI (${taskType}) đang được tắt trong cấu hình hệ thống. Vui lòng thao tác thủ công.`,
    };
  }

  const tokens = Math.max(0, Number(monthlyTokensUsed) || 0);
  const cost = Math.max(0, Number(monthlyCostVnd) || 0);

  if (cost >= cfg.monthly_budget_vnd || tokens >= cfg.monthly_token_limit) {
    return {
      allowed: false,
      warning80Pct: true,
      code: 'AI_BUDGET_EXCEEDED',
      message: 'Đã chạm hạn mức ngân sách/token AI trong tháng. Vui lòng nhập thủ công hoặc liên hệ Quản trị hệ thống.',
    };
  }

  const costPct = (cost / cfg.monthly_budget_vnd) * 100;
  const tokenPct = (tokens / cfg.monthly_token_limit) * 100;
  const warning80Pct = costPct >= cfg.warn_percent || tokenPct >= cfg.warn_percent;

  return {
    allowed: true,
    warning80Pct,
  };
}

export function parseDataUriPayload(
  dataUri,
  { allowPdf = false, maxBytes = MAX_IMAGE_BYTES } = {}
) {
  const raw = String(dataUri || '').trim();
  const match = DATA_URI_RE.exec(raw);
  if (!match) {
    return {
      valid: false,
      code: 'VALIDATION_ERROR',
      message: allowPdf
        ? 'Tệp tải lên phải ở định dạng base64 data URI (image/jpeg, image/png, image/webp hoặc application/pdf).'
        : 'Ảnh tải lên phải ở định dạng base64 data URI (image/jpeg, image/png hoặc image/webp).',
    };
  }

  const declaredMime = match[1].toLowerCase();
  const allowedMimes = allowPdf
    ? ['image/jpeg', 'image/png', 'image/webp', 'application/pdf']
    : ['image/jpeg', 'image/png', 'image/webp'];

  if (!allowedMimes.includes(declaredMime)) {
    return {
      valid: false,
      code: 'VALIDATION_ERROR',
      message: `Định dạng tệp (${declaredMime}) không được phép cho tác vụ này.`,
    };
  }

  const cleanBase64 = match[2].replace(/\s+/g, '');
  const bytes = Buffer.from(cleanBase64, 'base64');
  if (!bytes.length) {
    return {
      valid: false,
      code: 'VALIDATION_ERROR',
      message: 'Tệp tải lên rỗng hoặc không hợp lệ.',
    };
  }

  if (bytes.length > maxBytes) {
    const maxMb = Math.round((maxBytes / (1024 * 1024)) * 10) / 10;
    return {
      valid: false,
      code: 'VALIDATION_ERROR',
      message: `Dung lượng tệp vượt quá giới hạn ${maxMb}MB.`,
    };
  }

  // Magic-byte verification
  const isJpeg = bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const isPng =
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47;
  const isWebp =
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
    bytes.subarray(8, 12).toString('ascii') === 'WEBP';
  const isPdf = bytes.length >= 5 && bytes.subarray(0, 5).toString('ascii') === '%PDF-';

  const magicMatches =
    (declaredMime === 'image/jpeg' && isJpeg) ||
    (declaredMime === 'image/png' && isPng) ||
    (declaredMime === 'image/webp' && isWebp) ||
    (declaredMime === 'application/pdf' && allowPdf && isPdf);

  if (!magicMatches) {
    return {
      valid: false,
      code: 'VALIDATION_ERROR',
      message: 'Nội dung tệp không khớp chữ ký định dạng (magic bytes) hợp lệ.',
    };
  }

  const sha256Hex = createHash('sha256').update(bytes).digest('hex');

  return {
    valid: true,
    mimeType: declaredMime,
    base64Data: cleanBase64,
    byteLength: bytes.length,
    sha256Hex,
  };
}

function normalizeFieldValueForHash(val) {
  if (val === null || val === undefined) return '';
  return String(val).trim().replace(/\s+/g, ' ').toLowerCase();
}

export function hashFieldValue(fieldKey, val) {
  const norm = normalizeFieldValueForHash(val);
  return createHash('sha256').update(`${fieldKey}:${norm}`, 'utf8').digest('hex');
}

const SENSITIVE_ID_KEYS = new Set(['id_number', 'tenant_id_number', 'cccd']);
const SENSITIVE_PHONE_KEYS = new Set(['phone', 'tenant_phone']);

export function buildExtractionDbPayload(
  taskType,
  extractedFields = {},
  fieldConfidences = {}
) {
  const redactedOutput = {};
  const fieldHashes = {};

  for (const [key, rawVal] of Object.entries(extractedFields || {})) {
    if (rawVal === undefined || rawVal === null || String(rawVal).trim() === '') {
      redactedOutput[key] = null;
      continue;
    }
    const strVal = typeof rawVal === 'number' ? rawVal : String(rawVal).trim();
    fieldHashes[key] = hashFieldValue(key, strVal);

    if (SENSITIVE_ID_KEYS.has(key)) {
      redactedOutput[key] = maskIdNumber(String(strVal));
    } else if (SENSITIVE_PHONE_KEYS.has(key)) {
      redactedOutput[key] = maskPhone(String(strVal));
    } else {
      redactedOutput[key] = strVal;
    }
  }

  const totalFieldsCount = Object.keys(fieldHashes).length;
  return {
    redactedOutput: {
      ...redactedOutput,
      field_confidences: fieldConfidences || {},
      field_hashes: fieldHashes,
      task_type: taskType,
    },
    fieldHashes,
    totalFieldsCount,
  };
}

export function computeFieldAcceptanceDiff({ fieldHashes = {}, finalValues = {} } = {}) {
  const keys = Object.keys(fieldHashes || {});
  const totalFieldsCount = keys.length;
  if (totalFieldsCount === 0) {
    return {
      acceptedFieldsCount: 0,
      totalFieldsCount: 0,
      status: 'ACCEPTED',
    };
  }

  let acceptedFieldsCount = 0;
  for (const key of keys) {
    const finalVal = finalValues?.[key];
    if (finalVal !== undefined && hashFieldValue(key, finalVal) === fieldHashes[key]) {
      acceptedFieldsCount += 1;
    }
  }

  return {
    acceptedFieldsCount,
    totalFieldsCount,
    status: acceptedFieldsCount === totalFieldsCount ? 'ACCEPTED' : 'EDITED_ACCEPTED',
  };
}

export function postValidateMeterOcr({
  rawModelJson = {},
  expectedMeterType = null,
  previousValue = null,
  baselineAvgConsumption = null,
  anomalyThresholdPct = 30,
  confidenceThreshold = 0.8,
} = {}) {
  const rawConf = Number(rawModelJson?.confidence);
  const confidence = Number.isFinite(rawConf)
    ? Math.max(0, Math.min(1, Math.round(rawConf * 1000) / 1000))
    : 0;
  const reason = String(rawModelJson?.reason || '').trim();
  const warnings = [];

  const rawDetectedType = String(rawModelJson?.detected_meter_type || '')
    .trim()
    .toUpperCase();
  const detectedMeterType =
    rawDetectedType === 'ELECTRICITY' || rawDetectedType === 'WATER'
      ? rawDetectedType
      : null;

  const normExpectedType = String(expectedMeterType || '')
    .trim()
    .toUpperCase();
  const validExpectedType =
    normExpectedType === 'ELECTRICITY' || normExpectedType === 'WATER'
      ? normExpectedType
      : null;

  const hasTypeMismatch =
    Boolean(validExpectedType && detectedMeterType && validExpectedType !== detectedMeterType);

  const rawReading = rawModelJson?.reading;
  const parsedReading =
    rawReading === null || rawReading === undefined || rawReading === ''
      ? null
      : Number(rawReading);

  if (
    parsedReading === null ||
    !Number.isFinite(parsedReading) ||
    parsedReading < 0 ||
    confidence < confidenceThreshold
  ) {
    warnings.push('LOW_CONFIDENCE_OR_UNREADABLE');
    if (hasTypeMismatch) {
      warnings.push('METER_TYPE_MISMATCH');
    }
    return {
      reading: null,
      detectedMeterType,
      confidence,
      reason: reason || 'Ảnh đồng hồ mờ/lóa hoặc độ tin cậy dưới ngưỡng cấu hình; vui lòng nhập tay.',
      needsHumanReview: true,
      warnings,
    };
  }

  const reading = Math.round(parsedReading * 100) / 100;
  let needsHumanReview = false;

  if (hasTypeMismatch) {
    warnings.push('METER_TYPE_MISMATCH');
    needsHumanReview = true;
  }

  if (previousValue !== null && previousValue !== undefined && Number.isFinite(Number(previousValue))) {
    const prev = Number(previousValue);
    if (reading < prev) {
      warnings.push('READING_LOWER_THAN_PREVIOUS');
      needsHumanReview = true;
    } else if (
      baselineAvgConsumption !== null &&
      baselineAvgConsumption !== undefined &&
      Number(baselineAvgConsumption) > 0
    ) {
      const consumption = reading - prev;
      const base = Number(baselineAvgConsumption);
      const maxExpected = base * (1 + Math.max(0, Number(anomalyThresholdPct) || 30) / 100);
      if (consumption > maxExpected) {
        warnings.push('CONSUMPTION_ANOMALY_HIGH');
        needsHumanReview = true;
      }
    }
  }

  return {
    reading,
    detectedMeterType,
    confidence,
    reason: reason || 'Đọc chỉ số thành công, chờ người dùng xác nhận.',
    needsHumanReview,
    warnings,
  };
}

export function postValidateTicketTriage({
  rawModelJson = {},
  description = '',
  allowedAssigneeIds = [],
  confidenceThreshold = 0.7,
} = {}) {
  const rawConf = Number(rawModelJson?.confidence);
  const confidence = Number.isFinite(rawConf)
    ? Math.max(0, Math.min(1, Math.round(rawConf * 1000) / 1000))
    : 0;
  const summary = String(rawModelJson?.summary || '').trim().slice(0, 240);
  const warnings = [];

  const rawCat = String(rawModelJson?.category || '').trim().toUpperCase();
  const rawPrio = String(rawModelJson?.priority || '').trim().toUpperCase();
  const validCat = CLOSED_TICKET_CATEGORIES.includes(rawCat) ? rawCat : null;
  const validPrio = CLOSED_TICKET_PRIORITIES.includes(rawPrio) ? rawPrio : null;

  const allowedSet = new Set((allowedAssigneeIds || []).map((id) => String(id)));
  const rawAssignee = rawModelJson?.suggested_assignee_id
    ? String(rawModelJson.suggested_assignee_id).trim()
    : null;
  const suggestedAssigneeId = rawAssignee && allowedSet.has(rawAssignee) ? rawAssignee : null;

  const hasSafetyHazard = SAFETY_HAZARD_RE.test(`${description || ''} ${summary}`);

  if (!validCat || !validPrio || confidence < confidenceThreshold) {
    if (!validCat && rawCat) warnings.push('OUT_OF_TAXONOMY_CATEGORY');
    if (!validPrio && rawPrio) warnings.push('OUT_OF_TAXONOMY_PRIORITY');
    if (confidence < confidenceThreshold) warnings.push('LOW_CONFIDENCE_TRIAGE');

    const safePriority = hasSafetyHazard ? 'URGENT' : null;
    if (hasSafetyHazard) {
      warnings.push('SAFETY_HAZARD_ESCALATED');
    }

    return {
      category: null,
      priority: safePriority,
      suggestedAssigneeId: null,
      summary: summary || 'Cần Quản lý tòa nhà kiểm tra và phân loại thủ công.',
      confidence,
      needsHumanReview: true,
      triageStatus: 'NEEDS_MANUAL_REVIEW',
      warnings,
    };
  }

  let finalPriority = validPrio;
  if (hasSafetyHazard && finalPriority !== 'URGENT') {
    finalPriority = 'URGENT';
    warnings.push('SAFETY_HAZARD_ESCALATED');
  }

  return {
    category: validCat,
    priority: finalPriority,
    suggestedAssigneeId,
    summary: summary || `Gợi ý xử lý nhóm ${validCat} (${finalPriority}).`,
    confidence,
    needsHumanReview: false,
    triageStatus: 'SUGGESTED',
    warnings,
  };
}

export function estimateGeminiCostVnd({
  inputTokens = 0,
  outputTokens = 0,
  model = 'gemini-3.8-flash',
} = {}) {
  const inTok = Math.max(0, Number(inputTokens) || 0);
  const outTok = Math.max(0, Number(outputTokens) || 0);
  const modelLower = String(model || '').toLowerCase();
  const isPro = modelLower.includes('pro') || modelLower.includes('argon');

  // Ước tính quy đổi VND bảo thủ (tỷ giá ~25.500 VND/USD, làm tròn lên tối thiểu 1 VND khi có gọi token)
  const inRatePerMillionVnd = isPro ? 32000 : 8000;
  const outRatePerMillionVnd = isPro ? 255000 : 64000;
  const rawVnd =
    (inTok / 1_000_000) * inRatePerMillionVnd + (outTok / 1_000_000) * outRatePerMillionVnd;

  if (inTok + outTok > 0) {
    return Math.max(1, Math.ceil(rawVnd));
  }
  return 0;
}

export function buildGeminiPromptAndSchema(taskType, context = {}) {
  switch (taskType) {
    case 'CCCD_EXTRACT':
      return {
        systemInstruction:
          'Bạn là bộ trích xuất giấy tờ tùy thân CCCD/CMND Việt Nam chính xác. Chỉ đọc thông tin hiển thị rõ trên ảnh; trường nào mờ hoặc không thấy thì trả chuỗi rỗng "" và confidence thấp, tuyệt đối không tự suy đoán.',
        userPrompt:
          'Trích xuất thông tin từ ảnh CCCD đính kèm: full_name (họ và tên có dấu chuẩn), id_number (chỉ chữ số CCCD/CMND), dob (YYYY-MM-DD), issue_date (YYYY-MM-DD nếu thấy), permanent_address (nơi thường trú), kèm điểm tự tin 0..1.',
        responseSchema: {
          type: 'OBJECT',
          properties: {
            full_name: { type: 'STRING' },
            id_number: { type: 'STRING' },
            dob: { type: 'STRING' },
            issue_date: { type: 'STRING' },
            permanent_address: { type: 'STRING' },
            confidence: { type: 'NUMBER' },
            field_confidences: {
              type: 'OBJECT',
              properties: {
                full_name: { type: 'NUMBER' },
                id_number: { type: 'NUMBER' },
                dob: { type: 'NUMBER' },
                issue_date: { type: 'NUMBER' },
                permanent_address: { type: 'NUMBER' },
              },
            },
          },
          required: ['full_name', 'id_number', 'dob', 'confidence'],
        },
      };

    case 'CONTRACT_EXTRACT':
      return {
        systemInstruction:
          'Bạn là bộ số hóa hợp đồng thuê căn hộ/nhà trọ tại Việt Nam. Trích xuất chính xác các con số VND nguyên, ngày YYYY-MM-DD và thông tin bên thuê từ bản chụp/PDF hợp đồng. Trường nào không có trên tài liệu thì trả null hoặc "", không bịa dữ liệu.',
        userPrompt:
          'Trích xuất từ hợp đồng đính kèm: tenant_full_name, tenant_phone, tenant_id_number, apartment_code, start_date (YYYY-MM-DD), end_date (YYYY-MM-DD), rent_amount (số nguyên VND/tháng), deposit_amount (số nguyên VND), billing_day (1..31), payment_due_days (số ngày hạn thanh toán), terms_note (tóm tắt ngắn đơn giá điện/nước/dịch vụ ghi trong hợp đồng), kèm confidence 0..1.',
        responseSchema: {
          type: 'OBJECT',
          properties: {
            tenant_full_name: { type: 'STRING' },
            tenant_phone: { type: 'STRING' },
            tenant_id_number: { type: 'STRING' },
            apartment_code: { type: 'STRING' },
            start_date: { type: 'STRING' },
            end_date: { type: 'STRING' },
            rent_amount: { type: 'INTEGER', nullable: true },
            deposit_amount: { type: 'INTEGER', nullable: true },
            billing_day: { type: 'INTEGER', nullable: true },
            payment_due_days: { type: 'INTEGER', nullable: true },
            terms_note: { type: 'STRING' },
            confidence: { type: 'NUMBER' },
            field_confidences: {
              type: 'OBJECT',
              properties: {
                tenant_full_name: { type: 'NUMBER' },
                tenant_phone: { type: 'NUMBER' },
                tenant_id_number: { type: 'NUMBER' },
                apartment_code: { type: 'NUMBER' },
                start_date: { type: 'NUMBER' },
                end_date: { type: 'NUMBER' },
                rent_amount: { type: 'NUMBER' },
                deposit_amount: { type: 'NUMBER' },
                billing_day: { type: 'NUMBER' },
                payment_due_days: { type: 'NUMBER' },
              },
            },
          },
          required: ['confidence'],
        },
      };

    case 'METER_OCR': {
      const meterLabel =
        context.meterType === 'WATER'
          ? 'đồng hồ nước (m³)'
          : context.meterType === 'ELECTRICITY'
            ? 'đồng hồ điện (kWh)'
            : 'đồng hồ điện (kWh) hoặc đồng hồ nước (m³)';
      const targetDesc = context.meterCode
        ? `của mã đồng hồ ${context.meterCode}`
        : context.apartmentCode
          ? `của căn hộ ${context.apartmentCode}`
          : 'trong tòa nhà';
      const prevHint =
        context.previousValue !== null && context.previousValue !== undefined
          ? `Chỉ số kỳ trước để tham khảo ngữ cảnh là ${context.previousValue}.`
          : '';
      return {
        systemInstruction:
          'Bạn là bộ đọc chỉ số công tơ điện/nước từ ảnh chụp thực địa. Nếu mặt đồng hồ bị mờ, lóa sáng, che khuất hoặc không đọc chắc chắn các chữ số thì BẮT BUỘC trả reading = null và confidence < 0.5, tuyệt đối không đoán mò con số. Đồng thời nhận diện loại công tơ trên mặt đồng hồ vào trường detected_meter_type: "ELECTRICITY" nếu là công tơ điện (kWh) hoặc "WATER" nếu là đồng hồ nước (m³), hoặc null nếu không phân biệt được.',
        userPrompt: `Đọc chỉ số hiện tại trên ảnh ${meterLabel} ${targetDesc}. ${prevHint} Trả về JSON gồm reading (number hoặc null), detected_meter_type ("ELECTRICITY" | "WATER" | null), confidence (0..1) và reason (giải thích ngắn tiếng Việt).`,
        responseSchema: {
          type: 'OBJECT',
          properties: {
            reading: { type: 'NUMBER', nullable: true },
            detected_meter_type: {
              type: 'STRING',
              enum: ['ELECTRICITY', 'WATER'],
              nullable: true,
            },
            confidence: { type: 'NUMBER' },
            reason: { type: 'STRING' },
          },
          required: ['confidence', 'reason'],
        },
      };
    }

    case 'TICKET_TRIAGE': {
      const assigneesText =
        Array.isArray(context.assignees) && context.assignees.length > 0
          ? context.assignees.map((a) => `- ${a.id}: ${a.full_name || a.email || 'Nhân sự'}`).join('\n')
          : '(Không có danh sách nhân sự)';
      const historyText =
        Array.isArray(context.recentHistory) && context.recentHistory.length > 0
          ? context.recentHistory
              .map((h) => `- [${h.category}/${h.status}] ${h.title || ''}: ${String(h.description || '').slice(0, 80)}`)
              .join('\n')
          : '(Chưa có lịch sử sự cố gần đây)';
      return {
        systemInstruction:
          'Bạn là trợ lý điều phối kỹ thuật tòa nhà. Chỉ được phép phân loại vào đúng danh mục đóng được cung cấp; ưu tiên độ nhạy (recall) cao cho mức URGENT nếu có nguy cơ mất an toàn (rò điện, cháy khói, ngập nước, rò gas, kẹt khóa). TUYỆT ĐỐI KHÔNG phán đoán bên chịu chi phí sửa chữa.',
        userPrompt: `Phân loại yêu cầu báo hỏng căn hộ ${context.apartmentCode || ''}:\nTiêu đề/Hạng mục cư dân chọn: ${context.title || ''} (${context.categoryHint || ''})\nMô tả chi tiết: ${context.description || ''}\nLịch sử căn hộ:\n${historyText}\nNhân sự phụ trách khả dụng của tòa:\n${assigneesText}`,
        responseSchema: {
          type: 'OBJECT',
          properties: {
            category: {
              type: 'STRING',
              enum: CLOSED_TICKET_CATEGORIES,
            },
            priority: {
              type: 'STRING',
              enum: CLOSED_TICKET_PRIORITIES,
            },
            suggested_assignee_id: {
              type: 'STRING',
              nullable: true,
            },
            summary: {
              type: 'STRING',
            },
            confidence: {
              type: 'NUMBER',
            },
          },
          required: ['category', 'priority', 'summary', 'confidence'],
        },
      };
    }

    default:
      throw validationError(`Không hỗ trợ loại tác vụ AI: ${taskType}`);
  }
}

