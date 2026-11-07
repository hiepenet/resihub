import React from 'react';

export function Table({ children, className = '' }) {
  return (
    <div className="w-full max-w-full min-w-0 overflow-x-auto">
      <table className={`w-full border-collapse ${className}`}>{children}</table>
    </div>
  );
}

export function THead({ children, className = '' }) {
  return (
    <thead className={`bg-slate-50/95 border-b border-slate-200/90 ${className}`}>
      {children}
    </thead>
  );
}

export function TBody({ children, className = '' }) {
  return <tbody className={`divide-y divide-slate-100 bg-white ${className}`}>{children}</tbody>;
}

export function TH({ children, className = '', ...props }) {
  const alignCls = /\btext-(left|center|right)\b/.test(className) ? '' : 'text-left';
  return (
    <th
      className={`px-2.5 py-2.5 sm:px-3 first:pl-4 last:pr-4 text-xs font-semibold text-slate-600 tracking-normal whitespace-nowrap align-middle ${alignCls} ${className}`.trim()}
      {...props}
    >
      {children}
    </th>
  );
}

export function TD({ children, className = '', ...props }) {
  const alignCls = /\btext-(left|center|right)\b/.test(className) ? '' : 'text-left';
  return (
    <td
      className={`px-2.5 py-2.5 sm:px-3 first:pl-4 last:pr-4 text-sm text-slate-700 align-middle ${alignCls} ${className}`.trim()}
      {...props}
    >
      {children}
    </td>
  );
}

export default Table;
