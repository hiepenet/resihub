import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../../../core/theme/app_colors.dart';
import '../../../core/utils/ai_helpers.dart';
import '../../../core/utils/deposit_ui_helpers.dart';
import '../../../core/utils/format.dart';
import '../../../core/utils/validation.dart';
import '../../../shared/providers/toast_provider.dart';
import '../../../shared/widgets/common/confirm_dialog.dart';
import '../../../shared/widgets/common/page_header.dart';
import '../../../shared/widgets/ui/app_badge.dart';
import '../../../shared/widgets/ui/app_button.dart';
import '../../../shared/widgets/ui/app_card.dart';
import '../../../shared/widgets/ui/app_input.dart';
import '../../../shared/widgets/ui/app_select.dart';
import '../../../shared/widgets/ui/app_skeleton.dart';
import '../../../shared/widgets/ui/money_input.dart';
import '../../auth/providers/permission_provider.dart';
import '../../buildings/services/buildings_service.dart';
import '../../users/services/users_service.dart';
import '../widgets/ai_gateway_config_card.dart';

const Map<String, dynamic> kDefaultBillingConfig = {
  'billing_day': 1,
  'payment_due_days': 5,
  'due_date_offset_days': 5,
  'late_fee_grace_days': 5,
  'late_fee_per_day': 100000,
  'late_fee_cap': '',
  'meter_anomaly_threshold_pct': 30,
  'reminder_days_text': '3, 7, 15',
  'late_fee_percent': 0,
  'electricity_default_price': 3800,
  'water_default_price': 22000,
};

const Map<String, dynamic> kDefaultSlaConfig = {
  'response_hours': 2,
  'urgent_resolve_hours': 4,
  'normal_resolve_hours': 24,
  'deposit_refund_days': 5,
  'reopen_window_days': 3,
};

const Map<String, dynamic> kDefaultContactConfig = {
  'working_hours': '08:00 – 18:00 (Thứ 2 – Thứ 7)',
  'technical_hotline': '1900 6868',
  'security_hotline': '1900 9119',
  'emergency_phone': '0909 113 114',
  'support_email': 'support@resihub.vn',
};

/// JS `Math.min(max, Math.max(min, parsed))` — parse thất bại thì dùng [fallback].
int clampSettingInt(dynamic raw, int fallback, int min, [int? max]) {
  final parsed = int.tryParse(raw?.toString() ?? '');
  if (parsed == null) return fallback;
  var value = parsed < min ? min : parsed;
  if (max != null && value > max) value = max;
  return value;
}

/// Payload `updateSettings`, khớp key / kiểu / clamp / fallback của React `handleSave`.
Map<String, dynamic> buildSystemSettingsPayload({
  required Map<String, dynamic> billing,
  required Map<String, dynamic> sla,
  required Map<String, dynamic> contact,
  required Map<String, dynamic> approval,
  required Map<String, dynamic> reservation,
  required Map<String, dynamic> ai,
}) {
  final reminderDays = billing['reminder_days_text']
      .toString()
      .split(',')
      .map((x) => int.tryParse(x.trim()))
      .where((n) => n != null && n > 0)
      .cast<int>()
      .toList();

  final due = clampSettingInt(
    billing['due_date_offset_days'] ?? billing['payment_due_days'],
    5,
    1,
    60,
  );
  final capRaw = billing['late_fee_cap'];
  final capNum = num.tryParse(capRaw?.toString() ?? '');
  final lateFeeCap = (capRaw != null && capNum != null && capNum > 0)
      ? capNum.round()
      : null;

  return {
    'billing_config': {
      'billing_day': clampSettingInt(billing['billing_day'], 1, 1, 31),
      'payment_due_days': due,
      'due_date_offset_days': due,
      'late_fee_grace_days':
          clampSettingInt(billing['late_fee_grace_days'], 5, 0, 60),
      'late_fee_per_day':
          clampSettingInt(billing['late_fee_per_day'], 100000, 0),
      'late_fee_cap': lateFeeCap,
      'meter_anomaly_threshold_pct':
          clampSettingInt(billing['meter_anomaly_threshold_pct'], 30, 1, 500),
      'reminder_days': reminderDays.isNotEmpty ? reminderDays : [3, 7, 15],
      'late_fee_percent': clampSettingInt(billing['late_fee_percent'], 0, 0),
      'electricity_default_price':
          clampSettingInt(billing['electricity_default_price'], 3800, 0),
      'water_default_price':
          clampSettingInt(billing['water_default_price'], 22000, 0),
    },
    'sla_config': {
      'response_hours': clampSettingInt(sla['response_hours'], 2, 1),
      'urgent_resolve_hours': clampSettingInt(sla['urgent_resolve_hours'], 4, 1),
      'normal_resolve_hours': clampSettingInt(sla['normal_resolve_hours'], 24, 1),
      'deposit_refund_days': clampSettingInt(sla['deposit_refund_days'], 5, 1),
      'reopen_window_days': clampSettingInt(sla['reopen_window_days'], 3, 1),
    },
    'contact_config': {
      'working_hours': contact['working_hours']?.toString().trim() ?? '',
      'technical_hotline': contact['technical_hotline']?.toString().trim() ?? '',
      'security_hotline': contact['security_hotline']?.toString().trim() ?? '',
      'emergency_phone': contact['emergency_phone']?.toString().trim() ?? '',
      'support_email': contact['support_email']?.toString().trim() ?? '',
    },
    'approval_config': {
      'allow_self_approval': approval['allow_self_approval'] == true,
    },
    'reservation_cancel_policy': {
      'max_hold_days': clampSettingInt(reservation['max_hold_days'], 30, 1, 90),
      'public_max_hold_days':
          clampSettingInt(reservation['public_max_hold_days'], 7, 1, 30),
      'full_refund_before_days':
          clampSettingInt(reservation['full_refund_before_days'], 3, 0, 30),
      'partial_refund_pct':
          clampSettingInt(reservation['partial_refund_pct'], 50, 0, 100),
      'default_hold_amount':
          clampSettingInt(reservation['default_hold_amount'], 2000000, 0),
    },
    'ai_config': {
      ...ai,
      'monthly_budget_vnd': clampSettingInt(ai['monthly_budget_vnd'], 0, 0),
      'monthly_token_limit':
          clampSettingInt(ai['monthly_token_limit'], 5000000, 10000),
      'ocr_threshold':
          double.tryParse(ai['ocr_threshold']?.toString() ?? '') ?? 0.85,
      'extract_threshold':
          double.tryParse(ai['extract_threshold']?.toString() ?? '') ?? 0.75,
      'triage_threshold':
          double.tryParse(ai['triage_threshold']?.toString() ?? '') ?? 0.65,
    },
  };
}

