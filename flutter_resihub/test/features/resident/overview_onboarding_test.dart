import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:flutter_resihub/core/network/dio_client.dart';
import 'package:flutter_resihub/features/resident/services/resident_service.dart';
import 'package:flutter_resihub/features/resident/tabs/overview_tab.dart';

class _StubAdapter implements HttpClientAdapter {
  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) async {
    return ResponseBody.fromString(
      '{"success":true,"data":{}}',
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

  late Dio dio;

  setUp(() {
    dio = Dio(BaseOptions(baseUrl: 'http://localhost:3000'));
    dio.httpClientAdapter = _StubAdapter();
  });

  Widget buildTestApp(Map<String, dynamic> overview) {
    return ProviderScope(
      overrides: [
        dioProvider.overrideWithValue(dio),
        residentServiceProvider.overrideWithValue(ResidentService(dio: dio)),
      ],
      child: MaterialApp(
        home: Scaffold(
          body: OverviewTab(
            overview: overview,
            onRefreshOverview: () async {},
            onNavigateTab: (tab, [extra]) {},
          ),
        ),
      ),
    );
  }

  Future<void> pumpOverview(
      WidgetTester tester, Map<String, dynamic> overview) async {
    await tester.binding.setSurfaceSize(const Size(1200, 900));
    await tester.pumpWidget(buildTestApp(overview));
    await tester.pumpAndSettle();
  }

  testWidgets(
      'no contract + reservations + PENDING application hides KPI/hero '
      'and shows onboarding status + bank update button', (tester) async {
    final overview = <String, dynamic>{
      'active_contract': null,
      'user': {'full_name': 'Khách Đặt Cọc', 'phone': '0901234567'},
      'reservations': [
        {
          'reservation_id': 'rsv-1',
          'apartment_id': 'apt-1',
          'apartment_code': 'P.302',
          'building_name': 'Tòa Sapphire',
          'reservation_status': 'HELD',
          'hold_amount': 2000000,
          'area_m2': 75,
          'base_rent': 15000000,
        },
        {
          'reservation_id': 'rsv-2',
          'apartment_id': 'apt-2',
          'apartment_code': 'P.303',
          'building_name': 'Tòa Sapphire',
          'reservation_status': 'APPROVED_PENDING_PAYOUT',
          'hold_amount': 2000000,
          'refunded_amount': 1000000,
        },
      ],
      'onboarding_application': {
        'status': 'PENDING',
        'desired_apartment_id': 'apt-1',
        'desired_apartment_code': 'P.302',
        'desired_building_name': 'Tòa Sapphire',
        'application_note': 'Dự kiến nhận nhà tháng 12',
        'updated_at': '2026-11-17T09:30:00Z',
      },
    };

    await pumpOverview(tester, overview);

    expect(find.byKey(const Key('resident-kpi-footer')), findsNothing);
    expect(find.byKey(const Key('resident-overview-hero')), findsNothing);
    expect(find.byKey(const Key('resident-quick-actions')), findsNothing);

    expect(find.textContaining('Đăng ký thông tin nhận nhà'), findsWidgets);
    expect(find.byKey(const Key('resident-onboarding-status-card')),
        findsOneWidget);
    expect(find.text('Hồ sơ đang chờ Ban Quản Lý phê duyệt'), findsOneWidget);
    expect(find.textContaining('Cập nhật STK nhận hoàn'), findsWidgets);
  });

  testWidgets(
      'REJECTED application shows manager reason, APPROVED shows '
      'approval copy', (tester) async {
    await pumpOverview(tester, {
      'active_contract': null,
      'onboarding_application': {
        'status': 'REJECTED',
        'desired_apartment_code': 'P.302',
        'desired_building_name': 'Tòa Sapphire',
        'rejection_reason': 'Ảnh CCCD mờ, vui lòng tải lại.',
      },
    });

    expect(find.byKey(const Key('resident-onboarding-status-card')),
        findsOneWidget);
    expect(
      find.textContaining(
        'Lý do từ Ban Quản Lý: Ảnh CCCD mờ, vui lòng tải lại.',
      ),
      findsOneWidget,
    );
    expect(find.text('Cần chỉnh sửa'), findsOneWidget);
    expect(find.text('Chỉnh sửa & Gửi lại hồ sơ'), findsOneWidget);

    await pumpOverview(tester, {
      'active_contract': null,
      'onboarding_application': {
        'status': 'APPROVED',
        'desired_apartment_code': 'P.302',
      },
    });

    expect(find.text('Hồ sơ cư dân đã được phê duyệt'), findsOneWidget);
    expect(find.text('Đã duyệt — Chờ lập HĐ'), findsOneWidget);
  });

  testWidgets('reservation detail modal opens with its stable key',
      (tester) async {
    await pumpOverview(tester, {
      'active_contract': null,
      'reservations': [
        {
          'reservation_id': 'rsv-1',
          'apartment_id': 'apt-1',
          'apartment_code': 'P.302',
          'building_name': 'Tòa Sapphire',
          'reservation_status': 'HELD',
          'hold_amount': 2000000,
          'hold_until': '2026-12-31',
        },
      ],
      'onboarding_application': {
        'status': 'PENDING',
        'desired_apartment_id': 'apt-1',
      },
    });

    await tester.tap(find.text('Xem chi tiết').first);
    await tester.pumpAndSettle();

    expect(find.byKey(const Key('resident-reservation-detail-modal')),
        findsOneWidget);
    expect(find.text('Chi tiết Phiếu Giữ chỗ — Căn P.302'), findsOneWidget);
    expect(find.text('Trạng thái giữ chỗ'), findsOneWidget);
    expect(find.text('Hạn giữ chỗ'), findsOneWidget);
  });

  testWidgets(
      'held reservation without application shows inline onboarding '
      'form; no reservation shows public register button', (tester) async {
    await pumpOverview(tester, {
      'active_contract': null,
      'user': {'full_name': 'Khách Đặt Cọc', 'dob': '1995-06-01'},
      'reservations': [
        {
          'reservation_id': 'rsv-1',
          'apartment_id': 'apt-1',
          'apartment_code': 'P.302',
          'building_name': 'Tòa Sapphire',
          'reservation_status': 'HELD',
          'hold_amount': 2000000,
        },
      ],
      'available_apartments': [
        {
          'id': 'apt-9',
          'code': 'A.101',
          'building_name': 'Tòa Ruby',
          'base_rent': 12000000,
        },
      ],
    });

    expect(find.byKey(const Key('resident-inline-onboarding-form')),
        findsOneWidget);
    expect(
        find.byKey(const Key('resident-onboarding-status-card')), findsNothing);
    expect(find.text('Ngày sinh'), findsOneWidget);
    expect(
      find.text(
        'Ảnh chụp CCCD 2 mặt (Khuyến khích tải đủ mặt trước & mặt sau để duyệt nhanh)',
      ),
      findsOneWidget,
    );
    expect(find.text('Gửi hồ sơ đăng ký'), findsOneWidget);

    await pumpOverview(tester, {
      'active_contract': null,
      'reservations': [],
    });

    expect(find.text('Đăng ký thuê trực tuyến'), findsOneWidget);
    expect(find.text('Hiện chưa có căn hộ trống công khai'), findsOneWidget);
  });
}
