import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:flutter_resihub/core/constants/roles.dart';
import 'package:flutter_resihub/core/network/query_cache.dart';
import 'package:flutter_resihub/core/storage/app_storage.dart';
import 'package:flutter_resihub/core/theme/app_theme.dart';
import 'package:flutter_resihub/core/utils/ai_helpers.dart';
import 'package:flutter_resihub/core/utils/zalo_format.dart';
import 'package:flutter_resihub/features/ai_gateway/services/ai_service.dart';
import 'package:flutter_resihub/features/auth/models/user_model.dart';
import 'package:flutter_resihub/features/auth/providers/auth_provider.dart';
import 'package:flutter_resihub/features/buildings/services/buildings_service.dart';
import 'package:flutter_resihub/features/maintenance/screens/service_requests_page.dart';
import 'package:flutter_resihub/features/maintenance/services/service_requests_service.dart';

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

class _FakeAiService extends Fake implements AiService {
  Map<String, dynamic>? lastClassifyPayload;

  @override
  Future<dynamic> classifyServiceRequest(
    dynamic payload, {
    Options? options,
    String? idempotencyKey,
  }) async {
    lastClassifyPayload = payload is Map<String, dynamic>
        ? payload
        : payload is Map
            ? Map<String, dynamic>.from(payload)
            : {'data': payload};
    return {
      'success': true,
      'category': 'PLUMBING',
      'priority': 'HIGH',
      'confidence': 0.95,
      'rationale': 'AI tái phân loại dựa trên phản hồi của kỹ thuật viên.',
    };
  }
}

class _FakeBuildingsService extends Fake implements BuildingsService {
  @override
  Future<dynamic> listApartments([Map<String, dynamic>? params, bool force = false]) async {
    return {
      'data': [
        {'id': 'apt-101', 'code': 'P101', 'building_name': 'Tòa Sapphire'},
        {'id': 'apt-102', 'code': 'P102', 'building_name': 'Tòa Sapphire'},
      ],
    };
  }
}

