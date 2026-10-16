import React, { useEffect, useState } from 'react';
import {
  Building2,
  Home,
  Key,
  Search,
  Calendar,
  CreditCard,
  ShieldCheck,
  PhoneCall,
  UserCheck,
  CheckCircle2,
  AlertTriangle,
  Clock,
  Sparkles,
  Wrench,
  Car,
  FileText,
  Send,
  X,
  MapPin,
  Maximize2,
  Bed,
  Wifi,
  Wind,
  Droplets,
  HelpCircle,
  ChevronRight,
} from 'lucide-react';
import api from '../../services/api';
import { useAuthStore } from '../../stores/authStore';

export default function ResidentPortalPage() {
  const { user } = useAuthStore();

  const [isLoading, setIsLoading] = useState(true);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  // Modals
  const [showApplicationModal, setShowApplicationModal] = useState(false);
  const [showServiceModal, setShowServiceModal] = useState(false);
  const [showContactModal, setShowContactModal] = useState(false);
  const [selectedAptForContact, setSelectedAptForContact] = useState(null);

  // Form states
  const [applicationForm, setApplicationForm] = useState({
    full_name: user?.name || user?.full_name || '',
    id_number: '',
    dob: '',
    desired_apartment_id: '',
    note: '',
  });
  const [isSubmittingApp, setIsSubmittingApp] = useState(false);
  const [appSuccessMessage, setAppSuccessMessage] = useState('');

  // Service Request form
  const [serviceForm, setServiceForm] = useState({
    title: '',
    description: '',
    urgency: 'NORMAL',
  });
  const [isSubmittingService, setIsSubmittingService] = useState(false);
  const [serviceSuccessMessage, setServiceSuccessMessage] = useState('');

  // Fetch overview data
  const fetchOverview = async () => {
    setIsLoading(true);
    setError('');
    try {
      const res = await api.get('/api/v1/resident/overview');
      setData(res.data.data);
      if (res.data.data?.user?.full_name) {
        setApplicationForm((prev) => ({
          ...prev,
          full_name: res.data.data.user.full_name,
          id_number: res.data.data.user.id_number || '',
        }));
      }
    } catch (err) {
      console.error('Lỗi tải dữ liệu cổng cư dân:', err);
      setError('Không thể kết nối đến máy chủ. Vui lòng thử lại sau.');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchOverview();
  }, []);

  const formatVND = (amount) => {
    if (!amount) return '0 ₫';
    return Number(amount).toLocaleString('vi-VN') + ' ₫';
  };

  const formatDate = (dateStr) => {
    if (!dateStr) return '—';
    try {
      const d = new Date(dateStr);
      return d.toLocaleDateString('vi-VN');
    } catch {
      return dateStr;
    }
  };

  // Submit Rental Application (FR-012)
  const handleSubmitApplication = async (e) => {
    e.preventDefault();
    setIsSubmittingApp(true);
    setAppSuccessMessage('');
    try {
      const res = await api.post('/api/v1/resident/rental-application', applicationForm);
      setAppSuccessMessage(res.data.message || 'Hồ sơ đã được gửi thành công!');
      setTimeout(() => {
        setShowApplicationModal(false);
        fetchOverview();
      }, 1800);
    } catch (err) {
      alert(err.response?.data?.message || 'Có lỗi xảy ra khi nộp hồ sơ.');
    } finally {
      setIsSubmittingApp(false);
    }
  };

  // Submit Service Request (FR-042)
  const handleSubmitServiceRequest = async (e) => {
    e.preventDefault();
    setIsSubmittingService(true);
    setServiceSuccessMessage('');
    try {
      const res = await api.post('/api/v1/resident/service-requests', {
        ...serviceForm,
        apartment_id: data?.contract?.apartment_id,
      });
      setServiceSuccessMessage(res.data.message || 'Yêu cầu hỗ trợ đã được gửi.');
      setTimeout(() => {
        setShowServiceModal(false);
        setServiceForm({ title: '', description: '', urgency: 'NORMAL' });
        setServiceSuccessMessage('');
      }, 1800);
    } catch (err) {
      alert(err.response?.data?.message || 'Lỗi gửi yêu cầu hỗ trợ.');
    } finally {
      setIsSubmittingService(false);
    }
  };

  if (isLoading) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] space-y-4">
        <div className="w-12 h-12 border-4 border-indigo-200 border-t-indigo-600 rounded-full animate-spin"></div>
        <p className="text-sm font-medium text-slate-500">Đang tải thông tin Cổng Cư Dân...</p>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="p-8 text-center bg-white rounded-2xl border border-red-200 shadow-sm max-w-xl mx-auto my-12">
        <AlertTriangle className="w-12 h-12 text-red-500 mx-auto mb-3" />
        <h3 className="text-lg font-bold text-slate-800">Không thể tải cổng cư dân</h3>
        <p className="text-sm text-slate-600 mt-1 mb-4">{error || 'Có lỗi khi lấy dữ liệu tài khoản.'}</p>
        <button
          onClick={fetchOverview}
          className="px-4 py-2 bg-indigo-600 text-white rounded-xl text-sm font-medium hover:bg-indigo-700"
        >
          Thử lại
        </button>
      </div>
    );
  }

  const { has_contract, contract, reservation, pending_application, available_apartments, manager_contact } = data;
  const residentName = data.user?.full_name || user?.name || 'Cư dân';
  const residentPhone = data.user?.phone || user?.phone || '';

  return (
    <div className="space-y-6 sm:space-y-8 animate-fadeIn">
      {/* ========================================================================= */}
      {/* TRƯỜNG HỢP 1: CƯ DÂN ĐÃ KÝ HỢP ĐỒNG (CONTRACTED RESIDENT)                 */}
      {/* ========================================================================= */}
      {has_contract && contract ? (
        <div className="space-y-6">
          {/* Hero Banner Căn hộ đang thuê */}
          <div className="relative overflow-hidden rounded-3xl bg-gradient-to-r from-slate-900 via-indigo-950 to-indigo-900 text-white p-6 sm:p-8 shadow-xl">
            <div className="absolute right-0 top-0 bottom-0 w-1/3 bg-[radial-gradient(circle_at_center,_var(--tw-gradient-stops))] from-indigo-500/10 via-transparent to-transparent pointer-events-none"></div>

            <div className="relative z-10 flex flex-col md:flex-row md:items-center justify-between gap-6">
              <div className="space-y-2">
                <div className="flex items-center space-x-2.5">
                  <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 mr-1.5 animate-pulse"></span>
                    Đang Cư Trú
                  </span>
                  <span className="text-xs text-indigo-200/80 font-mono">
                    HĐ: #{contract.contract_id?.slice(0, 8).toUpperCase()}
                  </span>
                </div>

                <h1 className="text-2xl sm:text-3xl font-extrabold tracking-tight">
                  Căn hộ {contract.apartment_code} — {contract.building_name}
                </h1>
                <p className="text-sm text-indigo-200/90 flex items-center space-x-1.5">
                  <MapPin className="w-4 h-4 text-indigo-400 flex-shrink-0" />
                  <span>{contract.building_address}</span>
                  {contract.floor_name && <span>• {contract.floor_name}</span>}
                </p>
              </div>

              {/* Quick Contact Button */}
              <div className="flex items-center gap-3">
                <button
                  id="btn-resident-call-bql"
                  onClick={() => setShowContactModal(true)}
                  className="px-4 py-2.5 rounded-xl bg-white/10 hover:bg-white/20 backdrop-blur-sm text-white text-xs font-semibold transition-all border border-white/20 flex items-center space-x-2"
                >
                  <PhoneCall className="w-4 h-4 text-emerald-400" />
                  <span>Liên hệ BQL Tòa nhà</span>
                </button>
                <button
                  id="btn-resident-report-issue"
                  onClick={() => setShowServiceModal(true)}
                  className="px-4 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold shadow-lg shadow-indigo-600/30 transition-all flex items-center space-x-2"
                >
                  <Wrench className="w-4 h-4" />
                  <span>Báo hỏng / Sự cố</span>
                </button>
              </div>
            </div>
          </div>

          {/* 4 Stat Cards */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="bg-white p-5 rounded-2xl border border-slate-200/80 shadow-sm flex flex-col justify-between">
              <span className="text-xs font-semibold text-slate-500">Tiền thuê hàng tháng</span>
              <div className="mt-2">
                <span className="text-2xl font-bold text-slate-900">{formatVND(contract.rent_amount)}</span>
                <span className="text-xs text-slate-400 block mt-0.5">Kỳ hạn theo tháng</span>
              </div>
            </div>

            <div className="bg-white p-5 rounded-2xl border border-slate-200/80 shadow-sm flex flex-col justify-between">
              <span className="text-xs font-semibold text-slate-500">Tiền cọc an toàn đang giữ</span>
              <div className="mt-2">
                <span className="text-2xl font-bold text-indigo-600">
                  {formatVND(contract.deposit_held_amount || contract.deposit_amount)}
                </span>
                <span className="text-xs text-emerald-600 font-medium block mt-0.5">
                  ✓ Trạng thái: {contract.deposit_status || 'HELD'} (Đang bảo lưu)
                </span>
              </div>
            </div>

            <div className="bg-white p-5 rounded-2xl border border-slate-200/80 shadow-sm flex flex-col justify-between">
              <span className="text-xs font-semibold text-slate-500">Ngày thu tiền định kỳ</span>
              <div className="mt-2">
                <span className="text-2xl font-bold text-slate-900">
                  Ngày {contract.billing_day || 5} hàng tháng
                </span>
                <span className="text-xs text-slate-400 block mt-0.5">Hạn thanh toán 5 ngày</span>
              </div>
            </div>

            <div className="bg-white p-5 rounded-2xl border border-slate-200/80 shadow-sm flex flex-col justify-between">
              <span className="text-xs font-semibold text-slate-500">Thời hạn hợp đồng</span>
              <div className="mt-2">
                <span className="text-sm font-bold text-slate-900 block">
                  {formatDate(contract.start_date)} ➔ {formatDate(contract.end_date)}
                </span>
                <span className="text-xs text-indigo-600 font-medium block mt-1">
                  Đang trong thời hạn thuê hợp lệ
                </span>
              </div>
            </div>
          </div>

          {/* Chi tiết căn hộ & Tiện ích */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <div className="lg:col-span-2 bg-white rounded-2xl border border-slate-200/80 p-6 shadow-sm space-y-4">
              <h2 className="text-base font-bold text-slate-900 flex items-center space-x-2">
                <Home className="w-5 h-5 text-indigo-600" />
                <span>Thông tin & Tiện nghi căn hộ</span>
              </h2>

              <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 pt-2">
                <div className="p-3.5 rounded-xl bg-slate-50 border border-slate-100">
                  <span className="text-xs text-slate-500 block">Diện tích sàn</span>
                  <span className="text-base font-bold text-slate-800">{contract.area_m2 || 45} m²</span>
                </div>
                <div className="p-3.5 rounded-xl bg-slate-50 border border-slate-100">
                  <span className="text-xs text-slate-500 block">Phòng ngủ</span>
                  <span className="text-base font-bold text-slate-800">{contract.bedrooms || 1} PN</span>
                </div>
                <div className="p-3.5 rounded-xl bg-slate-50 border border-slate-100">
                  <span className="text-xs text-slate-500 block">Loại căn</span>
                  <span className="text-base font-bold text-slate-800">{contract.apartment_type || 'Căn hộ tiêu chuẩn'}</span>
                </div>
              </div>

              {/* Tiện nghi */}
              <div className="pt-2">
                <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider block mb-2.5">
                  Trang thiết bị bàn giao theo căn
                </span>
                <div className="flex flex-wrap gap-2">
                  <span className="inline-flex items-center px-3 py-1.5 rounded-lg text-xs font-medium bg-indigo-50 text-indigo-700 border border-indigo-100">
                    <Wifi className="w-3.5 h-3.5 mr-1.5" /> Wifi tốc độ cao
                  </span>
                  <span className="inline-flex items-center px-3 py-1.5 rounded-lg text-xs font-medium bg-indigo-50 text-indigo-700 border border-indigo-100">
                    <Wind className="w-3.5 h-3.5 mr-1.5" /> Điều hòa nhiệt độ
                  </span>
                  <span className="inline-flex items-center px-3 py-1.5 rounded-lg text-xs font-medium bg-indigo-50 text-indigo-700 border border-indigo-100">
                    <Droplets className="w-3.5 h-3.5 mr-1.5" /> Nước nóng lạnh
                  </span>
                  <span className="inline-flex items-center px-3 py-1.5 rounded-lg text-xs font-medium bg-indigo-50 text-indigo-700 border border-indigo-100">
                    <ShieldCheck className="w-3.5 h-3.5 mr-1.5" /> Khóa cửa thẻ từ / vân tay
                  </span>
                </div>
              </div>
            </div>

            {/* Cột tác vụ cư dân nhanh */}
            <div className="bg-white rounded-2xl border border-slate-200/80 p-6 shadow-sm flex flex-col justify-between space-y-4">
              <div>
                <h2 className="text-base font-bold text-slate-900 mb-1">Dịch vụ cư dân</h2>
                <p className="text-xs text-slate-500">Các tiện ích hỗ trợ bạn trong suốt thời gian thuê nhà.</p>
              </div>

              <div className="space-y-2.5">
                <button
                  id="btn-action-report-issue"
                  onClick={() => setShowServiceModal(true)}
                  className="w-full text-left p-3 rounded-xl border border-slate-200 hover:border-indigo-300 hover:bg-indigo-50/50 transition-all flex items-center justify-between group"
                >
                  <div className="flex items-center space-x-3">
                    <div className="w-8 h-8 rounded-lg bg-amber-50 text-amber-600 flex items-center justify-center">
                      <Wrench className="w-4 h-4" />
                    </div>
                    <div>
                      <span className="text-xs font-bold text-slate-800 block">Báo hỏng / Sửa chữa</span>
                      <span className="text-[11px] text-slate-500">Điện, nước, thiết bị hư hỏng</span>
                    </div>
                  </div>
                  <ChevronRight className="w-4 h-4 text-slate-400 group-hover:text-indigo-600 transition-colors" />
                </button>

                <button
                  id="btn-action-contact-bql"
                  onClick={() => setShowContactModal(true)}
                  className="w-full text-left p-3 rounded-xl border border-slate-200 hover:border-indigo-300 hover:bg-indigo-50/50 transition-all flex items-center justify-between group"
                >
                  <div className="flex items-center space-x-3">
                    <div className="w-8 h-8 rounded-lg bg-indigo-50 text-indigo-600 flex items-center justify-center">
                      <PhoneCall className="w-4 h-4" />
                    </div>
                    <div>
                      <span className="text-xs font-bold text-slate-800 block">Liên hệ Ban Quản Lý</span>
                      <span className="text-[11px] text-slate-500">Hotline BQL, tiếp nhận thắc mắc</span>
                    </div>
                  </div>
                  <ChevronRight className="w-4 h-4 text-slate-400 group-hover:text-indigo-600 transition-colors" />
                </button>

                <div className="p-3.5 rounded-xl bg-slate-50 border border-slate-100 text-xs text-slate-600 space-y-1">
                  <div className="font-semibold text-slate-800 flex items-center space-x-1.5">
                    <PhoneCall className="w-3.5 h-3.5 text-emerald-600" />
                    <span>Quản lý phụ trách:</span>
                  </div>
                  <p>{manager_contact?.full_name || 'BQL Tòa nhà'} — <span className="font-mono font-semibold text-indigo-600">{manager_contact?.phone || '0901.234.567'}</span></p>
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : (
        /* ========================================================================= */
        /* TRƯỜNG HỢP 2: CƯ DÂN CHƯA KÝ HỢP ĐỒNG (UNCONTRACTED / PROSPECT RESIDENT)    */
        /* ========================================================================= */
        <div className="space-y-6 sm:space-y-8">
          {/* Hero Banner Chào mừng Onboarding */}
          <div className="relative overflow-hidden rounded-3xl bg-gradient-to-r from-slate-900 via-indigo-950 to-indigo-900 text-white p-6 sm:p-10 shadow-xl">
            <div className="relative z-10 max-w-2xl space-y-3">
              <div className="flex items-center space-x-2">
                <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold bg-amber-400/20 text-amber-300 border border-amber-400/30">
                  <Sparkles className="w-3 h-3 mr-1" />
                  Khách Thuê Mới
                </span>
                <span className="text-xs text-indigo-200/70 font-mono">
                  SĐT: {residentPhone || 'Chưa cập nhật'}
                </span>
              </div>

              <h1 className="text-2xl sm:text-4xl font-extrabold tracking-tight leading-tight">
                Xin chào, {residentName}! 👋
              </h1>
              <p className="text-sm sm:text-base text-indigo-200/90 leading-relaxed">
                Chào mừng bạn đến với Cổng Dịch vụ Cư Dân ResiHub. Tài khoản của bạn hiện chưa liên kết với hợp đồng thuê căn hộ nào.
              </p>
            </div>
          </div>

          {/* BANNER NỔI BẬT: NẾU ĐÃ ĐẶT CỌC GIỮ CHỖ (NV-06) */}
          {reservation && reservation.reservation_status === 'HELD' && (
            <div
              id="banner-held-reservation"
              className="rounded-3xl border-2 border-amber-400 bg-gradient-to-br from-amber-50 via-orange-50 to-amber-100/60 p-6 sm:p-8 shadow-md"
            >
              <div className="flex flex-col md:flex-row md:items-center justify-between gap-6">
                <div className="space-y-2">
                  <div className="flex items-center space-x-2">
                    <span className="px-2.5 py-0.5 rounded-full text-xs font-bold bg-amber-500 text-white uppercase tracking-wider">
                      Đang Giữ Chỗ Căn Hộ
                    </span>
                    <span className="text-xs text-amber-800 font-medium">
                      Thời hạn giữ chỗ đến: <strong>{formatDate(reservation.hold_until)}</strong>
                    </span>
                  </div>

                  <h3 className="text-xl sm:text-2xl font-bold text-slate-900">
                    Căn hộ {reservation.apartment_code} — {reservation.building_name}
                  </h3>
                  <p className="text-xs sm:text-sm text-slate-700">
                    Địa chỉ: {reservation.building_address}
                  </p>
                  <p className="text-xs sm:text-sm text-slate-700">
                    Tiền cọc giữ chỗ đã nộp: <strong className="text-indigo-700 font-mono text-base">{formatVND(reservation.hold_amount)}</strong>
                  </p>
                  {reservation.reservation_note && (
                    <p className="text-xs text-slate-500 italic">
                      Ghi chú: "{reservation.reservation_note}"
                    </p>
                  )}
                </div>

                <div className="flex flex-col sm:flex-row gap-3">
                  <a
                    href={`tel:${reservation.manager_phone || '0901234567'}`}
                    className="px-5 py-3 rounded-xl bg-amber-500 hover:bg-amber-600 text-white text-xs font-bold transition-all shadow-md shadow-amber-500/20 flex items-center justify-center space-x-2"
                  >
                    <PhoneCall className="w-4 h-4" />
                    <span>Gọi BQL ký HĐ ({reservation.manager_phone || '0901.234.567'})</span>
                  </a>
                </div>
              </div>
            </div>
          )}

          {/* BANNER NẾU ĐÃ NỘP HỒ SƠ CHỜ DUYỆT (FR-012) */}
          {pending_application && (
            <div className="rounded-2xl border border-blue-200 bg-blue-50/80 p-5 flex items-start space-x-3.5">
              <Clock className="w-5 h-5 text-blue-600 flex-shrink-0 mt-0.5" />
              <div>
                <h4 className="text-sm font-bold text-blue-900">
                  Hồ sơ nhận nhà của bạn đang chờ Ban Quản Lý phê duyệt
                </h4>
                <p className="text-xs text-blue-700 mt-0.5">
                  Bạn đã gửi thông tin cư dân thành công vào ngày {formatDate(pending_application.created_at)}. Ban Quản Lý sẽ xác minh CCCD và kích hoạt hợp đồng thuê cho bạn trong thời gian sớm nhất.
                </p>
              </div>
            </div>
          )}

          {/* 2 Khối Hành Động Chính (Next Steps) */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {/* Card 1: Khai báo hồ sơ CCCD nhận nhà */}
            <div className="bg-white rounded-3xl border border-slate-200 p-6 sm:p-8 shadow-sm hover:shadow-md transition-all flex flex-col justify-between space-y-6">
              <div className="space-y-3">
                <div className="w-12 h-12 rounded-2xl bg-indigo-50 text-indigo-600 flex items-center justify-center">
                  <Key className="w-6 h-6" />
                </div>
                <h3 className="text-lg font-bold text-slate-900">
                  Bạn đã thuê căn hộ ngoài đời thực?
                </h3>
                <p className="text-xs sm:text-sm text-slate-600 leading-relaxed">
                  Nếu bạn đã gặp BQL hoặc Chủ nhà để thống nhất thuê phòng, hãy cung cấp thông tin CCCD/CMND để BQL liên kết căn hộ và kích hoạt đầy đủ quyền cư dân.
                </p>
              </div>

              <div>
                <button
                  id="btn-open-application-modal"
                  onClick={() => setShowApplicationModal(true)}
                  className="w-full py-3 px-4 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-xs sm:text-sm font-semibold transition-all shadow-md shadow-indigo-600/20 flex items-center justify-center space-x-2"
                >
                  <UserCheck className="w-4 h-4" />
                  <span>Khai báo thông tin nhận nhà</span>
                </button>
              </div>
            </div>

            {/* Card 2: Khám phá căn hộ trống */}
            <div className="bg-white rounded-3xl border border-slate-200 p-6 sm:p-8 shadow-sm hover:shadow-md transition-all flex flex-col justify-between space-y-6">
              <div className="space-y-3">
                <div className="w-12 h-12 rounded-2xl bg-emerald-50 text-emerald-600 flex items-center justify-center">
                  <Search className="w-6 h-6" />
                </div>
                <h3 className="text-lg font-bold text-slate-900">
                  Đang tìm thuê căn hộ mới?
                </h3>
                <p className="text-xs sm:text-sm text-slate-600 leading-relaxed">
                  Khám phá danh sách các căn hộ đang sẵn sàng cho thuê tại hệ thống ResiHub với đầy đủ thông tin diện tích, tiện ích và giá niêm yết rõ ràng.
                </p>
              </div>

              <div>
                <a
                  href="#available-units-section"
                  className="w-full py-3 px-4 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-800 text-xs sm:text-sm font-semibold transition-all flex items-center justify-center space-x-2"
                >
                  <Building2 className="w-4 h-4 text-slate-600" />
                  <span>Xem danh sách căn hộ trống bên dưới</span>
                </a>
              </div>
            </div>
          </div>

          {/* DANH SÁCH CĂN HỘ TRỐNG ĐANG CHO THUÊ (AVAILABLE UNITS) */}
          <div id="available-units-section" className="space-y-4 pt-4">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-xl font-bold text-slate-900 flex items-center space-x-2">
                  <Building2 className="w-5 h-5 text-indigo-600" />
                  <span>Căn hộ đang sẵn sàng cho thuê ({available_apartments?.length || 0} căn)</span>
                </h2>
                <p className="text-xs text-slate-500">Cập nhật thời gian thực từ hệ thống quản trị ResiHub.</p>
              </div>
            </div>

            {available_apartments && available_apartments.length > 0 ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 sm:gap-6">
                {available_apartments.map((apt) => (
                  <div
                    key={apt.id}
                    className="bg-white rounded-2xl border border-slate-200 hover:border-indigo-300 p-5 shadow-sm hover:shadow-md transition-all flex flex-col justify-between"
                  >
                    <div className="space-y-3">
                      <div className="flex items-center justify-between">
                        <span className="text-base font-bold text-slate-900 bg-slate-100 px-2.5 py-1 rounded-lg">
                          Căn {apt.code}
                        </span>
                        <span className="text-[11px] font-semibold text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded-full border border-emerald-200">
                          Sẵn sàng dọn vào
                        </span>
                      </div>

                      <div>
                        <h4 className="text-xs font-semibold text-slate-800 line-clamp-1">{apt.building_name}</h4>
                        <p className="text-[11px] text-slate-500 line-clamp-1">{apt.building_address}</p>
                      </div>

                      <div className="flex items-center space-x-3 text-xs text-slate-600 py-1 border-y border-slate-100">
                        <span className="flex items-center space-x-1">
                          <Maximize2 className="w-3.5 h-3.5 text-slate-400" />
                          <span>{apt.area_m2} m²</span>
                        </span>
                        <span>•</span>
                        <span className="flex items-center space-x-1">
                          <Bed className="w-3.5 h-3.5 text-slate-400" />
                          <span>{apt.bedrooms || 1} PN</span>
                        </span>
                      </div>

                      <div>
                        <span className="text-xs text-slate-400 block">Giá thuê niêm yết:</span>
                        <span className="text-base font-bold text-indigo-600">{formatVND(apt.base_rent)} / tháng</span>
                      </div>
                    </div>

                    <div className="pt-4 mt-2">
                      <button
                        onClick={() => {
                          setSelectedAptForContact(apt);
                          setShowContactModal(true);
                        }}
                        className="w-full py-2 px-3 rounded-xl bg-slate-50 hover:bg-indigo-50 text-indigo-700 text-xs font-semibold border border-indigo-200/80 transition-colors flex items-center justify-center space-x-1.5"
                      >
                        <PhoneCall className="w-3.5 h-3.5" />
                        <span>Liên hệ xem căn này</span>
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="p-8 text-center bg-white rounded-2xl border border-slate-200 text-slate-500 text-sm">
                Hiện tại tất cả các căn hộ đang được lấp đầy. Vui lòng liên hệ BQL để đăng ký danh sách chờ.
              </div>
            )}
          </div>

          {/* QUY TRÌNH 3 BƯỚC THUÊ NHÀ DỄ DÀNG */}
          <div className="bg-white rounded-3xl border border-slate-200 p-6 sm:p-8 shadow-sm">
            <h3 className="text-base font-bold text-slate-900 mb-6 text-center">
              Quy trình thuê căn hộ nhanh chóng tại ResiHub
            </h3>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-6 relative">
              <div className="flex flex-col items-center text-center space-y-2 p-4 rounded-2xl bg-slate-50">
                <div className="w-10 h-10 rounded-full bg-indigo-600 text-white font-bold flex items-center justify-center text-sm shadow-md shadow-indigo-600/20">
                  1
                </div>
                <h4 className="text-sm font-bold text-slate-800">Chọn phòng & Đặt cọc</h4>
                <p className="text-xs text-slate-500">
                  Xem phòng trực tiếp cùng BQL và đặt cọc giữ chỗ (NV-06) để bảo lưu căn hộ bạn ưng ý.
                </p>
              </div>

              <div className="flex flex-col items-center text-center space-y-2 p-4 rounded-2xl bg-slate-50">
                <div className="w-10 h-10 rounded-full bg-indigo-600 text-white font-bold flex items-center justify-center text-sm shadow-md shadow-indigo-600/20">
                  2
                </div>
                <h4 className="text-sm font-bold text-slate-800">Khai báo CCCD & Ký HĐ</h4>
                <p className="text-xs text-slate-500">
                  Khai báo hồ sơ cư dân (FR-012) và ký hợp đồng thuê điện tử minh bạch điều khoản.
                </p>
              </div>

              <div className="flex flex-col items-center text-center space-y-2 p-4 rounded-2xl bg-slate-50">
                <div className="w-10 h-10 rounded-full bg-emerald-600 text-white font-bold flex items-center justify-center text-sm shadow-md shadow-emerald-600/20">
                  3
                </div>
                <h4 className="text-sm font-bold text-slate-800">Nhận phòng & Bàn giao</h4>
                <p className="text-xs text-slate-500">
                  Nhận chìa khóa/mã cửa, bàn giao tài sản và kích hoạt toàn quyền trên Cổng Cư Dân.
                </p>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* MODAL 1: KHAI BÁO HỒ SƠ CƯ DÂN NHẬN NHÀ (FR-012)                          */}
      {/* ========================================================================= */}
      {showApplicationModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 backdrop-blur-sm p-4 overflow-y-auto">
          <div className="bg-white rounded-3xl max-w-lg w-full p-6 sm:p-8 shadow-2xl border border-slate-100 animate-scaleUp">
            <div className="flex items-center justify-between pb-4 border-b border-slate-100">
              <div className="flex items-center space-x-2.5">
                <div className="w-9 h-9 rounded-xl bg-indigo-50 text-indigo-600 flex items-center justify-center">
                  <UserCheck className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-base font-bold text-slate-900">Khai báo thông tin nhận nhà</h3>
                  <p className="text-xs text-slate-500">Gửi thông tin để Ban Quản Lý tạo hợp đồng thuê</p>
                </div>
              </div>
              <button
                onClick={() => setShowApplicationModal(false)}
                className="p-1 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-100"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {appSuccessMessage ? (
              <div className="py-8 text-center space-y-3">
                <CheckCircle2 className="w-12 h-12 text-emerald-500 mx-auto animate-bounce" />
                <h4 className="text-base font-bold text-slate-800">Gửi hồ sơ thành công!</h4>
                <p className="text-xs text-slate-600">{appSuccessMessage}</p>
              </div>
            ) : (
              <form onSubmit={handleSubmitApplication} className="space-y-4 pt-4">
                <div>
                  <label className="text-xs font-semibold text-slate-700 block mb-1">
                    Họ và tên cư dân <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="text"
                    required
                    value={applicationForm.full_name}
                    onChange={(e) => setApplicationForm({ ...applicationForm, full_name: e.target.value })}
                    className="w-full px-3.5 py-2.5 text-xs rounded-xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    placeholder="Nguyễn Văn A"
                  />
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="text-xs font-semibold text-slate-700 block mb-1">
                      Số CCCD / CMND <span className="text-red-500">*</span>
                    </label>
                    <input
                      type="text"
                      required
                      value={applicationForm.id_number}
                      onChange={(e) => setApplicationForm({ ...applicationForm, id_number: e.target.value })}
                      className="w-full px-3.5 py-2.5 text-xs rounded-xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                      placeholder="001099xxxxxx"
                    />
                  </div>

                  <div>
                    <label className="text-xs font-semibold text-slate-700 block mb-1">Ngày sinh</label>
                    <input
                      type="date"
                      value={applicationForm.dob}
                      onChange={(e) => setApplicationForm({ ...applicationForm, dob: e.target.value })}
                      className="w-full px-3.5 py-2.5 text-xs rounded-xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    />
                  </div>
                </div>

                <div>
                  <label className="text-xs font-semibold text-slate-700 block mb-1">
                    Căn hộ dự kiến thuê (nếu biết)
                  </label>
                  <select
                    value={applicationForm.desired_apartment_id}
                    onChange={(e) => setApplicationForm({ ...applicationForm, desired_apartment_id: e.target.value })}
                    className="w-full px-3.5 py-2.5 text-xs rounded-xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-indigo-500 bg-white"
                  >
                    <option value="">-- Chọn căn hộ (tùy chọn) --</option>
                    {available_apartments?.map((a) => (
                      <option key={a.id} value={a.id}>
                        Căn {a.code} — {a.building_name} ({formatVND(a.base_rent)}/tháng)
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="text-xs font-semibold text-slate-700 block mb-1">Ghi chú cho BQL</label>
                  <textarea
                    rows={2}
                    value={applicationForm.note}
                    onChange={(e) => setApplicationForm({ ...applicationForm, note: e.target.value })}
                    className="w-full px-3.5 py-2 text-xs rounded-xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    placeholder="Ví dụ: Em đã chuyển cọc giữ chỗ qua tài khoản, hẹn thứ 7 dọn vào..."
                  />
                </div>

                <div className="pt-2 flex items-center justify-end space-x-3">
                  <button
                    type="button"
                    onClick={() => setShowApplicationModal(false)}
                    className="px-4 py-2.5 text-xs font-semibold text-slate-600 hover:bg-slate-100 rounded-xl"
                  >
                    Hủy
                  </button>
                  <button
                    type="submit"
                    disabled={isSubmittingApp}
                    className="px-5 py-2.5 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-700 rounded-xl shadow-md shadow-indigo-600/20 disabled:opacity-50"
                  >
                    {isSubmittingApp ? 'Đang gửi...' : 'Gửi thông tin nhận nhà'}
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* MODAL 2: BÁO HỎNG / SỰ CỐ DỊCH VỤ (FR-042)                                 */}
      {/* ========================================================================= */}
      {showServiceModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 backdrop-blur-sm p-4">
          <div className="bg-white rounded-3xl max-w-md w-full p-6 shadow-2xl border border-slate-100 animate-scaleUp">
            <div className="flex items-center justify-between pb-3 border-b border-slate-100">
              <div className="flex items-center space-x-2">
                <Wrench className="w-5 h-5 text-indigo-600" />
                <h3 className="text-base font-bold text-slate-900">Báo hỏng / Yêu cầu sửa chữa</h3>
              </div>
              <button
                onClick={() => setShowServiceModal(false)}
                className="p-1 rounded-lg text-slate-400 hover:text-slate-600"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {serviceSuccessMessage ? (
              <div className="py-6 text-center space-y-2">
                <CheckCircle2 className="w-10 h-10 text-emerald-500 mx-auto" />
                <h4 className="text-sm font-bold text-slate-800">Đã tiếp nhận yêu cầu!</h4>
                <p className="text-xs text-slate-600">{serviceSuccessMessage}</p>
              </div>
            ) : (
              <form onSubmit={handleSubmitServiceRequest} className="space-y-3.5 pt-3">
                <div>
                  <label className="text-xs font-semibold text-slate-700 block mb-1">
                    Vấn đề gặp phải <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="text"
                    required
                    value={serviceForm.title}
                    onChange={(e) => setServiceForm({ ...serviceForm, title: e.target.value })}
                    className="w-full px-3 py-2 text-xs rounded-xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    placeholder="VD: Điều hòa phòng khách chảy nước, hỏng vòi sen"
                  />
                </div>

                <div>
                  <label className="text-xs font-semibold text-slate-700 block mb-1">
                    Mức độ khẩn cấp
                  </label>
                  <select
                    value={serviceForm.urgency}
                    onChange={(e) => setServiceForm({ ...serviceForm, urgency: e.target.value })}
                    className="w-full px-3 py-2 text-xs rounded-xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-indigo-500 bg-white"
                  >
                    <option value="NORMAL">Bình thường (xử lý trong 24h)</option>
                    <option value="URGENT">Khẩn cấp (nguy cơ chập cháy, ngập nước)</option>
                  </select>
                </div>

                <div>
                  <label className="text-xs font-semibold text-slate-700 block mb-1">
                    Mô tả chi tiết <span className="text-red-500">*</span>
                  </label>
                  <textarea
                    rows={3}
                    required
                    value={serviceForm.description}
                    onChange={(e) => setServiceForm({ ...serviceForm, description: e.target.value })}
                    className="w-full px-3 py-2 text-xs rounded-xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    placeholder="Mô tả cụ thể vị trí, tình trạng để thợ chuẩn bị dụng cụ..."
                  />
                </div>

                <div className="pt-2 flex items-center justify-end space-x-2">
                  <button
                    type="button"
                    onClick={() => setShowServiceModal(false)}
                    className="px-3.5 py-2 text-xs text-slate-600 hover:bg-slate-100 rounded-xl"
                  >
                    Hủy
                  </button>
                  <button
                    type="submit"
                    disabled={isSubmittingService}
                    className="px-4 py-2 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-700 rounded-xl shadow-md disabled:opacity-50"
                  >
                    {isSubmittingService ? 'Đang gửi...' : 'Gửi yêu cầu kỹ thuật'}
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* MODAL 3: LIÊN HỆ BAN QUẢN LÝ                                              */}
      {/* ========================================================================= */}
      {showContactModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 backdrop-blur-sm p-4">
          <div className="bg-white rounded-3xl max-w-md w-full p-6 shadow-2xl border border-slate-100 animate-scaleUp">
            <div className="flex items-center justify-between pb-3 border-b border-slate-100">
              <div className="flex items-center space-x-2">
                <PhoneCall className="w-5 h-5 text-indigo-600" />
                <h3 className="text-base font-bold text-slate-900">Thông tin Ban Quản Lý</h3>
              </div>
              <button
                onClick={() => {
                  setShowContactModal(false);
                  setSelectedAptForContact(null);
                }}
                className="p-1 rounded-lg text-slate-400 hover:text-slate-600"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="py-4 space-y-4">
              {selectedAptForContact && (
                <div className="p-3 bg-indigo-50/70 rounded-xl border border-indigo-100 text-xs">
                  <span className="font-semibold text-indigo-900 block">Căn hộ bạn đang quan tâm:</span>
                  <span className="text-indigo-700">
                    Căn {selectedAptForContact.code} — {selectedAptForContact.building_name} ({formatVND(selectedAptForContact.base_rent)}/tháng)
                  </span>
                </div>
              )}

              <div className="space-y-3 text-xs text-slate-700">
                <div className="flex items-center justify-between p-3 rounded-xl bg-slate-50">
                  <span className="text-slate-500">Quản lý tòa nhà:</span>
                  <span className="font-bold text-slate-900">{manager_contact?.full_name || 'BQL ResiHub'}</span>
                </div>
                <div className="flex items-center justify-between p-3 rounded-xl bg-slate-50">
                  <span className="text-slate-500">Hotline / Zalo:</span>
                  <a
                    href={`tel:${manager_contact?.phone || '0901234567'}`}
                    className="font-bold text-indigo-600 font-mono hover:underline"
                  >
                    {manager_contact?.phone || '0901.234.567'}
                  </a>
                </div>
                <div className="flex items-center justify-between p-3 rounded-xl bg-slate-50">
                  <span className="text-slate-500">Email hỗ trợ:</span>
                  <span className="font-mono text-slate-800">{manager_contact?.email || 'manager@resihub.vn'}</span>
                </div>
                <div className="flex items-center justify-between p-3 rounded-xl bg-slate-50">
                  <span className="text-slate-500">Giờ làm việc:</span>
                  <span className="text-slate-800 font-medium">8:00 - 20:00 (Thứ 2 - CN)</span>
                </div>
              </div>

              <div className="pt-2">
                <a
                  href={`tel:${manager_contact?.phone || '0901234567'}`}
                  className="w-full py-2.5 px-4 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold transition-all shadow-md flex items-center justify-center space-x-2"
                >
                  <PhoneCall className="w-4 h-4" />
                  <span>Gọi ngay: {manager_contact?.phone || '0901.234.567'}</span>
                </a>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
