import express from 'express';
import { pool } from '../db/client.js';
import { authenticateToken } from '../middleware/auth.js';
import { requireRole } from '../middleware/rbac.js';

const router = express.Router();

/**
 * GET /api/v1/settings
 * Lấy cấu hình hệ thống của tổ chức (billing_config, sla_config, contact_config) (M01 FR-005)
 */
router.get('/', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT key, value, description, updated_at FROM system_setting WHERE org_id = $1 ORDER BY key ASC',
      [req.user.org_id]
    );
    const map = {};
    for (const row of result.rows) {
      map[row.key] = row.value;
    }
    res.json({ data: map, items: result.rows });
  } catch (err) {
    console.error('[Settings Get Error]:', err);
    res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi khi tải cấu hình hệ thống.' });
  }
});

/**
 * PUT /api/v1/settings
 * Cập nhật cấu hình hệ thống (SYS_ADMIN) (FR-005)
 */
router.put('/', authenticateToken, requireRole(['SYS_ADMIN']), async (req, res) => {
  const { settings } = req.body;
  const payload = settings && typeof settings === 'object' ? settings : req.body;
  const orgId = req.user.org_id;

  if (!payload || typeof payload !== 'object' || Object.keys(payload).length === 0) {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Dữ liệu cấu hình không hợp lệ.' });
  }

  try {
    const updatedKeys = [];
    for (const [key, val] of Object.entries(payload)) {
      if (val === undefined || typeof val !== 'object' || val === null) continue;
      await pool.query(
        `INSERT INTO system_setting (org_id, key, value, updated_by, updated_at)
         VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT (org_id, key) DO UPDATE
           SET value = EXCLUDED.value,
               updated_by = EXCLUDED.updated_by,
               updated_at = NOW()`,
        [orgId, key, JSON.stringify(val), req.user.sub]
      );
      updatedKeys.push(key);
    }

    await pool.query(
      `INSERT INTO audit_log (actor_id, action, entity, entity_id, after)
       VALUES ($1, 'UPDATE_SETTINGS', 'system_setting', $2, $3)`,
      [req.user.sub, orgId, JSON.stringify({ updated_keys: updatedKeys })]
    );

    const refreshed = await pool.query(
      'SELECT key, value, description, updated_at FROM system_setting WHERE org_id = $1 ORDER BY key ASC',
      [orgId]
    );
    const map = {};
    for (const row of refreshed.rows) {
      map[row.key] = row.value;
    }

    res.json({ message: 'Lưu cấu hình hệ thống thành công.', data: map, items: refreshed.rows });
  } catch (err) {
    console.error('[Settings Update Error]:', err);
    res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi khi lưu cấu hình hệ thống.' });
  }
});

export default router;

