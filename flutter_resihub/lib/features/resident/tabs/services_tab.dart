import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../../../core/constants/statuses.dart';
import '../../../core/network/query_cache.dart';
import '../../../core/theme/app_colors.dart';
import '../../../core/utils/billing_helpers.dart';
import '../../../core/utils/date_range.dart';
import '../../../core/utils/format.dart';
import '../../../core/utils/validation.dart';
import '../../../shared/providers/toast_provider.dart';
import '../../../shared/widgets/ui/app_badge.dart';
import '../../../shared/widgets/ui/app_button.dart';
import '../../../shared/widgets/ui/app_card.dart';
import '../../../shared/widgets/ui/app_input.dart';
import '../../../shared/widgets/ui/app_modal.dart';
import '../../../shared/widgets/ui/app_select.dart';
import '../services/resident_service.dart';

/// Mirrors `CATEGORY_META` in `ServicesTab.jsx`.
class _CategoryMeta {
  final String label;
  final IconData icon;
  final Color bg;
  final Color fg;

  const _CategoryMeta(this.label, this.icon, this.bg, this.fg);
}

const Map<String, _CategoryMeta> _kCategoryMeta = {
  'PARKING': _CategoryMeta(
      'Gửi xe & Bãi đỗ', LucideIcons.car, AppColors.sky50, AppColors.sky700),
  'INTERNET': _CategoryMeta('Internet & Truyền hình', LucideIcons.wifi,
      AppColors.secondary50, AppColors.secondary700),
  'CLEANING': _CategoryMeta('Vệ sinh & Giặt ủi', LucideIcons.brush,
      AppColors.emerald50, AppColors.emerald700),
  'AMENITY': _CategoryMeta('Tiện ích nội khu', LucideIcons.dumbbell,
      AppColors.purple50, AppColors.purple700),
  'SECURITY': _CategoryMeta('Thẻ từ & An ninh', LucideIcons.shield,
      AppColors.amber50, AppColors.amber700),
  'UTILITY': _CategoryMeta('Điện / Nước / Năng lượng', LucideIcons.sparkles,
      AppColors.sky50, AppColors.sky700),
  'ELECTRICITY': _CategoryMeta(
      'Điện sinh hoạt', LucideIcons.zap, AppColors.amber50, AppColors.amber700),
  'WATER': _CategoryMeta('Nước sinh hoạt', LucideIcons.droplets,
      AppColors.sky50, AppColors.sky700),
  'MANAGEMENT': _CategoryMeta('Phí quản lý vận hành', LucideIcons.building2,
      AppColors.secondary50, AppColors.secondary700),
  'OTHER': _CategoryMeta('Dịch vụ khác', LucideIcons.package,
      AppColors.slate100, AppColors.slate700),
};

_CategoryMeta _categoryMeta(dynamic category) =>
    _kCategoryMeta[_str(category, 'OTHER').toUpperCase()] ??
    _kCategoryMeta['OTHER']!;

String _str(dynamic value, [String fallback = '']) =>
    value == null ? fallback : value.toString();

int _int(dynamic value, [int fallback = 0]) {
  if (value is num) return value.toInt();
  return int.tryParse(value?.toString() ?? '') ?? fallback;
}

num _amount(dynamic value) =>
    value is num ? value : (num.tryParse(value?.toString() ?? '') ?? 0);

bool _isParking(dynamic item) {
  if (item is! Map) return false;
  final cat = item['category'] ?? item['service_category'] ?? '';
  return _str(cat).trim().toUpperCase() == 'PARKING';
}

List<String> _plates(dynamic sub) {
  if (sub is! Map) return const [];
  final raw = sub['vehicle_plates'];
  if (raw is List) {
    return raw
        .map((p) => p?.toString().trim() ?? '')
        .where((p) => p.isNotEmpty)
        .toList();
  }
  final meta = sub['metadata'];
  final legacy = meta is Map ? meta['license_plate']?.toString().trim() : null;
  return (legacy != null && legacy.isNotEmpty) ? [legacy] : const [];
}

const Set<String> _kTerminalStatuses = {'CANCELLED', 'REJECTED', 'TERMINATED'};

/// React ServicesTab.jsx:322-332 — payload đăng ký dịch vụ.
Map<String, dynamic> buildSubscribeServicePayload({
  required String contractId,
  required String serviceId,
  required int quantity,
  String? startDate,
  String? note,
  List<String>? vehiclePlates,
}) {
  return {
    'contract_id': contractId,
    'service_id': serviceId,
    'quantity': quantity,
    'start_date': startDate ?? '',
    'note': note ?? '',
    if (vehiclePlates != null && vehiclePlates.isNotEmpty)
      'vehicle_plates': vehiclePlates,
  };
}

/// React ServicesTab.jsx:375-378 — payload hủy dịch vụ.
Map<String, dynamic> buildCancelServicePayload({
  String? endDate,
  String? note,
}) {
  return {
    'end_date': endDate ?? '',
    'note': note ?? '',
  };
}

class ServicesTab extends ConsumerStatefulWidget {
  final Map<String, dynamic>? overview;
  final Future<void> Function() onRefreshOverview;
  final void Function(String tab, [Map<String, dynamic>? extra]) onNavigateTab;
  final String? actionParam;
  final String? modalParam;
  final String? subscriptionIdParam;
  final VoidCallback? onClearActionParam;

  const ServicesTab({
    super.key,
    required this.overview,
    required this.onRefreshOverview,
    required this.onNavigateTab,
    this.actionParam,
    this.modalParam,
    this.subscriptionIdParam,
    this.onClearActionParam,
  });

  @override
  ConsumerState<ServicesTab> createState() => _ServicesTabState();
}

class _ServicesTabState extends ConsumerState<ServicesTab> {
  bool _loading = false;
  bool _deepLinkApplied = false;
  bool _showCancelledHistory = false;
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

  Map<String, dynamic>? get _contract {
    final c =
        widget.overview?['active_contract'] ?? widget.overview?['contract'];
    return c is Map ? Map<String, dynamic>.from(c) : null;
  }

  String? get _contractId {
    final c = _contract;
    return c?['contract_id']?.toString() ?? c?['id']?.toString();
  }

  bool get _hasActiveContract {
    final status = _str(_contract?['contract_status']).toUpperCase();
    return status == 'ACTIVE' || status == 'RENEWAL_PENDING';
  }

