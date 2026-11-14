import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:uuid/uuid.dart';

import '../../../core/network/dio_client.dart';
import '../../../core/network/query_cache.dart';

const Duration kContractsTtl = Duration(milliseconds: 25000);

String createIdempotencyKey() {
  return const Uuid().v4();
}

Options _withIdempotency(Options? options, [String? idempotencyKey]) {
  final opts = options?.copyWith() ?? Options();
  final headers = Map<String, dynamic>.from(opts.headers ?? {});
  headers['Idempotency-Key'] = idempotencyKey ?? createIdempotencyKey();
  return opts.copyWith(headers: headers);
}

Map<String, dynamic> _buildListParts(dynamic params) {
  final map = <String, dynamic>{'op': 'list'};
  if (params is Map) {
    for (final e in params.entries) {
      map[e.key.toString()] = e.value;
    }
  }
  return map;
}

Map<String, dynamic> _buildRequestsParts(dynamic params) {
  final map = <String, dynamic>{'op': 'requests'};
  if (params is Map) {
    for (final e in params.entries) {
      map[e.key.toString()] = e.value;
    }
  }
  return map;
}

/// Comprehensive Contracts Management Service.
/// Implements 29 executable methods + 3 cache peek helpers matching `frontend/src/services/contracts.service.js`.
class ContractsService {
  final Dio dio;
  final QueryCache? queryCache;

  ContractsService({
    required this.dio,
    this.queryCache,
  });

  Future<T> _cachedFetch<T>(
    String logicalKey,
    Future<T> Function() fetcher, {
    Duration ttl = kContractsTtl,
    bool force = false,
  }) {
    if (queryCache != null) {
      return queryCache!.cachedFetch<T>(logicalKey, fetcher, ttl: ttl, force: force);
    }
    return fetcher();
  }

  // 1. List
  dynamic peekList([dynamic params]) =>
      queryCache?.peek<dynamic>(buildCacheKey('contracts', _buildListParts(params)))?.data;

  Future<dynamic> list([dynamic params, Options? options, bool force = false]) {
    final queryParams = params is Map<String, dynamic>
        ? params
        : params is Map
            ? Map<String, dynamic>.from(params)
            : null;

    return _cachedFetch(
      buildCacheKey('contracts', _buildListParts(params)),
      () => dio
          .get<dynamic>(
            '/api/v1/contracts',
            queryParameters: queryParams,
            options: options,
          )
          .then((r) => r.data),
      ttl: kContractsTtl,
      force: force,
    );
  }

  // 2. Get by ID
  dynamic peekById(String? id) =>
      id != null && id.isNotEmpty
          ? queryCache?.peek<dynamic>(buildCacheKey('contracts', {'op': 'detail', 'id': id}))?.data
          : null;

  Future<dynamic> getById(String id, {Options? options, bool force = false}) {
    return _cachedFetch(
      buildCacheKey('contracts', {'op': 'detail', 'id': id}),
      () => dio
          .get<dynamic>(
            '/api/v1/contracts/$id',
            options: options,
          )
          .then((r) => r.data),
      ttl: kContractsTtl,
      force: force,
    );
  }

  // 3. List Requests
  dynamic peekRequests([dynamic params]) =>
      queryCache?.peek<dynamic>(buildCacheKey('contracts', _buildRequestsParts(params)))?.data;

  Future<dynamic> listRequests([dynamic params, Options? options, bool force = false]) {
    final queryParams = params is Map<String, dynamic>
        ? params
        : params is Map
            ? Map<String, dynamic>.from(params)
            : null;

    return _cachedFetch(
      buildCacheKey('contracts', _buildRequestsParts(params)),
      () => dio
          .get<dynamic>(
            '/api/v1/contracts/requests',
            queryParameters: queryParams,
            options: options,
          )
          .then((r) => r.data),
      ttl: kContractsTtl,
      force: force,
    );
  }

  // 4. Create
  Future<dynamic> create(dynamic payload, {Options? options, String? idempotencyKey}) {
    return dio
        .post<dynamic>(
          '/api/v1/contracts',
          data: payload,
          options: _withIdempotency(options, idempotencyKey),
        )
        .then((r) => r.data);
  }

  // 5. Update
  Future<dynamic> update(String id, dynamic payload, {Options? options}) {
    return dio
        .patch<dynamic>(
          '/api/v1/contracts/$id',
          data: payload,
          options: options,
        )
        .then((r) => r.data);
  }

