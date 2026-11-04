export const DEFAULT_AI_CONFIG = {
  enabled: true,
  model: 'gemini-3.8-flash',
  tasks: {
    cccd_extract: true,
    contract_extract: true,
    meter_ocr: true,
    ticket_triage: true,
  },
  ocr_threshold: 0.8,
  triage_threshold: 0.7,
  extract_threshold: 0.75,
  monthly_token_limit: 2000000,
  monthly_budget_vnd: 500000,
  warn_percent: 80,
  suggestion_ttl_hours: 72,
};

function normalizeFrontendAiModel(rawModel) {
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

export function mergeAiConfigState(raw = {}) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const srcTasks = src.tasks && typeof src.tasks === 'object' ? src.tasks : {};
  return {
    ...DEFAULT_AI_CONFIG,
    ...src,
    model: normalizeFrontendAiModel(src.model),
    ocr_threshold:
      src.ocr_threshold ?? src.meter_ocr_threshold ?? DEFAULT_AI_CONFIG.ocr_threshold,
    extract_threshold:
      src.extract_threshold ?? src.confidence_threshold ?? DEFAULT_AI_CONFIG.extract_threshold,
    triage_threshold:
      src.triage_threshold ?? DEFAULT_AI_CONFIG.triage_threshold,
    tasks: {
      cccd_extract:
        srcTasks.cccd_extract ?? src.cccd_extract_enabled ?? DEFAULT_AI_CONFIG.tasks.cccd_extract,
      contract_extract:
        srcTasks.contract_extract ??
        src.contract_extract_enabled ??
        DEFAULT_AI_CONFIG.tasks.contract_extract,
      meter_ocr:
        srcTasks.meter_ocr ?? src.meter_ocr_enabled ?? DEFAULT_AI_CONFIG.tasks.meter_ocr,
      ticket_triage:
        srcTasks.ticket_triage ??
        src.ticket_triage_enabled ??
        DEFAULT_AI_CONFIG.tasks.ticket_triage,
    },
  };
}

export function getAiTriageBadgeMeta(triageStatus) {
  switch (triageStatus) {
    case 'SUGGESTED':
      return {
        variant: 'amber',
        label: 'AI đề xuất',
        sparkles: true,
        needsManualWarning: false,
      };
    case 'NEEDS_MANUAL_REVIEW':
    case 'LOW_CONFIDENCE':
    case 'FAILED':
      return {
        variant: 'red',
        label: 'Cần phân loại thủ công',
        sparkles: false,
        needsManualWarning: true,
      };
    case 'ACCEPTED':
    case 'APPLIED':
      return {
        variant: 'emerald',
        label: 'Đã duyệt gợi ý AI',
        sparkles: false,
        needsManualWarning: false,
      };
    case 'OVERRIDDEN':
      return {
        variant: 'indigo',
        label: 'Đã điều chỉnh từ AI',
        sparkles: false,
        needsManualWarning: false,
      };
    default:
      return null;
  }
}

export function canOneClickApplyAiTriage(detail) {
  if (!detail) return false;
  if (!detail.ai_suggested_category || !detail.ai_suggested_priority) return false;
  return !['ACCEPTED', 'APPLIED', 'OVERRIDDEN'].includes(detail.ai_triage_status || '');
}

export function formatConfidenceBadge(confidence, threshold = 0.75) {
  const num = Number(confidence);
  const safeThreshold = Number.isFinite(Number(threshold)) ? Number(threshold) : 0.75;
  if (!Number.isFinite(num) || num <= 0) {
    return {
      percentText: '0%',
      tone: 'rose',
      label: 'Cần kiểm tra tay',
      isUncertain: true,
    };
  }

  const clamped = Math.max(0, Math.min(1, num));
  const pct = Math.round(clamped * 100);
  const percentText = `${pct}%`;

  if (clamped < safeThreshold) {
    return {
      percentText,
      tone: 'rose',
      label: `Độ tin cậy thấp (${percentText})`,
      isUncertain: true,
    };
  }

  if (clamped >= Math.max(0.88, safeThreshold + 0.1)) {
    return {
      percentText,
      tone: 'emerald',
      label: `Độ tin cậy cao (${percentText})`,
      isUncertain: false,
    };
  }

  return {
    percentText,
    tone: 'amber',
    label: `Độ tin cậy khá (${percentText})`,
    isUncertain: false,
  };
}

