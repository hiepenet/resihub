import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:flutter_resihub/core/storage/app_storage.dart';
import 'package:flutter_resihub/features/auth/models/user_model.dart';
import 'package:flutter_resihub/features/auth/providers/auth_provider.dart';
import 'package:flutter_resihub/features/auth/services/auth_service.dart';
import 'package:flutter_resihub/features/buildings/services/buildings_service.dart';
import 'package:flutter_resihub/features/notifications/services/notifications_service.dart';
import 'package:flutter_resihub/router/app_router.dart';
import 'package:flutter_resihub/router/route_guards.dart';
import 'package:flutter_resihub/shared/widgets/common/access_denied.dart';

class _FakeNotificationsService extends Fake implements NotificationsService {
  @override
  Future<dynamic> list() async {
    return {
      'data': <Map<String, dynamic>>[],
      'unread_count': 0,
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
    return {'profile': <String, dynamic>{}};
  }

  @override
  Future<dynamic> logout() async {
    return {'success': true};
  }
}

class _FakeBuildingsService extends Fake implements BuildingsService {
  @override
  Future<dynamic> list({bool force = false}) async {
    return {
      'data': [
        {'id': 'b-1', 'code': 'B01', 'name': 'Tòa Diamond'},
        {'id': 'b-2', 'code': 'B02', 'name': 'Tòa Sapphire'},
      ],
    };
  }
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

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late AppStorage storage;

  setUp(() async {
    SharedPreferences.setMockInitialValues({});
    final prefs = await SharedPreferences.getInstance();
    storage = AppStorage(prefs: prefs, isWeb: true);
  });

  ProviderContainer createContainer({UserModel? user, bool isAuth = false}) {
    final container = ProviderContainer(
      overrides: [
        appStorageProvider.overrideWithValue(storage),
        notificationsServiceProvider.overrideWithValue(_FakeNotificationsService()),
        authServiceProvider.overrideWithValue(_FakeAuthService()),
        buildingsServiceProvider.overrideWithValue(_FakeBuildingsService()),
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
      expect(notifyCount, 1); // isAuthenticated changed (false -> true) and roleCodes changed

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
      expect(notifyCount, 1); // NO extra notification

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
      expect(notifyCount, 2); // roleCodes changed to [MANAGER, OWNER]

      notifier.updateFromAuthState(AuthState(isAuthenticated: true, user: userOrder2));
      expect(notifyCount, 2); // identical sorted roles, NO extra notification

      // Logout notifies
      notifier.updateFromAuthState(const AuthState(isAuthenticated: false));
      expect(notifyCount, 3);
    });
  });

  group('2. Singleton GoRouter Provider', () {
    test('appRouterProvider provides a singleton GoRouter within the container', () {
      final container = createContainer();
      final router1 = container.read(appRouterProvider);
      final router2 = container.read(appRouterProvider);

      expect(identical(router1, router2), isTrue);
      container.dispose();
    });
  });

  group('3. Unauthenticated Auth Redirects', () {
    testWidgets('Unauthenticated "/" redirects to "/explore"', (tester) async {
      tester.view.physicalSize = const Size(1280, 800);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);

      final container = createContainer(isAuth: false);
      await tester.pumpWidget(_buildTestApp(container: container));
      await tester.pumpAndSettle();

      final router = container.read(appRouterProvider);
      expect(router.state.uri.path, '/explore');
      expect(find.text('Route: /explore'), findsOneWidget);
    });

    testWidgets('Unauthenticated "/admin/dashboard" redirects to "/login"', (tester) async {
      tester.view.physicalSize = const Size(1280, 800);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);

      final container = createContainer(isAuth: false);
      await tester.pumpWidget(_buildTestApp(container: container));
      await tester.pumpAndSettle();

      final router = container.read(appRouterProvider);
      router.go('/admin/dashboard');
      await tester.pumpAndSettle();

      expect(router.state.uri.path, '/login');
      expect(find.text('Route: /login'), findsOneWidget);
    });

