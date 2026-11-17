import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:flutter_resihub/core/config/app_env.dart';
import 'package:flutter_resihub/core/network/dio_client.dart';
import 'package:flutter_resihub/core/storage/app_storage.dart';
import 'package:flutter_resihub/features/auth/models/user_model.dart';
import 'package:flutter_resihub/features/auth/providers/auth_provider.dart';
import 'package:flutter_resihub/features/public/screens/public_explore_page.dart';
import 'package:flutter_resihub/features/public/services/public_service.dart';
import 'package:flutter_resihub/shared/widgets/ui/app_toast_overlay.dart';
import 'package:flutter_resihub/shared/widgets/ui/file_upload_field.dart';

class _FakePublicService implements PublicService {
  Map<String, dynamic>? lastGetApartmentsParams;
  String? lastOtpPhone;
  Map<String, dynamic>? lastCreateReservationPayload;
  Map<String, dynamic>? lastCreateReservationOptions;

  Map<String, dynamic> mockApartmentsData = {
    'buildings': [
      {
        'id': 'b-01',
        'code': 'T1',
        'name': 'Tòa Tháp Đôi Sun',
        'address': '123 Cầu Giấy, Hà Nội',
      },
      {
        'id': 'b-02',
        'code': 'T2',
        'name': 'Tòa Ruby Park',
        'address': '456 Tây Hồ, Hà Nội',
      },
    ],
    'apartments': [
      {
        'id': 'apt-101',
        'code': '101',
        'building_id': 'b-01',
        'building_code': 'T1',
        'building_name': 'Tòa Tháp Đôi Sun',
        'building_address': '123 Cầu Giấy, Hà Nội',
        'org_id': 'org-01',
        'floor_name': 'Tầng 1',
        'type': '1PN',
        'bedrooms': 1,
        'area_m2': 45.0,
        'base_rent': 8500000,
        'amenities': ['Điều hòa', 'Nóng lạnh', 'Tủ lạnh'],
      },
      {
        'id': 'apt-202',
        'code': '202',
        'building_id': 'b-02',
        'building_code': 'T2',
        'building_name': 'Tòa Ruby Park',
        'building_address': '456 Tây Hồ, Hà Nội',
        'org_id': 'org-01',
        'floor_name': 'Tầng 2',
        'type': '2PN',
        'bedrooms': 2,
        'area_m2': 70.0,
        'base_rent': 14000000,
        'amenities': ['Điều hòa', 'Máy giặt', 'Ban công'],
      },
    ],
    'policy': {
      'max_hold_days': 30,
      'public_max_hold_days': 7,
      'full_refund_before_days': 3,
      'partial_refund_pct': 50,
      'default_hold_amount': 2000000,
    },
    'policies_by_org': {
      'org-01': {
        'max_hold_days': 30,
        'public_max_hold_days': 7,
        'full_refund_before_days': 3,
        'partial_refund_pct': 50,
        'default_hold_amount': 2000000,
      },
    },
    'payment_accounts': {
      'b-01': {
        'bank_bin': '970422',
        'bank_name': 'MB Bank',
        'account_number': '09123456789',
        'account_name': 'CONG TY RESIHUB',
      },
      'b-02': {
        'bank_bin': '970415',
        'bank_name': 'VietinBank',
        'account_number': '1010101010',
        'account_name': 'CONG TY RESIHUB',
      },
    },
  };

  @override
  Future<dynamic> getApartments([Map<String, dynamic>? params]) async {
    lastGetApartmentsParams = params;
    return {'data': mockApartmentsData};
  }

  @override
  Future<dynamic> requestReservationOtp(String phone) async {
    lastOtpPhone = phone;
    return {
      'message': 'Mã OTP đã được gửi đến số điện thoại',
      'devOtp': '123456',
    };
  }

