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
