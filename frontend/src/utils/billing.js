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
    return todayVietnamYmd(val);
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

/**
 * Đánh giá sản lượng và cảnh báo biến động bất thường > thresholdPct% (mặc định 30%)
 * so với trung bình tối đa 3 kỳ CONFIRMED liền trước (M08 / FR-030 / FR-031).
 */
export function evaluateClientMeterAnomaly({
  prevReading,
  currentReading,
  baselineAvg = null,
  thresholdPct = 30,
} = {}) {
  const prev = Number(prevReading ?? 0);
  const hasInput =
    currentReading !== undefined &&
    currentReading !== null &&
    String(currentReading).trim() !== '';
  const base =
    baselineAvg !== null && baselineAvg !== undefined && Number(baselineAvg) > 0
      ? Number(baselineAvg)
      : null;

  if (!hasInput) {
    return {
      hasInput: false,
      isInvalid: false,
      consumption: null,
      baselineAvg: base,
      diffPct: null,
      isAbnormal: false,
    };
  }

  const curr = Number(currentReading);
  if (!Number.isFinite(prev) || !Number.isFinite(curr) || curr < prev) {
    return {
      hasInput: true,
      isInvalid: true,
      consumption: null,
      baselineAvg: base,
      diffPct: null,
      isAbnormal: false,
    };
  }

  const consumption = Number((curr - prev).toFixed(2));
  if (base === null) {
    return {
      hasInput: true,
      isInvalid: false,
      consumption,
      baselineAvg: null,
      diffPct: null,
      isAbnormal: false,
    };
  }

  const threshold =
    Number.isFinite(Number(thresholdPct)) && Number(thresholdPct) > 0
      ? Number(thresholdPct)
      : 30;
  const ratio = (consumption - base) / base;
  const diffPct = Math.round(ratio * 100);
  const isAbnormal = Math.abs(ratio) * 100 > threshold + 1e-9;

  return {
    hasInput: true,
    isInvalid: false,
    consumption,
    baselineAvg: base,
    diffPct,
    isAbnormal,
  };
}

/**
 * Tổng hợp danh sách hợp đồng bị bỏ qua khi sinh hóa đơn hàng loạt (AC-015.1):
 * - Phân tách nhóm thiếu chỉ số đồng hồ CONFIRMED (MISSING_CONFIRMED_METER_READING)
 *   và nhóm không phát sinh khoản thu (ZERO_BILLABLE_AMOUNT).
 */
export function summarizeSkippedContracts(skippedContracts = []) {
  const list = Array.isArray(skippedContracts) ? skippedContracts : [];
  const missingMeterApartments = [];
  const zeroBillableApartments = [];
  let missingMeterCount = 0;
  let zeroBillableCount = 0;
  let otherCount = 0;

  for (const item of list) {
    if (!item) continue;
    const aptLabel = item.apartment_code || item.contract_code || item.contract_id || '—';
    if (item.reason_code === 'MISSING_CONFIRMED_METER_READING') {
      missingMeterCount += 1;
      if (!missingMeterApartments.includes(aptLabel)) {
        missingMeterApartments.push(aptLabel);
      }
    } else if (item.reason_code === 'ZERO_BILLABLE_AMOUNT') {
      zeroBillableCount += 1;
      if (!zeroBillableApartments.includes(aptLabel)) {
        zeroBillableApartments.push(aptLabel);
      }
    } else {
      otherCount += 1;
    }
  }

  const totalSkipped = list.length;
  const parts = [];
  if (missingMeterCount > 0) {
    parts.push(
      `Thiếu chỉ số đồng hồ đã xác nhận (${missingMeterCount} căn: ${missingMeterApartments.join(', ')})`
    );
  }
  if (zeroBillableCount > 0) {
    parts.push(
      `Không phát sinh khoản thu (${zeroBillableCount} căn: ${zeroBillableApartments.join(', ')})`
    );
  }
  if (otherCount > 0) {
    parts.push(`Đã có hóa đơn / khác (${otherCount} hợp đồng)`);
  }

  return {
    totalSkipped,
    missingMeterCount,
    missingMeterApartments,
    zeroBillableCount,
    zeroBillableApartments,
    otherCount,
    message: parts.join(' • '),
  };
}

/**
 * Chuẩn hóa thông báo kết quả xác nhận chỉ số đồng hồ hàng loạt (`POST /api/v1/meters/readings/confirm-batch`).
 * Hỗ trợ `skipped_abnormal_without_note` dạng số nguyên (chuẩn backend) hoặc mảng dự phòng.
 */
