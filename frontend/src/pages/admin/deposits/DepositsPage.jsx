import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useNavigate, useSearchParams, Link } from 'react-router-dom';
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
  RotateCcw,
  Landmark,
  FileSpreadsheet,
  ScrollText,
} from 'lucide-react';
import { Button } from '../../../components/ui/Button';
import { Input } from '../../../components/ui/Input';
import { MoneyInput } from '../../../components/ui/MoneyInput';
import { Select } from '../../../components/ui/Select';
import { BankSelect } from '../../../components/common/BankSelect';
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
import { reportsService } from '../../../services/reports.service';
import { usersService } from '../../../services/users.service';
import { usePermission } from '../../../hooks/usePermission';
import { useVietQrBanks } from '../../../hooks/useVietQrBanks';
import { useToast } from '../../../hooks/useToast';
import { useAuthStore } from '../../../stores/authStore';
import { formatMoney, formatDate, formatDateTime } from '../../../utils/format';
import { matchVietQrBank } from '../../../utils/vietqrBanks';
import { toDateOnlyStr } from '../../../utils/dateRange';
import { extractErrorMessage } from '../../../utils/validation';
import { createIdempotencyKey, canCollectAdditionalDeposit } from '../../../utils/idempotency';
import { canActorApproveDepositRow } from '../../../utils/depositUiHelpers';

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
  TRANSFER_IN: 'Nhận kết chuyển',
  TRANSFER_OUT: 'Kết chuyển đi',
};

const AUDIT_ENTITY_META = {
  deposit: { label: 'Sổ cọc hợp đồng', variant: 'sky' },
  deposit_transaction: { label: 'Bút toán giao dịch cọc', variant: 'emerald' },
  receivable: { label: 'Công nợ cấn trừ / phát sinh', variant: 'amber' },
  reservation: { label: 'Phiếu đặt giữ chỗ gốc', variant: 'purple' },
};

const TXN_TYPE_META = {
  collect: { label: 'Thu tiền cọc', variant: 'emerald', sign: '+' },
  transfer: { label: 'Kết chuyển cọc', variant: 'sky', sign: '+' },
  deduct: { label: 'Khấu trừ cọc', variant: 'amber', sign: '-' },
  refund: { label: 'Hoàn trả cọc', variant: 'indigo', sign: '-' },
  refund_reversal: { label: 'Ngân hàng trả lại lệnh chi', variant: 'amber', sign: '+' },
};

function resolveDepositTxnMeta(tx) {
  if (
    tx?.type === 'transfer' &&
    (tx?.category === 'TRANSFER_OUT' || /^chuyển kết dư/i.test(String(tx?.description || '').trim()))
  ) {
    return { label: 'Kết chuyển đi', variant: 'amber', sign: '-' };
  }
  return TXN_TYPE_META[tx?.type] || { label: tx?.type || 'Giao dịch', variant: 'slate', sign: '' };
}

const PAYMENT_METHOD_OPTIONS = [
  { value: 'BANK_TRANSFER', label: 'Chuyển khoản ngân hàng (BANK_TRANSFER)' },
  { value: 'CASH', label: 'Tiền mặt (CASH)' },
];

