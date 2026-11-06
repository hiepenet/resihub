import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
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
  Camera,
} from 'lucide-react';
import { Card } from '../../../components/ui/Card';
import { Button } from '../../../components/ui/Button';
import { Badge } from '../../../components/ui/Badge';
import { Input } from '../../../components/ui/Input';
import { MoneyInput } from '../../../components/ui/MoneyInput';
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
import { useVietQrBanks } from '../../../hooks/useVietQrBanks';
import { formatMoney, formatDate, formatDateTime, toInputDate } from '../../../utils/format';
import {
  resolveResidentInvoiceLineMeterImage,
  resolveResidentInvoiceTotalsSummary,
} from '../../../utils/billing';
import { matchVietQrBank } from '../../../utils/vietqrBanks';
import { extractErrorMessage } from '../../../utils/validation';
import {
  stripNotificationTriggerParams,
  pickDeepLinkTarget,
} from '../../../utils/notificationNavigation';

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
  const bankCode = raw.bank_code || raw.bankCode || '';
  const bankLogo = raw.bank_logo || raw.bankLogo || '';
  const accountNo = raw.account_no || raw.account_number || raw.accountNo || '';
  const accountName =
    raw.account_name || raw.account_holder || raw.holder_name || raw.accountName || '';
  const branch = raw.branch || '';
  if (!bank && !accountNo) return null;
  return {
    bank: bank || 'Ngân hàng đối tác',
    bank_code: bankCode,
    bank_logo: bankLogo,
    account_no: accountNo || '—',
    account_name: accountName || 'BAN QUAN LY RESIHUB',
    branch,
  };
}

