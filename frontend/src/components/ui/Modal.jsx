import React, { useEffect } from 'react';
import { X } from 'lucide-react';

const MAX_WIDTHS = {
  sm: 'max-w-md',
  md: 'max-w-lg',
  lg: 'max-w-2xl',
  xl: 'max-w-4xl',
  full: 'max-w-6xl',
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
        <div className="fixed inset-0" onClick={onClose} />
        <div className="relative z-10 w-full max-w-lg bg-white h-full shadow-2xl border-l border-slate-200 flex flex-col">
          <div className="px-6 py-4 border-b border-slate-200 flex items-start justify-between gap-4">
            <div>
              <h3 className="text-base font-semibold text-slate-900">{title}</h3>
              {subtitle ? <p className="text-xs text-slate-500 mt-0.5">{subtitle}</p> : null}
            </div>
            <button
              type="button"
              onClick={onClose}
              className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto p-6">{children}</div>
          {footer ? (
            <div className="px-6 py-3.5 border-t border-slate-200 bg-slate-50/70 flex flex-wrap items-center justify-end gap-2.5">
              {footer}
            </div>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/45 backdrop-blur-[1px] overflow-y-auto">
      <div className="fixed inset-0" onClick={onClose} />
      <div
        className={`relative z-10 w-full ${
          MAX_WIDTHS[size] || MAX_WIDTHS.md
        } bg-white rounded-2xl shadow-elevated border border-slate-200/80 max-h-[90vh] flex flex-col overflow-hidden`}
      >
        <div className="px-6 py-4 border-b border-slate-100 flex items-start justify-between gap-4 shrink-0">
          <div>
            <h3 className="text-base font-semibold text-slate-900">{title}</h3>
            {subtitle ? <p className="text-xs text-slate-500 mt-0.5">{subtitle}</p> : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="p-6 overflow-y-auto flex-1">{children}</div>
        {footer ? (
          <div className="px-6 py-3.5 border-t border-slate-100 bg-slate-50/80 flex flex-wrap items-center justify-end gap-2.5 shrink-0">
            {footer}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export default Modal;

