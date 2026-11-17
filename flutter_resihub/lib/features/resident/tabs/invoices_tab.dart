import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../../../core/constants/statuses.dart';
import '../../../core/theme/app_colors.dart';
import '../../../core/utils/billing_helpers.dart';
import '../../../core/utils/format.dart';
import '../../../core/utils/validation.dart';
import '../../../core/utils/vietqr_banks.dart';
import '../../../features/buildings/services/buildings_service.dart';
import '../../../features/users/services/users_service.dart';
import '../../../shared/providers/toast_provider.dart';
import '../../../shared/widgets/common/status_badge.dart';
import '../../../shared/widgets/ui/app_badge.dart';
import '../../../shared/widgets/ui/app_button.dart';
import '../../../shared/widgets/ui/app_input.dart';
import '../../../shared/widgets/ui/app_modal.dart';
import '../../../shared/widgets/ui/app_select.dart';
import '../../../shared/widgets/ui/auth_media_viewer.dart';
import '../../../shared/widgets/ui/file_upload_field.dart';
import '../../../shared/widgets/ui/money_input.dart';
import '../services/resident_service.dart';

const _paymentMethods = <String, String>{
  'BANK_TRANSFER': 'Chuyển khoản',
  'QR_CODE': 'QR Code',
  'E_WALLET': 'Ví điện tử',
  'CASH': 'Tiền mặt',
  'CARD': 'Thẻ',
  'OTHER': 'Khác',
};

/// Promise.allSettled equivalent used for the payment-account lookups.
Future<Map<String, dynamic>> _settled(Future<dynamic> future) async {
  try {
    return {'ok': true, 'value': await future};
  } catch (e) {
    return {'ok': false, 'error': e};
  }
}

/// Payment account priority (mirrors InvoicesTab.jsx:203-235):
/// building -> settings -> overview -> corporate default.
Map<String, dynamic> resolveResidentPaymentAccountFromSources({
  dynamic buildingAccount,
  dynamic settingsAccount,
  dynamic overviewAccount,
}) {
  for (final raw in [buildingAccount, settingsAccount, overviewAccount]) {
    if (raw is Map && raw.isNotEmpty) return normalizeResidentPaymentAccount(raw);
  }
  return normalizeResidentPaymentAccount(null);
}

dynamic _extractBuildingAccount(dynamic res, String? targetBuildingId) {
  final data = res is Map ? res['data'] : res;
  if (data is! List || data.isEmpty) return null;
  Map? matched;
  if (targetBuildingId != null && targetBuildingId.isNotEmpty) {
    for (final b in data) {
      if (b is Map && b['id']?.toString() == targetBuildingId) {
        matched = b;
        break;
      }
    }
  }
  matched ??= data.first is Map ? data.first as Map : null;
  if (matched == null) return null;
  final lease = matched['lease_terms'];
  return matched['payment_account'] ??
      (lease is Map ? lease['payment_account'] : null);
}

dynamic _extractSettingsAccount(dynamic res) {
  final data = res is Map ? res['data'] : res;
  if (data is! Map) return null;
  final billing = data['billing_config'];
  return data['payment_account'] ??
      (billing is Map ? billing['payment_account'] : null);
}

/// Normalizes a raw payment account into the shape used by the transfer UI.
Map<String, dynamic> normalizeResidentPaymentAccount(dynamic raw) {
  if (raw is! Map) {
    return {
      'bank': 'Vietcombank',
      'bank_code': 'VCB',
      'bank_bin': '970436',
      'account_no': '99988877766',
      'account_name': 'RESIHUB CORP',
      'branch': 'Chi nhánh Hội Sở',
    };
  }
  final map = Map<String, dynamic>.from(raw);
  final bank = (map['bank'] ?? map['bank_name'] ?? map['bankName'] ?? 'Vietcombank').toString();
  final bankCode = (map['bank_code'] ?? map['bankCode'] ?? '').toString();
  final bankBin = (map['bank_bin'] ?? map['bankBin'] ?? map['bin'] ?? '').toString();
  final accountNo = (map['account_no'] ?? map['account_number'] ?? map['accountNo'] ?? '99988877766').toString();
  final accountName = (map['account_name'] ?? map['account_holder'] ?? map['holder_name'] ?? 'RESIHUB CORP').toString();
  final branch = (map['branch'] ?? '').toString();

  final matched = matchVietQrBank(kFallbackVietQrBanks, {
    'bank_name': bank,
    'bank_code': bankCode,
    'bank_bin': bankBin,
  });

  return {
    'bank': bank,
    'bank_code': bankCode.isNotEmpty ? bankCode : (matched?['code']?.toString() ?? ''),
    'bank_bin': bankBin.isNotEmpty ? bankBin : (matched?['bin']?.toString() ?? '970436'),
    'bank_logo': matched?['logo']?.toString() ?? '',
    'account_no': accountNo,
    'account_name': accountName,
    'branch': branch,
  };
}

class InvoicesTab extends ConsumerStatefulWidget {
  final Map<String, dynamic>? overview;
  final Future<void> Function() onRefreshOverview;
  final void Function(String tab, [Map<String, dynamic>? extra]) onNavigateTab;
  final String? invoiceIdParam;
  final String? creditIdParam;
  final String? modalParam;

  const InvoicesTab({
    super.key,
    required this.overview,
    required this.onRefreshOverview,
    required this.onNavigateTab,
    this.invoiceIdParam,
    this.creditIdParam,
    this.modalParam,
  });

  @override
  ConsumerState<InvoicesTab> createState() => _InvoicesTabState();
}

class _InvoicesTabState extends ConsumerState<InvoicesTab> {
  bool _loading = false;
  bool _deepLinkApplied = false;
  List<dynamic> _invoices = [];
  List<dynamic> _creditBalances = [];
  late Map<String, dynamic> _paymentAccount;
  String _filterTab = 'all';

  @override
  void initState() {
    super.initState();
    _paymentAccount = _resolvePaymentAccount();
    _fetchInvoices();
  }

  @override
  void didUpdateWidget(covariant InvoicesTab oldWidget) {
    super.didUpdateWidget(oldWidget);
    final oldCid = oldWidget.overview?['active_contract']?['contract_id'];
    final newCid = widget.overview?['active_contract']?['contract_id'];
    if (oldCid != newCid || oldWidget.overview != widget.overview) {
      _paymentAccount = _resolvePaymentAccount();
      _fetchInvoices();
    }
  }

