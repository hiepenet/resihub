import React from 'react';
import { NavLink } from 'react-router-dom';
import {
  LayoutDashboard,
  Building2,
  Users,
  FileSignature,
  ShieldCheck,
  Gauge,
  Sparkles,
  Receipt,
  Wallet,
  Wrench,
  BellRing,
  BarChart3,
  ScrollText,
  UserCog,
  X,
  Home,
} from 'lucide-react';
import { ADMIN_NAV_GROUPS } from '../../constants/navigation';
import { useAuthStore } from '../../stores/authStore';
import { ROLE_LABELS } from '../../constants/roles';

const ICON_MAP = {
  LayoutDashboard,
  Building2,
  Users,
  FileSignature,
  ShieldCheck,
  Gauge,
  Sparkles,
  Receipt,
  Wallet,
  Wrench,
  BellRing,
  BarChart3,
  ScrollText,
  UserCog,
};

export function Sidebar({ mobileOpen, onCloseMobile }) {
  useAuthStore((s) => s.user);
  const hasRole = useAuthStore((s) => s.hasRole);
  const getCurrentRoleInfo = useAuthStore((s) => s.getCurrentRoleInfo);
  const roleInfo = getCurrentRoleInfo();

  const filteredGroups = ADMIN_NAV_GROUPS.map((grp) => ({
    ...grp,
    items: grp.items.filter((item) => hasRole(item.roles)),
  })).filter((grp) => grp.items.length > 0);

  const navContent = (
    <div className="flex flex-col h-full bg-slate-900 text-slate-300 select-none">
      {/* Brand */}
      <div className="h-16 px-5 flex items-center justify-between border-b border-slate-800 shrink-0">
        <div className="flex items-center gap-2.5">
          <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-primary-400 to-secondary-600 flex items-center justify-center text-white shadow-md">
            <Home className="w-5 h-5" />
          </div>
          <div>
            <p className="text-base font-bold text-white tracking-tight leading-none">ResiHub</p>
            <p className="text-[11px] text-sky-400 font-medium mt-0.5">Property Cloud v2.0</p>
          </div>
        </div>
        <button
          type="button"
          onClick={onCloseMobile}
          className="lg:hidden p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800"
        >
          <X className="w-5 h-5" />
        </button>
      </div>

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto px-3 py-4 space-y-5">
        {filteredGroups.map((group) => (
          <div key={group.group}>
            <p className="px-3 mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
              {group.group}
            </p>
            <div className="space-y-0.5">
              {group.items.map((item) => {
                const Icon = ICON_MAP[item.icon] || LayoutDashboard;
                return (
                  <NavLink
                    key={item.path}
                    to={item.path}
                    onClick={onCloseMobile}
                    className={({ isActive }) =>
                      `flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-all ${
                        isActive
                          ? 'bg-primary-500 text-white shadow-sm'
                          : 'text-slate-300 hover:text-white hover:bg-slate-800/70'
                      }`
                    }
                  >
                    <Icon className="w-4 h-4 shrink-0" />
                    <span className="leading-snug break-words">{item.label}</span>
                  </NavLink>
                );
              })}
            </div>
          </div>
        ))}
      </nav>

      {/* Role Footer */}
      <div className="p-3.5 border-t border-slate-800 shrink-0">
        <div className="px-3 py-2.5 rounded-xl bg-slate-800/70 border border-slate-700/60">
          <p className="text-[11px] text-slate-400">Vai trò hiện tại</p>
          <p className="text-xs font-semibold text-sky-400 mt-0.5 leading-snug break-words">
            {ROLE_LABELS[roleInfo.code] || roleInfo.name}
          </p>
        </div>
      </div>
    </div>
  );

  return (
    <>
      <aside className="hidden lg:block w-64 shrink-0 h-screen sticky top-0 no-print">{navContent}</aside>

      {mobileOpen ? (
        <div className="fixed inset-0 z-50 lg:hidden flex no-print">
          <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-[1px]" onClick={onCloseMobile} />
          <aside className="relative z-10 w-64 max-w-[82vw] h-full shadow-2xl">{navContent}</aside>
        </div>
      ) : null}
    </>
  );
}

export default Sidebar;

