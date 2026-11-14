import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:flutter_resihub/app.dart';
import 'package:flutter_resihub/core/constants/roles.dart';
import 'package:flutter_resihub/core/storage/app_storage.dart';
import 'package:flutter_resihub/core/theme/app_colors.dart';
import 'package:flutter_resihub/features/auth/providers/auth_provider.dart';
import 'package:flutter_resihub/features/auth/services/auth_service.dart';
import 'package:flutter_resihub/features/buildings/services/buildings_service.dart';
import 'package:flutter_resihub/features/notifications/services/notifications_service.dart';
import 'package:flutter_resihub/shared/providers/toast_provider.dart';
import 'package:flutter_resihub/shared/widgets/ui/app_toast_overlay.dart';

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
  Future<dynamic> me() async {
    return {'user': <String, dynamic>{}};
  }

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

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('Task 10: ResiHubApp Boot & Configuration Tests', () {
    testWidgets('1. MaterialApp configuration & theme setup', (tester) async {
      SharedPreferences.setMockInitialValues({});
      final prefs = await SharedPreferences.getInstance();
      final storage = AppStorage(prefs: prefs, isWeb: true);
      await storage.init();

      final container = ProviderContainer(
        overrides: [
          appStorageProvider.overrideWithValue(storage),
          notificationsServiceProvider.overrideWithValue(_FakeNotificationsService()),
          authServiceProvider.overrideWithValue(_FakeAuthService()),
          buildingsServiceProvider.overrideWithValue(_FakeBuildingsService()),
        ],
      );
      addTearDown(container.dispose);

      // Hydrate auth synchronously before first route evaluation
      container.read(authProvider);

      await tester.pumpWidget(
        UncontrolledProviderScope(
          container: container,
          child: const ResiHubApp(),
        ),
      );
      await tester.pumpAndSettle();

      final materialApp = tester.widget<MaterialApp>(find.byType(MaterialApp));
      expect(materialApp.title, equals('ResiHub'));
      expect(materialApp.debugShowCheckedModeBanner, isFalse);
      expect(materialApp.theme?.colorScheme.primary, equals(AppColors.primary500));
      expect(materialApp.theme?.useMaterial3, isTrue);

      // Locales
      expect(
        materialApp.supportedLocales,
        containsAll([const Locale('vi', 'VN'), const Locale('en', 'US')]),
      );

      // Root AppToastOverlay
      expect(find.byType(AppToastOverlay), findsOneWidget);
    });

    testWidgets('2. Booting unauthenticated navigates to /explore', (tester) async {
      SharedPreferences.setMockInitialValues({});
      final prefs = await SharedPreferences.getInstance();
      final storage = AppStorage(prefs: prefs, isWeb: true);
      await storage.init();

      final container = ProviderContainer(
        overrides: [
          appStorageProvider.overrideWithValue(storage),
          notificationsServiceProvider.overrideWithValue(_FakeNotificationsService()),
          authServiceProvider.overrideWithValue(_FakeAuthService()),
          buildingsServiceProvider.overrideWithValue(_FakeBuildingsService()),
        ],
      );
      addTearDown(container.dispose);

      container.read(authProvider);

      await tester.pumpWidget(
        UncontrolledProviderScope(
          container: container,
          child: const ResiHubApp(),
        ),
      );
      await tester.pumpAndSettle();

      // Expect explore route placeholder
      expect(find.text('Khám phá ResiHub'), findsOneWidget);
      expect(find.text('Route: /explore'), findsOneWidget);
      expect(find.text('Đăng nhập'), findsNothing);
    });

    testWidgets(
      '3. Booting with hydrated MANAGER session boots directly into /admin/dashboard without flashing /login',
      (tester) async {
        final userMap = {
          'id': 'user-manager-1',
          'fullName': 'Quản lý Nguyễn',
          'email': 'manager@resihub.test',
          'role': 'MANAGER',
          'roles': [
            {'code': 'MANAGER', 'buildingId': 'b-1'}
          ],
        };

        SharedPreferences.setMockInitialValues({
          'accessToken': 'valid-manager-access-token',
          'refreshToken': 'valid-manager-refresh-token',
          'user': jsonEncode(userMap),
          'selectedBuildingId': 'b-1',
        });

        final prefs = await SharedPreferences.getInstance();
        final storage = AppStorage(prefs: prefs, isWeb: true);
        await storage.init();

        final container = ProviderContainer(
          overrides: [
            appStorageProvider.overrideWithValue(storage),
            notificationsServiceProvider.overrideWithValue(_FakeNotificationsService()),
            authServiceProvider.overrideWithValue(_FakeAuthService()),
            buildingsServiceProvider.overrideWithValue(_FakeBuildingsService()),
          ],
        );
        addTearDown(container.dispose);

        // Pre-runApp hydration
        final initialAuth = container.read(authProvider);
        expect(initialAuth.isAuthenticated, isTrue);
        expect(initialAuth.primaryRole, equals(AppRole.manager));

        await tester.pumpWidget(
          UncontrolledProviderScope(
            container: container,
            child: const ResiHubApp(),
          ),
        );
        await tester.pumpAndSettle();

        // Expect admin dashboard route placeholder
        expect(find.text('Bảng điều khiển'), findsOneWidget);
        expect(find.text('Route: /admin/dashboard'), findsOneWidget);
        expect(find.text('Đăng nhập'), findsNothing);
      },
    );

    testWidgets(
      '4. Booting with hydrated SYS_ADMIN session boots directly into /admin/dashboard',
      (tester) async {
        final userMap = {
          'id': 'user-sysadmin-1',
          'fullName': 'Admin Trần',
          'email': 'admin@resihub.test',
          'role': 'SYS_ADMIN',
          'roles': [
            {'code': 'SYS_ADMIN'}
          ],
        };

        SharedPreferences.setMockInitialValues({
          'accessToken': 'valid-admin-access-token',
          'refreshToken': 'valid-admin-refresh-token',
          'user': jsonEncode(userMap),
        });

        final prefs = await SharedPreferences.getInstance();
        final storage = AppStorage(prefs: prefs, isWeb: true);
        await storage.init();

        final container = ProviderContainer(
          overrides: [
            appStorageProvider.overrideWithValue(storage),
            notificationsServiceProvider.overrideWithValue(_FakeNotificationsService()),
            authServiceProvider.overrideWithValue(_FakeAuthService()),
            buildingsServiceProvider.overrideWithValue(_FakeBuildingsService()),
          ],
        );
        addTearDown(container.dispose);

        final initialAuth = container.read(authProvider);
        expect(initialAuth.isAuthenticated, isTrue);
        expect(initialAuth.isAdminPortal, isTrue);

        await tester.pumpWidget(
          UncontrolledProviderScope(
            container: container,
            child: const ResiHubApp(),
          ),
        );
        await tester.pumpAndSettle();

        expect(find.text('Bảng điều khiển'), findsOneWidget);
        expect(find.text('Route: /admin/dashboard'), findsOneWidget);
        expect(find.text('Đăng nhập'), findsNothing);
      },
    );

    testWidgets(
      '5. Booting with hydrated RESIDENT session boots directly into /resident',
      (tester) async {
        final userMap = {
          'id': 'user-resident-1',
          'fullName': 'Cư dân Lê',
          'email': 'resident@resihub.test',
          'role': 'RESIDENT',
          'roles': [
            {'code': 'RESIDENT'}
          ],
        };

        SharedPreferences.setMockInitialValues({
          'accessToken': 'valid-resident-access-token',
          'refreshToken': 'valid-resident-refresh-token',
          'user': jsonEncode(userMap),
        });

        final prefs = await SharedPreferences.getInstance();
        final storage = AppStorage(prefs: prefs, isWeb: true);
        await storage.init();

        final container = ProviderContainer(
          overrides: [
            appStorageProvider.overrideWithValue(storage),
            notificationsServiceProvider.overrideWithValue(_FakeNotificationsService()),
            authServiceProvider.overrideWithValue(_FakeAuthService()),
            buildingsServiceProvider.overrideWithValue(_FakeBuildingsService()),
          ],
        );
        addTearDown(container.dispose);

        final initialAuth = container.read(authProvider);
        expect(initialAuth.isAuthenticated, isTrue);
        expect(initialAuth.primaryRole, equals(AppRole.resident));

        await tester.pumpWidget(
          UncontrolledProviderScope(
            container: container,
            child: const ResiHubApp(),
          ),
        );
        await tester.pumpAndSettle();

        expect(find.text('Cổng cư dân'), findsOneWidget);
        expect(find.text('Route: /resident'), findsOneWidget);
        expect(find.text('Đăng nhập'), findsNothing);
      },
    );

    testWidgets(
      '6. AppToastOverlay renders toast messages emitted via toastProvider on top of routed pages',
      (tester) async {
        SharedPreferences.setMockInitialValues({});
        final prefs = await SharedPreferences.getInstance();
        final storage = AppStorage(prefs: prefs, isWeb: true);
        await storage.init();

        final container = ProviderContainer(
          overrides: [
            appStorageProvider.overrideWithValue(storage),
            notificationsServiceProvider.overrideWithValue(_FakeNotificationsService()),
            authServiceProvider.overrideWithValue(_FakeAuthService()),
            buildingsServiceProvider.overrideWithValue(_FakeBuildingsService()),
          ],
        );
        addTearDown(container.dispose);

        container.read(authProvider);

        await tester.pumpWidget(
          UncontrolledProviderScope(
            container: container,
            child: const ResiHubApp(),
          ),
        );
        await tester.pumpAndSettle();

        // Baseline: page is rendered, no toast
        expect(find.text('Khám phá ResiHub'), findsOneWidget);
        expect(find.text('Lưu dữ liệu thành công!'), findsNothing);

        // Emit toast
        container.read(toastProvider.notifier).success(
              'Lưu dữ liệu thành công!',
              title: 'Thành công',
            );
        await tester.pump();

        // Toast is now displayed on top of page
        expect(find.text('Thành công'), findsOneWidget);
        expect(find.text('Lưu dữ liệu thành công!'), findsOneWidget);
        expect(find.text('Khám phá ResiHub'), findsOneWidget);

        // Tap dismiss button on toast
        final dismissBtn = find.byKey(const Key('toast_dismiss_button'));
        expect(dismissBtn, findsOneWidget);
        await tester.tap(dismissBtn);
        await tester.pump();

        // Toast dismissed
        expect(find.text('Thành công'), findsNothing);
        expect(find.text('Lưu dữ liệu thành công!'), findsNothing);
      },
    );
  });
}
