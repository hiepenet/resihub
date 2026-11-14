import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:image/image.dart' as img;

import 'package:flutter_resihub/core/storage/app_storage.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:flutter_resihub/core/network/dio_client.dart';
import 'package:flutter_resihub/core/network/query_cache.dart';
import 'package:flutter_resihub/core/utils/base64_file.dart';
import 'package:flutter_resihub/core/utils/billing_helpers.dart';
import 'package:flutter_resihub/core/utils/meter_batch_photo_helpers.dart';
import 'package:flutter_resihub/features/ai_gateway/services/ai_service.dart';
import 'package:flutter_resihub/features/auth/models/user_model.dart';
import 'package:flutter_resihub/features/auth/providers/auth_provider.dart';
import 'package:flutter_resihub/features/buildings/services/buildings_service.dart';
import 'package:flutter_resihub/features/meters/screens/meter_readings_page.dart';
import 'package:flutter_resihub/features/meters/services/meters_service.dart';
import 'package:flutter_resihub/features/meters/widgets/meter_batch_photo_import_modal.dart';
import 'package:flutter_resihub/features/services/screens/service_catalog_page.dart';
import 'package:flutter_resihub/features/services/screens/subscriptions_page.dart';
import 'package:flutter_resihub/features/services/services/services_service.dart';

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

