export const DEDUCT_CATEGORIES = ['DAMAGE', 'CLEANING', 'UTILITY_DEBT', 'OTHER'];

/**
 * Kiểm tra giá trị tiền tệ VND nguyên dương an toàn (> 0).
 * Từ chối số thực dấu phẩy động, boolean, mảng, chuỗi rỗng/khoảng trắng, ký hiệu khoa học (1e5).
 */
export function isPositiveSafeIntegerVnd(val) {
  if (typeof val === 'number') {
    return Number.isSafeInteger(val) && val > 0;
  }
  if (typeof val === 'string') {
    const trimmed = val.trim();
    if (!/^[1-9]\d*$/.test(trimmed)) return false;
    const num = Number(trimmed);
    return Number.isSafeInteger(num) && num > 0;
  }
  return false;
}

/**
 * Chuẩn hóa Date hoặc chuỗi ngày sang YYYY-MM-DD theo múi giờ 'Asia/Ho_Chi_Minh'.
 */
export function getTodayVnDateStr(dateInput = new Date()) {
  if (!dateInput) return null;
  if (dateInput instanceof Date) {
    if (Number.isNaN(dateInput.getTime())) return null;
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Ho_Chi_Minh',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(dateInput);
  }
  const str = String(dateInput).trim();
  if (!str) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) {
    return str;
  }
  if (/^\d{4}-\d{2}-\d{2}T/.test(str)) {
    const parsed = new Date(str);
    if (!Number.isNaN(parsed.getTime())) {
      return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Ho_Chi_Minh',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(parsed);
    }
  }
  return str.slice(0, 10);
}

/**
 * Validate a deduction item according to FR-023/AC-017
 * Category 'RENT' is strictly forbidden under any circumstances.
 */
export function validateDeduction(input) {
  if (!input || typeof input !== 'object') {
    return { ok: false, code: 'INVALID_INPUT', message: 'Dữ liệu khấu trừ không hợp lệ.' };
  }

  const { category, amount, description, evidence } = input;

  if (category === 'RENT') {
    return {
      ok: false,
      code: 'RENT_DEDUCTION_FORBIDDEN',
      message: 'Không được khấu trừ tiền cọc để trừ tiền thuê phòng (FR-023).',
    };
  }

  if (!category || !DEDUCT_CATEGORIES.includes(category)) {
    return {
      ok: false,
      code: 'INVALID_CATEGORY',
      message: `Danh mục khấu trừ không hợp lệ. Phải thuộc: ${DEDUCT_CATEGORIES.join(', ')}.`,
    };
  }

  if (!isPositiveSafeIntegerVnd(amount)) {
    return {
      ok: false,
      code: 'INVALID_AMOUNT',
      message: 'Số tiền khấu trừ phải là số nguyên dương VND.',
    };
  }

  if (!description || typeof description !== 'string' || !description.trim()) {
    return {
      ok: false,
      code: 'INVALID_DESCRIPTION',
      message: 'Mô tả lý do khấu trừ không được để trống.',
    };
  }

  if (!Array.isArray(evidence) || evidence.length === 0) {
    return {
      ok: false,
      code: 'EVIDENCE_REQUIRED',
      message: 'Khấu trừ cọc bắt buộc phải có ít nhất một chứng từ/hình ảnh bằng chứng đính kèm (FR-023).',
    };
  }

  return { ok: true };
}

/**
 * Compute refund and shortfall according to AC-017
 * refund = max(0, deposit − debt − Σitems)
 * shortfall = max(0, debt + Σitems − deposit)
 */
export function computeRefund({ depositAmount, outstandingDebt, items }) {
  const dep = BigInt(depositAmount ?? 0);
  const debt = BigInt(outstandingDebt ?? 0);
  const sumItems = (items || []).reduce((acc, item) => {
    const raw = item?.amount ?? 0;
    const normalized = typeof raw === 'string' ? raw.trim() : raw;
    return acc + BigInt(normalized || 0);
  }, 0n);

  const totalDeductions = debt + sumItems;
  const refund = dep > totalDeductions ? dep - totalDeductions : 0n;
  const shortfall = totalDeductions > dep ? totalDeductions - dep : 0n;

  return { refund, shortfall };
}

/**
 * Split deposit opening into held amount and remaining collect
 * openHeld = holdAmount ?? 0n
 * remainingCollect = max(0n, depositAmount - openHeld)
 */
export function splitDepositOpening({ depositAmount, holdAmount }) {
  const dep = BigInt(depositAmount ?? 0);
  const openHeld = holdAmount !== null && holdAmount !== undefined ? BigInt(holdAmount) : 0n;
  const remainingCollect = dep > openHeld ? dep - openHeld : 0n;
  return { openHeld, remainingCollect };
}

/**
 * Determine deposit status after settlement approval (FR-024, AC-017.2, BUG-04):
 * - DEDUCTED_FULL when refund == 0 AND (deductions/debt > 0 OR shortfall > 0)
 * - PARTIALLY_REFUNDED when refund > 0 AND (deductions/debt > 0 OR shortfall > 0)
 * - REFUNDED when full deposit is refunded (deductions == 0 && shortfall == 0)
 */