  // 6. Activate
  Future<dynamic> activate(
    String id, [
    dynamic payload = const {},
    Options? options,
    String? idempotencyKey,
  ]) {
    return dio
        .post<dynamic>(
          '/api/v1/contracts/$id/activate',
          data: payload ?? const {},
          options: _withIdempotency(options, idempotencyKey),
        )
        .then((r) => r.data);
  }

  // 7. Approve
  Future<dynamic> approve(
    String id, [
    dynamic payload = const {},
    Options? options,
    String? idempotencyKey,
  ]) {
    return dio
        .post<dynamic>(
          '/api/v1/contracts/$id/approve',
          data: payload ?? const {},
          options: _withIdempotency(options, idempotencyKey),
        )
        .then((r) => r.data);
  }

  // 8. Reject
  Future<dynamic> reject(String id, dynamic payload, {Options? options}) {
    return dio
        .post<dynamic>(
          '/api/v1/contracts/$id/reject',
          data: payload,
          options: options,
        )
        .then((r) => r.data);
  }

  // 9. RejectContract (Alias accepting String reason or Map payload)
  Future<dynamic> rejectContract(String id, dynamic reason, {Options? options}) {
    final payload = reason is String ? {'reason': reason} : reason;
    return dio
        .post<dynamic>(
          '/api/v1/contracts/$id/reject',
          data: payload,
          options: options,
        )
        .then((r) => r.data);
  }

  // 10. Cancel
  Future<dynamic> cancel(String id, [dynamic payload = const {}, Options? options]) {
    return dio
        .post<dynamic>(
          '/api/v1/contracts/$id/cancel',
          data: payload ?? const {},
          options: options,
        )
        .then((r) => r.data);
  }

  // 11. Upload Scan
  Future<dynamic> uploadScan(String id, dynamic payload, {Options? options}) {
    return dio
        .post<dynamic>(
          '/api/v1/contracts/$id/scan',
          data: payload,
          options: options,
        )
        .then((r) => r.data);
  }

  // 12. Terminate
  Future<dynamic> terminate(
    String id,
    dynamic payload, {
    Options? options,
    String? idempotencyKey,
  }) {
    return dio
        .post<dynamic>(
          '/api/v1/contracts/$id/terminate',
          data: payload,
          options: _withIdempotency(options, idempotencyKey),
        )
        .then((r) => r.data);
  }

  // 13. Approve Termination
  Future<dynamic> approveTermination(String id, [dynamic payload = const {}, Options? options]) {
    return dio
        .post<dynamic>(
          '/api/v1/contracts/$id/terminate/approve',
          data: payload ?? const {},
          options: options,
        )
        .then((r) => r.data);
  }

  // 14. Reject Termination
  Future<dynamic> rejectTermination(String id, dynamic payload, {Options? options}) {
    return dio
        .post<dynamic>(
          '/api/v1/contracts/$id/terminate/reject',
          data: payload,
          options: options,
        )
        .then((r) => r.data);
  }

  // 15. Renew
  Future<dynamic> renew(
    String id,
    dynamic payload, {
    Options? options,
    String? idempotencyKey,
  }) {
    return dio
        .post<dynamic>(
          '/api/v1/contracts/$id/renew',
          data: payload,
          options: _withIdempotency(options, idempotencyKey),
        )
        .then((r) => r.data);
  }

  // 16. Transfer Room
  Future<dynamic> transferRoom(
    String id,
    dynamic payload, {
    Options? options,
    String? idempotencyKey,
  }) {
    return dio
        .post<dynamic>(
          '/api/v1/contracts/$id/transfer-room',
          data: payload,
          options: _withIdempotency(options, idempotencyKey),
        )
        .then((r) => r.data);
  }

  // 17. List Occupants
  dynamic peekOccupants(String? id) =>
      id != null && id.isNotEmpty
          ? queryCache?.peek<dynamic>(buildCacheKey('contracts', {'op': 'occupants', 'id': id}))?.data
          : null;

  Future<dynamic> listOccupants(String id, {Options? options, bool force = false}) {
    return _cachedFetch(
      buildCacheKey('contracts', {'op': 'occupants', 'id': id}),
      () => dio
          .get<dynamic>(
            '/api/v1/contracts/$id/occupants',
            options: options,
          )
          .then((r) => r.data),
      ttl: kContractsTtl,
      force: force,
    );
  }

  // 18. Add Occupant
  Future<dynamic> addOccupant(String id, dynamic payload, {Options? options}) {
    return dio
        .post<dynamic>(
          '/api/v1/contracts/$id/occupants',
          data: payload,
          options: options,
        )
        .then((r) => r.data);
  }

