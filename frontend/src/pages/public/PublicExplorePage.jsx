import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  Home,
  Building2,
  MapPin,
  Search,
  Sparkles,
  ShieldCheck,
  KeyRound,
  Phone,
  CheckCircle2,
  Clock,
  ArrowRight,
  BedDouble,
  Maximize2,
  Landmark,
  Info,
} from 'lucide-react';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { MoneyInput } from '../../components/ui/MoneyInput';
import { Select } from '../../components/ui/Select';
import { Badge } from '../../components/ui/Badge';
import { Card } from '../../components/ui/Card';
import { Modal } from '../../components/ui/Modal';
import { FileUpload } from '../../components/ui/FileUpload';
import { EmptyState } from '../../components/common/EmptyState';
import { publicService } from '../../services/public.service';
import { useAuthStore } from '../../stores/authStore';
import { useToast } from '../../hooks/useToast';
import { formatMoney, formatDate } from '../../utils/format';
import { addDaysStr, toDateOnlyStr } from '../../utils/dateRange';
import { extractErrorMessage, isValidPhone, normalizePhone } from '../../utils/validation';
import { createIdempotencyKey } from '../../utils/idempotency';
import { DEFAULT_RESERVATION_CANCEL_POLICY } from '../../utils/depositUiHelpers';

function extractAmenityLabels(amenities) {
  if (!amenities) return [];
  if (Array.isArray(amenities)) return amenities.filter(Boolean);
  if (typeof amenities === 'object') {
    return Object.entries(amenities)
      .filter(([, v]) => Boolean(v))
      .map(([k, v]) => (typeof v === 'string' ? `${k}: ${v}` : k));
  }
  return [];
}

function buildVietQrImageUrl(paymentAccount, amount, transferNote) {
  const bin = String(paymentAccount?.bank_bin || '').trim();
  const accNo = String(paymentAccount?.account_number || '').trim();
  if (!bin || !accNo) return null;
  const amtParam = Number(amount || 0) > 0 ? `amount=${Math.round(Number(amount))}` : '';
  const infoParam = transferNote ? `addInfo=${encodeURIComponent(transferNote)}` : '';
  const accountNameParam = paymentAccount?.account_name
    ? `accountName=${encodeURIComponent(paymentAccount.account_name)}`
    : '';
  const query = [amtParam, infoParam, accountNameParam].filter(Boolean).join('&');
  return `https://img.vietqr.io/image/${bin}-${accNo}-compact2.png${query ? `?${query}` : ''}`;
}

