import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:flutter_resihub/core/storage/app_storage.dart';
import 'package:flutter_resihub/features/auth/providers/auth_provider.dart';
import 'package:flutter_resihub/features/auth/screens/forgot_password_page.dart';
import 'package:flutter_resihub/features/auth/screens/login_page.dart';
import 'package:flutter_resihub/features/auth/services/auth_service.dart';
import 'package:flutter_resihub/shared/widgets/ui/app_toast_overlay.dart';

class _MockAuthService implements AuthService {
  Map<String, dynamic>? publicConfigResponse;
  Map<String, dynamic>? loginResponse;
  Exception? loginError;
  Map<String, dynamic>? requestOtpResponse;
  Exception? requestOtpError;
  Map<String, dynamic>? verifyOtpResponse;
  Exception? verifyOtpError;
  Map<String, dynamic>? forgotPasswordResponse;
  Exception? forgotPasswordError;
  Map<String, dynamic>? resetPasswordResponse;
  Exception? resetPasswordError;

  String? lastLoginEmail;
  String? lastLoginPassword;
  String? lastRequestOtpPhone;
  String? lastVerifyOtpPhone;
  String? lastVerifyOtpCode;
  String? lastForgotPasswordEmail;
  String? lastResetEmail;
  String? lastResetCode;
  String? lastResetNewPassword;

  @override
  Future<dynamic> getPublicConfig() async {
    if (publicConfigResponse != null) return publicConfigResponse;
    return {'showDemoAccounts': true};
  }

  @override
  Future<dynamic> loginEmail(String email, String password) async {
    lastLoginEmail = email;
    lastLoginPassword = password;
    if (loginError != null) throw loginError!;
    return loginResponse ??
        {
          'accessToken': 'test-access-token',
          'refreshToken': 'test-refresh-token',
          'user': {
            'id': 'user-1',
            'full_name': 'Admin Trần',
            'email': email,
            'roles': [
              {'code': 'SYS_ADMIN'}
            ],
          },
        };
  }

  @override
  Future<dynamic> requestOtp(String phone) async {
    lastRequestOtpPhone = phone;
    if (requestOtpError != null) throw requestOtpError!;
    return requestOtpResponse ??
        {
          'message': 'Mã OTP đã được gửi.',
          'devOtp': '123456',
        };
  }

  @override
  Future<dynamic> verifyOtp(String phone, String otp) async {
    lastVerifyOtpPhone = phone;
    lastVerifyOtpCode = otp;
    if (verifyOtpError != null) throw verifyOtpError!;
    return verifyOtpResponse ??
        {
          'accessToken': 'otp-access-token',
          'refreshToken': 'otp-refresh-token',
          'user': {
            'id': 'user-resident',
            'full_name': 'Cư dân Lê',
            'phone': phone,
            'roles': [
              {'code': 'RESIDENT'}
            ],
          },
        };
  }

  @override
  Future<dynamic> forgotPassword(String email) async {
    lastForgotPasswordEmail = email;
    if (forgotPasswordError != null) throw forgotPasswordError!;
    return forgotPasswordResponse ??
        {
          'message': 'Nếu email hợp lệ, mã khôi phục đã được gửi.',
          'devResetCode': '654321',
        };
  }

  @override
  Future<dynamic> resetPassword({
    required String email,
    required String code,
    required String newPassword,
  }) async {
    lastResetEmail = email;
    lastResetCode = code;
    lastResetNewPassword = newPassword;
    if (resetPasswordError != null) throw resetPasswordError!;
    return resetPasswordResponse ??
        {
          'message': 'Đặt lại mật khẩu thành công. Vui lòng đăng nhập.',
        };
  }

  @override
  Future<dynamic> changePassword(String currentPassword, String newPassword) async => {};

  @override
  Future<dynamic> getProfile() async => {};

  @override
  Future<dynamic> logout() async => {'success': true};

  @override
  Future<dynamic> me() async => {};

  @override
  Future<dynamic> updateProfile(Map<String, dynamic> payload) async => {};
}

