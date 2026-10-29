import React, { useState, useEffect } from 'react';
import { Modal } from '../ui/Modal';
import { Input } from '../ui/Input';
import { Button } from '../ui/Button';
import { Tabs } from '../ui/Tabs';
import { authService } from '../../services/auth.service';
import { useAuthStore } from '../../stores/authStore';
import { useToast } from '../../hooks/useToast';
import { extractErrorMessage } from '../../utils/validation';

export function ProfileModal({ open, onClose }) {
  const user = useAuthStore((s) => s.user);
  const updateUser = useAuthStore((s) => s.updateUser);
  const toast = useToast();

  const [tab, setTab] = useState('info');
  const [form, setForm] = useState({ full_name: '', phone: '', email: '', dob: '' });
  const [pwdForm, setPwdForm] = useState({ currentPassword: '', newPassword: '', confirmPassword: '' });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    authService
      .getProfile()
      .then((res) => {
        const p = res.profile || res.data || user || {};
        setForm({
          full_name: p.full_name || user?.full_name || '',
          phone: p.phone || user?.phone || '',
          email: p.email || user?.email || '',
          dob: p.dob ? String(p.dob).slice(0, 10) : '',
        });
      })
      .catch(() => {
        setForm({
          full_name: user?.full_name || '',
          phone: user?.phone || '',
          email: user?.email || '',
          dob: '',
        });
      });
  }, [open, user]);

  const handleSaveInfo = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      const res = await authService.updateProfile(form);
      updateUser({ full_name: form.full_name, phone: form.phone, email: form.email });
      toast.success(res.message || 'Đã cập nhật hồ sơ cá nhân.');
      onClose?.();
    } catch (err) {
      toast.error(extractErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const handleChangePwd = async (e) => {
    e.preventDefault();
    if (pwdForm.newPassword.length < 8) {
      toast.warning('Mật khẩu mới phải từ 8 ký tự trở lên.');
      return;
    }
    if (pwdForm.newPassword !== pwdForm.confirmPassword) {
      toast.warning('Mật khẩu xác nhận không khớp.');
      return;
    }
    setSaving(true);
    try {
      const res = await authService.changePassword(pwdForm.currentPassword, pwdForm.newPassword);
      toast.success(res.message || 'Đổi mật khẩu thành công.');
      setPwdForm({ currentPassword: '', newPassword: '', confirmPassword: '' });
      onClose?.();
    } catch (err) {
      toast.error(extractErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Tài khoản cá nhân" subtitle="Quản lý thông tin liên hệ và bảo mật">
      <Tabs
        tabs={[
          { id: 'info', label: 'Thông tin chung' },
          { id: 'password', label: 'Đổi mật khẩu' },
        ]}
        activeTab={tab}
        onChange={setTab}
        className="mb-4"
      />

      {tab === 'info' ? (
        <form onSubmit={handleSaveInfo} className="space-y-4">
          <Input
            label="Họ và tên"
            required
            value={form.full_name}
            onChange={(e) => setForm({ ...form, full_name: e.target.value })}
          />
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
            <Input
              label="Số điện thoại"
              value={form.phone}
              onChange={(e) => setForm({ ...form, phone: e.target.value })}
            />
            <Input
              label="Email"
              type="email"
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
            />
          </div>
          <Input
            label="Ngày sinh"
            type="date"
            value={form.dob}
            onChange={(e) => setForm({ ...form, dob: e.target.value })}
          />
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={onClose}>
              Đóng
            </Button>
            <Button type="submit" loading={saving}>
              Lưu thay đổi
            </Button>
          </div>
        </form>
      ) : (
        <form onSubmit={handleChangePwd} className="space-y-4">
          <Input
            label="Mật khẩu hiện tại"
            type="password"
            required
            value={pwdForm.currentPassword}
            onChange={(e) => setPwdForm({ ...pwdForm, currentPassword: e.target.value })}
          />
          <Input
            label="Mật khẩu mới (tối thiểu 8 ký tự)"
            type="password"
            required
            value={pwdForm.newPassword}
            onChange={(e) => setPwdForm({ ...pwdForm, newPassword: e.target.value })}
          />
          <Input
            label="Xác nhận mật khẩu mới"
            type="password"
            required
            value={pwdForm.confirmPassword}
            onChange={(e) => setPwdForm({ ...pwdForm, confirmPassword: e.target.value })}
          />
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={onClose}>
              Đóng
            </Button>
            <Button type="submit" loading={saving}>
              Cập nhật mật khẩu
            </Button>
          </div>
        </form>
      )}
    </Modal>
  );
}

export default ProfileModal;

