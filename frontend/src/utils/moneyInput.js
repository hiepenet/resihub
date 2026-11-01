function groupDigitsWithDots(digits) {
  if (!digits) return '';
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

function caretAfterSignificantChars(formatted, targetSigCount) {
  if (targetSigCount <= 0) return 0;
  let seen = 0;
  for (let i = 0; i < formatted.length; i += 1) {
    const ch = formatted[i];
    if (ch === '-' || (ch >= '0' && ch <= '9')) {
      seen += 1;
      if (seen === targetSigCount) {
        return i + 1;
      }
    }
  }
  return formatted.length;
}

/**
 * Chuẩn hóa giá trị prop đầu vào (number, chuỗi nguyên, chuỗi đã format có dấu chấm,
 * hoặc chuỗi số thập phân từ PostgreSQL NUMERIC(14,2) như "8500000.00") về chuỗi số nguyên sạch.
 */
export function normalizeMoneyPropValue(value, { allowNegative = false } = {}) {
  if (value === null || value === undefined || value === '') return '';

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return '';
    const rounded = Math.round(value);
    if (rounded === 0) return '0';
    if (rounded < 0) {
      return allowNegative ? String(rounded) : String(Math.abs(rounded));
    }
    return String(rounded);
  }

  const trimmed = String(value).trim();
  if (!trimmed) return '';

  // Chuỗi số thực có 1-2 chữ số thập phân (VD từ Postgres NUMERIC(14,2): "8500000.00", "220000.5")
  if (/^-?\d+\.\d{1,2}$/.test(trimmed)) {
    const num = Math.round(Number(trimmed));
    if (!Number.isFinite(num)) return '';
    if (num === 0) return '0';
    if (num < 0) {
      return allowNegative ? String(num) : String(Math.abs(num));
    }
    return String(num);
  }

  const isNeg = allowNegative && trimmed.startsWith('-');
  const rawDigits = trimmed.replace(/\D/g, '');
  if (!rawDigits) return '';

  const stripped = rawDigits.replace(/^0+/, '');
  if (!stripped) return '0';

  return isNeg ? `-${stripped}` : stripped;
}

/**
 * Định dạng giá trị tiền tệ sang chuỗi hiển thị phân tách hàng nghìn bằng dấu chấm (VD: "1.000.000").
 */
export function formatMoneyInputDisplay(value, { allowNegative = false } = {}) {
  if (allowNegative && String(value || '').trim() === '-') {
    return '-';
  }
  const clean = normalizeMoneyPropValue(value, { allowNegative });
  if (!clean) return '';
  if (clean.startsWith('-')) {
    return `-${groupDigitsWithDots(clean.slice(1))}`;
  }
  return groupDigitsWithDots(clean);
}

/**
 * Phân tích chuỗi người dùng vừa gõ/sửa trong ô input và tính lại vị trí con trỏ chính xác.
 */
export function parseMoneyUserEdit(displayText, caretIndex, { allowNegative = false } = {}) {
  const str = String(displayText ?? '');
  const safeCaret = Math.max(0, Math.min(str.length, Number(caretIndex ?? str.length)));

  const hasLeadingMinus = allowNegative && /^\s*-/.test(str);
  const digitsAll = str.replace(/\D/g, '');

  if (!digitsAll) {
    if (hasLeadingMinus) {
      return {
        rawValue: '',
        displayValue: '-',
        nextCaretIndex: 1,
        isTransientMinus: true,
      };
    }
    return {
      rawValue: '',
      displayValue: '',
      nextCaretIndex: 0,
      isTransientMinus: false,
    };
  }

  // Đếm số chữ số nằm trước vị trí con trỏ hiện tại
  const prefix = str.slice(0, safeCaret);
  const digitsBeforeCaret = prefix.replace(/\D/g, '').length;

  const strippedDigits = digitsAll.replace(/^0+/, '');
  if (!strippedDigits) {
    // Mọi chữ số đều là 0 -> thu gọn thành một số "0", đặt con trỏ cuối "0" để bấm Backspace lần nữa xóa hẳn được
    return {
      rawValue: '0',
      displayValue: '0',
      nextCaretIndex: 1,
      isTransientMinus: false,
    };
  }

  const leadingZerosRemoved = digitsAll.length - strippedDigits.length;
  const effectiveDigitsBefore = Math.max(0, digitsBeforeCaret - leadingZerosRemoved);
  const sigCountBefore = (hasLeadingMinus ? 1 : 0) + effectiveDigitsBefore;

  const rawValue = hasLeadingMinus ? `-${strippedDigits}` : strippedDigits;
  const displayValue = hasLeadingMinus
    ? `-${groupDigitsWithDots(strippedDigits)}`
    : groupDigitsWithDots(strippedDigits);

  // Nếu con trỏ đang đứng ngay sau dấu trừ (chưa qua chữ số nào), giữ ở vị trí 1
  const nextCaretIndex =
    hasLeadingMinus && effectiveDigitsBefore === 0 && prefix.includes('-')
      ? 1
      : caretAfterSignificantChars(displayValue, sigCountBefore);

  return {
    rawValue,
    displayValue,
    nextCaretIndex,
    isTransientMinus: false,
  };
}

/**
 * Xử lý phím Backspace / Delete khi con trỏ đứng sát dấu chấm phân cách "."
 * để xóa chữ số liền kề thay vì bị kẹt trên dấu chấm.
 */
export function handleMoneySeparatorKey(
  displayText,
  selectionStart,
  selectionEnd,
  key,
  { allowNegative = false } = {}
) {
  const str = String(displayText ?? '');
  if (selectionStart !== selectionEnd || selectionStart === null || selectionStart === undefined) {
    return { handled: false };
  }

  if (key === 'Backspace' && selectionStart >= 2 && str[selectionStart - 1] === '.') {
    // Xóa chữ số ngay trước dấu chấm (tại selectionStart - 2)
    const nextStr = str.slice(0, selectionStart - 2) + str.slice(selectionStart);
    const parsed = parseMoneyUserEdit(nextStr, selectionStart - 2, { allowNegative });
    return { handled: true, ...parsed };
  }

  if (key === 'Delete' && selectionStart < str.length - 1 && str[selectionStart] === '.') {
    // Xóa chữ số ngay sau dấu chấm (tại selectionStart + 1)
    const nextStr = str.slice(0, selectionStart) + str.slice(selectionStart + 2);
    const parsed = parseMoneyUserEdit(nextStr, selectionStart, { allowNegative });
    return { handled: true, ...parsed };
  }

  return { handled: false };
}

