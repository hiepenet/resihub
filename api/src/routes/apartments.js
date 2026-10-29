import express from 'express';
import { pool, adminPool } from '../db/client.js';
import { authenticateToken } from '../middleware/auth.js';
import { requireRole } from '../middleware/rbac.js';
import { isTransitionAllowed, APARTMENT_TRANSITIONS } from '../services/apartmentStatus.js';
import {
  getUserRoleCodes,
  getOwnerBuildingIds,
  getManagerBuildingIds,
  ownerBuildingFilter,
  managerBuildingFilter,
  logAccessDenied,
} from '../services/ownerScope.js';

const router = express.Router();

/**
 * GET /api/v1/apartments
 * - SYS_ADMIN: Xem toàn bộ căn hộ trong tổ chức (CRUD)
 * - OWNER: Xem căn hộ thuộc các tòa mình sở hữu (R)
 * - MANAGER: Xem căn hộ thuộc tòa được phân công quản lý (CRU)
 * - RESIDENT: Xem căn hộ của chính mình (R)
 * - AC-019.1: Truy cập building_id ngoài phạm vi trả 403 + ghi audit_log
 */
router.get('/', authenticateToken, async (req, res) => {
  const { building_id, status } = req.query;
  const orgId = req.user.org_id;
  const userRoleCodes = getUserRoleCodes(req);
  const isSysAdmin = userRoleCodes.includes('SYS_ADMIN');
  const isOwner = userRoleCodes.includes('OWNER');
  const isManager = userRoleCodes.includes('MANAGER');
  const isResident = userRoleCodes.includes('RESIDENT');

  try {
    // Kiểm tra quyền trên building_id truyền trực tiếp qua URL query (AC-019.1)
    if (building_id) {
      if (isOwner && !isSysAdmin) {
        const ownedIds = await getOwnerBuildingIds(req.user.sub, orgId);
        if (!ownedIds.includes(building_id)) {
          await logAccessDenied(req, 'building', building_id, 'OWNER queried apartments of unowned building');
          return res.status(403).json({
            code: 'ACCESS_DENIED',
            message: 'Bạn không sở hữu tòa nhà này.',
          });
        }
      } else if (isManager && !isSysAdmin) {
        const mgrIds = await getManagerBuildingIds(req.user.sub, orgId);
        if (!mgrIds.includes(building_id)) {
          await logAccessDenied(req, 'building', building_id, 'MANAGER queried apartments of unassigned building (AC-019.1)');
          return res.status(403).json({
            code: 'ACCESS_DENIED',
            message: 'Bạn không có quyền quản lý tòa nhà này.',
          });
        }
      }
    }

    let sql = `
      SELECT a.*, b.name as building_name, b.code as building_code, f.name as floor_name, z.name as zone_name, z.code as zone_code
      FROM apartment a
      JOIN building b ON b.id = a.building_id
      LEFT JOIN floor f ON f.id = a.floor_id
      LEFT JOIN zone z ON z.id = a.zone_id
      WHERE b.org_id = $1
    `;
    const params = [orgId];

    if (isSysAdmin) {
      // SYS_ADMIN: Toàn bộ căn hộ thuộc org
    } else if (isOwner) {
      const { sql: ownerSql } = await ownerBuildingFilter('a.building_id', req.user.sub, orgId, params);
      sql += ownerSql;
    } else if (isManager) {
      const { sql: mgrSql } = await managerBuildingFilter('a.building_id', req.user.sub, orgId, params);
      sql += mgrSql;
    } else if (isResident) {
      params.push(req.user.person_id);
      sql += ` AND a.id IN (
        SELECT c.apartment_id FROM contract c
        JOIN tenant t ON t.id = c.primary_tenant_id
        WHERE t.person_id = $${params.length}
      )`;
    } else {
      return res.json({ data: [] });
    }

    if (building_id) {
      params.push(building_id);
      sql += ` AND a.building_id = $${params.length}`;
    }

    if (status) {
      params.push(status);
      sql += ` AND a.status = ANY(string_to_array($${params.length}, ','))`;
    }

    sql += ` ORDER BY b.code ASC, a.code ASC`;

    const result = await pool.query(sql, params);
    res.json({ data: result.rows });
  } catch (err) {
    console.error('[Apartments Error]:', err);
    res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi khi lấy danh sách căn hộ.' });
  }
});

