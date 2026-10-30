import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import {
  Wallet,
  Clock,
  CheckCircle2,
  AlertTriangle,
  ShieldAlert,
  ShieldCheck,
  History,
  Plus,
  Trash2,
  RefreshCw,
  Receipt,
  Banknote,
  Building2,
  ExternalLink,
  XCircle,
  FileCheck2,
  Printer,
  MessageSquareWarning,
} from 'lucide-react';
import { Button } from '../../../components/ui/Button';
import { Input } from '../../../components/ui/Input';
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
import { ConfirmDialog } from '../../../components/common/ConfirmDialog';
import { EmptyState } from '../../../components/common/EmptyState';
import { LoadingSpinner } from '../../../components/common/LoadingSpinner';
import { depositsService } from '../../../services/deposits.service';
import { usersService } from '../../../services/users.service';
import { usePermission } from '../../../hooks/usePermission';
import { useToast } from '../../../hooks/useToast';
import { useAuthStore } from '../../../stores/authStore';
import { formatMoney, formatDate, formatDateTime } from '../../../utils/format';
import { extractErrorMessage } from '../../../utils/validation';

// Khớp 100% với DEDUCT_CATEGORIES trong api/src/services/depositSettlement.js
const DEDUCT_CATEGORY_OPTIONS = [
  { value: 'DAMAGE', label: 'Hư hỏng tài sản / nội thất (DAMAGE)' },
  { value: 'CLEANING', label: 'Vệ sinh hoàn trả mặt bằng (CLEANING)' },
  { value: 'UTILITY_DEBT', label: 'Điện / nước / tiện ích tồn đọng (UTILITY_DEBT)' },
  { value: 'OTHER', label: 'Khấu trừ hợp lệ khác (OTHER)' },
];

const CATEGORY_LABEL_MAP = {
  DAMAGE: 'Hư hỏng tài sản',
  CLEANING: 'Vệ sinh mặt bằng',
  UTILITY_DEBT: 'Tiện ích phát sinh',
  OTHER: 'Khoản mục khác',
};

const TXN_TYPE_META = {
  collect: { label: 'Thu tiền cọc', variant: 'emerald', sign: '+' },
  transfer: { label: 'Kết chuyển cọc', variant: 'sky', sign: '+' },
  deduct: { label: 'Khấu trừ cọc', variant: 'amber', sign: '-' },
  refund: { label: 'Hoàn trả cọc', variant: 'indigo', sign: '-' },
};

const PAYMENT_METHOD_OPTIONS = [
  { value: 'BANK_TRANSFER', label: 'Chuyển khoản ngân hàng (BANK_TRANSFER)' },
  { value: 'CASH', label: 'Tiền mặt (CASH)' },
];

function createEmptyDeductionItem() {
  return {
    category: 'DAMAGE',
    amount: '',
    description: '',
    evidence: [],
  };
}

