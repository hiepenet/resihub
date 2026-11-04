import React from 'react';
import { TrendingUp, TrendingDown } from 'lucide-react';

const ICON_COLORS = {
  sky: 'bg-sky-50 text-sky-600 border-sky-100',
  indigo: 'bg-indigo-50 text-indigo-600 border-indigo-100',
  emerald: 'bg-emerald-50 text-emerald-600 border-emerald-100',
  amber: 'bg-amber-50 text-amber-600 border-amber-100',
  rose: 'bg-rose-50 text-rose-600 border-rose-100',
};

export function StatsCard({
  title,
  value,
  valueTitle: propValueTitle,
  subtext,
  icon: Icon,
  trend, // number (% tăng/giảm)
  color = 'sky',
  onClick,
}) {
  const isPositive = typeof trend === 'number' && trend >= 0;
  const valueTitle =
    propValueTitle !== undefined
      ? propValueTitle
      : typeof value === 'string' || typeof value === 'number'
      ? String(value)
      : undefined;

  const handleKeyDown = onClick
    ? (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick(e);
        }
      }
    : undefined;

  return (
    <div
      onClick={onClick}
      onKeyDown={handleKeyDown}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      className={`bg-white rounded-xl border border-slate-200/80 p-4 sm:p-5 shadow-card flex flex-col justify-between transition-all ${
        onClick
          ? 'cursor-pointer hover:border-primary-300 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/40'
          : ''
      }`}
    >
      <div>
        <div className="flex items-start justify-between gap-2.5">
          <p className="text-xs font-medium text-slate-500 uppercase tracking-wide leading-snug pt-0.5">
            {title}
          </p>
          {Icon ? (
            <div
              className={`w-9 h-9 sm:w-10 sm:h-10 rounded-xl border flex items-center justify-center shrink-0 ${
                ICON_COLORS[color] || ICON_COLORS.sky
              }`}
            >
              <Icon className="w-4 h-4 sm:w-5 sm:h-5" />
            </div>
          ) : null}
        </div>

        <p
          title={valueTitle}
          className="text-xl sm:text-2xl font-bold text-slate-900 mt-2 break-words leading-tight tabular-nums"
        >
          {value}
        </p>
      </div>

      {(typeof trend === 'number' || subtext) ? (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 mt-3 pt-2.5 border-t border-slate-100 text-xs">
          {typeof trend === 'number' ? (
            <span
              className={`inline-flex items-center gap-0.5 font-semibold px-1.5 py-0.5 rounded-md shrink-0 ${
                isPositive ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-50 text-rose-700'
              }`}
            >
              {isPositive ? (
                <TrendingUp className="w-3.5 h-3.5" />
              ) : (
                <TrendingDown className="w-3.5 h-3.5" />
              )}
              {isPositive ? '+' : ''}
              {trend}%
            </span>
          ) : null}
          {subtext ? <span className="text-slate-500 leading-snug break-words">{subtext}</span> : null}
        </div>
      ) : null}
    </div>
  );
}

export default StatsCard;

