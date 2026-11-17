import 'dart:math' as math;
export 'meter_batch_photo_helpers.dart' show runBoundedConcurrencyQueue, QueueTaskResult;

const Map<String, dynamic> kDefaultAiConfig = {
  'enabled': true,
  'model': 'gemini-3.8-flash',
  'tasks': {
    'cccd_extract': true,
    'contract_extract': true,
    'meter_ocr': true,
    'ticket_triage': true,
  },
  'ocr_threshold': 0.8,
  'triage_threshold': 0.7,
  'extract_threshold': 0.75,
  'monthly_token_limit': 2000000,
  'monthly_budget_vnd': 500000,
  'warn_percent': 80,
  'suggestion_ttl_hours': 72,
};

String normalizeFrontendAiModel(dynamic rawModel) {
  final slug = rawModel?.toString().trim() ?? 'gemini-3.8-flash';
  final lower = slug.toLowerCase();
  if (lower.isEmpty) return 'gemini-3.8-flash';
  if (lower == 'gemini-2.5-flash-lite' || lower == 'gemini-2.0-flash-lite') {
    return 'gemini-3.5-flash-lite';
  }
  if (lower.startsWith('gemini-2.5-') ||
      lower.startsWith('gemini-2.0-') ||
      lower.startsWith('gemini-1.5-') ||
      lower == 'gemini-3.1-pro-preview') {
    return 'gemini-3.8-flash';
  }
  return slug;
}

Map<String, dynamic> mergeAiConfigState([Map<String, dynamic>? raw]) {
  final src = raw ?? const {};
  final rawTasks = src['tasks'];
  final srcTasks = rawTasks is Map ? rawTasks : const {};

  final defaultTasks = kDefaultAiConfig['tasks'] as Map<String, dynamic>;

  return {
    ...kDefaultAiConfig,
    ...src,
    'model': normalizeFrontendAiModel(src['model']),
    'ocr_threshold': src['ocr_threshold'] ?? src['meter_ocr_threshold'] ?? kDefaultAiConfig['ocr_threshold'],
    'extract_threshold': src['extract_threshold'] ?? src['confidence_threshold'] ?? kDefaultAiConfig['extract_threshold'],
    'triage_threshold': src['triage_threshold'] ?? kDefaultAiConfig['triage_threshold'],
    'tasks': {
      'cccd_extract': srcTasks['cccd_extract'] ?? src['cccd_extract_enabled'] ?? defaultTasks['cccd_extract'],
      'contract_extract': srcTasks['contract_extract'] ?? src['contract_extract_enabled'] ?? defaultTasks['contract_extract'],
      'meter_ocr': srcTasks['meter_ocr'] ?? src['meter_ocr_enabled'] ?? defaultTasks['meter_ocr'],
      'ticket_triage': srcTasks['ticket_triage'] ?? src['ticket_triage_enabled'] ?? defaultTasks['ticket_triage'],
    },
  };
}

Map<String, dynamic>? getAiTriageBadgeMeta(String? triageStatus) {
  switch (triageStatus) {
    case 'SUGGESTED':
      return {
        'variant': 'amber',
        'label': 'AI đề xuất',
        'sparkles': true,
        'needsManualWarning': false,
      };
    case 'NEEDS_MANUAL_REVIEW':
    case 'LOW_CONFIDENCE':
    case 'FAILED':
      return {
        'variant': 'red',
        'label': 'Cần phân loại thủ công',
        'sparkles': false,
        'needsManualWarning': true,
      };
    case 'ACCEPTED':
    case 'APPLIED':
      return {
        'variant': 'emerald',
        'label': 'Đã duyệt gợi ý AI',
        'sparkles': false,
        'needsManualWarning': false,
      };
    case 'OVERRIDDEN':
      return {
        'variant': 'indigo',
        'label': 'Đã điều chỉnh từ AI',
        'sparkles': false,
        'needsManualWarning': false,
      };
    default:
      return null;
  }
}

