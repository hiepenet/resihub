import jwt from 'jsonwebtoken';
import { JWT_SECRET } from '../config/env.js';

export function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({
      code: 'UNAUTHORIZED',
      message: 'Vui lòng đăng nhập để tiếp tục.',
    });
  }

  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err) {
      if (err.name === 'TokenExpiredError') {
        return res.status(401).json({
          code: 'TOKEN_EXPIRED',
          message: 'Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.',
        });
      }
      return res.status(403).json({
        code: 'INVALID_TOKEN',
        message: 'Token không hợp lệ.',
      });
    }

    req.user = decoded;
    next();
  });
}
