import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:flutter_resihub/core/storage/app_storage.dart';
import 'package:flutter_resihub/core/theme/app_theme.dart';
import 'package:flutter_resihub/features/auth/models/user_model.dart';
import 'package:flutter_resihub/features/auth/providers/auth_provider.dart';
import 'package:flutter_resihub/features/buildings/services/buildings_service.dart';
import 'package:flutter_resihub/features/services/screens/service_catalog_page.dart';
import 'package:flutter_resihub/features/services/services/services_service.dart';
import 'package:flutter_resihub/shared/providers/toast_provider.dart';
import 'package:flutter_resihub/shared/widgets/ui/app_input.dart';
import 'package:flutter_resihub/shared/widgets/ui/app_select.dart';

class _MockServicesService extends Fake implements ServicesService {
  List<Map<String, dynamic>> catalog = [];
  Map<String, dynamic>? lastCreatePayload;
  String? lastUpdateId;
  Map<String, dynamic>? lastUpdatePayload;
  Object? saveError;

  @override
  Future<dynamic> listCatalog([
    dynamic params,
    Options? options,
    bool force = false,
  ]) async {
    return {'data': catalog};
  }

  @override
  Future<dynamic> listSubscriptions([
    dynamic params,
    Options? options,
    bool force = false,
  ]) async {
    return {'data': []};
  }

  @override
  Future<dynamic> createCatalog(dynamic payload, {Options? options}) async {
    lastCreatePayload = Map<String, dynamic>.from(payload as Map);
    if (saveError != null) throw saveError!;
    return {'id': 'svc-new'};
  }

  @override
  Future<dynamic> updateCatalog(String id, dynamic payload,
      {Options? options}) async {
    lastUpdateId = id;
    lastUpdatePayload = Map<String, dynamic>.from(payload as Map);
    if (saveError != null) throw saveError!;
    return {'id': id};
  }
}

class _MockBuildingsService extends Fake implements BuildingsService {
  @override
  Future<dynamic> list({bool force = false}) async {
    return {
      'data': [
        {'id': 'b-1', 'code': 'B01', 'name': 'Tòa Diamond'},
      ],
    };
  }
}

Map<String, dynamic> _sampleService() => {
      'id': 'svc-1',
      'code': 'ELEC-01',
      'name': 'Điện sinh hoạt mẫu',
      'category': 'ELECTRICITY',
      'billing_type': 'METERED',
      'unit': 'kWh',
      'unit_price': 2200,
      'building_id': 'b-1',
      'description': 'Điện sinh hoạt',
      'is_active': true,
    };

