export const ZALO_QUICK_TEMPLATES = [
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
const BOLD_MARKER_REGEX = /\*\*([^\n]+?)\*\*/g;

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

const SR_CATEGORY_LABELS = {
  ELECTRICAL: 'Điện chiếu sáng / Ổ cắm',
  PLUMBING: 'Cấp thoát nước',
  HVAC: 'Điều hòa / Thông gió',
  FURNITURE: 'Nội thất căn hộ',
  APPLIANCE: 'Thiết bị gia dụng',
  CLEANING: 'Vệ sinh môi trường',
  SECURITY: 'An ninh / Khóa cửa',
  OTHER: 'Hạng mục khác',
};

const OPEN_SR_STATUSES = ['NEW', 'ASSIGNED', 'IN_PROGRESS', 'ON_HOLD', 'REOPENED'];

function formatVnDateTimeShort(value) {
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

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Parses **bold** markers into safe { text, bold } segments for React rendering & clipboard conversion.
 * Unclosed ** or single * are preserved verbatim without dropping text.
 */
export function parseZaloBoldSegments(text) {
  const input = String(text ?? '');
  if (!input) return [];

  const segments = [];
  let lastIndex = 0;

  for (const match of input.matchAll(BOLD_MARKER_REGEX)) {
    const matchIndex = match.index ?? 0;
    if (matchIndex > lastIndex) {
      segments.push({ text: input.slice(lastIndex, matchIndex), bold: false });
    }
    segments.push({ text: match[1], bold: true });
    lastIndex = matchIndex + match[0].length;
  }

  if (lastIndex < input.length) {
    segments.push({ text: input.slice(lastIndex), bold: false });
  }

  return segments;
}

/**
 * Strips matched **...** markers for clean text/plain clipboard fallback.
 */
export function stripZaloBoldMarkers(text) {
  return parseZaloBoldSegments(text)
    .map((seg) => seg.text)
    .join('');
}

/**
 * Converts a Zalo message with **...** markers into escaped HTML (<b>...</b> + <br>) for Zalo PC/Web.
 */
export function zaloTextToHtml(text) {
  const normalized = String(text ?? '').replace(/\r\n/g, '\n');
  if (!normalized) return '';

  return normalized
    .split('\n')
    .map((line) =>
      parseZaloBoldSegments(line)
        .map((seg) => (seg.bold ? `<b>${escapeHtml(seg.text)}</b>` : escapeHtml(seg.text)))
        .join('')
    )
    .join('<br>');
}

export function isValidZaloGroupUrl(rawUrl) {
  if (rawUrl === undefined || rawUrl === null) return true;
  const trimmed = String(rawUrl).trim();
  if (!trimmed) return true;
  if (!ZALO_INVITE_REGEX.test(trimmed) || trimmed.includes('..')) {
    return false;
  }
  return true;
}

export function buildZaloPreviewText({
  type = 'ANNOUNCEMENT',
  title = '',
  body = '',
  targetScope = 'BUILDING',
  buildingCode = '',
  buildingName = '',
  floorName = '',
  apartmentCode = '',
  hotline = '',
  scheduledOrSentAt = null,
} = {}) {
  const scope = String(targetScope || 'BUILDING').trim().toUpperCase();
  const codeOrName = String(buildingCode || buildingName || 'RESIHUB').trim();
  const typeBadge = TYPE_HEADERS[String(type || 'ANNOUNCEMENT').toUpperCase()] || 'THÔNG BÁO BQL';
  const header = `**[THÔNG BÁO BQL TÒA ${codeOrName}]**`;

  let greeting = `Kính gửi Quý Cư dân **Tòa ${buildingName || codeOrName}**,`;
  if (scope === 'APARTMENT' && apartmentCode) {
    greeting = `Kính gửi Anh/Chị Cư dân **Phòng ${apartmentCode}**${buildingCode ? ` (**Tòa ${buildingCode}**)` : ''},`;
  } else if (scope === 'FLOOR' && floorName) {
    greeting = `Kính gửi Quý Cư dân **${floorName}** — **Tòa ${buildingName || codeOrName}**,`;
  }

  const lines = [
    header,
    `📌 Phân loại: **${typeBadge}**`,
    greeting,
    '',
    `🔹 **${String(title || '(Chưa nhập tiêu đề)').trim()}**`,
    String(body || '(Chưa nhập nội dung)').trim(),
  ];

  const tsStr = formatVnDateTimeShort(scheduledOrSentAt);
  if (tsStr) {
    lines.push('', `🕒 Thời điểm ghi nhận: **${tsStr}**`);
  }
  if (String(hotline || '').trim()) {
    lines.push(`☎️ Hotline hỗ trợ BQL: **${String(hotline).trim()}**`);
  }
  lines.push('', 'Trân trọng — **Ban Quản Lý vận hành trên ResiHub**.');
  return lines.join('\n');
}

/**
 * Formats a safe Zalo room update message for a service request — NEVER includes internal_note.
 */
export function buildRoomMaintenanceZaloText(detail = {}) {
  if (!detail || typeof detail !== 'object') return '';
  if (detail.zalo_room_message_preview) {
    return detail.zalo_room_message_preview;
  }
  const codeLabel = detail.building_code || detail.building_name || 'RESIHUB';
  const aptLabel = detail.apartment_code || 'N/A';
  const statusLabel = SR_STATUS_LABELS[String(detail.status || 'NEW').toUpperCase()] || detail.status;
  const catLabel = SR_CATEGORY_LABELS[String(detail.category || 'OTHER').toUpperCase()] || detail.category;

  const lines = [
    `**[BQL TÒA ${codeLabel} — CẬP NHẬT SỬA CHỮA PHÒNG ${aptLabel}]**`,
    `🔧 Mã yêu cầu: **#${detail.tracking_code || ''}**`,
    `📂 Hạng mục: **${catLabel}**${detail.title ? ` — ${detail.title}` : ''}`,
    `📍 Trạng thái: **${statusLabel}**`,
  ];

  if (detail.assigned_to_name) {
    lines.push(`👷 Phụ trách xử lý: **${detail.assigned_to_name}**`);
  }
  if (detail.hold_reason) {
    lines.push(`⏸️ Lý do tạm hoãn / hẹn lại: **${detail.hold_reason}**`);
  }
  if (detail.next_appointment_at) {
    lines.push(`📅 Lịch hẹn xử lý tiếp theo: **${formatVnDateTimeShort(detail.next_appointment_at)}**`);
  }
  if (detail.resolution_note) {
    lines.push(`✅ Kết quả xử lý: **${detail.resolution_note}**`);
  }
  lines.push('', 'Quý Cư dân có thể xem ảnh nghiệm thu & đánh giá trên Cổng cư dân ResiHub.');
  return lines.join('\n');
}

export function computeSlaBadgeMeta({
  status = 'NEW',
  slaDueAt = null,
  slaBreachedAt = null,
  now = new Date(),
} = {}) {
  const normStatus = String(status || '').trim().toUpperCase();

  if (['RESOLVED', 'CLOSED'].includes(normStatus)) {
    return {
      state: 'COMPLETED',
      label: slaBreachedAt ? 'Hoàn thành (Trễ SLA)' : 'Đã xử lý đúng SLA',
      variant: slaBreachedAt ? 'amber' : 'emerald',
    };
  }

  if (normStatus === 'CANCELLED') {
    return {
      state: 'COMPLETED',
      label: 'Đã hủy',
      variant: 'slate',
    };
  }

  if (!OPEN_SR_STATUSES.includes(normStatus) || !slaDueAt) {
    return {
      state: 'ON_TRACK',
      label: 'Đang theo dõi SLA',
      variant: 'sky',
    };
  }

  const dueDt = slaDueAt instanceof Date ? slaDueAt : new Date(slaDueAt);
  const nowDt = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(dueDt.getTime()) || Number.isNaN(nowDt.getTime())) {
    return {
      state: 'ON_TRACK',
      label: 'Đang theo dõi SLA',
      variant: 'sky',
    };
  }

  const diffMs = dueDt.getTime() - nowDt.getTime();
  const diffMins = Math.round(diffMs / 60000);

  if (diffMs < 0 || slaBreachedAt) {
    const lateMins = Math.abs(diffMins);
    const lateText =
      lateMins >= 60 ? `${Math.floor(lateMins / 60)}h${lateMins % 60 > 0 ? `${lateMins % 60}p` : ''}` : `${lateMins}p`;
    return {
      state: 'OVERDUE',
      label: `Quá hạn SLA (${lateText})`,
      variant: 'red',
    };
  }

  if (diffMins <= 60) {
    return {
      state: 'DUE_SOON',
      label: `Sắp hết hạn SLA (còn ${Math.max(1, diffMins)}p)`,
      variant: 'amber',
    };
  }

  const hoursLeft = Math.floor(diffMins / 60);
  return {
    state: 'ON_TRACK',
    label: `Còn ${hoursLeft}h hạn SLA`,
    variant: 'emerald',
  };
}

export async function copyTextToClipboard(text) {
  const value = String(text ?? '');
  if (!value) return false;

  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch {
      // Fallback below
    }
  }

  if (typeof document !== 'undefined') {
    try {
      const textarea = document.createElement('textarea');
      textarea.value = value;
      textarea.setAttribute('readonly', '');
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      textarea.style.pointerEvents = 'none';
      document.body.appendChild(textarea);
      textarea.focus();
      textarea.select();
      const copied = document.execCommand('copy');
      document.body.removeChild(textarea);
      return Boolean(copied);
    } catch {
      return false;
    }
  }

  return false;
}

