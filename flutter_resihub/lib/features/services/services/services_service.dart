import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/constants/api_endpoints.dart';
import '../../../core/network/dio_client.dart';
import '../../../core/network/query_cache.dart';

const Duration kCatalogTtl = Duration(milliseconds: 60000);
const Duration kSubscriptionsTtl = Duration(milliseconds: 25000);

Map<String, dynamic> _buildParts(String op, dynamic params) {
  final map = <String, dynamic>{'op': op};
  if (params is Map) {
    for (final e in params.entries) {
      map[e.key.toString()] = e.value;
    }
  }
  return map;
}

/// Service catalog & subscriptions API service.
/// Port of `frontend/src/services/services.service.js`.
class ServicesService {
  final Dio dio;
  final QueryCache? queryCache;

  ServicesService({
    required this.dio,
    this.queryCache,
  });

  Future<T> _cachedFetch<T>(
    String logicalKey,
    Future<T> Function() fetcher, {
    Duration ttl = kCatalogTtl,
    bool force = false,
  }) {
    if (queryCache != null) {
      return queryCache!.cachedFetch<T>(logicalKey, fetcher, ttl: ttl, force: force);
    }
    return fetcher();
  }

  // 1. peekCatalog
  dynamic peekCatalog([dynamic params]) =>
      queryCache?.peek<dynamic>(buildCacheKey('services', _buildParts('catalog', params)))?.data;

  // 1. listCatalog (GET /api/v1/service-catalog)
  Future<dynamic> listCatalog([dynamic params, Options? options, bool force = false]) {
    final queryParams = params is Map<String, dynamic>
        ? params
        : params is Map
            ? Map<String, dynamic>.from(params)
            : null;

    return _cachedFetch(
      buildCacheKey('services', _buildParts('catalog', params)),
      () => dio
          .get<dynamic>(
            ApiEndpoints.serviceCatalog,
            queryParameters: queryParams,
            options: options,
          )
          .then((r) => r.data),
      ttl: kCatalogTtl,
      force: force,
    );
  }

  // 2. createCatalog (POST /api/v1/service-catalog)
  Future<dynamic> createCatalog(dynamic payload, {Options? options}) {
    return dio
        .post<dynamic>(
          ApiEndpoints.serviceCatalog,
          data: payload,
          options: options,
        )
        .then((r) => r.data);
  }

  // 3. updateCatalog (PATCH /api/v1/service-catalog/:id)
  Future<dynamic> updateCatalog(String id, dynamic payload, {Options? options}) {
    return dio
        .patch<dynamic>(
          '${ApiEndpoints.serviceCatalog}/$id',
          data: payload,
          options: options,
        )
        .then((r) => r.data);
  }

  // 4. peekSubscriptions
  dynamic peekSubscriptions([dynamic params]) =>
      queryCache?.peek<dynamic>(buildCacheKey('services', _buildParts('subscriptions', params)))?.data;

  // 4. listSubscriptions (GET /api/v1/service-subscriptions)
  Future<dynamic> listSubscriptions([dynamic params, Options? options, bool force = false]) {
    final queryParams = params is Map<String, dynamic>
        ? params
        : params is Map
            ? Map<String, dynamic>.from(params)
            : null;

    return _cachedFetch(
      buildCacheKey('services', _buildParts('subscriptions', params)),
      () => dio
          .get<dynamic>(
            ApiEndpoints.serviceSubscriptions,
            queryParameters: queryParams,
            options: options,
          )
          .then((r) => r.data),
      ttl: kSubscriptionsTtl,
      force: force,
    );
  }

  // 5. createSubscription (POST /api/v1/service-subscriptions)
  Future<dynamic> createSubscription(dynamic payload, {Options? options}) {
    return dio
        .post<dynamic>(
          ApiEndpoints.serviceSubscriptions,
          data: payload,
          options: options,
        )
        .then((r) => r.data);
  }

  // 6. updateSubscription (PATCH /api/v1/service-subscriptions/:id)
  Future<dynamic> updateSubscription(String id, dynamic payload, {Options? options}) {
    return dio
        .patch<dynamic>(
          '${ApiEndpoints.serviceSubscriptions}/$id',
          data: payload,
          options: options,
        )
        .then((r) => r.data);
  }

  // 7. terminateSubscription (PATCH /api/v1/service-subscriptions/:id)
  Future<dynamic> terminateSubscription(String id, dynamic payload, {Options? options}) {
    return dio
        .patch<dynamic>(
          '${ApiEndpoints.serviceSubscriptions}/$id',
          data: payload,
          options: options,
        )
        .then((r) => r.data);
  }
}

/// Riverpod provider for [ServicesService].
final servicesServiceProvider = Provider<ServicesService>((ref) {
  final dio = ref.watch(dioProvider);
  final queryCache = ref.watch(queryCacheProvider);
  return ServicesService(dio: dio, queryCache: queryCache);
});