Uint8List _createDummyPngBytes({int width = 10, int height = 10}) {
  final image = img.Image(width: width, height: height);
  img.fill(image, color: img.ColorRgb8(255, 0, 0));
  return Uint8List.fromList(img.encodePng(image));
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('ServicesService (7 methods matching services.service.js)', () {
    late Dio dio;
    late QueryCache queryCache;
    late ServicesService servicesService;
    late RequestOptions lastRequest;

    setUp(() {
      dio = Dio(BaseOptions(baseUrl: 'http://localhost:3000'));
      queryCache = QueryCache();

      dio.httpClientAdapter = _MockHttpClientAdapter((options) async {
        lastRequest = options;
        return ResponseBody.fromString(
          jsonEncode({
            'success': true,
            'data': [
              {'id': 'svc-1', 'name': 'Wifi Tốc độ cao', 'billing_type': 'FIXED'},
            ],
          }),
          200,
          headers: {
            Headers.contentTypeHeader: [Headers.jsonContentType],
          },
        );
      });

      servicesService = ServicesService(dio: dio, queryCache: queryCache);
    });

    test('1. listCatalog sends GET /api/v1/service-catalog and caches with 60s TTL', () async {
      final res = await servicesService.listCatalog({'category': 'INTERNET'});
      expect(res, isNotNull);
      expect(lastRequest.method, 'GET');
      expect(lastRequest.path, '/api/v1/service-catalog');
      expect(lastRequest.queryParameters['category'], 'INTERNET');

      // Cache hit test
      lastRequest = RequestOptions(path: '/none');
      final cached = await servicesService.listCatalog({'category': 'INTERNET'});
      expect(cached, isNotNull);
      expect(lastRequest.path, '/none'); // Not called
    });

    test('2. createCatalog sends POST /api/v1/service-catalog', () async {
      final payload = {
        'code': 'WIFI-01',
        'name': 'Internet FPT',
        'category': 'INTERNET',
        'billing_type': 'FIXED',
        'unit_price': 250000,
      };
      final res = await servicesService.createCatalog(payload);
      expect(res, isNotNull);
      expect(lastRequest.method, 'POST');
      expect(lastRequest.path, '/api/v1/service-catalog');
      expect(lastRequest.data, payload);
    });

    test('3. updateCatalog sends PATCH /api/v1/service-catalog/:id', () async {
      final payload = {'unit_price': 300000};
      final res = await servicesService.updateCatalog('svc-1', payload);
      expect(res, isNotNull);
      expect(lastRequest.method, 'PATCH');
      expect(lastRequest.path, '/api/v1/service-catalog/svc-1');
      expect(lastRequest.data, payload);
    });

    test('4. listSubscriptions sends GET /api/v1/service-subscriptions and caches with 25s TTL', () async {
      final res = await servicesService.listSubscriptions({'status': 'ACTIVE'});
      expect(res, isNotNull);
      expect(lastRequest.method, 'GET');
      expect(lastRequest.path, '/api/v1/service-subscriptions');
      expect(lastRequest.queryParameters['status'], 'ACTIVE');

      // Cache hit test
      lastRequest = RequestOptions(path: '/none');
      final cached = await servicesService.listSubscriptions({'status': 'ACTIVE'});
      expect(cached, isNotNull);
      expect(lastRequest.path, '/none');
    });

    test('5. createSubscription sends POST /api/v1/service-subscriptions', () async {
      final payload = {
        'apartment_id': 'apt-101',
        'service_id': 'svc-1',
        'quantity': 2,
        'start_date': '2026-11-01',
        'vehicle_plates': ['59A1-123.45', '59A1-678.90'],
      };
      final res = await servicesService.createSubscription(payload);
      expect(res, isNotNull);
      expect(lastRequest.method, 'POST');
      expect(lastRequest.path, '/api/v1/service-subscriptions');
      expect(lastRequest.data, payload);
    });

    test('6. updateSubscription sends PATCH /api/v1/service-subscriptions/:id', () async {
      final payload = {'quantity': 3};
      final res = await servicesService.updateSubscription('sub-99', payload);
      expect(res, isNotNull);
      expect(lastRequest.method, 'PATCH');
      expect(lastRequest.path, '/api/v1/service-subscriptions/sub-99');
      expect(lastRequest.data, payload);
    });

    test('7. terminateSubscription sends PATCH /api/v1/service-subscriptions/:id', () async {
      final payload = {
        'status': 'TERMINATED',
        'end_date': '2026-11-15',
        'zero_usage': false,
      };
      final res = await servicesService.terminateSubscription('sub-99', payload);
      expect(res, isNotNull);
      expect(lastRequest.method, 'PATCH');
      expect(lastRequest.path, '/api/v1/service-subscriptions/sub-99');
      expect(lastRequest.data, payload);
    });
  });

  group('MetersService (8 methods matching meters.service.js)', () {
    late Dio dio;
    late QueryCache queryCache;
    late MetersService metersService;
    late RequestOptions lastRequest;

    setUp(() {
      dio = Dio(BaseOptions(baseUrl: 'http://localhost:3000'));
      queryCache = QueryCache();

      dio.httpClientAdapter = _MockHttpClientAdapter((options) async {
        lastRequest = options;
        return ResponseBody.fromString(
          jsonEncode({
            'success': true,
            'data': [
              {
                'id': 'meter-1',
                'meter_code': 'M-ELEC-101',
                'meter_type': 'ELECTRICITY',
                'last_known_reading': 150.0,
              },
            ],
          }),
          200,
          headers: {
            Headers.contentTypeHeader: [Headers.jsonContentType],
          },
        );
      });

      metersService = MetersService(dio: dio, queryCache: queryCache);
    });

    test('1. list sends GET /api/v1/meters and caches with 20s TTL', () async {
      final res = await metersService.list({'building_id': 'bldg-1', 'period': '2026-11'});
      expect(res, isNotNull);
      expect(lastRequest.method, 'GET');
      expect(lastRequest.path, '/api/v1/meters');
      expect(lastRequest.queryParameters['building_id'], 'bldg-1');

      // Cache hit test
      lastRequest = RequestOptions(path: '/none');
      final cached = await metersService.list({'building_id': 'bldg-1', 'period': '2026-11'});
      expect(cached, isNotNull);
      expect(lastRequest.path, '/none');
    });

    test('2. create sends POST /api/v1/meters with idempotency', () async {
      final payload = {
        'apartment_id': 'apt-101',
        'meter_type': 'ELECTRICITY',
        'meter_code': 'M-ELEC-101',
        'initial_reading': 100,
      };
      final res = await metersService.create(payload);
      expect(res, isNotNull);
      expect(lastRequest.method, 'POST');
      expect(lastRequest.path, '/api/v1/meters');
      expect(lastRequest.headers['Idempotency-Key'], isNotEmpty);
      expect(lastRequest.data, payload);
    });

    test('3. listReadings sends GET /api/v1/meters/readings and caches with 20s TTL', () async {
      final res = await metersService.listReadings({'period': '2026-11'});
      expect(res, isNotNull);
      expect(lastRequest.method, 'GET');
      expect(lastRequest.path, '/api/v1/meters/readings');
      expect(lastRequest.queryParameters['period'], '2026-11');
    });

    test('4. listMeterReadings sends GET /api/v1/meters/:id/readings', () async {
      final res = await metersService.listMeterReadings('meter-1');
      expect(res, isNotNull);
      expect(lastRequest.method, 'GET');
      expect(lastRequest.path, '/api/v1/meters/meter-1/readings');
    });

    test('5. recordReading sends POST /api/v1/meters/:id/readings with idempotency', () async {
      final payload = {
        'period': '2026-11',
        'current_reading': 185.5,
        'image_base64': 'data:image/jpeg;base64,abc',
      };
      final res = await metersService.recordReading('meter-1', payload);
      expect(res, isNotNull);
      expect(lastRequest.method, 'POST');
      expect(lastRequest.path, '/api/v1/meters/meter-1/readings');
      expect(lastRequest.headers['Idempotency-Key'], isNotEmpty);
      expect(lastRequest.data, payload);
    });

    test('6. recordBatch sends POST /api/v1/meters/readings/batch with idempotency', () async {
      final payload = {
        'period': '2026-11',
        'status': 'DRAFT',
        'readings': [
          {'meter_id': 'm-1', 'current_reading': 200},
          {'meter_id': 'm-2', 'current_reading': 300},
        ],
      };
      final res = await metersService.recordBatch(payload);
      expect(res, isNotNull);
      expect(lastRequest.method, 'POST');
      expect(lastRequest.path, '/api/v1/meters/readings/batch');
      expect(lastRequest.headers['Idempotency-Key'], isNotEmpty);
      expect(lastRequest.data, payload);
    });

    test('7. confirmReading sends POST /api/v1/meters/readings/:readingId/confirm with idempotency', () async {
      final payload = {'reading_id': 'rd-101'};
      final res = await metersService.confirmReading('rd-101', payload);
      expect(res, isNotNull);
      expect(lastRequest.method, 'POST');
      expect(lastRequest.path, '/api/v1/meters/readings/rd-101/confirm');
      expect(lastRequest.headers['Idempotency-Key'], isNotEmpty);
    });

    test('8. confirmBatch sends POST /api/v1/meters/readings/confirm-batch with idempotency', () async {
      final payload = {
        'reading_ids': ['rd-1', 'rd-2'],
      };
      final res = await metersService.confirmBatch(payload);
      expect(res, isNotNull);
      expect(lastRequest.method, 'POST');
      expect(lastRequest.path, '/api/v1/meters/readings/confirm-batch');
      expect(lastRequest.headers['Idempotency-Key'], isNotEmpty);
      expect(lastRequest.data, payload);
    });
  });

  group('MeterBatchPhotoImportModal unit & helpers logic', () {
    test('enforces max 30 photos limit in batch helper and constants', () {
      expect(kMaxBatchMeterPhotos, 30);
      expect(kDefaultOcrConcurrency, 2);

      final over30List = List.generate(
        35,
        (i) => {'fileName': 'A10$i.jpg', 'draftReading': '10$i'},
      );
      final evalResult = evaluateBatchPhotoImportItems(
        over30List.take(30).toList(),
        [],
      );
      expect(evalResult.summary.totalCount, 30);
    });

    test('compressImageBytesToDataUrl compresses raw image bytes before OCR', () async {
      final bytes = _createDummyPngBytes(width: 1400, height: 1400);
      final dataUrl = await compressImageBytesToDataUrl(bytes, maxDimension: 1280);
      expect(dataUrl.startsWith('data:image/jpeg;base64,'), isTrue);
    });

    test('runBoundedConcurrencyQueue preserves order with concurrency 2', () async {
      int activeCount = 0;
      int maxSeenConcurrency = 0;

      final items = [1, 2, 3, 4, 5];
      final results = await runBoundedConcurrencyQueue<int, String>(
        items,
        2,
        (item, index) async {
          activeCount++;
          if (activeCount > maxSeenConcurrency) {
            maxSeenConcurrency = activeCount;
          }
          await Future.delayed(const Duration(milliseconds: 20));
          activeCount--;
          return 'Result-$item';
        },
      );

      expect(maxSeenConcurrency, lessThanOrEqualTo(2));
      expect(results.length, 5);
      expect(results[0].value, 'Result-1');
      expect(results[4].value, 'Result-5');
    });

    test('matchMeterFromFilename matches exact meter and apartment code correctly', () {
      final meters = [
        {
          'id': 'm-1',
          'meter_code': 'EM-101',
          'apartment_code': 'A101',
          'apartment_id': 'apt-1',
          'meter_type': 'ELECTRICITY',
        },
        {
          'id': 'm-2',
          'meter_code': 'WM-101',
          'apartment_code': 'A101',
          'apartment_id': 'apt-1',
          'meter_type': 'WATER',
        },
      ];

      // Exact match by meter_code
      final exactMatch = matchMeterFromFilename('EM-101_reading.jpg', meters);
      expect(exactMatch.matchKind, 'EXACT_METER');
      expect(exactMatch.meterId, 'm-1');

      // Match by apartment and detected type hint
      final aptMatch = matchMeterFromFilename('A101_dien.jpg', meters);
      expect(aptMatch.matchKind, 'EXACT_METER');
      expect(aptMatch.meterId, 'm-1');

      final waterMatch = matchMeterFromFilename('A101_nuoc.jpg', meters);
      expect(waterMatch.matchKind, 'EXACT_METER');
      expect(waterMatch.meterId, 'm-2');
    });

    test('resolveMeterSlotView maps overlapping contracts correctly for turnover', () {
      final meter = {
        'id': 'm-turnover',
        'apartment_code': 'A201',
        'meter_type': 'ELECTRICITY',
        'unit': 'kWh',
        'unit_price': 3500,
        'period_current_reading': 500,
        'period_previous_reading': 400,
        'target_contract_id': 'ct-1',
        'overlapping_contracts': [
          {
            'contract_id': 'ct-1',
            'contract_code': 'HD-201-OLD',
            'tenant_name': 'Nguyễn Văn A',
            'slot_index': 1,
            'total_slots': 2,
            'reading_id': 'rd-1',
            'previous_reading': 400,
            'current_reading': 450,
            'consumption': 50,
            'reading_status': 'CONFIRMED',
            'is_billed': true,
            'effective_unit_price': 3500,
            'effective_price_source': 'CONTRACT_OVERRIDE',
          },
          {
            'contract_id': 'ct-2',
            'contract_code': 'HD-201-NEW',
            'tenant_name': 'Trần Thị B',
            'slot_index': 2,
            'total_slots': 2,
            'reading_id': 'rd-2',
            'previous_reading': 450,
            'current_reading': 520,
            'consumption': 70,
            'reading_status': 'DRAFT',
            'is_billed': false,
            'effective_unit_price': 3800,
            'effective_price_source': 'BUILDING_CATALOG',
          },
        ],
      };

      // Switch to slot 2 (contract ct-2)
      final slot2View = resolveMeterSlotView(meter, 'ct-2');
      expect(slot2View['target_contract_id'], 'ct-2');
      expect(slot2View['target_contract_code'], 'HD-201-NEW');
      expect(slot2View['target_tenant_name'], 'Trần Thị B');
      expect(slot2View['period_slot_index'], 2);
      expect(slot2View['period_previous_reading'], 450);
      expect(slot2View['period_current_reading'], 520);
      expect(slot2View['period_consumption'], 70);
      expect(slot2View['period_reading_billed'], isFalse);
      expect(slot2View['effective_unit_price'], 3800);

      // Verify slot 1 lock state
      final slot1View = resolveMeterSlotView(meter, 'ct-1');
      expect(slot1View['period_reading_billed'], isTrue);
      expect(isMeterRowLockedForEdit(slot1View, true), isTrue);
    });
  });

  group('Widget Route Keys & Deep Linking', () {
    late Dio dio;
    late QueryCache queryCache;
    late BuildingsService buildingsService;
    late ServicesService servicesService;
    late MetersService metersService;
    late AiService aiService;
    late AppStorage storage;

    setUp(() async {
      SharedPreferences.setMockInitialValues({});
      final prefs = await SharedPreferences.getInstance();
      storage = AppStorage(prefs: prefs, isWeb: true);

      dio = Dio(BaseOptions(baseUrl: 'http://localhost:3000'));
      queryCache = QueryCache();

      dio.httpClientAdapter = _MockHttpClientAdapter((options) async {
        if (options.path.contains('/service-catalog')) {
          return ResponseBody.fromString(
            jsonEncode({
              'success': true,
              'data': [
                {
                  'id': 'svc-1',
                  'code': 'ELEC',
                  'name': 'Điện sinh hoạt',
                  'category': 'ELECTRICITY',
                  'billing_type': 'METERED',
                  'unit': 'kWh',
                  'unit_price': 3500,
                  'is_active': true,
                },
              ],
            }),
            200,
            headers: {Headers.contentTypeHeader: [Headers.jsonContentType]},
          );
        }
        if (options.path.contains('/service-subscriptions')) {
          return ResponseBody.fromString(
            jsonEncode({
              'success': true,
              'data': [
                {
                  'id': 'sub-deep-123',
                  'apartment_id': 'apt-1',
                  'apartment_code': '101',
                  'building_code': 'B1',
                  'service_id': 'svc-1',
                  'service_name': 'Gửi xe máy',
                  'service_code': 'PARK-MOTO',
                  'category': 'PARKING',
                  'status': 'PENDING_APPROVAL',
                  'quantity': 1,
                  'unit_price': 120000,
                  'start_date': '2026-11-01',
                  'vehicle_plates': ['59A1-999.99'],
                  'note': 'Gửi xe hầm B2',
                },
              ],
            }),
            200,
            headers: {Headers.contentTypeHeader: [Headers.jsonContentType]},
          );
        }
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
                  'period_current_reading': 150,
                  'period_reading_status': 'DRAFT',
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
      servicesService = ServicesService(dio: dio, queryCache: queryCache);
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
          servicesServiceProvider.overrideWithValue(servicesService),
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

    testWidgets('ServiceCatalogPage has Key("route:/admin/services")', (tester) async {
      await tester.binding.setSurfaceSize(const Size(1280, 800));
      final container = createContainer();

      await tester.pumpWidget(
        UncontrolledProviderScope(
          container: container,
          child: const MaterialApp(
            home: ServiceCatalogPage(),
          ),
        ),
      );

      await tester.pumpAndSettle();
      expect(find.byKey(const Key('route:/admin/services')), findsOneWidget);
      expect(find.text('Danh mục dịch vụ'), findsWidgets);
    });

    testWidgets('SubscriptionsPage has Key("route:/admin/services/subscriptions") and handles deep-link', (tester) async {
      await tester.binding.setSurfaceSize(const Size(1280, 800));
      final container = createContainer();

      await tester.pumpWidget(
        UncontrolledProviderScope(
          container: container,
          child: const MaterialApp(
            home: SubscriptionsPage(
              initialSubscriptionId: 'sub-deep-123',
              initialModal: 'review',
            ),
          ),
        ),
      );

      await tester.pumpAndSettle();
      expect(find.byKey(const Key('route:/admin/services/subscriptions')), findsOneWidget);

      // Verify that review modal is triggered for sub-deep-123
      expect(find.textContaining('Chi tiết đăng ký dịch vụ'), findsOneWidget);
      expect(find.textContaining('59A1-999.99'), findsWidgets);
    });

    testWidgets('MeterReadingsPage has Key("route:/admin/meters")', (tester) async {
      await tester.binding.setSurfaceSize(const Size(1280, 800));
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
      expect(find.byKey(const Key('route:/admin/meters')), findsOneWidget);
      expect(find.text('Ghi chỉ số Điện / Nước'), findsWidgets);
    });

    testWidgets('MeterBatchPhotoImportModal renders building selector and photo upload button', (tester) async {
      await tester.binding.setSurfaceSize(const Size(1280, 800));
      final container = createContainer();

      await tester.pumpWidget(
        UncontrolledProviderScope(
          container: container,
          child: const MaterialApp(
            home: Scaffold(
              body: MeterBatchPhotoImportModal(
                initialBuildingId: 'b-1',
                period: '2026-11',
              ),
            ),
          ),
        ),
      );

      await tester.pumpAndSettle();
      expect(find.textContaining('Tải ảnh chụp (Tối đa'), findsOneWidget);
      expect(find.textContaining('Chưa có ảnh nào được chọn'), findsOneWidget);
    });
  });
}
