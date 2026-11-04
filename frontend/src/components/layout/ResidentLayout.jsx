import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Home,
  FileText,
  Receipt,
  Sparkles,
  Wrench,
  Bell,
  PhoneCall,
  UserCircle,
  LogOut,
  Building2,
  ArrowLeft,
  MoreHorizontal,
  ChevronRight,
} from 'lucide-react';
import { RESIDENT_PORTAL_TABS } from '../../constants/navigation';
import { resolveResidentMobileNavState } from '../../utils/residentNavHelpers';
import { useAuthStore } from '../../stores/authStore';
import { useNotificationStore } from '../../stores/notificationStore';
import { authService } from '../../services/auth.service';
import { NotificationBell } from '../common/NotificationBell';
import { Select } from '../ui/Select';
import { Modal } from '../ui/Modal';

const TAB_ICONS = {
  Home,
  FileText,
  Receipt,
  Sparkles,
  Wrench,
  Bell,
  PhoneCall,
  UserCircle,
};

export function ResidentLayout({
  activeTab,
  onChangeTab,
  apartmentBadge,
  activeContracts = [],
  selectedContractId = '',
  onSelectContract,
  children,
}) {
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);
  const clearSession = useAuthStore((s) => s.clearSession);
  const unreadCount = useNotificationStore((s) => s.unreadCount);
  const resetNotifs = useNotificationStore((s) => s.reset);
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);

  const mobileNav = resolveResidentMobileNavState({
    activeTab,
    unreadCount,
    tabs: RESIDENT_PORTAL_TABS,
  });

  const handleLogout = async () => {
    setMoreMenuOpen(false);
    try {
      await authService.logout();
    } catch {
      // ignore
    } finally {
      resetNotifs();
      clearSession();
      navigate('/login');
    }
  };

  const canGoBackHistory = typeof window !== 'undefined' && (window.history.state?.idx || 0) > 0;
  const canGoBack = canGoBackHistory || activeTab !== 'overview';

  const handleBack = () => {
    if (typeof window !== 'undefined' && (window.history.state?.idx || 0) > 0) {
      navigate(-1);
      return;
    }
    if (activeTab !== 'overview') {
      onChangeTab?.('overview');
    }
  };

  const contractSelectOptions = activeContracts.map((c) => ({
    value: c.contract_id,
    label: `Căn ${c.apartment_code}${c.building_name ? ` — ${c.building_name}` : ''}`,
    badge: c.is_future_contract ? 'HĐ tương lai' : '',
  }));

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col pb-24 lg:pb-0">
      {/* Top Header */}
      <header className="bg-white border-b border-slate-200 px-3.5 sm:px-6 py-2 sticky top-0 z-30 no-print">
        <div className="min-h-12 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 sm:gap-3 min-w-0">
            <button
              type="button"
              onClick={handleBack}
              disabled={!canGoBack}
              title="Quay lại trang trước"
              aria-label="Quay lại trang trước"
              className="min-w-[44px] min-h-[44px] sm:min-w-0 sm:min-h-0 p-2 rounded-xl text-slate-600 hover:bg-slate-100 hover:text-slate-900 disabled:opacity-35 disabled:cursor-not-allowed inline-flex items-center justify-center transition-colors shrink-0"
            >
              <ArrowLeft className="w-5 h-5" />
            </button>
            <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-primary-500 to-secondary-600 flex items-center justify-center text-white shadow-sm shrink-0">
              <Home className="w-5 h-5" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-1.5 sm:gap-2 flex-wrap">
                <span className="text-base font-bold text-slate-900">ResiHub</span>
                <span className="text-[11px] sm:text-xs font-medium text-primary-600 bg-primary-50 px-2 py-0.5 rounded-full border border-primary-100 whitespace-nowrap">
                  Cổng cư dân
                </span>
              </div>
              {activeContracts.length > 1 ? (
                <div className="hidden sm:block mt-1 sm:w-[320px] md:w-[420px] max-w-full">
                  <Select
                    size="sm"
                    icon={Building2}
                    aria-label="Chọn căn hộ đang thuê"
                    searchPlaceholder="Tìm mã căn hộ, tòa nhà..."
                    value={selectedContractId || activeContracts[0]?.contract_id || ''}
                    onChange={(e) => onSelectContract?.(e.target.value)}
                    options={contractSelectOptions}
                    className="bg-primary-50/80 border-primary-200 text-primary-700"
                  />
                </div>
              ) : apartmentBadge ? (
                <p
                  title={apartmentBadge}
                  className="text-xs text-slate-500 flex items-center gap-1 mt-0.5 min-w-0"
                >
                  <Building2 className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                  <span className="truncate sm:whitespace-normal sm:break-words leading-snug">
                    {apartmentBadge}
                  </span>
                </p>
              ) : null}
            </div>
          </div>

          <div className="flex items-center gap-1 sm:gap-2 shrink-0">
            <NotificationBell onViewAll={() => onChangeTab?.('notifications')} />
            <button
              type="button"
              title={user?.full_name || 'Cư dân'}
              onClick={() => onChangeTab?.('profile')}
              className="hidden sm:flex items-center gap-2 px-2.5 py-1.5 rounded-xl hover:bg-slate-100 transition-colors"
            >
              <div className="w-7 h-7 rounded-full bg-primary-100 text-primary-700 font-semibold text-xs flex items-center justify-center shrink-0">
                {(user?.full_name || 'C').slice(0, 1).toUpperCase()}
              </div>
              <span className="text-xs font-semibold text-slate-700 max-w-[200px] lg:max-w-[260px] truncate">
                {user?.full_name || 'Cư dân'}
              </span>
            </button>
            <button
              type="button"
              onClick={handleLogout}
              title="Đăng xuất"
              aria-label="Đăng xuất"
              className="min-w-[44px] min-h-[44px] sm:min-w-0 sm:min-h-0 p-2 rounded-xl text-slate-500 hover:text-rose-600 hover:bg-rose-50 inline-flex items-center justify-center transition-colors"
            >
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Mobile full-width multi-contract switcher (< 640px) */}
        {activeContracts.length > 1 ? (
          <div className="sm:hidden mt-2 pt-2 border-t border-slate-100">
            <Select
              size="sm"
              icon={Building2}
              aria-label="Chọn căn hộ đang thuê"
              searchPlaceholder="Tìm mã căn hộ, tòa nhà..."
              value={selectedContractId || activeContracts[0]?.contract_id || ''}
              onChange={(e) => onSelectContract?.(e.target.value)}
              options={contractSelectOptions}
              className="w-full bg-primary-50/80 border-primary-200 text-primary-700"
            />
          </div>
        ) : null}
      </header>

      {/* Main Content + Desktop Sidebar */}
      <div className="flex-1 max-w-7xl w-full mx-auto flex gap-6 p-3.5 sm:p-6">
        <aside className="hidden lg:block w-60 shrink-0 no-print">
          <div className="bg-white rounded-2xl border border-slate-200/80 shadow-card p-2.5 sticky top-22 space-y-1">
            {RESIDENT_PORTAL_TABS.map((t) => {
              const Icon = TAB_ICONS[t.icon] || Home;
              const isActive = activeTab === t.id;
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => onChangeTab?.(t.id)}
                  className={`w-full flex items-center justify-between px-3.5 py-2.5 rounded-xl text-sm font-medium transition-all ${
                    isActive
                      ? 'bg-primary-500 text-white shadow-sm'
                      : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'
                  }`}
                >
                  <span className="flex items-center gap-2.5">
                    <Icon className="w-4 h-4 shrink-0" />
                    <span>{t.label}</span>
                  </span>
                  {t.id === 'notifications' && unreadCount > 0 ? (
                    <span
                      className={`text-[11px] font-bold px-1.5 py-0.5 rounded-full ${
                        isActive ? 'bg-white text-primary-600' : 'bg-rose-500 text-white'
                      }`}
                    >
                      {unreadCount}
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
        </aside>

        <main className="flex-1 min-w-0">{children}</main>
      </div>

      {/* Mobile Fixed 5-Slot Bottom Navigation Bar (PRD 8.1, 16.1, 16.3) */}
      <nav
        aria-label="Điều hướng cổng cư dân"
        className="lg:hidden fixed bottom-0 inset-x-0 bg-white/95 backdrop-blur-md border-t border-slate-200 z-30 pb-safe no-print shadow-[0_-2px_10px_rgba(15,23,42,0.04)]"
      >
        <div className="grid grid-cols-5 items-stretch min-h-[56px] px-1">
          {mobileNav.primaryTabs.map((t) => {
            const Icon = TAB_ICONS[t.icon] || Home;
            const isActive = activeTab === t.id;
            return (
              <button
                key={t.id}
                type="button"
                aria-current={isActive ? 'page' : undefined}
                onClick={() => {
                  setMoreMenuOpen(false);
                  onChangeTab?.(t.id);
                }}
                className={`min-h-[48px] flex flex-col items-center justify-center gap-0.5 px-1 py-1.5 rounded-xl text-[11px] font-medium transition-colors ${
                  isActive
                    ? 'text-primary-600 bg-primary-50/80 font-semibold'
                    : 'text-slate-500 hover:text-slate-800'
                }`}
              >
                <Icon className="w-5 h-5 shrink-0" />
                <span className="leading-tight text-center">{t.shortLabel}</span>
              </button>
            );
          })}

          <button
            type="button"
            aria-expanded={moreMenuOpen}
            aria-haspopup="dialog"
            onClick={() => setMoreMenuOpen((prev) => !prev)}
            className={`relative min-h-[48px] flex flex-col items-center justify-center gap-0.5 px-1 py-1.5 rounded-xl text-[11px] font-medium transition-colors ${
              mobileNav.isMoreActive || moreMenuOpen
                ? 'text-primary-600 bg-primary-50/80 font-semibold'
                : 'text-slate-500 hover:text-slate-800'
            }`}
          >
            <span className="relative inline-flex items-center justify-center">
              <MoreHorizontal className="w-5 h-5 shrink-0" />
              {mobileNav.moreBadgeCount > 0 ? (
                <span className="absolute -top-1.5 -right-2.5 min-w-[16px] h-4 px-1 rounded-full bg-rose-500 text-white text-[10px] font-bold flex items-center justify-center leading-none">
                  {mobileNav.moreBadgeCount > 99 ? '99+' : mobileNav.moreBadgeCount}
                </span>
              ) : null}
            </span>
            <span className="leading-tight text-center">
              {mobileNav.activeSecondaryTab ? mobileNav.activeSecondaryTab.shortLabel : 'Thêm'}
            </span>
          </button>
        </div>
      </nav>

      {/* Mobile Bottom-Sheet Drawer for Secondary Tabs */}
      <Modal
        open={moreMenuOpen}
        onClose={() => setMoreMenuOpen(false)}
        title="Tiện ích & Hồ sơ cư dân"
        subtitle={user?.full_name ? `Xin chào, ${user.full_name}` : 'Truy cập nhanh các mục khác'}
        size="sm"
      >
        <div className="space-y-1.5">
          {mobileNav.secondaryTabs.map((t) => {
            const Icon = TAB_ICONS[t.icon] || FileText;
            const isActive = activeTab === t.id;
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => {
                  setMoreMenuOpen(false);
                  onChangeTab?.(t.id);
                }}
                className={`w-full min-h-[48px] px-3.5 py-2.5 rounded-xl border flex items-center justify-between gap-3 text-left transition-colors ${
                  isActive
                    ? 'bg-primary-50 border-primary-200 text-primary-700 font-semibold'
                    : 'bg-white border-slate-200/80 text-slate-700 hover:bg-slate-50'
                }`}
              >
                <span className="flex items-center gap-3 min-w-0">
                  <span
                    className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 ${
                      isActive
                        ? 'bg-primary-500 text-white'
                        : 'bg-slate-100 text-slate-600'
                    }`}
                  >
                    <Icon className="w-4.5 h-4.5" />
                  </span>
                  <span className="text-sm break-words">{t.label}</span>
                </span>
                <span className="flex items-center gap-2 shrink-0">
                  {t.id === 'notifications' && unreadCount > 0 ? (
                    <span className="px-2 py-0.5 rounded-full bg-rose-500 text-white text-xs font-bold">
                      {unreadCount} mới
                    </span>
                  ) : null}
                  <ChevronRight className="w-4 h-4 text-slate-400" />
                </span>
              </button>
            );
          })}

          <div className="pt-2 mt-2 border-t border-slate-100">
            <button
              type="button"
              onClick={handleLogout}
              className="w-full min-h-[48px] px-3.5 py-2.5 rounded-xl border border-rose-200/80 bg-rose-50/50 hover:bg-rose-50 text-rose-700 font-semibold text-sm flex items-center justify-between gap-3 transition-colors"
            >
              <span className="flex items-center gap-3">
                <span className="w-9 h-9 rounded-xl bg-rose-100 text-rose-600 flex items-center justify-center shrink-0">
                  <LogOut className="w-4.5 h-4.5" />
                </span>
                <span>Đăng xuất tài khoản</span>
              </span>
              <ChevronRight className="w-4 h-4 text-rose-400" />
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

export default ResidentLayout;
