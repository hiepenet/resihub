import express from 'express';
import { pool } from '../db/client.js';
import { authenticateToken } from '../middleware/auth.js';
import { requireRole } from '../middleware/rbac.js';

const router = express.Router();

/**
 * GET /api/v1/buildings
 * Lấy danh sách tòa nhà theo quyền của user
 */
router.get('/', authenticateToken, async (req, res) => {
  try {
    const orgId = req.user.org_id;
    const result = await pool.query(
      `SELECT b.*, 
        (SELECT COUNT(*) FROM apartment a WHERE a.building_id = b.id) as total_apartments,
        (SELECT COUNT(*) FROM apartment a WHERE a.building_id = b.id AND a.status = 'AVAILABLE') as available_apartments,
        (SELECT COUNT(*) FROM apartment a WHERE a.building_id = b.id AND a.status = 'OCCUPIED') as occupied_apartments
       FROM building b
       WHERE b.org_id = $1
       ORDER BY b.created_at DESC`,
      [orgId]
    );

    res.json({ data: result.rows });
  } catch (err) {
    console.error('[Buildings Error]:', err);
    res.status(500).json({ code: 'DB_ERROR', message: 'Không thể lấy danh sách tòa nhà.' });
  }
});

/**
 * POST /api/v1/buildings
 * Tạo mới tòa nhà
 */
router.post('/', authenticateToken, requireRole(['OWNER', 'MANAGER', 'SYS_ADMIN']), async (req, res) => {
  const { name, code, address, timezone, lease_terms } = req.body;

  if (!name || !code) {
    return res.status(400).json({
      code: 'VALIDATION_ERROR',
      message: 'Tên và mã tòa nhà là bắt buộc.',
    });
  }

  try {
    const orgId = req.user.org_id;
    const checkDup = await pool.query('SELECT id FROM building WHERE org_id = $1 AND code = $2', [orgId, code]);
    if (checkDup.rows.length > 0) {
      return res.status(409).json({
        code: 'DUPLICATE_CODE',
        message: `Mã tòa nhà "${code}" đã tồn tại trong tổ chức.`,
      });
    }

    const result = await pool.query(
      `INSERT INTO building (org_id, name, code, address, timezone, lease_terms, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'ACTIVE')
       RETURNING *`,
      [
        orgId,
        name,
        code.toUpperCase(),
        address || '',
        timezone || 'Asia/Ho_Chi_Minh',
        JSON.stringify(lease_terms || {}),
      ]
    );

    // Ghi audit log
    await pool.query(
      `INSERT INTO audit_log (actor_id, action, entity, entity_id, after)
       VALUES ($1, 'CREATE', 'building', $2, $3)`,
      [req.user.sub, result.rows[0].id, JSON.stringify(result.rows[0])]
    );

    res.status(201).json({
      message: 'Tạo tòa nhà thành công.',
      data: result.rows[0],
    });
  } catch (err) {
    console.error('[Create Building Error]:', err);
    res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi máy chủ khi tạo tòa nhà.' });
  }
});

/**
 * GET /api/v1/buildings/:id
 */
router.get('/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query('SELECT * FROM building WHERE id = $1', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy tòa nhà.' });
    }
    res.json({ data: result.rows[0] });
  } catch (err) {
    res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi truy vấn.' });
  }
});

/**
 * GET /api/v1/buildings/:id/floor-map
 * Lấy sơ đồ tầng và căn hộ (FR-010)
 */
router.get('/:id/floor-map', authenticateToken, async (req, res) => {
  const { id } = req.params;
  try {
    const floorsRes = await pool.query(
      'SELECT * FROM floor WHERE building_id = $1 ORDER BY level DESC',
      [id]
    );

    const apartmentsRes = await pool.query(
      'SELECT * FROM apartment WHERE building_id = $1 ORDER BY code ASC',
      [id]
    );

    const floorMap = floorsRes.rows.map((floor) => {
      return {
        ...floor,
        apartments: apartmentsRes.rows.filter((apt) => apt.floor_id === floor.id),
      };
    });

    res.json({ data: floorMap });
  } catch (err) {
    console.error('[Floor Map Error]:', err);
    res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi khi tải sơ đồ tầng.' });
  }
});

/**
 * POST /api/v1/buildings/:id/floors
 */
router.post('/:id/floors', authenticateToken, requireRole(['OWNER', 'MANAGER', 'SYS_ADMIN']), async (req, res) => {
  const { id } = req.params;
  const { level, name } = req.body;

  if (level === undefined || level === null) {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Số tầng (level) là bắt buộc.' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO floor (building_id, level, name)
       VALUES ($1, $2, $3)
       ON CONFLICT (building_id, level) DO UPDATE SET name = EXCLUDED.name
       RETURNING *`,
      [id, parseInt(level, 10), name || `Tầng ${level}`]
    );

    res.status(201).json({ data: result.rows[0] });
  } catch (err) {
    res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi khi tạo tầng.' });
  }
});

export default router;