bool canOneClickApplyAiTriage(dynamic detail) {
  if (detail == null || detail is! Map) return false;
  final cat = detail['ai_suggested_category'];
  final prio = detail['ai_suggested_priority'];
  if (cat == null || prio == null) return false;

  final status = (detail['ai_triage_status'] ?? '').toString();
  return status != 'ACCEPTED' && status != 'APPLIED' && status != 'OVERRIDDEN';
}

class ConfidenceBadgeMeta {
  final String percentText;
  final String tone; // 'rose' | 'amber' | 'emerald'
  final String label;
  final bool isUncertain;

  const ConfidenceBadgeMeta({
    required this.percentText,
    required this.tone,
    required this.label,
    required this.isUncertain,
  });
}

ConfidenceBadgeMeta formatConfidenceBadge(dynamic confidence, [dynamic threshold = 0.75]) {
  final num? numVal = confidence is num ? confidence : num.tryParse(confidence?.toString() ?? '');
  final num? threshVal = threshold is num ? threshold : num.tryParse(threshold?.toString() ?? '');
  final safeThreshold = (threshVal != null && threshVal > 0) ? threshVal.toDouble() : 0.75;

  if (numVal == null || numVal <= 0) {
    return const ConfidenceBadgeMeta(
      percentText: '0%',
      tone: 'rose',
      label: 'Cần kiểm tra tay',
      isUncertain: true,
    );
  }

  final clamped = math.max(0.0, math.min(1.0, numVal.toDouble()));
  final pct = (clamped * 100).round();
  final percentText = '$pct%';

  if (clamped < safeThreshold) {
    return ConfidenceBadgeMeta(
      percentText: percentText,
      tone: 'rose',
      label: 'Độ tin cậy thấp ($percentText)',
      isUncertain: true,
    );
  }

  if (clamped >= math.max(0.88, safeThreshold + 0.1)) {
    return ConfidenceBadgeMeta(
      percentText: percentText,
      tone: 'emerald',
      label: 'Độ tin cậy cao ($percentText)',
      isUncertain: false,
    );
  }

  return ConfidenceBadgeMeta(
    percentText: percentText,
    tone: 'amber',
    label: 'Độ tin cậy khá ($percentText)',
    isUncertain: false,
  );
}

class AiErrorMessage {
  final String code;
  final String title;
  final String guidance;
  final bool canManualFallback;

  const AiErrorMessage({
    required this.code,
    required this.title,
    required this.guidance,
    required this.canManualFallback,
  });
}

