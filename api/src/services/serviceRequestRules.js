import { todayVietnamYmd } from './serviceBilling.js';

export const SERVICE_REQUEST_OPEN_STATUSES = [
  'NEW',
  'ASSIGNED',
  'IN_PROGRESS',
  'ON_HOLD',
  'REOPENED',
];

export const PREFERRED_SLOT_CODES = [
  'MORNING_08_12',
  'AFTERNOON_13_17',
  'EVENING_18_21',
  'ANYTIME',
];

const MANAGER_ALLOWED_TRANSITIONS = {
  NEW: ['NEW', 'ASSIGNED', 'IN_PROGRESS', 'ON_HOLD', 'RESOLVED', 'CANCELLED'],
  ASSIGNED: ['ASSIGNED', 'IN_PROGRESS', 'ON_HOLD', 'RESOLVED', 'CANCELLED'],
  IN_PROGRESS: ['ASSIGNED', 'IN_PROGRESS', 'ON_HOLD', 'RESOLVED', 'CANCELLED'],
  ON_HOLD: ['ASSIGNED', 'IN_PROGRESS', 'ON_HOLD', 'RESOLVED', 'CANCELLED'],
  REOPENED: ['ASSIGNED', 'IN_PROGRESS', 'ON_HOLD', 'RESOLVED', 'REOPENED', 'CANCELLED'],
  RESOLVED: ['RESOLVED', 'CLOSED'],
  CLOSED: [],
  CANCELLED: [],
};

function toPositiveHours(value, fallback) {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? num : fallback;
}

/**
 * Build Vietnam-timezone tracking prefix 'SR-YYYYMMDD-' (AC-004.1).
 */
export function buildServiceRequestTrackingPrefix(now = new Date()) {
  const ymd = todayVietnamYmd(now).replace(/-/g, '');
  return `SR-${ymd}-`;
}

/**
 * Compute SLA response and resolution deadlines based on org sla_config.
 */
export function computeServiceRequestSlaDeadlines({
  createdAt,
  priority = 'NORMAL',
  slaConfig = {},
} = {}) {
  const baseDate =
    createdAt instanceof Date && !Number.isNaN(createdAt.getTime())
      ? createdAt
      : new Date(createdAt || Date.now());
  const safeBase = Number.isNaN(baseDate.getTime()) ? new Date() : baseDate;

  const responseHours = toPositiveHours(slaConfig?.response_hours, 2);
  const urgentResolveHours = toPositiveHours(slaConfig?.urgent_resolve_hours, 4);
  const normalResolveHours = toPositiveHours(slaConfig?.normal_resolve_hours, 24);

  const normPriority = String(priority || 'NORMAL').trim().toUpperCase();
  const resolveHours = normPriority === 'URGENT' ? urgentResolveHours : normalResolveHours;

  const slaResponseDueAt = new Date(safeBase.getTime() + responseHours * 3600 * 1000);
  const slaDueAt = new Date(safeBase.getTime() + resolveHours * 3600 * 1000);

  return {
    slaResponseDueAt,
    slaDueAt,
    responseHours,
    resolveHours,
  };
}

/**
 * Return true when an existing service request in the same apartment + category
 * is still open and was created within windowHours (default 24h) (AC-004.2).
 */
export function isWithinDuplicateWindow({
  existingCreatedAt,
  existingStatus,
  now = new Date(),
  windowHours = 24,
} = {}) {
  const statusNorm = String(existingStatus || '').trim().toUpperCase();
  if (!SERVICE_REQUEST_OPEN_STATUSES.includes(statusNorm)) {
    return false;
  }
  if (!existingCreatedAt) return false;

  const createdDt =
    existingCreatedAt instanceof Date ? existingCreatedAt : new Date(existingCreatedAt);
  const nowDt = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(createdDt.getTime()) || Number.isNaN(nowDt.getTime())) {
    return false;
  }

  const hours = toPositiveHours(windowHours, 24);
  const elapsedMs = nowDt.getTime() - createdDt.getTime();
  if (elapsedMs < 0) return true;
  return elapsedMs <= hours * 3600 * 1000;
}

