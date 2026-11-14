import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/network/dio_client.dart';
import '../../../core/network/query_cache.dart';
import '../../../core/utils/idempotency.dart';

const Duration kDepositsTtl = Duration(milliseconds: 20000);

/// Dịch vụ Quản lý Sổ cọc & Quyết toán 4 Mắt (M06).
/// Khớp 14 phương thức với `frontend/src/services/deposits.service.js`.
class DepositsService {
  final Dio dio;
  final QueryCache? queryCache;

  DepositsService({
    required this.dio,
    this.queryCache,
  });

  Future<T> _cachedFetch<T>(
    String logicalKey,
    Future<T> Function() fetcher, {
    Duration ttl = kDepositsTtl,
    bool force = false,
  }) {
    if (queryCache != null) {
      return queryCache!.cachedFetch<T>(logicalKey, fetcher, ttl: ttl, force: force);
    }
    return fetcher();
  }

  // 1. peekList & list
  dynamic peekList([Map<String, dynamic>? params]) {
    final query = <String, dynamic>{'op': 'list', if (params != null) ...params};
    return queryCache?.peek<dynamic>(buildCacheKey('deposits', query))?.data;
  }

  Future<dynamic> list([Map<String, dynamic>? params, bool force = false]) {
    final query = <String, dynamic>{'op': 'list', if (params != null) ...params};
    return _cachedFetch(
      buildCacheKey('deposits', query),
      () => dio.get<dynamic>('/api/v1/deposits', queryParameters: params).then((r) => r.data),
      ttl: kDepositsTtl,
      force: force,
    );
  }

  // 2. listTransactions
  Future<dynamic> listTransactions(String id) {
    return dio.get<dynamic>('/api/v1/deposits/$id/transactions').then((r) => r.data);
  }

  // 3. getAuditLogs
  Future<dynamic> getAuditLogs(String id) {
    return dio.get<dynamic>('/api/v1/deposits/$id/audit-logs').then((r) => r.data);
  }

  // 4. createTransaction
  Future<dynamic> createTransaction(
    String id,
    Map<String, dynamic> payload, [
    Options? options,
  ]) {
    return dio
        .post<dynamic>(
          '/api/v1/deposits/$id/transactions',
          data: payload,
          options: withIdempotencyOptions(options),
        )
        .then((r) => r.data);
  }

  // 5. getSettlement & getSettlementDetail alias
  Future<dynamic> getSettlement(String id) {
    return dio.get<dynamic>('/api/v1/deposits/$id/settlement').then((r) => r.data);
  }

  Future<dynamic> getSettlementDetail(String id) => getSettlement(id);

  // 6. submitSettlement
  Future<dynamic> submitSettlement(
    String id,
    Map<String, dynamic> payload, [
    Options? options,
  ]) {
    return dio
        .post<dynamic>(
          '/api/v1/deposits/$id/settlement',
          data: payload,
          options: withIdempotencyOptions(options),
        )
        .then((r) => r.data);
  }

  // 7. approveSettlement
  Future<dynamic> approveSettlement(
    String id, [
    Map<String, dynamic>? payload,
    Options? options,
  ]) {
    return dio
        .post<dynamic>(
          '/api/v1/deposits/$id/settlement/approve',
          data: payload ?? <String, dynamic>{},
          options: withIdempotencyOptions(options),
        )
        .then((r) => r.data);
  }

  // 8. rejectSettlement
  Future<dynamic> rejectSettlement(
    String id,
    Map<String, dynamic> payload, [
    Options? options,
  ]) {
    return dio
        .post<dynamic>(
          '/api/v1/deposits/$id/settlement/reject',
          data: payload,
          options: withIdempotencyOptions(options),
        )
        .then((r) => r.data);
  }

  // 9. dispute
  Future<dynamic> dispute(
    String id,
    Map<String, dynamic> payload, [
    Options? options,
  ]) {
    return dio
        .post<dynamic>(
          '/api/v1/deposits/$id/dispute',
          data: payload,
          options: withIdempotencyOptions(options),
        )
        .then((r) => r.data);
  }

  // 10. resolveDispute
  Future<dynamic> resolveDispute(
    String id,
    Map<String, dynamic> payload, [
    Options? options,
  ]) {
    return dio
        .post<dynamic>(
          '/api/v1/deposits/$id/resolve-dispute',
          data: payload,
          options: withIdempotencyOptions(options),
        )
        .then((r) => r.data);
  }

  // 11. executePayout
  Future<dynamic> executePayout(
    String id,
    Map<String, dynamic> payload, [
    Options? options,
  ]) {
    return dio
        .post<dynamic>(
          '/api/v1/deposits/$id/payout',
          data: payload,
          options: withIdempotencyOptions(options),
        )
        .then((r) => r.data);
  }

  // 12. markPayoutReturned
  Future<dynamic> markPayoutReturned(
    String id,
    Map<String, dynamic> payload, [
    Options? options,
  ]) {
    return dio
        .post<dynamic>(
          '/api/v1/deposits/$id/payout-returned',
          data: payload,
          options: withIdempotencyOptions(options),
        )
        .then((r) => r.data);
  }

  // 13. updateRefundBankInfo
  Future<dynamic> updateRefundBankInfo(
    String id,
    Map<String, dynamic> payload, [
    Options? options,
  ]) {
    return dio
        .patch<dynamic>(
          '/api/v1/deposits/$id/bank-info',
          data: payload,
          options: withIdempotencyOptions(options),
        )
        .then((r) => r.data);
  }

  // 14. getSettlementPdfHtml
  Future<String> getSettlementPdfHtml(String id) {
    return dio
        .get<String>(
          '/api/v1/deposits/$id/settlement/pdf',
          options: Options(responseType: ResponseType.plain),
        )
        .then((r) => r.data ?? '');
  }
}

/// Provider cho [DepositsService].
final depositsServiceProvider = Provider<DepositsService>((ref) {
  final dio = ref.watch(dioProvider);
  final queryCache = ref.watch(queryCacheProvider);
  return DepositsService(dio: dio, queryCache: queryCache);
});
