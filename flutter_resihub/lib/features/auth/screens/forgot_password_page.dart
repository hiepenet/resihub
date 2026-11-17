import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../../../core/theme/app_colors.dart';
import '../../../core/utils/validation.dart';
import '../../../shared/providers/toast_provider.dart';
import '../../../shared/widgets/ui/app_button.dart';
import '../../../shared/widgets/ui/app_input.dart';
import '../services/auth_service.dart';

/// 2-Step Forgot Password Page matching `frontend/src/pages/auth/ForgotPasswordPage.jsx`.
///
/// Features:
/// - Step 1: Input email -> request recovery OTP.
/// - Step 2: Input OTP + new password (>= 8 chars) -> reset password.
/// - 60s countdown timer for resending recovery code, cancelled cleanly in dispose.
/// - Returns to `/login` upon success.
class ForgotPasswordPage extends ConsumerStatefulWidget {
  const ForgotPasswordPage({super.key});

  @override
  ConsumerState<ForgotPasswordPage> createState() => _ForgotPasswordPageState();
}

class _ForgotPasswordPageState extends ConsumerState<ForgotPasswordPage> {
  int _step = 1;
  final TextEditingController _emailController = TextEditingController();
  final TextEditingController _codeController = TextEditingController();
  final TextEditingController _newPasswordController = TextEditingController();
  bool _showPassword = false;
  String _devCode = '';
  bool _loading = false;