/// System Settings & Automated Cron Jobs Monitoring Page.
/// Root widget has `key: const Key('route:/admin/settings')` for route testing.
class SettingsPage extends ConsumerStatefulWidget {
  const SettingsPage({super.key});

  @override
  ConsumerState<SettingsPage> createState() => _SettingsPageState();
}

class _SettingsPageState extends ConsumerState<SettingsPage> {
  bool _loading = true;
  bool _saving = false;
  bool _resettingSetting = false;

  Map<String, dynamic> _billingConfig = Map<String, dynamic>.from(kDefaultBillingConfig);
  Map<String, dynamic> _slaConfig = Map<String, dynamic>.from(kDefaultSlaConfig);
  Map<String, dynamic> _contactConfig = Map<String, dynamic>.from(kDefaultContactConfig);
  Map<String, dynamic> _approvalConfig = {'allow_self_approval': false};
  Map<String, dynamic> _reservationCancelPolicy = Map<String, dynamic>.from(kDefaultReservationCancelPolicy);
  Map<String, dynamic> _aiConfig = Map<String, dynamic>.from(kDefaultAiConfig);
  bool _aiKeyConfigured = false;

  // Cron state
  List<Map<String, dynamic>> _cronRuns = [];
  bool _cronLoading = false;
  bool _triggeringCron = false;
  bool _allowCustomDate = false;
  String _cronAsOfDate = '';
  String _cronBuildingId = '';
  List<Map<String, dynamic>> _buildings = [];

