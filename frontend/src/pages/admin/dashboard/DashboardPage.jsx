import React, { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  ArcElement,
  Title,
  Tooltip as ChartTooltip,
  Legend,
  Filler,
} from 'chart.js';
import { Line, Doughnut } from 'react-chartjs-2';
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
} from 'lucide-react';
import { PageHeader } from '../../../components/common/PageHeader';
import { StatsCard } from '../../../components/common/StatsCard';
import { StatusBadge } from '../../../components/common/StatusBadge';
import { Card, CardHeader } from '../../../components/ui/Card';
import { Button } from '../../../components/ui/Button';
import { PageSkeleton } from '../../../components/ui/Skeleton';
import { reportsService } from '../../../services/reports.service';
import { useAuthStore } from '../../../stores/authStore';
import { useToast } from '../../../hooks/useToast';
import { formatCompactMoney, formatMoney, formatDate, formatRelativeTime } from '../../../utils/format';
import { extractErrorMessage } from '../../../utils/validation';

ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
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

  const loadDashboard = useCallback(async () => {
    setLoading(true);
    try {
      const res = await reportsService.getDashboard(
        selectedBuildingId ? { building_id: selectedBuildingId } : {}
      );
      setData(res.data);
    } catch (err) {
      toast.error(extractErrorMessage(err, 'Không thể tải dữ liệu bảng điều khiển.'));
    } finally {
      setLoading(false);
    }
  }, [selectedBuildingId, toast]);

  useEffect(() => {
    loadDashboard();
  }, [loadDashboard]);

  if (loading && !data) {
    return <PageSkeleton />;
  }

  const kpis = data?.kpis || {};
  const breakdown = data?.apartment_status_breakdown || {};
  const rev12m = data?.revenue_12m || [];
  const expiringContracts = data?.expiring_contracts || [];
  const recentRequests = data?.recent_service_requests || [];

  const lineData = {
    labels: rev12m.map((r) => r.period || r.month),
    datasets: [
      {
        label: 'Phát hành (Billed)',
        data: rev12m.map((r) => Number(r.billed || 0)),
        borderColor: '#6366f1',
        borderDash: [5, 5],
        backgroundColor: 'transparent',
        tension: 0.35,
        pointRadius: 2,
      },
      {
        label: 'Tất toán hóa đơn (Invoice Settled)',
        data: rev12m.map((r) => Number(r.invoice_settled || 0)),
        borderColor: '#10b981',
        backgroundColor: 'transparent',
        tension: 0.35,
        pointRadius: 3,
      },
      {
        label: 'Thực thu ròng (Collected)',
        data: rev12m.map((r) => Number(r.collected || 0)),
        borderColor: '#0ea5e9',
        backgroundColor: 'rgba(14, 165, 233, 0.12)',
        fill: true,
        tension: 0.35,
        pointRadius: 3,
      },
    ],
  };

  const doughnutData = {
    labels: ['Đang thuê', 'Còn trống', 'Đã giữ chỗ', 'Đang bảo trì', 'Ngưng khai thác'],
    datasets: [
      {
        data: [
          breakdown.OCCUPIED || 0,
          breakdown.AVAILABLE || 0,
          breakdown.RESERVED || 0,
          breakdown.MAINTENANCE || 0,
          (breakdown.BLOCKED || 0) + (breakdown.INACTIVE || 0),
        ],
        backgroundColor: ['#f43f5e', '#10b981', '#f59e0b', '#64748b', '#a855f7'],
        borderWidth: 2,
        borderColor: '#ffffff',
      },
    ],
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Bảng điều khiển vận hành"
        subtitle={`Tổng hợp chỉ số kinh doanh & kỹ thuật theo thời gian thực (Kỳ ${kpis.current_period || ''})`}
        actions={
          <Button variant="outline" size="sm" icon={RefreshCw} onClick={loadDashboard} loading={loading}>
            Làm mới
          </Button>
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

      {/* Charts Row */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <Card className="lg:col-span-8">
          <CardHeader
            title="Xu hướng doanh thu 12 tháng gần nhất"
            subtitle="So sánh giá trị hóa đơn phát hành và dòng tiền thực thu theo kỳ (AC-018)"
            action={
              <Button variant="ghost" size="xs" rightIcon={ArrowRight} onClick={() => navigate('/admin/reports')}>
                Báo cáo chi tiết
              </Button>
            }
          />
          <div className="h-72">
            <Line
              data={lineData}
              options={{
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                  legend: { position: 'top', labels: { boxWidth: 12, font: { size: 11 } } },
                },
                scales: {
                  y: {
                    ticks: {
                      callback: (v) =>
                        v >= 1_000_000 ? `${Math.round(v / 1_000_000)}M` : v,
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
        </Card>

        <Card className="lg:col-span-4 flex flex-col">
          <CardHeader
            title="Cơ cấu trạng thái căn hộ"
            subtitle={`Tổng số ${kpis.total_apartments || 0} căn hộ trong phạm vi`}
          />
          <div className="flex-1 flex items-center justify-center min-h-[240px]">
            <div className="w-56 h-56">
              <Doughnut
                data={doughnutData}
                options={{
                  responsive: true,
                  maintainAspectRatio: false,
                  cutout: '66%',
                  plugins: {
                    legend: { position: 'bottom', labels: { boxWidth: 10, font: { size: 11 } } },
                  },
                }}
              />
            </div>
          </div>
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

