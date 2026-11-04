import React, { useEffect, useId } from 'react';
import { X } from 'lucide-react';

const MAX_WIDTHS = {
  sm: 'sm:max-w-md',
  md: 'sm:max-w-lg',
  lg: 'sm:max-w-2xl',
  xl: 'sm:max-w-4xl',
  full: 'sm:max-w-6xl',
};

export function Modal({
  open,
  onClose,
  title,
  subtitle,
  children,
  footer,
  size = 'md',
  variant = 'center', // 'center' | 'drawer'
}) {
  const titleId = useId();

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') onClose?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  if (variant === 'drawer') {
    return (
      <div className="fixed inset-0 z-50 flex justify-end bg-slate-900/40 backdrop-blur-[1px]">
        <div className="fixed inset-0" onClick={onClose} aria-hidden="true" />
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby={title ? titleId : undefined}
          className="relative z-10 w-full max-w-lg bg-white h-full shadow-2xl border-l border-slate-200 flex flex-col"
        >
          <div className="px-4 sm:px-6 py-4 border-b border-slate-200 flex items-start justify-between gap-4">
            <div className="min-w-0">
              <h3 id={titleId} className="text-base font-semibold text-slate-900 break-words">
                {title}
              </h3>
              {subtitle ? (
                <p className="text-xs text-slate-500 mt-0.5 break-words">{subtitle}</p>
              ) : null}
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Đóng hộp thoại"
              className="min-w-[44px] min-h-[44px] sm:min-w-0 sm:min-h-0 p-1.5 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100 inline-flex items-center justify-center transition-colors shrink-0"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
          <div className={`flex-1 overflow-y-auto p-4 sm:p-6 ${footer ? '' : 'pb-safe'}`}>
            {children}
          </div>
          {footer ? (
            <div className="px-4 sm:px-6 py-3.5 pb-safe border-t border-slate-200 bg-slate-50/70 flex flex-wrap items-center justify-end gap-2.5">
              {footer}
            </div>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4 bg-slate-900/45 backdrop-blur-[1px] overflow-y-auto">
      <div className="fixed inset-0" onClick={onClose} aria-hidden="true" />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        className={`relative z-10 w-full ${
          MAX_WIDTHS[size] || MAX_WIDTHS.md
        } bg-white rounded-t-2xl sm:rounded-2xl shadow-elevated border border-slate-200/80 max-h-[92dvh] sm:max-h-[90vh] flex flex-col overflow-hidden`}
      >
        <div className="sm:hidden flex justify-center pt-2.5 pb-0.5 shrink-0" aria-hidden="true">
          <span className="w-10 h-1 rounded-full bg-slate-300" />
        </div>
        <div className="px-4 sm:px-6 py-3.5 sm:py-4 border-b border-slate-100 flex items-start justify-between gap-4 shrink-0">
          <div className="min-w-0">
            <h3 id={titleId} className="text-base font-semibold text-slate-900 break-words">
              {title}
            </h3>
            {subtitle ? (
              <p className="text-xs text-slate-500 mt-0.5 break-words">{subtitle}</p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Đóng hộp thoại"
            className="min-w-[44px] min-h-[44px] sm:min-w-0 sm:min-h-0 p-1.5 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100 inline-flex items-center justify-center transition-colors shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className={`p-4 sm:p-6 overflow-y-auto flex-1 ${footer ? '' : 'pb-safe'}`}>
          {children}
        </div>
        {footer ? (
          <div className="px-4 sm:px-6 py-3.5 pb-safe border-t border-slate-100 bg-slate-50/80 flex flex-wrap items-center justify-end gap-2.5 shrink-0">
            {footer}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export default Modal;