  String? get _contractId {
    final c = widget.overview?['active_contract'] ?? widget.overview?['contract'];
    return c?['contract_id']?.toString() ?? c?['id']?.toString();
  }

  Map<String, dynamic> _resolvePaymentAccount() {
    final raw = widget.overview?['payment_account'] ??
        widget.overview?['active_contract']?['payment_account'] ??
        widget.overview?['contract']?['payment_account'];
    return normalizeResidentPaymentAccount(raw);
  }

  /// Mirrors React: fetch buildings + settings alongside invoices and resolve
  /// the payment account with priority building -> settings -> overview.
  Map<String, dynamic> _resolvePaymentAccountWithSources(
    Map<String, dynamic> bldgRes,
    Map<String, dynamic> settingsRes,
    List<dynamic> loadedInvoices,
  ) {
    final contract = widget.overview?['active_contract'] ??
        widget.overview?['contract'];
    final history = widget.overview?['contract_history'];
    final targetBuildingId = contract is Map
        ? contract['building_id']?.toString()
        : null;
    final firstInvoiceBuilding = loadedInvoices.isNotEmpty &&
            loadedInvoices.first is Map
        ? (loadedInvoices.first as Map)['building_id']?.toString()
        : null;
    final historyBuilding = history is List &&
            history.isNotEmpty &&
            history.first is Map
        ? (history.first as Map)['building_id']?.toString()
        : null;
    final buildingId = (targetBuildingId?.isNotEmpty == true
            ? targetBuildingId
            : firstInvoiceBuilding?.isNotEmpty == true
                ? firstInvoiceBuilding
                : historyBuilding) ??
        '';

    final buildingAccount = bldgRes['ok'] == true
        ? _extractBuildingAccount(bldgRes['value'], buildingId)
        : null;
    final settingsAccount = settingsRes['ok'] == true
        ? _extractSettingsAccount(settingsRes['value'])
        : null;
    final overviewAccount = widget.overview?['payment_account'] ??
        (contract is Map ? contract['payment_account'] : null);

    return resolveResidentPaymentAccountFromSources(
      buildingAccount: buildingAccount,
      settingsAccount: settingsAccount,
      overviewAccount: overviewAccount,
    );
  }

