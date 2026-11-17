import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:flutter_resihub/features/auth/models/user_model.dart';
import 'package:flutter_resihub/features/auth/providers/auth_provider.dart';
import 'package:flutter_resihub/features/buildings/services/buildings_service.dart';
import 'package:flutter_resihub/features/buildings/widgets/floor_modal.dart';

class _FakeBuildingsService extends Fake implements BuildingsService {
  Map<String, dynamic>? lastBulkPayload;

  @override
  Future<dynamic> createFloorsBulk(String id, Map<String, dynamic> payload) async {
    lastBulkPayload = payload;
    return {'message': 'ok'};
  }
}

class _AuthMock extends AuthNotifier {
  _AuthMock(this._user);
  final UserModel _user;

  @override
  AuthState build() => AuthState(
        isAuthenticated: true,
        user: _user,
        accessToken: 'token',
        selectedBuildingId: 'b-1',
      );
}

Widget _wrap(Widget child, _FakeBuildingsService service) {
  final user = UserModel(
    id: 'u-1',
    fullName: 'Manager',
    roles: [UserRoleModel(code: 'MANAGER')],
  );
  return ProviderScope(
    overrides: [
      buildingsServiceProvider.overrideWithValue(service),
      authProvider.overrideWith(() => _AuthMock(user)),
    ],
    child: MaterialApp(home: Scaffold(body: child)),
  );
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('C11 - FloorModal parity', () {
    test('includeZero auto-toggle follows range until zeroTouched (214-128)', () {
      // Range strictly negative -> no auto decision (keeps previous).
      expect(autoIncludeZeroForRange('-3', '-1'), isNull);
      // Range spans zero -> exclude zero.
      expect(autoIncludeZeroForRange('-1', '5'), false);
      // Range touches zero -> include zero.
      expect(autoIncludeZeroForRange('0', '5'), true);
      expect(autoIncludeZeroForRange('1', '5'), isNull);
    });

    test('4-5 quick presets (React has 4 when empty, 3 when floors exist)', () {
      expect(buildFloorPresets(const []).length, greaterThanOrEqualTo(4));
      expect(
        buildFloorPresets([
          {'level': 1}
        ]).length,
        greaterThanOrEqualTo(3),
      );
    });

    test('customNames are applied to preview display name', () {
      final result = computeFloorBulkRows(
        fromLevel: '1',
        toLevel: '2',
        existingFloors: const [],
        includeZero: false,
        skipExisting: true,
        excludedLevels: const <int>{},
        customNames: const {1: 'Tầng Alpha'},
        namePrefix: 'Tầng',
      );
      expect(result.error, isEmpty);
      expect(result.rows.first.displayName, 'Tầng Alpha');
    });

    testWidgets('preview custom name field is editable and used in payload', (tester) async {
      tester.view.physicalSize = const Size(1000, 800);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);

      final service = _FakeBuildingsService();
      await tester.pumpWidget(_wrap(
        FloorModal(
          open: true,
          buildingId: 'b-1',
          existingFloors: const [],
          onClose: () {},
          onCreated: (_) {},
        ),
        service,
      ));
      await tester.pumpAndSettle();

      final field = find.byKey(const Key('floor-name-1'));
      expect(field, findsOneWidget, reason: 'phải cho sửa tên tầng trong preview');
      await tester.enterText(field, 'Tầng Alpha');
      await tester.pumpAndSettle();

      await tester.tap(find.text('Khởi tạo tầng'));
      await tester.pumpAndSettle();

      expect(service.lastBulkPayload, isNotNull);
      final floors = service.lastBulkPayload!['floors'] as List;
      expect(floors.first['name'], 'Tầng Alpha');
    });
  });
}