export function resolvePostSettlementStatus({ refundAmount = 0, outstandingDebt = 0, items = [], shortfall = 0 }) {
  const refund = BigInt(refundAmount ?? 0);
  const debt = BigInt(outstandingDebt ?? 0);
  const sumItems = (items || []).reduce((acc, item) => {
    const raw = item?.amount ?? 0;
    const normalized = typeof raw === 'string' ? raw.trim() : raw;
    return acc + BigInt(normalized || 0);
  }, 0n);
  const sf = BigInt(shortfall ?? 0);
  const totalDeductions = debt + sumItems;

  if (refund === 0n && (totalDeductions > 0n || sf > 0n)) {
    return 'DEDUCTED_FULL';
  }
  if (refund > 0n && (totalDeductions > 0n || sf > 0n)) {
    return 'PARTIALLY_REFUNDED';
  }
  return 'REFUNDED';
}

/**
 * Validate bank account information when refunding via BANK_TRANSFER (FR-024, BUG-03).
 */
export function validateRefundBankInfo({ refundAmount = 0, refundMethod = 'BANK_TRANSFER', bankInfo = {} } = {}) {
  const method = String(refundMethod || 'BANK_TRANSFER').trim();
  if (!['BANK_TRANSFER', 'CASH'].includes(method)) {
    return {
      ok: false,
      code: 'INVALID_REFUND_METHOD',
      message: 'Phương thức hoàn cọc không hợp lệ. Chỉ chấp nhận BANK_TRANSFER hoặc CASH.',
    };
  }

  const rawInfo = bankInfo && typeof bankInfo === 'object' && !Array.isArray(bankInfo) ? bankInfo : {};
  const bankName = String(rawInfo.bank_name || '').trim();
  const accountNumber = String(rawInfo.account_number ?? rawInfo.account_no ?? '').trim();
  const accountHolder = String(rawInfo.account_holder || '').trim();

  const normalizedBankInfo = {
    bank_name: bankName,
    account_number: accountNumber,
    account_holder: accountHolder,
    ...(rawInfo.bank_code ? { bank_code: String(rawInfo.bank_code).trim() } : {}),
    ...(rawInfo.bank_bin ? { bank_bin: String(rawInfo.bank_bin).trim() } : {}),
    ...(rawInfo.bank_logo ? { bank_logo: String(rawInfo.bank_logo).trim() } : {}),
  };

  const refundBig = BigInt(typeof refundAmount === 'string' ? refundAmount.trim() || 0 : Math.max(0, Math.trunc(Number(refundAmount || 0))));
  if (refundBig > 0n && method === 'BANK_TRANSFER') {
    if (!bankName || !accountNumber || !accountHolder) {
      return {
        ok: false,
        code: 'BANK_INFO_REQUIRED',
        message: 'Hoàn cọc qua chuyển khoản bắt buộc phải nhập đầy đủ tên ngân hàng, số tài khoản và chủ tài khoản nhận tiền (FR-024).',
      };
    }
    if (!/^[A-Za-z0-9]{4,25}$/.test(accountNumber)) {
      return {
        ok: false,
        code: 'INVALID_ACCOUNT_NUMBER',
        message: 'Số tài khoản nhận hoàn cọc chỉ gồm chữ và số (từ 4 đến 25 ký tự, không chứa dấu gạch ngang hay ký tự đặc biệt).',
      };
    }
  }

  return { ok: true, normalizedBankInfo };
}

/**
 * Chuẩn hóa danh sách hóa đơn đang mở để đối chiếu snapshot tất toán Four-Eyes.
 */
export function normalizeOpenInvoiceSnapshot(openInvoices = []) {
  if (!Array.isArray(openInvoices)) return [];
  return openInvoices
    .map((inv) => ({
      id: String(inv?.id || ''),
      remaining: Number(inv?.remaining ?? 0),
      service_unpaid: Number(inv?.service_unpaid ?? 0),
      rent_unpaid: Number(inv?.rent_unpaid ?? 0),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Kiểm tra biên bản tất toán đã bị lệch công nợ / số tiền cọc / danh sách hóa đơn mở so với lúc trình duyệt hay chưa.
 */
export function isSettlementSnapshotStale(
  savedSettlement,
  { serviceDebt = 0, rentDebt = 0, heldAmount = 0, openInvoices = [] } = {}
) {
  if (!savedSettlement || typeof savedSettlement !== 'object') return false;

  if (Number(serviceDebt ?? 0) !== Number(savedSettlement.outstanding_debt ?? 0)) {
    return true;
  }
  if (
    savedSettlement.rent_debt !== undefined &&
    Number(rentDebt ?? 0) !== Number(savedSettlement.rent_debt ?? 0)
  ) {
    return true;
  }
  if (
    savedSettlement.deposit_held_before_settlement !== undefined &&
    Number(heldAmount ?? 0) !== Number(savedSettlement.deposit_held_before_settlement ?? 0)
  ) {
    return true;
  }

  if (Array.isArray(savedSettlement.open_invoice_snapshot)) {
    const savedNorm = JSON.stringify(normalizeOpenInvoiceSnapshot(savedSettlement.open_invoice_snapshot));
    const liveNorm = JSON.stringify(normalizeOpenInvoiceSnapshot(openInvoices));
    if (savedNorm !== liveNorm) {
      return true;
    }
  }

  return false;
}
