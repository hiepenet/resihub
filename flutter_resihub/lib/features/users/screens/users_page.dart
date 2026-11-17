import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../../../core/constants/statuses.dart';
import '../../../core/theme/app_colors.dart';
import '../../../core/utils/ai_helpers.dart';
import '../../../core/utils/format.dart';
import '../../../core/utils/validation.dart';
import '../../../shared/providers/toast_provider.dart';
import '../../../shared/widgets/common/confirm_dialog.dart';
import '../../../shared/widgets/common/data_table_widget.dart';
import '../../../shared/widgets/common/page_header.dart';
import '../../../shared/widgets/common/search_bar_widget.dart';
import '../../../shared/widgets/common/status_badge.dart';
import '../../../shared/widgets/ui/app_badge.dart';
import '../../../shared/widgets/ui/app_button.dart';
import '../../../shared/widgets/ui/app_card.dart';
import '../../../shared/widgets/ui/app_input.dart';
import '../../../shared/widgets/ui/app_modal.dart';
import '../../../shared/widgets/ui/app_select.dart';
import '../../../shared/widgets/ui/app_tabs.dart';
import '../../../shared/widgets/ui/money_input.dart';
import '../../ai_gateway/widgets/ai_gateway_config_card.dart';
import '../../audit/widgets/audit_logs_view.dart';
import '../../auth/providers/auth_provider.dart';
import '../../auth/providers/permission_provider.dart';
import '../../buildings/services/buildings_service.dart';
import '../services/users_service.dart';

const List<AppSelectOption<String>> kAllRoleSelectOptions = [
  AppSelectOption(value: 'SYS_ADMIN', label: 'Quản trị hệ thống (SYS_ADMIN)'),
  AppSelectOption(value: 'OWNER', label: 'Chủ đầu tư (OWNER)'),
  AppSelectOption(value: 'MANAGER', label: 'Quản lý tòa nhà (MANAGER)'),
  AppSelectOption(value: 'RESIDENT', label: 'Cư dân (RESIDENT)'),
];

// Mirror of React `constants/roles.js` (ROLE_LABELS / ROLE_BADGE_VARIANTS).
const Map<String, String> kRoleLabels = {
  'SYS_ADMIN': 'Quản trị hệ thống',
  'OWNER': 'Chủ đầu tư',
  'MANAGER': 'Quản lý tòa nhà',
  'RESIDENT': 'Cư dân',
};
const Map<String, AppBadgeVariant> kRoleBadgeVariants = {
  'SYS_ADMIN': AppBadgeVariant.indigo,
  'OWNER': AppBadgeVariant.amber,
  'MANAGER': AppBadgeVariant.sky,
  'RESIDENT': AppBadgeVariant.purple,
};

const Map<String, dynamic> kUsersDefaultSlaConfig = {
  'response_hours': 2,
  'urgent_resolve_hours': 4,
  'normal_resolve_hours': 24,
  'deposit_refund_days': 5,
};
const Map<String, dynamic> kUsersDefaultContactConfig = {
  'working_hours': '08:00 – 18:00 (Thứ 2 – Thứ 7)',
  'technical_hotline': '1900 6868',
  'security_hotline': '1900 9119',
  'emergency_phone': '0909 113 114',
  'support_email': 'support@resihub.vn',
};

num _cfgNum(dynamic value, num fallback, {num? min, num? max}) {
  var n = num.tryParse(value?.toString() ?? '') ?? fallback;
  if (min != null && n < min) n = min;
  if (max != null && n > max) n = max;
  return n;
}

int _cfgInt(dynamic value, int fallback, {int? min, int? max}) =>
    _cfgNum(value, fallback, min: min, max: max).round();

/// Rebuild billing UI state from a server default (or null) — never spread the
/// previous map, otherwise a `reminder_days` list leaves a stale
/// `reminder_days_text` behind (React UsersPage.jsx:399-411).
Map<String, dynamic> billingStateFromConfig(Map? def) {
  return <String, dynamic>{
    'billing_day': def?['billing_day'] ?? 1,
    'payment_due_days': def?['payment_due_days'] ?? 5,
    'reminder_days_text': def?['reminder_days'] is List
        ? (def!['reminder_days'] as List).join(', ')
        : '3, 7, 15',
    'late_fee_percent': def?['late_fee_percent'] ?? 0,
    'electricity_default_price': def?['electricity_default_price'] ?? 3800,
    'water_default_price': def?['water_default_price'] ?? 22000,
  };
}

/// Build the settings payload with the same keys/types/defaults/clamps as
/// React UsersPage.jsx:426-471. Kept pure so it is unit-testable.
Map<String, dynamic> buildSettingsPayload({
  required Map<String, dynamic> billing,
  required Map<String, dynamic> sla,
  required Map<String, dynamic> contact,
  required Map<String, dynamic> approval,
  required Map<String, dynamic> ai,
}) {
  final reminderDays = billing['reminder_days_text']
      .toString()
      .split(',')
      .map((x) => num.tryParse(x.trim()))
      .where((n) => n != null && n > 0)
      .map((n) => n!.round())
      .toList();

  return <String, dynamic>{
    'billing_config': <String, dynamic>{
      'billing_day': _cfgInt(billing['billing_day'], 1, min: 1, max: 31),
      'payment_due_days': _cfgInt(billing['payment_due_days'], 5, min: 1),
      'reminder_days': reminderDays.isNotEmpty ? reminderDays : const [3, 7, 15],
      'late_fee_percent': _cfgNum(billing['late_fee_percent'], 0, min: 0),
      'electricity_default_price': _cfgInt(billing['electricity_default_price'], 3800, min: 0),
      'water_default_price': _cfgInt(billing['water_default_price'], 22000, min: 0),
    },
    'sla_config': <String, dynamic>{
      'response_hours': _cfgInt(sla['response_hours'], 2, min: 1),
      'urgent_resolve_hours': _cfgInt(sla['urgent_resolve_hours'], 4, min: 1),
      'normal_resolve_hours': _cfgInt(sla['normal_resolve_hours'], 24, min: 1),
      'deposit_refund_days': _cfgInt(sla['deposit_refund_days'], 5, min: 1),
    },
    'contact_config': <String, dynamic>{
      'working_hours': contact['working_hours']?.toString().trim() ?? '',
      'technical_hotline': contact['technical_hotline']?.toString().trim() ?? '',
      'security_hotline': contact['security_hotline']?.toString().trim() ?? '',
      'emergency_phone': contact['emergency_phone']?.toString().trim() ?? '',
      'support_email': contact['support_email']?.toString().trim() ?? '',
    },
    'approval_config': <String, dynamic>{
      'allow_self_approval': approval['allow_self_approval'] == true,
    },
    'ai_config': <String, dynamic>{
      ...ai,
      'monthly_budget_vnd': _cfgInt(ai['monthly_budget_vnd'], 0, min: 0),
      'monthly_token_limit': _cfgInt(ai['monthly_token_limit'], 5000000, min: 10000),
      'ocr_threshold': _cfgNum(ai['ocr_threshold'], 0.85),
      'extract_threshold': _cfgNum(ai['extract_threshold'], 0.75),
      'triage_threshold': _cfgNum(ai['triage_threshold'], 0.65),
    },
  };
}

