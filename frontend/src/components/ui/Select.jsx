import React, { useId } from 'react';
import { ChevronDown } from 'lucide-react';

export function Select({
  label,
  options = [],
  placeholder,
  error,
  hint,
  required = false,
  id,
  className = '',
  containerClassName = '',
  children,
  ...props
}) {
  const generatedId = useId();
  const fieldId = id || generatedId;

  return (
    <div className={`space-y-1.5 ${containerClassName}`}>
      {label ? (
        <label htmlFor={fieldId} className="block text-xs font-medium text-slate-700">
          {label}
          {required ? <span className="text-rose-500 ml-0.5">*</span> : null}
        </label>
      ) : null}
      <div className="relative">
        <select
          id={fieldId}
          className={`w-full h-9 pl-3 pr-8 rounded-lg border bg-white text-sm text-slate-800 appearance-none transition-colors focus:outline-none focus:ring-2 ${
            error
              ? 'border-rose-400 focus:border-rose-500 focus:ring-rose-500/20'
              : 'border-slate-200 hover:border-slate-300 focus:border-primary-500 focus:ring-primary-500/20'
          } disabled:bg-slate-50 disabled:text-slate-400 ${className}`}
          {...props}
        >
          {placeholder !== undefined ? <option value="">{placeholder}</option> : null}
          {children
            ? children
            : options.map((opt) => {
                const val = typeof opt === 'object' ? opt.value : opt;
                const lbl = typeof opt === 'object' ? opt.label : opt;
                return (
                  <option key={String(val)} value={val}>
                    {lbl}
                  </option>
                );
              })}
        </select>
        <ChevronDown className="w-4 h-4 text-slate-400 absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
      </div>
      {error ? (
        <p className="text-xs text-rose-600">{error}</p>
      ) : hint ? (
        <p className="text-xs text-slate-500">{hint}</p>
      ) : null}
    </div>
  );
}

export default Select;

