import React, { useId } from 'react';

export function Input({
  label,
  hint,
  error,
  icon: Icon,
  rightElement,
  required = false,
  multiline = false,
  rows = 3,
  id,
  className = '',
  containerClassName = '',
  ...props
}) {
  const generatedId = useId();
  const fieldId = id || generatedId;
  const baseInputCls = `w-full rounded-lg border bg-white text-sm text-slate-800 placeholder:text-slate-400 transition-colors focus:outline-none focus:ring-2 ${
    error
      ? 'border-rose-400 focus:border-rose-500 focus:ring-rose-500/20'
      : 'border-slate-200 hover:border-slate-300 focus:border-primary-500 focus:ring-primary-500/20'
  } disabled:bg-slate-50 disabled:text-slate-400`;

  return (
    <div className={`space-y-1.5 ${containerClassName}`}>
      {label ? (
        <label htmlFor={fieldId} className="block text-xs font-medium text-slate-700">
          {label}
          {required ? <span className="text-rose-500 ml-0.5">*</span> : null}
        </label>
      ) : null}
      <div className="relative">
        {Icon && !multiline ? (
          <Icon className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
        ) : null}
        {multiline ? (
          <textarea
            id={fieldId}
            rows={rows}
            className={`${baseInputCls} px-3 py-2 ${className}`}
            {...props}
          />
        ) : (
          <input
            id={fieldId}
            className={`${baseInputCls} h-9 ${Icon ? 'pl-9' : 'pl-3'} ${rightElement ? 'pr-9' : 'pr-3'} ${className}`}
            {...props}
          />
        )}
        {rightElement && !multiline ? (
          <div className="absolute right-2.5 top-1/2 -translate-y-1/2 flex items-center">
            {rightElement}
          </div>
        ) : null}
      </div>
      {error ? (
        <p className="text-xs text-rose-600">{error}</p>
      ) : hint ? (
        <p className="text-xs text-slate-500">{hint}</p>
      ) : null}
    </div>
  );
}

export default Input;

