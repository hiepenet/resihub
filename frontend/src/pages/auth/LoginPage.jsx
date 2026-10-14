import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Building2, Phone, KeyRound, ArrowRight, ShieldCheck, RefreshCw } from 'lucide-react';
import Button from '../../components/ui/Button';
import Input from '../../components/ui/Input';
import FormField from '../../components/ui/FormField';
import api from '../../services/api';
import { useAuthStore } from '../../stores/authStore';

export default function LoginPage() {
  const navigate = useNavigate();
  const { setAuthData, isAuthenticated } = useAuthStore();

  const [step, setStep] = useState(1); // 1: Phone, 2: OTP
  const [phone, setPhone] = useState('0901234567');
  const [otp, setOtp] = useState('');
  const [devOtpHint, setDevOtpHint] = useState('');
  const [countdown, setCountdown] = useState(300); // 5 mins
  const [resendCooldown, setResendCooldown] = useState(60);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');

  // Countdown timer for OTP expiry
  useEffect(() => {
    let timer;
    if (step === 2 && countdown > 0) {
      timer = setInterval(() => setCountdown((c) => c - 1), 1000);
    }
    return () => clearInterval(timer);
  }, [step, countdown]);

  // Resend cooldown timer
  useEffect(() => {
    let timer;
    if (step === 2 && resendCooldown > 0) {
      timer = setInterval(() => setResendCooldown((c) => c - 1), 1000);
    }
    return () => clearInterval(timer);
  }, [step, resendCooldown]);

  const handleRequestOtp = async (e) => {
    e?.preventDefault();
    setError('');

    if (!phone || phone.trim().length < 10) {
      setError('Vui lòng nhập số điện thoại hợp lệ (10 chữ số).');
      return;
    }

    setIsLoading(true);
    try {
      const res = await api.post('/api/v1/auth/otp/request', { phone });
      if (res.data?.devOtp) {
        setDevOtpHint(res.data.devOtp);
        setOtp(res.data.devOtp); // Auto-fill in dev for convenience!
      }
      setStep(2);
      setCountdown(300);
      setResendCooldown(60);
    } catch (err) {
      setError(err.response?.data?.message || 'Không thể gửi mã OTP. Vui lòng thử lại.');
    } finally {
      setIsLoading(false);
    }
  };

  const handleVerifyOtp = async (e) => {
    e?.preventDefault();
    setError('');

    if (!otp || otp.length !== 6) {
      setError('Vui lòng nhập đầy đủ 6 chữ số OTP.');
      return;
    }

    setIsLoading(true);
    try {
      const res = await api.post('/api/v1/auth/otp/verify', { phone, otp });
      const { accessToken, refreshToken, user } = res.data;

      setAuthData(accessToken, refreshToken, user);

      // Redirect by role according to plan
      const roleCodes = user.roles?.map((r) => r.code) || [];
      if (roleCodes.includes('RESIDENT') && roleCodes.length === 1) {
        navigate('/resident/apartment');
      } else {
        navigate('/admin/dashboard');
      }
    } catch (err) {
      setError(err.response?.data?.message || 'Mã OTP không đúng hoặc đã hết hạn.');
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
      {/* Decorative gradient blur */}
      <div className="absolute top-1/4 left-1/2 -translate-x-1/2 w-96 h-96 bg-primary-500/20 rounded-full blur-3xl pointer-events-none" />

      <div className="relative w-full max-w-md bg-white rounded-2xl shadow-2xl border border-slate-100 p-8 sm:p-10 backdrop-blur-sm">
        {/* Logo and Header */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-gradient-to-tr from-primary-600 to-indigo-600 text-white shadow-lg shadow-primary-500/30 mb-4">
            <Building2 className="w-7 h-7" />
          </div>
          <h2 className="text-2xl font-bold text-slate-900 tracking-tight">
            Đăng nhập ResiHub
          </h2>
          <p className="text-xs text-slate-500 mt-1.5">
            Hệ thống Quản lý Bất động sản & Căn hộ Dịch vụ
          </p>
        </div>

        {/* Step 1: Input Phone */}
        {step === 1 && (
          <form onSubmit={handleRequestOtp} className="space-y-5">
            <FormField
              label="Số điện thoại đăng nhập"
              required
              hint="Nhập số điện thoại đã được đăng ký hoặc số test (vd: 0901234567)"
              error={error}
            >
              <Input
                type="tel"
                placeholder="090 123 4567"
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
              <span>Bảo mật theo tiêu chuẩn OTP SMS & JWT</span>
            </div>
          </form>
        )}

        {/* Step 2: Input OTP */}
        {step === 2 && (
          <form onSubmit={handleVerifyOtp} className="space-y-5">
            <div className="text-center p-3 bg-slate-50 rounded-xl border border-slate-100 mb-2">
              <p className="text-xs text-slate-500">Mã xác thực đã được gửi đến số</p>
              <p className="text-sm font-bold text-slate-800 mt-0.5">{phone}</p>
            </div>

            {devOtpHint && (
              <div className="p-3 bg-amber-50 rounded-xl border border-amber-200 text-amber-900 text-xs flex items-center justify-between">
                <span>Mã OTP giả lập (Dev): <strong>{devOtpHint}</strong></span>
                <span className="text-[10px] bg-amber-200 px-2 py-0.5 rounded font-mono font-bold">MOCK SMS</span>
              </div>
            )}

            <FormField
              label="Nhập mã OTP 6 số"
              required
              hint={`Hiệu lực còn lại: ${formatCountdown(countdown)}`}
              error={error}
            >
              <Input
                type="text"
                maxLength={6}
                placeholder="------"
                value={otp}
                onChange={(e) => setOtp(e.target.value.replace(/\D/g, ''))}
                leftIcon={KeyRound}
                className="text-center text-lg tracking-widest font-mono font-bold"
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
                onClick={() => setStep(1)}
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
      </div>
    </div>
  );
}
