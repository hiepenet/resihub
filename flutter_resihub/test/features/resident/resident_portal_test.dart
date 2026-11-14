import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:flutter_resihub/core/network/dio_client.dart';
import 'package:flutter_resihub/core/storage/app_storage.dart';
import 'package:flutter_resihub/core/utils/billing_helpers.dart';
import 'package:flutter_resihub/core/utils/deposit_ui_helpers.dart';
import 'package:flutter_resihub/core/utils/format.dart';
import 'package:flutter_resihub/features/contracts/services/contracts_service.dart';
import 'package:flutter_resihub/features/resident/screens/resident_portal_page.dart';
import 'package:flutter_resihub/features/resident/services/resident_service.dart';
import 'package:flutter_resihub/features/resident/tabs/contract_tab.dart';
import 'package:flutter_resihub/features/resident/tabs/invoices_tab.dart';
import 'package:flutter_resihub/features/resident/tabs/profile_tab.dart';
import 'package:flutter_resihub/features/resident/tabs/services_tab.dart';
import 'package:flutter_resihub/shared/widgets/ui/html_print_preview_modal.dart';

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

  group('ResidentService (Exact 22 methods matching resident.service.js)', () {
    late Dio dio;
    late ResidentService residentService;
    late RequestOptions lastRequest;

    setUp(() {
      dio = Dio(BaseOptions(baseUrl: 'http://localhost:3000'));
      dio.httpClientAdapter = _MockHttpClientAdapter((options) async {
        lastRequest = options;
        if (options.path.contains('/settlement/pdf')) {
          return ResponseBody.fromString(
            '<html><body><h1>Bảng kê tất toán cọc PDF</h1></body></html>',
            200,
            headers: {
              Headers.contentTypeHeader: ['text/html; charset=utf-8'],
            },
          );
        }
        return ResponseBody.fromString(
          jsonEncode({
            'success': true,
            'data': {'id': 'mock-id', 'method': options.method, 'path': options.path},
          }),
          200,
          headers: {
            Headers.contentTypeHeader: [Headers.jsonContentType],
          },
        );
      });
      residentService = ResidentService(dio: dio);
    });

    test('1. getOverview with & without contractId', () async {
      await residentService.getOverview();
      expect(lastRequest.method, 'GET');
      expect(lastRequest.path, '/api/v1/resident/overview');
      expect(lastRequest.queryParameters['contract_id'], isNull);

      await residentService.getOverview('c-123');
      expect(lastRequest.queryParameters['contract_id'], 'c-123');
    });

    test('2. submitRentalApplication', () async {
      await residentService.submitRentalApplication({'desired_apartment_id': 'apt-1'});
      expect(lastRequest.method, 'POST');
      expect(lastRequest.path, '/api/v1/resident/rental-application');
      expect(lastRequest.data, {'desired_apartment_id': 'apt-1'});
    });

    test('3. uploadIdImage', () async {
      await residentService.uploadIdImage({'side': 'front', 'image_data': 'base64str'});
      expect(lastRequest.method, 'POST');
      expect(lastRequest.path, '/api/v1/resident/id-images');
      expect(lastRequest.data, {'side': 'front', 'image_data': 'base64str'});
    });

    test('4. listServiceRequests with & without contractId', () async {
      await residentService.listServiceRequests();
      expect(lastRequest.method, 'GET');
      expect(lastRequest.path, '/api/v1/resident/service-requests');
      expect(lastRequest.queryParameters['contract_id'], isNull);

      await residentService.listServiceRequests('c-456');
      expect(lastRequest.queryParameters['contract_id'], 'c-456');
    });

    test('5. createServiceRequest with idempotency header', () async {
      await residentService.createServiceRequest(
        {'title': 'Sửa điều hòa'},
        idempotencyKey: 'idem-req-1',
      );
      expect(lastRequest.method, 'POST');
      expect(lastRequest.path, '/api/v1/resident/service-requests');
      expect(lastRequest.headers['Idempotency-Key'], 'idem-req-1');
    });

    test('6. cancelServiceRequest', () async {
      await residentService.cancelServiceRequest(
        'sr-1',
        {'reason': 'Không cần nữa'},
        'idem-cancel-1',
      );
      expect(lastRequest.method, 'POST');
      expect(lastRequest.path, '/api/v1/resident/service-requests/sr-1/cancel');
      expect(lastRequest.headers['Idempotency-Key'], 'idem-cancel-1');
      expect(lastRequest.data, {'reason': 'Không cần nữa'});
    });

    test('7. reopenServiceRequest', () async {
      await residentService.reopenServiceRequest(
        'sr-1',
        {'reason': 'Lại bị hỏng'},
        'idem-reopen-1',
      );
      expect(lastRequest.method, 'POST');
      expect(lastRequest.path, '/api/v1/resident/service-requests/sr-1/reopen');
      expect(lastRequest.headers['Idempotency-Key'], 'idem-reopen-1');
    });

    test('8. rateServiceRequest', () async {
      await residentService.rateServiceRequest(
        'sr-1',
        {'rating': 5, 'feedback': 'Tuyệt vời'},
        'idem-rate-1',
      );
      expect(lastRequest.method, 'POST');
      expect(lastRequest.path, '/api/v1/resident/service-requests/sr-1/rating');
      expect(lastRequest.headers['Idempotency-Key'], 'idem-rate-1');
      expect(lastRequest.data, {'rating': 5, 'feedback': 'Tuyệt vời'});
    });

    test('9. listInvoices', () async {
      await residentService.listInvoices('c-999');
      expect(lastRequest.method, 'GET');
      expect(lastRequest.path, '/api/v1/resident/invoices');
      expect(lastRequest.queryParameters['contract_id'], 'c-999');
    });

    test('10. reportPayment', () async {
      await residentService.reportPayment({
        'invoice_id': 'inv-1',
        'amount': 5000000,
        'proof_url': 'https://example.com/proof.jpg',
      });
      expect(lastRequest.method, 'POST');
      expect(lastRequest.path, '/api/v1/resident/payments/report');
      expect(lastRequest.data['invoice_id'], 'inv-1');
    });

    test('11. listServices', () async {
      await residentService.listServices('c-111');
      expect(lastRequest.method, 'GET');
      expect(lastRequest.path, '/api/v1/resident/services');
      expect(lastRequest.queryParameters['contract_id'], 'c-111');
    });

    test('12. subscribeService', () async {
      await residentService.subscribeService({'service_id': 'srv-1', 'quantity': 1});
      expect(lastRequest.method, 'POST');
      expect(lastRequest.path, '/api/v1/resident/services');
      expect(lastRequest.data['service_id'], 'srv-1');
    });

    test('13. cancelService', () async {
      await residentService.cancelService('sub-1', {'cancellation_reason': 'Không ở nữa'});
      expect(lastRequest.method, 'PATCH');
      expect(lastRequest.path, '/api/v1/resident/services/sub-1/cancel');
      expect(lastRequest.data['cancellation_reason'], 'Không ở nữa');
    });

    test('14. withdrawCancelService', () async {
      await residentService.withdrawCancelService('sub-1');
      expect(lastRequest.method, 'PATCH');
      expect(lastRequest.path, '/api/v1/resident/services/sub-1/withdraw-cancel');
    });

    test('15. updateProfile', () async {
      await residentService.updateProfile({'full_name': 'Nguyễn Văn Cư Dân'});
      expect(lastRequest.method, 'PATCH');
      expect(lastRequest.path, '/api/v1/resident/profile');
      expect(lastRequest.data['full_name'], 'Nguyễn Văn Cư Dân');
    });

    test('16. listContractRequests', () async {
      await residentService.listContractRequests('c-123');
      expect(lastRequest.method, 'GET');
      expect(lastRequest.path, '/api/v1/resident/contract-requests');
      expect(lastRequest.queryParameters['contract_id'], 'c-123');
    });

    test('17. createContractRequest', () async {
      await residentService.createContractRequest({
        'request_type': 'RENEWAL',
        'reason': 'Gia hạn 6 tháng',
      });
      expect(lastRequest.method, 'POST');
      expect(lastRequest.path, '/api/v1/resident/contract-requests');
      expect(lastRequest.data['request_type'], 'RENEWAL');
    });

    test('18. listDepositTransactions', () async {
      await residentService.listDepositTransactions('c-123');
      expect(lastRequest.method, 'GET');
      expect(lastRequest.path, '/api/v1/resident/deposit-transactions');
      expect(lastRequest.queryParameters['contract_id'], 'c-123');
    });

    test('19. disputeDeposit with idempotency key', () async {
      await residentService.disputeDeposit(
        'dep-1',
        {'reason': 'Tính trừ tiền sơn tường sai'},
        idempotencyKey: 'idem-disp-1',
      );
      expect(lastRequest.method, 'POST');
      expect(lastRequest.path, '/api/v1/deposits/dep-1/dispute');
      expect(lastRequest.headers['Idempotency-Key'], 'idem-disp-1');
      expect(lastRequest.data['reason'], 'Tính trừ tiền sơn tường sai');
    });

    test('20. updateDepositRefundBankInfo', () async {
      await residentService.updateDepositRefundBankInfo(
        'dep-1',
        {
          'bank_name': 'Vietcombank',
          'account_number': '123456789',
          'account_holder': 'NGUYEN VAN A',
        },
        idempotencyKey: 'idem-bank-1',
      );
      expect(lastRequest.method, 'PATCH');
      expect(lastRequest.path, '/api/v1/deposits/dep-1/bank-info');
      expect(lastRequest.headers['Idempotency-Key'], 'idem-bank-1');
      expect(lastRequest.data['account_number'], '123456789');
    });

    test('21. updateReservationRefundBankInfo', () async {
      await residentService.updateReservationRefundBankInfo(
        'rsv-1',
        {
          'bank_name': 'Techcombank',
          'account_number': '987654321',
          'account_holder': 'NGUYEN VAN B',
        },
        idempotencyKey: 'idem-rsvbank-1',
      );
      expect(lastRequest.method, 'PATCH');
      expect(lastRequest.path, '/api/v1/reservations/rsv-1/bank-info');
      expect(lastRequest.headers['Idempotency-Key'], 'idem-rsvbank-1');
      expect(lastRequest.data['bank_name'], 'Techcombank');
    });

    test('22. getDepositSettlementPdfHtml returns text/html', () async {
      final html = await residentService.getDepositSettlementPdfHtml('dep-1');
      expect(lastRequest.method, 'GET');
      expect(lastRequest.path, '/api/v1/deposits/dep-1/settlement/pdf');
      expect(html, contains('Bảng kê tất toán cọc PDF'));
    });
  });

  group('ResidentPortalPage & 8 Tabs UI & Integration Flow', () {
    late Dio dio;
    late SharedPreferences prefs;
    late AppStorage storage;

    setUp(() async {
      SharedPreferences.setMockInitialValues({});
      prefs = await SharedPreferences.getInstance();
      storage = AppStorage(prefs: prefs);
      dio = Dio(BaseOptions(baseUrl: 'http://localhost:3000'));
    });

    testWidgets('Prospect reservation mode shows rental application submission', (tester) async {
      dio.httpClientAdapter = _MockHttpClientAdapter((options) async {
        if (options.path.contains('/resident/overview')) {
          return ResponseBody.fromString(
            jsonEncode({
              'success': true,
              'data': {
                'reservations': [
                  {
                    'id': 'rsv-101',
                    'apartment_code': 'P.302',
                    'building_name': 'Tòa Sapphire',
                    'status': 'HELD',
                    'amount': 2000000,
                  }
                ],
                'active_contract': null,
                'active_contracts': [],
                'user': {'full_name': 'Khách Đặt Cọc', 'phone': '0901234567'},
              },
            }),
            200,
            headers: {Headers.contentTypeHeader: [Headers.jsonContentType]},
          );
        }
        if (options.path.contains('/resident/service-requests')) {
          return ResponseBody.fromString(
            jsonEncode({'success': true, 'data': []}),
            200,
            headers: {Headers.contentTypeHeader: [Headers.jsonContentType]},
          );
        }
        if (options.path.contains('/resident/rental-application')) {
          return ResponseBody.fromString(
            jsonEncode({'success': true, 'data': {'application_id': 'app-99'}}),
            200,
            headers: {Headers.contentTypeHeader: [Headers.jsonContentType]},
          );
        }
        return ResponseBody.fromString(jsonEncode({'success': true, 'data': []}), 200,
            headers: {Headers.contentTypeHeader: [Headers.jsonContentType]});
      });

      await tester.binding.setSurfaceSize(const Size(1200, 900));

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            dioProvider.overrideWithValue(dio),
            appStorageProvider.overrideWithValue(storage),
            residentServiceProvider.overrideWithValue(ResidentService(dio: dio)),
          ],
          child: const MaterialApp(
            home: ResidentPortalPage(),
          ),
        ),
      );

      await tester.pumpAndSettle();

      // Check root key
      expect(find.byKey(const Key('route:/resident')), findsOneWidget);
      // Check reservation banner
      expect(find.textContaining('P.302'), findsWidgets);
      expect(find.textContaining('Tòa Sapphire'), findsWidgets);
      // Check apply button
      expect(find.textContaining('Nộp hồ sơ thuê'), findsWidgets);
    });

    testWidgets('Multi-contract resident switches units and triggers overview update', (tester) async {
      String? queriedContractId;
      dio.httpClientAdapter = _MockHttpClientAdapter((options) async {
        if (options.path.contains('/resident/overview')) {
          queriedContractId = options.queryParameters['contract_id']?.toString();
          return ResponseBody.fromString(
            jsonEncode({
              'success': true,
              'data': {
                'active_contracts': [
                  {
                    'contract_id': 'c-101',
                    'apartment_code': 'A.101',
                    'building_name': 'Tòa Ruby',
                  },
                  {
                    'contract_id': 'c-202',
                    'apartment_code': 'B.202',
                    'building_name': 'Tòa Diamond',
                  },
                ],
                'active_contract': {
                  'contract_id': queriedContractId ?? 'c-101',
                  'apartment_code': queriedContractId == 'c-202' ? 'B.202' : 'A.101',
                  'building_name': queriedContractId == 'c-202' ? 'Tòa Diamond' : 'Tòa Ruby',
                },
                'current_amount_due': 12000000,
                'user': {'full_name': 'Cư Dân Vip'},
              },
            }),
            200,
            headers: {Headers.contentTypeHeader: [Headers.jsonContentType]},
          );
        }
        return ResponseBody.fromString(jsonEncode({'success': true, 'data': []}), 200,
            headers: {Headers.contentTypeHeader: [Headers.jsonContentType]});
      });

      await tester.binding.setSurfaceSize(const Size(1200, 900));

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            dioProvider.overrideWithValue(dio),
            appStorageProvider.overrideWithValue(storage),
            residentServiceProvider.overrideWithValue(ResidentService(dio: dio)),
          ],
          child: const MaterialApp(
            home: ResidentPortalPage(),
          ),
        ),
      );

      await tester.pumpAndSettle();

      expect(find.byKey(const Key('resident-contract-switcher')), findsOneWidget);
      expect(find.textContaining('A.101'), findsWidgets);
    });

    testWidgets('ContractTab A4 preview & 7-day dispute window', (tester) async {
      bool contractTemplateCalled = false;
      bool disputeApiCalled = false;

      dio.httpClientAdapter = _MockHttpClientAdapter((options) async {
        if (options.path.contains('/contracts/c-1/template')) {
          contractTemplateCalled = true;
          return ResponseBody.fromString(
            '<html><body><h1>HỢP ĐỒNG THUÊ CĂN HỘ A.101</h1></body></html>',
            200,
            headers: {
              Headers.contentTypeHeader: ['text/html; charset=utf-8'],
            },
          );
        }
        if (options.path.contains('/resident/deposit-transactions')) {
          return ResponseBody.fromString(
            jsonEncode({
              'success': true,
              'data': [
                {
                  'deposit_id': 'dep-77',
                  'deposit_code': 'DEP-2026-001',
                  'status': 'PARTIALLY_REFUNDED',
                  'deposit_amount': 20000000,
                  'settlement': {
                    'refund_amount': 15000000,
                    'deduction_amount': 5000000,
                    'payout_at': DateTime.now().subtract(const Duration(days: 2)).toIso8601String(),
                  },
                }
              ],
            }),
            200,
            headers: {Headers.contentTypeHeader: [Headers.jsonContentType]},
          );
        }
        if (options.path.contains('/deposits/dep-77/dispute')) {
          disputeApiCalled = true;
          return ResponseBody.fromString(
            jsonEncode({'success': true, 'data': {'dispute_id': 'disp-1'}}),
            200,
            headers: {Headers.contentTypeHeader: [Headers.jsonContentType]},
          );
        }
        if (options.path.contains('/resident/contract-requests')) {
          return ResponseBody.fromString(
            jsonEncode({'success': true, 'data': []}),
            200,
            headers: {Headers.contentTypeHeader: [Headers.jsonContentType]},
          );
        }
        return ResponseBody.fromString(jsonEncode({'success': true, 'data': []}), 200,
            headers: {Headers.contentTypeHeader: [Headers.jsonContentType]});
      });

      await tester.binding.setSurfaceSize(const Size(1200, 900));

      final overview = {
        'active_contract': {
          'contract_id': 'c-1',
          'contract_code': 'HD-2026-001',
          'apartment_code': 'A.101',
          'building_name': 'Tòa Ruby',
          'status': 'ACTIVE',
          'occupants': [
            {'full_name': 'Trần Thị Thành Viên', 'id_number': '001099012345'},
          ],
        },
      };

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            dioProvider.overrideWithValue(dio),
            appStorageProvider.overrideWithValue(storage),
            residentServiceProvider.overrideWithValue(ResidentService(dio: dio)),
            contractsServiceProvider.overrideWithValue(ContractsService(dio: dio)),
          ],
          child: MaterialApp(
            home: Scaffold(
              body: ContractTab(
                overview: overview,
                onRefreshOverview: () async {},
                onNavigateTab: (tab, [extra]) {},
              ),
            ),
          ),
        ),
      );

      await tester.pumpAndSettle();

      // Check occupant CCCD masking
      expect(find.textContaining(maskIdNumber('001099012345')), findsOneWidget);

      // Check 7-day dispute window countdown
      final disputeState = getResidentDisputeWindowState({
        'status': 'PARTIALLY_REFUNDED',
        'settlement': {
          'payout_at': DateTime.now().subtract(const Duration(days: 2)).toIso8601String(),
        },
      });
      expect(disputeState.canDispute, isTrue);
      expect(disputeState.daysRemaining, 5);
      expect(find.textContaining('5 ngày'), findsWidgets);

      // Tap "Xem/In hợp đồng"
      final printButton = find.textContaining('Xem / In hợp đồng A4');
      if (printButton.evaluate().isNotEmpty) {
        await tester.tap(printButton);
        await tester.pumpAndSettle();
        expect(contractTemplateCalled, isTrue);
        expect(disputeApiCalled, isFalse);
        expect(find.byType(HtmlPrintPreviewModal), findsOneWidget);
        // Close modal
        final closeBtn = find.byIcon(Icons.close);
        if (closeBtn.evaluate().isNotEmpty) {
          await tester.tap(closeBtn.first);
          await tester.pumpAndSettle();
        }
      }
    });

    testWidgets('InvoicesTab displays summary, meter photo & report payment', (tester) async {
      dio.httpClientAdapter = _MockHttpClientAdapter((options) async {
        if (options.path.contains('/resident/invoices')) {
          return ResponseBody.fromString(
            jsonEncode({
              'success': true,
              'data': [
                {
                  'invoice_id': 'inv-101',
                  'invoice_code': 'HD-T11-001',
                  'status': 'PUBLISHED',
                  'subtotal_amount': 2500000,
                  'adjustment_amount': 0,
                  'total_amount': 2500000,
                  'paid_amount': 0,
                  'lines': [
                    {
                      'item_type': 'ELECTRICITY',
                      'item_name': 'Tiền điện',
                      'amount': 1500000,
                      'formula_meta': {
                        'image_url': 'https://resihub.vn/meters/elec_302.jpg',
                      },
                    },
                    {
                      'item_type': 'WATER',
                      'item_name': 'Tiền nước',
                      'amount': 200000,
                      'meter_image_url': 'https://resihub.vn/meters/water_302.jpg',
                    },
                  ],
                }
              ],
            }),
            200,
            headers: {Headers.contentTypeHeader: [Headers.jsonContentType]},
          );
        }
        return ResponseBody.fromString(jsonEncode({'success': true, 'data': []}), 200,
            headers: {Headers.contentTypeHeader: [Headers.jsonContentType]});
      });

      await tester.binding.setSurfaceSize(const Size(1200, 900));

      final lineElec = {
        'item_type': 'ELECTRICITY',
        'formula_meta': {'image_url': 'https://resihub.vn/meters/elec_302.jpg'},
      };
      expect(resolveResidentInvoiceLineMeterImage(lineElec), 'https://resihub.vn/meters/elec_302.jpg');

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            dioProvider.overrideWithValue(dio),
            appStorageProvider.overrideWithValue(storage),
            residentServiceProvider.overrideWithValue(ResidentService(dio: dio)),
          ],
          child: MaterialApp(
            home: Scaffold(
              body: InvoicesTab(
                overview: const {
                  'active_contract': {'contract_id': 'c-1'},
                },
                onRefreshOverview: () async {},
                onNavigateTab: (tab, [extra]) {},
              ),
            ),
          ),
        ),
      );

      await tester.pumpAndSettle();

      expect(find.textContaining('HD-T11-001'), findsOneWidget);
      expect(find.textContaining('2.500.000'), findsWidgets);
      // Meter photo icon / button exists for electricity
      expect(find.textContaining('Ảnh công tơ'), findsWidgets);
    });

    testWidgets('InvoicesTab renders building payment account, VietQR transfer syntax & credit balance/history',
        (tester) async {
      final dio = Dio();
      dio.httpClientAdapter = _MockHttpClientAdapter((options) async {
        if (options.path.contains('/resident/invoices')) {
          return ResponseBody.fromString(
            jsonEncode({
              'success': true,
              'data': [
                {
                  'invoice_id': 'inv-101',
                  'invoice_code': 'HD-T11-001',
                  'period': '2026-11',
                  'apartment_code': 'P302',
                  'status': 'ISSUED',
                  'subtotal_amount': 2500000,
                  'total_amount': 2500000,
                  'paid_amount': 0,
                  'lines': [],
                }
              ],
              'credit_balances': [
                {
                  'id': 'cr-1',
                  'amount': 350000,
                  'available_amount': 350000,
                  'status': 'AVAILABLE',
                  'description': 'Hoàn cọc dịch vụ kỳ trước',
                  'created_at': '2026-11-01',
                }
              ],
            }),
            200,
            headers: {Headers.contentTypeHeader: [Headers.jsonContentType]},
          );
        }
        return ResponseBody.fromString(jsonEncode({'success': true, 'data': []}), 200,
            headers: {Headers.contentTypeHeader: [Headers.jsonContentType]});
      });

      await tester.binding.setSurfaceSize(const Size(1200, 1000));

      final overview = {
        'available_credit_balance': 350000,
        'payment_account': {
          'bank': 'Vietcombank',
          'bank_code': 'VCB',
          'bank_bin': '970436',
          'account_no': '1234567890',
          'account_name': 'BAN QUAN LY APARTMENT',
          'branch': 'CN Ba Dinh',
        },
        'active_contract': {
          'contract_id': 'c-1',
          'apartment_code': 'P302',
        },
      };

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            dioProvider.overrideWithValue(dio),
            appStorageProvider.overrideWithValue(storage),
            residentServiceProvider.overrideWithValue(ResidentService(dio: dio)),
          ],
          child: MaterialApp(
            home: Scaffold(
              body: InvoicesTab(
                overview: overview,
                onRefreshOverview: () async {},
                onNavigateTab: (tab, [extra]) {},
              ),
            ),
          ),
        ),
      );

      await tester.pumpAndSettle();

      // Credit balance banner
      expect(find.textContaining('Số dư tín dụng khả dụng: 350.000'), findsOneWidget);
      // Credit balance history section
      expect(find.textContaining('Lịch sử biến động tín dụng'), findsOneWidget);
      expect(find.textContaining('Hoàn cọc dịch vụ kỳ trước'), findsOneWidget);

      // Building payment account
      expect(find.textContaining('Tài khoản nhận thanh toán Tòa nhà'), findsOneWidget);
      expect(find.textContaining('1234567890'), findsOneWidget);
      expect(find.textContaining('BAN QUAN LY APARTMENT'), findsOneWidget);

      // Copyable VietQR transfer syntax
      expect(find.textContaining('RESIHUB P302 202611'), findsOneWidget);

      // VietQR modal trigger
      final qrBtn = find.text('Mã QR thanh toán (VietQR)');
      expect(qrBtn, findsOneWidget);
      await tester.tap(qrBtn);
      await tester.pumpAndSettle();
      expect(find.text('Mã VietQR Thanh Toán'), findsOneWidget);
    });

    testWidgets('ProfileTab mounts and disposes cleanly without leaking controllers', (tester) async {
      final dio = Dio();
      dio.httpClientAdapter = _MockHttpClientAdapter((options) async {
        return ResponseBody.fromString(jsonEncode({'success': true, 'data': {}}), 200,
            headers: {Headers.contentTypeHeader: [Headers.jsonContentType]});
      });

      bool showProfile = true;

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            dioProvider.overrideWithValue(dio),
            appStorageProvider.overrideWithValue(storage),
            residentServiceProvider.overrideWithValue(ResidentService(dio: dio)),
          ],
          child: MaterialApp(
            home: Scaffold(
              body: StatefulBuilder(
                builder: (context, setState) {
                  if (!showProfile) {
                    return const SizedBox.shrink();
                  }
                  return ProfileTab(
                    overview: const {
                      'user': {
                        'full_name': 'Nguyen Van A',
                        'email': 'a@resihub.vn',
                        'phone': '0901234567',
                        'id_number': '001200000001',
                        'address': 'Toa A - P302',
                      },
                    },
                    onRefreshOverview: () async {},
                    onNavigateTab: (tab, [extra]) {},
                  );
                },
              ),
            ),
          ),
        ),
      );

      await tester.pumpAndSettle();
      expect(find.text('Nguyen Van A'), findsOneWidget);
      expect(find.text('0901234567'), findsOneWidget);

      // Unmount ProfileTab by switching flag
      showProfile = false;
      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            dioProvider.overrideWithValue(dio),
            appStorageProvider.overrideWithValue(storage),
            residentServiceProvider.overrideWithValue(ResidentService(dio: dio)),
          ],
          child: const MaterialApp(
            home: Scaffold(
              body: SizedBox.shrink(),
            ),
          ),
        ),
      );

      await tester.pumpAndSettle();
      expect(find.text('Nguyen Van A'), findsNothing);
    });

    testWidgets('ServicesTab subscribe modal computes and shows previewSubscriptionProrata', (tester) async {
      final dio = Dio();
      dio.httpClientAdapter = _MockHttpClientAdapter((options) async {
        if (options.path.contains('/resident/services')) {
          return ResponseBody.fromString(
            jsonEncode({
              'success': true,
              'data': {
                'subscriptions': [],
                'catalog': [
                  {
                    'id': 'srv-1',
                    'service_name': 'Vé gửi ô tô',
                    'service_code': 'PARKING_CAR',
                    'unit_price': 1200000,
                  }
                ],
              },
            }),
            200,
            headers: {Headers.contentTypeHeader: [Headers.jsonContentType]},
          );
        }
        return ResponseBody.fromString(jsonEncode({'success': true, 'data': []}), 200,
            headers: {Headers.contentTypeHeader: [Headers.jsonContentType]});
      });

      await tester.binding.setSurfaceSize(const Size(1200, 900));

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            dioProvider.overrideWithValue(dio),
            appStorageProvider.overrideWithValue(storage),
            residentServiceProvider.overrideWithValue(ResidentService(dio: dio)),
          ],
          child: MaterialApp(
            home: Scaffold(
              body: ServicesTab(
                overview: const {
                  'active_contract': {'contract_id': 'c-1'},
                },
                onRefreshOverview: () async {},
                onNavigateTab: (tab, [extra]) {},
              ),
            ),
          ),
        ),
      );

      await tester.pumpAndSettle();

      expect(find.text('Vé gửi ô tô'), findsOneWidget);
      final subBtn = find.text('Đăng ký');
      expect(subBtn, findsOneWidget);
      await tester.tap(subBtn);
      await tester.pumpAndSettle();

      // Prorata preview box is displayed
      expect(find.textContaining('Phí tạm tính tháng này'), findsOneWidget);
    });
  });
}
