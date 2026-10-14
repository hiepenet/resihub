import express from 'express';
import { pool } from '../db/client.js';
import { authenticateToken } from '../middleware/auth.js';
import { requireRole } from '../middleware/rbac.js';

const router = express.Router();

/**
 * GET /api/v1/apartments
 */
router.get('/', authenticateToken, async (req, res) => {
  const { building_id, status } = req.query;

  try {
    let sql = `
      SELECT a.*, b.name as building_name, f.name as floor_name
      FROM apartment a
      JOIN building b ON b.id = a.building_id
      LEFT JOIN floor f ON f.id = a.floor_id
      WHERE b.org_id = $1
    `;
    const params = [req.user.org_id];

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
 */
router.post('/', authenticateToken, requireRole(['OWNER', 'MANAGER', 'SYS_ADMIN']), async (req, res) => {
  const { building_id, floor_id, code, area_m2, type, bedrooms, base_rent, status, amenities, note } = req.body;

  if (!building_id || !code) {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Tòa nhà và mã phòng là bắt buộc.' });
  }

  if (base_rent !== undefined && base_rent < 0) {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Giá thuê không được âm.' });
  }

  try {
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
 */
router.patch('/:id', authenticateToken, requireRole(['OWNER', 'MANAGER', 'SYS_ADMIN']), async (req, res) => {
  const { id } = req.params;
  const { status, base_rent, area_m2, amenities, note } = req.body;

  try {
    const beforeRes = await pool.query('SELECT * FROM apartment WHERE id = $1', [id]);
    if (beforeRes.rows.length === 0) {
      return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy căn hộ.' });
    }
    const before = beforeRes.rows[0];

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

export default router;
