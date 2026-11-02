import express from 'express';
import { pool, adminPool, getUserClient } from '../db/client.js';
import { authenticateToken } from '../middleware/auth.js';
import { requireRole } from '../middleware/rbac.js';
import { idempotencyGuard } from '../middleware/idempotency.js';
import {
  getUserRoleCodes,
  getOwnerBuildingIds,
  getManagerBuildingIds,
  ownerBuildingFilter,
  managerBuildingFilter,
  logAccessDenied,
} from '../services/ownerScope.js';
import { syncApartmentStatus } from '../services/apartmentStatus.js';
import { checkFourEyesOrWarn } from '../services/pricing.js';
import { normalizeVnPhone, ensureResidentAccount } from '../services/residentAccount.js';
import { isPositiveSafeIntegerVnd, getTodayVnDateStr } from '../services/depositSettlement.js';

export { getTodayVnDateStr };

const router = express.Router();

/**
 * GET /api/v1/reservations
 * Quyền theo PRD 6.2 & FR-067: SYS_ADMIN (R), OWNER (R trên tòa sở hữu), MANAGER (CRU trên tòa quản lý)
 */
router.get('/', authenticateToken, requireRole(['SYS_ADMIN', 'OWNER', 'MANAGER']), async (req, res) => {
  try {
    const orgId = req.user.org_id;
    const { building_id, apartment_id, status } = req.query;
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
        building_has_active_owner(r.building_id) AS building_has_active_owner,
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

    if (apartment_id) {
      params.push(apartment_id);
      sql += ` AND r.apartment_id = $${params.length}`;
    }

    if (status) {
      params.push(status);
      sql += ` AND r.status = $${params.length}`;
    }

    sql += ` ORDER BY COALESCE(r.hold_from, (r.created_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date) ASC, r.hold_until ASC, r.created_at DESC`;

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
router.post('/', authenticateToken, requireRole(['MANAGER']), idempotencyGuard(), async (req, res) => {
  const { apartment_id, prospect_name, phone, hold_amount, hold_from, hold_until, note } = req.body;
  const orgId = req.user.org_id;

  const cleanPhone = normalizeVnPhone(phone);
  if (!apartment_id || !prospect_name?.trim() || !cleanPhone) {
    return res.status(400).json({
      code: 'VALIDATION_ERROR',
      message: 'Căn hộ, tên khách và số điện thoại là bắt buộc.',
    });
  }

  if (!/^0[0-9]{9}$/.test(cleanPhone)) {
    return res.status(400).json({
      code: 'INVALID_PHONE',
      message: 'Số điện thoại không hợp lệ. Vui lòng nhập đúng 10 chữ số (ví dụ: 0912345678).',
    });
  }

  if (!isPositiveSafeIntegerVnd(hold_amount)) {
    return res.status(400).json({
      code: 'INVALID_HOLD_AMOUNT',
      message: 'Số tiền đặt cọc giữ chỗ phải là số nguyên dương VND.',
    });
  }
  const normalizedHoldAmount = Number(String(hold_amount).trim());

  if (!hold_until) {
    return res.status(400).json({
      code: 'VALIDATION_ERROR',
      message: 'Thời hạn giữ chỗ (hold_until) là bắt buộc.',
    });
  }

  const todayStr = getTodayVnDateStr();
  const holdFromStr = hold_from ? String(hold_from).slice(0, 10) : todayStr;
  const holdUntilStr = String(hold_until).slice(0, 10);
  const holdFromDate = new Date(`${holdFromStr}T00:00:00Z`);
  const holdUntilDate = new Date(`${holdUntilStr}T00:00:00Z`);
  const todayDate = new Date(`${todayStr}T00:00:00Z`);

  if (
    isNaN(holdFromDate.getTime()) ||
    isNaN(holdUntilDate.getTime()) ||
    holdFromDate < todayDate ||
    holdUntilDate <= holdFromDate
  ) {
    return res.status(400).json({
      code: 'INVALID_HOLD_DATE',
      message: 'Khoảng thời gian giữ chỗ không hợp lệ (ngày kết thúc phải sau ngày bắt đầu và không nằm trong quá khứ).',
    });
  }

  const diffDays = Math.round((holdUntilDate.getTime() - holdFromDate.getTime()) / (24 * 60 * 60 * 1000));
  if (diffDays > 30) {
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
    const currentStatus = aptLock.rows[0].status;
    if (currentStatus === 'INACTIVE' || (currentStatus === 'MAINTENANCE' && holdFromStr <= todayStr)) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        code: 'APARTMENT_NOT_AVAILABLE',
        message: `Căn hộ ${apt.code} đang ở trạng thái ${currentStatus}, không thể đặt cọc giữ chỗ trong khoảng thời gian này.`,
      });
    }

    // Kiểm tra chồng lấn với các hợp đồng hiệu lực / chờ duyệt của căn hộ
    const overlapContract = await client.query(
      `SELECT start_date, COALESCE(terminated_at, end_date) AS end_date, status
       FROM contract
       WHERE apartment_id = $1
         AND status IN ('ACTIVE', 'RENEWAL_PENDING', 'TERMINATION_PENDING', 'PENDING_APPROVAL')
         AND start_date <= $2::date
         AND COALESCE(terminated_at, end_date) > $3::date
       ORDER BY start_date ASC
       LIMIT 1`,
      [apartment_id, holdUntilStr, holdFromStr]
    );
    if (overlapContract.rows.length > 0) {
      await client.query('ROLLBACK');
      const oc = overlapContract.rows[0];
      return res.status(409).json({
        code: 'APARTMENT_NOT_AVAILABLE',
        message: `Khoảng thời gian giữ chỗ bị chồng lấn với hợp đồng thuê (${String(oc.start_date).slice(0, 10)} → ${String(oc.end_date).slice(0, 10)}).`,
      });
    }

    // Kiểm tra chồng lấn với các phiếu giữ chỗ đang hiệu lực (HELD) khác trên cùng căn hộ
    const overlapRes = await client.query(
      `SELECT prospect_name, COALESCE(hold_from, (created_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date) AS hold_from, hold_until
       FROM reservation
       WHERE apartment_id = $1
         AND status = 'HELD'
         AND COALESCE(hold_from, (created_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date) <= $2::date
         AND hold_until >= $3::date
       ORDER BY hold_until ASC
       LIMIT 1`,
      [apartment_id, holdUntilStr, holdFromStr]
    );
    if (overlapRes.rows.length > 0) {
      await client.query('ROLLBACK');
      const orow = overlapRes.rows[0];
      return res.status(409).json({
        code: 'APARTMENT_NOT_AVAILABLE',
        message: `Khoảng thời gian giữ chỗ bị trùng với phiếu giữ chỗ của khách ${orow.prospect_name} (${String(orow.hold_from).slice(0, 10)} → ${String(orow.hold_until).slice(0, 10)}).`,
      });
    }

    const resResult = await client.query(
      `INSERT INTO reservation (
        org_id, building_id, apartment_id, prospect_name, phone, hold_amount, hold_from, hold_until, status, note, created_by
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'HELD', $9, $10)
      RETURNING *`,
      [
        orgId,
        apt.building_id,
        apartment_id,
        prospect_name.trim(),
        cleanPhone,
        normalizedHoldAmount,
        holdFromStr,
        holdUntilStr,
        note || '',
        req.user.sub,
      ]
    );

    const reservation = resResult.rows[0];

    // FR-067 + FR-001 + FR-012: Khởi tạo định danh person sơ bộ (nếu SĐT chưa tồn tại)
    // để khách giữ chỗ có thể đăng nhập OTP trên Cổng cư dân và tự khai hồ sơ nhận nhà.
    let prospectPersonId = null;
    const existingPersonRes = await adminPool.query(
      'SELECT id FROM person WHERE org_id = $1 AND phone = $2 LIMIT 1',
      [orgId, cleanPhone]
    );
    if (existingPersonRes.rows.length > 0) {
      prospectPersonId = existingPersonRes.rows[0].id;
    } else {
      const insPerson = await client.query(
        `INSERT INTO person (org_id, full_name, phone, created_by)
         VALUES ($1, $2, $3, $4)
         RETURNING id`,
        [orgId, prospect_name.trim(), cleanPhone, req.user.sub]
      );
      prospectPersonId = insPerson.rows[0].id;
    }

    await syncApartmentStatus(client, apartment_id);

    await client.query(
      `INSERT INTO audit_log (actor_id, action, entity, entity_id, after)
       VALUES ($1, 'CREATE', 'reservation', $2, $3)`,
      [req.user.sub, reservation.id, JSON.stringify(reservation)]
    );

    await client.query('COMMIT');

    if (prospectPersonId) {
      try {
        await ensureResidentAccount(prospectPersonId, { phone: cleanPhone });
      } catch (acctErr) {
        console.error('[Reservation Ensure Resident Account Warning]:', acctErr);
      }
    }
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
 * Chặn chuyển đổi thủ công rời rạc để đảm bảo tiền cọc giữ chỗ luôn kết chuyển nguyên tử khi kích hoạt HĐ (FR-067).
 */
router.patch('/:id/convert', authenticateToken, requireRole(['MANAGER']), async (req, res) => {
  return res.status(409).json({
    code: 'MUST_CONVERT_VIA_CONTRACT_ACTIVATION',
    message:
      'Phiếu giữ chỗ chỉ được kết chuyển tự động sang sổ cọc hợp đồng khi kích hoạt hợp đồng thuê (POST /api/v1/contracts/:id/activate).',
  });
});

async function canActAsReservationApprover(req, rsvRow, actionLabel) {
  const userRoles = getUserRoleCodes(req);
  if (userRoles.includes('OWNER')) {
    const ownedIds = await getOwnerBuildingIds(req.user.sub, req.user.org_id);
    if (ownedIds.includes(rsvRow.building_id)) {
      return { ok: true };
    }
  }
  if (userRoles.includes('MANAGER')) {
    const mgrIds = await getManagerBuildingIds(req.user.sub, req.user.org_id);
    if (mgrIds.includes(rsvRow.building_id)) {
      return { ok: true };
    }
  }
  if (userRoles.includes('SYS_ADMIN')) {
    if (!rsvRow.building_has_active_owner) {
      return { ok: true };
    }
    await logAccessDenied(
      req,
      'reservation',
      rsvRow.id,
      `SYS_ADMIN attempted ${actionLabel} on building with active OWNER`
    );
    return {
      ok: false,
      code: 'SYS_ADMIN_READ_ONLY_ON_OWNED_BUILDING',
      message: 'Tòa nhà đã có Chủ sở hữu (OWNER) hoạt động; Quản trị hệ thống chỉ có quyền Xem (R) theo PRD Mục 6.2.',
    };
  }
  await logAccessDenied(req, 'reservation', rsvRow.id, `Unauthorized ${actionLabel} on unassigned building`);
  return {
    ok: false,
    code: 'FORBIDDEN_BUILDING',
    message: 'Bạn không có quyền thao tác trên tòa nhà của hồ sơ giữ chỗ này.',
  };
}

/**
 * PATCH /api/v1/reservations/:id/forfeit
 */
router.patch(
  '/:id/forfeit',
  authenticateToken,
  requireRole(['OWNER', 'MANAGER', 'SYS_ADMIN']),
  idempotencyGuard(),
  async (req, res) => {
    const { id } = req.params;
    const trimmedReason = String(req.body?.reason || '').trim();
    if (!trimmedReason) {
      return res.status(400).json({
        code: 'REASON_REQUIRED',
        message: 'Vui lòng cung cấp lý do hủy / tịch thu cọc giữ chỗ (NFR-016).',
      });
    }

    const { client, release } = await getUserClient(req);
    try {
      const rsvExist = await adminPool.query(
        `SELECT r.*, building_has_active_owner(r.building_id) AS building_has_active_owner
         FROM reservation r
         WHERE r.id = $1 AND r.org_id = $2`,
        [id, req.user.org_id]
      );
      if (rsvExist.rows.length === 0) {
        return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy hồ sơ giữ chỗ.' });
      }
      const approverAccess = await canActAsReservationApprover(req, rsvExist.rows[0], 'reservation forfeit');
      if (!approverAccess.ok) {
        return res.status(403).json({
          code: approverAccess.code,
          message: approverAccess.message,
        });
      }

      await client.query('BEGIN');

      const resCheck = await client.query('SELECT * FROM reservation WHERE id = $1 FOR UPDATE', [id]);
      if (resCheck.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy hồ sơ giữ chỗ.' });
      }
      const currentRes = resCheck.rows[0];

      if (!['HELD', 'EXPIRED'].includes(currentRes.status)) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          code: 'INVALID_STATUS',
          message: `Hồ sơ giữ chỗ đang ở trạng thái ${currentRes.status}, chỉ phiếu HELD hoặc EXPIRED mới được xử lý.`,
        });
      }

      if (BigInt(currentRes.hold_amount ?? 0) <= 0n) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          code: 'INVALID_HOLD_AMOUNT',
          message: 'Phiếu giữ chỗ không có số dư tiền cọc hợp lệ để tịch thu.',
        });
      }

      const fourEyes = await checkFourEyesOrWarn({
        orgId: req.user.org_id,
        actorId: req.user.sub,
        creatorId: currentRes.created_by,
        entity: 'reservation',
        entityId: id,
        actionContext: 'RESERVATION_FORFEIT',
      });
      if (!fourEyes.allowed) {
        await client.query('ROLLBACK');
        return res.status(403).json({
          code: 'FOUR_EYES_VIOLATION',
          message: 'Quy tắc 4 mắt (Four-eyes): Người duyệt tịch thu cọc giữ chỗ phải khác người đã tạo phiếu giữ chỗ.',
        });
      }

      const updated = await client.query(
        `UPDATE reservation
         SET status = 'FORFEITED',
             note = COALESCE(NULLIF(note, '') || E'\n', '') || $2,
             updated_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [id, `[Tịch thu cọc]: ${trimmedReason}`]
      );

      await client.query('SELECT fn_sync_apartment_status_after_reservation($1)', [currentRes.apartment_id]);

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
            approved_by: req.user.sub,
            reason: trimmedReason,
            note: 'Khách hủy giữ chỗ / quá hạn, tịch thu tiền cọc giữ chỗ',
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
  }
);

/**
 * PATCH /api/v1/reservations/:id/refund
 */
router.patch(
  '/:id/refund',
  authenticateToken,
  requireRole(['OWNER', 'MANAGER', 'SYS_ADMIN']),
  idempotencyGuard(),
  async (req, res) => {
    const { id } = req.params;
    const trimmedReason = String(req.body?.reason || '').trim();
    if (!trimmedReason) {
      return res.status(400).json({
        code: 'REASON_REQUIRED',
        message: 'Vui lòng cung cấp lý do hoàn trả cọc giữ chỗ (NFR-016).',
      });
    }

    const { client, release } = await getUserClient(req);
    try {
      const rsvExist = await adminPool.query(
        `SELECT r.*, building_has_active_owner(r.building_id) AS building_has_active_owner
         FROM reservation r
         WHERE r.id = $1 AND r.org_id = $2`,
        [id, req.user.org_id]
      );
      if (rsvExist.rows.length === 0) {
        return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy hồ sơ giữ chỗ.' });
      }
      const approverAccess = await canActAsReservationApprover(req, rsvExist.rows[0], 'reservation refund');
      if (!approverAccess.ok) {
        return res.status(403).json({
          code: approverAccess.code,
          message: approverAccess.message,
        });
      }

      await client.query('BEGIN');

      const resCheck = await client.query('SELECT * FROM reservation WHERE id = $1 FOR UPDATE', [id]);
      if (resCheck.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy hồ sơ giữ chỗ.' });
      }
      const currentRes = resCheck.rows[0];

      if (!['HELD', 'EXPIRED'].includes(currentRes.status)) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          code: 'INVALID_STATUS',
          message: `Hồ sơ giữ chỗ đang ở trạng thái ${currentRes.status}, chỉ phiếu HELD hoặc EXPIRED mới được xử lý.`,
        });
      }

      if (BigInt(currentRes.hold_amount ?? 0) <= 0n) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          code: 'INVALID_HOLD_AMOUNT',
          message: 'Phiếu giữ chỗ không có số dư tiền cọc hợp lệ để hoàn trả.',
        });
      }

      const fourEyes = await checkFourEyesOrWarn({
        orgId: req.user.org_id,
        actorId: req.user.sub,
        creatorId: currentRes.created_by,
        entity: 'reservation',
        entityId: id,
        actionContext: 'RESERVATION_REFUND',
      });
      if (!fourEyes.allowed) {
        await client.query('ROLLBACK');
        return res.status(403).json({
          code: 'FOUR_EYES_VIOLATION',
          message: 'Quy tắc 4 mắt (AC-017 / Four-eyes): Người duyệt hoàn cọc giữ chỗ phải khác người đã tạo hồ sơ giữ chỗ (Chủ sở hữu, Quản lý khác hoặc SYS_ADMIN dự phòng).',
        });
      }

      const updated = await client.query(
        `UPDATE reservation
         SET status = 'REFUNDED',
             note = COALESCE(NULLIF(note, '') || E'\n', '') || $2,
             updated_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [id, `[Hoàn cọc giữ chỗ]: ${trimmedReason}`]
      );

      await client.query('SELECT fn_sync_apartment_status_after_reservation($1)', [currentRes.apartment_id]);

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
            reason: trimmedReason,
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
  }
);

export default router;
