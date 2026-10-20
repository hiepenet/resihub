import 'dotenv/config';
import express from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { adminPool as pool } from '../db/client.js';
import { otpRequestLimiter } from '../middleware/rateLimiter.js';
import { authenticateToken } from '../middleware/auth.js';
import { JWT_SECRET, JWT_REFRESH_SECRET } from '../config/env.js';

const router = express.Router();

// In-memory OTP storage: { phone: { otp, expiresAt, attempts, lockedUntil } }
const otpStore = new Map();

// In-memory phone rate limit tracker: { phone: [timestamps] }
const phoneRequestTracker = new Map();

// Helper to sign JWT (15m Access Token, 7d Refresh Token)
function generateTokens(payload) {
  const accessToken = jwt.sign(payload, JWT_SECRET, { expiresIn: '15m' });
  const refreshToken = jwt.sign(payload, JWT_REFRESH_SECRET, { expiresIn: '7d' });
  return { accessToken, refreshToken };
}

/**
 * =========================================================================
 * NV-01: ĐĂNG NHẬP OTP (Cư dân & Nhân viên qua SĐT) - FR-001, FR-002
 * =========================================================================
 */

/**
 * POST /api/v1/auth/otp/request
 * Gửi OTP qua SMS (Dev: log console & trả về trong response tiện dev)
 * Rate limit: 10 req/phút/IP (qua middleware) + 3 req/giờ/SĐT
 */
router.post('/otp/request', otpRequestLimiter, async (req, res) => {
  const { phone } = req.body;
  
  // Validation: Đúng định dạng VN (10 số, bắt đầu bằng 0 hoặc +84)
  if (!phone || !/^(0|\+84)[0-9]{9,10}$/.test(phone)) {
    return res.status(400).json({
      code: 'INVALID_PHONE',
      message: 'Số điện thoại không hợp lệ. Vui lòng nhập định dạng 10 số (ví dụ: 0901234567).',
    });
  }

  const cleanPhone = phone.startsWith('+84') ? '0' + phone.slice(3) : phone;

  // Kiểm tra số lần request trên SĐT trong 1 giờ qua (Tối đa 3 lần/giờ/SĐT)
  const now = Date.now();
  const oneHourAgo = now - 60 * 60 * 1000;
  const history = phoneRequestTracker.get(cleanPhone) || [];
  const recentHistory = history.filter((ts) => ts > oneHourAgo);

  if (recentHistory.length >= 3) {
    return res.status(429).json({
      code: 'RATE_LIMIT_EXCEEDED',
      message: 'Bạn đã yêu cầu gửi OTP quá 3 lần trong 1 giờ. Vui lòng đợi thêm hoặc liên hệ quản trị viên.',
    });
  }

  recentHistory.push(now);
  phoneRequestTracker.set(cleanPhone, recentHistory);

  // Kiểm tra xem SĐT có đang bị lock do nhập sai quá 5 lần không
  const existingRecord = otpStore.get(cleanPhone);
  if (existingRecord && existingRecord.lockedUntil && existingRecord.lockedUntil > now) {
    const minutesLeft = Math.ceil((existingRecord.lockedUntil - now) / 60000);
    return res.status(429).json({
      code: 'ACCOUNT_LOCKED',
      message: `Số điện thoại này đang bị tạm khóa do nhập sai quá 5 lần. Vui lòng thử lại sau ${minutesLeft} phút.`,
    });
  }

  // D6 / AC-001.3: Kiểm tra người dùng có tồn tại trong hệ thống và ở trạng thái ACTIVE không
  const acct = await pool.query(
    `SELECT au.status 
     FROM person p 
     JOIN app_user au ON au.person_id = p.id 
     WHERE p.phone = $1`,
    [cleanPhone]
  );

  // Nếu không tồn tại hoặc không ACTIVE: trả thông điệp trung lập, KHÔNG sinh và không lưu OTP (chống dò số)
  if (acct.rows.length === 0 || acct.rows[0].status !== 'ACTIVE') {
    return res.json({
      message: 'OTP đã được gửi thành công.',
    });
  }

  // Sinh mã OTP 6 số ngẫu nhiên
  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  const expiresAt = now + 5 * 60 * 1000; // TTL: 5 phút

  otpStore.set(cleanPhone, {
    otp,
    expiresAt,
    attempts: 0,
    lockedUntil: null,
  });

  console.log(`\n=============================================`);
  console.log(`[SMS MOCK] Mã OTP cho số ${cleanPhone}: 👉 ${otp} 👈`);
  console.log(`=============================================\n`);

  // Thông điệp trung lập, không tiết lộ SĐT có tồn tại hay không (chống enumeration attack)
  res.json({
    message: 'OTP đã được gửi thành công.',
    devOtp: process.env.NODE_ENV !== 'production' ? otp : undefined,
  });
});

