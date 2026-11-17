import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:flutter_resihub/features/resident/tabs/contact_tab.dart';

Widget _buildSubject({
  required void Function(String tab, [Map<String, dynamic>? extra])
      onNavigateTab,
}) {
  return ProviderScope(
    child: MaterialApp(
      home: Scaffold(
        body: ContactTab(
          overview: const {},
          onRefreshOverview: () async {},
          onNavigateTab: onNavigateTab,
        ),
      ),
    ),
  );
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  testWidgets(
      'ContactTab shows four hotline cards with verbatim titles, badges and copy buttons',
      (tester) async {
    await tester.binding.setSurfaceSize(const Size(1200, 900));
    addTearDown(() => tester.binding.setSurfaceSize(null));

    await tester.pumpWidget(_buildSubject(onNavigateTab: (tab, [extra]) {}));
    await tester.pumpAndSettle();

    // 4 exact React <h3> card titles.
    expect(find.text('Hotline Kỹ thuật Tòa nhà'), findsOneWidget);
    expect(find.text('Hotline An ninh & Bảo vệ'), findsOneWidget);
    expect(find.text('Đường dây Khẩn cấp (SOS / PCCC)'), findsOneWidget);
    expect(find.text('Chăm sóc Cư dân & Email Hỗ trợ'), findsOneWidget);

    // Badges / copy / call buttons.
    expect(find.text('Kỹ thuật'), findsOneWidget);
    expect(find.text('Trực 24/7'), findsOneWidget);
    expect(find.text('Khẩn cấp 24/7'), findsOneWidget);
    expect(find.text('CSKH'), findsOneWidget);
    expect(find.text('Gọi ngay'), findsWidgets);
    expect(find.byTooltip('Sao chép số'), findsWidgets);
  });

  testWidgets(
      'ContactTab shows national emergency numbers and maintenance link',
      (tester) async {
    await tester.binding.setSurfaceSize(const Size(1200, 900));
    addTearDown(() => tester.binding.setSurfaceSize(null));

    String? navigatedTab;
    Map<String, dynamic>? navigatedExtra;
    await tester.pumpWidget(_buildSubject(onNavigateTab: (tab, [extra]) {
      navigatedTab = tab;
      navigatedExtra = extra;
    }));
    await tester.pumpAndSettle();

    expect(find.text('113'), findsOneWidget);
    expect(find.text('114'), findsOneWidget);
    expect(find.text('115'), findsOneWidget);

    final link = find.text('Mở mục Báo hỏng →');
    expect(link, findsOneWidget);
    await tester.tap(link);
    await tester.pumpAndSettle();
    expect(navigatedTab, 'maintenance');
    expect(navigatedExtra, {'action': 'new'});
  });

  testWidgets('ContactTab hero shows manager badge, address and working hours',
      (tester) async {
    await tester.binding.setSurfaceSize(const Size(1200, 900));
    addTearDown(() => tester.binding.setSurfaceSize(null));

    await tester.pumpWidget(_buildSubject(onNavigateTab: (tab, [extra]) {}));
    await tester.pumpAndSettle();

    expect(find.text('Quản lý tòa nhà phụ trách trực tiếp'), findsOneWidget);
    expect(find.text('Ban Quản Lý Tòa Nhà ResiHub'), findsOneWidget);
    expect(find.text('Văn phòng Ban Quản Lý tại sảnh tầng 1 tòa nhà'),
        findsOneWidget);
    expect(find.textContaining('Giờ làm việc Văn phòng BQL'), findsOneWidget);
    expect(find.text('08:00 – 18:00 (Thứ 2 – Thứ 7)'), findsOneWidget);
  });
}
