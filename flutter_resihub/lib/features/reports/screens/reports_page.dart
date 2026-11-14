import 'dart:convert';

import 'package:fl_chart/fl_chart.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../../../core/constants/statuses.dart';
import '../../../core/theme/app_colors.dart';
import '../../../core/utils/file_exporter.dart';
import '../../../core/utils/format.dart';
import '../../../core/utils/validation.dart';
import '../../../shared/providers/toast_provider.dart';
import '../../../shared/widgets/common/data_table_widget.dart';
import '../../../shared/widgets/common/empty_state.dart';
import '../../../shared/widgets/common/page_header.dart';
import '../../../shared/widgets/common/stats_card.dart';
import '../../../shared/widgets/common/status_badge.dart';
import '../../../shared/widgets/ui/app_badge.dart';
import '../../../shared/widgets/ui/app_button.dart';
import '../../../shared/widgets/ui/app_card.dart';
import '../../../shared/widgets/ui/app_input.dart';
import '../../../shared/widgets/ui/app_modal.dart';
import '../../../shared/widgets/ui/app_select.dart';
import '../../../shared/widgets/ui/app_skeleton.dart';
import '../../../shared/widgets/ui/app_tabs.dart';
import '../../audit/widgets/audit_logs_view.dart';
import '../../auth/providers/auth_provider.dart';
import '../services/reports_service.dart';
import '../utils/chart_helpers.dart';
import '../widgets/dashboard_charts.dart';

const List<String> kValidReportTabs = [
  'revenue',
  'occupancy',
  'aging',
  'deposit-ledger',
  'financial-audit',
  'sla',
];

String _getDefaultFromDate() {
  final now = DateTime.now();
  final y = now.year.toString().padLeft(4, '0');
  final m = now.month.toString().padLeft(2, '0');
  return '$y-$m-01';
}

String _getDefaultToDate() {
  final now = DateTime.now();
  final y = now.year.toString().padLeft(4, '0');
  final m = now.month.toString().padLeft(2, '0');
  final d = now.day.toString().padLeft(2, '0');
  return '$y-$m-$d';
}

const List<AppSelectOption<String>> kDepositStatusFilterOptions = [
  AppSelectOption(value: '', label: 'Tất cả trạng thái sổ cọc'),
  AppSelectOption(value: 'HELD', label: 'Đang giữ cọc (HELD)'),
  AppSelectOption(value: 'SETTLEMENT_DRAFT', label: 'Nháp tất toán (SETTLEMENT_DRAFT)'),
  AppSelectOption(value: 'PENDING_APPROVAL', label: 'Chờ duyệt hoàn cọc (PENDING_APPROVAL)'),
  AppSelectOption(value: 'APPROVED_PENDING_PAYOUT', label: 'Chờ chi hoàn (APPROVED_PENDING_PAYOUT)'),
  AppSelectOption(value: 'PARTIALLY_REFUNDED', label: 'Hoàn một phần (PARTIALLY_REFUNDED)'),
  AppSelectOption(value: 'REFUNDED', label: 'Đã hoàn đủ 100% (REFUNDED)'),
  AppSelectOption(value: 'DEDUCTED_FULL', label: 'Đã khấu trừ hết (DEDUCTED_FULL)'),
  AppSelectOption(value: 'TRANSFERRED', label: 'Đã kết chuyển (TRANSFERRED)'),
  AppSelectOption(value: 'DISPUTED', label: 'Đang tranh chấp (DISPUTED)'),
  AppSelectOption(value: 'RETURNED', label: 'Ngân hàng hoàn trả lệnh (RETURNED)'),
];

/// Admin Management Reports Page (PRD §15.2 - 6 Specialized Reporting Sections).
class ReportsPage extends ConsumerStatefulWidget {
  final String? initialTab;
  final String? initialModal;

  const ReportsPage({
    super.key,
    this.initialTab,
    this.initialModal,
  });

  @override
  ConsumerState<ReportsPage> createState() => _ReportsPageState();
}

class _ReportsPageState extends ConsumerState<ReportsPage> {
  late String _activeTab;
  String _revenueChartMode = 'line'; // 'line' | 'bar'
  bool _loading = true;
  bool _ledgerLoading = false;

  String _ledgerFromDate = _getDefaultFromDate();
  String _ledgerToDate = _getDefaultToDate();
  String _ledgerStatus = '';

  String _exportingSection = '';

  Map<String, dynamic> _reportData = {
    'revenue_12m': [],
    'occupancy_by_building': [],
    'aging_by_building': [],
    'sla_by_category': [],
  };

  Map<String, dynamic> _ledgerData = {
    'summary': {},
    'reservation_summary': {},
    'items': [],
  };

  @override
  void initState() {
    super.initState();
    _activeTab = kValidReportTabs.contains(widget.initialTab) ? widget.initialTab! : 'revenue';

    WidgetsBinding.instance.addPostFrameCallback((_) async {
      _fetchSummary();
      if (_activeTab == 'deposit-ledger' || widget.initialModal == 'summary') {
        await _fetchDepositLedger();
      }
      if (!mounted) return;
      if (widget.initialModal == 'summary') {
        _showDepositSummaryModal();
      }
    });
  }

  Future<void> _fetchSummary({bool force = false}) async {
    final buildingId = ref.read(authProvider).selectedBuildingId;
    final params = {
      if (buildingId.isNotEmpty) 'building_id': buildingId,
    };
    final service = ref.read(reportsServiceProvider);

    if (!force) {
      dynamic cached = service.peekSummary(params);
      if (cached is String) {
        try {
          cached = jsonDecode(cached);
        } catch (_) {}
      }
      if (cached != null && cached is Map) {
        setState(() {
          _reportData = cached['data'] is Map ? (cached['data'] as Map).cast<String, dynamic>() : cached.cast<String, dynamic>();
        });
      }
    }

    setState(() => _loading = true);
    try {
      dynamic res = await service.getSummary(params, force);
      if (res is String) {
        try {
          res = jsonDecode(res);
        } catch (_) {}
      }
      if (mounted && res is Map) {
        setState(() {
          _reportData = res['data'] is Map ? (res['data'] as Map).cast<String, dynamic>() : res.cast<String, dynamic>();
        });
      }
    } catch (err) {
      if (mounted) {
        ref.read(toastProvider.notifier).error(
              extractErrorMessage(err, 'Không thể tải dữ liệu báo cáo thống kê.'),
            );
      }
    } finally {
      if (mounted) {
        setState(() => _loading = false);
      }
    }
  }

  Future<void> _fetchDepositLedger({bool force = false}) async {
    if (_ledgerFromDate.isNotEmpty && _ledgerToDate.isNotEmpty && _ledgerFromDate.compareTo(_ledgerToDate) > 0) {
      ref.read(toastProvider.notifier).warning('Ngày bắt đầu kỳ sổ cọc không được lớn hơn ngày kết thúc.');
      return;
    }

    final buildingId = ref.read(authProvider).selectedBuildingId;
    final params = <String, dynamic>{
      if (buildingId.isNotEmpty) 'building_id': buildingId,
      if (_ledgerFromDate.isNotEmpty) 'from_date': _ledgerFromDate,
      if (_ledgerToDate.isNotEmpty) 'to_date': _ledgerToDate,
      if (_ledgerStatus.isNotEmpty) 'status': _ledgerStatus,
    };
    final service = ref.read(reportsServiceProvider);

    if (!force) {
      dynamic cached = service.peekDepositLedger(params);
      if (cached is String) {
        try {
          cached = jsonDecode(cached);
        } catch (_) {}
      }
      if (cached != null && cached is Map) {
        setState(() {
          _ledgerData = cached['data'] is Map ? (cached['data'] as Map).cast<String, dynamic>() : cached.cast<String, dynamic>();
        });
      }
    }

    setState(() => _ledgerLoading = true);
    try {
      dynamic res = await service.getDepositLedger(params, force);
      if (res is String) {
        try {
          res = jsonDecode(res);
        } catch (_) {}
      }
      if (mounted && res is Map) {
        setState(() {
          _ledgerData = res['data'] is Map ? (res['data'] as Map).cast<String, dynamic>() : res.cast<String, dynamic>();
        });
      }
    } catch (err) {
      if (mounted) {
        ref.read(toastProvider.notifier).error(
              extractErrorMessage(err, 'Không thể tải Báo cáo Sổ cọc (RP-07).'),
            );
      }
    } finally {
      if (mounted) {
        setState(() => _ledgerLoading = false);
      }
    }
  }

