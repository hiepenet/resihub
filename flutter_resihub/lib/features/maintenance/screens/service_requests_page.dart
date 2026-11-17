import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../../core/constants/statuses.dart';
import '../../../core/theme/app_colors.dart';
import '../../../core/utils/ai_helpers.dart';
import '../../../core/utils/format.dart';
import '../../../core/utils/validation.dart';
import '../../../core/utils/zalo_format.dart';
import '../../ai_gateway/services/ai_service.dart';
import '../../auth/providers/auth_provider.dart';
import '../../auth/providers/permission_provider.dart';
import '../../buildings/services/buildings_service.dart';
import '../../../shared/providers/toast_provider.dart';
import '../../../shared/widgets/common/data_table_widget.dart';
import '../../../shared/widgets/common/empty_state.dart';
import '../../../shared/widgets/common/loading_spinner.dart';
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
import '../../../shared/widgets/ui/auth_media_viewer.dart';
import '../../../shared/widgets/ui/file_upload_field.dart';
import '../services/service_requests_service.dart';

const List<String> kOpenSrStatuses = [
  'NEW',
  'ASSIGNED',
  'IN_PROGRESS',
  'ON_HOLD',
  'REOPENED'
];

/// Port of `AUDIT_ACTION_LABELS` trong ServiceRequestsPage.jsx.
const Map<String, String> kSrAuditActionLabels = {
  'CREATE_SERVICE_REQUEST': 'Tạo yêu cầu báo hỏng',
  'UPDATE_SERVICE_REQUEST': 'Cập nhật xử lý kỹ thuật',
  'APPLY_SERVICE_REQUEST_TRIAGE': 'Duyệt / điều phối từ gợi ý AI',
  'REOPEN_SERVICE_REQUEST': 'Cư dân yêu cầu xử lý lại',
  'CANCEL_SERVICE_REQUEST': 'Hủy yêu cầu sửa chữa',
  'RATE_SERVICE_REQUEST': 'Cư dân nghiệm thu & đánh giá sao',
  'SLA_ESCALATION_SERVICE_REQUEST': 'Hệ thống cảnh báo quá hạn SLA',
};

const List<
    ({
      String status,
      String title,
      Color borderTopColor,
      String badgeVariant
    })> kKanbanColumns = [
  (
    status: 'NEW',
    title: 'Mới tiếp nhận',
    borderTopColor: Color(0xFF0EA5E9),
    badgeVariant: 'sky'
  ),
  (
    status: 'REOPENED',
    title: 'Mở lại xử lý',
    borderTopColor: Color(0xFFF43F5E),
    badgeVariant: 'red'
  ),
  (
    status: 'ASSIGNED',
    title: 'Đã phân công',
    borderTopColor: Color(0xFF6366F1),
    badgeVariant: 'indigo'
  ),
  (
    status: 'IN_PROGRESS',
    title: 'Đang xử lý',
    borderTopColor: Color(0xFFF59E0B),
    badgeVariant: 'amber'
  ),
  (
    status: 'ON_HOLD',
    title: 'Tạm hoãn / Hẹn lại',
    borderTopColor: Color(0xFFA855F7),
    badgeVariant: 'purple'
  ),
  (
    status: 'RESOLVED',
    title: 'Đã xử lý xong',
    borderTopColor: Color(0xFF10B981),
    badgeVariant: 'emerald'
  ),
  (
    status: 'CLOSED',
    title: 'Đã đóng',
    borderTopColor: Color(0xFF94A3B8),
    badgeVariant: 'slate'
  ),
  (
    status: 'CANCELLED',
    title: 'Đã hủy',
    borderTopColor: Color(0xFFE11D48),
    badgeVariant: 'red'
  ),
];

/// Màn hình Yêu cầu Bảo trì / Báo hỏng, Cam kết SLA & AI Triage (M11).
/// Port of `frontend/src/pages/admin/maintenance/ServiceRequestsPage.jsx`.
class ServiceRequestsPage extends ConsumerStatefulWidget {
  final String? initialRequestId;

  const ServiceRequestsPage({
    super.key = const Key('route:/admin/service-requests'),
    this.initialRequestId,
  });

  @override
  ConsumerState<ServiceRequestsPage> createState() =>
      _ServiceRequestsPageState();
}

class _ServiceRequestsPageState extends ConsumerState<ServiceRequestsPage> {
  List<Map<String, dynamic>> _requests = [];
  bool _loading = true;

  String _search = '';
  String _categoryFilter = '';
  String _priorityFilter = '';
  String _statusFilter = '';
  bool _overdueOnly = false;
  String _viewMode = 'kanban'; // 'kanban' | 'table'

  Timer? _slaTickerTimer;
  bool _autoOpened = false;

  @override
  void initState() {
    super.initState();
    _loadInitialData();

    // Ticker định kỳ 30 giây để cập nhật đồng hồ đếm ngược SLA trực tiếp
    _slaTickerTimer = Timer.periodic(const Duration(seconds: 30), (_) {
      if (mounted) setState(() {});
    });

    WidgetsBinding.instance.addPostFrameCallback((_) {
      _checkAutoOpenDetail();
    });
  }

  @override
  void dispose() {
    _slaTickerTimer?.cancel();
    super.dispose();
  }

  void _loadInitialData() {
    try {
      final selectedBuildingId = ref.read(authProvider).selectedBuildingId;
      final service = ref.read(serviceRequestsServiceProvider);
      final peeked = service.peekList({
        'building_id': selectedBuildingId.isNotEmpty ? selectedBuildingId : null
      });
      if (peeked is Map && peeked['data'] is List) {
        _requests = (peeked['data'] as List)
            .whereType<Map>()
            .map((e) => Map<String, dynamic>.from(e))
            .toList();
        _loading = false;
      }
    } catch (_) {}
    _fetchRequests();
  }

  void _checkAutoOpenDetail() {
    if (_autoOpened) return;

    String? targetId = widget.initialRequestId;
    if (targetId == null || targetId.isEmpty) {
      try {
        final uri = GoRouterState.of(context).uri;
        final q = uri.queryParameters['request_id'];
        if (q != null && q.isNotEmpty) targetId = q;
      } catch (_) {}
    }

    if (targetId != null && targetId.isNotEmpty) {
      _autoOpened = true;
      _openDetailDrawer(targetId);
    }
  }

  Map<String, dynamic> _buildFilterParams() {
    final selectedBuildingId = ref.read(authProvider).selectedBuildingId;
    return {
      if (selectedBuildingId.isNotEmpty) 'building_id': selectedBuildingId,
      if (_categoryFilter.isNotEmpty) 'category': _categoryFilter,
      if (_priorityFilter.isNotEmpty) 'priority': _priorityFilter,
      if (_statusFilter.isNotEmpty) 'status': _statusFilter,
      if (_overdueOnly) 'overdue_sla': 'true',
      if (_search.trim().isNotEmpty) 'search': _search.trim(),
    };
  }

  void _resetFilters() {
    setState(() {
      _search = '';
      _categoryFilter = '';
      _priorityFilter = '';
      _statusFilter = '';
      _overdueOnly = false;
    });
    _fetchRequests();
  }

  Future<void> _fetchRequests({bool force = false}) async {
    try {
      final service = ref.read(serviceRequestsServiceProvider);
      final params = _buildFilterParams();
      final res = await service.list(params, {'force': force});
      if (!mounted) return;

      if (res is Map && res['data'] is List) {
        setState(() {
          _requests = (res['data'] as List)
              .whereType<Map>()
              .map((e) => Map<String, dynamic>.from(e))
              .toList();
          _loading = false;
        });
      } else if (res is List) {
        setState(() {
          _requests = res
              .whereType<Map>()
              .map((e) => Map<String, dynamic>.from(e))
              .toList();
          _loading = false;
        });
      } else {
        setState(() {
          _requests = [];
          _loading = false;
        });
      }
    } catch (err) {
      if (mounted) {
        setState(() => _loading = false);
        ref.read(toastProvider.notifier).error(
              extractErrorMessage(
                  err, 'Không thể tải danh sách yêu cầu bảo trì.'),
            );
      }
    }
  }

  // Thống kê KPIs
  ({
    int total,
    int newCount,
    int processingCount,
    int doneCount,
    int overdueCount,
    int urgentCount
  }) _calculateStats() {
    final total = _requests.length;
    var newCount = 0;
    var processingCount = 0;
    var doneCount = 0;
    var overdueCount = 0;
    var urgentCount = 0;

    for (final r in _requests) {
      final status = (r['status']?.toString() ?? 'NEW').toUpperCase();
      final priority = (r['priority']?.toString() ?? 'NORMAL').toUpperCase();

      if (status == 'NEW' || status == 'REOPENED') newCount++;
      if (status == 'ASSIGNED' ||
          status == 'IN_PROGRESS' ||
          status == 'ON_HOLD') {
        processingCount++;
      }
      if (status == 'RESOLVED' || status == 'CLOSED') doneCount++;

      final isOverdue = r['is_sla_overdue'] == true ||
          computeSlaBadgeMeta(
                status: status,
                slaDueAt: r['sla_due_at'],
                slaBreachedAt: r['sla_breached_at'],
              ).state ==
              'OVERDUE';
      if (isOverdue) overdueCount++;

      if (priority == 'URGENT' && kOpenSrStatuses.contains(status)) {
        urgentCount++;
      }
    }

    return (
      total: total,
      newCount: newCount,
      processingCount: processingCount,
      doneCount: doneCount,
      overdueCount: overdueCount,
      urgentCount: urgentCount,
    );
  }

  Future<void> _openDetailDrawer(String requestId) async {
    await AppModal.show<void>(
      context: context,
      variant: AppModalVariant.drawer,
      size: AppModalSize.xl,
      title: 'Chi tiết Yêu cầu Bảo trì',
      child: _ServiceRequestDetailDrawer(
        requestId: requestId,
        onUpdated: () => _fetchRequests(force: true),
      ),
    );
  }

