import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/utils/validation.dart';
import '../../../shared/providers/toast_provider.dart';
import '../../../shared/widgets/ui/app_button.dart';
import '../../../shared/widgets/ui/app_card.dart';
import '../../../shared/widgets/ui/app_input.dart';
import '../../../shared/widgets/ui/file_upload_field.dart';
import '../../auth/providers/auth_provider.dart';
import '../../auth/services/auth_service.dart';
import '../services/resident_service.dart';

class ProfileTab extends ConsumerStatefulWidget {
  final Map<String, dynamic>? overview;
  final Future<void> Function() onRefreshOverview;
  final void Function(String tab, [Map<String, dynamic>? extra]) onNavigateTab;

  const ProfileTab({
    super.key,
    required this.overview,
    required this.onRefreshOverview,
    required this.onNavigateTab,
  });

  @override
  ConsumerState<ProfileTab> createState() => _ProfileTabState();
}

class _ProfileTabState extends ConsumerState<ProfileTab> {
  final _nameCtrl = TextEditingController();
  final _phoneCtrl = TextEditingController();
  final _emailCtrl = TextEditingController();
  final _idNumberCtrl = TextEditingController();
  final _addressCtrl = TextEditingController();

  final _currentPwdCtrl = TextEditingController();
  final _newPwdCtrl = TextEditingController();
  final _confirmPwdCtrl = TextEditingController();

  bool _savingProfile = false;
  bool _savingPwd = false;
  bool _uploadingId = false;

  String? _frontIdUrl;
  String? _backIdUrl;

  @override
  void initState() {
    super.initState();
    _initUserData();
  }

