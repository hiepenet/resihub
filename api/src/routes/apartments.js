import express from 'express';
import { pool } from '../db/client.js';
import { authenticateToken } from '../middleware/auth.js';
import { requireRole } from '../middleware/rbac.js';
import { isTransitionAllowed, APARTMENT_TRANSITIONS } from '../services/apartmentStatus.js';

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
      sql += ` AND a.status = ANY(string_to_array($${params.length}, ','))`;
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
  const { building_id, floor_id, zone_id, code, area_m2, type, bedrooms, base_rent, amenities, note } = req.body;

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

    // Guard tầng phải thuộc cùng tòa (B4)
    if (floor_id) {
      const floorCheck = await pool.query(
        `SELECT 1 FROM floor WHERE id = $1 AND building_id = $2`,
        [floor_id, building_id]
      );
      if (floorCheck.rows.length === 0) {
        return res.status(400).json({
          code: 'FLOOR_MISMATCH',
          message: 'Tầng không thuộc tòa nhà này.',
        });
      }
    }

    // Guard khu phải thuộc cùng tòa (B1)
    if (zone_id) {
      const zoneCheck = await pool.query(
        `SELECT 1 FROM zone WHERE id = $1 AND building_id = $2`,
        [zone_id, building_id]
      );
      if (zoneCheck.rows.length === 0) {
        return res.status(400).json({
          code: 'ZONE_MISMATCH',
          message: 'Khu không thuộc tòa nhà này.',
        });
      }
    }

    const result = await pool.query(
      `INSERT INTO apartment (building_id, zone_id, floor_id, code, area_m2, type, bedrooms, base_rent, status, amenities, note)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'AVAILABLE', $9, $10)
       RETURNING *`,
      [
        building_id,
        zone_id || null,
        floor_id || null,
        code.trim().toUpperCase(),
        area_m2 || 0,
        type || '1PN',
        bedrooms || 1,
        base_rent || 0,
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
  const { status, base_rent, area_m2, amenities, note, zone_id } = req.body;

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

    // Guard: OCCUPIED/RESERVED chỉ được cập nhật tự động qua luồng Hợp đồng / Giữ chỗ (A2/FR-008)
    if (status && ['OCCUPIED', 'RESERVED'].includes(status)) {
      return res.status(409).json({
        code: 'DIRECT_STATUS_CHANGE_PROHIBITED',
        message: 'Không thể tự ý chuyển sang trạng thái Đang thuê hoặc Đã đặt cọc. Trạng thái này được cập nhật tự động qua Hợp đồng và Giữ chỗ.',
      });
    }

    // Guard máy trạng thái (A2): chỉ AVAILABLE <-> MAINTENANCE <-> INACTIVE được đổi qua PATCH
    if (status && !isTransitionAllowed(before.status, status)) {
      return res.status(409).json({
        code: 'INVALID_STATUS_TRANSITION',
        message: `Không thể chuyển căn hộ từ ${before.status} sang ${status}. Các chuyển đổi hợp lệ từ ${before.status}: ${(APARTMENT_TRANSITIONS[before.status] || []).join(', ') || 'không có (phải qua luồng hợp đồng)'}.`,
      });
    }

    // Guard: căn có hợp đồng ACTIVE không được đổi trạng thái, sửa diện tích phải xác nhận (A9)
    const activeContract = await pool.query(
      `SELECT 1 FROM contract WHERE apartment_id = $1 AND status = 'ACTIVE'`,
      [id]
    );
    const hasActiveContract = activeContract.rows.length > 0;

    if (status && hasActiveContract) {
      return res.status(409).json({
        code: 'INVALID_STATUS_TRANSITION',
        message: 'Căn đang có hợp đồng hiệu lực, phải chấm dứt hợp đồng trước.',
      });
    }

    if (
      area_m2 !== undefined &&
      hasActiveContract &&
      Number(area_m2) !== Number(before.area_m2) &&
      req.body.confirm_recalculate_fees !== true
    ) {
      return res.status(409).json({
        code: 'AREA_CHANGE_REQUIRES_CONFIRM',
        message: 'Đang có hợp đồng ACTIVE trên căn này. Sửa diện tích ảnh hưởng phí dịch vụ — gửi kèm confirm_recalculate_fees: true để xác nhận tính lại.',
      });
    }

    // Guard khu phải thuộc cùng tòa của căn (B1)
    if (zone_id) {
      const zoneCheck = await pool.query(
        `SELECT 1 FROM zone WHERE id = $1 AND building_id = $2`,
        [zone_id, before.building_id]
      );
      if (zoneCheck.rows.length === 0) {
        return res.status(400).json({ code: 'ZONE_MISMATCH', message: 'Khu không thuộc tòa nhà này.' });
      }
    }

    const result = await pool.query(
      `UPDATE apartment
       SET status = COALESCE($1, status),
           base_rent = COALESCE($2, base_rent),
           area_m2 = COALESCE($3, area_m2),
           amenities = COALESCE($4, amenities),
           note = COALESCE($5, note),
           zone_id = COALESCE($6, zone_id),
           updated_at = NOW()
       WHERE id = $7
       RETURNING *`,
      [
        status || null,
        base_rent !== undefined ? base_rent : null,
        area_m2 !== undefined ? area_m2 : null,
        amenities ? JSON.stringify(amenities) : null,
        note !== undefined ? note : null,
        zone_id || null,
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

/**
 * PATCH /api/v1/apartments/:id/handover
 * Bàn giao & nghiệm thu phòng (B8 / PRD 7.5): căn MAINTENANCE (sau chấm dứt hợp đồng) về AVAILABLE.
 * Guard: chỉ từ MAINTENANCE, không còn hợp đồng ACTIVE. Cọc còn giữ → cảnh báo, không chặn.
 */
router.patch('/:id/handover', authenticateToken, requireRole(['MANAGER']), async (req, res) => {
  const { id } = req.params;

  try {
    const aptRes = await pool.query(
      `SELECT a.* FROM apartment a
       JOIN user_role ur ON ur.building_id = a.building_id
       WHERE a.id = $1 AND ur.user_id = $2`,
      [id, req.user.sub]
    );
    if (aptRes.rows.length === 0) {
      return res.status(403).json({ code: 'ACCESS_DENIED', message: 'Bạn không có quyền quản lý căn hộ này.' });
    }

    const before = aptRes.rows[0];
    if (before.status !== 'MAINTENANCE') {
      return res.status(409).json({
        code: 'INVALID_STATUS',
        message: `Chỉ căn hộ đang bảo trì (MAINTENANCE) mới cần bàn giao. Căn hiện ở trạng thái ${before.status}.`,
      });
    }

    const activeContract = await pool.query(
      `SELECT 1 FROM contract WHERE apartment_id = $1 AND status = 'ACTIVE'`,
      [id]
    );
    if (activeContract.rows.length > 0) {
      return res.status(409).json({
        code: 'ACTIVE_CONTRACT_EXISTS',
        message: 'Căn đang có hợp đồng hiệu lực, phải chấm dứt hợp đồng trước khi bàn giao.',
      });
    }

    const warnings = [];
    const heldDeposit = await pool.query(
      `SELECT 1 FROM deposit WHERE contract_id IN (
         SELECT id FROM contract WHERE apartment_id = $1
       ) AND status = 'HELD' LIMIT 1`,
      [id]
    );
    if (heldDeposit.rows.length > 0) {
      warnings.push('Còn cọc đang giữ chưa tất toán. Hãy hoàn tất tất toán theo FR-024.');
    }

    const result = await pool.query(
      `UPDATE apartment SET status = 'AVAILABLE', updated_at = NOW() WHERE id = $1 RETURNING *`,
      [id]
    );
    await pool.query(
      `INSERT INTO audit_log (actor_id, action, entity, entity_id, before, after)
       VALUES ($1, 'HANDOVER', 'apartment', $2, $3, $4)`,
      [req.user.sub, id, JSON.stringify(before), JSON.stringify(result.rows[0])]
    );

    res.json({ message: 'Bàn giao và nghiệm thu phòng thành công. Căn hộ sẵn sàng kinh doanh.', data: result.rows[0], warnings });
  } catch (err) {
    console.error('[Handover Apartment Error]:', err);
    res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi bàn giao căn hộ.' });
  }
});

export default router;
