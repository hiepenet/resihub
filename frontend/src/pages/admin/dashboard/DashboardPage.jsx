import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  BarElement,
  ArcElement,
  Title,
  Tooltip as ChartTooltip,
  Legend,
  Filler,
} from 'chart.js';
import { Line, Bar, Doughnut } from 'react-chartjs-2';
import {
  Building2,
  TrendingUp,
  AlertCircle,
  Wrench,
  CalendarClock,
  FileText,
  Receipt,
  ArrowRight,
  RefreshCw,
  Wallet,
  ShieldAlert,
  Clock,
  CheckCircle2,
  BarChart3,
} from 'lucide-react';
import { PageHeader } from '../../../components/common/PageHeader';
import { StatsCard } from '../../../components/common/StatsCard';
import { StatusBadge } from '../../../components/common/StatusBadge';
import { EmptyState } from '../../../components/common/EmptyState';
import { Card, CardHeader } from '../../../components/ui/Card';
import { Button } from '../../../components/ui/Button';
import { PageSkeleton } from '../../../components/ui/Skeleton';
import { reportsService } from '../../../services/reports.service';
import { useAuthStore } from '../../../stores/authStore';
import { useToast } from '../../../hooks/useToast';
import {
  formatCompactMoney,
  formatMoney,
  formatDate,
  formatDateTime,
  formatRelativeTime,
} from '../../../utils/format';
import {
  hasRevenueChartData,
  hasAgingChartData,
  hasOccupancyChartData,
  buildRevenueTrendChartData,
  buildRevenueBySourceChartData,
  buildReceivablesAgingChartData,
  buildOccupancyTrendChartData,
  buildApartmentStatusDoughnutData,
} from '../../../utils/chartHelpers';
import { extractErrorMessage } from '../../../utils/validation';

ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  BarElement,
  ArcElement,
  Title,
  ChartTooltip,
  Legend,
  Filler
);

