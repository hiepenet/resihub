import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:fl_chart/fl_chart.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:flutter_resihub/core/network/query_cache.dart';
import 'package:flutter_resihub/core/storage/app_storage.dart';
import 'package:flutter_resihub/features/audit/services/audit_service.dart';
import 'package:flutter_resihub/features/reports/screens/reports_page.dart';
import 'package:flutter_resihub/features/reports/services/reports_service.dart';
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

  Future<Widget> buildPage(
    WidgetTester tester, {
    required String initialLocation,
    required void Function(RequestOptions options) onRequest,
  }) async {
    await tester.binding.setSurfaceSize(const Size(1800, 1000));

    final dio = Dio(BaseOptions(baseUrl: 'http://localhost:3000'));
    dio.httpClientAdapter = _MockHttpClientAdapter((options) async {
      onRequest(options);
      if (options.path.contains('/deposit-ledger')) {
        return ResponseBody.fromString(
          jsonEncode({
            'success': true,
            'data': {
              'summary': {},
              'reservation_summary': {},
              'items': [],
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
            'data': {'logs': [], 'pagination': {'page': 1, 'limit': 20, 'total': 0, 'totalPages': 1}},
          }),
          200,
          headers: {Headers.contentTypeHeader: [Headers.jsonContentType]},
        );
      }
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
        reportsServiceProvider.overrideWithValue(ReportsService(dio: dio, queryCache: QueryCache())),
        auditServiceProvider.overrideWithValue(AuditService(dio: dio)),
      ],
    );

    final router = GoRouter(
      initialLocation: initialLocation,
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

    return UncontrolledProviderScope(
      container: container,
      child: MaterialApp.router(routerConfig: router),
    );
  }

  testWidgets('revenue Line/Bar toggle actually switches chart type', (tester) async {
    await tester.pumpWidget(await buildPage(
      tester,
      initialLocation: '/admin/reports?tab=revenue',
      onRequest: (_) {},
    ));
    await tester.pumpAndSettle();

    expect(find.byType(RevenueTrendLineChart), findsOneWidget);
    expect(find.byType(BarChart), findsNothing);

    await tester.tap(find.text('Biểu đồ Cột'));
    await tester.pumpAndSettle();

    expect(find.byType(RevenueTrendLineChart), findsNothing);
    expect(find.byType(BarChart), findsOneWidget);
  });

  testWidgets('occupancy tab renders a stacked BarChart with 3 datasets', (tester) async {
    await tester.pumpWidget(await buildPage(
      tester,
      initialLocation: '/admin/reports?tab=occupancy',
      onRequest: (_) {},
    ));
    await tester.pumpAndSettle();

    final barFinder = find.byType(BarChart);
    expect(barFinder, findsOneWidget);
    final data = tester.widget<BarChart>(barFinder).data;
    expect(data.barGroups, isNotEmpty);
    expect(data.barGroups.first.barRods.first.rodStackItems.length, 3);
  });

  testWidgets('changing deposit ledger from/to date auto-fetches without pressing Lọc', (tester) async {
    final requests = <RequestOptions>[];
    await tester.pumpWidget(await buildPage(
      tester,
      initialLocation: '/admin/reports?tab=deposit-ledger',
      onRequest: (options) => requests.add(options),
    ));
    await tester.pumpAndSettle();

    requests.clear();
    await tester.enterText(find.byType(TextFormField).at(0), '2020-01-01');
    await tester.pumpAndSettle();

    expect(
      requests.any(
        (r) => r.path.contains('/deposit-ledger') && r.queryParameters['from_date'] == '2020-01-01',
      ),
      isTrue,
      reason: 'Đổi "Từ ngày" phải tự fetch, không cần bấm "Lọc"',
    );
  });
}
