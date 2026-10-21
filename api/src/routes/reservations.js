import express from 'express';
import { pool, getUserClient } from '../db/client.js';
import { authenticateToken } from '../middleware/auth.js';
import { requireRole } from '../middleware/rbac.js';

const router = express.Router();

/**
 * GET /api/v1/reservations
 * Lấy danh sách đặt cọc giữ chỗ (M04 / FR-067 / NV-06)
 */
router.get('/', authenticateToken, requireRole(['OWNER', 'MANAGER']), async (req, res) => {
  try {
    const orgId = req.user.org_id;
    const { building_id, status } = req.query;
    const userRoles = (req.user.roles || []).map((r) => (typeof r === 'string' ? r : r.code));
    const isOwner = userRoles.includes('OWNER');
    const isManager = userRoles.includes('MANAGER');

    let sql = `
      SELECT r.*, 
        a.code as apartment_code, 
        a.area_m2 as apartment_area,
        b.name as building_name,
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

    if (isManager && !isOwner) {
      params.push(req.user.sub);
      sql += ` AND r.building_id IN (
        SELECT building_id FROM user_role WHERE user_id = $${params.length} AND building_id IS NOT NULL
      )`;
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
 * Tạo đặt cọc giữ chỗ cho khách tiềm năng (NV-06)
 */
router.post('/', authenticateToken, requireRole(['OWNER', 'MANAGER']), async (req, res) => {
  const { apartment_id, prospect_name, phone, hold_amount, hold_until, note } = req.body;
  const orgId = req.user.org_id;

  if (!apartment_id || !prospect_name || !phone) {
    return res.status(400).json({
      code: 'VALIDATION_ERROR',
      message: 'Căn hộ, tên khách và số điện thoại là bắt buộc.',
    });
  }

  const { client, release } = await getUserClient(req);
  try {
    await client.query('BEGIN');

    // 1. Kiểm tra căn hộ phải ở AVAILABLE
    const aptRes = await client.query(
      `SELECT a.*, b.org_id, b.id as b_id 
       FROM apartment a 
       JOIN building b ON b.id = a.building_id 
       WHERE a.id = $1`,
      [apartment_id]
    );

    if (aptRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy căn hộ.' });
    }

    const apt = aptRes.rows[0];
    if (apt.status !== 'AVAILABLE') {
      await client.query('ROLLBACK');
      return res.status(409).json({
        code: 'APARTMENT_NOT_AVAILABLE',
        message: `Căn hộ ${apt.code} đang ở trạng thái ${apt.status}, không thể đặt cọc giữ chỗ.`,
      });
    }

    // 2. Tạo bản ghi reservation
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
        hold_until || null,
        note || '',
        req.user.sub,
      ]
    );

    const reservation = resResult.rows[0];

    // 3. Chuyển trạng thái căn hộ sang RESERVED
    await client.query(
      `UPDATE apartment SET status = 'RESERVED', updated_at = NOW() WHERE id = $1`,
      [apartment_id]
    );

    // 4. Ghi audit_log
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
 * Chuyển cọc giữ chỗ thành cọc hợp đồng khi ký HĐ (NV-06)
 */
router.patch('/:id/convert', authenticateToken, requireRole(['OWNER', 'MANAGER']), async (req, res) => {
  const { id } = req.params;
  const { client, release } = await getUserClient(req);
  try {
    await client.query('BEGIN');

    const resCheck = await client.query('SELECT * FROM reservation WHERE id = $1', [id]);
    if (resCheck.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy hồ sơ giữ chỗ.' });
    }

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
 * Khách hủy giữ chỗ, mất tiền cọc (NV-06)
 */
router.patch('/:id/forfeit', authenticateToken, requireRole(['OWNER', 'MANAGER']), async (req, res) => {
  const { id } = req.params;
  const { client, release } = await getUserClient(req);
  try {
    await client.query('BEGIN');

    const resCheck = await client.query('SELECT * FROM reservation WHERE id = $1', [id]);
    if (resCheck.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy hồ sơ giữ chỗ.' });
    }

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

    // Mở lại phòng về AVAILABLE — chỉ khi căn không còn giữ chỗ HELD khác / hợp đồng ghim
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
      [req.user.sub, id, JSON.stringify(currentRes), JSON.stringify(updated.rows[0])]
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
 * Khách hủy và được hoàn lại cọc giữ chỗ (NV-06)
 */
router.patch('/:id/refund', authenticateToken, requireRole(['OWNER', 'MANAGER']), async (req, res) => {
  const { id } = req.params;
  const { client, release } = await getUserClient(req);
  try {
    await client.query('BEGIN');

    const resCheck = await client.query('SELECT * FROM reservation WHERE id = $1', [id]);
    if (resCheck.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy hồ sơ giữ chỗ.' });
    }

    const currentRes = resCheck.rows[0];
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

    // Mở lại phòng về AVAILABLE — chỉ khi căn không còn giữ chỗ HELD khác / hợp đồng ghim
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
      [req.user.sub, id, JSON.stringify(currentRes), JSON.stringify(updated.rows[0])]
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
