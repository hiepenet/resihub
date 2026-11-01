import React from 'react';
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
} from 'lucide-react';
import { RESIDENT_PORTAL_TABS } from '../../constants/navigation';
import { useAuthStore } from '../../stores/authStore';
import { useNotificationStore } from '../../stores/notificationStore';
import { authService } from '../../services/auth.service';
import { NotificationBell } from '../common/NotificationBell';
import { Select } from '../ui/Select';

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

  const handleLogout = async () => {
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

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col pb-16 lg:pb-0">
      {/* Top Header */}
      <header className="min-h-16 py-2 bg-white border-b border-slate-200 px-4 sm:px-6 flex items-center justify-between sticky top-0 z-30 no-print">
        <div className="flex items-center gap-2.5 sm:gap-3 min-w-0">
          <button
            type="button"
            onClick={handleBack}
            disabled={!canGoBack}
            title="Quay lại trang trước"
            aria-label="Quay lại trang trước"
            className="p-2 rounded-xl text-slate-600 hover:bg-slate-100 hover:text-slate-900 disabled:opacity-35 disabled:cursor-not-allowed transition-colors shrink-0"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-primary-500 to-secondary-600 flex items-center justify-center text-white shadow-sm shrink-0">
            <Home className="w-5 h-5" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-base font-bold text-slate-900">ResiHub</span>
              <span className="text-xs font-medium text-primary-600 bg-primary-50 px-2 py-0.5 rounded-full border border-primary-100">
                Cổng cư dân
              </span>
            </div>
            {activeContracts.length > 1 ? (
              <div className="mt-1 w-[200px] sm:w-[320px] md:w-[420px] max-w-full">
                <Select
                  size="sm"
                  icon={Building2}
                  aria-label="Chọn căn hộ đang thuê"
                  searchPlaceholder="Tìm mã căn hộ, tòa nhà..."
                  value={selectedContractId || activeContracts[0]?.contract_id || ''}
                  onChange={(e) => onSelectContract?.(e.target.value)}
                  options={activeContracts.map((c) => ({
                    value: c.contract_id,
                    label: `Căn ${c.apartment_code}${c.building_name ? ` — ${c.building_name}` : ''}`,
                    badge: c.is_future_contract ? 'HĐ tương lai' : '',
                  }))}
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

        <div className="flex items-center gap-2 shrink-0">
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
            className="p-2 rounded-xl text-slate-500 hover:text-rose-600 hover:bg-rose-50 transition-colors"
          >
            <LogOut className="w-4 h-4" />
          </button>
        </div>
      </header>

      {/* Main Content + Desktop Sidebar */}
      <div className="flex-1 max-w-7xl w-full mx-auto flex gap-6 p-4 sm:p-6">
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

      {/* Mobile Bottom Nav */}
      <nav className="lg:hidden fixed bottom-0 inset-x-0 bg-white border-t border-slate-200 z-30 flex items-center overflow-x-auto px-2 py-1.5 gap-1 no-print">
        {RESIDENT_PORTAL_TABS.map((t) => {
          const Icon = TAB_ICONS[t.icon] || Home;
          const isActive = activeTab === t.id;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => onChangeTab?.(t.id)}
              className={`flex flex-col items-center justify-center px-2 py-1.5 rounded-xl min-w-[64px] shrink-0 text-[11px] font-medium transition-colors ${
                isActive ? 'text-primary-600 bg-primary-50' : 'text-slate-500'
              }`}
            >
              <Icon className="w-4 h-4 mb-0.5" />
              <span className="whitespace-nowrap">{t.shortLabel}</span>
            </button>
          );
        })}
      </nav>
    </div>
  );
}

export default ResidentLayout;

