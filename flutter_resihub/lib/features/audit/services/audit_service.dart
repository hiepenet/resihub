import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/constants/api_endpoints.dart';
import '../../../core/network/dio_client.dart';
import '../../../core/network/query_cache.dart';

const Duration kAuditTtl = Duration(milliseconds: 20000);

/// System Audit Logs Service.
/// 1:1 port of `frontend/src/services/audit.service.js` (3 methods + peek helpers).
class AuditService {
  final Dio dio;
  final QueryCache? queryCache;

  AuditService({
    required this.dio,
    this.queryCache,
  });

  Future<T> _cachedFetch<T>(
    String logicalKey,
    Future<T> Function() fetcher, {
    Duration ttl = kAuditTtl,
    bool force = false,
  }) {
    if (queryCache != null) {
      return queryCache!.cachedFetch<T>(logicalKey, fetcher, ttl: ttl, force: force);
    }
    return fetcher();
  }

  /// Read cached audit log list without triggering network request.
  dynamic peekList([Map<String, dynamic>? params]) {
    final keyParams = {'op': 'list', if (params != null) ...params};
    return queryCache?.peek<dynamic>(buildCacheKey('auditLogs', keyParams))?.data;
  }

  /// 1. List system audit events with server-side pagination and filters.
  /// GET /api/v1/audit-logs
  Future<dynamic> list([Map<String, dynamic>? params, bool force = false]) {
    final keyParams = {'op': 'list', if (params != null) ...params};
    return _cachedFetch(
      buildCacheKey('auditLogs', keyParams),
      () => dio
          .get<dynamic>(
            ApiEndpoints.auditLogs,
            queryParameters: params,
          )
          .then((r) => r.data),
      ttl: kAuditTtl,
      force: force,
    );
  }

  /// 2. Export financial / operational audit logs as CSV bytes (RP-08).
  /// GET /api/v1/audit-logs?format=csv
  Future<List<int>> exportCsv([Map<String, dynamic>? params]) {
    final query = <String, dynamic>{
      if (params != null) ...params,
      'format': 'csv',
    };
    return dio
        .get<dynamic>(
          ApiEndpoints.auditLogs,
          queryParameters: query,
          options: Options(responseType: ResponseType.bytes),
        )
        .then((r) {
      final data = r.data;
      if (data is Uint8List) return data;
      if (data is List<int>) return data;
      if (data is String) return Uint8List.fromList(data.codeUnits);
      return <int>[];
    });
  }

  /// 3. Export financial / operational audit logs as Excel (.xlsx) bytes (RP-08).
  /// GET /api/v1/audit-logs?format=xlsx
  Future<List<int>> exportXlsx([Map<String, dynamic>? params]) {
    final query = <String, dynamic>{
      if (params != null) ...params,
      'format': 'xlsx',
    };
    return dio
        .get<dynamic>(
          ApiEndpoints.auditLogs,
          queryParameters: query,
          options: Options(responseType: ResponseType.bytes),
        )
        .then((r) {
      final data = r.data;
      if (data is Uint8List) return data;
      if (data is List<int>) return data;
      if (data is String) return Uint8List.fromList(data.codeUnits);
      return <int>[];
    });
  }
}

/// Riverpod provider for [AuditService].
final auditServiceProvider = Provider<AuditService>((ref) {
  final dio = ref.watch(dioProvider);
  final queryCache = ref.watch(queryCacheProvider);
  return AuditService(dio: dio, queryCache: queryCache);
});