/**
 * Copies a Zalo message with Rich Text HTML (<b>...</b> + <br>) for Zalo PC/Web
 * alongside stripped text/plain so raw ** markers never leak on plain paste.
 */
export async function copyZaloMessageToClipboard(text) {
  const raw = String(text ?? '');
  if (!raw) return false;

  const plainText = stripZaloBoldMarkers(raw);
  const htmlText = zaloTextToHtml(raw);

  if (
    typeof ClipboardItem !== 'undefined' &&
    typeof Blob !== 'undefined' &&
    typeof navigator !== 'undefined' &&
    typeof navigator.clipboard?.write === 'function'
  ) {
    try {
      const item = new ClipboardItem({
        'text/html': new Blob([htmlText], { type: 'text/html' }),
        'text/plain': new Blob([plainText], { type: 'text/plain' }),
      });
      await navigator.clipboard.write([item]);
      return true;
    } catch {
      // Fall through to contenteditable / plain text fallback
    }
  }

  if (typeof document !== 'undefined' && typeof window !== 'undefined' && window.getSelection) {
    try {
      const container = document.createElement('div');
      container.setAttribute('contenteditable', 'true');
      container.innerHTML = htmlText;
      container.style.position = 'fixed';
      container.style.left = '-9999px';
      container.style.top = '0';
      container.style.opacity = '0';
      container.style.pointerEvents = 'none';
      container.style.whiteSpace = 'pre-wrap';
      document.body.appendChild(container);

      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(container);
      selection.removeAllRanges();
      selection.addRange(range);

      const copied = document.execCommand('copy');
      selection.removeAllRanges();
      document.body.removeChild(container);
      if (copied) return true;
    } catch {
      // Fall through to plain text fallback
    }
  }

  return copyTextToClipboard(plainText);
}