  Future<void> _exportRevenue(String format) async {
    setState(() => _exportingSection = 'revenue-$format');
    final buildingId = ref.read(authProvider).selectedBuildingId;
    final params = {
      'section': 'revenue',
      if (buildingId.isNotEmpty) 'building_id': buildingId,
    };
    final service = ref.read(reportsServiceProvider);

    try {
      final bytes = format == 'xlsx'
          ? await service.exportSummaryXlsx(params)
          : await service.exportSummaryCsv(params);

      final dateStr = DateTime.now().toIso8601String().substring(0, 10);
      final fileName = 'bao-cao-doanh-thu-rp01-$dateStr.$format';
      final mimeType = format == 'xlsx'
          ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
          : 'text/csv; charset=utf-8';

      await saveOrShareBytes(bytes, fileName: fileName, mimeType: mimeType);
      if (mounted) {
        ref.read(toastProvider.notifier).success('Đã xuất báo cáo doanh thu (${format.toUpperCase()}).');
      }
    } catch (err) {
      try {
        final rows = _reportData['revenue_12m'] is List ? _reportData['revenue_12m'] as List : [];
        final csvBytes = buildUtf8BomCsvBytes(
          headers: [
            const CsvHeader(label: 'Kỳ (YYYY-MM)', key: 'period'),
            const CsvHeader(label: 'Số lượng hóa đơn', key: 'invoice_count'),
            const CsvHeader(label: 'Tổng phát hành (VNĐ)', key: 'billed'),
            const CsvHeader(label: 'Thực thu (VNĐ)', key: 'collected'),
            const CsvHeader(label: 'Còn tồn đọng (VNĐ)', key: 'outstanding'),
          ],
          rows: rows.map((r) => (r is Map ? r.cast<String, dynamic>() : <String, dynamic>{})).toList(),
        );
        await saveOrShareBytes(csvBytes, fileName: 'bao-cao-doanh-thu-12-thang.csv', mimeType: 'text/csv; charset=utf-8');
        if (mounted) {
          ref.read(toastProvider.notifier).success('Đã xuất báo cáo doanh thu 12 tháng ra CSV.');
        }
      } catch (e) {
        if (mounted) {
          ref.read(toastProvider.notifier).error(extractErrorMessage(e, 'Không thể xuất báo cáo doanh thu.'));
        }
      }
    } finally {
      if (mounted) setState(() => _exportingSection = '');
    }
  }

  Future<void> _exportOccupancyCsv() async {
    try {
      final rows = _reportData['occupancy_by_building'] is List ? _reportData['occupancy_by_building'] as List : [];
      final csvBytes = buildUtf8BomCsvBytes(
        headers: [
          const CsvHeader(label: 'Mã tòa', key: 'building_code'),
          const CsvHeader(label: 'Tên tòa nhà', key: 'building_name'),
          const CsvHeader(label: 'Tổng căn khai thác', key: 'total_apartments'),
          const CsvHeader(label: 'Đang thuê', key: 'occupied'),
          const CsvHeader(label: 'Còn trống', key: 'available'),
          const CsvHeader(label: 'Đã đặt cọc', key: 'reserved'),
          const CsvHeader(label: 'Đang bảo trì', key: 'maintenance'),
          const CsvHeader(label: 'Tỷ lệ lấp đầy (%)', key: 'occupancy_rate'),
        ],
        rows: rows.map((r) => (r is Map ? r.cast<String, dynamic>() : <String, dynamic>{})).toList(),
      );
      await saveOrShareBytes(csvBytes, fileName: 'bao-cao-ty-le-lap-day.csv', mimeType: 'text/csv; charset=utf-8');
      if (mounted) {
        ref.read(toastProvider.notifier).success('Đã xuất báo cáo tỷ lệ lấp đầy ra CSV.');
      }
    } catch (err) {
      if (mounted) {
        ref.read(toastProvider.notifier).error(extractErrorMessage(err, 'Không thể xuất báo cáo lấp đầy.'));
      }
    }
  }

  Future<void> _exportAging(String format) async {
    setState(() => _exportingSection = 'aging-$format');
    final buildingId = ref.read(authProvider).selectedBuildingId;
    final params = {
      'section': 'aging',
      if (buildingId.isNotEmpty) 'building_id': buildingId,
    };
    final service = ref.read(reportsServiceProvider);

    try {
      final bytes = format == 'xlsx'
          ? await service.exportSummaryXlsx(params)
          : await service.exportSummaryCsv(params);

      final dateStr = DateTime.now().toIso8601String().substring(0, 10);
      final fileName = 'bao-cao-tuoi-no-rp02-$dateStr.$format';
      final mimeType = format == 'xlsx'
          ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
          : 'text/csv; charset=utf-8';

      await saveOrShareBytes(bytes, fileName: fileName, mimeType: mimeType);
      if (mounted) {
        ref.read(toastProvider.notifier).success('Đã xuất báo cáo tuổi nợ (${format.toUpperCase()}).');
      }
    } catch (err) {
      try {
        final rows = _reportData['aging_by_building'] is List ? _reportData['aging_by_building'] as List : [];
        final csvBytes = buildUtf8BomCsvBytes(
          headers: [
            const CsvHeader(label: 'Mã tòa', key: 'building_code'),
            const CsvHeader(label: 'Tên tòa nhà', key: 'building_name'),
            const CsvHeader(label: 'Chưa đến hạn (VNĐ)', key: 'current_not_due'),
            const CsvHeader(label: '1 - 15 ngày (VNĐ)', key: 'bucket_0_15'),
            const CsvHeader(label: '16 - 30 ngày (VNĐ)', key: 'bucket_16_30'),
            const CsvHeader(label: '31 - 60 ngày (VNĐ)', key: 'bucket_31_60'),
            const CsvHeader(label: '> 60 ngày (VNĐ)', key: 'bucket_over_60'),
            const CsvHeader(label: 'Tổng dư nợ (VNĐ)', key: 'total_debt'),
          ],
          rows: rows.map((r) => (r is Map ? r.cast<String, dynamic>() : <String, dynamic>{})).toList(),
        );
        await saveOrShareBytes(csvBytes, fileName: 'bao-cao-tuoi-no-aging.csv', mimeType: 'text/csv; charset=utf-8');
        if (mounted) {
          ref.read(toastProvider.notifier).success('Đã xuất báo cáo tuổi nợ theo tòa nhà ra CSV.');
        }
      } catch (e) {
        if (mounted) {
          ref.read(toastProvider.notifier).error(extractErrorMessage(e, 'Không thể xuất báo cáo tuổi nợ.'));
        }
      }
    } finally {
      if (mounted) setState(() => _exportingSection = '');
    }
  }