export function InvoicesTab({
  overview,
  onRefreshOverview,
  actionParam,
  onClearActionParam,
  targetContractId = '',
}) {
  const toast = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const { banks } = useVietQrBanks();
  const contract = overview?.active_contract || overview?.contract || null;
  const [pinnedContractId, setPinnedContractId] = useState(() => targetContractId || '');

  useEffect(() => {
    if (targetContractId) {
      setPinnedContractId(targetContractId);
    }
  }, [targetContractId]);

  useEffect(() => {
    if (!targetContractId) {
      setPinnedContractId('');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contract?.contract_id]);

  const effectiveContractId = pinnedContractId || targetContractId || contract?.contract_id || '';

  const [invoices, setInvoices] = useState([]);
  const [creditBalances, setCreditBalances] = useState([]);
  const [detailInvoice, setDetailInvoice] = useState(null);
  const [detailCredit, setDetailCredit] = useState(null);
  const [paymentAccount, setPaymentAccount] = useState(DEFAULT_CORPORATE_ACCOUNT);

  const resolvedBankMeta = useMemo(
    () =>
      matchVietQrBank(banks, {
        bank_name: paymentAccount?.bank,
        bank_code: paymentAccount?.bank_code,
      }),
    [banks, paymentAccount?.bank, paymentAccount?.bank_code]
  );
  const displayBankLogo = paymentAccount?.bank_logo || resolvedBankMeta?.logo || '';
  const displayBankCode = paymentAccount?.bank_code || resolvedBankMeta?.code || '';
  const [loading, setLoading] = useState(true);
  const [filterTab, setFilterTab] = useState('all');
  const [expandedId, setExpandedId] = useState(null);
  const hasAutoExpandedRef = useRef(false);
  const [copiedField, setCopiedField] = useState('');
  const [previewImage, setPreviewImage] = useState(null);
  const [previewImageTitle, setPreviewImageTitle] = useState('Ảnh chứng từ thanh toán');

  const openImagePreview = (url, title = 'Ảnh chứng từ thanh toán') => {
    setPreviewImageTitle(title);
    setPreviewImage(url);
  };

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

  const [loadedContractKey, setLoadedContractKey] = useState(null);

  const loadInvoicesAndAccount = useCallback(async () => {
    const reqKey = String(effectiveContractId || '');
    setLoading(true);
    try {
      const [invRes, bldgRes, settingsRes] = await Promise.allSettled([
        residentService.listInvoices(effectiveContractId || undefined),
        buildingsService.list(),
        usersService.getSettings(),
      ]);

      let loadedInvoices = [];
      if (invRes.status === 'fulfilled') {
        loadedInvoices = invRes.value?.data || [];
        setInvoices(loadedInvoices);
        setCreditBalances(
          Array.isArray(invRes.value?.credit_balances) ? invRes.value.credit_balances : []
        );
        if (loadedInvoices.length > 0 && !hasAutoExpandedRef.current) {
          hasAutoExpandedRef.current = true;
          setExpandedId(loadedInvoices[0].id);
        }
      }

      // Resolve payment_account priority: Building lease_terms.payment_account -> Settings -> Overview -> Corporate default
      let resolvedAcc = null;
      const targetBuildingId =
        contract?.building_id ||
        loadedInvoices[0]?.building_id ||
        overview?.contract_history?.[0]?.building_id ||
        null;
      if (bldgRes.status === 'fulfilled') {
        const bldgs = Array.isArray(bldgRes.value?.data)
          ? bldgRes.value.data
          : Array.isArray(bldgRes.value)
          ? bldgRes.value
          : [];
        const matchedBldg =
          (targetBuildingId && bldgs.find((b) => b.id === targetBuildingId)) || bldgs[0] || null;
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
      setLoadedContractKey(reqKey);
      setLoading(false);
    }
  }, [effectiveContractId, contract?.building_id, contract?.payment_account, overview?.payment_account]);

  useEffect(() => {
    hasAutoExpandedRef.current = false;
  }, [effectiveContractId]);

  useEffect(() => {
    loadInvoicesAndAccount();
  }, [loadInvoicesAndAccount]);

  const unpaidInvoices = useMemo(
    () =>
      invoices.filter(
        (inv) =>
          ['ISSUED', 'PARTIALLY_PAID', 'OVERDUE', 'ADJUSTED'].includes(inv.status) &&
          Number(inv.total_amount || 0) - Number(inv.paid_amount || 0) > 0
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
      if (unpaidInvoices.length > 0) {
        openReportPaymentModal(unpaidInvoices[0]);
      }
      onClearActionParam?.();
    }
  }, [loading, actionParam, unpaidInvoices, openReportPaymentModal, onClearActionParam]);

  // Deep-link auto-modal từ thông báo: ?invoice_id=...&modal=pay|detail hoặc ?credit_id=...&modal=credit
  useEffect(() => {
    if (loading || loadedContractKey !== String(effectiveContractId || '')) return;
    const modal = searchParams.get('modal');
    const invoiceId = searchParams.get('invoice_id');
    const creditId = searchParams.get('credit_id');
    if (!modal && !invoiceId && !creditId) return;

    setSearchParams((prev) => stripNotificationTriggerParams(prev), { replace: true });

    if (modal === 'credit' || (creditId && !invoiceId)) {
      const matchedCredit = pickDeepLinkTarget(creditBalances, creditId);
      if (matchedCredit) {
        setDetailCredit(matchedCredit);
      } else if (
        !creditId &&
        Number(overview?.available_credit_balance || contract?.available_credit_balance || 0) > 0
      ) {
        setDetailCredit({
          id: 'available',
          amount: overview?.available_credit_balance || contract?.available_credit_balance || 0,
          applied_amount: 0,
          available_amount:
            overview?.available_credit_balance || contract?.available_credit_balance || 0,
          status: 'AVAILABLE',
          description: 'Số dư tín dụng khả dụng của hợp đồng',
        });
      } else {
        toast.info('Bản ghi liên quan không còn tồn tại hoặc đã thay đổi trạng thái.');
      }
      return;
    }

    const matchedInv = pickDeepLinkTarget(
      invoices,
      invoiceId,
      (i) => i.id,
      modal === 'pay' ? unpaidInvoices : invoices
    );

    if (!matchedInv) {
      toast.info('Bản ghi liên quan không còn tồn tại hoặc đã thay đổi trạng thái.');
      return;
    }

    setFilterTab('all');
    setExpandedId(matchedInv.id);
    const rem = Math.max(
      0,
      Number(matchedInv.total_amount || 0) - Number(matchedInv.paid_amount || 0)
    );
    const isUnpaid =
      ['ISSUED', 'PARTIALLY_PAID', 'OVERDUE', 'ADJUSTED'].includes(matchedInv.status) && rem > 0;

    if (modal === 'pay') {
      if (isUnpaid) {
        openReportPaymentModal(matchedInv);
      } else {
        setDetailInvoice(matchedInv);
      }
    } else {
      setDetailInvoice(matchedInv);
    }
  }, [
    loading,
    loadedContractKey,
    effectiveContractId,
    searchParams,
    setSearchParams,
    invoices,
    unpaidInvoices,
    creditBalances,
    overview?.available_credit_balance,
    contract?.available_credit_balance,
    openReportPaymentModal,
    toast,
  ]);

  const filteredInvoices = useMemo(() => {
    if (filterTab === 'unpaid') return unpaidInvoices;
    if (filterTab === 'paid') return invoices.filter((inv) => inv.status === 'PAID');
    return invoices;
  }, [invoices, unpaidInvoices, filterTab]);

  const summary = useMemo(() => {
    return invoices.reduce(
      (acc, inv) => {
        if (!['CANCELLED', 'DRAFT', 'VOID'].includes(inv.status)) {
          acc.totalBilled += Number(inv.total_amount || 0);
          acc.totalPaid += Number(inv.paid_amount || 0);
          if (['ISSUED', 'PARTIALLY_PAID', 'OVERDUE', 'ADJUSTED'].includes(inv.status)) {
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
      {/* Available Credit Balance Banner */}
      {Number(overview?.available_credit_balance || contract?.available_credit_balance || 0) > 0 ? (
        <div className="p-4 rounded-xl bg-sky-50 border border-sky-200 flex items-center justify-between gap-3 text-sky-900">
          <div className="flex items-center gap-3">
            <Sparkles className="w-5 h-5 text-sky-600 shrink-0" />
            <div>
              <p className="text-sm font-semibold">
                Số dư tín dụng khả dụng: {formatMoney(overview?.available_credit_balance || contract?.available_credit_balance)}
              </p>
              <p className="text-xs text-sky-700">
                Số dư này sẽ tự động được cấn trừ vào hóa đơn kỳ tới hoặc hoàn trả khi thanh lý hợp đồng.
              </p>
            </div>
          </div>
        </div>
      ) : null}

      {/* Top Grid: Summary + Bank Payment Account Card */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
        {/* Financial Summary */}
        <Card className="lg:col-span-7 flex flex-col justify-between">
          <div>
            <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
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
                className="w-full sm:w-auto"
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
                <div className="flex items-center gap-2 mt-0.5">
                  {displayBankLogo ? (
                    <img
                      src={displayBankLogo}
                      alt=""
                      className="w-8 h-5 object-contain rounded bg-white p-0.5 shrink-0"
                    />
                  ) : null}
                  <p className="text-sm font-semibold text-white">
                    {paymentAccount.bank}
                    {displayBankCode ? ` (${displayBankCode})` : ''}
                    {paymentAccount.branch ? ` — ${paymentAccount.branch}` : ''}
                  </p>
                </div>
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

          <div className="mt-3 pt-3 border-t border-white/10 flex flex-wrap items-center justify-between gap-2 text-xs">
            <div className="min-w-0">
              <span className="text-slate-400">Nội dung CK: </span>
              <code className="font-mono text-amber-300 font-semibold break-all">{transferSyntax}</code>
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
                const canPay = ['ISSUED', 'PARTIALLY_PAID', 'OVERDUE', 'ADJUSTED'].includes(inv.status) && remaining > 0;
                const lines = Array.isArray(inv.lines) ? inv.lines : [];
                const payments = Array.isArray(inv.payments) ? inv.payments : [];
                const hasPendingPayment = payments.some(
                  (p) => p.status === 'PENDING_CONFIRMATION' || p.status === 'PENDING'
                );

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
                            {inv.period ? `Kỳ ${inv.period}` : 'Phí phạt tất toán'}
                          </span>
                          <span className="text-xs font-mono text-slate-500">
                            #{inv.invoice_code}
                          </span>
                          <StatusBadge status={inv.status} domain="invoice" />
                          {hasPendingPayment ? (
                            <Badge variant="amber" dot>
                              Đang chờ đối soát TT
                            </Badge>
                          ) : null}
                        </div>
                        <p className="text-xs text-slate-500 flex items-center gap-2 flex-wrap">
                          {inv.issue_date ? (
                            <>
                              <span>Phát hành: {formatDate(inv.issue_date)}</span>
                              <span>•</span>
                            </>
                          ) : null}
                          <span className="inline-flex items-center gap-1">
                            <Calendar className="w-3.5 h-3.5 text-slate-400" />
                            Hạn TT: <strong className="text-slate-700">{formatDate(inv.due_date)}</strong>
                          </span>
                          <span>•</span>
                          <span>
                            Căn {inv.apartment_code}
                            {inv.building_name ? ` — ${inv.building_name}` : ''}
                          </span>
                        </p>
                      </div>

                      <div className="flex items-center justify-between sm:justify-end gap-4">
                        <div className="text-left sm:text-right">
                          <p className="text-[11px] text-slate-500">
                            {remaining > 0 ? 'Còn phải trả' : 'Tổng hóa đơn'}
                          </p>
                          <p
                            className={`text-base font-bold tabular-nums ${
                              remaining > 0 ? 'text-rose-600' : 'text-emerald-600'
                            }`}
                          >
                            {formatMoney(remaining > 0 ? remaining : inv.total_amount)}
                          </p>
                          {remaining > 0 && Number(inv.paid_amount || 0) > 0 ? (
                            <p className="text-[11px] text-slate-500">
                              Đã trả {formatMoney(inv.paid_amount)} / {formatMoney(inv.total_amount)}
                            </p>
                          ) : null}
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
                            aria-label={isExpanded ? 'Thu gọn chi tiết hóa đơn' : 'Mở rộng chi tiết hóa đơn'}
                            aria-expanded={isExpanded}
                            className="min-w-[44px] min-h-[44px] sm:min-w-0 sm:min-h-0 p-1.5 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100 inline-flex items-center justify-center"
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
                                const meterImageUrl = resolveResidentInvoiceLineMeterImage(line);
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
                                        {line.formula_meta?.description || line.formula_meta?.formula ? (
                                          <p className="text-[11px] text-indigo-700 bg-indigo-50/80 rounded px-1.5 py-0.5 mt-1 inline-block font-mono">
                                            {line.formula_meta.description || line.formula_meta.formula}
                                          </p>
                                        ) : null}
                                        {meterImageUrl ? (
                                          <div className="mt-1.5 flex items-center gap-2">
                                            <button
                                              type="button"
                                              aria-label={`Xem ảnh chụp mặt đồng hồ — ${line.description || meta.label}`}
                                              onClick={() =>
                                                openImagePreview(
                                                  meterImageUrl,
                                                  `Ảnh mặt đồng hồ đối chứng — ${line.description || meta.label}`
                                                )
                                              }
                                              className="min-h-[44px] sm:min-h-0 inline-flex items-center gap-1.5 px-3 sm:px-2 py-2 sm:py-1 rounded-lg border border-sky-200 bg-sky-50/80 text-[11px] font-semibold text-sky-700 hover:bg-sky-100 transition-colors"
                                            >
                                              <Camera className="w-3.5 h-3.5" />
                                              <span>Xem ảnh đồng hồ</span>
                                            </button>
                                            <button
                                              type="button"
                                              aria-label="Xem ảnh chụp mặt đồng hồ"
                                              onClick={() =>
                                                openImagePreview(
                                                  meterImageUrl,
                                                  `Ảnh mặt đồng hồ đối chứng — ${line.description || meta.label}`
                                                )
                                              }
                                              className="min-w-[44px] min-h-[44px] sm:min-w-0 sm:min-h-0 w-11 h-11 sm:w-8 sm:h-8 rounded-md border border-slate-200 overflow-hidden hover:ring-2 hover:ring-sky-400 transition-all shrink-0"
                                              title="Xem ảnh chụp mặt đồng hồ"
                                            >
                                              <AuthImage
                                                src={meterImageUrl}
                                                alt="Ảnh mặt đồng hồ"
                                                className="w-full h-full object-cover"
                                              />
                                            </button>
                                          </div>
                                        ) : null}
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
                            {(() => {
                              const totalsSummary = resolveResidentInvoiceTotalsSummary(inv);
                              return (
                                <div className="px-4 py-3 bg-slate-50/80 space-y-1 text-xs">
                                  {totalsSummary.hasBreakdown ? (
                                    <>
                                      <div className="flex justify-between text-slate-600">
                                        <span>Cộng tiền trước điều chỉnh / cấn trừ:</span>
                                        <span>{formatMoney(totalsSummary.subtotalAmount)}</span>
                                      </div>
                                      {totalsSummary.adjustmentAmount !== 0 ? (
                                        <div className="flex justify-between text-slate-600">
                                          <span>Điều chỉnh / Giảm trừ:</span>
                                          <span>{formatMoney(totalsSummary.adjustmentAmount)}</span>
                                        </div>
                                      ) : null}
                                      {totalsSummary.creditOffsetAmount > 0 ? (
                                        <div className="flex justify-between text-emerald-700 font-medium">
                                          <span>Tín dụng cấn trừ kỳ trước:</span>
                                          <span>-{formatMoney(totalsSummary.creditOffsetAmount)}</span>
                                        </div>
                                      ) : null}
                                    </>
                                  ) : null}
                                  <div className="flex justify-between font-semibold text-slate-800">
                                    <span>Tổng cộng hóa đơn:</span>
                                    <span>{formatMoney(totalsSummary.totalAmount)}</span>
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
                              );
                            })()}
                          </div>
                          {inv.note ? (
                            <div className="mt-2.5 p-3 rounded-xl bg-amber-50/70 border border-amber-200/80 text-xs text-slate-700 whitespace-pre-line break-words">
                              <span className="font-semibold text-slate-800">Ghi chú hóa đơn: </span>
                              {inv.note}
                            </div>
                          ) : null}
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
                                const isRejected = p.status === 'REJECTED';
                                const isConfirmed = p.status === 'CONFIRMED';
                                return (
                                  <div
                                    key={p.id}
                                    className="p-3.5 rounded-xl bg-white border border-slate-200/80 flex flex-col sm:flex-row sm:items-start justify-between gap-3 text-xs"
                                  >
                                    <div className="space-y-1 min-w-0 flex-1">
                                      <div className="flex items-center gap-2 flex-wrap">
                                        <span className="font-mono font-semibold text-slate-800">
                                          {p.payment_code}
                                        </span>
                                        <StatusBadge status={p.status} domain="payment" />
                                        <span className="text-slate-400">
                                          <Clock className="w-3 h-3 inline mr-1" />
                                          {formatDateTime(p.paid_at)}
                                        </span>
                                        {p.confirmed_at ? (
                                          <span className="text-emerald-700">
                                            • Đối soát {formatDateTime(p.confirmed_at)}
                                          </span>
                                        ) : null}
                                      </div>
                                      <p className="text-slate-600 break-words">
                                        Phương thức:{' '}
                                        <strong className="text-slate-800">
                                          {PAYMENT_METHOD_LABELS[p.method] || p.method}
                                        </strong>
                                        {p.reference_code
                                          ? ` • Mã GD: ${p.reference_code}`
                                          : ''}
                                      </p>
                                      {Number(p.overpayment_amount || 0) > 0 ? (
                                        <p className="text-sky-700 font-medium">
                                          Tiền nộp dư: {formatMoney(p.overpayment_amount)}
                                        </p>
                                      ) : null}
                                      {p.note ? (
                                        <div
                                          className={`rounded-lg px-2.5 py-1.5 whitespace-pre-line break-words ${
                                            isRejected
                                              ? 'bg-rose-50 border border-rose-200 text-rose-800'
                                              : 'bg-slate-50 border border-slate-200/60 text-slate-700'
                                          }`}
                                        >
                                          {p.note}
                                        </div>
                                      ) : null}
                                      {proofs.length > 0 ? (
                                        <div className="flex flex-wrap gap-2 pt-1">
                                          {proofs.map((imgUrl, idx) => (
                                            <button
                                              key={idx}
                                              type="button"
                                              onClick={() =>
                                                openImagePreview(imgUrl, 'Ảnh chứng từ thanh toán')
                                              }
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
                                      <span
                                        className={`text-sm font-bold tabular-nums ${
                                          isRejected
                                            ? 'text-rose-600 line-through'
                                            : isConfirmed
                                            ? 'text-emerald-700'
                                            : 'text-amber-700'
                                        }`}
                                      >
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
                label: `${inv.period ? `Kỳ ${inv.period}` : 'Phí phạt tất toán'} (${inv.invoice_code}) — Còn nợ: ${formatMoney(rem)}`,
              };
            })}
          />

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <MoneyInput
              required
              label="Số tiền đã chuyển (VNĐ)"
              placeholder="VD: 8.500.000"
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

      {/* Modal Chi tiết Hóa đơn (Read-only / Quick Pay từ thông báo) */}
      <Modal
        open={Boolean(detailInvoice)}
        onClose={() => setDetailInvoice(null)}
        title={
          detailInvoice
            ? `Chi tiết hóa đơn #${detailInvoice.invoice_code || ''} — ${detailInvoice.period ? `Kỳ ${detailInvoice.period}` : 'Phí phạt tất toán'}`
            : 'Chi tiết hóa đơn'
        }
        subtitle={
          detailInvoice
            ? `Căn ${detailInvoice.apartment_code || contract?.apartment_code || '—'}${
                detailInvoice.building_name ? ` — ${detailInvoice.building_name}` : ''
              }`
            : ''
        }
        size="lg"
        footer={
          detailInvoice ? (
            <div className="flex flex-wrap items-center justify-end gap-2 w-full">
              <Button variant="outline" onClick={() => setDetailInvoice(null)}>
                Đóng
              </Button>
              {['ISSUED', 'PARTIALLY_PAID', 'OVERDUE', 'ADJUSTED'].includes(detailInvoice.status) &&
              Math.max(
                0,
                Number(detailInvoice.total_amount || 0) - Number(detailInvoice.paid_amount || 0)
              ) > 0 ? (
                <Button
                  icon={CreditCard}
                  onClick={() => {
                    const inv = detailInvoice;
                    setDetailInvoice(null);
                    openReportPaymentModal(inv);
                  }}
                >
                  Báo đã thanh toán
                </Button>
              ) : null}
            </div>
          ) : null
        }
      >
        {detailInvoice ? (
          <div className="space-y-4 text-xs">
            <div className="flex flex-wrap items-center justify-between gap-2 p-3.5 rounded-xl bg-slate-50 border border-slate-200/80">
              <div className="space-y-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-mono font-bold text-slate-900 text-sm">
                    #{detailInvoice.invoice_code}
                  </span>
                  <StatusBadge status={detailInvoice.status} domain="invoice" />
                </div>
                <p className="text-slate-600">
                  Hạn thanh toán: <strong>{formatDate(detailInvoice.due_date)}</strong>
                </p>
              </div>
              <div className="text-right">
                <p className="text-slate-500">Tổng hóa đơn / Còn lại</p>
                <p className="text-base font-bold text-slate-900 tabular-nums">
                  {formatMoney(detailInvoice.total_amount)} •{' '}
                  <span className="text-rose-600">
                    {formatMoney(
                      Math.max(
                        0,
                        Number(detailInvoice.total_amount || 0) -
                          Number(detailInvoice.paid_amount || 0)
                      )
                    )}
                  </span>
                </p>
              </div>
            </div>

            {Array.isArray(detailInvoice.lines) && detailInvoice.lines.length > 0 ? (
              <div className="rounded-xl border border-slate-200 divide-y divide-slate-100 overflow-hidden">
                {detailInvoice.lines.map((line) => (
                  <div
                    key={line.id}
                    className="px-3.5 py-2.5 flex items-center justify-between gap-2 bg-white"
                  >
                    <div className="min-w-0">
                      <p className="font-semibold text-slate-800 break-words">{line.description}</p>
                      <p className="text-slate-500">
                        {line.quantity} {line.unit || ''} × {formatMoney(line.unit_price)}
                      </p>
                    </div>
                    <span className="font-bold text-slate-900 shrink-0">
                      {formatMoney(line.amount)}
                    </span>
                  </div>
                ))}
              </div>
            ) : null}

            {Array.isArray(detailInvoice.payments) && detailInvoice.payments.length > 0 ? (
              <div className="space-y-2">
                <p className="font-semibold text-slate-700 uppercase tracking-wider">
                  Giao dịch thanh toán ({detailInvoice.payments.length})
                </p>
                {detailInvoice.payments.map((p) => (
                  <div
                    key={p.id}
                    className="p-3 rounded-xl bg-slate-50 border border-slate-200/80 flex items-center justify-between gap-2"
                  >
                    <div className="space-y-0.5 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-mono font-semibold text-slate-800">
                          {p.payment_code}
                        </span>
                        <StatusBadge status={p.status} domain="payment" />
                      </div>
                      {p.note ? (
                        <p className="text-slate-600 break-words">{p.note}</p>
                      ) : null}
                    </div>
                    <span className="font-bold text-slate-900 shrink-0">
                      {formatMoney(p.amount)}
                    </span>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
      </Modal>

      {/* Modal Chi tiết Sổ Tín Dụng (Credit Balance) */}
      <Modal
        open={Boolean(detailCredit)}
        onClose={() => setDetailCredit(null)}
        title="Chi tiết Số dư Tín dụng & Hoàn tiền"
        subtitle="Theo dõi biến động tiền nộp dư, cấn trừ hóa đơn và đề nghị hoàn trả"
        size="md"
        footer={
          <Button variant="outline" onClick={() => setDetailCredit(null)}>
            Đóng
          </Button>
        }
      >
        {detailCredit ? (
          <div className="space-y-3.5 text-xs">
            <div className="p-3.5 rounded-xl bg-sky-50/70 border border-sky-200 flex items-center justify-between gap-2">
              <div>
                <p className="text-slate-500">Trạng thái khoản tín dụng</p>
                <div className="mt-1">
                  <StatusBadge status={detailCredit.status || 'AVAILABLE'} domain="credit_balance" />
                </div>
              </div>
              <div className="text-right">
                <p className="text-slate-500">Số dư khả dụng / Giá trị gốc</p>
                <p className="text-base font-bold text-sky-700 tabular-nums">
                  {formatMoney(
                    detailCredit.available_amount ??
                      Math.max(
                        0,
                        Number(detailCredit.amount || 0) - Number(detailCredit.applied_amount || 0)
                      )
                  )}{' '}
                  <span className="text-xs font-normal text-slate-500">
                    / {formatMoney(detailCredit.amount || 0)}
                  </span>
                </p>
              </div>
            </div>

            {detailCredit.description ? (
              <div className="p-3 rounded-xl bg-slate-50 border border-slate-200/80 text-slate-700 whitespace-pre-line break-words">
                <span className="font-semibold text-slate-900">Diễn giải: </span>
                {detailCredit.description}
              </div>
            ) : null}

            {detailCredit.refund_meta?.rejection_reason ? (
              <div className="p-3 rounded-xl bg-rose-50 border border-rose-200 text-rose-800 whitespace-pre-line break-words">
                <span className="font-semibold">Lý do từ chối hoàn tiền: </span>
                {detailCredit.refund_meta.rejection_reason}
              </div>
            ) : null}
          </div>
        ) : null}
      </Modal>

      {/* Lightbox xem ảnh biên lai / ảnh mặt đồng hồ */}
      <Modal
        open={Boolean(previewImage)}
        onClose={() => setPreviewImage(null)}
        title={previewImageTitle}
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
