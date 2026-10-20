// config/env.js — JWT secrets bắt buộc (fail fast khi thiếu — audit D5)
import 'dotenv/config';

const JWT_SECRET = process.env.JWT_SECRET;
const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET;

if (!JWT_SECRET || !JWT_REFRESH_SECRET) {
  throw new Error(
    'JWT_SECRET / JWT_REFRESH_SECRET bắt buộc. Kiểm tra .env (xem .env_example) hoặc biến môi trường khi triển khai.'
  );
}

export { JWT_SECRET, JWT_REFRESH_SECRET };
