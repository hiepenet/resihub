import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:flutter_resihub/core/network/dio_client.dart';
import 'package:flutter_resihub/features/resident/services/resident_service.dart';
import 'package:flutter_resihub/features/resident/tabs/services_tab.dart';

class _MockHttpClientAdapter implements HttpClientAdapter {
  final Future<ResponseBody> Function(RequestOptions options) _handler;

  _MockHttpClientAdapter(this._handler);

  @override
  Future<ResponseBody> fetch(RequestOptions options,
      Stream<Uint8List>? requestStream, Future<void>? cancelFuture) {
    return _handler(options);
  }

  @override
  void close({bool force = false}) {}
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  const overview = {
    'active_contract': {
      'contract_id': 'c-1',
      'contract_status': 'ACTIVE',
      'apartment_code': 'A.101',
      'start_date': '2026-01-01',
      'end_date': '2026-12-31',
    },
  };

  final subscription = {
    'id': 'sub-1',
    'service_id': 'srv-1',
    'service_name': 'Gói gửi xe ô tô',
    'category': 'PARKING',
    'status': 'ACTIVE',
    'unit_price': 1200000,
    'quantity': 2,
    'unit': 'tháng',
    'apartment_code': 'A.101',
    'start_date': '2026-11-01',
    'vehicle_plates': ['29A-123.45'],
    'note': 'Gửi xe hầm B1',
  };

  final catalog = [
    {
      'id': 'srv-1',
      'name': 'Vé gửi ô tô',
      'category': 'PARKING',
      'code': 'PARKING_CAR',
      'unit_price': 1200000,
      'unit': 'tháng',
    },
    {
      'id': 'srv-2',
      'name': 'Internet 100Mbps',
      'category': 'INTERNET',
      'code': 'NET100',
      'billing_type': 'METERED',
      'unit_price': 200000,
      'unit': 'tháng',
    },
  ];

