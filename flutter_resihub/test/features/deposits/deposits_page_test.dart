import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:flutter_resihub/core/network/dio_client.dart';
import 'package:flutter_resihub/core/network/query_cache.dart';
import 'package:flutter_resihub/core/storage/app_storage.dart';
import 'package:flutter_resihub/features/auth/models/user_model.dart';
import 'package:flutter_resihub/features/auth/providers/auth_provider.dart';
import 'package:flutter_resihub/features/deposits/screens/deposits_page.dart';
import 'package:flutter_resihub/features/deposits/services/deposits_service.dart';
import 'package:flutter_resihub/shared/widgets/ui/app_tabs.dart';

class _MockHttpClientAdapter implements HttpClientAdapter {
  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) async {
    return ResponseBody.fromString('{"success":true,"data":[]}', 200, headers: {
      Headers.contentTypeHeader: [Headers.jsonContentType],
    });
  }

  @override
  void close({bool force = false}) {}
}

class _FakeDepositsService extends Fake implements DepositsService {
  final List<Map<String, dynamic>> rows;
  _FakeDepositsService(this.rows);

  @override
  dynamic peekList([Map<String, dynamic>? params]) => null;

  @override
  Future<dynamic> list(
      [Map<String, dynamic>? params, bool force = false]) async {
    return {'data': rows};
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late AppStorage storage;
  late List<Map<String, dynamic>> rows;

  setUp(() async {
    SharedPreferences.setMockInitialValues({});
    final prefs = await SharedPreferences.getInstance();
    storage = AppStorage(prefs: prefs, isWeb: true);
    await storage.init();

    rows = [
      {
        'id': 'd-overdue',
        'apartment_code': 'OVERDUE-1',
        'status': 'HELD',
        'refund_due_date': '2020-01-01',
      },
      {
        'id': 'd-future',
        'apartment_code': 'FUTURE-1',
        'status': 'HELD',
        'refund_due_date': '2099-01-01',
      },
      {
        'id': 'd-settled',
        'apartment_code': 'SETTLED-1',
        'status': 'REFUNDED',
        'refund_due_date': '2020-01-01',
      },
      {
        'id': 'd-payout',
        'apartment_code': 'PAYOUT-1',
        'status': 'APPROVED_PENDING_PAYOUT',
      },
      {
        'id': 'd-returned',
        'apartment_code': 'RETURNED-1',
        'status': 'RETURNED',
      },
      {
        'id': 'd-held',
        'apartment_code': 'HELD-1',
        'status': 'HELD',
      },
      {
        'id': 'd-disputed',
        'apartment_code': 'DISPUTED-1',
        'status': 'DISPUTED',
      },
    ];
  });

  Future<void> pumpAt(WidgetTester tester, String location) async {
    await tester.binding.setSurfaceSize(const Size(1280, 900));
    addTearDown(() => tester.binding.setSurfaceSize(null));

    final dio = Dio(BaseOptions(baseUrl: 'http://localhost:3000'));
    dio.httpClientAdapter = _MockHttpClientAdapter();

    final container = ProviderContainer(
      overrides: [
        appStorageProvider.overrideWithValue(storage),
        dioProvider.overrideWithValue(dio),
        queryCacheProvider.overrideWithValue(QueryCache()),
        depositsServiceProvider.overrideWithValue(_FakeDepositsService(rows)),
      ],
    );
    container.read(authProvider.notifier).setAuthData(
          accessToken: 'token',
          refreshToken: 'refresh',
          user: const UserModel(
            id: 'u-mgr',
            fullName: 'Ban Quan Ly',
            phone: '0900000000',
            roles: [UserRoleModel(code: 'MANAGER')],
          ),
        );

    final router = GoRouter(
      initialLocation: location,
      routes: [
        GoRoute(
          path: '/admin/deposits',
          builder: (_, __) => const DepositsPage(),
        ),
      ],
    );

    await tester.pumpWidget(
      UncontrolledProviderScope(
        container: container,
        child: MaterialApp.router(routerConfig: router),
      ),
    );
    await tester.pumpAndSettle();
  }

  testWidgets('?overdue=1 shows banner and only overdue, non-settled rows',
      (tester) async {
    await pumpAt(tester, '/admin/deposits?overdue=1');

    expect(find.textContaining('Đang áp dụng bộ lọc nhanh từ Dashboard'),
        findsOneWidget);
    expect(find.textContaining('Các sổ cọc quá hạn hoàn trả (FR-068)'),
        findsOneWidget);
    expect(find.text('Xóa bộ lọc nhanh'), findsOneWidget);

    expect(find.text('OVERDUE-1'), findsOneWidget);
    expect(find.text('FUTURE-1'), findsNothing);
    expect(find.text('SETTLED-1'), findsNothing);
    expect(find.text('PAYOUT-1'), findsNothing);
  });

  testWidgets('?tab=payout shows banner and only payout/returned rows',
      (tester) async {
    await pumpAt(tester, '/admin/deposits?tab=payout');

    expect(find.textContaining('Đang áp dụng bộ lọc nhanh từ Dashboard'),
        findsOneWidget);
    expect(
      find.textContaining(
          'Các sổ cọc chờ BQL chi hoàn UNC / ngân hàng trả lại'),
      findsOneWidget,
    );
    expect(find.text('Xóa bộ lọc nhanh'), findsOneWidget);

    expect(find.text('PAYOUT-1'), findsOneWidget);
    expect(find.text('RETURNED-1'), findsOneWidget);
    expect(find.text('HELD-1'), findsNothing);
    expect(find.text('OVERDUE-1'), findsNothing);
  });

  testWidgets('?status=DISPUTED shows banner and only disputed rows',
      (tester) async {
    await pumpAt(tester, '/admin/deposits?status=DISPUTED');

    expect(find.textContaining('Đang áp dụng bộ lọc nhanh từ Dashboard'),
        findsOneWidget);
    expect(find.textContaining('Trạng thái DISPUTED'), findsOneWidget);
    expect(find.text('Xóa bộ lọc nhanh'), findsOneWidget);

    expect(find.text('DISPUTED-1'), findsOneWidget);
    expect(find.text('HELD-1'), findsNothing);
    expect(find.text('PAYOUT-1'), findsNothing);
  });

  testWidgets('"Xóa bộ lọc nhanh" clears the drill-down banner',
      (tester) async {
    await pumpAt(tester, '/admin/deposits?overdue=1');
    expect(find.text('Xóa bộ lọc nhanh'), findsOneWidget);

    await tester.tap(find.text('Xóa bộ lọc nhanh'));
    await tester.pumpAndSettle();

    expect(find.textContaining('Đang áp dụng bộ lọc nhanh từ Dashboard'),
        findsNothing);
    expect(find.text('Xóa bộ lọc nhanh'), findsNothing);
  });

  testWidgets('KPI cards show React copy, subtext and drill down to a tab',
      (tester) async {
    await pumpAt(tester, '/admin/deposits');

    // StatsCard renders its title in upper-case.
    expect(find.text('TỔNG TIỀN CỌC ĐANG GIỮ'), findsOneWidget);
    expect(find.text('CHỜ DUYỆT / CHI HOÀN'), findsOneWidget);
    expect(find.text('ĐÃ HOÀN / TẤT TOÁN'), findsOneWidget);
    expect(find.text('HỒ SƠ TRANH CHẤP'), findsOneWidget);

    expect(find.textContaining('sổ đang bảo lưu'), findsOneWidget);
    expect(find.text('Chờ Four-Eyes hoặc chờ UNC chi hoàn'), findsOneWidget);
    expect(
        find.text('Hoàn đủ, hoàn một phần hoặc cấn trừ hết'), findsOneWidget);
    expect(find.text('Đang tạm khóa phê duyệt / chi hoàn'), findsOneWidget);

    await tester.tap(find.text('Chờ Four-Eyes hoặc chờ UNC chi hoàn'));
    await tester.pumpAndSettle();
    expect(find.text('PAYOUT-1'), findsOneWidget);
    expect(find.text('HELD-1'), findsNothing);
  });

  testWidgets('main tabs use the React labels', (tester) async {
    await pumpAt(tester, '/admin/deposits');

    // Restrict to the tab bar: "Đang giữ cọc" also appears as a row status badge.
    Finder tabLabel(String label) =>
        find.descendant(of: find.byType(AppTabs), matching: find.text(label));

    expect(tabLabel('Đang giữ cọc'), findsOneWidget);
    expect(tabLabel('Chờ duyệt / Chi hoàn'), findsOneWidget);
    expect(tabLabel('Hoàn trả lệnh chi'), findsOneWidget);
    expect(tabLabel('Đã hoàn / Tất toán'), findsOneWidget);
  });

  testWidgets('tapping a main tab clears an active quick filter and banner',
      (tester) async {
    await pumpAt(tester, '/admin/deposits?overdue=1');
    expect(find.text('Xóa bộ lọc nhanh'), findsOneWidget);
    expect(find.text('OVERDUE-1'), findsOneWidget);

    await tester.tap(find.descendant(
        of: find.byType(AppTabs), matching: find.text('Chờ duyệt / Chi hoàn')));
    await tester.pumpAndSettle();

    expect(find.text('Xóa bộ lọc nhanh'), findsNothing);
    expect(find.textContaining('Đang áp dụng bộ lọc nhanh từ Dashboard'),
        findsNothing);
    expect(find.text('PAYOUT-1'), findsOneWidget);
    expect(find.text('OVERDUE-1'), findsNothing);
  });
}
