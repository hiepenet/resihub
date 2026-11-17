import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:flutter_resihub/core/network/dio_client.dart';
import 'package:flutter_resihub/core/network/query_cache.dart';
import 'package:flutter_resihub/features/resident/services/resident_service.dart';
import 'package:flutter_resihub/features/resident/tabs/invoices_tab.dart';

class _MockAdapter implements HttpClientAdapter {
  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) async {
    if (options.path.contains('/resident/invoices')) {
      return ResponseBody.fromString(
        jsonEncode({
          'success': true,
          'data': [
            {
              'invoice_id': 'inv-1',
              'invoice_code': 'HD-T11-001',
              'period': '2026-11',
              'status': 'ISSUED',
              'total_amount': 2500000,
              'paid_amount': 0,
              'lines': [],
            },
          ],
          'credit_balances': [
            {
              'id': 'cr-1',
              'amount': 350000,
              'available_amount': 350000,
              'status': 'AVAILABLE',
              'description': 'Hoàn cọc dịch vụ kỳ trước',
            },
          ],
        }),
        200,
        headers: {Headers.contentTypeHeader: [Headers.jsonContentType]},
      );
    }
    return ResponseBody.fromString(
      jsonEncode({'success': true, 'data': []}),
      200,
      headers: {Headers.contentTypeHeader: [Headers.jsonContentType]},
    );
  }

  @override
  void close({bool force = false}) {}
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  const overview = {
    'active_contract': {'contract_id': 'c-1', 'apartment_code': 'P302'},
    'available_credit_balance': 350000,
  };

  Future<void> pumpTab(
    WidgetTester tester, {
    String? modalParam,
    String? invoiceIdParam,
    String? creditIdParam,
  }) async {
    final dio = Dio(BaseOptions(baseUrl: 'http://localhost:3000'))
      ..httpClientAdapter = _MockAdapter();
    await tester.binding.setSurfaceSize(const Size(1200, 900));
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          dioProvider.overrideWithValue(dio),
          queryCacheProvider.overrideWithValue(QueryCache()),
          residentServiceProvider.overrideWithValue(ResidentService(dio: dio)),
        ],
        child: MaterialApp(
          home: Scaffold(
            body: InvoicesTab(
              overview: overview,
              onRefreshOverview: () async {},
              onNavigateTab: (tab, [extra]) {},
              modalParam: modalParam,
              invoiceIdParam: invoiceIdParam,
              creditIdParam: creditIdParam,
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
  }

  testWidgets('invoice_id + modal=pay opens the payment report modal',
      (tester) async {
    await pumpTab(
      tester,
      modalParam: 'pay',
      invoiceIdParam: 'inv-1',
    );
    expect(find.text('Báo đã thanh toán hóa đơn'), findsOneWidget);
  });

  testWidgets('credit_id opens the credit detail modal', (tester) async {
    await pumpTab(
      tester,
      modalParam: 'credit',
      creditIdParam: 'cr-1',
    );
    expect(
        find.text('Chi tiết Số dư Tín dụng & Hoàn tiền'), findsOneWidget);
  });

  testWidgets('invoice_id alone opens the invoice detail modal',
      (tester) async {
    await pumpTab(
      tester,
      invoiceIdParam: 'inv-1',
    );
    expect(find.text('Chi tiết hóa đơn'), findsOneWidget);
  });

  // Final review findings (re-graded Important — money + notification path).
  test('empty payment account is rejected so lower-priority sources can win',
      () {
    expect(
      normalizeResidentPaymentAccount({'bank': '', 'account_no': ''}),
      isNull,
    );
  });

  test('payment account fallback skips an empty building account', () {
    final resolved = resolveResidentPaymentAccountFromSources(
      buildingAccount: {'bank': '', 'account_no': ''},
      settingsAccount: {
        'bank': 'Vietcombank',
        'account_no': '1234567890',
        'account_name': 'BQL',
      },
    );
    expect(resolved['account_no'], '1234567890');
  });

  testWidgets('modal=pay without invoice_id opens the payment report modal',
      (tester) async {
    await pumpTab(tester, modalParam: 'pay');
    expect(find.text('Báo đã thanh toán hóa đơn'), findsOneWidget);
  });
}
