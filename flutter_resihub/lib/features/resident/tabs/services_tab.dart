import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../../../core/theme/app_colors.dart';
import '../../../core/utils/billing_helpers.dart';
import '../../../core/utils/format.dart';
import '../../../core/utils/validation.dart';
import '../../../shared/providers/toast_provider.dart';
import '../../../shared/widgets/ui/app_badge.dart';
import '../../../shared/widgets/ui/app_button.dart';
import '../../../shared/widgets/ui/app_card.dart';
import '../../../shared/widgets/ui/app_input.dart';
import '../../../shared/widgets/ui/app_modal.dart';
import '../services/resident_service.dart';

class ServicesTab extends ConsumerStatefulWidget {
  final Map<String, dynamic>? overview;
  final Future<void> Function() onRefreshOverview;
  final void Function(String tab, [Map<String, dynamic>? extra]) onNavigateTab;

  const ServicesTab({
    super.key,
    required this.overview,
    required this.onRefreshOverview,
    required this.onNavigateTab,
  });

  @override
  ConsumerState<ServicesTab> createState() => _ServicesTabState();
}

class _ServicesTabState extends ConsumerState<ServicesTab> {
  bool _loading = false;
  List<dynamic> _subscriptions = [];
  List<dynamic> _catalog = [];

  @override
  void initState() {
    super.initState();
    _fetchServices();
  }

  @override
  void didUpdateWidget(covariant ServicesTab oldWidget) {
    super.didUpdateWidget(oldWidget);
    final oldCid = oldWidget.overview?['active_contract']?['contract_id'];
    final newCid = widget.overview?['active_contract']?['contract_id'];
    if (oldCid != newCid) {
      _fetchServices();
    }
  }

  String? get _contractId {
    final c = widget.overview?['active_contract'] ?? widget.overview?['contract'];
    return c?['contract_id']?.toString() ?? c?['id']?.toString();
  }

  Future<void> _fetchServices() async {
    setState(() => _loading = true);
    try {
      final res = await ref.read(residentServiceProvider).listServices(_contractId);
      if (mounted) {
        final dataMap = res is Map && res['data'] is Map
            ? res['data'] as Map
            : (res is Map ? res : null);

        if (dataMap != null) {
          setState(() {
            _subscriptions = dataMap['active_subscriptions'] is List
                ? dataMap['active_subscriptions'] as List
                : (dataMap['subscriptions'] is List ? dataMap['subscriptions'] as List : []);
            _catalog = dataMap['catalog'] is List
                ? dataMap['catalog'] as List
                : (dataMap['services'] is List ? dataMap['services'] as List : []);
            _loading = false;
          });
        } else if (res is List) {
          setState(() {
            _subscriptions = res;
            _catalog = const [];
            _loading = false;
          });
        }
      }
    } catch (err) {
      if (mounted) {
        setState(() => _loading = false);
        ref
            .read(toastProvider.notifier)
            .error(extractErrorMessage(err, 'Không thể tải danh sách dịch vụ.'));
      }
    }
  }

