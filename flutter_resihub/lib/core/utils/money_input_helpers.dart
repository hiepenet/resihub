import 'dart:math';

/// Gom nhóm các chữ số thành cụm 3 ngăn cách bởi dấu chấm `.` (VD: `"1000000"` -> `"1.000.000"`).
String groupDigitsWithDots(String digits) {
  if (digits.isEmpty) return '';
  final buffer = StringBuffer();
  final len = digits.length;
  for (var i = 0; i < len; i++) {
    if (i > 0 && (len - i) % 3 == 0) {
      buffer.write('.');
    }
    buffer.write(digits[i]);
  }
  return buffer.toString();
}

/// Tính vị trí con trỏ sau số lượng ký tự có nghĩa (chữ số hoặc dấu âm).
int caretAfterSignificantChars(String formatted, int targetSigCount) {
  if (targetSigCount <= 0) return 0;
  var seen = 0;
  for (var i = 0; i < formatted.length; i++) {
    final ch = formatted[i];
    if (ch == '-' || (ch.codeUnitAt(0) >= 48 && ch.codeUnitAt(0) <= 57)) {
      seen += 1;
      if (seen == targetSigCount) {
        return i + 1;
      }
    }
  }
  return formatted.length;
}

/// Chuẩn hóa giá trị prop đầu vào (number, chuỗi nguyên, chuỗi có dấu chấm,
/// hoặc chuỗi số thập phân từ PostgreSQL NUMERIC(14,2) như "8500000.00") về chuỗi số nguyên sạch.
String normalizeMoneyPropValue(dynamic value, {bool allowNegative = false}) {
  if (value == null || value == '') return '';

  if (value is num) {
    if (value.isNaN || value.isInfinite) return '';
    final rounded = value.round();
    if (rounded == 0) return '0';
    if (rounded < 0) {
      return allowNegative ? '$rounded' : '${rounded.abs()}';
    }
    return '$rounded';
  }

  final trimmed = value.toString().trim();
  if (trimmed.isEmpty) return '';

  // Chuỗi số thực có 1-2 chữ số thập phân (từ Postgres NUMERIC(14,2): "8500000.00", "220000.5")
  if (RegExp(r'^-?\d+\.\d{1,2}$').hasMatch(trimmed)) {
    final numVal = double.tryParse(trimmed);
    if (numVal == null || numVal.isNaN || numVal.isInfinite) return '';
    final rounded = numVal.round();
    if (rounded == 0) return '0';
    if (rounded < 0) {
      return allowNegative ? '$rounded' : '${rounded.abs()}';
    }
    return '$rounded';
  }

  final isNeg = allowNegative && trimmed.startsWith('-');
  final rawDigits = trimmed.replaceAll(RegExp(r'\D'), '');
  if (rawDigits.isEmpty) return '';

  final stripped = rawDigits.replaceFirst(RegExp(r'^0+'), '');
  if (stripped.isEmpty) return '0';

  return isNeg ? '-$stripped' : stripped;
}

/// Alias của [normalizeMoneyPropValue] cho các component nhập liệu.
String toNumericInputValue(dynamic value, {bool allowNegative = false}) =>
    normalizeMoneyPropValue(value, allowNegative: allowNegative);

/// Alias của [normalizeMoneyPropValue] để xử lý chuỗi số thực / thập phân từ backend.
String normalizeDecimalNumericInputValue(dynamic value, {bool allowNegative = false}) =>
    normalizeMoneyPropValue(value, allowNegative: allowNegative);

/// Định dạng giá trị tiền tệ sang chuỗi hiển thị phân tách hàng nghìn bằng dấu chấm (VD: "1.000.000").
String formatMoneyInputDisplay(dynamic value, {bool allowNegative = false}) {
  if (allowNegative && (value?.toString().trim() == '-')) {
    return '-';
  }
  final clean = normalizeMoneyPropValue(value, allowNegative: allowNegative);
  if (clean.isEmpty) return '';
  if (clean.startsWith('-')) {
    return '-${groupDigitsWithDots(clean.substring(1))}';
  }
  return groupDigitsWithDots(clean);
}

/// Alias của [formatMoneyInputDisplay] dùng cho bản nháp hiển thị số tiền.
String formatMoneyDraftForDisplay(dynamic value, {bool allowNegative = false}) =>
    formatMoneyInputDisplay(value, allowNegative: allowNegative);

/// Kết quả phân tích chuỗi nhập tiền tệ của người dùng.
class MoneyUserEditResult {
  final String rawValue;
  final String displayValue;
  final int nextCaretIndex;
  final bool isTransientMinus;

  const MoneyUserEditResult({
    required this.rawValue,
    required this.displayValue,
    required this.nextCaretIndex,
    required this.isTransientMinus,
  });
}

