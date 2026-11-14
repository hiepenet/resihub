import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../../../core/constants/statuses.dart';
import '../../../core/theme/app_colors.dart';
import '../../../core/utils/billing_helpers.dart';
import '../../../core/utils/file_exporter.dart';
import '../../../core/utils/format.dart';
import '../../../core/utils/validation.dart';
import '../../../shared/providers/toast_provider.dart';
import '../../../shared/widgets/common/bank_select.dart';
import '../../../shared/widgets/common/data_table_widget.dart';
import '../../../shared/widgets/common/page_header.dart';
import '../../../shared/widgets/common/search_bar_widget.dart';
import '../../../shared/widgets/common/stats_card.dart';
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
import '../../invoices/services/invoices_service.dart';
import '../services/payments_service.dart';

const Map<String, String> kPaymentMethods = {
  'BANK_TRANSFER': 'Chuyển khoản',
  'TRANSFER': 'Chuyển khoản',
  'QR_CODE': 'QR Code',
  'E_WALLET': 'Ví điện tử',
  'EWALLET': 'Ví điện tử',
  'CASH': 'Tiền mặt',
  'CARD': 'Thẻ',
  'OTHER': 'Khác',
};

const Map<String, String> kPaymentStatusMap = {
  'PENDING_CONFIRMATION': 'Chờ đối soát',
  'CONFIRMED': 'Đã xác nhận',
  'REJECTED': 'Đã từ chối',
};

const List<AppSelectOption<String>> kPaymentMethodSelectOptions = [
  AppSelectOption(value: 'BANK_TRANSFER', label: 'Chuyển khoản'),
  AppSelectOption(value: 'QR_CODE', label: 'QR Code'),
  AppSelectOption(value: 'E_WALLET', label: 'Ví điện tử'),
  AppSelectOption(value: 'CASH', label: 'Tiền mặt'),
  AppSelectOption(value: 'CARD', label: 'Thẻ'),
  AppSelectOption(value: 'OTHER', label: 'Khác'),
];

const Map<String, ({String label, AppBadgeVariant variant})> kAgingLabels = {
  'current_not_due': (label: 'Chưa đến hạn', variant: AppBadgeVariant.slate),
  '0_15': (label: '0–15 ngày', variant: AppBadgeVariant.emerald),
  '16_30': (label: '16–30 ngày', variant: AppBadgeVariant.amber),
  '31_60': (label: '31–60 ngày', variant: AppBadgeVariant.indigo),
  'over_60': (label: '>60 ngày', variant: AppBadgeVariant.red),
};

/// Thanh toán & Đối soát Công nợ 4 Phân mục (M10).
/// Port of `frontend/src/pages/admin/payments/PaymentsPage.jsx`.
class PaymentsPage extends ConsumerStatefulWidget {
  final String? initialTab;
  final String? initialBucket;
  final String? initialPaymentId;

  const PaymentsPage({
    super.key,
    this.initialTab,
    this.initialBucket,
    this.initialPaymentId,
  });

  @override
  ConsumerState<PaymentsPage> createState() => _PaymentsPageState();
}

class _PaymentsPageState extends ConsumerState<PaymentsPage> {
  late String _activeTab; // transactions | aging | credits | overpayments

  // Tab 1: Transactions
  List<Map<String, dynamic>> _payments = [];
  bool _paymentsLoading = true;
  String _payStatusFilter = '';
  String _payMethodFilter = '';
  String _paySearch = '';
  Timer? _payDebounce;

  // Tab 2: Aging
  List<Map<String, dynamic>> _receivables = [];
  bool _agingLoading = false;
  String _agingBucketFilter = '';
  String _recStatusFilter = 'OPEN,PARTIALLY_PAID';
  String _recSearch = '';
  Map<String, num> _agingSummary = {
    'current_not_due': 0,
    'bucket_0_15': 0,
    'bucket_16_30': 0,
    'bucket_31_60': 0,
    'bucket_over_60': 0,
    'total_balance': 0,
  };

  // Tab 3: Credits
  List<Map<String, dynamic>> _credits = [];
  bool _creditsLoading = true;
  String _creditStatusFilter = '';
  String _creditSearch = '';

  // Tab 4: Overpayments
  List<Map<String, dynamic>> _overpayments = [];
  bool _overLoading = false;

  // Modals state
  bool _createOpen = false;
  bool _creating = false;
  List<Map<String, dynamic>> _openInvoices = [];
  String _createInvoiceId = '';
  String _createReceivableId = '';
  String _createAmount = '';
  String _createMethod = 'BANK_TRANSFER';
  String _createRefCode = '';
  String _createNote = '';
  String _createProofImage = '';

  // Review payment modal
  Map<String, dynamic>? _reviewPayment;
  String _confirmNote = '';
  bool _processingAction = false;
  Map<String, dynamic>? _rejectPaymentTarget;
  String _rejectPaymentReason = '';

  // Credit refund request modal
  Map<String, dynamic>? _refundRequestTarget;
  String _refundAmount = '';
  String _refundReason = '';
  String _refundBankInfo = '';
  String _refundProofImage = '';

  // Reject credit refund modal
  Map<String, dynamic>? _rejectCreditTarget;
  String _rejectCreditReason = '';

  @override
  void initState() {
    super.initState();
    _activeTab = widget.initialTab ?? 'transactions';
    _agingBucketFilter = widget.initialBucket ?? '';

    _loadInitialData();
  }

  @override
  void dispose() {
    _payDebounce?.cancel();
    super.dispose();
  }

  void _loadInitialData() {
    final buildingId = ref.read(authProvider).selectedBuildingId;
    final peekedPayments = ref.read(paymentsServiceProvider).peekList({
      if (buildingId.isNotEmpty) 'building_id': buildingId,
    });
    if (peekedPayments is Map && peekedPayments['data'] is List) {
      _payments = (peekedPayments['data'] as List)
          .whereType<Map>()
          .map((e) => Map<String, dynamic>.from(e))
          .toList();
      _paymentsLoading = false;
    }

    _fetchPayments();
    _fetchReceivables();
    _fetchCredits();
    _fetchOverpayments();
  }

  Future<void> _fetchPayments({bool force = false}) async {
    final buildingId = ref.read(authProvider).selectedBuildingId;
    final params = {
      if (buildingId.isNotEmpty) 'building_id': buildingId,
      if (_payStatusFilter.isNotEmpty) 'status': _payStatusFilter,
      if (_payMethodFilter.isNotEmpty) 'method': _payMethodFilter,
      if (_paySearch.trim().isNotEmpty) 'search': _paySearch.trim(),
    };

    if (!force) {
      final cached = ref.read(paymentsServiceProvider).peekList(params);
      if (cached is Map && cached['data'] is List) {
        setState(() {
          _payments = (cached['data'] as List)
              .whereType<Map>()
              .map((e) => Map<String, dynamic>.from(e))
              .toList();
          _paymentsLoading = false;
        });
      }
    }

    try {
      final res = await ref.read(paymentsServiceProvider).list(params, force);
      if (!mounted) return;
      if (res is Map && res['data'] is List) {
        setState(() {
          _payments = (res['data'] as List)
              .whereType<Map>()
              .map((e) => Map<String, dynamic>.from(e))
              .toList();
          _paymentsLoading = false;
        });

        if (widget.initialPaymentId != null && _reviewPayment == null) {
          final found = _payments.firstWhere(
            (p) => p['id']?.toString() == widget.initialPaymentId,
            orElse: () => const {},
          );
          if (found.isNotEmpty) {
            _reviewPayment = found;
            _confirmNote = found['note']?.toString() ?? '';
          }
        }
      } else {
        setState(() {
          _payments = [];
          _paymentsLoading = false;
        });
      }
    } catch (err) {
      if (mounted) {
        setState(() => _paymentsLoading = false);
        ref.read(toastProvider.notifier).error(
              extractErrorMessage(err, 'Không thể tải danh sách giao dịch thanh toán.'),
            );
      }
    }
  }