  Future<void> _exportDepositLedger(String format) async {
    if (_ledgerFromDate.isNotEmpty && _ledgerToDate.isNotEmpty && _ledgerFromDate.compareTo(_ledgerToDate) > 0) {
      ref.read(toastProvider.notifier).warning('Ngày bắt đầu kỳ sổ cọc không được lớn hơn ngày kết thúc.');
      return;
    }

    setState(() => _exportingSection = 'ledger-$format');
    final buildingId = ref.read(authProvider).selectedBuildingId;
    final params = <String, dynamic>{
      if (buildingId.isNotEmpty) 'building_id': buildingId,
      if (_ledgerFromDate.isNotEmpty) 'from_date': _ledgerFromDate,
      if (_ledgerToDate.isNotEmpty) 'to_date': _ledgerToDate,
      if (_ledgerStatus.isNotEmpty) 'status': _ledgerStatus,
    };
    final service = ref.read(reportsServiceProvider);

    try {
      final bytes = format == 'xlsx'
          ? await service.exportDepositLedgerXlsx(params)
          : await service.exportDepositLedgerCsv(params);

      final fileName = 'so-coc-rp07-${_ledgerFromDate.isEmpty ? 'ky' : _ledgerFromDate}-${_ledgerToDate.isEmpty ? 'nay' : _ledgerToDate}.$format';
      final mimeType = format == 'xlsx'
          ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
          : 'text/csv; charset=utf-8';

      await saveOrShareBytes(bytes, fileName: fileName, mimeType: mimeType);
      if (mounted) {
        ref.read(toastProvider.notifier).success(
              format == 'xlsx'
                  ? 'Đã xuất Báo cáo Sổ cọc (RP-07) ra tệp Excel (.xlsx).'
                  : 'Đã xuất Báo cáo Sổ cọc (RP-07) ra tệp CSV (UTF-8 BOM).',
            );
      }
    } catch (err) {
      if (mounted) {
        ref.read(toastProvider.notifier).error(
              extractErrorMessage(err, 'Không thể xuất tệp Báo cáo Sổ cọc (RP-07).'),
            );
      }
    } finally {
      if (mounted) setState(() => _exportingSection = '');
    }
  }

