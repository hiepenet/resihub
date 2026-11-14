import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
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
      }
    } catch (err) {
      if (mounted) {
        ref.read(toastProvider.notifier).error(
              extractErrorMessage(err, 'Không thể tải cấu hình hệ thống.'),
            );
        setState(() => _loading = false);
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
      }
    } catch (_) {
      if (mounted) {
        setState(() => _cronLoading = false);
      }
    }
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

      final reminderDays = _billingConfig['reminder_days_text']
          .toString()
          .split(',')
          .map((x) => int.tryParse(x.trim()))
          .where((n) => n != null && n > 0)
          .cast<int>()
          .toList();

      final dueOffset = int.tryParse(_billingConfig['due_date_offset_days']?.toString() ?? '') ?? 5;
      final graceDays = int.tryParse(_billingConfig['late_fee_grace_days']?.toString() ?? '') ?? 5;
      final lateFeePerDay = int.tryParse(_billingConfig['late_fee_per_day']?.toString() ?? '') ?? 100000;
      final lateFeeCapRaw = int.tryParse(_billingConfig['late_fee_cap']?.toString() ?? '');
      final lateFeeCap = (lateFeeCapRaw != null && lateFeeCapRaw > 0) ? lateFeeCapRaw : null;

      final payload = <String, dynamic>{
        'billing_config': {
          'billing_day': int.tryParse(_billingConfig['billing_day']?.toString() ?? '') ?? 1,
          'payment_due_days': dueOffset,
          'due_date_offset_days': dueOffset,
          'late_fee_grace_days': graceDays,
          'late_fee_per_day': lateFeePerDay,
          'late_fee_cap': lateFeeCap,
          'meter_anomaly_threshold_pct': int.tryParse(_billingConfig['meter_anomaly_threshold_pct']?.toString() ?? '') ?? 30,
          'reminder_days': reminderDays.isNotEmpty ? reminderDays : [3, 7, 15],
          'late_fee_percent': int.tryParse(_billingConfig['late_fee_percent']?.toString() ?? '') ?? 0,
          'electricity_default_price': int.tryParse(_billingConfig['electricity_default_price']?.toString() ?? '') ?? 3800,
          'water_default_price': int.tryParse(_billingConfig['water_default_price']?.toString() ?? '') ?? 22000,
        },
        'sla_config': {
          'response_hours': int.tryParse(_slaConfig['response_hours']?.toString() ?? '') ?? 2,
          'urgent_resolve_hours': int.tryParse(_slaConfig['urgent_resolve_hours']?.toString() ?? '') ?? 4,
          'normal_resolve_hours': int.tryParse(_slaConfig['normal_resolve_hours']?.toString() ?? '') ?? 24,
          'deposit_refund_days': int.tryParse(_slaConfig['deposit_refund_days']?.toString() ?? '') ?? 5,
          'reopen_window_days': int.tryParse(_slaConfig['reopen_window_days']?.toString() ?? '') ?? 3,
        },
        'contact_config': {
          'working_hours': _contactConfig['working_hours']?.toString().trim() ?? '',
          'technical_hotline': _contactConfig['technical_hotline']?.toString().trim() ?? '',
          'security_hotline': _contactConfig['security_hotline']?.toString().trim() ?? '',
          'emergency_phone': _contactConfig['emergency_phone']?.toString().trim() ?? '',
          'support_email': _contactConfig['support_email']?.toString().trim() ?? '',
        },
        'approval_config': {
          'allow_self_approval': _approvalConfig['allow_self_approval'] == true,
        },
        'reservation_cancel_policy': {
          'max_hold_days': int.tryParse(_reservationCancelPolicy['max_hold_days']?.toString() ?? '') ?? 30,
          'public_max_hold_days': int.tryParse(_reservationCancelPolicy['public_max_hold_days']?.toString() ?? '') ?? 7,
          'full_refund_before_days': int.tryParse(_reservationCancelPolicy['full_refund_before_days']?.toString() ?? '') ?? 3,
          'partial_refund_pct': int.tryParse(_reservationCancelPolicy['partial_refund_pct']?.toString() ?? '') ?? 50,
          'default_hold_amount': int.tryParse(_reservationCancelPolicy['default_hold_amount']?.toString() ?? '') ?? 2000000,
        },
        'ai_config': {
          ..._aiConfig,
          'monthly_budget_vnd': int.tryParse(_aiConfig['monthly_budget_vnd']?.toString() ?? '') ?? 1000000,
          'monthly_token_limit': int.tryParse(_aiConfig['monthly_token_limit']?.toString() ?? '') ?? 5000000,
          'ocr_threshold': double.tryParse(_aiConfig['ocr_threshold']?.toString() ?? '') ?? 0.85,
          'extract_threshold': double.tryParse(_aiConfig['extract_threshold']?.toString() ?? '') ?? 0.75,
          'triage_threshold': double.tryParse(_aiConfig['triage_threshold']?.toString() ?? '') ?? 0.65,
        },
      };

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
            _billingConfig = {
              ...kDefaultBillingConfig,
              if (def != null) ...Map<String, dynamic>.from(def),
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
                                    Text(
                                      'Cho phép người tạo tự phê duyệt trong mô hình 1 nhân sự (allow_self_approval)',
                                      style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: AppColors.slate900),
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
                        SingleChildScrollView(
                          scrollDirection: Axis.horizontal,
                          child: DataTable(
                            columns: const [
                              DataColumn(label: Text('Ngày đối soát', style: TextStyle(fontWeight: FontWeight.w600))),
                              DataColumn(label: Text('Trạng thái', style: TextStyle(fontWeight: FontWeight.w600))),
                              DataColumn(label: Text('Lần thử / Thời lượng', style: TextStyle(fontWeight: FontWeight.w600))),
                              DataColumn(label: Text('Kết quả tổng hợp', style: TextStyle(fontWeight: FontWeight.w600))),
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
                                    Text(
                                      'HĐ nháp: ${sum['autoCreatedInvoices'] ?? 0} • Chặn thiếu chỉ số: ${sum['skippedMeterContracts'] ?? 0} • Quá hạn: ${sum['overdueMarked'] ?? 0} • Phạt: ${sum['lateFeeUpdated'] ?? 0}',
                                      style: const TextStyle(fontSize: 11, color: AppColors.slate700),
                                    ),
                                  ),
                                ],
                              );
                            }).toList(),
                          ),
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
