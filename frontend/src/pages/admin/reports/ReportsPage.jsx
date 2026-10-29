import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  BarElement,
  Title,
  Tooltip,
  Legend,
  Filler,
} from 'chart.js';
import { Line, Bar } from 'react-chartjs-2';
import {
  BarChart3,
  TrendingUp,
  Building2,
  Clock,
  Wrench,
  Download,
  RefreshCw,
  Star,
} from 'lucide-react';
import { Button } from '../../../components/ui/Button';
import { Badge } from '../../../components/ui/Badge';
import { Card, CardHeader } from '../../../components/ui/Card';
import { Tabs } from '../../../components/ui/Tabs';
import { PageHeader } from '../../../components/common/PageHeader';
import { StatsCard } from '../../../components/common/StatsCard';
import { DataTable } from '../../../components/common/DataTable';
import { EmptyState } from '../../../components/common/EmptyState';
import { reportsService } from '../../../services/reports.service';
import { useToast } from '../../../hooks/useToast';
import { useAuthStore } from '../../../stores/authStore';
import { SERVICE_REQUEST_CATEGORY } from '../../../constants/statuses';
import { formatMoney, formatCompactMoney, exportToCsv } from '../../../utils/format';
import { extractErrorMessage } from '../../../utils/validation';

ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  BarElement,
  Title,
  Tooltip,
  Legend,
  Filler
);

