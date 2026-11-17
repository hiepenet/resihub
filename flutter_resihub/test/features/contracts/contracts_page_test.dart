import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:flutter_resihub/core/network/dio_client.dart';
import 'package:flutter_resihub/core/network/query_cache.dart';
import 'package:flutter_resihub/core/storage/app_storage.dart';
import 'package:flutter_resihub/core/utils/date_range.dart';
import 'package:flutter_resihub/features/auth/models/user_model.dart';
import 'package:flutter_resihub/features/auth/providers/auth_provider.dart';
import 'package:flutter_resihub/features/contracts/screens/contracts_page.dart';
import 'package:flutter_resihub/shared/widgets/ui/app_button.dart';
import 'package:flutter_resihub/shared/widgets/ui/app_input.dart';
import 'package:flutter_resihub/shared/widgets/ui/app_select.dart';

class _MockHttpClientAdapter implements HttpClientAdapter {
  final Future<ResponseBody> Function(RequestOptions options) _handler;

  _MockHttpClientAdapter(this._handler);

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) {
    return _handler(options);
  }

  @override
  void close({bool force = false}) {}
}

const _manager = UserModel(
  id: 'u-mgr',
  fullName: 'Ban Quan Ly',
  phone: '0900000000',
  roles: [UserRoleModel(code: 'MANAGER', name: 'Quản lý')],
);

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('validateContractCreateForm (B3)', () {
    test('billing_day 0 and payment_due_days 61 are rejected', () {
      final errs = validateContractCreateForm(
        const ContractCreateDraft(billingDay: '0', paymentDueDays: '61'),
      );
      expect(errs['billing_day'], isNotEmpty,
          reason: 'ngày phát hành hóa đơn 0 phải bị chặn');
      expect(errs['payment_due_days'], isNotEmpty,
          reason: 'hạn thanh toán 61 ngày phải bị chặn');

      final ok = validateContractCreateForm(
        const ContractCreateDraft(billingDay: '1', paymentDueDays: '60'),
      );
      expect(ok, isEmpty);
    });

    test('duplicate occupant phone (with primary and between occupants) is rejected', () {
      final errs = validateContractCreateForm(
        ContractCreateDraft(
          tenantMode: 'new',
          newTenantForm: const {'full_name': 'A', 'phone': '0912345678'},
          occupants: const [
            {'full_name': 'B', 'phone': '0912345678', 'relationship': 'family', 'id_number': ''},
            {'full_name': 'C', 'phone': '0912345678', 'relationship': 'friend', 'id_number': ''},
          ],
        ),
      );
      expect(errs['occ_phone_0'], isNotEmpty,
          reason: 'trùng SĐT với khách thuê chính phải bị chặn');
      expect(errs['occ_phone_1'], isNotEmpty,
          reason: 'trùng SĐT giữa các thành viên phải bị chặn');
    });

    test('invalid email / id number / short password are rejected for new tenant', () {
      final errs = validateContractCreateForm(
        ContractCreateDraft(
          tenantMode: 'new',
          newTenantForm: const {
            'full_name': 'A',
            'phone': '0912345678',
            'email': 'not-an-email',
            'id_number': '123',
            'password': 'short',
          },
        ),
      );
      expect(errs['new_email'], isNotEmpty);
      expect(errs['new_id_number'], isNotEmpty);
      expect(errs['new_password'], isNotEmpty);
    });

    test('out-of-scope duplicate identity blocks creation', () {
      final errs = validateContractCreateForm(
        const ContractCreateDraft(
          tenantMode: 'new',
          newTenantForm: {'full_name': 'A', 'phone': '0912345678'},
          duplicateOutOfScope: true,
        ),
      );
      expect(errs['duplicate_identity'], isNotEmpty);
    });

    test('parking service with missing plate is rejected', () {
      final errs = validateContractCreateForm(
        ContractCreateDraft(
          selectedServices: const {
            'svc-parking': {
              'checked': true,
              'quantity': 1,
              'unit_price': 0,
              'vehicle_plates': [''],
              'note': '',
            },
          },
          serviceCatalog: const [
            {'id': 'svc-parking', 'category': 'PARKING', 'billing_type': 'QUANTITY'},
          ],
        ),
      );
      expect(errs['svc_plates_svc-parking'], isNotEmpty);
    });
  });

  group('busy schedule validation (B6)', () {
    test('occupied start date and overlapping range are rejected', () {
      final today = toDateOnlyStr(DateTime.now());
      final busy = extractApartmentBusyIntervals(
        contracts: [
          {
            'id': 'c-busy',
            'status': 'ACTIVE',
            'start_date': addDaysStr(today, -1),
            'end_date': addDaysStr(today, 20),
          },
        ],
        todayStr: today,
      );

      final errs = validateContractCreateForm(
        ContractCreateDraft(
          busyIntervals: busy,
          todayStr: today,
          startDate: addDaysStr(today, 2),
          endDate: addDaysStr(today, 400),
        ),
      );
      expect(errs['start_date'], isNotEmpty,
          reason: 'ngày bắt đầu nằm trong lịch bận phải bị chặn');

      final free = validateContractCreateForm(
        ContractCreateDraft(
          busyIntervals: busy,
          todayStr: today,
          startDate: addDaysStr(today, 21),
          endDate: addDaysStr(today, 400),
        ),
      );
      expect(free['start_date'], isNull);
      expect(free['end_date'], isNull);
    });

    test('first available start date skips busy intervals', () {
      final today = toDateOnlyStr(DateTime.now());
      final busy = extractApartmentBusyIntervals(
        contracts: [
          {
            'id': 'c-busy',
            'status': 'ACTIVE',
            'start_date': addDaysStr(today, -1),
            'end_date': addDaysStr(today, 20),
          },
        ],
        todayStr: today,
      );
      final first = findFirstAvailableStartDate(today, busy, minSpanDays: 2);
      expect(first, addDaysStr(today, 21));
    });

    test('OCCUPIED apartment requires start date after today', () {
      final today = toDateOnlyStr(DateTime.now());
      final errs = validateContractCreateForm(
        ContractCreateDraft(
          apartmentStatus: 'OCCUPIED',
          todayStr: today,
          startDate: today,
        ),
      );
      expect(errs['start_date'], contains('sau hôm nay'));
    });
  });

  group('ContractsPage create modal UI', () {
    Future<void> pumpPage(
      WidgetTester tester, {
      List<dynamic> apartments = const [],
      Map<String, dynamic> apartmentDetail = const {},
    }) async {
      tester.view.physicalSize = const Size(1280, 900);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);

      SharedPreferences.setMockInitialValues({});
      final prefs = await SharedPreferences.getInstance();
      final storage = AppStorage(prefs: prefs, isWeb: true);

      final dio = Dio(BaseOptions(baseUrl: 'http://localhost:3000'));
      dio.httpClientAdapter = _MockHttpClientAdapter((options) async {
        late final dynamic data;
        if (options.path == '/api/v1/contracts' ||
            options.path == '/api/v1/contracts/requests') {
          data = <dynamic>[];
        } else if (options.path == '/api/v1/buildings') {
          data = [
            {'id': 'b1', 'name': 'Toa A'},
          ];
        } else if (options.path == '/api/v1/apartments') {
          data = apartments;
        } else if (options.path.startsWith('/api/v1/apartments/')) {
          data = apartmentDetail;
        } else {
          data = <dynamic>[];
        }
        return ResponseBody.fromString(
          jsonEncode({'success': true, 'data': data}),
          200,
          headers: {Headers.contentTypeHeader: [Headers.jsonContentType]},
        );
      });

      final container = ProviderContainer(
        overrides: [
          appStorageProvider.overrideWithValue(storage),
          dioProvider.overrideWithValue(dio),
          queryCacheProvider.overrideWithValue(QueryCache()),
        ],
      );
      container.read(authProvider.notifier).setAuthData(
            accessToken: 'token',
            refreshToken: 'refresh',
            user: _manager,
          );
      addTearDown(container.dispose);

      await tester.pumpWidget(
        UncontrolledProviderScope(
          container: container,
          child: const MaterialApp(home: Scaffold(body: ContractsPage())),
        ),
      );
      await tester.pumpAndSettle();
    }

    testWidgets('create form renders occupant relationship select', (tester) async {
      await pumpPage(tester);

      await tester.tap(find.widgetWithText(AppButton, 'Tạo hợp đồng'));
      await tester.pumpAndSettle();

      await tester.tap(find.widgetWithText(AppButton, 'Thêm thành viên ở cùng'));
      await tester.pumpAndSettle();

      expect(find.widgetWithText(AppSelect<String>, 'Quan hệ'), findsOneWidget,
          reason: 'phải render Select quan hệ cho thành viên ở cùng');
    });

    testWidgets('occupied start date is skipped and schedule is shown', (tester) async {
      final today = toDateOnlyStr(DateTime.now());
      final busy = [
        {
          'id': 'c-busy',
          'status': 'ACTIVE',
          'start_date': addDaysStr(today, -1),
          'end_date': addDaysStr(today, 20),
          'tenant_name': 'Khach cu',
        },
      ];
      await pumpPage(
        tester,
        apartments: [
          {
            'id': 'apt-1',
            'code': 'A-101',
            'building_id': 'b1',
            'base_rent': 10000000,
            'status': 'AVAILABLE',
          },
        ],
        apartmentDetail: {'contracts': busy, 'reservations': <dynamic>[]},
      );

      await tester.tap(find.widgetWithText(AppButton, 'Tạo hợp đồng'));
      await tester.pumpAndSettle();

      final aptSelect = find.widgetWithText(AppSelect<String>, 'Căn hộ');
      expect(aptSelect, findsOneWidget);
      await tester.tap(aptSelect);
      await tester.pumpAndSettle();
      final option = find.textContaining('A-101');
      expect(option, findsWidgets);
      await tester.tap(option.last);
      await tester.pumpAndSettle();

      expect(find.textContaining('Lịch đã thuê & đang giữ chỗ'), findsOneWidget,
          reason: 'phải hiển thị lịch hợp đồng/giữ chỗ của căn hộ');

      final expectedStart = findFirstAvailableStartDate(
        today,
        extractApartmentBusyIntervals(contracts: busy, todayStr: today),
        minSpanDays: 2,
      );
      final startInput = find.widgetWithText(AppInput, 'Ngày bắt đầu');
      expect(startInput, findsOneWidget);
      final startEditable = tester.widget<EditableText>(
        find.descendant(of: startInput, matching: find.byType(EditableText)),
      );
      expect(startEditable.controller.text, expectedStart,
          reason: 'phải tự chọn ngày trống đầu tiên, không phải ngày đang bận');
    });
  });
}