/**
 * POST /api/v1/auth/otp/verify
 * Xác thực mã OTP và sinh Access Token (15m) + Refresh Token (7d / 30m)
 */
router.post('/otp/verify', async (req, res) => {
  const { phone, otp } = req.body;

  if (!phone || !otp) {
    return res.status(400).json({
      code: 'MISSING_DATA',
      message: 'Vui lòng cung cấp số điện thoại và mã OTP.',
    });
  }

  const cleanPhone = phone.startsWith('+84') ? '0' + phone.slice(3) : phone;
  const now = Date.now();
  const record = otpStore.get(cleanPhone);

  // Mặc định hỗ trợ OTP test 123456 trong môi trường dev
  const isDevMasterOtp = process.env.NODE_ENV !== 'production' && otp === '123456';

  if (!record && !isDevMasterOtp) {
    return res.status(400).json({
      code: 'OTP_NOT_FOUND',
      message: 'Mã OTP không tồn tại hoặc đã hết hạn. Vui lòng gửi lại yêu cầu.',
    });
  }

  if (record && !isDevMasterOtp) {
    // Kiểm tra lock
    if (record.lockedUntil && record.lockedUntil > now) {
      const minutesLeft = Math.ceil((record.lockedUntil - now) / 60000);
      return res.status(429).json({
        code: 'TOO_MANY_ATTEMPTS',
        message: `Quá nhiều lần thử sai. Vui lòng thử lại sau ${minutesLeft} phút.`,
      });
    }

    // Kiểm tra hết hạn 5 phút
    if (now > record.expiresAt) {
      otpStore.delete(cleanPhone);
      return res.status(400).json({
        code: 'OTP_EXPIRED',
        message: 'Mã OTP đã hết hiệu lực (quá 5 phút). Vui lòng gửi lại mã mới.',
      });
    }

    // Kiểm tra max 5 lần thử sai
    if (record.otp !== otp) {
      record.attempts += 1;
      if (record.attempts >= 5) {
        record.lockedUntil = now + 15 * 60 * 1000; // Khóa 15 phút
        try {
          await pool.query(
            `INSERT INTO audit_log (actor_id, action, entity, entity_id, after)
             VALUES ($1, 'AUTH_LOCK', 'phone', gen_random_uuid(), $2)`,
            [null, JSON.stringify({ phone: cleanPhone })]
          );
        } catch (auditErr) {
          console.error('[Audit Lock Error]:', auditErr);
        }
        return res.status(429).json({
          code: 'TOO_MANY_ATTEMPTS',
          message: 'Bạn đã nhập sai quá 5 lần. Số điện thoại bị tạm khóa 15 phút.',
        });
      }

      return res.status(400).json({
        code: 'OTP_INVALID',
        message: `Mã OTP không chính xác. Bạn còn ${5 - record.attempts} lần thử.`,
      });
    }

    // Nhập đúng -> xóa OTP khỏi store
    otpStore.delete(cleanPhone);
  }

  try {
    // D6: Chỉ cho phép người dùng đã tồn tại trong CSDL
    const personRes = await pool.query('SELECT * FROM person WHERE phone = $1', [cleanPhone]);
    if (personRes.rows.length === 0) {
      return res.status(400).json({
        code: 'OTP_NOT_FOUND',
        message: 'Mã OTP không tồn tại hoặc đã hết hạn. Vui lòng gửi lại yêu cầu.',
      });
    }
    const person = personRes.rows[0];
    const orgId = person.org_id;

    const userRes = await pool.query('SELECT * FROM app_user WHERE person_id = $1', [person.id]);
    if (userRes.rows.length === 0) {
      return res.status(400).json({
        code: 'OTP_NOT_FOUND',
        message: 'Mã OTP không tồn tại hoặc đã hết hạn. Vui lòng gửi lại yêu cầu.',
      });
    }
    const appUser = userRes.rows[0];

    // Kiểm tra trạng thái tài khoản
    if (appUser.status === 'SUSPENDED') {
      return res.status(403).json({
        code: 'ACCOUNT_SUSPENDED',
        message: 'Tài khoản của bạn đã bị tạm khóa. Vui lòng liên hệ ban quản lý.',
      });
    }

    await pool.query('UPDATE app_user SET last_login_at = NOW() WHERE id = $1', [appUser.id]);

    // Lấy danh sách roles của user
    const rolesRes = await pool.query(`
      SELECT r.code, r.name, r.scope, ur.building_id
      FROM user_role ur
      JOIN role r ON r.id = ur.role_id
      WHERE ur.user_id = $1
    `, [appUser.id]);

    const roles = rolesRes.rows.length > 0
      ? rolesRes.rows
      : [{ code: 'RESIDENT', name: 'Cư dân', scope: 'building', building_id: null }];

    const payload = {
      sub: appUser.id,
      person_id: person.id,
      org_id: orgId,
      phone: person.phone,
      full_name: person.full_name,
      roles: roles.map((r) => ({ code: r.code, name: r.name, building_id: r.building_id })),
    };

    const tokens = generateTokens(payload);

    res.json({
      message: 'Xác thực thành công.',
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      user: payload,
    });
  } catch (err) {
    console.error('[Auth Error]:', err);
    res.status(500).json({
      code: 'SERVER_ERROR',
      message: 'Đã xảy ra lỗi máy chủ trong quá trình đăng nhập.',
    });
  }
});