export function resolveBatchConfirmFeedback(res = {}) {
  const confirmedCount = Math.max(0, Number(res?.confirmed_count || 0));
  const rawSkipped = res?.skipped_abnormal_without_note;
  const skippedCount = Array.isArray(rawSkipped)
    ? rawSkipped.length
    : Math.max(0, Number(rawSkipped || 0));

  if (skippedCount > 0) {
    return {
      level: 'warning',
      confirmedCount,
      skippedCount,
      message: `${res?.message || 'Đã xác nhận hàng loạt.'} (Còn ${skippedCount} đồng hồ bất thường cần nhập ghi chú giải trình).`,
    };
  }

  return {
    level: 'success',
    confirmedCount,
    skippedCount: 0,
    message: res?.message || `Đã xác nhận chốt ${confirmedCount} chỉ số.`,
  };
}

/**
 * Trích xuất đường dẫn ảnh mặt đồng hồ công tơ (FR-032) cho dòng hóa đơn ĐIỆN / NƯỚC bên Cổng Cư dân.
 */
export function resolveResidentInvoiceLineMeterImage(line = {}) {
  if (!line || typeof line !== 'object') return null;
  const typeKey = String(line.item_type || line.line_type || '').trim().toUpperCase();
  if (typeKey !== 'ELECTRICITY' && typeKey !== 'WATER') {
    return null;
  }
  const candidate = line.meter_image_url || line.formula_meta?.image_url || '';
  const trimmed = String(candidate || '').trim();
  return trimmed ? trimmed : null;
}

/**
 * Chuẩn hóa số liệu tổng kết chân hóa đơn bên Cổng Cư dân (bao gồm cả credit_offset_amount & adjustment_amount).
 */
export function resolveResidentInvoiceTotalsSummary(invoice = {}) {
  const inv = invoice || {};
  const statusUpper = String(inv.status || '').trim().toUpperCase();
  const totalAmount = Math.max(0, Number(inv.total_amount || 0));
  const paidAmount = Math.max(0, Number(inv.paid_amount || 0));
  const adjustmentAmount = Number(inv.adjustment_amount || 0);
  const creditOffsetAmount = Math.max(0, Number(inv.credit_offset_amount || 0));
  const subtotalAmount =
    inv.subtotal_amount !== undefined && inv.subtotal_amount !== null
      ? Number(inv.subtotal_amount || 0)
      : totalAmount - adjustmentAmount + creditOffsetAmount;
  const remainingAmount =
    statusUpper === 'VOID' || statusUpper === 'CANCELLED'
      ? 0
      : Math.max(0, totalAmount - paidAmount);

  return {
    subtotalAmount,
    adjustmentAmount,
    creditOffsetAmount,
    totalAmount,
    paidAmount,
    remainingAmount,
    showPreTotalBreakdown: adjustmentAmount !== 0 || creditOffsetAmount > 0,
  };
}

/**
 * Chuẩn hóa ngưỡng cảnh báo biến động chỉ số công tơ (%) từ cấu hình hệ thống (mặc định 30%).
 */
export function resolveAnomalyThresholdPct(rawPct) {
  const num = Number(rawPct);
  return Number.isFinite(num) && num > 0 ? num : 30;
}

/**
 * Tính số tiền tạm tính cho công tơ trên bảng ghi chỉ số (M08):
 * - Ưu tiên `effective_unit_price` (đã áp dụng thứ tự ưu tiên 3 tầng FR-065) trước `unit_price` gốc.
 * - Làm tròn hàng nghìn chuẩn `roundVND` (`ROUND(x, -3)`) đồng nhất với hóa đơn M09.
 */
export function computeMeterEstimatedAmount(consumption, meterRow = {}) {
  if (consumption === null || consumption === undefined || consumption === '') {
    return null;
  }
  const cons = Number(consumption);
  if (!Number.isFinite(cons) || cons < 0) {
    return null;
  }
  if (cons === 0) {
    return 0;
  }
  const rawPrice =
    meterRow?.effective_unit_price !== undefined && meterRow?.effective_unit_price !== null
      ? Number(meterRow.effective_unit_price)
      : Number(meterRow?.unit_price || 0);
  const safePrice = Number.isFinite(rawPrice) && rawPrice >= 0 ? rawPrice : 0;
  return roundVND(cons * safePrice);
}

export const DEFAULT_CONTRACT_SERVICE_CODE_OPTIONS = [
  { value: 'ELECTRICITY', label: 'Điện sinh hoạt (kWh)' },
  { value: 'WATER', label: 'Nước sinh hoạt (m³)' },
  { value: 'INTERNET', label: 'Internet / Wifi (INTERNET)' },
  { value: 'MOTORBIKE_PARKING', label: 'Gửi xe máy xăng (MOTORBIKE_PARKING)' },
  { value: 'ELECTRICBIKE_PARKING', label: 'Gửi xe đạp/máy điện (ELECTRICBIKE_PARKING)' },
  { value: 'TRASH', label: 'Phí thu gom rác (TRASH)' },
  { value: 'COMMON_SERVICE', label: 'Dịch vụ chung (COMMON_SERVICE)' },
];

