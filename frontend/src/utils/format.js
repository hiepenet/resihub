import { toDateOnlyStr } from './dateRange.js';

export function formatMoney(amount, showSymbol = true) {
  const num = Number(amount || 0);
  if (Number.isNaN(num)) return showSymbol ? '0 ₫' : '0';
  const formatted = new Intl.NumberFormat('vi-VN').format(Math.round(num));
  return showSymbol ? `${formatted} ₫` : formatted;
}

export function formatCompactMoney(amount) {
  const num = Number(amount || 0);
  if (Math.abs(num) >= 1_000_000_000) {
    return `${(num / 1_000_000_000).toFixed(2).replace(/\.00$/, '')} tỷ ₫`;
  }
  if (Math.abs(num) >= 1_000_000) {
    return `${(num / 1_000_000).toFixed(1).replace(/\.0$/, '')} tr ₫`;
  }
  return formatMoney(num);
}

export function formatDate(dateVal) {
  if (!dateVal) return '—';
  const d = new Date(dateVal);
  if (Number.isNaN(d.getTime())) return '—';
  return new Intl.DateTimeFormat('vi-VN', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(d);
}

export function formatDateTime(dateVal) {
  if (!dateVal) return '—';
  const d = new Date(dateVal);
  if (Number.isNaN(d.getTime())) return '—';
  return new Intl.DateTimeFormat('vi-VN', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(d);
}

export function formatRelativeTime(dateVal) {
  if (!dateVal) return '';
  const d = new Date(dateVal);
  if (Number.isNaN(d.getTime())) return '';
  const diffSec = Math.floor((Date.now() - d.getTime()) / 1000);
  if (diffSec < 60) return 'Vừa xong';
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)} phút trước`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)} giờ trước`;
  if (diffSec < 86400 * 7) return `${Math.floor(diffSec / 86400)} ngày trước`;
  return formatDate(dateVal);
}

export function toInputDate(dateVal) {
  return toDateOnlyStr(dateVal);
}

export function getCurrentPeriod(now = new Date()) {
  const dt = now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date(now);
  const safeDt = Number.isNaN(dt.getTime()) ? new Date() : dt;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Ho_Chi_Minh',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
    .format(safeDt)
    .slice(0, 7);
}

export function maskIdNumber(idNumber) {
  const clean = String(idNumber || '').trim();
  if (!clean) return '—';
  if (clean.length <= 4) return `****${clean}`;
  return `${'*'.repeat(Math.max(4, clean.length - 4))}${clean.slice(-4)}`;
}

export function maskPhone(phone) {
  const clean = String(phone || '').trim();
  if (!clean) return '—';
  if (clean.length <= 6) return `${clean.slice(0, 2)}***`;
  return `${clean.slice(0, 3)}****${clean.slice(-3)}`;
}

export function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = (err) => reject(err);
    reader.readAsDataURL(file);
  });
}

export function exportToCsv(filename, headers, rows) {
  const escapeCell = (val) => {
    if (val === null || val === undefined) return '';
    const str = String(val).replace(/"/g, '""');
    return /[",\n\r]/.test(str) ? `"${str}"` : str;
  };

  const lines = [
    headers.map((h) => escapeCell(h.label)).join(','),
    ...rows.map((row) => headers.map((h) => escapeCell(typeof h.accessor === 'function' ? h.accessor(row) : row[h.key])).join(',')),
  ];

  // BOM để Excel đọc chuẩn UTF-8 Tiếng Việt
  const blob = new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename.endsWith('.csv') ? filename : `${filename}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

