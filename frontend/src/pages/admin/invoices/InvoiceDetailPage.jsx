import React, { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
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
} from 'lucide-react';
import { Button } from '../../../components/ui/Button';
import { Input } from '../../../components/ui/Input';
import { Select } from '../../../components/ui/Select';
import { Modal } from '../../../components/ui/Modal';
import { Badge } from '../../../components/ui/Badge';
import { Card, CardHeader } from '../../../components/ui/Card';
import { Table, THead, TBody, TH, TD } from '../../../components/ui/Table';
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
import { extractErrorMessage } from '../../../utils/validation';

const LINE_TYPE_LABELS = {
  RENT: { label: 'Tiền thuê phòng', variant: 'sky' },
  ELECTRICITY: { label: 'Tiền điện', variant: 'amber' },
  WATER: { label: 'Tiền nước', variant: 'sky' },
  SERVICE: { label: 'Dịch vụ tiện ích', variant: 'indigo' },
  ADJUSTMENT: { label: 'Điều chỉnh', variant: 'purple' },
  OTHER: { label: 'Khoản khác', variant: 'slate' },
};

const PAYMENT_METHODS = {
  BANK_TRANSFER: 'Chuyển khoản ngân hàng',
  CASH: 'Tiền mặt tại quầy',
  CARD: 'Thẻ ngân hàng / POS',
  EWALLET: 'Ví điện tử',
  OTHER: 'Phương thức khác',
};