/**
 * Xây dựng danh sách mã dịch vụ riêng theo hợp đồng (FR-065):
 * Kết hợp 7 mã chuẩn (gồm Điện, Nước) với các mã dịch vụ đang hoạt động trong `service_catalog`
 * và các mã đã cấu hình trên hợp đồng để không bỏ sót dịch vụ tùy chỉnh mới.
 */
export function buildContractServiceCodeOptions(catalogItems = [], existingPrices = []) {
  const map = new Map();
  for (const std of DEFAULT_CONTRACT_SERVICE_CODE_OPTIONS) {
    map.set(std.value, { value: std.value, label: std.label });
  }

  const existingCodeSet = new Set(
    (Array.isArray(existingPrices) ? existingPrices : [])
      .map((sp) => String(sp?.service_code || '').trim().toUpperCase())
      .filter(Boolean)
  );

  for (const item of Array.isArray(catalogItems) ? catalogItems : []) {
    if (!item) continue;
    const code = String(item.code || item.service_code || '').trim().toUpperCase();
    if (!code) continue;
    if (item.is_active === false && !existingCodeSet.has(code)) continue;
    if (!map.has(code)) {
      const name = String(item.name || item.service_name || code).trim();
      map.set(code, {
        value: code,
        label: name.toUpperCase() === code ? code : `${name} (${code})`,
      });
    }
  }

  for (const code of existingCodeSet) {
    if (!map.has(code)) {
      map.set(code, { value: code, label: code });
    }
  }

  return Array.from(map.values());
}

/**
 * Kiểm tra dòng công tơ có bị khóa không cho sửa/ghi đè trên bảng hoặc modal (M08 Turnover):
 * - Khóa khi người dùng không có quyền ghi (`!canWriteMeters`)
 * - Hoặc khi đợt hợp đồng đang hiển thị đã được lập hóa đơn phát hành / quyết toán (`period_reading_billed === true`).
 */
export function isMeterRowLockedForEdit(row, canWriteMeters) {
  if (!canWriteMeters) return true;
  return Boolean(row?.period_reading_billed);
}

/**
 * Chuẩn hóa nhãn hiển thị hợp đồng & đợt giao ca giữa tháng trên bảng ghi chỉ số đồng hồ.
 */
export function resolveMeterTurnoverBadgeMeta(row = {}) {
  const r = row || {};
  const contractCode = r.target_contract_code || null;
  const tenantName = r.target_tenant_name || null;
  const totalSlots = Number(r.period_total_slots || 0);
  const slotIndex = Number(r.period_slot_index || 0);
  const isMultiSlot = totalSlots > 1 && slotIndex > 0;
  return {
    showContractTag: Boolean(contractCode || isMultiSlot),
    isMultiSlot,
    slotLabel: isMultiSlot ? `Đợt ${slotIndex}/${totalSlots}` : null,
    contractCode,
    tenantName,
  };
}

/**
 * Ánh xạ dữ liệu của một đợt hợp đồng (`overlapping_contracts`) lên đối tượng đồng hồ
 * khi Quản lý chuyển đổi giữa các hợp đồng trong cùng một kỳ tháng ở Modal chi tiết.
 */
export function resolveMeterSlotView(meter = {}, selectedContractId = null) {
  if (!meter || typeof meter !== 'object') return meter;
  const slots = Array.isArray(meter.overlapping_contracts) ? meter.overlapping_contracts : [];
  const targetId = selectedContractId || meter.target_contract_id || null;
  const slot = targetId
    ? slots.find((s) => String(s.contract_id) === String(targetId))
    : null;
  if (!slot) return meter;

  const hasReading = Boolean(slot.reading_id);
  return {
    ...meter,
    target_contract_id: slot.contract_id,
    target_contract_code: slot.contract_code || null,
    target_tenant_name: slot.tenant_name || null,
    period_slot_index: slot.slot_index ?? meter.period_slot_index,
    period_total_slots: slot.total_slots ?? meter.period_total_slots,
    period_reading_id: slot.reading_id || null,
    period_previous_reading: hasReading ? slot.previous_reading : null,
    period_current_reading: hasReading ? slot.current_reading : null,
    period_consumption: hasReading ? slot.consumption : null,
    period_reading_status: hasReading ? slot.reading_status : null,
    period_is_abnormal: hasReading ? Boolean(slot.is_abnormal) : false,
    period_abnormal_note: hasReading ? slot.abnormal_note || null : null,
    period_image_url: hasReading ? slot.image_url || null : null,
    period_reading_billed: Boolean(slot.is_billed),
    last_known_reading:
      slot.previous_reading !== null && slot.previous_reading !== undefined
        ? Number(slot.previous_reading)
        : meter.last_known_reading,
    effective_unit_price:
      slot.effective_unit_price !== null && slot.effective_unit_price !== undefined
        ? Number(slot.effective_unit_price)
        : meter.effective_unit_price,
    effective_price_source: slot.effective_price_source || meter.effective_price_source,
  };
}




