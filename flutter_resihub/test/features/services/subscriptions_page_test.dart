import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:flutter_resihub/core/network/dio_client.dart';
import 'package:flutter_resihub/core/network/query_cache.dart';
import 'package:flutter_resihub/core/storage/app_storage.dart';
import 'package:flutter_resihub/features/auth/models/user_model.dart';
import 'package:flutter_resihub/features/auth/providers/auth_provider.dart';
import 'package:flutter_resihub/features/buildings/services/buildings_service.dart';
import 'package:flutter_resihub/features/services/screens/subscriptions_page.dart';
import 'package:flutter_resihub/features/services/services/services_service.dart';
import 'package:flutter_resihub/shared/widgets/ui/app_input.dart';

class _RecordingServicesService extends Fake implements ServicesService {
  final List<Map<String, dynamic>> rows;
  final List<Map<String, dynamic>> catalog;
  _RecordingServicesService(this.rows, this.catalog);

  String? lastUpdateId;
  Map<String, dynamic>? lastUpdatePayload;
  String? lastTerminateId;
  Map<String, dynamic>? lastTerminatePayload;
  Map<String, dynamic>? lastCreatePayload;

  @override
  Future<dynamic> listSubscriptions(
      [dynamic params, Options? options, bool force = false]) async {
    return {'data': rows};
  }

  @override
  Future<dynamic> listCatalog(
      [dynamic params, Options? options, bool force = false]) async {
    return {'data': catalog};
  }

  @override
  Future<dynamic> updateSubscription(String id, dynamic payload,
      {Options? options}) async {
    lastUpdateId = id;
    lastUpdatePayload = Map<String, dynamic>.from(payload as Map);
    return {};
  }

  @override
  Future<dynamic> terminateSubscription(String id, dynamic payload,
      {Options? options}) async {
    lastTerminateId = id;
    lastTerminatePayload = Map<String, dynamic>.from(payload as Map);
    return {};
  }

  @override
  Future<dynamic> createSubscription(dynamic payload, {Options? options}) async {
    lastCreatePayload = Map<String, dynamic>.from(payload as Map);
    return {};
  }
}

class _FakeBuildingsService extends Fake implements BuildingsService {
  final List<Map<String, dynamic>> apartments;
  _FakeBuildingsService(this.apartments);