const PAYMENT_METHOD_LABELS = {
  BANK_TRANSFER: 'Chuyển khoản ngân hàng',
  TRANSFER: 'Chuyển khoản ngân hàng',
  QR_CODE: 'Quét mã QR',
  E_WALLET: 'Ví điện tử',
  CASH: 'Tiền mặt',
  CARD: 'Thẻ ngân hàng',
  OTHER: 'Phương thức khác',
};

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
  const [searchParams, setSearchParams] = useSearchParams();
  const toast = useToast();
  const {
    isSysAdmin,
    isOwner,
    isManager,
    isResident,
    canSettleDeposits,
    canExecuteDepositPayout,
    canApproveDepositRefund,
    user,
  } = usePermission();
  const { banks } = useVietQrBanks();
  const currentUserId = user?.id || user?.sub;
  const selectedBuildingId = useAuthStore((s) => s.selectedBuildingId);

  const [deposits, setDeposits] = useState([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState('held');
  const [search, setSearch] = useState('');
  const [exportingExcel, setExportingExcel] = useState(false);

  // Image Preview state
  const [previewImg, setPreviewImg] = useState(null);

  // Transactions, Audit Timeline & Collect Deposit Modal state
  const [txnModalOpen, setTxnModalOpen] = useState(false);
  const [txnModalSubTab, setTxnModalSubTab] = useState('transactions'); // 'transactions' | 'audit'
  const [selectedDepositForTxn, setSelectedDepositForTxn] = useState(null);
  const [transactions, setTransactions] = useState([]);
  const [loadingTxns, setLoadingTxns] = useState(false);
  const [auditLogs, setAuditLogs] = useState([]);
  const [loadingAuditLogs, setLoadingAuditLogs] = useState(false);
  const [auditLoadedDepositId, setAuditLoadedDepositId] = useState(null);
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
  const [inspectionEvidence, setInspectionEvidence] = useState([]);
  const [refundMethod, setRefundMethod] = useState('BANK_TRANSFER');
  const [bankInfo, setBankInfo] = useState({
    bank_name: '',
    bank_code: '',
    bank_bin: '',
    bank_logo: '',
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

  // Payout Execution Modal state (MANAGER UNC execution — Phase 2)
  const [payoutModalOpen, setPayoutModalOpen] = useState(false);
  const [payoutTarget, setPayoutTarget] = useState(null);
  const [payoutDetail, setPayoutDetail] = useState(null);
  const [loadingPayoutDetail, setLoadingPayoutDetail] = useState(false);
  const [payoutForm, setPayoutForm] = useState({
    evidence: [],
    reference_code: '',
    note: '',
  });
  const [submittingPayout, setSubmittingPayout] = useState(false);

  // Mark Returned Modal state (Bank reversal — Phase 2)
  const [returnedModalOpen, setReturnedModalOpen] = useState(false);
  const [returnedTarget, setReturnedTarget] = useState(null);
  const [returnedForm, setReturnedForm] = useState({
    reason: '',
    reference_code: '',
  });
  const [submittingReturned, setSubmittingReturned] = useState(false);

  // Update Refund Bank Info Modal state (Phase 2)
  const [bankUpdateModalOpen, setBankUpdateModalOpen] = useState(false);
  const [bankUpdateTarget, setBankUpdateTarget] = useState(null);
  const [bankUpdateForm, setBankUpdateForm] = useState({
    bank_name: '',
    bank_code: '',
    bank_bin: '',
    bank_logo: '',
    account_number: '',
    account_holder: '',
  });
  const [submittingBankUpdate, setSubmittingBankUpdate] = useState(false);

  // Rotating Idempotency-Key refs per modal/form session (GAP-04)
  const collectIdemKeyRef = useRef(createIdempotencyKey());
  const settlementIdemKeyRef = useRef(createIdempotencyKey());
  const approveIdemKeyRef = useRef(createIdempotencyKey());
  const rejectIdemKeyRef = useRef(createIdempotencyKey());
  const disputeIdemKeyRef = useRef(createIdempotencyKey());
  const resolveIdemKeyRef = useRef(createIdempotencyKey());
  const payoutIdemKeyRef = useRef(createIdempotencyKey());
  const returnedIdemKeyRef = useRef(createIdempotencyKey());
  const bankUpdateIdemKeyRef = useRef(createIdempotencyKey());

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
    const pending = scopedDeposits.filter((d) =>
      ['PENDING_APPROVAL', 'APPROVED_PENDING_PAYOUT'].includes(d.status)
    ).length;
    const returned = scopedDeposits.filter((d) => d.status === 'RETURNED').length;
    const refunded = scopedDeposits.filter((d) =>
      ['REFUNDED', 'PARTIALLY_REFUNDED', 'DEDUCTED_FULL', 'TRANSFERRED'].includes(d.status)
    ).length;
    const disputed = scopedDeposits.filter((d) => d.status === 'DISPUTED').length;
    const totalHeldAmount = scopedDeposits
      .filter((d) =>
        [
          'HELD',
          'SETTLEMENT_DRAFT',
          'PENDING_APPROVAL',
          'APPROVED_PENDING_PAYOUT',
          'RETURNED',
          'DISPUTED',
        ].includes(d.status)
      )
      .reduce((sum, d) => sum + Number(d.amount_held || 0), 0);

    return { held, pending, returned, refunded, disputed, totalHeldAmount };
  }, [scopedDeposits]);

  const tabQueryParam = searchParams.get('tab') || '';
  const statusQueryParam = searchParams.get('status') || '';
  const overdueOnlyFilter = searchParams.get('overdue') === '1';
  const payoutOnlyFilter = tabQueryParam === 'payout';

  useEffect(() => {
    if (statusQueryParam === 'DISPUTED') {
      setActiveTab('disputed');
    } else if (tabQueryParam === 'payout') {
      setActiveTab('pending');
    } else if (['held', 'pending', 'returned', 'refunded', 'disputed'].includes(tabQueryParam)) {
      setActiveTab(tabQueryParam);
    }
  }, [tabQueryParam, statusQueryParam]);

  const handleSelectMainTab = useCallback(
    (nextTab) => {
      setActiveTab(nextTab);
      if (tabQueryParam || statusQueryParam || overdueOnlyFilter) {
        setSearchParams({}, { replace: true });
      }
    },
    [tabQueryParam, statusQueryParam, overdueOnlyFilter, setSearchParams]
  );

  const handleClearDrillDown = useCallback(() => {
    setSearchParams({}, { replace: true });
  }, [setSearchParams]);

  const handleExportLedgerExcel = async () => {
    setExportingExcel(true);
    try {
      const blob = await reportsService.exportDepositLedgerXlsx({
        building_id: selectedBuildingId || undefined,
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `so-coc-rp07-${new Date().toISOString().slice(0, 10)}.xlsx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast.success('Đã xuất Sổ cọc (RP-07) ra tệp Excel (.xlsx).');
    } catch (err) {
      toast.error(extractErrorMessage(err, 'Không thể xuất tệp Excel Sổ cọc (RP-07).'));
    } finally {
      setExportingExcel(false);
    }
  };

  const filteredDeposits = useMemo(() => {
    const q = search.trim().toLowerCase();
    const now = new Date();
    const todayIso = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
      now.getDate()
    ).padStart(2, '0')}`;

    return scopedDeposits.filter((d) => {
      if (overdueOnlyFilter) {
        const dueStr = d.refund_due_date ? toDateOnlyStr(d.refund_due_date) : '';
        if (
          !dueStr ||
          dueStr >= todayIso ||
          ['REFUNDED', 'PARTIALLY_REFUNDED', 'DEDUCTED_FULL', 'TRANSFERRED'].includes(d.status)
        ) {
          return false;
        }
      } else if (payoutOnlyFilter) {
        if (!['APPROVED_PENDING_PAYOUT', 'RETURNED'].includes(d.status)) return false;
      } else if (statusQueryParam) {
        if (d.status !== statusQueryParam) return false;
      } else {
        if (activeTab === 'held' && !['HELD', 'SETTLEMENT_DRAFT'].includes(d.status)) return false;
        if (
          activeTab === 'pending' &&
          !['PENDING_APPROVAL', 'APPROVED_PENDING_PAYOUT'].includes(d.status)
        ) {
          return false;
        }
        if (activeTab === 'returned' && d.status !== 'RETURNED') return false;
        if (
          activeTab === 'refunded' &&
          !['REFUNDED', 'PARTIALLY_REFUNDED', 'DEDUCTED_FULL', 'TRANSFERRED'].includes(d.status)
        ) {
          return false;
        }
        if (activeTab === 'disputed' && d.status !== 'DISPUTED') return false;
      }

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
  }, [
    scopedDeposits,
    activeTab,
    search,
    overdueOnlyFilter,
    payoutOnlyFilter,
    statusQueryParam,
  ]);

  const canActAsApproverOnRow = useCallback(
    (depRow, settlementObj = null) =>
      canActorApproveDepositRow({
        isOwner,
        isManager,
        isSysAdmin,
        currentUserId,
        createdBy: settlementObj?.created_by ?? depRow?.settlement?.created_by,
        buildingHasActiveOwner: Boolean(depRow?.building_has_active_owner),
        allowSelfApproval,
      }),
    [isOwner, isManager, isSysAdmin, currentUserId, allowSelfApproval]
  );

  const canResolveDisputeRow = useCallback(
    (depRow) => {
      if (isOwner || isManager) return true;
      if (isSysAdmin && !depRow?.building_has_active_owner) return true;
      return false;
    },
    [isOwner, isManager, isSysAdmin]
  );

  const fetchDepositAuditLogs = useCallback(
    async (depositId) => {
      if (!depositId || isResident) return;
      setLoadingAuditLogs(true);
      try {
        const res = await depositsService.getAuditLogs(depositId);
        setAuditLogs(Array.isArray(res?.data) ? res.data : []);
        setAuditLoadedDepositId(depositId);
      } catch (err) {
        toast.error(extractErrorMessage(err, 'Không thể tải lịch sử kiểm toán của sổ cọc.'));
      } finally {
        setLoadingAuditLogs(false);
      }
    },
    [isResident, toast]
  );

  const handleSwitchTxnSubTab = useCallback(
    (nextSubTab) => {
      setTxnModalSubTab(nextSubTab);
      if (
        nextSubTab === 'audit' &&
        selectedDepositForTxn?.id &&
        auditLoadedDepositId !== selectedDepositForTxn.id
      ) {
        fetchDepositAuditLogs(selectedDepositForTxn.id);
      }
    },
    [selectedDepositForTxn, auditLoadedDepositId, fetchDepositAuditLogs]
  );

  // Mở Modal Lịch sử giao dịch, Kiểm toán & Thu bổ sung cọc
  const handleOpenTransactions = useCallback(
    async (dep, defaultOpenCollect = false, defaultSubTab = 'transactions') => {
      setSelectedDepositForTxn(dep);
      setTxnModalSubTab(defaultSubTab);
      setAuditLogs([]);
      setAuditLoadedDepositId(null);
      const allowCollect = Boolean(defaultOpenCollect) && canCollectAdditionalDeposit(dep);
      if (allowCollect) {
        collectIdemKeyRef.current = createIdempotencyKey();
      }
      setShowCollectForm(allowCollect);
      const shortage = Math.max(
        0,
        Math.round(Number(dep?.deposit_amount || 0) - Number(dep?.amount_held || 0))
      );
      setCollectForm({
        amount: shortage > 0 ? String(shortage) : '',
        method: 'BANK_TRANSFER',
        description:
          Number(dep?.amount_held || 0) === 0
            ? 'Thu tiền đặt cọc bảo đảm hợp đồng'
            : 'Thu bổ sung tiền đặt cọc hợp đồng',
        evidence: [],
      });
      setTxnModalOpen(true);
      if (defaultSubTab === 'audit' && !isResident) {
        fetchDepositAuditLogs(dep.id);
      }
      setLoadingTxns(true);
      try {
        const res = await depositsService.listTransactions(dep.id);
        setTransactions(Array.isArray(res?.data) ? res.data : []);
      } catch (err) {
        toast.error(extractErrorMessage(err, 'Không thể tải lịch sử giao dịch sổ cọc.'));
      } finally {
        setLoadingTxns(false);
      }
    },
    [toast, isResident, fetchDepositAuditLogs]
  );

  const handleSubmitCollect = async (e) => {
    e?.preventDefault();
    if (!selectedDepositForTxn) return;
    if (!canCollectAdditionalDeposit(selectedDepositForTxn)) {
      toast.warning('Sổ cọc hoặc hợp đồng hiện không ở trạng thái cho phép thu bổ sung.');
      return;
    }
    const rawNum = Number(String(collectForm.amount ?? '').trim());
    const shortage = Math.max(
      0,
      Math.round(Number(selectedDepositForTxn.deposit_amount || 0) - Number(selectedDepositForTxn.amount_held || 0))
    );
    if (!Number.isInteger(rawNum) || rawNum <= 0) {
      toast.warning('Số tiền thu bổ sung cọc phải là số nguyên dương VND.');
      return;
    }
    if (rawNum > shortage) {
      toast.warning(`Số tiền thu thêm không được vượt quá phần cọc còn thiếu (${formatMoney(shortage)}).`);
      return;
    }
    const amt = rawNum;
    if (!collectForm.method) {
      toast.warning('Vui lòng chọn phương thức thanh toán.');
      return;
    }

    setSubmittingCollect(true);
    try {
      const res = await depositsService.createTransaction(
        selectedDepositForTxn.id,
        {
          type: 'collect',
          amount: amt,
          method: collectForm.method,
          description: collectForm.description.trim() || 'Thu bổ sung cọc',
          evidence: Array.isArray(collectForm.evidence) ? collectForm.evidence : [],
        },
        { idempotencyKey: collectIdemKeyRef.current }
      );
      collectIdemKeyRef.current = createIdempotencyKey();
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
    settlementIdemKeyRef.current = createIdempotencyKey();
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
      setInspectionEvidence(
        Array.isArray(existing?.inspection_evidence) ? existing.inspection_evidence : []
      );
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
        const matchedBank = matchVietQrBank(banks, existing.bank_info || {});
        setBankInfo({
          bank_name: matchedBank ? matchedBank.shortName : existing.bank_info?.bank_name || '',
          bank_code: existing.bank_info?.bank_code || matchedBank?.code || '',
          bank_bin: existing.bank_info?.bank_bin || matchedBank?.bin || '',
          bank_logo: existing.bank_info?.bank_logo || matchedBank?.logo || '',
          account_number: existing.bank_info?.account_number || '',
          account_holder: existing.bank_info?.account_holder || dep.tenant_name || '',
        });
      } else {
        setDeductionItems([]);
        setRefundMethod('BANK_TRANSFER');
        setBankInfo({
          bank_name: '',
          bank_code: '',
          bank_bin: '',
          bank_logo: '',
          account_number: '',
          account_holder: dep.tenant_name || '',
        });
      }
    } catch (err) {
      toast.error(extractErrorMessage(err, 'Không thể tải thông tin hồ sơ tất toán.'));
    } finally {
      setLoadingSettlement(false);
    }
  }, [banks, toast]);

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

    const alreadyInspected = settlementDetail?.preconditions?.apartment_inspected !== false;
    if (!alreadyInspected && (!Array.isArray(inspectionEvidence) || inspectionEvidence.length === 0)) {
      toast.warning(
        'Vui lòng đính kèm ít nhất 01 ảnh biên bản kiểm tra bàn giao căn hộ hoặc thực hiện nghiệm thu phòng trước khi tất toán.'
      );
      return;
    }

    for (let i = 0; i < deductionItems.length; i += 1) {
      const it = deductionItems[i];
      const numAmt = Number(String(it.amount ?? '').trim());
      if (!Number.isInteger(numAmt) || numAmt <= 0) {
        toast.warning(`Khoản khấu trừ #${i + 1}: Số tiền phải là số nguyên dương VND.`);
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

    if (liveCalc.refundAmount > 0 && refundMethod === 'BANK_TRANSFER') {
      const bName = String(bankInfo.bank_name || '').trim();
      const accNo = String(bankInfo.account_number || '').trim();
      const accHolder = String(bankInfo.account_holder || '').trim();
      if (!bName || !accNo || !accHolder) {
        toast.warning(
          'Vui lòng nhập đầy đủ Ngân hàng, Số tài khoản và Chủ tài khoản nhận hoàn cọc.'
        );
        return;
      }
      if (!/^[A-Za-z0-9]{4,25}$/.test(accNo)) {
        toast.warning(
          'Số tài khoản ngân hàng chỉ được chứa chữ và số (từ 4 đến 25 ký tự, không khoảng trắng hay dấu gạch).'
        );
        return;
      }
    }

    setSubmittingSettlement(true);
    try {
      const payload = {
        outstanding_debt: liveCalc.serviceDebt,
        inspection_evidence: Array.isArray(inspectionEvidence) ? inspectionEvidence : [],
        items: deductionItems.map((it) => ({
          category: it.category,
          amount: Number(String(it.amount).trim()),
          description: it.description.trim(),
          evidence: it.evidence,
        })),
        refund_method: refundMethod,
        bank_info:
          refundMethod === 'BANK_TRANSFER'
            ? {
                bank_name: bankInfo.bank_name.trim(),
                bank_code: bankInfo.bank_code || undefined,
                bank_bin: bankInfo.bank_bin || undefined,
                bank_logo: bankInfo.bank_logo || undefined,
                account_number: bankInfo.account_number.trim(),
                account_holder: bankInfo.account_holder.trim(),
              }
            : {},
      };

      const res = await depositsService.submitSettlement(settlementDeposit.id, payload, {
        idempotencyKey: settlementIdemKeyRef.current,
      });
      toast.success(
        res?.message || 'Đã trình hồ sơ tất toán cọc chờ Chủ nhà / cấp thẩm quyền Four-Eyes phê duyệt.'
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

  // OWNER / Approver phê duyệt bảng kê tất toán (Four-Eyes)
  const handleConfirmApproveSettlement = async () => {
    if (!settlementDeposit) return;
    setApprovingSettlement(true);
    try {
      const res = await depositsService.approveSettlement(
        settlementDeposit.id,
        {},
        { idempotencyKey: approveIdemKeyRef.current }
      );
      const nextStatus = res?.data?.status;
      toast.success(
        res?.message ||
          (nextStatus === 'APPROVED_PENDING_PAYOUT'
            ? 'Đã phê duyệt bảng kê tất toán — chờ BQL tải UNC chi hoàn tiền cọc.'
            : 'Đã phê duyệt tất toán cọc thành công.')
      );
      setApproveConfirmOpen(false);
      setSettlementOpen(false);
      setActiveTab(nextStatus === 'APPROVED_PENDING_PAYOUT' ? 'pending' : 'refunded');
      await fetchDeposits();
    } catch (err) {
      toast.error(extractErrorMessage(err, 'Không thể phê duyệt tất toán cọc.'));
    } finally {
      setApprovingSettlement(false);
    }
  };

  // OWNER / Approver từ chối biên bản tất toán
  const handleConfirmRejectSettlement = async (e) => {
    e?.preventDefault();
    if (!settlementDeposit) return;
    if (!rejectReason.trim()) {
      toast.warning('Vui lòng cung cấp lý do từ chối hồ sơ tất toán.');
      return;
    }
    setRejectingSettlement(true);
    try {
      const res = await depositsService.rejectSettlement(
        settlementDeposit.id,
        { reason: rejectReason.trim() },
        { idempotencyKey: rejectIdemKeyRef.current }
      );
      toast.success(res?.message || 'Đã từ chối biên bản tất toán, trả về bản nháp cho BQL chỉnh sửa.');
      setRejectModalOpen(false);
      setSettlementOpen(false);
      setRejectReason('');
      setActiveTab('held');
      await fetchDeposits();
    } catch (err) {
      toast.error(extractErrorMessage(err, 'Không thể từ chối hồ sơ tất toán.'));
    } finally {
      setRejectingSettlement(false);
    }
  };

  // MANAGER chuyển sang trạng thái Tranh chấp (DISPUTED)
  const handleOpenDispute = (dep) => {
    disputeIdemKeyRef.current = createIdempotencyKey();
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
      const res = await depositsService.dispute(
        disputeTarget.id,
        { reason: disputeReason.trim() },
        { idempotencyKey: disputeIdemKeyRef.current }
      );
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
      resolveIdemKeyRef.current = createIdempotencyKey();
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

  const isResolveAccountingCommitted = useMemo(() => {
    const prevSt = resolveSettlementData?.previous_status_before_dispute || null;
    return (
      Boolean(resolveSettlementData?.accounting_committed_at) ||
      ['PARTIALLY_REFUNDED', 'REFUNDED', 'DEDUCTED_FULL', 'RETURNED'].includes(prevSt)
    );
  }, [resolveSettlementData]);

  const handleSubmitResolveDispute = async (resolution) => {
    if (!resolveTarget) return;
    if (!resolveReason.trim()) {
      toast.warning('Vui lòng nhập nội dung / lý do giải quyết khiếu nại.');
      return;
    }
    if (resolution === 'ADJUST' && isResolveAccountingCommitted) {
      toast.warning('Sổ cọc đã thực hiện hạch toán đối trừ / chi trả, không thể mở lại bản nháp.');
      return;
    }
    setResolvingAction(resolution);
    try {
      const res = await depositsService.resolveDispute(
        resolveTarget.id,
        {
          resolution,
          reason: resolveReason.trim(),
        },
        { idempotencyKey: resolveIdemKeyRef.current }
      );
      const nextStatus = res?.data?.status;
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
      setActiveTab(
        ['PENDING_APPROVAL', 'APPROVED_PENDING_PAYOUT'].includes(nextStatus)
          ? 'pending'
          : nextStatus === 'RETURNED'
          ? 'returned'
          : nextStatus === 'SETTLEMENT_DRAFT' || resolution === 'ADJUST'
          ? 'held'
          : 'refunded'
      );
      await fetchDeposits();
    } catch (err) {
      toast.error(extractErrorMessage(err, 'Không thể giải quyết khiếu nại sổ cọc.'));
    } finally {
      setResolvingAction('');
    }
  };

  // Mở Modal Thực hiện chi hoàn tiền cọc (Payout Execution — MANAGER)
  const handleOpenPayoutModal = useCallback(
    async (dep) => {
      payoutIdemKeyRef.current = createIdempotencyKey();
      setPayoutTarget(dep);
      setPayoutDetail(null);
      setPayoutForm({
        evidence: [],
        reference_code: '',
        note: '',
      });
      setPayoutModalOpen(true);
      setLoadingPayoutDetail(true);
      try {
        const res = await depositsService.getSettlement(dep.id);
        setPayoutDetail(res?.data || null);
      } catch (err) {
        toast.error(extractErrorMessage(err, 'Không thể tải dữ liệu đối soát trước khi chi hoàn.'));
      } finally {
        setLoadingPayoutDetail(false);
      }
    },
    [toast]
  );

  const handleSubmitPayout = async (e) => {
    e?.preventDefault();
    if (!payoutTarget) return;
    const st = payoutDetail?.settlement || payoutTarget?.settlement || {};
    const method = st.refund_method || 'BANK_TRANSFER';
    if (
      payoutDetail?.snapshot_stale &&
      payoutTarget.status === 'APPROVED_PENDING_PAYOUT' &&
      !st.accounting_committed_at
    ) {
      toast.warning(
        'Công nợ hoặc số dư cọc đã biến động kể từ khi duyệt. Vui lòng từ chối bảng kê để tính lại trước khi chi.'
      );
      return;
    }
    if (method === 'BANK_TRANSFER' && (!Array.isArray(payoutForm.evidence) || payoutForm.evidence.length === 0)) {
      toast.warning('Bắt buộc đính kèm ít nhất 01 ảnh chứng từ Ủy nhiệm chi (UNC) khi chuyển khoản hoàn cọc.');
      return;
    }

    setSubmittingPayout(true);
    try {
      const res = await depositsService.executePayout(
        payoutTarget.id,
        {
          evidence: Array.isArray(payoutForm.evidence) ? payoutForm.evidence : [],
          reference_code: payoutForm.reference_code.trim() || undefined,
          note: payoutForm.note.trim() || undefined,
        },
        { idempotencyKey: payoutIdemKeyRef.current }
      );
      payoutIdemKeyRef.current = createIdempotencyKey();
      toast.success(res?.message || 'Đã ghi nhận chi hoàn tiền cọc và lưu chứng từ UNC thành công.');
      setPayoutModalOpen(false);
      setSettlementOpen(false);
      setPayoutTarget(null);
      setActiveTab('refunded');
      await fetchDeposits();
    } catch (err) {
      toast.error(extractErrorMessage(err, 'Không thể thực hiện chi hoàn tiền cọc.'));
    } finally {
      setSubmittingPayout(false);
    }
  };

  // Mở Modal Ghi nhận ngân hàng trả lại lệnh chuyển khoản (RETURNED)
  const handleOpenReturnedModal = useCallback((dep) => {
    returnedIdemKeyRef.current = createIdempotencyKey();
    setReturnedTarget(dep);
    setReturnedForm({ reason: '', reference_code: '' });
    setReturnedModalOpen(true);
  }, []);

  const handleSubmitReturned = async (e) => {
    e?.preventDefault();
    if (!returnedTarget) return;
    if (!returnedForm.reason.trim()) {
      toast.warning('Vui lòng nhập lý do ngân hàng hoàn trả lệnh chuyển tiền.');
      return;
    }
    setSubmittingReturned(true);
    try {
      const res = await depositsService.markPayoutReturned(
        returnedTarget.id,
        {
          reason: returnedForm.reason.trim(),
          reference_code: returnedForm.reference_code.trim() || undefined,
        },
        { idempotencyKey: returnedIdemKeyRef.current }
      );
      returnedIdemKeyRef.current = createIdempotencyKey();
      toast.success(
        res?.message || 'Đã ghi nhận giao dịch ngân hàng trả lại (RETURNED) và thông báo cư dân cập nhật tài khoản.'
      );
      setReturnedModalOpen(false);
      setSettlementOpen(false);
      setReturnedTarget(null);
      setActiveTab('returned');
      await fetchDeposits();
    } catch (err) {
      toast.error(extractErrorMessage(err, 'Không thể ghi nhận trạng thái hoàn trả lệnh chi.'));
    } finally {
      setSubmittingReturned(false);
    }
  };

  // Mở Modal Cập nhật tài khoản thụ hưởng nhận hoàn cọc (APPROVED_PENDING_PAYOUT / RETURNED)
  const handleOpenBankUpdateModal = useCallback(
    (dep, settlementOverride = null) => {
      bankUpdateIdemKeyRef.current = createIdempotencyKey();
      const st = settlementOverride || dep?.settlement || {};
      const matched = matchVietQrBank(banks, st.bank_info || {});
      setBankUpdateTarget(dep);
      setBankUpdateForm({
        bank_name: matched ? matched.shortName : st.bank_info?.bank_name || '',
        bank_code: st.bank_info?.bank_code || matched?.code || '',
        bank_bin: st.bank_info?.bank_bin || matched?.bin || '',
        bank_logo: st.bank_info?.bank_logo || matched?.logo || '',
        account_number: st.bank_info?.account_number || '',
        account_holder: st.bank_info?.account_holder || dep?.tenant_name || '',
      });
      setBankUpdateModalOpen(true);
    },
    [banks]
  );

  const handleSubmitBankUpdate = async (e) => {
    e?.preventDefault();
    if (!bankUpdateTarget) return;
    const bName = String(bankUpdateForm.bank_name || '').trim();
    const accNo = String(bankUpdateForm.account_number || '').trim();
    const accHolder = String(bankUpdateForm.account_holder || '').trim();
    if (!bName || !accNo || !accHolder) {
      toast.warning('Vui lòng nhập đầy đủ Ngân hàng, Số tài khoản và Chủ tài khoản thụ hưởng.');
      return;
    }
    if (!/^[A-Za-z0-9]{4,25}$/.test(accNo)) {
      toast.warning('Số tài khoản ngân hàng chỉ được chứa chữ và số (4–25 ký tự).');
      return;
    }
    setSubmittingBankUpdate(true);
    try {
      const res = await depositsService.updateRefundBankInfo(
        bankUpdateTarget.id,
        {
          bank_info: {
            bank_name: bName,
            bank_code: bankUpdateForm.bank_code || undefined,
            bank_bin: bankUpdateForm.bank_bin || undefined,
            bank_logo: bankUpdateForm.bank_logo || undefined,
            account_number: accNo,
            account_holder: accHolder,
          },
        },
        { idempotencyKey: bankUpdateIdemKeyRef.current }
      );
      bankUpdateIdemKeyRef.current = createIdempotencyKey();
      const updatedSettlement = res?.data?.settlement || null;
      toast.success(res?.message || 'Đã cập nhật thông tin tài khoản thụ hưởng hoàn cọc.');
      setBankUpdateModalOpen(false);
      if (updatedSettlement) {
        setSettlementDetail((prev) => (prev ? { ...prev, settlement: updatedSettlement } : prev));
        setPayoutDetail((prev) => (prev ? { ...prev, settlement: updatedSettlement } : prev));
      }
      await fetchDeposits();
    } catch (err) {
      toast.error(extractErrorMessage(err, 'Không thể cập nhật thông tin tài khoản thụ hưởng.'));
    } finally {
      setSubmittingBankUpdate(false);
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
              <Building2 className="w-3.5 h-3.5 text-primary-500 shrink-0" />
              {row.apartment_code}
            </p>
            <p className="text-xs text-slate-500 break-words max-w-[220px]">{row.building_name}</p>
          </div>
        ),
      },
      {
        key: 'tenant_name',
        label: 'Khách thuê & Hợp đồng',
        sortable: true,
        render: (row) => (
          <div>
            <p className="font-medium text-slate-800 break-words">
              {row.tenant_name}
              {row.tenant_phone ? <span className="text-xs font-mono text-slate-500"> ({row.tenant_phone})</span> : null}
            </p>
            <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
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
        render: (row) => {
          const heldVal = Number(row.amount_held || 0);
          const reqVal = Number(row.deposit_amount || 0);
          const shortage = Math.max(0, reqVal - heldVal);
          const isSettledRow = ['REFUNDED', 'PARTIALLY_REFUNDED', 'DEDUCTED_FULL'].includes(
            row.status
          );
          return (
            <div>
              <p className="font-bold text-slate-900">{formatMoney(row.amount_held)}</p>
              {row.deposit_amount !== undefined && row.deposit_amount !== null ? (
                <p className="text-[11px] font-sans text-slate-500">
                  Cọc HĐ: {formatMoney(row.deposit_amount)}
                </p>
              ) : null}
              {canCollectAdditionalDeposit(row) && shortage > 0 ? (
                <p className="text-[11px] font-sans text-amber-600 font-medium">
                  Còn phải thu: {formatMoney(shortage)}
                </p>
              ) : null}
              {row.settlement?.refund_amount !== undefined ? (
                <p className="text-[11px] font-sans text-emerald-600 font-medium">
                  {isSettledRow
                    ? 'Đã hoàn trả'
                    : row.status === 'RETURNED'
                    ? 'Cần phát hành lại'
                    : 'Dự kiến hoàn'}
                  : {formatMoney(row.settlement.refund_amount)}
                </p>
              ) : null}
            </div>
          );
        },
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
            [
              'HELD',
              'SETTLEMENT_DRAFT',
              'PENDING_APPROVAL',
              'APPROVED_PENDING_PAYOUT',
              'RETURNED',
            ].includes(row.status) && new Date(row.refund_due_date) < new Date();
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
        render: (row) => {
          const canApproveThis = canActAsApproverOnRow(row);
          const hasPositiveRefund = Number(row.settlement?.refund_amount || 0) > 0;
          return (
            <div
              className="inline-flex flex-wrap items-center justify-center gap-1.5"
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

              {canSettleDeposits && canCollectAdditionalDeposit(row) ? (
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
                    variant={canApproveThis ? 'success' : 'soft'}
                    size="xs"
                    icon={ShieldCheck}
                    onClick={() => handleOpenSettlement(row)}
                  >
                    {canApproveThis ? 'Xem & Duyệt hoàn cọc' : 'Xem biên bản'}
                  </Button>
                  {isManager ? (
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

              {['APPROVED_PENDING_PAYOUT', 'RETURNED'].includes(row.status) ? (
                <>
                  <Button
                    variant="soft"
                    size="xs"
                    icon={Receipt}
                    onClick={() => handleOpenSettlement(row)}
                  >
                    Biên bản tất toán
                  </Button>
                  {canExecuteDepositPayout && hasPositiveRefund ? (
                    <>
                      <Button
                        variant="success"
                        size="xs"
                        icon={Banknote}
                        onClick={() => handleOpenPayoutModal(row)}
                      >
                        {row.status === 'RETURNED' ? 'Chi hoàn lại (UNC)' : 'Thực hiện chi hoàn (UNC)'}
                      </Button>
                      <Button
                        variant="outline"
                        size="xs"
                        icon={Landmark}
                        onClick={() => handleOpenBankUpdateModal(row)}
                      >
                        Đổi TK nhận
                      </Button>
                    </>
                  ) : null}
                </>
              ) : null}

              {['REFUNDED', 'PARTIALLY_REFUNDED', 'DEDUCTED_FULL', 'DISPUTED'].includes(row.status) ? (
                <Button
                  variant="soft"
                  size="xs"
                  icon={Receipt}
                  onClick={() => handleOpenSettlement(row)}
                >
                  Biên bản tất toán
                </Button>
              ) : null}

              {canExecuteDepositPayout &&
              ['REFUNDED', 'PARTIALLY_REFUNDED'].includes(row.status) &&
              hasPositiveRefund ? (
                <Button
                  variant="outline"
                  size="xs"
                  icon={RotateCcw}
                  className="text-amber-700 border-amber-200 hover:bg-amber-50"
                  onClick={() => handleOpenReturnedModal(row)}
                >
                  Ngân hàng trả lại
                </Button>
              ) : null}

              {row.status === 'DISPUTED' && canResolveDisputeRow(row) ? (
                <Button
                  variant="primary"
                  size="xs"
                  icon={MessageSquareWarning}
                  onClick={() => handleOpenResolveDispute(row)}
                >
                  Giải quyết khiếu nại
                </Button>
              ) : null}

              {[
                'PENDING_APPROVAL',
                'APPROVED_PENDING_PAYOUT',
                'RETURNED',
                'PARTIALLY_REFUNDED',
                'REFUNDED',
                'DEDUCTED_FULL',
                'DISPUTED',
                'SETTLEMENT_DRAFT',
              ].includes(row.status) ? (
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
          );
        },
      },
    ],
    [
      isManager,
      canSettleDeposits,
      canExecuteDepositPayout,
      canActAsApproverOnRow,
      canResolveDisputeRow,
      printingDepositId,
      handleOpenTransactions,
      handleOpenSettlement,
      handleOpenPayoutModal,
      handleOpenReturnedModal,
      handleOpenBankUpdateModal,
      handleOpenResolveDispute,
      handlePrintSettlementPdf,
    ]
  );

  const tabs = [
    { id: 'held', label: 'Đang giữ cọc', icon: Wallet, count: tabCounts.held },
    { id: 'pending', label: 'Chờ duyệt / Chi hoàn', icon: Clock, count: tabCounts.pending },
    { id: 'returned', label: 'Hoàn trả lệnh chi', icon: RotateCcw, count: tabCounts.returned },
    {
      id: 'refunded',
      label: 'Đã hoàn / Tất toán',
      icon: CheckCircle2,
      count: tabCounts.refunded,
    },
    { id: 'disputed', label: 'Tranh chấp', icon: ShieldAlert, count: tabCounts.disputed },
  ];

  // Xác định chế độ hiển thị trong Settlement Modal:
  const effectiveDepositStatus = settlementDetail?.status || settlementDeposit?.status;
  const effectiveContractStatus =
    settlementDetail?.contract_status || settlementDeposit?.contract_status;
  const isManagerEditableSettlement =
    canSettleDeposits && ['HELD', 'SETTLEMENT_DRAFT'].includes(effectiveDepositStatus);
  const isContractReadyForSettlement = ['TERMINATED', 'EXPIRED'].includes(effectiveContractStatus);
  const settlementPreconditions = settlementDetail?.preconditions || null;
  const isInspectionSatisfied =
    (settlementPreconditions ? settlementPreconditions.apartment_inspected !== false : true) ||
    inspectionEvidence.length > 0;
  const isPreconditionsReady = settlementPreconditions
    ? Boolean(
        settlementPreconditions.contract_ended !== false &&
          settlementPreconditions.final_meters_recorded !== false &&
          settlementPreconditions.no_draft_invoices !== false &&
          isInspectionSatisfied
      )
    : isContractReadyForSettlement;
  const readonlySettlementData = settlementDetail?.settlement || settlementDeposit?.settlement || null;
  const settlementDisputeThread = Array.isArray(readonlySettlementData?.dispute_thread)
    ? readonlySettlementData.dispute_thread
    : Array.isArray(readonlySettlementData?.thread)
    ? readonlySettlementData.thread
    : [];
  const effectiveBuildingHasActiveOwner = Boolean(
    settlementDetail?.building_has_active_owner ?? settlementDeposit?.building_has_active_owner
  );
  const canApproveCurrentModal = canActorApproveDepositRow({
    isOwner,
    isManager,
    isSysAdmin,
    currentUserId,
    createdBy: readonlySettlementData?.created_by,
    buildingHasActiveOwner: effectiveBuildingHasActiveOwner,
    allowSelfApproval,
  });
  const isSettlementCreator = Boolean(
    readonlySettlementData?.created_by &&
      currentUserId &&
      String(readonlySettlementData.created_by) === String(currentUserId)
  );
  const isSnapshotStale =
    ['PENDING_APPROVAL', 'APPROVED_PENDING_PAYOUT'].includes(effectiveDepositStatus) &&
    !readonlySettlementData?.accounting_committed_at &&
    (Boolean(settlementDetail?.snapshot_stale) ||
      Boolean(
        readonlySettlementData &&
          settlementDetail &&
          (Number(settlementDetail.calculated_service_debt ?? 0) !==
            Number(readonlySettlementData.outstanding_debt ?? 0) ||
            Number(settlementDetail.calculated_rent_debt ?? 0) !==
              Number(readonlySettlementData.rent_debt ?? 0) ||
            Number(settlementDetail.amount_held ?? 0) !==
              Number(readonlySettlementData.deposit_held_before_settlement ?? 0))
      ));

  const payoutSettlementData = payoutDetail?.settlement || payoutTarget?.settlement || null;
  const isPayoutSnapshotStale =
    payoutTarget?.status === 'APPROVED_PENDING_PAYOUT' &&
    !payoutSettlementData?.accounting_committed_at &&
    Boolean(payoutDetail?.snapshot_stale);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Quản lý Tiền đặt cọc & Tất toán"
        subtitle="Theo dõi sổ tiền cọc bảo đảm, Chủ nhà / cấp thẩm quyền phê duyệt Four-Eyes và BQL chi hoàn chứng từ UNC (FR-024)"
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {!isResident ? (
              <Button
                variant="outline"
                size="md"
                icon={FileSpreadsheet}
                loading={exportingExcel}
                onClick={handleExportLedgerExcel}
              >
                Xuất Excel (RP-07)
              </Button>
            ) : null}
            <Button variant="outline" size="md" icon={RefreshCw} onClick={fetchDeposits}>
              Làm mới dữ liệu
            </Button>
          </div>
        }
      />

      {/* KPI Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatsCard
          title="Tổng tiền cọc đang giữ"
          value={formatMoney(tabCounts.totalHeldAmount)}
          subtext={`${tabCounts.held} sổ đang bảo lưu${tabCounts.returned > 0 ? ` • ${tabCounts.returned} hoàn trả lệnh chi` : ''}`}
          icon={Wallet}
          color="sky"
          onClick={() => handleSelectMainTab('held')}
        />
        <StatsCard
          title="Chờ duyệt / Chi hoàn"
          value={tabCounts.pending}
          subtext="Chờ Four-Eyes hoặc chờ UNC chi hoàn"
          icon={Clock}
          color="amber"
          onClick={() => handleSelectMainTab('pending')}
        />
        <StatsCard
          title="Đã hoàn / Tất toán"
          value={tabCounts.refunded}
          subtext="Hoàn đủ, hoàn một phần hoặc cấn trừ hết"
          icon={CheckCircle2}
          color="emerald"
          onClick={() => handleSelectMainTab('refunded')}
        />
        <StatsCard
          title="Hồ sơ tranh chấp"
          value={tabCounts.disputed}
          subtext="Đang tạm khóa phê duyệt / chi hoàn"
          icon={ShieldAlert}
          color="rose"
          onClick={() => handleSelectMainTab('disputed')}
        />
      </div>

      {/* Banner thông báo khi đang áp dụng bộ lọc nhanh từ Dashboard */}
      {overdueOnlyFilter || payoutOnlyFilter || statusQueryParam ? (
        <div className="p-3.5 rounded-xl border border-amber-300 bg-amber-50/80 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-xs sm:text-sm text-amber-900">
            <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0" />
            <span>
              Đang áp dụng bộ lọc nhanh từ Dashboard:{' '}
              <strong>
                {overdueOnlyFilter
                  ? 'Các sổ cọc quá hạn hoàn trả (FR-068)'
                  : payoutOnlyFilter
                  ? 'Các sổ cọc chờ BQL chi hoàn UNC / ngân hàng trả lại'
                  : `Trạng thái ${statusQueryParam}`}
              </strong>{' '}
              ({filteredDeposits.length} bản ghi)
            </span>
          </div>
          <Button variant="outline" size="xs" icon={XCircle} onClick={handleClearDrillDown}>
            Xóa bộ lọc nhanh
          </Button>
        </div>
      ) : null}

      {/* Tabs */}
      <Tabs tabs={tabs} activeTab={activeTab} onChange={handleSelectMainTab} />

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

      {/* MODAL 1: Lịch sử giao dịch cọc, Kiểm toán xuyên suốt & Thu bổ sung cọc */}
      <Modal
        open={txnModalOpen}
        onClose={() => setTxnModalOpen(false)}
        title={
          selectedDepositForTxn
            ? `Chi tiết sổ tiền cọc — Căn ${selectedDepositForTxn.apartment_code}`
            : 'Lịch sử giao dịch & kiểm toán cọc'
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
                {canSettleDeposits && canCollectAdditionalDeposit(selectedDepositForTxn) ? (
                  <Button
                    variant={showCollectForm ? 'outline' : 'primary'}
                    size="sm"
                    icon={showCollectForm ? XCircle : Plus}
                    onClick={() => {
                      setTxnModalSubTab('transactions');
                      setShowCollectForm((v) => {
                        const next = !v;
                        if (next) collectIdemKeyRef.current = createIdempotencyKey();
                        return next;
                      });
                    }}
                  >
                    {showCollectForm ? 'Ẩn biểu mẫu thu' : 'Thu bổ sung cọc'}
                  </Button>
                ) : null}
              </div>
            </div>
          ) : null}

          {/* Chuyển đổi Sổ giao dịch | Lịch sử kiểm toán (GAP-07) */}
          {!isResident ? (
            <Tabs
              activeTab={txnModalSubTab}
              onChange={handleSwitchTxnSubTab}
              tabs={[
                {
                  id: 'transactions',
                  label: 'Sổ giao dịch',
                  icon: History,
                  count: transactions.length,
                },
                {
                  id: 'audit',
                  label: 'Lịch sử kiểm toán',
                  icon: ScrollText,
                  count:
                    auditLoadedDepositId === selectedDepositForTxn?.id
                      ? auditLogs.length
                      : undefined,
                },
              ]}
            />
          ) : null}

          {txnModalSubTab === 'audit' && !isResident ? (
            loadingAuditLogs ? (
              <LoadingSpinner label="Đang tải nhật ký kiểm toán xuyên suốt của sổ cọc..." />
            ) : auditLogs.length === 0 ? (
              <EmptyState
                icon={ScrollText}
                title="Chưa có nhật ký kiểm toán"
                description="Mọi thao tác từ giữ chỗ gốc, thu cọc, cấn trừ đến duyệt và chi hoàn đều được tự động lưu vết tại đây."
              />
            ) : (
              <div className="space-y-3">
                {auditLogs.map((log) => {
                  const entityMeta = AUDIT_ENTITY_META[log.entity] || {
                    label: log.entity || 'Đối tượng',
                    variant: 'slate',
                  };
                  const rolesLabel = Array.isArray(log.actor_roles) && log.actor_roles.length > 0
                    ? log.actor_roles.join(', ')
                    : '';
                  const payloadPreview = log.after || log.before || null;
                  return (
                    <div
                      key={log.id}
                      className="p-3.5 rounded-xl border border-slate-200 bg-white space-y-2"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex items-center gap-2 flex-wrap">
                          <Badge variant={entityMeta.variant}>{entityMeta.label}</Badge>
                          <Badge variant="indigo" dot>
                            {log.action}
                          </Badge>
                        </div>
                        <span className="text-xs font-mono text-slate-500">
                          {formatDateTime(log.at || log.created_at)}
                        </span>
                      </div>

                      <p className="text-xs text-slate-700">
                        Thực hiện bởi:{' '}
                        <strong className="text-slate-900">
                          {log.actor_name || 'Hệ thống'}
                        </strong>
                        {rolesLabel ? (
                          <span className="text-slate-500"> ({rolesLabel})</span>
                        ) : null}
                      </p>

                      {payloadPreview ? (
                        <pre className="text-[11px] font-mono bg-slate-50 border border-slate-100 rounded-lg p-2.5 text-slate-700 overflow-x-auto max-h-36">
                          {JSON.stringify(payloadPreview, null, 2)}
                        </pre>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            )
          ) : (
            <>
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
                    <MoneyInput
                      label="Số tiền thu thêm (VND)"
                      required
                      placeholder="VD: 5.000.000"
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
                    const meta = resolveDepositTxnMeta(tx);
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
                              {tx.reference_code ? (
                                <Badge variant="indigo">Mã GD: {tx.reference_code}</Badge>
                              ) : null}
                              <span className="text-xs text-slate-500">
                                • {PAYMENT_METHOD_LABELS[tx.method] || tx.method || 'Phương thức khác'}
                              </span>
                            </div>
                            <p className="text-xs text-slate-700 mt-1.5 font-medium whitespace-pre-line break-words">
                              {tx.description || '—'}
                            </p>
                            <p className="text-[11px] text-slate-400 mt-0.5">
                              Thực hiện: {tx.created_by_name || 'Hệ thống'}
                              {tx.approved_by_name ? ` • Phê duyệt: ${tx.approved_by_name}` : ''} •{' '}
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
            </>
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
        subtitle="Quy trình Four-Eyes: BQL lập biên bản & ảnh nghiệm thu → Chủ nhà / cấp thẩm quyền duyệt → BQL chi hoàn chứng từ UNC (FR-024)"
        size="xl"
        footer={
          <div className="flex items-center justify-between w-full flex-wrap gap-2">
            <div className="flex items-center gap-2 flex-wrap">
              {settlementDeposit &&
              [
                'PENDING_APPROVAL',
                'APPROVED_PENDING_PAYOUT',
                'RETURNED',
                'PARTIALLY_REFUNDED',
                'REFUNDED',
                'DEDUCTED_FULL',
                'DISPUTED',
                'SETTLEMENT_DRAFT',
              ].includes(effectiveDepositStatus) ? (
                <Button
                  variant="outline"
                  icon={Printer}
                  loading={printingDepositId === settlementDeposit.id}
                  onClick={() => handlePrintSettlementPdf(settlementDeposit)}
                >
                  In bảng kê A4
                </Button>
              ) : null}

              {isManager &&
              ['PENDING_APPROVAL', 'APPROVED_PENDING_PAYOUT'].includes(effectiveDepositStatus) &&
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

              {effectiveDepositStatus === 'DISPUTED' &&
              settlementDeposit &&
              canResolveDisputeRow(settlementDetail || settlementDeposit) ? (
                <Button
                  variant="primary"
                  icon={MessageSquareWarning}
                  onClick={() => handleOpenResolveDispute(settlementDeposit)}
                >
                  Giải quyết khiếu nại
                </Button>
              ) : null}

              {canExecuteDepositPayout &&
              settlementDeposit &&
              ['APPROVED_PENDING_PAYOUT', 'RETURNED'].includes(effectiveDepositStatus) &&
              Number(readonlySettlementData?.refund_amount || 0) > 0 ? (
                <Button
                  variant="outline"
                  icon={Landmark}
                  onClick={() => handleOpenBankUpdateModal(settlementDeposit, readonlySettlementData)}
                >
                  Cập nhật TK nhận cọc
                </Button>
              ) : null}

              {canExecuteDepositPayout &&
              settlementDeposit &&
              ['REFUNDED', 'PARTIALLY_REFUNDED'].includes(effectiveDepositStatus) &&
              Number(readonlySettlementData?.refund_amount || 0) > 0 ? (
                <Button
                  variant="outline"
                  icon={RotateCcw}
                  className="text-amber-700 border-amber-200 hover:bg-amber-50"
                  onClick={() => handleOpenReturnedModal(settlementDeposit)}
                >
                  Ngân hàng trả lại (RETURNED)
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

              {canApproveCurrentModal &&
              ['PENDING_APPROVAL', 'APPROVED_PENDING_PAYOUT'].includes(effectiveDepositStatus) &&
              !readonlySettlementData?.accounting_committed_at ? (
                <Button
                  variant="danger"
                  icon={XCircle}
                  onClick={() => {
                    rejectIdemKeyRef.current = createIdempotencyKey();
                    setRejectReason('');
                    setRejectModalOpen(true);
                  }}
                >
                  Từ chối biên bản
                </Button>
              ) : null}

              {canApproveCurrentModal && effectiveDepositStatus === 'PENDING_APPROVAL' ? (
                <Button
                  variant="success"
                  icon={ShieldCheck}
                  disabled={isSnapshotStale}
                  onClick={() => {
                    approveIdemKeyRef.current = createIdempotencyKey();
                    setApproveConfirmOpen(true);
                  }}
                >
                  Phê duyệt bảng kê
                </Button>
              ) : canApproveDepositRefund &&
                isSysAdmin &&
                effectiveBuildingHasActiveOwner &&
                effectiveDepositStatus === 'PENDING_APPROVAL' ? (
                <span className="text-xs font-medium text-slate-600 bg-slate-100 border border-slate-200 px-2.5 py-1.5 rounded-lg">
                  Tòa nhà có Chủ nhà hoạt động — SYS_ADMIN chỉ xem (PRD 6.2)
                </span>
              ) : canApproveDepositRefund &&
                isSettlementCreator &&
                !allowSelfApproval &&
                effectiveDepositStatus === 'PENDING_APPROVAL' ? (
                <span className="text-xs font-medium text-amber-700 bg-amber-50 border border-amber-200 px-2.5 py-1.5 rounded-lg">
                  Chờ Chủ nhà / Quản lý khác phê duyệt (Four-Eyes)
                </span>
              ) : null}

              {canExecuteDepositPayout &&
              settlementDeposit &&
              ['APPROVED_PENDING_PAYOUT', 'RETURNED'].includes(effectiveDepositStatus) &&
              Number(readonlySettlementData?.refund_amount || 0) > 0 ? (
                <Button
                  variant="success"
                  icon={Banknote}
                  disabled={isSnapshotStale}
                  onClick={() => handleOpenPayoutModal(settlementDeposit)}
                >
                  {effectiveDepositStatus === 'RETURNED'
                    ? 'Phát hành lại lệnh chi (UNC)'
                    : 'Thực hiện chi hoàn (UNC)'}
                </Button>
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
                      {!isInspectionSatisfied ? (
                        <li>
                          Chưa có biên bản nghiệm thu bàn giao căn hộ có ảnh chụp hiện trạng — vui lòng nghiệm thu phòng hoặc tải lên ít nhất 01 ảnh biên bản kiểm tra ngay bên dưới.
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
                  {(settlementDetail?.apartment_id || settlementDeposit?.apartment_id) &&
                  !isInspectionSatisfied ? (
                    <Button
                      variant="outline"
                      size="xs"
                      rightIcon={ExternalLink}
                      onClick={() => {
                        setSettlementOpen(false);
                        navigate(
                          `/admin/apartments/${
                            settlementDetail?.apartment_id || settlementDeposit?.apartment_id
                          }`
                        );
                      }}
                    >
                      Nghiệm thu tại trang Căn hộ
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

            {/* Hạng mục 0: Biên bản nghiệm thu bàn giao phòng */}
            <div className="p-4 rounded-xl border border-slate-200 bg-slate-50/70 space-y-3">
              <div className="flex items-center justify-between flex-wrap gap-2">
                <h4 className="text-sm font-semibold text-slate-900">
                  Biên bản kiểm tra &amp; Nghiệm thu bàn giao căn hộ
                </h4>
                {settlementPreconditions?.apartment_inspected ? (
                  <Badge variant="emerald" dot>
                    Đã nghiệm thu phòng
                    {settlementPreconditions.handover_recorded_at
                      ? ` (${formatDateTime(settlementPreconditions.handover_recorded_at)})`
                      : ''}
                  </Badge>
                ) : inspectionEvidence.length > 0 ? (
                  <Badge variant="sky" dot>
                    Đã đính kèm {inspectionEvidence.length} ảnh biên bản kiểm tra
                  </Badge>
                ) : (
                  <Badge variant="amber" dot>
                    Chưa có ảnh nghiệm thu bàn giao
                  </Badge>
                )}
              </div>
              <FileUpload
                label={
                  settlementPreconditions?.apartment_inspected
                    ? 'Ảnh biên bản kiểm tra bàn giao bổ sung (tùy chọn)'
                    : 'Ảnh biên bản kiểm tra bàn giao căn hộ (Bắt buộc ≥ 1 ảnh nếu chưa nghiệm thu căn hộ)'
                }
                multiple
                maxFiles={5}
                value={inspectionEvidence}
                onChange={setInspectionEvidence}
                hint="Đính kèm ảnh biên bản bàn giao có chữ ký hoặc ảnh chụp hiện trạng phòng khi nhận lại từ cư dân"
              />
            </div>

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
                        <MoneyInput
                          label="Số tiền khấu trừ (VND)"
                          required
                          placeholder="VD: 500.000"
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
                  {Array.isArray(settlementDetail?.open_invoices) && settlementDetail.open_invoices.length > 0 ? (
                    <div className="pt-2 border-t border-slate-200 space-y-1.5">
                      <p className="font-semibold text-slate-700">
                        Chi tiết hóa đơn còn nợ ({settlementDetail.open_invoices.length}):
                      </p>
                      {settlementDetail.open_invoices.map((inv) => (
                        <div
                          key={inv.id}
                          className="p-2 rounded-lg bg-white border border-slate-200 flex items-center justify-between gap-2 text-[11px]"
                        >
                          <div>
                            <Link
                              to={`/admin/invoices/${inv.id}`}
                              onClick={() => setSettlementOpen(false)}
                              className="font-mono font-semibold text-primary-600 hover:underline"
                            >
                              {inv.invoice_code} (Kỳ {inv.period})
                            </Link>
                            <p className="text-slate-500">
                              Dịch vụ: {formatMoney(inv.service_unpaid)} • Thuê: {formatMoney(inv.rent_unpaid)}
                            </p>
                          </div>
                          <span className="font-mono font-bold text-rose-600 shrink-0">
                            {formatMoney(inv.remaining)}
                          </span>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
                <Select
                  label="Phương thức hoàn trả tiền cọc"
                  value={refundMethod}
                  onChange={(e) => setRefundMethod(e.target.value)}
                  options={PAYMENT_METHOD_OPTIONS}
                />
                {refundMethod === 'BANK_TRANSFER' ? (
                  <div className="grid grid-cols-1 gap-2.5 pt-1">
                    <BankSelect
                      label="Ngân hàng thụ hưởng của cư dân (VietQR)"
                      required={liveCalc.refundAmount > 0}
                      placeholder="-- Chọn ngân hàng thụ hưởng --"
                      value={bankInfo.bank_name}
                      bankMeta={{
                        bank_code: bankInfo.bank_code,
                        bank_bin: bankInfo.bank_bin,
                        bank_logo: bankInfo.bank_logo,
                      }}
                      onBankChange={(val, chosen) =>
                        setBankInfo((p) => ({
                          ...p,
                          bank_name: val,
                          bank_code: chosen?.code || '',
                          bank_bin: chosen?.bin || '',
                          bank_logo: chosen?.logo || '',
                        }))
                      }
                    />
                    <div className="grid grid-cols-2 gap-2.5">
                      <Input
                        label="Số tài khoản"
                        required={liveCalc.refundAmount > 0}
                        placeholder="Số TK nhận hoàn cọc"
                        value={bankInfo.account_number}
                        onChange={(e) =>
                          setBankInfo((p) => ({ ...p, account_number: e.target.value }))
                        }
                      />
                      <Input
                        label="Chủ tài khoản"
                        required={liveCalc.refundAmount > 0}
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
                      Tổng khấu trừ &amp; công nợ vượt số cọc đang giữ. Khi phê duyệt / chi hoàn tất toán, hệ thống tự động tạo khoản phải thu sau trả phòng (<code>RECEIVABLE_AFTER_MOVE_OUT</code>).
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

            {effectiveDepositStatus === 'APPROVED_PENDING_PAYOUT' ? (
              <div className="p-4 rounded-xl bg-indigo-50 border border-indigo-200 text-xs text-indigo-900 space-y-1">
                <p className="font-bold text-sm">
                  Đã phê duyệt bảng kê (APPROVED_PENDING_PAYOUT) — Chờ Ban Quản Lý thực hiện chi hoàn &amp; tải chứng từ UNC
                </p>
                <p>
                  Số dư cọc vẫn được bảo lưu nguyên vẹn trên sổ cái cho tới khi BQL hoàn tất chuyển khoản và đính kèm chứng từ UNC.
                </p>
              </div>
            ) : null}

            {effectiveDepositStatus === 'RETURNED' ? (
              <div className="p-4 rounded-xl bg-amber-50 border border-amber-300 text-xs text-amber-900 space-y-1">
                <p className="font-bold text-sm">
                  Ngân hàng hoàn trả lệnh chi (RETURNED) — Chờ cập nhật tài khoản &amp; phát hành lại UNC
                </p>
                {readonlySettlementData?.return_reason ? (
                  <p>
                    <strong>Lý do hoàn trả:</strong> {readonlySettlementData.return_reason}
                  </p>
                ) : null}
              </div>
            ) : null}

            {isSnapshotStale ? (
              <div className="p-4 rounded-xl bg-amber-50 border border-amber-300 flex items-start gap-2.5 text-xs text-amber-900">
                <AlertTriangle className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
                <div>
                  <p className="font-bold text-sm">
                    Dữ liệu công nợ / số dư cọc đã biến động kể từ khi trình duyệt!
                  </p>
                  <p className="mt-1">
                    Hóa đơn mở hoặc tiền cọc bảo lưu hiện tại không còn khớp với bản chụp lúc lập biên bản. Nút{' '}
                    <strong>Phê duyệt / Chi hoàn</strong> đã được khóa an toàn — vui lòng bấm{' '}
                    <strong>Từ chối biên bản</strong> để Quản lý tòa nhà cập nhật lại bảng kê mới nhất.
                  </p>
                </div>
              </div>
            ) : null}

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
                            {msg.role === 'RESIDENT' ? 'Cư dân khiếu nại' : `BQL / Chủ nhà (${msg.role || 'ADMIN'})`}
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
                {readonlySettlementData.rejection_reason ? (
                  <div className="p-3.5 rounded-xl bg-rose-50 border border-rose-200 text-xs text-rose-800">
                    <p className="font-semibold">Lý do từ chối phê duyệt gần nhất:</p>
                    <p className="mt-1 whitespace-pre-line">{readonlySettlementData.rejection_reason}</p>
                  </div>
                ) : null}

                {Array.isArray(readonlySettlementData.inspection_evidence) &&
                readonlySettlementData.inspection_evidence.length > 0 ? (
                  <div className="p-3.5 rounded-xl border border-slate-200 bg-white space-y-2 text-xs">
                    <p className="font-semibold text-slate-800">
                      Ảnh biên bản kiểm tra bàn giao căn hộ ({readonlySettlementData.inspection_evidence.length})
                    </p>
                    <div className="flex flex-wrap gap-2">
                      {readonlySettlementData.inspection_evidence.map((ev, idx) => (
                        <div
                          key={idx}
                          onClick={() => setPreviewImg(ev)}
                          className="w-16 h-16 rounded-lg border border-slate-200 overflow-hidden cursor-pointer hover:border-primary-400"
                        >
                          <AuthImage src={ev} alt="Biên bản bàn giao" className="w-full h-full object-cover" />
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}

                {Array.isArray(settlementDetail?.open_invoices) && settlementDetail.open_invoices.length > 0 ? (
                  <div className="p-3.5 rounded-xl bg-amber-50/60 border border-amber-200 space-y-1.5 text-xs">
                    <p className="font-semibold text-amber-900">
                      Hóa đơn chưa thanh toán của hợp đồng ({settlementDetail.open_invoices.length}):
                    </p>
                    {settlementDetail.open_invoices.map((inv) => (
                      <div key={inv.id} className="flex items-center justify-between gap-2 text-amber-900">
                        <Link
                          to={`/admin/invoices/${inv.id}`}
                          onClick={() => setSettlementOpen(false)}
                          className="font-mono font-semibold text-primary-700 hover:underline"
                        >
                          {inv.invoice_code} (Kỳ {inv.period})
                        </Link>
                        <span>
                          Dịch vụ: <strong>{formatMoney(inv.service_unpaid)}</strong> • Thuê:{' '}
                          <strong>{formatMoney(inv.rent_unpaid)}</strong>
                        </span>
                      </div>
                    ))}
                  </div>
                ) : null}

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
                {(() => {
                  const isFinalized = ['REFUNDED', 'PARTIALLY_REFUNDED', 'DEDUCTED_FULL'].includes(
                    effectiveDepositStatus
                  );
                  const heldBefore = Number(
                    readonlySettlementData.deposit_held_before_settlement ??
                      settlementDetail?.amount_held ??
                      settlementDeposit?.amount_held ??
                      0
                  );
                  const readonlyItemsSum = (readonlySettlementData.items || []).reduce(
                    (s, it) => s + Math.max(0, Number(it.amount || 0)),
                    0
                  );
                  const readonlyRentDebt = Math.max(
                    0,
                    Number(
                      readonlySettlementData.rent_debt ??
                        settlementDetail?.calculated_rent_debt ??
                        0
                    )
                  );
                  return (
                    <div className="p-4 rounded-xl bg-sky-50/60 border border-sky-200 space-y-2 text-xs">
                      <div className="flex justify-between text-slate-700">
                        <span>Tiền đặt cọc bảo lưu trước tất toán:</span>
                        <strong>{formatMoney(heldBefore)}</strong>
                      </div>
                      <div className="flex justify-between text-slate-700">
                        <span>Tổng khấu trừ biên bản bàn giao:</span>
                        <strong className="text-amber-700">
                          - {formatMoney(readonlyItemsSum)}
                        </strong>
                      </div>
                      <div className="flex justify-between text-slate-700">
                        <span>Công nợ dịch vụ / điện nước (đối trừ vào cọc):</span>
                        <strong className="text-amber-700">
                          - {formatMoney(readonlySettlementData.outstanding_debt || 0)}
                        </strong>
                      </div>
                      {readonlyRentDebt > 0 ? (
                        <div className="flex justify-between text-slate-600 italic">
                          <span>Công nợ tiền thuê (KHÔNG trừ vào cọc — thanh toán riêng):</span>
                          <strong className="text-rose-600">
                            {formatMoney(readonlyRentDebt)}
                          </strong>
                        </div>
                      ) : null}
                      <div className="flex justify-between text-slate-700 pt-1 border-t border-sky-200/70">
                        <span>Phương thức hoàn trả:</span>
                        <strong>
                          {readonlySettlementData.refund_method === 'CASH'
                            ? 'Tiền mặt (CASH)'
                            : 'Chuyển khoản ngân hàng (BANK_TRANSFER)'}
                        </strong>
                      </div>
                      {readonlySettlementData.bank_info?.account_number ? (
                        <div className="flex justify-between items-center gap-2 text-slate-700">
                          <span>Tài khoản nhận hoàn cọc:</span>
                          <strong className="inline-flex items-center gap-1.5 text-right">
                            {readonlySettlementData.bank_info.bank_logo ? (
                              <img
                                src={readonlySettlementData.bank_info.bank_logo}
                                alt=""
                                className="w-6 h-4 object-contain rounded bg-white border border-slate-200 shrink-0"
                              />
                            ) : null}
                            <span>
                              {readonlySettlementData.bank_info.bank_name}
                              {readonlySettlementData.bank_info.bank_code
                                ? ` (${readonlySettlementData.bank_info.bank_code})`
                                : ''}{' '}
                              • {readonlySettlementData.bank_info.account_number} (
                              {readonlySettlementData.bank_info.account_holder})
                            </span>
                          </strong>
                        </div>
                      ) : null}
                      {readonlySettlementData.payout_reference_code ? (
                        <div className="flex justify-between text-slate-700">
                          <span>Mã tham chiếu Ủy nhiệm chi (UNC):</span>
                          <strong className="font-mono text-indigo-700">
                            {readonlySettlementData.payout_reference_code}
                          </strong>
                        </div>
                      ) : null}
                      {Array.isArray(readonlySettlementData.payout_evidence) &&
                      readonlySettlementData.payout_evidence.length > 0 ? (
                        <div className="pt-1 space-y-1.5">
                          <span className="text-slate-700 font-medium block">
                            Chứng từ Ủy nhiệm chi (UNC) đã thực hiện:
                          </span>
                          <div className="flex flex-wrap gap-2">
                            {readonlySettlementData.payout_evidence.map((ev, pIdx) => (
                              <div
                                key={pIdx}
                                onClick={() => setPreviewImg(ev)}
                                className="w-16 h-16 rounded-lg border border-sky-200 overflow-hidden cursor-pointer hover:border-primary-500"
                              >
                                <AuthImage src={ev} alt="Chứng từ UNC" className="w-full h-full object-cover" />
                              </div>
                            ))}
                          </div>
                        </div>
                      ) : null}
                      <div className="border-t border-sky-200 pt-2.5 flex justify-between items-center text-sm">
                        <span className="font-bold text-slate-900">
                          {isFinalized ? 'Số tiền hoàn trả thực tế:' : 'Số tiền hoàn trả dự kiến:'}
                        </span>
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
                  );
                })()}
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

      {/* Confirm OWNER phê duyệt bảng kê tất toán */}
      <ConfirmDialog
        open={approveConfirmOpen}
        onClose={() => setApproveConfirmOpen(false)}
        onConfirm={handleConfirmApproveSettlement}
        loading={approvingSettlement}
        variant="success"
        title="Phê duyệt bảng kê tất toán tiền cọc"
        confirmLabel="Xác nhận phê duyệt"
        message={
          settlementDeposit
            ? Number(readonlySettlementData?.refund_amount || 0) > 0
              ? `Xác nhận phê duyệt bảng kê tất toán cọc cho căn hộ ${
                  settlementDeposit.apartment_code
                } với số tiền hoàn dự kiến ${formatMoney(
                  readonlySettlementData?.refund_amount || 0
                )}? Hồ sơ sẽ chuyển sang trạng thái APPROVED_PENDING_PAYOUT để Ban Quản Lý chuyển khoản và tải chứng từ UNC.`
              : `Xác nhận phê duyệt tất toán cọc cho căn hộ ${settlementDeposit.apartment_code} (hoàn trả 0 ₫)? Hệ thống sẽ hạch toán đối trừ công nợ ngay lập tức.`
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
        subtitle="Hồ sơ sẽ chuyển sang trạng thái DISPUTED và tạm khóa phê duyệt / chi hoàn cọc cho đến khi giải quyết xong"
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
                  isResolveAccountingCommitted
                    ? 'Không thể mở lại sửa bảng kê vì tiền cọc đã được hạch toán đối trừ / chi trả'
                    : 'Đưa sổ cọc về trạng thái SETTLEMENT_DRAFT để chỉnh sửa lại bảng kê khấu trừ'
                }
              >
                <Button
                  variant="outline"
                  loading={resolvingAction === 'ADJUST'}
                  disabled={isResolveAccountingCommitted || Boolean(resolvingAction)}
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

            {isResolveAccountingCommitted ? (
              <div className="p-3 rounded-xl bg-amber-50 border border-amber-200 text-xs text-amber-800">
                Lưu ý: Sổ cọc này đã thực hiện hạch toán đối trừ / chi trả nên nút{' '}
                <strong>Mở lại sửa bảng kê</strong> bị vô hiệu hóa để bảo toàn sổ cái bất biến. Bạn chỉ có thể ghi nhận giải trình và{' '}
                <strong>Xác nhận kết quả</strong> (đóng chu kỳ khiếu nại cuối cùng).
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

      {/* Modal Thực hiện chi hoàn tiền cọc có chứng từ UNC (Phase 2 — MANAGER) */}
      <Modal
        open={payoutModalOpen}
        onClose={() => {
          if (!submittingPayout) setPayoutModalOpen(false);
        }}
        title={
          payoutTarget
            ? `${
                payoutTarget.status === 'RETURNED'
                  ? 'Phát hành lại lệnh chi hoàn cọc'
                  : 'Thực hiện chi hoàn tiền cọc (UNC)'
              } — Căn ${payoutTarget.apartment_code}`
            : 'Thực hiện chi hoàn tiền cọc'
        }
        subtitle="Ghi nhận chuyển khoản hoàn tiền đặt cọc thực tế kèm chứng từ Ủy nhiệm chi (UNC)"
        size="md"
        footer={
          <>
            <Button
              variant="outline"
              onClick={() => setPayoutModalOpen(false)}
              disabled={submittingPayout}
            >
              Hủy
            </Button>
            <Button
              variant="success"
              icon={Banknote}
              loading={submittingPayout}
              disabled={loadingPayoutDetail || isPayoutSnapshotStale}
              onClick={handleSubmitPayout}
            >
              Xác nhận đã chi hoàn
            </Button>
          </>
        }
      >
        {loadingPayoutDetail ? (
          <LoadingSpinner label="Đang kiểm tra đối soát công nợ & thông tin thụ hưởng..." />
        ) : (
          <form onSubmit={handleSubmitPayout} className="space-y-4">
            {isPayoutSnapshotStale ? (
              <div className="p-3.5 rounded-xl bg-amber-50 border border-amber-300 text-xs text-amber-900">
                <p className="font-bold">
                  Công nợ hoặc số dư cọc đã biến động kể từ khi duyệt bảng kê!
                </p>
                <p className="mt-1">
                  Không thể chi hoàn trên bản chụp cũ. Vui lòng từ chối biên bản để tính lại số tiền hoàn trả chính xác.
                </p>
              </div>
            ) : null}

            <div className="p-3.5 rounded-xl bg-emerald-50/70 border border-emerald-200 space-y-1.5 text-xs">
              <div className="flex justify-between items-center">
                <span className="text-slate-700 font-medium">Số tiền thực chi hoàn cho cư dân:</span>
                <strong className="text-base font-bold text-emerald-700">
                  {formatMoney(payoutSettlementData?.refund_amount || 0)}
                </strong>
              </div>
              <div className="flex justify-between items-center text-slate-600">
                <span>Phương thức hoàn trả:</span>
                <strong>
                  {payoutSettlementData?.refund_method === 'CASH'
                    ? 'Tiền mặt (CASH)'
                    : 'Chuyển khoản ngân hàng (BANK_TRANSFER)'}
                </strong>
              </div>
              {payoutSettlementData?.bank_info?.account_number ? (
                <div className="pt-1 border-t border-emerald-200/80 flex items-center justify-between gap-2 text-slate-700">
                  <span>Tài khoản thụ hưởng:</span>
                  <strong className="text-right">
                    {payoutSettlementData.bank_info.bank_name} •{' '}
                    {payoutSettlementData.bank_info.account_number} (
                    {payoutSettlementData.bank_info.account_holder})
                  </strong>
                </div>
              ) : null}
            </div>

            <FileUpload
              label={
                (payoutSettlementData?.refund_method || 'BANK_TRANSFER') === 'BANK_TRANSFER'
                  ? 'Ảnh chứng từ Ủy nhiệm chi / Biên lai chuyển khoản (Bắt buộc ≥ 1 ảnh)'
                  : 'Ảnh phiếu chi tiền mặt có chữ ký cư dân (Khuyến nghị)'
              }
              multiple
              maxFiles={3}
              value={payoutForm.evidence}
              onChange={(vals) => setPayoutForm((p) => ({ ...p, evidence: vals }))}
            />

            <Input
              label="Mã giao dịch ngân hàng / Số UNC"
              placeholder="VD: FT26306123456789"
              value={payoutForm.reference_code}
              onChange={(e) => setPayoutForm((p) => ({ ...p, reference_code: e.target.value }))}
            />

            <Input
              label="Ghi chú chi hoàn (tùy chọn)"
              multiline
              rows={2}
              placeholder="Ghi chú bổ sung trên bút toán chi hoàn..."
              value={payoutForm.note}
              onChange={(e) => setPayoutForm((p) => ({ ...p, note: e.target.value }))}
            />
          </form>
        )}
      </Modal>

      {/* Modal Ghi nhận Ngân hàng trả lại lệnh chi (RETURNED — Phase 2) */}
      <Modal
        open={returnedModalOpen}
        onClose={() => {
          if (!submittingReturned) setReturnedModalOpen(false);
        }}
        title={
          returnedTarget
            ? `Ghi nhận hoàn trả lệnh chi — Căn ${returnedTarget.apartment_code}`
            : 'Ngân hàng trả lại giao dịch hoàn cọc'
        }
        subtitle="Tạo bút toán đảo dương (refund_reversal) bất biến, khôi phục số dư chờ chi và thông báo cư dân cập nhật tài khoản"
        size="sm"
        footer={
          <>
            <Button
              variant="outline"
              onClick={() => setReturnedModalOpen(false)}
              disabled={submittingReturned}
            >
              Hủy
            </Button>
            <Button
              variant="primary"
              icon={RotateCcw}
              loading={submittingReturned}
              onClick={handleSubmitReturned}
            >
              Xác nhận hoàn trả lệnh chi
            </Button>
          </>
        }
      >
        <form onSubmit={handleSubmitReturned} className="space-y-3.5">
          <Input
            label="Lý do ngân hàng từ chối / hoàn trả lệnh chi"
            required
            multiline
            rows={3}
            placeholder="VD: Sai tên chủ tài khoản thụ hưởng / Tài khoản đã đóng..."
            value={returnedForm.reason}
            onChange={(e) => setReturnedForm((p) => ({ ...p, reason: e.target.value }))}
          />
          <Input
            label="Mã giao dịch hoàn trả ngân hàng (nếu có)"
            placeholder="VD: REV-FT26306999"
            value={returnedForm.reference_code}
            onChange={(e) => setReturnedForm((p) => ({ ...p, reference_code: e.target.value }))}
          />
        </form>
      </Modal>

      {/* Modal Cập nhật Tài khoản nhận hoàn cọc (APPROVED_PENDING_PAYOUT / RETURNED — Phase 2) */}
      <Modal
        open={bankUpdateModalOpen}
        onClose={() => {
          if (!submittingBankUpdate) setBankUpdateModalOpen(false);
        }}
        title={
          bankUpdateTarget
            ? `Cập nhật TK nhận hoàn cọc — Căn ${bankUpdateTarget.apartment_code}`
            : 'Cập nhật tài khoản thụ hưởng hoàn cọc'
        }
        subtitle="Chỉ cập nhật thông tin ngân hàng thụ hưởng mà không làm thay đổi công thức hay số tiền tất toán đã duyệt"
        size="md"
        footer={
          <>
            <Button
              variant="outline"
              onClick={() => setBankUpdateModalOpen(false)}
              disabled={submittingBankUpdate}
            >
              Hủy
            </Button>
            <Button
              variant="primary"
              icon={Landmark}
              loading={submittingBankUpdate}
              onClick={handleSubmitBankUpdate}
            >
              Lưu tài khoản thụ hưởng
            </Button>
          </>
        }
      >
        <form onSubmit={handleSubmitBankUpdate} className="space-y-3.5">
          <BankSelect
            label="Ngân hàng thụ hưởng (VietQR)"
            required
            placeholder="-- Chọn ngân hàng thụ hưởng --"
            value={bankUpdateForm.bank_name}
            bankMeta={{
              bank_code: bankUpdateForm.bank_code,
              bank_bin: bankUpdateForm.bank_bin,
              bank_logo: bankUpdateForm.bank_logo,
            }}
            onBankChange={(val, chosen) =>
              setBankUpdateForm((p) => ({
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
              value={bankUpdateForm.account_number}
              onChange={(e) =>
                setBankUpdateForm((p) => ({ ...p, account_number: e.target.value }))
              }
            />
            <Input
              label="Chủ tài khoản"
              required
              placeholder="Họ tên in hoa"
              value={bankUpdateForm.account_holder}
              onChange={(e) =>
                setBankUpdateForm((p) => ({ ...p, account_holder: e.target.value }))
              }
            />
          </div>
        </form>
      </Modal>
    </div>
  );
}

export default DepositsPage;