export function DepositsPage() {
  const navigate = useNavigate();
  const toast = useToast();
  const { isSysAdmin, isManager, canSettleDeposits, canApproveDepositRefund, user } = usePermission();
  const currentUserId = user?.id || user?.sub;
  const selectedBuildingId = useAuthStore((s) => s.selectedBuildingId);

  const [deposits, setDeposits] = useState([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState('held');
  const [search, setSearch] = useState('');

  // Image Preview state
  const [previewImg, setPreviewImg] = useState(null);

  // Transactions & Collect Deposit Modal state
  const [txnModalOpen, setTxnModalOpen] = useState(false);
  const [selectedDepositForTxn, setSelectedDepositForTxn] = useState(null);
  const [transactions, setTransactions] = useState([]);
  const [loadingTxns, setLoadingTxns] = useState(false);
  const [showCollectForm, setShowCollectForm] = useState(false);
  const [collectForm, setCollectForm] = useState({
    amount: '',
    method: 'BANK_TRANSFER',
    description: 'Thu bổ sung tiền đặt cọc hợp đồng',
    evidence: [],
  });
  const [submittingCollect, setSubmittingCollect] = useState(false);

  // Settlement & Four-Eyes Refund Modal state
  const [settlementOpen, setSettlementOpen] = useState(false);
  const [settlementDeposit, setSettlementDeposit] = useState(null);
  const [settlementDetail, setSettlementDetail] = useState(null);
  const [loadingSettlement, setLoadingSettlement] = useState(false);

  // Manager Settlement Form state
  const [outstandingDebt, setOutstandingDebt] = useState('0');
  const [deductionItems, setDeductionItems] = useState([]);
  const [refundMethod, setRefundMethod] = useState('BANK_TRANSFER');
  const [bankInfo, setBankInfo] = useState({
    bank_name: '',
    account_number: '',
    account_holder: '',
  });
  const [submittingSettlement, setSubmittingSettlement] = useState(false);

  // Owner Approve / Reject & Manager Dispute states
  const [approveConfirmOpen, setApproveConfirmOpen] = useState(false);
  const [approvingSettlement, setApprovingSettlement] = useState(false);

  const [rejectModalOpen, setRejectModalOpen] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  const [rejectingSettlement, setRejectingSettlement] = useState(false);

  const [disputeModalOpen, setDisputeModalOpen] = useState(false);
  const [disputeTarget, setDisputeTarget] = useState(null);
  const [disputeReason, setDisputeReason] = useState('');
  const [submittingDispute, setSubmittingDispute] = useState(false);

  // Resolve Dispute Modal state (R-07) + Four-eyes config (R-23) + Print A4 state (R-24)
  const [allowSelfApproval, setAllowSelfApproval] = useState(false);
  const [printingDepositId, setPrintingDepositId] = useState(null);
  const [resolveModalOpen, setResolveModalOpen] = useState(false);
  const [resolveTarget, setResolveTarget] = useState(null);
  const [resolveSettlementData, setResolveSettlementData] = useState(null);
  const [loadingResolveDetail, setLoadingResolveDetail] = useState(false);
  const [resolveReason, setResolveReason] = useState('');
  const [resolvingAction, setResolvingAction] = useState('');

  const fetchDeposits = useCallback(async () => {
    setLoading(true);
    try {
      const [res, settingsRes] = await Promise.all([
        depositsService.list(),
        usersService.getSettings().catch(() => null),
      ]);
      setDeposits(Array.isArray(res?.data) ? res.data : []);
      if (settingsRes?.data) {
        setAllowSelfApproval(Boolean(settingsRes.data?.approval_config?.allow_self_approval));
      }
    } catch (err) {
      toast.error(extractErrorMessage(err, 'Không thể tải danh sách sổ cọc.'));
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    fetchDeposits();
  }, [fetchDeposits]);

  const scopedDeposits = useMemo(() => {
    if (!selectedBuildingId) return deposits;
    return deposits.filter((d) => String(d.building_id) === String(selectedBuildingId));
  }, [deposits, selectedBuildingId]);

  const tabCounts = useMemo(() => {
    const held = scopedDeposits.filter((d) => ['HELD', 'SETTLEMENT_DRAFT'].includes(d.status)).length;
    const pending = scopedDeposits.filter((d) => d.status === 'PENDING_APPROVAL').length;
    const refunded = scopedDeposits.filter((d) =>
      ['REFUNDED', 'PARTIALLY_REFUNDED', 'TRANSFERRED'].includes(d.status)
    ).length;
    const disputed = scopedDeposits.filter((d) => d.status === 'DISPUTED').length;
    const totalHeldAmount = scopedDeposits
      .filter((d) => ['HELD', 'SETTLEMENT_DRAFT', 'PENDING_APPROVAL', 'DISPUTED'].includes(d.status))
      .reduce((sum, d) => sum + Number(d.amount_held || 0), 0);

    return { held, pending, refunded, disputed, totalHeldAmount };
  }, [scopedDeposits]);

  const filteredDeposits = useMemo(() => {
    const q = search.trim().toLowerCase();
    return scopedDeposits.filter((d) => {
      if (activeTab === 'held' && !['HELD', 'SETTLEMENT_DRAFT'].includes(d.status)) return false;
      if (activeTab === 'pending' && d.status !== 'PENDING_APPROVAL') return false;
      if (
        activeTab === 'refunded' &&
        !['REFUNDED', 'PARTIALLY_REFUNDED', 'TRANSFERRED'].includes(d.status)
      ) {
        return false;
      }
      if (activeTab === 'disputed' && d.status !== 'DISPUTED') return false;

      if (q) {
        const haystacks = [
          d.apartment_code,
          d.building_name,
          d.building_code,
          d.tenant_name,
          d.contract_id,
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        if (!haystacks.includes(q)) return false;
      }
      return true;
    });
  }, [scopedDeposits, activeTab, search]);

  // Mở Modal Lịch sử giao dịch & Thu bổ sung cọc
  const handleOpenTransactions = useCallback(async (dep, defaultOpenCollect = false) => {
    setSelectedDepositForTxn(dep);
    setShowCollectForm(defaultOpenCollect);
    setCollectForm({
      amount: '',
      method: 'BANK_TRANSFER',
      description: 'Thu bổ sung tiền đặt cọc hợp đồng',
      evidence: [],
    });
    setTxnModalOpen(true);
    setLoadingTxns(true);
    try {
      const res = await depositsService.listTransactions(dep.id);
      setTransactions(Array.isArray(res?.data) ? res.data : []);
    } catch (err) {
      toast.error(extractErrorMessage(err, 'Không thể tải lịch sử giao dịch sổ cọc.'));
    } finally {
      setLoadingTxns(false);
    }
  }, [toast]);

  const handleSubmitCollect = async (e) => {
    e?.preventDefault();
    if (!selectedDepositForTxn) return;
    const amt = Math.round(Number(collectForm.amount || 0));
    if (!amt || amt <= 0) {
      toast.warning('Số tiền thu bổ sung cọc phải lớn hơn 0.');
      return;
    }
    if (!collectForm.method) {
      toast.warning('Vui lòng chọn phương thức thanh toán.');
      return;
    }

    setSubmittingCollect(true);
    try {
      const res = await depositsService.createTransaction(selectedDepositForTxn.id, {
        type: 'collect',
        amount: amt,
        method: collectForm.method,
        description: collectForm.description.trim() || 'Thu bổ sung cọc',
        evidence: Array.isArray(collectForm.evidence) ? collectForm.evidence : [],
      });
      toast.success(res?.message || 'Đã ghi nhận giao dịch thu bổ sung cọc.');
      setShowCollectForm(false);
      setCollectForm({
        amount: '',
        method: 'BANK_TRANSFER',
        description: 'Thu bổ sung tiền đặt cọc hợp đồng',
        evidence: [],
      });

      const [tRes] = await Promise.all([
        depositsService.listTransactions(selectedDepositForTxn.id),
        fetchDeposits(),
      ]);
      setTransactions(Array.isArray(tRes?.data) ? tRes.data : []);
      setSelectedDepositForTxn((prev) =>
        prev ? { ...prev, amount_held: Number(prev.amount_held || 0) + amt } : prev
      );
    } catch (err) {
      toast.error(extractErrorMessage(err, 'Không thể ghi nhận thu bổ sung cọc.'));
    } finally {
      setSubmittingCollect(false);
    }
  };

  // Mở Modal Tất toán & Hoàn cọc Four-Eyes
  const handleOpenSettlement = useCallback(async (dep) => {
    setSettlementDeposit(dep);
    setSettlementOpen(true);
    setLoadingSettlement(true);

    try {
      const res = await depositsService.getSettlement(dep.id);
      const data = res?.data || {};
      setSettlementDetail(data);

      const existing = data.settlement || dep.settlement || null;
      const calcServiceDebt = Math.max(
        0,
        Math.round(
          Number(data.calculated_service_debt ?? existing?.outstanding_debt ?? 0)
        )
      );
      setOutstandingDebt(String(calcServiceDebt));
      if (existing) {
        setDeductionItems(
          Array.isArray(existing.items)
            ? existing.items.map((it) => ({
                category: it.category || 'DAMAGE',
                amount: String(Math.round(Number(it.amount || 0))),
                description: it.description || '',
                evidence: Array.isArray(it.evidence) ? it.evidence : [],
              }))
            : []
        );
        setRefundMethod(existing.refund_method || 'BANK_TRANSFER');
        setBankInfo({
          bank_name: existing.bank_info?.bank_name || '',
          account_number: existing.bank_info?.account_number || '',
          account_holder: existing.bank_info?.account_holder || dep.tenant_name || '',
        });
      } else {
        setDeductionItems([]);
        setRefundMethod('BANK_TRANSFER');
        setBankInfo({
          bank_name: '',
          account_number: '',
          account_holder: dep.tenant_name || '',
        });
      }
    } catch (err) {
      toast.error(extractErrorMessage(err, 'Không thể tải thông tin hồ sơ tất toán.'));
    } finally {
      setLoadingSettlement(false);
    }
  }, [toast]);

  // Tính toán tự động số tiền hoàn & công nợ từ DB (R-06: Cọc chỉ trừ nợ dịch vụ, KHÔNG trừ nợ tiền thuê)
  const liveCalc = useMemo(() => {
    const held = Math.round(
      Number(settlementDetail?.amount_held ?? settlementDeposit?.amount_held ?? 0)
    );
    const serviceDebt = Math.max(
      0,
      Math.round(
        Number(
          settlementDetail?.calculated_service_debt ??
            outstandingDebt ??
            0
        )
      )
    );
    const rentDebt = Math.max(
      0,
      Math.round(
        Number(
          settlementDetail?.calculated_rent_debt ??
            settlementDetail?.settlement?.rent_debt ??
            0
        )
      )
    );
    const itemsTotal = deductionItems.reduce(
      (sum, it) => sum + Math.max(0, Math.round(Number(it.amount || 0))),
      0
    );
    const totalDeductions = serviceDebt + itemsTotal;
    const refundAmount = Math.max(0, held - serviceDebt - itemsTotal);
    const shortfall = Math.max(0, totalDeductions - held);

    return {
      held,
      debt: serviceDebt,
      serviceDebt,
      rentDebt,
      itemsTotal,
      totalDeductions,
      refundAmount,
      shortfall,
    };
  }, [settlementDetail, settlementDeposit, outstandingDebt, deductionItems]);

  const handleAddDeductionRow = () => {
    setDeductionItems((prev) => [...prev, createEmptyDeductionItem()]);
  };

  const handleUpdateDeductionRow = (idx, patch) => {
    setDeductionItems((prev) => prev.map((it, i) => (i === idx ? { ...it, ...patch } : it)));
  };

  const handleRemoveDeductionRow = (idx) => {
    setDeductionItems((prev) => prev.filter((_, i) => i !== idx));
  };

  // MANAGER gửi hồ sơ tất toán (POST /api/v1/deposits/:id/settlement)
  const handleSubmitSettlement = async (e) => {
    e?.preventDefault();
    if (!settlementDeposit) return;

    for (let i = 0; i < deductionItems.length; i += 1) {
      const it = deductionItems[i];
      const numAmt = Math.round(Number(it.amount || 0));
      if (!numAmt || numAmt <= 0) {
        toast.warning(`Khoản khấu trừ #${i + 1}: Số tiền phải lớn hơn 0.`);
        return;
      }
      if (!String(it.description || '').trim()) {
        toast.warning(`Khoản khấu trừ #${i + 1}: Vui lòng nhập mô tả chi tiết lý do khấu trừ.`);
        return;
      }
      if (!Array.isArray(it.evidence) || it.evidence.length === 0) {
        toast.warning(
          `Khoản khấu trừ #${i + 1}: Bắt buộc đính kèm ít nhất 01 ảnh bằng chứng (FR-023).`
        );
        return;
      }
    }

    setSubmittingSettlement(true);
    try {
      const payload = {
        outstanding_debt: liveCalc.serviceDebt,
        items: deductionItems.map((it) => ({
          category: it.category,
          amount: Math.round(Number(it.amount)),
          description: it.description.trim(),
          evidence: it.evidence,
        })),
        refund_method: refundMethod,
        bank_info:
          refundMethod === 'BANK_TRANSFER'
            ? {
                bank_name: bankInfo.bank_name.trim(),
                account_number: bankInfo.account_number.trim(),
                account_holder: bankInfo.account_holder.trim(),
              }
            : {},
      };

      const res = await depositsService.submitSettlement(settlementDeposit.id, payload);
      toast.success(
        res?.message || 'Đã trình hồ sơ tất toán cọc chờ cấp thẩm quyền nội bộ (Four-Eyes) phê duyệt.'
      );
      setSettlementOpen(false);
      setActiveTab('pending');
      await fetchDeposits();
    } catch (err) {
      toast.error(extractErrorMessage(err, 'Không thể gửi hồ sơ tất toán cọc.'));
    } finally {
      setSubmittingSettlement(false);
    }
  };

  // OWNER phê duyệt hoàn cọc (Four-Eyes)
  const handleConfirmApproveSettlement = async () => {
    if (!settlementDeposit) return;
    setApprovingSettlement(true);
    try {
      const res = await depositsService.approveSettlement(settlementDeposit.id, {});
      toast.success(res?.message || 'Đã phê duyệt tất toán và hoàn cọc thành công.');
      setApproveConfirmOpen(false);
      setSettlementOpen(false);
      setActiveTab('refunded');
      await fetchDeposits();
    } catch (err) {
      toast.error(extractErrorMessage(err, 'Không thể phê duyệt tất toán cọc.'));
    } finally {
      setApprovingSettlement(false);
    }
  };

  // OWNER từ chối biên bản tất toán
  const handleConfirmRejectSettlement = async (e) => {
    e?.preventDefault();
    if (!settlementDeposit) return;
    if (!rejectReason.trim()) {
      toast.warning('Vui lòng cung cấp lý do từ chối hồ sơ tất toán.');
      return;
    }
    setRejectingSettlement(true);
    try {
      const res = await depositsService.rejectSettlement(settlementDeposit.id, {
        reason: rejectReason.trim(),
      });
      toast.success(res?.message || 'Đã từ chối biên bản tất toán, trả về bản nháp cho BQL chỉnh sửa.');
      setRejectModalOpen(false);
      setSettlementOpen(false);
      setRejectReason('');
      await fetchDeposits();
    } catch (err) {
      toast.error(extractErrorMessage(err, 'Không thể từ chối hồ sơ tất toán.'));
    } finally {
      setRejectingSettlement(false);
    }
  };

  // MANAGER chuyển sang trạng thái Tranh chấp (DISPUTED)
  const handleOpenDispute = (dep) => {
    setDisputeTarget(dep);
    setDisputeReason('');
    setDisputeModalOpen(true);
  };

  const handleConfirmDispute = async (e) => {
    e?.preventDefault();
    if (!disputeTarget) return;
    if (!disputeReason.trim()) {
      toast.warning('Vui lòng nhập lý do phát sinh tranh chấp cọc.');
      return;
    }
    setSubmittingDispute(true);
    try {
      const res = await depositsService.dispute(disputeTarget.id, {
        reason: disputeReason.trim(),
      });
      toast.success(res?.message || 'Đã chuyển hồ sơ sang trạng thái Tranh chấp (DISPUTED).');
      setDisputeModalOpen(false);
      setSettlementOpen(false);
      setDisputeTarget(null);
      setDisputeReason('');
      setActiveTab('disputed');
      await fetchDeposits();
    } catch (err) {
      toast.error(extractErrorMessage(err, 'Không thể chuyển trạng thái tranh chấp.'));
    } finally {
      setSubmittingDispute(false);
    }
  };

  // Giải quyết khiếu nại cọc (R-07: ADJUST -> SETTLEMENT_DRAFT | CONFIRM -> giữ kết quả)
  const handleOpenResolveDispute = useCallback(
    async (dep) => {
      setResolveTarget(dep);
      setResolveSettlementData(dep?.settlement || null);
      setResolveReason('');
      setResolveModalOpen(true);
      setLoadingResolveDetail(true);
      try {
        const res = await depositsService.getSettlement(dep.id);
        const detail = res?.data || {};
        setResolveTarget((prev) => ({ ...(prev || dep), ...detail }));
        setResolveSettlementData(detail.settlement || dep?.settlement || null);
      } catch {
        // Fallback to row's settlement data if already loaded
      } finally {
        setLoadingResolveDetail(false);
      }
    },
    []
  );

  const handleSubmitResolveDispute = async (resolution) => {
    if (!resolveTarget) return;
    if (!resolveReason.trim()) {
      toast.warning('Vui lòng nhập nội dung / lý do giải quyết khiếu nại.');
      return;
    }
    if (resolution === 'ADJUST' && Number(resolveTarget.amount_held || 0) === 0) {
      toast.warning('Không thể mở lại sửa bảng kê vì tiền cọc đã được chi hoàn hết (số dư = 0).');
      return;
    }
    setResolvingAction(resolution);
    try {
      const res = await depositsService.resolveDispute(resolveTarget.id, {
        resolution,
        reason: resolveReason.trim(),
      });
      toast.success(
        res?.message ||
          (resolution === 'ADJUST'
            ? 'Đã mở lại bảng kê tất toán về trạng thái nháp (SETTLEMENT_DRAFT) để chỉnh sửa.'
            : 'Đã xác nhận kết quả tất toán và đóng khiếu nại.')
      );
      setResolveModalOpen(false);
      setSettlementOpen(false);
      setResolveTarget(null);
      setResolveReason('');
      setActiveTab(resolution === 'ADJUST' ? 'held' : 'refunded');
      await fetchDeposits();
    } catch (err) {
      toast.error(extractErrorMessage(err, 'Không thể giải quyết khiếu nại sổ cọc.'));
    } finally {
      setResolvingAction('');
    }
  };

  // In bảng kê tất toán chuẩn A4 (R-24)
  const handlePrintSettlementPdf = useCallback(
    async (dep) => {
      if (!dep?.id) return;
      const printWin = window.open('', '_blank');
      if (!printWin) {
        toast.warning(
          'Trình duyệt đang chặn cửa sổ bật lên (Pop-up). Vui lòng cho phép mở tab mới để in bảng kê A4.'
        );
        return;
      }
      printWin.document.write(
        '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Đang tải bảng kê tất toán A4...</title></head><body style="font-family:sans-serif;padding:40px;text-align:center;color:#334155;">Đang chuẩn bị bản in Bảng kê tất toán tiền cọc chuẩn A4...</body></html>'
      );
      setPrintingDepositId(dep.id);
      try {
        const html = await depositsService.getSettlementPdfHtml(dep.id);
        printWin.document.open();
        printWin.document.write(html);
        printWin.document.close();
      } catch (err) {
        printWin.close();
        toast.error(extractErrorMessage(err, 'Không thể tải bản in A4 bảng kê tất toán.'));
      } finally {
        setPrintingDepositId(null);
      }
    },
    [toast]
  );

  const columns = useMemo(
    () => [
      {
        key: 'apartment_code',
        label: 'Căn hộ / Tòa nhà',
        sortable: true,
        render: (row) => (
          <div>
            <p className="font-semibold text-slate-900 flex items-center gap-1.5">
              <Building2 className="w-3.5 h-3.5 text-primary-500" />
              {row.apartment_code}
            </p>
            <p className="text-xs text-slate-500">{row.building_name}</p>
          </div>
        ),
      },
      {
        key: 'tenant_name',
        label: 'Khách thuê & Hợp đồng',
        sortable: true,
        render: (row) => (
          <div>
            <p className="font-medium text-slate-800">{row.tenant_name}</p>
            <div className="flex items-center gap-1.5 mt-0.5">
              <Link
                to={`/admin/contracts/${row.contract_id}`}
                onClick={(e) => e.stopPropagation()}
                className="font-mono text-[11px] text-primary-600 hover:underline"
              >
                HĐ-{String(row.contract_id).slice(0, 8).toUpperCase()}
              </Link>
              <span className="text-slate-300">•</span>
              <StatusBadge status={row.contract_status} domain="contract" dot={false} />
            </div>
          </div>
        ),
      },
      {
        key: 'amount_held',
        label: 'Số dư cọc',
        align: 'right',
        sortable: true,
        sortValue: (row) => Number(row.amount_held || 0),
        className: 'font-mono tabular-nums whitespace-nowrap',
        render: (row) => (
          <div>
            <p className="font-bold text-slate-900">{formatMoney(row.amount_held)}</p>
            {row.deposit_amount !== undefined && row.deposit_amount !== null ? (
              <p className="text-[11px] font-sans text-slate-500">
                Cọc HĐ: {formatMoney(row.deposit_amount)}
              </p>
            ) : null}
            {row.settlement?.refund_amount !== undefined ? (
              <p className="text-[11px] font-sans text-emerald-600 font-medium">
                Dự kiến hoàn: {formatMoney(row.settlement.refund_amount)}
              </p>
            ) : null}
          </div>
        ),
      },
      {
        key: 'refund_due_date',
        label: 'Hạn hoàn cọc',
        align: 'center',
        className: 'whitespace-nowrap',
        render: (row) => {
          if (!row.refund_due_date) {
            return <span className="text-xs text-slate-400">—</span>;
          }
          const isOverdue =
            ['HELD', 'SETTLEMENT_DRAFT', 'PENDING_APPROVAL'].includes(row.status) &&
            new Date(row.refund_due_date) < new Date();
          return (
            <span
              className={`text-xs font-medium ${
                isOverdue ? 'text-rose-600 font-semibold' : 'text-slate-700'
              }`}
            >
              {formatDate(row.refund_due_date)}
              {isOverdue ? ' (Quá hạn)' : ''}
            </span>
          );
        },
      },
      {
        key: 'status',
        label: 'Trạng thái',
        align: 'center',
        sortable: true,
        render: (row) => <StatusBadge status={row.status} domain="deposit" />,
      },
      {
        key: 'actions',
        label: 'Thao tác',
        align: 'center',
        className: 'whitespace-nowrap',
        render: (row) => (
          <div
            className="inline-flex items-center justify-center gap-1.5"
            onClick={(e) => e.stopPropagation()}
          >
            <Button
              variant="ghost"
              size="xs"
              icon={History}
              onClick={() => handleOpenTransactions(row, false)}
            >
              Sổ giao dịch
            </Button>

            {canSettleDeposits && ['HELD', 'SETTLEMENT_DRAFT'].includes(row.status) ? (
              <Button
                variant="outline"
                size="xs"
                icon={Plus}
                onClick={() => handleOpenTransactions(row, true)}
              >
                Thu bổ sung
              </Button>
            ) : null}

            {canSettleDeposits && ['HELD', 'SETTLEMENT_DRAFT'].includes(row.status) ? (
              <Button
                variant="primary"
                size="xs"
                icon={FileCheck2}
                onClick={() => handleOpenSettlement(row)}
              >
                {row.status === 'SETTLEMENT_DRAFT' ? 'Sửa tất toán' : 'Tất toán cọc'}
              </Button>
            ) : null}

            {row.status === 'PENDING_APPROVAL' ? (
              <>
                <Button
                  variant={canApproveDepositRefund ? 'success' : 'soft'}
                  size="xs"
                  icon={ShieldCheck}
                  onClick={() => handleOpenSettlement(row)}
                >
                  {canApproveDepositRefund ? 'Xem & Duyệt hoàn cọc' : 'Xem biên bản'}
                </Button>
                {(isSysAdmin || isManager) ? (
                  <Button
                    variant="outline"
                    size="xs"
                    icon={ShieldAlert}
                    className="text-rose-600 border-rose-200 hover:bg-rose-50"
                    onClick={() => handleOpenDispute(row)}
                  >
                    Tranh chấp
                  </Button>
                ) : null}
              </>
            ) : null}

            {['REFUNDED', 'PARTIALLY_REFUNDED', 'DISPUTED'].includes(row.status) ? (
              <Button
                variant="soft"
                size="xs"
                icon={Receipt}
                onClick={() => handleOpenSettlement(row)}
              >
                Biên bản tất toán
              </Button>
            ) : null}

            {row.status === 'DISPUTED' && (isSysAdmin || isManager) ? (
              <Button
                variant="primary"
                size="xs"
                icon={MessageSquareWarning}
                onClick={() => handleOpenResolveDispute(row)}
              >
                Giải quyết khiếu nại
              </Button>
            ) : null}

            {['PENDING_APPROVAL', 'PARTIALLY_REFUNDED', 'REFUNDED', 'DISPUTED', 'SETTLEMENT_DRAFT'].includes(
              row.status
            ) ? (
              <Button
                variant="outline"
                size="xs"
                icon={Printer}
                loading={printingDepositId === row.id}
                onClick={() => handlePrintSettlementPdf(row)}
              >
                In bảng kê A4
              </Button>
            ) : null}
          </div>
        ),
      },
    ],
    [
      isSysAdmin,
      isManager,
      canSettleDeposits,
      canApproveDepositRefund,
      printingDepositId,
      handleOpenTransactions,
      handleOpenSettlement,
      handleOpenResolveDispute,
      handlePrintSettlementPdf,
    ]
  );

  const tabs = [
    { id: 'held', label: 'Đang giữ cọc', icon: Wallet, count: tabCounts.held },
    { id: 'pending', label: 'Chờ duyệt hoàn cọc', icon: Clock, count: tabCounts.pending },
    {
      id: 'refunded',
      label: 'Đã hoàn / Hoàn một phần',
      icon: CheckCircle2,
      count: tabCounts.refunded,
    },
    { id: 'disputed', label: 'Tranh chấp', icon: ShieldAlert, count: tabCounts.disputed },
  ];

  // Xác định chế độ hiển thị trong Settlement Modal:
  // MANAGER / SYS_ADMIN có thể lập/sửa khi status thuộc ['HELD', 'SETTLEMENT_DRAFT']
  const effectiveDepositStatus = settlementDetail?.status || settlementDeposit?.status;
  const effectiveContractStatus =
    settlementDetail?.contract_status || settlementDeposit?.contract_status;
  const isManagerEditableSettlement =
    canSettleDeposits && ['HELD', 'SETTLEMENT_DRAFT'].includes(effectiveDepositStatus);
  const isContractReadyForSettlement = ['TERMINATED', 'EXPIRED'].includes(effectiveContractStatus);
  const settlementPreconditions = settlementDetail?.preconditions || null;
  const isPreconditionsReady = settlementPreconditions
    ? Boolean(settlementPreconditions.ready)
    : isContractReadyForSettlement;
  const readonlySettlementData = settlementDetail?.settlement || settlementDeposit?.settlement || null;
  const settlementDisputeThread = Array.isArray(readonlySettlementData?.dispute_thread)
    ? readonlySettlementData.dispute_thread
    : Array.isArray(readonlySettlementData?.thread)
    ? readonlySettlementData.thread
    : [];
  const isSettlementCreator = Boolean(
    readonlySettlementData?.created_by &&
      currentUserId &&
      String(readonlySettlementData.created_by) === String(currentUserId)
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title="Quản lý Tiền đặt cọc & Tất toán"
        subtitle="Theo dõi sổ tiền cọc bảo đảm, thu bổ sung cọc và phê duyệt hoàn cọc theo nguyên tắc Four-Eyes (FR-024)"
        actions={
          <Button variant="outline" size="md" icon={RefreshCw} onClick={fetchDeposits}>
            Làm mới dữ liệu
          </Button>
        }
      />

      {/* KPI Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatsCard
          title="Tổng tiền cọc đang giữ"
          value={formatMoney(tabCounts.totalHeldAmount)}
          subtext={`${tabCounts.held} sổ cọc đang bảo lưu`}
          icon={Wallet}
          color="sky"
          onClick={() => setActiveTab('held')}
        />
        <StatsCard
          title="Chờ duyệt hoàn cọc"
          value={tabCounts.pending}
          subtext="Biên bản tất toán chờ Four-Eyes"
          icon={Clock}
          color="amber"
          onClick={() => setActiveTab('pending')}
        />
        <StatsCard
          title="Đã hoàn / Tất toán"
          value={tabCounts.refunded}
          subtext="Hoàn đủ hoặc hoàn một phần"
          icon={CheckCircle2}
          color="emerald"
          onClick={() => setActiveTab('refunded')}
        />
        <StatsCard
          title="Hồ sơ tranh chấp"
          value={tabCounts.disputed}
          subtext="Đang tạm khóa phê duyệt hoàn"
          icon={ShieldAlert}
          color="rose"
          onClick={() => setActiveTab('disputed')}
        />
      </div>

      {/* Tabs */}
      <Tabs tabs={tabs} activeTab={activeTab} onChange={setActiveTab} />

      {/* Search Bar */}
      <Card className="p-4">
        <SearchBar
          value={search}
          onChange={setSearch}
          placeholder="Tìm theo mã căn hộ, tên tòa nhà, họ tên khách thuê hoặc mã hợp đồng..."
        />
      </Card>

      {/* Bảng dữ liệu sổ cọc */}
      <DataTable
        columns={columns}
        data={filteredDeposits}
        loading={loading}
        onRowClick={(row) => handleOpenTransactions(row, false)}
        emptyTitle="Chưa có sổ cọc trong mục này"
        emptyDescription="Các sổ cọc được tự động khởi tạo khi hợp đồng thuê được kích hoạt sang trạng thái ACTIVE."
      />

      {/* MODAL 1: Lịch sử giao dịch cọc & Thu bổ sung cọc */}
      <Modal
        open={txnModalOpen}
        onClose={() => setTxnModalOpen(false)}
        title={
          selectedDepositForTxn
            ? `Sổ giao dịch tiền cọc — Căn ${selectedDepositForTxn.apartment_code}`
            : 'Lịch sử giao dịch cọc'
        }
        subtitle={
          selectedDepositForTxn
            ? `${selectedDepositForTxn.building_name} • Khách thuê: ${
                selectedDepositForTxn.tenant_name
              } • Đang giữ: ${formatMoney(selectedDepositForTxn.amount_held)}`
            : ''
        }
        size="lg"
        footer={
          <Button variant="outline" onClick={() => setTxnModalOpen(false)}>
            Đóng cửa sổ
          </Button>
        }
      >
        <div className="space-y-5">
          {/* Header summary + nút bật form thu bổ sung */}
          {selectedDepositForTxn ? (
            <div className="p-4 rounded-xl bg-sky-50/70 border border-sky-200/80 flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-xs text-sky-700 font-medium">Số dư cọc đang bảo lưu thực tế</p>
                <p className="text-xl font-bold text-slate-900 mt-0.5">
                  {formatMoney(selectedDepositForTxn.amount_held)}
                </p>
                {selectedDepositForTxn.deposit_amount !== undefined &&
                selectedDepositForTxn.deposit_amount !== null ? (
                  <p className="text-xs text-slate-600 mt-0.5">
                    Cọc yêu cầu theo HĐ:{' '}
                    <strong>{formatMoney(selectedDepositForTxn.deposit_amount)}</strong>
                  </p>
                ) : null}
              </div>
              <div className="flex items-center gap-2">
                <StatusBadge status={selectedDepositForTxn.status} domain="deposit" />
                {canSettleDeposits &&
                ['HELD', 'SETTLEMENT_DRAFT'].includes(selectedDepositForTxn.status) ? (
                  <Button
                    variant={showCollectForm ? 'outline' : 'primary'}
                    size="sm"
                    icon={showCollectForm ? XCircle : Plus}
                    onClick={() => setShowCollectForm((v) => !v)}
                  >
                    {showCollectForm ? 'Ẩn biểu mẫu thu' : 'Thu bổ sung cọc'}
                  </Button>
                ) : null}
              </div>
            </div>
          ) : null}

          {/* Form Thu bổ sung cọc (type='collect') */}
          {showCollectForm && canSettleDeposits ? (
            <form
              onSubmit={handleSubmitCollect}
              className="p-4 rounded-xl border border-primary-200 bg-primary-50/20 space-y-4"
            >
              <h4 className="text-sm font-semibold text-slate-900 flex items-center gap-1.5">
                <Banknote className="w-4 h-4 text-primary-600" />
                Ghi nhận thu bổ sung tiền đặt cọc
              </h4>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <Input
                  label="Số tiền thu thêm (VND)"
                  type="number"
                  min="1"
                  required
                  placeholder="VD: 5000000"
                  value={collectForm.amount}
                  onChange={(e) => setCollectForm((p) => ({ ...p, amount: e.target.value }))}
                />
                <Select
                  label="Phương thức thanh toán"
                  required
                  value={collectForm.method}
                  onChange={(e) => setCollectForm((p) => ({ ...p, method: e.target.value }))}
                  options={PAYMENT_METHOD_OPTIONS}
                />
              </div>

              <Input
                label="Nội dung diễn giải"
                placeholder="VD: Thu đủ phần cọc còn lại sau khi trừ tiền giữ chỗ..."
                value={collectForm.description}
                onChange={(e) => setCollectForm((p) => ({ ...p, description: e.target.value }))}
              />

              <FileUpload
                label="Ảnh chứng từ / Ủy nhiệm chi đính kèm"
                multiple
                maxFiles={3}
                value={collectForm.evidence}
                onChange={(vals) => setCollectForm((p) => ({ ...p, evidence: vals }))}
                hint="Tải lên biên lai thu tiền hoặc ảnh chụp chuyển khoản (tối đa 3 ảnh)"
              />

              <div className="flex justify-end gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setShowCollectForm(false)}
                  disabled={submittingCollect}
                >
                  Hủy
                </Button>
                <Button variant="primary" size="sm" type="submit" loading={submittingCollect}>
                  Xác nhận thu cọc
                </Button>
              </div>
            </form>
          ) : null}

          {/* Danh sách giao dịch */}
          {loadingTxns ? (
            <LoadingSpinner label="Đang tải lịch sử biến động sổ cọc..." />
          ) : transactions.length === 0 ? (
            <EmptyState
              icon={History}
              title="Chưa có biến động giao dịch cọc"
              description="Sổ cọc chưa phát sinh giao dịch thu bổ sung, khấu trừ hoặc hoàn trả."
            />
          ) : (
            <div className="space-y-3">
              {transactions.map((tx) => {
                const meta = TXN_TYPE_META[tx.type] || {
                  label: tx.type,
                  variant: 'slate',
                  sign: '',
                };
                const evList = Array.isArray(tx.evidence) ? tx.evidence.filter(Boolean) : [];
                return (
                  <div
                    key={tx.id}
                    className="p-3.5 rounded-xl border border-slate-200 bg-white space-y-2"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="flex items-center gap-2 flex-wrap">
                          <Badge variant={meta.variant} dot>
                            {meta.label}
                          </Badge>
                          {tx.category ? (
                            <Badge variant="slate">
                              {CATEGORY_LABEL_MAP[tx.category] || tx.category}
                            </Badge>
                          ) : null}
                          <span className="text-xs text-slate-400">• {tx.method || 'OTHER'}</span>
                        </div>
                        <p className="text-xs text-slate-700 mt-1.5 font-medium">
                          {tx.description || '—'}
                        </p>
                        <p className="text-[11px] text-slate-400 mt-0.5">
                          Thực hiện: {tx.created_by_name || 'Hệ thống'} •{' '}
                          {formatDateTime(tx.created_at)}
                        </p>
                      </div>

                      <span
                        className={`text-sm font-bold shrink-0 ${
                          meta.sign === '+' ? 'text-emerald-600' : 'text-rose-600'
                        }`}
                      >
                        {meta.sign}
                        {formatMoney(tx.amount)}
                      </span>
                    </div>

                    {evList.length > 0 ? (
                      <div className="flex flex-wrap gap-2 pt-1">
                        {evList.map((src, idx) => (
                          <div
                            key={idx}
                            onClick={() => setPreviewImg(src)}
                            className="w-14 h-14 rounded-lg border border-slate-200 overflow-hidden cursor-pointer hover:border-primary-400"
                          >
                            <AuthImage src={src} alt="Chứng từ" className="w-full h-full object-cover" />
                          </div>
                        ))}
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </Modal>

      {/* MODAL 2: Tất toán & Hoàn cọc chuẩn Four-Eyes (FR-024) */}
      <Modal
        open={settlementOpen}
        onClose={() => setSettlementOpen(false)}
        title={
          settlementDeposit
            ? `Biên bản Tất toán & Hoàn cọc — Căn ${settlementDeposit.apartment_code}`
            : 'Hồ sơ tất toán tiền cọc'
        }
        subtitle="Quy trình kiểm soát chéo nội bộ Four-Eyes: Quản lý tòa nhà lập biên bản & bằng chứng → SYS_ADMIN / Quản lý khác phê duyệt (FR-024)"
        size="xl"
        footer={
          <div className="flex items-center justify-between w-full flex-wrap gap-2">
            <div className="flex items-center gap-2 flex-wrap">
              {settlementDeposit &&
              ['PENDING_APPROVAL', 'PARTIALLY_REFUNDED', 'REFUNDED', 'DISPUTED', 'SETTLEMENT_DRAFT'].includes(
                effectiveDepositStatus
              ) ? (
                <Button
                  variant="outline"
                  icon={Printer}
                  loading={printingDepositId === settlementDeposit.id}
                  onClick={() => handlePrintSettlementPdf(settlementDeposit)}
                >
                  In bảng kê A4
                </Button>
              ) : null}

              {(isSysAdmin || isManager) &&
              effectiveDepositStatus === 'PENDING_APPROVAL' &&
              settlementDeposit ? (
                <Button
                  variant="outline"
                  icon={ShieldAlert}
                  className="text-rose-600 border-rose-200 hover:bg-rose-50"
                  onClick={() => handleOpenDispute(settlementDeposit)}
                >
                  Chuyển Tranh chấp (DISPUTED)
                </Button>
              ) : null}

              {(isSysAdmin || isManager) &&
              effectiveDepositStatus === 'DISPUTED' &&
              settlementDeposit ? (
                <Button
                  variant="primary"
                  icon={MessageSquareWarning}
                  onClick={() => handleOpenResolveDispute(settlementDeposit)}
                >
                  Giải quyết khiếu nại
                </Button>
              ) : null}
            </div>

            <div className="flex items-center gap-2 flex-wrap">
              <Button variant="outline" onClick={() => setSettlementOpen(false)}>
                Đóng
              </Button>

              {isManagerEditableSettlement ? (
                <Button
                  variant="primary"
                  icon={FileCheck2}
                  loading={submittingSettlement}
                  disabled={!isPreconditionsReady}
                  onClick={handleSubmitSettlement}
                >
                  Gửi phê duyệt tất toán (Four-Eyes)
                </Button>
              ) : null}

              {canApproveDepositRefund &&
              (!isSettlementCreator || allowSelfApproval) &&
              effectiveDepositStatus === 'PENDING_APPROVAL' ? (
                <>
                  <Button
                    variant="danger"
                    icon={XCircle}
                    onClick={() => {
                      setRejectReason('');
                      setRejectModalOpen(true);
                    }}
                  >
                    Từ chối biên bản
                  </Button>
                  <Button
                    variant="success"
                    icon={ShieldCheck}
                    onClick={() => setApproveConfirmOpen(true)}
                  >
                    Phê duyệt hoàn cọc
                  </Button>
                </>
              ) : canApproveDepositRefund &&
                isSettlementCreator &&
                !allowSelfApproval &&
                effectiveDepositStatus === 'PENDING_APPROVAL' ? (
                <span className="text-xs font-medium text-amber-700 bg-amber-50 border border-amber-200 px-2.5 py-1.5 rounded-lg">
                  Chờ Quản lý khác / SYS_ADMIN duyệt (Four-Eyes)
                </span>
              ) : null}
            </div>
          </div>
        }
      >
        {loadingSettlement ? (
          <LoadingSpinner label="Đang tải hồ sơ tất toán..." />
        ) : isManagerEditableSettlement ? (
          /* CHẾ ĐỘ LẬP BIÊN BẢN TẤT TOÁN DÀNH CHO MANAGER */
          <form onSubmit={handleSubmitSettlement} className="space-y-5">
            {/* Kiểm tra các điều kiện tiên quyết (R-06 Pre-conditions) */}
            {!isPreconditionsReady ? (
              <div className="p-4 rounded-xl bg-amber-50 border border-amber-300 space-y-2.5">
                <div className="flex items-start gap-2.5 text-xs text-amber-900">
                  <AlertTriangle className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
                  <div className="space-y-1.5 flex-1">
                    <p className="font-semibold text-sm">
                      Chưa đủ điều kiện tiên quyết để trình phê duyệt tất toán cọc:
                    </p>
                    <ul className="list-disc pl-4 space-y-1 text-amber-800">
                      {(settlementPreconditions
                        ? !settlementPreconditions.contract_ended
                        : !isContractReadyForSettlement) ? (
                        <li>
                          Hợp đồng đang ở trạng thái <strong>{effectiveContractStatus}</strong> — bắt buộc phải ở trạng thái <strong>Đã thanh lý (TERMINATED)</strong> hoặc <strong>Đã hết hạn (EXPIRED)</strong>.
                        </li>
                      ) : null}
                      {settlementPreconditions &&
                      settlementPreconditions.final_meters_recorded === false ? (
                        <li>
                          Chưa ghi đủ chỉ số công tơ điện/nước cuối kỳ
                          {Array.isArray(settlementPreconditions.missing_meter_types) &&
                          settlementPreconditions.missing_meter_types.length > 0
                            ? ` (thiếu: ${settlementPreconditions.missing_meter_types.join(', ')})`
                            : ''}
                          . Vui lòng cập nhật chỉ số điện/nước trước khi lập tất toán.
                        </li>
                      ) : null}
                      {settlementPreconditions &&
                      settlementPreconditions.no_draft_invoices === false ? (
                        <li>
                          Còn hóa đơn bản nháp (<strong>DRAFT</strong>) chưa phát hành hoặc chưa hủy. Vui lòng phát hành hoặc hủy hóa đơn nháp trước khi tất toán.
                        </li>
                      ) : null}
                    </ul>
                  </div>
                </div>
                <div className="flex flex-wrap gap-2 pl-7">
                  {settlementDeposit?.contract_id &&
                  (settlementPreconditions
                    ? !settlementPreconditions.contract_ended
                    : !isContractReadyForSettlement) ? (
                    <Button
                      variant="outline"
                      size="xs"
                      rightIcon={ExternalLink}
                      onClick={() => {
                        setSettlementOpen(false);
                        navigate(`/admin/contracts/${settlementDeposit.contract_id}`);
                      }}
                    >
                      Đi tới Hợp đồng
                    </Button>
                  ) : null}
                  {settlementPreconditions &&
                  settlementPreconditions.final_meters_recorded === false ? (
                    <Button
                      variant="outline"
                      size="xs"
                      rightIcon={ExternalLink}
                      onClick={() => {
                        setSettlementOpen(false);
                        navigate('/admin/meters');
                      }}
                    >
                      Ghi chỉ số Điện / Nước
                    </Button>
                  ) : null}
                  {settlementPreconditions &&
                  settlementPreconditions.no_draft_invoices === false ? (
                    <Button
                      variant="outline"
                      size="xs"
                      rightIcon={ExternalLink}
                      onClick={() => {
                        setSettlementOpen(false);
                        navigate('/admin/invoices');
                      }}
                    >
                      Kiểm tra Hóa đơn nháp
                    </Button>
                  ) : null}
                </div>
              </div>
            ) : null}

            {/* Hiển thị lý do bị từ chối trước đó (nếu đang SETTLEMENT_DRAFT) */}
            {readonlySettlementData?.rejection_reason ? (
              <div className="p-3.5 rounded-xl bg-rose-50 border border-rose-200 text-xs text-rose-800">
                <p className="font-semibold">
                  Biên bản trước đó đã bị từ chối phê duyệt — Vui lòng điều chỉnh lại:
                </p>
                <p className="mt-1">{readonlySettlementData.rejection_reason}</p>
              </div>
            ) : null}

            {/* Quy tắc nghiệp vụ FR-023: Cấm khấu trừ tiền thuê */}
            <div className="p-3.5 rounded-xl bg-sky-50 border border-sky-200 flex items-start gap-2.5 text-xs text-sky-900">
              <ShieldAlert className="w-5 h-5 text-sky-600 shrink-0 mt-0.5" />
              <div className="leading-relaxed">
                <p className="font-semibold">Quy tắc khấu trừ bắt buộc (FR-023 &amp; FR-024):</p>
                <p className="text-sky-800 mt-0.5">
                  • <strong>Tuyệt đối KHÔNG cấn trừ tiền thuê phòng (RENT)</strong> vào biên bản khấu trừ vật chất.
                  <br />• Mỗi khoản khấu trừ hư hỏng / vệ sinh / tiện ích bắt buộc phải nhập lý do chi tiết và đính kèm <strong>ít nhất 01 ảnh bằng chứng nghiệm thu</strong>.
                </p>
              </div>
            </div>

            {/* Danh sách khoản mục khấu trừ */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <h4 className="text-sm font-semibold text-slate-900">
                  1. Các khoản khấu trừ biên bản bàn giao ({deductionItems.length})
                </h4>
                <Button variant="soft" size="xs" icon={Plus} onClick={handleAddDeductionRow}>
                  Thêm khoản khấu trừ
                </Button>
              </div>

              {deductionItems.length === 0 ? (
                <div className="p-4 rounded-xl border border-dashed border-slate-200 text-center text-xs text-slate-500">
                  Không có khấu trừ hư hỏng/vệ sinh (Hoàn 100% cọc sau khi đối trừ công nợ tồn đọng nếu có).
                </div>
              ) : (
                <div className="space-y-3">
                  {deductionItems.map((item, idx) => (
                    <div
                      key={idx}
                      className="p-4 rounded-xl border border-slate-200 bg-slate-50/60 space-y-3"
                    >
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-bold text-slate-700">
                          Khoản khấu trừ #{idx + 1}
                        </span>
                        <button
                          type="button"
                          onClick={() => handleRemoveDeductionRow(idx)}
                          className="inline-flex items-center gap-1 text-xs text-rose-600 hover:text-rose-700 font-medium"
                        >
                          <Trash2 className="w-3.5 h-3.5" /> Xóa khoản này
                        </button>
                      </div>

                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <Select
                          label="Danh mục khấu trừ (Không gồm tiền thuê)"
                          required
                          value={item.category}
                          onChange={(e) =>
                            handleUpdateDeductionRow(idx, { category: e.target.value })
                          }
                          options={DEDUCT_CATEGORY_OPTIONS}
                        />
                        <Input
                          label="Số tiền khấu trừ (VND)"
                          type="number"
                          min="1"
                          required
                          placeholder="VD: 500000"
                          value={item.amount}
                          onChange={(e) =>
                            handleUpdateDeductionRow(idx, { amount: e.target.value })
                          }
                        />
                      </div>

                      <Input
                        label="Mô tả hiện trạng / Lý do khấu trừ"
                        required
                        placeholder="VD: Vỡ kính bàn trà phòng khách theo biên bản bàn giao..."
                        value={item.description}
                        onChange={(e) =>
                          handleUpdateDeductionRow(idx, { description: e.target.value })
                        }
                      />

                      <FileUpload
                        label="Hình ảnh bằng chứng hiện trường (Bắt buộc ≥ 1 ảnh)"
                        multiple
                        maxFiles={3}
                        value={item.evidence}
                        onChange={(vals) => handleUpdateDeductionRow(idx, { evidence: vals })}
                      />
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Công nợ tồn đọng tự động (chỉ đọc) & Thông tin hoàn trả */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-2 border-t border-slate-100">
              <div className="space-y-3">
                <h4 className="text-sm font-semibold text-slate-900">
                  2. Công nợ tự động từ hệ thống &amp; Phương thức hoàn
                </h4>
                <div className="p-3.5 rounded-xl bg-slate-50 border border-slate-200 space-y-2 text-xs">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-slate-700 font-medium">
                      Nợ dịch vụ / điện nước (sẽ trừ vào cọc):
                    </span>
                    <strong className="font-mono text-amber-700 text-sm">
                      {formatMoney(liveCalc.serviceDebt)}
                    </strong>
                  </div>
                  <div className="flex items-center justify-between gap-2 pt-1.5 border-t border-slate-200/80">
                    <span className="text-slate-600">
                      Nợ tiền thuê (KHÔNG trừ vào cọc — cư dân thanh toán riêng):
                    </span>
                    <strong className="font-mono text-slate-800">
                      {formatMoney(liveCalc.rentDebt)}
                    </strong>
                  </div>
                  <p className="text-[11px] text-slate-500 pt-0.5">
                    Công nợ được tổng hợp tự động (chỉ đọc) từ các hóa đơn đã phát hành chưa thanh toán.
                  </p>
                </div>
                <Select
                  label="Phương thức hoàn trả tiền cọc"
                  value={refundMethod}
                  onChange={(e) => setRefundMethod(e.target.value)}
                  options={PAYMENT_METHOD_OPTIONS}
                />
                {refundMethod === 'BANK_TRANSFER' ? (
                  <div className="grid grid-cols-1 gap-2.5 pt-1">
                    <Input
                      label="Ngân hàng thụ hưởng của cư dân"
                      placeholder="VD: Vietcombank, Techcombank..."
                      value={bankInfo.bank_name}
                      onChange={(e) => setBankInfo((p) => ({ ...p, bank_name: e.target.value }))}
                    />
                    <div className="grid grid-cols-2 gap-2.5">
                      <Input
                        label="Số tài khoản"
                        placeholder="Số TK nhận hoàn cọc"
                        value={bankInfo.account_number}
                        onChange={(e) =>
                          setBankInfo((p) => ({ ...p, account_number: e.target.value }))
                        }
                      />
                      <Input
                        label="Chủ tài khoản"
                        placeholder="Họ tên in hoa"
                        value={bankInfo.account_holder}
                        onChange={(e) =>
                          setBankInfo((p) => ({ ...p, account_holder: e.target.value }))
                        }
                      />
                    </div>
                  </div>
                ) : null}
              </div>

              {/* Bảng tổng hợp tự động */}
              <div className="p-4 rounded-xl bg-slate-50 border border-slate-200/80 space-y-3 self-start">
                <h4 className="text-sm font-semibold text-slate-900">
                  3. Bảng đối chiếu tất toán tự động
                </h4>
                <div className="space-y-2 text-xs">
                  <div className="flex justify-between text-slate-600">
                    <span>Tiền cọc đang bảo lưu:</span>
                    <span className="font-semibold text-slate-900">
                      {formatMoney(liveCalc.held)}
                    </span>
                  </div>
                  <div className="flex justify-between text-slate-600">
                    <span>Nợ dịch vụ / điện nước (sẽ trừ vào cọc):</span>
                    <span className="font-semibold text-amber-700">
                      - {formatMoney(liveCalc.serviceDebt)}
                    </span>
                  </div>
                  <div className="flex justify-between text-slate-600">
                    <span>Tổng khấu trừ biên bản ({deductionItems.length} mục):</span>
                    <span className="font-semibold text-amber-700">
                      - {formatMoney(liveCalc.itemsTotal)}
                    </span>
                  </div>
                  {liveCalc.rentDebt > 0 ? (
                    <div className="flex justify-between text-slate-500 italic">
                      <span>Nợ tiền thuê (KHÔNG trừ vào cọc):</span>
                      <span className="font-semibold text-rose-600">
                        {formatMoney(liveCalc.rentDebt)}
                      </span>
                    </div>
                  ) : null}
                  <div className="border-t border-slate-200 pt-2.5 flex justify-between items-center text-sm">
                    <span className="font-bold text-slate-800">Dự kiến hoàn trả khách thuê:</span>
                    <span className="text-lg font-bold text-emerald-600">
                      {formatMoney(liveCalc.refundAmount)}
                    </span>
                  </div>
                </div>

                {liveCalc.shortfall > 0 ? (
                  <div className="p-3 rounded-lg bg-rose-50 border border-rose-200 text-xs text-rose-800 leading-relaxed">
                    <p className="font-bold">
                      Phát sinh thiếu hụt sau trả phòng (Shortfall): {formatMoney(liveCalc.shortfall)}
                    </p>
                    <p className="mt-0.5">
                      Tổng khấu trừ &amp; công nợ vượt số cọc đang giữ. Khi phê duyệt tất toán, hệ thống tự động tạo khoản phải thu sau trả phòng (<code>RECEIVABLE_AFTER_MOVE_OUT</code>).
                    </p>
                  </div>
                ) : null}
              </div>
            </div>
          </form>
        ) : (
          /* CHẾ ĐỘ XEM BIÊN BẢN & DUYỆT FOUR-EYES DÀNH CHO OWNER / XEM LỊCH SỬ */
          <div className="space-y-5">
            <div className="p-4 rounded-xl bg-slate-50 border border-slate-200 flex flex-wrap items-center justify-between gap-4">
              <div>
                <p className="text-xs text-slate-500">Khách thuê &amp; Căn hộ</p>
                <p className="text-sm font-bold text-slate-900 mt-0.5">
                  {settlementDetail?.tenant_name || settlementDeposit?.tenant_name} — Căn{' '}
                  {settlementDetail?.apartment_code || settlementDeposit?.apartment_code} (
                  {settlementDetail?.building_name || settlementDeposit?.building_name})
                </p>
              </div>
              <StatusBadge status={effectiveDepositStatus} domain="deposit" />
            </div>

            {(effectiveDepositStatus === 'DISPUTED' ||
              readonlySettlementData?.dispute_reason ||
              settlementDisputeThread.length > 0) ? (
              <div className="p-4 rounded-xl bg-rose-50/80 border border-rose-200 text-xs text-rose-900 space-y-2.5">
                <p className="font-bold flex items-center gap-1.5 text-rose-800">
                  <ShieldAlert className="w-4 h-4" />{' '}
                  {effectiveDepositStatus === 'DISPUTED'
                    ? 'Hồ sơ đang trong tình trạng Tranh chấp / Khiếu nại (DISPUTED)'
                    : 'Lịch sử trao đổi khiếu nại tiền cọc'}
                </p>
                {readonlySettlementData?.dispute_reason ? (
                  <p>
                    <strong>Lý do khiếu nại gần nhất:</strong> {readonlySettlementData.dispute_reason}
                  </p>
                ) : null}
                {settlementDisputeThread.length > 0 ? (
                  <div className="space-y-1.5 pt-1">
                    {settlementDisputeThread.map((msg, mIdx) => (
                      <div
                        key={mIdx}
                        className="p-2.5 rounded-lg bg-white border border-rose-200/70 space-y-0.5"
                      >
                        <div className="flex items-center justify-between gap-2 text-[11px] text-slate-500">
                          <Badge variant={msg.role === 'RESIDENT' ? 'amber' : 'indigo'}>
                            {msg.role === 'RESIDENT' ? 'Cư dân khiếu nại' : `BQL (${msg.role || 'ADMIN'})`}
                          </Badge>
                          <span>{formatDateTime(msg.at)}</span>
                        </div>
                        <p className="text-xs text-slate-800 pt-0.5">{msg.message}</p>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}

            {!readonlySettlementData ? (
              <EmptyState
                title="Chưa có dữ liệu biên bản tất toán"
                description="Quản lý tòa nhà (MANAGER) chưa lập hồ sơ tất toán cho sổ cọc này."
              />
            ) : (
              <>
                <div className="space-y-3">
                  <h4 className="text-sm font-semibold text-slate-900">
                    Chi tiết các khoản khấu trừ &amp; Bằng chứng nghiệm thu (
                    {(readonlySettlementData.items || []).length})
                  </h4>

                  {(readonlySettlementData.items || []).length === 0 ? (
                    <div className="p-3.5 rounded-xl border border-slate-200 bg-emerald-50/40 text-xs text-emerald-800 font-medium">
                      Không có khoản khấu trừ hư hỏng vật chất nào — Bàn giao nguyên trạng tốt.
                    </div>
                  ) : (
                    <div className="space-y-2.5">
                      {(readonlySettlementData.items || []).map((it, idx) => (
                        <div
                          key={idx}
                          className="p-3.5 rounded-xl border border-slate-200 bg-white space-y-2"
                        >
                          <div className="flex items-center justify-between gap-2">
                            <Badge variant="amber">
                              {CATEGORY_LABEL_MAP[it.category] || it.category}
                            </Badge>
                            <span className="text-sm font-bold text-rose-600">
                              - {formatMoney(it.amount)}
                            </span>
                          </div>
                          <p className="text-xs text-slate-700">{it.description}</p>
                          {Array.isArray(it.evidence) && it.evidence.length > 0 ? (
                            <div className="flex flex-wrap gap-2 pt-1">
                              {it.evidence.map((ev, eIdx) => (
                                <div
                                  key={eIdx}
                                  onClick={() => setPreviewImg(ev)}
                                  className="relative w-16 h-16 rounded-lg border border-slate-200 overflow-hidden cursor-pointer hover:border-primary-400"
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
                </div>

                {/* Tổng kết tài chính biên bản */}
                <div className="p-4 rounded-xl bg-sky-50/60 border border-sky-200 space-y-2 text-xs">
                  <div className="flex justify-between text-slate-700">
                    <span>Công nợ dịch vụ tồn đọng (outstanding_debt):</span>
                    <strong>{formatMoney(readonlySettlementData.outstanding_debt || 0)}</strong>
                  </div>
                  <div className="flex justify-between text-slate-700">
                    <span>Phương thức hoàn trả:</span>
                    <strong>
                      {readonlySettlementData.refund_method === 'CASH'
                        ? 'Tiền mặt (CASH)'
                        : 'Chuyển khoản ngân hàng (BANK_TRANSFER)'}
                    </strong>
                  </div>
                  {readonlySettlementData.bank_info?.account_number ? (
                    <div className="flex justify-between text-slate-700">
                      <span>Tài khoản nhận hoàn cọc:</span>
                      <strong>
                        {readonlySettlementData.bank_info.bank_name} •{' '}
                        {readonlySettlementData.bank_info.account_number} (
                        {readonlySettlementData.bank_info.account_holder})
                      </strong>
                    </div>
                  ) : null}
                  <div className="border-t border-sky-200 pt-2.5 flex justify-between items-center text-sm">
                    <span className="font-bold text-slate-900">Số tiền hoàn trả thực tế:</span>
                    <span className="text-lg font-bold text-emerald-700">
                      {formatMoney(readonlySettlementData.refund_amount || 0)}
                    </span>
                  </div>
                  {Number(readonlySettlementData.shortfall || 0) > 0 ? (
                    <div className="flex justify-between items-center text-rose-700 font-semibold pt-1">
                      <span>Khoản phải thu thêm sau trả phòng (Shortfall):</span>
                      <span>{formatMoney(readonlySettlementData.shortfall)}</span>
                    </div>
                  ) : null}
                </div>
              </>
            )}
          </div>
        )}
      </Modal>

      {/* Modal Phóng to ảnh chứng từ / bằng chứng */}
      <Modal
        open={Boolean(previewImg)}
        onClose={() => setPreviewImg(null)}
        title="Xem chi tiết chứng từ / bằng chứng"
        size="lg"
        footer={
          <Button variant="outline" onClick={() => setPreviewImg(null)}>
            Đóng
          </Button>
        }
      >
        <div className="flex items-center justify-center bg-slate-900/5 rounded-xl p-2 min-h-[300px]">
          {previewImg ? (
            <AuthImage
              src={previewImg}
              alt="Bằng chứng đính kèm"
              className="max-h-[70vh] w-auto rounded-lg object-contain"
            />
          ) : null}
        </div>
      </Modal>

      {/* Confirm OWNER phê duyệt hoàn cọc */}
      <ConfirmDialog
        open={approveConfirmOpen}
        onClose={() => setApproveConfirmOpen(false)}
        onConfirm={handleConfirmApproveSettlement}
        loading={approvingSettlement}
        variant="success"
        title="Phê duyệt tất toán & Hoàn trả tiền cọc"
        confirmLabel="Xác nhận phê duyệt"
        message={
          settlementDeposit
            ? `Xác nhận phê duyệt biên bản tất toán cọc cho căn hộ ${
                settlementDeposit.apartment_code
              } với số tiền hoàn trả là ${formatMoney(
                readonlySettlementData?.refund_amount || 0
              )}? Hệ thống sẽ tự động ghi sổ giao dịch và gửi thông báo cho cư dân.`
            : ''
        }
      />

      {/* Modal OWNER từ chối biên bản tất toán */}
      <Modal
        open={rejectModalOpen}
        onClose={() => setRejectModalOpen(false)}
        title="Từ chối biên bản tất toán cọc"
        subtitle="Hồ sơ sẽ quay về trạng thái Nháp tất toán (SETTLEMENT_DRAFT) để Quản lý tòa nhà bổ sung / chỉnh sửa"
        size="sm"
        footer={
          <>
            <Button
              variant="outline"
              onClick={() => setRejectModalOpen(false)}
              disabled={rejectingSettlement}
            >
              Hủy
            </Button>
            <Button
              variant="danger"
              onClick={handleConfirmRejectSettlement}
              loading={rejectingSettlement}
            >
              Xác nhận từ chối
            </Button>
          </>
        }
      >
        <Input
          label="Lý do từ chối biên bản"
          required
          multiline
          rows={3}
          placeholder="VD: Ảnh chụp bằng chứng khấu trừ chưa rõ nét, đề nghị kiểm tra lại..."
          value={rejectReason}
          onChange={(e) => setRejectReason(e.target.value)}
        />
      </Modal>

      {/* Modal MANAGER chuyển trạng thái Tranh chấp */}
      <Modal
        open={disputeModalOpen}
        onClose={() => setDisputeModalOpen(false)}
        title="Ghi nhận tranh chấp tiền đặt cọc"
        subtitle="Hồ sơ sẽ chuyển sang trạng thái DISPUTED và tạm khóa phê duyệt hoàn cọc cho đến khi giải quyết xong"
        size="sm"
        footer={
          <>
            <Button
              variant="outline"
              onClick={() => setDisputeModalOpen(false)}
              disabled={submittingDispute}
            >
              Hủy bỏ
            </Button>
            <Button
              variant="danger"
              onClick={handleConfirmDispute}
              loading={submittingDispute}
              icon={ShieldAlert}
            >
              Chuyển sang Tranh chấp
            </Button>
          </>
        }
      >
        <Input
          label="Nội dung / Lý do tranh chấp với khách thuê"
          required
          multiline
          rows={3}
          placeholder="Nhập chi tiết khiếu nại hoặc bất đồng về mức khấu trừ..."
          value={disputeReason}
          onChange={(e) => setDisputeReason(e.target.value)}
        />
      </Modal>

      {/* Modal Giải quyết khiếu nại cọc (R-07: ADJUST / CONFIRM) */}
      <Modal
        open={resolveModalOpen}
        onClose={() => {
          if (!resolvingAction) setResolveModalOpen(false);
        }}
        title={
          resolveTarget
            ? `Giải quyết khiếu nại tất toán — Căn ${resolveTarget.apartment_code}`
            : 'Giải quyết khiếu nại tất toán cọc'
        }
        subtitle="Xem xét nội dung khiếu nại của cư dân và lựa chọn mở lại sửa bảng kê hoặc xác nhận giữ nguyên kết quả"
        size="md"
        footer={
          <div className="flex flex-wrap items-center justify-between gap-2 w-full">
            <Button
              variant="outline"
              onClick={() => setResolveModalOpen(false)}
              disabled={Boolean(resolvingAction)}
            >
              Đóng
            </Button>
            <div className="flex flex-wrap items-center gap-2">
              <span
                title={
                  Number(resolveTarget?.amount_held || 0) === 0
                    ? 'Không thể mở lại sửa bảng kê vì tiền cọc đã được chi hoàn hết (số dư cọc = 0)'
                    : 'Đưa sổ cọc về trạng thái SETTLEMENT_DRAFT để chỉnh sửa lại bảng kê khấu trừ'
                }
              >
                <Button
                  variant="outline"
                  loading={resolvingAction === 'ADJUST'}
                  disabled={
                    Number(resolveTarget?.amount_held || 0) === 0 || Boolean(resolvingAction)
                  }
                  onClick={() => handleSubmitResolveDispute('ADJUST')}
                >
                  Mở lại sửa bảng kê
                </Button>
              </span>
              <Button
                variant="success"
                icon={CheckCircle2}
                loading={resolvingAction === 'CONFIRM'}
                disabled={Boolean(resolvingAction)}
                onClick={() => handleSubmitResolveDispute('CONFIRM')}
              >
                Xác nhận kết quả
              </Button>
            </div>
          </div>
        }
      >
        {loadingResolveDetail && !resolveSettlementData ? (
          <LoadingSpinner label="Đang tải nội dung khiếu nại..." />
        ) : (
          <div className="space-y-4">
            {resolveSettlementData?.dispute_reason ? (
              <div className="p-3.5 rounded-xl bg-rose-50 border border-rose-200 text-xs text-rose-900">
                <p className="font-semibold text-rose-800">Lý do khiếu nại hiện tại:</p>
                <p className="mt-1">{resolveSettlementData.dispute_reason}</p>
              </div>
            ) : null}

            {(() => {
              const thread = Array.isArray(resolveSettlementData?.dispute_thread)
                ? resolveSettlementData.dispute_thread
                : Array.isArray(resolveSettlementData?.thread)
                ? resolveSettlementData.thread
                : [];
              if (thread.length === 0) return null;
              return (
                <div className="space-y-2">
                  <p className="text-xs font-semibold text-slate-700">
                    Lịch sử trao đổi khiếu nại ({thread.length})
                  </p>
                  <div className="max-h-56 overflow-y-auto space-y-2 pr-1">
                    {thread.map((entry, idx) => (
                      <div
                        key={idx}
                        className="p-3 rounded-xl border border-slate-200 bg-slate-50/70 space-y-1 text-xs"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <Badge variant={entry.role === 'RESIDENT' ? 'amber' : 'indigo'}>
                            {entry.role === 'RESIDENT'
                              ? 'Cư dân'
                              : `Ban quản lý (${entry.role || 'ADMIN'})`}
                          </Badge>
                          <span className="text-[11px] text-slate-400">
                            {formatDateTime(entry.at)}
                          </span>
                        </div>
                        <p className="text-slate-800 leading-relaxed">{entry.message}</p>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })()}

            {Number(resolveTarget?.amount_held || 0) === 0 ? (
              <div className="p-3 rounded-xl bg-amber-50 border border-amber-200 text-xs text-amber-800">
                Lưu ý: Sổ cọc này đã được chi hoàn hết (<strong>số dư đang giữ = 0 ₫</strong>), nên nút{' '}
                <strong>Mở lại sửa bảng kê</strong> bị vô hiệu hóa. Bạn chỉ có thể ghi nhận giải trình và{' '}
                <strong>Xác nhận kết quả</strong>.
              </div>
            ) : null}

            <Input
              label="Nội dung phản hồi / Quyết định giải quyết khiếu nại"
              required
              multiline
              rows={3}
              placeholder="Nhập phản hồi giải quyết khiếu nại gửi tới cư dân và lưu lịch sử..."
              value={resolveReason}
              onChange={(e) => setResolveReason(e.target.value)}
            />
          </div>
        )}
      </Modal>
    </div>
  );
}

export default DepositsPage;
