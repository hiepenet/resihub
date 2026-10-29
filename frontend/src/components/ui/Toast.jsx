import React from 'react';
import { CheckCircle2, AlertCircle, AlertTriangle, Info, X } from 'lucide-react';
import { useToastStore } from '../../stores/toastStore';

const STYLES = {
  success: {
    icon: CheckCircle2,
    border: 'border-emerald-200 bg-white',
    iconCls: 'text-emerald-500',
  },
  error: {
    icon: AlertCircle,
    border: 'border-rose-200 bg-white',
    iconCls: 'text-rose-500',
  },
  warning: {
    icon: AlertTriangle,
    border: 'border-amber-200 bg-white',
    iconCls: 'text-amber-500',
  },
  info: {
    icon: Info,
    border: 'border-sky-200 bg-white',
    iconCls: 'text-sky-500',
  },
};

export function ToastContainer() {
  const toasts = useToastStore((s) => s.toasts);
  const removeToast = useToastStore((s) => s.removeToast);

  if (toasts.length === 0) return null;

  return (
    <div className="fixed top-4 right-4 z-[60] flex flex-col gap-2.5 w-full max-w-sm pointer-events-none px-4 sm:px-0">
      {toasts.map((t) => {
        const cfg = STYLES[t.variant] || STYLES.info;
        const Icon = cfg.icon;
        return (
          <div
            key={t.id}
            className={`pointer-events-auto flex items-start gap-3 p-3.5 rounded-xl border shadow-elevated transition-all ${cfg.border}`}
          >
            <Icon className={`w-5 h-5 shrink-0 mt-0.5 ${cfg.iconCls}`} />
            <div className="flex-1 min-w-0">
              {t.title ? <p className="text-xs font-semibold text-slate-900">{t.title}</p> : null}
              {t.message ? <p className="text-xs text-slate-600 mt-0.5 leading-relaxed">{t.message}</p> : null}
            </div>
            <button
              type="button"
              onClick={() => removeToast(t.id)}
              className="p-1 text-slate-400 hover:text-slate-600 rounded"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        );
      })}
    </div>
  );
}

export default ToastContainer;

