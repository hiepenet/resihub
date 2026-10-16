import React from 'react';
import { NavLink } from 'react-router-dom';
import { Building, Shield, ChevronDown, LogOut } from 'lucide-react';
import { NAV_ITEMS } from '../../constants/navigation';
import { useAuthStore } from '../../stores/authStore';

export default function Sidebar({ isOpen, onClose }) {
  const { user, getCurrentRole, getCurrentRoleInfo, logout } = useAuthStore();

  const currentRole = getCurrentRole();
  const currentRoleInfo = getCurrentRoleInfo();

  const visibleNavItems = NAV_ITEMS.filter((item) =>
    item.roles.includes(currentRole)
  );

  return (
    <>
      {/* Mobile Backdrop */}
      {isOpen && (
        <div
          className="fixed inset-0 z-40 bg-slate-900/50 backdrop-blur-sm lg:hidden"
          onClick={onClose}
        />
      )}

      {/* Sidebar container */}
      <aside
        className={`fixed inset-y-0 left-0 z-40 w-64 bg-slate-900 text-white flex flex-col transition-transform duration-200 ease-in-out lg:static lg:translate-x-0 ${
          isOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        {/* Brand Header */}
        <div className="h-16 flex items-center px-6 border-b border-slate-800 gap-3">
          <div className="w-9 h-9 rounded-xl bg-gradient-to-tr from-primary-600 to-indigo-500 flex items-center justify-center shadow-lg shadow-primary-500/30">
            <Building className="w-5 h-5 text-white" />
          </div>
          <div>
            <h1 className="font-bold text-lg tracking-tight leading-none text-white flex items-center gap-1.5">
              ResiHub
              <span className="text-[10px] uppercase font-bold tracking-widest bg-primary-500/20 text-primary-300 px-1.5 py-0.5 rounded border border-primary-500/30">
                MVP
              </span>
            </h1>
            <p className="text-[11px] text-slate-400 mt-0.5">Quản lý Bất động sản</p>
          </div>
        </div>

        {/* User Role Context (Cố định từ CSDL - Không thể thay đổi) */}
        <div className="px-4 py-3 bg-slate-950/60 border-b border-slate-800/80">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 mb-1.5 flex items-center justify-between">
            <span>Vai trò tài khoản</span>
            <Shield className="w-3.5 h-3.5 text-primary-400" />
          </div>
          <div className="flex items-center gap-2.5 px-3 py-2 bg-slate-800/90 border border-slate-700/80 rounded-xl text-xs font-semibold text-slate-200 shadow-inner">
            <span className="w-2 h-2 rounded-full bg-emerald-400 flex-shrink-0"></span>
            <span className="truncate">
              {currentRoleInfo?.name ? `${currentRoleInfo.name} (${currentRole})` : currentRole}
            </span>
          </div>
        </div>

        {/* Navigation Links */}
        <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto">
          <div className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold px-3 mb-2">
            Danh mục chính
          </div>
          {visibleNavItems.length === 0 ? (
            <div className="px-3 py-6 text-center text-xs text-slate-400 bg-slate-800/40 rounded-xl border border-slate-800 mx-2">
              <Shield className="w-6 h-6 mx-auto mb-2 text-slate-500" />
              <p className="font-semibold text-slate-300">Tài khoản Cư dân</p>
              <p className="text-[11px] text-slate-400 mt-1">
                Không có quyền truy cập vào các phân hệ Quản trị Bất động sản.
              </p>
            </div>
          ) : (
            visibleNavItems.map((item) => {
              const Icon = item.icon;
              return (
                <NavLink
                  key={item.path}
                  to={item.path}
                  onClick={onClose}
                  className={({ isActive }) =>
                    `flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all duration-150 ${
                      isActive
                        ? 'bg-primary-600 text-white shadow-sm shadow-primary-600/30'
                        : 'text-slate-300 hover:text-white hover:bg-slate-800/80'
                    }`
                  }
                >
                  <Icon className="w-4 h-4 flex-shrink-0" />
                  <span>{item.name}</span>
                </NavLink>
              );
            })
          )}
        </nav>


        {/* User Footer & Logout */}
        <div className="p-3 border-t border-slate-800 bg-slate-950/40">
          <div className="flex items-center justify-between px-2 py-1.5">
            <div className="flex items-center gap-2.5 overflow-hidden">
              <div className="w-8 h-8 rounded-full bg-slate-800 flex items-center justify-center text-slate-300 text-xs font-bold border border-slate-700 flex-shrink-0">
                {user?.full_name ? user.full_name.charAt(0) : 'U'}
              </div>
              <div className="overflow-hidden">
                <div className="text-xs font-semibold text-white truncate">
                  {user?.full_name || 'Quản lý viên'}
                </div>
                <div className="text-[11px] text-slate-400 truncate">
                  {user?.phone || '0901234567'}
                </div>
              </div>
            </div>

            <button
              onClick={logout}
              title="Đăng xuất"
              className="p-1.5 rounded-lg text-slate-400 hover:text-red-400 hover:bg-red-500/10 transition-colors"
            >
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        </div>
      </aside>
    </>
  );
}
