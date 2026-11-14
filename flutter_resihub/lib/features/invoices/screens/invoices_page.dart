import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../../../core/constants/statuses.dart';
import '../../../core/theme/app_colors.dart';
import '../../../core/utils/billing_helpers.dart';
import '../../../core/utils/file_exporter.dart';
import '../../../core/utils/format.dart';
import '../../../core/utils/validation.dart';
import '../../../shared/providers/toast_provider.dart';
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
import '../../auth/providers/auth_provider.dart';
import '../../auth/providers/permission_provider.dart';
import '../../buildings/services/buildings_service.dart';
import '../services/invoices_service.dart';

const Map<String, String> kInvoiceStatusOptions = {
  'DRAFT': 'Bản nháp',
  'ISSUED': 'Đã phát hành',
  'PARTIALLY_PAID': 'Thanh toán một phần',
  'PAID': 'Đã thanh toán',
  'OVERDUE': 'Quá hạn',
  'ADJUSTED': 'Đã điều chỉnh',
  'VOID': 'Đã hủy',
};

/// Quản lý Hóa đơn Kỳ (M09).
/// Port of `frontend/src/pages/admin/invoices/InvoicesPage.jsx`.
class InvoicesPage extends ConsumerStatefulWidget {
  const InvoicesPage({super.key});

  @override
  ConsumerState<InvoicesPage> createState() => _InvoicesPageState();
}

class _InvoicesPageState extends ConsumerState<InvoicesPage> {
  List<Map<String, dynamic>> _invoices = [];
  Map<String, dynamic> _summary = {
    'total_billed': 0,
    'total_paid': 0,
    'total_unpaid': 0,
  };
  bool _loading = true;

  // Filters
  String _period = getCurrentPeriod();
  String _statusFilter = '';
  String _search = '';
  Timer? _debounceTimer;

  // 4-eyes queue
  List<Map<String, dynamic>> _pendingAdjustments = [];
  bool _adjustmentsLoading = false;
  bool _showAdjustmentsModal = false;

  // Batch generation modal
  bool _batchOpen = false;
  List<Map<String, dynamic>> _buildings = [];
  String _batchPeriod = getCurrentPeriod();
  String _batchBuildingId = '';
  bool _autoIssue = false;
  bool _generating = false;
  String? _issuingId;

  // Batch generation report result
  Map<String, dynamic>? _batchResult;

  @override
  void initState() {
    super.initState();
    _loadInitialData();
  }

  @override
  void dispose() {
    _debounceTimer?.cancel();
    super.dispose();
  }

  void _loadInitialData() {
    final buildingId = ref.read(authProvider).selectedBuildingId;
    final initial = ref.read(invoicesServiceProvider).peekList({
      if (buildingId.isNotEmpty) 'building_id': buildingId,
      if (_period.isNotEmpty) 'period': _period,
    });

    if (initial is Map && initial['data'] is List) {
      _invoices = (initial['data'] as List)
          .whereType<Map>()
          .map((e) => Map<String, dynamic>.from(e))
          .toList();
      if (initial['summary'] is Map) {
        _summary = Map<String, dynamic>.from(initial['summary'] as Map);
      }
      _loading = false;
    }
    _fetchInvoices();
    _fetchAdjustmentsQueue();
  }

  Future<void> _fetchInvoices({bool force = false}) async {
    final buildingId = ref.read(authProvider).selectedBuildingId;
    final params = {
      if (buildingId.isNotEmpty) 'building_id': buildingId,
      if (_period.isNotEmpty) 'period': _period,
      if (_statusFilter.isNotEmpty) 'status': _statusFilter,
      if (_search.trim().isNotEmpty) 'search': _search.trim(),
    };

    if (!force) {
      final cached = ref.read(invoicesServiceProvider).peekList(params);
      if (cached is Map && cached['data'] is List) {
        setState(() {
          _invoices = (cached['data'] as List)
              .whereType<Map>()
              .map((e) => Map<String, dynamic>.from(e))
              .toList();
          if (cached['summary'] is Map) {
            _summary = Map<String, dynamic>.from(cached['summary'] as Map);
          }
          _loading = false;
        });
      }
    }

    try {
      final res = await ref.read(invoicesServiceProvider).list(params, force);
      if (!mounted) return;

      if (res is Map && res['data'] is List) {
        setState(() {
          _invoices = (res['data'] as List)
              .whereType<Map>()
              .map((e) => Map<String, dynamic>.from(e))
              .toList();
          if (res['summary'] is Map) {
            _summary = Map<String, dynamic>.from(res['summary'] as Map);
          }
          _loading = false;
        });
      } else {
        setState(() {
          _invoices = [];
          _loading = false;
        });
      }
    } catch (err) {
      if (mounted) {
        setState(() => _loading = false);
        ref.read(toastProvider.notifier).error(
              extractErrorMessage(err, 'Không thể tải danh sách hóa đơn.'),
            );
      }
    }
  }