  void _showDepositSummaryModal() {
    final summary = _ledgerData['summary'] is Map ? (_ledgerData['summary'] as Map).cast<String, dynamic>() : {};

    AppModal.show(
      context: context,
      title: 'Tổng hợp Báo cáo Sổ cọc định kỳ (RP-07)',
      subtitle: 'Kỳ đối soát: ${_ledgerFromDate.isEmpty ? '—' : _ledgerFromDate} → ${_ledgerToDate.isEmpty ? '—' : _ledgerToDate}',
      size: AppModalSize.lg,
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
          AppButton(
            text: 'Xuất Sổ cọc Excel (.xlsx)',
            variant: AppButtonVariant.primary,
            icon: const Icon(LucideIcons.fileSpreadsheet, size: 14),
            loading: _exportingSection == 'ledger-xlsx',
            onPressed: () => _exportDepositLedger('xlsx'),
          ),
        ],
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Container(
            padding: const EdgeInsets.all(14),
            decoration: BoxDecoration(
              color: AppColors.slate50,
              borderRadius: BorderRadius.circular(12),
              border: Border.all(color: AppColors.slate200),
            ),
            child: GridView.count(
              crossAxisCount: 2,
              shrinkWrap: true,
              physics: const NeverScrollableScrollPhysics(),
              childAspectRatio: 2.4,
              children: [
                _buildSummaryModalItem('Đầu kỳ đang giữ', formatMoney(summary['opening_held'] ?? 0), AppColors.slate900),
                _buildSummaryModalItem('Cuối kỳ đang giữ', formatMoney(summary['closing_held'] ?? 0), const Color(0xFF047857)),
                _buildSummaryModalItem('Thu mới trong kỳ', '+${formatMoney(summary['collected'] ?? 0)}', const Color(0xFF0369A1)),
                _buildSummaryModalItem(
                  'Hoàn chi / Khấu trừ',
                  '-${formatMoney((num.tryParse(summary['refunded']?.toString() ?? '0') ?? 0) + (num.tryParse(summary['deducted']?.toString() ?? '0') ?? 0))}',
                  const Color(0xFF4338CA),
                ),
              ],
            ),
          ),
          const SizedBox(height: 12),
          Container(
            padding: const EdgeInsets.all(12),
            decoration: BoxDecoration(
              color: const Color(0xFFFFFBEB),
              borderRadius: BorderRadius.circular(12),
              border: Border.all(color: const Color(0xFFFDE68A)),
            ),
            child: Row(
              mainAxisAlignment: MainAxisAlignment.spaceAround,
              children: [
                Text(
                  'Quá hạn: ${summary['overdue_count'] ?? 0}',
                  style: const TextStyle(fontSize: 12, fontWeight: FontWeight.bold, color: Color(0xFF92400E)),
                ),
                Text(
                  'Khiếu nại: ${summary['disputed_count'] ?? 0}',
                  style: const TextStyle(fontSize: 12, fontWeight: FontWeight.bold, color: Color(0xFF92400E)),
                ),
                Text(
                  'Chờ chi: ${summary['pending_payout_count'] ?? 0}',
                  style: const TextStyle(fontSize: 12, fontWeight: FontWeight.bold, color: Color(0xFF92400E)),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildSummaryModalItem(String label, String value, Color valueColor) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisAlignment: MainAxisAlignment.center,
      children: [
        Text(label, style: const TextStyle(fontSize: 11, color: AppColors.slate500)),
        const SizedBox(height: 2),
        Text(
          value,
          style: TextStyle(fontSize: 14, fontWeight: FontWeight.bold, color: valueColor, fontFamily: 'monospace'),
        ),
      ],
    );
  }

  @override
  Widget build(BuildContext context) {
    ref.listen<String?>(
      authProvider.select((s) => s.selectedBuildingId),
      (prev, next) {
        if (prev != next) {
          _fetchSummary(force: true);
          if (_activeTab == 'deposit-ledger') {
            _fetchDepositLedger(force: true);
          }
        }
      },
    );

    if (_loading && _reportData['revenue_12m'] is List && (_reportData['revenue_12m'] as List).isEmpty) {
      return const PageSkeleton();
    }

    final rev12m = _reportData['revenue_12m'] is List ? _reportData['revenue_12m'] as List : [];
    final occByBuilding =
        _reportData['occupancy_by_building'] is List ? _reportData['occupancy_by_building'] as List : [];
    final agingByBuilding =
        _reportData['aging_by_building'] is List ? _reportData['aging_by_building'] as List : [];
    final slaByCategory =
        _reportData['sla_by_category'] is List ? _reportData['sla_by_category'] as List : [];

    double totalBilled12m = 0;
    double totalCollected12m = 0;
    for (final r in rev12m) {
      if (r is Map) {
        totalBilled12m += toNonNegativeNumber(r['billed']);
        totalCollected12m += toNonNegativeNumber(r['collected']);
      }
    }
    final collectionRate = totalBilled12m > 0 ? (totalCollected12m / totalBilled12m * 100).toStringAsFixed(1) : '0';

    int totalApts = 0;
    int totalOcc = 0;
    for (final b in occByBuilding) {
      if (b is Map) {
        totalApts += num.tryParse(b['total_apartments']?.toString() ?? '0')?.toInt() ?? 0;
        totalOcc += num.tryParse(b['occupied']?.toString() ?? '0')?.toInt() ?? 0;
      }
    }
    final avgOccupancy = totalApts > 0 ? (totalOcc / totalApts * 100).toStringAsFixed(1) : '0';

    double totalDebt = 0;
    for (final b in agingByBuilding) {
      if (b is Map) {
        totalDebt += toNonNegativeNumber(b['total_debt']);
      }
    }

    final ledgerSummary =
        _ledgerData['summary'] is Map ? (_ledgerData['summary'] as Map).cast<String, dynamic>() : <String, dynamic>{};
    final ledgerRsv = _ledgerData['reservation_summary'] is Map
        ? (_ledgerData['reservation_summary'] as Map).cast<String, dynamic>()
        : <String, dynamic>{};
    final ledgerItems = _ledgerData['items'] is List ? _ledgerData['items'] as List : [];

    return Scaffold(
      key: const Key('route:/admin/reports'),
      backgroundColor: AppColors.background,
      body: SingleChildScrollView(
        padding: const EdgeInsets.all(24),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            // Page Header
            PageHeader(
              title: 'Báo cáo & Phân tích Quản trị',
              subtitle:
                  'Tổng hợp chuyên sâu Doanh thu 12 tháng, Hiệu suất lấp đầy, Rủi ro tuổi nợ, Sổ cọc RP-07 và Chất lượng SLA bảo trì.',
              actions: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  AppButton(
                    text: 'Làm mới số liệu',
                    variant: AppButtonVariant.outline,
                    size: AppButtonSize.sm,
                    icon: const Icon(LucideIcons.refreshCw, size: 14),
                    onPressed: () {
                      _fetchSummary(force: true);
                      if (_activeTab == 'deposit-ledger') {
                        _fetchDepositLedger(force: true);
                      }
                    },
                  ),
                ],
              ),
            ),
            const SizedBox(height: 20),

            // Top Overview KPIs (4 cards)
            LayoutBuilder(
              builder: (context, constraints) {
                final isWide = constraints.maxWidth >= 900;
                final isMedium = constraints.maxWidth >= 600;
                final crossAxisCount = isWide ? 4 : (isMedium ? 2 : 1);

                return GridView.count(
                  crossAxisCount: crossAxisCount,
                  crossAxisSpacing: 16,
                  mainAxisSpacing: 16,
                  shrinkWrap: true,
                  physics: const NeverScrollableScrollPhysics(),
                  childAspectRatio: isWide ? 1.6 : 2.0,
                  children: [
                    StatsCard(
                      title: 'Lũy kế phát hành (12T)',
                      value: formatCompactMoney(totalBilled12m),
                      subtext: formatMoney(totalBilled12m),
                      icon: LucideIcons.barChart3,
                      color: 'sky',
                    ),
                    StatsCard(
                      title: 'Lũy kế thực thu (12T)',
                      value: formatCompactMoney(totalCollected12m),
                      valueTitle: formatMoney(totalCollected12m),
                      subtext: '${formatMoney(totalCollected12m)} • Thu hồi $collectionRate%',
                      icon: LucideIcons.trendingUp,
                      color: 'emerald',
                    ),
                    StatsCard(
                      title: 'Tỷ lệ lấp đầy trung bình',
                      value: '$avgOccupancy%',
                      subtext: '$totalOcc / $totalApts căn đang khai thác',
                      icon: LucideIcons.building2,
                      color: 'indigo',
                    ),
                    StatsCard(
                      title: 'Tổng dư nợ hiện hành',
                      value: formatCompactMoney(totalDebt),
                      subtext: formatMoney(totalDebt),
                      icon: LucideIcons.clock,
                      color: 'rose',
                    ),
                  ],
                );
              },
            ),
            const SizedBox(height: 20),

            // 6 Tabs
            AppTabs(
              activeTab: _activeTab,
              onChanged: (newTab) {
                setState(() => _activeTab = newTab);
                if (newTab == 'deposit-ledger') {
                  _fetchDepositLedger();
                }
              },
              tabs: const [
                AppTabItem(id: 'revenue', label: 'Doanh thu 12 tháng (RP-01)', icon: Icon(LucideIcons.trendingUp, size: 16)),
                AppTabItem(id: 'occupancy', label: 'Tỷ lệ lấp đầy', icon: Icon(LucideIcons.building2, size: 16)),
                AppTabItem(id: 'aging', label: 'Báo cáo tuổi nợ (RP-02)', icon: Icon(LucideIcons.clock, size: 16)),
                AppTabItem(id: 'deposit-ledger', label: 'Sổ cọc (RP-07)', icon: Icon(LucideIcons.wallet, size: 16)),
                AppTabItem(id: 'financial-audit', label: 'Nhật ký tài chính (RP-08)', icon: Icon(LucideIcons.scrollText, size: 16)),
                AppTabItem(id: 'sla', label: 'SLA Báo hỏng', icon: Icon(LucideIcons.wrench, size: 16)),
              ],
            ),
            const SizedBox(height: 20),

            // Tab Content
            switch (_activeTab) {
              'revenue' => _buildRevenueTab(rev12m),
              'occupancy' => _buildOccupancyTab(occByBuilding),
              'aging' => _buildAgingTab(agingByBuilding),
              'deposit-ledger' => _buildDepositLedgerTab(ledgerSummary, ledgerRsv, ledgerItems),
              'financial-audit' => const AuditLogsView(lockedScope: 'financial', embedded: true),
              'sla' => _buildSlaTab(slaByCategory),
              _ => const SizedBox.shrink(),
            },
          ],
        ),
      ),
    );
  }

  // ─── TAB 1: REVENUE ─────────────────────────────────────────────────────────

  Widget _buildRevenueTab(List rev12m) {
    final revenueTrend = buildRevenueTrendChartData(rev12m);

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        AppCard(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              AppCardHeader(
                title: 'Biểu đồ Phát hành vs Thực thu (12 tháng gần nhất)',
                subtitle: 'So sánh giá trị hóa đơn phát hành hàng kỳ và dòng tiền thu thực tế.',
                action: Wrap(
                  spacing: 8,
                  runSpacing: 8,
                  crossAxisAlignment: WrapCrossAlignment.center,
                  children: [
                    Container(
                      padding: const EdgeInsets.all(2),
                      decoration: BoxDecoration(
                        color: AppColors.slate100,
                        borderRadius: BorderRadius.circular(8),
                      ),
                      child: Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          _buildChartModeButton('Biểu đồ Đường', _revenueChartMode == 'line', () {
                            setState(() => _revenueChartMode = 'line');
                          }),
                          _buildChartModeButton('Biểu đồ Cột', _revenueChartMode == 'bar', () {
                            setState(() => _revenueChartMode = 'bar');
                          }),
                        ],
                      ),
                    ),
                    AppButton(
                      text: 'Xuất Excel (.xlsx)',
                      variant: AppButtonVariant.outline,
                      size: AppButtonSize.sm,
                      icon: const Icon(LucideIcons.fileSpreadsheet, size: 14),
                      loading: _exportingSection == 'revenue-xlsx',
                      onPressed: () => _exportRevenue('xlsx'),
                    ),
                    AppButton(
                      text: 'Xuất CSV',
                      variant: AppButtonVariant.outline,
                      size: AppButtonSize.sm,
                      icon: const Icon(LucideIcons.download, size: 14),
                      loading: _exportingSection == 'revenue-csv',
                      onPressed: () => _exportRevenue('csv'),
                    ),
                  ],
                ),
              ),
              const SizedBox(height: 12),
              SizedBox(
                height: 300,
                child: rev12m.isEmpty
                    ? const EmptyState(title: 'Chưa có dữ liệu doanh thu')
                    : RevenueTrendLineChart(data: revenueTrend),
              ),
            ],
          ),
        ),
        const SizedBox(height: 16),
        DataTableWidget<Map<String, dynamic>>(
          data: rev12m.reversed.map((r) => r is Map ? r.cast<String, dynamic>() : <String, dynamic>{}).toList(),
          loading: _loading,
          emptyTitle: 'Chưa có dữ liệu doanh thu',
          columns: [
            DataTableColumn(
              key: 'period',
              label: 'Kỳ hạch toán',
              render: (r) => Text(
                r['period']?.toString() ?? '',
                style: const TextStyle(fontWeight: FontWeight.bold, fontFamily: 'monospace'),
              ),
            ),
            DataTableColumn(
              key: 'invoice_count',
              label: 'Số hóa đơn',
              render: (r) => Text('${r['invoice_count'] ?? 0}'),
            ),
            DataTableColumn(
              key: 'billed',
              label: 'Tổng phát hành',
              render: (r) => Text(
                formatMoney(r['billed']),
                style: const TextStyle(fontWeight: FontWeight.w600, color: AppColors.slate900),
              ),
            ),
            DataTableColumn(
              key: 'invoice_settled',
              label: 'Tất toán HĐ',
              render: (r) => Text(
                formatMoney(r['invoice_settled'] ?? 0),
                style: const TextStyle(color: Color(0xFF047857), fontWeight: FontWeight.w500),
              ),
            ),
            DataTableColumn(
              key: 'collected',
              label: 'Thực thu ròng',
              render: (r) => Text(
                formatMoney(r['collected'] ?? 0),
                style: const TextStyle(color: Color(0xFF0369A1), fontWeight: FontWeight.bold),
              ),
            ),
            DataTableColumn(
              key: 'credit_refunded',
              label: 'Hoàn tín dụng',
              render: (r) => Text(
                formatMoney(r['credit_refunded'] ?? 0),
                style: const TextStyle(color: Color(0xFFBE185D)),
              ),
            ),
            DataTableColumn(
              key: 'rate',
              label: 'Tỷ lệ thu',
              render: (r) {
                final b = toNonNegativeNumber(r['billed']);
                final c = toNonNegativeNumber(r['collected']);
                final pct = b > 0 ? (c / b * 100).round() : 0;
                return AppBadge(
                  label: '$pct%',
                  variant: pct >= 90
                      ? AppBadgeVariant.emerald
                      : pct >= 60
                          ? AppBadgeVariant.amber
                          : AppBadgeVariant.slate,
                );
              },
            ),
            DataTableColumn(
              key: 'outstanding',
              label: 'Còn phải thu',
              render: (r) => Text(
                formatMoney(r['outstanding']),
                style: const TextStyle(color: Color(0xFFE11D48), fontWeight: FontWeight.w600),
              ),
            ),
          ],
        ),
      ],
    );
  }

  // ─── TAB 2: OCCUPANCY ───────────────────────────────────────────────────────

  Widget _buildOccupancyTab(List occByBuilding) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        AppCard(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              AppCardHeader(
                title: 'Cơ cấu khai thác căn hộ theo từng tòa nhà',
                subtitle: 'Theo dõi tỷ lệ lấp đầy thực tế để tối ưu chính sách giá thuê và marketing.',
                action: AppButton(
                  text: 'Xuất CSV',
                  variant: AppButtonVariant.outline,
                  size: AppButtonSize.sm,
                  icon: const Icon(LucideIcons.download, size: 14),
                  onPressed: _exportOccupancyCsv,
                ),
              ),
              const SizedBox(height: 12),
              if (occByBuilding.isEmpty)
                const EmptyState(title: 'Chưa có dữ liệu tòa nhà')
              else
                LayoutBuilder(
                  builder: (context, constraints) {
                    final isWide = constraints.maxWidth >= 700;
                    final crossAxisCount = isWide ? 2 : 1;

                    return GridView.builder(
                      shrinkWrap: true,
                      physics: const NeverScrollableScrollPhysics(),
                      gridDelegate: SliverGridDelegateWithFixedCrossAxisCount(
                        crossAxisCount: crossAxisCount,
                        crossAxisSpacing: 16,
                        mainAxisSpacing: 16,
                        childAspectRatio: isWide ? 2.1 : 2.0,
                      ),
                      itemCount: occByBuilding.length,
                      itemBuilder: (context, idx) {
                        final b = occByBuilding[idx] as Map;
                        final rate = num.tryParse(b['occupancy_rate']?.toString() ?? '0')?.toDouble() ?? 0.0;
                        final barColor = rate >= 85
                            ? const Color(0xFF10B981)
                            : rate >= 60
                                ? const Color(0xFF0EA5E9)
                                : const Color(0xFFF59E0B);

                        return Container(
                          padding: const EdgeInsets.all(16),
                          decoration: BoxDecoration(
                            color: Colors.white,
                            borderRadius: BorderRadius.circular(12),
                            border: Border.all(color: AppColors.slate200),
                          ),
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.stretch,
                            children: [
                              Row(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  Expanded(
                                    child: Column(
                                      crossAxisAlignment: CrossAxisAlignment.start,
                                      children: [
                                        Container(
                                          padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                                          decoration: BoxDecoration(
                                            color: const Color(0xFFF0F9FF),
                                            borderRadius: BorderRadius.circular(4),
                                          ),
                                          child: Text(
                                            b['building_code']?.toString() ?? '',
                                            style: const TextStyle(
                                              fontSize: 11,
                                              fontWeight: FontWeight.bold,
                                              color: AppColors.primary700,
                                            ),
                                          ),
                                        ),
                                        const SizedBox(height: 4),
                                        Text(
                                          b['building_name']?.toString() ?? '',
                                          style: const TextStyle(fontSize: 14, fontWeight: FontWeight.bold),
                                        ),
                                      ],
                                    ),
                                  ),
                                  Column(
                                    crossAxisAlignment: CrossAxisAlignment.end,
                                    children: [
                                      Text(
                                        '$rate%',
                                        style: const TextStyle(fontSize: 20, fontWeight: FontWeight.bold),
                                      ),
                                      const Text(
                                        'Tỷ lệ lấp đầy',
                                        style: TextStyle(fontSize: 10, color: AppColors.slate500),
                                      ),
                                    ],
                                  ),
                                ],
                              ),
                              const SizedBox(height: 12),
                              ClipRRect(
                                borderRadius: BorderRadius.circular(6),
                                child: LinearProgressIndicator(
                                  value: (rate / 100).clamp(0.0, 1.0),
                                  minHeight: 8,
                                  backgroundColor: AppColors.slate100,
                                  valueColor: AlwaysStoppedAnimation<Color>(barColor),
                                ),
                              ),
                              const Spacer(),
                              Row(
                                children: [
                                  _buildOccupancyStatBox('Đang thuê', '${b['occupied'] ?? 0}', const Color(0xFFECFDF5), const Color(0xFF065F46)),
                                  const SizedBox(width: 6),
                                  _buildOccupancyStatBox('Còn trống', '${b['available'] ?? 0}', const Color(0xFFF0F9FF), const Color(0xFF075985)),
                                  const SizedBox(width: 6),
                                  _buildOccupancyStatBox('Giữ chỗ', '${b['reserved'] ?? 0}', const Color(0xFFFFFBEB), const Color(0xFF92400E)),
                                  const SizedBox(width: 6),
                                  _buildOccupancyStatBox('Bảo trì', '${b['maintenance'] ?? 0}', const Color(0xFFF1F5F9), const Color(0xFF334155)),
                                ],
                              ),
                            ],
                          ),
                        );
                      },
                    );
                  },
                ),
            ],
          ),
        ),
      ],
    );
  }

  Widget _buildOccupancyStatBox(String label, String value, Color bg, Color text) {
    return Expanded(
      child: Container(
        padding: const EdgeInsets.symmetric(vertical: 6),
        decoration: BoxDecoration(color: bg, borderRadius: BorderRadius.circular(6)),
        child: Column(
          children: [
            Text(value, style: TextStyle(fontSize: 13, fontWeight: FontWeight.bold, color: text)),
            Text(label, style: TextStyle(fontSize: 10, color: text)),
          ],
        ),
      ),
    );
  }

  // ─── TAB 3: AGING ───────────────────────────────────────────────────────────

  Widget _buildAgingTab(List agingByBuilding) {
    final buildingAgingData = buildReportsBuildingAgingChartData(agingByBuilding);

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        AppCard(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              AppCardHeader(
                title: 'Phân bổ tuổi nợ (Aging) theo từng tòa nhà',
                subtitle:
                    'Phân tầng công nợ theo 5 nhóm tuổi nợ chuẩn PRD: Chưa đến hạn, 1–15, 16–30, 31–60 và trên 60 ngày.',
                action: Wrap(
                  spacing: 8,
                  children: [
                    AppButton(
                      text: 'Xuất Excel (.xlsx)',
                      variant: AppButtonVariant.outline,
                      size: AppButtonSize.sm,
                      icon: const Icon(LucideIcons.fileSpreadsheet, size: 14),
                      loading: _exportingSection == 'aging-xlsx',
                      onPressed: () => _exportAging('xlsx'),
                    ),
                    AppButton(
                      text: 'Xuất CSV',
                      variant: AppButtonVariant.outline,
                      size: AppButtonSize.sm,
                      icon: const Icon(LucideIcons.download, size: 14),
                      loading: _exportingSection == 'aging-csv',
                      onPressed: () => _exportAging('csv'),
                    ),
                  ],
                ),
              ),
              const SizedBox(height: 12),
              SizedBox(
                height: 300,
                child: agingByBuilding.isEmpty
                    ? const EmptyState(
                        icon: LucideIcons.clock,
                        title: 'Không có công nợ tồn đọng',
                        description: 'Hiện tại toàn bộ các tòa nhà trong phạm vi đều đã thu đủ công nợ.',
                      )
                    : BuildingAgingStackedBarChart(data: buildingAgingData),
              ),
            ],
          ),
        ),
        const SizedBox(height: 16),
        DataTableWidget<Map<String, dynamic>>(
          data: agingByBuilding.map((b) => b is Map ? b.cast<String, dynamic>() : <String, dynamic>{}).toList(),
          loading: _loading,
          emptyTitle: 'Không có công nợ quá hạn theo tòa nhà',
          columns: [
            DataTableColumn(
              key: 'building_name',
              label: 'Tòa nhà',
              render: (r) => Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(r['building_name']?.toString() ?? '', style: const TextStyle(fontWeight: FontWeight.bold)),
                  Text(r['building_code']?.toString() ?? '', style: const TextStyle(fontSize: 11, color: AppColors.slate500)),
                ],
              ),
            ),
            DataTableColumn(
              key: 'current_not_due',
              label: 'Chưa đến hạn',
              render: (r) => Text(formatMoney(r['current_not_due'] ?? 0), style: const TextStyle(color: AppColors.slate600)),
            ),
            DataTableColumn(
              key: 'bucket_0_15',
              label: '1 – 15 ngày',
              render: (r) => Text(formatMoney(r['bucket_0_15'] ?? 0), style: const TextStyle(color: Color(0xFF047857))),
            ),
            DataTableColumn(
              key: 'bucket_16_30',
              label: '16 – 30 ngày',
              render: (r) => Text(formatMoney(r['bucket_16_30'] ?? 0), style: const TextStyle(color: Color(0xFFB45309))),
            ),
            DataTableColumn(
              key: 'bucket_31_60',
              label: '31 – 60 ngày',
              render: (r) => Text(formatMoney(r['bucket_31_60'] ?? 0), style: const TextStyle(color: Color(0xFFEA580C))),
            ),
            DataTableColumn(
              key: 'bucket_over_60',
              label: '> 60 ngày',
              render: (r) => Text(
                formatMoney(r['bucket_over_60'] ?? 0),
                style: const TextStyle(color: Color(0xFFBE123C), fontWeight: FontWeight.bold),
              ),
            ),
            DataTableColumn(
              key: 'total_debt',
              label: 'Tổng dư nợ',
              render: (r) => Text(
                formatMoney(r['total_debt'] ?? 0),
                style: const TextStyle(fontWeight: FontWeight.bold, color: AppColors.slate900),
              ),
            ),
          ],
        ),
      ],
    );
  }

  // ─── TAB 4: DEPOSIT LEDGER ──────────────────────────────────────────────────

  Widget _buildDepositLedgerTab(Map summary, Map rsv, List items) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        // Filter card
        AppCard(
          child: Wrap(
            spacing: 12,
            runSpacing: 12,
            crossAxisAlignment: WrapCrossAlignment.end,
            alignment: WrapAlignment.spaceBetween,
            children: [
              Wrap(
                spacing: 12,
                runSpacing: 12,
                children: [
                  SizedBox(
                    width: 160,
                    child: AppInput(
                      label: 'Từ ngày',
                      initialValue: _ledgerFromDate,
                      onChanged: (v) => _ledgerFromDate = v,
                    ),
                  ),
                  SizedBox(
                    width: 160,
                    child: AppInput(
                      label: 'Đến ngày',
                      initialValue: _ledgerToDate,
                      onChanged: (v) => _ledgerToDate = v,
                    ),
                  ),
                  SizedBox(
                    width: 220,
                    child: AppSelect<String>(
                      label: 'Trạng thái sổ cọc',
                      value: _ledgerStatus,
                      options: kDepositStatusFilterOptions,
                      onChanged: (v) {
                        setState(() => _ledgerStatus = v ?? '');
                        _fetchDepositLedger();
                      },
                    ),
                  ),
                  Padding(
                    padding: const EdgeInsets.only(bottom: 2),
                    child: AppButton(
                      text: 'Lọc',
                      variant: AppButtonVariant.primary,
                      size: AppButtonSize.md,
                      onPressed: () => _fetchDepositLedger(force: true),
                    ),
                  ),
                ],
              ),
              Wrap(
                spacing: 8,
                children: [
                  AppButton(
                    text: 'Tóm tắt kỳ',
                    variant: AppButtonVariant.outline,
                    size: AppButtonSize.sm,
                    icon: const Icon(LucideIcons.fileText, size: 14),
                    onPressed: _showDepositSummaryModal,
                  ),
                  AppButton(
                    text: 'Xuất Excel (.xlsx)',
                    variant: AppButtonVariant.primary,
                    size: AppButtonSize.sm,
                    icon: const Icon(LucideIcons.fileSpreadsheet, size: 14),
                    loading: _exportingSection == 'ledger-xlsx',
                    onPressed: () => _exportDepositLedger('xlsx'),
                  ),
                  AppButton(
                    text: 'Xuất CSV',
                    variant: AppButtonVariant.outline,
                    size: AppButtonSize.sm,
                    icon: const Icon(LucideIcons.download, size: 14),
                    loading: _exportingSection == 'ledger-csv',
                    onPressed: () => _exportDepositLedger('csv'),
                  ),
                ],
              ),
            ],
          ),
        ),
        const SizedBox(height: 16),

        // 6 Balance cards
        LayoutBuilder(
          builder: (context, constraints) {
            final isWide = constraints.maxWidth >= 1000;
            final isMedium = constraints.maxWidth >= 600;
            final crossAxisCount = isWide ? 6 : (isMedium ? 3 : 1);

            final col = toNonNegativeNumber(summary['collected']);
            final tin = toNonNegativeNumber(summary['transfer_in']);
            final ref = toNonNegativeNumber(summary['refunded']);
            final tout = toNonNegativeNumber(summary['transfer_out']);

            return GridView.count(
              crossAxisCount: crossAxisCount,
              crossAxisSpacing: 10,
              mainAxisSpacing: 10,
              shrinkWrap: true,
              physics: const NeverScrollableScrollPhysics(),
              childAspectRatio: isWide ? 1.6 : 2.4,
              children: [
                _buildLedgerBalanceCard(
                  title: 'Đầu kỳ đang giữ',
                  value: formatMoney(summary['opening_held'] ?? 0),
                  sub: 'Số dư mở sổ',
                  bg: Colors.white,
                  border: AppColors.slate200,
                  textColor: AppColors.slate900,
                ),
                _buildLedgerBalanceCard(
                  title: 'Thu mới + Nhận KC',
                  value: '+${formatMoney(col + tin)}',
                  sub: 'Thu: ${formatCompactMoney(col)} • KC đến: ${formatCompactMoney(tin)}',
                  bg: const Color(0xFFECFDF5),
                  border: const Color(0xFFA7F3D0),
                  textColor: const Color(0xFF047857),
                ),
                _buildLedgerBalanceCard(
                  title: 'Đã khấu trừ cọc',
                  value: '-${formatMoney(summary['deducted'] ?? 0)}',
                  sub: 'Hư hỏng / Nợ dịch vụ',
                  bg: const Color(0xFFFFFBEB),
                  border: const Color(0xFFFDE68A),
                  textColor: const Color(0xFFB45309),
                ),
                _buildLedgerBalanceCard(
                  title: 'Hoàn chi + KC đi',
                  value: '-${formatMoney(ref + tout)}',
                  sub: 'Hoàn: ${formatCompactMoney(ref)} • KC đi: ${formatCompactMoney(tout)}',
                  bg: const Color(0xFFEEF2FF),
                  border: const Color(0xFFC7D2FE),
                  textColor: const Color(0xFF4338CA),
                ),
                _buildLedgerBalanceCard(
                  title: 'Cuối kỳ đang giữ',
                  value: formatMoney(summary['closing_held'] ?? 0),
                  sub: 'Khớp cân đối sổ cái',
                  bg: const Color(0xFFF0F9FF),
                  border: const Color(0xFFBAE6FD),
                  textColor: const Color(0xFF0369A1),
                ),
                _buildLedgerBalanceCard(
                  title: 'Cảnh báo tồn đọng',
                  value:
                      '${(num.tryParse(summary['pending_payout_count']?.toString() ?? '0') ?? 0) + (num.tryParse(summary['returned_count']?.toString() ?? '0') ?? 0)} chờ chi',
                  sub: 'Quá hạn: ${summary['overdue_count'] ?? 0} • Tranh chấp: ${summary['disputed_count'] ?? 0}',
                  bg: const Color(0xFFFFF1F2),
                  border: const Color(0xFFFECDD3),
                  textColor: const Color(0xFFBE123C),
                ),
              ],
            );
          },
        ),
        const SizedBox(height: 16),

        // Reservation Summary Card
        AppCard(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const AppCardHeader(
                title: 'Đối soát Tiền đặt giữ chỗ ngoài Hợp đồng',
                subtitle:
                    'Bảo toàn 100% số dư VND: tách biệt tiền đang giữ chỗ (HELD), tiền đã duyệt chờ chi hoàn (APPROVED_PENDING_PAYOUT) và phiếu chờ xác nhận sao kê (PENDING_CONFIRM).',
              ),
              const SizedBox(height: 12),
              LayoutBuilder(
                builder: (context, constraints) {
                  final isWide = constraints.maxWidth >= 900;
                  final crossAxisCount = isWide ? 5 : 2;

                  return GridView.count(
                    crossAxisCount: crossAxisCount,
                    crossAxisSpacing: 10,
                    mainAxisSpacing: 10,
                    shrinkWrap: true,
                    physics: const NeverScrollableScrollPhysics(),
                    childAspectRatio: isWide ? 1.9 : 2.4,
                    children: [
                      _buildRsvBox(
                        title: 'Đang giữ chỗ (HELD)',
                        amount: formatMoney(rsv['active_held_amount'] ?? 0),
                        note: '${rsv['active_held_count'] ?? 0} phiếu đang khóa phòng',
                        bg: const Color(0xFFECFDF5),
                        border: const Color(0xFFA7F3D0),
                        color: const Color(0xFF065F46),
                      ),
                      _buildRsvBox(
                        title: 'Đã duyệt chờ chi hoàn',
                        amount: formatMoney(rsv['pending_payout_amount'] ?? 0),
                        note: '${rsv['pending_payout_count'] ?? 0} phiếu chờ BQL chi',
                        bg: const Color(0xFFEEF2FF),
                        border: const Color(0xFFC7D2FE),
                        color: const Color(0xFF3730A3),
                      ),
                      _buildRsvBox(
                        title: 'Chờ đối chiếu sao kê',
                        amount: formatMoney(rsv['pending_confirm_amount'] ?? 0),
                        note: '${rsv['pending_confirm_count'] ?? 0} phiếu chưa hạch toán',
                        bg: const Color(0xFFFFFBEB),
                        border: const Color(0xFFFDE68A),
                        color: const Color(0xFF92400E),
                      ),
                      _buildRsvBox(
                        title: 'Hoàn trả trong kỳ',
                        amount: formatMoney(rsv['refunded_in_period'] ?? 0),
                        note: 'Phiếu REFUNDED',
                        bg: const Color(0xFFF0F9FF),
                        border: const Color(0xFFBAE6FD),
                        color: const Color(0xFF075985),
                      ),
                      _buildRsvBox(
                        title: 'Tịch thu trong kỳ',
                        amount: formatMoney(rsv['forfeited_in_period'] ?? 0),
                        note: 'Doanh thu phạt hủy',
                        bg: const Color(0xFFFFF1F2),
                        border: const Color(0xFFFECDD3),
                        color: const Color(0xFF9F1239),
                      ),
                    ],
                  );
                },
              ),
            ],
          ),
        ),
        const SizedBox(height: 16),

        // Deposit Ledger Table
        DataTableWidget<Map<String, dynamic>>(
          data: items.map((i) => i is Map ? i.cast<String, dynamic>() : <String, dynamic>{}).toList(),
          loading: _ledgerLoading,
          emptyTitle: 'Không có sổ cọc nào trong phạm vi lọc',
          columns: [
            DataTableColumn(
              key: 'apartment_code',
              label: 'Căn hộ / Tòa',
              width: 140,
              render: (r) => Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(r['apartment_code']?.toString() ?? '', style: const TextStyle(fontWeight: FontWeight.bold)),
                  Text(r['building_code']?.toString() ?? '', style: const TextStyle(fontSize: 11, color: AppColors.slate500)),
                ],
              ),
            ),
            DataTableColumn(
              key: 'tenant_name',
              label: 'Khách thuê',
              width: 160,
              render: (r) => Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(r['tenant_name']?.toString() ?? '—', style: const TextStyle(fontWeight: FontWeight.w500)),
                  if (r['tenant_phone'] != null)
                    Text(r['tenant_phone'].toString(), style: const TextStyle(fontSize: 11, color: AppColors.slate500)),
                ],
              ),
            ),
            DataTableColumn(
              key: 'deposit_status',
              label: 'Trạng thái sổ',
              width: 140,
              render: (r) => StatusBadge(status: r['deposit_status']?.toString(), domain: StatusDomain.deposit),
            ),
            DataTableColumn(
              key: 'opening_held',
              label: 'Đầu kỳ',
              width: 130,
              render: (r) => Text(formatMoney(r['opening_held'] ?? 0)),
            ),
            DataTableColumn(
              key: 'collected',
              label: 'Thu mới / KC đến',
              width: 150,
              render: (r) {
                final totalIn = toNonNegativeNumber(r['collected']) +
                    toNonNegativeNumber(r['transfer_in']) +
                    toNonNegativeNumber(r['refund_reversed']);
                return Text('+${formatMoney(totalIn)}', style: const TextStyle(color: Color(0xFF047857), fontWeight: FontWeight.w600));
              },
            ),
            DataTableColumn(
              key: 'deducted',
              label: 'Khấu trừ',
              width: 130,
              render: (r) {
                final d = toNonNegativeNumber(r['deducted']);
                return Text(d > 0 ? '-${formatMoney(d)}' : formatMoney(0), style: const TextStyle(color: Color(0xFFB45309)));
              },
            ),
            DataTableColumn(
              key: 'refunded',
              label: 'Hoàn chi / KC đi',
              width: 150,
              render: (r) {
                final totalOut = toNonNegativeNumber(r['refunded']) + toNonNegativeNumber(r['transfer_out']);
                return Text(totalOut > 0 ? '-${formatMoney(totalOut)}' : formatMoney(0), style: const TextStyle(color: Color(0xFF4338CA)));
              },
            ),
            DataTableColumn(
              key: 'closing_held',
              label: 'Cuối kỳ đang giữ',
              width: 150,
              render: (r) => Text(
                formatMoney(r['closing_held'] ?? 0),
                style: const TextStyle(fontWeight: FontWeight.bold, color: AppColors.slate900),
              ),
            ),
            DataTableColumn(
              key: 'refund_due_date',
              label: 'Hạn hoàn cọc',
              width: 140,
              render: (r) {
                final isOverdue = r['is_overdue'] == true;
                final date = formatDate(r['refund_due_date']);
                if (date == '—') return const Text('—', style: TextStyle(color: AppColors.slate400));
                return Text(
                  isOverdue ? '$date (Quá hạn)' : date,
                  style: TextStyle(
                    fontSize: 12,
                    fontWeight: isOverdue ? FontWeight.bold : FontWeight.normal,
                    color: isOverdue ? const Color(0xFFE11D48) : AppColors.slate700,
                  ),
                );
              },
            ),
          ],
        ),
      ],
    );
  }

  Widget _buildLedgerBalanceCard({
    required String title,
    required String value,
    required String sub,
    required Color bg,
    required Color border,
    required Color textColor,
  }) {
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(color: bg, borderRadius: BorderRadius.circular(12), border: Border.all(color: border)),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Text(title, style: const TextStyle(fontSize: 11, color: AppColors.slate500)),
          const SizedBox(height: 2),
          Text(
            value,
            style: TextStyle(fontSize: 14, fontWeight: FontWeight.bold, color: textColor, fontFamily: 'monospace'),
          ),
          const SizedBox(height: 2),
          Text(sub, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 10, color: AppColors.slate400)),
        ],
      ),
    );
  }

  Widget _buildRsvBox({
    required String title,
    required String amount,
    required String note,
    required Color bg,
    required Color border,
    required Color color,
  }) {
    return Container(
      padding: const EdgeInsets.all(10),
      decoration: BoxDecoration(color: bg, borderRadius: BorderRadius.circular(8), border: Border.all(color: border)),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Text(title, style: TextStyle(fontSize: 11, fontWeight: FontWeight.w600, color: color)),
          const SizedBox(height: 2),
          Text(
            amount,
            style: TextStyle(fontSize: 14, fontWeight: FontWeight.bold, color: color, fontFamily: 'monospace'),
          ),
          const SizedBox(height: 2),
          Text(note, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 10, color: color)),
        ],
      ),
    );
  }

  // ─── TAB 6: SLA ─────────────────────────────────────────────────────────────

  Widget _buildSlaTab(List slaByCategory) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        AppCard(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const AppCardHeader(
                title: 'Thời gian xử lý sự cố trung bình theo hạng mục (giờ)',
                subtitle: 'Đánh giá tốc độ phản ứng kỹ thuật và mức độ hài lòng của cư dân.',
              ),
              const SizedBox(height: 12),
              if (slaByCategory.isEmpty)
                const EmptyState(title: 'Chưa có dữ liệu yêu cầu bảo trì')
              else
                SizedBox(
                  height: 280,
                  child: BarChart(
                    BarChartData(
                      maxY: _computeMaxHours(slaByCategory) * 1.2,
                      barGroups: [
                        for (int i = 0; i < slaByCategory.length; i++)
                          BarChartGroupData(
                            x: i,
                            barRods: [
                              BarChartRodData(
                                toY: toNonNegativeNumber((slaByCategory[i] as Map)['avg_resolve_hours']),
                                color: const Color(0xFF6366F1),
                                width: 22,
                                borderRadius: BorderRadius.circular(4),
                              ),
                            ],
                          ),
                      ],
                      titlesData: FlTitlesData(
                        leftTitles: AxisTitles(
                          sideTitles: SideTitles(
                            showTitles: true,
                            reservedSize: 40,
                            getTitlesWidget: (v, meta) => Text('${v.toInt()}h', style: const TextStyle(fontSize: 10)),
                          ),
                        ),
                        rightTitles: const AxisTitles(sideTitles: SideTitles(showTitles: false)),
                        topTitles: const AxisTitles(sideTitles: SideTitles(showTitles: false)),
                        bottomTitles: AxisTitles(
                          sideTitles: SideTitles(
                            showTitles: true,
                            reservedSize: 32,
                            getTitlesWidget: (v, meta) {
                              final idx = v.toInt();
                              if (idx >= 0 && idx < slaByCategory.length) {
                                final cat = (slaByCategory[idx] as Map)['category']?.toString() ?? '';
                                final label = kServiceRequestCategories[cat] ?? cat;
                                return Padding(
                                  padding: const EdgeInsets.only(top: 6),
                                  child: Text(
                                    label.length > 10 ? '${label.substring(0, 8)}...' : label,
                                    style: const TextStyle(fontSize: 10),
                                  ),
                                );
                              }
                              return const SizedBox.shrink();
                            },
                          ),
                        ),
                      ),
                      borderData: FlBorderData(show: false),
                    ),
                  ),
                ),
            ],
          ),
        ),
        const SizedBox(height: 16),
        DataTableWidget<Map<String, dynamic>>(
          data: slaByCategory.map((s) => s is Map ? s.cast<String, dynamic>() : <String, dynamic>{}).toList(),
          loading: _loading,
          emptyTitle: 'Chưa có dữ liệu SLA bảo trì',
          columns: [
            DataTableColumn(
              key: 'category',
              label: 'Hạng mục kỹ thuật',
              width: 180,
              render: (r) {
                final cat = r['category']?.toString() ?? '';
                return Text(
                  kServiceRequestCategories[cat] ?? cat,
                  style: const TextStyle(fontWeight: FontWeight.bold),
                );
              },
            ),
            DataTableColumn(
              key: 'total_requests',
              label: 'Tổng yêu cầu',
              width: 120,
              render: (r) => Text('${r['total_requests'] ?? 0}'),
            ),
            DataTableColumn(
              key: 'resolved_count',
              label: 'Đã hoàn thành',
              width: 130,
              render: (r) => Text(
                '${r['resolved_count'] ?? 0}',
                style: const TextStyle(color: Color(0xFF047857), fontWeight: FontWeight.w600),
              ),
            ),
            DataTableColumn(
              key: 'open_count',
              label: 'Đang mở',
              width: 110,
              render: (r) => Text(
                '${r['open_count'] ?? 0}',
                style: const TextStyle(color: Color(0xFFB45309)),
              ),
            ),
            DataTableColumn(
              key: 'avg_resolve_hours',
              label: 'Thời gian xử lý TB',
              width: 160,
              render: (r) {
                if (r['avg_resolve_hours'] == null) {
                  return const Text('Chưa có mẫu', style: TextStyle(fontSize: 11, color: AppColors.slate400));
                }
                final hrs = num.tryParse(r['avg_resolve_hours'].toString()) ?? 0;
                return AppBadge(
                  label: '${hrs.toStringAsFixed(1)} giờ',
                  variant: hrs <= 24 ? AppBadgeVariant.emerald : AppBadgeVariant.amber,
                );
              },
            ),
            DataTableColumn(
              key: 'avg_rating',
              label: 'Điểm đánh giá TB',
              width: 180,
              render: (r) {
                if (r['avg_rating'] == null) {
                  return const Text('Chưa có đánh giá', style: TextStyle(fontSize: 11, color: AppColors.slate400));
                }
                final rating = num.tryParse(r['avg_rating'].toString())?.toDouble() ?? 0.0;
                return FittedBox(
                  fit: BoxFit.scaleDown,
                  alignment: Alignment.centerLeft,
                  child: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      const Icon(LucideIcons.star, size: 14, color: Color(0xFFF59E0B)),
                      const SizedBox(width: 4),
                      Text(
                        '${rating.toStringAsFixed(2)} / 5.00',
                        style: const TextStyle(fontWeight: FontWeight.w600, color: Color(0xFFD97706)),
                      ),
                    ],
                  ),
                );
              },
            ),
          ],
        ),
      ],
    );
  }

  double _computeMaxHours(List rows) {
    double m = 0;
    for (final r in rows) {
      if (r is Map) {
        final h = toNonNegativeNumber(r['avg_resolve_hours']);
        if (h > m) m = h;
      }
    }
    return m > 0 ? m : 10.0;
  }

  Widget _buildChartModeButton(String label, bool active, VoidCallback onTap) {
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(6),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
        decoration: BoxDecoration(
          color: active ? Colors.white : Colors.transparent,
          borderRadius: BorderRadius.circular(6),
          boxShadow: active
              ? const [
                  BoxShadow(color: Color(0x0F000000), blurRadius: 4, offset: Offset(0, 1)),
                ]
              : null,
        ),
        child: Text(
          label,
          style: TextStyle(
            fontSize: 11,
            fontWeight: FontWeight.w600,
            color: active ? AppColors.primary700 : AppColors.slate600,
          ),
        ),
      ),
    );
  }
}
