import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../../../core/theme/app_colors.dart';
import '../../../core/utils/deposit_ui_helpers.dart';
import '../../../core/utils/format.dart';
import '../../../core/utils/validation.dart';
import '../../../shared/providers/toast_provider.dart';
import '../../../shared/widgets/common/bank_select.dart';
import '../../../shared/widgets/ui/app_badge.dart';
import '../../../shared/widgets/ui/app_button.dart';
import '../../../shared/widgets/ui/app_input.dart';
import '../../../shared/widgets/ui/app_modal.dart';
import '../../../shared/widgets/ui/app_select.dart';
import '../../../shared/widgets/ui/html_print_preview_modal.dart';
import '../../contracts/services/contracts_service.dart';
import '../services/resident_service.dart';

class ContractTab extends ConsumerStatefulWidget {
  final Map<String, dynamic>? overview;
  final Future<void> Function() onRefreshOverview;
  final void Function(String tab, [Map<String, dynamic>? extra]) onNavigateTab;

  const ContractTab({
    super.key,
    required this.overview,
    required this.onRefreshOverview,
    required this.onNavigateTab,
  });

  @override
  ConsumerState<ContractTab> createState() => _ContractTabState();
}

class _ContractTabState extends ConsumerState<ContractTab> {
  bool _loading = false;
  List<dynamic> _deposits = [];
  List<dynamic> _contractRequests = [];

  @override
  void initState() {
    super.initState();
    _fetchContractData();
  }

  @override
  void didUpdateWidget(covariant ContractTab oldWidget) {
    super.didUpdateWidget(oldWidget);
    final oldCid = oldWidget.overview?['active_contract']?['contract_id'];
    final newCid = widget.overview?['active_contract']?['contract_id'];
    if (oldCid != newCid) {
      _fetchContractData();
    }
  }

  String? get _contractId {
    final c = widget.overview?['active_contract'] ?? widget.overview?['contract'];
    return c?['contract_id']?.toString() ?? c?['id']?.toString();
  }

  Future<void> _fetchContractData() async {
    final cid = _contractId;
    if (cid == null || cid.isEmpty) return;

    setState(() => _loading = true);
    try {
      final res = await Future.wait([
        ref.read(residentServiceProvider).listDepositTransactions(cid),
        ref.read(residentServiceProvider).listContractRequests(cid),
      ]);

      final depData = res[0] is Map && res[0]['data'] is List
          ? res[0]['data'] as List
          : (res[0] is List ? res[0] : []);

      final reqData = res[1] is Map && res[1]['data'] is List
          ? res[1]['data'] as List
          : (res[1] is List ? res[1] : []);

      if (mounted) {
        setState(() {
          _deposits = depData;
          _contractRequests = reqData;
          _loading = false;
        });
      }
    } catch (err) {
      if (mounted) {
        setState(() => _loading = false);
        ref
            .read(toastProvider.notifier)
            .error(extractErrorMessage(err, 'Không thể tải dữ liệu hợp đồng & cọc.'));
      }
    }
  }

  Future<void> _handleViewA4Contract() async {
    final cid = _contractId;
    if (cid == null || cid.isEmpty) {
      ref.read(toastProvider.notifier).error('Không tìm thấy mã hợp đồng.');
      return;
    }

    try {
      final html = await ref.read(contractsServiceProvider).getTemplateHtml(cid);
      if (mounted) {
        await HtmlPrintPreviewModal.show(
          context,
          title: 'Bản in hợp đồng thuê A4',
          htmlContent: html,
          fileName: 'Hop_dong_thue_$cid.pdf',
        );
      }
    } catch (err) {
      ref
          .read(toastProvider.notifier)
          .error(extractErrorMessage(err, 'Không thể tải bản in hợp đồng A4.'));
    }
  }

