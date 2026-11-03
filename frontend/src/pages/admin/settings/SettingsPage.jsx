import React, { useState, useEffect, useCallback } from 'react';
import {
  Save,
  ShieldCheck,
  AlertTriangle,
  BookmarkCheck,
  Play,
  RefreshCw,
  Clock,
} from 'lucide-react';
import { Button } from '../../../components/ui/Button';
import { Input } from '../../../components/ui/Input';
import { MoneyInput } from '../../../components/ui/MoneyInput';
import { Select } from '../../../components/ui/Select';
import { Badge } from '../../../components/ui/Badge';
import { Card, CardHeader } from '../../../components/ui/Card';
import { Table, THead, TBody, TH, TD } from '../../../components/ui/Table';
import { PageHeader } from '../../../components/common/PageHeader';
import { usersService } from '../../../services/users.service';
import { buildingsService } from '../../../services/buildings.service';
import { usePermission } from '../../../hooks/usePermission';
import { useToast } from '../../../hooks/useToast';
import { formatDate, formatDateTime } from '../../../utils/format';
import { extractErrorMessage } from '../../../utils/validation';
import { DEFAULT_RESERVATION_CANCEL_POLICY } from '../../../utils/depositUiHelpers';
import { DEFAULT_AI_CONFIG, mergeAiConfigState } from '../../../utils/aiHelpers';
import { AiGatewayConfigCard } from '../../../components/settings/AiGatewayConfigCard';

