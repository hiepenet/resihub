import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/network/dio_client.dart';
import '../../../core/network/query_cache.dart';

const Duration kReportsTtl = Duration(milliseconds: 25000);

Uint8List _toUint8List(dynamic data) {
  if (data is Uint8List) return data;
  if (data is List<int>) return Uint8List.fromList(data);
  if (data is String) return Uint8List.fromList(utf8.encode(data));
  return Uint8List(0);
}

/// Reports & Analytics Service (1:1 port of `frontend/src/services/reports.service.js`).
class ReportsService {
  final Dio dio;
  final QueryCache? queryCache;

  ReportsService({
    required this.dio,
    this.queryCache,
  });

  Future<T> _cachedFetch<T>(
    String logicalKey,
    Future<T> Function() fetcher, {
    Duration ttl = kReportsTtl,
    bool force = false,
  }) {
    if (queryCache != null) {
      return queryCache!.cachedFetch<T>(logicalKey, fetcher, ttl: ttl, force: force);
    }
    return fetcher();
  }

  /// Peek cached dashboard metrics without triggering network request.
  dynamic peekDashboard([Map<String, dynamic>? params]) {
    final keyParams = {'op': 'dashboard', if (params != null) ...params};
    return queryCache?.peek<dynamic>(buildCacheKey('reports', keyParams))?.data;
  }

  /// 1. Get real-time operational dashboard KPIs, revenue, aging & occupancy trends.
  /// GET /api/v1/reports/dashboard
  Future<dynamic> getDashboard([Map<String, dynamic>? params, bool force = false]) {
    final keyParams = {'op': 'dashboard', if (params != null) ...params};
    return _cachedFetch(
      buildCacheKey('reports', keyParams),
      () => dio
          .get<dynamic>(
            '/api/v1/reports/dashboard',
            queryParameters: params,
          )
          .then((r) => r.data),
      ttl: kReportsTtl,
      force: force,
    );
  }

  /// Peek cached reports summary without triggering network request.
  dynamic peekSummary([Map<String, dynamic>? params]) {
    final keyParams = {'op': 'summary', if (params != null) ...params};
    return queryCache?.peek<dynamic>(buildCacheKey('reports', keyParams))?.data;
  }

  /// 2. Get high-level management summary report (Revenue, Occupancy, Aging, SLA).
  /// GET /api/v1/reports/summary
  Future<dynamic> getSummary([Map<String, dynamic>? params, bool force = false]) {
    final keyParams = {'op': 'summary', if (params != null) ...params};
    return _cachedFetch(
      buildCacheKey('reports', keyParams),
      () => dio
          .get<dynamic>(
            '/api/v1/reports/summary',
            queryParameters: params,
          )
          .then((r) => r.data),
      ttl: kReportsTtl,
      force: force,
    );
  }

  /// 3. Export Summary report as Excel (.xlsx) bytes (RP-01 / RP-02).
  /// GET /api/v1/reports/summary?format=xlsx
  Future<Uint8List> exportSummaryXlsx([Map<String, dynamic>? params]) {
    final query = <String, dynamic>{
      if (params != null) ...params,
      'format': 'xlsx',
    };
    return dio
        .get<dynamic>(
          '/api/v1/reports/summary',
          queryParameters: query,
          options: Options(responseType: ResponseType.bytes),
        )
        .then((r) => _toUint8List(r.data));
  }

  /// 4. Export Summary report as CSV bytes (RP-01 / RP-02).
  /// GET /api/v1/reports/summary?format=csv
  Future<Uint8List> exportSummaryCsv([Map<String, dynamic>? params]) {
    final query = <String, dynamic>{
      if (params != null) ...params,
      'format': 'csv',
    };
    return dio
        .get<dynamic>(
          '/api/v1/reports/summary',
          queryParameters: query,
          options: Options(responseType: ResponseType.bytes),
        )
        .then((r) => _toUint8List(r.data));
  }

  /// Peek cached deposit ledger report without triggering network request.
  dynamic peekDepositLedger([Map<String, dynamic>? params]) {
    final keyParams = {'op': 'depositLedger', if (params != null) ...params};
    return queryCache?.peek<dynamic>(buildCacheKey('reports', keyParams))?.data;
  }

  /// 5. Get contract deposit ledger balance sheet (RP-07).
  /// GET /api/v1/reports/deposit-ledger
  Future<dynamic> getDepositLedger([Map<String, dynamic>? params, bool force = false]) {
    final keyParams = {'op': 'depositLedger', if (params != null) ...params};
    return _cachedFetch(
      buildCacheKey('reports', keyParams),
      () => dio
          .get<dynamic>(
            '/api/v1/reports/deposit-ledger',
            queryParameters: params,
          )
          .then((r) => r.data),
      ttl: kReportsTtl,
      force: force,
    );
  }

  /// 6. Export Deposit Ledger as Excel (.xlsx) bytes (RP-07).
  /// GET /api/v1/reports/deposit-ledger?format=xlsx
  Future<Uint8List> exportDepositLedgerXlsx([Map<String, dynamic>? params]) {
    final query = <String, dynamic>{
      if (params != null) ...params,
      'format': 'xlsx',
    };
    return dio
        .get<dynamic>(
          '/api/v1/reports/deposit-ledger',
          queryParameters: query,
          options: Options(responseType: ResponseType.bytes),
        )
        .then((r) => _toUint8List(r.data));
  }

  /// 7. Export Deposit Ledger as CSV bytes (RP-07).
  /// GET /api/v1/reports/deposit-ledger?format=csv
  Future<Uint8List> exportDepositLedgerCsv([Map<String, dynamic>? params]) {
    final query = <String, dynamic>{
      if (params != null) ...params,
      'format': 'csv',
    };
    return dio
        .get<dynamic>(
          '/api/v1/reports/deposit-ledger',
          queryParameters: query,
          options: Options(responseType: ResponseType.bytes),
        )
        .then((r) => _toUint8List(r.data));
  }
}

/// Riverpod provider for [ReportsService].
final reportsServiceProvider = Provider<ReportsService>((ref) {
  final dio = ref.watch(dioProvider);
  final queryCache = ref.watch(queryCacheProvider);
  return ReportsService(dio: dio, queryCache: queryCache);
});
