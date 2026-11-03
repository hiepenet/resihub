import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useNavigate, useLocation, Link } from 'react-router-dom';
import {
  Receipt,
  Sparkles,
  Download,
  CheckCircle2,
  AlertTriangle,
  Eye,
  Send,
  RefreshCw,
  Clock,
  ExternalLink,
} from 'lucide-react';
import { Button } from '../../../components/ui/Button';
import { Select } from '../../../components/ui/Select';
import { Modal } from '../../../components/ui/Modal';
import { Card } from '../../../components/ui/Card';
import { PageHeader } from '../../../components/common/PageHeader';
import { StatsCard } from '../../../components/common/StatsCard';
import { StatusBadge } from '../../../components/common/StatusBadge';
import { DataTable } from '../../../components/common/DataTable';
import { SearchBar } from '../../../components/common/SearchBar';
import { invoicesService } from '../../../services/invoices.service';
import { buildingsService } from '../../../services/buildings.service';
import { usePermission } from '../../../hooks/usePermission';
import { useToast } from '../../../hooks/useToast';
import { useAuthStore } from '../../../stores/authStore';
import { INVOICE_STATUS } from '../../../constants/statuses';
import { formatMoney, formatDate, getCurrentPeriod, exportToCsv } from '../../../utils/format';
import { extractErrorMessage } from '../../../utils/validation';

const STATUS_OPTIONS = Object.entries(INVOICE_STATUS).map(([value, info]) => ({
  value,
  label: info.label,
}));

