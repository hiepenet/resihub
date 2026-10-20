import 'dotenv/config';
import jwt from 'jsonwebtoken';
import { JWT_SECRET } from '../config/env.js';
import { appPool, userScope } from '../db/client.js';

export function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({
      code: 'UNAUTHORIZED',
      message: 'Vui lòng đăng nhập để tiếp tục.',
    });
  }

  jwt.verify(token, JWT_SECRET, async (err, decoded) => {
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

    let client;
    try {
      client = await appPool.connect();
      await client.query(`SELECT set_config('app.current_user_id', $1, false)`, [req.user.sub]);
      req.dbClient = client;

      let released = false;
      const cleanup = async () => {
        if (released) return;
        released = true;
        try {
          await client.query('ROLLBACK');
        } catch {}
        try {
          await client.query('RESET app.current_user_id');
        } catch {}
        try {
          client.release();
        } catch {}
      };

      res.once('finish', cleanup);
      res.once('close', cleanup);

      userScope.run({ client }, () => next());
    } catch (dbErr) {
      console.error('[Auth Middleware DB Error]:', dbErr);
      if (client) {
        try {
          client.release();
        } catch {}
      }
      return res.status(500).json({
        code: 'DB_CONNECTION_ERROR',
        message: 'Không thể kết nối cơ sở dữ liệu.',
      });
    }
  });
}