Widget _buildTestApp({
  required ProviderContainer container,
  String initialLocation = '/login',
}) {
  final router = GoRouter(
    initialLocation: initialLocation,
    routes: [
      GoRoute(
        path: '/login',
        builder: (context, state) => const LoginPage(),
      ),
      GoRoute(
        path: '/forgot-password',
        builder: (context, state) => const ForgotPasswordPage(),
      ),
      GoRoute(
        path: '/admin/dashboard',
        builder: (context, state) => const Scaffold(
          body: Center(child: Text('Admin Dashboard Target Page')),
        ),
      ),
      GoRoute(
        path: '/resident',
        builder: (context, state) => const Scaffold(
          body: Center(child: Text('Resident Portal Target Page')),
        ),
      ),
      GoRoute(
        path: '/explore',
        builder: (context, state) => const Scaffold(
          body: Center(child: Text('Explore Target Page')),
        ),
      ),
    ],
  );

  return UncontrolledProviderScope(
    container: container,
    child: MaterialApp.router(
      routerConfig: router,
      builder: (context, child) => AppToastOverlay(child: child!),
    ),
  );
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late AppStorage storage;
  late _MockAuthService mockAuthService;

  setUp(() async {
    SharedPreferences.setMockInitialValues({});
    final prefs = await SharedPreferences.getInstance();
    storage = AppStorage(prefs: prefs, isWeb: true);
    await storage.init();
    mockAuthService = _MockAuthService();
  });

  ProviderContainer createContainer() {
    return ProviderContainer(
      overrides: [
        appStorageProvider.overrideWithValue(storage),
        authServiceProvider.overrideWithValue(mockAuthService),
      ],
    );
  }

  group('LoginPage Widget Tests', () {
    testWidgets('1. Shows demo accounts box when getPublicConfig returns showDemoAccounts: true and supports quick fill', (tester) async {
      mockAuthService.publicConfigResponse = {'showDemoAccounts': true};
      final container = createContainer();
      addTearDown(container.dispose);

      tester.view.physicalSize = const Size(1280, 800);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);

      await tester.pumpWidget(_buildTestApp(container: container));
      await tester.pumpAndSettle();

      // Demo box is visible
      expect(find.text('Tài khoản Demo kiểm thử nhanh'), findsOneWidget);
      expect(find.text('Quản trị (SYS_ADMIN)'), findsOneWidget);
      expect(find.text('admin@resihub.vn'), findsOneWidget);

      // Tap on demo account to quick fill
      await tester.tap(find.text('Quản trị (SYS_ADMIN)'));
      await tester.pumpAndSettle();

      expect(find.text('admin@resihub.vn'), findsWidgets);
    });

    testWidgets('2. Hides demo accounts box when getPublicConfig returns showDemoAccounts: false', (tester) async {
      mockAuthService.publicConfigResponse = {'showDemoAccounts': false};
      final container = createContainer();
      addTearDown(container.dispose);

      tester.view.physicalSize = const Size(1280, 800);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);

      await tester.pumpWidget(_buildTestApp(container: container));
      await tester.pumpAndSettle();

      expect(find.text('Tài khoản Demo kiểm thử nhanh'), findsNothing);
      expect(find.text('Quản trị (SYS_ADMIN)'), findsNothing);
    });

    testWidgets('3. Email + Password login validates empty fields and shows warning toast', (tester) async {
      final container = createContainer();
      addTearDown(container.dispose);

      tester.view.physicalSize = const Size(1280, 800);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);

      await tester.pumpWidget(_buildTestApp(container: container));
      await tester.pumpAndSettle();

      // Tap login without typing email or password
      final loginBtn = find.widgetWithText(ElevatedButton, 'Đăng nhập');
      final submitFinder = loginBtn.evaluate().isNotEmpty
          ? loginBtn
          : find.text('Đăng nhập');
      await tester.tap(submitFinder.first);
      await tester.pump();

      expect(find.text('Vui lòng nhập đầy đủ Email và Mật khẩu.'), findsOneWidget);
      expect(mockAuthService.lastLoginEmail, isNull);
    });

    testWidgets('4. Email + Password login succeeds and updates authProvider and navigates to target home', (tester) async {
      final container = createContainer();
      addTearDown(container.dispose);

      tester.view.physicalSize = const Size(1280, 800);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);

      await tester.pumpWidget(_buildTestApp(container: container));
      await tester.pumpAndSettle();

      // Enter email and password
      final emailInput = find.widgetWithText(TextFormField, 'Địa chỉ Email');
      final passwordInput = find.widgetWithText(TextFormField, 'Mật khẩu');

      if (emailInput.evaluate().isNotEmpty) {
        await tester.enterText(emailInput, 'admin@resihub.vn');
      } else {
        await tester.enterText(find.byType(TextFormField).first, 'admin@resihub.vn');
      }

      if (passwordInput.evaluate().isNotEmpty) {
        await tester.enterText(passwordInput, 'Admin@123456');
      } else {
        await tester.enterText(find.byType(TextFormField).at(1), 'Admin@123456');
      }

      // Tap submit
      await tester.tap(find.text('Đăng nhập').first);
      await tester.pumpAndSettle();

      expect(mockAuthService.lastLoginEmail, 'admin@resihub.vn');
      expect(mockAuthService.lastLoginPassword, 'Admin@123456');

      // authProvider updated
      final authState = container.read(authProvider);
      expect(authState.isAuthenticated, isTrue);
      expect(authState.accessToken, 'test-access-token');
      expect(authState.user?.fullName, 'Admin Trần');

      // Success toast & navigate
      expect(find.text('Xin chào Admin Trần!'), findsOneWidget);
      expect(find.text('Admin Dashboard Target Page'), findsOneWidget);
    });

    testWidgets('5. Email + Password login shows error toast on API failure', (tester) async {
      mockAuthService.loginError = DioException(
        requestOptions: RequestOptions(path: '/api/v1/auth/login'),
        response: Response(
          requestOptions: RequestOptions(path: '/api/v1/auth/login'),
          statusCode: 401,
          data: {'message': 'Tài khoản hoặc mật khẩu không chính xác.'},
        ),
      );

      final container = createContainer();
      addTearDown(container.dispose);

      tester.view.physicalSize = const Size(1280, 800);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);

      await tester.pumpWidget(_buildTestApp(container: container));
      await tester.pumpAndSettle();

      await tester.enterText(find.byType(TextFormField).first, 'admin@resihub.vn');
      await tester.enterText(find.byType(TextFormField).at(1), 'WrongPassword');
      await tester.tap(find.text('Đăng nhập').first);
      await tester.pumpAndSettle();

      expect(find.text('Tài khoản hoặc mật khẩu không chính xác.'), findsOneWidget);
      expect(container.read(authProvider).isAuthenticated, isFalse);
    });

    testWidgets('6. Phone OTP 2-step flow requests OTP, handles 60s countdown, and logs in on verify', (tester) async {
      final container = createContainer();
      addTearDown(container.dispose);

      tester.view.physicalSize = const Size(1280, 800);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);

      await tester.pumpWidget(_buildTestApp(container: container));
      await tester.pumpAndSettle();

      // Switch to Phone OTP tab
      await tester.tap(find.text('Số điện thoại (OTP)'));
      await tester.pumpAndSettle();

      // Enter invalid phone
      await tester.enterText(find.byType(TextFormField).first, '1234');
      await tester.tap(find.text('Nhận mã xác thực OTP'));
      await tester.pump();
      expect(find.text('Vui lòng nhập số điện thoại 10 chữ số hợp lệ (ví dụ: 0912345678).'), findsOneWidget);

      // Enter valid phone and request OTP
      await tester.enterText(find.byType(TextFormField).first, '0912345678');
      await tester.tap(find.text('Nhận mã xác thực OTP'));
      await tester.pumpAndSettle();

      expect(mockAuthService.lastRequestOtpPhone, '0912345678');
      expect(find.text('Mã OTP đã được gửi.'), findsOneWidget);
      expect(find.text('[Dev Mode] Mã OTP của bạn: 123456'), findsOneWidget);
      expect(find.textContaining('Gửi lại sau 60s'), findsOneWidget);

      // Ticking down countdown timer by 10s
      await tester.pump(const Duration(seconds: 10));
      expect(find.textContaining('Gửi lại sau 50s'), findsOneWidget);

      // Enter OTP code and verify
      final otpField = find.widgetWithText(TextFormField, 'Mã OTP (6 chữ số)');
      if (otpField.evaluate().isNotEmpty) {
        await tester.enterText(otpField, '123456');
      } else {
        await tester.enterText(find.byType(TextFormField).first, '123456');
      }

      await tester.tap(find.text('Xác thực & Đăng nhập'));
      await tester.pumpAndSettle();

      expect(mockAuthService.lastVerifyOtpCode, '123456');
      expect(container.read(authProvider).isAuthenticated, isTrue);
      expect(container.read(authProvider).user?.fullName, 'Cư dân Lê');
      expect(find.text('Resident Portal Target Page'), findsOneWidget);
    });

    testWidgets('7. Phone OTP countdown timer is cancelled cleanly when unmounted without pending timer errors', (tester) async {
      final container = createContainer();
      addTearDown(container.dispose);

      tester.view.physicalSize = const Size(1280, 800);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);

      await tester.pumpWidget(_buildTestApp(container: container));
      await tester.pumpAndSettle();

      // Switch to Phone OTP tab and request OTP
      await tester.tap(find.text('Số điện thoại (OTP)'));
      await tester.pumpAndSettle();

      await tester.enterText(find.byType(TextFormField).first, '0987654321');
      await tester.tap(find.text('Nhận mã xác thực OTP'));
      await tester.pumpAndSettle();

      // Timer is running (countdown = 60s)
      await tester.pump(const Duration(seconds: 5));

      // Navigate away / unmount LoginPage by pumping a different widget
      await tester.pumpWidget(
        UncontrolledProviderScope(
          container: container,
          child: const MaterialApp(
            home: Scaffold(body: Text('Different Screen')),
          ),
        ),
      );
      await tester.pumpAndSettle();

      // If timer wasn't cancelled in dispose(), Flutter test harness would fail here!
      expect(find.text('Different Screen'), findsOneWidget);
    });

    testWidgets('8. Links on LoginPage navigate to /forgot-password and /explore', (tester) async {
      final container = createContainer();
      addTearDown(container.dispose);

      tester.view.physicalSize = const Size(1280, 800);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);

      await tester.pumpWidget(_buildTestApp(container: container));
      await tester.pumpAndSettle();

      // Tap "Quên mật khẩu?"
      await tester.tap(find.text('Quên mật khẩu?'));
      await tester.pumpAndSettle();
      expect(find.text('Khôi phục mật khẩu'), findsOneWidget);

      // Tap "Quay lại trang Đăng nhập"
      await tester.tap(find.text('Quay lại trang Đăng nhập'));
      await tester.pumpAndSettle();
      expect(find.text('Đăng nhập hệ thống'), findsOneWidget);

      // Tap "Khám phá căn hộ trống & Đặt giữ chỗ online"
      await tester.tap(find.text('Khám phá căn hộ trống & Đặt giữ chỗ online').first);
      await tester.pumpAndSettle();
      expect(find.text('Explore Target Page'), findsOneWidget);
    });
  });

  group('ForgotPasswordPage Widget Tests', () {
    testWidgets('1. Step 1 requests reset code with email, then Step 2 resets password and returns to login', (tester) async {
      final container = createContainer();
      addTearDown(container.dispose);

      tester.view.physicalSize = const Size(1280, 800);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);

      await tester.pumpWidget(_buildTestApp(container: container, initialLocation: '/forgot-password'));
      await tester.pumpAndSettle();

      expect(find.text('Khôi phục mật khẩu'), findsOneWidget);
      expect(find.text('Nhập địa chỉ email tài khoản để nhận mã xác nhận khôi phục.'), findsOneWidget);

      // Step 1: enter email
      await tester.enterText(find.byType(TextFormField).first, 'manager@resihub.vn');
      await tester.tap(find.text('Gửi mã xác nhận'));
      await tester.pumpAndSettle();

      expect(mockAuthService.lastForgotPasswordEmail, 'manager@resihub.vn');
      expect(find.text('Nếu email hợp lệ, mã khôi phục đã được gửi.'), findsOneWidget);

      // Step 2 is active: shows dev code hint
      expect(find.textContaining('654321'), findsOneWidget);

      // Password length validation (< 8 chars)
      await tester.enterText(find.byType(TextFormField).first, '654321');
      await tester.enterText(find.byType(TextFormField).at(1), 'short');
      await tester.tap(find.text('Cập nhật mật khẩu mới'));
      await tester.pump();
      expect(find.text('Mật khẩu mới phải từ 8 ký tự trở lên.'), findsOneWidget);

      // Valid reset
      await tester.enterText(find.byType(TextFormField).at(1), 'ValidPassword@123');
      await tester.tap(find.text('Cập nhật mật khẩu mới'));
      await tester.pumpAndSettle();

      expect(mockAuthService.lastResetEmail, 'manager@resihub.vn');
      expect(mockAuthService.lastResetCode, '654321');
      expect(mockAuthService.lastResetNewPassword, 'ValidPassword@123');

      expect(find.text('Đặt lại mật khẩu thành công. Vui lòng đăng nhập.'), findsOneWidget);
      // Navigated to /login
      expect(find.text('Đăng nhập hệ thống'), findsOneWidget);
    });

    testWidgets('2. Step 2 resend timer cancels cleanly on dispose', (tester) async {
      final container = createContainer();
      addTearDown(container.dispose);

      tester.view.physicalSize = const Size(1280, 800);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);

      await tester.pumpWidget(_buildTestApp(container: container, initialLocation: '/forgot-password'));
      await tester.pumpAndSettle();

      await tester.enterText(find.byType(TextFormField).first, 'manager@resihub.vn');
      await tester.tap(find.text('Gửi mã xác nhận'));
      await tester.pumpAndSettle();

      // In Step 2, unmount
      await tester.pump(const Duration(seconds: 3));
      await tester.pumpWidget(
        UncontrolledProviderScope(
          container: container,
          child: const MaterialApp(
            home: Scaffold(body: Text('Another Page')),
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Another Page'), findsOneWidget);
    });
  });
}
