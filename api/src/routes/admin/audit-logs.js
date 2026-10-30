import express from 'express';
import { adminPool, getUserClient } from '../../db/client.js';
import { authenticateToken } from '../../middleware/auth.js';
import { requireRole } from '../../middleware/rbac.js';

const router = express.Router();

/**
 * GET /api/v1/audit-logs
 * Tra cứu nhật ký hệ thống (R-24 / FR-005 / AC-019):
 * - SYS_ADMIN: Xem toàn bộ nhật ký tổ chức (qua RLS rls_audit_log_select)
 * - OWNER: Xem nhật ký thuộc các tòa nhà mình sở hữu (qua RLS rls_audit_log_select)
 */
router.get('/', authenticateToken, requireRole(['SYS_ADMIN', 'OWNER']), async (req, res) => {
  const {
    page = 1,
    limit = 30,
    entity,
    action,
    actor_id,
    from,
    to,
    search,
  } = req.query;

  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 30));
  const offset = (pageNum - 1) * limitNum;

  const { client, release } = await getUserClient(req);
  try {
    await client.query('BEGIN');

    const params = [];
    let whereSql = 'WHERE 1 = 1';

    if (entity && String(entity).trim()) {
      params.push(String(entity).trim());
      whereSql += ` AND al.entity = $${params.length}`;
    }
    if (action && String(action).trim()) {
      params.push(String(action).trim().toUpperCase());
      whereSql += ` AND UPPER(al.action) = $${params.length}`;
    }
    if (actor_id && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(actor_id).trim())) {
      params.push(String(actor_id).trim());
      whereSql += ` AND al.actor_id = $${params.length}::uuid`;
    }
    if (from && /^\d{4}-\d{2}-\d{2}$/.test(String(from).trim())) {
      params.push(String(from).trim());
      whereSql += ` AND al.at >= $${params.length}::date`;
    }
    if (to && /^\d{4}-\d{2}-\d{2}$/.test(String(to).trim())) {
      params.push(String(to).trim());
      whereSql += ` AND al.at < ($${params.length}::date + INTERVAL '1 day')`;
    }
    if (search && String(search).trim()) {
      params.push(`%${String(search).trim()}%`);
      const idx = params.length;
      whereSql += ` AND (
        al.action ILIKE $${idx}
        OR al.entity ILIKE $${idx}
        OR al.entity_id::text ILIKE $${idx}
        OR COALESCE(al.after::text, '') ILIKE $${idx}
      )`;
    }

    const countRes = await client.query(
      `SELECT COUNT(*)::int AS total FROM audit_log al ${whereSql}`,
      params
    );
    const total = countRes.rows[0]?.total || 0;

    const listParams = [...params, limitNum, offset];
    const rowsRes = await client.query(
      `SELECT al.id,
              al.actor_id,
              al.action,
              al.entity,
              al.entity_id,
              al.before,
              al.after,
              al.ip,
              al.user_agent,
              al.at,
              al.at AS created_at
       FROM audit_log al
       ${whereSql}
       ORDER BY al.at DESC, al.id DESC
       LIMIT $${listParams.length - 1} OFFSET $${listParams.length}`,
      listParams
    );

    await client.query('COMMIT');

    const actorIds = Array.from(new Set(rowsRes.rows.map((r) => r.actor_id).filter(Boolean)));
    const actorMap = new Map();
    if (actorIds.length > 0) {
      const actorsRes = await adminPool.query(
        `SELECT au.id,
                p.full_name,
                COALESCE(p.email, au.auth_uid) AS email
         FROM app_user au
         LEFT JOIN person p ON p.id = au.person_id
         WHERE au.id = ANY($1::uuid[])`,
        [actorIds]
      );
      for (const a of actorsRes.rows) {
        actorMap.set(a.id, { full_name: a.full_name || 'Hệ thống', email: a.email || '' });
      }
    }

    const enriched = rowsRes.rows.map((row) => {
      const actor = row.actor_id ? actorMap.get(row.actor_id) : null;
      return {
        ...row,
        actor_name: actor?.full_name || (row.actor_id ? 'Người dùng' : 'Hệ thống (Cron)'),
        actor_email: actor?.email || '',
      };
    });

    res.json({
      data: enriched,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        total_pages: Math.max(1, Math.ceil(total / limitNum)),
      },
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[AuditLogs List Error]:', err);
    res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi khi tải nhật ký hệ thống.' });
  } finally {
    await release();
  }
});

export default router;

