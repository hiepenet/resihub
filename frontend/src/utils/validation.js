export function isValidPhone(phone) {
  const clean = String(phone || '').trim().replace(/[\s\-\.\(\)]/g, '');
  return /^(0|\+84)[0-9]{9}$/.test(clean);
}

export function normalizePhone(phone) {
  let clean = String(phone || '').trim().replace(/[\s\-\.\(\)]/g, '');
  if (clean.startsWith('+84')) clean = '0' + clean.slice(3);
  return clean;
}

export function isValidEmail(email) {
  if (!email) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email).trim());
}

export function isValidIdNumber(idNumber) {
  if (!idNumber) return false;
  return /^(\d{9}|\d{12}|[A-Z]\d{7,8})$/i.test(String(idNumber).trim());
}

export function extractErrorMessage(err, fallback = 'Đã xảy ra lỗi. Vui lòng thử lại.') {
  return (
    err?.response?.data?.message ||
    err?.message ||
    fallback
  );
}

