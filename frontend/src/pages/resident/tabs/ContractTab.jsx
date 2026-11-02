import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  FileText,
  Printer,
  Download,
  RefreshCw,
  LogOut,
  ShieldCheck,
  ShieldAlert,
  History,
  FileDiff,
  CheckCircle2,
  Clock,
  Calendar,
  Building2,
  Users,
  AlertTriangle,
  ArrowUpRight,
  ArrowDownLeft,
  Landmark,
} from 'lucide-react';
import { Card, CardHeader } from '../../../components/ui/Card';
import { Button } from '../../../components/ui/Button';
import { Badge } from '../../../components/ui/Badge';
import { Input } from '../../../components/ui/Input';
import { Select } from '../../../components/ui/Select';
import { BankSelect } from '../../../components/common/BankSelect';
import { Modal } from '../../../components/ui/Modal';
import { Skeleton } from '../../../components/ui/Skeleton';
import { AuthImage } from '../../../components/ui/FileUpload';
import { StatusBadge } from '../../../components/common/StatusBadge';
import { EmptyState } from '../../../components/common/EmptyState';
import { residentService } from '../../../services/resident.service';
import { contractsService } from '../../../services/contracts.service';
import { useVietQrBanks } from '../../../hooks/useVietQrBanks';
import { useToast } from '../../../hooks/useToast';
import { formatMoney, formatDate, formatDateTime, toInputDate, maskIdNumber } from '../../../utils/format';
import { matchVietQrBank } from '../../../utils/vietqrBanks';
import {
  addDaysStr,
  addMonthsClampedStr,
  formatDateVi,
  getDateOrderError,
  maxDateStr,
  toDateOnlyStr,
} from '../../../utils/dateRange';
import { extractErrorMessage } from '../../../utils/validation';
import { createIdempotencyKey } from '../../../utils/idempotency';
import {
  getResidentDisputeWindowState,
  canResidentUpdateRefundBankInfo,
} from '../../../utils/depositUiHelpers';

const DIFF_FIELD_LABELS = {
  rent_amount: 'Giá thuê hàng tháng',
  deposit_amount: 'Tiền đặt cọc',
  end_date: 'Ngày kết thúc HĐ',
  start_date: 'Ngày bắt đầu HĐ',
  billing_day: 'Ngày chốt kỳ',
  payment_due_days: 'Hạn thanh toán (ngày)',
  note: 'Ghi chú',
};

const DEPOSIT_TX_LABELS = {
  collect: { label: 'Thu tiền cọc', sign: '+', variant: 'emerald' },
  transfer: { label: 'Kết chuyển cọc', sign: '+', variant: 'sky' },
  refund: { label: 'Hoàn trả cọc', sign: '-', variant: 'indigo' },
  refund_reversal: { label: 'Ngân hàng trả lại lệnh chi', sign: '+', variant: 'amber' },
  deduct: { label: 'Khấu trừ cọc', sign: '-', variant: 'amber' },
  forfeit: { label: 'Thu hồi cọc vi phạm', sign: '-', variant: 'red' },
};

function resolveResidentDepositTxMeta(tx) {
  const desc = String(tx?.description || tx?.note || '').trim();
  if (tx?.type === 'transfer' && /^chuyển kết dư/i.test(desc)) {
    return { label: 'Kết chuyển đi', sign: '-', variant: 'amber' };
  }
  return DEPOSIT_TX_LABELS[tx?.type] || { label: tx?.type || 'Giao dịch', sign: '', variant: 'slate' };
}

const REQUEST_STATUS_MAP = {
  SUBMITTED: { label: 'Chờ BQL xử lý', variant: 'amber' },
  APPROVED: { label: 'Đã chấp thuận', variant: 'emerald' },
  REJECTED: { label: 'Từ chối', variant: 'red' },
  CANCELLED: { label: 'Đã hủy', variant: 'slate' },
};

const AMENDMENT_META_KEYS = [
  'status',
  'snapshot',
  'created_by',
  'approved_at',
  'approved_by',
  'created_at',
  'rejected_by',
  'rejected_at',
  'rejection_reason',
];

const DEDUCT_CATEGORY_LABELS = {
  DAMAGE: 'Hư hỏng tài sản',
  CLEANING: 'Vệ sinh mặt bằng',
  UTILITY_DEBT: 'Điện / nước / tiện ích',
  OTHER: 'Khấu trừ khác',
};

const PAYMENT_METHOD_LABELS = {
  BANK_TRANSFER: 'Chuyển khoản ngân hàng',
  TRANSFER: 'Chuyển khoản',
  QR_CODE: 'QR Code',
  E_WALLET: 'Ví điện tử',
  EWALLET: 'Ví điện tử',
  CASH: 'Tiền mặt',
  CARD: 'Thẻ',
  OTHER: 'Khác',
};

const BILLING_CYCLE_LABELS = {
  MONTHLY: 'hàng tháng',
  QUARTERLY: 'hàng quý',
  SEMI_ANNUALLY: '6 tháng/lần',
  YEARLY: 'hàng năm',
  ANNUALLY: 'hàng năm',
};

function formatDiffValue(key, val) {
  if (val === null || val === undefined || val === '') return '—';
  if (key.includes('amount')) return formatMoney(val);
  if (key.includes('date')) return formatDate(val);
  if (typeof val === 'object') return JSON.stringify(val);
  return String(val);
}

