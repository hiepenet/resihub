export const ZALO_ANNOUNCEMENT_TEMPLATES = [
  {
    key: 'UTILITY_INTERRUPTION',
    type: 'UTILITY_INTERRUPTION',
    label: 'Cắt điện / nước tạm thời',
    defaultTitle: 'Thông báo tạm ngừng cấp điện/nước để bảo dưỡng kỹ thuật',
    bodyTemplate:
      'Ban Quản Lý xin thông báo lịch **tạm ngừng cung cấp điện/nước** tại khu vực từ **[GIỜ BẮT ĐẦU]** đến **[GIỜ KẾT THÚC]** ngày **[NGÀY/THÁNG]** để bảo trì hệ thống. Mong Quý Cư dân chủ động sắp xếp sinh hoạt.',
  },
  {
    key: 'MAINTENANCE_NOTICE',
    type: 'MAINTENANCE_NOTICE',
    label: 'Bảo trì thang máy / PCCC định kỳ',
    defaultTitle: 'Thông báo lịch kiểm tra bảo trì hệ thống kỹ thuật & PCCC',
    bodyTemplate:
      'Đội kỹ thuật tòa nhà sẽ tiến hành **kiểm tra định kỳ hệ thống thang máy và chuông báo cháy** vào khung giờ **[KHUNG GIỜ]** ngày **[NGÀY/THÁNG]**. Trong thời gian thử tải có thể phát sinh tiếng chuông ngắn, mong Quý Cư dân thông cảm.',
  },
  {
    key: 'HOUSE_RULES',
    type: 'HOUSE_RULES',
    label: 'Nhắc nhở nội quy chung',
    defaultTitle: 'Nhắc nhở giữ gìn vệ sinh, an ninh & trật tự khu vực chung',
    bodyTemplate:
      'Nhằm đảm bảo môi trường sống văn minh, an toàn cho toàn tòa nhà, BQL đề nghị Quý Cư dân **để xe đúng vị trí quy định**, **phân loại rác đúng giờ** và **giữ yên tĩnh sau 22:00**.',
  },
  {
    key: 'SECURITY_ALERT',
    type: 'SECURITY_ALERT',
    label: 'Cảnh báo an ninh / an toàn',
    defaultTitle: 'Lưu ý tăng cường cảnh giác an ninh & an toàn phòng cháy',
    bodyTemplate:
      'BQL đề nghị Quý Cư dân **khóa cửa cẩn thận** khi ra khỏi phòng, **tắt các thiết bị điện công suất lớn** và **không cho người lạ đi cùng** vào khu vực kiểm soát thẻ từ.',
  },
  {
    key: 'GENERAL_ANNOUNCEMENT',
    type: 'ANNOUNCEMENT',
    label: 'Thông báo chung BQL',
    defaultTitle: 'Thông báo từ Ban Quản Lý tòa nhà',
    bodyTemplate:
      'Ban Quản Lý trân trọng thông báo đến Quý Cư dân nội dung sau: **[NỘI DUNG CHI TIẾT]**. Mọi thắc mắc vui lòng liên hệ BQL để được hỗ trợ kịp thời.',
  },
];

const ZALO_INVITE_REGEX = /^https:\/\/(zalo\.me|chat\.zalo\.me)\/[A-Za-z0-9._/-]+$/;

const TYPE_HEADERS = {
  UTILITY_INTERRUPTION: 'THÔNG BÁO ĐIỆN / NƯỚC',
  MAINTENANCE_NOTICE: 'THÔNG BÁO BẢO TRÌ KỸ THUẬT',
  HOUSE_RULES: 'NHẮC NHỞ NỘI QUY',
  SECURITY_ALERT: 'CẢNH BÁO AN NINH & AN TOÀN',
  ANNOUNCEMENT: 'THÔNG BÁO BQL',
  SYSTEM: 'THÔNG BÁO HỆ THỐNG',
};

const SR_STATUS_LABELS = {
  NEW: 'Mới tiếp nhận',
  ASSIGNED: 'Đã phân công kỹ thuật',
  IN_PROGRESS: 'Đang xử lý',
  ON_HOLD: 'Tạm hoãn / Hẹn lại',
  RESOLVED: 'Đã hoàn tất xử lý (chờ nghiệm thu)',
  REOPENED: 'Đang xử lý lại',
  CLOSED: 'Đã nghiệm thu & đóng phiếu',
  CANCELLED: 'Đã hủy',
};