  Future<void> _openCreateModal() async {
    final permissions = ref.read(permissionProvider);
    if (!permissions.canHandleMaintenance) return;

    await AppModal.show<void>(
      context: context,
      size: AppModalSize.lg,
      title: 'Tạo yêu cầu bảo trì hộ cư dân',
      child: _ServiceRequestCreateModal(
        onCreated: () => _fetchRequests(force: true),
        onOpenExisting: (id) {
          Navigator.of(context).pop();
          _openDetailDrawer(id);
        },
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final permissions = ref.read(permissionProvider);
    final stats = _calculateStats();

    return Scaffold(
      backgroundColor: AppColors.slate50,
      body: SingleChildScrollView(
        padding: const EdgeInsets.all(24),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            PageHeader(
              title: 'Yêu cầu & Báo hỏng Kỹ thuật',
              subtitle:
                  'Tiếp nhận, điều phối nhân sự bảo trì, kiểm soát cam kết SLA và đồng bộ tin nhắn nhóm Zalo phòng.',
              actions: Wrap(
                crossAxisAlignment: WrapCrossAlignment.center,
                spacing: 10,
                children: [
                  // Nút chuyển chế độ xem có nhãn (Kanban / Table)
                  Container(
                    decoration: BoxDecoration(
                      color: Colors.white,
                      borderRadius: BorderRadius.circular(10),
                      border: Border.all(color: AppColors.slate200),
                    ),
                    child: Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Tooltip(
                          message: 'Xem dạng thẻ (Kanban)',
                          child: TextButton.icon(
                            onPressed: () =>
                                setState(() => _viewMode = 'kanban'),
                            icon: Icon(
                              LucideIcons.layoutGrid,
                              size: 16,
                              color: _viewMode == 'kanban'
                                  ? AppColors.primary600
                                  : AppColors.slate500,
                            ),
                            label: Text(
                              'Bảng Kanban',
                              style: TextStyle(
                                fontSize: 12,
                                fontWeight: FontWeight.w600,
                                color: _viewMode == 'kanban'
                                    ? AppColors.primary600
                                    : AppColors.slate600,
                              ),
                            ),
                            style: TextButton.styleFrom(
                                padding: const EdgeInsets.symmetric(
                                    horizontal: 12, vertical: 8)),
                          ),
                        ),
                        Container(
                            width: 1, height: 20, color: AppColors.slate200),
                        Tooltip(
                          message: 'Xem dạng bảng',
                          child: TextButton.icon(
                            onPressed: () =>
                                setState(() => _viewMode = 'table'),
                            icon: Icon(
                              LucideIcons.list,
                              size: 16,
                              color: _viewMode == 'table'
                                  ? AppColors.primary600
                                  : AppColors.slate500,
                            ),
                            label: Text(
                              'Chế độ Bảng',
                              style: TextStyle(
                                fontSize: 12,
                                fontWeight: FontWeight.w600,
                                color: _viewMode == 'table'
                                    ? AppColors.primary600
                                    : AppColors.slate600,
                              ),
                            ),
                            style: TextButton.styleFrom(
                                padding: const EdgeInsets.symmetric(
                                    horizontal: 12, vertical: 8)),
                          ),
                        ),
                      ],
                    ),
                  ),
                  AppButton(
                    text: 'Làm mới',
                    icon: const Icon(LucideIcons.refreshCw, size: 16),
                    variant: AppButtonVariant.outline,
                    onPressed: () => _fetchRequests(force: true),
                  ),
                  if (permissions.canHandleMaintenance) ...[
                    AppButton(
                      text: 'Tạo yêu cầu hộ cư dân',
                      icon: const Icon(LucideIcons.plus, size: 18),
                      onPressed: _openCreateModal,
                    ),
                  ],
                ],
              ),
            ),
            const SizedBox(height: 20),

            // Hàng Thẻ Thống Kê KPIs (port of React KPIs)
            LayoutBuilder(
              builder: (context, constraints) {
                final isWide = constraints.maxWidth >= 900;
                final kpis = <StatsCard>[
                  StatsCard(
                    title: 'Tổng yêu cầu',
                    value: stats.total,
                    subtext: stats.urgentCount > 0
                        ? '${stats.urgentCount} sự cố KHẨN CẤP đang mở'
                        : 'Tất cả sự cố ghi nhận',
                    icon: LucideIcons.wrench,
                    color: 'sky',
                  ),
                  StatsCard(
                    title: 'Mới / Mở lại',
                    value: stats.newCount,
                    subtext: stats.overdueCount > 0
                        ? '${stats.overdueCount} phiếu đang quá hạn SLA!'
                        : 'Chờ tiếp nhận & phân công',
                    icon: LucideIcons.alertTriangle,
                    color: stats.overdueCount > 0 ? 'rose' : 'amber',
                  ),
                  StatsCard(
                    title: 'Đang xử lý / Hẹn lại',
                    value: stats.processingCount,
                    subtext: 'Đã phân công / Đang sửa / Tạm hoãn',
                    icon: LucideIcons.clock,
                    color: 'indigo',
                  ),
                  StatsCard(
                    title: 'Đã hoàn thành',
                    value: stats.doneCount,
                    subtext: 'Đã xử lý xong & nghiệm thu',
                    icon: LucideIcons.checkCircle2,
                    color: 'emerald',
                  ),
                ];
                return isWide
                    ? Row(
                        children: [
                          for (var i = 0; i < kpis.length; i++) ...[
                            if (i > 0) const SizedBox(width: 16),
                            Expanded(child: kpis[i]),
                          ],
                        ],
                      )
                    : Column(
                        children: [
                          for (var i = 0; i < kpis.length; i++) ...[
                            if (i > 0) const SizedBox(height: 12),
                            kpis[i],
                          ],
                        ],
                      );
              },
            ),
            const SizedBox(height: 20),

            // Thanh Bộ Lọc & Tìm Kiếm
            AppCard(
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
              child: Wrap(
                spacing: 12,
                runSpacing: 12,
                crossAxisAlignment: WrapCrossAlignment.center,
                children: [
                  SizedBox(
                    width: 240,
                    child: SearchBarWidget(
                      placeholder:
                          'Tìm theo mã tra cứu (SR-...), căn hộ, tiêu đề, cư dân...',
                      value: _search,
                      // Port of React debounce: 200ms trước khi gọi API.
                      debounceDuration: const Duration(milliseconds: 200),
                      onChanged: (val) {
                        setState(() => _search = val);
                        _fetchRequests();
                      },
                    ),
                  ),
                  SizedBox(
                    width: 170,
                    child: AppSelect<String>(
                      placeholder: 'Tất cả trạng thái',
                      value: _statusFilter.isEmpty ? null : _statusFilter,
                      options: [
                        const AppSelectOption(
                            value: '', label: 'Tất cả trạng thái'),
                        ...kKanbanColumns.map(
                          (c) =>
                              AppSelectOption(value: c.status, label: c.title),
                        ),
                      ],
                      onChanged: (val) {
                        setState(() => _statusFilter = val ?? '');
                        _fetchRequests();
                      },
                    ),
                  ),
                  SizedBox(
                    width: 180,
                    child: AppSelect<String>(
                      placeholder: 'Tất cả hạng mục',
                      value: _categoryFilter.isEmpty ? null : _categoryFilter,
                      options: [
                        const AppSelectOption(
                            value: '', label: 'Tất cả hạng mục'),
                        ...kServiceRequestCategories.entries.map(
                          (e) => AppSelectOption(value: e.key, label: e.value),
                        ),
                      ],
                      onChanged: (val) {
                        setState(() => _categoryFilter = val ?? '');
                        _fetchRequests();
                      },
                    ),
                  ),
                  SizedBox(
                    width: 150,
                    child: AppSelect<String>(
                      placeholder: 'Tất cả mức ưu tiên',
                      value: _priorityFilter.isEmpty ? null : _priorityFilter,
                      options: const [
                        AppSelectOption(value: '', label: 'Tất cả mức ưu tiên'),
                        AppSelectOption(value: 'LOW', label: 'Thấp'),
                        AppSelectOption(value: 'NORMAL', label: 'Bình thường'),
                        AppSelectOption(value: 'HIGH', label: 'Cao'),
                        AppSelectOption(value: 'URGENT', label: 'Khẩn cấp'),
                      ],
                      onChanged: (val) {
                        setState(() => _priorityFilter = val ?? '');
                        _fetchRequests();
                      },
                    ),
                  ),
                  InkWell(
                    onTap: () {
                      setState(() => _overdueOnly = !_overdueOnly);
                      _fetchRequests();
                    },
                    borderRadius: BorderRadius.circular(8),
                    child: Container(
                      padding: const EdgeInsets.symmetric(
                          horizontal: 10, vertical: 8),
                      decoration: BoxDecoration(
                        color: _overdueOnly
                            ? const Color(0xFFFFF1F2)
                            : Colors.transparent,
                        borderRadius: BorderRadius.circular(8),
                        border: Border.all(
                          color: _overdueOnly
                              ? const Color(0xFFFDA4AF)
                              : AppColors.slate200,
                        ),
                      ),
                      child: Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Icon(
                            _overdueOnly
                                ? LucideIcons.checkSquare
                                : LucideIcons.square,
                            size: 16,
                            color: _overdueOnly
                                ? AppColors.rose600
                                : AppColors.slate500,
                          ),
                          const SizedBox(width: 6),
                          Text(
                            'Chỉ hiển thị phiếu đang Quá hạn SLA',
                            style: TextStyle(
                              fontSize: 13,
                              fontWeight: _overdueOnly
                                  ? FontWeight.w600
                                  : FontWeight.w400,
                              color: _overdueOnly
                                  ? AppColors.rose700
                                  : AppColors.slate700,
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
                  if (_categoryFilter.isNotEmpty ||
                      _priorityFilter.isNotEmpty ||
                      _statusFilter.isNotEmpty ||
                      _overdueOnly ||
                      _search.isNotEmpty)
                    InkWell(
                      onTap: _resetFilters,
                      borderRadius: BorderRadius.circular(6),
                      child: const Padding(
                        padding:
                            EdgeInsets.symmetric(horizontal: 6, vertical: 8),
                        child: Text(
                          'Xóa bộ lọc',
                          style: TextStyle(
                            fontSize: 13,
                            fontWeight: FontWeight.w600,
                            color: AppColors.primary600,
                          ),
                        ),
                      ),
                    ),
                ],
              ),
            ),
            const SizedBox(height: 20),

            // Nội dung chính (Kanban Board hoặc Table)
            if (_loading)
              const Center(
                child: Padding(
                  padding: EdgeInsets.all(48.0),
                  child: LoadingSpinner(),
                ),
              )
            else if (_requests.isEmpty)
              const EmptyState(
                title: 'Không có yêu cầu bảo trì nào',
                description:
                    'Chưa có yêu cầu sự cố nào phù hợp với bộ lọc hiện tại.',
                icon: LucideIcons.clipboardCheck,
              )
            else if (_viewMode == 'kanban')
              _buildKanbanView()
            else
              _buildTableView(),
          ],
        ),
      ),
    );
  }

  // ---------------------------------------------------------------------------
  // Kanban View
  // ---------------------------------------------------------------------------
  Widget _buildKanbanView() {
    final grouped = <String, List<Map<String, dynamic>>>{};
    for (final col in kKanbanColumns) {
      grouped[col.status] = [];
    }
    for (final r in _requests) {
      final st = (r['status']?.toString() ?? 'NEW').toUpperCase();
      if (grouped.containsKey(st)) {
        grouped[st]!.add(r);
      }
    }

    return SizedBox(
      height: 640,
      child: ListView.separated(
        scrollDirection: Axis.horizontal,
        itemCount: kKanbanColumns.length,
        separatorBuilder: (_, __) => const SizedBox(width: 14),
        itemBuilder: (context, idx) {
          final col = kKanbanColumns[idx];
          final items = grouped[col.status] ?? [];

          return Container(
            width: 290,
            decoration: BoxDecoration(
              color: const Color(0xFFF8FAFC),
              borderRadius: BorderRadius.circular(12),
              border: Border.all(color: AppColors.slate200),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                // Top Color Accent Bar & Column Header
                Container(
                  height: 4,
                  decoration: BoxDecoration(
                    color: col.borderTopColor,
                    borderRadius:
                        const BorderRadius.vertical(top: Radius.circular(12)),
                  ),
                ),
                Padding(
                  padding:
                      const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
                  child: Row(
                    mainAxisAlignment: MainAxisAlignment.spaceBetween,
                    children: [
                      Expanded(
                        child: Text(
                          col.title,
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(
                            fontSize: 14,
                            fontWeight: FontWeight.w700,
                            color: AppColors.slate800,
                          ),
                        ),
                      ),
                      const SizedBox(width: 6),
                      AppBadge(
                        label: items.length.toString(),
                        variant: AppBadgeVariant.fromString(col.badgeVariant),
                      ),
                    ],
                  ),
                ),
                const Divider(
                    height: 1, thickness: 1, color: AppColors.slate200),

                // Card List
                Expanded(
                  child: items.isEmpty
                      ? const Center(
                          child: Text(
                            'Trống',
                            style: TextStyle(
                                fontSize: 12, color: AppColors.slate400),
                          ),
                        )
                      : ListView.separated(
                          padding: const EdgeInsets.all(10),
                          itemCount: items.length,
                          separatorBuilder: (_, __) =>
                              const SizedBox(height: 10),
                          itemBuilder: (context, cardIdx) {
                            return _buildKanbanCard(items[cardIdx]);
                          },
                        ),
                ),
              ],
            ),
          );
        },
      ),
    );
  }

  Widget _buildKanbanCard(Map<String, dynamic> r) {
    final status = (r['status']?.toString() ?? 'NEW').toUpperCase();
    final priority = (r['priority']?.toString() ?? 'NORMAL').toUpperCase();
    final slaMeta = computeSlaBadgeMeta(
      status: status,
      slaDueAt: r['sla_due_at'],
      slaBreachedAt: r['sla_breached_at'],
    );
    final categoryLabel =
        kServiceRequestCategories[r['category']] ?? r['category'] ?? 'Khác';

    return InkWell(
      onTap: () => _openDetailDrawer(r['id']?.toString() ?? ''),
      borderRadius: BorderRadius.circular(10),
      child: Container(
        padding: const EdgeInsets.all(12),
        decoration: BoxDecoration(
          color: Colors.white,
          borderRadius: BorderRadius.circular(10),
          border: Border.all(color: AppColors.slate200),
          boxShadow: [
            BoxShadow(
              color: Colors.black.withValues(alpha: 0.03),
              blurRadius: 4,
              offset: const Offset(0, 2),
            ),
          ],
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            // Row mã yêu cầu & phòng & mức độ
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                Expanded(
                  child: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Flexible(
                        child: Text(
                          '#${r['tracking_code'] ?? r['id'] ?? ''}',
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(
                            fontSize: 12,
                            fontWeight: FontWeight.w700,
                            color: AppColors.slate800,
                          ),
                        ),
                      ),
                      if (r['apartment_code'] != null) ...[
                        const SizedBox(width: 6),
                        Container(
                          padding: const EdgeInsets.symmetric(
                              horizontal: 6, vertical: 2),
                          decoration: BoxDecoration(
                            color: AppColors.primary50,
                            borderRadius: BorderRadius.circular(4),
                            border: Border.all(color: AppColors.primary200),
                          ),
                          child: Text(
                            'P${r['apartment_code']}',
                            style: const TextStyle(
                              fontSize: 11,
                              fontWeight: FontWeight.w600,
                              color: AppColors.primary700,
                            ),
                          ),
                        ),
                      ],
                    ],
                  ),
                ),
                const SizedBox(width: 6),
                StatusBadge(
                  status: priority,
                  domain: StatusDomain.priority,
                ),
              ],
            ),
            const SizedBox(height: 8),

            // Tiêu đề
            Text(
              r['title']?.toString() ?? '(Không tiêu đề)',
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(
                fontSize: 13,
                fontWeight: FontWeight.w600,
                color: AppColors.slate800,
              ),
            ),
            const SizedBox(height: 4),

            // Hạng mục
            Text(
              categoryLabel,
              style: const TextStyle(
                fontSize: 11,
                color: AppColors.slate500,
              ),
            ),
            const SizedBox(height: 8),

            // SLA Badge & Kỹ thuật viên
            Wrap(
              alignment: WrapAlignment.spaceBetween,
              crossAxisAlignment: WrapCrossAlignment.center,
              spacing: 6,
              runSpacing: 4,
              children: [
                AppBadge(
                  label: slaMeta.label,
                  variant: AppBadgeVariant.fromString(slaMeta.variant),
                  dot: true,
                ),
                if (r['assigned_to_name'] != null &&
                    r['assigned_to_name'].toString().isNotEmpty)
                  Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      const Icon(LucideIcons.userCheck,
                          size: 12, color: AppColors.secondary600),
                      const SizedBox(width: 4),
                      Text(
                        r['assigned_to_name'].toString(),
                        style: const TextStyle(
                            fontSize: 11,
                            color: AppColors.secondary700,
                            fontWeight: FontWeight.w500),
                      ),
                    ],
                  ),
              ],
            ),
          ],
        ),
      ),
    );
  }

  // ---------------------------------------------------------------------------
  // Table View
  // ---------------------------------------------------------------------------
  Widget _buildTableView() {
    return DataTableWidget<Map<String, dynamic>>(
      loading: _loading,
      data: _requests,
      columns: [
        DataTableColumn<Map<String, dynamic>>(
          key: 'tracking_code',
          label: 'Mã yêu cầu',
          width: 130,
          cellText: (r) => r['tracking_code']?.toString() ?? '—',
          render: (r) => Text(
            '#${r['tracking_code'] ?? '—'}',
            style: const TextStyle(
                fontWeight: FontWeight.w700, color: AppColors.slate800),
          ),
        ),
        DataTableColumn<Map<String, dynamic>>(
          key: 'apartment_code',
          label: 'Căn hộ',
          width: 100,
          cellText: (r) => r['apartment_code']?.toString() ?? '—',
          render: (r) => Text('P${r['apartment_code'] ?? '—'}'),
        ),
        DataTableColumn<Map<String, dynamic>>(
          key: 'title',
          label: 'Tiêu đề sự cố',
          width: 200,
          cellText: (r) => r['title']?.toString() ?? '—',
        ),
        DataTableColumn<Map<String, dynamic>>(
          key: 'category',
          label: 'Hạng mục',
          width: 160,
          cellText: (r) =>
              kServiceRequestCategories[r['category']] ?? r['category'] ?? '—',
        ),
        DataTableColumn<Map<String, dynamic>>(
          key: 'priority',
          label: 'Mức độ',
          width: 120,
          render: (r) => StatusBadge(
            status: r['priority']?.toString(),
            domain: StatusDomain.priority,
          ),
        ),
        DataTableColumn<Map<String, dynamic>>(
          key: 'status',
          label: 'Trạng thái',
          width: 150,
          render: (r) => StatusBadge(
            status: r['status']?.toString(),
            domain: StatusDomain.serviceRequest,
          ),
        ),
        DataTableColumn<Map<String, dynamic>>(
          key: 'sla',
          label: 'SLA',
          width: 180,
          render: (r) {
            final meta = computeSlaBadgeMeta(
              status: r['status']?.toString() ?? 'NEW',
              slaDueAt: r['sla_due_at'],
              slaBreachedAt: r['sla_breached_at'],
            );
            return AppBadge(
              label: meta.label,
              variant: AppBadgeVariant.fromString(meta.variant),
              dot: true,
            );
          },
        ),
        DataTableColumn<Map<String, dynamic>>(
          key: 'assigned_to_name',
          label: 'Phụ trách',
          width: 150,
          cellText: (r) =>
              r['assigned_to_name']?.toString() ?? 'Chưa phân công',
          render: (r) {
            final name = r['assigned_to_name']?.toString() ?? '';
            if (name.isEmpty) {
              return const Text(
                'Chưa phân công',
                style: TextStyle(
                    fontSize: 12,
                    color: AppColors.slate400,
                    fontStyle: FontStyle.italic),
              );
            }
            return Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                const Icon(LucideIcons.userCheck,
                    size: 14, color: AppColors.secondary600),
                const SizedBox(width: 4),
                Flexible(
                  child: Text(name,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(
                          fontSize: 12, color: AppColors.slate700)),
                ),
              ],
            );
          },
        ),
        DataTableColumn<Map<String, dynamic>>(
          key: 'rating',
          label: 'Đánh giá',
          width: 120,
          cellText: (r) => r['rating']?.toString() ?? '—',
          render: (r) {
            final rating = num.tryParse(r['rating']?.toString() ?? '') ?? 0;
            if (rating <= 0) {
              return const Text('—',
                  style: TextStyle(color: AppColors.slate400));
            }
            return Row(
              mainAxisSize: MainAxisSize.min,
              children: List.generate(
                5,
                (i) => Icon(
                  LucideIcons.star,
                  size: 14,
                  color: i < rating ? AppColors.amber500 : AppColors.slate300,
                ),
              ),
            );
          },
        ),
        DataTableColumn<Map<String, dynamic>>(
          key: 'actions',
          label: 'Thao tác',
          width: 180,
          render: (r) => AppButton(
            text: 'Chi tiết',
            size: AppButtonSize.xs,
            variant: AppButtonVariant.outline,
            onPressed: () => _openDetailDrawer(r['id']?.toString() ?? ''),
          ),
        ),
      ],
      onRowClick: (r) => _openDetailDrawer(r['id']?.toString() ?? ''),
    );
  }
}

