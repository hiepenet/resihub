import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import {
  FileText,
  Printer,
  CheckCircle2,
  XCircle,
  RefreshCw,
  ArrowRightLeft,
  FilePlus2,
  Users,
  UserPlus,
  Trash2,
  Edit3,
  History,
  Building2,
  User,
  AlertTriangle,
  ZoomIn,
  ExternalLink,
  Plus,
  ShieldCheck,
  Clock,
  Calendar,
  Sparkles,
} from 'lucide-react';
import { Button } from '../../../components/ui/Button';
import { Input } from '../../../components/ui/Input';
import { MoneyInput } from '../../../components/ui/MoneyInput';
import { Select } from '../../../components/ui/Select';
import { Modal } from '../../../components/ui/Modal';
import { Badge } from '../../../components/ui/Badge';
import { Card, CardHeader } from '../../../components/ui/Card';
import { Tabs } from '../../../components/ui/Tabs';
import { FileUpload, AuthImage, AuthPdfViewer } from '../../../components/ui/FileUpload';
import { PageHeader } from '../../../components/common/PageHeader';
import { StatusBadge } from '../../../components/common/StatusBadge';
import { DataTable } from '../../../components/common/DataTable';
import { ConfirmDialog } from '../../../components/common/ConfirmDialog';
import { EmptyState } from '../../../components/common/EmptyState';
import { LoadingSpinner } from '../../../components/common/LoadingSpinner';
import {
  ServiceSubscriptionMetaFields,
  VehiclePlatesBadges,
} from '../../../components/common/ServiceSubscriptionMetaFields';
import { contractsService, createIdempotencyKey } from '../../../services/contracts.service';
import {
  MAX_PARKING_QUANTITY,
  isParkingService,
  allowsMultiQuantity,
  syncVehiclePlatesArray,
  validateServiceMetaInput,
} from '../../../utils/serviceSubscriptionMeta';
import { buildingsService } from '../../../services/buildings.service';
import { tenantsService } from '../../../services/tenants.service';
import { servicesService } from '../../../services/services.service';
import { usersService } from '../../../services/users.service';
import { paymentsService } from '../../../services/payments.service';
import { canActorApproveCreditRefund } from '../../../utils/billing';
import { usePermission } from '../../../hooks/usePermission';
import { useToast } from '../../../hooks/useToast';
import { formatMoney, formatDate, formatDateTime, toInputDate } from '../../../utils/format';
import {
  addDaysStr,
  addMonthsClampedStr,
  extractApartmentBusyIntervals,
  findFirstAvailableStartDate,
  findOverlappingBusyIntervals,
  formatBusyOverlapError,
  formatDateVi,
  getDateOrderError,
  maxDateStr,
  toDateOnlyStr,
} from '../../../utils/dateRange';
import {
  isValidPhone,
  normalizePhone,
  isValidEmail,
  isValidIdNumber,
  extractErrorMessage,
} from '../../../utils/validation';

const RELATIONSHIP_OPTIONS = [
  { value: 'family', label: 'Gia đình / Người thân' },
  { value: 'spouse', label: 'Vợ / Chồng' },
  { value: 'child', label: 'Con cái' },
  { value: 'roommate', label: 'Bạn cùng phòng' },
  { value: 'friend', label: 'Bạn bè' },
  { value: 'other', label: 'Khác' },
];

const SERVICE_CODE_OPTIONS = [
  { value: 'ELECTRICITY', label: 'Điện sinh hoạt (kWh)' },
  { value: 'WATER', label: 'Nước sinh hoạt (m³)' },
  { value: 'INTERNET', label: 'Internet / Wifi (INTERNET)' },
  { value: 'MOTORBIKE_PARKING', label: 'Gửi xe máy xăng (MOTORBIKE_PARKING)' },
  { value: 'ELECTRICBIKE_PARKING', label: 'Gửi xe đạp/máy điện (ELECTRICBIKE_PARKING)' },
  { value: 'TRASH', label: 'Phí thu gom rác (TRASH)' },
  { value: 'COMMON_SERVICE', label: 'Dịch vụ chung (COMMON_SERVICE)' },
];

const DIFF_FIELD_LABELS = {
  end_date: 'Ngày kết thúc',
  rent_amount: 'Giá thuê / tháng',
  deposit_amount: 'Tiền đặt cọc',
  note: 'Ghi chú',
};

function formatDiffVal(field, val) {
  if (val === null || val === undefined || val === '') return '—';
  if (field === 'rent_amount' || field === 'deposit_amount') return formatMoney(val);
  if (field === 'end_date') return formatDate(val);
  return String(val);
}

function addMonthsStr(dateStr, months) {
  return addMonthsClampedStr(dateStr, months);
}

