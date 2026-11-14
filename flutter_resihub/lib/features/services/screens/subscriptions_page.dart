import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../../../core/constants/statuses.dart';
import '../../../core/theme/app_colors.dart';
import '../../../core/utils/billing_helpers.dart';
import '../../../core/utils/format.dart';
import '../../../core/utils/service_subscription_meta.dart';
import '../../../core/utils/validation.dart';
import '../../../shared/providers/toast_provider.dart';
import '../../../shared/widgets/common/confirm_dialog.dart';
import '../../../shared/widgets/common/empty_state.dart';
import '../../../shared/widgets/common/page_header.dart';
import '../../../shared/widgets/common/search_bar_widget.dart';
import '../../../shared/widgets/common/service_subscription_meta_fields.dart';
import '../../../shared/widgets/common/stats_card.dart';
import '../../../shared/widgets/common/status_badge.dart';
import '../../../shared/widgets/ui/app_button.dart';
import '../../../shared/widgets/ui/app_card.dart';
import '../../../shared/widgets/ui/app_input.dart';
import '../../../shared/widgets/ui/app_modal.dart';
import '../../../shared/widgets/ui/app_select.dart';
import '../../auth/providers/auth_provider.dart';
import '../../auth/providers/permission_provider.dart';
import '../services/services_service.dart';

const List<Map<String, String>> kSubscriptionStatusFilters = [
  {'value': '', 'label': 'Tất cả đăng ký'},
  {'value': 'PENDING_APPROVAL', 'label': 'Chờ phê duyệt'},
  {'value': 'ACTIVE', 'label': 'Đang sử dụng'},
  {'value': 'CANCELLATION_PENDING', 'label': 'Chờ hủy'},
  {'value': 'TERMINATED', 'label': 'Đã chấm dứt'},
  {'value': 'CANCELLED', 'label': 'Đã hủy'},
  {'value': 'REJECTED', 'label': 'Đã từ chối'},
];

/// Apartment Service Subscriptions Administration Page (M07).
/// Port of `frontend/src/pages/admin/services/SubscriptionsPage.jsx`.
class SubscriptionsPage extends ConsumerStatefulWidget {
  final String? initialSubscriptionId;
  final String? initialModal;

  const SubscriptionsPage({
    super.key,
    this.initialSubscriptionId,
    this.initialModal,
  });

  @override
  ConsumerState<SubscriptionsPage> createState() => _SubscriptionsPageState();
}

class _SubscriptionsPageState extends ConsumerState<SubscriptionsPage> {
  List<Map<String, dynamic>> _subscriptions = [];
  bool _loading = true;

  String _statusFilter = '';
  String _search = '';
  bool _deepLinkHandled = false;

  @override
  void initState() {
    super.initState();
    _fetchSubscriptions();
  }

  Future<void> _fetchSubscriptions({bool force = false}) async {
    setState(() => _loading = true);
    final selectedBuildingId = ref.read(authProvider).selectedBuildingId;

    try {
      final svc = ref.read(servicesServiceProvider);
      final res = await svc.listSubscriptions(
        selectedBuildingId.isNotEmpty ? {'building_id': selectedBuildingId} : null,
        null,
        force,
      );

      final list = (res is Map && res['data'] is List)
          ? (res['data'] as List).whereType<Map>().map((e) => Map<String, dynamic>.from(e)).toList()
          : (res is List)
              ? res.whereType<Map>().map((e) => Map<String, dynamic>.from(e)).toList()
              : <Map<String, dynamic>>[];

      if (mounted) {
        setState(() {
          _subscriptions = list;
          _loading = false;
        });
        _checkAndTriggerDeepLink();
      }
    } catch (err) {
      if (mounted) {
        setState(() => _loading = false);
        ref.read(toastProvider.notifier).error(
              extractErrorMessage(err, 'Không thể tải danh sách đăng ký dịch vụ.'),
            );
      }
    }
  }

