import '../config/env.js';
import { adminPool, appPool } from '../db/client.js';
import { startDailyJobs } from './daily.js';

async function main() {
  await adminPool.query('SELECT 1');
  const job = startDailyJobs({ keepAlive: true, runCatchUpOnBoot: true });
  console.log('[Worker] ResiHub Daily Cron Worker started (00:05 Asia/Ho_Chi_Minh).');

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[Worker] Received ${signal}, shutting down gracefully...`);
    job.stop();
    await Promise.allSettled([adminPool.end(), appPool.end()]);
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('[Worker] Fatal startup error:', err);
  process.exit(1);
});
