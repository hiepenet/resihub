import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../../../core/constants/statuses.dart';
import '../../../core/theme/app_colors.dart';
import '../../../core/utils/billing_helpers.dart';
import '../../../core/utils/format.dart';
import '../../../core/utils/validation.dart';
import '../../../shared/providers/toast_provider.dart';
import '../../../shared/widgets/common/empty_state.dart';
import '../../../shared/widgets/common/page_header.dart';
import '../../../shared/widgets/common/status_badge.dart';
import '../../../shared/widgets/ui/app_badge.dart';
import '../../../shared/widgets/ui/app_button.dart';
import '../../../shared/widgets/ui/app_card.dart';
import '../../../shared/widgets/ui/app_input.dart';
import '../../../shared/widgets/ui/app_modal.dart';
import '../../../shared/widgets/ui/app_select.dart';
import '../../../shared/widgets/ui/app_tabs.dart';
import '../../../shared/widgets/ui/auth_media_viewer.dart';
import '../../../shared/widgets/ui/file_upload_field.dart';
import '../../../shared/widgets/ui/money_input.dart';
import '../../auth/providers/auth_provider.dart';
import '../../auth/providers/permission_provider.dart';
import '../../payments/services/payments_service.dart';
import '../services/invoices_service.dart';

const Map<String, ({String label, AppBadgeVariant variant})> kLineTypeLabels = {
  'RENT': (label: 'Tiền thuê phòng', variant: AppBadgeVariant.sky),
  'ELECTRICITY': (label: 'Tiền điện', variant: AppBadgeVariant.amber),
  'WATER': (label: 'Tiền nước', variant: AppBadgeVariant.sky),
  'SERVICE': (label: 'Dịch vụ tiện ích', variant: AppBadgeVariant.indigo),
  'LATE_FEE': (label: 'Phạt chậm thanh toán', variant: AppBadgeVariant.red),
  'ADJUSTMENT': (label: 'Điều chỉnh', variant: AppBadgeVariant.purple),
  'OTHER': (label: 'Khoản khác', variant: AppBadgeVariant.slate),
};

const List<AppSelectOption<String>> kPaymentMethodOptions = [
  AppSelectOption(value: 'BANK_TRANSFER', label: 'Chuyển khoản'),
  AppSelectOption(value: 'QR_CODE', label: 'QR Code'),
  AppSelectOption(value: 'E_WALLET', label: 'Ví điện tử'),
  AppSelectOption(value: 'CASH', label: 'Tiền mặt'),
  AppSelectOption(value: 'CARD', label: 'Thẻ'),
  AppSelectOption(value: 'OTHER', label: 'Khác'),
];

const List<AppSelectOption<String>> kAdjustmentTargetOptions = [
  AppSelectOption(value: 'SERVICE', label: 'Dịch vụ tiện ích (SERVICE)'),
  AppSelectOption(value: 'RENT', label: 'Tiền thuê phòng (RENT)'),
  AppSelectOption(value: 'LATE_FEE', label: 'Miễn giảm/phạt chậm thanh toán (LATE_FEE)'),
  AppSelectOption(value: 'MANUAL', label: 'Điều chỉnh thủ công khác (MANUAL)'),
];

/// Chi tiết Hóa đơn & Quy trình Hủy 2 Bước (M09).
/// Port of `frontend/src/pages/admin/invoices/InvoiceDetailPage.jsx`.
class InvoiceDetailPage extends ConsumerStatefulWidget {
  final String invoiceId;
  final String? initialModal;

  const InvoiceDetailPage({
    super.key,
    required this.invoiceId,
    this.initialModal,
  });

  @override
  ConsumerState<InvoiceDetailPage> createState() => _InvoiceDetailPageState();
}

class _InvoiceDetailPageState extends ConsumerState<InvoiceDetailPage> {
  String _activeTab = 'details'; // details | audit
  Map<String, dynamic>? _invoice;
  bool _loading = true;
  bool _submitting = false;

  // Audit logs (PRD 8.2)
  List<Map<String, dynamic>> _auditLogs = [];
  bool _auditLoading = false;

  // 4-eyes adjustments list (FR-064)
  List<Map<String, dynamic>> _adjustments = [];

  // DRAFT line edit modal
  bool _lineEditOpen = false;
  Map<String, dynamic>? _editingLine;
  String _lineItemType = 'SERVICE';
  String _lineDescription = '';
  String _lineQuantity = '1';
  String _lineUnitPrice = '0';
  String _lineUnit = 'tháng';

  // Issue confirm modal (PRD 16.1)
  bool _issueConfirmOpen = false;

  // 2-step VOID modal (PRD 16.2)
  bool _voidOpen = false;
  String _typedVoidCode = '';
  String _voidReason = '';

  // 4-eyes adjustment request modal
  bool _adjustOpen = false;
  String _adjustTarget = 'SERVICE';
  String _adjustDeltaAmount = '0';
  String _adjustReason = '';

  // Reject adjustment modal
  Map<String, dynamic>? _rejectAdjTarget;
  String _rejectionReason = '';

  // Quick pay modal
  bool _payOpen = false;
  String _payAmount = '0';
  String _payMethod = 'BANK_TRANSFER';
  String _payRefCode = '';
  String _payNote = '';
  String _payProofImage = '';

  // Proof image preview
  String? _previewProofUrl;

  @override
  void initState() {
    super.initState();
    _fetchDetail();
    _fetchAdjustments();
  }

  Future<void> _fetchDetail() async {
    setState(() => _loading = true);
    try {
      final res = await ref.read(invoicesServiceProvider).getById(widget.invoiceId);
      if (!mounted) return;
      if (res is Map && res['data'] is Map) {
        setState(() {
          _invoice = Map<String, dynamic>.from(res['data'] as Map);
          _loading = false;
        });
      } else if (res is Map) {
        setState(() {
          _invoice = Map<String, dynamic>.from(res);
          _loading = false;
        });
      } else {
        setState(() => _loading = false);
      }
    } catch (err) {
      if (mounted) {
        setState(() => _loading = false);
        ref.read(toastProvider.notifier).error(
              extractErrorMessage(err, 'Không thể tải thông tin chi tiết hóa đơn.'),
            );
      }
    }
  }

  Future<void> _fetchAdjustments() async {
    try {
      final res = await ref.read(invoicesServiceProvider).getAdjustments({'invoice_id': widget.invoiceId});
      if (!mounted) return;
      if (res is Map && res['data'] is List) {
        setState(() {
          _adjustments = (res['data'] as List)
              .whereType<Map>()
              .map((e) => Map<String, dynamic>.from(e))
              .toList();
        });
      } else {
        setState(() {
          _adjustments = [];
        });
      }
    } catch (_) {
      if (mounted) {
        setState(() {
          _adjustments = [];
        });
      }
    }
  }

  Future<void> _fetchAuditLogs() async {
    setState(() => _auditLoading = true);
    try {
      final res = await ref.read(invoicesServiceProvider).getAuditLogs(widget.invoiceId);
      if (!mounted) return;
      if (res is Map && res['data'] is List) {
        setState(() {
          _auditLogs = (res['data'] as List)
              .whereType<Map>()
              .map((e) => Map<String, dynamic>.from(e))
              .toList();
          _auditLoading = false;
        });
      } else {
        setState(() {
          _auditLogs = [];
          _auditLoading = false;
        });
      }
    } catch (_) {
      if (mounted) {
        setState(() {
          _auditLogs = [];
          _auditLoading = false;
        });
      }
    }
  }

