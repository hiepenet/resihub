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
import 'package:flutter_resihub/core/utils/deposit_ui_helpers.dart';
import 'package:flutter_resihub/features/auth/models/user_model.dart';
import 'package:flutter_resihub/features/auth/providers/auth_provider.dart';
import 'package:flutter_resihub/features/auth/providers/permission_provider.dart';
import 'package:flutter_resihub/features/deposits/screens/deposits_page.dart';
import 'package:flutter_resihub/features/deposits/services/deposits_service.dart';
import 'package:flutter_resihub/features/deposits/widgets/deposit_detail_modal.dart';
import 'package:flutter_resihub/shared/providers/toast_provider.dart';
import 'package:flutter_resihub/shared/widgets/common/bank_select.dart';
import 'package:flutter_resihub/shared/widgets/ui/app_input.dart';
import 'package:flutter_resihub/shared/widgets/ui/file_upload_field.dart';
import 'package:flutter_resihub/shared/widgets/ui/money_input.dart';

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

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('DepositsService (14 methods matching deposits.service.js)', () {
    late Dio dio;
    late QueryCache queryCache;
    late DepositsService depositsService;
    late RequestOptions lastRequest;

    setUp(() {
      dio = Dio(BaseOptions(baseUrl: 'http://localhost:3000'));
      queryCache = QueryCache();

      dio.httpClientAdapter = _MockHttpClientAdapter((options) async {
        lastRequest = options;
        if (options.path.endsWith('/settlement/pdf')) {
          return ResponseBody.fromString(
            '<html><body><h1>Bảng kê tất toán</h1></body></html>',
            200,
            headers: {
              Headers.contentTypeHeader: ['text/html; charset=utf-8'],
            },
          );
        }
        return ResponseBody.fromString(
          jsonEncode({
            'success': true,
            'data': {'id': 'dep-123', 'status': 'HELD'},
            'message': 'OK',
          }),
          200,
          headers: {
            Headers.contentTypeHeader: [Headers.jsonContentType],
          },
        );
      });

      depositsService = DepositsService(dio: dio, queryCache: queryCache);
    });

    test('1. list sends GET /api/v1/deposits and caches for 20s', () async {
      final res = await depositsService.list({'building_id': 'b-1'});
      expect(res, isNotNull);
      expect(lastRequest.method, 'GET');
      expect(lastRequest.path, '/api/v1/deposits');
      expect(lastRequest.queryParameters['building_id'], 'b-1');

      // Subsequent call hits cache
      lastRequest = RequestOptions(path: '/uncalled');
      final cached = await depositsService.list({'building_id': 'b-1'});
      expect(cached, isNotNull);
      expect(lastRequest.path, '/uncalled');

      // Force refresh bypasses cache
      final forced = await depositsService.list({'building_id': 'b-1'}, true);
      expect(forced, isNotNull);
      expect(lastRequest.path, '/api/v1/deposits');
    });

    test('2. peekList reads synchronously from cache', () async {
      expect(depositsService.peekList({'building_id': 'b-1'}), isNull);
      await depositsService.list({'building_id': 'b-1'});
      final peeked = depositsService.peekList({'building_id': 'b-1'});
      expect(peeked, isNotNull);
    });

    test('3. listTransactions sends GET /api/v1/deposits/:id/transactions', () async {
      await depositsService.listTransactions('dep-123');
      expect(lastRequest.method, 'GET');
      expect(lastRequest.path, '/api/v1/deposits/dep-123/transactions');
    });

    test('4. getAuditLogs sends GET /api/v1/deposits/:id/audit-logs', () async {
      await depositsService.getAuditLogs('dep-123');
      expect(lastRequest.method, 'GET');
      expect(lastRequest.path, '/api/v1/deposits/dep-123/audit-logs');
    });

    test('5. createTransaction sends POST /api/v1/deposits/:id/transactions with idempotency header', () async {
      final payload = {'type': 'collect', 'amount': 5000000};
      await depositsService.createTransaction('dep-123', payload);
      expect(lastRequest.method, 'POST');
      expect(lastRequest.path, '/api/v1/deposits/dep-123/transactions');
      expect(lastRequest.data, payload);
      expect(lastRequest.headers['Idempotency-Key'], isNotNull);
    });

    test('6. getSettlement sends GET /api/v1/deposits/:id/settlement', () async {
      await depositsService.getSettlement('dep-123');
      expect(lastRequest.method, 'GET');
      expect(lastRequest.path, '/api/v1/deposits/dep-123/settlement');
    });

    test('7. submitSettlement sends POST /api/v1/deposits/:id/settlement with idempotency header', () async {
      final payload = {'deductions': [], 'refund_method': 'BANK_TRANSFER'};
      await depositsService.submitSettlement('dep-123', payload);
      expect(lastRequest.method, 'POST');
      expect(lastRequest.path, '/api/v1/deposits/dep-123/settlement');
      expect(lastRequest.headers['Idempotency-Key'], isNotNull);
    });

    test('8. approveSettlement sends POST /api/v1/deposits/:id/settlement/approve with idempotency header', () async {
      await depositsService.approveSettlement('dep-123');
      expect(lastRequest.method, 'POST');
      expect(lastRequest.path, '/api/v1/deposits/dep-123/settlement/approve');
      expect(lastRequest.headers['Idempotency-Key'], isNotNull);
    });

    test('9. rejectSettlement sends POST /api/v1/deposits/:id/settlement/reject with idempotency header', () async {
      await depositsService.rejectSettlement('dep-123', {'reason': 'Cần kiểm tra lại tiền điện'});
      expect(lastRequest.method, 'POST');
      expect(lastRequest.path, '/api/v1/deposits/dep-123/settlement/reject');
      expect(lastRequest.data['reason'], 'Cần kiểm tra lại tiền điện');
      expect(lastRequest.headers['Idempotency-Key'], isNotNull);
    });

    test('10. dispute sends POST /api/v1/deposits/:id/dispute with idempotency header', () async {
      await depositsService.dispute('dep-123', {'reason': 'Cư dân không đồng ý phí vệ sinh'});
      expect(lastRequest.method, 'POST');
      expect(lastRequest.path, '/api/v1/deposits/dep-123/dispute');
      expect(lastRequest.headers['Idempotency-Key'], isNotNull);
    });

    test('11. resolveDispute sends POST /api/v1/deposits/:id/resolve-dispute with idempotency header', () async {
      await depositsService.resolveDispute('dep-123', {'resolution': 'ADJUST', 'reason': 'Chấp nhận giảm 500k'});
      expect(lastRequest.method, 'POST');
      expect(lastRequest.path, '/api/v1/deposits/dep-123/resolve-dispute');
      expect(lastRequest.headers['Idempotency-Key'], isNotNull);
    });

    test('12. executePayout sends POST /api/v1/deposits/:id/payout with idempotency header', () async {
      await depositsService.executePayout('dep-123', {'reference_code': 'UNC999', 'evidence': ['https://file.url']});
      expect(lastRequest.method, 'POST');
      expect(lastRequest.path, '/api/v1/deposits/dep-123/payout');
      expect(lastRequest.headers['Idempotency-Key'], isNotNull);
    });

    test('13. markPayoutReturned sends POST /api/v1/deposits/:id/payout-returned with idempotency header', () async {
      await depositsService.markPayoutReturned('dep-123', {'reason': 'Sai số tài khoản'});
      expect(lastRequest.method, 'POST');
      expect(lastRequest.path, '/api/v1/deposits/dep-123/payout-returned');
      expect(lastRequest.headers['Idempotency-Key'], isNotNull);
    });

    test('14. updateRefundBankInfo sends PATCH /api/v1/deposits/:id/bank-info with idempotency header', () async {
      await depositsService.updateRefundBankInfo('dep-123', {'bank_info': {'bank_name': 'VCB', 'account_number': '123'}});
      expect(lastRequest.method, 'PATCH');
      expect(lastRequest.path, '/api/v1/deposits/dep-123/bank-info');
      expect(lastRequest.headers['Idempotency-Key'], isNotNull);
    });

    test('15. getSettlementPdfHtml sends GET /api/v1/deposits/:id/settlement/pdf with ResponseType.plain', () async {
      final html = await depositsService.getSettlementPdfHtml('dep-123');
      expect(html, contains('Bảng kê tất toán'));
      expect(lastRequest.method, 'GET');
      expect(lastRequest.path, '/api/v1/deposits/dep-123/settlement/pdf');
      expect(lastRequest.responseType, ResponseType.plain);
    });

    test('16. depositsServiceProvider provides configured DepositsService', () {
      final container = ProviderContainer(
        overrides: [
          dioProvider.overrideWithValue(dio),
          queryCacheProvider.overrideWithValue(queryCache),
        ],
      );
      final service = container.read(depositsServiceProvider);
      expect(service, isA<DepositsService>());
      expect(service.dio, equals(dio));
    });
  });

  group('resolveSettlementPayoutSummary (separation of deposit refund vs credit refund)', () {
    test('separates deposit refund and credit balance refund clearly', () {
      final summary = resolveSettlementPayoutSummary({
        'deposit_refund_amount': 5000000,
        'credit_refund_amount': 750000,
        'total_payout_amount': 5750000,
      });

      expect(summary.depositRefund, 5000000);
      expect(summary.creditRefund, 750000);
      expect(summary.totalPayout, 5750000);
      expect(summary.hasCreditRefund, isTrue);
    });

    test('calculates totalPayout if not explicitly provided', () {
      final summary = resolveSettlementPayoutSummary({
        'depositRefund': '3000000',
        'creditRefund': '200000',
      });

      expect(summary.depositRefund, 3000000);
      expect(summary.creditRefund, 200000);
      expect(summary.totalPayout, 3200000);
      expect(summary.hasCreditRefund, isTrue);
    });

    test('handles zero credit refund correctly', () {
      final summary = resolveSettlementPayoutSummary({
        'refund_amount': 2000000,
        'credit_refund_amount': 0,
      });

      expect(summary.depositRefund, 2000000);
      expect(summary.creditRefund, 0);
      expect(summary.totalPayout, 2000000);
      expect(summary.hasCreditRefund, isFalse);
    });
  });

  group('4-Eyes canActorApproveDepositRow gating', () {
    test('creator cannot self-approve when allowSelfApproval is false', () {
      final canApprove = canActorApproveDepositRow(
        isOwner: true,
        currentUserId: 'user-manager-1',
        createdBy: 'user-manager-1',
        buildingHasActiveOwner: true,
        allowSelfApproval: false,
      );
      expect(canApprove, isFalse);
    });

    test('creator can approve when allowSelfApproval is true', () {
      final canApprove = canActorApproveDepositRow(
        isOwner: true,
        currentUserId: 'user-owner-1',
        createdBy: 'user-owner-1',
        buildingHasActiveOwner: true,
        allowSelfApproval: true,
      );
      expect(canApprove, isTrue);
    });

    test('owner can approve settlement submitted by manager', () {
      final canApprove = canActorApproveDepositRow(
        isOwner: true,
        currentUserId: 'user-owner-1',
        createdBy: 'user-manager-1',
        buildingHasActiveOwner: true,
        allowSelfApproval: false,
      );
      expect(canApprove, isTrue);
    });

    test('sys_admin fallback approval when building has NO active owner', () {
      final canApprove = canActorApproveDepositRow(
        isSysAdmin: true,
        currentUserId: 'user-admin-1',
        createdBy: 'user-manager-1',
        buildingHasActiveOwner: false,
        allowSelfApproval: false,
      );
      expect(canApprove, isTrue);
    });

    test('sys_admin CANNOT approve if building HAS active owner (owner must approve)', () {
      final canApprove = canActorApproveDepositRow(
        isSysAdmin: true,
        currentUserId: 'user-admin-1',
        createdBy: 'user-manager-1',
        buildingHasActiveOwner: true,
        allowSelfApproval: false,
      );
      expect(canApprove, isFalse);
    });
  });

  group('canCollectAdditionalDeposit gating', () {
    test('returns true only for HELD deposit with active contract and deposit shortage', () {
      final valid = canCollectAdditionalDeposit({
        'status': 'HELD',
        'contract_status': 'ACTIVE',
        'deposit_amount': 10000000,
        'amount_held': 5000000,
      });
      expect(valid, isTrue);

      final fullDeposit = canCollectAdditionalDeposit({
        'status': 'HELD',
        'contract_status': 'ACTIVE',
        'deposit_amount': 10000000,
        'amount_held': 10000000,
      });
      expect(fullDeposit, isFalse);

      final wrongStatus = canCollectAdditionalDeposit({
        'status': 'PENDING_APPROVAL',
        'contract_status': 'ACTIVE',
        'deposit_amount': 10000000,
        'amount_held': 5000000,
      });
      expect(wrongStatus, isFalse);

      final inactiveContract = canCollectAdditionalDeposit({
        'status': 'HELD',
        'contract_status': 'EXPIRED',
        'deposit_amount': 10000000,
        'amount_held': 5000000,
      });
      expect(inactiveContract, isFalse);
    });
  });

  group('DepositsPage & DepositDetailModal UI & Deep linking', () {
    late FakeDepositsService fakeService;
    late AppStorage storage;

    final mockDeposit1 = {
      'id': 'dep-001',
      'building_id': 'b-1',
      'building_name': 'Tòa Landmark 81',
      'apartment_code': 'P101',
      'tenant_name': 'Nguyễn Văn An',
      'tenant_phone': '0901234567',
      'amount_held': 10000000,
      'deposit_amount': 10000000,
      'status': 'HELD',
      'contract_id': 'ct-101',
      'contract_status': 'ACTIVE',
      'building_has_active_owner': true,
      'settlement': null,
    };

    final mockDepositSettlement = {
      'id': 'dep-002',
      'building_id': 'b-1',
      'building_name': 'Tòa Landmark 81',
      'apartment_code': 'P102',
      'tenant_name': 'Trần Thị Bình',
      'tenant_phone': '0912345678',
      'amount_held': 15000000,
      'deposit_amount': 15000000,
      'status': 'PENDING_APPROVAL',
      'contract_id': 'ct-102',
      'contract_status': 'TERMINATION_PENDING',
      'building_has_active_owner': true,
      'settlement': {
        'id': 'stl-002',
        'deposit_id': 'dep-002',
        'created_by': 'user-manager-1',
        'status': 'PENDING_APPROVAL',
        'outstanding_debt': 1000000,
        'calculated_refund_amount': 13000000,
        'deposit_refund_amount': 13000000,
        'credit_refund_amount': 500000,
        'total_payout_amount': 13500000,
        'refund_method': 'BANK_TRANSFER',
        'bank_info': {
          'bank_name': 'Vietcombank',
          'bank_code': 'VCB',
          'account_number': '001100223344',
          'account_holder': 'TRAN THI BINH',
        },
        'items': [
          {
            'category': 'CLEANING',
            'amount': 1000000,
            'description': 'Vệ sinh sàn nhà',
            'evidence': [],
          }
        ],
      },
    };

    setUp(() async {
      fakeService = FakeDepositsService([mockDeposit1, mockDepositSettlement]);
      SharedPreferences.setMockInitialValues({});
      final prefs = await SharedPreferences.getInstance();
      storage = AppStorage(prefs: prefs, isWeb: true);
      await storage.init();
    });

    Widget buildTestApp({
      required UserModel user,
      String? initialDepositId,
      String? initialModal,
      void Function(ProviderContainer)? onContainer,
    }) {
      final container = ProviderContainer(
        overrides: [
          appStorageProvider.overrideWithValue(storage),
          depositsServiceProvider.overrideWithValue(fakeService),
          permissionProvider.overrideWithValue(PermissionMatrix(user)),
        ],
      );

      container.read(authProvider.notifier).setAuthData(
            accessToken: 'test-token',
            refreshToken: 'test-refresh',
            user: user,
          );

      onContainer?.call(container);

      return UncontrolledProviderScope(
        container: container,
        child: MaterialApp(
          home: Scaffold(
            body: DepositsPage(
              initialDepositId: initialDepositId,
              initialModal: initialModal,
            ),
          ),
        ),
      );
    }

    testWidgets('renders DepositsPage with tabs and stats card', (tester) async {
      await tester.binding.setSurfaceSize(const Size(1280, 800));

      const testUser = UserModel(
        id: 'user-mgr-1',
        fullName: 'Quản lý Nguyễn',
        phone: '0900000001',
        roles: [UserRoleModel(code: 'MANAGER')],
      );

      await tester.pumpWidget(buildTestApp(user: testUser));
      await tester.pumpAndSettle();

      expect(find.text('Sổ cọc hợp đồng'), findsOneWidget);
      expect(find.textContaining('Đang giữ'), findsWidgets);
      expect(find.textContaining('Chờ duyệt'), findsWidgets);
      expect(find.textContaining('Đã hoàn cọc'), findsWidgets);
      expect(find.textContaining('Tranh chấp'), findsWidgets);
      expect(find.text('P101'), findsOneWidget);
      expect(find.text('Sổ giao dịch'), findsWidgets);
    });

    testWidgets('deep links directly to settlement modal when initialDepositId and initialModal=settlement are passed', (tester) async {
      await tester.binding.setSurfaceSize(const Size(1280, 800));

      const testUser = UserModel(
        id: 'user-owner-1',
        fullName: 'Chủ nhà Lê',
        phone: '0900000002',
        roles: [UserRoleModel(code: 'OWNER')],
      );

      await tester.pumpWidget(
        buildTestApp(
          user: testUser,
          initialDepositId: 'dep-002',
          initialModal: 'settlement',
        ),
      );

      await tester.pumpAndSettle();

      // Settlement modal should be opened for dep-002
      expect(find.byType(DepositDetailModal), findsOneWidget);
      expect(find.textContaining('TRAN THI BINH'), findsWidgets);
      // Separation of deposit refund vs credit balance refund
      expect(find.textContaining('13.000.000'), findsWidgets);
      expect(find.textContaining('500.000'), findsWidgets);
    });

    testWidgets('surfaces API errors via toastProvider on action failure', (tester) async {
      await tester.binding.setSurfaceSize(const Size(1280, 800));

      fakeService.throwOnApprove = Exception('Lỗi từ chối phê duyệt do không đủ quyền');

      const testUser = UserModel(
        id: 'user-owner-1',
        fullName: 'Chủ nhà Lê',
        phone: '0900000002',
        roles: [UserRoleModel(code: 'OWNER')],
      );

      late ProviderContainer container;

      await tester.pumpWidget(
        buildTestApp(
          user: testUser,
          initialDepositId: 'dep-002',
          initialModal: 'settlement',
          onContainer: (c) => container = c,
        ),
      );

      await tester.pumpAndSettle();

      // Find approve button and tap it
      final approveBtn = find.text('Phê duyệt tất toán');
      expect(approveBtn, findsOneWidget);
      await tester.tap(approveBtn);
      await tester.pumpAndSettle();

      // Confirm dialog appears
      final confirmBtn = find.text('Xác nhận duyệt');
      expect(confirmBtn, findsOneWidget);
      await tester.tap(confirmBtn);
      await tester.pumpAndSettle();

      // Toast state should have error
      final toasts = container.read(toastProvider);
      expect(toasts.any((t) => t.message.contains('Lỗi từ chối phê duyệt') || t.variant == ToastVariant.error), isTrue);

      // Drain toast auto-dismiss timer
      await tester.pump(const Duration(seconds: 6));
    });

    testWidgets('propose settlement: FileUploadField evidence required, live draft recalculation, and submitSettlement uses items key with evidence', (tester) async {
      await tester.binding.setSurfaceSize(const Size(1280, 1400));

      const testUser = UserModel(
        id: 'user-mgr-1',
        fullName: 'Quản lý Nguyễn',
        phone: '0900000001',
        roles: [UserRoleModel(code: 'MANAGER')],
      );

      late ProviderContainer container;

      await tester.pumpWidget(
        buildTestApp(
          user: testUser,
          initialDepositId: 'dep-001',
          initialModal: 'settlement',
          onContainer: (c) => container = c,
        ),
      );

      await tester.pumpAndSettle();

      // Modal is open for dep-001 (HELD state)
      expect(find.byType(DepositDetailModal), findsOneWidget);

      // Live draft initial summary: held 10,000,000 - debt 1,000,000 = 9,000,000
      expect(find.textContaining('9.000.000'), findsWidgets);

      // Tap "+ Thêm khoản khấu trừ"
      final addDeductBtn = find.text('+ Thêm khoản khấu trừ');
      expect(addDeductBtn, findsOneWidget);
      await tester.tap(addDeductBtn);
      await tester.pumpAndSettle();

      // Dialog is open
      expect(find.text('Thêm khoản khấu trừ'), findsOneWidget);
      expect(find.byType(FileUploadField), findsWidgets);

      // Enter amount: 2000000
      final moneyInputs = find.byType(MoneyInput);
      await tester.enterText(moneyInputs.first, '2000000');
      await tester.pumpAndSettle();

      // Enter description: 'Hỏng sofa phòng khách'
      final textFields = find.byType(TextField);
      await tester.enterText(textFields.last, 'Hỏng sofa phòng khách');
      await tester.pumpAndSettle();

      // Try tapping "Thêm" without evidence -> warning toast
      final submitAddBtn = find.widgetWithText(ElevatedButton, 'Thêm');
      await tester.tap(submitAddBtn);
      await tester.pumpAndSettle();

      final toastsBefore = container.read(toastProvider);
      expect(toastsBefore.any((t) => t.message.contains('bằng chứng') || t.message.contains('FR-023')), isTrue);
      // Dialog should still be open
      expect(find.text('Thêm khoản khấu trừ'), findsOneWidget);

      // Bind evidence via FileUploadField
      final uploadField = tester.widget<FileUploadField>(find.byKey(const ValueKey('deduction_evidence_upload')));
      uploadField.onChanged?.call(['data:image/png;base64,iVBORw0KGgo=']);
      await tester.pumpAndSettle();

      // Now tap "Thêm" again
      await tester.tap(submitAddBtn);
      await tester.pumpAndSettle();

      // Dialog closed and deduction row is present
      expect(find.text('Thêm khoản khấu trừ'), findsNothing);
      expect(find.text('Hỏng sofa phòng khách'), findsOneWidget);
      expect(find.textContaining('1 minh chứng'), findsOneWidget);

      // Live draft recalculation: 10,000,000 held - 1,000,000 debt - 2,000,000 deduction = 7,000,000
      expect(find.textContaining('7.000.000'), findsWidgets);

      // Fill bank info
      final bankSelect = tester.widget<BankSelect>(find.byType(BankSelect));
      bankSelect.onBankChange?.call('VCB', {'shortName': 'Vietcombank'});
      await tester.pumpAndSettle();

      final accInputs = find.byType(AppInput);
      await tester.enterText(accInputs.first, '0123456789'); // account number
      await tester.pumpAndSettle();

      // Submit settlement proposal
      final submitSettlementBtn = find.text('Trình duyệt quyết toán 4 mắt');
      expect(submitSettlementBtn, findsOneWidget);
      await tester.ensureVisible(submitSettlementBtn);
      await tester.pumpAndSettle();
      await tester.tap(submitSettlementBtn);
      await tester.pumpAndSettle();

      // Verify payload sent to DepositsService.submitSettlement
      expect(fakeService.lastSubmittedSettlementPayload, isNotNull);
      final payload = fakeService.lastSubmittedSettlementPayload!;
      expect(payload.containsKey('items'), isTrue);
      expect(payload.containsKey('deductions'), isFalse);
      expect(payload['items'], isA<List>());
      final items = payload['items'] as List;
      expect(items.length, 1);
      final item0 = items[0] as Map;
      expect(item0['category'], 'DAMAGE');
      expect(item0['amount'], 2000000);
      expect(item0['description'], 'Hỏng sofa phòng khách');
      expect(item0['evidence'], isA<List>());
      expect((item0['evidence'] as List).isNotEmpty, isTrue);

      // Drain toast timer
      await tester.pump(const Duration(seconds: 6));
    });
  });
}

