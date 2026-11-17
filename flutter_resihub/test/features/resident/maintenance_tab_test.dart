import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:flutter_resihub/features/resident/services/resident_service.dart';
import 'package:flutter_resihub/features/resident/tabs/maintenance_tab.dart';

class _FakeResidentService extends Fake implements ResidentService {
  List<dynamic> requests = <dynamic>[];
  Object? createError;
  Map<String, dynamic>? lastCreatePayload;
  int createCalls = 0;

  @override
  Future<dynamic> listServiceRequests(
      [String? contractId, Options? options]) async {
    return {'data': requests};
  }

  @override
  Future<dynamic> createServiceRequest(
    dynamic payload, {
    Options? options,
    String? idempotencyKey,
  }) async {
    lastCreatePayload = Map<String, dynamic>.from(payload as Map);
    createCalls += 1;
    if (createError != null) throw createError!;
    return {'message': 'Đã tiếp nhận báo hỏng! Mã tra cứu: SR-TEST'};
  }
}

Map<String, dynamic> _overview() {
  return {
    'active_contract': {
      'contract_id': 'c-1',
      'apartment_id': 'apt-1',
      'apartment_code': 'A.101',
      'building_name': 'Tòa Sapphire',
    },
    'sla_config': {'reopen_window_days': 3},
  };
}

List<Map<String, dynamic>> _requests() {
  return [
    {
      'id': 'sr-1',
      'tracking_code': 'SR-2026-001',
      'status': 'NEW',
      'category': 'PLUMBING',
      'priority': 'HIGH',
      'title': 'Vòi nước rò rỉ',
      'description': 'Vòi nước nhà vệ sinh rò rỉ nhỏ giọt.',
      'location_detail': 'Nhà vệ sinh phụ',
      'preferred_slot': 'MORNING_08_12',
      'created_at': '2026-11-01T08:00:00Z',
      'sla_due_at': '2099-01-01T08:00:00Z',
      'assigned_to_name': 'Đang điều phối nhân sự',
    },
    {
      'id': 'sr-2',
      'tracking_code': 'SR-2026-002',
      'status': 'RESOLVED',
      'category': 'ELECTRICAL',
      'priority': 'NORMAL',
      'title': 'Điều hòa không mát',
      'description': 'Điều hòa phòng ngủ chảy nước.',
      'location_detail': 'Phòng ngủ chính',
      'preferred_slot': 'AFTERNOON_13_17',
      'created_at': '2026-10-28T09:00:00Z',
      'resolved_at': '2026-10-29T09:00:00Z',
      'sla_due_at': '2026-10-30T09:00:00Z',
      'assigned_to_name': 'Nguyễn Văn Kỹ',
      'resolution_note': 'Đã nạp gas và vệ sinh dàn lạnh.',
    },
  ];
}

Widget _buildTab(_FakeResidentService service) {
  return ProviderScope(
    overrides: [residentServiceProvider.overrideWithValue(service)],
    child: MaterialApp(
      home: Scaffold(
        body: MaintenanceTab(
          overview: _overview(),
          onRefreshOverview: () async {},
          onNavigateTab: (_, [__]) {},
        ),
      ),
    ),
  );
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('MaintenanceTab parity', () {
    testWidgets('3 filter chips and richer request card fields',
        (tester) async {
      final service = _FakeResidentService()..requests = _requests();
      await tester.pumpWidget(_buildTab(service));
      await tester.pumpAndSettle();

      expect(find.text('Tất cả yêu cầu'), findsOneWidget);
      expect(find.text('Đang xử lý'), findsOneWidget);
      expect(find.text('Đã hoàn thành'), findsOneWidget);

      expect(find.textContaining('Mã tra cứu'), findsWidgets);
      expect(find.textContaining('Khung giờ'), findsWidgets);
      expect(find.textContaining('SLA'), findsWidgets);
      expect(find.text('Vòi nước rò rỉ'), findsOneWidget);
      expect(find.textContaining('Nguyễn Văn Kỹ'), findsWidgets);
    });

    testWidgets('create form exposes location and preferred slot',
        (tester) async {
      final service = _FakeResidentService();
      await tester.pumpWidget(_buildTab(service));
      await tester.pumpAndSettle();

      await tester.tap(find.text('Gửi yêu cầu báo hỏng'));
      await tester.pumpAndSettle();

      expect(find.text('Vị trí cụ thể trong phòng'), findsOneWidget);
      expect(find.textContaining('Khung giờ thuận tiện'), findsWidgets);
      expect(find.text('Hạng mục sự cố'), findsOneWidget);
      expect(find.text('Mức độ khẩn cấp'), findsOneWidget);
      expect(find.text('Gửi yêu cầu'), findsOneWidget);
    });

    testWidgets('409 DUPLICATE_SERVICE_REQUEST opens duplicate modal',
        (tester) async {
      final service = _FakeResidentService()..requests = _requests();
      final reqOpts = RequestOptions(path: '/api/v1/resident/service-requests');
      service.createError = DioException(
        requestOptions: reqOpts,
        response: Response<dynamic>(
          requestOptions: reqOpts,
          statusCode: 409,
          data: {
            'code': 'DUPLICATE_SERVICE_REQUEST',
            'message':
                'Căn hộ đang có yêu cầu cùng hạng mục vừa gửi trong 24 giờ qua (SR-2026-001). Bạn vẫn muốn gửi thêm yêu cầu mới?',
            'existing_request': {
              'id': 'sr-1',
              'tracking_code': 'SR-2026-001',
              'title': 'Vòi nước rò rỉ',
              'status': 'NEW',
              'created_at': '2026-11-01T08:00:00Z',
            },
          },
        ),
      );

      await tester.pumpWidget(_buildTab(service));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Gửi yêu cầu báo hỏng'));
      await tester.pumpAndSettle();

      await tester.enterText(
        find.byType(TextFormField).last,
        'Vòi nước vẫn rò rỉ',
      );
      final submit = find.text('Gửi yêu cầu');
      await tester.ensureVisible(submit);
      await tester.tap(submit);
      await tester.pumpAndSettle();

      expect(find.text('Phát hiện yêu cầu cùng hạng mục trong 24 giờ qua'),
          findsOneWidget);
      expect(find.text('Xem yêu cầu đã gửi'), findsOneWidget);
      expect(find.text('Vẫn tiếp tục gửi mới'), findsOneWidget);
      expect(find.textContaining('SR-2026-001'), findsWidgets);
    });
  });
}
