import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/theme/app_colors.dart';
import '../../../core/utils/validation.dart';
import '../../../features/auth/providers/auth_provider.dart';
import '../../../features/auth/services/auth_service.dart';
import '../ui/app_button.dart';
import '../ui/app_input.dart';
import '../ui/app_modal.dart';
import '../ui/app_tabs.dart';

/// Modal for viewing and updating personal profile info and changing password.
/// Port of `frontend/src/components/common/ProfileModal.jsx`.
class ProfileModal extends ConsumerStatefulWidget {
  final bool open;
  final VoidCallback? onClose;

  const ProfileModal({
    super.key,
    this.open = true,
    this.onClose,
  });

  /// Static helper to display the profile modal cleanly via [showDialog] root overlay.
  static Future<void> show({
    required BuildContext context,
  }) {
    return showDialog<void>(
      context: context,
      builder: (ctx) => ProfileModal(
        onClose: () => Navigator.of(ctx).pop(),
      ),
    );
  }

  @override
  ConsumerState<ProfileModal> createState() => _ProfileModalState();
}

class _ProfileModalState extends ConsumerState<ProfileModal> {
  String _activeTab = 'info';
  bool _saving = false;

  final TextEditingController _fullNameController = TextEditingController();
  final TextEditingController _phoneController = TextEditingController();
  final TextEditingController _emailController = TextEditingController();
  final TextEditingController _dobController = TextEditingController();
  final TextEditingController _idNumberController = TextEditingController();

  final TextEditingController _currentPwdController = TextEditingController();
  final TextEditingController _newPwdController = TextEditingController();
  final TextEditingController _confirmPwdController = TextEditingController();

  @override
  void initState() {
    super.initState();
    _loadProfile();
  }

  @override
  void dispose() {
    _fullNameController.dispose();
    _phoneController.dispose();
    _emailController.dispose();
    _dobController.dispose();
    _idNumberController.dispose();
    _currentPwdController.dispose();
    _newPwdController.dispose();
    _confirmPwdController.dispose();
    super.dispose();
  }

  void _loadProfile() {
    final user = ref.read(authProvider).user;
    if (user != null) {
      _fullNameController.text = user.fullName;
      _phoneController.text = user.phone ?? '';
      _emailController.text = user.email ?? '';
    }

    final authService = ref.read(authServiceProvider);
    authService.getProfile().then((res) {
      if (!mounted) return;
      final Map<String, dynamic> p;
      if (res is Map && res['profile'] is Map) {
        p = Map<String, dynamic>.from(res['profile'] as Map);
      } else if (res is Map && res['data'] is Map) {
        p = Map<String, dynamic>.from(res['data'] as Map);
      } else if (res is Map) {
        p = Map<String, dynamic>.from(res);
      } else {
        return;
      }

      setState(() {
        if (p['full_name'] != null) _fullNameController.text = p['full_name'].toString();
        if (p['phone'] != null) _phoneController.text = p['phone'].toString();
        if (p['email'] != null) _emailController.text = p['email'].toString();
        if (p['dob'] != null) {
          final s = p['dob'].toString();
          _dobController.text = s.length >= 10 ? s.substring(0, 10) : s;
        }
        if (p['id_number'] != null) _idNumberController.text = p['id_number'].toString();
      });
    }).catchError((_) {
      // Keep initial user values
    });
  }

