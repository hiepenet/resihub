import React, { useEffect, useState, useCallback } from 'react';
import {
  Sparkles,
  ShieldAlert,
  CheckCircle2,
  XCircle,
  RefreshCw,
  BarChart3,
} from 'lucide-react';
import { Card, CardHeader } from '../ui/Card';
import { Input } from '../ui/Input';
import { MoneyInput } from '../ui/MoneyInput';
import { Select } from '../ui/Select';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { aiService } from '../../services/ai.service';
import { formatMoney } from '../../utils/format';

export function AiGatewayConfigCard({
  aiConfig,
  onChange,
  apiKeyConfigured = false,
  canEdit = false,
}) {
  const [usage, setUsage] = useState(null);
  const [loadingUsage, setLoadingUsage] = useState(false);

  const loadUsage = useCallback(async () => {
    setLoadingUsage(true);
    try {
      const res = await aiService.getUsageSummary();
      setUsage(res?.data || null);
    } catch {
      // Non-blocking if usage endpoint unavailable
    } finally {
      setLoadingUsage(false);
    }
  }, []);

  useEffect(() => {
    loadUsage();
  }, [loadUsage]);

  const setField = (key, value) => {
    if (!canEdit || typeof onChange !== 'function') return;
    onChange({
      ...aiConfig,
      [key]: value,
    });
  };

  const setTaskFlag = (taskKey, checked) => {
    if (!canEdit || typeof onChange !== 'function') return;
    onChange({
      ...aiConfig,
      tasks: {
        ...(aiConfig.tasks || {}),
        [taskKey]: Boolean(checked),
      },
    });
  };

  const effectiveKeyOk = Boolean(usage?.api_key_configured ?? apiKeyConfigured);
  const budgetPct = Math.min(100, Number(usage?.monthly_budget_pct || 0));
  const tokenPct = Math.min(100, Number(usage?.monthly_token_pct || 0));
  const warnActive = Boolean(usage?.warn_triggered);

  return (
    <Card className="space-y-5 border-amber-200/80">
      <CardHeader
        title="Cổng Trợ lý AI — Gemini Gateway (M15)"
        subtitle="Nguyên tắc cốt lõi PRD 12.1: AI chỉ đề xuất nháp — người dùng xác nhận mới ghi vào cơ sở dữ liệu. Hỗ trợ Kill Switch tổng & hạn mức chi phí tháng."
        action={
          <div className="flex flex-wrap items-center gap-2">
            {effectiveKeyOk ? (
              <Badge variant="emerald" dot>
                GEMINI_API_KEY đã kết nối
              </Badge>
            ) : (
              <Badge variant="red" dot>
                Chưa cấu hình GEMINI_API_KEY
              </Badge>
            )}
            <Button
              type="button"
              size="xs"
              variant="outline"
              icon={RefreshCw}
              loading={loadingUsage}
              onClick={loadUsage}
            >
              Làm mới thống kê
            </Button>
          </div>
        }
      />

      {!effectiveKeyOk ? (
        <div className="p-3.5 rounded-xl bg-rose-50 border border-rose-200 flex items-start gap-2.5 text-xs text-rose-800">
          <XCircle className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" />
          <div>
            <p className="font-semibold">Máy chủ Backend chưa nhận biến môi trường GEMINI_API_KEY</p>
            <p className="mt-0.5 text-rose-700">
              Khóa kết nối Gemini chỉ lưu trên biến môi trường máy chủ (<code>api/.env</code>), tuyệt đối không gửi xuống trình duyệt. Khi chưa cấu hình, mọi biểu mẫu vẫn nhập thủ công bình thường.
            </p>
          </div>
        </div>
      ) : null}

      {/* Master Kill Switch */}
      <label
        className={`flex items-start gap-3 p-4 rounded-xl border transition-colors ${
          canEdit ? 'cursor-pointer' : 'cursor-not-allowed opacity-80'
        } ${
          aiConfig.enabled
            ? 'bg-emerald-50/60 border-emerald-200'
            : 'bg-rose-50/70 border-rose-200'
        }`}
      >
        <input
          type="checkbox"
          disabled={!canEdit}
          checked={Boolean(aiConfig.enabled)}
          onChange={(e) => setField('enabled', e.target.checked)}
          className="mt-0.5 w-4 h-4 rounded border-slate-300 text-primary-600 focus:ring-primary-500"
        />
        <div className="space-y-1 text-xs">
          <div className="flex items-center gap-2">
            <span className="font-bold text-slate-900">
              Bật AI Gateway toàn tổ chức (Master Switch)
            </span>
            <Badge variant={aiConfig.enabled ? 'emerald' : 'red'}>
              {aiConfig.enabled ? 'ĐANG BẬT' : 'ĐÃ NGẮT (KILL SWITCH)'}
            </Badge>
          </div>
          <p className="text-slate-600 leading-relaxed">
            Bỏ chọn để ngắt tức thì mọi lời gọi ra Gemini API khi cần kiểm soát chi phí hoặc bảo trì (R-09 / PRD 12.6). Luồng nhập tay không bị ảnh hưởng.
          </p>
        </div>
      </label>

      {/* Bật / tắt từng tác vụ MVP */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        {[
          {
            key: 'cccd_extract',
            title: 'AI-01a: Quét CCCD',
            desc: 'Trích xuất Họ tên, Số CCCD, Ngày sinh, Quê quán',
          },
          {
            key: 'contract_extract',
            title: 'AI-01b: Quét Hợp đồng',
            desc: 'Đọc ảnh chụp / PDF scan hợp đồng giấy sang bản nháp',
          },
          {
            key: 'meter_ocr',
            title: 'AI-02: OCR Đồng hồ',
            desc: 'Đọc chỉ số điện/nước & cảnh báo ảnh mờ, lóa',
          },
          {
            key: 'ticket_triage',
            title: 'AI-03: Phân loại Báo hỏng',
            desc: 'Tự động gợi ý danh mục, độ khẩn & người xử lý',
          },
        ].map((item) => {
          const checked = Boolean(aiConfig.tasks?.[item.key]);
          return (
            <label
              key={item.key}
              className={`p-3 rounded-xl border text-xs flex items-start gap-2.5 ${
                canEdit ? 'cursor-pointer' : 'cursor-not-allowed opacity-80'
              } ${
                checked && aiConfig.enabled
                  ? 'bg-amber-50/40 border-amber-200'
                  : 'bg-slate-50 border-slate-200'
              }`}
            >
              <input
                type="checkbox"
                disabled={!canEdit || !aiConfig.enabled}
                checked={checked}
                onChange={(e) => setTaskFlag(item.key, e.target.checked)}
                className="mt-0.5 w-4 h-4 rounded border-slate-300 text-amber-600 focus:ring-amber-500"
              />
              <div>
                <p className="font-semibold text-slate-900">{item.title}</p>
                <p className="text-[11px] text-slate-500 mt-0.5">{item.desc}</p>
              </div>
            </label>
          );
        })}
      </div>

      {/* Model, Ngưỡng tin cậy & Ngân sách tháng */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        <Select
          label="Mô hình Gemini mặc định"
          disabled={!canEdit}
          value={aiConfig.model || 'gemini-2.5-flash'}
          onChange={(e) => setField('model', e.target.value)}
          options={[
            { value: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash (Nhanh & Tối ưu chi phí — Khuyến nghị)' },
            { value: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro (Độ chính xác sâu cho tài liệu phức tạp)' },
          ]}
        />

        <MoneyInput
          label="Trần ngân sách AI tháng (VNĐ)"
          disabled={!canEdit}
          value={aiConfig.monthly_budget_vnd}
          onChange={(e) => setField('monthly_budget_vnd', e?.target ? e.target.value : e)}
          hint="Tự động chặn gọi mới khi chạm 100% hạn mức tháng"
        />

        <Input
          label="Trần Token tháng (Input + Output)"
          type="number"
          min={10000}
          step={100000}
          disabled={!canEdit}
          value={aiConfig.monthly_token_limit}
          onChange={(e) => setField('monthly_token_limit', Number(e.target.value) || 0)}
          hint={`Cảnh báo Quản trị viên khi đạt ${aiConfig.warn_percent || 80}%`}
        />

        <Input
          label="Ngưỡng tin cậy OCR Đồng hồ (0.50 – 0.99)"
          type="number"
          min={0.5}
          max={0.99}
          step={0.01}
          disabled={!canEdit}
          value={aiConfig.ocr_threshold}
          onChange={(e) => setField('ocr_threshold', e.target.value)}
          hint="Dưới ngưỡng này AI để trống ô chỉ số để nhập tay (AC-014.1)"
        />

        <Input
          label="Ngưỡng tin cậy Quét CCCD / Hợp đồng"
          type="number"
          min={0.5}
          max={0.99}
          step={0.01}
          disabled={!canEdit}
          value={aiConfig.extract_threshold}
          onChange={(e) => setField('extract_threshold', e.target.value)}
          hint="Mặc định 0.75 (75%)"
        />

        <Input
          label="Ngưỡng tin cậy Phân loại Báo hỏng"
          type="number"
          min={0.4}
          max={0.99}
          step={0.01}
          disabled={!canEdit}
          value={aiConfig.triage_threshold}
          onChange={(e) => setField('triage_threshold', e.target.value)}
          hint="Dưới ngưỡng sẽ gắn nhãn Cần phân loại thủ công (AC-011.2)"
        />
      </div>

      {/* Thanh tiêu thụ tháng & KPI G6 */}
      {usage ? (
        <div className="pt-3 border-t border-slate-200 space-y-3">
          {warnActive ? (
            <div className="p-3 rounded-xl bg-amber-50 border border-amber-300 flex items-center gap-2 text-xs text-amber-900">
              <ShieldAlert className="w-4 h-4 text-amber-600 shrink-0" />
              <span>
                Chi phí hoặc sản lượng token AI kỳ <strong>{usage.period}</strong> đã vượt ngưỡng cảnh báo{' '}
                <strong>{usage.warn_percent}%</strong>.
              </span>
            </div>
          ) : null}

          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs">
            <div className="p-3.5 rounded-xl bg-slate-50 border border-slate-200 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-slate-600 font-medium">Chi phí ước tính kỳ {usage.period}</span>
                <span className="font-bold text-slate-900">
                  {formatMoney(usage.monthly_cost_vnd)} / {formatMoney(usage.monthly_budget_vnd)}
                </span>
              </div>
              <div className="w-full h-2 rounded-full bg-slate-200 overflow-hidden">
                <div
                  className={`h-full rounded-full ${
                    budgetPct >= 80 ? 'bg-rose-500' : 'bg-emerald-500'
                  }`}
                  style={{ width: `${budgetPct}%` }}
                />
              </div>
              <p className="text-[11px] text-slate-500">
                {usage.monthly_calls || 0} lượt gọi AI • Đã dùng {usage.monthly_budget_pct || 0}% ngân sách
              </p>
            </div>

            <div className="p-3.5 rounded-xl bg-slate-50 border border-slate-200 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-slate-600 font-medium">Sản lượng Token tháng</span>
                <span className="font-bold text-slate-900">
                  {Number(usage.monthly_tokens_used || 0).toLocaleString('vi-VN')} tok
                </span>
              </div>
              <div className="w-full h-2 rounded-full bg-slate-200 overflow-hidden">
                <div
                  className={`h-full rounded-full ${
                    tokenPct >= 80 ? 'bg-amber-500' : 'bg-primary-500'
                  }`}
                  style={{ width: `${tokenPct}%` }}
                />
              </div>
              <p className="text-[11px] text-slate-500">
                Hạn mức: {Number(usage.monthly_token_limit || 0).toLocaleString('vi-VN')} token ({usage.monthly_token_pct || 0}%)
              </p>
            </div>

            <div className="p-3.5 rounded-xl bg-amber-50/50 border border-amber-200 space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="font-semibold text-amber-950 flex items-center gap-1">
                  <BarChart3 className="w-3.5 h-3.5 text-amber-600" />
                  Chỉ số mục tiêu G6 (PRD Mục 4)
                </span>
                <Sparkles className="w-3.5 h-3.5 text-amber-500" />
              </div>
              <p className="text-[11px] text-slate-700">
                Chấp nhận trường trích xuất không sửa:{' '}
                <strong>
                  {usage.kpi_g6?.exact_field_acceptance_rate_pct !== null &&
                  usage.kpi_g6?.exact_field_acceptance_rate_pct !== undefined
                    ? `${usage.kpi_g6.exact_field_acceptance_rate_pct}%`
                    : 'Chưa có mẫu'}
                </strong>{' '}
                (Mục tiêu &ge; {usage.kpi_g6?.target_pct || 70}%)
              </p>
              <p className="text-[11px] text-slate-700">
                Giữ nguyên phân loại báo hỏng:{' '}
                <strong>
                  {usage.kpi_g6?.triage_keep_rate_pct !== null &&
                  usage.kpi_g6?.triage_keep_rate_pct !== undefined
                    ? `${usage.kpi_g6.triage_keep_rate_pct}%`
                    : 'Chưa có mẫu'}
                </strong>{' '}
                (Mục tiêu &ge; {usage.kpi_g6?.triage_target_pct || 80}%)
              </p>
            </div>
          </div>
        </div>
      ) : null}
    </Card>
  );
}

export default AiGatewayConfigCard;
