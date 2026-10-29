import React, { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  Home,
  Mail,
  Lock,
  Phone,
  KeyRound,
  Eye,
  EyeOff,
  Building2,
  ShieldCheck,
  Sparkles,
  ArrowRight,
} from 'lucide-react';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { authService } from '../../services/auth.service';
import { useAuthStore } from '../../stores/authStore';
import { useToast } from '../../hooks/useToast';
import { isAdminPortalUser } from '../../utils/permissions';
import { extractErrorMessage, isValidPhone, normalizePhone } from '../../utils/validation';

const DEMO_ACCOUNTS = [
  { label: 'Quản trị (SYS_ADMIN)', email: 'admin@resihub.vn', pass: 'Admin@123456' },
  { label: 'Chủ đầu tư Ocean Park', email: 'owner.vop@resihub.vn', pass: 'Demo@123456' },
  { label: 'Quản lý Tòa VOP-A', email: 'manager.vop.a@resihub.vn', pass: 'Demo@123456' },
  { label: 'Cư dân mẫu', email: 'tenant1@resihub.vn', pass: 'Demo@123456' },
];

export function LoginPage() {
  const navigate = useNavigate();
  const toast = useToast();
  const setAuthData = useAuthStore((s) => s.setAuthData);
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const user = useAuthStore((s) => s.user);

  const [mode, setMode] = useState('email'); // 'email' | 'otp'
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);

  const [phone, setPhone] = useState('');
  const [otp, setOtp] = useState('');
  const [otpStep, setOtpStep] = useState('request'); // 'request' | 'verify'
  const [countdown, setCountdown] = useState(0);
  const [devOtpHint, setDevOtpHint] = useState('');

  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (isAuthenticated && user) {
      navigate(isAdminPortalUser(user) ? '/admin/dashboard' : '/resident', { replace: true });
    }
  }, [isAuthenticated, user, navigate]);

  useEffect(() => {
    if (countdown <= 0) return undefined;
    const t = setTimeout(() => setCountdown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [countdown]);

  const handleLoginSuccess = (res) => {
    setAuthData(res.accessToken, res.refreshToken, res.user);
    toast.success(`Xin chào ${res.user?.full_name || 'bạn'}!`);
    navigate(isAdminPortalUser(res.user) ? '/admin/dashboard' : '/resident', { replace: true });
  };

  const handleEmailSubmit = async (e) => {
    e.preventDefault();
    if (!email.trim() || !password) {
      toast.warning('Vui lòng nhập đầy đủ Email và Mật khẩu.');
      return;
    }
    setLoading(true);
    try {
      const res = await authService.loginEmail(email.trim(), password);
      handleLoginSuccess(res);
    } catch (err) {
      toast.error(extractErrorMessage(err, 'Đăng nhập thất bại.'));
    } finally {
      setLoading(false);
    }
  };

  const handleRequestOtp = async (e) => {
    e.preventDefault();
    if (!isValidPhone(phone)) {
      toast.warning('Vui lòng nhập số điện thoại 10 chữ số hợp lệ (ví dụ: 0912345678).');
      return;
    }
    setLoading(true);
    try {
      const clean = normalizePhone(phone);
      const res = await authService.requestOtp(clean);
      toast.info(res.message || 'Nếu số điện thoại đã đăng ký, mã OTP đã được gửi.');
      setDevOtpHint(res.devOtp || '');
      setOtpStep('verify');
      setCountdown(60);
    } catch (err) {
      toast.error(extractErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  const handleVerifyOtp = async (e) => {
    e.preventDefault();
    if (!otp.trim()) {
      toast.warning('Vui lòng nhập mã OTP gồm 6 chữ số.');
      return;
    }
    setLoading(true);
    try {
      const clean = normalizePhone(phone);
      const res = await authService.verifyOtp(clean, otp.trim());
      handleLoginSuccess(res);
    } catch (err) {
      toast.error(extractErrorMessage(err, 'Mã OTP không chính xác hoặc số điện thoại chưa được đăng ký.'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen grid grid-cols-1 lg:grid-cols-12 bg-slate-50">
      {/* Left Showcase Panel */}
      <div className="hidden lg:flex lg:col-span-6 xl:col-span-7 bg-gradient-to-br from-slate-900 via-sky-950 to-indigo-950 text-white p-12 flex-col justify-between relative overflow-hidden">
        <div className="absolute -top-24 -right-24 w-96 h-96 rounded-full bg-primary-500/15 blur-3xl pointer-events-none" />
        <div className="absolute bottom-0 left-0 w-80 h-80 rounded-full bg-secondary-500/20 blur-3xl pointer-events-none" />

        <div className="relative z-10 flex items-center gap-3">
          <div className="w-11 h-11 rounded-2xl bg-gradient-to-br from-primary-400 to-secondary-500 flex items-center justify-center shadow-lg">
            <Home className="w-6 h-6 text-white" />
          </div>
          <div>
            <h1 className="text-xl font-bold tracking-tight">ResiHub</h1>
            <p className="text-xs text-sky-300">Nền tảng Quản lý Căn hộ & Nhà cho thuê v2.0</p>
          </div>
        </div>

        <div className="relative z-10 max-w-xl space-y-6">
          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-white/10 border border-white/15 text-xs font-medium text-sky-200">
            <Sparkles className="w-3.5 h-3.5 text-sky-400" />
            Chuẩn hóa toàn diện theo đặc tả PRD v2.0
          </span>
          <h2 className="text-3xl xl:text-4xl font-bold leading-tight">
            Vận hành chuỗi tòa nhà thông minh, minh bạch từ Hợp đồng đến Sổ cọc.
          </h2>
          <p className="text-sm text-slate-300 leading-relaxed">
            Phân quyền đa tầng (RLS PostgreSQL) tách biệt tuyệt đối giữa Chủ đầu tư, Quản lý từng tòa và Cổng cư dân trực tuyến.
          </p>

          <div className="grid grid-cols-2 gap-4 pt-2">
            <div className="p-4 rounded-2xl bg-white/5 border border-white/10">
              <Building2 className="w-5 h-5 text-sky-400 mb-2" />
              <p className="text-sm font-semibold">Sơ đồ tầng trực quan</p>
              <p className="text-xs text-slate-400 mt-0.5">Kiểm soát trạng thái phòng, giữ chỗ và bàn giao thời gian thực.</p>
            </div>
            <div className="p-4 rounded-2xl bg-white/5 border border-white/10">
              <ShieldCheck className="w-5 h-5 text-emerald-400 mb-2" />
              <p className="text-sm font-semibold">Đối soát cọc Four-Eyes</p>
              <p className="text-xs text-slate-400 mt-0.5">Tách bạch tiền thuê & tiền cọc, phê duyệt hoàn cọc minh bạch.</p>
            </div>
          </div>
        </div>

        <p className="relative z-10 text-xs text-slate-400">
          © {new Date().getFullYear()} ResiHub Property Management System.
        </p>
      </div>

      {/* Right Form Panel */}
      <div className="lg:col-span-6 xl:col-span-5 flex items-center justify-center p-6 sm:p-10">
        <div className="w-full max-w-md space-y-6">
          <div className="lg:hidden flex items-center gap-2.5 mb-2">
            <div className="w-9 h-9 rounded-xl bg-primary-500 flex items-center justify-center text-white">
              <Home className="w-5 h-5" />
            </div>
            <span className="text-lg font-bold text-slate-900">ResiHub</span>
          </div>

          <div>
            <h2 className="text-2xl font-bold text-slate-900">Đăng nhập hệ thống</h2>
            <p className="text-sm text-slate-500 mt-1">
              Chọn phương thức đăng nhập phù hợp với vai trò của bạn.
            </p>
          </div>

          {/* Mode Switcher */}
          <div className="grid grid-cols-2 p-1 rounded-xl bg-slate-200/70">
            <button
              type="button"
              onClick={() => setMode('email')}
              className={`py-2 text-xs font-semibold rounded-lg transition-all ${
                mode === 'email' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              Email & Mật khẩu
            </button>
            <button
              type="button"
              onClick={() => setMode('otp')}
              className={`py-2 text-xs font-semibold rounded-lg transition-all ${
                mode === 'otp' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              Số điện thoại (OTP)
            </button>
          </div>

          {mode === 'email' ? (
            <form onSubmit={handleEmailSubmit} className="bg-white p-6 rounded-2xl border border-slate-200/80 shadow-card space-y-4">
              <Input
                label="Địa chỉ Email"
                type="email"
                icon={Mail}
                required
                placeholder="ten@resihub.vn"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
              <Input
                label="Mật khẩu"
                type={showPassword ? 'text' : 'password'}
                icon={Lock}
                required
                placeholder="Nhập mật khẩu (tối thiểu 8 ký tự)"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                rightElement={
                  <button
                    type="button"
                    onClick={() => setShowPassword((s) => !s)}
                    className="text-slate-400 hover:text-slate-600"
                  >
                    {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                }
              />

              <div className="flex items-center justify-end">
                <Link to="/forgot-password" className="text-xs font-medium text-primary-600 hover:text-primary-700">
                  Quên mật khẩu?
                </Link>
              </div>

              <Button type="submit" size="lg" loading={loading} rightIcon={ArrowRight} className="w-full">
                Đăng nhập
              </Button>
            </form>
          ) : (
            <div className="bg-white p-6 rounded-2xl border border-slate-200/80 shadow-card space-y-4">
              {otpStep === 'request' ? (
                <form onSubmit={handleRequestOtp} className="space-y-4">
                  <Input
                    label="Số điện thoại đã đăng ký"
                    icon={Phone}
                    required
                    placeholder="0912345678"
                    hint="Chỉ các số điện thoại đã được Ban quản lý đăng ký hồ sơ mới nhận được mã OTP."
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                  />
                  <Button type="submit" size="lg" loading={loading} className="w-full">
                    Nhận mã xác thực OTP
                  </Button>
                </form>
              ) : (
                <form onSubmit={handleVerifyOtp} className="space-y-4">
                  <div className="p-3 rounded-xl bg-sky-50 border border-sky-100 text-xs text-sky-800">
                    Nếu SĐT <span className="font-semibold">{normalizePhone(phone)}</span> tồn tại trong hệ thống, mã OTP đã được gửi.
                    {devOtpHint ? (
                      <span className="block mt-1 font-semibold text-primary-700">
                        [Dev Mode] Mã OTP của bạn: {devOtpHint}
                      </span>
                    ) : null}
                  </div>
                  <Input
                    label="Mã OTP (6 chữ số)"
                    icon={KeyRound}
                    required
                    maxLength={6}
                    placeholder="Nhập 6 chữ số OTP"
                    value={otp}
                    onChange={(e) => setOtp(e.target.value)}
                  />
                  <Button type="submit" size="lg" loading={loading} className="w-full">
                    Xác thực & Đăng nhập
                  </Button>
                  <div className="flex items-center justify-between text-xs pt-1">
                    <button
                      type="button"
                      onClick={() => {
                        setOtpStep('request');
                        setOtp('');
                        setDevOtpHint('');
                      }}
                      className="text-slate-500 hover:text-slate-800"
                    >
                      Đổi số điện thoại
                    </button>
                    <button
                      type="button"
                      disabled={countdown > 0 || loading}
                      onClick={handleRequestOtp}
                      className="font-medium text-primary-600 disabled:text-slate-400"
                    >
                      {countdown > 0 ? `Gửi lại sau ${countdown}s` : 'Gửi lại mã OTP'}
                    </button>
                  </div>
                </form>
              )}
            </div>
          )}

          {/* Quick Demo Accounts */}
          <div className="bg-white/70 rounded-2xl border border-slate-200/70 p-4">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 mb-2.5">
              Tài khoản Demo kiểm thử nhanh
            </p>
            <div className="grid grid-cols-2 gap-2">
              {DEMO_ACCOUNTS.map((acc) => (
                <button
                  key={acc.email}
                  type="button"
                  onClick={() => {
                    setMode('email');
                    setEmail(acc.email);
                    setPassword(acc.pass);
                  }}
                  className="text-left px-3 py-2 rounded-xl border border-slate-200 bg-white hover:border-primary-300 hover:bg-primary-50/40 transition-colors"
                >
                  <p className="text-xs font-semibold text-slate-800 truncate">{acc.label}</p>
                  <p className="text-[11px] text-slate-500 truncate">{acc.email}</p>
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default LoginPage;

