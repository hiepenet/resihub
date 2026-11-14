import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:flutter_resihub/core/network/query_cache.dart';
import 'package:flutter_resihub/core/storage/app_storage.dart';
import 'package:flutter_resihub/core/theme/app_theme.dart';
import 'package:flutter_resihub/features/auth/models/user_model.dart';
import 'package:flutter_resihub/features/auth/providers/auth_provider.dart';
import 'package:flutter_resihub/features/buildings/providers/buildings_lookup_provider.dart';
import 'package:flutter_resihub/features/buildings/screens/buildings_page.dart';
import 'package:flutter_resihub/features/buildings/services/buildings_service.dart';
import 'package:flutter_resihub/shared/widgets/common/search_bar_widget.dart';

class MockBuildingsService extends Fake implements BuildingsService {
  List<Map<String, dynamic>> buildingsData = [];
  Map<String, dynamic>? lastCreatedPayload;
  String? lastUpdatedId;
  Map<String, dynamic>? lastUpdatedPayload;
  String? lastRemovedId;
  String? lastStatusUpdatedId;
  String? lastStatusUpdatedStatus;
  String? lastCheckedCode;
  String? lastLookupIdentifier;

  @override
  dynamic peekList() => null;

  @override
  Future<dynamic> list({bool force = false}) async {
    return {'data': buildingsData};
  }

  @override
  Future<dynamic> listBanks() async {
    return {
      'data': [
        {
          'code': 'VCB',
          'shortName': 'Vietcombank',
          'name': 'Ngân hàng TMCP Ngoại Thương Việt Nam',
          'bin': '970436',
          'logo': 'https://api.vietqr.io/img/VCB.png',
        },
      ],
    };
  }

  @override
  Future<dynamic> checkCode(String code) async {
    lastCheckedCode = code;
    return {'available': true, 'message': 'Mã tòa khả dụng'};
  }

  @override
  Future<dynamic> lookupOwner(String identifier) async {
    lastLookupIdentifier = identifier;
    if (identifier.contains('notfound')) {
      return {'found': false, 'message': 'Không tìm thấy hồ sơ Chủ đầu tư khớp với thông tin này'};
    }
    return {
      'found': true,
      'owner': {
        'id': 'owner-999',
        'masked_name': 'Tr*** V** B',
        'masked_email': 'b***@gmail.com',
        'masked_phone': '098****456',
      },
    };
  }

  @override
  Future<dynamic> create(Map<String, dynamic> payload) async {
    lastCreatedPayload = payload;
    return {'id': 'b-new', ...payload};
  }

  @override
  Future<dynamic> update(String id, Map<String, dynamic> payload) async {
    lastUpdatedId = id;
    lastUpdatedPayload = payload;
    return {'id': id, ...payload};
  }

  @override
  Future<dynamic> remove(String id) async {
    lastRemovedId = id;
    return {'message': 'Đã xóa tòa nhà thành công'};
  }

  @override
  Future<dynamic> updateStatus(String id, String status) async {
    lastStatusUpdatedId = id;
    lastStatusUpdatedStatus = status;
    return {'id': id, 'status': status};
  }
}

List<Map<String, dynamic>> _sampleBuildings() => [
      {
        'id': 'b-1',
        'code': 'B01',
        'name': 'Tòa Diamond',
        'address': '123 Đường Số 1, Quận 1',
        'status': 'ACTIVE',
        'total_floors': 10,
        'total_zones': 2,
        'total_apartments': 50,
        'occupied_apartments': 30,
        'available_apartments': 20,
        'owner_id': 'owner-1',
        'owner_preview': {
          'id': 'owner-1',
          'masked_name': 'Ng*** V** A',
          'masked_email': 'a***@gmail.com',
          'masked_phone': '090****123',
        },
        'payment_account': {
          'bank_name': 'Vietcombank',
          'bank_code': 'VCB',
          'bank_bin': '970436',
          'account_number': '1234567890',
          'account_holder': 'NGUYEN VAN A',
        },
      },
      {
        'id': 'b-2',
        'code': 'B02',
        'name': 'Tòa Sapphire',
        'address': '456 Đường Số 2, Quận 2',
        'status': 'INACTIVE',
        'total_floors': 0,
        'total_zones': 0,
        'total_apartments': 0,
        'occupied_apartments': 0,
        'available_apartments': 0,
        'owner_id': null,
        'owner_preview': null,
        'payment_account': null,
      },
    ];

