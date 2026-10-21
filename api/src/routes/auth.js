import 'dotenv/config';
import express from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { adminPool as pool } from '../db/client.js';
import { otpRequestLimiter, generalLimiter } from '../middleware/rateLimiter.js';
import { authenticateToken } from '../middleware/auth.js';
import { JWT_SECRET, JWT_REFRESH_SECRET } from '../config/env.js';

const router = express.Router();

// Helper normalize phone: Chuyển mọi dạng (+84, 84, có dấu cách, gạch nối) thành chuẩn 10 chữ số VN
function normalizePhone(phone) {
  let clean = (phone || '').toString().trim().replace(/[\s\-\.\(\)]/g, '');
  if (clean.startsWith('+84')) {
    clean = '0' + clean.slice(3);
  } else if (clean.startsWith('84') && clean.length === 11) {
    clean = '0' + clean.slice(2);
  }
  return clean;
}

// In-memory OTP storage: { phone: { otp, expiresAt, attempts, lockedUntil } }
const otpStore = new Map();

// In-memory phone rate limit tracker: { phone: [timestamps] }
const phoneRequestTracker = new Map();

// In-memory email failed login tracker: { email: { attempts: number, lockedUntil: number } }
export const emailLoginTracker = new Map();

// In-memory reset password token store: { email: { code: string, expiresAt: number } }
const resetTokenStore = new Map();

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
 * Bất kỳ số điện thoại 10 chữ số hợp lệ đều được gửi mock OTP và tạo tài khoản Cư dân (RESIDENT)
 */
