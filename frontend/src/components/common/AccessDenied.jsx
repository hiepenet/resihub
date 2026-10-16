import React from 'react';
import { ShieldAlert, ArrowLeft, LogOut, CheckCircle2 } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '../../stores/authStore';
import Button from '../ui/Button';

const ROLE_NAMES = {
  OWNER: 'Chủ đầu tư / Chủ nhà (OWNER)',
  MANAGER: 'Quản lý tòa nhà (MANAGER)',
  ACCOUNTANT: 'Kế toán (ACCOUNTANT)',
  STAFF: 'Nhân viên vận hành (STAFF)',
  RESIDENT: 'Cư dân (RESIDENT)',
  SYS_ADMIN: 'Quản trị viên hệ thống (SYS_ADMIN)',
};

export default function AccessDenied({ allowedRoles = [], currentRole }) {
  const navigate = useNavigate();
  const { user, getCurrentRole, logout } = useAuthStore();

  const role = currentRole || getCurrentRole() || user?.roles?.[0]?.code || 'RESIDENT';

  return (
    <div className="min-h-[70vh] flex items-center justify-center p-4">
      <div className="max-w-lg w-full bg-white rounded-3xl border border-slate-200/90 shadow-xl p-8 sm:p-10 text-center relative overflow-hidden">
        {/* Top Decorative Banner */}
        <div className="absolute top-0 left-0 right-0 h-2 bg-gradient-to-r from-amber-500 via-rose-500 to-red-600" />

        {/* Shield Icon with glowing ring */}
        <div className="mx-auto w-20 h-20 rounded-2xl bg-gradient-to-tr from-amber-100 to-rose-100 border border-amber-200 flex items-center justify-center text-amber-600 shadow-inner mb-6">
          <ShieldAlert className="w-10 h-10" />
        </div>

        <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-rose-50 border border-rose-200 text-rose-700 text-xs font-bold uppercase tracking-wider mb-3">
          Lỗi 403 · Không có quyền truy cập
        </div>

        <h2 className="text-2xl font-extrabold text-slate-900 tracking-tight">
          Khu vực hạn chế quyền
        </h2>

        <p className="text-sm text-slate-600 mt-2 leading-relaxed">
          Tài khoản của bạn hiện có vai trò cố định là{' '}
          <strong className="text-slate-900 font-bold bg-slate-100 px-2 py-0.5 rounded border border-slate-200">
            {ROLE_NAMES[role] || role}
          </strong>
          , không đủ thẩm quyền để truy cập hoặc thực hiện thao tác trên trang này.
        </p>

        {allowedRoles.length > 0 && (
          <div className="mt-6 p-4 rounded-xl bg-slate-50 border border-slate-200/80 text-left">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 block mb-2">
              Vai trò được phép truy cập theo phân quyền PRD:
            </span>
            <div className="flex flex-wrap gap-2">
              {allowedRoles.map((r) => (
                <span
                  key={r}
                  className="px-2.5 py-1 rounded-lg bg-white border border-slate-300 text-xs font-semibold text-slate-700 shadow-2xs"
                >
                  {ROLE_NAMES[r] || r}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Action Controls */}
        <div className="mt-8 flex flex-col sm:flex-row items-center justify-center gap-3">
          <Button
            variant="secondary"
            size="md"
            onClick={() => navigate('/admin/dashboard')}
            leftIcon={ArrowLeft}
            className="w-full sm:w-auto"
          >
            Về Dashboard
          </Button>

          <Button
            variant="ghost"
            size="md"
            onClick={logout}
            leftIcon={LogOut}
            className="w-full sm:w-auto text-slate-500 hover:text-red-600"
          >
            Đăng xuất
          </Button>
        </div>
      </div>
    </div>
  );
}