  Future<void> _fetchInvoices() async {
    setState(() => _loading = true);
    try {
      final results = await Future.wait([
        _settled(ref.read(residentServiceProvider).listInvoices(_contractId)),
        _settled(ref.read(buildingsServiceProvider).list()),
        _settled(ref.read(usersServiceProvider).getSettings()),
      ]);
      final invRes = results[0];
      final res = invRes['ok'] == true ? invRes['value'] : null;
      List<dynamic> list = [];
      List<dynamic> credits = [];
      if (res is Map) {
        if (res['data'] is List) list = res['data'] as List;
        if (res['credit_balances'] is List) {
          credits = res['credit_balances'] as List;
        } else if (res['credits'] is List) {
          credits = res['credits'] as List;
        } else if (res['credit_transactions'] is List) {
          credits = res['credit_transactions'] as List;
        }
      } else if (res is List) {
        list = res;
      }

      if (credits.isEmpty && widget.overview != null) {
        if (widget.overview!['credit_balances'] is List) {
          credits = widget.overview!['credit_balances'] as List;
        } else if (widget.overview!['credits'] is List) {
          credits = widget.overview!['credits'] as List;
        } else if (widget.overview!['credit_transactions'] is List) {
          credits = widget.overview!['credit_transactions'] as List;
        }
      }

      _paymentAccount = _resolvePaymentAccountWithSources(
        results[1],
        results[2],
        list,
      );

      if (mounted) {
        setState(() {
          _invoices = list;
          _creditBalances = credits;
          _loading = false;
        });
        _applyDeepLink();
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

  /// Deep-link ?invoice_id= | ?credit_id= | ?modal=pay — parity InvoicesTab.jsx:291-367.
  void _applyDeepLink() {
    final modal = widget.modalParam;
    final invoiceId = widget.invoiceIdParam;
    final creditId = widget.creditIdParam;
    if (_deepLinkApplied ||
        (modal == null &&
            (invoiceId == null || invoiceId.isEmpty) &&
            (creditId == null || creditId.isEmpty))) {
      return;
    }
    _deepLinkApplied = true;
    if (!mounted) return;
    final context = this.context;

    if (modal == 'credit' || (creditId != null && creditId.isNotEmpty)) {
      Map<String, dynamic>? matched;
      for (final c in _creditBalances) {
        if (c is Map && (c['id'] ?? c['credit_id'])?.toString() == creditId) {
          matched = Map<String, dynamic>.from(c);
          break;
        }
      }
      if (matched == null) {
        ref.read(toastProvider.notifier).info(
            'Bản ghi liên quan không còn tồn tại hoặc đã thay đổi trạng thái.');
        return;
      }
      _openCreditDetailModal(context, matched);
      return;
    }

    Map<String, dynamic>? matched;
    for (final inv in _invoices) {
      if (inv is Map && (inv['invoice_id'] ?? inv['id'])?.toString() == invoiceId) {
        matched = Map<String, dynamic>.from(inv);
        break;
      }
    }
    if (matched == null && modal == 'pay' && _unpaidInvoices.isNotEmpty) {
      final first = _unpaidInvoices.first;
      if (first is Map) matched = Map<String, dynamic>.from(first);
    }
    if (matched == null) {
      ref.read(toastProvider.notifier).info(
          'Bản ghi liên quan không còn tồn tại hoặc đã thay đổi trạng thái.');
      return;
    }
    setState(() => _filterTab = 'all');
    if (modal == 'pay' && _unpaidInvoices.any((u) =>
        (u is Map ? (u['invoice_id'] ?? u['id'])?.toString() : null) ==
        invoiceId)) {
      _openPaymentReportModal(context, matched);
    } else {
      _openInvoiceDetailModal(context, matched);
    }
  }

  void _openInvoiceDetailModal(BuildContext context, Map<String, dynamic> inv) {
    final code = inv['invoice_code']?.toString() ??
        inv['invoice_id']?.toString() ??
        inv['id']?.toString() ??
        '';
    final summary = resolveResidentInvoiceTotalsSummary(inv);
    AppModal.show(
      context: context,
      title: 'Chi tiết hóa đơn',
      subtitle: 'Mã hóa đơn: $code',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        mainAxisSize: MainAxisSize.min,
        children: [
          Text('Tổng tiền: ${formatMoney(summary.totalAmount)}'),
          const SizedBox(height: 8),
          Text('Đã thanh toán: ${formatMoney(summary.paidAmount)}'),
          const SizedBox(height: 8),
          Text('Còn nợ: ${formatMoney(summary.remainingAmount)}'),
        ],
      ),
    );
  }

  List<dynamic> get _unpaidInvoices {
    return _invoices.where((inv) {
      if (inv is! Map) return false;
      final st = inv['status']?.toString().toUpperCase();
      final summary = resolveResidentInvoiceTotalsSummary(inv);
      return ['ISSUED', 'PARTIALLY_PAID', 'OVERDUE', 'ADJUSTED'].contains(st) &&
          summary.remainingAmount > 0;
    }).toList();
  }

  List<dynamic> get _filteredInvoices {
    if (_filterTab == 'unpaid') return _unpaidInvoices;
    if (_filterTab == 'paid') {
      return _invoices.where((inv) {
        if (inv is Map) {
          final st = inv['status']?.toString().toUpperCase();
          return st == 'PAID';
        }
        return false;
      }).toList();
    }
    return _invoices;
  }

  int get _totalUnpaid {
    int total = 0;
    for (final inv in _unpaidInvoices) {
      if (inv is Map) {
        final s = resolveResidentInvoiceTotalsSummary(inv);
        total += s.remainingAmount;
      }
    }
    return total;
  }

  int get _totalPaid {
    int total = 0;
    for (final inv in _invoices) {
      if (inv is Map) {
        final st = inv['status']?.toString().toUpperCase();
        if (st != 'CANCELLED' && st != 'DRAFT' && st != 'VOID') {
          total += num.tryParse(inv['paid_amount']?.toString() ?? '')?.toInt() ?? 0;
        }
      }
    }
    return total;
  }

  int get _totalBilled {
    int total = 0;
    for (final inv in _invoices) {
      if (inv is Map) {
        final st = inv['status']?.toString().toUpperCase();
        if (st != 'CANCELLED' && st != 'DRAFT' && st != 'VOID') {
          total += num.tryParse(inv['total_amount']?.toString() ?? '')?.toInt() ?? 0;
        }
      }
    }
    return total;
  }

  String _computeTransferSyntax() {
    final contract = widget.overview?['active_contract'] ?? widget.overview?['contract'];
    final unpaid = _unpaidInvoices;
    final firstUnpaid = unpaid.isNotEmpty && unpaid.first is Map
        ? Map<String, dynamic>.from(unpaid.first as Map)
        : null;
    final aptCode = (contract?['apartment_code'] ?? firstUnpaid?['apartment_code'] ?? 'CANHO').toString();
    final rawPeriod = (firstUnpaid?['period'] ?? firstUnpaid?['billing_period'] ?? '').toString();
    final period = rawPeriod.replaceAll('-', '');
    return 'RESIHUB $aptCode${period.isNotEmpty ? ' $period' : ''}';
  }

  String _buildVietQrUrl(int amount, String transferSyntax) {
    final bin = (_paymentAccount['bank_bin'] ?? '970436').toString();
    final accNo = (_paymentAccount['account_no'] ?? '').toString();
    final accName = (_paymentAccount['account_name'] ?? '').toString();
    final encSyntax = Uri.encodeComponent(transferSyntax);
    final encName = Uri.encodeComponent(accName);
    return 'https://img.vietqr.io/image/$bin-$accNo-compact2.png?amount=$amount&addInfo=$encSyntax&accountName=$encName';
  }

  void _copyToClipboard(BuildContext context, String text, String label) {
    if (text.isEmpty) return;
    Clipboard.setData(ClipboardData(text: text));
    ref.read(toastProvider.notifier).info('Đã sao chép $label vào bộ nhớ tạm.');
  }

  void _openPaymentReportModal(BuildContext context, [Map<String, dynamic>? targetInv]) {
    String invoiceIdOf(dynamic inv) => inv is Map
        ? (inv['invoice_id'] ?? inv['id'])?.toString() ?? ''
        : '';

    final candidates = List<dynamic>.from(_unpaidInvoices);
    if (targetInv != null) {
      final tid = invoiceIdOf(targetInv);
      if (tid.isNotEmpty && !candidates.any((u) => invoiceIdOf(u) == tid)) {
        candidates.insert(0, targetInv);
      }
    }

    String amountFor(String invId) {
      for (final u in candidates) {
        if (invoiceIdOf(u) == invId) {
          return resolveResidentInvoiceTotalsSummary(u).remainingAmount.toString();
        }
      }
      return '';
    }

    String selectedInvoiceId = targetInv != null
        ? invoiceIdOf(targetInv)
        : (candidates.isNotEmpty ? invoiceIdOf(candidates.first) : '');
    if (selectedInvoiceId.isEmpty && candidates.isNotEmpty) {
      selectedInvoiceId = invoiceIdOf(candidates.first);
    }

    String amount = amountFor(selectedInvoiceId);
    String method = 'BANK_TRANSFER';
    final referenceCtrl = TextEditingController();
    final noteCtrl = TextEditingController();
    final dateCtrl = TextEditingController(text: toInputDate(DateTime.now()));
    List<String> proofImages = [];
    bool submitting = false;

    final invoiceOptions = candidates.map<AppSelectOption<String>>((u) {
      final m = u is Map ? Map<String, dynamic>.from(u) : <String, dynamic>{};
      final rem = resolveResidentInvoiceTotalsSummary(m).remainingAmount;
      final period = m['period']?.toString() ?? m['billing_period']?.toString() ?? '';
      final label = period.isNotEmpty ? 'Kỳ $period' : 'Phí phạt tất toán';
      return AppSelectOption<String>(
        value: invoiceIdOf(m),
        label: '$label (${m['invoice_code']?.toString() ?? ''}) — Còn nợ: ${formatMoney(rem)}',
      );
    }).toList();

    final methodOptions = _paymentMethods.entries
        .map((e) => AppSelectOption<String>(value: e.key, label: e.value))
        .toList();

    Future<void> pickDate(BuildContext pickerContext, StateSetter setModalState) async {
      final initial = DateTime.tryParse(dateCtrl.text) ?? DateTime.now();
      final picked = await showDatePicker(
        context: pickerContext,
        initialDate: initial,
        firstDate: DateTime(2000),
        lastDate: DateTime.now().add(const Duration(days: 365)),
      );
      if (picked != null) {
        setModalState(() => dateCtrl.text = toInputDate(picked));
      }
    }

    AppModal.show(
      context: context,
      title: 'Báo đã thanh toán hóa đơn',
      subtitle: 'Gửi thông tin giao dịch và ảnh biên lai để kế toán Ban Quản Lý đối soát xác nhận',
      child: StatefulBuilder(
        builder: (ctx, setModalState) {
          return Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            mainAxisSize: MainAxisSize.min,
            children: [
              AppSelect<String>(
                label: 'Chọn hóa đơn thanh toán',
                required: true,
                placeholder: '-- Chọn hóa đơn --',
                value: selectedInvoiceId,
                options: invoiceOptions,
                hint: 'Mã hóa đơn: ${selectedInvoiceId.isEmpty ? '—' : selectedInvoiceId}',
                onChanged: (val) {
                  setModalState(() {
                    selectedInvoiceId = val ?? '';
                    amount = amountFor(selectedInvoiceId);
                  });
                },
              ),
              const SizedBox(height: 12),
              MoneyInput(
                label: 'Số tiền đã chuyển (VNĐ)',
                required: true,
                placeholder: 'VD: 8.500.000',
                value: amount,
                hint: amount.isNotEmpty ? 'Bằng số: ${formatMoney(amount)}' : null,
                onChanged: (val) => amount = val,
              ),
              const SizedBox(height: 12),
              AppSelect<String>(
                label: 'Phương thức thanh toán',
                value: method,
                options: methodOptions,
                onChanged: (val) => setModalState(() => method = val ?? 'BANK_TRANSFER'),
              ),
              const SizedBox(height: 12),
              AppInput(
                label: 'Mã tham chiếu / Mã GD ngân hàng',
                controller: referenceCtrl,
                placeholder: 'VD: FT2630291823...',
              ),
              const SizedBox(height: 12),
              InkWell(
                onTap: () => pickDate(ctx, setModalState),
                borderRadius: BorderRadius.circular(8),
                child: AbsorbPointer(
                  child: AppInput(
                    label: 'Ngày thực hiện giao dịch',
                    hint: 'Ngày thanh toán (YYYY-MM-DD)',
                    controller: dateCtrl,
                    readOnly: true,
                    rightElement: const Icon(LucideIcons.calendar,
                        size: 16, color: AppColors.slate400),
                  ),
                ),
              ),
              const SizedBox(height: 12),
              FileUploadField(
                label: 'Ảnh chụp biên lai / Ủy nhiệm chi chuyển khoản (tối đa 3 ảnh)',
                hint: 'Ảnh chứng từ thanh toán',
                multiple: true,
                maxFiles: 3,
                value: proofImages,
                onChanged: (val) {
                  setModalState(() {
                    proofImages = (val is List ? val : <dynamic>[])
                        .map((e) => e.toString())
                        .where((s) => s.isNotEmpty)
                        .toList();
                  });
                },
              ),
              const SizedBox(height: 12),
              AppInput(
                label: 'Ghi chú gửi kế toán (tùy chọn)',
                controller: noteCtrl,
                multiline: true,
                rows: 2,
                placeholder: 'Ví dụ: Đã chuyển khoản thanh toán đủ kỳ tháng này...',
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
                    text: submitting ? 'Đang gửi...' : 'Gửi đối soát thanh toán',
                    loading: submitting,
                    onPressed: submitting
                        ? null
                        : () async {
                            if (selectedInvoiceId.isEmpty) {
                              ref
                                  .read(toastProvider.notifier)
                                  .warning('Vui lòng chọn hóa đơn cần báo thanh toán.');
                              return;
                            }
                            final amt =
                                num.tryParse(amount.replaceAll(RegExp(r'[^\d.]'), ''))?.round() ?? 0;
                            if (amt <= 0) {
                              ref
                                  .read(toastProvider.notifier)
                                  .warning('Vui lòng nhập số tiền thanh toán hợp lệ (> 0).');
                              return;
                            }

                            setModalState(() => submitting = true);
                            try {
                              final paidAt = DateTime.tryParse(dateCtrl.text);
                              await ref.read(residentServiceProvider).reportPayment({
                                'invoice_id': selectedInvoiceId,
                                'amount': amt,
                                'method': method,
                                if (referenceCtrl.text.trim().isNotEmpty)
                                  'reference_code': referenceCtrl.text.trim(),
                                if (paidAt != null) 'paid_at': paidAt.toUtc().toIso8601String(),
                                'note': noteCtrl.text.trim(),
                                'proof_images': proofImages,
                              });
                              if (ctx.mounted) {
                                Navigator.of(ctx).pop();
                              }
                              ref
                                  .read(toastProvider.notifier)
                                  .success('Đã gửi thông báo thanh toán kèm chứng từ thành công!');
                              await _fetchInvoices();
                              await widget.onRefreshOverview();
                            } catch (err) {
                              setModalState(() => submitting = false);
                              ref
                                  .read(toastProvider.notifier)
                                  .error(extractErrorMessage(err, 'Không thể gửi xác nhận thanh toán.'));
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

  void _showMeterPhotoDialog(BuildContext context, String imageUrl, String title) {
    AuthMediaViewer.show(
      context,
      src: imageUrl,
      title: title,
    );
  }

  void _openCreditDetailModal(BuildContext context, Map<String, dynamic> credit) {
    final status = credit['status']?.toString() ?? 'AVAILABLE';
    final amount = credit['amount'] ?? 0;
    final avail = credit['available_amount'] ?? amount;
    final desc = credit['description']?.toString() ?? '';
    final reason = credit['refund_meta'] is Map
        ? credit['refund_meta']['rejection_reason']?.toString()
        : null;

    AppModal.show(
      context: context,
      title: 'Chi tiết Số dư Tín dụng & Hoàn tiền',
      subtitle: 'Theo dõi biến động tiền nộp dư, cấn trừ hóa đơn và đề nghị hoàn trả',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Container(
            padding: const EdgeInsets.all(14),
            decoration: BoxDecoration(
              color: AppColors.primary50,
              borderRadius: BorderRadius.circular(12),
              border: Border.all(color: AppColors.primary200),
            ),
            child: Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      const Text('Trạng thái khoản tín dụng',
                          style: TextStyle(fontSize: 12, color: AppColors.slate500)),
                      const SizedBox(height: 4),
                      StatusBadge(status: status, domain: StatusDomain.creditBalance),
                    ],
                  ),
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.end,
                    children: [
                      const Text('Khả dụng / Giá trị gốc',
                          style: TextStyle(fontSize: 12, color: AppColors.slate500)),
                      const SizedBox(height: 2),
                      Text(
                        '${formatMoney(avail)} / ${formatMoney(amount)}',
                        style: const TextStyle(
                          fontFamily: 'Inter',
                          fontSize: 14,
                          fontWeight: FontWeight.bold,
                          color: AppColors.primary700,
                        ),
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
          if (desc.isNotEmpty) ...[
            const SizedBox(height: 12),
            Container(
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(
                color: AppColors.slate50,
                borderRadius: BorderRadius.circular(10),
                border: Border.all(color: AppColors.slate200),
              ),
              child: Text(
                'Diễn giải: $desc',
                style: const TextStyle(fontSize: 13, color: AppColors.slate700),
              ),
            ),
          ],
          if (reason != null && reason.isNotEmpty) ...[
            const SizedBox(height: 12),
            Container(
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(
                color: AppColors.rose50,
                borderRadius: BorderRadius.circular(10),
                border: Border.all(color: AppColors.rose200),
              ),
              child: Text(
                'Lý do từ chối: $reason',
                style: const TextStyle(fontSize: 13, color: AppColors.rose700),
              ),
            ),
          ],
        ],
      ),
    );
  }

  void _openVietQrModal(BuildContext context, {required int amount, required String transferSyntax}) {
    final qrUrl = _buildVietQrUrl(amount, transferSyntax);
    final bankName = _paymentAccount['bank']?.toString() ?? 'Ngân hàng';
    final accNo = _paymentAccount['account_no']?.toString() ?? '';
    final accHolder = _paymentAccount['account_name']?.toString() ?? '';

    AppModal.show(
      context: context,
      title: 'Mã VietQR Thanh Toán',
      subtitle: 'Quét mã để tự động điền số tiền và nội dung chuyển khoản',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.center,
        children: [
          Container(
            padding: const EdgeInsets.all(12),
            decoration: BoxDecoration(
              color: Colors.white,
              borderRadius: BorderRadius.circular(16),
              border: Border.all(color: AppColors.slate200),
              boxShadow: const [
                BoxShadow(
                  color: Color.fromRGBO(15, 23, 42, 0.06),
                  blurRadius: 10,
                  offset: Offset(0, 4),
                ),
              ],
            ),
            child: ClipRRect(
              borderRadius: BorderRadius.circular(8),
              child: Image.network(
                qrUrl,
                width: 220,
                height: 220,
                fit: BoxFit.contain,
                errorBuilder: (ctx, err, stack) => Container(
                  width: 220,
                  height: 220,
                  color: AppColors.slate100,
                  alignment: Alignment.center,
                  child: const Text('Không tải được ảnh VietQR',
                      style: TextStyle(fontSize: 12, color: AppColors.slate500)),
                ),
              ),
            ),
          ),
          const SizedBox(height: 16),
          Container(
            padding: const EdgeInsets.all(12),
            decoration: BoxDecoration(
              color: AppColors.slate50,
              borderRadius: BorderRadius.circular(12),
              border: Border.all(color: AppColors.slate200),
            ),
            child: Column(
              children: [
                _buildInfoRow('Ngân hàng', bankName),
                const SizedBox(height: 6),
                _buildInfoRowWithCopy(context, 'Số tài khoản', accNo),
                const SizedBox(height: 6),
                _buildInfoRow('Chủ tài khoản', accHolder),
                const SizedBox(height: 6),
                _buildInfoRow('Số tiền', formatMoney(amount)),
                const SizedBox(height: 6),
                _buildInfoRowWithCopy(context, 'Nội dung CK', transferSyntax),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildInfoRow(String label, String value) {
    return Row(
      mainAxisAlignment: MainAxisAlignment.spaceBetween,
      children: [
        Text(label, style: const TextStyle(fontSize: 12, color: AppColors.slate500)),
        Flexible(
          child: Text(
            value,
            textAlign: TextAlign.end,
            style: const TextStyle(
              fontSize: 12,
              fontWeight: FontWeight.w600,
              color: AppColors.slate900,
            ),
          ),
        ),
      ],
    );
  }

  Widget _buildInfoRowWithCopy(BuildContext context, String label, String value) {
    return Row(
      mainAxisAlignment: MainAxisAlignment.spaceBetween,
      children: [
        Text(label, style: const TextStyle(fontSize: 12, color: AppColors.slate500)),
        Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(
              value,
              style: const TextStyle(
                fontFamily: 'Inter',
                fontSize: 12,
                fontWeight: FontWeight.bold,
                color: AppColors.primary700,
              ),
            ),
            const SizedBox(width: 6),
            InkWell(
              onTap: () => _copyToClipboard(context, value, label),
              borderRadius: BorderRadius.circular(4),
              child: const Padding(
                padding: EdgeInsets.all(4),
                child: Icon(LucideIcons.copy, size: 14, color: AppColors.primary600),
              ),
            ),
          ],
        ),
      ],
    );
  }

  @override
  Widget build(BuildContext context) {
    final transferSyntax = _computeTransferSyntax();
    final totalUnpaid = _totalUnpaid;
    final totalPaid = _totalPaid;
    final totalBilled = _totalBilled;
    final unpaidInvoices = _unpaidInvoices;
    final filteredInvoices = _filteredInvoices;

    final num availableCredit = widget.overview?['available_credit_balance'] ??
        widget.overview?['credit_balance'] ??
        widget.overview?['active_contract']?['available_credit_balance'] ??
        widget.overview?['contract']?['available_credit_balance'] ??
        0;

    return RefreshIndicator(
      onRefresh: () async {
        await widget.onRefreshOverview();
        await _fetchInvoices();
      },
      child: _loading && _invoices.isEmpty
          ? const Center(child: CircularProgressIndicator())
          : ListView(
              padding: const EdgeInsets.all(16),
              children: [
                // Available Credit Balance Banner
                if (availableCredit > 0) ...[
                  Container(
                    margin: const EdgeInsets.only(bottom: 16),
                    padding: const EdgeInsets.all(14),
                    decoration: BoxDecoration(
                      color: const Color(0xFFF0F9FF),
                      borderRadius: BorderRadius.circular(14),
                      border: Border.all(color: const Color(0xFFBAE6FD)),
                    ),
                    child: Row(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        const Icon(LucideIcons.sparkles, size: 20, color: Color(0xFF0284C7)),
                        const SizedBox(width: 10),
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(
                                'Số dư tín dụng khả dụng: ${formatMoney(availableCredit)}',
                                style: const TextStyle(
                                  fontFamily: 'Inter',
                                  fontSize: 14,
                                  fontWeight: FontWeight.bold,
                                  color: Color(0xFF0369A1),
                                ),
                              ),
                              const SizedBox(height: 2),
                              const Text(
                                'Số dư này sẽ tự động được cấn trừ vào hóa đơn kỳ tới hoặc hoàn trả khi thanh lý hợp đồng.',
                                style: TextStyle(
                                  fontSize: 12,
                                  color: Color(0xFF0284C7),
                                ),
                              ),
                            ],
                          ),
                        ),
                      ],
                    ),
                  ),
                ],

                // Financial Summary Cards
                Container(
                  margin: const EdgeInsets.only(bottom: 16),
                  padding: const EdgeInsets.all(16),
                  decoration: BoxDecoration(
                    color: Colors.white,
                    borderRadius: BorderRadius.circular(16),
                    border: Border.all(color: AppColors.slate200),
                    boxShadow: const [
                      BoxShadow(
                        color: Color.fromRGBO(15, 23, 42, 0.04),
                        blurRadius: 8,
                        offset: Offset(0, 2),
                      ),
                    ],
                  ),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      Row(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          const Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(
                                  'Hóa đơn & Đối soát Thanh toán',
                                  style: TextStyle(
                                    fontFamily: 'Inter',
                                    fontSize: 15,
                                    fontWeight: FontWeight.bold,
                                    color: AppColors.slate900,
                                  ),
                                ),
                                SizedBox(height: 2),
                                Text(
                                  'Tra cứu chi tiết tiền thuê, điện, nước, dịch vụ hàng tháng và gửi biên lai chuyển khoản',
                                  style: TextStyle(fontSize: 12, color: AppColors.slate500),
                                ),
                              ],
                            ),
                          ),
                          const SizedBox(width: 12),
                          AppButton(
                            text: 'Báo đã thanh toán',
                            size: AppButtonSize.sm,
                            icon: const Icon(LucideIcons.creditCard, size: 14),
                            onPressed: unpaidInvoices.isEmpty
                                ? null
                                : () => _openPaymentReportModal(context, unpaidInvoices.first),
                          ),
                        ],
                      ),
                      const SizedBox(height: 14),
                      Row(
                        children: [
                          Expanded(
                            child: Container(
                              padding: const EdgeInsets.all(12),
                              decoration: BoxDecoration(
                                color: const Color(0xFFFFF1F2),
                                borderRadius: BorderRadius.circular(12),
                                border: Border.all(color: const Color(0xFFFFE4E6)),
                              ),
                              child: Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  const Text('Cần thanh toán',
                                      style: TextStyle(fontSize: 11, color: AppColors.slate500)),
                                  const SizedBox(height: 4),
                                  Text(
                                    formatMoney(totalUnpaid),
                                    style: const TextStyle(
                                      fontFamily: 'Inter',
                                      fontSize: 15,
                                      fontWeight: FontWeight.bold,
                                      color: Color(0xFFE11D48),
                                    ),
                                  ),
                                  const SizedBox(height: 2),
                                  Text(
                                    '${unpaidInvoices.length} hóa đơn mở',
                                    style: const TextStyle(fontSize: 11, color: AppColors.slate500),
                                  ),
                                ],
                              ),
                            ),
                          ),
                          const SizedBox(width: 8),
                          Expanded(
                            child: Container(
                              padding: const EdgeInsets.all(12),
                              decoration: BoxDecoration(
                                color: const Color(0xFFECFDF5),
                                borderRadius: BorderRadius.circular(12),
                                border: Border.all(color: const Color(0xFFD1FAE5)),
                              ),
                              child: Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  const Text('Đã thanh toán',
                                      style: TextStyle(fontSize: 11, color: AppColors.slate500)),
                                  const SizedBox(height: 4),
                                  Text(
                                    formatMoney(totalPaid),
                                    style: const TextStyle(
                                      fontFamily: 'Inter',
                                      fontSize: 15,
                                      fontWeight: FontWeight.bold,
                                      color: Color(0xFF047857),
                                    ),
                                  ),
                                  const SizedBox(height: 2),
                                  const Text(
                                    'Đã đối soát',
                                    style: TextStyle(fontSize: 11, color: AppColors.slate500),
                                  ),
                                ],
                              ),
                            ),
                          ),
                          const SizedBox(width: 8),
                          Expanded(
                            child: Container(
                              padding: const EdgeInsets.all(12),
                              decoration: BoxDecoration(
                                color: AppColors.slate50,
                                borderRadius: BorderRadius.circular(12),
                                border: Border.all(color: AppColors.slate200),
                              ),
                              child: Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  const Text('Tổng phát sinh',
                                      style: TextStyle(fontSize: 11, color: AppColors.slate500)),
                                  const SizedBox(height: 4),
                                  Text(
                                    formatMoney(totalBilled),
                                    style: const TextStyle(
                                      fontFamily: 'Inter',
                                      fontSize: 15,
                                      fontWeight: FontWeight.bold,
                                      color: AppColors.slate900,
                                    ),
                                  ),
                                  const SizedBox(height: 2),
                                  Text(
                                    '${_invoices.length} kỳ hóa đơn',
                                    style: const TextStyle(fontSize: 11, color: AppColors.slate500),
                                  ),
                                ],
                              ),
                            ),
                          ),
                        ],
                      ),
                    ],
                  ),
                ),

                // Building Official Payment Account & VietQR Card
                Container(
                  margin: const EdgeInsets.only(bottom: 16),
                  padding: const EdgeInsets.all(16),
                  decoration: BoxDecoration(
                    gradient: const LinearGradient(
                      colors: [Color(0xFF0F172A), Color(0xFF1E1B4B)],
                      begin: Alignment.topLeft,
                      end: Alignment.bottomRight,
                    ),
                    borderRadius: BorderRadius.circular(16),
                    boxShadow: const [
                      BoxShadow(
                        color: Color.fromRGBO(15, 23, 42, 0.12),
                        blurRadius: 10,
                        offset: Offset(0, 4),
                      ),
                    ],
                  ),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      Row(
                        mainAxisAlignment: MainAxisAlignment.spaceBetween,
                        children: [
                          Row(
                            children: const [
                              Icon(LucideIcons.landmark, size: 18, color: Color(0xFF7DD3FC)),
                              SizedBox(width: 8),
                              Text(
                                'Tài khoản nhận thanh toán Tòa nhà',
                                style: TextStyle(
                                  fontFamily: 'Inter',
                                  fontSize: 13,
                                  fontWeight: FontWeight.w600,
                                  color: Color(0xFFBAE6FD),
                                ),
                              ),
                            ],
                          ),
                          const AppBadge(
                            label: 'Chính thức',
                            variant: AppBadgeVariant.sky,
                          ),
                        ],
                      ),
                      const SizedBox(height: 12),
                      Text(
                        '${_paymentAccount['bank']}${_paymentAccount['bank_code'] != null && _paymentAccount['bank_code'].toString().isNotEmpty ? ' (${_paymentAccount['bank_code']})' : ''}${_paymentAccount['branch'] != null && _paymentAccount['branch'].toString().isNotEmpty ? ' — ${_paymentAccount['branch']}' : ''}',
                        style: const TextStyle(
                          fontFamily: 'Inter',
                          fontSize: 14,
                          fontWeight: FontWeight.bold,
                          color: Colors.white,
                        ),
                      ),
                      const SizedBox(height: 8),
                      Container(
                        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                        decoration: BoxDecoration(
                          color: Colors.white.withOpacity(0.08),
                          borderRadius: BorderRadius.circular(10),
                          border: Border.all(color: Colors.white.withOpacity(0.12)),
                        ),
                        child: Row(
                          mainAxisAlignment: MainAxisAlignment.spaceBetween,
                          children: [
                            Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                const Text(
                                  'Số tài khoản',
                                  style: TextStyle(fontSize: 11, color: Color(0xFFCBD5E1)),
                                ),
                                const SizedBox(height: 2),
                                Text(
                                  _paymentAccount['account_no']?.toString() ?? '—',
                                  style: const TextStyle(
                                    fontFamily: 'Inter',
                                    fontSize: 16,
                                    fontWeight: FontWeight.bold,
                                    letterSpacing: 1.2,
                                    color: Color(0xFF7DD3FC),
                                  ),
                                ),
                              ],
                            ),
                            IconButton(
                              icon: const Icon(LucideIcons.copy, size: 18, color: Colors.white),
                              onPressed: () => _copyToClipboard(
                                context,
                                _paymentAccount['account_no']?.toString() ?? '',
                                'số tài khoản',
                              ),
                              tooltip: 'Sao chép số tài khoản',
                            ),
                          ],
                        ),
                      ),
                      const SizedBox(height: 8),
                      Text(
                        'Chủ TK: ${_paymentAccount['account_name'] ?? 'BAN QUẢN LÝ'}',
                        style: const TextStyle(
                          fontSize: 12,
                          fontWeight: FontWeight.w500,
                          color: Color(0xFFE2E8F0),
                        ),
                      ),
                      const SizedBox(height: 10),
                      const Divider(color: Color(0x33FFFFFF), height: 1),
                      const SizedBox(height: 10),
                      Row(
                        mainAxisAlignment: MainAxisAlignment.spaceBetween,
                        children: [
                          Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                const Text(
                                  'Nội dung CK:',
                                  style: TextStyle(fontSize: 11, color: Color(0xFF94A3B8)),
                                ),
                                const SizedBox(height: 2),
                                Text(
                                  transferSyntax,
                                  style: const TextStyle(
                                    fontFamily: 'Inter',
                                    fontSize: 13,
                                    fontWeight: FontWeight.bold,
                                    color: Color(0xFFFDE047),
                                  ),
                                ),
                              ],
                            ),
                          ),
                          TextButton.icon(
                            onPressed: () =>
                                _copyToClipboard(context, transferSyntax, 'nội dung chuyển khoản'),
                            icon: const Icon(LucideIcons.copy, size: 14, color: Color(0xFF7DD3FC)),
                            label: const Text(
                              'Sao chép',
                              style: TextStyle(fontSize: 12, color: Color(0xFF7DD3FC)),
                            ),
                          ),
                        ],
                      ),
                      const SizedBox(height: 10),
                      AppButton(
                        text: 'Mã QR thanh toán (VietQR)',
                        variant: AppButtonVariant.outline,
                        size: AppButtonSize.sm,
                        icon: const Icon(LucideIcons.qrCode, size: 14),
                        onPressed: () => _openVietQrModal(
                          context,
                          amount: totalUnpaid > 0 ? totalUnpaid : 0,
                          transferSyntax: transferSyntax,
                        ),
                      ),
                    ],
                  ),
                ),

                // Credit Balance History Section
                if (_creditBalances.isNotEmpty) ...[
                  Container(
                    margin: const EdgeInsets.only(bottom: 16),
                    padding: const EdgeInsets.all(16),
                    decoration: BoxDecoration(
                      color: Colors.white,
                      borderRadius: BorderRadius.circular(16),
                      border: Border.all(color: AppColors.slate200),
                    ),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        Row(
                          children: [
                            const Icon(LucideIcons.sparkles, size: 16, color: AppColors.primary600),
                            const SizedBox(width: 8),
                            Text(
                              'Lịch sử biến động tín dụng (${_creditBalances.length})',
                              style: const TextStyle(
                                fontFamily: 'Inter',
                                fontSize: 14,
                                fontWeight: FontWeight.bold,
                                color: AppColors.slate900,
                              ),
                            ),
                          ],
                        ),
                        const SizedBox(height: 12),
                        ..._creditBalances.map((c) {
                          final credit = c is Map ? Map<String, dynamic>.from(c) : <String, dynamic>{};
                          final status = credit['status']?.toString() ?? 'AVAILABLE';
                          final desc = credit['description']?.toString() ?? 'Khoản tín dụng';
                          final amt = credit['amount'] ?? 0;
                          final avail = credit['available_amount'] ?? amt;

                          return InkWell(
                            onTap: () => _openCreditDetailModal(context, credit),
                            borderRadius: BorderRadius.circular(10),
                            child: Container(
                              margin: const EdgeInsets.only(bottom: 8),
                              padding: const EdgeInsets.all(12),
                              decoration: BoxDecoration(
                                color: AppColors.slate50,
                                borderRadius: BorderRadius.circular(10),
                                border: Border.all(color: AppColors.slate200),
                              ),
                              child: Row(
                                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                                children: [
                                  Expanded(
                                    child: Column(
                                      crossAxisAlignment: CrossAxisAlignment.start,
                                      children: [
                                        Row(
                                          children: [
                                            StatusBadge(status: status, domain: StatusDomain.creditBalance),
                                            if (credit['created_at'] != null) ...[
                                              const SizedBox(width: 8),
                                              Text(
                                                formatDate(credit['created_at']),
                                                style: const TextStyle(fontSize: 11, color: AppColors.slate500),
                                              ),
                                            ],
                                          ],
                                        ),
                                        const SizedBox(height: 4),
                                        Text(
                                          desc,
                                          style: const TextStyle(
                                            fontSize: 12,
                                            fontWeight: FontWeight.w500,
                                            color: AppColors.slate800,
                                          ),
                                        ),
                                      ],
                                    ),
                                  ),
                                  Column(
                                    crossAxisAlignment: CrossAxisAlignment.end,
                                    children: [
                                      Text(
                                        formatMoney(amt),
                                        style: const TextStyle(
                                          fontFamily: 'Inter',
                                          fontSize: 13,
                                          fontWeight: FontWeight.bold,
                                          color: AppColors.slate900,
                                        ),
                                      ),
                                      if (avail != amt)
                                        Text(
                                          'Còn lại: ${formatMoney(avail)}',
                                          style: const TextStyle(
                                            fontFamily: 'Inter',
                                            fontSize: 11,
                                            color: AppColors.primary700,
                                          ),
                                        ),
                                    ],
                                  ),
                                ],
                              ),
                            ),
                          );
                        }),
                      ],
                    ),
                  ),
                ],

                // Filter Tabs (all / unpaid / paid)
                Container(
                  margin: const EdgeInsets.only(bottom: 16),
                  decoration: BoxDecoration(
                    color: AppColors.slate100,
                    borderRadius: BorderRadius.circular(10),
                  ),
                  padding: const EdgeInsets.all(4),
                  child: Row(
                    children: [
                      _buildFilterTabItem('all', 'Tất cả hóa đơn', _invoices.length),
                      _buildFilterTabItem('unpaid', 'Chờ thanh toán', unpaidInvoices.length),
                      _buildFilterTabItem(
                        'paid',
                        'Đã hoàn tất',
                        _invoices.where((i) => i is Map && i['status']?.toString().toUpperCase() == 'PAID').length,
                      ),
                    ],
                  ),
                ),

                // Invoices List
                if (filteredInvoices.isEmpty) ...[
                  Padding(
                    padding: const EdgeInsets.all(32),
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        const Icon(LucideIcons.receipt, size: 48, color: AppColors.slate400),
                        const SizedBox(height: 12),
                        Text(
                          _filterTab == 'unpaid'
                              ? 'Tuyệt vời! Không có hóa đơn chờ thanh toán'
                              : 'Chưa có hóa đơn nào',
                          style: const TextStyle(
                            fontFamily: 'Inter',
                            fontSize: 15,
                            fontWeight: FontWeight.w600,
                            color: AppColors.slate800,
                          ),
                        ),
                        const SizedBox(height: 4),
                        const Text(
                          'Các kỳ hóa đơn sẽ hiển thị tại đây khi Ban Quản Lý phát hành.',
                          style: TextStyle(fontSize: 12, color: AppColors.slate500),
                        ),
                      ],
                    ),
                  ),
                ] else ...[
                  ...filteredInvoices.map((invRaw) {
                    final inv = invRaw is Map
                        ? Map<String, dynamic>.from(invRaw)
                        : <String, dynamic>{};

                    final summary = resolveResidentInvoiceTotalsSummary(inv);
                    final status = inv['status']?.toString().toUpperCase() ?? '';
                    final isPaid = status == 'PAID';
                    final isOverdue = status == 'OVERDUE';
                    final lines = inv['lines'] is List ? inv['lines'] as List : const [];

                    return Container(
                      margin: const EdgeInsets.only(bottom: 16),
                      decoration: BoxDecoration(
                        color: isOverdue ? AppColors.rose50 : Colors.white,
                        borderRadius: BorderRadius.circular(16),
                        border: Border.all(
                          color: isOverdue ? AppColors.rose300 : AppColors.slate200,
                        ),
                        boxShadow: [
                          BoxShadow(
                            color: isOverdue
                                ? AppColors.rose200
                                : const Color.fromRGBO(15, 23, 42, 0.03),
                            blurRadius: 8,
                            offset: const Offset(0, 2),
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
                                StatusBadge(status: status, domain: StatusDomain.invoice),
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
                  }),
                ],
              ],
            ),
    );
  }

  Widget _buildFilterTabItem(String key, String label, int count) {
    final active = _filterTab == key;
    final textStyle = TextStyle(
      fontFamily: 'Inter',
      fontSize: 12,
      fontWeight: active ? FontWeight.bold : FontWeight.w500,
      color: active ? AppColors.slate900 : AppColors.slate600,
    );
    return Expanded(
      child: InkWell(
        onTap: () => setState(() => _filterTab = key),
        borderRadius: BorderRadius.circular(8),
        child: Container(
          padding: const EdgeInsets.symmetric(vertical: 8),
          decoration: BoxDecoration(
            color: active ? Colors.white : Colors.transparent,
            borderRadius: BorderRadius.circular(8),
            boxShadow: active
                ? const [
                    BoxShadow(
                      color: Color.fromRGBO(15, 23, 42, 0.06),
                      blurRadius: 4,
                      offset: Offset(0, 1),
                    )
                  ]
                : null,
          ),
          alignment: Alignment.center,
          child: Row(
            mainAxisSize: MainAxisSize.min,
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              Flexible(
                child: Text(label, overflow: TextOverflow.ellipsis, style: textStyle),
              ),
              const SizedBox(width: 4),
              Text('$count', style: textStyle),
            ],
          ),
        ),
      ),
    );
  }
}
