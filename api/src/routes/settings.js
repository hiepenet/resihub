import express from 'express';
import { pool } from '../db/client.js';
import { authenticateToken } from '../middleware/auth.js';
import { requireRole } from '../middleware/rbac.js';
import { idempotencyGuard } from '../middleware/idempotency.js';
import { runDailyJobs } from '../jobs/daily.js';
import { todayVietnamYmd } from '../services/serviceBilling.js';
import { normalizeAiConfig } from '../services/aiRules.js';
import { isGeminiApiKeyConfigured } from '../services/geminiClient.js';

const router = express.Router();
const DATE_YMD_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

function normalizeSlaConfig(incoming, existing = {}) {
  const merged = { ...(existing || {}), ...(incoming || {}) };
  const defaults = {
    response_hours: 2,
    urgent_resolve_hours: 4,
    normal_resolve_hours: 24,
    deposit_refund_days: 5,
    reopen_window_days: 3,
  };

  for (const [field, fallback] of Object.entries(defaults)) {
    const raw = merged[field];
    if (raw === undefined || raw === null || raw === '') {
      merged[field] = fallback;
    } else {
      const parsed = Math.round(Number(raw));
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw Object.assign(new Error(`Cấu hình SLA (${field}) phải là số nguyên dương.`), {
          status: 400,
          code: 'VALIDATION_ERROR',
        });
      }
      merged[field] = parsed;
    }
  }

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
    res.json({
      data: map,
      items: result.rows,
      ai_runtime: { api_key_configured: isGeminiApiKeyConfigured() },
    });
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
          : key === 'sla_config'
          ? normalizeSlaConfig(val, existingMap.sla_config)
          : key === 'ai_config'
          ? normalizeAiConfig(val, existingMap.ai_config)
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

    res.json({
      message: 'Lưu cấu hình hệ thống thành công.',
      data: map,
      items: refreshed.rows,
      ai_runtime: { api_key_configured: isGeminiApiKeyConfigured() },
    });
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ code: err.code || 'VALIDATION_ERROR', message: err.message });
    }
    console.error('[Settings Update Error]:', err);
    res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi khi lưu cấu hình hệ thống.' });
  }
});

/**
 * GET /api/v1/settings/cron-runs
 * Lịch sử thực thi tiến trình tự động hằng ngày (PRD 14.5, FR-066 — chỉ SYS_ADMIN, tuân thủ FORCE RLS)
 */
router.get(
  '/cron-runs',
  authenticateToken,
  requireRole(['SYS_ADMIN']),
  async (req, res) => {
    try {
      const limit = Math.min(50, Math.max(1, Math.round(Number(req.query.limit) || 15)));
      const result = await pool.query(
        `SELECT id, job_name, run_date, status, attempt_count, duration_ms, summary, error_message, started_at, finished_at
         FROM cron_job_run
         ORDER BY started_at DESC
         LIMIT $1`,
        [limit]
      );
      res.json({
        data: result.rows,
        today_vn: todayVietnamYmd(),
        allow_custom_date: process.env.NODE_ENV !== 'production',
      });
    } catch (err) {
      console.error('[Cron Runs List Error]:', err);
      res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi khi tải nhật ký tiến trình tự động.' });
    }
  }
);

/**
 * POST /api/v1/settings/cron-runs/trigger
 * Kích hoạt đồng bộ tiến trình tự động hằng ngày an toàn cho SYS_ADMIN (FR-066, FR-064)
 * - Production: chỉ cho phép chạy cho ngày hiện tại (Asia/Ho_Chi_Minh).
 * - Dev / Test / QA: cho phép truyền `as_of_date` (YYYY-MM-DD) để kiểm thử chu kỳ billing_day & phí phạt chậm trên giao diện.
 */
router.post(
  '/cron-runs/trigger',
  authenticateToken,
  requireRole(['SYS_ADMIN']),
  idempotencyGuard(),
  async (req, res) => {
    const rawAsOfDate = req.body?.as_of_date ? String(req.body.as_of_date).trim() : '';
    const rawBuildingId = req.body?.building_id ? String(req.body.building_id).trim() : '';
    const todayVn = todayVietnamYmd();

    if (rawAsOfDate && !DATE_YMD_RE.test(rawAsOfDate)) {
      return res.status(400).json({
        code: 'INVALID_DATE',
        message: 'Ngày đối soát (as_of_date) phải theo định dạng YYYY-MM-DD.',
      });
    }
    if (rawBuildingId && !UUID_RE.test(rawBuildingId)) {
      return res.status(400).json({
        code: 'INVALID_BUILDING_ID',
        message: 'Mã định danh tòa nhà (building_id) không hợp lệ.',
      });
    }

    const effectiveDate = rawAsOfDate || todayVn;
    if (process.env.NODE_ENV === 'production' && effectiveDate !== todayVn) {
      return res.status(403).json({
        code: 'CUSTOM_DATE_FORBIDDEN_IN_PROD',
        message: 'Môi trường Production chỉ cho phép kích hoạt đồng bộ cho ngày hiện tại.',
      });
    }

    try {
      const runResult = await runDailyJobs({
        asOfDate: effectiveDate,
        buildingId: rawBuildingId || null,
        triggerSource: 'sys_admin_ui',
      });

      await pool.query(
        `INSERT INTO audit_log (actor_id, action, entity, entity_id, after)
         VALUES ($1, 'TRIGGER_DAILY_CRON', 'system_setting', $2, $3::jsonb)`,
        [
          req.user.sub,
          req.user.org_id,
          JSON.stringify({
            as_of_date: effectiveDate,
            building_id: rawBuildingId || null,
            skipped: Boolean(runResult?.skipped),
          }),
        ]
      );

      res.json({
        message: runResult?.skipped
          ? 'Tiến trình đang được thực thi ở một phiên khác (pg_try_advisory_lock).'
          : `Đã thực thi tiến trình tự động cho ngày ${runResult.runDate} thành công.`,
        data: runResult,
      });
    } catch (err) {
      console.error('[Cron Trigger Error]:', err);
      res.status(500).json({
        code: 'CRON_EXECUTION_FAILED',
        message: err?.message || 'Lỗi khi thực thi tiến trình tự động hằng ngày.',
      });
    }
  }
);

export default router;
