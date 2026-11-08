import express from 'express';
import { adminPool, getUserClient } from '../db/client.js';
import { authenticateToken } from '../middleware/auth.js';
import { requireRole } from '../middleware/rbac.js';
import { idempotencyGuard } from '../middleware/idempotency.js';
import {
  getUserRoleCodes,
  scopedBuildingFilter,
  checkBuildingAccess,
  logAccessDenied,
} from '../services/ownerScope.js';
import { validateZaloInviteLink } from '../services/zaloFormatter.js';

const router = express.Router();

const VALID_SCOPES = ['BUILDING', 'APARTMENT'];

async function resolveOpsScope(queryFn, entity, id) {
  if (!id) return null;
  try {
    const res = await queryFn(
      `SELECT resource_id, org_id, building_id FROM fn_get_ops_resource_scope($1, $2)`,
      [entity, id]
    );
    return res.rows[0] || null;
  } catch (err) {
    if (err.code === '22P02') return null;
    throw err;
  }
}

/**
 * GET /api/v1/zalo-groups (FR-069, PRD 13.6)
 * Danh bạ nhóm Zalo theo tòa / phòng (SYS_ADMIN, OWNER, MANAGER đọc; kiểm tra 403 ACCESS_DENIED đa tòa)
 */
router.get('/', authenticateToken, requireRole(['SYS_ADMIN', 'OWNER', 'MANAGER']), async (req, res) => {
  const { building_id, scope, apartment_id, include_inactive } = req.query;
  const { client, release } = await getUserClient(req);

  try {
    const queryFn = (sql, params) => client.query(sql, params);

    if (building_id) {
      const bldgScope = await resolveOpsScope(queryFn, 'building', building_id);
      if (!bldgScope) {
        return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy tòa nhà.' });
      }
      const allowed = await checkBuildingAccess(req, building_id);
      if (!allowed) {
        await logAccessDenied(req, 'zalo_group', building_id, 'Cross-building GET /zalo-groups denied');
        return res.status(403).json({
          code: 'ACCESS_DENIED',
          message: 'Bạn không có quyền truy cập danh bạ nhóm Zalo của tòa nhà này.',
        });
      }
    }

    const params = [req.user.org_id];
    const conditions = ['zg.org_id = $1'];

    const roles = getUserRoleCodes(req);
    if (!roles.includes('SYS_ADMIN')) {
      const { sql: scopeSql } = await scopedBuildingFilter(req, 'zg.building_id', params);
      if (scopeSql) {
        conditions.push(scopeSql.replace(/^\s*AND\s+/i, ''));
      }
    }

    if (building_id) {
      params.push(building_id);
      conditions.push(`zg.building_id = $${params.length}`);
    }

    if (scope && VALID_SCOPES.includes(String(scope).toUpperCase())) {
      params.push(String(scope).toUpperCase());
      conditions.push(`zg.scope = $${params.length}`);
    }

    if (apartment_id) {
      params.push(apartment_id);
      conditions.push(`zg.apartment_id = $${params.length}`);
    }

    if (String(include_inactive) !== 'true') {
      conditions.push('zg.is_active = TRUE');
    }

    const result = await client.query(
      `SELECT zg.*,
              b.code AS building_code,
              b.name AS building_name,
              a.code AS apartment_code,
              f.id AS floor_id,
              f.name AS floor_name
       FROM zalo_group zg
       JOIN building b ON b.id = zg.building_id
       LEFT JOIN apartment a ON a.id = zg.apartment_id
       LEFT JOIN floor f ON f.id = a.floor_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY zg.scope ASC, a.code ASC NULLS FIRST, zg.name ASC`,
      params
    );

    res.json({ data: result.rows });
  } catch (err) {
    console.error('[Get Zalo Groups Error]:', err);
    res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi khi tải danh bạ nhóm Zalo.' });
  } finally {
    await release();
  }
});

/**
 * POST /api/v1/zalo-groups (FR-069, PRD 6.2)
 * Tạo mới nhóm Zalo tòa nhà / phòng (SYS_ADMIN toàn tổ chức, hoặc MANAGER của tòa được phép ghi)
 */
