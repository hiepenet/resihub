import { adminPool } from '../db/client.js';

// Shared in-memory OTP storage across /auth/otp/* and /public/reservations/*:
// { phone: { otp, expiresAt, attempts, lockedUntil } }
export const otpStore = new Map();

// Shared in-memory phone rate limit tracker: { phone: [timestamps] }
export const phoneRequestTracker = new Map();

const OTP_MAX_REQ_PER_HOUR = 3;
const OTP_TTL_MS = 5 * 60 * 1000;
const OTP_LOCK_MS = 15 * 60 * 1000;
const OTP_MAX_ATTEMPTS = 5;

/**
 * Kiểm tra giới hạn gửi OTP (3 lần/giờ/SĐT) và trạng thái khóa 15 phút (AC-001.2),
 * đồng thời sinh mã OTP 6 chữ số có hiệu lực 5 phút.
 * Nếu store = false (VD: SĐT không tồn tại trên luồng đăng nhập), chỉ ghi nhận bộ đếm chống dò quét.
 */
export function requestPhoneOtp(cleanPhone, { now = Date.now(), store = true } = {}) {
  const oneHourAgo = now - 60 * 60 * 1000;
  const history = phoneRequestTracker.get(cleanPhone) || [];
  const recentHistory = history.filter((ts) => ts > oneHourAgo);

  if (recentHistory.length >= OTP_MAX_REQ_PER_HOUR) {
    return {
      ok: false,
      status: 429,
      code: 'RATE_LIMIT_EXCEEDED',
      message:
        'Bạn đã yêu cầu gửi OTP quá 3 lần trong 1 giờ. Vui lòng đợi thêm hoặc liên hệ quản trị viên.',
    };
  }

  recentHistory.push(now);
  phoneRequestTracker.set(cleanPhone, recentHistory);

  const existingRecord = otpStore.get(cleanPhone);
  if (existingRecord && existingRecord.lockedUntil && existingRecord.lockedUntil > now) {
    const minutesLeft = Math.ceil((existingRecord.lockedUntil - now) / 60000);
    return {
      ok: false,
      status: 429,
      code: 'ACCOUNT_LOCKED',
      message: `Số điện thoại này đang bị tạm khóa do nhập sai quá 5 lần. Vui lòng thử lại sau ${minutesLeft} phút.`,
    };
  }

  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  const expiresAt = now + OTP_TTL_MS;

  if (store) {
    otpStore.set(cleanPhone, {
      otp,
      expiresAt,
      attempts: 0,
      lockedUntil: null,
    });
  }

  return { ok: true, otp, expiresAt };
}

/**
 * Lưu OTP vào kho dùng chung sau khi đã kiểm tra điều kiện tài khoản (dành cho luồng /auth/otp/request).
 */
export function storePhoneOtp(cleanPhone, otp, expiresAt) {
  otpStore.set(cleanPhone, {
    otp,
    expiresAt,
    attempts: 0,
    lockedUntil: null,
  });
}

/**
 * Xóa OTP đã xác thực thành công khỏi kho.
 */
export function consumePhoneOtp(cleanPhone) {
  otpStore.delete(cleanPhone);
}

/**
 * Xác thực mã OTP dùng chung giữa /auth/otp/verify và /public/reservations:
 * - Chia sẻ chung bộ đếm sai (quá 5 lần sai khóa 15 phút + ghi audit_log).
 * - allowDevMasterOtp mặc định FALSE (luồng công khai tuyệt đối không mở bypass '123456').
 */
export async function verifyPhoneOtp(
  cleanPhone,
  otp,
  {
    allowDevMasterOtp = false,
    lockAuditAction = 'AUTH_LOCK',
    dbPool = adminPool,
    consumeOnSuccess = true,
  } = {}
) {
  const now = Date.now();
  const record = otpStore.get(cleanPhone);
  const rawOtp = String(otp ?? '').trim();

  if (record && record.lockedUntil && record.lockedUntil > now) {
    const minutesLeft = Math.ceil((record.lockedUntil - now) / 60000);
    return {
      ok: false,
      status: 429,
      code: 'TOO_MANY_ATTEMPTS',
      message: `Quá nhiều lần thử sai. Vui lòng thử lại sau ${minutesLeft} phút.`,
    };
  }

  const isDevMasterOtp =
    Boolean(allowDevMasterOtp) && process.env.NODE_ENV !== 'production' && rawOtp === '123456';

  if (!record && !isDevMasterOtp) {
    return {
      ok: false,
      status: 400,
      code: 'OTP_NOT_FOUND',
      message: 'Mã OTP không tồn tại hoặc đã hết hạn. Vui lòng gửi lại yêu cầu.',
    };
  }

  if (record && !isDevMasterOtp) {
    if (now > record.expiresAt) {
      otpStore.delete(cleanPhone);
      return {
        ok: false,
        status: 400,
        code: 'OTP_EXPIRED',
        message: 'Mã OTP đã hết hiệu lực (quá 5 phút). Vui lòng gửi lại mã mới.',
      };
    }

    if (record.otp !== rawOtp) {
      record.attempts = (record.attempts || 0) + 1;
      if (record.attempts >= OTP_MAX_ATTEMPTS) {
        record.lockedUntil = now + OTP_LOCK_MS;
        try {
          await dbPool.query(
            `INSERT INTO audit_log (actor_id, action, entity, entity_id, after)
             VALUES ($1, $2, 'phone', gen_random_uuid(), $3)`,
            [null, lockAuditAction, JSON.stringify({ phone: cleanPhone })]
          );
        } catch (auditErr) {
          console.error('[Audit Lock Error]:', auditErr);
        }
        return {
          ok: false,
          status: 429,
          code: 'TOO_MANY_ATTEMPTS',
          message: 'Bạn đã nhập sai quá 5 lần. Số điện thoại bị tạm khóa 15 phút.',
        };
      }

      return {
        ok: false,
        status: 400,
        code: 'OTP_INVALID',
        message: `Mã OTP không chính xác. Bạn còn ${OTP_MAX_ATTEMPTS - record.attempts} lần thử.`,
      };
    }

    if (consumeOnSuccess) {
      otpStore.delete(cleanPhone);
    }
  }

  return { ok: true };
}