/**
 * =========================================================================
 * NV-02: ĐĂNG NHẬP EMAIL/MẬT KHẨU (Nhân viên nội bộ) - FR-003
 * Actor: MANAGER, ACCOUNTANT, STAFF, SYS_ADMIN, OWNER
 * =========================================================================
 */
router.post('/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({
      code: 'VALIDATION_ERROR',
      message: 'Email và mật khẩu là bắt buộc.',
    });
  }

  if (password.length < 8) {
    return res.status(400).json({
      code: 'VALIDATION_ERROR',
      message: 'Mật khẩu phải chứa ít nhất 8 ký tự.',
    });
  }

  try {
    // Tìm person theo email
    const personRes = await pool.query(
      `SELECT p.*, au.id as user_id, au.status as user_status, au.password_hash
       FROM person p
       JOIN app_user au ON au.person_id = p.id
       WHERE LOWER(p.email) = LOWER($1)`,
      [email.trim()]
    );

    if (personRes.rows.length === 0) {
      return res.status(401).json({
        code: 'INVALID_CREDENTIALS',
        message: 'Email hoặc mật khẩu không chính xác.',
      });
    }

    const userData = personRes.rows[0];

    // Kiểm tra trạng thái tài khoản (ACTIVE vs SUSPENDED)
    if (userData.user_status === 'SUSPENDED') {
      return res.status(403).json({
        code: 'ACCOUNT_SUSPENDED',
        message: 'Tài khoản của bạn đã bị tạm khóa. Vui lòng liên hệ quản trị viên.',
      });
    }

    // Kiểm tra mật khẩu (hỗ trợ hash bcrypt hoặc mật khẩu demo mặc định trong dev)
    let isPasswordMatch = false;
    if (userData.password_hash) {
      isPasswordMatch = await bcrypt.compare(password, userData.password_hash);
    }
    
    // Fallback cho tài khoản demo seed trong môi trường dev nếu password_hash chưa gán
    if (!isPasswordMatch && process.env.NODE_ENV !== 'production' && password === 'password123') {
      isPasswordMatch = true;
    }

    if (!isPasswordMatch) {
      return res.status(401).json({
        code: 'INVALID_CREDENTIALS',
        message: 'Email hoặc mật khẩu không chính xác.',
      });
    }

    // Cập nhật last_login_at
    await pool.query('UPDATE app_user SET last_login_at = NOW() WHERE id = $1', [userData.user_id]);

    // Lấy danh sách roles của user
    const rolesRes = await pool.query(`
      SELECT r.code, r.name, r.scope, ur.building_id
      FROM user_role ur
      JOIN role r ON r.id = ur.role_id
      WHERE ur.user_id = $1
    `, [userData.user_id]);

    const roles = rolesRes.rows;

    const payload = {
      sub: userData.user_id,
      person_id: userData.id,
      org_id: userData.org_id,
      phone: userData.phone,
      email: userData.email,
      full_name: userData.full_name,
      roles: roles.map((r) => ({ code: r.code, name: r.name, building_id: r.building_id })),
    };

    const tokens = generateTokens(payload);

    res.json({
      message: 'Đăng nhập thành công.',
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      user: payload,
    });
  } catch (err) {
    console.error('[Login Error]:', err);
    res.status(500).json({
      code: 'SERVER_ERROR',
      message: 'Lỗi máy chủ khi xử lý đăng nhập email/mật khẩu.',
    });
  }
});