/**
 * POST /api/v1/apartments
 * Quyền theo PRD 6.2: SYS_ADMIN (CRUD toàn org) hoặc MANAGER (CRU trên tòa được gán). OWNER chỉ có R.
 */
router.post('/', authenticateToken, requireRole(['SYS_ADMIN', 'MANAGER']), async (req, res) => {
  const { building_id, floor_id, zone_id, code, area_m2, type, bedrooms, base_rent, amenities, note } = req.body;
  const roleCodes = getUserRoleCodes(req);
  const isSysAdmin = roleCodes.includes('SYS_ADMIN');

  if (!building_id || !code) {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Tòa nhà và mã phòng là bắt buộc.' });
  }

  if (base_rent !== undefined && base_rent < 0) {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Giá thuê không được âm.' });
  }

  try {
    const bCheck = await adminPool.query('SELECT id FROM building WHERE id = $1 AND org_id = $2', [building_id, req.user.org_id]);
    if (bCheck.rows.length === 0) {
      return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy tòa nhà.' });
    }

    if (!isSysAdmin) {
      const mgrIds = await getManagerBuildingIds(req.user.sub, req.user.org_id);
      if (!mgrIds.includes(building_id)) {
        await logAccessDenied(req, 'building', building_id, 'MANAGER attempted to create apartment in unassigned building');
        return res.status(403).json({
          code: 'ACCESS_DENIED',
          message: 'Bạn không có quyền quản lý tòa nhà này để tạo căn hộ.',
        });
      }
    }

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

    await pool.query(
      `INSERT INTO audit_log (actor_id, action, entity, entity_id, after)
       VALUES ($1, 'CREATE', 'apartment', $2, $3)`,
      [req.user.sub, result.rows[0].id, JSON.stringify(result.rows[0])]
    );

    res.status(201).json({ message: 'Tạo căn hộ thành công.', data: result.rows[0] });
  } catch (err) {
    if (err.code === '23505') {
      let suggestion = '';
      try {
        const last = await pool.query(
          `SELECT code FROM apartment WHERE building_id = $1 ORDER BY code DESC LIMIT 1`,
          [building_id]
        );
        if (last.rows.length > 0) {
          const m = last.rows[0].code.match(/^(.*?)(\d+)$/);
          if (m) suggestion = ` Gợi ý mã kế tiếp: ${m[1]}${parseInt(m[2], 10) + 1}.`;
        }
      } catch {
        // gợi ý là phụ
      }
      return res.status(409).json({ code: 'DUPLICATE_CODE', message: `Mã căn "${code}" đã tồn tại trong tòa nhà này.${suggestion}` });
    }
    console.error('[Create Apartment Error]:', err);
    res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi máy chủ khi tạo căn hộ.' });
  }
});

/**
 * PATCH /api/v1/apartments/:id
 * Quyền: SYS_ADMIN hoặc MANAGER của tòa nhà đó (CRU).
 */