class UsersPage extends ConsumerStatefulWidget {
  const UsersPage({super.key});

  @override
  ConsumerState<UsersPage> createState() => _UsersPageState();
}

class _UsersPageState extends ConsumerState<UsersPage> {
  String _activeTab = 'users'; // 'users' | 'settings' | 'audit'

  // Tab 1: Users
  List<Map<String, dynamic>> _users = [];
  List<Map<String, dynamic>> _buildings = [];
  bool _loadingUsers = true;
  String? _roleFilter;
  String? _statusFilter;
  String _search = '';
  bool _filterBySelectedBuilding = true;

  // Tab 2: Settings
  bool _loadingSettings = false;
  bool _savingSettings = false;
  bool _resettingSetting = false;
  Map<String, dynamic> _billingConfig = billingStateFromConfig(null);
  Map<String, dynamic> _slaConfig = Map<String, dynamic>.from(kUsersDefaultSlaConfig);
  Map<String, dynamic> _contactConfig = Map<String, dynamic>.from(kUsersDefaultContactConfig);
  Map<String, dynamic> _approvalConfig = {'allow_self_approval': false};
  Map<String, dynamic> _aiConfig = Map<String, dynamic>.from(kDefaultAiConfig);
  bool _aiKeyConfigured = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _fetchUsersData();
      _fetchSettingsData();
    });
  }

  Future<void> _fetchUsersData() async {
    setState(() => _loadingUsers = true);
    try {
      final usersService = ref.read(usersServiceProvider);
      final buildingsService = ref.read(buildingsServiceProvider);

      final usersRes = await usersService.list({
        if (_roleFilter != null && _roleFilter!.isNotEmpty) 'role': _roleFilter,
        if (_statusFilter != null && _statusFilter!.isNotEmpty) 'status': _statusFilter,
        if (_search.trim().isNotEmpty) 'search': _search.trim(),
      });

      final bldgRes = await buildingsService.list().catchError((_) => {'data': []});

      if (mounted) {
        setState(() {
          if (usersRes is Map && usersRes['data'] is List) {
            _users = (usersRes['data'] as List).whereType<Map>().map((e) => Map<String, dynamic>.from(e)).toList();
          } else if (usersRes is List) {
            _users = usersRes.whereType<Map>().map((e) => Map<String, dynamic>.from(e)).toList();
          }

          if (bldgRes is Map && bldgRes['data'] is List) {
            _buildings = (bldgRes['data'] as List).whereType<Map>().map((e) => Map<String, dynamic>.from(e)).toList();
          }
          _loadingUsers = false;
        });
      }
    } catch (err) {
      if (mounted) {
        ref.read(toastProvider.notifier).error(
              extractErrorMessage(err, 'Không thể tải danh sách tài khoản.'),
            );
        setState(() => _loadingUsers = false);
      }
    }
  }

  Future<void> _fetchSettingsData() async {
    setState(() => _loadingSettings = true);
    try {
      final usersService = ref.read(usersServiceProvider);
      final res = await usersService.getSettings();
      final data = res is Map && res['data'] is Map ? res['data'] as Map : (res is Map ? res : {});

      if (mounted) {
        setState(() {
          if (data['billing_config'] is Map) {
            _billingConfig = billingStateFromConfig(data['billing_config'] as Map);
          }
          if (data['sla_config'] is Map) {
            _slaConfig = {
              ..._slaConfig,
              ...Map<String, dynamic>.from(data['sla_config'] as Map),
            };
          }
          if (data['contact_config'] is Map) {
            _contactConfig = {
              ..._contactConfig,
              ...Map<String, dynamic>.from(data['contact_config'] as Map),
            };
          }
          if (data['approval_config'] is Map) {
            _approvalConfig = {
              'allow_self_approval': (data['approval_config'] as Map)['allow_self_approval'] == true,
            };
          }
          if (data['ai_config'] is Map) {
            _aiConfig = mergeAiConfigState(Map<String, dynamic>.from(data['ai_config'] as Map));
          }
          final aiRuntime = res is Map ? res['ai_runtime'] : null;
          _aiKeyConfigured = aiRuntime is Map && aiRuntime['api_key_configured'] == true;
          _loadingSettings = false;
        });
      }
    } catch (err) {
      if (mounted) {
        ref.read(toastProvider.notifier).error(
              extractErrorMessage(err, 'Không thể tải cấu hình hệ thống.'),
            );
        setState(() => _loadingSettings = false);
      }
    }
  }

  List<Map<String, dynamic>> _getDisplayedUsers() {
    final authState = ref.read(authProvider);
    final selectedBuildingId = authState.selectedBuildingId;

    if (selectedBuildingId.isEmpty || !_filterBySelectedBuilding) {
      return _users;
    }
    return _users.where((u) {
      final roles = u['roles'] is List ? (u['roles'] as List).whereType<Map>().toList() : <Map>[];
      return roles.any((r) => r['code'] == 'SYS_ADMIN' || r['building_id'] == selectedBuildingId);
    }).toList();
  }

  void _openUserModal([Map<String, dynamic>? editingUser]) {
    final authState = ref.read(authProvider);
    final selectedBuildingId = authState.selectedBuildingId;

    final isEdit = editingUser != null;
    final nameCtrl = TextEditingController(text: editingUser?['full_name']?.toString() ?? '');
    final emailCtrl = TextEditingController(text: editingUser?['email']?.toString() ?? '');
    final phoneCtrl = TextEditingController(text: editingUser?['phone']?.toString() ?? '');
    final idNumberCtrl = TextEditingController(text: editingUser?['id_number']?.toString() ?? '');
    final passCtrl = TextEditingController();
    String currentStatus = editingUser?['status']?.toString() ?? 'ACTIVE';

    List<Map<String, String>> currentRoles = [];
    if (editingUser?['roles'] is List) {
      for (final r in editingUser!['roles'] as List) {
        if (r is Map && r['code'] != null) {
          currentRoles.add({
            'role_code': r['code'].toString(),
            'building_id': r['building_id']?.toString() ?? '',
          });
        }
      }
    }
    if (currentRoles.isEmpty) {
      currentRoles.add({
        'role_code': 'MANAGER',
        'building_id': selectedBuildingId,
      });
    }

    AppModal.show<void>(
      context: context,
      title: isEdit ? 'Cập nhật tài khoản & Phân quyền' : 'Tạo tài khoản mới',
      subtitle: isEdit ? 'Chỉnh sửa vai trò, quyền hạn và trạng thái người dùng.' : 'Khởi tạo tài khoản nhân viên hoặc đối tác vào hệ thống.',
      size: AppModalSize.lg,
      child: StatefulBuilder(
        builder: (ctx, setModalState) {
          return SingleChildScrollView(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                AppInput(
                  label: 'Họ và tên',
                  controller: nameCtrl,
                  required: true,
                  placeholder: 'VD: Nguyễn Văn A',
                ),
                const SizedBox(height: 12),
                Row(
                  children: [
                    Expanded(
                      child: AppInput(
                        label: 'Địa chỉ Email',
                        controller: emailCtrl,
                        placeholder: 'user@resihub.vn',
                      ),
                    ),
                    const SizedBox(width: 12),
                    Expanded(
                      child: AppInput(
                        label: 'Số điện thoại',
                        controller: phoneCtrl,
                        placeholder: '0901234567',
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 12),
                Row(
                  children: [
                    Expanded(
                      child: AppInput(
                        label: 'Số CCCD / Hộ chiếu',
                        controller: idNumberCtrl,
                        placeholder: '12 chữ số',
                      ),
                    ),
                    const SizedBox(width: 12),
                    Expanded(
                      child: AppInput(
                        label: isEdit ? 'Mật khẩu mới (bỏ trống nếu không đổi)' : 'Mật khẩu khởi tạo (≥ 8 ký tự)',
                        controller: passCtrl,
                        obscureText: true,
                        placeholder: '••••••••',
                        required: !isEdit,
                      ),
                    ),
                  ],
                ),
                if (isEdit) ...[
                  const SizedBox(height: 12),
                  AppSelect<String>(
                    label: 'Trạng thái tài khoản',
                    value: currentStatus,
                    options: const [
                      AppSelectOption(value: 'ACTIVE', label: 'Đang hoạt động (ACTIVE)'),
                      AppSelectOption(value: 'SUSPENDED', label: 'Tạm khóa (SUSPENDED)'),
                    ],
                    onChanged: (val) => setModalState(() => currentStatus = val ?? 'ACTIVE'),
                  ),
                ],
                const SizedBox(height: 16),
                const Divider(color: AppColors.border),
                const SizedBox(height: 12),

                // Roles configuration rows
                Row(
                  mainAxisAlignment: MainAxisAlignment.spaceBetween,
                  children: [
                    const Expanded(
                      child: Text(
                        'Phân quyền vai trò & Phạm vi tòa nhà',
                        style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: AppColors.slate900),
                      ),
                    ),
                    AppButton(
                      text: 'Thêm vai trò',
                      size: AppButtonSize.xs,
                      variant: AppButtonVariant.outline,
                      icon: const Icon(LucideIcons.plus, size: 13),
                      onPressed: () {
                        setModalState(() {
                          currentRoles.add({
                            'role_code': 'MANAGER',
                            'building_id': selectedBuildingId,
                          });
                        });
                      },
                    ),
                  ],
                ),
                const SizedBox(height: 10),

                ...currentRoles.asMap().entries.map((entry) {
                  final idx = entry.key;
                  final roleRow = entry.value;
                  final isSysAdmin = roleRow['role_code'] == 'SYS_ADMIN';

                  return Padding(
                    padding: const EdgeInsets.only(bottom: 8.0),
                    child: Row(
                      children: [
                        Expanded(
                          flex: 3,
                          child: AppSelect<String>(
                            value: roleRow['role_code'],
                            options: kAllRoleSelectOptions,
                            onChanged: (val) {
                              setModalState(() {
                                roleRow['role_code'] = val ?? 'MANAGER';
                                if (val == 'SYS_ADMIN') {
                                  roleRow['building_id'] = '';
                                }
                              });
                            },
                          ),
                        ),
                        const SizedBox(width: 8),
                        Expanded(
                          flex: 4,
                          child: AppSelect<String>(
                            placeholder: isSysAdmin ? 'Toàn hệ thống (Không giới hạn)' : 'Chọn tòa nhà phụ trách',
                            disabled: isSysAdmin,
                            value: isSysAdmin ? '' : roleRow['building_id'],
                            options: [
                              const AppSelectOption(value: '', label: 'Chưa gán tòa nhà'),
                              ..._buildings.map(
                                (b) => AppSelectOption(
                                  value: b['id'].toString(),
                                  label: '${b['code']} — ${b['name']}',
                                ),
                              ),
                            ],
                            onChanged: isSysAdmin
                                ? null
                                : (val) => setModalState(() => roleRow['building_id'] = val ?? ''),
                          ),
                        ),
                        const SizedBox(width: 8),
                        // React: minRoles = 0 when editing, 1 when creating.
                        if (isEdit || currentRoles.length > 1)
                          IconButton(
                            key: ValueKey('remove-role-row-$idx'),
                            icon: const Icon(LucideIcons.trash2, size: 16, color: AppColors.rose600),
                            onPressed: () {
                              setModalState(() {
                                currentRoles.removeAt(idx);
                              });
                            },
                          ),
                      ],
                    ),
                  );
                }),
                const SizedBox(height: 16),

                // Footer Save Button
                Row(
                  mainAxisAlignment: MainAxisAlignment.end,
                  children: [
                    AppButton(
                      text: 'Hủy bỏ',
                      variant: AppButtonVariant.outline,
                      onPressed: () => Navigator.of(context, rootNavigator: true).pop(),
                    ),
                    const SizedBox(width: 10),
                    AppButton(
                      text: isEdit ? 'Cập nhật' : 'Tạo tài khoản',
                      variant: AppButtonVariant.primary,
                      onPressed: () async {
                        final fullName = nameCtrl.text.trim();
                        final email = emailCtrl.text.trim();
                        final phone = phoneCtrl.text.trim();
                        final idNumber = idNumberCtrl.text.trim();
                        final password = passCtrl.text;

                        if (fullName.isEmpty) {
                          ref.read(toastProvider.notifier).warning('Họ và tên người dùng là bắt buộc.');
                          return;
                        }
                        if (email.isEmpty && phone.isEmpty) {
                          ref.read(toastProvider.notifier).warning('Phải nhập ít nhất Email hoặc Số điện thoại.');
                          return;
                        }
                        if (email.isNotEmpty && !isValidEmail(email)) {
                          ref.read(toastProvider.notifier).warning('Địa chỉ Email không đúng định dạng.');
                          return;
                        }
                        if (phone.isNotEmpty && !isValidPhone(phone)) {
                          ref.read(toastProvider.notifier).warning('Số điện thoại Việt Nam không hợp lệ (10 chữ số).');
                          return;
                        }
                        if (!isEdit && (password.isEmpty || password.length < 8)) {
                          ref.read(toastProvider.notifier).warning('Mật khẩu khởi tạo phải có tối thiểu 8 ký tự.');
                          return;
                        }
                        if (isEdit && password.isNotEmpty && password.length < 8) {
                          ref.read(toastProvider.notifier).warning('Mật khẩu đặt lại phải có tối thiểu 8 ký tự.');
                          return;
                        }

                        final formattedRoles = currentRoles.map((r) => {
                          'role_code': r['role_code']!,
                          'building_id': r['role_code'] == 'SYS_ADMIN' ? null : (r['building_id']!.isEmpty ? null : r['building_id']),
                        }).toList();

                        try {
                          final usersService = ref.read(usersServiceProvider);
                          if (isEdit) {
                            final payload = <String, dynamic>{
                              'full_name': fullName,
                              'email': email.isNotEmpty ? email : null,
                              'phone': phone.isNotEmpty ? phone : null,
                              'id_number': idNumber.isNotEmpty ? idNumber : null,
                              'status': currentStatus,
                              'roles': formattedRoles,
                              if (password.isNotEmpty) 'password': password,
                            };
                            final res = await usersService.update(editingUser['id'].toString(), payload);
                            final msg = res is Map && res['message'] != null ? res['message'].toString() : 'Cập nhật tài khoản thành công.';
                            ref.read(toastProvider.notifier).success(msg);
                          } else {
                            final payload = <String, dynamic>{
                              'full_name': fullName,
                              'email': email.isNotEmpty ? email : null,
                              'phone': phone.isNotEmpty ? phone : null,
                              'id_number': idNumber.isNotEmpty ? idNumber : null,
                              'password': password,
                              'roles': formattedRoles,
                            };
                            final res = await usersService.create(payload);
                            final msg = res is Map && res['message'] != null ? res['message'].toString() : 'Tạo tài khoản mới thành công.';
                            ref.read(toastProvider.notifier).success(msg);
                          }
                          if (ctx.mounted) {
                            Navigator.of(ctx, rootNavigator: true).pop();
                          }
                          _fetchUsersData();
                        } catch (err) {
                          ref.read(toastProvider.notifier).error(
                                extractErrorMessage(err, 'Không thể lưu tài khoản người dùng.'),
                              );
                        }
                      },
                    ),
                  ],
                ),
              ],
            ),
          );
        },
      ),
    );
  }

  Future<void> _handleConfirmToggleStatus(Map<String, dynamic> user) async {
    final currentStatus = user['status']?.toString() ?? 'ACTIVE';
    final nextStatus = currentStatus == 'ACTIVE' ? 'SUSPENDED' : 'ACTIVE';
    final name = user['full_name']?.toString() ?? 'người dùng';

    final confirmed = await ConfirmDialog.show(
      context: context,
      title: nextStatus == 'SUSPENDED' ? 'Tạm khóa tài khoản' : 'Mở khóa tài khoản',
      message: 'Bạn có chắc chắn muốn ${nextStatus == 'SUSPENDED' ? 'tạm khóa' : 'mở khóa'} tài khoản "$name"?',
      confirmLabel: nextStatus == 'SUSPENDED' ? 'Khóa tài khoản' : 'Mở khóa',
      variant: nextStatus == 'SUSPENDED' ? ConfirmDialogVariant.danger : ConfirmDialogVariant.primary,
    );
    if (confirmed != true) return;

    try {
      final usersService = ref.read(usersServiceProvider);
      final res = await usersService.update(user['id'].toString(), {'status': nextStatus});
      final msg = res is Map && res['message'] != null
          ? res['message'].toString()
          : (nextStatus == 'SUSPENDED' ? 'Đã tạm khóa tài khoản $name.' : 'Đã mở khóa tài khoản $name.');
      ref.read(toastProvider.notifier).success(msg);
      _fetchUsersData();
    } catch (err) {
      ref.read(toastProvider.notifier).error(
            extractErrorMessage(err, 'Không thể đổi trạng thái tài khoản.'),
          );
    }
  }

  Future<void> _handleConfirmDeleteUser(Map<String, dynamic> user) async {
    final name = user['full_name']?.toString() ?? 'người dùng';
    final confirmed = await ConfirmDialog.show(
      context: context,
      title: 'Xóa tài khoản vĩnh viễn',
      message: 'Bạn có chắc chắn muốn xóa tài khoản "$name"? Thao tác này chỉ thực hiện được với tài khoản chưa phát sinh dữ liệu lịch sử.',
      confirmLabel: 'Xóa vĩnh viễn',
      variant: ConfirmDialogVariant.danger,
    );
    if (confirmed != true) return;

    try {
      final usersService = ref.read(usersServiceProvider);
      final res = await usersService.remove(user['id'].toString());
      final msg = res is Map && res['message'] != null ? res['message'].toString() : 'Đã xóa tài khoản "$name".';
      ref.read(toastProvider.notifier).success(msg);
      _fetchUsersData();
    } catch (err) {
      ref.read(toastProvider.notifier).error(
            extractErrorMessage(err, 'Không thể xóa tài khoản người dùng.'),
          );
    }
  }

  Future<void> _handleSaveSettings() async {
    setState(() => _savingSettings = true);
    try {
      final usersService = ref.read(usersServiceProvider);
      final payload = buildSettingsPayload(
        billing: _billingConfig,
        sla: _slaConfig,
        contact: _contactConfig,
        approval: _approvalConfig,
        ai: _aiConfig,
      );

      final res = await usersService.updateSettings(payload);
      final msg = res is Map && res['message'] != null ? res['message'].toString() : 'Đã lưu cấu hình hệ thống thành công.';
      if (mounted) {
        ref.read(toastProvider.notifier).success(msg);
      }
    } catch (err) {
      if (mounted) {
        ref.read(toastProvider.notifier).error(
              extractErrorMessage(err, 'Không thể lưu cấu hình hệ thống.'),
            );
      }
    } finally {
      if (mounted) {
        setState(() => _savingSettings = false);
      }
    }
  }

  Future<void> _handleResetSetting(String key, String label) async {
    final confirmed = await ConfirmDialog.show(
      context: context,
      title: 'Khôi phục cấu hình mặc định',
      message: 'Bạn có chắc chắn muốn khôi phục thiết lập "$label" về mặc định?',
      confirmLabel: 'Khôi phục',
      variant: ConfirmDialogVariant.warning,
    );
    if (confirmed != true) return;

    setState(() => _resettingSetting = true);
    try {
      final usersService = ref.read(usersServiceProvider);
      final res = await usersService.resetSetting(key);
      final def = res is Map && res['default_value'] is Map ? res['default_value'] as Map : null;

      if (mounted) {
        setState(() {
          if (key == 'ai_config') {
            _aiConfig = mergeAiConfigState(def != null ? Map<String, dynamic>.from(def) : kDefaultAiConfig);
          } else if (key == 'approval_config') {
            _approvalConfig = {'allow_self_approval': def?['allow_self_approval'] == true};
          } else if (key == 'billing_config') {
            _billingConfig = billingStateFromConfig(def);
          } else if (key == 'sla_config') {
            _slaConfig = {
              ...kUsersDefaultSlaConfig,
              if (def != null) ...Map<String, dynamic>.from(def),
            };
          } else if (key == 'contact_config') {
            _contactConfig = {
              ...kUsersDefaultContactConfig,
              if (def != null) ...Map<String, dynamic>.from(def),
            };
          }
        });
        ref.read(toastProvider.notifier).success('Đã khôi phục cấu hình "$label" về mặc định.');
      }
    } catch (err) {
      if (mounted) {
        ref.read(toastProvider.notifier).error(
              extractErrorMessage(err, 'Không thể khôi phục cấu hình mặc định.'),
            );
      }
    } finally {
      if (mounted) {
        setState(() => _resettingSetting = false);
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final permissions = ref.watch(permissionProvider);
    final canManageUsers = permissions.canManageUsers;
    final currentUserId = permissions.user?.id;
    final displayedUsers = _getDisplayedUsers();

    final userColumns = <DataTableColumn<Map<String, dynamic>>>[
      DataTableColumn(
        key: 'full_name',
        label: 'Người dùng',
        width: 220,
        render: (row) {
          final name = row['full_name']?.toString() ?? 'U';
          final initial = name.isNotEmpty ? name.substring(0, 1).toUpperCase() : 'U';
          final idNum = row['id_number']?.toString();

          return Row(
            children: [
              Container(
                width: 36,
                height: 36,
                decoration: const BoxDecoration(
                  color: AppColors.primary100,
                  shape: BoxShape.circle,
                ),
                alignment: Alignment.center,
                child: Text(
                  initial,
                  style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 13, color: AppColors.primary700),
                ),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(name, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 13, color: AppColors.slate900)),
                    if (idNum != null && idNum.isNotEmpty)
                      Text('CCCD: $idNum', maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 11, color: AppColors.slate400)),
                  ],
                ),
              ),
            ],
          );
        },
      ),
      DataTableColumn(
        key: 'email',
        label: 'Liên hệ',
        width: 200,
        render: (row) {
          final email = row['email']?.toString() ?? '—';
          final phone = row['phone']?.toString() ?? '—';

          return Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(email, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w500, color: AppColors.slate800)),
              Text(phone, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 11, color: AppColors.slate500)),
            ],
          );
        },
      ),
      DataTableColumn(
        key: 'roles',
        label: 'Vai trò & Phạm vi',
        width: 240,
        render: (row) {
          final roles = row['roles'] is List ? (row['roles'] as List).whereType<Map>().toList() : <Map>[];
          if (roles.isEmpty) {
            return const Text('Chưa gán quyền', style: TextStyle(fontSize: 11, fontStyle: FontStyle.italic, color: AppColors.slate400));
          }

          return Wrap(
            spacing: 6,
            runSpacing: 4,
            children: roles.map((r) {
              final code = r['code']?.toString() ?? '';
              final bldg = r['building_code']?.toString() ?? '';
              final suffix = bldg.isNotEmpty ? ' • $bldg' : (code == 'SYS_ADMIN' ? ' • Toàn hệ thống' : '');
              final label = kRoleLabels[code] ?? r['name']?.toString() ?? code;

              return AppBadge(
                label: '$label$suffix',
                variant: kRoleBadgeVariants[code] ?? AppBadgeVariant.slate,
              );
            }).toList(),
          );
        },
      ),
      DataTableColumn(
        key: 'status',
        label: 'Trạng thái',
        align: TextAlign.center,
        width: 120,
        render: (row) => StatusBadge(
          status: row['status']?.toString(),
          domain: StatusDomain.user,
        ),
      ),
      DataTableColumn(
        key: 'last_login_at',
        label: 'Đăng nhập gần nhất',
        align: TextAlign.center,
        width: 140,
        render: (row) {
          final lastLogin = row['last_login_at'];
          return Text(
            lastLogin != null ? formatDateTime(lastLogin) : 'Chưa đăng nhập',
            style: const TextStyle(fontSize: 11, color: AppColors.slate500),
          );
        },
      ),
      DataTableColumn(
        key: 'actions',
        label: 'Thao tác',
        align: TextAlign.center,
        width: 380,
        render: (row) {
          if (!canManageUsers) return const SizedBox.shrink();
          final isSelf = currentUserId != null && row['id']?.toString() == currentUserId;
          final status = row['status']?.toString() ?? 'ACTIVE';

          return Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              AppButton(
                text: 'Phân quyền',
                size: AppButtonSize.xs,
                variant: AppButtonVariant.outline,
                icon: const Icon(LucideIcons.filePenLine, size: 12),
                onPressed: () => _openUserModal(row),
              ),
              const SizedBox(width: 4),
              AppButton(
                text: status == 'ACTIVE' ? 'Khóa' : 'Mở',
                size: AppButtonSize.xs,
                variant: status == 'ACTIVE' ? AppButtonVariant.danger : AppButtonVariant.success,
                icon: Icon(status == 'ACTIVE' ? LucideIcons.lock : LucideIcons.lockOpen, size: 12),
                disabled: isSelf && status == 'ACTIVE',
                onPressed: () => _handleConfirmToggleStatus(row),
              ),
              const SizedBox(width: 4),
              AppButton(
                text: 'Xóa',
                size: AppButtonSize.xs,
                variant: AppButtonVariant.outline,
                icon: const Icon(LucideIcons.trash2, size: 12),
                disabled: isSelf,
                onPressed: () => _handleConfirmDeleteUser(row),
              ),
            ],
          );
        },
      ),
    ];

    return Scaffold(
      key: const Key('route:/admin/users'),
      body: SingleChildScrollView(
        padding: const EdgeInsets.all(24),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            PageHeader(
              title: 'Người dùng & Cấu hình Hệ thống',
              subtitle: 'Quản lý tài khoản nhân sự, phân quyền theo phạm vi tòa nhà (RBAC + RLS) và thiết lập tham số vận hành.',
              actions: Wrap(
                spacing: 8,
                crossAxisAlignment: WrapCrossAlignment.center,
                children: [
                  AppButton(
                    text: 'Mở trang Nhật ký hệ thống',
                    variant: AppButtonVariant.outline,
                    icon: const Icon(LucideIcons.scrollText, size: 14),
                    rightIcon: const Icon(LucideIcons.externalLink, size: 14),
                    onPressed: () => context.go('/admin/audit-logs'),
                  ),
                  AppButton(
                    text: 'Mở trang cấu hình chi tiết & Cron',
                    variant: AppButtonVariant.outline,
                    icon: const Icon(LucideIcons.settings, size: 14),
                    rightIcon: const Icon(LucideIcons.externalLink, size: 14),
                    onPressed: () => context.go('/admin/settings'),
                  ),
                  if (_activeTab == 'users' && canManageUsers)
                    AppButton(
                      text: 'Tạo tài khoản mới',
                      variant: AppButtonVariant.primary,
                      icon: const Icon(LucideIcons.userPlus, size: 15),
                      onPressed: () => _openUserModal(),
                    )
                  else if (_activeTab == 'settings' && canManageUsers)
                    AppButton(
                      text: 'Lưu cấu hình hệ thống',
                      variant: AppButtonVariant.primary,
                      icon: const Icon(LucideIcons.save, size: 15),
                      loading: _savingSettings,
                      onPressed: _handleSaveSettings,
                    ),
                ],
              ),
            ),
            const SizedBox(height: 16),

            AppTabs(
              activeTab: _activeTab,
              onChanged: (val) => setState(() => _activeTab = val),
              tabs: [
                AppTabItem(
                  id: 'users',
                  label: 'Quản lý tài khoản & Phân quyền',
                  count: displayedUsers.length,
                ),
                const AppTabItem(
                  id: 'settings',
                  label: 'Cấu hình hệ thống',
                ),
                const AppTabItem(
                  id: 'audit',
                  label: 'Nhật ký hệ thống',
                ),
              ],
            ),
            const SizedBox(height: 16),

            // TAB 1: USERS
            if (_activeTab == 'users') ...[
              AppCard(
                padding: const EdgeInsets.all(16),
                child: Column(
                  children: [
                    Wrap(
                      spacing: 12,
                      runSpacing: 12,
                      children: [
                        SizedBox(
                          width: 320,
                          child: SearchBarWidget(
                            value: _search,
                            onChanged: (val) {
                              setState(() => _search = val);
                              _fetchUsersData();
                            },
                            placeholder: 'Tìm theo họ tên, email hoặc SĐT...',
                            debounceDuration: const Duration(milliseconds: 200),
                          ),
                        ),
                        SizedBox(
                          width: 220,
                          child: AppSelect<String>(
                            placeholder: 'Tất cả vai trò',
                            value: _roleFilter,
                            options: [
                              const AppSelectOption(value: '', label: 'Tất cả vai trò'),
                              ...kAllRoleSelectOptions,
                            ],
                            onChanged: (val) {
                              setState(() => _roleFilter = val);
                              _fetchUsersData();
                            },
                          ),
                        ),
                        SizedBox(
                          width: 200,
                          child: AppSelect<String>(
                            placeholder: 'Tất cả trạng thái',
                            value: _statusFilter,
                            options: const [
                              AppSelectOption(value: '', label: 'Tất cả trạng thái'),
                              AppSelectOption(value: 'ACTIVE', label: 'Đang hoạt động (ACTIVE)'),
                              AppSelectOption(value: 'SUSPENDED', label: 'Tạm khóa (SUSPENDED)'),
                            ],
                            onChanged: (val) {
                              setState(() => _statusFilter = val);
                              _fetchUsersData();
                            },
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 12),
                    Row(
                      mainAxisAlignment: MainAxisAlignment.spaceBetween,
                      children: [
                        Text(
                          _filterBySelectedBuilding
                              ? 'Đang lọc nhân sự thuộc tòa nhà đã chọn trên thanh điều hướng.'
                              : 'Đang hiển thị toàn bộ tài khoản trong tổ chức.',
                          style: const TextStyle(fontSize: 11, color: AppColors.slate600),
                        ),
                        InkWell(
                          onTap: () => setState(() => _filterBySelectedBuilding = !_filterBySelectedBuilding),
                          child: Text(
                            _filterBySelectedBuilding ? 'Xem toàn tổ chức' : 'Chỉ xem tòa đang chọn',
                            style: const TextStyle(fontSize: 11, fontWeight: FontWeight.w600, color: AppColors.primary600),
                          ),
                        ),
                      ],
                    ),
                  ],
                ),
              ),
              const SizedBox(height: 16),
              DataTableWidget<Map<String, dynamic>>(
                columns: userColumns,
                data: displayedUsers,
                loading: _loadingUsers,
                emptyTitle: 'Không tìm thấy tài khoản nào',
                emptyDescription: 'Thử thay đổi bộ lọc vai trò hoặc từ khóa tìm kiếm.',
              ),
            ],

            // TAB 2: SETTINGS
            if (_activeTab == 'settings') ...[
              if (_loadingSettings)
                const Center(
                  child: Padding(
                    padding: EdgeInsets.all(40),
                    child: CircularProgressIndicator(),
                  ),
                )
              else ...[
                AiGatewayConfigCard(
                aiConfig: _aiConfig,
                onChange: (val) => setState(() => _aiConfig = val),
                apiKeyConfigured: _aiKeyConfigured,
                canEdit: canManageUsers,
                resetting: _resettingSetting,
                onReset: canManageUsers ? () => _handleResetSetting('ai_config', 'Cổng Trợ lý AI (ai_config)') : null,
              ),
              const SizedBox(height: 20),

              // Four-eyes Rule Card
              AppCard(
                padding: const EdgeInsets.all(20),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    AppCardHeader(
                      title: 'Quy tắc Phê duyệt Nội bộ (Four-eyes)',
                      subtitle: 'Khóa cấu hình: approval_config',
                      action: canManageUsers
                          ? AppButton(
                              text: 'Khôi phục mặc định',
                              size: AppButtonSize.xs,
                              variant: AppButtonVariant.outline,
                              icon: const Icon(LucideIcons.rotateCcw, size: 13),
                              onPressed: () => _handleResetSetting('approval_config', 'Quy tắc Phê duyệt (approval_config)'),
                            )
                          : null,
                    ),
                    Container(
                      padding: const EdgeInsets.all(14),
                      decoration: BoxDecoration(
                        color: AppColors.slate50,
                        borderRadius: BorderRadius.circular(10),
                        border: Border.all(color: AppColors.border),
                      ),
                      child: Row(
                        children: [
                          const Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(
                                  'Cho phép người tạo tự phê duyệt trong mô hình 1 nhân sự (allow_self_approval)',
                                  style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: AppColors.slate900),
                                ),
                                SizedBox(height: 4),
                                Text(
                                  'Mặc định tắt (Four-eyes nghiêm ngặt: người lập hồ sơ không được tự duyệt hợp đồng giá ưu đãi, phụ lục hay hoàn cọc). Khi bật tùy chọn này, thao tác sẽ được gắn nhãn SELF_APPROVAL_WARNING vào Nhật ký Kiểm toán.',
                                  style: TextStyle(fontSize: 11, color: AppColors.slate600),
                                ),
                              ],
                            ),
                          ),
                          Switch(
                            value: _approvalConfig['allow_self_approval'] == true,
                            onChanged: canManageUsers
                                ? (val) => setState(() => _approvalConfig['allow_self_approval'] = val)
                                : null,
                          ),
                        ],
                      ),
                    ),
                  ],
                ),
              ),
              const SizedBox(height: 20),

              // Operational settings grid: Billing, SLA, Contact
              Wrap(
                spacing: 20,
                runSpacing: 20,
                children: [
                  SizedBox(
                    width: 380,
                    child: AppCard(
                      padding: const EdgeInsets.all(20),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          AppCardHeader(
                            title: 'Chu kỳ Hóa đơn & Giá mặc định',
                            subtitle: 'Khóa cấu hình: billing_config',
                            action: canManageUsers
                                ? AppButton(
                                    text: 'Khôi phục',
                                    size: AppButtonSize.xs,
                                    variant: AppButtonVariant.outline,
                                    icon: const Icon(LucideIcons.rotateCcw, size: 12),
                                    onPressed: () => _handleResetSetting('billing_config', 'Chu kỳ Hóa đơn (billing_config)'),
                                  )
                                : null,
                          ),
                          AppInput(
                            label: 'Ngày chốt chỉ số & lập HĐ (1–31)',
                            initialValue: (_billingConfig['billing_day'] ?? 1).toString(),
                            enabled: canManageUsers,
                            keyboardType: TextInputType.number,
                            onChanged: (val) => _billingConfig['billing_day'] = val,
                          ),
                          const SizedBox(height: 12),
                          AppInput(
                            label: 'Thời hạn thanh toán (số ngày sau phát hành)',
                            initialValue: (_billingConfig['payment_due_days'] ?? 5).toString(),
                            enabled: canManageUsers,
                            keyboardType: TextInputType.number,
                            onChanged: (val) => _billingConfig['payment_due_days'] = val,
                          ),
                          const SizedBox(height: 12),
                          AppInput(
                            label: 'Các mốc ngày nhắc nợ tự động (cách nhau dấu phẩy)',
                            initialValue: _billingConfig['reminder_days_text']?.toString() ?? '3, 7, 15',
                            enabled: canManageUsers,
                            onChanged: (val) => _billingConfig['reminder_days_text'] = val,
                          ),
                          const SizedBox(height: 12),
                          AppInput(
                            label: 'Lãi phạt chậm thanh toán (% / tháng)',
                            initialValue: (_billingConfig['late_fee_percent'] ?? 0).toString(),
                            enabled: canManageUsers,
                            keyboardType: const TextInputType.numberWithOptions(decimal: true),
                            onChanged: (val) => _billingConfig['late_fee_percent'] = val,
                          ),
                          const SizedBox(height: 12),
                          MoneyInput(
                            label: 'Giá điện mặc định (₫/kWh)',
                            disabled: !canManageUsers,
                            value: _billingConfig['electricity_default_price'] ?? 3800,
                            onChanged: (val) => _billingConfig['electricity_default_price'] = int.tryParse(val.replaceAll(RegExp(r'\D'), '')) ?? 3800,
                          ),
                          const SizedBox(height: 12),
                          MoneyInput(
                            label: 'Giá nước mặc định (₫/m³)',
                            disabled: !canManageUsers,
                            value: _billingConfig['water_default_price'] ?? 22000,
                            onChanged: (val) => _billingConfig['water_default_price'] = int.tryParse(val.replaceAll(RegExp(r'\D'), '')) ?? 22000,
                          ),
                        ],
                      ),
                    ),
                  ),

                  SizedBox(
                    width: 380,
                    child: AppCard(
                      padding: const EdgeInsets.all(20),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          AppCardHeader(
                            title: 'Cam kết SLA Kỹ thuật',
                            subtitle: 'Khóa cấu hình: sla_config',
                            action: canManageUsers
                                ? AppButton(
                                    text: 'Khôi phục',
                                    size: AppButtonSize.xs,
                                    variant: AppButtonVariant.outline,
                                    icon: const Icon(LucideIcons.rotateCcw, size: 12),
                                    onPressed: () => _handleResetSetting('sla_config', 'Cam kết SLA (sla_config)'),
                                  )
                                : null,
                          ),
                          AppInput(
                            label: 'Thời gian tiếp nhận tối đa (giờ)',
                            initialValue: (_slaConfig['response_hours'] ?? 2).toString(),
                            enabled: canManageUsers,
                            keyboardType: TextInputType.number,
                            onChanged: (val) => _slaConfig['response_hours'] = val,
                          ),
                          const SizedBox(height: 12),
                          AppInput(
                            label: 'SLA xử lý sự cố KHẨN CẤP (giờ)',
                            initialValue: (_slaConfig['urgent_resolve_hours'] ?? 4).toString(),
                            enabled: canManageUsers,
                            keyboardType: TextInputType.number,
                            onChanged: (val) => _slaConfig['urgent_resolve_hours'] = val,
                          ),
                          const SizedBox(height: 12),
                          AppInput(
                            label: 'SLA xử lý sự cố THÔNG THƯỜNG (giờ)',
                            initialValue: (_slaConfig['normal_resolve_hours'] ?? 24).toString(),
                            enabled: canManageUsers,
                            keyboardType: TextInputType.number,
                            onChanged: (val) => _slaConfig['normal_resolve_hours'] = val,
                          ),
                          const SizedBox(height: 12),
                          AppInput(
                            label: 'Thời hạn hoàn trả cọc sau thanh lý (ngày)',
                            initialValue: (_slaConfig['deposit_refund_days'] ?? 5).toString(),
                            enabled: canManageUsers,
                            keyboardType: TextInputType.number,
                            onChanged: (val) => _slaConfig['deposit_refund_days'] = val,
                          ),
                        ],
                      ),
                    ),
                  ),

                  SizedBox(
                    width: 380,
                    child: AppCard(
                      padding: const EdgeInsets.all(20),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          AppCardHeader(
                            title: 'Danh bạ Ban Quản Lý',
                            subtitle: 'Khóa cấu hình: contact_config',
                            action: canManageUsers
                                ? AppButton(
                                    text: 'Khôi phục',
                                    size: AppButtonSize.xs,
                                    variant: AppButtonVariant.outline,
                                    icon: const Icon(LucideIcons.rotateCcw, size: 12),
                                    onPressed: () => _handleResetSetting('contact_config', 'Danh bạ BQL (contact_config)'),
                                  )
                                : null,
                          ),
                          AppInput(
                            label: 'Khung giờ làm việc',
                            initialValue: _contactConfig['working_hours']?.toString() ?? '',
                            enabled: canManageUsers,
                            onChanged: (val) => _contactConfig['working_hours'] = val,
                          ),
                          const SizedBox(height: 12),
                          AppInput(
                            label: 'Hotline Kỹ thuật / Bảo trì',
                            initialValue: _contactConfig['technical_hotline']?.toString() ?? '',
                            enabled: canManageUsers,
                            onChanged: (val) => _contactConfig['technical_hotline'] = val,
                          ),
                          const SizedBox(height: 12),
                          AppInput(
                            label: 'Hotline An ninh / Trực bảo vệ 24/7',
                            initialValue: _contactConfig['security_hotline']?.toString() ?? '',
                            enabled: canManageUsers,
                            onChanged: (val) => _contactConfig['security_hotline'] = val,
                          ),
                          const SizedBox(height: 12),
                          AppInput(
                            label: 'Số điện thoại khẩn cấp / PCCC',
                            initialValue: _contactConfig['emergency_phone']?.toString() ?? '',
                            enabled: canManageUsers,
                            onChanged: (val) => _contactConfig['emergency_phone'] = val,
                          ),
                          const SizedBox(height: 12),
                          AppInput(
                            label: 'Email tiếp nhận hỗ trợ cư dân',
                            initialValue: _contactConfig['support_email']?.toString() ?? '',
                            enabled: canManageUsers,
                            keyboardType: TextInputType.emailAddress,
                            onChanged: (val) => _contactConfig['support_email'] = val,
                          ),
                        ],
                      ),
                    ),
                  ),
                ],
              ),
              ],
            ],

            // TAB 3: AUDIT
            if (_activeTab == 'audit') ...[
              const AuditLogsView(),
            ],
          ],
        ),
      ),
    );
  }
}
