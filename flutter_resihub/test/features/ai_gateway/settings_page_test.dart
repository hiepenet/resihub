import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:flutter_resihub/features/ai_gateway/screens/settings_page.dart';
import 'package:flutter_resihub/features/ai_gateway/services/ai_service.dart';
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

Widget _buildTestApp() {
  final sysAdmin = UserModel(
    id: 'admin-1',
    email: 'admin@resihub.test',
    fullName: 'Admin',
    roles: const [UserRoleModel(code: 'SYS_ADMIN', name: 'Quản trị hệ thống')],
  );

  return ProviderScope(
    overrides: [
      usersServiceProvider.overrideWithValue(_FakeUsersService()),
      buildingsServiceProvider.overrideWithValue(_FakeBuildingsService()),
      aiServiceProvider.overrideWithValue(_FakeAiService()),
      permissionProvider.overrideWithValue(PermissionMatrix(sysAdmin)),
    ],
    child: const MaterialApp(home: SettingsPage()),
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
}
