/**
 * Bộ tiện ích che dữ liệu định danh nhạy cảm (PII Masking) và Rate Limit tra cứu
 * Tuân thủ PRD v2.0 Mục 13.5, 14.2, 17.1 & NFR-007.
 */

export function maskName(fullName) {
  const clean = String(fullName || '').trim().replace(/\s+/g, ' ');
  if (!clean) return '***';
  const parts = clean.split(' ');
  if (parts.length === 1) {
    return `${parts[0].slice(0, 1)}***`;
  }
  if (parts.length === 2) {
    return `${parts[0]} ${parts[1].slice(0, 1)}***`;
  }
  return `${parts[0]} *** ${parts[parts.length - 1]}`;
}

export function maskEmail(email) {
  const clean = String(email || '').trim();
  const atIdx = clean.indexOf('@');
  if (!clean || atIdx <= 0) return null;
  const local = clean.slice(0, atIdx);
  const domain = clean.slice(atIdx + 1);
  const prefix = local.length >= 3 ? local.slice(0, 2) : local.slice(0, 1);
  return `${prefix}***@${domain}`;
}

export function maskPhone(phone) {
  const clean = String(phone || '').trim();
  if (!clean) return null;
  if (clean.length <= 6) return `${clean.slice(0, 2)}***`;
  return `${clean.slice(0, 3)}****${clean.slice(-3)}`;
}

export function maskIdNumber(idNumber) {
  const clean = String(idNumber || '').trim();
  if (!clean) return null;
  if (clean.length <= 4) return `****${clean}`;
  return `${'*'.repeat(Math.max(4, clean.length - 4))}${clean.slice(-4)}`;
}

export function buildOwnerPreview(ownerRow) {
  // FIX BP-009: dùng != null thay vì !ownerRow.id để id=0 (hợp lệ) không bị trả null
  if (!ownerRow || ownerRow.id == null) return null;
  return {
    id: ownerRow.id,
    masked_name: maskName(ownerRow.full_name),
    masked_email: maskEmail(ownerRow.email),
    masked_phone: maskPhone(ownerRow.phone),
  };
}

/**
 * Sliding-window rate limiter theo userId để chống dò quét Email / SĐT / CCCD hàng loạt.
 */
export function checkLookupRateLimit(bucketMap, key, maxHits = 20, windowMs = 5 * 60 * 1000) {
  const now = Date.now();
  const prev = bucketMap.get(key) || [];
  const recent = prev.filter((ts) => now - ts < windowMs);
  if (recent.length >= maxHits) {
    const oldest = recent[0];
    const retryAfterSec = Math.max(1, Math.ceil((windowMs - (now - oldest)) / 1000));
    bucketMap.set(key, recent);
    return { allowed: false, retryAfterSec };
  }
  recent.push(now);
  bucketMap.set(key, recent);
  return { allowed: true, retryAfterSec: 0 };
}

