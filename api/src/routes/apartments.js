import express from 'express';
import { pool } from '../db/client.js';
import { authenticateToken } from '../middleware/auth.js';
import { requireRole } from '../middleware/rbac.js';

const router = express.Router();

/**
 * GET /api/v1/apartments
 * - OWNER: Xem toàn bộ căn hộ trong tổ chức (R)
 * - MANAGER: Xem các căn hộ thuộc các tòa do mình quản lý (CRU)
 * - RESIDENT: Xem căn hộ của chính mình (R)
 */
router.get('/', authenticateToken, async (req, res) => {
  const { building_id, status } = req.query;
  const orgId = req.user.org_id;
  const userRoleCodes = (req.user.roles || []).map((r) => (typeof r === 'string' ? r : r.code));
  const isOwner = userRoleCodes.includes('OWNER');
  const isManager = userRoleCodes.includes('MANAGER');
  const isResident = userRoleCodes.includes('RESIDENT');

  try {
    let sql = `
      SELECT a.*, b.name as building_name, f.name as floor_name
      FROM apartment a
      JOIN building b ON b.id = a.building_id
      LEFT JOIN floor f ON f.id = a.floor_id
      WHERE b.org_id = $1
    `;
    const params = [orgId];

    if (isManager && !isOwner) {
      // MANAGER: Chỉ xem căn hộ thuộc tòa mình quản lý
      params.push(req.user.sub);
      sql += ` AND a.building_id IN (
        SELECT building_id FROM user_role WHERE user_id = $${params.length} AND building_id IS NOT NULL
      )`;
    } else if (isResident && !isOwner && !isManager) {
      // RESIDENT: Chỉ xem căn hộ mình đang thuê
      params.push(req.user.person_id);
      sql += ` AND a.id IN (
        SELECT c.apartment_id FROM contract c
        JOIN tenant t ON t.id = c.primary_tenant_id
        WHERE t.person_id = $${params.length}
      )`;
    }

    if (building_id) {
      params.push(building_id);
      sql += ` AND a.building_id = $${params.length}`;
    }

    if (status) {
      params.push(status);
      sql += ` AND a.status = $${params.length}`;
    }

    sql += ` ORDER BY a.code ASC`;

    const result = await pool.query(sql, params);
    res.json({ data: result.rows });
  } catch (err) {
    console.error('[Apartments Error]:', err);
    res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi khi lấy danh sách căn hộ.' });
  }
});

/**
 * POST /api/v1/apartments
 * Quyền: Chỉ MANAGER có quyền tạo căn hộ trên tòa mình quản lý (CRU). OWNER có quyền R (bị chặn).
 */
router.post('/', authenticateToken, requireRole(['MANAGER']), async (req, res) => {
  const { building_id, floor_id, code, area_m2, type, bedrooms, base_rent, status, amenities, note } = req.body;

  if (!building_id || !code) {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Tòa nhà và mã phòng là bắt buộc.' });
  }

  if (base_rent !== undefined && base_rent < 0) {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Giá thuê không được âm.' });
  }

  try {
    // Kiểm tra quyền quản lý tòa nhà của Manager
    const checkMgr = await pool.query(
      `SELECT 1 FROM user_role WHERE user_id = $1 AND building_id = $2`,
      [req.user.sub, building_id]
    );
    if (checkMgr.rows.length === 0) {
      return res.status(403).json({
        code: 'ACCESS_DENIED',
        message: 'Bạn không có quyền quản lý tòa nhà này để tạo căn hộ.',
      });
    }

    const result = await pool.query(
      `INSERT INTO apartment (building_id, floor_id, code, area_m2, type, bedrooms, base_rent, status, amenities, note)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [
        building_id,
        floor_id || null,
        code.trim().toUpperCase(),
        area_m2 || 0,
        type || '1PN',
        bedrooms || 1,
        base_rent || 0,
        status || 'AVAILABLE',
        JSON.stringify(amenities || {}),
        note || '',
      ]
    );

    // Audit log
    await pool.query(
      `INSERT INTO audit_log (actor_id, action, entity, entity_id, after)
       VALUES ($1, 'CREATE', 'apartment', $2, $3)`,
      [req.user.sub, result.rows[0].id, JSON.stringify(result.rows[0])]
    );

    res.status(201).json({ message: 'Tạo căn hộ thành công.', data: result.rows[0] });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ code: 'DUPLICATE_CODE', message: `Mã căn "${code}" đã tồn tại trong tòa nhà này.` });
    }
    console.error('[Create Apartment Error]:', err);
    res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi máy chủ khi tạo căn hộ.' });
  }
});

/**
 * PATCH /api/v1/apartments/:id
 * Quyền: Chỉ MANAGER có quyền cập nhật căn hộ thuộc tòa mình quản lý (CRU).
 */
router.patch('/:id', authenticateToken, requireRole(['MANAGER']), async (req, res) => {
  const { id } = req.params;
  const { status, base_rent, area_m2, amenities, note } = req.body;

  try {
    // Kiểm tra căn hộ có thuộc tòa nhà do Manager này quản lý không
    const aptRes = await pool.query(
      `SELECT a.* FROM apartment a
       JOIN user_role ur ON ur.building_id = a.building_id
       WHERE a.id = $1 AND ur.user_id = $2`,
      [id, req.user.sub]
    );

    if (aptRes.rows.length === 0) {
      return res.status(403).json({
        code: 'ACCESS_DENIED',
        message: 'Bạn không có quyền quản lý căn hộ này.',
      });
    }

    const before = aptRes.rows[0];

    const result = await pool.query(
      `UPDATE apartment
       SET status = COALESCE($1, status),
           base_rent = COALESCE($2, base_rent),
           area_m2 = COALESCE($3, area_m2),
           amenities = COALESCE($4, amenities),
           note = COALESCE($5, note),
           updated_at = NOW()
       WHERE id = $6
       RETURNING *`,
      [
        status || null,
        base_rent !== undefined ? base_rent : null,
        area_m2 !== undefined ? area_m2 : null,
        amenities ? JSON.stringify(amenities) : null,
        note !== undefined ? note : null,
        id,
      ]
    );

    // Audit log
    await pool.query(
      `INSERT INTO audit_log (actor_id, action, entity, entity_id, before, after)
       VALUES ($1, 'UPDATE', 'apartment', $2, $3, $4)`,
      [req.user.sub, id, JSON.stringify(before), JSON.stringify(result.rows[0])]
    );

    res.json({ message: 'Cập nhật căn hộ thành công.', data: result.rows[0] });
  } catch (err) {
    console.error('[Update Apartment Error]:', err);
    res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi cập nhật căn hộ.' });
  }
});

/**
 * DELETE /api/v1/apartments/:id
 * Quyền: Bị chặn (Manager CRU không xóa)
 */
router.delete('/:id', authenticateToken, async (req, res) => {
  return res.status(403).json({
    code: 'DELETE_PROHIBITED',
    message: 'Thao tác xóa không được phép. Quyền của Quản lý là CRU (Tạo, Xem, Sửa), không được Xóa căn hộ.',
  });
});

export default router;
