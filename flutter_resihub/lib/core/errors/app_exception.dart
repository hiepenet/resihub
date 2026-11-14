import 'package:dio/dio.dart';
import '../utils/validation.dart';

/// Structured application exception representing both network and domain failures.
class AppException implements Exception {
  final String message;
  final int? statusCode;
  final String? code;
  final dynamic details;
  final dynamic originalError;

  const AppException({
    required this.message,
    this.statusCode,
    this.code,
    this.details,
    this.originalError,
  });

  /// Creates a structured [AppException] from a [DioException].
  factory AppException.fromDioException(DioException e) {
    final statusCode = e.response?.statusCode;
    final data = e.response?.data;

    String? code;
    dynamic details;
    if (data is Map) {
      code = data['code']?.toString() ?? data['errorCode']?.toString();
      details = data['details'] ?? data['errors'];
    }

    String userMessage;

    switch (e.type) {
      case DioExceptionType.connectionTimeout:
      case DioExceptionType.sendTimeout:
      case DioExceptionType.receiveTimeout:
        userMessage = 'Kết nối mạng quá thời gian chờ, vui lòng kiểm tra mạng và thử lại.';
        break;
      case DioExceptionType.connectionError:
        userMessage = 'Không thể kết nối đến máy chủ, vui lòng kiểm tra đường truyền.';
        break;
      case DioExceptionType.cancel:
        userMessage = 'Yêu cầu đã bị hủy.';
        break;
      case DioExceptionType.badResponse:
        final extracted = extractErrorMessage(data);
        if (extracted.isNotEmpty && extracted != 'Đã xảy ra lỗi. Vui lòng thử lại.') {
          userMessage = extracted;
        } else {
          switch (statusCode) {
            case 400:
              userMessage = 'Dữ liệu yêu cầu không hợp lệ.';
              break;
            case 401:
              userMessage = 'Phiên đăng nhập đã hết hạn, vui lòng đăng nhập lại.';
              break;
            case 403:
              userMessage = 'Bạn không có quyền thực hiện thao tác này.';
              break;
            case 404:
              userMessage = 'Không tìm thấy tài nguyên yêu cầu.';
              break;
            case 409:
              userMessage = 'Dữ liệu bị trùng lặp hoặc xung đột.';
              break;
            case 422:
              userMessage = 'Dữ liệu không thể xử lý.';
              break;
            case 500:
            case 502:
            case 503:
            case 504:
              userMessage = 'Hệ thống đang gặp sự cố, vui lòng thử lại sau.';
              break;
            default:
              userMessage = 'Đã có lỗi xảy ra (${statusCode ?? 'không xác định'}).';
          }
        }
        break;
      default:
        final extracted = extractErrorMessage(e);
        userMessage = extracted.isNotEmpty
            ? extracted
            : 'Đã có lỗi xảy ra, vui lòng thử lại.';
    }

    return AppException(
      message: userMessage,
      statusCode: statusCode,
      code: code,
      details: details,
      originalError: e,
    );
  }

  @override
  String toString() => 'AppException(statusCode: $statusCode, code: $code, message: $message)';
}