Widget _buildTestApp({
  required MockBuildingsService mockService,
  required String roleCode,
  required AppStorage storage,
  GoRouter? customRouter,
  void Function(ProviderContainer container)? onContainerCreated,
}) {
  final user = UserModel(
    id: 'user-$roleCode',
    fullName: 'User $roleCode',
    email: '$roleCode@resihub.test',
    roles: [UserRoleModel(code: roleCode)],
  );

  final router = customRouter ??
      GoRouter(
        initialLocation: '/admin/buildings',
        routes: [
          GoRoute(
            path: '/admin/buildings',
            builder: (context, state) => const BuildingsPage(),
          ),
          GoRoute(
            path: '/admin/buildings/:id/floor-plan',
            builder: (context, state) =>
                Scaffold(body: Text('FLOOR_PLAN_${state.pathParameters['id']}')),
          ),
          GoRoute(
            path: '/admin/buildings/:id',
            builder: (context, state) =>
                Scaffold(body: Text('DETAIL_${state.pathParameters['id']}')),
          ),
        ],
      );

  final container = ProviderContainer(
    overrides: [
      appStorageProvider.overrideWithValue(storage),
      buildingsServiceProvider.overrideWithValue(mockService),
    ],
  );

  container.read(authProvider.notifier).setAuthData(
        accessToken: 'test-token',
        refreshToken: 'test-refresh',
        user: user,
      );

  onContainerCreated?.call(container);

  return UncontrolledProviderScope(
    container: container,
    child: MaterialApp.router(
      theme: buildAppTheme(),
      routerConfig: router,
    ),
  );
}