export function InvoicesPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const toast = useToast();
  const { canManageInvoices } = usePermission();
  const selectedBuildingId = useAuthStore((s) => s.selectedBuildingId);

  const [invoices, setInvoices] = useState([]);
  const [summary, setSummary] = useState({ total_billed: 0, total_paid: 0, total_unpaid: 0 });
  const [loading, setLoading] = useState(true);

  // Bộ lọc
  const [period, setPeriod] = useState(getCurrentPeriod());
  const [statusFilter, setStatusFilter] = useState('');
  const [search, setSearch] = useState('');

  // Hàng đợi 4 mắt: Điều chỉnh hóa đơn chờ duyệt (Ruling 2)
  const [pendingAdjustments, setPendingAdjustments] = useState([]);
  const [adjustmentsLoading, setAdjustmentsLoading] = useState(false);
  const [showAdjustmentsModal, setShowAdjustmentsModal] = useState(false);

  // Modal sinh hóa đơn hàng loạt
  const [batchOpen, setBatchOpen] = useState(false);
  const [buildings, setBuildings] = useState([]);
  const [batchPeriod, setBatchPeriod] = useState(getCurrentPeriod());
  const [batchBuildingId, setBatchBuildingId] = useState('');
  const [autoIssue, setAutoIssue] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [issuingId, setIssuingId] = useState(null);

  // Kết quả sinh hóa đơn hàng loạt & hợp đồng bỏ qua (AC-015.1)
  const [batchResult, setBatchResult] = useState(null);

  const fetchAdjustmentsQueue = useCallback(async () => {
    setAdjustmentsLoading(true);
    try {
      const res = await invoicesService.getAdjustments({
        status: 'PENDING_APPROVAL',
        building_id: selectedBuildingId || undefined,
      });
      setPendingAdjustments(res.data || []);
    } catch {
      setPendingAdjustments([]);
    } finally {
      setAdjustmentsLoading(false);
    }
  }, [selectedBuildingId]);

  // Tự động mở hàng đợi khi URL chứa ?status=PENDING_APPROVAL hoặc ?tab=adjustments
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    if (params.get('status') === 'PENDING_APPROVAL' || params.get('tab') === 'adjustments') {
      setShowAdjustmentsModal(true);
    }
  }, [location.search]);

  const fetchInvoices = useCallback(async () => {
    setLoading(true);
    try {
      const res = await invoicesService.list({
        building_id: selectedBuildingId || undefined,
        period: period || undefined,
        status: statusFilter || undefined,
        search: search.trim() || undefined,
      });
      setInvoices(res.data || []);
      setSummary(res.summary || { total_billed: 0, total_paid: 0, total_unpaid: 0 });
    } catch (err) {
      toast.error(extractErrorMessage(err, 'Không thể tải danh sách hóa đơn.'));
    } finally {
      setLoading(false);
    }
  }, [selectedBuildingId, period, statusFilter, search, toast]);

  useEffect(() => {
    const t = setTimeout(() => {
      fetchInvoices();
      fetchAdjustmentsQueue();
    }, 200);
    return () => clearTimeout(t);
  }, [fetchInvoices, fetchAdjustmentsQueue]);

  const openBatchModal = async () => {
    setBatchPeriod(period || getCurrentPeriod());
    setBatchBuildingId(selectedBuildingId || '');
    setAutoIssue(true);
    setBatchOpen(true);
    try {
      const res = await buildingsService.list();
      setBuildings(res.data || []);
    } catch {
      setBuildings([]);
    }
  };

  const handleGenerateBatch = async (e) => {
    e.preventDefault();
    if (!batchPeriod) {
      toast.warning('Vui lòng chọn kỳ thanh toán cần sinh hóa đơn.');
      return;
    }
    setGenerating(true);
    try {
      const res = await invoicesService.generateBatch({
        building_id: batchBuildingId || selectedBuildingId || undefined,
        period: batchPeriod,
        auto_issue: autoIssue,
      });
      toast.success(res.message || 'Đã xử lý sinh hóa đơn hàng loạt.');
      setBatchOpen(false);
      setBatchResult(res);
      setPeriod(batchPeriod);
      fetchInvoices();
    } catch (err) {
      toast.error(extractErrorMessage(err, 'Không thể sinh hóa đơn hàng loạt.'));
    } finally {
      setGenerating(false);
    }
  };

  const handleQuickIssue = async (e, row) => {
    e.stopPropagation();
    setIssuingId(row.id);
    try {
      const res = await invoicesService.updateStatus(row.id, { status: 'ISSUED' });
      toast.success(res.message || `Đã phát hành hóa đơn ${row.invoice_code}.`);
      fetchInvoices();
    } catch (err) {
      toast.error(extractErrorMessage(err, 'Không thể phát hành hóa đơn.'));
    } finally {
      setIssuingId(null);
    }
  };

  const handleExportCsv = () => {
    if (invoices.length === 0) {
      toast.warning('Không có dữ liệu hóa đơn để xuất CSV.');
      return;
    }
    exportToCsv(
      `hoa-don-${period || 'tat-ca'}.csv`,
      [
        { label: 'Mã hóa đơn', key: 'invoice_code' },
        { label: 'Kỳ', key: 'period' },
        { label: 'Mã tòa', key: 'building_code' },
        { label: 'Căn hộ', key: 'apartment_code' },
        { label: 'Cư dân', accessor: (r) => r.tenant_name || '' },
        { label: 'Số điện thoại', accessor: (r) => r.tenant_phone || '' },
        { label: 'Ngày tạo', accessor: (r) => formatDate(r.issue_date) },
        { label: 'Hạn thanh toán', accessor: (r) => formatDate(r.due_date) },
        { label: 'Tạm tính (VNĐ)', accessor: (r) => Number(r.subtotal_amount || 0) },
        { label: 'Điều chỉnh (VNĐ)', accessor: (r) => Number(r.adjustment_amount || 0) },
        { label: 'Tổng cộng (VNĐ)', accessor: (r) => Number(r.total_amount || 0) },
        { label: 'Đã thu (VNĐ)', accessor: (r) => Number(r.paid_amount || 0) },
        { label: 'Còn lại (VNĐ)', accessor: (r) => Math.max(0, Number(r.remaining_amount || 0)) },
        { label: 'Trạng thái', accessor: (r) => INVOICE_STATUS[r.status]?.label || r.status },
      ],
      invoices
    );
    toast.success(`Đã xuất ${invoices.length} hóa đơn ra file CSV.`);
  };

  const columns = useMemo(
    () => [
      {
        key: 'invoice_code',
        label: 'Mã hóa đơn',
        sortable: true,
        render: (row) => (
          <div>
            <span className="font-mono text-xs font-semibold text-primary-700 bg-primary-50 px-2 py-0.5 rounded border border-primary-100">
              {row.invoice_code}
            </span>
            <p className="text-[11px] text-slate-400 mt-1">Kỳ: {row.period}</p>
          </div>
        ),
      },
      {
        key: 'apartment_code',
        label: 'Căn hộ / Khách thuê',
        sortable: true,
        render: (row) => (
          <div>
            <p className="font-semibold text-slate-900">
              Căn {row.apartment_code}{' '}
              <span className="text-xs font-normal text-slate-500">
                ({row.building_name || row.building_code})
              </span>
            </p>
            <p className="text-xs text-slate-500 mt-0.5">
              {row.tenant_name || '—'}
              {row.tenant_phone ? ` • ${row.tenant_phone}` : ''}
            </p>
          </div>
        ),
      },
      {
        key: 'due_date',
        label: 'Hạn thanh toán',
        align: 'center',
        sortable: true,
        className: 'whitespace-nowrap',
        render: (row) => (
          <div className="text-xs">
            <p className="font-medium text-slate-800">{formatDate(row.due_date)}</p>
            <p className="text-slate-400 mt-0.5">Lập: {formatDate(row.issue_date)}</p>
          </div>
        ),
      },
      {
        key: 'total_amount',
        label: 'Tổng phải thu',
        align: 'right',
        sortable: true,
        sortValue: (r) => Number(r.total_amount || 0),
        className: 'font-mono tabular-nums font-semibold text-slate-900 whitespace-nowrap',
        render: (row) => (
          <div>
            <p>{formatMoney(row.total_amount)}</p>
            {Number(row.adjustment_amount) !== 0 ? (
              <p className="text-[11px] font-sans text-indigo-600 font-normal">
                ĐC: {Number(row.adjustment_amount) > 0 ? '+' : ''}
                {formatMoney(row.adjustment_amount)}
              </p>
            ) : null}
          </div>
        ),
      },
      {
        key: 'paid_amount',
        label: 'Đã thu',
        align: 'right',
        sortable: true,
        sortValue: (r) => Number(r.paid_amount || 0),
        className: 'font-mono tabular-nums text-emerald-700 font-medium whitespace-nowrap',
        render: (row) => formatMoney(row.paid_amount),
      },
      {
        key: 'remaining_amount',
        label: 'Còn nợ',
        align: 'right',
        sortable: true,
        sortValue: (r) => Number(r.remaining_amount || 0),
        className: 'font-mono tabular-nums font-semibold whitespace-nowrap',
        render: (row) => {
          const rem = Math.max(0, Number(row.remaining_amount || 0));
          const isVoidOrCancelled = ['CANCELLED', 'VOID'].includes(row.status);
          return (
            <span className={rem > 0 && !isVoidOrCancelled ? 'text-rose-600' : 'text-slate-400'}>
              {isVoidOrCancelled ? '0 ₫' : formatMoney(rem)}
            </span>
          );
        },
      },
      {
        key: 'status',
        label: 'Trạng thái',
        align: 'center',
        sortable: true,
        render: (row) => <StatusBadge status={row.status} domain="invoice" />,
      },
      {
        key: 'actions',
        label: 'Thao tác',
        align: 'center',
        className: 'whitespace-nowrap',
        render: (row) => (
          <div className="inline-flex items-center justify-center gap-1.5" onClick={(e) => e.stopPropagation()}>
            {canManageInvoices && row.status === 'DRAFT' ? (
              <Button
                size="xs"
                variant="soft"
                icon={Send}
                loading={issuingId === row.id}
                onClick={(e) => handleQuickIssue(e, row)}
              >
                Phát hành
              </Button>
            ) : null}
            <Button
              size="xs"
              variant="ghost"
              icon={Eye}
              onClick={() => navigate(`/admin/invoices/${row.id}`)}
            >
              Chi tiết
            </Button>
          </div>
        ),
      },
    ],
    [canManageInvoices, issuingId, navigate]
  );

  const collectionRate =
    summary.total_billed > 0
      ? Math.round((summary.total_paid / summary.total_billed) * 100)
      : 0;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Quản lý Hóa đơn Kỳ"
        subtitle="Tổng hợp tiền thuê, điện, nước, dịch vụ tiện ích và phát hành hóa đơn định kỳ cho cư dân."
        actions={
          <>
            <Button variant="outline" icon={RefreshCw} onClick={fetchInvoices}>
              Làm mới
            </Button>
            <Button variant="outline" icon={Download} onClick={handleExportCsv}>
              Xuất CSV
            </Button>
            {canManageInvoices ? (
              <Button variant="primary" icon={Sparkles} onClick={openBatchModal}>
                Sinh hóa đơn hàng loạt kỳ này
              </Button>
            ) : null}
          </>
        }
      />

      {/* Cảnh báo hàng đợi 4 mắt: Điều chỉnh hóa đơn chờ duyệt (Ruling 2) */}
      {pendingAdjustments.length > 0 ? (
        <div className="p-4 rounded-xl bg-amber-50 border border-amber-200 flex flex-col sm:flex-row sm:items-center justify-between gap-3 shadow-xs">
          <div className="flex items-start gap-3">
            <Clock className="w-5 h-5 text-amber-600 mt-0.5 flex-shrink-0" />
            <div>
              <p className="text-sm font-semibold text-amber-900">
                Có {pendingAdjustments.length} đề nghị điều chỉnh hóa đơn đang chờ phê duyệt 4 mắt
              </p>
              <p className="text-xs text-amber-800/80 mt-0.5">
                Các đề nghị điều chỉnh tăng/giảm hoặc hủy (VOID) sau phát hành cần được kiểm duyệt trước khi đồng bộ tài chính.
              </p>
            </div>
          </div>
          <Button
            size="sm"
            variant="warning"
            onClick={() => setShowAdjustmentsModal(true)}
            className="self-start sm:self-center whitespace-nowrap"
          >
            Xem hàng đợi ({pendingAdjustments.length})
          </Button>
        </div>
      ) : null}

      {/* KPI tổng phát hành / đã thu / chưa thu */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <StatsCard
          title={`Tổng phát hành ${period ? `(${period})` : '(Tất cả kỳ)'}`}
          value={formatMoney(summary.total_billed)}
          subtext={`${invoices.filter((i) => !['CANCELLED', 'VOID'].includes(i.status)).length} hóa đơn hợp lệ`}
          icon={Receipt}
          color="sky"
        />
        <StatsCard
          title="Đã thu thực tế"
          value={formatMoney(summary.total_paid)}
          subtext={`Tỷ lệ thu đạt ${collectionRate}% tổng phát hành`}
          icon={CheckCircle2}
          color="emerald"
        />
        <StatsCard
          title="Chưa thu / Còn phải thu"
          value={formatMoney(summary.total_unpaid)}
          subtext={`${
            invoices.filter((i) => ['ISSUED', 'PARTIALLY_PAID', 'OVERDUE', 'ADJUSTED'].includes(i.status)).length
          } hóa đơn đang chờ thanh toán`}
          icon={AlertTriangle}
          color="rose"
        />
      </div>

      {/* Bộ lọc */}
      <Card className="p-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3 items-center">
          <div className="flex items-center gap-2">
            <input
              type="month"
              value={period}
              onChange={(e) => setPeriod(e.target.value)}
              className="w-full h-9 px-3 rounded-lg border border-slate-200 bg-white text-sm font-medium text-slate-800 focus:outline-none focus:border-primary-500 focus:ring-2 focus:ring-primary-500/20"
            />
            {period ? (
              <button
                type="button"
                onClick={() => setPeriod('')}
                className="text-xs text-primary-600 hover:underline whitespace-nowrap"
              >
                Tất cả kỳ
              </button>
            ) : null}
          </div>

          <Select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            placeholder="Tất cả trạng thái"
            options={STATUS_OPTIONS}
          />

          <div className="sm:col-span-2 lg:col-span-3">
            <SearchBar
              value={search}
              onChange={setSearch}
              placeholder="Tìm theo mã hóa đơn (INV-...), mã căn hộ, họ tên cư dân..."
            />
          </div>
        </div>
      </Card>

      {/* Bảng danh sách hóa đơn */}
      <DataTable
        columns={columns}
        data={invoices}
        loading={loading}
        onRowClick={(row) => navigate(`/admin/invoices/${row.id}`)}
        emptyTitle="Chưa có hóa đơn nào trong kỳ này"
        emptyDescription="Bấm “Sinh hóa đơn hàng loạt kỳ này” để tự động tính tiền thuê, điện, nước và dịch vụ cho toàn bộ hợp đồng đang hiệu lực."
        emptyAction={
          canManageInvoices ? (
            <Button variant="primary" size="sm" icon={Sparkles} onClick={openBatchModal}>
              Sinh hóa đơn hàng loạt
            </Button>
          ) : null
        }
      />

      {/* Modal Sinh hóa đơn hàng loạt */}
      <Modal
        open={batchOpen}
        onClose={() => setBatchOpen(false)}
        title="Sinh hóa đơn hàng loạt theo kỳ"
        subtitle="Hệ thống tự động gom Tiền thuê + Chỉ số Điện/Nước đã chốt + Gói dịch vụ ACTIVE của từng hợp đồng."
        size="md"
        footer={
          <>
            <Button variant="outline" onClick={() => setBatchOpen(false)} disabled={generating}>
              Hủy
            </Button>
            <Button variant="primary" icon={Sparkles} onClick={handleGenerateBatch} loading={generating}>
              Tiến hành sinh hóa đơn
            </Button>
          </>
        }
      >
        <form onSubmit={handleGenerateBatch} className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1.5">
              Kỳ hóa đơn (YYYY-MM) <span className="text-rose-500">*</span>
            </label>
            <input
              type="month"
              required
              value={batchPeriod}
              onChange={(e) => setBatchPeriod(e.target.value)}
              className="w-full h-9 px-3 rounded-lg border border-slate-200 bg-white text-sm font-medium text-slate-800 focus:outline-none focus:border-primary-500 focus:ring-2 focus:ring-primary-500/20"
            />
          </div>

          {!selectedBuildingId ? (
            <Select
              label="Phạm vi tòa nhà"
              value={batchBuildingId}
              onChange={(e) => setBatchBuildingId(e.target.value)}
              placeholder="Tất cả tòa nhà trong phạm vi quản lý"
              options={buildings.map((b) => ({
                value: b.id,
                label: `${b.code} — ${b.name}`,
              }))}
            />
          ) : null}

          <label className="flex items-start gap-3 p-3.5 rounded-xl border border-primary-200 bg-primary-50/50 cursor-pointer">
            <input
              type="checkbox"
              checked={autoIssue}
              onChange={(e) => setAutoIssue(e.target.checked)}
              className="mt-0.5 w-4 h-4 rounded border-primary-300 text-primary-600 focus:ring-primary-500"
            />
            <div className="text-xs">
              <p className="font-semibold text-slate-900">
                Tự động phát hành ngay (ISSUED) & Gửi thông báo cho cư dân
              </p>
              <p className="text-slate-600 mt-0.5 leading-relaxed">
                Khi bật, hóa đơn sẽ chuyển thẳng sang trạng thái <strong>Đã phát hành</strong>, đồng
                bộ sang Sổ công nợ và gửi thông báo tới ứng dụng của cư dân. Bỏ chọn nếu bạn muốn tạo{' '}
                <strong>Bản nháp (DRAFT)</strong> để rà soát trước.
              </p>
            </div>
          </label>
        </form>
      </Modal>

      {/* Modal báo cáo kết quả sinh hóa đơn hàng loạt & skipped_contracts (AC-015.1) */}
      <Modal
        open={Boolean(batchResult)}
        onClose={() => setBatchResult(null)}
        title="Báo cáo kết quả sinh hóa đơn"
        subtitle={`Kỳ thanh toán: ${batchPeriod}`}
        size="lg"
        footer={
          <Button variant="primary" onClick={() => setBatchResult(null)}>
            Đóng
          </Button>
        }
      >
        {batchResult ? (
          <div className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="p-3 rounded-xl bg-emerald-50 border border-emerald-200 text-center">
                <p className="text-xs text-emerald-700 font-medium">Hóa đơn tạo mới</p>
                <p className="text-xl font-bold text-emerald-800 mt-0.5">
                  {batchResult.created_count ?? 0}
                </p>
              </div>
              <div className="p-3 rounded-xl bg-sky-50 border border-sky-200 text-center">
                <p className="text-xs text-sky-700 font-medium">Bản nháp đã cập nhật</p>
                <p className="text-xl font-bold text-sky-800 mt-0.5">
                  {batchResult.updated_draft_count ?? 0}
                </p>
              </div>
              <div className="p-3 rounded-xl bg-amber-50 border border-amber-200 text-center">
                <p className="text-xs text-amber-700 font-medium">Hợp đồng bỏ qua</p>
                <p className="text-xl font-bold text-amber-800 mt-0.5">
                  {(batchResult.skipped_contracts || []).length}
                </p>
              </div>
            </div>

            {Array.isArray(batchResult.skipped_contracts) && batchResult.skipped_contracts.length > 0 ? (
              <div className="space-y-2">
                <p className="text-xs font-semibold text-slate-800">
                  Chi tiết hợp đồng không sinh hóa đơn kỳ này (Bảo toàn dữ liệu):
                </p>
                <div className="max-h-60 overflow-y-auto rounded-lg border border-slate-200">
                  <table className="w-full text-xs text-left">
                    <thead className="bg-slate-50 text-slate-600 font-semibold sticky top-0 border-b border-slate-200">
                      <tr>
                        <th className="p-2.5">Mã Hợp đồng</th>
                        <th className="p-2.5">Căn hộ</th>
                        <th className="p-2.5">Lý do bỏ qua</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {batchResult.skipped_contracts.map((sc, idx) => (
                        <tr key={idx} className="hover:bg-slate-50/50">
                          <td className="p-2.5 font-mono font-medium text-slate-800">
                            {sc.contract_code || sc.contract_id?.slice(0, 8)}
                          </td>
                          <td className="p-2.5 text-slate-700 font-semibold">
                            {sc.apartment_code || '—'}
                          </td>
                          <td className="p-2.5 text-amber-700">{sc.reason || 'Đã có hóa đơn trong kỳ'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ) : (
              <p className="text-xs text-slate-500 italic text-center py-2">
                Tất cả hợp đồng đủ điều kiện đều đã được sinh hoặc làm mới hóa đơn thành công.
              </p>
            )}
          </div>
        ) : null}
      </Modal>

      {/* Modal Hàng đợi 4 mắt: Đề nghị điều chỉnh hóa đơn chờ duyệt (Ruling 2) */}
      <Modal
        open={showAdjustmentsModal}
        onClose={() => setShowAdjustmentsModal(false)}
        title="Hàng đợi Điều chỉnh Hóa đơn chờ duyệt 4 mắt"
        subtitle="Danh sách các đề nghị tăng/giảm hoặc hủy hóa đơn (VOID) cần phê duyệt độc lập."
        size="xl"
        footer={
          <Button variant="outline" onClick={() => setShowAdjustmentsModal(false)}>
            Đóng
          </Button>
        }
      >
        <div className="space-y-4">
          {adjustmentsLoading ? (
            <div className="py-8 text-center text-xs text-slate-400">
              Đang tải danh sách chờ duyệt...
            </div>
          ) : pendingAdjustments.length === 0 ? (
            <div className="py-8 text-center text-xs text-slate-500">
              Không có đề nghị điều chỉnh hóa đơn nào đang chờ phê duyệt.
            </div>
          ) : (
            <div className="max-h-[60vh] overflow-y-auto rounded-lg border border-slate-200">
              <table className="w-full text-xs text-left">
                <thead className="bg-slate-50 text-slate-600 font-semibold sticky top-0 border-b border-slate-200">
                  <tr>
                    <th className="p-2.5">Hóa đơn</th>
                    <th className="p-2.5">Căn hộ</th>
                    <th className="p-2.5">Loại điều chỉnh</th>
                    <th className="p-2.5 text-right">Số tiền thay đổi</th>
                    <th className="p-2.5">Lý do</th>
                    <th className="p-2.5 text-center">Thao tác</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {pendingAdjustments.map((adj) => (
                    <tr key={adj.id} className="hover:bg-slate-50/50">
                      <td className="p-2.5 font-mono font-semibold text-primary-600">
                        <Link
                          to={`/admin/invoices/${adj.invoice_id}`}
                          className="hover:underline flex items-center gap-1"
                        >
                          {adj.invoice_code || adj.invoice_id?.slice(0, 8)}
                          <ExternalLink className="w-3 h-3 text-slate-400" />
                        </Link>
                      </td>
                      <td className="p-2.5 font-medium text-slate-800">
                        {adj.apartment_code || '—'}
                      </td>
                      <td className="p-2.5">
                        <Badge
                          variant={adj.action_type === 'VOID' ? 'slate' : 'purple'}
                          size="xs"
                        >
                          {adj.action_type === 'VOID' ? 'Hủy hóa đơn (VOID)' : `Điều chỉnh ${adj.adjustment_target || ''}`}
                        </Badge>
                      </td>
                      <td className="p-2.5 text-right font-mono font-semibold text-slate-900">
                        {adj.delta_amount != null
                          ? `${Number(adj.delta_amount) > 0 ? '+' : ''}${formatMoney(adj.delta_amount)}`
                          : '—'}
                      </td>
                      <td className="p-2.5 text-slate-600 max-w-xs break-words">
                        {adj.reason || '—'}
                      </td>
                      <td className="p-2.5 text-center">
                        <Button
                          size="xs"
                          variant="soft"
                          icon={Eye}
                          onClick={() => {
                            setShowAdjustmentsModal(false);
                            navigate(`/admin/invoices/${adj.invoice_id}`);
                          }}
                        >
                          Chi tiết & Phê duyệt
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </Modal>
    </div>
  );
}

export default InvoicesPage;
