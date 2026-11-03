export { createIdempotencyKey, withIdempotency } from './idempotency.js';

/**
 * Làm tròn số tiền VND đến hàng nghìn gần nhất — ROUND(x, -3) (PRD Mục 10.3 / Ruling 3).
 * Ví dụ: 123456 -> 123000; 123500 -> 124000; -123600 -> -124000
 */
export function roundVND(amount) {
  const num = Number(amount || 0);
  if (!Number.isFinite(num) || num === 0) return 0;
  const sign = num < 0 ? -1 : 1;
  return sign * Math.round(Math.abs(num) / 1000) * 1000;
}

/**
 * Lấy ngày hôm nay theo múi giờ 'Asia/Ho_Chi_Minh' dạng 'YYYY-MM-DD' (PRD 13.4).
 */
export function todayVietnamYmd(now) {
  let dt = now;
  if (!dt) {
    dt = new Date();
  } else if (!(dt instanceof Date)) {
    dt = new Date(dt);
  }
  if (Number.isNaN(dt.getTime())) {
    dt = new Date();
  }
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Ho_Chi_Minh',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(dt);
}

/**
 * Phân bổ nhóm tuổi nợ chuẩn PRD AC-016.1:
 * - daysOverdue <= 0: 'current_not_due' (Chưa đến hạn)
 * - 1..15 ngày: '0_15'
 * - 16..30 ngày: '16_30'
 * - 31..60 ngày: '31_60'
 * - > 60 ngày: 'over_60'
 */
export function resolvePrdAgingBucket(daysOverdue) {
  const days = Number(daysOverdue);
  if (!Number.isFinite(days) || days <= 0) {
    return 'current_not_due';
  }
  if (days <= 15) return '0_15';
  if (days <= 30) return '16_30';
  if (days <= 60) return '31_60';
  return 'over_60';
}

export const PRD_AGING_BUCKETS = {
  current_not_due: { key: 'current_not_due', label: 'Chưa đến hạn', variant: 'slate' },
  '0_15': { key: '0_15', label: '0–15 ngày', variant: 'emerald' },
  '16_30': { key: '16_30', label: '16–30 ngày', variant: 'amber' },
  '31_60': { key: '31_60', label: '31–60 ngày', variant: 'orange' },
  over_60: { key: 'over_60', label: '>60 ngày', variant: 'red' },
};