Finder findInput(Key key) =>
    find.descendant(of: find.byKey(key), matching: find.byType(EditableText));

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late AppStorage storage;

  setUp(() async {
    SharedPreferences.setMockInitialValues({});
    final prefs = await SharedPreferences.getInstance();
    storage = AppStorage(prefs: prefs, isWeb: true);
  });

  group('BuildingsPage - Role Permissions & UI (M03 Part 1)', () {
    testWidgets('1. OWNER role: Read-only view (no Add, Edit, Delete, or Status Toggle)', (tester) async {
      tester.view.physicalSize = const Size(1280, 900);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);

      final service = MockBuildingsService()..buildingsData = _sampleBuildings();
      await tester.pumpWidget(_buildTestApp(mockService: service, roleCode: 'OWNER', storage: storage));
      await tester.pumpAndSettle();

      // Check header and stats
      expect(find.text('Quản lý Bất động sản'), findsOneWidget);
      expect(find.text('Tổng số tòa nhà'.toUpperCase()), findsOneWidget);
      expect(find.text('2'), findsOneWidget);
      expect(find.text('Tổng quy mô căn hộ'.toUpperCase()), findsOneWidget);
      expect(find.text('50'), findsOneWidget);
      expect(find.text('Tỷ lệ lấp đầy trung bình'.toUpperCase()), findsOneWidget);
      expect(find.text('60.0%'), findsOneWidget);

      // Check cards rendered
      expect(find.text('Tòa Diamond'), findsOneWidget);
      expect(find.text('Tòa Sapphire'), findsOneWidget);

      // OWNER permissions: canCreateBuilding == false, canEditRealEstate == false, canManageBuildings == false
      expect(find.text('Thêm tòa nhà mới'), findsNothing);
      expect(find.text('Sửa'), findsNothing);
      expect(find.text('Xóa'), findsNothing);
      expect(find.byKey(const Key('building_status_toggle_b-1')), findsNothing);

      // But Sơ đồ tầng & Chi tiết are visible
      expect(find.text('Sơ đồ tầng'), findsNWidgets(2));
      expect(find.text('Chi tiết'), findsNWidgets(2));

      // Click Sơ đồ tầng on first building navigates
      await tester.tap(find.text('Sơ đồ tầng').first);
      await tester.pumpAndSettle();
      expect(find.text('FLOOR_PLAN_b-1'), findsOneWidget);
    });

    testWidgets('2. MANAGER role: Sees Add and Edit, but NOT Delete or Status Toggle', (tester) async {
      tester.view.physicalSize = const Size(1280, 900);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);

      final service = MockBuildingsService()..buildingsData = _sampleBuildings();
      await tester.pumpWidget(_buildTestApp(mockService: service, roleCode: 'MANAGER', storage: storage));
      await tester.pumpAndSettle();

      // MANAGER: canCreateBuilding == true, canEditRealEstate == true
      expect(find.text('Thêm tòa nhà mới'), findsOneWidget);
      expect(find.text('Sửa'), findsNWidgets(2));

      // MANAGER: canManageBuildings == false -> No delete, no status toggle
      expect(find.text('Xóa'), findsNothing);
      expect(find.byKey(const Key('building_status_toggle_b-1')), findsNothing);
    });

    testWidgets('3. MANAGER editing building with existing owner: Owner field is LOCKED', (tester) async {
      tester.view.physicalSize = const Size(1280, 900);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);

      final service = MockBuildingsService()..buildingsData = _sampleBuildings();
      await tester.pumpWidget(_buildTestApp(mockService: service, roleCode: 'MANAGER', storage: storage));
      await tester.pumpAndSettle();

      // Click Sửa on first building (b-1 has owner_id 'owner-1')
      await tester.tap(find.text('Sửa').first);
      await tester.pumpAndSettle();

      // Modal is open
      expect(find.text('Cập nhật tòa nhà B01'), findsOneWidget);

      // Verify Owner section is LOCKED for MANAGER:
      // Shows lock message and masked info, NO "Đổi / Xóa" button, and NO search input
      expect(find.textContaining('FR-070'), findsOneWidget);
      expect(find.text('Ng*** V** A'), findsOneWidget);
      expect(find.text('Đổi / Xóa'), findsNothing);
      expect(find.byKey(const Key('owner_identifier_input')), findsNothing);
    });

    testWidgets('4. MANAGER editing building without owner: Owner field is EDITABLE', (tester) async {
      tester.view.physicalSize = const Size(1280, 900);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);

      final service = MockBuildingsService()..buildingsData = _sampleBuildings();
      await tester.pumpWidget(_buildTestApp(mockService: service, roleCode: 'MANAGER', storage: storage));
      await tester.pumpAndSettle();

      // Click Sửa on second building (b-2 has null owner_id)
      await tester.tap(find.text('Sửa').last);
      await tester.pumpAndSettle();

      // Modal is open
      expect(find.text('Cập nhật tòa nhà B02'), findsOneWidget);

      // Owner field is EDITABLE
      expect(findInput(const Key('owner_identifier_input')), findsOneWidget);
      expect(find.text('Kiểm tra'), findsOneWidget);

      // Test owner lookup by email
      await tester.enterText(findInput(const Key('owner_identifier_input')), 'owner@example.com');
      await tester.tap(find.text('Kiểm tra'));
      await tester.pumpAndSettle();

      expect(service.lastLookupIdentifier, 'owner@example.com');
      expect(find.text('Đã xác thực: Tr*** V** B'), findsOneWidget);
      expect(find.text('Đổi / Xóa'), findsOneWidget);
    });

    testWidgets('5. SYS_ADMIN: Full access (Owner NOT locked, can toggle status and delete)', (tester) async {
      tester.view.physicalSize = const Size(1280, 900);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);

      final service = MockBuildingsService()..buildingsData = _sampleBuildings();
      await tester.pumpWidget(_buildTestApp(mockService: service, roleCode: 'SYS_ADMIN', storage: storage));
      await tester.pumpAndSettle();

      // Add, Edit, Delete, Status Toggle all present
      expect(find.text('Thêm tòa nhà mới'), findsOneWidget);
      expect(find.text('Sửa'), findsNWidgets(2));
      expect(find.text('Xóa'), findsNWidgets(2));
      expect(find.byKey(const Key('building_status_toggle_b-1')), findsOneWidget);
      expect(find.byKey(const Key('building_status_toggle_b-2')), findsOneWidget);

      // B01 has 10 floors and 50 apts -> Delete button is disabled
      // B02 has 0 floors and 0 apts -> Delete button is enabled

      // Test Edit on B01: Owner field is NOT locked for SYS_ADMIN!
      await tester.tap(find.text('Sửa').first);
      await tester.pumpAndSettle();
      expect(find.text('Cập nhật tòa nhà B01'), findsOneWidget);
      expect(find.text('Đổi / Xóa'), findsOneWidget); // SYS_ADMIN can change owner!
      expect(find.textContaining('FR-070'), findsNothing); // Lock message not shown

      // Close modal
      await tester.tap(find.text('Hủy bỏ'));
      await tester.pumpAndSettle();

      // Test Status Toggle on B01 (currently ACTIVE -> toggle to INACTIVE)
      await tester.tap(find.byKey(const Key('building_status_toggle_b-1')));
      await tester.pumpAndSettle();
      expect(service.lastStatusUpdatedId, 'b-1');
      expect(service.lastStatusUpdatedStatus, 'INACTIVE');

      // Test Delete on B02 (empty building)
      await tester.tap(find.text('Xóa').last);
      await tester.pumpAndSettle();

      // Confirm dialog appears
      expect(find.text('Xác nhận xóa tòa nhà'), findsOneWidget);
      expect(find.textContaining('B02 — Tòa Sapphire'), findsOneWidget);

      // Tap confirm button
      await tester.tap(find.text('Xóa tòa nhà'));
      await tester.pumpAndSettle();
      expect(service.lastRemovedId, 'b-2');

      // Flush toast dismiss timer
      await tester.pump(const Duration(seconds: 5));
    });

    testWidgets('6. Search filters building cards & shows empty state when no match', (tester) async {
      tester.view.physicalSize = const Size(1280, 900);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);

      final service = MockBuildingsService()..buildingsData = _sampleBuildings();
      await tester.pumpWidget(_buildTestApp(mockService: service, roleCode: 'SYS_ADMIN', storage: storage));
      await tester.pumpAndSettle();

      expect(find.text('Tòa Diamond'), findsOneWidget);
      expect(find.text('Tòa Sapphire'), findsOneWidget);

      // Search for "Diamond"
      final searchField = find.descendant(of: find.byType(SearchBarWidget), matching: find.byType(EditableText));
      await tester.enterText(searchField, 'Diamond');
      await tester.pump(const Duration(milliseconds: 350));
      await tester.pumpAndSettle();

      expect(find.text('Tòa Diamond'), findsOneWidget);
      expect(find.text('Tòa Sapphire'), findsNothing);

      // Search for non-existent "xyz"
      await tester.enterText(searchField, 'xyz-non-existent');
      await tester.pump(const Duration(milliseconds: 350));
      await tester.pumpAndSettle();

      expect(find.text('Không tìm thấy tòa nhà nào'), findsOneWidget);
      expect(find.text('Tòa Diamond'), findsNothing);
      expect(find.text('Tòa Sapphire'), findsNothing);
    });

    testWidgets('7. Create building modal: validates and submits payload, invalidates selector', (tester) async {
      tester.view.physicalSize = const Size(1280, 900);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);

      final service = MockBuildingsService()..buildingsData = _sampleBuildings();
      late ProviderContainer capturedContainer;
      await tester.pumpWidget(_buildTestApp(
        mockService: service,
        roleCode: 'MANAGER',
        storage: storage,
        onContainerCreated: (c) => capturedContainer = c,
      ));
      await tester.pumpAndSettle();

      // Open create modal
      await tester.tap(find.text('Thêm tòa nhà mới'));
      await tester.pumpAndSettle();

      expect(find.text('Khởi tạo tòa nhà mới'), findsOneWidget);

      // Fill in Name
      await tester.enterText(findInput(const Key('building_name_input')), 'Tòa Ruby');
      // Fill in Code
      await tester.enterText(findInput(const Key('building_code_input')), 'VOP-R');
      // Fill in Address
      await tester.enterText(findInput(const Key('building_address_input')), '789 Đường Số 3');

      // Submit
      await tester.tap(find.text('Tạo tòa nhà'));
      await tester.pumpAndSettle();

      expect(service.lastCreatedPayload, isNotNull);
      expect(service.lastCreatedPayload!['name'], 'Tòa Ruby');
      expect(service.lastCreatedPayload!['code'], 'VOP-R');
      expect(service.lastCreatedPayload!['address'], '789 Đường Số 3');

      // Verify Live TopBar Sync: queryCache and selector provider for 'buildings' invalidated
      expect(capturedContainer.read(queryCacheProvider).peek('buildings'), isNull);
      expect(capturedContainer.exists(buildingsListProvider), isFalse);

      // Flush toast dismiss timer
      await tester.pump(const Duration(seconds: 5));
    });
  });
}