  Future<void> _fetchAdjustmentsQueue() async {
    setState(() => _adjustmentsLoading = true);
    final buildingId = ref.read(authProvider).selectedBuildingId;
    try {
      final res = await ref.read(invoicesServiceProvider).getAdjustments({
        'status': 'PENDING_APPROVAL',
        if (buildingId.isNotEmpty) 'building_id': buildingId,
      });
      if (!mounted) return;
      if (res is Map && res['data'] is List) {
        setState(() {
          _pendingAdjustments = (res['data'] as List)
              .whereType<Map>()
              .map((e) => Map<String, dynamic>.from(e))
              .toList();
          _adjustmentsLoading = false;
        });
      } else {
        setState(() {
          _pendingAdjustments = [];
          _adjustmentsLoading = false;
        });
      }
    } catch (err) {
      if (mounted) {
        setState(() {
          _pendingAdjustments = [];
          _adjustmentsLoading = false;
        });
        ref.read(toastProvider.notifier).error(
              extractErrorMessage(err, 'Không thể tải hàng đợi điều chỉnh hóa đơn.'),
            );
      }
    }
  }

  void _onSearchChanged(String val) {
    _debounceTimer?.cancel();
    _debounceTimer = Timer(const Duration(milliseconds: 250), () {
      if (mounted) {
        setState(() => _search = val);
        _fetchInvoices();
      }
    });
  }

  Future<void> _openBatchModal() async {
    final buildingId = ref.read(authProvider).selectedBuildingId;
    setState(() {
      _batchPeriod = _period.isNotEmpty ? _period : getCurrentPeriod();
      _batchBuildingId = buildingId;
      _autoIssue = false;
      _batchOpen = true;
    });

    try {
      final res = await ref.read(buildingsServiceProvider).list();
      if (!mounted) return;
      if (res is Map && res['data'] is List) {
        setState(() {
          _buildings = (res['data'] as List)
              .whereType<Map>()
              .map((e) => Map<String, dynamic>.from(e))
              .toList();
        });
      }
    } catch (err) {
      if (mounted) {
        setState(() => _buildings = []);
        ref.read(toastProvider.notifier).error(
              extractErrorMessage(err, 'Không thể tải danh sách tòa nhà.'),
            );
      }
    }
  }

  Future<void> _handleGenerateBatch() async {
    if (_batchPeriod.isEmpty) {
      ref.read(toastProvider.notifier).warning('Vui lòng chọn kỳ thanh toán cần sinh hóa đơn.');
      return;
    }

    setState(() => _generating = true);
    final buildingId = ref.read(authProvider).selectedBuildingId;
    try {
      final payload = {
        'period': _batchPeriod,
        'auto_issue': _autoIssue,
        if ((_batchBuildingId.isNotEmpty ? _batchBuildingId : buildingId).isNotEmpty)
          'building_id': _batchBuildingId.isNotEmpty ? _batchBuildingId : buildingId,
      };
      final res = await ref.read(invoicesServiceProvider).generateBatch(payload);
      if (!mounted) return;

      final resMap = res is Map ? Map<String, dynamic>.from(res) : <String, dynamic>{};
      final skipped = resMap['skipped_contracts'];
      final skipSummary = summarizeSkippedContracts(skipped);

      if (skipSummary.totalSkipped > 0) {
        ref.read(toastProvider.notifier).warning(
              '${resMap['message'] ?? 'Đã xử lý sinh hóa đơn hàng loạt.'} (${skipSummary.message})',
            );
      } else {
        ref.read(toastProvider.notifier).success(
              (resMap['message'] ?? 'Đã xử lý sinh hóa đơn hàng loạt.').toString(),
            );
      }

      setState(() {
        _batchOpen = false;
        _batchResult = resMap;
        _period = _batchPeriod;
        _generating = false;
      });
      _fetchInvoices(force: true);
    } catch (err) {
      if (mounted) {
        setState(() => _generating = false);
        ref.read(toastProvider.notifier).error(
              extractErrorMessage(err, 'Không thể sinh hóa đơn hàng loạt.'),
            );
      }
    }
  }

