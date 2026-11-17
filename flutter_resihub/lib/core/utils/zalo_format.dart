import 'dart:math';
import 'format.dart';
import 'zalo_clipboard_stub.dart'
    if (dart.library.js_interop) 'zalo_clipboard_web.dart';

/// Mẫu thông báo Zalo soạn sẵn cho Ban Quản Lý.
class ZaloQuickTemplate {
  final String key;
  final String type;
  final String label;
  final String defaultTitle;
  final String bodyTemplate;

  const ZaloQuickTemplate({
    required this.key,
    required this.type,
    required this.label,
    required this.defaultTitle,
    required this.bodyTemplate,
  });
}

const List<ZaloQuickTemplate> kZaloQuickTemplates = [
  ZaloQuickTemplate(
    key: 'UTILITY_INTERRUPTION',
    type: 'UTILITY_INTERRUPTION',
    label: 'Cắt điện / nước tạm thời',
    defaultTitle: 'Thông báo tạm ngừng cấp điện/nước để bảo dưỡng kỹ thuật',
    bodyTemplate:
        'Ban Quản Lý xin thông báo lịch **tạm ngừng cung cấp điện/nước** tại khu vực từ **[GIỜ BẮT ĐẦU]** đến **[GIỜ KẾT THÚC]** ngày **[NGÀY/THÁNG]** để bảo trì hệ thống. Mong Quý Cư dân chủ động sắp xếp sinh hoạt.',
  ),
  ZaloQuickTemplate(
    key: 'MAINTENANCE_NOTICE',
    type: 'MAINTENANCE_NOTICE',
    label: 'Bảo trì thang máy / PCCC định kỳ',
    defaultTitle: 'Thông báo lịch kiểm tra bảo trì hệ thống kỹ thuật & PCCC',
    bodyTemplate:
        'Đội kỹ thuật tòa nhà sẽ tiến hành **kiểm tra định kỳ hệ thống thang máy và chuông báo cháy** vào khung giờ **[KHUNG GIỜ]** ngày **[NGÀY/THÁNG]**. Trong thời gian thử tải có thể phát sinh tiếng chuông ngắn, mong Quý Cư dân thông cảm.',
  ),
  ZaloQuickTemplate(
    key: 'HOUSE_RULES',
    type: 'HOUSE_RULES',
    label: 'Nhắc nhở nội quy chung',
    defaultTitle: 'Nhắc nhở giữ gìn vệ sinh, an ninh & trật tự khu vực chung',
    bodyTemplate:
        'Nhằm đảm bảo môi trường sống văn minh, an toàn cho toàn tòa nhà, BQL đề nghị Quý Cư dân **để xe đúng vị trí quy định**, **phân loại rác đúng giờ** và **giữ yên tĩnh sau 22:00**.',
  ),
  ZaloQuickTemplate(
    key: 'SECURITY_ALERT',
    type: 'SECURITY_ALERT',
    label: 'Cảnh báo an ninh / an toàn',
    defaultTitle: 'Lưu ý tăng cường cảnh giác an ninh & an toàn phòng cháy',
    bodyTemplate:
        'BQL đề nghị Quý Cư dân **khóa cửa cẩn thận** khi ra khỏi phòng, **tắt các thiết bị điện công suất lớn** và **không cho người lạ đi cùng** vào khu vực kiểm soát thẻ từ.',
  ),
  ZaloQuickTemplate(
    key: 'GENERAL_ANNOUNCEMENT',
    type: 'ANNOUNCEMENT',
    label: 'Thông báo chung BQL',
    defaultTitle: 'Thông báo từ Ban Quản Lý tòa nhà',
    bodyTemplate:
        'Ban Quản Lý trân trọng thông báo đến Quý Cư dân nội dung sau: **[NỘI DUNG CHI TIẾT]**. Mọi thắc mắc vui lòng liên hệ BQL để được hỗ trợ kịp thời.',
  ),
];

final _zaloInviteRegex = RegExp(r'^https:\/\/(zalo\.me|chat\.zalo\.me)\/[A-Za-z0-9._/-]+$');
final _boldMarkerRegex = RegExp(r'\*\*([^\n]+?)\*\*');