  @override
  Future<dynamic> listApartments(
      [Map<String, dynamic>? params, bool force = false]) async {
    return {'data': apartments};
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  Future<_RecordingServicesService> pumpPage(
    WidgetTester tester, {
    required List<Map<String, dynamic>> rows,
    List<Map<String, dynamic>> catalog = const [],
    List<Map<String, dynamic>> apartments = const [],
  }) async {
    await tester.binding.setSurfaceSize(const Size(1800, 1000));
    addTearDown(() => tester.binding.setSurfaceSize(null));

    SharedPreferences.setMockInitialValues({});
    final prefs = await SharedPreferences.getInstance();
    final storage = AppStorage(prefs: prefs, isWeb: true);
    await storage.init();

    final services = _RecordingServicesService(rows, catalog);
    final container = ProviderContainer(
      overrides: [
        appStorageProvider.overrideWithValue(storage),
        dioProvider.overrideWithValue(Dio(BaseOptions(baseUrl: 'http://localhost'))),
        queryCacheProvider.overrideWithValue(QueryCache()),
        servicesServiceProvider.overrideWithValue(services),
        buildingsServiceProvider.overrideWithValue(_FakeBuildingsService(apartments)),
      ],
    );
    addTearDown(container.dispose);
    container.read(authProvider.notifier).setAuthData(
          accessToken: 'token',
          refreshToken: 'refresh',
          user: const UserModel(
            id: 'u-mgr',
            fullName: 'Ban Quan Ly',
            phone: '0900000000',
            roles: [UserRoleModel(code: 'MANAGER')],
          ),
        );

    final router = GoRouter(
      initialLocation: '/admin/services/subscriptions',
      routes: [
        GoRoute(
          path: '/admin/services/subscriptions',
          builder: (_, __) => const SubscriptionsPage(),
        ),
      ],
    );

    await tester.pumpWidget(
      UncontrolledProviderScope(
        container: container,
        child: MaterialApp.router(routerConfig: router),
      ),
    );
    await tester.pumpAndSettle();
    return services;
  }

  TextField fieldFor(WidgetTester tester, String label) {
    return tester.widget<TextField>(
      find.descendant(
        of: find.ancestor(
          of: find.text(label),
          matching: find.byType(AppInput),
        ),
        matching: find.byType(TextField),
      ),
    );
  }

  Map<String, dynamic> pendingRow() => {
        'id': 'sub-1',
        'apartment_code': '101',
        'building_code': 'A',
        'service_name': 'Gui xe may',
        'service_code': 'PARK',
        'status': 'CANCELLATION_PENDING',
        'unit_price': 100000,
        'quantity': 1,
        'start_date': '2020-01-01',
        'note': 'old note',
      };

  testWidgets('keep service sends ACTIVE not REJECTED', (tester) async {
    final services = await pumpPage(tester, rows: [pendingRow()]);

    await tester.tap(find.byTooltip('Xem chi tiết'));
    await tester.pumpAndSettle();

    expect(find.text('Giữ lại dịch vụ'), findsOneWidget);

    await tester.tap(find.text('Giữ lại dịch vụ'));
    await tester.pumpAndSettle();

    expect(services.lastUpdateId, 'sub-1');
    expect(services.lastUpdatePayload, {
      'status': 'ACTIVE',
      'note': 'Giữ lại dịch vụ tiếp tục sử dụng',
    });
  });

  testWidgets('CANCELLATION_PENDING row has 2 actions', (tester) async {
    await pumpPage(tester, rows: [pendingRow()]);

    expect(find.byTooltip('Xem chi tiết'), findsOneWidget);
    expect(find.byTooltip('Giữ lại dịch vụ'), findsOneWidget);
    expect(find.byTooltip('Xác nhận hủy'), findsOneWidget);
  });

  testWidgets('cancel end date respects end_date', (tester) async {
    await pumpPage(tester, rows: [
      {
        ...pendingRow(),
        'status': 'ACTIVE',
        'end_date': '2020-05-10',
      },
    ]);

    await tester.tap(find.byTooltip('Chấm dứt gói'));
    await tester.pumpAndSettle();

    expect(fieldFor(tester, 'Ngày kết thúc sử dụng').controller!.text,
        '2020-05-10');
  });

  testWidgets('cancel end date falls back to future start_date', (tester) async {
    await pumpPage(tester, rows: [
      {
        ...pendingRow(),
        'status': 'ACTIVE',
        'start_date': '2099-06-15',
      },
    ]);

    await tester.tap(find.byTooltip('Chấm dứt gói'));
    await tester.pumpAndSettle();

    expect(fieldFor(tester, 'Ngày kết thúc sử dụng').controller!.text,
        '2099-06-15');
  });

  testWidgets('cancel payload includes cancel_reason and note', (tester) async {
    final services = await pumpPage(tester, rows: [
      {
        ...pendingRow(),
        'status': 'ACTIVE',
        'end_date': '2025-01-01',
      },
    ]);

    await tester.tap(find.byTooltip('Chấm dứt gói'));
    await tester.pumpAndSettle();

    expect(find.text('Ghi chú xác nhận hủy'), findsOneWidget);
    await tester.enterText(
      find.descendant(
        of: find.ancestor(
          of: find.text('Ghi chú xác nhận hủy'),
          matching: find.byType(AppInput),
        ),
        matching: find.byType(TextField),
      ),
      '  Thu hoi the xe  ',
    );
    await tester.pumpAndSettle();

    await tester.tap(find.text('Xác nhận chấm dứt'));
    await tester.pumpAndSettle();

    expect(services.lastTerminateId, 'sub-1');
    expect(services.lastTerminatePayload, {
      'status': 'TERMINATED',
      'end_date': '2025-01-01',
      'zero_usage': false,
      'cancel_reason': 'Thu hoi the xe',
      'note': 'Thu hoi the xe',
    });
  });

  testWidgets('note is validated for non-parking services too', (tester) async {
    final services = await pumpPage(
      tester,
      rows: const [],
      catalog: [
        {
          'id': 'svc-1',
          'name': 'Ve sinh',
          'billing_type': 'FIXED',
          'unit_price': 50000,
          'unit': 'thang',
          'category': 'CLEANING',
        },
      ],
      apartments: [
        {'id': 'apt-1', 'code': '101', 'building_code': 'A'},
      ],
    );

    await tester.tap(find.text('Đăng ký mới'));
    await tester.pumpAndSettle();

    final noteFinder = find.descendant(
      of: find.ancestor(
        of: find.text('Ghi chú dịch vụ (tùy chọn)'),
        matching: find.byType(AppInput),
      ),
      matching: find.byType(TextField),
    );
    // AppInput enforces maxLength 500, so drive the field's onChanged directly
    // to exercise the page's validation of an overlong note for a non-parking service.
    final noteField = tester.widget<TextField>(noteFinder);
    noteField.onChanged!('x' * 501);
    await tester.pumpAndSettle();

    await tester.tap(find.text('Tạo gói đăng ký'));
    await tester.pumpAndSettle();

    expect(
      find.text('Ghi chú dịch vụ không được vượt quá 500 ký tự.'),
      findsOneWidget,
    );
    expect(services.lastCreatePayload, isNull);
  });
}
