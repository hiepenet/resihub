import React, { useState, useEffect, useMemo } from 'react';
import {
  Building2,
  Maximize2,
  BedDouble,
  CalendarClock,
  Wallet,
  Receipt,
  ShieldCheck,
  BellRing,
  Wrench,
  Sparkles,
  FileText,
  ArrowRight,
  CheckCircle2,
  Clock,
  MapPin,
  Send,
  Home,
  AlertCircle,
  XCircle,
} from 'lucide-react';
import { Card, CardHeader } from '../../../components/ui/Card';
import { Button } from '../../../components/ui/Button';
import { Badge } from '../../../components/ui/Badge';
import { Input } from '../../../components/ui/Input';
import { Select } from '../../../components/ui/Select';
import { Modal } from '../../../components/ui/Modal';
import { FileUpload, AuthImage } from '../../../components/ui/FileUpload';
import { StatusBadge } from '../../../components/common/StatusBadge';
import { EmptyState } from '../../../components/common/EmptyState';
import { residentService } from '../../../services/resident.service';
import { useNotificationStore } from '../../../stores/notificationStore';
import { useToast } from '../../../hooks/useToast';
import { formatMoney, formatDate, formatDateTime, toInputDate } from '../../../utils/format';
import { isValidIdNumber, extractErrorMessage } from '../../../utils/validation';

const AMENITY_LABELS = {
  wifi: 'Wi-Fi tốc độ cao',
  internet: 'Internet cáp quang',
  air_conditioner: 'Điều hòa nhiệt độ',
  ac: 'Điều hòa',
  water_heater: 'Bình nóng lạnh',
  elevator: 'Thang máy thẻ từ',
  fridge: 'Tủ lạnh',
  refrigerator: 'Tủ lạnh',
  washing_machine: 'Máy giặt',
  washer: 'Máy giặt',
  kitchen: 'Bếp & hút mùi',
  balcony: 'Ban công thoáng',
  parking: 'Bãi đỗ xe',
  security_24_7: 'An ninh 24/7',
  security: 'An ninh 24/7',
  tv: 'Smart TV',
  bed: 'Giường & nệm',
  wardrobe: 'Tủ quần áo',
  sofa: 'Sofa phòng khách',
  desk: 'Bàn làm việc',
  microwave: 'Lò vi sóng',
  pool: 'Hồ bơi nội khu',
  gym: 'Phòng Gym',
};

function parseAmenities(rawAmenities) {
  if (!rawAmenities) return [];
  let parsed = rawAmenities;
  if (typeof rawAmenities === 'string') {
    try {
      parsed = JSON.parse(rawAmenities);
    } catch {
      return rawAmenities
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    }
  }
  if (Array.isArray(parsed)) {
    return parsed
      .map((item) => {
        if (!item) return null;
        if (typeof item === 'string') return AMENITY_LABELS[item] || item;
        if (typeof item === 'object') return item.label || item.name || AMENITY_LABELS[item.code] || item.code || null;
        return null;
      })
      .filter(Boolean);
  }
  if (typeof parsed === 'object') {
    return Object.entries(parsed)
      .filter(([, val]) => Boolean(val))
      .map(([key, val]) => {
        if (typeof val === 'string' && val.trim() && val !== 'true') return val.trim();
        if (AMENITY_LABELS[key]) return AMENITY_LABELS[key];
        return key
          .replace(/_/g, ' ')
          .replace(/\b\w/g, (c) => c.toUpperCase());
      });
  }
  return [];
}

