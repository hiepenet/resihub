import React, { useState, useEffect } from 'react';
import {
  UserCircle,
  Save,
  KeyRound,
  Eye,
  EyeOff,
  Phone,
  Mail,
  CreditCard,
  MapPin,
  Globe,
  Calendar,
  ShieldCheck,
} from 'lucide-react';
import { Card, CardHeader } from '../../../components/ui/Card';
import { Button } from '../../../components/ui/Button';
import { Input } from '../../../components/ui/Input';
import { FileUpload, AuthImage } from '../../../components/ui/FileUpload';
import { residentService } from '../../../services/resident.service';
import { authService } from '../../../services/auth.service';
import { useAuthStore } from '../../../stores/authStore';
import { useToast } from '../../../hooks/useToast';
import { toInputDate } from '../../../utils/format';
import {
  isValidPhone,
  normalizePhone,
  isValidEmail,
  isValidIdNumber,
  extractErrorMessage,
} from '../../../utils/validation';

export function ProfileTab({ overview, onRefreshOverview }) {
  const toast = useToast();
  const authUser = useAuthStore((s) => s.user);
  const updateUser = useAuthStore((s) => s.updateUser);

  const person = overview?.user || authUser || {};

  const [profileForm, setProfileForm] = useState({
    full_name: '',
    phone: '',
    email: '',
    dob: '',
    id_number: '',
    address: '',
    nationality: 'Việt Nam',
    avatar_base64: '',
  });
  const [profileErrors, setProfileErrors] = useState({});
  const [savingProfile, setSavingProfile] = useState(false);

  const [pwdForm, setPwdForm] = useState({
    currentPassword: '',
    newPassword: '',
    confirmPassword: '',
  });
  const [pwdErrors, setPwdErrors] = useState({});
  const [savingPwd, setSavingPwd] = useState(false);
  const [showCurrentPwd, setShowCurrentPwd] = useState(false);
  const [showNewPwd, setShowNewPwd] = useState(false);

  useEffect(() => {
    setProfileForm({
      full_name: person.full_name || '',
      phone: person.phone || '',
      email: person.email || '',
      dob: toInputDate(person.dob) || '',
      id_number: person.id_number || '',
      address: person.address || '',
      nationality: person.nationality || 'Việt Nam',
      avatar_base64: '',
    });
  }, [
    person.full_name,
    person.phone,
    person.email,
    person.dob,
    person.id_number,
    person.address,
    person.nationality,
  ]);

  const handleSaveProfile = async (e) => {
    e.preventDefault();
    const errs = {};

    if (!profileForm.full_name?.trim()) {
      errs.full_name = 'Vui lòng nhập họ và tên.';
    }
    if (profileForm.phone?.trim() && !isValidPhone(profileForm.phone)) {
      errs.phone = 'Số điện thoại không đúng định dạng Việt Nam (10 số).';
    }
    if (profileForm.email?.trim() && !isValidEmail(profileForm.email)) {
      errs.email = 'Địa chỉ email không hợp lệ.';
    }
    if (profileForm.id_number?.trim() && !isValidIdNumber(profileForm.id_number)) {
      errs.id_number = 'Số CCCD (9/12 số) hoặc Hộ chiếu không hợp lệ.';
    }

    if (Object.keys(errs).length > 0) {
      setProfileErrors(errs);
      return;
    }

    setSavingProfile(true);
    try {
      const payload = {
        full_name: profileForm.full_name.trim(),
        phone: profileForm.phone?.trim() ? normalizePhone(profileForm.phone) : undefined,
        email: profileForm.email?.trim() || undefined,
        dob: profileForm.dob || undefined,
        id_number: profileForm.id_number?.trim() || undefined,
        address: profileForm.address?.trim() || undefined,
        nationality: profileForm.nationality?.trim() || undefined,
        avatar_base64: profileForm.avatar_base64 || undefined,
      };

      const res = await residentService.updateProfile(payload);
      const updated = res?.data || {};

      updateUser({
        full_name: updated.full_name || payload.full_name,
        phone: updated.phone || payload.phone,
        email: updated.email || payload.email,
        avatar_url: updated.avatar_url || person.avatar_url,
      });

      setProfileForm((s) => ({ ...s, avatar_base64: '' }));
      toast.success(res?.message || 'Cập nhật hồ sơ cá nhân thành công!');
      await onRefreshOverview?.();
    } catch (err) {
      toast.error(extractErrorMessage(err, 'Không thể cập nhật hồ sơ cá nhân.'));
    } finally {
      setSavingProfile(false);
    }
  };

  const handleChangePassword = async (e) => {
    e.preventDefault();
    const errs = {};

    if (!pwdForm.currentPassword) {
      errs.currentPassword = 'Vui lòng nhập mật khẩu hiện tại.';
    }
    if (!pwdForm.newPassword || pwdForm.newPassword.length < 8) {
      errs.newPassword = 'Mật khẩu mới phải có tối thiểu 8 ký tự.';
    } else if (pwdForm.newPassword === pwdForm.currentPassword) {
      errs.newPassword = 'Mật khẩu mới phải khác mật khẩu hiện tại.';
    }
    if (pwdForm.confirmPassword !== pwdForm.newPassword) {
      errs.confirmPassword = 'Xác nhận mật khẩu mới không khớp.';
    }

    if (Object.keys(errs).length > 0) {
      setPwdErrors(errs);
      return;
    }

    setSavingPwd(true);
    try {
      const res = await authService.changePassword(
        pwdForm.currentPassword,
        pwdForm.newPassword
      );
      toast.success(res?.message || 'Đổi mật khẩu đăng nhập thành công!');
      setPwdForm({ currentPassword: '', newPassword: '', confirmPassword: '' });
      setPwdErrors({});
    } catch (err) {
      toast.error(extractErrorMessage(err, 'Không thể đổi mật khẩu. Vui lòng kiểm tra mật khẩu hiện tại.'));
    } finally {
      setSavingPwd(false);
    }
  };

  const avatarPreviewSrc = profileForm.avatar_base64 || person.avatar_url || null;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
      {/* Left: Personal Profile Form */}
      <div className="lg:col-span-8">
        <Card>
          <CardHeader
            title="Hồ sơ cá nhân Cư dân"
            subtitle="Cập nhật thông tin liên lạc, định danh CCCD và địa chỉ thường trú phục vụ quản lý cư trú"
          />

          <form onSubmit={handleSaveProfile} className="space-y-5">
            {/* Avatar Section */}
            <div className="p-4 rounded-xl bg-slate-50 border border-slate-200/70 flex flex-col sm:flex-row sm:items-center gap-4">
              <div className="w-20 h-20 rounded-2xl overflow-hidden border-2 border-white shadow-sm bg-primary-100 flex items-center justify-center shrink-0">
                {avatarPreviewSrc ? (
                  <AuthImage
                    src={avatarPreviewSrc}
                    alt={profileForm.full_name || 'Ảnh đại diện'}
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <UserCircle className="w-11 h-11 text-primary-600" />
                )}
              </div>

              <div className="flex-1 min-w-0">
                <FileUpload
                  label="Ảnh chân dung / Ảnh đại diện"
                  multiple={false}
                  value={profileForm.avatar_base64}
                  onChange={(b64) =>
                    setProfileForm((s) => ({ ...s, avatar_base64: b64 || '' }))
                  }
                  hint="Chọn ảnh JPG hoặc PNG rõ mặt (tối đa 5MB)"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <Input
                label="Họ và tên đầy đủ"
                required
                placeholder="Nguyễn Văn A"
                value={profileForm.full_name}
                error={profileErrors.full_name}
                onChange={(e) => {
                  setProfileForm((s) => ({ ...s, full_name: e.target.value }));
                  if (profileErrors.full_name) {
                    setProfileErrors((p) => ({ ...p, full_name: '' }));
                  }
                }}
              />

              <Input
                label="Số điện thoại liên hệ"
                icon={Phone}
                placeholder="0901234567"
                value={profileForm.phone}
                error={profileErrors.phone}
                onChange={(e) => {
                  setProfileForm((s) => ({ ...s, phone: e.target.value }));
                  if (profileErrors.phone) {
                    setProfileErrors((p) => ({ ...p, phone: '' }));
                  }
                }}
              />

              <Input
                type="email"
                label="Địa chỉ Email"
                icon={Mail}
                placeholder="cudan@example.com"
                value={profileForm.email}
                error={profileErrors.email}
                onChange={(e) => {
                  setProfileForm((s) => ({ ...s, email: e.target.value }));
                  if (profileErrors.email) {
                    setProfileErrors((p) => ({ ...p, email: '' }));
                  }
                }}
              />

              <Input
                type="date"
                label="Ngày sinh"
                icon={Calendar}
                value={profileForm.dob}
                onChange={(e) => setProfileForm((s) => ({ ...s, dob: e.target.value }))}
              />

              <Input
                label="Số CCCD / Hộ chiếu"
                icon={CreditCard}
                placeholder="079099001234"
                value={profileForm.id_number}
                error={profileErrors.id_number}
                onChange={(e) => {
                  setProfileForm((s) => ({ ...s, id_number: e.target.value }));
                  if (profileErrors.id_number) {
                    setProfileErrors((p) => ({ ...p, id_number: '' }));
                  }
                }}
              />

              <Input
                label="Quốc tịch"
                icon={Globe}
                placeholder="Việt Nam"
                value={profileForm.nationality}
                onChange={(e) =>
                  setProfileForm((s) => ({ ...s, nationality: e.target.value }))
                }
              />
            </div>

            <Input
              multiline
              rows={2}
              label="Địa chỉ thường trú"
              icon={MapPin}
              placeholder="Số nhà, đường/phố, phường/xã, quận/huyện, tỉnh/thành phố..."
              value={profileForm.address}
              onChange={(e) =>
                setProfileForm((s) => ({ ...s, address: e.target.value }))
              }
            />

            <div className="pt-2 flex items-center justify-end">
              <Button type="submit" icon={Save} loading={savingProfile}>
                Lưu thay đổi hồ sơ
              </Button>
            </div>
          </form>
        </Card>
      </div>

      {/* Right: Change Password Form */}
      <div className="lg:col-span-4 space-y-6">
        <Card>
          <CardHeader
            title="Đổi mật khẩu đăng nhập"
            subtitle="Bảo vệ tài khoản Cổng cư dân của bạn"
          />

          <form onSubmit={handleChangePassword} className="space-y-4">
            <Input
              type={showCurrentPwd ? 'text' : 'password'}
              label="Mật khẩu hiện tại"
              required
              icon={KeyRound}
              placeholder="••••••••"
              value={pwdForm.currentPassword}
              error={pwdErrors.currentPassword}
              onChange={(e) => {
                setPwdForm((s) => ({ ...s, currentPassword: e.target.value }));
                if (pwdErrors.currentPassword) {
                  setPwdErrors((p) => ({ ...p, currentPassword: '' }));
                }
              }}
              rightElement={
                <button
                  type="button"
                  onClick={() => setShowCurrentPwd((v) => !v)}
                  className="text-slate-400 hover:text-slate-600"
                >
                  {showCurrentPwd ? (
                    <EyeOff className="w-4 h-4" />
                  ) : (
                    <Eye className="w-4 h-4" />
                  )}
                </button>
              }
            />

            <Input
              type={showNewPwd ? 'text' : 'password'}
              label="Mật khẩu mới"
              required
              icon={KeyRound}
              placeholder="Tối thiểu 8 ký tự"
              value={pwdForm.newPassword}
              error={pwdErrors.newPassword}
              onChange={(e) => {
                setPwdForm((s) => ({ ...s, newPassword: e.target.value }));
                if (pwdErrors.newPassword) {
                  setPwdErrors((p) => ({ ...p, newPassword: '' }));
                }
              }}
              rightElement={
                <button
                  type="button"
                  onClick={() => setShowNewPwd((v) => !v)}
                  className="text-slate-400 hover:text-slate-600"
                >
                  {showNewPwd ? (
                    <EyeOff className="w-4 h-4" />
                  ) : (
                    <Eye className="w-4 h-4" />
                  )}
                </button>
              }
            />

            <Input
              type={showNewPwd ? 'text' : 'password'}
              label="Xác nhận mật khẩu mới"
              required
              icon={KeyRound}
              placeholder="Nhập lại mật khẩu mới"
              value={pwdForm.confirmPassword}
              error={pwdErrors.confirmPassword}
              onChange={(e) => {
                setPwdForm((s) => ({ ...s, confirmPassword: e.target.value }));
                if (pwdErrors.confirmPassword) {
                  setPwdErrors((p) => ({ ...p, confirmPassword: '' }));
                }
              }}
            />

            <div className="p-3 rounded-xl bg-slate-50 border border-slate-200/70 flex items-start gap-2 text-[11px] text-slate-500">
              <ShieldCheck className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
              <span>
                Nên kết hợp chữ hoa, chữ thường, chữ số và ký tự đặc biệt để tăng cường bảo mật cho tài khoản.
              </span>
            </div>

            <Button
              type="submit"
              variant="secondary"
              className="w-full"
              icon={KeyRound}
              loading={savingPwd}
            >
              Cập nhật mật khẩu
            </Button>
          </form>
        </Card>
      </div>
    </div>
  );
}

export default ProfileTab;
