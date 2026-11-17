import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:flutter_resihub/features/resident/tabs/overview_tab.dart';

Widget _buildSubject(
  Map<String, dynamic> overview,
  void Function(String tab, [Map<String, dynamic>? extra]) onNavigate,
) {
  return ProviderScope(
    child: MaterialApp(
      home: Scaffold(
        body: OverviewTab(
          overview: overview,
          onRefreshOverview: () async {},
          onNavigateTab: onNavigate,
        ),
      ),
    ),
  );
}

/// Task 5 (React parity) hides hero/KPI/quick-actions/invoice cards when there
/// is no active contract, so every fixture needs a minimal contract to reach
/// the widgets these assertions target.
Map<String, dynamic> _minimalContract() => <String, dynamic>{
      'contract_id': 'c-1',
      'apartment_code': '11A01',
      'building_name': 'VOP1',
      'status': 'ACTIVE',
      'end_date': '2027-06-30',
    };

Map<String, dynamic> _fullOverview() => <String, dynamic>{
      'active_contract': _minimalContract(),
      'current_amount_due': 300000,
      'latest_invoice': <String, dynamic>{
        'invoice_code': 'INV-2026-10-001',
        'invoice_type': 'REGULAR',
        'period': '2026-10',
        'status': 'PARTIALLY_PAID',
        'due_date': '2026-11-10T00:00:00Z',
        'paid_amount': 200000,
        'total_amount': 500000,
      },
      'manager_contact': <String, dynamic>{
        'full_name': 'Nguyễn Văn Quản',
        'phone': '0901234567',
        'email': 'bql@resihub.vn',
        'technical_hotline': '1900 1234',
        'working_hours': '08:00 – 20:00',
      },
    };

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  testWidgets(
      'quick actions, latest invoice and support cards render React strings',
      (tester) async {
    await tester.binding.setSurfaceSize(const Size(1440, 900));
    addTearDown(() => tester.binding.setSurfaceSize(null));

    await tester.pumpWidget(_buildSubject(_fullOverview(), (_, [__]) {}));
    await tester.pumpAndSettle();

    // Quick actions (React: OverviewTab.jsx:1414-1477).
    expect(find.byKey(const Key('resident-quick-actions')), findsOneWidget);
    expect(find.text('Thao tác nhanh'), findsOneWidget);
    expect(find.text('Các tiện ích thường dùng dành cho cư dân căn hộ'),
        findsOneWidget);
    for (final label in [
      'Báo đã thanh toán',
      'Gửi yêu cầu sửa chữa',
      'Đăng ký dịch vụ',
      'Xem hợp đồng',
    ]) {
      expect(find.text(label), findsOneWidget, reason: label);
    }
    for (final subtitle in [
      'Gửi ủy nhiệm chi / biên lai chuyển khoản',
      'Báo hỏng điện, nước, điều hòa, nội thất',
      'Gửi xe, dọn phòng, tiện ích mở rộng',
      'Bản in A4, phụ lục, gia hạn & sổ cọc',
    ]) {
      expect(find.text(subtitle), findsOneWidget, reason: subtitle);
    }

    // Latest invoice card (React: OverviewTab.jsx:1479-1531).
    expect(
        find.byKey(const Key('resident-latest-invoice-card')), findsOneWidget);
    expect(find.text('Hóa đơn kỳ gần nhất'), findsOneWidget);
    expect(find.text('Tất cả hóa đơn'), findsOneWidget);
    expect(find.text('INV-2026-10-001'), findsOneWidget);
    expect(find.text('Kỳ 2026-10'), findsOneWidget);
    expect(find.text('Thanh toán một phần'), findsOneWidget); // StatusBadge
    expect(find.text('Hạn thanh toán:'), findsOneWidget);
    expect(find.text('Đã trả:'), findsOneWidget);
    expect(find.text('10/11/2026'), findsOneWidget);
    expect(find.text('Tổng hóa đơn'), findsOneWidget);
    expect(find.text('500.000 ₫'), findsOneWidget);
    expect(find.text('200.000 ₫'), findsOneWidget);
    expect(find.text('Thanh toán'), findsOneWidget);

    // Manager support card (React: OverviewTab.jsx:1533-1569).
    expect(
        find.byKey(const Key('resident-manager-support-card')), findsOneWidget);
    expect(find.text('Ban Quản Lý hỗ trợ'), findsOneWidget);
    expect(find.text('Nguyễn Văn Quản'), findsOneWidget);
    expect(find.text('SĐT Quản lý: 0901234567'), findsOneWidget);
    expect(find.text('Email: bql@resihub.vn'), findsOneWidget);
    expect(find.text('Hotline KT: 1900 1234'), findsOneWidget);
    expect(find.text('Giờ làm việc: 08:00 – 20:00'), findsOneWidget);
    expect(find.text('Xem đầy đủ danh bạ BQL'), findsOneWidget);

    expect(tester.takeException(), isNull);
  });

  testWidgets('quick actions and card buttons navigate to the right tabs',
      (tester) async {
    // Contract-backed hero/KPI content is tall; enlarge viewport so the
    // invoice pay button and manager-support link are actually reachable.
    await tester.binding.setSurfaceSize(const Size(1440, 1400));
    addTearDown(() => tester.binding.setSurfaceSize(null));

    final tabs = <String>[];
    final extras = <Map<String, dynamic>?>[];
    await tester.pumpWidget(
      _buildSubject(
        _fullOverview(),
        (tab, [extra]) {
          tabs.add(tab);
          extras.add(extra);
        },
      ),
    );
    await tester.pumpAndSettle();

    for (final label in [
      'Báo đã thanh toán',
      'Gửi yêu cầu sửa chữa',
      'Đăng ký dịch vụ',
      'Xem hợp đồng',
    ]) {
      await tester.tap(find.text(label));
      await tester.pumpAndSettle();
    }
    await tester.tap(find.text('Tất cả hóa đơn'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Thanh toán'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Xem đầy đủ danh bạ BQL'));
    await tester.pumpAndSettle();

    expect(tabs, [
      'invoices',
      'maintenance',
      'services',
      'contract',
      'invoices',
      'invoices',
      'contact',
    ]);
    expect(extras, [
      {'action': 'pay'},
      {'action': 'new'},
      {'action': 'subscribe'},
      null,
      null,
      {'action': 'pay'},
      null,
    ]);
    expect(tester.takeException(), isNull);
  });

  testWidgets('pay action is gated on current_amount_due > 0', (tester) async {
    await tester.binding.setSurfaceSize(const Size(1440, 1400));
    addTearDown(() => tester.binding.setSurfaceSize(null));

    final overview = _fullOverview();
    overview['current_amount_due'] = 0;

    final tabs = <String>[];
    final extras = <Map<String, dynamic>?>[];
    await tester.pumpWidget(
      _buildSubject(
        overview,
        (tab, [extra]) {
          tabs.add(tab);
          extras.add(extra);
        },
      ),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.text('Báo đã thanh toán'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Thanh toán'));
    await tester.pumpAndSettle();

    expect(tabs, ['invoices', 'invoices']);
    expect(extras, [null, null]);
    expect(tester.takeException(), isNull);
  });

  testWidgets('null-safe fallbacks for empty overview', (tester) async {
    await tester.pumpWidget(
      _buildSubject(<String, dynamic>{'active_contract': _minimalContract()},
          (_, [__]) {}),
    );
    await tester.pumpAndSettle();

    expect(
        find.byKey(const Key('resident-latest-invoice-card')), findsOneWidget);
    expect(
      find.text('Hiện chưa có hóa đơn nào được phát hành cho căn hộ của bạn.'),
      findsOneWidget,
    );
    expect(find.text('Ban Quản Lý ResiHub'), findsOneWidget);
    expect(find.text('Hotline KT: 1900 6868'), findsOneWidget);
    expect(find.text('Giờ làm việc: 08:00 – 18:00'), findsOneWidget);
    expect(find.text('Thanh toán'), findsNothing);
    expect(tester.takeException(), isNull);
  });
}
