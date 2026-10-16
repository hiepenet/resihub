import React from 'react';
import { Outlet, useNavigate } from 'react-router-dom';
import { Building2, LogOut, PhoneCall, Bell, Shield, User, Home, Sparkles } from 'lucide-react';
import { useAuthStore } from '../../stores/authStore';

export default function ResidentLayout() {
  const navigate = useNavigate();
  const { user, logout } = useAuthStore();

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  const displayName = user?.name || user?.full_name || 'Cư dân';
  const displayPhone = user?.phone || '';

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col font-sans text-slate-800">
      {/* Resident Portal Topbar */}
      <header className="sticky top-0 z-40 bg-white border-b border-slate-200 shadow-sm">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
          {/* Logo & Portal Badge */}
          <div className="flex items-center space-x-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-indigo-600 to-violet-500 flex items-center justify-center text-white shadow-md shadow-indigo-100">
              <Building2 className="w-5 h-5" />
            </div>
            <div className="flex flex-col">
              <div className="flex items-center space-x-2">
                <span className="text-lg font-bold bg-gradient-to-r from-slate-900 via-indigo-950 to-indigo-700 bg-clip-text text-transparent">
                  ResiHub
                </span>
                <span className="text-xs px-2 py-0.5 rounded-full font-semibold bg-indigo-50 text-indigo-700 border border-indigo-200/60">
                  Cổng Cư Dân
                </span>
              </div>
              <span className="text-[11px] text-slate-500 hidden sm:inline">
                Hệ thống Quản lý Dịch vụ Căn hộ
              </span>
            </div>
          </div>

          {/* Right actions: Support hotline, Profile & Logout */}
          <div className="flex items-center space-x-3 sm:space-x-4">
            {/* Hotline chip */}
            <a
              href="tel:0901234567"
              className="hidden md:flex items-center space-x-1.5 px-3 py-1.5 rounded-lg bg-emerald-50 text-emerald-700 hover:bg-emerald-100 transition-colors text-xs font-medium border border-emerald-200/60"
              title="Tổng đài hỗ trợ cư dân 24/7"
            >
              <PhoneCall className="w-3.5 h-3.5" />
              <span>Hotline BQL: 0901.234.567</span>
            </a>

            {/* User Info chip */}
            <div className="flex items-center space-x-2.5 pl-2 sm:border-l sm:border-slate-200">
              <div className="w-9 h-9 rounded-full bg-indigo-100 text-indigo-700 font-bold flex items-center justify-center text-sm border border-indigo-200">
                {displayName.charAt(0).toUpperCase()}
              </div>
              <div className="hidden sm:flex flex-col text-left">
                <span className="text-xs font-semibold text-slate-800 leading-tight">
                  {displayName}
                </span>
                <span className="text-[11px] text-slate-500 font-mono">
                  {displayPhone || 'Tài khoản Cư dân'}
                </span>
              </div>
            </div>

            {/* Logout button */}
            <button
              id="btn-resident-logout"
              onClick={handleLogout}
              className="p-2 rounded-lg text-slate-500 hover:text-red-600 hover:bg-red-50 transition-colors"
              title="Đăng xuất"
            >
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        </div>
      </header>

      {/* Main Content Area */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-6 sm:py-8">
        <Outlet />
      </main>

      {/* Footer */}
      <footer className="bg-white border-t border-slate-200 py-6 mt-auto">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 flex flex-col sm:flex-row items-center justify-between text-xs text-slate-500 gap-4">
          <div className="flex items-center space-x-2">
            <span className="font-semibold text-slate-700">ResiHub Resident Portal v2.0</span>
            <span>•</span>
            <span>Dành riêng cho khách thuê và cư dân căn hộ</span>
          </div>
          <div className="flex items-center space-x-4">
            <span>Hỗ trợ kỹ thuật: 1900 6868</span>
            <span>•</span>
            <span>Bảo mật & Điều khoản</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