  Future<void> _fetchReceivables({bool force = false}) async {
    final buildingId = ref.read(authProvider).selectedBuildingId;
    final params = {
      if (buildingId.isNotEmpty) 'building_id': buildingId,
      if (_recStatusFilter.isNotEmpty && _recStatusFilter != 'ALL') 'status': _recStatusFilter,
    };

    setState(() => _agingLoading = true);
    try {
      final res = await ref.read(paymentsServiceProvider).listReceivables(params, force);
      if (!mounted) return;
      if (res is Map && res['data'] is List) {
        final rawSummary = res['aging_summary_prd'] ?? res['aging_summary'];
        final s = rawSummary is Map ? rawSummary : {};

        setState(() {
          _receivables = (res['data'] as List)
              .whereType<Map>()
              .map((e) => Map<String, dynamic>.from(e))
              .toList();
          _agingSummary = {
            'current_not_due': num.tryParse(s['current_not_due']?.toString() ?? '0') ?? 0,
            'bucket_0_15': num.tryParse((s['bucket_0_15'] ?? s['0_15'])?.toString() ?? '0') ?? 0,
            'bucket_16_30': num.tryParse((s['bucket_16_30'] ?? s['16_30'])?.toString() ?? '0') ?? 0,
            'bucket_31_60': num.tryParse((s['bucket_31_60'] ?? s['31_60'])?.toString() ?? '0') ?? 0,
            'bucket_over_60': num.tryParse((s['bucket_over_60'] ?? s['over_60'])?.toString() ?? '0') ?? 0,
            'total_balance': num.tryParse(s['total_balance']?.toString() ?? '0') ?? 0,
          };
          _agingLoading = false;
        });
      } else {
        setState(() {
          _receivables = [];
          _agingLoading = false;
        });
      }
    } catch (err) {
      if (mounted) {
        setState(() => _agingLoading = false);
        ref.read(toastProvider.notifier).error(
              extractErrorMessage(err, 'Không thể tải báo cáo công nợ tuổi nợ.'),
            );
      }
    }
  }

  Future<void> _fetchCredits({bool force = false}) async {
    final buildingId = ref.read(authProvider).selectedBuildingId;
    final params = {
      if (buildingId.isNotEmpty) 'building_id': buildingId,
      if (_creditStatusFilter.isNotEmpty) 'status': _creditStatusFilter,
    };

    setState(() => _creditsLoading = true);
    try {
      final res = await ref.read(paymentsServiceProvider).getCredits(params, force);
      if (!mounted) return;
      if (res is Map && res['data'] is List) {
        setState(() {
          _credits = (res['data'] as List)
              .whereType<Map>()
              .map((e) => Map<String, dynamic>.from(e))
              .toList();
          _creditsLoading = false;
        });
      } else {
        setState(() {
          _credits = [];
          _creditsLoading = false;
        });
      }
    } catch (err) {
      if (mounted) {
        setState(() {
          _credits = [];
          _creditsLoading = false;
        });
        ref.read(toastProvider.notifier).error(
              extractErrorMessage(err, 'Không thể tải danh sách số dư tín dụng.'),
            );
      }
    }
  }

  Future<void> _fetchOverpayments({bool force = false}) async {
    final buildingId = ref.read(authProvider).selectedBuildingId;
    final params = {
      if (buildingId.isNotEmpty) 'building_id': buildingId,
      'overpayment_only': 'true',
    };

    setState(() => _overLoading = true);
    try {
      final res = await ref.read(paymentsServiceProvider).list(params, force);
      if (!mounted) return;
      if (res is Map && res['data'] is List) {
        final list = (res['data'] as List)
            .whereType<Map>()
            .map((e) => Map<String, dynamic>.from(e))
            .where((p) => (num.tryParse(p['overpayment_amount']?.toString() ?? '0') ?? 0) > 0)
            .toList();
        setState(() {
          _overpayments = list;
          _overLoading = false;
        });
      } else {
        setState(() {
          _overpayments = [];
          _overLoading = false;
        });
      }
    } catch (err) {
      if (mounted) {
        setState(() => _overLoading = false);
        ref.read(toastProvider.notifier).error(
              extractErrorMessage(err, 'Không thể tải danh sách thanh toán thừa.'),
            );
      }
    }
  }

  Future<void> _openCreateModal([Map<String, dynamic>? presetReceivable]) async {
    setState(() {
      _createInvoiceId = presetReceivable?['invoice_id']?.toString() ?? '';
      _createReceivableId = presetReceivable?['id']?.toString() ?? '';
      _createAmount = presetReceivable != null ? presetReceivable['balance']?.toString() ?? '' : '';
      _createMethod = 'BANK_TRANSFER';
      _createRefCode = '';
      _createNote = presetReceivable != null ? 'Thu nợ ${presetReceivable['invoice_code'] ?? ''}' : '';
      _createProofImage = '';
      _createOpen = true;
    });

    final buildingId = ref.read(authProvider).selectedBuildingId;
    try {
      final res = await ref.read(invoicesServiceProvider).list({
        if (buildingId.isNotEmpty) 'building_id': buildingId,
        'status': 'ISSUED,PARTIALLY_PAID,OVERDUE,ADJUSTED',
      });
      if (!mounted) return;
      if (res is Map && res['data'] is List) {
        setState(() {
          _openInvoices = (res['data'] as List)
              .whereType<Map>()
              .map((e) => Map<String, dynamic>.from(e))
              .toList();
        });
      }
    } catch (err) {
      if (mounted) {
        setState(() => _openInvoices = []);
        ref.read(toastProvider.notifier).error(
              extractErrorMessage(err, 'Không thể tải danh sách hóa đơn đang mở.'),
            );
      }
    }
  }

  Future<void> _handleCreatePayment() async {
    if (_createInvoiceId.isEmpty && _createReceivableId.isEmpty) {
      ref.read(toastProvider.notifier).warning('Vui lòng chọn hóa đơn cần thu tiền.');
      return;
    }
    final amt = num.tryParse(_createAmount)?.round() ?? 0;
    if (amt <= 0) {
      ref.read(toastProvider.notifier).warning('Số tiền thanh toán phải lớn hơn 0.');
      return;
    }

    setState(() => _creating = true);
    try {
      final res = await ref.read(paymentsServiceProvider).create({
        if (_createInvoiceId.isNotEmpty) 'invoice_id': _createInvoiceId,
        if (_createReceivableId.isNotEmpty) 'receivable_id': _createReceivableId,
        'amount': amt,
        'method': _createMethod,
        if (_createRefCode.trim().isNotEmpty) 'reference_code': _createRefCode.trim(),
        if (_createNote.trim().isNotEmpty) 'note': _createNote.trim(),
        if (_createProofImage.isNotEmpty) 'proof_images': [_createProofImage],
      });
      if (!mounted) return;
      final msg = res is Map && res['message'] != null
          ? res['message'].toString()
          : 'Ghi nhận thanh toán thành công.';
      ref.read(toastProvider.notifier).success(msg);
      setState(() => _createOpen = false);
      _fetchPayments(force: true);
      _fetchReceivables(force: true);
      _fetchOverpayments(force: true);
    } catch (err) {
      if (mounted) {
        ref.read(toastProvider.notifier).error(
              extractErrorMessage(err, 'Không thể ghi nhận thanh toán.'),
            );
      }
    } finally {
      if (mounted) setState(() => _creating = false);
    }
  }

  Future<void> _handleConfirmPayment(Map<String, dynamic> payment, [String noteText = '']) async {
    setState(() => _processingAction = true);
    final id = payment['id'].toString();
    try {
      final res = await ref.read(paymentsServiceProvider).confirm(id, {
        if (noteText.trim().isNotEmpty) 'note': noteText.trim(),
      });
      if (!mounted) return;
      final msg = res is Map && res['message'] != null
          ? res['message'].toString()
          : 'Đã đối soát xác nhận giao dịch ${payment['payment_code']}.';
      ref.read(toastProvider.notifier).success(msg);
      setState(() {
        _reviewPayment = null;
        _confirmNote = '';
      });
      _fetchPayments(force: true);
      _fetchReceivables(force: true);
      _fetchOverpayments(force: true);
    } catch (err) {
      if (mounted) {
        ref.read(toastProvider.notifier).error(
              extractErrorMessage(err, 'Không thể xác nhận giao dịch thanh toán.'),
            );
      }
    } finally {
      if (mounted) setState(() => _processingAction = false);
    }
  }

  Future<void> _handleRejectPayment() async {
    if (_rejectPaymentTarget == null) return;
    if (_rejectPaymentReason.trim().isEmpty) {
      ref.read(toastProvider.notifier).warning('Vui lòng nhập lý do từ chối chứng từ.');
      return;
    }

    setState(() => _processingAction = true);
    try {
      final res = await ref.read(paymentsServiceProvider).reject(
            _rejectPaymentTarget!['id'].toString(),
            {'reason': _rejectPaymentReason.trim()},
          );
      if (!mounted) return;
      final msg = res is Map && res['message'] != null
          ? res['message'].toString()
          : 'Đã từ chối chứng từ thanh toán.';
      ref.read(toastProvider.notifier).success(msg);
      setState(() {
        _rejectPaymentTarget = null;
        _reviewPayment = null;
        _rejectPaymentReason = '';
      });
      _fetchPayments(force: true);
    } catch (err) {
      if (mounted) {
        ref.read(toastProvider.notifier).error(
              extractErrorMessage(err, 'Không thể từ chối chứng từ.'),
            );
      }
    } finally {
      if (mounted) setState(() => _processingAction = false);
    }
  }