  Future<void> _handleQuickIssue(Map<String, dynamic> row) async {
    final invoiceId = row['id']?.toString() ?? '';
    final invoiceCode = row['invoice_code']?.toString() ?? invoiceId;
    setState(() => _issuingId = invoiceId);

    try {
      final res = await ref.read(invoicesServiceProvider).updateStatus(invoiceId, {'status': 'ISSUED'});
      if (!mounted) return;
      final msg = res is Map && res['message'] != null
          ? res['message'].toString()
          : 'Đã phát hành hóa đơn $invoiceCode.';
      ref.read(toastProvider.notifier).success(msg);
      _fetchInvoices(force: true);
    } catch (err) {
      if (mounted) {
        ref.read(toastProvider.notifier).error(
              extractErrorMessage(err, 'Không thể phát hành hóa đơn.'),
            );
      }
    } finally {
      if (mounted) setState(() => _issuingId = null);
    }
  }

  Future<void> _exportCsv() async {
    if (_invoices.isEmpty) {
      ref.read(toastProvider.notifier).warning('Không có dữ liệu hóa đơn để xuất CSV.');
      return;
    }

    final headers = [
      const CsvHeader(label: 'Mã hóa đơn', key: 'invoice_code'),
      const CsvHeader(label: 'Kỳ', key: 'period'),
      const CsvHeader(label: 'Mã tòa', key: 'building_code'),
      const CsvHeader(label: 'Căn hộ', key: 'apartment_code'),
      const CsvHeader(label: 'Cư dân', key: 'tenant_name'),
      const CsvHeader(label: 'Số điện thoại', key: 'tenant_phone'),
      CsvHeader(label: 'Ngày tạo', key: 'issue_date', accessor: (r) => formatDate(r['issue_date'])),
      CsvHeader(label: 'Hạn thanh toán', key: 'due_date', accessor: (r) => formatDate(r['due_date'])),
      const CsvHeader(label: 'Tạm tính (VNĐ)', key: 'subtotal_amount'),
      const CsvHeader(label: 'Điều chỉnh (VNĐ)', key: 'adjustment_amount'),
      const CsvHeader(label: 'Tổng cộng (VNĐ)', key: 'total_amount'),
      const CsvHeader(label: 'Đã thu (VNĐ)', key: 'paid_amount'),
      const CsvHeader(label: 'Còn lại (VNĐ)', key: 'remaining_amount'),
      CsvHeader(label: 'Trạng thái', key: 'status', accessor: (r) => kInvoiceStatusOptions[r['status']] ?? r['status'] ?? ''),
    ];

    try {
      final bytes = buildUtf8BomCsvBytes(headers: headers, rows: _invoices);
      await saveOrShareBytes(
        bytes,
        fileName: 'hoa-don-${_period.isNotEmpty ? _period : 'tat-ca'}.csv',
        mimeType: 'text/csv',
      );
      ref.read(toastProvider.notifier).success('Đã xuất ${_invoices.length} hóa đơn ra file CSV.');
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
    final canManageInvoices = permissions.canManageInvoices;
    final totalBilled = num.tryParse(_summary['total_billed']?.toString() ?? '0') ?? 0;
    final totalPaid = num.tryParse(_summary['total_paid']?.toString() ?? '0') ?? 0;
    final totalUnpaid = num.tryParse(_summary['total_unpaid']?.toString() ?? '0') ?? 0;
    final collectionRate = totalBilled > 0 ? ((totalPaid / totalBilled) * 100).round() : 0;

    return Stack(
      children: [
        SingleChildScrollView(
          padding: const EdgeInsets.all(24.0),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
          PageHeader(
            title: 'Quản lý Hóa đơn Kỳ',
            subtitle: 'Tổng hợp tiền thuê, điện, nước, dịch vụ tiện ích và phát hành hóa đơn định kỳ cho cư dân.',
            actions: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                AppButton(
                  text: 'Làm mới',
                  icon: const Icon(LucideIcons.refreshCw, size: 14),
                  variant: AppButtonVariant.outline,
                  onPressed: () {
                    _fetchInvoices(force: true);
                    _fetchAdjustmentsQueue();
                  },
                ),
                const SizedBox(width: 8),
                AppButton(
                  text: 'Xuất CSV',
                  icon: const Icon(LucideIcons.download, size: 14),
                  variant: AppButtonVariant.outline,
                  onPressed: _exportCsv,
                ),
                if (canManageInvoices) ...[
                  const SizedBox(width: 8),
                  AppButton(
                    text: 'Sinh hóa đơn hàng loạt kỳ này',
                    icon: const Icon(LucideIcons.sparkles, size: 14),
                    variant: AppButtonVariant.primary,
                    onPressed: _openBatchModal,
                  ),
                ],
              ],
            ),
          ),
          const SizedBox(height: 16),

          // 4-eyes queue alert banner
          if (_pendingAdjustments.isNotEmpty) ...[
            Container(
              padding: const EdgeInsets.all(16),
              decoration: BoxDecoration(
                color: const Color(0xFFFFFBEB),
                borderRadius: BorderRadius.circular(12),
                border: Border.all(color: const Color(0xFFFDE68A)),
              ),
              child: Row(
                children: [
                  const Icon(LucideIcons.clock, color: Color(0xFFD97706), size: 24),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          'Có ${_pendingAdjustments.length} đề nghị điều chỉnh hóa đơn đang chờ phê duyệt 4 mắt',
                          style: const TextStyle(fontWeight: FontWeight.bold, color: Color(0xFF78350F), fontSize: 13),
                        ),
                        const SizedBox(height: 2),
                        const Text(
                          'Các đề nghị điều chỉnh tăng/giảm hoặc hủy (VOID) sau phát hành cần được kiểm duyệt trước khi đồng bộ tài chính.',
                          style: TextStyle(color: Color(0xFF92400E), fontSize: 12),
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(width: 12),
                  AppButton(
                    text: 'Xem hàng đợi (${_pendingAdjustments.length})',
                    variant: AppButtonVariant.warning,
                    size: AppButtonSize.sm,
                    onPressed: () => setState(() => _showAdjustmentsModal = true),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 16),
          ],

          // KPI Cards
          Row(
            children: [
              Expanded(
                child: StatsCard(
                  title: 'Tổng phát hành ${_period.isNotEmpty ? '($_period)' : '(Tất cả kỳ)'}',
                  value: formatMoney(totalBilled),
                  subtext: '${_invoices.where((i) => i['status'] != 'CANCELLED' && i['status'] != 'VOID').length} hóa đơn hợp lệ',
                  icon: LucideIcons.receipt,
                  color: 'sky',
                ),
              ),
              const SizedBox(width: 16),
              Expanded(
                child: StatsCard(
                  title: 'Đã thu thực tế',
                  value: formatMoney(totalPaid),
                  subtext: 'Tỷ lệ thu đạt $collectionRate% tổng phát hành',
                  icon: LucideIcons.circleCheck,
                  color: 'emerald',
                ),
              ),
              const SizedBox(width: 16),
              Expanded(
                child: StatsCard(
                  title: 'Chưa thu / Còn phải thu',
                  value: formatMoney(totalUnpaid),
                  subtext: '${_invoices.where((i) => ['ISSUED', 'PARTIALLY_PAID', 'OVERDUE', 'ADJUSTED'].contains(i['status'])).length} hóa đơn đang chờ thanh toán',
                  icon: LucideIcons.triangleAlert,
                  color: 'rose',
                ),
              ),
            ],
          ),
          const SizedBox(height: 16),

          // Filter card
          AppCard(
            padding: const EdgeInsets.all(16),
            child: Row(
              children: [
                SizedBox(
                  width: 200,
                  child: AppInput(
                    label: 'Kỳ hóa đơn (YYYY-MM)',
                    placeholder: 'YYYY-MM',
                    initialValue: _period,
                    onChanged: (val) {
                      setState(() => _period = val);
                      _fetchInvoices();
                    },
                  ),
                ),
                if (_period.isNotEmpty) ...[
                  const SizedBox(width: 8),
                  Padding(
                    padding: const EdgeInsets.only(top: 24),
                    child: TextButton(
                      onPressed: () {
                        setState(() => _period = '');
                        _fetchInvoices();
                      },
                      child: const Text('Tất cả kỳ', style: TextStyle(fontSize: 12)),
                    ),
                  ),
                ],
                const SizedBox(width: 16),
                SizedBox(
                  width: 220,
                  child: AppSelect<String>(
                    label: 'Trạng thái',
                    placeholder: 'Tất cả trạng thái',
                    value: _statusFilter.isEmpty ? null : _statusFilter,
                    options: [
                      const AppSelectOption(value: '', label: 'Tất cả trạng thái'),
                      ...kInvoiceStatusOptions.entries.map((e) => AppSelectOption(value: e.key, label: e.value)),
                    ],
                    onChanged: (val) {
                      setState(() => _statusFilter = val ?? '');
                      _fetchInvoices();
                    },
                  ),
                ),
                const SizedBox(width: 16),
                Expanded(
                  child: Padding(
                    padding: const EdgeInsets.only(top: 24),
                    child: SearchBarWidget(
                      placeholder: 'Tìm theo mã hóa đơn, mã căn hộ, họ tên cư dân...',
                      onChanged: _onSearchChanged,
                    ),
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(height: 16),

          // Invoices Table
          DataTableWidget<Map<String, dynamic>>(
            data: _invoices,
            loading: _loading,
            emptyTitle: 'Chưa có hóa đơn nào trong kỳ này',
            emptyDescription: 'Bấm “Sinh hóa đơn hàng loạt kỳ này” để tự động tính tiền thuê, điện, nước và dịch vụ cho toàn bộ hợp đồng đang hiệu lực.',
            emptyAction: canManageInvoices
                ? AppButton(
                    text: 'Sinh hóa đơn hàng loạt',
                    icon: const Icon(LucideIcons.sparkles, size: 14),
                    size: AppButtonSize.sm,
                    onPressed: _openBatchModal,
                  )
                : null,
            onRowClick: (row) {
              final id = row['id']?.toString() ?? '';
              if (id.isNotEmpty) {
                try {
                  context.push('/admin/invoices/$id');
                } catch (_) {}
              }
            },
            columns: [
              DataTableColumn(
                key: 'invoice_code',
                label: 'Mã hóa đơn',
                width: 150,
                render: (row) => Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Container(
                      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                      decoration: BoxDecoration(
                        color: AppColors.primary50,
                        border: Border.all(color: AppColors.primary200),
                        borderRadius: BorderRadius.circular(4),
                      ),
                      child: Text(
                        row['invoice_code']?.toString() ?? '—',
                        style: const TextStyle(
                          fontFamily: 'monospace',
                          fontSize: 12,
                          fontWeight: FontWeight.w600,
                          color: AppColors.primary700,
                        ),
                      ),
                    ),
                    const SizedBox(height: 2),
                    Text(
                      'Kỳ: ${row['period'] ?? 'Tất toán kỳ cuối'}',
                      style: const TextStyle(fontSize: 11, color: AppColors.textMuted),
                    ),
                  ],
                ),
              ),
              DataTableColumn(
                key: 'apartment_code',
                label: 'Căn hộ / Khách thuê',
                width: 200,
                render: (row) => Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      'Căn ${row['apartment_code'] ?? '—'} (${row['building_code'] ?? row['building_name'] ?? '—'})',
                      style: const TextStyle(fontWeight: FontWeight.bold, color: AppColors.textPrimary, fontSize: 13),
                    ),
                    const SizedBox(height: 2),
                    Text(
                      '${row['tenant_name'] ?? '—'}${row['tenant_phone'] != null ? ' • ${row['tenant_phone']}' : ''}',
                      style: const TextStyle(color: AppColors.textSecondary, fontSize: 12),
                    ),
                  ],
                ),
              ),
              DataTableColumn(
                key: 'due_date',
                label: 'Hạn thanh toán',
                width: 140,
                render: (row) => Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      formatDate(row['due_date']),
                      style: const TextStyle(fontWeight: FontWeight.w500, fontSize: 12),
                    ),
                    const SizedBox(height: 2),
                    Text(
                      'Lập: ${formatDate(row['issue_date'] ?? row['created_at'])}',
                      style: const TextStyle(color: AppColors.textMuted, fontSize: 11),
                    ),
                  ],
                ),
              ),
              DataTableColumn(
                key: 'total_amount',
                label: 'Tổng phải thu',
                width: 140,
                align: TextAlign.right,
                render: (row) {
                  final total = num.tryParse(row['total_amount']?.toString() ?? '0') ?? 0;
                  final adj = num.tryParse(row['adjustment_amount']?.toString() ?? '0') ?? 0;
                  return Column(
                    crossAxisAlignment: CrossAxisAlignment.end,
                    children: [
                      Text(
                        formatMoney(total),
                        style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 13),
                      ),
                      if (adj != 0)
                        Text(
                          'ĐC: ${adj > 0 ? '+' : ''}${formatMoney(adj)}',
                          style: const TextStyle(fontSize: 11, color: Colors.indigo),
                        ),
                    ],
                  );
                },
              ),
              DataTableColumn(
                key: 'paid_amount',
                label: 'Đã thu',
                width: 130,
                align: TextAlign.right,
                render: (row) {
                  final paid = num.tryParse(row['paid_amount']?.toString() ?? '0') ?? 0;
                  return Text(
                    formatMoney(paid),
                    style: const TextStyle(fontWeight: FontWeight.w600, color: AppColors.emerald600, fontSize: 13),
                  );
                },
              ),
              DataTableColumn(
                key: 'remaining_amount',
                label: 'Còn nợ',
                width: 130,
                align: TextAlign.right,
                render: (row) {
                  final rem = num.tryParse(row['remaining_amount']?.toString() ?? '0') ?? 0;
                  final isVoid = ['CANCELLED', 'VOID'].contains(row['status']);
                  return Text(
                    isVoid ? '0 ₫' : formatMoney(rem),
                    style: TextStyle(
                      fontWeight: FontWeight.bold,
                      fontSize: 13,
                      color: rem > 0 && !isVoid ? AppColors.rose600 : AppColors.textMuted,
                    ),
                  );
                },
              ),
              DataTableColumn(
                key: 'status',
                label: 'Trạng thái',
                width: 220,
                align: TextAlign.center,
                render: (row) => Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    StatusBadge(status: row['status']?.toString() ?? '', domain: StatusDomain.invoice),
                    if (row['invoice_type'] == 'LATE_FEE_SETTLEMENT')
                      const Padding(
                        padding: EdgeInsets.only(top: 2),
                        child: AppBadge(label: 'Phát sinh tất toán', variant: AppBadgeVariant.amber),
                      ),
                  ],
                ),
              ),
              DataTableColumn(
                key: 'actions',
                label: 'Thao tác',
                width: 340,
                align: TextAlign.center,
                render: (row) {
                  final isDraft = row['status'] == 'DRAFT';
                  final isSettlement = row['invoice_type'] == 'LATE_FEE_SETTLEMENT';
                  final isIssuing = _issuingId == row['id'];

                  return Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      if (canManageInvoices && isDraft && !isSettlement)
                        AppButton(
                          text: 'Phát hành',
                          icon: const Icon(LucideIcons.send, size: 14),
                          size: AppButtonSize.sm,
                          variant: AppButtonVariant.soft,
                          loading: isIssuing,
                          onPressed: () => _handleQuickIssue(row),
                        ),
                      const SizedBox(width: 6),
                      AppButton(
                        text: 'Chi tiết',
                        icon: const Icon(LucideIcons.eye, size: 14),
                        size: AppButtonSize.sm,
                        variant: AppButtonVariant.ghost,
                        onPressed: () {
                          final id = row['id']?.toString() ?? '';
                          if (id.isNotEmpty) {
                            try {
                              context.push('/admin/invoices/$id');
                            } catch (_) {}
                          }
                        },
                      ),
                    ],
                  );
                },
              ),
            ],
          ),
        ],
      ),
    ),

      // Modal: Batch generate
      if (_batchOpen)
        _buildModalOverlay(
          maxWidth: 640,
          child: AppModal(
              title: 'Sinh hóa đơn hàng loạt theo kỳ',
              subtitle: 'Hệ thống tự động gom Tiền thuê + Chỉ số Điện/Nước đã chốt + Gói dịch vụ ACTIVE của từng hợp đồng.',
              onClose: () => setState(() => _batchOpen = false),
              footer: Row(
                mainAxisAlignment: MainAxisAlignment.end,
                children: [
                  AppButton(
                    text: 'Hủy',
                    variant: AppButtonVariant.outline,
                    onPressed: () => setState(() => _batchOpen = false),
                  ),
                  const SizedBox(width: 8),
                  AppButton(
                    text: 'Tiến hành sinh hóa đơn',
                    icon: const Icon(LucideIcons.sparkles, size: 14),
                    variant: AppButtonVariant.primary,
                    loading: _generating,
                    onPressed: _handleGenerateBatch,
                  ),
                ],
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  AppInput(
                    label: 'Kỳ hóa đơn (YYYY-MM) *',
                    placeholder: 'YYYY-MM',
                    initialValue: _batchPeriod,
                    onChanged: (val) => setState(() => _batchPeriod = val),
                  ),
                  const SizedBox(height: 12),
                  if (_buildings.isNotEmpty)
                    AppSelect<String>(
                      label: 'Phạm vi tòa nhà',
                      placeholder: 'Tất cả tòa nhà trong phạm vi quản lý',
                      value: _batchBuildingId.isEmpty ? null : _batchBuildingId,
                      options: [
                        const AppSelectOption(value: '', label: 'Tất cả tòa nhà trong phạm vi quản lý'),
                        ..._buildings.map((b) => AppSelectOption(
                              value: b['id']?.toString() ?? '',
                              label: '${b['code'] ?? ''} — ${b['name'] ?? ''}',
                            )),
                      ],
                      onChanged: (val) => setState(() => _batchBuildingId = val ?? ''),
                    ),
                  const SizedBox(height: 12),
                  InkWell(
                    onTap: () => setState(() => _autoIssue = !_autoIssue),
                    child: Container(
                      padding: const EdgeInsets.all(12),
                      decoration: BoxDecoration(
                        color: AppColors.primary50.withValues(alpha: 0.5),
                        border: Border.all(color: AppColors.primary200),
                        borderRadius: BorderRadius.circular(8),
                      ),
                      child: Row(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Checkbox(
                            value: _autoIssue,
                            onChanged: (val) => setState(() => _autoIssue = val ?? false),
                          ),
                          const SizedBox(width: 8),
                          const Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(
                                  'Tự động phát hành ngay (ISSUED) & Gửi thông báo cho cư dân',
                                  style: TextStyle(fontWeight: FontWeight.bold, fontSize: 13),
                                ),
                                SizedBox(height: 2),
                                Text(
                                  'Khi bật, hóa đơn sẽ chuyển thẳng sang trạng thái Đã phát hành, đồng bộ sang Sổ công nợ và gửi thông báo tới ứng dụng của cư dân. Bỏ chọn nếu bạn muốn tạo Bản nháp (DRAFT) để rà soát trước.',
                                  style: TextStyle(fontSize: 12, color: AppColors.textSecondary),
                                ),
                              ],
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ),

      // Modal: Batch result report
      if (_batchResult != null)
        _buildModalOverlay(
          maxWidth: 680,
          child: AppModal(
              title: 'Báo cáo kết quả sinh hóa đơn',
              subtitle: 'Kỳ thanh toán: $_batchPeriod',
              onClose: () => setState(() => _batchResult = null),
              footer: AppButton(
                text: 'Đóng',
                variant: AppButtonVariant.primary,
                onPressed: () => setState(() => _batchResult = null),
              ),
              child: Builder(builder: (context) {
                final skipped = _batchResult!['skipped_contracts'] is List
                    ? _batchResult!['skipped_contracts'] as List
                    : [];
                final skipSummary = summarizeSkippedContracts(skipped);

                return Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Row(
                      children: [
                        Expanded(
                          child: Container(
                            padding: const EdgeInsets.all(12),
                            decoration: BoxDecoration(
                              color: const Color(0xFFECFDF5),
                              borderRadius: BorderRadius.circular(8),
                              border: Border.all(color: const Color(0xFFA7F3D0)),
                            ),
                            child: Column(
                              children: [
                                const Text('Hóa đơn tạo mới', style: TextStyle(fontSize: 12, color: Color(0xFF047857))),
                                const SizedBox(height: 4),
                                Text(
                                  '${_batchResult!['created_count'] ?? 0}',
                                  style: const TextStyle(fontSize: 20, fontWeight: FontWeight.bold, color: Color(0xFF065F46)),
                                ),
                              ],
                            ),
                          ),
                        ),
                        const SizedBox(width: 12),
                        Expanded(
                          child: Container(
                            padding: const EdgeInsets.all(12),
                            decoration: BoxDecoration(
                              color: const Color(0xFFF0F9FF),
                              borderRadius: BorderRadius.circular(8),
                              border: Border.all(color: const Color(0xFFBAE6FD)),
                            ),
                            child: Column(
                              children: [
                                const Text('Bản nháp đã cập nhật', style: TextStyle(fontSize: 12, color: Color(0xFF0369A1))),
                                const SizedBox(height: 4),
                                Text(
                                  '${_batchResult!['updated_draft_count'] ?? 0}',
                                  style: const TextStyle(fontSize: 20, fontWeight: FontWeight.bold, color: Color(0xFF075985)),
                                ),
                              ],
                            ),
                          ),
                        ),
                        const SizedBox(width: 12),
                        Expanded(
                          child: Container(
                            padding: const EdgeInsets.all(12),
                            decoration: BoxDecoration(
                              color: const Color(0xFFFFFBEB),
                              borderRadius: BorderRadius.circular(8),
                              border: Border.all(color: const Color(0xFFFDE68A)),
                            ),
                            child: Column(
                              children: [
                                const Text('Hợp đồng bỏ qua', style: TextStyle(fontSize: 12, color: Color(0xFFB45309))),
                                const SizedBox(height: 4),
                                Text(
                                  '${skipped.length}',
                                  style: const TextStyle(fontSize: 20, fontWeight: FontWeight.bold, color: Color(0xFF92400E)),
                                ),
                              ],
                            ),
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 16),
                    if (skipSummary.message.isNotEmpty) ...[
                      Container(
                        padding: const EdgeInsets.all(12),
                        decoration: BoxDecoration(
                          color: const Color(0xFFFFFBEB),
                          borderRadius: BorderRadius.circular(8),
                          border: Border.all(color: const Color(0xFFFDE68A)),
                        ),
                        child: Text(
                          'Tổng hợp bỏ qua: ${skipSummary.message}',
                          style: const TextStyle(fontSize: 12, color: Color(0xFF92400E), fontWeight: FontWeight.w500),
                        ),
                      ),
                      const SizedBox(height: 12),
                    ],
                    if (skipped.isNotEmpty) ...[
                      const Text(
                        'Chi tiết hợp đồng không sinh hóa đơn kỳ này (Bảo toàn dữ liệu):',
                        style: TextStyle(fontWeight: FontWeight.bold, fontSize: 13),
                      ),
                      const SizedBox(height: 8),
                      Container(
                        constraints: const BoxConstraints(maxHeight: 200),
                        child: ListView.builder(
                          shrinkWrap: true,
                          itemCount: skipped.length,
                          itemBuilder: (context, idx) {
                            final sc = skipped[idx] is Map ? skipped[idx] as Map : {};
                            return ListTile(
                              dense: true,
                              title: Text('HĐ: ${sc['contract_code'] ?? sc['contract_id'] ?? '—'} (Căn ${sc['apartment_code'] ?? '—'})'),
                              subtitle: Text(sc['reason']?.toString() ?? 'Đã có hóa đơn trong kỳ'),
                            );
                          },
                        ),
                      ),
                    ] else
                      const Center(
                        child: Padding(
                          padding: EdgeInsets.all(12.0),
                          child: Text(
                            'Tất cả hợp đồng đủ điều kiện đều đã được sinh hoặc làm mới hóa đơn thành công.',
                            style: TextStyle(fontStyle: FontStyle.italic, color: AppColors.textMuted),
                          ),
                        ),
                      ),
                  ],
                );
              }),
            ),
          ),

      // Modal: Pending adjustments 4-eyes queue
      if (_showAdjustmentsModal)
        _buildModalOverlay(
          maxWidth: 800,
          child: AppModal(
              title: 'Hàng đợi Điều chỉnh Hóa đơn chờ duyệt 4 mắt',
              subtitle: 'Danh sách các đề nghị tăng/giảm hoặc hủy hóa đơn (VOID) cần phê duyệt độc lập.',
              onClose: () => setState(() => _showAdjustmentsModal = false),
              footer: AppButton(
                text: 'Đóng',
                variant: AppButtonVariant.outline,
                onPressed: () => setState(() => _showAdjustmentsModal = false),
              ),
              child: _adjustmentsLoading
                  ? const Center(child: Padding(padding: EdgeInsets.all(24.0), child: CircularProgressIndicator()))
                  : _pendingAdjustments.isEmpty
                      ? const Center(
                          child: Padding(
                            padding: EdgeInsets.all(24.0),
                            child: Text('Không có đề nghị điều chỉnh hóa đơn nào đang chờ phê duyệt.'),
                          ),
                        )
                      : Container(
                          constraints: const BoxConstraints(maxHeight: 350),
                          child: ListView.separated(
                            shrinkWrap: true,
                            itemCount: _pendingAdjustments.length,
                            separatorBuilder: (_, __) => const Divider(),
                            itemBuilder: (context, idx) {
                              final adj = _pendingAdjustments[idx];
                              final isVoid = adj['action_type'] == 'VOID';
                              final delta = num.tryParse(adj['delta_amount']?.toString() ?? '0') ?? 0;

                              return ListTile(
                                dense: true,
                                title: Row(
                                  children: [
                                    Text(
                                      adj['invoice_code']?.toString() ?? 'Hóa đơn',
                                      style: const TextStyle(fontWeight: FontWeight.bold, color: AppColors.primary600),
                                    ),
                                    const SizedBox(width: 8),
                                    AppBadge(
                                      label: isVoid ? 'Hủy hóa đơn (VOID)' : 'Điều chỉnh ${adj['adjustment_target'] ?? ''}',
                                      variant: isVoid ? AppBadgeVariant.slate : AppBadgeVariant.purple,
                                    ),
                                  ],
                                ),
                                subtitle: Text(
                                  'Căn ${adj['apartment_code'] ?? '—'} • Lý do: ${adj['reason'] ?? '—'}',
                                ),
                                trailing: Row(
                                  mainAxisSize: MainAxisSize.min,
                                  children: [
                                    if (!isVoid)
                                      Text(
                                        '${delta > 0 ? '+' : ''}${formatMoney(delta)}',
                                        style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 13),
                                      ),
                                    const SizedBox(width: 8),
                                    AppButton(
                                      text: 'Chi tiết & Duyệt',
                                      size: AppButtonSize.sm,
                                      variant: AppButtonVariant.soft,
                                      onPressed: () {
                                        setState(() => _showAdjustmentsModal = false);
                                        final invId = adj['invoice_id']?.toString() ?? '';
                                        if (invId.isNotEmpty) {
                                          try {
                                            context.push('/admin/invoices/$invId');
                                          } catch (_) {}
                                        }
                                      },
                                    ),
                                  ],
                                ),
                              );
                            },
                          ),
                        ),
            ),
          ),
      ],
    );
  }
}
