import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:flutter_resihub/core/network/dio_client.dart';
import 'package:flutter_resihub/core/network/query_cache.dart';
import 'package:flutter_resihub/core/storage/app_storage.dart';
import 'package:flutter_resihub/features/ai_gateway/services/ai_service.dart';
import 'package:flutter_resihub/features/auth/models/user_model.dart';
import 'package:flutter_resihub/features/auth/providers/auth_provider.dart';
import 'package:flutter_resihub/features/buildings/services/buildings_service.dart';
import 'package:flutter_resihub/features/meters/screens/meter_readings_page.dart';
import 'package:flutter_resihub/features/meters/services/meters_service.dart';
import 'package:flutter_resihub/shared/widgets/ui/ai_suggestion_field.dart';
import 'package:flutter_resihub/shared/widgets/ui/app_button.dart';
import 'package:flutter_resihub/shared/widgets/ui/file_upload_field.dart';

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

  group('Single Meter Detail Modal OCR Auto-Fill & AISuggestionField', () {
    late Dio dio;
    late QueryCache queryCache;
    late AppStorage storage;
    late BuildingsService buildingsService;
    late MetersService metersService;
    late AiService aiService;
    late List<RequestOptions> requests;

    setUp(() async {
      SharedPreferences.setMockInitialValues({});
      final prefs = await SharedPreferences.getInstance();
      storage = AppStorage(prefs: prefs);
      requests = [];

      dio = Dio(BaseOptions(baseUrl: 'http://localhost:3000'));
      queryCache = QueryCache();

      dio.httpClientAdapter = _MockHttpClientAdapter((options) async {
        requests.add(options);
        if (options.path.contains('/buildings')) {
          return ResponseBody.fromString(
            jsonEncode({
              'success': true,
              'data': [
                {'id': 'b-1', 'code': 'B1', 'name': 'Tòa Park 1'},
              ],
            }),
            200,
            headers: {Headers.contentTypeHeader: [Headers.jsonContentType]},
          );
        }
        if (options.path.contains('/meter-ocr')) {
          return ResponseBody.fromString(
            jsonEncode({
              'success': true,
              'data': {
                'suggestion_id': 'sugg-single-999',
                'confidence': 0.95,
                'output': {
                  'reading': 180,
                  'detected_meter_type': 'ELECTRICITY',
                  'reason': 'Chỉ số hiển thị rõ nét trên màn hình LCD.',
                },
              },
            }),
            200,
            headers: {Headers.contentTypeHeader: [Headers.jsonContentType]},
          );
        }
        if (options.path.contains('/meters') && options.path.contains('/readings')) {
          return ResponseBody.fromString(
            jsonEncode({
              'success': true,
              'message': 'Đã ghi chỉ số thành công.',
              'data': {'id': 'r-1'},
            }),
            200,
            headers: {Headers.contentTypeHeader: [Headers.jsonContentType]},
          );
        }
        if (options.path.contains('/meters')) {
          return ResponseBody.fromString(
            jsonEncode({
              'success': true,
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
                  'period_current_reading': null,
                  'period_reading_status': null,
                  'period_is_abnormal': false,
                  'period_total_slots': 1,
                  'period_slot_index': 1,
                },
              ],
            }),
            200,
            headers: {Headers.contentTypeHeader: [Headers.jsonContentType]},
          );
        }
        return ResponseBody.fromString(
          jsonEncode({'success': true, 'data': []}),
          200,
          headers: {Headers.contentTypeHeader: [Headers.jsonContentType]},
        );
      });

      buildingsService = BuildingsService(dio: dio, queryCache: queryCache);
      metersService = MetersService(dio: dio, queryCache: queryCache);
      aiService = AiService(dio: dio);
    });

    ProviderContainer createContainer() {
      final container = ProviderContainer(
        overrides: [
          appStorageProvider.overrideWithValue(storage),
          dioProvider.overrideWithValue(dio),
          queryCacheProvider.overrideWithValue(queryCache),
          buildingsServiceProvider.overrideWithValue(buildingsService),
          metersServiceProvider.overrideWithValue(metersService),
          aiServiceProvider.overrideWithValue(aiService),
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

    testWidgets('AI OCR automatically fills reading field and shows AISuggestionField with confidence', (tester) async {
      await tester.binding.setSurfaceSize(const Size(1280, 1000));
      final container = createContainer();

      await tester.pumpWidget(
        UncontrolledProviderScope(
          container: container,
          child: const MaterialApp(
            home: MeterReadingsPage(),
          ),
        ),
      );

      await tester.pumpAndSettle();

      // Tap on edit icon button with tooltip 'Ghi chỉ số & Chi tiết' to open detail modal
      final recordButton = find.byTooltip('Ghi chỉ số & Chi tiết');
      expect(recordButton, findsOneWidget);
      await tester.tap(recordButton);
      await tester.pumpAndSettle();

      // Modal is open
      expect(find.textContaining('Ghi chỉ số chi tiết • Căn 101'), findsOneWidget);

      // Trigger FileUploadField onChanged with dummy base64 dataUri
      final uploadFinder = find.byType(FileUploadField);
      expect(uploadFinder, findsOneWidget);
      final uploadWidget = tester.widget<FileUploadField>(uploadFinder);

      // Simulate photo upload
      uploadWidget.onChanged?.call('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==');
      await tester.pump();
      await tester.pumpAndSettle();

      // Verify AI OCR was called
      expect(requests.any((r) => r.path.contains('/meter-ocr')), isTrue);

      // VERIFY AI AUTO-FILL: Input field should now contain '180'
      final inputFinder = find.byWidgetPredicate(
        (w) => w is EditableText && w.controller.text == '180',
      );
      expect(inputFinder, findsOneWidget, reason: 'Reading input field must be auto-filled with AI OCR reading 180');

      // VERIFY AISuggestionField is visible with confidence badge
      expect(find.byType(AISuggestionField), findsWidgets);
      expect(find.text('AI đề xuất'), findsOneWidget);
      expect(find.text('Tin cậy 95%'), findsOneWidget);

      // Confirm AI suggestion
      final confirmBtn = find.text('Xác nhận');
      expect(confirmBtn, findsOneWidget);
      await tester.tap(confirmBtn);
      await tester.pumpAndSettle();

      expect(find.text('Đã xác nhận gợi ý AI'), findsOneWidget);

      // Submit "Lưu nháp"
      final saveDraftBtn = find.widgetWithText(AppButton, 'Lưu nháp').last;
      await tester.ensureVisible(saveDraftBtn);
      await tester.tap(saveDraftBtn);
      await tester.pumpAndSettle();

      // Verify payload includes ai_suggestion_id and reading 180
      final saveReq = requests.lastWhere((r) => r.path.contains('/readings') && r.method == 'POST');
      final data = saveReq.data as Map<String, dynamic>;
      expect(data['current_reading'], 180);
      expect(data['ai_suggestion_id'], 'sugg-single-999');

      // Drain toast timers
      await tester.pump(const Duration(seconds: 5));
    });
  });
}
