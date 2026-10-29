import React, { useState, useMemo } from 'react';
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
} from 'lucide-react';
import { Card, CardHeader } from '../../../components/ui/Card';
import { Button } from '../../../components/ui/Button';
import { Badge } from '../../../components/ui/Badge';
import { Input } from '../../../components/ui/Input';
import { Select } from '../../../components/ui/Select';
import { Modal } from '../../../components/ui/Modal';
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
  const reservation = overview?.reservation || null;
  const pendingApplication = overview?.pending_application || null;
  const availableApartments = Array.isArray(overview?.available_apartments)
    ? overview.available_apartments
    : [];

  const [applyModalOpen, setApplyModalOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [formErrors, setFormErrors] = useState({});
  const [appForm, setAppForm] = useState({
    full_name: '',
    id_number: '',
    dob: '',
    desired_apartment_id: '',
    note: '',
  });

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
    setAppForm({
      full_name: user?.full_name || '',
      id_number: user?.id_number || '',
      dob: toInputDate(user?.dob) || '',
      desired_apartment_id: aptId || availableApartments[0]?.id || '',
      note: '',
    });
    setApplyModalOpen(true);
  };

  const handleSubmitApplication = async (e) => {
    e.preventDefault();
    const errs = {};
    if (!appForm.full_name?.trim()) {
      errs.full_name = 'Vui lòng nhập họ và tên đầy đủ.';
    }
    if (appForm.id_number?.trim() && !isValidIdNumber(appForm.id_number)) {
      errs.id_number = 'Số CCCD / Hộ chiếu không hợp lệ (9 hoặc 12 chữ số).';
    }
    if (Object.keys(errs).length > 0) {
      setFormErrors(errs);
      return;
    }

    setSubmitting(true);
    try {
      const res = await residentService.submitRentalApplication({
        full_name: appForm.full_name.trim(),
        id_number: appForm.id_number?.trim() || undefined,
        dob: appForm.dob || undefined,
        desired_apartment_id: appForm.desired_apartment_id || undefined,
        note: appForm.note?.trim() || undefined,
      });
      toast.success(res?.message || 'Đã gửi đăng ký thuê căn hộ thành công!');
      setApplyModalOpen(false);
      await onRefreshOverview?.();
    } catch (err) {
      toast.error(extractErrorMessage(err, 'Không thể gửi đăng ký thuê trực tuyến.'));
    } finally {
      setSubmitting(false);
    }
  };

  if (contract) {
    const openTotal = unreadCount + openRequestsCount;

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
                  Căn hộ đang cư trú
                </span>
                <StatusBadge
                  status={contract.contract_status}
                  domain="contract"
                  className="!bg-white/95 !border-white/50 shadow-sm"
                />
                {daysRemaining !== null && daysRemaining <= 30 && daysRemaining >= 0 ? (
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
                <p className="text-sm text-sky-100 flex items-center gap-1.5 mt-1">
                  <Building2 className="w-4 h-4 shrink-0 text-sky-200" />
                  <span>
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
            <div className="grid grid-cols-3 lg:grid-cols-1 gap-2.5 sm:gap-3 lg:min-w-[230px] bg-white/10 backdrop-blur-md rounded-xl p-3.5 sm:p-4 border border-white/15">
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-lg bg-white/15 flex items-center justify-center shrink-0">
                  <Maximize2 className="w-4 h-4 text-sky-100" />
                </div>
                <div className="min-w-0">
                  <p className="text-[11px] text-sky-200">Diện tích</p>
                  <p className="text-sm font-bold truncate">
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
                  <p className="text-sm font-bold truncate">
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
                  <p className="text-[11px] text-sky-200">Hết hạn HĐ</p>
                  <p className="text-sm font-bold truncate">{formatDate(contract.end_date)}</p>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* 4 KPI Cards Row */}
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
          {/* KPI 1: Current Amount Due (AC-002.1) */}
          <Card
            className={`flex flex-col justify-between transition-all ${
              currentAmountDue > 0
                ? 'border-amber-300 bg-gradient-to-br from-white to-amber-50/40'
                : 'border-emerald-200/80'
            }`}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-xs font-medium text-slate-500 uppercase tracking-wide">
                  Cần thanh toán hiện tại
                </p>
                <p
                  className={`text-2xl font-bold mt-1.5 truncate ${
                    currentAmountDue > 0 ? 'text-rose-600' : 'text-emerald-600'
                  }`}
                >
                  {formatMoney(currentAmountDue)}
                </p>
              </div>
              <div
                className={`w-10 h-10 rounded-xl border flex items-center justify-center shrink-0 ${
                  currentAmountDue > 0
                    ? 'bg-rose-50 text-rose-600 border-rose-100'
                    : 'bg-emerald-50 text-emerald-600 border-emerald-100'
                }`}
              >
                <Receipt className="w-5 h-5" />
              </div>
            </div>

            <div className="mt-3 pt-3 border-t border-slate-100 flex items-center justify-between gap-2">
              <span className="text-xs text-slate-500 truncate">
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
          <Card className="flex flex-col justify-between">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-xs font-medium text-slate-500 uppercase tracking-wide">
                  Tiền thuê hàng tháng
                </p>
                <p className="text-2xl font-bold text-slate-900 mt-1.5 truncate">
                  {formatMoney(contract.rent_amount)}
                </p>
              </div>
              <div className="w-10 h-10 rounded-xl border bg-sky-50 text-sky-600 border-sky-100 flex items-center justify-center shrink-0">
                <Wallet className="w-5 h-5" />
              </div>
            </div>

            <div className="mt-3 pt-3 border-t border-slate-100 flex items-center justify-between text-xs text-slate-500">
              <span>Chốt kỳ ngày {contract.billing_day || 1} hàng tháng</span>
              <span className="font-medium text-slate-700">
                Hạn +{contract.payment_due_days || 5} ngày
              </span>
            </div>
          </Card>

          {/* KPI 3: Held Deposit */}
          <Card className="flex flex-col justify-between">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-xs font-medium text-slate-500 uppercase tracking-wide">
                  Tiền cọc đang giữ
                </p>
                <p className="text-2xl font-bold text-slate-900 mt-1.5 truncate">
                  {formatMoney(contract.deposit_held_amount ?? contract.deposit_amount ?? 0)}
                </p>
              </div>
              <div className="w-10 h-10 rounded-xl border bg-indigo-50 text-indigo-600 border-indigo-100 flex items-center justify-center shrink-0">
                <ShieldCheck className="w-5 h-5" />
              </div>
            </div>

            <div className="mt-3 pt-3 border-t border-slate-100 flex items-center justify-between gap-2">
              <span className="text-xs text-slate-500 truncate">
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
          <Card className="flex flex-col justify-between">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-xs font-medium text-slate-500 uppercase tracking-wide">
                  Thông báo & Yêu cầu mở
                </p>
                <p className="text-2xl font-bold text-slate-900 mt-1.5 truncate">
                  {openTotal}
                </p>
              </div>
              <div className="w-10 h-10 rounded-xl border bg-purple-50 text-purple-600 border-purple-100 flex items-center justify-center shrink-0">
                <BellRing className="w-5 h-5" />
              </div>
            </div>

            <div className="mt-3 pt-3 border-t border-slate-100 flex items-center justify-between text-xs">
              <button
                type="button"
                onClick={() => onNavigateTab?.('notifications')}
                className="text-slate-600 hover:text-primary-600 font-medium"
              >
                {unreadCount} chưa đọc
              </button>
              <span className="text-slate-300">•</span>
              <button
                type="button"
                onClick={() => onNavigateTab?.('maintenance')}
                className="text-slate-600 hover:text-primary-600 font-medium"
              >
                {openRequestsCount} báo hỏng đang xử lý
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
              <div className="p-3 rounded-xl bg-slate-50 border border-slate-200/70">
                <p className="font-semibold text-slate-900 text-sm">
                  {overview?.manager_contact?.full_name || 'Ban Quản Lý ResiHub'}
                </p>
                <p className="text-slate-500 mt-0.5">
                  Hotline KT: <span className="font-semibold text-slate-800">{overview?.manager_contact?.technical_hotline || '1900 6868'}</span>
                </p>
                <p className="text-slate-500 mt-0.5">
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
      </div>
    );
  }

  // Case: Resident DOES NOT have an active contract yet
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
              Xin chào, {user?.full_name || 'Quý khách'}!
            </h1>
            <p className="text-sm text-sky-100 max-w-2xl">
              Tài khoản của bạn hiện chưa có hợp đồng thuê đang hiệu lực. Bạn có thể theo dõi trạng thái hồ sơ giữ chỗ hoặc chọn căn hộ trống bên dưới để gửi đăng ký thuê trực tuyến.
            </p>
          </div>
          <Button
            variant="outline"
            size="lg"
            icon={Send}
            onClick={() => openApplyModal('')}
            className="!bg-white !text-primary-700 hover:!bg-sky-50 !border-white shrink-0 font-semibold"
          >
            Đăng ký thuê trực tuyến
          </Button>
        </div>
      </div>

      {/* Existing Pending Application or Reservation Status */}
      {(pendingApplication || reservation) ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {pendingApplication ? (
            <Card className="border-amber-200 bg-amber-50/30">
              <div className="flex items-start gap-3.5">
                <div className="w-10 h-10 rounded-xl bg-amber-100 text-amber-700 flex items-center justify-center shrink-0">
                  <Clock className="w-5 h-5" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h3 className="text-sm font-semibold text-slate-900">
                      Hồ sơ đăng ký thuê đang chờ duyệt
                    </h3>
                    <Badge variant="amber" dot>
                      Chờ phê duyệt
                    </Badge>
                  </div>
                  <p className="text-xs text-slate-600 mt-1 leading-relaxed">
                    Hồ sơ tự khai của bạn (gửi lúc {formatDateTime(pendingApplication.created_at)}) đã được ghi nhận. Ban Quản Lý sẽ liên hệ xác minh và hoàn tất hợp đồng thuê.
                  </p>
                  <div className="mt-3">
                    <Button size="xs" variant="outline" onClick={() => openApplyModal('')}>
                      Cập nhật bổ sung thông tin hồ sơ
                    </Button>
                  </div>
                </div>
              </div>
            </Card>
          ) : null}

          {reservation ? (
            <Card className="border-sky-200 bg-sky-50/30">
              <div className="flex items-start gap-3.5">
                <div className="w-10 h-10 rounded-xl bg-sky-100 text-sky-700 flex items-center justify-center shrink-0">
                  <ShieldCheck className="w-5 h-5" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h3 className="text-sm font-semibold text-slate-900">
                      Phiếu đặt cọc giữ chỗ: Căn {reservation.apartment_code}
                    </h3>
                    <Badge variant="sky" dot>
                      Đang giữ chỗ
                    </Badge>
                  </div>
                  <p className="text-xs text-slate-600 mt-1">
                    Tòa nhà: <span className="font-medium text-slate-800">{reservation.building_name}</span>
                    {reservation.area_m2 ? ` • ${reservation.area_m2} m²` : ''}
                  </p>
                  <p className="text-xs text-slate-600 mt-0.5">
                    Tiền giữ chỗ: <span className="font-bold text-primary-700">{formatMoney(reservation.hold_amount)}</span>
                    {' • '}Giữ đến: <span className="font-medium">{formatDateTime(reservation.hold_until)}</span>
                  </p>
                </div>
              </div>
            </Card>
          ) : null}
        </div>
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
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {availableApartments.map((apt) => {
              const aptAmenities = parseAmenities(apt.amenities);
              return (
                <div
                  key={apt.id}
                  className="rounded-xl border border-slate-200/90 hover:border-primary-400 hover:shadow-md transition-all p-4 flex flex-col justify-between bg-white"
                >
                  <div className="space-y-3">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <span className="text-base font-bold text-slate-900">
                          Căn {apt.code}
                        </span>
                        <p className="text-xs text-slate-500 flex items-center gap-1 mt-0.5">
                          <MapPin className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                          <span className="truncate">{apt.building_name}</span>
                        </p>
                      </div>
                      <Badge variant="emerald" dot>
                        Còn trống
                      </Badge>
                    </div>

                    <div className="flex items-center gap-3 text-xs text-slate-600 bg-slate-50 px-3 py-2 rounded-lg">
                      <span>{apt.area_m2 ? `${apt.area_m2} m²` : '—'}</span>
                      <span className="text-slate-300">•</span>
                      <span>{apt.type || `${apt.bedrooms || 1} PN`}</span>
                      {apt.floor_name ? (
                        <>
                          <span className="text-slate-300">•</span>
                          <span className="truncate">{apt.floor_name}</span>
                        </>
                      ) : null}
                    </div>

                    {aptAmenities.length > 0 ? (
                      <div className="flex flex-wrap gap-1">
                        {aptAmenities.slice(0, 4).map((am, i) => (
                          <span
                            key={i}
                            className="text-[11px] px-2 py-0.5 rounded-md bg-slate-100 text-slate-600"
                          >
                            {am}
                          </span>
                        ))}
                        {aptAmenities.length > 4 ? (
                          <span className="text-[11px] px-2 py-0.5 rounded-md bg-slate-100 text-slate-500">
                            +{aptAmenities.length - 4}
                          </span>
                        ) : null}
                      </div>
                    ) : null}
                  </div>

                  <div className="pt-4 mt-4 border-t border-slate-100 flex items-center justify-between gap-2">
                    <div>
                      <p className="text-[11px] text-slate-400">Giá thuê niêm yết</p>
                      <p className="text-sm font-bold text-primary-600">
                        {formatMoney(apt.base_rent)}
                        <span className="text-[11px] font-normal text-slate-500">/tháng</span>
                      </p>
                    </div>
                    <Button size="sm" onClick={() => openApplyModal(apt.id)}>
                      Đăng ký thuê
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      {/* Online Rental Application Modal */}
      <Modal
        open={applyModalOpen}
        onClose={() => setApplyModalOpen(false)}
        title="Đăng ký thuê căn hộ trực tuyến"
        subtitle="Điền thông tin cá nhân để Ban Quản Lý duyệt hồ sơ và liên hệ bàn giao phòng"
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
        <form onSubmit={handleSubmitApplication} className="space-y-4">
          <Select
            label="Căn hộ mong muốn thuê"
            placeholder="-- Chọn căn hộ trống (hoặc để BQL tư vấn) --"
            value={appForm.desired_apartment_id}
            onChange={(e) => setAppForm((s) => ({ ...s, desired_apartment_id: e.target.value }))}
            options={availableApartments.map((a) => ({
              value: a.id,
              label: `Căn ${a.code} — ${a.building_name} (${a.area_m2}m² • ${formatMoney(a.base_rent)}/tháng)`,
            }))}
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
              label="Số CCCD / Hộ chiếu"
              placeholder="012345678901"
              value={appForm.id_number}
              error={formErrors.id_number}
              onChange={(e) => {
                setAppForm((s) => ({ ...s, id_number: e.target.value }));
                if (formErrors.id_number) setFormErrors((err) => ({ ...err, id_number: '' }));
              }}
            />
            <Input
              type="date"
              label="Ngày sinh"
              value={appForm.dob}
              onChange={(e) => setAppForm((s) => ({ ...s, dob: e.target.value }))}
            />
          </div>

          <Input
            multiline
            rows={3}
            label="Ghi chú / Nhu cầu thêm"
            placeholder="Ví dụ: Ngày dự kiến chuyển vào, số người ở cùng, nhu cầu gửi xe..."
            value={appForm.note}
            onChange={(e) => setAppForm((s) => ({ ...s, note: e.target.value }))}
          />
        </form>
      </Modal>
    </div>
  );
}

export default OverviewTab;
