import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Building2,
  Phone,
  KeyRound,
  Mail,
  Lock,
  ArrowRight,
  ShieldCheck,
  RefreshCw,
  Eye,
  EyeOff,
  UserCheck,
} from 'lucide-react';
import Button from '../../components/ui/Button';
import Input from '../../components/ui/Input';
import FormField from '../../components/ui/FormField';
import api from '../../services/api';
import { useAuthStore } from '../../stores/authStore';

export default function LoginPage() {
  const navigate = useNavigate();
  const { setAuthData } = useAuthStore();

  // Active Login Method: 'otp' (NV-01) or 'password' (NV-02)
  const [authMethod, setAuthMethod] = useState('otp');

  // NV-01: OTP State
  const [step, setStep] = useState(1); // 1: Phone, 2: OTP
  const [phone, setPhone] = useState('0977930202');
  const [otp, setOtp] = useState('');
  const [devOtpHint, setDevOtpHint] = useState('');
  const [countdown, setCountdown] = useState(300); // 5 mins
  const [resendCooldown, setResendCooldown] = useState(60);

  // NV-02: Email/Password State
  const [email, setEmail] = useState('manager@resihub.vn');
  const [password, setPassword] = useState('password123');
  const [showPassword, setShowPassword] = useState(false);

  // Shared Form State
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');

  // Chuẩn hóa số điện thoại 10 chữ số
  const cleanPhoneNumber = (input) => {
    let cleaned = (input || '').toString().trim().replace(/[\s\-\.\(\)]/g, '');
    if (cleaned.startsWith('+84')) {
      cleaned = '0' + cleaned.slice(3);
    } else if (cleaned.startsWith('84') && cleaned.length === 11) {
      cleaned = '0' + cleaned.slice(2);
    }
    return cleaned;
  };

  // Countdown timer for OTP expiry (5 mins)
  useEffect(() => {
    let timer;
    if (authMethod === 'otp' && step === 2 && countdown > 0) {
      timer = setInterval(() => setCountdown((c) => c - 1), 1000);
    }
    return () => clearInterval(timer);
  }, [authMethod, step, countdown]);

  // Resend cooldown timer (60s)
  useEffect(() => {
    let timer;
    if (authMethod === 'otp' && step === 2 && resendCooldown > 0) {
      timer = setInterval(() => setResendCooldown((c) => c - 1), 1000);
    }
    return () => clearInterval(timer);
  }, [authMethod, step, resendCooldown]);

  // Handle redirect by user roles
  const redirectByRole = (user) => {
    const roleCodes = user.roles?.map((r) => (typeof r === 'string' ? r : r.code)) || [];
    if (roleCodes.includes('RESIDENT') && !roleCodes.includes('MANAGER') && !roleCodes.includes('OWNER')) {
      navigate('/resident');
    } else {
      navigate('/admin/dashboard');
    }
  };

  /**
   * NV-01: Gửi yêu cầu mã OTP
   */
  const handleRequestOtp = async (e) => {
    e?.preventDefault();
    setError('');

    const normalized = cleanPhoneNumber(phone);
    if (!normalized || !/^0[0-9]{9}$/.test(normalized)) {
      setError('Vui lòng nhập đúng số điện thoại 10 chữ số (bắt đầu bằng 0, ví dụ: 0977930202).');
      return;
    }

    setIsLoading(true);
    try {
      const res = await api.post('/api/v1/auth/otp/request', { phone: normalized });
      if (res.data?.devOtp) {
        setDevOtpHint(res.data.devOtp);
        setOtp(res.data.devOtp); // Auto-fill test code in dev
      }
      setPhone(normalized);
      setStep(2);
      setCountdown(300);
      setResendCooldown(60);
    } catch (err) {
      setError(err.response?.data?.message || 'Không thể gửi mã OTP. Vui lòng thử lại.');
    } finally {
      setIsLoading(false);
    }
  };

  /**
   * NV-01: Xác thực mã OTP
   */
  const handleVerifyOtp = async (e) => {
    e?.preventDefault();
    setError('');

    const normalized = cleanPhoneNumber(phone);
    if (!otp || otp.length !== 6) {
      setError('Vui lòng nhập đủ 6 chữ số OTP.');
      return;
    }

    setIsLoading(true);
    try {
      const res = await api.post('/api/v1/auth/otp/verify', { phone: normalized, otp });
      const { accessToken, refreshToken, user } = res.data;

      setAuthData(accessToken, refreshToken, user);
      redirectByRole(user);
    } catch (err) {
      setError(err.response?.data?.message || 'Mã OTP không đúng hoặc đã hết hạn.');
    } finally {
      setIsLoading(false);
    }
  };

  /**
   * NV-02: Đăng nhập Email & Mật khẩu (Nhân viên nội bộ)
   */
  const handlePasswordLogin = async (e) => {
    e?.preventDefault();
    setError('');

    if (!email || !password) {
      setError('Vui lòng nhập đầy đủ email và mật khẩu.');
      return;
    }

    if (password.length < 8) {
      setError('Mật khẩu phải có tối thiểu 8 ký tự.');
      return;
    }

    setIsLoading(true);
    try {
      const res = await api.post('/api/v1/auth/login', { email, password });
      const { accessToken, refreshToken, user } = res.data;

      setAuthData(accessToken, refreshToken, user);
      redirectByRole(user);
    } catch (err) {
      setError(err.response?.data?.message || 'Email hoặc mật khẩu không chính xác.');
    } finally {
      setIsLoading(false);
    }
  };

  const formatCountdown = (secs) => {
    const mins = Math.floor(secs / 60);
    const remainder = secs % 60;
    return `${mins.toString().padStart(2, '0')}:${remainder.toString().padStart(2, '0')}`;
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-900 via-slate-800 to-indigo-950 p-4">
      {/* Decorative gradient blur background */}
      <div className="absolute top-1/4 left-1/2 -translate-x-1/2 w-96 h-96 bg-primary-500/20 rounded-full blur-3xl pointer-events-none" />

      <div className="relative w-full max-w-md bg-white rounded-2xl shadow-2xl border border-slate-100 p-8 sm:p-10 backdrop-blur-sm">
        {/* Brand Header */}
        <div className="text-center mb-6">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-gradient-to-tr from-primary-600 to-indigo-600 text-white shadow-lg shadow-primary-500/30 mb-3">
            <Building2 className="w-7 h-7" />
          </div>
          <h2 className="text-2xl font-bold text-slate-900 tracking-tight">
            Đăng nhập ResiHub
          </h2>
          <p className="text-xs text-slate-500 mt-1">
            Nền tảng Quản lý Bất động sản & Căn hộ Dịch vụ
          </p>
        </div>

        {/* Tab Switcher: NV-01 (OTP) vs NV-02 (Email/Password) */}
        <div className="flex bg-slate-100 p-1 rounded-xl mb-6 text-xs font-semibold">
          <button
            id="tab-otp"
            type="button"
            onClick={() => {
              setAuthMethod('otp');
              setError('');
            }}
            className={`flex-1 py-2 rounded-lg flex items-center justify-center gap-1.5 transition-all duration-150 ${
              authMethod === 'otp'
                ? 'bg-white text-slate-900 shadow-sm'
                : 'text-slate-500 hover:text-slate-800'
            }`}
          >
            <Phone className="w-3.5 h-3.5" />
            <span>Mã OTP (SĐT)</span>
          </button>

          <button
            id="tab-password"
            type="button"
            onClick={() => {
              setAuthMethod('password');
              setError('');
            }}
            className={`flex-1 py-2 rounded-lg flex items-center justify-center gap-1.5 transition-all duration-150 ${
              authMethod === 'password'
                ? 'bg-white text-slate-900 shadow-sm'
                : 'text-slate-500 hover:text-slate-800'
            }`}
          >
            <Mail className="w-3.5 h-3.5" />
            <span>Nhân viên (Email)</span>
          </button>
        </div>

        {/* Error Notification */}
        {error && (
          <div className="mb-5 p-3 rounded-xl bg-red-50 border border-red-200 text-xs text-red-700 flex items-start gap-2">
            <span className="flex-shrink-0 font-bold">⚠️</span>
            <span>{error}</span>
          </div>
        )}

        {/* ================================================================= */}
        {/* NV-01: ĐĂNG NHẬP OTP (Cư dân & Nhân viên qua SĐT)                 */}
        {/* ================================================================= */}
        {authMethod === 'otp' && (
          <>
            {/* Step 1: Input Phone */}
            {step === 1 && (
              <form onSubmit={handleRequestOtp} className="space-y-5">
                <FormField
                  label="Số điện thoại nhận OTP"
                  required
                  hint="Nhập bất kỳ SĐT 10 chữ số (vd: 0977930202) để nhận mock OTP và vào tài khoản Cư dân"
                >
                  <Input
                    type="tel"
                    placeholder="0977930202"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    leftIcon={Phone}
                    autoFocus
                  />
                </FormField>

                <Button
                  type="submit"
                  className="w-full py-2.5"
                  isLoading={isLoading}
                  rightIcon={ArrowRight}
                >
                  Gửi mã xác thực OTP
                </Button>

                <div className="pt-2 text-center text-xs text-slate-400 flex items-center justify-center gap-1.5">
                  <ShieldCheck className="w-4 h-4 text-emerald-500" />
                  <span>Tự động kích hoạt tài khoản Cư dân cho mọi số 10 chữ số</span>
                </div>
              </form>
            )}

            {/* Step 2: Input 6-digit OTP */}
            {step === 2 && (
              <form onSubmit={handleVerifyOtp} className="space-y-5">
                <div className="text-center p-3 bg-slate-50 rounded-xl border border-slate-100 mb-1">
                  <p className="text-xs text-slate-500">Mã xác thực 6 số đã gửi tới</p>
                  <p className="text-sm font-bold text-slate-800 mt-0.5">{phone}</p>
                </div>

                {devOtpHint && (
                  <div className="p-3 bg-emerald-50 rounded-xl border border-emerald-200 text-emerald-900 text-xs flex items-center justify-between">
                    <span>Mã OTP giả lập (Dev): <strong className="font-mono text-sm text-emerald-700">{devOtpHint}</strong></span>
                    <span className="text-[10px] bg-emerald-200 text-emerald-800 px-2 py-0.5 rounded font-mono font-bold">TỰ ĐỘNG ĐIỀN</span>
                  </div>
                )}

                <FormField
                  label="Nhập mã OTP 6 số"
                  required
                  hint={`Hiệu lực còn lại: ${formatCountdown(countdown)}`}
                >
                  <Input
                    type="text"
                    maxLength={6}
                    placeholder="------"
                    value={otp}
                    onChange={(e) => setOtp(e.target.value.replace(/\D/g, ''))}
                    leftIcon={KeyRound}
                    className="text-center text-xl tracking-widest font-mono font-bold"
                    autoFocus
                  />
                </FormField>

                <Button
                  type="submit"
                  className="w-full py-2.5"
                  isLoading={isLoading}
                >
                  Xác thực & Đăng nhập
                </Button>

                <div className="flex items-center justify-between pt-2 text-xs">
                  <button
                    type="button"
                    onClick={() => {
                      setStep(1);
                      setError('');
                    }}
                    className="text-slate-500 hover:text-slate-800 font-medium"
                  >
                    ← Đổi số điện thoại
                  </button>

                  <button
                    type="button"
                    disabled={resendCooldown > 0 || isLoading}
                    onClick={handleRequestOtp}
                    className="text-primary-600 hover:text-primary-700 font-semibold disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1"
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                    {resendCooldown > 0 ? `Gửi lại sau ${resendCooldown}s` : 'Gửi lại OTP'}
                  </button>
                </div>
              </form>
            )}
          </>
        )}

        {/* ================================================================= */}
        {/* NV-02: ĐĂNG NHẬP EMAIL/MẬT KHẨU (Nhân viên nội bộ)               */}
        {/* ================================================================= */}
        {authMethod === 'password' && (
          <form onSubmit={handlePasswordLogin} className="space-y-4">
            <FormField label="Email nhân sự" required>
              <Input
                type="email"
                placeholder="manager@resihub.vn"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                leftIcon={Mail}
                autoFocus
              />
            </FormField>

            <FormField label="Mật khẩu (≥ 8 ký tự)" required>
              <div className="relative">
                <Input
                  type={showPassword ? 'text' : 'password'}
                  placeholder="••••••••"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  leftIcon={Lock}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </FormField>

            <div className="p-3 bg-slate-50 rounded-xl border border-slate-100 text-xs text-slate-500 space-y-2">
              <div className="flex items-center justify-between font-semibold text-slate-700">
                <span>💡 Tài khoản kiểm thử theo vai trò cố định:</span>
                <span className="text-[10px] bg-slate-200 px-1.5 py-0.5 rounded font-mono">pass: password123</span>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-[11px]">
                <button
                  id="btn-quick-owner"
                  type="button"
                  onClick={() => { setEmail('owner@resihub.vn'); setPassword('password123'); }}
                  className="p-2 rounded-xl bg-white hover:bg-slate-100 border border-slate-200 text-left transition shadow-xs"
                >
                  <strong className="text-amber-600 block font-bold">OWNER</strong>
                  <span className="text-slate-400 text-[10px]">Chủ sở hữu</span>
                </button>
                <button
                  id="btn-quick-manager"
                  type="button"
                  onClick={() => { setEmail('manager@resihub.vn'); setPassword('password123'); }}
                  className="p-2 rounded-xl bg-white hover:bg-slate-100 border border-slate-200 text-left transition shadow-xs"
                >
                  <strong className="text-indigo-600 block font-bold">MANAGER</strong>
                  <span className="text-slate-400 text-[10px]">Quản lý tòa</span>
                </button>
                <button
                  id="btn-quick-resident"
                  type="button"
                  onClick={() => { setEmail('resident@resihub.vn'); setPassword('password123'); }}
                  className="p-2 rounded-xl bg-white hover:bg-slate-100 border border-slate-200 text-left transition shadow-xs"
                >
                  <strong className="text-purple-600 block font-bold truncate">CƯ DÂN (Chưa HĐ)</strong>
                  <span className="text-slate-400 text-[10px]">Cọc phòng A202</span>
                </button>
                <button
                  id="btn-quick-resident-active"
                  type="button"
                  onClick={() => { setEmail('resident_active@resihub.vn'); setPassword('password123'); }}
                  className="p-2 rounded-xl bg-white hover:bg-slate-100 border border-slate-200 text-left transition shadow-xs"
                >
                  <strong className="text-emerald-600 block font-bold truncate">CƯ DÂN (Đã ký HĐ)</strong>
                  <span className="text-slate-400 text-[10px]">Đang thuê A102</span>
                </button>
              </div>
            </div>

            <Button
              id="btn-submit-password-login"
              type="submit"
              className="w-full py-2.5 mt-2"
              isLoading={isLoading}
              leftIcon={UserCheck}
            >
              Đăng nhập Quản trị viên
            </Button>
          </form>
        )}
      </div>
    </div>
  );
}
