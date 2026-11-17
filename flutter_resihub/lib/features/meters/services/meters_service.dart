import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/constants/api_endpoints.dart';
import '../../../core/network/dio_client.dart';
import '../../../core/network/query_cache.dart';
import '../../../core/utils/idempotency.dart';

const Duration kMetersTtl = Duration(seconds: 20);

Map<String, dynamic> _buildParts(String op, dynamic params) {
  final map = <String, dynamic>{'op': op};
  if (params is Map) {
    for (final e in params.entries) {
      map[e.key.toString()] = e.value;
    }
  }
  return map;
}

/// Utility meters & meter readings API service.
/// Port of `frontend/src/services/meters.service.js`.
class MetersService {
  final Dio dio;
  final QueryCache? queryCache;

  MetersService({
    required this.dio,
    this.queryCache,
  });

  Future<T> _cachedFetch<T>(
    String logicalKey,
    Future<T> Function() fetcher, {
    Duration ttl = kMetersTtl,
    bool force = false,
  }) {
    if (queryCache != null) {
      return queryCache!.cachedFetch<T>(logicalKey, fetcher, ttl: ttl, force: force);
    }
    return fetcher();
  }

  // 1. peekList
  dynamic peekList([dynamic params]) =>
      queryCache?.peek<dynamic>(buildCacheKey('meters', _buildParts('list', params)))?.data;

  // 1. list (GET /api/v1/meters)
  Future<dynamic> list([dynamic params, Options? options, bool force = false]) {
    final queryParams = params is Map<String, dynamic>
        ? params
        : params is Map
            ? Map<String, dynamic>.from(params)
            : null;

    return _cachedFetch(
      buildCacheKey('meters', _buildParts('list', params)),
      () => dio
          .get<dynamic>(
            ApiEndpoints.meters,
            queryParameters: queryParams,
            options: options,
          )
          .then((r) => r.data),
      ttl: kMetersTtl,
      force: force,
    );
  }

  // 2. create (POST /api/v1/meters)
  Future<dynamic> create(
    dynamic payload, {
    Options? options,
    String? idempotencyKey,
  }) {
    return dio
        .post<dynamic>(
          ApiEndpoints.meters,
          data: payload,
          options: withIdempotencyOptions(options, idempotencyKey: idempotencyKey),
        )
        .then((r) => r.data);
  }

  // 3. peekReadings
  dynamic peekReadings([dynamic params]) =>
      queryCache?.peek<dynamic>(buildCacheKey('meters', _buildParts('readings', params)))?.data;

  // 3. listReadings (GET /api/v1/meters/readings)
  Future<dynamic> listReadings([dynamic params, Options? options, bool force = false]) {
    final queryParams = params is Map<String, dynamic>
        ? params
        : params is Map
            ? Map<String, dynamic>.from(params)
            : null;

    return _cachedFetch(
      buildCacheKey('meters', _buildParts('readings', params)),
      () => dio
          .get<dynamic>(
            '${ApiEndpoints.meters}/readings',
            queryParameters: queryParams,
            options: options,
          )
          .then((r) => r.data),
      ttl: kMetersTtl,
      force: force,
    );
  }

  // 4. listMeterReadings (GET /api/v1/meters/:id/readings)
  Future<dynamic> listMeterReadings(String id, {Options? options}) {
    return dio
        .get<dynamic>(
          '${ApiEndpoints.meters}/$id/readings',
          options: options,
        )
        .then((r) => r.data);
  }

  // 5. recordReading (POST /api/v1/meters/:id/readings)
  Future<dynamic> recordReading(
    String id,
    dynamic payload, {
    Options? options,
    String? idempotencyKey,
  }) {
    return dio
        .post<dynamic>(
          '${ApiEndpoints.meters}/$id/readings',
          data: payload,
          options: withIdempotencyOptions(options, idempotencyKey: idempotencyKey),
        )
        .then((r) => r.data);
  }

  // 6. recordBatch (POST /api/v1/meters/readings/batch)
  Future<dynamic> recordBatch(
    dynamic payload, {
    Options? options,
    String? idempotencyKey,
  }) {
    return dio
        .post<dynamic>(
          '${ApiEndpoints.meters}/readings/batch',
          data: payload,
          options: withIdempotencyOptions(options, idempotencyKey: idempotencyKey),
        )
        .then((r) => r.data);
  }

  // 7. confirmReading (POST /api/v1/meters/readings/:readingId/confirm)
  Future<dynamic> confirmReading(
    String readingId, [
    dynamic payload = const {},
    Options? options,
    String? idempotencyKey,
  ]) {
    return dio
        .post<dynamic>(
          '${ApiEndpoints.meters}/readings/$readingId/confirm',
          data: payload,
          options: withIdempotencyOptions(options, idempotencyKey: idempotencyKey),
        )
        .then((r) => r.data);
  }

  // 8. confirmBatch (POST /api/v1/meters/readings/confirm-batch)
  Future<dynamic> confirmBatch([
    dynamic payload = const {},
    Options? options,
    String? idempotencyKey,
  ]) {
    return dio
        .post<dynamic>(
          '${ApiEndpoints.meters}/readings/confirm-batch',
          data: payload,
          options: withIdempotencyOptions(options, idempotencyKey: idempotencyKey),
        )
        .then((r) => r.data);
  }
}

/// Riverpod provider for [MetersService].
final metersServiceProvider = Provider<MetersService>((ref) {
  final dio = ref.watch(dioProvider);
  final queryCache = ref.watch(queryCacheProvider);
  return MetersService(dio: dio, queryCache: queryCache);
});