  Future<void> _handleSaveInfo() async {
    setState(() => _saving = true);
    try {
      final authService = ref.read(authServiceProvider);
      final payload = {
        'full_name': _fullNameController.text.trim(),
        'phone': _phoneController.text.trim(),
        'email': _emailController.text.trim(),
        'dob': _dobController.text.trim(),
      };
      final res = await authService.updateProfile(payload);

      await ref.read(authProvider.notifier).updateUser({
        'full_name': _fullNameController.text.trim(),
        'phone': _phoneController.text.trim(),
        'email': _emailController.text.trim(),
      });

      if (mounted) {
        final msg = res is Map ? res['message']?.toString() : 'Đã cập nhật hồ sơ cá nhân.';
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(msg ?? 'Đã cập nhật hồ sơ cá nhân.')),
        );
        widget.onClose?.call();
      }
    } catch (err) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(extractErrorMessage(err)),
            backgroundColor: AppColors.rose600,
          ),
        );
      }
    } finally {
      if (mounted) {
        setState(() => _saving = false);
      }
    }
  }

  Future<void> _handleChangePassword() async {
    final newPwd = _newPwdController.text;
    final confirmPwd = _confirmPwdController.text;

    if (newPwd.length < 8) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text('Mật khẩu mới phải từ 8 ký tự trở lên.'),
          backgroundColor: AppColors.amber600,
        ),
      );
      return;
    }
    if (newPwd != confirmPwd) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text('Mật khẩu xác nhận không khớp.'),
          backgroundColor: AppColors.amber600,
        ),
      );
      return;
    }

    setState(() => _saving = true);
    try {
      final authService = ref.read(authServiceProvider);
      final res = await authService.changePassword(_currentPwdController.text, newPwd);

      if (mounted) {
        final msg = res is Map ? res['message']?.toString() : 'Đổi mật khẩu thành công.';
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(msg ?? 'Đổi mật khẩu thành công.')),
        );
        _currentPwdController.clear();
        _newPwdController.clear();
        _confirmPwdController.clear();
        widget.onClose?.call();
      }
    } catch (err) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(extractErrorMessage(err)),
            backgroundColor: AppColors.rose600,
          ),
        );
      }
    } finally {
      if (mounted) {
        setState(() => _saving = false);
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    if (!widget.open) return const SizedBox.shrink();

    return AppModal(
      title: 'Tài khoản cá nhân',
      subtitle: 'Quản lý thông tin liên hệ và bảo mật',
      size: AppModalSize.md,
      onClose: widget.onClose,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          AppTabs(
            tabs: const [
              AppTabItem(id: 'info', label: 'Thông tin chung'),
              AppTabItem(id: 'password', label: 'Đổi mật khẩu'),
            ],
            activeTab: _activeTab,
            onChanged: (tab) => setState(() => _activeTab = tab),
          ),
          const SizedBox(height: 16),
          if (_activeTab == 'info') ...[
            AppInput(
              controller: _fullNameController,
              label: 'Họ và tên',
              required: true,
              placeholder: 'Nguyễn Văn A',
            ),
            const SizedBox(height: 12),
            Row(
              children: [
                Expanded(
                  child: AppInput(
                    controller: _phoneController,
                    label: 'Số điện thoại',
                    placeholder: '0901234567',
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: AppInput(
                    controller: _emailController,
                    label: 'Email',
                    placeholder: 'name@example.com',
                  ),
                ),
              ],
            ),
            const SizedBox(height: 12),
            Row(
              children: [
                Expanded(
                  child: AppInput(
                    controller: _dobController,
                    label: 'Ngày sinh',
                    placeholder: 'YYYY-MM-DD',
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: AppInput(
                    controller: _idNumberController,
                    label: 'Số CCCD / Hộ chiếu',
                    readOnly: true,
                    placeholder: '—',
                  ),
                ),
              ],
            ),
            const SizedBox(height: 20),
            Row(
              mainAxisAlignment: MainAxisAlignment.end,
              children: [
                AppButton(
                  text: 'Đóng',
                  variant: AppButtonVariant.outline,
                  onPressed: widget.onClose,
                ),
                const SizedBox(width: 8),
                AppButton(
                  text: 'Lưu thay đổi',
                  loading: _saving,
                  onPressed: _handleSaveInfo,
                ),
              ],
            ),
          ] else ...[
            AppInput(
              controller: _currentPwdController,
              label: 'Mật khẩu hiện tại',
              obscureText: true,
              required: true,
            ),
            const SizedBox(height: 12),
            AppInput(
              controller: _newPwdController,
              label: 'Mật khẩu mới (tối thiểu 8 ký tự)',
              obscureText: true,
              required: true,
            ),
            const SizedBox(height: 12),
            AppInput(
              controller: _confirmPwdController,
              label: 'Xác nhận mật khẩu mới',
              obscureText: true,
              required: true,
            ),
            const SizedBox(height: 20),
            Row(
              mainAxisAlignment: MainAxisAlignment.end,
              children: [
                AppButton(
                  text: 'Đóng',
                  variant: AppButtonVariant.outline,
                  onPressed: widget.onClose,
                ),
                const SizedBox(width: 8),
                AppButton(
                  text: 'Cập nhật mật khẩu',
                  loading: _saving,
                  onPressed: _handleChangePassword,
                ),
              ],
            ),
          ],
        ],
      ),
    );
  }
}
