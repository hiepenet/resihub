import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:flutter_resihub/core/network/query_cache.dart';
import 'package:flutter_resihub/core/storage/app_storage.dart';
import 'package:flutter_resihub/core/theme/app_theme.dart';
import 'package:flutter_resihub/core/utils/billing_helpers.dart';
import 'package:flutter_resihub/features/auth/models/user_model.dart';
import 'package:flutter_resihub/features/auth/providers/auth_provider.dart';
import 'package:flutter_resihub/features/buildings/services/buildings_service.dart';
import 'package:flutter_resihub/features/invoices/screens/invoice_detail_page.dart';
import 'package:flutter_resihub/features/invoices/screens/invoices_page.dart';
import 'package:flutter_resihub/features/invoices/services/invoices_service.dart';
import 'package:flutter_resihub/features/payments/screens/payments_page.dart';
import 'package:flutter_resihub/features/payments/services/payments_service.dart';
import 'package:flutter_resihub/shared/widgets/ui/app_button.dart';

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

Widget _buildTestApp({
  required Widget child,
  required String roleCode,
  required AppStorage storage,
  List<Override> overrides = const [],
  String? buildingId,
}) {
  final user = UserModel(
    id: 'user-$roleCode',
    fullName: 'User $roleCode',
    email: '$roleCode@resihub.test',
    roles: [UserRoleModel(code: roleCode, buildingId: buildingId)],
  );

  final container = ProviderContainer(
    overrides: [
      appStorageProvider.overrideWithValue(storage),
      ...overrides,
    ],
  );

  container.read(authProvider.notifier).setAuthData(
        accessToken: 'test-token',
        refreshToken: 'test-refresh',
        user: user,
      );

  return UncontrolledProviderScope(
    container: container,
    child: MaterialApp(
      theme: buildAppTheme(),
      home: Scaffold(body: child),
    ),
  );
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late AppStorage storage;

  setUp(() async {
    SharedPreferences.setMockInitialValues({});
    final prefs = await SharedPreferences.getInstance();
    storage = AppStorage(prefs: prefs, isWeb: true);
  });

  group('InvoicesService - 13 methods & query caching', () {
    late Dio dio;
    late QueryCache queryCache;
    late InvoicesService invoicesService;
    late RequestOptions lastRequest;

    setUp(() {
      dio = Dio(BaseOptions(baseUrl: 'http://localhost:3000'));
      queryCache = QueryCache();

      dio.httpClientAdapter = _MockHttpClientAdapter((options) async {
        lastRequest = options;
        return ResponseBody.fromString(
          jsonEncode({
            'success': true,
            'data': [
              {
                'id': 'inv-1',
                'invoice_code': 'INV-202611-001',
                'status': 'DRAFT',
                'period': '2026-11',
                'total_amount': 5500000,
                'paid_amount': 0,
                'remaining_amount': 5500000,
                'apartment_code': '101',
                'building_code': 'B1',
              }
            ],
            'summary': {
              'total_billed': 5500000,
              'total_paid': 0,
              'total_unpaid': 5500000,
            }
          }),
          200,
          headers: {
            Headers.contentTypeHeader: [Headers.jsonContentType],
          },
        );
      });

      invoicesService = InvoicesService(dio: dio, queryCache: queryCache);
    });

    test('1. list sends GET /api/v1/invoices and caches response', () async {
      final res = await invoicesService.list({'building_id': 'b-1'});
      expect(res, isNotNull);
      expect(lastRequest.method, 'GET');
      expect(lastRequest.path, '/api/v1/invoices');
      expect(lastRequest.queryParameters['building_id'], 'b-1');

      // Subsequent call without force hits cache
      lastRequest = RequestOptions(path: '/should-not-hit');
      final cached = await invoicesService.list({'building_id': 'b-1'});
      expect(cached, isNotNull);
      expect(lastRequest.path, '/should-not-hit');

      // peekList returns cached data
      final peeked = invoicesService.peekList({'building_id': 'b-1'});
      expect(peeked, isNotNull);
    });

    test('2. getById sends GET /api/v1/invoices/:id and caches', () async {
      final res = await invoicesService.getById('inv-1');
      expect(res, isNotNull);
      expect(lastRequest.method, 'GET');
      expect(lastRequest.path, '/api/v1/invoices/inv-1');

      final peeked = invoicesService.peekById('inv-1');
      expect(peeked, isNotNull);
    });

    test('3. generateBatch sends POST /api/v1/invoices/generate-batch', () async {
      final payload = {'period': '2026-11', 'building_id': 'b-1', 'auto_issue': false};
      await invoicesService.generateBatch(payload);
      expect(lastRequest.method, 'POST');
      expect(lastRequest.path, '/api/v1/invoices/generate-batch');
      expect(lastRequest.data, payload);
    });

    test('4. updateStatus sends PATCH /api/v1/invoices/:id/status', () async {
      await invoicesService.updateStatus('inv-1', {'status': 'ISSUED'});
      expect(lastRequest.method, 'PATCH');
      expect(lastRequest.path, '/api/v1/invoices/inv-1/status');
      expect(lastRequest.data, {'status': 'ISSUED'});
    });

    test('5. addLine sends POST /api/v1/invoices/:id/lines', () async {
      final payload = {'item_type': 'SERVICE', 'description': 'Giặt là', 'quantity': 1, 'unit_price': 50000};
      await invoicesService.addLine('inv-1', payload);
      expect(lastRequest.method, 'POST');
      expect(lastRequest.path, '/api/v1/invoices/inv-1/lines');
      expect(lastRequest.data, payload);
    });

    test('6. updateLine sends PATCH /api/v1/invoices/:id/lines/:lineId', () async {
      final payload = {'unit_price': 60000};
      await invoicesService.updateLine('inv-1', 'line-1', payload);
      expect(lastRequest.method, 'PATCH');
      expect(lastRequest.path, '/api/v1/invoices/inv-1/lines/line-1');
      expect(lastRequest.data, payload);
    });

    test('7. deleteLine sends DELETE /api/v1/invoices/:id/lines/:lineId', () async {
      await invoicesService.deleteLine('inv-1', 'line-1');
      expect(lastRequest.method, 'DELETE');
      expect(lastRequest.path, '/api/v1/invoices/inv-1/lines/line-1');
    });

    test('8. issue sends POST /api/v1/invoices/:id/issue', () async {
      await invoicesService.issue('inv-1');
      expect(lastRequest.method, 'POST');
      expect(lastRequest.path, '/api/v1/invoices/inv-1/issue');
    });

    test('9. requestAdjustment sends POST /api/v1/invoices/:id/adjust', () async {
      final payload = {'action_type': 'VOID', 'confirm_invoice_code': 'INV-001', 'reason': 'Sai sot'};
      await invoicesService.requestAdjustment('inv-1', payload);
      expect(lastRequest.method, 'POST');
      expect(lastRequest.path, '/api/v1/invoices/inv-1/adjust');
      expect(lastRequest.data, payload);
    });

    test('10. getAdjustments sends GET /api/v1/invoices/adjustments and caches', () async {
      final res = await invoicesService.getAdjustments({'status': 'PENDING_APPROVAL'});
      expect(res, isNotNull);
      expect(lastRequest.method, 'GET');
      expect(lastRequest.path, '/api/v1/invoices/adjustments');
      expect(lastRequest.queryParameters['status'], 'PENDING_APPROVAL');

      final peeked = invoicesService.peekAdjustments({'status': 'PENDING_APPROVAL'});
      expect(peeked, isNotNull);
    });

    test('11. approveAdjustment sends POST /api/v1/invoices/:id/adjustments/:adjId/approve', () async {
      await invoicesService.approveAdjustment('inv-1', 'adj-1');
      expect(lastRequest.method, 'POST');
      expect(lastRequest.path, '/api/v1/invoices/inv-1/adjustments/adj-1/approve');
    });

    test('12. rejectAdjustment sends POST /api/v1/invoices/:id/adjustments/:adjId/reject', () async {
      final payload = {'rejection_reason': 'Không đủ cơ sở'};
      await invoicesService.rejectAdjustment('inv-1', 'adj-1', payload);
      expect(lastRequest.method, 'POST');
      expect(lastRequest.path, '/api/v1/invoices/inv-1/adjustments/adj-1/reject');
      expect(lastRequest.data, payload);
    });

    test('13. getAuditLogs sends GET /api/v1/invoices/:id/audit-logs', () async {
      await invoicesService.getAuditLogs('inv-1');
      expect(lastRequest.method, 'GET');
      expect(lastRequest.path, '/api/v1/invoices/inv-1/audit-logs');
    });
  });

  group('PaymentsService - 9 methods & query caching', () {
    late Dio dio;
    late QueryCache queryCache;
    late PaymentsService paymentsService;
    late RequestOptions lastRequest;

    setUp(() {
      dio = Dio(BaseOptions(baseUrl: 'http://localhost:3000'));
      queryCache = QueryCache();

      dio.httpClientAdapter = _MockHttpClientAdapter((options) async {
        lastRequest = options;
        return ResponseBody.fromString(
          jsonEncode({
            'success': true,
            'data': [
              {
                'id': 'pay-1',
                'payment_code': 'PAY-001',
                'amount': 3000000,
                'status': 'PENDING_CONFIRMATION',
                'method': 'BANK_TRANSFER',
              }
            ],
          }),
          200,
          headers: {
            Headers.contentTypeHeader: [Headers.jsonContentType],
          },
        );
      });

      paymentsService = PaymentsService(dio: dio, queryCache: queryCache);
    });

    test('1. list sends GET /api/v1/payments and caches', () async {
      final res = await paymentsService.list({'status': 'CONFIRMED'});
      expect(res, isNotNull);
      expect(lastRequest.method, 'GET');
      expect(lastRequest.path, '/api/v1/payments');
      expect(lastRequest.queryParameters['status'], 'CONFIRMED');

      final peeked = paymentsService.peekList({'status': 'CONFIRMED'});
      expect(peeked, isNotNull);
    });

    test('2. create sends POST /api/v1/payments', () async {
      final payload = {'invoice_id': 'inv-1', 'amount': 3000000, 'method': 'BANK_TRANSFER'};
      await paymentsService.create(payload);
      expect(lastRequest.method, 'POST');
      expect(lastRequest.path, '/api/v1/payments');
      expect(lastRequest.data, payload);
    });

    test('3. confirm sends PATCH /api/v1/payments/:id/confirm', () async {
      await paymentsService.confirm('pay-1', {'note': 'Đã khớp sao kê'});
      expect(lastRequest.method, 'PATCH');
      expect(lastRequest.path, '/api/v1/payments/pay-1/confirm');
      expect(lastRequest.data, {'note': 'Đã khớp sao kê'});
    });

    test('4. reject sends PATCH /api/v1/payments/:id/reject', () async {
      await paymentsService.reject('pay-1', {'reason': 'Ảnh mờ không rõ'});
      expect(lastRequest.method, 'PATCH');
      expect(lastRequest.path, '/api/v1/payments/pay-1/reject');
      expect(lastRequest.data, {'reason': 'Ảnh mờ không rõ'});
    });

    test('5. listReceivables sends GET /api/v1/receivables and caches', () async {
      final res = await paymentsService.listReceivables({'status': 'OPEN'});
      expect(res, isNotNull);
      expect(lastRequest.method, 'GET');
      expect(lastRequest.path, '/api/v1/receivables');

      final peeked = paymentsService.peekReceivables({'status': 'OPEN'});
      expect(peeked, isNotNull);
    });

    test('6. getCredits sends GET /api/v1/payments/credits and caches', () async {
      final res = await paymentsService.getCredits({'status': 'AVAILABLE'});
      expect(res, isNotNull);
      expect(lastRequest.method, 'GET');
      expect(lastRequest.path, '/api/v1/payments/credits');

      final peeked = paymentsService.peekCredits({'status': 'AVAILABLE'});
      expect(peeked, isNotNull);
    });

    test('7. requestCreditRefund sends POST /api/v1/payments/credits/:id/refund', () async {
      final payload = {'amount': 500000, 'reason': 'Hoàn trả tiền thừa'};
      await paymentsService.requestCreditRefund('cred-1', payload);
      expect(lastRequest.method, 'POST');
      expect(lastRequest.path, '/api/v1/payments/credits/cred-1/refund');
      expect(lastRequest.data, payload);
    });

    test('8. approveCreditRefund sends POST /api/v1/payments/credits/:id/refund/approve', () async {
      await paymentsService.approveCreditRefund('cred-1');
      expect(lastRequest.method, 'POST');
      expect(lastRequest.path, '/api/v1/payments/credits/cred-1/refund/approve');
    });

    test('9. rejectCreditRefund sends POST /api/v1/payments/credits/:id/refund/reject', () async {
      final payload = {'rejection_reason': 'Thông tin STK sai'};
      await paymentsService.rejectCreditRefund('cred-1', payload);
      expect(lastRequest.method, 'POST');
      expect(lastRequest.path, '/api/v1/payments/credits/cred-1/refund/reject');
      expect(lastRequest.data, payload);
    });
  });

  group('2-Step Void & 4-Eyes Helpers', () {
    test('canConfirmInvoiceVoid requires exact matching code and non-empty reason', () {
      final invoice = {'invoice_code': 'INV-2026-999'};

      // Code mismatch -> false
      expect(
        canConfirmInvoiceVoid(
          invoice: invoice,
          typedInvoiceCode: 'INV-WRONG',
          reason: 'Lý do hủy hợp lệ',
        ),
        isFalse,
      );

      // Empty reason -> false
      expect(
        canConfirmInvoiceVoid(
          invoice: invoice,
          typedInvoiceCode: 'INV-2026-999',
          reason: '   ',
        ),
        isFalse,
      );

      // Null reason -> false
      expect(
        canConfirmInvoiceVoid(
          invoice: invoice,
          typedInvoiceCode: 'INV-2026-999',
          reason: null,
        ),
        isFalse,
      );

      // Matched code + valid reason -> true
      expect(
        canConfirmInvoiceVoid(
          invoice: invoice,
          typedInvoiceCode: 'INV-2026-999',
          reason: 'Khách thanh lý hợp đồng trước hạn',
        ),
        isTrue,
      );
    });

    test('canActorApproveInvoiceAdjustment & canActorApproveCreditRefund 4-eyes rules', () {
      final creator = {'id': 'user-1', 'role': 'MANAGER'};
      final record = {'created_by': 'user-1', 'amount': 1000000};

      // 1. Self-approval blocked
      expect(
        canActorApproveInvoiceAdjustment(
          actor: creator,
          record: record,
        ),
        isFalse,
      );

      // 2. Different MANAGER can approve
      final otherManager = {'id': 'user-2', 'role': 'MANAGER'};
      expect(
        canActorApproveInvoiceAdjustment(
          actor: otherManager,
          record: record,
        ),
        isTrue,
      );

      // 3. OWNER can approve
      final owner = {'id': 'user-3', 'role': 'OWNER'};
      expect(
        canActorApproveInvoiceAdjustment(
          actor: owner,
          record: record,
        ),
        isTrue,
      );

      // 4. SYS_ADMIN fallback only when building has no active owner
      final sysAdmin = {'id': 'user-4', 'role': 'SYS_ADMIN'};
      expect(
        canActorApproveInvoiceAdjustment(
          actor: sysAdmin,
          record: record,
          buildingHasActiveOwner: true,
        ),
        isFalse,
      );
      expect(
        canActorApproveInvoiceAdjustment(
          actor: sysAdmin,
          record: record,
          buildingHasActiveOwner: false,
        ),
        isTrue,
      );

      // Credit refund behaves identically
      expect(
        canActorApproveCreditRefund(
          actor: otherManager,
          record: record,
        ),
        isTrue,
      );
    });
  });

  group('InvoicesPage Widget Tests', () {
    final fakeInvoices = [
      {
        'id': 'inv-101',
        'invoice_code': 'INV-202611-101',
        'status': 'DRAFT',
        'period': '2026-11',
        'total_amount': 6000000,
        'paid_amount': 0,
        'remaining_amount': 6000000,
        'apartment_code': 'A101',
        'building_code': 'SUN',
        'tenant_name': 'Nguyễn Văn A',
        'tenant_phone': '0901234567',
        'due_date': '2026-11-15',
        'issue_date': '2026-11-01',
      },
      {
        'id': 'inv-102',
        'invoice_code': 'INV-202611-102',
        'status': 'ISSUED',
        'period': '2026-11',
        'total_amount': 4500000,
        'paid_amount': 2000000,
        'remaining_amount': 2500000,
        'apartment_code': 'A102',
        'building_code': 'SUN',
        'tenant_name': 'Trần Thị B',
        'tenant_phone': '0909888777',
        'due_date': '2026-11-15',
        'issue_date': '2026-11-01',
      },
    ];

    testWidgets('MANAGER sees operational buttons (batch generate & issue)', (tester) async {
      tester.view.physicalSize = const Size(1280, 900);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(() => tester.view.resetPhysicalSize());

      final dio = Dio();
      dio.httpClientAdapter = _MockHttpClientAdapter((options) async {
        if (options.path.contains('/adjustments')) {
          return ResponseBody.fromString(jsonEncode({'success': true, 'data': []}), 200, headers: {Headers.contentTypeHeader: [Headers.jsonContentType]});
        }
        return ResponseBody.fromString(
          jsonEncode({
            'success': true,
            'data': fakeInvoices,
            'summary': {
              'total_billed': 10500000,
              'total_paid': 2000000,
              'total_unpaid': 8500000,
            }
          }),
          200,
          headers: {Headers.contentTypeHeader: [Headers.jsonContentType]},
        );
      });
      final mockInvoicesService = InvoicesService(dio: dio);
      final mockBuildingsService = BuildingsService(dio: dio);

      await tester.pumpWidget(
        _buildTestApp(
          child: const InvoicesPage(),
          roleCode: 'MANAGER',
          storage: storage,
          overrides: [
            invoicesServiceProvider.overrideWithValue(mockInvoicesService),
            buildingsServiceProvider.overrideWithValue(mockBuildingsService),
          ],
        ),
      );

      await tester.pumpAndSettle();

      // Verify page title and KPI cards
      expect(find.text('Quản lý Hóa đơn Kỳ'), findsOneWidget);
      expect(find.text('Sinh hóa đơn hàng loạt kỳ này'), findsOneWidget);

      // Verify invoices list items
      expect(find.text('INV-202611-101'), findsOneWidget);
      expect(find.text('INV-202611-102'), findsOneWidget);

      // DRAFT invoice has "Phát hành" button for MANAGER
      expect(find.text('Phát hành'), findsOneWidget);
    });

    testWidgets('OWNER has read-only view without batch generate and quick issue buttons', (tester) async {
      tester.view.physicalSize = const Size(1280, 900);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(() => tester.view.resetPhysicalSize());

      final dio = Dio();
      dio.httpClientAdapter = _MockHttpClientAdapter((options) async {
        if (options.path.contains('/adjustments')) {
          return ResponseBody.fromString(jsonEncode({'success': true, 'data': []}), 200, headers: {Headers.contentTypeHeader: [Headers.jsonContentType]});
        }
        return ResponseBody.fromString(
          jsonEncode({
            'success': true,
            'data': fakeInvoices,
            'summary': {
              'total_billed': 10500000,
              'total_paid': 2000000,
              'total_unpaid': 8500000,
            }
          }),
          200,
          headers: {Headers.contentTypeHeader: [Headers.jsonContentType]},
        );
      });
      final mockInvoicesService = InvoicesService(dio: dio);
      final mockBuildingsService = BuildingsService(dio: dio);

      await tester.pumpWidget(
        _buildTestApp(
          child: const InvoicesPage(),
          roleCode: 'OWNER',
          storage: storage,
          overrides: [
            invoicesServiceProvider.overrideWithValue(mockInvoicesService),
            buildingsServiceProvider.overrideWithValue(mockBuildingsService),
          ],
        ),
      );

      await tester.pumpAndSettle();

      // OWNER should NOT see "Sinh hóa đơn hàng loạt kỳ này" or "Phát hành"
      expect(find.text('Sinh hóa đơn hàng loạt kỳ này'), findsNothing);
      expect(find.text('Phát hành'), findsNothing);
    });
  });

  group('InvoicesPage parity B22-B24', () {
    ResponseBody jsonRes(Map<String, dynamic> body) => ResponseBody.fromString(
          jsonEncode(body),
          200,
          headers: {Headers.contentTypeHeader: [Headers.jsonContentType]},
        );

    Future<void> pumpPage(
      WidgetTester tester, {
      String roleCode = 'MANAGER',
      String? buildingId,
      List<Map<String, dynamic>> buildings = const [
        {'id': 'b-1', 'code': 'SUN', 'name': 'Sun Tower'},
      ],
    }) async {
      tester.view.physicalSize = const Size(1280, 900);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(() => tester.view.resetPhysicalSize());

      final dio = Dio();
      dio.httpClientAdapter = _MockHttpClientAdapter((options) async {
        if (options.path.contains('/adjustments')) {
          return jsonRes({'success': true, 'data': []});
        }
        if (options.path == '/api/v1/buildings') {
          return jsonRes({'success': true, 'data': buildings});
        }
        return jsonRes({
          'success': true,
          'data': [
            {
              'id': 'inv-201',
              'invoice_code': 'INV-202611-201',
              'status': 'DRAFT',
              'period': '2026-11',
              'total_amount': 1000000,
              'paid_amount': 0,
              'remaining_amount': 1000000,
              'apartment_code': 'A101',
              'building_code': 'SUN',
            }
          ],
          'summary': {
            'total_billed': 1000000,
            'total_paid': 0,
            'total_unpaid': 1000000,
          },
        });
      });

      await tester.pumpWidget(
        _buildTestApp(
          child: const InvoicesPage(),
          roleCode: roleCode,
          storage: storage,
          buildingId: buildingId,
          overrides: [
            invoicesServiceProvider.overrideWithValue(InvoicesService(dio: dio)),
            buildingsServiceProvider.overrideWithValue(BuildingsService(dio: dio)),
          ],
        ),
      );
      await tester.pumpAndSettle();
    }

    testWidgets('B22: status filter includes CANCELLED (Đã hủy)', (tester) async {
      await pumpPage(tester);

      await tester.tap(find.text('Tất cả trạng thái'));
      await tester.pumpAndSettle();

      final searchField = find.byWidgetPredicate(
        (w) => w is TextField && w.decoration?.hintText == 'Tìm kiếm...',
      );
      expect(searchField, findsOneWidget);
      await tester.enterText(searchField, 'Đã hủy');
      await tester.pumpAndSettle();

      // VOID + CANCELLED đều có nhãn "Đã hủy" (khớp React INVOICE_STATUS).
      expect(find.widgetWithText(ListTile, 'Đã hủy'), findsNWidgets(2));
    });

    testWidgets('B23: period field rejects invalid YYYY-MM month', (tester) async {
      await pumpPage(tester);

      await tester.enterText(find.byType(TextFormField).first, '2026-13');
      await tester.pumpAndSettle();

      expect(find.text('Kỳ không hợp lệ (định dạng YYYY-MM)'), findsOneWidget);
    });

    testWidgets('B24: building scope hidden when a building is selected', (tester) async {
      await pumpPage(tester, buildingId: 'b-selected');

      await tester.tap(find.text('Sinh hóa đơn hàng loạt kỳ này'));
      await tester.pumpAndSettle();

      expect(find.text('Sinh hóa đơn hàng loạt theo kỳ'), findsOneWidget);
      expect(find.text('Phạm vi tòa nhà'), findsNothing);
    });
  });

  group('InvoiceDetailPage - 2-step Void & Details', () {
    final fakeDetail = {
      'id': 'inv-detail-1',
      'invoice_code': 'INV-202611-088',
      'status': 'ISSUED',
      'period': '2026-11',
      'subtotal_amount': 5000000,
      'adjustment_amount': 0,
      'total_amount': 5000000,
      'paid_amount': 0,
      'apartment_code': '302',
      'building_name': 'Sun Tower',
      'contract_code': 'HD-302',
      'tenant_name': 'Phạm Văn C',
      'tenant_phone': '0912345678',
      'due_date': '2026-11-20',
      'issue_date': '2026-11-05',
      'lines': [
        {
          'id': 'l-1',
          'item_type': 'RENT',
          'description': 'Tiền thuê tháng 11',
          'quantity': 1,
          'unit': 'tháng',
          'unit_price': 5000000,
          'amount': 5000000,
        }
      ],
    };

    testWidgets('2-step VOID modal disabled when code mismatches, enabled when matched + reason', (tester) async {
      tester.view.physicalSize = const Size(1280, 1000);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(() => tester.view.resetPhysicalSize());

      final dio = Dio();
      dio.httpClientAdapter = _MockHttpClientAdapter((options) async {
        if (options.path.contains('/adjustments')) {
          return ResponseBody.fromString(jsonEncode({'success': true, 'data': []}), 200, headers: {Headers.contentTypeHeader: [Headers.jsonContentType]});
        }
        if (options.path.contains('/audit-logs')) {
          return ResponseBody.fromString(jsonEncode({'success': true, 'data': []}), 200, headers: {Headers.contentTypeHeader: [Headers.jsonContentType]});
        }
        return ResponseBody.fromString(
          jsonEncode({'success': true, 'data': fakeDetail}),
          200,
          headers: {Headers.contentTypeHeader: [Headers.jsonContentType]},
        );
      });
      final mockInvoicesService = InvoicesService(dio: dio);

      await tester.pumpWidget(
        _buildTestApp(
          child: const InvoiceDetailPage(invoiceId: 'inv-detail-1'),
          roleCode: 'MANAGER',
          storage: storage,
          overrides: [
            invoicesServiceProvider.overrideWithValue(mockInvoicesService),
          ],
        ),
      );

      await tester.pumpAndSettle();

      expect(find.textContaining('INV-202611-088'), findsWidgets);
      expect(find.text('Hủy hóa đơn (VOID)'), findsOneWidget);

      // Click "Hủy hóa đơn (VOID)" to open modal
      await tester.tap(find.text('Hủy hóa đơn (VOID)'));
      await tester.pumpAndSettle();

      expect(find.text('Xác nhận Hủy hóa đơn đã phát hành (VOID)'), findsOneWidget);

      // Confirm button finder inside modal
      final confirmVoidBtn = find.widgetWithText(AppButton, 'Xác nhận gửi đề nghị VOID');
      expect(confirmVoidBtn, findsOneWidget);

      // Initially disabled
      AppButton btnWidget = tester.widget<AppButton>(confirmVoidBtn);
      expect(btnWidget.disabled, isTrue);

      // Type WRONG code
      final inputs = find.byType(TextField);
      expect(inputs, findsWidgets);

      await tester.enterText(inputs.first, 'WRONG-CODE');
      await tester.pumpAndSettle();
      btnWidget = tester.widget<AppButton>(confirmVoidBtn);
      expect(btnWidget.disabled, isTrue);

      // Type CORRECT code but empty reason
      await tester.enterText(inputs.first, 'INV-202611-088');
      await tester.pumpAndSettle();
      btnWidget = tester.widget<AppButton>(confirmVoidBtn);
      expect(btnWidget.disabled, isTrue);

      // Enter valid non-empty reason
      await tester.enterText(inputs.at(1), 'Khách đã trả phòng trước kỳ');
      await tester.pumpAndSettle();

      // Now enabled!
      btnWidget = tester.widget<AppButton>(confirmVoidBtn);
      expect(btnWidget.disabled, isFalse);
    });
  });

  group('PaymentsPage Widget Tests - 4 Tabs & Aging Buckets', () {
    final fakePayments = [
      {
        'id': 'pay-001',
        'payment_code': 'PAY-202611-001',
        'apartment_code': '101',
        'building_code': 'SUN',
        'tenant_name': 'Nguyễn Văn An',
        'invoice_code': 'INV-202611-001',
        'method': 'BANK_TRANSFER',
        'amount': 5000000,
        'overpayment_amount': 500000,
        'status': 'PENDING_CONFIRMATION',
        'paid_at': '2026-11-10T10:00:00Z',
        'proof_images': ['https://example.com/proof1.png'],
      },
    ];

    final fakeReceivables = [
      {
        'id': 'rec-001',
        'apartment_code': '101',
        'building_code': 'SUN',
        'tenant_name': 'Nguyễn Văn An',
        'invoice_code': 'INV-202611-001',
        'amount': 5000000,
        'paid_amount': 2000000,
        'balance': 3000000,
        'status': 'OPEN',
        'due_date': '2026-11-01',
        'days_overdue': 12, // bucket '0_15'
      },
      {
        'id': 'rec-002',
        'apartment_code': '202',
        'building_code': 'SUN',
        'tenant_name': 'Lê Văn Bình',
        'invoice_code': 'INV-202611-002',
        'amount': 4000000,
        'paid_amount': 0,
        'balance': 4000000,
        'status': 'OPEN',
        'due_date': '2026-10-15',
        'days_overdue': 28, // bucket '16_30'
      },
    ];

    final fakeCredits = [
      {
        'id': 'cred-001',
        'apartment_code': '101',
        'building_code': 'SUN',
        'tenant_name': 'Nguyễn Văn An',
        'amount': 500000,
        'applied_amount': 0,
        'status': 'AVAILABLE',
        'description': 'Nộp thừa tiền điện kỳ trước',
        'created_at': '2026-11-01T08:00:00Z',
      },
      {
        'id': 'cred-002',
        'apartment_code': '202',
        'building_code': 'SUN',
        'tenant_name': 'Lê Văn Bình',
        'amount': 300000,
        'applied_amount': 0,
        'status': 'PENDING_DIRECT_REFUND',
        'description': 'Đề nghị hoàn tiền thừa sau thanh lý',
        'created_at': '2026-11-05T08:00:00Z',
        'refund_meta': {
          'requested_by': 'mgr-other',
          'amount': 300000,
          'reason': 'Khách thanh lý hợp đồng',
        },
      },
    ];

    testWidgets('Renders all 4 tabs and supports switching', (tester) async {
      tester.view.physicalSize = const Size(1920, 1080);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(() => tester.view.resetPhysicalSize());

      String? lastListQueryOverpayment;

      final dio = Dio();
      dio.httpClientAdapter = _MockHttpClientAdapter((options) async {
        if (options.path.contains('/payments/credits')) {
          return ResponseBody.fromString(jsonEncode({'success': true, 'data': fakeCredits}), 200, headers: {Headers.contentTypeHeader: [Headers.jsonContentType]});
        }
        if (options.path.contains('/receivables')) {
          return ResponseBody.fromString(
            jsonEncode({
              'success': true,
              'data': fakeReceivables,
              'aging_summary_prd': {
                'current_not_due': 0,
                'bucket_0_15': 3000000,
                'bucket_16_30': 4000000,
                'bucket_31_60': 0,
                'bucket_over_60': 0,
                'total_balance': 7000000,
              }
            }),
            200,
            headers: {Headers.contentTypeHeader: [Headers.jsonContentType]},
          );
        }
        if (options.path == '/api/v1/payments') {
          lastListQueryOverpayment = options.queryParameters['overpayment_only']?.toString();
          return ResponseBody.fromString(
            jsonEncode({'success': true, 'data': fakePayments}),
            200,
            headers: {Headers.contentTypeHeader: [Headers.jsonContentType]},
          );
        }
        return ResponseBody.fromString(jsonEncode({'success': true, 'data': []}), 200, headers: {Headers.contentTypeHeader: [Headers.jsonContentType]});
      });

      final paymentsService = PaymentsService(dio: dio);

      await tester.pumpWidget(
        _buildTestApp(
          child: const PaymentsPage(),
          roleCode: 'MANAGER',
          storage: storage,
          overrides: [
            paymentsServiceProvider.overrideWithValue(paymentsService),
          ],
        ),
      );

      await tester.pumpAndSettle();

      // Check all 4 tab titles present
      expect(find.text('Giao dịch thanh toán'), findsOneWidget);
      expect(find.text('Công nợ theo tuổi nợ (AC-016.1)'), findsOneWidget);
      expect(find.text('Sổ tín dụng / Hoàn tiền (4 mắt)'), findsOneWidget);
      expect(find.text('Thanh toán thừa'), findsOneWidget);

      // Tab 1 active: shows PAY-202611-001
      expect(find.text('PAY-202611-001'), findsWidgets);

      // Switch to Tab 2: aging
      await tester.tap(find.text('Công nợ theo tuổi nợ (AC-016.1)'));
      await tester.pumpAndSettle();
      expect(find.text('CHƯA ĐẾN HẠN'), findsWidgets);
      expect(find.text('TUỔI NỢ 0–15 NGÀY'), findsOneWidget);
      expect(find.text('TUỔI NỢ 16–30 NGÀY'), findsOneWidget);
      expect(find.text('TUỔI NỢ 31–60 NGÀY'), findsOneWidget);
      expect(find.text('TUỔI NỢ > 60 NGÀY'), findsOneWidget);

      // Switch to Tab 3: credits
      await tester.tap(find.text('Sổ tín dụng / Hoàn tiền (4 mắt)'));
      await tester.pumpAndSettle();
      expect(find.text('TỔNG SỐ DƯ TÍN DỤNG'), findsOneWidget);
      expect(find.text('Nộp thừa tiền điện kỳ trước'), findsOneWidget);
      expect(find.text('Đề nghị hoàn tiền thừa sau thanh lý'), findsOneWidget);

      // Switch to Tab 4: overpayments
      await tester.ensureVisible(find.text('Thanh toán thừa'));
      await tester.tap(find.text('Thanh toán thừa'));
      await tester.pumpAndSettle();
      expect(find.text('SỐ GIAO DỊCH NỘP THỪA'), findsOneWidget);
      expect(lastListQueryOverpayment, 'true');
    });

    testWidgets('initialTab aging with initialBucket filters receivables properly', (tester) async {
      tester.view.physicalSize = const Size(1280, 1000);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(() => tester.view.resetPhysicalSize());

      final dio = Dio();
      dio.httpClientAdapter = _MockHttpClientAdapter((options) async {
        if (options.path.contains('/receivables')) {
          return ResponseBody.fromString(
            jsonEncode({
              'success': true,
              'data': fakeReceivables,
              'aging_summary_prd': {
                'current_not_due': 0,
                'bucket_0_15': 3000000,
                'bucket_16_30': 4000000,
                'bucket_31_60': 0,
                'bucket_over_60': 0,
                'total_balance': 7000000,
              }
            }),
            200,
            headers: {Headers.contentTypeHeader: [Headers.jsonContentType]},
          );
        }
        return ResponseBody.fromString(jsonEncode({'success': true, 'data': []}), 200, headers: {Headers.contentTypeHeader: [Headers.jsonContentType]});
      });

      final paymentsService = PaymentsService(dio: dio);

      await tester.pumpWidget(
        _buildTestApp(
          child: const PaymentsPage(initialTab: 'aging', initialBucket: '16_30'),
          roleCode: 'MANAGER',
          storage: storage,
          overrides: [
            paymentsServiceProvider.overrideWithValue(paymentsService),
          ],
        ),
      );

      await tester.pumpAndSettle();

      // Only bucket 16_30 item visible (Lê Văn Bình, căn 202)
      expect(find.textContaining('Căn 202'), findsOneWidget);
      expect(find.textContaining('Căn 101'), findsNothing);
    });
  });
}