  String get _minSubscribeDate => maxDateStr([
        todayVietnamYmd(),
        toDateOnlyStr(_contract?['start_date']),
      ]);

  String get _maxSubscribeDate => toDateOnlyStr(_contract?['end_date']);

  List<dynamic> get _activeSubscriptions => _subscriptions.where((s) {
        final status = _str(s is Map ? s['status'] : '').trim().toUpperCase();
        return !_kTerminalStatuses.contains(status);
      }).toList();

  List<dynamic> get _historySubscriptions => _subscriptions.where((s) {
        final status = _str(s is Map ? s['status'] : '').trim().toUpperCase();
        return _kTerminalStatuses.contains(status);
      }).toList();

  Future<void> _fetchServices({bool force = false}) async {
    setState(() => _loading = true);
    try {
      final res = await ref.read(queryCacheProvider).cachedFetch<dynamic>(
            'resident:services:${_contractId ?? ''}',
            () => ref.read(residentServiceProvider).listServices(_contractId),
            force: force,
          );
      if (mounted) {
        final dataMap = res is Map && res['data'] is Map
            ? res['data'] as Map
            : (res is Map ? res : null);

        if (dataMap != null) {
          setState(() {
            _subscriptions = dataMap['active_subscriptions'] is List
                ? dataMap['active_subscriptions'] as List
                : (dataMap['subscriptions'] is List
                    ? dataMap['subscriptions'] as List
                    : []);
            _catalog = dataMap['catalog'] is List
                ? dataMap['catalog'] as List
                : (dataMap['services'] is List
                    ? dataMap['services'] as List
                    : []);
            _loading = false;
          });
        } else if (res is List) {
          setState(() {
            _subscriptions = res;
            _catalog = const [];
            _loading = false;
          });
        }
        _applyDeepLink();
      }
    } catch (err) {
      if (mounted) {
        setState(() => _loading = false);
        ref.read(toastProvider.notifier).error(extractErrorMessage(
            err, 'Không thể tải thông tin dịch vụ tiện ích.'));
      }
    }
  }

  /// Deep-links ?action=subscribe + ?subscription_id= — parity ServicesTab.jsx:202-230.
  void _applyDeepLink() {
    final action = widget.actionParam;
    final subId = widget.subscriptionIdParam;
    final modal = widget.modalParam;
    if (_deepLinkApplied ||
        (action == null &&
            (subId == null || subId.isEmpty) &&
            (modal == null || modal.isEmpty))) {
      return;
    }
    _deepLinkApplied = true;
    if (!mounted) return;
    final ctx = context;

    if (action == 'subscribe') {
      widget.onClearActionParam?.call();
      if (_hasActiveContract && _catalog.isNotEmpty) {
        final first = _catalog.first;
        _openSubscribeModal(
          ctx,
          first is Map
              ? Map<String, dynamic>.from(first)
              : <String, dynamic>{},
        );
      }
      return;
    }

    if ((subId != null && subId.isNotEmpty) ||
        (modal != null && modal.isNotEmpty)) {
      Map<String, dynamic>? matched;
      for (final s in _subscriptions) {
        if (s is Map &&
            (subId == null ||
                subId.isEmpty ||
                (s['id'] ?? s['subscription_id'] ?? s['sub_id'])?.toString() ==
                    subId)) {
          matched = Map<String, dynamic>.from(s);
          break;
        }
      }
      if (matched == null) {
        ref.read(toastProvider.notifier).info(
            'Bản ghi liên quan không còn tồn tại hoặc đã thay đổi trạng thái.');
        return;
      }
      final status = _str(matched['status']).toUpperCase();
      if (_kTerminalStatuses.contains(status)) {
        setState(() => _showCancelledHistory = true);
      }
      _openDetailModal(ctx, matched);
    }
  }

  /// Responsive card grid: 1 column, then [maxCols] once wide enough.
  /// Subscriptions cap at 2 (like React's `md:grid-cols-2`), catalog at 3.
  Widget _responsiveGrid({
    required String gridKey,
    required int maxCols,
    required int count,
    required Widget Function(int index) builder,
  }) {
    return LayoutBuilder(
      builder: (context, constraints) {
        final maxWidth = constraints.maxWidth;
        var cols = 1;
        if (maxWidth >= 1200 && maxCols >= 3) {
          cols = 3;
        } else if (maxWidth >= 768 && maxCols >= 2) {
          cols = 2;
        }
        const gap = 16.0;
        final cardWidth =
            cols <= 1 ? maxWidth : (maxWidth - gap * (cols - 1)) / cols;
        return Wrap(
          key: Key(gridKey),
          spacing: gap,
          runSpacing: gap,
          children: List.generate(
            count,
            (i) => SizedBox(width: cardWidth, child: builder(i)),
          ),
        );
      },
    );
  }

  Widget _iconBox(_CategoryMeta meta) => Container(
        width: 40,
        height: 40,
        decoration: BoxDecoration(
          color: meta.bg,
          borderRadius: BorderRadius.circular(10),
        ),
        child: Icon(meta.icon, size: 20, color: meta.fg),
      );

