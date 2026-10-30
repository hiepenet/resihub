import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  Receipt,
  CreditCard,
  Landmark,
  Copy,
  Check,
  ChevronDown,
  ChevronUp,
  Home,
  Zap,
  Droplets,
  Sparkles,
  FileText,
  Clock,
  Send,
  Calendar,
  AlertTriangle,
} from 'lucide-react';
import { Card } from '../../../components/ui/Card';
import { Button } from '../../../components/ui/Button';
import { Badge } from '../../../components/ui/Badge';
import { Input } from '../../../components/ui/Input';
import { Select } from '../../../components/ui/Select';
import { Modal } from '../../../components/ui/Modal';
import { Tabs } from '../../../components/ui/Tabs';
import { Skeleton } from '../../../components/ui/Skeleton';
import { FileUpload, AuthImage } from '../../../components/ui/FileUpload';
import { StatusBadge } from '../../../components/common/StatusBadge';
import { EmptyState } from '../../../components/common/EmptyState';
import { residentService } from '../../../services/resident.service';
import { buildingsService } from '../../../services/buildings.service';
import { usersService } from '../../../services/users.service';
import { useToast } from '../../../hooks/useToast';
import { formatMoney, formatDate, formatDateTime, toInputDate } from '../../../utils/format';
import { extractErrorMessage } from '../../../utils/validation';

const LINE_TYPE_META = {
  RENT: { label: 'Tiền thuê căn hộ', icon: Home, badgeVariant: 'sky' },
  ELECTRICITY: { label: 'Tiền điện', icon: Zap, badgeVariant: 'amber' },
  WATER: { label: 'Tiền nước', icon: Droplets, badgeVariant: 'indigo' },
  SERVICE: { label: 'Dịch vụ tiện ích', icon: Sparkles, badgeVariant: 'emerald' },
  LATE_FEE: { label: 'Phạt chậm thanh toán', icon: AlertTriangle, badgeVariant: 'red' },
  ADJUSTMENT: { label: 'Điều chỉnh', icon: FileText, badgeVariant: 'purple' },
  OTHER: { label: 'Khoản mục khác', icon: FileText, badgeVariant: 'slate' },
};

const PAYMENT_METHODS = [
  { value: 'BANK_TRANSFER', label: 'Chuyển khoản' },
  { value: 'QR_CODE', label: 'QR Code' },
  { value: 'E_WALLET', label: 'Ví điện tử' },
  { value: 'CASH', label: 'Tiền mặt' },
  { value: 'CARD', label: 'Thẻ' },
  { value: 'OTHER', label: 'Khác' },
];

const PAYMENT_METHOD_LABELS = {
  BANK_TRANSFER: 'Chuyển khoản',
  TRANSFER: 'Chuyển khoản',
  QR_CODE: 'QR Code',
  E_WALLET: 'Ví điện tử',
  EWALLET: 'Ví điện tử',
  CASH: 'Tiền mặt',
  CARD: 'Thẻ',
  OTHER: 'Khác',
};

const DEFAULT_CORPORATE_ACCOUNT = {
  bank: 'Vietcombank',
  account_no: '99988877766',
  account_name: 'RESIHUB CORP',
  branch: 'Chi nhánh Hội Sở',
};

function normalizePaymentAccount(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const bank = raw.bank || raw.bank_name || raw.bankName || '';
  const accountNo = raw.account_no || raw.account_number || raw.accountNo || '';
  const accountName = raw.account_name || raw.holder_name || raw.accountName || '';
  const branch = raw.branch || '';
  if (!bank && !accountNo) return null;
  return {
    bank: bank || 'Ngân hàng đối tác',
    account_no: accountNo || '—',
    account_name: accountName || 'BAN QUAN LY RESIHUB',
    branch,
  };
}