  @override
  Future<dynamic> createReservation(Map<String, dynamic> payload, [Map<String, dynamic>? options]) async {
    lastCreateReservationPayload = payload;
    lastCreateReservationOptions = options;
    return {
      'message': 'Đã gửi yêu cầu giữ chỗ trực tuyến thành công!',
      'data': {
        'id': 'res-101',
        'apartment_id': payload['apartment_id'],
        'prospect_name': payload['prospect_name'],
        'phone': payload['phone'],
        'hold_amount': payload['hold_amount'],
        'hold_until': payload['hold_until'],
        'status': 'PENDING_CONFIRMATION',
      },
    };
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('PublicService Unit Tests', () {
    late Dio testDio;
    late List<RequestOptions> recordedRequests;

    setUp(() {
      recordedRequests = [];
      testDio = Dio(
        BaseOptions(
          baseUrl: AppEnv.apiBaseUrl,
          headers: {'Content-Type': 'application/json'},
        ),
      );
      testDio.interceptors.add(
        InterceptorsWrapper(
          onRequest: (options, handler) {
            recordedRequests.add(options);
            return handler.resolve(
              Response(
                requestOptions: options,
                data: {'success': true, 'path': options.path},
                statusCode: 200,
              ),
            );
          },
        ),
      );
    });

    test('getApartments calls GET /api/v1/public/apartments with queryParameters', () async {
      final service = PublicService(dio: testDio);
      final res = await service.getApartments({'building_id': 'b-01'});

      expect(res, isNotNull);
      expect(recordedRequests.length, 1);
      final req = recordedRequests.first;
      expect(req.method, 'GET');
      expect(req.path, '/api/v1/public/apartments');
      expect(req.queryParameters, {'building_id': 'b-01'});
    });

    test('requestReservationOtp calls POST /api/v1/public/reservations/otp/request with phone', () async {
      final service = PublicService(dio: testDio);
      final res = await service.requestReservationOtp('0912345678');

      expect(res, isNotNull);
      expect(recordedRequests.length, 1);
      final req = recordedRequests.first;
      expect(req.method, 'POST');
      expect(req.path, '/api/v1/public/reservations/otp/request');
      expect(req.data, {'phone': '0912345678'});
    });

    test('createReservation attaches Idempotency-Key from options and calls POST /api/v1/public/reservations', () async {
      final service = PublicService(dio: testDio);
      const customKey = 'test-custom-idempotency-key-123';
      final payload = {
        'apartment_id': 'apt-101',
        'prospect_name': 'Nguyen Van A',
        'phone': '0912345678',
        'otp': '123456',
        'hold_amount': 2000000,
      };

      await service.createReservation(payload, {'idempotencyKey': customKey});

      expect(recordedRequests.length, 1);
      final req = recordedRequests.first;
      expect(req.method, 'POST');
      expect(req.path, '/api/v1/public/reservations');
      expect(req.data, payload);
      expect(req.headers['Idempotency-Key'], customKey);
    });

    test('publicServiceProvider uses publicDioProvider without Authorization header even if AppStorage has token', () async {
      SharedPreferences.setMockInitialValues({});
      final prefs = await SharedPreferences.getInstance();
      final storage = AppStorage(prefs: prefs, isWeb: true);
      await storage.init();
      await storage.setTokens(accessToken: 'mock-jwt-token-active', refreshToken: 'mock-refresh-token');

      final container = ProviderContainer(
        overrides: [
          appStorageProvider.overrideWithValue(storage),
        ],
      );
      addTearDown(container.dispose);

      final service = container.read(publicServiceProvider);
      expect(service, isNotNull);

      // Verify that the public Dio used by publicServiceProvider has NO AuthInterceptor
      final publicDio = container.read(publicDioProvider);
      final headers = publicDio.options.headers;
      expect(headers['Authorization'], isNull);
    });
  });

  group('PublicExplorePage Widget Tests', () {
    late SharedPreferences prefs;
    late AppStorage storage;
    late _FakePublicService fakeService;

    setUp(() async {
      SharedPreferences.setMockInitialValues({});
      prefs = await SharedPreferences.getInstance();
      storage = AppStorage(prefs: prefs, isWeb: true);
      await storage.init();
      fakeService = _FakePublicService();
    });

    Widget createTestWidget({
      AuthState? initialAuthState,
      _FakePublicService? service,
    }) {
      final s = service ?? fakeService;
      return ProviderScope(
        overrides: [
          appStorageProvider.overrideWithValue(storage),
          publicServiceProvider.overrideWithValue(s),
          authProvider.overrideWith(
            () => _StubAuthNotifier(initialAuthState ?? const AuthState()),
          ),
        ],
        child: const MaterialApp(
          home: Scaffold(
            body: AppToastOverlay(
              child: PublicExplorePage(),
            ),
          ),
        ),
      );
    }

    testWidgets('Renders route marker and compatibility texts for router tests', (tester) async {
      await tester.binding.setSurfaceSize(const Size(1280, 900));
      addTearDown(() => tester.binding.setSurfaceSize(null));

      await tester.pumpWidget(createTestWidget());
      await tester.pumpAndSettle();

      // Compatibility markers for app_router / widget_test
      expect(find.text('Route: /explore'), findsOneWidget);
      expect(find.text('Khám phá ResiHub'), findsOneWidget);
    });

    testWidgets('Renders hero banner, building cards, and apartment catalog', (tester) async {
      await tester.binding.setSurfaceSize(const Size(1280, 900));
      addTearDown(() => tester.binding.setSurfaceSize(null));

      await tester.pumpWidget(createTestWidget());
      await tester.pumpAndSettle();

      // Hero banner text
      expect(
        find.text('Khám phá căn hộ còn trống & Đặt giữ chỗ trực tuyến ngay hôm nay'),
        findsOneWidget,
      );

      // Building cards
      expect(find.text('Tòa Tháp Đôi Sun'), findsWidgets);
      expect(find.text('Tòa Ruby Park'), findsWidgets);

      // Apartment cards
      expect(find.text('Căn hộ 101'), findsOneWidget);
      expect(find.text('Căn hộ 202'), findsOneWidget);

      // Specs
      expect(find.textContaining('45'), findsWidgets); // 45.0 m²
      expect(find.textContaining('70'), findsWidgets); // 70.0 m²
      expect(find.text('Còn trống'), findsNWidgets(2));
    });

    testWidgets('Top navigation changes based on auth state', (tester) async {
      await tester.binding.setSurfaceSize(const Size(1280, 900));
      addTearDown(() => tester.binding.setSurfaceSize(null));

      // Unauthenticated
      await tester.pumpWidget(createTestWidget());
      await tester.pumpAndSettle();
      expect(find.text('Đăng nhập'), findsOneWidget);
      expect(find.text('Tra cứu giữ chỗ / Cư dân (OTP)'), findsOneWidget);
      expect(find.text('Vào cổng của tôi'), findsNothing);

      // Authenticated as Resident
      const residentState = AuthState(
        isAuthenticated: true,
        user: UserModel(
          id: 'u-res',
          email: 'res@resihub.vn',
          fullName: 'Resident User',
          roles: [UserRoleModel(code: 'RESIDENT')],
        ),
      );

      await tester.pumpWidget(const SizedBox());
      await tester.pumpWidget(createTestWidget(initialAuthState: residentState));
      await tester.pumpAndSettle();
      expect(find.text('Vào cổng của tôi'), findsOneWidget);
      expect(find.text('Đăng nhập'), findsNothing);
    });

    testWidgets('Filters apartments by search query', (tester) async {
      await tester.binding.setSurfaceSize(const Size(1280, 900));
      addTearDown(() => tester.binding.setSurfaceSize(null));

      await tester.pumpWidget(createTestWidget());
      await tester.pumpAndSettle();

      expect(find.text('Căn hộ 101'), findsOneWidget);
      expect(find.text('Căn hộ 202'), findsOneWidget);

      // Search for 101
      final searchInput = find.byType(TextField).first;
      await tester.enterText(searchInput, '101');
      await tester.pumpAndSettle();

      expect(find.text('Căn hộ 101'), findsOneWidget);
      expect(find.text('Căn hộ 202'), findsNothing);

      // Search for non-existent apartment
      await tester.enterText(searchInput, 'XYZ-UNKNOWN');
      await tester.pumpAndSettle();

      expect(find.text('Chưa tìm thấy căn hộ trống phù hợp'), findsOneWidget);
    });

    testWidgets('Clicking building card filters apartments and clicking again resets', (tester) async {
      await tester.binding.setSurfaceSize(const Size(1280, 900));
      addTearDown(() => tester.binding.setSurfaceSize(null));

      await tester.pumpWidget(createTestWidget());
      await tester.pumpAndSettle();

      // Click Tòa Tháp Đôi Sun
      final buildingCard = find.text('Tòa Tháp Đôi Sun').first;
      await tester.tap(buildingCard);
      await tester.pumpAndSettle();

      expect(find.text('Căn hộ 101'), findsOneWidget);
      expect(find.text('Căn hộ 202'), findsNothing);

      // Reset filter via "Xem tất cả tòa nhà"
      final resetLink = find.text('Xem tất cả tòa nhà');
      expect(resetLink, findsOneWidget);
      await tester.tap(resetLink);
      await tester.pumpAndSettle();

      expect(find.text('Căn hộ 101'), findsOneWidget);
      expect(find.text('Căn hộ 202'), findsOneWidget);
    });

    testWidgets('Full Booking Flow: validation, OTP request, countdown, form submit & done state', (tester) async {
      await tester.binding.setSurfaceSize(const Size(1280, 1100));
      addTearDown(() => tester.binding.setSurfaceSize(null));

      await tester.pumpWidget(createTestWidget());
      await tester.pumpAndSettle();

      // Click "Đặt giữ chỗ Online" on apartment 101
      final bookButtons = find.text('Đặt giữ chỗ Online');
      expect(bookButtons, findsWidgets);
      await tester.ensureVisible(bookButtons.first);
      await tester.pumpAndSettle();
      await tester.tap(bookButtons.first);
      await tester.pumpAndSettle();

      // Modal is open
      expect(find.textContaining('Đặt giữ chỗ Trực tuyến — Căn 101'), findsOneWidget);
      expect(find.textContaining('Chính sách Đặt cọc Giữ chỗ công khai'), findsOneWidget);
      expect(find.textContaining('Tài khoản nhận chuyển khoản'), findsOneWidget);
      expect(find.text('09123456789'), findsOneWidget); // bank account number

      // Try sending OTP with invalid phone
      final sendOtpBtn = find.byKey(const Key('booking-send-otp-btn'));
      expect(sendOtpBtn, findsOneWidget);
      await tester.ensureVisible(sendOtpBtn);
      await tester.pumpAndSettle();
      await tester.tap(sendOtpBtn);
      await tester.pumpAndSettle();
      expect(find.textContaining('Vui lòng nhập số điện thoại'), findsOneWidget);

      // Enter valid phone and send OTP
      final phoneFinder = find.descendant(
        of: find.byKey(const Key('booking-phone')),
        matching: find.byType(TextField),
      );
      await tester.enterText(phoneFinder, '0912345678');
      await tester.pumpAndSettle();

      await tester.ensureVisible(sendOtpBtn);
      await tester.pumpAndSettle();
      await tester.tap(sendOtpBtn);
      await tester.pumpAndSettle();

      expect(fakeService.lastOtpPhone, '0912345678');
      expect(find.textContaining('[Dev Mode] Mã OTP xác thực SĐT của bạn: 123456'), findsOneWidget);

      // Countdown started (e.g. 60s)
      expect(find.textContaining('60s'), findsOneWidget);

      // Try submitting without required fields
      final submitBtn = find.byKey(const Key('booking-submit-btn'));
      await tester.ensureVisible(submitBtn);
      await tester.tap(submitBtn);
      await tester.pumpAndSettle();

      expect(find.textContaining('Vui lòng nhập họ và tên'), findsOneWidget);

      // Fill Name
      final nameFinder = find.descendant(
        of: find.byKey(const Key('booking-name')),
        matching: find.byType(TextField),
      );
      await tester.enterText(nameFinder, 'Trần Minh Hoàng');
      await tester.pumpAndSettle();

      // Fill OTP
      final otpFinder = find.descendant(
        of: find.byKey(const Key('booking-otp')),
        matching: find.byType(TextField),
      );
      await tester.enterText(otpFinder, '123456');
      await tester.pumpAndSettle();

      // Check privacy checkbox
      final checkboxFinder = find.byKey(const Key('booking-privacy-checkbox'));
      await tester.ensureVisible(checkboxFinder);
      await tester.tap(checkboxFinder);
      await tester.pumpAndSettle();

      // Submit without evidence
      await tester.tap(submitBtn);
      await tester.pumpAndSettle();
      expect(find.textContaining('Vui lòng tải lên ảnh chụp biên lai chuyển khoản'), findsOneWidget);

      // Provide evidence UNC
      final fileUpload = tester.widget<FileUploadField>(find.byKey(const Key('booking-evidence')));
      fileUpload.onChanged?.call(['https://cdn.resihub.vn/receipt_unc_101.jpg']);
      await tester.pumpAndSettle();

      // Submit valid booking
      await tester.tap(submitBtn);
      await tester.pumpAndSettle();

      expect(fakeService.lastCreateReservationPayload, isNotNull);
      expect(fakeService.lastCreateReservationPayload!['apartment_id'], 'apt-101');
      expect(fakeService.lastCreateReservationPayload!['prospect_name'], 'Trần Minh Hoàng');
      expect(fakeService.lastCreateReservationPayload!['phone'], '0912345678');
      expect(fakeService.lastCreateReservationPayload!['otp'], '123456');
      expect(fakeService.lastCreateReservationPayload!['evidence'], ['https://cdn.resihub.vn/receipt_unc_101.jpg']);

      // Modal enters 'done' step
      expect(
        find.textContaining('Yêu cầu giữ chỗ đang chờ Ban quản lý đối chiếu sao kê xác nhận'),
        findsOneWidget,
      );
      expect(find.text('Đăng nhập OTP Cổng cư dân để theo dõi'), findsOneWidget);
    });

    testWidgets('OTP timer cleans up on unmount without timer leak', (tester) async {
      await tester.binding.setSurfaceSize(const Size(1280, 900));
      addTearDown(() => tester.binding.setSurfaceSize(null));

      await tester.pumpWidget(createTestWidget());
      await tester.pumpAndSettle();

      // Open modal
      final bookBtn = find.text('Đặt giữ chỗ Online').first;
      await tester.ensureVisible(bookBtn);
      await tester.pumpAndSettle();
      await tester.tap(bookBtn);
      await tester.pumpAndSettle();

      // Enter valid phone & send OTP to trigger countdown timer
      final phoneFinder = find.descendant(
        of: find.byKey(const Key('booking-phone')),
        matching: find.byType(TextField),
      );
      await tester.enterText(phoneFinder, '0988776655');
      await tester.pumpAndSettle();

      await tester.tap(find.byKey(const Key('booking-send-otp-btn')));
      await tester.pumpAndSettle();

      // Close modal by clicking "Hủy"
      final cancelBtn = find.byKey(const Key('booking-cancel-btn'));
      await tester.ensureVisible(cancelBtn);
      await tester.tap(cancelBtn);
      await tester.pumpAndSettle();

      // Unmount the entire widget tree to verify no dangling timer exception is thrown
      await tester.pumpWidget(const SizedBox());
      await tester.pumpAndSettle();
    });
  });
}

class _StubAuthNotifier extends AuthNotifier {
  final AuthState _initial;
  _StubAuthNotifier(this._initial);

  @override
  AuthState build() => _initial;
}
