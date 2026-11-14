import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/constants/api_endpoints.dart';
import '../../../core/network/dio_client.dart';

/// Authentication API service matching `frontend/src/services/auth.service.js`.
/// Implements all 11 endpoints with exact HTTP verbs, endpoints and response data extraction.
class AuthService {
  final Dio _dio;
  final Dio _publicDio;

  AuthService({
    required Dio dio,
    Dio? publicDio,
  })  : _dio = dio,
        _publicDio = publicDio ?? dio;

  /// GET /api/v1/auth/public-config
  Future<dynamic> getPublicConfig() async {
    final response = await _publicDio.get<dynamic>(ApiEndpoints.authPublicConfig);
    return response.data;
  }

  /// POST /api/v1/auth/login
  Future<dynamic> loginEmail(String email, String password) async {
    final response = await _dio.post<dynamic>(
      ApiEndpoints.authLogin,
      data: {'email': email, 'password': password},
    );
    return response.data;
  }

  /// POST /api/v1/auth/otp/request
  Future<dynamic> requestOtp(String phone) async {
    final response = await _dio.post<dynamic>(
      ApiEndpoints.authOtpRequest,
      data: {'phone': phone},
    );
    return response.data;
  }

  /// POST /api/v1/auth/otp/verify
  Future<dynamic> verifyOtp(String phone, String otp) async {
    final response = await _dio.post<dynamic>(
      ApiEndpoints.authOtpVerify,
      data: {'phone': phone, 'otp': otp},
    );
    return response.data;
  }

  /// GET /api/v1/auth/me
  Future<dynamic> me() async {
    final response = await _dio.get<dynamic>(ApiEndpoints.authMe);
    return response.data;
  }

  /// GET /api/v1/auth/profile
  Future<dynamic> getProfile() async {
    final response = await _dio.get<dynamic>(ApiEndpoints.authProfile);
    return response.data;
  }

  /// PATCH /api/v1/auth/profile
  Future<dynamic> updateProfile(Map<String, dynamic> payload) async {
    final response = await _dio.patch<dynamic>(
      ApiEndpoints.authProfile,
      data: payload,
    );
    return response.data;
  }

  /// POST /api/v1/auth/change-password
  Future<dynamic> changePassword(String currentPassword, String newPassword) async {
    final response = await _dio.post<dynamic>(
      ApiEndpoints.authChangePassword,
      data: {'currentPassword': currentPassword, 'newPassword': newPassword},
    );
    return response.data;
  }

  /// POST /api/v1/auth/forgot-password
  Future<dynamic> forgotPassword(String email) async {
    final response = await _dio.post<dynamic>(
      ApiEndpoints.authForgotPassword,
      data: {'email': email},
    );
    return response.data;
  }

  /// POST /api/v1/auth/reset-password
  Future<dynamic> resetPassword({
    required String email,
    required String code,
    required String newPassword,
  }) async {
    final response = await _dio.post<dynamic>(
      ApiEndpoints.authResetPassword,
      data: {
        'email': email,
        'code': code,
        'newPassword': newPassword,
      },
    );
    return response.data;
  }

  /// POST /api/v1/auth/logout
  Future<dynamic> logout() async {
    final response = await _dio.post<dynamic>(ApiEndpoints.authLogout);
    return response.data;
  }
}

/// Provider for [AuthService].
final authServiceProvider = Provider<AuthService>((ref) {
  final dio = ref.watch(dioProvider);
  final publicDio = ref.watch(publicDioProvider);
  return AuthService(dio: dio, publicDio: publicDio);
});
