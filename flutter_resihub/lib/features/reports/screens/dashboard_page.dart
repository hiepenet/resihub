import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../../../core/constants/statuses.dart';
import '../../../core/theme/app_colors.dart';
import '../../../core/utils/format.dart';
import '../../../core/utils/validation.dart';
import '../../../shared/providers/toast_provider.dart';
import '../../../shared/widgets/common/empty_state.dart';
import '../../../shared/widgets/common/page_header.dart';
import '../../../shared/widgets/common/stats_card.dart';
import '../../../shared/widgets/common/status_badge.dart';
import '../../../shared/widgets/ui/app_button.dart';
import '../../../shared/widgets/ui/app_card.dart';
import '../../../shared/widgets/ui/app_skeleton.dart';
import '../../auth/providers/auth_provider.dart';
import '../services/reports_service.dart';
import '../utils/chart_helpers.dart';
import '../widgets/dashboard_charts.dart';

/// Admin Operations Dashboard Page (PRD §15.1 - 4 fl_charts + Real-time KPIs).
class DashboardPage extends ConsumerStatefulWidget {
  const DashboardPage({super.key});

  @override
  ConsumerState<DashboardPage> createState() => _DashboardPageState();
}

class _DashboardPageState extends ConsumerState<DashboardPage> {
  int _months = 12;
  String _revenueMode = 'trend'; // 'trend' | 'source'
  bool _loading = true;
  Map<String, dynamic>? _data;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _loadDashboard();
    });
  }

  Map<String, dynamic> _buildParams() {
    final buildingId = ref.read(authProvider).selectedBuildingId;
    return {
      'months': _months,
      if (buildingId.isNotEmpty) 'building_id': buildingId,
    };
  }

  Future<void> _loadDashboard({bool force = false}) async {
    final params = _buildParams();
    final service = ref.read(reportsServiceProvider);

    if (!force) {
      final cached = service.peekDashboard(params);
      if (cached != null && cached is Map) {
        setState(() {
          _data = cached['data'] is Map
              ? (cached['data'] as Map).cast<String, dynamic>()
              : cached.cast<String, dynamic>();
        });
      }
    }

    setState(() => _loading = true);
    try {
      var res = await service.getDashboard(params, force);
      if (res is String) {
        try {
          res = jsonDecode(res);
        } catch (_) {}
      }
      if (mounted && res is Map) {
        final payload = res['data'] is Map ? (res['data'] as Map).cast<String, dynamic>() : res.cast<String, dynamic>();
        setState(() {
          _data = payload;
        });
      }
    } catch (err) {
      if (mounted) {
        ref.read(toastProvider.notifier).error(
              extractErrorMessage(err, 'Không thể tải dữ liệu bảng điều khiển.'),
            );
      }
    } finally {
      if (mounted) {
        setState(() => _loading = false);
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_loading && _data == null) {
      return const PageSkeleton();
    }

    final kpis = _data?['kpis'] is Map ? (_data!['kpis'] as Map).cast<String, dynamic>() : <String, dynamic>{};
    final rev12m = _data?['revenue_12m'] is List ? _data!['revenue_12m'] as List : const [];
    final revBySource = _data?['revenue_by_source'] is List ? _data!['revenue_by_source'] as List : const [];
    final agingInfo = _data?['receivables_aging'] is Map
        ? (_data!['receivables_aging'] as Map).cast<String, dynamic>()
        : <String, dynamic>{};
    final occ12m = _data?['occupancy_12m'] is List ? _data!['occupancy_12m'] as List : const [];
    final expiringContracts =
        _data?['expiring_contracts'] is List ? _data!['expiring_contracts'] as List : const [];
    final recentRequests =
        _data?['recent_service_requests'] is List ? _data!['recent_service_requests'] as List : const [];

    final revenueTrendData = buildRevenueTrendChartData(rev12m);
    final revenueSourceData = buildRevenueBySourceChartData(revBySource);
    final agingChart = buildReceivablesAgingChartData(agingInfo);
    final occupancyTrend = buildOccupancyTrendChartData(occ12m);

    final showRevenueChart = hasRevenueChartData(rev12m, revBySource);
    final showAgingChart = hasAgingChartData(agingInfo);
    final showOccupancyChart = hasOccupancyChartData(kpis['total_apartments'], occ12m);

    final subtitleParts = [
      'Tổng hợp chỉ số kinh doanh & kỹ thuật theo thời gian thực (Kỳ ${kpis['current_period'] ?? ''})',
    ];
    if (_data?['generated_at'] != null) {
      subtitleParts.add('Cập nhật lúc ${formatDateTime(_data!['generated_at'])}');
    }

    return Scaffold(
      key: const Key('route:/admin/dashboard'),
      backgroundColor: AppColors.background,
      body: SingleChildScrollView(
        padding: const EdgeInsets.all(24),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            // Page Header
            PageHeader(
              title: 'Bảng điều khiển vận hành',
              subtitle: subtitleParts.join(' · '),
              actions: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  // Months selector
                  Container(
                    padding: const EdgeInsets.all(2),
                    decoration: BoxDecoration(
                      color: AppColors.slate100,
                      borderRadius: BorderRadius.circular(8),
                      border: Border.all(color: AppColors.slate200),
                    ),
                    child: Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        for (final m in [6, 12])
                          InkWell(
                            onTap: () {
                              if (_months != m) {
                                setState(() => _months = m);
                                _loadDashboard();
                              }
                            },
                            borderRadius: BorderRadius.circular(6),
                            child: Container(
                              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
                              decoration: BoxDecoration(
                                color: _months == m ? Colors.white : Colors.transparent,
                                borderRadius: BorderRadius.circular(6),
                                boxShadow: _months == m
                                    ? const [
                                        BoxShadow(
                                          color: Color(0x0F000000),
                                          blurRadius: 4,
                                          offset: Offset(0, 1),
                                        ),
                                      ]
                                    : null,
                              ),
                              child: Text(
                                '$m kỳ',
                                style: TextStyle(
                                  fontSize: 12,
                                  fontWeight: FontWeight.w600,
                                  color: _months == m ? AppColors.primary700 : AppColors.slate600,
                                ),
                              ),
                            ),
                          ),
                      ],
                    ),
                  ),
                  const SizedBox(width: 8),
                  AppButton(
                    text: 'Làm mới',
                    variant: AppButtonVariant.outline,
                    size: AppButtonSize.sm,
                    icon: const Icon(LucideIcons.refreshCw, size: 14),
                    loading: _loading,
                    onPressed: () => _loadDashboard(force: true),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 20),

            // Top KPIs (4 Cards)
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
                      title: 'Tỷ lệ lấp đầy',
                      value: '${kpis['occupancy_rate'] ?? 0}%',
                      subtext:
                          '${kpis['occupied_apartments'] ?? 0}/${kpis['total_apartments'] ?? 0} căn đang khai thác (${kpis['available_apartments'] ?? 0} trống)',
                      icon: LucideIcons.building2,
                      color: 'sky',
                      onClick: () => context.go('/admin/buildings'),
                    ),
                    StatsCard(
                      title: 'Doanh thu tháng này',
                      value: formatCompactMoney(kpis['monthly_revenue'] ?? 0),
                      valueTitle: formatMoney(kpis['monthly_revenue'] ?? 0),
                      trend: kpis['revenue_growth_pct'] is num ? (kpis['revenue_growth_pct'] as num) : null,
                      subtext:
                          'Thực thu: ${formatMoney(kpis['monthly_revenue'] ?? 0)} · Phát hành: ${formatMoney(kpis['monthly_billed'] ?? 0)}',
                      icon: LucideIcons.trendingUp,
                      color: 'emerald',
                      onClick: () => context.go('/admin/invoices'),
                    ),
                    StatsCard(
                      title: 'Công nợ chưa thu',
                      value: formatCompactMoney(kpis['unpaid_debt'] ?? 0),
                      valueTitle: formatMoney(kpis['unpaid_debt'] ?? 0),
                      subtext: 'Tổng dư nợ: ${formatMoney(kpis['unpaid_debt'] ?? 0)}',
                      icon: LucideIcons.alertCircle,
                      color: 'rose',
                      onClick: () => context.go('/admin/payments'),
                    ),
                    StatsCard(
                      title: 'Yêu cầu chờ xử lý',
                      value: '${kpis['pending_requests'] ?? 0}',
                      subtext: 'Sự cố kỹ thuật mới / đang xử lý',
                      icon: LucideIcons.wrench,
                      color: 'amber',
                      onClick: () => context.go('/admin/maintenance'),
                    ),
                  ],
                );
              },
            ),
            const SizedBox(height: 16),

            // Operational Alerts / Four-Eyes Queue Cards (7 cards)
            LayoutBuilder(
              builder: (context, constraints) {
                final isWide = constraints.maxWidth >= 1000;
                final isMedium = constraints.maxWidth >= 600;
                final crossAxisCount = isWide ? 4 : (isMedium ? 2 : 1);

                return GridView.count(
                  crossAxisCount: crossAxisCount,
                  crossAxisSpacing: 12,
                  mainAxisSpacing: 12,
                  shrinkWrap: true,
                  physics: const NeverScrollableScrollPhysics(),
                  childAspectRatio: isWide ? 2.5 : 2.8,
                  children: [
                    _buildAlertCard(
                      title: 'Chờ duyệt điều chỉnh HĐ',
                      count: kpis['pending_invoice_adjustments'] ?? 0,
                      hint: 'Duyệt 4 mắt HĐ →',
                      icon: LucideIcons.fileText,
                      bg: const Color(0xFFFAF5FF),
                      border: const Color(0xFFE9D5FF),
                      textColor: const Color(0xFF6B21A8),
                      iconColor: const Color(0xFF9333EA),
                      onTap: () => context.go('/admin/invoices?status=PENDING_APPROVAL'),
                    ),
                    _buildAlertCard(
                      title: 'Chờ duyệt hoàn tín dụng',
                      count: kpis['pending_credit_refunds'] ?? 0,
                      hint: 'Duyệt 4 mắt hoàn tiền →',
                      icon: LucideIcons.receipt,
                      bg: const Color(0xFFEEF2FF),
                      border: const Color(0xFFC7D2FE),
                      textColor: const Color(0xFF3730A3),
                      iconColor: const Color(0xFF4F46E5),
                      onTap: () => context.go('/admin/payments?tab=credits&status=PENDING_DIRECT_REFUND'),
                    ),
                    _buildAlertCard(
                      title: 'Chờ duyệt tất toán cọc',
                      count: kpis['pending_deposit_approvals'] ?? 0,
                      hint: 'Duyệt Four-Eyes →',
                      icon: LucideIcons.clock,
                      bg: const Color(0xFFFFFBEB),
                      border: const Color(0xFFFDE68A),
                      textColor: const Color(0xFF92400E),
                      iconColor: const Color(0xFFD97706),
                      onTap: () => context.go('/admin/deposits?tab=pending'),
                    ),
                    _buildAlertCard(
                      title: 'Chờ chi hoàn / Trả lệnh',
                      count: kpis['pending_deposit_payouts'] ?? 0,
                      hint: 'Phát hành UNC →',
                      icon: LucideIcons.wallet,
                      bg: const Color(0xFFF0F9FF),
                      border: const Color(0xFFBAE6FD),
                      textColor: const Color(0xFF075985),
                      iconColor: const Color(0xFF0284C7),
                      onTap: () => context.go('/admin/deposits?tab=payout'),
                    ),
                    _buildAlertCard(
                      title: 'Quá hạn hoàn cọc (5 ngày)',
                      count: kpis['overdue_deposit_refunds'] ?? 0,
                      hint: 'Xử lý khẩn FR-068 →',
                      icon: LucideIcons.alertCircle,
                      bg: const Color(0xFFFFF1F2),
                      border: const Color(0xFFFECDD3),
                      textColor: const Color(0xFF9F1239),
                      iconColor: const Color(0xFFE11D48),
                      onTap: () => context.go('/admin/deposits?overdue=1'),
                    ),
                    _buildAlertCard(
                      title: 'Sổ cọc đang tranh chấp',
                      count: kpis['disputed_deposits'] ?? 0,
                      hint: 'Giải quyết khiếu nại →',
                      icon: LucideIcons.shieldAlert,
                      bg: const Color(0xFFFAF5FF),
                      border: const Color(0xFFE9D5FF),
                      textColor: const Color(0xFF6B21A8),
                      iconColor: const Color(0xFF9333EA),
                      onTap: () => context.go('/admin/deposits?status=DISPUTED'),
                    ),
                    _buildAlertCard(
                      title: 'Giữ chỗ chờ sao kê',
                      count: kpis['pending_reservation_confirms'] ?? 0,
                      hint: 'Đối chiếu chuyển khoản →',
                      icon: LucideIcons.checkCircle2,
                      bg: const Color(0xFFECFDF5),
                      border: const Color(0xFFA7F3D0),
                      textColor: const Color(0xFF065F46),
                      iconColor: const Color(0xFF059669),
                      onTap: () => context.go('/admin/buildings/floor-plan?pending_confirm=1'),
                    ),
                  ],
                );
              },
            ),
            const SizedBox(height: 20),

            // Charts Row 1: (1) Revenue Chart & (2) Receivables Aging Chart
            LayoutBuilder(
              builder: (context, constraints) {
                final isWide = constraints.maxWidth >= 960;

                final revenueCard = AppCard(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      AppCardHeader(
                        title: 'Biểu đồ doanh thu ($_months kỳ gần nhất)',
                        subtitle: _revenueMode == 'trend'
                            ? 'Xu hướng doanh thu phát hành (ISSUED), tất toán & thực thu theo kỳ'
                            : 'Cơ cấu doanh thu phát hành theo nguồn: Thuê phòng, Điện, Nước, Dịch vụ & Khác',
                        action: Row(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            Container(
                              padding: const EdgeInsets.all(2),
                              decoration: BoxDecoration(
                                color: AppColors.slate100,
                                borderRadius: BorderRadius.circular(8),
                                border: Border.all(color: AppColors.slate200),
                              ),
                              child: Row(
                                mainAxisSize: MainAxisSize.min,
                                children: [
                                  _buildModeButton('Xu hướng thu', _revenueMode == 'trend', () {
                                    setState(() => _revenueMode = 'trend');
                                  }),
                                  _buildModeButton('Theo nguồn thu', _revenueMode == 'source', () {
                                    setState(() => _revenueMode = 'source');
                                  }),
                                ],
                              ),
                            ),
                            const SizedBox(width: 8),
                            AppButton(
                              text: 'Báo cáo',
                              variant: AppButtonVariant.ghost,
                              size: AppButtonSize.xs,
                              rightIcon: const Icon(LucideIcons.arrowRight, size: 14),
                              onPressed: () => context.go('/admin/reports'),
                            ),
                          ],
                        ),
                      ),
                      const SizedBox(height: 12),
                      SizedBox(
                        height: 310,
                        child: !showRevenueChart
                            ? EmptyState(
                                icon: LucideIcons.barChart3,
                                title: 'Chưa phát sinh doanh thu trong giai đoạn này',
                                description:
                                    'Biểu đồ sẽ hiển thị ngay khi có hóa đơn phát hành hoặc thanh toán.',
                                action: AppButton(
                                  text: 'Quản lý hóa đơn',
                                  variant: AppButtonVariant.outline,
                                  size: AppButtonSize.sm,
                                  onPressed: () => context.go('/admin/invoices'),
                                ),
                              )
                            : _revenueMode == 'trend'
                                ? RevenueTrendLineChart(data: revenueTrendData)
                                : RevenueSourceStackedBarChart(
                                    data: revenueSourceData,
                                    onTap: () => context.go('/admin/invoices'),
                                  ),
                      ),
                    ],
                  ),
                );

                final agingCard = AppCard(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      AppCardHeader(
                        title: 'Công nợ theo nhóm tuổi nợ',
                        subtitle:
                            'Quá hạn: ${formatMoney(agingInfo['overdue_debt'] ?? 0)} / Tổng: ${formatMoney(agingInfo['total_debt'] ?? kpis['unpaid_debt'] ?? 0)} · Bấm cột để lọc',
                        action: AppButton(
                          text: 'Sổ công nợ',
                          variant: AppButtonVariant.ghost,
                          size: AppButtonSize.xs,
                          rightIcon: const Icon(LucideIcons.arrowRight, size: 14),
                          onPressed: () => context.go('/admin/payments?tab=aging'),
                        ),
                      ),
                      const SizedBox(height: 12),
                      SizedBox(
                        height: 310,
                        child: !showAgingChart
                            ? const EmptyState(
                                icon: LucideIcons.checkCircle2,
                                title: 'Không có công nợ tồn đọng',
                                description:
                                    'Toàn bộ khoản phải thu trong phạm vi hiện đã được thanh toán đầy đủ.',
                              )
                            : ReceivablesAgingBarChart(
                                data: agingChart,
                                onBucketTap: (bucketKey) {
                                  context.go('/admin/payments?tab=aging&bucket=$bucketKey');
                                },
                              ),
                      ),
                    ],
                  ),
                );

                if (isWide) {
                  return Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Expanded(flex: 7, child: revenueCard),
                      const SizedBox(width: 16),
                      Expanded(flex: 5, child: agingCard),
                    ],
                  );
                }

                return Column(
                  children: [
                    revenueCard,
                    const SizedBox(height: 16),
                    agingCard,
                  ],
                );
              },
            ),
            const SizedBox(height: 20),

            // Charts Row 2: (3) Occupancy Trend Chart
            AppCard(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  AppCardHeader(
                    title: 'Biểu đồ tỷ lệ lấp đầy ($_months kỳ gần nhất)',
                    subtitle:
                        'Tỷ lệ căn hộ có hợp đồng hiệu lực trên tổng số căn hộ khai thác được tại ngày cuối kỳ',
                    action: AppButton(
                      text: 'Danh mục căn hộ',
                      variant: AppButtonVariant.ghost,
                      size: AppButtonSize.xs,
                      rightIcon: const Icon(LucideIcons.arrowRight, size: 14),
                      onPressed: () => context.go('/admin/buildings'),
                    ),
                  ),
                  const SizedBox(height: 12),
                  SizedBox(
                    height: 290,
                    child: !showOccupancyChart
                        ? EmptyState(
                            icon: LucideIcons.building2,
                            title: 'Chưa có căn hộ khai thác',
                            description: 'Hãy khởi tạo tòa nhà và danh sách căn hộ để theo dõi tỷ lệ lấp đầy.',
                            action: AppButton(
                              text: 'Thiết lập tòa nhà',
                              variant: AppButtonVariant.outline,
                              size: AppButtonSize.sm,
                              onPressed: () => context.go('/admin/buildings'),
                            ),
                          )
                        : OccupancyTrendLineChart(
                            data: occupancyTrend,
                            onTap: () => context.go('/admin/buildings'),
                          ),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 20),

            // Bottom Widgets: Expiring Contracts + Recent Service Requests
            LayoutBuilder(
              builder: (context, constraints) {
                final isWide = constraints.maxWidth >= 900;

                final contractsWidget = AppCard(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      AppCardHeader(
                        title: 'Hợp đồng sắp hết hạn (45 ngày tới)',
                        subtitle: 'Chủ động liên hệ cư dân để gia hạn hoặc chuẩn bị bàn giao phòng',
                        action: AppButton(
                          text: 'Tất cả HĐ',
                          variant: AppButtonVariant.ghost,
                          size: AppButtonSize.xs,
                          rightIcon: const Icon(LucideIcons.arrowRight, size: 14),
                          onPressed: () => context.go('/admin/contracts'),
                        ),
                      ),
                      if (expiringContracts.isEmpty)
                        const Padding(
                          padding: EdgeInsets.symmetric(vertical: 24),
                          child: Center(
                            child: Text(
                              'Không có hợp đồng nào sắp hết hạn trong 45 ngày tới.',
                              style: TextStyle(fontSize: 12, color: AppColors.slate400),
                            ),
                          ),
                        )
                      else
                        ListView.separated(
                          shrinkWrap: true,
                          physics: const NeverScrollableScrollPhysics(),
                          itemCount: expiringContracts.length,
                          separatorBuilder: (_, __) => const Divider(height: 1, color: AppColors.slate100),
                          itemBuilder: (context, idx) {
                            final c = expiringContracts[idx] as Map;
                            final daysLeft = num.tryParse(c['days_left']?.toString() ?? '0')?.toInt() ?? 0;
                            final isUrgent = daysLeft <= 7;

                            return InkWell(
                              onTap: () => context.go('/admin/contracts/${c['id']}'),
                              borderRadius: BorderRadius.circular(8),
                              child: Padding(
                                padding: const EdgeInsets.symmetric(vertical: 10, horizontal: 8),
                                child: Row(
                                  children: [
                                    Expanded(
                                      child: Column(
                                        crossAxisAlignment: CrossAxisAlignment.start,
                                        children: [
                                          Row(
                                            children: [
                                              Container(
                                                padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                                                decoration: BoxDecoration(
                                                  color: const Color(0xFFF0F9FF),
                                                  borderRadius: BorderRadius.circular(4),
                                                ),
                                                child: Text(
                                                  '${c['building_name'] ?? c['building_code'] ?? ''} · ${c['apartment_code'] ?? ''}',
                                                  style: const TextStyle(
                                                    fontSize: 11,
                                                    fontWeight: FontWeight.bold,
                                                    color: AppColors.primary700,
                                                  ),
                                                ),
                                              ),
                                              const SizedBox(width: 8),
                                              Expanded(
                                                child: Text(
                                                  '${c['tenant_name'] ?? ''}${c['tenant_phone'] != null ? ' (${c['tenant_phone']})' : ''}',
                                                  style: const TextStyle(
                                                    fontSize: 13,
                                                    fontWeight: FontWeight.w600,
                                                    color: AppColors.slate800,
                                                  ),
                                                  overflow: TextOverflow.ellipsis,
                                                ),
                                              ),
                                            ],
                                          ),
                                          const SizedBox(height: 4),
                                          Text(
                                            'Hết hạn: ${formatDate(c['end_date'])} · Giá thuê: ${formatMoney(c['rent_amount'])}',
                                            style: const TextStyle(fontSize: 11, color: AppColors.slate500),
                                          ),
                                        ],
                                      ),
                                    ),
                                    Container(
                                      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                                      decoration: BoxDecoration(
                                        color: isUrgent ? const Color(0xFFFFF1F2) : const Color(0xFFFFFBEB),
                                        borderRadius: BorderRadius.circular(12),
                                      ),
                                      child: Row(
                                        mainAxisSize: MainAxisSize.min,
                                        children: [
                                          Icon(
                                            LucideIcons.calendarClock,
                                            size: 13,
                                            color: isUrgent ? const Color(0xFFE11D48) : const Color(0xFFD97706),
                                          ),
                                          const SizedBox(width: 4),
                                          Text(
                                            'Còn $daysLeft ngày',
                                            style: TextStyle(
                                              fontSize: 11,
                                              fontWeight: FontWeight.bold,
                                              color: isUrgent ? const Color(0xFFBE123C) : const Color(0xFFB45309),
                                            ),
                                          ),
                                        ],
                                      ),
                                    ),
                                  ],
                                ),
                              ),
                            );
                          },
                        ),
                    ],
                  ),
                );

                final requestsWidget = AppCard(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      AppCardHeader(
                        title: 'Yêu cầu báo hỏng mới nhất',
                        subtitle: '5 phản ánh kỹ thuật gần đây từ các tòa nhà',
                        action: AppButton(
                          text: 'Xử lý ngay',
                          variant: AppButtonVariant.ghost,
                          size: AppButtonSize.xs,
                          rightIcon: const Icon(LucideIcons.arrowRight, size: 14),
                          onPressed: () => context.go('/admin/maintenance'),
                        ),
                      ),
                      if (recentRequests.isEmpty)
                        const Padding(
                          padding: EdgeInsets.symmetric(vertical: 24),
                          child: Center(
                            child: Text(
                              'Chưa có yêu cầu báo hỏng nào.',
                              style: TextStyle(fontSize: 12, color: AppColors.slate400),
                            ),
                          ),
                        )
                      else
                        ListView.separated(
                          shrinkWrap: true,
                          physics: const NeverScrollableScrollPhysics(),
                          itemCount: recentRequests.length,
                          separatorBuilder: (_, __) => const Divider(height: 1, color: AppColors.slate100),
                          itemBuilder: (context, idx) {
                            final sr = recentRequests[idx] as Map;

                            return InkWell(
                              onTap: () => context.go('/admin/maintenance'),
                              borderRadius: BorderRadius.circular(8),
                              child: Padding(
                                padding: const EdgeInsets.symmetric(vertical: 10, horizontal: 8),
                                child: Row(
                                  children: [
                                    Expanded(
                                      child: Column(
                                        crossAxisAlignment: CrossAxisAlignment.start,
                                        children: [
                                          Row(
                                            children: [
                                              Text(
                                                '#${sr['tracking_code'] ?? ''}',
                                                style: const TextStyle(
                                                  fontSize: 11,
                                                  fontFamily: 'monospace',
                                                  fontWeight: FontWeight.w600,
                                                  color: AppColors.slate500,
                                                ),
                                              ),
                                              const SizedBox(width: 8),
                                              Expanded(
                                                child: Text(
                                                  '${sr['building_name'] ?? sr['building_code'] ?? ''} · ${sr['apartment_code'] ?? ''}',
                                                  style: const TextStyle(
                                                    fontSize: 12,
                                                    fontWeight: FontWeight.w600,
                                                    color: Color(0xFF0369A1),
                                                  ),
                                                  overflow: TextOverflow.ellipsis,
                                                ),
                                              ),
                                            ],
                                          ),
                                          const SizedBox(height: 3),
                                          Text(
                                            sr['title']?.toString() ?? '',
                                            maxLines: 1,
                                            overflow: TextOverflow.ellipsis,
                                            style: const TextStyle(
                                              fontSize: 13,
                                              fontWeight: FontWeight.w500,
                                              color: AppColors.slate800,
                                            ),
                                          ),
                                          const SizedBox(height: 2),
                                          Text(
                                            formatRelativeTime(sr['created_at']),
                                            style: const TextStyle(fontSize: 11, color: AppColors.slate400),
                                          ),
                                        ],
                                      ),
                                    ),
                                    Column(
                                      crossAxisAlignment: CrossAxisAlignment.end,
                                      children: [
                                        StatusBadge(
                                          status: sr['status']?.toString(),
                                          domain: StatusDomain.serviceRequest,
                                        ),
                                        const SizedBox(height: 4),
                                        StatusBadge(
                                          status: sr['priority']?.toString(),
                                          domain: StatusDomain.priority,
                                          dot: false,
                                        ),
                                      ],
                                    ),
                                  ],
                                ),
                              ),
                            );
                          },
                        ),
                    ],
                  ),
                );

                if (isWide) {
                  return Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Expanded(child: contractsWidget),
                      const SizedBox(width: 16),
                      Expanded(child: requestsWidget),
                    ],
                  );
                }

                return Column(
                  children: [
                    contractsWidget,
                    const SizedBox(height: 16),
                    requestsWidget,
                  ],
                );
              },
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildModeButton(String label, bool active, VoidCallback onTap) {
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(6),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
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

  Widget _buildAlertCard({
    required String title,
    required dynamic count,
    required String hint,
    required IconData icon,
    required Color bg,
    required Color border,
    required Color textColor,
    required Color iconColor,
    required VoidCallback onTap,
  }) {
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(12),
      child: Container(
        padding: const EdgeInsets.all(12),
        decoration: BoxDecoration(
          color: bg,
          borderRadius: BorderRadius.circular(12),
          border: Border.all(color: border),
        ),
        child: Row(
          children: [
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  Text(
                    title,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(fontSize: 11, fontWeight: FontWeight.w600, color: textColor),
                  ),
                  const SizedBox(height: 2),
                  Text(
                    '$count',
                    style: const TextStyle(fontSize: 18, fontWeight: FontWeight.bold, color: AppColors.slate900),
                  ),
                  const SizedBox(height: 2),
                  Text(
                    hint,
                    style: TextStyle(fontSize: 10, fontWeight: FontWeight.w500, color: textColor),
                  ),
                ],
              ),
            ),
            Icon(icon, size: 22, color: iconColor),
          ],
        ),
      ),
    );
  }
}
