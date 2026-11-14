import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../../../core/theme/app_colors.dart';
import '../../../core/utils/date_range.dart';
import '../../../core/utils/file_exporter.dart';
import '../../../core/utils/format.dart';
import '../../../core/utils/validation.dart';
import '../../../shared/providers/toast_provider.dart';
import '../../../shared/widgets/common/data_table_widget.dart';
import '../../../shared/widgets/common/search_bar_widget.dart';
import '../../../shared/widgets/ui/app_badge.dart';
import '../../../shared/widgets/ui/app_button.dart';
import '../../../shared/widgets/ui/app_card.dart';
import '../../../shared/widgets/ui/app_input.dart';
import '../../../shared/widgets/ui/app_modal.dart';
import '../../../shared/widgets/ui/app_select.dart';
import '../services/audit_service.dart';

const List<AppSelectOption<String>> kAuditEntityOptions = [
  // 12 Financial Entities (RP-08 Spec & PRD)
  AppSelectOption(value: 'invoice', label: 'Hóa đơn (invoice)'),
  AppSelectOption(value: 'invoice_line', label: 'Dòng hóa đơn (invoice_line)'),
  AppSelectOption(value: 'invoice_adjustment', label: 'Điều chỉnh hóa đơn (invoice_adjustment)'),
  AppSelectOption(value: 'payment', label: 'Thanh toán (payment)'),
  AppSelectOption(value: 'credit_balance', label: 'Số dư tín dụng (credit_balance)'),
  AppSelectOption(value: 'receivable', label: 'Công nợ phải thu (receivable)'),
  AppSelectOption(value: 'deposit', label: 'Tiền đặt cọc (deposit)'),
  AppSelectOption(value: 'deposit_transaction', label: 'Giao dịch cọc (deposit_transaction)'),
  AppSelectOption(value: 'reservation', label: 'Giữ chỗ (reservation)'),
  AppSelectOption(value: 'service_subscription', label: 'Đăng ký dịch vụ (service_subscription)'),
  AppSelectOption(value: 'service_catalog', label: 'Danh mục dịch vụ (service_catalog)'),
  AppSelectOption(value: 'contract_service_price', label: 'Biểu giá dịch vụ hợp đồng (contract_service_price)'),
  // Operational Entities
  AppSelectOption(value: 'contract', label: 'Hợp đồng (contract)'),
  AppSelectOption(value: 'apartment', label: 'Căn hộ (apartment)'),
  AppSelectOption(value: 'building', label: 'Tòa nhà (building)'),
  AppSelectOption(value: 'tenant', label: 'Cư dân (tenant)'),
  AppSelectOption(value: 'user_account', label: 'Tài khoản (user_account)'),
  AppSelectOption(value: 'system_setting', label: 'Cấu hình hệ thống (system_setting)'),
];

const List<AppSelectOption<String>> kAuditActionOptions = [
  AppSelectOption(value: 'ACCESS_DENIED', label: 'Từ chối truy cập (ACCESS_DENIED)'),
  AppSelectOption(value: 'SELF_APPROVAL_WARNING', label: 'Cảnh báo tự duyệt (SELF_APPROVAL_WARNING)'),
  AppSelectOption(value: 'CREATE', label: 'Tạo mới (CREATE)'),
  AppSelectOption(value: 'UPDATE', label: 'Cập nhật (UPDATE)'),
  AppSelectOption(value: 'DELETE', label: 'Xóa (DELETE)'),
  AppSelectOption(value: 'APPROVE', label: 'Phê duyệt (APPROVE)'),
  AppSelectOption(value: 'REJECT', label: 'Từ chối (REJECT)'),
  AppSelectOption(value: 'ACTIVATE', label: 'Kích hoạt (ACTIVATE)'),
  AppSelectOption(value: 'TERMINATE', label: 'Thanh lý (TERMINATE)'),
  AppSelectOption(value: 'DISPUTE', label: 'Khiếu nại / Tranh chấp (DISPUTE)'),
  AppSelectOption(value: 'RESOLVE_DISPUTE', label: 'Giải quyết khiếu nại (RESOLVE_DISPUTE)'),
];

