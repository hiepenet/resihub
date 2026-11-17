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
import '../../../shared/widgets/common/empty_state.dart';
import '../../../shared/widgets/ui/app_badge.dart';
import '../../../shared/widgets/ui/app_button.dart';
import '../../../shared/widgets/ui/app_card.dart';
import '../../../shared/widgets/ui/app_input.dart';
import '../../../shared/widgets/ui/app_modal.dart';
import '../../../shared/widgets/ui/file_upload_field.dart';
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

    final fullNameCtrl =
        TextEditingController(text: user['full_name']?.toString() ?? '');
    final phoneCtrl =
        TextEditingController(text: user['phone']?.toString() ?? '');
    final idNumberCtrl =
        TextEditingController(text: user['id_number']?.toString() ?? '');
    final addressCtrl =
        TextEditingController(text: user['address']?.toString() ?? '');
    final jobCtrl = TextEditingController();
    final emergencyNameCtrl = TextEditingController();
    final emergencyPhoneCtrl = TextEditingController();

    bool submitting = false;

    AppModal.show(
      context: context,
      title: 'Nộp hồ sơ thuê căn hộ',
      subtitle:
          'Vui lòng xác nhận thông tin cư trú để ban quản lý lập hợp đồng thuê.',
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
                      onPressed:
                          submitting ? null : () => Navigator.of(ctx).pop(),
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
                                ref.read(toastProvider.notifier).error(
                                    'Vui lòng điền họ tên và số điện thoại.');
                                return;
                              }

                              setModalState(() => submitting = true);
                              try {
                                await ref
                                    .read(residentServiceProvider)
                                    .submitRentalApplication({
                                  if (apartmentId != null &&
                                      apartmentId.isNotEmpty)
                                    'desired_apartment_id': apartmentId,
                                  'full_name': name,
                                  'phone': phone,
                                  'id_number': idNumberCtrl.text.trim(),
                                  'address': addressCtrl.text.trim(),
                                  'job_title': jobCtrl.text.trim(),
                                  'emergency_contact_name':
                                      emergencyNameCtrl.text.trim(),
                                  'emergency_contact_phone':
                                      emergencyPhoneCtrl.text.trim(),
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
                                ref.read(toastProvider.notifier).error(
                                    extractErrorMessage(
                                        err, 'Không thể gửi hồ sơ thuê.'));
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

  void _openReservationBankModal(
      BuildContext context, Map<String, dynamic> rsv) {
    final rsvId =
        rsv['reservation_id']?.toString() ?? rsv['id']?.toString() ?? '';
    String bankName = rsv['bank_name']?.toString() ?? '';
    String? bankCode = rsv['bank_code']?.toString();
    String? bankBin = rsv['bank_bin']?.toString();
    final accNumCtrl =
        TextEditingController(text: rsv['account_number']?.toString() ?? '');
    final accHolderCtrl =
        TextEditingController(text: rsv['account_holder']?.toString() ?? '');

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
                            if (bankName.isEmpty ||
                                acc.isEmpty ||
                                holder.isEmpty) {
                              ref.read(toastProvider.notifier).error(
                                  'Vui lòng điền đầy đủ thông tin ngân hàng.');
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
                              ref.read(toastProvider.notifier).success(
                                  'Đã cập nhật thông tin tài khoản hoàn tiền.');
                              await widget.onRefreshOverview();
                            } catch (err) {
                              setModalState(() => saving = false);
                              ref.read(toastProvider.notifier).error(
                                    extractErrorMessage(err,
                                        'Không thể cập nhật tài khoản ngân hàng.'),
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

  String _reservationStatus(Map r) =>
      r['reservation_status']?.toString() ?? r['status']?.toString() ?? 'HELD';

  /// Modal chi tiết giữ chỗ / hồ sơ — parity: OverviewTab.jsx:702-828.
  void _openReservationDetailModal(
    BuildContext context,
    Map<String, dynamic> rsv, {
    bool isApplicationOnly = false,
  }) {
    final status = _reservationStatus(rsv);
    final aptCode = rsv['apartment_code']?.toString() ?? '';
    final application = rsv['application'] is Map
        ? rsv['application'] as Map
        : const <String, dynamic>{};
    final appStatus = application['status']?.toString() ?? 'PENDING';
    final desiredCode = application['desired_apartment_code']?.toString() ?? '';
    final desiredBuilding =
        application['desired_building_name']?.toString() ?? '';
    final canUpdateBank = canResidentUpdateReservationBankInfo(rsv);

    final title = isApplicationOnly
        ? 'Chi tiết Hồ sơ Đăng ký Thuê'
        : 'Chi tiết Phiếu Giữ chỗ — Căn $aptCode';
    final subtitle = isApplicationOnly
        ? (desiredBuilding.isNotEmpty
            ? desiredBuilding
            : 'Trạng thái xét duyệt hồ sơ cư dân')
        : (rsv['building_name']?.toString() ?? '');

    AppModal.show(
      context: context,
      title: title,
      subtitle: subtitle,
      footer: Wrap(
        alignment: WrapAlignment.end,
        spacing: 8,
        runSpacing: 8,
        children: [
          AppButton(
            text: 'Đóng',
            variant: AppButtonVariant.outline,
            onPressed: () => Navigator.of(context).pop(),
          ),
          if (!isApplicationOnly && status == 'HELD')
            AppButton(
              text: 'Đăng ký thông tin nhận nhà',
              icon: const Icon(LucideIcons.send, size: 14),
              onPressed: () {
                Navigator.of(context).pop();
                _openApplicationModal(
                  context,
                  apartmentId: rsv['apartment_id']?.toString(),
                );
              },
            ),
          if (!isApplicationOnly && canUpdateBank)
            AppButton(
              text: 'Cập nhật STK nhận hoàn',
              icon: const Icon(LucideIcons.creditCard, size: 14),
              onPressed: () {
                Navigator.of(context).pop();
                _openReservationBankModal(context, rsv);
              },
            ),
        ],
      ),
      child: KeyedSubtree(
        key: const Key('resident-reservation-detail-modal'),
        child: isApplicationOnly
            ? Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Container(
                    padding: const EdgeInsets.all(14),
                    decoration: BoxDecoration(
                      color: AppColors.emerald50,
                      borderRadius: BorderRadius.circular(12),
                      border: Border.all(color: AppColors.emerald200),
                    ),
                    child: Row(
                      mainAxisAlignment: MainAxisAlignment.spaceBetween,
                      children: [
                        const Text(
                          'Trạng thái hồ sơ',
                          style: TextStyle(
                            fontFamily: 'Inter',
                            fontSize: 12,
                            fontWeight: FontWeight.w600,
                            color: AppColors.slate800,
                          ),
                        ),
                        AppBadge(
                          label: appStatus,
                          variant: appStatus == 'APPROVED'
                              ? AppBadgeVariant.emerald
                              : appStatus == 'REJECTED'
                                  ? AppBadgeVariant.red
                                  : AppBadgeVariant.amber,
                          dot: true,
                        ),
                      ],
                    ),
                  ),
                  if (desiredCode.isNotEmpty) ...[
                    const SizedBox(height: 12),
                    Text(
                      'Căn hộ đăng ký: Căn $desiredCode'
                      '${desiredBuilding.isNotEmpty ? ' ($desiredBuilding)' : ''}',
                      style: const TextStyle(
                        fontFamily: 'Inter',
                        fontSize: 12,
                        color: AppColors.slate700,
                      ),
                    ),
                  ],
                  const SizedBox(height: 12),
                  const Text(
                    'Ban Quản Lý đã tiếp nhận hồ sơ định danh và sẽ liên hệ để hoàn tất hợp đồng thuê.',
                    style: TextStyle(
                      fontFamily: 'Inter',
                      fontSize: 12,
                      color: AppColors.slate600,
                    ),
                  ),
                ],
              )
            : Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
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
                            const Text(
                              'Trạng thái giữ chỗ',
                              style: TextStyle(
                                fontFamily: 'Inter',
                                fontSize: 12,
                                color: AppColors.slate500,
                              ),
                            ),
                            const SizedBox(height: 4),
                            StatusBadge(
                              status: status,
                              domain: StatusDomain.reservation,
                            ),
                          ],
                        ),
                        Column(
                          crossAxisAlignment: CrossAxisAlignment.end,
                          children: [
                            const Text(
                              'Tiền cọc giữ chỗ',
                              style: TextStyle(
                                fontFamily: 'Inter',
                                fontSize: 12,
                                color: AppColors.slate500,
                              ),
                            ),
                            const SizedBox(height: 4),
                            Text(
                              formatMoney(
                                  rsv['hold_amount'] ?? rsv['amount'] ?? 0),
                              style: const TextStyle(
                                fontFamily: 'Inter',
                                fontSize: 16,
                                fontWeight: FontWeight.bold,
                                color: AppColors.primary600,
                              ),
                            ),
                          ],
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(height: 12),
                  Container(
                    padding: const EdgeInsets.all(12),
                    decoration: BoxDecoration(
                      color: Colors.white,
                      borderRadius: BorderRadius.circular(12),
                      border: Border.all(color: AppColors.slate200),
                    ),
                    child: Row(
                      children: [
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              const Text(
                                'Hạn giữ chỗ',
                                style: TextStyle(
                                  fontFamily: 'Inter',
                                  fontSize: 12,
                                  color: AppColors.slate500,
                                ),
                              ),
                              const SizedBox(height: 2),
                              Text(
                                formatDate(rsv['hold_until']),
                                style: const TextStyle(
                                  fontFamily: 'Inter',
                                  fontSize: 13,
                                  fontWeight: FontWeight.w600,
                                  color: AppColors.slate900,
                                ),
                              ),
                            ],
                          ),
                        ),
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.end,
                            children: [
                              const Text(
                                'Hoàn trả / Khấu trừ',
                                style: TextStyle(
                                  fontFamily: 'Inter',
                                  fontSize: 12,
                                  color: AppColors.slate500,
                                ),
                              ),
                              const SizedBox(height: 2),
                              Text(
                                formatMoney(rsv['refunded_amount'] ?? 0),
                                style: const TextStyle(
                                  fontFamily: 'Inter',
                                  fontSize: 13,
                                  fontWeight: FontWeight.w600,
                                  color: AppColors.emerald700,
                                ),
                              ),
                            ],
                          ),
                        ),
                      ],
                    ),
                  ),
                  if ((rsv['settlement_reason']?.toString() ?? '')
                      .isNotEmpty) ...[
                    const SizedBox(height: 12),
                    Container(
                      padding: const EdgeInsets.all(12),
                      decoration: BoxDecoration(
                        color: AppColors.slate50,
                        borderRadius: BorderRadius.circular(12),
                        border: Border.all(color: AppColors.slate200),
                      ),
                      child: Text(
                        'Ghi chú thanh lý: ${rsv['settlement_reason']}',
                        style: const TextStyle(
                          fontFamily: 'Inter',
                          fontSize: 12,
                          color: AppColors.slate700,
                        ),
                      ),
                    ),
                  ],
                ],
              ),
      ),
    );
  }

  /// `(thu giữ phạt …)` chỉ hiển thị khi forfeited_amount > 0 (React:1008-1010).
  String _forfeitedSuffix(Map r) {
    final raw = r['forfeited_amount'] ?? 0;
    final num value = raw is num ? raw : num.tryParse(raw.toString()) ?? 0;
    return value > 0 ? ' (thu giữ phạt ${formatMoney(raw)})' : '';
  }

  /// Nội dung tài khoản nhận hoàn (React:1013-1025).
  String _refundBankText(Map r) {
    final bank = r['refund_bank_info'] is Map
        ? r['refund_bank_info'] as Map
        : const <String, dynamic>{};
    final account = bank['account_number']?.toString() ?? '';
    if (account.isEmpty) {
      return 'Bạn chưa cung cấp tài khoản ngân hàng nhận hoàn. Vui lòng bấm "Cập nhật STK nhận hoàn" để Ban Quản Lý chuyển khoản nhanh chóng.';
    }
    return '${bank['bank_name'] ?? ''} • $account (${bank['account_holder'] ?? ''})';
  }

  Widget _miniInfo(String label, String value, {Color? valueColor}) {
    return Container(
      padding: const EdgeInsets.all(10),
      decoration: BoxDecoration(
        color: AppColors.slate50,
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: AppColors.slate200),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            label,
            style: const TextStyle(
              fontFamily: 'Inter',
              fontSize: 11,
              color: AppColors.slate500,
            ),
          ),
          const SizedBox(height: 2),
          Text(
            value,
            style: TextStyle(
              fontFamily: 'Inter',
              fontSize: 12,
              fontWeight: FontWeight.w600,
              color: valueColor ?? AppColors.slate900,
            ),
          ),
        ],
      ),
    );
  }

  /// Danh sách thẻ giữ chỗ (dùng cho cả 2 nhánh có / không hợp đồng).
  Widget _buildReservationBanners(
    BuildContext context,
    List<Map<String, dynamic>> reservations, {
    required bool showActionButton,
  }) {
    return Column(
      children: [
        for (final r in reservations)
          _buildReservationCard(
            context,
            r,
            showActionButton: showActionButton,
          ),
      ],
    );
  }

  /// Thẻ giữ chỗ giàu thông tin — parity: OverviewTab.jsx:903-1079.
  Widget _buildReservationCard(
    BuildContext context,
    Map<String, dynamic> r, {
    required bool showActionButton,
  }) {
    final status = _reservationStatus(r);
    final isAmber =
        status == 'PENDING_CONFIRM' || status == 'CANCEL_PENDING_APPROVAL';
    final isPayout = status == 'APPROVED_PENDING_PAYOUT';
    final canUpdateBank = canResidentUpdateReservationBankInfo(r);
    final aptCode = r['apartment_code']?.toString() ?? '';
    final floorName = r['floor_name']?.toString() ?? '';
    final buildingName = r['building_name']?.toString() ?? '';
    final buildingAddress = r['building_address']?.toString() ?? '';
    final amenities = parseResidentAmenities(r['amenities']);
    final holdAmount = r['hold_amount'] ?? r['amount'] ?? 0;
    final note = r['reservation_note']?.toString() ?? '';
    final refundBankText = _refundBankText(r);
    final statusLabel = switch (status) {
      'PENDING_CONFIRM' => 'Phiếu đăng ký giữ chỗ đang chờ đối soát',
      'CANCEL_PENDING_APPROVAL' =>
        'Đề xuất thanh lý hủy giữ chỗ đang chờ phê duyệt',
      'APPROVED_PENDING_PAYOUT' =>
        'Đã duyệt hoàn tiền giữ chỗ — Chờ BQL chuyển khoản',
      _ => 'Thông tin căn hộ đang giữ chỗ',
    };
    final toneIcon = isAmber ? LucideIcons.clock : LucideIcons.shieldCheck;

    return Container(
      margin: const EdgeInsets.only(bottom: 16),
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(
          color: isAmber ? AppColors.amber200 : AppColors.sky200,
        ),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Container(
                padding: const EdgeInsets.all(10),
                decoration: BoxDecoration(
                  color: isAmber ? AppColors.amber100 : AppColors.sky50,
                  borderRadius: BorderRadius.circular(12),
                ),
                child: Icon(
                  toneIcon,
                  size: 20,
                  color: isAmber ? AppColors.amber700 : AppColors.sky700,
                ),
              ),
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
                        Text(
                          statusLabel,
                          style: TextStyle(
                            fontFamily: 'Inter',
                            fontSize: 12,
                            fontWeight: FontWeight.w600,
                            color:
                                isAmber ? AppColors.amber700 : AppColors.sky700,
                          ),
                        ),
                        StatusBadge(
                          status: status,
                          domain: StatusDomain.reservation,
                        ),
                      ],
                    ),
                    const SizedBox(height: 4),
                    Text(
                      'Căn hộ $aptCode${floorName.isNotEmpty ? ' • $floorName' : ''}',
                      style: const TextStyle(
                        fontFamily: 'Inter',
                        fontSize: 18,
                        fontWeight: FontWeight.bold,
                        color: AppColors.slate900,
                      ),
                    ),
                    if (buildingName.isNotEmpty) ...[
                      const SizedBox(height: 2),
                      Text(
                        '$buildingName'
                        '${buildingAddress.isNotEmpty ? ' — $buildingAddress' : ''}',
                        style: const TextStyle(
                          fontFamily: 'Inter',
                          fontSize: 12,
                          color: AppColors.slate600,
                        ),
                      ),
                    ],
                  ],
                ),
              ),
            ],
          ),
          if (status == 'PENDING_CONFIRM') ...[
            const SizedBox(height: 12),
            _miniInfo(
              'Thông báo',
              'Ban Quản Lý đang đối soát chứng từ chuyển khoản của bạn (SLA 4 giờ làm việc). Căn hộ sẽ chính thức khóa giữ chỗ sau khi BQL xác nhận đã nhận tiền.',
            ),
          ],
          if (status == 'CANCEL_PENDING_APPROVAL') ...[
            const SizedBox(height: 12),
            _miniInfo(
              'Đề xuất thanh lý',
              'Ban Quản Lý đã lập đề xuất thanh lý hủy giữ chỗ (Hoàn khách ${formatMoney(r['refunded_amount'] ?? 0)} • Thu giữ phạt ${formatMoney(r['forfeited_amount'] ?? 0)}) và đang trình Chủ nhà phê duyệt.',
            ),
          ],
          if (isPayout) ...[
            const SizedBox(height: 12),
            Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                _miniInfo(
                  'Chi hoàn tiền',
                  'Chủ nhà đã phê duyệt hoàn trả ${formatMoney(r['refunded_amount'] ?? 0)}${_forfeitedSuffix(r)}. Ban Quản Lý đang thực hiện thủ tục chi hoàn tiền cho bạn.',
                  valueColor: AppColors.emerald700,
                ),
                const SizedBox(height: 8),
                _miniInfo(
                  'Tài khoản nhận hoàn',
                  refundBankText,
                  valueColor: refundBankText.startsWith('Bạn chưa cung cấp')
                      ? AppColors.amber700
                      : AppColors.slate900,
                ),
              ],
            ),
          ],
          const SizedBox(height: 12),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              _miniInfo(
                'Thiết kế & Diện tích',
                '${r['apartment_type']?.toString().isNotEmpty == true ? r['apartment_type'] : (r['bedrooms'] != null ? '${r['bedrooms']} PN' : 'Tiêu chuẩn')}'
                    '${r['area_m2'] != null ? ' • ${r['area_m2']} m²' : ''}',
              ),
              _miniInfo(
                'Giá thuê niêm yết',
                r['base_rent'] != null
                    ? '${formatMoney(r['base_rent'])}/tháng'
                    : '—',
              ),
              _miniInfo('Tiền cọc giữ chỗ', formatMoney(holdAmount),
                  valueColor: AppColors.primary600),
              _miniInfo(
                'Thời hạn giữ chỗ',
                '${r['hold_from'] != null ? '${formatDate(r['hold_from'])} → ' : ''}${formatDate(r['hold_until'])}',
              ),
            ],
          ),
          if (amenities.isNotEmpty) ...[
            const SizedBox(height: 12),
            Wrap(
              spacing: 6,
              runSpacing: 6,
              children: [
                for (final amenity in amenities)
                  Container(
                    padding:
                        const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                    decoration: BoxDecoration(
                      color: AppColors.slate100,
                      borderRadius: BorderRadius.circular(6),
                    ),
                    child: Text(
                      amenity,
                      style: const TextStyle(
                        fontFamily: 'Inter',
                        fontSize: 11,
                        color: AppColors.slate700,
                      ),
                    ),
                  ),
              ],
            ),
          ],
          if (note.isNotEmpty) ...[
            const SizedBox(height: 8),
            Text(
              'Ghi chú phiếu giữ chỗ: $note',
              style: const TextStyle(
                fontFamily: 'Inter',
                fontSize: 12,
                fontStyle: FontStyle.italic,
                color: AppColors.slate600,
              ),
            ),
          ],
          const SizedBox(height: 14),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            alignment: WrapAlignment.end,
            children: [
              if (canUpdateBank)
                AppButton(
                  text: 'Cập nhật STK nhận hoàn',
                  size: AppButtonSize.sm,
                  variant: AppButtonVariant.outline,
                  icon: const Icon(LucideIcons.creditCard, size: 14),
                  onPressed: () => _openReservationBankModal(context, r),
                ),
              if (showActionButton && status == 'HELD')
                AppButton(
                  text: 'Đăng ký thông tin nhận nhà',
                  size: AppButtonSize.sm,
                  icon: const Icon(LucideIcons.fileText, size: 14),
                  onPressed: () => _openApplicationModal(
                    context,
                    apartmentId: r['apartment_id']?.toString(),
                  ),
                ),
              AppButton(
                text: 'Xem chi tiết',
                size: AppButtonSize.sm,
                variant: AppButtonVariant.ghost,
                onPressed: () => _openReservationDetailModal(context, r),
              ),
            ],
          ),
        ],
      ),
    );
  }

  /// Welcome banner + status card + inline form + history + apartments khi
  /// cư dân chưa có hợp đồng — parity: OverviewTab.jsx:1579-1830.
  Widget _buildNoContractView(
    BuildContext context,
    Map ov,
    Map user,
    List<Map<String, dynamic>> reservations,
    Map? onboardingApplication,
  ) {
    final reservation = reservations.isNotEmpty ? reservations.first : null;
    final hasHeldReservation =
        reservations.any((r) => _reservationStatus(r) == 'HELD');
    final showInlineOnboardingForm =
        hasHeldReservation && onboardingApplication == null;

    final rawName = user['full_name']?.toString().trim() ?? '';
    final fullName = rawName.isNotEmpty
        ? rawName
        : (reservation?['prospect_name']?.toString().trim() ?? '');
    final greetingName = fullName.isNotEmpty ? fullName : 'Quý khách';

    String message;
    if (reservation != null) {
      final rStatus = _reservationStatus(reservation);
      final apt = reservation['apartment_code']?.toString() ?? '';
      final bld = reservation['building_name']?.toString() ?? '';
      message = switch (rStatus) {
        'PENDING_CONFIRM' =>
          'Phiếu đặt cọc giữ chỗ căn hộ $apt ($bld) của bạn đang chờ Ban Quản Lý đối soát sao kê ngân hàng.',
        'CANCEL_PENDING_APPROVAL' =>
          'Đề xuất thanh lý hủy giữ chỗ căn hộ $apt ($bld) của bạn đang chờ Chủ nhà phê duyệt.',
        'APPROVED_PENDING_PAYOUT' =>
          'Phiếu giữ chỗ căn hộ $apt ($bld) đã được duyệt hoàn tiền — vui lòng kiểm tra tài khoản ngân hàng nhận hoàn bên dưới.',
        _ =>
          'Bạn đang có phiếu đặt cọc giữ chỗ căn hộ $apt ($bld). Vui lòng kiểm tra thông tin căn hộ và hoàn tất hồ sơ nhận nhà bên dưới.',
      };
    } else {
      message =
          'Tài khoản của bạn hiện chưa có hợp đồng thuê đang hiệu lực. Bạn có thể theo dõi trạng thái hồ sơ giữ chỗ hoặc chọn căn hộ trống bên dưới để gửi đăng ký thuê trực tuyến.';
    }

    const activeStatuses = <String>{
      'HELD',
      'PENDING_CONFIRM',
      'CANCEL_PENDING_APPROVAL',
      'APPROVED_PENDING_PAYOUT',
      'CONVERTED',
    };
    final history = (ov['reservation_history'] is List
            ? ov['reservation_history'] as List
            : const [])
        .whereType<Map<String, dynamic>>()
        .where((h) => !activeStatuses.contains(_reservationStatus(h)))
        .toList();
    final availableApartments = (ov['available_apartments'] is List
            ? ov['available_apartments'] as List
            : const [])
        .whereType<Map<String, dynamic>>()
        .toList();
    final idImages =
        ov['id_images'] is List ? ov['id_images'] as List : const [];

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Container(
          key: const Key('resident-onboarding-welcome'),
          padding: const EdgeInsets.all(20),
          decoration: BoxDecoration(
            gradient: LinearGradient(
              colors: [
                AppColors.sky500,
                AppColors.primary600,
                const Color(0xFF4338CA),
              ],
              begin: Alignment.topLeft,
              end: Alignment.bottomRight,
            ),
            borderRadius: BorderRadius.circular(20),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              _heroBadge(
                icon: LucideIcons.sparkles,
                label: 'Chào mừng đến với ResiHub',
                background: Colors.white.withValues(alpha: 0.20),
              ),
              const SizedBox(height: 12),
              Text(
                'Xin chào, $greetingName!',
                style: const TextStyle(
                  fontFamily: 'Inter',
                  fontSize: 24,
                  fontWeight: FontWeight.bold,
                  color: Colors.white,
                ),
              ),
              const SizedBox(height: 6),
              Text(
                message,
                style: const TextStyle(
                  fontFamily: 'Inter',
                  fontSize: 13,
                  color: Color(0xFFE0F2FE),
                ),
              ),
              if (!showInlineOnboardingForm) ...[
                const SizedBox(height: 16),
                AppButton(
                  text: hasHeldReservation
                      ? 'Đăng ký thông tin nhận nhà'
                      : 'Đăng ký thuê trực tuyến',
                  variant: AppButtonVariant.outline,
                  icon: const Icon(LucideIcons.send, size: 14),
                  onPressed: () => _openApplicationModal(
                    context,
                    apartmentId: hasHeldReservation
                        ? (reservation?['apartment_id']?.toString() ?? '')
                        : null,
                  ),
                ),
              ],
            ],
          ),
        ),
        if (reservations.isNotEmpty) ...[
          const SizedBox(height: 16),
          _buildReservationBanners(context, reservations,
              showActionButton: false),
        ],
        if (onboardingApplication != null) ...[
          const SizedBox(height: 16),
          _buildOnboardingStatusCard(context, onboardingApplication),
        ],
        if (showInlineOnboardingForm) ...[
          const SizedBox(height: 16),
          _InlineOnboardingForm(
            user: user,
            reservation: reservation,
            availableApartments: availableApartments,
            idImages: idImages,
            onRefresh: widget.onRefreshOverview,
          ),
        ],
        if (history.isNotEmpty) ...[
          const SizedBox(height: 16),
          _buildReservationHistoryCard(history),
        ],
        const SizedBox(height: 16),
        _buildAvailableApartmentsCard(
            context, availableApartments, reservations),
      ],
    );
  }

  /// Card trạng thái hồ sơ PENDING / APPROVED / REJECTED — parity: 462-582.
  Widget _buildOnboardingStatusCard(BuildContext context, Map app) {
    final status = app['status']?.toString() ?? '';
    final desiredCode = app['desired_apartment_code']?.toString() ?? '';
    final desiredBuilding = app['desired_building_name']?.toString() ?? '';
    final desiredLabel = desiredCode.isNotEmpty
        ? 'căn hộ $desiredCode'
            '${desiredBuilding.isNotEmpty ? ' ($desiredBuilding)' : ''}'
        : '';
    final note = app['application_note']?.toString() ?? '';
    final submittedAt = formatDateTime(app['updated_at'] ?? app['created_at']);

    final Color bg;
    final Color iconBg;
    final IconData icon;
    final String heading;
    final String badge;
    final String body;
    final AppBadgeVariant badgeVariant;
    final String? actionLabel;
    final AppButtonVariant actionVariant;

    switch (status) {
      case 'REJECTED':
        bg = AppColors.rose50;
        iconBg = AppColors.rose100;
        icon = LucideIcons.xCircle;
        heading =
            'Hồ sơ đăng ký thuê ${desiredLabel.isNotEmpty ? 'cho $desiredLabel ' : ''}cần bổ sung thông tin';
        badge = 'Cần chỉnh sửa';
        badgeVariant = AppBadgeVariant.red;
        final reason = app['rejection_reason']?.toString().trim() ?? '';
        body =
            'Lý do từ Ban Quản Lý: ${reason.isNotEmpty ? reason : 'Vui lòng kiểm tra và cập nhật lại thông tin giấy tờ tùy thân.'}';
        actionLabel = 'Chỉnh sửa & Gửi lại hồ sơ';
        actionVariant = AppButtonVariant.primary;
        break;
      case 'APPROVED':
        bg = AppColors.emerald50;
        iconBg = AppColors.emerald100;
        icon = LucideIcons.checkCircle2;
        heading = 'Hồ sơ cư dân đã được phê duyệt';
        badge = 'Đã duyệt — Chờ lập HĐ';
        badgeVariant = AppBadgeVariant.emerald;
        body = 'Ban Quản Lý đã xác thực thông tin định danh của bạn'
            '${desiredLabel.isNotEmpty ? ' cho $desiredLabel' : ''} và sẽ liên hệ để ký kết hợp đồng thuê.';
        actionLabel = null;
        actionVariant = AppButtonVariant.primary;
        break;
      case 'PENDING':
        bg = AppColors.amber50;
        iconBg = AppColors.amber100;
        icon = LucideIcons.clock;
        heading = 'Hồ sơ đang chờ Ban Quản Lý phê duyệt';
        badge = 'Chờ phê duyệt';
        badgeVariant = AppBadgeVariant.amber;
        body = 'Hồ sơ tự khai của bạn'
            '${desiredLabel.isNotEmpty ? ' cho $desiredLabel' : ''} gửi lúc $submittedAt đã được ghi nhận. Ban Quản Lý sẽ đối chiếu giấy tờ và hoàn tất hợp đồng thuê.';
        actionLabel = 'Cập nhật bổ sung thông tin hồ sơ';
        actionVariant = AppButtonVariant.outline;
        break;
      default:
        return const SizedBox.shrink();
    }

    return Container(
      key: const Key('resident-onboarding-status-card'),
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: bg,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: bg),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Container(
            width: 40,
            height: 40,
            decoration: BoxDecoration(
              color: iconBg,
              borderRadius: BorderRadius.circular(12),
            ),
            child: Icon(icon, size: 20, color: AppColors.slate700),
          ),
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
                    Text(
                      heading,
                      style: const TextStyle(
                        fontFamily: 'Inter',
                        fontSize: 14,
                        fontWeight: FontWeight.w600,
                        color: AppColors.slate900,
                      ),
                    ),
                    AppBadge(label: badge, variant: badgeVariant, dot: true),
                  ],
                ),
                const SizedBox(height: 6),
                Text(
                  body,
                  style: const TextStyle(
                    fontFamily: 'Inter',
                    fontSize: 12,
                    color: AppColors.slate600,
                  ),
                ),
                if (note.isNotEmpty) ...[
                  const SizedBox(height: 6),
                  Text(
                    '${status == 'APPROVED' ? 'Ghi chú hồ sơ' : 'Ghi chú của bạn'}: $note',
                    style: const TextStyle(
                      fontFamily: 'Inter',
                      fontSize: 12,
                      color: AppColors.slate600,
                    ),
                  ),
                ],
                const SizedBox(height: 12),
                Wrap(
                  spacing: 8,
                  runSpacing: 8,
                  children: [
                    if (actionLabel != null)
                      AppButton(
                        text: actionLabel,
                        size: AppButtonSize.xs,
                        variant: actionVariant,
                        onPressed: () => _openApplicationModal(
                          context,
                          apartmentId: app['desired_apartment_id']?.toString(),
                        ),
                      ),
                    AppButton(
                      text: 'Xem chi tiết',
                      size: AppButtonSize.xs,
                      variant: AppButtonVariant.ghost,
                      onPressed: () => _openReservationDetailModal(
                        context,
                        {'application': app},
                        isApplicationOnly: true,
                      ),
                    ),
                  ],
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildReservationHistoryCard(List<Map<String, dynamic>> history) {
    return AppCard(
      header: const AppCardHeader(
        title: 'Lịch sử phiếu đặt cọc giữ chỗ',
        subtitle:
            'Các phiếu giữ chỗ đã thanh lý, hoàn trả hoặc từ chối đối soát',
      ),
      child: Column(
        children: [
          for (final h in history)
            Container(
              margin: const EdgeInsets.only(bottom: 10),
              padding: const EdgeInsets.all(14),
              decoration: BoxDecoration(
                color: AppColors.slate50,
                borderRadius: BorderRadius.circular(12),
                border: Border.all(color: AppColors.slate200),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Wrap(
                    spacing: 8,
                    runSpacing: 4,
                    crossAxisAlignment: WrapCrossAlignment.center,
                    children: [
                      Text(
                        'Căn ${h['apartment_code'] ?? ''} — ${h['building_name'] ?? ''}',
                        style: const TextStyle(
                          fontFamily: 'Inter',
                          fontSize: 13,
                          fontWeight: FontWeight.bold,
                          color: AppColors.slate900,
                        ),
                      ),
                      StatusBadge(
                        status: _reservationStatus(h),
                        domain: StatusDomain.reservation,
                      ),
                    ],
                  ),
                  const SizedBox(height: 4),
                  Text(
                    'Số tiền cọc giữ chỗ: ${formatMoney(h['hold_amount'] ?? 0)}'
                    ' • Hoàn trả: ${formatMoney(h['refunded_amount'] ?? 0)}'
                    ' • Tịch thu/Khấu trừ: ${formatMoney(h['forfeited_amount'] ?? 0)}',
                    style: const TextStyle(
                      fontFamily: 'Inter',
                      fontSize: 12,
                      color: AppColors.slate600,
                    ),
                  ),
                  if ((h['settlement_reason']?.toString() ?? '')
                      .isNotEmpty) ...[
                    const SizedBox(height: 2),
                    Text(
                      'Lý do: ${h['settlement_reason']}',
                      style: const TextStyle(
                        fontFamily: 'Inter',
                        fontSize: 12,
                        color: AppColors.slate500,
                      ),
                    ),
                  ],
                  const SizedBox(height: 6),
                  Align(
                    alignment: Alignment.centerRight,
                    child: AppButton(
                      text: 'Xem chi tiết',
                      size: AppButtonSize.xs,
                      variant: AppButtonVariant.ghost,
                      onPressed: () => _openReservationDetailModal(
                        context,
                        h,
                      ),
                    ),
                  ),
                ],
              ),
            ),
        ],
      ),
    );
  }

  Widget _buildAvailableApartmentsCard(
    BuildContext context,
    List<Map<String, dynamic>> apartments,
    List<Map<String, dynamic>> reservations,
  ) {
    return AppCard(
      header: const AppCardHeader(
        title: 'Căn hộ còn trống khả dụng',
        subtitle:
            'Chọn căn hộ phù hợp và gửi hồ sơ đăng ký thuê trực tuyến chỉ trong 1 phút',
      ),
      child: apartments.isEmpty
          ? EmptyState(
              icon: LucideIcons.building2,
              title: 'Hiện chưa có căn hộ trống công khai',
              description:
                  'Bạn vẫn có thể gửi hồ sơ đăng ký chờ hoặc liên hệ trực tiếp Ban Quản Lý để được tư vấn căn hộ sắp trống.',
              action: AppButton(
                text: 'Gửi hồ sơ đăng ký thuê',
                icon: const Icon(LucideIcons.send, size: 14),
                onPressed: () => _openApplicationModal(context),
              ),
            )
          : LayoutBuilder(
              builder: (context, constraints) {
                const gap = 12.0;
                final columns = constraints.maxWidth >= 1200
                    ? 3
                    : (constraints.maxWidth >= 640 ? 2 : 1);
                final width = columns == 3
                    ? (constraints.maxWidth - gap * 2) / 3
                    : (columns == 2
                        ? (constraints.maxWidth - gap) / 2
                        : constraints.maxWidth);
                return Wrap(
                  spacing: gap,
                  runSpacing: gap,
                  children: [
                    for (final apt in apartments)
                      SizedBox(
                        width: width,
                        child: _buildAvailableApartmentTile(
                          context,
                          apt,
                          reservations,
                        ),
                      ),
                  ],
                );
              },
            ),
    );
  }

  Widget _buildAvailableApartmentTile(
    BuildContext context,
    Map<String, dynamic> apt,
    List<Map<String, dynamic>> reservations,
  ) {
    final isReserved = reservations.any((r) =>
            r['apartment_id']?.toString() == apt['id']?.toString() &&
            ['HELD', 'CANCEL_PENDING_APPROVAL']
                .contains(_reservationStatus(r))) ||
        apt['status']?.toString() == 'RESERVED';
    final amenities = parseResidentAmenities(apt['amenities']);

    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(
          color: isReserved ? AppColors.sky200 : AppColors.slate200,
        ),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      'Căn ${apt['code'] ?? ''}',
                      style: const TextStyle(
                        fontFamily: 'Inter',
                        fontSize: 16,
                        fontWeight: FontWeight.bold,
                        color: AppColors.slate900,
                      ),
                    ),
                    const SizedBox(height: 2),
                    Text(
                      '${apt['building_name'] ?? ''}'
                      '${apt['building_address'] != null ? ' — ${apt['building_address']}' : ''}',
                      style: const TextStyle(
                        fontFamily: 'Inter',
                        fontSize: 12,
                        color: AppColors.slate600,
                      ),
                    ),
                  ],
                ),
              ),
              AppBadge(
                label: isReserved ? 'Đang giữ chỗ' : 'Còn trống',
                variant:
                    isReserved ? AppBadgeVariant.sky : AppBadgeVariant.emerald,
                dot: true,
              ),
            ],
          ),
          const SizedBox(height: 10),
          Wrap(
            spacing: 6,
            runSpacing: 6,
            children: [
              Text(
                apt['area_m2'] != null ? '${apt['area_m2']} m²' : '—',
                style: const TextStyle(
                    fontFamily: 'Inter',
                    fontSize: 12,
                    color: AppColors.slate600),
              ),
              const Text('•', style: TextStyle(color: AppColors.slate300)),
              Text(
                apt['type']?.toString() ?? '${apt['bedrooms'] ?? 1} PN',
                style: const TextStyle(
                    fontFamily: 'Inter',
                    fontSize: 12,
                    color: AppColors.slate600),
              ),
              if (apt['floor_name'] != null) ...[
                const Text('•', style: TextStyle(color: AppColors.slate300)),
                Text(
                  '${apt['floor_name']}',
                  style: const TextStyle(
                      fontFamily: 'Inter',
                      fontSize: 12,
                      color: AppColors.slate600),
                ),
              ],
            ],
          ),
          if (amenities.isNotEmpty) ...[
            const SizedBox(height: 8),
            Wrap(
              spacing: 6,
              runSpacing: 6,
              children: [
                for (final amenity in amenities.take(5))
                  Container(
                    padding:
                        const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                    decoration: BoxDecoration(
                      color: AppColors.slate100,
                      borderRadius: BorderRadius.circular(6),
                    ),
                    child: Text(
                      amenity,
                      style: const TextStyle(
                        fontFamily: 'Inter',
                        fontSize: 11,
                        color: AppColors.slate600,
                      ),
                    ),
                  ),
              ],
            ),
          ],
          const SizedBox(height: 14),
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Text(
                    'Giá thuê niêm yết',
                    style: TextStyle(
                      fontFamily: 'Inter',
                      fontSize: 11,
                      color: AppColors.slate400,
                    ),
                  ),
                  Text(
                    '${formatMoney(apt['base_rent'] ?? 0)}/tháng',
                    style: const TextStyle(
                      fontFamily: 'Inter',
                      fontSize: 13,
                      fontWeight: FontWeight.bold,
                      color: AppColors.primary600,
                    ),
                  ),
                ],
              ),
              AppButton(
                text: isReserved ? 'Đăng ký nhận nhà' : 'Đăng ký thuê',
                size: AppButtonSize.sm,
                onPressed: () => _openApplicationModal(
                  context,
                  apartmentId: apt['id']?.toString(),
                ),
              ),
            ],
          ),
        ],
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
        : (ov['contract'] is Map
            ? ov['contract'] as Map<String, dynamic>
            : null);

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
    final buildingAddress =
        contract?['building_address']?.toString().trim() ?? '';
    final amenities = contract != null
        ? parseResidentAmenities(contract['amenities'])
        : const <String>[];

    final rawReservations = ov['reservations'] is List
        ? ov['reservations'] as List
        : (ov['reservation'] is Map ? [ov['reservation']] : const []);
    final reservations =
        rawReservations.whereType<Map<String, dynamic>>().toList();
    final onboardingApplication = ov['onboarding_application'] is Map
        ? ov['onboarding_application'] as Map
        : (ov['pending_application'] is Map
            ? ov['pending_application'] as Map
            : null);

    // Chưa có hợp đồng → nhánh riêng (React OverviewTab.jsx:1579-1830):
    // ẩn hero / KPI / quick actions, thay bằng onboarding + giữ chỗ.
    if (contract == null) {
      return RefreshIndicator(
        onRefresh: widget.onRefreshOverview,
        child: SingleChildScrollView(
          physics: const AlwaysScrollableScrollPhysics(),
          padding: const EdgeInsets.all(16),
          child: _buildNoContractView(
            context,
            ov,
            user,
            reservations,
            onboardingApplication,
          ),
        ),
      );
    }

    final unreadCount = ref.watch(notificationProvider).unreadCount;
    final currentAmountDue = ov['current_amount_due'] is num
        ? ov['current_amount_due'] as num
        : num.tryParse(ov['current_amount_due']?.toString() ?? '0') ?? 0;
    final latestInvoice =
        ov['latest_invoice'] is Map ? ov['latest_invoice'] as Map : null;

    return RefreshIndicator(
      onRefresh: widget.onRefreshOverview,
      child: SingleChildScrollView(
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            // Prospect Reservation Banner(s) — parity: OverviewTab.jsx:903-1079
            if (reservations.isNotEmpty) ...[
              _buildReservationBanners(context, reservations,
                  showActionButton: onboardingApplication == null),
            ],

            // Active Resident Apartment Hero Banner (parity: OverviewTab.jsx:1089-1205)
            ...[
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

                final kpiContract = contract;
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

/// Form đăng ký nhận nhà inline (khi đang giữ chỗ, chưa có hồ sơ) —
/// parity: OverviewTab.jsx:1627-1640 + 311-438.
class _InlineOnboardingForm extends ConsumerStatefulWidget {
  final Map user;
  final Map<String, dynamic>? reservation;
  final List<Map<String, dynamic>> availableApartments;
  final List idImages;
  final Future<void> Function() onRefresh;

  const _InlineOnboardingForm({
    required this.user,
    required this.reservation,
    required this.availableApartments,
    required this.idImages,
    required this.onRefresh,
  });

  @override
  ConsumerState<_InlineOnboardingForm> createState() =>
      _InlineOnboardingFormState();
}

class _InlineOnboardingFormState extends ConsumerState<_InlineOnboardingForm> {
  late final TextEditingController _nameCtrl;
  late final TextEditingController _idCtrl;
  late final TextEditingController _dobCtrl;
  late final TextEditingController _noteCtrl;
  String? _apartmentId;
  bool _consent = false;
  bool _submitting = false;
  String? _frontData;
  String? _backData;

  @override
  void initState() {
    super.initState();
    final user = widget.user;
    final reservation = widget.reservation;
    final name = user['full_name']?.toString().trim() ?? '';
    _nameCtrl = TextEditingController(
      text: name.isNotEmpty
          ? name
          : (reservation?['prospect_name']?.toString() ?? ''),
    );
    _idCtrl = TextEditingController(text: user['id_number']?.toString() ?? '');
    _dobCtrl = TextEditingController(text: toInputDate(user['dob']));
    _noteCtrl = TextEditingController();
    _apartmentId = reservation?['apartment_id']?.toString() ??
        (widget.availableApartments.isNotEmpty
            ? widget.availableApartments.first['id']?.toString()
            : null);
    _consent = user['privacy_consent_at'] != null;
  }

  @override
  void dispose() {
    _nameCtrl.dispose();
    _idCtrl.dispose();
    _dobCtrl.dispose();
    _noteCtrl.dispose();
    super.dispose();
  }

  List<DropdownMenuItem<String>> _apartmentOptions() {
    final seen = <String>{};
    final options = <DropdownMenuItem<String>>[];
    final r = widget.reservation;
    if (r != null &&
        (r['reservation_status'] ?? r['status'] ?? 'HELD') == 'HELD') {
      final id = r['apartment_id']?.toString();
      if (id != null && id.isNotEmpty) {
        seen.add(id);
        options.add(DropdownMenuItem(
          value: id,
          child: Text(
            'Căn ${r['apartment_code'] ?? ''} — ${r['building_name'] ?? ''} [Đang giữ chỗ]',
            overflow: TextOverflow.ellipsis,
          ),
        ));
      }
    }
    for (final apt in widget.availableApartments) {
      final id = apt['id']?.toString();
      if (id == null || id.isEmpty || seen.contains(id)) continue;
      seen.add(id);
      options.add(DropdownMenuItem(
        value: id,
        child: Text(
          'Căn ${apt['code'] ?? ''} — ${apt['building_name'] ?? ''}'
          '${apt['status']?.toString() == 'RESERVED' ? ' [Đang giữ chỗ]' : ''}',
          overflow: TextOverflow.ellipsis,
        ),
      ));
    }
    return options;
  }

  Future<void> _pickDob() async {
    final initial =
        DateTime.tryParse(_dobCtrl.text.trim()) ?? DateTime(2000, 1, 1);
    final picked = await showDatePicker(
      context: context,
      initialDate: initial,
      firstDate: DateTime(1950),
      lastDate: DateTime.now(),
    );
    if (picked != null && mounted) {
      setState(() => _dobCtrl.text = toInputDate(picked));
    }
  }

  Future<void> _submit() async {
    final name = _nameCtrl.text.trim();
    final idNumber = _idCtrl.text.trim();
    if (name.isEmpty) {
      ref.read(toastProvider.notifier).error('Vui lòng nhập họ và tên đầy đủ.');
      return;
    }
    if (idNumber.isNotEmpty && !isValidIdNumber(idNumber)) {
      ref
          .read(toastProvider.notifier)
          .error('Số CCCD / Hộ chiếu không hợp lệ (9 hoặc 12 chữ số).');
      return;
    }
    if (!_consent) {
      ref.read(toastProvider.notifier).warning(
          'Vui lòng đồng ý với Chính sách bảo vệ dữ liệu cá nhân trước khi gửi hồ sơ.');
      return;
    }

    setState(() => _submitting = true);
    try {
      final service = ref.read(residentServiceProvider);
      if (_frontData != null && _frontData!.isNotEmpty) {
        await service
            .uploadIdImage({'side': 'front', 'image_base64': _frontData});
      }
      if (_backData != null && _backData!.isNotEmpty) {
        await service
            .uploadIdImage({'side': 'back', 'image_base64': _backData});
      }
      await service.submitRentalApplication({
        'full_name': name,
        if (idNumber.isNotEmpty) 'id_number': idNumber,
        if (_dobCtrl.text.trim().isNotEmpty) 'dob': _dobCtrl.text.trim(),
        if (_apartmentId != null && _apartmentId!.isNotEmpty)
          'desired_apartment_id': _apartmentId,
        if (_noteCtrl.text.trim().isNotEmpty) 'note': _noteCtrl.text.trim(),
        'privacy_consent': true,
      });
      ref
          .read(toastProvider.notifier)
          .success('Đã gửi hồ sơ đăng ký nhận nhà thành công!');
      await widget.onRefresh();
    } catch (err) {
      ref
          .read(toastProvider.notifier)
          .error(extractErrorMessage(err, 'Không thể gửi hồ sơ đăng ký.'));
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }

  Map<String, dynamic>? _existingImage(String side) {
    for (final img in [...widget.idImages].reversed) {
      if (img is Map && img['side']?.toString() == side) {
        return Map<String, dynamic>.from(img);
      }
    }
    return null;
  }

  @override
  Widget build(BuildContext context) {
    final options = _apartmentOptions();
    final existingFront = _existingImage('front');
    final existingBack = _existingImage('back');

    return AppCard(
      key: const Key('resident-inline-onboarding-form'),
      header: const AppCardHeader(
        title: 'Đăng ký thông tin nhận nhà',
        subtitle:
            'Khai báo thông tin định danh và tải lên ảnh CCCD 2 mặt để Ban Quản Lý phê duyệt hồ sơ',
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          DropdownButtonFormField<String>(
            value: _apartmentId != null &&
                    options.any((option) => option.value == _apartmentId)
                ? _apartmentId
                : null,
            isExpanded: true,
            decoration: const InputDecoration(
              labelText: 'Căn hộ đăng ký nhận nhà / thuê',
              hintText: '-- Chọn căn hộ (hoặc để BQL tư vấn) --',
              border: OutlineInputBorder(),
              isDense: true,
            ),
            items: options,
            onChanged: (value) => setState(() => _apartmentId = value),
          ),
          const SizedBox(height: 12),
          AppInput(
            label: 'Họ và tên người đăng ký',
            required: true,
            placeholder: 'Nhập họ và tên theo CCCD',
            controller: _nameCtrl,
          ),
          const SizedBox(height: 12),
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Expanded(
                child: GestureDetector(
                  onTap: _pickDob,
                  child: AbsorbPointer(
                    child: AppInput(
                      label: 'Ngày sinh',
                      placeholder: 'YYYY-MM-DD',
                      controller: _dobCtrl,
                    ),
                  ),
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: AppInput(
                  label: 'Số CCCD / Hộ chiếu',
                  placeholder: '001099112233',
                  controller: _idCtrl,
                ),
              ),
            ],
          ),
          const SizedBox(height: 16),
          const Text(
            'Ảnh chụp CCCD 2 mặt (Khuyến khích tải đủ mặt trước & mặt sau để duyệt nhanh)',
            style: TextStyle(
              fontFamily: 'Inter',
              fontSize: 12,
              fontWeight: FontWeight.w600,
              color: AppColors.slate800,
            ),
          ),
          const SizedBox(height: 2),
          const Text(
            'Ảnh giấy tờ được bảo mật nghiêm ngặt, chỉ Ban Quản Lý tòa nhà được phân quyền mới có thể đối chiếu.',
            style: TextStyle(
              fontFamily: 'Inter',
              fontSize: 11,
              color: AppColors.slate500,
            ),
          ),
          const SizedBox(height: 10),
          FileUploadField(
            label: 'Ảnh CCCD mặt trước',
            allowPdf: false,
            hint: existingFront != null
                ? 'Tải ảnh mới để thay mặt trước'
                : 'Chọn ảnh mặt trước (≤ 5MB)',
            onChanged: (value) => _frontData = value?.toString(),
          ),
          const SizedBox(height: 12),
          FileUploadField(
            label: 'Ảnh CCCD mặt sau',
            allowPdf: false,
            hint: existingBack != null
                ? 'Tải ảnh mới để thay mặt sau'
                : 'Chọn ảnh mặt sau (≤ 5MB)',
            onChanged: (value) => _backData = value?.toString(),
          ),
          const SizedBox(height: 12),
          AppInput(
            label: 'Ghi chú / Nhu cầu nhận phòng',
            placeholder:
                'Ví dụ: Ngày dự kiến nhận nhà, số người ở cùng, nhu cầu gửi xe...',
            controller: _noteCtrl,
            multiline: true,
            rows: 2,
          ),
          const SizedBox(height: 12),
          Container(
            padding: const EdgeInsets.all(12),
            decoration: BoxDecoration(
              color: AppColors.slate50,
              borderRadius: BorderRadius.circular(12),
              border: Border.all(color: AppColors.slate200),
            ),
            child: Material(
              type: MaterialType.transparency,
              child: CheckboxListTile(
                value: _consent,
                dense: true,
                contentPadding: EdgeInsets.zero,
                controlAffinity: ListTileControlAffinity.leading,
                onChanged: (checked) =>
                    setState(() => _consent = checked ?? false),
                title: RichText(
                  text: TextSpan(
                    style: const TextStyle(
                      fontFamily: 'Inter',
                      fontSize: 12,
                      color: AppColors.slate700,
                    ),
                    children: [
                      const TextSpan(
                          text:
                              'Tôi xác nhận thông tin khai báo là chính xác và '),
                      const TextSpan(
                        text: 'Đồng ý chính sách bảo vệ dữ liệu cá nhân',
                        style: TextStyle(
                          fontWeight: FontWeight.bold,
                          color: AppColors.slate900,
                        ),
                      ),
                      const TextSpan(
                        text:
                            ' của ResiHub để phục vụ xác minh hồ sơ, lập hợp đồng thuê và quản lý cư trú.',
                      ),
                    ],
                  ),
                ),
              ),
            ),
          ),
          const SizedBox(height: 16),
          Align(
            alignment: Alignment.centerRight,
            child: AppButton(
              text: _submitting ? 'Đang gửi...' : 'Gửi hồ sơ đăng ký',
              icon: const Icon(LucideIcons.send, size: 14),
              loading: _submitting,
              onPressed: _submitting ? null : _submit,
            ),
          ),
        ],
      ),
    );
  }
}
