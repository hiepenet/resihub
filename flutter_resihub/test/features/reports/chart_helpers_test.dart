import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:flutter_resihub/core/network/query_cache.dart';
import 'package:flutter_resihub/core/storage/app_storage.dart';
import 'package:flutter_resihub/core/utils/format.dart';
import 'package:flutter_resihub/features/audit/services/audit_service.dart';
import 'package:flutter_resihub/features/audit/widgets/audit_logs_view.dart';
import 'package:flutter_resihub/features/auth/providers/auth_provider.dart';
import 'package:flutter_resihub/features/reports/screens/dashboard_page.dart';
import 'package:flutter_resihub/features/reports/screens/reports_page.dart';
import 'package:flutter_resihub/features/reports/services/reports_service.dart';
import 'package:flutter_resihub/features/reports/utils/chart_helpers.dart';
import 'package:flutter_resihub/features/reports/widgets/dashboard_charts.dart';

class _MockHttpClientAdapter implements HttpClientAdapter {
  final Future<ResponseBody> Function(RequestOptions options) _handler;

  _MockHttpClientAdapter(this._handler);

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) {
    return _handler(options);
  }

  @override
  void close({bool force = false}) {}
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('ReportsService (7 core methods + query cache peek)', () {
    late Dio dio;
    late QueryCache queryCache;
    late ReportsService reportsService;
    late RequestOptions lastRequest;

    setUp(() {
      dio = Dio(BaseOptions(baseUrl: 'http://localhost:3000'));
      queryCache = QueryCache();

      dio.httpClientAdapter = _MockHttpClientAdapter((options) async {
        lastRequest = options;
        if (options.path.contains('/summary') && options.queryParameters['format'] == 'xlsx') {
          return ResponseBody.fromBytes(
            Uint8List.fromList([0x50, 0x4B, 0x03, 0x04]),
            200,
            headers: {
              Headers.contentTypeHeader: [
                'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
              ],
            },
          );
        }
        if (options.path.contains('/summary') && options.queryParameters['format'] == 'csv') {
          return ResponseBody.fromString(
            'period,billed,collected\n2026-01,1000,800\n',
            200,
            headers: {
              Headers.contentTypeHeader: ['text/csv'],
            },
          );
        }
        if (options.path.contains('/deposit-ledger') && options.queryParameters['format'] == 'xlsx') {
          return ResponseBody.fromBytes(
            Uint8List.fromList([0x50, 0x4B, 0x03, 0x04]),
            200,
          );
        }
        if (options.path.contains('/deposit-ledger') && options.queryParameters['format'] == 'csv') {
          return ResponseBody.fromString(
            'apartment,tenant,opening\nA101,Nguyen Van A,5000000\n',
            200,
          );
        }

        return ResponseBody.fromString(
          jsonEncode({
            'success': true,
            'data': {'mock': true},
          }),
          200,
          headers: {
            Headers.contentTypeHeader: [Headers.jsonContentType],
          },
        );
      });

      reportsService = ReportsService(dio: dio, queryCache: queryCache);
    });

    test('1. getDashboard sends GET /api/v1/reports/dashboard and supports peek', () async {
      expect(reportsService.peekDashboard(), isNull);

      final res = await reportsService.getDashboard({'months': 12});
      expect(res, isNotNull);
      expect(lastRequest.method, 'GET');
      expect(lastRequest.path, '/api/v1/reports/dashboard');
      expect(lastRequest.queryParameters['months'], 12);

      final cached = reportsService.peekDashboard({'months': 12});
      expect(cached, isNotNull);
    });

    test('2. getSummary sends GET /api/v1/reports/summary and caches', () async {
      final res = await reportsService.getSummary({'building_id': 'b-1'});
      expect(res, isNotNull);
      expect(lastRequest.method, 'GET');
      expect(lastRequest.path, '/api/v1/reports/summary');
      expect(lastRequest.queryParameters['building_id'], 'b-1');

      final cached = reportsService.peekSummary({'building_id': 'b-1'});
      expect(cached, isNotNull);
    });

    test('3. exportSummaryXlsx sends GET /api/v1/reports/summary with format=xlsx and binary response', () async {
      final bytes = await reportsService.exportSummaryXlsx({'section': 'revenue'});
      expect(bytes, isNotEmpty);
      expect(bytes[0], 0x50);
      expect(lastRequest.path, '/api/v1/reports/summary');
      expect(lastRequest.queryParameters['format'], 'xlsx');
      expect(lastRequest.queryParameters['section'], 'revenue');
      expect(lastRequest.responseType, ResponseType.bytes);
    });

    test('4. exportSummaryCsv sends GET /api/v1/reports/summary with format=csv', () async {
      final bytes = await reportsService.exportSummaryCsv({'section': 'revenue'});
      expect(bytes, isNotEmpty);
      final text = utf8.decode(bytes);
      expect(text, contains('period,billed,collected'));
      expect(lastRequest.queryParameters['format'], 'csv');
    });

    test('5. getDepositLedger sends GET /api/v1/reports/deposit-ledger', () async {
      final res = await reportsService.getDepositLedger({'from_date': '2026-01-01'});
      expect(res, isNotNull);
      expect(lastRequest.path, '/api/v1/reports/deposit-ledger');
      expect(lastRequest.queryParameters['from_date'], '2026-01-01');

      final cached = reportsService.peekDepositLedger({'from_date': '2026-01-01'});
      expect(cached, isNotNull);
    });

    test('6. exportDepositLedgerXlsx sends GET /api/v1/reports/deposit-ledger with format=xlsx', () async {
      final bytes = await reportsService.exportDepositLedgerXlsx({'status': 'HELD'});
      expect(bytes, isNotEmpty);
      expect(lastRequest.path, '/api/v1/reports/deposit-ledger');
      expect(lastRequest.queryParameters['format'], 'xlsx');
      expect(lastRequest.queryParameters['status'], 'HELD');
    });

    test('7. exportDepositLedgerCsv sends GET /api/v1/reports/deposit-ledger with format=csv', () async {
      final bytes = await reportsService.exportDepositLedgerCsv({'status': 'HELD'});
      expect(bytes, isNotEmpty);
      final text = utf8.decode(bytes);
      expect(text, contains('apartment,tenant,opening'));
      expect(lastRequest.path, '/api/v1/reports/deposit-ledger');
      expect(lastRequest.queryParameters['format'], 'csv');
    });
  });

  group('chart_helpers.dart utils tests', () {
    test('DASHBOARD_AGING_BUCKET_KEYS contains 5 standard buckets', () {
      expect(
        kDashboardAgingBucketKeys,
        ['current_not_due', '0_15', '16_30', '31_60', 'over_60'],
      );
    });

    test('buildRevenueTrendChartData builds 3 line series correctly', () {
      final series = [
        {'period': '2026-01', 'billed': 10000000, 'invoice_settled': 8000000, 'collected': 7000000},
        {'period': '2026-02', 'billed': 12000000, 'invoice_settled': 12000000, 'collected': 11000000},
      ];
      final trend = buildRevenueTrendChartData(series);
      expect(trend.labels, ['2026-01', '2026-02']);
      expect(trend.billed, [10000000.0, 12000000.0]);
      expect(trend.invoiceSettled, [8000000.0, 12000000.0]);
      expect(trend.collected, [7000000.0, 11000000.0]);
    });

    test('buildRevenueBySourceChartData builds 5 stacked sources correctly', () {
      final series = [
        {
          'period': '2026-01',
          'rent': 5000000,
          'electricity': 1000000,
          'water': 300000,
          'service': 500000,
          'other': 200000,
        },
      ];
      final sourceData = buildRevenueBySourceChartData(series);
      expect(sourceData.labels, ['2026-01']);
      expect(sourceData.rent, [5000000.0]);
      expect(sourceData.electricity, [1000000.0]);
      expect(sourceData.water, [300000.0]);
      expect(sourceData.service, [500000.0]);
      expect(sourceData.other, [200000.0]);
    });

    test('buildReceivablesAgingChartData formats 5 buckets with amounts and counts', () {
      final aging = {
        'total_debt': 15000000,
        'buckets': [
          {'key': 'current_not_due', 'amount': 8000000, 'count': 4},
          {'key': '0_15', 'amount': 3000000, 'count': 2},
          {'key': '16_30', 'amount': 2000000, 'count': 1},
          {'key': '31_60', 'amount': 1000000, 'count': 1},
          {'key': 'over_60', 'amount': 1000000, 'count': 1},
        ],
      };
      final result = buildReceivablesAgingChartData(aging);
      expect(result.bucketKeys, ['current_not_due', '0_15', '16_30', '31_60', 'over_60']);
      expect(result.amounts, [8000000.0, 3000000.0, 2000000.0, 1000000.0, 1000000.0]);
      expect(result.counts, [4, 2, 1, 1, 1]);
      expect(result.labels, ['Chưa đến hạn', '1–15 ngày', '16–30 ngày', '31–60 ngày', '>60 ngày']);
    });

    test('buildOccupancyTrendChartData clamps occupancy rate and retains meta points', () {
      final series = [
        {'period': '2026-01', 'occupied': 18, 'exploitable': 20, 'occupancy_rate': 90.0},
        {'period': '2026-02', 'occupied': 20, 'exploitable': 20, 'occupancy_rate': 105.0}, // clamped to 100
      ];
      final occ = buildOccupancyTrendChartData(series);
      expect(occ.labels, ['2026-01', '2026-02']);
      expect(occ.rates, [90.0, 100.0]);
      expect(occ.metaPoints[0].occupied, 18);
      expect(occ.metaPoints[0].exploitable, 20);
      expect(occ.metaPoints[1].occupied, 20);
    });

    test('guard helpers detect present vs empty data', () {
      expect(hasRevenueChartData([], []), isFalse);
      expect(hasRevenueChartData([{'billed': 100}], []), isTrue);
      expect(hasRevenueChartData([], [{'rent': 500}]), isTrue);

      expect(hasAgingChartData({}), isFalse);
      expect(hasAgingChartData({'total_debt': 500}), isTrue);
      expect(hasAgingChartData({'buckets': [{'amount': 10}]}), isTrue);

      expect(hasOccupancyChartData(0, []), isFalse);
      expect(hasOccupancyChartData(10, []), isTrue);
      expect(hasOccupancyChartData(0, [{'exploitable': 5}]), isTrue);
    });

    test('buildReportsBuildingAgingChartData handles buildings breakdown', () {
      final rows = [
        {
          'building_code': 'B1',
          'building_name': 'Tòa Landmark 1',
          'current_not_due': 5000000,
          'bucket_0_15': 2000000,
          'bucket_16_30': 1000000,
          'bucket_31_60': 500000,
          'bucket_over_60': 200000,
        },
      ];
      final data = buildReportsBuildingAgingChartData(rows);
      expect(data.labels, ['B1']);
      expect(data.currentNotDue, [5000000.0]);
      expect(data.bucket0To15, [2000000.0]);
      expect(data.bucket16To30, [1000000.0]);
      expect(data.bucket31To60, [500000.0]);
      expect(data.bucketOver60, [200000.0]);
    });

    test('resolvePaymentsUrlQuery extracts tab, bucket, creditStatus', () {
      final q1 = resolvePaymentsUrlQuery('?tab=aging&bucket=16_30');
      expect(q1.tab, 'aging');
      expect(q1.agingBucket, '16_30');

      final q2 = resolvePaymentsUrlQuery('bucket=over_60');
      expect(q2.tab, 'aging');
      expect(q2.agingBucket, 'over_60');

      final q3 = resolvePaymentsUrlQuery('tab=credits&status=PENDING_DIRECT_REFUND');
      expect(q3.tab, 'credits');
      expect(q3.creditStatus, 'PENDING_DIRECT_REFUND');

      final q4 = resolvePaymentsUrlQuery('status=PENDING_DIRECT_REFUND');
      expect(q4.tab, 'credits');

      final q5 = resolvePaymentsUrlQuery('tab=overpayments');
      expect(q5.tab, 'overpayments');

      final q6 = resolvePaymentsUrlQuery('other=123');
      expect(q6.tab, isNull);
    });
  });

  group('Widget Tests: DashboardPage & ReportsPage', () {
    testWidgets('DashboardPage renders with route key and KPIs', (tester) async {
      await tester.binding.setSurfaceSize(const Size(1400, 900));

      final requests = <RequestOptions>[];
      final dio = Dio(BaseOptions(baseUrl: 'http://localhost:3000'));
      dio.httpClientAdapter = _MockHttpClientAdapter((options) async {
        requests.add(options);
        return ResponseBody.fromString(
          jsonEncode({
            'success': true,
            'data': {
              'kpis': {
                'occupancy_rate': 95,
                'occupied_apartments': 19,
                'total_apartments': 20,
                'available_apartments': 1,
                'monthly_revenue': 25000000,
                'monthly_billed': 30000000,
                'unpaid_debt': 5000000,
                'pending_requests': 3,
                'pending_invoice_adjustments': 1,
                'pending_credit_refunds': 2,
                'pending_deposit_approvals': 4,
                'pending_deposit_payouts': 1,
                'overdue_deposit_refunds': 2,
                'disputed_deposits': 1,
                'pending_reservation_confirms': 3,
              },
              'revenue_12m': [
                {'period': '2026-01', 'billed': 30000000, 'collected': 25000000, 'invoice_settled': 25000000},
              ],
              'revenue_by_source': [
                {'period': '2026-01', 'rent': 20000000, 'electricity': 3000000, 'water': 1000000, 'service': 1000000, 'other': 0},
              ],
              'receivables_aging': {
                'total_debt': 5000000,
                'overdue_debt': 2000000,
                'buckets': [
                  {'key': 'current_not_due', 'amount': 3000000, 'count': 2},
                  {'key': '0_15', 'amount': 1000000, 'count': 1},
                  {'key': '16_30', 'amount': 500000, 'count': 1},
                  {'key': '31_60', 'amount': 500000, 'count': 1},
                  {'key': 'over_60', 'amount': 0, 'count': 0},
                ],
              },
              'occupancy_12m': [
                {'period': '2026-01', 'occupied': 19, 'exploitable': 20, 'occupancy_rate': 95},
              ],
              'expiring_contracts': [
                {
                  'id': 'c-1',
                  'building_name': 'Landmark 1',
                  'apartment_code': 'P101',
                  'tenant_name': 'Nguyen Van A',
                  'tenant_phone': '0901234567',
                  'end_date': '2026-12-01',
                  'rent_amount': 15000000,
                  'days_left': 15,
                },
              ],
              'recent_service_requests': [
                {
                  'id': 'sr-1',
                  'tracking_code': 'SR-001',
                  'building_name': 'Landmark 1',
                  'apartment_code': 'P101',
                  'title': 'Hỏng bóng đèn phòng khách',
                  'status': 'NEW',
                  'priority': 'HIGH',
                  'created_at': '2026-11-14T08:00:00Z',
                },
              ],
            },
          }),
          200,
          headers: {Headers.contentTypeHeader: [Headers.jsonContentType]},
        );
      });

      SharedPreferences.setMockInitialValues({});
      final prefs = await SharedPreferences.getInstance();
      final storage = AppStorage(prefs: prefs, isWeb: true);

      final container = ProviderContainer(
        overrides: [
          appStorageProvider.overrideWithValue(storage),
          reportsServiceProvider.overrideWithValue(ReportsService(dio: dio)),
          auditServiceProvider.overrideWithValue(AuditService(dio: dio)),
        ],
      );

      final router = GoRouter(
        initialLocation: '/admin/dashboard',
        routes: [
          GoRoute(
            path: '/admin/dashboard',
            builder: (context, state) => const DashboardPage(),
          ),
          GoRoute(
            path: '/admin/payments',
            builder: (context, state) => Text('PAYMENTS_TARGET: ${state.uri.queryParameters}'),
          ),
          GoRoute(
            path: '/admin/invoices',
            builder: (context, state) => const Text('INVOICES_TARGET'),
          ),
          GoRoute(
            path: '/admin/buildings',
            builder: (context, state) => const Text('BUILDINGS_TARGET'),
          ),
          GoRoute(
            path: '/admin/deposits',
            builder: (context, state) => const Text('DEPOSITS_TARGET'),
          ),
          GoRoute(
            path: '/admin/maintenance',
            builder: (context, state) => const Text('MAINTENANCE_TARGET'),
          ),
          GoRoute(
            path: '/admin/contracts/:id',
            builder: (context, state) => Text('CONTRACT_TARGET: ${state.pathParameters['id']}'),
          ),
        ],
      );

      await tester.pumpWidget(
        UncontrolledProviderScope(
          container: container,
          child: MaterialApp.router(
            routerConfig: router,
          ),
        ),
      );

      await tester.pumpAndSettle();

      // Route Key verification
      expect(find.byKey(const Key('route:/admin/dashboard')), findsOneWidget);

      // Verify KPI text
      expect(find.text('Bảng điều khiển vận hành'), findsOneWidget);
      expect(find.text('TỶ LỆ LẤP ĐẦY'), findsWidgets);
      expect(find.text('DOANH THU THÁNG NÀY'), findsOneWidget);
      expect(find.text('CÔNG NỢ CHƯA THU'), findsOneWidget);
      expect(find.text('Hợp đồng sắp hết hạn (45 ngày tới)'), findsOneWidget);
      expect(find.text('Yêu cầu báo hỏng mới nhất'), findsOneWidget);

      // Verify chart widgets
      expect(find.byType(RevenueTrendLineChart), findsOneWidget);
      expect(find.byType(ReceivablesAgingBarChart), findsOneWidget);
      expect(find.byType(OccupancyTrendLineChart), findsOneWidget);

      // Test revenue mode switch
      await tester.tap(find.text('Theo nguồn thu'));
      await tester.pumpAndSettle();
      expect(find.byType(RevenueSourceStackedBarChart), findsOneWidget);

      // Verify changing selectedBuildingId triggers fresh fetch with building_id
      requests.clear();
      await container.read(authProvider.notifier).setSelectedBuildingId('b-999');
      await tester.pumpAndSettle();
      expect(
        requests.any((r) => r.path.contains('/dashboard') && r.queryParameters['building_id'] == 'b-999'),
        isTrue,
      );
    });

    testWidgets('ReportsPage renders all 6 tabs including financial-audit and handles ?modal=summary', (tester) async {
      await tester.binding.setSurfaceSize(const Size(1800, 1000));

      final requests = <RequestOptions>[];
      final dio = Dio(BaseOptions(baseUrl: 'http://localhost:3000'));
      dio.httpClientAdapter = _MockHttpClientAdapter((options) async {
        requests.add(options);
        if (options.path.contains('/summary')) {
          return ResponseBody.fromString(
            jsonEncode({
              'success': true,
              'data': {
                'revenue_12m': [
                  {'period': '2026-01', 'billed': 30000000, 'collected': 25000000, 'invoice_count': 10, 'outstanding': 5000000},
                ],
                'occupancy_by_building': [
                  {
                    'building_id': 'b1',
                    'building_code': 'LM1',
                    'building_name': 'Landmark 1',
                    'total_apartments': 20,
                    'occupied': 18,
                    'available': 1,
                    'reserved': 1,
                    'maintenance': 0,
                    'occupancy_rate': 90,
                  },
                ],
                'aging_by_building': [
                  {
                    'building_code': 'LM1',
                    'building_name': 'Landmark 1',
                    'current_not_due': 3000000,
                    'bucket_0_15': 1000000,
                    'bucket_16_30': 500000,
                    'bucket_31_60': 500000,
                    'bucket_over_60': 0,
                    'total_debt': 5000000,
                  },
                ],
                'sla_by_category': [
                  {
                    'category': 'PLUMBING',
                    'total_requests': 5,
                    'resolved_count': 5,
                    'open_count': 0,
                    'avg_resolve_hours': 4.5,
                    'avg_rating': 4.8,
                  },
                ],
              },
            }),
            200,
            headers: {Headers.contentTypeHeader: [Headers.jsonContentType]},
          );
        }

        if (options.path.contains('/deposit-ledger')) {
          return ResponseBody.fromString(
            jsonEncode({
              'success': true,
              'data': {
                'period': {'from_date': '2026-01-01', 'to_date': '2026-01-31'},
                'summary': {
                  'opening_held': 100000000,
                  'collected': 20000000,
                  'transfer_in': 0,
                  'refund_reversed': 0,
                  'deducted': 5000000,
                  'refunded': 15000000,
                  'transfer_out': 0,
                  'closing_held': 100000000,
                  'disputed_count': 1,
                  'disputed_amount': 10000000,
                  'pending_payout_count': 1,
                  'pending_payout_amount': 5000000,
                  'returned_count': 0,
                  'overdue_count': 1,
                },
                'reservation_summary': {
                  'active_held_count': 2,
                  'active_held_amount': 10000000,
                  'pending_payout_count': 1,
                  'pending_payout_amount': 5000000,
                  'pending_confirm_count': 1,
                  'pending_confirm_amount': 5000000,
                  'refunded_in_period': 2000000,
                  'forfeited_in_period': 1000000,
                },
                'items': [
                  {
                    'deposit_id': 'd-1',
                    'apartment_code': 'P101',
                    'building_code': 'LM1',
                    'tenant_name': 'Nguyen Van A',
                    'tenant_phone': '0901234567',
                    'deposit_status': 'HELD',
                    'opening_held': 20000000,
                    'collected': 0,
                    'deducted': 0,
                    'refunded': 0,
                    'closing_held': 20000000,
                    'refund_due_date': '2026-12-01',
                    'is_overdue': false,
                  },
                ],
              },
            }),
            200,
            headers: {Headers.contentTypeHeader: [Headers.jsonContentType]},
          );
        }

        if (options.path.contains('/audit-logs')) {
          return ResponseBody.fromString(
            jsonEncode({
              'success': true,
              'data': {
                'logs': [],
                'pagination': {'page': 1, 'limit': 20, 'total': 0, 'totalPages': 1},
              },
            }),
            200,
            headers: {Headers.contentTypeHeader: [Headers.jsonContentType]},
          );
        }

        return ResponseBody.fromString(
          jsonEncode({'success': true, 'data': {}}),
          200,
          headers: {Headers.contentTypeHeader: [Headers.jsonContentType]},
        );
      });

      SharedPreferences.setMockInitialValues({});
      final prefs = await SharedPreferences.getInstance();
      final storage = AppStorage(prefs: prefs, isWeb: true);

      final container = ProviderContainer(
        overrides: [
          appStorageProvider.overrideWithValue(storage),
          reportsServiceProvider.overrideWithValue(ReportsService(dio: dio)),
          auditServiceProvider.overrideWithValue(AuditService(dio: dio)),
        ],
      );

      final router = GoRouter(
        initialLocation: '/admin/reports',
        routes: [
          GoRoute(
            path: '/admin/reports',
            builder: (context, state) => ReportsPage(
              initialTab: state.uri.queryParameters['tab'],
              initialModal: state.uri.queryParameters['modal'],
            ),
          ),
        ],
      );

      await tester.pumpWidget(
        UncontrolledProviderScope(
          container: container,
          child: MaterialApp.router(
            routerConfig: router,
          ),
        ),
      );

      await tester.pumpAndSettle();

      // Route Key verification
      expect(find.byKey(const Key('route:/admin/reports')), findsOneWidget);

      // Verify Header
      expect(find.text('Báo cáo & Phân tích Quản trị'), findsOneWidget);

      // Tab 1: Revenue
      expect(find.text('Doanh thu 12 tháng (RP-01)'), findsOneWidget);
      expect(find.text('LŨY KẾ PHÁT HÀNH (12T)'), findsOneWidget);
      expect(find.text('LŨY KẾ THỰC THU (12T)'), findsOneWidget);

      // Tab 2: Occupancy
      await tester.tap(find.text('Tỷ lệ lấp đầy'));
      await tester.pumpAndSettle();
      expect(find.text('Cơ cấu khai thác căn hộ theo từng tòa nhà'), findsOneWidget);

      // Tab 3: Aging
      await tester.tap(find.text('Báo cáo tuổi nợ (RP-02)'));
      await tester.pumpAndSettle();
      expect(find.text('Phân bổ tuổi nợ (Aging) theo từng tòa nhà'), findsOneWidget);
      expect(find.byType(BuildingAgingStackedBarChart), findsOneWidget);

      // Tab 4: Deposit Ledger
      await tester.tap(find.text('Sổ cọc (RP-07)'));
      await tester.pumpAndSettle();
      expect(find.text('Đối soát Tiền đặt giữ chỗ ngoài Hợp đồng'), findsOneWidget);
      expect(find.text('Đầu kỳ đang giữ'), findsWidgets);

      // Tab 5: Financial Audit (embeds AuditLogsView)
      await tester.ensureVisible(find.text('Nhật ký tài chính (RP-08)'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Nhật ký tài chính (RP-08)'));
      await tester.pumpAndSettle();
      expect(find.byType(AuditLogsView), findsOneWidget);

      // Tab 6: SLA
      await tester.ensureVisible(find.text('SLA Báo hỏng'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('SLA Báo hỏng'));
      await tester.pumpAndSettle();
      expect(find.text('Thời gian xử lý sự cố trung bình theo hạng mục (giờ)'), findsOneWidget);

      // Verify changing selectedBuildingId triggers fresh fetch in ReportsPage
      requests.clear();
      await container.read(authProvider.notifier).setSelectedBuildingId('b-777');
      await tester.pumpAndSettle();
      expect(
        requests.any((r) => r.path.contains('/summary') && r.queryParameters['building_id'] == 'b-777'),
        isTrue,
      );
    });

    testWidgets('ReportsPage mounts with ?modal=summary, awaits deposit ledger and displays populated summary metrics', (tester) async {
      await tester.binding.setSurfaceSize(const Size(1800, 1000));

      final dio = Dio(BaseOptions(baseUrl: 'http://localhost:3000'));
      dio.httpClientAdapter = _MockHttpClientAdapter((options) async {
        if (options.path.contains('/deposit-ledger')) {
          return ResponseBody.fromString(
            jsonEncode({
              'success': true,
              'data': {
                'summary': {
                  'opening_held': 100000000,
                  'closing_held': 120000000,
                  'collected': 25000000,
                  'refunded': 5000000,
                  'deducted': 0,
                  'overdue_count': 0,
                  'disputed_count': 0,
                  'pending_payout_count': 0,
                },
                'reservation_summary': {},
                'items': [],
              },
            }),
            200,
            headers: {Headers.contentTypeHeader: [Headers.jsonContentType]},
          );
        }
        return ResponseBody.fromString(
          jsonEncode({
            'success': true,
            'data': {
              'revenue_12m': [],
              'occupancy_by_building': [],
              'aging_by_building': [],
              'sla_by_category': [],
            },
          }),
          200,
          headers: {Headers.contentTypeHeader: [Headers.jsonContentType]},
        );
      });

      SharedPreferences.setMockInitialValues({});
      final prefs = await SharedPreferences.getInstance();
      final storage = AppStorage(prefs: prefs, isWeb: true);

      final container = ProviderContainer(
        overrides: [
          appStorageProvider.overrideWithValue(storage),
          reportsServiceProvider.overrideWithValue(ReportsService(dio: dio)),
          auditServiceProvider.overrideWithValue(AuditService(dio: dio)),
        ],
      );

      final router = GoRouter(
        initialLocation: '/admin/reports?modal=summary',
        routes: [
          GoRoute(
            path: '/admin/reports',
            builder: (context, state) => ReportsPage(
              initialTab: state.uri.queryParameters['tab'],
              initialModal: state.uri.queryParameters['modal'],
            ),
          ),
        ],
      );

      await tester.pumpWidget(
        UncontrolledProviderScope(
          container: container,
          child: MaterialApp.router(
            routerConfig: router,
          ),
        ),
      );

      await tester.pumpAndSettle();

      // Modal is visible
      expect(find.text('Tổng hợp Báo cáo Sổ cọc định kỳ (RP-07)'), findsOneWidget);
      // Metrics are populated from awaited deposit-ledger, NOT empty/zeroed
      expect(find.text(formatMoney(100000000)), findsOneWidget);
      expect(find.text(formatMoney(120000000)), findsOneWidget);
      expect(find.text('+${formatMoney(25000000)}'), findsOneWidget);
    });
  });
}