  void _openSubscribeModal(BuildContext context, Map<String, dynamic> item,
      {bool preselect = true}) {
    final cid = _contractId;
    if (cid == null || cid.isEmpty) {
      ref
          .read(toastProvider.notifier)
          .error('Vui lòng chọn căn hộ đang có hợp đồng.');
      return;
    }
    final contractStatus = _str(_contract?['contract_status']).toUpperCase();
    if (contractStatus.isNotEmpty &&
        contractStatus != 'ACTIVE' &&
        contractStatus != 'RENEWAL_PENDING') {
      ref.read(toastProvider.notifier).warning(
          'Bạn cần có hợp đồng thuê đang hiệu lực (ACTIVE) để đăng ký dịch vụ mới.');
      return;
    }

    final selectable = _catalog.where((c) {
      return c is Map && _str(c['billing_type']).toUpperCase() != 'METERED';
    }).toList();

    String serviceId = '';
    if (preselect) {
      final requestedId = _str(item['id'], _str(item['service_id']));
      serviceId = requestedId.isNotEmpty
          ? requestedId
          : (selectable.isNotEmpty
              ? _str((selectable.first as Map)['id'])
              : '');
      if (serviceId.isNotEmpty &&
          !selectable.any((c) => _str((c as Map)['id']) == serviceId)) {
        serviceId =
            selectable.isNotEmpty ? _str((selectable.first as Map)['id']) : '';
      }
    }

    final qtyCtrl = TextEditingController(text: '1');
    final startDateCtrl = TextEditingController(
        text: _minSubscribeDate.isNotEmpty
            ? _minSubscribeDate
            : todayVietnamYmd());
    final plateCtrl = TextEditingController();
    final noteCtrl = TextEditingController();
    bool submitting = false;

    Map<String, dynamic>? selectedItem() {
      for (final c in _catalog) {
        if (c is Map && _str(c['id']) == serviceId) {
          return Map<String, dynamic>.from(c);
        }
      }
      return null;
    }

    AppModal.show(
      context: context,
      title: 'Đăng ký sử dụng dịch vụ tiện ích',
      subtitle:
          'Hệ thống tự động ước tính phí Pro-rata công bằng theo ngày bắt đầu trong tháng đầu tiên',
      child: StatefulBuilder(
        builder: (ctx, setModalState) {
          final selected = selectedItem();
          final unitPrice = selected == null
              ? 0
              : (selected['unit_price'] ?? selected['price'] ?? 0);
          final unit =
              selected == null ? 'tháng' : _str(selected['unit'], 'tháng');
          final isParking = _isParking(selected);
          final billingType = _str(selected?['billing_type']).toUpperCase();
          final qty = _int(qtyCtrl.text.trim(), 1);
          final effQty = qty < 1 ? 1 : qty;
          final startDate = _str(startDateCtrl.text).trim();

          String subscribeDateError = '';
          if (startDate.isNotEmpty) {
            if (_minSubscribeDate.isNotEmpty &&
                startDate.compareTo(_minSubscribeDate) < 0) {
              subscribeDateError =
                  'Ngày bắt đầu sử dụng không được nhỏ hơn ${formatDateVi(_minSubscribeDate)}.';
            } else if (_maxSubscribeDate.isNotEmpty &&
                startDate.compareTo(_maxSubscribeDate) > 0) {
              subscribeDateError =
                  'Ngày bắt đầu sử dụng không được vượt quá ngày kết thúc hợp đồng (${formatDateVi(_maxSubscribeDate)}).';
            }
          }

          final prorata = (selected == null || subscribeDateError.isNotEmpty)
              ? null
              : previewSubscriptionProrata(
                  unitPrice: unitPrice,
                  quantity: effQty,
                  startDate: startDate,
                );
          final fullMonthAmount = _amount(unitPrice) * effQty;

          final options = selectable.map((c) {
            final m = c as Map;
            final name = _str(m['name'], _str(m['service_name'], 'Dịch vụ'));
            final price = m['unit_price'] ?? m['price'] ?? 0;
            final u = _str(m['unit'], 'tháng');
            return AppSelectOption<String>(
              value: _str(m['id']),
              label: '$name — ${formatMoney(price)}/$u',
            );
          }).toList();

          Widget breakdownRow(String label, String value, {bool bold = false}) {
            return Padding(
              padding: const EdgeInsets.symmetric(vertical: 2),
              child: Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Expanded(
                    child: Text(label,
                        style: TextStyle(
                            fontFamily: 'Inter',
                            fontSize: bold ? 13 : 12,
                            fontWeight:
                                bold ? FontWeight.bold : FontWeight.w400,
                            color: bold
                                ? AppColors.primary700
                                : AppColors.slate600)),
                  ),
                  const SizedBox(width: 8),
                  Text(value,
                      style: TextStyle(
                          fontFamily: 'Inter',
                          fontSize: bold ? 13 : 12,
                          fontWeight: bold ? FontWeight.bold : FontWeight.w500,
                          color: bold
                              ? AppColors.primary700
                              : AppColors.slate800)),
                ],
              ),
            );
          }

          return SingleChildScrollView(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              mainAxisSize: MainAxisSize.min,
              children: [
                AppSelect<String>(
                  label: 'Dịch vụ cần đăng ký',
                  required: true,
                  value: serviceId.isEmpty ? null : serviceId,
                  options: options,
                  onChanged: (val) => setModalState(() {
                    serviceId = val ?? '';
                    qtyCtrl.text = '1';
                  }),
                ),
                const SizedBox(height: 12),
                Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Expanded(
                      child: AppInput(
                        label: 'Số lượng ($unit)',
                        controller: qtyCtrl,
                        keyboardType: TextInputType.number,
                        enabled: !(billingType == 'FIXED' && !isParking),
                        onChanged: (_) => setModalState(() {}),
                      ),
                    ),
                    const SizedBox(width: 12),
                    Expanded(
                      child: GestureDetector(
                        onTap: () async {
                          final initial =
                              DateTime.tryParse(startDateCtrl.text) ??
                                  DateTime.now();
                          final picked = await showDatePicker(
                            context: ctx,
                            initialDate: initial,
                            firstDate: DateTime(2000),
                            lastDate:
                                DateTime.now().add(const Duration(days: 730)),
                          );
                          if (picked != null) {
                            setModalState(
                                () => startDateCtrl.text = toInputDate(picked));
                          }
                        },
                        child: AbsorbPointer(
                          child: AppInput(
                            label: 'Ngày bắt đầu sử dụng',
                            controller: startDateCtrl,
                            readOnly: true,
                            error: subscribeDateError.isEmpty
                                ? null
                                : subscribeDateError,
                            rightElement: const Icon(LucideIcons.calendar,
                                size: 16, color: AppColors.slate400),
                          ),
                        ),
                      ),
                    ),
                  ],
                ),
                if (prorata != null) ...[
                  const SizedBox(height: 14),
                  Container(
                    padding: const EdgeInsets.all(12),
                    decoration: BoxDecoration(
                      color: AppColors.primary50,
                      borderRadius: BorderRadius.circular(12),
                      border: Border.all(color: AppColors.sky200),
                    ),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Row(
                          children: [
                            const Icon(LucideIcons.calculator,
                                size: 16, color: AppColors.primary700),
                            const SizedBox(width: 8),
                            Flexible(
                              child: Text(
                                  'Ước tính phí Pro-rata tháng đầu tiên',
                                  style: const TextStyle(
                                      fontFamily: 'Inter',
                                      fontSize: 12,
                                      fontWeight: FontWeight.w600,
                                      color: AppColors.primary700)),
                            ),
                          ],
                        ),
                        const SizedBox(height: 8),
                        breakdownRow(
                            'Phí trọn tháng ($effQty × ${formatMoney(unitPrice)}):',
                            '${formatMoney(fullMonthAmount)} / tháng'),
                        breakdownRow('Số ngày sử dụng thực tế tháng đầu:',
                            '${prorata.activeDays} / ${prorata.daysInMonth} ngày'),
                        // Legacy label kept for the existing resident_portal_test.dart assertion.
                        Padding(
                          padding: const EdgeInsets.symmetric(vertical: 2),
                          child: Text(
                            'Phí tạm tính tháng này (${prorata.daysRatio} ngày): ${prorata.formattedAmount}',
                            style: const TextStyle(
                                fontFamily: 'Inter',
                                fontSize: 11,
                                color: AppColors.slate500),
                          ),
                        ),
                        const Padding(
                          padding: EdgeInsets.symmetric(vertical: 6),
                          child: Divider(height: 1, color: AppColors.sky200),
                        ),
                        breakdownRow('Phí kỳ đầu tạm tính (Pro-rata):',
                            formatMoney(prorata.amount),
                            bold: true),
                        const SizedBox(height: 4),
                        const Row(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Icon(LucideIcons.info,
                                size: 14, color: AppColors.sky500),
                            SizedBox(width: 4),
                            Expanded(
                              child: Text(
                                'Các tháng tiếp theo sẽ tính tròn kỳ theo đơn giá niêm yết.',
                                style: TextStyle(
                                    fontFamily: 'Inter',
                                    fontSize: 11,
                                    color: AppColors.slate500),
                              ),
                            ),
                          ],
                        ),
                      ],
                    ),
                  ),
                ],
                if (isParking) ...[
                  const SizedBox(height: 12),
                  AppInput(
                    label: 'Biển số xe',
                    controller: plateCtrl,
                    icon: const Icon(LucideIcons.car,
                        size: 16, color: AppColors.slate400),
                    hint: 'VD: 59A1-123.45, Xe đạp #1 hoặc Chờ bấm biển',
                    inputFormatters: [
                      LengthLimitingTextInputFormatter(30),
                    ],
                  ),
                ],
                const SizedBox(height: 12),
                AppInput(
                  label: 'Ghi chú dịch vụ (tùy chọn)',
                  controller: noteCtrl,
                  multiline: true,
                  rows: 2,
                  hint: isParking
                      ? 'VD: Loại xe tay ga, ô đỗ hầm B1, mã thẻ từ...'
                      : 'VD: Khung giờ phục vụ, gói cước hoặc thỏa thuận riêng...',
                  inputFormatters: [
                    LengthLimitingTextInputFormatter(500),
                  ],
                ),
                const SizedBox(height: 20),
                Wrap(
                  alignment: WrapAlignment.end,
                  spacing: 8,
                  runSpacing: 8,
                  children: [
                    AppButton(
                      text: 'Hủy',
                      variant: AppButtonVariant.outline,
                      onPressed:
                          submitting ? null : () => Navigator.of(ctx).pop(),
                    ),
                    AppButton(
                      text: submitting ? 'Đang gửi...' : 'Xác nhận đăng ký',
                      loading: submitting,
                      disabled: subscribeDateError.isNotEmpty,
                      icon: const Icon(LucideIcons.checkCircle2,
                          size: 16, color: Colors.white),
                      onPressed: (submitting || subscribeDateError.isNotEmpty)
                          ? null
                          : () async {
                              if (serviceId.isEmpty) {
                                ref.read(toastProvider.notifier).warning(
                                    'Vui lòng chọn dịch vụ muốn đăng ký.');
                                return;
                              }
                              final plate = plateCtrl.text.trim();
                              if (isParking && plate.isEmpty) {
                                ref
                                    .read(toastProvider.notifier)
                                    .warning('Vui lòng nhập biển số xe.');
                                return;
                              }
                              setModalState(() => submitting = true);
                              try {
                                await ref
                                    .read(residentServiceProvider)
                                    .subscribeService(
                                  buildSubscribeServicePayload(
                                    contractId: cid,
                                    serviceId: serviceId,
                                    quantity:
                                        (billingType == 'FIXED' && !isParking)
                                            ? 1
                                            : effQty,
                                    startDate: startDate,
                                    note: noteCtrl.text.trim(),
                                    vehiclePlates: isParking ? [plate] : null,
                                  ),
                                );
                                if (ctx.mounted) Navigator.of(ctx).pop();
                                ref.read(toastProvider.notifier).success(
                                    'Đã gửi yêu cầu đăng ký dịch vụ, chờ Ban Quản Lý phê duyệt!');
                                await _fetchServices(force: true);
                              } catch (err) {
                                if (ctx.mounted) {
                                  setModalState(() => submitting = false);
                                }
                                ref.read(toastProvider.notifier).error(
                                    extractErrorMessage(
                                        err, 'Không thể đăng ký dịch vụ.'));
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
    final subId = _str(sub['subscription_id'], _str(sub['id']));
    final name = _str(sub['service_name'], _str(sub['name'], 'dịch vụ'));
    final unitPrice = sub['unit_price'] ?? sub['price'] ?? 0;
    final qty = _int(sub['quantity'], 1);
    final startDate = _str(sub['start_date']);
    final status = _str(sub['status']).toUpperCase();
    final plates = _plates(sub);

    final endDateCtrl = TextEditingController(text: todayVietnamYmd());
    final reasonCtrl = TextEditingController();
    bool submitting = false;
    final minCancelDate = todayVietnamYmd();
    final contractEnd = _maxSubscribeDate;

    AppModal.show(
      context: context,
      title: 'Hủy dịch vụ: $name',
      subtitle:
          'Chọn ngày ngừng sử dụng để hệ thống kết toán phí Pro-rata chính xác tới ngày hủy',
      child: StatefulBuilder(
        builder: (ctx, setModalState) {
          final endDate = _str(endDateCtrl.text).trim();
          String cancelDateError = '';
          if (endDate.isNotEmpty) {
            if (minCancelDate.isNotEmpty &&
                endDate.compareTo(minCancelDate) < 0) {
              cancelDateError =
                  'Ngày kết thúc sử dụng không được nhỏ hơn hôm nay (${formatDateVi(minCancelDate)}).';
            } else if (contractEnd.isNotEmpty &&
                endDate.compareTo(contractEnd) > 0) {
              cancelDateError =
                  'Ngày kết thúc sử dụng không được vượt quá ngày kết thúc hợp đồng (${formatDateVi(contractEnd)}).';
            }
          }

          final prorata = cancelDateError.isEmpty
              ? previewSubscriptionProrata(
                  unitPrice: unitPrice,
                  quantity: qty < 1 ? 1 : qty,
                  startDate: startDate,
                  endDate: endDate,
                )
              : null;

          return SingleChildScrollView(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              mainAxisSize: MainAxisSize.min,
              children: [
                if (plates.isNotEmpty)
                  Padding(
                    padding: const EdgeInsets.only(bottom: 12),
                    child: Wrap(
                      spacing: 6,
                      children: plates
                          .map((p) => AppBadge(
                                label: p,
                                variant: AppBadgeVariant.sky,
                                icon: const Icon(LucideIcons.car, size: 12),
                              ))
                          .toList(),
                    ),
                  ),
                GestureDetector(
                  onTap: () async {
                    final initial =
                        DateTime.tryParse(endDateCtrl.text) ?? DateTime.now();
                    final picked = await showDatePicker(
                      context: ctx,
                      initialDate: initial,
                      firstDate: DateTime(2000),
                      lastDate: DateTime.now().add(const Duration(days: 730)),
                    );
                    if (picked != null) {
                      setModalState(
                          () => endDateCtrl.text = toInputDate(picked));
                    }
                  },
                  child: AbsorbPointer(
                    child: AppInput(
                      label: 'Ngày kết thúc sử dụng',
                      controller: endDateCtrl,
                      readOnly: true,
                      error: cancelDateError.isEmpty ? null : cancelDateError,
                      icon: const Icon(LucideIcons.calendar,
                          size: 16, color: AppColors.slate400),
                    ),
                  ),
                ),
                if (status == 'ACTIVE' && prorata != null) ...[
                  const SizedBox(height: 12),
                  Container(
                    padding: const EdgeInsets.all(12),
                    decoration: BoxDecoration(
                      color: AppColors.amber50,
                      borderRadius: BorderRadius.circular(12),
                      border: Border.all(color: AppColors.amber200),
                    ),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        const Text('Tạm tính phí sử dụng đến ngày hủy:',
                            style: TextStyle(
                                fontFamily: 'Inter',
                                fontSize: 12,
                                fontWeight: FontWeight.w600,
                                color: AppColors.amber900)),
                        const SizedBox(height: 4),
                        Text(
                            '${prorata.activeDays}/${prorata.daysInMonth} ngày trong tháng = ${prorata.formattedAmount}',
                            style: const TextStyle(
                                fontFamily: 'Inter',
                                fontSize: 12,
                                color: AppColors.amber900)),
                      ],
                    ),
                  ),
                ],
                const SizedBox(height: 12),
                AppInput(
                  label: 'Lý do hủy dịch vụ (tùy chọn)',
                  controller: reasonCtrl,
                  multiline: true,
                  rows: 2,
                  hint: 'Ví dụ: Không còn nhu cầu gửi xe...',
                  inputFormatters: [LengthLimitingTextInputFormatter(500)],
                ),
                const SizedBox(height: 20),
                Wrap(
                  alignment: WrapAlignment.end,
                  spacing: 8,
                  runSpacing: 8,
                  children: [
                    AppButton(
                      text: 'Quay lại',
                      variant: AppButtonVariant.outline,
                      onPressed:
                          submitting ? null : () => Navigator.of(ctx).pop(),
                    ),
                    AppButton(
                      text:
                          submitting ? 'Đang xử lý...' : 'Xác nhận hủy dịch vụ',
                      variant: AppButtonVariant.danger,
                      loading: submitting,
                      disabled: cancelDateError.isNotEmpty,
                      onPressed: (submitting || cancelDateError.isNotEmpty)
                          ? null
                          : () async {
                              setModalState(() => submitting = true);
                              try {
                                await ref
                                    .read(residentServiceProvider)
                                    .cancelService(
                                  subId,
                                  buildCancelServicePayload(
                                    endDate: endDateCtrl.text.trim(),
                                    note: reasonCtrl.text.trim(),
                                  ),
                                );
                                if (ctx.mounted) Navigator.of(ctx).pop();
                                ref.read(toastProvider.notifier).success(
                                    'Đã gửi yêu cầu hủy dịch vụ thành công.');
                                await _fetchServices(force: true);
                              } catch (err) {
                                if (ctx.mounted) {
                                  setModalState(() => submitting = false);
                                }
                                ref.read(toastProvider.notifier).error(
                                    extractErrorMessage(
                                        err, 'Không thể hủy dịch vụ.'));
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

  void _openDetailModal(BuildContext context, Map<String, dynamic> sub) {
    final name = _str(sub['service_name'], _str(sub['name']));
    final status = _str(sub['status'], 'ACTIVE').toUpperCase();
    final unitPrice = sub['unit_price'] ?? sub['price'] ?? 0;
    final qty = _int(sub['quantity'], 1);
    final apt = _str(sub['apartment_code']);
    final plates = _plates(sub);
    final note = _str(sub['note']);
    final startDate = _str(sub['start_date']);
    final endDate = _str(sub['end_date']);
    final serviceId = _str(sub['service_id'], _str(sub['id']));
    final statusMeta = resolveStatusMeta(StatusDomain.subscription, status);
    final isCancelPending = status == 'CANCELLATION_PENDING';
    final canCancel = status == 'ACTIVE' || status == 'PENDING_APPROVAL';

    AppModal.show(
      context: context,
      title: 'Gói dịch vụ: $name',
      subtitle:
          apt.isNotEmpty ? 'Căn $apt' : 'Thông tin đăng ký dịch vụ căn hộ',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        mainAxisSize: MainAxisSize.min,
        children: [
          Container(
            padding: const EdgeInsets.all(14),
            decoration: BoxDecoration(
              color: AppColors.slate50,
              borderRadius: BorderRadius.circular(12),
              border: Border.all(color: AppColors.slate200),
            ),
            child: Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Text('Trạng thái',
                        style: TextStyle(
                            fontFamily: 'Inter',
                            fontSize: 12,
                            color: AppColors.slate500)),
                    const SizedBox(height: 4),
                    AppBadge.fromStatusMeta(statusMeta),
                  ],
                ),
                Column(
                  crossAxisAlignment: CrossAxisAlignment.end,
                  children: [
                    const Text('Đơn giá × Số lượng',
                        style: TextStyle(
                            fontFamily: 'Inter',
                            fontSize: 12,
                            color: AppColors.slate500)),
                    const SizedBox(height: 4),
                    Text('${formatMoney(unitPrice)} × $qty',
                        style: const TextStyle(
                            fontFamily: 'Inter',
                            fontSize: 16,
                            fontWeight: FontWeight.bold,
                            color: AppColors.primary700)),
                  ],
                ),
              ],
            ),
          ),
          const SizedBox(height: 12),
          Container(
            padding: const EdgeInsets.all(12),
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(12),
              border: Border.all(color: AppColors.slate200),
            ),
            child: Row(
              children: [
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      const Text('Ngày bắt đầu',
                          style: TextStyle(
                              fontFamily: 'Inter',
                              fontSize: 12,
                              color: AppColors.slate500)),
                      const SizedBox(height: 2),
                      Text(formatDate(startDate),
                          style: const TextStyle(
                              fontFamily: 'Inter',
                              fontSize: 13,
                              fontWeight: FontWeight.w600,
                              color: AppColors.slate900)),
                    ],
                  ),
                ),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      const Text('Ngày kết thúc',
                          style: TextStyle(
                              fontFamily: 'Inter',
                              fontSize: 12,
                              color: AppColors.slate500)),
                      const SizedBox(height: 2),
                      Text(
                          endDate.isNotEmpty
                              ? formatDate(endDate)
                              : 'Đang duy trì',
                          style: const TextStyle(
                              fontFamily: 'Inter',
                              fontSize: 13,
                              fontWeight: FontWeight.w600,
                              color: AppColors.slate900)),
                    ],
                  ),
                ),
              ],
            ),
          ),
          if (plates.isNotEmpty) ...[
            const SizedBox(height: 12),
            Wrap(
              spacing: 6,
              children: plates
                  .map((p) => AppBadge(
                        label: p,
                        variant: AppBadgeVariant.sky,
                        icon: const Icon(LucideIcons.car, size: 12),
                      ))
                  .toList(),
            ),
          ],
          if (note.isNotEmpty) ...[
            const SizedBox(height: 12),
            Container(
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(
                color: AppColors.slate50,
                borderRadius: BorderRadius.circular(12),
                border: Border.all(color: AppColors.slate200),
              ),
              child: Text('Ghi chú: $note',
                  style: const TextStyle(
                      fontFamily: 'Inter',
                      fontSize: 12,
                      color: AppColors.slate700)),
            ),
          ],
          const SizedBox(height: 20),
          Wrap(
            alignment: WrapAlignment.end,
            spacing: 8,
            runSpacing: 8,
            children: [
              AppButton(
                text: 'Đóng',
                variant: AppButtonVariant.outline,
                onPressed: () => Navigator.of(context).pop(),
              ),
              if (isCancelPending)
                AppButton(
                  text: 'Rút yêu cầu hủy',
                  variant: AppButtonVariant.outline,
                  onPressed: () {
                    Navigator.of(context).pop();
                    _handleWithdrawCancel(
                        _str(sub['subscription_id'], _str(sub['id'])));
                  },
                )
              else if (canCancel)
                AppButton(
                  text: status == 'PENDING_APPROVAL'
                      ? 'Hủy yêu cầu'
                      : 'Hủy dịch vụ',
                  variant: AppButtonVariant.danger,
                  onPressed: () {
                    Navigator.of(context).pop();
                    _openCancelModal(context, sub);
                  },
                )
              else if (_hasActiveContract && serviceId.isNotEmpty)
                AppButton(
                  text: 'Đăng ký lại',
                  icon: const Icon(LucideIcons.plus,
                      size: 16, color: Colors.white),
                  onPressed: () {
                    Navigator.of(context).pop();
                    _openSubscribeModal(context, {
                      'id': serviceId,
                      'name': name,
                      'unit_price': unitPrice
                    });
                  },
                ),
            ],
          ),
        ],
      ),
    );
  }

  Future<void> _handleWithdrawCancel(String subId) async {
    try {
      await ref.read(residentServiceProvider).withdrawCancelService(subId);
      ref
          .read(toastProvider.notifier)
          .success('Đã rút yêu cầu hủy dịch vụ thành công.');
      await _fetchServices(force: true);
    } catch (err) {
      ref.read(toastProvider.notifier).error(
          extractErrorMessage(err, 'Không thể rút yêu cầu hủy dịch vụ.'));
    }
  }

  Widget _buildSubscriptionCard(BuildContext context, dynamic s) {
    final sub = s is Map ? Map<String, dynamic>.from(s) : <String, dynamic>{};
    final subId = _str(sub['subscription_id'], _str(sub['id']));
    final name = _str(sub['service_name'], _str(sub['name'], 'Dịch vụ'));
    final status = _str(sub['status'], 'ACTIVE').toUpperCase();
    final cat = _categoryMeta(sub['category'] ?? sub['service_category']);
    final unitPrice = sub['unit_price'] ?? sub['price'] ?? 0;
    final qty = _int(sub['quantity'], 1);
    final unit = _str(sub['unit'], 'gói');
    final apt = _str(sub['apartment_code']);
    final plates = _plates(sub);
    final note = _str(sub['note']);
    final startDate = _str(sub['start_date']);
    final endDate = _str(sub['end_date']);
    final prorataAmount = _amount(sub['prorata_amount']);
    final monthlyTotal = _amount(unitPrice) * (qty < 1 ? 1 : qty);
    final statusMeta = resolveStatusMeta(StatusDomain.subscription, status);
    final isCancelPending =
        status == 'CANCELLATION_PENDING' || status == 'CANCEL_REQUESTED';
    final canCancel = status == 'ACTIVE' || status == 'PENDING_APPROVAL';

    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: AppColors.slate200),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          GestureDetector(
            onTap: () => _openDetailModal(context, sub),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                _iconBox(cat),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Wrap(
                        spacing: 8,
                        runSpacing: 4,
                        crossAxisAlignment: WrapCrossAlignment.center,
                        children: [
                          Text(name,
                              style: const TextStyle(
                                  fontFamily: 'Inter',
                                  fontSize: 14,
                                  fontWeight: FontWeight.bold,
                                  color: AppColors.slate900)),
                          AppBadge.fromStatusMeta(statusMeta),
                        ],
                      ),
                      const SizedBox(height: 2),
                      Text(cat.label,
                          style: const TextStyle(
                              fontFamily: 'Inter',
                              fontSize: 11,
                              color: AppColors.slate500)),
                      const SizedBox(height: 4),
                      Text(
                        'Số lượng: $qty $unit • Đơn giá: ${formatMoney(unitPrice)}'
                        '${apt.isNotEmpty ? ' • Căn $apt' : ''}',
                        style: const TextStyle(
                            fontFamily: 'Inter',
                            fontSize: 12,
                            color: AppColors.slate600),
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
          if (plates.isNotEmpty) ...[
            const SizedBox(height: 6),
            Wrap(
              spacing: 6,
              children: plates
                  .map((p) => AppBadge(
                        label: p,
                        variant: AppBadgeVariant.sky,
                        icon: const Icon(LucideIcons.car, size: 12),
                      ))
                  .toList(),
            ),
          ],
          if (note.isNotEmpty) ...[
            const SizedBox(height: 6),
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
              decoration: BoxDecoration(
                color: AppColors.slate50,
                borderRadius: BorderRadius.circular(8),
                border: Border.all(color: AppColors.slate200),
              ),
              child: Text('Ghi chú: $note',
                  style: const TextStyle(
                      fontFamily: 'Inter',
                      fontSize: 11,
                      color: AppColors.slate600)),
            ),
          ],
          const SizedBox(height: 12),
          Container(
            padding: const EdgeInsets.only(top: 12),
            decoration: const BoxDecoration(
              border: Border(top: BorderSide(color: AppColors.slate100)),
            ),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.end,
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        'Bắt đầu: ${formatDate(startDate)}'
                        '${endDate.isNotEmpty ? ' • Kết thúc: ${formatDate(endDate)}' : ''}'
                        '${prorataAmount > 0 ? ' • Kỳ đầu (Pro-rata): ${formatMoney(prorataAmount)}' : ''}',
                        style: const TextStyle(
                            fontFamily: 'Inter',
                            fontSize: 11,
                            color: AppColors.slate500),
                      ),
                      const SizedBox(height: 2),
                      Text('${formatMoney(monthlyTotal)} / tháng',
                          style: const TextStyle(
                              fontFamily: 'Inter',
                              fontSize: 14,
                              fontWeight: FontWeight.bold,
                              color: AppColors.primary700)),
                    ],
                  ),
                ),
                if (isCancelPending || canCancel) ...[
                  const SizedBox(width: 8),
                  AppButton(
                    text: isCancelPending
                        ? 'Rút yêu cầu hủy'
                        : (status == 'PENDING_APPROVAL'
                            ? 'Hủy yêu cầu'
                            : 'Hủy dịch vụ'),
                    size: AppButtonSize.xs,
                    variant: AppButtonVariant.outline,
                    onPressed: isCancelPending
                        ? () => _handleWithdrawCancel(subId)
                        : () => _openCancelModal(context, sub),
                  ),
                ],
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildCatalogCard(BuildContext context, dynamic c) {
    final item = c is Map ? Map<String, dynamic>.from(c) : <String, dynamic>{};
    final id = _str(item['id'], _str(item['service_id']));
    final name = _str(item['name'], _str(item['service_name'], 'Dịch vụ'));
    final code = _str(item['code'], _str(item['service_code']));
    final desc = _str(item['description']);
    final unitPrice = item['unit_price'] ?? item['price'] ?? 0;
    final unit = _str(item['unit'], 'tháng');
    final cat = _categoryMeta(item['category'] ?? item['service_category']);
    final isMetered = _str(item['billing_type']).toUpperCase() == 'METERED';
    final alreadySubscribed = _activeSubscriptions.any((s) {
      if (s is! Map) return false;
      final sid = _str(s['service_id'], _str(s['id']));
      return sid.isNotEmpty && sid == id;
    });

    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: AppColors.slate200),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              _iconBox(cat),
              const SizedBox(width: 8),
              Flexible(
                child: Wrap(
                  alignment: WrapAlignment.end,
                  spacing: 6,
                  runSpacing: 4,
                  children: [
                    if (alreadySubscribed)
                      const AppBadge(
                          label: 'Đã đăng ký',
                          variant: AppBadgeVariant.emerald,
                          dot: true),
                    AppBadge(label: cat.label, variant: AppBadgeVariant.slate),
                  ],
                ),
              ),
            ],
          ),
          const SizedBox(height: 10),
          Wrap(
            spacing: 6,
            crossAxisAlignment: WrapCrossAlignment.center,
            children: [
              Text(name,
                  style: const TextStyle(
                      fontFamily: 'Inter',
                      fontSize: 14,
                      fontWeight: FontWeight.bold,
                      color: AppColors.slate900)),
              if (code.isNotEmpty)
                Text('#$code',
                    style: const TextStyle(
                        fontFamily: 'monospace',
                        fontSize: 11,
                        color: AppColors.slate400)),
            ],
          ),
          if (desc.isNotEmpty) ...[
            const SizedBox(height: 4),
            Text(desc,
                style: const TextStyle(
                    fontFamily: 'Inter',
                    fontSize: 12,
                    color: AppColors.slate500)),
          ],
          const SizedBox(height: 16),
          Container(
            padding: const EdgeInsets.only(top: 12),
            decoration: const BoxDecoration(
              border: Border(top: BorderSide(color: AppColors.slate100)),
            ),
            child: Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              crossAxisAlignment: CrossAxisAlignment.end,
              children: [
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      const Text('Đơn giá niêm yết',
                          style: TextStyle(
                              fontFamily: 'Inter',
                              fontSize: 11,
                              color: AppColors.slate400)),
                      const SizedBox(height: 2),
                      Text.rich(
                        TextSpan(
                          children: [
                            TextSpan(
                              text: formatMoney(unitPrice),
                              style: const TextStyle(
                                  fontFamily: 'Inter',
                                  fontSize: 14,
                                  fontWeight: FontWeight.bold,
                                  color: AppColors.primary600),
                            ),
                            TextSpan(
                              text: '/$unit',
                              style: const TextStyle(
                                  fontFamily: 'Inter',
                                  fontSize: 11,
                                  color: AppColors.slate500),
                            ),
                          ],
                        ),
                      ),
                    ],
                  ),
                ),
                const SizedBox(width: 8),
                if (isMetered)
                  const AppBadge(
                      label: 'Tính theo chỉ số', variant: AppBadgeVariant.sky)
                else
                  AppButton(
                    text: alreadySubscribed ? 'Đăng ký thêm' : 'Đăng ký',
                    size: AppButtonSize.sm,
                    variant: alreadySubscribed
                        ? AppButtonVariant.soft
                        : AppButtonVariant.primary,
                    onPressed: () => _openSubscribeModal(context, item),
                  ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildHistorySection(List<dynamic> history) {
    return Padding(
      padding: const EdgeInsets.only(top: 20),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          GestureDetector(
            onTap: () =>
                setState(() => _showCancelledHistory = !_showCancelledHistory),
            child: Text(
              _showCancelledHistory
                  ? 'Ẩn lịch sử dịch vụ đã hủy / ngừng sử dụng'
                  : 'Xem lịch sử dịch vụ đã hủy (${history.length})',
              style: const TextStyle(
                  fontFamily: 'Inter',
                  fontSize: 12,
                  fontWeight: FontWeight.w500,
                  color: AppColors.slate500),
            ),
          ),
          if (_showCancelledHistory) ...[
            const SizedBox(height: 12),
            Column(
              children: history.map((h) {
                final sub = h is Map ? h : const {};
                final name = _str(sub['service_name'], _str(sub['name']));
                final qty = _int(sub['quantity'], 1);
                final plates = _plates(sub);
                final note = _str(sub['note']);
                return Container(
                  margin: const EdgeInsets.only(bottom: 8),
                  padding:
                      const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
                  decoration: BoxDecoration(
                    color: AppColors.slate50,
                    borderRadius: BorderRadius.circular(8),
                    border: Border.all(color: AppColors.slate200),
                  ),
                  child: Row(
                    mainAxisAlignment: MainAxisAlignment.spaceBetween,
                    children: [
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              '$name (SL: $qty • Từ ${formatDate(sub['start_date'])}'
                              '${sub['end_date'] != null ? ' đến ${formatDate(sub['end_date'])}' : ''})',
                              style: const TextStyle(
                                  fontFamily: 'Inter',
                                  fontSize: 12,
                                  color: AppColors.slate500),
                            ),
                            if (plates.isNotEmpty)
                              Padding(
                                padding: const EdgeInsets.only(top: 4),
                                child: Wrap(
                                  spacing: 6,
                                  children: plates
                                      .map((p) => AppBadge(
                                            label: p,
                                            variant: AppBadgeVariant.sky,
                                          ))
                                      .toList(),
                                ),
                              ),
                            if (note.isNotEmpty)
                              Text('Ghi chú: $note',
                                  style: const TextStyle(
                                      fontFamily: 'Inter',
                                      fontSize: 12,
                                      color: AppColors.slate600)),
                          ],
                        ),
                      ),
                      AppBadge.fromStatusMeta(resolveStatusMeta(
                          StatusDomain.subscription,
                          _str(sub['status']).toUpperCase())),
                    ],
                  ),
                );
              }).toList(),
            ),
          ],
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final activeSubscriptions = _activeSubscriptions;
    final historySubscriptions = _historySubscriptions;
    final catalog = _catalog;
    final showHeaderCta = _hasActiveContract && catalog.isNotEmpty;

    return RefreshIndicator(
      onRefresh: () async {
        await widget.onRefreshOverview();
        await _fetchServices(force: true);
      },
      child: SingleChildScrollView(
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            if (_loading && _subscriptions.isEmpty)
              const Center(
                  child: Padding(
                      padding: EdgeInsets.all(16),
                      child: CircularProgressIndicator()))
            else
              AppCard(
                header: AppCardHeader(
                  title: 'Dịch vụ căn hộ đang đăng ký',
                  subtitle:
                      'Quản lý các gói dịch vụ định kỳ gắn với hợp đồng thuê hiện tại của bạn',
                  action: showHeaderCta
                      ? AppButton(
                          text: 'Đăng ký thêm dịch vụ',
                          size: AppButtonSize.sm,
                          icon: const Icon(LucideIcons.plus,
                              size: 16, color: Colors.white),
                          onPressed: () => _openSubscribeModal(
                              context, const {},
                              preselect: false),
                        )
                      : null,
                ),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    if (activeSubscriptions.isEmpty)
                      const Text(
                        'Chưa có dịch vụ đăng ký nào đang hoạt động',
                        style:
                            TextStyle(color: AppColors.slate500, fontSize: 13),
                      )
                    else
                      _responsiveGrid(
                        gridKey: 'services-subscription-grid',
                        maxCols: 2,
                        count: activeSubscriptions.length,
                        builder: (i) => _buildSubscriptionCard(
                            context, activeSubscriptions[i]),
                      ),
                    if (historySubscriptions.isNotEmpty)
                      _buildHistorySection(historySubscriptions),
                  ],
                ),
              ),
            const SizedBox(height: 16),
            AppCard(
              header: const AppCardHeader(
                title: 'Danh mục dịch vụ Tòa nhà cung cấp',
                subtitle:
                    'Chọn dịch vụ tiện ích để đăng ký bổ sung — tự động tính phí Pro-rata theo số ngày thực tế trong tháng đầu',
              ),
              child: catalog.isEmpty
                  ? const Text(
                      'Chưa có danh mục dịch vụ mở rộng',
                      style: TextStyle(color: AppColors.slate500, fontSize: 13),
                    )
                  : _responsiveGrid(
                      gridKey: 'services-catalog-grid',
                      maxCols: 3,
                      count: catalog.length,
                      builder: (i) => _buildCatalogCard(context, catalog[i]),
                    ),
            ),
          ],
        ),
      ),
    );
  }
}