AppBadgeVariant _getActionBadgeVariant(String? action) {
  final upper = (action ?? '').toUpperCase();
  if (upper == 'ACCESS_DENIED' || upper.contains('DENIED')) return AppBadgeVariant.red;
  if (upper == 'SELF_APPROVAL_WARNING' || upper.contains('SELF_APPROVAL') || upper.contains('WARNING')) {
    return AppBadgeVariant.amber;
  }
  if (upper.contains('CREATE') || upper.contains('APPROVE') || upper.contains('ACTIVATE')) {
    return AppBadgeVariant.emerald;
  }
  if (upper.contains('DELETE') || upper.contains('REJECT') || upper.contains('CANCEL') || upper.contains('FORFEIT')) {
    return AppBadgeVariant.red;
  }
  if (upper.contains('UPDATE') || upper.contains('SETTLE') || upper.contains('RESOLVE')) {
    return AppBadgeVariant.sky;
  }
  return AppBadgeVariant.slate;
}

String _formatJsonBlock(dynamic val) {
  if (val == null) return 'null';
  if (val is String) {
    try {
      final decoded = jsonDecode(val);
      const encoder = JsonEncoder.withIndent('  ');
      return encoder.convert(decoded);
    } catch (_) {
      return val;
    }
  }
  try {
    const encoder = JsonEncoder.withIndent('  ');
    return encoder.convert(val);
  } catch (_) {
    return val.toString();
  }
}

/// Standalone, reusable System Audit Logs View.
/// Embedded in [AuditLogsPage], [UsersPage] (tab `audit`), and `ReportsPage` (tab `financial-audit`).
class AuditLogsView extends ConsumerStatefulWidget {
  final String? lockedScope;
  final bool embedded;
  final Future<void> Function(Uint8List bytes, String fileName, String mimeType)? onSaveOrShare;

  const AuditLogsView({
    super.key,
    this.lockedScope,
    this.embedded = false,
    this.onSaveOrShare,
  });

  @override
  ConsumerState<AuditLogsView> createState() => _AuditLogsViewState();
}

class _AuditLogsViewState extends ConsumerState<AuditLogsView> {
  List<Map<String, dynamic>> _logs = [];
  bool _loading = true;
  int _page = 1;
  final int _limit = 20;
  int _total = 0;
  int _totalPages = 1;

  String _search = '';
  String _debouncedSearch = '';
  Timer? _debounceTimer;

  String _scope = '';
  String? _selectedEntity;
  String? _selectedAction;
  String _fromDate = '';
  String _toDate = '';

  bool _exportingCsv = false;
  bool _exportingXlsx = false;

  String get _effectiveScope => widget.lockedScope ?? _scope;

