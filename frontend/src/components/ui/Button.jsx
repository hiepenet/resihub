import React from 'react';
import { Loader2 } from 'lucide-react';

const VARIANTS = {
  primary: 'bg-primary-500 hover:bg-primary-600 text-white shadow-sm focus-visible:ring-primary-500',
  secondary: 'bg-secondary-600 hover:bg-secondary-700 text-white shadow-sm focus-visible:ring-secondary-500',
  outline: 'bg-white hover:bg-slate-50 text-slate-700 border border-slate-200 shadow-sm focus-visible:ring-slate-300',
  ghost: 'bg-transparent hover:bg-slate-100 text-slate-600 hover:text-slate-900',
  success: 'bg-emerald-600 hover:bg-emerald-700 text-white shadow-sm focus-visible:ring-emerald-500',
  warning: 'bg-amber-500 hover:bg-amber-600 text-white shadow-sm focus-visible:ring-amber-500',
  danger: 'bg-rose-600 hover:bg-rose-700 text-white shadow-sm focus-visible:ring-rose-500',
  soft: 'bg-primary-50 hover:bg-primary-100 text-primary-700 border border-primary-100',
};

const SIZES = {
  xs: 'h-7 px-2.5 text-xs gap-1 rounded-md',
  sm: 'h-8 px-3 text-xs gap-1.5 rounded-lg',
  md: 'h-9 px-4 text-sm gap-2 rounded-lg',
  lg: 'h-11 px-5 text-sm gap-2 rounded-xl',
};

export function Button({
  children,
  variant = 'primary',
  size = 'md',
  loading = false,
  disabled = false,
  icon: Icon,
  rightIcon: RightIcon,
  className = '',
  type = 'button',
  ...props
}) {
  const isDisabled = disabled || loading;
  return (
    <button
      type={type}
      disabled={isDisabled}
      className={`inline-flex items-center justify-center font-medium whitespace-nowrap shrink-0 transition-all duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-1 disabled:opacity-50 disabled:cursor-not-allowed select-none ${
        VARIANTS[variant] || VARIANTS.primary
      } ${SIZES[size] || SIZES.md} ${className}`}
      {...props}
    >
      {loading ? (
        <Loader2 className="w-4 h-4 animate-spin shrink-0" />
      ) : Icon ? (
        <Icon className="w-4 h-4 shrink-0" />
      ) : null}
      {children}
      {RightIcon && !loading ? <RightIcon className="w-4 h-4 shrink-0" /> : null}
    </button>
  );
}

export default Button;

