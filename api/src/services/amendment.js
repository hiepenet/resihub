export const AMENDMENT_WHITELIST = ['end_date', 'rent_amount', 'deposit_amount', 'note'];

/**
 * Build diff between current contract and proposed changes
 * Only whitelisted fields are allowed, and new values must differ from old values.
 */
export function buildDiff(current, changes) {
  if (!changes || typeof changes !== 'object') {
    return { ok: false, code: 'INVALID_CHANGES', message: 'Dữ liệu thay đổi không hợp lệ.' };
  }

  const diff = {};
  const keys = Object.keys(changes);
  if (keys.length === 0) {
    return { ok: false, code: 'NO_CHANGES', message: 'Không có trường nào được thay đổi.' };
  }

  for (const k of keys) {
    if (!AMENDMENT_WHITELIST.includes(k)) {
      return { ok: false, code: 'DISALLOWED_FIELD', message: `Trường ${k} không được phép sửa đổi qua phụ lục hợp đồng.` };
    }

    const oldVal = current ? current[k] : undefined;
    const newVal = changes[k];

    const oldStr = oldVal instanceof Date ? oldVal.toISOString().split('T')[0] : String(oldVal ?? '');
    const newStr = newVal instanceof Date ? newVal.toISOString().split('T')[0] : String(newVal ?? '');

    if (oldStr === newStr) {
      return { ok: false, code: 'VALUE_UNCHANGED', message: `Giá trị trường ${k} không thay đổi so với hiện tại.` };
    }

    diff[k] = { old: oldVal, new: newVal };
  }

  return { ok: true, diff };
}

/**
 * If amending end_date, contract status temporarily flags RENEWAL_PENDING; otherwise ACTIVE.
 */
export function nextStatusOnAmend(fieldName) {
  if (fieldName === 'end_date') {
    return 'RENEWAL_PENDING';
  }
  return 'ACTIVE';
}