  @override
  void didUpdateWidget(covariant ProfileTab oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.overview != widget.overview) {
      _initUserData();
    }
  }

  void _initUserData() {
    final user = widget.overview?['user'] is Map
        ? widget.overview!['user'] as Map
        : (ref.read(authProvider).user != null
            ? {
                'full_name': ref.read(authProvider).user!.fullName,
                'email': ref.read(authProvider).user!.email,
                'phone': ref.read(authProvider).user!.phone,
              }
            : const {});

    _nameCtrl.text = user['full_name']?.toString() ?? '';
    _phoneCtrl.text = user['phone']?.toString() ?? '';
    _emailCtrl.text = user['email']?.toString() ?? '';
    _idNumberCtrl.text = user['id_number']?.toString() ?? '';
    _addressCtrl.text = user['address']?.toString() ?? '';

    final idImages = widget.overview?['id_images'] is List
        ? widget.overview!['id_images'] as List
        : const [];
    for (final img in idImages) {
      if (img is Map) {
        if (img['side'] == 'front') _frontIdUrl = img['url']?.toString();
        if (img['side'] == 'back') _backIdUrl = img['url']?.toString();
      }
    }
  }

  Future<void> _handleSaveProfile() async {
    final name = _nameCtrl.text.trim();
    if (name.isEmpty) {
      ref.read(toastProvider.notifier).error('Vui lòng nhập họ và tên.');
      return;
    }

    setState(() => _savingProfile = true);
    try {
      await ref.read(residentServiceProvider).updateProfile({
        'full_name': name,
        'phone': _phoneCtrl.text.trim(),
        'email': _emailCtrl.text.trim(),
        'id_number': _idNumberCtrl.text.trim(),
        'address': _addressCtrl.text.trim(),
      });
      ref.read(toastProvider.notifier).success('Đã cập nhật thông tin cá nhân.');
      await widget.onRefreshOverview();
    } catch (err) {
      ref.read(toastProvider.notifier).error(extractErrorMessage(err, 'Không thể cập nhật hồ sơ.'));
    } finally {
      if (mounted) setState(() => _savingProfile = false);
    }
  }

  Future<void> _handleUploadIdImage(String side, dynamic fileData) async {
    if (fileData == null) return;
    setState(() => _uploadingId = true);
    try {
      await ref.read(residentServiceProvider).uploadIdImage({
        'side': side,
        'image_data': fileData.toString(),
      });
      ref.read(toastProvider.notifier).success('Đã tải ảnh CCCD mặt ${side == 'front' ? 'trước' : 'sau'} lên.');
      await widget.onRefreshOverview();
    } catch (err) {
      ref.read(toastProvider.notifier).error(extractErrorMessage(err, 'Không thể tải ảnh CCCD lên.'));
    } finally {
      if (mounted) setState(() => _uploadingId = false);
    }
  }

  Future<void> _handleChangePassword() async {
    final current = _currentPwdCtrl.text;
    final newPwd = _newPwdCtrl.text;
    final confirm = _confirmPwdCtrl.text;

    if (current.isEmpty || newPwd.isEmpty) {
      ref.read(toastProvider.notifier).error('Vui lòng nhập mật khẩu hiện tại và mật khẩu mới.');
      return;
    }
    if (newPwd.length < 6) {
      ref.read(toastProvider.notifier).error('Mật khẩu mới phải có ít nhất 6 ký tự.');
      return;
    }
    if (newPwd != confirm) {
      ref.read(toastProvider.notifier).error('Mật khẩu xác nhận không khớp.');
      return;
    }

    setState(() => _savingPwd = true);
    try {
      await ref.read(authServiceProvider).changePassword(current, newPwd);
      ref.read(toastProvider.notifier).success('Đổi mật khẩu thành công.');
      _currentPwdCtrl.clear();
      _newPwdCtrl.clear();
      _confirmPwdCtrl.clear();
    } catch (err) {
      ref.read(toastProvider.notifier).error(extractErrorMessage(err, 'Không thể đổi mật khẩu.'));
    } finally {
      if (mounted) setState(() => _savingPwd = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return RefreshIndicator(
      onRefresh: widget.onRefreshOverview,
      child: SingleChildScrollView(
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            // Personal Info
            AppCard(
              header: const AppCardHeader(title: 'Thông tin cá nhân'),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  AppInput(
                    label: 'Họ và tên *',
                    controller: _nameCtrl,
                  ),
                  const SizedBox(height: 12),
                  AppInput(
                    label: 'Số điện thoại',
                    controller: _phoneCtrl,
                    keyboardType: TextInputType.phone,
                  ),
                  const SizedBox(height: 12),
                  AppInput(
                    label: 'Email',
                    controller: _emailCtrl,
                    keyboardType: TextInputType.emailAddress,
                  ),
                  const SizedBox(height: 12),
                  AppInput(
                    label: 'Số CCCD/Hộ chiếu',
                    controller: _idNumberCtrl,
                    keyboardType: TextInputType.number,
                  ),
                  const SizedBox(height: 12),
                  AppInput(
                    label: 'Địa chỉ thường trú',
                    controller: _addressCtrl,
                  ),
                  const SizedBox(height: 16),
                  Row(
                    mainAxisAlignment: MainAxisAlignment.end,
                    children: [
                      AppButton(
                        text: _savingProfile ? 'Đang lưu...' : 'Lưu thông tin',
                        loading: _savingProfile,
                        onPressed: _savingProfile ? null : _handleSaveProfile,
                      ),
                    ],
                  ),
                ],
              ),
            ),
            const SizedBox(height: 16),

            // Identity Document Upload
            AppCard(
              header: const AppCardHeader(title: 'Giấy tờ định danh (CCCD / Hộ chiếu)'),
              child: Column(
                children: [
                  if (_uploadingId) const Padding(padding: EdgeInsets.only(bottom: 8), child: LinearProgressIndicator()),
                  FileUploadField(
                    label: 'Ảnh mặt trước CCCD',
                    value: _frontIdUrl,
                    onChanged: (val) => _handleUploadIdImage('front', val),
                  ),
                  const SizedBox(height: 12),
                  FileUploadField(
                    label: 'Ảnh mặt sau CCCD',
                    value: _backIdUrl,
                    onChanged: (val) => _handleUploadIdImage('back', val),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 16),

            // Change Password
            AppCard(
              header: const AppCardHeader(title: 'Đổi mật khẩu đăng nhập'),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  AppInput(
                    label: 'Mật khẩu hiện tại *',
                    controller: _currentPwdCtrl,
                    obscureText: true,
                  ),
                  const SizedBox(height: 12),
                  AppInput(
                    label: 'Mật khẩu mới *',
                    controller: _newPwdCtrl,
                    obscureText: true,
                  ),
                  const SizedBox(height: 12),
                  AppInput(
                    label: 'Xác nhận mật khẩu mới *',
                    controller: _confirmPwdCtrl,
                    obscureText: true,
                  ),
                  const SizedBox(height: 16),
                  Row(
                    mainAxisAlignment: MainAxisAlignment.end,
                    children: [
                      AppButton(
                        text: _savingPwd ? 'Đang cập nhật...' : 'Đổi mật khẩu',
                        loading: _savingPwd,
                        onPressed: _savingPwd ? null : _handleChangePassword,
                      ),
                    ],
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}
