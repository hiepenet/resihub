import express from 'express';
import { adminPool, getUserClient } from '../../db/client.js';
import { authenticateToken } from '../../middleware/auth.js';
import { requireRole } from '../../middleware/rbac.js';
import { toUtf8BomCsv, toXlsxBuffer } from '../../utils/csv.js';
import { getUserRoleCodes } from '../../services/ownerScope.js';

const router = express.Router();

const FINANCIAL_AUDIT_ENTITIES = [
  'invoice',
  'invoice_line',
  'invoice_adjustment',
  'payment',
  'receivable',
  'credit_balance',
  'deposit',
  'deposit_transaction',
  'reservation',
  'service_subscription',
  'service_catalog',
  'contract_service_price',
];

/**
 * GET /api/v1/audit-logs
 * Tra cứu nhật ký hệ thống & Xuất CSV Nhật ký thao tác tài chính RP-08 (R-24 / FR-005 / AC-019 / PRD 15.2):
 * - SYS_ADMIN: Xem toàn bộ nhật ký tổ chức (qua RLS rls_audit_log_select)
 * - OWNER: Xem nhật ký thuộc các tòa nhà mình sở hữu (qua RLS rls_audit_log_select)
 * - Hỗ trợ scope=financial và format=csv (tối đa 5000 dòng, chống Formula Injection)
 */
router.get('/', authenticateToken, requireRole(['SYS_ADMIN', 'OWNER', 'MANAGER']), async (req, res) => {
  const {
    page = 1,
    limit = 30,
    entity,
    action,
    actor_id,
    from,
    to,
    search,
    scope,
    format,
  } = req.query;

  const isCsv = String(format || '').toLowerCase() === 'csv';
  const isXlsx = String(format || '').toLowerCase() === 'xlsx';
  const isFinancialScope = String(scope || '').toLowerCase() === 'financial';

  const roleCodes = getUserRoleCodes(req);
  if (roleCodes.includes('MANAGER') && !roleCodes.some((r) => ['SYS_ADMIN', 'OWNER'].includes(r))) {
    if (!isFinancialScope) {
      return res.status(403).json({
        code: 'ACCESS_DENIED',
        message: 'Quản lý (MANAGER) chỉ có quyền xem nhật ký thao tác tài chính (scope=financial).',
      });
    }
  }
  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 30));
  const offset = (pageNum - 1) * limitNum;

  const { client, release } = await getUserClient(req);
  try {
    await client.query('BEGIN');

    const params = [];
    let whereSql = 'WHERE 1 = 1';

    if (isFinancialScope) {
      params.push(FINANCIAL_AUDIT_ENTITIES);
      whereSql += ` AND al.entity = ANY($${params.length}::text[])`;
    }
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

    let total = 0;
    let rowsRes;

    if (isCsv || isXlsx) {
      const csvParams = [...params, 5000];
      rowsRes = await client.query(
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
         LIMIT $${csvParams.length}`,
        csvParams
      );
      total = rowsRes.rows.length;
    } else {
      const countRes = await client.query(
        `SELECT COUNT(*)::int AS total FROM audit_log al ${whereSql}`,
        params
      );
      total = countRes.rows[0]?.total || 0;

      const listParams = [...params, limitNum, offset];
      rowsRes = await client.query(
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
    }

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

    if (isCsv || isXlsx) {
      const headers = [
        'Thời gian',
        'Người thực hiện',
        'Email',
        'Hành động',
        'Đối tượng',
        'Mã bản ghi',
        'IP',
        'Trước thay đổi (Before)',
        'Sau thay đổi (After)',
      ];
      const exportRows = enriched.map((row) => [
        row.at ? new Date(row.at).toISOString() : '',
        row.actor_name,
        row.actor_email,
        row.action || '',
        row.entity || '',
        row.entity_id ? String(row.entity_id) : '',
        row.ip ? String(row.ip) : '',
        row.before ? JSON.stringify(row.before) : '',
        row.after ? JSON.stringify(row.after) : '',
      ]);
      const fileSlug = isFinancialScope ? 'nhat-ky-tai-chinh-rp08' : 'nhat-ky-kiem-toan';

      if (isXlsx) {
        const xlsxBuf = toXlsxBuffer([
          {
            name: isFinancialScope ? 'Nhat ky tai chinh RP-08' : 'Nhat ky he thong',
            headers,
            rows: exportRows,
          },
        ]);
        res.setHeader(
          'Content-Type',
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        );
        res.setHeader('Content-Disposition', `attachment; filename="${fileSlug}.xlsx"`);
        return res.status(200).send(xlsxBuf);
      }

      const csvContent = toUtf8BomCsv(headers, exportRows);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${fileSlug}.csv"`);
      return res.status(200).send(csvContent);
    }

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