  void _openSubscribeModal(BuildContext context, Map<String, dynamic> item) {
    final cid = _contractId;
    if (cid == null || cid.isEmpty) {
      ref.read(toastProvider.notifier).error('Vui lòng chọn căn hộ đang có hợp đồng.');
      return;
    }

    final serviceId = item['service_id']?.toString() ?? item['id']?.toString() ?? '';
    final serviceName = item['service_name']?.toString() ?? item['name']?.toString() ?? 'Dịch vụ';
    final serviceCode = item['service_code']?.toString() ?? item['code']?.toString() ?? '';
    final isVehicleService = serviceCode.contains('PARKING') ||
        serviceCode.contains('VEHICLE') ||
        serviceCode.contains('MOTO') ||
        serviceCode.contains('BIKE');

    final unitPrice = item['price'] ?? item['unit_price'] ?? 0;
    final qtyCtrl = TextEditingController(text: '1');
    final plateCtrl = TextEditingController();
    bool submitting = false;

    AppModal.show(
      context: context,
      title: 'Đăng ký: $serviceName',
      subtitle: 'Đơn giá: ${formatMoney(unitPrice)}/tháng',
      child: StatefulBuilder(
        builder: (ctx, setModalState) {
          final qty = int.tryParse(qtyCtrl.text.trim()) ?? 1;
          final prorata = previewSubscriptionProrata(
            unitPrice: unitPrice,
            quantity: qty,
            startDate: todayVietnamYmd(),
          );

          return SingleChildScrollView(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                AppInput(
                  label: 'Số lượng *',
                  controller: qtyCtrl,
                  keyboardType: TextInputType.number,
                  onChanged: (_) => setModalState(() {}),
                ),
                if (isVehicleService) ...[
                  const SizedBox(height: 12),
                  AppInput(
                    label: 'Biển số xe *',
                    controller: plateCtrl,
                    hint: 'Ví dụ: 29A-123.45',
                  ),
                ],
                const SizedBox(height: 12),
                Container(
                  padding: const EdgeInsets.all(12),
                  decoration: BoxDecoration(
                    color: AppColors.primary50,
                    borderRadius: BorderRadius.circular(10),
                    border: Border.all(color: AppColors.primary200),
                  ),
                  child: Row(
                    children: [
                      const Icon(LucideIcons.sparkles, size: 18, color: AppColors.primary600),
                      const SizedBox(width: 8),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              'Phí tạm tính tháng này (${prorata.daysRatio} ngày): ${prorata.formattedAmount}',
                              style: const TextStyle(
                                fontFamily: 'Inter',
                                fontSize: 13,
                                fontWeight: FontWeight.w600,
                                color: AppColors.primary900,
                              ),
                            ),
                            const SizedBox(height: 2),
                            Text(
                              prorata.description,
                              style: const TextStyle(
                                fontFamily: 'Inter',
                                fontSize: 11,
                                color: AppColors.primary700,
                              ),
                            ),
                          ],
                        ),
                      ),
                    ],
                  ),
                ),
                const SizedBox(height: 20),
              Row(
                mainAxisAlignment: MainAxisAlignment.end,
                children: [
                  AppButton(
                    text: 'Hủy',
                    variant: AppButtonVariant.outline,
                    onPressed: submitting ? null : () => Navigator.of(ctx).pop(),
                  ),
                  const SizedBox(width: 8),
                  AppButton(
                    text: submitting ? 'Đang gửi...' : 'Xác nhận đăng ký',
                    loading: submitting,
                    onPressed: submitting
                        ? null
                        : () async {
                            final qty = int.tryParse(qtyCtrl.text.trim()) ?? 1;
                            final plate = plateCtrl.text.trim();
                            if (isVehicleService && plate.isEmpty) {
                              ref
                                  .read(toastProvider.notifier)
                                  .error('Vui lòng nhập biển số xe.');
                              return;
                            }

                            setModalState(() => submitting = true);
                            try {
                              await ref.read(residentServiceProvider).subscribeService({
                                'contract_id': cid,
                                'service_id': serviceId,
                                'quantity': qty,
                                if (isVehicleService)
                                  'metadata': {'license_plate': plate},
                              });
                              if (ctx.mounted) {
                                Navigator.of(ctx).pop();
                              }
                              ref
                                  .read(toastProvider.notifier)
                                  .success('Đã đăng ký dịch vụ thành công.');
                              await _fetchServices();
                            } catch (err) {
                              setModalState(() => submitting = false);
                              ref
                                  .read(toastProvider.notifier)
                                  .error(extractErrorMessage(err, 'Không thể đăng ký dịch vụ.'));
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

  void _openCancelModal(BuildContext context, Map<String, dynamic> sub) {
    final subId = sub['subscription_id']?.toString() ?? sub['id']?.toString() ?? '';
    final name = sub['service_name']?.toString() ?? sub['name']?.toString() ?? 'dịch vụ';
    final reasonCtrl = TextEditingController();
    bool submitting = false;

    AppModal.show(
      context: context,
      title: 'Hủy đăng ký: $name',
      subtitle: 'Yêu cầu hủy sẽ được gửi đến BQL và có hiệu lực từ kỳ tiếp theo.',
      child: StatefulBuilder(
        builder: (ctx, setModalState) {
          return Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              AppInput(
                label: 'Lý do hủy dịch vụ',
                controller: reasonCtrl,
                multiline: true,
                rows: 3,
                hint: 'Ví dụ: Đã bán xe / Không có nhu cầu sử dụng tiếp...',
              ),
              const SizedBox(height: 20),
              Row(
                mainAxisAlignment: MainAxisAlignment.end,
                children: [
                  AppButton(
                    text: 'Đóng',
                    variant: AppButtonVariant.outline,
                    onPressed: submitting ? null : () => Navigator.of(ctx).pop(),
                  ),
                  const SizedBox(width: 8),
                  AppButton(
                    text: submitting ? 'Đang xử lý...' : 'Xác nhận hủy',
                    variant: AppButtonVariant.danger,
                    loading: submitting,
                    onPressed: submitting
                        ? null
                        : () async {
                            setModalState(() => submitting = true);
                            try {
                              await ref.read(residentServiceProvider).cancelService(
                                subId,
                                {'cancellation_reason': reasonCtrl.text.trim()},
                              );
                              if (ctx.mounted) {
                                Navigator.of(ctx).pop();
                              }
                              ref
                                  .read(toastProvider.notifier)
                                  .success('Đã gửi yêu cầu hủy dịch vụ.');
                              await _fetchServices();
                            } catch (err) {
                              setModalState(() => submitting = false);
                              ref
                                  .read(toastProvider.notifier)
                                  .error(extractErrorMessage(err, 'Không thể hủy dịch vụ.'));
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

  Future<void> _handleWithdrawCancel(String subId) async {
    try {
      await ref.read(residentServiceProvider).withdrawCancelService(subId);
      ref.read(toastProvider.notifier).success('Đã rút lại yêu cầu hủy dịch vụ.');
      await _fetchServices();
    } catch (err) {
      ref
          .read(toastProvider.notifier)
          .error(extractErrorMessage(err, 'Không thể rút lại yêu cầu hủy dịch vụ.'));
    }
  }

  @override
  Widget build(BuildContext context) {
    return RefreshIndicator(
      onRefresh: () async {
        await widget.onRefreshOverview();
        await _fetchServices();
      },
      child: SingleChildScrollView(
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            // Active Subscriptions Section
            if (_loading && _subscriptions.isEmpty)
              const Center(child: Padding(padding: EdgeInsets.all(16), child: CircularProgressIndicator()))
            else
              AppCard(
                header: AppCardHeader(title: 'Dịch vụ đang sử dụng (${_subscriptions.length})'),
              child: _subscriptions.isEmpty
                  ? const Text(
                      'Căn hộ hiện chưa đăng ký thêm dịch vụ gia tăng nào.',
                      style: TextStyle(color: AppColors.slate500, fontSize: 13),
                    )
                  : Column(
                      children: _subscriptions.map((s) {
                        final sub = s is Map ? Map<String, dynamic>.from(s) : <String, dynamic>{};
                        final subId = sub['subscription_id']?.toString() ?? sub['id']?.toString() ?? '';
                        final name = sub['service_name']?.toString() ?? sub['name']?.toString() ?? 'Dịch vụ';
                        final status = sub['status']?.toString().toUpperCase() ?? 'ACTIVE';
                        final isCancelPending = status == 'CANCEL_REQUESTED';
                        final meta = sub['metadata'] is Map ? sub['metadata'] as Map : const {};
                        final plate = meta['license_plate']?.toString();

                        return Container(
                          margin: const EdgeInsets.only(bottom: 12),
                          padding: const EdgeInsets.all(12),
                          decoration: BoxDecoration(
                            color: AppColors.slate50,
                            borderRadius: BorderRadius.circular(12),
                            border: Border.all(color: AppColors.slate200),
                          ),
                          child: Row(
                            children: [
                              Container(
                                width: 40,
                                height: 40,
                                decoration: BoxDecoration(
                                  color: AppColors.primary100,
                                  borderRadius: BorderRadius.circular(10),
                                ),
                                child: const Icon(LucideIcons.sparkles,
                                    size: 20, color: AppColors.primary600),
                              ),
                              const SizedBox(width: 12),
                              Expanded(
                                child: Column(
                                  crossAxisAlignment: CrossAxisAlignment.start,
                                  children: [
                                    Row(
                                      children: [
                                        Text(
                                          name,
                                          style: const TextStyle(
                                            fontFamily: 'Inter',
                                            fontSize: 14,
                                            fontWeight: FontWeight.bold,
                                            color: AppColors.slate900,
                                          ),
                                        ),
                                        const SizedBox(width: 8),
                                        AppBadge(
                                          label: isCancelPending ? 'Chờ hủy' : 'Đang dùng',
                                          variant: isCancelPending
                                              ? AppBadgeVariant.amber
                                              : AppBadgeVariant.emerald,
                                        ),
                                      ],
                                    ),
                                    const SizedBox(height: 2),
                                    Text(
                                      '${formatMoney(sub['price'] ?? sub['unit_price'] ?? 0)}/tháng • SL: ${sub['quantity'] ?? 1}${plate != null && plate.isNotEmpty ? ' • Biển số: $plate' : ''}',
                                      style: const TextStyle(
                                        fontSize: 12,
                                        color: AppColors.slate600,
                                      ),
                                    ),
                                  ],
                                ),
                              ),
                              if (isCancelPending)
                                AppButton(
                                  text: 'Rút yêu cầu hủy',
                                  size: AppButtonSize.sm,
                                  variant: AppButtonVariant.outline,
                                  onPressed: () => _handleWithdrawCancel(subId),
                                )
                              else
                                AppButton(
                                  text: 'Hủy dịch vụ',
                                  size: AppButtonSize.sm,
                                  variant: AppButtonVariant.ghost,
                                  onPressed: () => _openCancelModal(context, sub),
                                ),
                            ],
                          ),
                        );
                      }).toList(),
                    ),
            ),
            const SizedBox(height: 16),

            // Available Catalog Section
            if (_catalog.isNotEmpty) ...[
              AppCard(
                header: AppCardHeader(title: 'Danh mục dịch vụ có thể đăng ký (${_catalog.length})'),
                child: Column(
                  children: _catalog.map((c) {
                    final item = c is Map ? Map<String, dynamic>.from(c) : <String, dynamic>{};
                    final name = item['service_name']?.toString() ?? item['name']?.toString() ?? '';
                    final desc = item['description']?.toString() ?? '';
                    final price = item['price'] ?? item['unit_price'] ?? 0;

                    return Container(
                      margin: const EdgeInsets.only(bottom: 12),
                      padding: const EdgeInsets.all(12),
                      decoration: BoxDecoration(
                        color: Colors.white,
                        borderRadius: BorderRadius.circular(12),
                        border: Border.all(color: AppColors.slate200),
                      ),
                      child: Row(
                        children: [
                          Container(
                            width: 40,
                            height: 40,
                            decoration: BoxDecoration(
                              color: AppColors.secondary50,
                              borderRadius: BorderRadius.circular(10),
                            ),
                            child: const Icon(LucideIcons.plusCircle,
                                size: 20, color: AppColors.secondary600),
                          ),
                          const SizedBox(width: 12),
                          Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(
                                  name,
                                  style: const TextStyle(
                                    fontFamily: 'Inter',
                                    fontSize: 14,
                                    fontWeight: FontWeight.w600,
                                    color: AppColors.slate800,
                                  ),
                                ),
                                if (desc.isNotEmpty) ...[
                                  const SizedBox(height: 2),
                                  Text(
                                    desc,
                                    style: const TextStyle(
                                      fontSize: 12,
                                      color: AppColors.slate500,
                                    ),
                                  ),
                                ],
                                const SizedBox(height: 2),
                                Text(
                                  '${formatMoney(price)}/tháng',
                                  style: const TextStyle(
                                    fontSize: 13,
                                    fontWeight: FontWeight.bold,
                                    color: AppColors.primary600,
                                  ),
                                ),
                              ],
                            ),
                          ),
                          AppButton(
                            text: 'Đăng ký',
                            size: AppButtonSize.sm,
                            onPressed: () => _openSubscribeModal(context, item),
                          ),
                        ],
                      ),
                    );
                  }).toList(),
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }
}
