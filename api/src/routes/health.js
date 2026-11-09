import express from 'express';
import { pool } from '../db/client.js';

export function createHealthRouter(dbPool = pool) {
  const router = express.Router();

  router.get('/health', async (req, res) => {
    try {
      const result = await dbPool.query('SELECT NOW() as current_time');
      const dbStatus = result.rows.length > 0 ? 'connected' : 'disconnected';
      if (dbStatus !== 'connected') {
        return res.status(503).json({
          status: 'degraded',
          app: 'ResiHub API',
          version: '1.0.0',
          timestamp: new Date().toISOString(),
          database: dbStatus,
        });
      }
      return res.status(200).json({
        status: 'ok',
        app: 'ResiHub API',
        version: '1.0.0',
        timestamp: new Date().toISOString(),
        database: dbStatus,
      });
    } catch (err) {
      return res.status(503).json({
        status: 'degraded',
        app: 'ResiHub API',
        version: '1.0.0',
        timestamp: new Date().toISOString(),
        database: `error: ${err.message}`,
      });
    }
  });

  return router;
}

export default createHealthRouter();
