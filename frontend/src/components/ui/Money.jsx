import React from 'react';

/**
 * Money component formatting VND according to PRD 16.1
 * Example: 7500000 -> 7.500.000 ₫
 */
export default function Money({
  amount,
  currency = '₫',
  showSign = false,
  colorCode = false,
  className = '',
}) {
  const numericAmount = typeof amount === 'bigint' ? Number(amount) : Number(amount) || 0;

  // Format with dots as thousands separators (standard Vietnamese accounting)
  const formatted = Math.abs(numericAmount).toLocaleString('vi-VN');

  let sign = '';
  if (numericAmount > 0 && showSign) sign = '+';
  if (numericAmount < 0) sign = '-';

  let colorClass = '';
  if (colorCode) {
    if (numericAmount > 0) colorClass = 'text-emerald-600 font-semibold';
    else if (numericAmount < 0) colorClass = 'text-red-600 font-semibold';
    else colorClass = 'text-slate-600';
  }

  return (
    <span className={`tabular-nums font-medium ${colorClass} ${className}`}>
      {sign}
      {formatted} {currency}
    </span>
  );
}