router.post('/', authenticateToken, requireRole(['SYS_ADMIN', 'MANAGER']), idempotencyGuard(), async (req, res) => {
  const {
    building_id,
    scope = 'BUILDING',
    apartment_id = null,
    name,
    invite_link = null,
    note = null,
    is_active = true,
  } = req.body || {};

  if (!building_id || !name?.trim()) {
    return res.status(400).json({
      code: 'VALIDATION_ERROR',
      message: 'Vui lòng chọn tòa nhà và nhập tên nhóm Zalo.',
    });
  }

  const normScope = String(scope).trim().toUpperCase();
  if (!VALID_SCOPES.includes(normScope)) {
    return res.status(400).json({
      code: 'VALIDATION_ERROR',
      message: 'Phạm vi nhóm Zalo phải là BUILDING hoặc APARTMENT.',
    });
  }

  if (normScope === 'APARTMENT' && !apartment_id) {
    return res.status(400).json({
      code: 'VALIDATION_ERROR',
      message: 'Nhóm Zalo phạm vi phòng (APARTMENT) bắt buộc chọn căn hộ.',
    });
  }

  const linkCheck = validateZaloInviteLink(invite_link);
  if (!linkCheck.valid) {
    return res.status(422).json({
      code: linkCheck.code || 'INVALID_ZALO_LINK',
      message: linkCheck.message,
    });
  }

  const { client, release } = await getUserClient(req);
  let txStarted = false;

  try {
    const queryFn = (sql, params) => client.query(sql, params);
    const bldgScope = await resolveOpsScope(queryFn, 'building', building_id);
    if (!bldgScope) {
      return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy tòa nhà.' });
    }

    const allowed = await checkBuildingAccess(req, building_id);
    if (!allowed) {
      await logAccessDenied(req, 'zalo_group', building_id, 'MANAGER attempted POST /zalo-groups on unassigned building');
      return res.status(403).json({
        code: 'ACCESS_DENIED',
        message: 'Bạn không được phân công quản lý tòa nhà này.',
      });
    }

    let targetApartmentId = null;
    if (normScope === 'APARTMENT') {
      const aptScope = await resolveOpsScope(queryFn, 'apartment', apartment_id);
      if (!aptScope) {
        return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy căn hộ.' });
      }
      if (aptScope.building_id !== building_id) {
        return res.status(422).json({
          code: 'APARTMENT_BUILDING_MISMATCH',
          message: 'Căn hộ đã chọn không thuộc tòa nhà này.',
        });
      }
      targetApartmentId = apartment_id;
    }

    await client.query('BEGIN');
    txStarted = true;

    const insRes = await client.query(
      `INSERT INTO zalo_group (
         org_id, building_id, apartment_id, scope, name, invite_link, note, is_active, created_by
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        bldgScope.org_id,
        building_id,
        targetApartmentId,
        normScope,
        name.trim(),
        linkCheck.normalized,
        note?.trim() || null,
        Boolean(is_active),
        req.user.sub,
      ]
    );
    const created = insRes.rows[0];

    await client.query(
      `INSERT INTO audit_log (actor_id, action, entity, entity_id, after)
       VALUES ($1, 'CREATE_ZALO_GROUP', 'zalo_group', $2, $3)`,
      [req.user.sub, created.id, JSON.stringify(created)]
    );

    const enrichedRes = await client.query(
      `SELECT zg.*, b.code AS building_code, b.name AS building_name, a.code AS apartment_code
       FROM zalo_group zg
       JOIN building b ON b.id = zg.building_id
       LEFT JOIN apartment a ON a.id = zg.apartment_id
       WHERE zg.id = $1`,
      [created.id]
    );

    await client.query('COMMIT');
    txStarted = false;

    res.status(201).json({
      message: 'Đã thêm nhóm Zalo vào danh bạ.',
      data: enrichedRes.rows[0] || created,
    });
  } catch (err) {
    if (txStarted) {
      await client.query('ROLLBACK').catch(() => {});
    }
    if (err.code === '23505') {
      return res.status(409).json({
        code: 'DUPLICATE_ZALO_GROUP',
        message: 'Tên nhóm Zalo này đã tồn tại trong cùng tòa nhà / căn hộ.',
      });
    }
    console.error('[Create Zalo Group Error]:', err);
    res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi khi thêm nhóm Zalo.' });
  } finally {
    await release();
  }
});

/**
 * PUT /api/v1/zalo-groups/:id (FR-069, PRD 6.2)
 * Cập nhật thông tin nhóm Zalo (SYS_ADMIN toàn tổ chức, hoặc MANAGER của tòa được phép ghi)
 */
router.put('/:id', authenticateToken, requireRole(['SYS_ADMIN', 'MANAGER']), idempotencyGuard(), async (req, res) => {
  const { id } = req.params;
  const { name, scope, apartment_id, invite_link, note, is_active } = req.body || {};

  if (invite_link !== undefined) {
    const linkCheck = validateZaloInviteLink(invite_link);
    if (!linkCheck.valid) {
      return res.status(422).json({
        code: linkCheck.code || 'INVALID_ZALO_LINK',
        message: linkCheck.message,
      });
    }
  }

  const { client, release } = await getUserClient(req);
  let txStarted = false;

  try {
    const queryFn = (sql, params) => client.query(sql, params);
    const zgScope = await resolveOpsScope(queryFn, 'zalo_group', id);
    if (!zgScope) {
      return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy nhóm Zalo.' });
    }

    const allowed = await checkBuildingAccess(req, zgScope.building_id);
    if (!allowed) {
      await logAccessDenied(req, 'zalo_group', id, 'MANAGER attempted PUT /zalo-groups/:id on unassigned building');
      return res.status(403).json({
        code: 'ACCESS_DENIED',
        message: 'Bạn không được phân công quản lý tòa nhà này.',
      });
    }

    const currentRes = await client.query(`SELECT * FROM zalo_group WHERE id = $1 LIMIT 1`, [id]);
    if (currentRes.rows.length === 0) {
      return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy nhóm Zalo.' });
    }
    const existing = currentRes.rows[0];

    const nextScope = scope !== undefined ? String(scope).trim().toUpperCase() : existing.scope;
    if (!VALID_SCOPES.includes(nextScope)) {
      return res.status(400).json({
        code: 'VALIDATION_ERROR',
        message: 'Phạm vi nhóm Zalo phải là BUILDING hoặc APARTMENT.',
      });
    }

    let nextApartmentId =
      nextScope === 'BUILDING'
        ? null
        : apartment_id !== undefined
        ? apartment_id
        : existing.apartment_id;

    if (nextScope === 'APARTMENT') {
      if (!nextApartmentId) {
        return res.status(400).json({
          code: 'VALIDATION_ERROR',
          message: 'Nhóm Zalo phạm vi phòng (APARTMENT) bắt buộc chọn căn hộ.',
        });
      }
      const aptScope = await resolveOpsScope(queryFn, 'apartment', nextApartmentId);
      if (!aptScope || aptScope.building_id !== existing.building_id) {
        return res.status(422).json({
          code: 'APARTMENT_BUILDING_MISMATCH',
          message: 'Căn hộ đã chọn không thuộc tòa nhà của nhóm Zalo.',
        });
      }
    }

    const nextName = name !== undefined ? String(name).trim() : existing.name;
    if (!nextName) {
      return res.status(400).json({
        code: 'VALIDATION_ERROR',
        message: 'Tên nhóm Zalo không được để trống.',
      });
    }

    const nextInviteLink =
      invite_link !== undefined ? validateZaloInviteLink(invite_link).normalized : existing.invite_link;
    const nextNote = note !== undefined ? (note?.trim() || null) : existing.note;
    const nextIsActive = is_active !== undefined ? Boolean(is_active) : existing.is_active;

    await client.query('BEGIN');
    txStarted = true;

    const updRes = await client.query(
      `UPDATE zalo_group
       SET scope = $1,
           apartment_id = $2,
           name = $3,
           invite_link = $4,
           note = $5,
           is_active = $6,
           updated_at = NOW()
       WHERE id = $7
       RETURNING *`,
      [nextScope, nextApartmentId, nextName, nextInviteLink, nextNote, nextIsActive, id]
    );
    const updated = updRes.rows[0];

    await client.query(
      `INSERT INTO audit_log (actor_id, action, entity, entity_id, before, after)
       VALUES ($1, 'UPDATE_ZALO_GROUP', 'zalo_group', $2, $3, $4)`,
      [req.user.sub, id, JSON.stringify(existing), JSON.stringify(updated)]
    );

    const enrichedRes = await client.query(
      `SELECT zg.*, b.code AS building_code, b.name AS building_name, a.code AS apartment_code
       FROM zalo_group zg
       JOIN building b ON b.id = zg.building_id
       LEFT JOIN apartment a ON a.id = zg.apartment_id
       WHERE zg.id = $1`,
      [id]
    );

    await client.query('COMMIT');
    txStarted = false;

    res.json({
      message: 'Đã cập nhật nhóm Zalo.',
      data: enrichedRes.rows[0] || updated,
    });
  } catch (err) {
    if (txStarted) {
      await client.query('ROLLBACK').catch(() => {});
    }
    if (err.code === '23505') {
      return res.status(409).json({
        code: 'DUPLICATE_ZALO_GROUP',
        message: 'Tên nhóm Zalo này đã tồn tại trong cùng tòa nhà / căn hộ.',
      });
    }
    console.error('[Update Zalo Group Error]:', err);
    res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi khi cập nhật nhóm Zalo.' });
  } finally {
    await release();
  }
});

/**
 * DELETE /api/v1/zalo-groups/:id (FR-069, PRD 6.2)
 * Xóa nhóm Zalo khỏi danh bạ (chỉ SYS_ADMIN được phép xóa)
 */
router.delete('/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const roles = getUserRoleCodes(req);

  try {
    const scopeRes = await adminPool.query(
      'SELECT id, org_id, building_id FROM zalo_group WHERE id = $1 AND org_id = $2 LIMIT 1',
      [id, req.user.org_id]
    );
    if (scopeRes.rows.length === 0) {
      return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy nhóm Zalo.' });
    }

    if (!roles.includes('SYS_ADMIN')) {
      await logAccessDenied(req, 'zalo_group', id, 'Non-SYS_ADMIN attempted DELETE /zalo-groups/:id');
      return res.status(403).json({
        code: 'DELETE_PROHIBITED',
        message: 'Thao tác xóa không được phép. Chỉ Quản trị viên hệ thống (SYS_ADMIN) mới có quyền xóa nhóm Zalo.',
      });
    }
  } catch (err) {
    if (err.code === '22P02') {
      return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy nhóm Zalo.' });
    }
    console.error('[Delete Zalo Group Scope Error]:', err);
    return res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi khi kiểm tra nhóm Zalo.' });
  }

  const { client, release } = await getUserClient(req);
  let txStarted = false;

  try {
    await client.query('BEGIN');
    txStarted = true;

    const delRes = await client.query(
      'DELETE FROM zalo_group WHERE id = $1 AND org_id = $2 RETURNING *',
      [id, req.user.org_id]
    );
    if (delRes.rows.length === 0) {
      await client.query('ROLLBACK');
      txStarted = false;
      return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy nhóm Zalo.' });
    }
    const deleted = delRes.rows[0];

    await client.query(
      `INSERT INTO audit_log (actor_id, action, entity, entity_id, before)
       VALUES ($1, 'DELETE', 'zalo_group', $2, $3)`,
      [req.user.sub, id, JSON.stringify(deleted)]
    );

    await client.query('COMMIT');
    txStarted = false;

    return res.json({
      message: 'Đã xóa nhóm Zalo khỏi danh bạ.',
      data: deleted,
    });
  } catch (err) {
    if (txStarted) {
      await client.query('ROLLBACK').catch(() => {});
    }
    if (err.code === '22P02') {
      return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy nhóm Zalo.' });
    }
    console.error('[Delete Zalo Group Error]:', err);
    return res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi khi xóa nhóm Zalo.' });
  } finally {
    await release();
  }
});

export default router;
