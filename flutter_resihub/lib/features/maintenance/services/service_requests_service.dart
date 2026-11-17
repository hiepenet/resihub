import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/network/dio_client.dart';
import '../../../core/network/query_cache.dart';
import '../../../core/utils/idempotency.dart';

const Duration kServiceRequestsTtl = Duration(milliseconds: 20000);

/// Dịch vụ Yêu cầu Bảo trì & Báo hỏng (M11).
/// Port of `frontend/src/services/serviceRequests.service.js`.
class ServiceRequestsService {
  final Dio dio;
  final QueryCache? queryCache;

  ServiceRequestsService({
    required this.dio,
    this.queryCache,
  });

  Future<T> _cachedFetch<T>(
    String logicalKey,
    Future<T> Function() fetcher, {
    Duration ttl = kServiceRequestsTtl,
    bool force = false,
  }) {
    if (queryCache != null) {
      return queryCache!.cachedFetch<T>(logicalKey, fetcher, ttl: ttl, force: force);
    }
    return fetcher();
  }

  // ---------------------------------------------------------------------------
  // Cache peek helpers
  // ---------------------------------------------------------------------------

  dynamic peekList([Map<String, dynamic>? params]) =>
      queryCache?.peek<dynamic>(buildCacheKey('serviceRequests', {'op': 'list', ...?params}))?.data;

  dynamic peekById(String? id) =>
      id != null && id.isNotEmpty
          ? queryCache?.peek<dynamic>(buildCacheKey('serviceRequests', {'op': 'detail', 'id': id}))?.data
          : null;

  // ---------------------------------------------------------------------------
  // 6 Primary Service Methods
  // ---------------------------------------------------------------------------

  /// Danh sách yêu cầu bảo trì kèm lọc theo tòa, phòng, trạng thái, SLA, tìm kiếm.
  /// GET /api/v1/service-requests
  Future<dynamic> list([Map<String, dynamic>? params, Map<String, dynamic>? options]) {
    final force = options?['force'] == true;
    return _cachedFetch(
      buildCacheKey('serviceRequests', {'op': 'list', ...?params}),
      () => dio.get<dynamic>('/api/v1/service-requests', queryParameters: params).then((r) => r.data),
      ttl: kServiceRequestsTtl,
      force: force,
    );
  }

  /// Chi tiết yêu cầu bảo trì theo ID.
  /// GET /api/v1/service-requests/:id
  Future<dynamic> getById(String id, [Map<String, dynamic>? options]) {
    final force = options?['force'] == true;
    return _cachedFetch(
      buildCacheKey('serviceRequests', {'op': 'detail', 'id': id}),
      () => dio.get<dynamic>('/api/v1/service-requests/$id').then((r) => r.data),
      ttl: kServiceRequestsTtl,
      force: force,
    );
  }

  /// Tạo yêu cầu bảo trì mới (kèm hỗ trợ Idempotency-Key).
  /// POST /api/v1/service-requests
  Future<dynamic> create(Map<String, dynamic> payload, [Map<String, dynamic>? options]) {
    final idempotencyKey = options?['idempotencyKey']?.toString();
    return dio
        .post<dynamic>(
          '/api/v1/service-requests',
          data: payload,
          options: withIdempotencyOptions(null, idempotencyKey: idempotencyKey),
        )
        .then((r) => r.data);
  }

  /// Cập nhật tiến độ / trạng thái xử lý kỹ thuật (kèm Idempotency-Key).
  /// PATCH /api/v1/service-requests/:id/status
  Future<dynamic> updateStatus(String id, Map<String, dynamic> payload, [Map<String, dynamic>? options]) {
    final idempotencyKey = options?['idempotencyKey']?.toString();
    return dio
        .patch<dynamic>(
          '/api/v1/service-requests/$id/status',
          data: payload,
          options: withIdempotencyOptions(null, idempotencyKey: idempotencyKey),
        )
        .then((r) => r.data);
  }

  /// Áp dụng đề xuất phân loại & điều phối của AI (kèm Idempotency-Key).
  /// POST /api/v1/service-requests/:id/apply-triage
  Future<dynamic> applyTriage(String id, Map<String, dynamic> payload, [Map<String, dynamic>? options]) {
    final idempotencyKey = options?['idempotencyKey']?.toString();
    return dio
        .post<dynamic>(
          '/api/v1/service-requests/$id/apply-triage',
          data: payload,
          options: withIdempotencyOptions(null, idempotencyKey: idempotencyKey),
        )
        .then((r) => r.data);
  }

  /// Đánh giá chất lượng nghiệm thu từ cư dân (kèm Idempotency-Key).
  /// POST /api/v1/service-requests/:id/rating
  Future<dynamic> rate(String id, Map<String, dynamic> payload, [Map<String, dynamic>? options]) {
    final idempotencyKey = options?['idempotencyKey']?.toString();
    return dio
        .post<dynamic>(
          '/api/v1/service-requests/$id/rating',
          data: payload,
          options: withIdempotencyOptions(null, idempotencyKey: idempotencyKey),
        )
        .then((r) => r.data);
  }
}

/// Riverpod provider cho [ServiceRequestsService].
final serviceRequestsServiceProvider = Provider<ServiceRequestsService>((ref) {
  final dio = ref.watch(dioProvider);
  final queryCache = ref.watch(queryCacheProvider);
  return ServiceRequestsService(dio: dio, queryCache: queryCache);
});
