export const DEDUCT_CATEGORIES = ['DAMAGE', 'CLEANING', 'UTILITY_DEBT', 'OTHER'];

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
      message: 'Không được khấu trừ tiền cọc để trừ tiền thuê phòng (FR-023).'
    };
  }

  if (!category || !DEDUCT_CATEGORIES.includes(category)) {
    return {
      ok: false,
      code: 'INVALID_CATEGORY',
      message: `Danh mục khấu trừ không hợp lệ. Phải thuộc: ${DEDUCT_CATEGORIES.join(', ')}.`
    };
  }

  const numAmount = Number(amount);
  if (amount === undefined || amount === null || isNaN(numAmount) || numAmount <= 0) {
    return {
      ok: false,
      code: 'INVALID_AMOUNT',
      message: 'Số tiền khấu trừ phải lớn hơn 0.'
    };
  }

  if (!description || typeof description !== 'string' || !description.trim()) {
    return {
      ok: false,
      code: 'INVALID_DESCRIPTION',
      message: 'Mô tả lý do khấu trừ không được để trống.'
    };
  }

  if (!Array.isArray(evidence) || evidence.length === 0) {
    return {
      ok: false,
      code: 'EVIDENCE_REQUIRED',
      message: 'Khấu trừ cọc bắt buộc phải có ít nhất một chứng từ/hình ảnh bằng chứng đính kèm (FR-023).'
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
  const sumItems = (items || []).reduce((acc, item) => acc + BigInt(item.amount ?? 0), 0n);

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
