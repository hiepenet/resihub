#!/bin/sh
set -eu

mkdir -p /app/uploads
chown -R node:node /app/uploads

if [ "${SKIP_DB_INIT:-false}" != "true" ]; then
  echo "[Entrypoint] Waiting for PostgreSQL via DATABASE_URL..."
  su-exec node node -e '
    import("pg").then(async ({ default: pg }) => {
      for (let i = 1; i <= 30; i++) {
        const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
        try { await c.connect(); await c.query("SELECT 1"); await c.end(); process.exit(0); }
        catch (e) { await c.end().catch(() => {}); if (i === 30) { console.error(e.message); process.exit(1); } await new Promise(r => setTimeout(r, 2000)); }
      }
    });
  '
fi

if [ "${RUN_MIGRATIONS_ON_BOOT:-false}" = "true" ]; then
  echo "[Entrypoint] Running database migrations..."
  su-exec node node src/db/migrate.js
fi

if [ "${SEED_DEMO_ON_FIRST_BOOT:-false}" = "true" ]; then
  ORG_COUNT=$(su-exec node node -e '
    import("pg").then(async ({ default: pg }) => {
      const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
      await c.connect();
      const r = await c.query("SELECT COUNT(*)::int AS cnt FROM organization");
      await c.end();
      process.stdout.write(String(r.rows[0]?.cnt ?? 0));
    });
  ')
  if [ "${ORG_COUNT}" = "0" ]; then
    echo "[Entrypoint] Empty DB + SEED_DEMO_ON_FIRST_BOOT=true -> seeding Vinhomes demo dataset..."
    su-exec node node src/db/seed_vinhomes.js
  else
    echo "[Entrypoint] Organization already exists (count=${ORG_COUNT}) -> skipping demo seed."
  fi
fi

if [ "${RUN_BOOTSTRAP:-false}" = "true" ]; then
  echo "[Entrypoint] Running production bootstrap..."
  su-exec node node src/db/bootstrapProd.js
fi

exec su-exec node "$@"
