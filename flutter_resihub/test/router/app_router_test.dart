import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:flutter_resihub/core/network/dio_client.dart';
import 'package:flutter_resihub/core/storage/app_storage.dart';
import 'package:flutter_resihub/features/ai_gateway/screens/settings_page.dart';
import 'package:flutter_resihub/features/audit/screens/audit_logs_page.dart';
import 'package:flutter_resihub/features/auth/models/user_model.dart';
import 'package:flutter_resihub/features/auth/providers/auth_provider.dart';
import 'package:flutter_resihub/features/auth/screens/forgot_password_page.dart';
import 'package:flutter_resihub/features/auth/screens/login_page.dart';
import 'package:flutter_resihub/features/buildings/screens/apartment_detail_page.dart';
import 'package:flutter_resihub/features/buildings/screens/building_detail_page.dart';
import 'package:flutter_resihub/features/buildings/screens/buildings_page.dart';
import 'package:flutter_resihub/features/buildings/screens/floor_plan_page.dart';
import 'package:flutter_resihub/features/buildings/screens/zone_detail_page.dart';
import 'package:flutter_resihub/features/buildings/services/buildings_service.dart';
import 'package:flutter_resihub/features/contracts/screens/contract_detail_page.dart';
import 'package:flutter_resihub/features/contracts/screens/contracts_page.dart';
import 'package:flutter_resihub/features/deposits/screens/deposits_page.dart';
import 'package:flutter_resihub/features/invoices/screens/invoice_detail_page.dart';
import 'package:flutter_resihub/features/invoices/screens/invoices_page.dart';
import 'package:flutter_resihub/features/maintenance/screens/service_requests_page.dart';
import 'package:flutter_resihub/features/meters/screens/meter_readings_page.dart';
import 'package:flutter_resihub/features/notifications/screens/notifications_page.dart';
import 'package:flutter_resihub/features/payments/screens/payments_page.dart';
import 'package:flutter_resihub/features/public/screens/public_explore_page.dart';
import 'package:flutter_resihub/features/reports/screens/dashboard_page.dart';
import 'package:flutter_resihub/features/reports/screens/reports_page.dart';
import 'package:flutter_resihub/features/resident/screens/resident_portal_page.dart';
import 'package:flutter_resihub/features/services/screens/service_catalog_page.dart';
import 'package:flutter_resihub/features/services/screens/subscriptions_page.dart';
import 'package:flutter_resihub/features/tenants/screens/tenant_detail_page.dart';
import 'package:flutter_resihub/features/tenants/screens/tenants_page.dart';
import 'package:flutter_resihub/features/users/screens/users_page.dart';
import 'package:flutter_resihub/router/app_router.dart';
import 'package:flutter_resihub/router/route_guards.dart';
import 'package:flutter_resihub/shared/widgets/common/access_denied.dart';

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

