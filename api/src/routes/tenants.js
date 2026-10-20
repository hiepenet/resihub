import express from 'express';
import { pool, getUserClient } from '../db/client.js';
import { authenticateToken } from '../middleware/auth.js';
import { requireRole } from '../middleware/rbac.js';

const router = express.Router();

/**
 * GET /api/v1/tenants/check-dup
 * Kiểm tra trùng SĐT hoặc CCCD (FR-021)
 */
router.get('/check-dup', authenticateToken, requireRole(['OWNER', 'MANAGER']), async (req, res) => {
  const { phone, id_number } = req.query;
  const orgId = req.user.org_id;

  try {
    let sql = `SELECT id, full_name, phone FROM person WHERE org_id = $1 AND (`;
    const params = [orgId];
    const conditions = [];

    if (phone) {
      params.push(phone);
      conditions.push(`phone = $${params.length}`);
    }
    if (id_number) {
      params.push(id_number);
      conditions.push(`id_number = $${params.length}`);
    }

    if (conditions.length === 0) {
      return res.json({ isDuplicate: false, duplicates: [] });
    }

    sql += conditions.join(' OR ') + ')';
    const result = await pool.query(sql, params);

    res.json({
      isDuplicate: result.rows.length > 0,
      duplicates: result.rows,
    });
  } catch (err) {
    console.error('[Check Dup Error]:', err);
    res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi kiểm tra trùng lặp.' });
  }
});

/**
 * GET /api/v1/tenants
 * Quyền: OWNER (R), MANAGER (CRU)
 */
router.get('/', authenticateToken, requireRole(['OWNER', 'MANAGER']), async (req, res) => {
  try {
    const orgId = req.user.org_id;
    const userRoles = (req.user.roles || []).map((r) => (typeof r === 'string' ? r : r.code));
    const isOwner = userRoles.includes('OWNER');
    const isManager = userRoles.includes('MANAGER');

    let sql = `
      SELECT t.*, p.full_name, p.phone, p.email, p.dob, p.id_number
      FROM tenant t
      JOIN person p ON p.id = t.person_id
      WHERE t.org_id = $1
    `;
    const params = [orgId];

    if (isManager && !isOwner) {
      params.push(req.user.sub);
      sql += ` AND (
        t.id IN (
          SELECT c.primary_tenant_id FROM contract c
          WHERE c.building_id IN (SELECT building_id FROM user_role WHERE user_id = $${params.length} AND building_id IS NOT NULL)
        )
        OR t.id IN (
          SELECT co.tenant_id FROM contract_occupant co
          JOIN contract c ON c.id = co.contract_id
          WHERE c.building_id IN (SELECT building_id FROM user_role WHERE user_id = $${params.length} AND building_id IS NOT NULL)
        )
        OR NOT EXISTS (
          SELECT 1 FROM contract c WHERE c.primary_tenant_id = t.id
        )
      )`;
    }

    sql += ` ORDER BY t.created_at DESC`;

    const result = await pool.query(sql, params);

    res.json({ data: result.rows });
  } catch (err) {
    console.error('[Tenants Error]:', err);
    res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi lấy danh sách cư dân.' });
  }
});

/**
 * POST /api/v1/tenants
 * Quyền: Chỉ MANAGER có quyền tạo hồ sơ cư dân (CRU)
 */
router.post('/', authenticateToken, requireRole(['MANAGER']), async (req, res) => {
  const { full_name, phone, email, dob, id_number, type } = req.body;
  const orgId = req.user.org_id;

  if (!full_name || !phone) {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Họ tên và số điện thoại là bắt buộc.' });
  }

  const { client, release } = await getUserClient(req);
  try {
    await client.query('BEGIN');

    // 1. Tạo hoặc lấy person
    let personRes = await client.query('SELECT * FROM person WHERE org_id = $1 AND phone = $2', [orgId, phone]);
    let personId;
    if (personRes.rows.length === 0) {
      const newPerson = await client.query(
        `INSERT INTO person (org_id, full_name, phone, email, dob, id_number)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id`,
        [orgId, full_name, phone, email || null, dob || null, id_number || null]
      );
      personId = newPerson.rows[0].id;
    } else {
      personId = personRes.rows[0].id;
    }

    // 2. Tạo tenant
    const tenantRes = await client.query(
      `INSERT INTO tenant (person_id, org_id, type, status)
       VALUES ($1, $2, $3, 'APPROVED')
       RETURNING *`,
      [personId, orgId, type || 'primary']
    );

    // Audit log
    await client.query(
      `INSERT INTO audit_log (actor_id, action, entity, entity_id, after)
       VALUES ($1, 'CREATE', 'tenant', $2, $3)`,
      [req.user.sub, tenantRes.rows[0].id, JSON.stringify(tenantRes.rows[0])]
    );

    await client.query('COMMIT');
    res.status(201).json({ message: 'Tạo hồ sơ cư dân thành công.', data: tenantRes.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[Create Tenant Error]:', err);
    res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi máy chủ khi tạo hồ sơ cư dân.' });
  } finally {
    await release();
  }
});

export default router;
