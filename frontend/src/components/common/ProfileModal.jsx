import React, { useState, useEffect } from 'react';
import { X, User, Lock, Shield, Check, AlertCircle, Calendar, Mail, Phone, CreditCard } from 'lucide-react';
import Button from '../ui/Button';
import Input from '../ui/Input';
import FormField from '../ui/FormField';
import api from '../../services/api';
import { useAuthStore } from '../../stores/authStore';

export default function ProfileModal({ isOpen, onClose }) {
  const { user, setUser } = useAuthStore();
  const [activeTab, setActiveTab] = useState('profile'); // 'profile' | 'password'

  // Profile Form State
  const [profileForm, setProfileForm] = useState({
    full_name: '',
    email: '',
    dob: '',
    phone: '',
    id_number: '',
  });
  const [isProfileLoading, setIsProfileLoading] = useState(false);
  const [profileMsg, setProfileMsg] = useState({ type: '', text: '' });

  // Password Form State
  const [passwordForm, setPasswordForm] = useState({
    old_password: '',
    new_password: '',
    confirm_password: '',
  });
  const [isPasswordLoading, setIsPasswordLoading] = useState(false);
  const [passwordMsg, setPasswordMsg] = useState({ type: '', text: '' });

  useEffect(() => {
    if (isOpen) {
      loadProfile();
      setProfileMsg({ type: '', text: '' });
      setPasswordMsg({ type: '', text: '' });
      setPasswordForm({ old_password: '', new_password: '', confirm_password: '' });
    }
  }, [isOpen]);

  const loadProfile = async () => {
    setIsProfileLoading(true);
    try {
      const res = await api.get('/api/v1/auth/profile');
      const data = res.data?.data || {};
      setProfileForm({
        full_name: data.full_name || '',
        email: data.email || '',
        dob: data.dob ? new Date(data.dob).toISOString().split('T')[0] : '',
        phone: data.phone || '',
        id_number: data.id_number || '',
      });
    } catch (err) {
      console.warn('Could not load profile from API, using store session:', err);
      if (user) {
        setProfileForm({
          full_name: user.name || user.full_name || '',
          email: user.email || '',
          dob: '',
          phone: user.phone || '',
          id_number: user.id_number || '',
        });
      }
    } finally {
      setIsProfileLoading(false);
    }
  };

  const handleUpdateProfile = async (e) => {
    e.preventDefault();
    setProfileMsg({ type: '', text: '' });
    setIsProfileLoading(true);
    try {
      const res = await api.patch('/api/v1/auth/profile', {
        full_name: profileForm.full_name,
        email: profileForm.email,
        dob: profileForm.dob || null,
      });

      setProfileMsg({ type: 'success', text: res.data?.message || 'Cập nhật hồ sơ thành công!' });

      // Cập nhật lại user trong Zustand store
      if (setUser && user) {
        setUser({
          ...user,
          name: profileForm.full_name,
          full_name: profileForm.full_name,
          email: profileForm.email,
        });
      }
    } catch (err) {
      setProfileMsg({
        type: 'error',
        text: err.response?.data?.message || 'Không thể cập nhật hồ sơ.',
      });
    } finally {
      setIsProfileLoading(false);
    }
  };

  const handleChangePassword = async (e) => {
    e.preventDefault();
    setPasswordMsg({ type: '', text: '' });

    if (passwordForm.new_password.length < 8) {
      setPasswordMsg({ type: 'error', text: 'Mật khẩu mới phải có tối thiểu 8 ký tự.' });
      return;
    }

    if (passwordForm.new_password !== passwordForm.confirm_password) {
      setPasswordMsg({ type: 'error', text: 'Mật khẩu mới và xác nhận mật khẩu không khớp.' });
      return;
    }

    setIsPasswordLoading(true);
    try {
      const res = await api.post('/api/v1/auth/change-password', {
        old_password: passwordForm.old_password,
        new_password: passwordForm.new_password,
      });

      setPasswordMsg({
        type: 'success',
        text: res.data?.message || 'Đổi mật khẩu thành công!',
      });
      setPasswordForm({ old_password: '', new_password: '', confirm_password: '' });
    } catch (err) {
      setPasswordMsg({
        type: 'error',
        text: err.response?.data?.message || 'Lỗi khi đổi mật khẩu.',
      });
    } finally {
      setIsPasswordLoading(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-sm animate-in fade-in duration-200">
      <div
        className="bg-white rounded-3xl shadow-2xl max-w-md w-full overflow-hidden border border-slate-100 flex flex-col max-h-[90vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="p-5 border-b border-slate-100 flex items-center justify-between bg-slate-50/60">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl bg-indigo-50 border border-indigo-100 text-indigo-600 flex items-center justify-center">
              <Shield className="w-5 h-5" />
            </div>
            <div>
              <h3 className="font-bold text-base text-slate-800">Tài khoản & Bảo mật</h3>
              <p className="text-xs text-slate-400">Quản lý hồ sơ và thiết lập mật khẩu</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-xl text-slate-400 hover:text-slate-600 hover:bg-slate-100 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Tab switcher */}
        <div className="flex border-b border-slate-100 px-5 bg-white">
          <button
            onClick={() => setActiveTab('profile')}
            className={`py-3 px-4 font-semibold text-xs border-b-2 flex items-center gap-2 transition-all ${
              activeTab === 'profile'
                ? 'border-indigo-600 text-indigo-600'
                : 'border-transparent text-slate-400 hover:text-slate-700'
            }`}
          >
            <User className="w-4 h-4" />
            <span>Thông tin cá nhân</span>
          </button>
          <button
            onClick={() => setActiveTab('password')}
            className={`py-3 px-4 font-semibold text-xs border-b-2 flex items-center gap-2 transition-all ${
              activeTab === 'password'
                ? 'border-indigo-600 text-indigo-600'
                : 'border-transparent text-slate-400 hover:text-slate-700'
            }`}
          >
            <Lock className="w-4 h-4" />
            <span>Đổi mật khẩu</span>
          </button>
        </div>

        {/* Modal Body */}
        <div className="p-6 overflow-y-auto flex-1">
          {activeTab === 'profile' ? (
            <form onSubmit={handleUpdateProfile} className="space-y-4">
              {profileMsg.text && (
                <div
                  className={`p-3 rounded-xl text-xs flex items-center gap-2 ${
                    profileMsg.type === 'success'
                      ? 'bg-emerald-50 text-emerald-800 border border-emerald-200'
                      : 'bg-rose-50 text-rose-800 border border-rose-200'
                  }`}
                >
                  {profileMsg.type === 'success' ? (
                    <Check className="w-4 h-4 text-emerald-600 shrink-0" />
                  ) : (
                    <AlertCircle className="w-4 h-4 text-rose-600 shrink-0" />
                  )}
                  <span>{profileMsg.text}</span>
                </div>
              )}

              <FormField label="Họ và tên" required>
                <Input
                  type="text"
                  required
                  value={profileForm.full_name}
                  onChange={(e) => setProfileForm({ ...profileForm, full_name: e.target.value })}
                  placeholder="Nhập họ và tên đầy đủ"
                />
              </FormField>

              <FormField label="Địa chỉ Email" required>
                <Input
                  type="email"
                  required
                  value={profileForm.email}
                  onChange={(e) => setProfileForm({ ...profileForm, email: e.target.value })}
                  placeholder="name@example.com"
                />
              </FormField>

              <FormField label="Ngày sinh">
                <Input
                  type="date"
                  value={profileForm.dob}
                  onChange={(e) => setProfileForm({ ...profileForm, dob: e.target.value })}
                />
              </FormField>

              <div className="grid grid-cols-2 gap-3 pt-1">
                <div>
                  <label className="text-xs font-semibold text-slate-500 block mb-1">
                    Số điện thoại
                  </label>
                  <input
                    type="text"
                    disabled
                    value={profileForm.phone}
                    className="w-full rounded-xl border border-slate-200 bg-slate-50 py-2 px-3 text-xs text-slate-500 font-mono cursor-not-allowed"
                    title="Số điện thoại liên kết hồ sơ cư trú, không thể tự ý đổi."
                  />
                </div>
                <div>
                  <label className="text-xs font-semibold text-slate-500 block mb-1">
                    Số CCCD / Hộ chiếu
                  </label>
                  <input
                    type="text"
                    disabled
                    value={profileForm.id_number || 'Chưa cập nhật'}
                    className="w-full rounded-xl border border-slate-200 bg-slate-50 py-2 px-3 text-xs text-slate-500 font-mono cursor-not-allowed"
                    title="CCCD định danh người dùng theo pháp luật."
                  />
                </div>
              </div>

              <p className="text-[11px] text-slate-400 italic">
                * Số điện thoại và CCCD gắn với hồ sơ pháp lý căn hộ. Vui lòng liên hệ BQL nếu cần đính chính.
              </p>

              <div className="flex justify-end gap-2.5 pt-4 border-t border-slate-100">
                <Button variant="secondary" type="button" onClick={onClose} disabled={isProfileLoading}>
                  Đóng
                </Button>
                <Button variant="primary" type="submit" isLoading={isProfileLoading}>
                  Lưu thay đổi
                </Button>
              </div>
            </form>
          ) : (
            <form onSubmit={handleChangePassword} className="space-y-4">
              {passwordMsg.text && (
                <div
                  className={`p-3 rounded-xl text-xs flex items-center gap-2 ${
                    passwordMsg.type === 'success'
                      ? 'bg-emerald-50 text-emerald-800 border border-emerald-200'
                      : 'bg-rose-50 text-rose-800 border border-rose-200'
                  }`}
                >
                  {passwordMsg.type === 'success' ? (
                    <Check className="w-4 h-4 text-emerald-600 shrink-0" />
                  ) : (
                    <AlertCircle className="w-4 h-4 text-rose-600 shrink-0" />
                  )}
                  <span>{passwordMsg.text}</span>
                </div>
              )}

              <FormField label="Mật khẩu hiện tại" required>
                <Input
                  type="password"
                  required
                  placeholder="••••••••"
                  value={passwordForm.old_password}
                  onChange={(e) =>
                    setPasswordForm({ ...passwordForm, old_password: e.target.value })
                  }
                />
              </FormField>

              <FormField label="Mật khẩu mới (tối thiểu 8 ký tự)" required>
                <Input
                  type="password"
                  required
                  placeholder="••••••••"
                  value={passwordForm.new_password}
                  onChange={(e) =>
                    setPasswordForm({ ...passwordForm, new_password: e.target.value })
                  }
                />
              </FormField>

              <FormField label="Xác nhận mật khẩu mới" required>
                <Input
                  type="password"
                  required
                  placeholder="••••••••"
                  value={passwordForm.confirm_password}
                  onChange={(e) =>
                    setPasswordForm({ ...passwordForm, confirm_password: e.target.value })
                  }
                />
              </FormField>

              <div className="flex justify-end gap-2.5 pt-4 border-t border-slate-100">
                <Button variant="secondary" type="button" onClick={onClose} disabled={isPasswordLoading}>
                  Hủy
                </Button>
                <Button variant="primary" type="submit" isLoading={isPasswordLoading}>
                  Cập nhật mật khẩu
                </Button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