const Map<String, String> _kTypeHeaders = {
  'UTILITY_INTERRUPTION': 'THÔNG BÁO ĐIỆN / NƯỚC',
  'MAINTENANCE_NOTICE': 'THÔNG BÁO BẢO TRÌ KỸ THUẬT',
  'HOUSE_RULES': 'NHẮC NHỞ NỘI QUY',
  'SECURITY_ALERT': 'CẢNH BÁO AN NINH & AN TOÀN',
  'ANNOUNCEMENT': 'THÔNG BÁO BQL',
  'SYSTEM': 'THÔNG BÁO HỆ THỐNG',
};

const Map<String, String> _kSrStatusLabels = {
  'NEW': 'Mới tiếp nhận',
  'ASSIGNED': 'Đã phân công kỹ thuật',
  'IN_PROGRESS': 'Đang xử lý',
  'ON_HOLD': 'Tạm hoãn / Hẹn lại',
  'RESOLVED': 'Đã hoàn tất xử lý (chờ nghiệm thu)',
  'REOPENED': 'Đang xử lý lại',
  'CLOSED': 'Đã nghiệm thu & đóng phiếu',
  'CANCELLED': 'Đã hủy',
};

const Map<String, String> _kSrCategoryLabels = {
  'ELECTRICAL': 'Điện chiếu sáng / Ổ cắm',
  'PLUMBING': 'Cấp thoát nước',
  'HVAC': 'Điều hòa / Thông gió',
  'FURNITURE': 'Nội thất căn hộ',
  'APPLIANCE': 'Thiết bị gia dụng',
  'CLEANING': 'Vệ sinh môi trường',
  'SECURITY': 'An ninh / Khóa cửa',
  'OTHER': 'Hạng mục khác',
};

const Set<String> _kOpenSrStatuses = {'NEW', 'ASSIGNED', 'IN_PROGRESS', 'ON_HOLD', 'REOPENED'};

