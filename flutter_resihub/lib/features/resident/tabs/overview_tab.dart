import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../../../core/constants/statuses.dart';
import '../../../core/theme/app_colors.dart';
import '../../../core/utils/deposit_ui_helpers.dart';
import '../../../core/utils/format.dart';
import '../../../core/utils/resident_overview_helpers.dart';
import '../../../core/utils/validation.dart';
import '../../../shared/providers/notification_provider.dart';
import '../../../shared/providers/toast_provider.dart';
import '../../../shared/widgets/common/bank_select.dart';
import '../../../shared/widgets/common/status_badge.dart';
import '../../../shared/widgets/ui/app_badge.dart';
import '../../../shared/widgets/ui/app_button.dart';
import '../../../shared/widgets/ui/app_card.dart';
import '../../../shared/widgets/ui/app_input.dart';
import '../../../shared/widgets/ui/app_modal.dart';
import '../services/resident_service.dart';

class OverviewTab extends ConsumerStatefulWidget {
  final Map<String, dynamic>? overview;
  final int openRequestsCount;
  final Future<void> Function() onRefreshOverview;
  final void Function(String tab, [Map<String, dynamic>? extra]) onNavigateTab;

  const OverviewTab({
    super.key,
    required this.overview,
    this.openRequestsCount = 0,
    required this.onRefreshOverview,
    required this.onNavigateTab,
  });

  @override
  ConsumerState<OverviewTab> createState() => _OverviewTabState();
}

