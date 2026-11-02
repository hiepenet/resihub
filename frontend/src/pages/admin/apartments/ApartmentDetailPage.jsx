import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import {
  Edit3,
  CheckCircle2,
  Plus,
  Gauge,
  Wrench,
  FileSignature,
  Bookmark,
  BookmarkPlus,
  Layers,
  XCircle,
  Scale,
  ShieldCheck,
  Wallet,
} from 'lucide-react';
import { PageHeader } from '../../../components/common/PageHeader';
import { StatusBadge } from '../../../components/common/StatusBadge';
import { DataTable } from '../../../components/common/DataTable';
import { BankSelect } from '../../../components/common/BankSelect';
import { Card, CardHeader } from '../../../components/ui/Card';
import { Button } from '../../../components/ui/Button';
import { Badge } from '../../../components/ui/Badge';
import { Modal } from '../../../components/ui/Modal';
import { Input } from '../../../components/ui/Input';
import { MoneyInput } from '../../../components/ui/MoneyInput';
import { Select } from '../../../components/ui/Select';
import { FileUpload, AuthImage } from '../../../components/ui/FileUpload';
import { PageSkeleton } from '../../../components/ui/Skeleton';
import {
  APARTMENT_STATUS,
  PAYMENT_METHOD_OPTIONS,
  PAYMENT_METHOD_LABELS,
} from '../../../constants/statuses';
import { buildingsService } from '../../../services/buildings.service';
import { usersService } from '../../../services/users.service';
import { usePermission } from '../../../hooks/usePermission';
import { useToast } from '../../../hooks/useToast';
import { formatMoney, formatDate } from '../../../utils/format';
import { addDaysStr, toDateOnlyStr } from '../../../utils/dateRange';
import { extractErrorMessage } from '../../../utils/validation';
import { createIdempotencyKey } from '../../../utils/idempotency';
import {
  DEFAULT_RESERVATION_CANCEL_POLICY,
  canManagerConfirmReservationPayment,
  canProposeReservationCancel,
  canApproveReservationCancel,
  canPayoutReservationCancel,
  computeSuggestedCancelSplit,
} from '../../../utils/depositUiHelpers';

const APARTMENT_TYPE_OPTIONS = ['Studio', '1PN', '2PN', '3PN', 'Penthouse', 'Duplex'];

