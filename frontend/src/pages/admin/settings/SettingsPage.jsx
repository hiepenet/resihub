import React, { useState, useEffect, useCallback } from 'react';
import { Save, ShieldCheck, AlertTriangle } from 'lucide-react';
import { Button } from '../../../components/ui/Button';
import { Input } from '../../../components/ui/Input';
import { Card, CardHeader } from '../../../components/ui/Card';
import { PageHeader } from '../../../components/common/PageHeader';
import { usersService } from '../../../services/users.service';
import { usePermission } from '../../../hooks/usePermission';
import { useToast } from '../../../hooks/useToast';
import { extractErrorMessage } from '../../../utils/validation';

const DEFAULT_BILLING_CONFIG = {
  billing_day: 1,
  payment_due_days: 5,
  reminder_days_text: '3, 7, 15',
  late_fee_percent: 0,
  electricity_default_price: 3800,
  water_default_price: 22000,
};

const DEFAULT_SLA_CONFIG = {
  response_hours: 2,
  urgent_resolve_hours: 4,
  normal_resolve_hours: 24,
  deposit_refund_days: 5,
};

const DEFAULT_CONTACT_CONFIG = {
  working_hours: '08:00 – 18:00 (Thứ 2 – Thứ 7)',
  technical_hotline: '1900 6868',
  security_hotline: '1900 9119',
  emergency_phone: '0909 113 114',
  support_email: 'support@resihub.vn',
};

const DEFAULT_APPROVAL_CONFIG = {
  allow_self_approval: false,
};