  Future<void> _handleApproveCreditRefund(Map<String, dynamic> credit) async {
    setState(() => _processingAction = true);
    try {
      final res = await ref.read(paymentsServiceProvider).approveCreditRefund(credit['id'].toString());
      if (!mounted) return;
      final msg = res is Map && res['message'] != null
          ? res['message'].toString()
          : 'Đã phê duyệt hoàn tiền tín dụng thành công.';
      ref.read(toastProvider.notifier).success(msg);
      _fetchCredits(force: true);
    } catch (err) {
      if (mounted) {
        ref.read(toastProvider.notifier).error(
              extractErrorMessage(err, 'Không thể phê duyệt hoàn tiền tín dụng.'),
            );
      }
    } finally {
      if (mounted) setState(() => _processingAction = false);
    }
  }

  Future<void> _handleRejectCreditRefund() async {
    if (_rejectCreditTarget == null) return;
    if (_rejectCreditReason.trim().isEmpty) {
      ref.read(toastProvider.notifier).warning('Vui lòng nhập lý do từ chối hoàn tiền.');
      return;
    }

    setState(() => _processingAction = true);
    try {
      final res = await ref.read(paymentsServiceProvider).rejectCreditRefund(
            _rejectCreditTarget!['id'].toString(),
            {'rejection_reason': _rejectCreditReason.trim()},
          );
      if (!mounted) return;
      final msg = res is Map && res['message'] != null
          ? res['message'].toString()
          : 'Đã từ chối đề nghị hoàn tiền tín dụng.';
      ref.read(toastProvider.notifier).success(msg);
      setState(() {
        _rejectCreditTarget = null;
        _rejectCreditReason = '';
      });
      _fetchCredits(force: true);
    } catch (err) {
      if (mounted) {
        ref.read(toastProvider.notifier).error(
              extractErrorMessage(err, 'Không thể từ chối đề nghị hoàn tiền.'),
            );
      }
    } finally {
      if (mounted) setState(() => _processingAction = false);
    }
  }

  Future<void> _handleRequestCreditRefund() async {
    if (_refundRequestTarget == null) return;
    final amt = num.tryParse(_refundAmount)?.round() ?? 0;
    final total = num.tryParse(_refundRequestTarget!['amount']?.toString() ?? '0') ?? 0;
    final applied = num.tryParse(_refundRequestTarget!['applied_amount']?.toString() ?? '0') ?? 0;
    final avail = total - applied > 0 ? total - applied : 0;

    if (amt <= 0) {
      ref.read(toastProvider.notifier).warning('Số tiền hoàn trả phải lớn hơn 0.');
      return;
    }
    if (amt > avail) {
      ref.read(toastProvider.notifier).warning('Số tiền hoàn tối đa là ${formatMoney(avail)}.');
      return;
    }
    if (_refundReason.trim().isEmpty) {
      ref.read(toastProvider.notifier).warning('Vui lòng nhập lý do hoàn tiền.');
      return;
    }

    setState(() => _processingAction = true);
    try {
      final res = await ref.read(paymentsServiceProvider).requestCreditRefund(
            _refundRequestTarget!['id'].toString(),
            {
              'amount': amt,
              'reason': _refundReason.trim(),
              if (_refundBankInfo.trim().isNotEmpty) 'bank_info': _refundBankInfo.trim(),
              if (_refundProofImage.isNotEmpty) 'proof_image': _refundProofImage,
            },
          );
      if (!mounted) return;
      final msg = res is Map && res['message'] != null
          ? res['message'].toString()
          : 'Đã gửi đề nghị hoàn tiền tín dụng (chờ duyệt 4 mắt).';
      ref.read(toastProvider.notifier).success(msg);
      setState(() => _refundRequestTarget = null);
      _fetchCredits(force: true);
    } catch (err) {
      if (mounted) {
        ref.read(toastProvider.notifier).error(
              extractErrorMessage(err, 'Không thể gửi đề nghị hoàn tiền tín dụng.'),
            );
      }
    } finally {
      if (mounted) setState(() => _processingAction = false);
    }
  }

  Future<void> _exportAgingCsv(List<Map<String, dynamic>> list) async {
    if (list.isEmpty) {
      ref.read(toastProvider.notifier).warning('Không có dữ liệu công nợ để xuất CSV.');
      return;
    }

    final headers = [
      const CsvHeader(label: 'Mã tòa', key: 'building_code'),
      const CsvHeader(label: 'Căn hộ', key: 'apartment_code'),
      const CsvHeader(label: 'Khách thuê', key: 'tenant_name'),
      const CsvHeader(label: 'SĐT', key: 'tenant_phone'),
      const CsvHeader(label: 'Mã hóa đơn', key: 'invoice_code'),
      CsvHeader(label: 'Hạn thanh toán', key: 'due_date', accessor: (r) => formatDate(r['due_date'])),
      const CsvHeader(label: 'Số ngày quá hạn', key: 'days_overdue'),
      CsvHeader(label: 'Nhóm tuổi nợ', key: 'days_overdue', accessor: (r) => kAgingLabels[resolvePrdAgingBucket(r['days_overdue'])]?.label ?? 'Chưa đến hạn'),
      const CsvHeader(label: 'Phải thu (VNĐ)', key: 'amount'),
      const CsvHeader(label: 'Đã thu (VNĐ)', key: 'paid_amount'),
      const CsvHeader(label: 'Dư nợ còn lại (VNĐ)', key: 'balance'),
      const CsvHeader(label: 'Trạng thái', key: 'status'),
    ];

    try {
      final bytes = buildUtf8BomCsvBytes(headers: headers, rows: list);
      await saveOrShareBytes(
        bytes,
        fileName: 'bao-cao-cong-no-aging.csv',
        mimeType: 'text/csv',
      );
      ref.read(toastProvider.notifier).success('Đã xuất danh sách công nợ Aging ra CSV.');
    } catch (err) {
      ref.read(toastProvider.notifier).error('Không thể xuất file CSV: $err');
    }
  }

