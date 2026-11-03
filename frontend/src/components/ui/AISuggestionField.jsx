import React from 'react';
import { Sparkles, Check, X, AlertTriangle } from 'lucide-react';
import { formatConfidenceBadge } from '../../utils/aiHelpers';

/**
 * AISuggestionField — Khung hiển thị trường dữ liệu "AI đề xuất, người quyết định" (PRD 12.1, 16.2, 16.5):
 * - Viền nét đứt + nền màu nhẹ khi đang chờ người dùng kiểm tra (!confirmed)
 * - Nhãn "AI đề xuất" kèm độ tin cậy (%) + thông báo aria-live="polite"
 * - Nút Xác nhận / Xóa gợi ý thuận tiện bằng bàn phím và chuột
 */
export function AISuggestionField({
  active = false,
  confirmed = false,
  edited = false,
  confidence = null,
  threshold = 0.75,
  warningText = '',
  onConfirm,
  onDismiss,
  children,
  className = '',
}) {
  if (!active) {
    return children;
  }

  const confInfo = confidence !== null && confidence !== undefined
    ? formatConfidenceBadge(confidence, threshold)
    : null;

  const badgeToneClasses =
    confInfo?.tone === 'rose'
      ? 'bg-rose-100 text-rose-800 border-rose-200'
      : confInfo?.tone === 'emerald'
      ? 'bg-emerald-100 text-emerald-800 border-emerald-200'
      : 'bg-amber-100 text-amber-900 border-amber-200';

  const wrapperClasses = confirmed
    ? 'rounded-xl border border-emerald-200 bg-emerald-50/35 p-2.5 transition-colors'
    : confInfo?.isUncertain
    ? 'rounded-xl border-2 border-dashed border-rose-300 bg-rose-50/45 p-2.5 transition-colors'
    : 'rounded-xl border-2 border-dashed border-amber-400 bg-amber-50/50 p-2.5 transition-colors';

  return (
    <div className={`${wrapperClasses} ${className}`} aria-live="polite">
      <div className="flex flex-wrap items-center justify-between gap-1.5 mb-1.5">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold bg-amber-100 text-amber-900 border border-amber-300">
            <Sparkles className="w-3 h-3 text-amber-600" aria-hidden="true" />
            {confirmed ? (edited ? 'Đã chỉnh sửa từ AI' : 'Đã xác nhận gợi ý AI') : 'AI đề xuất'}
          </span>

          {confInfo ? (
            <span
              className={`inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-medium border ${badgeToneClasses}`}
              title={confInfo.label}
            >
              Tin cậy {confInfo.percentText}
            </span>
          ) : null}
        </div>

        <div className="flex items-center gap-1">
          {!confirmed && typeof onConfirm === 'function' ? (
            <button
              type="button"
              onClick={onConfirm}
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-semibold bg-emerald-600 text-white hover:bg-emerald-700 focus:outline-none focus:ring-2 focus:ring-emerald-500"
              title="Xác nhận giá trị AI đề xuất"
            >
              <Check className="w-3 h-3" aria-hidden="true" />
              Xác nhận
            </button>
          ) : null}

          {typeof onDismiss === 'function' ? (
            <button
              type="button"
              onClick={onDismiss}
              className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-md text-[11px] font-medium text-slate-600 hover:text-rose-700 hover:bg-rose-50 focus:outline-none focus:ring-2 focus:ring-slate-400"
              title="Bỏ gợi ý AI ở trường này"
            >
              <X className="w-3 h-3" aria-hidden="true" />
              Bỏ
            </button>
          ) : null}
        </div>
      </div>

      <div>{children}</div>

      {warningText ? (
        <p className="mt-1.5 flex items-start gap-1 text-[11px] text-rose-700 font-medium">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" aria-hidden="true" />
          <span>{warningText}</span>
        </p>
      ) : null}
    </div>
  );
}

export default AISuggestionField;

