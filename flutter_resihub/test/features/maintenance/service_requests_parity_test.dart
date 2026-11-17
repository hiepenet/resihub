import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:flutter_resihub/core/constants/roles.dart';
import 'package:flutter_resihub/core/storage/app_storage.dart';
import 'package:flutter_resihub/core/theme/app_theme.dart';
import 'package:flutter_resihub/features/ai_gateway/services/ai_service.dart';
import 'package:flutter_resihub/features/auth/models/user_model.dart';
import 'package:flutter_resihub/features/auth/providers/auth_provider.dart';
import 'package:flutter_resihub/features/buildings/services/buildings_service.dart';
import 'package:flutter_resihub/features/maintenance/screens/service_requests_page.dart';
import 'package:flutter_resihub/features/maintenance/services/service_requests_service.dart';
import 'package:flutter_resihub/shared/widgets/ui/auth_media_viewer.dart';
import 'package:flutter_resihub/shared/widgets/ui/file_upload_field.dart';

Finder createField(String key) => find.descendant(
      of: find.byKey(Key(key)),
      matching: find.byType(EditableText),
    );

const String kTinyPng =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l6sAAAAASUVORK5CYII=';

class _FakeBuildingsService extends Fake implements BuildingsService {
  @override
  Future<dynamic> listApartments(
      [Map<String, dynamic>? params, bool force = false]) async {
    return {
      'data': [
        {'id': 'apt-101', 'code': 'P101', 'building_name': 'Tòa Sapphire'},
      ],
    };
  }
}

class _FakeAiService extends Fake implements AiService {
  @override
  Future<dynamic> classifyServiceRequest(
    dynamic payload, {
    Options? options,
    String? idempotencyKey,
  }) async {
    return {'success': true};
  }
}