function toDateStr(val) {
  if (!val) return '';
  if (typeof val === 'string') return val.slice(0, 10);
  if (val instanceof Date && !Number.isNaN(val.getTime())) {
    const y = val.getFullYear();
    const m = String(val.getMonth() + 1).padStart(2, '0');
    const d = String(val.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  return String(val).slice(0, 10);
}

/**
 * Tính toán & xem trước phí Pro-rata dịch vụ đăng ký:
 * Hỗ trợ cả 2 dạng gọi:
 * - Object: previewSubscriptionProrata({ unitPrice, quantity, startDate, endDate, zeroUsage, periodYm })
 * - Positional: previewSubscriptionProrata(unitPrice, quantity, startDate, endDate, options)
 */
export function previewSubscriptionProrata(arg1, arg2, arg3, arg4, arg5) {
  let unitPrice;
  let quantity = 1;
  let startDate = '';
  let endDate = '';
  let zeroUsage = false;
  let periodYm = '';

  if (typeof arg1 === 'object' && arg1 !== null) {
    unitPrice = Number(arg1.unitPrice ?? arg1.unit_price ?? 0);
    quantity = Math.max(1, Number(arg1.quantity || 1));
    startDate = toDateStr(arg1.startDate || arg1.start_date);
    endDate = toDateStr(arg1.endDate || arg1.end_date);
    zeroUsage = Boolean(arg1.zeroUsage || arg1.zero_usage);
    periodYm = arg1.periodYm || arg1.period || '';
  } else {
    unitPrice = Number(arg1 || 0);
    quantity = Math.max(1, Number(arg2 || 1));
    startDate = toDateStr(arg3);
    endDate = toDateStr(arg4);
    if (typeof arg5 === 'object' && arg5 !== null) {
      zeroUsage = Boolean(arg5.zeroUsage || arg5.zero_usage);
      periodYm = arg5.periodYm || arg5.period || '';
    } else {
      zeroUsage = Boolean(arg5);
    }
  }

  // Nếu người dùng chọn zero_usage (0 ₫)
  if (zeroUsage) {
    const res = {
      amount: 0,
      activeDays: 0,
      daysInMonth: 30,
      isProrated: true,
      formattedAmount: '0 ₫',
      daysRatio: '0/30',
      description: 'Miễn phí sử dụng (0 ₫)',
    };
    res.toString = () => res.formattedAmount;
    res.valueOf = () => 0;
    return res;
  }

  // Xác định kỳ tháng & số ngày trong tháng
  let refDateStr = endDate || startDate || todayVietnamYmd();
  if (periodYm && /^\d{4}-\d{2}$/.test(periodYm)) {
    refDateStr = `${periodYm}-01`;
  }
  const [y, m] = refDateStr.slice(0, 7).split('-').map(Number);
  const safeY = Number.isFinite(y) && y > 1970 ? y : 2026;
  const safeM = Number.isFinite(m) && m >= 1 && m <= 12 ? m : 11;
  const daysInMonth = new Date(Date.UTC(safeY, safeM, 0)).getUTCDate();

  // Kiểm tra thứ tự ngày
  if (startDate && endDate && endDate < startDate) {
    const res = {
      amount: 0,
      activeDays: 0,
      daysInMonth,
      isProrated: true,
      formattedAmount: '0 ₫',
      daysRatio: `0/${daysInMonth}`,
      description: 'Ngày kết thúc trước ngày bắt đầu (0 ₫)',
    };
    res.toString = () => res.formattedAmount;
    res.valueOf = () => 0;
    return res;
  }

  let activeDays = daysInMonth;
  const padM = String(safeM).padStart(2, '0');
  const padDim = String(daysInMonth).padStart(2, '0');
  const monthStart = `${safeY}-${padM}-01`;
  const monthEnd = `${safeY}-${padM}-${padDim}`;

  if (startDate || endDate) {
    const effStart = startDate ? (startDate > monthStart ? startDate : monthStart) : monthStart;
    const effEnd = endDate ? (endDate < monthEnd ? endDate : monthEnd) : monthEnd;

    if (effEnd < effStart) {
      activeDays = 0;
    } else {
      const d1 = Number(effStart.slice(8, 10));
      const d2 = Number(effEnd.slice(8, 10));
      activeDays = Math.max(0, d2 - d1 + 1);
    }
  }

  const isProrated = activeDays < daysInMonth;
  const rawAmount = isProrated
    ? (unitPrice * quantity * activeDays) / daysInMonth
    : unitPrice * quantity;
  const amount = activeDays <= 0 ? 0 : roundVND(rawAmount);
  const formattedAmount = `${amount.toLocaleString('vi-VN')} ₫`;

  const result = {
    amount,
    activeDays,
    daysInMonth,
    isProrated,
    formattedAmount,
    daysRatio: `${activeDays}/${daysInMonth}`,
    description: isProrated
      ? `${activeDays}/${daysInMonth} ngày (${formattedAmount})`
      : `Trọn kỳ (${formattedAmount})`,
  };

  result.toString = () => formattedAmount;
  result.valueOf = () => amount;
  return result;
}

/**
 * Kiểm tra điều kiện xác nhận hủy hóa đơn 2 bước (PRD 16.2):
 * - Phải gõ đúng mã hóa đơn invoice_code
 * - Phải có lý do hủy non-empty
 */
export function canConfirmInvoiceVoid(arg1, arg2, arg3) {
  let invoice;
  let typedInvoiceCode;
  let reason;

  if (typeof arg1 === 'object' && arg1 !== null && ('typedInvoiceCode' in arg1 || 'typedCode' in arg1 || 'confirmCode' in arg1 || 'invoice' in arg1)) {
    invoice = arg1.invoice || arg1.invoiceCode || arg1.code;
    typedInvoiceCode = arg1.typedInvoiceCode ?? arg1.typedCode ?? arg1.confirmCode ?? arg1.confirm_invoice_code;
    reason = arg1.reason;
  } else {
    invoice = arg1;
    typedInvoiceCode = arg2;
    reason = arg3;
  }

  const expected = typeof invoice === 'string' ? invoice : (invoice?.invoice_code || invoice?.code || '');
  if (!expected || !typedInvoiceCode) return false;
  if (String(typedInvoiceCode).trim() !== String(expected).trim()) return false;
  if (!reason || !String(reason).trim()) return false;
  return true;
}

function resolveActorInfo(actor) {
  if (!actor) return { id: null, roles: [] };
  const id = actor.id || actor.user_id || null;
  let roles = [];
  if (Array.isArray(actor.roleCodes)) {
    roles = actor.roleCodes;
  } else if (Array.isArray(actor.roles)) {
    roles = actor.roles;
  } else if (actor.role) {
    roles = [actor.role];
  } else if (typeof actor === 'string') {
    roles = [actor];
  }
  return { id, roles: roles.map((r) => String(r).toUpperCase()) };
}

/**
 * Kiểm tra quyền phê duyệt 4 mắt cho đề nghị điều chỉnh hóa đơn (PRD Mục 5.6 & 6.2):
 * - Ngăn chặn tự phê duyệt (creatorId === actorId) trừ khi allowSelfApproval = true.
 * - OWNER: có quyền duyệt.
 * - MANAGER: có quyền duyệt (khi không phải người tạo).
 * - SYS_ADMIN: chỉ có quyền duyệt dự phòng khi tòa nhà chưa có OWNER hoạt động (buildingHasActiveOwner === false).
 */
export function canActorApproveInvoiceAdjustment(options = {}) {
  const {
    actor,
    record,
    buildingHasActiveOwner = true,
    allowSelfApproval = false,
  } = options || {};

  const { id: actorId, roles } = resolveActorInfo(actor);
  const creatorId = record?.created_by || record?.requested_by || record?.creatorId || null;

  // 4-eyes check
  if (actorId && creatorId && String(actorId) === String(creatorId)) {
    if (!allowSelfApproval) return false;
  }

  const isOwner = roles.includes('OWNER');
  const isManager = roles.includes('MANAGER');
  const isSysAdmin = roles.includes('SYS_ADMIN') || roles.includes('ADMIN');

  if (isOwner) return true;
  if (isManager) return true;
  if (isSysAdmin) {
    // Dự phòng khi tòa chưa có OWNER hoạt động
    return !buildingHasActiveOwner;
  }

  return false;
}

/**
 * Kiểm tra quyền phê duyệt 4 mắt cho đề nghị hoàn tiền tín dụng (FR-040 & PRD Mục 5.6):
 * Áp dụng cùng quy tắc 4 mắt và dự phòng SYS_ADMIN.
 */
export function canActorApproveCreditRefund(options = {}) {
  return canActorApproveInvoiceAdjustment(options);
}

/**
 * Tách bạch số tiền hoàn cọc và hoàn tín dụng trong quyết toán cuối kỳ (M06 / FR-024 / FR-040):
 * - depositRefund: hoàn từ số dư tiền cọc sau cấn trừ.
 * - creditRefund: hoàn từ số dư tín dụng còn dư sau bù trừ nợ và thiệt hại.
 * - totalPayout = depositRefund + creditRefund.
 * - requiresUncPayout: true khi totalPayout > 0 (kể cả khi depositRefund === 0 && creditRefund > 0).
 */
export function resolveSettlementPayoutSummary(settlement = {}) {
  const s = settlement || {};
  const depositRefund = Math.max(
    0,
    Number(s.deposit_refund_amount ?? s.depositRefund ?? s.refund_amount ?? s.calculated_refund_amount ?? 0) || 0
  );
  const creditRefund = Math.max(
    0,
    Number(s.credit_refund_amount ?? s.creditRefund ?? s.credit_refund ?? 0) || 0
  );
  const totalPayout = Math.max(
    0,
    Number(s.total_payout_amount ?? s.totalPayout ?? s.total_payout ?? (depositRefund + creditRefund)) || 0
  );
  return {
    depositRefund,
    creditRefund,
    totalPayout,
    requiresUncPayout: totalPayout > 0,
  };
}