AiErrorMessage mapAiErrorToVietnamese(dynamic error) {
  String code = '';
  String serverMessage = '';

  if (error is Map) {
    final respData = (error['response'] is Map) ? error['response']['data'] : null;
    code = (respData is Map ? respData['code'] : null)?.toString() ??
        error['code']?.toString() ??
        ((error['data'] is Map ? error['data']['code'] : null)?.toString() ?? '');

    serverMessage = (respData is Map ? respData['message'] : null)?.toString() ??
        error['message']?.toString() ??
        '';
  } else if (error is String) {
    code = error;
  }

  switch (code) {
    case 'PRIVACY_CONSENT_REQUIRED':
      return const AiErrorMessage(
        code: 'PRIVACY_CONSENT_REQUIRED',
        title: 'Chưa xác nhận xử lý dữ liệu bằng AI',
        guidance: 'Vui lòng tích chọn xác nhận thông báo xử lý dữ liệu cá nhân/hợp đồng bằng AI trước khi bấm trích xuất, hoặc nhập trực tiếp vào biểu mẫu.',
        canManualFallback: false,
      );
    case 'AI_DISABLED':
      return const AiErrorMessage(
        code: 'AI_DISABLED',
        title: 'Trợ lý AI đang tạm tắt (Kill Switch)',
        guidance: 'Quản trị hệ thống đang tạm ngắt AI Gateway. Bạn vẫn có thể tiếp tục nhập và lưu dữ liệu thủ công bình thường.',
        canManualFallback: true,
      );
    case 'AI_TASK_DISABLED':
      return const AiErrorMessage(
        code: 'AI_TASK_DISABLED',
        title: 'Tác vụ AI này đang tạm tắt',
        guidance: 'Tính năng AI cho nghiệp vụ này đang được cấu hình tắt. Vui lòng nhập trực tiếp thông tin vào các ô bên dưới.',
        canManualFallback: true,
      );
    case 'AI_BUDGET_EXCEEDED':
      return const AiErrorMessage(
        code: 'AI_BUDGET_EXCEEDED',
        title: 'Đã chạm trần ngân sách AI trong tháng',
        guidance: 'Tổ chức đã sử dụng hết hạn mức chi phí/token AI của kỳ này. Bạn vui lòng nhập thủ công hoặc liên hệ Quản trị hệ thống nâng hạn mức.',
        canManualFallback: true,
      );
    case 'AI_UNCONFIGURED':
      return const AiErrorMessage(
        code: 'AI_UNCONFIGURED',
        title: 'Máy chủ chưa cấu hình khóa kết nối AI',
        guidance: 'Hệ thống chưa thiết lập GEMINI_API_KEY trên máy chủ Backend. Vui lòng nhập thủ công hoặc báo Quản trị hệ thống kiểm tra môi trường.',
        canManualFallback: true,
      );
    case 'AI_TIMEOUT':
      return const AiErrorMessage(
        code: 'AI_TIMEOUT',
        title: 'Dịch vụ AI phản hồi quá thời gian chờ',
        guidance: 'Kết nối tới Gemini tạm thời chậm hơn bình thường. Bạn có thể bấm thử lại với ảnh rõ nét hơn hoặc nhập trực tiếp không cần chờ AI.',
        canManualFallback: true,
      );
    case 'AI_RATE_LIMIT_EXCEEDED':
    case 'AI_UPSTREAM_RATE_LIMIT':
      return const AiErrorMessage(
        code: 'AI_RATE_LIMIT_EXCEEDED',
        title: 'Tần suất gọi AI đang cao',
        guidance: 'Hệ thống đang giới hạn tốc độ gọi AI để bảo vệ hạn mức. Vui lòng đợi vài giây rồi thử lại hoặc nhập tay.',
        canManualFallback: true,
      );
    default:
      return AiErrorMessage(
        code: code.isNotEmpty ? code : 'AI_ERROR',
        title: 'Không thể xử lý bằng AI lúc này',
        guidance: serverMessage.isNotEmpty
            ? serverMessage
            : 'Hệ thống AI tạm thời gián đoạn. Bạn có thể tiếp tục nhập và lưu dữ liệu thủ công ngay.',
        canManualFallback: true,
      );
  }
}

Map<String, dynamic> createAiFieldTracker(
  String? suggestionId, [
  Map<String, dynamic>? suggestedMap,
  Map<String, dynamic>? fieldConfidences,
]) {
  final Map<String, dynamic> fields = {};
  if (suggestedMap != null) {
    for (final entry in suggestedMap.entries) {
      if (entry.value == null || entry.value.toString().isEmpty) continue;
      final rawConf = fieldConfidences?[entry.key];
      final num? confNum = rawConf is num ? rawConf : num.tryParse(rawConf?.toString() ?? '');
      fields[entry.key] = {
        'active': true,
        'confirmed': false,
        'edited': false,
        'suggestedValue': entry.value.toString(),
        'confidence': confNum?.toDouble(),
      };
    }
  }

  return {
    'suggestionId': suggestionId,
    'fields': fields,
  };
}

Map<String, dynamic> markFieldConfirmedOrEdited(
  Map<String, dynamic>? tracker,
  String fieldKey,
  dynamic newValue,
) {
  if (tracker == null || tracker['fields'] is! Map) return tracker ?? {};
  final fields = Map<String, dynamic>.from(tracker['fields'] as Map);
  if (!fields.containsKey(fieldKey)) return tracker;

  final prevField = Map<String, dynamic>.from(fields[fieldKey] as Map);
  final nextValNorm = newValue?.toString().trim() ?? '';
  final suggNorm = prevField['suggestedValue']?.toString().trim() ?? '';

  fields[fieldKey] = {
    ...prevField,
    'confirmed': true,
    'edited': nextValNorm != suggNorm,
  };

  return {
    ...tracker,
    'fields': fields,
  };
}