export function ReportsPage() {
  const toast = useToast();
  const selectedBuildingId = useAuthStore((s) => s.selectedBuildingId);

  const [activeTab, setActiveTab] = useState('revenue'); // revenue | occupancy | aging | sla
  const [revenueChartMode, setRevenueChartMode] = useState('line'); // 'line' | 'bar'
  const [loading, setLoading] = useState(true);
  const [reportData, setReportData] = useState({
    revenue_12m: [],
    occupancy_by_building: [],
    aging_by_building: [],
    sla_by_category: [],
  });

  const fetchSummary = useCallback(async () => {
    setLoading(true);
    try {
      const res = await reportsService.getSummary({
        building_id: selectedBuildingId || undefined,
      });
      setReportData(
        res.data || {
          revenue_12m: [],
          occupancy_by_building: [],
          aging_by_building: [],
          sla_by_category: [],
        }
      );
    } catch (err) {
      toast.error(extractErrorMessage(err, 'Không thể tải dữ liệu báo cáo thống kê.'));
    } finally {
      setLoading(false);
    }
  }, [selectedBuildingId, toast]);

  useEffect(() => {
    fetchSummary();
  }, [fetchSummary]);

  const overviewKpis = useMemo(() => {
    const rev = reportData.revenue_12m || [];
    const totalBilled12m = rev.reduce((s, r) => s + Number(r.billed || 0), 0);
    const totalCollected12m = rev.reduce((s, r) => s + Number(r.collected || 0), 0);
    const collectionRate =
      totalBilled12m > 0 ? Number(((totalCollected12m / totalBilled12m) * 100).toFixed(1)) : 0;

    const occ = reportData.occupancy_by_building || [];
    const totalApts = occ.reduce((s, b) => s + Number(b.total_apartments || 0), 0);
    const totalOcc = occ.reduce((s, b) => s + Number(b.occupied || 0), 0);
    const avgOccupancy = totalApts > 0 ? Number(((totalOcc / totalApts) * 100).toFixed(1)) : 0;

    const totalDebt = (reportData.aging_by_building || []).reduce(
      (s, b) => s + Number(b.total_debt || 0),
      0
    );

    return { totalBilled12m, totalCollected12m, collectionRate, avgOccupancy, totalOcc, totalApts, totalDebt };
  }, [reportData]);

  // --- Dữ liệu Biểu đồ Tab 1: Doanh thu 12 tháng ---
  const revenueChartData = useMemo(() => {
    const rows = reportData.revenue_12m || [];
    return {
      labels: rows.map((r) => r.period),
      datasets: [
        {
          label: 'Phát hành (VNĐ)',
          data: rows.map((r) => Number(r.billed || 0)),
          borderColor: '#0ea5e9',
          backgroundColor:
            revenueChartMode === 'line' ? 'rgba(14, 165, 233, 0.14)' : 'rgba(14, 165, 233, 0.85)',
          fill: revenueChartMode === 'line',
          tension: 0.35,
          borderRadius: 6,
        },
        {
          label: 'Thực thu (VNĐ)',
          data: rows.map((r) => Number(r.collected || 0)),
          borderColor: '#10b981',
          backgroundColor:
            revenueChartMode === 'line' ? 'rgba(16, 185, 129, 0.14)' : 'rgba(16, 185, 129, 0.85)',
          fill: revenueChartMode === 'line',
          tension: 0.35,
          borderRadius: 6,
        },
      ],
    };
  }, [reportData.revenue_12m, revenueChartMode]);

  const moneyChartOptions = useMemo(
    () => ({
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { position: 'top' },
        tooltip: {
          callbacks: {
            label: (ctx) => `${ctx.dataset.label}: ${formatMoney(ctx.parsed.y || 0)}`,
          },
        },
      },
      scales: {
        y: {
          beginAtZero: true,
          ticks: {
            callback: (val) => formatCompactMoney(val),
          },
        },
      },
    }),
    []
  );

  // --- Dữ liệu Biểu đồ Tab 2: Lấp đầy theo tòa ---
  const occupancyChartData = useMemo(() => {
    const rows = reportData.occupancy_by_building || [];
    return {
      labels: rows.map((r) => `${r.building_code} (${r.occupancy_rate}%)`),
      datasets: [
        {
          label: 'Đang thuê',
          data: rows.map((r) => Number(r.occupied || 0)),
          backgroundColor: '#10b981',
          borderRadius: 6,
        },
        {
          label: 'Còn trống',
          data: rows.map((r) => Number(r.available || 0)),
          backgroundColor: '#38bdf8',
          borderRadius: 6,
        },
        {
          label: 'Đã cọc / Bảo trì',
          data: rows.map((r) => Number(r.reserved || 0) + Number(r.maintenance || 0)),
          backgroundColor: '#f59e0b',
          borderRadius: 6,
        },
      ],
    };
  }, [reportData.occupancy_by_building]);

  // --- Dữ liệu Biểu đồ Tab 3: Tuổi nợ theo tòa ---
  const agingChartData = useMemo(() => {
    const rows = reportData.aging_by_building || [];
    return {
      labels: rows.map((r) => `${r.building_code} — ${r.building_name}`),
      datasets: [
        {
          label: '0 – 30 ngày',
          data: rows.map((r) => Number(r.bucket_0_30 || 0)),
          backgroundColor: '#38bdf8',
          borderRadius: 4,
        },
        {
          label: '31 – 60 ngày',
          data: rows.map((r) => Number(r.bucket_31_60 || 0)),
          backgroundColor: '#fbbf24',
          borderRadius: 4,
        },
        {
          label: '61 – 90 ngày',
          data: rows.map((r) => Number(r.bucket_61_90 || 0)),
          backgroundColor: '#f97316',
          borderRadius: 4,
        },
        {
          label: '> 90 ngày',
          data: rows.map((r) => Number(r.bucket_over_90 || 0)),
          backgroundColor: '#e11d48',
          borderRadius: 4,
        },
      ],
    };
  }, [reportData.aging_by_building]);

  // --- Dữ liệu Biểu đồ Tab 4: SLA Báo hỏng ---
  const slaChartData = useMemo(() => {
    const rows = reportData.sla_by_category || [];
    return {
      labels: rows.map((r) => SERVICE_REQUEST_CATEGORY[r.category] || r.category),
      datasets: [
        {
          label: 'Thời gian xử lý TB (giờ)',
          data: rows.map((r) => Number(r.avg_resolve_hours || 0)),
          backgroundColor: 'rgba(99, 102, 241, 0.85)',
          borderRadius: 6,
        },
      ],
    };
  }, [reportData.sla_by_category]);

  // --- Hàm Xuất CSV cho từng Tab ---
  const exportRevenueCsv = () => {
    exportToCsv(
      'bao-cao-doanh-thu-12-thang.csv',
      [
        { label: 'Kỳ (YYYY-MM)', key: 'period' },
        { label: 'Số lượng hóa đơn', key: 'invoice_count' },
        { label: 'Tổng phát hành (VNĐ)', key: 'billed' },
        { label: 'Thực thu (VNĐ)', key: 'collected' },
        {
          label: 'Tỷ lệ thu (%)',
          accessor: (r) =>
            r.billed > 0 ? Number(((r.collected / r.billed) * 100).toFixed(1)) : 0,
        },
        { label: 'Còn tồn đọng (VNĐ)', key: 'outstanding' },
      ],
      reportData.revenue_12m || []
    );
    toast.success('Đã xuất báo cáo doanh thu 12 tháng ra CSV.');
  };

  const exportOccupancyCsv = () => {
    exportToCsv(
      'bao-cao-ty-le-lap-day.csv',
      [
        { label: 'Mã tòa', key: 'building_code' },
        { label: 'Tên tòa nhà', key: 'building_name' },
        { label: 'Tổng căn khai thác', key: 'total_apartments' },
        { label: 'Đang thuê', key: 'occupied' },
        { label: 'Còn trống', key: 'available' },
        { label: 'Đã đặt cọc', key: 'reserved' },
        { label: 'Đang bảo trì', key: 'maintenance' },
        { label: 'Tỷ lệ lấp đầy (%)', key: 'occupancy_rate' },
      ],
      reportData.occupancy_by_building || []
    );
    toast.success('Đã xuất báo cáo tỷ lệ lấp đầy ra CSV.');
  };

  const exportAgingCsv = () => {
    exportToCsv(
      'bao-cao-tuoi-no-aging.csv',
      [
        { label: 'Mã tòa', key: 'building_code' },
        { label: 'Tên tòa nhà', key: 'building_name' },
        { label: '0 - 30 ngày (VNĐ)', key: 'bucket_0_30' },
        { label: '31 - 60 ngày (VNĐ)', key: 'bucket_31_60' },
        { label: '61 - 90 ngày (VNĐ)', key: 'bucket_61_90' },
        { label: '> 90 ngày (VNĐ)', key: 'bucket_over_90' },
        { label: 'Tổng dư nợ (VNĐ)', key: 'total_debt' },
      ],
      reportData.aging_by_building || []
    );
    toast.success('Đã xuất báo cáo tuổi nợ theo tòa nhà ra CSV.');
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Báo cáo & Phân tích Quản trị"
        subtitle="Tổng hợp chuyên sâu Doanh thu 12 tháng, Hiệu suất lấp đầy, Rủi ro tuổi nợ và Chất lượng SLA bảo trì."
        actions={
          <Button variant="outline" icon={RefreshCw} onClick={fetchSummary}>
            Làm mới số liệu
          </Button>
        }
      />

      {/* KPI Tổng quan */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatsCard
          title="Lũy kế phát hành (12T)"
          value={formatCompactMoney(overviewKpis.totalBilled12m)}
          subtext={formatMoney(overviewKpis.totalBilled12m)}
          icon={BarChart3}
          color="sky"
        />
        <StatsCard
          title="Lũy kế thực thu (12T)"
          value={formatCompactMoney(overviewKpis.totalCollected12m)}
          subtext={`Hiệu suất thu hồi đạt ${overviewKpis.collectionRate}%`}
          icon={TrendingUp}
          color="emerald"
        />
        <StatsCard
          title="Tỷ lệ lấp đầy trung bình"
          value={`${overviewKpis.avgOccupancy}%`}
          subtext={`${overviewKpis.totalOcc} / ${overviewKpis.totalApts} căn đang khai thác`}
          icon={Building2}
          color="indigo"
        />
        <StatsCard
          title="Tổng dư nợ hiện hành"
          value={formatCompactMoney(overviewKpis.totalDebt)}
          subtext={formatMoney(overviewKpis.totalDebt)}
          icon={Clock}
          color="rose"
        />
      </div>

      {/* 4 Tabs Báo cáo */}
      <Tabs
        activeTab={activeTab}
        onChange={setActiveTab}
        tabs={[
          { id: 'revenue', label: 'Doanh thu 12 tháng', icon: TrendingUp },
          { id: 'occupancy', label: 'Tỷ lệ lấp đầy', icon: Building2 },
          { id: 'aging', label: 'Báo cáo tuổi nợ', icon: Clock },
          { id: 'sla', label: 'SLA Báo hỏng', icon: Wrench },
        ]}
      />

      {/* TAB 1: DOANH THU 12 THÁNG */}
      {activeTab === 'revenue' ? (
        <div className="space-y-5">
          <Card>
            <CardHeader
              title="Biểu đồ Phát hành vs Thực thu (12 tháng gần nhất)"
              subtitle="So sánh giá trị hóa đơn phát hành hàng kỳ và dòng tiền thu thực tế."
              action={
                <>
                  <div className="inline-flex rounded-lg border border-slate-200 p-0.5 bg-slate-50">
                    <button
                      type="button"
                      onClick={() => setRevenueChartMode('line')}
                      className={`px-2.5 py-1 text-xs font-medium rounded-md ${
                        revenueChartMode === 'line'
                          ? 'bg-white text-primary-600 shadow-sm'
                          : 'text-slate-500'
                      }`}
                    >
                      Biểu đồ Đường
                    </button>
                    <button
                      type="button"
                      onClick={() => setRevenueChartMode('bar')}
                      className={`px-2.5 py-1 text-xs font-medium rounded-md ${
                        revenueChartMode === 'bar'
                          ? 'bg-white text-primary-600 shadow-sm'
                          : 'text-slate-500'
                      }`}
                    >
                      Biểu đồ Cột
                    </button>
                  </div>
                  <Button variant="outline" size="sm" icon={Download} onClick={exportRevenueCsv}>
                    Xuất CSV
                  </Button>
                </>
              }
            />
            <div className="h-80">
              {revenueChartMode === 'line' ? (
                <Line data={revenueChartData} options={moneyChartOptions} />
              ) : (
                <Bar data={revenueChartData} options={moneyChartOptions} />
              )}
            </div>
          </Card>

          <DataTable
            loading={loading}
            rowKey="period"
            pageSize={12}
            data={[...(reportData.revenue_12m || [])].reverse()}
            columns={[
              {
                key: 'period',
                label: 'Kỳ hạch toán',
                align: 'center',
                sortable: true,
                className: 'whitespace-nowrap',
                render: (r) => <span className="font-mono font-semibold text-slate-900">{r.period}</span>,
              },
              {
                key: 'invoice_count',
                label: 'Số hóa đơn',
                align: 'center',
                sortable: true,
                className: 'font-mono tabular-nums whitespace-nowrap',
              },
              {
                key: 'billed',
                label: 'Tổng phát hành',
                align: 'right',
                sortable: true,
                className: 'font-mono tabular-nums font-medium text-slate-900 whitespace-nowrap',
                render: (r) => formatMoney(r.billed),
              },
              {
                key: 'collected',
                label: 'Thực thu',
                align: 'right',
                sortable: true,
                className: 'font-mono tabular-nums font-semibold text-emerald-700 whitespace-nowrap',
                render: (r) => formatMoney(r.collected),
              },
              {
                key: 'rate',
                label: 'Tỷ lệ thu',
                align: 'center',
                render: (r) => {
                  const pct = r.billed > 0 ? Math.round((r.collected / r.billed) * 100) : 0;
                  return (
                    <Badge variant={pct >= 90 ? 'emerald' : pct >= 60 ? 'amber' : 'slate'}>
                      {pct}%
                    </Badge>
                  );
                },
              },
              {
                key: 'outstanding',
                label: 'Còn phải thu',
                align: 'right',
                sortable: true,
                className: 'font-mono tabular-nums text-rose-600 font-medium whitespace-nowrap',
                render: (r) => formatMoney(r.outstanding),
              },
            ]}
          />
        </div>
      ) : null}

      {/* TAB 2: TỶ LỆ LẤP ĐẦY */}
      {activeTab === 'occupancy' ? (
        <div className="space-y-5">
          <Card>
            <CardHeader
              title="Cơ cấu khai thác căn hộ theo từng tòa nhà"
              subtitle="Theo dõi tỷ lệ lấp đầy thực tế để tối ưu chính sách giá thuê và marketing."
              action={
                <Button variant="outline" size="sm" icon={Download} onClick={exportOccupancyCsv}>
                  Xuất CSV
                </Button>
              }
            />
            {(reportData.occupancy_by_building || []).length === 0 ? (
              <EmptyState title="Chưa có dữ liệu tòa nhà" />
            ) : (
              <div className="h-72">
                <Bar
                  data={occupancyChartData}
                  options={{
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: { legend: { position: 'top' } },
                    scales: {
                      x: { stacked: true },
                      y: { stacked: true, beginAtZero: true },
                    },
                  }}
                />
              </div>
            )}
          </Card>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {(reportData.occupancy_by_building || []).map((b) => {
              const rate = Number(b.occupancy_rate || 0);
              const barColor =
                rate >= 85 ? 'bg-emerald-500' : rate >= 60 ? 'bg-sky-500' : 'bg-amber-500';
              return (
                <Card key={b.building_id} className="space-y-3">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <span className="font-mono text-xs font-semibold text-primary-700 bg-primary-50 px-2 py-0.5 rounded">
                        {b.building_code}
                      </span>
                      <h4 className="text-base font-semibold text-slate-900 mt-1">
                        {b.building_name}
                      </h4>
                    </div>
                    <div className="text-right">
                      <span className="text-2xl font-bold text-slate-900">{rate}%</span>
                      <p className="text-[11px] text-slate-500">Tỷ lệ lấp đầy</p>
                    </div>
                  </div>

                  {/* Progress Bar trực quan */}
                  <div className="w-full h-3 rounded-full bg-slate-100 overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all duration-500 ${barColor}`}
                      style={{ width: `${Math.min(100, Math.max(0, rate))}%` }}
                    />
                  </div>

                  <div className="grid grid-cols-4 gap-2 pt-1 text-center text-xs">
                    <div className="p-2 rounded-lg bg-emerald-50 text-emerald-800">
                      <p className="font-bold text-sm">{b.occupied}</p>
                      <p className="text-[11px]">Đang thuê</p>
                    </div>
                    <div className="p-2 rounded-lg bg-sky-50 text-sky-800">
                      <p className="font-bold text-sm">{b.available}</p>
                      <p className="text-[11px]">Còn trống</p>
                    </div>
                    <div className="p-2 rounded-lg bg-amber-50 text-amber-800">
                      <p className="font-bold text-sm">{b.reserved}</p>
                      <p className="text-[11px]">Giữ chỗ</p>
                    </div>
                    <div className="p-2 rounded-lg bg-slate-100 text-slate-700">
                      <p className="font-bold text-sm">{b.maintenance}</p>
                      <p className="text-[11px]">Bảo trì</p>
                    </div>
                  </div>
                </Card>
              );
            })}
          </div>
        </div>
      ) : null}

      {/* TAB 3: BÁO CÁO TUỔI NỢ (AGING) */}
      {activeTab === 'aging' ? (
        <div className="space-y-5">
          <Card>
            <CardHeader
              title="Phân bổ tuổi nợ (Aging) theo từng tòa nhà"
              subtitle="Phân tầng công nợ quá hạn theo 4 ngưỡng rủi ro: 0–30, 31–60, 61–90 và trên 90 ngày."
              action={
                <Button variant="outline" size="sm" icon={Download} onClick={exportAgingCsv}>
                  Xuất CSV
                </Button>
              }
            />
            {(reportData.aging_by_building || []).length === 0 ? (
              <EmptyState
                icon={Clock}
                title="Không có công nợ tồn đọng"
                description="Hiện tại toàn bộ các tòa nhà trong phạm vi đều đã thu đủ công nợ."
              />
            ) : (
              <div className="h-72">
                <Bar
                  data={agingChartData}
                  options={{
                    ...moneyChartOptions,
                    scales: {
                      x: { stacked: true },
                      y: {
                        stacked: true,
                        beginAtZero: true,
                        ticks: { callback: (val) => formatCompactMoney(val) },
                      },
                    },
                  }}
                />
              </div>
            )}
          </Card>

          <DataTable
            loading={loading}
            rowKey="building_code"
            data={reportData.aging_by_building || []}
            emptyTitle="Không có công nợ quá hạn theo tòa nhà"
            columns={[
              {
                key: 'building_name',
                label: 'Tòa nhà',
                sortable: true,
                render: (r) => (
                  <div>
                    <p className="font-semibold text-slate-900">{r.building_name}</p>
                    <span className="font-mono text-xs text-slate-500">{r.building_code}</span>
                  </div>
                ),
              },
              {
                key: 'bucket_0_30',
                label: '0 – 30 ngày',
                className: 'text-right font-mono text-sky-700',
                headerClassName: 'text-right',
                render: (r) => formatMoney(r.bucket_0_30),
              },
              {
                key: 'bucket_31_60',
                label: '31 – 60 ngày',
                className: 'text-right font-mono text-amber-700',
                headerClassName: 'text-right',
                render: (r) => formatMoney(r.bucket_31_60),
              },
              {
                key: 'bucket_61_90',
                label: '61 – 90 ngày',
                className: 'text-right font-mono text-orange-700',
                headerClassName: 'text-right',
                render: (r) => formatMoney(r.bucket_61_90),
              },
              {
                key: 'bucket_over_90',
                label: '> 90 ngày',
                className: 'text-right font-mono text-rose-700 font-semibold',
                headerClassName: 'text-right',
                render: (r) => formatMoney(r.bucket_over_90),
              },
              {
                key: 'total_debt',
                label: 'Tổng dư nợ',
                sortable: true,
                className: 'text-right font-mono font-bold text-slate-900',
                headerClassName: 'text-right',
                render: (r) => formatMoney(r.total_debt),
              },
            ]}
          />
        </div>
      ) : null}

      {/* TAB 4: SLA BÁO HỎNG */}
      {activeTab === 'sla' ? (
        <div className="space-y-5">
          <Card>
            <CardHeader
              title="Thời gian xử lý sự cố trung bình theo hạng mục (giờ)"
              subtitle="Đánh giá tốc độ phản ứng kỹ thuật và mức độ hài lòng của cư dân."
            />
            {(reportData.sla_by_category || []).length === 0 ? (
              <EmptyState title="Chưa có dữ liệu yêu cầu bảo trì" />
            ) : (
              <div className="h-72">
                <Bar
                  data={slaChartData}
                  options={{
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: { legend: { position: 'top' } },
                    scales: {
                      y: {
                        beginAtZero: true,
                        ticks: { callback: (v) => `${v}h` },
                      },
                    },
                  }}
                />
              </div>
            )}
          </Card>

          <DataTable
            loading={loading}
            rowKey="category"
            data={reportData.sla_by_category || []}
            emptyTitle="Chưa có dữ liệu SLA bảo trì"
            columns={[
              {
                key: 'category',
                label: 'Hạng mục kỹ thuật',
                render: (r) => (
                  <span className="font-semibold text-slate-900">
                    {SERVICE_REQUEST_CATEGORY[r.category] || r.category}
                  </span>
                ),
              },
              {
                key: 'total_requests',
                label: 'Tổng yêu cầu',
                align: 'center',
                sortable: true,
                className: 'font-mono tabular-nums whitespace-nowrap',
              },
              {
                key: 'resolved_count',
                label: 'Đã hoàn thành',
                align: 'center',
                className: 'font-mono tabular-nums text-emerald-700 font-medium whitespace-nowrap',
              },
              {
                key: 'open_count',
                label: 'Đang mở',
                align: 'center',
                className: 'font-mono tabular-nums text-amber-700 whitespace-nowrap',
              },
              {
                key: 'avg_resolve_hours',
                label: 'Thời gian xử lý TB',
                align: 'center',
                sortable: true,
                render: (r) => {
                  if (r.avg_resolve_hours === null || r.avg_resolve_hours === undefined) {
                    return <span className="text-xs text-slate-400">Chưa có mẫu</span>;
                  }
                  const hrs = Number(r.avg_resolve_hours);
                  return (
                    <Badge variant={hrs <= 24 ? 'emerald' : 'amber'}>
                      {hrs} giờ
                    </Badge>
                  );
                },
              },
              {
                key: 'avg_rating',
                label: 'Điểm đánh giá TB',
                align: 'center',
                sortable: true,
                render: (r) =>
                  r.avg_rating ? (
                    <span className="inline-flex items-center gap-1 font-semibold text-amber-600 whitespace-nowrap">
                      <Star className="w-3.5 h-3.5 fill-amber-400 text-amber-400" />
                      {Number(r.avg_rating).toFixed(2)} / 5.00
                    </span>
                  ) : (
                    <span className="text-xs text-slate-400">Chưa có đánh giá</span>
                  ),
              },
            ]}
          />
        </div>
      ) : null}
    </div>
  );
}

export default ReportsPage;
