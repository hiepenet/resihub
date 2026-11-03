import rateLimit from 'express-rate-limit';

// Hàm kiểm tra bỏ chặn IP (localhost, dev, nội bộ docker)
export const isLocalOrDev = (req) => {
  if (process.env.NODE_ENV !== 'production') {
    return true;
  }
  const rawIp = req.ip || req.connection?.remoteAddress || req.headers?.['x-forwarded-for'] || '';
  const ip = String(rawIp).replace(/^::ffff:/, '').trim();
  return (
    ip === '127.0.0.1' ||
    ip === '::1' ||
    ip.includes('localhost') ||
    ip.startsWith('172.') ||
    ip.startsWith('192.168.') ||
    ip.startsWith('10.')
  );
};

export const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5000, // Tăng giới hạn cho phép test thoải mái
  skip: isLocalOrDev,
  message: {
    code: 'TOO_MANY_REQUESTS',
    message: 'Quá nhiều yêu cầu từ địa chỉ IP này. Vui lòng thử lại sau ít phút.',
  },
  standardHeaders: true,
  legacyHeaders: false,
});

export const otpRequestLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  skip: isLocalOrDev,
  message: {
    code: 'RATE_LIMIT_EXCEEDED',
    message: 'Bạn đã yêu cầu gửi OTP quá nhanh. Vui lòng thử lại sau 1 phút.',
  },
  standardHeaders: true,
  legacyHeaders: false,
});

export const aiRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  keyGenerator: (req) => String(req.user?.sub || 'anonymous'),
  skip: (req) =>
    req.headers?.['x-test-ai-rate-limit'] !== '1' &&
    req.headers?.['x-test-rate-limit'] !== '1' &&
    isLocalOrDev(req),
  message: {
    code: 'AI_RATE_LIMIT_EXCEEDED',
    message: 'Bạn đang gửi yêu cầu AI quá nhanh (tối đa 20 lần/phút). Vui lòng thử lại sau ít giây hoặc nhập thủ công.',
  },
  standardHeaders: true,
  legacyHeaders: false,
});