function getDaysRemaining(endDate) {
  if (!endDate) return null;
  const end = new Date(endDate);
  if (Number.isNaN(end.getTime())) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  end.setHours(0, 0, 0, 0);
  return Math.ceil((end.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
}

export function OverviewTab({ overview, openRequestsCount = 0, onRefreshOverview, onNavigateTab }) {
  const toast = useToast();
  const unreadCount = useNotificationStore((s) => s.unreadCount);

  const contract = overview?.active_contract || overview?.contract || null;
  const user = overview?.user || {};
  const currentAmountDue = Number(overview?.current_amount_due || 0);
  const latestInvoice = overview?.latest_invoice || null;
  const reservations = useMemo(() => {
    if (Array.isArray(overview?.reservations) && overview.reservations.length > 0) {
      return overview.reservations;
    }
    return overview?.reservation ? [overview.reservation] : [];
  }, [overview?.reservations, overview?.reservation]);
  const reservation = reservations[0] || null;
  const reservationHistory = useMemo(
    () =>
      Array.isArray(overview?.reservation_history)
        ? overview.reservation_history.filter(
            (h) => !['HELD', 'PENDING_CONFIRM', 'CONVERTED'].includes(h.reservation_status)
          )
        : [],
    [overview?.reservation_history]
  );
  const onboardingApplication = overview?.onboarding_application || overview?.pending_application || null;
  const idImages = useMemo(
    () => (Array.isArray(overview?.id_images) ? overview.id_images : []),
    [overview?.id_images]
  );
  const existingFrontImg = useMemo(
    () => [...idImages].reverse().find((img) => img.side === 'front') || null,
    [idImages]
  );
  const existingBackImg = useMemo(
    () => [...idImages].reverse().find((img) => img.side === 'back') || null,
    [idImages]
  );
  const availableApartments = useMemo(
    () => (Array.isArray(overview?.available_apartments) ? overview.available_apartments : []),
    [overview?.available_apartments]
  );

  const apartmentSelectOptions = useMemo(() => {
    const map = new Map();
    reservations.forEach((r) => {
      if (r.apartment_id) {
        map.set(r.apartment_id, {
          value: r.apartment_id,
          label: `Căn ${r.apartment_code} — ${r.building_name} (${r.area_m2 || 0}m² • ${formatMoney(r.base_rent)}/tháng) [Đang giữ chỗ]`,
        });
      }
    });
    availableApartments.forEach((a) => {
      if (!map.has(a.id)) {
        const isRsv = a.status === 'RESERVED';
        map.set(a.id, {
          value: a.id,
          label: `Căn ${a.code} — ${a.building_name} (${a.area_m2 || 0}m² • ${formatMoney(a.base_rent)}/tháng)${isRsv ? ' [Đang giữ chỗ]' : ''}`,
        });
      }
    });
    return Array.from(map.values());
  }, [reservations, availableApartments]);

  const [applyModalOpen, setApplyModalOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [formErrors, setFormErrors] = useState({});
  const [idCardFiles, setIdCardFiles] = useState({ front: '', back: '' });
  const [appForm, setAppForm] = useState(() => ({
    full_name: user?.full_name || reservation?.prospect_name || '',
    id_number: user?.id_number || '',
    dob: toInputDate(user?.dob) || '',
    desired_apartment_id:
      onboardingApplication?.desired_apartment_id ||
      reservation?.apartment_id ||
      availableApartments[0]?.id ||
      '',
    note: onboardingApplication?.application_note || '',
    privacy_consent: Boolean(user?.privacy_consent_at),
  }));

  useEffect(() => {
    setAppForm((prev) => ({
      ...prev,
      full_name: prev.full_name || user?.full_name || reservation?.prospect_name || '',
      id_number: prev.id_number || user?.id_number || '',
      dob: prev.dob || toInputDate(user?.dob) || '',
      desired_apartment_id:
        prev.desired_apartment_id ||
        onboardingApplication?.desired_apartment_id ||
        reservation?.apartment_id ||
        availableApartments[0]?.id ||
        '',
      privacy_consent: prev.privacy_consent || Boolean(user?.privacy_consent_at),
    }));
  }, [
    user?.full_name,
    user?.id_number,
    user?.dob,
    user?.privacy_consent_at,
    onboardingApplication?.desired_apartment_id,
    reservation?.prospect_name,
    reservation?.apartment_id,
    availableApartments,
  ]);

  const contractAmenities = useMemo(
    () => parseAmenities(contract?.amenities),
    [contract?.amenities]
  );

  const daysRemaining = useMemo(
    () => getDaysRemaining(contract?.end_date),
    [contract?.end_date]
  );

  const openApplyModal = (aptId = '') => {
    setFormErrors({});
    setIdCardFiles({ front: '', back: '' });
    setAppForm({
      full_name: user?.full_name || reservation?.prospect_name || '',
      id_number: user?.id_number || '',
      dob: toInputDate(user?.dob) || '',
      desired_apartment_id:
        aptId ||
        onboardingApplication?.desired_apartment_id ||
        reservation?.apartment_id ||
        availableApartments[0]?.id ||
        '',
      note: onboardingApplication?.application_note || '',
      privacy_consent: Boolean(user?.privacy_consent_at),
    });
    setApplyModalOpen(true);
  };

  const handleSubmitApplication = async (e) => {
    e?.preventDefault?.();
    const errs = {};
    if (!appForm.full_name?.trim()) {
      errs.full_name = 'Vui lòng nhập họ và tên đầy đủ.';
    }
    if (appForm.id_number?.trim() && !isValidIdNumber(appForm.id_number)) {
      errs.id_number = 'Số CCCD / Hộ chiếu không hợp lệ (9 hoặc 12 chữ số).';
    }
    if (!appForm.privacy_consent) {
      errs.privacy_consent = 'Vui lòng đồng ý với Chính sách bảo vệ dữ liệu cá nhân trước khi gửi hồ sơ.';
    }
    if (Object.keys(errs).length > 0) {
      setFormErrors(errs);
      if (errs.privacy_consent) {
        toast.warning(errs.privacy_consent);
      }
      return;
    }

    setSubmitting(true);
    try {
      if (idCardFiles.front) {
        await residentService.uploadIdImage({ side: 'front', image_base64: idCardFiles.front });
      }
      if (idCardFiles.back) {
        await residentService.uploadIdImage({ side: 'back', image_base64: idCardFiles.back });
      }
      const res = await residentService.submitRentalApplication({
        full_name: appForm.full_name.trim(),
        id_number: appForm.id_number?.trim() || undefined,
        dob: appForm.dob || undefined,
        desired_apartment_id: appForm.desired_apartment_id || reservation?.apartment_id || undefined,
        note: appForm.note?.trim() || undefined,
        privacy_consent: true,
      });
      toast.success(res?.message || 'Đã gửi hồ sơ đăng ký nhận nhà thành công!');
      setIdCardFiles({ front: '', back: '' });
      setApplyModalOpen(false);
      await onRefreshOverview?.();
    } catch (err) {
      toast.error(extractErrorMessage(err, 'Không thể gửi hồ sơ đăng ký.'));
    } finally {
      setSubmitting(false);
    }
  };

  const renderApplicationFormFields = () => (
    <div className="space-y-4">
      <Select
        label="Căn hộ đăng ký nhận nhà / thuê"
        placeholder="-- Chọn căn hộ (hoặc để BQL tư vấn) --"
        value={appForm.desired_apartment_id}
        onChange={(e) => setAppForm((s) => ({ ...s, desired_apartment_id: e.target.value }))}
        options={apartmentSelectOptions}
      />

      <Input
        label="Họ và tên người đăng ký"
        required
        placeholder="Nhập họ và tên theo CCCD"
        value={appForm.full_name}
        error={formErrors.full_name}
        onChange={(e) => {
          setAppForm((s) => ({ ...s, full_name: e.target.value }));
          if (formErrors.full_name) setFormErrors((err) => ({ ...err, full_name: '' }));
        }}
      />

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Input
          type="date"
          label="Ngày sinh"
          value={appForm.dob}
          onChange={(e) => setAppForm((s) => ({ ...s, dob: e.target.value }))}
        />
        <Input
          label="Số CCCD / Hộ chiếu"
          placeholder="001099112233"
          value={appForm.id_number}
          error={formErrors.id_number}
          onChange={(e) => {
            setAppForm((s) => ({ ...s, id_number: e.target.value }));
            if (formErrors.id_number) setFormErrors((err) => ({ ...err, id_number: '' }));
          }}
        />
      </div>

      <div className="space-y-3 pt-1 border-t border-slate-100">
        <div>
          <p className="text-xs font-semibold text-slate-800">
            Ảnh chụp CCCD 2 mặt (Khuyến khích tải đủ mặt trước & mặt sau để duyệt nhanh)
          </p>
          <p className="text-[11px] text-slate-500 mt-0.5">
            Ảnh giấy tờ được bảo mật nghiêm ngặt, chỉ Ban Quản Lý tòa nhà được phân quyền mới có thể đối chiếu.
          </p>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <span className="text-xs font-medium text-slate-700">Ảnh CCCD mặt trước</span>
            {existingFrontImg && !idCardFiles.front ? (
              <div className="w-full h-24 rounded-lg border border-slate-200 overflow-hidden bg-slate-50">
                <AuthImage
                  src={`/api/v1/attachments/${existingFrontImg.attachment_id}/view`}
                  alt="CCCD mặt trước đã tải"
                  className="w-full h-full object-cover"
                />
              </div>
            ) : null}
            <FileUpload
              value={idCardFiles.front}
              onChange={(b64) => setIdCardFiles((prev) => ({ ...prev, front: b64 || '' }))}
              hint={existingFrontImg ? 'Tải ảnh mới để thay mặt trước' : 'Chọn ảnh mặt trước (≤ 5MB)'}
            />
          </div>
          <div className="space-y-1.5">
            <span className="text-xs font-medium text-slate-700">Ảnh CCCD mặt sau</span>
            {existingBackImg && !idCardFiles.back ? (
              <div className="w-full h-24 rounded-lg border border-slate-200 overflow-hidden bg-slate-50">
                <AuthImage
                  src={`/api/v1/attachments/${existingBackImg.attachment_id}/view`}
                  alt="CCCD mặt sau đã tải"
                  className="w-full h-full object-cover"
                />
              </div>
            ) : null}
            <FileUpload
              value={idCardFiles.back}
              onChange={(b64) => setIdCardFiles((prev) => ({ ...prev, back: b64 || '' }))}
              hint={existingBackImg ? 'Tải ảnh mới để thay mặt sau' : 'Chọn ảnh mặt sau (≤ 5MB)'}
            />
          </div>
        </div>
      </div>

      <Input
        multiline
        rows={2}
        label="Ghi chú / Nhu cầu nhận phòng"
        placeholder="Ví dụ: Ngày dự kiến nhận nhà, số người ở cùng, nhu cầu gửi xe..."
        value={appForm.note}
        onChange={(e) => setAppForm((s) => ({ ...s, note: e.target.value }))}
      />

      <div
        className={`p-3 rounded-xl border space-y-1 ${
          formErrors.privacy_consent
            ? 'bg-rose-50/60 border-rose-300'
            : 'bg-slate-50 border-slate-200/80'
        }`}
      >
        <label className="flex items-start gap-2.5 cursor-pointer text-xs text-slate-700 leading-relaxed">
          <input
            type="checkbox"
            checked={Boolean(appForm.privacy_consent)}
            onChange={(e) => {
              const checked = e.target.checked;
              setAppForm((s) => ({ ...s, privacy_consent: checked }));
              if (checked && formErrors.privacy_consent) {
                setFormErrors((err) => ({ ...err, privacy_consent: '' }));
              }
            }}
            className="mt-0.5 h-4 w-4 rounded border-slate-300 text-primary-600 focus:ring-primary-500"
          />
          <span>
            Tôi xác nhận thông tin khai báo là chính xác và{' '}
            <strong className="text-slate-900">Đồng ý chính sách bảo vệ dữ liệu cá nhân</strong> của ResiHub để phục vụ xác minh hồ sơ, lập hợp đồng thuê và quản lý cư trú.
          </span>
        </label>
        {formErrors.privacy_consent ? (
          <p className="text-xs font-medium text-rose-600 pl-6">{formErrors.privacy_consent}</p>
        ) : null}
      </div>
    </div>
  );

  const renderApplicationModal = () => (
    <Modal
      open={applyModalOpen}
      onClose={() => setApplyModalOpen(false)}
      title={reservation ? 'Đăng ký thông tin nhận nhà' : 'Đăng ký thuê căn hộ trực tuyến'}
      subtitle="Điền thông tin cá nhân và ảnh CCCD 2 mặt để Ban Quản Lý duyệt hồ sơ và liên hệ bàn giao phòng"
      size="md"
      footer={
        <>
          <Button variant="outline" onClick={() => setApplyModalOpen(false)} disabled={submitting}>
            Hủy
          </Button>
          <Button icon={Send} onClick={handleSubmitApplication} loading={submitting}>
            Gửi hồ sơ đăng ký
          </Button>
        </>
      }
    >
      <form onSubmit={handleSubmitApplication}>{renderApplicationFormFields()}</form>
    </Modal>
  );

  const renderOnboardingStatusCard = () => {
    if (!onboardingApplication) return null;
    const desiredLabel = onboardingApplication.desired_apartment_code
      ? `căn hộ ${onboardingApplication.desired_apartment_code}${onboardingApplication.desired_building_name ? ` (${onboardingApplication.desired_building_name})` : ''}`
      : '';

    if (onboardingApplication.status === 'REJECTED') {
      return (
        <Card className="border-rose-200 bg-rose-50/40">
          <div className="flex items-start gap-3.5">
            <div className="w-10 h-10 rounded-xl bg-rose-100 text-rose-700 flex items-center justify-center shrink-0">
              <XCircle className="w-5 h-5" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <h3 className="text-sm font-semibold text-slate-900">
                  Hồ sơ đăng ký thuê {desiredLabel ? `cho ${desiredLabel} ` : ''}cần bổ sung thông tin
                </h3>
                <Badge variant="red" dot>
                  Cần chỉnh sửa
                </Badge>
              </div>
              <p className="text-xs text-rose-800 mt-1.5 font-medium bg-white/80 border border-rose-200 rounded-lg px-3 py-2 whitespace-pre-line break-words">
                Lý do từ Ban Quản Lý:{' '}
                {onboardingApplication.rejection_reason ||
                  'Vui lòng kiểm tra và cập nhật lại thông tin giấy tờ tùy thân.'}
              </p>
              {onboardingApplication.application_note ? (
                <p className="text-xs text-slate-600 mt-1.5 whitespace-pre-line break-words">
                  Ghi chú của bạn: {onboardingApplication.application_note}
                </p>
              ) : null}
              <div className="mt-3">
                <Button
                  size="xs"
                  variant="primary"
                  onClick={() => openApplyModal(onboardingApplication.desired_apartment_id || '')}
                >
                  Chỉnh sửa & Gửi lại hồ sơ
                </Button>
              </div>
            </div>
          </div>
        </Card>
      );
    }

    if (onboardingApplication.status === 'APPROVED') {
      return (
        <Card className="border-emerald-200 bg-emerald-50/30">
          <div className="flex items-start gap-3.5">
            <div className="w-10 h-10 rounded-xl bg-emerald-100 text-emerald-700 flex items-center justify-center shrink-0">
              <CheckCircle2 className="w-5 h-5" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <h3 className="text-sm font-semibold text-slate-900">
                  Hồ sơ cư dân đã được phê duyệt
                </h3>
                <Badge variant="emerald" dot>
                  Đã duyệt — Chờ lập HĐ
                </Badge>
              </div>
              <p className="text-xs text-slate-600 mt-1 leading-relaxed">
                Ban Quản Lý đã xác thực thông tin định danh của bạn
                {desiredLabel ? ` cho ${desiredLabel}` : ''} và sẽ liên hệ để ký kết hợp đồng thuê.
              </p>
              {onboardingApplication.application_note ? (
                <p className="text-xs text-slate-600 mt-1.5 whitespace-pre-line break-words">
                  Ghi chú hồ sơ: {onboardingApplication.application_note}
                </p>
              ) : null}
            </div>
          </div>
        </Card>
      );
    }

    if (onboardingApplication.status === 'PENDING') {
      return (
        <Card className="border-amber-200 bg-amber-50/40">
          <div className="flex items-start gap-3.5">
            <div className="w-10 h-10 rounded-xl bg-amber-100 text-amber-700 flex items-center justify-center shrink-0">
              <Clock className="w-5 h-5" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <h3 className="text-sm font-semibold text-slate-900">
                  Hồ sơ đang chờ Ban Quản Lý phê duyệt
                </h3>
                <Badge variant="amber" dot>
                  Chờ phê duyệt
                </Badge>
              </div>
              <p className="text-xs text-slate-600 mt-1 leading-relaxed">
                Hồ sơ tự khai của bạn
                {desiredLabel ? ` cho ${desiredLabel}` : ''}{' '}
                gửi lúc {formatDateTime(onboardingApplication.updated_at || onboardingApplication.created_at)} đã được ghi nhận. Ban Quản Lý sẽ đối chiếu giấy tờ và hoàn tất hợp đồng thuê.
              </p>
              {onboardingApplication.application_note ? (
                <p className="text-xs text-slate-600 mt-1.5 whitespace-pre-line break-words">
                  Ghi chú của bạn: {onboardingApplication.application_note}
                </p>
              ) : null}
              <div className="mt-3">
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() => openApplyModal(onboardingApplication.desired_apartment_id || '')}
                >
                  Cập nhật bổ sung thông tin hồ sơ
                </Button>
              </div>
            </div>
          </div>
        </Card>
      );
    }

    return null;
  };

  const renderReservationsSection = ({ showActionButton = true } = {}) => {
    if (reservations.length === 0) return null;

    return (
      <div className="space-y-3">
        {reservations.map((r) => {
          const rAmenities = parseAmenities(r.amenities);
          const rStatus = r.reservation_status || 'HELD';
          const isPendingConfirm = rStatus === 'PENDING_CONFIRM';
          return (
            <Card
              key={r.reservation_id || r.apartment_id}
              className={
                isPendingConfirm
                  ? 'border-amber-200 bg-gradient-to-br from-amber-50/70 via-white to-orange-50/40 shadow-sm'
                  : 'border-sky-200 bg-gradient-to-br from-sky-50/70 via-white to-indigo-50/40 shadow-sm'
              }
            >
              <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4">
                <div className="flex items-start gap-3.5 min-w-0">
                  <div
                    className={`w-11 h-11 rounded-2xl flex items-center justify-center shrink-0 ${
                      isPendingConfirm ? 'bg-amber-100 text-amber-700' : 'bg-sky-100 text-sky-700'
                    }`}
                  >
                    {isPendingConfirm ? <Clock className="w-5 h-5" /> : <ShieldCheck className="w-5 h-5" />}
                  </div>
                  <div className="space-y-1.5 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span
                        className={`text-xs font-semibold uppercase tracking-wide ${
                          isPendingConfirm ? 'text-amber-700' : 'text-sky-700'
                        }`}
                      >
                        {isPendingConfirm
                          ? 'Phiếu đăng ký giữ chỗ đang chờ đối soát'
                          : 'Thông tin căn hộ đang giữ chỗ'}
                      </span>
                      <StatusBadge status={rStatus} domain="reservation" />
                    </div>
                    <h3 className="text-lg font-bold text-slate-900">
                      Căn hộ {r.apartment_code}
                      {r.floor_name ? ` • ${r.floor_name}` : ''}
                    </h3>
                    <p className="text-xs text-slate-600 flex items-start gap-1.5">
                      <Building2 className="w-3.5 h-3.5 text-slate-400 shrink-0 mt-0.5" />
                      <span className="break-words">
                        <strong className="text-slate-800">{r.building_name}</strong>
                        {r.building_address ? ` — ${r.building_address}` : ''}
                      </span>
                    </p>
                  </div>
                </div>

                {showActionButton && !isPendingConfirm ? (
                  <Button
                    size="sm"
                    icon={Send}
                    onClick={() => openApplyModal(r.apartment_id)}
                    className="shrink-0"
                  >
                    Đăng ký thông tin nhận nhà
                  </Button>
                ) : null}
              </div>

              {isPendingConfirm ? (
                <div className="mt-3 p-3 rounded-xl bg-amber-50/90 border border-amber-200/80 text-xs text-amber-900 leading-relaxed">
                  Ban Quản Lý đang đối soát chứng từ chuyển khoản của bạn (SLA 4 giờ làm việc). Căn hộ sẽ chính thức khóa giữ chỗ sau khi BQL xác nhận đã nhận tiền.
                </div>
              ) : null}

              <div className="mt-4 pt-3.5 border-t border-sky-100 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 text-xs">
                <div className="p-2.5 rounded-xl bg-white/90 border border-slate-200/70">
                  <p className="text-[11px] text-slate-500">Thiết kế & Diện tích</p>
                  <p className="font-semibold text-slate-900 mt-0.5 break-words">
                    {r.apartment_type || (r.bedrooms ? `${r.bedrooms} PN` : 'Tiêu chuẩn')}
                    {r.area_m2 ? ` • ${r.area_m2} m²` : ''}
                  </p>
                </div>
                <div className="p-2.5 rounded-xl bg-white/90 border border-slate-200/70">
                  <p className="text-[11px] text-slate-500">Giá thuê niêm yết</p>
                  <p className="font-semibold text-slate-900 mt-0.5 break-words">
                    {r.base_rent ? `${formatMoney(r.base_rent)}/tháng` : '—'}
                  </p>
                </div>
                <div className="p-2.5 rounded-xl bg-white/90 border border-slate-200/70">
                  <p className="text-[11px] text-slate-500">Tiền cọc giữ chỗ</p>
                  <p className="font-bold text-primary-700 mt-0.5 break-words">{formatMoney(r.hold_amount)}</p>
                </div>
                <div className="p-2.5 rounded-xl bg-white/90 border border-slate-200/70">
                  <p className="text-[11px] text-slate-500">Thời hạn giữ chỗ</p>
                  <p className="font-semibold text-slate-900 mt-0.5 break-words">
                    {r.hold_from ? `${formatDate(r.hold_from)} → ` : ''}
                    {formatDate(r.hold_until)}
                  </p>
                </div>
              </div>

              {rAmenities.length > 0 ? (
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {rAmenities.map((am, idx) => (
                    <span
                      key={idx}
                      className="text-[11px] px-2 py-0.5 rounded-md bg-white border border-sky-200/70 text-slate-700"
                    >
                      {am}
                    </span>
                  ))}
                </div>
              ) : null}

              {r.reservation_note ? (
                <p className="mt-2.5 text-xs text-slate-600 italic whitespace-pre-line break-words">
                  Ghi chú phiếu giữ chỗ: {r.reservation_note}
                </p>
              ) : null}
            </Card>
          );
        })}
      </div>
    );
  };

  if (contract) {
    const openTotal = unreadCount + openRequestsCount;
    const totalAmountDueAll = Number(overview?.total_amount_due_all ?? currentAmountDue);
    const hasMultiContracts = (overview?.active_contracts?.length || 0) > 1;

    return (
      <div className="space-y-6">
        {/* Luxury Apartment Hero Card (Sky Blue -> Indigo) */}
        <div className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-sky-500 via-primary-600 to-indigo-700 text-white p-6 sm:p-7 shadow-elevated">
          <div className="absolute -right-12 -top-12 w-56 h-56 rounded-full bg-white/10 blur-2xl pointer-events-none" />
          <div className="absolute -left-10 -bottom-16 w-48 h-48 rounded-full bg-indigo-400/20 blur-2xl pointer-events-none" />

          <div className="relative z-10 flex flex-col lg:flex-row lg:items-start lg:justify-between gap-6">
            <div className="space-y-3 max-w-2xl">
              <div className="flex flex-wrap items-center gap-2">
                <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-white/20 backdrop-blur-sm border border-white/25">
                  <Home className="w-3.5 h-3.5" />
                  {contract.is_future_contract
                    ? `Hợp đồng sắp hiệu lực (${formatDate(contract.start_date)})`
                    : contract.contract_status === 'TERMINATION_PENDING'
                      ? 'Căn hộ đang chờ bàn giao / thanh lý'
                      : 'Căn hộ đang cư trú'}
                </span>
                <StatusBadge
                  status={contract.contract_status}
                  domain="contract"
                  className="!bg-white/95 !border-white/50 shadow-sm"
                />
                {contract.contract_status === 'TERMINATION_PENDING' && contract.terminated_at ? (
                  <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-amber-400/95 text-slate-900">
                    <Clock className="w-3.5 h-3.5" />
                    Dự kiến trả phòng: {formatDate(contract.terminated_at)}
                  </span>
                ) : daysRemaining !== null && daysRemaining <= 30 && daysRemaining >= 0 ? (
                  <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-amber-400/95 text-slate-900">
                    <AlertCircle className="w-3.5 h-3.5" />
                    Còn {daysRemaining} ngày hết hạn HĐ
                  </span>
                ) : null}
              </div>

              <div>
                <p className="text-sky-100 text-sm">
                  Xin chào, <span className="font-semibold text-white">{user?.full_name || 'Cư dân'}</span>
                </p>
                <h1 className="text-2xl sm:text-3xl font-bold tracking-tight mt-0.5">
                  Căn hộ {contract.apartment_code}
                  {contract.floor_name ? ` • ${contract.floor_name}` : ''}
                </h1>
                <p className="text-sm text-sky-100 flex items-start gap-1.5 mt-1">
                  <Building2 className="w-4 h-4 shrink-0 text-sky-200 mt-0.5" />
                  <span className="break-words">
                    {contract.building_name}
                    {contract.building_address ? ` — ${contract.building_address}` : ''}
                  </span>
                </p>
              </div>

              {/* Amenities from DB */}
              <div className="pt-2">
                <p className="text-[11px] font-semibold uppercase tracking-wider text-sky-200 mb-2">
                  Tiện nghi bàn giao căn hộ
                </p>
                {contractAmenities.length > 0 ? (
                  <div className="flex flex-wrap gap-1.5">
                    {contractAmenities.map((am, idx) => (
                      <span
                        key={idx}
                        className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium bg-white/15 hover:bg-white/20 border border-white/20 backdrop-blur-sm transition-colors"
                      >
                        <CheckCircle2 className="w-3.5 h-3.5 text-emerald-300 shrink-0" />
                        {am}
                      </span>
                    ))}
                  </div>
                ) : (
                  <p className="text-xs text-sky-100/80 italic">
                    Danh mục tiện nghi theo biên bản bàn giao căn hộ.
                  </p>
                )}
              </div>
            </div>

            {/* Right Specs Grid */}
            <div className="grid grid-cols-1 sm:grid-cols-3 lg:grid-cols-1 gap-2.5 sm:gap-3 lg:min-w-[230px] bg-white/10 backdrop-blur-md rounded-xl p-3.5 sm:p-4 border border-white/15">
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-lg bg-white/15 flex items-center justify-center shrink-0">
                  <Maximize2 className="w-4 h-4 text-sky-100" />
                </div>
                <div className="min-w-0">
                  <p className="text-[11px] text-sky-200">Diện tích</p>
                  <p className="text-sm font-bold break-words">
                    {contract.area_m2 ? `${contract.area_m2} m²` : '—'}
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-lg bg-white/15 flex items-center justify-center shrink-0">
                  <BedDouble className="w-4 h-4 text-sky-100" />
                </div>
                <div className="min-w-0">
                  <p className="text-[11px] text-sky-200">Loại phòng</p>
                  <p className="text-sm font-bold break-words">
                    {contract.apartment_type ||
                      (contract.bedrooms ? `${contract.bedrooms} Phòng ngủ` : 'Tiêu chuẩn')}
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-lg bg-white/15 flex items-center justify-center shrink-0">
                  <CalendarClock className="w-4 h-4 text-sky-100" />
                </div>
                <div className="min-w-0">
                  <p className="text-[11px] text-sky-200">Thời hạn HĐ</p>
                  <p className="text-sm font-bold break-words">
                    {contract.start_date ? `${formatDate(contract.start_date)} → ` : ''}
                    {formatDate(contract.end_date)}
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Active Reservation(s) & Onboarding Status alongside existing Contract */}
        {reservations.length > 0 || onboardingApplication ? (
          <div className="space-y-4">
            {renderReservationsSection({ showActionButton: !onboardingApplication })}
            {renderOnboardingStatusCard()}
          </div>
        ) : null}

        {/* 4 KPI Cards Row */}
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
          {/* KPI 1: Current Amount Due (AC-002.1) */}
          <Card
            padding="none"
            className={`p-4 sm:p-5 flex flex-col justify-between transition-all ${
              currentAmountDue > 0
                ? 'border-amber-300 bg-gradient-to-br from-white to-amber-50/40'
                : 'border-emerald-200/80'
            }`}
          >
            <div>
              <div className="flex items-start justify-between gap-2.5">
                <p className="text-xs font-medium text-slate-500 uppercase tracking-wide leading-snug">
                  Cần thanh toán hiện tại
                </p>
                <div
                  className={`w-9 h-9 rounded-xl border flex items-center justify-center shrink-0 ${
                    currentAmountDue > 0
                      ? 'bg-rose-50 text-rose-600 border-rose-100'
                      : 'bg-emerald-50 text-emerald-600 border-emerald-100'
                  }`}
                >
                  <Receipt className="w-4.5 h-4.5" />
                </div>
              </div>
              <p
                title={formatMoney(currentAmountDue)}
                className={`text-xl 2xl:text-2xl font-bold mt-2 break-words leading-tight tabular-nums ${
                  currentAmountDue > 0 ? 'text-rose-600' : 'text-emerald-600'
                }`}
              >
                {formatMoney(currentAmountDue)}
              </p>
              {hasMultiContracts && totalAmountDueAll !== currentAmountDue ? (
                <p className="text-[11px] font-medium text-slate-600 mt-1 break-words">
                  Tổng tất cả căn hộ: <span className="font-semibold text-rose-600">{formatMoney(totalAmountDueAll)}</span>
                </p>
              ) : null}
            </div>

            <div className="mt-3 pt-3 border-t border-slate-100 flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
              <span className="text-xs text-slate-500 leading-snug break-words">
                {currentAmountDue > 0 && latestInvoice
                  ? `Kỳ ${latestInvoice.period} • Hạn ${formatDate(latestInvoice.due_date)}`
                  : 'Không có dư nợ quá hạn'}
              </span>
              <button
                type="button"
                onClick={() => onNavigateTab?.('invoices')}
                className="inline-flex items-center gap-1 text-xs font-semibold text-primary-600 hover:text-primary-700 shrink-0"
              >
                Hóa đơn
                <ArrowRight className="w-3.5 h-3.5" />
              </button>
            </div>
          </Card>

          {/* KPI 2: Monthly Rent */}
          <Card padding="none" className="p-4 sm:p-5 flex flex-col justify-between">
            <div>
              <div className="flex items-start justify-between gap-2.5">
                <p className="text-xs font-medium text-slate-500 uppercase tracking-wide leading-snug">
                  Tiền thuê hàng tháng
                </p>
                <div className="w-9 h-9 rounded-xl border bg-sky-50 text-sky-600 border-sky-100 flex items-center justify-center shrink-0">
                  <Wallet className="w-4.5 h-4.5" />
                </div>
              </div>
              <p
                title={formatMoney(contract.rent_amount)}
                className="text-xl 2xl:text-2xl font-bold text-slate-900 mt-2 break-words leading-tight tabular-nums"
              >
                {formatMoney(contract.rent_amount)}
              </p>
            </div>

            <div className="mt-3 pt-3 border-t border-slate-100 flex flex-wrap items-center justify-between gap-x-2 gap-y-1 text-xs text-slate-500">
              <span className="leading-snug">Chốt kỳ ngày {contract.billing_day || 1} hàng tháng</span>
              <span className="font-medium text-slate-700 shrink-0">
                Hạn +{contract.payment_due_days || 5} ngày
              </span>
            </div>
          </Card>

          {/* KPI 3: Held Deposit */}
          <Card padding="none" className="p-4 sm:p-5 flex flex-col justify-between">
            <div>
              <div className="flex items-start justify-between gap-2.5">
                <p className="text-xs font-medium text-slate-500 uppercase tracking-wide leading-snug">
                  Tiền cọc đang giữ
                </p>
                <div className="w-9 h-9 rounded-xl border bg-indigo-50 text-indigo-600 border-indigo-100 flex items-center justify-center shrink-0">
                  <ShieldCheck className="w-4.5 h-4.5" />
                </div>
              </div>
              <p
                title={formatMoney(contract.deposit_held_amount ?? contract.deposit_amount ?? 0)}
                className="text-xl 2xl:text-2xl font-bold text-slate-900 mt-2 break-words leading-tight tabular-nums"
              >
                {formatMoney(contract.deposit_held_amount ?? contract.deposit_amount ?? 0)}
              </p>
            </div>

            <div className="mt-3 pt-3 border-t border-slate-100 flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
              <span className="text-xs text-slate-500 leading-snug break-words">
                {contract.deposit_status === 'HELD' ? 'Đang bảo lưu theo HĐ' : 'Sổ cọc hợp đồng'}
              </span>
              <button
                type="button"
                onClick={() => onNavigateTab?.('contract')}
                className="inline-flex items-center gap-1 text-xs font-semibold text-indigo-600 hover:text-indigo-700 shrink-0"
              >
                Sổ cọc
                <ArrowRight className="w-3.5 h-3.5" />
              </button>
            </div>
          </Card>

          {/* KPI 4: Open Notifications & Requests */}
          <Card padding="none" className="p-4 sm:p-5 flex flex-col justify-between">
            <div>
              <div className="flex items-start justify-between gap-2.5">
                <p className="text-xs font-medium text-slate-500 uppercase tracking-wide leading-snug">
                  Thông báo & Yêu cầu mở
                </p>
                <div className="w-9 h-9 rounded-xl border bg-purple-50 text-purple-600 border-purple-100 flex items-center justify-center shrink-0">
                  <BellRing className="w-4.5 h-4.5" />
                </div>
              </div>
              <p className="text-xl 2xl:text-2xl font-bold text-slate-900 mt-2 break-words leading-tight tabular-nums">
                {openTotal}
              </p>
            </div>

            <div className="mt-3 pt-3 border-t border-slate-100 flex flex-wrap items-center justify-between gap-x-2 gap-y-1 text-xs">
              <button
                type="button"
                onClick={() => onNavigateTab?.('notifications')}
                className="text-slate-600 hover:text-primary-600 font-medium text-left"
              >
                {unreadCount} chưa đọc
              </button>
              <button
                type="button"
                onClick={() => onNavigateTab?.('maintenance')}
                className="text-slate-600 hover:text-primary-600 font-medium text-left"
              >
                {openRequestsCount} báo hỏng mở
              </button>
            </div>
          </Card>
        </div>

        {/* Quick Actions */}
        <Card>
          <CardHeader
            title="Thao tác nhanh"
            subtitle="Các tiện ích thường dùng dành cho cư dân căn hộ"
          />
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <button
              type="button"
              onClick={() => onNavigateTab?.('invoices', { action: 'pay' })}
              className="group flex flex-col items-start p-4 rounded-xl border border-slate-200/80 hover:border-primary-300 hover:bg-primary-50/40 transition-all text-left"
            >
              <div className="w-10 h-10 rounded-xl bg-sky-100 text-sky-600 flex items-center justify-center mb-3 group-hover:scale-105 transition-transform">
                <Receipt className="w-5 h-5" />
              </div>
              <p className="text-sm font-semibold text-slate-900">Báo đã thanh toán</p>
              <p className="text-xs text-slate-500 mt-0.5">
                Gửi ủy nhiệm chi / biên lai chuyển khoản
              </p>
            </button>

            <button
              type="button"
              onClick={() => onNavigateTab?.('maintenance', { action: 'new' })}
              className="group flex flex-col items-start p-4 rounded-xl border border-slate-200/80 hover:border-amber-300 hover:bg-amber-50/40 transition-all text-left"
            >
              <div className="w-10 h-10 rounded-xl bg-amber-100 text-amber-600 flex items-center justify-center mb-3 group-hover:scale-105 transition-transform">
                <Wrench className="w-5 h-5" />
              </div>
              <p className="text-sm font-semibold text-slate-900">Gửi yêu cầu sửa chữa</p>
              <p className="text-xs text-slate-500 mt-0.5">
                Báo hỏng điện, nước, điều hòa, nội thất
              </p>
            </button>

            <button
              type="button"
              onClick={() => onNavigateTab?.('services', { action: 'subscribe' })}
              className="group flex flex-col items-start p-4 rounded-xl border border-slate-200/80 hover:border-emerald-300 hover:bg-emerald-50/40 transition-all text-left"
            >
              <div className="w-10 h-10 rounded-xl bg-emerald-100 text-emerald-600 flex items-center justify-center mb-3 group-hover:scale-105 transition-transform">
                <Sparkles className="w-5 h-5" />
              </div>
              <p className="text-sm font-semibold text-slate-900">Đăng ký dịch vụ</p>
              <p className="text-xs text-slate-500 mt-0.5">
                Gửi xe, dọn phòng, tiện ích mở rộng
              </p>
            </button>

            <button
              type="button"
              onClick={() => onNavigateTab?.('contract')}
              className="group flex flex-col items-start p-4 rounded-xl border border-slate-200/80 hover:border-indigo-300 hover:bg-indigo-50/40 transition-all text-left"
            >
              <div className="w-10 h-10 rounded-xl bg-indigo-100 text-indigo-600 flex items-center justify-center mb-3 group-hover:scale-105 transition-transform">
                <FileText className="w-5 h-5" />
              </div>
              <p className="text-sm font-semibold text-slate-900">Xem hợp đồng</p>
              <p className="text-xs text-slate-500 mt-0.5">
                Bản in A4, phụ lục, gia hạn & sổ cọc
              </p>
            </button>
          </div>
        </Card>

        {/* Latest Invoice & Support Summary */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <Card className="lg:col-span-2">
            <CardHeader
              title="Hóa đơn kỳ gần nhất"
              subtitle="Theo dõi trạng thái thanh toán kỳ hiện hành"
              action={
                <Button variant="ghost" size="sm" onClick={() => onNavigateTab?.('invoices')}>
                  Tất cả hóa đơn
                </Button>
              }
            />
            {latestInvoice ? (
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 p-4 rounded-xl bg-slate-50 border border-slate-200/70">
                <div className="space-y-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-bold text-slate-900">
                      {latestInvoice.invoice_code}
                    </span>
                    <Badge variant="sky">Kỳ {latestInvoice.period}</Badge>
                    <StatusBadge status={latestInvoice.status} domain="invoice" />
                  </div>
                  <p className="text-xs text-slate-500">
                    Hạn thanh toán: <span className="font-medium text-slate-700">{formatDate(latestInvoice.due_date)}</span>
                    {' • '}Đã trả: <span className="font-medium text-emerald-700">{formatMoney(latestInvoice.paid_amount)}</span>
                  </p>
                </div>
                <div className="flex items-center justify-between sm:justify-end gap-3">
                  <div className="text-left sm:text-right">
                    <p className="text-[11px] text-slate-500">Tổng hóa đơn</p>
                    <p className="text-base font-bold text-slate-900">
                      {formatMoney(latestInvoice.total_amount)}
                    </p>
                  </div>
                  {['ISSUED', 'PARTIALLY_PAID', 'OVERDUE'].includes(latestInvoice.status) ? (
                    <Button
                      size="sm"
                      onClick={() => onNavigateTab?.('invoices', { action: 'pay' })}
                    >
                      Thanh toán
                    </Button>
                  ) : null}
                </div>
              </div>
            ) : (
              <p className="text-xs text-slate-500 py-4">
                Hiện chưa có hóa đơn nào được phát hành cho căn hộ của bạn.
              </p>
            )}
          </Card>

          <Card>
            <CardHeader
              title="Ban Quản Lý hỗ trợ"
              subtitle="Liên hệ nhanh khi cần giúp đỡ"
            />
            <div className="space-y-2.5 text-xs">
              <div className="p-3 rounded-xl bg-slate-50 border border-slate-200/70 space-y-1">
                <p className="font-semibold text-slate-900 text-sm">
                  {overview?.manager_contact?.full_name || 'Ban Quản Lý ResiHub'}
                </p>
                {overview?.manager_contact?.phone ? (
                  <p className="text-slate-600">
                    SĐT Quản lý: <span className="font-semibold text-slate-800">{overview.manager_contact.phone}</span>
                  </p>
                ) : null}
                {overview?.manager_contact?.email ? (
                  <p className="text-slate-600 break-all">
                    Email: <span className="font-medium text-slate-800">{overview.manager_contact.email}</span>
                  </p>
                ) : null}
                <p className="text-slate-500">
                  Hotline KT: <span className="font-semibold text-slate-800">{overview?.manager_contact?.technical_hotline || '1900 6868'}</span>
                </p>
                <p className="text-slate-500">
                  Giờ làm việc: {overview?.manager_contact?.working_hours || '08:00 – 18:00'}
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                className="w-full"
                onClick={() => onNavigateTab?.('contact')}
              >
                Xem đầy đủ danh bạ BQL
              </Button>
            </div>
          </Card>
        </div>

        {renderApplicationModal()}
      </div>
    );
  }

  // Case: Resident DOES NOT have an active contract yet
  const hasHeldReservation = reservations.some((r) => (r.reservation_status || 'HELD') === 'HELD');
  const showInlineOnboardingForm = hasHeldReservation && !onboardingApplication;

  return (
    <div className="space-y-6">
      {/* Welcome Banner */}
      <div className="rounded-2xl bg-gradient-to-br from-sky-500 via-primary-600 to-indigo-700 text-white p-6 sm:p-7 shadow-elevated">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="space-y-1.5">
            <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-white/20 border border-white/25">
              Chào mừng đến với ResiHub
            </span>
            <h1 className="text-2xl font-bold tracking-tight">
              Xin chào, {user?.full_name || reservation?.prospect_name || 'Quý khách'}!
            </h1>
            <p className="text-sm text-sky-100 max-w-2xl">
              {reservation
                ? reservation.reservation_status === 'PENDING_CONFIRM'
                  ? `Phiếu đặt cọc giữ chỗ căn hộ ${reservation.apartment_code} (${reservation.building_name}) của bạn đang chờ Ban Quản Lý đối soát sao kê ngân hàng.`
                  : `Bạn đang có phiếu đặt cọc giữ chỗ căn hộ ${reservation.apartment_code} (${reservation.building_name}). Vui lòng kiểm tra thông tin căn hộ và hoàn tất hồ sơ nhận nhà bên dưới.`
                : 'Tài khoản của bạn hiện chưa có hợp đồng thuê đang hiệu lực. Bạn có thể theo dõi trạng thái hồ sơ giữ chỗ hoặc chọn căn hộ trống bên dưới để gửi đăng ký thuê trực tuyến.'}
            </p>
          </div>
          {!showInlineOnboardingForm ? (
            <Button
              variant="outline"
              size="lg"
              icon={Send}
              onClick={() => openApplyModal(hasHeldReservation ? reservation?.apartment_id || '' : '')}
              className="!bg-white !text-primary-700 hover:!bg-sky-50 !border-white shrink-0 font-semibold"
            >
              {hasHeldReservation ? 'Đăng ký thông tin nhận nhà' : 'Đăng ký thuê trực tuyến'}
            </Button>
          ) : null}
        </div>
      </div>

      {/* Scenario 1 Step 3: Reserved Apartment Info + Inline Onboarding Form (when not yet submitted) */}
      {showInlineOnboardingForm ? (
        <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
          <div className="xl:col-span-5">
            {renderReservationsSection({ showActionButton: false })}
          </div>
          <Card className="xl:col-span-7 border-primary-200/80 shadow-card">
            <CardHeader
              title="Đăng ký thông tin nhận nhà"
              subtitle="Khai báo thông tin định danh và tải lên ảnh CCCD 2 mặt để Ban Quản Lý phê duyệt hồ sơ"
            />
            <form onSubmit={handleSubmitApplication} className="space-y-4">
              {renderApplicationFormFields()}
              <div className="flex justify-end pt-2">
                <Button type="submit" size="lg" icon={Send} loading={submitting}>
                  Gửi hồ sơ đăng ký
                </Button>
              </div>
            </form>
          </Card>
        </div>
      ) : reservations.length > 0 || onboardingApplication ? (
        <div
          className={`grid grid-cols-1 ${
            reservations.length > 0 && onboardingApplication ? 'lg:grid-cols-2' : ''
          } gap-4 items-start`}
        >
          {renderOnboardingStatusCard()}
          {renderReservationsSection({ showActionButton: false })}
        </div>
      ) : null}

      {/* Reservation History (settled / cancelled / rejected reservations) */}
      {reservationHistory.length > 0 ? (
        <Card>
          <CardHeader
            title="Lịch sử phiếu đặt cọc giữ chỗ"
            subtitle="Các phiếu giữ chỗ đã thanh lý, hoàn trả hoặc từ chối đối soát"
          />
          <div className="space-y-2.5">
            {reservationHistory.map((h) => (
              <div
                key={h.reservation_id}
                className="p-3.5 rounded-xl border border-slate-200/80 bg-slate-50/70 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs"
              >
                <div className="space-y-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-bold text-slate-900">
                      Căn {h.apartment_code} — {h.building_name}
                    </span>
                    <StatusBadge status={h.reservation_status} domain="reservation" />
                  </div>
                  <p className="text-slate-600">
                    Số tiền cọc giữ chỗ: <strong className="text-slate-800">{formatMoney(h.hold_amount)}</strong>
                    {h.reservation_status === 'PARTIALLY_REFUNDED' ||
                    Number(h.refunded_amount || 0) > 0 ||
                    Number(h.forfeited_amount || 0) > 0 ? (
                      <>
                        {' • '}Hoàn trả: <strong className="text-emerald-700">{formatMoney(h.refunded_amount || 0)}</strong>
                        {' • '}Tịch thu/Khấu trừ:{' '}
                        <strong className="text-rose-700">{formatMoney(h.forfeited_amount || 0)}</strong>
                      </>
                    ) : null}
                  </p>
                  {h.settlement_reason ? (
                    <p className="text-slate-500 italic">Lý do: {h.settlement_reason}</p>
                  ) : null}
                </div>
                <span className="text-[11px] text-slate-500 shrink-0">
                  {h.settled_at ? formatDateTime(h.settled_at) : formatDate(h.hold_until)}
                </span>
              </div>
            ))}
          </div>
        </Card>
      ) : null}

      {/* Available Apartments */}
      <Card>
        <CardHeader
          title="Căn hộ còn trống khả dụng"
          subtitle="Chọn căn hộ phù hợp và gửi hồ sơ đăng ký thuê trực tuyến chỉ trong 1 phút"
        />

        {availableApartments.length === 0 ? (
          <EmptyState
            icon={Building2}
            title="Hiện chưa có căn hộ trống công khai"
            description="Bạn vẫn có thể gửi hồ sơ đăng ký chờ hoặc liên hệ trực tiếp Ban Quản Lý để được tư vấn căn hộ sắp trống."
            action={
              <Button icon={Send} onClick={() => openApplyModal('')}>
                Gửi hồ sơ đăng ký thuê
              </Button>
            }
          />
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-2 xl:grid-cols-3 gap-4">
            {availableApartments.map((apt) => {
              const aptAmenities = parseAmenities(apt.amenities);
              const isReservedApt =
                reservations.some((r) => r.apartment_id === apt.id) || apt.status === 'RESERVED';
              return (
                <div
                  key={apt.id}
                  className={`rounded-xl border transition-all p-4 flex flex-col justify-between bg-white ${
                    isReservedApt
                      ? 'border-sky-300 bg-sky-50/20 shadow-sm'
                      : 'border-slate-200/90 hover:border-primary-400 hover:shadow-md'
                  }`}
                >
                  <div className="space-y-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <span className="text-base font-bold text-slate-900">
                          Căn {apt.code}
                        </span>
                        <p className="text-xs text-slate-600 flex items-start gap-1 mt-0.5">
                          <MapPin className="w-3.5 h-3.5 text-slate-400 shrink-0 mt-0.5" />
                          <span className="break-words leading-snug">
                            <strong className="font-medium text-slate-700">{apt.building_name}</strong>
                            {apt.building_address ? ` — ${apt.building_address}` : ''}
                          </span>
                        </p>
                      </div>
                      {isReservedApt ? (
                        <Badge variant="sky" dot className="shrink-0">
                          Đang giữ chỗ
                        </Badge>
                      ) : (
                        <Badge variant="emerald" dot className="shrink-0">
                          Còn trống
                        </Badge>
                      )}
                    </div>

                    <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-slate-600 bg-slate-50 px-3 py-2 rounded-lg">
                      <span>{apt.area_m2 ? `${apt.area_m2} m²` : '—'}</span>
                      <span className="text-slate-300">•</span>
                      <span>{apt.type || `${apt.bedrooms || 1} PN`}</span>
                      {apt.floor_name ? (
                        <>
                          <span className="text-slate-300">•</span>
                          <span className="break-words">{apt.floor_name}</span>
                        </>
                      ) : null}
                    </div>

                    {aptAmenities.length > 0 ? (
                      <div className="flex flex-wrap gap-1">
                        {aptAmenities.slice(0, 5).map((am, i) => (
                          <span
                            key={i}
                            className="text-[11px] px-2 py-0.5 rounded-md bg-slate-100 text-slate-600"
                          >
                            {am}
                          </span>
                        ))}
                        {aptAmenities.length > 5 ? (
                          <span
                            title={aptAmenities.slice(5).join(', ')}
                            className="text-[11px] px-2 py-0.5 rounded-md bg-slate-100 text-slate-500 cursor-help"
                          >
                            +{aptAmenities.length - 5} tiện ích
                          </span>
                        ) : null}
                      </div>
                    ) : null}
                  </div>

                  <div className="pt-4 mt-4 border-t border-slate-100 flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <p className="text-[11px] text-slate-400">Giá thuê niêm yết</p>
                      <p className="text-sm font-bold text-primary-600 tabular-nums">
                        {formatMoney(apt.base_rent)}
                        <span className="text-[11px] font-normal text-slate-500">/tháng</span>
                      </p>
                    </div>
                    <Button size="sm" onClick={() => openApplyModal(apt.id)}>
                      {isReservedApt ? 'Đăng ký nhận nhà' : 'Đăng ký thuê'}
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      {renderApplicationModal()}
    </div>
  );
}

export default OverviewTab;