  // --- 1. DRAFT Line Handlers ---
  void _openAddLineModal() {
    setState(() {
      _editingLine = null;
      _lineItemType = 'SERVICE';
      _lineDescription = '';
      _lineQuantity = '1';
      _lineUnitPrice = '0';
      _lineUnit = 'tháng';
      _lineEditOpen = true;
    });
  }

  void _openEditLineModal(Map<String, dynamic> line) {
    setState(() {
      _editingLine = line;
      _lineItemType = line['item_type']?.toString() ?? 'SERVICE';
      _lineDescription = line['description']?.toString() ?? '';
      _lineQuantity = line['quantity']?.toString() ?? '1';
      _lineUnitPrice = line['unit_price']?.toString() ?? '0';
      _lineUnit = line['unit']?.toString() ?? 'tháng';
      _lineEditOpen = true;
    });
  }

  Future<void> _handleSaveLine() async {
    if (_lineDescription.trim().isEmpty) {
      ref.read(toastProvider.notifier).warning('Vui lòng nhập diễn giải chi tiết cho dòng phí.');
      return;
    }
    final qty = num.tryParse(_lineQuantity);
    final unitPrice = num.tryParse(_lineUnitPrice);
    if (qty == null || qty <= 0) {
      ref.read(toastProvider.notifier).warning('Số lượng phải lớn hơn 0.');
      return;
    }
    if (unitPrice == null || unitPrice < 0) {
      ref.read(toastProvider.notifier).warning('Đơn giá không hợp lệ.');
      return;
    }

    setState(() => _submitting = true);
    try {
      final payload = {
        'item_type': _lineItemType,
        'description': _lineDescription.trim(),
        'quantity': qty,
        'unit_price': unitPrice.round(),
        'unit': _lineUnit.trim().isNotEmpty ? _lineUnit.trim() : 'lần',
      };

      if (_editingLine != null) {
        await ref.read(invoicesServiceProvider).updateLine(
              widget.invoiceId,
              _editingLine!['id'].toString(),
              payload,
            );
        ref.read(toastProvider.notifier).success('Đã cập nhật dòng khoản phí.');
      } else {
        await ref.read(invoicesServiceProvider).addLine(widget.invoiceId, payload);
        ref.read(toastProvider.notifier).success('Đã thêm dòng khoản phí mới vào bản nháp.');
      }

      setState(() => _lineEditOpen = false);
      _fetchDetail();
    } catch (err) {
      if (mounted) {
        ref.read(toastProvider.notifier).error(
              extractErrorMessage(err, 'Không thể lưu dòng chi tiết khoản phí.'),
            );
      }
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }

  Future<void> _handleDeleteLine(Map<String, dynamic> line) async {
    setState(() => _submitting = true);
    try {
      await ref.read(invoicesServiceProvider).deleteLine(widget.invoiceId, line['id'].toString());
      ref.read(toastProvider.notifier).success('Đã xóa dòng khoản phí.');
      _fetchDetail();
    } catch (err) {
      if (mounted) {
        ref.read(toastProvider.notifier).error(
              extractErrorMessage(err, 'Không thể xóa dòng khoản phí.'),
            );
      }
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }

  // --- 2. Contextual Issue Handler ---
  Future<void> _handleConfirmIssue() async {
    setState(() => _submitting = true);
    try {
      final res = await ref.read(invoicesServiceProvider).issue(widget.invoiceId);
      if (!mounted) return;
      final msg = res is Map && res['message'] != null
          ? res['message'].toString()
          : 'Đã phát hành hóa đơn và thông báo cho cư dân.';
      ref.read(toastProvider.notifier).success(msg);
      setState(() => _issueConfirmOpen = false);
      _fetchDetail();
    } catch (err) {
      if (mounted) {
        ref.read(toastProvider.notifier).error(
              extractErrorMessage(err, 'Không thể phát hành hóa đơn.'),
            );
      }
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }

  // --- 3. 2-Step VOID Handler (PRD 16.2) ---
  Future<void> _handleConfirmVoid() async {
    if (_invoice == null) return;
    final canVoid = canConfirmInvoiceVoid(
      invoice: _invoice!,
      typedInvoiceCode: _typedVoidCode,
      reason: _voidReason,
    );
    if (!canVoid) {
      ref.read(toastProvider.notifier).warning('Vui lòng gõ chính xác mã hóa đơn và nhập lý do hủy đầy đủ.');
      return;
    }

    setState(() => _submitting = true);
    try {
      final res = await ref.read(invoicesServiceProvider).requestAdjustment(widget.invoiceId, {
        'action_type': 'VOID',
        'confirm_invoice_code': _typedVoidCode.trim(),
        'reason': _voidReason.trim(),
      });
      if (!mounted) return;
      final msg = res is Map && res['message'] != null
          ? res['message'].toString()
          : 'Đã lập đề nghị hủy hóa đơn (chờ duyệt 4 mắt).';
      ref.read(toastProvider.notifier).success(msg);
      setState(() {
        _voidOpen = false;
        _typedVoidCode = '';
        _voidReason = '';
      });
      _fetchDetail();
      _fetchAdjustments();
    } catch (err) {
      if (mounted) {
        ref.read(toastProvider.notifier).error(
              extractErrorMessage(err, 'Không thể gửi đề nghị hủy hóa đơn.'),
            );
      }
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }

  // --- 4. 4-Eyes Adjust Handlers ---
  void _openAdjustModal() {
    setState(() {
      _adjustTarget = _invoice?['invoice_type'] == 'LATE_FEE_SETTLEMENT' ? 'LATE_FEE' : 'SERVICE';
      _adjustDeltaAmount = '0';
      _adjustReason = '';
      _adjustOpen = true;
    });
  }

  Future<void> _handleSaveAdjustment() async {
    final deltaNum = num.tryParse(_adjustDeltaAmount)?.round() ?? 0;
    if (deltaNum == 0) {
      ref.read(toastProvider.notifier).warning('Số tiền điều chỉnh delta phải khác 0 (dương để tăng, âm để giảm).');
      return;
    }
    if (_adjustReason.trim().isEmpty) {
      ref.read(toastProvider.notifier).warning('Vui lòng nhập lý do điều chỉnh bắt buộc.');
      return;
    }

    setState(() => _submitting = true);
    try {
      final res = await ref.read(invoicesServiceProvider).requestAdjustment(widget.invoiceId, {
        'action_type': 'ADJUST',
        'adjustment_target': _adjustTarget,
        'delta_amount': deltaNum,
        'reason': _adjustReason.trim(),
      });
      if (!mounted) return;
      final msg = res is Map && res['message'] != null
          ? res['message'].toString()
          : 'Đã tạo đề nghị điều chỉnh hóa đơn (chờ duyệt 4 mắt).';
      ref.read(toastProvider.notifier).success(msg);
      setState(() => _adjustOpen = false);
      _fetchDetail();
      _fetchAdjustments();
    } catch (err) {
      if (mounted) {
        ref.read(toastProvider.notifier).error(
              extractErrorMessage(err, 'Không thể tạo đề nghị điều chỉnh hóa đơn.'),
            );
      }
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }

  Future<void> _handleApproveAdjustment(Map<String, dynamic> adj) async {
    setState(() => _submitting = true);
    try {
      final res = await ref.read(invoicesServiceProvider).approveAdjustment(widget.invoiceId, adj['id'].toString());
      if (!mounted) return;
      final msg = res is Map && res['message'] != null
          ? res['message'].toString()
          : 'Đã phê duyệt điều chỉnh hóa đơn thành công.';
      ref.read(toastProvider.notifier).success(msg);
      _fetchDetail();
      _fetchAdjustments();
    } catch (err) {
      if (mounted) {
        ref.read(toastProvider.notifier).error(
              extractErrorMessage(err, 'Không thể phê duyệt điều chỉnh hóa đơn.'),
            );
      }
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }

  Future<void> _handleRejectAdjustment() async {
    if (_rejectAdjTarget == null) return;
    if (_rejectionReason.trim().isEmpty) {
      ref.read(toastProvider.notifier).warning('Vui lòng nhập lý do từ chối.');
      return;
    }

    setState(() => _submitting = true);
    try {
      final res = await ref.read(invoicesServiceProvider).rejectAdjustment(
            widget.invoiceId,
            _rejectAdjTarget!['id'].toString(),
            {'rejection_reason': _rejectionReason.trim()},
          );
      if (!mounted) return;
      final msg = res is Map && res['message'] != null
          ? res['message'].toString()
          : 'Đã từ chối đề nghị điều chỉnh hóa đơn.';
      ref.read(toastProvider.notifier).success(msg);
      setState(() {
        _rejectAdjTarget = null;
        _rejectionReason = '';
      });
      _fetchDetail();
      _fetchAdjustments();
    } catch (err) {
      if (mounted) {
        ref.read(toastProvider.notifier).error(
              extractErrorMessage(err, 'Không thể từ chối đề nghị điều chỉnh.'),
            );
      }
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }

  // --- 5. Quick Pay Handler ---
  void _openQuickPayModal() {
    if (_invoice == null) return;
    final total = num.tryParse(_invoice!['total_amount']?.toString() ?? '0') ?? 0;
    final paid = num.tryParse(_invoice!['paid_amount']?.toString() ?? '0') ?? 0;
    final rem = total - paid > 0 ? total - paid : total;

    setState(() {
      _payAmount = rem.toString();
      _payMethod = 'BANK_TRANSFER';
      _payRefCode = '';
      _payNote = 'Thu tiền hóa đơn ${_invoice!['invoice_code']}';
      _payProofImage = '';
      _payOpen = true;
    });
  }

  Future<void> _handleSaveQuickPayment() async {
    final amt = num.tryParse(_payAmount)?.round() ?? 0;
    if (amt <= 0) {
      ref.read(toastProvider.notifier).warning('Số tiền thanh toán phải lớn hơn 0.');
      return;
    }

    setState(() => _submitting = true);
    try {
      final res = await ref.read(paymentsServiceProvider).create({
        'invoice_id': widget.invoiceId,
        'amount': amt,
        'method': _payMethod,
        if (_payRefCode.trim().isNotEmpty) 'reference_code': _payRefCode.trim(),
        if (_payNote.trim().isNotEmpty) 'note': _payNote.trim(),
        if (_payProofImage.isNotEmpty) 'proof_images': [_payProofImage],
      });
      if (!mounted) return;
      final msg = res is Map && res['message'] != null
          ? res['message'].toString()
          : 'Ghi nhận thanh toán thành công.';
      ref.read(toastProvider.notifier).success(msg);
      setState(() => _payOpen = false);
      _fetchDetail();
    } catch (err) {
      if (mounted) {
        ref.read(toastProvider.notifier).error(
              extractErrorMessage(err, 'Không thể ghi nhận thanh toán.'),
            );
      }
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_loading) {
      return const Center(child: Padding(padding: EdgeInsets.all(48.0), child: CircularProgressIndicator()));
    }

    if (_invoice == null) {
      return Padding(
        padding: const EdgeInsets.all(24.0),
        child: AppCard(
          padding: const EdgeInsets.all(32),
          child: EmptyState(
            title: 'Không tìm thấy hóa đơn',
            description: 'Hóa đơn không tồn tại hoặc bạn không có quyền truy cập tòa nhà của hóa đơn này.',
            action: AppButton(
              text: 'Quay lại danh sách hóa đơn',
              icon: const Icon(LucideIcons.arrowLeft, size: 14),
              variant: AppButtonVariant.outline,
              onPressed: () {
                try {
                  context.pop();
                } catch (_) {
                  context.go('/admin/invoices');
                }
              },
            ),
          ),
        ),
      );
    }

    final permissions = ref.watch(permissionProvider);
    final user = ref.watch(authProvider).user;
    final canManageInvoices = permissions.canManageInvoices;
    final canManagePayments = permissions.canManagePayments;
    final canApproveInvoiceAdjustments = permissions.canApproveInvoiceAdjustments;
    final canViewFinancialAuditLogs = permissions.canViewFinancialAuditLogs;

    final invoice = _invoice!;
    final totalAmount = num.tryParse(invoice['total_amount']?.toString() ?? '0') ?? 0;
    final paidAmount = num.tryParse(invoice['paid_amount']?.toString() ?? '0') ?? 0;
    final subtotalAmount = num.tryParse(invoice['subtotal_amount']?.toString() ?? '0') ?? 0;
    final adjustmentAmount = num.tryParse(invoice['adjustment_amount']?.toString() ?? '0') ?? 0;
    final creditOffsetAmount = num.tryParse(invoice['credit_offset_amount']?.toString() ?? '0') ?? 0;
    final remaining = (totalAmount - paidAmount > 0) ? totalAmount - paidAmount : 0;

    final isDraft = invoice['status'] == 'DRAFT';
    final isVoid = invoice['status'] == 'VOID';
    final isCancelled = invoice['status'] == 'CANCELLED';
    final isSettlement = invoice['invoice_type'] == 'LATE_FEE_SETTLEMENT';

    final canRequestAdjust = canManageInvoices && !isDraft && !isVoid && !isCancelled;
    final canVoidInvoice = canManageInvoices && !isDraft && !isVoid && !isCancelled && paidAmount == 0;
    final canCollect = canManagePayments && !isDraft && !isVoid && !isCancelled && remaining > 0;

    final lines = invoice['lines'] is List ? (invoice['lines'] as List).whereType<Map>().toList() : [];

    final canConfirmVoidBtn = canConfirmInvoiceVoid(
      invoice: invoice,
      typedInvoiceCode: _typedVoidCode,
      reason: _voidReason,
    );

    return SingleChildScrollView(
      padding: const EdgeInsets.all(24.0),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          PageHeader(
            title: 'Chi tiết Hóa đơn ${invoice['invoice_code'] ?? ''}',
            subtitle: '${invoice['period'] != null ? 'Kỳ thanh toán ${invoice['period']}' : 'Phí phạt tất toán kỳ cuối'} • Căn ${invoice['apartment_code'] ?? '—'} (${invoice['building_name'] ?? '—'})',
            showBack: true,
            onBack: () {
              try {
                context.pop();
              } catch (_) {
                context.go('/admin/invoices');
              }
            },
            actions: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                if (canManageInvoices && isDraft && !isSettlement) ...[
                  AppButton(
                    text: 'Phát hành',
                    icon: const Icon(LucideIcons.send, size: 14),
                    size: AppButtonSize.sm,
                    variant: AppButtonVariant.primary,
                    loading: _submitting,
                    onPressed: () => setState(() => _issueConfirmOpen = true),
                  ),
                  const SizedBox(width: 8),
                ],
                if (canRequestAdjust) ...[
                  AppButton(
                    text: 'Đề nghị điều chỉnh',
                    icon: const Icon(LucideIcons.slidersHorizontal, size: 14),
                    size: AppButtonSize.sm,
                    variant: AppButtonVariant.outline,
                    onPressed: _openAdjustModal,
                  ),
                  const SizedBox(width: 8),
                ],
                if (canCollect) ...[
                  AppButton(
                    text: 'Ghi nhận thu tiền',
                    icon: const Icon(LucideIcons.wallet, size: 14),
                    size: AppButtonSize.sm,
                    variant: AppButtonVariant.success,
                    onPressed: _openQuickPayModal,
                  ),
                  const SizedBox(width: 8),
                ],
                if (canVoidInvoice) ...[
                  AppButton(
                    text: 'Hủy hóa đơn (VOID)',
                    icon: const Icon(LucideIcons.ban, size: 14),
                    size: AppButtonSize.sm,
                    variant: AppButtonVariant.danger,
                    onPressed: () {
                      setState(() {
                        _typedVoidCode = '';
                        _voidReason = '';
                        _voidOpen = true;
                      });
                    },
                  ),
                ],
              ],
            ),
          ),
          const SizedBox(height: 16),

          // Tabs
          AppTabs(
            activeTab: _activeTab,
            onChanged: (tab) {
              setState(() => _activeTab = tab);
              if (tab == 'audit') _fetchAuditLogs();
            },
            tabs: [
              const AppTabItem(id: 'details', label: 'Tờ hóa đơn chi tiết'),
              if (canViewFinancialAuditLogs)
                AppTabItem(
                  id: 'audit',
                  label: 'Lịch sử / Kiểm toán',
                  icon: const Icon(LucideIcons.history, size: 14),
                  count: _auditLogs.isNotEmpty ? _auditLogs.length : null,
                ),
            ],
          ),
          const SizedBox(height: 16),

          if (_activeTab == 'details') ...[
            // Main invoice detail card (A4 paper style)
            AppCard(
              padding: const EdgeInsets.all(24),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  // Invoice Header
                  Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    mainAxisAlignment: MainAxisAlignment.spaceBetween,
                    children: [
                      Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Row(
                            children: [
                              Text(
                                isSettlement ? 'HÓA ĐƠN PHÍ PHẠT TẤT TOÁN' : 'HÓA ĐƠN THU TIỀN KỲ',
                                style: const TextStyle(fontSize: 18, fontWeight: FontWeight.bold, letterSpacing: -0.5),
                              ),
                              const SizedBox(width: 8),
                              StatusBadge(status: invoice['status']?.toString() ?? '', domain: StatusDomain.invoice),
                            ],
                          ),
                          const SizedBox(height: 4),
                          Text(
                            'Mã số: ${invoice['invoice_code'] ?? '—'}',
                            style: const TextStyle(fontFamily: 'monospace', fontSize: 13, fontWeight: FontWeight.bold, color: AppColors.primary700),
                          ),
                          Text(
                            'Đơn vị quản lý: ${invoice['building_name'] ?? '—'}',
                            style: const TextStyle(fontSize: 12, color: AppColors.textSecondary),
                          ),
                        ],
                      ),
                      Column(
                        crossAxisAlignment: CrossAxisAlignment.end,
                        children: [
                          Text('Kỳ đối soát: ${invoice['period'] ?? 'Tất toán kỳ cuối'}', style: const TextStyle(fontSize: 12, fontWeight: FontWeight.bold)),
                          Text('Hạn thanh toán: ${formatDate(invoice['due_date'])}', style: const TextStyle(fontSize: 12, color: AppColors.rose600, fontWeight: FontWeight.w600)),
                          Text('Ngày lập: ${formatDate(invoice['issue_date'] ?? invoice['created_at'])}', style: const TextStyle(fontSize: 12, color: AppColors.textMuted)),
                        ],
                      ),
                    ],
                  ),
                  const Divider(height: 32),

                  // Apartment and Tenant Info
                  Container(
                    padding: const EdgeInsets.all(16),
                    decoration: BoxDecoration(
                      color: AppColors.slate50,
                      borderRadius: BorderRadius.circular(12),
                      border: Border.all(color: AppColors.slate100),
                    ),
                    child: Row(
                      children: [
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              const Row(
                                children: [
                                  Icon(LucideIcons.building2, size: 16, color: AppColors.primary600),
                                  SizedBox(width: 6),
                                  Text('CĂN HỘ / MẶT BẰNG', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 11, color: AppColors.textSecondary)),
                                ],
                              ),
                              const SizedBox(height: 4),
                              Text('Căn ${invoice['apartment_code'] ?? '—'}', style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 14)),
                              Text(invoice['building_name']?.toString() ?? '', style: const TextStyle(fontSize: 12, color: AppColors.textSecondary)),
                              if (invoice['contract_code'] != null)
                                Text('HĐ: ${invoice['contract_code']}', style: const TextStyle(fontSize: 11, fontFamily: 'monospace', color: AppColors.textMuted)),
                            ],
                          ),
                        ),
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              const Row(
                                children: [
                                  Icon(LucideIcons.user, size: 16, color: AppColors.primary600),
                                  SizedBox(width: 6),
                                  Text('NGƯỜI THANH TOÁN (CƯ DÂN)', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 11, color: AppColors.textSecondary)),
                                ],
                              ),
                              const SizedBox(height: 4),
                              Text(invoice['tenant_name']?.toString() ?? 'Khách thuê', style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 14)),
                              Text(invoice['tenant_phone']?.toString() ?? 'Chưa cập nhật SĐT', style: const TextStyle(fontSize: 12, color: AppColors.textSecondary)),
                              if (invoice['tenant_email'] != null)
                                Text(invoice['tenant_email']?.toString() ?? '', style: const TextStyle(fontSize: 11, color: AppColors.textMuted)),
                            ],
                          ),
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(height: 24),