class _FakeServiceRequestsService extends Fake
    implements ServiceRequestsService {
  final List<Map<String, dynamic>> requests;
  bool duplicateOnCreate = false;
  Map<String, dynamic>? lastListParams;
  Map<String, dynamic>? lastCreatedPayload;

  _FakeServiceRequestsService(this.requests);

  @override
  dynamic peekList([Map<String, dynamic>? params]) => {'data': requests};

  @override
  Future<dynamic> list(
      [Map<String, dynamic>? params, Map<String, dynamic>? options]) async {
    lastListParams = params;
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
    final item =
        requests.firstWhere((r) => r['id'] == id, orElse: () => requests.first);
    return {'data': item};
  }

  @override
  Future<dynamic> create(Map<String, dynamic> payload,
      [Map<String, dynamic>? options]) async {
    lastCreatedPayload = payload;
    if (duplicateOnCreate) {
      throw DioException(
        requestOptions: RequestOptions(path: '/api/v1/service-requests'),
        response: Response(
          requestOptions: RequestOptions(path: '/api/v1/service-requests'),
          statusCode: 409,
          data: {
            'code': 'DUPLICATE_SERVICE_REQUEST',
            'message': 'Căn hộ đang có yêu cầu cùng hạng mục trong 24 giờ qua.',
            'existing_request': {'id': 'sr-101', 'tracking_code': 'SR-00101'},
          },
        ),
      );
    }
    return {'success': true, 'message': 'Đã tạo yêu cầu bảo trì mới.'};
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late AppStorage storage;

  setUp(() async {
    SharedPreferences.setMockInitialValues({});
    final prefs = await SharedPreferences.getInstance();
    storage = AppStorage(prefs: prefs, isWeb: true);
  });

  UserModel managerUser() => UserModel(
        id: 'user-manager',
        fullName: 'Manager Test',
        email: 'manager@resihub.test',
        roles: [UserRoleModel(code: AppRole.manager.code)],
      );

  List<Map<String, dynamic>> mockRequests() => [
        {
          'id': 'sr-101',
          'tracking_code': 'SR-00101',
          'apartment_code': 'P101',
          'building_code': 'B01',
          'building_name': 'Tòa Sapphire',
          'assigned_to_name': 'Trần Văn Thợ',
          'category': 'ELECTRICAL',
          'priority': 'URGENT',
          'status': 'NEW',
          'title': 'Chập điện cầu dao chính',
          'description': 'Mùi khét bốc ra từ tủ điện tổng.',
          'location_detail': 'Cạnh cửa chính',
          'preferred_slot': 'ANYTIME',
          'requester_name': 'Nguyễn Văn An',
          'requester_phone': '0901234567',
          'created_at': DateTime(2026, 11, 17, 9).toIso8601String(),
          'sla_due_at': DateTime(2026, 11, 17, 12).toIso8601String(),
          'first_responded_at': DateTime(2026, 11, 17, 9, 30).toIso8601String(),
          'reopen_reason': 'Cư dân yêu cầu kiểm tra lại cầu dao.',
          'cancelled_reason': 'Cư dân hủy do đã tự xử lý.',
          'images': [kTinyPng],
          'rating': 4,
          'apartment_zalo_group': {
            'name': 'Nhóm P101',
            'invite_link': 'https://zalo.me/123456789',
          },
          'audit_timeline': [
            {
              'id': 'aud-1',
              'action': 'CREATE_SERVICE_REQUEST',
              'actor_name': 'Nguyễn Văn An',
              'created_at': DateTime(2026, 11, 17, 9).toIso8601String(),
              'before': {'status': null},
              'after': {'status': 'NEW'},
            },
          ],
          'ai_triage_status': 'NONE',
        },
        {
          'id': 'sr-102',
          'tracking_code': 'SR-00102',
          'apartment_code': 'P102',
          'category': 'PLUMBING',
          'priority': 'NORMAL',
          'status': 'RESOLVED',
          'title': 'Nghẹt bồn rửa bát',
          'description': 'Nước thoát chậm.',
          'rating': 5,
          'created_at': DateTime(2026, 11, 16, 9).toIso8601String(),
        },
      ];

  Widget createTestApp({
    required ServiceRequestsService service,
    String? initialRequestId,
  }) {
    final container = ProviderContainer(
      overrides: [
        appStorageProvider.overrideWithValue(storage),
        serviceRequestsServiceProvider.overrideWithValue(service),
        aiServiceProvider.overrideWithValue(_FakeAiService()),
        buildingsServiceProvider.overrideWithValue(_FakeBuildingsService()),
      ],
    );
    container.read(authProvider.notifier).setAuthData(
          accessToken: 'test-token',
          refreshToken: 'test-refresh',
          user: managerUser(),
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

  Future<void> pumpPage(
      WidgetTester tester, _FakeServiceRequestsService service) async {
    tester.view.physicalSize = const Size(1280, 900);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    await tester.pumpWidget(createTestApp(service: service));
    await tester.pumpAndSettle();
  }

  Future<void> pumpDetail(
    WidgetTester tester,
    _FakeServiceRequestsService service,
    String id,
  ) async {
    tester.view.physicalSize = const Size(1280, 900);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    await tester.pumpWidget(createTestApp(service: service, initialRequestId: id));
    await tester.pumpAndSettle();
  }

  testWidgets('parity: 4 KPIs, header strings and labelled view toggle',
      (tester) async {
    final service = _FakeServiceRequestsService(mockRequests());
    await pumpPage(tester, service);

    // StatsCard uppercases its title.
    expect(find.text('TỔNG YÊU CẦU'), findsOneWidget);
    expect(find.text('MỚI / MỞ LẠI'), findsOneWidget);
    expect(find.text('ĐANG XỬ LÝ / HẸN LẠI'), findsOneWidget);
    expect(find.text('ĐÃ HOÀN THÀNH'), findsOneWidget);

    expect(find.text('Yêu cầu & Báo hỏng Kỹ thuật'), findsOneWidget);
    expect(
      find.text(
        'Tiếp nhận, điều phối nhân sự bảo trì, kiểm soát cam kết SLA và đồng bộ tin nhắn nhóm Zalo phòng.',
      ),
      findsOneWidget,
    );
    expect(find.text('Bảng Kanban'), findsOneWidget);
    expect(find.text('Chế độ Bảng'), findsOneWidget);
    expect(find.text('Làm mới'), findsOneWidget);
    expect(find.text('Tạo yêu cầu hộ cư dân'), findsOneWidget);
  });

  testWidgets('parity: table has "Phụ trách" and "Đánh giá" columns',
      (tester) async {
    final service = _FakeServiceRequestsService(mockRequests());
    await pumpPage(tester, service);

    await tester.tap(find.text('Chế độ Bảng'));
    await tester.pumpAndSettle();

    expect(find.text('Phụ trách'), findsOneWidget);
    expect(find.text('Đánh giá'), findsOneWidget);
    expect(find.text('Trần Văn Thợ'), findsWidgets);
  });

  testWidgets('parity: create form shows 3-image upload and sends images[]',
      (tester) async {
    final service = _FakeServiceRequestsService(mockRequests());
    await pumpPage(tester, service);

    await tester.tap(find.text('Tạo yêu cầu hộ cư dân'));
    await tester.pumpAndSettle();

    expect(find.text('Ảnh hiện trạng đính kèm (tối đa 3 ảnh)'), findsOneWidget);
    expect(find.byType(FileUploadField), findsOneWidget);

    await tester.tap(find.text('Chọn căn hộ'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Phòng P101 — Tòa Sapphire'));
    await tester.pumpAndSettle();

    await tester.enterText(createField('sr-create-title'), 'Sự cố test parity');
    await tester.enterText(
        createField('sr-create-description'), 'Mô tả test parity');
    await tester.pumpAndSettle();

    await tester.ensureVisible(find.text('Tạo yêu cầu bảo trì'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Tạo yêu cầu bảo trì'));
    await tester.pumpAndSettle();

    expect(service.lastCreatedPayload, isNotNull);
    expect(service.lastCreatedPayload!['images'], isA<List>());
    // Toast tự ẩn sau 4 giây — đảm bảo không còn timer treo.
    await tester.pump(const Duration(seconds: 5));
  });

  testWidgets(
      'parity: detail drawer SLA/response fields, reasons, audit labels and Zalo room panel',
      (tester) async {
    final service = _FakeServiceRequestsService(mockRequests());
    tester.view.physicalSize = const Size(1280, 900);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    await tester.pumpWidget(
        createTestApp(service: service, initialRequestId: 'sr-101'));
    await tester.pumpAndSettle();

    // SLA / phản hồi đầu tiên / thời điểm tiếp nhận
    expect(find.text('Hạn hoàn thành SLA'), findsOneWidget);
    expect(find.text('Phản hồi đầu tiên'), findsOneWidget);
    expect(find.text('Thời điểm tiếp nhận'), findsOneWidget);

    // Lý do mở lại / hủy
    expect(find.textContaining('Lý do cư dân mở lại yêu cầu:'), findsOneWidget);
    expect(find.textContaining('Lý do hủy phiếu:'), findsOneWidget);

    // Audit label map
    expect(find.text('Tạo yêu cầu báo hỏng'), findsOneWidget);
    expect(find.textContaining('Thực hiện bởi:'), findsWidgets);

    // Zalo room link + preview
    expect(find.text('Mở nhóm Zalo phòng'), findsOneWidget);
    expect(find.textContaining('Nhóm liên kết:'), findsOneWidget);
    expect(
      find.byWidgetPredicate(
        (w) =>
            w is RichText &&
            w.text.toPlainText().contains('CẬP NHẬT SỬA CHỮA PHÒNG'),
      ),
      findsWidgets,
    );
  });

  testWidgets(
      'parity: tapping attachment image opens "Xem ảnh đính kèm" lightbox',
      (tester) async {
    final service = _FakeServiceRequestsService(mockRequests());
    tester.view.physicalSize = const Size(1280, 900);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    await tester.pumpWidget(
        createTestApp(service: service, initialRequestId: 'sr-101'));
    await tester.pumpAndSettle();

    expect(find.text('Ảnh hiện trạng (1)'), findsOneWidget);
    await tester.ensureVisible(find.byType(AuthImage).first);
    await tester.pumpAndSettle();
    await tester.tap(find.byType(AuthImage).first);
    await tester.pumpAndSettle();

    expect(find.text('Xem ảnh đính kèm'), findsOneWidget);
  });

  testWidgets(
      'parity: duplicate modal has "Mở phiếu #" and sends ignore_duplicate_warning',
      (tester) async {
    final service = _FakeServiceRequestsService(mockRequests())
      ..duplicateOnCreate = true;
    await pumpPage(tester, service);

    await tester.tap(find.text('Tạo yêu cầu hộ cư dân'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Chọn căn hộ'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Phòng P101 — Tòa Sapphire'));
    await tester.pumpAndSettle();

    await tester.enterText(createField('sr-create-title'), 'Sự cố trùng lặp');
    await tester.enterText(
        createField('sr-create-description'), 'Mô tả trùng lặp');
    await tester.pumpAndSettle();

    await tester.ensureVisible(find.text('Tạo yêu cầu bảo trì'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Tạo yêu cầu bảo trì'));
    await tester.pumpAndSettle();

    expect(find.text('Mở phiếu #SR-00101'), findsOneWidget);

    await tester.tap(find.text('Vẫn tạo phiếu mới'));
    await tester.pumpAndSettle();

    expect(service.lastCreatedPayload, isNotNull);
    expect(service.lastCreatedPayload!['ignore_duplicate_warning'], isTrue);
    expect(service.lastCreatedPayload!.containsKey('force_duplicate'), isFalse);
    expect(service.lastCreatedPayload!['images'], isA<List>());
    await tester.pump(const Duration(seconds: 5));
  });

  testWidgets('parity: search debounces and "Xóa bộ lọc" resets filters',
      (tester) async {
    final service = _FakeServiceRequestsService(mockRequests());
    await pumpPage(tester, service);

    final searchField = find.byType(TextField).first;
    await tester.enterText(searchField, 'SR-001');
    // SearchBarWidget debounces 200ms before calling onChanged.
    await tester.pump(const Duration(milliseconds: 250));
    await tester.pumpAndSettle();

    expect(service.lastListParams?['search'], 'SR-001');
    expect(find.text('Xóa bộ lọc'), findsOneWidget);

    await tester.tap(find.text('Xóa bộ lọc'));
    await tester.pumpAndSettle();

    expect(service.lastListParams?.containsKey('search'), isFalse);
    expect(find.text('Xóa bộ lọc'), findsNothing);
  });

  test('parity: next_appointment_at converts local input <-> ISO (React)', () {
    // Display (React toLocalDateTimeInputValue): ISO -> local YYYY-MM-DDTHH:mm
    // and back via parse+toUtc must round-trip exactly, regardless of host TZ.
    const iso = '2026-11-17T02:30:00.000Z';
    final local = toLocalDateTimeInputValue(iso);
    expect(local, matches(RegExp(r'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$')));
    expect(DateTime.parse(local).toUtc().toIso8601String(), iso);
    expect(toLocalDateTimeInputValue(null), '');
    expect(toLocalDateTimeInputValue(''), '');
    expect(toLocalDateTimeInputValue('garbage'), '');

    // Send (React new Date(v).toISOString()): local input -> UTC ISO.
    // Explicit offset keeps the assertion host-TZ independent.
    expect(toIsoFromLocalInput('2026-11-17T09:30:00+07:00'),
        '2026-11-17T02:30:00.000Z');
    expect(toIsoFromLocalInput('  '), isNull);
    expect(toIsoFromLocalInput('garbage'), isNull);
  });

  testWidgets('parity: edit section has resolution upload and priority select',
      (tester) async {
    final service = _FakeServiceRequestsService(mockRequests());
    await pumpDetail(tester, service, 'sr-101');

    expect(find.text('Mức độ ưu tiên'), findsOneWidget);
    expect(
      find.text('Ảnh nghiệm thu sau sửa chữa (tối đa 3 ảnh)'),
      findsOneWidget,
    );
    // Create-form upload is not shown on detail; only resolution upload exists.
    expect(find.byType(FileUploadField), findsOneWidget);
  });

  testWidgets('parity: AI card hidden when no triage and status closed',
      (tester) async {
    final service = _FakeServiceRequestsService(mockRequests());
    // sr-102: RESOLVED, no ai_triage_status -> React hides the card.
    await pumpDetail(tester, service, 'sr-102');

    expect(find.text('Phân loại & điều phối từ AI'), findsNothing);
  });

  testWidgets(
      'parity: AI card shows ai_summary, manual warning and category override',
      (tester) async {
    final requests = mockRequests();
    requests.first['ai_triage_status'] = 'NEEDS_MANUAL_REVIEW';
    requests.first['ai_summary'] = 'Tóm tắt sự cố điện do AI.';
    final service = _FakeServiceRequestsService(requests);
    await pumpDetail(tester, service, 'sr-101');

    expect(find.text('Phân loại & điều phối từ AI'), findsOneWidget);
    expect(find.textContaining('Tóm tắt AI:'), findsOneWidget);
    expect(find.textContaining('Cần phân loại thủ công'), findsWidgets);
    expect(find.text('Hạng mục áp dụng / ghi đè'), findsOneWidget);
  });

  testWidgets('parity: resolve button visible when status ON_HOLD',
      (tester) async {
    final requests = mockRequests();
    requests.first['status'] = 'ON_HOLD';
    final service = _FakeServiceRequestsService(requests);
    await pumpDetail(tester, service, 'sr-101');

    expect(find.text('Hoàn tất xử lý'), findsOneWidget);
  });
}
