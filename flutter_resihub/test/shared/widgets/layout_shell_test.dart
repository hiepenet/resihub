import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:flutter_resihub/core/storage/app_storage.dart';
import 'package:flutter_resihub/core/theme/app_theme.dart';
import 'package:flutter_resihub/features/auth/models/user_model.dart';
import 'package:flutter_resihub/features/auth/providers/auth_provider.dart';
import 'package:flutter_resihub/features/auth/services/auth_service.dart';
import 'package:flutter_resihub/features/buildings/providers/buildings_lookup_provider.dart';
import 'package:flutter_resihub/features/buildings/services/buildings_service.dart';
import 'package:flutter_resihub/features/notifications/services/notifications_service.dart';
import 'package:flutter_resihub/shared/widgets/common/notification_bell.dart';
import 'package:flutter_resihub/shared/widgets/common/profile_modal.dart';
import 'package:flutter_resihub/shared/widgets/layout/admin_shell.dart';
import 'package:flutter_resihub/shared/widgets/layout/resident_shell.dart';
import 'package:flutter_resihub/shared/widgets/layout/sidebar_widget.dart';
import 'package:flutter_resihub/shared/widgets/layout/top_bar.dart';

class _FakeNotificationsService extends Fake implements NotificationsService {
  @override
  Future<dynamic> list() async {
    return {
      'data': [
        {
          'id': 'notif-1',
          'type': 'ANNOUNCEMENT',
          'title': 'Bảo trì thang máy',
          'content': 'Thang máy sẽ tạm ngừng hoạt động vào ngày mai.',
          'created_at': DateTime.now().toIso8601String(),
          'read_at': null,
        }
      ],
      'unread_count': 1,
    };
  }

  @override
  Future<dynamic> markRead(dynamic id) async {
    return {'success': true};
  }
}

class _FakeAuthService extends Fake implements AuthService {
  @override
  Future<dynamic> getProfile() async {
    return {
      'profile': {
        'full_name': 'Nguyễn Văn Quản Lý',
        'email': 'manager@resihub.test',
        'phone': '0901234567',
      }
    };
  }

  @override
  Future<dynamic> logout() async {
    return {'success': true};
  }
}

class _FakeBuildingsService extends Fake implements BuildingsService {
  List<Map<String, dynamic>> mockList = [
    {'id': 'bld-1', 'code': 'B01', 'name': 'Tòa Diamond', 'address': '123 Cầu Giấy'},
    {'id': 'bld-2', 'code': 'B02', 'name': 'Tòa Sapphire', 'address': '456 Mỹ Đình'},
  ];

  @override
  Future<dynamic> list({bool force = false}) async {
    return {'data': mockList};
  }
}

UserModel _createUserWithRole(String roleCode, {String? buildingId}) {
  return UserModel(
    id: 'user-$roleCode',
    fullName: 'Test User $roleCode',
    email: '$roleCode@resihub.test',
    roles: [
      UserRoleModel(code: roleCode, buildingId: buildingId),
    ],
  );
}

