import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/network/dio_client.dart';
import '../../../core/network/query_cache.dart';

const Duration kTenantsTtl = Duration(seconds: 60);

Map<String, dynamic> _buildListParts(dynamic params) {
  final map = <String, dynamic>{'op': 'list'};
  if (params is Map) {
    for (final e in params.entries) {
      map[e.key.toString()] = e.value;
    }
  }
  return map;
}

/// Tenant, Resident Profile, and Identity Document Service.
/// Port of `frontend/src/services/tenants.service.js`.
class TenantsService {
  final Dio dio;
  final QueryCache? queryCache;

  TenantsService({
    required this.dio,
    this.queryCache,
  });

  Future<T> _cachedFetch<T>(
    String logicalKey,
    Future<T> Function() fetcher, {
    Duration ttl = kTenantsTtl,
    bool force = false,
  }) {
    if (queryCache != null) {
      return queryCache!.cachedFetch<T>(logicalKey, fetcher, ttl: ttl, force: force);
    }
    return fetcher();
  }

  // 1. List
  dynamic peekList([dynamic params]) =>
      queryCache?.peek<dynamic>(buildCacheKey('tenants', _buildListParts(params)))?.data;

  Future<dynamic> list([dynamic params, Options? options, bool force = false]) {
    final queryParams = params is Map<String, dynamic>
        ? params
        : params is Map
            ? Map<String, dynamic>.from(params)
            : null;

    return _cachedFetch(
      buildCacheKey('tenants', _buildListParts(params)),
      () => dio
          .get<dynamic>(
            '/api/v1/tenants',
            queryParameters: queryParams,
            options: options,
          )
          .then((r) => r.data),
      ttl: kTenantsTtl,
      force: force,
    );
  }

  // 2. Get by ID
  dynamic peekById(String? id) =>
      id != null && id.isNotEmpty
          ? queryCache?.peek<dynamic>(buildCacheKey('tenants', {'op': 'detail', 'id': id}))?.data
          : null;

  Future<dynamic> getById(String id, {Options? options, bool force = false}) {
    return _cachedFetch(
      buildCacheKey('tenants', {'op': 'detail', 'id': id}),
      () => dio
          .get<dynamic>(
            '/api/v1/tenants/$id',
            options: options,
          )
          .then((r) => r.data),
      ttl: kTenantsTtl,
      force: force,
    );
  }

  // 3. Get ID Images
  dynamic peekIdImages(String? id) =>
      id != null && id.isNotEmpty
          ? queryCache?.peek<dynamic>(buildCacheKey('tenants', {'op': 'idImages', 'id': id}))?.data
          : null;

  Future<dynamic> getIdImages(String id, {Options? options, bool force = false}) {
    return _cachedFetch(
      buildCacheKey('tenants', {'op': 'idImages', 'id': id}),
      () => dio
          .get<dynamic>(
            '/api/v1/tenants/$id/id-images',
            options: options,
          )
          .then((r) => r.data),
      ttl: kTenantsTtl,
      force: force,
    );
  }

  // 4. Lookup
  Future<dynamic> lookup(String identifier, {Options? options}) {
    return dio
        .get<dynamic>(
          '/api/v1/tenants/lookup',
          queryParameters: {'identifier': identifier},
          options: options,
        )
        .then((r) => r.data);
  }

  // 5. Check Duplicate
  Future<dynamic> checkDup(dynamic params, {Options? options}) {
    final queryParams = params is Map<String, dynamic>
        ? params
        : params is Map
            ? Map<String, dynamic>.from(params)
            : null;

    return dio
        .get<dynamic>(
          '/api/v1/tenants/check-dup',
          queryParameters: queryParams,
          options: options,
        )
        .then((r) => r.data);
  }

  // 6. Create
  Future<dynamic> create(dynamic payload, {Options? options}) {
    return dio
        .post<dynamic>(
          '/api/v1/tenants',
          data: payload,
          options: options,
        )
        .then((r) => r.data);
  }

  // 7. Update
  Future<dynamic> update(String id, dynamic payload, {Options? options}) {
    return dio
        .patch<dynamic>(
          '/api/v1/tenants/$id',
          data: payload,
          options: options,
        )
        .then((r) => r.data);
  }

  // 8. Remove
  Future<dynamic> remove(String id, {Options? options}) {
    return dio
        .delete<dynamic>(
          '/api/v1/tenants/$id',
          options: options,
        )
        .then((r) => r.data);
  }

  // 9. Merge
  Future<dynamic> merge(dynamic payload, {Options? options}) {
    return dio
        .post<dynamic>(
          '/api/v1/tenants/merge',
          data: payload,
          options: options,
        )
        .then((r) => r.data);
  }

  // 10. Upload ID Image
  Future<dynamic> uploadIdImage(String id, dynamic payload, {Options? options}) {
    return dio
        .post<dynamic>(
          '/api/v1/tenants/$id/id-images',
          data: payload,
          options: options,
        )
        .then((r) => r.data);
  }

  // 11. Delete ID Image
  Future<dynamic> deleteIdImage(String id, String attachmentId, {Options? options}) {
    return dio
        .delete<dynamic>(
          '/api/v1/tenants/$id/id-images/$attachmentId',
          options: options,
        )
        .then((r) => r.data);
  }
}

/// Riverpod provider for [TenantsService].
final tenantsServiceProvider = Provider<TenantsService>((ref) {
  final dio = ref.watch(dioProvider);
  final queryCache = ref.watch(queryCacheProvider);
  return TenantsService(dio: dio, queryCache: queryCache);
});
