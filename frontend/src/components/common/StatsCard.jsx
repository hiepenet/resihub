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
  subtext,
  icon: Icon,
  trend, // number (% tăng/giảm)
  color = 'sky',
  onClick,
}) {
  const isPositive = typeof trend === 'number' && trend >= 0;
  return (
    <div
      onClick={onClick}
      className={`bg-white rounded-xl border border-slate-200/80 p-5 shadow-card transition-all ${
        onClick ? 'cursor-pointer hover:border-primary-300 hover:shadow-md' : ''
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-medium text-slate-500 uppercase tracking-wide">{title}</p>
          <p className="text-2xl font-bold text-slate-900 mt-1.5 truncate">{value}</p>
        </div>
        {Icon ? (
          <div className={`w-10 h-10 rounded-xl border flex items-center justify-center shrink-0 ${ICON_COLORS[color] || ICON_COLORS.sky}`}>
            <Icon className="w-5 h-5" />
          </div>
        ) : null}
      </div>

      {(typeof trend === 'number' || subtext) ? (
        <div className="flex items-center gap-2 mt-3 text-xs">
          {typeof trend === 'number' ? (
            <span
              className={`inline-flex items-center gap-0.5 font-semibold px-1.5 py-0.5 rounded-md ${
                isPositive ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-50 text-rose-700'
              }`}
            >
              {isPositive ? <TrendingUp className="w-3.5 h-3.5" /> : <TrendingDown className="w-3.5 h-3.5" />}
              {isPositive ? '+' : ''}
              {trend}%
            </span>
          ) : null}
          {subtext ? <span className="text-slate-500 truncate">{subtext}</span> : null}
        </div>
      ) : null}
    </div>
  );
}

export default StatsCard;

