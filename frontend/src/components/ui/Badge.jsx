import React from 'react';

const BADGE_STYLES = {
  sky: 'bg-sky-50 text-sky-700 border-sky-200',
  indigo: 'bg-indigo-50 text-indigo-700 border-indigo-200',
  emerald: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  amber: 'bg-amber-50 text-amber-700 border-amber-200',
  red: 'bg-rose-50 text-rose-700 border-rose-200',
  purple: 'bg-purple-50 text-purple-700 border-purple-200',
  slate: 'bg-slate-100 text-slate-700 border-slate-200',
};

const DOT_STYLES = {
  sky: 'bg-sky-500',
  indigo: 'bg-indigo-500',
  emerald: 'bg-emerald-500',
  amber: 'bg-amber-500',
  red: 'bg-rose-500',
  purple: 'bg-purple-500',
  slate: 'bg-slate-400',
};

export function Badge({ children, variant = 'slate', dot = false, icon: Icon, className = '' }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium border whitespace-nowrap shrink-0 ${
        BADGE_STYLES[variant] || BADGE_STYLES.slate
      } ${className}`}
    >
      {dot ? <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${DOT_STYLES[variant] || DOT_STYLES.slate}`} /> : null}
      {Icon ? <Icon className="w-3.5 h-3.5 shrink-0" /> : null}
      {children}
    </span>
  );
}

export default Badge;

