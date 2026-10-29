import express from 'express';
import { pool, adminPool, getUserClient } from '../db/client.js';
import { authenticateToken } from '../middleware/auth.js';
import { requireRole } from '../middleware/rbac.js';
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
 * GET /api/v1/reservations
 * Quyền theo PRD 6.2 & FR-067: SYS_ADMIN (R), OWNER (R trên tòa sở hữu), MANAGER (CRU trên tòa quản lý)
 */
router.get('/', authenticateToken, requireRole(['SYS_ADMIN', 'OWNER', 'MANAGER']), async (req, res) => {
  try {
    const orgId = req.user.org_id;
    const { building_id, status } = req.query;
    const userRoles = getUserRoleCodes(req);
    const isSysAdmin = userRoles.includes('SYS_ADMIN');
    const isOwner = userRoles.includes('OWNER');
    const isManager = userRoles.includes('MANAGER');

    if (building_id && !isSysAdmin) {
      if (isOwner) {
        const ownedIds = await getOwnerBuildingIds(req.user.sub, orgId);
        if (!ownedIds.includes(building_id)) {
          await logAccessDenied(req, 'building', building_id, 'OWNER queried reservations of unowned building');
          return res.status(403).json({ code: 'ACCESS_DENIED', message: 'Bạn không sở hữu tòa nhà này.' });
        }
      } else if (isManager) {
        const mgrIds = await getManagerBuildingIds(req.user.sub, orgId);
        if (!mgrIds.includes(building_id)) {
          await logAccessDenied(req, 'building', building_id, 'MANAGER queried reservations of unassigned building');
          return res.status(403).json({ code: 'ACCESS_DENIED', message: 'Bạn không có quyền quản lý tòa nhà này.' });
        }
      }
    }

    let sql = `
      SELECT r.*, 
        a.code as apartment_code, 
        a.area_m2 as apartment_area,
        b.name as building_name,
        b.code as building_code,
        u.id IS NOT NULL as has_creator,
        p_u.email as created_by_email
      FROM reservation r
      JOIN apartment a ON a.id = r.apartment_id
      JOIN building b ON b.id = r.building_id
      LEFT JOIN app_user u ON u.id = r.created_by
      LEFT JOIN person p_u ON p_u.id = u.person_id
      WHERE r.org_id = $1
    `;
    const params = [orgId];

    if (isSysAdmin) {
      // SYS_ADMIN: Toàn bộ org
    } else if (isOwner) {
      const { sql: ownerSql } = await ownerBuildingFilter('r.building_id', req.user.sub, orgId, params);
      sql += ownerSql;
    } else if (isManager) {
      const { sql: mgrSql } = await managerBuildingFilter('r.building_id', req.user.sub, orgId, params);
      sql += mgrSql;
    }

    if (building_id) {
      params.push(building_id);
      sql += ` AND r.building_id = $${params.length}`;
    }

    if (status) {
      params.push(status);
      sql += ` AND r.status = $${params.length}`;
    }

    sql += ` ORDER BY r.created_at DESC`;

    const result = await pool.query(sql, params);
    res.json({ data: result.rows });
  } catch (err) {
    console.error('[Get Reservations Error]:', err);
    res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi khi lấy danh sách đặt cọc giữ chỗ.' });
  }
});

/**
 * POST /api/v1/reservations
 * Tạo đặt cọc giữ chỗ cho khách tiềm năng (NV-06 / FR-067)
 * Quyền theo PRD 6.2 & FR-067: Chỉ MANAGER của tòa chứa căn hộ (OWNER là R)
 */
