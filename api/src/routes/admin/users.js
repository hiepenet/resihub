import express from 'express';
import bcrypt from 'bcryptjs';
import { adminPool } from '../../db/client.js';
import { authenticateToken } from '../../middleware/auth.js';
import { requireRole } from '../../middleware/rbac.js';

const router = express.Router();

function normalizePhone(phone) {
  let clean = (phone || '').toString().trim().replace(/[\s\-\.\(\)]/g, '');
  if (clean.startsWith('+84')) clean = '0' + clean.slice(3);
  else if (clean.startsWith('84') && clean.length === 11) clean = '0' + clean.slice(2);
  return clean;
}

/**
 * GET /api/v1/admin/users/roles
 * Lấy danh mục vai trò của tổ chức (SYS_ADMIN, OWNER, MANAGER, STAFF, ACCOUNTANT, RESIDENT)
 */
router.get('/roles', authenticateToken, requireRole(['SYS_ADMIN', 'OWNER', 'MANAGER']), async (req, res) => {
  try {
    const result = await adminPool.query(
      'SELECT id, code, name, scope FROM role WHERE org_id = $1 ORDER BY code ASC',
      [req.user.org_id]
    );
    res.json({ data: result.rows });
  } catch (err) {
    console.error('[Admin Roles List Error]:', err);
    res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi khi tải danh sách vai trò.' });
  }
});

/**
 * GET /api/v1/admin/users
 * Danh sách người dùng toàn tổ chức (M01, FR-004)
 * Cho phép SYS_ADMIN xem đầy đủ; OWNER xem nhân sự tòa mình sở hữu (hữu ích khi tra cứu)
 */
router.get('/', authenticateToken, requireRole(['SYS_ADMIN', 'OWNER']), async (req, res) => {
  const { role, status, search } = req.query;
  const orgId = req.user.org_id;

  try {
    const params = [orgId];
    let sql = `
      SELECT au.id,
             au.person_id,
             au.status,
             au.last_login_at,
             au.created_at,
             p.full_name,
             p.phone,
             p.email,
             p.id_number,
             p.address,
             p.nationality,
             COALESCE(
               json_agg(
                 DISTINCT jsonb_build_object(
                   'role_id', r.id,
                   'code', r.code,
                   'name', r.name,
                   'scope', r.scope,
                   'building_id', ur.building_id,
                   'building_code', b.code,
                   'building_name', b.name
                 )
               ) FILTER (WHERE r.id IS NOT NULL),
               '[]'::json
             ) AS roles
      FROM app_user au
      JOIN person p ON p.id = au.person_id
      LEFT JOIN user_role ur ON ur.user_id = au.id
      LEFT JOIN role r ON r.id = ur.role_id
      LEFT JOIN building b ON b.id = ur.building_id
      WHERE p.org_id = $1
    `;

    if (status) {
      params.push(status);
      sql += ` AND au.status = $${params.length}`;
    }
    if (role) {
      params.push(role);
      sql += ` AND EXISTS (
        SELECT 1 FROM user_role ur2 JOIN role r2 ON r2.id = ur2.role_id
        WHERE ur2.user_id = au.id AND r2.code = $${params.length}
      )`;
    }
    if (search && search.trim()) {
      params.push(`%${search.trim()}%`);
      const idx = params.length;
      sql += ` AND (p.full_name ILIKE $${idx} OR COALESCE(p.email, '') ILIKE $${idx} OR COALESCE(p.phone, '') ILIKE $${idx})`;
    }

    sql += `
      GROUP BY au.id, p.id
      ORDER BY au.created_at DESC
    `;

    const result = await adminPool.query(sql, params);

    // Kèm danh sách Chủ đầu tư (owner table) để gán cho Building dễ dàng
    const ownersRes = await adminPool.query(
      `SELECT o.id, o.full_name, o.full_name AS name, o.person_id,
              COALESCE(p.email, o.email) AS email,
              COALESCE(p.phone, o.phone) AS phone
       FROM owner o
       LEFT JOIN person p ON p.id = o.person_id
       WHERE o.org_id = $1
       ORDER BY o.full_name ASC`,
      [orgId]
    );

    res.json({ data: result.rows, owners: ownersRes.rows });
  } catch (err) {
    console.error('[Admin Users List Error]:', err);
    res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi khi tải danh sách tài khoản.' });
  }
});

/**
 * POST /api/v1/admin/users
 * Tạo tài khoản nhân sự / chủ đầu tư / quản lý mới và gán vai trò theo tòa nhà (FR-004)
 */
