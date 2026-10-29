import React from 'react';
import { Loader2 } from 'lucide-react';

export function LoadingSpinner({ label = 'Đang tải dữ liệu...', fullScreen = false }) {
  return (
    <div
      className={`flex flex-col items-center justify-center gap-2.5 text-slate-500 ${
        fullScreen ? 'min-h-screen' : 'py-16'
      }`}
    >
      <Loader2 className="w-7 h-7 animate-spin text-primary-500" />
      {label ? <span className="text-xs font-medium">{label}</span> : null}
    </div>
  );
}

export default LoadingSpinner;