export function mapAiErrorToVietnamese(error) {
  const code =
    error?.response?.data?.code ||
    error?.code ||
    error?.data?.code ||
    '';
  const serverMessage =
    error?.response?.data?.message ||
    error?.message ||
    '';

  switch (code) {
    case 'PRIVACY_CONSENT_REQUIRED':
      return {
        code,
        title: 'Chưa xác nhận xử lý dữ liệu bằng AI',
        guidance:
          'Vui lòng tích chọn xác nhận thông báo xử lý dữ liệu cá nhân/hợp đồng bằng AI trước khi bấm trích xuất, hoặc nhập trực tiếp vào biểu mẫu.',
        canManualFallback: false,
      };
    case 'AI_DISABLED':
      return {
        code,
        title: 'Trợ lý AI đang tạm tắt (Kill Switch)',
        guidance:
          'Quản trị hệ thống đang tạm ngắt AI Gateway. Bạn vẫn có thể tiếp tục nhập và lưu dữ liệu thủ công bình thường.',
        canManualFallback: true,
      };
    case 'AI_TASK_DISABLED':
      return {
        code,
        title: 'Tác vụ AI này đang tạm tắt',
        guidance:
          'Tính năng AI cho nghiệp vụ này đang được cấu hình tắt. Vui lòng nhập trực tiếp thông tin vào các ô bên dưới.',
        canManualFallback: true,
      };
    case 'AI_BUDGET_EXCEEDED':
      return {
        code,
        title: 'Đã chạm trần ngân sách AI trong tháng',
        guidance:
          'Tổ chức đã sử dụng hết hạn mức chi phí/token AI của kỳ này. Bạn vui lòng nhập thủ công hoặc liên hệ Quản trị hệ thống nâng hạn mức.',
        canManualFallback: true,
      };
    case 'AI_UNCONFIGURED':
      return {
        code,
        title: 'Máy chủ chưa cấu hình khóa kết nối AI',
        guidance:
          'Hệ thống chưa thiết lập GEMINI_API_KEY trên máy chủ Backend. Vui lòng nhập thủ công hoặc báo Quản trị hệ thống kiểm tra môi trường.',
        canManualFallback: true,
      };
    case 'AI_TIMEOUT':
      return {
        code,
        title: 'Dịch vụ AI phản hồi quá thời gian chờ',
        guidance:
          'Kết nối tới Gemini tạm thời chậm hơn bình thường. Bạn có thể bấm thử lại với ảnh rõ nét hơn hoặc nhập trực tiếp không cần chờ AI.',
        canManualFallback: true,
      };
    case 'AI_RATE_LIMIT_EXCEEDED':
    case 'AI_UPSTREAM_RATE_LIMIT':
      return {
        code,
        title: 'Tần suất gọi AI đang cao',
        guidance:
          'Hệ thống đang giới hạn tốc độ gọi AI để bảo vệ hạn mức. Vui lòng đợi vài giây rồi thử lại hoặc nhập tay.',
        canManualFallback: true,
      };
    default:
      return {
        code: code || 'AI_ERROR',
        title: 'Không thể xử lý bằng AI lúc này',
        guidance:
          serverMessage ||
          'Hệ thống AI tạm thời gián đoạn. Bạn có thể tiếp tục nhập và lưu dữ liệu thủ công ngay.',
        canManualFallback: true,
      };
  }
}

export function createAiFieldTracker(suggestionId, suggestedMap = {}, fieldConfidences = {}) {
  const fields = {};
  const entries = suggestedMap && typeof suggestedMap === 'object' ? Object.entries(suggestedMap) : [];
  for (const [key, val] of entries) {
    if (val === undefined || val === null || val === '') continue;
    const rawConf = fieldConfidences?.[key];
    fields[key] = {
      active: true,
      confirmed: false,
      edited: false,
      suggestedValue: String(val),
      confidence: Number.isFinite(Number(rawConf)) ? Number(rawConf) : null,
    };
  }

  return {
    suggestionId: suggestionId || null,
    fields,
  };
}

export function markFieldConfirmedOrEdited(tracker, fieldKey, newValue) {
  if (!tracker || !tracker.fields || !tracker.fields[fieldKey]) {
    return tracker;
  }
  const prevField = tracker.fields[fieldKey];
  const nextValNorm = newValue === undefined || newValue === null ? '' : String(newValue).trim();
  const suggNorm = String(prevField.suggestedValue ?? '').trim();

  return {
    ...tracker,
    fields: {
      ...tracker.fields,
      [fieldKey]: {
        ...prevField,
        confirmed: true,
        edited: nextValNorm !== suggNorm,
      },
    },
  };
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64');
  }
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

export async function compressImageFileToDataUri(
  file,
  { maxDimension = 1280, quality = 0.78 } = {}
) {
  if (!file) throw new Error('Chưa chọn tệp tài liệu.');
  if (typeof file === 'string' && file.startsWith('data:')) {
    return file;
  }

  const mime = String(file.type || '').toLowerCase();
  if (mime === 'application/pdf') {
    const ab = await file.arrayBuffer();
    return `data:application/pdf;base64,${arrayBufferToBase64(ab)}`;
  }

  // Non-DOM fallback (unit tests / SSR)
  if (typeof document === 'undefined' || typeof Image === 'undefined') {
    const ab = await file.arrayBuffer();
    const fallbackMime = mime || 'image/jpeg';
    return `data:${fallbackMime};base64,${arrayBufferToBase64(ab)}`;
  }

  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Không thể đọc tệp ảnh.'));
    reader.onload = () => {
      const rawDataUrl = String(reader.result || '');
      const img = new Image();
      img.onerror = () => resolve(rawDataUrl);
      img.onload = () => {
        try {
          const { width, height } = img;
          if (
            mime === 'image/jpeg' &&
            width <= maxDimension &&
            height <= maxDimension &&
            rawDataUrl.length < 350_000
          ) {
            resolve(rawDataUrl);
            return;
          }
          const scale = Math.min(1, maxDimension / Math.max(width, height));
          const targetW = Math.max(1, Math.round(width * scale));
          const targetH = Math.max(1, Math.round(height * scale));
          const canvas = document.createElement('canvas');
          canvas.width = targetW;
          canvas.height = targetH;
          const ctx = canvas.getContext('2d');
          if (!ctx) {
            resolve(rawDataUrl);
            return;
          }
          ctx.drawImage(img, 0, 0, targetW, targetH);
          const outMime = mime === 'image/png' ? 'image/jpeg' : mime || 'image/jpeg';
          resolve(canvas.toDataURL(outMime, quality));
        } catch {
          resolve(rawDataUrl);
        }
      };
      img.src = rawDataUrl;
    };
    reader.readAsDataURL(file);
  });
}