Widget _wrapWithScope({
  required Widget child,
  required AppStorage storage,
  UserModel? user,
  List<Map<String, dynamic>>? buildings,
  _FakeBuildingsService? buildingsService,
}) {
  return ProviderScope(
    overrides: [
      appStorageProvider.overrideWithValue(storage),
      notificationsServiceProvider.overrideWithValue(_FakeNotificationsService()),
      authServiceProvider.overrideWithValue(_FakeAuthService()),
      if (buildingsService != null)
        buildingsServiceProvider.overrideWithValue(buildingsService),
      if (buildings != null)
        buildingsListProvider.overrideWith((ref) async => buildings),
    ],
    child: MaterialApp(
      theme: buildAppTheme(),
      home: child,
    ),
  );
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late AppStorage storage;

  setUp(() async {
    SharedPreferences.setMockInitialValues({});
    storage = AppStorage(isWeb: true);
    await storage.init();
  });

  group('1. SidebarWidget Role-Based Menu Filtering & Navigation', () {
    testWidgets('SYS_ADMIN sees all 14 nav items across 4 groups', (tester) async {
      final user = _createUserWithRole('SYS_ADMIN');
      await storage.setUser(user.toJson());
      await storage.setTokens(accessToken: 'mock-sysadmin-token');

      await tester.pumpWidget(
        _wrapWithScope(
          storage: storage,
          user: user,
          child: const Scaffold(
            body: SidebarWidget(
              currentPath: '/admin/dashboard',
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      // All 14 items should exist
      expect(find.text('Bảng điều khiển'), findsOneWidget);
      expect(find.text('Bất động sản'), findsOneWidget);
      expect(find.text('Hồ sơ Cư dân'), findsOneWidget);
      expect(find.text('Hợp đồng thuê'), findsOneWidget);
      expect(find.text('Quản lý Tiền cọc'), findsOneWidget);
      expect(find.text('Chỉ số Điện / Nước'), findsOneWidget);
      expect(find.text('Dịch vụ & Tiện ích'), findsOneWidget);
      expect(find.text('Hóa đơn kỳ'), findsOneWidget);
      expect(find.text('Thanh toán & Công nợ'), findsOneWidget);
      expect(find.text('Yêu cầu & Báo hỏng'), findsOneWidget);
      expect(find.text('Thông báo cư dân'), findsOneWidget);
      expect(find.text('Báo cáo thống kê'), findsOneWidget);
      // SYS_ADMIN specific items:
      expect(find.text('Nhật ký hệ thống'), findsOneWidget);
      expect(find.text('Người dùng & Cấu hình'), findsOneWidget);
      // Role label footer
      expect(find.text('Quản trị hệ thống'), findsOneWidget);
    });

    testWidgets('OWNER sees 13 nav items (audit-logs included, users excluded)', (tester) async {
      final user = _createUserWithRole('OWNER');
      await storage.setUser(user.toJson());
      await storage.setTokens(accessToken: 'mock-owner-token');

      await tester.pumpWidget(
        _wrapWithScope(
          storage: storage,
          user: user,
          child: const Scaffold(
            body: SidebarWidget(
              currentPath: '/admin/dashboard',
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Bảng điều khiển'), findsOneWidget);
      expect(find.text('Nhật ký hệ thống'), findsOneWidget);
      // OWNER must NOT see Người dùng & Cấu hình
      expect(find.text('Người dùng & Cấu hình'), findsNothing);
      expect(find.text('Chủ đầu tư'), findsOneWidget);
    });

    testWidgets('MANAGER sees 12 nav items (audit-logs and users excluded)', (tester) async {
      final user = _createUserWithRole('MANAGER');
      await storage.setUser(user.toJson());
      await storage.setTokens(accessToken: 'mock-manager-token');

      await tester.pumpWidget(
        _wrapWithScope(
          storage: storage,
          user: user,
          child: const Scaffold(
            body: SidebarWidget(
              currentPath: '/admin/dashboard',
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Bảng điều khiển'), findsOneWidget);
      expect(find.text('Hóa đơn kỳ'), findsOneWidget);
      // MANAGER must NOT see audit-logs or users
      expect(find.text('Nhật ký hệ thống'), findsNothing);
      expect(find.text('Người dùng & Cấu hình'), findsNothing);
      expect(find.text('Quản lý tòa nhà'), findsOneWidget);
    });

    testWidgets('Sidebar highlights active route and fires onNavigate callback', (tester) async {
      final user = _createUserWithRole('MANAGER');
      await storage.setUser(user.toJson());
      await storage.setTokens(accessToken: 'mock-token');

      String? navigatedRoute;

      await tester.pumpWidget(
        _wrapWithScope(
          storage: storage,
          user: user,
          child: Scaffold(
            body: SidebarWidget(
              currentPath: '/admin/buildings',
              onNavigate: (route) => navigatedRoute = route,
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      // Tap on Hóa đơn kỳ
      final invoicesFinder = find.text('Hóa đơn kỳ');
      await tester.ensureVisible(invoicesFinder);
      await tester.tap(invoicesFinder);
      await tester.pumpAndSettle();

      expect(navigatedRoute, '/admin/invoices');
    });

    testWidgets('Sidebar toggle collapse button immediately changes rendered width and persists in AppStorage', (tester) async {
      final user = _createUserWithRole('SYS_ADMIN');
      await storage.setUser(user.toJson());
      await storage.setTokens(accessToken: 'mock-token');

      await tester.pumpWidget(
        _wrapWithScope(
          storage: storage,
          user: user,
          child: const Scaffold(
            body: SidebarWidget(
              currentPath: '/admin/dashboard',
              collapsible: true,
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      // Initially expanded (256px)
      expect(tester.getSize(find.byType(SidebarWidget)).width, 256.0);
      expect(storage.sidebarCollapsed, isFalse);

      // Find collapse toggle button
      final toggleButton = find.byKey(const Key('sidebar-collapse-toggle'));
      expect(toggleButton, findsOneWidget);
      await tester.tap(toggleButton);
      await tester.pumpAndSettle();

      // Immediately collapsed (72px) without external rebuild
      expect(tester.getSize(find.byType(SidebarWidget)).width, 72.0);
      expect(storage.sidebarCollapsed, isTrue);

      // Tap again to re-expand
      await tester.tap(toggleButton);
      await tester.pumpAndSettle();
      expect(tester.getSize(find.byType(SidebarWidget)).width, 256.0);
      expect(storage.sidebarCollapsed, isFalse);
    });
  });

  group('2. TopBar Reactive Building Selector & User Actions', () {
    testWidgets('TopBar renders building selector with placeholder when multiple buildings exist', (tester) async {
      final user = _createUserWithRole('SYS_ADMIN');
      await storage.setUser(user.toJson());
      await storage.setTokens(accessToken: 'mock-token');

      final buildings = [
        {'id': 'bld-1', 'code': 'B01', 'name': 'Tòa Diamond'},
        {'id': 'bld-2', 'code': 'B02', 'name': 'Tòa Sapphire'},
      ];

      await tester.pumpWidget(
        _wrapWithScope(
          storage: storage,
          user: user,
          buildings: buildings,
          child: const Scaffold(
            body: TopBar(),
          ),
        ),
      );
      await tester.pumpAndSettle();

      // Displays dropdown with placeholder 'Tất cả tòa nhà trong phạm vi (2)'
      expect(find.text('Tất cả tòa nhà trong phạm vi (2)'), findsOneWidget);
      expect(find.byType(NotificationBell), findsOneWidget);
    });

    testWidgets('TopBar allows selecting building and switching back to all buildings', (tester) async {
      final user = _createUserWithRole('SYS_ADMIN');
      await storage.setUser(user.toJson());
      await storage.setTokens(accessToken: 'mock-token');

      final buildings = [
        {'id': 'bld-1', 'code': 'B01', 'name': 'Tòa Diamond'},
        {'id': 'bld-2', 'code': 'B02', 'name': 'Tòa Sapphire'},
      ];

      late WidgetRef capturedRef;

      await tester.pumpWidget(
        _wrapWithScope(
          storage: storage,
          user: user,
          buildings: buildings,
          child: Scaffold(
            body: Consumer(
              builder: (ctx, ref, _) {
                capturedRef = ref;
                return const TopBar();
              },
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      // Initial state: selectedBuildingId is empty, selector shows all buildings label
      expect(find.text('Tất cả tòa nhà trong phạm vi (2)'), findsOneWidget);

      // Open selector dropdown
      await tester.tap(find.text('Tất cả tòa nhà trong phạm vi (2)'));
      await tester.pumpAndSettle();

      // Select Tòa Diamond
      await tester.tap(find.text('B01 — Tòa Diamond').last);
      await tester.pumpAndSettle();

      // Verify selectedBuildingId became 'bld-1'
      expect(capturedRef.read(authProvider).selectedBuildingId, 'bld-1');
      expect(find.text('B01 — Tòa Diamond'), findsOneWidget);

      // Re-open selector to switch back to 'Tất cả tòa nhà trong phạm vi (2)'
      await tester.tap(find.text('B01 — Tòa Diamond'));
      await tester.pumpAndSettle();

      // Select 'Tất cả tòa nhà trong phạm vi (2)'
      await tester.tap(find.text('Tất cả tòa nhà trong phạm vi (2)').last);
      await tester.pumpAndSettle();

      // Verify selectedBuildingId reverted to empty string
      expect(capturedRef.read(authProvider).selectedBuildingId, '');
    });

    testWidgets('TopBar auto-syncs selectedBuildingId when list changes to single building', (tester) async {
      final user = _createUserWithRole('MANAGER', buildingId: 'bld-1');
      await storage.setUser(user.toJson());
      await storage.setTokens(accessToken: 'mock-token');

      final singleBuilding = [
        {'id': 'bld-1', 'code': 'B01', 'name': 'Tòa Diamond'},
      ];

      late WidgetRef capturedRef;

      await tester.pumpWidget(
        _wrapWithScope(
          storage: storage,
          user: user,
          buildings: singleBuilding,
          child: Scaffold(
            body: Consumer(
              builder: (ctx, ref, _) {
                capturedRef = ref;
                return const TopBar();
              },
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      // The selectedBuildingId in authProvider should be auto-synced to 'bld-1'
      expect(capturedRef.read(authProvider).selectedBuildingId, 'bld-1');
    });

    testWidgets('TopBar auto-resets selectedBuildingId when current selection is not in list', (tester) async {
      final user = _createUserWithRole('SYS_ADMIN');
      await storage.setUser(user.toJson());
      await storage.setTokens(accessToken: 'mock-token');
      await storage.setSelectedBuildingId('bld-deleted');

      final buildings = [
        {'id': 'bld-1', 'code': 'B01', 'name': 'Tòa Diamond'},
        {'id': 'bld-2', 'code': 'B02', 'name': 'Tòa Sapphire'},
      ];

      late WidgetRef capturedRef;

      await tester.pumpWidget(
        _wrapWithScope(
          storage: storage,
          user: user,
          buildings: buildings,
          child: Scaffold(
            body: Consumer(
              builder: (ctx, ref, _) {
                capturedRef = ref;
                return const TopBar();
              },
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      // Auto-resets to empty string because 'bld-deleted' is invalid
      expect(capturedRef.read(authProvider).selectedBuildingId, '');
    });

    testWidgets('TopBar profile button opens ProfileModal and logout button clears session', (tester) async {
      final user = _createUserWithRole('SYS_ADMIN');
      await storage.setUser(user.toJson());
      await storage.setTokens(accessToken: 'mock-token');

      late WidgetRef capturedRef;

      await tester.pumpWidget(
        _wrapWithScope(
          storage: storage,
          user: user,
          buildings: const [],
          child: Scaffold(
            body: Consumer(
              builder: (ctx, ref, _) {
                capturedRef = ref;
                return const TopBar();
              },
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      // Avatar button
      final profileButton = find.byKey(const Key('topbar-profile-button'));
      expect(profileButton, findsOneWidget);
      await tester.tap(profileButton);
      await tester.pumpAndSettle();

      expect(find.byType(ProfileModal), findsOneWidget);

      // Close modal
      final closeButton = find.text('Đóng');
      await tester.tap(closeButton);
      await tester.pumpAndSettle();
      expect(find.byType(ProfileModal), findsNothing);

      // Tap logout
      final logoutButton = find.byKey(const Key('topbar-logout-button'));
      expect(logoutButton, findsOneWidget);
      await tester.tap(logoutButton);
      await tester.pumpAndSettle();

      expect(capturedRef.read(authProvider).isAuthenticated, isFalse);
    });
  });

  group('3. AdminShell Desktop vs Mobile Layout', () {
    testWidgets('AdminShell renders persistent Sidebar on desktop (1280px)', (tester) async {
      tester.view.physicalSize = const Size(1280, 800);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(() => tester.view.resetPhysicalSize());

      final user = _createUserWithRole('SYS_ADMIN');
      await storage.setUser(user.toJson());
      await storage.setTokens(accessToken: 'mock-token');

      await tester.pumpWidget(
        _wrapWithScope(
          storage: storage,
          user: user,
          buildings: const [],
          child: const AdminShell(
            currentLocation: '/admin/dashboard',
            child: Text('Dashboard Content'),
          ),
        ),
      );
      await tester.pumpAndSettle();

      // On desktop, persistent sidebar is visible
      expect(find.byType(SidebarWidget), findsOneWidget);
      expect(find.text('Dashboard Content'), findsOneWidget);
      // Hamburger menu button is hidden on desktop
      expect(find.byKey(const Key('topbar-mobile-menu-button')), findsNothing);
      expect(tester.takeException(), isNull);
    });

    testWidgets('AdminShell uses Drawer on mobile (375px) and opens via hamburger button', (tester) async {
      tester.view.physicalSize = const Size(375, 667);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(() => tester.view.resetPhysicalSize());

      final user = _createUserWithRole('SYS_ADMIN');
      await storage.setUser(user.toJson());
      await storage.setTokens(accessToken: 'mock-token');

      await tester.pumpWidget(
        _wrapWithScope(
          storage: storage,
          user: user,
          buildings: const [],
          child: const AdminShell(
            currentLocation: '/admin/dashboard',
            child: Text('Dashboard Content'),
          ),
        ),
      );
      await tester.pumpAndSettle();

      // On mobile, persistent sidebar is not visible until drawer opens
      expect(find.byType(SidebarWidget), findsNothing);
      expect(find.text('Dashboard Content'), findsOneWidget);

      // Hamburger button is visible
      final hamburger = find.byKey(const Key('topbar-mobile-menu-button'));
      expect(hamburger, findsOneWidget);

      // Tap hamburger to open drawer
      await tester.tap(hamburger);
      await tester.pumpAndSettle();

      // Now SidebarWidget inside Drawer is visible
      expect(find.byType(SidebarWidget), findsOneWidget);
      expect(tester.takeException(), isNull);
    });

    testWidgets('AdminShell wraps child in SelectionArea for web text copying', (tester) async {
      tester.view.physicalSize = const Size(1280, 800);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(() => tester.view.resetPhysicalSize());

      final user = _createUserWithRole('SYS_ADMIN');
      await storage.setUser(user.toJson());
      await storage.setTokens(accessToken: 'mock-token');

      await tester.pumpWidget(
        _wrapWithScope(
          storage: storage,
          user: user,
          buildings: const [],
          child: const AdminShell(
            currentLocation: '/admin/contracts',
            child: Text('HD-2026-001'),
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.byType(SelectionArea), findsOneWidget);
      expect(find.text('HD-2026-001'), findsOneWidget);
    });
  });

  group('4. ResidentShell 3-Tier Responsive Breakpoints & Multi-Contract Switcher', () {
    final mockContracts = [
      {'contract_id': 'c-101', 'apartment_code': 'A101', 'building_name': 'Tòa Diamond', 'is_future_contract': false},
      {'contract_id': 'c-202', 'apartment_code': 'B202', 'building_name': 'Tòa Sapphire', 'is_future_contract': true},
    ];

    testWidgets('Desktop (1280px) renders left 8-tab sidebar and multi-contract switcher', (tester) async {
      tester.view.physicalSize = const Size(1280, 800);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(() => tester.view.resetPhysicalSize());

      final user = _createUserWithRole('RESIDENT');
      await storage.setUser(user.toJson());
      await storage.setTokens(accessToken: 'mock-token');

      String selectedTab = 'overview';
      String? switchedContract;

      await tester.pumpWidget(
        _wrapWithScope(
          storage: storage,
          user: user,
          child: ResidentShell(
            activeTab: selectedTab,
            onTabSelected: (t) => selectedTab = t,
            contracts: mockContracts,
            selectedContractId: 'c-101',
            onContractChanged: (cid) => switchedContract = cid,
            child: const Text('Resident Overview Content'),
          ),
        ),
      );
      await tester.pumpAndSettle();

      // In desktop sidebar, all 8 tabs are rendered
      expect(find.text('Tổng quan'), findsWidgets);
      expect(find.text('Hợp đồng & Cọc'), findsOneWidget);
      expect(find.text('Hóa đơn & TT'), findsOneWidget);
      expect(find.text('Dịch vụ tiện ích'), findsOneWidget);
      expect(find.text('Báo hỏng / Hỗ trợ'), findsOneWidget);
      expect(find.text('Thông báo'), findsWidgets);
      expect(find.text('Danh bạ BQL'), findsOneWidget);
      expect(find.text('Hồ sơ cá nhân'), findsOneWidget);

      // Multi-contract switcher is visible (contracts.length > 1)
      expect(find.byKey(const Key('resident-contract-switcher')), findsOneWidget);
      await tester.tap(find.byKey(const Key('resident-contract-switcher')));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Căn B202 — Tòa Sapphire').last);
      await tester.pumpAndSettle();
      expect(switchedContract, 'c-202');

      // Tap on Hóa đơn & TT tab
      await tester.tap(find.text('Hóa đơn & TT'));
      await tester.pumpAndSettle();
      expect(selectedTab, 'invoices');

      // Verify no bottom navigation bar on desktop
      expect(find.byKey(const Key('resident-bottom-nav')), findsNothing);
      expect(tester.takeException(), isNull);
    });

    testWidgets('Tablet (800px) renders horizontal scrollable tab bar and no bottom nav', (tester) async {
      tester.view.physicalSize = const Size(800, 1024);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(() => tester.view.resetPhysicalSize());

      final user = _createUserWithRole('RESIDENT');
      await storage.setUser(user.toJson());
      await storage.setTokens(accessToken: 'mock-token');

      String selectedTab = 'overview';

      await tester.pumpWidget(
        _wrapWithScope(
          storage: storage,
          user: user,
          child: ResidentShell(
            activeTab: selectedTab,
            onTabSelected: (t) => selectedTab = t,
            contracts: const [],
            apartmentBadge: 'Căn A101 — Tòa Diamond',
            child: const Text('Tablet Content'),
          ),
        ),
      );
      await tester.pumpAndSettle();

      // Horizontal tab strip is visible
      expect(find.byKey(const Key('resident-horizontal-tabs')), findsOneWidget);
      // Apartment badge rendered since contracts.length <= 1
      expect(find.text('Căn A101 — Tòa Diamond'), findsOneWidget);
      // Contract switcher not rendered since contracts.length <= 1
      expect(find.byKey(const Key('resident-contract-switcher')), findsNothing);
      // No bottom nav on tablet
      expect(find.byKey(const Key('resident-bottom-nav')), findsNothing);
      expect(tester.takeException(), isNull);
    });

    testWidgets('Mobile (375px) renders 5-slot BottomNav and "Thêm" opens 4-tab bottom sheet', (tester) async {
      tester.view.physicalSize = const Size(375, 667);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(() => tester.view.resetPhysicalSize());

      final user = _createUserWithRole('RESIDENT');
      await storage.setUser(user.toJson());
      await storage.setTokens(accessToken: 'mock-token');

      String selectedTab = 'overview';

      await tester.pumpWidget(
        _wrapWithScope(
          storage: storage,
          user: user,
          child: StatefulBuilder(
            builder: (ctx, setState) {
              return ResidentShell(
                activeTab: selectedTab,
                onTabSelected: (t) => setState(() => selectedTab = t),
                contracts: mockContracts,
                selectedContractId: 'c-101',
                child: Text('Current Tab: $selectedTab'),
              );
            },
          ),
        ),
      );
      await tester.pumpAndSettle();

      // BottomNav is visible on mobile
      expect(find.byKey(const Key('resident-bottom-nav')), findsOneWidget);

      // 4 primary tabs: Tổng quan, Hóa đơn, Báo hỏng, Dịch vụ + Thêm
      expect(find.text('Tổng quan'), findsWidgets);
      expect(find.text('Hóa đơn'), findsOneWidget);
      expect(find.text('Báo hỏng'), findsOneWidget);
      expect(find.text('Dịch vụ'), findsOneWidget);
      expect(find.text('Thêm'), findsOneWidget);

      // Tap on 'Thêm' button to open bottom sheet
      await tester.tap(find.text('Thêm'));
      await tester.pumpAndSettle();

      // Modal bottom sheet should appear with the 4 secondary tabs
      expect(find.text('Tiện ích & Hồ sơ cư dân'), findsOneWidget);
      expect(find.text('Hợp đồng & Cọc'), findsOneWidget);
      expect(find.text('Danh bạ BQL'), findsOneWidget);
      expect(find.text('Hồ sơ cá nhân'), findsOneWidget);

      // Tap on 'Hợp đồng & Cọc' in the modal sheet
      await tester.tap(find.text('Hợp đồng & Cọc'));
      await tester.pumpAndSettle();

      // Modal sheet is closed and active tab is switched to 'contract'
      expect(selectedTab, 'contract');
      expect(find.text('Current Tab: contract'), findsOneWidget);

      // Now that active tab is 'contract' (secondary tab), the 5th bottom nav slot highlights and shows 'Hợp đồng'
      expect(find.text('Hợp đồng'), findsOneWidget);

      expect(tester.takeException(), isNull);
    });

    testWidgets('ResidentShell wraps child in SelectionArea for web text copying', (tester) async {
      tester.view.physicalSize = const Size(1280, 800);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(() => tester.view.resetPhysicalSize());

      final user = _createUserWithRole('RESIDENT');
      await storage.setUser(user.toJson());
      await storage.setTokens(accessToken: 'mock-token');

      await tester.pumpWidget(
        _wrapWithScope(
          storage: storage,
          user: user,
          buildings: const [],
          child: ResidentShell(
            activeTab: 'invoices',
            onTabSelected: (_) {},
            contracts: const [],
            child: const Text('INV-2026-001'),
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.byType(SelectionArea), findsOneWidget);
      expect(find.text('INV-2026-001'), findsOneWidget);
    });
  });
}