class _OverviewTabState extends ConsumerState<OverviewTab> {
  void _openApplicationModal(BuildContext context, {String? apartmentId}) {
    final overview = widget.overview ?? const {};
    final user = overview['user'] is Map ? overview['user'] as Map : const {};

    final fullNameCtrl = TextEditingController(text: user['full_name']?.toString() ?? '');
    final phoneCtrl = TextEditingController(text: user['phone']?.toString() ?? '');
    final idNumberCtrl = TextEditingController(text: user['id_number']?.toString() ?? '');
    final addressCtrl = TextEditingController(text: user['address']?.toString() ?? '');
    final jobCtrl = TextEditingController();
    final emergencyNameCtrl = TextEditingController();
    final emergencyPhoneCtrl = TextEditingController();

    bool submitting = false;

    AppModal.show(
      context: context,
      title: 'Nộp hồ sơ thuê căn hộ',
      subtitle: 'Vui lòng xác nhận thông tin cư trú để ban quản lý lập hợp đồng thuê.',
      child: StatefulBuilder(
        builder: (ctx, setModalState) {
          return SingleChildScrollView(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                AppInput(
                  label: 'Họ và tên *',
                  controller: fullNameCtrl,
                  hint: 'Nguyễn Văn A',
                ),
                const SizedBox(height: 12),
                AppInput(
                  label: 'Số điện thoại *',
                  controller: phoneCtrl,
                  keyboardType: TextInputType.phone,
                ),
                const SizedBox(height: 12),
                AppInput(
                  label: 'Số CCCD/Hộ chiếu *',
                  controller: idNumberCtrl,
                  keyboardType: TextInputType.number,
                ),
                const SizedBox(height: 12),
                AppInput(
                  label: 'Địa chỉ thường trú',
                  controller: addressCtrl,
                ),
                const SizedBox(height: 12),
                AppInput(
                  label: 'Nghề nghiệp',
                  controller: jobCtrl,
                ),
                const SizedBox(height: 12),
                AppInput(
                  label: 'Người liên hệ khẩn cấp',
                  controller: emergencyNameCtrl,
                ),
                const SizedBox(height: 12),
                AppInput(
                  label: 'SĐT người liên hệ khẩn cấp',
                  controller: emergencyPhoneCtrl,
                  keyboardType: TextInputType.phone,
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
                      text: submitting ? 'Đang gửi...' : 'Gửi hồ sơ',
                      loading: submitting,
                      onPressed: submitting
                          ? null
                          : () async {
                              final name = fullNameCtrl.text.trim();
                              final phone = phoneCtrl.text.trim();
                              if (name.isEmpty || phone.isEmpty) {
                                ref
                                    .read(toastProvider.notifier)
                                    .error('Vui lòng điền họ tên và số điện thoại.');
                                return;
                              }

                              setModalState(() => submitting = true);
                              try {
                                await ref
                                    .read(residentServiceProvider)
                                    .submitRentalApplication({
                                  if (apartmentId != null && apartmentId.isNotEmpty)
                                    'desired_apartment_id': apartmentId,
                                  'full_name': name,
                                  'phone': phone,
                                  'id_number': idNumberCtrl.text.trim(),
                                  'address': addressCtrl.text.trim(),
                                  'job_title': jobCtrl.text.trim(),
                                  'emergency_contact_name': emergencyNameCtrl.text.trim(),
                                  'emergency_contact_phone': emergencyPhoneCtrl.text.trim(),
                                });
                                if (ctx.mounted) {
                                  Navigator.of(ctx).pop();
                                }
                                ref
                                    .read(toastProvider.notifier)
                                    .success('Đã gửi hồ sơ thuê thành công.');
                                await widget.onRefreshOverview();
                              } catch (err) {
                                setModalState(() => submitting = false);
                                ref
                                    .read(toastProvider.notifier)
                                    .error(extractErrorMessage(err, 'Không thể gửi hồ sơ thuê.'));
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

  void _openReservationBankModal(BuildContext context, Map<String, dynamic> rsv) {
    final rsvId = rsv['reservation_id']?.toString() ?? rsv['id']?.toString() ?? '';
    String bankName = rsv['bank_name']?.toString() ?? '';
    String? bankCode = rsv['bank_code']?.toString();
    String? bankBin = rsv['bank_bin']?.toString();
    final accNumCtrl = TextEditingController(text: rsv['account_number']?.toString() ?? '');
    final accHolderCtrl = TextEditingController(text: rsv['account_holder']?.toString() ?? '');

    bool saving = false;

    AppModal.show(
      context: context,
      title: 'Tài khoản nhận hoàn tiền giữ chỗ',
      subtitle:
          'Căn ${rsv['apartment_code'] ?? ''} • Tiền hoàn: ${formatMoney(rsv['refunded_amount'] ?? 0)}',
      child: StatefulBuilder(
        builder: (ctx, setModalState) {
          return Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              BankSelect(
                value: bankName,
                onBankChange: (nextVal, bank) {
                  setModalState(() {
                    bankName = nextVal;
                    bankCode = bank?['code']?.toString();
                    bankBin = bank?['bin']?.toString();
                  });
                },
              ),
              const SizedBox(height: 12),
              AppInput(
                label: 'Số tài khoản *',
                controller: accNumCtrl,
                keyboardType: TextInputType.number,
              ),
              const SizedBox(height: 12),
              AppInput(
                label: 'Tên chủ tài khoản (in hoa không dấu) *',
                controller: accHolderCtrl,
              ),
              const SizedBox(height: 20),
              Row(
                mainAxisAlignment: MainAxisAlignment.end,
                children: [
                  AppButton(
                    text: 'Đóng',
                    variant: AppButtonVariant.outline,
                    onPressed: saving ? null : () => Navigator.of(ctx).pop(),
                  ),
                  const SizedBox(width: 8),
                  AppButton(
                    text: saving ? 'Đang lưu...' : 'Xác nhận tài khoản',
                    loading: saving,
                    onPressed: saving
                        ? null
                        : () async {
                            final acc = accNumCtrl.text.trim();
                            final holder = accHolderCtrl.text.trim();
                            if (bankName.isEmpty || acc.isEmpty || holder.isEmpty) {
                              ref
                                  .read(toastProvider.notifier)
                                  .error('Vui lòng điền đầy đủ thông tin ngân hàng.');
                              return;
                            }

                            setModalState(() => saving = true);
                            try {
                              await ref
                                  .read(residentServiceProvider)
                                  .updateReservationRefundBankInfo(rsvId, {
                                'bank_name': bankName,
                                if (bankCode != null) 'bank_code': bankCode,
                                if (bankBin != null) 'bank_bin': bankBin,
                                'account_number': acc,
                                'account_holder': holder.toUpperCase(),
                              });
                              if (ctx.mounted) {
                                Navigator.of(ctx).pop();
                              }
                              ref
                                  .read(toastProvider.notifier)
                                  .success('Đã cập nhật thông tin tài khoản hoàn tiền.');
                              await widget.onRefreshOverview();
                            } catch (err) {
                              setModalState(() => saving = false);
                              ref.read(toastProvider.notifier).error(
                                    extractErrorMessage(
                                        err, 'Không thể cập nhật tài khoản ngân hàng.'),
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

  Widget _heroBadge({
    required IconData icon,
    required String label,
    required Color background,
    Color foreground = Colors.white,
    Color border = const Color(0x40FFFFFF),
  }) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
      decoration: BoxDecoration(
        color: background,
        borderRadius: BorderRadius.circular(999),
        border: Border.all(color: border),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(icon, size: 14, color: foreground),
          const SizedBox(width: 6),
          Flexible(
            child: Text(
              label,
              style: TextStyle(
                fontFamily: 'Inter',
                fontSize: 12,
                fontWeight: FontWeight.w600,
                color: foreground,
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _heroSpec(IconData icon, String label, String value) {
    return SizedBox(
      width: 150,
      child: Row(
        children: [
          Container(
            width: 32,
            height: 32,
            decoration: BoxDecoration(
              color: Colors.white.withValues(alpha: 0.15),
              borderRadius: BorderRadius.circular(8),
            ),
            child: Icon(icon, size: 16, color: const Color(0xFFE0F2FE)),
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  label,
                  style: const TextStyle(
                    fontFamily: 'Inter',
                    fontSize: 11,
                    color: Color(0xFFBAE6FD),
                  ),
                ),
                const SizedBox(height: 2),
                Text(
                  value,
                  style: const TextStyle(
                    fontFamily: 'Inter',
                    fontSize: 14,
                    fontWeight: FontWeight.bold,
                    color: Colors.white,
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final ov = widget.overview ?? const {};
    final contract = ov['active_contract'] is Map
        ? ov['active_contract'] as Map<String, dynamic>
        : (ov['contract'] is Map ? ov['contract'] as Map<String, dynamic> : null);

    // Hero card values (parity: OverviewTab.jsx:1089-1205).
    final user = ov['user'] is Map ? ov['user'] as Map : const {};
    final fullName = user['full_name']?.toString().trim() ?? '';
    final contractStatus = contract?['contract_status']?.toString() ??
        contract?['status']?.toString() ??
        '';
    final isFutureContract = contract?['is_future_contract'] == true ||
        contract?['is_future_contract']?.toString().toLowerCase() == 'true';
    final daysRemaining = contract != null
        ? getResidentDaysRemaining(contract['end_date'])
        : null;
    final floorName = contract?['floor_name']?.toString().trim() ?? '';
    final buildingName = contract?['building_name']?.toString().trim() ?? '';
    final buildingAddress = contract?['building_address']?.toString().trim() ?? '';
    final amenities = contract != null
        ? parseResidentAmenities(contract['amenities'])
        : const <String>[];

    final rawReservations = ov['reservations'] is List
        ? ov['reservations'] as List
        : (ov['reservation'] is Map ? [ov['reservation']] : const []);
    final reservations = rawReservations.whereType<Map<String, dynamic>>().toList();

    final unreadCount = ref.watch(notificationProvider).unreadCount;
    final currentAmountDue = ov['current_amount_due'] is num
        ? ov['current_amount_due'] as num
        : num.tryParse(ov['current_amount_due']?.toString() ?? '0') ?? 0;
    final latestInvoice = ov['latest_invoice'] is Map ? ov['latest_invoice'] as Map : null;

    return RefreshIndicator(
      onRefresh: widget.onRefreshOverview,
      child: SingleChildScrollView(
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            // Prospect Reservation Banner(s)
            if (reservations.isNotEmpty) ...[
              ...reservations.map((r) {
                final aptCode = r['apartment_code']?.toString() ?? '';
                final bldName = r['building_name']?.toString() ?? '';
                final status = r['status']?.toString() ?? r['reservation_status']?.toString() ?? '';
                final holdAmount = r['amount'] ?? r['hold_amount'] ?? 0;
                final canUpdateBank = canResidentUpdateReservationBankInfo(r);

                return Container(
                  margin: const EdgeInsets.only(bottom: 16),
                  decoration: BoxDecoration(
                    color: Colors.amber.shade50,
                    borderRadius: BorderRadius.circular(16),
                    border: Border.all(color: Colors.amber.shade200),
                  ),
                  padding: const EdgeInsets.all(16),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        mainAxisAlignment: MainAxisAlignment.spaceBetween,
                        children: [
                          Row(
                            children: [
                              Container(
                                padding: const EdgeInsets.all(8),
                                decoration: BoxDecoration(
                                  color: Colors.amber.shade100,
                                  borderRadius: BorderRadius.circular(10),
                                ),
                                child: const Icon(LucideIcons.sparkles,
                                    size: 20, color: Colors.amber),
                              ),
                              const SizedBox(width: 10),
                              Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  Text(
                                    'Giữ chỗ căn $aptCode${bldName.isNotEmpty ? ' — $bldName' : ''}',
                                    style: const TextStyle(
                                      fontFamily: 'Inter',
                                      fontSize: 15,
                                      fontWeight: FontWeight.bold,
                                      color: AppColors.slate900,
                                    ),
                                  ),
                                  const SizedBox(height: 2),
                                  Text(
                                    'Tiền giữ chỗ: ${formatMoney(holdAmount)}',
                                    style: const TextStyle(
                                      fontFamily: 'Inter',
                                      fontSize: 12,
                                      color: AppColors.slate600,
                                    ),
                                  ),
                                ],
                              ),
                            ],
                          ),
                          AppBadge(
                            label: status == 'HELD'
                                ? 'Đang giữ chỗ'
                                : status == 'PENDING_CONFIRM'
                                    ? 'Chờ xác nhận'
                                    : status == 'APPROVED_PENDING_PAYOUT'
                                        ? 'Chờ hoàn tiền'
                                        : status,
                            variant: status == 'HELD'
                                ? AppBadgeVariant.emerald
                                : AppBadgeVariant.amber,
                          ),
                        ],
                      ),
                      const SizedBox(height: 12),
                      Row(
                        mainAxisAlignment: MainAxisAlignment.end,
                        children: [
                          if (canUpdateBank) ...[
                            AppButton(
                              text: 'Cập nhật TK hoàn tiền',
                              size: AppButtonSize.sm,
                              variant: AppButtonVariant.outline,
                              icon: const Icon(LucideIcons.creditCard, size: 14),
                              onPressed: () => _openReservationBankModal(context, r),
                            ),
                            const SizedBox(width: 8),
                          ],
                          AppButton(
                            text: 'Nộp hồ sơ thuê',
                            size: AppButtonSize.sm,
                            icon: const Icon(LucideIcons.fileText, size: 14),
                            onPressed: () => _openApplicationModal(
                              context,
                              apartmentId: r['apartment_id']?.toString(),
                            ),
                          ),
                        ],
                      ),
                    ],
                  ),
                );
              }),
            ],

            // Active Resident Apartment Hero Banner (parity: OverviewTab.jsx:1089-1205)
            if (contract != null) ...[
              Container(
                key: const Key('resident-overview-hero'),
                decoration: BoxDecoration(
                  gradient: const LinearGradient(
                    colors: [AppColors.primary600, AppColors.secondary600],
                    begin: Alignment.topLeft,
                    end: Alignment.bottomRight,
                  ),
                  borderRadius: BorderRadius.circular(20),
                  boxShadow: const [
                    BoxShadow(
                      color: Color.fromRGBO(37, 99, 235, 0.2),
                      blurRadius: 16,
                      offset: Offset(0, 6),
                    ),
                  ],
                ),
                padding: const EdgeInsets.all(20),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    // Status badges — Wrap keeps them on multiple lines at 390px.
                    Wrap(
                      spacing: 8,
                      runSpacing: 8,
                      crossAxisAlignment: WrapCrossAlignment.center,
                      children: [
                        _heroBadge(
                          icon: LucideIcons.home,
                          label: isFutureContract
                              ? 'Hợp đồng sắp hiệu lực (${formatDate(contract['start_date'])})'
                              : contractStatus == 'TERMINATION_PENDING'
                                  ? 'Căn hộ đang chờ bàn giao / thanh lý'
                                  : 'Căn hộ đang cư trú',
                          background: Colors.white.withValues(alpha: 0.20),
                        ),
                        StatusBadge(status: contractStatus, dot: false),
                        if (contractStatus == 'TERMINATION_PENDING' &&
                            contract['terminated_at'] != null)
                          _heroBadge(
                            icon: LucideIcons.clock,
                            label:
                                'Dự kiến trả phòng: ${formatDate(contract['terminated_at'])}',
                            background: const Color(0xFFFBBF24),
                            foreground: const Color(0xFF0F172A),
                            border: Colors.transparent,
                          )
                        else if (daysRemaining != null &&
                            daysRemaining >= 0 &&
                            daysRemaining <= 30)
                          _heroBadge(
                            icon: LucideIcons.circleAlert,
                            label: 'Còn $daysRemaining ngày hết hạn HĐ',
                            background: const Color(0xFFFBBF24),
                            foreground: const Color(0xFF0F172A),
                            border: Colors.transparent,
                          ),
                      ],
                    ),
                    const SizedBox(height: 14),
                    Text(
                      'Xin chào, ${fullName.isEmpty ? 'Cư dân' : fullName}',
                      style: const TextStyle(
                        fontFamily: 'Inter',
                        fontSize: 14,
                        color: Color(0xFFE0F2FE),
                      ),
                    ),
                    const SizedBox(height: 2),
                    Text(
                      'Căn hộ ${contract['apartment_code'] ?? '---'}'
                      '${floorName.isNotEmpty ? ' • $floorName' : ''}',
                      style: const TextStyle(
                        fontFamily: 'Inter',
                        fontSize: 24,
                        fontWeight: FontWeight.bold,
                        color: Colors.white,
                      ),
                    ),
                    if (buildingName.isNotEmpty || buildingAddress.isNotEmpty) ...[
                      const SizedBox(height: 6),
                      Row(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          const Icon(LucideIcons.building2,
                              size: 16, color: Color(0xFFBAE6FD)),
                          const SizedBox(width: 6),
                          Expanded(
                            child: Text(
                              '$buildingName'
                              '${buildingAddress.isNotEmpty ? ' — $buildingAddress' : ''}',
                              style: const TextStyle(
                                fontFamily: 'Inter',
                                fontSize: 13,
                                color: Color(0xFFE0F2FE),
                              ),
                            ),
                          ),
                        ],
                      ),
                    ],
                    const SizedBox(height: 14),
                    const Text(
                      'TIỆN NGHI BÀN GIAO CĂN HỘ',
                      style: TextStyle(
                        fontFamily: 'Inter',
                        fontSize: 11,
                        fontWeight: FontWeight.w600,
                        color: Color(0xFFBAE6FD),
                      ),
                    ),
                    const SizedBox(height: 8),
                    if (amenities.isNotEmpty)
                      Wrap(
                        spacing: 6,
                        runSpacing: 6,
                        children: [
                          for (final amenity in amenities)
                            Container(
                              padding: const EdgeInsets.symmetric(
                                  horizontal: 8, vertical: 5),
                              decoration: BoxDecoration(
                                color: Colors.white.withValues(alpha: 0.15),
                                borderRadius: BorderRadius.circular(8),
                                border: Border.all(
                                    color: const Color(0x33FFFFFF)),
                              ),
                              child: Row(
                                mainAxisSize: MainAxisSize.min,
                                children: [
                                  const Icon(LucideIcons.checkCircle2,
                                      size: 14, color: Color(0xFF6EE7B7)),
                                  const SizedBox(width: 5),
                                  Text(
                                    amenity,
                                    style: const TextStyle(
                                      fontFamily: 'Inter',
                                      fontSize: 12,
                                      fontWeight: FontWeight.w500,
                                      color: Colors.white,
                                    ),
                                  ),
                                ],
                              ),
                            ),
                        ],
                      )
                    else
                      const Text(
                        'Danh mục tiện nghi theo biên bản bàn giao căn hộ.',
                        style: TextStyle(
                          fontFamily: 'Inter',
                          fontSize: 12,
                          fontStyle: FontStyle.italic,
                          color: Color(0xFFE2E8F0),
                        ),
                      ),
                    const SizedBox(height: 16),
                    Container(
                      width: double.infinity,
                      padding: const EdgeInsets.all(14),
                      decoration: BoxDecoration(
                        color: Colors.white.withValues(alpha: 0.10),
                        borderRadius: BorderRadius.circular(12),
                        border: Border.all(color: const Color(0x26FFFFFF)),
                      ),
                      child: Wrap(
                        spacing: 12,
                        runSpacing: 12,
                        children: [
                          _heroSpec(
                            LucideIcons.maximize2,
                            'Diện tích',
                            (contract['area_m2'] == null ||
                                    contract['area_m2'].toString().isEmpty)
                                ? '—'
                                : '${contract['area_m2']} m²',
                          ),
                          _heroSpec(
                            LucideIcons.bedDouble,
                            'Loại phòng',
                            (contract['apartment_type']?.toString().trim().isNotEmpty ??
                                    false)
                                ? contract['apartment_type'].toString().trim()
                                : (contract['bedrooms'] != null
                                    ? '${contract['bedrooms']} Phòng ngủ'
                                    : 'Tiêu chuẩn'),
                          ),
                          _heroSpec(
                            LucideIcons.calendarClock,
                            'Thời hạn HĐ',
                            contract['start_date'] != null
                                ? '${formatDate(contract['start_date'])} → ${formatDate(contract['end_date'])}'
                                : formatDate(contract['end_date']),
                          ),
                        ],
                      ),
                    ),
                  ],
                ),
              ),
              const SizedBox(height: 16),
            ],

            // 4 KPI Cards Row (parity: OverviewTab.jsx:1260-1412)
            LayoutBuilder(
              builder: (context, constraints) {
                final columns = constraints.maxWidth >= 1200
                    ? 4
                    : (constraints.maxWidth >= 640 ? 2 : 1);
                final cardWidth = columns == 4
                    ? (constraints.maxWidth - 36) / 4
                    : (columns == 2
                        ? (constraints.maxWidth - 12) / 2
                        : constraints.maxWidth);

                final kpiContract = contract ?? const <String, dynamic>{};
                final dueNow = currentAmountDue > 0;
                final dueColor =
                    dueNow ? AppColors.rose600 : AppColors.emerald600;
                final dueBg = dueNow ? AppColors.rose50 : AppColors.emerald50;

                final rawActiveContracts = ov['active_contracts'];
                final hasMultiContracts =
                    rawActiveContracts is List && rawActiveContracts.length > 1;
                final totalAmountDueAll = _kpiNumber(
                    ov['total_amount_due_all'] ?? currentAmountDue,
                    currentAmountDue);
                final openTotal = unreadCount + widget.openRequestsCount;

                final captionStyle = TextStyle(
                  fontFamily: 'Inter',
                  fontSize: 12,
                  color: AppColors.slate500,
                );
                final linkStyle = TextStyle(
                  fontFamily: 'Inter',
                  fontSize: 12,
                  fontWeight: FontWeight.w600,
                  color: AppColors.primary600,
                );
                Widget kpiFooter(List<Widget> children) => Container(
                      key: const Key('resident-kpi-footer'),
                      child: Wrap(
                        alignment: WrapAlignment.spaceBetween,
                        spacing: 8,
                        runSpacing: 4,
                        crossAxisAlignment: WrapCrossAlignment.center,
                        children: children,
                      ),
                    );

                final cards = <Widget>[
                  _buildKpiCard(
                    cardIndex: 1,
                    title: 'CẦN THANH TOÁN HIỆN TẠI',
                    value: formatMoney(currentAmountDue),
                    valueColor: dueColor,
                    icon: LucideIcons.receipt,
                    color: dueColor,
                    bgColor: dueBg,
                    subline: hasMultiContracts &&
                            totalAmountDueAll != currentAmountDue
                        ? RichText(
                            text: TextSpan(
                              style: const TextStyle(
                                fontFamily: 'Inter',
                                fontSize: 11,
                                color: AppColors.slate600,
                              ),
                              children: [
                                const TextSpan(text: 'Tổng tất cả căn hộ: '),
                                TextSpan(
                                  text: formatMoney(totalAmountDueAll),
                                  style: const TextStyle(
                                    fontWeight: FontWeight.w600,
                                    color: AppColors.rose600,
                                  ),
                                ),
                              ],
                            ),
                          )
                        : null,
                    footer: kpiFooter([
                      Text(
                        dueNow &&
                                latestInvoice != null &&
                                ![
                                  'DRAFT',
                                  'VOID'
                                ].contains(latestInvoice['status']?.toString())
                            ? ((latestInvoice['period']
                                        ?.toString()
                                        .isNotEmpty ??
                                    false)
                                ? 'Kỳ ${latestInvoice['period']} • Hạn ${formatDate(latestInvoice['due_date'])}'
                                : 'Phí phạt tất toán')
                            : 'Không có dư nợ quá hạn',
                        style: captionStyle,
                      ),
                      GestureDetector(
                        onTap: () => widget.onNavigateTab('invoices'),
                        child: Text('Hóa đơn', style: linkStyle),
                      ),
                    ]),
                    onTap: () => widget.onNavigateTab('invoices'),
                  ),
                  _buildKpiCard(
                    cardIndex: 2,
                    title: 'TIỀN THUÊ HÀNG THÁNG',
                    value: formatMoney(kpiContract['rent_amount'] ??
                        kpiContract['monthly_rent'] ??
                        0),
                    icon: LucideIcons.wallet,
                    color: AppColors.primary600,
                    bgColor: AppColors.sky50,
                    footer: kpiFooter([
                      Text(
                        'Chốt kỳ ngày ${_kpiNumber(kpiContract['billing_day'], 1)} hàng tháng',
                        style: captionStyle,
                      ),
                      Text(
                        'Hạn +${_kpiNumber(kpiContract['payment_due_days'], 5)} ngày',
                        style: const TextStyle(
                          fontFamily: 'Inter',
                          fontSize: 12,
                          fontWeight: FontWeight.w500,
                          color: AppColors.slate700,
                        ),
                      ),
                    ]),
                    onTap: () => widget.onNavigateTab('contract'),
                  ),
                  _buildKpiCard(
                    cardIndex: 3,
                    title: 'TIỀN CỌC ĐANG GIỮ',
                    value: formatMoney(kpiContract['deposit_held_amount'] ??
                        kpiContract['deposit_amount'] ??
                        0),
                    icon: LucideIcons.shieldCheck,
                    color: AppColors.secondary600,
                    bgColor: AppColors.secondary50,
                    footer: kpiFooter([
                      Text(
                        kpiContract['deposit_status']?.toString() == 'HELD'
                            ? 'Đang bảo lưu theo HĐ'
                            : 'Sổ cọc hợp đồng',
                        style: captionStyle,
                      ),
                      GestureDetector(
                        onTap: () => widget.onNavigateTab('contract'),
                        child: Text(
                          'Sổ cọc',
                          style: TextStyle(
                            fontFamily: 'Inter',
                            fontSize: 12,
                            fontWeight: FontWeight.w600,
                            color: AppColors.secondary600,
                          ),
                        ),
                      ),
                    ]),
                    onTap: () => widget.onNavigateTab('contract'),
                  ),
                  _buildKpiCard(
                    cardIndex: 4,
                    title: 'THÔNG BÁO & YÊU CẦU MỞ',
                    value: '$openTotal',
                    icon: LucideIcons.bellRing,
                    color: AppColors.purple500,
                    bgColor: AppColors.purple50,
                    footer: kpiFooter([
                      GestureDetector(
                        onTap: () => widget.onNavigateTab('notifications'),
                        child:
                            Text('$unreadCount chưa đọc', style: captionStyle),
                      ),
                      GestureDetector(
                        onTap: () => widget.onNavigateTab('maintenance'),
                        child: Text('${widget.openRequestsCount} báo hỏng mở',
                            style: captionStyle),
                      ),
                    ]),
                    onTap: () => widget.onNavigateTab('notifications'),
                  ),
                ];

                return Wrap(
                  spacing: 12,
                  runSpacing: 12,
                  children: [
                    for (final card in cards)
                      SizedBox(width: cardWidth, child: card)
                  ],
                );
              },
            ),
            const SizedBox(height: 20),

            // Quick Actions Section (parity: OverviewTab.jsx:1414-1477).
            AppCard(
              key: const Key('resident-quick-actions'),
              header: const AppCardHeader(
                title: 'Thao tác nhanh',
                subtitle: 'Các tiện ích thường dùng dành cho cư dân căn hộ',
              ),
              child: LayoutBuilder(
                builder: (context, constraints) {
                  const gap = 12.0;
                  final raw = constraints.maxWidth.isFinite
                      ? (constraints.maxWidth - gap * 3) / 4
                      : 200.0;
                  final cardWidth = raw.clamp(140.0, 320.0).toDouble();
                  return Wrap(
                    spacing: gap,
                    runSpacing: gap,
                    children: [
                      _buildQuickActionCard(
                        width: cardWidth,
                        icon: LucideIcons.receipt,
                        iconBg: AppColors.primary100,
                        iconFg: AppColors.primary600,
                        title: 'Báo đã thanh toán',
                        subtitle: 'Gửi ủy nhiệm chi / biên lai chuyển khoản',
                        onTap: () => widget.onNavigateTab(
                          'invoices',
                          currentAmountDue > 0 ? {'action': 'pay'} : null,
                        ),
                      ),
                      _buildQuickActionCard(
                        width: cardWidth,
                        icon: LucideIcons.wrench,
                        iconBg: AppColors.amber100,
                        iconFg: AppColors.amber600,
                        title: 'Gửi yêu cầu sửa chữa',
                        subtitle: 'Báo hỏng điện, nước, điều hòa, nội thất',
                        onTap: () => widget.onNavigateTab(
                          'maintenance',
                          {'action': 'new'},
                        ),
                      ),
                      _buildQuickActionCard(
                        width: cardWidth,
                        icon: LucideIcons.sparkles,
                        iconBg: AppColors.emerald100,
                        iconFg: AppColors.emerald600,
                        title: 'Đăng ký dịch vụ',
                        subtitle: 'Gửi xe, dọn phòng, tiện ích mở rộng',
                        onTap: () => widget.onNavigateTab(
                          'services',
                          {'action': 'subscribe'},
                        ),
                      ),
                      _buildQuickActionCard(
                        width: cardWidth,
                        icon: LucideIcons.fileText,
                        iconBg: AppColors.secondary100,
                        iconFg: AppColors.secondary600,
                        title: 'Xem hợp đồng',
                        subtitle: 'Bản in A4, phụ lục, gia hạn & sổ cọc',
                        onTap: () => widget.onNavigateTab('contract'),
                      ),
                    ],
                  );
                },
              ),
            ),
            const SizedBox(height: 16),

            // Latest invoice (2fr) + manager support (1fr) — parity: 1479-1570.
            LayoutBuilder(
              builder: (context, constraints) {
                final invoiceCard = _buildLatestInvoiceCard(
                  latestInvoice,
                  currentAmountDue,
                );
                final supportCard = _buildManagerSupportCard(ov);
                if (constraints.maxWidth >= 1024) {
                  return IntrinsicHeight(
                    child: Row(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        Expanded(flex: 2, child: invoiceCard),
                        const SizedBox(width: 16),
                        Expanded(child: supportCard),
                      ],
                    ),
                  );
                }
                return Column(
                  children: [
                    invoiceCard,
                    const SizedBox(height: 16),
                    supportCard,
                  ],
                );
              },
            ),
          ],
        ),
      ),
    );
  }

  /// JS `x || fallback` cho số: null / 0 / '' → fallback.
  num _kpiNumber(dynamic value, num fallback) {
    if (value is num) return value == 0 ? fallback : value;
    final parsed = num.tryParse(value?.toString() ?? '');
    return (parsed == null || parsed == 0) ? fallback : parsed;
  }

  Widget _buildKpiCard({
    required String title,
    required String value,
    required IconData icon,
    required Color color,
    required Color bgColor,
    required Widget footer,
    required VoidCallback onTap,
    required int cardIndex,
    Color? valueColor,
    Widget? subline,
  }) {
    return InkWell(
      key: Key('resident-kpi-card-$cardIndex'),
      onTap: onTap,
      borderRadius: BorderRadius.circular(14),
      child: Container(
        padding: const EdgeInsets.all(16),
        decoration: BoxDecoration(
          color: Colors.white,
          borderRadius: BorderRadius.circular(14),
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
                Expanded(
                  child: Text(
                    title,
                    style: const TextStyle(
                      fontFamily: 'Inter',
                      fontSize: 12,
                      fontWeight: FontWeight.w500,
                      color: AppColors.slate500,
                    ),
                  ),
                ),
                const SizedBox(width: 10),
                Container(
                  width: 36,
                  height: 36,
                  decoration: BoxDecoration(
                    color: bgColor,
                    borderRadius: BorderRadius.circular(12),
                  ),
                  child: Icon(icon, size: 18, color: color),
                ),
              ],
            ),
            const SizedBox(height: 8),
            Text(
              value,
              style: TextStyle(
                fontFamily: 'Inter',
                fontSize: 20,
                fontWeight: FontWeight.w700,
                color: valueColor ?? AppColors.slate900,
              ),
            ),
            if (subline != null) ...[
              const SizedBox(height: 4),
              subline,
            ],
            const SizedBox(height: 12),
            const Divider(color: AppColors.slate100, height: 1),
            const SizedBox(height: 12),
            footer,
          ],
        ),
      ),
    );
  }

  Widget _buildQuickActionCard({
    required double width,
    required IconData icon,
    required Color iconBg,
    required Color iconFg,
    required String title,
    required String subtitle,
    required VoidCallback onTap,
  }) {
    return SizedBox(
      width: width,
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(12),
        child: Container(
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
              Container(
                width: 40,
                height: 40,
                decoration: BoxDecoration(
                  color: iconBg,
                  borderRadius: BorderRadius.circular(12),
                ),
                child: Icon(icon, size: 20, color: iconFg),
              ),
              const SizedBox(height: 12),
              Text(
                title,
                style: const TextStyle(
                  fontFamily: 'Inter',
                  fontSize: 14,
                  fontWeight: FontWeight.w600,
                  color: AppColors.slate900,
                ),
              ),
              const SizedBox(height: 2),
              Text(
                subtitle,
                style: const TextStyle(
                  fontFamily: 'Inter',
                  fontSize: 12,
                  color: AppColors.slate500,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildLatestInvoiceCard(Map? invoice, num currentAmountDue) {
    return AppCard(
      key: const Key('resident-latest-invoice-card'),
      header: AppCardHeader(
        title: 'Hóa đơn kỳ gần nhất',
        subtitle: 'Theo dõi trạng thái thanh toán kỳ hiện hành',
        action: AppButton(
          text: 'Tất cả hóa đơn',
          size: AppButtonSize.sm,
          variant: AppButtonVariant.ghost,
          onPressed: () => widget.onNavigateTab('invoices'),
        ),
      ),
      child: invoice == null
          ? const Padding(
              padding: EdgeInsets.symmetric(vertical: 16),
              child: Text(
                'Hiện chưa có hóa đơn nào được phát hành cho căn hộ của bạn.',
                style: TextStyle(
                  fontFamily: 'Inter',
                  fontSize: 12,
                  color: AppColors.slate500,
                ),
              ),
            )
          : _buildLatestInvoiceBody(invoice, currentAmountDue),
    );
  }

  Widget _buildLatestInvoiceBody(Map invoice, num currentAmountDue) {
    final code = invoice['invoice_code']?.toString() ?? '';
    final period = invoice['period']?.toString() ?? '';
    final isLateFee =
        invoice['invoice_type']?.toString() == 'LATE_FEE_SETTLEMENT' ||
            period.isEmpty;
    final status = invoice['status']?.toString() ?? '';
    final total = num.tryParse(invoice['total_amount']?.toString() ?? '0') ?? 0;
    final paid = num.tryParse(invoice['paid_amount']?.toString() ?? '0') ?? 0;
    final showPay = [
          'ISSUED',
          'PARTIALLY_PAID',
          'OVERDUE',
          'ADJUSTED',
        ].contains(status) &&
        (total - paid) > 0;

    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: AppColors.slate50,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: AppColors.slate200),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          Wrap(
            spacing: 8,
            runSpacing: 6,
            crossAxisAlignment: WrapCrossAlignment.center,
            children: [
              if (code.isNotEmpty)
                Text(
                  code,
                  style: const TextStyle(
                    fontFamily: 'Inter',
                    fontSize: 14,
                    fontWeight: FontWeight.bold,
                    color: AppColors.slate900,
                  ),
                ),
              AppBadge(
                variant: isLateFee ? AppBadgeVariant.amber : AppBadgeVariant.sky,
                label: period.isNotEmpty ? 'Kỳ $period' : 'Phí phạt tất toán',
              ),
              StatusBadge(status: status, domain: StatusDomain.invoice),
            ],
          ),
          const SizedBox(height: 6),
          Wrap(
            spacing: 4,
            runSpacing: 4,
            crossAxisAlignment: WrapCrossAlignment.center,
            children: [
              const Text(
                'Hạn thanh toán:',
                style: TextStyle(
                    fontFamily: 'Inter', fontSize: 12, color: AppColors.slate500),
              ),
              Text(
                formatDate(invoice['due_date']),
                style: const TextStyle(
                  fontFamily: 'Inter',
                  fontSize: 12,
                  fontWeight: FontWeight.w500,
                  color: AppColors.slate700,
                ),
              ),
              const Text('•',
                  style: TextStyle(
                      fontFamily: 'Inter',
                      fontSize: 12,
                      color: AppColors.slate500)),
              const Text(
                'Đã trả:',
                style: TextStyle(
                    fontFamily: 'Inter', fontSize: 12, color: AppColors.slate500),
              ),
              Text(
                formatMoney(paid),
                style: const TextStyle(
                  fontFamily: 'Inter',
                  fontSize: 12,
                  fontWeight: FontWeight.w500,
                  color: AppColors.emerald700,
                ),
              ),
            ],
          ),
          const SizedBox(height: 12),
          Row(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    const Text(
                      'Tổng hóa đơn',
                      style: TextStyle(
                          fontFamily: 'Inter',
                          fontSize: 11,
                          color: AppColors.slate500),
                    ),
                    const SizedBox(height: 2),
                    Text(
                      formatMoney(total),
                      style: const TextStyle(
                        fontFamily: 'Inter',
                        fontSize: 16,
                        fontWeight: FontWeight.bold,
                        color: AppColors.slate900,
                      ),
                    ),
                  ],
                ),
              ),
              if (showPay) ...[
                const SizedBox(width: 12),
                AppButton(
                  text: 'Thanh toán',
                  size: AppButtonSize.sm,
                  onPressed: () => widget.onNavigateTab(
                    'invoices',
                    currentAmountDue > 0 ? {'action': 'pay'} : null,
                  ),
                ),
              ],
            ],
          ),
        ],
      ),
    );
  }

  Widget _buildManagerSupportCard(Map overview) {
    final contact = overview['manager_contact'] is Map
        ? overview['manager_contact'] as Map
        : const {};
    final name = contact['full_name']?.toString().trim() ?? '';
    final phone = contact['phone']?.toString().trim() ?? '';
    final email = contact['email']?.toString().trim() ?? '';
    final hotline = contact['technical_hotline']?.toString().trim() ?? '';
    final hours = contact['working_hours']?.toString().trim() ?? '';

    const labelStyle = TextStyle(
        fontFamily: 'Inter', fontSize: 12, color: AppColors.slate600);

    return AppCard(
      key: const Key('resident-manager-support-card'),
      header: const AppCardHeader(
        title: 'Ban Quản Lý hỗ trợ',
        subtitle: 'Liên hệ nhanh khi cần giúp đỡ',
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        mainAxisSize: MainAxisSize.min,
        children: [
          Container(
            padding: const EdgeInsets.all(12),
            decoration: BoxDecoration(
              color: AppColors.slate50,
              borderRadius: BorderRadius.circular(12),
              border: Border.all(color: AppColors.slate200),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  name.isEmpty ? 'Ban Quản Lý ResiHub' : name,
                  style: const TextStyle(
                    fontFamily: 'Inter',
                    fontSize: 14,
                    fontWeight: FontWeight.w600,
                    color: AppColors.slate900,
                  ),
                ),
                const SizedBox(height: 4),
                if (phone.isNotEmpty) Text('SĐT Quản lý: $phone', style: labelStyle),
                if (email.isNotEmpty) Text('Email: $email', style: labelStyle),
                Text(
                  'Hotline KT: ${hotline.isEmpty ? '1900 6868' : hotline}',
                  style: const TextStyle(
                      fontFamily: 'Inter',
                      fontSize: 12,
                      color: AppColors.slate500),
                ),
                Text(
                  'Giờ làm việc: ${hours.isEmpty ? '08:00 – 18:00' : hours}',
                  style: const TextStyle(
                      fontFamily: 'Inter',
                      fontSize: 12,
                      color: AppColors.slate500),
                ),
              ],
            ),
          ),
          const SizedBox(height: 12),
          AppButton(
            text: 'Xem đầy đủ danh bạ BQL',
            variant: AppButtonVariant.outline,
            size: AppButtonSize.sm,
            fullWidth: true,
            onPressed: () => widget.onNavigateTab('contact'),
          ),
        ],
      ),
    );
  }
}
