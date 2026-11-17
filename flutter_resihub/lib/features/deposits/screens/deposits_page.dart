import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../../../core/theme/app_colors.dart';
import '../../../core/utils/date_range.dart';
import '../../../core/utils/file_exporter.dart';
import '../../../core/utils/format.dart';
import '../../../core/utils/idempotency.dart';
import '../../../core/utils/validation.dart';
import '../../../shared/providers/toast_provider.dart';
import '../../../shared/widgets/common/empty_state.dart';
import '../../../shared/widgets/common/loading_spinner.dart';
import '../../../shared/widgets/common/page_header.dart';
import '../../../shared/widgets/common/search_bar_widget.dart';
import '../../../shared/widgets/common/stats_card.dart';
import '../../../shared/widgets/ui/app_badge.dart';
import '../../../shared/widgets/ui/app_button.dart';
import '../../../shared/widgets/ui/app_card.dart';
import '../../../shared/widgets/ui/app_tabs.dart';
import '../../auth/providers/auth_provider.dart';
import '../services/deposits_service.dart';
import '../widgets/deposit_detail_modal.dart';

/// Bộ lọc nhanh từ Dashboard (khớp `DepositsPage.jsx`: overdue / tab=payout / status).
enum _DepositQuickFilter { none, payout, overdue, disputed }

class DepositsPage extends ConsumerStatefulWidget {
  final String? initialDepositId;
  final String? initialModal;

  const DepositsPage({
    super.key,
    this.initialDepositId,
    this.initialModal,
  });

  @override
  ConsumerState<DepositsPage> createState() => _DepositsPageState();
}

class _DepositsPageState extends ConsumerState<DepositsPage> {
  List<Map<String, dynamic>> _deposits = [];
  bool _loading = true;
  String _activeTab = 'held';
  String _search = '';
  bool _deepLinkHandled = false;
  _DepositQuickFilter _quickFilter = _DepositQuickFilter.none;

  @override
  void initState() {
    super.initState();
    _loadInitialData();
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    // Không có GoRouter (widget test cũ) → bỏ qua bộ lọc nhanh.
    final params = GoRouter.maybeOf(context) != null
        ? GoRouterState.of(context).uri.queryParameters
        : const <String, String>{};
    final status = params['status'];
    final tab = params['tab'];
    final overdue = params['overdue'] == '1';

    // activeTab: khớp useEffect trong React (status > payout > tab hợp lệ).
    if (status == 'DISPUTED') {
      _activeTab = 'disputed';
    } else if (tab == 'payout') {
      _activeTab = 'pending';
    } else if (tab != null &&
        ['held', 'pending', 'returned', 'refunded', 'disputed'].contains(tab)) {
      _activeTab = tab;
    }

    // quickFilter: khớp precedence trong filteredDeposits của React (overdue > payout > status).
    if (overdue) {
      _quickFilter = _DepositQuickFilter.overdue;
    } else if (tab == 'payout') {
      _quickFilter = _DepositQuickFilter.payout;
    } else if (status == 'DISPUTED') {
      _quickFilter = _DepositQuickFilter.disputed;
    } else {
      _quickFilter = _DepositQuickFilter.none;
    }
  }

  String get _quickFilterLabel {
    switch (_quickFilter) {
      case _DepositQuickFilter.overdue:
        return 'Các sổ cọc quá hạn hoàn trả (FR-068)';
      case _DepositQuickFilter.payout:
        return 'Các sổ cọc chờ BQL chi hoàn UNC / ngân hàng trả lại';
      case _DepositQuickFilter.disputed:
        return 'Trạng thái DISPUTED';
      case _DepositQuickFilter.none:
        return '';
    }
  }

  void _loadInitialData() {
    try {
      final service = ref.read(depositsServiceProvider);
      final peeked = service.peekList();
      if (peeked is Map && peeked['data'] is List) {
        _deposits = (peeked['data'] as List)
            .whereType<Map>()
            .map((e) => Map<String, dynamic>.from(e))
            .toList();
        _loading = false;
        _handleDeepLink();
      }
    } catch (_) {}
    _fetchDeposits();
  }