export function PublicExplorePage() {
  const navigate = useNavigate();
  const toast = useToast();
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const isAdminPortal = useAuthStore((s) => s.isAdminPortal);
  const todayStr = toDateOnlyStr(new Date());

  const [loading, setLoading] = useState(true);
  const [catalog, setCatalog] = useState({
    buildings: [],
    apartments: [],
    policy: DEFAULT_RESERVATION_CANCEL_POLICY,
    policies_by_org: {},
    payment_accounts: {},
  });

  // Filters (H2)
  const [searchText, setSearchText] = useState('');
  const [buildingFilter, setBuildingFilter] = useState('ALL');
  const [typeFilter, setTypeFilter] = useState('ALL');
  const [maxPriceFilter, setMaxPriceFilter] = useState('ALL');

  // Online Booking Modal (H3)
  const bookingIdemKeyRef = useRef(createIdempotencyKey());
  const [selectedApt, setSelectedApt] = useState(null);
  const [bookingStep, setBookingStep] = useState('form'); // 'form' | 'done'
  const [submittedReservation, setSubmittedReservation] = useState(null);
  const [otpSending, setOtpSending] = useState(false);
  const [otpSent, setOtpSent] = useState(false);
  const [otpCountdown, setOtpCountdown] = useState(0);
  const [devOtpHint, setDevOtpHint] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const [bookingForm, setBookingForm] = useState({
    prospect_name: '',
    phone: '',
    otp: '',
    hold_amount: DEFAULT_RESERVATION_CANCEL_POLICY.default_hold_amount,
    hold_from: todayStr,
    hold_until: addDaysStr(todayStr, 3),
    evidence: [],
    privacy_consent: false,
    note: '',
  });

  const loadCatalog = useCallback(async () => {
    setLoading(true);
    try {
      const res = await publicService.getApartments();
      if (res?.data) {
        setCatalog({
          buildings: res.data.buildings || [],
          apartments: res.data.apartments || [],
          policy: res.data.policy || DEFAULT_RESERVATION_CANCEL_POLICY,
          policies_by_org: res.data.policies_by_org || {},
          payment_accounts: res.data.payment_accounts || {},
        });
      }
    } catch (err) {
      toast.error(extractErrorMessage(err, 'Không thể tải danh mục căn hộ trống.'));
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    loadCatalog();
  }, [loadCatalog]);

  useEffect(() => {
    if (otpCountdown <= 0) return undefined;
    const t = setTimeout(() => setOtpCountdown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [otpCountdown]);

  const distinctTypes = useMemo(() => {
    const s = new Set();
    for (const a of catalog.apartments) {
      if (a.type) s.add(a.type);
    }
    return Array.from(s);
  }, [catalog.apartments]);

  const filteredApartments = useMemo(() => {
    const q = searchText.trim().toLowerCase();
    return catalog.apartments.filter((a) => {
      if (buildingFilter !== 'ALL' && a.building_id !== buildingFilter) return false;
      if (typeFilter !== 'ALL' && a.type !== typeFilter) return false;
      if (maxPriceFilter !== 'ALL' && Number(a.base_rent || 0) > Number(maxPriceFilter)) {
        return false;
      }
      if (q) {
        const hay = `${a.code || ''} ${a.building_name || ''} ${a.building_code || ''} ${
          a.building_address || ''
        } ${a.type || ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [catalog.apartments, buildingFilter, typeFilter, maxPriceFilter, searchText]);

  const buildingStats = useMemo(() => {
    const map = {};
    for (const b of catalog.buildings) {
      map[b.id] = { count: 0, minRent: null };
    }
    for (const a of catalog.apartments) {
      if (!map[a.building_id]) map[a.building_id] = { count: 0, minRent: null };
      map[a.building_id].count += 1;
      const rent = Number(a.base_rent || 0);
      if (rent > 0 && (map[a.building_id].minRent === null || rent < map[a.building_id].minRent)) {
        map[a.building_id].minRent = rent;
      }
    }
    return map;
  }, [catalog.buildings, catalog.apartments]);

  const selectedOrgPolicy = useMemo(() => {
    if (!selectedApt) return catalog.policy || DEFAULT_RESERVATION_CANCEL_POLICY;
    return (
      catalog.policies_by_org?.[selectedApt.org_id] ||
      catalog.policy ||
      DEFAULT_RESERVATION_CANCEL_POLICY
    );
  }, [selectedApt, catalog.policies_by_org, catalog.policy]);

  const selectedPaymentAccount = useMemo(() => {
    if (!selectedApt) return null;
    return catalog.payment_accounts?.[selectedApt.building_id] || null;
  }, [selectedApt, catalog.payment_accounts]);

  const handleOpenBookingModal = (apt) => {
    const orgPol =
      catalog.policies_by_org?.[apt.org_id] ||
      catalog.policy ||
      DEFAULT_RESERVATION_CANCEL_POLICY;
    const maxPublicDays = Math.max(1, Number(orgPol.public_max_hold_days || 7));
    const defaultSpan = Math.min(3, maxPublicDays);
    bookingIdemKeyRef.current = createIdempotencyKey();
    setSelectedApt(apt);
    setBookingStep('form');
    setSubmittedReservation(null);
    setOtpSent(false);
    setOtpCountdown(0);
    setDevOtpHint('');
    setBookingForm({
      prospect_name: '',
      phone: '',
      otp: '',
      hold_amount:
        Number(orgPol.default_hold_amount) ||
        DEFAULT_RESERVATION_CANCEL_POLICY.default_hold_amount,
      hold_from: todayStr,
      hold_until: addDaysStr(todayStr, defaultSpan),
      evidence: [],
      privacy_consent: false,
      note: '',
    });
  };

  const handleSendOtp = async () => {
    if (!isValidPhone(bookingForm.phone)) {
      toast.warning('Vui lòng nhập số điện thoại 10 chữ số hợp lệ (ví dụ: 0912345678).');
      return;
    }
    setOtpSending(true);
    try {
      const clean = normalizePhone(bookingForm.phone);
      const res = await publicService.requestReservationOtp(clean);
      setOtpSent(true);
      setOtpCountdown(60);
      setDevOtpHint(res?.devOtp || '');
      toast.info(res?.message || 'Mã xác thực OTP đã được gửi.');
    } catch (err) {
      toast.error(extractErrorMessage(err, 'Không thể gửi mã OTP.'));
    } finally {
      setOtpSending(false);
    }
  };

  const handleSubmitBooking = async (e) => {
    e.preventDefault();
    if (!selectedApt) return;
    if (!bookingForm.prospect_name.trim()) {
      toast.warning('Vui lòng nhập họ và tên người đặt giữ chỗ.');
      return;
    }
    if (!isValidPhone(bookingForm.phone)) {
      toast.warning('Vui lòng nhập số điện thoại 10 chữ số hợp lệ.');
      return;
    }
    if (!bookingForm.otp.trim()) {
      toast.warning('Vui lòng nhập mã xác thực OTP 6 chữ số.');
      return;
    }
    const holdAmt = Number(String(bookingForm.hold_amount ?? '').trim());
    if (!Number.isInteger(holdAmt) || holdAmt <= 0) {
      toast.warning('Số tiền đặt giữ chỗ phải là số nguyên dương VND.');
      return;
    }
    if (!Array.isArray(bookingForm.evidence) || bookingForm.evidence.length === 0) {
      toast.warning('Vui lòng tải lên ảnh chụp biên lai chuyển khoản (UNC).');
      return;
    }
    if (!bookingForm.privacy_consent) {
      toast.warning('Vui lòng đồng ý điều khoản bảo vệ dữ liệu cá nhân trước khi gửi.');
      return;
    }

    setSubmitting(true);
    try {
      const res = await publicService.createReservation(
        {
          apartment_id: selectedApt.id,
          prospect_name: bookingForm.prospect_name.trim(),
          phone: normalizePhone(bookingForm.phone),
          otp: bookingForm.otp.trim(),
          hold_amount: holdAmt,
          hold_from: bookingForm.hold_from || todayStr,
          hold_until: bookingForm.hold_until,
          privacy_consent: true,
          evidence: bookingForm.evidence,
          note: bookingForm.note.trim(),
        },
        { idempotencyKey: bookingIdemKeyRef.current }
      );
      setSubmittedReservation(res?.data || null);
      setBookingStep('done');
      toast.success(res?.message || 'Đã gửi yêu cầu giữ chỗ trực tuyến thành công!');
    } catch (err) {
      toast.error(extractErrorMessage(err, 'Không thể gửi yêu cầu giữ chỗ.'));
    } finally {
      setSubmitting(false);
    }
  };

  const maxPublicDays = Math.max(1, Number(selectedOrgPolicy.public_max_hold_days || 7));
  const transferContent = selectedApt
    ? `GIU CHO ${selectedApt.code} ${normalizePhone(bookingForm.phone || '')}`.trim()
    : '';
  const qrImgUrl = selectedApt
    ? buildVietQrImageUrl(selectedPaymentAccount, bookingForm.hold_amount, transferContent)
    : null;

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col">
      {/* Top Public Navbar */}
      <header className="sticky top-0 z-30 bg-white/95 backdrop-blur border-b border-slate-200/80">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between gap-4">
          <Link to="/explore" className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-primary-500 to-indigo-600 flex items-center justify-center text-white shadow-sm">
              <Home className="w-5 h-5" />
            </div>
            <div>
              <span className="text-base font-bold text-slate-900 tracking-tight">ResiHub</span>
              <span className="hidden sm:inline-block ml-2 text-xs text-slate-500">
                Hệ thống Căn hộ Dịch vụ &amp; Đặt giữ chỗ Trực tuyến
              </span>
            </div>
          </Link>

          <div className="flex items-center gap-2.5">
            {isAuthenticated ? (
              <Button
                size="sm"
                icon={ArrowRight}
                onClick={() => navigate(isAdminPortal() ? '/admin/dashboard' : '/resident')}
              >
                Vào cổng của tôi
              </Button>
            ) : (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  icon={Phone}
                  onClick={() => navigate('/login?mode=otp')}
                >
                  Tra cứu giữ chỗ / Cư dân (OTP)
                </Button>
                <Button size="sm" onClick={() => navigate('/login')}>
                  Đăng nhập
                </Button>
              </>
            )}
          </div>
        </div>
      </header>

      {/* H1: Hero & Building Showcase */}
      <section className="bg-gradient-to-br from-slate-900 via-sky-950 to-indigo-950 text-white py-12 sm:py-16">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 space-y-8">
          <div className="max-w-3xl space-y-4">
            <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-white/10 border border-white/15 text-xs font-medium text-sky-200">
              <Sparkles className="w-3.5 h-3.5 text-sky-400" />
              Đặt giữ chỗ trực tuyến minh bạch — Đối soát sao kê ngân hàng chuẩn mực
            </span>
            <h1 className="text-3xl sm:text-4xl font-bold leading-tight">
              Khám phá căn hộ còn trống &amp; Đặt giữ chỗ trực tuyến ngay hôm nay
            </h1>
            <p className="text-sm sm:text-base text-slate-300 leading-relaxed">
              Giá thuê niêm yết rõ ràng, chính sách hoàn/hủy giữ chỗ công khai và theo dõi tiến độ duyệt trực tiếp trên Cổng cư dân bằng mã OTP số điện thoại.
            </p>
          </div>

          {/* Building Cards (H1) */}
          {catalog.buildings.length > 0 ? (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 pt-2">
              {catalog.buildings.map((b) => {
                const st = buildingStats[b.id] || { count: 0, minRent: null };
                const active = buildingFilter === b.id;
                return (
                  <button
                    key={b.id}
                    type="button"
                    onClick={() => setBuildingFilter(active ? 'ALL' : b.id)}
                    className={`text-left p-4 rounded-2xl border transition-all ${
                      active
                        ? 'bg-white text-slate-900 border-sky-400 shadow-lg'
                        : 'bg-white/10 hover:bg-white/15 text-white border-white/15'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <Building2
                          className={`w-5 h-5 shrink-0 ${
                            active ? 'text-primary-600' : 'text-sky-300'
                          }`}
                        />
                        <div>
                          <p className="text-sm font-bold">{b.name}</p>
                          <p
                            className={`text-[11px] ${
                              active ? 'text-slate-500' : 'text-slate-300'
                            }`}
                          >
                            Mã tòa: {b.code}
                          </p>
                        </div>
                      </div>
                      <span
                        className={`text-xs font-semibold px-2.5 py-0.5 rounded-full ${
                          active
                            ? 'bg-emerald-100 text-emerald-800'
                            : 'bg-emerald-400/20 text-emerald-200'
                        }`}
                      >
                        {st.count} căn trống
                      </span>
                    </div>
                    {b.address ? (
                      <p
                        className={`text-xs mt-2 flex items-center gap-1 ${
                          active ? 'text-slate-600' : 'text-slate-300'
                        }`}
                      >
                        <MapPin className="w-3.5 h-3.5 shrink-0" />
                        <span className="truncate">{b.address}</span>
                      </p>
                    ) : null}
                    <p
                      className={`text-xs font-semibold mt-2 ${
                        active ? 'text-primary-700' : 'text-sky-200'
                      }`}
                    >
                      {st.minRent
                        ? `Giá từ ${formatMoney(st.minRent)}/tháng`
                        : 'Liên hệ Ban quản lý'}
                    </p>
                  </button>
                );
              })}
            </div>
          ) : null}
        </div>
      </section>

      {/* H2: Filter & Available Apartments Catalog */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-6">
        <Card className="p-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3.5">
            <Input
              icon={Search}
              placeholder="Tìm mã căn, tên tòa, địa chỉ..."
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
            />
            <Select
              aria-label="Lọc theo tòa nhà"
              value={buildingFilter}
              onChange={(e) => setBuildingFilter(e.target.value)}
              options={[
                { value: 'ALL', label: `Tất cả tòa nhà (${catalog.buildings.length})` },
                ...catalog.buildings.map((b) => ({
                  value: b.id,
                  label: `${b.code} — ${b.name}`,
                })),
              ]}
            />
            <Select
              aria-label="Lọc theo loại căn"
              value={typeFilter}
              onChange={(e) => setTypeFilter(e.target.value)}
              options={[
                { value: 'ALL', label: 'Tất cả thiết kế' },
                ...distinctTypes.map((t) => ({ value: t, label: t })),
              ]}
            />
            <Select
              aria-label="Lọc theo mức giá"
              value={maxPriceFilter}
              onChange={(e) => setMaxPriceFilter(e.target.value)}
              options={[
                { value: 'ALL', label: 'Mọi mức giá thuê' },
                { value: '6000000', label: 'Dưới 6.000.000 ₫/tháng' },
                { value: '10000000', label: 'Dưới 10.000.000 ₫/tháng' },
                { value: '15000000', label: 'Dưới 15.000.000 ₫/tháng' },
                { value: '25000000', label: 'Dưới 25.000.000 ₫/tháng' },
              ]}
            />
          </div>
        </Card>

        <div className="flex items-center justify-between gap-2">
          <h2 className="text-lg font-bold text-slate-900">
            Danh sách căn hộ đang mở trống ({filteredApartments.length})
          </h2>
          {buildingFilter !== 'ALL' ? (
            <button
              type="button"
              onClick={() => setBuildingFilter('ALL')}
              className="text-xs font-medium text-primary-600 hover:underline"
            >
              Xem tất cả tòa nhà
            </button>
          ) : null}
        </div>

        {loading ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
            {[1, 2, 3, 4, 5, 6].map((i) => (
              <div
                key={i}
                className="h-64 rounded-2xl bg-white border border-slate-200 animate-pulse"
              />
            ))}
          </div>
        ) : filteredApartments.length === 0 ? (
          <Card>
            <EmptyState
              icon={Building2}
              title="Chưa tìm thấy căn hộ trống phù hợp"
              description="Hãy thử nới lỏng bộ lọc tòa nhà hoặc mức giá thuê."
            />
          </Card>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
            {filteredApartments.map((apt) => {
              const amenities = extractAmenityLabels(apt.amenities);
              const orgPol =
                catalog.policies_by_org?.[apt.org_id] ||
                catalog.policy ||
                DEFAULT_RESERVATION_CANCEL_POLICY;
              return (
                <Card
                  key={apt.id}
                  className="p-5 flex flex-col justify-between gap-4 hover:border-primary-300 transition-all"
                >
                  <div className="space-y-3">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <span className="text-xs font-semibold text-primary-600">
                          {apt.building_code} — {apt.building_name}
                        </span>
                        <h3 className="text-lg font-bold text-slate-900 mt-0.5">
                          Căn hộ {apt.code}
                        </h3>
                      </div>
                      <Badge variant="emerald">Còn trống</Badge>
                    </div>

                    <div className="flex flex-wrap items-center gap-3 text-xs text-slate-600">
                      <span className="inline-flex items-center gap-1">
                        <BedDouble className="w-3.5 h-3.5 text-slate-400" />
                        {apt.type || '1PN'} ({apt.bedrooms ?? 1} PN)
                      </span>
                      <span className="inline-flex items-center gap-1">
                        <Maximize2 className="w-3.5 h-3.5 text-slate-400" />
                        {apt.area_m2 || 0} m²
                      </span>
                      {apt.floor_name ? <span>• {apt.floor_name}</span> : null}
                    </div>

                    {apt.building_address ? (
                      <p className="text-xs text-slate-500 flex items-center gap-1">
                        <MapPin className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                        <span className="truncate">{apt.building_address}</span>
                      </p>
                    ) : null}

                    {amenities.length > 0 ? (
                      <div className="flex flex-wrap gap-1.5">
                        {amenities.slice(0, 4).map((am) => (
                          <Badge key={am} variant="sky">
                            {am}
                          </Badge>
                        ))}
                        {amenities.length > 4 ? (
                          <Badge variant="slate">+{amenities.length - 4}</Badge>
                        ) : null}
                      </div>
                    ) : null}
                  </div>

                  <div className="pt-3 border-t border-slate-100 flex items-end justify-between gap-3">
                    <div>
                      <p className="text-[11px] text-slate-400">Giá thuê niêm yết</p>
                      <p className="text-lg font-bold text-primary-600 tabular-nums">
                        {formatMoney(apt.base_rent)}
                        <span className="text-xs font-normal text-slate-500">/tháng</span>
                      </p>
                      <p className="text-[11px] text-slate-500">
                        Cọc giữ chỗ gợi ý: {formatMoney(orgPol.default_hold_amount || 2000000)}
                      </p>
                    </div>
                    <Button size="sm" onClick={() => handleOpenBookingModal(apt)}>
                      Đặt giữ chỗ Online
                    </Button>
                  </div>
                </Card>
              );
            })}
          </div>
        )}
      </main>

      {/* H3: Online Reservation Modal */}
      <Modal
        open={Boolean(selectedApt)}
        onClose={() => {
          if (!submitting) setSelectedApt(null);
        }}
        size="lg"
        title={
          selectedApt
            ? `Đặt giữ chỗ Trực tuyến — Căn ${selectedApt.code} (${selectedApt.building_name})`
            : 'Đặt giữ chỗ Trực tuyến'
        }
        subtitle={
          selectedApt
            ? `Giá thuê niêm yết: ${formatMoney(selectedApt.base_rent)}/tháng • Diện tích: ${
                selectedApt.area_m2 || 0
              } m²`
            : ''
        }
      >
        {selectedApt && bookingStep === 'done' ? (
          <div className="space-y-5 py-2">
            <div className="p-4 rounded-2xl bg-amber-50 border border-amber-200 flex items-start gap-3">
              <Clock className="w-6 h-6 text-amber-600 shrink-0 mt-0.5" />
              <div className="space-y-1">
                <p className="text-sm font-bold text-slate-900">
                  Yêu cầu giữ chỗ đang chờ Ban quản lý đối chiếu sao kê xác nhận
                </p>
                <p className="text-xs text-slate-700 leading-relaxed">
                  Biên lai chuyển khoản giữ chỗ{' '}
                  <strong>{formatMoney(submittedReservation?.hold_amount || bookingForm.hold_amount)}</strong>{' '}
                  cho căn <strong>{selectedApt.code}</strong> (giữ đến{' '}
                  <strong>{formatDate(submittedReservation?.hold_until || bookingForm.hold_until)}</strong>) đã được hệ thống tiếp nhận. Căn hộ sẽ chính thức khóa giữ phòng cho bạn ngay khi Quản lý tòa nhà xác nhận tiền đã vào tài khoản.
                </p>
              </div>
            </div>

            <div className="p-4 rounded-xl bg-slate-50 border border-slate-200 text-xs text-slate-700 space-y-1.5">
              <p>
                <strong>Số điện thoại theo dõi hồ sơ:</strong>{' '}
                <span className="font-mono">{normalizePhone(bookingForm.phone)}</span>
              </p>
              <p>
                Bạn có thể đăng nhập ngay vào <strong>Cổng cư dân bằng mã OTP</strong> để xem trạng thái phiếu giữ chỗ và bổ sung hồ sơ thuê phòng.
              </p>
            </div>

            <div className="flex flex-wrap justify-end gap-2.5">
              <Button variant="outline" onClick={() => setSelectedApt(null)}>
                Đóng cửa sổ
              </Button>
              <Button
                icon={CheckCircle2}
                onClick={() =>
                  navigate(`/login?mode=otp&phone=${encodeURIComponent(normalizePhone(bookingForm.phone))}`)
                }
              >
                Đăng nhập OTP Cổng cư dân để theo dõi
              </Button>
            </div>
          </div>
        ) : selectedApt ? (
          <form onSubmit={handleSubmitBooking} className="space-y-4">
            {/* Policy Notice */}
            <div className="p-3.5 rounded-xl bg-sky-50/80 border border-sky-200 text-xs text-sky-900 space-y-1">
              <p className="font-semibold flex items-center gap-1.5">
                <Info className="w-4 h-4 text-sky-600 shrink-0" />
                Chính sách Đặt cọc Giữ chỗ công khai của tòa nhà
              </p>
              <ul className="list-disc pl-5 space-y-0.5 text-sky-800">
                <li>
                  Thời hạn giữ chỗ trực tuyến tối đa <strong>{maxPublicDays} ngày</strong>; chuyển thẳng vào tiền cọc hợp đồng khi ký chính thức.
                </li>
                <li>
                  Báo hủy trước hạn giữ chỗ từ{' '}
                  <strong>{selectedOrgPolicy.full_refund_before_days} ngày trở lên</strong>: hoàn{' '}
                  <strong>100%</strong>; báo hủy sát hạn dưới{' '}
                  {selectedOrgPolicy.full_refund_before_days} ngày: hoàn{' '}
                  <strong>{selectedOrgPolicy.partial_refund_pct}%</strong> (làm tròn đến 1.000đ); quá hạn không ký hợp đồng: mất cọc giữ chỗ.
                </li>
                <li>
                  Căn hộ chỉ chính thức khóa giữ phòng sau khi Ban quản lý đối chiếu sao kê xác nhận tiền về tài khoản.
                </li>
              </ul>
            </div>

            {/* Payment Account & VietQR */}
            <div className="p-4 rounded-xl bg-slate-50 border border-slate-200 grid grid-cols-1 sm:grid-cols-12 gap-4 items-center">
              <div className="sm:col-span-7 space-y-1.5 text-xs">
                <p className="font-semibold text-slate-900 flex items-center gap-1.5">
                  <Landmark className="w-4 h-4 text-primary-600" />
                  Tài khoản nhận chuyển khoản giữ chỗ
                </p>
                {selectedPaymentAccount ? (
                  <>
                    <p className="text-slate-700">
                      Ngân hàng: <strong>{selectedPaymentAccount.bank_name || 'Theo tòa nhà'}</strong>
                    </p>
                    <p className="text-slate-700">
                      Số tài khoản:{' '}
                      <strong className="font-mono text-primary-700">
                        {selectedPaymentAccount.account_number || '—'}
                      </strong>
                    </p>
                    <p className="text-slate-700">
                      Chủ tài khoản: <strong>{selectedPaymentAccount.account_name || '—'}</strong>
                    </p>
                    <p className="text-slate-600">
                      Nội dung CK gợi ý: <code className="font-mono font-semibold">{transferContent}</code>
                    </p>
                  </>
                ) : (
                  <p className="text-slate-500">
                    Vui lòng chuyển khoản theo hướng dẫn của Ban quản lý tòa nhà và đính kèm ảnh chụp biên lai UNC bên dưới.
                  </p>
                )}
              </div>
              {qrImgUrl ? (
                <div className="sm:col-span-5 flex justify-center">
                  <img
                    src={qrImgUrl}
                    alt="Mã VietQR chuyển khoản giữ chỗ"
                    className="w-36 h-36 object-contain rounded-xl border border-slate-200 bg-white p-1.5"
                  />
                </div>
              ) : null}
            </div>

            {/* Prospect & Shared OTP Verification */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
              <Input
                label="Họ và tên người đặt giữ chỗ"
                required
                placeholder="Nguyễn Văn A"
                value={bookingForm.prospect_name}
                onChange={(e) =>
                  setBookingForm((p) => ({ ...p, prospect_name: e.target.value }))
                }
              />
              <div className="space-y-1.5">
                <Input
                  label="Số điện thoại xác thực OTP"
                  required
                  icon={Phone}
                  placeholder="0912345678"
                  value={bookingForm.phone}
                  onChange={(e) => setBookingForm((p) => ({ ...p, phone: e.target.value }))}
                  rightElement={
                    <button
                      type="button"
                      disabled={otpSending || otpCountdown > 0}
                      onClick={handleSendOtp}
                      className="text-xs font-semibold text-primary-600 hover:text-primary-700 disabled:text-slate-400 whitespace-nowrap pr-1"
                    >
                      {otpCountdown > 0 ? `${otpCountdown}s` : otpSent ? 'Gửi lại OTP' : 'Gửi mã OTP'}
                    </button>
                  }
                />
              </div>
            </div>

            {devOtpHint ? (
              <div className="px-3 py-2 rounded-xl bg-amber-50 border border-amber-200 text-xs text-amber-900">
                [Dev Mode] Mã OTP xác thực SĐT của bạn: <strong>{devOtpHint}</strong>
              </div>
            ) : null}

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3.5">
              <Input
                label="Mã xác thực OTP (6 số)"
                required
                icon={KeyRound}
                maxLength={6}
                placeholder="Nhập 6 số OTP"
                value={bookingForm.otp}
                onChange={(e) => setBookingForm((p) => ({ ...p, otp: e.target.value }))}
              />
              <MoneyInput
                label="Số tiền chuyển giữ chỗ (VND)"
                required
                value={bookingForm.hold_amount}
                onChange={(e) =>
                  setBookingForm((p) => ({ ...p, hold_amount: e.target.value }))
                }
              />
              <Input
                label={`Giữ đến ngày (tối đa ${maxPublicDays} ngày)`}
                type="date"
                required
                min={addDaysStr(todayStr, 1)}
                max={addDaysStr(todayStr, maxPublicDays)}
                value={bookingForm.hold_until}
                onChange={(e) =>
                  setBookingForm((p) => ({ ...p, hold_until: e.target.value }))
                }
              />
            </div>

            <FileUpload
              label="Ảnh chụp biên lai chuyển khoản ngân hàng — UNC (bắt buộc ≥ 1 ảnh)"
              multiple
              maxFiles={3}
              value={bookingForm.evidence}
              onChange={(vals) => setBookingForm((p) => ({ ...p, evidence: vals }))}
            />

            <Input
              label="Ghi chú thêm cho Ban quản lý (tùy chọn)"
              multiline
              rows={2}
              placeholder="VD: Dự kiến dọn vào cuối tuần này..."
              value={bookingForm.note}
              onChange={(e) => setBookingForm((p) => ({ ...p, note: e.target.value }))}
            />

            <label className="flex items-start gap-2.5 p-3 rounded-xl bg-slate-50 border border-slate-200 cursor-pointer text-xs text-slate-700">
              <input
                type="checkbox"
                checked={Boolean(bookingForm.privacy_consent)}
                onChange={(e) =>
                  setBookingForm((p) => ({ ...p, privacy_consent: e.target.checked }))
                }
                className="mt-0.5 rounded border-slate-300 text-primary-600 focus:ring-primary-500"
              />
              <span>
                Tôi xác nhận thông tin kê khai là chính xác và <strong>đồng ý cho phép xử lý dữ liệu cá nhân</strong> phục vụ thủ tục giữ chỗ, đối soát thanh toán và lập hợp đồng thuê theo Nghị định 13/2023/NĐ-CP (PRD 17.1).
              </span>
            </label>

            <div className="flex justify-end gap-2.5 pt-2">
              <Button
                variant="outline"
                disabled={submitting}
                onClick={() => setSelectedApt(null)}
              >
                Hủy
              </Button>
              <Button type="submit" icon={ShieldCheck} loading={submitting}>
                Gửi yêu cầu giữ chỗ &amp; Biên lai UNC
              </Button>
            </div>
          </form>
        ) : null}
      </Modal>
    </div>
  );
}

export default PublicExplorePage;
