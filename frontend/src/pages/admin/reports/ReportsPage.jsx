import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
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
  Wallet,
  FileSpreadsheet,
  ScrollText,
  AlertTriangle,
} from 'lucide-react';
import { Button } from '../../../components/ui/Button';
import { Input } from '../../../components/ui/Input';
import { Select } from '../../../components/ui/Select';
import { Modal } from '../../../components/ui/Modal';
import { Badge } from '../../../components/ui/Badge';
import { Card, CardHeader } from '../../../components/ui/Card';
import { Tabs } from '../../../components/ui/Tabs';
import { PageHeader } from '../../../components/common/PageHeader';
import { StatsCard } from '../../../components/common/StatsCard';
import { StatusBadge } from '../../../components/common/StatusBadge';
import { DataTable } from '../../../components/common/DataTable';
import { EmptyState } from '../../../components/common/EmptyState';
import { reportsService } from '../../../services/reports.service';
import { useToast } from '../../../hooks/useToast';
import { useAuthStore } from '../../../stores/authStore';
import { SERVICE_REQUEST_CATEGORY, DEPOSIT_STATUS } from '../../../constants/statuses';
import { formatMoney, formatCompactMoney, formatDate, exportToCsv } from '../../../utils/format';
import { buildReportsBuildingAgingChartData } from '../../../utils/chartHelpers';
import { extractErrorMessage } from '../../../utils/validation';
import { stripNotificationTriggerParams } from '../../../utils/notificationNavigation';
import { AuditLogsView } from '../audit/AuditLogsPage';

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

const VALID_REPORT_TABS = ['revenue', 'occupancy', 'aging', 'deposit-ledger', 'financial-audit', 'sla'];

function getDefaultPeriodRange() {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  return {
    from_date: `${yyyy}-${mm}-01`,
    to_date: `${yyyy}-${mm}-${dd}`,
  };
}

const DEPOSIT_STATUS_FILTER_OPTIONS = [
  { value: '', label: 'Tất cả trạng thái sổ cọc' },
  ...Object.entries(DEPOSIT_STATUS).map(([value, meta]) => ({
    value,
    label: meta.label,
  })),
];