  Future<void> _handleViewSettlementPdf(String depositId) async {
    try {
      final html = await ref.read(residentServiceProvider).getDepositSettlementPdfHtml(depositId);
      if (mounted) {
        await HtmlPrintPreviewModal.show(
          context,
          title: 'Bảng kê tất toán tiền cọc',
          htmlContent: html,
          fileName: 'Tat_toan_coc_$depositId.pdf',
        );
      }
    } catch (err) {
      ref
          .read(toastProvider.notifier)
          .error(extractErrorMessage(err, 'Không thể tải bảng kê tất toán cọc.'));
    }
  }

  void _openDisputeModal(BuildContext context, Map<String, dynamic> dep) {
    final depositId = dep['deposit_id']?.toString() ?? dep['id']?.toString() ?? '';
    final reasonCtrl = TextEditingController();
    bool submitting = false;

    AppModal.show(
      context: context,
      title: 'Khiếu nại quyết toán tiền cọc',
      subtitle: 'Mã cọc: ${dep['deposit_code'] ?? depositId}',
      child: StatefulBuilder(
        builder: (ctx, setModalState) {
          return Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const Text(
                'Theo quy định, bạn có 7 ngày để gửi khiếu nại nếu không đồng ý với các khoản trừ chi phí tất toán phòng.',
                style: TextStyle(fontSize: 13, color: AppColors.slate600),
              ),
              const SizedBox(height: 12),
              AppInput(
                label: 'Lý do & chi tiết khiếu nại *',
                controller: reasonCtrl,
                multiline: true,
                rows: 4,
                hint: 'Ví dụ: Chi phí sơn tường không hợp lý vì phòng đã được sơn trước khi trả...',
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
                    text: submitting ? 'Đang gửi...' : 'Gửi khiếu nại',
                    variant: AppButtonVariant.danger,
                    loading: submitting,
                    onPressed: submitting
                        ? null
                        : () async {
                            final r = reasonCtrl.text.trim();
                            if (r.isEmpty) {
                              ref
                                  .read(toastProvider.notifier)
                                  .error('Vui lòng nhập lý do khiếu nại.');
                              return;
                            }

                            setModalState(() => submitting = true);
                            try {
                              await ref
                                  .read(residentServiceProvider)
                                  .disputeDeposit(depositId, {'reason': r});
                              if (ctx.mounted) {
                                Navigator.of(ctx).pop();
                              }
                              ref
                                  .read(toastProvider.notifier)
                                  .success('Đã gửi khiếu nại cọc thành công.');
                              await _fetchContractData();
                            } catch (err) {
                              setModalState(() => submitting = false);
                              ref
                                  .read(toastProvider.notifier)
                                  .error(extractErrorMessage(err, 'Không thể gửi khiếu nại.'));
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

  void _openDepositBankModal(BuildContext context, Map<String, dynamic> dep) {
    final depositId = dep['deposit_id']?.toString() ?? dep['id']?.toString() ?? '';
    String bankName = dep['bank_name']?.toString() ?? '';
    String? bankCode = dep['bank_code']?.toString();
    String? bankBin = dep['bank_bin']?.toString();
    final accNumCtrl = TextEditingController(text: dep['account_number']?.toString() ?? '');
    final accHolderCtrl = TextEditingController(text: dep['account_holder']?.toString() ?? '');

    bool saving = false;

    AppModal.show(
      context: context,
      title: 'Tài khoản nhận hoàn tiền cọc',
      subtitle: 'Mã cọc: ${dep['deposit_code'] ?? depositId}',
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
                label: 'Tên chủ tài khoản *',
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
                    text: saving ? 'Đang lưu...' : 'Xác nhận',
                    loading: saving,
                    onPressed: saving
                        ? null
                        : () async {
                            final acc = accNumCtrl.text.trim();
                            final holder = accHolderCtrl.text.trim();
                            if (bankName.isEmpty || acc.isEmpty || holder.isEmpty) {
                              ref
                                  .read(toastProvider.notifier)
                                  .error('Vui lòng điền đủ thông tin ngân hàng.');
                              return;
                            }

                            setModalState(() => saving = true);
                            try {
                              await ref
                                  .read(residentServiceProvider)
                                  .updateDepositRefundBankInfo(depositId, {
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
                                  .success('Đã lưu thông tin tài khoản hoàn cọc.');
                              await _fetchContractData();
                            } catch (err) {
                              setModalState(() => saving = false);
                              ref.read(toastProvider.notifier).error(
                                    extractErrorMessage(err, 'Không thể cập nhật ngân hàng.'),
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

  void _openCreateContractRequestModal(BuildContext context) {
    final cid = _contractId;
    if (cid == null || cid.isEmpty) return;

    String requestType = 'RENEWAL';
    final reasonCtrl = TextEditingController();
    final noteCtrl = TextEditingController();
    bool submitting = false;

    AppModal.show(
      context: context,
      title: 'Gửi yêu cầu hợp đồng',
      subtitle: 'Gia hạn, đề xuất chấm dứt hoặc chuyển phòng',
      child: StatefulBuilder(
        builder: (ctx, setModalState) {
          return SingleChildScrollView(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                AppSelect<String>(
                  label: 'Loại yêu cầu',
                  value: requestType,
                  options: const [
                    AppSelectOption(value: 'RENEWAL', label: 'Gia hạn hợp đồng'),
                    AppSelectOption(value: 'TERMINATION', label: 'Chấm dứt trước hạn'),
                    AppSelectOption(value: 'TRANSFER_ROOM', label: 'Chuyển đổi phòng'),
                  ],
                  onChanged: (val) {
                    if (val != null) {
                      setModalState(() => requestType = val);
                    }
                  },
                ),
                const SizedBox(height: 12),
                AppInput(
                  label: 'Lý do yêu cầu *',
                  controller: reasonCtrl,
                  hint: 'Nêu rõ lý do hoặc thời gian mong muốn...',
                  multiline: true,
                  rows: 3,
                ),
                const SizedBox(height: 12),
                AppInput(
                  label: 'Ghi chú thêm',
                  controller: noteCtrl,
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
                      text: submitting ? 'Đang gửi...' : 'Gửi yêu cầu',
                      loading: submitting,
                      onPressed: submitting
                          ? null
                          : () async {
                              final reason = reasonCtrl.text.trim();
                              if (reason.isEmpty) {
                                ref.read(toastProvider.notifier).error('Vui lòng nhập lý do.');
                                return;
                              }

                              setModalState(() => submitting = true);
                              try {
                                await ref
                                    .read(residentServiceProvider)
                                    .createContractRequest({
                                  'contract_id': cid,
                                  'request_type': requestType,
                                  'reason': reason,
                                  'note': noteCtrl.text.trim(),
                                });
                                if (ctx.mounted) {
                                  Navigator.of(ctx).pop();
                                }
                                ref
                                    .read(toastProvider.notifier)
                                    .success('Đã gửi yêu cầu hợp đồng.');
                                await _fetchContractData();
                              } catch (err) {
                                setModalState(() => submitting = false);
                                ref.read(toastProvider.notifier).error(
                                      extractErrorMessage(err, 'Không thể gửi yêu cầu hợp đồng.'),
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

  Widget _buildInfoItem(String label, String value) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          label,
          style: const TextStyle(
            fontSize: 11,
            color: AppColors.slate500,
            fontFamily: 'Inter',
          ),
        ),
        const SizedBox(height: 2),
        Text(
          value,
          style: const TextStyle(
            fontSize: 13,
            fontWeight: FontWeight.w600,
            color: AppColors.slate800,
            fontFamily: 'Inter',
          ),
        ),
      ],
    );
  }

  @override
  Widget build(BuildContext context) {
    final contract = widget.overview?['active_contract'] is Map
        ? widget.overview!['active_contract'] as Map<String, dynamic>
        : (widget.overview?['contract'] is Map
            ? widget.overview!['contract'] as Map<String, dynamic>
            : null);

    if (contract == null) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(32),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Icon(LucideIcons.fileX2, size: 48, color: AppColors.slate400),
              const SizedBox(height: 12),
              const Text(
                'Chưa có hợp đồng thuê nào được kích hoạt',
                style: TextStyle(
                  fontFamily: 'Inter',
                  fontSize: 16,
                  fontWeight: FontWeight.w600,
                  color: AppColors.slate800,
                ),
              ),
              const SizedBox(height: 6),
              const Text(
                'Hồ sơ hoặc căn hộ đang trong giai đoạn chuẩn bị.',
                style: TextStyle(fontSize: 13, color: AppColors.slate500),
              ),
            ],
          ),
        ),
      );
    }

    final rawOccupants = contract['occupants'] is List ? contract['occupants'] as List : const [];
    final occupants = rawOccupants.whereType<Map<String, dynamic>>().toList();

    return RefreshIndicator(
      onRefresh: () async {
        await widget.onRefreshOverview();
        await _fetchContractData();
      },
      child: SingleChildScrollView(
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            // Contract Summary Card
            Container(
              decoration: BoxDecoration(
                color: Colors.white,
                borderRadius: BorderRadius.circular(16),
                border: Border.all(color: AppColors.slate200),
              ),
              padding: const EdgeInsets.all(16),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    mainAxisAlignment: MainAxisAlignment.spaceBetween,
                    children: [
                      Text(
                        'Hợp đồng thuê: ${contract['contract_code'] ?? '---'}',
                        style: const TextStyle(
                          fontFamily: 'Inter',
                          fontSize: 15,
                          fontWeight: FontWeight.bold,
                          color: AppColors.slate900,
                        ),
                      ),
                      AppButton(
                        text: 'Xem / In hợp đồng A4',
                        size: AppButtonSize.sm,
                        icon: const Icon(LucideIcons.printer, size: 14),
                        onPressed: _handleViewA4Contract,
                      ),
                    ],
                  ),
                  const SizedBox(height: 12),
                  Row(
                    mainAxisAlignment: MainAxisAlignment.spaceBetween,
                    children: [
                      Text(
                        'Căn hộ: ${contract['apartment_code'] ?? '---'} (${contract['building_name'] ?? 'Tòa nhà'})',
                        style: const TextStyle(
                          fontFamily: 'Inter',
                          fontSize: 14,
                          fontWeight: FontWeight.w600,
                          color: AppColors.slate900,
                        ),
                      ),
                      AppBadge(
                        label: contract['status'] == 'ACTIVE' ? 'Đang hiệu lực' : 'Đang xử lý',
                        variant: contract['status'] == 'ACTIVE'
                            ? AppBadgeVariant.emerald
                            : AppBadgeVariant.amber,
                      ),
                    ],
                  ),
                  const SizedBox(height: 12),
                  const Divider(color: AppColors.slate100, height: 1),
                  const SizedBox(height: 12),
                  Wrap(
                    spacing: 24,
                    runSpacing: 8,
                    children: [
                      _buildInfoItem('Ngày bắt đầu', formatDate(contract['start_date'])),
                      _buildInfoItem('Ngày kết thúc', formatDate(contract['end_date'])),
                      _buildInfoItem(
                          'Giá thuê hàng tháng', formatMoney(contract['monthly_rent'])),
                      _buildInfoItem('Tiền cọc quy định', formatMoney(contract['deposit_amount'])),
                    ],
                  ),
                  const SizedBox(height: 16),
                  Row(
                    mainAxisAlignment: MainAxisAlignment.end,
                    children: [
                      AppButton(
                        text: 'Gửi yêu cầu hợp đồng',
                        size: AppButtonSize.sm,
                        variant: AppButtonVariant.outline,
                        icon: const Icon(LucideIcons.send, size: 14),
                        onPressed: () => _openCreateContractRequestModal(context),
                      ),
                    ],
                  ),
                ],
              ),
            ),
            const SizedBox(height: 16),

            // Occupants List with Masked CCCD
            Container(
              decoration: BoxDecoration(
                color: Colors.white,
                borderRadius: BorderRadius.circular(16),
                border: Border.all(color: AppColors.slate200),
              ),
              padding: const EdgeInsets.all(16),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    'Thành viên cư trú (${occupants.length})',
                    style: const TextStyle(
                      fontFamily: 'Inter',
                      fontSize: 14,
                      fontWeight: FontWeight.w600,
                      color: AppColors.slate900,
                    ),
                  ),
                  const SizedBox(height: 12),
                  if (occupants.isEmpty)
                    const Text(
                      'Chưa có danh sách thành viên đi kèm.',
                      style: TextStyle(color: AppColors.slate500, fontSize: 13),
                    )
                  else
                    ...occupants.map((occ) {
                      final rawId = occ['id_number']?.toString() ?? '';
                      final maskedId = rawId.isNotEmpty ? maskIdNumber(rawId) : '---';
                      return Padding(
                        padding: const EdgeInsets.symmetric(vertical: 8),
                        child: Row(
                          children: [
                            Container(
                              width: 36,
                              height: 36,
                              decoration: BoxDecoration(
                                color: AppColors.primary50,
                                borderRadius: BorderRadius.circular(10),
                              ),
                              child: const Icon(LucideIcons.user,
                                  size: 18, color: AppColors.primary600),
                            ),
                            const SizedBox(width: 12),
                            Expanded(
                              child: Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  Text(
                                    occ['full_name']?.toString() ?? 'Thành viên',
                                    style: const TextStyle(
                                      fontFamily: 'Inter',
                                      fontSize: 14,
                                      fontWeight: FontWeight.w600,
                                      color: AppColors.slate800,
                                    ),
                                  ),
                                  const SizedBox(height: 2),
                                  Text(
                                    'CCCD: $maskedId • ${occ['relationship'] ?? 'Thành viên'}',
                                    style: const TextStyle(
                                      fontFamily: 'Inter',
                                      fontSize: 12,
                                      color: AppColors.slate500,
                                    ),
                                  ),
                                ],
                              ),
                            ),
                          ],
                        ),
                      );
                    }),
                ],
              ),
            ),
            const SizedBox(height: 16),

            // Deposit Ledger & 7-Day Dispute Window
            Container(
              decoration: BoxDecoration(
                color: Colors.white,
                borderRadius: BorderRadius.circular(16),
                border: Border.all(color: AppColors.slate200),
              ),
              padding: const EdgeInsets.all(16),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Text(
                    'Sổ cọc & Quyết toán hoàn tiền',
                    style: TextStyle(
                      fontFamily: 'Inter',
                      fontSize: 14,
                      fontWeight: FontWeight.w600,
                      color: AppColors.slate900,
                    ),
                  ),
                  const SizedBox(height: 12),
                  if (_loading && _deposits.isEmpty)
                    const Center(
                      child: Padding(
                        padding: EdgeInsets.all(16),
                        child: CircularProgressIndicator(),
                      ),
                    )
                  else if (_deposits.isEmpty)
                    const Text(
                      'Chưa có giao dịch tiền cọc nào được ghi nhận.',
                      style: TextStyle(color: AppColors.slate500, fontSize: 13),
                    )
                  else
                    ..._deposits.map((d) {
                      final dep = d is Map ? Map<String, dynamic>.from(d) : <String, dynamic>{};
                      final disputeState = getResidentDisputeWindowState(dep);
                      final canUpdateBank = canResidentUpdateRefundBankInfo(dep);
                      final depId = dep['deposit_id']?.toString() ?? dep['id']?.toString() ?? '';

                      return Container(
                        margin: const EdgeInsets.only(bottom: 12),
                        padding: const EdgeInsets.all(14),
                        decoration: BoxDecoration(
                          color: AppColors.slate50,
                          borderRadius: BorderRadius.circular(12),
                          border: Border.all(color: AppColors.slate200),
                        ),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Row(
                              mainAxisAlignment: MainAxisAlignment.spaceBetween,
                              children: [
                                Text(
                                  dep['deposit_code']?.toString() ?? 'Khoản cọc',
                                  style: const TextStyle(
                                    fontFamily: 'Inter',
                                    fontSize: 14,
                                    fontWeight: FontWeight.bold,
                                    color: AppColors.slate900,
                                  ),
                                ),
                                Text(
                                  formatMoney(dep['deposit_amount'] ?? 0),
                                  style: const TextStyle(
                                    fontFamily: 'Inter',
                                    fontSize: 14,
                                    fontWeight: FontWeight.bold,
                                    color: AppColors.primary700,
                                  ),
                                ),
                              ],
                            ),
                            const SizedBox(height: 8),

                            // 7-day dispute window countdown
                            if (disputeState.canDispute && disputeState.daysRemaining != null)
                              Container(
                                padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
                                margin: const EdgeInsets.only(bottom: 8),
                                decoration: BoxDecoration(
                                  color: Colors.amber.shade50,
                                  borderRadius: BorderRadius.circular(8),
                                  border: Border.all(color: Colors.amber.shade300),
                                ),
                                child: Row(
                                  children: [
                                    const Icon(LucideIcons.clock,
                                        size: 14, color: Colors.amber),
                                    const SizedBox(width: 6),
                                    Expanded(
                                      child: Text(
                                        'Thời hạn khiếu nại quyết toán cọc: còn ${disputeState.daysRemaining} ngày.',
                                        style: const TextStyle(
                                          fontSize: 12,
                                          fontWeight: FontWeight.w600,
                                          color: AppColors.slate800,
                                        ),
                                      ),
                                    ),
                                  ],
                                ),
                              ),

                            Row(
                              mainAxisAlignment: MainAxisAlignment.end,
                              children: [
                                AppButton(
                                  text: 'Xem bảng kê tất toán',
                                  size: AppButtonSize.sm,
                                  variant: AppButtonVariant.outline,
                                  icon: const Icon(LucideIcons.fileSpreadsheet, size: 14),
                                  onPressed: () => _handleViewSettlementPdf(depId),
                                ),
                                if (disputeState.canDispute) ...[
                                  const SizedBox(width: 8),
                                  AppButton(
                                    text: 'Khiếu nại cọc',
                                    size: AppButtonSize.sm,
                                    variant: AppButtonVariant.danger,
                                    icon: const Icon(LucideIcons.alertTriangle, size: 14),
                                    onPressed: () => _openDisputeModal(context, dep),
                                  ),
                                ],
                                if (canUpdateBank) ...[
                                  const SizedBox(width: 8),
                                  AppButton(
                                    text: 'Tài khoản nhận hoàn',
                                    size: AppButtonSize.sm,
                                    icon: const Icon(LucideIcons.creditCard, size: 14),
                                    onPressed: () => _openDepositBankModal(context, dep),
                                  ),
                                ],
                              ],
                            ),
                          ],
                        ),
                      );
                    }),
                ],
              ),
            ),

            if (_contractRequests.isNotEmpty) ...[
              const SizedBox(height: 16),
              Container(
                decoration: BoxDecoration(
                  color: Colors.white,
                  borderRadius: BorderRadius.circular(16),
                  border: Border.all(color: AppColors.slate200),
                ),
                padding: const EdgeInsets.all(16),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      'Yêu cầu hợp đồng đã gửi (${_contractRequests.length})',
                      style: const TextStyle(
                        fontFamily: 'Inter',
                        fontSize: 14,
                        fontWeight: FontWeight.w600,
                        color: AppColors.slate900,
                      ),
                    ),
                    const SizedBox(height: 12),
                    ..._contractRequests.map((r) {
                      final req = r is Map ? r : const {};
                      final type = req['request_type']?.toString() ?? 'Yêu cầu';
                      final reason = req['reason']?.toString() ?? '';
                      final status = req['status']?.toString() ?? 'PENDING';
                      return ListTile(
                        contentPadding: EdgeInsets.zero,
                        title: Text(type == 'RENEWAL'
                            ? 'Gia hạn'
                            : (type == 'TERMINATION' ? 'Chấm dứt' : type)),
                        subtitle: Text(reason),
                        trailing: AppBadge(label: status),
                      );
                    }),
                  ],
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }
}
