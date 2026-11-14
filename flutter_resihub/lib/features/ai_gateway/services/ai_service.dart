import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/network/dio_client.dart';
import '../../../core/utils/idempotency.dart';

/// Service interfacing with ResiHub AI Gateway endpoints.
/// Port of `frontend/src/services/ai.service.js`.
class AiService {
  final Dio dio;

  AiService({required this.dio});

  /// Extracts structured documents (CCCD/Passport, Contracts) with Gemini Vision.
  /// POST /api/v1/ai/extract
  Future<dynamic> extractDocument(
    dynamic payload, {
    Options? options,
    String? idempotencyKey,
  }) {
    return dio
        .post<dynamic>(
          '/api/v1/ai/extract',
          data: payload,
          options: withIdempotencyOptions(options, idempotencyKey: idempotencyKey),
        )
        .then((r) => r.data);
  }

  /// OCRs utility meter counters (electric/water) from camera captures.
  /// POST /api/v1/ai/meter-ocr
  Future<dynamic> ocrMeterReading(
    dynamic payload, {
    Options? options,
    String? idempotencyKey,
  }) {
    return dio
        .post<dynamic>(
          '/api/v1/ai/meter-ocr',
          data: payload,
          options: withIdempotencyOptions(options, idempotencyKey: idempotencyKey),
        )
        .then((r) => r.data);
  }

  /// Classifies resident service requests / support tickets into department & priority.
  /// POST /api/v1/ai/classify
  Future<dynamic> classifyServiceRequest(
    dynamic payload, {
    Options? options,
    String? idempotencyKey,
  }) {
    return dio
        .post<dynamic>(
          '/api/v1/ai/classify',
          data: payload,
          options: withIdempotencyOptions(options, idempotencyKey: idempotencyKey),
        )
        .then((r) => r.data);
  }

  /// Reviews AI suggestions (ACCEPT, REJECT, or OVERRIDE).
  /// POST /api/v1/ai/suggestions/:id/review
  Future<dynamic> reviewSuggestion(
    String id,
    dynamic payload, {
    Options? options,
    String? idempotencyKey,
  }) {
    return dio
        .post<dynamic>(
          '/api/v1/ai/suggestions/$id/review',
          data: payload,
          options: withIdempotencyOptions(options, idempotencyKey: idempotencyKey),
        )
        .then((r) => r.data);
  }

  /// Retrieves monthly token & cost usage summaries for AI services.
  /// GET /api/v1/ai/usage
  Future<dynamic> getUsageSummary({
    dynamic params,
    Options? options,
  }) {
    return dio
        .get<dynamic>(
          '/api/v1/ai/usage',
          queryParameters: params is Map<String, dynamic>
              ? params
              : params is Map
                  ? Map<String, dynamic>.from(params)
                  : null,
          options: options,
        )
        .then((r) => r.data);
  }
}

/// Riverpod provider for [AiService].
final aiServiceProvider = Provider<AiService>((ref) {
  final dio = ref.watch(dioProvider);
  return AiService(dio: dio);
});
