import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';

import 'package:flutter_resihub/core/utils/ai_helpers.dart';
import 'package:flutter_resihub/core/utils/deposit_ui_helpers.dart';
import 'package:flutter_resihub/features/ai_gateway/screens/settings_page.dart';
import 'package:flutter_resihub/features/ai_gateway/services/ai_service.dart';
import 'package:flutter_resihub/features/ai_gateway/widgets/ai_gateway_config_card.dart';
import 'package:flutter_resihub/features/auth/models/user_model.dart';
import 'package:flutter_resihub/features/auth/providers/permission_provider.dart';
import 'package:flutter_resihub/features/buildings/services/buildings_service.dart';
import 'package:flutter_resihub/features/users/services/users_service.dart';

class _FakeUsersService extends Fake implements UsersService {
  @override
  Future<dynamic> getSettings({bool force = false}) async {
    return {
      'data': {
        'billing_config': {},
        'sla_config': {},
        'contact_config': {},
      },
      'ai_runtime': {'api_key_configured': false},
    };
  }

  @override
  Future<dynamic> listCronRuns([Map<String, dynamic>? params]) async {
    return {'data': [], 'allow_custom_date': false};
  }
}

class _FakeBuildingsService extends Fake implements BuildingsService {
  @override
  Future<dynamic> list({bool force = false}) async => {'data': []};
}

class _FakeAiService extends Fake implements AiService {}

List<Override> _overrides() => [
      usersServiceProvider.overrideWithValue(_FakeUsersService()),
      buildingsServiceProvider.overrideWithValue(_FakeBuildingsService()),
      aiServiceProvider.overrideWithValue(_FakeAiService()),
      permissionProvider.overrideWithValue(PermissionMatrix(_sysAdmin())),
    ];

UserModel _sysAdmin() => UserModel(
      id: 'admin-1',
      email: 'admin@resihub.test',
      fullName: 'Admin',
      roles: const [UserRoleModel(code: 'SYS_ADMIN', name: 'Quản trị hệ thống')],
    );

Widget _buildTestApp() {
  return ProviderScope(
    overrides: _overrides(),
    child: const MaterialApp(home: SettingsPage()),
  );
}

Widget _buildTestAppWithRouter(String location) {
  final router = GoRouter(
    initialLocation: location,
    routes: [
      GoRoute(
        path: '/admin/settings',
        builder: (context, state) => const SettingsPage(),
      ),
    ],
  );
  return ProviderScope(
    overrides: _overrides(),
    child: MaterialApp.router(routerConfig: router),
  );
}