  void _checkAndTriggerDeepLink() {
    if (_deepLinkHandled) return;

    String? subId = widget.initialSubscriptionId;
    if (subId == null || subId.isEmpty) {
      try {
        final routerState = GoRouterState.of(context);
        subId = routerState.uri.queryParameters['subscription_id'];
      } catch (_) {}
    }

    if (subId == null || subId.isEmpty) return;

    final matched = _subscriptions.firstWhere(
      (s) => s['id']?.toString() == subId,
      orElse: () => {},
    );

    if (matched.isEmpty) {
      ref.read(toastProvider.notifier).info('Bản ghi liên quan không còn tồn tại hoặc đã thay đổi trạng thái.');
      return;
    }

    _deepLinkHandled = true;
    final canManage = ref.read(permissionProvider).canManageServices;

    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      if (matched['status'] == 'CANCELLATION_PENDING' && canManage) {
        _openCancelModal(matched);
      } else {
        _openReviewModal(matched);
      }
    });
  }

  List<Map<String, dynamic>> get _filteredSubscriptions {
    final q = _search.trim().toLowerCase();
    return _subscriptions.where((s) {
      if (_statusFilter.isNotEmpty && s['status'] != _statusFilter) {
        return false;
      }
      if (q.isNotEmpty) {
        final apt = (s['apartment_code'] ?? '').toString().toLowerCase();
        final bldg = (s['building_code'] ?? '').toString().toLowerCase();
        final name = (s['service_name'] ?? '').toString().toLowerCase();
        final code = (s['service_code'] ?? '').toString().toLowerCase();
        final tenant = (s['tenant_name'] ?? '').toString().toLowerCase();
        final note = (s['note'] ?? '').toString().toLowerCase();
        final plates = (s['vehicle_plates'] is List)
            ? (s['vehicle_plates'] as List).join(' ').toLowerCase()
            : '';

        if (!apt.contains(q) &&
            !bldg.contains(q) &&
            !name.contains(q) &&
            !code.contains(q) &&
            !tenant.contains(q) &&
            !note.contains(q) &&
            !plates.contains(q)) {
          return false;
        }
      }
      return true;
    }).toList();
  }

  void _openReviewModal(Map<String, dynamic> item) {
    AppModal.show<void>(
      context: context,
      title: 'Chi tiết đăng ký dịch vụ',
      subtitle: 'Căn ${item['apartment_code'] ?? '—'} (${item['building_code'] ?? '—'}) • ${item['service_name'] ?? 'Dịch vụ'}',
      size: AppModalSize.lg,
      child: Consumer(
        builder: (ctx, ref, _) {
          final canManage = ref.watch(permissionProvider).canManageServices;
          final status = item['status']?.toString() ?? '';
          final unitPrice = item['unit_price'] is num
              ? item['unit_price'] as num
              : num.tryParse(item['unit_price']?.toString() ?? '0') ?? 0;
          final qty = item['quantity'] ?? 1;

          return Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  const Text('Trạng thái:', style: TextStyle(fontSize: 13, color: AppColors.slate500)),
                  StatusBadge(status: status, domain: StatusDomain.subscription),
                ],
              ),
              const Divider(height: 24),
              Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  const Text('Người đại diện / Cư dân:', style: TextStyle(fontSize: 13, color: AppColors.slate500)),
                  Text(
                    item['tenant_name']?.toString() ?? '—',
                    style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: AppColors.slate900),
                  ),
                ],
              ),
              const SizedBox(height: 10),
              Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  const Text('Đơn giá & Số lượng:', style: TextStyle(fontSize: 13, color: AppColors.slate500)),
                  Text(
                    '$qty × ${formatMoney(unitPrice)}',
                    style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: AppColors.slate900),
                  ),
                ],
              ),
              const SizedBox(height: 10),
              Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  const Text('Thời gian áp dụng:', style: TextStyle(fontSize: 13, color: AppColors.slate500)),
                  Text(
                    '${formatDate(item['start_date'])}${item['end_date'] != null ? ' → ${formatDate(item['end_date'])}' : ''}',
                    style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w500, color: AppColors.slate800),
                  ),
                ],
              ),
              if (item['vehicle_plates'] is List && (item['vehicle_plates'] as List).isNotEmpty) ...[
                const SizedBox(height: 14),
                const Text('Biển số xe đăng ký:', style: TextStyle(fontSize: 13, color: AppColors.slate500)),
                const SizedBox(height: 6),
                VehiclePlatesBadges(plates: item['vehicle_plates'] as List),
              ],
              if (item['note'] != null && item['note'].toString().trim().isNotEmpty) ...[
                const SizedBox(height: 14),
                const Text('Ghi chú dịch vụ:', style: TextStyle(fontSize: 13, color: AppColors.slate500)),
                const SizedBox(height: 4),
                Container(
                  width: double.infinity,
                  padding: const EdgeInsets.all(10),
                  decoration: BoxDecoration(
                    color: AppColors.slate50,
                    borderRadius: BorderRadius.circular(8),
                    border: Border.all(color: AppColors.border),
                  ),
                  child: Text(
                    item['note'].toString(),
                    style: const TextStyle(fontSize: 13, color: AppColors.slate700),
                  ),
                ),
              ],
              const SizedBox(height: 24),
              Wrap(
                spacing: 8,
                runSpacing: 8,
                alignment: WrapAlignment.end,
                crossAxisAlignment: WrapCrossAlignment.center,
                children: [
                  AppButton(
                    text: 'Đóng',
                    variant: AppButtonVariant.outline,
                    onPressed: () => Navigator.of(ctx).pop(),
                  ),
                  if (canManage && status == 'PENDING_APPROVAL') ...[
                    AppButton(
                      text: 'Từ chối',
                      variant: AppButtonVariant.danger,
                      onPressed: () {
                        Navigator.of(ctx).pop();
                        _handleRejectSubscription(item);
                      },
                    ),
                    AppButton(
                      text: 'Duyệt kích hoạt',
                      variant: AppButtonVariant.primary,
                      onPressed: () {
                        Navigator.of(ctx).pop();
                        _handleApproveSubscription(item);
                      },
                    ),
                  ],
                  if (canManage && status == 'CANCELLATION_PENDING') ...[
                    AppButton(
                      text: 'Từ chối hủy',
                      variant: AppButtonVariant.outline,
                      onPressed: () {
                        Navigator.of(ctx).pop();
                        _handleRejectSubscription(item);
                      },
                    ),
                    AppButton(
                      text: 'Chấp thuận hủy',
                      variant: AppButtonVariant.danger,
                      onPressed: () {
                        Navigator.of(ctx).pop();
                        _openCancelModal(item);
                      },
                    ),
                  ],
                ],
              ),
            ],
          );
        },
      ),
    );
  }

  Future<void> _handleApproveSubscription(Map<String, dynamic> item) async {
    final id = item['id']?.toString();
    if (id == null) return;

    try {
      await ref.read(servicesServiceProvider).updateSubscription(id, {'status': 'ACTIVE'});
      ref.read(toastProvider.notifier).success('Đã duyệt và kích hoạt gói dịch vụ thành công.');
      _fetchSubscriptions(force: true);
    } catch (err) {
      ref.read(toastProvider.notifier).error(
            extractErrorMessage(err, 'Không thể duyệt gói dịch vụ.'),
          );
    }
  }

  Future<void> _handleRejectSubscription(Map<String, dynamic> item) async {
    final confirmed = await ConfirmDialog.show(
      context: context,
      title: 'Từ chối đăng ký dịch vụ',
      message: 'Bạn có chắc chắn muốn từ chối gói dịch vụ "${item['service_name']}" của căn ${item['apartment_code']}?',
      confirmLabel: 'Từ chối đăng ký',
      showReasonInput: true,
      reasonLabel: 'Lý do từ chối',
      reasonHint: 'VD: Không còn chỗ để xe, căn hộ chưa thanh toán kỳ trước...',
      variant: ConfirmDialogVariant.danger,
    );

    if (confirmed != true) return;
    final id = item['id']?.toString();
    if (id == null) return;

    try {
      await ref.read(servicesServiceProvider).updateSubscription(id, {'status': 'REJECTED'});
      ref.read(toastProvider.notifier).success('Đã từ chối gói dịch vụ.');
      _fetchSubscriptions(force: true);
    } catch (err) {
      ref.read(toastProvider.notifier).error(
            extractErrorMessage(err, 'Không thể từ chối gói dịch vụ.'),
          );
    }
  }

  void _openCancelModal(Map<String, dynamic> item) {
    String endDate = todayVietnamYmd();
    bool zeroUsage = false;
    bool saving = false;

    AppModal.show<void>(
      context: context,
      title: 'Chấm dứt gói dịch vụ & Tính phí Pro-rata',
      subtitle: 'Căn ${item['apartment_code']} • ${item['service_name']}',
      size: AppModalSize.md,
      child: StatefulBuilder(
        builder: (ctx, setModalState) {
          final prorata = previewSubscriptionProrata(
            unitPrice: item['unit_price'],
            quantity: item['quantity'] ?? 1,
            endDate: endDate,
            zeroUsage: zeroUsage,
          );

          return Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              AppInput(
                label: 'Ngày kết thúc sử dụng',
                initialValue: endDate,
                onChanged: (val) => setModalState(() => endDate = val.trim()),
              ),
              const SizedBox(height: 12),
              SwitchListTile.adaptive(
                contentPadding: EdgeInsets.zero,
                title: const Text('Miễn phí sử dụng kỳ cuối (Zero usage)', style: TextStyle(fontSize: 13)),
                value: zeroUsage,
                onChanged: (val) => setModalState(() => zeroUsage = val),
              ),
              const SizedBox(height: 12),
              Container(
                padding: const EdgeInsets.all(12),
                decoration: BoxDecoration(
                  color: AppColors.slate50,
                  borderRadius: BorderRadius.circular(8),
                  border: Border.all(color: AppColors.border),
                ),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Text('Dự tính phí Pro-rata kỳ này:', style: TextStyle(fontSize: 12, color: AppColors.slate500)),
                    const SizedBox(height: 4),
                    Text(
                      formatMoney(prorata.amount),
                      style: const TextStyle(fontSize: 18, fontWeight: FontWeight.bold, color: AppColors.slate900),
                    ),
                    const SizedBox(height: 2),
                    Text(
                      prorata.description,
                      style: const TextStyle(fontSize: 12, color: AppColors.slate600),
                    ),
                  ],
                ),
              ),
              const SizedBox(height: 20),
              Row(
                mainAxisAlignment: MainAxisAlignment.end,
                children: [
                  AppButton(
                    text: 'Hủy bỏ',
                    variant: AppButtonVariant.outline,
                    onPressed: saving ? null : () => Navigator.of(ctx).pop(),
                  ),
                  const SizedBox(width: 8),
                  AppButton(
                    text: 'Xác nhận chấm dứt',
                    variant: AppButtonVariant.danger,
                    loading: saving,
                    onPressed: () async {
                      setModalState(() => saving = true);
                      final id = item['id']?.toString();
                      if (id == null) return;

                      try {
                        await ref.read(servicesServiceProvider).terminateSubscription(id, {
                          'status': 'TERMINATED',
                          'end_date': endDate,
                          'zero_usage': zeroUsage,
                        });
                        ref.read(toastProvider.notifier).success('Đã chấm dứt gói dịch vụ thành công.');
                        if (ctx.mounted) Navigator.of(ctx).pop();
                        _fetchSubscriptions(force: true);
                      } catch (err) {
                        setModalState(() => saving = false);
                        ref.read(toastProvider.notifier).error(
                              extractErrorMessage(err, 'Không thể chấm dứt gói dịch vụ.'),
                            );
                      }
                    },
                  ),
                ],
              ),
            ],
          );
        },
      ),
    );
  }

  Future<void> _openAssignModal() async {
    try {
      final catRes = await ref.read(servicesServiceProvider).listCatalog();
      final catList = (catRes is Map && catRes['data'] is List)
          ? (catRes['data'] as List).whereType<Map>().map((e) => Map<String, dynamic>.from(e)).toList()
          : <Map<String, dynamic>>[];

      if (!mounted) return;

      String selectedServiceId = catList.isNotEmpty ? catList[0]['id'].toString() : '';
      String apartmentId = '';
      int quantity = 1;
      String startDate = todayVietnamYmd();
      List<String> vehiclePlates = [''];
      String note = '';
      bool saving = false;

      AppModal.show<void>(
        context: context,
        title: 'Đăng ký dịch vụ cho Căn hộ',
        subtitle: 'Gán dịch vụ tiện ích, gói gửi xe hoặc phí định kỳ',
        size: AppModalSize.lg,
        child: StatefulBuilder(
          builder: (ctx, setModalState) {
            final activeSvc = catList.firstWhere(
              (s) => s['id']?.toString() == selectedServiceId,
              orElse: () => {},
            );
            final isParking = isParkingService(activeSvc);
            final unitPrice = activeSvc['unit_price'] ?? 0;
            final prorata = previewSubscriptionProrata(
              unitPrice: unitPrice,
              quantity: quantity,
              startDate: startDate,
            );

            return Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                AppInput(
                  label: 'Mã căn hộ / ID căn hộ',
                  required: true,
                  placeholder: 'Nhập ID hoặc mã căn hộ (VD: 101, 202...)',
                  initialValue: apartmentId,
                  onChanged: (val) => apartmentId = val.trim(),
                ),
                const SizedBox(height: 12),
                AppSelect<String>(
                  label: 'Chọn dịch vụ từ danh mục',
                  value: selectedServiceId,
                  options: catList.map((s) {
                    return AppSelectOption(
                      value: s['id']?.toString() ?? '',
                      label: '${s['name']} (${formatMoney(s['unit_price'])}/${s['unit'] ?? 'tháng'})',
                    );
                  }).toList(),
                  onChanged: (val) {
                    if (val != null) {
                      setModalState(() {
                        selectedServiceId = val;
                        final newSvc = catList.firstWhere((s) => s['id']?.toString() == val, orElse: () => {});
                        if (isParkingService(newSvc)) {
                          vehiclePlates = syncVehiclePlatesArray(vehiclePlates, quantity);
                        }
                      });
                    }
                  },
                ),
                const SizedBox(height: 12),
                Row(
                  children: [
                    Expanded(
                      child: AppInput(
                        label: 'Số lượng đăng ký',
                        required: true,
                        initialValue: quantity.toString(),
                        onChanged: (val) {
                          final parsed = int.tryParse(val.trim()) ?? 1;
                          setModalState(() {
                            quantity = parsed > 0 ? parsed : 1;
                            if (isParking) {
                              vehiclePlates = syncVehiclePlatesArray(vehiclePlates, quantity);
                            }
                          });
                        },
                      ),
                    ),
                    const SizedBox(width: 12),
                    Expanded(
                      child: AppInput(
                        label: 'Ngày bắt đầu áp dụng',
                        required: true,
                        initialValue: startDate,
                        onChanged: (val) => setModalState(() => startDate = val.trim()),
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 12),
                ServiceSubscriptionMetaFields(
                  isParking: isParking,
                  quantity: quantity,
                  vehiclePlates: vehiclePlates,
                  note: note,
                  onPlateChange: (idx, val) {
                    if (idx >= 0 && idx < vehiclePlates.length) {
                      vehiclePlates[idx] = val;
                    }
                  },
                  onNoteChange: (val) => note = val,
                ),
                const SizedBox(height: 16),
                Container(
                  padding: const EdgeInsets.all(12),
                  decoration: BoxDecoration(
                    color: AppColors.slate50,
                    borderRadius: BorderRadius.circular(8),
                    border: Border.all(color: AppColors.border),
                  ),
                  child: Row(
                    mainAxisAlignment: MainAxisAlignment.spaceBetween,
                    children: [
                      const Text('Dự tính phí tháng đầu (Pro-rata):', style: TextStyle(fontSize: 13, color: AppColors.slate600)),
                      Text(
                        formatMoney(prorata.amount),
                        style: const TextStyle(fontSize: 16, fontWeight: FontWeight.bold, color: AppColors.slate900),
                      ),
                    ],
                  ),
                ),
                const SizedBox(height: 20),
                Row(
                  mainAxisAlignment: MainAxisAlignment.end,
                  children: [
                    AppButton(
                      text: 'Hủy bỏ',
                      variant: AppButtonVariant.outline,
                      onPressed: saving ? null : () => Navigator.of(ctx).pop(),
                    ),
                    const SizedBox(width: 8),
                    AppButton(
                      text: 'Tạo gói đăng ký',
                      variant: AppButtonVariant.primary,
                      loading: saving,
                      onPressed: () async {
                        if (apartmentId.isEmpty) {
                          ref.read(toastProvider.notifier).warning('Vui lòng nhập căn hộ đăng ký.');
                          return;
                        }

                        if (isParking) {
                          final metaVal = validateServiceMetaInput(
                            isParking: true,
                            quantity: quantity,
                            vehiclePlates: vehiclePlates,
                            note: note,
                          );
                          if (!metaVal.valid) {
                            final err = metaVal.plateErrors.firstWhere((e) => e.isNotEmpty, orElse: () => metaVal.quantityError);
                            ref.read(toastProvider.notifier).warning(err);
                            return;
                          }
                        }

                        setModalState(() => saving = true);
                        try {
                          await ref.read(servicesServiceProvider).createSubscription({
                            'apartment_id': apartmentId,
                            'service_id': selectedServiceId,
                            'quantity': quantity,
                            'start_date': startDate,
                            'vehicle_plates': isParking ? vehiclePlates.map((p) => p.trim()).where((p) => p.isNotEmpty).toList() : [],
                            'note': note.trim(),
                          });
                          ref.read(toastProvider.notifier).success('Đã đăng ký dịch vụ thành công.');
                          if (ctx.mounted) Navigator.of(ctx).pop();
                          _fetchSubscriptions(force: true);
                        } catch (err) {
                          setModalState(() => saving = false);
                          ref.read(toastProvider.notifier).error(
                                extractErrorMessage(err, 'Không thể tạo gói đăng ký.'),
                              );
                        }
                      },
                    ),
                  ],
                ),
              ],
            );
          },
        ),
      );
    } catch (err) {
      ref.read(toastProvider.notifier).error(extractErrorMessage(err));
    }
  }

  @override
  Widget build(BuildContext context) {
    final perms = ref.watch(permissionProvider);
    final canManage = perms.canManageServices;
    final items = _filteredSubscriptions;

    final pendingApprove = _subscriptions.where((s) => s['status'] == 'PENDING_APPROVAL').length;
    final pendingCancel = _subscriptions.where((s) => s['status'] == 'CANCELLATION_PENDING').length;
    final activeCount = _subscriptions.where((s) => s['status'] == 'ACTIVE').length;
    final monthlyTotal = _subscriptions.where((s) => s['status'] == 'ACTIVE').fold<num>(
      0,
      (sum, s) {
        final p = s['unit_price'] is num ? s['unit_price'] as num : num.tryParse(s['unit_price']?.toString() ?? '0') ?? 0;
        final q = s['quantity'] is num ? s['quantity'] as num : num.tryParse(s['quantity']?.toString() ?? '1') ?? 1;
        return sum + (p * q);
      },
    );

    return Scaffold(
      key: const Key('route:/admin/services/subscriptions'),
      backgroundColor: AppColors.background,
      body: RefreshIndicator(
        onRefresh: () => _fetchSubscriptions(force: true),
        child: SingleChildScrollView(
          physics: const AlwaysScrollableScrollPhysics(),
          padding: const EdgeInsets.all(24),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              PageHeader(
                title: 'Gói đăng ký dịch vụ',
                subtitle: 'Theo dõi các gói dịch vụ cư dân đăng ký, gửi xe, tiện ích và phê duyệt',
                breadcrumbs: const [
                  BreadcrumbItem(label: 'Trang chủ', to: '/admin'),
                  BreadcrumbItem(label: 'Dịch vụ', to: '/admin/services'),
                  BreadcrumbItem(label: 'Gói đăng ký'),
                ],
                actions: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    AppButton(
                      text: 'Danh mục dịch vụ',
                      icon: const Icon(LucideIcons.package, size: 16),
                      variant: AppButtonVariant.outline,
                      onPressed: () => context.go('/admin/services'),
                    ),
                    if (canManage) ...[
                      const SizedBox(width: 8),
                      AppButton(
                        text: 'Đăng ký mới',
                        icon: const Icon(LucideIcons.plus, size: 16),
                        variant: AppButtonVariant.primary,
                        onPressed: _openAssignModal,
                      ),
                    ],
                  ],
                ),
              ),
              const SizedBox(height: 20),

              // Stats Cards
              LayoutBuilder(
                builder: (context, constraints) {
                  final isWide = constraints.maxWidth > 900;
                  return GridView.count(
                    shrinkWrap: true,
                    physics: const NeverScrollableScrollPhysics(),
                    crossAxisCount: isWide ? 4 : 2,
                    crossAxisSpacing: 16,
                    mainAxisSpacing: 16,
                    childAspectRatio: isWide ? 2.2 : 1.8,
                    children: [
                      StatsCard(
                        title: 'Chờ phê duyệt',
                        value: pendingApprove.toString(),
                        icon: LucideIcons.clock,
                        color: 'amber',
                      ),
                      StatsCard(
                        title: 'Chờ hủy',
                        value: pendingCancel.toString(),
                        icon: LucideIcons.ban,
                        color: 'rose',
                      ),
                      StatsCard(
                        title: 'Đang hoạt động',
                        value: activeCount.toString(),
                        icon: LucideIcons.checkCircle2,
                        color: 'emerald',
                      ),
                      StatsCard(
                        title: 'Doanh thu tháng (ước tính)',
                        value: formatMoney(monthlyTotal),
                        icon: LucideIcons.calculator,
                        color: 'sky',
                      ),
                    ],
                  );
                },
              ),
              const SizedBox(height: 20),

              // Filters & Search
              AppCard(
                padding: const EdgeInsets.all(16),
                child: Row(
                  children: [
                    Expanded(
                      flex: 2,
                      child: SearchBarWidget(
                        placeholder: 'Tìm theo căn hộ, tên dịch vụ, biển số xe, cư dân...',
                        value: _search,
                        onChanged: (val) => setState(() => _search = val),
                      ),
                    ),
                    const SizedBox(width: 12),
                    Expanded(
                      child: AppSelect<String>(
                        value: _statusFilter,
                        options: kSubscriptionStatusFilters.map((e) {
                          return AppSelectOption(value: e['value']!, label: e['label']!);
                        }).toList(),
                        onChanged: (val) => setState(() => _statusFilter = val ?? ''),
                      ),
                    ),
                  ],
                ),
              ),
              const SizedBox(height: 20),

              if (_loading) ...[
                const Center(
                  child: Padding(
                    padding: EdgeInsets.symmetric(vertical: 40),
                    child: CircularProgressIndicator(),
                  ),
                ),
              ] else if (items.isEmpty) ...[
                EmptyState(
                  icon: LucideIcons.users,
                  title: 'Chưa có gói đăng ký nào',
                  description: 'Không tìm thấy dữ liệu đăng ký dịch vụ phù hợp bộ lọc.',
                  action: canManage
                      ? AppButton(
                          text: 'Tạo đăng ký mới',
                          icon: const Icon(LucideIcons.plus, size: 16),
                          variant: AppButtonVariant.primary,
                          onPressed: _openAssignModal,
                        )
                      : null,
                ),
              ] else ...[
                AppCard(
                  padding: EdgeInsets.zero,
                  child: SingleChildScrollView(
                    scrollDirection: Axis.horizontal,
                    child: DataTable(
                      headingRowColor: WidgetStateProperty.all(AppColors.slate50),
                      columns: const [
                        DataColumn(label: Text('Căn hộ / Tòa', style: TextStyle(fontWeight: FontWeight.w600))),
                        DataColumn(label: Text('Dịch vụ đăng ký', style: TextStyle(fontWeight: FontWeight.w600))),
                        DataColumn(label: Text('Đơn giá & SL', style: TextStyle(fontWeight: FontWeight.w600))),
                        DataColumn(label: Text('Thời gian áp dụng', style: TextStyle(fontWeight: FontWeight.w600))),
                        DataColumn(label: Text('Trạng thái', style: TextStyle(fontWeight: FontWeight.w600))),
                        DataColumn(label: Text('Thao tác', style: TextStyle(fontWeight: FontWeight.w600))),
                      ],
                      rows: items.map((sub) {
                        final status = sub['status']?.toString() ?? '';
                        final unitPrice = sub['unit_price'] is num
                            ? sub['unit_price'] as num
                            : num.tryParse(sub['unit_price']?.toString() ?? '0') ?? 0;
                        final qty = sub['quantity'] ?? 1;

                        return DataRow(
                          cells: [
                            DataCell(
                              Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                mainAxisAlignment: MainAxisAlignment.center,
                                children: [
                                  Text(
                                    'Căn ${sub['apartment_code'] ?? '—'}',
                                    style: const TextStyle(fontWeight: FontWeight.w600, color: AppColors.slate900),
                                  ),
                                  Text(
                                    sub['building_code'] ?? '',
                                    style: const TextStyle(fontSize: 11, color: AppColors.slate500),
                                  ),
                                ],
                              ),
                            ),
                            DataCell(
                              Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                mainAxisAlignment: MainAxisAlignment.center,
                                children: [
                                  Text(
                                    sub['service_name'] ?? '—',
                                    style: const TextStyle(fontWeight: FontWeight.w500, color: AppColors.slate900),
                                  ),
                                  if (sub['vehicle_plates'] is List && (sub['vehicle_plates'] as List).isNotEmpty)
                                    Padding(
                                      padding: const EdgeInsets.only(top: 4.0),
                                      child: VehiclePlatesBadges(plates: sub['vehicle_plates'] as List),
                                    ),
                                ],
                              ),
                            ),
                            DataCell(
                              Text(
                                '$qty × ${formatMoney(unitPrice)}',
                                style: const TextStyle(fontWeight: FontWeight.w500),
                              ),
                            ),
                            DataCell(
                              Text(
                                '${formatDate(sub['start_date'])}${sub['end_date'] != null ? ' → ${formatDate(sub['end_date'])}' : ''}',
                                style: const TextStyle(fontSize: 12),
                              ),
                            ),
                            DataCell(StatusBadge(status: status, domain: StatusDomain.subscription)),
                            DataCell(
                              Row(
                                mainAxisSize: MainAxisSize.min,
                                children: [
                                  IconButton(
                                    icon: const Icon(LucideIcons.eye, size: 16, color: AppColors.slate600),
                                    tooltip: 'Xem chi tiết',
                                    onPressed: () => _openReviewModal(sub),
                                  ),
                                  if (canManage && status == 'PENDING_APPROVAL') ...[
                                    IconButton(
                                      icon: const Icon(LucideIcons.check, size: 16, color: AppColors.emerald600),
                                      tooltip: 'Duyệt',
                                      onPressed: () => _handleApproveSubscription(sub),
                                    ),
                                    IconButton(
                                      icon: const Icon(LucideIcons.x, size: 16, color: AppColors.rose600),
                                      tooltip: 'Từ chối',
                                      onPressed: () => _handleRejectSubscription(sub),
                                    ),
                                  ],
                                  if (canManage && status == 'ACTIVE')
                                    IconButton(
                                      icon: const Icon(LucideIcons.ban, size: 16, color: AppColors.amber600),
                                      tooltip: 'Chấm dứt gói',
                                      onPressed: () => _openCancelModal(sub),
                                    ),
                                ],
                              ),
                            ),
                          ],
                        );
                      }).toList(),
                    ),
                  ),
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }
}