  Future<void> _fetchDeposits({bool force = false}) async {
    try {
      final service = ref.read(depositsServiceProvider);
      final res = await service.list(null, force);
      if (!mounted) return;
      if (res is Map && res['data'] is List) {
        setState(() {
          _deposits = (res['data'] as List)
              .whereType<Map>()
              .map((e) => Map<String, dynamic>.from(e))
              .toList();
          _loading = false;
        });
      } else if (res is List) {
        setState(() {
          _deposits = res
              .whereType<Map>()
              .map((e) => Map<String, dynamic>.from(e))
              .toList();
          _loading = false;
        });
      } else {
        setState(() {
          _deposits = [];
          _loading = false;
        });
      }
      _handleDeepLink();
    } catch (err) {
      if (mounted) {
        setState(() => _loading = false);
        ref.read(toastProvider.notifier).error(
              extractErrorMessage(err, 'Không thể tải danh sách sổ cọc.'),
            );
      }
    }
  }

  void _handleDeepLink() {
    if (_deepLinkHandled || widget.initialDepositId == null) return;
    _deepLinkHandled = true;

    final targetId = widget.initialDepositId;
    final dep = _deposits.cast<Map<String, dynamic>?>().firstWhere(
          (d) => d != null && d['id']?.toString() == targetId,
          orElse: () => null,
        );

    if (dep == null) {
      ref.read(toastProvider.notifier).info(
          'Bản ghi liên quan không còn tồn tại hoặc đã thay đổi trạng thái.');
      return;
    }

    final status = dep['status']?.toString();
    if (status == 'DISPUTED') {
      _activeTab = 'disputed';
    } else if (status == 'RETURNED') {
      _activeTab = 'returned';
    } else if (status == 'PENDING_APPROVAL' ||
        status == 'APPROVED_PENDING_PAYOUT') {
      _activeTab = 'pending';
    } else if ([
      'REFUNDED',
      'PARTIALLY_REFUNDED',
      'DEDUCTED_FULL',
      'TRANSFERRED'
    ].contains(status)) {
      _activeTab = 'refunded';
    } else {
      _activeTab = 'held';
    }

    final targetModal = widget.initialModal;
    final tabIdx = (targetModal == 'settlement' ||
            status == 'PENDING_APPROVAL' ||
            status == 'APPROVED_PENDING_PAYOUT')
        ? 0
        : 1;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      _openDetailModal(dep, initialTabIndex: tabIdx);
    });
  }

  void _openDetailModal(Map<String, dynamic> deposit,
      {int initialTabIndex = 1}) {
    DepositDetailModal.show(
      context,
      deposit: deposit,
      initialTabIndex: initialTabIndex,
      onRefresh: () => _fetchDeposits(force: true),
    );
  }

  Future<void> _exportExcelLedger() async {
    try {
      final headers = [
        const CsvHeader(label: 'Mã phòng', key: 'apartment_code'),
        const CsvHeader(label: 'Tòa nhà', key: 'building_name'),
        const CsvHeader(label: 'Khách thuê', key: 'tenant_name'),
        const CsvHeader(label: 'Số điện thoại', key: 'tenant_phone'),
        const CsvHeader(label: 'Mức cọc HĐ (VND)', key: 'deposit_amount'),
        const CsvHeader(label: 'Tiền cọc thực giữ (VND)', key: 'amount_held'),
        const CsvHeader(label: 'Trạng thái', key: 'status'),
        const CsvHeader(label: 'Mã hợp đồng', key: 'contract_id'),
      ];

      final bytes =
          buildUtf8BomCsvBytes(headers: headers, rows: _scopedDeposits);
      final filename =
          'so-coc-rp07-${DateTime.now().toIso8601String().substring(0, 10)}.csv';
      await saveOrShareBytes(bytes, fileName: filename, mimeType: 'text/csv');
      ref
          .read(toastProvider.notifier)
          .success('Đã xuất Sổ cọc (RP-07) thành công.');
    } catch (err) {
      ref.read(toastProvider.notifier).error(
            extractErrorMessage(err, 'Không thể xuất tệp Sổ cọc (RP-07).'),
          );
    }
  }

  List<Map<String, dynamic>> get _scopedDeposits {
    final selectedBuildingId =
        ref.watch(authProvider.select((s) => s.selectedBuildingId));
    if (selectedBuildingId.isEmpty) return _deposits;
    return _deposits
        .where((d) => d['building_id']?.toString() == selectedBuildingId)
        .toList();
  }

  List<Map<String, dynamic>> get _filteredDeposits {
    final q = _search.trim().toLowerCase();
    return _scopedDeposits.filterDeposits(
      activeTab: _activeTab,
      search: q,
      quickFilter: _quickFilter,
      todayIso: toDateOnlyStr(DateTime.now()),
    );
  }

  @override
  Widget build(BuildContext context) {
    final scoped = _scopedDeposits;

    final heldCount = scoped
        .where((d) => ['HELD', 'SETTLEMENT_DRAFT'].contains(d['status']))
        .length;
    final pendingCount = scoped
        .where((d) => ['PENDING_APPROVAL', 'APPROVED_PENDING_PAYOUT']
            .contains(d['status']))
        .length;
    final returnedCount = scoped.where((d) => d['status'] == 'RETURNED').length;
    final refundedCount = scoped
        .where((d) => [
              'REFUNDED',
              'PARTIALLY_REFUNDED',
              'DEDUCTED_FULL',
              'TRANSFERRED'
            ].contains(d['status']))
        .length;
    final disputedCount = scoped.where((d) => d['status'] == 'DISPUTED').length;

    final totalHeldAmount = scoped
        .where((d) => [
              'HELD',
              'SETTLEMENT_DRAFT',
              'PENDING_APPROVAL',
              'APPROVED_PENDING_PAYOUT',
              'RETURNED',
              'DISPUTED'
            ].contains(d['status']))
        .fold<int>(0, (sum, d) {
      final amt = d['amount_held'];
      final numVal =
          amt is num ? amt : num.tryParse(amt?.toString() ?? '') ?? 0;
      return sum + numVal.toInt();
    });

    final tabItems = [
      AppTabItem(id: 'held', label: 'Đang giữ ($heldCount)'),
      AppTabItem(id: 'pending', label: 'Chờ duyệt ($pendingCount)'),
      AppTabItem(id: 'returned', label: 'Ngân hàng trả lại ($returnedCount)'),
      AppTabItem(id: 'refunded', label: 'Đã hoàn cọc ($refundedCount)'),
      AppTabItem(id: 'disputed', label: 'Tranh chấp ($disputedCount)'),
    ];

    return Scaffold(
      backgroundColor: AppColors.slate50,
      body: SingleChildScrollView(
        padding: const EdgeInsets.all(24),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            // Page Header
            PageHeader(
              title: 'Sổ cọc hợp đồng',
              subtitle:
                  'Quản lý độc lập tiền đặt cọc và quy trình quyết toán hoàn cọc 4 mắt.',
              actions: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  AppButton(
                    text: 'Xuất sổ cọc (RP-07)',
                    variant: AppButtonVariant.outline,
                    icon: const Icon(LucideIcons.fileSpreadsheet, size: 16),
                    onPressed: _exportExcelLedger,
                  ),
                  const SizedBox(width: 8),
                  AppButton(
                    text: 'Làm mới',
                    variant: AppButtonVariant.secondary,
                    icon: const Icon(LucideIcons.refreshCw, size: 16),
                    onPressed: () => _fetchDeposits(force: true),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 20),

            // Stats Cards Row
            Row(
              children: [
                Expanded(
                  child: StatsCard(
                    title: 'Tổng tiền cọc đang giữ',
                    value: formatMoney(totalHeldAmount),
                    icon: LucideIcons.wallet,
                    color: 'indigo',
                  ),
                ),
                const SizedBox(width: 16),
                Expanded(
                  child: StatsCard(
                    title: 'Sổ cọc đang quản lý',
                    value: '$heldCount căn',
                    icon: LucideIcons.building2,
                    color: 'sky',
                  ),
                ),
                const SizedBox(width: 16),
                Expanded(
                  child: StatsCard(
                    title: 'Chờ duyệt 4 mắt',
                    value: '$pendingCount hồ sơ',
                    icon: LucideIcons.shieldAlert,
                    color: 'amber',
                  ),
                ),
                const SizedBox(width: 16),
                Expanded(
                  child: StatsCard(
                    title: 'Khiếu nại cọc',
                    value: '$disputedCount hồ sơ',
                    icon: LucideIcons.messageSquareWarning,
                    color: 'rose',
                  ),
                ),
              ],
            ),
            const SizedBox(height: 24),

            // Quick-filter banner (Dashboard drill-down)
            if (_quickFilter != _DepositQuickFilter.none)
              Container(
                margin: const EdgeInsets.only(bottom: 16),
                padding:
                    const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
                decoration: BoxDecoration(
                  color: AppColors.amber50,
                  border: Border.all(color: AppColors.amber300),
                  borderRadius: BorderRadius.circular(12),
                ),
                child: Row(
                  children: [
                    const Icon(LucideIcons.triangleAlert,
                        size: 16, color: AppColors.amber600),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Wrap(
                        crossAxisAlignment: WrapCrossAlignment.center,
                        spacing: 4,
                        children: [
                          const Text(
                            'Đang áp dụng bộ lọc nhanh từ Dashboard',
                            style: TextStyle(
                              color: AppColors.amber900,
                              fontSize: 13,
                              fontWeight: FontWeight.w500,
                            ),
                          ),
                          Text(
                            ': ${_quickFilterLabel} (${_filteredDeposits.length} bản ghi)',
                            style: const TextStyle(
                                color: AppColors.amber900, fontSize: 13),
                          ),
                        ],
                      ),
                    ),
                    const SizedBox(width: 12),
                    AppButton(
                      text: 'Xóa bộ lọc nhanh',
                      variant: AppButtonVariant.outline,
                      size: AppButtonSize.xs,
                      icon: const Icon(LucideIcons.xCircle, size: 14),
                      onPressed: () => context.go('/admin/deposits'),
                    ),
                  ],
                ),
              ),

            // Tabs & Search Bar
            AppCard(
              padding: const EdgeInsets.all(16),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Row(
                    children: [
                      Expanded(
                        child: AppTabs(
                          tabs: tabItems,
                          activeTab: _activeTab,
                          onChanged: (key) => setState(() => _activeTab = key),
                        ),
                      ),
                      const SizedBox(width: 16),
                      SizedBox(
                        width: 280,
                        child: SearchBarWidget(
                          placeholder: 'Tìm số phòng, tên khách, HĐ...',
                          value: _search,
                          onChanged: (val) => setState(() => _search = val),
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 16),

                  // Data Content
                  if (_loading)
                    const Center(
                      child: Padding(
                        padding: EdgeInsets.all(40),
                        child: LoadingSpinner(),
                      ),
                    )
                  else if (_filteredDeposits.isEmpty)
                    const EmptyState(
                      title: 'Không tìm thấy sổ cọc nào',
                      description:
                          'Không có dữ liệu phù hợp với bộ lọc tìm kiếm hiện tại.',
                    )
                  else
                    _buildDepositsTable(_filteredDeposits),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildDepositsTable(List<Map<String, dynamic>> items) {
    return ListView.separated(
      shrinkWrap: true,
      physics: const NeverScrollableScrollPhysics(),
      itemCount: items.length,
      separatorBuilder: (_, __) =>
          const Divider(height: 1, color: AppColors.slate200),
      itemBuilder: (context, idx) {
        final dep = items[idx];
        final status = dep['status']?.toString() ?? 'HELD';
        final canCollect = canCollectAdditionalDeposit(dep);

        return InkWell(
          onTap: () => _openDetailModal(dep),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
            child: Row(
              children: [
                // Apartment Code & Building
                Expanded(
                  flex: 3,
                  child: Row(
                    children: [
                      Container(
                        padding: const EdgeInsets.all(10),
                        decoration: BoxDecoration(
                          color: AppColors.secondary50,
                          borderRadius: BorderRadius.circular(8),
                        ),
                        child: const Icon(LucideIcons.home,
                            size: 20, color: AppColors.secondary600),
                      ),
                      const SizedBox(width: 12),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              dep['apartment_code']?.toString() ?? '---',
                              style: const TextStyle(
                                fontWeight: FontWeight.bold,
                                fontSize: 15,
                                color: AppColors.slate900,
                              ),
                            ),
                            Text(
                              dep['building_name']?.toString() ?? 'Tòa nhà',
                              style: const TextStyle(
                                  fontSize: 12, color: AppColors.slate500),
                            ),
                          ],
                        ),
                      ),
                    ],
                  ),
                ),

                // Tenant
                Expanded(
                  flex: 3,
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        dep['tenant_name']?.toString() ?? 'Khách thuê',
                        style: const TextStyle(
                            fontWeight: FontWeight.w600, fontSize: 14),
                      ),
                      Text(
                        dep['tenant_phone']?.toString() ?? '---',
                        style: const TextStyle(
                            fontSize: 12, color: AppColors.slate500),
                      ),
                    ],
                  ),
                ),

                // Contract
                Expanded(
                  flex: 2,
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        dep['contract_id']?.toString() ?? '---',
                        style: const TextStyle(
                            fontSize: 13, fontWeight: FontWeight.w500),
                      ),
                      Text(
                        dep['contract_status']?.toString() ?? 'N/A',
                        style: const TextStyle(
                            fontSize: 11, color: AppColors.slate500),
                      ),
                    ],
                  ),
                ),

                // Deposit Amount Held
                Expanded(
                  flex: 3,
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        formatMoney(dep['amount_held'] ?? 0),
                        style: const TextStyle(
                          fontWeight: FontWeight.bold,
                          fontSize: 14,
                          color: AppColors.emerald600,
                        ),
                      ),
                      Text(
                        'Quy định: ${formatMoney(dep['deposit_amount'] ?? 0)}',
                        style: const TextStyle(
                            fontSize: 11, color: AppColors.slate500),
                      ),
                    ],
                  ),
                ),

                // Status Badge
                Expanded(
                  flex: 3,
                  child: Align(
                    alignment: Alignment.centerLeft,
                    child: _buildTableStatusBadge(status),
                  ),
                ),

                // Actions
                Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    if (canCollect) ...[
                      AppButton(
                        text: 'Thu thêm',
                        variant: AppButtonVariant.outline,
                        size: AppButtonSize.xs,
                        icon: const Icon(LucideIcons.plus, size: 14),
                        onPressed: () => _openDetailModal(dep),
                      ),
                      const SizedBox(width: 8),
                    ],
                    AppButton(
                      text: 'Sổ giao dịch',
                      variant: AppButtonVariant.outline,
                      size: AppButtonSize.xs,
                      icon: const Icon(LucideIcons.history, size: 14),
                      onPressed: () =>
                          _openDetailModal(dep, initialTabIndex: 1),
                    ),
                  ],
                ),
              ],
            ),
          ),
        );
      },
    );
  }

  Widget _buildTableStatusBadge(String status) {
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
        label = 'Chờ chi hoàn (UNC)';
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
        label = 'Hoàn 1 phần';
        variant = AppBadgeVariant.emerald;
        break;
      case 'DEDUCTED_FULL':
        label = 'Khấu trừ hết';
        variant = AppBadgeVariant.slate;
        break;
      case 'DISPUTED':
        label = 'Đang khiếu nại';
        variant = AppBadgeVariant.red;
        break;
    }

    return AppBadge(label: label, variant: variant);
  }
}

