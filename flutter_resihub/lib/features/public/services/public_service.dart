import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/constants/api_endpoints.dart';
import '../../../core/network/dio_client.dart';
import '../../../core/utils/idempotency.dart';

/// Public service for browsing available apartments and creating reservations.
/// Matches `frontend/src/services/public.service.js`.
/// Uses [publicDioProvider] to ensure no stale Bearer JWT header is sent.
class PublicService {
  final Dio _dio;

  PublicService({required Dio dio}) : _dio = dio;

  /// GET /api/v1/public/apartments
  Future<dynamic> getApartments([Map<String, dynamic>? params]) async {
    final response = await _dio.get<dynamic>(
      '${ApiEndpoints.public}/apartments',
      queryParameters: params,
    );
    return response.data;
  }

  /// POST /api/v1/public/reservations/otp/request
  Future<dynamic> requestReservationOtp(String phone) async {
    final response = await _dio.post<dynamic>(
      '${ApiEndpoints.public}/reservations/otp/request',
      data: {'phone': phone},
    );
    return response.data;
  }

  /// POST /api/v1/public/reservations
  Future<dynamic> createReservation(
    Map<String, dynamic> payload, [
    Map<String, dynamic>? options,
  ]) async {
    final opts = withIdempotency(options);
    final headers = opts['headers'] is Map
        ? Map<String, dynamic>.from(opts['headers'] as Map)
        : <String, dynamic>{};

    final response = await _dio.post<dynamic>(
      '${ApiEndpoints.public}/reservations',
      data: payload,
      options: Options(headers: headers),
    );
    return response.data;
  }
}

/// Riverpod provider for [PublicService].
final publicServiceProvider = Provider<PublicService>((ref) {
  final dio = ref.watch(publicDioProvider);
  return PublicService(dio: dio);
});
