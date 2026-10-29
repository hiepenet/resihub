import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Menu, Building2, LogOut, UserCircle2 } from 'lucide-react';
import { useAuthStore } from '../../stores/authStore';
import { useNotificationStore } from '../../stores/notificationStore';
import { authService } from '../../services/auth.service';
import { buildingsService } from '../../services/buildings.service';
import { NotificationBell } from '../common/NotificationBell';
import { ProfileModal } from '../common/ProfileModal';
import { Badge } from '../ui/Badge';
import { ROLE_LABELS, ROLE_BADGE_VARIANTS } from '../../constants/roles';

export function TopBar({ onOpenMobileMenu }) {
  const navigate = useNavigate();
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
    buildingsService
      .list()
      .then((res) => {
        const list = res.data || [];
        setBuildings(list);
        if (list.length === 1 && !selectedBuildingId) {
          setSelectedBuildingId(list[0].id);
        }
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
        <div className="flex items-center gap-3 min-w-0">
          <button
            type="button"
            onClick={onOpenMobileMenu}
            className="lg:hidden p-2 rounded-lg text-slate-600 hover:bg-slate-100"
          >
            <Menu className="w-5 h-5" />
          </button>

          {/* Building Filter */}
          {buildings.length > 0 ? (
            <div className="flex items-center gap-2 bg-slate-50 border border-slate-200 rounded-xl px-3 py-1.5 max-w-xs sm:max-w-sm">
              <Building2 className="w-4 h-4 text-primary-500 shrink-0" />
              <select
                value={selectedBuildingId}
                onChange={(e) => setSelectedBuildingId(e.target.value)}
                disabled={buildings.length === 1}
                className="bg-transparent text-xs sm:text-sm font-medium text-slate-700 focus:outline-none truncate pr-2 disabled:opacity-90"
              >
                {buildings.length > 1 ? (
                  <option value="">Tất cả tòa nhà trong phạm vi ({buildings.length})</option>
                ) : null}
                {buildings.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.code} — {b.name}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
        </div>

        <div className="flex items-center gap-2 sm:gap-3 shrink-0">
          <Badge variant={ROLE_BADGE_VARIANTS[primaryRole] || 'sky'} className="hidden md:inline-flex">
            {ROLE_LABELS[primaryRole] || primaryRole}
          </Badge>

          <NotificationBell onViewAll={() => navigate('/admin/notifications')} />

          <button
            type="button"
            onClick={() => setProfileOpen(true)}
            className="flex items-center gap-2 pl-2 pr-3 py-1.5 rounded-xl hover:bg-slate-100 transition-colors border border-transparent hover:border-slate-200"
          >
            <div className="w-7 h-7 rounded-full bg-primary-100 text-primary-700 flex items-center justify-center font-semibold text-xs">
              {(user?.full_name || user?.email || 'U').slice(0, 1).toUpperCase()}
            </div>
            <div className="hidden sm:block text-left">
              <p className="text-xs font-semibold text-slate-800 leading-tight max-w-[140px] truncate">
                {user?.full_name || 'Người dùng'}
              </p>
              <p className="text-[11px] text-slate-400 leading-tight max-w-[140px] truncate">
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