class FakeDepositsService extends Fake implements DepositsService {
  final List<Map<String, dynamic>> deposits;
  Exception? throwOnApprove;
  Map<String, dynamic>? lastSubmittedSettlementPayload;

  FakeDepositsService(this.deposits);

  @override
  dynamic peekList([Map<String, dynamic>? params]) => null;

  @override
  Future<dynamic> list([Map<String, dynamic>? params, bool force = false]) async {
    return {'data': deposits};
  }

  @override
  Future<dynamic> listTransactions(String id) async {
    return {'data': []};
  }

  @override
  Future<dynamic> getAuditLogs(String id) async {
    return {'data': []};
  }

  @override
  Future<dynamic> getSettlement(String id) async {
    final dep = deposits.firstWhere((d) => d['id'] == id, orElse: () => deposits.first);
    return {
      'data': {
        ...dep,
        'calculated_service_debt': 1000000,
        'settlement': dep['settlement'],
      }
    };
  }

  @override
  Future<dynamic> submitSettlement(String id, Map<String, dynamic> payload, [Options? options]) async {
    lastSubmittedSettlementPayload = payload;
    return {
      'success': true,
      'message': 'Đã trình hồ sơ quyết toán cọc chờ phê duyệt 4 mắt.',
      'data': {'status': 'PENDING_APPROVAL'},
    };
  }

