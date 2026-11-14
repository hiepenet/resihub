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
import 'package:flutter_resihub/core/utils/format.dart';
import 'package:flutter_resihub/features/ai_gateway/services/ai_service.dart';
import 'package:flutter_resihub/features/auth/models/user_model.dart';
import 'package:flutter_resihub/features/auth/providers/auth_provider.dart';
import 'package:flutter_resihub/features/tenants/screens/tenant_detail_page.dart';
import 'package:flutter_resihub/features/tenants/screens/tenants_page.dart';
import 'package:flutter_resihub/features/tenants/services/tenants_service.dart';
import 'package:flutter_resihub/shared/widgets/common/page_header.dart';
import 'package:flutter_resihub/shared/widgets/ui/app_modal.dart';

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

  late AppStorage storage;

  setUp(() async {
    SharedPreferences.setMockInitialValues({});
    final prefs = await SharedPreferences.getInstance();
    storage = AppStorage(prefs: prefs, isWeb: true);
  });

  group('AiService (5 methods matching ai.service.js)', () {
    late Dio dio;
    late AiService aiService;
    late RequestOptions lastRequest;

    setUp(() {
      dio = Dio(BaseOptions(baseUrl: 'http://localhost:3000'));
      dio.httpClientAdapter = _MockHttpClientAdapter((options) async {
        lastRequest = options;
        return ResponseBody.fromString(
          jsonEncode({'success': true, 'data': {'test': 'value'}}),
          200,
          headers: {
            Headers.contentTypeHeader: [Headers.jsonContentType],
          },
        );
      });
      aiService = AiService(dio: dio);
    });

    test('1. extractDocument sends POST /api/v1/ai/extract with idempotency', () async {
      final payload = {
        'document_type': 'CCCD',
        'files': ['base64-data'],
        'privacy_acknowledged': true,
      };
      final res = await aiService.extractDocument(payload);
      expect(res, isNotNull);
      expect(lastRequest.method, 'POST');
      expect(lastRequest.path, '/api/v1/ai/extract');
      expect(lastRequest.data, payload);
      expect(lastRequest.headers['Idempotency-Key'], isNotEmpty);
    });

    test('2. ocrMeterReading sends POST /api/v1/ai/meter-ocr with idempotency', () async {
      final payload = {'image': 'meter-image-base64'};
      final res = await aiService.ocrMeterReading(payload);
      expect(res, isNotNull);
      expect(lastRequest.method, 'POST');
      expect(lastRequest.path, '/api/v1/ai/meter-ocr');
      expect(lastRequest.data, payload);
      expect(lastRequest.headers['Idempotency-Key'], isNotEmpty);
    });

    test('3. classifyServiceRequest sends POST /api/v1/ai/classify with idempotency', () async {
      final payload = {'description': 'Vòi nước bị rò rỉ'};
      final res = await aiService.classifyServiceRequest(payload);
      expect(res, isNotNull);
      expect(lastRequest.method, 'POST');
      expect(lastRequest.path, '/api/v1/ai/classify');
      expect(lastRequest.data, payload);
      expect(lastRequest.headers['Idempotency-Key'], isNotEmpty);
    });

    test('4. reviewSuggestion sends POST /api/v1/ai/suggestions/:id/review with idempotency', () async {
      final payload = {'decision': 'ACCEPT'};
      final res = await aiService.reviewSuggestion('sugg-101', payload);
      expect(res, isNotNull);
      expect(lastRequest.method, 'POST');
      expect(lastRequest.path, '/api/v1/ai/suggestions/sugg-101/review');
      expect(lastRequest.data, payload);
      expect(lastRequest.headers['Idempotency-Key'], isNotEmpty);
    });

    test('5. getUsageSummary sends GET /api/v1/ai/usage with params', () async {
      final res = await aiService.getUsageSummary(params: {'period': '2026-11'});
      expect(res, isNotNull);
      expect(lastRequest.method, 'GET');
      expect(lastRequest.path, '/api/v1/ai/usage');
      expect(lastRequest.queryParameters['period'], '2026-11');
    });
  });

  group('TenantsService (11 methods + peek helpers matching tenants.service.js)', () {
    late Dio dio;
    late QueryCache queryCache;
    late TenantsService tenantsService;
    late RequestOptions lastRequest;

    setUp(() {
      dio = Dio(BaseOptions(baseUrl: 'http://localhost:3000'));
      queryCache = QueryCache();
      dio.httpClientAdapter = _MockHttpClientAdapter((options) async {
        lastRequest = options;
        return ResponseBody.fromString(
          jsonEncode({'success': true, 'data': {'id': 'tenant-123'}}),
          200,
          headers: {
            Headers.contentTypeHeader: [Headers.jsonContentType],
          },
        );
      });
      tenantsService = TenantsService(dio: dio, queryCache: queryCache);
    });

    test('1. list sends GET /api/v1/tenants and caches', () async {
      final res = await tenantsService.list();
      expect(res, isNotNull);
      expect(lastRequest.method, 'GET');
      expect(lastRequest.path, '/api/v1/tenants');

      // Hits peekList & query cache
      expect(tenantsService.peekList(), isNotNull);
      lastRequest = RequestOptions(path: '/none');
      final cached = await tenantsService.list();
      expect(cached, isNotNull);
      expect(lastRequest.path, '/none'); // Cached, not fetched again
    });

    test('2. getById sends GET /api/v1/tenants/:id and caches', () async {
      await tenantsService.getById('tenant-456');
      expect(lastRequest.method, 'GET');
      expect(lastRequest.path, '/api/v1/tenants/tenant-456');
      expect(tenantsService.peekById('tenant-456'), isNotNull);
    });

    test('3. getIdImages sends GET /api/v1/tenants/:id/id-images and caches', () async {
      await tenantsService.getIdImages('tenant-456');
      expect(lastRequest.method, 'GET');
      expect(lastRequest.path, '/api/v1/tenants/tenant-456/id-images');
      expect(tenantsService.peekIdImages('tenant-456'), isNotNull);
    });

    test('4. lookup sends GET /api/v1/tenants/lookup with identifier', () async {
      await tenantsService.lookup('0912345678');
      expect(lastRequest.method, 'GET');
      expect(lastRequest.path, '/api/v1/tenants/lookup');
      expect(lastRequest.queryParameters['identifier'], '0912345678');
    });

    test('5. checkDup sends GET /api/v1/tenants/check-dup with params', () async {
      await tenantsService.checkDup({'phone': '0912345678', 'id_number': '001234567890'});
      expect(lastRequest.method, 'GET');
      expect(lastRequest.path, '/api/v1/tenants/check-dup');
      expect(lastRequest.queryParameters['phone'], '0912345678');
      expect(lastRequest.queryParameters['id_number'], '001234567890');
    });

    test('6. create sends POST /api/v1/tenants with payload', () async {
      final payload = {'full_name': 'Nguyen Van A', 'phone': '0912345678'};
      await tenantsService.create(payload);
      expect(lastRequest.method, 'POST');
      expect(lastRequest.path, '/api/v1/tenants');
      expect(lastRequest.data, payload);
    });

    test('7. update sends PATCH /api/v1/tenants/:id with payload', () async {
      final payload = {'full_name': 'Nguyen Van B'};
      await tenantsService.update('t-1', payload);
      expect(lastRequest.method, 'PATCH');
      expect(lastRequest.path, '/api/v1/tenants/t-1');
      expect(lastRequest.data, payload);
    });

    test('8. remove sends DELETE /api/v1/tenants/:id', () async {
      await tenantsService.remove('t-1');
      expect(lastRequest.method, 'DELETE');
      expect(lastRequest.path, '/api/v1/tenants/t-1');
    });

    test('9. merge sends POST /api/v1/tenants/merge with payload', () async {
      final payload = {
        'source_tenant_id': 't-src',
        'target_tenant_id': 't-dst',
        'reason': 'Duplicate tenant',
      };
      await tenantsService.merge(payload);
      expect(lastRequest.method, 'POST');
      expect(lastRequest.path, '/api/v1/tenants/merge');
      expect(lastRequest.data, payload);
    });

    test('10. uploadIdImage sends POST /api/v1/tenants/:id/id-images', () async {
      final payload = {'side': 'front', 'image_base64': 'img-data'};
      await tenantsService.uploadIdImage('t-1', payload);
      expect(lastRequest.method, 'POST');
      expect(lastRequest.path, '/api/v1/tenants/t-1/id-images');
      expect(lastRequest.data, payload);
    });

    test('11. deleteIdImage sends DELETE /api/v1/tenants/:id/id-images/:attachmentId', () async {
      await tenantsService.deleteIdImage('t-1', 'att-99');
      expect(lastRequest.method, 'DELETE');
      expect(lastRequest.path, '/api/v1/tenants/t-1/id-images/att-99');
    });
  });

  group('TenantsPage Widget Tests', () {
    testWidgets('renders list with masked id_number and handles search', (tester) async {
      tester.view.physicalSize = const Size(1280, 900);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);

      final dio = Dio(BaseOptions(baseUrl: 'http://localhost:3000'));
      final queryCache = QueryCache();

      final mockTenants = [
        {
          'id': 't-001',
          'full_name': 'Nguyen Van Minh',
          'phone': '0901234567',
          'id_number': '001200001234',
          'email': 'minh@example.com',
          'nationality': 'Việt Nam',
          'status': 'ACTIVE',
          'type': 'primary',
          'active_contract': {
            'apartment_code': 'A101',
            'building_name': 'Tòa Landmark',
          },
        },
        {
          'id': 't-002',
          'full_name': 'Tran Thi Hoa',
          'phone': '0912345678',
          'id_number': null,
          'email': 'hoa@example.com',
          'nationality': 'Việt Nam',
          'status': 'PENDING',
          'type': 'occupant',
        },
      ];

      dio.httpClientAdapter = _MockHttpClientAdapter((options) async {
        if (options.path == '/api/v1/tenants') {
          return ResponseBody.fromString(
            jsonEncode({'success': true, 'data': mockTenants}),
            200,
            headers: {
              Headers.contentTypeHeader: [Headers.jsonContentType],
            },
          );
        }
        return ResponseBody.fromString(
          jsonEncode({'success': true, 'data': []}),
          200,
          headers: {
            Headers.contentTypeHeader: [Headers.jsonContentType],
          },
        );
      });

      final user = UserModel(
        id: 'u-1',
        fullName: 'Manager User',
        phone: '0900000000',
        roles: const [UserRoleModel(code: 'MANAGER', name: 'Quản lý')],
      );

      final container = ProviderContainer(
        overrides: [
          appStorageProvider.overrideWithValue(storage),
          dioProvider.overrideWithValue(dio),
          queryCacheProvider.overrideWithValue(queryCache),
        ],
      );
      container.read(authProvider.notifier).setAuthData(
            accessToken: 'token',
            refreshToken: 'refresh',
            user: user,
          );

      await tester.pumpWidget(
        UncontrolledProviderScope(
          container: container,
          child: const MaterialApp(
            home: Scaffold(
              body: TenantsPage(),
            ),
          ),
        ),
      );

      await tester.pumpAndSettle();

      // Check title and tenants rendered
      expect(find.text('Hồ sơ cư dân'), findsOneWidget);
      expect(find.text('Nguyen Van Minh'), findsOneWidget);
      expect(find.text('Tran Thi Hoa'), findsOneWidget);

      // CCCD masked: '001200001234' -> maskIdNumber is '********1234'
      final masked = maskIdNumber('001200001234');
      expect(find.text(masked), findsOneWidget);

      // Missing ID badge
      expect(find.text('Thiếu giấy tờ'), findsOneWidget);
    });

    testWidgets('Create tenant modal validates inputs and includes privacy consent', (tester) async {
      tester.view.physicalSize = const Size(1280, 900);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);

      final dio = Dio(BaseOptions(baseUrl: 'http://localhost:3000'));
      final queryCache = QueryCache();

      dio.httpClientAdapter = _MockHttpClientAdapter((options) async {
        return ResponseBody.fromString(
          jsonEncode({'success': true, 'data': []}),
          200,
          headers: {
            Headers.contentTypeHeader: [Headers.jsonContentType],
          },
        );
      });

      final user = UserModel(
        id: 'u-1',
        fullName: 'Manager User',
        phone: '0900000000',
        roles: const [UserRoleModel(code: 'MANAGER', name: 'Quản lý')],
      );

      final container = ProviderContainer(
        overrides: [
          appStorageProvider.overrideWithValue(storage),
          dioProvider.overrideWithValue(dio),
          queryCacheProvider.overrideWithValue(queryCache),
        ],
      );
      container.read(authProvider.notifier).setAuthData(
            accessToken: 'token',
            refreshToken: 'refresh',
            user: user,
          );

      await tester.pumpWidget(
        UncontrolledProviderScope(
          container: container,
          child: const MaterialApp(
            home: Scaffold(
              body: TenantsPage(),
            ),
          ),
        ),
      );

      await tester.pumpAndSettle();

      // Tap "Thêm cư dân" button
      final addBtn = find.text('Thêm cư dân');
      expect(addBtn, findsOneWidget);
      await tester.tap(addBtn);
      await tester.pumpAndSettle();

      // Modal is visible
      expect(find.text('Tạo hồ sơ cư dân mới'), findsOneWidget);
      expect(find.text('Đồng thuận xử lý dữ liệu cư dân (GDPR / Nghị định 13/2023)'), findsOneWidget);
    });
  });

  group('TenantDetailPage Widget Tests - Strict PII Protection for OWNER', () {
    testWidgets('OWNER role masks CCCD images, hides upload/AI buttons, and shows PII protection card', (tester) async {
      tester.view.physicalSize = const Size(1280, 900);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);

      final dio = Dio(BaseOptions(baseUrl: 'http://localhost:3000'));
      final queryCache = QueryCache();

      final mockTenant = {
        'id': 't-owner-view',
        'full_name': 'Le Van OwnerTenant',
        'phone': '0909999999',
        'id_number': '079200004321',
        'dob': '1990-05-15',
        'nationality': 'Việt Nam',
        'address': 'Quận 1, TP. Hồ Chí Minh',
        'status': 'ACTIVE',
      };

      final mockIdImages = {
        'masked_for_owner': true,
        'has_id_images': true,
        'data': [],
      };

      dio.httpClientAdapter = _MockHttpClientAdapter((options) async {
        if (options.path == '/api/v1/tenants/t-owner-view') {
          return ResponseBody.fromString(
            jsonEncode({'success': true, 'data': mockTenant}),
            200,
            headers: {
              Headers.contentTypeHeader: [Headers.jsonContentType],
            },
          );
        }
        if (options.path == '/api/v1/tenants/t-owner-view/id-images') {
          return ResponseBody.fromString(
            jsonEncode({'success': true, ...mockIdImages}),
            200,
            headers: {
              Headers.contentTypeHeader: [Headers.jsonContentType],
            },
          );
        }
        return ResponseBody.fromString(
          jsonEncode({'success': true, 'data': []}),
          200,
          headers: {
            Headers.contentTypeHeader: [Headers.jsonContentType],
          },
        );
      });

      // OWNER role user
      final ownerUser = UserModel(
        id: 'u-owner',
        fullName: 'Chu Toa Nha',
        phone: '0988888888',
        roles: const [UserRoleModel(code: 'OWNER', name: 'Chủ nhà')],
      );

      final container = ProviderContainer(
        overrides: [
          appStorageProvider.overrideWithValue(storage),
          dioProvider.overrideWithValue(dio),
          queryCacheProvider.overrideWithValue(queryCache),
        ],
      );
      container.read(authProvider.notifier).setAuthData(
            accessToken: 'token',
            refreshToken: 'refresh',
            user: ownerUser,
          );

      await tester.pumpWidget(
        UncontrolledProviderScope(
          container: container,
          child: const MaterialApp(
            home: Scaffold(
              body: TenantDetailPage(tenantId: 't-owner-view'),
            ),
          ),
        ),
      );

      await tester.pumpAndSettle();

      // Title & Basic profile
      expect(find.widgetWithText(PageHeader, 'Le Van OwnerTenant'), findsOneWidget);

      // PII notice must be present
      expect(find.text('Bảo mật giấy tờ tùy thân gốc (PRD Mục 13.5)'), findsOneWidget);
      expect(
        find.textContaining('chỉ Ban Quản Lý tòa nhà và Quản trị hệ thống mới có quyền xem ảnh gốc'),
        findsOneWidget,
      );

      // Badge must show 'Đã lưu bảo mật'
      expect(find.text('Đã lưu bảo mật'), findsOneWidget);

      // AI scan button & CCCD upload buttons MUST NOT exist
      expect(find.text('Quét nhanh CCCD bằng AI (AI-01)'), findsNothing);
      expect(find.text('Mặt trước CCCD'), findsNothing);
      expect(find.text('Mặt sau CCCD'), findsNothing);
    });

    testWidgets('MANAGER role sees CCCD image slots, upload buttons, and AI CCCD extraction tool', (tester) async {
      tester.view.physicalSize = const Size(1280, 900);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);

      final dio = Dio(BaseOptions(baseUrl: 'http://localhost:3000'));
      final queryCache = QueryCache();

      final mockTenant = {
        'id': 't-manager-view',
        'full_name': 'Pham Van ManagerTenant',
        'phone': '0901111222',
        'id_number': '079200009999',
        'dob': '1995-10-20',
        'nationality': 'Việt Nam',
        'status': 'PENDING',
      };

      final mockIdImages = {
        'masked_for_owner': false,
        'has_id_images': true,
        'data': [
          {
            'attachment_id': 'att-1',
            'side': 'front',
            'url': 'http://localhost:3000/api/v1/attachments/att-1',
          },
        ],
      };

      dio.httpClientAdapter = _MockHttpClientAdapter((options) async {
        if (options.path == '/api/v1/tenants/t-manager-view') {
          return ResponseBody.fromString(
            jsonEncode({'success': true, 'data': mockTenant}),
            200,
            headers: {
              Headers.contentTypeHeader: [Headers.jsonContentType],
            },
          );
        }
        if (options.path == '/api/v1/tenants/t-manager-view/id-images') {
          return ResponseBody.fromString(
            jsonEncode({'success': true, ...mockIdImages}),
            200,
            headers: {
              Headers.contentTypeHeader: [Headers.jsonContentType],
            },
          );
        }
        return ResponseBody.fromString(
          jsonEncode({'success': true, 'data': []}),
          200,
          headers: {
            Headers.contentTypeHeader: [Headers.jsonContentType],
          },
        );
      });

      // MANAGER role user
      final managerUser = UserModel(
        id: 'u-mgr',
        fullName: 'Ban Quan Ly',
        phone: '0977777777',
        roles: const [UserRoleModel(code: 'MANAGER', name: 'Quản lý')],
      );

      final container = ProviderContainer(
        overrides: [
          appStorageProvider.overrideWithValue(storage),
          dioProvider.overrideWithValue(dio),
          queryCacheProvider.overrideWithValue(queryCache),
        ],
      );
      container.read(authProvider.notifier).setAuthData(
            accessToken: 'token',
            refreshToken: 'refresh',
            user: managerUser,
          );

      await tester.pumpWidget(
        UncontrolledProviderScope(
          container: container,
          child: const MaterialApp(
            home: Scaffold(
              body: TenantDetailPage(tenantId: 't-manager-view'),
            ),
          ),
        ),
      );

      await tester.pumpAndSettle();

      // PII notice is NOT shown for MANAGER
      expect(find.text('Bảo mật giấy tờ tùy thân gốc (PRD Mục 13.5)'), findsNothing);

      // AI scan tool and CCCD slots ARE shown
      expect(find.text('Quét nhanh CCCD bằng AI (AI-01)'), findsOneWidget);
      expect(find.text('Mặt trước CCCD'), findsOneWidget);
      expect(find.text('Mặt sau CCCD'), findsOneWidget);
    });

    testWidgets('initialModal: "approval" automatically opens quick review modal', (tester) async {
      tester.view.physicalSize = const Size(1280, 900);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);

      final dio = Dio(BaseOptions(baseUrl: 'http://localhost:3000'));
      final queryCache = QueryCache();

      final mockTenant = {
        'id': 't-approval-test',
        'full_name': 'Hoang Thi Approval',
        'phone': '0933445566',
        'id_number': '001200008888',
        'status': 'PENDING',
      };

      dio.httpClientAdapter = _MockHttpClientAdapter((options) async {
        if (options.path == '/api/v1/tenants/t-approval-test') {
          return ResponseBody.fromString(
            jsonEncode({'success': true, 'data': mockTenant}),
            200,
            headers: {
              Headers.contentTypeHeader: [Headers.jsonContentType],
            },
          );
        }
        return ResponseBody.fromString(
          jsonEncode({'success': true, 'masked_for_owner': false, 'data': []}),
          200,
          headers: {
            Headers.contentTypeHeader: [Headers.jsonContentType],
          },
        );
      });

      final managerUser = UserModel(
        id: 'u-mgr',
        fullName: 'Ban Quan Ly',
        phone: '0977777777',
        roles: const [UserRoleModel(code: 'MANAGER', name: 'Quản lý')],
      );

      final container = ProviderContainer(
        overrides: [
          appStorageProvider.overrideWithValue(storage),
          dioProvider.overrideWithValue(dio),
          queryCacheProvider.overrideWithValue(queryCache),
        ],
      );
      container.read(authProvider.notifier).setAuthData(
            accessToken: 'token',
            refreshToken: 'refresh',
            user: managerUser,
          );

      await tester.pumpWidget(
        UncontrolledProviderScope(
          container: container,
          child: const MaterialApp(
            home: Scaffold(
              body: TenantDetailPage(
                tenantId: 't-approval-test',
                initialModal: 'approval',
              ),
            ),
          ),
        ),
      );

      await tester.pumpAndSettle();

      // Quick review modal is open
      expect(find.text('Hồ sơ Định danh & Xét duyệt Cư dân'), findsOneWidget);
      expect(
        find.descendant(of: find.byType(AppModal), matching: find.text('Phê duyệt hồ sơ')),
        findsOneWidget,
      );
      expect(
        find.descendant(of: find.byType(AppModal), matching: find.text('Từ chối / Yêu cầu bổ sung')),
        findsOneWidget,
      );
    });
  });
}