  Dio buildDio(
      {required List<dynamic> subscriptions, required List<dynamic> services}) {
    final dio = Dio(BaseOptions(baseUrl: 'http://localhost:3000'));
    dio.httpClientAdapter = _MockHttpClientAdapter((options) async {
      if (options.path.contains('/resident/services')) {
        return ResponseBody.fromString(
          jsonEncode({
            'success': true,
            'data': {'subscriptions': subscriptions, 'catalog': services},
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
    });
    return dio;
  }

  Future<void> pumpTab(
    WidgetTester tester,
    Dio dio, {
    String? actionParam,
    String? modalParam,
    String? subscriptionIdParam,
  }) async {
    await tester.binding.setSurfaceSize(const Size(1200, 900));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          dioProvider.overrideWithValue(dio),
          residentServiceProvider.overrideWithValue(ResidentService(dio: dio)),
        ],
        child: MaterialApp(
          home: Scaffold(
            body: ServicesTab(
              overview: overview,
              onRefreshOverview: () async {},
              onNavigateTab: (tab, [extra]) {},
              actionParam: actionParam,
              modalParam: modalParam,
              subscriptionIdParam: subscriptionIdParam,
              onClearActionParam: () {},
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
  }

  testWidgets(
      'renders React headings, header CTA, catalog badges and rich subscription card',
      (tester) async {
    await pumpTab(
        tester, buildDio(subscriptions: [subscription], services: catalog));

    expect(find.text('Dịch vụ căn hộ đang đăng ký'), findsOneWidget);
    expect(
      find.text(
          'Quản lý các gói dịch vụ định kỳ gắn với hợp đồng thuê hiện tại của bạn'),
      findsOneWidget,
    );
    expect(find.text('Đăng ký thêm dịch vụ'), findsOneWidget);
    expect(find.text('Danh mục dịch vụ Tòa nhà cung cấp'), findsOneWidget);
    expect(find.text('Đã đăng ký'), findsOneWidget);
    expect(find.text('Tính theo chỉ số'), findsOneWidget);

    // Subscription card: category label, apartment code and monthly total.
    expect(find.text('Gửi xe & Bãi đỗ'), findsWidgets);
    expect(find.textContaining('A.101'), findsWidgets);
    expect(find.textContaining('2.400.000 ₫ / tháng'), findsOneWidget);

    // Responsive grids use Wrap containers.
    expect(find.byKey(const Key('services-subscription-grid')), findsOneWidget);
    expect(find.byKey(const Key('services-catalog-grid')), findsOneWidget);
  });

  testWidgets('subscribe modal exposes start date and note fields',
      (tester) async {
    await pumpTab(
        tester, buildDio(subscriptions: [subscription], services: catalog));

    await tester.tap(find.text('Đăng ký thêm dịch vụ'));
    await tester.pumpAndSettle();

    expect(find.text('Đăng ký sử dụng dịch vụ tiện ích'), findsOneWidget);
    expect(find.textContaining('Ngày bắt đầu sử dụng'), findsWidgets);
    expect(find.textContaining('Ghi chú'), findsWidgets);
    expect(find.text('Xác nhận đăng ký'), findsOneWidget);
  });

  testWidgets('cancel modal exposes end date and reason fields',
      (tester) async {
    await pumpTab(
        tester, buildDio(subscriptions: [subscription], services: catalog));

    await tester.tap(find.text('Hủy dịch vụ'));
    await tester.pumpAndSettle();

    expect(find.textContaining('Hủy dịch vụ:'), findsOneWidget);
    expect(find.textContaining('Ngày kết thúc sử dụng'), findsWidgets);
    expect(find.textContaining('Lý do hủy dịch vụ'), findsWidgets);
    expect(find.text('Xác nhận hủy dịch vụ'), findsOneWidget);
  });

  group('T7 parity — service payloads (E4-E5)', () {
    test('subscribe payload uses start_date/note/vehicle_plates, not metadata',
        () {
      final payload = buildSubscribeServicePayload(
        contractId: 'c-1',
        serviceId: 'srv-1',
        quantity: 1,
        startDate: '2026-11-17',
        note: 'Gửi xe hầm B1',
        vehiclePlates: const ['29A-123.45'],
      );
      expect(payload['start_date'], '2026-11-17');
      expect(payload['note'], 'Gửi xe hầm B1');
      expect(payload['vehicle_plates'], ['29A-123.45']);
      expect(payload.containsKey('metadata'), isFalse);
    });

    test('non-parking subscribe omits vehicle_plates', () {
      final payload = buildSubscribeServicePayload(
        contractId: 'c-1',
        serviceId: 'srv-2',
        quantity: 1,
        startDate: '2026-11-17',
        note: '',
      );
      expect(payload.containsKey('start_date'), isTrue);
      expect(payload.containsKey('note'), isTrue);
      expect(payload.containsKey('vehicle_plates'), isFalse);
    });

    test('cancel payload uses end_date/note, not cancellation_reason', () {
      final payload = buildCancelServicePayload(
        endDate: '2026-11-20',
        note: 'Không còn nhu cầu',
      );
      expect(payload['end_date'], '2026-11-20');
      expect(payload['note'], 'Không còn nhu cầu');
      expect(payload.containsKey('cancellation_reason'), isFalse);
    });
  });

  group('E9 deep-link — ServicesTab modals', () {
    testWidgets('action=subscribe opens the subscribe modal', (tester) async {
      await pumpTab(
        tester,
        buildDio(subscriptions: [subscription], services: catalog),
        actionParam: 'subscribe',
      );
      expect(find.text('Đăng ký sử dụng dịch vụ tiện ích'), findsOneWidget);
    });

    testWidgets('subscription_id opens the subscription detail modal',
        (tester) async {
      await pumpTab(
        tester,
        buildDio(subscriptions: [subscription], services: catalog),
        modalParam: 'detail',
        subscriptionIdParam: 'sub-1',
      );
      expect(find.text('Gói dịch vụ: Gói gửi xe ô tô'), findsOneWidget);
    });
  });
}