export function SettingsPage() {
  const toast = useToast();
  const { isSysAdmin } = usePermission();

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [billingConfig, setBillingConfig] = useState(DEFAULT_BILLING_CONFIG);
  const [slaConfig, setSlaConfig] = useState(DEFAULT_SLA_CONFIG);
  const [contactConfig, setContactConfig] = useState(DEFAULT_CONTACT_CONFIG);
  const [approvalConfig, setApprovalConfig] = useState(DEFAULT_APPROVAL_CONFIG);

  const fetchSettings = useCallback(async () => {
    setLoading(true);
    try {
      const res = await usersService.getSettings();
      const data = res?.data || {};
      if (data.billing_config) {
        const bc = data.billing_config;
        setBillingConfig({
          billing_day: bc.billing_day ?? 1,
          payment_due_days: bc.payment_due_days ?? 5,
          reminder_days_text: Array.isArray(bc.reminder_days)
            ? bc.reminder_days.join(', ')
            : '3, 7, 15',
          late_fee_percent: bc.late_fee_percent ?? 0,
          electricity_default_price: bc.electricity_default_price ?? 3800,
          water_default_price: bc.water_default_price ?? 22000,
        });
      }
      if (data.sla_config) {
        setSlaConfig({ ...DEFAULT_SLA_CONFIG, ...data.sla_config });
      }
      if (data.contact_config) {
        setContactConfig({ ...DEFAULT_CONTACT_CONFIG, ...data.contact_config });
      }
      if (data.approval_config) {
        setApprovalConfig({
          allow_self_approval: Boolean(data.approval_config.allow_self_approval),
        });
      }
    } catch (err) {
      toast.error(extractErrorMessage(err, 'Không thể tải cấu hình hệ thống.'));
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    fetchSettings();
  }, [fetchSettings]);

  const handleSave = async (e) => {
    e?.preventDefault();
    const reminderDays = String(billingConfig.reminder_days_text || '')
      .split(',')
      .map((x) => Number(x.trim()))
      .filter((n) => !Number.isNaN(n) && n > 0);

    setSaving(true);
    try {
      const res = await usersService.updateSettings({
        billing_config: {
          billing_day: Math.min(28, Math.max(1, Number(billingConfig.billing_day) || 1)),
          payment_due_days: Math.max(1, Number(billingConfig.payment_due_days) || 5),
          reminder_days: reminderDays.length > 0 ? reminderDays : [3, 7, 15],
          late_fee_percent: Math.max(0, Number(billingConfig.late_fee_percent) || 0),
          electricity_default_price: Math.max(
            0,
            Number(billingConfig.electricity_default_price) || 3800
          ),
          water_default_price: Math.max(0, Number(billingConfig.water_default_price) || 22000),
        },
        sla_config: {
          response_hours: Math.max(1, Number(slaConfig.response_hours) || 2),
          urgent_resolve_hours: Math.max(1, Number(slaConfig.urgent_resolve_hours) || 4),
          normal_resolve_hours: Math.max(1, Number(slaConfig.normal_resolve_hours) || 24),
          deposit_refund_days: Math.max(1, Number(slaConfig.deposit_refund_days) || 5),
        },
        contact_config: {
          working_hours: contactConfig.working_hours.trim(),
          technical_hotline: contactConfig.technical_hotline.trim(),
          security_hotline: contactConfig.security_hotline.trim(),
          emergency_phone: contactConfig.emergency_phone.trim(),
          support_email: contactConfig.support_email.trim(),
        },
        approval_config: {
          allow_self_approval: Boolean(approvalConfig.allow_self_approval),
        },
      });
      toast.success(res?.message || 'Đã lưu cấu hình hệ thống thành công.');
    } catch (err) {
      toast.error(extractErrorMessage(err, 'Không thể lưu cấu hình hệ thống.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Cấu hình Hệ thống"
        subtitle="Thiết lập quy tắc phê duyệt nội bộ (Four-eyes), chu kỳ hóa đơn, SLA kỹ thuật và thông tin liên hệ Ban Quản Lý."
        actions={
          isSysAdmin ? (
            <Button variant="primary" icon={Save} loading={saving} onClick={handleSave}>
              Lưu cấu hình hệ thống
            </Button>
          ) : null
        }
      />

      {loading ? (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          {[1, 2, 3, 4].map((i) => (
            <div
              key={i}
              className="h-64 rounded-xl bg-white border border-slate-200 animate-pulse"
            />
          ))}
        </div>
      ) : (
        <form onSubmit={handleSave} className="space-y-6">
          {/* Quy tắc Phê duyệt Nội bộ (Four-eyes) — R-23 */}
          <Card className="space-y-4">
            <CardHeader
              title="Quy tắc Phê duyệt Nội bộ (Four-eyes)"
              subtitle="Khóa cấu hình: approval_config"
            />

            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 p-4 rounded-xl bg-slate-50 border border-slate-200">
              <div className="space-y-1">
                <p className="text-sm font-semibold text-slate-900 flex items-center gap-2">
                  <ShieldCheck className="w-4 h-4 text-primary-600 shrink-0" />
                  Cho phép người tạo tự phê duyệt trong mô hình vận hành 1 nhân sự (allow_self_approval)
                </p>
                <p className="text-xs text-slate-600 leading-relaxed">
                  Mặc định tắt (<strong>Four-eyes nghiêm ngặt</strong>: người lập hồ sơ không được tự duyệt hợp đồng giá ưu đãi, phụ lục hay hoàn cọc). Khi bật tùy chọn này cho mô hình vận hành chỉ có 1 Quản lý, người tạo được phép tự phê duyệt hồ sơ do chính mình tạo và hệ thống sẽ tự động ghi nhận cảnh báo{' '}
                  <code className="px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 font-mono text-[11px]">
                    SELF_APPROVAL_WARNING
                  </code>{' '}
                  vào Nhật ký Kiểm toán (Audit Log).
                </p>
              </div>

              <label className="relative inline-flex items-center cursor-pointer shrink-0">
                <input
                  type="checkbox"
                  className="sr-only peer"
                  disabled={!isSysAdmin}
                  checked={Boolean(approvalConfig.allow_self_approval)}
                  onChange={(e) =>
                    setApprovalConfig({ allow_self_approval: e.target.checked })
                  }
                />
                <div className="w-11 h-6 bg-slate-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-primary-600 peer-disabled:opacity-60" />
              </label>
            </div>

            {approvalConfig.allow_self_approval ? (
              <div className="p-3.5 rounded-xl bg-amber-50 border border-amber-200 flex items-start gap-2.5 text-xs text-amber-900">
                <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
                <span>
                  Chế độ cho phép tự phê duyệt đang <strong>BẬT</strong>. Mọi thao tác tự phê duyệt sẽ gắn nhãn cảnh báo <strong>SELF_APPROVAL_WARNING</strong> để Chủ đầu tư (OWNER) và SYS_ADMIN hậu kiểm tại Nhật ký hệ thống.
                </span>
              </div>
            ) : null}
          </Card>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <Card className="space-y-4">
              <CardHeader
                title="Chu kỳ Hóa đơn & Giá mặc định"
                subtitle="Khóa cấu hình: billing_config"
              />
              <Input
                label="Ngày chốt chỉ số & lập hóa đơn hàng tháng"
                type="number"
                min="1"
                max="28"
                disabled={!isSysAdmin}
                value={billingConfig.billing_day}
                onChange={(e) =>
                  setBillingConfig((s) => ({ ...s, billing_day: e.target.value }))
                }
              />
              <Input
                label="Thời hạn thanh toán (số ngày sau phát hành)"
                type="number"
                min="1"
                max="30"
                disabled={!isSysAdmin}
                value={billingConfig.payment_due_days}
                onChange={(e) =>
                  setBillingConfig((s) => ({ ...s, payment_due_days: e.target.value }))
                }
              />
              <Input
                label="Các mốc ngày nhắc nợ tự động (cách nhau dấu phẩy)"
                placeholder="3, 7, 15"
                disabled={!isSysAdmin}
                value={billingConfig.reminder_days_text}
                onChange={(e) =>
                  setBillingConfig((s) => ({ ...s, reminder_days_text: e.target.value }))
                }
              />
              <div className="grid grid-cols-2 gap-3">
                <Input
                  label="Giá điện mặc định (₫/kWh)"
                  type="number"
                  min="0"
                  disabled={!isSysAdmin}
                  value={billingConfig.electricity_default_price}
                  onChange={(e) =>
                    setBillingConfig((s) => ({
                      ...s,
                      electricity_default_price: e.target.value,
                    }))
                  }
                />
                <Input
                  label="Giá nước mặc định (₫/m³)"
                  type="number"
                  min="0"
                  disabled={!isSysAdmin}
                  value={billingConfig.water_default_price}
                  onChange={(e) =>
                    setBillingConfig((s) => ({
                      ...s,
                      water_default_price: e.target.value,
                    }))
                  }
                />
              </div>
            </Card>

            <Card className="space-y-4">
              <CardHeader
                title="Cam kết SLA Kỹ thuật & Tiền cọc"
                subtitle="Khóa cấu hình: sla_config"
              />
              <Input
                label="Thời gian phản hồi tiếp nhận tối đa (giờ)"
                type="number"
                min="1"
                disabled={!isSysAdmin}
                value={slaConfig.response_hours}
                onChange={(e) =>
                  setSlaConfig((s) => ({ ...s, response_hours: e.target.value }))
                }
              />
              <Input
                label="SLA xử lý sự cố KHẨN CẤP (giờ)"
                type="number"
                min="1"
                disabled={!isSysAdmin}
                value={slaConfig.urgent_resolve_hours}
                onChange={(e) =>
                  setSlaConfig((s) => ({ ...s, urgent_resolve_hours: e.target.value }))
                }
              />
              <Input
                label="SLA xử lý sự cố THÔNG THƯỜNG (giờ)"
                type="number"
                min="1"
                disabled={!isSysAdmin}
                value={slaConfig.normal_resolve_hours}
                onChange={(e) =>
                  setSlaConfig((s) => ({ ...s, normal_resolve_hours: e.target.value }))
                }
              />
              <Input
                label="Thời hạn hoàn trả tiền cọc sau thanh lý (ngày)"
                type="number"
                min="1"
                disabled={!isSysAdmin}
                value={slaConfig.deposit_refund_days}
                onChange={(e) =>
                  setSlaConfig((s) => ({ ...s, deposit_refund_days: e.target.value }))
                }
              />
            </Card>

            <Card className="space-y-4">
              <CardHeader
                title="Danh bạ Ban Quản Lý (Cổng Cư Dân)"
                subtitle="Khóa cấu hình: contact_config"
              />
              <Input
                label="Khung giờ làm việc hành chính"
                disabled={!isSysAdmin}
                value={contactConfig.working_hours}
                onChange={(e) =>
                  setContactConfig((s) => ({ ...s, working_hours: e.target.value }))
                }
              />
              <Input
                label="Hotline Kỹ thuật / Bảo trì"
                disabled={!isSysAdmin}
                value={contactConfig.technical_hotline}
                onChange={(e) =>
                  setContactConfig((s) => ({ ...s, technical_hotline: e.target.value }))
                }
              />
              <Input
                label="Hotline An ninh / Trực bảo vệ 24/7"
                disabled={!isSysAdmin}
                value={contactConfig.security_hotline}
                onChange={(e) =>
                  setContactConfig((s) => ({ ...s, security_hotline: e.target.value }))
                }
              />
              <Input
                label="Số điện thoại khẩn cấp / PCCC"
                disabled={!isSysAdmin}
                value={contactConfig.emergency_phone}
                onChange={(e) =>
                  setContactConfig((s) => ({ ...s, emergency_phone: e.target.value }))
                }
              />
              <Input
                label="Email tiếp nhận hỗ trợ cư dân"
                type="email"
                disabled={!isSysAdmin}
                value={contactConfig.support_email}
                onChange={(e) =>
                  setContactConfig((s) => ({ ...s, support_email: e.target.value }))
                }
              />
            </Card>
          </div>

          {isSysAdmin ? (
            <div className="flex justify-end">
              <Button type="submit" variant="primary" size="lg" icon={Save} loading={saving}>
                Lưu toàn bộ cấu hình hệ thống
              </Button>
            </div>
          ) : null}
        </form>
      )}
    </div>
  );
}

export default SettingsPage;
