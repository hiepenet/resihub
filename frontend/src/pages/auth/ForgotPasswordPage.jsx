import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Mail, KeyRound, Lock, ArrowLeft, Home } from 'lucide-react';
import { Input } from '../../components/ui/Input';
import { Button } from '../../components/ui/Button';
import { authService } from '../../services/auth.service';
import { useToast } from '../../hooks/useToast';
import { extractErrorMessage } from '../../utils/validation';

export function ForgotPasswordPage() {
  const navigate = useNavigate();
  const toast = useToast();

  const [step, setStep] = useState(1);
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [devCode, setDevCode] = useState('');
  const [loading, setLoading] = useState(false);

  const handleRequestCode = async (e) => {
    e.preventDefault();
    setLoading(true);
    try {
      const res = await authService.forgotPassword(email.trim());
      toast.info(res.message || 'Nếu email hợp lệ, mã khôi phục đã được gửi.');
      if (res.devResetCode) setDevCode(res.devResetCode);
      setStep(2);
    } catch (err) {
      toast.error(extractErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  const handleReset = async (e) => {
    e.preventDefault();
    if (newPassword.length < 8) {
      toast.warning('Mật khẩu mới phải từ 8 ký tự trở lên.');
      return;
    }
    setLoading(true);
    try {
      const res = await authService.resetPassword({
        email: email.trim(),
        code: code.trim(),
        newPassword,
      });
      toast.success(res.message || 'Đặt lại mật khẩu thành công. Vui lòng đăng nhập.');
      navigate('/login');
    } catch (err) {
      toast.error(extractErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 p-4">
      <div className="w-full max-w-md bg-white rounded-2xl border border-slate-200 shadow-card p-6 sm:p-8 space-y-6">
        <div className="flex items-center gap-2.5">
          <div className="w-9 h-9 rounded-xl bg-primary-500 text-white flex items-center justify-center">
            <Home className="w-5 h-5" />
          </div>
          <span className="text-lg font-bold text-slate-900">ResiHub</span>
        </div>

        <div>
          <h1 className="text-xl font-bold text-slate-900">Khôi phục mật khẩu</h1>
          <p className="text-xs text-slate-500 mt-1">
            {step === 1
              ? 'Nhập địa chỉ email tài khoản để nhận mã xác nhận khôi phục.'
              : 'Nhập mã xác nhận gồm 6 chữ số và mật khẩu mới.'}
          </p>
        </div>

        {step === 1 ? (
          <form onSubmit={handleRequestCode} className="space-y-4">
            <Input
              label="Email tài khoản"
              type="email"
              icon={Mail}
              required
              placeholder="ten@resihub.vn"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <Button type="submit" size="lg" loading={loading} className="w-full">
              Gửi mã xác nhận
            </Button>
          </form>
        ) : (
          <form onSubmit={handleReset} className="space-y-4">
            {devCode ? (
              <div className="p-3 rounded-xl bg-sky-50 border border-sky-100 text-xs text-sky-800">
                [Dev Mode] Mã khôi phục của bạn: <span className="font-bold">{devCode}</span>
              </div>
            ) : null}
            <Input
              label="Mã xác nhận"
              icon={KeyRound}
              required
              placeholder="Nhập mã 6 chữ số"
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
            <Input
              label="Mật khẩu mới (tối thiểu 8 ký tự)"
              type="password"
              icon={Lock}
              required
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
            />
            <Button type="submit" size="lg" loading={loading} className="w-full">
              Cập nhật mật khẩu mới
            </Button>
          </form>
        )}

        <div className="pt-2 border-t border-slate-100">
          <Link
            to="/login"
            className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-500 hover:text-primary-600"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            Quay lại trang Đăng nhập
          </Link>
        </div>
      </div>
    </div>
  );
}

export default ForgotPasswordPage;

