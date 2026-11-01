import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Link } from 'react-router-dom';
import {
  Wallet,
  Plus,
  Check,
  X,
  Eye,
  Clock,
  AlertTriangle,
  TrendingUp,
  Download,
  RefreshCw,
  CheckCircle2,
} from 'lucide-react';
import { Button } from '../../../components/ui/Button';
import { Input } from '../../../components/ui/Input';
import { MoneyInput } from '../../../components/ui/MoneyInput';
import { Select } from '../../../components/ui/Select';
import { Modal } from '../../../components/ui/Modal';
import { Badge } from '../../../components/ui/Badge';
import { Card } from '../../../components/ui/Card';
import { Tabs } from '../../../components/ui/Tabs';
import { FileUpload, AuthImage } from '../../../components/ui/FileUpload';
import { PageHeader } from '../../../components/common/PageHeader';
import { StatsCard } from '../../../components/common/StatsCard';
import { StatusBadge } from '../../../components/common/StatusBadge';
import { DataTable } from '../../../components/common/DataTable';
import { SearchBar } from '../../../components/common/SearchBar';
import { paymentsService } from '../../../services/payments.service';
import { invoicesService } from '../../../services/invoices.service';
import { usePermission } from '../../../hooks/usePermission';
import { useToast } from '../../../hooks/useToast';
import { useAuthStore } from '../../../stores/authStore';
import { PAYMENT_STATUS, RECEIVABLE_STATUS } from '../../../constants/statuses';
import { formatMoney, formatDate, formatDateTime, exportToCsv } from '../../../utils/format';
import { extractErrorMessage } from '../../../utils/validation';

const PAYMENT_METHOD_OPTIONS = [
  { value: 'BANK_TRANSFER', label: 'Chuyển khoản' },
  { value: 'QR_CODE', label: 'QR Code' },
  { value: 'E_WALLET', label: 'Ví điện tử' },
  { value: 'CASH', label: 'Tiền mặt' },
  { value: 'CARD', label: 'Thẻ' },
  { value: 'OTHER', label: 'Khác' },
];

const PAYMENT_METHODS = {
  BANK_TRANSFER: 'Chuyển khoản',
  TRANSFER: 'Chuyển khoản',
  QR_CODE: 'QR Code',
  E_WALLET: 'Ví điện tử',
  EWALLET: 'Ví điện tử',
  CASH: 'Tiền mặt',
  CARD: 'Thẻ',
  OTHER: 'Khác',
};

const AGING_LABELS = {
  '0_30': { label: '0 – 30 ngày', variant: 'sky' },
  '31_60': { label: '31 – 60 ngày', variant: 'amber' },
  '61_90': { label: '61 – 90 ngày', variant: 'amber' },
  OVER_90: { label: '> 90 ngày', variant: 'red' },
};

