import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:flutter_resihub/features/resident/tabs/overview_tab.dart';

Widget _buildSubject(Map<String, dynamic> overview) {
  return ProviderScope(
    child: MaterialApp(
      home: Scaffold(
        body: OverviewTab(
          overview: overview,
          onRefreshOverview: () async {},
          onNavigateTab: (String tab, [Map<String, dynamic>? extra]) {},
        ),
      ),
    ),
  );
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('hero shows greeting, badges, amenities and contract specs',
      (tester) async {
    final now = DateTime.now();
    final end = DateTime(now.year, now.month, now.day + 10);
    final Map<String, dynamic> overview = {
      'user': {'full_name': 'Trần Thanh Nam'},
      'active_contract': <String, dynamic>{
        'apartment_code': 'A.1203',
        'floor_name': 'Tầng 12',
        'building_name': 'Tòa Sapphire',
        'building_address': '123 Nguyễn Huệ, Quận 1',
        'contract_status': 'ACTIVE',
        'amenities': ['wifi', 'air_conditioner', 'parking'],
        'area_m2': 85,
        'bedrooms': 2,
        'start_date': '2025-01-01T00:00:00Z',
        'end_date': end.toIso8601String(),
      },
    };

    await tester.binding.setSurfaceSize(const Size(390, 844));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(_buildSubject(overview));
    await tester.pumpAndSettle();

    // Brief-required strings.
    expect(find.byKey(const Key('resident-overview-hero')), findsOneWidget);
    expect(find.text('Xin chào, Trần Thanh Nam'), findsOneWidget);
    expect(find.text('TIỆN NGHI BÀN GIAO CĂN HỘ'), findsOneWidget);
    expect(find.text('Wi-Fi tốc độ cao'), findsOneWidget);
    expect(find.text('Diện tích'), findsOneWidget);
    expect(find.text('Loại phòng'), findsOneWidget);
    expect(find.text('Thời hạn HĐ'), findsOneWidget);

    // Badges + title + specs.
    expect(find.text('Căn hộ đang cư trú'), findsOneWidget);
    expect(find.text('Đang hiệu lực'), findsOneWidget); // StatusBadge
    expect(find.text('Còn 10 ngày hết hạn HĐ'), findsOneWidget);
    expect(find.textContaining('Căn hộ A.1203 • Tầng 12'), findsOneWidget);
    expect(find.text('85 m²'), findsOneWidget);
    expect(find.text('2 Phòng ngủ'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('future contract uses null-safe fallbacks', (tester) async {
    final now = DateTime.now();
    final start = DateTime(now.year, now.month, now.day + 5);
    final Map<String, dynamic> overview = {
      'user': const <String, dynamic>{},
      'active_contract': <String, dynamic>{
        'apartment_code': 'B.201',
        'contract_status': 'PENDING_APPROVAL',
        'is_future_contract': true,
        'start_date': start.toIso8601String(),
        'amenities': null,
      },
    };

    await tester.pumpWidget(_buildSubject(overview));
    await tester.pumpAndSettle();

    expect(find.textContaining('Hợp đồng sắp hiệu lực ('), findsOneWidget);
    expect(find.text('Xin chào, Cư dân'), findsOneWidget);
    expect(find.text('Căn hộ B.201'), findsOneWidget);
    expect(find.text('Danh mục tiện nghi theo biên bản bàn giao căn hộ.'),
        findsOneWidget);
    expect(find.text('Tiêu chuẩn'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });
}
