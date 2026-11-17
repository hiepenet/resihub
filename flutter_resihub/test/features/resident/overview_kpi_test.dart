import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:flutter_resihub/features/resident/tabs/overview_tab.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('Overview KPI cards match React titles and footers',
      (tester) async {
    await tester.binding.setSurfaceSize(const Size(1440, 900));
    addTearDown(() => tester.binding.setSurfaceSize(null));

    final overview = <String, dynamic>{
      'current_amount_due': 0,
      'active_contract': <String, dynamic>{
        'apartment_code': 'A.101',
        'building_name': 'Tòa Ruby',
        'rent_amount': 7300000,
        'deposit_amount': 7300000,
        'deposit_held_amount': 7300000,
        'deposit_status': 'HELD',
        'billing_day': 5,
        'payment_due_days': 10,
        'end_date': '2027-06-30',
      },
      'latest_invoice': <String, dynamic>{'period': '2026-10'},
    };

    await tester.pumpWidget(
      ProviderScope(
        child: MaterialApp(
          home: Scaffold(
            body: OverviewTab(
              overview: overview,
              openRequestsCount: 2,
              onRefreshOverview: () async {},
              onNavigateTab: (String tab, [Map<String, dynamic>? extra]) {},
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('CẦN THANH TOÁN HIỆN TẠI'), findsOneWidget);
    expect(find.text('TIỀN THUÊ HÀNG THÁNG'), findsOneWidget);
    expect(find.text('TIỀN CỌC ĐANG GIỮ'), findsOneWidget);
    expect(find.text('THÔNG BÁO & YÊU CẦU MỞ'), findsOneWidget);
    expect(find.byKey(const Key('resident-kpi-footer')), findsNWidgets(4));
    expect(find.text('Không có dư nợ quá hạn'), findsOneWidget);

    for (var i = 1; i <= 4; i++) {
      expect(find.byKey(Key('resident-kpi-card-$i')), findsOneWidget);
    }
    expect(tester.takeException(), isNull);
  });
}