/**
 * =========================================================================
 * POST /api/v1/auth/refresh (Làm mới Token)
 * =========================================================================
 */
router.post('/refresh', async (req, res) => {
  const { refreshToken } = req.body;
  if (!refreshToken) {
    return res.status(401).json({ code: 'MISSING_TOKEN', message: 'Thiếu Refresh Token.' });
  }

  try {
    const decoded = jwt.verify(refreshToken, JWT_REFRESH_SECRET);

    // 1. Kiểm tra trạng thái app_user trong CSDL
    const userRes = await pool.query(
      `SELECT au.status, au.person_id, p.org_id, p.phone, p.email, p.full_name
       FROM app_user au
       LEFT JOIN person p ON p.id = au.person_id
       WHERE au.id = $1`,
      [decoded.sub]
    );

    if (userRes.rows.length === 0 || userRes.rows[0].status !== 'ACTIVE') {
      return res.status(403).json({
        code: 'ACCOUNT_SUSPENDED',
        message: 'Tài khoản của bạn đã bị tạm khóa hoặc không tồn tại.',
      });
    }

    // 2. Reload roles mới nhất từ CSDL
    const rolesRes = await pool.query(
      `SELECT r.code 
       FROM user_role ur 
       JOIN role r ON r.id = ur.role_id 
       WHERE ur.user_id = $1`,
      [decoded.sub]
    );
    const freshRoles = rolesRes.rows.map((r) => r.code);

    const userRow = userRes.rows[0];
    const newPayload = {
      sub: decoded.sub,
      person_id: userRow.person_id || decoded.person_id,
      org_id: userRow.org_id || decoded.org_id,
      phone: userRow.phone || decoded.phone,
      email: userRow.email || decoded.email,
      full_name: userRow.full_name || decoded.full_name,
      roles: freshRoles,
    };

    const accessToken = jwt.sign(newPayload, JWT_SECRET, { expiresIn: '15m' });
    res.json({ accessToken });
  } catch (err) {
    if (err.name === 'TokenExpiredError' || err.name === 'JsonWebTokenError') {
      return res.status(403).json({
        code: 'INVALID_REFRESH_TOKEN',
        message: 'Refresh token không hợp lệ hoặc đã hết hạn.',
      });
    }
    console.error('[Refresh Token Error]:', err);
    res.status(500).json({ code: 'SERVER_ERROR', message: 'Lỗi máy chủ khi làm mới token.' });
  }
});

/**
 * GET /api/v1/auth/me (Lấy thông tin profile người dùng hiện tại)
 */
router.get('/me', authenticateToken, async (req, res) => {
  res.json({ user: req.user });
});

/**
 * POST /api/v1/auth/logout
 */
router.post('/logout', (req, res) => {
  res.json({ message: 'Đăng xuất thành công.' });
});

export default router;
