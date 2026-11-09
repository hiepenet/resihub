// config/env.js — JWT secrets bắt buộc (fail fast khi thiếu — audit D5) + cấu hình Gemini server-only (M15) + Production runtime flags
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';

dotenv.config();
dotenv.config({ path: fileURLToPath(new URL('../../.env', import.meta.url)) });

const JWT_SECRET = process.env.JWT_SECRET;
const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET;

if (!JWT_SECRET || !JWT_REFRESH_SECRET) {
  throw new Error(
    'JWT_SECRET / JWT_REFRESH_SECRET bắt buộc. Kiểm tra .env (xem .env_example) hoặc biến môi trường khi triển khai.'
  );
}

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_BASE_URL =
  process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta';
const GEMINI_TIMEOUT_MS = Math.max(
  1000,
  Number(process.env.GEMINI_TIMEOUT_MS || 45000) || 45000
);

export function isOtpDemoEnabled(envObj = process.env) {
  return envObj.NODE_ENV !== 'production' || envObj.OTP_DEMO_MODE === 'true';
}

export function isDemoAccountsEnabled(envObj = process.env) {
  return envObj.NODE_ENV !== 'production' || envObj.SHOW_DEMO_ACCOUNTS === 'true';
}

export function resolveCorsOriginOption(envObj = process.env) {
  if (envObj.NODE_ENV !== 'production') {
    return '*';
  }
  const origins = String(envObj.CORS_ORIGIN || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return origins.length > 0 ? origins : false;
}

export const env = {
  jwtSecret: JWT_SECRET,
  jwtRefreshSecret: JWT_REFRESH_SECRET,
  geminiApiKey: GEMINI_API_KEY,
  geminiBaseUrl: GEMINI_BASE_URL,
  geminiTimeoutMs: GEMINI_TIMEOUT_MS,
};

export {
  JWT_SECRET,
  JWT_REFRESH_SECRET,
  GEMINI_API_KEY,
  GEMINI_BASE_URL,
  GEMINI_TIMEOUT_MS,
};