const PREFERRED_SLOT_VI = {
  MORNING_08_12: 'Sáng (08:00 – 12:00)',
  AFTERNOON_13_17: 'Chiều (13:00 – 17:00)',
  EVENING_18_21: 'Tối (18:00 – 21:00)',
  ANYTIME: 'Linh hoạt cả ngày',
};

const CATEGORY_VI = {
  PLUMBING: 'Cấp thoát nước',
  ELECTRICAL: 'Điện / Chiếu sáng',
  APPLIANCE: 'Thiết bị / Nội thất',
  HVAC: 'Điều hòa / Thông gió',
  FURNITURE: 'Nội thất căn hộ',
  STRUCTURAL: 'Kết cấu / Cửa / Tường',
  INTERNET: 'Internet / Mạng',
  SECURITY: 'Khóa từ / An ninh',
  CLEANING: 'Vệ sinh',
  OTHER: 'Hạng mục khác',
};

function formatVietnamDateTime(value) {
  if (!value) return '';
  const dt = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(dt.getTime())) return '';
  return new Intl.DateTimeFormat('vi-VN', {
    timeZone: 'Asia/Ho_Chi_Minh',
    hour: '2-digit',
    minute: '2-digit',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour12: false,
  }).format(dt);
}

function resolveHotline(contactConfig) {
  if (!contactConfig || typeof contactConfig !== 'object') return '';
  return String(
    contactConfig.support_hotline ||
      contactConfig.technical_hotline ||
      contactConfig.hotline ||
      contactConfig.phone ||
      ''
  ).trim();
}

/**
 * Validate Zalo group invite URL against strict HTTPS zalo.me / chat.zalo.me allowlist.
 */
export function validateZaloInviteLink(rawUrl) {
  if (rawUrl === undefined || rawUrl === null) {
    return { valid: true, normalized: null };
  }
  const trimmed = String(rawUrl).trim();
  if (!trimmed) {
    return { valid: true, normalized: null };
  }

  if (!ZALO_INVITE_REGEX.test(trimmed) || trimmed.includes('..')) {
    return {
      valid: false,
      normalized: null,
      code: 'INVALID_ZALO_LINK',
      message: 'Link nhóm Zalo phải bắt đầu bằng https://zalo.me/ hoặc https://chat.zalo.me/.',
    };
  }

  return { valid: true, normalized: trimmed };
}

/**
 * Deterministic Vietnamese formatter for pasting announcements into Building/Room Zalo groups (FR-069).
 * Wraps key operational fields in **...** for Rich Text bold copy on Zalo PC/Web.
 *
 * FIX BP-010: Phát hiện placeholder chưa được thay thế trong title/body và log warning.
 * Placeholder pattern: [TEXT IN BRACKETS] — ví dụ: [NỘI DUNG CHI TIẾT], [TÊN CƯ DÂN]
 */
const PLACEHOLDER_RE = /\[[^\]]{2,50}\]/;

