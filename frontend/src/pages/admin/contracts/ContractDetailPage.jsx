import React, { useState, useEffect, useCallback, useMemo } from 'react';
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
} from 'lucide-react';
import { Button } from '../../../components/ui/Button';
import { Input } from '../../../components/ui/Input';
import { Select } from '../../../components/ui/Select';
import { Modal } from '../../../components/ui/Modal';
import { Badge } from '../../../components/ui/Badge';
import { Card, CardHeader } from '../../../components/ui/Card';
import { Tabs } from '../../../components/ui/Tabs';
import { FileUpload, AuthImage } from '../../../components/ui/FileUpload';
import { PageHeader } from '../../../components/common/PageHeader';
import { StatusBadge } from '../../../components/common/StatusBadge';
import { DataTable } from '../../../components/common/DataTable';
import { ConfirmDialog } from '../../../components/common/ConfirmDialog';
import { EmptyState } from '../../../components/common/EmptyState';
import { LoadingSpinner } from '../../../components/common/LoadingSpinner';
import { contractsService } from '../../../services/contracts.service';
import { buildingsService } from '../../../services/buildings.service';
import { usePermission } from '../../../hooks/usePermission';
import { useToast } from '../../../hooks/useToast';
import { formatMoney, formatDate, formatDateTime, toInputDate } from '../../../utils/format';
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
  if (!dateStr) return '';
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return '';
  d.setMonth(d.getMonth() + months);
  return d.toISOString().slice(0, 10);
}

