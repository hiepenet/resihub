import React from 'react';

export default function Input({
  id,
  type = 'text',
  placeholder = '',
  value,
  onChange,
  disabled = false,
  error = false,
  className = '',
  leftIcon: LeftIcon,
  rightIcon: RightIcon,
  ...props
}) {
  return (
    <div className="relative rounded-lg shadow-sm w-full">
      {LeftIcon && (
        <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3 text-slate-400">
          <LeftIcon className="h-4 w-4" aria-hidden="true" />
        </div>
      )}
      <input
        id={id}
        type={type}
        value={value}
        onChange={onChange}
        disabled={disabled}
        placeholder={placeholder}
        className={`block w-full rounded-lg border py-2 text-sm transition-all duration-150 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-offset-1 disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-400 ${
          LeftIcon ? 'pl-9' : 'pl-3.5'
        } ${RightIcon ? 'pr-9' : 'pr-3.5'} ${
          error
            ? 'border-red-400 text-red-900 focus:border-red-500 focus:ring-red-500 bg-red-50/20'
            : 'border-slate-300 text-slate-900 focus:border-primary-500 focus:ring-primary-500 bg-white hover:border-slate-400'
        } ${className}`}
        {...props}
      />
      {RightIcon && (
        <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-3 text-slate-400">
          <RightIcon className="h-4 w-4" aria-hidden="true" />
        </div>
      )}
    </div>
  );
}
