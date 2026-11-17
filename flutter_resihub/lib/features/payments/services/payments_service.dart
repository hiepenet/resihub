import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/constants/api_endpoints.dart';
import '../../../core/network/dio_client.dart';
import '../../../core/network/query_cache.dart';

const Duration kPaymentsTtl = Duration(milliseconds: 20000);

bool _extractForce(dynamic options) {
  if (options is bool) return options;
  if (options is Map && options['force'] == true) return true;
  return false;
}

/// Payments Service.
/// Port of `frontend/src/services/payments.service.js` with 9 core methods and peek helpers.
class PaymentsService {
  final Dio dio;
  final QueryCache? queryCache;

  PaymentsService({
    required this.dio,
    this.queryCache,
  });

  Future<T> _cachedFetch<T>(
    String logicalKey,
    Future<T> Function() fetcher, {
    Duration ttl = kPaymentsTtl,
    bool force = false,
  }) {
    if (queryCache != null) {
      return queryCache!.cachedFetch<T>(logicalKey, fetcher, ttl: ttl, force: force);
    }
    return fetcher();
  }

  // 1. peekList & list
  dynamic peekList([Map<String, dynamic>? params]) {
    final query = {'op': 'list', ...?params};
    return queryCache?.peek<dynamic>(buildCacheKey('payments', query))?.data;
  }

  Future<dynamic> list([Map<String, dynamic>? params, dynamic options]) {
    final query = {'op': 'list', ...?params};
    final force = _extractForce(options);
    return _cachedFetch(
      buildCacheKey('payments', query),
      () => dio
          .get<dynamic>(ApiEndpoints.payments, queryParameters: params)
          .then((r) => r.data),
      ttl: kPaymentsTtl,
      force: force,
    );
  }

  // 2. create
  Future<dynamic> create(Map<String, dynamic> payload) {
    return dio.post<dynamic>(ApiEndpoints.payments, data: payload).then((r) => r.data);
  }

  // 3. confirm
  Future<dynamic> confirm(String id, [Map<String, dynamic>? payload]) {
    return dio
        .patch<dynamic>('${ApiEndpoints.payments}/$id/confirm', data: payload ?? const {})
        .then((r) => r.data);
  }

  // 4. reject
  Future<dynamic> reject(String id, [Map<String, dynamic>? payload]) {
    return dio
        .patch<dynamic>('${ApiEndpoints.payments}/$id/reject', data: payload ?? const {})
        .then((r) => r.data);
  }

  // 5. peekReceivables & listReceivables
  dynamic peekReceivables([Map<String, dynamic>? params]) {
    final query = {'op': 'receivables', ...?params};
    return queryCache?.peek<dynamic>(buildCacheKey('payments', query))?.data;
  }

  Future<dynamic> listReceivables([Map<String, dynamic>? params, dynamic options]) {
    final query = {'op': 'receivables', ...?params};
    final force = _extractForce(options);
    return _cachedFetch(
      buildCacheKey('payments', query),
      () => dio
          .get<dynamic>(ApiEndpoints.receivables, queryParameters: params)
          .then((r) => r.data),
      ttl: kPaymentsTtl,
      force: force,
    );
  }

  // 6. peekCredits & getCredits
  dynamic peekCredits([Map<String, dynamic>? params]) {
    final query = {'op': 'credits', ...?params};
    return queryCache?.peek<dynamic>(buildCacheKey('payments', query))?.data;
  }

  Future<dynamic> getCredits([Map<String, dynamic>? params, dynamic options]) {
    final query = {'op': 'credits', ...?params};
    final force = _extractForce(options);
    return _cachedFetch(
      buildCacheKey('payments', query),
      () => dio
          .get<dynamic>('${ApiEndpoints.payments}/credits', queryParameters: params)
          .then((r) => r.data),
      ttl: kPaymentsTtl,
      force: force,
    );
  }

  // 7. requestCreditRefund
  Future<dynamic> requestCreditRefund(String creditId, Map<String, dynamic> payload) {
    return dio
        .post<dynamic>('${ApiEndpoints.payments}/credits/$creditId/refund', data: payload)
        .then((r) => r.data);
  }

  // 8. approveCreditRefund
  Future<dynamic> approveCreditRefund(String creditId) {
    return dio
        .post<dynamic>('${ApiEndpoints.payments}/credits/$creditId/refund/approve')
        .then((r) => r.data);
  }

  // 9. rejectCreditRefund
  Future<dynamic> rejectCreditRefund(String creditId, [Map<String, dynamic>? payload]) {
    return dio
        .post<dynamic>('${ApiEndpoints.payments}/credits/$creditId/refund/reject', data: payload ?? const {})
        .then((r) => r.data);
  }
}

/// Provider for PaymentsService.
final paymentsServiceProvider = Provider<PaymentsService>((ref) {
  final dio = ref.watch(dioProvider);
  final queryCache = ref.watch(queryCacheProvider);
  return PaymentsService(dio: dio, queryCache: queryCache);
});
