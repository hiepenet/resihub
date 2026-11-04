import React, { useState } from 'react';
import {
  PhoneCall,
  Mail,
  Clock,
  ShieldAlert,
  Wrench,
  Siren,
  Building2,
  MapPin,
  Copy,
  Check,
  UserCheck,
  Headphones,
} from 'lucide-react';
import { Card } from '../../../components/ui/Card';
import { Button } from '../../../components/ui/Button';
import { Badge } from '../../../components/ui/Badge';
import { useToast } from '../../../hooks/useToast';

export function ContactTab({ overview, onNavigateTab }) {
  const toast = useToast();
  const [copiedKey, setCopiedKey] = useState('');

  const contract = overview?.active_contract || overview?.contract || null;
  const reservation =
    (Array.isArray(overview?.reservations) && overview.reservations[0]) ||
    overview?.reservation ||
    null;
  const onboardingApp = overview?.onboarding_application || overview?.pending_application || null;

  // Hợp nhất dữ liệu từ manager_contact, building_manager và contact_config (system_setting)
  const rawManager = {
    ...(overview?.manager_contact || {}),
    ...(overview?.building_manager || {}),
  };

  const rawContactConfig = {
    ...(overview?.manager_contact || {}),
    ...(overview?.contact_config || {}),
  };

  const managerName = rawManager.full_name || 'Ban Quản Lý Tòa Nhà ResiHub';
  const managerPhone = rawManager.phone || '0901 234 567';
  const managerEmail = rawManager.email || 'manager@resihub.vn';
  const buildingName =
    rawManager.building_name ||
    contract?.building_name ||
    reservation?.building_name ||
    onboardingApp?.desired_building_name ||
    'Hệ thống Căn hộ Dịch vụ ResiHub';
  const buildingAddress =
    rawManager.building_address ||
    contract?.building_address ||
    reservation?.building_address ||
    onboardingApp?.desired_building_address ||
    'Văn phòng Ban Quản Lý tại sảnh tầng 1 tòa nhà';

  const workingHours =
    rawContactConfig.working_hours || '08:00 – 18:00 (Thứ 2 – Thứ 7)';
  const technicalHotline = rawContactConfig.technical_hotline || '1900 6868';
  const securityHotline = rawContactConfig.security_hotline || '1900 9119';
  const emergencyPhone = rawContactConfig.emergency_phone || '0909 113 114';
  const supportEmail = rawContactConfig.support_email || 'support@resihub.vn';

  const cleanTel = (num) => String(num || '').replace(/[^\d+]/g, '');

  const handleCopy = async (value, key) => {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopiedKey(key);
      setTimeout(() => setCopiedKey(''), 2000);
      toast.info(`Đã sao chép: ${value}`);
    } catch {
      // ignore
    }
  };

  return (
    <div className="space-y-6">
      {/* Direct Building Manager Hero Card */}
      <div className="rounded-2xl bg-gradient-to-br from-sky-500 via-primary-600 to-indigo-700 text-white p-6 sm:p-7 shadow-elevated">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-6">
          <div className="flex items-start gap-4">
            <div className="w-14 h-14 rounded-2xl bg-white/20 backdrop-blur-sm border border-white/30 flex items-center justify-center text-xl font-bold shrink-0">
              {managerName.slice(0, 1).toUpperCase()}
            </div>
            <div className="space-y-1.5">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-white/20 border border-white/25">
                  <UserCheck className="w-3.5 h-3.5" />
                  Quản lý tòa nhà phụ trách trực tiếp
                </span>
              </div>
              <h2 className="text-xl sm:text-2xl font-bold">{managerName}</h2>
              <p className="text-sm text-sky-100 flex items-center gap-1.5">
                <Building2 className="w-4 h-4 text-sky-200 shrink-0" />
                <span>{buildingName}</span>
              </p>
              <p className="text-xs text-sky-100/90 flex items-center gap-1.5">
                <MapPin className="w-3.5 h-3.5 text-sky-200 shrink-0" />
                <span>{buildingAddress}</span>
              </p>
            </div>
          </div>

          <div className="flex flex-col sm:flex-row lg:flex-col gap-2.5 shrink-0">
            <a
              href={`tel:${cleanTel(managerPhone)}`}
              className="inline-flex items-center justify-center gap-2 min-h-[44px] sm:min-h-0 sm:h-10 px-4 rounded-xl bg-white text-primary-700 hover:bg-sky-50 font-semibold text-sm shadow-sm transition-colors"
            >
              <PhoneCall className="w-4 h-4 shrink-0" />
              Gọi Quản lý: {managerPhone}
            </a>
            <a
              href={`mailto:${managerEmail}`}
              className="inline-flex items-center justify-center gap-2 min-h-[44px] sm:min-h-0 sm:h-10 px-4 rounded-xl bg-white/15 hover:bg-white/25 text-white border border-white/25 font-medium text-xs transition-colors"
            >
              <Mail className="w-4 h-4 shrink-0" />
              {managerEmail}
            </a>
          </div>
        </div>

        <div className="mt-5 pt-4 border-t border-white/15 flex flex-wrap items-center justify-between gap-3 text-xs text-sky-100">
          <span className="inline-flex items-center gap-1.5">
            <Clock className="w-4 h-4 text-sky-200" />
            Giờ làm việc Văn phòng BQL: <strong className="text-white">{workingHours}</strong>
          </span>
          <span>Tiếp nhận hỗ trợ cư dân trực tiếp tại Quầy lễ tân Sảnh chính</span>
        </div>
      </div>

      {/* Hotlines Grid (from contact_config / system_setting) */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Technical Hotline */}
        <Card className="flex flex-col justify-between">
          <div>
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-3">
                <div className="w-11 h-11 rounded-xl bg-amber-50 text-amber-600 border border-amber-100 flex items-center justify-center shrink-0">
                  <Wrench className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-sm font-bold text-slate-900">Hotline Kỹ thuật Tòa nhà</h3>
                  <p className="text-xs text-slate-500">
                    Sự cố điện, nước, điều hòa, thang máy, internet
                  </p>
                </div>
              </div>
              <Badge variant="amber">Kỹ thuật</Badge>
            </div>

            <div className="mt-4 p-3.5 rounded-xl bg-slate-50 border border-slate-200/70 flex items-center justify-between gap-2">
              <a
                href={`tel:${cleanTel(technicalHotline)}`}
                className="text-lg font-bold text-slate-900 hover:text-primary-600 transition-colors"
              >
                {technicalHotline}
              </a>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => handleCopy(technicalHotline, 'tech')}
                  aria-label="Sao chép số Hotline kỹ thuật"
                  className="min-w-[44px] min-h-[44px] sm:min-w-0 sm:min-h-0 p-2 rounded-lg hover:bg-slate-200/70 text-slate-500 inline-flex items-center justify-center"
                  title="Sao chép số"
                >
                  {copiedKey === 'tech' ? (
                    <Check className="w-4 h-4 text-emerald-600" />
                  ) : (
                    <Copy className="w-4 h-4" />
                  )}
                </button>
                <a
                  href={`tel:${cleanTel(technicalHotline)}`}
                  className="inline-flex items-center justify-center gap-1.5 min-h-[44px] sm:min-h-0 px-3.5 py-2 sm:py-1.5 rounded-lg bg-primary-500 hover:bg-primary-600 text-white text-xs font-semibold transition-colors"
                >
                  <PhoneCall className="w-3.5 h-3.5" />
                  Gọi ngay
                </a>
              </div>
            </div>
          </div>

          <div className="mt-3 pt-3 border-t border-slate-100 flex items-center justify-between text-xs">
            <span className="text-slate-500">Hoặc gửi phiếu kèm ảnh sự cố</span>
            <Button
              variant="ghost"
              size="xs"
              onClick={() => onNavigateTab?.('maintenance', { action: 'new' })}
              className="!text-primary-600 font-semibold"
            >
              Mở mục Báo hỏng →
            </Button>
          </div>
        </Card>

        {/* Security Hotline */}
        <Card className="flex flex-col justify-between">
          <div>
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-3">
                <div className="w-11 h-11 rounded-xl bg-indigo-50 text-indigo-600 border border-indigo-100 flex items-center justify-center shrink-0">
                  <ShieldAlert className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-sm font-bold text-slate-900">Hotline An ninh & Bảo vệ</h3>
                  <p className="text-xs text-slate-500">
                    Trực chốt sảnh, hầm gửi xe, kiểm soát ra vào & thẻ từ
                  </p>
                </div>
              </div>
              <Badge variant="indigo" dot>
                Trực 24/7
              </Badge>
            </div>

            <div className="mt-4 p-3.5 rounded-xl bg-slate-50 border border-slate-200/70 flex items-center justify-between gap-2">
              <a
                href={`tel:${cleanTel(securityHotline)}`}
                className="text-lg font-bold text-slate-900 hover:text-primary-600 transition-colors"
              >
                {securityHotline}
              </a>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => handleCopy(securityHotline, 'sec')}
                  aria-label="Sao chép số Hotline an ninh"
                  className="min-w-[44px] min-h-[44px] sm:min-w-0 sm:min-h-0 p-2 rounded-lg hover:bg-slate-200/70 text-slate-500 inline-flex items-center justify-center"
                  title="Sao chép số"
                >
                  {copiedKey === 'sec' ? (
                    <Check className="w-4 h-4 text-emerald-600" />
                  ) : (
                    <Copy className="w-4 h-4" />
                  )}
                </button>
                <a
                  href={`tel:${cleanTel(securityHotline)}`}
                  className="inline-flex items-center justify-center gap-1.5 min-h-[44px] sm:min-h-0 px-3.5 py-2 sm:py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-semibold transition-colors"
                >
                  <PhoneCall className="w-3.5 h-3.5" />
                  Gọi ngay
                </a>
              </div>
            </div>
          </div>

          <div className="mt-3 pt-3 border-t border-slate-100 text-xs text-slate-500">
            Hỗ trợ mở khóa khẩn cấp, đăng ký khách thăm và đảm bảo trật tự khu căn hộ 24/24.
          </div>
        </Card>

        {/* Emergency Phone */}
        <Card className="border-rose-200 bg-rose-50/20 flex flex-col justify-between">
          <div>
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-3">
                <div className="w-11 h-11 rounded-xl bg-rose-100 text-rose-600 border border-rose-200 flex items-center justify-center shrink-0">
                  <Siren className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-sm font-bold text-rose-900">
                    Đường dây Khẩn cấp (SOS / PCCC)
                  </h3>
                  <p className="text-xs text-rose-700/80">
                    Sự cố cháy nổ, y tế khẩn cấp, an toàn tính mạng & tài sản
                  </p>
                </div>
              </div>
              <Badge variant="red" dot>
                Khẩn cấp 24/7
              </Badge>
            </div>

            <div className="mt-4 p-3.5 rounded-xl bg-white border border-rose-200 flex items-center justify-between gap-2">
              <a
                href={`tel:${cleanTel(emergencyPhone)}`}
                className="text-lg font-bold text-rose-600 hover:text-rose-700 transition-colors"
              >
                {emergencyPhone}
              </a>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => handleCopy(emergencyPhone, 'sos')}
                  className="p-2 rounded-lg hover:bg-rose-50 text-slate-500"
                  title="Sao chép số"
                >
                  {copiedKey === 'sos' ? (
                    <Check className="w-4 h-4 text-emerald-600" />
                  ) : (
                    <Copy className="w-4 h-4" />
                  )}
                </button>
                <a
                  href={`tel:${cleanTel(emergencyPhone)}`}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-rose-600 hover:bg-rose-700 text-white text-xs font-semibold transition-colors"
                >
                  <PhoneCall className="w-3.5 h-3.5" />
                  Gọi SOS
                </a>
              </div>
            </div>
          </div>

          <div className="mt-3 pt-3 border-t border-rose-100 text-xs text-rose-700/80">
            Số khẩn cấp quốc gia: <strong>113</strong> (Công an) • <strong>114</strong> (Cứu hỏa) •{' '}
            <strong>115</strong> (Cấp cứu)
          </div>
        </Card>

        {/* Support Email & Office Hours */}
        <Card className="flex flex-col justify-between">
          <div>
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-3">
                <div className="w-11 h-11 rounded-xl bg-emerald-50 text-emerald-600 border border-emerald-100 flex items-center justify-center shrink-0">
                  <Headphones className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-sm font-bold text-slate-900">
                    Chăm sóc Cư dân & Email Hỗ trợ
                  </h3>
                  <p className="text-xs text-slate-500">
                    Giải đáp hóa đơn, thủ tục hợp đồng, đăng ký tạm trú & góp ý dịch vụ
                  </p>
                </div>
              </div>
              <Badge variant="emerald">CSKH</Badge>
            </div>

            <div className="mt-4 p-3.5 rounded-xl bg-slate-50 border border-slate-200/70 flex flex-wrap items-center justify-between gap-2">
              <a
                href={`mailto:${supportEmail}`}
                className="text-sm sm:text-base font-bold text-slate-900 hover:text-primary-600 break-all transition-colors"
              >
                {supportEmail}
              </a>
              <div className="flex items-center gap-1.5 shrink-0">
                <button
                  type="button"
                  onClick={() => handleCopy(supportEmail, 'email')}
                  className="p-2 rounded-lg hover:bg-slate-200/70 text-slate-500"
                  title="Sao chép email"
                >
                  {copiedKey === 'email' ? (
                    <Check className="w-4 h-4 text-emerald-600" />
                  ) : (
                    <Copy className="w-4 h-4" />
                  )}
                </button>
                <a
                  href={`mailto:${supportEmail}`}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-semibold transition-colors"
                >
                  <Mail className="w-3.5 h-3.5" />
                  Gửi Email
                </a>
              </div>
            </div>
          </div>

          <div className="mt-3 pt-3 border-t border-slate-100 flex items-center gap-1.5 text-xs text-slate-500">
            <Clock className="w-3.5 h-3.5 text-slate-400 shrink-0" />
            <span>Giờ hành chính: {workingHours}</span>
          </div>
        </Card>
      </div>
    </div>
  );
}

export default ContactTab;