function ContractTimeline({ status }) {
  const terminalStep = useMemo(() => {
    if (status === 'RENEWAL_PENDING') {
      return { id: 'RENEWAL_PENDING', label: 'Chờ duyệt gia hạn', state: 'warning' };
    }
    if (status === 'TERMINATION_PENDING') {
      return { id: 'TERMINATION_PENDING', label: 'Chờ duyệt chấm dứt', state: 'warning' };
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
        label: '2. Phê duyệt giá',
        desc: 'CĐT duyệt nếu giảm > 10%',
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
  }, [status, terminalStep]);

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
  const { isManager, isOwner, user } = usePermission();

  const [contract, setContract] = useState(null);
  const [occupants, setOccupants] = useState([]);
  const [amendments, setAmendments] = useState([]);
  const [servicePrices, setServicePrices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState('overview');

  // Action loading states
  const [printing, setPrinting] = useState(false);
  const [uploadingScan, setUploadingScan] = useState(false);
  const [previewScanSrc, setPreviewScanSrc] = useState(null);

  // Confirm Dialogs (Activate / Approve / ApproveTermination)
  const [confirmState, setConfirmState] = useState({ open: false, type: '' });
  const [processingConfirm, setProcessingConfirm] = useState(false);

  // Edit Draft Modal
  const [editDraftOpen, setEditDraftOpen] = useState(false);
  const [editDraftForm, setEditDraftForm] = useState({
    start_date: '',
    end_date: '',
    rent_amount: '',
    deposit_amount: '',
    billing_cycle: 'monthly',
    billing_day: '1',
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
  const [transferForm, setTransferForm] = useState({
    new_apartment_id: '',
    new_start_date: '',
    new_end_date: '',
    new_rent_amount: '',
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
  const [removeOccTarget, setRemoveOccTarget] = useState(null);
  const [removingOcc, setRemovingOcc] = useState(false);

  // Service Prices Modal
  const [spModalOpen, setSpModalOpen] = useState(false);
  const [spForm, setSpForm] = useState({
    service_code: 'INTERNET',
    unit_price: '',
    effective_from: '',
  });
  const [submittingSp, setSubmittingSp] = useState(false);

  const loadAll = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    try {
      const [cRes, oRes, aRes, spRes] = await Promise.all([
        contractsService.getById(id),
        contractsService.listOccupants(id).catch(() => ({ data: [] })),
        contractsService.listAmendments(id).catch(() => ({ data: [] })),
        contractsService.listServicePrices(id).catch(() => ({ data: [] })),
      ]);
      setContract(cRes?.data || null);
      setOccupants(Array.isArray(oRes?.data) ? oRes.data : []);
      setAmendments(Array.isArray(aRes?.data) ? aRes.data : []);
      setServicePrices(Array.isArray(spRes?.data) ? spRes.data : []);
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
      const res = await contractsService.uploadScan(id, { image_base64: base64Val });
      toast.success(res?.message || 'Đã đính kèm bản scan hợp đồng thành công.');
      await loadAll();
    } catch (err) {
      toast.error(extractErrorMessage(err, 'Không thể tải lên bản scan hợp đồng.'));
    } finally {
      setUploadingScan(false);
    }
  };

  // Xử lý Kích hoạt / Phê duyệt giá / Phê duyệt chấm dứt
  const handleConfirmAction = async () => {
    const actionType = confirmState.type;
    if (!actionType) return;
    setProcessingConfirm(true);
    try {
      if (actionType === 'activate') {
        const res = await contractsService.activate(id);
        toast.success(res?.message || 'Kích hoạt hợp đồng thành công!');
      } else if (actionType === 'approve') {
        const res = await contractsService.approve(id);
        toast.success(res?.message || 'Đã phê duyệt và kích hoạt hợp đồng thành công!');
      } else if (actionType === 'approve_termination') {
        const res = await contractsService.approveTermination(id);
        toast.success(res?.message || 'Đã phê duyệt chấm dứt hợp đồng.');
      }
      setConfirmState({ open: false, type: '' });
      await loadAll();
    } catch (err) {
      const errCode = err?.response?.data?.code;
      if (errCode === 'PRICE_NEEDS_APPROVAL') {
        // Backend đã commit chuyển hợp đồng sang PENDING_APPROVAL chờ OWNER duyệt
        toast.warning(
          err?.response?.data?.message ||
            'Giá thuê thấp hơn 90% giá niêm yết. Hợp đồng đã chuyển sang chờ Chủ đầu tư (OWNER) phê duyệt.'
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
      note: contract.note || '',
    });
    setEditDraftOpen(true);
  };

  const handleSaveDraft = async (e) => {
    e?.preventDefault();
    if (editDraftForm.end_date <= editDraftForm.start_date) {
      toast.warning('Ngày kết thúc phải sau ngày bắt đầu.');
      return;
    }
    setSavingDraft(true);
    try {
      const res = await contractsService.update(id, {
        start_date: editDraftForm.start_date,
        end_date: editDraftForm.end_date,
        rent_amount: Math.round(Number(editDraftForm.rent_amount || 0)),
        deposit_amount: Math.round(Number(editDraftForm.deposit_amount || 0)),
        billing_cycle: editDraftForm.billing_cycle,
        billing_day: Math.min(28, Math.max(1, Number(editDraftForm.billing_day || 1))),
        note: editDraftForm.note,
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
    const curEnd = toInputDate(contract?.end_date);
    if (!renewForm.new_end_date || renewForm.new_end_date <= curEnd) {
      toast.warning('Ngày kết thúc gia hạn phải sau ngày kết thúc hiện tại của hợp đồng.');
      return;
    }
    setSubmittingRenew(true);
    try {
      const res = await contractsService.renew(id, {
        new_end_date: renewForm.new_end_date,
        rent_amount: Math.round(Number(renewForm.rent_amount || 0)),
        deposit_amount: Math.round(Number(renewForm.deposit_amount || 0)),
        note: renewForm.note.trim(),
      });
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
      effective_from: new Date().toISOString().slice(0, 10),
      reason: '',
    });
    setAmendOpen(true);
  };

  const handleAmendSubmit = async (e) => {
    e?.preventDefault();
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
    const today = new Date().toISOString().slice(0, 10);
    setTransferForm({
      new_apartment_id: '',
      new_start_date: today,
      new_end_date: toInputDate(contract.end_date),
      new_rent_amount: String(Math.round(Number(contract.rent_amount || 0))),
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
    if (transferForm.new_end_date <= transferForm.new_start_date) {
      toast.warning('Ngày kết thúc hợp đồng mới phải sau ngày chuyển phòng.');
      return;
    }
    setSubmittingTransfer(true);
    try {
      const res = await contractsService.transferRoom(id, {
        new_apartment_id: transferForm.new_apartment_id,
        new_start_date: transferForm.new_start_date,
        new_end_date: transferForm.new_end_date,
        new_rent_amount: Math.round(Number(transferForm.new_rent_amount || 0)),
        transfer_deposit: Boolean(transferForm.transfer_deposit),
        note: transferForm.note.trim() || undefined,
      });
      toast.success(res?.message || 'Chuyển phòng thành công!');
      setTransferOpen(false);
      const newContractId = res?.data?.new_contract?.id;
      if (newContractId) {
        navigate(`/admin/contracts/${newContractId}`);
      } else {
        await loadAll();
      }
    } catch (err) {
      toast.error(extractErrorMessage(err, 'Không thể thực hiện chuyển phòng.'));
    } finally {
      setSubmittingTransfer(false);
    }
  };

  // Đề xuất chấm dứt hợp đồng (MANAGER)
  const handleOpenTerminate = () => {
    if (!contract) return;
    const today = new Date().toISOString().slice(0, 10);
    const sDate = toInputDate(contract.start_date);
    const eDate = toInputDate(contract.end_date);
    let defaultTermDate = today;
    if (defaultTermDate < sDate) defaultTermDate = sDate;
    if (defaultTermDate > eDate) defaultTermDate = eDate;

    setTerminateForm({
      terminated_date: defaultTermDate,
      reason: 'Khách thuê trả phòng / Thanh lý hợp đồng',
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
    setSubmittingTerminate(true);
    try {
      const res = await contractsService.terminate(id, {
        terminated_date: terminateForm.terminated_date,
        reason: terminateForm.reason.trim(),
        note: terminateForm.note.trim(),
      });
      toast.success(res?.message || 'Đã gửi đề xuất chấm dứt hợp đồng chờ OWNER duyệt.');
      setTerminateOpen(false);
      await loadAll();
    } catch (err) {
      toast.error(extractErrorMessage(err, 'Không thể gửi đề xuất chấm dứt hợp đồng.'));
    } finally {
      setSubmittingTerminate(false);
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
    { id: 'occupants', label: 'Người ở cùng', icon: Users, count: occupants.length },
    {
      id: 'amendments',
      label: 'Phụ lục hợp đồng',
      icon: FilePlus2,
      count: pendingAmendmentsCount > 0 ? pendingAmendmentsCount : amendments.length,
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

            {/* Nút hành động dành cho MANAGER */}
            {isManager && contract.status === 'DRAFT' ? (
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

            {isManager && contract.status === 'PENDING_APPROVAL' ? (
              <Button variant="outline" icon={XCircle} onClick={() => setCancelOpen(true)}>
                Hủy đề xuất
              </Button>
            ) : null}

            {isManager && ['ACTIVE', 'RENEWAL_PENDING', 'EXPIRED'].includes(contract.status) ? (
              <Button variant="outline" icon={RefreshCw} onClick={handleOpenRenew}>
                Gia hạn HĐ
              </Button>
            ) : null}

            {isManager && ['ACTIVE', 'RENEWAL_PENDING'].includes(contract.status) ? (
              <Button variant="outline" icon={FilePlus2} onClick={handleOpenAmend}>
                Phụ lục điều chỉnh
              </Button>
            ) : null}

            {isManager && contract.status === 'ACTIVE' ? (
              <>
                <Button variant="soft" icon={ArrowRightLeft} onClick={handleOpenTransfer}>
                  Chuyển phòng
                </Button>
                <Button variant="danger" icon={XCircle} onClick={handleOpenTerminate}>
                  Yêu cầu chấm dứt
                </Button>
              </>
            ) : null}

            {/* Nút hành động dành cho OWNER */}
            {isOwner && contract.status === 'PENDING_APPROVAL' ? (
              <Button
                variant="success"
                icon={ShieldCheck}
                onClick={() => setConfirmState({ open: true, type: 'approve' })}
              >
                Phê duyệt HĐ giá ưu đãi
              </Button>
            ) : null}

            {isOwner && contract.status === 'TERMINATION_PENDING' ? (
              <>
                <Button variant="outline" icon={XCircle} onClick={() => setRejectTermOpen(true)}>
                  Từ chối chấm dứt
                </Button>
                <Button
                  variant="success"
                  icon={CheckCircle2}
                  onClick={() => setConfirmState({ open: true, type: 'approve_termination' })}
                >
                  Duyệt chấm dứt HĐ
                </Button>
              </>
            ) : null}
          </>
        }
      />

      {/* Timeline trạng thái */}
      <ContractTimeline status={contract.status} />

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
              Hợp đồng đang chờ Chủ đầu tư (OWNER) phê duyệt chấm dứt — Ngày thanh lý dự kiến:{' '}
              {formatDate(contract.terminated_at)}
            </p>
            <p className="text-amber-800 mt-0.5">
              Theo nguyên tắc Four-eyes (FR-017), người đề xuất chấm dứt không được tự phê duyệt. Sau khi OWNER phê duyệt, căn hộ sẽ chuyển sang Bảo trì chờ nghiệm thu và sổ cọc được mở hạn hoàn cọc 5 ngày.
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
                <p className="text-xs text-slate-500">Chu kỳ &amp; Ngày chốt hóa đơn</p>
                <p className="font-semibold text-slate-800 mt-0.5">
                  {contract.billing_cycle === 'quarterly' ? '3 tháng / lần' : 'Hàng tháng'} • Ngày{' '}
                  {contract.billing_day || 1}
                </p>
              </div>

              <div className="p-3 rounded-lg border border-slate-100">
                <p className="text-xs text-slate-500">Email liên hệ / Ngày thanh lý</p>
                <p className="font-semibold text-slate-800 mt-0.5 truncate">
                  {contract.terminated_at
                    ? `Thanh lý: ${formatDate(contract.terminated_at)}`
                    : contract.tenant_email || 'Chưa cập nhật email'}
                </p>
              </div>
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
                  return (
                    <div
                      key={att.id}
                      onClick={() => setPreviewScanSrc(viewUrl)}
                      className="group relative rounded-xl border border-slate-200 overflow-hidden bg-slate-50 cursor-pointer hover:border-primary-400 transition-all"
                    >
                      <div className="h-36 w-full">
                        <AuthImage
                          src={viewUrl}
                          alt={`Bản scan #${idx + 1}`}
                          className="w-full h-full object-cover"
                        />
                      </div>
                      <div className="px-2.5 py-1.5 bg-white border-t border-slate-100 flex items-center justify-between text-[11px] text-slate-600">
                        <span className="font-medium truncate">Bản ký #{attachments.length - idx}</span>
                        <span className="inline-flex items-center gap-0.5 text-primary-600 font-medium">
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

            {isManager ? (
              <FileUpload
                label="Đính kèm thêm ảnh scan hợp đồng đã ký"
                value=""
                onChange={handleUploadScan}
                hint={
                  uploadingScan
                    ? 'Đang tải bản scan lên máy chủ...'
                    : 'Hỗ trợ ảnh chụp / scan rõ nét JPG, PNG (tối đa 5MB)'
                }
              />
            ) : null}
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
            {isManager ? (
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
                label: 'CCCD / Hộ chiếu',
                align: 'center',
                className: 'whitespace-nowrap',
                render: (row) => (
                  <span className="font-mono text-xs">{row.id_number || 'Chưa bổ sung'}</span>
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
                  isManager ? (
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
                Mọi thay đổi về giá thuê, tiền cọc hoặc ngày kết thúc sau khi ACTIVE đều lưu vết phiên bản và cần phê duyệt (FR-016).
              </p>
            </div>
            {isManager && ['ACTIVE', 'RENEWAL_PENDING'].includes(contract.status) ? (
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

                const isPureExtension =
                  Boolean(diff.end_date) && !diff.rent_amount && !diff.deposit_amount;
                const canManagerApproveExt =
                  isManager &&
                  isPureExtension &&
                  diff.created_by &&
                  diff.created_by !== user?.id;

                return (
                  <Card key={ver.id} className="p-5">
                    <div className="flex flex-wrap items-start justify-between gap-3 pb-3 border-b border-slate-100">
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-bold text-slate-900">
                            Phụ lục phiên bản #{ver.version_no}
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

                      {isPending && (isOwner || canManagerApproveExt) ? (
                        <div className="flex items-center gap-2">
                          {isOwner ? (
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
                          ) : null}
                          <Button
                            variant="success"
                            size="xs"
                            icon={CheckCircle2}
                            onClick={() => handleApproveAmendment(ver.id)}
                          >
                            Phê duyệt phụ lục
                          </Button>
                        </div>
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
                        <div className="p-2.5 rounded-lg bg-rose-50 border border-rose-200 text-xs text-rose-700">
                          <strong>Lý do từ chối:</strong> {diff.rejection_reason}
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
                isManager ? (
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
                      <p className="font-semibold text-slate-800">{sp.service_code}</p>
                      <p className="text-slate-500">
                        Hiệu lực từ: {formatDate(sp.effective_from)}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="font-bold text-slate-900">{formatMoney(sp.unit_price)}</span>
                      {isManager ? (
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

      {/* Modal Xem ảnh scan phóng to */}
      <Modal
        open={Boolean(previewScanSrc)}
        onClose={() => setPreviewScanSrc(null)}
        title={`Bản scan hợp đồng ${contractCode}`}
        size="lg"
        footer={
          <Button variant="outline" onClick={() => setPreviewScanSrc(null)}>
            Đóng
          </Button>
        }
      >
        <div className="flex items-center justify-center bg-slate-900/5 rounded-xl p-2 min-h-[320px]">
          {previewScanSrc ? (
            <AuthImage
              src={previewScanSrc}
              alt="Bản scan hợp đồng"
              className="max-h-[72vh] w-auto rounded-lg object-contain"
            />
          ) : null}
        </div>
      </Modal>

      {/* Modal Sửa hợp đồng nháp */}
      <Modal
        open={editDraftOpen}
        onClose={() => setEditDraftOpen(false)}
        title="Chỉnh sửa hợp đồng nháp"
        subtitle="Chỉ hợp đồng ở trạng thái DRAFT mới được chỉnh sửa trực tiếp"
        size="md"
        footer={
          <>
            <Button variant="outline" onClick={() => setEditDraftOpen(false)} disabled={savingDraft}>
              Hủy
            </Button>
            <Button variant="primary" onClick={handleSaveDraft} loading={savingDraft}>
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
            />
            <Input
              label="Ngày kết thúc"
              type="date"
              required
              value={editDraftForm.end_date}
              onChange={(e) => setEditDraftForm((p) => ({ ...p, end_date: e.target.value }))}
            />
            <Input
              label="Giá thuê / tháng (VND)"
              type="number"
              min="0"
              required
              value={editDraftForm.rent_amount}
              onChange={(e) => setEditDraftForm((p) => ({ ...p, rent_amount: e.target.value }))}
            />
            <Input
              label="Tiền đặt cọc (VND)"
              type="number"
              min="0"
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
              label="Ngày chốt hóa đơn"
              type="number"
              min="1"
              max="28"
              value={editDraftForm.billing_day}
              onChange={(e) => setEditDraftForm((p) => ({ ...p, billing_day: e.target.value }))}
            />
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
            <Button variant="primary" onClick={handleRenewSubmit} loading={submittingRenew} icon={RefreshCw}>
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
            value={renewForm.new_end_date}
            onChange={(e) => setRenewForm((p) => ({ ...p, new_end_date: e.target.value }))}
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
            <Input
              label="Giá thuê kỳ mới (VND)"
              type="number"
              min="0"
              required
              value={renewForm.rent_amount}
              onChange={(e) => setRenewForm((p) => ({ ...p, rent_amount: e.target.value }))}
            />
            <Input
              label="Tiền cọc kỳ mới (VND)"
              type="number"
              min="0"
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
        subtitle="Đề xuất điều chỉnh giá thuê, tiền cọc hoặc ngày kết thúc trình OWNER phê duyệt (FR-016)"
        size="md"
        footer={
          <>
            <Button variant="outline" onClick={() => setAmendOpen(false)} disabled={submittingAmend}>
              Hủy bỏ
            </Button>
            <Button variant="primary" onClick={handleAmendSubmit} loading={submittingAmend} icon={FilePlus2}>
              Gửi đề xuất phụ lục
            </Button>
          </>
        }
      >
        <form onSubmit={handleAmendSubmit} className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Input
              label="Giá thuê mới (VND)"
              type="number"
              min="0"
              value={amendForm.rent_amount}
              onChange={(e) => setAmendForm((p) => ({ ...p, rent_amount: e.target.value }))}
              hint={`Hiện tại: ${formatMoney(contract.rent_amount)}`}
            />
            <Input
              label="Tiền cọc mới (VND)"
              type="number"
              min="0"
              value={amendForm.deposit_amount}
              onChange={(e) => setAmendForm((p) => ({ ...p, deposit_amount: e.target.value }))}
              hint={`Hiện tại: ${formatMoney(contract.deposit_amount)}`}
            />
            <Input
              label="Ngày kết thúc mới"
              type="date"
              value={amendForm.end_date}
              onChange={(e) => setAmendForm((p) => ({ ...p, end_date: e.target.value }))}
              hint={`Hiện tại: ${formatDate(contract.end_date)}`}
            />
            <Input
              label="Ngày bắt đầu áp dụng phụ lục"
              type="date"
              required
              value={amendForm.effective_from}
              onChange={(e) => setAmendForm((p) => ({ ...p, effective_from: e.target.value }))}
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

      {/* Modal Chuyển phòng Atomic (FR-013) */}
      <Modal
        open={transferOpen}
        onClose={() => setTransferOpen(false)}
        title="Chuyển phòng (Atomic Transaction)"
        subtitle={`Đóng hợp đồng căn ${contract.apartment_code} (chuyển sang Bảo trì) và mở hợp đồng mới ACTIVE trên căn đích cùng tòa (FR-013)`}
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
              icon={ArrowRightLeft}
            >
              Thực hiện chuyển phòng
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

          <div className="grid grid-cols-2 gap-4">
            <Input
              label="Ngày chuyển phòng"
              type="date"
              required
              value={transferForm.new_start_date}
              onChange={(e) => setTransferForm((p) => ({ ...p, new_start_date: e.target.value }))}
            />
            <Input
              label="Ngày kết thúc HĐ mới"
              type="date"
              required
              value={transferForm.new_end_date}
              onChange={(e) => setTransferForm((p) => ({ ...p, new_end_date: e.target.value }))}
            />
          </div>

          <Input
            label="Giá thuê căn hộ mới (VND / tháng)"
            type="number"
            min="0"
            required
            value={transferForm.new_rent_amount}
            onChange={(e) => setTransferForm((p) => ({ ...p, new_rent_amount: e.target.value }))}
          />

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
              <p className="font-semibold">Tự động kết chuyển sổ cọc hiện tại sang hợp đồng mới</p>
              <p className="text-sky-700 mt-0.5">
                Sổ cọc cũ sẽ ghi nhận trạng thái TRANSFERRED và mở sổ cọc mới giữ nguyên số dư đang giữ.
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

      {/* Modal Đề xuất chấm dứt hợp đồng (MANAGER) */}
      <Modal
        open={terminateOpen}
        onClose={() => setTerminateOpen(false)}
        title="Đề xuất chấm dứt hợp đồng"
        subtitle="Gửi yêu cầu thanh lý sang trạng thái TERMINATION_PENDING chờ Chủ đầu tư (OWNER) phê duyệt (FR-017)"
        size="md"
        footer={
          <>
            <Button variant="outline" onClick={() => setTerminateOpen(false)} disabled={submittingTerminate}>
              Hủy bỏ
            </Button>
            <Button variant="danger" onClick={handleTerminateSubmit} loading={submittingTerminate}>
              Gửi đề xuất chấm dứt
            </Button>
          </>
        }
      >
        <form onSubmit={handleTerminateSubmit} className="space-y-4">
          <Input
            label="Ngày chấm dứt hợp đồng"
            type="date"
            required
            value={terminateForm.terminated_date}
            onChange={(e) => setTerminateForm((p) => ({ ...p, terminated_date: e.target.value }))}
            hint={`Phải nằm trong kỳ hạn hợp đồng (${formatDate(contract.start_date)} – ${formatDate(contract.end_date)})`}
          />
          <Input
            label="Lý do chấm dứt"
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

      {/* Modal Từ chối đề xuất chấm dứt (OWNER) */}
      <Modal
        open={rejectTermOpen}
        onClose={() => setRejectTermOpen(false)}
        title="Từ chối đề xuất chấm dứt hợp đồng"
        subtitle="Hợp đồng sẽ quay trở lại trạng thái Đang hiệu lực (ACTIVE)"
        size="sm"
        footer={
          <>
            <Button variant="outline" onClick={() => setRejectTermOpen(false)} disabled={submittingRejectTerm}>
              Hủy
            </Button>
            <Button
              variant="danger"
              onClick={handleRejectTerminationSubmit}
              loading={submittingRejectTerm}
            >
              Xác nhận từ chối
            </Button>
          </>
        }
      >
        <Input
          label="Lý do từ chối chấm dứt"
          required
          multiline
          rows={3}
          placeholder="Nhập lý do từ chối để BQL nắm rõ..."
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
            <Button variant="primary" onClick={handleAddServicePrice} loading={submittingSp}>
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
          <Input
            label="Đơn giá áp dụng (VND)"
            type="number"
            min="0"
            required
            placeholder="VD: 150000"
            value={spForm.unit_price}
            onChange={(e) => setSpForm((p) => ({ ...p, unit_price: e.target.value }))}
          />
          <Input
            label="Ngày bắt đầu áp dụng"
            type="date"
            required
            value={spForm.effective_from}
            onChange={(e) => setSpForm((p) => ({ ...p, effective_from: e.target.value }))}
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
            ? 'Kích hoạt hợp đồng thuê'
            : confirmState.type === 'approve'
            ? 'Phê duyệt hợp đồng giá ưu đãi'
            : 'Phê duyệt chấm dứt hợp đồng'
        }
        confirmLabel="Xác nhận thực hiện"
        message={
          confirmState.type === 'activate'
            ? `Xác nhận kích hoạt hợp đồng ${contractCode} cho căn hộ ${contract.apartment_code}? Hệ thống sẽ chuyển trạng thái căn hộ và tự động mở sổ cọc bảo đảm.`
            : confirmState.type === 'approve'
            ? `Xác nhận phê duyệt mức giá thuê ${formatMoney(contract.rent_amount)}/tháng cho căn hộ ${contract.apartment_code} và kích hoạt hợp đồng sang ACTIVE?`
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
    </div>
  );
}

export default ContractDetailPage;
