import express from 'express';
import jwt from 'jsonwebtoken';
import { pool } from '../db/client.js';
import { otpRequestLimiter } from '../middleware/rateLimiter.js';
import { authenticateToken } from '../middleware/auth.js';

const router = express.Router();

// In-memory OTP storage for dev: { phone: { otp, expiresAt, attempts } }
const otpStore = new Map();

const JWT_SECRET = process.env.JWT_SECRET || 'resihub_dev_jwt_secret_key_very_secure_12345';
const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'resihub_dev_jwt_refresh_secret_key_very_secure_67890';

// Helper to sign JWT
function generateTokens(payload) {
  const accessToken = jwt.sign(payload, JWT_SECRET, { expiresIn: '15m' });
  const refreshToken = jwt.sign(payload, JWT_REFRESH_SECRET, { expiresIn: '7d' });
  return { accessToken, refreshToken };
}

/**
 * POST /api/v1/auth/otp/request
 * Gửi OTP qua SMS (Dev: log console & trả về trong response tiện dev)
 */
router.post('/otp/request', otpRequestLimiter, async (req, res) => {
  const { phone } = req.body;
  if (!phone || !/^(0|\+84)[0-9]{9,10}$/.test(phone)) {
    return res.status(400).json({
      code: 'INVALID_PHONE',
      message: 'Số điện thoại không hợp lệ. Vui lòng nhập định dạng 10 số (ví dụ: 0901234567).',
    });
  }

  // Generate 6 digit OTP
  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  const expiresAt = Date.now() + 5 * 60 * 1000; // 5 mins

  otpStore.set(phone, {
    otp,
    expiresAt,
    attempts: 0,
  });

  console.log(`\n=============================================`);
  console.log(`[SMS MOCK] Mã OTP cho số ${phone}: 👉 ${otp} 👈`);
  console.log(`=============================================\n`);

  res.json({
    message: 'OTP đã được gửi thành công.',
    devOtp: process.env.NODE_ENV !== 'production' ? otp : undefined,
  });
});

/**
 * POST /api/v1/auth/otp/verify
 * Xác thực mã OTP và sinh Access Token + Refresh Token
 */
router.post('/otp/verify', async (req, res) => {
  const { phone, otp } = req.body;

  if (!phone || !otp) {
    return res.status(400).json({
      code: 'MISSING_DATA',
      message: 'Vui lòng cung cấp số điện thoại và mã OTP.',
    });
  }

  const record = otpStore.get(phone);

  // Mặc định hỗ trợ OTP test 123456 trong môi trường dev
  const isDevMasterOtp = process.env.NODE_ENV !== 'production' && otp === '123456';

  if (!record && !isDevMasterOtp) {
    return res.status(400).json({
      code: 'OTP_NOT_FOUND',
      message: 'Mã OTP không tồn tại hoặc đã hết hạn. Vui lòng gửi lại yêu cầu.',
    });
  }

  if (record && !isDevMasterOtp) {
    if (Date.now() > record.expiresAt) {
      otpStore.delete(phone);
      return res.status(400).json({
        code: 'OTP_EXPIRED',
        message: 'Mã OTP đã hết hiệu lực (quá 5 phút). Vui lòng gửi lại mã mới.',
      });
    }

    if (record.attempts >= 5) {
      otpStore.delete(phone);
      return res.status(429).json({
        code: 'TOO_MANY_ATTEMPTS',
        message: 'Bạn đã nhập sai quá 5 lần. Vui lòng đợi 15 phút và gửi lại mã mới.',
      });
    }

    if (record.otp !== otp) {
      record.attempts += 1;
      return res.status(400).json({
        code: 'OTP_INVALID',
        message: `Mã OTP không chính xác. Bạn còn ${5 - record.attempts} lần thử.`,
      });
    }

    // Correct OTP -> remove from store
    otpStore.delete(phone);
  }

  try {
    // Tìm hoặc tạo người dùng trong database
    let personRes = await pool.query('SELECT * FROM person WHERE phone = $1', [phone]);
    let person;
    let orgId;

    if (personRes.rows.length === 0) {
      // Lấy org mặc định
      const orgRes = await pool.query('SELECT id FROM organization LIMIT 1');
      if (orgRes.rows.length === 0) {
        return res.status(500).json({ code: 'DB_ERROR', message: 'Hệ thống chưa khởi tạo tổ chức.' });
      }
      orgId = orgRes.rows[0].id;

      // Tạo person mới
      const newPerson = await pool.query(
        `INSERT INTO person (org_id, full_name, phone)
         VALUES ($1, $2, $3)
         RETURNING *`,
        [orgId, `Người dùng ${phone.slice(-4)}`, phone]
      );
      person = newPerson.rows[0];
    } else {
      person = personRes.rows[0];
      orgId = person.org_id;
    }

    // Tìm hoặc tạo app_user
    let userRes = await pool.query('SELECT * FROM app_user WHERE person_id = $1', [person.id]);
    let appUser;
    if (userRes.rows.length === 0) {
      const newUser = await pool.query(
        `INSERT INTO app_user (person_id, auth_uid, status)
         VALUES ($1, $2, 'ACTIVE')
         RETURNING *`,
        [person.id, `user_${person.id}`]
      );
      appUser = newUser.rows[0];

      // Gán role mặc định RESIDENT nếu chưa có
      const defaultRoleRes = await pool.query("SELECT id FROM role WHERE code = 'RESIDENT' AND org_id = $1", [orgId]);
      if (defaultRoleRes.rows.length > 0) {
        await pool.query(
          `INSERT INTO user_role (user_id, role_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [appUser.id, defaultRoleRes.rows[0].id]
        );
      }
    } else {
      appUser = userRes.rows[0];
      // Cập nhật last_login_at
      await pool.query('UPDATE app_user SET last_login_at = NOW() WHERE id = $1', [appUser.id]);
    }

    // Lấy roles của user
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
 * POST /api/v1/auth/refresh
 * Làm mới Access Token
 */
router.post('/refresh', (req, res) => {
  const { refreshToken } = req.body;
  if (!refreshToken) {
    return res.status(401).json({ code: 'MISSING_TOKEN', message: 'Thiếu Refresh Token.' });
  }

  jwt.verify(refreshToken, JWT_REFRESH_SECRET, (err, decoded) => {
    if (err) {
      return res.status(403).json({ code: 'INVALID_REFRESH_TOKEN', message: 'Refresh token không hợp lệ hoặc đã hết hạn.' });
    }

    const newPayload = {
      sub: decoded.sub,
      person_id: decoded.person_id,
      org_id: decoded.org_id,
      phone: decoded.phone,
      full_name: decoded.full_name,
      roles: decoded.roles,
    };

    const accessToken = jwt.sign(newPayload, JWT_SECRET, { expiresIn: '15m' });
    res.json({ accessToken });
  });
});

/**
 * GET /api/v1/auth/me
 * Lấy thông tin user hiện tại
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