  Widget _buildModalOverlay({
    required Widget child,
    double maxWidth = 600,
  }) {
    return Positioned.fill(
      child: ColoredBox(
        color: AppColors.slate900.withValues(alpha: 0.45),
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(24),
            child: ConstrainedBox(
              constraints: BoxConstraints(maxWidth: maxWidth),
              child: child,
            ),
          ),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final permissions = ref.watch(permissionProvider);
    final user = ref.watch(authProvider).user;
    final canManagePayments = permissions.canManagePayments;
    final canApproveCreditRefunds = permissions.canApproveCreditRefunds;

    final pendingConfirmList = _payments.where((p) => p['status'] == 'PENDING_CONFIRMATION').toList();
    final pendingRefundsCount = _credits.where((c) => c['status'] == 'PENDING_DIRECT_REFUND').length;

    // Filtered receivables
    final filteredReceivables = _receivables.where((r) {
      if (_agingBucketFilter.isNotEmpty) {
        final bucket = resolvePrdAgingBucket(r['days_overdue']);
        if (bucket != _agingBucketFilter) return false;
      }
      if (_recSearch.trim().isNotEmpty) {
        final q = _recSearch.trim().toLowerCase();
        final hit = (r['apartment_code']?.toString().toLowerCase().contains(q) ?? false) ||
            (r['tenant_name']?.toString().toLowerCase().contains(q) ?? false) ||
            (r['invoice_code']?.toString().toLowerCase().contains(q) ?? false);
        if (!hit) return false;
      }
      return true;
    }).toList();

    // Filtered credits
    final filteredCredits = _credits.where((c) {
      if (_creditStatusFilter.isNotEmpty && c['status'] != _creditStatusFilter) return false;
      if (_creditSearch.trim().isNotEmpty) {
        final q = _creditSearch.trim().toLowerCase();
        final hit = (c['apartment_code']?.toString().toLowerCase().contains(q) ?? false) ||
            (c['tenant_name']?.toString().toLowerCase().contains(q) ?? false) ||
            (c['description']?.toString().toLowerCase().contains(q) ?? false);
        if (!hit) return false;
      }
      return true;
    }).toList();

    // Total overpayments sum
    final totalOverpaymentSum = _overpayments.fold<num>(
      0,
      (sum, p) => sum + (num.tryParse(p['overpayment_amount']?.toString() ?? '0') ?? 0),
    );

    return Stack(
      children: [
        SingleChildScrollView(
      padding: const EdgeInsets.all(24.0),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          PageHeader(
            title: 'Thanh toán & Đối soát Công nợ',
            subtitle: 'Đối soát chứng từ chuyển khoản của cư dân, ghi nhận phiếu thu và phân tích tuổi nợ (Aging).',
            actions: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                AppButton(
                  text: 'Làm mới',
                  icon: const Icon(LucideIcons.refreshCw, size: 14),
                  variant: AppButtonVariant.outline,
                  onPressed: () {
                    _fetchPayments(force: true);
                    _fetchReceivables(force: true);
                    _fetchCredits(force: true);
                    _fetchOverpayments(force: true);
                  },
                ),
                if (canManagePayments) ...[
                  const SizedBox(width: 8),
                  AppButton(
                    text: 'Ghi nhận thanh toán mới',
                    icon: const Icon(LucideIcons.plus, size: 14),
                    variant: AppButtonVariant.primary,
                    onPressed: () => _openCreateModal(),
                  ),
                ],
              ],
            ),
          ),
          const SizedBox(height: 16),

          // Tabs
          AppTabs(
            activeTab: _activeTab,
            onChanged: (tab) => setState(() => _activeTab = tab),
            tabs: [
              AppTabItem(
                id: 'transactions',
                label: 'Giao dịch thanh toán',
                icon: const Icon(LucideIcons.wallet, size: 14),
                count: pendingConfirmList.isNotEmpty ? pendingConfirmList.length : _payments.length,
              ),
              AppTabItem(
                id: 'aging',
                label: 'Công nợ theo tuổi nợ (AC-016.1)',
                icon: const Icon(LucideIcons.clock, size: 14),
                count: _receivables.length,
              ),
              AppTabItem(
                id: 'credits',
                label: 'Sổ tín dụng / Hoàn tiền (4 mắt)',
                icon: const Icon(LucideIcons.sparkles, size: 14),
                count: pendingRefundsCount > 0 ? pendingRefundsCount : _credits.length,
              ),
              AppTabItem(
                id: 'overpayments',
                label: 'Thanh toán thừa',
                icon: const Icon(LucideIcons.trendingUp, size: 14),
                count: _overpayments.length,
              ),
            ],
          ),
          const SizedBox(height: 16),

          // TAB 1: TRANSACTIONS
          if (_activeTab == 'transactions') ...[
            // Banner for PENDING_CONFIRMATION
            if (pendingConfirmList.isNotEmpty) ...[
              Container(
                padding: const EdgeInsets.all(16),
                decoration: BoxDecoration(
                  color: const Color(0xFFFFFBEB),
                  borderRadius: BorderRadius.circular(12),
                  border: Border.all(color: const Color(0xFFFDE68A), width: 2),
                ),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        const Icon(LucideIcons.triangleAlert, color: Color(0xFFD97706), size: 22),
                        const SizedBox(width: 8),
                        Text(
                          'Cần đối soát ngay: ${pendingConfirmList.length} chứng từ thanh toán do cư dân gửi',
                          style: const TextStyle(fontWeight: FontWeight.bold, color: Color(0xFF78350F), fontSize: 13),
                        ),
                      ],
                    ),
                    const SizedBox(height: 12),
                    ListView.separated(
                      shrinkWrap: true,
                      physics: const NeverScrollableScrollPhysics(),
                      itemCount: pendingConfirmList.length,
                      separatorBuilder: (_, __) => const SizedBox(height: 8),
                      itemBuilder: (context, idx) {
                        final item = pendingConfirmList[idx];
                        final proofImages = item['proof_images'] is List ? item['proof_images'] as List : [];
                        final firstImg = proofImages.isNotEmpty ? proofImages.first?.toString() : null;

                        return Container(
                          padding: const EdgeInsets.all(12),
                          decoration: BoxDecoration(
                            color: Colors.white,
                            borderRadius: BorderRadius.circular(8),
                            border: Border.all(color: const Color(0xFFFDE68A)),
                          ),
                          child: Row(
                            children: [
                              if (firstImg != null)
                                InkWell(
                                  onTap: () {
                                    setState(() {
                                      _reviewPayment = item;
                                      _confirmNote = item['note']?.toString() ?? '';
                                    });
                                  },
                                  child: Container(
                                    width: 50,
                                    height: 50,
                                    margin: const EdgeInsets.only(right: 12),
                                    decoration: BoxDecoration(
                                      borderRadius: BorderRadius.circular(6),
                                      border: Border.all(color: AppColors.slate200),
                                    ),
                                    clipBehavior: Clip.antiAlias,
                                    child: AuthImage(src: firstImg),
                                  ),
                                ),
                              Expanded(
                                child: Column(
                                  crossAxisAlignment: CrossAxisAlignment.start,
                                  children: [
                                    Text(
                                      'Căn ${item['apartment_code'] ?? '—'} (${item['building_code'] ?? '—'}) • ${formatMoney(item['amount'])}',
                                      style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 13),
                                    ),
                                    Text(
                                      '${item['tenant_name'] ?? 'Cư dân'} • HĐ: ${item['invoice_code'] ?? '—'} • ${kPaymentMethods[item['method']] ?? item['method']}',
                                      style: const TextStyle(fontSize: 12, color: AppColors.textSecondary),
                                    ),
                                  ],
                                ),
                              ),
                              AppButton(
                                text: 'Xem ảnh',
                                size: AppButtonSize.sm,
                                variant: AppButtonVariant.outline,
                                onPressed: () {
                                  setState(() {
                                    _reviewPayment = item;
                                    _confirmNote = item['note']?.toString() ?? '';
                                  });
                                },
                              ),
                              if (canManagePayments) ...[
                                const SizedBox(width: 6),
                                AppButton(
                                  text: 'Đối soát xác nhận',
                                  icon: const Icon(LucideIcons.check, size: 14),
                                  size: AppButtonSize.sm,
                                  variant: AppButtonVariant.success,
                                  disabled: _processingAction,
                                  onPressed: () => _handleConfirmPayment(item),
                                ),
                                const SizedBox(width: 6),
                                AppButton(
                                  text: 'Từ chối',
                                  icon: const Icon(LucideIcons.x, size: 14),
                                  size: AppButtonSize.sm,
                                  variant: AppButtonVariant.danger,
                                  disabled: _processingAction,
                                  onPressed: () {
                                    setState(() {
                                      _rejectPaymentTarget = item;
                                      _rejectPaymentReason = '';
                                    });
                                  },
                                ),
                              ],
                            ],
                          ),
                        );
                      },
                    ),
                  ],
                ),
              ),
              const SizedBox(height: 16),
            ],

            // Filters
            AppCard(
              padding: const EdgeInsets.all(16),
              child: Row(
                children: [
                  Expanded(
                    child: SearchBarWidget(
                      placeholder: 'Tìm mã giao dịch, hóa đơn, căn hộ, khách thuê...',
                      onChanged: (val) {
                        _payDebounce?.cancel();
                        _payDebounce = Timer(const Duration(milliseconds: 250), () {
                          if (mounted) {
                            setState(() => _paySearch = val);
                            _fetchPayments();
                          }
                        });
                      },
                    ),
                  ),
                  const SizedBox(width: 12),
                  SizedBox(
                    width: 200,
                    child: AppSelect<String>(
                      placeholder: 'Tất cả trạng thái',
                      value: _payStatusFilter.isEmpty ? null : _payStatusFilter,
                      options: [
                        const AppSelectOption(value: '', label: 'Tất cả trạng thái'),
                        ...kPaymentStatusMap.entries.map((e) => AppSelectOption(value: e.key, label: e.value)),
                      ],
                      onChanged: (val) {
                        setState(() => _payStatusFilter = val ?? '');
                        _fetchPayments();
                      },
                    ),
                  ),
                  const SizedBox(width: 12),
                  SizedBox(
                    width: 200,
                    child: AppSelect<String>(
                      placeholder: 'Tất cả phương thức',
                      value: _payMethodFilter.isEmpty ? null : _payMethodFilter,
                      options: [
                        const AppSelectOption(value: '', label: 'Tất cả phương thức'),
                        ...kPaymentMethodSelectOptions,
                      ],
                      onChanged: (val) {
                        setState(() => _payMethodFilter = val ?? '');
                        _fetchPayments();
                      },
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 16),

            // Payments DataTable
            DataTableWidget<Map<String, dynamic>>(
              data: _payments,
              loading: _paymentsLoading,
              emptyTitle: 'Chưa có giao dịch thanh toán nào',
              emptyDescription: 'Các phiếu thu và báo thanh toán từ cư dân sẽ hiển thị tại đây.',
              columns: [
                DataTableColumn(
                  key: 'payment_code',
                  label: 'Mã giao dịch',
                  width: 150,
                  render: (row) => Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Container(
                        padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                        decoration: BoxDecoration(
                          color: AppColors.slate100,
                          borderRadius: BorderRadius.circular(4),
                        ),
                        child: Text(
                          row['payment_code']?.toString() ?? '—',
                          style: const TextStyle(fontFamily: 'monospace', fontWeight: FontWeight.bold, fontSize: 12),
                        ),
                      ),
                      const SizedBox(height: 2),
                      Text(formatDateTime(row['paid_at']), style: const TextStyle(fontSize: 11, color: AppColors.textMuted)),
                    ],
                  ),
                ),
                DataTableColumn(
                  key: 'apartment_code',
                  label: 'Căn hộ / Cư dân',
                  width: 180,
                  render: (row) => Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        'Căn ${row['apartment_code'] ?? '—'} (${row['building_code'] ?? '—'})',
                        style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 13),
                      ),
                      Text(row['tenant_name']?.toString() ?? '—', style: const TextStyle(fontSize: 12, color: AppColors.textSecondary)),
                    ],
                  ),
                ),
                DataTableColumn(
                  key: 'invoice_code',
                  label: 'Hóa đơn',
                  width: 140,
                  render: (row) => Text(
                    row['invoice_code']?.toString() ?? 'Thu công nợ lẻ',
                    style: const TextStyle(fontFamily: 'monospace', fontSize: 12, color: AppColors.primary600, fontWeight: FontWeight.w600),
                  ),
                ),
                DataTableColumn(
                  key: 'method',
                  label: 'Phương thức',
                  width: 130,
                  render: (row) => Text(
                    kPaymentMethods[row['method']] ?? row['method']?.toString() ?? '—',
                    style: const TextStyle(fontSize: 12),
                  ),
                ),
                DataTableColumn(
                  key: 'amount',
                  label: 'Số tiền nộp',
                  width: 140,
                  align: TextAlign.right,
                  render: (row) {
                    final over = num.tryParse(row['overpayment_amount']?.toString() ?? '0') ?? 0;
                    return Column(
                      crossAxisAlignment: CrossAxisAlignment.end,
                      children: [
                        Text(
                          formatMoney(row['amount']),
                          style: const TextStyle(fontFamily: 'monospace', fontWeight: FontWeight.bold, color: AppColors.emerald600, fontSize: 13),
                        ),
                        if (over > 0)
                          Text('Thừa: ${formatMoney(over)}', style: const TextStyle(fontSize: 11, color: Colors.indigo)),
                      ],
                    );
                  },
                ),
                DataTableColumn(
                  key: 'status',
                  label: 'Trạng thái',
                  width: 140,
                  align: TextAlign.center,
                  render: (row) => StatusBadge(status: row['status']?.toString() ?? '', domain: StatusDomain.payment),
                ),
                DataTableColumn(
                  key: 'actions',
                  label: 'Thao tác',
                  width: 480,
                  align: TextAlign.center,
                  render: (row) {
                    final isPending = row['status'] == 'PENDING_CONFIRMATION';
                    return Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        AppButton(
                          text: 'Chi tiết',
                          icon: const Icon(LucideIcons.eye, size: 14),
                          size: AppButtonSize.sm,
                          variant: isPending ? AppButtonVariant.soft : AppButtonVariant.outline,
                          onPressed: () {
                            setState(() {
                              _reviewPayment = row;
                              _confirmNote = row['note']?.toString() ?? '';
                            });
                          },
                        ),
                        if (canManagePayments && isPending) ...[
                          const SizedBox(width: 6),
                          AppButton(
                            text: 'Xác nhận',
                            icon: const Icon(LucideIcons.check, size: 14),
                            size: AppButtonSize.sm,
                            variant: AppButtonVariant.success,
                            disabled: _processingAction,
                            onPressed: () => _handleConfirmPayment(row),
                          ),
                          const SizedBox(width: 6),
                          AppButton(
                            text: 'Từ chối',
                            icon: const Icon(LucideIcons.x, size: 14),
                            size: AppButtonSize.sm,
                            variant: AppButtonVariant.danger,
                            disabled: _processingAction,
                            onPressed: () {
                              setState(() {
                                _rejectPaymentTarget = row;
                                _rejectPaymentReason = '';
                              });
                            },
                          ),
                        ],
                      ],
                    );
                  },
                ),
              ],
            ),
          ],

          // TAB 2: AGING (5 Buckets)
          if (_activeTab == 'aging') ...[
            // 5 Buckets KPI Cards
            Row(
              children: [
                Expanded(
                  child: InkWell(
                    onTap: () => setState(() => _agingBucketFilter = _agingBucketFilter == 'current_not_due' ? '' : 'current_not_due'),
                    child: StatsCard(
                      title: 'Chưa đến hạn',
                      value: formatMoney(_agingSummary['current_not_due']),
                      subtext: 'Trong hạn chưa đến ngày đến hạn',
                      icon: LucideIcons.clock,
                      color: 'slate',
                    ),
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: InkWell(
                    onTap: () => setState(() => _agingBucketFilter = _agingBucketFilter == '0_15' ? '' : '0_15'),
                    child: StatsCard(
                      title: 'Tuổi nợ 0–15 ngày',
                      value: formatMoney(_agingSummary['bucket_0_15']),
                      subtext: 'Mới quá hạn 0–15 ngày (AC-016.1)',
                      icon: LucideIcons.clock,
                      color: 'emerald',
                    ),
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: InkWell(
                    onTap: () => setState(() => _agingBucketFilter = _agingBucketFilter == '16_30' ? '' : '16_30'),
                    child: StatsCard(
                      title: 'Tuổi nợ 16–30 ngày',
                      value: formatMoney(_agingSummary['bucket_16_30']),
                      subtext: 'Quá hạn 16–30 ngày (AC-016.1)',
                      icon: LucideIcons.triangleAlert,
                      color: 'amber',
                    ),
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: InkWell(
                    onTap: () => setState(() => _agingBucketFilter = _agingBucketFilter == '31_60' ? '' : '31_60'),
                    child: StatsCard(
                      title: 'Tuổi nợ 31–60 ngày',
                      value: formatMoney(_agingSummary['bucket_31_60']),
                      subtext: 'Quá hạn 31–60 ngày (AC-016.1)',
                      icon: LucideIcons.triangleAlert,
                      color: 'indigo',
                    ),
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: InkWell(
                    onTap: () => setState(() => _agingBucketFilter = _agingBucketFilter == 'over_60' ? '' : 'over_60'),
                    child: StatsCard(
                      title: 'Tuổi nợ > 60 ngày',
                      value: formatMoney(_agingSummary['bucket_over_60']),
                      subtext: 'Quá hạn nghiêm trọng >60 ngày',
                      icon: LucideIcons.triangleAlert,
                      color: 'rose',
                    ),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 16),

            // Filter bar
            AppCard(
              padding: const EdgeInsets.all(16),
              child: Row(
                children: [
                  Expanded(
                    child: SearchBarWidget(
                      placeholder: 'Tìm căn hộ, cư dân, mã hóa đơn...',
                      onChanged: (val) => setState(() => _recSearch = val),
                    ),
                  ),
                  const SizedBox(width: 12),
                  SizedBox(
                    width: 220,
                    child: AppSelect<String>(
                      placeholder: 'Tất cả nhóm tuổi nợ',
                      value: _agingBucketFilter.isEmpty ? null : _agingBucketFilter,
                      options: [
                        const AppSelectOption(value: '', label: 'Tất cả nhóm tuổi nợ (AC-016.1)'),
                        ...kAgingLabels.entries.map((e) => AppSelectOption(value: e.key, label: e.value.label)),
                      ],
                      onChanged: (val) => setState(() => _agingBucketFilter = val ?? ''),
                    ),
                  ),
                  const SizedBox(width: 12),
                  SizedBox(
                    width: 200,
                    child: AppSelect<String>(
                      value: _recStatusFilter,
                      options: const [
                        AppSelectOption(value: 'OPEN,PARTIALLY_PAID', label: 'Đang còn nợ'),
                        AppSelectOption(value: 'ALL', label: 'Tất cả khoản công nợ'),
                        AppSelectOption(value: 'PAID', label: 'Đã thu đủ'),
                        AppSelectOption(value: 'WRITTEN_OFF', label: 'Đã xóa nợ'),
                      ],
                      onChanged: (val) {
                        setState(() => _recStatusFilter = val ?? 'OPEN,PARTIALLY_PAID');
                        _fetchReceivables();
                      },
                    ),
                  ),
                  const SizedBox(width: 12),
                  AppButton(
                    text: 'Xuất CSV Aging',
                    icon: const Icon(LucideIcons.download, size: 14),
                    variant: AppButtonVariant.outline,
                    onPressed: () => _exportAgingCsv(filteredReceivables),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 16),

            // Receivables DataTable
            DataTableWidget<Map<String, dynamic>>(
              data: filteredReceivables,
              loading: _agingLoading,
              emptyTitle: 'Không có khoản công nợ quá hạn',
              emptyDescription: 'Tất cả các khoản phải thu hiện đang được thanh toán đúng hạn.',
              columns: [
                DataTableColumn(
                  key: 'apartment_code',
                  label: 'Căn hộ / Khách nợ',
                  width: 180,
                  render: (row) => Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        'Căn ${row['apartment_code'] ?? '—'} (${row['building_code'] ?? '—'})',
                        style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 13),
                      ),
                      Text(
                        '${row['tenant_name'] ?? '—'}${row['tenant_phone'] != null ? ' • ${row['tenant_phone']}' : ''}',
                        style: const TextStyle(fontSize: 12, color: AppColors.textSecondary),
                      ),
                    ],
                  ),
                ),
                DataTableColumn(
                  key: 'invoice_code',
                  label: 'Khoản công nợ',
                  width: 140,
                  render: (row) => Text(
                    row['invoice_code']?.toString() ?? 'Khoản công nợ',
                    style: const TextStyle(fontFamily: 'monospace', fontWeight: FontWeight.bold, color: AppColors.primary600, fontSize: 12),
                  ),
                ),
                DataTableColumn(
                  key: 'due_date',
                  label: 'Hạn thanh toán',
                  width: 140,
                  render: (row) {
                    final days = num.tryParse(row['days_overdue']?.toString() ?? '0') ?? 0;
                    return Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(formatDate(row['due_date']), style: const TextStyle(fontWeight: FontWeight.w500, fontSize: 12)),
                        Text(
                          days > 0 ? 'Quá hạn $days ngày' : 'Trong hạn',
                          style: TextStyle(fontSize: 11, fontWeight: FontWeight.bold, color: days > 0 ? AppColors.rose600 : AppColors.emerald600),
                        ),
                      ],
                    );
                  },
                ),
                DataTableColumn(
                  key: 'aging_bucket',
                  label: 'Nhóm tuổi nợ (AC-016.1)',
                  width: 180,
                  align: TextAlign.center,
                  render: (row) {
                    final bucketKey = resolvePrdAgingBucket(row['days_overdue']);
                    final meta = kAgingLabels[bucketKey] ?? kAgingLabels['current_not_due']!;
                    return AppBadge(label: meta.label, variant: meta.variant);
                  },
                ),
                DataTableColumn(
                  key: 'amount',
                  label: 'Gốc phải thu',
                  width: 140,
                  align: TextAlign.right,
                  render: (row) => Text(formatMoney(row['amount']), style: const TextStyle(fontFamily: 'monospace', fontSize: 12)),
                ),
                DataTableColumn(
                  key: 'balance',
                  label: 'Dư nợ',
                  width: 140,
                  align: TextAlign.right,
                  render: (row) => Text(
                    formatMoney(row['balance']),
                    style: const TextStyle(fontFamily: 'monospace', fontWeight: FontWeight.bold, color: AppColors.rose600, fontSize: 13),
                  ),
                ),
                DataTableColumn(
                  key: 'status',
                  label: 'Trạng thái',
                  width: 160,
                  align: TextAlign.center,
                  render: (row) => StatusBadge(status: row['status']?.toString() ?? '', domain: StatusDomain.receivable),
                ),
                DataTableColumn(
                  key: 'actions',
                  label: 'Thao tác',
                  width: 160,
                  align: TextAlign.center,
                  render: (row) {
                    if (canManagePayments && ['OPEN', 'PARTIALLY_PAID'].contains(row['status'])) {
                      return AppButton(
                        text: 'Thu nợ',
                        icon: const Icon(LucideIcons.wallet, size: 14),
                        size: AppButtonSize.sm,
                        variant: AppButtonVariant.soft,
                        onPressed: () => _openCreateModal(row),
                      );
                    }
                    return const SizedBox();
                  },
                ),
              ],
            ),
          ],

          // TAB 3: CREDITS & 4-EYES REFUNDS
          if (_activeTab == 'credits') ...[
            Row(
              children: [
                Expanded(
                  child: StatsCard(
                    title: 'Tổng số dư tín dụng',
                    value: formatMoney(_credits.fold<num>(0, (s, c) => s + (num.tryParse(c['amount']?.toString() ?? '0') ?? 0))),
                    subtext: '${_credits.length} khoản nộp thừa / giảm trừ',
                    icon: LucideIcons.sparkles,
                    color: 'indigo',
                  ),
                ),
                const SizedBox(width: 16),
                Expanded(
                  child: StatsCard(
                    title: 'Khả dụng (Chờ cấn trừ kỳ sau)',
                    value: formatMoney(_credits.where((c) => ['AVAILABLE', 'PARTIALLY_APPLIED'].contains(c['status'])).fold<num>(
                          0,
                          (s, c) {
                            final total = num.tryParse(c['amount']?.toString() ?? '0') ?? 0;
                            final applied = num.tryParse(c['applied_amount']?.toString() ?? '0') ?? 0;
                            return s + (total - applied > 0 ? total - applied : 0);
                          },
                        )),
                    subtext: 'Tự động bù trừ khi sinh hóa đơn DRAFT kỳ kế tiếp',
                    icon: LucideIcons.circleCheck,
                    color: 'emerald',
                  ),
                ),
                const SizedBox(width: 16),
                Expanded(
                  child: StatsCard(
                    title: 'Đề nghị hoàn tiền chờ duyệt',
                    value: '$pendingRefundsCount',
                    subtext: 'Quy trình 4 mắt: Cần OWNER/MANAGER thứ 2 phê duyệt',
                    icon: LucideIcons.triangleAlert,
                    color: 'amber',
                  ),
                ),
              ],
            ),
            const SizedBox(height: 16),

            // Credits Filters
            AppCard(
              padding: const EdgeInsets.all(16),
              child: Row(
                children: [
                  Expanded(
                    child: SearchBarWidget(
                      placeholder: 'Tìm căn hộ, khách thuê, lý do ghi nhận tín dụng...',
                      onChanged: (val) => setState(() => _creditSearch = val),
                    ),
                  ),
                  const SizedBox(width: 12),
                  SizedBox(
                    width: 240,
                    child: AppSelect<String>(
                      placeholder: 'Tất cả trạng thái tín dụng',
                      value: _creditStatusFilter.isEmpty ? null : _creditStatusFilter,
                      options: const [
                        AppSelectOption(value: '', label: 'Tất cả trạng thái'),
                        AppSelectOption(value: 'AVAILABLE', label: 'Khả dụng'),
                        AppSelectOption(value: 'PARTIALLY_APPLIED', label: 'Đã dùng một phần'),
                        AppSelectOption(value: 'APPLIED', label: 'Đã cấn trừ đủ'),
                        AppSelectOption(value: 'PENDING_DIRECT_REFUND', label: 'Chờ duyệt hoàn tiền (4 mắt)'),
                        AppSelectOption(value: 'REFUNDED_DIRECT', label: 'Đã hoàn tiền trực tiếp'),
                      ],
                      onChanged: (val) {
                        setState(() => _creditStatusFilter = val ?? '');
                        _fetchCredits();
                      },
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 16),

            // Credits DataTable
            DataTableWidget<Map<String, dynamic>>(
              data: filteredCredits,
              loading: _creditsLoading,
              emptyTitle: 'Chưa có khoản tín dụng nào',
              emptyDescription: 'Các khoản cư dân thanh toán thừa hoặc được giảm trừ sau thanh lý dịch vụ sẽ tự động ghi nhận vào sổ tín dụng.',
              columns: [
                DataTableColumn(
                  key: 'apartment_code',
                  label: 'Căn hộ / Khách thuê',
                  width: 180,
                  render: (row) => Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text('Căn ${row['apartment_code'] ?? '—'} (${row['building_code'] ?? '—'})', style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 13)),
                      Text(row['tenant_name']?.toString() ?? '—', style: const TextStyle(fontSize: 12, color: AppColors.textSecondary)),
                    ],
                  ),
                ),
                DataTableColumn(
                  key: 'amount',
                  label: 'Số tiền tín dụng',
                  width: 140,
                  align: TextAlign.right,
                  render: (row) => Text(formatMoney(row['amount']), style: const TextStyle(fontFamily: 'monospace', fontWeight: FontWeight.bold, fontSize: 13)),
                ),
                DataTableColumn(
                  key: 'applied_amount',
                  label: 'Đã cấn trừ',
                  width: 120,
                  align: TextAlign.right,
                  render: (row) => Text(formatMoney(row['applied_amount'] ?? 0), style: const TextStyle(fontFamily: 'monospace', color: AppColors.textMuted, fontSize: 12)),
                ),
                DataTableColumn(
                  key: 'available_balance',
                  label: 'Còn khả dụng',
                  width: 130,
                  align: TextAlign.right,
                  render: (row) {
                    final total = num.tryParse(row['amount']?.toString() ?? '0') ?? 0;
                    final applied = num.tryParse(row['applied_amount']?.toString() ?? '0') ?? 0;
                    final avail = total - applied > 0 ? total - applied : 0;
                    return Text(formatMoney(avail), style: const TextStyle(fontFamily: 'monospace', fontWeight: FontWeight.bold, color: AppColors.emerald600, fontSize: 13));
                  },
                ),
                DataTableColumn(
                  key: 'status',
                  label: 'Trạng thái',
                  width: 200,
                  align: TextAlign.center,
                  render: (row) => StatusBadge(status: row['status']?.toString() ?? '', domain: StatusDomain.creditBalance),
                ),
                DataTableColumn(
                  key: 'description',
                  label: 'Diễn giải / Lý do',
                  width: 240,
                  render: (row) => Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(row['description']?.toString() ?? '—', style: const TextStyle(fontSize: 12)),
                      if (row['rejection_reason'] != null)
                        Text('Lý do từ chối: ${row['rejection_reason']}', style: const TextStyle(fontSize: 11, color: AppColors.rose600)),
                    ],
                  ),
                ),
                DataTableColumn(
                  key: 'actions',
                  label: 'Thao tác (4 mắt)',
                  width: 340,
                  align: TextAlign.center,
                  render: (row) {
                    final total = num.tryParse(row['amount']?.toString() ?? '0') ?? 0;
                    final applied = num.tryParse(row['applied_amount']?.toString() ?? '0') ?? 0;
                    final avail = total - applied > 0 ? total - applied : 0;

                    if (row['status'] == 'PENDING_DIRECT_REFUND') {
                      final canApprove = canActorApproveCreditRefund(
                            actor: user,
                            record: row,
                            buildingHasActiveOwner: true,
                          ) &&
                          canApproveCreditRefunds;

                      if (canApprove) {
                        return Row(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            AppButton(
                              text: 'Duyệt',
                              icon: const Icon(LucideIcons.circleCheck, size: 14),
                              size: AppButtonSize.sm,
                              variant: AppButtonVariant.success,
                              loading: _processingAction,
                              onPressed: () => _handleApproveCreditRefund(row),
                            ),
                            const SizedBox(width: 6),
                            AppButton(
                              text: 'Từ chối',
                              size: AppButtonSize.sm,
                              variant: AppButtonVariant.danger,
                              loading: _processingAction,
                              onPressed: () {
                                setState(() {
                                  _rejectCreditTarget = row;
                                  _rejectCreditReason = '';
                                });
                              },
                            ),
                          ],
                        );
                      } else {
                        return const AppBadge(label: 'Chờ người khác duyệt (4 mắt)', variant: AppBadgeVariant.amber);
                      }
                    }

                    if (['AVAILABLE', 'PARTIALLY_APPLIED'].contains(row['status']) && canManagePayments && avail > 0) {
                      return AppButton(
                        text: 'Đề nghị hoàn tiền',
                        icon: const Icon(LucideIcons.trendingUp, size: 14),
                        size: AppButtonSize.sm,
                        variant: AppButtonVariant.outline,
                        onPressed: () {
                          setState(() {
                            _refundRequestTarget = row;
                            _refundAmount = avail.toString();
                            _refundReason = '';
                            _refundBankInfo = '';
                            _refundProofImage = '';
                          });
                        },
                      );
                    }

                    return const SizedBox();
                  },
                ),
              ],
            ),
          ],

          // TAB 4: OVERPAYMENTS
          if (_activeTab == 'overpayments') ...[
            Row(
              children: [
                Expanded(
                  child: StatsCard(
                    title: 'Số giao dịch nộp thừa',
                    value: '${_overpayments.length}',
                    subtext: 'Phát sinh khi khách chuyển khoản vượt số dư nợ hóa đơn',
                    icon: LucideIcons.circleCheck,
                    color: 'indigo',
                  ),
                ),
                const SizedBox(width: 16),
                Expanded(
                  child: StatsCard(
                    title: 'Tổng giá trị thanh toán thừa',
                    value: formatMoney(totalOverpaymentSum),
                    subtext: 'Theo dõi để khấu trừ vào hóa đơn kỳ kế tiếp',
                    icon: LucideIcons.trendingUp,
                    color: 'emerald',
                  ),
                ),
              ],
            ),
            const SizedBox(height: 16),

            DataTableWidget<Map<String, dynamic>>(
              data: _overpayments,
              loading: _overLoading,
              emptyTitle: 'Chưa có khoản thanh toán thừa nào',
              emptyDescription: 'Các giao dịch có số tiền chuyển vượt quá dư nợ hóa đơn sẽ tự động liệt kê tại đây.',
              columns: [
                DataTableColumn(
                  key: 'payment_code',
                  label: 'Mã giao dịch',
                  width: 150,
                  render: (row) => Text(row['payment_code']?.toString() ?? '—', style: const TextStyle(fontFamily: 'monospace', fontWeight: FontWeight.bold, fontSize: 12)),
                ),
                DataTableColumn(
                  key: 'apartment_code',
                  label: 'Căn hộ / Cư dân',
                  width: 180,
                  render: (row) => Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text('Căn ${row['apartment_code'] ?? '—'} (${row['building_code'] ?? '—'})', style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 13)),
                      Text(row['tenant_name']?.toString() ?? '—', style: const TextStyle(fontSize: 12, color: AppColors.textSecondary)),
                    ],
                  ),
                ),
                DataTableColumn(
                  key: 'invoice_code',
                  label: 'Hóa đơn gốc',
                  width: 140,
                  render: (row) => Text(row['invoice_code']?.toString() ?? '—', style: const TextStyle(fontFamily: 'monospace', color: AppColors.primary600, fontSize: 12)),
                ),
                DataTableColumn(
                  key: 'amount',
                  label: 'Tổng tiền nộp',
                  width: 130,
                  align: TextAlign.right,
                  render: (row) => Text(formatMoney(row['amount']), style: const TextStyle(fontFamily: 'monospace', fontSize: 12)),
                ),
                DataTableColumn(
                  key: 'overpayment_amount',
                  label: 'Số tiền nộp thừa',
                  width: 150,
                  align: TextAlign.right,
                  render: (row) => Text(
                    formatMoney(row['overpayment_amount']),
                    style: const TextStyle(fontFamily: 'monospace', fontWeight: FontWeight.bold, color: Colors.indigo, fontSize: 13),
                  ),
                ),
                DataTableColumn(
                  key: 'paid_at',
                  label: 'Thời gian xác nhận',
                  width: 160,
                  align: TextAlign.center,
                  render: (row) => Column(
                    children: [
                      Text(formatDateTime(row['paid_at']), style: const TextStyle(fontSize: 11)),
                      Text('Bởi: ${row['confirmed_by_name'] ?? 'Kế toán'}', style: const TextStyle(fontSize: 11, color: AppColors.textMuted)),
                    ],
                  ),
                ),
              ],
            ),
          ],
        ],
      ),
    ),

      // Modal: Record Payment
      if (_createOpen)
        _buildModalOverlay(
          maxWidth: 620,
          child: AppModal(
              title: 'Ghi nhận phiếu thu / Thanh toán mới',
              subtitle: 'Tự động gạch nợ hóa đơn tương ứng và tính toán tiền thừa (nếu có).',
              onClose: () => setState(() => _createOpen = false),
              footer: Row(
                mainAxisAlignment: MainAxisAlignment.end,
                children: [
                  AppButton(
                    text: 'Hủy',
                    variant: AppButtonVariant.outline,
                    onPressed: () => setState(() => _createOpen = false),
                  ),
                  const SizedBox(width: 8),
                  AppButton(
                    text: 'Xác nhận ghi nhận',
                    variant: AppButtonVariant.primary,
                    loading: _creating,
                    onPressed: _handleCreatePayment,
                  ),
                ],
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  AppSelect<String>(
                    label: 'Chọn hóa đơn chưa thu *',
                    value: _createInvoiceId.isEmpty ? null : _createInvoiceId,
                    options: _openInvoices.map((inv) {
                      final total = num.tryParse(inv['total_amount']?.toString() ?? '0') ?? 0;
                      final paid = num.tryParse(inv['paid_amount']?.toString() ?? '0') ?? 0;
                      final rem = total - paid > 0 ? total - paid : 0;
                      return AppSelectOption(
                        value: inv['id'].toString(),
                        label: '${inv['invoice_code']} — Căn ${inv['apartment_code']} (${inv['tenant_name'] ?? 'Cư dân'}) • Còn nợ: ${formatMoney(rem)}',
                      );
                    }).toList(),
                    onChanged: (val) {
                      final found = _openInvoices.firstWhere((i) => i['id']?.toString() == val, orElse: () => const {});
                      if (found.isNotEmpty) {
                        final total = num.tryParse(found['total_amount']?.toString() ?? '0') ?? 0;
                        final paid = num.tryParse(found['paid_amount']?.toString() ?? '0') ?? 0;
                        final rem = total - paid > 0 ? total - paid : 0;
                        setState(() {
                          _createInvoiceId = val ?? '';
                          _createAmount = rem.toString();
                        });
                      } else {
                        setState(() => _createInvoiceId = val ?? '');
                      }
                    },
                  ),
                  const SizedBox(height: 12),
                  Row(
                    children: [
                      Expanded(
                        child: MoneyInput(
                          label: 'Số tiền thực nhận (VNĐ) *',
                          value: _createAmount,
                          onChanged: (val) => setState(() => _createAmount = val),
                        ),
                      ),
                      const SizedBox(width: 12),
                      Expanded(
                        child: AppSelect<String>(
                          label: 'Phương thức thanh toán *',
                          value: _createMethod,
                          options: kPaymentMethodSelectOptions,
                          onChanged: (val) => setState(() => _createMethod = val ?? 'BANK_TRANSFER'),
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 12),
                  AppInput(
                    label: 'Mã tham chiếu giao dịch / Ủy nhiệm chi',
                    placeholder: 'VD: VCB98237492...',
                    initialValue: _createRefCode,
                    onChanged: (val) => setState(() => _createRefCode = val),
                  ),
                  const SizedBox(height: 12),
                  AppInput(
                    label: 'Ghi chú kế toán',
                    placeholder: 'Ghi chú nội dung chuyển khoản...',
                    initialValue: _createNote,
                    onChanged: (val) => setState(() => _createNote = val),
                  ),
                  const SizedBox(height: 12),
                  FileUploadField(
                    label: 'Ảnh chụp biên lai / Sao kê đối chiếu',
                    value: _createProofImage.isNotEmpty ? [_createProofImage] : [],
                    onChanged: (urls) => setState(() => _createProofImage = urls.isNotEmpty ? urls.first : ''),
                  ),
                ],
              ),
            ),
          ),

      // Modal: Review Payment & Proof Images
      if (_reviewPayment != null)
        _buildModalOverlay(
          maxWidth: 680,
          child: AppModal(
              title: 'Đối soát chứng từ #${_reviewPayment!['payment_code']}',
              subtitle: 'Căn ${_reviewPayment!['apartment_code'] ?? '—'} • Số tiền báo nộp: ${formatMoney(_reviewPayment!['amount'])}',
              onClose: () => setState(() => _reviewPayment = null),
              footer: _reviewPayment!['status'] == 'PENDING_CONFIRMATION' && canManagePayments
                  ? Row(
                      mainAxisAlignment: MainAxisAlignment.end,
                      children: [
                        AppButton(
                          text: 'Từ chối chứng từ',
                          variant: AppButtonVariant.danger,
                          disabled: _processingAction,
                          onPressed: () {
                            setState(() {
                              _rejectPaymentTarget = _reviewPayment;
                              _rejectPaymentReason = '';
                            });
                          },
                        ),
                        const SizedBox(width: 8),
                        AppButton(
                          text: 'Đối soát xác nhận hợp lệ',
                          icon: const Icon(LucideIcons.check, size: 14),
                          variant: AppButtonVariant.success,
                          loading: _processingAction,
                          onPressed: () => _handleConfirmPayment(_reviewPayment!, _confirmNote),
                        ),
                      ],
                    )
                  : AppButton(
                      text: 'Đóng',
                      variant: AppButtonVariant.outline,
                      onPressed: () => setState(() => _reviewPayment = null),
                    ),
              child: Builder(builder: (context) {
                final proofImages = _reviewPayment!['proof_images'] is List ? _reviewPayment!['proof_images'] as List : [];
                return Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    if (proofImages.isNotEmpty) ...[
                      const Text('Ảnh chụp chứng từ chuyển khoản:', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 13)),
                      const SizedBox(height: 8),
                      SizedBox(
                        height: 220,
                        child: ListView.separated(
                          scrollDirection: Axis.horizontal,
                          itemCount: proofImages.length,
                          separatorBuilder: (_, __) => const SizedBox(width: 8),
                          itemBuilder: (context, idx) {
                            return Container(
                              width: 220,
                              decoration: BoxDecoration(
                                borderRadius: BorderRadius.circular(8),
                                border: Border.all(color: AppColors.slate200),
                              ),
                              clipBehavior: Clip.antiAlias,
                              child: AuthImage(src: proofImages[idx]?.toString()),
                            );
                          },
                        ),
                      ),
                      const SizedBox(height: 12),
                    ],
                    if (_reviewPayment!['status'] == 'PENDING_CONFIRMATION' && canManagePayments)
                      AppInput(
                        label: 'Ghi chú xác nhận đối soát (tùy chọn)',
                        placeholder: 'VD: Đã khớp sao kê Vietcombank ngày hôm nay...',
                        initialValue: _confirmNote,
                        onChanged: (val) => setState(() => _confirmNote = val),
                      ),
                  ],
                );
              }),
            ),
          ),

      // Modal: Reject Payment
      if (_rejectPaymentTarget != null)
        _buildModalOverlay(
          child: AppModal(
              title: 'Từ chối chứng từ thanh toán',
              subtitle: 'Giao dịch #${_rejectPaymentTarget!['payment_code']} — Cư dân sẽ nhận được thông báo lý do từ chối.',
              onClose: () => setState(() => _rejectPaymentTarget = null),
              footer: Row(
                mainAxisAlignment: MainAxisAlignment.end,
                children: [
                  AppButton(
                    text: 'Hủy',
                    variant: AppButtonVariant.outline,
                    onPressed: () => setState(() => _rejectPaymentTarget = null),
                  ),
                  const SizedBox(width: 8),
                  AppButton(
                    text: 'Xác nhận từ chối',
                    variant: AppButtonVariant.danger,
                    loading: _processingAction,
                    onPressed: _handleRejectPayment,
                  ),
                ],
              ),
              child: AppInput(
                label: 'Lý do từ chối chứng từ *',
                placeholder: 'VD: Ảnh chụp mờ không rõ mã giao dịch / Chưa nhận được tiền trên sao kê...',
                multiline: true,
                rows: 3,
                initialValue: _rejectPaymentReason,
                onChanged: (val) => setState(() => _rejectPaymentReason = val),
              ),
            ),
          ),

      // Modal: Request Credit Refund
      if (_refundRequestTarget != null)
        _buildModalOverlay(
          maxWidth: 620,
          child: AppModal(
              title: 'Lập đề nghị hoàn tiền từ Sổ tín dụng',
              subtitle: 'Căn ${_refundRequestTarget!['apartment_code'] ?? '—'} • Khách: ${_refundRequestTarget!['tenant_name'] ?? '—'}',
              onClose: () => setState(() => _refundRequestTarget = null),
              footer: Row(
                mainAxisAlignment: MainAxisAlignment.end,
                children: [
                  AppButton(
                    text: 'Hủy',
                    variant: AppButtonVariant.outline,
                    onPressed: () => setState(() => _refundRequestTarget = null),
                  ),
                  const SizedBox(width: 8),
                  AppButton(
                    text: 'Gửi đề nghị hoàn tiền',
                    variant: AppButtonVariant.primary,
                    loading: _processingAction,
                    onPressed: _handleRequestCreditRefund,
                  ),
                ],
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  MoneyInput(
                    label: 'Số tiền cần hoàn trả (₫) *',
                    value: _refundAmount,
                    onChanged: (val) => setState(() => _refundAmount = val),
                  ),
                  const SizedBox(height: 12),
                  BankSelect(
                    label: 'Ngân hàng nhận tiền',
                    value: _refundBankInfo,
                    onChanged: (val) => setState(() => _refundBankInfo = val ?? ''),
                  ),
                  const SizedBox(height: 12),
                  AppInput(
                    label: 'Lý do hoàn tiền bắt buộc *',
                    placeholder: 'VD: Khách thuê đã chấm dứt hợp đồng và thanh lý hết công nợ...',
                    multiline: true,
                    rows: 3,
                    initialValue: _refundReason,
                    onChanged: (val) => setState(() => _refundReason = val),
                  ),
                  const SizedBox(height: 12),
                  FileUploadField(
                    label: 'Ảnh chứng từ đối soát / Đơn đề nghị hoàn tiền (tùy chọn)',
                    value: _refundProofImage.isNotEmpty ? [_refundProofImage] : [],
                    onChanged: (urls) => setState(() => _refundProofImage = urls.isNotEmpty ? urls.first : ''),
                  ),
                ],
              ),
            ),
          ),

      // Modal: Reject Credit Refund
      if (_rejectCreditTarget != null)
        _buildModalOverlay(
          child: AppModal(
              title: 'Từ chối đề nghị hoàn tiền tín dụng',
              onClose: () => setState(() => _rejectCreditTarget = null),
              footer: Row(
                mainAxisAlignment: MainAxisAlignment.end,
                children: [
                  AppButton(
                    text: 'Hủy',
                    variant: AppButtonVariant.outline,
                    onPressed: () => setState(() => _rejectCreditTarget = null),
                  ),
                  const SizedBox(width: 8),
                  AppButton(
                    text: 'Xác nhận từ chối',
                    variant: AppButtonVariant.danger,
                    loading: _processingAction,
                    onPressed: _handleRejectCreditRefund,
                  ),
                ],
              ),
              child: AppInput(
                label: 'Lý do từ chối *',
                placeholder: 'VD: Thông tin số tài khoản nhận tiền chưa khớp hợp đồng...',
                multiline: true,
                rows: 3,
                initialValue: _rejectCreditReason,
                onChanged: (val) => setState(() => _rejectCreditReason = val),
              ),
            ),
          ),
      ],
    );
  }
}
