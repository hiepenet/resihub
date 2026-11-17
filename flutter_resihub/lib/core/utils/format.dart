import 'dart:math';
import 'package:intl/intl.dart';
import 'date_range.dart';

/// Định dạng số tiền VND (VD: `1.000.000 ₫` hoặc `1.000.000`).
String formatMoney(dynamic amount, {bool showSymbol = true}) {
  if (amount == null) return showSymbol ? '0 ₫' : '0';
  final num? numVal = amount is num ? amount : num.tryParse(amount.toString());
  if (numVal == null || numVal.isNaN || numVal.isInfinite) {
    return showSymbol ? '0 ₫' : '0';
  }
  final rounded = numVal.round();
  final formatter = NumberFormat('#,##0', 'vi_VN');
  final formatted = formatter.format(rounded);
  return showSymbol ? '$formatted ₫' : formatted;
}

/// Định dạng số tiền rút gọn (tỷ, triệu) chuẩn tiếng Việt (VD: `1.50 tỷ ₫`, `2.5 tr ₫`).
String formatCompactMoney(dynamic amount) {
  if (amount == null) return '0 ₫';
  final num? numVal = amount is num ? amount : num.tryParse(amount.toString());
  if (numVal == null || numVal.isNaN || numVal.isInfinite) {
    return '0 ₫';
  }
  final absNum = numVal.abs();
  if (absNum >= 1000000000) {
    final valStr = (numVal / 1000000000).toStringAsFixed(2).replaceFirst(RegExp(r'\.00$'), '');
    return '$valStr tỷ ₫';
  }
  if (absNum >= 1000000) {
    final valStr = (numVal / 1000000).toStringAsFixed(1).replaceFirst(RegExp(r'\.0$'), '');
    return '$valStr tr ₫';
  }
  return formatMoney(numVal);
}

/// Định dạng ngày sang chuẩn Việt Nam: `dd/MM/yyyy`. Trả về `—` nếu null/rỗng/lỗi.
String formatDate(dynamic dateVal) {
  if (dateVal == null || dateVal == '') return '—';
  DateTime? dt;
  if (dateVal is DateTime) {
    dt = dateVal;
  } else {
    dt = DateTime.tryParse(dateVal.toString());
  }
  if (dt == null) return '—';
  if (dt.isUtc) {
    dt = dt.toLocal();
  }
  final day = dt.day.toString().padLeft(2, '0');
  final month = dt.month.toString().padLeft(2, '0');
  final year = dt.year.toString().padLeft(4, '0');
  return '$day/$month/$year';
}

/// Định dạng ngày giờ sang chuẩn Việt Nam: `dd/MM/yyyy HH:mm`. Trả về `—` nếu null/rỗng/lỗi.
String formatDateTime(dynamic dateVal) {
  if (dateVal == null || dateVal == '') return '—';
  DateTime? dt;
  if (dateVal is DateTime) {
    dt = dateVal;
  } else {
    dt = DateTime.tryParse(dateVal.toString());
  }
  if (dt == null) return '—';
  if (dt.isUtc) {
    dt = dt.toLocal();
  }
  final day = dt.day.toString().padLeft(2, '0');
  final month = dt.month.toString().padLeft(2, '0');
  final year = dt.year.toString().padLeft(4, '0');
  final hour = dt.hour.toString().padLeft(2, '0');
  final minute = dt.minute.toString().padLeft(2, '0');
  return '$day/$month/$year $hour:$minute';
}

/// Định dạng thời gian tương đối (VD: `Vừa xong`, `15 phút trước`, `3 giờ trước`, `2 ngày trước`).
String formatRelativeTime(dynamic dateVal, {DateTime? now}) {
  if (dateVal == null || dateVal == '') return '';
  DateTime? dt;
  if (dateVal is DateTime) {
    dt = dateVal;
  } else {
    dt = DateTime.tryParse(dateVal.toString());
  }
  if (dt == null) return '';
  if (dt.isUtc) {
    dt = dt.toLocal();
  }
  final current = now ?? DateTime.now();
  final diffSec = (current.millisecondsSinceEpoch - dt.millisecondsSinceEpoch) ~/ 1000;
  if (diffSec < 60) return 'Vừa xong';
  if (diffSec < 3600) return '${diffSec ~/ 60} phút trước';
  if (diffSec < 86400) return '${diffSec ~/ 3600} giờ trước';
  if (diffSec < 86400 * 7) return '${diffSec ~/ 86400} ngày trước';
  return formatDate(dt);
}

/// Chuẩn hóa ngày cho input date (`YYYY-MM-DD`).
String toInputDate(dynamic dateVal) => toDateOnlyStr(dateVal);

/// Lấy chu kỳ hiện tại dạng `YYYY-MM` theo giờ Việt Nam (Asia/Ho_Chi_Minh, UTC+7).
String getCurrentPeriod([DateTime? now]) {
  // Vietnam has no DST, so UTC+7 is exact. Mirrors React's Asia/Ho_Chi_Minh format.
  final dt = (now ?? DateTime.now()).toUtc().add(const Duration(hours: 7));
  final year = dt.year.toString().padLeft(4, '0');
  final month = dt.month.toString().padLeft(2, '0');
  return '$year-$month';
}

/// Che số điện thoại bảo mật (VD: `091****678`).
String maskPhone(dynamic phone) {
  final clean = phone?.toString().trim() ?? '';
  if (clean.isEmpty) return '—';
  if (clean.length <= 6) return '${clean.substring(0, 2)}***';
  return '${clean.substring(0, 3)}****${clean.substring(clean.length - 3)}';
}

/// Che CCCD / Hộ chiếu bảo mật (VD: `********8901`).
String maskIdNumber(dynamic idNumber) {
  final clean = idNumber?.toString().trim() ?? '';
  if (clean.isEmpty) return '—';
  if (clean.length <= 4) return '****$clean';
  final maskLen = max(4, clean.length - 4);
  return '${'*' * maskLen}${clean.substring(clean.length - 4)}';
}