export function DashboardPage() {
  const navigate = useNavigate();
  const toast = useToast();
  const selectedBuildingId = useAuthStore((s) => s.selectedBuildingId);

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [months, setMonths] = useState(12);
  const [revenueMode, setRevenueMode] = useState('trend'); // 'trend' | 'source'

  const loadDashboard = useCallback(async () => {
    setLoading(true);
    try {
      const params = {
        months,
        ...(selectedBuildingId ? { building_id: selectedBuildingId } : {}),
      };
      const res = await reportsService.getDashboard(params);
      setData(res.data);
    } catch (err) {
      toast.error(extractErrorMessage(err, 'Không thể tải dữ liệu bảng điều khiển.'));
    } finally {
      setLoading(false);
    }
  }, [selectedBuildingId, months, toast]);

  useEffect(() => {
    loadDashboard();
  }, [loadDashboard]);

  const kpis = data?.kpis || {};
  const breakdown = data?.apartment_status_breakdown || {};
  const rev12m = data?.revenue_12m || [];
  const revBySource = data?.revenue_by_source || [];
  const agingInfo = data?.receivables_aging || {};
  const occ12m = data?.occupancy_12m || [];
  const expiringContracts = data?.expiring_contracts || [];
  const recentRequests = data?.recent_service_requests || [];

  const revenueTrendData = useMemo(() => buildRevenueTrendChartData(rev12m), [rev12m]);
  const revenueSourceData = useMemo(
    () => buildRevenueBySourceChartData(revBySource),
    [revBySource]
  );
  const agingChart = useMemo(
    () => buildReceivablesAgingChartData(agingInfo),
    [agingInfo]
  );
  const occupancyTrend = useMemo(
    () => buildOccupancyTrendChartData(occ12m),
    [occ12m]
  );
  const doughnutData = useMemo(
    () => buildApartmentStatusDoughnutData(breakdown),
    [breakdown]
  );

  if (loading && !data) {
    return <PageSkeleton />;
  }

  const showRevenueChart = hasRevenueChartData(rev12m, revBySource);
  const showAgingChart = hasAgingChartData(agingInfo);
  const showOccupancyChart = hasOccupancyChartData(kpis.total_apartments, occ12m);

  const subtitleParts = [
    `Tổng hợp chỉ số kinh doanh & kỹ thuật theo thời gian thực (Kỳ ${kpis.current_period || ''})`,
  ];
  if (data?.generated_at) {
    subtitleParts.push(`Cập nhật lúc ${formatDateTime(data.generated_at)}`);
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Bảng điều khiển vận hành"
        subtitle={subtitleParts.join(' · ')}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <div
              role="group"
              aria-label="Chọn khoảng kỳ thống kê"
              className="inline-flex items-center rounded-lg border border-slate-200 bg-slate-50 p-0.5"
            >
              {[6, 12].map((m) => {
                const active = months === m;
                return (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setMonths(m)}
                    aria-pressed={active}
                    className={`px-3 py-1.5 min-h-[36px] sm:min-h-0 text-xs font-semibold rounded-md transition-colors ${
                      active
                        ? 'bg-white text-primary-700 shadow-xs'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    {m} kỳ
                  </button>
                );
              })}
            </div>
            <Button
              variant="outline"
              size="sm"
              icon={RefreshCw}
              onClick={loadDashboard}
              loading={loading}
            >
              Làm mới
            </Button>
          </div>
        }
      />

      {/* 2x2 / 4-Col KPI Row */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <StatsCard
          title="Tỷ lệ lấp đầy"
          value={`${kpis.occupancy_rate || 0}%`}
          subtext={`${kpis.occupied_apartments || 0}/${kpis.total_apartments || 0} căn đang khai thác (${kpis.available_apartments || 0} trống)`}
          icon={Building2}
          color="sky"
          onClick={() => navigate('/admin/buildings')}
        />
        <StatsCard
          title="Doanh thu tháng này"
          value={formatCompactMoney(kpis.monthly_revenue || 0)}
          valueTitle={formatMoney(kpis.monthly_revenue || 0)}
          trend={kpis.revenue_growth_pct}
          subtext={`Thực thu: ${formatMoney(kpis.monthly_revenue || 0)} · Phát hành: ${formatMoney(kpis.monthly_billed || 0)}`}
          icon={TrendingUp}
          color="emerald"
          onClick={() => navigate('/admin/invoices')}
        />
        <StatsCard
          title="Công nợ chưa thu"
          value={formatCompactMoney(kpis.unpaid_debt || 0)}
          valueTitle={formatMoney(kpis.unpaid_debt || 0)}
          subtext={`Tổng dư nợ: ${formatMoney(kpis.unpaid_debt || 0)}`}
          icon={AlertCircle}
          color="rose"
          onClick={() => navigate('/admin/payments')}
        />
        <StatsCard
          title="Yêu cầu chờ xử lý"
          value={kpis.pending_requests || 0}
          subtext="Sự cố kỹ thuật mới / đang xử lý"
          icon={Wrench}
          color="amber"
          onClick={() => navigate('/admin/maintenance')}
        />
      </div>

      {/* Dải KPI Cảnh báo Sổ cọc & Giữ chỗ có Drill-down (GAP-05 / FR-024) */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        {/* Four-Eyes Pending Queue Cards (PRD 15.1-15.3) */}
        <button
          type="button"
          onClick={() => navigate('/admin/invoices?status=PENDING_APPROVAL')}
          className="text-left p-3.5 rounded-xl border border-purple-200/80 bg-purple-50/50 hover:bg-purple-50 transition-colors flex items-center justify-between gap-3"
        >
          <div>
            <p className="text-xs font-medium text-purple-800">Chờ duyệt điều chỉnh HĐ</p>
            <p className="text-xl font-bold text-slate-900 mt-0.5">
              {kpis.pending_invoice_adjustments || 0}
            </p>
            <p className="text-[11px] text-purple-700 mt-0.5">Duyệt 4 mắt HĐ →</p>
          </div>
          <FileText className="w-6 h-6 text-purple-600 shrink-0" />
        </button>

        <button
          type="button"
          onClick={() => navigate('/admin/payments?tab=credits&status=PENDING_DIRECT_REFUND')}
          className="text-left p-3.5 rounded-xl border border-indigo-200/80 bg-indigo-50/50 hover:bg-indigo-50 transition-colors flex items-center justify-between gap-3"
        >
          <div>
            <p className="text-xs font-medium text-indigo-800">Chờ duyệt hoàn tín dụng</p>
            <p className="text-xl font-bold text-slate-900 mt-0.5">
              {kpis.pending_credit_refunds || 0}
            </p>
            <p className="text-[11px] text-indigo-700 mt-0.5">Duyệt 4 mắt hoàn tiền →</p>
          </div>
          <Receipt className="w-6 h-6 text-indigo-600 shrink-0" />
        </button>

        <button
          type="button"
          onClick={() => navigate('/admin/deposits?tab=pending')}
          className="text-left p-3.5 rounded-xl border border-amber-200/80 bg-amber-50/50 hover:bg-amber-50 transition-colors flex items-center justify-between gap-3"
        >
          <div>
            <p className="text-xs font-medium text-amber-800">Chờ duyệt tất toán cọc</p>
            <p className="text-xl font-bold text-slate-900 mt-0.5">
              {kpis.pending_deposit_approvals || 0}
            </p>
            <p className="text-[11px] text-amber-700 mt-0.5">Duyệt Four-Eyes →</p>
          </div>
          <Clock className="w-6 h-6 text-amber-600 shrink-0" />
        </button>

        <button
          type="button"
          onClick={() => navigate('/admin/deposits?tab=payout')}
          className="text-left p-3.5 rounded-xl border border-sky-200/80 bg-sky-50/50 hover:bg-sky-50 transition-colors flex items-center justify-between gap-3"
        >
          <div>
            <p className="text-xs font-medium text-sky-800">Chờ chi hoàn / Trả lệnh</p>
            <p className="text-xl font-bold text-slate-900 mt-0.5">
              {kpis.pending_deposit_payouts || 0}
            </p>
            <p className="text-[11px] text-sky-700 mt-0.5">Phát hành UNC →</p>
          </div>
          <Wallet className="w-6 h-6 text-sky-600 shrink-0" />
        </button>

        <button
          type="button"
          onClick={() => navigate('/admin/deposits?overdue=1')}
          className="text-left p-3.5 rounded-xl border border-rose-200/80 bg-rose-50/50 hover:bg-rose-50 transition-colors flex items-center justify-between gap-3"
        >
          <div>
            <p className="text-xs font-medium text-rose-800">Quá hạn hoàn cọc (5 ngày)</p>
            <p className="text-xl font-bold text-rose-700 mt-0.5">
              {kpis.overdue_deposit_refunds || 0}
            </p>
            <p className="text-[11px] text-rose-700 mt-0.5">Xử lý khẩn FR-068 →</p>
          </div>
          <AlertCircle className="w-6 h-6 text-rose-600 shrink-0" />
        </button>

        <button
          type="button"
          onClick={() => navigate('/admin/deposits?status=DISPUTED')}
          className="text-left p-3.5 rounded-xl border border-purple-200/80 bg-purple-50/50 hover:bg-purple-50 transition-colors flex items-center justify-between gap-3"
        >
          <div>
            <p className="text-xs font-medium text-purple-800">Sổ cọc đang tranh chấp</p>
            <p className="text-xl font-bold text-slate-900 mt-0.5">
              {kpis.disputed_deposits || 0}
            </p>
            <p className="text-[11px] text-purple-700 mt-0.5">Giải quyết khiếu nại →</p>
          </div>
          <ShieldAlert className="w-6 h-6 text-purple-600 shrink-0" />
        </button>

        <button
          type="button"
          onClick={() => navigate('/admin/buildings/floor-plan?pending_confirm=1')}
          className="text-left p-3.5 rounded-xl border border-emerald-200/80 bg-emerald-50/50 hover:bg-emerald-50 transition-colors flex items-center justify-between gap-3"
        >
          <div>
            <p className="text-xs font-medium text-emerald-800">Giữ chỗ chờ sao kê</p>
            <p className="text-xl font-bold text-slate-900 mt-0.5">
              {kpis.pending_reservation_confirms || 0}
            </p>
            <p className="text-[11px] text-emerald-700 mt-0.5">Đối chiếu chuyển khoản →</p>
          </div>
          <CheckCircle2 className="w-6 h-6 text-emerald-600 shrink-0" />
        </button>
      </div>

      {/* Charts Row 1: Biểu đồ Doanh thu (Trend / Stacked Source) & Biểu đồ Công nợ Tuổi nợ (PRD 5 Buckets) */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <Card className="lg:col-span-7">
          <CardHeader
            title={`Biểu đồ doanh thu (${months} kỳ gần nhất)`}
            subtitle={
              revenueMode === 'trend'
                ? 'So sánh giá trị hóa đơn phát hành, tất toán và dòng tiền thực thu theo kỳ (AC-018)'
                : 'Cơ cấu doanh thu phát hành theo nguồn: Tiền phòng, Điện, Nước, Dịch vụ & Khác'
            }
            action={
              <div className="flex flex-wrap items-center gap-2">
                <div
                  role="group"
                  aria-label="Chế độ xem biểu đồ doanh thu"
                  className="inline-flex items-center rounded-lg border border-slate-200 bg-slate-50 p-0.5"
                >
                  <button
                    type="button"
                    onClick={() => setRevenueMode('trend')}
                    aria-pressed={revenueMode === 'trend'}
                    className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors ${
                      revenueMode === 'trend'
                        ? 'bg-white text-primary-700 shadow-xs'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    Xu hướng thu
                  </button>
                  <button
                    type="button"
                    onClick={() => setRevenueMode('source')}
                    aria-pressed={revenueMode === 'source'}
                    className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors ${
                      revenueMode === 'source'
                        ? 'bg-white text-primary-700 shadow-xs'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    Theo nguồn thu
                  </button>
                </div>
                <Button
                  variant="ghost"
                  size="xs"
                  rightIcon={ArrowRight}
                  onClick={() => navigate('/admin/reports')}
                >
                  Báo cáo
                </Button>
              </div>
            }
          />
          {!showRevenueChart ? (
            <EmptyState
              icon={BarChart3}
              title="Chưa phát sinh doanh thu trong giai đoạn này"
              description="Biểu đồ sẽ hiển thị ngay khi có hóa đơn phát hành hoặc giao dịch thanh toán được xác nhận."
              action={
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => navigate('/admin/invoices')}
                >
                  Quản lý hóa đơn
                </Button>
              }
            />
          ) : (
            <div className="h-72">
              {revenueMode === 'trend' ? (
                <Line
                  data={revenueTrendData}
                  options={{
                    responsive: true,
                    maintainAspectRatio: false,
                    interaction: { mode: 'index', intersect: false },
                    plugins: {
                      legend: {
                        position: 'top',
                        labels: { boxWidth: 12, font: { size: 11 } },
                      },
                      tooltip: {
                        callbacks: {
                          label: (ctx) =>
                            ` ${ctx.dataset.label}: ${formatMoney(ctx.parsed.y)}`,
                        },
                      },
                    },
                    scales: {
                      y: {
                        beginAtZero: true,
                        ticks: {
                          callback: (v) => formatCompactMoney(v),
                          font: { size: 11 },
                        },
                        grid: { color: '#f1f5f9' },
                      },
                      x: {
                        grid: { display: false },
                        ticks: { font: { size: 11 } },
                      },
                    },
                  }}
                />
              ) : (
                <Bar
                  data={revenueSourceData}
                  options={{
                    responsive: true,
                    maintainAspectRatio: false,
                    interaction: { mode: 'index', intersect: false },
                    plugins: {
                      legend: {
                        position: 'top',
                        labels: { boxWidth: 12, font: { size: 11 } },
                      },
                      tooltip: {
                        callbacks: {
                          label: (ctx) =>
                            ` ${ctx.dataset.label}: ${formatMoney(ctx.parsed.y)}`,
                          footer: (items) => {
                            const sum = items.reduce(
                              (acc, item) => acc + Number(item.parsed?.y || 0),
                              0
                            );
                            return `Tổng phát hành kỳ: ${formatMoney(sum)}`;
                          },
                        },
                      },
                    },
                    scales: {
                      x: {
                        stacked: true,
                        grid: { display: false },
                        ticks: { font: { size: 11 } },
                      },
                      y: {
                        stacked: true,
                        beginAtZero: true,
                        ticks: {
                          callback: (v) => formatCompactMoney(v),
                          font: { size: 11 },
                        },
                        grid: { color: '#f1f5f9' },
                      },
                    },
                  }}
                />
              )}
            </div>
          )}
        </Card>

        <Card className="lg:col-span-5 flex flex-col">
          <CardHeader
            title="Công nợ theo nhóm tuổi nợ"
            subtitle={`Quá hạn: ${formatMoney(agingInfo.overdue_debt || 0)} / Tổng: ${formatMoney(agingInfo.total_debt ?? kpis.unpaid_debt ?? 0)} · Bấm cột để lọc`}
            action={
              <Button
                variant="ghost"
                size="xs"
                rightIcon={ArrowRight}
                onClick={() => navigate('/admin/payments?tab=aging')}
              >
                Sổ công nợ
              </Button>
            }
          />
          {!showAgingChart ? (
            <div className="flex-1 flex items-center justify-center">
              <EmptyState
                icon={CheckCircle2}
                title="Không có công nợ tồn đọng"
                description="Toàn bộ khoản phải thu trong phạm vi hiện đã được thanh toán đầy đủ."
              />
            </div>
          ) : (
            <div className="h-72">
              <Bar
                data={agingChart.chartData}
                options={{
                  responsive: true,
                  maintainAspectRatio: false,
                  onClick: (_evt, elements) => {
                    if (elements && elements.length > 0) {
                      const idx = elements[0].index;
                      const bKey = agingChart.bucketKeys[idx];
                      if (bKey) {
                        navigate(`/admin/payments?tab=aging&bucket=${bKey}`);
                      }
                    }
                  },
                  onHover: (evt, elements) => {
                    if (evt?.native?.target) {
                      evt.native.target.style.cursor =
                        elements && elements.length > 0 ? 'pointer' : 'default';
                    }
                  },
                  plugins: {
                    legend: { display: false },
                    tooltip: {
                      callbacks: {
                        label: (ctx) => {
                          const cnt = agingChart.counts[ctx.dataIndex] || 0;
                          return ` Dư nợ: ${formatMoney(ctx.parsed.y)} (${cnt} khoản)`;
                        },
                      },
                    },
                  },
                  scales: {
                    y: {
                      beginAtZero: true,
                      ticks: {
                        callback: (v) => formatCompactMoney(v),
                        font: { size: 11 },
                      },
                      grid: { color: '#f1f5f9' },
                    },
                    x: {
                      grid: { display: false },
                      ticks: { font: { size: 11 } },
                    },
                  },
                }}
              />
            </div>
          )}
        </Card>
      </div>

      {/* Charts Row 2: Biểu đồ Lấp đầy theo kỳ (Line 0-100%) & Cơ cấu trạng thái căn hộ (Doughnut) */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <Card className="lg:col-span-8">
          <CardHeader
            title={`Xu hướng tỷ lệ lấp đầy (${months} kỳ gần nhất)`}
            subtitle="Tỷ lệ căn hộ có hợp đồng hiệu lực trên tổng số căn hộ đang khai thác (không tính căn hộ ngưng khai thác)"
            action={
              <Button
                variant="ghost"
                size="xs"
                rightIcon={ArrowRight}
                onClick={() => navigate('/admin/buildings')}
              >
                Danh mục căn hộ
              </Button>
            }
          />
          {!showOccupancyChart ? (
            <EmptyState
              icon={Building2}
              title="Chưa có căn hộ khai thác"
              description="Hãy khởi tạo tòa nhà và danh sách căn hộ để theo dõi tỷ lệ lấp đầy theo kỳ."
              action={
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => navigate('/admin/buildings')}
                >
                  Thiết lập tòa nhà
                </Button>
              }
            />
          ) : (
            <div className="h-64">
              <Line
                data={occupancyTrend.chartData}
                options={{
                  responsive: true,
                  maintainAspectRatio: false,
                  interaction: { mode: 'index', intersect: false },
                  plugins: {
                    legend: {
                      position: 'top',
                      labels: { boxWidth: 12, font: { size: 11 } },
                    },
                    tooltip: {
                      callbacks: {
                        label: (ctx) => {
                          const pt = occupancyTrend.metaPoints[ctx.dataIndex];
                          if (!pt) return ` Tỷ lệ lấp đầy: ${ctx.parsed.y}%`;
                          return ` Tỷ lệ lấp đầy: ${pt.occupancy_rate}% (${pt.occupied}/${pt.exploitable} căn đang khai thác)`;
                        },
                      },
                    },
                  },
                  scales: {
                    y: {
                      min: 0,
                      max: 100,
                      ticks: {
                        callback: (v) => `${v}%`,
                        font: { size: 11 },
                      },
                      grid: { color: '#f1f5f9' },
                    },
                    x: {
                      grid: { display: false },
                      ticks: { font: { size: 11 } },
                    },
                  },
                }}
              />
            </div>
          )}
        </Card>

        <Card className="lg:col-span-4 flex flex-col">
          <CardHeader
            title="Cơ cấu trạng thái căn hộ"
            subtitle={`Tổng số ${kpis.total_apartments || 0} căn hộ đang khai thác`}
          />
          {!showOccupancyChart ? (
            <div className="flex-1 flex items-center justify-center">
              <EmptyState
                icon={Building2}
                title="Chưa có căn hộ khai thác"
                description="Chưa có dữ liệu phân bổ trạng thái phòng."
              />
            </div>
          ) : (
            <div className="flex-1 flex items-center justify-center min-h-[240px]">
              <div className="w-56 h-56">
                <Doughnut
                  data={doughnutData}
                  options={{
                    responsive: true,
                    maintainAspectRatio: false,
                    cutout: '66%',
                    plugins: {
                      legend: {
                        position: 'bottom',
                        labels: { boxWidth: 10, font: { size: 11 } },
                      },
                    },
                  }}
                />
              </div>
            </div>
          )}
        </Card>
      </div>

      {/* Bottom Widgets */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Widget 3: Expiring Contracts */}
        <Card>
          <CardHeader
            title="Hợp đồng sắp hết hạn (45 ngày tới)"
            subtitle="Chủ động liên hệ cư dân để gia hạn hoặc chuẩn bị bàn giao phòng"
            action={
              <Button variant="ghost" size="xs" rightIcon={ArrowRight} onClick={() => navigate('/admin/contracts')}>
                Tất cả HĐ
              </Button>
            }
          />
          {expiringContracts.length === 0 ? (
            <div className="py-10 text-center text-xs text-slate-400">
              Không có hợp đồng nào sắp hết hạn trong 45 ngày tới.
            </div>
          ) : (
            <div className="divide-y divide-slate-100">
              {expiringContracts.map((c) => (
                <div
                  key={c.id}
                  onClick={() => navigate(`/admin/contracts/${c.id}`)}
                  className="py-3 flex items-center justify-between gap-3 hover:bg-slate-50 rounded-lg px-2 -mx-2 cursor-pointer transition-colors"
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-xs font-bold text-primary-700 bg-primary-50 px-2 py-0.5 rounded-md">
                        {c.building_name || c.building_code} · {c.apartment_code}
                      </span>
                      <span className="text-sm font-medium text-slate-800 break-words">{c.tenant_name}</span>
                      {c.tenant_phone ? (
                        <span className="text-xs font-mono text-slate-500">({c.tenant_phone})</span>
                      ) : null}
                    </div>
                    <p className="text-xs text-slate-500 mt-0.5">
                      Hết hạn: {formatDate(c.end_date)} · Giá thuê: {formatMoney(c.rent_amount)}
                    </p>
                  </div>
                  <span
                    className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold shrink-0 ${
                      c.days_left <= 7
                        ? 'bg-rose-50 text-rose-700'
                        : 'bg-amber-50 text-amber-700'
                    }`}
                  >
                    <CalendarClock className="w-3.5 h-3.5" />
                    Còn {c.days_left} ngày
                  </span>
                </div>
              ))}
            </div>
          )}
        </Card>

        {/* Widget 4: Recent Service Requests */}
        <Card>
          <CardHeader
            title="Yêu cầu báo hỏng mới nhất"
            subtitle="5 phản ánh kỹ thuật gần đây từ các tòa nhà"
            action={
              <Button variant="ghost" size="xs" rightIcon={ArrowRight} onClick={() => navigate('/admin/maintenance')}>
                Xử lý ngay
              </Button>
            }
          />
          {recentRequests.length === 0 ? (
            <div className="py-10 text-center text-xs text-slate-400">
              Chưa có yêu cầu báo hỏng nào.
            </div>
          ) : (
            <div className="divide-y divide-slate-100">
              {recentRequests.map((sr) => (
                <div
                  key={sr.id}
                  onClick={() => navigate('/admin/maintenance')}
                  className="py-3 flex items-center justify-between gap-3 hover:bg-slate-50 rounded-lg px-2 -mx-2 cursor-pointer transition-colors"
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-[11px] font-mono font-semibold text-slate-500">
                        #{sr.tracking_code}
                      </span>
                      <span className="text-xs font-semibold text-sky-700">
                        {sr.building_name || sr.building_code} · {sr.apartment_code}
                      </span>
                    </div>
                    <p className="text-sm font-medium text-slate-800 line-clamp-2 break-words mt-0.5" title={sr.title}>
                      {sr.title}
                    </p>
                    <p className="text-[11px] text-slate-400">{formatRelativeTime(sr.created_at)}</p>
                  </div>
                  <div className="flex flex-col items-end gap-1 shrink-0">
                    <StatusBadge status={sr.status} domain="service_request" />
                    <StatusBadge status={sr.priority} domain="priority" dot={false} />
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}

export default DashboardPage;