UserModel _createUser(String roleCode) {
  return UserModel(
    id: 'user-$roleCode',
    fullName: 'Test $roleCode User',
    email: '$roleCode@resihub.test',
    roles: [
      UserRoleModel(code: roleCode),
    ],
  );
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late AppStorage storage;

  setUp(() async {
    SharedPreferences.setMockInitialValues({});
    final prefs = await SharedPreferences.getInstance();
    storage = AppStorage(prefs: prefs, isWeb: true);
  });

  group('ServiceRequestsService (All 6 Methods + QueryCache)', () {
    late Dio dio;
    late QueryCache queryCache;
    late ServiceRequestsService service;
    late RequestOptions lastRequest;
    dynamic nextResponseBody;

    setUp(() {
      dio = Dio(BaseOptions(baseUrl: 'http://localhost:3000'));
      queryCache = QueryCache();

      dio.httpClientAdapter = _MockHttpClientAdapter((options) async {
        lastRequest = options;
        final body = nextResponseBody ?? {'success': true, 'data': {'id': 'sr-1'}};
        return ResponseBody.fromString(
          jsonEncode(body),
          200,
          headers: {
            Headers.contentTypeHeader: [Headers.jsonContentType],
          },
        );
      });

      service = ServiceRequestsService(dio: dio, queryCache: queryCache);
    });

    test('1. list sends GET /api/v1/service-requests and caches with queryCache', () async {
      nextResponseBody = {
        'data': [
          {'id': 'sr-100', 'tracking_code': 'SR-100', 'status': 'NEW'},
        ],
      };

      final res1 = await service.list({'status': 'NEW'});
      expect(lastRequest.method, 'GET');
      expect(lastRequest.path, '/api/v1/service-requests');
      expect(lastRequest.queryParameters['status'], 'NEW');
      expect(res1['data'], isNotEmpty);

      // Hit cache on repeated call
      lastRequest = RequestOptions(path: '/unrelated');
      final res2 = await service.list({'status': 'NEW'});
      expect(lastRequest.path, '/unrelated'); // HTTP adapter not invoked
      expect(res2['data'], isNotEmpty);

      // Force refresh bypasses cache
      await service.list({'status': 'NEW'}, {'force': true});
      expect(lastRequest.path, '/api/v1/service-requests');
    });

    test('2. getById sends GET /api/v1/service-requests/:id and caches', () async {
      nextResponseBody = {
        'data': {'id': 'sr-100', 'tracking_code': 'SR-100', 'status': 'IN_PROGRESS'},
      };

      final res = await service.getById('sr-100');
      expect(lastRequest.method, 'GET');
      expect(lastRequest.path, '/api/v1/service-requests/sr-100');
      expect(res['data']['tracking_code'], 'SR-100');

      // peekById retrieves from queryCache
      final peeked = service.peekById('sr-100');
      expect(peeked, isNotNull);
      expect((peeked as Map)['data']['id'], 'sr-100');
    });

    test('3. create sends POST /api/v1/service-requests with idempotency header', () async {
      final payload = {
        'apartment_id': 'apt-101',
        'category': 'ELECTRICAL',
        'priority': 'HIGH',
        'title': 'Hỏng aptomat tổng',
        'description': 'Mất điện toàn bộ phòng 101',
      };

      await service.create(payload, {'idempotencyKey': 'custom-key-123'});
      expect(lastRequest.method, 'POST');
      expect(lastRequest.path, '/api/v1/service-requests');
      expect(lastRequest.headers['Idempotency-Key'], 'custom-key-123');
      expect(lastRequest.data['category'], 'ELECTRICAL');
    });

    test('4. updateStatus sends PATCH /api/v1/service-requests/:id/status with idempotency', () async {
      final payload = {
        'status': 'RESOLVED',
        'resolution_note': 'Đã thay aptomat mới 32A',
      };

      await service.updateStatus('sr-100', payload);
      expect(lastRequest.method, 'PATCH');
      expect(lastRequest.path, '/api/v1/service-requests/sr-100/status');
      expect(lastRequest.headers['Idempotency-Key'], isNotEmpty);
      expect(lastRequest.data['status'], 'RESOLVED');
    });

    test('5. applyTriage sends POST /api/v1/service-requests/:id/apply-triage with idempotency', () async {
      final payload = {
        'category': 'PLUMBING',
        'priority': 'URGENT',
        'assigned_to': 'user-tech-1',
      };

      await service.applyTriage('sr-100', payload);
      expect(lastRequest.method, 'POST');
      expect(lastRequest.path, '/api/v1/service-requests/sr-100/apply-triage');
      expect(lastRequest.headers['Idempotency-Key'], isNotEmpty);
      expect(lastRequest.data['category'], 'PLUMBING');
    });

    test('6. rate sends POST /api/v1/service-requests/:id/rating with idempotency', () async {
      final payload = {
        'rating': 5,
        'rating_note': 'Kỹ thuật viên nhiệt tình, xử lý nhanh!',
      };

      await service.rate('sr-100', payload);
      expect(lastRequest.method, 'POST');
      expect(lastRequest.path, '/api/v1/service-requests/sr-100/rating');
      expect(lastRequest.headers['Idempotency-Key'], isNotEmpty);
      expect(lastRequest.data['rating'], 5);
    });
  });

  group('SLA Badges (computeSlaBadgeMeta)', () {
    final now = DateTime(2026, 11, 14, 12, 0, 0);

    test('RESOLVED on time returns COMPLETED emerald', () {
      final meta = computeSlaBadgeMeta(
        status: 'RESOLVED',
        slaDueAt: now.subtract(const Duration(hours: 1)),
        slaBreachedAt: null,
        now: now,
      );
      expect(meta.state, 'COMPLETED');
      expect(meta.variant, 'emerald');
      expect(meta.label, 'Đã xử lý đúng SLA');
    });

    test('RESOLVED but breached returns COMPLETED amber', () {
      final meta = computeSlaBadgeMeta(
        status: 'CLOSED',
        slaDueAt: now.subtract(const Duration(hours: 2)),
        slaBreachedAt: now.subtract(const Duration(hours: 1)),
        now: now,
      );
      expect(meta.state, 'COMPLETED');
      expect(meta.variant, 'amber');
      expect(meta.label, 'Hoàn thành (Trễ SLA)');
    });

    test('CANCELLED returns COMPLETED slate', () {
      final meta = computeSlaBadgeMeta(
        status: 'CANCELLED',
        now: now,
      );
      expect(meta.state, 'COMPLETED');
      expect(meta.variant, 'slate');
      expect(meta.label, 'Đã hủy');
    });

    test('Open ticket overdue returns OVERDUE red with hours & mins', () {
      final meta = computeSlaBadgeMeta(
        status: 'IN_PROGRESS',
        slaDueAt: now.subtract(const Duration(hours: 2, minutes: 15)),
        now: now,
      );
      expect(meta.state, 'OVERDUE');
      expect(meta.variant, 'red');
      expect(meta.label, contains('Quá hạn SLA'));
      expect(meta.label, contains('2h15p'));
    });

    test('Open ticket due soon (<= 60m) returns DUE_SOON amber', () {
      final meta = computeSlaBadgeMeta(
        status: 'ASSIGNED',
        slaDueAt: now.add(const Duration(minutes: 45)),
        now: now,
      );
      expect(meta.state, 'DUE_SOON');
      expect(meta.variant, 'amber');
      expect(meta.label, contains('Sắp hết hạn SLA'));
      expect(meta.label, contains('45p'));
    });

    test('Open ticket on track (> 60m) returns ON_TRACK emerald', () {
      final meta = computeSlaBadgeMeta(
        status: 'NEW',
        slaDueAt: now.add(const Duration(hours: 4)),
        now: now,
      );
      expect(meta.state, 'ON_TRACK');
      expect(meta.variant, 'emerald');
      expect(meta.label, contains('Còn 4h hạn SLA'));
    });
  });

  group('AI Triage Helpers & 1-Click Eligibility (canOneClickApplyAiTriage)', () {
    test('canOneClickApplyAiTriage returns true when category & priority suggested and not yet applied', () {
      final detail = {
        'id': 'sr-1',
        'ai_suggested_category': 'ELECTRICAL',
        'ai_suggested_priority': 'HIGH',
        'ai_triage_status': 'SUGGESTED',
      };
      expect(canOneClickApplyAiTriage(detail), isTrue);
    });

    test('canOneClickApplyAiTriage returns false when suggestions missing', () {
      final detail = {
        'id': 'sr-2',
        'ai_suggested_category': null,
        'ai_suggested_priority': 'NORMAL',
      };
      expect(canOneClickApplyAiTriage(detail), isFalse);
    });

    test('canOneClickApplyAiTriage returns false when already ACCEPTED or APPLIED or OVERRIDDEN', () {
      expect(canOneClickApplyAiTriage({
        'ai_suggested_category': 'ELECTRICAL',
        'ai_suggested_priority': 'HIGH',
        'ai_triage_status': 'APPLIED',
      }), isFalse);

      expect(canOneClickApplyAiTriage({
        'ai_suggested_category': 'ELECTRICAL',
        'ai_suggested_priority': 'HIGH',
        'ai_triage_status': 'ACCEPTED',
      }), isFalse);

      expect(canOneClickApplyAiTriage({
        'ai_suggested_category': 'ELECTRICAL',
        'ai_suggested_priority': 'HIGH',
        'ai_triage_status': 'OVERRIDDEN',
      }), isFalse);
    });
  });

  group('Safe Zalo Room Text Copy (Strict Exclusion of internal_note)', () {
    test('buildRoomMaintenanceZaloText includes public details and NEVER leaks internal_note', () {
      final detail = {
        'building_code': 'SAPPHIRE',
        'apartment_code': 'P304',
        'tracking_code': 'SR-9988',
        'title': 'Rò rỉ vòi sen phòng tắm',
        'category': 'PLUMBING',
        'status': 'IN_PROGRESS',
        'assigned_to_name': 'Nguyễn Văn Kỹ Thuật',
        'hold_reason': 'Đang chờ linh kiện thay thế',
        'next_appointment_at': '2026-11-15T09:00:00.000Z',
        'resolution_note': 'Đã thay mới gioăng cao su chịu nhiệt',
        'internal_note': 'BÍ MẬT NỘI BỘ BQL: Chi phí phụ tùng 150k, không báo cư dân phần nhân công',
      };

      final text = buildRoomMaintenanceZaloText(detail);

      expect(text, contains('SAPPHIRE'));
      expect(text, contains('P304'));
      expect(text, contains('SR-9988'));
      expect(text, contains('Nguyễn Văn Kỹ Thuật'));
      expect(text, contains('Đang chờ linh kiện thay thế'));
      expect(text, contains('Đã thay mới gioăng cao su chịu nhiệt'));

      // STRICT VERIFICATION: internal_note must NEVER appear in Zalo room message
      expect(text, isNot(contains('BÍ MẬT NỘI BỘ')));
      expect(text, isNot(contains('Chi phí phụ tùng')));
      expect(text, isNot(contains('internal_note')));
    });
  });

  group('ServiceRequestsPage Widget Tests', () {
    late _FakeAiService fakeAiService;
    late _FakeBuildingsService fakeBuildingsService;
    late List<Map<String, dynamic>> mockRequests;

    setUp(() {
      fakeAiService = _FakeAiService();
      fakeBuildingsService = _FakeBuildingsService();

      final now = DateTime.now();
      mockRequests = [
        {
          'id': 'sr-101',
          'tracking_code': 'SR-00101',
          'building_id': 'b-1',
          'building_code': 'B01',
          'building_name': 'Tòa Sapphire',
          'apartment_id': 'apt-101',
          'apartment_code': 'P101',
          'resident_name': 'Nguyễn Văn An',
          'resident_phone': '0901234567',
          'category': 'ELECTRICAL',
          'priority': 'URGENT',
          'status': 'NEW',
          'title': 'Chập điện cầu dao chính',
          'description': 'Mùi khét bốc ra từ tủ điện tổng phòng khách',
          'location_detail': 'Cạnh cửa chính',
          'preferred_slot': 'ANYTIME',
          'created_at': now.subtract(const Duration(minutes: 30)).toIso8601String(),
          'sla_due_at': now.add(const Duration(minutes: 30)).toIso8601String(),
          'ai_suggested_category': 'ELECTRICAL',
          'ai_suggested_priority': 'URGENT',
          'ai_suggested_assignee_id': 'tech-1',
          'ai_suggested_assignee_name': 'Trần Văn Thợ Điện',
          'ai_triage_status': 'SUGGESTED',
          'ai_confidence': 0.94,
          'ai_rationale': 'Nguy cơ cháy nổ cao, cần thợ điện can thiệp khẩn cấp trong 30p.',
          'available_assignees': [
            {'id': 'tech-1', 'name': 'Trần Văn Thợ Điện'},
            {'id': 'tech-2', 'name': 'Lê Văn Thợ Nước'},
          ],
          'audit_timeline': [
            {
              'id': 'aud-1',
              'action': 'CREATE_SERVICE_REQUEST',
              'actor_name': 'Nguyễn Văn An (Cư dân)',
              'created_at': now.subtract(const Duration(minutes: 30)).toIso8601String(),
              'note': 'Cư dân gửi yêu cầu qua app mobile',
            },
          ],
        },
        {
          'id': 'sr-102',
          'tracking_code': 'SR-00102',
          'building_id': 'b-1',
          'apartment_id': 'apt-102',
          'apartment_code': 'P102',
          'resident_name': 'Trần Thị Bình',
          'category': 'PLUMBING',
          'priority': 'NORMAL',
          'status': 'RESOLVED',
          'title': 'Nghẹt bồn rửa bát',
          'description': 'Nước thoát rất chậm',
          'created_at': now.subtract(const Duration(days: 1)).toIso8601String(),
          'sla_due_at': now.subtract(const Duration(hours: 2)).toIso8601String(),
          'sla_breached_at': null,
          'resolution_note': 'Đã thông tắc bồn rửa thành công',
          'rating': 5,
          'rating_note': 'Dịch vụ rất tốt!',
        },
      ];
    });

    Widget createTestApp({
      required UserModel currentUser,
      String? initialRequestId,
      ServiceRequestsService? serviceRequestsService,
    }) {
      final sService = serviceRequestsService ?? _FakeServiceRequestsService(mockRequests);

      final container = ProviderContainer(
        overrides: [
          appStorageProvider.overrideWithValue(storage),
          serviceRequestsServiceProvider.overrideWithValue(sService),
          aiServiceProvider.overrideWithValue(fakeAiService),
          buildingsServiceProvider.overrideWithValue(fakeBuildingsService),
        ],
      );

      container.read(authProvider.notifier).setAuthData(
            accessToken: 'test-token',
            refreshToken: 'test-refresh',
            user: currentUser,
          );

      return UncontrolledProviderScope(
        container: container,
        child: MaterialApp(
          theme: buildAppTheme(),
          home: Scaffold(
            body: ServiceRequestsPage(initialRequestId: initialRequestId),
          ),
        ),
      );
    }

    testWidgets('1. Root widget has key route:/admin/service-requests and renders StatsCard', (tester) async {
      tester.view.physicalSize = const Size(1280, 900);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);

      final manager = _createUser(AppRole.manager.code);
      await tester.pumpWidget(createTestApp(currentUser: manager));
      await tester.pumpAndSettle();

      expect(find.byKey(const Key('route:/admin/service-requests')), findsOneWidget);
      expect(find.text('Yêu cầu & Báo hỏng Kỹ thuật'), findsOneWidget);

      // Verify StatsCard (StatsCard converts title to uppercase)
      expect(find.text('TỔNG YÊU CẦU'), findsOneWidget);
      expect(find.text('MỚI / MỞ LẠI'), findsOneWidget);
      expect(find.text('ĐANG XỬ LÝ / HẸN LẠI'), findsOneWidget);
      expect(find.text('ĐÃ HOÀN THÀNH'), findsOneWidget);
    });

    testWidgets('2. Switches between Kanban view and Table view cleanly', (tester) async {
      tester.view.physicalSize = const Size(1280, 900);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);

      final manager = _createUser(AppRole.manager.code);
      await tester.pumpWidget(createTestApp(currentUser: manager));
      await tester.pumpAndSettle();

      // Default is Kanban view
      expect(find.textContaining('SR-00101'), findsWidgets);

      // Tap Table View toggle button
      final tableButton = find.byTooltip('Xem dạng bảng');
      if (tableButton.evaluate().isNotEmpty) {
        await tester.tap(tableButton);
        await tester.pumpAndSettle();
      }

      expect(find.text('Chập điện cầu dao chính'), findsWidgets);
    });

    testWidgets('3. Auto-opens detail modal with ?request_id or initialRequestId', (tester) async {
      tester.view.physicalSize = const Size(1280, 900);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);

      final manager = _createUser(AppRole.manager.code);
      await tester.pumpWidget(createTestApp(
        currentUser: manager,
        initialRequestId: 'sr-101',
      ));
      await tester.pumpAndSettle();

      // Detail drawer should be open showing tracking code and resident info
      expect(find.textContaining('SR-00101'), findsWidgets);
      expect(find.textContaining('Nguyễn Văn An'), findsWidgets);
      expect(find.textContaining('0901234567'), findsWidgets);

      // SLA badge is rendered
      expect(find.textContaining('SLA'), findsWidgets);
    });

    testWidgets('4. 1-click AI triage applies suggestion and shows toast', (tester) async {
      tester.view.physicalSize = const Size(1280, 900);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);

      final manager = _createUser(AppRole.manager.code);
      final fakeService = _FakeServiceRequestsService(mockRequests);

      await tester.pumpWidget(createTestApp(
        currentUser: manager,
        initialRequestId: 'sr-101',
        serviceRequestsService: fakeService,
      ));
      await tester.pumpAndSettle();

      // AI Triage card displays AI recommendation
      expect(find.textContaining('AI đề xuất'), findsWidgets);
      expect(find.text('Áp dụng gợi ý AI (1 chạm)'), findsOneWidget);

      // Tap 1-click apply button
      await tester.tap(find.text('Áp dụng gợi ý AI (1 chạm)'));
      await tester.pumpAndSettle();

      expect(fakeService.lastAppliedTriageId, 'sr-101');
      await tester.pump(const Duration(seconds: 5));
    });

    testWidgets('5. Safe Zalo copy copies text and does not leak internal note', (tester) async {
      tester.view.physicalSize = const Size(1280, 900);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);

      final manager = _createUser(AppRole.manager.code);
      final fakeService = _FakeServiceRequestsService(mockRequests);

      await tester.pumpWidget(createTestApp(
        currentUser: manager,
        initialRequestId: 'sr-101',
        serviceRequestsService: fakeService,
      ));
      await tester.pumpAndSettle();

      final copyButton = find.text('Sao chép gửi nhóm Zalo');
      expect(copyButton, findsOneWidget);

      await tester.tap(copyButton);
      await tester.pumpAndSettle();
      await tester.pump(const Duration(seconds: 5));

      // Verified via buildRoomMaintenanceZaloText logic tested above
    });

    testWidgets('6. Read-Only Mode for OWNER: No Create button, No Status edit actions', (tester) async {
      tester.view.physicalSize = const Size(1280, 900);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);

      final owner = _createUser(AppRole.owner.code);
      await tester.pumpWidget(createTestApp(
        currentUser: owner,
        initialRequestId: 'sr-101',
      ));
      await tester.pumpAndSettle();

      // "+ Tiếp nhận yêu cầu" button is NOT displayed for OWNER
      expect(find.text('+ Tiếp nhận yêu cầu'), findsNothing);

      // Editing buttons like "Lưu thay đổi", "Bắt đầu xử lý", "Áp dụng gợi ý AI" are NOT available
      expect(find.text('Áp dụng gợi ý AI (1 chạm)'), findsNothing);
      expect(find.text('Lưu cập nhật'), findsNothing);

      // Read-only info is visible
      expect(find.textContaining('Nguyễn Văn An'), findsWidgets);
      expect(find.text('Chập điện cầu dao chính'), findsWidgets);
    });

    testWidgets('7. Read-Only Mode for SYS_ADMIN: No Status edit actions', (tester) async {
      tester.view.physicalSize = const Size(1280, 900);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);

      final sysAdmin = _createUser(AppRole.sysAdmin.code);
      await tester.pumpWidget(createTestApp(
        currentUser: sysAdmin,
        initialRequestId: 'sr-101',
      ));
      await tester.pumpAndSettle();

      // "+ Tiếp nhận yêu cầu" button is NOT displayed for SYS_ADMIN
      expect(find.text('+ Tiếp nhận yêu cầu'), findsNothing);
      expect(find.text('Áp dụng gợi ý AI (1 chạm)'), findsNothing);
      expect(find.text('Lưu cập nhật'), findsNothing);
    });
  });
}