router.post('/', authenticateToken, requireRole(['SYS_ADMIN']), async (req, res) => {
  const { full_name, email, phone, password, id_number, roles = [] } = req.body;
  const orgId = req.user.org_id;

  if (!full_name?.trim()) {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Họ và tên là bắt buộc.' });
  }
  const cleanEmail = email?.trim().toLowerCase() || null;
  const cleanPhone = phone ? normalizePhone(phone) : null;

  if (!cleanEmail && !cleanPhone) {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Phải cung cấp ít nhất Email hoặc Số điện thoại.' });
  }
  if (password && password.length < 8) {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Mật khẩu phải từ 8 ký tự trở lên.' });
  }

  const client = await adminPool.connect();
  try {
    await client.query('BEGIN');

    if (cleanEmail) {
      const dupEmail = await client.query('SELECT 1 FROM person WHERE LOWER(email) = $1 AND org_id = $2', [cleanEmail, orgId]);
      if (dupEmail.rows.length > 0) {
        await client.query('ROLLBACK');
        return res.status(409).json({ code: 'DUPLICATE_EMAIL', message: 'Email này đã được sử dụng trong tổ chức.' });
      }
    }
    if (cleanPhone) {
      const dupPhone = await client.query('SELECT 1 FROM person WHERE phone = $1 AND org_id = $2', [cleanPhone, orgId]);
      if (dupPhone.rows.length > 0) {
        await client.query('ROLLBACK');
        return res.status(409).json({ code: 'DUPLICATE_PHONE', message: 'Số điện thoại này đã tồn tại trong tổ chức.' });
      }
    }

    const pIns = await client.query(
      `INSERT INTO person (org_id, full_name, phone, email, id_number)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [orgId, full_name.trim(), cleanPhone, cleanEmail, id_number?.trim() || null]
    );
    const person = pIns.rows[0];

    const passwordHash = password ? await bcrypt.hash(password, 10) : null;
    const authUid = cleanEmail || `user_${cleanPhone || person.id.slice(0, 8)}`;

    const uIns = await client.query(
      `INSERT INTO app_user (person_id, auth_uid, password_hash, status)
       VALUES ($1, $2, $3, 'ACTIVE')
       RETURNING *`,
      [person.id, authUid, passwordHash]
    );
    const appUser = uIns.rows[0];

    // Gán vai trò
    const roleAssignments = Array.isArray(roles) && roles.length > 0 ? roles : [{ role_code: 'STAFF', building_id: null }];
    for (const item of roleAssignments) {
      const code = typeof item === 'string' ? item : (item.role_code || item.code);
      const bId = typeof item === 'object' ? (item.building_id || null) : null;
      if (!code) continue;

      const rRes = await client.query('SELECT id, code FROM role WHERE org_id = $1 AND code = $2', [orgId, code]);
      if (rRes.rows.length === 0) continue;

      await client.query(
        `INSERT INTO user_role (user_id, role_id, building_id)
         VALUES ($1, $2, $3)
         ON CONFLICT DO NOTHING`,
        [appUser.id, rRes.rows[0].id, bId]
      );

      if (code === 'OWNER') {
        const ownExist = await client.query('SELECT id FROM owner WHERE person_id = $1 AND org_id = $2', [person.id, orgId]);
        if (ownExist.rows.length === 0) {
          await client.query(
            `INSERT INTO owner (org_id, person_id, full_name, phone, email)
             VALUES ($1, $2, $3, $4, $5)`,
            [orgId, person.id, person.full_name, cleanPhone, cleanEmail]
          );
        }
      }
    }

    await client.query(
      `INSERT INTO audit_log (actor_id, action, entity, entity_id, after)
       VALUES ($1, 'CREATE_USER', 'app_user', $2, $3)`,
      [req.user.sub, appUser.id, JSON.stringify({ person_id: person.id, full_name: person.full_name, email: cleanEmail, roles: roleAssignments })]
    );

    await client.query('COMMIT');
    res.status(201).json({
      message: 'Tạo tài khoản người dùng thành công.',
      data: { ...appUser, full_name: person.full_name, email: person.email, phone: person.phone },
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[Create Admin User Error]:', err);
    res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi khi tạo tài khoản người dùng.' });
  } finally {
    client.release();
  }
});

/**
 * PATCH /api/v1/admin/users/:id
 * Cập nhật thông tin, khóa/mở tài khoản (ACTIVE/SUSPENDED), đặt lại mật khẩu, gán lại vai trò & tòa nhà
 */
router.patch('/:id', authenticateToken, requireRole(['SYS_ADMIN']), async (req, res) => {
  const { id } = req.params;
  const { full_name, email, phone, status, password, roles } = req.body;
  const orgId = req.user.org_id;

  const client = await adminPool.connect();
  try {
    const existing = await client.query(
      `SELECT au.*, p.full_name, p.email, p.phone, p.org_id
       FROM app_user au
       JOIN person p ON p.id = au.person_id
       WHERE au.id = $1 AND p.org_id = $2`,
      [id, orgId]
    );
    if (existing.rows.length === 0) {
      return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy tài khoản.' });
    }
    const cur = existing.rows[0];

    if (id === req.user.sub && status === 'SUSPENDED') {
      return res.status(409).json({ code: 'SELF_LOCK_PROHIBITED', message: 'Không thể tự khóa tài khoản Quản trị viên đang đăng nhập.' });
    }

    await client.query('BEGIN');

    // Cập nhật person
    const nextName = full_name?.trim() || cur.full_name;
    const nextEmail = email !== undefined ? (email?.trim().toLowerCase() || null) : cur.email;
    const nextPhone = phone !== undefined ? (phone ? normalizePhone(phone) : null) : cur.phone;

    await client.query(
      `UPDATE person
       SET full_name = $1, email = $2, phone = $3, updated_at = NOW()
       WHERE id = $4`,
      [nextName, nextEmail, nextPhone, cur.person_id]
    );

    // Cập nhật app_user (status, password_hash, tăng token_version nếu khóa hoặc đổi role)
    const nextStatus = status && ['ACTIVE', 'SUSPENDED'].includes(status) ? status : cur.status;
    let nextHash = cur.password_hash;
    if (password && password.length >= 8) {
      nextHash = await bcrypt.hash(password, 10);
    }
    const bumpToken = nextStatus === 'SUSPENDED' || Array.isArray(roles) || Boolean(password);

    const upUser = await client.query(
      `UPDATE app_user
       SET status = $1,
           password_hash = $2,
           token_version = COALESCE(token_version, 1) + CASE WHEN $3 THEN 1 ELSE 0 END
       WHERE id = $4
       RETURNING id, person_id, status, token_version, created_at`,
      [nextStatus, nextHash, bumpToken, id]
    );

    // Cập nhật phân quyền user_role nếu có truyền mảng roles
    if (Array.isArray(roles)) {
      await client.query('DELETE FROM user_role WHERE user_id = $1', [id]);
      for (const item of roles) {
        const code = typeof item === 'string' ? item : (item.role_code || item.code);
        const bId = typeof item === 'object' ? (item.building_id || null) : null;
        if (!code) continue;

        const rRes = await client.query('SELECT id FROM role WHERE org_id = $1 AND code = $2', [orgId, code]);
        if (rRes.rows.length === 0) continue;

        await client.query(
          `INSERT INTO user_role (user_id, role_id, building_id)
           VALUES ($1, $2, $3)
           ON CONFLICT DO NOTHING`,
          [id, rRes.rows[0].id, bId]
        );

        if (code === 'OWNER') {
          const ownExist = await client.query('SELECT id FROM owner WHERE person_id = $1 AND org_id = $2', [cur.person_id, orgId]);
          if (ownExist.rows.length === 0) {
            await client.query(
              `INSERT INTO owner (org_id, person_id, full_name, phone, email)
               VALUES ($1, $2, $3, $4, $5)`,
              [orgId, cur.person_id, nextName, nextPhone, nextEmail]
            );
          }
        }
      }
    }

    await client.query(
      `INSERT INTO audit_log (actor_id, action, entity, entity_id, before, after)
       VALUES ($1, 'UPDATE_USER', 'app_user', $2, $3, $4)`,
      [
        req.user.sub,
        id,
        JSON.stringify({ status: cur.status, full_name: cur.full_name }),
        JSON.stringify({ status: nextStatus, full_name: nextName, roles_updated: Array.isArray(roles) }),
      ]
    );

    await client.query('COMMIT');
    res.json({
      message: 'Cập nhật tài khoản thành công.',
      data: { ...upUser.rows[0], full_name: nextName, email: nextEmail, phone: nextPhone },
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[Update Admin User Error]:', err);
    res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi khi cập nhật tài khoản.' });
  } finally {
    client.release();
  }
});

export default router;
