import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/theme/app_colors.dart';
import '../../../core/utils/format.dart';
import '../../../core/utils/validation.dart';
import '../../../shared/providers/toast_provider.dart';
import '../../../shared/widgets/ui/app_button.dart';
import '../../../shared/widgets/ui/app_card.dart';
import '../../../shared/widgets/ui/app_input.dart';
import '../../../shared/widgets/ui/auth_media_viewer.dart';
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
  final _dobCtrl = TextEditingController();
  final _idNumberCtrl = TextEditingController();
  final _nationalityCtrl = TextEditingController();
  final _addressCtrl = TextEditingController();

  final _currentPwdCtrl = TextEditingController();
  final _newPwdCtrl = TextEditingController();
  final _confirmPwdCtrl = TextEditingController();

  bool _savingProfile = false;
  bool _savingPwd = false;
  String? _uploadingSide;

  bool _obscureCurrent = true;
  bool _obscureNew = true;
  bool _obscureConfirm = true;

  String? _avatarBase64;
  String? _frontIdUrl;
  String? _backIdUrl;

  final Map<String, String> _profileErrors = {};
  final Map<String, String> _pwdErrors = {};

  static const _inputIcon =
      Icon(Icons.key, size: 18, color: AppColors.slate400);

  @override
  void initState() {
    super.initState();
    _initUserData();
  }

  @override
  void dispose() {
    _nameCtrl.dispose();
    _phoneCtrl.dispose();
    _emailCtrl.dispose();
    _dobCtrl.dispose();
    _idNumberCtrl.dispose();
    _nationalityCtrl.dispose();
    _addressCtrl.dispose();
    _currentPwdCtrl.dispose();
    _newPwdCtrl.dispose();
    _confirmPwdCtrl.dispose();
    super.dispose();
  }

  @override
  void didUpdateWidget(covariant ProfileTab oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.overview != widget.overview) {
      _initUserData();
    }
  }

  void _initUserData() {
    Map<dynamic, dynamic> user = const {};
    if (widget.overview?['user'] is Map) {
      user = widget.overview!['user'] as Map;
    } else {
      final authUser = ref.read(authProvider).user;
      if (authUser != null) {
        user = {
          'full_name': authUser.fullName,
          'email': authUser.email,
          'phone': authUser.phone,
        };
      }
    }

    _nameCtrl.text = user['full_name']?.toString() ?? '';
    _phoneCtrl.text = user['phone']?.toString() ?? '';
    _emailCtrl.text = user['email']?.toString() ?? '';
    _dobCtrl.text = toInputDate(user['dob']);
    _idNumberCtrl.text = user['id_number']?.toString() ?? '';
    _nationalityCtrl.text = user['nationality']?.toString() ?? 'Việt Nam';
    _addressCtrl.text = user['address']?.toString() ?? '';
    _avatarBase64 = null;

    _frontIdUrl = null;
    _backIdUrl = null;
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
    final phone = _phoneCtrl.text.trim();
    final email = _emailCtrl.text.trim();
    final idNumber = _idNumberCtrl.text.trim();

    final errors = <String, String>{};
    if (name.isEmpty) errors['full_name'] = 'Vui lòng nhập họ và tên.';
    if (phone.isNotEmpty && !isValidPhone(phone)) {
      errors['phone'] = 'Số điện thoại không đúng định dạng Việt Nam (10 số).';
    }
    if (email.isNotEmpty && !isValidEmail(email)) {
      errors['email'] = 'Địa chỉ email không hợp lệ.';
    }
    if (idNumber.isNotEmpty && !isValidIdNumber(idNumber)) {
      errors['id_number'] = 'Số CCCD (9/12 số) hoặc Hộ chiếu không hợp lệ.';
    }
    if (errors.isNotEmpty) {
      setState(() => _profileErrors
        ..clear()
        ..addAll(errors));
      return;
    }
    if (_profileErrors.isNotEmpty) setState(() => _profileErrors.clear());

    setState(() => _savingProfile = true);
    try {
      final payload = <String, dynamic>{
        'full_name': name,
        'phone': phone.isNotEmpty ? normalizePhone(phone) : '',
        'email': email,
        'dob': _dobCtrl.text.trim(),
        'id_number': idNumber,
        'nationality': _nationalityCtrl.text.trim(),
        'address': _addressCtrl.text.trim(),
        'avatar_base64': _avatarBase64 ?? '',
      };
      await ref.read(residentServiceProvider).updateProfile(payload);
      if (mounted) setState(() => _avatarBase64 = null);
      ref
          .read(toastProvider.notifier)
          .success('Cập nhật hồ sơ cá nhân thành công!');
      await widget.onRefreshOverview();
    } catch (err) {
      ref
          .read(toastProvider.notifier)
          .error(extractErrorMessage(err, 'Không thể cập nhật hồ sơ cá nhân.'));
    } finally {
      if (mounted) setState(() => _savingProfile = false);
    }
  }

  Future<void> _handleUploadIdImage(String side, dynamic fileData) async {
    if (fileData == null) return;
    setState(() => _uploadingSide = side);
    try {
      await ref.read(residentServiceProvider).uploadIdImage({
        'side': side,
        'image_data': fileData.toString(),
      });
      ref.read(toastProvider.notifier).success(
          'Đã cập nhật ảnh CCCD mặt ${side == 'front' ? 'trước' : 'sau'}.');
      await widget.onRefreshOverview();
    } catch (err) {
      ref
          .read(toastProvider.notifier)
          .error(extractErrorMessage(err, 'Không thể tải lên ảnh CCCD.'));
    } finally {
      if (mounted) setState(() => _uploadingSide = null);
    }
  }

  Future<void> _handleChangePassword() async {
    final current = _currentPwdCtrl.text;
    final newPwd = _newPwdCtrl.text;
    final confirm = _confirmPwdCtrl.text;

    final errors = <String, String>{};
    if (current.isEmpty) {
      errors['currentPassword'] = 'Vui lòng nhập mật khẩu hiện tại.';
    }
    if (newPwd.length < 8) {
      errors['newPassword'] = 'Mật khẩu mới phải có tối thiểu 8 ký tự.';
    } else if (newPwd == current) {
      errors['newPassword'] = 'Mật khẩu mới phải khác mật khẩu hiện tại.';
    }
    if (confirm != newPwd) {
      errors['confirmPassword'] = 'Xác nhận mật khẩu mới không khớp.';
    }
    if (errors.isNotEmpty) {
      setState(() => _pwdErrors
        ..clear()
        ..addAll(errors));
      return;
    }
    if (_pwdErrors.isNotEmpty) setState(() => _pwdErrors.clear());

    setState(() => _savingPwd = true);
    try {
      await ref.read(authServiceProvider).changePassword(current, newPwd);
      ref
          .read(toastProvider.notifier)
          .success('Đổi mật khẩu đăng nhập thành công!');
      _currentPwdCtrl.clear();
      _newPwdCtrl.clear();
      _confirmPwdCtrl.clear();
    } catch (err) {
      ref.read(toastProvider.notifier).error(extractErrorMessage(
          err, 'Không thể đổi mật khẩu. Vui lòng kiểm tra mật khẩu hiện tại.'));
    } finally {
      if (mounted) setState(() => _savingPwd = false);
    }
  }

  IconButton _visibilityToggle(
      bool obscure, VoidCallback onPressed, String label) {
    return IconButton(
      tooltip: obscure ? 'Hiện $label' : 'Ẩn $label',
      icon: Icon(obscure ? Icons.visibility : Icons.visibility_off, size: 18),
      color: AppColors.slate400,
      onPressed: onPressed,
    );
  }

  Widget _fieldsGrid(List<Widget> fields) {
    return LayoutBuilder(
      builder: (context, constraints) {
        final twoCols = constraints.maxWidth >= 600;
        const gap = 12.0;
        final width =
            twoCols ? (constraints.maxWidth - gap) / 2 : constraints.maxWidth;
        return Wrap(
          spacing: gap,
          runSpacing: 12,
          children: [
            for (final field in fields) SizedBox(width: width, child: field)
          ],
        );
      },
    );
  }

  Widget _idImageCard(String side, String label, String? url) {
    final hasImage = url != null && url.isNotEmpty;
    final status = _uploadingSide == side
        ? 'Đang tải lên...'
        : (hasImage ? 'Đã lưu trữ' : 'Chưa có ảnh');
    final labelLower = label.toLowerCase();

    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: AppColors.slate50,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: AppColors.slate200),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        mainAxisSize: MainAxisSize.min,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  label,
                  style: const TextStyle(
                    fontFamily: 'Inter',
                    fontSize: 12,
                    fontWeight: FontWeight.w600,
                    color: AppColors.slate800,
                  ),
                ),
              ),
              Text(
                status,
                style: const TextStyle(
                  fontFamily: 'Inter',
                  fontSize: 11,
                  color: AppColors.slate500,
                ),
              ),
            ],
          ),
          const SizedBox(height: 12),
          Container(
            height: 144,
            clipBehavior: Clip.antiAlias,
            decoration: BoxDecoration(
              color: Colors.white,
              borderRadius: BorderRadius.circular(8),
              border: Border.all(
                color: hasImage ? AppColors.slate200 : AppColors.slate300,
              ),
            ),
            child: hasImage
                ? AuthImage(
                    src: url,
                    alt: label,
                    width: double.infinity,
                    height: 144,
                    fit: BoxFit.contain)
                : Center(
                    child: Text(
                      'Chưa tải lên $labelLower',
                      style: const TextStyle(
                        fontFamily: 'Inter',
                        fontSize: 12,
                        color: AppColors.slate400,
                      ),
                    ),
                  ),
          ),
          const SizedBox(height: 12),
          FileUploadField(
            label:
                hasImage ? 'Cập nhật lại $labelLower' : 'Tải lên $labelLower',
            value: '',
            allowPdf: false,
            onChanged: (val) => _handleUploadIdImage(side, val),
          ),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return RefreshIndicator(
      onRefresh: widget.onRefreshOverview,
      child: SingleChildScrollView(
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.all(16),
        child: LayoutBuilder(
          builder: (context, constraints) {
            const gap = 16.0;
            final twoColumns = constraints.maxWidth >= 1024;
            final leftWidth = twoColumns
                ? (constraints.maxWidth - gap) * 8 / 12
                : constraints.maxWidth;
            final rightWidth = twoColumns
                ? (constraints.maxWidth - gap) * 4 / 12
                : constraints.maxWidth;

            return Wrap(
              spacing: gap,
              runSpacing: gap,
              children: [
                SizedBox(width: leftWidth, child: _buildProfileColumn()),
                SizedBox(width: rightWidth, child: _buildPasswordCard()),
              ],
            );
          },
        ),
      ),
    );
  }

  Widget _buildProfileColumn() {
    final user = widget.overview?['user'] is Map
        ? widget.overview!['user'] as Map
        : const <dynamic, dynamic>{};
    final avatarPreview = (_avatarBase64 != null && _avatarBase64!.isNotEmpty)
        ? _avatarBase64
        : user['avatar_url']?.toString();
    final consentAt = user['privacy_consent_at'];
    final consentVersion = user['privacy_policy_version'];
    String? consentText;
    if (consentAt != null && consentAt.toString().isNotEmpty) {
      consentText =
          'Đã đồng thuận bảo vệ dữ liệu cá nhân lúc ${formatDateTime(consentAt)}';
      if (consentVersion != null && consentVersion.toString().isNotEmpty) {
        consentText += ' (Phiên bản $consentVersion)';
      }
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        AppCard(
          header: const AppCardHeader(
            title: 'Hồ sơ cá nhân Cư dân',
            subtitle:
                'Cập nhật thông tin liên lạc, định danh CCCD và địa chỉ thường trú phục vụ quản lý cư trú',
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              // Avatar
              Container(
                padding: const EdgeInsets.all(16),
                decoration: BoxDecoration(
                  color: AppColors.slate50,
                  borderRadius: BorderRadius.circular(12),
                  border: Border.all(color: AppColors.slate200),
                ),
                child: Row(
                  children: [
                    Container(
                      width: 80,
                      height: 80,
                      clipBehavior: Clip.antiAlias,
                      decoration: BoxDecoration(
                        color: AppColors.primary100,
                        borderRadius: BorderRadius.circular(16),
                        border: Border.all(color: Colors.white, width: 2),
                        boxShadow: const [AppColors.cardShadow],
                      ),
                      child: avatarPreview != null && avatarPreview.isNotEmpty
                          ? AuthImage(
                              src: avatarPreview,
                              alt: _nameCtrl.text.isNotEmpty
                                  ? _nameCtrl.text
                                  : 'Ảnh đại diện',
                              width: 80,
                              height: 80,
                              fit: BoxFit.cover,
                            )
                          : const Icon(Icons.account_circle,
                              size: 44, color: AppColors.primary600),
                    ),
                    const SizedBox(width: 16),
                    Expanded(
                      child: FileUploadField(
                        label: 'Ảnh chân dung / Ảnh đại diện',
                        value: _avatarBase64,
                        allowPdf: false,
                        maxSizeMB: 5,
                        hint: 'Chọn ảnh JPG hoặc PNG rõ mặt (tối đa 5MB)',
                        onChanged: (val) => setState(
                            () => _avatarBase64 = val?.toString() ?? ''),
                      ),
                    ),
                  ],
                ),
              ),
              const SizedBox(height: 20),
              _fieldsGrid([
                AppInput(
                  label: 'Họ và tên đầy đủ',
                  required: true,
                  placeholder: 'Nguyễn Văn A',
                  controller: _nameCtrl,
                  error: _profileErrors['full_name'],
                ),
                AppInput(
                  label: 'Số điện thoại liên hệ',
                  placeholder: '0901234567',
                  controller: _phoneCtrl,
                  keyboardType: TextInputType.phone,
                  error: _profileErrors['phone'],
                ),
                AppInput(
                  label: 'Địa chỉ Email',
                  placeholder: 'cudan@example.com',
                  controller: _emailCtrl,
                  keyboardType: TextInputType.emailAddress,
                  error: _profileErrors['email'],
                ),
                AppInput(
                  label: 'Ngày sinh',
                  controller: _dobCtrl,
                  placeholder: 'YYYY-MM-DD',
                  keyboardType: TextInputType.datetime,
                ),
                AppInput(
                  label: 'Số CCCD / Hộ chiếu',
                  placeholder: '079099001234',
                  controller: _idNumberCtrl,
                  error: _profileErrors['id_number'],
                ),
                AppInput(
                  label: 'Quốc tịch',
                  placeholder: 'Việt Nam',
                  controller: _nationalityCtrl,
                ),
              ]),
              const SizedBox(height: 16),
              AppInput(
                label: 'Địa chỉ thường trú',
                placeholder:
                    'Số nhà, đường/phố, phường/xã, quận/huyện, tỉnh/thành phố...',
                controller: _addressCtrl,
                multiline: true,
                rows: 2,
              ),
              const SizedBox(height: 16),
              Row(
                children: [
                  Expanded(
                    child: consentText == null
                        ? const SizedBox.shrink()
                        : Row(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              const Icon(Icons.verified_user,
                                  size: 16, color: AppColors.emerald600),
                              const SizedBox(width: 6),
                              Expanded(
                                child: Text(
                                  consentText,
                                  style: const TextStyle(
                                    fontFamily: 'Inter',
                                    fontSize: 11,
                                    color: AppColors.slate500,
                                  ),
                                ),
                              ),
                            ],
                          ),
                  ),
                  const SizedBox(width: 12),
                  AppButton(
                    text: _savingProfile ? 'Đang lưu...' : 'Lưu thay đổi hồ sơ',
                    loading: _savingProfile,
                    onPressed: _savingProfile ? null : _handleSaveProfile,
                  ),
                ],
              ),
            ],
          ),
        ),
        const SizedBox(height: 16),
        AppCard(
          header: const AppCardHeader(
            title: 'Ảnh giấy tờ tùy thân (CCCD / Hộ chiếu)',
            subtitle:
                'Hình ảnh CCCD 2 mặt phục vụ xác thực cư trú và lập hợp đồng thuê',
          ),
          child: LayoutBuilder(
            builder: (context, constraints) {
              const gap = 12.0;
              final twoCols = constraints.maxWidth >= 600;
              final width = twoCols
                  ? (constraints.maxWidth - gap) / 2
                  : constraints.maxWidth;
              return Wrap(
                spacing: gap,
                runSpacing: gap,
                children: [
                  SizedBox(
                    width: width,
                    child: _idImageCard('front', 'CCCD Mặt trước', _frontIdUrl),
                  ),
                  SizedBox(
                    width: width,
                    child: _idImageCard('back', 'CCCD Mặt sau', _backIdUrl),
                  ),
                ],
              );
            },
          ),
        ),
      ],
    );
  }

  Widget _buildPasswordCard() {
    return AppCard(
      header: const AppCardHeader(
        title: 'Đổi mật khẩu đăng nhập',
        subtitle: 'Bảo vệ tài khoản Cổng cư dân của bạn',
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          AppInput(
            label: 'Mật khẩu hiện tại',
            required: true,
            placeholder: '••••••••',
            controller: _currentPwdCtrl,
            obscureText: _obscureCurrent,
            icon: _inputIcon,
            error: _pwdErrors['currentPassword'],
            rightElement: _visibilityToggle(
              _obscureCurrent,
              () => setState(() => _obscureCurrent = !_obscureCurrent),
              'mật khẩu hiện tại',
            ),
          ),
          const SizedBox(height: 16),
          AppInput(
            label: 'Mật khẩu mới',
            required: true,
            placeholder: 'Tối thiểu 8 ký tự',
            controller: _newPwdCtrl,
            obscureText: _obscureNew,
            icon: _inputIcon,
            error: _pwdErrors['newPassword'],
            rightElement: _visibilityToggle(
              _obscureNew,
              () => setState(() => _obscureNew = !_obscureNew),
              'mật khẩu mới',
            ),
          ),
          const SizedBox(height: 16),
          AppInput(
            label: 'Xác nhận mật khẩu mới',
            required: true,
            placeholder: 'Nhập lại mật khẩu mới',
            controller: _confirmPwdCtrl,
            obscureText: _obscureConfirm,
            icon: _inputIcon,
            error: _pwdErrors['confirmPassword'],
            rightElement: _visibilityToggle(
              _obscureConfirm,
              () => setState(() => _obscureConfirm = !_obscureConfirm),
              'mật khẩu mới',
            ),
          ),
          const SizedBox(height: 16),
          Container(
            padding: const EdgeInsets.all(12),
            decoration: BoxDecoration(
              color: AppColors.slate50,
              borderRadius: BorderRadius.circular(12),
              border: Border.all(color: AppColors.slate200),
            ),
            child: const Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Icon(Icons.verified_user,
                    size: 16, color: AppColors.emerald600),
                SizedBox(width: 8),
                Expanded(
                  child: Text(
                    'Nên kết hợp chữ hoa, chữ thường, chữ số và ký tự đặc biệt để tăng cường bảo mật cho tài khoản.',
                    style: TextStyle(
                      fontFamily: 'Inter',
                      fontSize: 11,
                      color: AppColors.slate500,
                    ),
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(height: 16),
          AppButton(
            text: 'Cập nhật mật khẩu',
            variant: AppButtonVariant.secondary,
            fullWidth: true,
            loading: _savingPwd,
            onPressed: _savingPwd ? null : _handleChangePassword,
          ),
        ],
      ),
    );
  }
}