/**
 * Validate M11 status transitions for MANAGER and RESIDENT roles.
 */
export function validateServiceRequestTransition({
  fromStatus,
  toStatus,
  actorRole,
  holdReason = '',
  reopenReason = '',
  resolvedAt = null,
  reopenWindowDays = 3,
  now = new Date(),
} = {}) {
  const from = String(fromStatus || '').trim().toUpperCase();
  const to = String(toStatus || '').trim().toUpperCase();
  const role = String(actorRole || '').trim().toUpperCase();

  if (!from || !to) {
    return {
      valid: false,
      code: 'INVALID_STATUS_TRANSITION',
      message: 'Trạng thái yêu cầu không hợp lệ.',
    };
  }

  if (role === 'MANAGER') {
    const allowed = MANAGER_ALLOWED_TRANSITIONS[from] || [];
    if (!allowed.includes(to)) {
      return {
        valid: false,
        code: 'INVALID_STATUS_TRANSITION',
        message: `Không thể chuyển trạng thái từ ${from} sang ${to}.`,
      };
    }

    if (to === 'ON_HOLD' && String(holdReason || '').trim().length === 0) {
      return {
        valid: false,
        code: 'HOLD_REASON_REQUIRED',
        message: 'Vui lòng nhập lý do tạm hoãn / hẹn lại xử lý.',
      };
    }

    return { valid: true };
  }

  if (role === 'RESIDENT') {
    if (to === 'CANCELLED') {
      if (from !== 'NEW') {
        return {
          valid: false,
          code: 'INVALID_STATUS_TRANSITION',
          message: 'Chỉ có thể tự hủy yêu cầu khi đang ở trạng thái Mới tạo (NEW).',
        };
      }
      return { valid: true };
    }

    if (to === 'CLOSED') {
      if (from !== 'RESOLVED') {
        return {
          valid: false,
          code: 'INVALID_STATUS_TRANSITION',
          message: 'Chỉ có thể nghiệm thu đóng yêu cầu khi BQL đã hoàn tất xử lý (RESOLVED).',
        };
      }
      return { valid: true };
    }

    if (to === 'REOPENED') {
      if (from !== 'RESOLVED') {
        return {
          valid: false,
          code: 'INVALID_STATUS_TRANSITION',
          message: 'Chỉ có thể yêu cầu xử lý lại đối với phiếu ở trạng thái Đã xử lý (RESOLVED).',
        };
      }

      if (String(reopenReason || '').trim().length < 5) {
        return {
          valid: false,
          code: 'REOPEN_REASON_REQUIRED',
          message: 'Vui lòng nhập lý do yêu cầu xử lý lại (tối thiểu 5 ký tự).',
        };
      }

      const windowDays = toPositiveHours(reopenWindowDays, 3);
      if (resolvedAt) {
        const resolvedDt = resolvedAt instanceof Date ? resolvedAt : new Date(resolvedAt);
        const nowDt = now instanceof Date ? now : new Date(now);
        if (!Number.isNaN(resolvedDt.getTime()) && !Number.isNaN(nowDt.getTime())) {
          const elapsedMs = nowDt.getTime() - resolvedDt.getTime();
          if (elapsedMs > windowDays * 86400 * 1000) {
            return {
              valid: false,
              code: 'REOPEN_WINDOW_EXPIRED',
              message: `Đã quá thời hạn ${windowDays} ngày để mở lại yêu cầu. Vui lòng gửi yêu cầu mới.`,
            };
          }
        }
      }

      return { valid: true };
    }

    return {
      valid: false,
      code: 'INVALID_STATUS_TRANSITION',
      message: `Cư dân không thể chuyển trạng thái từ ${from} sang ${to}.`,
    };
  }

  return {
    valid: false,
    code: 'FORBIDDEN_ROLE',
    message: 'Vai trò hiện tại không được phép cập nhật trạng thái yêu cầu.',
  };
}
