import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { pool } from './client.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function runMigrations() {
  const client = await pool.connect();
  try {
    console.log('[Migration] Checking database connection...');
    
    // Create migrations tracker table
    await client.query(`
      CREATE TABLE IF NOT EXISTS _migrations (
        id SERIAL PRIMARY KEY,
        name TEXT UNIQUE NOT NULL,
        executed_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    const migrationsDir = path.join(__dirname, 'migrations');
    const files = fs.readdirSync(migrationsDir)
      .filter((file) => file.endsWith('.sql'))
      .sort();

    const { rows: executedRows } = await client.query('SELECT name FROM _migrations');
    const executedSet = new Set(executedRows.map((r) => r.name));

    for (const file of files) {
      if (!executedSet.has(file)) {
        console.log(`[Migration] Running ${file}...`);
        const filePath = path.join(migrationsDir, file);
        const sql = fs.readFileSync(filePath, 'utf8');

        await client.query('BEGIN');
        try {
          await client.query(sql);
          await client.query('INSERT INTO _migrations (name) VALUES ($1)', [file]);
          await client.query('COMMIT');
          console.log(`[Migration] ✓ Applied: ${file}`);
        } catch (err) {
          await client.query('ROLLBACK');
          console.error(`[Migration] ✗ Failed: ${file}`, err);
          throw err;
        }
      } else {
        console.log(`[Migration] - Skipped (already applied): ${file}`);
      }
    }

    console.log('[Migration] All migrations completed successfully.');
  } finally {
    client.release();
    await pool.end();
  }
}

runMigrations().catch((err) => {
  console.error('[Migration] Fatal error running migrations:', err.message);
  process.exit(1);
});