export function ApartmentDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const { canEditRealEstate, isOwner, isManager, isSysAdmin, user } = usePermission();
  const currentUserId = user?.id || user?.sub;
  const todayStr = toDateOnlyStr(new Date());

  const [apt, setApt] = useState(null);
  const [zones, setZones] = useState([]);
  const [cancelPolicy, setCancelPolicy] = useState(DEFAULT_RESERVATION_CANCEL_POLICY);
  const [allowSelfApproval, setAllowSelfApproval] = useState(false);
  const [loading, setLoading] = useState(true);
  const [editOpen, setEditOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    zone_id: '',
    type: '1PN',
    bedrooms: 1,
    area_m2: 0,
    base_rent: 0,
    note: '',
    amenitiesText: '',
  });

  useEffect(() => {
    buildingsService
      .getReservationCancelPolicy()
      .then((res) => {
        if (res?.data) {
          setCancelPolicy((prev) => ({ ...prev, ...res.data }));
        }
      })
      .catch(() => {});
    usersService
      .getSettings()
      .then((res) => {
        setAllowSelfApproval(Boolean(res?.data?.approval_config?.allow_self_approval));
      })
      .catch(() => {});
  }, []);

  const loadApartment = useCallback(async () => {
    setLoading(true);
    try {
      const res = await buildingsService.getApartment(id);
      const d = res.data;
      setApt(d);
      if (d?.building_id) {
        const zRes = await buildingsService.listZones(d.building_id).catch(() => ({ data: [] }));
        setZones(zRes.data || []);
      }
      const am =
        d.amenities && typeof d.amenities === 'object'
          ? Object.keys(d.amenities)
              .filter((k) => d.amenities[k])
              .join(', ')
          : '';
      setForm({
        zone_id: d.zone_id || '',
        type: d.type || '1PN',
        bedrooms: d.bedrooms ?? 1,
        area_m2: d.area_m2 || 0,
        base_rent: d.base_rent || 0,
        note: d.note || '',
        amenitiesText: am,
      });
    } catch (err) {
      toast.error(extractErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [id, toast]);

  useEffect(() => {
    loadApartment();
  }, [loadApartment]);

  const handleSave = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      const amenitiesObj = {};
      form.amenitiesText
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .forEach((k) => {
          amenitiesObj[k] = true;
        });

      const payload = {
        zone_id: form.zone_id || null,
        type: form.type || '1PN',
        bedrooms: Number(form.bedrooms ?? 1),
        area_m2: Number(form.area_m2),
        base_rent: Number(form.base_rent),
        note: form.note,
        amenities: amenitiesObj,
      };

      try {
        await buildingsService.updateApartment(id, payload);
        toast.success('Đã cập nhật thông tin căn hộ.');
        setEditOpen(false);
        loadApartment();
      } catch (err) {
        if (
          err?.response?.status === 409 &&
          err?.response?.data?.code === 'AREA_CHANGE_REQUIRES_CONFIRM'
        ) {
          const confirmed = window.confirm(
            'Căn hộ đang có hợp đồng hiệu lực. Thay đổi diện tích có thể ảnh hưởng cách tính phí dịch vụ. Bạn có chắc chắn muốn tiếp tục?'
          );
          if (confirmed) {
            await buildingsService.updateApartment(id, {
              ...payload,
              confirm_recalculate_fees: true,
            });
            toast.success('Đã cập nhật thông tin căn hộ.');
            setEditOpen(false);
            loadApartment();
          }
          return;
        }
        throw err;
      }
    } catch (err) {
      toast.error(extractErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const handleTransition = async (nextStatus) => {
    setSaving(true);
    try {
      await buildingsService.updateApartment(id, { status: nextStatus });
      toast.success(`Đã chuyển trạng thái sang ${APARTMENT_STATUS[nextStatus]?.label || nextStatus}.`);
      loadApartment();
    } catch (err) {
      toast.error(extractErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const [handoverModalOpen, setHandoverModalOpen] = useState(false);
  const [handoverForm, setHandoverForm] = useState({
    note: '',
    evidence: [],
    keep_maintenance: false,
  });

  const handleOpenHandoverModal = () => {
    setHandoverForm({
      note: '',
      evidence: [],
      keep_maintenance: false,
    });
    setHandoverModalOpen(true);
  };

  const handleHandover = async (e) => {
    e?.preventDefault();
    setSaving(true);
    try {
      const res = await buildingsService.handoverApartment(id, {
        note: String(handoverForm.note || '').trim() || undefined,
        evidence: Array.isArray(handoverForm.evidence) ? handoverForm.evidence : [],
        keep_maintenance: Boolean(handoverForm.keep_maintenance),
      });
      toast.success(res.message || 'Nghiệm thu & bàn giao phòng thành công.');
      setHandoverModalOpen(false);
      loadApartment();
    } catch (err) {
      toast.error(extractErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  // Internal Create Reservation Modal
  const [createRsvOpen, setCreateRsvOpen] = useState(false);
  const [createRsvForm, setCreateRsvForm] = useState({
    prospect_name: '',
    phone: '',
    hold_amount: DEFAULT_RESERVATION_CANCEL_POLICY.default_hold_amount,
    method: 'BANK_TRANSFER',
    hold_from: todayStr,
    hold_until: addDaysStr(todayStr, 5),
    evidence: [],
    note: '',
  });
  const createRsvIdemRef = useRef(createIdempotencyKey());

  const handleOpenCreateReservation = () => {
    createRsvIdemRef.current = createIdempotencyKey();
    setCreateRsvForm({
      prospect_name: '',
      phone: '',
      hold_amount:
        Number(cancelPolicy.default_hold_amount) ||
        DEFAULT_RESERVATION_CANCEL_POLICY.default_hold_amount,
      method: 'BANK_TRANSFER',
      hold_from: todayStr,
      hold_until: addDaysStr(todayStr, Math.min(5, Number(cancelPolicy.max_hold_days || 30))),
      evidence: [],
      note: '',
    });
    setCreateRsvOpen(true);
  };

  const handleSubmitCreateReservation = async (e) => {
    e.preventDefault();
    const holdAmt = Number(String(createRsvForm.hold_amount ?? '').trim());
    if (!Number.isInteger(holdAmt) || holdAmt <= 0) {
      toast.warning('Tiền đặt cọc giữ chỗ phải là số nguyên dương VND.');
      return;
    }
    setSaving(true);
    try {
      await buildingsService.createReservation(
        {
          apartment_id: id,
          prospect_name: createRsvForm.prospect_name.trim(),
          phone: createRsvForm.phone.trim(),
          hold_amount: holdAmt,
          method: createRsvForm.method || 'BANK_TRANSFER',
          hold_from: createRsvForm.hold_from || undefined,
          hold_until: createRsvForm.hold_until,
          evidence: Array.isArray(createRsvForm.evidence) ? createRsvForm.evidence : [],
          note: createRsvForm.note.trim(),
        },
        { idempotencyKey: createRsvIdemRef.current }
      );
      toast.success('Đã ghi nhận đặt cọc giữ chỗ thành công.');
      setCreateRsvOpen(false);
      loadApartment();
    } catch (err) {
      toast.error(extractErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  // Confirm / Reject PENDING_CONFIRM payment
  const rejectIdemKeyRef = useRef(createIdempotencyKey());
  const [rejectModal, setRejectModal] = useState({
    open: false,
    reservation: null,
    reason: '',
  });

  const handleConfirmPayment = async (reservation) => {
    if (!reservation?.id) return;
    setSaving(true);
    try {
      const res = await buildingsService.confirmReservationPayment(
        reservation.id,
        {},
        { idempotencyKey: createIdempotencyKey() }
      );
      toast.success(res?.message || 'Đã xác nhận tiền về và khóa giữ chỗ căn hộ.');
      loadApartment();
    } catch (err) {
      toast.error(extractErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const handleOpenRejectModal = (reservation) => {
    rejectIdemKeyRef.current = createIdempotencyKey();
    setRejectModal({ open: true, reservation, reason: '' });
  };

  const handleSubmitRejectPayment = async (e) => {
    e?.preventDefault();
    const { reservation, reason } = rejectModal;
    const trimmed = String(reason || '').trim();
    if (!reservation?.id) return;
    if (!trimmed) {
      toast.warning('Vui lòng nhập lý do từ chối biên lai chuyển khoản.');
      return;
    }
    setSaving(true);
    try {
      const res = await buildingsService.rejectReservationPayment(
        reservation.id,
        { reason: trimmed },
        { idempotencyKey: rejectIdemKeyRef.current }
      );
      toast.success(res?.message || 'Đã từ chối yêu cầu giữ chỗ.');
      setRejectModal({ open: false, reservation: null, reason: '' });
      loadApartment();
    } catch (err) {
      toast.error(extractErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  // Step 1: MANAGER Proposal Modal (ROUND(x, -3) + BankSelect, without UNC)
  const settleIdemKeyRef = useRef(createIdempotencyKey());
  const [settleModal, setSettleModal] = useState({
    open: false,
    reservation: null,
    suggested: { refunded_amount: 0, forfeited_amount: 0 },
    refunded_amount: 0,
    forfeited_amount: 0,
    refund_method: 'BANK_TRANSFER',
    bank_name: '',
    bank_code: '',
    bank_bin: '',
    bank_logo: '',
    account_number: '',
    account_holder: '',
    reason: '',
  });

  const handleOpenCancelSettleModal = (reservation) => {
    settleIdemKeyRef.current = createIdempotencyKey();
    const suggested = computeSuggestedCancelSplit({
      holdAmount: Number(reservation.hold_amount || 0),
      holdUntil: reservation.hold_until,
      todayStr,
      policy: cancelPolicy,
    });
    const existingBank = reservation.refund_bank_info || {};
    setSettleModal({
      open: true,
      reservation,
      suggested,
      refunded_amount: suggested.refunded_amount,
      forfeited_amount: suggested.forfeited_amount,
      refund_method: reservation.refund_method || 'BANK_TRANSFER',
      bank_name: existingBank.bank_name || '',
      bank_code: existingBank.bank_code || '',
      bank_bin: existingBank.bank_bin || '',
      bank_logo: existingBank.bank_logo || '',
      account_number: existingBank.account_number || '',
      account_holder: existingBank.account_holder || reservation.prospect_name || '',
      reason: '',
    });
  };

  const handleChangeSettleRefunded = (rawVal) => {
    const total = Number(settleModal.reservation?.hold_amount || 0);
    const num = Math.min(total, Math.max(0, Math.round(Number(rawVal || 0))));
    setSettleModal((p) => ({
      ...p,
      refunded_amount: num,
      forfeited_amount: Math.max(0, total - num),
    }));
  };

  const handleSubmitCancelSettle = async (e) => {
    e?.preventDefault();
    const rsv = settleModal.reservation;
    if (!rsv?.id) return;
    const total = Number(rsv.hold_amount || 0);
    const refAmt = Math.round(Number(settleModal.refunded_amount || 0));
    const forfAmt = Math.round(Number(settleModal.forfeited_amount || 0));
    if (refAmt < 0 || forfAmt < 0 || refAmt + forfAmt !== total) {
      toast.warning(`Tổng tiền hoàn + tiền phạt phải bằng đúng ${formatMoney(total)}.`);
      return;
    }
    const trimmedReason = String(settleModal.reason || '').trim();
    if (!trimmedReason) {
      toast.warning('Vui lòng nhập lý do đề xuất thanh lý hủy giữ chỗ.');
      return;
    }
    if (refAmt > 0 && settleModal.refund_method === 'BANK_TRANSFER') {
      if (
        !String(settleModal.bank_name || '').trim() ||
        !String(settleModal.account_number || '').trim() ||
        !String(settleModal.account_holder || '').trim()
      ) {
        toast.warning('Vui lòng nhập đầy đủ Ngân hàng, Số tài khoản và Chủ tài khoản nhận hoàn.');
        return;
      }
    }

    setSaving(true);
    try {
      const payload = {
        refunded_amount: refAmt,
        forfeited_amount: forfAmt,
        reason: trimmedReason,
        refund_method: settleModal.refund_method,
      };
      if (refAmt > 0 && settleModal.refund_method === 'BANK_TRANSFER') {
        payload.refund_bank_info = {
          bank_name: String(settleModal.bank_name).trim(),
          bank_code: settleModal.bank_code || undefined,
          bank_bin: settleModal.bank_bin || undefined,
          bank_logo: settleModal.bank_logo || undefined,
          account_number: String(settleModal.account_number).trim(),
          account_holder: String(settleModal.account_holder).trim(),
        };
      }
      const res = await buildingsService.cancelSettleReservation(rsv.id, payload, {
        idempotencyKey: settleIdemKeyRef.current,
      });
      toast.success(res?.message || 'Đã gửi đề xuất thanh lý hủy giữ chỗ chờ phê duyệt.');
      setSettleModal((p) => ({ ...p, open: false, reservation: null }));
      loadApartment();
    } catch (err) {
      toast.error(extractErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  // Step 2: OWNER / Four-Eyes Approver Review Modal (Approve or Reject)
  const reviewCancelIdemRef = useRef(createIdempotencyKey());
  const [reviewCancelModal, setReviewCancelModal] = useState({
    open: false,
    reservation: null,
    mode: 'approve',
    note: '',
    rejectReason: '',
  });

  const handleOpenReviewCancelModal = (reservation, mode = 'approve') => {
    reviewCancelIdemRef.current = createIdempotencyKey();
    setReviewCancelModal({
      open: true,
      reservation,
      mode,
      note: '',
      rejectReason: '',
    });
  };

  const handleSubmitReviewCancel = async (e) => {
    e?.preventDefault();
    const rsv = reviewCancelModal.reservation;
    if (!rsv?.id) return;

    if (reviewCancelModal.mode === 'reject') {
      const trimmedReason = String(reviewCancelModal.rejectReason || '').trim();
      if (!trimmedReason) {
        toast.warning('Vui lòng nhập lý do từ chối đề xuất thanh lý giữ chỗ.');
        return;
      }
      setSaving(true);
      try {
        const res = await buildingsService.rejectReservationCancel(
          rsv.id,
          { reason: trimmedReason },
          { idempotencyKey: reviewCancelIdemRef.current }
        );
        toast.success(res?.message || 'Đã từ chối đề xuất thanh lý hủy giữ chỗ.');
        setReviewCancelModal({ open: false, reservation: null, mode: 'approve', note: '', rejectReason: '' });
        loadApartment();
      } catch (err) {
        toast.error(extractErrorMessage(err));
      } finally {
        setSaving(false);
      }
      return;
    }

    setSaving(true);
    try {
      const res = await buildingsService.approveReservationCancel(
        rsv.id,
        { note: String(reviewCancelModal.note || '').trim() || undefined },
        { idempotencyKey: reviewCancelIdemRef.current }
      );
      toast.success(res?.message || 'Đã phê duyệt phương án thanh lý hủy giữ chỗ.');
      setReviewCancelModal({ open: false, reservation: null, mode: 'approve', note: '', rejectReason: '' });
      loadApartment();
    } catch (err) {
      toast.error(extractErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  // Step 3: MANAGER Payout with UNC & Edit Refund Bank Info Modals
  const payoutCancelIdemRef = useRef(createIdempotencyKey());
  const [payoutCancelModal, setPayoutCancelModal] = useState({
    open: false,
    reservation: null,
    refund_method: 'BANK_TRANSFER',
    bank_name: '',
    bank_code: '',
    bank_bin: '',
    bank_logo: '',
    account_number: '',
    account_holder: '',
    refund_evidence: [],
    reference_code: '',
    note: '',
  });

  const handleOpenPayoutCancelModal = (reservation) => {
    payoutCancelIdemRef.current = createIdempotencyKey();
    const existingBank = reservation.refund_bank_info || {};
    setPayoutCancelModal({
      open: true,
      reservation,
      refund_method: reservation.refund_method || 'BANK_TRANSFER',
      bank_name: existingBank.bank_name || '',
      bank_code: existingBank.bank_code || '',
      bank_bin: existingBank.bank_bin || '',
      bank_logo: existingBank.bank_logo || '',
      account_number: existingBank.account_number || '',
      account_holder: existingBank.account_holder || reservation.prospect_name || '',
      refund_evidence: [],
      reference_code: '',
      note: '',
    });
  };

  const handleSubmitPayoutCancel = async (e) => {
    e?.preventDefault();
    const rsv = payoutCancelModal.reservation;
    if (!rsv?.id) return;
    const method = payoutCancelModal.refund_method || 'BANK_TRANSFER';
    const evList = Array.isArray(payoutCancelModal.refund_evidence)
      ? payoutCancelModal.refund_evidence.filter(Boolean)
      : [];

    if (method === 'BANK_TRANSFER') {
      if (
        !String(payoutCancelModal.bank_name || '').trim() ||
        !String(payoutCancelModal.account_number || '').trim() ||
        !String(payoutCancelModal.account_holder || '').trim()
      ) {
        toast.warning('Vui lòng nhập đầy đủ Ngân hàng, Số tài khoản và Chủ tài khoản nhận hoàn.');
        return;
      }
      if (evList.length === 0) {
        toast.warning(
          'Chi hoàn tiền giữ chỗ qua chuyển khoản bắt buộc đính kèm ít nhất 01 ảnh chứng từ UNC.'
        );
        return;
      }
    }

    setSaving(true);
    try {
      const payload = {
        refund_method: method,
        refund_evidence: evList,
        reference_code: String(payoutCancelModal.reference_code || '').trim() || undefined,
        note: String(payoutCancelModal.note || '').trim() || undefined,
      };
      if (method === 'BANK_TRANSFER') {
        payload.refund_bank_info = {
          bank_name: String(payoutCancelModal.bank_name).trim(),
          bank_code: payoutCancelModal.bank_code || undefined,
          bank_bin: payoutCancelModal.bank_bin || undefined,
          bank_logo: payoutCancelModal.bank_logo || undefined,
          account_number: String(payoutCancelModal.account_number).trim(),
          account_holder: String(payoutCancelModal.account_holder).trim(),
        };
      }
      const res = await buildingsService.payoutReservationCancel(rsv.id, payload, {
        idempotencyKey: payoutCancelIdemRef.current,
      });
      toast.success(res?.message || 'Đã xác nhận chi hoàn tiền giữ chỗ và lưu chứng từ UNC.');
      setPayoutCancelModal((p) => ({ ...p, open: false, reservation: null }));
      loadApartment();
    } catch (err) {
      toast.error(extractErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const editRsvBankIdemRef = useRef(createIdempotencyKey());
  const [editRsvBankModal, setEditRsvBankModal] = useState({
    open: false,
    reservation: null,
    bank_name: '',
    bank_code: '',
    bank_bin: '',
    bank_logo: '',
    account_number: '',
    account_holder: '',
  });

  const handleOpenEditRsvBankModal = (reservation) => {
    editRsvBankIdemRef.current = createIdempotencyKey();
    const existingBank = reservation.refund_bank_info || {};
    setEditRsvBankModal({
      open: true,
      reservation,
      bank_name: existingBank.bank_name || '',
      bank_code: existingBank.bank_code || '',
      bank_bin: existingBank.bank_bin || '',
      bank_logo: existingBank.bank_logo || '',
      account_number: existingBank.account_number || '',
      account_holder: existingBank.account_holder || reservation.prospect_name || '',
    });
  };

  const handleSubmitEditRsvBank = async (e) => {
    e?.preventDefault();
    const rsv = editRsvBankModal.reservation;
    if (!rsv?.id) return;
    if (
      !String(editRsvBankModal.bank_name || '').trim() ||
      !String(editRsvBankModal.account_number || '').trim() ||
      !String(editRsvBankModal.account_holder || '').trim()
    ) {
      toast.warning('Vui lòng nhập đầy đủ Ngân hàng, Số tài khoản và Chủ tài khoản nhận hoàn.');
      return;
    }
    setSaving(true);
    try {
      const res = await buildingsService.updateReservationBankInfo(
        rsv.id,
        {
          bank_info: {
            bank_name: String(editRsvBankModal.bank_name).trim(),
            bank_code: editRsvBankModal.bank_code || undefined,
            bank_bin: editRsvBankModal.bank_bin || undefined,
            bank_logo: editRsvBankModal.bank_logo || undefined,
            account_number: String(editRsvBankModal.account_number).trim(),
            account_holder: String(editRsvBankModal.account_holder).trim(),
          },
        },
        { idempotencyKey: editRsvBankIdemRef.current }
      );
      toast.success(res?.message || 'Đã cập nhật tài khoản nhận hoàn tiền giữ chỗ.');
      setEditRsvBankModal((p) => ({ ...p, open: false, reservation: null }));
      loadApartment();
    } catch (err) {
      toast.error(extractErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  if (loading && !apt) return <PageSkeleton />;
  if (!apt) return null;

  const manualTransitions = (apt.allowed_transitions || []).filter(
    (st) => !['OCCUPIED', 'RESERVED'].includes(st)
  );
  const amenityKeys =
    apt.amenities && typeof apt.amenities === 'object'
      ? Object.entries(apt.amenities)
          .filter(([, v]) => Boolean(v))
          .map(([k, v]) => (typeof v === 'string' ? `${k}: ${v}` : k))
      : [];
  const maxInternalHoldDays = Number(cancelPolicy.max_hold_days || 30);

  return (
    <div className="space-y-6">
      <PageHeader
        title={`Căn hộ ${apt.code}`}
        subtitle={`${apt.building_code} — ${apt.building_name} · ${apt.floor_name || ''}${
          apt.zone_code ? ` · Khu ${apt.zone_code}` : ''
        }`}
        breadcrumbs={[
          { label: 'Bất động sản', to: '/admin/buildings' },
          { label: apt.building_code, to: `/admin/buildings/${apt.building_id}` },
          { label: 'Sơ đồ tầng', to: `/admin/buildings/${apt.building_id}/floor-plan` },
          { label: `Căn ${apt.code}` },
        ]}
        actions={
          <>
            {canEditRealEstate && apt.status === 'MAINTENANCE' ? (
              <Button variant="success" size="sm" icon={CheckCircle2} onClick={handleOpenHandoverModal} loading={saving}>
                Nghiệm thu &amp; Bàn giao
              </Button>
            ) : null}
            {isManager && ['AVAILABLE', 'RESERVED', 'OCCUPIED'].includes(apt.status) ? (
              <Button
                variant="warning"
                size="sm"
                icon={BookmarkPlus}
                onClick={handleOpenCreateReservation}
              >
                Đặt cọc giữ chỗ
              </Button>
            ) : null}
            {isManager && ['AVAILABLE', 'RESERVED', 'OCCUPIED'].includes(apt.status) ? (
              <Button
                size="sm"
                icon={Plus}
                onClick={() => navigate(`/admin/contracts?apartment_id=${apt.id}`)}
              >
                Tạo hợp đồng thuê
              </Button>
            ) : null}
            {canEditRealEstate ? (
              <Button variant="outline" size="sm" icon={Edit3} onClick={() => setEditOpen(true)}>
                Chỉnh sửa
              </Button>
            ) : null}
          </>
        }
      />

      {/* Info & State Machine */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <Card className="lg:col-span-2 space-y-4">
          <CardHeader title="Thông số kỹ thuật & Tiện nghi" />
          <div className="grid grid-cols-2 sm:grid-cols-3 2xl:grid-cols-5 gap-3.5">
            <div className="p-3 rounded-xl bg-slate-50 border border-slate-100">
              <p className="text-xs text-slate-400">Trạng thái</p>
              <div className="mt-1">
                <StatusBadge status={apt.status} domain="apartment" />
              </div>
            </div>
            <div className="p-3 rounded-xl bg-slate-50 border border-slate-100">
              <p className="text-xs text-slate-400">Phân khu (Khu)</p>
              <div className="mt-1">
                {apt.zone_id ? (
                  <Link
                    to={`/admin/buildings/${apt.building_id}/zones/${apt.zone_id}`}
                    className="inline-flex items-start gap-1 text-xs font-semibold text-primary-700 hover:underline"
                  >
                    <Layers className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                    <span className="break-words">
                      {apt.zone_code}
                      {apt.zone_name ? ` — ${apt.zone_name}` : ''}
                    </span>
                  </Link>
                ) : (
                  <span className="text-xs text-slate-400 italic">Chưa gán khu</span>
                )}
              </div>
            </div>
            <div className="p-3 rounded-xl bg-slate-50 border border-slate-100">
              <p className="text-xs text-slate-400">Giá niêm yết</p>
              <p className="text-sm font-bold text-primary-600 mt-1 tabular-nums break-words">
                {formatMoney(apt.base_rent)}
              </p>
            </div>
            <div className="p-3 rounded-xl bg-slate-50 border border-slate-100">
              <p className="text-xs text-slate-400">Diện tích</p>
              <p className="text-sm font-bold text-slate-800 mt-1">{apt.area_m2 || 0} m²</p>
            </div>
            <div className="p-3 rounded-xl bg-slate-50 border border-slate-100 col-span-2 sm:col-span-1">
              <p className="text-xs text-slate-400">Thiết kế</p>
              <p className="text-sm font-bold text-slate-800 mt-1">
                {apt.type || '1PN'} ({apt.bedrooms || 1} PN)
              </p>
            </div>
          </div>

          <div>
            <p className="text-xs font-semibold text-slate-600 mb-2">Danh sách nội thất / tiện nghi</p>
            {amenityKeys.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {amenityKeys.map((k) => (
                  <Badge key={k} variant="sky">
                    {k}
                  </Badge>
                ))}
              </div>
            ) : (
              <p className="text-xs text-slate-400">Chưa khai báo danh mục tiện nghi chi tiết.</p>
            )}
          </div>

          {apt.note ? (
            <div className="p-3 rounded-xl bg-amber-50/50 border border-amber-100 text-xs text-slate-700">
              <span className="font-semibold">Ghi chú:</span> {apt.note}
            </div>
          ) : null}
        </Card>

        <Card className="space-y-4">
          <CardHeader
            title="Chuyển trạng thái (FR-008)"
            subtitle="OCCUPIED & RESERVED tự động đồng bộ qua Hợp đồng / Giữ chỗ"
          />
          {canEditRealEstate && manualTransitions.length > 0 ? (
            <div className="flex flex-col gap-2">
              {manualTransitions.map((st) => (
                <Button
                  key={st}
                  variant="outline"
                  size="sm"
                  loading={saving}
                  onClick={() => handleTransition(st)}
                  className="justify-between"
                >
                  <span>Chuyển sang: {APARTMENT_STATUS[st]?.label || st}</span>
                  <StatusBadge status={st} domain="apartment" />
                </Button>
              ))}
            </div>
          ) : (
            <p className="text-xs text-slate-500">
              Không có chuyển đổi thủ công khả dụng ở trạng thái hiện tại.
            </p>
          )}

          {/* Meters Quick Summary */}
          <div className="pt-3 border-t border-slate-100 space-y-2">
            <p className="text-xs font-semibold text-slate-700 flex items-center gap-1.5">
              <Gauge className="w-4 h-4 text-primary-500" />
              Đồng hồ Điện / Nước
            </p>
            {(apt.meters || []).length === 0 ? (
              <p className="text-xs text-slate-400">Chưa gắn đồng hồ.</p>
            ) : (
              apt.meters.map((m) => (
                <div key={m.id} className="flex items-center justify-between text-xs p-2.5 rounded-lg bg-slate-50">
                  <div>
                    <span className="font-semibold text-slate-800">
                      {m.meter_type === 'ELECTRICITY' ? 'Điện' : 'Nước'} ({m.meter_code})
                    </span>
                    <p className="text-[11px] text-slate-400">
                      Đơn giá: {formatMoney(m.unit_price)}/{m.unit}
                    </p>
                  </div>
                  <div className="text-right">
                    <span className="font-bold text-primary-700">
                      {m.latest_reading ?? m.initial_reading} {m.unit}
                    </span>
                    {m.latest_period ? <p className="text-[11px] text-slate-400">Kỳ {m.latest_period}</p> : null}
                  </div>
                </div>
              ))
            )}
          </div>
        </Card>
      </div>

      {/* Contracts & Reservations */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card padding={false} className="overflow-hidden min-w-0">
          <div className="p-5 pb-3 flex items-center gap-2">
            <FileSignature className="w-4 h-4 text-primary-500" />
            <h3 className="text-sm font-semibold text-slate-900">Lịch sử Hợp đồng của căn hộ</h3>
          </div>
          <DataTable
            embedded
            data={apt.contracts || []}
            onRowClick={(c) => navigate(`/admin/contracts/${c.id}`)}
            emptyTitle="Chưa phát sinh hợp đồng"
            columns={[
              {
                key: 'tenant_name',
                label: 'Khách thuê',
                render: (r) => <span className="font-medium text-slate-900">{r.tenant_name || '—'}</span>,
              },
              {
                key: 'period',
                label: 'Kỳ hạn',
                align: 'center',
                className: 'whitespace-nowrap text-xs',
                render: (r) => `${formatDate(r.start_date)} → ${formatDate(r.end_date)}`,
              },
              {
                key: 'rent_amount',
                label: 'Giá thuê',
                align: 'right',
                className: 'font-mono tabular-nums whitespace-nowrap',
                render: (r) => formatMoney(r.rent_amount),
              },
              {
                key: 'status',
                label: 'Trạng thái',
                align: 'center',
                render: (r) => <StatusBadge status={r.status} domain="contract" />,
              },
            ]}
          />
        </Card>

        <Card padding={false} className="overflow-hidden min-w-0">
          <div className="p-5 pb-3 flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Bookmark className="w-4 h-4 text-amber-500" />
              <h3 className="text-sm font-semibold text-slate-900">Hồ sơ Đặt cọc Giữ chỗ</h3>
            </div>
          </div>
          <DataTable
            embedded
            data={apt.reservations || []}
            emptyTitle="Chưa có hồ sơ giữ chỗ"
            columns={[
              {
                key: 'prospect_name',
                label: 'Khách đặt / Chứng từ',
                render: (r) => (
                  <div className="space-y-1">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="font-medium text-slate-900">{r.prospect_name}</span>
                      <Badge variant={r.source === 'PUBLIC' ? 'sky' : 'slate'}>
                        {r.source === 'PUBLIC' ? 'Online' : 'Nội bộ'}
                      </Badge>
                    </div>
                    {r.phone ? <p className="text-xs font-mono text-slate-500">{r.phone}</p> : null}
                    {r.method ? (
                      <p className="text-[11px] text-slate-500">
                        Phương thức: {PAYMENT_METHOD_LABELS[r.method] || r.method}
                      </p>
                    ) : null}
                    {r.note ? <p className="text-[11px] text-slate-500 whitespace-pre-line">{r.note}</p> : null}
                    {r.rejected_reason ? (
                      <p className="text-[11px] text-rose-600">
                        Lý do từ chối: {r.rejected_reason}
                      </p>
                    ) : null}
                    {r.cancel_reason ? (
                      <p className="text-[11px] text-amber-700">
                        Lý do thanh lý: {r.cancel_reason}
                      </p>
                    ) : null}
                    {r.cancel_settlement?.rejected_reason &&
                    ['HELD', 'EXPIRED'].includes(r.status) ? (
                      <p className="text-[11px] text-rose-600">
                        Lý do từ chối đề xuất hủy: {r.cancel_settlement.rejected_reason}
                      </p>
                    ) : null}
                    {r.refund_bank_info?.account_number ? (
                      <p className="text-[11px] text-slate-600">
                        STK hoàn: {r.refund_bank_info.bank_name} • {r.refund_bank_info.account_number} (
                        {r.refund_bank_info.account_holder})
                      </p>
                    ) : null}
                    {Array.isArray(r.evidence) && r.evidence.length > 0 ? (
                      <div className="flex flex-wrap gap-1.5 pt-1">
                        {r.evidence.map((url, idx) => (
                          <AuthImage
                            key={`${r.id}-ev-${idx}`}
                            src={url}
                            alt="Biên lai giữ chỗ"
                            className="w-10 h-10 rounded-lg object-cover border border-slate-200"
                          />
                        ))}
                      </div>
                    ) : null}
                    {Array.isArray(r.refund_evidence) && r.refund_evidence.length > 0 ? (
                      <div className="flex flex-wrap items-center gap-1.5 pt-1">
                        <span className="text-[10px] font-semibold text-emerald-700">UNC hoàn:</span>
                        {r.refund_evidence.map((url, idx) => (
                          <AuthImage
                            key={`${r.id}-ref-ev-${idx}`}
                            src={url}
                            alt="UNC hoàn giữ chỗ"
                            className="w-10 h-10 rounded-lg object-cover border border-emerald-200"
                          />
                        ))}
                      </div>
                    ) : null}
                  </div>
                ),
              },
              {
                key: 'hold_amount',
                label: 'Tiền giữ chỗ',
                align: 'right',
                className: 'font-mono tabular-nums whitespace-nowrap',
                render: (r) => (
                  <div className="space-y-0.5">
                    <div>{formatMoney(r.hold_amount)}</div>
                    {Number(r.refunded_amount || 0) + Number(r.forfeited_amount || 0) > 0 ? (
                      <div className="text-[10px] text-slate-500">
                        Hoàn {formatMoney(r.refunded_amount || 0)} • Phạt{' '}
                        {formatMoney(r.forfeited_amount || 0)}
                      </div>
                    ) : null}
                  </div>
                ),
              },
              {
                key: 'hold_until',
                label: 'Khoảng giữ chỗ',
                align: 'center',
                className: 'whitespace-nowrap text-xs',
                render: (r) => `${formatDate(r.hold_from || r.created_at)} → ${formatDate(r.hold_until)}`,
              },
              {
                key: 'actions',
                label: 'Trạng thái / Xử lý',
                align: 'center',
                className: 'whitespace-nowrap',
                render: (r) => {
                  const canConfirm = canManagerConfirmReservationPayment(r, { isManager });
                  const canPropose =
                    canProposeReservationCancel(r, { isManager }) &&
                    Number(r.hold_amount || 0) > 0;
                  const canApprove = canApproveReservationCancel(r, {
                    isOwner,
                    isManager,
                    isSysAdmin,
                    currentUserId,
                    buildingHasActiveOwner: Boolean(
                      r.building_has_active_owner ?? apt.building_has_active_owner
                    ),
                    allowSelfApproval,
                  });
                  const canPayout = canPayoutReservationCancel(r, { isManager });

                  return (
                    <div className="inline-flex flex-col items-center gap-1.5">
                      <StatusBadge status={r.status} domain="reservation" />
                      {canConfirm ? (
                        <div className="inline-flex items-center justify-center gap-1">
                          <Button
                            size="xs"
                            variant="success"
                            icon={CheckCircle2}
                            loading={saving}
                            onClick={() => handleConfirmPayment(r)}
                          >
                            Xác nhận tiền về
                          </Button>
                          <Button
                            size="xs"
                            variant="danger"
                            icon={XCircle}
                            disabled={saving}
                            onClick={() => handleOpenRejectModal(r)}
                          >
                            Từ chối biên lai
                          </Button>
                        </div>
                      ) : null}

                      {canPropose ? (
                        <Button
                          size="xs"
                          variant="outline"
                          icon={Scale}
                          onClick={() => handleOpenCancelSettleModal(r)}
                        >
                          Đề xuất thanh lý hủy
                        </Button>
                      ) : null}

                      {canApprove ? (
                        <div className="inline-flex items-center justify-center gap-1">
                          <Button
                            size="xs"
                            variant="success"
                            icon={ShieldCheck}
                            disabled={saving}
                            onClick={() => handleOpenReviewCancelModal(r, 'approve')}
                          >
                            Duyệt thanh lý hủy
                          </Button>
                          <Button
                            size="xs"
                            variant="danger"
                            icon={XCircle}
                            disabled={saving}
                            onClick={() => handleOpenReviewCancelModal(r, 'reject')}
                          >
                            Từ chối
                          </Button>
                        </div>
                      ) : null}

                      {canPayout ? (
                        <div className="inline-flex items-center justify-center gap-1">
                          <Button
                            size="xs"
                            variant="primary"
                            icon={Wallet}
                            disabled={saving}
                            onClick={() => handleOpenPayoutCancelModal(r)}
                          >
                            Chi hoàn &amp; Tải UNC
                          </Button>
                          <Button
                            size="xs"
                            variant="outline"
                            icon={Edit3}
                            disabled={saving}
                            onClick={() => handleOpenEditRsvBankModal(r)}
                          >
                            Sửa STK
                          </Button>
                        </div>
                      ) : null}
                    </div>
                  );
                },
              },
            ]}
          />
        </Card>
      </div>

      {/* Maintenance History */}
      {(apt.service_requests || []).length > 0 ? (
        <Card padding={false} className="overflow-hidden min-w-0">
          <div className="p-5 pb-3 flex items-center gap-2">
            <Wrench className="w-4 h-4 text-amber-500" />
            <h3 className="text-sm font-semibold text-slate-900">Lịch sử Yêu cầu Bảo trì / Báo hỏng</h3>
          </div>
          <DataTable
            embedded
            data={apt.service_requests}
            onRowClick={() => navigate('/admin/maintenance')}
            columns={[
              {
                key: 'tracking_code',
                label: 'Mã YC',
                render: (r) => <span className="font-mono text-xs">{r.tracking_code}</span>,
              },
              { key: 'title', label: 'Nội dung' },
              {
                key: 'created_at',
                label: 'Ngày báo',
                align: 'center',
                className: 'whitespace-nowrap',
                render: (r) => formatDate(r.created_at),
              },
              {
                key: 'status',
                label: 'Trạng thái',
                align: 'center',
                render: (r) => <StatusBadge status={r.status} domain="service_request" />,
              },
            ]}
          />
        </Card>
      ) : null}

      {/* Handover Inspection Modal (FR-024, R-12) */}
      <Modal
        open={handoverModalOpen}
        onClose={() => {
          if (!saving) setHandoverModalOpen(false);
        }}
        title={`Nghiệm thu & Bàn giao căn ${apt.code}`}
        subtitle="Đính kèm hình ảnh hiện trạng bàn giao để đủ điều kiện tất toán tiền đặt cọc (FR-024, R-12)"
        size="md"
      >
        <form onSubmit={handleHandover} className="space-y-4">
          <FileUpload
            label="Ảnh biên bản / hiện trạng bàn giao phòng (Khuyến nghị ≥ 1 ảnh cho tất toán cọc)"
            multiple
            maxFiles={5}
            value={handoverForm.evidence}
            onChange={(vals) => setHandoverForm((p) => ({ ...p, evidence: vals }))}
            hint="Ảnh chụp hiện trạng nội thất, đồng hồ điện nước hoặc biên bản có chữ ký hai bên"
          />
          <Input
            label="Ghi chú kiểm tra bàn giao"
            multiline
            rows={3}
            placeholder="VD: Đã kiểm tra điều hòa, tủ bếp, sàn gỗ — nguyên trạng tốt..."
            value={handoverForm.note}
            onChange={(e) => setHandoverForm((p) => ({ ...p, note: e.target.value }))}
          />
          <label className="flex items-start gap-2.5 p-3 rounded-xl bg-amber-50/70 border border-amber-200 cursor-pointer text-xs text-slate-700">
            <input
              type="checkbox"
              checked={Boolean(handoverForm.keep_maintenance)}
              onChange={(e) =>
                setHandoverForm((p) => ({ ...p, keep_maintenance: e.target.checked }))
              }
              className="mt-0.5 rounded border-slate-300 text-primary-600 focus:ring-primary-500"
            />
            <span>
              <strong>Giữ căn hộ ở trạng thái Đang bảo trì (MAINTENANCE)</strong> — chỉ ghi nhận biên bản nghiệm thu kèm ảnh để tất toán tiền cọc trước, chưa mở bán phòng ngay.
            </span>
          </label>
          <div className="flex justify-end gap-2 pt-2">
            <Button
              variant="outline"
              onClick={() => setHandoverModalOpen(false)}
              disabled={saving}
            >
              Hủy
            </Button>
            <Button type="submit" variant="success" loading={saving}>
              {handoverForm.keep_maintenance
                ? 'Lưu biên bản nghiệm thu'
                : 'Nghiệm thu & Mở bán (AVAILABLE)'}
            </Button>
          </div>
        </form>
      </Modal>

      {/* Internal Create Reservation Modal */}
      <Modal
        open={createRsvOpen}
        onClose={() => {
          if (!saving) setCreateRsvOpen(false);
        }}
        title={`Đặt cọc giữ chỗ — Căn ${apt.code}`}
        subtitle={`Giữ chỗ nội bộ tối đa ${maxInternalHoldDays} ngày theo chính sách FR-067`}
      >
        <form onSubmit={handleSubmitCreateReservation} className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
            <Input
              label="Họ tên khách đặt giữ chỗ"
              required
              value={createRsvForm.prospect_name}
              onChange={(e) =>
                setCreateRsvForm((p) => ({ ...p, prospect_name: e.target.value }))
              }
            />
            <Input
              label="Số điện thoại"
              required
              placeholder="0912345678"
              value={createRsvForm.phone}
              onChange={(e) => setCreateRsvForm((p) => ({ ...p, phone: e.target.value }))}
            />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
            <MoneyInput
              label="Tiền cọc giữ chỗ (VND)"
              required
              value={createRsvForm.hold_amount}
              onChange={(e) =>
                setCreateRsvForm((p) => ({ ...p, hold_amount: e.target.value }))
              }
            />
            <Select
              label="Phương thức thu tiền"
              value={createRsvForm.method}
              onChange={(e) => setCreateRsvForm((p) => ({ ...p, method: e.target.value }))}
              options={PAYMENT_METHOD_OPTIONS}
            />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
            <Input
              label="Giữ chỗ từ ngày"
              type="date"
              required
              min={todayStr}
              value={createRsvForm.hold_from}
              onChange={(e) => setCreateRsvForm((p) => ({ ...p, hold_from: e.target.value }))}
            />
            <Input
              label={`Đến hết ngày (tối đa ${maxInternalHoldDays} ngày)`}
              type="date"
              required
              min={addDaysStr(createRsvForm.hold_from || todayStr, 1)}
              max={
                createRsvForm.hold_from
                  ? addDaysStr(createRsvForm.hold_from, maxInternalHoldDays)
                  : undefined
              }
              value={createRsvForm.hold_until}
              onChange={(e) =>
                setCreateRsvForm((p) => ({ ...p, hold_until: e.target.value }))
              }
            />
          </div>
          <FileUpload
            label="Ảnh biên lai / phiếu thu giữ chỗ (tùy chọn, tối đa 5 ảnh)"
            multiple
            maxFiles={5}
            value={createRsvForm.evidence}
            onChange={(vals) => setCreateRsvForm((p) => ({ ...p, evidence: vals }))}
          />
          <Input
            label="Ghi chú"
            multiline
            rows={2}
            value={createRsvForm.note}
            onChange={(e) => setCreateRsvForm((p) => ({ ...p, note: e.target.value }))}
          />
          <div className="flex justify-end gap-2 pt-2">
            <Button
              variant="outline"
              disabled={saving}
              onClick={() => setCreateRsvOpen(false)}
            >
              Hủy
            </Button>
            <Button type="submit" loading={saving}>
              Xác nhận giữ chỗ
            </Button>
          </div>
        </form>
      </Modal>

      {/* Reject Payment Modal */}
      <Modal
        open={rejectModal.open}
        onClose={() => {
          if (!saving) setRejectModal({ open: false, reservation: null, reason: '' });
        }}
        title="Từ chối xác nhận biên lai giữ chỗ"
        subtitle={
          rejectModal.reservation
            ? `Khách: ${rejectModal.reservation.prospect_name} • ${formatMoney(
                rejectModal.reservation.hold_amount
              )}`
            : ''
        }
        size="sm"
      >
        <form onSubmit={handleSubmitRejectPayment} className="space-y-4">
          <Input
            label="Lý do từ chối biên lai (bắt buộc)"
            required
            multiline
            rows={3}
            placeholder="VD: Sao kê ngân hàng chưa ghi nhận khoản tiền..."
            value={rejectModal.reason}
            onChange={(e) => setRejectModal((p) => ({ ...p, reason: e.target.value }))}
          />
          <div className="flex justify-end gap-2 pt-2">
            <Button
              variant="outline"
              disabled={saving}
              onClick={() => setRejectModal({ open: false, reservation: null, reason: '' })}
            >
              Hủy
            </Button>
            <Button type="submit" variant="danger" loading={saving}>
              Xác nhận từ chối
            </Button>
          </div>
        </form>
      </Modal>

      {/* Step 1: MANAGER Proposal Modal (ROUND(x, -3), no UNC) */}
      <Modal
        open={settleModal.open}
        onClose={() => {
          if (!saving) setSettleModal((p) => ({ ...p, open: false }));
        }}
        title="Đề xuất thanh lý hủy giữ chỗ (Bước 1 — BQL lập đề xuất)"
        subtitle={
          settleModal.reservation
            ? `Khách: ${settleModal.reservation.prospect_name} • Tiền giữ chỗ: ${formatMoney(
                settleModal.reservation.hold_amount
              )} • Hạn: ${formatDate(settleModal.reservation.hold_until)}`
            : ''
        }
        size="md"
      >
        {settleModal.reservation ? (
          <form onSubmit={handleSubmitCancelSettle} className="space-y-4">
            <div className="p-3.5 rounded-xl bg-sky-50 border border-sky-200 text-xs text-sky-900 space-y-2">
              <p>
                <strong>Gợi ý tự động theo chính sách tổ chức (làm tròn 1.000đ — PRD 10.3):</strong>{' '}
                Hoàn khách <strong>{formatMoney(settleModal.suggested.refunded_amount)}</strong> • Thu giữ phạt{' '}
                <strong>{formatMoney(settleModal.suggested.forfeited_amount)}</strong>.
              </p>
              <div className="flex flex-wrap gap-1.5">
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() =>
                    setSettleModal((p) => ({
                      ...p,
                      refunded_amount: p.suggested.refunded_amount,
                      forfeited_amount: p.suggested.forfeited_amount,
                    }))
                  }
                >
                  Áp dụng gợi ý chính sách
                </Button>
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() =>
                    setSettleModal((p) => ({
                      ...p,
                      refunded_amount: Number(p.reservation.hold_amount || 0),
                      forfeited_amount: 0,
                    }))
                  }
                >
                  Hoàn 100%
                </Button>
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() =>
                    setSettleModal((p) => ({
                      ...p,
                      refunded_amount: 0,
                      forfeited_amount: Number(p.reservation.hold_amount || 0),
                    }))
                  }
                >
                  Tịch thu 100%
                </Button>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
              <MoneyInput
                label="Số tiền đề xuất hoàn khách (VND)"
                required
                value={settleModal.refunded_amount}
                onChange={(e) => handleChangeSettleRefunded(e.target.value)}
              />
              <MoneyInput
                label="Số tiền thu giữ / phạt cọc (VND)"
                disabled
                value={settleModal.forfeited_amount}
              />
            </div>

            {Number(settleModal.refunded_amount || 0) > 0 ? (
              <div className="p-3.5 rounded-xl bg-slate-50 border border-slate-200 space-y-3.5">
                <Select
                  label="Phương thức hoàn tiền dự kiến"
                  value={settleModal.refund_method}
                  onChange={(e) =>
                    setSettleModal((p) => ({ ...p, refund_method: e.target.value }))
                  }
                  options={[
                    { value: 'BANK_TRANSFER', label: 'Chuyển khoản ngân hàng' },
                    { value: 'CASH', label: 'Tiền mặt tại quầy' },
                  ]}
                />

                {settleModal.refund_method === 'BANK_TRANSFER' ? (
                  <>
                    <BankSelect
                      label="Ngân hàng nhận hoàn (bắt buộc)"
                      required
                      value={settleModal.bank_name}
                      bankMeta={{
                        bank_code: settleModal.bank_code,
                        bank_bin: settleModal.bank_bin,
                        bank_logo: settleModal.bank_logo,
                      }}
                      onBankChange={(val, chosen) =>
                        setSettleModal((p) => ({
                          ...p,
                          bank_name: val || chosen?.shortName || chosen?.short_name || '',
                          bank_code: chosen?.code || '',
                          bank_bin: chosen?.bin || '',
                          bank_logo: chosen?.logo || '',
                        }))
                      }
                    />
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <Input
                        label="Số tài khoản nhận hoàn"
                        required
                        placeholder="Nhập STK ngân hàng"
                        value={settleModal.account_number}
                        onChange={(e) =>
                          setSettleModal((p) => ({ ...p, account_number: e.target.value }))
                        }
                      />
                      <Input
                        label="Chủ tài khoản (IN HOA)"
                        required
                        placeholder="NGUYEN VAN A"
                        value={settleModal.account_holder}
                        onChange={(e) =>
                          setSettleModal((p) => ({
                            ...p,
                            account_holder: e.target.value.toUpperCase(),
                          }))
                        }
                      />
                    </div>
                  </>
                ) : null}

                <p className="text-[11px] text-slate-600 bg-white p-2.5 rounded-lg border border-slate-200">
                  Chưa cần tải chứng từ UNC ở bước đề xuất. Sau khi Chủ nhà phê duyệt phương án hoàn trả, BQL sẽ thực hiện chuyển khoản và đính kèm ảnh UNC ở bước chi hoàn (PRD 6.2 &amp; 7.5).
                </p>
              </div>
            ) : null}

            <Input
              label="Lý do đề xuất thanh lý hủy (bắt buộc lưu vết kiểm toán)"
              required
              multiline
              rows={3}
              placeholder="VD: Khách báo hủy sát hạn hoàn 50% theo chính sách giữ chỗ..."
              value={settleModal.reason}
              onChange={(e) => setSettleModal((p) => ({ ...p, reason: e.target.value }))}
            />

            <div className="flex justify-end gap-2 pt-2">
              <Button
                variant="outline"
                onClick={() => setSettleModal((p) => ({ ...p, open: false }))}
                disabled={saving}
              >
                Hủy
              </Button>
              <Button type="submit" variant="primary" loading={saving}>
                Gửi đề xuất phê duyệt
              </Button>
            </div>
          </form>
        ) : null}
      </Modal>

      {/* Step 2: OWNER / Four-Eyes Approver Review Modal */}
      <Modal
        open={reviewCancelModal.open}
        onClose={() => {
          if (!saving) {
            setReviewCancelModal({
              open: false,
              reservation: null,
              mode: 'approve',
              note: '',
              rejectReason: '',
            });
          }
        }}
        title={
          reviewCancelModal.mode === 'reject'
            ? 'Từ chối đề xuất thanh lý hủy giữ chỗ'
            : 'Phê duyệt thanh lý hủy giữ chỗ (Bước 2 — Kiểm soát 4 mắt)'
        }
        subtitle={
          reviewCancelModal.reservation
            ? `Khách: ${reviewCancelModal.reservation.prospect_name} • Tiền giữ chỗ: ${formatMoney(
                reviewCancelModal.reservation.hold_amount
              )}`
            : ''
        }
        size="md"
      >
        {reviewCancelModal.reservation ? (
          <form onSubmit={handleSubmitReviewCancel} className="space-y-4">
            <div className="p-3.5 rounded-xl bg-slate-50 border border-slate-200 text-xs space-y-2">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                <div>
                  <span className="text-slate-500">Tổng giữ chỗ:</span>
                  <p className="font-bold text-slate-900">
                    {formatMoney(reviewCancelModal.reservation.hold_amount)}
                  </p>
                </div>
                <div>
                  <span className="text-slate-500">Đề xuất hoàn khách:</span>
                  <p className="font-bold text-emerald-700">
                    {formatMoney(reviewCancelModal.reservation.refunded_amount)}
                  </p>
                </div>
                <div>
                  <span className="text-slate-500">Đề xuất thu phạt:</span>
                  <p className="font-bold text-rose-700">
                    {formatMoney(reviewCancelModal.reservation.forfeited_amount)}
                  </p>
                </div>
              </div>
              {reviewCancelModal.reservation.cancel_reason ? (
                <p className="text-slate-700 pt-1 border-t border-slate-200/80">
                  <strong>Lý do BQL đề xuất:</strong> {reviewCancelModal.reservation.cancel_reason}
                </p>
              ) : null}
              {Number(reviewCancelModal.reservation.refunded_amount || 0) > 0 ? (
                <p className="text-slate-600">
                  <strong>Phương thức hoàn:</strong>{' '}
                  {PAYMENT_METHOD_LABELS[reviewCancelModal.reservation.refund_method] ||
                    reviewCancelModal.reservation.refund_method ||
                    'Chuyển khoản'}
                  {reviewCancelModal.reservation.refund_bank_info?.account_number
                    ? ` — ${reviewCancelModal.reservation.refund_bank_info.bank_name} • ${reviewCancelModal.reservation.refund_bank_info.account_number} (${reviewCancelModal.reservation.refund_bank_info.account_holder})`
                    : ''}
                </p>
              ) : null}
            </div>

            {reviewCancelModal.reservation.cancel_settlement?.policy_override ? (
              <div className="p-3 rounded-xl bg-amber-50 border border-amber-200 text-xs text-amber-900">
                <strong>Cảnh báo lệch chính sách chuẩn:</strong> Mức đề xuất khác với gợi ý tự động của hệ thống (Hoàn{' '}
                {formatMoney(
                  reviewCancelModal.reservation.cancel_settlement?.policy_suggested_split
                    ?.refunded_amount || 0
                )}{' '}
                • Phạt{' '}
                {formatMoney(
                  reviewCancelModal.reservation.cancel_settlement?.policy_suggested_split
                    ?.forfeited_amount || 0
                )}
                ). Vui lòng kiểm tra kỹ lý do trước khi phê duyệt.
              </div>
            ) : null}

            <div className="flex gap-2">
              <Button
                size="xs"
                variant={reviewCancelModal.mode === 'approve' ? 'success' : 'outline'}
                onClick={() => setReviewCancelModal((p) => ({ ...p, mode: 'approve' }))}
              >
                Chế độ: Phê duyệt
              </Button>
              <Button
                size="xs"
                variant={reviewCancelModal.mode === 'reject' ? 'danger' : 'outline'}
                onClick={() => setReviewCancelModal((p) => ({ ...p, mode: 'reject' }))}
              >
                Chế độ: Từ chối đề xuất
              </Button>
            </div>

            {reviewCancelModal.mode === 'reject' ? (
              <Input
                label="Lý do từ chối đề xuất (bắt buộc)"
                required
                multiline
                rows={3}
                placeholder="VD: Mức hoàn chưa đúng chính sách giữ chỗ, đề nghị áp dụng phạt 100%..."
                value={reviewCancelModal.rejectReason}
                onChange={(e) =>
                  setReviewCancelModal((p) => ({ ...p, rejectReason: e.target.value }))
                }
              />
            ) : (
              <Input
                label="Ghi chú phê duyệt (tùy chọn)"
                multiline
                rows={2}
                placeholder="VD: Đồng ý hoàn theo đề xuất, mở lại phòng để chào khách mới..."
                value={reviewCancelModal.note}
                onChange={(e) => setReviewCancelModal((p) => ({ ...p, note: e.target.value }))}
              />
            )}

            <div className="flex justify-end gap-2 pt-2">
              <Button
                variant="outline"
                disabled={saving}
                onClick={() =>
                  setReviewCancelModal({
                    open: false,
                    reservation: null,
                    mode: 'approve',
                    note: '',
                    rejectReason: '',
                  })
                }
              >
                Đóng
              </Button>
              <Button
                type="submit"
                variant={reviewCancelModal.mode === 'reject' ? 'danger' : 'success'}
                loading={saving}
              >
                {reviewCancelModal.mode === 'reject'
                  ? 'Xác nhận từ chối đề xuất'
                  : Number(reviewCancelModal.reservation.refunded_amount || 0) === 0
                  ? 'Phê duyệt & Tịch thu 100%'
                  : 'Phê duyệt phương án & Mở phòng'}
              </Button>
            </div>
          </form>
        ) : null}
      </Modal>

      {/* Step 3: MANAGER Payout with UNC Modal */}
      <Modal
        open={payoutCancelModal.open}
        onClose={() => {
          if (!saving) setPayoutCancelModal((p) => ({ ...p, open: false }));
        }}
        title="Thực chi hoàn tiền giữ chỗ & Tải UNC (Bước 3 — BQL thực chi)"
        subtitle={
          payoutCancelModal.reservation
            ? `Khách: ${payoutCancelModal.reservation.prospect_name} • Đã duyệt hoàn: ${formatMoney(
                payoutCancelModal.reservation.refunded_amount
              )}`
            : ''
        }
        size="md"
      >
        {payoutCancelModal.reservation ? (
          <form onSubmit={handleSubmitPayoutCancel} className="space-y-4">
            <div className="p-3 rounded-xl bg-emerald-50 border border-emerald-200 text-xs text-emerald-900">
              Số tiền đã được phê duyệt hoàn trả:{' '}
              <strong>{formatMoney(payoutCancelModal.reservation.refunded_amount)}</strong> (Thu giữ phạt:{' '}
              <strong>{formatMoney(payoutCancelModal.reservation.forfeited_amount)}</strong>). Số tiền này đã khóa theo quyết định phê duyệt.
            </div>

            <Select
              label="Phương thức chi hoàn thực tế"
              value={payoutCancelModal.refund_method}
              onChange={(e) =>
                setPayoutCancelModal((p) => ({ ...p, refund_method: e.target.value }))
              }
              options={[
                { value: 'BANK_TRANSFER', label: 'Chuyển khoản ngân hàng (bắt buộc UNC)' },
                { value: 'CASH', label: 'Tiền mặt tại quầy' },
              ]}
            />

            {payoutCancelModal.refund_method === 'BANK_TRANSFER' ? (
              <div className="p-3.5 rounded-xl bg-slate-50 border border-slate-200 space-y-3">
                <BankSelect
                  label="Ngân hàng nhận hoàn (bắt buộc)"
                  required
                  value={payoutCancelModal.bank_name}
                  bankMeta={{
                    bank_code: payoutCancelModal.bank_code,
                    bank_bin: payoutCancelModal.bank_bin,
                    bank_logo: payoutCancelModal.bank_logo,
                  }}
                  onBankChange={(val, chosen) =>
                    setPayoutCancelModal((p) => ({
                      ...p,
                      bank_name: val || chosen?.shortName || chosen?.short_name || '',
                      bank_code: chosen?.code || '',
                      bank_bin: chosen?.bin || '',
                      bank_logo: chosen?.logo || '',
                    }))
                  }
                />
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <Input
                    label="Số tài khoản nhận hoàn"
                    required
                    value={payoutCancelModal.account_number}
                    onChange={(e) =>
                      setPayoutCancelModal((p) => ({ ...p, account_number: e.target.value }))
                    }
                  />
                  <Input
                    label="Chủ tài khoản (IN HOA)"
                    required
                    value={payoutCancelModal.account_holder}
                    onChange={(e) =>
                      setPayoutCancelModal((p) => ({
                        ...p,
                        account_holder: e.target.value.toUpperCase(),
                      }))
                    }
                  />
                </div>
              </div>
            ) : null}

            <FileUpload
              label={
                payoutCancelModal.refund_method === 'BANK_TRANSFER'
                  ? 'Ảnh chứng từ UNC chuyển khoản hoàn tiền (bắt buộc ≥ 1 ảnh — PRD 7.5)'
                  : 'Ảnh phiếu chi tiền mặt / biên nhận (tùy chọn)'
              }
              multiple
              maxFiles={3}
              value={payoutCancelModal.refund_evidence}
              onChange={(vals) =>
                setPayoutCancelModal((p) => ({ ...p, refund_evidence: vals }))
              }
            />

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Input
                label="Mã tham chiếu giao dịch / UNC"
                placeholder="VD: FT26308..."
                value={payoutCancelModal.reference_code}
                onChange={(e) =>
                  setPayoutCancelModal((p) => ({ ...p, reference_code: e.target.value }))
                }
              />
              <Input
                label="Ghi chú chi hoàn"
                placeholder="VD: Đã chuyển khoản hoàn giữ chỗ"
                value={payoutCancelModal.note}
                onChange={(e) =>
                  setPayoutCancelModal((p) => ({ ...p, note: e.target.value }))
                }
              />
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <Button
                variant="outline"
                disabled={saving}
                onClick={() => setPayoutCancelModal((p) => ({ ...p, open: false }))}
              >
                Hủy
              </Button>
              <Button type="submit" variant="primary" loading={saving}>
                Xác nhận đã chi hoàn &amp; Lưu UNC
              </Button>
            </div>
          </form>
        ) : null}
      </Modal>

      {/* Edit Reservation Refund Bank Info Modal */}
      <Modal
        open={editRsvBankModal.open}
        onClose={() => {
          if (!saving) setEditRsvBankModal((p) => ({ ...p, open: false }));
        }}
        title="Cập nhật tài khoản nhận hoàn giữ chỗ"
        subtitle={
          editRsvBankModal.reservation
            ? `Khách: ${editRsvBankModal.reservation.prospect_name} • Số tiền hoàn: ${formatMoney(
                editRsvBankModal.reservation.refunded_amount
              )}`
            : ''
        }
        size="sm"
      >
        {editRsvBankModal.reservation ? (
          <form onSubmit={handleSubmitEditRsvBank} className="space-y-3.5">
            <BankSelect
              label="Ngân hàng nhận hoàn"
              required
              value={editRsvBankModal.bank_name}
              bankMeta={{
                bank_code: editRsvBankModal.bank_code,
                bank_bin: editRsvBankModal.bank_bin,
                bank_logo: editRsvBankModal.bank_logo,
              }}
              onBankChange={(val, chosen) =>
                setEditRsvBankModal((p) => ({
                  ...p,
                  bank_name: val || chosen?.shortName || chosen?.short_name || '',
                  bank_code: chosen?.code || '',
                  bank_bin: chosen?.bin || '',
                  bank_logo: chosen?.logo || '',
                }))
              }
            />
            <Input
              label="Số tài khoản nhận hoàn"
              required
              value={editRsvBankModal.account_number}
              onChange={(e) =>
                setEditRsvBankModal((p) => ({ ...p, account_number: e.target.value }))
              }
            />
            <Input
              label="Chủ tài khoản (IN HOA)"
              required
              value={editRsvBankModal.account_holder}
              onChange={(e) =>
                setEditRsvBankModal((p) => ({
                  ...p,
                  account_holder: e.target.value.toUpperCase(),
                }))
              }
            />
            <div className="flex justify-end gap-2 pt-2">
              <Button
                variant="outline"
                disabled={saving}
                onClick={() => setEditRsvBankModal((p) => ({ ...p, open: false }))}
              >
                Hủy
              </Button>
              <Button type="submit" loading={saving}>
                Lưu tài khoản
              </Button>
            </div>
          </form>
        ) : null}
      </Modal>

      {/* Edit Apartment Modal */}
      <Modal open={editOpen} onClose={() => setEditOpen(false)} title={`Cập nhật căn hộ ${apt.code}`}>
        <form onSubmit={handleSave} className="space-y-4">
          <Select
            label="Phân khu (Khu / Block — FR-007)"
            placeholder="-- Không gán phân khu --"
            value={form.zone_id}
            onChange={(e) => setForm({ ...form, zone_id: e.target.value })}
            options={zones.map((z) => ({
              value: z.id,
              label: `${z.code}${z.name ? ` — ${z.name}` : ''}`,
            }))}
          />
          <div className="grid grid-cols-2 gap-3.5">
            <Select
              label="Loại căn hộ"
              value={form.type}
              onChange={(e) => setForm({ ...form, type: e.target.value })}
              options={
                form.type && !APARTMENT_TYPE_OPTIONS.includes(form.type)
                  ? [form.type, ...APARTMENT_TYPE_OPTIONS]
                  : APARTMENT_TYPE_OPTIONS
              }
            />
            <Input
              label="Số phòng ngủ"
              type="number"
              min="0"
              required
              value={form.bedrooms}
              onChange={(e) => setForm({ ...form, bedrooms: e.target.value })}
            />
          </div>
          <div className="grid grid-cols-2 gap-3.5">
            <Input
              label="Diện tích (m²)"
              type="number"
              step="0.5"
              required
              value={form.area_m2}
              onChange={(e) => setForm({ ...form, area_m2: e.target.value })}
            />
            <MoneyInput
              label="Giá thuê niêm yết (VND)"
              required
              placeholder="VD: 8.500.000"
              value={form.base_rent}
              onChange={(e) => setForm({ ...form, base_rent: e.target.value })}
            />
          </div>
          <Input
            label="Tiện nghi (ngăn cách bằng dấu phẩy)"
            placeholder="Điều hòa, Nóng lạnh, Tủ bếp, Máy giặt, Giường tủ"
            value={form.amenitiesText}
            onChange={(e) => setForm({ ...form, amenitiesText: e.target.value })}
          />
          <Input
            label="Ghi chú vận hành"
            multiline
            rows={2}
            value={form.note}
            onChange={(e) => setForm({ ...form, note: e.target.value })}
          />
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => setEditOpen(false)}>
              Hủy
            </Button>
            <Button type="submit" loading={saving}>
              Lưu thay đổi
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}

export default ApartmentDetailPage;