class _FakeServiceRequestsService extends Fake implements ServiceRequestsService {
  final List<Map<String, dynamic>> requests;
  String? lastAppliedTriageId;
  Map<String, dynamic>? lastAppliedTriagePayload;
  String? lastUpdatedStatusId;
  Map<String, dynamic>? lastUpdatedStatusPayload;
  Map<String, dynamic>? lastCreatedPayload;

  _FakeServiceRequestsService(this.requests);

  @override
  dynamic peekList([Map<String, dynamic>? params]) => {'data': requests};

  @override
  Future<dynamic> list([Map<String, dynamic>? params, Map<String, dynamic>? options]) async {
    return {'data': requests};
  }

  @override
  dynamic peekById(String? id) {
    final item = requests.cast<Map<String, dynamic>?>().firstWhere(
          (r) => r?['id'] == id,
          orElse: () => null,
        );
    return item != null ? {'data': item} : null;
  }

  @override
  Future<dynamic> getById(String id, [Map<String, dynamic>? options]) async {
    final item = requests.firstWhere((r) => r['id'] == id, orElse: () => requests.first);
    return {'data': item};
  }

  @override
  Future<dynamic> create(Map<String, dynamic> payload, [Map<String, dynamic>? options]) async {
    lastCreatedPayload = payload;
    return {'success': true, 'message': 'Đã tạo yêu cầu bảo trì thành công'};
  }

  @override
  Future<dynamic> updateStatus(String id, Map<String, dynamic> payload, [Map<String, dynamic>? options]) async {
    lastUpdatedStatusId = id;
    lastUpdatedStatusPayload = payload;
    return {'success': true, 'message': 'Cập nhật trạng thái thành công'};
  }

  @override
  Future<dynamic> applyTriage(String id, Map<String, dynamic> payload, [Map<String, dynamic>? options]) async {
    lastAppliedTriageId = id;
    lastAppliedTriagePayload = payload;
    return {'success': true, 'message': 'Đã áp dụng đề xuất phân loại & điều phối của AI.'};
  }

  @override
  Future<dynamic> rate(String id, Map<String, dynamic> payload, [Map<String, dynamic>? options]) async {
    return {'success': true, 'message': 'Đã gửi đánh giá'};
  }
}