router.post('/otp/request', otpRequestLimiter, async (req, res) => {
  const { phone } = req.body;

  // Validation: Kiểm tra đúng 10 chữ số VN (bắt đầu bằng 0, tổng cộng 10 số)
  const cleanPhone = normalizePhone(phone);
  if (!cleanPhone || !/^0[0-9]{9}$/.test(cleanPhone)) {
    return res.status(400).json({
      code: 'INVALID_PHONE',
      message: 'Số điện thoại không hợp lệ. Vui lòng nhập đúng số điện thoại 10 chữ số (bắt đầu bằng 0, ví dụ: 0977930202).',
    });
  }

  // Kiểm tra số lần request trên SĐT trong 1 giờ qua (Rate-limit: 3 lần/giờ/SĐT theo AC-001)
  const now = Date.now();
  const oneHourAgo = now - 60 * 60 * 1000;
  const history = phoneRequestTracker.get(cleanPhone) || [];
  const recentHistory = history.filter((ts) => ts > oneHourAgo);
  const maxReqPerHour = 3; // Giới hạn nghiêm ngặt 3 lần / giờ / SĐT

  if (recentHistory.length >= maxReqPerHour) {
    return res.status(429).json({
      code: 'RATE_LIMIT_EXCEEDED',
      message: 'Bạn đã yêu cầu gửi OTP quá 3 lần trong 1 giờ. Vui lòng đợi thêm hoặc liên hệ quản trị viên.',
    });
  }

  recentHistory.push(now);
  phoneRequestTracker.set(cleanPhone, recentHistory);

  // Kiểm tra xem SĐT có đang bị lock do nhập sai quá 5 lần không (AC-001.2: Khóa 15 phút)
  const existingRecord = otpStore.get(cleanPhone);
  if (existingRecord && existingRecord.lockedUntil && existingRecord.lockedUntil > now) {
    const minutesLeft = Math.ceil((existingRecord.lockedUntil - now) / 60000);
    return res.status(429).json({
      code: 'ACCOUNT_LOCKED',
      message: `Số điện thoại này đang bị tạm khóa do nhập sai quá 5 lần. Vui lòng thử lại sau ${minutesLeft} phút.`,
    });
  }

  // Đảm bảo số điện thoại có tài khoản cư dân (RESIDENT) trong hệ thống
  let acct = await pool.query(
    `SELECT p.id as person_id, p.full_name, au.id as user_id, au.status 
     FROM person p 
     LEFT JOIN app_user au ON au.person_id = p.id 
     WHERE p.phone = $1`,
    [cleanPhone]
  );

  let targetUserId = null;

  if (acct.rows.length === 0) {
    // 1. Tự động tạo hồ sơ cư dân mới
    const orgRes = await pool.query('SELECT id FROM organization LIMIT 1');
    const orgId = orgRes.rows[0]?.id;

    const pRes = await pool.query(
      `INSERT INTO person (org_id, full_name, phone)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [orgId, `Cư dân ${cleanPhone}`, cleanPhone]
    );
    const newPersonId = pRes.rows[0].id;

    const uRes = await pool.query(
      `INSERT INTO app_user (person_id, auth_uid, status)
       VALUES ($1, $2, 'ACTIVE')
       RETURNING id`,
      [newPersonId, `user_${cleanPhone}`]
    );
    targetUserId = uRes.rows[0].id;
  } else if (!acct.rows[0].user_id) {
    // 2. Đã có person nhưng chưa có app_user
    const personId = acct.rows[0].person_id;
    const uRes = await pool.query(
      `INSERT INTO app_user (person_id, auth_uid, status)
       VALUES ($1, $2, 'ACTIVE')
       RETURNING id`,
      [personId, `user_${cleanPhone}`]
    );
    targetUserId = uRes.rows[0].id;
  } else {
    // 3. Đã có app_user -> Đảm bảo ACTIVE
    targetUserId = acct.rows[0].user_id;
    if (acct.rows[0].status !== 'ACTIVE') {
      await pool.query("UPDATE app_user SET status = 'ACTIVE' WHERE id = $1", [targetUserId]);
    }
  }

  // Đảm bảo tài khoản luôn có role RESIDENT (Cư dân)
  if (targetUserId) {
    const roleCheck = await pool.query(
      `SELECT 1 FROM user_role ur 
       JOIN role r ON r.id = ur.role_id 
       WHERE ur.user_id = $1 AND r.code = 'RESIDENT'`,
      [targetUserId]
    );
    if (roleCheck.rows.length === 0) {
      const roleRes = await pool.query("SELECT id FROM role WHERE code = 'RESIDENT' LIMIT 1");
      if (roleRes.rows.length > 0) {
        await pool.query(
          `INSERT INTO user_role (user_id, role_id, building_id)
           VALUES ($1, $2, NULL)`,
          [targetUserId, roleRes.rows[0].id]
        );
      }
    }
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

  res.json({
    message: 'OTP đã được gửi thành công.',
    devOtp: otp,
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

  const cleanPhone = normalizePhone(phone);
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
      token_version: appUser.token_version || 1,
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
 * Rate limit: 15 req/phút/IP + Khóa 15 phút sau 5 lần nhập sai
 * =========================================================================
 */
router.post('/login', generalLimiter, async (req, res) => {
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

  const cleanEmail = email.trim().toLowerCase();
  const now = Date.now();

  // Kiểm tra tài khoản có đang bị khóa 15 phút do nhập sai 5 lần không
  const loginRecord = emailLoginTracker.get(cleanEmail);
  if (loginRecord && loginRecord.lockedUntil && loginRecord.lockedUntil > now) {
    const minutesLeft = Math.ceil((loginRecord.lockedUntil - now) / 60000);
    return res.status(429).json({
      code: 'ACCOUNT_LOCKED',
      message: `Tài khoản này đang bị tạm khóa do nhập sai mật khẩu quá 5 lần. Vui lòng thử lại sau ${minutesLeft} phút.`,
    });
  }

  try {
    // Tìm person theo email
    const personRes = await pool.query(
      `SELECT p.*, au.id as user_id, au.status as user_status, au.password_hash, au.token_version
       FROM person p
       JOIN app_user au ON au.person_id = p.id
       WHERE LOWER(p.email) = $1`,
      [cleanEmail]
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
      const attempts = (loginRecord?.attempts || 0) + 1;
      if (attempts >= 5) {
        const lockedUntil = now + 15 * 60 * 1000;
        emailLoginTracker.set(cleanEmail, { attempts, lockedUntil });
        try {
          await pool.query(
            `INSERT INTO audit_log (actor_id, action, entity, entity_id, after)
             VALUES ($1, 'AUTH_LOCK', 'app_user', $2, $3)`,
            [userData.user_id, userData.user_id, JSON.stringify({ email: cleanEmail, reason: 'Too many failed password attempts' })]
          );
        } catch (auditErr) {
          console.error('[Audit Lock Error]:', auditErr);
        }
        return res.status(429).json({
          code: 'ACCOUNT_LOCKED',
          message: 'Bạn đã nhập sai mật khẩu quá 5 lần. Tài khoản bị tạm khóa 15 phút.',
        });
      }
      emailLoginTracker.set(cleanEmail, { attempts, lockedUntil: null });
      return res.status(401).json({
        code: 'INVALID_CREDENTIALS',
        message: `Email hoặc mật khẩu không chính xác. Bạn còn ${5 - attempts} lần thử.`,
      });
    }

    // Đăng nhập thành công -> Xóa bộ đếm sai
    emailLoginTracker.delete(cleanEmail);

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
      token_version: userData.token_version || 1,
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
 * POST /api/v1/auth/refresh (Làm mới Token có kiểm tra Token Version / Revoke)
 * =========================================================================
 */
router.post('/refresh', async (req, res) => {
  const { refreshToken } = req.body;
  if (!refreshToken) {
    return res.status(401).json({ code: 'MISSING_TOKEN', message: 'Thiếu Refresh Token.' });
  }

  try {
    const decoded = jwt.verify(refreshToken, JWT_REFRESH_SECRET);

    // 1. Kiểm tra trạng thái app_user trong CSDL và token_version
    const userRes = await pool.query(
      `SELECT au.status, au.person_id, au.token_version, p.org_id, p.phone, p.email, p.full_name
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

    const userRow = userRes.rows[0];

    // Kiểm tra xem refresh token có bị thu hồi (sau khi logout hoặc đổi mật khẩu) không
    if (decoded.token_version && userRow.token_version && decoded.token_version !== userRow.token_version) {
      return res.status(403).json({
        code: 'TOKEN_REVOKED',
        message: 'Phiên đăng nhập đã bị thu hồi hoặc đã đăng xuất. Vui lòng đăng nhập lại.',
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

    const newPayload = {
      sub: decoded.sub,
      person_id: userRow.person_id || decoded.person_id,
      org_id: userRow.org_id || decoded.org_id,
      phone: userRow.phone || decoded.phone,
      email: userRow.email || decoded.email,
      full_name: userRow.full_name || decoded.full_name,
      roles: freshRoles,
      token_version: userRow.token_version || 1,
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
 * POST /api/v1/auth/logout (Thu hồi Token khi đăng xuất)
 */
router.post('/logout', authenticateToken, async (req, res) => {
  try {
    await pool.query('UPDATE app_user SET token_version = COALESCE(token_version, 1) + 1 WHERE id = $1', [req.user.sub]);
    res.json({ message: 'Đăng xuất thành công, refresh token đã được thu hồi an toàn.' });
  } catch (err) {
    console.error('[Logout Error]:', err);
    res.status(500).json({ code: 'SERVER_ERROR', message: 'Lỗi khi xử lý đăng xuất.' });
  }
});

/**
 * =========================================================================
 * PROFILE & ĐỔI MẬT KHẨU (Task 9)
 * =========================================================================
 */
router.get('/profile', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT p.id as person_id, p.full_name, p.phone, p.email, p.dob, p.id_number, au.id as user_id, au.status
       FROM app_user au
       JOIN person p ON p.id = au.person_id
       WHERE au.id = $1`,
      [req.user.sub]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy hồ sơ người dùng.' });
    }
    res.json({ data: result.rows[0] });
  } catch (err) {
    console.error('[Get Profile Error]:', err);
    res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi tải hồ sơ cá nhân.' });
  }
});

router.patch('/profile', authenticateToken, async (req, res) => {
  const { full_name, email, dob } = req.body;
  try {
    const userRes = await pool.query('SELECT person_id FROM app_user WHERE id = $1', [req.user.sub]);
    const personId = userRes.rows[0]?.person_id;
    if (!personId) {
      return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy hồ sơ liên kết.' });
    }

    const updated = await pool.query(
      `UPDATE person
       SET full_name = COALESCE($1, full_name),
           email = COALESCE($2, email),
           dob = COALESCE($3, dob),
           updated_at = NOW()
       WHERE id = $4
       RETURNING id, full_name, phone, email, dob, id_number`,
      [full_name, email, dob, personId]
    );
    res.json({ message: 'Cập nhật thông tin hồ sơ thành công.', data: updated.rows[0] });
  } catch (err) {
    console.error('[Update Profile Error]:', err);
    res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi máy chủ khi cập nhật hồ sơ.' });
  }
});

router.post('/change-password', authenticateToken, async (req, res) => {
  const { old_password, new_password } = req.body;
  if (!old_password || !new_password) {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Vui lòng cung cấp mật khẩu cũ và mật khẩu mới.' });
  }
  if (new_password.length < 8) {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Mật khẩu mới phải có tối thiểu 8 ký tự.' });
  }

  try {
    const userRes = await pool.query('SELECT password_hash FROM app_user WHERE id = $1', [req.user.sub]);
    if (userRes.rows.length === 0) {
      return res.status(404).json({ code: 'NOT_FOUND', message: 'Tài khoản không tồn tại.' });
    }

    const user = userRes.rows[0];
    let match = false;
    if (user.password_hash) {
      match = await bcrypt.compare(old_password, user.password_hash);
    } else if (process.env.NODE_ENV !== 'production' && old_password === 'password123') {
      match = true;
    }

    if (!match) {
      return res.status(400).json({ code: 'INVALID_PASSWORD', message: 'Mật khẩu hiện tại không chính xác.' });
    }

    const newHash = await bcrypt.hash(new_password, 10);
    // Đổi mật khẩu thành công -> Tăng token_version để thu hồi các phiên đăng nhập khác
    await pool.query('UPDATE app_user SET password_hash = $1, token_version = COALESCE(token_version, 1) + 1 WHERE id = $2', [newHash, req.user.sub]);

    res.json({ message: 'Đổi mật khẩu thành công. Các phiên đăng nhập khác đã được thu hồi an toàn.' });
  } catch (err) {
    console.error('[Change Password Error]:', err);
    res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi máy chủ khi đổi mật khẩu.' });
  }
});

/**
 * =========================================================================
 * QUÊN MẬT KHẨU / ĐẶT LẠI MẬT KHẨU (Task 10)
 * =========================================================================
 */
router.post('/forgot-password', generalLimiter, async (req, res) => {
  const { email } = req.body;
  if (!email) {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Vui lòng cung cấp email.' });
  }
  const cleanEmail = email.trim().toLowerCase();

  try {
    const userRes = await pool.query(
      `SELECT au.id FROM person p JOIN app_user au ON au.person_id = p.id WHERE LOWER(p.email) = $1`,
      [cleanEmail]
    );

    const resetCode = Math.floor(100000 + Math.random() * 900000).toString();
    if (userRes.rows.length > 0) {
      resetTokenStore.set(cleanEmail, { code: resetCode, expiresAt: Date.now() + 15 * 60 * 1000 });
      console.log(`\n=============================================`);
      console.log(`[RESET PASSWORD MOCK] Mã đặt lại mật khẩu cho ${cleanEmail}: 👉 ${resetCode} 👈`);
      console.log(`=============================================\n`);
    }

    // Thông báo trung lập bảo vệ danh tính (anti-enumeration)
    res.json({
      message: 'Nếu email tồn tại trong hệ thống, mã xác nhận đã được gửi thành công.',
      devResetCode: process.env.NODE_ENV !== 'production' && userRes.rows.length > 0 ? resetCode : undefined,
    });
  } catch (err) {
    console.error('[Forgot Password Error]:', err);
    res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi khi gửi yêu cầu quên mật khẩu.' });
  }
});

router.post('/reset-password', generalLimiter, async (req, res) => {
  const { email, code, new_password } = req.body;
  if (!email || !code || !new_password) {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Vui lòng cung cấp email, mã xác nhận và mật khẩu mới.' });
  }
  if (new_password.length < 8) {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Mật khẩu mới phải có tối thiểu 8 ký tự.' });
  }

  const cleanEmail = email.trim().toLowerCase();
  const record = resetTokenStore.get(cleanEmail);

  if (!record || record.code !== code.trim() || Date.now() > record.expiresAt) {
    return res.status(400).json({ code: 'INVALID_RESET_CODE', message: 'Mã xác nhận không đúng hoặc đã hết hạn.' });
  }

  try {
    const userRes = await pool.query(
      `SELECT au.id FROM person p JOIN app_user au ON au.person_id = p.id WHERE LOWER(p.email) = $1`,
      [cleanEmail]
    );
    if (userRes.rows.length === 0) {
      return res.status(404).json({ code: 'NOT_FOUND', message: 'Tài khoản không tồn tại.' });
    }

    const newHash = await bcrypt.hash(new_password, 10);
    await pool.query(
      'UPDATE app_user SET password_hash = $1, token_version = COALESCE(token_version, 1) + 1 WHERE id = $2',
      [newHash, userRes.rows[0].id]
    );
    resetTokenStore.delete(cleanEmail);

    res.json({ message: 'Đặt lại mật khẩu thành công. Vui lòng đăng nhập với mật khẩu mới.' });
  } catch (err) {
    console.error('[Reset Password Error]:', err);
    res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi khi cập nhật mật khẩu mới.' });
  }
});

export default router;