Map<String, dynamic> _buildMockJsonPayload(RequestOptions options) {
  final path = options.path;
  final segments = path.split('/').where((s) => s.isNotEmpty).toList();

  if (path.endsWith('/public/apartments')) {
    return {
      'success': true,
      'data': {
        'buildings': [
          {'id': 'b-1', 'code': 'B01', 'name': 'Tòa Diamond', 'address': '123 Cầu Giấy'},
        ],
        'apartments': [
          {
            'id': 'apt-101',
            'code': 'A-101',
            'building_id': 'b-1',
            'building_code': 'B01',
            'building_name': 'Tòa Diamond',
            'floor_name': 'Tầng 1',
            'type': '1PN',
            'bedrooms': 1,
            'area_m2': 45,
            'base_rent': 8500000,
            'amenities': ['Điều hòa'],
          },
        ],
        'policy': {
          'max_hold_days': 30,
          'public_max_hold_days': 7,
          'full_refund_before_days': 3,
          'partial_refund_pct': 50,
          'default_hold_amount': 2000000,
        },
        'policies_by_org': <String, dynamic>{},
        'payment_accounts': <String, dynamic>{},
      },
    };
  }

  if (path.endsWith('/auth/public-config')) {
    return {'success': true, 'showDemoAccounts': false};
  }

  if (path.endsWith('/auth/profile')) {
    return {'success': true, 'profile': <String, dynamic>{}};
  }

  if (path.endsWith('/auth/me')) {
    return {'success': true, 'user': <String, dynamic>{}};
  }

  if (path.endsWith('/notifications')) {
    return {
      'success': true,
      'data': <Map<String, dynamic>>[],
      'sent_history': <Map<String, dynamic>>[],
      'unread_count': 0,
    };
  }

  if (path.endsWith('/reports/dashboard')) {
    return {
      'success': true,
      'data': {
        'kpis': {
          'current_period': '2026-11',
          'total_apartments': 20,
          'occupied_apartments': 15,
          'occupancy_rate': 75.0,
          'monthly_revenue': 150000000,
          'total_receivables': 10000000,
          'open_service_requests': 2,
        },
        'revenue_12m': <Map<String, dynamic>>[],
        'revenue_by_source': <Map<String, dynamic>>[],
        'receivables_aging': <String, dynamic>{},
        'occupancy_12m': <Map<String, dynamic>>[],
        'expiring_contracts': <Map<String, dynamic>>[],
        'recent_service_requests': <Map<String, dynamic>>[],
      },
    };
  }

  if (path.endsWith('/reports/summary')) {
    return {
      'success': true,
      'data': {
        'revenue_12m': <Map<String, dynamic>>[],
        'occupancy_by_building': <Map<String, dynamic>>[],
        'aging_by_building': <Map<String, dynamic>>[],
        'sla_by_category': <Map<String, dynamic>>[],
      },
    };
  }

  if (path.endsWith('/reports/deposit-ledger')) {
    return {
      'success': true,
      'data': {
        'summary': <String, dynamic>{},
        'reservation_summary': <String, dynamic>{},
        'items': <Map<String, dynamic>>[],
      },
    };
  }

  if (path.endsWith('/resident/overview')) {
    return {
      'success': true,
      'data': {
        'contracts': [
          {
            'contract_id': 'c-res-1',
            'id': 'c-res-1',
            'apartment_code': 'A-101',
            'building_name': 'Tòa Diamond',
            'status': 'ACTIVE',
            'rent_amount': 8500000,
          },
        ],
        'active_contract': {
          'contract_id': 'c-res-1',
          'id': 'c-res-1',
          'apartment_code': 'A-101',
          'building_name': 'Tòa Diamond',
          'status': 'ACTIVE',
          'rent_amount': 8500000,
        },
        'unpaid_invoices': <Map<String, dynamic>>[],
        'reservations': <Map<String, dynamic>>[],
        'contact_config': {
          'working_hours': '08:00 – 18:00',
          'technical_hotline': '1900 6868',
        },
      },
    };
  }

  if (path.endsWith('/buildings')) {
    return {
      'success': true,
      'data': [
        {'id': 'b-1', 'code': 'B01', 'name': 'Tòa Diamond', 'status': 'ACTIVE'},
        {'id': 'b-2', 'code': 'B02', 'name': 'Tòa Sapphire', 'status': 'ACTIVE'},
      ],
    };
  }

  if (path.endsWith('/buildings/policies/reservation-cancel')) {
    return {
      'success': true,
      'data': {
        'max_hold_days': 30,
        'public_max_hold_days': 7,
        'full_refund_before_days': 3,
        'partial_refund_pct': 50,
        'default_hold_amount': 2000000,
      },
    };
  }

  if (path.contains('/buildings/') && path.endsWith('/zones')) {
    final bldId = segments.length >= 2 ? segments[segments.length - 2] : 'b-1';
    return {
      'success': true,
      'data': [
        {'id': 'zone-456', 'building_id': bldId, 'code': 'Z1', 'name': 'Khu A'},
      ],
    };
  }

  if (path.contains('/buildings/') && path.endsWith('/floors')) {
    final bldId = segments.length >= 2 ? segments[segments.length - 2] : 'b-1';
    return {
      'success': true,
      'data': [
        {'id': 'f-1', 'building_id': bldId, 'level': 1, 'name': 'Tầng 1'},
      ],
    };
  }

  if (path.contains('/buildings/') && path.endsWith('/floor-map')) {
    return {
      'success': true,
      'data': [
        {
          'id': 'f-1',
          'level': 1,
          'name': 'Tầng 1',
          'apartments': <Map<String, dynamic>>[],
        },
      ],
    };
  }

  if (segments.length >= 4 &&
      segments[segments.length - 2] == 'buildings' &&
      segments.last != 'banks' &&
      segments.last != 'owners') {
    final bldId = segments.last;
    return {
      'success': true,
      'data': {
        'id': bldId,
        'code': 'B01',
        'name': 'Tòa $bldId',
        'status': 'ACTIVE',
        'total_floors': 5,
        'total_apartments': 20,
      },
    };
  }

  if (segments.length >= 4 && segments[segments.length - 2] == 'apartments') {
    final aptId = segments.last;
    return {
      'success': true,
      'data': {
        'id': aptId,
        'code': 'A-101',
        'building_id': 'b-1',
        'building_name': 'Tòa Diamond',
        'status': 'AVAILABLE',
        'type': '1PN',
        'bedrooms': 1,
        'area_m2': 45,
        'base_rent': 8500000,
        'reservations': <Map<String, dynamic>>[],
      },
    };
  }

  if (segments.length >= 4 &&
      segments[segments.length - 2] == 'contracts' &&
      segments.last != 'requests') {
    final contractId = segments.last;
    return {
      'success': true,
      'data': {
        'id': contractId,
        'contract_code': 'HD-$contractId',
        'status': 'ACTIVE',
        'apartment_id': 'apt-101',
        'apartment_code': 'A-101',
        'building_id': 'b-1',
        'building_name': 'Tòa Diamond',
        'tenant_id': 't-1',
        'tenant_name': 'Nguyễn Văn A',
        'start_date': '2026-01-01',
        'end_date': '2026-12-31',
        'rent_amount': 8500000,
        'deposit_amount': 8500000,
        'occupants': <Map<String, dynamic>>[],
        'amendments': <Map<String, dynamic>>[],
        'service_prices': <Map<String, dynamic>>[],
      },
    };
  }

  if (path.contains('/tenants/') && path.endsWith('/id-images')) {
    return {
      'success': true,
      'data': <Map<String, dynamic>>[],
      'masked_for_owner': false,
      'has_id_images': false,
    };
  }

  if (segments.length >= 4 &&
      segments[segments.length - 2] == 'tenants' &&
      segments.last != 'lookup') {
    final tenantId = segments.last;
    return {
      'success': true,
      'data': {
        'id': tenantId,
        'full_name': 'Cư dân $tenantId',
        'phone': '0901234567',
        'email': '$tenantId@resihub.vn',
        'status': 'ACTIVE',
        'contracts': <Map<String, dynamic>>[],
      },
    };
  }

  if (segments.length >= 4 &&
      segments[segments.length - 2] == 'invoices' &&
      segments.last != 'summary' &&
      segments.last != 'adjustments') {
    final invoiceId = segments.last;
    return {
      'success': true,
      'data': {
        'id': invoiceId,
        'invoice_code': 'INV-$invoiceId',
        'period': '2026-11',
        'status': 'ISSUED',
        'apartment_code': 'A-101',
        'building_name': 'Tòa Diamond',
        'tenant_name': 'Nguyễn Văn A',
        'total_amount': 9000000,
        'paid_amount': 0,
        'lines': <Map<String, dynamic>>[],
        'payments': <Map<String, dynamic>>[],
      },
    };
  }

  if (segments.length >= 4 &&
      segments[segments.length - 2] == 'service-requests' &&
      segments.last != 'assignees') {
    final srId = segments.last;
    return {
      'success': true,
      'data': {
        'id': srId,
        'code': 'SR-$srId',
        'title': 'Sự cố $srId',
        'description': 'Kiểm tra hệ thống điện',
        'category': 'ELECTRICAL',
        'priority': 'NORMAL',
        'status': 'NEW',
        'apartment_code': 'A-101',
        'building_name': 'Tòa Diamond',
        'images': <String>[],
        'audit_timeline': <Map<String, dynamic>>[],
      },
    };
  }

  if (path.endsWith('/settings')) {
    return {
      'success': true,
      'data': <String, dynamic>{},
    };
  }

  if (path.endsWith('/audit-logs')) {
    return {
      'success': true,
      'data': <Map<String, dynamic>>[],
      'pagination': {'page': 1, 'limit': 20, 'total': 0, 'totalPages': 1},
    };
  }

  // Generic fallback: collection endpoints return empty list, item endpoints return id map
  const collectionNames = {
    'apartments',
    'banks',
    'owners',
    'reservations',
    'tenants',
    'contracts',
    'requests',
    'deposits',
    'services',
    'subscriptions',
    'meters',
    'meter-readings',
    'invoices',
    'adjustments',
    'invoice-adjustments',
    'payments',
    'receivables',
    'credits',
    'overpayments',
    'service-requests',
    'assignees',
    'announcements',
    'zalo-groups',
    'users',
    'runs',
    'cron',
  };

  final lastSegment = segments.isNotEmpty ? segments.last : '';
  if (collectionNames.contains(lastSegment)) {
    return {
      'success': true,
      'data': <Map<String, dynamic>>[],
    };
  }

  return {
    'success': true,
    'data': {'id': lastSegment},
  };
}