                  // Line Items Section
                  Row(
                    mainAxisAlignment: MainAxisAlignment.spaceBetween,
                    children: [
                      const Text('Chi tiết các khoản phí trong kỳ', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 14)),
                      if (canManageInvoices && isDraft && !isSettlement)
                        AppButton(
                          text: 'Thêm dòng phí',
                          icon: const Icon(LucideIcons.plus, size: 14),
                          size: AppButtonSize.sm,
                          variant: AppButtonVariant.outline,
                          onPressed: _openAddLineModal,
                        ),
                    ],
                  ),
                  const SizedBox(height: 12),

                  // Table of lines
                  Table(
                    border: TableBorder.all(color: AppColors.slate200, width: 1),
                    columnWidths: const {
                      0: FixedColumnWidth(40),
                      1: IntrinsicColumnWidth(),
                      2: FlexColumnWidth(3),
                      3: FixedColumnWidth(60),
                      4: FixedColumnWidth(60),
                      5: IntrinsicColumnWidth(),
                      6: IntrinsicColumnWidth(),
                      7: IntrinsicColumnWidth(),
                    },
                    children: [
                      TableRow(
                        decoration: const BoxDecoration(color: Color(0xFFF8FAFC)),
                        children: [
                          const Padding(padding: EdgeInsets.all(8), child: Text('STT', textAlign: TextAlign.center, style: TextStyle(fontWeight: FontWeight.bold, fontSize: 12))),
                          const Padding(padding: EdgeInsets.all(8), child: Text('Hạng mục', textAlign: TextAlign.center, style: TextStyle(fontWeight: FontWeight.bold, fontSize: 12))),
                          const Padding(padding: EdgeInsets.all(8), child: Text('Diễn giải chi tiết', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 12))),
                          const Padding(padding: EdgeInsets.all(8), child: Text('SL', textAlign: TextAlign.center, style: TextStyle(fontWeight: FontWeight.bold, fontSize: 12))),
                          const Padding(padding: EdgeInsets.all(8), child: Text('ĐVT', textAlign: TextAlign.center, style: TextStyle(fontWeight: FontWeight.bold, fontSize: 12))),
                          const Padding(padding: EdgeInsets.all(8), child: Text('Đơn giá', textAlign: TextAlign.right, style: TextStyle(fontWeight: FontWeight.bold, fontSize: 12))),
                          const Padding(padding: EdgeInsets.all(8), child: Text('Thành tiền', textAlign: TextAlign.right, style: TextStyle(fontWeight: FontWeight.bold, fontSize: 12))),
                          if (isDraft && !isSettlement && canManageInvoices)
                            const Padding(padding: EdgeInsets.all(8), child: Text('Thao tác', textAlign: TextAlign.center, style: TextStyle(fontWeight: FontWeight.bold, fontSize: 12))),
                        ],
                      ),
                      if (lines.isEmpty)
                        TableRow(
                          children: [
                            Padding(
                              padding: const EdgeInsets.all(16),
                              child: Text('Chưa có dòng chi tiết khoản phí nào.', textAlign: TextAlign.center, style: TextStyle(color: AppColors.textMuted, fontSize: 12)),
                            ),
                            const SizedBox(),
                            const SizedBox(),
                            const SizedBox(),
                            const SizedBox(),
                            const SizedBox(),
                            const SizedBox(),
                            if (isDraft && !isSettlement && canManageInvoices) const SizedBox(),
                          ],
                        )
                      else
                        ...lines.asMap().entries.map((entry) {
                          final idx = entry.key;
                          final line = entry.value;
                          final type = line['item_type']?.toString() ?? 'OTHER';
                          final typeMeta = kLineTypeLabels[type] ?? (label: type, variant: AppBadgeVariant.slate);
                          final amt = num.tryParse(line['amount']?.toString() ?? '0') ?? 0;
                          final unitPrice = num.tryParse(line['unit_price']?.toString() ?? '0') ?? 0;

                          return TableRow(
                            children: [
                              Padding(padding: const EdgeInsets.all(8), child: Text('${idx + 1}', textAlign: TextAlign.center, style: const TextStyle(fontSize: 12, color: AppColors.textMuted))),
                              Padding(padding: const EdgeInsets.all(8), child: AppBadge(label: typeMeta.label, variant: typeMeta.variant)),
                              Padding(
                                padding: const EdgeInsets.all(8),
                                child: Column(
                                  crossAxisAlignment: CrossAxisAlignment.start,
                                  children: [
                                    Text(line['description']?.toString() ?? '', style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w500)),
                                    if (line['meter_reading_photo'] != null)
                                      Padding(
                                        padding: const EdgeInsets.only(top: 4.0),
                                        child: InkWell(
                                          onTap: () => setState(() => _previewProofUrl = line['meter_reading_photo']?.toString()),
                                          child: SizedBox(
                                            height: 50,
                                            width: 50,
                                            child: AuthImage(src: line['meter_reading_photo']?.toString()),
                                          ),
                                        ),
                                      ),
                                  ],
                                ),
                              ),
                              Padding(padding: const EdgeInsets.all(8), child: Text('${line['quantity'] ?? 1}', textAlign: TextAlign.center, style: const TextStyle(fontFamily: 'monospace', fontSize: 12))),
                              Padding(padding: const EdgeInsets.all(8), child: Text('${line['unit'] ?? 'tháng'}', textAlign: TextAlign.center, style: const TextStyle(fontSize: 12, color: AppColors.textMuted))),
                              Padding(padding: const EdgeInsets.all(8), child: Text(formatMoney(unitPrice), textAlign: TextAlign.right, style: const TextStyle(fontFamily: 'monospace', fontSize: 12))),
                              Padding(
                                padding: const EdgeInsets.all(8),
                                child: Text(
                                  formatMoney(amt),
                                  textAlign: TextAlign.right,
                                  style: TextStyle(
                                    fontFamily: 'monospace',
                                    fontSize: 12,
                                    fontWeight: FontWeight.bold,
                                    color: amt < 0 ? AppColors.emerald600 : AppColors.textPrimary,
                                  ),
                                ),
                              ),
                              if (isDraft && !isSettlement && canManageInvoices)
                                Padding(
                                  padding: const EdgeInsets.all(8),
                                  child: Row(
                                    mainAxisSize: MainAxisSize.min,
                                    mainAxisAlignment: MainAxisAlignment.center,
                                    children: [
                                      IconButton(
                                        icon: const Icon(LucideIcons.pencil, size: 14),
                                        onPressed: () => _openEditLineModal(Map<String, dynamic>.from(line)),
                                      ),
                                      IconButton(
                                        icon: const Icon(LucideIcons.trash2, size: 14, color: AppColors.rose600),
                                        onPressed: () => _handleDeleteLine(Map<String, dynamic>.from(line)),
                                      ),
                                    ],
                                  ),
                                ),
                            ],
                          );
                        }),
                    ],
                  ),
                  const Divider(height: 32),

                  // Financial Totals Summary & VietQR
                  Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    mainAxisAlignment: MainAxisAlignment.spaceBetween,
                    children: [
                      // VietQR section rendered via AuthImage without JWT leak
                      if (invoice['vietqr_url'] != null || invoice['qr_url'] != null)
                        Container(
                          padding: const EdgeInsets.all(12),
                          decoration: BoxDecoration(
                            border: Border.all(color: AppColors.slate200),
                            borderRadius: BorderRadius.circular(12),
                          ),
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              const Text('Mã QR Thanh toán (VietQR)', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 12)),
                              const SizedBox(height: 8),
                              SizedBox(
                                width: 140,
                                height: 140,
                                child: AuthImage(
                                  src: (invoice['vietqr_url'] ?? invoice['qr_url'])?.toString(),
                                  alt: 'VietQR Invoice',
                                ),
                              ),
                            ],
                          ),
                        )
                      else
                        const SizedBox(),

                      // Totals breakdown
                      ConstrainedBox(
                        constraints: const BoxConstraints(minWidth: 320, maxWidth: 420),
                        child: Column(
                          children: [
                            Row(
                              children: [
                                const Expanded(child: Text('Cộng tiền trước điều chỉnh:', style: TextStyle(fontSize: 12, color: AppColors.textSecondary))),
                                const SizedBox(width: 8),
                                Text(formatMoney(subtotalAmount), style: const TextStyle(fontFamily: 'monospace', fontSize: 12, fontWeight: FontWeight.w500)),
                              ],
                            ),
                            if (adjustmentAmount != 0) ...[
                              const SizedBox(height: 6),
                              Row(
                                children: [
                                  const Expanded(child: Text('Điều chỉnh:', style: TextStyle(fontSize: 12, color: Colors.indigo))),
                                  const SizedBox(width: 8),
                                  Text(
                                    '${adjustmentAmount > 0 ? '+' : ''}${formatMoney(adjustmentAmount)}',
                                    style: const TextStyle(fontFamily: 'monospace', fontSize: 12, color: Colors.indigo, fontWeight: FontWeight.w600),
                                  ),
                                ],
                              ),
                            ],
                            if (creditOffsetAmount > 0) ...[
                              const SizedBox(height: 6),
                              Row(
                                children: [
                                  const Expanded(child: Text('Tín dụng cấn trừ kỳ trước:', style: TextStyle(fontSize: 12, color: AppColors.emerald600))),
                                  const SizedBox(width: 8),
                                  Text(
                                    '-${formatMoney(creditOffsetAmount)}',
                                    style: const TextStyle(fontFamily: 'monospace', fontSize: 12, color: AppColors.emerald600, fontWeight: FontWeight.w600),
                                  ),
                                ],
                              ),
                            ],
                            const Divider(height: 16),
                            Row(
                              children: [
                                const Expanded(child: Text('TỔNG CỘNG PHẢI THU:', style: TextStyle(fontSize: 13, fontWeight: FontWeight.bold))),
                                const SizedBox(width: 8),
                                Text(formatMoney(totalAmount), style: const TextStyle(fontFamily: 'monospace', fontSize: 15, fontWeight: FontWeight.bold, color: AppColors.primary700)),
                              ],
                            ),
                            const SizedBox(height: 6),
                            Row(
                              children: [
                                const Expanded(child: Text('Đã thanh toán thực tế:', style: TextStyle(fontSize: 12, color: AppColors.emerald600, fontWeight: FontWeight.w500))),
                                const SizedBox(width: 8),
                                Text(formatMoney(paidAmount), style: const TextStyle(fontFamily: 'monospace', fontSize: 12, color: AppColors.emerald600, fontWeight: FontWeight.w600)),
                              ],
                            ),
                            const Divider(height: 16),
                            Row(
                              children: [
                                const Expanded(child: Text('CÒN PHẢI THU:', style: TextStyle(fontSize: 13, fontWeight: FontWeight.bold))),
                                const SizedBox(width: 8),
                                Text(
                                  isVoid || isCancelled ? '0 ₫' : formatMoney(remaining),
                                  style: TextStyle(
                                    fontFamily: 'monospace',
                                    fontSize: 14,
                                    fontWeight: FontWeight.bold,
                                    color: remaining > 0 && !isVoid && !isCancelled ? AppColors.rose600 : AppColors.textMuted,
                                  ),
                                ),
                              ],
                            ),
                          ],
                        ),
                      ),
                    ],
                  ),
                ],
              ),
            ),
            const SizedBox(height: 24),

            // 4-Eyes Adjustments List
            if (_adjustments.isNotEmpty) ...[
              AppCard(
                padding: const EdgeInsets.all(20),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Text('Đề nghị điều chỉnh hóa đơn (Quy trình 4 mắt)', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 14)),
                    const SizedBox(height: 4),
                    const Text('Lịch sử các đề nghị tăng/giảm hoặc hủy hóa đơn được lập và phê duyệt độc lập.', style: TextStyle(fontSize: 12, color: AppColors.textSecondary)),
                    const SizedBox(height: 12),
                    ListView.separated(
                      shrinkWrap: true,
                      physics: const NeverScrollableScrollPhysics(),
                      itemCount: _adjustments.length,
                      separatorBuilder: (_, __) => const Divider(),
                      itemBuilder: (context, idx) {
                        final adj = _adjustments[idx];
                        final canApprove = canActorApproveInvoiceAdjustment(
                              actor: user,
                              record: adj,
                              buildingHasActiveOwner: true,
                            ) &&
                            canApproveInvoiceAdjustments &&
                            adj['status'] == 'PENDING_APPROVAL';

                        final isVoidAction = adj['action_type'] == 'VOID';
                        final delta = num.tryParse(adj['delta_amount']?.toString() ?? '0') ?? 0;

                        return ListTile(
                          dense: true,
                          contentPadding: EdgeInsets.zero,
                          title: Row(
                            children: [
                              StatusBadge(status: adj['status']?.toString() ?? '', domain: StatusDomain.invoiceAdjustment),
                              const SizedBox(width: 8),
                              AppBadge(
                                label: isVoidAction ? 'HỦY HÓA ĐƠN' : (adj['adjustment_target']?.toString() ?? ''),
                                variant: isVoidAction ? AppBadgeVariant.slate : AppBadgeVariant.purple,
                              ),
                              const SizedBox(width: 8),
                              if (!isVoidAction)
                                Text(
                                  '${delta > 0 ? '+' : ''}${formatMoney(delta)}',
                                  style: const TextStyle(fontWeight: FontWeight.bold, fontFamily: 'monospace'),
                                ),
                            ],
                          ),
                          subtitle: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              const SizedBox(height: 4),
                              Text('Lý do: ${adj['reason'] ?? '—'}', style: const TextStyle(fontSize: 12)),
                              if (adj['rejection_reason'] != null)
                                Text('Lý do từ chối: ${adj['rejection_reason']}', style: const TextStyle(fontSize: 12, color: AppColors.rose600)),
                              Text(formatDateTime(adj['created_at']), style: const TextStyle(fontSize: 11, color: AppColors.textMuted)),
                            ],
                          ),
                          trailing: canApprove
                              ? Row(
                                  mainAxisSize: MainAxisSize.min,
                                  children: [
                                    AppButton(
                                      text: 'Duyệt',
                                      icon: const Icon(LucideIcons.circleCheck, size: 14),
                                      size: AppButtonSize.sm,
                                      variant: AppButtonVariant.success,
                                      loading: _submitting,
                                      onPressed: () => _handleApproveAdjustment(adj),
                                    ),
                                    const SizedBox(width: 6),
                                    AppButton(
                                      text: 'Từ chối',
                                      size: AppButtonSize.sm,
                                      variant: AppButtonVariant.danger,
                                      loading: _submitting,
                                      onPressed: () {
                                        setState(() {
                                          _rejectAdjTarget = adj;
                                          _rejectionReason = '';
                                        });
                                      },
                                    ),
                                  ],
                                )
                              : null,
                        );
                      },
                    ),
                  ],
                ),
              ),
            ],
          ] else ...[
            // Tab 2: Audit Logs
            AppCard(
              padding: const EdgeInsets.all(20),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Text('Nhật ký kiểm toán tài chính hóa đơn', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 14)),
                  const SizedBox(height: 4),
                  const Text('Toàn bộ lịch sử thêm dòng nháp, phát hành, yêu cầu điều chỉnh và phê duyệt 4 mắt.', style: TextStyle(fontSize: 12, color: AppColors.textSecondary)),
                  const SizedBox(height: 12),
                  if (_auditLoading)
                    const Center(child: Padding(padding: EdgeInsets.all(24), child: CircularProgressIndicator()))
                  else if (_auditLogs.isEmpty)
                    const Padding(
                      padding: EdgeInsets.all(24),
                      child: Center(child: Text('Chưa có bản ghi kiểm toán nào được tạo cho hóa đơn này.', style: TextStyle(color: AppColors.textMuted))),
                    )
                  else
                    ListView.separated(
                      shrinkWrap: true,
                      physics: const NeverScrollableScrollPhysics(),
                      itemCount: _auditLogs.length,
                      separatorBuilder: (_, __) => const Divider(),
                      itemBuilder: (context, idx) {
                        final log = _auditLogs[idx];
                        return ListTile(
                          dense: true,
                          title: Row(
                            children: [
                              Text(formatDateTime(log['created_at']), style: const TextStyle(fontSize: 12, fontFamily: 'monospace', color: AppColors.textMuted)),
                              const SizedBox(width: 8),
                              AppBadge(label: log['action']?.toString() ?? '', variant: AppBadgeVariant.sky),
                            ],
                          ),
                          subtitle: Text('Thực hiện bởi: ${log['actor_name'] ?? log['actor_email'] ?? 'Hệ thống'}'),
                        );
                      },
                    ),
                ],
              ),
            ),
          ],

          // Modal: Add / Edit Line
          if (_lineEditOpen)
            AppModal(
              title: _editingLine != null ? 'Chỉnh sửa khoản phí' : 'Thêm khoản phí vào hóa đơn nháp',
              onClose: () => setState(() => _lineEditOpen = false),
              footer: Row(
                mainAxisAlignment: MainAxisAlignment.end,
                children: [
                  AppButton(
                    text: 'Hủy',
                    variant: AppButtonVariant.outline,
                    onPressed: () => setState(() => _lineEditOpen = false),
                  ),
                  const SizedBox(width: 8),
                  AppButton(
                    text: _editingLine != null ? 'Lưu thay đổi' : 'Thêm dòng',
                    variant: AppButtonVariant.primary,
                    loading: _submitting,
                    onPressed: _handleSaveLine,
                  ),
                ],
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  AppSelect<String>(
                    label: 'Loại khoản phí',
                    value: _lineItemType,
                    options: kLineTypeLabels.entries
                        .where((e) => e.key != 'LATE_FEE')
                        .map((e) => AppSelectOption(value: e.key, label: e.value.label))
                        .toList(),
                    onChanged: (val) => setState(() => _lineItemType = val ?? 'SERVICE'),
                  ),
                  const SizedBox(height: 12),
                  AppInput(
                    label: 'Diễn giải chi tiết *',
                    placeholder: 'VD: Phí giặt là tháng 11, Sửa khóa căn hộ...',
                    initialValue: _lineDescription,
                    onChanged: (val) => setState(() => _lineDescription = val),
                  ),
                  const SizedBox(height: 12),
                  Row(
                    children: [
                      Expanded(
                        child: AppInput(
                          label: 'Số lượng *',
                          initialValue: _lineQuantity,
                          onChanged: (val) => setState(() => _lineQuantity = val),
                        ),
                      ),
                      const SizedBox(width: 12),
                      Expanded(
                        child: AppInput(
                          label: 'Đơn vị tính',
                          initialValue: _lineUnit,
                          onChanged: (val) => setState(() => _lineUnit = val),
                        ),
                      ),
                      const SizedBox(width: 12),
                      Expanded(
                        child: MoneyInput(
                          label: 'Đơn giá (₫) *',
                          value: _lineUnitPrice,
                          onChanged: (val) => setState(() => _lineUnitPrice = val),
                        ),
                      ),
                    ],
                  ),
                ],
              ),
            ),

          // Modal: Issue Confirmation
          if (_issueConfirmOpen)
            AppModal(
              title: 'Xác nhận phát hành hóa đơn',
              subtitle: 'Vui lòng rà soát kỹ số tiền trước khi công bố tới cư dân.',
              onClose: () => setState(() => _issueConfirmOpen = false),
              footer: Row(
                mainAxisAlignment: MainAxisAlignment.end,
                children: [
                  AppButton(
                    text: 'Hủy',
                    variant: AppButtonVariant.outline,
                    onPressed: () => setState(() => _issueConfirmOpen = false),
                  ),
                  const SizedBox(width: 8),
                  AppButton(
                    text: 'Xác nhận phát hành ngay',
                    icon: const Icon(LucideIcons.send, size: 14),
                    variant: AppButtonVariant.primary,
                    loading: _submitting,
                    onPressed: _handleConfirmIssue,
                  ),
                ],
              ),
              child: Container(
                padding: const EdgeInsets.all(16),
                decoration: BoxDecoration(
                  color: const Color(0xFFF0F9FF),
                  borderRadius: BorderRadius.circular(12),
                  border: Border.all(color: const Color(0xFFBAE6FD)),
                ),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text('Mã hóa đơn: ${invoice['invoice_code'] ?? ''}', style: const TextStyle(fontWeight: FontWeight.bold)),
                    const SizedBox(height: 4),
                    Text('Căn hộ: Căn ${invoice['apartment_code'] ?? '—'} (${invoice['tenant_name'] ?? 'Khách thuê'})'),
                    const SizedBox(height: 4),
                    Text('Tổng tiền phát hành: ${formatMoney(totalAmount)}', style: const TextStyle(fontWeight: FontWeight.bold, color: AppColors.primary700, fontSize: 15)),
                    const SizedBox(height: 4),
                    Text('Hạn thanh toán: ${formatDate(invoice['due_date'])}', style: const TextStyle(color: AppColors.rose600, fontWeight: FontWeight.w600)),
                  ],
                ),
              ),
            ),

          // Modal: 2-Step VOID Confirmation (PRD 16.2)
          if (_voidOpen)
            AppModal(
              title: 'Xác nhận Hủy hóa đơn đã phát hành (VOID)',
              subtitle: 'Yêu cầu kiểm soát 2 bước an toàn để tránh thao tác nhầm lẫn.',
              onClose: () => setState(() => _voidOpen = false),
              footer: Row(
                mainAxisAlignment: MainAxisAlignment.end,
                children: [
                  AppButton(
                    text: 'Đóng',
                    variant: AppButtonVariant.outline,
                    onPressed: () => setState(() => _voidOpen = false),
                  ),
                  const SizedBox(width: 8),
                  AppButton(
                    text: 'Xác nhận gửi đề nghị VOID',
                    icon: const Icon(LucideIcons.ban, size: 14),
                    variant: AppButtonVariant.danger,
                    disabled: !canConfirmVoidBtn,
                    loading: _submitting,
                    onPressed: _handleConfirmVoid,
                  ),
                ],
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Container(
                    padding: const EdgeInsets.all(12),
                    decoration: BoxDecoration(
                      color: const Color(0xFFFFF1F2),
                      borderRadius: BorderRadius.circular(8),
                      border: Border.all(color: const Color(0xFFFECDD3)),
                    ),
                    child: const Text(
                      'Cảnh báo hủy hóa đơn sau phát hành:\nĐề nghị hủy (VOID) sẽ được gửi đến cấp thẩm quyền (OWNER / 4-Eyes) phê duyệt. Sau khi duyệt, hóa đơn và công nợ liên quan sẽ được hủy bỏ hoàn toàn.',
                      style: TextStyle(color: Color(0xFF9F1239), fontSize: 12),
                    ),
                  ),
                  const SizedBox(height: 16),
                  Text(
                    'Bước 1: Gõ lại chính xác mã hóa đơn "${invoice['invoice_code'] ?? ''}" để xác nhận',
                    style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 13),
                  ),
                  const SizedBox(height: 6),
                  AppInput(
                    placeholder: 'Gõ lại "${invoice['invoice_code'] ?? ''}"',
                    initialValue: _typedVoidCode,
                    onChanged: (val) => setState(() => _typedVoidCode = val),
                  ),
                  const SizedBox(height: 16),
                  const Text(
                    'Bước 2: Nhập lý do hủy bắt buộc *',
                    style: TextStyle(fontWeight: FontWeight.bold, fontSize: 13),
                  ),
                  const SizedBox(height: 6),
                  AppInput(
                    placeholder: 'VD: Khách đã thanh lý hợp đồng và dọn đi trước kỳ hóa đơn...',
                    multiline: true,
                    rows: 3,
                    initialValue: _voidReason,
                    onChanged: (val) => setState(() => _voidReason = val),
                  ),
                ],
              ),
            ),

          // Modal: 4-Eyes Adjustment Request
          if (_adjustOpen)
            AppModal(
              title: 'Lập đề nghị điều chỉnh hóa đơn',
              subtitle: 'Tạo đề nghị tăng/giảm số tiền hóa đơn để gửi phê duyệt 4 mắt.',
              onClose: () => setState(() => _adjustOpen = false),
              footer: Row(
                mainAxisAlignment: MainAxisAlignment.end,
                children: [
                  AppButton(
                    text: 'Hủy',
                    variant: AppButtonVariant.outline,
                    onPressed: () => setState(() => _adjustOpen = false),
                  ),
                  const SizedBox(width: 8),
                  AppButton(
                    text: 'Gửi đề nghị điều chỉnh',
                    variant: AppButtonVariant.primary,
                    loading: _submitting,
                    onPressed: _handleSaveAdjustment,
                  ),
                ],
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  AppSelect<String>(
                    label: 'Mục tiêu điều chỉnh',
                    value: _adjustTarget,
                    options: kAdjustmentTargetOptions,
                    onChanged: (val) => setState(() => _adjustTarget = val ?? 'SERVICE'),
                  ),
                  const SizedBox(height: 12),
                  MoneyInput(
                    label: 'Số tiền điều chỉnh delta (₫) *',
                    hint: 'Nhập số âm để giảm trừ (VD: -150.000) hoặc số dương để tính bổ sung.',
                    allowNegative: true,
                    value: _adjustDeltaAmount,
                    onChanged: (val) => setState(() => _adjustDeltaAmount = val),
                  ),
                  const SizedBox(height: 12),
                  AppInput(
                    label: 'Lý do điều chỉnh bắt buộc *',
                    placeholder: 'VD: Giảm trừ phí dịch vụ do sự cố, hoặc miễn giảm phí chậm nộp...',
                    multiline: true,
                    rows: 3,
                    initialValue: _adjustReason,
                    onChanged: (val) => setState(() => _adjustReason = val),
                  ),
                ],
              ),
            ),

          // Modal: Reject Adjustment
          if (_rejectAdjTarget != null)
            AppModal(
              title: 'Từ chối đề nghị điều chỉnh hóa đơn',
              onClose: () => setState(() => _rejectAdjTarget = null),
              footer: Row(
                mainAxisAlignment: MainAxisAlignment.end,
                children: [
                  AppButton(
                    text: 'Đóng',
                    variant: AppButtonVariant.outline,
                    onPressed: () => setState(() => _rejectAdjTarget = null),
                  ),
                  const SizedBox(width: 8),
                  AppButton(
                    text: 'Xác nhận từ chối',
                    variant: AppButtonVariant.danger,
                    loading: _submitting,
                    onPressed: _handleRejectAdjustment,
                  ),
                ],
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  const Text('Vui lòng nhập lý do từ chối đề nghị điều chỉnh để người lập được biết:'),
                  const SizedBox(height: 8),
                  AppInput(
                    label: 'Lý do từ chối *',
                    placeholder: 'VD: Không đủ căn cứ chứng minh sự cố gián đoạn dịch vụ...',
                    multiline: true,
                    rows: 3,
                    initialValue: _rejectionReason,
                    onChanged: (val) => setState(() => _rejectionReason = val),
                  ),
                ],
              ),
            ),

          // Modal: Quick Pay
          if (_payOpen)
            AppModal(
              title: 'Ghi nhận thu tiền nhanh',
              subtitle: 'Hóa đơn ${invoice['invoice_code']} • Căn ${invoice['apartment_code']}',
              onClose: () => setState(() => _payOpen = false),
              footer: Row(
                mainAxisAlignment: MainAxisAlignment.end,
                children: [
                  AppButton(
                    text: 'Hủy',
                    variant: AppButtonVariant.outline,
                    onPressed: () => setState(() => _payOpen = false),
                  ),
                  const SizedBox(width: 8),
                  AppButton(
                    text: 'Xác nhận thu tiền',
                    icon: const Icon(LucideIcons.wallet, size: 14),
                    variant: AppButtonVariant.success,
                    loading: _submitting,
                    onPressed: _handleSaveQuickPayment,
                  ),
                ],
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Row(
                    children: [
                      Expanded(
                        child: MoneyInput(
                          label: 'Số tiền thu (₫) *',
                          value: _payAmount,
                          onChanged: (val) => setState(() => _payAmount = val),
                        ),
                      ),
                      const SizedBox(width: 12),
                      Expanded(
                        child: AppSelect<String>(
                          label: 'Phương thức',
                          value: _payMethod,
                          options: kPaymentMethodOptions,
                          onChanged: (val) => setState(() => _payMethod = val ?? 'BANK_TRANSFER'),
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 12),
                  AppInput(
                    label: 'Mã giao dịch ngân hàng / Số biên lai',
                    placeholder: 'VD: FT2630291823...',
                    initialValue: _payRefCode,
                    onChanged: (val) => setState(() => _payRefCode = val),
                  ),
                  const SizedBox(height: 12),
                  AppInput(
                    label: 'Ghi chú thu tiền',
                    initialValue: _payNote,
                    onChanged: (val) => setState(() => _payNote = val),
                  ),
                  const SizedBox(height: 12),
                  FileUploadField(
                    label: 'Ảnh chụp chứng từ / Ủy nhiệm chi (tùy chọn)',
                    value: _payProofImage.isNotEmpty ? [_payProofImage] : [],
                    onChanged: (urls) => setState(() => _payProofImage = urls.isNotEmpty ? urls.first : ''),
                  ),
                ],
              ),
            ),

          // Modal: Proof image preview
          if (_previewProofUrl != null)
            AppModal(
              title: 'Ảnh chứng từ',
              onClose: () => setState(() => _previewProofUrl = null),
              footer: AppButton(
                text: 'Đóng',
                variant: AppButtonVariant.outline,
                onPressed: () => setState(() => _previewProofUrl = null),
              ),
              child: Center(
                child: SizedBox(
                  height: 350,
                  child: AuthImage(src: _previewProofUrl),
                ),
              ),
            ),
        ],
      ),
    );
  }
}
