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
import '../../../shared/widgets/ui/app_input.dart';
import '../../../shared/widgets/ui/app_modal.dart';
import '../../../shared/widgets/ui/auth_media_viewer.dart';
import '../../../shared/widgets/ui/file_upload_field.dart';
import '../services/resident_service.dart';

class InvoicesTab extends ConsumerStatefulWidget {
  final Map<String, dynamic>? overview;
  final Future<void> Function() onRefreshOverview;
  final void Function(String tab, [Map<String, dynamic>? extra]) onNavigateTab;
  final String? invoiceIdParam;

  const InvoicesTab({
    super.key,
    required this.overview,
    required this.onRefreshOverview,
    required this.onNavigateTab,
    this.invoiceIdParam,
  });

  @override
  ConsumerState<InvoicesTab> createState() => _InvoicesTabState();
}

class _InvoicesTabState extends ConsumerState<InvoicesTab> {
  bool _loading = false;
  List<dynamic> _invoices = [];

  @override
  void initState() {
    super.initState();
    _fetchInvoices();
  }

  @override
  void didUpdateWidget(covariant InvoicesTab oldWidget) {
    super.didUpdateWidget(oldWidget);
    final oldCid = oldWidget.overview?['active_contract']?['contract_id'];
    final newCid = widget.overview?['active_contract']?['contract_id'];
    if (oldCid != newCid) {
      _fetchInvoices();
    }
  }

  String? get _contractId {
    final c = widget.overview?['active_contract'] ?? widget.overview?['contract'];
    return c?['contract_id']?.toString() ?? c?['id']?.toString();
  }

  Future<void> _fetchInvoices() async {
    setState(() => _loading = true);
    try {
      final res = await ref.read(residentServiceProvider).listInvoices(_contractId);
      final list = res is Map && res['data'] is List
          ? res['data'] as List
          : (res is List ? res : []);

      if (mounted) {
        setState(() {
          _invoices = list;
          _loading = false;
        });
      }
    } catch (err) {
      if (mounted) {
        setState(() => _loading = false);
        ref
            .read(toastProvider.notifier)
            .error(extractErrorMessage(err, 'Không thể tải danh sách hóa đơn.'));
      }
    }
  }