export function InvoicesTab({ overview, onRefreshOverview, actionParam, onClearActionParam }) {
  const toast = useToast();
  const contract = overview?.active_contract || overview?.contract || null;

  const [invoices, setInvoices] = useState([]);
  const [paymentAccount, setPaymentAccount] = useState(DEFAULT_CORPORATE_ACCOUNT);
  const [loading, setLoading] = useState(true);
  const [filterTab, setFilterTab] = useState('all');
  const [expandedId, setExpandedId] = useState(null);
  const hasAutoExpandedRef = useRef(false);
  const [copiedField, setCopiedField] = useState('');
  const [previewImage, setPreviewImage] = useState(null);

  // Report Payment Modal
  const [payModalOpen, setPayModalOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [payForm, setPayForm] = useState({
    invoice_id: '',
    amount: '',
    method: 'BANK_TRANSFER',
    reference_code: '',
    paid_at: toInputDate(new Date()),
    note: '',
    proof_images: [],
  });

  const loadInvoicesAndAccount = useCallback(async () => {
    setLoading(true);
    try {
      const [invRes, bldgRes, settingsRes] = await Promise.allSettled([
        residentService.listInvoices(contract?.contract_id),
        buildingsService.list(),
        usersService.getSettings(),
      ]);

      let loadedInvoices = [];
      if (invRes.status === 'fulfilled') {
        loadedInvoices = invRes.value?.data || [];
        setInvoices(loadedInvoices);
        if (loadedInvoices.length > 0 && !hasAutoExpandedRef.current) {
          hasAutoExpandedRef.current = true;
          setExpandedId(loadedInvoices[0].id);
        }
      }

      // Resolve payment_account priority: Building lease_terms.payment_account -> Settings -> Overview -> Corporate default
      let resolvedAcc = null;
      if (bldgRes.status === 'fulfilled') {
        const bldgs = Array.isArray(bldgRes.value?.data)
          ? bldgRes.value.data
          : Array.isArray(bldgRes.value)
          ? bldgRes.value
          : [];
        const matchedBldg =
          bldgs.find((b) => b.id === contract?.building_id) || bldgs[0] || null;
        const bldgAcc =
          matchedBldg?.payment_account || matchedBldg?.lease_terms?.payment_account;
        resolvedAcc = normalizePaymentAccount(bldgAcc);
      }

      if (!resolvedAcc && settingsRes.status === 'fulfilled') {
        const stData = settingsRes.value?.data || {};
        resolvedAcc =
          normalizePaymentAccount(stData.payment_account) ||
          normalizePaymentAccount(stData.billing_config?.payment_account);
      }

      if (!resolvedAcc) {
        resolvedAcc =
          normalizePaymentAccount(overview?.payment_account) ||
          normalizePaymentAccount(contract?.payment_account) ||
          DEFAULT_CORPORATE_ACCOUNT;
      }

      setPaymentAccount(resolvedAcc);
    } finally {
      setLoading(false);
    }
  }, [contract?.contract_id, contract?.building_id, contract?.payment_account, overview?.payment_account]);

  useEffect(() => {
    hasAutoExpandedRef.current = false;
  }, [contract?.contract_id]);

  useEffect(() => {
    loadInvoicesAndAccount();
  }, [loadInvoicesAndAccount]);

  const unpaidInvoices = useMemo(
    () =>
      invoices.filter((inv) =>
        ['ISSUED', 'PARTIALLY_PAID', 'OVERDUE'].includes(inv.status)
      ),
    [invoices]
  );

  const openReportPaymentModal = useCallback(
    (targetInv = null) => {
      const chosen = targetInv || unpaidInvoices[0] || null;
      const remaining = chosen
        ? Math.max(0, Number(chosen.total_amount || 0) - Number(chosen.paid_amount || 0))
        : '';
      setPayForm({
        invoice_id: chosen?.id || '',
        amount: remaining ? String(remaining) : '',
        method: 'BANK_TRANSFER',
        reference_code: '',
        paid_at: toInputDate(new Date()),
        note: '',
        proof_images: [],
      });
      setPayModalOpen(true);
    },
    [unpaidInvoices]
  );

  useEffect(() => {
    if (!loading && actionParam === 'pay') {
      openReportPaymentModal(unpaidInvoices[0] || null);
      onClearActionParam?.();
    }
  }, [loading, actionParam, unpaidInvoices, openReportPaymentModal, onClearActionParam]);

  const filteredInvoices = useMemo(() => {
    if (filterTab === 'unpaid') return unpaidInvoices;
    if (filterTab === 'paid') return invoices.filter((inv) => inv.status === 'PAID');
    return invoices;
  }, [invoices, unpaidInvoices, filterTab]);

  const summary = useMemo(() => {
    return invoices.reduce(
      (acc, inv) => {
        if (inv.status !== 'CANCELLED') {
          acc.totalBilled += Number(inv.total_amount || 0);
          acc.totalPaid += Number(inv.paid_amount || 0);
          if (['ISSUED', 'PARTIALLY_PAID', 'OVERDUE'].includes(inv.status)) {
            acc.totalUnpaid += Math.max(
              0,
              Number(inv.total_amount || 0) - Number(inv.paid_amount || 0)
            );
          }
        }
        return acc;
      },
      { totalBilled: 0, totalPaid: 0, totalUnpaid: 0 }
    );
  }, [invoices]);

  const handleCopy = async (text, key) => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopiedField(key);
      setTimeout(() => setCopiedField(''), 2000);
      toast.info('Đã sao chép vào bộ nhớ tạm.');
    } catch {
      // ignore
    }
  };

  const handleInvoiceChangeInModal = (invId) => {
    const found = unpaidInvoices.find((i) => i.id === invId);
    const rem = found
      ? Math.max(0, Number(found.total_amount || 0) - Number(found.paid_amount || 0))
      : '';
    setPayForm((s) => ({
      ...s,
      invoice_id: invId,
      amount: rem ? String(rem) : '',
    }));
  };

  const handleSubmitPayment = async (e) => {
    e.preventDefault();
    const numAmount = Number(payForm.amount);
    if (!payForm.invoice_id) {
      toast.warning('Vui lòng chọn hóa đơn cần báo thanh toán.');
      return;
    }
    if (!numAmount || numAmount <= 0) {
      toast.warning('Vui lòng nhập số tiền thanh toán hợp lệ (> 0).');
      return;
    }

    setSubmitting(true);
    try {
      const res = await residentService.reportPayment({
        invoice_id: payForm.invoice_id,
        amount: Math.round(numAmount),
        method: payForm.method,
        reference_code: payForm.reference_code?.trim() || undefined,
        paid_at: payForm.paid_at ? new Date(payForm.paid_at).toISOString() : undefined,
        note: payForm.note?.trim() || undefined,
        proof_images: payForm.proof_images,
      });
      toast.success(
        res?.message || 'Đã gửi thông báo thanh toán kèm chứng từ thành công!'
      );
      setPayModalOpen(false);
      await Promise.allSettled([loadInvoicesAndAccount(), onRefreshOverview?.()]);
    } catch (err) {
      toast.error(extractErrorMessage(err, 'Không thể gửi xác nhận thanh toán.'));
    } finally {
      setSubmitting(false);
    }
  };

  const transferSyntax = useMemo(() => {
    const firstUnpaid = unpaidInvoices[0];
    const aptCode = contract?.apartment_code || firstUnpaid?.apartment_code || 'CANHO';
    const period = firstUnpaid?.period ? firstUnpaid.period.replace('-', '') : '';
    return `RESIHUB ${aptCode}${period ? ` ${period}` : ''}`;
  }, [contract?.apartment_code, unpaidInvoices]);

  return (
    <div className="space-y-6">
      {/* Top Grid: Summary + Bank Payment Account Card */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
        {/* Financial Summary */}
        <Card className="lg:col-span-7 flex flex-col justify-between">
          <div>
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-base font-bold text-slate-900">
                  Hóa đơn & Đối soát Thanh toán
                </h2>
                <p className="text-xs text-slate-500 mt-0.5">
                  Tra cứu chi tiết tiền thuê, điện, nước, dịch vụ hàng tháng và gửi biên lai chuyển khoản
                </p>
              </div>
              <Button
                icon={CreditCard}
                size="sm"
                disabled={unpaidInvoices.length === 0}
                onClick={() => openReportPaymentModal(unpaidInvoices[0])}
              >
                Báo đã thanh toán
              </Button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mt-5">
              <div className="p-3.5 rounded-xl bg-rose-50/70 border border-rose-100">
                <p className="text-xs text-slate-500">Cần thanh toán</p>
                <p className="text-lg font-bold text-rose-600 mt-1">
                  {formatMoney(summary.totalUnpaid)}
                </p>
                <p className="text-[11px] text-slate-500 mt-0.5">
                  {unpaidInvoices.length} hóa đơn mở
                </p>
              </div>
              <div className="p-3.5 rounded-xl bg-emerald-50/70 border border-emerald-100">
                <p className="text-xs text-slate-500">Đã thanh toán</p>
                <p className="text-lg font-bold text-emerald-700 mt-1">
                  {formatMoney(summary.totalPaid)}
                </p>
                <p className="text-[11px] text-slate-500 mt-0.5">Đã xác nhận đối soát</p>
              </div>
              <div className="p-3.5 rounded-xl bg-slate-50 border border-slate-200/70">
                <p className="text-xs text-slate-500">Tổng phát sinh</p>
                <p className="text-lg font-bold text-slate-900 mt-1">
                  {formatMoney(summary.totalBilled)}
                </p>
                <p className="text-[11px] text-slate-500 mt-0.5">
                  {invoices.length} kỳ hóa đơn
                </p>
              </div>
            </div>
          </div>
        </Card>

        {/* Building Payment Account Card */}
        <div className="lg:col-span-5 rounded-2xl bg-gradient-to-br from-slate-900 via-indigo-950 to-slate-900 text-white p-5 shadow-elevated flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between gap-2">
              <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-sky-300">
                <Landmark className="w-4 h-4" />
                Tài khoản nhận thanh toán Tòa nhà
              </span>
              <Badge variant="sky" className="!bg-sky-500/20 !text-sky-200 !border-sky-400/30">
                Chính thức
              </Badge>
            </div>

            <div className="mt-4 space-y-2.5">
              <div>
                <p className="text-[11px] text-slate-400 uppercase tracking-wider">Ngân hàng</p>
                <p className="text-sm font-semibold text-white">
                  {paymentAccount.bank}
                  {paymentAccount.branch ? ` — ${paymentAccount.branch}` : ''}
                </p>
              </div>

              <div className="flex items-center justify-between gap-2 bg-white/10 rounded-xl px-3.5 py-2.5 border border-white/10">
                <div>
                  <p className="text-[11px] text-slate-300">Số tài khoản</p>
                  <p className="text-base font-mono font-bold tracking-wider text-sky-300">
                    {paymentAccount.account_no}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => handleCopy(paymentAccount.account_no, 'acc')}
                  className="p-2 rounded-lg bg-white/10 hover:bg-white/20 text-white transition-colors"
                  title="Sao chép số tài khoản"
                >
                  {copiedField === 'acc' ? (
                    <Check className="w-4 h-4 text-emerald-400" />
                  ) : (
                    <Copy className="w-4 h-4" />
                  )}
                </button>
              </div>

              <div className="flex items-center justify-between gap-2 text-xs">
                <div>
                  <span className="text-slate-400">Chủ TK: </span>
                  <span className="font-semibold text-white">{paymentAccount.account_name}</span>
                </div>
              </div>
            </div>
          </div>

          <div className="mt-3 pt-3 border-t border-white/10 flex items-center justify-between gap-2 text-xs">
            <div className="min-w-0">
              <span className="text-slate-400">Nội dung CK: </span>
              <code className="font-mono text-amber-300 font-semibold">{transferSyntax}</code>
            </div>
            <button
              type="button"
              onClick={() => handleCopy(transferSyntax, 'syntax')}
              className="text-sky-300 hover:text-sky-200 font-medium shrink-0 inline-flex items-center gap-1"
            >
              {copiedField === 'syntax' ? 'Đã chép' : 'Sao chép'}
            </button>
          </div>
        </div>
      </div>

      {/* Invoices List */}
      <Card padding={false} className="overflow-hidden">
        <div className="px-5 pt-4">
          <Tabs
            activeTab={filterTab}
            onChange={setFilterTab}
            tabs={[
              { id: 'all', label: 'Tất cả hóa đơn', count: invoices.length },
              { id: 'unpaid', label: 'Chờ thanh toán', count: unpaidInvoices.length },
              {
                id: 'paid',
                label: 'Đã hoàn tất',
                count: invoices.filter((i) => i.status === 'PAID').length,
              },
            ]}
          />
        </div>

        <div className="p-5">
          {loading ? (
            <div className="space-y-3">
              {[1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-24 w-full rounded-xl" />
              ))}
            </div>
          ) : filteredInvoices.length === 0 ? (
            <EmptyState
              icon={Receipt}
              title="Không có hóa đơn nào"
              description={
                filterTab === 'unpaid'
                  ? 'Tuyệt vời! Bạn đã thanh toán đầy đủ tất cả hóa đơn đến kỳ.'
                  : 'Danh sách hóa đơn hàng tháng của căn hộ sẽ được hiển thị tại đây khi Ban Quản Lý phát hành.'
              }
            />
          ) : (
            <div className="space-y-3.5">
              {filteredInvoices.map((inv) => {
                const isExpanded = expandedId === inv.id;
                const remaining = Math.max(
                  0,
                  Number(inv.total_amount || 0) - Number(inv.paid_amount || 0)
                );
                const canPay = ['ISSUED', 'PARTIALLY_PAID', 'OVERDUE'].includes(inv.status);
                const lines = Array.isArray(inv.lines) ? inv.lines : [];
                const payments = Array.isArray(inv.payments) ? inv.payments : [];

                return (
                  <div
                    key={inv.id}
                    className={`rounded-xl border transition-all overflow-hidden ${
                      inv.status === 'OVERDUE'
                        ? 'border-rose-300 bg-rose-50/15'
                        : isExpanded
                        ? 'border-primary-300 shadow-sm'
                        : 'border-slate-200/90'
                    }`}
                  >
                    {/* Invoice Header Row */}
                    <div
                      onClick={() => setExpandedId(isExpanded ? null : inv.id)}
                      className="p-4 bg-white hover:bg-slate-50/60 cursor-pointer flex flex-col sm:flex-row sm:items-center justify-between gap-3"
                    >
                      <div className="space-y-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-sm font-bold text-slate-900">
                            Kỳ {inv.period}
                          </span>
                          <span className="text-xs font-mono text-slate-500">
                            #{inv.invoice_code}
                          </span>
                          <StatusBadge status={inv.status} domain="invoice" />
                        </div>
                        <p className="text-xs text-slate-500 flex items-center gap-2 flex-wrap">
                          <span className="inline-flex items-center gap-1">
                            <Calendar className="w-3.5 h-3.5 text-slate-400" />
                            Hạn TT: <strong className="text-slate-700">{formatDate(inv.due_date)}</strong>
                          </span>
                          <span>•</span>
                          <span>Căn {inv.apartment_code}</span>
                        </p>
                      </div>

                      <div className="flex items-center justify-between sm:justify-end gap-4">
                        <div className="text-left sm:text-right">
                          <p className="text-[11px] text-slate-500">
                            {remaining > 0 ? 'Còn phải trả' : 'Tổng hóa đơn'}
                          </p>
                          <p
                            className={`text-base font-bold ${
                              remaining > 0 ? 'text-rose-600' : 'text-emerald-600'
                            }`}
                          >
                            {formatMoney(remaining > 0 ? remaining : inv.total_amount)}
                          </p>
                        </div>

                        <div
                          className="flex items-center gap-2"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {canPay ? (
                            <Button
                              size="sm"
                              onClick={() => openReportPaymentModal(inv)}
                            >
                              Báo thanh toán
                            </Button>
                          ) : null}
                          <button
                            type="button"
                            onClick={() => setExpandedId(isExpanded ? null : inv.id)}
                            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100"
                            title="Chi tiết hóa đơn"
                          >
                            {isExpanded ? (
                              <ChevronUp className="w-4 h-4" />
                            ) : (
                              <ChevronDown className="w-4 h-4" />
                            )}
                          </button>
                        </div>
                      </div>
                    </div>

                    {/* Expanded Breakdown: Lines + Payment History */}
                    {isExpanded ? (
                      <div className="border-t border-slate-100 bg-slate-50/60 p-4 sm:p-5 space-y-5">
                        {/* Line Items */}
                        <div>
                          <h4 className="text-xs font-semibold text-slate-700 uppercase tracking-wider mb-2.5">
                            Chi tiết các khoản phí ({lines.length})
                          </h4>
                          <div className="bg-white rounded-xl border border-slate-200/80 divide-y divide-slate-100 overflow-hidden">
                            {lines.length === 0 ? (
                              <p className="p-4 text-xs text-slate-400 text-center">
                                Không có dòng chi tiết.
                              </p>
                            ) : (
                              lines.map((line) => {
                                const typeKey = String(
                                  line.item_type || line.line_type || 'OTHER'
                                ).toUpperCase();
                                const meta = LINE_TYPE_META[typeKey] || LINE_TYPE_META.OTHER;
                                const LineIcon = meta.icon;
                                return (
                                  <div
                                    key={line.id}
                                    className="px-4 py-3 flex items-center justify-between gap-3 text-xs"
                                  >
                                    <div className="flex items-start gap-2.5 min-w-0">
                                      <div className="w-7 h-7 rounded-lg bg-slate-100 text-slate-600 flex items-center justify-center shrink-0 mt-0.5">
                                        <LineIcon className="w-3.5 h-3.5" />
                                      </div>
                                      <div className="min-w-0">
                                        <div className="flex items-center gap-2 flex-wrap">
                                          <span className="font-semibold text-slate-800">
                                            {line.description || meta.label}
                                          </span>
                                          <Badge variant={meta.badgeVariant}>{meta.label}</Badge>
                                        </div>
                                        <p className="text-slate-500 mt-0.5">
                                          SL: {line.quantity} {line.unit || ''} ×{' '}
                                          {formatMoney(line.unit_price)}
                                        </p>
                                      </div>
                                    </div>
                                    <span className="font-bold text-slate-900 shrink-0">
                                      {formatMoney(line.amount)}
                                    </span>
                                  </div>
                                );
                              })
                            )}

                            {/* Totals Footer */}
                            <div className="px-4 py-3 bg-slate-50/80 space-y-1 text-xs">
                              {Number(inv.adjustment_amount || 0) !== 0 ? (
                                <div className="flex justify-between text-slate-600">
                                  <span>Điều chỉnh / Giảm trừ:</span>
                                  <span>{formatMoney(inv.adjustment_amount)}</span>
                                </div>
                              ) : null}
                              <div className="flex justify-between font-semibold text-slate-800">
                                <span>Tổng cộng hóa đơn:</span>
                                <span>{formatMoney(inv.total_amount)}</span>
                              </div>
                              <div className="flex justify-between text-emerald-700">
                                <span>Đã thanh toán xác nhận:</span>
                                <span>{formatMoney(inv.paid_amount)}</span>
                              </div>
                              <div className="flex justify-between font-bold text-sm pt-1 border-t border-slate-200/70">
                                <span className="text-slate-900">Số tiền còn lại:</span>
                                <span
                                  className={
                                    remaining > 0 ? 'text-rose-600' : 'text-emerald-600'
                                  }
                                >
                                  {formatMoney(remaining)}
                                </span>
                              </div>
                            </div>
                          </div>
                        </div>

                        {/* Payment History */}
                        <div>
                          <h4 className="text-xs font-semibold text-slate-700 uppercase tracking-wider mb-2.5">
                            Lịch sử thanh toán & Đối soát ({payments.length})
                          </h4>
                          {payments.length === 0 ? (
                            <p className="text-xs text-slate-500 bg-white rounded-xl border border-slate-200/70 p-3.5">
                              Chưa có giao dịch thanh toán nào cho hóa đơn này.
                            </p>
                          ) : (
                            <div className="space-y-2">
                              {payments.map((p) => {
                                const proofs = Array.isArray(p.proof_images)
                                  ? p.proof_images
                                  : [];
                                return (
                                  <div
                                    key={p.id}
                                    className="p-3.5 rounded-xl bg-white border border-slate-200/80 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs"
                                  >
                                    <div className="space-y-1">
                                      <div className="flex items-center gap-2 flex-wrap">
                                        <span className="font-mono font-semibold text-slate-800">
                                          {p.payment_code}
                                        </span>
                                        <StatusBadge status={p.status} domain="payment" />
                                        <span className="text-slate-400">
                                          <Clock className="w-3 h-3 inline mr-1" />
                                          {formatDateTime(p.paid_at)}
                                        </span>
                                      </div>
                                      <p className="text-slate-600">
                                        Phương thức:{' '}
                                        <strong className="text-slate-800">
                                          {PAYMENT_METHOD_LABELS[p.method] || p.method}
                                        </strong>
                                        {p.reference_code
                                          ? ` • Mã GD: ${p.reference_code}`
                                          : ''}
                                        {p.note ? ` • Ghi chú: ${p.note}` : ''}
                                      </p>
                                      {proofs.length > 0 ? (
                                        <div className="flex flex-wrap gap-2 pt-1">
                                          {proofs.map((imgUrl, idx) => (
                                            <button
                                              key={idx}
                                              type="button"
                                              onClick={() => setPreviewImage(imgUrl)}
                                              className="w-12 h-12 rounded-lg border border-slate-200 overflow-hidden hover:ring-2 hover:ring-primary-400 transition-all"
                                            >
                                              <AuthImage
                                                src={imgUrl}
                                                alt="Biên lai"
                                                className="w-full h-full object-cover"
                                              />
                                            </button>
                                          ))}
                                        </div>
                                      ) : null}
                                    </div>
                                    <div className="text-left sm:text-right shrink-0">
                                      <span className="text-sm font-bold text-emerald-700">
                                        {formatMoney(p.amount)}
                                      </span>
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </Card>

      {/* Modal Báo Đã Thanh Toán */}
      <Modal
        open={payModalOpen}
        onClose={() => setPayModalOpen(false)}
        title="Báo đã thanh toán hóa đơn"
        subtitle="Gửi thông tin giao dịch và ảnh biên lai để kế toán Ban Quản Lý đối soát xác nhận"
        size="md"
        footer={
          <>
            <Button variant="outline" onClick={() => setPayModalOpen(false)} disabled={submitting}>
              Hủy
            </Button>
            <Button icon={Send} onClick={handleSubmitPayment} loading={submitting}>
              Gửi đối soát thanh toán
            </Button>
          </>
        }
      >
        <form onSubmit={handleSubmitPayment} className="space-y-4">
          <Select
            label="Chọn hóa đơn thanh toán"
            required
            placeholder="-- Chọn hóa đơn --"
            value={payForm.invoice_id}
            onChange={(e) => handleInvoiceChangeInModal(e.target.value)}
            options={unpaidInvoices.map((inv) => {
              const rem = Math.max(
                0,
                Number(inv.total_amount || 0) - Number(inv.paid_amount || 0)
              );
              return {
                value: inv.id,
                label: `Kỳ ${inv.period} (${inv.invoice_code}) — Còn nợ: ${formatMoney(rem)}`,
              };
            })}
          />

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Input
              type="number"
              min="1000"
              step="1000"
              required
              label="Số tiền đã chuyển (VNĐ)"
              placeholder="Nhập số tiền..."
              value={payForm.amount}
              hint={payForm.amount ? `Bằng số: ${formatMoney(payForm.amount)}` : undefined}
              onChange={(e) => setPayForm((s) => ({ ...s, amount: e.target.value }))}
            />

            <Select
              label="Phương thức thanh toán"
              value={payForm.method}
              onChange={(e) => setPayForm((s) => ({ ...s, method: e.target.value }))}
              options={PAYMENT_METHODS}
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Input
              label="Mã tham chiếu / Mã GD ngân hàng"
              placeholder="VD: FT2630291823..."
              value={payForm.reference_code}
              onChange={(e) =>
                setPayForm((s) => ({ ...s, reference_code: e.target.value }))
              }
            />

            <Input
              type="date"
              label="Ngày thực hiện giao dịch"
              value={payForm.paid_at}
              onChange={(e) => setPayForm((s) => ({ ...s, paid_at: e.target.value }))}
            />
          </div>

          <FileUpload
            label="Ảnh chụp biên lai / Ủy nhiệm chi chuyển khoản (tối đa 3 ảnh)"
            multiple
            maxFiles={3}
            value={payForm.proof_images}
            onChange={(imgs) => setPayForm((s) => ({ ...s, proof_images: imgs }))}
          />

          <Input
            multiline
            rows={2}
            label="Ghi chú gửi kế toán (tùy chọn)"
            placeholder="Ví dụ: Đã chuyển khoản thanh toán đủ kỳ tháng này..."
            value={payForm.note}
            onChange={(e) => setPayForm((s) => ({ ...s, note: e.target.value }))}
          />
        </form>
      </Modal>

      {/* Lightbox xem ảnh biên lai */}
      <Modal
        open={Boolean(previewImage)}
        onClose={() => setPreviewImage(null)}
        title="Ảnh chứng từ thanh toán"
        size="lg"
      >
        {previewImage ? (
          <div className="flex items-center justify-center bg-slate-900/5 rounded-xl p-2">
            <AuthImage
              src={previewImage}
              alt="Chứng từ"
              className="max-h-[70vh] w-auto rounded-lg object-contain"
            />
          </div>
        ) : null}
      </Modal>
    </div>
  );
}

export default InvoicesTab;
