import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:flutter_resihub/core/storage/app_storage.dart';
import 'package:flutter_resihub/core/network/dio_client.dart';
import 'package:flutter_resihub/core/network/query_cache.dart';
import 'package:flutter_resihub/core/utils/format.dart';
import 'package:flutter_resihub/features/ai_gateway/services/ai_service.dart';
import 'package:flutter_resihub/features/auth/models/user_model.dart';
import 'package:flutter_resihub/features/auth/providers/auth_provider.dart';
import 'package:flutter_resihub/features/buildings/services/buildings_service.dart';
import 'package:flutter_resihub/features/meters/screens/meter_readings_page.dart';
import 'package:flutter_resihub/features/meters/services/meters_service.dart';
import 'package:flutter_resihub/shared/widgets/ui/app_button.dart';

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

  final requests = <RequestOptions>[];

  const thresholdPct = 45;

  ResponseBody jsonResponseOf(Map<String, dynamic> body) => ResponseBody.fromString(
        jsonEncode(body),
        200,
        headers: {Headers.contentTypeHeader: [Headers.jsonContentType]},
      );

  Future<ProviderContainer> createContainer() async {
    SharedPreferences.setMockInitialValues({});
    final prefs = await SharedPreferences.getInstance();
    final storage = AppStorage(prefs: prefs, isWeb: true);

    final dio = Dio(BaseOptions(baseUrl: 'http://localhost:3000'));
    final queryCache = QueryCache();
    dio.httpClientAdapter = _MockHttpClientAdapter((options) async {
      requests.add(options);
      final path = options.path;
      if (path.contains('/buildings')) {
        return jsonResponseOf({
          'success': true,
          'data': [
            {'id': 'b-1', 'code': 'B1', 'name': 'Tòa Park 1'},
          ],
        });
      }
      if (path.contains('/readings') && options.method == 'GET') {
        return jsonResponseOf({'success': true, 'data': []});
      }
      if (path.contains('/meters') && options.method == 'GET') {
        return jsonResponseOf({
          'success': true,
          'anomaly_threshold_pct': thresholdPct,
          'data': [
            {
              'id': 'm-1',
              'apartment_code': '101',
              'building_code': 'B1',
              'meter_code': 'ELEC-101',
              'meter_type': 'ELECTRICITY',
              'unit': 'kWh',
              'unit_price': 3500,
              'last_known_reading': 100,
              'period_previous_reading': 100,
              'period_current_reading': 150,
              'period_reading_id': 'rd-1',
              'period_reading_status': 'DRAFT',
              'period_is_abnormal': false,
              'period_total_slots': 1,
              'period_slot_index': 1,
            },
          ],
        });
      }
      return jsonResponseOf({'success': true, 'data': [], 'message': 'ok'});
    });

    final container = ProviderContainer(
      overrides: [
        appStorageProvider.overrideWithValue(storage),
        dioProvider.overrideWithValue(dio),
        queryCacheProvider.overrideWithValue(queryCache),
        buildingsServiceProvider.overrideWithValue(
          BuildingsService(dio: dio, queryCache: queryCache),
        ),
        metersServiceProvider.overrideWithValue(
          MetersService(dio: dio, queryCache: queryCache),
        ),
        aiServiceProvider.overrideWithValue(AiService(dio: dio)),
      ],
    );
    container.read(authProvider.notifier).setAuthData(
          accessToken: 'token-manager',
          refreshToken: 'refresh-manager',
          user: const UserModel(
            id: 'u-1',
            email: 'manager@resihub.vn',
            fullName: 'Manager',
            roles: [UserRoleModel(code: 'MANAGER')],
          ),
        );
    return container;
  }

  Future<ProviderContainer> pumpPage(WidgetTester tester) async {
    requests.clear();
    await tester.binding.setSurfaceSize(const Size(1400, 1000));
    final container = await createContainer();
    await tester.pumpWidget(
      UncontrolledProviderScope(
        container: container,
        child: const MaterialApp(home: MeterReadingsPage()),
      ),
    );
    await tester.pumpAndSettle();
    return container;
  }

  testWidgets('D1: meter list request sends active_contract=true by default', (tester) async {
    await pumpPage(tester);

    final listReq = requests.firstWhere(
      (r) => r.path == '/api/v1/meters' && r.method == 'GET',
    );
    expect(listReq.queryParameters['active_contract'], 'true');
  });

  testWidgets('D2: "Chỉ số mới" column renders an editable inline field', (tester) async {
    await pumpPage(tester);

    final inlineField = find.byKey(const Key('meter-inline-reading-m-1'));
    expect(inlineField, findsOneWidget);
    expect(
      find.descendant(of: inlineField, matching: find.byType(EditableText)),
      findsOneWidget,
    );
  });

  testWidgets('D3: two batch record buttons "Lưu nháp" and "Lưu & Chốt chỉ số" exist', (tester) async {
    await pumpPage(tester);

    expect(find.widgetWithText(AppButton, 'Lưu nháp'), findsOneWidget);
    expect(find.widgetWithText(AppButton, 'Lưu & Chốt chỉ số'), findsOneWidget);
  });

  testWidgets('D5: confirmBatch payload includes period and building_id', (tester) async {
    await pumpPage(tester);

    final confirmAllButton = find.byWidgetPredicate(
      (w) => w is AppButton && (w.text ?? '').contains('Chốt toàn bộ'),
    );
    expect(confirmAllButton, findsOneWidget);
    await tester.tap(confirmAllButton);
    await tester.pumpAndSettle();

    final dialogConfirm = find.widgetWithText(AppButton, 'Chốt hàng loạt');
    expect(dialogConfirm, findsOneWidget);
    await tester.tap(dialogConfirm);
    await tester.pumpAndSettle();

    final batchReq = requests.firstWhere(
      (r) => r.path == '/api/v1/meters/readings/confirm-batch' && r.method == 'POST',
    );
    final data = batchReq.data as Map<String, dynamic>;
    expect(data['period'], getCurrentPeriod());
    expect(data['building_id'], 'b-1');
    expect(data['reading_ids'], ['rd-1']);

    // Flush the success toast's auto-dismiss timer so it does not leak past the test.
    await tester.pump(const Duration(seconds: 5));
  });

  testWidgets('D6: anomaly threshold label is read from the API response', (tester) async {
    await pumpPage(tester);

    expect(find.textContaining('>$thresholdPct%'), findsWidgets);
  });
}
