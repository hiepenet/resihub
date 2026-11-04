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
  const errorId = `${fieldId}-error`;
  const hintId = `${fieldId}-hint`;
  const describedBy =
    props['aria-describedby'] || (error ? errorId : hint ? hintId : undefined);

  const baseInputCls = `w-full rounded-lg border bg-white text-base sm:text-sm text-slate-800 placeholder:text-slate-400 transition-colors focus:outline-none focus:ring-2 ${
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
            required={required}
            aria-invalid={Boolean(error)}
            aria-describedby={describedBy}
            className={`${baseInputCls} min-h-[88px] px-3 py-2.5 sm:py-2 ${className}`}
            {...props}
          />
        ) : (
          <input
            id={fieldId}
            required={required}
            aria-invalid={Boolean(error)}
            aria-describedby={describedBy}
            className={`${baseInputCls} min-h-[44px] sm:min-h-0 sm:h-9 ${
              Icon ? 'pl-9' : 'pl-3'
            } ${rightElement ? 'pr-9' : 'pr-3'} ${className}`}
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
        <p id={errorId} role="alert" className="text-xs text-rose-600">
          {error}
        </p>
      ) : hint ? (
        <p id={hintId} className="text-xs text-slate-500">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export default Input;
