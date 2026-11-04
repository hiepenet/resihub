import React, { useState, useEffect, useMemo } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { Menu, Building2, LogOut, ArrowLeft } from 'lucide-react';
import { useAuthStore } from '../../stores/authStore';
import { useNotificationStore } from '../../stores/notificationStore';
import { authService } from '../../services/auth.service';
import { buildingsService } from '../../services/buildings.service';
import { NotificationBell } from '../common/NotificationBell';
import { ProfileModal } from '../common/ProfileModal';
import { Badge } from '../ui/Badge';
import { Select } from '../ui/Select';
import { ROLE_LABELS, ROLE_BADGE_VARIANTS } from '../../constants/roles';

export function TopBar({ onOpenMobileMenu }) {
  const navigate = useNavigate();
  const location = useLocation();
  const user = useAuthStore((s) => s.user);
  const selectedBuildingId = useAuthStore((s) => s.selectedBuildingId);
  const setSelectedBuildingId = useAuthStore((s) => s.setSelectedBuildingId);
  const clearSession = useAuthStore((s) => s.clearSession);
  const getCurrentRole = useAuthStore((s) => s.getCurrentRole);
  const resetNotifs = useNotificationStore((s) => s.reset);

  const [buildings, setBuildings] = useState([]);
  const [profileOpen, setProfileOpen] = useState(false);

  const primaryRole = getCurrentRole();

  useEffect(() => {
    const fetchBuildings = () => {
      buildingsService
        .list()
        .then((res) => {
          const list = res.data || [];
          setBuildings(list);
          const currentSelected = useAuthStore.getState().selectedBuildingId;
          if (list.length === 1 && !currentSelected) {
            setSelectedBuildingId(list[0].id);
          }
        })
        .catch(() => {});
    };

    fetchBuildings();
    window.addEventListener('resihub:buildings-updated', fetchBuildings);
    return () => window.removeEventListener('resihub:buildings-updated', fetchBuildings);
  }, [setSelectedBuildingId]);

  const buildingOptions = useMemo(
    () =>
      buildings.map((b) => ({
        value: b.id,
        label: `${b.code} — ${b.name}`,
        badge: b.code,
        sublabel: b.address || undefined,
      })),
    [buildings]
  );

  const canGoBack =
    (typeof window !== 'undefined' && window.history.state && window.history.state.idx > 0) ||
    location.pathname !== '/admin/dashboard';

  const handleBack = () => {
    if (typeof window !== 'undefined' && window.history.state && window.history.state.idx > 0) {
      navigate(-1);
    } else if (location.pathname !== '/admin/dashboard') {
      navigate('/admin/dashboard');
    }
  };

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

  return (
    <>
      <header className="h-16 bg-white/95 backdrop-blur border-b border-slate-200/80 px-4 sm:px-6 flex items-center justify-between gap-4 sticky top-0 z-30 no-print">
        <div className="flex items-center gap-2.5 min-w-0">
          <button
            type="button"
            onClick={onOpenMobileMenu}
            aria-label="Mở menu điều hướng"
            className="lg:hidden p-2 rounded-lg text-slate-600 hover:bg-slate-100"
          >
            <Menu className="w-5 h-5" />
          </button>

          <button
            type="button"
            onClick={handleBack}
            disabled={!canGoBack}
            title="Quay lại trang trước"
            aria-label="Quay lại trang trước"
            className="w-8 h-8 rounded-xl border border-slate-200 bg-white text-slate-600 hover:text-primary-600 hover:border-primary-300 hover:bg-primary-50/70 disabled:opacity-40 disabled:pointer-events-none flex items-center justify-center shrink-0 transition-all"
          >
            <ArrowLeft className="w-4 h-4" />
          </button>

          {/* Building Filter (Searchable Dropdown) */}
          {buildings.length > 0 ? (
            <div className="w-56 sm:w-80 lg:w-96 min-w-0">
              <Select
                size="sm"
                icon={Building2}
                aria-label="Chọn tòa nhà phạm vi"
                value={selectedBuildingId}
                disabled={buildings.length === 1}
                placeholder={
                  buildings.length > 1
                    ? `Tất cả tòa nhà trong phạm vi (${buildings.length})`
                    : undefined
                }
                searchPlaceholder="Tìm nhanh theo mã hoặc tên tòa nhà..."
                options={buildingOptions}
                onChange={(e) => setSelectedBuildingId(e.target.value)}
                className="bg-slate-50/90 border-slate-200 rounded-xl"
              />
            </div>
          ) : null}
        </div>

        <div className="flex items-center gap-2 sm:gap-3 shrink-0">
          <Badge variant={ROLE_BADGE_VARIANTS[primaryRole] || 'sky'} className="hidden md:inline-flex">
            {ROLE_LABELS[primaryRole] || primaryRole}
          </Badge>

          <NotificationBell onViewAll={() => navigate('/admin/notifications?tab=inbox')} />

          <button
            type="button"
            onClick={() => setProfileOpen(true)}
            className="flex items-center gap-2 pl-2 pr-3 py-1.5 rounded-xl hover:bg-slate-100 transition-colors border border-transparent hover:border-slate-200"
          >
            <div className="w-7 h-7 rounded-full bg-primary-100 text-primary-700 flex items-center justify-center font-semibold text-xs">
              {(user?.full_name || user?.email || 'U').slice(0, 1).toUpperCase()}
            </div>
            <div className="hidden sm:block text-left">
              <p
                title={user?.full_name || 'Người dùng'}
                className="text-xs font-semibold text-slate-800 leading-tight max-w-[220px] xl:max-w-[280px] truncate"
              >
                {user?.full_name || 'Người dùng'}
              </p>
              <p
                title={user?.email || user?.phone || ''}
                className="text-[11px] text-slate-400 leading-tight max-w-[220px] xl:max-w-[280px] truncate"
              >
                {user?.email || user?.phone || ''}
              </p>
            </div>
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

      <ProfileModal open={profileOpen} onClose={() => setProfileOpen(false)} />
    </>
  );
}

export default TopBar;
