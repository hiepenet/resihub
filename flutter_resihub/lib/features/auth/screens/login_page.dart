import 'dart:async';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../../../core/theme/app_colors.dart';
import '../../../core/utils/permissions.dart';
import '../../../core/utils/validation.dart';
import '../../../shared/providers/toast_provider.dart';
import '../../../shared/widgets/ui/app_button.dart';
import '../../../shared/widgets/ui/app_input.dart';
import '../models/user_model.dart';
import '../providers/auth_provider.dart';
import '../services/auth_service.dart';

const _kDemoAccounts = [
  (label: 'Quản trị (SYS_ADMIN)', email: 'admin@resihub.vn', pass: 'Admin@123456'),
  (label: 'Chủ đầu tư Ocean Park', email: 'owner.vop@resihub.vn', pass: 'Demo@123456'),
  (label: 'Quản lý Ocean Park 1', email: 'manager.vop1@resihub.vn', pass: 'Demo@123456'),
  (label: 'Quản lý Ocean Park 2', email: 'manager.vop2@resihub.vn', pass: 'Demo@123456'),
  (label: 'Quản lý Ocean Park 3', email: 'manager.vop3@resihub.vn', pass: 'Demo@123456'),
  (label: 'Cư dân mẫu', email: 'tenant1@resihub.vn', pass: 'Demo@123456'),
];

/// Login page matching `frontend/src/pages/auth/LoginPage.jsx`.
///
/// Features:
/// - Dual-mode authentication: Email/Password & Phone OTP.
/// - Dynamic demo accounts container backed by `authService.getPublicConfig()`.
/// - 60s resend OTP countdown timer cancelled cleanly on dispose.
/// - Immediate redirection if already authenticated.
class LoginPage extends ConsumerStatefulWidget {
  final String? initialMode;
  final String? initialPhone;

  const LoginPage({
    super.key,
    this.initialMode,
    this.initialPhone,
  });

  @override
  ConsumerState<LoginPage> createState() => _LoginPageState();
}

class _LoginPageState extends ConsumerState<LoginPage> {
  late String _mode; // 'email' | 'otp'
  final TextEditingController _emailController = TextEditingController();
  final TextEditingController _passwordController = TextEditingController();
  bool _showPassword = false;

  late final TextEditingController _phoneController;
  final TextEditingController _otpController = TextEditingController();
  String _otpStep = 'request'; // 'request' | 'verify'
  int _countdown = 0;
  Timer? _countdownTimer;
  String _devOtpHint = '';

  bool _loading = false;
  bool _showDemoAccounts = kDebugMode;

