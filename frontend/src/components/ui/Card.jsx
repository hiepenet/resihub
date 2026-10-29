import React from 'react';

export function Card({ children, className = '', padding = true, ...props }) {
  return (
    <div
      className={`bg-white rounded-xl border border-slate-200/80 shadow-card ${
        padding ? 'p-5' : ''
      } ${className}`}
      {...props}
    >
      {children}
    </div>
  );
}

export function CardHeader({ title, subtitle, action, className = '' }) {
  return (
    <div className={`flex flex-wrap items-center justify-between gap-3 mb-4 ${className}`}>
      <div>
        <h3 className="text-sm font-semibold text-slate-900">{title}</h3>
        {subtitle ? <p className="text-xs text-slate-500 mt-0.5">{subtitle}</p> : null}
      </div>
      {action ? <div className="flex items-center gap-2">{action}</div> : null}
    </div>
  );
}

export default Card;

