import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:flutter_resihub/core/network/dio_client.dart';
import 'package:flutter_resihub/core/storage/app_storage.dart';
import 'package:flutter_resihub/features/contracts/services/contracts_service.dart';
import 'package:flutter_resihub/features/resident/services/resident_service.dart';
import 'package:flutter_resihub/features/resident/tabs/contract_tab.dart';
import 'package:flutter_resihub/shared/widgets/ui/html_print_preview_modal.dart';

class _MockAdapter implements HttpClientAdapter {
  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) async {
    final path = options.path;
    if (path.contains('/contracts/c-1/template')) {
      return ResponseBody.fromString(
        '<html><body><h1>HỢP ĐỒNG THUÊ A.101</h1></body></html>',
        200,
        headers: {
          Headers.contentTypeHeader: ['text/html; charset=utf-8']
        },
      );
    }
    if (path.contains('/resident/deposit-transactions')) {
      return ResponseBody.fromString(
        jsonEncode({
          'success': true,
          'data': [
            {
              'deposit_id': 'dep-1',
              'deposit_code': 'DEP-001',
              'deposit_amount': 20000000,
              'status': 'REFUNDED',
              'settlement': {
                'refund_amount': 15000000,
                'outstanding_debt': 1200000,
                'deposit_held_before_settlement': 20000000,
                'items': [
                  {
                    'category': 'CLEANING',
                    'amount': 800000,
                    'description': 'Vệ sinh mặt bằng sau bàn giao',
                    'evidence': [''],
                  },
                ],
                'dispute_thread': [
                  {
                    'role': 'RESIDENT',
                    'message': 'Tôi không đồng ý khoản vệ sinh.',
                    'at': '2026-11-01T10:00:00Z'
                  },
                  {
                    'role': 'MANAGER',
                    'message': 'BQL đã rà soát lại.',
                    'at': '2026-11-02T10:00:00Z'
                  },
                ],
              },
            },
          ],
        }),
        200,
        headers: {
          Headers.contentTypeHeader: [Headers.jsonContentType]
        },
      );
    }
    if (path.contains('/contracts/c-1/occupants')) {
      return ResponseBody.fromString(
        jsonEncode({
          'success': true,
          'data': [
            {
              'tenant_id': 't-1',
              'full_name': 'Trần Thị Cư Dân',
              'phone': '0901234567',
              'email': 'cu.dan@resihub.vn',
              'id_number': '001099012345',
              'relationship': 'Vợ',
              'status': 'ACTIVE',
            },
          ],
        }),
        200,
        headers: {
          Headers.contentTypeHeader: [Headers.jsonContentType]
        },
      );
    }
    return ResponseBody.fromString(
      jsonEncode({'success': true, 'data': []}),
      200,
      headers: {
        Headers.contentTypeHeader: [Headers.jsonContentType]
      },
    );
  }

  @override
  void close({bool force = false}) {}
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  Future<void> pumpContractTab(
    WidgetTester tester, {
    Map<String, dynamic>? overview,
    List<String>? navigatedTabs,
  }) async {
    SharedPreferences.setMockInitialValues({});
    final prefs = await SharedPreferences.getInstance();
    final storage = AppStorage(prefs: prefs);
    final dio = Dio(BaseOptions(baseUrl: 'http://localhost:3000'))
      ..httpClientAdapter = _MockAdapter();

    await tester.binding.setSurfaceSize(const Size(1200, 900));
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          dioProvider.overrideWithValue(dio),
          appStorageProvider.overrideWithValue(storage),
          residentServiceProvider.overrideWithValue(ResidentService(dio: dio)),
          contractsServiceProvider
              .overrideWithValue(ContractsService(dio: dio)),
        ],
        child: MaterialApp(
          home: Scaffold(
            body: ContractTab(
              overview: overview,
              onRefreshOverview: () async {},
              onNavigateTab: (tab, [extra]) => navigatedTabs?.add(tab),
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
  }

  testWidgets(
      'Contract tab parity surfaces timeline, terms, CTAs, amendments and history',
      (tester) async {
    await pumpContractTab(
      tester,
      overview: {
        'active_contract': {
          'contract_id': 'c-1',
          'contract_code': 'HD-2026-001',
          'apartment_code': 'A.101',
          'building_name': 'Tòa Ruby',
          'contract_status': 'ACTIVE',
          'start_date': '2026-01-01',
          'end_date': '2026-12-31',
          'rent_amount': 15000000,
          'deposit_amount': 30000000,
          'billing_day': 5,
          'billing_cycle': 'MONTHLY',
          'payment_due_days': 7,
          'contract_note': 'Giữ nguyên nội thất hiện có.',
        },
        'amendments': [
          {
            'id': 'am-1',
            'version_no': 2,
            'reason': 'Điều chỉnh giá thuê',
            'effective_from': '2026-06-01',
            'diff': {
              'status': 'APPROVED',
              'rent_amount': {'old': 14000000, 'new': 15000000},
              'billing_day': 5,
            },
          },
        ],
        'contract_history': [
          {
            'id': 'c-1',
            'apartment_code': 'A.101',
            'building_name': 'Tòa Ruby',
            'status': 'ACTIVE',
            'start_date': '2026-01-01',
            'end_date': '2026-12-31',
            'rent_amount': 15000000,
          },
        ],
      },
    );

    // Brief Step 1 — exact asserted strings.
    expect(find.text('Tiến trình hợp đồng'), findsOneWidget);
    expect(find.text('Ngày chốt kỳ'), findsOneWidget);
    expect(find.text('Số ngày gia hạn thanh toán'), findsOneWidget);
    expect(find.textContaining('Xin gia hạn'), findsWidgets);
    expect(find.textContaining('Xin chấm dứt'), findsWidgets);
    expect(find.text('Phụ lục điều chỉnh hợp đồng'), findsOneWidget);
    expect(find.text('Chuỗi lịch sử hợp đồng'), findsOneWidget);

    // Extra terms + note + occupant grid details.
    expect(find.textContaining('Giữ nguyên nội thất hiện có.'), findsOneWidget);
    expect(find.text('0901234567'), findsOneWidget);
    expect(find.text('cu.dan@resihub.vn'), findsOneWidget);

    // Rich deposit settlement: deductions, evidence strip, dispute thread.
    expect(find.text('Bảng kê tất toán tiền cọc'), findsOneWidget);
    expect(find.text('Các khoản khấu trừ bàn giao (1)'), findsOneWidget);
    expect(find.text('Vệ sinh mặt bằng sau bàn giao'), findsOneWidget);
    expect(
        find.text('Lịch sử khiếu nại & phản hồi giải quyết'), findsOneWidget);
    expect(find.text('Tôi không đồng ý khoản vệ sinh.'), findsOneWidget);

    // A4 modal still previews and now offers HTML download.
    await tester.tap(find.textContaining('Xem / In hợp đồng A4'));
    await tester.pumpAndSettle();
    expect(find.byType(HtmlPrintPreviewModal), findsOneWidget);
    expect(find.text('Tải bản HTML'), findsOneWidget);
  });

  testWidgets('Empty contract view offers apartment navigation CTA',
      (tester) async {
    final navigated = <String>[];
    await pumpContractTab(
      tester,
      overview: const {'active_contract': null},
      navigatedTabs: navigated,
    );

    expect(find.text('Chưa có hợp đồng thuê'), findsOneWidget);
    await tester.tap(find.text('Xem căn hộ trống'));
    await tester.pumpAndSettle();
    expect(navigated, contains('overview'));
  });
}
