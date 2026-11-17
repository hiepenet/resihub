import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:flutter_resihub/core/network/dio_client.dart';
import 'package:flutter_resihub/core/network/query_cache.dart';
import 'package:flutter_resihub/core/storage/app_storage.dart';
import 'package:flutter_resihub/features/auth/models/user_model.dart';
import 'package:flutter_resihub/features/auth/providers/auth_provider.dart';
import 'package:flutter_resihub/features/contracts/screens/contract_detail_page.dart';
import 'package:flutter_resihub/shared/widgets/ui/app_tabs.dart';

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

const _manager = UserModel(
  id: 'u-mgr',
  fullName: 'Ban Quan Ly',
  phone: '0900000000',
  roles: [UserRoleModel(code: 'MANAGER', name: 'Quản lý')],
);

const _owner = UserModel(
  id: 'u-owner',
  fullName: 'Chu So Huu',
  phone: '0900000001',
  roles: [UserRoleModel(code: 'OWNER', name: 'Chủ sở hữu')],
);

Map<String, dynamic> _contractFixture({String status = 'TERMINATION_PENDING'}) {
  return {
    'id': 'c1',
    'apartment_code': 'A-101',
    'building_name': 'Toa A',
    'tenant_name': 'Nguyen Van A',
    'status': status,
    'start_date': '2026-01-01',
    'end_date': '2026-12-31',
    'billing_day': 1,
    'payment_due_days': 5,
    'rent_amount': 10000000,
    'deposit_amount': 10000000,
    'attachments': <dynamic>[],
    'invoice_schedule': [
      {'period_no': 1},
    ],
    'service_subscriptions': <dynamic>[],
    'credit_balances': [
      {
        'id': 'cr1',
        'amount': 1000000,
        'applied_amount': 0,
        'settlement_refund_amount': 0,
        'status': 'AVAILABLE',
      },
    ],
    'catalog_services': [
      {'id': 'svc-x', 'code': 'CUSTOM', 'name': 'Dich vu custom'},
    ],
    'related_contracts': <dynamic>[],
    'occupants': <dynamic>[],
    'amendments': <dynamic>[],
    'service_prices': <dynamic>[],
  };
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('B9 — 6 tabs', () {
    test('detail tab items include schedule and credits', () {
      final tabs = buildContractDetailTabItems(_contractFixture());
      expect(tabs.length, 6);
      expect(
        tabs.map((t) => t.id).toList(),
        ['overview', 'schedule', 'occupants', 'amendments', 'credits', 'history'],
      );
      expect(
        tabs.firstWhere((t) => t.id == 'schedule').label,
        'Lịch hóa đơn dự kiến',
      );
      expect(
        tabs.firstWhere((t) => t.id == 'credits').label,
        'Sổ tín dụng & Hoàn tiền',
      );
    });

    testWidgets('detail renders all 6 tab labels', (tester) async {
      await pumpDetail(tester);
      expect(find.byType(AppTabs), findsOneWidget);
      for (final label in [
        'Chi tiết & Bản scan',
        'Lịch hóa đơn dự kiến',
        'Người ở cùng',
        'Phụ lục hợp đồng',
        'Sổ tín dụng & Hoàn tiền',
        'Giá dịch vụ riêng',
      ]) {
        expect(find.text(label), findsOneWidget, reason: 'thiếu tab $label');
      }
    });
  });

  group('B11 — edit draft payload', () {
    test('payload has services/service_prices and clamps billing fields', () {
      final payload = buildEditDraftSavePayload(
        startDate: '2026-01-01',
        endDate: '2026-12-31',
        rentAmount: 10000000,
        depositAmount: 10000000,
        billingCycle: 'monthly',
        billingDay: 0,
        paymentDueDays: 61,
        note: '  giu nguyen  ',
        services: [
          {'service_id': 'svc-x', 'quantity': 1, 'unit_price': 0},
        ],
        servicePrices: [
          {'service_code': 'ELECTRICITY', 'unit_price': null},
        ],
      );
      expect(payload['billing_day'], 1);
      expect(payload['payment_due_days'], 60);
      expect(payload['note'], 'giu nguyen');
      expect(payload['services'], isA<List>());
      expect(payload['service_prices'], isA<List>());
      expect((payload['services'] as List).first['service_id'], 'svc-x');
      expect((payload['service_prices'] as List).first['service_code'], 'ELECTRICITY');
    });
  });

  group('B15 — amendment changes', () {
    test('only changed fields are sent, note is included when edited', () {
      final current = {
        'end_date': '2026-12-31',
        'rent_amount': 10000000,
        'deposit_amount': 10000000,
        'note': 'old note',
      };
      final unchanged = buildAmendmentChanges(
        current: current,
        endDate: '2026-12-31',
        rentAmount: '10000000',
        depositAmount: '10000000',
        note: 'old note',
      );
      expect(unchanged, isEmpty);

      final changed = buildAmendmentChanges(
        current: current,
        endDate: '2026-12-31',
        rentAmount: '11000000',
        depositAmount: '10000000',
        note: 'new note',
      );
      expect(changed, {
        'rent_amount': 11000000,
        'note': 'new note',
      });
    });
  });

  group('B13 — termination form', () {
    test('defaults use two reasons and clamp date to contract range', () {
      final pre = resolveTerminateDefaults(
        todayStr: '2026-06-15',
        contractStartStr: '2026-07-01',
        contractEndStr: '2026-12-31',
      );
      expect(pre.isPreMoveIn, isTrue);
      expect(pre.date, '2026-06-15');
      expect(pre.reason, contains('trước ngày nhận phòng'));

      final post = resolveTerminateDefaults(
        todayStr: '2026-08-15',
        contractStartStr: '2026-07-01',
        contractEndStr: '2026-08-01',
      );
      expect(post.isPreMoveIn, isFalse);
      expect(post.date, '2026-08-01');
      expect(post.reason, 'Khách thuê trả phòng / Thanh lý hợp đồng');

      expect(
        validateTerminateDate(date: '2026-06-30', minDate: '2026-07-01', maxDate: '2026-12-31'),
        isNotEmpty,
      );
      expect(
        validateTerminateDate(date: '2027-01-01', minDate: '2026-07-01', maxDate: '2026-12-31'),
        isNotEmpty,
      );
      expect(
        validateTerminateDate(date: '2026-08-15', minDate: '2026-07-01', maxDate: '2026-12-31'),
        isEmpty,
      );
    });
  });

  group('B9 — credit refund payload', () {
    test('bank_info fields and proof_image are sent', () {
      final payload = buildCreditRefundPayload(
        amount: 500000,
        reason: '  hoan tien  ',
        bankName: '  VCB  ',
        accountNumber: ' 123456789 ',
        accountHolder: '  Nguyen Van A ',
        proofImage: 'base64-proof',
      );
      expect(payload['amount'], 500000);
      expect(payload['reason'], 'hoan tien');
      expect(payload['bank_info'], {
        'bank_name': 'VCB',
        'account_number': '123456789',
        'account_holder': 'Nguyen Van A',
      });
      expect(payload['proof_image'], 'base64-proof');

      final noProof = buildCreditRefundPayload(
        amount: 1,
        reason: 'r',
        bankName: '',
        accountNumber: '',
        accountHolder: '',
        proofImage: '',
      );
      expect(noProof.containsKey('proof_image'), isFalse);
    });
  });

  group('B16 — approval-pending error codes', () {
    test('two codes are detected', () {
      expect(extractApprovalPendingErrorCode('PRICE_NEEDS_APPROVAL'), 'PRICE_NEEDS_APPROVAL');
      expect(extractApprovalPendingErrorCode('TRANSFER_NEEDS_APPROVAL'), 'TRANSFER_NEEDS_APPROVAL');
      expect(extractApprovalPendingErrorCode('SOMETHING_ELSE'), isNull);
      expect(
        extractApprovalPendingErrorCode({
          'response': {'data': {'code': 'TRANSFER_NEEDS_APPROVAL'}},
        }),
        'TRANSFER_NEEDS_APPROVAL',
      );
    });
  });

  group('B12/B14 — widget behaviour', () {
    testWidgets('final move-out opens terminate flow and calls terminate endpoint', (tester) async {
      final requests = <RequestOptions>[];
      await pumpDetail(tester, onRequest: requests.add);

      await tester.tap(find.text('Chốt trả phòng & Chấm dứt ngay'));
      await tester.pumpAndSettle();
      expect(find.text('Xác nhận chấm dứt'), findsOneWidget,
          reason: 'nút chốt trả phòng phải mở form terminate, không phải dialog approveTermination');

      await tester.tap(find.text('Xác nhận chấm dứt'));
      await tester.pumpAndSettle();

      final paths = requests.where((r) => r.method == 'POST').map((r) => r.path).toList();
      expect(paths, contains('/api/v1/contracts/c1/terminate'));
      expect(paths, isNot(contains('/api/v1/contracts/c1/terminate/approve')));
    });

    testWidgets('allow_self_approval from settings enables self approval', (tester) async {
      final contract = _contractFixture(status: 'PENDING_APPROVAL');
      contract['created_by'] = 'u-owner';
      await pumpDetail(
        tester,
        contract: contract,
        user: _owner,
        allowSelfApproval: true,
      );
      expect(find.text('Phê duyệt HĐ giá ưu đãi'), findsOneWidget,
          reason: 'allow_self_approval=true phải cho proposer tự phê duyệt');
    });
  });
}

