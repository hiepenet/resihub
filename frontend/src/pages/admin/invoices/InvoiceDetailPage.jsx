import React, { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate, useSearchParams, Link } from 'react-router-dom';
import {
  ArrowLeft,
  Printer,
  Send,
  SlidersHorizontal,
  Ban,
  Wallet,
  Building2,
  User,
  Calendar,
  Eye,
  Plus,
  Trash2,
  Edit3,
  History,
  AlertTriangle,
  CheckCircle,
} from 'lucide-react';
import { Button } from '../../../components/ui/Button';
import { Input } from '../../../components/ui/Input';
import { MoneyInput } from '../../../components/ui/MoneyInput';
import { Select } from '../../../components/ui/Select';
import { Modal } from '../../../components/ui/Modal';
import { Badge } from '../../../components/ui/Badge';
import { Card, CardHeader } from '../../../components/ui/Card';
import { Table, THead, TBody, TH, TD } from '../../../components/ui/Table';
import { Tabs } from '../../../components/ui/Tabs';
import { FileUpload, AuthImage } from '../../../components/ui/FileUpload';
import { PageHeader } from '../../../components/common/PageHeader';
import { StatusBadge } from '../../../components/common/StatusBadge';
import { ConfirmDialog } from '../../../components/common/ConfirmDialog';
import { EmptyState } from '../../../components/common/EmptyState';
import { invoicesService } from '../../../services/invoices.service';
import { paymentsService } from '../../../services/payments.service';
import { usePermission } from '../../../hooks/usePermission';
import { useToast } from '../../../hooks/useToast';
import { useAuthStore } from '../../../stores/authStore';
import { formatMoney, formatDate, formatDateTime, toInputDate } from '../../../utils/format';
import { formatDateVi, getDateOrderError, minDateStr, toDateOnlyStr } from '../../../utils/dateRange';
import { extractErrorMessage } from '../../../utils/validation';
import { canConfirmInvoiceVoid, canActorApproveInvoiceAdjustment } from '../../../utils/billing';
import { stripNotificationTriggerParams } from '../../../utils/notificationNavigation';

const LINE_TYPE_LABELS = {
  RENT: { label: 'Tiền thuê phòng', variant: 'sky' },
  ELECTRICITY: { label: 'Tiền điện', variant: 'amber' },
  WATER: { label: 'Tiền nước', variant: 'sky' },
  SERVICE: { label: 'Dịch vụ tiện ích', variant: 'indigo' },
  LATE_FEE: { label: 'Phạt chậm thanh toán', variant: 'red' },
  ADJUSTMENT: { label: 'Điều chỉnh', variant: 'purple' },
  OTHER: { label: 'Khoản khác', variant: 'slate' },
};

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

const ADJUSTMENT_TARGET_OPTIONS = [
  { value: 'SERVICE', label: 'Dịch vụ tiện ích (SERVICE)' },
  { value: 'RENT', label: 'Tiền thuê phòng (RENT)' },
  { value: 'LATE_FEE', label: 'Miễn giảm/phạt chậm thanh toán (LATE_FEE)' },
  { value: 'MANUAL', label: 'Điều chỉnh thủ công khác (MANUAL)' },
];