  void _openPaymentReportModal(BuildContext context, Map<String, dynamic> inv) {
    final invoiceId = inv['invoice_id']?.toString() ?? inv['id']?.toString() ?? '';
    final code = inv['invoice_code']?.toString() ?? '';
    final summary = resolveResidentInvoiceTotalsSummary(inv);

    final amountCtrl = TextEditingController(text: summary.remainingAmount.toString());
    final noteCtrl = TextEditingController();
    String? proofUrl;
    bool submitting = false;

    AppModal.show(
      context: context,
      title: 'Báo đã thanh toán hóa đơn',
      subtitle: '$code • Còn lại: ${formatMoney(summary.remainingAmount)}',
      child: StatefulBuilder(
        builder: (ctx, setModalState) {
          return SingleChildScrollView(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                AppInput(
                  label: 'Số tiền đã chuyển (VND) *',
                  controller: amountCtrl,
                  keyboardType: TextInputType.number,
                ),
                const SizedBox(height: 12),
                FileUploadField(
                  label: 'Ảnh chụp ủy nhiệm chi / biên lai chuyển khoản',
                  value: proofUrl,
                  onChanged: (val) {
                    setModalState(() {
                      proofUrl = val?.toString();
                    });
                  },
                ),
                const SizedBox(height: 12),
                AppInput(
                  label: 'Ghi chú cho kế toán',
                  controller: noteCtrl,
                  hint: 'Ví dụ: Đã chuyển khoản qua app ngân hàng lúc 10h...',
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
                      text: submitting ? 'Đang gửi...' : 'Gửi báo cáo',
                      loading: submitting,
                      onPressed: submitting
                          ? null
                          : () async {
                              final amt = int.tryParse(amountCtrl.text.replaceAll(RegExp(r'\D'), '')) ?? 0;
                              if (amt <= 0) {
                                ref
                                    .read(toastProvider.notifier)
                                    .error('Vui lòng nhập số tiền hợp lệ.');
                                return;
                              }

                              setModalState(() => submitting = true);
                              try {
                                await ref.read(residentServiceProvider).reportPayment({
                                  'invoice_id': invoiceId,
                                  'amount': amt,
                                  'payment_method': 'BANK_TRANSFER',
                                  if (proofUrl != null && proofUrl!.isNotEmpty)
                                    'proof_url': proofUrl,
                                  'note': noteCtrl.text.trim(),
                                });
                                if (ctx.mounted) {
                                  Navigator.of(ctx).pop();
                                }
                                ref
                                    .read(toastProvider.notifier)
                                    .success('Đã gửi báo cáo thanh toán thành công.');
                                await _fetchInvoices();
                                await widget.onRefreshOverview();
                              } catch (err) {
                                setModalState(() => submitting = false);
                                ref
                                    .read(toastProvider.notifier)
                                    .error(extractErrorMessage(err, 'Không thể gửi báo cáo thanh toán.'));
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

  void _showMeterPhotoDialog(BuildContext context, String imageUrl, String title) {
    AuthMediaViewer.show(
      context,
      src: imageUrl,
      title: title,
    );
  }

  @override
  Widget build(BuildContext context) {
    return RefreshIndicator(
      onRefresh: () async {
        await widget.onRefreshOverview();
        await _fetchInvoices();
      },
      child: _loading && _invoices.isEmpty
          ? const Center(child: CircularProgressIndicator())
          : _invoices.isEmpty
              ? Center(
                  child: Padding(
                    padding: const EdgeInsets.all(32),
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Icon(LucideIcons.receipt, size: 48, color: AppColors.slate400),
                        const SizedBox(height: 12),
                        const Text(
                          'Chưa có hóa đơn nào',
                          style: TextStyle(
                            fontFamily: 'Inter',
                            fontSize: 16,
                            fontWeight: FontWeight.w600,
                            color: AppColors.slate800,
                          ),
                        ),
                        const SizedBox(height: 6),
                        const Text(
                          'Các kỳ hóa đơn tiền phòng & dịch vụ sẽ hiển thị tại đây.',
                          style: TextStyle(fontSize: 13, color: AppColors.slate500),
                        ),
                      ],
                    ),
                  ),
                )
              : ListView.builder(
                  padding: const EdgeInsets.all(16),
                  itemCount: _invoices.length,
                  itemBuilder: (context, index) {
                    final inv = _invoices[index] is Map
                        ? Map<String, dynamic>.from(_invoices[index] as Map)
                        : <String, dynamic>{};

                    final summary = resolveResidentInvoiceTotalsSummary(inv);
                    final status = inv['status']?.toString().toUpperCase() ?? '';
                    final isPaid = status == 'PAID';
                    final lines = inv['lines'] is List ? inv['lines'] as List : const [];

                    return Container(
                      margin: const EdgeInsets.only(bottom: 16),
                      decoration: BoxDecoration(
                        color: Colors.white,
                        borderRadius: BorderRadius.circular(16),
                        border: Border.all(color: AppColors.slate200),
                        boxShadow: const [
                          BoxShadow(
                            color: Color.fromRGBO(15, 23, 42, 0.03),
                            blurRadius: 8,
                            offset: Offset(0, 2),
                          ),
                        ],
                      ),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        children: [
                          // Header
                          Padding(
                            padding: const EdgeInsets.all(16),
                            child: Row(
                              mainAxisAlignment: MainAxisAlignment.spaceBetween,
                              children: [
                                Row(
                                  children: [
                                    Container(
                                      padding: const EdgeInsets.all(8),
                                      decoration: BoxDecoration(
                                        color: AppColors.primary50,
                                        borderRadius: BorderRadius.circular(10),
                                      ),
                                      child: const Icon(LucideIcons.receipt,
                                          size: 20, color: AppColors.primary600),
                                    ),
                                    const SizedBox(width: 12),
                                    Column(
                                      crossAxisAlignment: CrossAxisAlignment.start,
                                      children: [
                                        Text(
                                          inv['invoice_code']?.toString() ?? 'Hóa đơn',
                                          style: const TextStyle(
                                            fontFamily: 'Inter',
                                            fontSize: 15,
                                            fontWeight: FontWeight.bold,
                                            color: AppColors.slate900,
                                          ),
                                        ),
                                        const SizedBox(height: 2),
                                        Text(
                                          inv['billing_period'] != null
                                              ? 'Kỳ: ${inv['billing_period']}'
                                              : (inv['created_at'] != null
                                                  ? formatDate(inv['created_at'])
                                                  : ''),
                                          style: const TextStyle(
                                            fontFamily: 'Inter',
                                            fontSize: 12,
                                            color: AppColors.slate500,
                                          ),
                                        ),
                                      ],
                                    ),
                                  ],
                                ),
                                AppBadge(
                                  label: isPaid
                                      ? 'Đã thanh toán'
                                      : status == 'PARTIALLY_PAID'
                                          ? 'Đã trả một phần'
                                          : 'Chờ thanh toán',
                                  variant: isPaid
                                      ? AppBadgeVariant.emerald
                                      : status == 'PARTIALLY_PAID'
                                          ? AppBadgeVariant.sky
                                          : AppBadgeVariant.red,
                                ),
                              ],
                            ),
                          ),
                          const Divider(color: AppColors.slate100, height: 1),

                          // Lines breakdown
                          if (lines.isNotEmpty)
                            Padding(
                              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
                              child: Column(
                                children: lines.map((l) {
                                  final line = l is Map ? l : const {};
                                  final meterImg = resolveResidentInvoiceLineMeterImage(line);
                                  final itemName = line['item_name']?.toString() ??
                                      line['description']?.toString() ??
                                      'Mục';
                                  final lineAmt = line['amount'] ?? 0;

                                  return Padding(
                                    padding: const EdgeInsets.symmetric(vertical: 4),
                                    child: Row(
                                      mainAxisAlignment: MainAxisAlignment.spaceBetween,
                                      children: [
                                        Expanded(
                                          child: Row(
                                            children: [
                                              Text(
                                                itemName,
                                                style: const TextStyle(
                                                  fontSize: 13,
                                                  color: AppColors.slate700,
                                                ),
                                              ),
                                              if (meterImg != null) ...[
                                                const SizedBox(width: 8),
                                                InkWell(
                                                  onTap: () => _showMeterPhotoDialog(
                                                    context,
                                                    meterImg,
                                                    'Ảnh chỉ số: $itemName',
                                                  ),
                                                  borderRadius: BorderRadius.circular(6),
                                                  child: Container(
                                                    padding: const EdgeInsets.symmetric(
                                                        horizontal: 6, vertical: 2),
                                                    decoration: BoxDecoration(
                                                      color: AppColors.primary50,
                                                      borderRadius: BorderRadius.circular(6),
                                                      border: Border.all(color: AppColors.primary200),
                                                    ),
                                                    child: Row(
                                                      mainAxisSize: MainAxisSize.min,
                                                      children: const [
                                                        Icon(LucideIcons.camera,
                                                            size: 12, color: AppColors.primary600),
                                                        SizedBox(width: 4),
                                                        Text(
                                                          'Ảnh công tơ',
                                                          style: TextStyle(
                                                            fontSize: 11,
                                                            fontWeight: FontWeight.w600,
                                                            color: AppColors.primary700,
                                                          ),
                                                        ),
                                                      ],
                                                    ),
                                                  ),
                                                ),
                                              ],
                                            ],
                                          ),
                                        ),
                                        Text(
                                          formatMoney(lineAmt),
                                          style: const TextStyle(
                                            fontFamily: 'Inter',
                                            fontSize: 13,
                                            fontWeight: FontWeight.w600,
                                            color: AppColors.slate800,
                                          ),
                                        ),
                                      ],
                                    ),
                                  );
                                }).toList(),
                              ),
                            ),
                          const Divider(color: AppColors.slate100, height: 1),

                          // Summary footer
                          Padding(
                            padding: const EdgeInsets.all(16),
                            child: Column(
                              children: [
                                Row(
                                  mainAxisAlignment: MainAxisAlignment.spaceBetween,
                                  children: [
                                    const Text('Tổng cộng:',
                                        style: TextStyle(fontSize: 13, color: AppColors.slate600)),
                                    Text(
                                      formatMoney(summary.totalAmount),
                                      style: const TextStyle(
                                        fontFamily: 'Inter',
                                        fontSize: 14,
                                        fontWeight: FontWeight.bold,
                                        color: AppColors.slate900,
                                      ),
                                    ),
                                  ],
                                ),
                                if (summary.paidAmount > 0) ...[
                                  const SizedBox(height: 4),
                                  Row(
                                    mainAxisAlignment: MainAxisAlignment.spaceBetween,
                                    children: [
                                      const Text('Đã thanh toán:',
                                          style: TextStyle(fontSize: 13, color: AppColors.slate600)),
                                      Text(
                                        formatMoney(summary.paidAmount),
                                        style: const TextStyle(
                                          fontFamily: 'Inter',
                                          fontSize: 13,
                                          color: AppColors.emerald600,
                                          fontWeight: FontWeight.w600,
                                        ),
                                      ),
                                    ],
                                  ),
                                ],
                                const SizedBox(height: 6),
                                Row(
                                  mainAxisAlignment: MainAxisAlignment.spaceBetween,
                                  children: [
                                    const Text('Còn lại cần trả:',
                                        style: TextStyle(
                                            fontSize: 13,
                                            fontWeight: FontWeight.w600,
                                            color: AppColors.slate800)),
                                    Text(
                                      formatMoney(summary.remainingAmount),
                                      style: TextStyle(
                                        fontFamily: 'Inter',
                                        fontSize: 16,
                                        fontWeight: FontWeight.bold,
                                        color: summary.remainingAmount > 0
                                            ? AppColors.rose600
                                            : AppColors.emerald600,
                                      ),
                                    ),
                                  ],
                                ),
                                if (!isPaid) ...[
                                  const SizedBox(height: 12),
                                  Row(
                                    mainAxisAlignment: MainAxisAlignment.end,
                                    children: [
                                      AppButton(
                                        text: 'Báo đã thanh toán',
                                        size: AppButtonSize.sm,
                                        icon: const Icon(LucideIcons.send, size: 14),
                                        onPressed: () => _openPaymentReportModal(context, inv),
                                      ),
                                    ],
                                  ),
                                ],
                              ],
                            ),
                          ),
                        ],
                      ),
                    );
                  },
                ),
    );
  }
}