// =============================================================================
// Detail Drawer Modal Component
// =============================================================================
class _ServiceRequestDetailDrawer extends ConsumerStatefulWidget {
  final String requestId;
  final VoidCallback? onUpdated;

  const _ServiceRequestDetailDrawer({
    required this.requestId,
    this.onUpdated,
  });

  @override
  ConsumerState<_ServiceRequestDetailDrawer> createState() =>
      _ServiceRequestDetailDrawerState();
}

class _ServiceRequestDetailDrawerState
    extends ConsumerState<_ServiceRequestDetailDrawer> {
  Map<String, dynamic>? _detail;
  bool _loading = true;
  bool _updating = false;
  bool _applyingTriage = false;
  bool _rerunningAi = false;
  AiErrorMessage? _aiTriageError;

  // Form edit state
  String _status = 'NEW';
  String _priority = 'NORMAL';
  String _assignedTo = '';
  String _triageOverrideCategory = 'OTHER';
  final _holdReasonController = TextEditingController();
  final _nextAppointmentController = TextEditingController();
  final _resolutionNoteController = TextEditingController();
  final _internalNoteController = TextEditingController();
  List<String> _resolutionImages = [];

  @override
  void initState() {
    super.initState();
    _fetchDetail();
  }

  @override
  void dispose() {
    _holdReasonController.dispose();
    _nextAppointmentController.dispose();
    _resolutionNoteController.dispose();
    _internalNoteController.dispose();
    super.dispose();
  }

  void _syncStateFromDetail(Map<String, dynamic> d) {
    _detail = d;
    _status = d['status']?.toString() ?? 'NEW';
    _priority = d['priority']?.toString() ?? 'NORMAL';
    _assignedTo = d['assigned_to']?.toString() ?? '';
    _triageOverrideCategory = d['ai_suggested_category']?.toString() ??
        d['category']?.toString() ??
        'OTHER';
    _holdReasonController.text = d['hold_reason']?.toString() ?? '';
    _nextAppointmentController.text =
        d['next_appointment_at']?.toString() ?? '';
    _resolutionNoteController.text = d['resolution_note']?.toString() ?? '';
    _internalNoteController.text = d['internal_note']?.toString() ?? '';

    if (d['resolution_images'] is List) {
      _resolutionImages =
          (d['resolution_images'] as List).map((e) => e.toString()).toList();
    } else {
      _resolutionImages = [];
    }
  }

  Future<void> _fetchDetail({bool force = false}) async {
    try {
      final service = ref.read(serviceRequestsServiceProvider);
      final peeked = !force ? service.peekById(widget.requestId) : null;
      if (peeked is Map && peeked['data'] is Map) {
        _syncStateFromDetail(Map<String, dynamic>.from(peeked['data'] as Map));
        _loading = false;
      } else {
        _loading = true;
      }

      final res = await service.getById(widget.requestId, {'force': force});
      if (!mounted) return;

      if (res is Map && res['data'] is Map) {
        setState(() {
          _syncStateFromDetail(Map<String, dynamic>.from(res['data'] as Map));
          _loading = false;
        });
      } else {
        setState(() => _loading = false);
      }
    } catch (err) {
      if (mounted) {
        setState(() => _loading = false);
        ref.read(toastProvider.notifier).error(
              extractErrorMessage(
                  err, 'Không thể tải chi tiết yêu cầu bảo trì.'),
            );
      }
    }
  }

  Future<void> _handleApplyAiSuggestionExact() async {
    final permissions = ref.read(permissionProvider);
    if (!permissions.canHandleMaintenance || _detail == null) return;

    setState(() {
      _applyingTriage = true;
      _aiTriageError = null;
    });

    try {
      final service = ref.read(serviceRequestsServiceProvider);
      final res = await service.applyTriage(widget.requestId, {});
      if (!mounted) return;

      ref.read(toastProvider.notifier).success(
            res is Map && res['message'] != null
                ? res['message'].toString()
                : 'Đã áp dụng đề xuất phân loại & điều phối của AI.',
          );
      await _fetchDetail(force: true);
      widget.onUpdated?.call();
    } catch (err) {
      if (mounted) {
        ref.read(toastProvider.notifier).error(
              extractErrorMessage(err, 'Không thể áp dụng đề xuất AI.'),
            );
      }
    } finally {
      if (mounted) setState(() => _applyingTriage = false);
    }
  }

  Future<void> _handleApplyAiWithOverride() async {
    final permissions = ref.read(permissionProvider);
    if (!permissions.canHandleMaintenance || _detail == null) return;

    setState(() {
      _applyingTriage = true;
      _aiTriageError = null;
    });

    try {
      final payload = {
        'category': _triageOverrideCategory,
        'priority': _priority,
        'assigned_to': _assignedTo.isNotEmpty
            ? _assignedTo
            : _detail?['ai_suggested_assignee_id'],
      };
      final service = ref.read(serviceRequestsServiceProvider);
      final res = await service.applyTriage(widget.requestId, payload);
      if (!mounted) return;

      ref.read(toastProvider.notifier).success(
            res is Map && res['message'] != null
                ? res['message'].toString()
                : 'Đã áp dụng điều phối kèm chỉnh sửa của quản lý.',
          );
      await _fetchDetail(force: true);
      widget.onUpdated?.call();
    } catch (err) {
      if (mounted) {
        ref.read(toastProvider.notifier).error(
              extractErrorMessage(
                  err, 'Không thể áp dụng điều chỉnh phân loại.'),
            );
      }
    } finally {
      if (mounted) setState(() => _applyingTriage = false);
    }
  }

  Future<void> _handleRerunAiClassify() async {
    final permissions = ref.read(permissionProvider);
    if (!permissions.canHandleMaintenance || _detail == null) return;

    setState(() {
      _rerunningAi = true;
      _aiTriageError = null;
    });

    try {
      final aiService = ref.read(aiServiceProvider);
      await aiService
          .classifyServiceRequest({'service_request_id': widget.requestId});
      if (!mounted) return;

      ref
          .read(toastProvider.notifier)
          .success('AI đã cập nhật gợi ý phân loại & điều phối mới.');
      await _fetchDetail(force: true);
      widget.onUpdated?.call();
    } catch (err) {
      if (mounted) {
        setState(() {
          _aiTriageError = mapAiErrorToVietnamese(err);
        });
      }
    } finally {
      if (mounted) setState(() => _rerunningAi = false);
    }
  }

  Future<void> _handleSaveStatusUpdate([String? overrideStatus]) async {
    final nextStatus = overrideStatus ?? _status;

    if (nextStatus == 'ON_HOLD' &&
        _holdReasonController.text.trim().length < 3) {
      setState(() => _status = 'ON_HOLD');
      ref.read(toastProvider.notifier).warning(
          'Vui lòng nhập lý do tạm hoãn / hẹn lại (tối thiểu 3 ký tự) trước khi lưu.');
      return;
    }

    setState(() => _updating = true);

    try {
      final payload = {
        'status': nextStatus,
        'assigned_to': _assignedTo.isNotEmpty ? _assignedTo : null,
        'priority': _priority,
        'resolution_note': _resolutionNoteController.text.trim(),
        'resolution_images': _resolutionImages,
        'hold_reason': _holdReasonController.text.trim(),
        'next_appointment_at': _nextAppointmentController.text.trim().isNotEmpty
            ? _nextAppointmentController.text.trim()
            : null,
        'internal_note': _internalNoteController.text.trim(),
      };

      final service = ref.read(serviceRequestsServiceProvider);
      final res = await service.updateStatus(widget.requestId, payload);
      if (!mounted) return;

      ref.read(toastProvider.notifier).success(
            res is Map && res['message'] != null
                ? res['message'].toString()
                : 'Cập nhật yêu cầu thành công.',
          );
      await _fetchDetail(force: true);
      widget.onUpdated?.call();
    } catch (err) {
      if (mounted) {
        ref.read(toastProvider.notifier).error(
              extractErrorMessage(err, 'Không thể cập nhật yêu cầu bảo trì.'),
            );
      }
    } finally {
      if (mounted) setState(() => _updating = false);
    }
  }

  Future<void> _handleCopyZaloRoomMessage() async {
    if (_detail == null) return;
    final text = buildRoomMaintenanceZaloText(_detail);
    if (text.isEmpty) return;

    await copyZaloRichText(text);
    if (!mounted) return;

    ref
        .read(toastProvider.notifier)
        .success('Đã sao chép nội dung gửi nhóm Zalo phòng!');
  }

  /// Lightbox xem ảnh phóng to (React: Modal "Xem ảnh đính kèm").
  void _openImagePreview(String src) {
    AuthMediaViewer.show(context, src: src, title: 'Xem ảnh đính kèm');
  }

  Future<void> _openZaloGroupLink(String rawUrl) async {
    final uri = Uri.tryParse(rawUrl);
    if (uri == null) return;
    try {
      await launchUrl(uri, mode: LaunchMode.externalApplication);
    } catch (_) {}
  }

  @override
  Widget build(BuildContext context) {
    if (_loading && _detail == null) {
      return const SizedBox(
        height: 400,
        child: Center(child: LoadingSpinner()),
      );
    }

    if (_detail == null) {
      return const SizedBox(
        height: 200,
        child: Center(child: Text('Không tìm thấy thông tin yêu cầu.')),
      );
    }

    final d = _detail!;
    final permissions = ref.read(permissionProvider);
    final canEdit = permissions.canHandleMaintenance;

    final status = (d['status']?.toString() ?? 'NEW').toUpperCase();
    final slaMeta = computeSlaBadgeMeta(
      status: status,
      slaDueAt: d['sla_due_at'],
      slaBreachedAt: d['sla_breached_at'],
    );
    final aiTriageMeta =
        getAiTriageBadgeMeta(d['ai_triage_status']?.toString());
    final availableAssignees =
        (d['available_assignees'] as List?)?.whereType<Map>().toList() ?? [];
    final zaloGroup = d['apartment_zalo_group'] is Map
        ? Map<String, dynamic>.from(d['apartment_zalo_group'] as Map)
        : <String, dynamic>{};
    final zaloInviteLink = zaloGroup['invite_link']?.toString() ?? '';
    final zaloGroupName = zaloGroup['name']?.toString() ?? '';
    final zaloPreview = buildRoomMaintenanceZaloText(d);

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        // Banner Read-Only cho OWNER hoặc SYS_ADMIN
        if (!canEdit)
          Container(
            margin: const EdgeInsets.only(bottom: 16),
            padding: const EdgeInsets.all(12),
            decoration: BoxDecoration(
              color: const Color(0xFFF1F5F9),
              borderRadius: BorderRadius.circular(8),
              border: Border.all(color: AppColors.slate300),
            ),
            child: const Row(
              children: [
                Icon(LucideIcons.lock, size: 16, color: AppColors.slate600),
                SizedBox(width: 8),
                Expanded(
                  child: Text(
                    'Chế độ xem (Chỉ Quản lý vận hành mới có quyền tiếp nhận và cập nhật xử lý bảo trì).',
                    style: TextStyle(
                        fontSize: 12,
                        color: AppColors.slate700,
                        fontWeight: FontWeight.w500),
                  ),
                ),
              ],
            ),
          ),

        // Header: Mã yêu cầu, Phòng, Resident & Badges
        Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: [
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    '#${d['tracking_code'] ?? d['id'] ?? ''}',
                    style: const TextStyle(
                        fontSize: 18,
                        fontWeight: FontWeight.w800,
                        color: AppColors.slate900),
                  ),
                  const SizedBox(height: 4),
                  Text(
                    'Phòng ${d['apartment_code'] ?? '—'} • Tòa ${d['building_code'] ?? d['building_name'] ?? 'RESIHUB'}',
                    style: const TextStyle(
                        fontSize: 13,
                        color: AppColors.slate600,
                        fontWeight: FontWeight.w600),
                  ),
                  if (d['resident_name'] != null) ...[
                    const SizedBox(height: 2),
                    Text(
                      'Cư dân: ${d['resident_name']} • SĐT: ${d['resident_phone'] ?? '—'}',
                      style: const TextStyle(
                          fontSize: 12, color: AppColors.slate500),
                    ),
                  ],
                ],
              ),
            ),
            Column(
              crossAxisAlignment: CrossAxisAlignment.end,
              children: [
                StatusBadge(
                    status: status, domain: StatusDomain.serviceRequest),
                const SizedBox(height: 6),
                AppBadge(
                  label: slaMeta.label,
                  variant: AppBadgeVariant.fromString(slaMeta.variant),
                  dot: true,
                ),
              ],
            ),
          ],
        ),
        const SizedBox(height: 16),
        const Divider(height: 1, color: AppColors.slate200),
        const SizedBox(height: 16),

        // Card AI Triage (React đặt trước hộp Zalo)
        _buildAiTriageCard(d, canEdit, aiTriageMeta, availableAssignees),
        const SizedBox(height: 16),

        // Hộp tiện ích Đồng bộ Nhóm Zalo Phòng (FR-069)
        Container(
          padding: const EdgeInsets.all(12),
          decoration: BoxDecoration(
            color: const Color(0xFFF0F9FF),
            borderRadius: BorderRadius.circular(10),
            border: Border.all(color: const Color(0xFFBAE6FD)),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Wrap(
                alignment: WrapAlignment.spaceBetween,
                crossAxisAlignment: WrapCrossAlignment.center,
                spacing: 8,
                runSpacing: 8,
                children: [
                  ConstrainedBox(
                    constraints: const BoxConstraints(maxWidth: 320),
                    child: const Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          'Cập nhật tiến độ qua Nhóm Zalo Phòng',
                          style: TextStyle(
                              fontSize: 12,
                              fontWeight: FontWeight.w700,
                              color: Color(0xFF0C4A6E)),
                        ),
                        SizedBox(height: 2),
                        Text(
                          'Tin nhắn tự động loại bỏ ghi chú nội bộ BQL để gửi an toàn cho cư dân.',
                          style:
                              TextStyle(fontSize: 11, color: Color(0xFF0369A1)),
                        ),
                      ],
                    ),
                  ),
                  Wrap(
                    spacing: 8,
                    runSpacing: 8,
                    children: [
                      AppButton(
                        text: 'Sao chép gửi nhóm Zalo',
                        icon: const Icon(LucideIcons.copy, size: 14),
                        size: AppButtonSize.xs,
                        onPressed: _handleCopyZaloRoomMessage,
                      ),
                      if (zaloInviteLink.isNotEmpty)
                        InkWell(
                          onTap: () => _openZaloGroupLink(zaloInviteLink),
                          borderRadius: BorderRadius.circular(8),
                          child: Container(
                            padding: const EdgeInsets.symmetric(
                                horizontal: 10, vertical: 8),
                            decoration: BoxDecoration(
                              color: const Color(0xFF0284C7),
                              borderRadius: BorderRadius.circular(8),
                            ),
                            child: const Row(
                              mainAxisSize: MainAxisSize.min,
                              children: [
                                Icon(LucideIcons.externalLink,
                                    size: 14, color: Colors.white),
                                SizedBox(width: 6),
                                Text(
                                  'Mở nhóm Zalo phòng',
                                  style: TextStyle(
                                      fontSize: 12,
                                      fontWeight: FontWeight.w600,
                                      color: Colors.white),
                                ),
                              ],
                            ),
                          ),
                        ),
                    ],
                  ),
                ],
              ),
              if (zaloGroupName.isNotEmpty) ...[
                const SizedBox(height: 8),
                Text(
                  'Nhóm liên kết: $zaloGroupName',
                  style:
                      const TextStyle(fontSize: 11, color: Color(0xFF0369A1)),
                ),
              ],
              if (zaloPreview.isNotEmpty) ...[
                const SizedBox(height: 8),
                Container(
                  width: double.infinity,
                  padding: const EdgeInsets.all(10),
                  decoration: BoxDecoration(
                    color: Colors.white.withValues(alpha: 0.9),
                    borderRadius: BorderRadius.circular(8),
                    border: Border.all(color: const Color(0xFFBAE6FD)),
                  ),
                  child: RichText(
                    text: TextSpan(
                      style: const TextStyle(
                          fontSize: 12, color: AppColors.slate700, height: 1.4),
                      children: parseZaloBoldSegments(zaloPreview)
                          .map(
                            (seg) => TextSpan(
                              text: seg.text,
                              style: seg.bold
                                  ? const TextStyle(
                                      fontWeight: FontWeight.w700,
                                      color: AppColors.slate900)
                                  : null,
                            ),
                          )
                          .toList(),
                    ),
                  ),
                ),
              ],
              const SizedBox(height: 6),
              const Text(
                'Mẹo trên Zalo PC / Zalo Web: nhấn Ctrl+V (hoặc chuột phải chọn Dán giữ định dạng) để giữ nguyên chữ in đậm.',
                style: TextStyle(fontSize: 11, color: Color(0xFF0369A1)),
              ),
            ],
          ),
        ),
        const SizedBox(height: 16),

        // Thông tin chung & SLA (ngày tiếp nhận, hạn SLA, phản hồi đầu tiên)
        _buildGeneralInfoCard(d),
        const SizedBox(height: 16),

        // Thông tin yêu cầu từ Cư dân
        AppCard(
          header: const AppCardHeader(title: 'Nội dung phản ánh từ Cư dân'),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                d['title']?.toString() ?? '(Không tiêu đề)',
                style: const TextStyle(
                    fontSize: 15,
                    fontWeight: FontWeight.w700,
                    color: AppColors.slate900),
              ),
              const SizedBox(height: 6),
              Text(
                d['description']?.toString() ?? 'Chưa có mô tả chi tiết.',
                style: const TextStyle(
                    fontSize: 13, color: AppColors.slate700, height: 1.4),
              ),
              if (d['location_detail'] != null &&
                  d['location_detail'].toString().isNotEmpty) ...[
                const SizedBox(height: 10),
                Text(
                  'Vị trí cụ thể: ${d['location_detail']}',
                  style: const TextStyle(
                      fontSize: 12,
                      color: AppColors.slate600,
                      fontStyle: FontStyle.italic),
                ),
              ],
              if (d['preferred_slot'] != null) ...[
                const SizedBox(height: 6),
                Text(
                  'Khung giờ thuận tiện: ${d['preferred_slot']}',
                  style:
                      const TextStyle(fontSize: 12, color: AppColors.slate600),
                ),
              ],

              // Lý do mở lại / hủy (React: Mô tả sự cố & Lý do mở lại / hủy)
              if (d['reopen_reason'] != null &&
                  d['reopen_reason'].toString().isNotEmpty) ...[
                const SizedBox(height: 10),
                Container(
                  padding: const EdgeInsets.all(10),
                  decoration: BoxDecoration(
                    color: const Color(0xFFFFF1F2),
                    borderRadius: BorderRadius.circular(8),
                    border: Border.all(color: const Color(0xFFFECDD3)),
                  ),
                  child: Text(
                    'Lý do cư dân mở lại yêu cầu: ${d['reopen_reason']}',
                    style:
                        const TextStyle(fontSize: 12, color: AppColors.rose800),
                  ),
                ),
              ],
              if (d['cancelled_reason'] != null &&
                  d['cancelled_reason'].toString().isNotEmpty) ...[
                const SizedBox(height: 10),
                Container(
                  padding: const EdgeInsets.all(10),
                  decoration: BoxDecoration(
                    color: AppColors.slate50,
                    borderRadius: BorderRadius.circular(8),
                    border: Border.all(color: AppColors.slate200),
                  ),
                  child: Text(
                    'Lý do hủy phiếu: ${d['cancelled_reason']}',
                    style: const TextStyle(
                        fontSize: 12, color: AppColors.slate700),
                  ),
                ),
              ],

              // Ảnh hiện trạng — nhấn để mở lightbox "Xem ảnh đính kèm"
              if (d['images'] is List && (d['images'] as List).isNotEmpty) ...[
                const SizedBox(height: 12),
                Text(
                  'Ảnh hiện trạng (${(d['images'] as List).length})',
                  style: const TextStyle(
                      fontSize: 12,
                      fontWeight: FontWeight.w600,
                      color: AppColors.slate700),
                ),
                const SizedBox(height: 8),
                Wrap(
                  spacing: 8,
                  runSpacing: 8,
                  children: (d['images'] as List).map((imgUrl) {
                    return InkWell(
                      onTap: () => _openImagePreview(imgUrl.toString()),
                      borderRadius: BorderRadius.circular(8),
                      child: ClipRRect(
                        borderRadius: BorderRadius.circular(8),
                        child: AuthImage(
                          src: imgUrl.toString(),
                          width: 80,
                          height: 80,
                          fit: BoxFit.cover,
                        ),
                      ),
                    );
                  }).toList(),
                ),
              ],
            ],
          ),
        ),
        const SizedBox(height: 16),

        // Quy trình Xử lý & Cập nhật Trạng thái Kỹ thuật
        if (canEdit)
          _buildManagementEditSection(d, availableAssignees)
        else
          _buildReadOnlySummarySection(d),

        // Đánh giá sao từ cư dân (nếu có)
        if (d['rating'] != null) ...[
          const SizedBox(height: 16),
          AppCard(
            header:
                const AppCardHeader(title: 'Đánh giá nghiệm thu của Cư dân'),
            child: Row(
              children: [
                ...List.generate(5, (starIdx) {
                  final numRating = num.tryParse(d['rating'].toString()) ?? 0;
                  return Icon(
                    LucideIcons.star,
                    size: 20,
                    color: starIdx < numRating
                        ? AppColors.amber500
                        : AppColors.slate300,
                  );
                }),
                const SizedBox(width: 10),
                if (d['rating_note'] != null &&
                    d['rating_note'].toString().isNotEmpty)
                  Expanded(
                    child: Text(
                      '“${d['rating_note']}”',
                      style: const TextStyle(
                          fontSize: 13,
                          fontStyle: FontStyle.italic,
                          color: AppColors.slate700),
                    ),
                  ),
              ],
            ),
          ),
        ],

        // Lịch sử xử lý (Audit Timeline)
        if (d['audit_timeline'] is List &&
            (d['audit_timeline'] as List).isNotEmpty) ...[
          const SizedBox(height: 16),
          AppCard(
            header: AppCardHeader(
                title:
                    'Lịch sử xử lý (${(d['audit_timeline'] as List).length})'),
            child: Column(
              children:
                  (d['audit_timeline'] as List).whereType<Map>().map((log) {
                final action = log['action']?.toString();
                final actionLabel =
                    (action != null ? kSrAuditActionLabels[action] : null) ??
                        action ??
                        'Cập nhật';
                final prevSt = log['before'] is Map
                    ? log['before']['status']?.toString()
                    : null;
                final nextSt = log['after'] is Map
                    ? log['after']['status']?.toString()
                    : null;
                return Padding(
                  padding: const EdgeInsets.only(bottom: 12),
                  child: Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      const Icon(LucideIcons.history,
                          size: 16, color: AppColors.slate500),
                      const SizedBox(width: 10),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              actionLabel,
                              style: const TextStyle(
                                  fontSize: 13,
                                  fontWeight: FontWeight.w600,
                                  color: AppColors.slate800),
                            ),
                            Text(
                              'Thực hiện bởi: ${log['actor_name']?.toString() ?? 'Hệ thống tự động'}',
                              style: const TextStyle(
                                  fontSize: 12, color: AppColors.slate500),
                            ),
                            if (nextSt != null && nextSt.isNotEmpty)
                              Text(
                                prevSt != null && prevSt != nextSt
                                    ? '$prevSt → $nextSt'
                                    : nextSt,
                                style: const TextStyle(
                                    fontSize: 11, color: AppColors.slate700),
                              ),
                            if (log['note'] != null &&
                                log['note'].toString().isNotEmpty)
                              Text(
                                log['note'].toString(),
                                style: const TextStyle(
                                    fontSize: 12, color: AppColors.slate600),
                              ),
                          ],
                        ),
                      ),
                      if (log['created_at'] != null)
                        Text(
                          formatDateTime(log['created_at']),
                          style: const TextStyle(
                              fontSize: 11, color: AppColors.slate400),
                        ),
                    ],
                  ),
                );
              }).toList(),
            ),
          ),
        ],
      ],
    );
  }

  // Thông tin chung & SLA — port of React "Thông tin chung & SLA"
  Widget _buildGeneralInfoCard(Map<String, dynamic> d) {
    final slot = d['preferred_slot']?.toString() ?? '';
    final requester = d['requester_name']?.toString() ??
        d['resident_name']?.toString() ??
        'Ban quản lý';
    final requesterPhone = d['requester_phone']?.toString() ??
        d['resident_phone']?.toString() ??
        '';

    return AppCard(
      header: const AppCardHeader(title: 'Thông tin chung & SLA'),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          _buildInfoRow('Mã tra cứu', d['tracking_code']?.toString() ?? '—'),
          _buildInfoRow(
            'Vị trí căn hộ',
            'Căn ${d['apartment_code'] ?? '—'} (${d['building_code'] ?? d['building_name'] ?? 'RESIHUB'})',
          ),
          _buildInfoRow('Vị trí trong phòng',
              d['location_detail']?.toString() ?? 'Không ghi cụ thể'),
          _buildInfoRow(
              'Khung giờ cư dân hẹn',
              slot.isEmpty
                  ? 'Linh hoạt'
                  : (kPreferredSlotLabels[slot] ?? slot)),
          _buildInfoRow(
              'Người gửi yêu cầu',
              requesterPhone.isNotEmpty
                  ? '$requester ($requesterPhone)'
                  : requester),
          _buildInfoRow('Thời điểm tiếp nhận', formatDateTime(d['created_at'])),
          if (d['sla_due_at'] != null)
            _buildInfoRow(
                'Hạn hoàn thành SLA', formatDateTime(d['sla_due_at'])),
          if (d['first_responded_at'] != null)
            _buildInfoRow(
                'Phản hồi đầu tiên', formatDateTime(d['first_responded_at'])),
          if (d['resolved_at'] != null)
            _buildInfoRow(
              'Hoàn thành bởi',
              '${d['resolved_by_name']?.toString() ?? 'Kỹ thuật viên'} • ${formatDateTime(d['resolved_at'])}',
            ),
        ],
      ),
    );
  }

  // Card Trí tuệ nhân tạo AI Triage
  Widget _buildAiTriageCard(
    Map<String, dynamic> d,
    bool canEdit,
    Map<String, dynamic>? aiTriageMeta,
    List<Map> availableAssignees,
  ) {
    final cat = d['ai_suggested_category'];
    final prio = d['ai_suggested_priority'];
    final confidenceMeta = formatConfidenceBadge(d['ai_confidence']);
    final is1ClickEligible = canOneClickApplyAiTriage(d);

    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: const Color(0xFFFAF5FF), // purple-50
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: const Color(0xFFE9D5FF)), // purple-200
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Wrap(
            alignment: WrapAlignment.spaceBetween,
            crossAxisAlignment: WrapCrossAlignment.center,
            spacing: 8,
            runSpacing: 6,
            children: [
              ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 320),
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    const Icon(LucideIcons.sparkles,
                        size: 18, color: Color(0xFF9333EA)),
                    const SizedBox(width: 8),
                    const Flexible(
                      child: Text(
                        'Phân loại & điều phối từ AI',
                        style: TextStyle(
                            fontSize: 13,
                            fontWeight: FontWeight.w700,
                            color: Color(0xFF6B21A8)),
                      ),
                    ),
                  ],
                ),
              ),
              if (aiTriageMeta != null)
                AppBadge(
                  label: aiTriageMeta['label']?.toString() ?? '',
                  variant: AppBadgeVariant.fromString(
                      aiTriageMeta['variant']?.toString()),
                  icon: const Icon(LucideIcons.sparkles, size: 10),
                ),
            ],
          ),
          const SizedBox(height: 10),

          // Chi tiết gợi ý
          if (cat != null || prio != null) ...[
            Wrap(
              spacing: 12,
              runSpacing: 6,
              children: [
                if (cat != null)
                  Text(
                    'Hạng mục: ${kServiceRequestCategories[cat] ?? cat}',
                    style: const TextStyle(
                        fontSize: 12,
                        fontWeight: FontWeight.w600,
                        color: AppColors.slate800),
                  ),
                if (prio != null)
                  Text(
                    'Mức độ: $prio',
                    style: const TextStyle(
                        fontSize: 12,
                        fontWeight: FontWeight.w600,
                        color: AppColors.slate800),
                  ),
                AppBadge(
                  label: confidenceMeta.label,
                  variant: AppBadgeVariant.fromString(confidenceMeta.tone),
                ),
                if (d['ai_suggested_assignee_name'] != null)
                  Text(
                    'Kỹ thuật đề xuất: ${d['ai_suggested_assignee_name']}',
                    style: const TextStyle(
                        fontSize: 12,
                        fontWeight: FontWeight.w600,
                        color: AppColors.secondary700),
                  ),
              ],
            ),
            if (d['ai_rationale'] != null &&
                d['ai_rationale'].toString().isNotEmpty) ...[
              const SizedBox(height: 6),
              Text(
                'Lý do: ${d['ai_rationale']}',
                style: const TextStyle(
                    fontSize: 12,
                    color: AppColors.slate600,
                    fontStyle: FontStyle.italic),
              ),
            ],
            const SizedBox(height: 12),
          ],

          // Error alert nếu AI gặp lỗi
          if (_aiTriageError != null) ...[
            Container(
              padding: const EdgeInsets.all(10),
              margin: const EdgeInsets.only(bottom: 10),
              decoration: BoxDecoration(
                color: const Color(0xFFFFF1F2),
                borderRadius: BorderRadius.circular(8),
                border: Border.all(color: const Color(0xFFFECDD3)),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    _aiTriageError!.title,
                    style: const TextStyle(
                        fontSize: 12,
                        fontWeight: FontWeight.w700,
                        color: AppColors.rose800),
                  ),
                  const SizedBox(height: 2),
                  Text(
                    _aiTriageError!.guidance,
                    style:
                        const TextStyle(fontSize: 11, color: AppColors.rose700),
                  ),
                ],
              ),
            ),
          ],

          // Action buttons cho AI Triage
          if (canEdit) ...[
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                if (is1ClickEligible)
                  AppButton(
                    text: 'Áp dụng gợi ý AI (1 chạm)',
                    icon: const Icon(LucideIcons.sparkles, size: 14),
                    size: AppButtonSize.xs,
                    loading: _applyingTriage,
                    onPressed: _handleApplyAiSuggestionExact,
                  ),
                AppButton(
                  text: 'Áp dụng theo lựa chọn đang chỉnh',
                  size: AppButtonSize.xs,
                  variant: AppButtonVariant.soft,
                  loading: _applyingTriage,
                  onPressed: _handleApplyAiWithOverride,
                ),
                AppButton(
                  text: 'Chạy lại AI phân loại',
                  icon: const Icon(LucideIcons.refreshCw, size: 14),
                  size: AppButtonSize.xs,
                  variant: AppButtonVariant.outline,
                  loading: _rerunningAi,
                  onPressed: _handleRerunAiClassify,
                ),
              ],
            ),
          ],
        ],
      ),
    );
  }

  // Section chỉnh sửa xử lý kỹ thuật cho MANAGER
  Widget _buildManagementEditSection(
      Map<String, dynamic> d, List<Map> availableAssignees) {
    return AppCard(
      header: const AppCardHeader(title: 'Điều phối & Xử lý Kỹ thuật'),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // Quick actions
          const Text(
            'Thao tác nhanh:',
            style: TextStyle(
                fontSize: 12,
                fontWeight: FontWeight.w600,
                color: AppColors.slate600),
          ),
          const SizedBox(height: 8),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              if (_status == 'NEW' || _status == 'REOPENED')
                AppButton(
                  text: 'Phân công kỹ thuật',
                  size: AppButtonSize.xs,
                  variant: AppButtonVariant.primary,
                  onPressed: () => _handleSaveStatusUpdate('ASSIGNED'),
                ),
              if (_status == 'NEW' ||
                  _status == 'ASSIGNED' ||
                  _status == 'ON_HOLD' ||
                  _status == 'REOPENED')
                AppButton(
                  text:
                      _status == 'ON_HOLD' ? 'Tiếp tục xử lý' : 'Bắt đầu xử lý',
                  size: AppButtonSize.xs,
                  variant: AppButtonVariant.primary,
                  onPressed: () => _handleSaveStatusUpdate('IN_PROGRESS'),
                ),
              if (_status == 'ASSIGNED' ||
                  _status == 'IN_PROGRESS' ||
                  _status == 'REOPENED')
                AppButton(
                  text: 'Hoàn tất xử lý',
                  size: AppButtonSize.xs,
                  variant: AppButtonVariant.success,
                  onPressed: () => _handleSaveStatusUpdate('RESOLVED'),
                ),
              if (_status == 'ASSIGNED' ||
                  _status == 'IN_PROGRESS' ||
                  _status == 'ON_HOLD' ||
                  _status == 'REOPENED')
                AppButton(
                  text: 'Tạm hoãn / Hẹn lại',
                  size: AppButtonSize.xs,
                  variant: AppButtonVariant.warning,
                  onPressed: () {
                    setState(() => _status = 'ON_HOLD');
                  },
                ),
              if (_status == 'RESOLVED')
                AppButton(
                  text: 'Đóng phiếu',
                  size: AppButtonSize.xs,
                  variant: AppButtonVariant.secondary,
                  onPressed: () => _handleSaveStatusUpdate('CLOSED'),
                ),
              if (kOpenSrStatuses.contains(_status))
                AppButton(
                  text: 'Hủy yêu cầu',
                  size: AppButtonSize.xs,
                  variant: AppButtonVariant.danger,
                  onPressed: () => _handleSaveStatusUpdate('CANCELLED'),
                ),
            ],
          ),
          const SizedBox(height: 16),
          const Divider(height: 1, color: AppColors.slate200),
          const SizedBox(height: 16),

          // Fields
          AppSelect<String>(
            label: 'Trạng thái xử lý',
            value: _status,
            options: kKanbanColumns
                .map((c) => AppSelectOption(value: c.status, label: c.title))
                .toList(),
            onChanged: (val) {
              if (val != null) setState(() => _status = val);
            },
          ),
          const SizedBox(height: 12),
          AppSelect<String>(
            label: 'Kỹ thuật viên phụ trách',
            value: _assignedTo.isEmpty ? null : _assignedTo,
            options: [
              const AppSelectOption(value: '', label: 'Chưa phân công'),
              ...availableAssignees.map(
                (u) => AppSelectOption(
                    value: u['id'].toString(),
                    label: u['name']?.toString() ?? u['id'].toString()),
              ),
            ],
            onChanged: (val) => setState(() => _assignedTo = val ?? ''),
          ),
          const SizedBox(height: 12),

          if (_status == 'ON_HOLD' ||
              _holdReasonController.text.isNotEmpty) ...[
            AppInput(
              label: 'Lý do tạm hoãn / hẹn lại *',
              hint: 'Ví dụ: Đang đợi phụ tùng thay thế từ nhà cung cấp',
              controller: _holdReasonController,
              required: true,
            ),
            const SizedBox(height: 12),
            AppInput(
              label: 'Lịch hẹn xử lý tiếp theo',
              hint: 'YYYY-MM-DDTHH:mm:ss.sssZ',
              controller: _nextAppointmentController,
            ),
            const SizedBox(height: 12),
          ],

          AppInput(
            label:
                'Kết quả xử lý gửi cư dân (hiển thị công khai & gửi nhóm Zalo)',
            hint:
                'Mô tả chi tiết linh kiện đã sửa / thay mới để cư dân nghiệm thu',
            controller: _resolutionNoteController,
            multiline: true,
            rows: 2,
          ),
          const SizedBox(height: 12),

          AppInput(
            label:
                'Ghi chú nội bộ BQL (Tuyệt đối KHÔNG hiển thị ra cư dân hay Zalo)',
            hint: 'Ghi chú chi phí nội bộ, báo giá thợ ngoài, lịch sử lưu ý...',
            controller: _internalNoteController,
            multiline: true,
            rows: 2,
          ),
          const SizedBox(height: 16),

          AppButton(
            text: 'Lưu cập nhật',
            icon: const Icon(LucideIcons.save, size: 16),
            loading: _updating,
            onPressed: () => _handleSaveStatusUpdate(),
          ),
        ],
      ),
    );
  }

  // Section Read-Only tóm tắt cho OWNER / SYS_ADMIN
  Widget _buildReadOnlySummarySection(Map<String, dynamic> d) {
    return AppCard(
      header: const AppCardHeader(title: 'Thông tin Xử lý & Kết quả'),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          _buildInfoRow('Trạng thái hiện tại:', d['status']?.toString() ?? '—'),
          _buildInfoRow('Kỹ thuật viên phụ trách:',
              d['assigned_to_name']?.toString() ?? 'Chưa phân công'),
          if (d['hold_reason'] != null &&
              d['hold_reason'].toString().isNotEmpty)
            _buildInfoRow('Lý do tạm hoãn:', d['hold_reason'].toString()),
          if (d['next_appointment_at'] != null)
            _buildInfoRow('Lịch hẹn xử lý tiếp theo:',
                formatDateTime(d['next_appointment_at'])),
          if (d['resolution_note'] != null &&
              d['resolution_note'].toString().isNotEmpty)
            _buildInfoRow('Kết quả xử lý:', d['resolution_note'].toString()),
          if (d['resolution_images'] is List &&
              (d['resolution_images'] as List).isNotEmpty) ...[
            const SizedBox(height: 8),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: (d['resolution_images'] as List).map((imgUrl) {
                return InkWell(
                  onTap: () => _openImagePreview(imgUrl.toString()),
                  borderRadius: BorderRadius.circular(8),
                  child: ClipRRect(
                    borderRadius: BorderRadius.circular(8),
                    child: AuthImage(
                        src: imgUrl.toString(),
                        width: 80,
                        height: 80,
                        fit: BoxFit.cover),
                  ),
                );
              }).toList(),
            ),
          ],
          if (d['internal_note'] != null &&
              d['internal_note'].toString().isNotEmpty)
            _buildInfoRow('Ghi chú nội bộ:', d['internal_note'].toString()),
        ],
      ),
    );
  }

  Widget _buildInfoRow(String label, String value) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: 170,
            child: Text(
              label,
              style: const TextStyle(
                  fontSize: 12,
                  fontWeight: FontWeight.w600,
                  color: AppColors.slate600),
            ),
          ),
          Expanded(
            child: Text(
              value,
              style: const TextStyle(fontSize: 12, color: AppColors.slate800),
            ),
          ),
        ],
      ),
    );
  }
}