  @override
  Future<dynamic> approveSettlement(String id, [Map<String, dynamic>? payload, Options? options]) async {
    if (throwOnApprove != null) throw throwOnApprove!;
    return {'success': true, 'data': {'status': 'APPROVED_PENDING_PAYOUT'}};
  }

  @override
  Future<dynamic> rejectSettlement(String id, Map<String, dynamic> payload, [Options? options]) async {
    return {'success': true, 'data': {'status': 'SETTLEMENT_DRAFT'}};
  }

  @override
  Future<dynamic> dispute(String id, Map<String, dynamic> payload, [Options? options]) async {
    return {'success': true, 'data': {'status': 'DISPUTED'}};
  }

  @override
  Future<dynamic> resolveDispute(String id, Map<String, dynamic> payload, [Options? options]) async {
    return {'success': true, 'data': {'status': 'APPROVED_PENDING_PAYOUT'}};
  }

  @override
  Future<dynamic> executePayout(String id, Map<String, dynamic> payload, [Options? options]) async {
    return {'success': true, 'data': {'status': 'REFUNDED'}};
  }

  @override
  Future<dynamic> markPayoutReturned(String id, Map<String, dynamic> payload, [Options? options]) async {
    return {'success': true, 'data': {'status': 'RETURNED'}};
  }

  @override
  Future<dynamic> updateRefundBankInfo(String id, Map<String, dynamic> payload, [Options? options]) async {
    return {'success': true, 'data': {'settlement': {}}};
  }

  @override
  Future<dynamic> createTransaction(String id, Map<String, dynamic> payload, [Options? options]) async {
    return {'success': true, 'data': {}};
  }

  @override
  Future<String> getSettlementPdfHtml(String id) async {
    return '<html><body>Bảng kê tất toán</body></html>';
  }
}
