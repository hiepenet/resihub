import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const { Pool } = pg;

const connectionConfig = process.env.DATABASE_URL
  ? { connectionString: process.env.DATABASE_URL }
  : {
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT || '5433', 10),
      database: process.env.POSTGRES_DB || 'resihub',
      user: process.env.POSTGRES_USER || 'postgres',
      password: process.env.POSTGRES_PASSWORD || 'postgres',
    };

export const pool = new Pool(connectionConfig);

pool.on('error', (err) => {
  console.error('[Database Pool Error]: Unexpected error on idle client', err);
});

export const query = (text, params) => pool.query(text, params);

export default {
  pool,
  query,
};