    testWidgets('Unauthenticated "/resident" redirects to "/login"', (tester) async {
      tester.view.physicalSize = const Size(1280, 800);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);

      final container = createContainer(isAuth: false);
      await tester.pumpWidget(_buildTestApp(container: container));
      await tester.pumpAndSettle();

      final router = container.read(appRouterProvider);
      router.go('/resident');
      await tester.pumpAndSettle();

      expect(router.state.uri.path, '/login');
    });

    testWidgets('Unauthenticated public routes (/explore, /login, /forgot-password) allowed', (tester) async {
      tester.view.physicalSize = const Size(1280, 800);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);

      final container = createContainer(isAuth: false);
      await tester.pumpWidget(_buildTestApp(container: container));
      await tester.pumpAndSettle();

      final router = container.read(appRouterProvider);

      router.go('/login');
      await tester.pumpAndSettle();
      expect(router.state.uri.path, '/login');
      expect(find.text('Route: /login'), findsOneWidget);

      router.go('/forgot-password');
      await tester.pumpAndSettle();
      expect(router.state.uri.path, '/forgot-password');
      expect(find.text('Route: /forgot-password'), findsOneWidget);

      router.go('/explore');
      await tester.pumpAndSettle();
      expect(router.state.uri.path, '/explore');
      expect(find.text('Route: /explore'), findsOneWidget);
    });
  });

  group('4. Authenticated Redirects (Manager vs Resident)', () {
    testWidgets('Authenticated MANAGER "/" redirects to "/admin/dashboard"', (tester) async {
      tester.view.physicalSize = const Size(1280, 800);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);

      final manager = _createUser('MANAGER');
      final container = createContainer(user: manager, isAuth: true);

      await tester.pumpWidget(_buildTestApp(container: container));
      await tester.pumpAndSettle();

      final router = container.read(appRouterProvider);
      expect(router.state.uri.path, '/admin/dashboard');
      expect(find.text('Route: /admin/dashboard'), findsOneWidget);
    });

    testWidgets('Authenticated RESIDENT "/" redirects to "/resident"', (tester) async {
      tester.view.physicalSize = const Size(1280, 800);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);

      final resident = _createUser('RESIDENT');
      final container = createContainer(user: resident, isAuth: true);

      await tester.pumpWidget(_buildTestApp(container: container));
      await tester.pumpAndSettle();

      final router = container.read(appRouterProvider);
      expect(router.state.uri.path, '/resident');
      expect(find.text('Route: /resident'), findsOneWidget);
    });

    testWidgets('Authenticated MANAGER visiting "/login" redirects to "/admin/dashboard"', (tester) async {
      tester.view.physicalSize = const Size(1280, 800);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);

      final manager = _createUser('MANAGER');
      final container = createContainer(user: manager, isAuth: true);

      await tester.pumpWidget(_buildTestApp(container: container));
      await tester.pumpAndSettle();

      final router = container.read(appRouterProvider);
      router.go('/login');
      await tester.pumpAndSettle();

      expect(router.state.uri.path, '/admin/dashboard');
    });

    testWidgets('Authenticated RESIDENT visiting "/admin/*" redirects to "/resident"', (tester) async {
      tester.view.physicalSize = const Size(1280, 800);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);

      final resident = _createUser('RESIDENT');
      final container = createContainer(user: resident, isAuth: true);

      await tester.pumpWidget(_buildTestApp(container: container));
      await tester.pumpAndSettle();

      final router = container.read(appRouterProvider);
      router.go('/admin/buildings');
      await tester.pumpAndSettle();

      expect(router.state.uri.path, '/resident');
    });
  });

  group('5. RoleGuard Permission Enforcement', () {
    testWidgets('MANAGER visiting "/admin/users" or "/admin/settings" renders AccessDenied', (tester) async {
      tester.view.physicalSize = const Size(1280, 800);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);

      final manager = _createUser('MANAGER');
      final container = createContainer(user: manager, isAuth: true);

      await tester.pumpWidget(_buildTestApp(container: container));
      await tester.pumpAndSettle();

      final router = container.read(appRouterProvider);

      // 1. users page
      router.go('/admin/users');
      await tester.pumpAndSettle();
      expect(find.byType(AccessDenied), findsOneWidget);
      expect(find.text('Route: /admin/users'), findsNothing);

      // 2. settings page
      router.go('/admin/settings');
      await tester.pumpAndSettle();
      expect(find.byType(AccessDenied), findsOneWidget);
      expect(find.text('Route: /admin/settings'), findsNothing);

      // 3. audit-logs page (only SYS_ADMIN and OWNER)
      router.go('/admin/audit-logs');
      await tester.pumpAndSettle();
      expect(find.byType(AccessDenied), findsOneWidget);
    });

    testWidgets('OWNER visiting "/admin/audit-logs" succeeds per App.jsx', (tester) async {
      tester.view.physicalSize = const Size(1280, 800);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);

      final owner = _createUser('OWNER');
      final container = createContainer(user: owner, isAuth: true);

      await tester.pumpWidget(_buildTestApp(container: container));
      await tester.pumpAndSettle();

      final router = container.read(appRouterProvider);
      router.go('/admin/audit-logs');
      await tester.pumpAndSettle();

      expect(find.byType(AccessDenied), findsNothing);
      expect(find.text('Route: /admin/audit-logs'), findsOneWidget);
    });

    testWidgets('SYS_ADMIN visiting "/admin/users" and "/admin/settings" succeeds', (tester) async {
      tester.view.physicalSize = const Size(1280, 800);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);

      final admin = _createUser('SYS_ADMIN');
      final container = createContainer(user: admin, isAuth: true);

      await tester.pumpWidget(_buildTestApp(container: container));
      await tester.pumpAndSettle();

      final router = container.read(appRouterProvider);

      router.go('/admin/users');
      await tester.pumpAndSettle();
      expect(find.byType(AccessDenied), findsNothing);
      expect(find.text('Route: /admin/users'), findsOneWidget);

      router.go('/admin/settings');
      await tester.pumpAndSettle();
      expect(find.byType(AccessDenied), findsNothing);
      expect(find.text('Route: /admin/settings'), findsOneWidget);
    });
  });

  group('6. Static-Before-Dynamic Route Ordering', () {
    testWidgets('/admin/buildings/floor-plan matches floor-plan, NEVER :id="floor-plan"', (tester) async {
      tester.view.physicalSize = const Size(1280, 800);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);

      final manager = _createUser('MANAGER');
      final container = createContainer(user: manager, isAuth: true);

      await tester.pumpWidget(_buildTestApp(container: container));
      await tester.pumpAndSettle();

      final router = container.read(appRouterProvider);
      router.go('/admin/buildings/floor-plan');
      await tester.pumpAndSettle();

      expect(find.text('Route: /admin/buildings/floor-plan'), findsOneWidget);
      expect(find.text('Route: /admin/buildings/:id'), findsNothing);

      // Now verify dynamic building detail matches correctly
      router.go('/admin/buildings/bld-123');
      await tester.pumpAndSettle();
      expect(find.text('Route: /admin/buildings/:id'), findsOneWidget);
      expect(find.text('Params: {id: bld-123}'), findsOneWidget);

      // Verify zone detail
      router.go('/admin/buildings/bld-123/zones/zone-456');
      await tester.pumpAndSettle();
      expect(find.text('Route: /admin/buildings/:id/zones/:zoneId'), findsOneWidget);
      expect(find.text('Params: {id: bld-123, zoneId: zone-456}'), findsOneWidget);
    });

    testWidgets('/admin/services/subscriptions matches static route before dynamic services', (tester) async {
      tester.view.physicalSize = const Size(1280, 800);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);

      final manager = _createUser('MANAGER');
      final container = createContainer(user: manager, isAuth: true);

      await tester.pumpWidget(_buildTestApp(container: container));
      await tester.pumpAndSettle();

      final router = container.read(appRouterProvider);
      router.go('/admin/services/subscriptions');
      await tester.pumpAndSettle();

      expect(find.text('Route: /admin/services/subscriptions'), findsOneWidget);

      router.go('/admin/services');
      await tester.pumpAndSettle();
      expect(find.text('Route: /admin/services'), findsOneWidget);
    });
  });

  group('7. ValueKey Remounting on Dynamic :id Detail Routes', () {
    testWidgets('Navigating from /admin/contracts/c-1 to /admin/contracts/c-2 remounts widget state', (tester) async {
      tester.view.physicalSize = const Size(1280, 800);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);

      final manager = _createUser('MANAGER');
      final container = createContainer(user: manager, isAuth: true);

      await tester.pumpWidget(_buildTestApp(container: container));
      await tester.pumpAndSettle();

      final router = container.read(appRouterProvider);
      router.go('/admin/contracts/c-1');
      await tester.pumpAndSettle();

      expect(find.byKey(const ValueKey('c-1:')), findsOneWidget);
      expect(find.text('Params: {id: c-1}'), findsOneWidget);
      final mountText1 = tester.widget<Text>(find.byWidgetPredicate(
        (w) => w is Text && (w.data?.startsWith('Mount: ') ?? false),
      )).data;

      // Navigate to contract c-2
      router.go('/admin/contracts/c-2');
      await tester.pumpAndSettle();

      expect(find.byKey(const ValueKey('c-1:')), findsNothing);
      expect(find.byKey(const ValueKey('c-2:')), findsOneWidget);
      expect(find.text('Params: {id: c-2}'), findsOneWidget);
      final mountText2 = tester.widget<Text>(find.byWidgetPredicate(
        (w) => w is Text && (w.data?.startsWith('Mount: ') ?? false),
      )).data;

      // ValueKey ensures widget element is remounted cleanly
      expect(mountText1, isNot(equals(mountText2)));
    });
  });

  group('8. Preserving Navigation Stack on State Changes', () {
    testWidgets('Changing selectedBuildingId does NOT reset navigation route', (tester) async {
      tester.view.physicalSize = const Size(1280, 800);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);

      final manager = _createUser('MANAGER');
      final container = createContainer(user: manager, isAuth: true);

      await tester.pumpWidget(_buildTestApp(container: container));
      await tester.pumpAndSettle();

      final router = container.read(appRouterProvider);
      router.go('/admin/tenants/t-99');
      await tester.pumpAndSettle();

      expect(router.state.uri.path, '/admin/tenants/t-99');
      expect(find.text('Params: {id: t-99}'), findsOneWidget);

      // Change building context
      await container.read(authProvider.notifier).setSelectedBuildingId('b-2');
      await tester.pumpAndSettle();

      // Route MUST remain unchanged on /admin/tenants/t-99
      expect(router.state.uri.path, '/admin/tenants/t-99');
      expect(find.text('Params: {id: t-99}'), findsOneWidget);
    });

    testWidgets('Calling updateUser does NOT reset navigation route', (tester) async {
      tester.view.physicalSize = const Size(1280, 800);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);

      final manager = _createUser('MANAGER');
      final container = createContainer(user: manager, isAuth: true);

      await tester.pumpWidget(_buildTestApp(container: container));
      await tester.pumpAndSettle();

      final router = container.read(appRouterProvider);
      router.go('/admin/invoices/inv-555');
      await tester.pumpAndSettle();

      expect(router.state.uri.path, '/admin/invoices/inv-555');

      // Update user phone / name
      await container.read(authProvider.notifier).updateUser({
        'phone': '0988776655',
        'full_name': 'Updated Manager Name',
      });
      await tester.pumpAndSettle();

      expect(router.state.uri.path, '/admin/invoices/inv-555');
      expect(find.text('Params: {id: inv-555}'), findsOneWidget);
    });
  });
}
