import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../../../core/theme/app_colors.dart';
import '../../../core/utils/deposit_ui_helpers.dart';
import '../../../core/utils/format.dart';
import '../../../core/utils/validation.dart';
import '../../../shared/providers/toast_provider.dart';
import '../../../shared/widgets/common/bank_select.dart';
import '../../../shared/widgets/common/confirm_dialog.dart';
import '../../../shared/widgets/common/empty_state.dart';
import '../../../shared/widgets/common/loading_spinner.dart';
import '../../../shared/widgets/ui/app_badge.dart';
import '../../../shared/widgets/ui/app_button.dart';
import '../../../shared/widgets/ui/app_card.dart';
import '../../../shared/widgets/ui/app_input.dart';
import '../../../shared/widgets/ui/app_select.dart';
import '../../../shared/widgets/ui/file_upload_field.dart';
import '../../../shared/widgets/ui/html_print_preview_modal.dart';
import '../../../shared/widgets/ui/money_input.dart';
import '../../auth/providers/auth_provider.dart';
import '../../auth/providers/permission_provider.dart';
import '../services/deposits_service.dart';

const List<Map<String, String>> kDeductCategoryOptions = [
  {'value': 'DAMAGE', 'label': 'Hư hỏng tài sản / nội thất (DAMAGE)'},
  {'value': 'CLEANING', 'label': 'Vệ sinh hoàn trả mặt bằng (CLEANING)'},
  {'value': 'UTILITY_DEBT', 'label': 'Điện / nước / tiện ích tồn đọng (UTILITY_DEBT)'},
  {'value': 'OTHER', 'label': 'Khấu trừ hợp lệ khác (OTHER)'},
];

const Map<String, String> kCategoryLabels = {
  'DAMAGE': 'Hư hỏng tài sản',
  'CLEANING': 'Vệ sinh mặt bằng',
  'UTILITY_DEBT': 'Tiện ích phát sinh',
  'OTHER': 'Khoản mục khác',
  'TRANSFER_IN': 'Nhận kết chuyển',
  'TRANSFER_OUT': 'Kết chuyển đi',
};

const List<Map<String, String>> kPaymentMethodOptions = [
  {'value': 'BANK_TRANSFER', 'label': 'Chuyển khoản ngân hàng (BANK_TRANSFER)'},
  {'value': 'CASH', 'label': 'Tiền mặt (CASH)'},
];

class DepositDetailModal extends ConsumerStatefulWidget {
  final Map<String, dynamic> deposit;
  final Map<String, dynamic>? initialDetail;
  final VoidCallback? onRefresh;

  const DepositDetailModal({
    super.key,
    required this.deposit,
    this.initialDetail,
    this.onRefresh,
  });

  static Future<void> show(
    BuildContext context, {
    required Map<String, dynamic> deposit,
    Map<String, dynamic>? initialDetail,
    VoidCallback? onRefresh,
  }) {
    return showDialog<void>(
      context: context,
      barrierDismissible: true,
      builder: (ctx) => Dialog(
        backgroundColor: Colors.transparent,
        insetPadding: const EdgeInsets.symmetric(horizontal: 20, vertical: 24),
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 960, maxHeight: 860),
          child: Container(
            decoration: BoxDecoration(
              color: Colors.white,
              borderRadius: BorderRadius.circular(16),
              boxShadow: [
                BoxShadow(
                  color: Colors.black.withOpacity(0.12),
                  blurRadius: 24,
                  offset: const Offset(0, 8),
                ),
              ],
            ),
            child: ClipRRect(
              borderRadius: BorderRadius.circular(16),
              child: DepositDetailModal(
                deposit: deposit,
                initialDetail: initialDetail,
                onRefresh: onRefresh,
              ),
            ),
          ),
        ),
      ),
    );
  }

  @override
  ConsumerState<DepositDetailModal> createState() => _DepositDetailModalState();
}