export function InvoiceDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const { canManageInvoices, canManagePayments } = usePermission();
  const selectedBuildingId = useAuthStore((s) => s.selectedBuildingId);

  const [invoice, setInvoice] = useState(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  // Modal điều chỉnh hóa đơn
  const [adjustOpen, setAdjustOpen] = useState(false);
  const [adjustForm, setAdjustForm] = useState({
    adjustment_amount: '0',
    adjustment_reason: '',
    due_date: '',
    note: '',
  });

  // Modal ghi nhận thu tiền nhanh
  const [payOpen, setPayOpen] = useState(false);
  const [payForm, setPayForm] = useState({
    amount: '',
    method: 'BANK_TRANSFER',
    reference_code: '',
    note: '',
    proof_image: '',
  });

  // Confirm hủy hóa đơn
  const [cancelOpen, setCancelOpen] = useState(false);

  // Lightbox xem ảnh chứng từ
  const [previewProof, setPreviewProof] = useState(null);

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
  }, [id, selectedBuildingId, toast]);

  useEffect(() => {
    fetchDetail();
  }, [fetchDetail]);

  const handleIssue = async () => {
    if (!invoice) return;
    setSubmitting(true);
    try {
      const res = await invoicesService.updateStatus(invoice.id, { status: 'ISSUED' });
      toast.success(res.message || 'Đã phát hành hóa đơn cho cư dân.');
      fetchDetail();
    } catch (err) {
      toast.error(extractErrorMessage(err, 'Không thể phát hành hóa đơn.'));
    } finally {
      setSubmitting(false);
    }
  };

  const openAdjustModal = () => {
    if (!invoice) return;
    const adjLine = (invoice.lines || []).find((l) => l.item_type === 'ADJUSTMENT');
    setAdjustForm({
      adjustment_amount: String(Number(invoice.adjustment_amount || 0)),
      adjustment_reason: adjLine?.description || 'Điều chỉnh phí hóa đơn',
      due_date: toInputDate(invoice.due_date),
      note: invoice.note || '',
    });
    setAdjustOpen(true);
  };

  const handleSaveAdjustment = async (e) => {
    e.preventDefault();
    if (!invoice) return;
    const adjNum = Math.round(Number(adjustForm.adjustment_amount || 0));
    if (adjNum !== 0 && !adjustForm.adjustment_reason.trim()) {
      toast.warning('Vui lòng nhập lý do điều chỉnh số tiền.');
      return;
    }

    setSubmitting(true);
    try {
      const res = await invoicesService.updateStatus(invoice.id, {
        adjustment_amount: adjNum,
        adjustment_reason: adjustForm.adjustment_reason.trim() || 'Điều chỉnh hóa đơn',
        due_date: adjustForm.due_date || undefined,
        note: adjustForm.note.trim() || null,
      });
      toast.success(res.message || 'Đã cập nhật điều chỉnh hóa đơn.');
      setAdjustOpen(false);
      fetchDetail();
    } catch (err) {
      toast.error(extractErrorMessage(err, 'Không thể điều chỉnh hóa đơn.'));
    } finally {
      setSubmitting(false);
    }
  };

  const handleCancelInvoice = async () => {
    if (!invoice) return;
    setSubmitting(true);
    try {
      const res = await invoicesService.updateStatus(invoice.id, { status: 'CANCELLED' });
      toast.success(res.message || 'Đã hủy hóa đơn.');
      setCancelOpen(false);
      fetchDetail();
    } catch (err) {
      toast.error(extractErrorMessage(err, 'Không thể hủy hóa đơn.'));
    } finally {
      setSubmitting(false);
    }
  };

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

  const handleQuickPay = async (e) => {
    e.preventDefault();
    if (!invoice) return;
    const amt = Math.round(Number(payForm.amount || 0));
    if (amt <= 0) {
      toast.warning('Số tiền thu phải lớn hơn 0.');
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
        proof_image: payForm.proof_image || undefined,
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
  const canAdjust = canManageInvoices && !['PAID', 'CANCELLED'].includes(invoice.status);
  const canCancel =
    canManageInvoices &&
    invoice.status !== 'CANCELLED' &&
    Number(invoice.paid_amount || 0) === 0;
  const canCollect =
    canManagePayments &&
    !['PAID', 'CANCELLED', 'DRAFT'].includes(invoice.status) &&
    remaining > 0;

  const previewAdjustedTotal = Math.max(
    0,
    Number(invoice.subtotal_amount || 0) + Math.round(Number(adjustForm.adjustment_amount || 0))
  );

  return (
    <div className="space-y-6">
      <PageHeader
        breadcrumbs={[
          { label: 'Hóa đơn kỳ', to: '/admin/invoices' },
          { label: invoice.invoice_code },
        ]}
        title={`Chi tiết Hóa đơn ${invoice.invoice_code}`}
        subtitle={`Kỳ thanh toán ${invoice.period} • Căn ${invoice.apartment_code} (${invoice.building_name})`}
        actions={
          <>
            <Link to="/admin/invoices">
              <Button variant="outline" icon={ArrowLeft}>
                Quay lại
              </Button>
            </Link>

            <Button variant="outline" icon={Printer} onClick={() => window.print()}>
              In hóa đơn PDF
            </Button>

            {canManageInvoices && invoice.status === 'DRAFT' ? (
              <Button
                variant="primary"
                icon={Send}
                loading={submitting}
                onClick={handleIssue}
              >
                Phát hành hóa đơn
              </Button>
            ) : null}

            {canAdjust ? (
              <Button variant="outline" icon={SlidersHorizontal} onClick={openAdjustModal}>
                Điều chỉnh số tiền
              </Button>
            ) : null}

            {canCollect ? (
              <Button variant="success" icon={Wallet} onClick={openQuickPayModal}>
                Ghi nhận thu tiền
              </Button>
            ) : null}

            {canCancel ? (
              <Button variant="danger" icon={Ban} onClick={() => setCancelOpen(true)}>
                Hủy hóa đơn
              </Button>
            ) : null}
          </>
        }
      />

      {/* Tờ Hóa Đơn Chuẩn Chuyên Nghiệp (Hỗ trợ in A4 PDF) */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-card p-6 sm:p-8 print-area space-y-8">
        {/* Header Tờ Hóa Đơn */}
        <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4 pb-6 border-b border-slate-200">
          <div>
            <div className="inline-flex items-center gap-2 text-primary-600 font-bold text-sm uppercase tracking-wider">
              <Building2 className="w-4 h-4" />
              <span>Hệ thống Quản lý Căn hộ ResiHub</span>
            </div>
            <h2 className="text-xl font-bold text-slate-900 mt-1">{invoice.building_name}</h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Mã tòa nhà: {invoice.building_code}
              {invoice.building_address ? ` • Địa chỉ: ${invoice.building_address}` : ''}
            </p>
          </div>

          <div className="sm:text-right space-y-1.5">
            <div className="flex sm:justify-end items-center gap-2">
              <span className="text-xs uppercase tracking-wider font-semibold text-slate-400">
                PHIẾU BÁO PHÍ & HÓA ĐƠN
              </span>
              <StatusBadge status={invoice.status} domain="invoice" />
            </div>
            <p className="font-mono text-lg font-bold text-slate-900">{invoice.invoice_code}</p>
            <p className="text-xs text-slate-500">Kỳ hạch toán: Tháng {invoice.period}</p>
          </div>
        </div>

        {/* Thông tin Khách thuê & Lịch thanh toán */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div className="p-4 rounded-xl bg-slate-50/80 border border-slate-200/70 space-y-2 text-sm">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-400 flex items-center gap-1.5">
              <User className="w-3.5 h-3.5" /> Thông tin Căn hộ & Cư dân
            </p>
            <div className="grid grid-cols-3 gap-1 pt-1 text-xs">
              <span className="text-slate-500">Căn hộ:</span>
              <span className="col-span-2 font-semibold text-slate-900">
                Căn {invoice.apartment_code}{' '}
                {invoice.area_m2 ? `(${invoice.area_m2} m²)` : ''}
              </span>

              <span className="text-slate-500">Khách thuê chính:</span>
              <span className="col-span-2 font-semibold text-slate-900">
                {invoice.tenant_name || '—'}
              </span>

              <span className="text-slate-500">Số điện thoại:</span>
              <span className="col-span-2 text-slate-700">{invoice.tenant_phone || '—'}</span>

              <span className="text-slate-500">Email nhận HĐ:</span>
              <span className="col-span-2 text-slate-700">{invoice.tenant_email || '—'}</span>
            </div>
          </div>

          <div className="p-4 rounded-xl bg-slate-50/80 border border-slate-200/70 space-y-2 text-sm">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-400 flex items-center gap-1.5">
              <Calendar className="w-3.5 h-3.5" /> Thông tin Kỳ thanh toán
            </p>
            <div className="grid grid-cols-3 gap-1 pt-1 text-xs">
              <span className="text-slate-500">Ngày lập hóa đơn:</span>
              <span className="col-span-2 font-medium text-slate-800">
                {formatDate(invoice.issue_date)}
              </span>

              <span className="text-slate-500">Hạn thanh toán:</span>
              <span className="col-span-2 font-semibold text-rose-600">
                {formatDate(invoice.due_date)}
              </span>

              <span className="text-slate-500">Thời điểm phát hành:</span>
              <span className="col-span-2 text-slate-700">
                {invoice.issued_at ? formatDateTime(invoice.issued_at) : 'Chưa phát hành (Nháp)'}
              </span>

              {invoice.note ? (
                <>
                  <span className="text-slate-500">Ghi chú HĐ:</span>
                  <span className="col-span-2 text-slate-700">{invoice.note}</span>
                </>
              ) : null}
            </div>
          </div>
        </div>

        {/* Bảng chi tiết khoản thu */}
        <div className="space-y-3">
          <h3 className="text-sm font-semibold text-slate-900">
            Chi tiết các khoản phí trong kỳ
          </h3>
          <div className="border border-slate-200 rounded-xl overflow-hidden">
            <Table>
              <THead>
                <tr>
                  <TH className="w-14 text-center">STT</TH>
                  <TH className="text-center">Hạng mục</TH>
                  <TH>Diễn giải chi tiết</TH>
                  <TH className="text-center">Số lượng</TH>
                  <TH className="text-center">ĐVT</TH>
                  <TH className="text-right">Đơn giá</TH>
                  <TH className="text-right">Thành tiền</TH>
                </tr>
              </THead>
              <TBody>
                {(invoice.lines || []).length === 0 ? (
                  <tr>
                    <TD colSpan={7} className="text-center text-slate-400 py-6">
                      Chưa có dòng chi tiết hóa đơn.
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
                        <TD className="font-medium text-slate-800">{line.description}</TD>
                        <TD className="text-center font-mono whitespace-nowrap">{Number(line.quantity)}</TD>
                        <TD className="text-center text-slate-500 whitespace-nowrap">{line.unit}</TD>
                        <TD className="text-right font-mono tabular-nums whitespace-nowrap">{formatMoney(line.unit_price)}</TD>
                        <TD
                          className={`text-right font-mono tabular-nums font-semibold whitespace-nowrap ${
                            Number(line.amount) < 0 ? 'text-emerald-600' : 'text-slate-900'
                          }`}
                        >
                          {Number(line.amount) > 0 && line.item_type === 'ADJUSTMENT' ? '+' : ''}
                          {formatMoney(line.amount)}
                        </TD>
                      </tr>
                    );
                  })
                )}
              </TBody>
            </Table>
          </div>
        </div>

        {/* Tổng kết số tiền */}
        <div className="flex flex-col sm:flex-row justify-end">
          <div className="w-full sm:w-96 rounded-xl bg-slate-50 border border-slate-200 p-4 space-y-2.5 text-sm">
            <div className="flex items-center justify-between text-slate-600">
              <span>Cộng tiền dịch vụ (Tạm tính):</span>
              <span className="font-mono font-medium text-slate-900">
                {formatMoney(invoice.subtotal_amount)}
              </span>
            </div>

            <div className="flex items-center justify-between text-slate-600">
              <span>Điều chỉnh tăng / giảm:</span>
              <span className="font-mono font-medium text-indigo-700">
                {Number(invoice.adjustment_amount) > 0 ? '+' : ''}
                {formatMoney(invoice.adjustment_amount)}
              </span>
            </div>

            <div className="pt-2.5 border-t border-slate-200 flex items-center justify-between text-base font-bold text-slate-900">
              <span>Tổng cộng phải thu:</span>
              <span className="font-mono text-primary-700">
                {formatMoney(invoice.total_amount)}
              </span>
            </div>

            <div className="flex items-center justify-between text-emerald-700 text-xs font-medium">
              <span>Đã thanh toán:</span>
              <span className="font-mono">{formatMoney(invoice.paid_amount)}</span>
            </div>

            <div className="pt-2 border-t border-dashed border-slate-200 flex items-center justify-between font-bold">
              <span className="text-slate-800">Số tiền còn phải thanh toán:</span>
              <span
                className={`font-mono text-base ${
                  remaining > 0 && invoice.status !== 'CANCELLED'
                    ? 'text-rose-600'
                    : 'text-emerald-600'
                }`}
              >
                {invoice.status === 'CANCELLED' ? '0 ₫' : formatMoney(remaining)}
              </span>
            </div>
          </div>
        </div>

        {/* Chữ ký khi in PDF */}
        <div className="hidden print:grid grid-cols-2 gap-8 pt-10 text-center text-xs text-slate-600">
          <div>
            <p className="font-semibold text-slate-900 uppercase">Người lập phiếu / Ban quản lý</p>
            <p className="italic mt-1">(Ký và ghi rõ họ tên)</p>
          </div>
          <div>
            <p className="font-semibold text-slate-900 uppercase">Khách thuê căn hộ</p>
            <p className="italic mt-1">(Ký xác nhận)</p>
          </div>
        </div>
      </div>

      {/* Lịch sử giao dịch thanh toán của hóa đơn này */}
      <Card className="no-print" padding={false}>
        <div className="p-5 border-b border-slate-100">
          <CardHeader
            title={`Lịch sử thanh toán (${(invoice.payments || []).length})`}
            subtitle="Các giao dịch thu tiền trực tiếp hoặc chứng từ chuyển khoản do cư dân gửi lên."
            className="mb-0"
          />
        </div>

        {(invoice.payments || []).length === 0 ? (
          <EmptyState
            icon={Wallet}
            title="Chưa có giao dịch thanh toán nào"
            description="Hóa đơn này chưa phát sinh khoản thu nào."
          />
        ) : (
          <Table>
            <THead>
              <tr>
                <TH>Mã giao dịch</TH>
                <TH className="text-center">Thời gian</TH>
                <TH>Phương thức</TH>
                <TH className="text-right">Số tiền nộp</TH>
                <TH className="text-center">Trạng thái</TH>
                <TH className="text-center">Người xác nhận</TH>
                <TH className="w-px whitespace-nowrap text-center">Chứng từ</TH>
              </tr>
            </THead>
            <TBody>
              {invoice.payments.map((py) => (
                <tr key={py.id}>
                  <TD className="font-mono text-xs font-semibold text-slate-800 whitespace-nowrap">
                    {py.payment_code}
                  </TD>
                  <TD className="text-center text-xs text-slate-600 whitespace-nowrap">{formatDateTime(py.paid_at)}</TD>
                  <TD>
                    <p className="text-xs font-medium text-slate-800 whitespace-nowrap">
                      {PAYMENT_METHODS[py.method] || py.method}
                    </p>
                    {py.reference_code ? (
                      <p className="text-[11px] font-mono text-slate-500">
                        Ref: {py.reference_code}
                      </p>
                    ) : null}
                  </TD>
                  <TD className="text-right whitespace-nowrap">
                    <p className="font-mono tabular-nums font-semibold text-emerald-700">
                      {formatMoney(py.amount)}
                    </p>
                    {Number(py.overpayment_amount) > 0 ? (
                      <p className="text-[11px] text-indigo-600">
                        Nộp thừa: {formatMoney(py.overpayment_amount)}
                      </p>
                    ) : null}
                  </TD>
                  <TD className="text-center">
                    <StatusBadge status={py.status} domain="payment" />
                  </TD>
                  <TD className="text-center text-xs text-slate-600 whitespace-nowrap">{py.confirmed_by_name || '—'}</TD>
                  <TD className="w-px whitespace-nowrap text-center">
                    {Array.isArray(py.proof_images) && py.proof_images.length > 0 ? (
                      <Button
                        size="xs"
                        variant="soft"
                        icon={Eye}
                        onClick={() => setPreviewProof(py.proof_images[0])}
                      >
                        Xem UNC
                      </Button>
                    ) : (
                      <span className="text-xs text-slate-400">—</span>
                    )}
                  </TD>
                </tr>
              ))}
            </TBody>
          </Table>
        )}
      </Card>

      {/* Modal Điều chỉnh số tiền */}
      <Modal
        open={adjustOpen}
        onClose={() => setAdjustOpen(false)}
        title="Điều chỉnh số tiền hóa đơn"
        subtitle="Nhập số dương (+) để phụ thu thêm hoặc số âm (-) để giảm trừ khuyến mãi/khấu trừ."
        size="md"
        footer={
          <>
            <Button variant="outline" onClick={() => setAdjustOpen(false)} disabled={submitting}>
              Hủy
            </Button>
            <Button variant="primary" onClick={handleSaveAdjustment} loading={submitting}>
              Lưu điều chỉnh
            </Button>
          </>
        }
      >
        <form onSubmit={handleSaveAdjustment} className="space-y-4">
          <Input
            label="Số tiền điều chỉnh (VNĐ)"
            type="number"
            step="1000"
            required
            placeholder="VD: -200000 (giảm trừ) hoặc 150000 (phụ thu)"
            value={adjustForm.adjustment_amount}
            onChange={(e) =>
              setAdjustForm((s) => ({ ...s, adjustment_amount: e.target.value }))
            }
          />

          <div className="p-3.5 rounded-xl bg-indigo-50/70 border border-indigo-200 flex items-center justify-between text-xs">
            <span className="text-indigo-800">Tổng phải thu sau điều chỉnh:</span>
            <span className="text-base font-bold text-indigo-700 font-mono">
              {formatMoney(previewAdjustedTotal)}
            </span>
          </div>

          <Input
            label="Lý do điều chỉnh (hiển thị trên dòng chi tiết hóa đơn)"
            required
            placeholder="VD: Hỗ trợ miễn phí gửi xe tháng đầu / Truy thu phí thẻ từ..."
            value={adjustForm.adjustment_reason}
            onChange={(e) =>
              setAdjustForm((s) => ({ ...s, adjustment_reason: e.target.value }))
            }
          />

          <Input
            label="Gia hạn ngày thanh toán (nếu có)"
            type="date"
            value={adjustForm.due_date}
            onChange={(e) => setAdjustForm((s) => ({ ...s, due_date: e.target.value }))}
          />

          <Input
            label="Ghi chú hóa đơn"
            multiline
            rows={2}
            value={adjustForm.note}
            onChange={(e) => setAdjustForm((s) => ({ ...s, note: e.target.value }))}
          />
        </form>
      </Modal>

      {/* Modal Ghi nhận thu tiền nhanh */}
      <Modal
        open={payOpen}
        onClose={() => setPayOpen(false)}
        title={`Ghi nhận thu tiền — ${invoice.invoice_code}`}
        subtitle={`Còn phải thu: ${formatMoney(remaining)}`}
        size="md"
        footer={
          <>
            <Button variant="outline" onClick={() => setPayOpen(false)} disabled={submitting}>
              Hủy
            </Button>
            <Button variant="success" onClick={handleQuickPay} loading={submitting}>
              Xác nhận thu tiền
            </Button>
          </>
        }
      >
        <form onSubmit={handleQuickPay} className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Input
              label="Số tiền thực thu (VNĐ)"
              type="number"
              min="1000"
              step="1000"
              required
              value={payForm.amount}
              onChange={(e) => setPayForm((s) => ({ ...s, amount: e.target.value }))}
            />
            <Select
              label="Phương thức thanh toán"
              required
              value={payForm.method}
              onChange={(e) => setPayForm((s) => ({ ...s, method: e.target.value }))}
              options={Object.entries(PAYMENT_METHODS).map(([value, label]) => ({
                value,
                label,
              }))}
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

      {/* Hộp thoại xác nhận hủy hóa đơn */}
      <ConfirmDialog
        open={cancelOpen}
        onClose={() => setCancelOpen(false)}
        onConfirm={handleCancelInvoice}
        loading={submitting}
        title="Xác nhận hủy hóa đơn"
        message={`Bạn có chắc chắn muốn hủy hóa đơn ${invoice.invoice_code}? Khoản công nợ gắn liền (nếu có) sẽ tự động được xóa bỏ (WRITTEN_OFF).`}
        confirmLabel="Xác nhận hủy"
      />

      {/* Lightbox xem ảnh chứng từ */}
      <Modal
        open={Boolean(previewProof)}
        onClose={() => setPreviewProof(null)}
        title="Ảnh chứng từ thanh toán"
        size="lg"
      >
        {previewProof ? (
          <div className="flex items-center justify-center bg-slate-900 rounded-xl overflow-hidden max-h-[70vh]">
            <AuthImage
              src={previewProof}
              alt="Chứng từ thanh toán"
              className="max-h-[70vh] w-auto object-contain"
            />
          </div>
        ) : null}
      </Modal>
    </div>
  );
}

export default InvoiceDetailPage;
