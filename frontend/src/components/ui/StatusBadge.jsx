import React from 'react';

const STATUS_CONFIG = {
  // Real Estate (Căn hộ)
  AVAILABLE: {
    label: 'Có sẵn',
    className: 'bg-emerald-50 text-emerald-700 border-emerald-200/80 ring-emerald-500/10',
    dot: 'bg-emerald-500',
  },
  OCCUPIED: {
    label: 'Đang thuê',
    className: 'bg-indigo-50 text-indigo-700 border-indigo-200/80 ring-indigo-500/10',
    dot: 'bg-indigo-500',
  },
  RESERVED: {
    label: 'Đã cọc giữ chỗ',
    className: 'bg-amber-50 text-amber-700 border-amber-200/80 ring-amber-500/10',
    dot: 'bg-amber-500',
  },
  MAINTENANCE: {
    label: 'Bảo trì',
    className: 'bg-rose-50 text-rose-700 border-rose-200/80 ring-rose-500/10',
    dot: 'bg-rose-500',
  },
  INACTIVE: {
    label: 'Không kinh doanh',
    className: 'bg-slate-50 text-slate-600 border-slate-200/80 ring-slate-500/10',
    dot: 'bg-slate-400',
  },

  // Hợp đồng
  DRAFT: {
    label: 'Bản nháp',
    className: 'bg-slate-50 text-slate-600 border-slate-200 ring-slate-400/10',
    dot: 'bg-slate-400',
  },
  PENDING_APPROVAL: {
    label: 'Chờ duyệt',
    className: 'bg-amber-50 text-amber-700 border-amber-200 ring-amber-400/10',
    dot: 'bg-amber-500',
  },
  ACTIVE: {
    label: 'Hiệu lực',
    className: 'bg-emerald-50 text-emerald-700 border-emerald-200 ring-emerald-500/10',
    dot: 'bg-emerald-500',
  },
  RENEWAL_PENDING: {
    label: 'Chờ tái ký',
    className: 'bg-blue-50 text-blue-700 border-blue-200 ring-blue-500/10',
    dot: 'bg-blue-500',
  },
  EXPIRED: {
    label: 'Hết hạn',
    className: 'bg-rose-50 text-rose-700 border-rose-200 ring-rose-500/10',
    dot: 'bg-rose-500',
  },
  TERMINATED: {
    label: 'Đã thanh lý',
    className: 'bg-slate-100 text-slate-600 border-slate-200 ring-slate-400/10',
    dot: 'bg-slate-400',
  },
  TERMINATION_PENDING: {
    label: 'Chờ duyệt thanh lý',
    className: 'bg-amber-50 text-amber-700 border-amber-200 ring-amber-400/10',
    dot: 'bg-amber-500',
  },

  // Cọc
  HELD: {
    label: 'Đang giữ cọc',
    className: 'bg-blue-50 text-blue-700 border-blue-200 ring-blue-500/10',
    dot: 'bg-blue-500',
  },
  REFUNDED: {
    label: 'Đã hoàn cọc',
    className: 'bg-emerald-50 text-emerald-700 border-emerald-200 ring-emerald-500/10',
    dot: 'bg-emerald-500',
  },
  DISPUTED: {
    label: 'Tranh chấp',
    className: 'bg-red-50 text-red-700 border-red-200 ring-red-500/10',
    dot: 'bg-red-500',
  },
  SETTLEMENT_DRAFT: {
    label: 'Nháp tất toán',
    className: 'bg-slate-50 text-slate-600 border-slate-200 ring-slate-400/10',
    dot: 'bg-slate-400',
  },
};

export default function StatusBadge({ status, customLabel, size = 'md', className = '' }) {
  const normalizedStatus = (status || '').toUpperCase();
  const config = STATUS_CONFIG[normalizedStatus] || {
    label: customLabel || status || 'Chưa xác định',
    className: 'bg-slate-100 text-slate-700 border-slate-200 ring-slate-400/10',
    dot: 'bg-slate-400',
  };

  const displayLabel = customLabel || config.label;

  const sizeStyles = {
    sm: 'text-xs px-2 py-0.5 gap-1.5',
    md: 'text-xs px-2.5 py-1 gap-1.5 font-medium',
    lg: 'text-sm px-3 py-1.5 gap-2 font-medium',
  };

  return (
    <span
      className={`inline-flex items-center rounded-full border ring-1 ring-inset ${
        sizeStyles[size] || sizeStyles.md
      } ${config.className} ${className}`}
    >
      <span className={`w-1.5 h-1.5 rounded-full ${config.dot}`} />
      <span>{displayLabel}</span>
    </span>
  );
}
