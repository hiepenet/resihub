import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:flutter_resihub/features/auth/models/user_model.dart';
import 'package:flutter_resihub/features/auth/providers/auth_provider.dart';
import 'package:flutter_resihub/features/buildings/services/buildings_service.dart';
import 'package:flutter_resihub/features/deposits/services/deposits_service.dart';
import 'package:flutter_resihub/features/deposits/widgets/deposit_detail_modal.dart';
import 'package:flutter_resihub/shared/widgets/ui/app_select.dart';

class _MockAuthNotifier extends AuthNotifier {
  final UserModel _user;
  _MockAuthNotifier(this._user);

  @override
  AuthState build() => AuthState(user: _user, isAuthenticated: true);
}

class _FakeDepositsService extends Fake implements DepositsService {}

class _FakeBuildingsService extends Fake implements BuildingsService {
  @override
  Future<dynamic> listBanks() async => {'data': []};
}

const _manager = UserModel(
  id: 'u-mgr',
  fullName: 'Ban Quan Ly',
  phone: '0900000000',
  roles: [UserRoleModel(code: 'MANAGER')],
);

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('deposit settlement parity helpers', () {
    test('STK validation: 4-25 alphanumeric only', () {
      expect(isValidRefundAccountNumber('123'), isFalse);
      expect(isValidRefundAccountNumber('1234'), isTrue);
      expect(isValidRefundAccountNumber('1234567890123456789012345'), isTrue);
      expect(isValidRefundAccountNumber('12345678901234567890123456'), isFalse);
      expect(isValidRefundAccountNumber('12-34'), isFalse);
      expect(isValidRefundAccountNumber(' 12ab '), isTrue);
    });

    test('outstanding_debt uses computed liveCalc.serviceDebt', () {
      expect(resolveLiveServiceDebt(-500), 0);
      expect(resolveLiveServiceDebt(1200.6), 1201);

      final payload = buildSettlePayload(
        rawServiceDebt: -500,
        items: const [],
        refundMethod: 'BANK_TRANSFER',
        bankInfo: const {},
        inspectionEvidence: null,
      );
      expect(payload['outstanding_debt'], 0);
    });

    test('bank_info is {} for CASH and trimmed map for BANK_TRANSFER', () {
      const bankInfo = {
        'bank_name': 'Vietcombank',
        'bank_code': 'VCB',
        'bank_bin': '970436',
        'bank_logo': 'logo.png',
        'account_number': ' 123456 ',
        'account_holder': ' NGUYEN VAN A ',
      };

      final cash = buildSettlePayload(
        rawServiceDebt: 0,
        items: const [],
        refundMethod: 'CASH',
        bankInfo: bankInfo,
        inspectionEvidence: null,
      );
      expect(cash['bank_info'], isA<Map<String, dynamic>>());
      expect(cash['bank_info'], isEmpty);
      expect(cash['refund_method'], 'CASH');

      final bank = buildSettlePayload(
        rawServiceDebt: 1000,
        items: const [],
        refundMethod: 'BANK_TRANSFER',
        bankInfo: bankInfo,
        inspectionEvidence: null,
      );
      expect(bank['outstanding_debt'], 1000);
      expect(bank['bank_info']['account_number'], '123456');
      expect(bank['bank_info']['account_holder'], 'NGUYEN VAN A');
    });
  });

  group('DepositDetailModal refund method UI', () {
    Future<void> pumpModal(WidgetTester tester) async {
      await tester.binding.setSurfaceSize(const Size(1280, 1000));
      addTearDown(() => tester.binding.setSurfaceSize(null));

      final detail = <String, dynamic>{
        'settlement': <String, dynamic>{
          'refund_method': 'BANK_TRANSFER',
          'items': <dynamic>[],
          'bank_info': <String, dynamic>{
            'bank_name': 'Vietcombank',
            'bank_code': 'VCB',
            'account_number': '12345678',
            'account_holder': 'NGUYEN VAN A',
          },
        },
        'preconditions': <String, dynamic>{
          'unbilled_final_period': <String, dynamic>{
            'has_unbilled_period': true,
            'period': '2026-10',
            'active_days': 12,
          },
        },
      };

      final container = ProviderContainer(
        overrides: [
          authProvider.overrideWith(() => _MockAuthNotifier(_manager)),
          depositsServiceProvider.overrideWithValue(_FakeDepositsService()),
          buildingsServiceProvider.overrideWithValue(_FakeBuildingsService()),
        ],
      );
      addTearDown(container.dispose);

      await tester.pumpWidget(
        UncontrolledProviderScope(
          container: container,
          child: MaterialApp(
            home: Scaffold(
              body: DepositDetailModal(
                deposit: <String, dynamic>{
                  'id': 'd1',
                  'apartment_code': 'A-101',
                  'status': 'HELD',
                  'amount_held': 20000000,
                  'deposit_amount': 20000000,
                  'contract_id': 'c1',
                },
                initialDetail: detail,
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
    }

    testWidgets('dropdown has 2 methods; CASH hides bank fields',
        (tester) async {
      await pumpModal(tester);

      expect(find.text('Phương thức hoàn trả tiền cọc'), findsOneWidget);
      expect(find.text('Số tài khoản ngân hàng'), findsOneWidget);
      expect(find.text('Sinh hóa đơn Pro-rata kỳ cuối'), findsOneWidget);

      await tester.tap(find.widgetWithText(
          AppSelect<String>, 'Phương thức hoàn trả tiền cọc'));
      await tester.pumpAndSettle();

      // BANK_TRANSFER appears both as the trigger label and as the selected option.
      expect(find.text('Chuyển khoản ngân hàng (BANK_TRANSFER)'),
          findsWidgets);
      expect(find.text('Tiền mặt (CASH)'), findsOneWidget);

      await tester.tap(find.text('Tiền mặt (CASH)'));
      await tester.pumpAndSettle();

      expect(find.text('Số tài khoản ngân hàng'), findsNothing);
      expect(find.text('Chủ tài khoản thụ hưởng'), findsNothing);
    });
  });
}