Dio _createMockDio() {
  final dio = Dio(BaseOptions(baseUrl: 'http://localhost:3000'));
  dio.httpClientAdapter = _MockHttpClientAdapter((options) async {
    final payload = _buildMockJsonPayload(options);
    return ResponseBody.fromString(
      jsonEncode(payload),
      200,
      headers: {
        Headers.contentTypeHeader: [Headers.jsonContentType],
      },
    );
  });
  return dio;
}

UserModel _createUser(String roleCode, {String? buildingId}) {
  return UserModel(
    id: 'user-$roleCode',
    fullName: 'User $roleCode',
    email: '$roleCode@resihub.test',
    roles: [
      UserRoleModel(code: roleCode, buildingId: buildingId),
    ],
  );
}

Widget _buildTestApp({
  required ProviderContainer container,
}) {
  return UncontrolledProviderScope(
    container: container,
    child: Builder(
      builder: (context) {
        final router = container.read(appRouterProvider);
        return MaterialApp.router(
          routerConfig: router,
        );
      },
    ),
  );
}

void _configureDesktopViewport(WidgetTester tester) {
  tester.view.physicalSize = const Size(1280, 800);
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late AppStorage storage;

  setUp(() async {
    SharedPreferences.setMockInitialValues({});
    final prefs = await SharedPreferences.getInstance();
    storage = AppStorage(prefs: prefs, isWeb: true);
  });

  ProviderContainer createContainer({UserModel? user, bool isAuth = false}) {
    final mockDio = _createMockDio();
    final mockPublicDio = _createMockDio();

    final container = ProviderContainer(
      overrides: [
        appStorageProvider.overrideWithValue(storage),
        dioProvider.overrideWithValue(mockDio),
        publicDioProvider.overrideWithValue(mockPublicDio),
        buildingsServiceProvider.overrideWithValue(BuildingsService(dio: mockDio)),
      ],
    );

    if (isAuth && user != null) {
      storage.setTokens(accessToken: 'access-token', refreshToken: 'refresh-token');
      storage.setUser(user.toJson());
      container.read(authProvider.notifier).setAuthData(
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        user: user,
      );
    }

    return container;
  }

  group('1. RouterRefreshNotifier Unit Tests', () {
    test('RouterRefreshNotifier notifies only on auth or roles change', () {
      final notifier = RouterRefreshNotifier(
        isAuthenticated: false,
        roleCodes: const [],
      );

      var notifyCount = 0;
      notifier.addListener(() {
        notifyCount++;
      });

      // 1. Changing selectedBuildingId does NOT notify
      notifier.updateFromAuthState(const AuthState(
        isAuthenticated: false,
        selectedBuildingId: 'b-999',
      ));
      expect(notifyCount, 0);

      // 2. Updating user name/phone without changing roleCodes does NOT notify
      final user1 = UserModel(
        id: 'u-1',
        fullName: 'Original Name',
        roles: const [UserRoleModel(code: 'MANAGER')],
      );
      notifier.updateFromAuthState(AuthState(
        isAuthenticated: true,
        user: user1,
      ));
      expect(notifyCount, 1);

      // Same auth & same roles, but different name
      final user2 = UserModel(
        id: 'u-1',
        fullName: 'Updated Name',
        roles: const [UserRoleModel(code: 'MANAGER')],
      );
      notifier.updateFromAuthState(AuthState(
        isAuthenticated: true,
        user: user2,
      ));
      expect(notifyCount, 1);

      // Role order permutation does NOT notify
      final userOrder1 = UserModel(
        id: 'u-1',
        fullName: 'User 1',
        roles: const [UserRoleModel(code: 'OWNER'), UserRoleModel(code: 'MANAGER')],
      );
      final userOrder2 = UserModel(
        id: 'u-1',
        fullName: 'User 1',
        roles: const [UserRoleModel(code: 'MANAGER'), UserRoleModel(code: 'OWNER')],
      );
      notifier.updateFromAuthState(AuthState(isAuthenticated: true, user: userOrder1));
      expect(notifyCount, 2);

      notifier.updateFromAuthState(AuthState(isAuthenticated: true, user: userOrder2));
      expect(notifyCount, 2);

      // Logout notifies
      notifier.updateFromAuthState(const AuthState(isAuthenticated: false));
      expect(notifyCount, 3);
    });
  });

  group('2. Singleton GoRouter Provider', () {
    test('appRouterProvider provides a singleton GoRouter within the container', () {
      final container = createContainer();
      addTearDown(container.dispose);

      final router1 = container.read(appRouterProvider);
      final router2 = container.read(appRouterProvider);

      expect(identical(router1, router2), isTrue);
    });
  });

  group('3. Unauthenticated Auth Redirects', () {
    testWidgets('Unauthenticated "/" redirects to "/explore" and mounts PublicExplorePage', (tester) async {
      _configureDesktopViewport(tester);

      final container = createContainer(isAuth: false);
      addTearDown(container.dispose);

      await tester.pumpWidget(_buildTestApp(container: container));
      await tester.pumpAndSettle();

      final router = container.read(appRouterProvider);
      expect(router.state.uri.path, '/explore');
      expect(find.byType(PublicExplorePage), findsOneWidget);
    });

    testWidgets('Unauthenticated "/admin/dashboard" redirects to "/login" and mounts LoginPage', (tester) async {
      _configureDesktopViewport(tester);

      final container = createContainer(isAuth: false);
      addTearDown(container.dispose);

      await tester.pumpWidget(_buildTestApp(container: container));
      await tester.pumpAndSettle();

      final router = container.read(appRouterProvider);
      router.go('/admin/dashboard');
      await tester.pumpAndSettle();

      expect(router.state.uri.path, '/login');
      expect(find.byType(LoginPage), findsOneWidget);
    });

    testWidgets('Unauthenticated "/resident" redirects to "/login"', (tester) async {
      _configureDesktopViewport(tester);

      final container = createContainer(isAuth: false);
      addTearDown(container.dispose);

      await tester.pumpWidget(_buildTestApp(container: container));
      await tester.pumpAndSettle();

      final router = container.read(appRouterProvider);
      router.go('/resident');
      await tester.pumpAndSettle();

      expect(router.state.uri.path, '/login');
      expect(find.byType(LoginPage), findsOneWidget);
    });

    testWidgets('Unauthenticated public routes (/explore, /login, /forgot-password) mount real screens', (tester) async {
      _configureDesktopViewport(tester);

      final container = createContainer(isAuth: false);
      addTearDown(container.dispose);

      await tester.pumpWidget(_buildTestApp(container: container));
      await tester.pumpAndSettle();

      final router = container.read(appRouterProvider);

      router.go('/login?mode=otp&phone=0912345678');
      await tester.pumpAndSettle();
      expect(router.state.uri.path, '/login');
      expect(find.byType(LoginPage), findsOneWidget);
      final loginWidget = tester.widget<LoginPage>(find.byType(LoginPage));
      expect(loginWidget.initialMode, 'otp');
      expect(loginWidget.initialPhone, '0912345678');

      router.go('/forgot-password');
      await tester.pumpAndSettle();
      expect(router.state.uri.path, '/forgot-password');
      expect(find.byType(ForgotPasswordPage), findsOneWidget);

      router.go('/explore');
      await tester.pumpAndSettle();
      expect(router.state.uri.path, '/explore');
      expect(find.byType(PublicExplorePage), findsOneWidget);
    });
  });

  group('4. Authenticated Redirects (Manager vs Resident)', () {
    testWidgets('Authenticated MANAGER "/" redirects to "/admin/dashboard" and mounts DashboardPage', (tester) async {
      _configureDesktopViewport(tester);

      final manager = _createUser('MANAGER');
      final container = createContainer(user: manager, isAuth: true);
      addTearDown(container.dispose);

      await tester.pumpWidget(_buildTestApp(container: container));
      await tester.pumpAndSettle();

      final router = container.read(appRouterProvider);
      expect(router.state.uri.path, '/admin/dashboard');
      expect(find.byType(DashboardPage), findsOneWidget);
    });

    testWidgets('Authenticated RESIDENT "/" redirects to "/resident" and mounts ResidentPortalPage', (tester) async {
      _configureDesktopViewport(tester);

      final resident = _createUser('RESIDENT');
      final container = createContainer(user: resident, isAuth: true);
      addTearDown(container.dispose);

      await tester.pumpWidget(_buildTestApp(container: container));
      await tester.pumpAndSettle();

      final router = container.read(appRouterProvider);
      expect(router.state.uri.path, '/resident');
      expect(find.byType(ResidentPortalPage), findsOneWidget);
    });

    testWidgets('Authenticated MANAGER visiting "/login" redirects to "/admin/dashboard"', (tester) async {
      _configureDesktopViewport(tester);

      final manager = _createUser('MANAGER');
      final container = createContainer(user: manager, isAuth: true);
      addTearDown(container.dispose);

      await tester.pumpWidget(_buildTestApp(container: container));
      await tester.pumpAndSettle();

      final router = container.read(appRouterProvider);
      router.go('/login');
      await tester.pumpAndSettle();

      expect(router.state.uri.path, '/admin/dashboard');
      expect(find.byType(DashboardPage), findsOneWidget);
    });

    testWidgets('Authenticated RESIDENT visiting "/admin/*" redirects to "/resident"', (tester) async {
      _configureDesktopViewport(tester);

      final resident = _createUser('RESIDENT');
      final container = createContainer(user: resident, isAuth: true);
      addTearDown(container.dispose);

      await tester.pumpWidget(_buildTestApp(container: container));
      await tester.pumpAndSettle();

      final router = container.read(appRouterProvider);
      router.go('/admin/buildings');
      await tester.pumpAndSettle();

      expect(router.state.uri.path, '/resident');
      expect(find.byType(ResidentPortalPage), findsOneWidget);
    });
  });

  group('5. RoleGuard Permission Enforcement', () {
    testWidgets('MANAGER visiting "/admin/users", "/admin/settings", or "/admin/audit-logs" renders AccessDenied', (tester) async {
      _configureDesktopViewport(tester);

      final manager = _createUser('MANAGER');
      final container = createContainer(user: manager, isAuth: true);
      addTearDown(container.dispose);

      await tester.pumpWidget(_buildTestApp(container: container));
      await tester.pumpAndSettle();

      final router = container.read(appRouterProvider);

      // 1. users page
      router.go('/admin/users');
      await tester.pumpAndSettle();
      expect(find.byType(AccessDenied), findsOneWidget);
      expect(find.byType(UsersPage), findsNothing);

      // 2. settings page
      router.go('/admin/settings');
      await tester.pumpAndSettle();
      expect(find.byType(AccessDenied), findsOneWidget);
      expect(find.byType(SettingsPage), findsNothing);

      // 3. audit-logs page (only SYS_ADMIN and OWNER)
      router.go('/admin/audit-logs');
      await tester.pumpAndSettle();
      expect(find.byType(AccessDenied), findsOneWidget);
      expect(find.byType(AuditLogsPage), findsNothing);
    });

    testWidgets('OWNER visiting "/admin/audit-logs" mounts AuditLogsPage per App.jsx', (tester) async {
      _configureDesktopViewport(tester);

      final owner = _createUser('OWNER');
      final container = createContainer(user: owner, isAuth: true);
      addTearDown(container.dispose);

      await tester.pumpWidget(_buildTestApp(container: container));
      await tester.pumpAndSettle();

      final router = container.read(appRouterProvider);
      router.go('/admin/audit-logs');
      await tester.pumpAndSettle();

      expect(find.byType(AccessDenied), findsNothing);
      expect(find.byType(AuditLogsPage), findsOneWidget);
    });

    testWidgets('SYS_ADMIN visiting "/admin/users" and "/admin/settings" mounts UsersPage and SettingsPage', (tester) async {
      _configureDesktopViewport(tester);

      final admin = _createUser('SYS_ADMIN');
      final container = createContainer(user: admin, isAuth: true);
      addTearDown(container.dispose);

      await tester.pumpWidget(_buildTestApp(container: container));
      await tester.pumpAndSettle();

      final router = container.read(appRouterProvider);

      router.go('/admin/users');
      await tester.pumpAndSettle();
      expect(find.byType(AccessDenied), findsNothing);
      expect(find.byType(UsersPage), findsOneWidget);

      router.go('/admin/settings');
      await tester.pumpAndSettle();
      expect(find.byType(AccessDenied), findsNothing);
      expect(find.byType(SettingsPage), findsOneWidget);
    });
  });

  group('6. Static-Before-Dynamic Route Ordering', () {
    testWidgets('/admin/buildings/floor-plan matches FloorPlanPage, NEVER BuildingDetailPage(:id="floor-plan")', (tester) async {
      _configureDesktopViewport(tester);

      final manager = _createUser('MANAGER');
      final container = createContainer(user: manager, isAuth: true);
      addTearDown(container.dispose);

      await tester.pumpWidget(_buildTestApp(container: container));
      await tester.pumpAndSettle();

      final router = container.read(appRouterProvider);
      router.go('/admin/buildings/floor-plan?pending_confirm=1');
      await tester.pumpAndSettle();

      expect(find.byType(FloorPlanPage), findsOneWidget);
      expect(find.byType(BuildingDetailPage), findsNothing);
      final fpWidget = tester.widget<FloorPlanPage>(find.byType(FloorPlanPage));
      expect(fpWidget.buildingId, isNull);
      expect(fpWidget.highlightPendingConfirm, isTrue);

      // Verify dynamic building detail matches correctly
      router.go('/admin/buildings/bld-123');
      await tester.pumpAndSettle();
      expect(find.byType(BuildingDetailPage), findsOneWidget);
      final bldWidget = tester.widget<BuildingDetailPage>(find.byType(BuildingDetailPage));
      expect(bldWidget.key, const ValueKey('bld-123:'));
      expect(bldWidget.buildingId, 'bld-123');

      // Verify building-scoped floor-plan
      router.go('/admin/buildings/bld-123/floor-plan?pending_confirm=1');
      await tester.pumpAndSettle();
      expect(find.byType(FloorPlanPage), findsOneWidget);
      final bldFpWidget = tester.widget<FloorPlanPage>(find.byType(FloorPlanPage));
      expect(bldFpWidget.buildingId, 'bld-123');
      expect(bldFpWidget.highlightPendingConfirm, isTrue);

      // Verify zone detail
      router.go('/admin/buildings/bld-123/zones/zone-456');
      await tester.pumpAndSettle();
      expect(find.byType(ZoneDetailPage), findsOneWidget);
      final zoneWidget = tester.widget<ZoneDetailPage>(find.byType(ZoneDetailPage));
      expect(zoneWidget.key, const ValueKey('bld-123:zone-456'));
      expect(zoneWidget.buildingId, 'bld-123');
      expect(zoneWidget.zoneId, 'zone-456');
    });

    testWidgets('/admin/services/subscriptions matches SubscriptionsPage before ServiceCatalogPage', (tester) async {
      _configureDesktopViewport(tester);

      final manager = _createUser('MANAGER');
      final container = createContainer(user: manager, isAuth: true);
      addTearDown(container.dispose);

      await tester.pumpWidget(_buildTestApp(container: container));
      await tester.pumpAndSettle();

      final router = container.read(appRouterProvider);
      router.go('/admin/services/subscriptions?subscription_id=sub-9');
      await tester.pumpAndSettle();

      expect(find.byType(SubscriptionsPage), findsOneWidget);
      expect(find.byType(ServiceCatalogPage), findsNothing);
      final subsWidget = tester.widget<SubscriptionsPage>(find.byType(SubscriptionsPage));
      expect(subsWidget.initialSubscriptionId, 'sub-9');

      router.go('/admin/services');
      await tester.pumpAndSettle();
      expect(find.byType(ServiceCatalogPage), findsOneWidget);
      expect(find.byType(SubscriptionsPage), findsNothing);
    });
  });

  group('7. ValueKey Remounting on Dynamic :id Detail Routes', () {
    testWidgets('Navigating from /admin/contracts/c-1 to /admin/contracts/c-2 remounts ContractDetailPage state', (tester) async {
      _configureDesktopViewport(tester);

      final manager = _createUser('MANAGER');
      final container = createContainer(user: manager, isAuth: true);
      addTearDown(container.dispose);

      await tester.pumpWidget(_buildTestApp(container: container));
      await tester.pumpAndSettle();

      final router = container.read(appRouterProvider);
      router.go('/admin/contracts/c-1');
      await tester.pumpAndSettle();

      expect(find.byKey(const ValueKey('c-1:')), findsOneWidget);
      expect(find.byType(ContractDetailPage), findsOneWidget);
      expect(
        tester.widget<ContractDetailPage>(find.byType(ContractDetailPage)).contractId,
        'c-1',
      );
      final state1 = tester.state(find.byType(ContractDetailPage));

      // Navigate to contract c-2
      router.go('/admin/contracts/c-2');
      await tester.pumpAndSettle();

      expect(find.byKey(const ValueKey('c-1:')), findsNothing);
      expect(find.byKey(const ValueKey('c-2:')), findsOneWidget);
      final contractWidget2 = tester.widget<ContractDetailPage>(find.byType(ContractDetailPage));
      expect(contractWidget2.key, const ValueKey('c-2:'));
      expect(contractWidget2.contractId, 'c-2');
      final state2 = tester.state(find.byType(ContractDetailPage));

      // ValueKey ensures widget element & state are remounted cleanly
      expect(identical(state1, state2), isFalse);
    });
  });

  group('8. Preserving Navigation Stack on State Changes', () {
    testWidgets('Changing selectedBuildingId does NOT reset navigation route on TenantDetailPage', (tester) async {
      _configureDesktopViewport(tester);

      final manager = _createUser('MANAGER');
      final container = createContainer(user: manager, isAuth: true);
      addTearDown(container.dispose);

      await tester.pumpWidget(_buildTestApp(container: container));
      await tester.pumpAndSettle();

      final router = container.read(appRouterProvider);
      router.go('/admin/tenants/t-99');
      await tester.pumpAndSettle();

      expect(router.state.uri.path, '/admin/tenants/t-99');
      expect(find.byType(TenantDetailPage), findsOneWidget);
      expect(tester.widget<TenantDetailPage>(find.byType(TenantDetailPage)).tenantId, 't-99');

      // Change building context
      await container.read(authProvider.notifier).setSelectedBuildingId('b-2');
      await tester.pumpAndSettle();

      // Route MUST remain unchanged on /admin/tenants/t-99
      expect(router.state.uri.path, '/admin/tenants/t-99');
      expect(find.byType(TenantDetailPage), findsOneWidget);
      expect(tester.widget<TenantDetailPage>(find.byType(TenantDetailPage)).tenantId, 't-99');
    });

    testWidgets('Calling updateUser does NOT reset navigation route on InvoiceDetailPage', (tester) async {
      _configureDesktopViewport(tester);

      final manager = _createUser('MANAGER');
      final container = createContainer(user: manager, isAuth: true);
      addTearDown(container.dispose);

      await tester.pumpWidget(_buildTestApp(container: container));
      await tester.pumpAndSettle();

      final router = container.read(appRouterProvider);
      router.go('/admin/invoices/inv-555');
      await tester.pumpAndSettle();

      expect(router.state.uri.path, '/admin/invoices/inv-555');
      expect(find.byType(InvoiceDetailPage), findsOneWidget);

      // Update user phone / name
      await container.read(authProvider.notifier).updateUser({
        'phone': '0988776655',
        'full_name': 'Updated Manager Name',
      });
      await tester.pumpAndSettle();

      expect(router.state.uri.path, '/admin/invoices/inv-555');
      expect(find.byType(InvoiceDetailPage), findsOneWidget);
      expect(tester.widget<InvoiceDetailPage>(find.byType(InvoiceDetailPage)).invoiceId, 'inv-555');
    });
  });

  group('9. Deep-Link Query Parameters & Redirect Wiring', () {
    testWidgets('/admin/service-requests?request_id=sr-42 redirects to /admin/maintenance?request_id=sr-42 and mounts ServiceRequestsPage', (tester) async {
      _configureDesktopViewport(tester);

      final manager = _createUser('MANAGER');
      final container = createContainer(user: manager, isAuth: true);
      addTearDown(container.dispose);

      await tester.pumpWidget(_buildTestApp(container: container));
      await tester.pumpAndSettle();

      final router = container.read(appRouterProvider);
      router.go('/admin/service-requests?request_id=sr-42');
      await tester.pumpAndSettle();

      expect(router.state.uri.toString(), '/admin/maintenance?request_id=sr-42');
      expect(find.byType(ServiceRequestsPage), findsOneWidget);
      final srPage = tester.widget<ServiceRequestsPage>(find.byType(ServiceRequestsPage));
      expect(srPage.initialRequestId, 'sr-42');
    });

    testWidgets('/resident forwards all 7 deep-link query parameters to ResidentPortalPage', (tester) async {
      _configureDesktopViewport(tester);

      final resident = _createUser('RESIDENT');
      final container = createContainer(user: resident, isAuth: true);
      addTearDown(container.dispose);

      await tester.pumpWidget(_buildTestApp(container: container));
      await tester.pumpAndSettle();

      final router = container.read(appRouterProvider);
      router.go(
        '/resident?tab=invoices&contract_id=c-10&target_contract_id=c-20&action=pay&invoice_id=inv-88&request_id=sr-77&modal=detail',
      );
      await tester.pumpAndSettle();

      expect(find.byType(ResidentPortalPage), findsOneWidget);
      final portal = tester.widget<ResidentPortalPage>(find.byType(ResidentPortalPage));
      expect(portal.initialTab, 'invoices');
      expect(portal.contractId, 'c-10');
      expect(portal.targetContractId, 'c-20');
      expect(portal.action, 'pay');
      expect(portal.invoiceId, 'inv-88');
      expect(portal.requestId, 'sr-77');
      expect(portal.modal, 'detail');
    });

    testWidgets('Remaining admin feature routes mount real pages with deep-link query params', (tester) async {
      _configureDesktopViewport(tester);

      final manager = _createUser('MANAGER');
      final container = createContainer(user: manager, isAuth: true);
      addTearDown(container.dispose);

      await tester.pumpWidget(_buildTestApp(container: container));
      await tester.pumpAndSettle();

      final router = container.read(appRouterProvider);

      router.go('/admin/buildings');
      await tester.pumpAndSettle();
      expect(find.byType(BuildingsPage), findsOneWidget);

      router.go('/admin/apartments/apt-77?reservation_id=res-5');
      await tester.pumpAndSettle();
      expect(find.byType(ApartmentDetailPage), findsOneWidget);
      final aptPage = tester.widget<ApartmentDetailPage>(find.byType(ApartmentDetailPage));
      expect(aptPage.key, const ValueKey('apt-77:'));
      expect(aptPage.apartmentId, 'apt-77');
      expect(aptPage.initialReservationId, 'res-5');

      router.go('/admin/tenants');
      await tester.pumpAndSettle();
      expect(find.byType(TenantsPage), findsOneWidget);

      router.go('/admin/contracts?tab=requests');
      await tester.pumpAndSettle();
      expect(find.byType(ContractsPage), findsOneWidget);
      expect(tester.widget<ContractsPage>(find.byType(ContractsPage)).initialTab, 'requests');

      router.go('/admin/deposits?deposit_id=dep-11');
      await tester.pumpAndSettle();
      expect(find.byType(DepositsPage), findsOneWidget);
      expect(tester.widget<DepositsPage>(find.byType(DepositsPage)).initialDepositId, 'dep-11');

      router.go('/admin/meters?meter_id=m-22');
      await tester.pumpAndSettle();
      expect(find.byType(MeterReadingsPage), findsOneWidget);
      expect(tester.widget<MeterReadingsPage>(find.byType(MeterReadingsPage)).initialMeterId, 'm-22');

      router.go('/admin/invoices');
      await tester.pumpAndSettle();
      expect(find.byType(InvoicesPage), findsOneWidget);

      router.go('/admin/payments?tab=aging&bucket=over_60&payment_id=pay-33');
      await tester.pumpAndSettle();
      expect(find.byType(PaymentsPage), findsOneWidget);
      final payPage = tester.widget<PaymentsPage>(find.byType(PaymentsPage));
      expect(payPage.initialTab, 'aging');
      expect(payPage.initialBucket, 'over_60');
      expect(payPage.initialPaymentId, 'pay-33');

      router.go('/admin/notifications?tab=zalo');
      await tester.pumpAndSettle();
      expect(find.byType(NotificationsPage), findsOneWidget);
      expect(tester.widget<NotificationsPage>(find.byType(NotificationsPage)).initialTab, 'zalo');

      router.go('/admin/reports?tab=aging');
      await tester.pumpAndSettle();
      expect(find.byType(ReportsPage), findsOneWidget);
      expect(tester.widget<ReportsPage>(find.byType(ReportsPage)).initialTab, 'aging');
    });
  });
}
