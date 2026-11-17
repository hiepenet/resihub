import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../../../core/constants/statuses.dart';
import '../../../core/theme/app_colors.dart';
import '../../../core/utils/deposit_ui_helpers.dart';
import '../../../core/utils/file_exporter.dart';
import '../../../core/utils/format.dart';
import '../../../core/utils/validation.dart';
import '../../../shared/providers/toast_provider.dart';
import '../../../shared/widgets/common/bank_select.dart';
import '../../../shared/widgets/ui/app_badge.dart';
import '../../../shared/widgets/ui/app_button.dart';
import '../../../shared/widgets/ui/app_card.dart';
import '../../../shared/widgets/ui/app_input.dart';
import '../../../shared/widgets/ui/app_modal.dart';
import '../../../shared/widgets/ui/app_select.dart';
import '../../../shared/widgets/ui/auth_media_viewer.dart';
import '../../../shared/widgets/ui/html_print_preview_modal.dart';
import '../../contracts/services/contracts_service.dart';
import '../services/resident_service.dart';

const Map<String, String> kResidentDeductCategoryLabels = {
  'DAMAGE': 'Hư hỏng tài sản',
  'CLEANING': 'Vệ sinh mặt bằng',
  'UTILITY_DEBT': 'Điện / nước / tiện ích',
  'OTHER': 'Khấu trừ khác',
};

const Map<String, String> kResidentBillingCycleLabels = {
  'MONTHLY': 'hàng tháng',
  'QUARTERLY': 'hàng quý',
  'SEMI_ANNUALLY': '6 tháng/lần',
  'YEARLY': 'hàng năm',
  'ANNUALLY': 'hàng năm',
};

const List<String> kResidentSettlementStatuses = [
  'SETTLEMENT_DRAFT',
  'PENDING_APPROVAL',
  'APPROVED_PENDING_PAYOUT',
  'PARTIALLY_REFUNDED',
  'REFUNDED',
  'DEDUCTED_FULL',
  'RETURNED',
  'DISPUTED',
];

List<Map<String, dynamic>> asResidentMapList(dynamic value) {
  if (value is List) {
    return value.whereType<Map<String, dynamic>>().toList();
  }
  if (value is Map) {
    final data = value['data'];
    return data is List
        ? data.whereType<Map<String, dynamic>>().toList()
        : <Map<String, dynamic>>[];
  }
  return <Map<String, dynamic>>[];
}

/// Gom các bản ghi cọc có bảng kê từ HĐ hiện tại, lịch sử HĐ, sổ cọc và overview.
List<Map<String, dynamic>> resolveResidentSettlementDeposits({
  required Map<String, dynamic>? overview,
  required dynamic contract,
  required List<Map<String, dynamic>> contractHistory,
  required List<dynamic> deposits,
}) {
  final merged = <String, Map<String, dynamic>>{};

  void put(dynamic raw) {
    final entry = raw is Map<String, dynamic>
        ? raw
        : (raw is Map ? Map<String, dynamic>.from(raw) : null);
    if (entry == null) return;
    final id = (entry['deposit_id'] ?? entry['id'])?.toString();
    if (id == null || id.isEmpty) return;
    final settlement = entry['settlement'];
    final hasSettlement = settlement is Map && settlement.isNotEmpty;
    final status = (entry['deposit_status'] ?? entry['status'])?.toString();
    if (!hasSettlement && !kResidentSettlementStatuses.contains(status)) return;
    merged[id] = {
      ...(merged[id] ?? <String, dynamic>{}),
      ...entry,
      'deposit_id': id,
      if (hasSettlement) 'settlement': settlement,
    };
  }

  if (contract is Map<String, dynamic>) {
    put(<String, dynamic>{
      'deposit_id': contract['deposit_id'],
      'apartment_code': contract['apartment_code'],
      'building_name': contract['building_name'],
      'amount_held': contract['deposit_held_amount'],
      'deposit_status': contract['deposit_status'],
      'refund_due_date':
          contract['deposit_refund_due_date'] ?? contract['refund_due_date'],
      'settlement': contract['deposit_settlement'],
    });
  }
  for (final ch in contractHistory) {
    put(<String, dynamic>{
      'deposit_id': ch['deposit_id'],
      'apartment_code': ch['apartment_code'],
      'building_name': ch['building_name'],
      'amount_held': ch['deposit_held_amount'] ?? ch['amount_held'],
      'deposit_status': ch['deposit_status'],
      'refund_due_date': ch['deposit_refund_due_date'] ?? ch['refund_due_date'],
      'settlement': ch['deposit_settlement'],
    });
  }
  for (final dep in deposits) {
    put(dep);
  }
  for (final ds in asResidentMapList(overview?['deposit_settlements'])) {
    put(ds);
  }

  return merged.values
      .where(
          (e) => e['settlement'] is Map && (e['settlement'] as Map).isNotEmpty)
      .toList();
}

num _signedNum(dynamic value) {
  if (value is num) return value.isNaN ? 0 : value;
  return num.tryParse(value?.toString() ?? '') ?? 0;
}

num _nonNegativeNum(dynamic value) {
  final parsed = _signedNum(value);
  return parsed < 0 ? 0 : parsed;
}

String _formatDiffValue(String key, dynamic value) {
  if (value == null || value.toString().isEmpty) return '—';
  if (key.contains('amount')) return formatMoney(value);
  if (key.contains('date')) return formatDate(value);
  if (value is Map) return value.toString();
  return value.toString();
}