class _DepositDetailModalState extends ConsumerState<DepositDetailModal>
    with SingleTickerProviderStateMixin {
  late TabController _tabController;
  late Map<String, dynamic> _dep;
  Map<String, dynamic>? _settlementDetail;
  bool _loadingSettlement = true;

  // Transactions & Audit
  List<Map<String, dynamic>> _transactions = [];
  bool _loadingTxns = false;
  List<Map<String, dynamic>> _auditLogs = [];
  bool _loadingAuditLogs = false;

  // Collect Additional Deposit Form state
  bool _showCollectForm = false;
  int? _collectAmount;
  String _collectMethod = 'BANK_TRANSFER';
  String _collectDescription = 'Thu bổ sung tiền đặt cọc hợp đồng';
  dynamic _collectEvidence;
  bool _submittingCollect = false;

  // Settlement Form state (for MANAGER)
  int _outstandingDebt = 0;
  List<Map<String, dynamic>> _deductionItems = [];
  String _refundMethod = 'BANK_TRANSFER';
  Map<String, dynamic> _bankInfo = {
    'bank_name': '',
    'bank_code': '',
    'bank_bin': '',
    'bank_logo': '',
    'account_number': '',
    'account_holder': '',
  };
  dynamic _inspectionEvidence;
  bool _submittingSettlement = false;

  // 4-Eyes Actions loading states
  bool _actionLoading = false;

  @override
  void initState() {
    super.initState();
    _tabController = TabController(length: 3, vsync: this);
    _dep = Map<String, dynamic>.from(widget.deposit);
    if (widget.initialDetail != null) {
      _settlementDetail = Map<String, dynamic>.from(widget.initialDetail!);
      _applySettlementDetail();
      _loadingSettlement = false;
    } else {
      _loadSettlement();
    }
  }

  @override
  void dispose() {
    _tabController.dispose();
    super.dispose();
  }

  Future<void> _loadSettlement() async {
    setState(() => _loadingSettlement = true);
    try {
      final service = ref.read(depositsServiceProvider);
      final res = await service.getSettlement(_dep['id'].toString());
      if (!mounted) return;
      if (res is Map && res['data'] is Map) {
        _settlementDetail = Map<String, dynamic>.from(res['data'] as Map);
      } else if (res is Map) {
        _settlementDetail = Map<String, dynamic>.from(res);
      }
      _applySettlementDetail();
    } catch (err) {
      if (mounted) {
        ref.read(toastProvider.notifier).error(
              extractErrorMessage(err, 'Không thể tải hồ sơ quyết toán cọc.'),
            );
      }
    } finally {
      if (mounted) setState(() => _loadingSettlement = false);
    }
  }

  void _applySettlementDetail() {
    final data = _settlementDetail ?? {};
    final existing = data['settlement'] is Map
        ? Map<String, dynamic>.from(data['settlement'] as Map)
        : (_dep['settlement'] is Map ? Map<String, dynamic>.from(_dep['settlement'] as Map) : null);

    final rawDebt = data['calculated_service_debt'] ?? existing?['outstanding_debt'] ?? 0;
    _outstandingDebt = (rawDebt is num ? rawDebt : num.tryParse(rawDebt.toString()) ?? 0).toInt();

    if (existing != null) {
      final items = existing['items'];
      if (items is List) {
        _deductionItems = items.whereType<Map>().map((it) {
          final amt = it['amount'];
          return {
            'category': it['category']?.toString() ?? 'DAMAGE',
            'amount': (amt is num ? amt : num.tryParse(amt?.toString() ?? ''))?.toInt() ?? 0,
            'description': it['description']?.toString() ?? '',
            'evidence': it['evidence'] ?? [],
          };
        }).toList();
      }
      _refundMethod = existing['refund_method']?.toString() ?? 'BANK_TRANSFER';
      if (existing['bank_info'] is Map) {
        _bankInfo = Map<String, dynamic>.from(existing['bank_info'] as Map);
      }
      _inspectionEvidence = existing['inspection_evidence'];
    } else {
      _deductionItems = [];
      _refundMethod = 'BANK_TRANSFER';
      _bankInfo = {
        'bank_name': '',
        'bank_code': '',
        'bank_bin': '',
        'bank_logo': '',
        'account_number': '',
        'account_holder': _dep['tenant_name']?.toString() ?? '',
      };
      _inspectionEvidence = null;
    }
  }

  Future<void> _loadTransactions() async {
    setState(() => _loadingTxns = true);
    try {
      final service = ref.read(depositsServiceProvider);
      final res = await service.listTransactions(_dep['id'].toString());
      if (!mounted) return;
      if (res is Map && res['data'] is List) {
        setState(() {
          _transactions = (res['data'] as List)
              .whereType<Map>()
              .map((e) => Map<String, dynamic>.from(e))
              .toList();
        });
      }
    } catch (err) {
      if (mounted) {
        ref.read(toastProvider.notifier).error(
              extractErrorMessage(err, 'Không thể tải lịch sử giao dịch sổ cọc.'),
            );
      }
    } finally {
      if (mounted) setState(() => _loadingTxns = false);
    }
  }

  Future<void> _loadAuditLogs() async {
    setState(() => _loadingAuditLogs = true);
    try {
      final service = ref.read(depositsServiceProvider);
      final res = await service.getAuditLogs(_dep['id'].toString());
      if (!mounted) return;
      if (res is Map && res['data'] is List) {
        setState(() {
          _auditLogs = (res['data'] as List)
              .whereType<Map>()
              .map((e) => Map<String, dynamic>.from(e))
              .toList();
        });
      }
    } catch (err) {
      if (mounted) {
        ref.read(toastProvider.notifier).error(
              extractErrorMessage(err, 'Không thể tải nhật ký kiểm toán sổ cọc.'),
            );
      }
    } finally {
      if (mounted) setState(() => _loadingAuditLogs = false);
    }
  }

  // ---------------------------------------------------------------------------
  // Action Handlers
  // ---------------------------------------------------------------------------

  Future<void> _submitSettlementProposal() async {
    final permissions = ref.read(permissionProvider);
    if (!permissions.canSettleDeposits) {
      ref.read(toastProvider.notifier).error('Chỉ Quản lý tòa nhà mới có quyền lập hồ sơ quyết toán.');
      return;
    }

    for (int i = 0; i < _deductionItems.length; i++) {
      final it = _deductionItems[i];
      final amt = it['amount'];
      final numAmt = amt is num ? amt.toInt() : (int.tryParse(amt?.toString() ?? '') ?? 0);
      if (numAmt <= 0) {
        ref.read(toastProvider.notifier).warning('Khoản khấu trừ #${i + 1}: Số tiền phải là số nguyên dương VND.');
        return;
      }
      final desc = it['description']?.toString().trim() ?? '';
      if (desc.isEmpty) {
        ref.read(toastProvider.notifier).warning('Khoản khấu trừ #${i + 1}: Vui lòng nhập mô tả chi tiết lý do khấu trừ.');
        return;
      }
      final ev = it['evidence'];
      if (ev is! List || ev.isEmpty) {
        ref.read(toastProvider.notifier).warning('Khoản khấu trừ #${i + 1}: Bắt buộc đính kèm ít nhất 01 ảnh bằng chứng (FR-023).');
        return;
      }
    }

    if (_refundMethod == 'BANK_TRANSFER') {
      final bName = _bankInfo['bank_name']?.toString().trim() ?? '';
      final accNo = _bankInfo['account_number']?.toString().trim() ?? '';
      final holder = _bankInfo['account_holder']?.toString().trim() ?? '';
      if (bName.isEmpty || accNo.isEmpty || holder.isEmpty) {
        ref.read(toastProvider.notifier).warning('Vui lòng nhập đầy đủ thông tin tài khoản ngân hàng thụ hưởng.');
        return;
      }
    }

    setState(() => _submittingSettlement = true);
    try {
      final service = ref.read(depositsServiceProvider);
      final payload = {
        'outstanding_debt': _outstandingDebt,
        'items': _deductionItems.map((it) => {
          'category': it['category'],
          'amount': num.tryParse(it['amount']?.toString() ?? '')?.toInt() ?? 0,
          'description': it['description']?.toString().trim() ?? '',
          'evidence': it['evidence'] is List ? it['evidence'] : [],
        }).toList(),
        'refund_method': _refundMethod,
        'bank_info': _refundMethod == 'BANK_TRANSFER' ? _bankInfo : null,
        'inspection_evidence': _inspectionEvidence,
      };

      final res = await service.submitSettlement(_dep['id'].toString(), payload);
      if (!mounted) return;
      ref.read(toastProvider.notifier).success(
            (res is Map ? res['message']?.toString() : null) ??
                'Đã trình hồ sơ quyết toán cọc chờ phê duyệt 4 mắt.',
          );
      widget.onRefresh?.call();
      await _loadSettlement();
    } catch (err) {
      if (mounted) {
        ref.read(toastProvider.notifier).error(
              extractErrorMessage(err, 'Không thể gửi hồ sơ quyết toán cọc.'),
            );
      }
    } finally {
      if (mounted) setState(() => _submittingSettlement = false);
    }
  }

  Future<void> _handleApproveSettlement() async {
    final confirmed = await ConfirmDialog.show(
      context: context,
      title: 'Phê duyệt quyết toán cọc',
      message: 'Bạn có chắc chắn muốn phê duyệt hồ sơ quyết toán cọc này theo quy tắc 4 mắt?',
      confirmLabel: 'Xác nhận duyệt',
      variant: ConfirmDialogVariant.primary,
    );
    if (confirmed != true) return;

    setState(() => _actionLoading = true);
    try {
      final service = ref.read(depositsServiceProvider);
      final res = await service.approveSettlement(_dep['id'].toString());
      if (!mounted) return;
      ref.read(toastProvider.notifier).success(
            (res is Map ? res['message']?.toString() : null) ?? 'Đã phê duyệt quyết toán cọc thành công.',
          );
      widget.onRefresh?.call();
      await _loadSettlement();
    } catch (err) {
      if (mounted) {
        ref.read(toastProvider.notifier).error(
              extractErrorMessage(err, 'Lỗi từ chối phê duyệt hồ sơ quyết toán.'),
            );
      }
    } finally {
      if (mounted) setState(() => _actionLoading = false);
    }
  }

  Future<void> _handleRejectSettlement() async {
    final reasonController = TextEditingController();
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Từ chối biên bản quyết toán', style: TextStyle(fontWeight: FontWeight.w600)),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            const Text(
              'Biên bản quyết toán sẽ được trả lại trạng thái Nháp cho Quản lý điều chỉnh. Vui lòng cung cấp lý do từ chối:',
              style: TextStyle(fontSize: 14, color: AppColors.slate600),
            ),
            const SizedBox(height: 12),
            TextField(
              controller: reasonController,
              maxLines: 3,
              decoration: const InputDecoration(
                hintText: 'Nhập lý do từ chối...',
                border: OutlineInputBorder(),
              ),
            ),
          ],
        ),
        actions: [
          TextButton(onPressed: () => Navigator.of(ctx).pop(false), child: const Text('Hủy')),
          ElevatedButton(
            style: ElevatedButton.styleFrom(backgroundColor: AppColors.rose600),
            onPressed: () => Navigator.of(ctx).pop(true),
            child: const Text('Từ chối', style: TextStyle(color: Colors.white)),
          ),
        ],
      ),
    );

    final reason = reasonController.text.trim();
    if (confirmed != true || reason.isEmpty) return;

    setState(() => _actionLoading = true);
    try {
      final service = ref.read(depositsServiceProvider);
      final res = await service.rejectSettlement(_dep['id'].toString(), {'reason': reason});
      if (!mounted) return;
      ref.read(toastProvider.notifier).success(
            (res is Map ? res['message']?.toString() : null) ?? 'Đã từ chối biên bản quyết toán cọc.',
          );
      widget.onRefresh?.call();
      await _loadSettlement();
    } catch (err) {
      if (mounted) {
        ref.read(toastProvider.notifier).error(
              extractErrorMessage(err, 'Không thể từ chối hồ sơ quyết toán.'),
            );
      }
    } finally {
      if (mounted) setState(() => _actionLoading = false);
    }
  }

  Future<void> _handleDispute() async {
    final reasonController = TextEditingController();
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Ghi nhận tranh chấp cọc', style: TextStyle(fontWeight: FontWeight.w600)),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            const Text(
              'Hồ sơ sẽ chuyển sang trạng thái Tranh chấp (DISPUTED). Vui lòng nhập lý do khiếu nại của cư dân / BQL:',
              style: TextStyle(fontSize: 14, color: AppColors.slate600),
            ),
            const SizedBox(height: 12),
            TextField(
              controller: reasonController,
              maxLines: 3,
              decoration: const InputDecoration(
                hintText: 'Nhập chi tiết tranh chấp / khiếu nại...',
                border: OutlineInputBorder(),
              ),
            ),
          ],
        ),
        actions: [
          TextButton(onPressed: () => Navigator.of(ctx).pop(false), child: const Text('Hủy')),
          ElevatedButton(
            style: ElevatedButton.styleFrom(backgroundColor: AppColors.amber600),
            onPressed: () => Navigator.of(ctx).pop(true),
            child: const Text('Xác nhận tranh chấp', style: TextStyle(color: Colors.white)),
          ),
        ],
      ),
    );

    final reason = reasonController.text.trim();
    if (confirmed != true || reason.isEmpty) return;

    setState(() => _actionLoading = true);
    try {
      final service = ref.read(depositsServiceProvider);
      final res = await service.dispute(_dep['id'].toString(), {'reason': reason});
      if (!mounted) return;
      ref.read(toastProvider.notifier).success(
            (res is Map ? res['message']?.toString() : null) ?? 'Đã chuyển hồ sơ sang trạng thái Tranh chấp.',
          );
      widget.onRefresh?.call();
      await _loadSettlement();
    } catch (err) {
      if (mounted) {
        ref.read(toastProvider.notifier).error(
              extractErrorMessage(err, 'Không thể ghi nhận tranh chấp.'),
            );
      }
    } finally {
      if (mounted) setState(() => _actionLoading = false);
    }
  }

  Future<void> _handleResolveDispute() async {
    String resolution = 'CONFIRM';
    final reasonController = TextEditingController();

    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => StatefulBuilder(
        builder: (context, setDialogState) => AlertDialog(
          title: const Text('Giải quyết khiếu nại / tranh chấp', style: TextStyle(fontWeight: FontWeight.w600)),
          content: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              RadioListTile<String>(
                title: const Text('Xác nhận kết quả tất toán & đóng khiếu nại (CONFIRM)'),
                value: 'CONFIRM',
                groupValue: resolution,
                onChanged: (v) => setDialogState(() => resolution = v!),
              ),
              RadioListTile<String>(
                title: const Text('Mở lại bản nháp để điều chỉnh (ADJUST)'),
                value: 'ADJUST',
                groupValue: resolution,
                onChanged: (v) => setDialogState(() => resolution = v!),
              ),
              const SizedBox(height: 12),
              TextField(
                controller: reasonController,
                maxLines: 3,
                decoration: const InputDecoration(
                  hintText: 'Nhập nội dung / căn cứ giải quyết...',
                  border: OutlineInputBorder(),
                ),
              ),
            ],
          ),
          actions: [
            TextButton(onPressed: () => Navigator.of(ctx).pop(false), child: const Text('Hủy')),
            ElevatedButton(
              onPressed: () => Navigator.of(ctx).pop(true),
              child: const Text('Hoàn tất giải quyết'),
            ),
          ],
        ),
      ),
    );

    final reason = reasonController.text.trim();
    if (confirmed != true || reason.isEmpty) return;

    setState(() => _actionLoading = true);
    try {
      final service = ref.read(depositsServiceProvider);
      final res = await service.resolveDispute(_dep['id'].toString(), {
        'resolution': resolution,
        'reason': reason,
      });
      if (!mounted) return;
      ref.read(toastProvider.notifier).success(
            (res is Map ? res['message']?.toString() : null) ?? 'Đã giải quyết khiếu nại thành công.',
          );
      widget.onRefresh?.call();
      await _loadSettlement();
    } catch (err) {
      if (mounted) {
        ref.read(toastProvider.notifier).error(
              extractErrorMessage(err, 'Không thể giải quyết tranh chấp.'),
            );
      }
    } finally {
      if (mounted) setState(() => _actionLoading = false);
    }
  }

  Future<void> _handleExecutePayout() async {
    final refController = TextEditingController();
    final noteController = TextEditingController();
    dynamic payoutEvidence;

    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => StatefulBuilder(
        builder: (context, setDialogState) => AlertDialog(
          title: const Text('Ghi nhận chi hoàn tiền cọc (UNC)', style: TextStyle(fontWeight: FontWeight.w600)),
          content: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                TextField(
                  controller: refController,
                  decoration: const InputDecoration(
                    labelText: 'Mã tham chiếu / Số UNC ngân hàng',
                    border: OutlineInputBorder(),
                  ),
                ),
                const SizedBox(height: 12),
                TextField(
                  controller: noteController,
                  maxLines: 2,
                  decoration: const InputDecoration(
                    labelText: 'Ghi chú lệnh chi',
                    border: OutlineInputBorder(),
                  ),
                ),
                const SizedBox(height: 16),
                const Text('Ảnh chứng từ UNC / Biên lai chi tiền (Bắt buộc):',
                    style: TextStyle(fontSize: 13, fontWeight: FontWeight.w500)),
                const SizedBox(height: 6),
                FileUploadField(
                  multiple: true,
                  maxFiles: 3,
                  value: payoutEvidence,
                  onChanged: (val) => setDialogState(() => payoutEvidence = val),
                ),
              ],
            ),
          ),
          actions: [
            TextButton(onPressed: () => Navigator.of(ctx).pop(false), child: const Text('Hủy')),
            ElevatedButton(
              onPressed: () => Navigator.of(ctx).pop(true),
              child: const Text('Xác nhận đã chi hoàn'),
            ),
          ],
        ),
      ),
    );

    if (confirmed != true) return;

    setState(() => _actionLoading = true);
    try {
      final service = ref.read(depositsServiceProvider);
      final res = await service.executePayout(_dep['id'].toString(), {
        'reference_code': refController.text.trim(),
        'note': noteController.text.trim(),
        'evidence': payoutEvidence is List ? payoutEvidence : (payoutEvidence != null ? [payoutEvidence] : []),
      });
      if (!mounted) return;
      ref.read(toastProvider.notifier).success(
            (res is Map ? res['message']?.toString() : null) ?? 'Đã ghi nhận chi hoàn cọc thành công.',
          );
      widget.onRefresh?.call();
      await _loadSettlement();
    } catch (err) {
      if (mounted) {
        ref.read(toastProvider.notifier).error(
              extractErrorMessage(err, 'Không thể thực hiện chi hoàn tiền cọc.'),
            );
      }
    } finally {
      if (mounted) setState(() => _actionLoading = false);
    }
  }

  Future<void> _handleMarkPayoutReturned() async {
    final reasonController = TextEditingController();
    final refController = TextEditingController();

    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Ngân hàng trả lại lệnh chi', style: TextStyle(fontWeight: FontWeight.w600)),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            const Text(
              'Ghi nhận lệnh chuyển khoản hoàn cọc bị ngân hàng từ chối hoặc trả về (sai số tài khoản, tài khoản bị khóa...).',
              style: TextStyle(fontSize: 13, color: AppColors.slate600),
            ),
            const SizedBox(height: 12),
            TextField(
              controller: reasonController,
              maxLines: 2,
              decoration: const InputDecoration(
                labelText: 'Lý do ngân hàng hoàn trả *',
                border: OutlineInputBorder(),
              ),
            ),
            const SizedBox(height: 12),
            TextField(
              controller: refController,
              decoration: const InputDecoration(
                labelText: 'Mã tra soát ngân hàng',
                border: OutlineInputBorder(),
              ),
            ),
          ],
        ),
        actions: [
          TextButton(onPressed: () => Navigator.of(ctx).pop(false), child: const Text('Hủy')),
          ElevatedButton(
            style: ElevatedButton.styleFrom(backgroundColor: AppColors.rose600),
            onPressed: () => Navigator.of(ctx).pop(true),
            child: const Text('Ghi nhận trả lại', style: TextStyle(color: Colors.white)),
          ),
        ],
      ),
    );

    final reason = reasonController.text.trim();
    if (confirmed != true || reason.isEmpty) return;

    setState(() => _actionLoading = true);
    try {
      final service = ref.read(depositsServiceProvider);
      final res = await service.markPayoutReturned(_dep['id'].toString(), {
        'reason': reason,
        'reference_code': refController.text.trim(),
      });
      if (!mounted) return;
      ref.read(toastProvider.notifier).success(
            (res is Map ? res['message']?.toString() : null) ?? 'Đã ghi nhận trạng thái ngân hàng hoàn trả.',
          );
      widget.onRefresh?.call();
      await _loadSettlement();
    } catch (err) {
      if (mounted) {
        ref.read(toastProvider.notifier).error(
              extractErrorMessage(err, 'Không thể ghi nhận ngân hàng trả lại.'),
            );
      }
    } finally {
      if (mounted) setState(() => _actionLoading = false);
    }
  }

  Future<void> _handleUpdateBankInfo() async {
    final accNoController = TextEditingController(text: _bankInfo['account_number']?.toString() ?? '');
    final accHolderController = TextEditingController(text: _bankInfo['account_holder']?.toString() ?? '');
    String bankName = _bankInfo['bank_name']?.toString() ?? '';
    String? bankCode = _bankInfo['bank_code']?.toString();
    String? bankBin = _bankInfo['bank_bin']?.toString();
    String? bankLogo = _bankInfo['bank_logo']?.toString();

    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => StatefulBuilder(
        builder: (context, setDialogState) => AlertDialog(
          title: const Text('Cập nhật tài khoản thụ hưởng', style: TextStyle(fontWeight: FontWeight.w600)),
          content: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                BankSelect(
                  value: bankCode ?? '',
                  onBankChange: (nextVal, bank) {
                    setDialogState(() {
                      bankCode = nextVal;
                      bankName = bank?['shortName'] ?? bank?['name'] ?? nextVal;
                      bankBin = bank?['bin']?.toString();
                      bankLogo = bank?['logo']?.toString();
                    });
                  },
                ),
                const SizedBox(height: 12),
                TextField(
                  controller: accNoController,
                  decoration: const InputDecoration(
                    labelText: 'Số tài khoản ngân hàng *',
                    border: OutlineInputBorder(),
                  ),
                ),
                const SizedBox(height: 12),
                TextField(
                  controller: accHolderController,
                  decoration: const InputDecoration(
                    labelText: 'Chủ tài khoản thụ hưởng *',
                    border: OutlineInputBorder(),
                  ),
                ),
              ],
            ),
          ),
          actions: [
            TextButton(onPressed: () => Navigator.of(ctx).pop(false), child: const Text('Hủy')),
            ElevatedButton(
              onPressed: () => Navigator.of(ctx).pop(true),
              child: const Text('Lưu thông tin'),
            ),
          ],
        ),
      ),
    );

    if (confirmed != true) return;

    final accNo = accNoController.text.trim();
    final holder = accHolderController.text.trim();
    if (bankName.isEmpty || accNo.isEmpty || holder.isEmpty) {
      ref.read(toastProvider.notifier).warning('Vui lòng nhập đầy đủ thông tin tài khoản.');
      return;
    }

    setState(() => _actionLoading = true);
    try {
      final service = ref.read(depositsServiceProvider);
      final res = await service.updateRefundBankInfo(_dep['id'].toString(), {
        'bank_info': {
          'bank_name': bankName,
          'bank_code': bankCode,
          'bank_bin': bankBin,
          'bank_logo': bankLogo,
          'account_number': accNo,
          'account_holder': holder,
        },
      });
      if (!mounted) return;
      ref.read(toastProvider.notifier).success(
            (res is Map ? res['message']?.toString() : null) ?? 'Đã cập nhật tài khoản thụ hưởng hoàn cọc.',
          );
      widget.onRefresh?.call();
      await _loadSettlement();
    } catch (err) {
      if (mounted) {
        ref.read(toastProvider.notifier).error(
              extractErrorMessage(err, 'Không thể cập nhật tài khoản ngân hàng.'),
            );
      }
    } finally {
      if (mounted) setState(() => _actionLoading = false);
    }
  }

  Future<void> _handlePrintA4() async {
    try {
      final service = ref.read(depositsServiceProvider);
      final html = await service.getSettlementPdfHtml(_dep['id'].toString());
      if (!mounted) return;
      await HtmlPrintPreviewModal.show(
        context,
        title: 'Bảng kê quyết toán hoàn cọc A4 (${_dep['apartment_code']})',
        htmlContent: html,
      );
    } catch (err) {
      if (mounted) {
        ref.read(toastProvider.notifier).error(
              extractErrorMessage(err, 'Không thể tạo bản in bảng kê tất toán.'),
            );
      }
    }
  }

  Future<void> _handleCollectAdditional() async {
    if (!canCollectAdditionalDeposit(_dep)) {
      ref.read(toastProvider.notifier).warning('Sổ cọc hiện không ở trạng thái cho phép thu bổ sung.');
      return;
    }

    final rawAmount = _collectAmount ?? 0;
    final reqAmount = (_dep['deposit_amount'] is num
            ? _dep['deposit_amount']
            : num.tryParse(_dep['deposit_amount']?.toString() ?? '')) ??
        0;
    final heldAmount = (_dep['amount_held'] is num
            ? _dep['amount_held']
            : num.tryParse(_dep['amount_held']?.toString() ?? '')) ??
        0;
    final shortage = (reqAmount - heldAmount).toInt();

    if (rawAmount <= 0) {
      ref.read(toastProvider.notifier).warning('Vui lòng nhập số tiền thu bổ sung hợp lệ.');
      return;
    }
    if (rawAmount > shortage) {
      ref.read(toastProvider.notifier).warning('Số tiền thu không được vượt quá số còn thiếu (${formatMoney(shortage)}).');
      return;
    }

    setState(() => _submittingCollect = true);
    try {
      final service = ref.read(depositsServiceProvider);
      final res = await service.createTransaction(_dep['id'].toString(), {
        'type': 'collect',
        'amount': rawAmount,
        'method': _collectMethod,
        'description': _collectDescription.trim().isNotEmpty ? _collectDescription.trim() : 'Thu bổ sung cọc',
        'evidence': _collectEvidence is List ? _collectEvidence : (_collectEvidence != null ? [_collectEvidence] : []),
      });

      if (!mounted) return;
      ref.read(toastProvider.notifier).success(
            (res is Map ? res['message']?.toString() : null) ?? 'Đã ghi nhận giao dịch thu bổ sung cọc.',
          );
      setState(() {
        _showCollectForm = false;
        _collectAmount = null;
        _dep['amount_held'] = (heldAmount + rawAmount).toInt();
      });
      widget.onRefresh?.call();
      await _loadTransactions();
    } catch (err) {
      if (mounted) {
        ref.read(toastProvider.notifier).error(
              extractErrorMessage(err, 'Không thể ghi nhận thu bổ sung cọc.'),
            );
      }
    } finally {
      if (mounted) setState(() => _submittingCollect = false);
    }
  }

  // ---------------------------------------------------------------------------
  // Build Methods
  // ---------------------------------------------------------------------------

  @override
  Widget build(BuildContext context) {
    final status = _dep['status']?.toString() ?? 'HELD';

    return Container(
      color: Colors.white,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          // Modal Header
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 16),
            decoration: const BoxDecoration(
              border: Border(bottom: BorderSide(color: AppColors.slate200)),
            ),
            child: Row(
              children: [
                Container(
                  padding: const EdgeInsets.all(8),
                  decoration: BoxDecoration(
                    color: AppColors.secondary50,
                    borderRadius: BorderRadius.circular(8),
                  ),
                  child: const Icon(LucideIcons.wallet, size: 20, color: AppColors.secondary600),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        children: [
                          Text(
                            'Sổ cọc ${_dep['apartment_code'] ?? '---'}',
                            style: const TextStyle(
                              fontSize: 18,
                              fontWeight: FontWeight.bold,
                              color: AppColors.slate900,
                            ),
                          ),
                          const SizedBox(width: 8),
                          _buildStatusBadge(status),
                        ],
                      ),
                      const SizedBox(width: 4),
                      Text(
                        '${_dep['tenant_name'] ?? 'Khách thuê'} • ${_dep['building_name'] ?? 'Tòa nhà'}',
                        style: const TextStyle(fontSize: 13, color: AppColors.slate500),
                      ),
                    ],
                  ),
                ),
                IconButton(
                  icon: const Icon(LucideIcons.x, color: AppColors.slate400),
                  onPressed: () => Navigator.of(context).pop(),
                ),
              ],
            ),
          ),

          // Tab Bar
          TabBar(
            controller: _tabController,
            labelColor: AppColors.secondary600,
            unselectedLabelColor: AppColors.slate500,
            indicatorColor: AppColors.secondary600,
            onTap: (idx) {
              if (idx == 1 && _transactions.isEmpty) _loadTransactions();
              if (idx == 2 && _auditLogs.isEmpty) _loadAuditLogs();
            },
            tabs: const [
              Tab(text: 'Quyết toán & Hoàn cọc 4 Mắt'),
              Tab(text: 'Sổ giao dịch & Thu cọc'),
              Tab(text: 'Nhật ký kiểm toán'),
            ],
          ),

          // Tab Contents
          Expanded(
            child: TabBarView(
              controller: _tabController,
              children: [
                _buildSettlementTab(),
                _buildTransactionsTab(),
                _buildAuditLogsTab(),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildStatusBadge(String status) {
    String label = status;
    AppBadgeVariant variant = AppBadgeVariant.slate;

    switch (status) {
      case 'HELD':
        label = 'Đang giữ cọc';
        variant = AppBadgeVariant.sky;
        break;
      case 'SETTLEMENT_DRAFT':
        label = 'Nháp quyết toán';
        variant = AppBadgeVariant.amber;
        break;
      case 'PENDING_APPROVAL':
        label = 'Chờ duyệt 4 mắt';
        variant = AppBadgeVariant.amber;
        break;
      case 'APPROVED_PENDING_PAYOUT':
        label = 'Đã duyệt — Chờ chi hoàn';
        variant = AppBadgeVariant.indigo;
        break;
      case 'RETURNED':
        label = 'Ngân hàng trả lại';
        variant = AppBadgeVariant.red;
        break;
      case 'REFUNDED':
        label = 'Đã hoàn cọc';
        variant = AppBadgeVariant.emerald;
        break;
      case 'PARTIALLY_REFUNDED':
        label = 'Hoàn cọc 1 phần';
        variant = AppBadgeVariant.emerald;
        break;
      case 'DEDUCTED_FULL':
        label = 'Khấu trừ toàn bộ';
        variant = AppBadgeVariant.slate;
        break;
      case 'DISPUTED':
        label = 'Đang khiếu nại';
        variant = AppBadgeVariant.red;
        break;
    }

    return AppBadge(label: label, variant: variant);
  }

  // ===========================================================================
  // Tab 1: Settlement & 4-Eyes Payout
  // ===========================================================================

  Widget _buildSettlementTab() {
    if (_loadingSettlement) {
      return const Center(child: LoadingSpinner());
    }

    final permissions = ref.read(permissionProvider);
    final currentUserId = ref.read(authProvider.select((s) => s.user?.id));
    final status = _dep['status']?.toString() ?? 'HELD';
    final settlementData = _settlementDetail?['settlement'] is Map
        ? Map<String, dynamic>.from(_settlementDetail!['settlement'] as Map)
        : (_dep['settlement'] is Map ? Map<String, dynamic>.from(_dep['settlement'] as Map) : null);

    final isDraft = status == 'HELD' || status == 'SETTLEMENT_DRAFT';

    SettlementPayoutSummary summary;
    if (isDraft) {
      final held = ((_dep['amount_held'] is num
              ? _dep['amount_held']
              : num.tryParse(_dep['amount_held']?.toString() ?? '')) ??
          0).round();
      final serviceDebt = _outstandingDebt > 0 ? _outstandingDebt : 0;
      final itemsTotal = _deductionItems.fold<int>(
        0,
        (sum, it) {
          final amt = it['amount'];
          final numAmt = amt is num ? amt.round() : (int.tryParse(amt?.toString() ?? '') ?? 0);
          return sum + (numAmt > 0 ? numAmt : 0);
        },
      );
      final depositRefund = (held - serviceDebt - itemsTotal) > 0 ? (held - serviceDebt - itemsTotal) : 0;
      final rawCredit = ((_settlementDetail?['credit_balance'] ??
              settlementData?['credit_refund_amount'] ??
              settlementData?['credit_balance'] ??
              _dep['credit_balance']) is num
          ? (_settlementDetail?['credit_balance'] ??
              settlementData?['credit_refund_amount'] ??
              settlementData?['credit_balance'] ??
              _dep['credit_balance'])
          : num.tryParse((_settlementDetail?['credit_balance'] ??
                      settlementData?['credit_refund_amount'] ??
                      settlementData?['credit_balance'] ??
                      _dep['credit_balance'])
                  ?.toString() ??
              '')) ??
          0;
      final creditRefund = rawCredit > 0 ? rawCredit.round() : 0;
      final totalPayout = depositRefund + creditRefund;
      summary = SettlementPayoutSummary(
        depositRefund: depositRefund,
        creditRefund: creditRefund,
        totalPayout: totalPayout,
        requiresUncPayout: totalPayout > 0,
      );
    } else {
      summary = resolveSettlementPayoutSummary(settlementData ?? {
        'deposit_refund_amount': _dep['amount_held'],
        'credit_refund_amount': 0,
        'total_payout_amount': _dep['amount_held'],
      });
    }

    final canApprove = canActorApproveDepositRow(
      isOwner: permissions.isOwner,
      isManager: permissions.isManager,
      isSysAdmin: permissions.isSysAdmin,
      currentUserId: currentUserId,
      createdBy: settlementData?['created_by'],
      buildingHasActiveOwner: _dep['building_has_active_owner'] == true,
      allowSelfApproval: false,
    );

    final canResolve = permissions.isOwner ||
        permissions.isManager ||
        (permissions.isSysAdmin && _dep['building_has_active_owner'] != true);

    return SingleChildScrollView(
      padding: const EdgeInsets.all(20),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          // Basic Deposit Info Card
          AppCard(
            child: Row(
              children: [
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      const Text('Số tiền cọc thực giữ', style: TextStyle(fontSize: 12, color: AppColors.slate500)),
                      const SizedBox(height: 4),
                      Text(
                        formatMoney(_dep['amount_held'] ?? 0),
                        style: const TextStyle(fontSize: 18, fontWeight: FontWeight.bold, color: AppColors.emerald600),
                      ),
                    ],
                  ),
                ),
                Container(width: 1, height: 40, color: AppColors.slate200),
                const SizedBox(width: 16),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      const Text('Mức cọc quy định', style: TextStyle(fontSize: 12, color: AppColors.slate500)),
                      const SizedBox(height: 4),
                      Text(
                        formatMoney(_dep['deposit_amount'] ?? 0),
                        style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600, color: AppColors.slate800),
                      ),
                    ],
                  ),
                ),
                Container(width: 1, height: 40, color: AppColors.slate200),
                const SizedBox(width: 16),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      const Text('Hợp đồng thuê', style: TextStyle(fontSize: 12, color: AppColors.slate500)),
                      const SizedBox(height: 4),
                      Text(
                        '${_dep['contract_id'] ?? '---'} (${_dep['contract_status'] ?? 'N/A'})',
                        style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w500, color: AppColors.slate700),
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(height: 16),

          // PRD Separation of Deposit Refund vs Credit Balance Refund Card
          Container(
            padding: const EdgeInsets.all(16),
            decoration: BoxDecoration(
              color: AppColors.secondary50.withOpacity(0.4),
              border: Border.all(color: AppColors.secondary100),
              borderRadius: BorderRadius.circular(12),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  mainAxisAlignment: MainAxisAlignment.spaceBetween,
                  children: [
                    const Text(
                      'TỔNG TIỀN HOÀN TRẢ CƯ DÂN',
                      style: TextStyle(
                        fontSize: 13,
                        fontWeight: FontWeight.bold,
                        color: AppColors.secondary700,
                        letterSpacing: 0.5,
                      ),
                    ),
                    Text(
                      formatMoney(summary.totalPayout),
                      style: const TextStyle(
                        fontSize: 20,
                        fontWeight: FontWeight.bold,
                        color: AppColors.secondary600,
                      ),
                    ),
                  ],
                ),
                const Divider(height: 20, color: AppColors.secondary100),
                Row(
                  children: [
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          const Text('• Hoàn từ tiền cọc hợp đồng:',
                              style: TextStyle(fontSize: 13, color: AppColors.slate700)),
                          const SizedBox(height: 2),
                          Text(
                            formatMoney(summary.depositRefund),
                            style: const TextStyle(
                              fontSize: 15,
                              fontWeight: FontWeight.w600,
                              color: AppColors.slate900,
                            ),
                          ),
                        ],
                      ),
                    ),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          const Text('• Hoàn từ số dư tín dụng (Credit Balance):',
                              style: TextStyle(fontSize: 13, color: AppColors.slate700)),
                          const SizedBox(height: 2),
                          Text(
                            formatMoney(summary.creditRefund),
                            style: TextStyle(
                              fontSize: 15,
                              fontWeight: FontWeight.w600,
                              color: summary.creditRefund > 0 ? AppColors.emerald700 : AppColors.slate600,
                            ),
                          ),
                        ],
                      ),
                    ),
                  ],
                ),
              ],
            ),
          ),
          const SizedBox(height: 16),

          // Settlement Details Form / View
          if (status == 'HELD' || status == 'SETTLEMENT_DRAFT')
            _buildSettlementProposalForm(permissions.canSettleDeposits)
          else
            _buildSettlementReadOnlyView(settlementData),

          const SizedBox(height: 24),

          // 4-Eyes Actions Footer
          _buildActionButtons(status, canApprove, canResolve, permissions),
        ],
      ),
    );
  }

  Widget _buildSettlementProposalForm(bool canEdit) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const Text(
          'Khoản mục khấu trừ quyết toán',
          style: TextStyle(fontSize: 15, fontWeight: FontWeight.bold, color: AppColors.slate900),
        ),
        const SizedBox(height: 8),

        // Deductions list
        if (_deductionItems.isEmpty)
          const Padding(
            padding: EdgeInsets.symmetric(vertical: 8),
            child: Text('Không có khoản khấu trừ nào.', style: TextStyle(color: AppColors.slate500, fontSize: 13)),
          )
        else
          ..._deductionItems.asMap().entries.map((entry) {
            final idx = entry.key;
            final item = entry.value;
            final evList = item['evidence'] is List ? (item['evidence'] as List) : [];
            return Card(
              margin: const EdgeInsets.only(bottom: 8),
              elevation: 0,
              shape: RoundedRectangleBorder(
                side: const BorderSide(color: AppColors.slate200),
                borderRadius: BorderRadius.circular(8),
              ),
              child: Padding(
                padding: const EdgeInsets.all(12),
                child: Row(
                  children: [
                    Expanded(
                      flex: 3,
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            kCategoryLabels[item['category']] ?? item['category'].toString(),
                            style: const TextStyle(fontWeight: FontWeight.w500),
                          ),
                          if (evList.isNotEmpty)
                            Text(
                              '${evList.length} minh chứng',
                              style: const TextStyle(fontSize: 11, color: AppColors.slate500),
                            ),
                        ],
                      ),
                    ),
                    Expanded(
                      flex: 2,
                      child: Text(
                        formatMoney(item['amount'] ?? 0),
                        style: const TextStyle(fontWeight: FontWeight.w600, color: AppColors.rose600),
                      ),
                    ),
                    Expanded(
                      flex: 4,
                      child: Text(
                        item['description']?.toString() ?? '',
                        style: const TextStyle(color: AppColors.slate600, fontSize: 13),
                      ),
                    ),
                    if (canEdit)
                      IconButton(
                        key: ValueKey('remove_deduction_$idx'),
                        icon: const Icon(LucideIcons.trash2, size: 16, color: AppColors.rose500),
                        onPressed: () {
                          setState(() {
                            _deductionItems.removeAt(idx);
                          });
                        },
                      ),
                  ],
                ),
              ),
            );
          }),

        if (canEdit) ...[
          const SizedBox(height: 8),
          AppButton(
            text: '+ Thêm khoản khấu trừ',
            variant: AppButtonVariant.outline,
            size: AppButtonSize.sm,
            onPressed: _openAddDeductionDialog,
          ),
          const SizedBox(height: 20),
          const Text(
            'Thông tin nhận hoàn tiền cọc',
            style: TextStyle(fontSize: 15, fontWeight: FontWeight.bold, color: AppColors.slate900),
          ),
          const SizedBox(height: 12),
          BankSelect(
            value: _bankInfo['bank_code']?.toString() ?? '',
            onBankChange: (nextVal, bank) {
              setState(() {
                _bankInfo['bank_code'] = nextVal;
                _bankInfo['bank_name'] = bank?['shortName'] ?? bank?['name'] ?? nextVal;
                _bankInfo['bank_bin'] = bank?['bin']?.toString();
                _bankInfo['bank_logo'] = bank?['logo']?.toString();
              });
            },
          ),
          const SizedBox(height: 12),
          AppInput(
            label: 'Số tài khoản ngân hàng',
            initialValue: _bankInfo['account_number']?.toString() ?? '',
            onChanged: (v) => _bankInfo['account_number'] = v,
          ),
          const SizedBox(height: 12),
          AppInput(
            label: 'Chủ tài khoản thụ hưởng',
            initialValue: _bankInfo['account_holder']?.toString() ?? '',
            onChanged: (v) => _bankInfo['account_holder'] = v,
          ),
          const SizedBox(height: 16),
          const Text('Ảnh / biên bản kiểm tra bàn giao mặt bằng:',
              style: TextStyle(fontSize: 13, fontWeight: FontWeight.w500)),
          const SizedBox(height: 6),
          FileUploadField(
            multiple: true,
            maxFiles: 5,
            value: _inspectionEvidence,
            onChanged: (v) => setState(() => _inspectionEvidence = v),
          ),
        ],
      ],
    );
  }

  void _openAddDeductionDialog() {
    String category = 'DAMAGE';
    int? amount;
    final descController = TextEditingController();
    List<String> evidence = [];

    showDialog<void>(
      context: context,
      builder: (ctx) => StatefulBuilder(
        builder: (context, setDialogState) => AlertDialog(
          title: const Text('Thêm khoản khấu trừ', style: TextStyle(fontWeight: FontWeight.w600)),
          content: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                AppSelect<String>(
                  label: 'Loại khấu trừ',
                  value: category,
                  options: kDeductCategoryOptions
                      .map((o) => AppSelectOption<String>(value: o['value']!, label: o['label']!))
                      .toList(),
                  onChanged: (v) => setDialogState(() => category = v ?? 'DAMAGE'),
                ),
                const SizedBox(height: 12),
                MoneyInput(
                  label: 'Số tiền khấu trừ (VND)',
                  value: amount?.toString(),
                  onChanged: (v) {
                    amount = int.tryParse(v) ?? 0;
                  },
                ),
                const SizedBox(height: 12),
                TextField(
                  controller: descController,
                  decoration: const InputDecoration(
                    labelText: 'Diễn giải lý do khấu trừ',
                    border: OutlineInputBorder(),
                  ),
                ),
                const SizedBox(height: 12),
                FileUploadField(
                  key: const ValueKey('deduction_evidence_upload'),
                  label: 'Ảnh/chứng từ bằng chứng (Bắt buộc FR-023)',
                  value: evidence,
                  multiple: true,
                  maxFiles: 5,
                  hint: 'Đính kèm ít nhất 1 ảnh/chứng từ minh chứng hư hỏng/chi phí',
                  onChanged: (files) {
                    setDialogState(() {
                      if (files == null) {
                        evidence = [];
                      } else if (files is List) {
                        evidence = files.map((e) => e.toString()).where((s) => s.isNotEmpty).toList();
                      } else {
                        final str = files.toString().trim();
                        evidence = str.isNotEmpty ? [str] : [];
                      }
                    });
                  },
                ),
              ],
            ),
          ),
          actions: [
            TextButton(onPressed: () => Navigator.of(ctx).pop(), child: const Text('Hủy')),
            ElevatedButton(
              onPressed: () {
                if ((amount ?? 0) <= 0) {
                  ref.read(toastProvider.notifier).warning('Vui lòng nhập số tiền khấu trừ hợp lệ.');
                  return;
                }
                if (descController.text.trim().isEmpty) {
                  ref.read(toastProvider.notifier).warning('Vui lòng nhập mô tả chi tiết lý do khấu trừ.');
                  return;
                }
                if (evidence.isEmpty) {
                  ref.read(toastProvider.notifier).warning('Khoản khấu trừ bắt buộc phải có ít nhất 01 ảnh bằng chứng (FR-023).');
                  return;
                }
                setState(() {
                  _deductionItems.add({
                    'category': category,
                    'amount': amount,
                    'description': descController.text.trim(),
                    'evidence': List<String>.from(evidence),
                  });
                });
                Navigator.of(ctx).pop();
              },
              child: const Text('Thêm'),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildSettlementReadOnlyView(Map<String, dynamic>? settlement) {
    if (settlement == null) {
      return const EmptyState(title: 'Chưa có hồ sơ quyết toán', description: 'Sổ cọc chưa lập đề xuất quyết toán.');
    }

    final bank = settlement['bank_info'] is Map ? settlement['bank_info'] as Map : null;
    final items = settlement['items'] is List ? settlement['items'] as List : [];

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const Text(
          'Danh mục khấu trừ đã đề xuất',
          style: TextStyle(fontSize: 15, fontWeight: FontWeight.bold, color: AppColors.slate900),
        ),
        const SizedBox(height: 8),
        if (items.isEmpty)
          const Text('Không có khoản khấu trừ.', style: TextStyle(color: AppColors.slate500, fontSize: 13))
        else
          ...items.map((it) {
            final amt = it['amount'];
            return Container(
              margin: const EdgeInsets.only(bottom: 8),
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(
                border: Border.all(color: AppColors.slate200),
                borderRadius: BorderRadius.circular(8),
              ),
              child: Row(
                children: [
                  Expanded(
                    child: Text(
                      kCategoryLabels[it['category']] ?? it['category']?.toString() ?? 'Khấu trừ',
                      style: const TextStyle(fontWeight: FontWeight.w500),
                    ),
                  ),
                  Text(
                    '- ${formatMoney(amt ?? 0)}',
                    style: const TextStyle(fontWeight: FontWeight.bold, color: AppColors.rose600),
                  ),
                ],
              ),
            );
          }),
        const SizedBox(height: 16),
        if (bank != null) ...[
          const Text(
            'Tài khoản ngân hàng nhận hoàn tiền',
            style: TextStyle(fontSize: 15, fontWeight: FontWeight.bold, color: AppColors.slate900),
          ),
          const SizedBox(height: 8),
          Container(
            padding: const EdgeInsets.all(12),
            decoration: BoxDecoration(
              color: AppColors.slate50,
              border: Border.all(color: AppColors.slate200),
              borderRadius: BorderRadius.circular(8),
            ),
            child: Row(
              children: [
                const Icon(LucideIcons.landmark, size: 24, color: AppColors.secondary600),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(bank['bank_name']?.toString() ?? 'Ngân hàng',
                          style: const TextStyle(fontWeight: FontWeight.w600)),
                      Text('STK: ${bank['account_number'] ?? '---'} • Chủ TK: ${bank['account_holder'] ?? '---'}',
                          style: const TextStyle(fontSize: 13, color: AppColors.slate600)),
                    ],
                  ),
                ),
              ],
            ),
          ),
        ],
      ],
    );
  }

  Widget _buildActionButtons(
    String status,
    bool canApprove,
    bool canResolve,
    PermissionMatrix permissions,
  ) {
    if (_actionLoading) {
      return const Center(child: LoadingSpinner());
    }

    return Wrap(
      spacing: 10,
      runSpacing: 10,
      alignment: WrapAlignment.end,
      children: [
        // Print A4 Button (Always available once settlement is prepared or completed)
        if (status != 'HELD')
          AppButton(
            text: 'In bảng kê A4',
            variant: AppButtonVariant.outline,
            icon: const Icon(LucideIcons.printer, size: 16),
            onPressed: _handlePrintA4,
          ),

        // HELD / SETTLEMENT_DRAFT
        if ((status == 'HELD' || status == 'SETTLEMENT_DRAFT') && permissions.canSettleDeposits)
          AppButton(
            text: 'Trình duyệt quyết toán 4 mắt',
            variant: AppButtonVariant.primary,
            icon: const Icon(LucideIcons.send, size: 16),
            loading: _submittingSettlement,
            onPressed: _submitSettlementProposal,
          ),

        // PENDING_APPROVAL: 4-Eyes Approve / Reject / Dispute
        if (status == 'PENDING_APPROVAL') ...[
          if (canApprove)
            AppButton(
              text: 'Phê duyệt tất toán',
              variant: AppButtonVariant.primary,
              icon: const Icon(LucideIcons.checkCircle2, size: 16),
              onPressed: _handleApproveSettlement,
            ),
          if (canApprove)
            AppButton(
              text: 'Từ chối hồ sơ',
              variant: AppButtonVariant.danger,
              icon: const Icon(LucideIcons.xCircle, size: 16),
              onPressed: _handleRejectSettlement,
            ),
          AppButton(
            text: 'Báo cáo tranh chấp',
            variant: AppButtonVariant.warning,
            icon: const Icon(LucideIcons.messageSquareWarning, size: 16),
            onPressed: _handleDispute,
          ),
        ],

        // APPROVED_PENDING_PAYOUT: Execute payout (UNC), mark returned, update bank
        if (status == 'APPROVED_PENDING_PAYOUT') ...[
          if (permissions.canExecuteDepositPayout)
            AppButton(
              text: 'Thực hiện chi hoàn (UNC)',
              variant: AppButtonVariant.primary,
              icon: const Icon(LucideIcons.banknote, size: 16),
              onPressed: _handleExecutePayout,
            ),
          if (permissions.canExecuteDepositPayout)
            AppButton(
              text: 'Ngân hàng trả lại lệnh chi',
              variant: AppButtonVariant.danger,
              icon: const Icon(LucideIcons.rotateCcw, size: 16),
              onPressed: _handleMarkPayoutReturned,
            ),
          AppButton(
            text: 'Cập nhật tài khoản thụ hưởng',
            variant: AppButtonVariant.outline,
            icon: const Icon(LucideIcons.landmark, size: 16),
            onPressed: _handleUpdateBankInfo,
          ),
        ],

        // RETURNED
        if (status == 'RETURNED') ...[
          AppButton(
            text: 'Cập nhật tài khoản thụ hưởng',
            variant: AppButtonVariant.primary,
            icon: const Icon(LucideIcons.landmark, size: 16),
            onPressed: _handleUpdateBankInfo,
          ),
          if (permissions.canExecuteDepositPayout)
            AppButton(
              text: 'Thực hiện lại chi hoàn (UNC)',
              variant: AppButtonVariant.outline,
              icon: const Icon(LucideIcons.banknote, size: 16),
              onPressed: _handleExecutePayout,
            ),
        ],

        // DISPUTED
        if (status == 'DISPUTED' && canResolve)
          AppButton(
            text: 'Giải quyết khiếu nại',
            variant: AppButtonVariant.primary,
            icon: const Icon(LucideIcons.shieldCheck, size: 16),
            onPressed: _handleResolveDispute,
          ),
      ],
    );
  }

  // ===========================================================================
  // Tab 2: Transactions & Collect Additional
  // ===========================================================================

  Widget _buildTransactionsTab() {
    if (_loadingTxns) {
      return const Center(child: LoadingSpinner());
    }

    final reqAmount = (_dep['deposit_amount'] is num
            ? _dep['deposit_amount']
            : num.tryParse(_dep['deposit_amount']?.toString() ?? '')) ??
        0;
    final heldAmount = (_dep['amount_held'] is num
            ? _dep['amount_held']
            : num.tryParse(_dep['amount_held']?.toString() ?? '')) ??
        0;
    final shortage = (reqAmount - heldAmount).toInt();
    final canCollect = canCollectAdditionalDeposit(_dep);

    return SingleChildScrollView(
      padding: const EdgeInsets.all(20),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          // Header & Collect button
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              Text(
                'Lịch sử bút toán giao dịch (${_transactions.length})',
                style: const TextStyle(fontSize: 16, fontWeight: FontWeight.bold, color: AppColors.slate900),
              ),
              if (canCollect)
                AppButton(
                  text: _showCollectForm ? 'Đóng biểu mẫu' : '+ Thu bổ sung cọc',
                  variant: _showCollectForm ? AppButtonVariant.outline : AppButtonVariant.primary,
                  size: AppButtonSize.sm,
                  onPressed: () {
                    setState(() {
                      _showCollectForm = !_showCollectForm;
                      if (_showCollectForm) _collectAmount = shortage;
                    });
                  },
                ),
            ],
          ),
          const SizedBox(height: 16),

          // Collect Additional Form
          if (_showCollectForm) ...[
            Container(
              padding: const EdgeInsets.all(16),
              decoration: BoxDecoration(
                color: AppColors.emerald50.withOpacity(0.5),
                border: Border.all(color: AppColors.emerald200),
                borderRadius: BorderRadius.circular(12),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Text(
                    'Thu bổ sung tiền cọc (Thiếu: ${formatMoney(shortage)})',
                    style: const TextStyle(fontWeight: FontWeight.bold, color: AppColors.emerald700),
                  ),
                  const SizedBox(height: 12),
                  MoneyInput(
                    label: 'Số tiền thu bổ sung (VND)',
                    value: _collectAmount?.toString(),
                    onChanged: (v) {
                      _collectAmount = int.tryParse(v) ?? 0;
                    },
                  ),
                  const SizedBox(height: 12),
                  AppSelect<String>(
                    label: 'Phương thức thanh toán',
                    value: _collectMethod,
                    options: kPaymentMethodOptions
                        .map((o) => AppSelectOption<String>(value: o['value']!, label: o['label']!))
                        .toList(),
                    onChanged: (v) => setState(() => _collectMethod = v ?? 'BANK_TRANSFER'),
                  ),
                  const SizedBox(height: 12),
                  AppInput(
                    label: 'Nội dung giao dịch',
                    initialValue: _collectDescription,
                    onChanged: (v) => _collectDescription = v,
                  ),
                  const SizedBox(height: 12),
                  FileUploadField(
                    label: 'Chứng từ thu tiền:',
                    multiple: true,
                    maxFiles: 3,
                    value: _collectEvidence,
                    onChanged: (v) => setState(() => _collectEvidence = v),
                  ),
                  const SizedBox(height: 16),
                  AppButton(
                    text: 'Ghi nhận thu cọc bổ sung',
                    variant: AppButtonVariant.primary,
                    loading: _submittingCollect,
                    onPressed: _handleCollectAdditional,
                  ),
                ],
              ),
            ),
            const SizedBox(height: 20),
          ],

          // Transactions List
          if (_transactions.isEmpty)
            const EmptyState(title: 'Chưa có giao dịch', description: 'Chưa có bút toán nào được ghi nhận cho sổ cọc này.')
          else
            ..._transactions.map((tx) {
              final type = tx['type']?.toString() ?? 'Giao dịch';
              final amt = tx['amount'] ?? 0;
              final isPositive = type == 'collect' || type == 'refund_reversal';

              return Container(
                margin: const EdgeInsets.only(bottom: 8),
                padding: const EdgeInsets.all(12),
                decoration: BoxDecoration(
                  border: Border.all(color: AppColors.slate200),
                  borderRadius: BorderRadius.circular(8),
                ),
                child: Row(
                  children: [
                    Container(
                      padding: const EdgeInsets.all(8),
                      decoration: BoxDecoration(
                        color: isPositive ? AppColors.emerald50 : AppColors.rose50,
                        shape: BoxShape.circle,
                      ),
                      child: Icon(
                        isPositive ? LucideIcons.plus : LucideIcons.minus,
                        size: 16,
                        color: isPositive ? AppColors.emerald600 : AppColors.rose600,
                      ),
                    ),
                    const SizedBox(width: 12),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            tx['description']?.toString() ?? type,
                            style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 14),
                          ),
                          Text(
                            '${tx['method'] ?? 'CHUYỂN KHOẢN'} • ${formatDateTime(tx['created_at'])}',
                            style: const TextStyle(fontSize: 12, color: AppColors.slate500),
                          ),
                        ],
                      ),
                    ),
                    Text(
                      '${isPositive ? '+' : '-'} ${formatMoney(amt)}',
                      style: TextStyle(
                        fontWeight: FontWeight.bold,
                        fontSize: 15,
                        color: isPositive ? AppColors.emerald600 : AppColors.rose600,
                      ),
                    ),
                  ],
                ),
              );
            }),
        ],
      ),
    );
  }

  // ===========================================================================
  // Tab 3: Audit Logs
  // ===========================================================================

  Widget _buildAuditLogsTab() {
    if (_loadingAuditLogs) {
      return const Center(child: LoadingSpinner());
    }

    if (_auditLogs.isEmpty) {
      return const EmptyState(
        title: 'Chưa có nhật ký kiểm toán',
        description: 'Chưa có thay đổi nào được ghi nhận cho sổ cọc này.',
      );
    }

    return ListView.separated(
      padding: const EdgeInsets.all(20),
      itemCount: _auditLogs.length,
      separatorBuilder: (_, __) => const Divider(height: 16, color: AppColors.slate200),
      itemBuilder: (context, idx) {
        final log = _auditLogs[idx];
        return Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Padding(
              padding: EdgeInsets.only(top: 2),
              child: Icon(LucideIcons.history, size: 16, color: AppColors.secondary500),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    log['action']?.toString() ?? 'Hành động',
                    style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 14),
                  ),
                  const SizedBox(height: 2),
                  Text(
                    '${log['actor_name'] ?? 'Hệ thống'} • ${formatDateTime(log['created_at'])}',
                    style: const TextStyle(fontSize: 12, color: AppColors.slate500),
                  ),
                  if (log['details'] != null) ...[
                    const SizedBox(height: 4),
                    Text(
                      log['details'].toString(),
                      style: const TextStyle(fontSize: 12, color: AppColors.slate700),
                    ),
                  ],
                ],
              ),
            ),
          ],
        );
      },
    );
  }
}
