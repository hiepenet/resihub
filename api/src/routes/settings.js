import express from 'express';
import { pool } from '../db/client.js';
import { authenticateToken } from '../middleware/auth.js';
import { requireRole } from '../middleware/rbac.js';

const router = express.Router();

function normalizeBillingConfig(incoming, existing = {}) {
  const merged = { ...(existing || {}), ...(incoming || {}) };

  if (merged.billing_day !== undefined && merged.billing_day !== null && merged.billing_day !== '') {
    const bd = Math.round(Number(merged.billing_day));
    if (!Number.isFinite(bd) || bd < 1 || bd > 31) {
      throw Object.assign(new Error('Ngày chốt kỳ hóa đơn (billing_day) phải từ 1 đến 31.'), {
        status: 400,
        code: 'VALIDATION_ERROR',
      });
    }
    merged.billing_day = bd;
  }

  const rawOffset =
    incoming?.due_date_offset_days !== undefined
      ? incoming.due_date_offset_days
      : incoming?.payment_due_days !== undefined
      ? incoming.payment_due_days
      : merged.due_date_offset_days ?? merged.payment_due_days ?? 5;
  const offsetDays = Math.max(0, Math.round(Number(rawOffset) || 0));
  merged.due_date_offset_days = offsetDays;
  if (incoming?.payment_due_days !== undefined || merged.payment_due_days === undefined) {
    merged.payment_due_days =
      incoming?.payment_due_days !== undefined
        ? Math.max(0, Math.round(Number(incoming.payment_due_days) || 0))
        : offsetDays;
  }

  merged.late_fee_grace_days =
    merged.late_fee_grace_days !== undefined && merged.late_fee_grace_days !== null && merged.late_fee_grace_days !== ''
      ? Math.max(0, Math.round(Number(merged.late_fee_grace_days) || 0))
      : 5;

  merged.late_fee_per_day =
    merged.late_fee_per_day !== undefined && merged.late_fee_per_day !== null && merged.late_fee_per_day !== ''
      ? Math.max(0, Math.round(Number(merged.late_fee_per_day) || 0))
      : 100000;

  if (merged.late_fee_cap === null || merged.late_fee_cap === undefined || merged.late_fee_cap === '') {
    merged.late_fee_cap = null;
  } else {
    const capNum = Math.round(Number(merged.late_fee_cap));
    merged.late_fee_cap = Number.isFinite(capNum) && capNum > 0 ? capNum : null;
  }

  const rawThreshold = Number(merged.meter_anomaly_threshold_pct);
  merged.meter_anomaly_threshold_pct =
    Number.isFinite(rawThreshold) && rawThreshold > 0 ? rawThreshold : 30;

  return merged;
}

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
    const existingRes = await pool.query(
      'SELECT key, value FROM system_setting WHERE org_id = $1',
      [orgId]
    );
    const existingMap = Object.fromEntries(existingRes.rows.map((r) => [r.key, r.value]));

    const updatedKeys = [];
    for (const [key, val] of Object.entries(payload)) {
      if (val === undefined || typeof val !== 'object' || val === null) continue;
      const normalizedVal =
        key === 'billing_config'
          ? normalizeBillingConfig(val, existingMap.billing_config)
          : { ...(existingMap[key] || {}), ...val };

      await pool.query(
        `INSERT INTO system_setting (org_id, key, value, updated_by, updated_at)
         VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT (org_id, key) DO UPDATE
           SET value = EXCLUDED.value,
               updated_by = EXCLUDED.updated_by,
               updated_at = NOW()`,
        [orgId, key, JSON.stringify(normalizedVal), req.user.sub]
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
    if (err.status) {
      return res.status(err.status).json({ code: err.code || 'VALIDATION_ERROR', message: err.message });
    }
    console.error('[Settings Update Error]:', err);
    res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi khi lưu cấu hình hệ thống.' });
  }
});

export default router;