export function ReportsPage() {
  const toast = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedBuildingId = useAuthStore((s) => s.selectedBuildingId);

  const defaultRange = useMemo(() => getDefaultPeriodRange(), []);
  const initialTab = VALID_REPORT_TABS.includes(searchParams.get('tab'))
    ? searchParams.get('tab')
    : 'revenue';

  const [activeTab, setActiveTab] = useState(initialTab);
  const [revenueChartMode, setRevenueChartMode] = useState('line'); // 'line' | 'bar'
  const [loading, setLoading] = useState(true);
  const [reportData, setReportData] = useState({
    revenue_12m: [],
    occupancy_by_building: [],
    aging_by_building: [],
    sla_by_category: [],
  });

  // RP-07 — Sổ cọc state
  const [ledgerFromDate, setLedgerFromDate] = useState(
    () => searchParams.get('from_date') || defaultRange.from_date
  );
  const [ledgerToDate, setLedgerToDate] = useState(
    () => searchParams.get('to_date') || defaultRange.to_date
  );
  const [ledgerStatus, setLedgerStatus] = useState(() => searchParams.get('status') || '');
  const [ledgerLoading, setLedgerLoading] = useState(false);
  const [exportingLedgerFormat, setExportingLedgerFormat] = useState('');
  const [depositSummaryModalOpen, setDepositSummaryModalOpen] = useState(false);
  const [exportingSummarySection, setExportingSummarySection] = useState('');
  const [ledgerFetchedRange, setLedgerFetchedRange] = useState({ from: null, to: null });
  const [ledgerData, setLedgerData] = useState({
    period: { from_date: defaultRange.from_date, to_date: defaultRange.to_date },
    summary: {
      opening_held: 0,
      collected: 0,
      transfer_in: 0,
      refund_reversed: 0,
      deducted: 0,
      refunded: 0,
      transfer_out: 0,
      closing_held: 0,
      disputed_count: 0,
      disputed_amount: 0,
      pending_payout_count: 0,
      pending_payout_amount: 0,
      returned_count: 0,
      returned_amount: 0,
      overdue_count: 0,
    },
    reservation_summary: {
      active_held_count: 0,
      active_held_amount: 0,
      pending_confirm_count: 0,
      pending_confirm_amount: 0,
      refunded_in_period: 0,
      forfeited_in_period: 0,
    },
    items: [],
  });

  useEffect(() => {
    const tabParam = searchParams.get('tab');
    if (tabParam && VALID_REPORT_TABS.includes(tabParam)) {
      setActiveTab((prev) => (prev === tabParam ? prev : tabParam));
    }
    const fromParam = searchParams.get('from_date');
    const toParam = searchParams.get('to_date');
    if (fromParam) {
      setLedgerFromDate((prev) => (prev === fromParam ? prev : fromParam));
    }
    if (toParam) {
      setLedgerToDate((prev) => (prev === toParam ? prev : toParam));
    }
  }, [searchParams]);

  useEffect(() => {
    const modal = searchParams.get('modal');
    const expectedFrom = searchParams.get('from_date') || ledgerFromDate;
    const expectedTo = searchParams.get('to_date') || ledgerToDate;
    if (
      modal === 'summary' &&
      activeTab === 'deposit-ledger' &&
      !ledgerLoading &&
      ledgerFetchedRange.from === expectedFrom &&
      ledgerFetchedRange.to === expectedTo
    ) {
      setSearchParams((prev) => stripNotificationTriggerParams(prev), { replace: true });
      setDepositSummaryModalOpen(true);
    }
  }, [
    searchParams,
    setSearchParams,
    activeTab,
    ledgerLoading,
    ledgerFetchedRange,
    ledgerFromDate,
    ledgerToDate,
  ]);

  const handleTabChange = (nextTab) => {
    setActiveTab(nextTab);
    const nextParams = new URLSearchParams(searchParams);
    if (nextTab === 'revenue') {
      nextParams.delete('tab');
    } else {
      nextParams.set('tab', nextTab);
    }
    setSearchParams(nextParams, { replace: true });
  };

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

  const fetchDepositLedger = useCallback(async () => {
    if (ledgerFromDate && ledgerToDate && ledgerFromDate > ledgerToDate) {
      toast.warning('Ngày bắt đầu kỳ sổ cọc không được lớn hơn ngày kết thúc.');
      return;
    }
    setLedgerLoading(true);
    try {
      const res = await reportsService.getDepositLedger({
        building_id: selectedBuildingId || undefined,
        from_date: ledgerFromDate || undefined,
        to_date: ledgerToDate || undefined,
        status: ledgerStatus || undefined,
      });
      if (res?.data) {
        setLedgerData(res.data);
      }
    } catch (err) {
      toast.error(extractErrorMessage(err, 'Không thể tải Báo cáo Sổ cọc (RP-07).'));
    } finally {
      setLedgerFetchedRange({ from: ledgerFromDate, to: ledgerToDate });
      setLedgerLoading(false);
    }
  }, [selectedBuildingId, ledgerFromDate, ledgerToDate, ledgerStatus, toast]);

  useEffect(() => {
    fetchSummary();
  }, [fetchSummary]);

  useEffect(() => {
    if (activeTab === 'deposit-ledger') {
      fetchDepositLedger();
    }
  }, [activeTab, fetchDepositLedger]);

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

  // --- Dữ liệu Biểu đồ Tab 3: Tuổi nợ theo tòa (5 nhóm chuẩn PRD AC-016.1) ---
  const agingChartData = useMemo(
    () => buildReportsBuildingAgingChartData(reportData.aging_by_building || []),
    [reportData.aging_by_building]
  );

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

  const handleExportRevenue = async (format = 'xlsx') => {
    setExportingSummarySection(`revenue-${format}`);
    try {
      const params = {
        section: 'revenue',
        ...(selectedBuildingId ? { building_id: selectedBuildingId } : {}),
      };
      const blob =
        format === 'xlsx'
          ? await reportsService.exportSummaryXlsx(params)
          : await reportsService.exportSummaryCsv(params);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `bao-cao-doanh-thu-rp01-${new Date().toISOString().slice(0, 10)}.${format}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast.success(`Đã xuất báo cáo doanh thu (${format.toUpperCase()}).`);
    } catch {
      exportRevenueCsv();
    } finally {
      setExportingSummarySection('');
    }
  };

  const handleExportAging = async (format = 'xlsx') => {
    setExportingSummarySection(`aging-${format}`);
    try {
      const params = {
        section: 'aging',
        ...(selectedBuildingId ? { building_id: selectedBuildingId } : {}),
      };
      const blob =
        format === 'xlsx'
          ? await reportsService.exportSummaryXlsx(params)
          : await reportsService.exportSummaryCsv(params);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `bao-cao-tuoi-no-rp02-${new Date().toISOString().slice(0, 10)}.${format}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast.success(`Đã xuất báo cáo tuổi nợ (${format.toUpperCase()}).`);
    } catch {
      exportAgingCsv();
    } finally {
      setExportingSummarySection('');
    }
  };

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
        { label: 'Chưa đến hạn (VNĐ)', key: 'current_not_due' },
        { label: '1 - 15 ngày (VNĐ)', key: 'bucket_0_15' },
        { label: '16 - 30 ngày (VNĐ)', key: 'bucket_16_30' },
        { label: '31 - 60 ngày (VNĐ)', key: 'bucket_31_60' },
        { label: '> 60 ngày (VNĐ)', key: 'bucket_over_60' },
        { label: 'Tổng dư nợ (VNĐ)', key: 'total_debt' },
      ],
      reportData.aging_by_building || []
    );
    toast.success('Đã xuất báo cáo tuổi nợ theo tòa nhà ra CSV.');
  };

  const handleExportDepositLedger = async (fmt) => {
    if (ledgerFromDate && ledgerToDate && ledgerFromDate > ledgerToDate) {
      toast.warning('Ngày bắt đầu kỳ sổ cọc không được lớn hơn ngày kết thúc.');
      return;
    }
    setExportingLedgerFormat(fmt);
    try {
      const params = {
        building_id: selectedBuildingId || undefined,
        from_date: ledgerFromDate || undefined,
        to_date: ledgerToDate || undefined,
        status: ledgerStatus || undefined,
      };
      const blob =
        fmt === 'xlsx'
          ? await reportsService.exportDepositLedgerXlsx(params)
          : await reportsService.exportDepositLedgerCsv(params);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `so-coc-rp07-${ledgerFromDate || 'ky'}-${ledgerToDate || 'nay'}.${fmt}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast.success(
        fmt === 'xlsx'
          ? 'Đã xuất Báo cáo Sổ cọc (RP-07) ra tệp Excel (.xlsx).'
          : 'Đã xuất Báo cáo Sổ cọc (RP-07) ra tệp CSV (UTF-8 BOM).'
      );
    } catch (err) {
      toast.error(extractErrorMessage(err, 'Không thể xuất tệp Báo cáo Sổ cọc (RP-07).'));
    } finally {
      setExportingLedgerFormat('');
    }
  };

  const handleRefreshAll = () => {
    fetchSummary();
    if (activeTab === 'deposit-ledger') {
      fetchDepositLedger();
    }
  };

  const ledgerSummary = ledgerData.summary || {};
  const ledgerRsv = ledgerData.reservation_summary || {};

  return (
    <div className="space-y-6">
      <PageHeader
        title="Báo cáo & Phân tích Quản trị"
        subtitle="Tổng hợp chuyên sâu Doanh thu 12 tháng, Hiệu suất lấp đầy, Rủi ro tuổi nợ, Sổ cọc RP-07 và Chất lượng SLA bảo trì."
        actions={
          <Button variant="outline" icon={RefreshCw} onClick={handleRefreshAll}>
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
          valueTitle={formatMoney(overviewKpis.totalCollected12m)}
          subtext={`${formatMoney(overviewKpis.totalCollected12m)} • Thu hồi ${overviewKpis.collectionRate}%`}
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

      {/* 5 Tabs Báo cáo */}
      <Tabs
        activeTab={activeTab}
        onChange={handleTabChange}
        tabs={[
          { id: 'revenue', label: 'Doanh thu 12 tháng (RP-01)', icon: TrendingUp },
          { id: 'occupancy', label: 'Tỷ lệ lấp đầy', icon: Building2 },
          { id: 'aging', label: 'Báo cáo tuổi nợ (RP-02)', icon: Clock },
          { id: 'deposit-ledger', label: 'Sổ cọc (RP-07)', icon: Wallet },
          { id: 'financial-audit', label: 'Nhật ký tài chính (RP-08)', icon: ScrollText },
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
                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      icon={FileSpreadsheet}
                      loading={exportingSummarySection === 'revenue-xlsx'}
                      onClick={() => handleExportRevenue('xlsx')}
                      className="text-emerald-700 hover:bg-emerald-50 border-emerald-300"
                    >
                      Xuất Excel (.xlsx)
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      icon={Download}
                      loading={exportingSummarySection === 'revenue-csv'}
                      onClick={() => handleExportRevenue('csv')}
                    >
                      Xuất CSV
                    </Button>
                  </div>
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
                key: 'invoice_settled',
                label: 'Tất toán HĐ',
                sortable: true,
                className: 'text-right font-mono tabular-nums whitespace-nowrap text-emerald-700 font-medium',
                headerClassName: 'text-right whitespace-nowrap',
                render: (r) => formatMoney(r.invoice_settled || 0),
              },
              {
                key: 'collected',
                label: 'Thực thu ròng',
                sortable: true,
                className: 'text-right font-mono tabular-nums whitespace-nowrap text-sky-700 font-semibold',
                headerClassName: 'text-right whitespace-nowrap',
                render: (r) => formatMoney(r.collected || 0),
              },
              {
                key: 'credit_refunded',
                label: 'Hoàn tín dụng',
                sortable: true,
                className: 'text-right font-mono tabular-nums whitespace-nowrap text-pink-700',
                headerClassName: 'text-right whitespace-nowrap',
                render: (r) => formatMoney(r.credit_refunded || 0),
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
              subtitle="Phân tầng công nợ theo 5 nhóm tuổi nợ chuẩn PRD: Chưa đến hạn, 1–15, 16–30, 31–60 và trên 60 ngày."
              action={
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    icon={FileSpreadsheet}
                    loading={exportingSummarySection === 'aging-xlsx'}
                    onClick={() => handleExportAging('xlsx')}
                    className="text-emerald-700 hover:bg-emerald-50 border-emerald-300"
                  >
                    Xuất Excel (.xlsx)
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    icon={Download}
                    loading={exportingSummarySection === 'aging-csv'}
                    onClick={() => handleExportAging('csv')}
                  >
                    Xuất CSV
                  </Button>
                </div>
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
                    <p className="font-semibold text-slate-900 break-words">{r.building_name}</p>
                    <span className="font-mono text-xs text-slate-500">{r.building_code}</span>
                  </div>
                ),
              },
              {
                key: 'current_not_due',
                label: 'Chưa đến hạn',
                className: 'text-right font-mono tabular-nums whitespace-nowrap text-slate-600',
                headerClassName: 'text-right whitespace-nowrap',
                render: (r) => formatMoney(r.current_not_due || 0),
              },
              {
                key: 'bucket_0_15',
                label: '1 – 15 ngày',
                className: 'text-right font-mono tabular-nums whitespace-nowrap text-emerald-700',
                headerClassName: 'text-right whitespace-nowrap',
                render: (r) => formatMoney(r.bucket_0_15 || 0),
              },
              {
                key: 'bucket_16_30',
                label: '16 – 30 ngày',
                className: 'text-right font-mono tabular-nums whitespace-nowrap text-amber-700',
                headerClassName: 'text-right whitespace-nowrap',
                render: (r) => formatMoney(r.bucket_16_30 || 0),
              },
              {
                key: 'bucket_31_60',
                label: '31 – 60 ngày',
                className: 'text-right font-mono tabular-nums whitespace-nowrap text-orange-700',
                headerClassName: 'text-right whitespace-nowrap',
                render: (r) => formatMoney(r.bucket_31_60 || 0),
              },
              {
                key: 'bucket_over_60',
                label: '> 60 ngày',
                className: 'text-right font-mono tabular-nums whitespace-nowrap text-rose-700 font-semibold',
                headerClassName: 'text-right whitespace-nowrap',
                render: (r) => formatMoney(r.bucket_over_60 || 0),
              },
              {
                key: 'total_debt',
                label: 'Tổng dư nợ',
                sortable: true,
                className: 'text-right font-mono tabular-nums whitespace-nowrap font-bold text-slate-900',
                headerClassName: 'text-right whitespace-nowrap',
                render: (r) => formatMoney(r.total_debt),
              },
            ]}
          />
        </div>
      ) : null}

      {/* TAB 4: SỔ CỌC RP-07 */}
      {activeTab === 'deposit-ledger' ? (
        <div className="space-y-5">
          {/* Bộ lọc kỳ & Xuất Excel / CSV */}
          <Card className="p-4">
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 flex-1 min-w-[280px]">
                <Input
                  type="date"
                  label="Từ ngày"
                  value={ledgerFromDate}
                  onChange={(e) => setLedgerFromDate(e.target.value)}
                />
                <Input
                  type="date"
                  label="Đến ngày"
                  value={ledgerToDate}
                  onChange={(e) => setLedgerToDate(e.target.value)}
                />
                <Select
                  label="Trạng thái sổ cọc"
                  value={ledgerStatus}
                  onChange={(e) => setLedgerStatus(e.target.value)}
                  options={DEPOSIT_STATUS_FILTER_OPTIONS}
                />
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="primary"
                  size="sm"
                  icon={FileSpreadsheet}
                  loading={exportingLedgerFormat === 'xlsx'}
                  onClick={() => handleExportDepositLedger('xlsx')}
                >
                  Xuất Excel (.xlsx)
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  icon={Download}
                  loading={exportingLedgerFormat === 'csv'}
                  onClick={() => handleExportDepositLedger('csv')}
                >
                  Xuất CSV
                </Button>
              </div>
            </div>
          </Card>

          {/* 6 Thẻ Cân đối Sổ cái Tiền cọc Hợp đồng */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-3">
            <div className="p-3.5 rounded-xl border border-slate-200 bg-white">
              <p className="text-xs font-medium text-slate-500">Đầu kỳ đang giữ</p>
              <p className="text-base font-bold font-mono tabular-nums text-slate-900 mt-1">
                {formatMoney(ledgerSummary.opening_held || 0)}
              </p>
              <p className="text-[11px] text-slate-400 mt-0.5">Số dư mở sổ</p>
            </div>

            <div className="p-3.5 rounded-xl border border-emerald-200/80 bg-emerald-50/40">
              <p className="text-xs font-medium text-emerald-800">Thu mới + Nhận KC</p>
              <p className="text-base font-bold font-mono tabular-nums text-emerald-700 mt-1">
                +{formatMoney((ledgerSummary.collected || 0) + (ledgerSummary.transfer_in || 0))}
              </p>
              <p className="text-[11px] text-emerald-700/80 mt-0.5">
                Thu: {formatCompactMoney(ledgerSummary.collected || 0)} • KC đến:{' '}
                {formatCompactMoney(ledgerSummary.transfer_in || 0)}
                {Number(ledgerSummary.refund_reversed || 0) > 0
                  ? ` • Trả lệnh: +${formatCompactMoney(ledgerSummary.refund_reversed)}`
                  : ''}
              </p>
            </div>

            <div className="p-3.5 rounded-xl border border-amber-200/80 bg-amber-50/40">
              <p className="text-xs font-medium text-amber-800">Đã khấu trừ cọc</p>
              <p className="text-base font-bold font-mono tabular-nums text-amber-700 mt-1">
                -{formatMoney(ledgerSummary.deducted || 0)}
              </p>
              <p className="text-[11px] text-amber-700/80 mt-0.5">Hư hỏng / Nợ dịch vụ</p>
            </div>

            <div className="p-3.5 rounded-xl border border-indigo-200/80 bg-indigo-50/40">
              <p className="text-xs font-medium text-indigo-800">Hoàn chi + KC đi</p>
              <p className="text-base font-bold font-mono tabular-nums text-indigo-700 mt-1">
                -{formatMoney((ledgerSummary.refunded || 0) + (ledgerSummary.transfer_out || 0))}
              </p>
              <p className="text-[11px] text-indigo-700/80 mt-0.5">
                Hoàn: {formatCompactMoney(ledgerSummary.refunded || 0)} • KC đi:{' '}
                {formatCompactMoney(ledgerSummary.transfer_out || 0)}
              </p>
            </div>

            <div className="p-3.5 rounded-xl border border-sky-300 bg-sky-50/70">
              <p className="text-xs font-semibold text-sky-900">Cuối kỳ đang giữ</p>
              <p className="text-base font-bold font-mono tabular-nums text-sky-900 mt-1">
                {formatMoney(ledgerSummary.closing_held || 0)}
              </p>
              <p className="text-[11px] text-sky-700 mt-0.5">Khớp cân đối sổ cái</p>
            </div>

            <div className="p-3.5 rounded-xl border border-rose-200/80 bg-rose-50/40">
              <p className="text-xs font-medium text-rose-800 flex items-center gap-1">
                <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                Cảnh báo tồn đọng
              </p>
              <p className="text-sm font-bold text-slate-900 mt-1">
                {(ledgerSummary.pending_payout_count || 0) + (ledgerSummary.returned_count || 0)} chờ chi •{' '}
                {ledgerSummary.overdue_count || 0} quá hạn
              </p>
              <p className="text-[11px] text-rose-700 mt-0.5">
                Tranh chấp: {ledgerSummary.disputed_count || 0} sổ (
                {formatCompactMoney(ledgerSummary.disputed_amount || 0)})
              </p>
            </div>
          </div>

          {/* Khối Đối soát Tiền Giữ chỗ Tách biệt (HELD vs APPROVED_PENDING_PAYOUT vs PENDING_CONFIRM) */}
          <Card>
            <CardHeader
              title="Đối soát Tiền đặt giữ chỗ ngoài Hợp đồng"
              subtitle="Bảo toàn 100% số dư VND: tách biệt tiền đang giữ chỗ (HELD / chờ duyệt hủy), tiền đã duyệt chờ BQL chi hoàn (APPROVED_PENDING_PAYOUT) và phiếu chờ xác nhận sao kê (PENDING_CONFIRM)."
            />
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
              <div className="p-3 rounded-lg bg-emerald-50/60 border border-emerald-200/70">
                <p className="text-xs text-emerald-800 font-medium">
                  Đang giữ chỗ đã xác nhận (HELD)
                </p>
                <p className="text-lg font-bold font-mono tabular-nums text-emerald-900 mt-0.5">
                  {formatMoney(ledgerRsv.active_held_amount || 0)}
                </p>
                <p className="text-[11px] text-emerald-700">
                  {ledgerRsv.active_held_count || 0} phiếu đang khóa phòng
                </p>
              </div>

              <div className="p-3 rounded-lg bg-indigo-50/60 border border-indigo-200/70">
                <p className="text-xs text-indigo-800 font-medium">
                  Đã duyệt chờ chi hoàn
                </p>
                <p className="text-lg font-bold font-mono tabular-nums text-indigo-900 mt-0.5">
                  {formatMoney(ledgerRsv.pending_payout_amount || 0)}
                </p>
                <p className="text-[11px] text-indigo-700">
                  {ledgerRsv.pending_payout_count || 0} phiếu chờ BQL chi &amp; tải UNC
                </p>
              </div>

              <div className="p-3 rounded-lg bg-amber-50/60 border border-amber-200/70">
                <p className="text-xs text-amber-800 font-medium">
                  Chờ đối chiếu sao kê (PENDING_CONFIRM)
                </p>
                <p className="text-lg font-bold font-mono tabular-nums text-amber-900 mt-0.5">
                  {formatMoney(ledgerRsv.pending_confirm_amount || 0)}
                </p>
                <p className="text-[11px] text-amber-700">
                  {ledgerRsv.pending_confirm_count || 0} phiếu chưa hạch toán thực thu
                </p>
              </div>

              <div className="p-3 rounded-lg bg-sky-50/60 border border-sky-200/70">
                <p className="text-xs text-sky-800 font-medium">Hoàn trả giữ chỗ trong kỳ</p>
                <p className="text-lg font-bold font-mono tabular-nums text-sky-900 mt-0.5">
                  {formatMoney(ledgerRsv.refunded_in_period || 0)}
                </p>
                <p className="text-[11px] text-sky-700">Phiếu REFUNDED / PARTIALLY_REFUNDED</p>
              </div>

              <div className="p-3 rounded-lg bg-rose-50/60 border border-rose-200/70">
                <p className="text-xs text-rose-800 font-medium">Tịch thu giữ chỗ trong kỳ</p>
                <p className="text-lg font-bold font-mono tabular-nums text-rose-900 mt-0.5">
                  {formatMoney(ledgerRsv.forfeited_in_period || 0)}
                </p>
                <p className="text-[11px] text-rose-700">Doanh thu phạt hủy giữ chỗ</p>
              </div>
            </div>
          </Card>

          {/* Bảng Chi tiết Sổ cọc RP-07 */}
          <DataTable
            loading={ledgerLoading}
            rowKey="deposit_id"
            pageSize={15}
            data={ledgerData.items || []}
            emptyTitle="Không có sổ cọc nào trong phạm vi lọc"
            columns={[
              {
                key: 'apartment_code',
                label: 'Căn hộ / Tòa',
                sortable: true,
                render: (r) => (
                  <div>
                    <p className="font-semibold text-slate-900">{r.apartment_code}</p>
                    <span className="text-xs font-mono text-slate-500">{r.building_code}</span>
                  </div>
                ),
              },
              {
                key: 'tenant_name',
                label: 'Khách thuê',
                sortable: true,
                render: (r) => (
                  <div>
                    <p className="font-medium text-slate-800">{r.tenant_name || '—'}</p>
                    {r.tenant_phone ? (
                      <p className="text-xs font-mono text-slate-500">{r.tenant_phone}</p>
                    ) : null}
                  </div>
                ),
              },
              {
                key: 'deposit_status',
                label: 'Trạng thái sổ',
                align: 'center',
                render: (r) => <StatusBadge status={r.deposit_status} domain="deposit" />,
              },
              {
                key: 'opening_held',
                label: 'Đầu kỳ',
                align: 'right',
                sortable: true,
                className: 'font-mono tabular-nums whitespace-nowrap text-slate-700',
                render: (r) => formatMoney(r.opening_held || 0),
              },
              {
                key: 'collected',
                label: 'Thu mới / KC đến',
                align: 'right',
                className: 'font-mono tabular-nums whitespace-nowrap text-emerald-700',
                render: (r) => {
                  const totalIn =
                    Number(r.collected || 0) +
                    Number(r.transfer_in || 0) +
                    Number(r.refund_reversed || 0);
                  return (
                    <div>
                      <p className="font-semibold">+{formatMoney(totalIn)}</p>
                      {Number(r.transfer_in || 0) > 0 ? (
                        <p className="text-[10px] text-slate-500">
                          KC đến: {formatCompactMoney(r.transfer_in)}
                        </p>
                      ) : null}
                      {Number(r.refund_reversed || 0) > 0 ? (
                        <p className="text-[10px] text-amber-700">
                          Trả lệnh: +{formatCompactMoney(r.refund_reversed)}
                        </p>
                      ) : null}
                    </div>
                  );
                },
              },
              {
                key: 'deducted',
                label: 'Khấu trừ',
                align: 'right',
                className: 'font-mono tabular-nums whitespace-nowrap text-amber-700',
                render: (r) =>
                  Number(r.deducted || 0) > 0 ? `-${formatMoney(r.deducted)}` : formatMoney(0),
              },
              {
                key: 'refunded',
                label: 'Hoàn chi / KC đi',
                align: 'right',
                className: 'font-mono tabular-nums whitespace-nowrap text-indigo-700',
                render: (r) => {
                  const totalOut = Number(r.refunded || 0) + Number(r.transfer_out || 0);
                  return (
                    <div>
                      <p>{totalOut > 0 ? `-${formatMoney(totalOut)}` : formatMoney(0)}</p>
                      {Number(r.transfer_out || 0) > 0 ? (
                        <p className="text-[10px] text-slate-500">
                          KC đi: {formatCompactMoney(r.transfer_out)}
                        </p>
                      ) : null}
                    </div>
                  );
                },
              },
              {
                key: 'closing_held',
                label: 'Cuối kỳ đang giữ',
                align: 'right',
                sortable: true,
                className: 'font-mono tabular-nums whitespace-nowrap font-bold text-slate-900',
                render: (r) => formatMoney(r.closing_held || 0),
              },
              {
                key: 'refund_due_date',
                label: 'Hạn hoàn cọc',
                align: 'center',
                className: 'whitespace-nowrap',
                render: (r) =>
                  r.refund_due_date ? (
                    <span
                      className={`text-xs font-medium ${
                        r.is_overdue ? 'text-rose-600 font-semibold' : 'text-slate-700'
                      }`}
                    >
                      {formatDate(r.refund_due_date)}
                      {r.is_overdue ? ' (Quá hạn)' : ''}
                    </span>
                  ) : (
                    <span className="text-xs text-slate-400">—</span>
                  ),
              },
            ]}
          />
        </div>
      ) : null}

      {/* TAB: NHẬT KÝ KIỂM TOÁN TÀI CHÍNH RP-08 */}
      {activeTab === 'financial-audit' ? (
        <div className="space-y-5">
          <AuditLogsView lockedScope="financial" />
        </div>
      ) : null}

      {/* Modal Tóm tắt Báo cáo Sổ cọc định kỳ RP-07 (mở từ thông báo MONTHLY_DEPOSIT_REPORT) */}
      <Modal
        open={depositSummaryModalOpen}
        onClose={() => setDepositSummaryModalOpen(false)}
        title="Tổng hợp Báo cáo Sổ cọc định kỳ (RP-07)"
        subtitle={`Kỳ đối soát: ${ledgerFromDate || '—'} → ${ledgerToDate || '—'}`}
        size="md"
        footer={
          <>
            <Button variant="outline" onClick={() => setDepositSummaryModalOpen(false)}>
              Đóng
            </Button>
            <Button
              variant="primary"
              icon={FileSpreadsheet}
              loading={exportingLedgerFormat === 'xlsx'}
              onClick={() => handleExportDepositLedger('xlsx')}
            >
              Xuất Sổ cọc Excel (.xlsx)
            </Button>
          </>
        }
      >
        <div className="space-y-4 text-xs">
          <div className="grid grid-cols-2 gap-3 p-3.5 rounded-xl bg-slate-50 border border-slate-200">
            <div>
              <p className="text-slate-500">Đầu kỳ đang giữ</p>
              <p className="font-mono text-sm font-bold text-slate-900 mt-0.5">
                {formatMoney(ledgerData.summary?.opening_held || 0)}
              </p>
            </div>
            <div>
              <p className="text-slate-500">Cuối kỳ đang giữ</p>
              <p className="font-mono text-sm font-bold text-emerald-700 mt-0.5">
                {formatMoney(ledgerData.summary?.closing_held || 0)}
              </p>
            </div>
            <div>
              <p className="text-slate-500">Thu mới trong kỳ</p>
              <p className="font-mono font-semibold text-sky-700 mt-0.5">
                +{formatMoney(ledgerData.summary?.collected || 0)}
              </p>
            </div>
            <div>
              <p className="text-slate-500">Hoàn chi / Khấu trừ</p>
              <p className="font-mono font-semibold text-indigo-700 mt-0.5">
                -{formatMoney(Number(ledgerData.summary?.refunded || 0) + Number(ledgerData.summary?.deducted || 0))}
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 p-3 rounded-xl bg-amber-50 border border-amber-200 text-amber-900">
            <span>Hồ sơ quá hạn hoàn cọc: <strong>{ledgerData.summary?.overdue_count || 0}</strong></span>
            <span>Đang khiếu nại: <strong>{ledgerData.summary?.disputed_count || 0}</strong></span>
            <span>Chờ chi hoàn: <strong>{ledgerData.summary?.pending_payout_count || 0}</strong></span>
          </div>
        </div>
      </Modal>

      {/* TAB 5: SLA BÁO HỎNG */}
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
