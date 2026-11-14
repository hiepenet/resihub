import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/network/dio_client.dart';
import '../../../core/network/query_cache.dart';

const Duration kInvoicesTtl = Duration(milliseconds: 20000);

bool _extractForce(dynamic options) {
  if (options is bool) return options;
  if (options is Map && options['force'] == true) return true;
  return false;
}

/// Invoices Service.
/// Port of `frontend/src/services/invoices.service.js` with 13 core methods and peek helpers.
class InvoicesService {
  final Dio dio;
  final QueryCache? queryCache;

  InvoicesService({
    required this.dio,
    this.queryCache,
  });

  Future<T> _cachedFetch<T>(
    String logicalKey,
    Future<T> Function() fetcher, {
    Duration ttl = kInvoicesTtl,
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
    return queryCache?.peek<dynamic>(buildCacheKey('invoices', query))?.data;
  }

  Future<dynamic> list([Map<String, dynamic>? params, dynamic options]) {
    final query = {'op': 'list', ...?params};
    final force = _extractForce(options);
    return _cachedFetch(
      buildCacheKey('invoices', query),
      () => dio
          .get<dynamic>('/api/v1/invoices', queryParameters: params)
          .then((r) => r.data),
      ttl: kInvoicesTtl,
      force: force,
    );
  }

  // 2. peekById & getById
  dynamic peekById(String? id) {
    if (id == null || id.isEmpty) return null;
    return queryCache?.peek<dynamic>(buildCacheKey('invoices', {'op': 'detail', 'id': id}))?.data;
  }

  Future<dynamic> getById(String id, [dynamic options]) {
    final force = _extractForce(options);
    return _cachedFetch(
      buildCacheKey('invoices', {'op': 'detail', 'id': id}),
      () => dio.get<dynamic>('/api/v1/invoices/$id').then((r) => r.data),
      ttl: kInvoicesTtl,
      force: force,
    );
  }

  // 3. generateBatch
  Future<dynamic> generateBatch(Map<String, dynamic> payload) {
    return dio.post<dynamic>('/api/v1/invoices/generate-batch', data: payload).then((r) => r.data);
  }

  // 4. updateStatus
  Future<dynamic> updateStatus(String id, Map<String, dynamic> payload) {
    return dio.patch<dynamic>('/api/v1/invoices/$id/status', data: payload).then((r) => r.data);
  }

  // 5. addLine (DRAFT Line editor)
  Future<dynamic> addLine(String invoiceId, Map<String, dynamic> payload) {
    return dio.post<dynamic>('/api/v1/invoices/$invoiceId/lines', data: payload).then((r) => r.data);
  }

  // 6. updateLine
  Future<dynamic> updateLine(String invoiceId, String lineId, Map<String, dynamic> payload) {
    return dio
        .patch<dynamic>('/api/v1/invoices/$invoiceId/lines/$lineId', data: payload)
        .then((r) => r.data);
  }

  // 7. deleteLine
  Future<dynamic> deleteLine(String invoiceId, String lineId) {
    return dio.delete<dynamic>('/api/v1/invoices/$invoiceId/lines/$lineId').then((r) => r.data);
  }

  // 8. issue (Contextual issue)
  Future<dynamic> issue(String invoiceId, [Map<String, dynamic>? payload]) {
    return dio
        .post<dynamic>('/api/v1/invoices/$invoiceId/issue', data: payload ?? const {})
        .then((r) => r.data);
  }

  // 9. requestAdjustment (4-eyes adjustment & 2-step VOID)
  Future<dynamic> requestAdjustment(String invoiceId, Map<String, dynamic> payload) {
    return dio.post<dynamic>('/api/v1/invoices/$invoiceId/adjust', data: payload).then((r) => r.data);
  }

  // 10. peekAdjustments & getAdjustments
  dynamic peekAdjustments([Map<String, dynamic>? params]) {
    final query = {'op': 'adjustments', ...?params};
    return queryCache?.peek<dynamic>(buildCacheKey('invoices', query))?.data;
  }

  Future<dynamic> getAdjustments([Map<String, dynamic>? params, dynamic options]) {
    final query = {'op': 'adjustments', ...?params};
    final force = _extractForce(options);
    return _cachedFetch(
      buildCacheKey('invoices', query),
      () => dio
          .get<dynamic>('/api/v1/invoices/adjustments', queryParameters: params)
          .then((r) => r.data),
      ttl: kInvoicesTtl,
      force: force,
    );
  }

  // 11. approveAdjustment
  Future<dynamic> approveAdjustment(String invoiceId, String adjId) {
    return dio
        .post<dynamic>('/api/v1/invoices/$invoiceId/adjustments/$adjId/approve')
        .then((r) => r.data);
  }

  // 12. rejectAdjustment
  Future<dynamic> rejectAdjustment(
    String invoiceId,
    String adjId, [
    Map<String, dynamic>? payload,
  ]) {
    return dio
        .post<dynamic>('/api/v1/invoices/$invoiceId/adjustments/$adjId/reject', data: payload ?? const {})
        .then((r) => r.data);
  }

  // 13. getAuditLogs
  Future<dynamic> getAuditLogs(String invoiceId) {
    return dio.get<dynamic>('/api/v1/invoices/$invoiceId/audit-logs').then((r) => r.data);
  }
}

/// Provider for InvoicesService.
final invoicesServiceProvider = Provider<InvoicesService>((ref) {
  final dio = ref.watch(dioProvider);
  final queryCache = ref.watch(queryCacheProvider);
  return InvoicesService(dio: dio, queryCache: queryCache);
});