Future<void> pumpDetail(
  WidgetTester tester, {
  Map<String, dynamic>? contract,
  UserModel user = _manager,
  bool allowSelfApproval = false,
  void Function(RequestOptions)? onRequest,
}) async {
  tester.view.physicalSize = const Size(1440, 1000);
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.resetPhysicalSize);

  SharedPreferences.setMockInitialValues({});
  final prefs = await SharedPreferences.getInstance();
  final storage = AppStorage(prefs: prefs, isWeb: true);

  final payload = contract ?? _contractFixture();
  final dio = Dio(BaseOptions(baseUrl: 'http://localhost:3000'));
  dio.httpClientAdapter = _MockHttpClientAdapter((options) async {
    onRequest?.call(options);
    late final dynamic data;
    if (options.path.startsWith('/api/v1/contracts/c1')) {
      data = {'success': true, 'data': payload};
    } else if (options.path == '/api/v1/settings') {
      data = {
        'success': true,
        'data': {'approval_config': {'allow_self_approval': allowSelfApproval}},
      };
    } else if (options.path == '/api/v1/service-catalog') {
      data = {'success': true, 'data': payload['catalog_services'] ?? <dynamic>[]};
    } else {
      data = {'success': true, 'data': <dynamic>[]};
    }
    return ResponseBody.fromString(
      jsonEncode(data),
      200,
      headers: {Headers.contentTypeHeader: [Headers.jsonContentType]},
    );
  });

  final container = ProviderContainer(
    overrides: [
      appStorageProvider.overrideWithValue(storage),
      dioProvider.overrideWithValue(dio),
      queryCacheProvider.overrideWithValue(QueryCache()),
    ],
  );
  container.read(authProvider.notifier).setAuthData(
        accessToken: 'token',
        refreshToken: 'refresh',
        user: user,
      );
  addTearDown(container.dispose);

  await tester.pumpWidget(
    UncontrolledProviderScope(
      container: container,
      child: const MaterialApp(home: Scaffold(body: ContractDetailPage(contractId: 'c1'))),
    ),
  );
  await tester.pumpAndSettle();
}