Widget _buildTestApp({
  required _MockServicesService services,
  required AppStorage storage,
  void Function(ProviderContainer container)? onContainerCreated,
}) {
  final user = UserModel(
    id: 'user-manager',
    fullName: 'Manager',
    email: 'manager@resihub.test',
    roles: [UserRoleModel(code: 'MANAGER')],
  );

  final router = GoRouter(
    initialLocation: '/admin/services',
    routes: [
      GoRoute(
        path: '/admin/services',
        builder: (context, state) => const ServiceCatalogPage(),
      ),
    ],
  );

  final container = ProviderContainer(
    overrides: [
      appStorageProvider.overrideWithValue(storage),
      servicesServiceProvider.overrideWithValue(services),
      buildingsServiceProvider.overrideWithValue(_MockBuildingsService()),
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

Finder _field(String label) => find.descendant(
      of: find.widgetWithText(AppInput, label),
      matching: find.byType(EditableText),
    );

Future<void> _enterField(WidgetTester tester, String label, String text) async {
  await tester.enterText(_field(label), text);
}

Future<void> _selectOption(
  WidgetTester tester,
  String selectLabel,
  String optionText,
) async {
  await tester.tap(find.widgetWithText(AppSelect<String>, selectLabel));
  await tester.pumpAndSettle();
  await tester.tap(
    find.descendant(
      of: find.byType(Dialog),
      matching: find.text(optionText),
    ),
  );
  await tester.pumpAndSettle();
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late AppStorage storage;

  setUp(() async {
    SharedPreferences.setMockInitialValues({});
    final prefs = await SharedPreferences.getInstance();
    storage = AppStorage(prefs: prefs, isWeb: true);
  });

  group('ServiceCatalogPage - D13 parity', () {
    testWidgets('changing category does not rewrite billing_type/unit',
        (tester) async {
      tester.view.physicalSize = const Size(1280, 900);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);

      final services = _MockServicesService()..catalog = [_sampleService()];
      await tester.pumpWidget(
        _buildTestApp(services: services, storage: storage),
      );
      await tester.pumpAndSettle();

      await tester.tap(find.text('Thêm dịch vụ'));
      await tester.pumpAndSettle();

      await _selectOption(tester, 'Nhóm dịch vụ', 'Điện sinh hoạt');
      await _enterField(tester, 'Mã dịch vụ', 'ELEC-X');
      await _enterField(tester, 'Tên dịch vụ', 'Điện test');

      await tester.tap(find.text('Thêm dịch vụ').last);
      await tester.pumpAndSettle();

      expect(services.lastCreatePayload, isNotNull);
      expect(services.lastCreatePayload!['billing_type'], 'FIXED');
      expect(services.lastCreatePayload!['unit'], 'tháng');

      await tester.pump(const Duration(seconds: 6));
    });

    testWidgets('building scope is disabled when editing and update payload '
        'omits code/building_id', (tester) async {
      tester.view.physicalSize = const Size(1280, 900);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);

      final services = _MockServicesService()..catalog = [_sampleService()];
      await tester.pumpWidget(
        _buildTestApp(services: services, storage: storage),
      );
      await tester.pumpAndSettle();

      await tester.tap(find.byTooltip('Chỉnh sửa dịch vụ'));
      await tester.pumpAndSettle();

      expect(find.text('Chỉnh sửa dịch vụ'), findsOneWidget);
      expect(
        find.widgetWithText(AppSelect<String>, 'Phạm vi áp dụng'),
        findsNothing,
      );
      expect(
        find.widgetWithText(AppInput, 'Phạm vi áp dụng'),
        findsOneWidget,
      );
      expect(find.text('Riêng tòa B01 — Tòa Diamond'), findsOneWidget);

      await tester.tap(find.text('Cập nhật'));
      await tester.pumpAndSettle();

      expect(services.lastUpdateId, 'svc-1');
      expect(services.lastUpdatePayload, isNotNull);
      expect(services.lastUpdatePayload!.containsKey('building_id'), isFalse);
      expect(services.lastUpdatePayload!.containsKey('code'), isFalse);
      expect(services.lastUpdatePayload!['is_active'], isTrue);
      expect(services.lastUpdatePayload!['description'], 'Điện sinh hoạt');

      await tester.pump(const Duration(seconds: 6));
    });

    testWidgets('create payload uppercases code, omits is_active and '
        'normalizes empty description to null', (tester) async {
      tester.view.physicalSize = const Size(1280, 900);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);

      final services = _MockServicesService()..catalog = [_sampleService()];
      await tester.pumpWidget(
        _buildTestApp(services: services, storage: storage),
      );
      await tester.pumpAndSettle();

      await tester.tap(find.text('Thêm dịch vụ'));
      await tester.pumpAndSettle();
      await _enterField(tester, 'Mã dịch vụ', 'elec-09');
      await _enterField(tester, 'Tên dịch vụ', 'Điện mới');
      await tester.tap(find.text('Thêm dịch vụ').last);
      await tester.pumpAndSettle();

      expect(services.lastCreatePayload, isNotNull);
      expect(services.lastCreatePayload!['code'], 'ELEC-09');
      expect(services.lastCreatePayload!.containsKey('is_active'), isFalse);
      expect(services.lastCreatePayload!['description'], isNull);

      await tester.pump(const Duration(seconds: 6));
    });

    testWidgets('is_active switch is shown only when editing', (tester) async {
      tester.view.physicalSize = const Size(1280, 900);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);

      final services = _MockServicesService()..catalog = [_sampleService()];
      await tester.pumpWidget(
        _buildTestApp(services: services, storage: storage),
      );
      await tester.pumpAndSettle();

      await tester.tap(find.text('Thêm dịch vụ'));
      await tester.pumpAndSettle();
      expect(find.byType(SwitchListTile), findsNothing);

      await tester.tap(find.text('Hủy bỏ'));
      await tester.pumpAndSettle();
      await tester.tap(find.byTooltip('Chỉnh sửa dịch vụ'));
      await tester.pumpAndSettle();
      expect(find.byType(SwitchListTile), findsOneWidget);
    });

    testWidgets('status filter uses「Đang cung cấp / Ngưng cung cấp」labels',
        (tester) async {
      tester.view.physicalSize = const Size(1280, 900);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);

      final services = _MockServicesService()..catalog = [_sampleService()];
      await tester.pumpWidget(
        _buildTestApp(services: services, storage: storage),
      );
      await tester.pumpAndSettle();

      await tester.tap(
        find.widgetWithText(AppSelect<String>, 'Tất cả trạng thái'),
      );
      await tester.pumpAndSettle();

      expect(find.text('Đang cung cấp'), findsOneWidget);
      expect(find.text('Ngưng cung cấp'), findsOneWidget);
      expect(find.text('Đang áp dụng'), findsNothing);
      expect(find.text('Ngừng áp dụng'), findsNothing);
    });

    testWidgets('ORG_DEFAULT_SHARED_ACROSS_BUILDINGS surfaces a dedicated '
        'message on save', (tester) async {
      tester.view.physicalSize = const Size(1280, 900);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);

      final services = _MockServicesService()
        ..catalog = [_sampleService()]
        ..saveError = DioException(
          requestOptions: RequestOptions(path: '/api/v1/service-catalog'),
          response: Response(
            requestOptions: RequestOptions(path: '/api/v1/service-catalog'),
            statusCode: 400,
            data: {'code': 'ORG_DEFAULT_SHARED_ACROSS_BUILDINGS'},
          ),
          type: DioExceptionType.badResponse,
        );

      late ProviderContainer captured;
      await tester.pumpWidget(
        _buildTestApp(
          services: services,
          storage: storage,
          onContainerCreated: (c) => captured = c,
        ),
      );
      await tester.pumpAndSettle();

      await tester.tap(find.text('Thêm dịch vụ'));
      await tester.pumpAndSettle();
      await _enterField(tester, 'Mã dịch vụ', 'ELEC-09');
      await _enterField(tester, 'Tên dịch vụ', 'Điện mới');
      await tester.tap(find.text('Thêm dịch vụ').last);
      await tester.pumpAndSettle();

      final toasts = captured.read(toastProvider);
      expect(toasts, isNotEmpty);
      expect(toasts.last.variant, ToastVariant.error);
      expect(
        toasts.last.message,
        contains('Không thể sửa dịch vụ mặc định tổ chức'),
      );

      await tester.pump(const Duration(seconds: 6));
    });
  });
}