// =============================================================================
// Create Modal Component (Tiếp nhận sự cố hộ Cư dân)
// =============================================================================
class _ServiceRequestCreateModal extends ConsumerStatefulWidget {
  final VoidCallback? onCreated;
  final ValueChanged<String>? onOpenExisting;

  const _ServiceRequestCreateModal({this.onCreated, this.onOpenExisting});

  @override
  ConsumerState<_ServiceRequestCreateModal> createState() =>
      _ServiceRequestCreateModalState();
}

class _ServiceRequestCreateModalState
    extends ConsumerState<_ServiceRequestCreateModal> {
  List<Map<String, dynamic>> _apartments = [];
  bool _loadingApts = true;
  bool _submitting = false;

  String _apartmentId = '';
  String _category = 'ELECTRICAL';
  String _priority = 'NORMAL';
  String _preferredSlot = 'ANYTIME';
  final _titleController = TextEditingController();
  final _descriptionController = TextEditingController();
  final _locationDetailController = TextEditingController();
  List<String> _images = [];

  Map<String, dynamic>? _duplicatePrompt;

  @override
  void initState() {
    super.initState();
    _fetchApartments();
  }

  @override
  void dispose() {
    _titleController.dispose();
    _descriptionController.dispose();
    _locationDetailController.dispose();
    super.dispose();
  }

  Future<void> _fetchApartments() async {
    try {
      final selectedBuildingId = ref.read(authProvider).selectedBuildingId;
      final bService = ref.read(buildingsServiceProvider);
      final res = await bService.listApartments({
        if (selectedBuildingId.isNotEmpty) 'building_id': selectedBuildingId,
      });

      if (!mounted) return;
      if (res is Map && res['data'] is List) {
        setState(() {
          _apartments = (res['data'] as List)
              .whereType<Map>()
              .map((e) => Map<String, dynamic>.from(e))
              .toList();
          _loadingApts = false;
        });
      } else {
        setState(() => _loadingApts = false);
      }
    } catch (_) {
      if (mounted) setState(() => _loadingApts = false);
    }
  }

  Future<void> _submitPayload(Map<String, dynamic> payload) async {
    setState(() => _submitting = true);

    try {
      final service = ref.read(serviceRequestsServiceProvider);
      final res = await service.create(payload);
      if (!mounted) return;

      ref.read(toastProvider.notifier).success(
            res is Map && res['message'] != null
                ? res['message'].toString()
                : 'Đã tạo yêu cầu bảo trì mới.',
          );
      Navigator.of(context).pop();
      widget.onCreated?.call();
    } catch (err) {
      if (!mounted) return;

      // Handle duplicate conflict (409)
      dynamic errResp;
      try {
        errResp = (err as dynamic).response?.data;
      } catch (_) {}

      if (errResp is Map && errResp['code'] == 'DUPLICATE_SERVICE_REQUEST') {
        setState(() {
          _duplicatePrompt = {
            'message': errResp['message'] ??
                'Căn hộ đang có yêu cầu cùng hạng mục trong 24 giờ qua.',
            'existing_request': errResp['existing_request'],
            'pending_payload': payload,
          };
        });
      } else {
        ref.read(toastProvider.notifier).error(
              extractErrorMessage(err, 'Lỗi khi tạo yêu cầu bảo trì.'),
            );
      }
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }

  void _handleSubmit() {
    if (_apartmentId.isEmpty) {
      ref
          .read(toastProvider.notifier)
          .warning('Vui lòng chọn căn hộ cần tạo yêu cầu bảo trì.');
      return;
    }
    if (_titleController.text.trim().isEmpty ||
        _descriptionController.text.trim().isEmpty) {
      ref
          .read(toastProvider.notifier)
          .warning('Vui lòng nhập đầy đủ tiêu đề và mô tả chi tiết sự cố.');
      return;
    }

    final payload = {
      'apartment_id': _apartmentId,
      'category': _category,
      'priority': _priority,
      'preferred_slot': _preferredSlot,
      'title': _titleController.text.trim(),
      'description': _descriptionController.text.trim(),
      'images': _images,
      if (_locationDetailController.text.trim().isNotEmpty)
        'location_detail': _locationDetailController.text.trim(),
    };

    _submitPayload(payload);
  }

  @override
  Widget build(BuildContext context) {
    if (_duplicatePrompt != null) {
      return Container(
        padding: const EdgeInsets.all(20),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                const Icon(LucideIcons.alertTriangle,
                    size: 24, color: AppColors.amber500),
                const SizedBox(width: 10),
                const Expanded(
                  child: Text(
                    'Cảnh báo Yêu cầu Trùng lặp',
                    style: TextStyle(
                        fontSize: 16,
                        fontWeight: FontWeight.w700,
                        color: AppColors.slate900),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 12),
            Text(
              _duplicatePrompt!['message']?.toString() ?? '',
              style: const TextStyle(fontSize: 13, color: AppColors.slate700),
            ),
            const SizedBox(height: 16),
            Wrap(
              alignment: WrapAlignment.end,
              spacing: 10,
              runSpacing: 8,
              children: [
                if (_duplicatePrompt!['existing_request'] is Map &&
                    (_duplicatePrompt!['existing_request'] as Map)['id'] !=
                        null)
                  AppButton(
                    text:
                        'Mở phiếu #${(_duplicatePrompt!['existing_request'] as Map)['tracking_code'] ?? ''}',
                    variant: AppButtonVariant.secondary,
                    onPressed: () {
                      final existingId =
                          (_duplicatePrompt!['existing_request'] as Map)['id']
                              .toString();
                      setState(() => _duplicatePrompt = null);
                      widget.onOpenExisting?.call(existingId);
                    },
                  ),
                AppButton(
                  text: 'Hủy bỏ',
                  variant: AppButtonVariant.outline,
                  onPressed: () => setState(() => _duplicatePrompt = null),
                ),
                AppButton(
                  text: 'Vẫn tạo phiếu mới',
                  variant: AppButtonVariant.warning,
                  loading: _submitting,
                  onPressed: () {
                    final p = Map<String, dynamic>.from(
                        _duplicatePrompt!['pending_payload'] as Map);
                    // Backend (api/src/routes/service-requests.js) đọc ignore_duplicate_warning.
                    p['ignore_duplicate_warning'] = true;
                    _submitPayload(p);
                  },
                ),
              ],
            ),
          ],
        ),
      );
    }

    return SingleChildScrollView(
      padding: const EdgeInsets.all(20),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          AppSelect<String>(
            label: 'Căn hộ yêu cầu *',
            placeholder:
                _loadingApts ? 'Đang tải danh sách căn hộ...' : 'Chọn căn hộ',
            value: _apartmentId.isEmpty ? null : _apartmentId,
            options: _apartments.map((apt) {
              final code = apt['code'] ?? apt['apartment_code'] ?? apt['id'];
              final bName = apt['building_name'] ?? apt['building_code'] ?? '';
              return AppSelectOption(
                value: apt['id'].toString(),
                label:
                    'Phòng $code${bName.toString().isNotEmpty ? ' — $bName' : ''}',
              );
            }).toList(),
            onChanged: (val) => setState(() => _apartmentId = val ?? ''),
          ),
          const SizedBox(height: 12),
          Row(
            children: [
              Expanded(
                child: AppSelect<String>(
                  label: 'Hạng mục sự cố',
                  value: _category,
                  options: kServiceRequestCategories.entries
                      .map((e) => AppSelectOption(value: e.key, label: e.value))
                      .toList(),
                  onChanged: (val) {
                    if (val != null) setState(() => _category = val);
                  },
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: AppSelect<String>(
                  label: 'Mức độ ưu tiên',
                  value: _priority,
                  options: const [
                    AppSelectOption(value: 'LOW', label: 'Thấp'),
                    AppSelectOption(value: 'NORMAL', label: 'Bình thường'),
                    AppSelectOption(value: 'HIGH', label: 'Cao'),
                    AppSelectOption(value: 'URGENT', label: 'Khẩn cấp'),
                  ],
                  onChanged: (val) {
                    if (val != null) setState(() => _priority = val);
                  },
                ),
              ),
            ],
          ),
          const SizedBox(height: 12),
          AppSelect<String>(
            label: 'Khung giờ tiếp nhận thuận tiện',
            value: _preferredSlot,
            options: const [
              AppSelectOption(value: 'ANYTIME', label: 'Linh hoạt cả ngày'),
              AppSelectOption(
                  value: 'MORNING_08_12', label: 'Buổi sáng (08:00 – 12:00)'),
              AppSelectOption(
                  value: 'AFTERNOON_13_17',
                  label: 'Buổi chiều (13:00 – 17:00)'),
              AppSelectOption(
                  value: 'EVENING_18_21', label: 'Buổi tối (18:00 – 21:00)'),
            ],
            onChanged: (val) {
              if (val != null) setState(() => _preferredSlot = val);
            },
          ),
          const SizedBox(height: 12),
          AppInput(
            key: const Key('sr-create-title'),
            label: 'Tiêu đề sự cố *',
            hint: 'Ví dụ: Hỏng vòi sen nhà tắm, Chập aptomat...',
            controller: _titleController,
            required: true,
          ),
          const SizedBox(height: 12),
          AppInput(
            label: 'Vị trí cụ thể trong phòng',
            hint: 'Ví dụ: Ban công, Phòng ngủ Master, Dưới bồn rửa bát...',
            controller: _locationDetailController,
          ),
          const SizedBox(height: 12),
          AppInput(
            key: const Key('sr-create-description'),
            label: 'Mô tả chi tiết sự cố *',
            hint:
                'Mô tả hiện tượng sự cố, nguyên nhân nếu biết, thời điểm phát hiện...',
            controller: _descriptionController,
            multiline: true,
            rows: 3,
            required: true,
          ),
          const SizedBox(height: 12),
          FileUploadField(
            label: 'Ảnh hiện trạng đính kèm (tối đa 3 ảnh)',
            multiple: true,
            maxFiles: 3,
            allowPdf: false,
            value: _images,
            onChanged: (val) => setState(() {
              _images = List<String>.from((val as List?) ?? const <String>[]);
            }),
          ),
          const SizedBox(height: 20),
          AppButton(
            text: 'Tạo yêu cầu bảo trì',
            icon: const Icon(LucideIcons.checkCircle, size: 16),
            loading: _submitting,
            onPressed: _handleSubmit,
          ),
        ],
      ),
    );
  }
}