export function formatAnnouncementForZalo({
  type = 'ANNOUNCEMENT',
  title = '',
  body = '',
  targetScope = 'BUILDING',
  buildingCode = '',
  buildingName = '',
  floorName = '',
  apartmentCode = '',
  contactConfig = {},
  scheduledOrSentAt = null,
} = {}) {
  const scope = String(targetScope || 'BUILDING').trim().toUpperCase();
  const codeOrName = String(buildingCode || buildingName || 'RESIHUB').trim();
  const typeKey = String(type || 'ANNOUNCEMENT').trim().toUpperCase();
  const typeBadge = TYPE_HEADERS[typeKey] || 'THÔNG BÁO BQL';

  // FIX BP-010: cảnh báo nếu caller truyền placeholder chưa replace
  const rawTitle = String(title || '').trim();
  const rawBody = String(body || '').trim();
  if (PLACEHOLDER_RE.test(rawTitle) || PLACEHOLDER_RE.test(rawBody)) {
    console.warn(
      '[formatAnnouncementForZalo] WARNING: Nội dung thông báo còn chứa placeholder chưa được thay thế.',
      { title: rawTitle, body: rawBody }
    );
  }

  const header = `**[THÔNG BÁO BQL TÒA ${codeOrName}]**`;

  let greeting = `Kính gửi Quý Cư dân **Tòa ${buildingName || codeOrName}**,`;
  if (scope === 'APARTMENT' && apartmentCode) {
    greeting = `Kính gửi Anh/Chị Cư dân **Phòng ${apartmentCode}**${buildingCode ? ` (**Tòa ${buildingCode}**)` : ''},`;
  } else if (scope === 'FLOOR' && floorName) {
    greeting = `Kính gửi Quý Cư dân **${floorName}**${buildingCode ? ` — **Tòa ${buildingCode}**` : ''},`;
  }

  const lines = [header];
  if (typeKey !== 'ANNOUNCEMENT') {
    lines.push(`🔔 Phân loại: **${typeBadge}**`);
  }
  if (rawTitle) {
    lines.push(`📌 **${rawTitle}**`);
  }
  lines.push('');
  lines.push(greeting);
  if (rawBody) {
    lines.push(rawBody);
  }

  const tsText = formatVietnamDateTime(scheduledOrSentAt);
  const hotline = resolveHotline(contactConfig);
  lines.push('');
  if (tsText) {
    lines.push(`🕒 Thời gian phát hành: **${tsText}**`);
  }
  if (hotline) {
    lines.push(`📞 Hotline hỗ trợ kỹ thuật/BQL: **${hotline}**`);
  }
  lines.push(`Trân trọng, **Ban Quản Lý Tòa ${codeOrName}**.`);

  return lines.join('\n');
}

/**
 * Format a single apartment's service request status/resolution for pasting into the room's Zalo group.
 * Wraps key operational fields in **...** for Rich Text bold copy on Zalo PC/Web.
 */
export function formatServiceRequestForRoomZalo({
  trackingCode = '',
  category = '',
  title = '',
  status = 'NEW',
  apartmentCode = '',
  buildingCode = '',
  preferredSlot = '',
  holdReason = '',
  nextAppointmentAt = null,
  resolutionNote = '',
  assigneeName = '',
  contactConfig = {},
} = {}) {
  const roomLabel = apartmentCode ? `Phòng ${apartmentCode}` : 'Căn hộ';
  const bldgSuffix = buildingCode ? ` — Tòa ${buildingCode}` : '';
  const statusUpper = String(status || 'NEW').trim().toUpperCase();
  const catUpper = String(category || '').trim().toUpperCase();

  const lines = [
    `**[CẬP NHẬT KỸ THUẬT — ${roomLabel}${bldgSuffix}]**`,
    `Kính gửi Anh/Chị Cư dân **${roomLabel}**,`,
    `• Mã yêu cầu: **${trackingCode || 'Đang cập nhật'}**`,
    `• Hạng mục: **${CATEGORY_VI[catUpper] || category || 'Sửa chữa kỹ thuật'}**${title ? ` — ${title}` : ''}`,
    `• Trạng thái hiện tại: **${SR_STATUS_LABELS[statusUpper] || statusUpper}**`,
  ];

  if (assigneeName) {
    lines.push(`• Nhân sự phụ trách: **${assigneeName}**`);
  }
  if (preferredSlot) {
    lines.push(`• Khung giờ cư dân đăng ký: **${PREFERRED_SLOT_VI[preferredSlot] || preferredSlot}**`);
  }
  if (holdReason) {
    lines.push(`• Lý do tạm hoãn / hẹn lại: **${String(holdReason).trim()}**`);
  }
  const apptText = formatVietnamDateTime(nextAppointmentAt);
  if (apptText) {
    lines.push(`• Lịch hẹn xử lý tiếp theo: **${apptText}**`);
  }
  if (resolutionNote) {
    lines.push(`• Phản hồi từ BQL/Kỹ thuật: **${String(resolutionNote).trim()}**`);
  }

  const hotline = resolveHotline(contactConfig);
  lines.push('');
  if (hotline) {
    lines.push(`📞 Cần hỗ trợ thêm vui lòng liên hệ Hotline BQL: **${hotline}**`);
  }
  lines.push('Vui lòng mở Cổng Cư dân ResiHub để xem hình ảnh chi tiết hoặc nghiệm thu yêu cầu.');

  return lines.join('\n');
}