router.patch('/:id', authenticateToken, requireRole(['SYS_ADMIN', 'MANAGER']), async (req, res) => {
  const { id } = req.params;
  const { status, base_rent, area_m2, amenities, note, zone_id } = req.body;
  const roleCodes = getUserRoleCodes(req);
  const isSysAdmin = roleCodes.includes('SYS_ADMIN');

  try {
    const aptExist = await adminPool.query(
      `SELECT a.* FROM apartment a
       JOIN building b ON b.id = a.building_id
       WHERE a.id = $1 AND b.org_id = $2`,
      [id, req.user.org_id]
    );
    if (aptExist.rows.length === 0) {
      return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy căn hộ.' });
    }

    const before = aptExist.rows[0];

    if (!isSysAdmin) {
      const mgrIds = await getManagerBuildingIds(req.user.sub, req.user.org_id);
      if (!mgrIds.includes(before.building_id)) {
        await logAccessDenied(req, 'apartment', id, 'MANAGER attempted to update apartment in unassigned building');
        return res.status(403).json({
          code: 'ACCESS_DENIED',
          message: 'Bạn không có quyền quản lý căn hộ này.',
        });
      }
    }

    if (status && ['OCCUPIED', 'RESERVED'].includes(status)) {
      return res.status(409).json({
        code: 'DIRECT_STATUS_CHANGE_PROHIBITED',
        message: 'Không thể tự ý chuyển sang trạng thái Đang thuê hoặc Đã đặt cọc. Trạng thái này được cập nhật tự động qua Hợp đồng và Giữ chỗ.',
      });
    }

    if (status && !isTransitionAllowed(before.status, status)) {
      return res.status(409).json({
        code: 'INVALID_STATUS_TRANSITION',
        message: `Không thể chuyển căn hộ từ ${before.status} sang ${status}. Các chuyển đổi hợp lệ từ ${before.status}: ${(APARTMENT_TRANSITIONS[before.status] || []).join(', ') || 'không có (phải qua luồng hợp đồng)'}.`,
      });
    }

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
 * Quyền theo PRD 6.2: Chỉ SYS_ADMIN được xóa căn hộ chưa phát sinh hợp đồng / giữ chỗ.
 */
router.delete('/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const roleCodes = getUserRoleCodes(req);

  if (!roleCodes.includes('SYS_ADMIN')) {
    await logAccessDenied(req, 'apartment', id, 'Non-SYS_ADMIN attempted to delete apartment');
    return res.status(403).json({
      code: 'DELETE_PROHIBITED',
      message: 'Thao tác xóa không được phép. Quyền của Quản lý là CRU (Tạo, Xem, Sửa), không được Xóa căn hộ.',
    });
  }

  try {
    const hasHistory = await pool.query(
      `SELECT 1 FROM contract WHERE apartment_id = $1
       UNION ALL
       SELECT 1 FROM reservation WHERE apartment_id = $1
       LIMIT 1`,
      [id]
    );
    if (hasHistory.rows.length > 0) {
      return res.status(409).json({
        code: 'APARTMENT_HAS_HISTORY',
        message: 'Không thể xóa căn hộ đã từng phát sinh hợp đồng hoặc giữ chỗ. Vui lòng chuyển sang trạng thái INACTIVE.',
      });
    }

    const delRes = await pool.query('DELETE FROM apartment WHERE id = $1 RETURNING *', [id]);
    if (delRes.rows.length === 0) {
      return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy căn hộ.' });
    }

    await pool.query(
      `INSERT INTO audit_log (actor_id, action, entity, entity_id, before)
       VALUES ($1, 'DELETE', 'apartment', $2, $3)`,
      [req.user.sub, id, JSON.stringify(delRes.rows[0])]
    );

    return res.json({ message: 'Đã xóa căn hộ thành công.', data: delRes.rows[0] });
  } catch (err) {
    console.error('[Delete Apartment Error]:', err);
    return res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi xóa căn hộ.' });
  }
});

/**
 * PATCH /api/v1/apartments/:id/handover
 * Bàn giao & nghiệm thu phòng (B8 / PRD 7.5): căn MAINTENANCE (sau chấm dứt hợp đồng) về AVAILABLE.
 */
router.patch('/:id/handover', authenticateToken, requireRole(['SYS_ADMIN', 'MANAGER']), async (req, res) => {
  const { id } = req.params;
  const roleCodes = getUserRoleCodes(req);
  const isSysAdmin = roleCodes.includes('SYS_ADMIN');

  try {
    const aptExist = await adminPool.query(
      `SELECT a.* FROM apartment a
       JOIN building b ON b.id = a.building_id
       WHERE a.id = $1 AND b.org_id = $2`,
      [id, req.user.org_id]
    );
    if (aptExist.rows.length === 0) {
      return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy căn hộ.' });
    }
    const before = aptExist.rows[0];

    if (!isSysAdmin) {
      const mgrIds = await getManagerBuildingIds(req.user.sub, req.user.org_id);
      if (!mgrIds.includes(before.building_id)) {
        await logAccessDenied(req, 'apartment', id, 'MANAGER attempted handover in unassigned building');
        return res.status(403).json({ code: 'ACCESS_DENIED', message: 'Bạn không có quyền quản lý căn hộ này.' });
      }
    }

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
