import 'package:dio/dio.dart';

/// Kiểm tra số điện thoại hợp lệ (chuẩn Việt Nam: đầu `0` hoặc `+84` kèm 9 số sau).
bool isValidPhone(String? phone) {
  if (phone == null) return false;
  final clean = phone.trim().replaceAll(RegExp(r'[\s\-\.\(\)]'), '');
  return RegExp(r'^(0|\+84)[0-9]{9}$').hasMatch(clean);
}

/// Chuẩn hóa số điện thoại: bỏ khoảng trắng/dấu gạch, chuyển `+84` thành `0`.
String normalizePhone(String? phone) {
  if (phone == null) return '';
  var clean = phone.trim().replaceAll(RegExp(r'[\s\-\.\(\)]'), '');
  if (clean.startsWith('+84')) {
    clean = '0${clean.substring(3)}';
  }
  return clean;
}

/// Kiểm tra địa chỉ email hợp lệ.
bool isValidEmail(String? email) {
  if (email == null) return false;
  final clean = email.trim();
  if (clean.isEmpty) return false;
  return RegExp(r'^[^\s@]+@[^\s@]+\.[^\s@]+$').hasMatch(clean);
}

/// Kiểm tra số CCCD (9 hoặc 12 số) hoặc số Hộ chiếu (1 chữ cái + 7 hoặc 8 số).
bool isValidIdNumber(String? idNumber) {
  if (idNumber == null) return false;
  final clean = idNumber.trim();
  if (clean.isEmpty) return false;
  return RegExp(r'^(\d{9}|\d{12}|[A-Z]\d{7,8})$', caseSensitive: false).hasMatch(clean);
}

/// Trích xuất thông báo lỗi thân thiện từ `DioException`, `Map`, `Exception` hoặc đối tượng lỗi bất kỳ.
String extractErrorMessage(dynamic err, [String fallback = 'Đã xảy ra lỗi. Vui lòng thử lại.']) {
  if (err == null) return fallback;
  if (err is DioException) {
    final data = err.response?.data;
    if (data is Map && data['message'] != null) {
      return data['message'].toString();
    }
    if (data is String && data.trim().isNotEmpty) {
      return data;
    }
    if (err.message != null && err.message!.trim().isNotEmpty) {
      return err.message!;
    }
  }
  if (err is Map) {
    if (err['message'] != null) return err['message'].toString();
    if (err['error'] != null) return err['error'].toString();
  }
  final str = err.toString();
  if (str.startsWith('Exception: ')) {
    return str.substring(11);
  }
  if (str.trim().isNotEmpty) {
    return str;
  }
  return fallback;
}
