import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../../../core/theme/app_colors.dart';
import '../../../core/utils/deposit_ui_helpers.dart';
import '../../../core/utils/format.dart';
import '../../../core/utils/validation.dart';
import '../../../shared/providers/notification_provider.dart';
import '../../../shared/providers/toast_provider.dart';
import '../../../shared/widgets/common/bank_select.dart';
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

  @override
  Widget build(BuildContext context) {
    final ov = widget.overview ?? const {};
    final contract = ov['active_contract'] is Map
        ? ov['active_contract'] as Map<String, dynamic>
        : (ov['contract'] is Map ? ov['contract'] as Map<String, dynamic> : null);

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

            // Active Resident Apartment Hero Banner
            if (contract != null) ...[
              Container(
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
                    Row(
                      mainAxisAlignment: MainAxisAlignment.spaceBetween,
                      children: [
                        Row(
                          children: [
                            Container(
                              width: 44,
                              height: 44,
                              decoration: BoxDecoration(
                                color: Colors.white.withValues(alpha: 0.2),
                                borderRadius: BorderRadius.circular(12),
                              ),
                              child: const Icon(LucideIcons.home, color: Colors.white, size: 24),
                            ),
                            const SizedBox(width: 12),
                            Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(
                                  'Căn hộ ${contract['apartment_code'] ?? '---'}',
                                  style: const TextStyle(
                                    fontFamily: 'Inter',
                                    fontSize: 18,
                                    fontWeight: FontWeight.bold,
                                    color: Colors.white,
                                  ),
                                ),
                                const SizedBox(height: 2),
                                Text(
                                  contract['building_name']?.toString() ?? 'Tòa nhà ResiHub',
                                  style: const TextStyle(
                                    fontFamily: 'Inter',
                                    fontSize: 13,
                                    color: Color(0xFFE2E8F0),
                                  ),
                                ),
                              ],
                            ),
                          ],
                        ),
                        Container(
                          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                          decoration: BoxDecoration(
                            color: Colors.white.withValues(alpha: 0.25),
                            borderRadius: BorderRadius.circular(20),
                          ),
                          child: Text(
                            contract['status'] == 'ACTIVE' ? 'Đang hiệu lực' : 'Đang xử lý',
                            style: const TextStyle(
                              fontFamily: 'Inter',
                              fontSize: 12,
                              fontWeight: FontWeight.w600,
                              color: Colors.white,
                            ),
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 16),
                    const Divider(color: Colors.white24, height: 1),
                    const SizedBox(height: 14),
                    Wrap(
                      spacing: 24,
                      runSpacing: 10,
                      children: [
                        if (contract['end_date'] != null)
                          Row(
                            mainAxisSize: MainAxisSize.min,
                            children: [
                              const Icon(LucideIcons.calendarClock,
                                  size: 15, color: Color(0xFFCBD5E1)),
                              const SizedBox(width: 6),
                              Text(
                                'Hạn HĐ: ${formatDate(contract['end_date'])}',
                                style: const TextStyle(
                                    fontSize: 12, color: Colors.white, fontFamily: 'Inter'),
                              ),
                            ],
                          ),
                        if (contract['monthly_rent'] != null)
                          Row(
                            mainAxisSize: MainAxisSize.min,
                            children: [
                              const Icon(LucideIcons.wallet, size: 15, color: Color(0xFFCBD5E1)),
                              const SizedBox(width: 6),
                              Text(
                                'Tiền thuê: ${formatMoney(contract['monthly_rent'])}/tháng',
                                style: const TextStyle(
                                    fontSize: 12, color: Colors.white, fontFamily: 'Inter'),
                              ),
                            ],
                          ),
                      ],
                    ),
                  ],
                ),
              ),
              const SizedBox(height: 16),
            ],

            // 4 KPIs Grid
            LayoutBuilder(
              builder: (context, constraints) {
                final crossAxisCount = constraints.maxWidth >= 768 ? 4 : 2;
                return GridView.count(
                  crossAxisCount: crossAxisCount,
                  shrinkWrap: true,
                  physics: const NeverScrollableScrollPhysics(),
                  mainAxisSpacing: 12,
                  crossAxisSpacing: 12,
                  childAspectRatio: constraints.maxWidth >= 768 ? 1.4 : 1.3,
                  children: [
                    // KPI 1: Tiền cần thanh toán
                    _buildKpiCard(
                      title: 'Cần thanh toán',
                      value: formatMoney(currentAmountDue),
                      icon: LucideIcons.receipt,
                      color: currentAmountDue > 0 ? AppColors.rose600 : AppColors.primary600,
                      bgColor: currentAmountDue > 0 ? AppColors.rose50 : AppColors.primary50,
                      onTap: () => widget.onNavigateTab('invoices'),
                    ),

                    // KPI 2: Hóa đơn gần nhất
                    _buildKpiCard(
                      title: 'Hóa đơn gần nhất',
                      value: latestInvoice != null
                          ? (latestInvoice['invoice_code']?.toString() ?? 'Chi tiết')
                          : 'Không có',
                      icon: LucideIcons.fileText,
                      color: AppColors.secondary600,
                      bgColor: AppColors.secondary50,
                      onTap: () => widget.onNavigateTab('invoices'),
                    ),

                    // KPI 3: Yêu cầu cần xử lý
                    _buildKpiCard(
                      title: 'Yêu cầu sự cố',
                      value: '${widget.openRequestsCount} đang mở',
                      icon: LucideIcons.wrench,
                      color: widget.openRequestsCount > 0 ? Colors.amber.shade700 : AppColors.slate600,
                      bgColor: widget.openRequestsCount > 0 ? Colors.amber.shade50 : AppColors.slate100,
                      onTap: () => widget.onNavigateTab('maintenance'),
                    ),

                    // KPI 4: Thông báo
                    _buildKpiCard(
                      title: 'Thông báo',
                      value: '$unreadCount chưa đọc',
                      icon: LucideIcons.bellRing,
                      color: unreadCount > 0 ? AppColors.primary600 : AppColors.slate600,
                      bgColor: unreadCount > 0 ? AppColors.primary50 : AppColors.slate100,
                      onTap: () => widget.onNavigateTab('notifications'),
                    ),
                  ],
                );
              },
            ),
            const SizedBox(height: 20),

            // Quick Actions Section
            AppCard(
              header: const AppCardHeader(title: 'Lối tắt thao tác nhanh'),
              child: Wrap(
                spacing: 10,
                runSpacing: 10,
                children: [
                  _buildQuickAction(
                    icon: LucideIcons.wrench,
                    label: 'Báo hỏng / Sự cố',
                    onTap: () => widget.onNavigateTab('maintenance', {'action': 'create'}),
                  ),
                  _buildQuickAction(
                    icon: LucideIcons.receipt,
                    label: 'Thanh toán hóa đơn',
                    onTap: () => widget.onNavigateTab('invoices'),
                  ),
                  _buildQuickAction(
                    icon: LucideIcons.sparkles,
                    label: 'Đăng ký dịch vụ',
                    onTap: () => widget.onNavigateTab('services'),
                  ),
                  _buildQuickAction(
                    icon: LucideIcons.fileText,
                    label: 'Chi tiết hợp đồng',
                    onTap: () => widget.onNavigateTab('contract'),
                  ),
                  _buildQuickAction(
                    icon: LucideIcons.phoneCall,
                    label: 'Liên hệ BQL',
                    onTap: () => widget.onNavigateTab('contact'),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildKpiCard({
    required String title,
    required String value,
    required IconData icon,
    required Color color,
    required Color bgColor,
    required VoidCallback onTap,
  }) {
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(14),
      child: Container(
        padding: const EdgeInsets.all(12),
        decoration: BoxDecoration(
          color: Colors.white,
          borderRadius: BorderRadius.circular(14),
          border: Border.all(color: AppColors.slate200),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: [
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                Expanded(
                  child: Text(
                    title,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(
                      fontFamily: 'Inter',
                      fontSize: 12,
                      fontWeight: FontWeight.w500,
                      color: AppColors.slate500,
                    ),
                  ),
                ),
                const SizedBox(width: 4),
                Container(
                  padding: const EdgeInsets.all(6),
                  decoration: BoxDecoration(
                    color: bgColor,
                    borderRadius: BorderRadius.circular(8),
                  ),
                  child: Icon(icon, size: 14, color: color),
                ),
              ],
            ),
            Text(
              value,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(
                fontFamily: 'Inter',
                fontSize: 16,
                fontWeight: FontWeight.w700,
                color: color,
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildQuickAction({
    required IconData icon,
    required String label,
    required VoidCallback onTap,
  }) {
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(12),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
        decoration: BoxDecoration(
          color: AppColors.slate50,
          borderRadius: BorderRadius.circular(12),
          border: Border.all(color: AppColors.slate200),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(icon, size: 16, color: AppColors.primary600),
            const SizedBox(width: 8),
            Text(
              label,
              style: const TextStyle(
                fontFamily: 'Inter',
                fontSize: 13,
                fontWeight: FontWeight.w600,
                color: AppColors.slate800,
              ),
            ),
          ],
        ),
      ),
    );
  }
}