const DEFAULT_BILLING_CONFIG = {
  billing_day: 1,
  payment_due_days: 5,
  due_date_offset_days: 5,
  late_fee_grace_days: 5,
  late_fee_per_day: 100000,
  late_fee_cap: '',
  meter_anomaly_threshold_pct: 30,
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
  reopen_window_days: 3,
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
  const [reservationCancelPolicy, setReservationCancelPolicy] = useState(
    DEFAULT_RESERVATION_CANCEL_POLICY
  );
  const [aiConfig, setAiConfig] = useState(DEFAULT_AI_CONFIG);
  const [aiKeyConfigured, setAiKeyConfigured] = useState(false);

  // Giám sát & Kích hoạt Tiến trình Tự động Hằng ngày (Cron 00:05 — FR-066 / PRD 14.5)
  const [cronRuns, setCronRuns] = useState([]);
  const [cronLoading, setCronLoading] = useState(false);
  const [triggeringCron, setTriggeringCron] = useState(false);
  const [allowCustomDate, setAllowCustomDate] = useState(false);
  const [cronAsOfDate, setCronAsOfDate] = useState('');
  const [cronBuildingId, setCronBuildingId] = useState('');
  const [buildings, setBuildings] = useState([]);

  const fetchCronRuns = useCallback(async () => {
    if (!isSysAdmin) return;
    setCronLoading(true);
    try {
      const [cronRes, bldgRes] = await Promise.allSettled([
        usersService.listCronRuns({ limit: 10 }),
        buildingsService.list(),
      ]);
      if (cronRes.status === 'fulfilled') {
        const payload = cronRes.value || {};
        setCronRuns(Array.isArray(payload.data) ? payload.data : []);
        setAllowCustomDate(Boolean(payload.allow_custom_date));
        if (payload.today_vn) {
          setCronAsOfDate((prev) => prev || payload.today_vn);
        }
      }
      if (bldgRes.status === 'fulfilled') {
        const list = Array.isArray(bldgRes.value?.data)
          ? bldgRes.value.data
          : Array.isArray(bldgRes.value)
          ? bldgRes.value
          : [];
        setBuildings(list);
      }
    } catch {
      // silent fallback
    } finally {
      setCronLoading(false);
    }
  }, [isSysAdmin]);

  useEffect(() => {
    fetchCronRuns();
  }, [fetchCronRuns]);

  const handleTriggerCron = async () => {
    if (!isSysAdmin) return;
    setTriggeringCron(true);
    try {
      const payload = {};
      if (allowCustomDate && cronAsOfDate) {
        payload.as_of_date = cronAsOfDate;
      }
      if (cronBuildingId) {
        payload.building_id = cronBuildingId;
      }
      const res = await usersService.triggerCronRun(payload);
      toast.success(res?.message || 'Đã thực thi tiến trình tự động hằng ngày thành công.');
      await fetchCronRuns();
    } catch (err) {
      toast.error(extractErrorMessage(err, 'Không thể kích hoạt tiến trình tự động hằng ngày.'));
      await fetchCronRuns();
    } finally {
      setTriggeringCron(false);
    }
  };

  const fetchSettings = useCallback(async () => {
    setLoading(true);
    try {
      const res = await usersService.getSettings();
      const data = res?.data || {};
      if (data.billing_config) {
        const bc = data.billing_config;
        const resolvedDueDays = bc.due_date_offset_days ?? bc.payment_due_days ?? 5;
        setBillingConfig({
          billing_day: bc.billing_day ?? 1,
          payment_due_days: resolvedDueDays,
          due_date_offset_days: resolvedDueDays,
          late_fee_grace_days: bc.late_fee_grace_days ?? 5,
          late_fee_per_day: bc.late_fee_per_day ?? 100000,
          late_fee_cap:
            bc.late_fee_cap !== null &&
            bc.late_fee_cap !== undefined &&
            Number(bc.late_fee_cap) > 0
              ? bc.late_fee_cap
              : '',
          meter_anomaly_threshold_pct: bc.meter_anomaly_threshold_pct ?? 30,
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
      if (data.reservation_cancel_policy) {
        const rcp = data.reservation_cancel_policy;
        setReservationCancelPolicy({
          max_hold_days:
            rcp.max_hold_days ?? DEFAULT_RESERVATION_CANCEL_POLICY.max_hold_days,
          public_max_hold_days:
            rcp.public_max_hold_days ??
            DEFAULT_RESERVATION_CANCEL_POLICY.public_max_hold_days,
          full_refund_before_days:
            rcp.full_refund_before_days ??
            DEFAULT_RESERVATION_CANCEL_POLICY.full_refund_before_days,
          partial_refund_pct:
            rcp.partial_refund_pct ?? DEFAULT_RESERVATION_CANCEL_POLICY.partial_refund_pct,
          default_hold_amount:
            rcp.default_hold_amount ??
            DEFAULT_RESERVATION_CANCEL_POLICY.default_hold_amount,
        });
      }
      if (data.ai_config) {
        setAiConfig(mergeAiConfigState(data.ai_config));
      }
      setAiKeyConfigured(Boolean(res?.ai_runtime?.api_key_configured));
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

    const dueOffsetDays = Math.min(
      60,
      Math.max(
        1,
        Math.round(
          Number(billingConfig.due_date_offset_days ?? billingConfig.payment_due_days) || 5
        )
      )
    );
    const rawLateFeeCap = Number(billingConfig.late_fee_cap);
    const normalizedLateFeeCap =
      billingConfig.late_fee_cap !== '' &&
      billingConfig.late_fee_cap !== null &&
      billingConfig.late_fee_cap !== undefined &&
      Number.isFinite(rawLateFeeCap) &&
      rawLateFeeCap > 0
        ? Math.round(rawLateFeeCap)
        : null;
    const rawGraceDays = Number(billingConfig.late_fee_grace_days);
    const normalizedGraceDays =
      billingConfig.late_fee_grace_days !== '' &&
      billingConfig.late_fee_grace_days !== null &&
      billingConfig.late_fee_grace_days !== undefined &&
      Number.isFinite(rawGraceDays)
        ? Math.min(60, Math.max(0, Math.round(rawGraceDays)))
        : 5;
    const rawFeePerDay = Number(billingConfig.late_fee_per_day);
    const normalizedFeePerDay =
      billingConfig.late_fee_per_day !== '' &&
      billingConfig.late_fee_per_day !== null &&
      billingConfig.late_fee_per_day !== undefined &&
      Number.isFinite(rawFeePerDay)
        ? Math.max(0, Math.round(rawFeePerDay))
        : 100000;

    setSaving(true);
    try {
      const res = await usersService.updateSettings({
        billing_config: {
          billing_day: Math.min(31, Math.max(1, Math.round(Number(billingConfig.billing_day) || 1))),
          payment_due_days: dueOffsetDays,
          due_date_offset_days: dueOffsetDays,
          late_fee_grace_days: normalizedGraceDays,
          late_fee_per_day: normalizedFeePerDay,
          late_fee_cap: normalizedLateFeeCap,
          meter_anomaly_threshold_pct: Math.min(
            500,
            Math.max(1, Number(billingConfig.meter_anomaly_threshold_pct) || 30)
          ),
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
          reopen_window_days: Math.max(1, Number(slaConfig.reopen_window_days) || 3),
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
        reservation_cancel_policy: {
          max_hold_days: Math.min(
            90,
            Math.max(1, Math.round(Number(reservationCancelPolicy.max_hold_days) || 30))
          ),
          public_max_hold_days: Math.min(
            30,
            Math.max(1, Math.round(Number(reservationCancelPolicy.public_max_hold_days) || 7))
          ),
          full_refund_before_days: Math.min(
            30,
            Math.max(0, Math.round(Number(reservationCancelPolicy.full_refund_before_days) ?? 3))
          ),
          partial_refund_pct: Math.min(
            100,
            Math.max(0, Math.round(Number(reservationCancelPolicy.partial_refund_pct) ?? 50))
          ),
          default_hold_amount: Math.max(
            0,
            Math.round(Number(reservationCancelPolicy.default_hold_amount) || 2000000)
          ),
        },
        ai_config: {
          ...aiConfig,
          monthly_budget_vnd: Math.max(0, Math.round(Number(aiConfig.monthly_budget_vnd) || 0)),
          monthly_token_limit: Math.max(10000, Math.round(Number(aiConfig.monthly_token_limit) || 5000000)),
          ocr_threshold: Number(aiConfig.ocr_threshold) || 0.85,
          extract_threshold: Number(aiConfig.extract_threshold) || 0.75,
          triage_threshold: Number(aiConfig.triage_threshold) || 0.65,
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
        subtitle="Thiết lập quy tắc phê duyệt nội bộ (Four-eyes), chính sách giữ chỗ, chu kỳ hóa đơn, SLA kỹ thuật và thông tin liên hệ Ban Quản Lý."
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
          <AiGatewayConfigCard
            aiConfig={aiConfig}
            onChange={setAiConfig}
            apiKeyConfigured={aiKeyConfigured}
            canEdit={isSysAdmin}
          />

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

          {/* Chính sách Đặt cọc Giữ chỗ — FR-005 / FR-067 */}
          <Card className="space-y-4">
            <CardHeader
              title="Chính sách Đặt cọc Giữ chỗ (FR-005 / FR-067)"
              subtitle="Khóa cấu hình: reservation_cancel_policy"
            />
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
              <MoneyInput
                label="Mức cọc giữ chỗ mặc định (VND)"
                disabled={!isSysAdmin}
                placeholder="VD: 2.000.000"
                value={reservationCancelPolicy.default_hold_amount}
                onChange={(e) =>
                  setReservationCancelPolicy((s) => ({
                    ...s,
                    default_hold_amount: e.target.value,
                  }))
                }
              />
              <Input
                label="Tối đa giữ chỗ nội bộ (ngày)"
                type="number"
                min="1"
                max="90"
                disabled={!isSysAdmin}
                value={reservationCancelPolicy.max_hold_days}
                onChange={(e) =>
                  setReservationCancelPolicy((s) => ({
                    ...s,
                    max_hold_days: e.target.value,
                  }))
                }
              />
              <Input
                label="Tối đa giữ chỗ Online (ngày)"
                type="number"
                min="1"
                max="30"
                disabled={!isSysAdmin}
                value={reservationCancelPolicy.public_max_hold_days}
                onChange={(e) =>
                  setReservationCancelPolicy((s) => ({
                    ...s,
                    public_max_hold_days: e.target.value,
                  }))
                }
              />
              <Input
                label="Mốc hủy hoàn 100% (trước ≥ X ngày)"
                type="number"
                min="0"
                max="30"
                disabled={!isSysAdmin}
                value={reservationCancelPolicy.full_refund_before_days}
                onChange={(e) =>
                  setReservationCancelPolicy((s) => ({
                    ...s,
                    full_refund_before_days: e.target.value,
                  }))
                }
              />
              <Input
                label="Tỷ lệ hoàn sát hạn (%)"
                type="number"
                min="0"
                max="100"
                disabled={!isSysAdmin}
                value={reservationCancelPolicy.partial_refund_pct}
                onChange={(e) =>
                  setReservationCancelPolicy((s) => ({
                    ...s,
                    partial_refund_pct: e.target.value,
                  }))
                }
              />
            </div>
            <div className="p-3 rounded-xl bg-sky-50/70 border border-sky-200 flex items-start gap-2.5 text-xs text-sky-900">
              <BookmarkCheck className="w-4 h-4 text-sky-600 shrink-0 mt-0.5" />
              <span>
                <strong>Quy tắc làm tròn tiền tệ Việt Nam (PRD 10.3):</strong> Khi khách hủy sát hạn (còn dưới{' '}
                <strong>{reservationCancelPolicy.full_refund_before_days}</strong> ngày trước hạn giữ chỗ), số tiền hoàn theo tỷ lệ{' '}
                <strong>{reservationCancelPolicy.partial_refund_pct}%</strong> sẽ được làm tròn đến hàng nghìn VND gần nhất (
                <code className="px-1 py-0.5 rounded bg-sky-100 text-sky-900 font-mono text-[11px]">
                  ROUND(x, -3)
                </code>
                ), phần còn lại ghi nhận thu giữ cọc sao cho tổng hoàn + phạt luôn khớp 100% tiền giữ chỗ. Quá hạn không ký HĐ mặc định tịch thu 100%.
              </span>
            </div>
          </Card>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <Card className="space-y-4">
              <CardHeader
                title="Chu kỳ Hóa đơn, Phạt chậm & Giá mặc định"
                subtitle="Khóa cấu hình: billing_config"
              />
              <div className="space-y-1">
                <Input
                  label="Ngày chốt chỉ số & lập hóa đơn mặc định (1–31)"
                  type="number"
                  min="1"
                  max="31"
                  disabled={!isSysAdmin}
                  value={billingConfig.billing_day}
                  onChange={(e) =>
                    setBillingConfig((s) => ({ ...s, billing_day: e.target.value }))
                  }
                />
                <p className="text-[11px] text-slate-500">
                  Hợp đồng có ngày lập hóa đơn 29/30/31 sẽ tự động chốt vào ngày cuối cùng của tháng ngắn (VD: 28/02 hoặc 29/02 năm nhuận — FR-066).
                </p>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Input
                  label="Hạn thanh toán sau phát hành (ngày)"
                  type="number"
                  min="1"
                  max="60"
                  disabled={!isSysAdmin}
                  value={billingConfig.due_date_offset_days}
                  onChange={(e) =>
                    setBillingConfig((s) => ({
                      ...s,
                      due_date_offset_days: e.target.value,
                      payment_due_days: e.target.value,
                    }))
                  }
                />
                <Input
                  label="Số ngày ân hạn phạt chậm"
                  type="number"
                  min="0"
                  max="60"
                  disabled={!isSysAdmin}
                  value={billingConfig.late_fee_grace_days}
                  onChange={(e) =>
                    setBillingConfig((s) => ({
                      ...s,
                      late_fee_grace_days: e.target.value,
                    }))
                  }
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <MoneyInput
                  label="Phạt chậm mỗi ngày (₫/ngày)"
                  disabled={!isSysAdmin}
                  placeholder="VD: 100.000"
                  value={billingConfig.late_fee_per_day}
                  onChange={(e) =>
                    setBillingConfig((s) => ({
                      ...s,
                      late_fee_per_day: e.target.value,
                    }))
                  }
                />
                <MoneyInput
                  label="Trần phí phạt tối đa (₫)"
                  disabled={!isSysAdmin}
                  placeholder="Trống = không trần"
                  value={billingConfig.late_fee_cap}
                  onChange={(e) =>
                    setBillingConfig((s) => ({
                      ...s,
                      late_fee_cap: e.target.value,
                    }))
                  }
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Input
                  label="Ngưỡng cảnh báo chỉ số (%)"
                  type="number"
                  min="1"
                  max="500"
                  disabled={!isSysAdmin}
                  value={billingConfig.meter_anomaly_threshold_pct}
                  onChange={(e) =>
                    setBillingConfig((s) => ({
                      ...s,
                      meter_anomaly_threshold_pct: e.target.value,
                    }))
                  }
                />
                <Input
                  label="Mốc ngày nhắc nợ (dấu phẩy)"
                  placeholder="3, 7, 15"
                  disabled={!isSysAdmin}
                  value={billingConfig.reminder_days_text}
                  onChange={(e) =>
                    setBillingConfig((s) => ({ ...s, reminder_days_text: e.target.value }))
                  }
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <MoneyInput
                  label="Giá điện mặc định (₫/kWh)"
                  disabled={!isSysAdmin}
                  placeholder="VD: 3.800"
                  value={billingConfig.electricity_default_price}
                  onChange={(e) =>
                    setBillingConfig((s) => ({
                      ...s,
                      electricity_default_price: e.target.value,
                    }))
                  }
                />
                <MoneyInput
                  label="Giá nước mặc định (₫/m³)"
                  disabled={!isSysAdmin}
                  placeholder="VD: 22.000"
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
              <Input
                label="Số ngày cho phép cư dân mở lại yêu cầu sau khi hoàn tất (ngày)"
                type="number"
                min="1"
                disabled={!isSysAdmin}
                value={slaConfig.reopen_window_days ?? 3}
                onChange={(e) =>
                  setSlaConfig((s) => ({ ...s, reopen_window_days: e.target.value }))
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

      {/* Giám sát & Kích hoạt Tiến trình Tự động Hằng ngày (FR-066 / FR-064 / PRD 14.5) */}
      {isSysAdmin ? (
        <Card className="space-y-4">
          <CardHeader
            title="Tiến trình Tự động Hằng ngày (Cron 00:05 — FR-066 / FR-064)"
            subtitle="Tự động sinh hóa đơn nháp theo billing_day, chuyển quá hạn (OVERDUE) & cộng phạt chậm thanh toán với khóa pg_try_advisory_lock(73918205)"
            action={
              <Button
                type="button"
                variant="outline"
                size="sm"
                icon={RefreshCw}
                loading={cronLoading}
                onClick={fetchCronRuns}
              >
                Làm mới nhật ký
              </Button>
            }
          />

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 items-end p-4 rounded-xl bg-slate-50 border border-slate-200">
            <Select
              label="Phạm vi tòa nhà đối soát"
              value={cronBuildingId}
              onChange={(e) => setCronBuildingId(e.target.value)}
              options={[
                { value: '', label: 'Tất cả tòa nhà trong hệ thống' },
                ...buildings.map((b) => ({
                  value: b.id,
                  label: `${b.code} — ${b.name}`,
                })),
              ]}
            />
            <Input
              label={
                allowCustomDate
                  ? 'Ngày đối soát (as_of_date — Môi trường Dev/QA)'
                  : 'Ngày đối soát hiện tại (Múi giờ Việt Nam)'
              }
              type="date"
              disabled={!allowCustomDate}
              value={cronAsOfDate}
              onChange={(e) => setCronAsOfDate(e.target.value)}
            />
            <div className="flex sm:justify-end">
              <Button
                type="button"
                variant="primary"
                icon={Play}
                loading={triggeringCron}
                onClick={handleTriggerCron}
                className="w-full sm:w-auto"
              >
                Chạy đồng bộ ngay
              </Button>
            </div>
          </div>

          <div className="border border-slate-200 rounded-xl overflow-hidden">
            {cronRuns.length === 0 ? (
              <p className="p-6 text-xs text-slate-400 text-center">
                {cronLoading
                  ? 'Đang tải lịch sử thực thi cron_job_run...'
                  : 'Chưa có bản ghi thực thi tiến trình tự động nào.'}
              </p>
            ) : (
              <Table>
                <THead>
                  <tr>
                    <TH>Ngày đối soát</TH>
                    <TH className="text-center">Trạng thái</TH>
                    <TH className="text-center">Lần thử / Thời lượng</TH>
                    <TH>Kết quả tổng hợp</TH>
                    <TH className="text-right">Thời điểm chạy</TH>
                  </tr>
                </THead>
                <TBody>
                  {cronRuns.map((run) => {
                    const st = String(run.status || '').toUpperCase();
                    const sum = run.summary && typeof run.summary === 'object' ? run.summary : {};
                    return (
                      <tr key={run.id}>
                        <TD className="font-mono font-semibold text-slate-900 whitespace-nowrap">
                          {formatDate(run.run_date)}
                        </TD>
                        <TD className="text-center whitespace-nowrap">
                          {st === 'SUCCEEDED' ? (
                            <Badge variant="emerald" dot>
                              Thành công
                            </Badge>
                          ) : st === 'FAILED' ? (
                            <Badge variant="red" dot>
                              Thất bại
                            </Badge>
                          ) : (
                            <Badge variant="sky" dot>
                              Đang chạy
                            </Badge>
                          )}
                        </TD>
                        <TD className="text-center text-xs text-slate-600 font-mono whitespace-nowrap">
                          Lần {run.attempt_count || 1} • {run.duration_ms ?? 0} ms
                        </TD>
                        <TD className="text-xs text-slate-700">
                          <div className="flex flex-wrap gap-x-3 gap-y-1">
                            <span>
                              HĐ nháp mới:{' '}
                              <strong>{Number(sum.autoCreatedInvoices || 0)}</strong>
                            </span>
                            <span>
                              Chặn thiếu chỉ số:{' '}
                              <strong>{Number(sum.skippedMeterContracts || 0)}</strong>
                            </span>
                            <span>
                              Chuyển quá hạn: <strong>{Number(sum.overdueMarked || 0)}</strong>
                            </span>
                            <span>
                              Cộng phạt chậm: <strong>{Number(sum.lateFeeUpdated || 0)}</strong>
                            </span>
                          </div>
                          {run.error_message ? (
                            <p className="text-rose-600 mt-1 break-words">{run.error_message}</p>
                          ) : null}
                        </TD>
                        <TD className="text-right text-xs text-slate-500 whitespace-nowrap">
                          <Clock className="w-3 h-3 inline mr-1" />
                          {formatDateTime(run.started_at)}
                        </TD>
                      </tr>
                    );
                  })}
                </TBody>
              </Table>
            )}
          </div>
        </Card>
      ) : null}
    </div>
  );
}

export default SettingsPage;
