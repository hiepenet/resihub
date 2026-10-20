import pg from 'pg';
import dotenv from 'dotenv';
import { AsyncLocalStorage } from 'async_hooks';

dotenv.config();

const { Pool } = pg;

// 1. ADMIN POOL (Superuser - Dành cho migrations, seed, auth lookups)
const adminConnectionConfig = process.env.DATABASE_URL
  ? { connectionString: process.env.DATABASE_URL }
  : {
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT || '5433', 10),
      database: process.env.POSTGRES_DB || 'resihub',
      user: process.env.POSTGRES_USER || 'postgres',
      password: process.env.POSTGRES_PASSWORD || 'postgres',
    };

export const adminPool = new Pool(adminConnectionConfig);
adminPool.on('error', (err) => {
  console.error('[Admin Database Pool Error]: Unexpected error on idle client', err);
});

// 2. APP POOL (resihub_app - RLS-bound role)
let appConnectionConfig;
if (process.env.APP_DATABASE_URL) {
  appConnectionConfig = { connectionString: process.env.APP_DATABASE_URL };
} else {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('FATAL: APP_DATABASE_URL must be defined in production environment.');
  }
  console.warn('[Database Pool Warning]: APP_DATABASE_URL not set, falling back to adminPool connection config.');
  appConnectionConfig = adminConnectionConfig;
}

export const appPool = new Pool(appConnectionConfig);
appPool.on('error', (err) => {
  console.error('[App Database Pool Error]: Unexpected error on idle client', err);
});

// 3. ASYNC LOCAL STORAGE (Scope cho từng HTTP request)
export const userScope = new AsyncLocalStorage();

// 4. PROXY POOL (Tự động định tuyến query vào request client nếu đang trong userScope)
export const pool = new Proxy(appPool, {
  get(target, prop, receiver) {
    if (prop === 'query') {
      return (text, params) => {
        const store = userScope.getStore();
        if (store?.client) {
          return store.client.query(text, params);
        }
        return target.query(text, params);
      };
    }
    return Reflect.get(target, prop, receiver);
  },
});

// 5. HELPER LẤY CLIENT CÓ CONTEXT (Dùng cho 11 vị trí transaction thủ công)
// Ruling #1: Reuse req.dbClient nếu middleware đã cấp (release là no-op; middleware finish/close lo RESET + release)
export async function getUserClient(req) {
  if (req?.dbClient) {
    return {
      client: req.dbClient,
      release: async () => {}, // no-op do middleware quản lý lifecycle
    };
  }

  // Fallback: khi gọi ngoài middleware (cron, background, testing)
  const client = await appPool.connect();
  const userId = req?.user?.sub || req?.user?.id;
  if (userId) {
    await client.query(`SELECT set_config('app.current_user_id', $1, false)`, [userId]);
  }

  const release = async () => {
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

  return { client, release };
}

export const query = (text, params) => pool.query(text, params);

export default {
  pool,
  adminPool,
  appPool,
  userScope,
  getUserClient,
  query,
};