export function PaymentsPage() {
  const toast = useToast();
  const { canManagePayments } = usePermission();
  const selectedBuildingId = useAuthStore((s) => s.selectedBuildingId);

  const [activeTab, setActiveTab] = useState('transactions'); // transactions | aging | overpayments

  // Tab 1: Giao dịch thanh toán
  const [payments, setPayments] = useState([]);
  const [paymentsLoading, setPaymentsLoading] = useState(true);
  const [payStatusFilter, setPayStatusFilter] = useState('');
  const [payMethodFilter, setPayMethodFilter] = useState('');
  const [paySearch, setPaySearch] = useState('');

  // Tab 2: Công nợ Aging
  const [receivables, setReceivables] = useState([]);
  const [agingSummary, setAgingSummary] = useState({
    bucket_0_30: 0,
    bucket_31_60: 0,
    bucket_61_90: 0,
    bucket_over_90: 0,
    total_balance: 0,
  });
  const [agingLoading, setAgingLoading] = useState(false);
  const [recStatusFilter, setRecStatusFilter] = useState('OPEN,PARTIALLY_PAID');
  const [agingBucketFilter, setAgingBucketFilter] = useState('');
  const [recSearch, setRecSearch] = useState('');

  // Tab 3: Thanh toán thừa
  const [overpayments, setOverpayments] = useState([]);
  const [overLoading, setOverLoading] = useState(false);

  // Modal ghi nhận thanh toán mới
  const [createOpen, setCreateOpen] = useState(false);
  const [openInvoices, setOpenInvoices] = useState([]);
  const [creating, setCreating] = useState(false);
  const [createForm, setCreateForm] = useState({
    invoice_id: '',
    receivable_id: '',
    amount: '',
    method: 'BANK_TRANSFER',
    reference_code: '',
    note: '',
    proof_image: '',
  });

  // Modal đối soát xem ảnh chứng từ & xác nhận / từ chối
  const [reviewPayment, setReviewPayment] = useState(null);
  const [confirmNote, setConfirmNote] = useState('');
  const [rejectModalTarget, setRejectModalTarget] = useState(null);
  const [rejectReason, setRejectReason] = useState('');
  const [processingAction, setProcessingAction] = useState(false);

  const fetchPayments = useCallback(async () => {
    setPaymentsLoading(true);
    try {
      const res = await paymentsService.list({
        building_id: selectedBuildingId || undefined,
        status: payStatusFilter || undefined,
        method: payMethodFilter || undefined,
        search: paySearch.trim() || undefined,
      });
      setPayments(res.data || []);
    } catch (err) {
      toast.error(extractErrorMessage(err, 'Không thể tải danh sách giao dịch thanh toán.'));
    } finally {
      setPaymentsLoading(false);
    }
  }, [selectedBuildingId, payStatusFilter, payMethodFilter, paySearch, toast]);

  const fetchReceivables = useCallback(async () => {
    setAgingLoading(true);
    try {
      const res = await paymentsService.listReceivables({
        building_id: selectedBuildingId || undefined,
        status: recStatusFilter,
      });
      setReceivables(res.data || []);
      setAgingSummary(
        res.aging_summary || {
          bucket_0_30: 0,
          bucket_31_60: 0,
          bucket_61_90: 0,
          bucket_over_90: 0,
          total_balance: 0,
        }
      );
    } catch (err) {
      toast.error(extractErrorMessage(err, 'Không thể tải báo cáo công nợ tuổi nợ.'));
    } finally {
      setAgingLoading(false);
    }
  }, [selectedBuildingId, recStatusFilter, toast]);

  const fetchOverpayments = useCallback(async () => {
    setOverLoading(true);
    try {
      const res = await paymentsService.list({
        building_id: selectedBuildingId || undefined,
        overpayment_only: 'true',
      });
      setOverpayments(
        (res.data || []).filter((p) => Number(p.overpayment_amount || 0) > 0)
      );
    } catch (err) {
      toast.error(extractErrorMessage(err, 'Không thể tải danh sách thanh toán thừa.'));
    } finally {
      setOverLoading(false);
    }
  }, [selectedBuildingId, toast]);

  useEffect(() => {
    const t = setTimeout(() => {
      fetchPayments();
    }, 200);
    return () => clearTimeout(t);
  }, [fetchPayments]);

  useEffect(() => {
    fetchReceivables();
    fetchOverpayments();
  }, [fetchReceivables, fetchOverpayments]);

  const pendingConfirmList = useMemo(
    () => payments.filter((p) => p.status === 'PENDING_CONFIRMATION'),
    [payments]
  );

  const filteredReceivables = useMemo(() => {
    return receivables.filter((r) => {
      if (agingBucketFilter && r.aging_bucket !== agingBucketFilter) return false;
      if (recSearch.trim()) {
        const q = recSearch.trim().toLowerCase();
        const hit =
          r.apartment_code?.toLowerCase().includes(q) ||
          r.tenant_name?.toLowerCase().includes(q) ||
          r.invoice_code?.toLowerCase().includes(q) ||
          r.description?.toLowerCase().includes(q);
        if (!hit) return false;
      }
      return true;
    });
  }, [receivables, agingBucketFilter, recSearch]);

  const totalOverpaymentSum = useMemo(
    () => overpayments.reduce((s, p) => s + Number(p.overpayment_amount || 0), 0),
    [overpayments]
  );

  const openCreateModal = async (presetReceivable = null) => {
    setCreateForm({
      invoice_id: presetReceivable?.invoice_id || '',
      receivable_id: presetReceivable?.id || '',
      amount: presetReceivable ? String(Math.max(0, Number(presetReceivable.balance || 0))) : '',
      method: 'BANK_TRANSFER',
      reference_code: '',
      note: presetReceivable ? `Thu nợ ${presetReceivable.invoice_code || presetReceivable.description || ''}` : '',
      proof_image: '',
    });
    setCreateOpen(true);
    try {
      const res = await invoicesService.list({
        building_id: selectedBuildingId || undefined,
        status: 'ISSUED,PARTIALLY_PAID,OVERDUE',
      });
      setOpenInvoices(res.data || []);
    } catch {
      setOpenInvoices([]);
    }
  };

  const handleCreatePayment = async (e) => {
    e.preventDefault();
    if (!createForm.invoice_id && !createForm.receivable_id) {
      toast.warning('Vui lòng chọn hóa đơn cần thu tiền.');
      return;
    }
    const amt = Math.round(Number(createForm.amount || 0));
    if (!amt || amt <= 0) {
      toast.warning('Số tiền thanh toán phải lớn hơn 0.');
      return;
    }

    setCreating(true);
    try {
      const res = await paymentsService.create({
        invoice_id: createForm.invoice_id || undefined,
        receivable_id: createForm.receivable_id || undefined,
        amount: amt,
        method: createForm.method,
        reference_code: createForm.reference_code.trim() || undefined,
        note: createForm.note.trim() || undefined,
        proof_image: createForm.proof_image || undefined,
      });
      toast.success(res.message || 'Ghi nhận thanh toán thành công.');
      setCreateOpen(false);
      fetchPayments();
      fetchReceivables();
      fetchOverpayments();
    } catch (err) {
      toast.error(extractErrorMessage(err, 'Không thể ghi nhận thanh toán.'));
    } finally {
      setCreating(false);
    }
  };

  const handleConfirmPayment = async (payment, noteText = '') => {
    setProcessingAction(true);
    try {
      const res = await paymentsService.confirm(payment.id, {
        note: noteText.trim() || undefined,
      });
      toast.success(res.message || `Đã đối soát xác nhận giao dịch ${payment.payment_code}.`);
      setReviewPayment(null);
      setConfirmNote('');
      fetchPayments();
      fetchReceivables();
      fetchOverpayments();
    } catch (err) {
      toast.error(extractErrorMessage(err, 'Không thể xác nhận giao dịch thanh toán.'));
    } finally {
      setProcessingAction(false);
    }
  };

  const handleRejectPayment = async (e) => {
    e.preventDefault();
    if (!rejectModalTarget) return;
    if (!rejectReason.trim()) {
      toast.warning('Vui lòng nhập lý do từ chối chứng từ.');
      return;
    }
    setProcessingAction(true);
    try {
      const res = await paymentsService.reject(rejectModalTarget.id, {
        reason: rejectReason.trim(),
      });
      toast.success(res.message || 'Đã từ chối chứng từ thanh toán.');
      setRejectModalTarget(null);
      setReviewPayment(null);
      setRejectReason('');
      fetchPayments();
    } catch (err) {
      toast.error(extractErrorMessage(err, 'Không thể từ chối chứng từ.'));
    } finally {
      setProcessingAction(false);
    }
  };

  const handleExportAgingCsv = () => {
    if (filteredReceivables.length === 0) {
      toast.warning('Không có dữ liệu công nợ để xuất CSV.');
      return;
    }
    exportToCsv(
      'bao-cao-cong-no-aging.csv',
      [
        { label: 'Mã tòa', key: 'building_code' },
        { label: 'Căn hộ', key: 'apartment_code' },
        { label: 'Khách thuê', accessor: (r) => r.tenant_name || '' },
        { label: 'SĐT', accessor: (r) => r.tenant_phone || '' },
        { label: 'Mã hóa đơn', accessor: (r) => r.invoice_code || '' },
        { label: 'Hạn thanh toán', accessor: (r) => formatDate(r.due_date) },
        { label: 'Số ngày quá hạn', accessor: (r) => Number(r.days_overdue || 0) },
        {
          label: 'Nhóm tuổi nợ',
          accessor: (r) => AGING_LABELS[r.aging_bucket]?.label || r.aging_bucket,
        },
        { label: 'Phải thu (VNĐ)', accessor: (r) => Number(r.amount || 0) },
        { label: 'Đã thu (VNĐ)', accessor: (r) => Number(r.paid_amount || 0) },
        { label: 'Dư nợ còn lại (VNĐ)', accessor: (r) => Number(r.balance || 0) },
        { label: 'Trạng thái', accessor: (r) => RECEIVABLE_STATUS[r.status]?.label || r.status },
      ],
      filteredReceivables
    );
    toast.success('Đã xuất danh sách công nợ Aging ra CSV.');
  };

  const paymentColumns = useMemo(
    () => [
      {
        key: 'payment_code',
        label: 'Mã giao dịch',
        sortable: true,
        render: (row) => (
          <div>
            <span className="font-mono text-xs font-semibold text-slate-800 bg-slate-100 px-2 py-0.5 rounded">
              {row.payment_code}
            </span>
            <p className="text-[11px] text-slate-400 mt-1">{formatDateTime(row.paid_at)}</p>
          </div>
        ),
      },
      {
        key: 'apartment_code',
        label: 'Căn hộ / Cư dân',
        sortable: true,
        render: (row) => (
          <div>
            <p className="font-semibold text-slate-900">
              {row.apartment_code ? `Căn ${row.apartment_code}` : '—'}{' '}
              <span className="text-xs font-normal text-slate-500">({row.building_code})</span>
            </p>
            <p className="text-xs text-slate-500 mt-0.5">{row.tenant_name || '—'}</p>
          </div>
        ),
      },
      {
        key: 'invoice_code',
        label: 'Hóa đơn',
        align: 'center',
        className: 'whitespace-nowrap',
        render: (row) =>
          row.invoice_id ? (
            <Link
              to={`/admin/invoices/${row.invoice_id}`}
              onClick={(e) => e.stopPropagation()}
              className="font-mono text-xs font-medium text-primary-600 hover:underline whitespace-nowrap"
            >
              {row.invoice_code} ({row.invoice_period})
            </Link>
          ) : (
            <span className="text-xs text-slate-400 whitespace-nowrap">Thu công nợ lẻ</span>
          ),
      },
      {
        key: 'method',
        label: 'Phương thức',
        render: (row) => (
          <div className="text-xs">
            <p className="font-medium text-slate-800 whitespace-nowrap">
              {PAYMENT_METHODS[row.method] || row.method}
            </p>
            {row.reference_code ? (
              <p className="font-mono text-[11px] text-slate-500">Ref: {row.reference_code}</p>
            ) : null}
          </div>
        ),
      },
      {
        key: 'amount',
        label: 'Số tiền nộp',
        align: 'right',
        sortable: true,
        sortValue: (r) => Number(r.amount || 0),
        className: 'font-mono tabular-nums whitespace-nowrap',
        render: (row) => (
          <div>
            <p className="font-mono font-semibold text-emerald-700">{formatMoney(row.amount)}</p>
            {Number(row.overpayment_amount) > 0 ? (
              <p className="text-[11px] font-sans text-indigo-600 font-medium">
                Thừa: {formatMoney(row.overpayment_amount)}
              </p>
            ) : null}
          </div>
        ),
      },
      {
        key: 'status',
        label: 'Trạng thái',
        align: 'center',
        sortable: true,
        render: (row) => <StatusBadge status={row.status} domain="payment" />,
      },
      {
        key: 'actions',
        label: 'Thao tác',
        align: 'center',
        className: 'whitespace-nowrap',
        render: (row) => {
          const hasProof = Array.isArray(row.proof_images) && row.proof_images.length > 0;
          return (
            <div className="inline-flex flex-wrap items-center justify-center gap-1.5" onClick={(e) => e.stopPropagation()}>
              <Button
                size="xs"
                variant={row.status === 'PENDING_CONFIRMATION' ? 'soft' : 'outline'}
                icon={Eye}
                onClick={() => {
                  setReviewPayment(row);
                  setConfirmNote(row.note || '');
                }}
              >
                {hasProof ? 'Xem chứng từ' : 'Chi tiết'}
              </Button>

              {canManagePayments && row.status === 'PENDING_CONFIRMATION' ? (
                <>
                  <Button
                    size="xs"
                    variant="success"
                    icon={Check}
                    disabled={processingAction}
                    onClick={() => handleConfirmPayment(row)}
                  >
                    Xác nhận
                  </Button>
                  <Button
                    size="xs"
                    variant="danger"
                    icon={X}
                    disabled={processingAction}
                    onClick={() => {
                      setRejectModalTarget(row);
                      setRejectReason('');
                    }}
                  >
                    Từ chối
                  </Button>
                </>
              ) : null}
            </div>
          );
        },
      },
    ],
    [canManagePayments, processingAction]
  );

  const agingColumns = useMemo(
    () => [
      {
        key: 'apartment_code',
        label: 'Căn hộ / Khách nợ',
        sortable: true,
        render: (row) => (
          <div>
            <p className="font-semibold text-slate-900">
              {row.apartment_code ? `Căn ${row.apartment_code}` : '—'}{' '}
              <span className="text-xs font-normal text-slate-500">({row.building_code})</span>
            </p>
            <p className="text-xs text-slate-500 mt-0.5">
              {row.tenant_name || '—'}
              {row.tenant_phone ? ` • ${row.tenant_phone}` : ''}
            </p>
          </div>
        ),
      },
      {
        key: 'invoice_code',
        label: 'Khoản công nợ',
        render: (row) => (
          <div>
            {row.invoice_id ? (
              <Link
                to={`/admin/invoices/${row.invoice_id}`}
                className="font-mono text-xs font-semibold text-primary-600 hover:underline"
              >
                {row.invoice_code}
              </Link>
            ) : (
              <span className="text-xs font-medium text-slate-800">
                {row.type === 'RECEIVABLE_AFTER_MOVE_OUT'
                  ? 'Công nợ sau trả phòng'
                  : row.type === 'INVOICE'
                  ? 'Công nợ hóa đơn'
                  : row.type || 'Khoản công nợ khác'}
              </span>
            )}
            <p className="text-xs text-slate-500 mt-0.5 break-words max-w-[260px]">
              {row.description || '—'}
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
        render: (row) => {
          const days = Number(row.days_overdue || 0);
          return (
            <div className="text-xs">
              <p className="font-medium text-slate-800">{formatDate(row.due_date)}</p>
              {days > 0 ? (
                <p className="text-rose-600 font-semibold mt-0.5">Quá hạn {days} ngày</p>
              ) : (
                <p className="text-emerald-600 mt-0.5">Trong hạn</p>
              )}
            </div>
          );
        },
      },
      {
        key: 'aging_bucket',
        label: 'Nhóm tuổi nợ',
        align: 'center',
        sortable: true,
        render: (row) => {
          const b = AGING_LABELS[row.aging_bucket] || AGING_LABELS['0_30'];
          return <Badge variant={b.variant}>{b.label}</Badge>;
        },
      },
      {
        key: 'amount',
        label: 'Gốc phải thu',
        align: 'right',
        className: 'font-mono tabular-nums text-slate-700 whitespace-nowrap',
        render: (row) => formatMoney(row.amount),
      },
      {
        key: 'balance',
        label: 'Dư nợ',
        align: 'right',
        sortable: true,
        sortValue: (r) => Number(r.balance || 0),
        className: 'font-mono tabular-nums font-bold text-rose-600 whitespace-nowrap',
        render: (row) => formatMoney(Math.max(0, Number(row.balance || 0))),
      },
      {
        key: 'status',
        label: 'Trạng thái',
        align: 'center',
        render: (row) => <StatusBadge status={row.status} domain="receivable" />,
      },
      {
        key: 'actions',
        label: 'Thao tác',
        align: 'center',
        className: 'whitespace-nowrap',
        render: (row) =>
          canManagePayments && ['OPEN', 'PARTIALLY_PAID'].includes(row.status) ? (
            <Button
              size="xs"
              variant="soft"
              icon={Wallet}
              onClick={() => openCreateModal(row)}
            >
              Thu nợ
            </Button>
          ) : null,
      },
    ],
    [canManagePayments]
  );

  const overpaymentColumns = useMemo(
    () => [
      {
        key: 'payment_code',
        label: 'Mã giao dịch',
        render: (row) => (
          <span className="font-mono text-xs font-semibold text-slate-800">{row.payment_code}</span>
        ),
      },
      {
        key: 'apartment_code',
        label: 'Căn hộ / Cư dân',
        render: (row) => (
          <div>
            <p className="font-semibold text-slate-900">
              Căn {row.apartment_code || '—'} ({row.building_code})
            </p>
            <p className="text-xs text-slate-500">{row.tenant_name || '—'}</p>
          </div>
        ),
      },
      {
        key: 'invoice_code',
        label: 'Hóa đơn gốc',
        align: 'center',
        className: 'whitespace-nowrap',
        render: (row) => (
          <span className="font-mono text-xs text-primary-600">{row.invoice_code || '—'}</span>
        ),
      },
      {
        key: 'amount',
        label: 'Tổng tiền nộp',
        align: 'right',
        className: 'font-mono tabular-nums whitespace-nowrap',
        render: (row) => formatMoney(row.amount),
      },
      {
        key: 'overpayment_amount',
        label: 'Số tiền nộp thừa',
        align: 'right',
        sortable: true,
        sortValue: (r) => Number(r.overpayment_amount || 0),
        className: 'font-mono tabular-nums font-bold text-indigo-700 whitespace-nowrap',
        render: (row) => formatMoney(row.overpayment_amount),
      },
      {
        key: 'paid_at',
        label: 'Thời gian xác nhận',
        align: 'center',
        className: 'whitespace-nowrap',
        render: (row) => (
          <div className="text-xs text-slate-600">
            <p>{formatDateTime(row.paid_at)}</p>
            <p className="text-slate-400">Bởi: {row.confirmed_by_name || 'Kế toán'}</p>
          </div>
        ),
      },
    ],
    []
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title="Thanh toán & Đối soát Công nợ"
        subtitle="Đối soát chứng từ chuyển khoản của cư dân, ghi nhận phiếu thu và phân tích tuổi nợ (Aging)."
        actions={
          <>
            <Button
              variant="outline"
              icon={RefreshCw}
              onClick={() => {
                fetchPayments();
                fetchReceivables();
                fetchOverpayments();
              }}
            >
              Làm mới
            </Button>
            {canManagePayments ? (
              <Button variant="primary" icon={Plus} onClick={() => openCreateModal()}>
                Ghi nhận thanh toán mới
              </Button>
            ) : null}
          </>
        }
      />

      <Tabs
        activeTab={activeTab}
        onChange={setActiveTab}
        tabs={[
          {
            id: 'transactions',
            label: 'Giao dịch thanh toán',
            icon: Wallet,
            count: pendingConfirmList.length > 0 ? `${pendingConfirmList.length} chờ duyệt` : payments.length,
          },
          {
            id: 'aging',
            label: 'Công nợ theo tuổi nợ (Aging)',
            icon: Clock,
            count: receivables.length,
          },
          {
            id: 'overpayments',
            label: 'Thanh toán thừa',
            icon: TrendingUp,
            count: overpayments.length,
          },
        ]}
      />

      {/* TAB 1: GIAO DỊCH THANH TOÁN */}
      {activeTab === 'transactions' ? (
        <div className="space-y-5">
          {/* Khu vực nổi bật ưu tiên đối soát PENDING_CONFIRMATION */}
          {pendingConfirmList.length > 0 ? (
            <div className="rounded-2xl border-2 border-amber-300 bg-amber-50/70 p-4 sm:p-5 space-y-3.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2.5">
                  <div className="w-9 h-9 rounded-xl bg-amber-500 text-white flex items-center justify-center shrink-0">
                    <AlertTriangle className="w-5 h-5" />
                  </div>
                  <div>
                    <h3 className="text-sm font-bold text-amber-950">
                      Cần đối soát ngay: {pendingConfirmList.length} chứng từ thanh toán do cư dân gửi
                    </h3>
                    <p className="text-xs text-amber-800">
                      Kiểm tra ảnh ủy nhiệm chi / sao kê ngân hàng trước khi bấm Đối soát xác nhận.
                    </p>
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                {pendingConfirmList.map((item) => {
                  const firstImg = Array.isArray(item.proof_images) ? item.proof_images[0] : null;
                  return (
                    <div
                      key={item.id}
                      className="bg-white rounded-xl border border-amber-200 p-3.5 shadow-sm flex flex-wrap items-center justify-between gap-3"
                    >
                      <div className="flex items-start gap-3 min-w-0 flex-1">
                        <button
                          type="button"
                          onClick={() => {
                            setReviewPayment(item);
                            setConfirmNote(item.note || '');
                          }}
                          className="w-16 h-16 rounded-lg border border-slate-200 overflow-hidden bg-slate-100 shrink-0 hover:ring-2 hover:ring-primary-500"
                        >
                          <AuthImage
                            src={firstImg}
                            alt="Chứng từ"
                            className="w-full h-full object-cover"
                          />
                        </button>
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-semibold text-sm text-slate-900">
                              Căn {item.apartment_code || '—'} ({item.building_name || item.building_code})
                            </span>
                            <span className="font-mono text-sm font-bold text-emerald-700">
                              {formatMoney(item.amount)}
                            </span>
                          </div>
                          <p className="text-xs text-slate-600 break-words mt-0.5">
                            {item.tenant_name || 'Cư dân'} • HĐ:{' '}
                            <span className="font-mono font-medium">{item.invoice_code || '—'}</span>
                          </p>
                          <p className="text-[11px] text-slate-400 break-words">
                            {PAYMENT_METHODS[item.method] || item.method}
                            {item.reference_code ? ` • Ref: ${item.reference_code}` : ''}
                          </p>
                        </div>
                      </div>

                      <div className="flex flex-col sm:flex-row items-end sm:items-center gap-1.5 shrink-0">
                        <Button
                          size="xs"
                          variant="outline"
                          icon={Eye}
                          onClick={() => {
                            setReviewPayment(item);
                            setConfirmNote(item.note || '');
                          }}
                        >
                          Xem ảnh
                        </Button>
                        {canManagePayments ? (
                          <>
                            <Button
                              size="xs"
                              variant="success"
                              icon={Check}
                              disabled={processingAction}
                              onClick={() => handleConfirmPayment(item)}
                            >
                              Đối soát xác nhận
                            </Button>
                            <Button
                              size="xs"
                              variant="danger"
                              icon={X}
                              disabled={processingAction}
                              onClick={() => {
                                setRejectModalTarget(item);
                                setRejectReason('');
                              }}
                            >
                              Từ chối
                            </Button>
                          </>
                        ) : null}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : null}

          <Card className="p-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
              <div className="sm:col-span-2">
                <SearchBar
                  value={paySearch}
                  onChange={setPaySearch}
                  placeholder="Tìm mã giao dịch (PAY-...), hóa đơn, căn hộ, khách thuê..."
                />
              </div>
              <Select
                value={payStatusFilter}
                onChange={(e) => setPayStatusFilter(e.target.value)}
                placeholder="Tất cả trạng thái"
                options={Object.entries(PAYMENT_STATUS).map(([value, info]) => ({
                  value,
                  label: info.label,
                }))}
              />
              <Select
                value={payMethodFilter}
                onChange={(e) => setPayMethodFilter(e.target.value)}
                placeholder="Tất cả phương thức"
                options={PAYMENT_METHOD_OPTIONS}
              />
            </div>
          </Card>

          <DataTable
            columns={paymentColumns}
            data={payments}
            loading={paymentsLoading}
            emptyTitle="Chưa có giao dịch thanh toán nào"
            emptyDescription="Các phiếu thu và báo thanh toán từ cư dân sẽ hiển thị tại đây."
          />
        </div>
      ) : null}

      {/* TAB 2: CÔNG NỢ THEO TUỔI NỢ (AGING) */}
      {activeTab === 'aging' ? (
        <div className="space-y-5">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <StatsCard
              title="Tuổi nợ 0 – 30 ngày"
              value={formatMoney(agingSummary.bucket_0_30)}
              subtext="Trong hạn hoặc mới quá hạn nhẹ"
              icon={Clock}
              color="sky"
              onClick={() =>
                setAgingBucketFilter((b) => (b === '0_30' ? '' : '0_30'))
              }
            />
            <StatsCard
              title="Tuổi nợ 31 – 60 ngày"
              value={formatMoney(agingSummary.bucket_31_60)}
              subtext="Cần gửi thông báo nhắc nợ lần 2"
              icon={AlertTriangle}
              color="amber"
              onClick={() =>
                setAgingBucketFilter((b) => (b === '31_60' ? '' : '31_60'))
              }
            />
            <StatsCard
              title="Tuổi nợ 61 – 90 ngày"
              value={formatMoney(agingSummary.bucket_61_90)}
              subtext="Rủi ro cao — cần làm việc trực tiếp"
              icon={AlertTriangle}
              color="indigo"
              onClick={() =>
                setAgingBucketFilter((b) => (b === '61_90' ? '' : '61_90'))
              }
            />
            <StatsCard
              title="Tuổi nợ > 90 ngày"
              value={formatMoney(agingSummary.bucket_over_90)}
              subtext="Nợ quá hạn nghiêm trọng"
              icon={AlertTriangle}
              color="rose"
              onClick={() =>
                setAgingBucketFilter((b) => (b === 'OVER_90' ? '' : 'OVER_90'))
              }
            />
          </div>

          <Card className="p-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3 items-center">
              <div className="sm:col-span-2">
                <SearchBar
                  value={recSearch}
                  onChange={setRecSearch}
                  placeholder="Tìm căn hộ, cư dân, mã hóa đơn..."
                />
              </div>
              <Select
                value={agingBucketFilter}
                onChange={(e) => setAgingBucketFilter(e.target.value)}
                placeholder="Tất cả nhóm tuổi nợ"
                options={Object.entries(AGING_LABELS).map(([value, info]) => ({
                  value,
                  label: info.label,
                }))}
              />
              <Select
                value={recStatusFilter}
                onChange={(e) => setRecStatusFilter(e.target.value)}
                options={[
                  { value: 'OPEN,PARTIALLY_PAID', label: 'Đang còn nợ' },
                  { value: 'ALL', label: 'Tất cả khoản công nợ' },
                  { value: 'PAID', label: 'Đã thu đủ' },
                  { value: 'WRITTEN_OFF', label: 'Đã xóa nợ' },
                ]}
              />
              <Button variant="outline" icon={Download} onClick={handleExportAgingCsv}>
                Xuất CSV Aging
              </Button>
            </div>
          </Card>

          <DataTable
            columns={agingColumns}
            data={filteredReceivables}
            loading={agingLoading}
            emptyTitle="Không có khoản công nợ quá hạn"
            emptyDescription="Tất cả các khoản phải thu hiện đang được thanh toán đúng hạn."
          />
        </div>
      ) : null}

      {/* TAB 3: THANH TOÁN THỪA */}
      {activeTab === 'overpayments' ? (
        <div className="space-y-5">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <StatsCard
              title="Số giao dịch nộp thừa"
              value={overpayments.length}
              subtext="Phát sinh khi khách chuyển khoản vượt số dư nợ hóa đơn"
              icon={CheckCircle2}
              color="indigo"
            />
            <StatsCard
              title="Tổng giá trị thanh toán thừa"
              value={formatMoney(totalOverpaymentSum)}
              subtext="Theo dõi để khấu trừ vào hóa đơn kỳ kế tiếp"
              icon={TrendingUp}
              color="emerald"
            />
          </div>

          <DataTable
            columns={overpaymentColumns}
            data={overpayments}
            loading={overLoading}
            emptyTitle="Chưa có khoản thanh toán thừa nào"
            emptyDescription="Các giao dịch có số tiền chuyển vượt quá dư nợ hóa đơn (`overpayment_amount > 0`) sẽ tự động liệt kê tại đây."
          />
        </div>
      ) : null}

      {/* Modal Ghi nhận thanh toán mới */}
      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="Ghi nhận phiếu thu / Thanh toán mới"
        subtitle="Tự động gạch nợ hóa đơn tương ứng và tính toán tiền thừa (nếu có)."
        size="lg"
        footer={
          <>
            <Button variant="outline" onClick={() => setCreateOpen(false)} disabled={creating}>
              Hủy
            </Button>
            <Button variant="primary" onClick={handleCreatePayment} loading={creating}>
              Xác nhận ghi nhận
            </Button>
          </>
        }
      >
        <form onSubmit={handleCreatePayment} className="space-y-4">
          <Select
            label="Chọn hóa đơn chưa thu"
            required={!createForm.receivable_id}
            value={createForm.invoice_id}
            onChange={(e) => {
              const invId = e.target.value;
              const found = openInvoices.find((i) => i.id === invId);
              const rem = found
                ? Math.max(0, Number(found.total_amount || 0) - Number(found.paid_amount || 0))
                : '';
              setCreateForm((s) => ({
                ...s,
                invoice_id: invId,
                amount: rem ? String(rem) : s.amount,
              }));
            }}
            placeholder="-- Chọn hóa đơn cần thu --"
            options={openInvoices.map((inv) => {
              const rem = Math.max(
                0,
                Number(inv.total_amount || 0) - Number(inv.paid_amount || 0)
              );
              return {
                value: inv.id,
                label: `${inv.invoice_code} — Căn ${inv.apartment_code} (${
                  inv.tenant_name || 'Cư dân'
                }) • Còn nợ: ${formatMoney(rem)}`,
              };
            })}
          />

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <MoneyInput
              label="Số tiền thực nhận (VNĐ)"
              required
              placeholder="VD: 8.500.000"
              value={createForm.amount}
              onChange={(e) => setCreateForm((s) => ({ ...s, amount: e.target.value }))}
            />
            <Select
              label="Phương thức thanh toán"
              required
              value={createForm.method}
              onChange={(e) => setCreateForm((s) => ({ ...s, method: e.target.value }))}
              options={PAYMENT_METHOD_OPTIONS}
            />
          </div>

          <Input
            label="Mã tham chiếu giao dịch / Ủy nhiệm chi"
            placeholder="VD: VCB98237492..."
            value={createForm.reference_code}
            onChange={(e) => setCreateForm((s) => ({ ...s, reference_code: e.target.value }))}
          />

          <Input
            label="Ghi chú kế toán"
            placeholder="Ghi chú nội dung chuyển khoản..."
            value={createForm.note}
            onChange={(e) => setCreateForm((s) => ({ ...s, note: e.target.value }))}
          />

          <FileUpload
            label="Ảnh chụp biên lai / Sao kê đối chiếu"
            multiple={false}
            value={createForm.proof_image}
            onChange={(img) => setCreateForm((s) => ({ ...s, proof_image: img }))}
          />
        </form>
      </Modal>

      {/* Modal Xem ảnh chứng từ & Đối soát xác nhận */}
      <Modal
        open={Boolean(reviewPayment)}
        onClose={() => setReviewPayment(null)}
        title={
          reviewPayment
            ? `Đối soát chứng từ #${reviewPayment.payment_code}`
            : 'Chi tiết chứng từ'
        }
        subtitle={
          reviewPayment
            ? `Căn ${reviewPayment.apartment_code || '—'} • Số tiền báo nộp: ${formatMoney(
                reviewPayment.amount
              )}`
            : ''
        }
        size="lg"
        footer={
          reviewPayment &&
          canManagePayments &&
          reviewPayment.status === 'PENDING_CONFIRMATION' ? (
            <>
              <Button
                variant="danger"
                icon={X}
                disabled={processingAction}
                onClick={() => {
                  setRejectModalTarget(reviewPayment);
                  setRejectReason('');
                }}
              >
                Từ chối chứng từ
              </Button>
              <Button
                variant="success"
                icon={Check}
                loading={processingAction}
                onClick={() => handleConfirmPayment(reviewPayment, confirmNote)}
              >
                Đối soát xác nhận hợp lệ
              </Button>
            </>
          ) : (
            <Button variant="outline" onClick={() => setReviewPayment(null)}>
              Đóng
            </Button>
          )
        }
      >
        {reviewPayment ? (
          <div className="space-y-4">
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 p-3.5 rounded-xl bg-slate-50 border border-slate-200 text-xs">
              <div>
                <p className="text-slate-400">Hóa đơn</p>
                <p className="font-mono font-semibold text-slate-900 mt-0.5 break-all">
                  {reviewPayment.invoice_code || '—'}
                </p>
              </div>
              <div>
                <p className="text-slate-400">Số tiền khai báo</p>
                <p className="font-mono font-bold text-emerald-700 mt-0.5">
                  {formatMoney(reviewPayment.amount)}
                </p>
                {Number(reviewPayment.overpayment_amount) > 0 ? (
                  <p className="text-[11px] text-indigo-600 mt-0.5">
                    Nộp thừa: {formatMoney(reviewPayment.overpayment_amount)}
                  </p>
                ) : null}
              </div>
              <div>
                <p className="text-slate-400">Mã tham chiếu</p>
                <p className="font-mono font-medium text-slate-800 mt-0.5 break-all">
                  {reviewPayment.reference_code || '—'}
                </p>
              </div>
              <div>
                <p className="text-slate-400">Trạng thái</p>
                <div className="mt-0.5">
                  <StatusBadge status={reviewPayment.status} domain="payment" />
                </div>
              </div>
              <div>
                <p className="text-slate-400">Người đối soát</p>
                <p className="font-medium text-slate-800 mt-0.5">
                  {reviewPayment.confirmed_by_name || '—'}
                </p>
              </div>
              <div>
                <p className="text-slate-400">Thời điểm xác nhận</p>
                <p className="font-medium text-slate-800 mt-0.5">
                  {reviewPayment.confirmed_at ? formatDateTime(reviewPayment.confirmed_at) : '—'}
                </p>
              </div>
            </div>

            {Array.isArray(reviewPayment.proof_images) &&
            reviewPayment.proof_images.length > 0 ? (
              <div className="space-y-2">
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Ảnh chụp chứng từ chuyển khoản ({reviewPayment.proof_images.length})
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {reviewPayment.proof_images.map((url, idx) => (
                    <div
                      key={idx}
                      className="rounded-xl border border-slate-200 bg-slate-900 overflow-hidden flex items-center justify-center max-h-80"
                    >
                      <AuthImage
                        src={url}
                        alt={`Chứng từ ${idx + 1}`}
                        className="max-h-80 w-auto object-contain"
                      />
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <p className="text-xs text-slate-500 italic py-4 text-center">
                Giao dịch này không có ảnh chụp chứng từ đính kèm.
              </p>
            )}

            {canManagePayments && reviewPayment.status === 'PENDING_CONFIRMATION' ? (
              <Input
                label="Ghi chú xác nhận đối soát (tùy chọn)"
                placeholder="VD: Đã khớp sao kê Vietcombank ngày hôm nay..."
                value={confirmNote}
                onChange={(e) => setConfirmNote(e.target.value)}
              />
            ) : reviewPayment.note ? (
              <div className="p-3 rounded-xl bg-slate-50 border border-slate-200 text-xs text-slate-700">
                <strong>Ghi chú:</strong> {reviewPayment.note}
              </div>
            ) : null}
          </div>
        ) : null}
      </Modal>

      {/* Modal nhập lý do từ chối chứng từ */}
      <Modal
        open={Boolean(rejectModalTarget)}
        onClose={() => setRejectModalTarget(null)}
        title="Từ chối chứng từ thanh toán"
        subtitle={
          rejectModalTarget
            ? `Giao dịch #${rejectModalTarget.payment_code} — Cư dân sẽ nhận được thông báo lý do từ chối.`
            : ''
        }
        size="sm"
        footer={
          <>
            <Button
              variant="outline"
              onClick={() => setRejectModalTarget(null)}
              disabled={processingAction}
            >
              Hủy
            </Button>
            <Button
              variant="danger"
              onClick={handleRejectPayment}
              loading={processingAction}
            >
              Xác nhận từ chối
            </Button>
          </>
        }
      >
        <form onSubmit={handleRejectPayment}>
          <Input
            label="Lý do từ chối chứng từ"
            required
            multiline
            rows={3}
            placeholder="VD: Ảnh chụp mờ không rõ mã giao dịch / Chưa nhận được tiền trên sao kê..."
            value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value)}
          />
        </form>
      </Modal>
    </div>
  );
}

export default PaymentsPage;