  @override
  void initState() {
    super.initState();
    _mode = widget.initialMode == 'otp' ? 'otp' : 'email';
    _phoneController = TextEditingController(text: widget.initialPhone ?? '');

    _loadPublicConfig();

    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      final auth = ref.read(authProvider);
      if (auth.isAuthenticated && auth.user != null) {
        context.go(auth.isAdminPortal ? '/admin/dashboard' : '/resident');
      }
    });
  }

  Future<void> _loadPublicConfig() async {
    try {
      final authService = ref.read(authServiceProvider);
      final dynamic cfg = await authService.getPublicConfig();
      if (!mounted) return;
      if (cfg is Map) {
        if (cfg.containsKey('showDemoAccounts')) {
          setState(() {
            _showDemoAccounts = cfg['showDemoAccounts'] == true;
          });
        } else if (cfg.containsKey('show_demo_accounts')) {
          setState(() {
            _showDemoAccounts = cfg['show_demo_accounts'] == true;
          });
        }
      }
    } catch (_) {
      // Silently fall back to default
    }
  }

  void _startCountdown([int seconds = 60]) {
    _countdownTimer?.cancel();
    if (!mounted) return;
    setState(() {
      _countdown = seconds;
    });
    _countdownTimer = Timer.periodic(const Duration(seconds: 1), (timer) {
      if (!mounted) {
        timer.cancel();
        return;
      }
      if (_countdown <= 1) {
        timer.cancel();
        setState(() {
          _countdown = 0;
        });
      } else {
        setState(() {
          _countdown--;
        });
      }
    });
  }

  @override
  void dispose() {
    _countdownTimer?.cancel();
    _countdownTimer = null;
    _emailController.dispose();
    _passwordController.dispose();
    _phoneController.dispose();
    _otpController.dispose();
    super.dispose();
  }

  Future<void> _handleLoginSuccess(dynamic res) async {
    if (res is! Map) return;

    final accessToken = res['accessToken']?.toString() ??
        res['access_token']?.toString() ??
        res['token']?.toString() ??
        '';
    final refreshToken = res['refreshToken']?.toString() ??
        res['refresh_token']?.toString();

    final userRaw = res['user'];
    final UserModel userModel;
    if (userRaw is Map<String, dynamic>) {
      userModel = UserModel.fromJson(userRaw);
    } else if (userRaw is Map) {
      userModel = UserModel.fromJson(Map<String, dynamic>.from(userRaw));
    } else {
      userModel = UserModel(
        id: 'user',
        fullName: 'Người dùng',
      );
    }

    await ref.read(authProvider.notifier).setAuthData(
          accessToken: accessToken,
          refreshToken: refreshToken,
          user: userModel,
        );

    final name = userModel.fullName.trim().isNotEmpty ? userModel.fullName : 'bạn';
    ref.read(toastProvider.notifier).success('Xin chào $name!');

    if (!mounted) return;
    final target = isAdminPortalUser(userModel) ? '/admin/dashboard' : '/resident';
    context.go(target);
  }

  Future<void> _handleEmailSubmit() async {
    final email = _emailController.text.trim();
    final password = _passwordController.text;

    if (email.isEmpty || password.isEmpty) {
      ref.read(toastProvider.notifier).warning('Vui lòng nhập đầy đủ Email và Mật khẩu.');
      return;
    }

    setState(() => _loading = true);
    try {
      final authService = ref.read(authServiceProvider);
      final res = await authService.loginEmail(email, password);
      await _handleLoginSuccess(res);
    } catch (err) {
      ref.read(toastProvider.notifier).error(
            extractErrorMessage(err, 'Đăng nhập thất bại.'),
          );
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _handleRequestOtp() async {
    final rawPhone = _phoneController.text.trim();
    if (!isValidPhone(rawPhone)) {
      ref.read(toastProvider.notifier).warning(
            'Vui lòng nhập số điện thoại 10 chữ số hợp lệ (ví dụ: 0912345678).',
          );
      return;
    }

    setState(() => _loading = true);
    try {
      final clean = normalizePhone(rawPhone);
      final authService = ref.read(authServiceProvider);
      final dynamic res = await authService.requestOtp(clean);

      final msg = (res is Map && res['message'] != null)
          ? res['message'].toString()
          : 'Nếu số điện thoại đã đăng ký, mã OTP đã được gửi.';
      ref.read(toastProvider.notifier).info(msg);

      if (mounted) {
        setState(() {
          _devOtpHint = (res is Map && res['devOtp'] != null) ? res['devOtp'].toString() : '';
          _otpStep = 'verify';
        });
        _startCountdown(60);
      }
    } catch (err) {
      ref.read(toastProvider.notifier).error(extractErrorMessage(err));
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _handleVerifyOtp() async {
    final otp = _otpController.text.trim();
    if (otp.isEmpty) {
      ref.read(toastProvider.notifier).warning('Vui lòng nhập mã OTP gồm 6 chữ số.');
      return;
    }

    setState(() => _loading = true);
    try {
      final clean = normalizePhone(_phoneController.text);
      final authService = ref.read(authServiceProvider);
      final res = await authService.verifyOtp(clean, otp);
      await _handleLoginSuccess(res);
    } catch (err) {
      ref.read(toastProvider.notifier).error(
            extractErrorMessage(
              err,
              'Mã OTP không chính xác hoặc số điện thoại chưa được đăng ký.',
            ),
          );
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final screenWidth = MediaQuery.of(context).size.width;
    final isDesktop = screenWidth >= 1024;

    return Scaffold(
      backgroundColor: AppColors.slate50,
      body: Stack(
        children: [
          // Invisible tag for router testing compatibility
          const SizedBox(
            width: 0,
            height: 0,
            child: Text('Route: /login', style: TextStyle(fontSize: 0)),
          ),
          Row(
            children: [
              // Left Showcase Panel (Desktop)
              if (isDesktop)
                Expanded(
                  flex: 6,
                  child: Container(
                    decoration: const BoxDecoration(
                      gradient: LinearGradient(
                        begin: Alignment.topLeft,
                        end: Alignment.bottomRight,
                        colors: [
                          Color(0xFF0F172A),
                          Color(0xFF082F49),
                          Color(0xFF1E1B4B),
                        ],
                      ),
                    ),
                    child: SingleChildScrollView(
                      padding: const EdgeInsets.all(40.0),
                      child: ConstrainedBox(
                        constraints: BoxConstraints(
                          minHeight: MediaQuery.of(context).size.height - 80,
                        ),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          mainAxisAlignment: MainAxisAlignment.spaceBetween,
                          children: [
                            // Showcase Header
                            Row(
                              mainAxisAlignment: MainAxisAlignment.spaceBetween,
                              children: [
                                Flexible(
                                  child: InkWell(
                                    onTap: () => context.go('/explore'),
                                    child: Row(
                                      mainAxisSize: MainAxisSize.min,
                                      children: [
                                        Container(
                                          width: 44,
                                          height: 44,
                                          decoration: BoxDecoration(
                                            gradient: const LinearGradient(
                                              colors: [AppColors.primary400, AppColors.secondary500],
                                            ),
                                            borderRadius: BorderRadius.circular(16),
                                          ),
                                          child: const Icon(LucideIcons.home, color: Colors.white, size: 24),
                                        ),
                                        const SizedBox(width: 12),
                                        Flexible(
                                          child: Column(
                                            crossAxisAlignment: CrossAxisAlignment.start,
                                            mainAxisSize: MainAxisSize.min,
                                            children: const [
                                              Text(
                                                'ResiHub',
                                                style: TextStyle(
                                                  color: Colors.white,
                                                  fontSize: 20,
                                                  fontWeight: FontWeight.bold,
                                                ),
                                              ),
                                              Text(
                                                'Nền tảng Quản lý Căn hộ & Nhà cho thuê v2.0',
                                                style: TextStyle(
                                                  color: AppColors.primary300,
                                                  fontSize: 12,
                                                ),
                                                overflow: TextOverflow.ellipsis,
                                              ),
                                            ],
                                          ),
                                        ),
                                      ],
                                    ),
                                  ),
                                ),
                                const SizedBox(width: 12),
                                OutlinedButton.icon(
                                  onPressed: () => context.go('/explore'),
                                  icon: const Icon(LucideIcons.compass, size: 16, color: AppColors.primary300),
                                  label: const Text('Xem căn hộ trống', style: TextStyle(color: Colors.white, fontSize: 12)),
                                  style: OutlinedButton.styleFrom(
                                    side: BorderSide(color: Colors.white.withValues(alpha: 0.15)),
                                    backgroundColor: Colors.white.withValues(alpha: 0.1),
                                    shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                                  ),
                                ),
                              ],
                            ),

                            const SizedBox(height: 32),

                            // Showcase Center Body
                            ConstrainedBox(
                              constraints: const BoxConstraints(maxWidth: 540),
                              child: Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  Container(
                                    padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
                                    decoration: BoxDecoration(
                                      color: Colors.white.withValues(alpha: 0.1),
                                      border: Border.all(color: Colors.white.withValues(alpha: 0.15)),
                                      borderRadius: BorderRadius.circular(999),
                                    ),
                                    child: const Row(
                                      mainAxisSize: MainAxisSize.min,
                                      children: [
                                        Icon(LucideIcons.sparkles, size: 14, color: AppColors.primary400),
                                        SizedBox(width: 6),
                                        Text(
                                          'Chuẩn hóa toàn diện theo đặc tả PRD v2.0',
                                          style: TextStyle(
                                            color: AppColors.primary200,
                                            fontSize: 12,
                                            fontWeight: FontWeight.w500,
                                          ),
                                        ),
                                      ],
                                    ),
                                  ),
                                  const SizedBox(height: 24),
                                  const Text(
                                    'Vận hành chuỗi tòa nhà thông minh, minh bạch từ Hợp đồng đến Sổ cọc.',
                                    style: TextStyle(
                                      color: Colors.white,
                                      fontSize: 30,
                                      fontWeight: FontWeight.bold,
                                      height: 1.25,
                                    ),
                                  ),
                                  const SizedBox(height: 16),
                                  const Text(
                                    'Phân quyền đa tầng (RLS PostgreSQL) tách biệt tuyệt đối giữa Chủ đầu tư, Quản lý từng tòa và Cổng cư dân trực tuyến.',
                                    style: TextStyle(
                                      color: AppColors.slate300,
                                      fontSize: 14,
                                      height: 1.5,
                                    ),
                                  ),
                                  const SizedBox(height: 24),
                                  Row(
                                    children: [
                                      Expanded(
                                        child: Container(
                                          padding: const EdgeInsets.all(16),
                                          decoration: BoxDecoration(
                                            color: Colors.white.withValues(alpha: 0.05),
                                            border: Border.all(color: Colors.white.withValues(alpha: 0.1)),
                                            borderRadius: BorderRadius.circular(16),
                                          ),
                                          child: Column(
                                            crossAxisAlignment: CrossAxisAlignment.start,
                                            children: const [
                                              Icon(LucideIcons.building2, color: AppColors.primary400, size: 20),
                                              SizedBox(height: 8),
                                              Text(
                                                'Sơ đồ tầng trực quan',
                                                style: TextStyle(color: Colors.white, fontSize: 13, fontWeight: FontWeight.w600),
                                              ),
                                              SizedBox(height: 4),
                                              Text(
                                                'Kiểm soát trạng thái phòng, giữ chỗ và bàn giao thời gian thực.',
                                                style: TextStyle(color: AppColors.slate400, fontSize: 11),
                                              ),
                                            ],
                                          ),
                                        ),
                                      ),
                                      const SizedBox(width: 16),
                                      Expanded(
                                        child: Container(
                                          padding: const EdgeInsets.all(16),
                                          decoration: BoxDecoration(
                                            color: Colors.white.withValues(alpha: 0.05),
                                            border: Border.all(color: Colors.white.withValues(alpha: 0.1)),
                                            borderRadius: BorderRadius.circular(16),
                                          ),
                                          child: Column(
                                            crossAxisAlignment: CrossAxisAlignment.start,
                                            children: const [
                                              Icon(LucideIcons.shieldCheck, color: AppColors.emerald500, size: 20),
                                              SizedBox(height: 8),
                                              Text(
                                                'Đối soát cọc Four-Eyes',
                                                style: TextStyle(color: Colors.white, fontSize: 13, fontWeight: FontWeight.w600),
                                              ),
                                              SizedBox(height: 4),
                                              Text(
                                                'Tách bạch tiền thuê & tiền cọc, phê duyệt hoàn cọc minh bạch.',
                                                style: TextStyle(color: AppColors.slate400, fontSize: 11),
                                              ),
                                            ],
                                          ),
                                        ),
                                      ),
                                    ],
                                  ),
                                ],
                              ),
                            ),

                            const SizedBox(height: 32),

                            // Showcase Footer
                            const Text(
                              '© 2026 ResiHub Property Management System.',
                              style: TextStyle(color: AppColors.slate400, fontSize: 12),
                            ),
                          ],
                        ),
                      ),
                    ),
                  ),
                ),

              // Right Form Panel
              Expanded(
                flex: isDesktop ? 5 : 12,
                child: Center(
                  child: SingleChildScrollView(
                    padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 32),
                    child: ConstrainedBox(
                      constraints: const BoxConstraints(maxWidth: 440),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        children: [
                          // Mobile top header
                          if (!isDesktop) ...[
                            Row(
                              mainAxisAlignment: MainAxisAlignment.spaceBetween,
                              children: [
                                InkWell(
                                  onTap: () => context.go('/explore'),
                                  child: Row(
                                    mainAxisSize: MainAxisSize.min,
                                    children: [
                                      Container(
                                        width: 36,
                                        height: 36,
                                        decoration: BoxDecoration(
                                          color: AppColors.primary500,
                                          borderRadius: BorderRadius.circular(12),
                                        ),
                                        child: const Icon(LucideIcons.home, color: Colors.white, size: 20),
                                      ),
                                      const SizedBox(width: 10),
                                      const Text(
                                        'ResiHub',
                                        style: TextStyle(
                                          fontSize: 18,
                                          fontWeight: FontWeight.bold,
                                          color: AppColors.slate900,
                                        ),
                                      ),
                                    ],
                                  ),
                                ),
                                const SizedBox(width: 8),
                                Flexible(
                                  child: InkWell(
                                    onTap: () => context.go('/explore'),
                                    child: Row(
                                      mainAxisSize: MainAxisSize.min,
                                      children: const [
                                        Icon(LucideIcons.compass, size: 14, color: AppColors.primary600),
                                        SizedBox(width: 4),
                                        Flexible(
                                          child: Text(
                                            'Khám phá căn hộ trống & Đặt giữ chỗ online',
                                            style: TextStyle(
                                              color: AppColors.primary600,
                                              fontSize: 12,
                                              fontWeight: FontWeight.w500,
                                            ),
                                            overflow: TextOverflow.ellipsis,
                                          ),
                                        ),
                                      ],
                                    ),
                                  ),
                                ),
                              ],
                            ),
                            const SizedBox(height: 24),
                          ] else ...[
                            Align(
                              alignment: Alignment.centerRight,
                              child: InkWell(
                                onTap: () => context.go('/explore'),
                                child: Row(
                                  mainAxisSize: MainAxisSize.min,
                                  children: const [
                                    Icon(LucideIcons.compass, size: 14, color: AppColors.primary600),
                                    SizedBox(width: 6),
                                    Flexible(
                                      child: Text(
                                        'Khám phá căn hộ trống & Đặt giữ chỗ online',
                                        style: TextStyle(
                                          color: AppColors.primary600,
                                          fontSize: 12,
                                          fontWeight: FontWeight.w500,
                                        ),
                                        overflow: TextOverflow.ellipsis,
                                      ),
                                    ),
                                  ],
                                ),
                              ),
                            ),
                            const SizedBox(height: 16),
                          ],

                          // Title and Subtitle
                          const Text(
                            'Đăng nhập hệ thống',
                            style: TextStyle(
                              fontSize: 24,
                              fontWeight: FontWeight.bold,
                              color: AppColors.slate900,
                            ),
                          ),
                          const SizedBox(height: 6),
                          const Text(
                            'Chọn phương thức đăng nhập phù hợp với vai trò của bạn.',
                            style: TextStyle(
                              fontSize: 14,
                              color: AppColors.slate500,
                            ),
                          ),
                          const SizedBox(height: 20),

                          // Mode Switcher
                          Container(
                            padding: const EdgeInsets.all(4),
                            decoration: BoxDecoration(
                              color: AppColors.slate200.withValues(alpha: 0.7),
                              borderRadius: BorderRadius.circular(12),
                            ),
                            child: Row(
                              children: [
                                Expanded(
                                  child: GestureDetector(
                                    onTap: () => setState(() => _mode = 'email'),
                                    child: Container(
                                      padding: const EdgeInsets.symmetric(vertical: 8),
                                      decoration: BoxDecoration(
                                        color: _mode == 'email' ? Colors.white : Colors.transparent,
                                        borderRadius: BorderRadius.circular(8),
                                        boxShadow: _mode == 'email'
                                            ? [
                                                BoxShadow(
                                                  color: Colors.black.withValues(alpha: 0.05),
                                                  blurRadius: 4,
                                                  offset: const Offset(0, 1),
                                                ),
                                              ]
                                            : null,
                                      ),
                                      child: Center(
                                        child: Text(
                                          'Email & Mật khẩu',
                                          style: TextStyle(
                                            fontSize: 12,
                                            fontWeight: FontWeight.w600,
                                            color: _mode == 'email' ? AppColors.slate900 : AppColors.slate600,
                                          ),
                                        ),
                                      ),
                                    ),
                                  ),
                                ),
                                Expanded(
                                  child: GestureDetector(
                                    onTap: () => setState(() => _mode = 'otp'),
                                    child: Container(
                                      padding: const EdgeInsets.symmetric(vertical: 8),
                                      decoration: BoxDecoration(
                                        color: _mode == 'otp' ? Colors.white : Colors.transparent,
                                        borderRadius: BorderRadius.circular(8),
                                        boxShadow: _mode == 'otp'
                                            ? [
                                                BoxShadow(
                                                  color: Colors.black.withValues(alpha: 0.05),
                                                  blurRadius: 4,
                                                  offset: const Offset(0, 1),
                                                ),
                                              ]
                                            : null,
                                      ),
                                      child: Center(
                                        child: Text(
                                          'Số điện thoại (OTP)',
                                          style: TextStyle(
                                            fontSize: 12,
                                            fontWeight: FontWeight.w600,
                                            color: _mode == 'otp' ? AppColors.slate900 : AppColors.slate600,
                                          ),
                                        ),
                                      ),
                                    ),
                                  ),
                                ),
                              ],
                            ),
                          ),
                          const SizedBox(height: 16),

                          // Form Box
                          Container(
                            padding: const EdgeInsets.all(24),
                            decoration: BoxDecoration(
                              color: Colors.white,
                              borderRadius: BorderRadius.circular(16),
                              border: Border.all(color: AppColors.slate200),
                              boxShadow: [
                                BoxShadow(
                                  color: Colors.black.withValues(alpha: 0.03),
                                  blurRadius: 10,
                                  offset: const Offset(0, 4),
                                ),
                              ],
                            ),
                            child: _mode == 'email' ? _buildEmailForm() : _buildOtpForm(),
                          ),
                          const SizedBox(height: 16),

                          // Quick Demo Accounts Box
                          if (_showDemoAccounts) _buildDemoAccountsBox(),
                        ],
                      ),
                    ),
                  ),
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }

  Widget _buildEmailForm() {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        AppInput(
          label: 'Địa chỉ Email',
          placeholder: 'ten@resihub.vn',
          icon: const Icon(LucideIcons.mail, size: 18),
          required: true,
          controller: _emailController,
          keyboardType: TextInputType.emailAddress,
        ),
        const SizedBox(height: 16),
        AppInput(
          label: 'Mật khẩu',
          placeholder: 'Nhập mật khẩu (tối thiểu 8 ký tự)',
          icon: const Icon(LucideIcons.lock, size: 18),
          required: true,
          obscureText: !_showPassword,
          controller: _passwordController,
          rightElement: IconButton(
            icon: Icon(
              _showPassword ? LucideIcons.eyeOff : LucideIcons.eye,
              size: 18,
              color: AppColors.slate400,
            ),
            onPressed: () => setState(() => _showPassword = !_showPassword),
          ),
        ),
        const SizedBox(height: 12),
        Align(
          alignment: Alignment.centerRight,
          child: TextButton(
            onPressed: () => context.go('/forgot-password'),
            style: TextButton.styleFrom(
              padding: EdgeInsets.zero,
              minimumSize: Size.zero,
              tapTargetSize: MaterialTapTargetSize.shrinkWrap,
            ),
            child: const Text(
              'Quên mật khẩu?',
              style: TextStyle(
                fontSize: 12,
                fontWeight: FontWeight.w500,
                color: AppColors.primary600,
              ),
            ),
          ),
        ),
        const SizedBox(height: 16),
        AppButton(
          text: 'Đăng nhập',
          rightIcon: const Icon(LucideIcons.arrowRight, size: 18),
          loading: _loading,
          fullWidth: true,
          size: AppButtonSize.lg,
          onPressed: _handleEmailSubmit,
        ),
      ],
    );
  }

  Widget _buildOtpForm() {
    if (_otpStep == 'request') {
      return Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          AppInput(
            label: 'Số điện thoại đã đăng ký / đặt giữ chỗ',
            placeholder: '0912345678',
            hint: 'Số điện thoại cư dân hoặc khách vừa đặt giữ chỗ trực tuyến có thể nhận OTP đăng nhập theo dõi hồ sơ.',
            icon: const Icon(LucideIcons.phone, size: 18),
            required: true,
            controller: _phoneController,
            keyboardType: TextInputType.phone,
          ),
          const SizedBox(height: 16),
          AppButton(
            text: 'Nhận mã xác thực OTP',
            loading: _loading,
            fullWidth: true,
            size: AppButtonSize.lg,
            onPressed: _handleRequestOtp,
          ),
        ],
      );
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Container(
          padding: const EdgeInsets.all(12),
          decoration: BoxDecoration(
            color: AppColors.primary50,
            borderRadius: BorderRadius.circular(12),
            border: Border.all(color: AppColors.primary100),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                'Nếu SĐT ${normalizePhone(_phoneController.text)} tồn tại trong hệ thống, mã OTP đã được gửi.',
                style: const TextStyle(fontSize: 12, color: AppColors.primary800),
              ),
              if (_devOtpHint.isNotEmpty) ...[
                const SizedBox(height: 4),
                Text(
                  '[Dev Mode] Mã OTP của bạn: $_devOtpHint',
                  style: const TextStyle(
                    fontSize: 12,
                    fontWeight: FontWeight.w600,
                    color: AppColors.primary700,
                  ),
                ),
              ],
            ],
          ),
        ),
        const SizedBox(height: 16),
        AppInput(
          label: 'Mã OTP (6 chữ số)',
          placeholder: 'Nhập 6 chữ số OTP',
          icon: const Icon(LucideIcons.keyRound, size: 18),
          required: true,
          controller: _otpController,
          keyboardType: TextInputType.number,
          inputFormatters: [
            FilteringTextInputFormatter.digitsOnly,
            LengthLimitingTextInputFormatter(6),
          ],
        ),
        const SizedBox(height: 16),
        AppButton(
          text: 'Xác thực & Đăng nhập',
          loading: _loading,
          fullWidth: true,
          size: AppButtonSize.lg,
          onPressed: _handleVerifyOtp,
        ),
        const SizedBox(height: 12),
        Row(
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: [
            TextButton(
              onPressed: () {
                setState(() {
                  _otpStep = 'request';
                  _otpController.clear();
                  _devOtpHint = '';
                });
              },
              style: TextButton.styleFrom(
                padding: EdgeInsets.zero,
                minimumSize: Size.zero,
                tapTargetSize: MaterialTapTargetSize.shrinkWrap,
              ),
              child: const Text(
                'Đổi số điện thoại',
                style: TextStyle(fontSize: 12, color: AppColors.slate500),
              ),
            ),
            TextButton(
              onPressed: (_countdown > 0 || _loading) ? null : _handleRequestOtp,
              style: TextButton.styleFrom(
                padding: EdgeInsets.zero,
                minimumSize: Size.zero,
                tapTargetSize: MaterialTapTargetSize.shrinkWrap,
              ),
              child: Text(
                _countdown > 0 ? 'Gửi lại sau ${_countdown}s' : 'Gửi lại mã OTP',
                style: TextStyle(
                  fontSize: 12,
                  fontWeight: FontWeight.w500,
                  color: _countdown > 0 ? AppColors.slate400 : AppColors.primary600,
                ),
              ),
            ),
          ],
        ),
      ],
    );
  }

  Widget _buildDemoAccountsBox() {
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: Colors.white.withValues(alpha: 0.7),
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: AppColors.slate200),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Text(
            'Tài khoản Demo kiểm thử nhanh',
            style: TextStyle(
              fontSize: 11,
              fontWeight: FontWeight.w600,
              color: AppColors.slate400,
              letterSpacing: 0.5,
            ),
          ),
          const SizedBox(height: 10),
          LayoutBuilder(
            builder: (context, constraints) {
              final itemWidth = (constraints.maxWidth - 8) / 2 > 120
                  ? (constraints.maxWidth - 8) / 2
                  : constraints.maxWidth;
              return Wrap(
                spacing: 8,
                runSpacing: 8,
                children: _kDemoAccounts.map((acc) {
                  return SizedBox(
                    width: itemWidth,
                    child: InkWell(
                      onTap: () {
                        setState(() {
                          _mode = 'email';
                          _emailController.text = acc.email;
                          _passwordController.text = acc.pass;
                        });
                      },
                      borderRadius: BorderRadius.circular(12),
                      child: Container(
                        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
                        decoration: BoxDecoration(
                          color: Colors.white,
                          borderRadius: BorderRadius.circular(12),
                          border: Border.all(color: AppColors.slate200),
                        ),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              acc.label,
                              style: const TextStyle(
                                fontSize: 11,
                                fontWeight: FontWeight.w600,
                                color: AppColors.slate800,
                              ),
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                            ),
                            const SizedBox(height: 2),
                            Text(
                              acc.email,
                              style: const TextStyle(
                                fontSize: 10,
                                color: AppColors.slate500,
                              ),
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                            ),
                          ],
                        ),
                      ),
                    ),
                  );
                }).toList(),
              );
            },
          ),
        ],
      ),
    );
  }
}