  int _countdown = 0;
  Timer? _countdownTimer;

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
    _codeController.dispose();
    _newPasswordController.dispose();
    super.dispose();
  }

  Future<void> _handleRequestCode() async {
    final email = _emailController.text.trim();
    if (email.isEmpty) {
      ref.read(toastProvider.notifier).warning('Vui lòng nhập địa chỉ email.');
      return;
    }

    setState(() => _loading = true);
    try {
      final authService = ref.read(authServiceProvider);
      final dynamic res = await authService.forgotPassword(email);

      final msg = (res is Map && res['message'] != null)
          ? res['message'].toString()
          : 'Nếu email hợp lệ, mã khôi phục đã được gửi.';
      ref.read(toastProvider.notifier).info(msg);

      if (mounted) {
        setState(() {
          if (res is Map && res['devResetCode'] != null) {
            _devCode = res['devResetCode'].toString();
          }
          _step = 2;
        });
        _startCountdown(60);
      }
    } catch (err) {
      ref.read(toastProvider.notifier).error(extractErrorMessage(err));
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _handleReset() async {
    final email = _emailController.text.trim();
    final code = _codeController.text.trim();
    final newPassword = _newPasswordController.text;

    if (code.isEmpty) {
      ref.read(toastProvider.notifier).warning('Vui lòng nhập mã xác nhận.');
      return;
    }

    if (newPassword.length < 8) {
      ref.read(toastProvider.notifier).warning('Mật khẩu mới phải từ 8 ký tự trở lên.');
      return;
    }

    setState(() => _loading = true);
    try {
      final authService = ref.read(authServiceProvider);
      final dynamic res = await authService.resetPassword(
        email: email,
        code: code,
        newPassword: newPassword,
      );

      final msg = (res is Map && res['message'] != null)
          ? res['message'].toString()
          : 'Đặt lại mật khẩu thành công. Vui lòng đăng nhập.';
      ref.read(toastProvider.notifier).success(msg);

      if (!mounted) return;
      context.go('/login');
    } catch (err) {
      ref.read(toastProvider.notifier).error(extractErrorMessage(err));
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppColors.slate50,
      body: Stack(
        children: [
          // Invisible tag for router testing compatibility
          const SizedBox(
            width: 0,
            height: 0,
            child: Text('Route: /forgot-password', style: TextStyle(fontSize: 0)),
          ),
          Center(
            child: SingleChildScrollView(
              padding: const EdgeInsets.all(24),
              child: ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 440),
                child: Container(
                  padding: const EdgeInsets.all(32),
                  decoration: BoxDecoration(
                    color: Colors.white,
                    borderRadius: BorderRadius.circular(16),
                    border: Border.all(color: AppColors.slate200),
                    boxShadow: [
                      BoxShadow(
                        color: Colors.black.withValues(alpha: 0.04),
                        blurRadius: 16,
                        offset: const Offset(0, 4),
                      ),
                    ],
                  ),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      // Header Brand
                      Row(
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
                      const SizedBox(height: 20),

                      // Title & Subtitle
                      const Text(
                        'Khôi phục mật khẩu',
                        style: TextStyle(
                          fontSize: 20,
                          fontWeight: FontWeight.bold,
                          color: AppColors.slate900,
                        ),
                      ),
                      const SizedBox(height: 6),
                      Text(
                        _step == 1
                            ? 'Nhập địa chỉ email tài khoản để nhận mã xác nhận khôi phục.'
                            : 'Nhập mã xác nhận gồm 6 chữ số và mật khẩu mới.',
                        style: const TextStyle(
                          fontSize: 12,
                          color: AppColors.slate500,
                        ),
                      ),
                      const SizedBox(height: 20),

                      // Step Content
                      if (_step == 1) _buildStep1Form() else _buildStep2Form(),

                      const SizedBox(height: 20),
                      const Divider(height: 1, color: AppColors.slate100),
                      const SizedBox(height: 16),

                      // Back to login
                      InkWell(
                        onTap: () => context.go('/login'),
                        child: Row(
                          mainAxisSize: MainAxisSize.min,
                          children: const [
                            Icon(LucideIcons.arrowLeft, size: 14, color: AppColors.slate500),
                            SizedBox(width: 6),
                            Text(
                              'Quay lại trang Đăng nhập',
                              style: TextStyle(
                                fontSize: 12,
                                fontWeight: FontWeight.w500,
                                color: AppColors.slate500,
                              ),
                            ),
                          ],
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildStep1Form() {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        AppInput(
          label: 'Email tài khoản',
          placeholder: 'ten@resihub.vn',
          icon: const Icon(LucideIcons.mail, size: 18),
          required: true,
          controller: _emailController,
          keyboardType: TextInputType.emailAddress,
        ),
        const SizedBox(height: 20),
        AppButton(
          text: 'Gửi mã xác nhận',
          loading: _loading,
          fullWidth: true,
          size: AppButtonSize.lg,
          onPressed: _handleRequestCode,
        ),
      ],
    );
  }

  Widget _buildStep2Form() {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (_devCode.isNotEmpty) ...[
          Container(
            padding: const EdgeInsets.all(12),
            decoration: BoxDecoration(
              color: AppColors.primary50,
              borderRadius: BorderRadius.circular(12),
              border: Border.all(color: AppColors.primary100),
            ),
            child: Text.rich(
              TextSpan(
                text: '[Dev Mode] Mã khôi phục của bạn: ',
                style: const TextStyle(fontSize: 12, color: AppColors.primary800),
                children: [
                  TextSpan(
                    text: _devCode,
                    style: const TextStyle(fontWeight: FontWeight.bold),
                  ),
                ],
              ),
            ),
          ),
          const SizedBox(height: 16),
        ],
        AppInput(
          label: 'Mã xác nhận',
          placeholder: 'Nhập mã 6 chữ số',
          icon: const Icon(LucideIcons.keyRound, size: 18),
          required: true,
          controller: _codeController,
          keyboardType: TextInputType.number,
          inputFormatters: [
            FilteringTextInputFormatter.digitsOnly,
            LengthLimitingTextInputFormatter(6),
          ],
        ),
        const SizedBox(height: 16),
        AppInput(
          label: 'Mật khẩu mới (tối thiểu 8 ký tự)',
          placeholder: 'Nhập mật khẩu mới',
          icon: const Icon(LucideIcons.lock, size: 18),
          required: true,
          obscureText: !_showPassword,
          controller: _newPasswordController,
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
            onPressed: (_countdown > 0 || _loading) ? null : _handleRequestCode,
            style: TextButton.styleFrom(
              padding: EdgeInsets.zero,
              minimumSize: Size.zero,
              tapTargetSize: MaterialTapTargetSize.shrinkWrap,
            ),
            child: Text(
              _countdown > 0 ? 'Gửi lại mã sau ${_countdown}s' : 'Gửi lại mã xác nhận',
              style: TextStyle(
                fontSize: 12,
                fontWeight: FontWeight.w500,
                color: _countdown > 0 ? AppColors.slate400 : AppColors.primary600,
              ),
            ),
          ),
        ),
        const SizedBox(height: 16),
        AppButton(
          text: 'Cập nhật mật khẩu mới',
          loading: _loading,
          fullWidth: true,
          size: AppButtonSize.lg,
          onPressed: _handleReset,
        ),
      ],
    );
  }
}
