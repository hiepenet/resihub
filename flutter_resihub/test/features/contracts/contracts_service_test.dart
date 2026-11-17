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
import 'package:flutter_resihub/features/auth/models/user_model.dart';
import 'package:flutter_resihub/features/auth/providers/auth_provider.dart';
import 'package:flutter_resihub/features/contracts/screens/contract_detail_page.dart';
import 'package:flutter_resihub/features/contracts/screens/contracts_page.dart';
import 'package:flutter_resihub/features/contracts/services/contracts_service.dart';

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

  group('ContractsService - All 29 methods matching contracts.service.js', () {
    late Dio dio;
    late QueryCache queryCache;
    late ContractsService service;
    late RequestOptions lastRequest;

    setUp(() {
      dio = Dio(BaseOptions(baseUrl: 'http://localhost:3000'));
      queryCache = QueryCache();

      dio.httpClientAdapter = _MockHttpClientAdapter((options) async {
        lastRequest = options;

        if (options.path.endsWith('/template')) {
          return ResponseBody.fromString(
            '<html><body><h1>Hợp Đồng Thuê Nhà</h1></body></html>',
            200,
            headers: {
              Headers.contentTypeHeader: ['text/html; charset=utf-8'],
            },
          );
        }

        return ResponseBody.fromString(
          jsonEncode({
            'success': true,
            'data': {'id': 'test-contract-123'},
            'message': 'Success',
          }),
          200,
          headers: {
            Headers.contentTypeHeader: [Headers.jsonContentType],
          },
        );
      });

      service = ContractsService(dio: dio, queryCache: queryCache);
    });

    test('1. list sends GET /api/v1/contracts and caches with peekList', () async {
      final res = await service.list({'building_id': 'b-1'});
      expect(res, isNotNull);
      expect(lastRequest.method, 'GET');
      expect(lastRequest.path, '/api/v1/contracts');
      expect(lastRequest.queryParameters['building_id'], 'b-1');

      // peekList returns cached data
      expect(service.peekList({'building_id': 'b-1'}), isNotNull);

      // cached fetch does not re-request
      lastRequest = RequestOptions(path: '/uncalled');
      final cached = await service.list({'building_id': 'b-1'});
      expect(cached, isNotNull);
      expect(lastRequest.path, '/uncalled');
    });

    test('2. getById sends GET /api/v1/contracts/:id and caches with peekById', () async {
      await service.getById('c-1');
      expect(lastRequest.method, 'GET');
      expect(lastRequest.path, '/api/v1/contracts/c-1');
      expect(service.peekById('c-1'), isNotNull);

      // cached fetch
      lastRequest = RequestOptions(path: '/uncalled');
      await service.getById('c-1');
      expect(lastRequest.path, '/uncalled');
    });

    test('3. listRequests sends GET /api/v1/contracts/requests and caches with peekRequests', () async {
      final res = await service.listRequests({'status': 'SUBMITTED'});
      expect(res, isNotNull);
      expect(lastRequest.method, 'GET');
      expect(lastRequest.path, '/api/v1/contracts/requests');
      expect(lastRequest.queryParameters['status'], 'SUBMITTED');
      expect(service.peekRequests({'status': 'SUBMITTED'}), isNotNull);
    });

    test('4. create sends POST /api/v1/contracts with Idempotency-Key', () async {
      final payload = {'apartment_id': 'apt-1', 'rent_amount': 8500000};
      await service.create(payload, idempotencyKey: 'custom-idem-create');
      expect(lastRequest.method, 'POST');
      expect(lastRequest.path, '/api/v1/contracts');
      expect(lastRequest.data, payload);
      expect(lastRequest.headers['Idempotency-Key'], 'custom-idem-create');
    });

    test('5. update sends PATCH /api/v1/contracts/:id', () async {
      final payload = {'rent_amount': 9000000};
      await service.update('c-1', payload);
      expect(lastRequest.method, 'PATCH');
      expect(lastRequest.path, '/api/v1/contracts/c-1');
      expect(lastRequest.data, payload);
    });

    test('6. activate sends POST /api/v1/contracts/:id/activate with Idempotency-Key', () async {
      await service.activate('c-1', {}, idempotencyKey: 'idem-act');
      expect(lastRequest.method, 'POST');
      expect(lastRequest.path, '/api/v1/contracts/c-1/activate');
      expect(lastRequest.headers['Idempotency-Key'], 'idem-act');
    });

    test('7. approve sends POST /api/v1/contracts/:id/approve with Idempotency-Key', () async {
      await service.approve('c-1', {}, idempotencyKey: 'idem-app');
      expect(lastRequest.method, 'POST');
      expect(lastRequest.path, '/api/v1/contracts/c-1/approve');
      expect(lastRequest.headers['Idempotency-Key'], 'idem-app');
    });

    test('8. reject sends POST /api/v1/contracts/:id/reject', () async {
      await service.reject('c-1', {'reason': 'Reject note'});
      expect(lastRequest.method, 'POST');
      expect(lastRequest.path, '/api/v1/contracts/c-1/reject');
      expect(lastRequest.data['reason'], 'Reject note');
    });

    test('9. rejectContract alias converts String to Map and passes Map through', () async {
      // 9a: String reason
      await service.rejectContract('c-1', 'Price too low');
      expect(lastRequest.method, 'POST');
      expect(lastRequest.path, '/api/v1/contracts/c-1/reject');
      expect(lastRequest.data, {'reason': 'Price too low'});

      // 9b: Map reason
      await service.rejectContract('c-1', {'reason': 'Custom reason', 'code': 'ERR_PRICE'});
      expect(lastRequest.method, 'POST');
      expect(lastRequest.path, '/api/v1/contracts/c-1/reject');
      expect(lastRequest.data['reason'], 'Custom reason');
      expect(lastRequest.data['code'], 'ERR_PRICE');
    });

    test('10. cancel sends POST /api/v1/contracts/:id/cancel', () async {
      await service.cancel('c-1', {'reason': 'Cancelled by tenant'});
      expect(lastRequest.method, 'POST');
      expect(lastRequest.path, '/api/v1/contracts/c-1/cancel');
      expect(lastRequest.data['reason'], 'Cancelled by tenant');
    });

    test('11. uploadScan sends POST /api/v1/contracts/:id/scan', () async {
      final payload = {'file_base64': 'data:base64...'};
      await service.uploadScan('c-1', payload);
      expect(lastRequest.method, 'POST');
      expect(lastRequest.path, '/api/v1/contracts/c-1/scan');
      expect(lastRequest.data, payload);
    });

    test('12. terminate sends POST /api/v1/contracts/:id/terminate with Idempotency-Key', () async {
      final payload = {'terminated_date': '2026-12-01', 'reason': 'Early termination'};
      await service.terminate('c-1', payload, idempotencyKey: 'idem-term');
      expect(lastRequest.method, 'POST');
      expect(lastRequest.path, '/api/v1/contracts/c-1/terminate');
      expect(lastRequest.data, payload);
      expect(lastRequest.headers['Idempotency-Key'], 'idem-term');
    });

    test('13. approveTermination sends POST /api/v1/contracts/:id/terminate/approve', () async {
      await service.approveTermination('c-1');
      expect(lastRequest.method, 'POST');
      expect(lastRequest.path, '/api/v1/contracts/c-1/terminate/approve');
    });

    test('14. rejectTermination sends POST /api/v1/contracts/:id/terminate/reject', () async {
      await service.rejectTermination('c-1', {'reason': 'Cannot terminate yet'});
      expect(lastRequest.method, 'POST');
      expect(lastRequest.path, '/api/v1/contracts/c-1/terminate/reject');
      expect(lastRequest.data['reason'], 'Cannot terminate yet');
    });

    test('15. renew sends POST /api/v1/contracts/:id/renew with Idempotency-Key', () async {
      final payload = {'new_end_date': '2027-12-01', 'rent_amount': 9000000};
      await service.renew('c-1', payload, idempotencyKey: 'idem-renew');
      expect(lastRequest.method, 'POST');
      expect(lastRequest.path, '/api/v1/contracts/c-1/renew');
      expect(lastRequest.data, payload);
      expect(lastRequest.headers['Idempotency-Key'], 'idem-renew');
    });

    test('16. transferRoom sends POST /api/v1/contracts/:id/transfer-room with Idempotency-Key', () async {
      final payload = {'new_apartment_id': 'apt-2', 'new_start_date': '2026-12-01'};
      await service.transferRoom('c-1', payload, idempotencyKey: 'idem-transfer');
      expect(lastRequest.method, 'POST');
      expect(lastRequest.path, '/api/v1/contracts/c-1/transfer-room');
      expect(lastRequest.data, payload);
      expect(lastRequest.headers['Idempotency-Key'], 'idem-transfer');
    });

    test('17. listOccupants sends GET /api/v1/contracts/:id/occupants and caches', () async {
      await service.listOccupants('c-1');
      expect(lastRequest.method, 'GET');
      expect(lastRequest.path, '/api/v1/contracts/c-1/occupants');
    });

    test('18. addOccupant sends POST /api/v1/contracts/:id/occupants', () async {
      final payload = {'full_name': 'Nguyen Van B', 'phone': '0901234567', 'relationship': 'spouse'};
      await service.addOccupant('c-1', payload);
      expect(lastRequest.method, 'POST');
      expect(lastRequest.path, '/api/v1/contracts/c-1/occupants');
      expect(lastRequest.data, payload);
    });

    test('19. removeOccupant sends DELETE /api/v1/contracts/:id/occupants/:tenantId', () async {
      await service.removeOccupant('c-1', 't-99');
      expect(lastRequest.method, 'DELETE');
      expect(lastRequest.path, '/api/v1/contracts/c-1/occupants/t-99');
    });

    test('20. listServicePrices sends GET /api/v1/contracts/:id/service-prices and caches', () async {
      await service.listServicePrices('c-1');
      expect(lastRequest.method, 'GET');
      expect(lastRequest.path, '/api/v1/contracts/c-1/service-prices');
    });

    test('21. addServicePrice sends POST /api/v1/contracts/:id/service-prices', () async {
      final payload = {'service_code': 'INTERNET', 'unit_price': 200000};
      await service.addServicePrice('c-1', payload);
      expect(lastRequest.method, 'POST');
      expect(lastRequest.path, '/api/v1/contracts/c-1/service-prices');
      expect(lastRequest.data, payload);
    });

    test('22. removeServicePrice sends DELETE /api/v1/contracts/:id/service-prices/:priceId', () async {
      await service.removeServicePrice('c-1', 'sp-88');
      expect(lastRequest.method, 'DELETE');
      expect(lastRequest.path, '/api/v1/contracts/c-1/service-prices/sp-88');
    });

    test('23. listAmendments sends GET /api/v1/contracts/:id/amendments and caches', () async {
      await service.listAmendments('c-1');
      expect(lastRequest.method, 'GET');
      expect(lastRequest.path, '/api/v1/contracts/c-1/amendments');
    });

    test('24. createAmendment sends POST /api/v1/contracts/:id/amendments', () async {
      final payload = {'changes': {'rent_amount': 9500000}, 'reason': 'Thỏa thuận năm 2'};
      await service.createAmendment('c-1', payload);
      expect(lastRequest.method, 'POST');
      expect(lastRequest.path, '/api/v1/contracts/c-1/amendments');
      expect(lastRequest.data, payload);
    });

    test('25. approveAmendment sends POST /api/v1/contracts/:id/amendments/:versionId/approve', () async {
      await service.approveAmendment('c-1', 'ver-5');
      expect(lastRequest.method, 'POST');
      expect(lastRequest.path, '/api/v1/contracts/c-1/amendments/ver-5/approve');
    });

    test('26. rejectAmendment sends POST /api/v1/contracts/:id/amendments/:versionId/reject', () async {
      final payload = {'reason': 'Khong dong y tang gia'};
      await service.rejectAmendment('c-1', 'ver-5', payload);
      expect(lastRequest.method, 'POST');
      expect(lastRequest.path, '/api/v1/contracts/c-1/amendments/ver-5/reject');
      expect(lastRequest.data, payload);
    });

    test('27. approveRequest sends POST /api/v1/contracts/requests/:id/approve', () async {
      await service.approveRequest('req-1');
      expect(lastRequest.method, 'POST');
      expect(lastRequest.path, '/api/v1/contracts/requests/req-1/approve');
    });

    test('28. rejectRequest sends POST /api/v1/contracts/requests/:id/reject', () async {
      final payload = {'reason': 'Yeu cau khong hop le'};
      await service.rejectRequest('req-1', payload);
      expect(lastRequest.method, 'POST');
      expect(lastRequest.path, '/api/v1/contracts/requests/req-1/reject');
      expect(lastRequest.data, payload);
    });

    test('29. getTemplateHtml sends GET /api/v1/contracts/:id/template with plain text response', () async {
      final html = await service.getTemplateHtml('c-1');
      expect(html, contains('Hợp Đồng Thuê Nhà'));
      expect(lastRequest.method, 'GET');
      expect(lastRequest.path, '/api/v1/contracts/c-1/template');
      expect(lastRequest.responseType, ResponseType.plain);
    });
  });

  group('ContractsPage Widget Tests', () {
    testWidgets('renders contract list, stats cards, and switches to requests tab via initialTab', (tester) async {
      tester.view.physicalSize = const Size(1280, 900);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);

      final dio = Dio(BaseOptions(baseUrl: 'http://localhost:3000'));
      final queryCache = QueryCache();

      final mockContracts = [
        {
          'id': 'c-1001',
          'apartment_code': 'P.101',
          'building_name': 'Tòa Landmark 81',
          'tenant_name': 'Nguyễn Văn An',
          'tenant_phone': '0901234567',
          'start_date': '2026-01-01',
          'end_date': '2026-12-31',
          'rent_amount': 12000000,
          'deposit_amount': 24000000,
          'status': 'ACTIVE',
        },
        {
          'id': 'c-1002',
          'apartment_code': 'P.202',
          'building_name': 'Tòa Landmark 81',
          'tenant_name': 'Trần Thị Bích',
          'tenant_phone': '0912345678',
          'start_date': '2026-02-01',
          'end_date': '2027-01-31',
          'rent_amount': 8500000,
          'deposit_amount': 8500000,
          'status': 'DRAFT',
        },
      ];

      final mockRequests = [
        {
          'id': 'req-501',
          'type': 'RENEWAL',
          'apartment_code': 'P.101',
          'building_name': 'Tòa Landmark 81',
          'resident_name': 'Nguyễn Văn An',
          'resident_phone': '0901234567',
          'desired_date': '2027-12-31',
          'note': 'Muốn gia hạn thêm 1 năm',
          'status': 'SUBMITTED',
        },
      ];

      dio.httpClientAdapter = _MockHttpClientAdapter((options) async {
        if (options.path == '/api/v1/contracts') {
          return ResponseBody.fromString(
            jsonEncode({'success': true, 'data': mockContracts}),
            200,
            headers: {Headers.contentTypeHeader: [Headers.jsonContentType]},
          );
        }
        if (options.path == '/api/v1/contracts/requests') {
          return ResponseBody.fromString(
            jsonEncode({'success': true, 'data': mockRequests}),
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

      final managerUser = UserModel(
        id: 'u-mgr-1',
        fullName: 'Manager Nguyen',
        phone: '0909000001',
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

      // Render ContractsPage with initialTab = 'requests'
      await tester.pumpWidget(
        UncontrolledProviderScope(
          container: container,
          child: const MaterialApp(
            home: Scaffold(
              body: ContractsPage(initialTab: 'requests'),
            ),
          ),
        ),
      );

      await tester.pumpAndSettle();

      // Check header and requests tab content
      expect(find.text('Quản lý Hợp đồng'), findsOneWidget);
      expect(find.text('P.101'), findsOneWidget);
      expect(find.text('Muốn gia hạn thêm 1 năm'), findsOneWidget);
      expect(find.text('Duyệt'), findsOneWidget);
      expect(find.text('Từ chối'), findsOneWidget);
    });
  });

  group('ContractDetailPage Widget Tests - 4-Eyes RBAC Separation', () {
    testWidgets('OWNER role sees 4-eyes approval buttons for PENDING_APPROVAL contract', (tester) async {
      tester.view.physicalSize = const Size(1280, 900);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);

      final dio = Dio(BaseOptions(baseUrl: 'http://localhost:3000'));
      final queryCache = QueryCache();

      final mockContract = {
        'id': 'c-pending-1',
        'apartment_code': 'P.303',
        'building_name': 'Tòa Bitexco',
        'tenant_name': 'Phạm Hoàng Long',
        'tenant_phone': '0988776655',
        'start_date': '2026-03-01',
        'end_date': '2027-02-28',
        'rent_amount': 7000000,
        'apartment_base_rent': 9000000, // Discounted > 10%
        'deposit_amount': 14000000,
        'status': 'PENDING_APPROVAL',
        'created_by': 'u-mgr-proposer',
        'has_building_owner': true,
        'attachments': [
          {
            'id': 'att-scan-1',
            'storage_path': 'scans/contract.pdf',
            'mime': 'application/pdf',
            'created_at': '2026-02-20',
          }
        ],
        'occupants': [],
        'amendments': [],
        'service_prices': [],
        'service_subscriptions': [],
        'invoice_schedule': [],
      };

      dio.httpClientAdapter = _MockHttpClientAdapter((options) async {
        if (options.path == '/api/v1/contracts/c-pending-1') {
          return ResponseBody.fromString(
            jsonEncode({'success': true, 'data': mockContract}),
            200,
            headers: {Headers.contentTypeHeader: [Headers.jsonContentType]},
          );
        }
        if (options.path.endsWith('/template')) {
          return ResponseBody.fromString(
            '<html><body><h1>Bản In Hợp Đồng A4</h1></body></html>',
            200,
            headers: {Headers.contentTypeHeader: ['text/html; charset=utf-8']},
          );
        }
        return ResponseBody.fromString(
          jsonEncode({'success': true, 'data': []}),
          200,
          headers: {Headers.contentTypeHeader: [Headers.jsonContentType]},
        );
      });

      // User is OWNER
      final ownerUser = UserModel(
        id: 'u-owner-99',
        fullName: 'Chủ Tòa Nhà',
        phone: '0911223344',
        roles: const [UserRoleModel(code: 'OWNER', name: 'Chủ sở hữu')],
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
              body: ContractDetailPage(contractId: 'c-pending-1'),
            ),
          ),
        ),
      );

      await tester.pumpAndSettle();

      // Owner sees approval and rejection buttons
      expect(find.text('Phê duyệt HĐ giá ưu đãi'), findsOneWidget);
      expect(find.text('Từ chối (trả về nháp)'), findsOneWidget);
      expect(find.text('Xem & In hợp đồng A4'), findsOneWidget);
    });

    testWidgets('SYS_ADMIN falls back to approve when buildingHasActiveOwner == false', (tester) async {
      tester.view.physicalSize = const Size(1280, 900);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);

      final dio = Dio(BaseOptions(baseUrl: 'http://localhost:3000'));
      final queryCache = QueryCache();

      final mockContract = {
        'id': 'c-pending-no-owner',
        'apartment_code': 'P.404',
        'building_name': 'Tòa Chưa Có Chủ',
        'tenant_name': 'Đặng Quốc Huy',
        'tenant_phone': '0977889900',
        'start_date': '2026-03-01',
        'end_date': '2027-02-28',
        'rent_amount': 6500000,
        'apartment_base_rent': 8000000,
        'deposit_amount': 13000000,
        'status': 'PENDING_APPROVAL',
        'created_by': 'u-mgr-proposer',
        'has_building_owner': false, // No active owner!
        'attachments': [],
        'occupants': [],
        'amendments': [],
        'service_prices': [],
        'service_subscriptions': [],
        'invoice_schedule': [],
      };

      dio.httpClientAdapter = _MockHttpClientAdapter((options) async {
        if (options.path == '/api/v1/contracts/c-pending-no-owner') {
          return ResponseBody.fromString(
            jsonEncode({'success': true, 'data': mockContract}),
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

      // User is SYS_ADMIN
      final sysAdminUser = UserModel(
        id: 'u-sysadmin-1',
        fullName: 'Super Admin',
        phone: '0999999999',
        roles: const [UserRoleModel(code: 'SYS_ADMIN', name: 'Quản trị hệ thống')],
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
            user: sysAdminUser,
          );

      await tester.pumpWidget(
        UncontrolledProviderScope(
          container: container,
          child: const MaterialApp(
            home: Scaffold(
              body: ContractDetailPage(contractId: 'c-pending-no-owner'),
            ),
          ),
        ),
      );

      await tester.pumpAndSettle();

      // SYS_ADMIN can approve because has_building_owner is false
      expect(find.text('Phê duyệt HĐ giá ưu đãi'), findsOneWidget);
      expect(find.text('Từ chối (trả về nháp)'), findsOneWidget);
    });
  });
}