  // Deep link ?modal=ai|cron → modal cảnh báo hệ thống (tương đương effect trong React).
  bool _deepLinkHandled = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _fetchSettings();
      _fetchCronRuns();
    });
  }

  Future<void> _fetchSettings() async {
    setState(() => _loading = true);
    try {
      final usersService = ref.read(usersServiceProvider);
      final res = await usersService.getSettings();
      final data = res is Map && res['data'] is Map ? res['data'] as Map : (res is Map ? res : {});

      if (mounted) {
        setState(() {
          if (data['billing_config'] is Map) {
            final bc = data['billing_config'] as Map;
            final resolvedDue = bc['due_date_offset_days'] ?? bc['payment_due_days'] ?? 5;
            _billingConfig = {
              ...kDefaultBillingConfig,
              ...Map<String, dynamic>.from(bc),
              'payment_due_days': resolvedDue,
              'due_date_offset_days': resolvedDue,
              'reminder_days_text': bc['reminder_days'] is List ? (bc['reminder_days'] as List).join(', ') : '3, 7, 15',
            };
          }
          if (data['sla_config'] is Map) {
            _slaConfig = {
              ...kDefaultSlaConfig,
              ...Map<String, dynamic>.from(data['sla_config'] as Map),
            };
          }
          if (data['contact_config'] is Map) {
            _contactConfig = {
              ...kDefaultContactConfig,
              ...Map<String, dynamic>.from(data['contact_config'] as Map),
            };
          }
          if (data['approval_config'] is Map) {
            _approvalConfig = {
              'allow_self_approval': (data['approval_config'] as Map)['allow_self_approval'] == true,
            };
          }
          if (data['reservation_cancel_policy'] is Map) {
            _reservationCancelPolicy = {
              ...kDefaultReservationCancelPolicy,
              ...Map<String, dynamic>.from(data['reservation_cancel_policy'] as Map),
            };
          }
          if (data['ai_config'] is Map) {
            _aiConfig = mergeAiConfigState(Map<String, dynamic>.from(data['ai_config'] as Map));
          }
          final aiRuntime = res is Map ? res['ai_runtime'] : null;
          _aiKeyConfigured = aiRuntime is Map && aiRuntime['api_key_configured'] == true;
          _loading = false;
        });
        _maybeOpenDeepLinkModal();
      }
    } catch (err) {
      if (mounted) {
        ref.read(toastProvider.notifier).error(
              extractErrorMessage(err, 'Không thể tải cấu hình hệ thống.'),
            );
        setState(() => _loading = false);
        _maybeOpenDeepLinkModal();
      }
    }
  }

  Future<void> _fetchCronRuns() async {
    final permissions = ref.read(permissionProvider);
    if (!permissions.isSysAdmin) return;

    setState(() => _cronLoading = true);
    try {
      final usersService = ref.read(usersServiceProvider);
      final buildingsService = ref.read(buildingsServiceProvider);

      final cronRes = await usersService.listCronRuns({'limit': 10}).catchError((_) => null);
      final bldgRes = await buildingsService.list().catchError((_) => null);

      if (mounted) {
        setState(() {
          if (cronRes is Map) {
            final payload = cronRes['data'];
            if (payload is List) {
              _cronRuns = payload.whereType<Map>().map((e) => Map<String, dynamic>.from(e)).toList();
            }
            _allowCustomDate = cronRes['allow_custom_date'] == true;
            if (cronRes['today_vn'] != null && _cronAsOfDate.isEmpty) {
              _cronAsOfDate = cronRes['today_vn'].toString();
            }
          }

          if (bldgRes is Map && bldgRes['data'] is List) {
            _buildings = (bldgRes['data'] as List).whereType<Map>().map((e) => Map<String, dynamic>.from(e)).toList();
          } else if (bldgRes is List) {
            _buildings = bldgRes.whereType<Map>().map((e) => Map<String, dynamic>.from(e)).toList();
          }
          _cronLoading = false;
        });
        _maybeOpenDeepLinkModal();
      }
    } catch (_) {
      if (mounted) {
        setState(() => _cronLoading = false);
        _maybeOpenDeepLinkModal();
      }
    }
  }

  /// Đọc `?modal=ai|cron` ngay trong widget (không sửa router), mở modal khi
  /// dữ liệu đã tải xong — khớp effect ở `SettingsPage.jsx:132-140`.
  void _maybeOpenDeepLinkModal() {
    if (!mounted || _deepLinkHandled) return;
    final router = GoRouter.maybeOf(context);
    if (router == null) return;
    final modal = GoRouterState.of(context).uri.queryParameters['modal'];
    if (modal != 'ai' && modal != 'cron') return;
    if (_loading) return;
    if (modal == 'cron' && _cronLoading) return;
    if (!ref.read(permissionProvider).isSysAdmin) return;

    setState(() => _deepLinkHandled = true);
    showDialog<void>(
      context: context,
      builder: (_) => AlertDialog(
        title: Text(modal == 'ai'
            ? 'Cảnh báo Ngân sách & Trạng thái AI Gateway'
            : 'Chi tiết Cảnh báo Tiến trình Tự động Hằng ngày (Cron)'),
        content: modal == 'ai'
            ? Text(
                'Trạng thái cổng AI: ${_aiConfig['enabled'] == true ? 'Đang bật' : 'Đang tắt'}\n'
                'Ngân sách trần / tháng: ${formatMoney(_aiConfig['monthly_budget_vnd'] ?? 0)}\n'
                'API Key: ${_aiKeyConfigured ? 'Đã cấu hình' : 'Chưa cấu hình'}',
              )
            : Text(
                _cronRuns.isEmpty
                    ? 'Chưa có bản ghi thực thi tiến trình nào.'
                    : 'Ngày đối soát: ${formatDate(_cronRuns.first['run_date'])} • '
                        'Lần thử: ${_cronRuns.first['attempt_count'] ?? 1}',
              ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(),
            child: const Text('Đóng'),
          ),
          if (modal == 'cron')
            FilledButton(
              onPressed: () async {
                final navigator = Navigator.of(context);
                await _handleTriggerCron();
                if (mounted) navigator.pop();
              },
              child: const Text('Chạy lại tiến trình ngay'),
            ),
        ],
      ),
    );
  }

  Future<void> _handleTriggerCron() async {
    final permissions = ref.read(permissionProvider);
    if (!permissions.isSysAdmin) return;

    setState(() => _triggeringCron = true);
    try {
      final usersService = ref.read(usersServiceProvider);
      final payload = <String, dynamic>{
        if (_allowCustomDate && _cronAsOfDate.isNotEmpty) 'as_of_date': _cronAsOfDate,
        if (_cronBuildingId.isNotEmpty) 'building_id': _cronBuildingId,
      };

      final res = await usersService.triggerCronRun(payload);
      final msg = res is Map && res['message'] != null ? res['message'].toString() : 'Đã thực thi tiến trình tự động hằng ngày thành công.';
      if (mounted) {
        ref.read(toastProvider.notifier).success(msg);
      }
      await _fetchCronRuns();
    } catch (err) {
      if (mounted) {
        ref.read(toastProvider.notifier).error(
              extractErrorMessage(err, 'Không thể kích hoạt tiến trình tự động hằng ngày.'),
            );
      }
      await _fetchCronRuns();
    } finally {
      if (mounted) {
        setState(() => _triggeringCron = false);
      }
    }
  }

  Future<void> _handleSave() async {
    setState(() => _saving = true);
    try {
      final usersService = ref.read(usersServiceProvider);

      final payload = buildSystemSettingsPayload(
        billing: _billingConfig,
        sla: _slaConfig,
        contact: _contactConfig,
        approval: _approvalConfig,
        reservation: _reservationCancelPolicy,
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
        setState(() => _saving = false);
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
          } else if (key == 'reservation_cancel_policy') {
            _reservationCancelPolicy = {
              ...kDefaultReservationCancelPolicy,
              if (def != null) ...Map<String, dynamic>.from(def),
            };
          } else if (key == 'billing_config') {
            final resolvedDue = def?['due_date_offset_days'] ?? def?['payment_due_days'] ?? 5;
            final capRaw = def?['late_fee_cap'];
            final capNum = num.tryParse(capRaw?.toString() ?? '');
            _billingConfig = {
              ...kDefaultBillingConfig,
              if (def != null) ...Map<String, dynamic>.from(def),
              'payment_due_days': resolvedDue,
              'due_date_offset_days': resolvedDue,
              'late_fee_cap': (capRaw != null && capNum != null && capNum > 0)
                  ? capRaw
                  : '',
              'reminder_days_text': def != null && def['reminder_days'] is List
                  ? (def['reminder_days'] as List).join(', ')
                  : kDefaultBillingConfig['reminder_days_text'],
            };
          } else if (key == 'sla_config') {
            _slaConfig = {
              ...kDefaultSlaConfig,
              if (def != null) ...Map<String, dynamic>.from(def),
            };
          } else if (key == 'contact_config') {
            _contactConfig = {
              ...kDefaultContactConfig,
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
    final canEdit = permissions.isSysAdmin;

    return Scaffold(
      key: const Key('route:/admin/settings'),
      body: SingleChildScrollView(
        padding: const EdgeInsets.all(24),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            PageHeader(
              title: 'Cấu hình Hệ thống',
              subtitle: 'Thiết lập quy tắc phê duyệt nội bộ (Four-eyes), chính sách giữ chỗ, chu kỳ hóa đơn, SLA kỹ thuật và thông tin liên hệ Ban Quản Lý.',
              actions: canEdit
                  ? AppButton(
                      text: 'Lưu cấu hình hệ thống',
                      variant: AppButtonVariant.primary,
                      icon: const Icon(LucideIcons.save, size: 16),
                      loading: _saving,
                      onPressed: _handleSave,
                    )
                  : null,
            ),
            const SizedBox(height: 16),

            if (_loading)
              const AppSkeleton(height: 400)
            else ...[
              // AI Gateway Card
              AiGatewayConfigCard(
                aiConfig: _aiConfig,
                onChange: (val) => setState(() => _aiConfig = val),
                apiKeyConfigured: _aiKeyConfigured,
                canEdit: canEdit,
                resetting: _resettingSetting,
                onReset: canEdit ? () => _handleResetSetting('ai_config', 'Cổng Trợ lý AI (ai_config)') : null,
              ),
              const SizedBox(height: 20),

              // Four-eyes Rule Card (R-23)
              AppCard(
                padding: const EdgeInsets.all(20),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    AppCardHeader(
                      title: 'Quy tắc Phê duyệt Nội bộ (Four-eyes)',
                      subtitle: 'Khóa cấu hình: approval_config',
                      action: canEdit
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
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                const Row(
                                  children: [
                                    Icon(LucideIcons.shieldCheck, size: 16, color: AppColors.primary600),
                                    SizedBox(width: 8),
                                    Expanded(
                                      child: Text(
                                        'Cho phép người tạo tự phê duyệt trong mô hình 1 nhân sự (allow_self_approval)',
                                        style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: AppColors.slate900),
                                      ),
                                    ),
                                  ],
                                ),
                                const SizedBox(height: 4),
                                const Text(
                                  'Mặc định tắt (Four-eyes nghiêm ngặt: người lập hồ sơ không được tự duyệt hợp đồng giá ưu đãi, phụ lục hay hoàn cọc). Khi bật tùy chọn này, thao tác sẽ được gắn nhãn SELF_APPROVAL_WARNING vào Nhật ký Kiểm toán.',
                                  style: TextStyle(fontSize: 11, color: AppColors.slate600),
                                ),
                              ],
                            ),
                          ),
                          Switch(
                            value: _approvalConfig['allow_self_approval'] == true,
                            onChanged: canEdit
                                ? (val) => setState(() => _approvalConfig['allow_self_approval'] = val)
                                : null,
                          ),
                        ],
                      ),
                    ),
                    if (_approvalConfig['allow_self_approval'] == true) ...[
                      const SizedBox(height: 10),
                      Container(
                        padding: const EdgeInsets.all(12),
                        decoration: BoxDecoration(
                          color: AppColors.amber50,
                          borderRadius: BorderRadius.circular(10),
                          border: Border.all(color: AppColors.amber300),
                        ),
                        child: const Row(
                          children: [
                            Icon(LucideIcons.triangleAlert, size: 16, color: AppColors.amber600),
                            SizedBox(width: 8),
                            Expanded(
                              child: Text(
                                'Chế độ cho phép tự phê duyệt đang BẬT. Mọi thao tác tự phê duyệt sẽ gắn nhãn cảnh báo SELF_APPROVAL_WARNING để Chủ đầu tư và Quản trị viên hậu kiểm.',
                                style: TextStyle(fontSize: 11, color: AppColors.amber900),
                              ),
                            ),
                          ],
                        ),
                      ),
                    ],
                  ],
                ),
              ),
              const SizedBox(height: 20),

              // Reservation Cancel Policy Card
              AppCard(
                padding: const EdgeInsets.all(20),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    AppCardHeader(
                      title: 'Chính sách Đặt cọc Giữ chỗ (FR-005 / FR-067)',
                      subtitle: 'Khóa cấu hình: reservation_cancel_policy',
                      action: canEdit
                          ? AppButton(
                              text: 'Khôi phục mặc định',
                              size: AppButtonSize.xs,
                              variant: AppButtonVariant.outline,
                              icon: const Icon(LucideIcons.rotateCcw, size: 13),
                              onPressed: () => _handleResetSetting('reservation_cancel_policy', 'Chính sách Giữ chỗ (reservation_cancel_policy)'),
                            )
                          : null,
                    ),
                    Wrap(
                      spacing: 16,
                      runSpacing: 16,
                      children: [
                        SizedBox(
                          width: 300,
                          child: MoneyInput(
                            label: 'Mức cọc giữ chỗ mặc định (VND)',
                            disabled: !canEdit,
                            value: _reservationCancelPolicy['default_hold_amount'] ?? 2000000,
                            onChanged: (val) => _reservationCancelPolicy['default_hold_amount'] = int.tryParse(val.replaceAll(RegExp(r'\D'), '')) ?? 2000000,
                          ),
                        ),
                        SizedBox(
                          width: 180,
                          child: AppInput(
                            label: 'Tối đa giữ chỗ nội bộ (ngày)',
                            placeholder: '30',
                            initialValue: (_reservationCancelPolicy['max_hold_days'] ?? 30).toString(),
                            enabled: canEdit,
                            onChanged: (val) => _reservationCancelPolicy['max_hold_days'] = int.tryParse(val) ?? 30,
                          ),
                        ),
                        SizedBox(
                          width: 180,
                          child: AppInput(
                            label: 'Tối đa giữ chỗ Online (ngày)',
                            placeholder: '7',
                            initialValue: (_reservationCancelPolicy['public_max_hold_days'] ?? 7).toString(),
                            enabled: canEdit,
                            onChanged: (val) => _reservationCancelPolicy['public_max_hold_days'] = int.tryParse(val) ?? 7,
                          ),
                        ),
                        SizedBox(
                          width: 180,
                          child: AppInput(
                            label: 'Mốc hủy hoàn 100% (trước ≥ X ngày)',
                            placeholder: '3',
                            initialValue: (_reservationCancelPolicy['full_refund_before_days'] ?? 3).toString(),
                            enabled: canEdit,
                            onChanged: (val) => _reservationCancelPolicy['full_refund_before_days'] = int.tryParse(val) ?? 3,
                          ),
                        ),
                        SizedBox(
                          width: 180,
                          child: AppInput(
                            label: 'Tỷ lệ hoàn sát hạn (%)',
                            placeholder: '50',
                            initialValue: (_reservationCancelPolicy['partial_refund_pct'] ?? 50).toString(),
                            enabled: canEdit,
                            onChanged: (val) => _reservationCancelPolicy['partial_refund_pct'] = int.tryParse(val) ?? 50,
                          ),
                        ),
                      ],
                    ),
                  ],
                ),
              ),
              const SizedBox(height: 20),

              // 3 Config Cards: Billing, SLA, Contact
              Wrap(
                spacing: 20,
                runSpacing: 20,
                children: [
                  // Billing Card
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
                            action: canEdit
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
                            label: 'Ngày chốt chỉ số & lập hóa đơn (1–31)',
                            initialValue: (_billingConfig['billing_day'] ?? 1).toString(),
                            enabled: canEdit,
                            onChanged: (val) => _billingConfig['billing_day'] = int.tryParse(val) ?? 1,
                          ),
                          const SizedBox(height: 12),
                          Row(
                            children: [
                              Expanded(
                                child: AppInput(
                                  label: 'Hạn thanh toán (ngày)',
                                  initialValue: (_billingConfig['due_date_offset_days'] ?? 5).toString(),
                                  enabled: canEdit,
                                  onChanged: (val) => _billingConfig['due_date_offset_days'] = int.tryParse(val) ?? 5,
                                ),
                              ),
                              const SizedBox(width: 12),
                              Expanded(
                                child: AppInput(
                                  label: 'Ân hạn phạt chậm (ngày)',
                                  initialValue: (_billingConfig['late_fee_grace_days'] ?? 5).toString(),
                                  enabled: canEdit,
                                  onChanged: (val) => _billingConfig['late_fee_grace_days'] = int.tryParse(val) ?? 5,
                                ),
                              ),
                            ],
                          ),
                          const SizedBox(height: 12),
                          MoneyInput(
                            label: 'Phạt chậm (₫/ngày)',
                            disabled: !canEdit,
                            value: _billingConfig['late_fee_per_day'] ?? 100000,
                            onChanged: (val) => _billingConfig['late_fee_per_day'] = int.tryParse(val.replaceAll(RegExp(r'\D'), '')) ?? 100000,
                          ),
                          const SizedBox(height: 12),
                          MoneyInput(
                            label: 'Trần phạt tối đa (₫)',
                            disabled: !canEdit,
                            value: _billingConfig['late_fee_cap'] ?? '',
                            onChanged: (val) => _billingConfig['late_fee_cap'] = val.replaceAll(RegExp(r'\D'), ''),
                          ),
                          const SizedBox(height: 12),
                          Row(
                            children: [
                              Expanded(
                                child: AppInput(
                                  label: 'Ngưỡng cảnh báo chỉ số (%)',
                                  initialValue: (_billingConfig['meter_anomaly_threshold_pct'] ?? 30).toString(),
                                  enabled: canEdit,
                                  onChanged: (val) => _billingConfig['meter_anomaly_threshold_pct'] = int.tryParse(val) ?? 30,
                                ),
                              ),
                              const SizedBox(width: 12),
                              Expanded(
                                child: AppInput(
                                  label: 'Mốc ngày nhắc nợ (dấu phẩy)',
                                  initialValue: _billingConfig['reminder_days_text']?.toString() ?? '',
                                  enabled: canEdit,
                                  onChanged: (val) => _billingConfig['reminder_days_text'] = val,
                                ),
                              ),
                            ],
                          ),
                          const SizedBox(height: 12),
                          MoneyInput(
                            label: 'Giá điện mặc định (₫/kWh)',
                            disabled: !canEdit,
                            value: _billingConfig['electricity_default_price'] ?? 3800,
                            onChanged: (val) => _billingConfig['electricity_default_price'] = int.tryParse(val.replaceAll(RegExp(r'\D'), '')) ?? 3800,
                          ),
                          const SizedBox(height: 12),
                          MoneyInput(
                            label: 'Giá nước mặc định (₫/m³)',
                            disabled: !canEdit,
                            value: _billingConfig['water_default_price'] ?? 22000,
                            onChanged: (val) => _billingConfig['water_default_price'] = int.tryParse(val.replaceAll(RegExp(r'\D'), '')) ?? 22000,
                          ),
                        ],
                      ),
                    ),
                  ),

                  // SLA Card
                  SizedBox(
                    width: 380,
                    child: AppCard(
                      padding: const EdgeInsets.all(20),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          AppCardHeader(
                            title: 'Cam kết SLA Kỹ thuật & Hoàn cọc',
                            subtitle: 'Khóa cấu hình: sla_config',
                            action: canEdit
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
                            enabled: canEdit,
                            onChanged: (val) => _slaConfig['response_hours'] = int.tryParse(val) ?? 2,
                          ),
                          const SizedBox(height: 12),
                          AppInput(
                            label: 'SLA xử lý sự cố KHẨN CẤP (giờ)',
                            initialValue: (_slaConfig['urgent_resolve_hours'] ?? 4).toString(),
                            enabled: canEdit,
                            onChanged: (val) => _slaConfig['urgent_resolve_hours'] = int.tryParse(val) ?? 4,
                          ),
                          const SizedBox(height: 12),
                          AppInput(
                            label: 'SLA xử lý sự cố THÔNG THƯỜNG (giờ)',
                            initialValue: (_slaConfig['normal_resolve_hours'] ?? 24).toString(),
                            enabled: canEdit,
                            onChanged: (val) => _slaConfig['normal_resolve_hours'] = int.tryParse(val) ?? 24,
                          ),
                          const SizedBox(height: 12),
                          AppInput(
                            label: 'Thời hạn hoàn trả tiền cọc (ngày)',
                            initialValue: (_slaConfig['deposit_refund_days'] ?? 5).toString(),
                            enabled: canEdit,
                            onChanged: (val) => _slaConfig['deposit_refund_days'] = int.tryParse(val) ?? 5,
                          ),
                          const SizedBox(height: 12),
                          AppInput(
                            label: 'Số ngày cho phép cư dân mở lại yêu cầu sau khi hoàn tất (ngày)',
                            initialValue: (_slaConfig['reopen_window_days'] ?? 3).toString(),
                            enabled: canEdit,
                            onChanged: (val) => _slaConfig['reopen_window_days'] = int.tryParse(val) ?? 3,
                          ),
                        ],
                      ),
                    ),
                  ),

                  // Contact Card
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
                            action: canEdit
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
                            label: 'Khung giờ làm việc hành chính',
                            initialValue: _contactConfig['working_hours']?.toString() ?? '',
                            enabled: canEdit,
                            onChanged: (val) => _contactConfig['working_hours'] = val,
                          ),
                          const SizedBox(height: 12),
                          AppInput(
                            label: 'Hotline Kỹ thuật / Bảo trì',
                            initialValue: _contactConfig['technical_hotline']?.toString() ?? '',
                            enabled: canEdit,
                            onChanged: (val) => _contactConfig['technical_hotline'] = val,
                          ),
                          const SizedBox(height: 12),
                          AppInput(
                            label: 'Hotline An ninh / Trực bảo vệ 24/7',
                            initialValue: _contactConfig['security_hotline']?.toString() ?? '',
                            enabled: canEdit,
                            onChanged: (val) => _contactConfig['security_hotline'] = val,
                          ),
                          const SizedBox(height: 12),
                          AppInput(
                            label: 'Số điện thoại khẩn cấp / PCCC',
                            initialValue: _contactConfig['emergency_phone']?.toString() ?? '',
                            enabled: canEdit,
                            onChanged: (val) => _contactConfig['emergency_phone'] = val,
                          ),
                          const SizedBox(height: 12),
                          AppInput(
                            label: 'Email tiếp nhận hỗ trợ cư dân',
                            initialValue: _contactConfig['support_email']?.toString() ?? '',
                            enabled: canEdit,
                            onChanged: (val) => _contactConfig['support_email'] = val,
                          ),
                        ],
                      ),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 20),

              // Daily Automated Cron Jobs Monitoring Card (FR-066 / FR-064 / PRD 14.5)
              if (canEdit) ...[
                AppCard(
                  padding: const EdgeInsets.all(20),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      AppCardHeader(
                        title: 'Tiến trình Tự động Hằng ngày (Cron 00:05 — FR-066 / FR-064)',
                        subtitle: 'Tự động sinh hóa đơn nháp theo billing_day, chuyển quá hạn (OVERDUE) & cộng phạt chậm thanh toán với khóa pg_try_advisory_lock(73918205)',
                        action: AppButton(
                          text: 'Làm mới nhật ký',
                          size: AppButtonSize.xs,
                          variant: AppButtonVariant.outline,
                          icon: const Icon(LucideIcons.refreshCw, size: 13),
                          loading: _cronLoading,
                          onPressed: _fetchCronRuns,
                        ),
                      ),
                      Container(
                        padding: const EdgeInsets.all(14),
                        decoration: BoxDecoration(
                          color: AppColors.slate50,
                          borderRadius: BorderRadius.circular(10),
                          border: Border.all(color: AppColors.border),
                        ),
                        child: Wrap(
                          spacing: 12,
                          runSpacing: 12,
                          crossAxisAlignment: WrapCrossAlignment.center,
                          children: [
                            SizedBox(
                              width: 240,
                              child: AppSelect<String>(
                                label: 'Phạm vi tòa nhà',
                                value: _cronBuildingId,
                                options: [
                                  const AppSelectOption(value: '', label: 'Tất cả tòa nhà'),
                                  ..._buildings.map(
                                    (b) => AppSelectOption(
                                      value: b['id'].toString(),
                                      label: '${b['code']} — ${b['name']}',
                                    ),
                                  ),
                                ],
                                onChanged: (val) => setState(() => _cronBuildingId = val ?? ''),
                              ),
                            ),
                            SizedBox(
                              width: 200,
                              child: AppInput(
                                label: _allowCustomDate ? 'Ngày đối soát (as_of_date)' : 'Ngày đối soát hiện tại',
                                placeholder: 'YYYY-MM-DD',
                                initialValue: _cronAsOfDate,
                                enabled: _allowCustomDate,
                                onChanged: (val) => _cronAsOfDate = val,
                              ),
                            ),
                            Padding(
                              padding: const EdgeInsets.only(top: 20),
                              child: AppButton(
                                text: 'Chạy đồng bộ ngay',
                                variant: AppButtonVariant.primary,
                                icon: const Icon(LucideIcons.play, size: 15),
                                loading: _triggeringCron,
                                onPressed: _handleTriggerCron,
                              ),
                            ),
                          ],
                        ),
                      ),
                      const SizedBox(height: 16),

                      // Cron Runs list
                      if (_cronRuns.isEmpty)
                        const Padding(
                          padding: EdgeInsets.all(16.0),
                          child: Center(
                            child: Text(
                              'Chưa có bản ghi thực thi tiến trình tự động nào.',
                              style: TextStyle(fontSize: 12, color: AppColors.slate400),
                            ),
                          ),
                        )
                      else
                        LayoutBuilder(
                          builder: (context, constraints) {
                            final minWidth = constraints.maxWidth.isFinite ? constraints.maxWidth : 600.0;
                            return SingleChildScrollView(
                              scrollDirection: Axis.horizontal,
                              child: ConstrainedBox(
                                constraints: BoxConstraints(minWidth: minWidth),
                                child: DataTable(
                            columns: const [
                              DataColumn(label: Text('Ngày đối soát', style: TextStyle(fontWeight: FontWeight.w600))),
                              DataColumn(label: Text('Trạng thái', style: TextStyle(fontWeight: FontWeight.w600))),
                              DataColumn(label: Text('Lần thử / Thời lượng', style: TextStyle(fontWeight: FontWeight.w600))),
                              DataColumn(label: Text('Kết quả tổng hợp', style: TextStyle(fontWeight: FontWeight.w600))),
                              DataColumn(label: Text('Thời điểm chạy', style: TextStyle(fontWeight: FontWeight.w600))),
                            ],
                            rows: _cronRuns.map((run) {
                              final st = (run['status'] ?? '').toString().toUpperCase();
                              final sum = run['summary'] is Map ? run['summary'] as Map : const {};

                              return DataRow(
                                cells: [
                                  DataCell(
                                    Text(
                                      formatDate(run['run_date']),
                                      style: const TextStyle(fontFamily: 'monospace', fontSize: 11, fontWeight: FontWeight.w600),
                                    ),
                                  ),
                                  DataCell(
                                    AppBadge(
                                      label: st == 'SUCCEEDED' ? 'Thành công' : (st == 'FAILED' ? 'Thất bại' : 'Đang chạy'),
                                      variant: st == 'SUCCEEDED' ? AppBadgeVariant.emerald : (st == 'FAILED' ? AppBadgeVariant.red : AppBadgeVariant.sky),
                                      dot: true,
                                    ),
                                  ),
                                  DataCell(
                                    Text(
                                      'Lần ${run['attempt_count'] ?? 1} • ${run['duration_ms'] ?? 0} ms',
                                      style: const TextStyle(fontSize: 11, color: AppColors.slate600),
                                    ),
                                  ),
                                  DataCell(
                                    Column(
                                      mainAxisAlignment: MainAxisAlignment.center,
                                      crossAxisAlignment: CrossAxisAlignment.start,
                                      children: [
                                        Text(
                                          'HĐ nháp: ${sum['autoCreatedInvoices'] ?? 0} • Chặn thiếu chỉ số: ${sum['skippedMeterContracts'] ?? 0} • Quá hạn: ${sum['overdueMarked'] ?? 0} • Phạt: ${sum['lateFeeUpdated'] ?? 0}',
                                          style: const TextStyle(fontSize: 11, color: AppColors.slate700),
                                        ),
                                        if ((run['error_message']?.toString() ?? '').isNotEmpty)
                                          Text(
                                            run['error_message'].toString(),
                                            style: const TextStyle(fontSize: 11, color: AppColors.rose600),
                                          ),
                                      ],
                                    ),
                                  ),
                                  DataCell(
                                    Row(
                                      children: [
                                        const Icon(LucideIcons.clock, size: 13, color: AppColors.slate500),
                                        const SizedBox(width: 4),
                                        Text(
                                          formatDateTime(run['started_at']),
                                          style: const TextStyle(fontSize: 11, color: AppColors.slate600),
                                        ),
                                      ],
                                    ),
                                  ),
                                ],
                              );
                            }).toList(),
                                ),
                              ),
                            );
                          },
                        ),
                    ],
                  ),
                ),
              ],
            ],
          ],
        ),
      ),
    );
  }
}