String _escapeHtml(dynamic value) {
  return (value?.toString() ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
}

/// Đoạn văn bản kèm cờ in đậm `**bold**`.
class ZaloBoldSegment {
  final String text;
  final bool bold;

  const ZaloBoldSegment({required this.text, required this.bold});
}

/// Tách văn bản chứa `**...**` thành các đoạn `ZaloBoldSegment`.
List<ZaloBoldSegment> parseZaloBoldSegments(String? text) {
  final input = text ?? '';
  if (input.isEmpty) return [];

  final segments = <ZaloBoldSegment>[];
  var lastIndex = 0;

  for (final match in _boldMarkerRegex.allMatches(input)) {
    if (match.start > lastIndex) {
      segments.add(ZaloBoldSegment(text: input.substring(lastIndex, match.start), bold: false));
    }
    segments.add(ZaloBoldSegment(text: match.group(1)!, bold: true));
    lastIndex = match.end;
  }

  if (lastIndex < input.length) {
    segments.add(ZaloBoldSegment(text: input.substring(lastIndex), bold: false));
  }

  return segments;
}

/// Loại bỏ các dấu `**` in đậm để trả về plain text sạch.
String stripZaloBoldMarkers(String? text) {
  return parseZaloBoldSegments(text).map((seg) => seg.text).join();
}

/// Chuyển đổi cú pháp `**in đậm**` thành thẻ `<b>` HTML và xuống dòng thành `<br>` cho Zalo Web/PC.
String zaloTextToHtml(String? text) {
  final normalized = (text ?? '').replaceAll('\r\n', '\n');
  if (normalized.isEmpty) return '';

  return normalized.split('\n').map((line) {
    return parseZaloBoldSegments(line).map((seg) {
      return seg.bold ? '<b>${_escapeHtml(seg.text)}</b>' : _escapeHtml(seg.text);
    }).join();
  }).join('<br>');
}

/// Kiểm tra liên kết nhóm Zalo hợp lệ (`zalo.me/...` hoặc `chat.zalo.me/...`).
bool isValidZaloGroupUrl(String? rawUrl) {
  if (rawUrl == null) return true;
  final trimmed = rawUrl.trim();
  if (trimmed.isEmpty) return true;
  if (!_zaloInviteRegex.hasMatch(trimmed) || trimmed.contains('..')) {
    return false;
  }
  return true;
}

/// Tạo nội dung xem trước tin nhắn Zalo gửi cư dân.
String buildZaloPreviewText({
  String type = 'ANNOUNCEMENT',
  String title = '',
  String body = '',
  String targetScope = 'BUILDING',
  String buildingCode = '',
  String buildingName = '',
  String floorName = '',
  String apartmentCode = '',
  String hotline = '',
  dynamic scheduledOrSentAt,
}) {
  final scope = targetScope.trim().toUpperCase();
  final codeOrName = (buildingCode.isNotEmpty ? buildingCode : (buildingName.isNotEmpty ? buildingName : 'RESIHUB')).trim();
  final typeBadge = _kTypeHeaders[type.toUpperCase()] ?? 'THÔNG BÁO BQL';
  final header = '**[THÔNG BÁO BQL TÒA $codeOrName]**';

  var greeting = 'Kính gửi Quý Cư dân **Tòa ${buildingName.isNotEmpty ? buildingName : codeOrName}**,';
  if (scope == 'APARTMENT' && apartmentCode.isNotEmpty) {
    final bldgSuffix = buildingCode.isNotEmpty ? ' (**Tòa $buildingCode**)' : '';
    greeting = 'Kính gửi Anh/Chị Cư dân **Phòng $apartmentCode**$bldgSuffix,';
  } else if (scope == 'FLOOR' && floorName.isNotEmpty) {
    greeting = 'Kính gửi Quý Cư dân **$floorName** — **Tòa ${buildingName.isNotEmpty ? buildingName : codeOrName}**,';
  }

  final lines = [
    header,
    '📌 Phân loại: **$typeBadge**',
    greeting,
    '',
    '🔹 **${(title.isNotEmpty ? title : '(Chưa nhập tiêu đề)').trim()}**',
    (body.isNotEmpty ? body : '(Chưa nhập nội dung)').trim(),
  ];

  if (scheduledOrSentAt != null) {
    final tsStr = formatDateTime(scheduledOrSentAt);
    if (tsStr != '—' && tsStr.isNotEmpty) {
      lines.addAll(['', '🕒 Thời điểm ghi nhận: **$tsStr**']);
    }
  }

  if (hotline.trim().isNotEmpty) {
    lines.add('☎️ Hotline hỗ trợ BQL: **${hotline.trim()}**');
  }

  lines.addAll(['', 'Trân trọng — **Ban Quản Lý vận hành trên ResiHub**.']);
  return lines.join('\n');
}

/// Định dạng tin nhắn cập nhật sửa chữa phòng cho nhóm Zalo.
///
/// TUYỆT ĐỐI KHÔNG BAO GIỜ hiển thị trường `internal_note` bảo mật ra tin nhắn!
String buildRoomMaintenanceZaloText(Map<String, dynamic>? detail) {
  if (detail == null) return '';
  if (detail['zalo_room_message_preview'] != null) {
    return detail['zalo_room_message_preview'].toString();
  }

  final codeLabel = detail['building_code'] ?? detail['building_name'] ?? 'RESIHUB';
  final aptLabel = detail['apartment_code'] ?? 'N/A';
  final statusRaw = (detail['status']?.toString() ?? 'NEW').toUpperCase();
  final statusLabel = _kSrStatusLabels[statusRaw] ?? detail['status'] ?? '';
  final catRaw = (detail['category']?.toString() ?? 'OTHER').toUpperCase();
  final catLabel = _kSrCategoryLabels[catRaw] ?? detail['category'] ?? '';

  final lines = [
    '**[BQL TÒA $codeLabel — CẬP NHẬT SỬA CHỮA PHÒNG $aptLabel]**',
    '🔧 Mã yêu cầu: **#${detail['tracking_code'] ?? ''}**',
    '📂 Hạng mục: **$catLabel**${detail['title'] != null && detail['title'].toString().isNotEmpty ? ' — ${detail['title']}' : ''}',
    '📍 Trạng thái: **$statusLabel**',
  ];

  if (detail['assigned_to_name'] != null && detail['assigned_to_name'].toString().isNotEmpty) {
    lines.add('👷 Phụ trách xử lý: **${detail['assigned_to_name']}**');
  }
  if (detail['hold_reason'] != null && detail['hold_reason'].toString().isNotEmpty) {
    lines.add('⏸️ Lý do tạm hoãn / hẹn lại: **${detail['hold_reason']}**');
  }
  if (detail['next_appointment_at'] != null) {
    final dtStr = formatDateTime(detail['next_appointment_at']);
    if (dtStr != '—' && dtStr.isNotEmpty) {
      lines.add('📅 Lịch hẹn xử lý tiếp theo: **$dtStr**');
    }
  }
  if (detail['resolution_note'] != null && detail['resolution_note'].toString().isNotEmpty) {
    lines.add('✅ Kết quả xử lý: **${detail['resolution_note']}**');
  }

  lines.addAll(['', 'Quý Cư dân có thể xem ảnh nghiệm thu & đánh giá trên Cổng cư dân ResiHub.']);
  return lines.join('\n');
}

/// Metadata trạng thái SLA cho badge hiển thị.
class SlaBadgeMeta {
  final String state; // 'COMPLETED' | 'ON_TRACK' | 'DUE_SOON' | 'OVERDUE'
  final String label;
  final String variant; // 'amber' | 'emerald' | 'slate' | 'sky' | 'red'

  const SlaBadgeMeta({
    required this.state,
    required this.label,
    required this.variant,
  });
}

/// Tính toán thông tin hiển thị huy hiệu SLA dựa trên thời hạn và trạng thái phiếu.
SlaBadgeMeta computeSlaBadgeMeta({
  String status = 'NEW',
  dynamic slaDueAt,
  dynamic slaBreachedAt,
  DateTime? now,
}) {
  final normStatus = status.trim().toUpperCase();

  if (normStatus == 'RESOLVED' || normStatus == 'CLOSED') {
    return SlaBadgeMeta(
      state: 'COMPLETED',
      label: slaBreachedAt != null ? 'Hoàn thành (Trễ SLA)' : 'Đã xử lý đúng SLA',
      variant: slaBreachedAt != null ? 'amber' : 'emerald',
    );
  }

  if (normStatus == 'CANCELLED') {
    return const SlaBadgeMeta(
      state: 'COMPLETED',
      label: 'Đã hủy',
      variant: 'slate',
    );
  }

  if (!_kOpenSrStatuses.contains(normStatus) || slaDueAt == null) {
    return const SlaBadgeMeta(
      state: 'ON_TRACK',
      label: 'Đang theo dõi SLA',
      variant: 'sky',
    );
  }

  final dueDt = slaDueAt is DateTime ? slaDueAt : DateTime.tryParse(slaDueAt.toString());
  final nowDt = now ?? DateTime.now();

  if (dueDt == null) {
    return const SlaBadgeMeta(
      state: 'ON_TRACK',
      label: 'Đang theo dõi SLA',
      variant: 'sky',
    );
  }

  final diffMs = dueDt.millisecondsSinceEpoch - nowDt.millisecondsSinceEpoch;
  final diffMins = (diffMs / 60000).round();

  if (diffMs < 0 || slaBreachedAt != null) {
    final lateMins = diffMins.abs();
    final lateText = lateMins >= 60
        ? '${lateMins ~/ 60}h${lateMins % 60 > 0 ? '${lateMins % 60}p' : ''}'
        : '${lateMins}p';
    return SlaBadgeMeta(
      state: 'OVERDUE',
      label: 'Quá hạn SLA ($lateText)',
      variant: 'red',
    );
  }

  if (diffMins <= 60) {
    return SlaBadgeMeta(
      state: 'DUE_SOON',
      label: 'Sắp hết hạn SLA (còn ${max(1, diffMins)}p)',
      variant: 'amber',
    );
  }

  final hoursLeft = diffMins ~/ 60;
  return SlaBadgeMeta(
    state: 'ON_TRACK',
    label: 'Còn ${hoursLeft}h hạn SLA',
    variant: 'emerald',
  );
}

/// Sao chép tin nhắn Zalo kèm định dạng Rich Text HTML (đậm `<b>`, xuống dòng `<br>`)
/// đồng thời kèm plain text sạch để không lộ dấu `**` khi dán.
Future<bool> copyZaloRichText(String text) => copyZaloRichTextPlatform(text);