String _formatResidentBankInfo(dynamic info) {
  if (info == null) return '';
  if (info is! Map) return info.toString();
  return [
    info['bank_name'] ?? info['bank'],
    info['account_no'] ?? info['account_number'],
    info['account_holder'] ?? info['account_name'] ?? info['holder_name'],
  ]
      .where((v) => v != null && v.toString().isNotEmpty)
      .map((v) => v.toString())
      .join(' • ');
}

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
  List<dynamic> _occupants = [];

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
    final c =
        widget.overview?['active_contract'] ?? widget.overview?['contract'];
    return c?['contract_id']?.toString() ?? c?['id']?.toString();
  }

  Future<void> _fetchContractData() async {
    final cid = _contractId;
    if (cid == null || cid.isEmpty) return;

    setState(() => _loading = true);
    final occupantsFuture = ref
        .read(contractsServiceProvider)
        .listOccupants(cid)
        .catchError((Object _) => <dynamic>[]);
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

      final occRes = await occupantsFuture;
      final occData = occRes is Map && occRes['data'] is List
          ? occRes['data'] as List
          : (occRes is List ? occRes : <dynamic>[]);

      if (mounted) {
        setState(() {
          _deposits = depData;
          _contractRequests = reqData;
          _occupants = occData;
          _loading = false;
        });
      }
    } catch (err) {
      if (mounted) {
        setState(() => _loading = false);
        ref.read(toastProvider.notifier).error(
            extractErrorMessage(err, 'Không thể tải dữ liệu hợp đồng & cọc.'));
      }
    }
  }

  Future<void> _handleViewA4Contract([String? targetContractId]) async {
    final cid = (targetContractId != null && targetContractId.isNotEmpty)
        ? targetContractId
        : _contractId;
    if (cid == null || cid.isEmpty) {
      ref.read(toastProvider.notifier).error('Không tìm thấy mã hợp đồng.');
      return;
    }

    try {
      final html =
          await ref.read(contractsServiceProvider).getTemplateHtml(cid);
      if (mounted) {
        await showDialog<void>(
          context: context,
          barrierColor: AppColors.slate900.withValues(alpha: 0.75),
          builder: (ctx) => Dialog(
            backgroundColor: Colors.transparent,
            insetPadding: const EdgeInsets.all(16),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 960, maxHeight: 780),
              child: Container(
                decoration: BoxDecoration(
                  color: Colors.white,
                  borderRadius: BorderRadius.circular(16),
                ),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    Padding(
                      padding: const EdgeInsets.symmetric(
                          horizontal: 16, vertical: 12),
                      child: Row(
                        children: [
                          const Expanded(
                            child: Text(
                              'Bản in Hợp đồng thuê căn hộ chuẩn A4',
                              style: TextStyle(
                                fontFamily: 'Inter',
                                fontSize: 16,
                                fontWeight: FontWeight.w600,
                                color: AppColors.slate900,
                              ),
                            ),
                          ),
                          IconButton(
                            icon: const Icon(LucideIcons.x,
                                size: 20, color: AppColors.slate500),
                            splashRadius: 20,
                            onPressed: () => Navigator.of(ctx).pop(),
                          ),
                        ],
                      ),
                    ),
                    const Divider(height: 1),
                    Padding(
                      padding: const EdgeInsets.symmetric(
                          horizontal: 16, vertical: 8),
                      child: Align(
                        alignment: Alignment.centerRight,
                        child: AppButton(
                          text: 'Tải bản HTML',
                          size: AppButtonSize.sm,
                          variant: AppButtonVariant.outline,
                          icon: const Icon(LucideIcons.download, size: 14),
                          onPressed: () => _downloadA4Html(html),
                        ),
                      ),
                    ),
                    Expanded(
                      child: HtmlPrintPreviewModal(
                        title: 'Bản in hợp đồng thuê A4',
                        htmlContent: html,
                        fileName: 'Hop_dong_thue_$cid.html',
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
        );
      }
    } catch (err) {
      ref
          .read(toastProvider.notifier)
          .error(extractErrorMessage(err, 'Không thể tải bản in hợp đồng A4.'));
    }
  }

  Future<void> _downloadA4Html(String html) async {
    try {
      final active =
          widget.overview?['active_contract'] ?? widget.overview?['contract'];
      final code = active is Map && active['apartment_code'] != null
          ? active['apartment_code']!.toString()
          : 'HopDong';
      await saveOrShareBytes(
        Uint8List.fromList(utf8.encode(html)),
        fileName: 'HopDong_${code}_A4.html',
        mimeType: 'text/html;charset=utf-8',
        shareSubject: 'Hợp đồng thuê A4',
      );
    } catch (err) {
      ref
          .read(toastProvider.notifier)
          .error(extractErrorMessage(err, 'Không thể tải bản HTML.'));
    }
  }

  Future<void> _handleViewSettlementPdf(String depositId) async {
    try {
      final html = await ref
          .read(residentServiceProvider)
          .getDepositSettlementPdfHtml(depositId);
      if (mounted) {
        await HtmlPrintPreviewModal.show(
          context,
          title: 'Bảng kê tất toán tiền cọc',
          htmlContent: html,
          fileName: 'Tat_toan_coc_$depositId.pdf',
        );
      }
    } catch (err) {
      ref.read(toastProvider.notifier).error(
          extractErrorMessage(err, 'Không thể tải bảng kê tất toán cọc.'));
    }
  }

  void _openDisputeModal(BuildContext context, Map<String, dynamic> dep) {
    final depositId =
        dep['deposit_id']?.toString() ?? dep['id']?.toString() ?? '';
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
                hint:
                    'Ví dụ: Chi phí sơn tường không hợp lý vì phòng đã được sơn trước khi trả...',
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
                              ref.read(toastProvider.notifier).error(
                                  extractErrorMessage(
                                      err, 'Không thể gửi khiếu nại.'));
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
    final depositId =
        dep['deposit_id']?.toString() ?? dep['id']?.toString() ?? '';
    String bankName = dep['bank_name']?.toString() ?? '';
    String? bankCode = dep['bank_code']?.toString();
    String? bankBin = dep['bank_bin']?.toString();
    final accNumCtrl =
        TextEditingController(text: dep['account_number']?.toString() ?? '');
    final accHolderCtrl =
        TextEditingController(text: dep['account_holder']?.toString() ?? '');

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
                            if (bankName.isEmpty ||
                                acc.isEmpty ||
                                holder.isEmpty) {
                              ref.read(toastProvider.notifier).error(
                                  'Vui lòng điền đủ thông tin ngân hàng.');
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
                              ref.read(toastProvider.notifier).success(
                                  'Đã lưu thông tin tài khoản hoàn cọc.');
                              await _fetchContractData();
                            } catch (err) {
                              setModalState(() => saving = false);
                              ref.read(toastProvider.notifier).error(
                                    extractErrorMessage(
                                        err, 'Không thể cập nhật ngân hàng.'),
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

  void _openCreateContractRequestModal(BuildContext context,
      [String initialType = 'RENEWAL']) {
    final cid = _contractId;
    if (cid == null || cid.isEmpty) return;

    String requestType =
        initialType == 'TERMINATION' ? 'TERMINATION' : 'RENEWAL';
    final reasonCtrl = TextEditingController();
    final noteCtrl = TextEditingController();
    bool submitting = false;

    AppModal.show(
      context: context,
      title: requestType == 'TERMINATION'
          ? 'Gửi yêu cầu Xin chấm dứt Hợp đồng trước hạn'
          : 'Gửi yêu cầu Xin gia hạn Hợp đồng',
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
                    AppSelectOption(
                        value: 'RENEWAL', label: 'Gia hạn hợp đồng'),
                    AppSelectOption(
                        value: 'TERMINATION', label: 'Chấm dứt trước hạn'),
                    AppSelectOption(
                        value: 'TRANSFER_ROOM', label: 'Chuyển đổi phòng'),
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
                      onPressed:
                          submitting ? null : () => Navigator.of(ctx).pop(),
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
                                ref
                                    .read(toastProvider.notifier)
                                    .error('Vui lòng nhập lý do.');
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
                                      extractErrorMessage(err,
                                          'Không thể gửi yêu cầu hợp đồng.'),
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

  Widget _emptyHint(String text) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 6),
        child: Text(text,
            style: const TextStyle(color: AppColors.slate500, fontSize: 13)),
      );

  Widget _statusBadge(String? code, StatusDomain domain) =>
      AppBadge.fromStatusMeta(resolveStatusMeta(domain, code));

  Widget _buildTimeline(Map<String, dynamic> contract) {
    final status =
        (contract['contract_status'] ?? contract['status'])?.toString();
    final steps = <Map<String, dynamic>>[
      {
        'label': 'Khởi tạo & Ký kết',
        'date': formatDate(
            contract['contract_created_at'] ?? contract['start_date']),
        'done': true,
        'active': false,
      },
      {
        'label': 'Bàn giao & Hiệu lực',
        'date': formatDate(contract['start_date']),
        'done': true,
        'active': false,
      },
      {
        'label': status == 'RENEWAL_PENDING'
            ? 'Chờ duyệt gia hạn'
            : (status == 'TERMINATION_PENDING'
                ? 'Chờ duyệt chấm dứt'
                : 'Đang thực hiện'),
        'date': 'Hiện tại',
        'done': true,
        'active': true,
      },
      {
        'label': 'Đáo hạn hợp đồng',
        'date': formatDate(contract['end_date']),
        'done': false,
        'active': false,
      },
    ];

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const Text(
          'Tiến trình hợp đồng',
          style: TextStyle(
            fontFamily: 'Inter',
            fontSize: 11,
            fontWeight: FontWeight.w600,
            color: AppColors.slate500,
          ),
        ),
        const SizedBox(height: 10),
        LayoutBuilder(
          builder: (ctx, constraints) {
            final columns = constraints.maxWidth >= 600 ? 4 : 2;
            final itemWidth =
                (constraints.maxWidth / columns - 8).clamp(120.0, 260.0);
            return Wrap(
              spacing: 8,
              runSpacing: 8,
              children: steps.map((step) {
                final active = step['active'] == true;
                final done = step['done'] == true;
                return Container(
                  width: itemWidth,
                  padding: const EdgeInsets.all(10),
                  decoration: BoxDecoration(
                    color: active
                        ? AppColors.primary50
                        : (done ? AppColors.emerald50 : AppColors.slate50),
                    borderRadius: BorderRadius.circular(10),
                    border: Border.all(
                      color: active
                          ? AppColors.primary200
                          : (done ? AppColors.emerald200 : AppColors.slate200),
                    ),
                  ),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        children: [
                          Icon(
                            done ? LucideIcons.checkCircle2 : LucideIcons.clock,
                            size: 14,
                            color: active
                                ? AppColors.primary600
                                : (done
                                    ? AppColors.emerald600
                                    : AppColors.slate400),
                          ),
                          const SizedBox(width: 5),
                          Expanded(
                            child: Text(
                              step['label'] as String,
                              style: const TextStyle(
                                fontFamily: 'Inter',
                                fontSize: 11,
                                fontWeight: FontWeight.w600,
                                color: AppColors.slate800,
                              ),
                            ),
                          ),
                        ],
                      ),
                      const SizedBox(height: 4),
                      Text(
                        step['date'] as String,
                        style: const TextStyle(
                            fontSize: 10, color: AppColors.slate500),
                      ),
                    ],
                  ),
                );
              }).toList(),
            );
          },
        ),
      ],
    );
  }

  Widget _buildOccupantsGrid(List<Map<String, dynamic>> occupants) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          'Thành viên đăng ký ở cùng (${occupants.length})',
          style: const TextStyle(
            fontFamily: 'Inter',
            fontSize: 14,
            fontWeight: FontWeight.w600,
            color: AppColors.slate900,
          ),
        ),
        const SizedBox(height: 12),
        Wrap(
          spacing: 8,
          runSpacing: 8,
          children: occupants.map((occ) {
            final rawId = occ['id_number']?.toString() ?? '';
            return Container(
              width: 240,
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(
                color: AppColors.slate50,
                borderRadius: BorderRadius.circular(10),
                border: Border.all(color: AppColors.slate200),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    occ['full_name']?.toString() ?? 'Thành viên',
                    style: const TextStyle(
                      fontFamily: 'Inter',
                      fontSize: 13,
                      fontWeight: FontWeight.w600,
                      color: AppColors.slate800,
                    ),
                  ),
                  const SizedBox(height: 3),
                  Text(
                    occ['phone']?.toString() ?? '—',
                    style: const TextStyle(
                        fontSize: 12, color: AppColors.slate600),
                  ),
                  if (occ['email'] != null &&
                      occ['email'].toString().isNotEmpty)
                    Text(
                      occ['email']!.toString(),
                      style: const TextStyle(
                          fontSize: 11, color: AppColors.slate500),
                    ),
                  if (rawId.isNotEmpty)
                    Text(
                      'CCCD: ${maskIdNumber(rawId)}',
                      style: const TextStyle(
                          fontSize: 11, color: AppColors.slate400),
                    ),
                  const SizedBox(height: 6),
                  Wrap(
                    spacing: 6,
                    runSpacing: 4,
                    children: [
                      AppBadge(
                          label:
                              occ['relationship']?.toString() ?? 'Thành viên'),
                      if (occ['status'] != null)
                        _statusBadge(
                            occ['status']?.toString(), StatusDomain.tenant),
                    ],
                  ),
                ],
              ),
            );
          }).toList(),
        ),
      ],
    );
  }

  Widget _evidenceStrip(dynamic evidence, {Color? borderColor}) {
    final list = evidence is List ? evidence : const <dynamic>[];
    if (list.isEmpty) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.only(top: 6),
      child: Wrap(
        spacing: 6,
        children: list.map((ev) {
          final src = ev?.toString() ?? '';
          return Container(
            width: 44,
            height: 44,
            clipBehavior: Clip.antiAlias,
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(6),
              border: Border.all(color: borderColor ?? AppColors.slate200),
            ),
            child: src.isNotEmpty
                ? AuthImage(src: src, fit: BoxFit.cover)
                : const Icon(LucideIcons.fileText,
                    size: 16, color: AppColors.slate400),
          );
        }).toList(),
      ),
    );
  }

  Widget _settlementRow(String label, String value, {Color? valueColor}) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 2),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Expanded(
              child: Text(label,
                  style: const TextStyle(
                      fontSize: 12, color: AppColors.slate600))),
          const SizedBox(width: 8),
          Text(
            value,
            style: TextStyle(
              fontSize: 12,
              fontWeight: FontWeight.w600,
              color: valueColor ?? AppColors.slate800,
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildSettlementCard(Map<String, dynamic> sd) {
    final st = sd['settlement'] is Map
        ? Map<String, dynamic>.from(sd['settlement'] as Map)
        : <String, dynamic>{};
    final items = asResidentMapList(st['items']);
    final itemsTotal =
        items.fold<num>(0, (sum, it) => sum + _nonNegativeNum(it['amount']));
    final serviceDebt = _nonNegativeNum(st['outstanding_debt']);
    final refundRaw = st['refund_amount'];
    final expectedRefund = refundRaw != null
        ? _signedNum(refundRaw)
        : _nonNegativeNum(
            _nonNegativeNum(sd['amount_held']) - serviceDebt - itemsTotal);
    final rawThread =
        st['dispute_thread'] is List ? st['dispute_thread'] : st['thread'];
    final thread = asResidentMapList(rawThread);
    final disputeState = getResidentDisputeWindowState(sd);
    final canUpdateBank = canResidentUpdateRefundBankInfo(sd);
    final status = (sd['deposit_status'] ?? sd['status'])?.toString();
    final isFinalized = const [
      'REFUNDED',
      'PARTIALLY_REFUNDED',
      'DEDUCTED_FULL'
    ].contains(status);
    final heldBefore =
        st['deposit_held_before_settlement'] ?? sd['amount_held'] ?? 0;
    final rentDebt = _nonNegativeNum(st['rent_debt']);
    final shortfall = _nonNegativeNum(st['shortfall']);
    final refundMethod = st['refund_method']?.toString() ?? '';
    final bankInfo = _formatResidentBankInfo(st['bank_info']);
    final depositId = sd['deposit_id']?.toString() ?? '';

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
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Expanded(
                child: Wrap(
                  spacing: 6,
                  runSpacing: 4,
                  crossAxisAlignment: WrapCrossAlignment.center,
                  children: [
                    Text(
                      'Căn ${sd['apartment_code'] ?? '—'}${sd['building_name'] != null ? ' — ${sd['building_name']}' : ''}',
                      style: const TextStyle(
                        fontFamily: 'Inter',
                        fontSize: 14,
                        fontWeight: FontWeight.bold,
                        color: AppColors.slate900,
                      ),
                    ),
                    _statusBadge(status, StatusDomain.deposit),
                  ],
                ),
              ),
            ],
          ),
          if (sd['refund_due_date'] != null)
            Padding(
              padding: const EdgeInsets.only(top: 4),
              child: Text(
                'Hạn hoàn cọc theo quy định: ${formatDate(sd['refund_due_date'])}',
                style: const TextStyle(fontSize: 12, color: AppColors.slate500),
              ),
            ),
          const SizedBox(height: 10),
          Wrap(
            spacing: 8,
            runSpacing: 6,
            children: [
              AppButton(
                text: 'Xem / In bảng kê',
                size: AppButtonSize.xs,
                variant: AppButtonVariant.outline,
                icon: const Icon(LucideIcons.printer, size: 13),
                onPressed: () => _handleViewSettlementPdf(depositId),
              ),
              if (canUpdateBank)
                AppButton(
                  text: 'Cập nhật TK nhận hoàn cọc',
                  size: AppButtonSize.xs,
                  icon: const Icon(LucideIcons.landmark, size: 13),
                  onPressed: () => _openDepositBankModal(context, sd),
                ),
              if (disputeState.canDispute)
                AppButton(
                  text: disputeState.daysRemaining != null
                      ? 'Khiếu nại bảng kê (còn ${disputeState.daysRemaining} ngày)'
                      : 'Không đồng ý / Khiếu nại',
                  size: AppButtonSize.xs,
                  variant: AppButtonVariant.danger,
                  icon: const Icon(LucideIcons.shieldAlert, size: 13),
                  onPressed: () => _openDisputeModal(context, sd),
                )
              else if (disputeState.lockedReason == 'FINALIZED')
                const AppBadge(label: 'Đã chốt giải quyết khiếu nại')
              else if (disputeState.lockedReason == 'EXPIRED')
                const AppBadge(label: 'Đã hết thời hạn khiếu nại 7 ngày'),
            ],
          ),
          if (status == 'APPROVED_PENDING_PAYOUT')
            _settlementNotice(
              'Chủ nhà đã duyệt bảng kê — Ban quản lý đang thực hiện chuyển khoản hoàn cọc',
              AppColors.secondary50,
              AppColors.secondary700,
            ),
          if (status == 'RETURNED')
            _settlementNotice(
              'Ngân hàng hoàn trả lệnh chuyển tiền — vui lòng cập nhật lại tài khoản thụ hưởng'
              '${st['return_reason'] != null ? '\nLý do ngân hàng thông báo: ${st['return_reason']}' : ''}',
              AppColors.amber50,
              AppColors.amber900,
            ),
          const SizedBox(height: 12),
          if (items.isEmpty)
            Container(
              padding: const EdgeInsets.all(10),
              decoration: BoxDecoration(
                color: AppColors.emerald50,
                borderRadius: BorderRadius.circular(10),
                border: Border.all(color: AppColors.emerald200),
              ),
              child: const Text(
                'Không phát sinh khấu trừ hư hỏng hay vệ sinh mặt bằng khi bàn giao.',
                style: TextStyle(fontSize: 12, color: AppColors.emerald700),
              ),
            )
          else ...[
            Text(
              'Các khoản khấu trừ bàn giao (${items.length})',
              style: const TextStyle(
                fontFamily: 'Inter',
                fontSize: 12,
                fontWeight: FontWeight.w600,
                color: AppColors.slate700,
              ),
            ),
            const SizedBox(height: 6),
            ...items.map((it) {
              final category = it['category']?.toString() ?? '';
              return Container(
                margin: const EdgeInsets.only(bottom: 6),
                padding: const EdgeInsets.all(10),
                decoration: BoxDecoration(
                  color: Colors.white,
                  borderRadius: BorderRadius.circular(10),
                  border: Border.all(color: AppColors.slate200),
                ),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      mainAxisAlignment: MainAxisAlignment.spaceBetween,
                      children: [
                        AppBadge(
                          label: kResidentDeductCategoryLabels[category] ??
                              category,
                          variant: AppBadgeVariant.amber,
                        ),
                        Text(
                          '- ${formatMoney(it['amount'])}',
                          style: const TextStyle(
                            fontSize: 12,
                            fontWeight: FontWeight.bold,
                            color: AppColors.rose600,
                          ),
                        ),
                      ],
                    ),
                    if (it['description'] != null &&
                        it['description'].toString().isNotEmpty)
                      Padding(
                        padding: const EdgeInsets.only(top: 6),
                        child: Text(
                          it['description']!.toString(),
                          style: const TextStyle(
                              fontSize: 12, color: AppColors.slate700),
                        ),
                      ),
                    _evidenceStrip(it['evidence']),
                  ],
                ),
              );
            }),
          ],
          const SizedBox(height: 10),
          Container(
            padding: const EdgeInsets.all(12),
            decoration: BoxDecoration(
              color: Colors.white,
              borderRadius: BorderRadius.circular(10),
              border: Border.all(color: AppColors.primary200),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                _settlementRow(
                  'Tiền đặt cọc bảo lưu trước tất toán:',
                  formatMoney(heldBefore),
                ),
                _settlementRow(
                  'Đối trừ nợ dịch vụ / điện nước:',
                  '- ${formatMoney(serviceDebt)}',
                  valueColor: AppColors.amber700,
                ),
                _settlementRow(
                  'Tổng khấu trừ hư hỏng / vệ sinh:',
                  '- ${formatMoney(itemsTotal)}',
                  valueColor: AppColors.amber700,
                ),
                if (rentDebt > 0)
                  _settlementRow(
                    'Công nợ tiền thuê (KHÔNG trừ vào cọc — thanh toán riêng):',
                    formatMoney(rentDebt),
                    valueColor: AppColors.rose600,
                  ),
                const Divider(height: 12, color: AppColors.slate100),
                _settlementRow(
                  isFinalized
                      ? 'Số tiền hoàn trả thực tế:'
                      : 'Số tiền hoàn trả dự kiến:',
                  formatMoney(expectedRefund),
                  valueColor: AppColors.emerald600,
                ),
                if (shortfall > 0)
                  _settlementRow(
                    'Khoản phải thu bổ sung sau trả phòng:',
                    formatMoney(shortfall),
                    valueColor: AppColors.rose700,
                  ),
                if (refundMethod.isNotEmpty)
                  _settlementRow(
                    'Hình thức hoàn cọc:',
                    kPaymentMethodLabels[refundMethod.toUpperCase()] ??
                        refundMethod,
                  ),
                if (bankInfo.isNotEmpty)
                  _settlementRow('Tài khoản nhận hoàn cọc:', bankInfo),
                if (st['approved_at'] != null)
                  _settlementRow(
                    'Xác nhận quyết toán lúc:',
                    formatDateTime(st['approved_at']),
                  ),
                if (st['payout_reference_code'] != null)
                  _settlementRow(
                    'Mã tham chiếu chuyển khoản (UNC):',
                    st['payout_reference_code']!.toString(),
                    valueColor: AppColors.secondary700,
                  ),
                if (st['payout_evidence'] is List &&
                    (st['payout_evidence'] as List).isNotEmpty)
                  Padding(
                    padding: const EdgeInsets.only(top: 6),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        const Text(
                          'Chứng từ chuyển khoản hoàn cọc (UNC):',
                          style: TextStyle(
                              fontSize: 12,
                              fontWeight: FontWeight.w600,
                              color: AppColors.slate700),
                        ),
                        _evidenceStrip(st['payout_evidence'],
                            borderColor: AppColors.primary300),
                      ],
                    ),
                  ),
                if (st['rejection_reason'] != null)
                  Padding(
                    padding: const EdgeInsets.only(top: 6),
                    child: Text(
                      'Ghi chú yêu cầu điều chỉnh lại bảng kê: ${st['rejection_reason']}',
                      style: const TextStyle(
                          fontSize: 12, color: AppColors.amber900),
                    ),
                  ),
              ],
            ),
          ),
          if (st['dispute_reason'] != null || thread.isNotEmpty)
            Container(
              margin: const EdgeInsets.only(top: 10),
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(
                color: AppColors.rose50,
                borderRadius: BorderRadius.circular(10),
                border: Border.all(color: AppColors.rose200),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Row(
                    children: [
                      Icon(LucideIcons.shieldAlert,
                          size: 14, color: AppColors.rose600),
                      SizedBox(width: 6),
                      Text(
                        'Lịch sử khiếu nại & phản hồi giải quyết',
                        style: TextStyle(
                          fontFamily: 'Inter',
                          fontSize: 12,
                          fontWeight: FontWeight.w600,
                          color: AppColors.rose800,
                        ),
                      ),
                    ],
                  ),
                  if (st['dispute_reason'] != null && thread.isEmpty)
                    Padding(
                      padding: const EdgeInsets.only(top: 6),
                      child: Text(
                        st['dispute_reason']!.toString(),
                        style: const TextStyle(
                            fontSize: 12, color: AppColors.rose800),
                      ),
                    ),
                  ...thread.map((msg) {
                    final isResident = msg['role']?.toString() == 'RESIDENT';
                    return Container(
                      margin: const EdgeInsets.only(top: 6),
                      padding: const EdgeInsets.all(8),
                      decoration: BoxDecoration(
                        color: Colors.white,
                        borderRadius: BorderRadius.circular(8),
                        border: Border.all(color: AppColors.rose100),
                      ),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Row(
                            mainAxisAlignment: MainAxisAlignment.spaceBetween,
                            children: [
                              AppBadge(
                                label:
                                    isResident ? 'Bạn (Cư dân)' : 'Ban Quản Lý',
                                variant: isResident
                                    ? AppBadgeVariant.amber
                                    : AppBadgeVariant.indigo,
                              ),
                              Text(
                                formatDateTime(msg['at']),
                                style: const TextStyle(
                                    fontSize: 10, color: AppColors.slate500),
                              ),
                            ],
                          ),
                          const SizedBox(height: 4),
                          Text(
                            msg['message']?.toString() ?? '',
                            style: const TextStyle(
                                fontSize: 12, color: AppColors.slate800),
                          ),
                        ],
                      ),
                    );
                  }),
                ],
              ),
            ),
        ],
      ),
    );
  }

  Widget _settlementNotice(String text, Color bg, Color fg) => Container(
        margin: const EdgeInsets.only(top: 8),
        padding: const EdgeInsets.all(12),
        decoration: BoxDecoration(
          color: bg,
          borderRadius: BorderRadius.circular(10),
          border: Border.all(color: fg.withValues(alpha: 0.25)),
        ),
        child: Text(text, style: TextStyle(fontSize: 12, color: fg)),
      );

  Widget _buildAmendmentsCard(List<Map<String, dynamic>> amendments) {
    const fieldLabels = <String, String>{
      'rent_amount': 'Giá thuê hàng tháng',
      'deposit_amount': 'Tiền đặt cọc',
      'end_date': 'Ngày kết thúc HĐ',
      'start_date': 'Ngày bắt đầu HĐ',
      'billing_day': 'Ngày chốt kỳ',
      'payment_due_days': 'Hạn thanh toán (ngày)',
      'note': 'Ghi chú',
    };
    const metaKeys = <String>{
      'status',
      'snapshot',
      'created_by',
      'approved_at',
      'approved_by',
      'created_at',
      'rejected_by',
      'rejected_at',
      'rejection_reason',
    };

    return AppCard(
      header: const AppCardHeader(
        title: 'Phụ lục điều chỉnh hợp đồng',
        subtitle: 'Các phụ lục thay đổi điều khoản đã được phê duyệt',
      ),
      padding: const EdgeInsets.all(16),
      borderRadius: BorderRadius.circular(16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: amendments.isEmpty
            ? [
                _emptyHint('Chưa có phụ lục điều chỉnh'),
                _emptyHint(
                    'Hợp đồng hiện giữ nguyên các điều khoản gốc từ khi ký kết.'),
              ]
            : amendments.map((am) {
                final diff = am['diff'] is Map
                    ? Map<String, dynamic>.from(am['diff'] as Map)
                    : <String, dynamic>{};
                final status = diff['status']?.toString();
                final isInitial = status == 'INITIAL_SNAPSHOT';
                final statusLabel = isInitial
                    ? 'Hiệu lực gốc'
                    : (status == 'APPROVED'
                        ? 'Đã phê duyệt'
                        : (status == 'REJECTED' ? 'Từ chối' : 'Chờ duyệt'));
                return Container(
                  margin: const EdgeInsets.only(bottom: 10),
                  padding: const EdgeInsets.all(12),
                  decoration: BoxDecoration(
                    color: AppColors.slate50,
                    borderRadius: BorderRadius.circular(10),
                    border: Border.all(color: AppColors.slate200),
                  ),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Wrap(
                        spacing: 6,
                        runSpacing: 4,
                        crossAxisAlignment: WrapCrossAlignment.center,
                        children: [
                          AppBadge(
                            label: isInitial
                                ? 'Phiên bản gốc #${am['version_no'] ?? '—'}'
                                : 'Phụ lục lần #${am['version_no'] ?? '—'}',
                            variant: AppBadgeVariant.indigo,
                          ),
                          if (status != null)
                            AppBadge(
                              label: statusLabel,
                              variant: isInitial || status == 'APPROVED'
                                  ? AppBadgeVariant.emerald
                                  : (status == 'REJECTED'
                                      ? AppBadgeVariant.red
                                      : AppBadgeVariant.amber),
                            ),
                          Text(
                            'Hiệu lực: ${formatDate(am['effective_from'])}',
                            style: const TextStyle(
                                fontSize: 11, color: AppColors.slate500),
                          ),
                        ],
                      ),
                      if (am['reason'] != null)
                        Padding(
                          padding: const EdgeInsets.only(top: 6),
                          child: Text(
                            am['reason']!.toString(),
                            style: const TextStyle(
                              fontSize: 12,
                              fontWeight: FontWeight.w500,
                              color: AppColors.slate700,
                            ),
                          ),
                        ),
                      if (diff['rejection_reason'] != null)
                        Padding(
                          padding: const EdgeInsets.only(top: 6),
                          child: Text(
                            'Lý do từ chối: ${diff['rejection_reason']}',
                            style: const TextStyle(
                                fontSize: 12, color: AppColors.rose700),
                          ),
                        ),
                      ...diff.entries
                          .where((e) => !metaKeys.contains(e.key))
                          .map((e) {
                        final v = e.value;
                        final isObj = v is Map;
                        final from = isObj ? (v['old'] ?? v['from']) : null;
                        final to = isObj ? (v['new'] ?? v['to']) : v;
                        return Padding(
                          padding: const EdgeInsets.only(top: 4),
                          child: _settlementRow(
                            '${fieldLabels[e.key] ?? e.key}:',
                            '${from != null ? '${_formatDiffValue(e.key, from)} → ' : ''}${_formatDiffValue(e.key, to)}',
                          ),
                        );
                      }),
                    ],
                  ),
                );
              }).toList(),
      ),
    );
  }

  Widget _buildHistoryCard(
      List<Map<String, dynamic>> history, String? currentId) {
    return AppCard(
      header: const AppCardHeader(
        title: 'Chuỗi lịch sử hợp đồng',
        subtitle: 'Toàn bộ các kỳ hợp đồng gốc và gia hạn nối tiếp',
      ),
      padding: const EdgeInsets.all(16),
      borderRadius: BorderRadius.circular(16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: history.isEmpty
            ? [
                _emptyHint('Chưa có lịch sử hợp đồng'),
                _emptyHint('Các hợp đồng đã ký sẽ hiển thị tại đây.'),
              ]
            : history.map((ch) {
                final id =
                    ch['id']?.toString() ?? ch['contract_id']?.toString() ?? '';
                final shortId = id.length >= 8
                    ? id.substring(0, 8).toUpperCase()
                    : id.toUpperCase();
                final parentId = ch['parent_contract_id']?.toString() ?? '';
                final parentShort = parentId.length >= 8
                    ? parentId.substring(0, 8).toUpperCase()
                    : parentId.toUpperCase();
                final isCurrent = id.isNotEmpty && id == currentId;
                return Container(
                  margin: const EdgeInsets.only(bottom: 10),
                  padding: const EdgeInsets.all(12),
                  decoration: BoxDecoration(
                    color: isCurrent ? AppColors.primary50 : Colors.white,
                    borderRadius: BorderRadius.circular(10),
                    border: Border.all(
                      color:
                          isCurrent ? AppColors.primary300 : AppColors.slate200,
                    ),
                  ),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        mainAxisAlignment: MainAxisAlignment.spaceBetween,
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Expanded(
                            child: Wrap(
                              spacing: 6,
                              runSpacing: 4,
                              crossAxisAlignment: WrapCrossAlignment.center,
                              children: [
                                Text(
                                  'HĐ #$shortId — Căn ${ch['apartment_code'] ?? '—'}',
                                  style: const TextStyle(
                                    fontFamily: 'Inter',
                                    fontSize: 12,
                                    fontWeight: FontWeight.bold,
                                    color: AppColors.slate900,
                                  ),
                                ),
                                _statusBadge(
                                  (ch['status'] ?? ch['contract_status'])
                                      ?.toString(),
                                  StatusDomain.contract,
                                ),
                              ],
                            ),
                          ),
                          AppButton(
                            text: 'Bản in',
                            size: AppButtonSize.xs,
                            variant: AppButtonVariant.ghost,
                            icon: const Icon(LucideIcons.printer, size: 13),
                            onPressed: () => _handleViewA4Contract(id),
                          ),
                        ],
                      ),
                      if (ch['building_name'] != null)
                        Text(
                          ch['building_name']!.toString(),
                          style: const TextStyle(
                              fontSize: 11, color: AppColors.slate500),
                        ),
                      const SizedBox(height: 6),
                      Text(
                        '${formatDate(ch['start_date'])} → ${formatDate(ch['end_date'])}'
                        '${ch['terminated_at'] != null ? ' (Thanh lý: ${formatDate(ch['terminated_at'])})' : ''}',
                        style: const TextStyle(
                            fontSize: 11, color: AppColors.slate600),
                      ),
                      Text(
                        '${formatMoney(ch['rent_amount'])}/tháng',
                        style: const TextStyle(
                          fontSize: 11,
                          fontWeight: FontWeight.w600,
                          color: AppColors.slate800,
                        ),
                      ),
                      if (ch['deposit_amount'] != null ||
                          ch['deposit_status'] != null)
                        Wrap(
                          spacing: 6,
                          crossAxisAlignment: WrapCrossAlignment.center,
                          children: [
                            Text(
                              'Tiền cọc: ${formatMoney(ch['deposit_amount'] ?? 0)}',
                              style: const TextStyle(
                                  fontSize: 11, color: AppColors.slate600),
                            ),
                            if (ch['deposit_status'] != null)
                              _statusBadge(ch['deposit_status']?.toString(),
                                  StatusDomain.deposit),
                          ],
                        ),
                      if (ch['parent_contract_id'] != null)
                        Text(
                          '↳ Gia hạn / Chuyển tiếp từ HĐ #$parentShort',
                          style: const TextStyle(
                              fontSize: 11, color: AppColors.secondary700),
                        ),
                    ],
                  ),
                );
              }).toList(),
      ),
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
              const Icon(LucideIcons.fileText,
                  size: 48, color: AppColors.slate400),
              const SizedBox(height: 12),
              const Text(
                'Chưa có hợp đồng thuê',
                style: TextStyle(
                  fontFamily: 'Inter',
                  fontSize: 16,
                  fontWeight: FontWeight.w600,
                  color: AppColors.slate800,
                ),
              ),
              const SizedBox(height: 6),
              const Text(
                'Bạn hiện chưa có hợp đồng thuê căn hộ nào. Hãy chọn căn hộ trống tại mục Tổng quan để gửi hồ sơ đăng ký thuê.',
                textAlign: TextAlign.center,
                style: TextStyle(fontSize: 13, color: AppColors.slate500),
              ),
              const SizedBox(height: 16),
              AppButton(
                text: 'Xem căn hộ trống',
                onPressed: () => widget.onNavigateTab('overview'),
              ),
            ],
          ),
        ),
      );
    }

    final rawOccupants = _occupants.isNotEmpty
        ? _occupants
        : (contract['occupants'] is List
            ? contract['occupants'] as List
            : const []);
    final occupants = rawOccupants.whereType<Map<String, dynamic>>().toList();
    final rawContractId =
        (contract['contract_id'] ?? contract['id'])?.toString() ?? '';
    final contractCode = contract['contract_code']?.toString() ??
        (rawContractId.length >= 8
            ? 'HĐ-${rawContractId.substring(0, 8).toUpperCase()}'
            : (rawContractId.isNotEmpty ? 'HĐ-$rawContractId' : '---'));
    final isContractActive =
        (contract['contract_status'] ?? contract['status']) == 'ACTIVE';
    final contractHistory =
        asResidentMapList(widget.overview?['contract_history']);
    final amendments = asResidentMapList(widget.overview?['amendments']);
    final settlementDeposits = resolveResidentSettlementDeposits(
      overview: widget.overview,
      contract: contract,
      contractHistory: contractHistory,
      deposits: _deposits,
    );
    final billingCycle = kResidentBillingCycleLabels[
            contract['billing_cycle']?.toString().toUpperCase() ?? 'MONTHLY'] ??
        'hàng tháng';

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
                        'Hợp đồng thuê: $contractCode',
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
                        onPressed: () => _handleViewA4Contract(),
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
                        label:
                            isContractActive ? 'Đang hiệu lực' : 'Đang xử lý',
                        variant: isContractActive
                            ? AppBadgeVariant.emerald
                            : AppBadgeVariant.amber,
                      ),
                    ],
                  ),
                  const SizedBox(height: 12),
                  const Divider(color: AppColors.slate100, height: 1),
                  const SizedBox(height: 12),
                  _buildTimeline(contract),
                  const SizedBox(height: 12),
                  const Divider(color: AppColors.slate100, height: 1),
                  const SizedBox(height: 12),
                  Wrap(
                    spacing: 24,
                    runSpacing: 8,
                    children: [
                      _buildInfoItem(
                          'Ngày bắt đầu', formatDate(contract['start_date'])),
                      _buildInfoItem(
                          'Ngày kết thúc', formatDate(contract['end_date'])),
                      _buildInfoItem(
                          'Giá thuê hàng tháng',
                          formatMoney(contract['rent_amount'] ??
                              contract['monthly_rent'])),
                      _buildInfoItem('Tiền cọc quy định',
                          formatMoney(contract['deposit_amount'])),
                      _buildInfoItem(
                        'Ngày chốt hóa đơn',
                        'Ngày ${contract['billing_day'] ?? 1} $billingCycle',
                      ),
                      _buildInfoItem(
                        'Hạn thanh toán',
                        '${contract['payment_due_days'] ?? 5} ngày sau phát hành',
                      ),
                    ],
                  ),
                  if (contract['contract_note'] != null &&
                      contract['contract_note'].toString().isNotEmpty)
                    Container(
                      margin: const EdgeInsets.only(top: 12),
                      padding: const EdgeInsets.all(10),
                      decoration: BoxDecoration(
                        color: AppColors.slate50,
                        borderRadius: BorderRadius.circular(10),
                        border: Border.all(color: AppColors.slate200),
                      ),
                      child: Text(
                        'Ghi chú hợp đồng: ${contract['contract_note']}',
                        style: const TextStyle(
                            fontSize: 12, color: AppColors.slate600),
                      ),
                    ),
                  if (isContractActive) ...[
                    const SizedBox(height: 16),
                    Wrap(
                      spacing: 8,
                      runSpacing: 6,
                      alignment: WrapAlignment.end,
                      children: [
                        AppButton(
                          text: 'Xin gia hạn HĐ',
                          size: AppButtonSize.sm,
                          icon: const Icon(LucideIcons.refreshCw, size: 14),
                          onPressed: () => _openCreateContractRequestModal(
                              context, 'RENEWAL'),
                        ),
                        AppButton(
                          text: 'Xin chấm dứt trước hạn',
                          size: AppButtonSize.sm,
                          variant: AppButtonVariant.outline,
                          icon: const Icon(LucideIcons.logOut, size: 14),
                          onPressed: () => _openCreateContractRequestModal(
                              context, 'TERMINATION'),
                        ),
                      ],
                    ),
                  ],
                ],
              ),
            ),
            const SizedBox(height: 16),

            // Occupants grid with phone / email / status
            Container(
              decoration: BoxDecoration(
                color: Colors.white,
                borderRadius: BorderRadius.circular(16),
                border: Border.all(color: AppColors.slate200),
              ),
              padding: const EdgeInsets.all(16),
              child: occupants.isEmpty
                  ? _emptyHint('Chưa có danh sách thành viên đi kèm.')
                  : _buildOccupantsGrid(occupants),
            ),
            const SizedBox(height: 16),

            // Bảng kê tất toán tiền cọc (settlement detail, deductions, evidence, dispute thread)
            if (settlementDeposits.isNotEmpty) ...[
              AppCard(
                header: const AppCardHeader(
                  title: 'Bảng kê tất toán tiền cọc',
                  subtitle:
                      'Chi tiết đối trừ công nợ dịch vụ, khấu trừ bàn giao và số tiền hoàn trả dự kiến / thực tế',
                ),
                padding: const EdgeInsets.all(16),
                borderRadius: BorderRadius.circular(16),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children:
                      settlementDeposits.map(_buildSettlementCard).toList(),
                ),
              ),
              const SizedBox(height: 16),
            ],

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
                      final dep = d is Map
                          ? Map<String, dynamic>.from(d)
                          : <String, dynamic>{};
                      final disputeState = getResidentDisputeWindowState(dep);
                      final canUpdateBank =
                          canResidentUpdateRefundBankInfo(dep);
                      final depId = dep['deposit_id']?.toString() ??
                          dep['id']?.toString() ??
                          '';

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
                                  dep['deposit_code']?.toString() ??
                                      'Khoản cọc',
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
                            if (disputeState.canDispute &&
                                disputeState.daysRemaining != null)
                              Container(
                                padding: const EdgeInsets.symmetric(
                                    horizontal: 10, vertical: 6),
                                margin: const EdgeInsets.only(bottom: 8),
                                decoration: BoxDecoration(
                                  color: Colors.amber.shade50,
                                  borderRadius: BorderRadius.circular(8),
                                  border:
                                      Border.all(color: Colors.amber.shade300),
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
                                  icon: const Icon(LucideIcons.fileSpreadsheet,
                                      size: 14),
                                  onPressed: () =>
                                      _handleViewSettlementPdf(depId),
                                ),
                                if (disputeState.canDispute) ...[
                                  const SizedBox(width: 8),
                                  AppButton(
                                    text: 'Khiếu nại cọc',
                                    size: AppButtonSize.sm,
                                    variant: AppButtonVariant.danger,
                                    icon: const Icon(LucideIcons.alertTriangle,
                                        size: 14),
                                    onPressed: () =>
                                        _openDisputeModal(context, dep),
                                  ),
                                ],
                                if (canUpdateBank) ...[
                                  const SizedBox(width: 8),
                                  AppButton(
                                    text: 'Tài khoản nhận hoàn',
                                    size: AppButtonSize.sm,
                                    icon: const Icon(LucideIcons.creditCard,
                                        size: 14),
                                    onPressed: () =>
                                        _openDepositBankModal(context, dep),
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
                    const Text(
                      'Đề nghị Gia hạn / Chấm dứt đã gửi',
                      style: TextStyle(
                        fontFamily: 'Inter',
                        fontSize: 14,
                        fontWeight: FontWeight.w600,
                        color: AppColors.slate900,
                      ),
                    ),
                    const SizedBox(height: 4),
                    const Text(
                      'Theo dõi phản hồi từ Ban Quản Lý đối với các đề nghị hợp đồng của bạn',
                      style: TextStyle(fontSize: 12, color: AppColors.slate500),
                    ),
                    const SizedBox(height: 12),
                    ..._contractRequests.map((r) {
                      final req = r is Map ? r : const {};
                      final type =
                          (req['request_type'] ?? req['type'])?.toString() ??
                              'Yêu cầu';
                      final note =
                          (req['note'] ?? req['reason'])?.toString() ?? '';
                      final status = req['status']?.toString() ?? 'SUBMITTED';
                      final statusLabel = const {
                            'SUBMITTED': 'Chờ BQL xử lý',
                            'APPROVED': 'Đã chấp thuận',
                            'REJECTED': 'Từ chối',
                            'CANCELLED': 'Đã hủy',
                          }[status] ??
                          status;
                      return Padding(
                        padding: const EdgeInsets.only(bottom: 8),
                        child: Row(
                          mainAxisAlignment: MainAxisAlignment.spaceBetween,
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Expanded(
                              child: Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  Text(
                                    type == 'RENEWAL'
                                        ? 'Xin gia hạn HĐ'
                                        : (type == 'TERMINATION'
                                            ? 'Xin chấm dứt HĐ trước hạn'
                                            : type),
                                    style: const TextStyle(
                                      fontFamily: 'Inter',
                                      fontSize: 13,
                                      fontWeight: FontWeight.w600,
                                      color: AppColors.slate800,
                                    ),
                                  ),
                                  if (note.isNotEmpty)
                                    Text(
                                      note,
                                      style: const TextStyle(
                                        fontSize: 12,
                                        color: AppColors.slate600,
                                      ),
                                    ),
                                ],
                              ),
                            ),
                            const SizedBox(width: 8),
                            AppBadge(label: statusLabel),
                          ],
                        ),
                      );
                    }),
                  ],
                ),
              ),
            ],

            const SizedBox(height: 16),
            _buildAmendmentsCard(amendments),
            const SizedBox(height: 16),
            _buildHistoryCard(contractHistory, rawContractId),
          ],
        ),
      ),
    );
  }
}