Map<String, dynamic> _payload({
  Map<String, dynamic>? billing,
  Map<String, dynamic>? sla,
  Map<String, dynamic>? ai,
  Map<String, dynamic>? reservation,
}) {
  return buildSystemSettingsPayload(
    billing: billing ?? Map<String, dynamic>.from(kDefaultBillingConfig),
    sla: sla ?? Map<String, dynamic>.from(kDefaultSlaConfig),
    contact: Map<String, dynamic>.from(kDefaultContactConfig),
    approval: {'allow_self_approval': false},
    reservation: reservation ?? Map<String, dynamic>.from(kDefaultReservationCancelPolicy),
    ai: ai ?? Map<String, dynamic>.from(kDefaultAiConfig),
  );
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('SettingsPage renders all four parity inputs', (tester) async {
    await tester.binding.setSurfaceSize(const Size(1440, 2400));
    addTearDown(() => tester.binding.setSurfaceSize(null));

    await tester.pumpWidget(_buildTestApp());
    await tester.pumpAndSettle();

    expect(find.text('Ngưỡng cảnh báo chỉ số (%)'), findsOneWidget);
    expect(find.text('Mốc ngày nhắc nợ (dấu phẩy)'), findsOneWidget);
    expect(
      find.text(
          'Số ngày cho phép cư dân mở lại yêu cầu sau khi hoàn tất (ngày)'),
      findsOneWidget,
    );
    expect(find.text('Số điện thoại khẩn cấp / PCCC'), findsOneWidget);
  });

  group('buildSystemSettingsPayload clamp & fallback (D23)', () {
    test('due 0 clamps to 1 and over-60 clamps to 60', () {
      final low = _payload(billing: {
        ...kDefaultBillingConfig,
        'due_date_offset_days': 0,
      })['billing_config'] as Map<String, dynamic>;
      expect(low['due_date_offset_days'], 1);
      expect(low['payment_due_days'], 1);

      final high = _payload(billing: {
        ...kDefaultBillingConfig,
        'due_date_offset_days': 999,
      })['billing_config'] as Map<String, dynamic>;
      expect(high['due_date_offset_days'], 60);
      expect(high['payment_due_days'], 60);
    });

    test('grace 0..60, anomaly 1..500, fees/percent/prices >= 0', () {
      final bc = _payload(billing: {
        ...kDefaultBillingConfig,
        'late_fee_grace_days': -5,
        'late_fee_per_day': -100,
        'meter_anomaly_threshold_pct': 900,
        'late_fee_percent': -2,
        'electricity_default_price': -1,
        'water_default_price': -1,
      })['billing_config'] as Map<String, dynamic>;

      expect(bc['late_fee_grace_days'], 0);
      expect(bc['late_fee_per_day'], 0);
      expect(bc['meter_anomaly_threshold_pct'], 500);
      expect(bc['late_fee_percent'], 0);
      expect(bc['electricity_default_price'], 0);
      expect(bc['water_default_price'], 0);
    });

    test('reservation days clamp to React ranges', () {
      final rcp = _payload(reservation: {
        'max_hold_days': 999,
        'public_max_hold_days': 0,
        'full_refund_before_days': -1,
        'partial_refund_pct': 150,
        'default_hold_amount': -5,
      })['reservation_cancel_policy'] as Map<String, dynamic>;

      expect(rcp['max_hold_days'], 90);
      expect(rcp['public_max_hold_days'], 1);
      expect(rcp['full_refund_before_days'], 0);
      expect(rcp['partial_refund_pct'], 100);
      expect(rcp['default_hold_amount'], 0);
    });

    test('monthly_budget_vnd falls back to 0 when unparsable', () {
      final ac = _payload(ai: {
        ...kDefaultAiConfig,
        'monthly_budget_vnd': 'không hợp lệ',
        'monthly_token_limit': '1',
      })['ai_config'] as Map<String, dynamic>;

      expect(ac['monthly_budget_vnd'], 0);
      expect(ac['monthly_token_limit'], 10000);
    });
  });

  testWidgets('AI task checkboxes default to false when tasks missing',
      (tester) async {
    await tester.binding.setSurfaceSize(const Size(1440, 2400));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(
      ProviderScope(
        overrides: [aiServiceProvider.overrideWithValue(_FakeAiService())],
        child: MaterialApp(
          home: Scaffold(
            body: AiGatewayConfigCard(aiConfig: const {}, canEdit: true),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    final checkboxes = find.byType(Checkbox);
    expect(checkboxes, findsNWidgets(5));
    for (var i = 0; i < 5; i++) {
      expect(tester.widget<Checkbox>(checkboxes.at(i)).value, isFalse,
          reason: 'checkbox $i');
    }
  });

  testWidgets('?modal=ai opens AI system alert dialog', (tester) async {
    await tester.binding.setSurfaceSize(const Size(1440, 2400));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(_buildTestAppWithRouter('/admin/settings?modal=ai'));
    await tester.pumpAndSettle();

    expect(
      find.text('Cảnh báo Ngân sách & Trạng thái AI Gateway'),
      findsOneWidget,
    );
  });

  testWidgets('?modal=cron opens cron system alert dialog', (tester) async {
    await tester.binding.setSurfaceSize(const Size(1440, 2400));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(_buildTestAppWithRouter('/admin/settings?modal=cron'));
    await tester.pumpAndSettle();

    expect(
      find.text('Chi tiết Cảnh báo Tiến trình Tự động Hằng ngày (Cron)'),
      findsOneWidget,
    );
  });
}