function ContractTimeline({ status, isRoomTransfer = false }) {
  const terminalStep = useMemo(() => {
    if (status === 'RENEWAL_PENDING') {
      return { id: 'RENEWAL_PENDING', label: 'Chờ duyệt gia hạn', state: 'warning' };
    }
    if (status === 'TERMINATION_PENDING') {
      return { id: 'TERMINATION_PENDING', label: 'Chờ bàn giao chấm dứt', state: 'warning' };
    }
    if (status === 'TERMINATED') {
      return { id: 'TERMINATED', label: 'Đã thanh lý', state: 'danger' };
    }
    if (status === 'EXPIRED') {
      return { id: 'EXPIRED', label: 'Đã hết hạn', state: 'done' };
    }
    if (status === 'CANCELLED') {
      return { id: 'CANCELLED', label: 'Đã hủy nháp', state: 'danger' };
    }
    return { id: 'END', label: 'Gia hạn / Thanh lý', state: 'upcoming' };
  }, [status]);

  const steps = useMemo(() => {
    const rankMap = {
      DRAFT: 1,
      CANCELLED: 1,
      PENDING_APPROVAL: 2,
      ACTIVE: 3,
      RENEWAL_PENDING: 4,
      TERMINATION_PENDING: 4,
      TERMINATED: 4,
      EXPIRED: 4,
    };
    const r = rankMap[status] || 1;

    return [
      {
        key: 'DRAFT',
        label: '1. Bản nháp & Ký kết',
        desc: 'Tạo nháp & đính kèm bản scan',
        state: status === 'CANCELLED' ? 'danger' : r > 1 ? 'done' : 'active',
      },
      {
        key: 'PENDING_APPROVAL',
        label: isRoomTransfer ? '2. Phê duyệt đổi phòng' : '2. Phê duyệt giá',
        desc: isRoomTransfer
          ? 'Chủ sở hữu duyệt đổi phòng & kết chuyển cọc'
          : 'Chủ sở hữu tòa nhà duyệt nếu giảm > 10%',
        state:
          status === 'PENDING_APPROVAL'
            ? 'warning'
            : r > 2
            ? 'done'
            : 'upcoming',
      },
      {
        key: 'ACTIVE',
        label: '3. Đang hiệu lực',
        desc: 'Bàn giao căn & mở sổ cọc',
        state: status === 'ACTIVE' ? 'active' : r > 3 ? 'done' : 'upcoming',
      },
      {
        key: terminalStep.id,
        label: `4. ${terminalStep.label}`,
        desc: 'Kết thúc kỳ hạn / biến động',
        state: terminalStep.state,
      },
    ];
  }, [status, terminalStep, isRoomTransfer]);

  const styleByState = {
    done: {
      circle: 'bg-emerald-500 text-white border-emerald-500',
      title: 'text-emerald-700 font-semibold',
      bar: 'bg-emerald-400',
    },
    active: {
      circle: 'bg-primary-500 text-white border-primary-500 ring-4 ring-primary-100',
      title: 'text-primary-700 font-bold',
      bar: 'bg-slate-200',
    },
    warning: {
      circle: 'bg-amber-500 text-white border-amber-500 ring-4 ring-amber-100',
      title: 'text-amber-700 font-bold',
      bar: 'bg-slate-200',
    },
    danger: {
      circle: 'bg-rose-500 text-white border-rose-500 ring-4 ring-rose-100',
      title: 'text-rose-700 font-bold',
      bar: 'bg-slate-200',
    },
    upcoming: {
      circle: 'bg-white text-slate-400 border-slate-300',
      title: 'text-slate-500 font-medium',
      bar: 'bg-slate-200',
    },
  };

  return (
    <Card className="p-5">
      <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
        {steps.map((step, idx) => {
          const st = styleByState[step.state] || styleByState.upcoming;
          return (
            <div key={step.key} className="relative flex sm:flex-col items-start gap-3 sm:gap-2">
              <div className="flex items-center w-full gap-2">
                <div
                  className={`w-7 h-7 rounded-full border-2 flex items-center justify-center text-xs font-bold shrink-0 transition-all ${st.circle}`}
                >
                  {step.state === 'done' ? <CheckCircle2 className="w-4 h-4" /> : idx + 1}
                </div>
                {idx < steps.length - 1 ? (
                  <div className={`hidden sm:block h-0.5 flex-1 rounded-full ${st.bar}`} />
                ) : null}
              </div>
              <div>
                <p className={`text-xs ${st.title}`}>{step.label}</p>
                <p className="text-[11px] text-slate-400 mt-0.5">{step.desc}</p>
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

export function ContractDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const {
    isSysAdmin,
    isOwner,
    isManager,
    canApproveContractAmendments,
    canTerminateContracts,
    user,
  } = usePermission();
  const currentUserId = user?.id || user?.sub;
  const canManageOps = isManager;

  const [contract, setContract] = useState(null);
  const [occupants, setOccupants] = useState([]);
  const [amendments, setAmendments] = useState([]);
  const [servicePrices, setServicePrices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState('overview');

  // Direct Credit Refund State (FR-040)
  const [creditRefundModalOpen, setCreditRefundModalOpen] = useState(false);
  const [selectedCredit, setSelectedCredit] = useState(null);
  const [creditRefundForm, setCreditRefundForm] = useState({
    amount: '',
    reason: '',
    bank_name: '',
    account_number: '',
    account_holder: '',
    proof_image: '',
  });
  const [submittingCreditRefund, setSubmittingCreditRefund] = useState(false);
  const [creditRejectModalOpen, setCreditRejectModalOpen] = useState(false);
  const [creditRejectionReason, setCreditRejectionReason] = useState('');
  const [submittingCreditReject, setSubmittingCreditReject] = useState(false);
  const [approvingCreditId, setApprovingCreditId] = useState(null);

  // Action loading states
  const [printing, setPrinting] = useState(false);
  const [uploadingScan, setUploadingScan] = useState(false);
  const [previewScanItem, setPreviewScanItem] = useState(null);

  // Confirm Dialogs (Activate / Approve / ApproveTermination)
  const [confirmState, setConfirmState] = useState({ open: false, type: '' });
  const [processingConfirm, setProcessingConfirm] = useState(false);
  const actionIdemKeyRef = useRef('');

  // Edit Draft Modal
  const [editDraftOpen, setEditDraftOpen] = useState(false);
  const [draftAptDetail, setDraftAptDetail] = useState(null);
  const [draftServiceCatalog, setDraftServiceCatalog] = useState([]);
  const [draftSelectedServices, setDraftSelectedServices] = useState({});
  const [draftServiceErrors, setDraftServiceErrors] = useState({});
  const [draftCustomMeterPrices, setDraftCustomMeterPrices] = useState({
    ELECTRICITY: '',
    WATER: '',
  });
  const [editDraftForm, setEditDraftForm] = useState({
    start_date: '',
    end_date: '',
    rent_amount: '',
    deposit_amount: '',
    billing_cycle: 'monthly',
    billing_day: '1',
    payment_due_days: '5',
    note: '',
  });
  const [savingDraft, setSavingDraft] = useState(false);

  // Cancel Draft Modal
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelReason, setCancelReason] = useState('');
  const [cancelling, setCancelling] = useState(false);

  // Renew Contract Modal
  const [renewOpen, setRenewOpen] = useState(false);
  const [renewForm, setRenewForm] = useState({
    new_end_date: '',
    rent_amount: '',
    deposit_amount: '',
    note: '',
  });
  const [submittingRenew, setSubmittingRenew] = useState(false);

  // Create Amendment Modal
  const [amendOpen, setAmendOpen] = useState(false);
  const [amendForm, setAmendForm] = useState({
    end_date: '',
    rent_amount: '',
    deposit_amount: '',
    note: '',
    effective_from: '',
    reason: '',
  });
  const [submittingAmend, setSubmittingAmend] = useState(false);

  // Reject Amendment Modal
  const [rejectAmendTarget, setRejectAmendTarget] = useState(null);
  const [rejectAmendReason, setRejectAmendReason] = useState('');
  const [submittingRejectAmend, setSubmittingRejectAmend] = useState(false);

  // Transfer Room Modal
  const [transferOpen, setTransferOpen] = useState(false);
  const [availableApts, setAvailableApts] = useState([]);
  const [loadingApts, setLoadingApts] = useState(false);
  const [transferAptDetail, setTransferAptDetail] = useState(null);
  const userEditedTransferDatesRef = useRef(false);
  const [transferForm, setTransferForm] = useState({
    new_apartment_id: '',
    new_start_date: '',
    new_end_date: '',
    new_rent_amount: '',
    new_deposit_amount: '',
    transfer_deposit: true,
    note: '',
  });
  const [submittingTransfer, setSubmittingTransfer] = useState(false);

  // Terminate Request Modal (MANAGER) & Reject Termination Modal (OWNER)
  const [terminateOpen, setTerminateOpen] = useState(false);
  const [terminateForm, setTerminateForm] = useState({
    terminated_date: '',
    reason: 'Thỏa thuận thanh lý hợp đồng trước hạn',
    note: '',
  });
  const [submittingTerminate, setSubmittingTerminate] = useState(false);

  const [rejectTermOpen, setRejectTermOpen] = useState(false);
  const [rejectTermReason, setRejectTermReason] = useState('');
  const [submittingRejectTerm, setSubmittingRejectTerm] = useState(false);

  // Reject PENDING_APPROVAL contract (return to DRAFT) + Four-eyes self-approval setting
  const [allowSelfApproval, setAllowSelfApproval] = useState(false);
  const [rejectPriceOpen, setRejectPriceOpen] = useState(false);
  const [rejectPriceReason, setRejectPriceReason] = useState('');
  const [submittingRejectPrice, setSubmittingRejectPrice] = useState(false);

  // Occupants Add / Remove
  const [occModalOpen, setOccModalOpen] = useState(false);
  const [occForm, setOccForm] = useState({
    full_name: '',
    phone: '',
    relationship: 'family',
    id_number: '',
    email: '',
    dob: '',
  });
  const [occErrors, setOccErrors] = useState({});
  const [submittingOcc, setSubmittingOcc] = useState(false);
  const [occDupInfo, setOccDupInfo] = useState({
    isDuplicate: false,
    inScope: true,
    duplicates: [],
    message: '',
  });
  const [occDupChecking, setOccDupChecking] = useState(false);
  const [removeOccTarget, setRemoveOccTarget] = useState(null);
  const [removingOcc, setRemovingOcc] = useState(false);

  // Kiểm tra trùng SĐT / CCCD realtime trên Modal Thêm thành viên cùng lưu trú (FR-021)
  useEffect(() => {
    if (!occModalOpen) {
      setOccDupInfo({ isDuplicate: false, inScope: true, duplicates: [], message: '' });
      setOccDupChecking(false);
      return undefined;
    }
    const cleanPhone = normalizePhone(occForm.phone);
    const cleanId = String(occForm.id_number || '').trim();
    const okPhone = isValidPhone(cleanPhone);
    const okId = isValidIdNumber(cleanId);

    if (!okPhone && !okId) {
      setOccDupInfo({ isDuplicate: false, inScope: true, duplicates: [], message: '' });
      setOccDupChecking(false);
      return undefined;
    }

    let cancelled = false;
    setOccDupChecking(true);
    const timer = setTimeout(async () => {
      try {
        const res = await tenantsService.checkDup({
          ...(okPhone ? { phone: cleanPhone } : {}),
          ...(okId ? { id_number: cleanId } : {}),
        });
        if (!cancelled) {
          setOccDupInfo({
            isDuplicate: Boolean(res?.isDuplicate),
            inScope: res?.inScope !== false,
            duplicates: Array.isArray(res?.duplicates) ? res.duplicates : [],
            message: res?.message || '',
          });
        }
      } catch {
        if (!cancelled) {
          setOccDupInfo({ isDuplicate: false, inScope: true, duplicates: [], message: '' });
        }
      } finally {
        if (!cancelled) setOccDupChecking(false);
      }
    }, 350);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [occModalOpen, occForm.phone, occForm.id_number]);

  // Service Prices Modal
  const [spModalOpen, setSpModalOpen] = useState(false);
  const [spForm, setSpForm] = useState({
    service_code: 'INTERNET',
    unit_price: '',
    effective_from: '',
  });
  const [submittingSp, setSubmittingSp] = useState(false);

  const handleOpenCreditRefundModal = (credit) => {
    const remaining = Math.max(
      0,
      Number(credit.amount || 0) - Number(credit.applied_amount || 0) - Number(credit.settlement_refund_amount || 0)
    );
    setSelectedCredit(credit);
    setCreditRefundForm({
      amount: String(remaining),
      reason: '',
      bank_name: contract?.tenant?.bank_name || '',
      account_number: contract?.tenant?.bank_account_no || '',
      account_holder: contract?.tenant?.bank_account_name || contract?.tenant?.full_name || '',
      proof_image: '',
    });
    setCreditRefundModalOpen(true);
  };

  const handleSubmitCreditRefund = async (e) => {
    e?.preventDefault?.();
    if (!selectedCredit) return;
    const numAmount = Number(creditRefundForm.amount);
    if (!numAmount || numAmount <= 0) {
      toast.warning('Vui lòng nhập số tiền hoàn trả hợp lệ (> 0).');
      return;
    }
    if (!creditRefundForm.reason.trim()) {
      toast.warning('Vui lòng nhập lý do hoàn tiền.');
      return;
    }
    setSubmittingCreditRefund(true);
    try {
      await paymentsService.requestCreditRefund(selectedCredit.id, {
        amount: numAmount,
        reason: creditRefundForm.reason.trim(),
        bank_info: {
          bank_name: creditRefundForm.bank_name.trim(),
          account_number: creditRefundForm.account_number.trim(),
          account_holder: creditRefundForm.account_holder.trim(),
        },
        proof_image: creditRefundForm.proof_image || undefined,
      });
      toast.success('Đã gửi đề nghị hoàn tiền tín dụng (chờ duyệt 4 mắt).');
      setCreditRefundModalOpen(false);
      await loadAll();
    } catch (err) {
      toast.error(extractErrorMessage(err, 'Không thể tạo đề nghị hoàn tiền tín dụng.'));
    } finally {
      setSubmittingCreditRefund(false);
    }
  };

  const handleApproveCreditRefund = async (credit) => {
    setApprovingCreditId(credit.id);
    try {
      await paymentsService.approveCreditRefund(credit.id);
      toast.success('Đã phê duyệt hoàn tiền tín dụng thành công.');
      await loadAll();
    } catch (err) {
      toast.error(extractErrorMessage(err, 'Không thể phê duyệt hoàn tiền.'));
    } finally {
      setApprovingCreditId(null);
    }
  };

  const handleOpenCreditRejectModal = (credit) => {
    setSelectedCredit(credit);
    setCreditRejectionReason('');
    setCreditRejectModalOpen(true);
  };

  const handleSubmitCreditReject = async () => {
    if (!selectedCredit) return;
    if (!creditRejectionReason.trim()) {
      toast.warning('Vui lòng nhập lý do từ chối.');
      return;
    }
    setSubmittingCreditReject(true);
    try {
      await paymentsService.rejectCreditRefund(selectedCredit.id, {
        rejection_reason: creditRejectionReason.trim(),
      });
      toast.success('Đã từ chối đề nghị hoàn tiền tín dụng.');
      setCreditRejectModalOpen(false);
      await loadAll();
    } catch (err) {
      toast.error(extractErrorMessage(err, 'Không thể từ chối đề nghị hoàn tiền.'));
    } finally {
      setSubmittingCreditReject(false);
    }
  };

  const loadAll = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    try {
      const [cRes, oRes, aRes, spRes, settingsRes] = await Promise.all([
        contractsService.getById(id),
        contractsService.listOccupants(id).catch(() => ({ data: [] })),
        contractsService.listAmendments(id).catch(() => ({ data: [] })),
        contractsService.listServicePrices(id).catch(() => ({ data: [] })),
        usersService.getSettings().catch(() => null),
      ]);
      setContract(cRes?.data || null);
      setOccupants(Array.isArray(oRes?.data) ? oRes.data : []);
      setAmendments(Array.isArray(aRes?.data) ? aRes.data : []);
      setServicePrices(Array.isArray(spRes?.data) ? spRes.data : []);
      setAllowSelfApproval(Boolean(settingsRes?.data?.approval_config?.allow_self_approval));
    } catch (err) {
      toast.error(extractErrorMessage(err, 'Không thể tải thông tin chi tiết hợp đồng.'));
    } finally {
      setLoading(false);
    }
  }, [id, toast]);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  const attachments = useMemo(
    () => (Array.isArray(contract?.attachments) ? contract.attachments : []),
    [contract]
  );
  const relatedContracts = useMemo(
    () => (Array.isArray(contract?.related_contracts) ? contract.related_contracts : []),
    [contract]
  );
  const serviceSubscriptions = useMemo(
    () => (Array.isArray(contract?.service_subscriptions) ? contract.service_subscriptions : []),
    [contract]
  );
  const invoiceSchedule = useMemo(
    () => (Array.isArray(contract?.invoice_schedule) ? contract.invoice_schedule : []),
    [contract]
  );
  const isContractDiscounted =
    Number(contract?.apartment_base_rent || 0) > 0 &&
    Number(contract?.rent_amount || 0) < Number(contract?.apartment_base_rent || 0) * 0.9;
  const canApprovePrice =
    isOwner ||
    (isSysAdmin && contract?.has_building_owner === false) ||
    (isManager &&
      Boolean(contract?.is_room_transfer) &&
      contract?.has_building_owner === false &&
      !isContractDiscounted);

  // Xem & In hợp đồng A4 chuẩn pháp lý
  const handlePrintA4 = async () => {
    const printWin = window.open('', '_blank');
    if (!printWin) {
      toast.warning('Trình duyệt đang chặn cửa sổ bật lên (Pop-up). Vui lòng cho phép mở tab mới để in hợp đồng.');
      return;
    }
    printWin.document.write(
      '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Đang tải mẫu hợp đồng A4...</title></head><body style="font-family:sans-serif;padding:40px;text-align:center;color:#334155;">Đang chuẩn bị bản in hợp đồng chuẩn A4...</body></html>'
    );

    setPrinting(true);
    try {
      const html = await contractsService.getTemplateHtml(id);
      printWin.document.open();
      printWin.document.write(html);
      printWin.document.close();
    } catch (err) {
      printWin.close();
      toast.error(extractErrorMessage(err, 'Không thể tải mẫu in hợp đồng A4.'));
    } finally {
      setPrinting(false);
    }
  };

  // Upload bản scan đã ký
  const handleUploadScan = async (base64Val) => {
    if (!base64Val) return;
    setUploadingScan(true);
    try {
      const res = await contractsService.uploadScan(id, {
        file_base64: base64Val,
        image_base64: base64Val,
      });
      toast.success(res?.message || 'Đã đính kèm bản scan hợp đồng thành công.');
      await loadAll();
    } catch (err) {
      toast.error(extractErrorMessage(err, 'Không thể tải lên bản scan hợp đồng.'));
    } finally {
      setUploadingScan(false);
    }
  };

  useEffect(() => {
    if (confirmState.open || renewOpen || transferOpen || terminateOpen) {
      actionIdemKeyRef.current = createIdempotencyKey();
    }
  }, [
    confirmState.open,
    confirmState.type,
    renewOpen,
    renewForm,
    transferOpen,
    transferForm,
    terminateOpen,
    terminateForm,
  ]);

  const selectableDraftServices = useMemo(
    () =>
      draftServiceCatalog.filter(
        (svc) =>
          svc.is_active !== false &&
          svc.billing_type !== 'METERED' &&
          (!svc.building_id ||
            !contract?.building_id ||
            String(svc.building_id) === String(contract.building_id))
      ),
    [draftServiceCatalog, contract?.building_id]
  );

  // Xử lý Kích hoạt / Phê duyệt giá / Phê duyệt chấm dứt
  const handleConfirmAction = async () => {
    const actionType = confirmState.type;
    if (!actionType) return;
    setProcessingConfirm(true);
    try {
      const idemOpts = { idempotencyKey: actionIdemKeyRef.current || createIdempotencyKey() };
      if (actionType === 'activate') {
        const res = await contractsService.activate(id, {}, idemOpts);
        toast.success(res?.message || 'Kích hoạt hợp đồng thành công!');
      } else if (actionType === 'approve') {
        const res = await contractsService.approve(id, {}, idemOpts);
        toast.success(res?.message || 'Đã phê duyệt và kích hoạt hợp đồng thành công!');
        const surplusAmt = Number(
          res?.surplus_deposit_amount ?? res?.data?.surplus_deposit_amount ?? 0
        );
        if (surplusAmt > 0) {
          toast.warning(
            `Sổ cọc căn cũ còn dư ${formatMoney(surplusAmt)} — vui lòng lập hồ sơ tất toán hoàn trả phần cọc dư cho cư dân đúng hạn.`
          );
        }
      } else if (actionType === 'approve_termination') {
        const res = await contractsService.approveTermination(id);
        toast.success(res?.message || 'Đã phê duyệt chấm dứt hợp đồng.');
      }
      setConfirmState({ open: false, type: '' });
      await loadAll();
    } catch (err) {
      const errCode = err?.response?.data?.code;
      if (errCode === 'PRICE_NEEDS_APPROVAL' || errCode === 'TRANSFER_NEEDS_APPROVAL') {
        // Backend đã commit chuyển hợp đồng sang PENDING_APPROVAL chờ Chủ sở hữu tòa nhà (OWNER) phê duyệt
        toast.warning(
          err?.response?.data?.message ||
            (errCode === 'TRANSFER_NEEDS_APPROVAL'
              ? 'Hợp đồng đổi phòng đã chuyển sang chờ Chủ sở hữu tòa nhà (OWNER) phê duyệt kết chuyển cọc.'
              : 'Giá thuê thấp hơn 90% giá niêm yết. Hợp đồng đã chuyển sang chờ Chủ sở hữu tòa nhà (OWNER) phê duyệt.')
        );
        setConfirmState({ open: false, type: '' });
        await loadAll();
      } else {
        toast.error(extractErrorMessage(err, 'Thao tác không thành công.'));
      }
    } finally {
      setProcessingConfirm(false);
    }
  };

  const todayStr = toDateOnlyStr(new Date());
  const contractStartStr = toDateOnlyStr(contract?.start_date);
  const contractEndStr = toDateOnlyStr(contract?.end_date);
  const minTerminateDate = useMemo(
    () => (contractStartStr && contractStartStr > todayStr ? todayStr : contractStartStr),
    [contractStartStr, todayStr]
  );

  // Tải lịch bận của căn hộ hiện tại khi sửa bản nháp (bỏ qua chính bản nháp đang sửa)
  useEffect(() => {
    if (!editDraftOpen || !contract?.apartment_id) {
      setDraftAptDetail(null);
      return undefined;
    }
    let cancelled = false;
    buildingsService
      .getApartment(contract.apartment_id)
      .then((res) => {
        if (!cancelled) setDraftAptDetail(res?.data || null);
      })
      .catch(() => {
        if (!cancelled) setDraftAptDetail(null);
      });
    return () => {
      cancelled = true;
    };
  }, [editDraftOpen, contract?.apartment_id]);

  // Tải lịch bận của căn hộ đích khi chuyển phòng & tự gợi ý ngày chuyển nằm ngoài khoảng bận
  useEffect(() => {
    if (!transferOpen || !transferForm.new_apartment_id) {
      setTransferAptDetail(null);
      return undefined;
    }
    let cancelled = false;
    const targetAptId = transferForm.new_apartment_id;
    buildingsService
      .getApartment(targetAptId)
      .then((res) => {
        if (cancelled) return;
        const detail = res?.data || null;
        setTransferAptDetail(detail);
        const busy = extractApartmentBusyIntervals(detail || {}, { todayStr });
        const freeStart = findFirstAvailableStartDate(todayStr, busy, { minSpanDays: 2 });
        if (freeStart) {
          setTransferForm((prev) => {
            if (String(prev.new_apartment_id) !== String(targetAptId)) return prev;
            const overlaps = findOverlappingBusyIntervals(
              prev.new_start_date,
              prev.new_end_date,
              busy
            );
            if (userEditedTransferDatesRef.current && overlaps.length === 0) return prev;
            const nextEnd =
              prev.new_end_date && prev.new_end_date > freeStart
                ? prev.new_end_date
                : addMonthsStr(freeStart, 12);
            return {
              ...prev,
              new_start_date: freeStart,
              new_end_date: nextEnd,
            };
          });
        }
      })
      .catch(() => {
        if (!cancelled) setTransferAptDetail(null);
      });
    return () => {
      cancelled = true;
    };
  }, [transferOpen, transferForm.new_apartment_id, todayStr]);

  const draftBusyIntervals = useMemo(
    () =>
      extractApartmentBusyIntervals(draftAptDetail || {}, {
        excludeContractId: contract?.id,
        todayStr,
      }),
    [draftAptDetail, contract?.id, todayStr]
  );

  const draftStartDateError = useMemo(() => {
    if (!editDraftForm.start_date) return '';
    const hits = findOverlappingBusyIntervals(
      editDraftForm.start_date,
      editDraftForm.start_date,
      draftBusyIntervals
    );
    return hits.length > 0 ? formatBusyOverlapError(hits, 'Ngày bắt đầu') : '';
  }, [editDraftForm.start_date, draftBusyIntervals]);

  const draftEndDateError = useMemo(() => {
    const orderErr = getDateOrderError(editDraftForm.start_date, editDraftForm.end_date, {
      strictAfter: true,
      startLabel: 'Ngày bắt đầu',
      endLabel: 'Ngày kết thúc',
    });
    if (orderErr) return orderErr;
    if (!draftStartDateError && editDraftForm.start_date && editDraftForm.end_date) {
      const hits = findOverlappingBusyIntervals(
        editDraftForm.start_date,
        editDraftForm.end_date,
        draftBusyIntervals
      );
      if (hits.length > 0) return formatBusyOverlapError(hits, 'Kỳ hạn hợp đồng nháp');
    }
    return '';
  }, [editDraftForm.start_date, editDraftForm.end_date, draftStartDateError, draftBusyIntervals]);

  const renewEndDateError = useMemo(
    () =>
      getDateOrderError(contractEndStr, renewForm.new_end_date, {
        strictAfter: true,
        startLabel: contractEndStr
          ? `Ngày kết thúc hiện tại (${formatDateVi(contractEndStr)})`
          : 'Ngày kết thúc hiện tại',
        endLabel: 'Ngày kết thúc mới',
      }),
    [contractEndStr, renewForm.new_end_date]
  );

  const amendEffectiveDateError = useMemo(
    () =>
      amendForm.effective_from
        ? getDateOrderError(contractStartStr, amendForm.effective_from, {
            strictAfter: false,
            startLabel: contractStartStr
              ? `Ngày bắt đầu HĐ (${formatDateVi(contractStartStr)})`
              : 'Ngày bắt đầu HĐ',
            endLabel: 'Ngày bắt đầu áp dụng phụ lục',
          })
        : '',
    [contractStartStr, amendForm.effective_from]
  );

  const minAmendEndDate = useMemo(
    () => maxDateStr(contractStartStr ? addDaysStr(contractStartStr, 1) : '', amendForm.effective_from),
    [contractStartStr, amendForm.effective_from]
  );

  const amendEndDateError = useMemo(() => {
    if (!amendForm.end_date) return '';
    const vsStart = getDateOrderError(contractStartStr, amendForm.end_date, {
      strictAfter: true,
      startLabel: contractStartStr
        ? `Ngày bắt đầu HĐ (${formatDateVi(contractStartStr)})`
        : 'Ngày bắt đầu HĐ',
      endLabel: 'Ngày kết thúc mới',
    });
    if (vsStart) return vsStart;
    if (amendForm.effective_from) {
      return getDateOrderError(amendForm.effective_from, amendForm.end_date, {
        strictAfter: false,
        startLabel: 'Ngày bắt đầu áp dụng phụ lục',
        endLabel: 'Ngày kết thúc mới',
      });
    }
    return '';
  }, [contractStartStr, amendForm.end_date, amendForm.effective_from]);

  const transferBusyIntervals = useMemo(
    () => extractApartmentBusyIntervals(transferAptDetail || {}, { todayStr }),
    [transferAptDetail, todayStr]
  );

  const earliestTransferStart = useMemo(
    () =>
      transferForm.new_apartment_id
        ? findFirstAvailableStartDate(todayStr, transferBusyIntervals, { minSpanDays: 2 })
        : '',
    [transferForm.new_apartment_id, todayStr, transferBusyIntervals]
  );

  const transferStartDateError = useMemo(() => {
    if (!transferForm.new_start_date) return '';
    if (minTerminateDate && transferForm.new_start_date < minTerminateDate) {
      return `Ngày chuyển phòng không được nhỏ hơn ${formatDateVi(minTerminateDate)}.`;
    }
    const hits = findOverlappingBusyIntervals(
      transferForm.new_start_date,
      transferForm.new_start_date,
      transferBusyIntervals
    );
    return hits.length > 0 ? formatBusyOverlapError(hits, 'Ngày chuyển phòng') : '';
  }, [transferForm.new_start_date, minTerminateDate, transferBusyIntervals]);

  const transferEndDateError = useMemo(() => {
    const orderErr = getDateOrderError(transferForm.new_start_date, transferForm.new_end_date, {
      strictAfter: true,
      startLabel: 'Ngày chuyển phòng',
      endLabel: 'Ngày kết thúc HĐ mới',
    });
    if (orderErr) return orderErr;
    if (!transferStartDateError && transferForm.new_start_date && transferForm.new_end_date) {
      const hits = findOverlappingBusyIntervals(
        transferForm.new_start_date,
        transferForm.new_end_date,
        transferBusyIntervals
      );
      if (hits.length > 0) return formatBusyOverlapError(hits, 'Kỳ hạn hợp đồng mới');
    }
    return '';
  }, [
    transferForm.new_start_date,
    transferForm.new_end_date,
    transferStartDateError,
    transferBusyIntervals,
  ]);

  const terminateDateError = useMemo(() => {
    if (!terminateForm.terminated_date) return '';
    if (minTerminateDate && terminateForm.terminated_date < minTerminateDate) {
      return `Ngày chấm dứt không được nhỏ hơn ${formatDateVi(minTerminateDate)}.`;
    }
    if (contractEndStr && terminateForm.terminated_date > contractEndStr) {
      return `Ngày chấm dứt không được vượt quá ngày kết thúc HĐ (${formatDateVi(contractEndStr)}).`;
    }
    return '';
  }, [terminateForm.terminated_date, minTerminateDate, contractEndStr]);

  const spEffectiveDateError = useMemo(
    () =>
      spForm.effective_from
        ? getDateOrderError(contractStartStr, spForm.effective_from, {
            strictAfter: false,
            startLabel: contractStartStr
              ? `Ngày bắt đầu HĐ (${formatDateVi(contractStartStr)})`
              : 'Ngày bắt đầu HĐ',
            endLabel: 'Ngày bắt đầu áp dụng',
          })
        : '',
    [contractStartStr, spForm.effective_from]
  );

  // Sửa bản nháp
  const handleOpenEditDraft = () => {
    if (!contract) return;
    setEditDraftForm({
      start_date: toInputDate(contract.start_date),
      end_date: toInputDate(contract.end_date),
      rent_amount: String(Math.round(Number(contract.rent_amount || 0))),
      deposit_amount: String(Math.round(Number(contract.deposit_amount || 0))),
      billing_cycle: contract.billing_cycle || 'monthly',
      billing_day: String(contract.billing_day || 1),
      payment_due_days: String(contract.payment_due_days || 5),
      note: contract.note || '',
    });

    const initServices = {};
    for (const sub of serviceSubscriptions) {
      if (!['PENDING_APPROVAL', 'ACTIVE'].includes(sub.status) || !sub.service_id) continue;
      const parking = isParkingService(sub);
      initServices[sub.service_id] = {
        checked: true,
        is_parking: parking,
        billing_type: sub.billing_type || 'QUANTITY',
        quantity: String(sub.quantity || 1),
        unit_price: String(Math.round(Number(sub.unit_price || 0))),
        vehicle_plates: parking ? syncVehiclePlatesArray(sub.vehicle_plates, sub.quantity || 1) : [],
        note: sub.note || '',
      };
    }
    setDraftSelectedServices(initServices);
    setDraftServiceErrors({});

    const elecOverride = servicePrices.find(
      (sp) => String(sp.service_code || '').toUpperCase() === 'ELECTRICITY'
    );
    const waterOverride = servicePrices.find(
      (sp) => String(sp.service_code || '').toUpperCase() === 'WATER'
    );
    setDraftCustomMeterPrices({
      ELECTRICITY:
        elecOverride && elecOverride.unit_price !== null && elecOverride.unit_price !== undefined
          ? String(Math.round(Number(elecOverride.unit_price)))
          : '',
      WATER:
        waterOverride && waterOverride.unit_price !== null && waterOverride.unit_price !== undefined
          ? String(Math.round(Number(waterOverride.unit_price)))
          : '',
    });

    setEditDraftOpen(true);

    servicesService
      .listCatalog({ active_only: 'true' })
      .then((res) => {
        setDraftServiceCatalog(Array.isArray(res?.data) ? res.data : []);
      })
      .catch(() => {
        setDraftServiceCatalog([]);
      });
  };

  const buildDraftServicesForSave = () => {
    const errors = {};
    let firstMessage = '';
    const items =
      draftServiceCatalog.length > 0
        ? selectableDraftServices
            .filter((svc) => draftSelectedServices[svc.id]?.checked)
            .map((svc) => ({
              serviceId: svc.id,
              parking: isParkingService(svc),
              billingType: svc.billing_type,
              defaultPrice: svc.unit_price,
              cfg: draftSelectedServices[svc.id] || {},
            }))
        : Object.entries(draftSelectedServices)
            .filter(([, cfg]) => cfg?.checked)
            .map(([serviceId, cfg]) => ({
              serviceId,
              parking: Boolean(cfg.is_parking),
              billingType: cfg.billing_type || 'QUANTITY',
              defaultPrice: cfg.unit_price,
              cfg,
            }));

    const payload = items.map(({ serviceId, parking, billingType, defaultPrice, cfg }) => {
      const multiQty = allowsMultiQuantity({
        billing_type: billingType,
        category: parking ? 'PARKING' : 'OTHER',
      });
      const effQty = multiQty ? cfg.quantity : 1;
      const meta = validateServiceMetaInput({
        isParking: parking,
        quantity: effQty,
        vehiclePlates: cfg.vehicle_plates,
        note: cfg.note,
      });
      if (!meta.valid) {
        errors[serviceId] = meta;
        if (!firstMessage) {
          firstMessage =
            meta.quantityError || meta.plateErrors.find(Boolean) || meta.noteError;
        }
      }
      const qty = multiQty ? Math.max(1, Math.round(Number(cfg.quantity || 1))) : 1;
      const priceVal =
        cfg.unit_price !== undefined && cfg.unit_price !== ''
          ? Math.max(0, Math.round(Number(cfg.unit_price)))
          : Math.round(Number(defaultPrice || 0));
      return {
        service_id: serviceId,
        quantity: qty,
        unit_price: priceVal,
        ...(parking ? { vehicle_plates: meta.cleanPlates } : {}),
        ...(meta.cleanNote ? { note: meta.cleanNote } : {}),
      };
    });

    return { valid: Object.keys(errors).length === 0, errors, firstMessage, payload };
  };

  const handleSaveDraft = async (e) => {
    e?.preventDefault();
    if (draftStartDateError || draftEndDateError) {
      toast.warning(draftStartDateError || draftEndDateError);
      return;
    }
    if (editDraftForm.end_date <= editDraftForm.start_date) {
      toast.warning('Ngày kết thúc phải sau ngày bắt đầu.');
      return;
    }
    const validatedServices = buildDraftServicesForSave();
    setDraftServiceErrors(validatedServices.errors);
    if (!validatedServices.valid) {
      toast.warning(validatedServices.firstMessage || 'Vui lòng kiểm tra lại biển số xe đăng ký.');
      return;
    }
    setSavingDraft(true);
    try {
      const draftServicesPayload = validatedServices.payload;

      const draftMeterPricesPayload = [
        {
          service_code: 'ELECTRICITY',
          unit_price:
            draftCustomMeterPrices.ELECTRICITY !== '' &&
            Number(draftCustomMeterPrices.ELECTRICITY) >= 0
              ? Math.round(Number(draftCustomMeterPrices.ELECTRICITY))
              : null,
        },
        {
          service_code: 'WATER',
          unit_price:
            draftCustomMeterPrices.WATER !== '' &&
            Number(draftCustomMeterPrices.WATER) >= 0
              ? Math.round(Number(draftCustomMeterPrices.WATER))
              : null,
        },
      ];

      const res = await contractsService.update(id, {
        start_date: editDraftForm.start_date,
        end_date: editDraftForm.end_date,
        rent_amount: Math.round(Number(editDraftForm.rent_amount || 0)),
        deposit_amount: Math.round(Number(editDraftForm.deposit_amount || 0)),
        billing_cycle: editDraftForm.billing_cycle,
        billing_day: Math.min(31, Math.max(1, Number(editDraftForm.billing_day || 1))),
        payment_due_days: Math.min(60, Math.max(1, Number(editDraftForm.payment_due_days || 5))),
        note: editDraftForm.note,
        services: draftServicesPayload,
        service_prices: draftMeterPricesPayload,
      });
      toast.success(res?.message || 'Cập nhật bản nháp hợp đồng thành công.');
      setEditDraftOpen(false);
      await loadAll();
    } catch (err) {
      toast.error(extractErrorMessage(err, 'Không thể cập nhật hợp đồng nháp.'));
    } finally {
      setSavingDraft(false);
    }
  };

  // Hủy nháp
  const handleCancelDraft = async (e) => {
    e?.preventDefault();
    setCancelling(true);
    try {
      const res = await contractsService.cancel(id, { reason: cancelReason.trim() });
      toast.success(res?.message || 'Đã hủy hợp đồng nháp.');
      setCancelOpen(false);
      setCancelReason('');
      await loadAll();
    } catch (err) {
      toast.error(extractErrorMessage(err, 'Không thể hủy hợp đồng nháp.'));
    } finally {
      setCancelling(false);
    }
  };

  // Gia hạn hợp đồng (Tạo HĐ mới nối tiếp có parent_contract_id)
  const handleOpenRenew = () => {
    if (!contract) return;
    const curEnd = toInputDate(contract.end_date);
    setRenewForm({
      new_end_date: addMonthsStr(curEnd, 12),
      rent_amount: String(Math.round(Number(contract.rent_amount || 0))),
      deposit_amount: String(Math.round(Number(contract.deposit_amount || 0))),
      note: `Gia hạn nối tiếp từ hợp đồng HĐ-${String(contract.id).slice(0, 8).toUpperCase()}`,
    });
    setRenewOpen(true);
  };

  const handleRenewSubmit = async (e) => {
    e?.preventDefault();
    if (renewEndDateError) {
      toast.warning(renewEndDateError);
      return;
    }
    const curEnd = toInputDate(contract?.end_date);
    if (!renewForm.new_end_date || renewForm.new_end_date <= curEnd) {
      toast.warning('Ngày kết thúc gia hạn phải sau ngày kết thúc hiện tại của hợp đồng.');
      return;
    }
    setSubmittingRenew(true);
    try {
      const res = await contractsService.renew(
        id,
        {
          new_end_date: renewForm.new_end_date,
          rent_amount: Math.round(Number(renewForm.rent_amount || 0)),
          deposit_amount: Math.round(Number(renewForm.deposit_amount || 0)),
          note: renewForm.note.trim(),
        },
        { idempotencyKey: actionIdemKeyRef.current || createIdempotencyKey() }
      );
      toast.success(res?.message || 'Đã tạo hợp đồng gia hạn nối tiếp thành công.');
      setRenewOpen(false);
      if (res?.data?.id) {
        navigate(`/admin/contracts/${res.data.id}`);
      } else {
        await loadAll();
      }
    } catch (err) {
      toast.error(extractErrorMessage(err, 'Không thể tạo hợp đồng gia hạn.'));
    } finally {
      setSubmittingRenew(false);
    }
  };

  // Lập phụ lục hợp đồng
  const handleOpenAmend = () => {
    if (!contract) return;
    setAmendForm({
      end_date: toInputDate(contract.end_date),
      rent_amount: String(Math.round(Number(contract.rent_amount || 0))),
      deposit_amount: String(Math.round(Number(contract.deposit_amount || 0))),
      note: contract.note || '',
      effective_from: maxDateStr(todayStr, toInputDate(contract.start_date)),
      reason: '',
    });
    setAmendOpen(true);
  };

  const handleAmendSubmit = async (e) => {
    e?.preventDefault();
    if (amendEffectiveDateError || amendEndDateError) {
      toast.warning(amendEffectiveDateError || amendEndDateError);
      return;
    }
    if (!amendForm.reason.trim()) {
      toast.warning('Vui lòng nhập lý do lập phụ lục hợp đồng.');
      return;
    }

    const changes = {};
    const curEnd = toInputDate(contract.end_date);
    const curRent = Math.round(Number(contract.rent_amount || 0));
    const curDep = Math.round(Number(contract.deposit_amount || 0));
    const curNote = String(contract.note || '');

    if (amendForm.end_date && amendForm.end_date !== curEnd) {
      changes.end_date = amendForm.end_date;
    }
    if (amendForm.rent_amount !== '' && Math.round(Number(amendForm.rent_amount)) !== curRent) {
      changes.rent_amount = Math.round(Number(amendForm.rent_amount));
    }
    if (amendForm.deposit_amount !== '' && Math.round(Number(amendForm.deposit_amount)) !== curDep) {
      changes.deposit_amount = Math.round(Number(amendForm.deposit_amount));
    }
    if (amendForm.note.trim() !== curNote.trim() && amendForm.note.trim() !== '') {
      changes.note = amendForm.note.trim();
    }

    if (Object.keys(changes).length === 0) {
      toast.warning('Chưa có thông tin nào thay đổi so với hợp đồng hiện tại.');
      return;
    }

    setSubmittingAmend(true);
    try {
      const res = await contractsService.createAmendment(id, {
        changes,
        effective_from: amendForm.effective_from || undefined,
        reason: amendForm.reason.trim(),
      });
      toast.success(res?.message || 'Đã gửi đề xuất phụ lục hợp đồng.');
      setAmendOpen(false);
      setActiveTab('amendments');
      await loadAll();
    } catch (err) {
      toast.error(extractErrorMessage(err, 'Không thể tạo phụ lục hợp đồng.'));
    } finally {
      setSubmittingAmend(false);
    }
  };

  const handleApproveAmendment = async (versionId) => {
    try {
      const res = await contractsService.approveAmendment(id, versionId);
      toast.success(res?.message || 'Đã phê duyệt và áp dụng phụ lục hợp đồng.');
      await loadAll();
    } catch (err) {
      toast.error(extractErrorMessage(err, 'Không thể phê duyệt phụ lục.'));
    }
  };

  const handleRejectAmendmentSubmit = async (e) => {
    e?.preventDefault();
    if (!rejectAmendTarget) return;
    if (!rejectAmendReason.trim()) {
      toast.warning('Vui lòng nhập lý do từ chối phụ lục.');
      return;
    }
    setSubmittingRejectAmend(true);
    try {
      const res = await contractsService.rejectAmendment(id, rejectAmendTarget.id, {
        reason: rejectAmendReason.trim(),
      });
      toast.success(res?.message || 'Đã từ chối phụ lục hợp đồng.');
      setRejectAmendTarget(null);
      setRejectAmendReason('');
      await loadAll();
    } catch (err) {
      toast.error(extractErrorMessage(err, 'Không thể từ chối phụ lục.'));
    } finally {
      setSubmittingRejectAmend(false);
    }
  };

  // Chuyển phòng atomic (FR-013)
  const handleOpenTransfer = async () => {
    if (!contract) return;
    userEditedTransferDatesRef.current = false;
    setTransferAptDetail(null);
    const curEnd = toInputDate(contract.end_date);
    setTransferForm({
      new_apartment_id: '',
      new_start_date: todayStr,
      new_end_date: curEnd && curEnd > todayStr ? curEnd : addMonthsStr(todayStr, 12),
      new_rent_amount: String(Math.round(Number(contract.rent_amount || 0))),
      new_deposit_amount: String(Math.round(Number(contract.deposit_amount || 0))),
      transfer_deposit: true,
      note: '',
    });
    setTransferOpen(true);
    setLoadingApts(true);
    try {
      const res = await buildingsService.listApartments({ building_id: contract.building_id });
      const list = (Array.isArray(res?.data) ? res.data : []).filter(
        (a) => a.status === 'AVAILABLE' && String(a.id) !== String(contract.apartment_id)
      );
      setAvailableApts(list);
    } catch (err) {
      toast.error(extractErrorMessage(err, 'Không thể tải danh sách căn trống cùng tòa.'));
    } finally {
      setLoadingApts(false);
    }
  };

  const handleTransferSubmit = async (e) => {
    e?.preventDefault();
    if (!transferForm.new_apartment_id) {
      toast.warning('Vui lòng chọn căn hộ trống cần chuyển đến.');
      return;
    }
    if (transferStartDateError || transferEndDateError) {
      toast.warning(transferStartDateError || transferEndDateError);
      return;
    }
    if (transferForm.new_end_date <= transferForm.new_start_date) {
      toast.warning('Ngày kết thúc hợp đồng mới phải sau ngày chuyển phòng.');
      return;
    }
    const proposedRent = Math.round(Number(transferForm.new_rent_amount || 0));
    setSubmittingTransfer(true);
    try {
      const res = await contractsService.transferRoom(
        id,
        {
          new_apartment_id: transferForm.new_apartment_id,
          new_start_date: transferForm.new_start_date,
          new_end_date: transferForm.new_end_date,
          new_rent_amount: proposedRent,
          ...(transferForm.new_deposit_amount !== ''
            ? { new_deposit_amount: Math.max(0, Math.round(Number(transferForm.new_deposit_amount))) }
            : {}),
          transfer_deposit: Boolean(transferForm.transfer_deposit),
          note: transferForm.note.trim() || undefined,
        },
        { idempotencyKey: actionIdemKeyRef.current || createIdempotencyKey() }
      );
      toast.success(
        res?.message ||
          'Đã tạo hợp đồng nháp đổi phòng! Vui lòng in hợp đồng A4, tải bản scan đã ký và trình Chủ sở hữu phê duyệt.'
      );
      setTransferOpen(false);
      const newContractId = res?.data?.new_contract?.id;
      if (newContractId) {
        navigate(`/admin/contracts/${newContractId}`);
      } else {
        await loadAll();
      }
    } catch (err) {
      toast.error(extractErrorMessage(err, 'Không thể khởi tạo hợp đồng đổi phòng.'));
    } finally {
      setSubmittingTransfer(false);
    }
  };

  // Thanh lý / Chấm dứt hợp đồng trực tiếp (MANAGER / SYS_ADMIN)
  const handleOpenTerminate = () => {
    if (!contract) return;
    const sDate = toInputDate(contract.start_date);
    const eDate = toInputDate(contract.end_date);
    const isPreMoveIn = todayStr < sDate;
    let defaultTermDate = todayStr;
    if (!isPreMoveIn && defaultTermDate < sDate) defaultTermDate = sDate;
    if (defaultTermDate > eDate) defaultTermDate = eDate;

    setTerminateForm({
      terminated_date: defaultTermDate,
      reason: isPreMoveIn
        ? 'Thanh lý hợp đồng trước ngày nhận phòng theo thỏa thuận'
        : 'Khách thuê trả phòng / Thanh lý hợp đồng',
      note: '',
    });
    setTerminateOpen(true);
  };

  const handleTerminateSubmit = async (e) => {
    e?.preventDefault();
    if (!terminateForm.terminated_date) {
      toast.warning('Vui lòng chọn ngày chấm dứt hợp đồng.');
      return;
    }
    if (terminateDateError) {
      toast.warning(terminateDateError);
      return;
    }
    if (!terminateForm.reason.trim()) {
      toast.warning('Vui lòng nhập lý do chấm dứt hợp đồng.');
      return;
    }
    setSubmittingTerminate(true);
    try {
      const res = await contractsService.terminate(
        id,
        {
          terminated_date: terminateForm.terminated_date,
          reason: terminateForm.reason.trim(),
          note: terminateForm.note.trim(),
        },
        { idempotencyKey: actionIdemKeyRef.current || createIdempotencyKey() }
      );
      toast.success(res?.message || 'Đã chấm dứt hợp đồng thành công.');
      setTerminateOpen(false);
      await loadAll();
    } catch (err) {
      toast.error(extractErrorMessage(err, 'Không thể thực hiện chấm dứt hợp đồng.'));
    } finally {
      setSubmittingTerminate(false);
    }
  };

  // Từ chối phê duyệt hợp đồng giá ưu đãi -> trả về nháp (DRAFT)
  const handleRejectPriceSubmit = async (e) => {
    e?.preventDefault();
    if (!rejectPriceReason.trim()) {
      toast.warning('Vui lòng nhập lý do từ chối phê duyệt hợp đồng.');
      return;
    }
    setSubmittingRejectPrice(true);
    try {
      const res = await contractsService.rejectContract(id, rejectPriceReason.trim());
      toast.success(res?.message || 'Đã từ chối phê duyệt, hợp đồng được trả về trạng thái bản nháp.');
      setRejectPriceOpen(false);
      setRejectPriceReason('');
      await loadAll();
    } catch (err) {
      toast.error(extractErrorMessage(err, 'Không thể từ chối phê duyệt hợp đồng.'));
    } finally {
      setSubmittingRejectPrice(false);
    }
  };

  // Từ chối chấm dứt (OWNER)
  const handleRejectTerminationSubmit = async (e) => {
    e?.preventDefault();
    if (!rejectTermReason.trim()) {
      toast.warning('Vui lòng nhập lý do từ chối chấm dứt hợp đồng.');
      return;
    }
    setSubmittingRejectTerm(true);
    try {
      const res = await contractsService.rejectTermination(id, {
        reason: rejectTermReason.trim(),
      });
      toast.success(res?.message || 'Đã từ chối đề xuất chấm dứt, hợp đồng quay lại hiệu lực.');
      setRejectTermOpen(false);
      setRejectTermReason('');
      await loadAll();
    } catch (err) {
      toast.error(extractErrorMessage(err, 'Không thể từ chối đề xuất chấm dứt.'));
    } finally {
      setSubmittingRejectTerm(false);
    }
  };

  // Thêm / Gỡ người ở cùng
  const handleAddOccupantSubmit = async (e) => {
    e?.preventDefault();
    const errs = {};
    if (!occForm.full_name.trim()) errs.full_name = 'Vui lòng nhập họ tên.';
    if (!occForm.phone.trim()) errs.phone = 'Vui lòng nhập số điện thoại.';
    else if (!isValidPhone(occForm.phone)) errs.phone = 'Số điện thoại không hợp lệ (10 số).';
    if (occForm.email && !isValidEmail(occForm.email)) errs.email = 'Email không hợp lệ.';
    if (occForm.id_number && !isValidIdNumber(occForm.id_number)) errs.id_number = 'CCCD/Hộ chiếu không hợp lệ.';
    setOccErrors(errs);
    if (Object.keys(errs).length > 0) return;

    setSubmittingOcc(true);
    try {
      const res = await contractsService.addOccupant(id, {
        full_name: occForm.full_name.trim(),
        phone: normalizePhone(occForm.phone),
        relationship: occForm.relationship,
        id_number: occForm.id_number.trim() || undefined,
        email: occForm.email.trim() || undefined,
        dob: occForm.dob || undefined,
      });
      toast.success(res?.message || 'Đã thêm thành viên cùng ở.');
      setOccModalOpen(false);
      setOccForm({ full_name: '', phone: '', relationship: 'family', id_number: '', email: '', dob: '' });
      const oRes = await contractsService.listOccupants(id);
      setOccupants(Array.isArray(oRes?.data) ? oRes.data : []);
    } catch (err) {
      toast.error(extractErrorMessage(err, 'Không thể thêm thành viên ở cùng.'));
    } finally {
      setSubmittingOcc(false);
    }
  };

  const handleConfirmRemoveOccupant = async () => {
    if (!removeOccTarget) return;
    setRemovingOcc(true);
    try {
      const res = await contractsService.removeOccupant(id, removeOccTarget.tenant_id);
      toast.success(res?.message || 'Đã gỡ thành viên khỏi hợp đồng.');
      setRemoveOccTarget(null);
      const oRes = await contractsService.listOccupants(id);
      setOccupants(Array.isArray(oRes?.data) ? oRes.data : []);
    } catch (err) {
      toast.error(extractErrorMessage(err, 'Không thể gỡ thành viên.'));
    } finally {
      setRemovingOcc(false);
    }
  };

  // Biểu phí dịch vụ riêng
  const handleAddServicePrice = async (e) => {
    e?.preventDefault();
    if (spForm.unit_price === '' || Number(spForm.unit_price) < 0) {
      toast.warning('Vui lòng nhập đơn giá dịch vụ hợp lệ (>= 0).');
      return;
    }
    if (spEffectiveDateError) {
      toast.warning(spEffectiveDateError);
      return;
    }
    setSubmittingSp(true);
    try {
      const res = await contractsService.addServicePrice(id, {
        service_code: spForm.service_code,
        unit_price: Math.round(Number(spForm.unit_price)),
        effective_from: spForm.effective_from || toInputDate(contract?.start_date),
      });
      toast.success(res?.message || 'Đã lưu đơn giá dịch vụ theo hợp đồng.');
      setSpModalOpen(false);
      const spRes = await contractsService.listServicePrices(id);
      setServicePrices(Array.isArray(spRes?.data) ? spRes.data : []);
    } catch (err) {
      toast.error(extractErrorMessage(err, 'Không thể cập nhật đơn giá dịch vụ.'));
    } finally {
      setSubmittingSp(false);
    }
  };

  const handleDeleteServicePrice = async (priceId) => {
    try {
      await contractsService.removeServicePrice(id, priceId);
      toast.success('Đã xóa cấu hình giá dịch vụ.');
      const spRes = await contractsService.listServicePrices(id);
      setServicePrices(Array.isArray(spRes?.data) ? spRes.data : []);
    } catch (err) {
      toast.error(extractErrorMessage(err, 'Không thể xóa đơn giá dịch vụ.'));
    }
  };

  if (loading) {
    return <LoadingSpinner label="Đang tải chi tiết hợp đồng..." />;
  }

  if (!contract) {
    return (
      <Card>
        <EmptyState
          title="Không tìm thấy hợp đồng"
          description="Hợp đồng không tồn tại hoặc nằm ngoài phạm vi tòa nhà của bạn."
          action={
            <Button variant="primary" onClick={() => navigate('/admin/contracts')}>
              Về danh sách hợp đồng
            </Button>
          }
        />
      </Card>
    );
  }

  const contractCode = `HĐ-${String(contract.id).slice(0, 8).toUpperCase()}`;
  const pendingAmendmentsCount = amendments.filter(
    (v) => !v.approved_by && v.diff?.status !== 'REJECTED'
  ).length;

  const tabs = [
    { id: 'overview', label: 'Chi tiết & Bản scan ký kết', icon: FileText },
    { id: 'schedule', label: 'Lịch hóa đơn dự kiến', icon: Calendar, count: invoiceSchedule.length },
    { id: 'occupants', label: 'Người ở cùng', icon: Users, count: occupants.length },
    {
      id: 'amendments',
      label: 'Phụ lục hợp đồng',
      icon: FilePlus2,
      count: pendingAmendmentsCount > 0 ? pendingAmendmentsCount : amendments.length,
    },
    {
      id: 'credits',
      label: 'Sổ tín dụng & Hoàn tiền',
      icon: Sparkles,
      count: (contract?.credit_balances || []).length,
    },
    { id: 'history', label: 'Lịch sử gia hạn & Giá dịch vụ', icon: History, count: relatedContracts.length },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        breadcrumbs={[
          { label: 'Quản lý Hợp đồng', to: '/admin/contracts' },
          { label: `${contractCode} (${contract.apartment_code})` },
        ]}
        title={`Hợp đồng ${contractCode} — Căn ${contract.apartment_code}`}
        subtitle={`Tòa nhà: ${contract.building_name} • Khách thuê chính: ${contract.tenant_name}`}
        actions={
          <>
            <Button
              variant="outline"
              icon={Printer}
              loading={printing}
              onClick={handlePrintA4}
            >
              Xem & In hợp đồng A4
            </Button>

            {/* Nút hành động vận hành (MANAGER / SYS_ADMIN) */}
            {canManageOps && contract.status === 'DRAFT' ? (
              <>
                <Button variant="outline" icon={Edit3} onClick={handleOpenEditDraft}>
                  Sửa nháp
                </Button>
                <Button variant="outline" icon={XCircle} onClick={() => setCancelOpen(true)}>
                  Hủy nháp
                </Button>
                <Button
                  variant="primary"
                  icon={CheckCircle2}
                  onClick={() => setConfirmState({ open: true, type: 'activate' })}
                >
                  Kích hoạt HĐ
                </Button>
              </>
            ) : null}

            {canManageOps && contract.status === 'PENDING_APPROVAL' ? (
              <Button variant="outline" icon={XCircle} onClick={() => setCancelOpen(true)}>
                Hủy đề xuất
              </Button>
            ) : null}

            {canManageOps && ['ACTIVE', 'RENEWAL_PENDING', 'EXPIRED'].includes(contract.status) ? (
              <Button variant="outline" icon={RefreshCw} onClick={handleOpenRenew}>
                Gia hạn HĐ
              </Button>
            ) : null}

            {canManageOps && ['ACTIVE', 'RENEWAL_PENDING'].includes(contract.status) ? (
              <Button variant="outline" icon={FilePlus2} onClick={handleOpenAmend}>
                Phụ lục điều chỉnh
              </Button>
            ) : null}

            {canManageOps && contract.status === 'ACTIVE' ? (
              <Button variant="soft" icon={ArrowRightLeft} onClick={handleOpenTransfer}>
                Chuyển phòng
              </Button>
            ) : null}

            {canTerminateContracts && ['ACTIVE', 'RENEWAL_PENDING'].includes(contract.status) ? (
              <Button variant="danger" icon={XCircle} onClick={handleOpenTerminate}>
                Thanh lý / Chấm dứt HĐ
              </Button>
            ) : null}

            {/* Phê duyệt / Từ chối giá ưu đãi (OWNER tòa nhà hoặc SYS_ADMIN khi tòa chưa gán OWNER) */}
            {canApprovePrice &&
            contract.status === 'PENDING_APPROVAL' &&
            (!contract.created_by ||
              String(contract.created_by) !== String(currentUserId) ||
              allowSelfApproval) ? (
              <>
                <Button
                  variant="danger"
                  icon={XCircle}
                  onClick={() => {
                    setRejectPriceReason('');
                    setRejectPriceOpen(true);
                  }}
                >
                  Từ chối (trả về nháp)
                </Button>
                <Button
                  variant="success"
                  icon={ShieldCheck}
                  onClick={() => setConfirmState({ open: true, type: 'approve' })}
                >
                  {contract.is_room_transfer
                    ? 'Phê duyệt đổi phòng & kết chuyển cọc'
                    : 'Phê duyệt HĐ giá ưu đãi'}
                </Button>
              </>
            ) : null}

            {canTerminateContracts && contract.status === 'TERMINATION_PENDING' ? (
              <>
                <Button variant="outline" icon={XCircle} onClick={() => setRejectTermOpen(true)}>
                  Hủy lịch chấm dứt
                </Button>
                <Button
                  variant="danger"
                  icon={CheckCircle2}
                  onClick={handleOpenTerminate}
                >
                  Chốt trả phòng &amp; Chấm dứt ngay
                </Button>
              </>
            ) : null}
          </>
        }
      />

      {/* Timeline trạng thái */}
      <ContractTimeline status={contract.status} isRoomTransfer={Boolean(contract.is_room_transfer)} />

      {/* Hướng dẫn quy trình 4 bước khi là Hợp đồng Đổi phòng (FR-013, FR-025, AC-009.2) */}
      {contract.is_room_transfer && ['DRAFT', 'PENDING_APPROVAL'].includes(contract.status) ? (
        <div className="p-4 rounded-xl bg-indigo-50 border border-indigo-200 flex items-start gap-3 text-xs text-indigo-950">
          <ArrowRightLeft className="w-5 h-5 text-indigo-600 shrink-0 mt-0.5" />
          <div className="leading-relaxed space-y-1">
            <p className="font-semibold">
              Hợp đồng Đổi phòng có kết chuyển cọc — Quy trình kiểm soát 4 mắt (FR-013, FR-025, AC-009.2)
            </p>
            <p className="text-indigo-800">
              {contract.status === 'DRAFT'
                ? 'Bước 1: In bản cứng A4 ký kết & tải lên bản scan hợp đồng mới → Bước 2: Bấm "Kích hoạt HĐ" để gửi trình duyệt → Bước 3: Chủ sở hữu phê duyệt để đóng hợp đồng căn cũ và kết chuyển sổ cọc sang căn mới.'
                : 'Hợp đồng đổi phòng đã có bản scan ký kết và đang chờ Chủ sở hữu tòa nhà phê duyệt. Hợp đồng căn cũ vẫn giữ hiệu lực (ACTIVE) cho tới khi được phê duyệt.'}
            </p>
          </div>
        </div>
      ) : null}

      {/* Cảnh báo điều kiện kích hoạt khi DRAFT */}
      {contract.status === 'DRAFT' && attachments.length === 0 ? (
        <div className="p-4 rounded-xl bg-amber-50 border border-amber-200 flex items-start gap-3 text-xs text-amber-900">
          <AlertTriangle className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
          <div className="leading-relaxed">
            <p className="font-semibold">Chưa đính kèm bản scan hợp đồng đã ký kết (AC-009.2)</p>
            <p className="text-amber-800 mt-0.5">
              Vui lòng nhấn <strong>Xem &amp; In hợp đồng A4</strong> để in bản cứng ký kết giữa hai bên, sau đó tải ảnh scan hợp đồng lên mục bên dưới trước khi bấm <strong>Kích hoạt HĐ</strong>.
            </p>
          </div>
        </div>
      ) : null}

      {contract.status === 'TERMINATION_PENDING' ? (
        <div className="p-4 rounded-xl bg-amber-50 border border-amber-200 flex items-start gap-3 text-xs text-amber-900">
          <Clock className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
          <div className="leading-relaxed">
            <p className="font-semibold">
              Hợp đồng đang chờ bàn giao chấm dứt — Ngày trả phòng dự kiến:{' '}
              {formatDate(contract.terminated_at)}
            </p>
            <p className="text-amber-800 mt-0.5">
              Đến đúng ngày hẹn hệ thống sẽ tự động chuyển hợp đồng sang <strong>Đã thanh lý (TERMINATED)</strong> và mở hạn hoàn cọc 5 ngày, hoặc Quản lý có thể bấm <strong>Chốt trả phòng &amp; Chấm dứt ngay</strong> khi khách bàn giao phòng sớm.
            </p>
          </div>
        </div>
      ) : null}

      {/* Tabs */}
      <Tabs tabs={tabs} activeTab={activeTab} onChange={setActiveTab} />

      {/* TAB 1: Tổng quan & Bản scan */}
      {activeTab === 'overview' ? (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          <Card className="lg:col-span-7">
            <CardHeader
              title="Thông tin chi tiết hợp đồng"
              subtitle="Các điều khoản thương mại và thông tin định danh khách thuê"
              action={<StatusBadge status={contract.status} domain="contract" />}
            />

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
              <div className="p-3.5 rounded-xl bg-slate-50 border border-slate-100">
                <p className="text-xs text-slate-500">Căn hộ &amp; Tòa nhà</p>
                <p className="font-bold text-slate-900 mt-1 flex items-center gap-1.5">
                  <Building2 className="w-4 h-4 text-primary-500" />
                  {contract.apartment_code} — {contract.building_name}
                </p>
              </div>

              <div className="p-3.5 rounded-xl bg-slate-50 border border-slate-100">
                <p className="text-xs text-slate-500">Khách thuê đại diện</p>
                <div className="mt-1 flex items-center justify-between gap-2">
                  <Link
                    to={`/admin/tenants/${contract.primary_tenant_id}`}
                    className="font-bold text-primary-600 hover:text-primary-700 hover:underline flex items-center gap-1.5"
                  >
                    <User className="w-4 h-4" />
                    {contract.tenant_name}
                  </Link>
                  <span className="text-xs text-slate-500">{contract.tenant_phone}</span>
                </div>
              </div>

              <div className="p-3.5 rounded-xl bg-sky-50/60 border border-sky-100">
                <p className="text-xs text-sky-700">Giá thuê hàng tháng</p>
                <p className="text-lg font-bold text-slate-900 mt-0.5">
                  {formatMoney(contract.rent_amount)}
                </p>
              </div>

              <div className="p-3.5 rounded-xl bg-emerald-50/60 border border-emerald-100">
                <p className="text-xs text-emerald-700">Tiền đặt cọc bảo đảm</p>
                <div className="flex items-center justify-between mt-0.5">
                  <p className="text-lg font-bold text-slate-900">
                    {formatMoney(contract.deposit_amount)}
                  </p>
                  <Link
                    to="/admin/deposits"
                    className="text-xs font-medium text-emerald-700 hover:underline"
                  >
                    Sổ cọc →
                  </Link>
                </div>
              </div>

              <div className="p-3 rounded-lg border border-slate-100">
                <p className="text-xs text-slate-500">Ngày bắt đầu hiệu lực</p>
                <p className="font-semibold text-slate-800 mt-0.5">
                  {formatDate(contract.start_date)}
                </p>
              </div>

              <div className="p-3 rounded-lg border border-slate-100">
                <p className="text-xs text-slate-500">Ngày kết thúc hợp đồng</p>
                <p className="font-semibold text-slate-800 mt-0.5">
                  {formatDate(contract.end_date)}
                </p>
              </div>

              <div className="p-3 rounded-lg border border-slate-100">
                <p className="text-xs text-slate-500">Chu kỳ, Ngày chốt &amp; Hạn thanh toán</p>
                <p className="font-semibold text-slate-800 mt-0.5">
                  {contract.billing_cycle === 'quarterly' ? '3 tháng / lần' : 'Hàng tháng'} • Ngày{' '}
                  {contract.billing_day || 1} • Hạn {contract.payment_due_days || 5} ngày
                </p>
              </div>

              <div className="p-3 rounded-lg border border-slate-100">
                <p className="text-xs text-slate-500">Email liên hệ</p>
                <p className="font-semibold text-slate-800 mt-0.5 break-all">
                  {contract.tenant_email || 'Chưa cập nhật email'}
                </p>
              </div>

              {contract.terminated_at ? (
                <div className="p-3 rounded-lg border border-amber-200 bg-amber-50/50 sm:col-span-2">
                  <p className="text-xs text-amber-700">Ngày thanh lý / chấm dứt hợp đồng</p>
                  <p className="font-semibold text-amber-900 mt-0.5">
                    {formatDate(contract.terminated_at)}
                  </p>
                </div>
              ) : null}
            </div>

            {contract.note ? (
              <div className="mt-4 p-3.5 rounded-xl bg-slate-50 border border-slate-200/70">
                <p className="text-xs font-semibold text-slate-700 mb-1">Ghi chú &amp; Nhật ký hợp đồng</p>
                <p className="text-xs text-slate-600 whitespace-pre-line leading-relaxed">
                  {contract.note}
                </p>
              </div>
            ) : null}
          </Card>

          {/* Bản scan hợp đồng đã ký */}
          <Card className="lg:col-span-5">
            <CardHeader
              title="Bản scan hợp đồng ký kết"
              subtitle="Chứng từ bắt buộc để kích hoạt hợp đồng sang ACTIVE (FR-020)"
              action={
                <Badge variant={attachments.length > 0 ? 'emerald' : 'amber'}>
                  {attachments.length} tệp đính kèm
                </Badge>
              }
            />

            {attachments.length > 0 ? (
              <div className="grid grid-cols-2 gap-3 mb-4">
                {attachments.map((att, idx) => {
                  const viewUrl = `/api/v1/attachments/${att.id}/view`;
                  const isPdf =
                    att.mime === 'application/pdf' ||
                    String(att.storage_path || '').toLowerCase().endsWith('.pdf');
                  return (
                    <div
                      key={att.id}
                      onClick={() => setPreviewScanItem({ src: viewUrl, isPdf })}
                      className="group relative rounded-xl border border-slate-200 overflow-hidden bg-slate-50 cursor-pointer hover:border-primary-400 transition-all"
                    >
                      <div className="h-36 w-full">
                        {isPdf ? (
                          <div className="w-full h-full flex flex-col items-center justify-center gap-2 bg-rose-50/70 text-rose-700 p-3 text-center">
                            <FileText className="w-10 h-10 text-rose-500" />
                            <span className="text-xs font-semibold">Tệp PDF hợp đồng</span>
                          </div>
                        ) : (
                          <AuthImage
                            src={viewUrl}
                            alt={`Bản scan #${idx + 1}`}
                            className="w-full h-full object-cover"
                          />
                        )}
                      </div>
                      <div className="px-2.5 py-1.5 bg-white border-t border-slate-100 flex items-center justify-between gap-2 text-[11px] text-slate-600">
                        <div className="min-w-0">
                          <p className="font-medium break-words">
                            Bản ký #{attachments.length - idx} {isPdf ? '(PDF)' : ''}
                          </p>
                          {att.created_at ? (
                            <p className="text-[10px] text-slate-400">{formatDate(att.created_at)}</p>
                          ) : null}
                        </div>
                        <span className="inline-flex items-center gap-0.5 text-primary-600 font-medium shrink-0">
                          <ZoomIn className="w-3 h-3" /> Xem
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="mb-4 py-8 px-4 rounded-xl border border-dashed border-slate-200 bg-slate-50 text-center text-xs text-slate-500">
                Chưa có bản scan hợp đồng đã ký kết.
              </div>
            )}

            {canManageOps ? (
              <FileUpload
                label="Đính kèm thêm bản scan hợp đồng đã ký (PDF / JPG / PNG)"
                accept="image/jpeg,image/png,application/pdf"
                maxSizeMB={10}
                value=""
                onChange={handleUploadScan}
                hint={
                  uploadingScan
                    ? 'Đang tải bản scan lên máy chủ...'
                    : 'Hỗ trợ tệp PDF hoặc ảnh chụp / scan rõ nét JPG, PNG (tối đa 10MB)'
                }
              />
            ) : null}
          </Card>
        </div>
      ) : null}

      {/* TAB Lịch hóa đơn dự kiến & Dịch vụ đi kèm */}
      {activeTab === 'schedule' ? (
        <div className="space-y-6">
          <Card>
            <CardHeader
              title="Dịch vụ đi kèm theo hợp đồng"
              subtitle="Các gói dịch vụ định kỳ đăng ký kèm hợp đồng (tự động kích hoạt sang ACTIVE khi hợp đồng hiệu lực)"
              action={
                <Badge variant={serviceSubscriptions.length > 0 ? 'sky' : 'slate'}>
                  {serviceSubscriptions.length} dịch vụ đăng ký
                </Badge>
              }
            />
            {serviceSubscriptions.length === 0 ? (
              <p className="text-xs text-slate-500 py-4 text-center italic">
                Chưa đăng ký gói dịch vụ cố định/theo số lượng đi kèm trên hợp đồng này.
              </p>
            ) : (
              <DataTable
                rowKey="id"
                data={serviceSubscriptions}
                columns={[
                  {
                    key: 'service_name',
                    label: 'Dịch vụ',
                    render: (row) => (
                      <div>
                        <p className="font-semibold text-slate-900">{row.service_name || row.code}</p>
                        <p className="text-[11px] text-slate-500 font-mono">{row.service_code || row.code}</p>
                      </div>
                    ),
                  },
                  {
                    key: 'quantity',
                    label: 'Số lượng',
                    align: 'center',
                    render: (row) => `${row.quantity || 1} ${row.unit || ''}`.trim(),
                  },
                  {
                    key: 'unit_price',
                    label: 'Đơn giá áp dụng',
                    align: 'right',
                    render: (row) => (
                      <span className="font-semibold text-slate-900">{formatMoney(row.unit_price)}</span>
                    ),
                  },
                  {
                    key: 'note',
                    label: 'Biển số / Ghi chú',
                    render: (row) =>
                      row.vehicle_plates?.length || row.note ? (
                        <div className="space-y-1">
                          <VehiclePlatesBadges plates={row.vehicle_plates} />
                          {row.note ? <p className="text-xs text-slate-700">{row.note}</p> : null}
                        </div>
                      ) : (
                        <span className="text-xs text-slate-400">—</span>
                      ),
                  },
                  {
                    key: 'status',
                    label: 'Trạng thái',
                    align: 'center',
                    render: (row) => (
                      <StatusBadge status={row.status} domain="subscription" />
                    ),
                  },
                ]}
              />
            )}
          </Card>

          <Card>
            <CardHeader
              title="Lịch hóa đơn dự kiến toàn kỳ hợp đồng"
              subtitle={`Chu kỳ ${
                contract.billing_cycle === 'quarterly' ? '3 tháng / lần' : 'hàng tháng'
              } • Ngày chốt: ngày ${contract.billing_day || 1} • Hạn thanh toán: ${
                contract.payment_due_days || 5
              } ngày sau phát hành (chưa bao gồm điện/nước theo chỉ số đồng hồ)`}
              action={<Badge variant="indigo">{invoiceSchedule.length} kỳ thu</Badge>}
            />
            <DataTable
              rowKey="period_no"
              data={invoiceSchedule}
              emptyTitle="Chưa có lịch hóa đơn dự kiến"
              emptyDescription="Lịch thu tiền dự kiến sẽ hiển thị theo kỳ hạn bắt đầu và kết thúc của hợp đồng."
              columns={[
                {
                  key: 'period_no',
                  label: 'Kỳ thu',
                  render: (row) => (
                    <div className="flex items-center gap-2">
                      <span className="font-mono font-bold text-slate-900">#{row.period_no}</span>
                      <span className="text-xs text-slate-600">{row.billing_period}</span>
                      {row.is_prorated ? <Badge variant="amber">Pro-rata</Badge> : null}
                    </div>
                  ),
                },
                {
                  key: 'period_range',
                  label: 'Khoảng tính phí',
                  render: (row) => (
                    <span className="text-xs text-slate-700 whitespace-nowrap">
                      {formatDate(row.period_start)} → {formatDate(row.period_end)}
                    </span>
                  ),
                },
                {
                  key: 'issue_date',
                  label: 'Ngày phát hành',
                  align: 'center',
                  render: (row) => (
                    <span className="text-xs font-medium text-slate-800 whitespace-nowrap">
                      {formatDate(row.issue_date)}
                    </span>
                  ),
                },
                {
                  key: 'due_date',
                  label: 'Hạn thanh toán',
                  align: 'center',
                  render: (row) => (
                    <span className="text-xs font-semibold text-primary-700 whitespace-nowrap">
                      {formatDate(row.due_date)}
                    </span>
                  ),
                },
                {
                  key: 'expected_rent',
                  label: 'Tiền thuê',
                  align: 'right',
                  render: (row) => formatMoney(row.expected_rent),
                },
                {
                  key: 'expected_fixed_services',
                  label: 'Dịch vụ cố định',
                  align: 'right',
                  render: (row) => formatMoney(row.expected_fixed_services),
                },
                {
                  key: 'expected_total',
                  label: 'Tổng tạm tính',
                  align: 'right',
                  render: (row) => (
                    <span className="font-bold text-slate-900">{formatMoney(row.expected_total)}</span>
                  ),
                },
                {
                  key: 'actual_invoice',
                  label: 'Hóa đơn thực tế',
                  align: 'center',
                  render: (row) =>
                    row.actual_invoice ? (
                      <Link
                        to={`/admin/invoices/${row.actual_invoice.id}`}
                        className="inline-flex flex-col items-center gap-0.5 hover:underline"
                      >
                        <StatusBadge status={row.actual_invoice.status} domain="invoice" />
                        {row.actual_invoice.invoice_code ? (
                          <span className="text-[11px] font-mono text-slate-600">
                            {row.actual_invoice.invoice_code} • {formatMoney(row.actual_invoice.total_amount)}
                          </span>
                        ) : null}
                      </Link>
                    ) : (
                      <Badge variant="slate">Dự kiến</Badge>
                    ),
                },
              ]}
            />
          </Card>
        </div>
      ) : null}

      {/* TAB 2: Người ở cùng */}
      {activeTab === 'occupants' ? (
        <div className="space-y-4">
          <div className="flex items-center justify-between flex-wrap gap-3">
            <div>
              <h3 className="text-sm font-semibold text-slate-900">Danh sách thành viên ở cùng</h3>
              <p className="text-xs text-slate-500">
                Gỡ thành viên khỏi hợp đồng sẽ không xóa cứng hồ sơ định danh cá nhân (NFR-016).
              </p>
            </div>
            {canManageOps ? (
              <Button variant="primary" size="sm" icon={UserPlus} onClick={() => setOccModalOpen(true)}>
                Thêm thành viên ở cùng
              </Button>
            ) : null}
          </div>

          <DataTable
            rowKey="tenant_id"
            data={occupants}
            emptyTitle="Chưa đăng ký người ở cùng"
            emptyDescription="Khách thuê chính đang lưu trú một mình hoặc chưa khai báo thêm thành viên."
            columns={[
              {
                key: 'full_name',
                label: 'Họ và tên',
                sortable: true,
                render: (row) => (
                  <Link
                    to={`/admin/tenants/${row.tenant_id}`}
                    className="font-semibold text-slate-900 hover:text-primary-600"
                  >
                    {row.full_name}
                  </Link>
                ),
              },
              {
                key: 'relationship',
                label: 'Quan hệ',
                align: 'center',
                render: (row) => {
                  const found = RELATIONSHIP_OPTIONS.find((o) => o.value === row.relationship);
                  return <Badge variant="indigo">{found ? found.label : row.relationship || 'Khác'}</Badge>;
                },
              },
              {
                key: 'phone',
                label: 'Số điện thoại',
                align: 'center',
                className: 'whitespace-nowrap',
                render: (row) => row.phone || '—',
              },
              {
                key: 'id_number',
                label: 'CCCD / Hồ sơ',
                align: 'center',
                className: 'whitespace-nowrap',
                render: (row) => (
                  <div className="flex flex-col items-center gap-1">
                    <span className="font-mono text-xs">{row.id_number || 'Chưa bổ sung'}</span>
                    {row.status === 'PENDING' || !row.id_number ? (
                      <Badge variant="amber">Chờ bổ sung CCCD</Badge>
                    ) : (
                      <Badge variant="emerald">Đã duyệt</Badge>
                    )}
                  </div>
                ),
              },
              {
                key: 'email',
                label: 'Email',
                render: (row) => row.email || '—',
              },
              {
                key: 'actions',
                label: 'Thao tác',
                align: 'center',
                render: (row) =>
                  canManageOps ? (
                    <Button
                      variant="ghost"
                      size="xs"
                      icon={Trash2}
                      className="text-rose-600 hover:text-rose-700 hover:bg-rose-50"
                      onClick={() => setRemoveOccTarget(row)}
                    >
                      Gỡ khỏi HĐ
                    </Button>
                  ) : null,
              },
            ]}
          />
        </div>
      ) : null}

      {/* TAB 3: Phụ lục hợp đồng */}
      {activeTab === 'amendments' ? (
        <div className="space-y-4">
          <div className="flex items-center justify-between flex-wrap gap-3">
            <div>
              <h3 className="text-sm font-semibold text-slate-900">Phụ lục điều chỉnh hợp đồng</h3>
              <p className="text-xs text-slate-500">
                Mọi thay đổi về giá thuê, tiền cọc hoặc ngày kết thúc sau khi ACTIVE đều lưu vết phiên bản và cần phê duyệt nội bộ Four-eyes (FR-016).
              </p>
            </div>
            {canManageOps && ['ACTIVE', 'RENEWAL_PENDING'].includes(contract.status) ? (
              <Button variant="primary" size="sm" icon={FilePlus2} onClick={handleOpenAmend}>
                Tạo phụ lục mới
              </Button>
            ) : null}
          </div>

          {amendments.length === 0 ? (
            <Card>
              <EmptyState
                icon={FilePlus2}
                title="Chưa có phụ lục hợp đồng"
                description="Khi cần điều chỉnh giá thuê, tiền cọc hoặc gia hạn kỳ hạn trên hợp đồng đang hiệu lực, hãy tạo phụ lục tại đây."
              />
            </Card>
          ) : (
            <div className="space-y-3">
              {amendments.map((ver) => {
                const diff = ver.diff || {};
                const isApproved = Boolean(ver.approved_by) || diff.status === 'APPROVED';
                const isRejected = diff.status === 'REJECTED';
                const isPending = !isApproved && !isRejected;

                const changedFields = ['end_date', 'rent_amount', 'deposit_amount', 'note'].filter(
                  (f) => diff[f] && typeof diff[f] === 'object'
                );

                const isAmendCreator = Boolean(
                  diff.created_by && currentUserId && String(diff.created_by) === String(currentUserId)
                );
                const canApproveThisAmend =
                  canApproveContractAmendments && (!isAmendCreator || allowSelfApproval);

                return (
                  <Card key={ver.id} className="p-5">
                    <div className="flex flex-wrap items-start justify-between gap-3 pb-3 border-b border-slate-100">
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-bold text-slate-900">
                            {diff.status === 'INITIAL_SNAPSHOT'
                              ? `Phiên bản gốc #${ver.version_no} (Khi kích hoạt)`
                              : `Phụ lục phiên bản #${ver.version_no}`}
                          </span>
                          {isApproved ? (
                            <Badge variant="emerald" dot>
                              Đã phê duyệt
                            </Badge>
                          ) : isRejected ? (
                            <Badge variant="red" dot>
                              Đã từ chối
                            </Badge>
                          ) : (
                            <Badge variant="amber" dot>
                              Chờ phê duyệt
                            </Badge>
                          )}
                        </div>
                        <p className="text-xs text-slate-500 mt-1">
                          Hiệu lực từ: <strong>{formatDate(ver.effective_from)}</strong> • Ngày tạo:{' '}
                          {formatDateTime(ver.created_at)}
                          {ver.approved_by_name ? ` • Người duyệt: ${ver.approved_by_name}` : ''}
                        </p>
                      </div>

                      {isPending && canApproveThisAmend ? (
                        <div className="flex items-center gap-2">
                          <Button
                            variant="outline"
                            size="xs"
                            icon={XCircle}
                            onClick={() => {
                              setRejectAmendTarget(ver);
                              setRejectAmendReason('');
                            }}
                          >
                            Từ chối
                          </Button>
                          <Button
                            variant="success"
                            size="xs"
                            icon={CheckCircle2}
                            onClick={() => handleApproveAmendment(ver.id)}
                          >
                            Phê duyệt phụ lục
                          </Button>
                        </div>
                      ) : isPending && canApproveContractAmendments && isAmendCreator ? (
                        <span className="text-[11px] font-medium text-amber-700 bg-amber-50 border border-amber-200 px-2.5 py-1 rounded-lg">
                          Chờ Quản lý khác duyệt (Four-eyes)
                        </span>
                      ) : null}
                    </div>

                    <div className="mt-3 space-y-2">
                      <p className="text-xs text-slate-700">
                        <strong>Lý do điều chỉnh:</strong> {ver.reason || '—'}
                      </p>

                      {changedFields.length > 0 ? (
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 pt-1">
                          {changedFields.map((field) => (
                            <div
                              key={field}
                              className="p-2.5 rounded-lg bg-slate-50 border border-slate-200/70 text-xs flex items-center justify-between gap-2"
                            >
                              <span className="font-medium text-slate-600">
                                {DIFF_FIELD_LABELS[field] || field}:
                              </span>
                              <span className="text-right">
                                <span className="line-through text-slate-400 mr-1.5">
                                  {formatDiffVal(field, diff[field].old)}
                                </span>
                                <span className="font-bold text-primary-700">
                                  → {formatDiffVal(field, diff[field].new)}
                                </span>
                              </span>
                            </div>
                          ))}
                        </div>
                      ) : null}

                      {isRejected && diff.rejection_reason ? (
                        <div className="p-2.5 rounded-lg bg-rose-50 border border-rose-200 text-xs text-rose-700 space-y-0.5">
                          <p>
                            <strong>Lý do từ chối:</strong> {diff.rejection_reason}
                          </p>
                          {diff.rejected_at ? (
                            <p className="text-[11px] text-rose-500">
                              Thời gian từ chối: {formatDateTime(diff.rejected_at)}
                            </p>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  </Card>
                );
              })}
            </div>
          )}
        </div>
      ) : null}

      {/* TAB 4: Chuỗi lịch sử gia hạn / chuyển phòng & Biểu phí dịch vụ */}
      {activeTab === 'credits' ? (
        <div className="space-y-6">
          <Card>
            <CardHeader
              title="Sổ số dư tín dụng & Hoàn tiền trực tiếp (Credit Ledger)"
              subtitle="Theo dõi các khoản tiền nộp thừa, hoàn tiền dịch vụ và thực hiện quy trình hoàn tiền trực tiếp 4 mắt (FR-040)"
              action={
                Number(contract?.available_credit_balance || 0) > 0 ? (
                  <Badge variant="emerald">
                    Khả dụng: {formatMoney(contract.available_credit_balance)}
                  </Badge>
                ) : (
                  <Badge variant="slate">Số dư: 0 ₫</Badge>
                )
              }
            />

            {(contract?.credit_balances || []).length === 0 ? (
              <EmptyState
                icon={Sparkles}
                title="Chưa có bản ghi số dư tín dụng"
                subtitle="Hợp đồng này hiện chưa phát sinh khoản tiền nộp thừa hoặc hoàn tiền dịch vụ nào."
              />
            ) : (
              <DataTable
                rowKey="id"
                data={contract.credit_balances}
                columns={[
                  {
                    key: 'created_at',
                    label: 'Thời gian',
                    render: (row) => (
                      <span className="text-xs font-mono text-slate-700">
                        {formatDateTime(row.created_at)}
                      </span>
                    ),
                  },
                  {
                    key: 'amount',
                    label: 'Số tiền gốc',
                    align: 'right',
                    render: (row) => (
                      <span className="font-semibold text-slate-900">{formatMoney(row.amount)}</span>
                    ),
                  },
                  {
                    key: 'applied_amount',
                    label: 'Đã cấn trừ',
                    align: 'right',
                    render: (row) => (
                      <span className="text-slate-600">{formatMoney(row.applied_amount || 0)}</span>
                    ),
                  },
                  {
                    key: 'settlement_refund_amount',
                    label: 'Hoàn quyết toán',
                    align: 'right',
                    render: (row) => (
                      <span className="text-slate-600">{formatMoney(row.settlement_refund_amount || 0)}</span>
                    ),
                  },
                  {
                    key: 'remaining',
                    label: 'Còn lại khả dụng',
                    align: 'right',
                    render: (row) => {
                      const rem = Math.max(
                        0,
                        Number(row.amount || 0) - Number(row.applied_amount || 0) - Number(row.settlement_refund_amount || 0)
                      );
                      return (
                        <span className="font-bold text-emerald-700">{formatMoney(rem)}</span>
                      );
                    },
                  },
                  {
                    key: 'reason_type',
                    label: 'Lý do / Mô tả',
                    render: (row) => (
                      <div className="text-xs">
                        <p className="font-medium text-slate-800">{row.description || row.reason_type}</p>
                        <p className="text-[11px] text-slate-400 font-mono">{row.reason_type}</p>
                      </div>
                    ),
                  },
                  {
                    key: 'status',
                    label: 'Trạng thái',
                    align: 'center',
                    render: (row) => (
                      <StatusBadge status={row.status} domain="credit_balance" />
                    ),
                  },
                  {
                    key: 'actions',
                    label: 'Thao tác 4 mắt',
                    align: 'right',
                    render: (row) => {
                      const rem = Math.max(
                        0,
                        Number(row.amount || 0) - Number(row.applied_amount || 0) - Number(row.settlement_refund_amount || 0)
                      );
                      const canApprove = canActorApproveCreditRefund({
                        actor: user,
                        record: row,
                        buildingHasActiveOwner: true,
                        allowSelfApproval,
                      });

                      if (['AVAILABLE', 'PARTIALLY_APPLIED'].includes(row.status) && rem > 0) {
                        return (
                          <Button
                            size="xs"
                            variant="outline"
                            onClick={() => handleOpenCreditRefundModal(row)}
                          >
                            Đề nghị hoàn tiền
                          </Button>
                        );
                      }

                      if (row.status === 'PENDING_DIRECT_REFUND') {
                        return (
                          <div className="flex items-center justify-end gap-1.5">
                            {canApprove ? (
                              <>
                                <Button
                                  size="xs"
                                  variant="primary"
                                  loading={approvingCreditId === row.id}
                                  onClick={() => handleApproveCreditRefund(row)}
                                >
                                  Duyệt hoàn
                                </Button>
                                <Button
                                  size="xs"
                                  variant="danger"
                                  onClick={() => handleOpenCreditRejectModal(row)}
                                >
                                  Từ chối
                                </Button>
                              </>
                            ) : (
                              <Badge variant="amber">Chờ quản lý khác duyệt</Badge>
                            )}
                          </div>
                        );
                      }

                      return <span className="text-xs text-slate-400">—</span>;
                    },
                  },
                ]}
              />
            )}
          </Card>
        </div>
      ) : null}

      {activeTab === 'history' ? (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          <Card className="lg:col-span-7">
            <CardHeader
              title="Chuỗi hợp đồng liên kết (Gia hạn / Chuyển phòng)"
              subtitle="Truy vết lịch sử nối tiếp qua parent_contract_id"
            />
            {relatedContracts.length === 0 ? (
              <EmptyState
                icon={History}
                title="Hợp đồng gốc độc lập"
                description="Chưa có hợp đồng tiền nhiệm hoặc hợp đồng gia hạn nối tiếp nào gắn với hợp đồng này."
              />
            ) : (
              <div className="space-y-2.5">
                {relatedContracts.map((rc) => {
                  const isParent = String(rc.id) === String(contract.parent_contract_id);
                  const isChild = String(rc.parent_contract_id) === String(contract.id);
                  return (
                    <div
                      key={rc.id}
                      className="p-3.5 rounded-xl border border-slate-200 hover:border-primary-300 bg-slate-50/60 flex items-center justify-between gap-3 transition-colors"
                    >
                      <div>
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-mono text-xs font-bold text-primary-700">
                            HĐ-{String(rc.id).slice(0, 8).toUpperCase()}
                          </span>
                          <Badge variant="sky">Căn {rc.apartment_code}</Badge>
                          <StatusBadge status={rc.status} domain="contract" />
                          {isParent ? (
                            <Badge variant="slate">Hợp đồng tiền nhiệm</Badge>
                          ) : isChild ? (
                            <Badge variant="indigo">Hợp đồng nối tiếp</Badge>
                          ) : null}
                        </div>
                        <p className="text-xs text-slate-600 mt-1">
                          Kỳ hạn: {formatDate(rc.start_date)} → {formatDate(rc.end_date)} • Giá thuê:{' '}
                          <strong>{formatMoney(rc.rent_amount)}</strong>
                        </p>
                      </div>
                      <Button
                        variant="outline"
                        size="xs"
                        rightIcon={ExternalLink}
                        onClick={() => navigate(`/admin/contracts/${rc.id}`)}
                      >
                        Xem HĐ
                      </Button>
                    </div>
                  );
                })}
              </div>
            )}
          </Card>

          <Card className="lg:col-span-5">
            <CardHeader
              title="Đơn giá dịch vụ riêng"
              subtitle="Áp dụng riêng cho hợp đồng này (FR-065)"
              action={
                canManageOps ? (
                  <Button
                    variant="soft"
                    size="xs"
                    icon={Plus}
                    onClick={() => {
                      setSpForm({
                        service_code: 'INTERNET',
                        unit_price: '',
                        effective_from: toInputDate(contract.start_date),
                      });
                      setSpModalOpen(true);
                    }}
                  >
                    Thêm giá riêng
                  </Button>
                ) : null
              }
            />
            {servicePrices.length === 0 ? (
              <p className="text-xs text-slate-500 py-6 text-center italic">
                Đang áp dụng biểu phí dịch vụ tiêu chuẩn của tòa nhà.
              </p>
            ) : (
              <div className="space-y-2">
                {servicePrices.map((sp) => (
                  <div
                    key={sp.id}
                    className="p-3 rounded-lg border border-slate-200 flex items-center justify-between gap-2 text-xs"
                  >
                    <div>
                      <p className="font-semibold text-slate-800">
                        {SERVICE_CODE_OPTIONS.find((opt) => opt.value === sp.service_code)?.label || sp.service_code}
                      </p>
                      <p className="text-slate-500">
                        Hiệu lực từ: {formatDate(sp.effective_from)}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="font-bold text-slate-900">{formatMoney(sp.unit_price)}</span>
                      {canManageOps ? (
                        <button
                          type="button"
                          onClick={() => handleDeleteServicePrice(sp.id)}
                          className="p-1 text-slate-400 hover:text-rose-600 rounded"
                          title="Xóa"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>
      ) : null}

      {/* Modal Xem bản scan phóng to (Ảnh hoặc PDF) */}
      <Modal
        open={Boolean(previewScanItem)}
        onClose={() => setPreviewScanItem(null)}
        title={`Bản scan hợp đồng ${contractCode}`}
        size="lg"
        footer={
          <Button variant="outline" onClick={() => setPreviewScanItem(null)}>
            Đóng
          </Button>
        }
      >
        <div className="flex items-center justify-center bg-slate-900/5 rounded-xl p-2 min-h-[320px]">
          {previewScanItem ? (
            previewScanItem.isPdf ? (
              <AuthPdfViewer
                src={previewScanItem.src}
                title={`Bản scan PDF hợp đồng ${contractCode}`}
                className="w-full h-[72vh] rounded-lg border border-slate-200 bg-white"
              />
            ) : (
              <AuthImage
                src={previewScanItem.src}
                alt="Bản scan hợp đồng"
                className="max-h-[72vh] w-auto rounded-lg object-contain"
              />
            )
          ) : null}
        </div>
      </Modal>

      {/* Modal Sửa hợp đồng nháp */}
      <Modal
        open={editDraftOpen}
        onClose={() => setEditDraftOpen(false)}
        title="Chỉnh sửa hợp đồng nháp"
        subtitle="Chỉ hợp đồng ở trạng thái DRAFT mới được chỉnh sửa trực tiếp"
        size="xl"
        footer={
          <>
            <Button variant="outline" onClick={() => setEditDraftOpen(false)} disabled={savingDraft}>
              Hủy
            </Button>
            <Button
              variant="primary"
              onClick={handleSaveDraft}
              loading={savingDraft}
              disabled={Boolean(draftStartDateError || draftEndDateError)}
            >
              Lưu cập nhật
            </Button>
          </>
        }
      >
        <form onSubmit={handleSaveDraft} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <Input
              label="Ngày bắt đầu"
              type="date"
              required
              value={editDraftForm.start_date}
              onChange={(e) => setEditDraftForm((p) => ({ ...p, start_date: e.target.value }))}
              error={draftStartDateError}
            />
            <Input
              label="Ngày kết thúc"
              type="date"
              required
              min={editDraftForm.start_date ? addDaysStr(editDraftForm.start_date, 1) : undefined}
              value={editDraftForm.end_date}
              onChange={(e) => setEditDraftForm((p) => ({ ...p, end_date: e.target.value }))}
              error={draftEndDateError}
            />
            <MoneyInput
              label="Giá thuê / tháng (VND)"
              required
              placeholder="VD: 8.500.000"
              value={editDraftForm.rent_amount}
              onChange={(e) => setEditDraftForm((p) => ({ ...p, rent_amount: e.target.value }))}
            />
            <MoneyInput
              label="Tiền đặt cọc (VND)"
              placeholder="VD: 8.500.000"
              value={editDraftForm.deposit_amount}
              onChange={(e) => setEditDraftForm((p) => ({ ...p, deposit_amount: e.target.value }))}
            />
            <Select
              label="Chu kỳ thanh toán"
              value={editDraftForm.billing_cycle}
              onChange={(e) => setEditDraftForm((p) => ({ ...p, billing_cycle: e.target.value }))}
              options={[
                { value: 'monthly', label: 'Hàng tháng' },
                { value: 'quarterly', label: '3 tháng / lần' },
              ]}
            />
            <Input
              label="Ngày chốt hóa đơn (1–31)"
              type="number"
              min="1"
              max="31"
              hint="Tháng thiếu ngày tự lùi về cuối tháng"
              value={editDraftForm.billing_day}
              onChange={(e) => setEditDraftForm((p) => ({ ...p, billing_day: e.target.value }))}
            />
            <Input
              label="Hạn thanh toán (ngày sau phát hành)"
              type="number"
              min="1"
              max="60"
              hint="Mặc định 5 ngày (1–60 ngày)"
              value={editDraftForm.payment_due_days}
              onChange={(e) => setEditDraftForm((p) => ({ ...p, payment_due_days: e.target.value }))}
            />
          </div>
          <div className="p-3.5 rounded-xl border border-slate-200 bg-slate-50/70 space-y-3">
            <div>
              <p className="text-xs font-semibold text-slate-800">
                Dịch vụ đi kèm &amp; Đơn giá Điện/Nước riêng theo hợp đồng
              </p>
              <p className="text-[11px] text-slate-500 mt-0.5">
                Cập nhật các dịch vụ định kỳ (sẽ tự động kích hoạt khi hợp đồng sang ACTIVE) và đơn giá Điện/Nước thỏa thuận riêng
              </p>
            </div>

            {selectableDraftServices.length > 0 ? (
              <div className="space-y-2">
                {selectableDraftServices.map((svc) => {
                  const parking = isParkingService(svc);
                  const multiQty = allowsMultiQuantity(svc);
                  const svcErr = draftServiceErrors[svc.id] || {};
                  const cfg = draftSelectedServices[svc.id] || {
                    checked: false,
                    is_parking: parking,
                    billing_type: svc.billing_type,
                    quantity: '1',
                    unit_price: String(Math.round(Number(svc.unit_price || 0))),
                    vehicle_plates: [''],
                    note: '',
                  };
                  return (
                    <div
                      key={svc.id}
                      className={`p-2.5 rounded-lg border transition-colors ${
                        cfg.checked
                          ? 'bg-white border-primary-300 shadow-xs'
                          : 'bg-white/70 border-slate-200'
                      }`}
                    >
                      <div className="grid grid-cols-1 sm:grid-cols-12 gap-3.5 items-center">
                        <label className="sm:col-span-5 flex items-start gap-2.5 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={Boolean(cfg.checked)}
                            onChange={(e) => {
                              const checked = e.target.checked;
                              const nextQty = draftSelectedServices[svc.id]?.quantity || '1';
                              setDraftSelectedServices((prev) => ({
                                ...prev,
                                [svc.id]: {
                                  checked,
                                  is_parking: parking,
                                  billing_type: svc.billing_type,
                                  quantity: nextQty,
                                  unit_price:
                                    prev[svc.id]?.unit_price !== undefined
                                      ? prev[svc.id].unit_price
                                      : String(Math.round(Number(svc.unit_price || 0))),
                                  vehicle_plates: parking
                                    ? syncVehiclePlatesArray(prev[svc.id]?.vehicle_plates, nextQty)
                                    : [],
                                  note: prev[svc.id]?.note || '',
                                },
                              }));
                            }}
                            className="mt-0.5 rounded border-slate-300 text-primary-600 focus:ring-primary-500"
                          />
                          <div className="text-xs">
                            <p className="font-semibold text-slate-800">
                              {svc.name}{' '}
                              <span className="font-mono text-[11px] text-slate-400">({svc.code})</span>
                            </p>
                            <p className="text-[11px] text-slate-500">
                              Niêm yết: {formatMoney(svc.unit_price)} / {svc.unit || 'tháng'}
                            </p>
                          </div>
                        </label>

                        {cfg.checked ? (
                          <>
                            <div className="sm:col-span-3">
                              {multiQty ? (
                                <Input
                                  label="Số lượng"
                                  type="number"
                                  min="1"
                                  max={parking ? MAX_PARKING_QUANTITY : undefined}
                                  error={svcErr.quantityError || ''}
                                  value={cfg.quantity}
                                  onChange={(e) => {
                                    const nextQty = e.target.value;
                                    setDraftSelectedServices((prev) => ({
                                      ...prev,
                                      [svc.id]: {
                                        ...cfg,
                                        is_parking: parking,
                                        billing_type: svc.billing_type,
                                        quantity: nextQty,
                                        vehicle_plates: parking
                                          ? syncVehiclePlatesArray(cfg.vehicle_plates, nextQty)
                                          : [],
                                      },
                                    }));
                                    setDraftServiceErrors((prev) => {
                                      if (!prev[svc.id]) return prev;
                                      const next = { ...prev };
                                      delete next[svc.id];
                                      return next;
                                    });
                                  }}
                                />
                              ) : (
                                <div className="text-[11px] text-slate-400 sm:pt-5 text-center">1 gói</div>
                              )}
                            </div>
                            <div className="sm:col-span-4">
                              <MoneyInput
                                label="Đơn giá áp dụng (VND)"
                                value={cfg.unit_price}
                                onChange={(e) =>
                                  setDraftSelectedServices((prev) => ({
                                    ...prev,
                                    [svc.id]: { ...cfg, unit_price: e.target.value },
                                  }))
                                }
                              />
                            </div>
                          </>
                        ) : null}
                      </div>

                      {cfg.checked ? (
                        <div className="mt-2.5 pt-2.5 border-t border-slate-100">
                          <ServiceSubscriptionMetaFields
                            isParking={parking}
                            quantity={multiQty ? cfg.quantity : 1}
                            vehiclePlates={cfg.vehicle_plates}
                            note={cfg.note || ''}
                            plateErrors={svcErr.plateErrors || []}
                            noteError={svcErr.noteError || ''}
                            onPlateChange={(plateIdx, val) => {
                              const nextPlates = syncVehiclePlatesArray(
                                cfg.vehicle_plates,
                                multiQty ? cfg.quantity : 1
                              );
                              nextPlates[plateIdx] = val;
                              setDraftSelectedServices((prev) => ({
                                ...prev,
                                [svc.id]: {
                                  ...cfg,
                                  is_parking: parking,
                                  billing_type: svc.billing_type,
                                  vehicle_plates: nextPlates,
                                },
                              }));
                              setDraftServiceErrors((prev) => {
                                if (!prev[svc.id]) return prev;
                                const next = { ...prev };
                                delete next[svc.id];
                                return next;
                              });
                            }}
                            onNoteChange={(val) => {
                              setDraftSelectedServices((prev) => ({
                                ...prev,
                                [svc.id]: { ...cfg, note: val },
                              }));
                              setDraftServiceErrors((prev) => {
                                if (!prev[svc.id]) return prev;
                                const next = { ...prev };
                                delete next[svc.id];
                                return next;
                              });
                            }}
                          />
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="text-xs text-slate-500 italic">
                Chưa có dịch vụ định kỳ nào trong danh mục hoạt động của tòa nhà.
              </p>
            )}

            <div className="pt-2 border-t border-slate-200/80 grid grid-cols-1 sm:grid-cols-2 gap-3">
              <MoneyInput
                label="Đơn giá Điện riêng theo HĐ (VND/kWh)"
                placeholder="Để trống = theo giá đồng hồ tòa nhà"
                value={draftCustomMeterPrices.ELECTRICITY}
                onChange={(e) =>
                  setDraftCustomMeterPrices((p) => ({ ...p, ELECTRICITY: e.target.value }))
                }
              />
              <MoneyInput
                label="Đơn giá Nước riêng theo HĐ (VND/m³)"
                placeholder="Để trống = theo giá đồng hồ tòa nhà"
                value={draftCustomMeterPrices.WATER}
                onChange={(e) =>
                  setDraftCustomMeterPrices((p) => ({ ...p, WATER: e.target.value }))
                }
              />
            </div>
          </div>

          <Input
            label="Ghi chú"
            multiline
            rows={2}
            value={editDraftForm.note}
            onChange={(e) => setEditDraftForm((p) => ({ ...p, note: e.target.value }))}
          />
        </form>
      </Modal>

      {/* Modal Hủy nháp */}
      <Modal
        open={cancelOpen}
        onClose={() => setCancelOpen(false)}
        title="Hủy hợp đồng nháp"
        size="sm"
        footer={
          <>
            <Button variant="outline" onClick={() => setCancelOpen(false)} disabled={cancelling}>
              Đóng
            </Button>
            <Button variant="danger" onClick={handleCancelDraft} loading={cancelling}>
              Xác nhận hủy nháp
            </Button>
          </>
        }
      >
        <Input
          label="Lý do hủy hợp đồng nháp"
          multiline
          rows={3}
          placeholder="Nhập lý do hủy nháp..."
          value={cancelReason}
          onChange={(e) => setCancelReason(e.target.value)}
        />
      </Modal>

      {/* Modal Gia hạn hợp đồng nối tiếp (renew) */}
      <Modal
        open={renewOpen}
        onClose={() => setRenewOpen(false)}
        title="Gia hạn hợp đồng (Tạo hợp đồng nối tiếp)"
        subtitle={`Kỳ hạn mới sẽ nối tiếp từ ngày ${formatDate(contract.end_date)} và liên kết parent_contract_id (FR-015)`}
        size="md"
        footer={
          <>
            <Button variant="outline" onClick={() => setRenewOpen(false)} disabled={submittingRenew}>
              Hủy bỏ
            </Button>
            <Button
              variant="primary"
              onClick={handleRenewSubmit}
              loading={submittingRenew}
              disabled={Boolean(renewEndDateError)}
              icon={RefreshCw}
            >
              Tạo HĐ gia hạn
            </Button>
          </>
        }
      >
        <form onSubmit={handleRenewSubmit} className="space-y-4">
          <Input
            label="Ngày kết thúc mới"
            type="date"
            required
            min={contractEndStr ? addDaysStr(contractEndStr, 1) : undefined}
            value={renewForm.new_end_date}
            onChange={(e) => setRenewForm((p) => ({ ...p, new_end_date: e.target.value }))}
            error={renewEndDateError}
            hint={`Phải sau ngày kết thúc hiện tại (${formatDate(contract.end_date)})`}
          />
          <div className="flex items-center gap-2">
            {[6, 12, 24].map((m) => (
              <button
                key={m}
                type="button"
                onClick={() =>
                  setRenewForm((p) => ({
                    ...p,
                    new_end_date: addMonthsStr(toInputDate(contract.end_date), m),
                  }))
                }
                className="px-2.5 py-1 text-xs rounded-md bg-slate-100 hover:bg-primary-50 text-slate-700 hover:text-primary-700 border border-slate-200"
              >
                +{m} tháng
              </button>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-4">
            <MoneyInput
              label="Giá thuê kỳ mới (VND)"
              required
              placeholder="VD: 8.500.000"
              value={renewForm.rent_amount}
              onChange={(e) => setRenewForm((p) => ({ ...p, rent_amount: e.target.value }))}
            />
            <MoneyInput
              label="Tiền cọc kỳ mới (VND)"
              placeholder="VD: 8.500.000"
              value={renewForm.deposit_amount}
              onChange={(e) => setRenewForm((p) => ({ ...p, deposit_amount: e.target.value }))}
            />
          </div>
          <Input
            label="Ghi chú gia hạn"
            multiline
            rows={2}
            value={renewForm.note}
            onChange={(e) => setRenewForm((p) => ({ ...p, note: e.target.value }))}
          />
        </form>
      </Modal>

      {/* Modal Lập phụ lục điều chỉnh */}
      <Modal
        open={amendOpen}
        onClose={() => setAmendOpen(false)}
        title="Lập phụ lục điều chỉnh hợp đồng"
        subtitle="Đề xuất điều chỉnh giá thuê, tiền cọc hoặc ngày kết thúc trình cấp thẩm quyền nội bộ phê duyệt (FR-016)"
        size="md"
        footer={
          <>
            <Button variant="outline" onClick={() => setAmendOpen(false)} disabled={submittingAmend}>
              Hủy bỏ
            </Button>
            <Button
              variant="primary"
              onClick={handleAmendSubmit}
              loading={submittingAmend}
              disabled={Boolean(amendEffectiveDateError || amendEndDateError)}
              icon={FilePlus2}
            >
              Gửi đề xuất phụ lục
            </Button>
          </>
        }
      >
        <form onSubmit={handleAmendSubmit} className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <MoneyInput
              label="Giá thuê mới (VND)"
              placeholder="VD: 8.500.000"
              value={amendForm.rent_amount}
              onChange={(e) => setAmendForm((p) => ({ ...p, rent_amount: e.target.value }))}
              hint={`Hiện tại: ${formatMoney(contract.rent_amount)}`}
            />
            <MoneyInput
              label="Tiền cọc mới (VND)"
              placeholder="VD: 8.500.000"
              value={amendForm.deposit_amount}
              onChange={(e) => setAmendForm((p) => ({ ...p, deposit_amount: e.target.value }))}
              hint={`Hiện tại: ${formatMoney(contract.deposit_amount)}`}
            />
            <Input
              label="Ngày bắt đầu áp dụng phụ lục"
              type="date"
              required
              min={contractStartStr || undefined}
              value={amendForm.effective_from}
              onChange={(e) => setAmendForm((p) => ({ ...p, effective_from: e.target.value }))}
              error={amendEffectiveDateError}
            />
            <Input
              label="Ngày kết thúc mới"
              type="date"
              min={minAmendEndDate || undefined}
              value={amendForm.end_date}
              onChange={(e) => setAmendForm((p) => ({ ...p, end_date: e.target.value }))}
              error={amendEndDateError}
              hint={`Hiện tại: ${formatDate(contract.end_date)}`}
            />
          </div>
          <Input
            label="Lý do lập phụ lục"
            required
            multiline
            rows={2}
            placeholder="VD: Điều chỉnh giá thuê theo thỏa thuận năm thứ 2..."
            value={amendForm.reason}
            onChange={(e) => setAmendForm((p) => ({ ...p, reason: e.target.value }))}
          />
        </form>
      </Modal>

      {/* Modal Từ chối phụ lục */}
      <Modal
        open={Boolean(rejectAmendTarget)}
        onClose={() => setRejectAmendTarget(null)}
        title={`Từ chối Phụ lục #${rejectAmendTarget?.version_no || ''}`}
        size="sm"
        footer={
          <>
            <Button
              variant="outline"
              onClick={() => setRejectAmendTarget(null)}
              disabled={submittingRejectAmend}
            >
              Hủy
            </Button>
            <Button
              variant="danger"
              onClick={handleRejectAmendmentSubmit}
              loading={submittingRejectAmend}
            >
              Xác nhận từ chối
            </Button>
          </>
        }
      >
        <Input
          label="Lý do từ chối phụ lục"
          required
          multiline
          rows={3}
          placeholder="Nhập lý do từ chối..."
          value={rejectAmendReason}
          onChange={(e) => setRejectAmendReason(e.target.value)}
        />
      </Modal>

      {/* Modal Khởi tạo Hợp đồng Đổi phòng (FR-013, FR-025, AC-009.2) */}
      <Modal
        open={transferOpen}
        onClose={() => setTransferOpen(false)}
        title="Đổi phòng & Kết chuyển cọc (Quy trình 4 mắt)"
        subtitle={`Khởi tạo hợp đồng nháp (DRAFT) cho căn mới cùng tòa; hợp đồng căn ${contract.apartment_code} vẫn giữ hiệu lực cho tới khi tải bản scan ký kết và Chủ sở hữu phê duyệt (FR-013, AC-009.2)`}
        size="md"
        footer={
          <>
            <Button variant="outline" onClick={() => setTransferOpen(false)} disabled={submittingTransfer}>
              Hủy bỏ
            </Button>
            <Button
              variant="primary"
              onClick={handleTransferSubmit}
              loading={submittingTransfer}
              disabled={Boolean(transferStartDateError || transferEndDateError)}
              icon={ArrowRightLeft}
            >
              Tạo nháp HĐ đổi phòng
            </Button>
          </>
        }
      >
        <form onSubmit={handleTransferSubmit} className="space-y-4">
          <Select
            label={`Chọn căn hộ trống (AVAILABLE) tại ${contract.building_name}`}
            required
            placeholder={
              loadingApts
                ? 'Đang tải danh sách căn trống...'
                : availableApts.length === 0
                ? 'Không còn căn trống (AVAILABLE) nào cùng tòa'
                : '-- Chọn căn hộ chuyển đến --'
            }
            value={transferForm.new_apartment_id}
            onChange={(e) => {
              userEditedTransferDatesRef.current = false;
              const aptId = e.target.value;
              const apt = availableApts.find((a) => String(a.id) === String(aptId));
              setTransferForm((p) => ({
                ...p,
                new_apartment_id: aptId,
                new_rent_amount: apt?.base_rent
                  ? String(Math.round(Number(apt.base_rent)))
                  : p.new_rent_amount,
              }));
            }}
            options={availableApts.map((a) => ({
              value: a.id,
              label: `Căn ${a.code} — ${a.area_m2 || '—'}m² — Giá niêm yết: ${formatMoney(a.base_rent)}`,
            }))}
          />

          {earliestTransferStart && earliestTransferStart > todayStr ? (
            <div className="p-2.5 rounded-xl bg-amber-50 border border-amber-200 text-xs text-amber-900 flex items-start gap-2">
              <Clock className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
              <span>
                Căn hộ đích đang có lịch giữ chỗ / hợp đồng dự kiến — hệ thống đã tự gợi ý ngày chuyển phòng trống gần nhất:{' '}
                <strong>{formatDateVi(earliestTransferStart)}</strong>.
              </span>
            </div>
          ) : null}

          <div className="grid grid-cols-2 gap-4">
            <Input
              label="Ngày chuyển phòng"
              type="date"
              required
              min={
                maxDateStr(
                  minTerminateDate,
                  earliestTransferStart && earliestTransferStart > todayStr ? earliestTransferStart : ''
                ) || undefined
              }
              value={transferForm.new_start_date}
              onChange={(e) => {
                userEditedTransferDatesRef.current = true;
                setTransferForm((p) => ({ ...p, new_start_date: e.target.value }));
              }}
              error={transferStartDateError}
            />
            <Input
              label="Ngày kết thúc HĐ mới"
              type="date"
              required
              min={transferForm.new_start_date ? addDaysStr(transferForm.new_start_date, 1) : undefined}
              value={transferForm.new_end_date}
              onChange={(e) => {
                userEditedTransferDatesRef.current = true;
                setTransferForm((p) => ({ ...p, new_end_date: e.target.value }));
              }}
              error={transferEndDateError}
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <MoneyInput
              label="Giá thuê căn hộ mới (VND / tháng)"
              required
              placeholder="VD: 8.500.000"
              value={transferForm.new_rent_amount}
              onChange={(e) => setTransferForm((p) => ({ ...p, new_rent_amount: e.target.value }))}
            />
            <MoneyInput
              label="Tiền đặt cọc hợp đồng mới (VND)"
              placeholder="VD: 8.500.000"
              value={transferForm.new_deposit_amount}
              onChange={(e) => setTransferForm((p) => ({ ...p, new_deposit_amount: e.target.value }))}
            />
          </div>

          {(() => {
            const chosenApt = availableApts.find(
              (a) => String(a.id) === String(transferForm.new_apartment_id)
            );
            const propRent = Math.round(Number(transferForm.new_rent_amount || 0));
            if (
              chosenApt?.base_rent &&
              Number(chosenApt.base_rent) > 0 &&
              propRent > 0 &&
              propRent < Number(chosenApt.base_rent) * 0.9
            ) {
              return (
                <div className="p-2.5 rounded-xl bg-amber-50 border border-amber-200 text-xs text-amber-900 flex items-start gap-2">
                  <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
                  <span>
                    Giá thuê đề xuất thấp hơn 90% giá niêm yết ({formatMoney(chosenApt.base_rent)}). Bản nháp vẫn được tạo và sẽ do <strong>Chủ sở hữu tòa nhà (OWNER)</strong> phê duyệt đồng thời ở bước duyệt đổi phòng (FR-013).
                  </span>
                </div>
              );
            }
            return null;
          })()}

          <label className="flex items-start gap-2.5 p-3 rounded-xl bg-sky-50 border border-sky-200 cursor-pointer">
            <input
              type="checkbox"
              checked={transferForm.transfer_deposit}
              onChange={(e) =>
                setTransferForm((p) => ({ ...p, transfer_deposit: e.target.checked }))
              }
              className="mt-0.5 rounded border-slate-300 text-primary-600 focus:ring-primary-500"
            />
            <div className="text-xs text-sky-900">
              <p className="font-semibold">Tự động kết chuyển sổ cọc hiện tại sang hợp đồng mới khi được phê duyệt</p>
              <p className="text-sky-700 mt-0.5">
                Khi Chủ sở hữu phê duyệt, hệ thống tự động kết chuyển cọc sang hợp đồng mới (phần cọc dư nếu hạ cấp phòng sẽ giữ trên sổ cọc cũ kèm hạn hoàn 5 ngày).
              </p>
            </div>
          </label>

          <Input
            label="Ghi chú chuyển phòng"
            multiline
            rows={2}
            placeholder="Lý do đổi căn, thỏa thuận chênh lệch..."
            value={transferForm.note}
            onChange={(e) => setTransferForm((p) => ({ ...p, note: e.target.value }))}
          />
        </form>
      </Modal>

      {/* Modal Thanh lý / Chấm dứt hợp đồng trực tiếp (MANAGER / SYS_ADMIN) */}
      <Modal
        open={terminateOpen}
        onClose={() => setTerminateOpen(false)}
        title="Thanh lý / Chấm dứt hợp đồng"
        subtitle="Chấm dứt hiệu lực hợp đồng ngay lập tức, đồng bộ trạng thái căn hộ và mở hạn hoàn cọc 5 ngày (FR-017, FR-068)"
        size="md"
        footer={
          <>
            <Button variant="outline" onClick={() => setTerminateOpen(false)} disabled={submittingTerminate}>
              Hủy bỏ
            </Button>
            <Button
              variant="danger"
              onClick={handleTerminateSubmit}
              loading={submittingTerminate}
              disabled={Boolean(terminateDateError)}
            >
              Xác nhận chấm dứt hợp đồng
            </Button>
          </>
        }
      >
        <form onSubmit={handleTerminateSubmit} className="space-y-4">
          <Input
            label="Ngày chấm dứt hợp đồng"
            type="date"
            required
            min={minTerminateDate || undefined}
            max={contractEndStr || undefined}
            value={terminateForm.terminated_date}
            onChange={(e) => setTerminateForm((p) => ({ ...p, terminated_date: e.target.value }))}
            error={terminateDateError}
            hint={
              contractStartStr > todayStr
                ? `Hợp đồng tương lai (chưa nhận phòng): có thể thanh lý từ hôm nay đến ${formatDate(contract.end_date)}`
                : `Phải nằm trong kỳ hạn hợp đồng (${formatDate(contract.start_date)} – ${formatDate(contract.end_date)})`
            }
          />
          <Input
            label="Lý do chấm dứt (Bắt buộc ghi Audit Log)"
            required
            value={terminateForm.reason}
            onChange={(e) => setTerminateForm((p) => ({ ...p, reason: e.target.value }))}
          />
          <Input
            label="Ghi chú bàn giao"
            multiline
            rows={2}
            placeholder="Tình trạng sơ bộ, lịch hẹn kiểm tra phòng..."
            value={terminateForm.note}
            onChange={(e) => setTerminateForm((p) => ({ ...p, note: e.target.value }))}
          />
        </form>
      </Modal>

      {/* Modal Từ chối phê duyệt hợp đồng giá ưu đãi -> trả về nháp */}
      <Modal
        open={rejectPriceOpen}
        onClose={() => setRejectPriceOpen(false)}
        title="Từ chối phê duyệt hợp đồng (trả về bản nháp)"
        subtitle="Hợp đồng sẽ chuyển về trạng thái Bản nháp (DRAFT) để điều chỉnh lại mức giá hoặc điều khoản"
        size="sm"
        footer={
          <>
            <Button variant="outline" onClick={() => setRejectPriceOpen(false)} disabled={submittingRejectPrice}>
              Hủy
            </Button>
            <Button
              variant="danger"
              onClick={handleRejectPriceSubmit}
              loading={submittingRejectPrice}
            >
              Xác nhận từ chối
            </Button>
          </>
        }
      >
        <form onSubmit={handleRejectPriceSubmit} className="space-y-3">
          <Input
            label="Lý do từ chối phê duyệt"
            required
            multiline
            rows={3}
            placeholder="Nhập lý do từ chối mức giá ưu đãi để người tạo điều chỉnh..."
            value={rejectPriceReason}
            onChange={(e) => setRejectPriceReason(e.target.value)}
          />
        </form>
      </Modal>

      {/* Modal Hủy lịch chấm dứt hợp đồng (trả về ACTIVE) */}
      <Modal
        open={rejectTermOpen}
        onClose={() => setRejectTermOpen(false)}
        title="Hủy lịch chấm dứt hợp đồng"
        subtitle="Hợp đồng sẽ xóa ngày hẹn trả phòng và quay trở lại trạng thái Đang hiệu lực (ACTIVE)"
        size="sm"
        footer={
          <>
            <Button variant="outline" onClick={() => setRejectTermOpen(false)} disabled={submittingRejectTerm}>
              Đóng
            </Button>
            <Button
              variant="danger"
              onClick={handleRejectTerminationSubmit}
              loading={submittingRejectTerm}
            >
              Xác nhận hủy lịch chấm dứt
            </Button>
          </>
        }
      >
        <Input
          label="Lý do hủy lịch chấm dứt"
          required
          multiline
          rows={3}
          placeholder="VD: Cư dân đề nghị tiếp tục ở lại theo hợp đồng hiện tại..."
          value={rejectTermReason}
          onChange={(e) => setRejectTermReason(e.target.value)}
        />
      </Modal>

      {/* Modal Thêm thành viên ở cùng */}
      <Modal
        open={occModalOpen}
        onClose={() => setOccModalOpen(false)}
        title="Thêm thành viên cùng lưu trú"
        subtitle="Nếu trùng SĐT trong hệ thống, hồ sơ định danh sẽ tự động được liên kết"
        size="md"
        footer={
          <>
            <Button variant="outline" onClick={() => setOccModalOpen(false)} disabled={submittingOcc}>
              Hủy
            </Button>
            <Button variant="primary" onClick={handleAddOccupantSubmit} loading={submittingOcc} icon={UserPlus}>
              Thêm vào hợp đồng
            </Button>
          </>
        }
      >
        <form onSubmit={handleAddOccupantSubmit} className="space-y-4">
          {occDupChecking ? (
            <div className="p-2.5 rounded-lg bg-slate-50 border border-slate-200 text-xs text-slate-600 flex items-center gap-2">
              <RefreshCw className="w-3.5 h-3.5 animate-spin text-primary-600" />
              Đang kiểm tra hồ sơ định danh trên hệ thống...
            </div>
          ) : occDupInfo.isDuplicate ? (
            occDupInfo.inScope && occDupInfo.duplicates.length > 0 ? (
              <div className="p-3 rounded-xl bg-emerald-50 border border-emerald-200 text-xs text-emerald-900 space-y-2">
                <div className="flex items-start gap-2">
                  <ShieldCheck className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
                  <div className="flex-1">
                    <p className="font-semibold">
                      Phát hiện hồ sơ có sẵn trong phạm vi quản lý:{' '}
                      {occDupInfo.duplicates[0].full_name || occDupInfo.duplicates[0].masked_name}
                    </p>
                    <p className="text-emerald-800 mt-0.5">
                      SĐT: {occDupInfo.duplicates[0].masked_phone || occDupInfo.duplicates[0].phone || '—'}
                      {occDupInfo.duplicates[0].masked_id_number
                        ? ` • CCCD: ${occDupInfo.duplicates[0].masked_id_number}`
                        : ''}{' '}
                      — Hệ thống sẽ tự động liên kết định danh khi thêm vào hợp đồng (không tạo bản ghi trùng).
                    </p>
                  </div>
                </div>
                {occDupInfo.duplicates[0].full_name &&
                occForm.full_name.trim() !== occDupInfo.duplicates[0].full_name ? (
                  <button
                    type="button"
                    onClick={() =>
                      setOccForm((prev) => ({
                        ...prev,
                        full_name: occDupInfo.duplicates[0].full_name || prev.full_name,
                      }))
                    }
                    className="px-2.5 py-1 rounded-md bg-emerald-600 hover:bg-emerald-700 text-white font-medium text-xs transition-colors"
                  >
                    Điền nhanh tên &ldquo;{occDupInfo.duplicates[0].full_name}&rdquo;
                  </button>
                ) : null}
              </div>
            ) : (
              <div className="p-3 rounded-xl bg-amber-50 border border-amber-200 text-xs text-amber-900 flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
                <div>
                  <p className="font-semibold">Phát hiện SĐT / CCCD đã đăng ký trên hệ thống</p>
                  <p className="text-amber-800 mt-0.5">
                    Nếu đúng SĐT của cư dân đã có hồ sơ tại tòa khác, hệ thống sẽ liên kết an toàn mà không ghi đè định danh gốc; nếu số CCCD trùng với một SĐT khác, thao tác sẽ bị chặn (FR-021).
                  </p>
                </div>
              </div>
            )
          ) : null}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Input
              label="Họ và tên"
              required
              value={occForm.full_name}
              onChange={(e) => setOccForm((p) => ({ ...p, full_name: e.target.value }))}
              error={occErrors.full_name}
            />
            <Input
              label="Số điện thoại"
              required
              value={occForm.phone}
              onChange={(e) => setOccForm((p) => ({ ...p, phone: e.target.value }))}
              error={occErrors.phone}
            />
            <Select
              label="Quan hệ với khách thuê chính"
              value={occForm.relationship}
              onChange={(e) => setOccForm((p) => ({ ...p, relationship: e.target.value }))}
              options={RELATIONSHIP_OPTIONS}
            />
            <Input
              label="Số CCCD / Hộ chiếu"
              hint="Bỏ trống nếu bổ sung sau (trạng thái PENDING)"
              value={occForm.id_number}
              onChange={(e) => setOccForm((p) => ({ ...p, id_number: e.target.value }))}
              error={occErrors.id_number}
            />
            <Input
              label="Email"
              type="email"
              value={occForm.email}
              onChange={(e) => setOccForm((p) => ({ ...p, email: e.target.value }))}
              error={occErrors.email}
            />
            <Input
              label="Ngày sinh"
              type="date"
              max={todayStr}
              value={occForm.dob}
              onChange={(e) => setOccForm((p) => ({ ...p, dob: e.target.value }))}
            />
          </div>
        </form>
      </Modal>

      {/* Modal Thêm giá dịch vụ riêng */}
      <Modal
        open={spModalOpen}
        onClose={() => setSpModalOpen(false)}
        title="Cấu hình đơn giá dịch vụ theo hợp đồng"
        size="sm"
        footer={
          <>
            <Button variant="outline" onClick={() => setSpModalOpen(false)} disabled={submittingSp}>
              Hủy
            </Button>
            <Button
              variant="primary"
              onClick={handleAddServicePrice}
              loading={submittingSp}
              disabled={Boolean(spEffectiveDateError)}
            >
              Lưu đơn giá
            </Button>
          </>
        }
      >
        <form onSubmit={handleAddServicePrice} className="space-y-4">
          <Select
            label="Dịch vụ"
            value={spForm.service_code}
            onChange={(e) => setSpForm((p) => ({ ...p, service_code: e.target.value }))}
            options={SERVICE_CODE_OPTIONS}
          />
          <MoneyInput
            label="Đơn giá áp dụng (VND)"
            required
            placeholder="VD: 150.000"
            value={spForm.unit_price}
            onChange={(e) => setSpForm((p) => ({ ...p, unit_price: e.target.value }))}
          />
          <Input
            label="Ngày bắt đầu áp dụng"
            type="date"
            required
            min={contractStartStr || undefined}
            value={spForm.effective_from}
            onChange={(e) => setSpForm((p) => ({ ...p, effective_from: e.target.value }))}
            error={spEffectiveDateError}
          />
        </form>
      </Modal>

      {/* Confirm Dialog cho Kích hoạt / Phê duyệt giá / Phê duyệt chấm dứt */}
      <ConfirmDialog
        open={confirmState.open}
        onClose={() => setConfirmState({ open: false, type: '' })}
        onConfirm={handleConfirmAction}
        loading={processingConfirm}
        variant={confirmState.type === 'approve_termination' ? 'warning' : 'success'}
        title={
          confirmState.type === 'activate'
            ? contract.is_room_transfer
              ? 'Trình phê duyệt hợp đồng đổi phòng'
              : 'Kích hoạt hợp đồng thuê'
            : confirmState.type === 'approve'
            ? contract.is_room_transfer
              ? 'Phê duyệt đổi phòng & kết chuyển cọc'
              : 'Phê duyệt hợp đồng giá ưu đãi'
            : 'Phê duyệt chấm dứt hợp đồng'
        }
        confirmLabel="Xác nhận thực hiện"
        message={
          confirmState.type === 'activate'
            ? contract.is_room_transfer
              ? `Xác nhận gửi hợp đồng đổi phòng ${contractCode} (căn ${contract.apartment_code}) sang trạng thái Chờ phê duyệt (PENDING_APPROVAL)? Hợp đồng căn cũ vẫn giữ hiệu lực cho tới khi được phê duyệt.`
              : `Xác nhận kích hoạt hợp đồng ${contractCode} cho căn hộ ${contract.apartment_code}? Hệ thống sẽ chuyển trạng thái căn hộ và tự động mở sổ cọc bảo đảm.`
            : confirmState.type === 'approve'
            ? contract.is_room_transfer
              ? `Xác nhận phê duyệt đổi phòng sang căn ${contract.apartment_code} (giá thuê ${formatMoney(contract.rent_amount)}/tháng)? Hệ thống sẽ đồng thời chấm dứt hợp đồng căn cũ (chuyển sang Bảo trì), kích hoạt hợp đồng mới sang ACTIVE và kết chuyển sổ cọc.`
              : `Xác nhận phê duyệt mức giá thuê ${formatMoney(contract.rent_amount)}/tháng cho căn hộ ${contract.apartment_code} và kích hoạt hợp đồng sang ACTIVE?`
            : `Xác nhận phê duyệt chấm dứt hợp đồng ${contractCode}? Căn hộ ${contract.apartment_code} sẽ chuyển sang trạng thái Bảo trì chờ nghiệm thu và thiết lập hạn hoàn cọc 5 ngày.`
        }
      />

      {/* Confirm gỡ người ở cùng */}
      <ConfirmDialog
        open={Boolean(removeOccTarget)}
        onClose={() => setRemoveOccTarget(null)}
        onConfirm={handleConfirmRemoveOccupant}
        loading={removingOcc}
        variant="danger"
        title="Gỡ thành viên khỏi hợp đồng"
        confirmLabel="Gỡ thành viên"
        message={
          removeOccTarget
            ? `Gỡ "${removeOccTarget.full_name}" khỏi danh sách lưu trú của hợp đồng ${contractCode}? Hồ sơ cá nhân của cư dân vẫn được bảo lưu.`
            : ''
        }
      />
    {/* Modal Đề nghị hoàn tiền tín dụng (FR-040) */}
      <Modal
        open={creditRefundModalOpen}
        onClose={() => setCreditRefundModalOpen(false)}
        title="Đề nghị hoàn tiền tín dụng trực tiếp (Four-Eyes Refund)"
        subtitle="Khoản tiền hoàn sẽ được chuyển đến người có thẩm quyền phê duyệt 4 mắt trước khi giải ngân"
        size="md"
        footer={
          <>
            <Button variant="outline" onClick={() => setCreditRefundModalOpen(false)} disabled={submittingCreditRefund}>
              Hủy
            </Button>
            <Button variant="primary" onClick={handleSubmitCreditRefund} loading={submittingCreditRefund}>
              Gửi đề nghị hoàn tiền
            </Button>
          </>
        }
      >
        <form onSubmit={handleSubmitCreditRefund} className="space-y-4">
          <MoneyInput
            label="Số tiền đề nghị hoàn (VNĐ)"
            value={creditRefundForm.amount}
            onChange={(val) => setCreditRefundForm((s) => ({ ...s, amount: String(val) }))}
            required
          />
          <Input
            label="Lý do hoàn trả"
            value={creditRefundForm.reason}
            onChange={(e) => setCreditRefundForm((s) => ({ ...s, reason: e.target.value }))}
            placeholder="Ví dụ: Khách nộp thừa tiền phòng kỳ 11/2026, yêu cầu hoàn về TK..."
            required
          />
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2 border-t border-slate-100">
            <Input
              label="Ngân hàng nhận"
              value={creditRefundForm.bank_name}
              onChange={(e) => setCreditRefundForm((s) => ({ ...s, bank_name: e.target.value }))}
              placeholder="VD: Vietcombank, Techcombank..."
            />
            <Input
              label="Số tài khoản"
              value={creditRefundForm.account_number}
              onChange={(e) => setCreditRefundForm((s) => ({ ...s, account_number: e.target.value }))}
              placeholder="Số tài khoản thụ hưởng"
            />
          </div>
          <Input
            label="Chủ tài khoản thụ hưởng"
            value={creditRefundForm.account_holder}
            onChange={(e) => setCreditRefundForm((s) => ({ ...s, account_holder: e.target.value }))}
            placeholder="Họ và tên chủ tài khoản"
          />
          <FileUpload
            label="Ảnh chứng từ UNC / Đề nghị (Tùy chọn)"
            value={creditRefundForm.proof_image ? [creditRefundForm.proof_image] : []}
            onChange={(files) => setCreditRefundForm((s) => ({ ...s, proof_image: files[0] || '' }))}
            maxFiles={1}
            accept="image/*,application/pdf"
          />
        </form>
      </Modal>

      {/* Modal Từ chối hoàn tiền tín dụng */}
      <Modal
        open={creditRejectModalOpen}
        onClose={() => setCreditRejectModalOpen(false)}
        title="Từ chối đề nghị hoàn tiền tín dụng"
        subtitle="Hồ sơ sẽ quay về trạng thái AVAILABLE để người lập điều chỉnh thông tin"
        size="sm"
        footer={
          <>
            <Button variant="outline" onClick={() => setCreditRejectModalOpen(false)} disabled={submittingCreditReject}>
              Quay lại
            </Button>
            <Button variant="danger" onClick={handleSubmitCreditReject} loading={submittingCreditReject}>
              Xác nhận từ chối
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Input
            multiline
            rows={3}
            label="Lý do từ chối"
            value={creditRejectionReason}
            onChange={(e) => setCreditRejectionReason(e.target.value)}
            placeholder="Nhập lý do cụ thể để người tạo được biết..."
            required
          />
        </div>
      </Modal>
    </div>
  );
}

export default ContractDetailPage;
