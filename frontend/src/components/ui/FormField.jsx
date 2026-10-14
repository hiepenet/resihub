import React from 'react';
import { AlertCircle } from 'lucide-react';

export default function FormField({
  id,
  label,
  required = false,
  hint,
  error,
  children,
  className = '',
}) {
  return (
    <div className={`space-y-1.5 ${className}`}>
      {label && (
        <label htmlFor={id} className="block text-xs font-semibold text-slate-700 tracking-wide uppercase">
          {label}
          {required && <span className="text-red-500 ml-1">*</span>}
        </label>
      )}

      {children}

      {hint && !error && (
        <p className="text-xs text-slate-500 mt-1">{hint}</p>
      )}

      {error && (
        <div className="flex items-center gap-1.5 text-xs text-red-600 mt-1">
          <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" />
          <span>{error}</span>
        </div>
      )}
    </div>
  );
}