/// Phân tích chuỗi người dùng vừa gõ/sửa trong ô input và tính lại vị trí con trỏ chính xác.
MoneyUserEditResult parseMoneyUserEdit(
  String? displayText,
  int? caretIndex, {
  bool allowNegative = false,
}) {
  final str = displayText ?? '';
  final safeCaret = caretIndex == null ? str.length : caretIndex.clamp(0, str.length);

  final hasLeadingMinus = allowNegative && RegExp(r'^\s*-').hasMatch(str);
  final digitsAll = str.replaceAll(RegExp(r'\D'), '');

  if (digitsAll.isEmpty) {
    if (hasLeadingMinus) {
      return const MoneyUserEditResult(
        rawValue: '',
        displayValue: '-',
        nextCaretIndex: 1,
        isTransientMinus: true,
      );
    }
    return const MoneyUserEditResult(
      rawValue: '',
      displayValue: '',
      nextCaretIndex: 0,
      isTransientMinus: false,
    );
  }

  // Đếm số chữ số nằm trước vị trí con trỏ hiện tại
  final prefix = str.substring(0, safeCaret);
  final digitsBeforeCaret = prefix.replaceAll(RegExp(r'\D'), '').length;

  final strippedDigits = digitsAll.replaceFirst(RegExp(r'^0+'), '');
  if (strippedDigits.isEmpty) {
    // Mọi chữ số đều là 0 -> thu gọn thành "0", đặt con trỏ cuối "0"
    return const MoneyUserEditResult(
      rawValue: '0',
      displayValue: '0',
      nextCaretIndex: 1,
      isTransientMinus: false,
    );
  }

  final leadingZerosRemoved = digitsAll.length - strippedDigits.length;
  final effectiveDigitsBefore = max(0, digitsBeforeCaret - leadingZerosRemoved);
  final sigCountBefore = (hasLeadingMinus ? 1 : 0) + effectiveDigitsBefore;

  final rawValue = hasLeadingMinus ? '-$strippedDigits' : strippedDigits;
  final displayValue = hasLeadingMinus
      ? '-${groupDigitsWithDots(strippedDigits)}'
      : groupDigitsWithDots(strippedDigits);

  final nextCaretIndex = (hasLeadingMinus && effectiveDigitsBefore == 0 && prefix.contains('-'))
      ? 1
      : caretAfterSignificantChars(displayValue, sigCountBefore);

  return MoneyUserEditResult(
    rawValue: rawValue,
    displayValue: displayValue,
    nextCaretIndex: nextCaretIndex,
    isTransientMinus: false,
  );
}

/// Kết quả xử lý phím xóa khi con trỏ đứng sát dấu phân cách `.`.
class MoneySeparatorKeyResult {
  final bool handled;
  final String? rawValue;
  final String? displayValue;
  final int? nextCaretIndex;
  final bool? isTransientMinus;

  const MoneySeparatorKeyResult({
    required this.handled,
    this.rawValue,
    this.displayValue,
    this.nextCaretIndex,
    this.isTransientMinus,
  });
}

/// Xử lý phím Backspace / Delete khi con trỏ đứng sát dấu chấm phân cách `.`
/// để xóa chữ số liền kề thay vì bị kẹt trên dấu chấm.
MoneySeparatorKeyResult handleMoneySeparatorKey(
  String? displayText,
  int? selectionStart,
  int? selectionEnd,
  String key, {
  bool allowNegative = false,
}) {
  final str = displayText ?? '';
  if (selectionStart != selectionEnd || selectionStart == null) {
    return const MoneySeparatorKeyResult(handled: false);
  }

  if (key == 'Backspace' && selectionStart >= 2 && str[selectionStart - 1] == '.') {
    // Xóa chữ số ngay trước dấu chấm (tại selectionStart - 2)
    final nextStr = str.substring(0, selectionStart - 2) + str.substring(selectionStart);
    final parsed = parseMoneyUserEdit(nextStr, selectionStart - 2, allowNegative: allowNegative);
    return MoneySeparatorKeyResult(
      handled: true,
      rawValue: parsed.rawValue,
      displayValue: parsed.displayValue,
      nextCaretIndex: parsed.nextCaretIndex,
      isTransientMinus: parsed.isTransientMinus,
    );
  }

  if (key == 'Delete' && selectionStart < str.length - 1 && str[selectionStart] == '.') {
    // Xóa chữ số ngay sau dấu chấm (tại selectionStart + 1)
    final nextStr = str.substring(0, selectionStart) + str.substring(selectionStart + 2);
    final parsed = parseMoneyUserEdit(nextStr, selectionStart, allowNegative: allowNegative);
    return MoneySeparatorKeyResult(
      handled: true,
      rawValue: parsed.rawValue,
      displayValue: parsed.displayValue,
      nextCaretIndex: parsed.nextCaretIndex,
      isTransientMinus: parsed.isTransientMinus,
    );
  }

  return const MoneySeparatorKeyResult(handled: false);
}