router.post('/', authenticateToken, requireRole(['MANAGER']), async (req, res) => {
  const { apartment_id, prospect_name, phone, hold_amount, hold_until, note } = req.body;
  const orgId = req.user.org_id;

  if (!apartment_id || !prospect_name || !phone) {
    return res.status(400).json({
      code: 'VALIDATION_ERROR',
      message: 'Căn hộ, tên khách và số điện thoại là bắt buộc.',
    });
  }

  if (!hold_until) {
    return res.status(400).json({
      code: 'VALIDATION_ERROR',
      message: 'Thời hạn giữ chỗ (hold_until) là bắt buộc.',
    });
  }
  const holdUntilDate = new Date(hold_until);
  const nowDate = new Date();
  if (isNaN(holdUntilDate.getTime()) || holdUntilDate <= nowDate) {
    return res.status(400).json({
      code: 'INVALID_HOLD_DATE',
      message: 'Thời hạn giữ chỗ phải là một ngày hợp lệ trong tương lai.',
    });
  }
  const maxHoldDate = new Date(nowDate.getTime() + 30 * 24 * 60 * 60 * 1000);
  if (holdUntilDate > maxHoldDate) {
    return res.status(400).json({
      code: 'HOLD_DURATION_EXCEEDED',
      message: 'Thời hạn giữ chỗ tối đa không quá 30 ngày theo quy định.',
    });
  }

  const { client, release } = await getUserClient(req);
  try {
    const aptExist = await adminPool.query(
      `SELECT a.*, b.org_id
       FROM apartment a JOIN building b ON b.id = a.building_id
       WHERE a.id = $1 AND b.org_id = $2`,
      [apartment_id, orgId]
    );
    if (aptExist.rows.length === 0) {
      return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy căn hộ.' });
    }
    const apt = aptExist.rows[0];

    const mgrIds = await getManagerBuildingIds(req.user.sub, orgId);
    if (!mgrIds.includes(apt.building_id)) {
      await logAccessDenied(req, 'building', apt.building_id, 'MANAGER attempted reservation on unassigned building');
      return res.status(403).json({
        code: 'FORBIDDEN_BUILDING',
        message: 'Bạn không có quyền quản lý tòa nhà chứa căn hộ này.',
      });
    }

    await client.query('BEGIN');

    const aptLock = await client.query('SELECT * FROM apartment WHERE id = $1 FOR UPDATE', [apartment_id]);
    if (aptLock.rows[0].status !== 'AVAILABLE') {
      await client.query('ROLLBACK');
      return res.status(409).json({
        code: 'APARTMENT_NOT_AVAILABLE',
        message: `Căn hộ ${apt.code} đang ở trạng thái ${aptLock.rows[0].status}, không thể đặt cọc giữ chỗ.`,
      });
    }

    const resResult = await client.query(
      `INSERT INTO reservation (
        org_id, building_id, apartment_id, prospect_name, phone, hold_amount, hold_until, status, note, created_by
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'HELD', $8, $9)
      RETURNING *`,
      [
        orgId,
        apt.building_id,
        apartment_id,
        prospect_name.trim(),
        phone.trim(),
        hold_amount || 0,
        hold_until,
        note || '',
        req.user.sub,
      ]
    );

    const reservation = resResult.rows[0];

    await client.query(
      `UPDATE apartment SET status = 'RESERVED', updated_at = NOW() WHERE id = $1`,
      [apartment_id]
    );

    await client.query(
      `INSERT INTO audit_log (actor_id, action, entity, entity_id, after)
       VALUES ($1, 'CREATE', 'reservation', $2, $3)`,
      [req.user.sub, reservation.id, JSON.stringify(reservation)]
    );

    await client.query('COMMIT');
    res.status(201).json({
      message: `Đã đặt cọc giữ chỗ căn ${apt.code} cho khách ${prospect_name} thành công.`,
      data: reservation,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[Create Reservation Error]:', err);
    res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi máy chủ khi đặt cọc giữ chỗ.' });
  } finally {
    await release();
  }
});

/**
 * PATCH /api/v1/reservations/:id/convert
 */
router.patch('/:id/convert', authenticateToken, requireRole(['MANAGER']), async (req, res) => {
  const { id } = req.params;
  const { client, release } = await getUserClient(req);
  try {
    const rsvExist = await adminPool.query('SELECT * FROM reservation WHERE id = $1 AND org_id = $2', [id, req.user.org_id]);
    if (rsvExist.rows.length === 0) {
      return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy hồ sơ giữ chỗ.' });
    }
    const mgrIds = await getManagerBuildingIds(req.user.sub, req.user.org_id);
    if (!mgrIds.includes(rsvExist.rows[0].building_id)) {
      await logAccessDenied(req, 'reservation', id, 'MANAGER attempted reservation convert on unassigned building');
      return res.status(403).json({
        code: 'FORBIDDEN_BUILDING',
        message: 'Bạn không có quyền thao tác trên tòa nhà của hồ sơ giữ chỗ này.',
      });
    }

    await client.query('BEGIN');

    const resCheck = await client.query('SELECT * FROM reservation WHERE id = $1 FOR UPDATE', [id]);
    const currentRes = resCheck.rows[0];

    if (currentRes.status !== 'HELD') {
      await client.query('ROLLBACK');
      return res.status(400).json({
        code: 'INVALID_STATUS',
        message: `Hồ sơ giữ chỗ đang ở trạng thái ${currentRes.status}, không thể chuyển đổi.`,
      });
    }

    const updated = await client.query(
      `UPDATE reservation SET status = 'CONVERTED', updated_at = NOW() WHERE id = $1 RETURNING *`,
      [id]
    );

    await client.query(
      `INSERT INTO audit_log (actor_id, action, entity, entity_id, before, after)
       VALUES ($1, 'UPDATE', 'reservation', $2, $3, $4)`,
      [req.user.sub, id, JSON.stringify(currentRes), JSON.stringify(updated.rows[0])]
    );

    await client.query('COMMIT');
    res.json({ message: 'Đã chuyển cọc giữ chỗ sang hợp đồng.', data: updated.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[Convert Reservation Error]:', err);
    res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi khi chuyển đổi cọc giữ chỗ.' });
  } finally {
    await release();
  }
});

/**
 * PATCH /api/v1/reservations/:id/forfeit
 */
router.patch('/:id/forfeit', authenticateToken, requireRole(['MANAGER']), async (req, res) => {
  const { id } = req.params;
  const { client, release } = await getUserClient(req);
  try {
    const rsvExist = await adminPool.query('SELECT * FROM reservation WHERE id = $1 AND org_id = $2', [id, req.user.org_id]);
    if (rsvExist.rows.length === 0) {
      return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy hồ sơ giữ chỗ.' });
    }
    const mgrIds = await getManagerBuildingIds(req.user.sub, req.user.org_id);
    if (!mgrIds.includes(rsvExist.rows[0].building_id)) {
      await logAccessDenied(req, 'reservation', id, 'MANAGER attempted reservation forfeit on unassigned building');
      return res.status(403).json({
        code: 'FORBIDDEN_BUILDING',
        message: 'Bạn không có quyền thao tác trên tòa nhà của hồ sơ giữ chỗ này.',
      });
    }

    await client.query('BEGIN');

    const resCheck = await client.query('SELECT * FROM reservation WHERE id = $1 FOR UPDATE', [id]);
    const currentRes = resCheck.rows[0];

    if (currentRes.status !== 'HELD') {
      await client.query('ROLLBACK');
      return res.status(400).json({
        code: 'INVALID_STATUS',
        message: `Hồ sơ giữ chỗ đang ở trạng thái ${currentRes.status}.`,
      });
    }

    const updated = await client.query(
      `UPDATE reservation SET status = 'FORFEITED', updated_at = NOW() WHERE id = $1 RETURNING *`,
      [id]
    );

    await client.query(
      `UPDATE apartment a SET status = 'AVAILABLE', updated_at = NOW()
       WHERE a.id = $1 AND a.status = 'RESERVED'
         AND NOT EXISTS (SELECT 1 FROM reservation r WHERE r.apartment_id = a.id AND r.status = 'HELD')
         AND NOT EXISTS (SELECT 1 FROM contract c WHERE c.apartment_id = a.id AND c.status IN ('ACTIVE','RENEWAL_PENDING'))`,
      [currentRes.apartment_id]
    );

    await client.query(
      `INSERT INTO audit_log (actor_id, action, entity, entity_id, before, after)
       VALUES ($1, 'FORFEIT', 'reservation', $2, $3, $4)`,
      [
        req.user.sub,
        id,
        JSON.stringify(currentRes),
        JSON.stringify({
          reservation: updated.rows[0],
          forfeited_amount: currentRes.hold_amount,
          note: 'Khách hủy giữ chỗ, mất tiền cọc giữ chỗ',
        }),
      ]
    );

    await client.query('COMMIT');
    res.json({ message: 'Đã ghi nhận khách hủy giữ chỗ (mất cọc). Phòng đã mở lại có sẵn.', data: updated.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[Forfeit Reservation Error]:', err);
    res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi ghi nhận hủy giữ chỗ.' });
  } finally {
    await release();
  }
});

/**
 * PATCH /api/v1/reservations/:id/refund
 */
router.patch('/:id/refund', authenticateToken, requireRole(['MANAGER']), async (req, res) => {
  const { id } = req.params;
  const { client, release } = await getUserClient(req);
  try {
    const rsvExist = await adminPool.query('SELECT * FROM reservation WHERE id = $1 AND org_id = $2', [id, req.user.org_id]);
    if (rsvExist.rows.length === 0) {
      return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy hồ sơ giữ chỗ.' });
    }
    const mgrIds = await getManagerBuildingIds(req.user.sub, req.user.org_id);
    if (!mgrIds.includes(rsvExist.rows[0].building_id)) {
      await logAccessDenied(req, 'reservation', id, 'MANAGER attempted reservation refund on unassigned building');
      return res.status(403).json({
        code: 'FORBIDDEN_BUILDING',
        message: 'Bạn không có quyền thao tác trên tòa nhà của hồ sơ giữ chỗ này.',
      });
    }

    await client.query('BEGIN');

    const resCheck = await client.query('SELECT * FROM reservation WHERE id = $1 FOR UPDATE', [id]);
    const currentRes = resCheck.rows[0];

    if (currentRes.created_by && currentRes.created_by === req.user.sub) {
      await client.query('ROLLBACK');
      return res.status(403).json({
        code: 'FOUR_EYES_VIOLATION',
        message: 'Quy tắc 4 mắt (AC-017 / Four-eyes): Người duyệt hoàn cọc giữ chỗ phải khác người đã tạo hồ sơ giữ chỗ.',
      });
    }

    if (currentRes.status !== 'HELD') {
      await client.query('ROLLBACK');
      return res.status(400).json({
        code: 'INVALID_STATUS',
        message: `Hồ sơ giữ chỗ đang ở trạng thái ${currentRes.status}.`,
      });
    }

    const updated = await client.query(
      `UPDATE reservation SET status = 'REFUNDED', updated_at = NOW() WHERE id = $1 RETURNING *`,
      [id]
    );

    await client.query(
      `UPDATE apartment a SET status = 'AVAILABLE', updated_at = NOW()
       WHERE a.id = $1 AND a.status = 'RESERVED'
         AND NOT EXISTS (SELECT 1 FROM reservation r WHERE r.apartment_id = a.id AND r.status = 'HELD')
         AND NOT EXISTS (SELECT 1 FROM contract c WHERE c.apartment_id = a.id AND c.status IN ('ACTIVE','RENEWAL_PENDING'))`,
      [currentRes.apartment_id]
    );

    await client.query(
      `INSERT INTO audit_log (actor_id, action, entity, entity_id, before, after)
       VALUES ($1, 'REFUND', 'reservation', $2, $3, $4)`,
      [
        req.user.sub,
        id,
        JSON.stringify(currentRes),
        JSON.stringify({
          reservation: updated.rows[0],
          refunded_amount: currentRes.hold_amount,
          approved_by: req.user.sub,
          note: 'Hoàn trả tiền đặt cọc giữ chỗ cho khách',
        }),
      ]
    );

    await client.query('COMMIT');
    res.json({ message: 'Đã hoàn tiền giữ chỗ cho khách. Phòng đã mở lại có sẵn.', data: updated.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[Refund Reservation Error]:', err);
    res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi hoàn tiền giữ chỗ.' });
  } finally {
    await release();
  }
});

export default router;
