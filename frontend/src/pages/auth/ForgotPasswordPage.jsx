import React, { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { Building2, KeyRound, ArrowLeft, Check, AlertCircle, Eye, EyeOff, ShieldCheck } from 'lucide-react';
import Button from '../../components/ui/Button';
import Input from '../../components/ui/Input';
import FormField from '../../components/ui/FormField';
import api from '../../services/api';

export default function ForgotPasswordPage() {
  const navigate = useNavigate();

  // Step 1: 'request' | Step 2: 'reset' | Step 3: 'success'
  const [step, setStep] = useState('request');

  const [identifier, setIdentifier] = useState('');
  const [resetToken, setResetToken] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);

  const [isLoading, setIsLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [mockTokenNotice, setMockTokenNotice] = useState('');

  // Xử lý gửi yêu cầu quên mật khẩu
  const handleRequestReset = async (e) => {
    e.preventDefault();
    setErrorMsg('');
    setMockTokenNotice('');

    if (!identifier.trim()) {
      setErrorMsg('Vui lòng nhập Email hoặc Số điện thoại tài khoản của bạn.');
      return;
    }

    setIsLoading(true);
    try {
      const res = await api.post('/api/v1/auth/forgot-password', {
        identifier: identifier.trim(),
      });

      if (res.data?.reset_token) {
        setMockTokenNotice(res.data.reset_token);
        setResetToken(res.data.reset_token);
      }

      setStep('reset');
    } catch (err) {
      setErrorMsg(err.response?.data?.message || 'Không thể gửi yêu cầu đặt lại mật khẩu.');
    } finally {
      setIsLoading(false);
    }
  };

  // Xử lý xác nhận đổi mật khẩu mới
  const handleResetPassword = async (e) => {
    e.preventDefault();
    setErrorMsg('');

    if (!resetToken.trim()) {
      setErrorMsg('Vui lòng nhập mã xác nhận (OTP/Token).');
      return;
    }

    if (newPassword.length < 8) {
      setErrorMsg('Mật khẩu mới phải có ít nhất 8 ký tự.');
      return;
    }

    if (newPassword !== confirmPassword) {
      setErrorMsg('Mật khẩu mới và xác nhận mật khẩu không khớp.');
      return;
    }

    setIsLoading(true);
    try {
      await api.post('/api/v1/auth/reset-password', {
        identifier: identifier.trim(),
        reset_token: resetToken.trim(),
        new_password: newPassword,
      });

      setStep('success');
    } catch (err) {
      setErrorMsg(err.response?.data?.message || 'Mã xác nhận không đúng hoặc đã hết hạn.');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-indigo-950 to-slate-900 flex flex-col justify-center py-12 sm:px-6 lg:px-8 font-sans">
      <div className="sm:mx-auto sm:w-full sm:max-w-md">
        {/* Brand */}
        <div className="flex items-center justify-center space-x-3 mb-6">
          <div className="w-12 h-12 rounded-2xl bg-gradient-to-tr from-indigo-500 to-indigo-700 flex items-center justify-center text-white shadow-xl shadow-indigo-500/30">
            <Building2 className="w-6 h-6" />
          </div>
          <div>
            <h1 className="text-2xl font-black text-white tracking-tight">ResiHub</h1>
            <p className="text-[11px] text-indigo-200/80 uppercase tracking-widest font-semibold">
              Quản lý Căn hộ Dịch vụ
            </p>
          </div>
        </div>

        {/* Card */}
        <div className="bg-white/95 backdrop-blur-md py-8 px-6 sm:px-10 shadow-2xl rounded-3xl border border-white/20">
          {step === 'request' && (
            <div>
              <div className="mb-6 text-center">
                <div className="w-12 h-12 rounded-2xl bg-indigo-50 text-indigo-600 flex items-center justify-center mx-auto mb-3 border border-indigo-100">
                  <KeyRound className="w-6 h-6" />
                </div>
                <h2 className="text-xl font-bold text-slate-900">Quên mật khẩu?</h2>
                <p className="text-xs text-slate-500 mt-1">
                  Nhập Email hoặc Số điện thoại đã đăng ký để nhận mã khôi phục tài khoản.
                </p>
              </div>

              {errorMsg && (
                <div className="mb-4 p-3 rounded-xl bg-rose-50 border border-rose-200 text-xs text-rose-700 flex items-center gap-2">
                  <AlertCircle className="w-4 h-4 text-rose-600 shrink-0" />
                  <span>{errorMsg}</span>
                </div>
              )}

              <form onSubmit={handleRequestReset} className="space-y-4">
                <FormField label="Email hoặc Số điện thoại" required>
                  <Input
                    type="text"
                    required
                    placeholder="vd: 0901234567 hoặc user@resihub.vn"
                    value={identifier}
                    onChange={(e) => setIdentifier(e.target.value)}
                    autoFocus
                  />
                </FormField>

                <Button
                  type="submit"
                  variant="primary"
                  className="w-full bg-indigo-600 hover:bg-indigo-700 py-2.5 shadow-lg shadow-indigo-600/30 font-semibold text-sm"
                  isLoading={isLoading}
                >
                  Gửi mã khôi phục
                </Button>

                <div className="text-center pt-2">
                  <Link
                    to="/login"
                    className="inline-flex items-center gap-1.5 text-xs text-slate-500 hover:text-slate-800 transition-colors"
                  >
                    <ArrowLeft className="w-3.5 h-3.5" />
                    <span>Quay lại Đăng nhập</span>
                  </Link>
                </div>
              </form>
            </div>
          )}

          {step === 'reset' && (
            <div>
              <div className="mb-6 text-center">
                <div className="w-12 h-12 rounded-2xl bg-indigo-50 text-indigo-600 flex items-center justify-center mx-auto mb-3 border border-indigo-100">
                  <ShieldCheck className="w-6 h-6" />
                </div>
                <h2 className="text-xl font-bold text-slate-900">Đặt lại mật khẩu mới</h2>
                <p className="text-xs text-slate-500 mt-1">
                  Mã xác nhận đã gửi đến <strong>{identifier}</strong>.
                </p>
              </div>

              {mockTokenNotice && (
                <div className="mb-4 p-3 rounded-xl bg-amber-50 border border-amber-200 text-xs text-amber-800 flex flex-col gap-0.5">
                  <span className="font-bold">Mã xác thực giả lập (Môi trường Dev):</span>
                  <span className="font-mono text-sm font-black text-amber-950">{mockTokenNotice}</span>
                </div>
              )}

              {errorMsg && (
                <div className="mb-4 p-3 rounded-xl bg-rose-50 border border-rose-200 text-xs text-rose-700 flex items-center gap-2">
                  <AlertCircle className="w-4 h-4 text-rose-600 shrink-0" />
                  <span>{errorMsg}</span>
                </div>
              )}

              <form onSubmit={handleResetPassword} className="space-y-4">
                <FormField label="Mã xác nhận (OTP/Token 6 số)" required>
                  <Input
                    type="text"
                    required
                    placeholder="123456"
                    value={resetToken}
                    onChange={(e) => setResetToken(e.target.value)}
                    className="font-mono tracking-widest text-center text-base"
                  />
                </FormField>

                <FormField label="Mật khẩu mới (tối thiểu 8 ký tự)" required>
                  <div className="relative">
                    <Input
                      type={showPassword ? 'text' : 'password'}
                      required
                      placeholder="••••••••"
                      value={newPassword}
                      onChange={(e) => setNewPassword(e.target.value)}
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

                <FormField label="Xác nhận mật khẩu mới" required>
                  <Input
                    type={showPassword ? 'text' : 'password'}
                    required
                    placeholder="••••••••"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                  />
                </FormField>

                <Button
                  type="submit"
                  variant="primary"
                  className="w-full bg-indigo-600 hover:bg-indigo-700 py-2.5 shadow-lg shadow-indigo-600/30 font-semibold text-sm"
                  isLoading={isLoading}
                >
                  Xác nhận đổi mật khẩu
                </Button>

                <div className="text-center pt-2">
                  <button
                    type="button"
                    onClick={() => setStep('request')}
                    className="inline-flex items-center gap-1.5 text-xs text-slate-500 hover:text-slate-800 transition-colors"
                  >
                    <ArrowLeft className="w-3.5 h-3.5" />
                    <span>Gửi lại mã khôi phục</span>
                  </button>
                </div>
              </form>
            </div>
          )}

          {step === 'success' && (
            <div className="text-center py-4">
              <div className="w-16 h-16 rounded-3xl bg-emerald-100 text-emerald-600 flex items-center justify-center mx-auto mb-4 border border-emerald-200 shadow-lg shadow-emerald-500/20">
                <Check className="w-8 h-8 stroke-[3]" />
              </div>
              <h2 className="text-xl font-bold text-slate-900">Đổi mật khẩu thành công!</h2>
              <p className="text-xs text-slate-500 mt-2 mb-6 leading-relaxed">
                Mật khẩu của bạn đã được cập nhật thành công. Bạn có thể sử dụng mật khẩu mới để đăng nhập ngay bây giờ.
              </p>

              <Button
                variant="primary"
                className="w-full bg-indigo-600 hover:bg-indigo-700 py-2.5 shadow-lg shadow-indigo-600/30 font-semibold text-sm"
                onClick={() => navigate('/login')}
              >
                Đăng nhập ngay
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