  // 19. Remove Occupant
  Future<dynamic> removeOccupant(String id, String tenantId, {Options? options}) {
    return dio
        .delete<dynamic>(
          '/api/v1/contracts/$id/occupants/$tenantId',
          options: options,
        )
        .then((r) => r.data);
  }

  // 20. List Service Prices
  dynamic peekServicePrices(String? id) =>
      id != null && id.isNotEmpty
          ? queryCache?.peek<dynamic>(buildCacheKey('contracts', {'op': 'servicePrices', 'id': id}))?.data
          : null;

  Future<dynamic> listServicePrices(String id, {Options? options, bool force = false}) {
    return _cachedFetch(
      buildCacheKey('contracts', {'op': 'servicePrices', 'id': id}),
      () => dio
          .get<dynamic>(
            '/api/v1/contracts/$id/service-prices',
            options: options,
          )
          .then((r) => r.data),
      ttl: kContractsTtl,
      force: force,
    );
  }

  // 21. Add Service Price
  Future<dynamic> addServicePrice(String id, dynamic payload, {Options? options}) {
    return dio
        .post<dynamic>(
          '/api/v1/contracts/$id/service-prices',
          data: payload,
          options: options,
        )
        .then((r) => r.data);
  }

  // 22. Remove Service Price
  Future<dynamic> removeServicePrice(String id, String priceId, {Options? options}) {
    return dio
        .delete<dynamic>(
          '/api/v1/contracts/$id/service-prices/$priceId',
          options: options,
        )
        .then((r) => r.data);
  }

  // 23. List Amendments
  dynamic peekAmendments(String? id) =>
      id != null && id.isNotEmpty
          ? queryCache?.peek<dynamic>(buildCacheKey('contracts', {'op': 'amendments', 'id': id}))?.data
          : null;

  Future<dynamic> listAmendments(String id, {Options? options, bool force = false}) {
    return _cachedFetch(
      buildCacheKey('contracts', {'op': 'amendments', 'id': id}),
      () => dio
          .get<dynamic>(
            '/api/v1/contracts/$id/amendments',
            options: options,
          )
          .then((r) => r.data),
      ttl: kContractsTtl,
      force: force,
    );
  }

  // 24. Create Amendment
  Future<dynamic> createAmendment(String id, dynamic payload, {Options? options}) {
    return dio
        .post<dynamic>(
          '/api/v1/contracts/$id/amendments',
          data: payload,
          options: options,
        )
        .then((r) => r.data);
  }

  // 25. Approve Amendment
  Future<dynamic> approveAmendment(String id, String versionId, {Options? options}) {
    return dio
        .post<dynamic>(
          '/api/v1/contracts/$id/amendments/$versionId/approve',
          options: options,
        )
        .then((r) => r.data);
  }

  // 26. Reject Amendment
  Future<dynamic> rejectAmendment(
    String id,
    String versionId,
    dynamic payload, {
    Options? options,
  }) {
    return dio
        .post<dynamic>(
          '/api/v1/contracts/$id/amendments/$versionId/reject',
          data: payload,
          options: options,
        )
        .then((r) => r.data);
  }

  // 27. Approve Request
  Future<dynamic> approveRequest(String id, [dynamic payload = const {}, Options? options]) {
    return dio
        .post<dynamic>(
          '/api/v1/contracts/requests/$id/approve',
          data: payload ?? const {},
          options: options,
        )
        .then((r) => r.data);
  }

  // 28. Reject Request
  Future<dynamic> rejectRequest(String id, dynamic payload, {Options? options}) {
    return dio
        .post<dynamic>(
          '/api/v1/contracts/requests/$id/reject',
          data: payload,
          options: options,
        )
        .then((r) => r.data);
  }

  // 29. Get Template HTML (plain text response)
  Future<String> getTemplateHtml(String id, {Options? options}) {
    final opts = (options?.copyWith() ?? Options()).copyWith(
      responseType: ResponseType.plain,
    );
    return dio
        .get<String>(
          '/api/v1/contracts/$id/template',
          options: opts,
        )
        .then((r) => r.data ?? '');
  }
}

/// Riverpod provider for [ContractsService].
final contractsServiceProvider = Provider<ContractsService>((ref) {
  final dio = ref.watch(dioProvider);
  final queryCache = ref.watch(queryCacheProvider);
  return ContractsService(dio: dio, queryCache: queryCache);
});