extension _DepositFilterExtension on List<Map<String, dynamic>> {
  List<Map<String, dynamic>> filterDeposits({
    required String activeTab,
    required String search,
    _DepositQuickFilter quickFilter = _DepositQuickFilter.none,
    String todayIso = '',
  }) {
    const settled = [
      'REFUNDED',
      'PARTIALLY_REFUNDED',
      'DEDUCTED_FULL',
      'TRANSFERRED'
    ];
    return where((d) {
      final st = d['status']?.toString();
      switch (quickFilter) {
        case _DepositQuickFilter.overdue:
          final due = toDateOnlyStr(d['refund_due_date']);
          if (due.isEmpty ||
              due.compareTo(todayIso) >= 0 ||
              settled.contains(st)) {
            return false;
          }
          break;
        case _DepositQuickFilter.payout:
          if (!const ['APPROVED_PENDING_PAYOUT', 'RETURNED'].contains(st)) {
            return false;
          }
          break;
        case _DepositQuickFilter.disputed:
          if (st != 'DISPUTED') return false;
          break;
        case _DepositQuickFilter.none:
          if (activeTab == 'held' &&
              !const ['HELD', 'SETTLEMENT_DRAFT'].contains(st)) {
            return false;
          }
          if (activeTab == 'pending' &&
              !const ['PENDING_APPROVAL', 'APPROVED_PENDING_PAYOUT']
                  .contains(st)) {
            return false;
          }
          if (activeTab == 'returned' && st != 'RETURNED') {
            return false;
          }
          if (activeTab == 'refunded' && !settled.contains(st)) {
            return false;
          }
          if (activeTab == 'disputed' && st != 'DISPUTED') {
            return false;
          }
          break;
      }

      if (search.isNotEmpty) {
        final haystack = [
          d['apartment_code'],
          d['building_name'],
          d['tenant_name'],
          d['tenant_phone'],
          d['contract_id'],
        ].where((e) => e != null).join(' ').toLowerCase();
        if (!haystack.contains(search)) return false;
      }

      return true;
    }).toList();
  }
}