export function ContractTab({ overview, onRefreshOverview, onNavigateTab }) {
  const toast = useToast();
  const { banks } = useVietQrBanks();
  const iframeRef = useRef(null);

  const contract = overview?.active_contract || overview?.contract || null;
  const contractHistory = Array.isArray(overview?.contract_history) ? overview.contract_history : [];
  const amendments = Array.isArray(overview?.amendments) ? overview.amendments : [];

  const [depositData, setDepositData] = useState({ deposit: null, transactions: [] });
  const [contractRequests, setContractRequests] = useState([]);
  const [occupants, setOccupants] = useState([]);
  const [loadingExtra, setLoadingExtra] = useState(true);

  // Print A4 Template Modal
  const [templateOpen, setTemplateOpen] = useState(false);
  const [templateLoading, setTemplateLoading] = useState(false);
  const [templateHtml, setTemplateHtml] = useState('');

  // Renewal / Termination Request Modal
  const [reqModalOpen, setReqModalOpen] = useState(false);
  const [reqSubmitting, setReqSubmitting] = useState(false);
  const [reqForm, setReqForm] = useState({
    type: 'RENEWAL',
    desired_date: '',
    note: '',
  });

  // Deposit Settlement Dispute & Print states (R-07, R-24)
  const [disputeModalOpen, setDisputeModalOpen] = useState(false);
  const [disputeDepositTarget, setDisputeDepositTarget] = useState(null);
  const [disputeReason, setDisputeReason] = useState('');
  const [submittingDispute, setSubmittingDispute] = useState(false);
  const [printingSettlementId, setPrintingSettlementId] = useState(null);
  const [previewEvidenceSrc, setPreviewEvidenceSrc] = useState(null);

  // Resident Refund Bank Info Update Modal (Phase 2 — APPROVED_PENDING_PAYOUT / RETURNED)
  const [bankModalOpen, setBankModalOpen] = useState(false);
  const [bankDepositTarget, setBankDepositTarget] = useState(null);
  const [bankForm, setBankForm] = useState({
    bank_name: '',
    bank_code: '',
    bank_bin: '',
    bank_logo: '',
    account_number: '',
    account_holder: '',
  });
  const [submittingBankInfo, setSubmittingBankInfo] = useState(false);

  const loadContractDetails = useCallback(async () => {
    setLoadingExtra(true);
    try {
      const promises = [
        residentService.listDepositTransactions(contract?.contract_id),
        residentService.listContractRequests(contract?.contract_id),
      ];
      if (contract?.contract_id) {
        promises.push(contractsService.listOccupants(contract.contract_id));
      }
      const [depRes, reqRes, occRes] = await Promise.allSettled(promises);

      if (depRes.status === 'fulfilled') {
        setDepositData(depRes.value?.data || { deposit: null, transactions: [] });
      }
      if (reqRes.status === 'fulfilled') {
        setContractRequests(reqRes.value?.data || []);
      }
      if (occRes && occRes.status === 'fulfilled') {
        setOccupants(occRes.value?.data || []);
      }
    } finally {
      setLoadingExtra(false);
    }
  }, [contract?.contract_id]);

  useEffect(() => {
    loadContractDetails();
  }, [loadContractDetails]);

  const handleOpenTemplate = async (targetContractId) => {
    const cid = targetContractId || contract?.contract_id;
    if (!cid) return;
    setTemplateOpen(true);
    setTemplateLoading(true);
    setTemplateHtml('');
    try {
      const html = await contractsService.getTemplateHtml(cid);
      setTemplateHtml(html);
    } catch (err) {
      toast.error(extractErrorMessage(err, 'Không thể tải bản in hợp đồng A4.'));
      setTemplateOpen(false);
    } finally {
      setTemplateLoading(false);
    }
  };

  const handlePrintA4 = () => {
    if (iframeRef.current?.contentWindow) {
      iframeRef.current.contentWindow.focus();
      iframeRef.current.contentWindow.print();
    }
  };

  const handleDownloadHtml = () => {
    if (!templateHtml) return;
    const code = contract?.apartment_code || 'HopDong';
    const blob = new Blob([templateHtml], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `HopDong_${code}_A4.html`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const contractStartStr = toDateOnlyStr(contract?.start_date);
  const contractEndStr = toDateOnlyStr(contract?.end_date);
  const todayDateStr = toInputDate(new Date());
  const minRenewalDesiredDate = contractEndStr
    ? addDaysStr(contractEndStr, 1)
    : todayDateStr;
  const minTerminationDesiredDate = maxDateStr(todayDateStr, contractStartStr);
  const maxTerminationDesiredDate =
    contractEndStr && contractEndStr >= minTerminationDesiredDate ? contractEndStr : '';

  const getDefaultDesiredDateForType = (type) => {
    if (type === 'RENEWAL') {
      return contractEndStr
        ? addMonthsClampedStr(contractEndStr, 12)
        : addMonthsClampedStr(todayDateStr, 12);
    }
    const plus30 = addDaysStr(todayDateStr, 30);
    if (maxTerminationDesiredDate && plus30 > maxTerminationDesiredDate) {
      return maxTerminationDesiredDate;
    }
    return maxDateStr(plus30, minTerminationDesiredDate);
  };

  const reqDesiredDateError = (() => {
    if (!reqForm.desired_date) return '';
    if (reqForm.type === 'RENEWAL') {
      if (contractEndStr) {
        return getDateOrderError(contractEndStr, reqForm.desired_date, {
          strictAfter: true,
          startLabel: `Ngày hết hạn HĐ hiện tại (${formatDateVi(contractEndStr)})`,
          endLabel: 'Ngày kết thúc mới mong muốn',
        });
      }
      return getDateOrderError(todayDateStr, reqForm.desired_date, {
        strictAfter: false,
        startLabel: 'Hôm nay',
        endLabel: 'Ngày kết thúc mới mong muốn',
      });
    }
    if (minTerminationDesiredDate && reqForm.desired_date < minTerminationDesiredDate) {
      return `Ngày dự kiến bàn giao không được nhỏ hơn ${formatDateVi(minTerminationDesiredDate)}.`;
    }
    if (maxTerminationDesiredDate && reqForm.desired_date > maxTerminationDesiredDate) {
      return `Ngày dự kiến bàn giao không được vượt quá ngày hết hạn HĐ (${formatDateVi(maxTerminationDesiredDate)}).`;
    }
    return '';
  })();

  const openRequestModal = (type = 'RENEWAL') => {
    setReqForm({
      type,
      desired_date: getDefaultDesiredDateForType(type),
      note: '',
    });
    setReqModalOpen(true);
  };

  const handleSubmitContractRequest = async (e) => {
    e.preventDefault();
    if (reqForm.type === 'TERMINATION' && !reqForm.desired_date) {
      toast.warning('Vui lòng chọn ngày mong muốn chấm dứt hợp đồng.');
      return;
    }
    if (reqDesiredDateError) {
      toast.warning(reqDesiredDateError);
      return;
    }

    setReqSubmitting(true);
    try {
      const res = await residentService.createContractRequest({
        contract_id: contract?.contract_id || undefined,
        type: reqForm.type,
        desired_date: reqForm.desired_date || undefined,
        note: reqForm.note?.trim() || undefined,
      });
      toast.success(res?.message || 'Đã gửi đề nghị hợp đồng tới Ban Quản Lý.');
      setReqModalOpen(false);
      await Promise.allSettled([loadContractDetails(), onRefreshOverview?.()]);
    } catch (err) {
      toast.error(extractErrorMessage(err, 'Không thể gửi đề nghị hợp đồng.'));
    } finally {
      setReqSubmitting(false);
    }
  };

  const disputeIdemKeyRef = useRef(createIdempotencyKey());
  const bankIdemKeyRef = useRef(createIdempotencyKey());

  const handleOpenBankModal = (sd) => {
    bankIdemKeyRef.current = createIdempotencyKey();
    const existingBank = sd?.settlement?.bank_info || {};
    const matched = matchVietQrBank(banks, existingBank);
    setBankDepositTarget(sd);
    setBankForm({
      bank_name: matched ? matched.shortName : existingBank.bank_name || '',
      bank_code: existingBank.bank_code || matched?.code || '',
      bank_bin: existingBank.bank_bin || matched?.bin || '',
      bank_logo: existingBank.bank_logo || matched?.logo || '',
      account_number: existingBank.account_number || existingBank.account_no || '',
      account_holder: existingBank.account_holder || existingBank.account_name || overview?.profile?.full_name || '',
    });
    setBankModalOpen(true);
  };

  const handleSubmitBankInfo = async (e) => {
    e?.preventDefault();
    if (!bankDepositTarget?.deposit_id) return;
    const bName = String(bankForm.bank_name || '').trim();
    const accNo = String(bankForm.account_number || '').trim();
    const accHolder = String(bankForm.account_holder || '').trim();
    if (!bName || !accNo || !accHolder) {
      toast.warning('Vui lòng nhập đầy đủ Ngân hàng, Số tài khoản và Chủ tài khoản nhận hoàn cọc.');
      return;
    }
    if (!/^[A-Za-z0-9]{4,25}$/.test(accNo)) {
      toast.warning('Số tài khoản ngân hàng chỉ gồm chữ và số (4–25 ký tự, không khoảng trắng).');
      return;
    }
    setSubmittingBankInfo(true);
    try {
      const res = await residentService.updateDepositRefundBankInfo(
        bankDepositTarget.deposit_id,
        {
          bank_info: {
            bank_name: bName,
            bank_code: bankForm.bank_code || undefined,
            bank_bin: bankForm.bank_bin || undefined,
            bank_logo: bankForm.bank_logo || undefined,
            account_number: accNo,
            account_holder: accHolder,
          },
        },
        { idempotencyKey: bankIdemKeyRef.current }
      );
      bankIdemKeyRef.current = createIdempotencyKey();
      toast.success(res?.message || 'Đã cập nhật thông tin tài khoản nhận hoàn cọc.');
      setBankModalOpen(false);
      setBankDepositTarget(null);
      await Promise.allSettled([loadContractDetails(), onRefreshOverview?.()]);
    } catch (err) {
      toast.error(extractErrorMessage(err, 'Không thể cập nhật tài khoản nhận hoàn cọc.'));
    } finally {
      setSubmittingBankInfo(false);
    }
  };

  const handleOpenDisputeModal = (depEntry) => {
    disputeIdemKeyRef.current = createIdempotencyKey();
    setDisputeDepositTarget(depEntry);
    setDisputeReason('');
    setDisputeModalOpen(true);
  };

  const handleSubmitDispute = async (e) => {
    e?.preventDefault();
    if (!disputeDepositTarget?.deposit_id) return;
    if (!disputeReason.trim()) {
      toast.warning('Vui lòng nhập lý do không đồng ý / khiếu nại bảng kê tất toán cọc.');
      return;
    }
    setSubmittingDispute(true);
    try {
      const res = await residentService.disputeDeposit(
        disputeDepositTarget.deposit_id,
        { reason: disputeReason.trim() },
        { idempotencyKey: disputeIdemKeyRef.current }
      );
      toast.success(res?.message || 'Đã gửi khiếu nại bảng kê tất toán tiền cọc tới Ban Quản Lý.');
      setDisputeModalOpen(false);
      setDisputeDepositTarget(null);
      setDisputeReason('');
      await Promise.allSettled([loadContractDetails(), onRefreshOverview?.()]);
    } catch (err) {
      toast.error(extractErrorMessage(err, 'Không thể gửi khiếu nại tất toán tiền cọc.'));
    } finally {
      setSubmittingDispute(false);
    }
  };

  const handlePrintSettlementPdf = async (depositId) => {
    if (!depositId) return;
    const printWin = window.open('', '_blank');
    if (!printWin) {
      toast.warning(
        'Trình duyệt đang chặn cửa sổ bật lên (Pop-up). Vui lòng cho phép mở tab mới để xem / in bảng kê.'
      );
      return;
    }
    printWin.document.write(
      '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Đang tải bảng kê tất toán...</title></head><body style="font-family:sans-serif;padding:40px;text-align:center;color:#334155;">Đang chuẩn bị bản in Bảng kê tất toán tiền cọc...</body></html>'
    );
    setPrintingSettlementId(depositId);
    try {
      const html = await residentService.getDepositSettlementPdfHtml(depositId);
      printWin.document.open();
      printWin.document.write(html);
      printWin.document.close();
    } catch (err) {
      printWin.close();
      toast.error(extractErrorMessage(err, 'Không thể tải bản in bảng kê tất toán tiền cọc.'));
    } finally {
      setPrintingSettlementId(null);
    }
  };

  // Tổng hợp danh sách sổ cọc có bảng kê tất toán (từ overview.deposit_settlements, contract hiện tại, depositData và lịch sử HĐ)
  const settlementDeposits = useMemo(() => {
    const map = new Map();
    const putEntry = (entry) => {
      if (!entry?.deposit_id) return;
      const hasSettlement =
        entry.settlement &&
        typeof entry.settlement === 'object' &&
        Object.keys(entry.settlement).length > 0;
      const inSettlementStatus = [
        'SETTLEMENT_DRAFT',
        'PENDING_APPROVAL',
        'APPROVED_PENDING_PAYOUT',
        'PARTIALLY_REFUNDED',
        'REFUNDED',
        'DEDUCTED_FULL',
        'RETURNED',
        'DISPUTED',
      ].includes(entry.deposit_status);
      if (!hasSettlement && !inSettlementStatus) return;

      const key = String(entry.deposit_id);
      const prev = map.get(key) || {};
      map.set(key, {
        ...prev,
        ...entry,
        settlement: hasSettlement ? entry.settlement : prev.settlement || null,
      });
    };

    if (contract?.deposit_id) {
      putEntry({
        deposit_id: contract.deposit_id,
        apartment_code: contract.apartment_code,
        building_name: contract.building_name,
        amount_held: contract.deposit_held_amount,
        deposit_status: contract.deposit_status,
        refund_due_date: contract.deposit_refund_due_date ?? contract.refund_due_date,
        settlement: contract.deposit_settlement,
      });
    }

    contractHistory.forEach((ch) => {
      if (ch?.deposit_id) {
        putEntry({
          deposit_id: ch.deposit_id,
          apartment_code: ch.apartment_code,
          building_name: ch.building_name,
          amount_held: ch.deposit_held_amount ?? ch.amount_held,
          deposit_status: ch.deposit_status,
          refund_due_date: ch.deposit_refund_due_date ?? ch.refund_due_date,
          settlement: ch.deposit_settlement,
        });
      }
    });

    if (depositData?.deposit?.id) {
      putEntry({
        deposit_id: depositData.deposit.id,
        apartment_code: contract?.apartment_code,
        building_name: contract?.building_name,
        amount_held: depositData.deposit.amount_held,
        deposit_status: depositData.deposit.status,
        refund_due_date: depositData.deposit.refund_due_date,
        settlement: depositData.deposit.settlement,
      });
    }

    if (Array.isArray(overview?.deposit_settlements)) {
      overview.deposit_settlements.forEach((ds) => {
        putEntry({
          deposit_id: ds.deposit_id || ds.id,
          apartment_code: ds.apartment_code,
          building_name: ds.building_name,
          amount_held: ds.amount_held,
          deposit_status: ds.deposit_status || ds.status,
          refund_due_date: ds.refund_due_date,
          settlement: ds.settlement,
        });
      });
    }

    return Array.from(map.values()).filter((item) => item.settlement);
  }, [overview?.deposit_settlements, contract, contractHistory, depositData?.deposit]);

  if (!contract && contractHistory.length === 0 && settlementDeposits.length === 0) {
    return (
      <Card>
        <EmptyState
          icon={FileText}
          title="Chưa có hợp đồng thuê"
          description="Bạn hiện chưa có hợp đồng thuê căn hộ nào. Hãy chọn căn hộ trống tại mục Tổng quan để gửi hồ sơ đăng ký thuê."
          action={
            <Button onClick={() => onNavigateTab?.('overview')}>
              Xem căn hộ trống
            </Button>
          }
        />
      </Card>
    );
  }

  const timelineSteps = contract
    ? [
        {
          label: 'Khởi tạo & Ký kết',
          date: formatDate(contract.contract_created_at || contract.start_date),
          done: true,
        },
        {
          label: 'Bàn giao & Hiệu lực',
          date: formatDate(contract.start_date),
          done: true,
        },
        {
          label:
            contract.contract_status === 'RENEWAL_PENDING'
              ? 'Chờ duyệt gia hạn'
              : contract.contract_status === 'TERMINATION_PENDING'
              ? 'Chờ duyệt chấm dứt'
              : 'Đang thực hiện',
          date: 'Hiện tại',
          active: true,
          done: true,
        },
        {
          label: 'Đáo hạn hợp đồng',
          date: formatDate(contract.end_date),
          done: false,
        },
      ]
    : [];

  const depositInfo = depositData?.deposit;
  const depositTransactions = Array.isArray(depositData?.transactions)
    ? depositData.transactions
    : [];

  return (
    <div className="space-y-6">
      {/* Current Active Contract Details */}
      {contract ? (
        <Card>
          <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 pb-5 border-b border-slate-100">
            <div className="space-y-1">
              <div className="flex items-center gap-2.5 flex-wrap">
                <h2 className="text-lg font-bold text-slate-900">
                  Hợp đồng thuê #{contract.contract_id?.slice(0, 8).toUpperCase()}
                </h2>
                <StatusBadge status={contract.contract_status} domain="contract" />
                {contract.parent_contract_id ? (
                  <Badge variant="indigo">
                    Nối tiếp HĐ #{contract.parent_contract_id.slice(0, 8).toUpperCase()}
                  </Badge>
                ) : null}
              </div>
              <p className="text-xs text-slate-500 flex items-center gap-1.5">
                <Building2 className="w-3.5 h-3.5 text-slate-400" />
                <span>
                  Căn {contract.apartment_code} — {contract.building_name}
                </span>
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="soft"
                size="sm"
                icon={Printer}
                onClick={() => handleOpenTemplate(contract.contract_id)}
              >
                Xem / Tải bản in A4
              </Button>
              {contract.contract_status === 'ACTIVE' ? (
                <>
                  <Button
                    variant="primary"
                    size="sm"
                    icon={RefreshCw}
                    onClick={() => openRequestModal('RENEWAL')}
                  >
                    Xin gia hạn HĐ
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    icon={LogOut}
                    onClick={() => openRequestModal('TERMINATION')}
                    className="text-rose-600 hover:text-rose-700 hover:bg-rose-50 border-rose-200"
                  >
                    Xin chấm dứt trước hạn
                  </Button>
                </>
              ) : null}
            </div>
          </div>

          {contract.contract_status === 'TERMINATION_PENDING' ? (
            <div className="mt-4 p-3.5 rounded-xl bg-amber-50 border border-amber-200 flex items-start gap-2.5 text-xs text-amber-900">
              <Clock className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
              <div>
                <p className="font-semibold">
                  Đã duyệt lịch chấm dứt hợp đồng — Ngày trả phòng dự kiến:{' '}
                  {formatDate(contract.terminated_at)}
                </p>
                <p className="text-amber-800 mt-0.5">
                  Vui lòng bàn giao căn hộ và chốt chỉ số điện/nước cùng Ban Quản Lý trước hoặc vào ngày hẹn để tiến hành tất toán tiền cọc.
                </p>
              </div>
            </div>
          ) : null}

          {/* Status Timeline */}
          <div className="py-5 border-b border-slate-100">
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-3.5">
              Tiến trình hợp đồng
            </p>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {timelineSteps.map((step, idx) => (
                <div
                  key={idx}
                  className={`p-3 rounded-xl border ${
                    step.active
                      ? 'bg-primary-50/70 border-primary-200'
                      : step.done
                      ? 'bg-emerald-50/40 border-emerald-200/70'
                      : 'bg-slate-50 border-slate-200/70'
                  }`}
                >
                  <div className="flex items-start gap-1.5">
                    {step.done ? (
                      <CheckCircle2
                        className={`w-4 h-4 shrink-0 mt-0.5 ${
                          step.active ? 'text-primary-600' : 'text-emerald-600'
                        }`}
                      />
                    ) : (
                      <Clock className="w-4 h-4 text-slate-400 shrink-0 mt-0.5" />
                    )}
                    <span className="text-xs font-semibold text-slate-800 leading-snug break-words">
                      {step.label}
                    </span>
                  </div>
                  <p className="text-[11px] text-slate-500 mt-1 pl-5.5">{step.date}</p>
                </div>
              ))}
            </div>
          </div>

          {/* Key Contract Terms */}
          <div className="grid grid-cols-2 sm:grid-cols-3 2xl:grid-cols-6 gap-4 pt-5">
            <div>
              <p className="text-xs text-slate-500">Ngày bắt đầu</p>
              <p className="text-sm font-semibold text-slate-900 mt-0.5">
                {formatDate(contract.start_date)}
              </p>
            </div>
            <div>
              <p className="text-xs text-slate-500">Ngày kết thúc</p>
              <p className="text-sm font-semibold text-slate-900 mt-0.5">
                {formatDate(contract.end_date)}
              </p>
            </div>
            <div>
              <p className="text-xs text-slate-500">Giá thuê / tháng</p>
              <p className="text-sm font-bold text-primary-600 mt-0.5 tabular-nums">
                {formatMoney(contract.rent_amount)}
              </p>
            </div>
            <div>
              <p className="text-xs text-slate-500">Tiền cọc hợp đồng</p>
              <p className="text-sm font-bold text-indigo-600 mt-0.5 tabular-nums">
                {formatMoney(contract.deposit_amount)}
              </p>
            </div>
            <div>
              <p className="text-xs text-slate-500">Ngày chốt hóa đơn</p>
              <p className="text-sm font-semibold text-slate-900 mt-0.5">
                Ngày {contract.billing_day || 1}{' '}
                {BILLING_CYCLE_LABELS[String(contract.billing_cycle || 'MONTHLY').toUpperCase()] || 'hàng tháng'}
              </p>
            </div>
            <div>
              <p className="text-xs text-slate-500">Hạn thanh toán</p>
              <p className="text-sm font-semibold text-slate-900 mt-0.5">
                {contract.payment_due_days || 5} ngày sau phát hành
              </p>
            </div>
          </div>

          {contract.contract_note ? (
            <div className="mt-4 p-3 rounded-xl bg-slate-50 border border-slate-200/60 text-xs text-slate-600 whitespace-pre-line break-words">
              <span className="font-semibold text-slate-700">Ghi chú hợp đồng: </span>
              {contract.contract_note}
            </div>
          ) : null}

          {/* Co-occupants if any */}
          {occupants.length > 0 ? (
            <div className="mt-5 pt-4 border-t border-slate-100">
              <p className="text-xs font-semibold text-slate-700 flex items-center gap-1.5 mb-2.5">
                <Users className="w-4 h-4 text-slate-400" />
                Thành viên đăng ký ở cùng ({occupants.length})
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5">
                {occupants.map((occ) => (
                  <div
                    key={occ.tenant_id}
                    className="p-3 rounded-lg bg-slate-50 border border-slate-200/70 flex items-start justify-between gap-2 text-xs"
                  >
                    <div className="min-w-0 space-y-0.5">
                      <p className="font-semibold text-slate-800 break-words">{occ.full_name}</p>
                      <p className="text-slate-600">{occ.phone || '—'}</p>
                      {occ.email ? (
                        <p className="text-slate-500 break-all">{occ.email}</p>
                      ) : null}
                      {occ.id_number ? (
                        <p className="text-[11px] text-slate-400">CCCD: {maskIdNumber(occ.id_number)}</p>
                      ) : null}
                    </div>
                    <div className="flex flex-col items-end gap-1 shrink-0">
                      <Badge variant="slate">{occ.relationship || 'Thành viên'}</Badge>
                      {occ.status ? <StatusBadge status={occ.status} domain="tenant" /> : null}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </Card>
      ) : null}

      {/* Submitted Contract Requests (Renewal / Termination) */}
      {contractRequests.length > 0 ? (
        <Card>
          <CardHeader
            title="Đề nghị Gia hạn / Chấm dứt đã gửi"
            subtitle="Theo dõi phản hồi từ Ban Quản Lý đối với các đề nghị hợp đồng của bạn"
          />
          <div className="space-y-2.5">
            {contractRequests.map((cr) => {
              const st = REQUEST_STATUS_MAP[cr.status] || { label: cr.status, variant: 'slate' };
              return (
                <div
                  key={cr.id}
                  className="p-3.5 rounded-xl border border-slate-200/80 flex flex-col sm:flex-row sm:items-start justify-between gap-3"
                >
                  <div className="space-y-1.5 min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <Badge variant={cr.type === 'RENEWAL' ? 'sky' : 'red'}>
                        {cr.type === 'RENEWAL' ? 'Xin gia hạn HĐ' : 'Xin chấm dứt HĐ trước hạn'}
                      </Badge>
                      <Badge variant={st.variant} dot>
                        {st.label}
                      </Badge>
                      {cr.apartment_code ? (
                        <span className="text-xs font-medium text-slate-700">
                          Căn {cr.apartment_code}
                          {cr.building_name ? ` — ${cr.building_name}` : ''}
                        </span>
                      ) : null}
                      <span className="text-xs text-slate-400">
                        Gửi lúc {formatDateTime(cr.created_at)}
                        {cr.updated_at && cr.updated_at !== cr.created_at
                          ? ` • Cập nhật ${formatDateTime(cr.updated_at)}`
                          : ''}
                      </span>
                    </div>
                    <p className="text-xs text-slate-600">
                      Ngày mong muốn:{' '}
                      <span className="font-semibold text-slate-800">
                        {formatDate(cr.desired_date)}
                      </span>
                    </p>
                    {cr.note ? (
                      <div
                        className={`text-xs rounded-lg px-3 py-2 whitespace-pre-line break-words ${
                          cr.status === 'REJECTED' || /\[Lý do từ chối\]/i.test(cr.note)
                            ? 'bg-rose-50/80 border border-rose-200 text-rose-800'
                            : 'bg-slate-50 border border-slate-200/70 text-slate-700'
                        }`}
                      >
                        {cr.note}
                      </div>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        </Card>
      ) : null}

      {/* Bảng kê tất toán tiền cọc (R-07, R-24) */}
      {settlementDeposits.length > 0 ? (
        <Card>
          <CardHeader
            title="Bảng kê tất toán tiền cọc"
            subtitle="Chi tiết đối trừ công nợ dịch vụ, khấu trừ bàn giao và số tiền hoàn trả dự kiến / thực tế"
          />
          <div className="space-y-4">
            {settlementDeposits.map((sd) => {
              const stObj = sd.settlement || {};
              const items = Array.isArray(stObj.items) ? stObj.items : [];
              const itemsTotal = items.reduce(
                (sum, it) => sum + Math.max(0, Number(it.amount || 0)),
                0
              );
              const serviceDebt = Math.max(0, Number(stObj.outstanding_debt || 0));
              const expectedRefund =
                stObj.refund_amount !== undefined && stObj.refund_amount !== null
                  ? Number(stObj.refund_amount)
                  : Math.max(0, Number(sd.amount_held || 0) - serviceDebt - itemsTotal);
              const thread = Array.isArray(stObj.dispute_thread)
                ? stObj.dispute_thread
                : Array.isArray(stObj.thread)
                ? stObj.thread
                : [];
              const disputeWindow = getResidentDisputeWindowState(sd);
              const canUpdateBank = canResidentUpdateRefundBankInfo(sd);

              return (
                <div
                  key={sd.deposit_id}
                  className="p-4 rounded-2xl border border-slate-200 bg-slate-50/40 space-y-4"
                >
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-slate-200/80">
                    <div>
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-bold text-slate-900">
                          Căn {sd.apartment_code || '—'}
                          {sd.building_name ? ` — ${sd.building_name}` : ''}
                        </span>
                        <StatusBadge status={sd.deposit_status} domain="deposit" />
                      </div>
                      {sd.refund_due_date ? (
                        <p className="text-xs text-slate-500 mt-0.5">
                          Hạn hoàn cọc theo quy định: <strong>{formatDate(sd.refund_due_date)}</strong>
                        </p>
                      ) : null}
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      <Button
                        variant="outline"
                        size="xs"
                        icon={Printer}
                        loading={printingSettlementId === sd.deposit_id}
                        onClick={() => handlePrintSettlementPdf(sd.deposit_id)}
                      >
                        Xem / In bảng kê
                      </Button>
                      {canUpdateBank ? (
                        <Button
                          variant={sd.deposit_status === 'RETURNED' ? 'primary' : 'outline'}
                          size="xs"
                          icon={Landmark}
                          onClick={() => handleOpenBankModal(sd)}
                        >
                          Cập nhật TK nhận hoàn cọc
                        </Button>
                      ) : null}
                      {disputeWindow.canDispute ? (
                        <Button
                          variant="danger"
                          size="xs"
                          icon={ShieldAlert}
                          onClick={() => handleOpenDisputeModal(sd)}
                        >
                          {disputeWindow.daysRemaining !== null
                            ? `Khiếu nại bảng kê (còn ${disputeWindow.daysRemaining} ngày)`
                            : 'Không đồng ý / Khiếu nại'}
                        </Button>
                      ) : disputeWindow.lockedReason === 'FINALIZED' ? (
                        <Badge variant="slate">Đã chốt giải quyết khiếu nại</Badge>
                      ) : disputeWindow.lockedReason === 'EXPIRED' ? (
                        <Badge variant="slate">Đã hết thời hạn khiếu nại 7 ngày</Badge>
                      ) : null}
                    </div>
                  </div>

                  {sd.deposit_status === 'APPROVED_PENDING_PAYOUT' ? (
                    <div className="p-3.5 rounded-xl bg-indigo-50 border border-indigo-200 text-xs text-indigo-900 space-y-1">
                      <p className="font-semibold">
                        Chủ nhà đã duyệt bảng kê — Ban quản lý đang thực hiện chuyển khoản hoàn cọc
                      </p>
                      <p className="text-indigo-800">
                        Vui lòng kiểm tra kỹ thông tin tài khoản thụ hưởng bên dưới. Khi chuyển khoản hoàn tất, chứng từ Ủy nhiệm chi (UNC) sẽ được cập nhật tại đây.
                      </p>
                    </div>
                  ) : null}

                  {sd.deposit_status === 'RETURNED' ? (
                    <div className="p-3.5 rounded-xl bg-amber-50 border border-amber-300 text-xs text-amber-900 space-y-1.5">
                      <p className="font-semibold">
                        Ngân hàng hoàn trả lệnh chuyển tiền — vui lòng cập nhật lại tài khoản thụ hưởng
                      </p>
                      {stObj.return_reason ? (
                        <p className="text-amber-800">
                          <strong>Lý do ngân hàng thông báo:</strong> {stObj.return_reason}
                        </p>
                      ) : null}
                    </div>
                  ) : null}

                  {/* Danh sách khoản khấu trừ biên bản bàn giao */}
                  {items.length === 0 ? (
                    <div className="p-3 rounded-xl bg-emerald-50/60 border border-emerald-200/80 text-xs text-emerald-800">
                      Không phát sinh khấu trừ hư hỏng hay vệ sinh mặt bằng khi bàn giao.
                    </div>
                  ) : (
                    <div className="space-y-2">
                      <p className="text-xs font-semibold text-slate-700">
                        Các khoản khấu trừ bàn giao ({items.length})
                      </p>
                      {items.map((it, idx) => (
                        <div
                          key={idx}
                          className="p-3 rounded-xl bg-white border border-slate-200/80 space-y-1.5 text-xs"
                        >
                          <div className="flex items-center justify-between gap-2">
                            <Badge variant="amber">
                              {DEDUCT_CATEGORY_LABELS[it.category] || it.category}
                            </Badge>
                            <span className="font-bold text-rose-600">
                              - {formatMoney(it.amount)}
                            </span>
                          </div>
                          {it.description ? (
                            <p className="text-slate-700">{it.description}</p>
                          ) : null}
                          {Array.isArray(it.evidence) && it.evidence.length > 0 ? (
                            <div className="flex flex-wrap gap-2 pt-1">
                              {it.evidence.map((ev, eIdx) => (
                                <div
                                  key={eIdx}
                                  onClick={() => setPreviewEvidenceSrc(ev)}
                                  className="w-14 h-14 rounded-lg border border-slate-200 overflow-hidden cursor-pointer hover:border-primary-400"
                                >
                                  <AuthImage
                                    src={ev}
                                    alt="Bằng chứng khấu trừ"
                                    className="w-full h-full object-cover"
                                  />
                                </div>
                              ))}
                            </div>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Tổng hợp công nợ đối trừ & số tiền hoàn */}
                  {(() => {
                    const isFinalized = ['REFUNDED', 'PARTIALLY_REFUNDED', 'DEDUCTED_FULL'].includes(
                      sd.deposit_status
                    );
                    const heldBefore = Number(
                      stObj.deposit_held_before_settlement ?? sd.amount_held ?? 0
                    );
                    const rentDebt = Math.max(0, Number(stObj.rent_debt || 0));
                    return (
                      <div className="p-3.5 rounded-xl bg-white border border-indigo-100 space-y-2 text-xs">
                        <div className="flex justify-between text-slate-600">
                          <span>Tiền đặt cọc bảo lưu trước tất toán:</span>
                          <strong className="text-slate-900">{formatMoney(heldBefore)}</strong>
                        </div>
                        <div className="flex justify-between text-slate-600">
                          <span>Đối trừ nợ dịch vụ / điện nước:</span>
                          <strong className="text-amber-700">- {formatMoney(serviceDebt)}</strong>
                        </div>
                        <div className="flex justify-between text-slate-600">
                          <span>Tổng khấu trừ hư hỏng / vệ sinh:</span>
                          <strong className="text-amber-700">- {formatMoney(itemsTotal)}</strong>
                        </div>
                        {rentDebt > 0 ? (
                          <div className="flex justify-between text-slate-500 italic">
                            <span>Công nợ tiền thuê (KHÔNG trừ vào cọc — thanh toán riêng):</span>
                            <strong className="text-rose-600">{formatMoney(rentDebt)}</strong>
                          </div>
                        ) : null}
                        <div className="border-t border-slate-100 pt-2 flex justify-between items-center text-sm">
                          <span className="font-bold text-slate-900">
                            {isFinalized ? 'Số tiền hoàn trả thực tế:' : 'Số tiền hoàn trả dự kiến:'}
                          </span>
                          <span className="text-base font-bold text-emerald-600">
                            {formatMoney(expectedRefund)}
                          </span>
                        </div>
                        {Number(stObj.shortfall || 0) > 0 ? (
                          <div className="flex justify-between text-rose-700 font-semibold pt-1">
                            <span>Khoản phải thu bổ sung sau trả phòng:</span>
                            <span>{formatMoney(stObj.shortfall)}</span>
                          </div>
                        ) : null}
                        {stObj.refund_method || stObj.bank_info || stObj.approved_at ? (
                          <div className="pt-2 border-t border-slate-100 space-y-1 text-slate-600">
                            {stObj.refund_method ? (
                              <p>
                                Hình thức hoàn cọc:{' '}
                                <strong className="text-slate-800">
                                  {PAYMENT_METHOD_LABELS[String(stObj.refund_method).toUpperCase()] || stObj.refund_method}
                                </strong>
                              </p>
                            ) : null}
                            {stObj.bank_info ? (
                              <p className="break-words">
                                Tài khoản nhận hoàn cọc:{' '}
                                <strong className="text-slate-800">
                                  {typeof stObj.bank_info === 'object'
                                      ? [
                                          stObj.bank_info.bank_name || stObj.bank_info.bank,
                                          stObj.bank_info.account_no || stObj.bank_info.account_number,
                                          stObj.bank_info.account_holder || stObj.bank_info.account_name || stObj.bank_info.holder_name,
                                        ]
                                          .filter(Boolean)
                                          .join(' • ')
                                      : stObj.bank_info}
                                  </strong>
                                </p>
                              ) : null}
                              {stObj.approved_at ? (
                                <p>
                                  Xác nhận quyết toán lúc:{' '}
                                  <strong className="text-slate-800">{formatDateTime(stObj.approved_at)}</strong>
                                </p>
                              ) : null}
                              {stObj.payout_reference_code ? (
                                <p>
                                  Mã tham chiếu chuyển khoản (UNC):{' '}
                                  <strong className="font-mono text-indigo-700">{stObj.payout_reference_code}</strong>
                                </p>
                              ) : null}
                              {Array.isArray(stObj.payout_evidence) && stObj.payout_evidence.length > 0 ? (
                                <div className="pt-1.5 space-y-1">
                                  <p className="font-medium text-slate-700">Chứng từ chuyển khoản hoàn cọc (UNC):</p>
                                  <div className="flex flex-wrap gap-2">
                                    {stObj.payout_evidence.map((ev, pIdx) => (
                                      <button
                                        key={pIdx}
                                        type="button"
                                        onClick={() => setPreviewEvidenceSrc(ev)}
                                        className="w-14 h-14 rounded-lg border border-indigo-200 overflow-hidden hover:border-primary-500"
                                      >
                                        <AuthImage src={ev} alt="Chứng từ hoàn cọc UNC" className="w-full h-full object-cover" />
                                      </button>
                                    ))}
                                  </div>
                                </div>
                              ) : null}
                            </div>
                          ) : null}
                        {stObj.rejection_reason ? (
                          <div className="p-2.5 rounded-lg bg-amber-50 border border-amber-200 text-amber-900 whitespace-pre-line break-words">
                            <span className="font-semibold">Ghi chú yêu cầu điều chỉnh lại bảng kê: </span>
                            {stObj.rejection_reason}
                          </div>
                        ) : null}
                      </div>
                    );
                  })()}

                  {/* Lịch sử trao đổi khiếu nại */}
                  {stObj.dispute_reason || thread.length > 0 ? (
                    <div className="p-3.5 rounded-xl bg-rose-50/70 border border-rose-200 space-y-2 text-xs">
                      <p className="font-semibold text-rose-800 flex items-center gap-1.5">
                        <ShieldAlert className="w-4 h-4" />
                        Lịch sử khiếu nại &amp; phản hồi giải quyết
                      </p>
                      {stObj.dispute_reason && thread.length === 0 ? (
                        <p className="text-rose-900">{stObj.dispute_reason}</p>
                      ) : null}
                      {thread.map((msg, mIdx) => (
                        <div
                          key={mIdx}
                          className="p-2.5 rounded-lg bg-white border border-rose-100 space-y-1"
                        >
                          <div className="flex items-center justify-between gap-2 text-[11px] text-slate-500">
                            <Badge variant={msg.role === 'RESIDENT' ? 'amber' : 'indigo'}>
                              {msg.role === 'RESIDENT' ? 'Bạn (Cư dân)' : 'Ban Quản Lý'}
                            </Badge>
                            <span>{formatDateTime(msg.at)}</span>
                          </div>
                          <p className="text-slate-800">{msg.message}</p>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </Card>
      ) : null}

      {/* Deposit Ledger & Transactions */}
      <Card>
        <CardHeader
          title="Sổ cọc & Lịch sử giao dịch cọc"
          subtitle="Minh bạch số dư tiền cọc đang bảo lưu và toàn bộ biến động thu/hoàn/khấu trừ"
          action={
            depositInfo?.status ? (
              <StatusBadge status={depositInfo.status} domain="deposit" />
            ) : null
          }
        />

        {loadingExtra ? (
          <div className="space-y-2.5">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-24 w-full" />
          </div>
        ) : (
          <div className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 p-4 rounded-xl bg-indigo-50/50 border border-indigo-100">
              <div>
                <p className="text-xs text-slate-500">Mức cọc quy định trên HĐ</p>
                <p className="text-base font-bold text-slate-900 mt-0.5">
                  {formatMoney(contract?.deposit_amount || depositData?.contract?.deposit_amount || 0)}
                </p>
              </div>
              <div>
                <p className="text-xs text-slate-500">Số dư cọc thực giữ hiện tại</p>
                <p className="text-base font-bold text-indigo-700 mt-0.5">
                  {formatMoney(depositInfo?.amount_held ?? contract?.deposit_held_amount ?? 0)}
                </p>
              </div>
              <div>
                <p className="text-xs text-slate-500">Số giao dịch đã duyệt</p>
                <p className="text-base font-bold text-slate-900 mt-0.5">
                  {depositTransactions.length} giao dịch
                </p>
              </div>
            </div>

            {depositTransactions.length === 0 ? (
              <p className="text-xs text-slate-500 text-center py-6">
                Chưa có lịch sử giao dịch sổ cọc nào được ghi nhận.
              </p>
            ) : (
              <div className="divide-y divide-slate-100 border border-slate-200/80 rounded-xl overflow-hidden">
                {depositTransactions.map((tx) => {
                  const meta = resolveResidentDepositTxMeta(tx);
                  const isPlus = meta.sign === '+';
                  return (
                    <div
                      key={tx.id}
                      className="p-3.5 bg-white hover:bg-slate-50/70 flex items-center justify-between gap-3"
                    >
                      <div className="flex items-start gap-3 min-w-0">
                        <div
                          className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 mt-0.5 ${
                            isPlus
                              ? 'bg-emerald-50 text-emerald-600'
                              : 'bg-amber-50 text-amber-600'
                          }`}
                        >
                          {isPlus ? (
                            <ArrowDownLeft className="w-4 h-4" />
                          ) : (
                            <ArrowUpRight className="w-4 h-4" />
                          )}
                        </div>
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-xs font-semibold text-slate-900 break-words">
                              {tx.description || tx.note || meta.label}
                            </span>
                            <Badge variant={meta.variant}>{meta.label}</Badge>
                            {tx.category ? (
                              <Badge variant="amber">
                                {DEDUCT_CATEGORY_LABELS[tx.category] || tx.category}
                              </Badge>
                            ) : null}
                            {tx.reference_code ? (
                              <Badge variant="indigo">Mã GD: {tx.reference_code}</Badge>
                            ) : null}
                          </div>
                          <p className="text-[11px] text-slate-500 mt-0.5">
                            {formatDateTime(tx.created_at)}
                            {tx.method
                              ? ` • Phương thức: ${PAYMENT_METHOD_LABELS[String(tx.method).toUpperCase()] || tx.method}`
                              : ''}
                          </p>
                          {Array.isArray(tx.evidence) && tx.evidence.length > 0 ? (
                            <div className="flex flex-wrap gap-1.5 pt-1.5">
                              {tx.evidence.map((ev, eIdx) => (
                                <button
                                  key={eIdx}
                                  type="button"
                                  onClick={() => setPreviewEvidenceSrc(ev)}
                                  className="w-11 h-11 rounded-lg border border-slate-200 overflow-hidden hover:border-primary-400"
                                >
                                  <AuthImage
                                    src={ev}
                                    alt="Chứng từ giao dịch cọc"
                                    className="w-full h-full object-cover"
                                  />
                                </button>
                              ))}
                            </div>
                          ) : null}
                        </div>
                      </div>
                      <span
                        className={`text-sm font-bold shrink-0 ${
                          isPlus ? 'text-emerald-600' : 'text-rose-600'
                        }`}
                      >
                        {meta.sign}
                        {formatMoney(tx.amount)}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </Card>

      {/* Amendments & Contract History Chain */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Amendments */}
        <Card>
          <CardHeader
            title="Phụ lục điều chỉnh hợp đồng"
            subtitle="Các phụ lục thay đổi điều khoản đã được phê duyệt"
          />
          {amendments.length === 0 ? (
            <EmptyState
              icon={FileDiff}
              title="Chưa có phụ lục điều chỉnh"
              description="Hợp đồng hiện giữ nguyên các điều khoản gốc từ khi ký kết."
            />
          ) : (
            <div className="space-y-3">
              {amendments.map((am) => {
                const diffObj =
                  typeof am.diff === 'object' && am.diff !== null ? am.diff : {};
                return (
                  <div
                    key={am.id}
                    className="p-3.5 rounded-xl border border-slate-200/80 bg-slate-50/50 space-y-2"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2 flex-wrap">
                        <Badge variant="indigo">
                          {diffObj.status === 'INITIAL_SNAPSHOT'
                            ? `Phiên bản gốc #${am.version_no}`
                            : `Phụ lục lần #${am.version_no}`}
                        </Badge>
                        {diffObj.status ? (
                          <Badge
                            variant={
                              diffObj.status === 'APPROVED' || diffObj.status === 'INITIAL_SNAPSHOT'
                                ? 'emerald'
                                : diffObj.status === 'REJECTED'
                                ? 'red'
                                : 'amber'
                            }
                            dot
                          >
                            {diffObj.status === 'INITIAL_SNAPSHOT'
                              ? 'Hiệu lực gốc'
                              : diffObj.status === 'APPROVED'
                              ? 'Đã phê duyệt'
                              : diffObj.status === 'REJECTED'
                              ? 'Từ chối'
                              : 'Chờ duyệt'}
                          </Badge>
                        ) : null}
                      </div>
                      <span className="text-xs text-slate-500">
                        Hiệu lực: <strong className="text-slate-700">{formatDate(am.effective_from)}</strong>
                        {am.created_at ? ` • Lập ${formatDate(am.created_at)}` : ''}
                      </span>
                    </div>
                    {am.reason ? (
                      <p className="text-xs text-slate-700 font-medium break-words">{am.reason}</p>
                    ) : null}
                    {diffObj.rejection_reason ? (
                      <p className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded-lg px-2.5 py-1.5 whitespace-pre-line break-words">
                        Lý do từ chối: {diffObj.rejection_reason}
                      </p>
                    ) : null}
                    {(() => {
                      const diffEntries = Object.entries(diffObj).filter(
                        ([k]) => !AMENDMENT_META_KEYS.includes(k)
                      );
                      if (diffEntries.length === 0) return null;
                      return (
                        <div className="space-y-1 pt-1 border-t border-slate-200/60 text-xs text-slate-600">
                          {diffEntries.map(([k, v]) => {
                            const isObj = v && typeof v === 'object' && !Array.isArray(v);
                            const fromVal = isObj
                              ? 'old' in v
                                ? v.old
                                : 'from' in v
                                ? v.from
                                : null
                              : null;
                            const toVal = isObj
                              ? 'new' in v
                                ? v.new
                                : 'to' in v
                                ? v.to
                                : null
                              : v;
                            return (
                              <div key={k} className="flex items-center justify-between gap-2">
                                <span className="text-slate-500">
                                  {DIFF_FIELD_LABELS[k] || k}:
                                </span>
                                <span className="font-semibold text-slate-800">
                                  {fromVal !== null && fromVal !== undefined
                                    ? `${formatDiffValue(k, fromVal)} → `
                                    : ''}
                                  {formatDiffValue(k, toVal)}
                                </span>
                              </div>
                            );
                          })}
                        </div>
                      );
                    })()}
                  </div>
                );
              })}
            </div>
          )}
        </Card>

        {/* Contract Renewal / History Chain */}
        <Card>
          <CardHeader
            title="Chuỗi lịch sử hợp đồng"
            subtitle="Toàn bộ các kỳ hợp đồng gốc và gia hạn nối tiếp"
          />
          {contractHistory.length === 0 ? (
            <EmptyState
              icon={History}
              title="Chưa có lịch sử hợp đồng"
              description="Các hợp đồng đã ký sẽ hiển thị tại đây."
            />
          ) : (
            <div className="space-y-3">
              {contractHistory.map((ch) => (
                <div
                  key={ch.id}
                  className={`p-3.5 rounded-xl border transition-colors ${
                    ch.id === contract?.contract_id
                      ? 'border-primary-300 bg-primary-50/30'
                      : 'border-slate-200/80 bg-white'
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-xs font-bold text-slate-900">
                          HĐ #{ch.id.slice(0, 8).toUpperCase()} — Căn {ch.apartment_code}
                        </span>
                        <StatusBadge status={ch.status} domain="contract" />
                      </div>
                      <p className="text-xs text-slate-500 mt-0.5">{ch.building_name}</p>
                    </div>
                    <Button
                      variant="ghost"
                      size="xs"
                      icon={Printer}
                      onClick={() => handleOpenTemplate(ch.id)}
                    >
                      Bản in
                    </Button>
                  </div>

                  <div className="mt-2.5 pt-2.5 border-t border-slate-100 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-600">
                    <span className="inline-flex items-center gap-1 flex-wrap">
                      <Calendar className="w-3.5 h-3.5 text-slate-400" />
                      {formatDate(ch.start_date)} → {formatDate(ch.end_date)}
                      {ch.terminated_at ? ` (Thanh lý: ${formatDate(ch.terminated_at)})` : ''}
                    </span>
                    <span className="font-semibold text-slate-800">
                      {formatMoney(ch.rent_amount)}/tháng
                    </span>
                  </div>

                  {ch.deposit_amount !== undefined || ch.deposit_status ? (
                    <div className="mt-1.5 flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-500">
                      <span>
                        Tiền cọc: <strong className="text-slate-700">{formatMoney(ch.deposit_amount || 0)}</strong>
                      </span>
                      {ch.deposit_status ? (
                        <StatusBadge status={ch.deposit_status} domain="deposit" />
                      ) : null}
                    </div>
                  ) : null}

                  {ch.parent_contract_id ? (
                    <p className="text-[11px] text-indigo-600 font-medium mt-1.5">
                      ↳ Gia hạn / Chuyển tiếp từ HĐ #{ch.parent_contract_id.slice(0, 8).toUpperCase()}
                    </p>
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      {/* Modal Xem / In Hợp đồng A4 */}
      <Modal
        open={templateOpen}
        onClose={() => setTemplateOpen(false)}
        title="Bản in Hợp đồng thuê căn hộ chuẩn A4"
        subtitle="Xem trước, tải về hoặc in / xuất PDF trực tiếp"
        size="xl"
        footer={
          <>
            <Button variant="outline" onClick={() => setTemplateOpen(false)}>
              Đóng
            </Button>
            <Button
              variant="soft"
              icon={Download}
              onClick={handleDownloadHtml}
              disabled={!templateHtml}
            >
              Tải bản HTML
            </Button>
            <Button
              variant="primary"
              icon={Printer}
              onClick={handlePrintA4}
              disabled={!templateHtml}
            >
              In / Lưu PDF (A4)
            </Button>
          </>
        }
      >
        {templateLoading ? (
          <div className="space-y-3 py-8">
            <Skeleton className="h-8 w-2/3 mx-auto" />
            <Skeleton className="h-96 w-full" />
          </div>
        ) : (
          <div className="border border-slate-200 rounded-xl overflow-hidden bg-slate-100">
            <iframe
              ref={iframeRef}
              title="Contract A4 Template"
              srcDoc={templateHtml}
              className="w-full h-[65vh] bg-white"
            />
          </div>
        )}
      </Modal>

      {/* Modal Gửi đề nghị Gia hạn / Chấm dứt HĐ */}
      <Modal
        open={reqModalOpen}
        onClose={() => setReqModalOpen(false)}
        title={
          reqForm.type === 'RENEWAL'
            ? 'Gửi yêu cầu Xin gia hạn Hợp đồng'
            : 'Gửi yêu cầu Xin chấm dứt Hợp đồng trước hạn'
        }
        subtitle={`Căn hộ ${contract?.apartment_code || ''} — Ngày hết hạn hiện tại: ${formatDate(
          contract?.end_date
        )}`}
        size="md"
        footer={
          <>
            <Button variant="outline" onClick={() => setReqModalOpen(false)} disabled={reqSubmitting}>
              Hủy
            </Button>
            <Button
              variant={reqForm.type === 'TERMINATION' ? 'danger' : 'primary'}
              onClick={handleSubmitContractRequest}
              loading={reqSubmitting}
              disabled={Boolean(reqDesiredDateError)}
            >
              Gửi đề nghị tới BQL
            </Button>
          </>
        }
      >
        <form onSubmit={handleSubmitContractRequest} className="space-y-4">
          <Select
            label="Loại đề nghị"
            value={reqForm.type}
            onChange={(e) => {
              const nextType = e.target.value;
              setReqForm((s) => ({
                ...s,
                type: nextType,
                desired_date: getDefaultDesiredDateForType(nextType),
              }));
            }}
            options={[
              { value: 'RENEWAL', label: 'Xin gia hạn tiếp hợp đồng thuê' },
              { value: 'TERMINATION', label: 'Xin chấm dứt hợp đồng trước hạn' },
            ]}
          />

          {reqForm.type === 'TERMINATION' ? (
            <div className="p-3.5 rounded-xl bg-amber-50 border border-amber-200 flex items-start gap-2.5 text-xs text-amber-800">
              <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
              <p className="leading-relaxed">
                <strong>Lưu ý quy định báo trước (AC-006.1):</strong> Đề nghị chấm dứt hợp đồng trước hạn cần gửi trước tối thiểu <strong>30 ngày</strong> để Ban Quản Lý sắp xếp lịch kiểm tra nghiệm thu phòng và tất toán tiền cọc.
              </p>
            </div>
          ) : (
            <div className="p-3.5 rounded-xl bg-sky-50 border border-sky-200 flex items-start gap-2.5 text-xs text-sky-800">
              <ShieldCheck className="w-4 h-4 text-sky-600 shrink-0 mt-0.5" />
              <p className="leading-relaxed">
                Ban Quản Lý sẽ tiếp nhận yêu cầu gia hạn, trao đổi điều khoản kỳ mới và khởi tạo hợp đồng gia hạn nối tiếp cho bạn.
              </p>
            </div>
          )}

          <Input
            type="date"
            required={reqForm.type === 'TERMINATION'}
            label={
              reqForm.type === 'RENEWAL'
                ? 'Ngày kết thúc mới mong muốn'
                : 'Ngày dự kiến bàn giao trả phòng'
            }
            min={
              reqForm.type === 'RENEWAL'
                ? minRenewalDesiredDate || undefined
                : minTerminationDesiredDate || undefined
            }
            max={
              reqForm.type === 'TERMINATION'
                ? maxTerminationDesiredDate || undefined
                : undefined
            }
            error={reqDesiredDateError}
            value={reqForm.desired_date}
            onChange={(e) => setReqForm((s) => ({ ...s, desired_date: e.target.value }))}
          />

          <Input
            multiline
            rows={3}
            label="Lý do / Ghi chú gửi Ban Quản Lý"
            placeholder={
              reqForm.type === 'RENEWAL'
                ? 'Ví dụ: Tôi muốn gia hạn thêm 12 tháng, giữ nguyên các dịch vụ đang đăng ký...'
                : 'Ví dụ: Chuyển công tác sang khu vực khác, mong BQL hỗ trợ kiểm tra bàn giao...'
            }
            value={reqForm.note}
            onChange={(e) => setReqForm((s) => ({ ...s, note: e.target.value }))}
          />
        </form>
      </Modal>

      {/* Modal Khiếu nại bảng kê tất toán tiền cọc (R-07) */}
      <Modal
        open={disputeModalOpen}
        onClose={() => setDisputeModalOpen(false)}
        title="Không đồng ý / Khiếu nại bảng kê tất toán cọc"
        subtitle={
          disputeDepositTarget
            ? `Căn hộ ${disputeDepositTarget.apartment_code || ''}${
                disputeDepositTarget.building_name ? ` — ${disputeDepositTarget.building_name}` : ''
              }`
            : ''
        }
        size="md"
        footer={
          <>
            <Button
              variant="outline"
              onClick={() => setDisputeModalOpen(false)}
              disabled={submittingDispute}
            >
              Hủy
            </Button>
            <Button
              variant="danger"
              icon={ShieldAlert}
              loading={submittingDispute}
              onClick={handleSubmitDispute}
            >
              Gửi khiếu nại tới BQL
            </Button>
          </>
        }
      >
        <form onSubmit={handleSubmitDispute} className="space-y-3">
          <div className="p-3 rounded-xl bg-amber-50 border border-amber-200 text-xs text-amber-800 leading-relaxed">
            Vui lòng nêu rõ khoản mục khấu trừ hoặc công nợ bạn chưa đồng ý. Hồ sơ cọc sẽ chuyển sang trạng thái <strong>Tranh chấp (DISPUTED)</strong> để Ban Quản Lý rà soát và phản hồi trực tiếp trên bảng kê.
          </div>
          <Input
            label="Lý do khiếu nại / Không đồng ý"
            required
            multiline
            rows={4}
            placeholder="Ví dụ: Tôi không đồng ý khoản khấu trừ vệ sinh 500.000 ₫ vì đã dọn dẹp sạch sẽ trước khi bàn giao..."
            value={disputeReason}
            onChange={(e) => setDisputeReason(e.target.value)}
          />
        </form>
      </Modal>

      {/* Modal Cập nhật TK nhận hoàn cọc (Phase 2 — APPROVED_PENDING_PAYOUT / RETURNED) */}
      <Modal
        open={bankModalOpen}
        onClose={() => {
          if (!submittingBankInfo) setBankModalOpen(false);
        }}
        title="Cập nhật tài khoản nhận hoàn cọc"
        subtitle={
          bankDepositTarget
            ? `Căn hộ ${bankDepositTarget.apartment_code || ''}${
                bankDepositTarget.building_name ? ` — ${bankDepositTarget.building_name}` : ''
              }`
            : ''
        }
        size="md"
        footer={
          <>
            <Button
              variant="outline"
              onClick={() => setBankModalOpen(false)}
              disabled={submittingBankInfo}
            >
              Hủy
            </Button>
            <Button
              variant="primary"
              icon={Landmark}
              loading={submittingBankInfo}
              onClick={handleSubmitBankInfo}
            >
              Lưu tài khoản nhận cọc
            </Button>
          </>
        }
      >
        <form onSubmit={handleSubmitBankInfo} className="space-y-3.5">
          <BankSelect
            label="Ngân hàng thụ hưởng (VietQR)"
            required
            placeholder="-- Chọn ngân hàng thụ hưởng --"
            value={bankForm.bank_name}
            bankMeta={{
              bank_code: bankForm.bank_code,
              bank_bin: bankForm.bank_bin,
              bank_logo: bankForm.bank_logo,
            }}
            onBankChange={(val, chosen) =>
              setBankForm((p) => ({
                ...p,
                bank_name: val,
                bank_code: chosen?.code || '',
                bank_bin: chosen?.bin || '',
                bank_logo: chosen?.logo || '',
              }))
            }
          />
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Input
              label="Số tài khoản"
              required
              placeholder="Số TK nhận hoàn cọc"
              value={bankForm.account_number}
              onChange={(e) => setBankForm((p) => ({ ...p, account_number: e.target.value }))}
            />
            <Input
              label="Chủ tài khoản"
              required
              placeholder="Họ tên in hoa"
              value={bankForm.account_holder}
              onChange={(e) => setBankForm((p) => ({ ...p, account_holder: e.target.value }))}
            />
          </div>
        </form>
      </Modal>

      {/* Modal Phóng to ảnh bằng chứng khấu trừ */}
      <Modal
        open={Boolean(previewEvidenceSrc)}
        onClose={() => setPreviewEvidenceSrc(null)}
        title="Ảnh bằng chứng khấu trừ"
        size="lg"
        footer={
          <Button variant="outline" onClick={() => setPreviewEvidenceSrc(null)}>
            Đóng
          </Button>
        }
      >
        <div className="flex items-center justify-center bg-slate-900/5 rounded-xl p-2 min-h-[280px]">
          {previewEvidenceSrc ? (
            <AuthImage
              src={previewEvidenceSrc}
              alt="Bằng chứng khấu trừ"
              className="max-h-[70vh] w-auto rounded-lg object-contain"
            />
          ) : null}
        </div>
      </Modal>
    </div>
  );
}

export default ContractTab;
