import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:flutter_resihub/app.dart';
import 'package:flutter_resihub/core/constants/roles.dart';
import 'package:flutter_resihub/core/network/dio_client.dart';
import 'package:flutter_resihub/core/storage/app_storage.dart';
import 'package:flutter_resihub/core/theme/app_colors.dart';
import 'package:flutter_resihub/features/auth/providers/auth_provider.dart';
import 'package:flutter_resihub/features/auth/screens/login_page.dart';
import 'package:flutter_resihub/features/buildings/services/buildings_service.dart';
import 'package:flutter_resihub/features/public/screens/public_explore_page.dart';
import 'package:flutter_resihub/features/reports/screens/dashboard_page.dart';
import 'package:flutter_resihub/features/resident/screens/resident_portal_page.dart';
import 'package:flutter_resihub/shared/providers/toast_provider.dart';
import 'package:flutter_resihub/shared/widgets/ui/app_toast_overlay.dart';

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

Map<String, dynamic> _buildMockBootPayload(RequestOptions options) {
  final path = options.path;

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

  if (path.endsWith('/notifications')) {
    return {
      'success': true,
      'data': <Map<String, dynamic>>[],
      'sent_history': <Map<String, dynamic>>[],
      'unread_count': 0,
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

  if (path.endsWith('/auth/profile')) {
    return {'success': true, 'profile': <String, dynamic>{}};
  }

  if (path.endsWith('/auth/me')) {
    return {'success': true, 'user': <String, dynamic>{}};
  }

  return {
    'success': true,
    'data': <Map<String, dynamic>>[],
  };
}

Dio _createMockDio() {
  final dio = Dio(BaseOptions(baseUrl: 'http://localhost:3000'));
  dio.httpClientAdapter = _MockHttpClientAdapter((options) async {
    final payload = _buildMockBootPayload(options);
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

ProviderContainer _createBootContainer(AppStorage storage) {
  final mockDio = _createMockDio();
  final mockPublicDio = _createMockDio();

  return ProviderContainer(
    overrides: [
      appStorageProvider.overrideWithValue(storage),
      dioProvider.overrideWithValue(mockDio),
      publicDioProvider.overrideWithValue(mockPublicDio),
      buildingsServiceProvider.overrideWithValue(BuildingsService(dio: mockDio)),
    ],
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

  group('Task 10: ResiHubApp Boot & Configuration Tests', () {
    testWidgets('1. MaterialApp configuration & theme setup', (tester) async {
      _configureDesktopViewport(tester);

      SharedPreferences.setMockInitialValues({});
      final prefs = await SharedPreferences.getInstance();
      final storage = AppStorage(prefs: prefs, isWeb: true);
      await storage.init();

      final container = _createBootContainer(storage);
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

    testWidgets('2. Booting unauthenticated navigates to /explore and mounts PublicExplorePage', (tester) async {
      _configureDesktopViewport(tester);

      SharedPreferences.setMockInitialValues({});
      final prefs = await SharedPreferences.getInstance();
      final storage = AppStorage(prefs: prefs, isWeb: true);
      await storage.init();

      final container = _createBootContainer(storage);
      addTearDown(container.dispose);

      container.read(authProvider);

      await tester.pumpWidget(
        UncontrolledProviderScope(
          container: container,
          child: const ResiHubApp(),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.byType(PublicExplorePage), findsOneWidget);
      expect(find.byType(LoginPage), findsNothing);
    });

    testWidgets(
      '3. Booting with hydrated MANAGER session boots directly into /admin/dashboard without flashing /login',
      (tester) async {
        _configureDesktopViewport(tester);

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

        final container = _createBootContainer(storage);
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

        expect(find.byType(DashboardPage), findsOneWidget);
        expect(find.byType(LoginPage), findsNothing);
      },
    );

    testWidgets(
      '4. Booting with hydrated SYS_ADMIN session boots directly into /admin/dashboard',
      (tester) async {
        _configureDesktopViewport(tester);

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

        final container = _createBootContainer(storage);
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

        expect(find.byType(DashboardPage), findsOneWidget);
        expect(find.byType(LoginPage), findsNothing);
      },
    );

    testWidgets(
      '5. Booting with hydrated RESIDENT session boots directly into /resident',
      (tester) async {
        _configureDesktopViewport(tester);

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

        final container = _createBootContainer(storage);
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

        expect(find.byType(ResidentPortalPage), findsOneWidget);
        expect(find.byType(LoginPage), findsNothing);
      },
    );

    testWidgets(
      '6. AppToastOverlay renders toast messages emitted via toastProvider on top of routed pages',
      (tester) async {
        _configureDesktopViewport(tester);

        SharedPreferences.setMockInitialValues({});
        final prefs = await SharedPreferences.getInstance();
        final storage = AppStorage(prefs: prefs, isWeb: true);
        await storage.init();

        final container = _createBootContainer(storage);
        addTearDown(container.dispose);

        container.read(authProvider);

        await tester.pumpWidget(
          UncontrolledProviderScope(
            container: container,
            child: const ResiHubApp(),
          ),
        );
        await tester.pumpAndSettle();

        // Baseline: PublicExplorePage is rendered, no toast
        expect(find.byType(PublicExplorePage), findsOneWidget);
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
        expect(find.byType(PublicExplorePage), findsOneWidget);

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