export function InvoiceDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const toast = useToast();
  const {
    canManageInvoices,
    canManagePayments,
    canApproveInvoiceAdjustments,
    canViewFinancialAuditLogs,
    user,
  } = usePermission();
  const selectedBuildingId = useAuthStore((s) => s.selectedBuildingId);

  const [activeTab, setActiveTab] = useState('details'); // details | audit
  const [invoice, setInvoice] = useState(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  // Tab Lịch sử / Kiểm toán (PRD 8.2)
  const [auditLogs, setAuditLogs] = useState([]);
  const [auditLoading, setAuditLoading] = useState(false);

  // Danh sách đề nghị điều chỉnh 4 mắt (FR-064)
  const [adjustments, setAdjustments] = useState([]);
  const [adjLoading, setAdjLoading] = useState(false);

  // Modal thêm/sửa dòng DRAFT (PRD Mục 8.2)
  const [lineEditOpen, setLineEditOpen] = useState(false);
  const [editingLine, setEditingLine] = useState(null);
  const [lineForm, setLineForm] = useState({
    item_type: 'SERVICE',
    description: '',
    quantity: '1',
    unit_price: '',
    unit: 'tháng',
  });

  // Modal xác nhận ngữ cảnh khi phát hành (PRD 16.1)
  const [issueConfirmOpen, setIssueConfirmOpen] = useState(false);

  // Modal xác nhận 2 bước gõ lại invoice_code khi VOID (PRD 16.2)
  const [voidOpen, setVoidOpen] = useState(false);
  const [typedVoidCode, setTypedVoidCode] = useState('');
  const [voidReason, setVoidReason] = useState('');

  // Modal đề nghị điều chỉnh 4 mắt (ADJUST / LATE_FEE)
  const [adjustOpen, setAdjustOpen] = useState(false);
  const [adjustForm, setAdjustForm] = useState({
    adjustment_target: 'SERVICE',
    delta_amount: '0',
    reason: '',
    subscription_id: '',
  });

  // Modal từ chối điều chỉnh (4 mắt)
  const [rejectAdjTarget, setRejectAdjTarget] = useState(null);
  const [rejectionReason, setRejectionReason] = useState('');

  // Modal ghi nhận thu tiền nhanh
  const [payOpen, setPayOpen] = useState(false);
  const [payForm, setPayForm] = useState({
    amount: '',
    method: 'BANK_TRANSFER',
    reference_code: '',
    note: '',
    proof_image: '',
  });

  // Lightbox xem ảnh chứng từ & Modal mở tự động từ thông báo
  const [previewProof, setPreviewProof] = useState(null);
  const [reviewAdjustment, setReviewAdjustment] = useState(null);
  const [summaryModalOpen, setSummaryModalOpen] = useState(false);

  const fetchDetail = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    try {
      const res = await invoicesService.getById(id);
      setInvoice(res.data);
    } catch (err) {
      toast.error(extractErrorMessage(err, 'Không thể tải thông tin chi tiết hóa đơn.'));
    } finally {
      setLoading(false);
    }
  }, [id, toast]);

  const fetchAdjustments = useCallback(async () => {
    if (!id) return;
    setAdjLoading(true);
    try {
      const res = await invoicesService.getAdjustments({ invoice_id: id });
      setAdjustments(res.data || []);
    } catch {
      setAdjustments([]);
    } finally {
      setAdjLoading(false);
    }
  }, [id]);

  const fetchAuditLogs = useCallback(async () => {
    if (!id) return;
    setAuditLoading(true);
    try {
      const res = await invoicesService.getAuditLogs(id);
      setAuditLogs(res.data || []);
    } catch {
      setAuditLogs([]);
    } finally {
      setAuditLoading(false);
    }
  }, [id]);

  useEffect(() => {
    fetchDetail();
    fetchAdjustments();
  }, [fetchDetail, fetchAdjustments]);

  useEffect(() => {
    if (activeTab === 'audit') {
      fetchAuditLogs();
    }
  }, [activeTab, fetchAuditLogs]);

  useEffect(() => {
    const modal = searchParams.get('modal');
    if (
      modal === 'auto' &&
      !loading &&
      !adjLoading &&
      invoice &&
      String(invoice.id) === String(id)
    ) {
      setSearchParams((prev) => stripNotificationTriggerParams(prev), { replace: true });

      const pendingAdj = adjustments.find(
        (a) => a.status === 'PENDING_APPROVAL' || a.status === 'PENDING'
      );
      if (pendingAdj) {
        setReviewAdjustment(pendingAdj);
        return;
      }

      const rem = Math.max(0, Number(invoice.total_amount || 0) - Number(invoice.paid_amount || 0));
      const allowCollect =
        canManagePayments && !['DRAFT', 'VOID', 'CANCELLED'].includes(invoice.status) && rem > 0;
      if (allowCollect) {
        setPayForm({
          amount: String(rem > 0 ? rem : Number(invoice.total_amount || 0)),
          method: 'BANK_TRANSFER',
          reference_code: '',
          note: `Thu tiền hóa đơn ${invoice.invoice_code}`,
          proof_image: '',
        });
        setPayOpen(true);
        return;
      }

      setSummaryModalOpen(true);
    }
  }, [id, searchParams, setSearchParams, loading, adjLoading, invoice, adjustments, canManagePayments]);

  // --- 1. DRAFT Line Editor Handlers ---
  const openAddLineModal = () => {
    setEditingLine(null);
    setLineForm({
      item_type: 'SERVICE',
      description: '',
      quantity: '1',
      unit_price: '',
      unit: 'tháng',
    });
    setLineEditOpen(true);
  };

  const openEditLineModal = (line) => {
    setEditingLine(line);
    setLineForm({
      item_type: line.item_type || 'SERVICE',
      description: line.description || '',
      quantity: String(line.quantity || 1),
      unit_price: String(line.unit_price || 0),
      unit: line.unit || 'tháng',
    });
    setLineEditOpen(true);
  };

  const handleSaveLine = async (e) => {
    e.preventDefault();
    if (!lineForm.description.trim()) {
      toast.warning('Vui lòng nhập diễn giải chi tiết cho dòng phí.');
      return;
    }
    const qty = Number(lineForm.quantity);
    const unitPrice = Number(lineForm.unit_price);
    if (!Number.isFinite(qty) || qty <= 0) {
      toast.warning('Số lượng phải lớn hơn 0.');
      return;
    }
    if (!Number.isFinite(unitPrice) || unitPrice < 0) {
      toast.warning('Đơn giá không hợp lệ.');
      return;
    }

    setSubmitting(true);
    try {
      const payload = {
        item_type: lineForm.item_type,
        description: lineForm.description.trim(),
        quantity: qty,
        unit_price: Math.round(unitPrice),
        unit: lineForm.unit.trim() || 'lần',
      };
      if (editingLine) {
        await invoicesService.updateLine(invoice.id, editingLine.id, payload);
        toast.success('Đã cập nhật dòng khoản phí.');
      } else {
        await invoicesService.addLine(invoice.id, payload);
        toast.success('Đã thêm dòng khoản phí mới vào bản nháp.');
      }
      setLineEditOpen(false);
      fetchDetail();
    } catch (err) {
      toast.error(extractErrorMessage(err, 'Không thể lưu dòng chi tiết khoản phí.'));
    } finally {
      setSubmitting(false);
    }
  };

  const handleDeleteLine = async (line) => {
    if (!window.confirm(`Bạn có chắc chắn muốn xóa dòng "${line.description}" khỏi hóa đơn nháp?`)) {
      return;
    }
    setSubmitting(true);
    try {
      await invoicesService.deleteLine(invoice.id, line.id);
      toast.success('Đã xóa dòng khoản phí.');
      fetchDetail();
    } catch (err) {
      toast.error(extractErrorMessage(err, 'Không thể xóa dòng khoản phí.'));
    } finally {
      setSubmitting(false);
    }
  };

  // --- 2. Contextual Issue Handler (PRD 16.1) ---
  const handleConfirmIssue = async () => {
    if (!invoice) return;
    setSubmitting(true);
    try {
      const res = await invoicesService.issue(invoice.id);
      toast.success(res.message || 'Đã phát hành hóa đơn và thông báo cho cư dân.');
      setIssueConfirmOpen(false);
      fetchDetail();
    } catch (err) {
      toast.error(extractErrorMessage(err, 'Không thể phát hành hóa đơn.'));
    } finally {
      setSubmitting(false);
    }
  };

  // --- 3. 2-Step VOID Handler (PRD 16.2) ---
  const handleConfirmVoid = async () => {
    if (!invoice) return;
    const canVoid = canConfirmInvoiceVoid({
      invoice,
      typedInvoiceCode: typedVoidCode,
      reason: voidReason,
    });
    if (!canVoid) {
      toast.warning('Vui lòng gõ chính xác mã hóa đơn và nhập lý do hủy đầy đủ.');
      return;
    }

    setSubmitting(true);
    try {
      const res = await invoicesService.requestAdjustment(invoice.id, {
        action_type: 'VOID',
        confirm_invoice_code: typedVoidCode.trim(),
        reason: voidReason.trim(),
      });
      toast.success(res.message || 'Đã lập đề nghị hủy hóa đơn (chờ duyệt 4 mắt).');
      setVoidOpen(false);
      setTypedVoidCode('');
      setVoidReason('');
      fetchDetail();
      fetchAdjustments();
    } catch (err) {
      toast.error(extractErrorMessage(err, 'Không thể gửi đề nghị hủy hóa đơn.'));
    } finally {
      setSubmitting(false);
    }
  };

  // --- 4. 4-Eyes Adjust Handlers (FR-064) ---
  const openAdjustModal = () => {
    if (!invoice) return;
    setAdjustForm({
      adjustment_target: invoice.invoice_type === 'LATE_FEE_SETTLEMENT' ? 'LATE_FEE' : 'SERVICE',
      delta_amount: '0',
      reason: '',
      subscription_id: '',
    });
    setAdjustOpen(true);
  };

  const handleSaveAdjustment = async (e) => {
    e.preventDefault();
    if (!invoice) return;
    const deltaNum = Math.round(Number(adjustForm.delta_amount || 0));
    if (deltaNum === 0) {
      toast.warning('Số tiền điều chỉnh delta phải khác 0 (dương để tăng, âm để giảm).');
      return;
    }
    if (!adjustForm.reason.trim()) {
      toast.warning('Vui lòng nhập lý do điều chỉnh bắt buộc.');
      return;
    }

    setSubmitting(true);
    try {
      const res = await invoicesService.requestAdjustment(invoice.id, {
        action_type: 'ADJUST',
        adjustment_target: adjustForm.adjustment_target,
        delta_amount: deltaNum,
        reason: adjustForm.reason.trim(),
        subscription_id: adjustForm.subscription_id || undefined,
      });
      toast.success(res.message || 'Đã tạo đề nghị điều chỉnh hóa đơn (chờ duyệt 4 mắt).');
      setAdjustOpen(false);
      fetchDetail();
      fetchAdjustments();
    } catch (err) {
      toast.error(extractErrorMessage(err, 'Không thể tạo đề nghị điều chỉnh hóa đơn.'));
    } finally {
      setSubmitting(false);
    }
  };

  const handleApproveAdjustment = async (adj) => {
    if (!window.confirm('Xác nhận phê duyệt đề nghị điều chỉnh hóa đơn này? Thay đổi sẽ cập nhật trực tiếp vào số dư công nợ.')) {
      return;
    }
    setSubmitting(true);
    try {
      const res = await invoicesService.approveAdjustment(invoice.id, adj.id);
      toast.success(res.message || 'Đã phê duyệt điều chỉnh hóa đơn thành công.');
      fetchDetail();
      fetchAdjustments();
    } catch (err) {
      toast.error(extractErrorMessage(err, 'Không thể phê duyệt điều chỉnh hóa đơn.'));
    } finally {
      setSubmitting(false);
    }
  };

  const handleRejectAdjustment = async () => {
    if (!rejectAdjTarget) return;
    if (!rejectionReason.trim()) {
      toast.warning('Vui lòng nhập lý do từ chối.');
      return;
    }
    setSubmitting(true);
    try {
      const res = await invoicesService.rejectAdjustment(invoice.id, rejectAdjTarget.id, {
        rejection_reason: rejectionReason.trim(),
      });
      toast.success(res.message || 'Đã từ chối đề nghị điều chỉnh hóa đơn.');
      setRejectAdjTarget(null);
      setRejectionReason('');
      fetchDetail();
      fetchAdjustments();
    } catch (err) {
      toast.error(extractErrorMessage(err, 'Không thể từ chối đề nghị điều chỉnh.'));
    } finally {
      setSubmitting(false);
    }
  };

  // --- 5. Quick Pay Handler ---
  const openQuickPayModal = () => {
    if (!invoice) return;
    const rem = Math.max(0, Number(invoice.total_amount || 0) - Number(invoice.paid_amount || 0));
    setPayForm({
      amount: String(rem > 0 ? rem : Number(invoice.total_amount || 0)),
      method: 'BANK_TRANSFER',
      reference_code: '',
      note: `Thu tiền hóa đơn ${invoice.invoice_code}`,
      proof_image: '',
    });
    setPayOpen(true);
  };

  const handleSaveQuickPayment = async (e) => {
    e.preventDefault();
    if (!invoice) return;
    const amt = Math.round(Number(payForm.amount || 0));
    if (!amt || amt <= 0) {
      toast.warning('Số tiền thanh toán phải lớn hơn 0.');
      return;
    }

    setSubmitting(true);
    try {
      const res = await paymentsService.create({
        invoice_id: invoice.id,
        amount: amt,
        method: payForm.method,
        reference_code: payForm.reference_code.trim() || undefined,
        note: payForm.note.trim() || undefined,
        proof_images: payForm.proof_image ? [payForm.proof_image] : [],
      });
      toast.success(res.message || 'Ghi nhận thanh toán thành công.');
      setPayOpen(false);
      fetchDetail();
    } catch (err) {
      toast.error(extractErrorMessage(err, 'Không thể ghi nhận thanh toán.'));
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="h-20 bg-white rounded-xl border border-slate-200 animate-pulse" />
        <div className="h-96 bg-white rounded-xl border border-slate-200 animate-pulse" />
      </div>
    );
  }

  if (!invoice) {
    return (
      <Card>
        <EmptyState
          title="Không tìm thấy hóa đơn"
          description="Hóa đơn không tồn tại hoặc bạn không có quyền truy cập tòa nhà của hóa đơn này."
          action={
            <Button variant="outline" icon={ArrowLeft} onClick={() => navigate('/admin/invoices')}>
              Quay lại danh sách hóa đơn
            </Button>
          }
        />
      </Card>
    );
  }

  const remaining = Math.max(
    0,
    Number(invoice.total_amount || 0) - Number(invoice.paid_amount || 0)
  );
  const isDraft = invoice.status === 'DRAFT';
  const isVoid = invoice.status === 'VOID';
  const isCancelled = invoice.status === 'CANCELLED';
  const isSettlement = invoice.invoice_type === 'LATE_FEE_SETTLEMENT';
  const isRegular = (invoice.invoice_type || 'REGULAR') === 'REGULAR';
  const periodLabel = invoice.period || 'Tất toán kỳ cuối';

  const canRequestAdjust = canManageInvoices && !isDraft && !isVoid && !isCancelled;
  const canVoidInvoice = canManageInvoices && !isDraft && !isVoid && !isCancelled && Number(invoice.paid_amount || 0) === 0;
  const canCollect = canManagePayments && !isDraft && !isVoid && !isCancelled && remaining > 0;

  return (
    <div className="space-y-6">
      <PageHeader
        breadcrumbs={[
          { label: 'Hóa đơn kỳ', to: '/admin/invoices' },
          { label: invoice.invoice_code },
        ]}
        title={`Chi tiết Hóa đơn ${invoice.invoice_code}`}
        subtitle={`${invoice.period ? `Kỳ thanh toán ${invoice.period}` : 'Phí phạt tất toán kỳ cuối'} • Căn ${invoice.apartment_code} (${invoice.building_name})`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Link to="/admin/invoices">
              <Button variant="outline" icon={ArrowLeft}>
                Quay lại
              </Button>
            </Link>

            <Button variant="outline" icon={Printer} onClick={() => window.print()}>
              In hóa đơn PDF
            </Button>

            {canManageInvoices && isDraft && !isSettlement ? (
              <Button
                variant="primary"
                icon={Send}
                loading={submitting}
                onClick={() => setIssueConfirmOpen(true)}
              >
                Phát hành hóa đơn
              </Button>
            ) : null}

            {canRequestAdjust ? (
              <Button variant="outline" icon={SlidersHorizontal} onClick={openAdjustModal}>
                Đề nghị điều chỉnh (4 mắt)
              </Button>
            ) : null}

            {canCollect ? (
              <Button variant="success" icon={Wallet} onClick={openQuickPayModal}>
                Ghi nhận thu tiền
              </Button>
            ) : null}

            {canVoidInvoice ? (
              <Button variant="danger" icon={Ban} onClick={() => setVoidOpen(true)}>
                Hủy hóa đơn (VOID)
              </Button>
            ) : null}
          </div>
        }
      />

      {/* Tabs Chuyển đổi: Chi tiết hóa đơn vs Lịch sử / Kiểm toán (PRD 8.2) */}
      <div className="bg-white rounded-xl border border-slate-200 px-4 pt-2">
        <Tabs
          activeTab={activeTab}
          onChange={setActiveTab}
          tabs={[
            { id: 'details', label: 'Tờ hóa đơn chi tiết' },
            ...(canViewFinancialAuditLogs
              ? [
                  {
                    id: 'audit',
                    label: 'Lịch sử / Kiểm toán',
                    icon: History,
                    count: auditLogs.length || undefined,
                  },
                ]
              : []),
          ]}
        />
      </div>

      {activeTab === 'details' ? (
        <div className="space-y-6">
          {invoice.status === 'OVERDUE' && isRegular ? (
            <div className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-xl p-3">
              ℹ️ Phí phạt chậm thanh toán đang tích lũy và sẽ được đưa vào hóa đơn kỳ kế tiếp.
            </div>
          ) : null}

          {/* Tờ Hóa Đơn Chuẩn Chuyên Nghiệp (Hỗ trợ in A4 PDF) */}
          <div className="bg-white rounded-2xl border border-slate-200 shadow-card p-6 sm:p-8 print-area space-y-8">
            {/* Header Tờ Hóa Đơn */}
            <div className="flex flex-col sm:flex-row justify-between items-start gap-6 border-b border-slate-200 pb-6">
              <div className="space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xl font-bold tracking-tight text-slate-900">
                    {isSettlement ? 'HÓA ĐƠN PHÍ PHẠT TẤT TOÁN' : 'HÓA ĐƠN THU TIỀN KỲ'}
                  </span>
                  <StatusBadge status={invoice.status} domain="invoice" />
                  {isSettlement ? (
                    <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-amber-100 text-amber-800">
                      Phí phạt tất toán
                    </span>
                  ) : null}
                </div>
                <p className="font-mono text-sm font-semibold text-primary-700">
                  Mã số: {invoice.invoice_code}
                </p>
                <p className="text-xs text-slate-500">
                  Đơn vị quản lý: <strong>{invoice.building_name}</strong>
                </p>
              </div>

              <div className="sm:text-right space-y-1 text-xs text-slate-600">
                <p>
                  Kỳ đối soát: <strong className="text-slate-900">{periodLabel}</strong>
                </p>
                <p>
                  Hạn thanh toán:{' '}
                  <strong className="text-rose-600">{formatDate(invoice.due_date)}</strong>
                </p>
                <p>
                  Ngày lập:{' '}
                  <span className="text-slate-700">
                    {formatDate(invoice.issue_date || invoice.created_at)}
                  </span>
                </p>
              </div>
            </div>

            {/* Thông tin Căn hộ & Khách thuê */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 p-4 rounded-xl bg-slate-50 border border-slate-100 text-xs">
              <div className="space-y-1.5">
                <div className="flex items-center gap-2 font-semibold text-slate-800">
                  <Building2 className="w-4 h-4 text-primary-600" />
                  <span>CĂN HỘ / MẶT BẰNG</span>
                </div>
                <p className="font-medium text-slate-900 text-sm">Căn {invoice.apartment_code}</p>
                <p className="text-slate-500">{invoice.building_name}</p>
                <p className="font-mono text-[11px] text-slate-400">HĐ: {invoice.contract_code}</p>
              </div>

              <div className="space-y-1.5">
                <div className="flex items-center gap-2 font-semibold text-slate-800">
                  <User className="w-4 h-4 text-primary-600" />
                  <span>NGƯỜI THANH TOÁN (CƯ DÂN)</span>
                </div>
                <p className="font-medium text-slate-900 text-sm">
                  {invoice.tenant_name || 'Khách thuê'}
                </p>
                <p className="text-slate-600">{invoice.tenant_phone || 'Chưa cập nhật SĐT'}</p>
                <p className="text-slate-400">{invoice.tenant_email || ''}</p>
              </div>
            </div>

            {/* Bảng chi tiết khoản thu (DRAFT line editor) */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-slate-900">
                  Chi tiết các khoản phí trong kỳ
                </h3>
                {canManageInvoices && isDraft && !isSettlement ? (
                  <Button size="xs" variant="outline" icon={Plus} onClick={openAddLineModal}>
                    Thêm dòng phí
                  </Button>
                ) : null}
              </div>

              <div className="border border-slate-200 rounded-xl overflow-hidden">
                <Table>
                  <THead>
                    <tr>
                      <TH className="w-12 text-center">STT</TH>
                      <TH className="text-center">Hạng mục</TH>
                      <TH>Diễn giải chi tiết</TH>
                      <TH className="text-center">Số lượng</TH>
                      <TH className="text-center">ĐVT</TH>
                      <TH className="text-right">Đơn giá</TH>
                      <TH className="text-right">Thành tiền</TH>
                      {isDraft && !isSettlement && canManageInvoices ? (
                        <TH className="w-20 text-center">Thao tác</TH>
                      ) : null}
                    </tr>
                  </THead>
                  <TBody>
                    {(invoice.lines || []).length === 0 ? (
                      <tr>
                        <TD colSpan={isDraft && !isSettlement ? 8 : 7} className="text-center text-slate-400 py-6">
                          Chưa có dòng chi tiết khoản phí nào.
                        </TD>
                      </tr>
                    ) : (
                      invoice.lines.map((line, idx) => {
                        const typeMeta = LINE_TYPE_LABELS[line.item_type] || LINE_TYPE_LABELS.OTHER;
                        return (
                          <tr key={line.id || idx}>
                            <TD className="text-center text-xs text-slate-400">{idx + 1}</TD>
                            <TD className="text-center">
                              <Badge variant={typeMeta.variant}>{typeMeta.label}</Badge>
                            </TD>
                            <TD className="font-medium text-slate-800">
                              {line.description}
                              {line.formula_meta?.description ? (
                                <p className="text-[11px] font-normal text-slate-500">
                                  {line.formula_meta.description}
                                </p>
                              ) : null}
                            </TD>
                            <TD className="text-center font-mono whitespace-nowrap">
                              {Number(line.quantity)}
                            </TD>
                            <TD className="text-center text-slate-500 whitespace-nowrap">
                              {line.unit || 'tháng'}
                            </TD>
                            <TD className="text-right font-mono tabular-nums whitespace-nowrap">
                              {formatMoney(line.unit_price)}
                            </TD>
                            <TD
                              className={`text-right font-mono tabular-nums font-semibold whitespace-nowrap ${
                                Number(line.amount) < 0 ? 'text-emerald-600' : 'text-slate-900'
                              }`}
                            >
                              {Number(line.amount) > 0 && line.item_type === 'ADJUSTMENT' ? '+' : ''}
                              {formatMoney(line.amount)}
                            </TD>
                            {isDraft && !isSettlement && canManageInvoices ? (
                              <TD className="text-center">
                                {line.item_type === 'LATE_FEE' || Boolean(line.credit_id) ? (
                                  <span className="text-[11px] text-slate-400">Tự động</span>
                                ) : (
                                  <div className="inline-flex items-center gap-1">
                                    <button
                                      type="button"
                                      onClick={() => openEditLineModal(line)}
                                      className="p-1 rounded text-slate-500 hover:text-primary-600 hover:bg-slate-100"
                                      title="Sửa dòng"
                                    >
                                      <Edit3 className="w-3.5 h-3.5" />
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => handleDeleteLine(line)}
                                      className="p-1 rounded text-slate-500 hover:text-rose-600 hover:bg-rose-50"
                                      title="Xóa dòng"
                                    >
                                      <Trash2 className="w-3.5 h-3.5" />
                                    </button>
                                  </div>
                                )}
                              </TD>
                            ) : null}
                          </tr>
                        );
                      })
                    )}
                  </TBody>
                </Table>
              </div>
            </div>

            {/* Tổng hợp tài chính */}
            <div className="flex flex-col sm:flex-row justify-between items-start sm:items-end gap-6 pt-4 border-t border-slate-200">
              <div className="space-y-1 text-xs text-slate-500 max-w-sm">
                <p>
                  * Hóa đơn điện tử nội bộ phát hành theo quy chế quản lý tòa nhà ResiHub.
                </p>
                <p>
                  * Mọi thắc mắc về số liệu vui lòng liên hệ Ban quản lý trước hạn thanh toán.
                </p>
              </div>

              <div className="w-full sm:w-80 space-y-2 text-xs">
                <div className="flex justify-between text-slate-600">
                  <span>Cộng tiền trước điều chỉnh:</span>
                  <span className="font-mono tabular-nums font-medium">
                    {formatMoney(invoice.subtotal_amount)}
                  </span>
                </div>

                {Number(invoice.adjustment_amount) !== 0 ? (
                  <div className="flex justify-between text-indigo-700 font-medium">
                    <span>Điều chỉnh:</span>
                    <span className="font-mono tabular-nums">
                      {Number(invoice.adjustment_amount) > 0 ? '+' : ''}
                      {formatMoney(invoice.adjustment_amount)}
                    </span>
                  </div>
                ) : null}

                {Number(invoice.credit_offset_amount || 0) > 0 ? (
                  <div className="flex justify-between text-emerald-700 font-medium">
                    <span>Tín dụng cấn trừ kỳ trước:</span>
                    <span className="font-mono tabular-nums">
                      -{formatMoney(invoice.credit_offset_amount)}
                    </span>
                  </div>
                ) : null}

                <div className="flex justify-between items-center pt-2 border-t border-slate-200 text-sm font-bold text-slate-900">
                  <span>TỔNG CỘNG PHẢI THU:</span>
                  <span className="text-base text-primary-700 font-mono">
                    {formatMoney(invoice.total_amount)}
                  </span>
                </div>

                <div className="flex justify-between text-emerald-700 font-medium pt-1">
                  <span>Đã thanh toán thực tế:</span>
                  <span className="font-mono tabular-nums">{formatMoney(invoice.paid_amount)}</span>
                </div>

                <div className="flex justify-between text-sm font-bold pt-1 border-t border-dashed border-slate-200">
                  <span>CÒN PHẢI THU:</span>
                  <span
                    className={`font-mono ${
                      remaining > 0 && !isVoid && !isCancelled ? 'text-rose-600' : 'text-slate-400'
                    }`}
                  >
                    {isVoid || isCancelled ? '0 ₫' : formatMoney(remaining)}
                  </span>
                </div>
              </div>
            </div>
          </div>

          {/* Danh sách đề nghị điều chỉnh hóa đơn 4 mắt (FR-064) */}
          {adjustments.length > 0 ? (
            <Card className="p-5 space-y-3">
              <CardHeader
                title="Đề nghị điều chỉnh hóa đơn (Quy trình 4 mắt)"
                subtitle="Lịch sử các đề nghị tăng/giảm hoặc hủy hóa đơn được lập và phê duyệt độc lập."
              />
              <div className="border border-slate-200 rounded-xl overflow-hidden">
                <Table>
                  <THead>
                    <tr>
                      <TH className="text-center">Trạng thái</TH>
                      <TH className="text-center">Loại</TH>
                      <TH className="text-right">Số tiền thay đổi</TH>
                      <TH>Lý do đề xuất</TH>
                      <TH className="text-center">Thời gian</TH>
                      <TH className="text-center">Thao tác</TH>
                    </tr>
                  </THead>
                  <TBody>
                    {adjustments.map((adj) => {
                      const canApprove = canActorApproveInvoiceAdjustment({
                        actor: user,
                        record: adj,
                        buildingHasActiveOwner: true,
                      }) && canApproveInvoiceAdjustments && adj.status === 'PENDING_APPROVAL';

                      return (
                        <tr key={adj.id}>
                          <TD className="text-center">
                            <StatusBadge status={adj.status} domain="invoice_adjustment" />
                          </TD>
                          <TD className="text-center">
                            <Badge variant={adj.action_type === 'VOID' ? 'slate' : 'purple'} size="xs">
                              {adj.action_type === 'VOID' ? 'HỦY HÓA ĐƠN' : adj.adjustment_target}
                            </Badge>
                          </TD>
                          <TD className="text-right font-mono font-semibold text-slate-800">
                            {adj.delta_amount != null
                              ? `${Number(adj.delta_amount) > 0 ? '+' : ''}${formatMoney(adj.delta_amount)}`
                              : '—'}
                          </TD>
                          <TD className="text-xs text-slate-700 max-w-xs break-words">
                            {adj.reason}
                            {adj.rejection_reason ? (
                              <p className="text-rose-600 mt-0.5">
                                Lý do từ chối: {adj.rejection_reason}
                              </p>
                            ) : null}
                          </TD>
                          <TD className="text-center text-xs text-slate-500 whitespace-nowrap">
                            {formatDateTime(adj.created_at)}
                          </TD>
                          <TD className="text-center whitespace-nowrap">
                            {canApprove ? (
                              <div className="inline-flex items-center gap-1.5">
                                <Button
                                  size="xs"
                                  variant="success"
                                  icon={CheckCircle}
                                  loading={submitting}
                                  onClick={() => handleApproveAdjustment(adj)}
                                >
                                  Duyệt
                                </Button>
                                <Button
                                  size="xs"
                                  variant="danger"
                                  loading={submitting}
                                  onClick={() => {
                                    setRejectAdjTarget(adj);
                                    setRejectionReason('');
                                  }}
                                >
                                  Từ chối
                                </Button>
                              </div>
                            ) : (
                              <span className="text-xs text-slate-400">—</span>
                            )}
                          </TD>
                        </tr>
                      );
                    })}
                  </TBody>
                </Table>
              </div>
            </Card>
          ) : null}
        </div>
      ) : (
        /* TAB 2: LỊCH SỬ / KIỂM TOÁN (PRD 8.2) */
        <Card className="p-5 space-y-4">
          <CardHeader
            title="Nhật ký kiểm toán tài chính hóa đơn"
            subtitle="Toàn bộ lịch sử thêm dòng nháp, phát hành, yêu cầu điều chỉnh và phê duyệt 4 mắt."
          />
          {auditLoading ? (
            <div className="py-10 text-center text-xs text-slate-400">
              Đang tải nhật ký kiểm toán...
            </div>
          ) : auditLogs.length === 0 ? (
            <div className="py-10 text-center text-xs text-slate-500">
              Chưa có bản ghi kiểm toán nào được tạo cho hóa đơn này.
            </div>
          ) : (
            <div className="border border-slate-200 rounded-xl overflow-hidden">
              <Table>
                <THead>
                  <tr>
                    <TH className="w-40 text-center">Thời gian</TH>
                    <TH>Hành động</TH>
                    <TH>Người thực hiện</TH>
                    <TH>Chi tiết thay đổi</TH>
                  </tr>
                </THead>
                <TBody>
                  {auditLogs.map((log) => (
                    <tr key={log.id}>
                      <TD className="text-center font-mono text-xs text-slate-500 whitespace-nowrap">
                        {formatDateTime(log.created_at)}
                      </TD>
                      <TD>
                        <Badge variant="indigo" size="xs">
                          {log.action}
                        </Badge>
                      </TD>
                      <TD className="text-xs font-medium text-slate-800">
                        {log.actor_name || log.actor_email || log.actor_id || 'Hệ thống'}
                      </TD>
                      <TD className="text-xs text-slate-600 max-w-md break-words font-mono text-[11px]">
                        {log.after ? JSON.stringify(log.after) : log.before ? JSON.stringify(log.before) : '—'}
                      </TD>
                    </tr>
                  ))}
                </TBody>
              </Table>
            </div>
          )}
        </Card>
      )}

      {/* Modal thêm / sửa dòng DRAFT (PRD 8.2) */}
      <Modal
        open={lineEditOpen}
        onClose={() => setLineEditOpen(false)}
        title={editingLine ? 'Chỉnh sửa khoản phí' : 'Thêm khoản phí vào hóa đơn nháp'}
        size="md"
        footer={
          <>
            <Button variant="outline" onClick={() => setLineEditOpen(false)} disabled={submitting}>
              Hủy
            </Button>
            <Button variant="primary" onClick={handleSaveLine} loading={submitting}>
              {editingLine ? 'Lưu thay đổi' : 'Thêm dòng'}
            </Button>
          </>
        }
      >
        <form onSubmit={handleSaveLine} className="space-y-4">
          <Select
            label="Loại khoản phí"
            value={lineForm.item_type}
            onChange={(e) => setLineForm((s) => ({ ...s, item_type: e.target.value }))}
            options={Object.entries(LINE_TYPE_LABELS)
              .filter(([value]) => value !== 'LATE_FEE')
              .map(([value, info]) => ({
                value,
                label: info.label,
              }))}
          />
          <Input
            label="Diễn giải chi tiết"
            required
            placeholder="VD: Phí giặt là tháng 11, Sửa khóa căn hộ..."
            value={lineForm.description}
            onChange={(e) => setLineForm((s) => ({ ...s, description: e.target.value }))}
          />
          <div className="grid grid-cols-3 gap-3">
            <Input
              label="Số lượng"
              type="number"
              min="0.01"
              step="any"
              required
              value={lineForm.quantity}
              onChange={(e) => setLineForm((s) => ({ ...s, quantity: e.target.value }))}
            />
            <Input
              label="Đơn vị tính"
              value={lineForm.unit}
              onChange={(e) => setLineForm((s) => ({ ...s, unit: e.target.value }))}
            />
            <MoneyInput
              label="Đơn giá (₫)"
              required
              value={lineForm.unit_price}
              onChange={(e) => setLineForm((s) => ({ ...s, unit_price: e.target.value }))}
            />
          </div>
        </form>
      </Modal>

      {/* Hộp thoại xác nhận ngữ cảnh khi phát hành (PRD 16.1) */}
      <Modal
        open={issueConfirmOpen}
        onClose={() => setIssueConfirmOpen(false)}
        title="Xác nhận phát hành hóa đơn"
        subtitle="Vui lòng rà soát kỹ số tiền trước khi công bố tới cư dân."
        size="md"
        footer={
          <>
            <Button
              variant="outline"
              onClick={() => setIssueConfirmOpen(false)}
              disabled={submitting}
            >
              Hủy
            </Button>
            <Button
              variant="primary"
              icon={Send}
              onClick={handleConfirmIssue}
              loading={submitting}
            >
              Xác nhận phát hành ngay
            </Button>
          </>
        }
      >
        <div className="space-y-4 text-xs">
          <div className="p-4 rounded-xl bg-sky-50 border border-sky-200 space-y-2">
            <div className="flex justify-between">
              <span className="text-slate-600">Mã hóa đơn:</span>
              <span className="font-mono font-bold text-slate-900">{invoice.invoice_code}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-600">Căn hộ:</span>
              <span className="font-semibold text-slate-900">
                Căn {invoice.apartment_code} ({invoice.tenant_name || 'Khách thuê'})
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-600">Tổng tiền phát hành:</span>
              <span className="font-mono font-bold text-base text-primary-700">
                {formatMoney(invoice.total_amount)}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-600">Hạn thanh toán:</span>
              <span className="font-semibold text-rose-600">{formatDate(invoice.due_date)}</span>
            </div>
          </div>

          <div className="p-3.5 rounded-xl bg-amber-50 border border-amber-200 flex items-start gap-2.5 text-amber-900">
            <AlertTriangle className="w-4 h-4 text-amber-600 mt-0.5 flex-shrink-0" />
            <p className="leading-relaxed">
              <strong>Lưu ý bất biến:</strong> Sau khi phát hành, hóa đơn sẽ bị khóa bất biến
              (không được thêm, sửa, xóa dòng trực tiếp). Mọi điều chỉnh sau đó bắt buộc phải tạo
              đề nghị qua quy trình kiểm duyệt 4 mắt. Cư dân sẽ nhận được thông báo nợ phí ngay lập tức.
            </p>
          </div>
        </div>
      </Modal>

      {/* Hộp thoại xác nhận 2 bước gõ lại invoice_code khi VOID (PRD 16.2) */}
      <Modal
        open={voidOpen}
        onClose={() => setVoidOpen(false)}
        title="Xác nhận Hủy hóa đơn đã phát hành (VOID)"
        subtitle="Yêu cầu kiểm soát 2 bước an toàn để tránh thao tác nhầm lẫn."
        size="md"
        footer={
          <>
            <Button variant="outline" onClick={() => setVoidOpen(false)} disabled={submitting}>
              Đóng
            </Button>
            <Button
              variant="danger"
              icon={Ban}
              onClick={handleConfirmVoid}
              loading={submitting}
              disabled={
                !canConfirmInvoiceVoid({
                  invoice,
                  typedInvoiceCode: typedVoidCode,
                  reason: voidReason,
                })
              }
            >
              Xác nhận gửi đề nghị VOID
            </Button>
          </>
        }
      >
        <div className="space-y-4 text-xs">
          <div className="p-3.5 rounded-xl bg-rose-50 border border-rose-200 text-rose-900 space-y-1">
            <p className="font-semibold">Cảnh báo hủy hóa đơn sau phát hành:</p>
            <p className="leading-relaxed">
              Đề nghị hủy (VOID) sẽ được gửi đến cấp thẩm quyền (OWNER / 4-Eyes) phê duyệt. Sau khi duyệt,
              hóa đơn và công nợ liên quan sẽ được hủy bỏ hoàn toàn.
            </p>
          </div>

          <div className="space-y-1.5">
            <label className="block font-semibold text-slate-800">
              Bước 1: Gõ lại chính xác mã hóa đơn{' '}
              <span className="font-mono font-bold text-rose-600 select-all">
                {invoice.invoice_code}
              </span>{' '}
              để xác nhận
            </label>
            <Input
              value={typedVoidCode}
              onChange={(e) => setTypedVoidCode(e.target.value)}
              placeholder={`Gõ lại "${invoice.invoice_code}"`}
              className="font-mono font-semibold"
            />
          </div>

          <div className="space-y-1.5">
            <label className="block font-semibold text-slate-800">
              Bước 2: Nhập lý do hủy bắt buộc <span className="text-rose-500">*</span>
            </label>
            <Input
              multiline
              rows={2}
              required
              value={voidReason}
              onChange={(e) => setVoidReason(e.target.value)}
              placeholder="VD: Khách đã thanh lý hợp đồng và dọn đi trước kỳ hóa đơn..."
            />
          </div>
        </div>
      </Modal>

      {/* Modal đề nghị điều chỉnh 4 mắt (ADJUST / LATE_FEE) */}
      <Modal
        open={adjustOpen}
        onClose={() => setAdjustOpen(false)}
        title="Lập đề nghị điều chỉnh hóa đơn"
        subtitle="Tạo đề nghị tăng/giảm số tiền hóa đơn để gửi phê duyệt 4 mắt."
        size="md"
        footer={
          <>
            <Button variant="outline" onClick={() => setAdjustOpen(false)} disabled={submitting}>
              Hủy
            </Button>
            <Button variant="primary" onClick={handleSaveAdjustment} loading={submitting}>
              Gửi đề nghị điều chỉnh
            </Button>
          </>
        }
      >
        <form onSubmit={handleSaveAdjustment} className="space-y-4">
          <Select
            label="Mục tiêu điều chỉnh"
            value={adjustForm.adjustment_target}
            onChange={(e) => setAdjustForm((s) => ({ ...s, adjustment_target: e.target.value }))}
            options={ADJUSTMENT_TARGET_OPTIONS}
          />

          <MoneyInput
            label="Số tiền điều chỉnh delta (₫)"
            required
            hint="Nhập số âm để giảm trừ (VD: -150.000) hoặc số dương để tính bổ sung."
            value={adjustForm.delta_amount}
            onChange={(e) => setAdjustForm((s) => ({ ...s, delta_amount: e.target.value }))}
          />

          <Input
            label="Lý do điều chỉnh bắt buộc"
            multiline
            rows={2}
            required
            placeholder="VD: Giảm trừ phí dịch vụ do ngắt mạng 3 ngày, hoặc miễn giảm phí chậm nộp..."
            value={adjustForm.reason}
            onChange={(e) => setAdjustForm((s) => ({ ...s, reason: e.target.value }))}
          />
        </form>
      </Modal>

      {/* Modal từ chối điều chỉnh (4 mắt) */}
      <Modal
        open={Boolean(rejectAdjTarget)}
        onClose={() => setRejectAdjTarget(null)}
        title="Từ chối đề nghị điều chỉnh hóa đơn"
        size="sm"
        footer={
          <>
            <Button variant="outline" onClick={() => setRejectAdjTarget(null)} disabled={submitting}>
              Đóng
            </Button>
            <Button variant="danger" onClick={handleRejectAdjustment} loading={submitting}>
              Xác nhận từ chối
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <p className="text-xs text-slate-600">
            Vui lòng nhập lý do từ chối đề nghị điều chỉnh để người lập được biết:
          </p>
          <Input
            label="Lý do từ chối"
            multiline
            rows={2}
            required
            value={rejectionReason}
            onChange={(e) => setRejectionReason(e.target.value)}
            placeholder="VD: Không đủ căn cứ chứng minh sự cố gián đoạn dịch vụ..."
          />
        </div>
      </Modal>

      {/* Modal ghi nhận thu tiền nhanh */}
      <Modal
        open={payOpen}
        onClose={() => setPayOpen(false)}
        title="Ghi nhận thu tiền nhanh"
        subtitle={`Hóa đơn ${invoice.invoice_code} • Căn ${invoice.apartment_code}`}
        size="md"
        footer={
          <>
            <Button variant="outline" onClick={() => setPayOpen(false)} disabled={submitting}>
              Hủy
            </Button>
            <Button variant="success" icon={Wallet} onClick={handleSaveQuickPayment} loading={submitting}>
              Xác nhận thu tiền
            </Button>
          </>
        }
      >
        <form onSubmit={handleSaveQuickPayment} className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <MoneyInput
              label="Số tiền thu (₫)"
              required
              value={payForm.amount}
              onChange={(e) => setPayForm((s) => ({ ...s, amount: e.target.value }))}
            />
            <Select
              label="Phương thức"
              value={payForm.method}
              onChange={(e) => setPayForm((s) => ({ ...s, method: e.target.value }))}
              options={PAYMENT_METHOD_OPTIONS}
            />
          </div>

          <Input
            label="Mã giao dịch ngân hàng / Số biên lai"
            placeholder="VD: FT2630291823..."
            value={payForm.reference_code}
            onChange={(e) => setPayForm((s) => ({ ...s, reference_code: e.target.value }))}
          />

          <Input
            label="Ghi chú thu tiền"
            value={payForm.note}
            onChange={(e) => setPayForm((s) => ({ ...s, note: e.target.value }))}
          />

          <FileUpload
            label="Ảnh chụp chứng từ / Ủy nhiệm chi (tùy chọn)"
            multiple={false}
            value={payForm.proof_image}
            onChange={(img) => setPayForm((s) => ({ ...s, proof_image: img }))}
          />
        </form>
      </Modal>

      {/* Modal xem chi tiết / phê duyệt đề nghị điều chỉnh hóa đơn (4 mắt) */}
      <Modal
        open={Boolean(reviewAdjustment)}
        onClose={() => setReviewAdjustment(null)}
        title="Phê duyệt Đề nghị Điều chỉnh Hóa đơn (4 mắt)"
        subtitle={
          reviewAdjustment
            ? `Hóa đơn ${invoice.invoice_code} • Căn ${invoice.apartment_code} (${invoice.building_name})`
            : ''
        }
        size="md"
        footer={
          reviewAdjustment ? (
            <>
              <Button variant="outline" onClick={() => setReviewAdjustment(null)} disabled={submitting}>
                Đóng
              </Button>
              {canActorApproveInvoiceAdjustment({
                actor: user,
                record: reviewAdjustment,
                buildingHasActiveOwner: true,
              }) &&
              canApproveInvoiceAdjustments &&
              reviewAdjustment.status === 'PENDING_APPROVAL' ? (
                <>
                  <Button
                    variant="danger"
                    disabled={submitting}
                    onClick={() => {
                      const target = reviewAdjustment;
                      setReviewAdjustment(null);
                      setRejectAdjTarget(target);
                      setRejectionReason('');
                    }}
                  >
                    Từ chối
                  </Button>
                  <Button
                    variant="success"
                    icon={CheckCircle}
                    loading={submitting}
                    onClick={async () => {
                      const target = reviewAdjustment;
                      await handleApproveAdjustment(target);
                      setReviewAdjustment(null);
                    }}
                  >
                    Phê duyệt điều chỉnh
                  </Button>
                </>
              ) : null}
            </>
          ) : null
        }
      >
        {reviewAdjustment ? (
          <div className="space-y-4 text-xs">
            <div className="grid grid-cols-2 gap-3 p-3.5 rounded-xl bg-slate-50 border border-slate-200">
              <div>
                <p className="text-slate-500">Trạng thái đề nghị</p>
                <div className="mt-1">
                  <StatusBadge status={reviewAdjustment.status} domain="invoice_adjustment" />
                </div>
              </div>
              <div>
                <p className="text-slate-500">Loại điều chỉnh</p>
                <div className="mt-1">
                  <Badge variant={reviewAdjustment.action_type === 'VOID' ? 'slate' : 'purple'} size="xs">
                    {reviewAdjustment.action_type === 'VOID'
                      ? 'HỦY HÓA ĐƠN (VOID)'
                      : reviewAdjustment.adjustment_target}
                  </Badge>
                </div>
              </div>
              <div>
                <p className="text-slate-500">Số tiền thay đổi (Delta)</p>
                <p className="font-mono text-sm font-bold text-slate-900 mt-0.5">
                  {reviewAdjustment.delta_amount != null
                    ? `${Number(reviewAdjustment.delta_amount) > 0 ? '+' : ''}${formatMoney(reviewAdjustment.delta_amount)}`
                    : '—'}
                </p>
              </div>
              <div>
                <p className="text-slate-500">Thời gian lập</p>
                <p className="font-medium text-slate-800 mt-0.5">
                  {formatDateTime(reviewAdjustment.created_at)}
                </p>
              </div>
            </div>

            <div className="p-3 rounded-xl bg-white border border-slate-200 space-y-1">
              <p className="font-semibold text-slate-700">Lý do đề xuất điều chỉnh</p>
              <p className="text-slate-600 whitespace-pre-line">{reviewAdjustment.reason || '—'}</p>
            </div>
          </div>
        ) : null}
      </Modal>

      {/* Modal Tóm tắt nhanh hóa đơn (mở từ thông báo cho vai trò giám sát / hóa đơn đã tất toán) */}
      <Modal
        open={summaryModalOpen}
        onClose={() => setSummaryModalOpen(false)}
        title={`Tóm tắt Hóa đơn ${invoice.invoice_code}`}
        subtitle={`${invoice.period ? `Kỳ ${invoice.period}` : 'Phí phạt tất toán'} • Căn ${invoice.apartment_code} (${invoice.building_name})`}
        size="md"
        footer={
          <>
            <Button variant="outline" onClick={() => setSummaryModalOpen(false)}>
              Đóng
            </Button>
            <Button
              variant="outline"
              icon={Printer}
              onClick={() => {
                setSummaryModalOpen(false);
                window.print();
              }}
            >
              In hóa đơn PDF
            </Button>
            {canManageInvoices && isDraft && !isSettlement ? (
              <Button
                variant="primary"
                icon={Send}
                onClick={() => {
                  setSummaryModalOpen(false);
                  setIssueConfirmOpen(true);
                }}
              >
                Phát hành hóa đơn
              </Button>
            ) : null}
          </>
        }
      >
        <div className="space-y-4 text-xs">
          <div className="grid grid-cols-2 gap-3 p-3.5 rounded-xl bg-slate-50 border border-slate-200">
            <div>
              <p className="text-slate-500">Trạng thái hóa đơn</p>
              <div className="mt-1 flex flex-wrap items-center gap-1.5">
                <StatusBadge status={invoice.status} domain="invoice" />
                {isSettlement ? (
                  <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium bg-amber-100 text-amber-800">
                    Phí phạt tất toán
                  </span>
                ) : null}
              </div>
            </div>
            <div>
              <p className="text-slate-500">Hạn thanh toán</p>
              <p className="font-semibold text-slate-800 mt-1">{formatDate(invoice.due_date)}</p>
            </div>
            <div>
              <p className="text-slate-500">Tổng cộng phải thu</p>
              <p className="font-mono text-sm font-bold text-primary-700 mt-0.5">
                {formatMoney(invoice.total_amount)}
              </p>
            </div>
            <div>
              <p className="text-slate-500">Còn phải thu</p>
              <p className="font-mono text-sm font-bold text-rose-600 mt-0.5">
                {isVoid || isCancelled ? '0 ₫' : formatMoney(remaining)}
              </p>
            </div>
          </div>

          {adjustments.length > 0 ? (
            <div className="p-3 rounded-xl bg-indigo-50/70 border border-indigo-200 space-y-1">
              <p className="font-semibold text-indigo-900">
                Đề nghị điều chỉnh gần nhất ({adjustments[0].status})
              </p>
              <p className="text-indigo-800">{adjustments[0].reason || '—'}</p>
              {adjustments[0].rejection_reason ? (
                <p className="text-rose-700 font-medium">
                  Lý do từ chối: {adjustments[0].rejection_reason}
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
      </Modal>

      {/* Lightbox xem ảnh chứng từ */}
      <Modal
        open={Boolean(previewProof)}
        onClose={() => setPreviewProof(null)}
        title={
          Array.isArray(previewProof) && previewProof.length > 1
            ? `Ảnh chứng từ thanh toán (${previewProof.length} ảnh)`
            : 'Ảnh chứng từ thanh toán'
        }
        size="lg"
      >
        {previewProof ? (
          <div className="space-y-3 max-h-[75vh] overflow-y-auto">
            {(Array.isArray(previewProof) ? previewProof : [previewProof]).map((src, idx) => (
              <div
                key={idx}
                className="flex items-center justify-center bg-slate-900 rounded-xl overflow-hidden"
              >
                <AuthImage
                  src={src}
                  alt={`Chứng từ thanh toán #${idx + 1}`}
                  className="max-h-[65vh] w-auto object-contain"
                />
              </div>
            ))}
          </div>
        ) : null}
      </Modal>
    </div>
  );
}

export default InvoiceDetailPage;