  @override
  void initState() {
    super.initState();
    _scope = widget.lockedScope ?? '';
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _fetchLogs();
    });
  }

  @override
  void dispose() {
    _debounceTimer?.cancel();
    super.dispose();
  }

  void _onSearchChanged(String val) {
    _search = val;
    _debounceTimer?.cancel();
    _debounceTimer = Timer(const Duration(milliseconds: 250), () {
      if (mounted) {
        setState(() {
          _debouncedSearch = val.trim();
          _page = 1;
        });
        _fetchLogs();
      }
    });
  }

  Future<void> _fetchLogs({bool force = false}) async {
    final auditService = ref.read(auditServiceProvider);
    final params = <String, dynamic>{
      'page': _page,
      'limit': _limit,
      if (_effectiveScope.isNotEmpty) 'scope': _effectiveScope,
      if (_selectedEntity != null && _selectedEntity!.isNotEmpty) 'entity': _selectedEntity,
      if (_selectedAction != null && _selectedAction!.isNotEmpty) 'action': _selectedAction,
      if (_fromDate.isNotEmpty) 'from': _fromDate,
      if (_toDate.isNotEmpty) 'to': _toDate,
      if (_debouncedSearch.isNotEmpty) 'search': _debouncedSearch,
    };

    final cached = !force ? auditService.peekList(params) : null;
    if (cached == null && mounted) {
      setState(() => _loading = true);
    }

    try {
      final res = await auditService.list(params, force);
      if (!mounted) return;

      List<Map<String, dynamic>> rawItems = [];
      if (res is Map) {
        final data = res['data'];
        if (data is List) {
          rawItems = data.whereType<Map>().map((e) => Map<String, dynamic>.from(e)).toList();
        } else if (data is Map && data['items'] is List) {
          rawItems = (data['items'] as List).whereType<Map>().map((e) => Map<String, dynamic>.from(e)).toList();
        } else if (res['items'] is List) {
          rawItems = (res['items'] as List).whereType<Map>().map((e) => Map<String, dynamic>.from(e)).toList();
        }

        final meta = res['pagination'] ?? res['meta'] ?? (res['data'] is Map ? res['data']['pagination'] : null) ?? {};
        final resolvedTotal = int.tryParse(meta['total']?.toString() ?? res['total']?.toString() ?? '') ?? rawItems.length;
        final resolvedTotalPages = int.tryParse(meta['totalPages']?.toString() ?? meta['total_pages']?.toString() ?? '') ??
            (resolvedTotal > 0 ? (resolvedTotal / _limit).ceil() : 1);

        setState(() {
          _logs = rawItems;
          _total = resolvedTotal;
          _totalPages = resolvedTotalPages > 0 ? resolvedTotalPages : 1;
          _loading = false;
        });
      } else if (res is List) {
        rawItems = res.whereType<Map>().map((e) => Map<String, dynamic>.from(e)).toList();
        setState(() {
          _logs = rawItems;
          _total = rawItems.length;
          _totalPages = (rawItems.length / _limit).ceil();
          if (_totalPages < 1) _totalPages = 1;
          _loading = false;
        });
      }
    } catch (err) {
      if (mounted) {
        ref.read(toastProvider.notifier).error(
              extractErrorMessage(err, 'Không thể tải nhật ký kiểm toán hệ thống.'),
            );
        setState(() => _loading = false);
      }
    }
  }

  void _handleResetFilters() {
    setState(() {
      _search = '';
      _debouncedSearch = '';
      _scope = widget.lockedScope ?? '';
      _selectedEntity = null;
      _selectedAction = null;
      _fromDate = '';
      _toDate = '';
      _page = 1;
    });
    _fetchLogs();
  }

  Future<void> _handleExportCsv() async {
    setState(() => _exportingCsv = true);
    try {
      final auditService = ref.read(auditServiceProvider);
      final params = <String, dynamic>{
        if (_effectiveScope.isNotEmpty) 'scope': _effectiveScope else 'scope': 'financial',
        if (_selectedEntity != null && _selectedEntity!.isNotEmpty) 'entity': _selectedEntity,
        if (_selectedAction != null && _selectedAction!.isNotEmpty) 'action': _selectedAction,
        if (_fromDate.isNotEmpty) 'from': _fromDate,
        if (_toDate.isNotEmpty) 'to': _toDate,
        if (_debouncedSearch.isNotEmpty) 'search': _debouncedSearch,
      };

      final bytes = await auditService.exportCsv(params);
      final nowStr = DateTime.now().toIso8601String().substring(0, 10);
      final fileName = 'nhat-ky-tai-chinh-rp08-$nowStr.csv';

      if (widget.onSaveOrShare != null) {
        await widget.onSaveOrShare!(Uint8List.fromList(bytes), fileName, 'text/csv');
      } else {
        await saveOrShareBytes(
          Uint8List.fromList(bytes),
          fileName: fileName,
          mimeType: 'text/csv',
          shareSubject: 'Nhật ký kiểm toán tài chính ResiHub',
        );
      }

      if (mounted) {
        ref.read(toastProvider.notifier).success('Đã xuất CSV Nhật ký thao tác tài chính (RP-08).');
      }
    } catch (err) {
      if (mounted) {
        ref.read(toastProvider.notifier).error(
              extractErrorMessage(err, 'Không thể xuất CSV Nhật ký tài chính (RP-08).'),
            );
      }
    } finally {
      if (mounted) {
        setState(() => _exportingCsv = false);
      }
    }
  }

  Future<void> _handleExportXlsx() async {
    setState(() => _exportingXlsx = true);
    try {
      final auditService = ref.read(auditServiceProvider);
      final params = <String, dynamic>{
        if (_effectiveScope.isNotEmpty) 'scope': _effectiveScope else 'scope': 'financial',
        if (_selectedEntity != null && _selectedEntity!.isNotEmpty) 'entity': _selectedEntity,
        if (_selectedAction != null && _selectedAction!.isNotEmpty) 'action': _selectedAction,
        if (_fromDate.isNotEmpty) 'from': _fromDate,
        if (_toDate.isNotEmpty) 'to': _toDate,
        if (_debouncedSearch.isNotEmpty) 'search': _debouncedSearch,
      };

      final bytes = await auditService.exportXlsx(params);
      final nowStr = DateTime.now().toIso8601String().substring(0, 10);
      final fileName = 'nhat-ky-tai-chinh-rp08-$nowStr.xlsx';

      if (widget.onSaveOrShare != null) {
        await widget.onSaveOrShare!(Uint8List.fromList(bytes), fileName, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      } else {
        await saveOrShareBytes(
          Uint8List.fromList(bytes),
          fileName: fileName,
          mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          shareSubject: 'Nhật ký kiểm toán tài chính ResiHub',
        );
      }

      if (mounted) {
        ref.read(toastProvider.notifier).success('Đã xuất Excel (.xlsx) Nhật ký thao tác tài chính (RP-08).');
      }
    } catch (err) {
      if (mounted) {
        ref.read(toastProvider.notifier).error(
              extractErrorMessage(err, 'Không thể xuất Excel Nhật ký tài chính (RP-08).'),
            );
      }
    } finally {
      if (mounted) {
        setState(() => _exportingXlsx = false);
      }
    }
  }

  void _showDetailModal(Map<String, dynamic> log) {
    final beforePayload = log['before'] ?? log['before_data'] ?? log['old_data'];
    final afterPayload = log['after'] ?? log['after_data'] ?? log['new_data'] ?? log['details'] ?? log['metadata'];
    final act = log['action']?.toString() ?? '—';
    final entityStr = log['entity']?.toString() ?? log['entity_type']?.toString() ?? '—';
    final entityIdStr = log['entity_id']?.toString() ?? log['record_id']?.toString() ?? '—';
    final dateStr = formatDateTime(log['created_at']);

    AppModal.show<void>(
      context: context,
      title: 'Chi tiết bản ghi Nhật ký Kiểm toán (Audit Log)',
      subtitle: '$act • $entityStr • $dateStr',
      size: AppModalSize.xl,
      footer: AppButton(
        text: 'Đóng',
        variant: AppButtonVariant.outline,
        onPressed: () => Navigator.of(context, rootNavigator: true).pop(),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          Container(
            padding: const EdgeInsets.all(12),
            decoration: BoxDecoration(
              color: AppColors.slate50,
              borderRadius: BorderRadius.circular(10),
              border: Border.all(color: AppColors.border),
            ),
            child: Wrap(
              spacing: 16,
              runSpacing: 12,
              children: [
                SizedBox(
                  width: 200,
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      const Text('Người thực hiện', style: TextStyle(fontSize: 11, color: AppColors.slate500)),
                      const SizedBox(height: 2),
                      Text(
                        log['actor_name']?.toString() ?? log['actor_full_name']?.toString() ?? 'Hệ thống',
                        style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w600, color: AppColors.slate900),
                      ),
                      if (log['actor_email'] != null)
                        Text(
                          log['actor_email'].toString(),
                          style: const TextStyle(fontSize: 11, color: AppColors.slate500),
                        ),
                    ],
                  ),
                ),
                SizedBox(
                  width: 140,
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      const Text('Hành động', style: TextStyle(fontSize: 11, color: AppColors.slate500)),
                      const SizedBox(height: 4),
                      AppBadge(
                        label: act,
                        variant: _getActionBadgeVariant(act),
                        dot: true,
                      ),
                    ],
                  ),
                ),
                SizedBox(
                  width: 180,
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      const Text('Đối tượng & Mã', style: TextStyle(fontSize: 11, color: AppColors.slate500)),
                      const SizedBox(height: 2),
                      Text(
                        '$entityStr / $entityIdStr',
                        style: const TextStyle(fontFamily: 'monospace', fontSize: 11, fontWeight: FontWeight.w600, color: AppColors.slate900),
                      ),
                    ],
                  ),
                ),
                SizedBox(
                  width: 140,
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      const Text('Địa chỉ IP', style: TextStyle(fontSize: 11, color: AppColors.slate500)),
                      const SizedBox(height: 2),
                      Text(
                        log['ip']?.toString() ?? log['ip_address']?.toString() ?? '—',
                        style: const TextStyle(fontFamily: 'monospace', fontSize: 11, color: AppColors.slate700),
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(height: 16),
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Text('Dữ liệu trước thay đổi (Before)', style: TextStyle(fontSize: 12, fontWeight: FontWeight.w600, color: AppColors.slate700)),
                    const SizedBox(height: 6),
                    Container(
                      width: double.infinity,
                      constraints: const BoxConstraints(maxHeight: 250),
                      padding: const EdgeInsets.all(12),
                      decoration: BoxDecoration(
                        color: AppColors.slate900,
                        borderRadius: BorderRadius.circular(8),
                      ),
                      child: SingleChildScrollView(
                        child: SelectableText(
                          _formatJsonBlock(beforePayload),
                          style: const TextStyle(fontFamily: 'monospace', fontSize: 11, color: AppColors.slate100),
                        ),
                      ),
                    ),
                  ],
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Text('Dữ liệu sau thay đổi / Chi tiết (After)', style: TextStyle(fontSize: 12, fontWeight: FontWeight.w600, color: AppColors.slate700)),
                    const SizedBox(height: 6),
                    Container(
                      width: double.infinity,
                      constraints: const BoxConstraints(maxHeight: 250),
                      padding: const EdgeInsets.all(12),
                      decoration: BoxDecoration(
                        color: AppColors.slate900,
                        borderRadius: BorderRadius.circular(8),
                      ),
                      child: SingleChildScrollView(
                        child: SelectableText(
                          _formatJsonBlock(afterPayload),
                          style: const TextStyle(fontFamily: 'monospace', fontSize: 11, color: AppColors.emerald200),
                        ),
                      ),
                    ),
                  ],
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final columns = <DataTableColumn<Map<String, dynamic>>>[
      DataTableColumn(
        key: 'created_at',
        label: 'Thời gian',
        width: 150,
        render: (row) => Text(
          formatDateTime(row['created_at']),
          style: const TextStyle(fontFamily: 'monospace', fontSize: 11, color: AppColors.slate700),
        ),
      ),
      DataTableColumn(
        key: 'actor',
        label: 'Người thực hiện',
        width: 200,
        render: (row) {
          final name = row['actor_name']?.toString() ?? row['actor_full_name']?.toString() ?? 'Hệ thống';
          final email = row['actor_email']?.toString() ?? '';
          return Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(name, style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w600, color: AppColors.slate900)),
              if (email.isNotEmpty)
                Text(email, style: const TextStyle(fontSize: 11, color: AppColors.slate500)),
            ],
          );
        },
      ),
      DataTableColumn(
        key: 'action',
        label: 'Hành động',
        align: TextAlign.center,
        width: 170,
        render: (row) {
          final act = row['action']?.toString() ?? '—';
          final upper = act.toUpperCase();
          final isAccessDenied = upper == 'ACCESS_DENIED' || upper.contains('DENIED');
          final isSelfApproval = upper == 'SELF_APPROVAL_WARNING' || upper.contains('SELF_APPROVAL');

          return Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              if (isAccessDenied) ...[
                const Icon(LucideIcons.shieldAlert, size: 14, color: AppColors.rose600),
                const SizedBox(width: 4),
              ] else if (isSelfApproval) ...[
                const Icon(LucideIcons.triangleAlert, size: 14, color: AppColors.amber600),
                const SizedBox(width: 4),
              ],
              AppBadge(
                label: act,
                variant: _getActionBadgeVariant(act),
                dot: true,
              ),
            ],
          );
        },
      ),
      DataTableColumn(
        key: 'entity',
        label: 'Phân hệ / Đối tượng',
        width: 150,
        render: (row) {
          final ent = row['entity']?.toString() ?? row['entity_type']?.toString() ?? '—';
          return Container(
            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
            decoration: BoxDecoration(
              color: AppColors.slate100,
              borderRadius: BorderRadius.circular(4),
            ),
            child: Text(
              ent,
              style: const TextStyle(fontFamily: 'monospace', fontSize: 11, fontWeight: FontWeight.w600, color: AppColors.slate700),
            ),
          );
        },
      ),
      DataTableColumn(
        key: 'entity_id',
        label: 'Mã bản ghi',
        width: 120,
        render: (row) {
          final eid = row['entity_id']?.toString() ?? row['record_id']?.toString() ?? '—';
          final display = eid.length > 12 ? '${eid.substring(0, 6)}…${eid.substring(eid.length - 4)}' : eid;
          return Text(
            display,
            style: const TextStyle(fontFamily: 'monospace', fontSize: 11, color: AppColors.slate600),
          );
        },
      ),
      DataTableColumn(
        key: 'actions',
        label: 'Chi tiết',
        align: TextAlign.center,
        width: 180,
        render: (row) => AppButton(
          text: 'Xem JSON',
          size: AppButtonSize.xs,
          variant: AppButtonVariant.ghost,
          icon: const Icon(LucideIcons.eye, size: 13),
          onPressed: () => _showDetailModal(row),
        ),
      ),
    ];

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: [
        AppCard(
          padding: const EdgeInsets.all(16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Wrap(
                spacing: 12,
                runSpacing: 12,
                crossAxisAlignment: WrapCrossAlignment.center,
                children: [
                  SizedBox(
                    width: 280,
                    child: SearchBarWidget(
                      value: _search,
                      onChanged: _onSearchChanged,
                      placeholder: 'Tìm theo người thực hiện, email, mã...',
                    ),
                  ),
                  SizedBox(
                    width: 180,
                    child: AppSelect<String>(
                      placeholder: 'Tất cả đối tượng',
                      value: _selectedEntity,
                      options: kAuditEntityOptions,
                      onChanged: (val) {
                        setState(() {
                          _selectedEntity = val;
                          _page = 1;
                        });
                        _fetchLogs();
                      },
                    ),
                  ),
                  SizedBox(
                    width: 180,
                    child: AppSelect<String>(
                      placeholder: 'Tất cả hành động',
                      value: _selectedAction,
                      options: kAuditActionOptions,
                      onChanged: (val) {
                        setState(() {
                          _selectedAction = val;
                          _page = 1;
                        });
                        _fetchLogs();
                      },
                    ),
                  ),
                  SizedBox(
                    width: 140,
                    child: AppInput(
                      placeholder: 'Từ ngày (YYYY-MM-DD)',
                      initialValue: _fromDate,
                      onChanged: (val) {
                        final synced = syncFilterDateRange(val, _toDate);
                        setState(() {
                          _fromDate = synced.fromDate;
                          _toDate = synced.toDate;
                          _page = 1;
                        });
                        _fetchLogs();
                      },
                    ),
                  ),
                  SizedBox(
                    width: 140,
                    child: AppInput(
                      placeholder: 'Đến ngày (YYYY-MM-DD)',
                      initialValue: _toDate,
                      onChanged: (val) {
                        final syncedTo = _fromDate.isNotEmpty && val.isNotEmpty && val.compareTo(_fromDate) < 0
                            ? _fromDate
                            : val;
                        setState(() {
                          _toDate = syncedTo;
                          _page = 1;
                        });
                        _fetchLogs();
                      },
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 12),
              const Divider(color: AppColors.border, height: 1),
              const SizedBox(height: 10),
              Wrap(
                spacing: 8,
                runSpacing: 8,
                crossAxisAlignment: WrapCrossAlignment.center,
                alignment: WrapAlignment.spaceBetween,
                children: [
                  Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Text(
                        'Tổng cộng $_total bản ghi nhật ký kiểm toán',
                        style: const TextStyle(fontSize: 12, color: AppColors.slate600),
                      ),
                      const SizedBox(width: 8),
                      if (widget.lockedScope == null)
                        AppButton(
                          text: _scope == 'financial' ? 'Đang lọc: Tài chính (RP-08)' : 'Tất cả tài chính (RP-08)',
                          size: AppButtonSize.xs,
                          variant: _scope == 'financial' ? AppButtonVariant.primary : AppButtonVariant.outline,
                          icon: const Icon(LucideIcons.wallet, size: 13),
                          onPressed: () {
                            setState(() {
                              _scope = _scope == 'financial' ? '' : 'financial';
                              _page = 1;
                            });
                            _fetchLogs();
                          },
                        ),
                    ],
                  ),
                  Wrap(
                    spacing: 8,
                    children: [
                      if (_search.isNotEmpty || _selectedEntity != null || _selectedAction != null || _fromDate.isNotEmpty || _toDate.isNotEmpty)
                        AppButton(
                          text: 'Xóa bộ lọc',
                          size: AppButtonSize.xs,
                          variant: AppButtonVariant.ghost,
                          icon: const Icon(LucideIcons.rotateCcw, size: 13),
                          onPressed: _handleResetFilters,
                        ),
                      AppButton(
                        text: 'Xuất Excel (.xlsx)',
                        size: AppButtonSize.xs,
                        variant: AppButtonVariant.outline,
                        icon: const Icon(LucideIcons.fileSpreadsheet, size: 13),
                        loading: _exportingXlsx,
                        onPressed: _handleExportXlsx,
                      ),
                      AppButton(
                        text: 'Xuất CSV (RP-08)',
                        size: AppButtonSize.xs,
                        variant: AppButtonVariant.outline,
                        icon: const Icon(LucideIcons.download, size: 13),
                        loading: _exportingCsv,
                        onPressed: _handleExportCsv,
                      ),
                      AppButton(
                        text: 'Làm mới',
                        size: AppButtonSize.xs,
                        variant: AppButtonVariant.outline,
                        icon: const Icon(LucideIcons.refreshCw, size: 13),
                        onPressed: () => _fetchLogs(force: true),
                      ),
                    ],
                  ),
                ],
              ),
            ],
          ),
        ),
        const SizedBox(height: 16),
        DataTableWidget<Map<String, dynamic>>(
          columns: columns,
          data: _logs,
          loading: _loading,
          pageSize: _limit,
          onRowClick: (row) => _showDetailModal(row),
          emptyTitle: 'Chưa có bản ghi nhật ký hệ thống',
          emptyDescription: 'Không tìm thấy sự kiện kiểm toán nào khớp với bộ lọc hiện tại.',
        ),
        if (_totalPages > 1 || _total > _limit) ...[
          const SizedBox(height: 12),
          AppCard(
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
            child: Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                Text(
                  'Trang $_page / $_totalPages ($_total dòng)',
                  style: const TextStyle(fontSize: 12, color: AppColors.slate700),
                ),
                Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    AppButton(
                      text: 'Trước',
                      size: AppButtonSize.xs,
                      variant: AppButtonVariant.outline,
                      icon: const Icon(LucideIcons.chevronLeft, size: 14),
                      disabled: _page <= 1 || _loading,
                      onPressed: () {
                        setState(() => _page--);
                        _fetchLogs();
                      },
                    ),
                    const SizedBox(width: 8),
                    AppButton(
                      text: 'Sau',
                      size: AppButtonSize.xs,
                      variant: AppButtonVariant.outline,
                      rightIcon: const Icon(LucideIcons.chevronRight, size: 14),
                      disabled: _page >= _totalPages || _loading,
                      onPressed: () {
                        setState(() => _page++);
                        _fetchLogs();
                      },
                    ),
                  ],
                ),
              ],
            ),
          ),
        ],
      ],
    );
  }
}
