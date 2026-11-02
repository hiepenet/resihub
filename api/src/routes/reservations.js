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
import { saveBase64Image } from '../services/imageUpload.js';
import { normalizeVnPhone, ensureResidentAccount, isInternalPerson } from '../services/residentAccount.js';
import {
  isPositiveSafeIntegerVnd,
  getTodayVnDateStr,
  validateRefundBankInfo,
  computeSuggestedCancelSplit,
  DEFAULT_RESERVATION_CANCEL_POLICY,
} from '../services/depositSettlement.js';

export { getTodayVnDateStr };

const router = express.Router();

const VALID_RESERVATION_METHODS = [
  'BANK_TRANSFER',
  'CASH',
  'QR_CODE',
  'E_WALLET',
  'CARD',
  'OTHER',
];
const ATTACHMENT_VIEW_URL_RE = /^\/api\/v1\/attachments\/[0-9a-f-]{36}\/view$/i;

export async function getOrgReservationCancelPolicy(orgId) {
  if (!orgId) return { ...DEFAULT_RESERVATION_CANCEL_POLICY };
  try {
    const res = await adminPool.query(
      `SELECT value FROM system_setting WHERE org_id = $1 AND key = 'reservation_cancel_policy' LIMIT 1`,
      [orgId]
    );
    const raw = res.rows[0]?.value;
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      return {
        max_hold_days: Math.max(1, Number(raw.max_hold_days ?? DEFAULT_RESERVATION_CANCEL_POLICY.max_hold_days)),
        public_max_hold_days: Math.max(
          1,
          Number(raw.public_max_hold_days ?? DEFAULT_RESERVATION_CANCEL_POLICY.public_max_hold_days)
        ),
        full_refund_before_days: Math.max(
          0,
          Number(raw.full_refund_before_days ?? DEFAULT_RESERVATION_CANCEL_POLICY.full_refund_before_days)
        ),
        partial_refund_pct: Math.min(
          100,
          Math.max(0, Number(raw.partial_refund_pct ?? DEFAULT_RESERVATION_CANCEL_POLICY.partial_refund_pct))
        ),
        default_hold_amount: Math.max(
          0,
          Number(raw.default_hold_amount ?? DEFAULT_RESERVATION_CANCEL_POLICY.default_hold_amount)
        ),
      };
    }
  } catch (err) {
    console.warn('[Reservation Cancel Policy Lookup Warning]:', err.message);
  }
  return { ...DEFAULT_RESERVATION_CANCEL_POLICY };
}

export function isReservationSettleable(currentRes) {
  if (!currentRes) return false;
  const settledSum =
    Number(currentRes.refunded_amount || 0) + Number(currentRes.forfeited_amount || 0);
  if (settledSum !== 0) return false;
  if (currentRes.status === 'HELD') return true;
  if (currentRes.status === 'EXPIRED') {
    return currentRes.source !== 'PUBLIC' || Boolean(currentRes.confirmed_at);
  }
  return false;
}

function parseNonNegativeSafeIntVnd(val) {
  if (typeof val === 'number') {
    return Number.isSafeInteger(val) && val >= 0 ? val : null;
  }
  if (typeof val === 'string') {
    const trimmed = val.trim();
    if (!/^(0|[1-9]\d*)$/.test(trimmed)) return null;
    const num = Number(trimmed);
    return Number.isSafeInteger(num) && num >= 0 ? num : null;
  }
  return null;
}

export async function persistReservationEvidence(
  client,
  req,
  reservationId,
  rawList,
  { allowExistingAttachmentUrls = false } = {}
) {
  if (!Array.isArray(rawList) || rawList.length === 0) return [];
  if (rawList.length > 5) {
    const err = new Error('Tối đa 5 tệp chứng từ cho mỗi phiếu giữ chỗ.');
    err.httpStatus = 422;
    err.code = 'TOO_MANY_EVIDENCE_FILES';
    throw err;
  }
  const normalized = [];
  for (const item of rawList) {
    const raw = String(item || '').trim();
    if (!raw) continue;
    if (ATTACHMENT_VIEW_URL_RE.test(raw)) {
      if (!allowExistingAttachmentUrls) {
        const err = new Error('Chứng từ tải lên phải là tệp ảnh/PDF hợp lệ (không chấp nhận đường dẫn sẵn có).');
        err.httpStatus = 422;
        err.code = 'INVALID_EVIDENCE';
        throw err;
      }
      const idMatch = raw.match(/\/attachments\/([0-9a-f-]{36})\/view$/i);
      const attachmentId = idMatch ? idMatch[1] : null;
      const ownRes = attachmentId
        ? await client.query(
            `SELECT 1 FROM attachment
             WHERE id = $1::uuid AND owner_entity = 'reservation' AND owner_id = $2::uuid
             LIMIT 1`,
            [attachmentId, reservationId]
          )
        : { rows: [] };
      if (ownRes.rows.length === 0) {
        const err = new Error('Chứng từ tham chiếu không thuộc về phiếu giữ chỗ này.');
        err.httpStatus = 422;
        err.code = 'INVALID_EVIDENCE';
        throw err;
      }
      normalized.push(raw);
      continue;
    }
    const saved = await saveBase64Image({
      imageBase64: raw,
      folder: 'reservations',
      entityId: String(reservationId),
      entity: 'reservation',
      ownerId: reservationId,
      req,
      query: (sql, params) => client.query(sql, params),
      allowPdf: true,
    });
    if (saved.error) {
      const err = new Error(saved.error.message);
      err.httpStatus = 422;
      err.code = saved.error.code || 'INVALID_EVIDENCE';
      throw err;
    }
    normalized.push(`/api/v1/attachments/${saved.attachment.id}/view`);
  }
  return normalized;
}

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
 * GET /api/v1/reservations/cancel-policy
 */
router.get(
  '/cancel-policy',
  authenticateToken,
  requireRole(['SYS_ADMIN', 'OWNER', 'MANAGER']),
  async (req, res) => {
    try {
      const policy = await getOrgReservationCancelPolicy(req.user.org_id);
      res.json({ data: policy });
    } catch (err) {
      console.error('[Get Reservation Cancel Policy Error]:', err);
      res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi khi tải chính sách hủy giữ chỗ.' });
    }
  }
);

/**
 * POST /api/v1/reservations
 * Tạo đặt cọc giữ chỗ nội bộ cho khách tiềm năng (NV-06 / FR-067)
 */
router.post('/', authenticateToken, requireRole(['MANAGER']), idempotencyGuard(), async (req, res) => {
  const { apartment_id, prospect_name, phone, hold_amount, hold_from, hold_until, note, method, evidence } = req.body;
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

  const normalizedMethod = method ? String(method).trim().toUpperCase() : 'BANK_TRANSFER';
  if (!VALID_RESERVATION_METHODS.includes(normalizedMethod)) {
    return res.status(400).json({
      code: 'INVALID_METHOD',
      message: `Phương thức thu tiền giữ chỗ không hợp lệ. Chỉ chấp nhận: ${VALID_RESERVATION_METHODS.join(', ')}.`,
    });
  }

  if (!hold_until) {
    return res.status(400).json({
      code: 'VALIDATION_ERROR',
      message: 'Thời hạn giữ chỗ (hold_until) là bắt buộc.',
    });
  }

  const todayStr = getTodayVnDateStr();
  const holdFromStr = hold_from ? getTodayVnDateStr(hold_from) : todayStr;
  const holdUntilStr = getTodayVnDateStr(hold_until);
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

  const policy = await getOrgReservationCancelPolicy(orgId);
  const maxHoldDays = Number(policy.max_hold_days || 30);
  const diffDays = Math.round((holdUntilDate.getTime() - holdFromDate.getTime()) / (24 * 60 * 60 * 1000));
  if (diffDays > maxHoldDays) {
    return res.status(400).json({
      code: 'HOLD_DURATION_EXCEEDED',
      message: `Thời hạn giữ chỗ tối đa không quá ${maxHoldDays} ngày theo quy định.`,
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
        message: `Khoảng thời gian giữ chỗ bị chồng lấn với hợp đồng thuê (${getTodayVnDateStr(oc.start_date)} → ${getTodayVnDateStr(oc.end_date)}).`,
      });
    }

    // Kiểm tra chồng lấn với các phiếu giữ chỗ đang hiệu lực (HELD / CANCEL_PENDING_APPROVAL) khác trên cùng căn hộ
    const overlapRes = await client.query(
      `SELECT prospect_name, COALESCE(hold_from, (created_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date) AS hold_from, hold_until
       FROM reservation
       WHERE apartment_id = $1
         AND status IN ('HELD', 'CANCEL_PENDING_APPROVAL')
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
        org_id, building_id, apartment_id, prospect_name, phone, hold_amount,
        hold_from, hold_until, status, source, method, confirmed_by, confirmed_at, note, created_by
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'HELD', 'INTERNAL', $9, $10, NOW(), $11, $10)
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
        normalizedMethod,
        req.user.sub,
        note || '',
      ]
    );

    let reservation = resResult.rows[0];

    if (Array.isArray(evidence) && evidence.length > 0) {
      const savedEvidence = await persistReservationEvidence(client, req, reservation.id, evidence);
      if (savedEvidence.length > 0) {
        const evUpd = await client.query(
          `UPDATE reservation SET evidence = $2 WHERE id = $1 RETURNING *`,
          [reservation.id, savedEvidence]
        );
        reservation = evUpd.rows[0];
      }
    }

    // FR-067 + FR-001 + FR-012: Khởi tạo định danh person sơ bộ (nếu SĐT chưa tồn tại)
    let prospectPersonId = null;
    const existingPersonRes = await adminPool.query(
      'SELECT id FROM person WHERE org_id = $1 AND phone = $2 LIMIT 1',
      [orgId, cleanPhone]
    );
    if (existingPersonRes.rows.length > 0) {
      prospectPersonId = existingPersonRes.rows[0].id;
      if (await isInternalPerson(prospectPersonId, orgId)) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          code: 'INTERNAL_ACCOUNT_PHONE',
          message: 'Số điện thoại này thuộc tài khoản nhân sự / quản trị nội bộ, không thể dùng cho hồ sơ cư dân giữ chỗ.',
        });
      }
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
    await client.query('ROLLBACK').catch(() => {});
    if (err.httpStatus) {
      return res.status(err.httpStatus).json({ code: err.code, message: err.message });
    }
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
  return res.status(409).json({
    code: 'MUST_CONVERT_VIA_CONTRACT_ACTIVATION',
    message:
      'Phiếu giữ chỗ chỉ được kết chuyển tự động sang sổ cọc hợp đồng khi kích hoạt hợp đồng thuê (POST /api/v1/contracts/:id/activate).',
  });
});

/**
 * PATCH /api/v1/reservations/:id/confirm-payment
 * MANAGER đối chiếu sao kê xác nhận tiền về cho phiếu khách đặt online (PENDING_CONFIRM -> HELD, PRD 5.3)
 */
router.patch(
  '/:id/confirm-payment',
  authenticateToken,
  requireRole(['MANAGER']),
  idempotencyGuard(),
  async (req, res) => {
    const { id } = req.params;
    const orgId = req.user.org_id;
    const { client, release } = await getUserClient(req);
    try {
      const rsvExist = await adminPool.query(
        'SELECT * FROM reservation WHERE id = $1 AND org_id = $2',
        [id, orgId]
      );
      if (rsvExist.rows.length === 0) {
        return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy hồ sơ giữ chỗ.' });
      }

      const mgrIds = await getManagerBuildingIds(req.user.sub, orgId);
      if (!mgrIds.includes(rsvExist.rows[0].building_id)) {
        await logAccessDenied(req, 'reservation', id, 'MANAGER attempted confirm-payment on unassigned building');
        return res.status(403).json({
          code: 'FORBIDDEN_BUILDING',
          message: 'Bạn không có quyền quản lý tòa nhà của phiếu giữ chỗ này.',
        });
      }

      await client.query('BEGIN');

      const resLock = await client.query('SELECT * FROM reservation WHERE id = $1 FOR UPDATE', [id]);
      if (resLock.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy hồ sơ giữ chỗ.' });
      }
      const currentRes = resLock.rows[0];
      if (currentRes.status !== 'PENDING_CONFIRM') {
        await client.query('ROLLBACK');
        return res.status(400).json({
          code: 'INVALID_STATUS',
          message: `Phiếu giữ chỗ đang ở trạng thái ${currentRes.status}, chỉ phiếu PENDING_CONFIRM mới được xác nhận tiền về.`,
        });
      }

      const aptLock = await client.query('SELECT * FROM apartment WHERE id = $1 FOR UPDATE', [
        currentRes.apartment_id,
      ]);
      const aptRow = aptLock.rows[0];
      if (!aptRow || aptRow.status !== 'AVAILABLE') {
        await client.query('ROLLBACK');
        return res.status(409).json({
          code: 'APARTMENT_NOT_AVAILABLE',
          message: `Căn hộ hiện đang ở trạng thái ${aptRow?.status || 'KHÔNG KHẢ DỤNG'}, không thể xác nhận giữ chỗ.`,
        });
      }

      const holdFromStr = getTodayVnDateStr(currentRes.hold_from) || getTodayVnDateStr();
      const holdUntilStr = getTodayVnDateStr(currentRes.hold_until);

      const overlapContract = await client.query(
        `SELECT id FROM contract
         WHERE apartment_id = $1
           AND status IN ('ACTIVE', 'RENEWAL_PENDING', 'TERMINATION_PENDING', 'PENDING_APPROVAL')
           AND start_date <= $2::date
           AND COALESCE(terminated_at, end_date) > $3::date
         LIMIT 1`,
        [currentRes.apartment_id, holdUntilStr, holdFromStr]
      );
      if (overlapContract.rows.length > 0) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          code: 'APARTMENT_NOT_AVAILABLE',
          message: 'Căn hộ đã có hợp đồng thuê hiệu lực / chờ duyệt trong khoảng thời gian này.',
        });
      }

      const overlapHeld = await client.query(
        `SELECT id FROM reservation
         WHERE apartment_id = $1
           AND id <> $2
           AND status IN ('HELD', 'CANCEL_PENDING_APPROVAL')
           AND COALESCE(hold_from, (created_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date) <= $3::date
           AND hold_until >= $4::date
         LIMIT 1`,
        [currentRes.apartment_id, id, holdUntilStr, holdFromStr]
      );
      if (overlapHeld.rows.length > 0) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          code: 'APARTMENT_NOT_AVAILABLE',
          message: 'Căn hộ đã được xác nhận giữ chỗ cho khách hàng khác trước đó.',
        });
      }

      const updated = await client.query(
        `UPDATE reservation
         SET status = 'HELD',
             confirmed_by = $2,
             confirmed_at = NOW(),
             updated_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [id, req.user.sub]
      );

      await client.query('SELECT fn_sync_apartment_status_after_reservation($1)', [currentRes.apartment_id]);

      await client.query('SELECT fn_notify_reservation_prospect($1, $2, $3, $4)', [
        id,
        'RESERVATION_PAYMENT_CONFIRMED',
        `Đã xác nhận giữ chỗ căn ${aptRow.code}`,
        `Ban quản lý đã đối chiếu sao kê và xác nhận giữ căn ${aptRow.code} cho bạn đến hết ngày ${holdUntilStr}.`,
      ]);

      await client.query(
        `INSERT INTO audit_log (actor_id, action, entity, entity_id, before, after)
         VALUES ($1, 'CONFIRM_PAYMENT', 'reservation', $2, $3, $4)`,
        [req.user.sub, id, JSON.stringify(currentRes), JSON.stringify(updated.rows[0])]
      );

      await client.query('COMMIT');
      res.json({
        message: `Đã xác nhận tiền đặt giữ chỗ và khóa căn ${aptRow.code} thành công.`,
        data: updated.rows[0],
      });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('[Confirm Reservation Payment Error]:', err);
      res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi máy chủ khi xác nhận sao kê giữ chỗ.' });
    } finally {
      await release();
    }
  }
);

/**
 * PATCH /api/v1/reservations/:id/reject-payment
 * MANAGER từ chối biên lai chuyển khoản cho phiếu PENDING_CONFIRM (không phát sinh phạt)
 */
router.patch(
  '/:id/reject-payment',
  authenticateToken,
  requireRole(['MANAGER']),
  idempotencyGuard(),
  async (req, res) => {
    const { id } = req.params;
    const orgId = req.user.org_id;
    const trimmedReason = String(req.body?.reason || '').trim();
    if (!trimmedReason) {
      return res.status(400).json({
        code: 'REASON_REQUIRED',
        message: 'Vui lòng nhập lý do từ chối xác nhận biên lai chuyển khoản.',
      });
    }

    const { client, release } = await getUserClient(req);
    try {
      const rsvExist = await adminPool.query(
        'SELECT * FROM reservation WHERE id = $1 AND org_id = $2',
        [id, orgId]
      );
      if (rsvExist.rows.length === 0) {
        return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy hồ sơ giữ chỗ.' });
      }

      const mgrIds = await getManagerBuildingIds(req.user.sub, orgId);
      if (!mgrIds.includes(rsvExist.rows[0].building_id)) {
        await logAccessDenied(req, 'reservation', id, 'MANAGER attempted reject-payment on unassigned building');
        return res.status(403).json({
          code: 'FORBIDDEN_BUILDING',
          message: 'Bạn không có quyền quản lý tòa nhà của phiếu giữ chỗ này.',
        });
      }

      await client.query('BEGIN');

      const resLock = await client.query('SELECT * FROM reservation WHERE id = $1 FOR UPDATE', [id]);
      if (resLock.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy hồ sơ giữ chỗ.' });
      }
      const currentRes = resLock.rows[0];
      if (currentRes.status !== 'PENDING_CONFIRM') {
        await client.query('ROLLBACK');
        return res.status(400).json({
          code: 'INVALID_STATUS',
          message: `Phiếu giữ chỗ đang ở trạng thái ${currentRes.status}, chỉ phiếu PENDING_CONFIRM mới được từ chối xác nhận.`,
        });
      }

      const updated = await client.query(
        `UPDATE reservation
         SET status = 'REJECTED',
             rejected_reason = $2,
             refunded_amount = 0,
             forfeited_amount = 0,
             updated_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [id, trimmedReason]
      );

      await client.query('SELECT fn_notify_reservation_prospect($1, $2, $3, $4)', [
        id,
        'RESERVATION_PAYMENT_REJECTED',
        'Từ chối xác nhận phiếu đặt giữ chỗ',
        `Yêu cầu đặt giữ chỗ của bạn không được xác nhận. Lý do: ${trimmedReason}`,
      ]);

      await client.query(
        `INSERT INTO audit_log (actor_id, action, entity, entity_id, before, after)
         VALUES ($1, 'REJECT_PAYMENT', 'reservation', $2, $3, $4)`,
        [
          req.user.sub,
          id,
          JSON.stringify(currentRes),
          JSON.stringify({ reservation: updated.rows[0], reason: trimmedReason }),
        ]
      );

      await client.query('COMMIT');
      res.json({
        message: 'Đã từ chối xác nhận phiếu giữ chỗ.',
        data: updated.rows[0],
      });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('[Reject Reservation Payment Error]:', err);
      res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi máy chủ khi từ chối phiếu giữ chỗ.' });
    } finally {
      await release();
    }
  }
);

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

function extractReservationBankPayload(rawInput) {
  if (!rawInput || typeof rawInput !== 'object' || Array.isArray(rawInput)) {
    return {};
  }
  if (rawInput.bank_info !== undefined) {
    return rawInput.bank_info && typeof rawInput.bank_info === 'object' && !Array.isArray(rawInput.bank_info)
      ? rawInput.bank_info
      : {};
  }
  return rawInput;
}

/**
 * PATCH /api/v1/reservations/:id/cancel-settle
 * Bước 1: MANAGER lập đề xuất thanh lý hủy phiếu giữ chỗ theo chính sách chia hoàn / phạt (FR-005 / FR-067 / PRD 6.2 & 10.3)
 * Chuyển sang CANCEL_PENDING_APPROVAL (không yêu cầu UNC ở bước lập đề xuất).
 */
router.patch(
  '/:id/cancel-settle',
  authenticateToken,
  requireRole(['MANAGER']),
  idempotencyGuard(),
  async (req, res) => {
    const { id } = req.params;
    const {
      refunded_amount,
      forfeited_amount,
      reason,
      refund_method = 'BANK_TRANSFER',
      refund_bank_info = {},
    } = req.body || {};

    const trimmedReason = String(reason || '').trim();
    if (!trimmedReason) {
      return res.status(400).json({
        code: 'REASON_REQUIRED',
        message: 'Vui lòng cung cấp lý do thanh lý hủy giữ chỗ (NFR-016).',
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
      const preRow = rsvExist.rows[0];

      const mgrIds = await getManagerBuildingIds(req.user.sub, req.user.org_id);
      if (!mgrIds.includes(preRow.building_id)) {
        await logAccessDenied(req, 'reservation', id, 'MANAGER attempted cancel-settle proposal on unassigned building');
        return res.status(403).json({
          code: 'FORBIDDEN_BUILDING',
          message: 'Bạn không có quyền quản lý tòa nhà của hồ sơ giữ chỗ này.',
        });
      }

      if (!isReservationSettleable(preRow)) {
        return res.status(400).json({
          code: 'INVALID_STATUS',
          message: `Hồ sơ giữ chỗ đang ở trạng thái ${preRow.status} (hoặc đã được thanh lý trước đó), chỉ phiếu HELD hoặc EXPIRED đã xác nhận tiền mới được lập đề xuất hủy.`,
        });
      }

      const refundInt = parseNonNegativeSafeIntVnd(refunded_amount);
      const forfeitInt = parseNonNegativeSafeIntVnd(forfeited_amount);
      const holdAmt = Number(preRow.hold_amount || 0);
      if (holdAmt <= 0) {
        return res.status(409).json({
          code: 'INVALID_HOLD_AMOUNT',
          message: 'Phiếu giữ chỗ không có số dư tiền cọc hợp lệ.',
        });
      }

      if (refundInt === null || forfeitInt === null || refundInt + forfeitInt !== holdAmt) {
        return res.status(422).json({
          code: 'INVALID_CANCEL_SPLIT',
          message: `Tổng tiền hoàn trả và tiền phạt hủy phải là số nguyên VND không âm và bằng đúng tiền cọc giữ chỗ (${holdAmt.toLocaleString('vi-VN')} ₫).`,
        });
      }

      const effectiveMethod = refundInt > 0 ? String(refund_method || 'BANK_TRANSFER').trim().toUpperCase() : null;
      let normalizedBankInfo = null;
      if (refundInt > 0) {
        const rawBankPayload = extractReservationBankPayload(refund_bank_info);
        const bankCheck = validateRefundBankInfo({
          refundAmount: refundInt,
          refundMethod: effectiveMethod,
          bankInfo: rawBankPayload,
        });
        if (!bankCheck.ok) {
          return res.status(422).json({
            code: bankCheck.code,
            message: bankCheck.message,
          });
        }
        normalizedBankInfo = effectiveMethod === 'BANK_TRANSFER' ? bankCheck.normalizedBankInfo : null;
      }

      await client.query('BEGIN');

      const resCheck = await client.query('SELECT * FROM reservation WHERE id = $1 FOR UPDATE', [id]);
      if (resCheck.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          code: 'INVALID_STATUS',
          message: 'Phiếu giữ chỗ không còn ở trạng thái cho phép lập đề xuất hủy.',
        });
      }
      const currentRes = resCheck.rows[0];
      if (!isReservationSettleable(currentRes)) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          code: 'INVALID_STATUS',
          message: `Phiếu giữ chỗ đang ở trạng thái ${currentRes.status} hoặc đã lập đề xuất thanh lý trước đó.`,
        });
      }

      const policy = await getOrgReservationCancelPolicy(req.user.org_id);
      const suggestedSplit = computeSuggestedCancelSplit({
        holdAmount: holdAmt,
        holdUntil: currentRes.hold_until,
        todayStr: getTodayVnDateStr(),
        policy,
      });
      const policyOverride =
        suggestedSplit.refunded_amount !== refundInt ||
        suggestedSplit.forfeited_amount !== forfeitInt;

      const nowIso = new Date().toISOString();
      const cancelSettlementMeta = {
        previous_status: currentRes.status,
        proposed_by: req.user.sub,
        proposed_at: nowIso,
        policy_suggested_split: suggestedSplit,
        policy_override: policyOverride,
        approved_by: null,
        approved_at: null,
        payout_by: null,
        payout_at: null,
        reference_code: null,
      };

      const updated = await client.query(
        `UPDATE reservation
         SET status = 'CANCEL_PENDING_APPROVAL',
             refunded_amount = $2,
             forfeited_amount = $3,
             cancel_reason = $4,
             refund_method = $5,
             refund_bank_info = $6,
             cancel_settlement = $7::jsonb,
             note = COALESCE(NULLIF(note, '') || E'\n', '') || $8,
             updated_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [
          id,
          refundInt,
          forfeitInt,
          trimmedReason,
          effectiveMethod,
          normalizedBankInfo ? JSON.stringify(normalizedBankInfo) : null,
          JSON.stringify(cancelSettlementMeta),
          `[Đề xuất thanh lý hủy giữ chỗ]: Hoàn ${refundInt.toLocaleString('vi-VN')} ₫ / Phạt ${forfeitInt.toLocaleString('vi-VN')} ₫ — ${trimmedReason}`,
        ]
      );

      await client.query('SELECT fn_sync_apartment_status_after_reservation($1)', [currentRes.apartment_id]);

      await client.query('SELECT fn_notify_reservation_staff($1, $2, $3, $4, $5)', [
        id,
        'APPROVERS',
        'RESERVATION_CANCEL_PENDING_APPROVAL',
        'Đề xuất thanh lý hủy giữ chỗ chờ phê duyệt',
        `BQL đề xuất thanh lý giữ chỗ khách ${currentRes.prospect_name}: hoàn ${refundInt.toLocaleString('vi-VN')} ₫, phạt ${forfeitInt.toLocaleString('vi-VN')} ₫.`,
      ]);

      await client.query(
        `INSERT INTO audit_log (actor_id, action, entity, entity_id, before, after)
         VALUES ($1, 'CANCEL_SETTLE_PROPOSE', 'reservation', $2, $3, $4)`,
        [
          req.user.sub,
          id,
          JSON.stringify(currentRes),
          JSON.stringify({
            reservation: updated.rows[0],
            refunded_amount: refundInt,
            forfeited_amount: forfeitInt,
            refund_method: effectiveMethod,
            policy_suggested_split: suggestedSplit,
            policy_override: policyOverride,
            proposed_by: req.user.sub,
            reason: trimmedReason,
          }),
        ]
      );

      await client.query('COMMIT');
      res.json({
        message: 'Đã gửi đề xuất thanh lý hủy giữ chỗ chờ phê duyệt (Four-Eyes).',
        data: updated.rows[0],
      });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      if (err.httpStatus) {
        return res.status(err.httpStatus).json({ code: err.code, message: err.message });
      }
      console.error('[Cancel-Settle Propose Reservation Error]:', err);
      res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi máy chủ khi lập đề xuất thanh lý hủy giữ chỗ.' });
    } finally {
      await release();
    }
  }
);

/**
 * POST /api/v1/reservations/:id/cancel-approve
 * Bước 2a: OWNER (hoặc người duyệt Four-Eyes dự phòng) phê duyệt đề xuất hủy giữ chỗ (FR-067 / PRD 6.1–6.2)
 * - Nếu refunded_amount === 0: chốt thẳng FORFEITED + mở căn AVAILABLE.
 * - Nếu refunded_amount > 0: chuyển sang APPROVED_PENDING_PAYOUT + mở ngay căn AVAILABLE để BQL chi hoàn kèm UNC.
 */
router.post(
  '/:id/cancel-approve',
  authenticateToken,
  requireRole(['OWNER', 'MANAGER', 'SYS_ADMIN']),
  idempotencyGuard(),
  async (req, res) => {
    const { id } = req.params;
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
      const preRow = rsvExist.rows[0];

      const approverAccess = await canActAsReservationApprover(req, preRow, 'reservation cancel-approve');
      if (!approverAccess.ok) {
        return res.status(403).json({
          code: approverAccess.code,
          message: approverAccess.message,
        });
      }

      if (preRow.status !== 'CANCEL_PENDING_APPROVAL') {
        return res.status(409).json({
          code: 'INVALID_STATUS',
          message: `Phiếu giữ chỗ đang ở trạng thái ${preRow.status}, chỉ phiếu CANCEL_PENDING_APPROVAL mới được phê duyệt.`,
        });
      }

      await client.query('BEGIN');

      const resCheck = await client.query('SELECT * FROM reservation WHERE id = $1 FOR UPDATE', [id]);
      if (resCheck.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          code: 'INVALID_STATUS',
          message: 'Phiếu giữ chỗ không còn ở trạng thái chờ phê duyệt.',
        });
      }
      const currentRes = resCheck.rows[0];
      if (currentRes.status !== 'CANCEL_PENDING_APPROVAL') {
        await client.query('ROLLBACK');
        return res.status(409).json({
          code: 'INVALID_STATUS',
          message: `Phiếu giữ chỗ đang ở trạng thái ${currentRes.status}, chỉ phiếu CANCEL_PENDING_APPROVAL mới được phê duyệt.`,
        });
      }

      const proposerId =
        currentRes.cancel_settlement?.proposed_by || currentRes.confirmed_by || currentRes.created_by;
      const fourEyes = await checkFourEyesOrWarn({
        orgId: req.user.org_id,
        actorId: req.user.sub,
        creatorId: proposerId,
        entity: 'reservation',
        entityId: id,
        actionContext: 'RESERVATION_CANCEL_APPROVE',
      });
      if (!fourEyes.allowed) {
        await client.query('ROLLBACK');
        return res.status(403).json({
          code: 'FOUR_EYES_VIOLATION',
          message:
            'Quy tắc 4 mắt (Four-eyes): Người phê duyệt thanh lý hủy giữ chỗ phải khác người lập đề xuất / xác nhận phiếu giữ chỗ.',
        });
      }

      const refundAmt = Number(currentRes.refunded_amount || 0);
      const forfeitAmt = Number(currentRes.forfeited_amount || 0);
      const nextStatus = refundAmt === 0 ? 'FORFEITED' : 'APPROVED_PENDING_PAYOUT';
      const nowIso = new Date().toISOString();
      const approvalNote = String(req.body?.note || '').trim();
      const mergedSettlement = {
        ...(currentRes.cancel_settlement && typeof currentRes.cancel_settlement === 'object'
          ? currentRes.cancel_settlement
          : {}),
        approved_by: req.user.sub,
        approved_at: nowIso,
        approval_note: approvalNote || null,
      };
      const approvalNoteSuffix = approvalNote ? ` — ${approvalNote}` : '';

      const updated = await client.query(
        `UPDATE reservation
         SET status = $2,
             cancel_settlement = $3::jsonb,
             note = COALESCE(NULLIF(note, '') || E'\n', '') || $4,
             updated_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [
          id,
          nextStatus,
          JSON.stringify(mergedSettlement),
          refundAmt === 0
            ? `[Đã duyệt thanh lý hủy giữ chỗ — Phạt cọc 100%]: ${forfeitAmt.toLocaleString('vi-VN')} ₫${approvalNoteSuffix}`
            : `[Đã duyệt thanh lý hủy giữ chỗ — Chờ BQL chi hoàn]: Hoàn ${refundAmt.toLocaleString('vi-VN')} ₫ / Phạt ${forfeitAmt.toLocaleString('vi-VN')} ₫${approvalNoteSuffix}`,
        ]
      );

      await client.query('SELECT fn_sync_apartment_status_after_reservation($1)', [currentRes.apartment_id]);

      if (refundAmt === 0) {
        await client.query('SELECT fn_notify_reservation_prospect($1, $2, $3, $4)', [
          id,
          'RESERVATION_CANCEL_SETTLED',
          'Đã thanh lý hủy phiếu đặt giữ chỗ',
          `Phiếu giữ chỗ của bạn đã được thanh lý hủy (phí hủy giữ chỗ: ${forfeitAmt.toLocaleString('vi-VN')} ₫).`,
        ]);
      } else {
        await client.query('SELECT fn_notify_reservation_staff($1, $2, $3, $4, $5)', [
          id,
          'BUILDING_MANAGERS',
          'RESERVATION_CANCEL_APPROVED_FOR_PAYOUT',
          'Đề xuất hủy giữ chỗ đã được duyệt — Chờ chi hoàn & tải UNC',
          `Phương án hoàn ${refundAmt.toLocaleString('vi-VN')} ₫ cho khách ${currentRes.prospect_name} đã được duyệt. Vui lòng thực chi và tải chứng từ UNC.`,
        ]);
        await client.query('SELECT fn_notify_reservation_prospect($1, $2, $3, $4)', [
          id,
          'RESERVATION_CANCEL_APPROVED',
          'Đã duyệt phương án hoàn tiền giữ chỗ',
          `Phương án hoàn trả ${refundAmt.toLocaleString('vi-VN')} ₫ đã được phê duyệt. Ban quản lý đang thực hiện thủ tục chi hoàn.`,
        ]);
      }

      await client.query(
        `INSERT INTO audit_log (actor_id, action, entity, entity_id, before, after)
         VALUES ($1, 'CANCEL_SETTLE_APPROVE', 'reservation', $2, $3, $4)`,
        [
          req.user.sub,
          id,
          JSON.stringify(currentRes),
          JSON.stringify({
            reservation: updated.rows[0],
            refunded_amount: refundAmt,
            forfeited_amount: forfeitAmt,
            approved_by: req.user.sub,
            approved_at: nowIso,
          }),
        ]
      );

      await client.query('COMMIT');
      res.json({
        message:
          refundAmt === 0
            ? 'Đã phê duyệt thanh lý hủy giữ chỗ (phạt cọc 100%). Căn hộ đã được mở lại có sẵn.'
            : 'Đã phê duyệt phương án hủy giữ chỗ và mở lại căn hộ. Chờ BQL thực chi hoàn tiền & tải UNC.',
        data: updated.rows[0],
      });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('[Cancel-Approve Reservation Error]:', err);
      res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi máy chủ khi phê duyệt hủy giữ chỗ.' });
    } finally {
      await release();
    }
  }
);

/**
 * POST /api/v1/reservations/:id/cancel-reject
 * Bước 2b: OWNER (hoặc người duyệt Four-Eyes dự phòng) từ chối đề xuất hủy giữ chỗ
 * Khôi phục EXPIRED (nếu hold_until < today hoặc trước đó là EXPIRED) hoặc HELD.
 */
router.post(
  '/:id/cancel-reject',
  authenticateToken,
  requireRole(['OWNER', 'MANAGER', 'SYS_ADMIN']),
  idempotencyGuard(),
  async (req, res) => {
    const { id } = req.params;
    const trimmedReason = String(req.body?.reason || '').trim();
    if (!trimmedReason) {
      return res.status(400).json({
        code: 'REASON_REQUIRED',
        message: 'Vui lòng cung cấp lý do từ chối đề xuất hủy giữ chỗ.',
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
      const preRow = rsvExist.rows[0];

      const approverAccess = await canActAsReservationApprover(req, preRow, 'reservation cancel-reject');
      if (!approverAccess.ok) {
        return res.status(403).json({
          code: approverAccess.code,
          message: approverAccess.message,
        });
      }

      if (preRow.status !== 'CANCEL_PENDING_APPROVAL') {
        return res.status(409).json({
          code: 'INVALID_STATUS',
          message: `Phiếu giữ chỗ đang ở trạng thái ${preRow.status}, chỉ phiếu CANCEL_PENDING_APPROVAL mới được từ chối duyệt.`,
        });
      }

      await client.query('BEGIN');

      const resCheck = await client.query('SELECT * FROM reservation WHERE id = $1 FOR UPDATE', [id]);
      if (resCheck.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          code: 'INVALID_STATUS',
          message: 'Phiếu giữ chỗ không còn ở trạng thái chờ phê duyệt.',
        });
      }
      const currentRes = resCheck.rows[0];
      if (currentRes.status !== 'CANCEL_PENDING_APPROVAL') {
        await client.query('ROLLBACK');
        return res.status(409).json({
          code: 'INVALID_STATUS',
          message: `Phiếu giữ chỗ đang ở trạng thái ${currentRes.status}, chỉ phiếu CANCEL_PENDING_APPROVAL mới được từ chối duyệt.`,
        });
      }

      const proposerId =
        currentRes.cancel_settlement?.proposed_by || currentRes.confirmed_by || currentRes.created_by;
      const fourEyes = await checkFourEyesOrWarn({
        orgId: req.user.org_id,
        actorId: req.user.sub,
        creatorId: proposerId,
        entity: 'reservation',
        entityId: id,
        actionContext: 'RESERVATION_CANCEL_REJECT',
      });
      if (!fourEyes.allowed) {
        await client.query('ROLLBACK');
        return res.status(403).json({
          code: 'FOUR_EYES_VIOLATION',
          message:
            'Quy tắc 4 mắt (Four-eyes): Người duyệt / từ chối đề xuất hủy giữ chỗ phải khác người lập đề xuất.',
        });
      }

      const todayStr = getTodayVnDateStr();
      const holdUntilStr = currentRes.hold_until ? getTodayVnDateStr(currentRes.hold_until) : null;
      const prevStatus = currentRes.cancel_settlement?.previous_status;
      const restoredStatus =
        prevStatus === 'EXPIRED' || (holdUntilStr && holdUntilStr < todayStr) ? 'EXPIRED' : 'HELD';

      const nowIso = new Date().toISOString();
      const mergedSettlement = {
        ...(currentRes.cancel_settlement && typeof currentRes.cancel_settlement === 'object'
          ? currentRes.cancel_settlement
          : {}),
        rejected_by: req.user.sub,
        rejected_at: nowIso,
        rejected_reason: trimmedReason,
      };

      const updated = await client.query(
        `UPDATE reservation
         SET status = $2,
             refunded_amount = 0,
             forfeited_amount = 0,
             cancel_settlement = $3::jsonb,
             note = COALESCE(NULLIF(note, '') || E'\n', '') || $4,
             updated_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [
          id,
          restoredStatus,
          JSON.stringify(mergedSettlement),
          `[Từ chối đề xuất hủy giữ chỗ]: ${trimmedReason}`,
        ]
      );

      await client.query('SELECT fn_sync_apartment_status_after_reservation($1)', [currentRes.apartment_id]);

      await client.query('SELECT fn_notify_reservation_staff($1, $2, $3, $4, $5)', [
        id,
        'BUILDING_MANAGERS',
        'RESERVATION_CANCEL_REJECTED',
        'Đề xuất thanh lý hủy giữ chỗ bị từ chối',
        `Đề xuất hủy giữ chỗ khách ${currentRes.prospect_name} bị từ chối: ${trimmedReason}`,
      ]);

      await client.query(
        `INSERT INTO audit_log (actor_id, action, entity, entity_id, before, after)
         VALUES ($1, 'CANCEL_SETTLE_REJECT', 'reservation', $2, $3, $4)`,
        [
          req.user.sub,
          id,
          JSON.stringify(currentRes),
          JSON.stringify({
            reservation: updated.rows[0],
            restored_status: restoredStatus,
            rejected_by: req.user.sub,
            reason: trimmedReason,
          }),
        ]
      );

      await client.query('COMMIT');
      res.json({
        message: 'Đã từ chối đề xuất thanh lý hủy giữ chỗ.',
        data: updated.rows[0],
      });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('[Cancel-Reject Reservation Error]:', err);
      res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi máy chủ khi từ chối đề xuất hủy giữ chỗ.' });
    } finally {
      await release();
    }
  }
);

/**
 * POST /api/v1/reservations/:id/cancel-payout
 * Bước 3: MANAGER thực chi hoàn tiền giữ chỗ & tải chứng từ UNC (PRD 6.2 & 7.5)
 */
router.post(
  '/:id/cancel-payout',
  authenticateToken,
  requireRole(['MANAGER']),
  idempotencyGuard(),
  async (req, res) => {
    const { id } = req.params;
    const {
      refund_method,
      refund_bank_info,
      refund_evidence = [],
      reference_code,
      note,
    } = req.body || {};

    const { client, release } = await getUserClient(req);
    try {
      const rsvExist = await adminPool.query(
        `SELECT r.* FROM reservation r WHERE r.id = $1 AND r.org_id = $2`,
        [id, req.user.org_id]
      );
      if (rsvExist.rows.length === 0) {
        return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy hồ sơ giữ chỗ.' });
      }
      const preRow = rsvExist.rows[0];

      const mgrIds = await getManagerBuildingIds(req.user.sub, req.user.org_id);
      if (!mgrIds.includes(preRow.building_id)) {
        await logAccessDenied(req, 'reservation', id, 'MANAGER attempted cancel-payout on unassigned building');
        return res.status(403).json({
          code: 'FORBIDDEN_BUILDING',
          message: 'Bạn không có quyền quản lý tòa nhà của hồ sơ giữ chỗ này.',
        });
      }

      if (preRow.status !== 'APPROVED_PENDING_PAYOUT' || Number(preRow.refunded_amount || 0) <= 0) {
        return res.status(409).json({
          code: 'INVALID_STATUS',
          message: `Phiếu giữ chỗ đang ở trạng thái ${preRow.status}, chỉ phiếu APPROVED_PENDING_PAYOUT có số tiền hoàn > 0 mới được thực chi.`,
        });
      }

      await client.query('BEGIN');

      const resCheck = await client.query('SELECT * FROM reservation WHERE id = $1 FOR UPDATE', [id]);
      if (resCheck.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          code: 'INVALID_STATUS',
          message: 'Phiếu giữ chỗ không còn ở trạng thái chờ chi hoàn.',
        });
      }
      const currentRes = resCheck.rows[0];
      const refundAmt = Number(currentRes.refunded_amount || 0);
      const forfeitAmt = Number(currentRes.forfeited_amount || 0);
      if (currentRes.status !== 'APPROVED_PENDING_PAYOUT' || refundAmt <= 0) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          code: 'INVALID_STATUS',
          message: `Phiếu giữ chỗ đang ở trạng thái ${currentRes.status}, chỉ phiếu APPROVED_PENDING_PAYOUT có số tiền hoàn > 0 mới được thực chi.`,
        });
      }

      const effectiveMethod = String(
        refund_method || currentRes.refund_method || 'BANK_TRANSFER'
      )
        .trim()
        .toUpperCase();

      const bodyBankPayload =
        refund_bank_info !== undefined ? extractReservationBankPayload(refund_bank_info) : null;
      const candidateBankInfo =
        bodyBankPayload && Object.keys(bodyBankPayload).length > 0
          ? bodyBankPayload
          : currentRes.refund_bank_info || {};

      const bankCheck = validateRefundBankInfo({
        refundAmount: refundAmt,
        refundMethod: effectiveMethod,
        bankInfo: candidateBankInfo,
      });
      if (!bankCheck.ok) {
        await client.query('ROLLBACK');
        return res.status(422).json({
          code: bankCheck.code,
          message: bankCheck.message,
        });
      }
      const normalizedBankInfo =
        effectiveMethod === 'BANK_TRANSFER' ? bankCheck.normalizedBankInfo : currentRes.refund_bank_info;

      if (effectiveMethod === 'BANK_TRANSFER') {
        const validEv = Array.isArray(refund_evidence)
          ? refund_evidence.filter((item) => typeof item === 'string' && item.trim().length > 0)
          : [];
        if (validEv.length === 0) {
          await client.query('ROLLBACK');
          return res.status(422).json({
            code: 'REFUND_EVIDENCE_REQUIRED',
            message:
              'Chi hoàn tiền giữ chỗ qua chuyển khoản ngân hàng (BANK_TRANSFER) bắt buộc đính kèm ít nhất 01 ảnh chứng từ UNC (PRD 7.5).',
          });
        }
      }

      let savedRefundEvidence = Array.isArray(currentRes.refund_evidence) ? currentRes.refund_evidence : [];
      if (Array.isArray(refund_evidence) && refund_evidence.length > 0) {
        savedRefundEvidence = await persistReservationEvidence(client, req, id, refund_evidence, {
          allowExistingAttachmentUrls: true,
        });
      }

      const nextStatus = forfeitAmt === 0 ? 'REFUNDED' : 'PARTIALLY_REFUNDED';
      const nowIso = new Date().toISOString();
      const trimmedRef = reference_code ? String(reference_code).trim() : null;
      const trimmedNote = note ? String(note).trim() : '';
      const mergedSettlement = {
        ...(currentRes.cancel_settlement && typeof currentRes.cancel_settlement === 'object'
          ? currentRes.cancel_settlement
          : {}),
        payout_by: req.user.sub,
        payout_at: nowIso,
        reference_code: trimmedRef,
      };

      const noteLine = `[Đã chi hoàn giữ chỗ]: Hoàn ${refundAmt.toLocaleString('vi-VN')} ₫ (${effectiveMethod})${trimmedRef ? ` — Mã GD: ${trimmedRef}` : ''}${trimmedNote ? ` — ${trimmedNote}` : ''}`;

      const updated = await client.query(
        `UPDATE reservation
         SET status = $2,
             refund_method = $3,
             refund_bank_info = $4,
             refund_evidence = $5,
             cancel_settlement = $6::jsonb,
             note = COALESCE(NULLIF(note, '') || E'\n', '') || $7,
             updated_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [
          id,
          nextStatus,
          effectiveMethod,
          normalizedBankInfo ? JSON.stringify(normalizedBankInfo) : null,
          savedRefundEvidence,
          JSON.stringify(mergedSettlement),
          noteLine,
        ]
      );

      await client.query('SELECT fn_notify_reservation_prospect($1, $2, $3, $4)', [
        id,
        'RESERVATION_CANCEL_SETTLED',
        'Đã hoàn trả tiền đặt giữ chỗ',
        `Ban quản lý đã hoàn trả ${refundAmt.toLocaleString('vi-VN')} ₫ tiền đặt giữ chỗ cho bạn${trimmedRef ? ` (Mã GD: ${trimmedRef})` : ''}.`,
      ]);

      await client.query(
        `INSERT INTO audit_log (actor_id, action, entity, entity_id, before, after)
         VALUES ($1, 'CANCEL_SETTLE_PAYOUT', 'reservation', $2, $3, $4)`,
        [
          req.user.sub,
          id,
          JSON.stringify(currentRes),
          JSON.stringify({
            reservation: updated.rows[0],
            refunded_amount: refundAmt,
            forfeited_amount: forfeitAmt,
            refund_method: effectiveMethod,
            reference_code: trimmedRef,
            payout_by: req.user.sub,
            payout_at: nowIso,
          }),
        ]
      );

      await client.query('COMMIT');
      res.json({
        message: 'Đã xác nhận chi hoàn tiền giữ chỗ và lưu chứng từ UNC thành công.',
        data: updated.rows[0],
      });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      if (err.httpStatus) {
        return res.status(err.httpStatus).json({ code: err.code, message: err.message });
      }
      console.error('[Cancel-Payout Reservation Error]:', err);
      res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi máy chủ khi xác nhận chi hoàn tiền giữ chỗ.' });
    } finally {
      await release();
    }
  }
);

/**
 * PATCH /api/v1/reservations/:id/bank-info
 * Cập nhật thông tin tài khoản nhận hoàn tiền giữ chỗ (MANAGER hoặc RESIDENT trùng SĐT khi đang APPROVED_PENDING_PAYOUT)
 */
router.patch(
  '/:id/bank-info',
  authenticateToken,
  requireRole(['MANAGER', 'RESIDENT']),
  idempotencyGuard(),
  async (req, res) => {
    const { id } = req.params;
    const rawBankPayload = extractReservationBankPayload(req.body);
    const bankCheck = validateRefundBankInfo({
      refundAmount: 1,
      refundMethod: 'BANK_TRANSFER',
      bankInfo: rawBankPayload,
    });
    if (!bankCheck.ok) {
      return res.status(422).json({
        code: bankCheck.code,
        message: bankCheck.message,
      });
    }

    const { client, release } = await getUserClient(req);
    try {
      await client.query('BEGIN');

      const rpcRes = await client.query(
        `SELECT * FROM fn_update_reservation_refund_bank_info($1::uuid, $2::jsonb)`,
        [id, JSON.stringify(bankCheck.normalizedBankInfo)]
      );
      const updated = rpcRes.rows[0];

      const userRoles = getUserRoleCodes(req);
      if (userRoles.includes('RESIDENT') && !userRoles.includes('MANAGER')) {
        await client.query('SELECT fn_notify_reservation_staff($1, $2, $3, $4, $5)', [
          id,
          'BUILDING_MANAGERS',
          'RESERVATION_BANK_INFO_UPDATED',
          'Khách giữ chỗ đã cập nhật tài khoản nhận hoàn tiền',
          `Khách ${updated.prospect_name} đã cập nhật STK nhận hoàn (${bankCheck.normalizedBankInfo.bank_name} - ${bankCheck.normalizedBankInfo.account_number}).`,
        ]);
      }

      await client.query('COMMIT');
      res.json({
        message: 'Đã cập nhật thông tin tài khoản ngân hàng nhận hoàn tiền giữ chỗ.',
        data: updated,
      });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      if (err.code === 'P0002') {
        return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy hồ sơ giữ chỗ.' });
      }
      if (err.code === '42501') {
        await logAccessDenied(req, 'reservation', id, 'Unauthorized reservation bank-info update');
        return res.status(403).json({
          code: 'ACCESS_DENIED',
          message: 'Bạn không có quyền cập nhật thông tin nhận hoàn của hồ sơ giữ chỗ này.',
        });
      }
      if (err.code === 'P0001') {
        return res.status(409).json({
          code: 'INVALID_STATUS_FOR_BANK_UPDATE',
          message: 'Chỉ hồ sơ giữ chỗ đang chờ chi hoàn (APPROVED_PENDING_PAYOUT) mới được cập nhật tài khoản nhận tiền.',
        });
      }
      console.error('[Update Reservation Bank Info Error]:', err);
      res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi khi cập nhật thông tin tài khoản nhận hoàn giữ chỗ.' });
    } finally {
      await release();
    }
  }
);

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
      const preRow = rsvExist.rows[0];
      const approverAccess = await canActAsReservationApprover(req, preRow, 'reservation forfeit');
      if (!approverAccess.ok) {
        return res.status(403).json({
          code: approverAccess.code,
          message: approverAccess.message,
        });
      }

      if (!isReservationSettleable(preRow)) {
        return res.status(400).json({
          code: 'INVALID_STATUS',
          message: `Hồ sơ giữ chỗ đang ở trạng thái ${preRow.status}, chỉ phiếu HELD hoặc EXPIRED đã xác nhận tiền mới được xử lý.`,
        });
      }

      await client.query('BEGIN');

      const resCheck = await client.query('SELECT * FROM reservation WHERE id = $1 FOR UPDATE', [id]);
      if (resCheck.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          code: 'INVALID_STATUS',
          message: 'Phiếu giữ chỗ không còn ở trạng thái cho phép tịch thu.',
        });
      }
      const currentRes = resCheck.rows[0];

      if (!isReservationSettleable(currentRes)) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          code: 'INVALID_STATUS',
          message: `Hồ sơ giữ chỗ đang ở trạng thái ${currentRes.status}, chỉ phiếu HELD hoặc EXPIRED đã xác nhận tiền mới được xử lý.`,
        });
      }

      if (BigInt(currentRes.hold_amount ?? 0) <= 0n) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          code: 'INVALID_HOLD_AMOUNT',
          message: 'Phiếu giữ chỗ không có số dư tiền cọc hợp lệ để tịch thu.',
        });
      }

      const creatorId = currentRes.confirmed_by || currentRes.created_by;
      const fourEyes = await checkFourEyesOrWarn({
        orgId: req.user.org_id,
        actorId: req.user.sub,
        creatorId,
        entity: 'reservation',
        entityId: id,
        actionContext: 'RESERVATION_FORFEIT',
      });
      if (!fourEyes.allowed) {
        await client.query('ROLLBACK');
        return res.status(403).json({
          code: 'FOUR_EYES_VIOLATION',
          message: 'Quy tắc 4 mắt (Four-eyes): Người duyệt tịch thu cọc giữ chỗ phải khác người đã tạo / xác nhận phiếu giữ chỗ.',
        });
      }

      const nowIso = new Date().toISOString();
      const forfeitSettlement = {
        ...(currentRes.cancel_settlement && typeof currentRes.cancel_settlement === 'object'
          ? currentRes.cancel_settlement
          : {}),
        previous_status: currentRes.status,
        approved_by: req.user.sub,
        approved_at: nowIso,
        direct_forfeit_approval: true,
      };

      const updated = await client.query(
        `UPDATE reservation
         SET status = 'FORFEITED',
             refunded_amount = 0,
             forfeited_amount = hold_amount,
             cancel_reason = $3,
             cancel_settlement = $4::jsonb,
             note = COALESCE(NULLIF(note, '') || E'\n', '') || $2,
             updated_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [id, `[Tịch thu cọc]: ${trimmedReason}`, trimmedReason, JSON.stringify(forfeitSettlement)]
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
      await client.query('ROLLBACK').catch(() => {});
      console.error('[Forfeit Reservation Error]:', err);
      res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi ghi nhận hủy giữ chỗ.' });
    } finally {
      await release();
    }
  }
);

/**
 * PATCH /api/v1/reservations/:id/refund
 * Duyệt hoàn 100% tiền giữ chỗ trực tiếp -> chuyển sang APPROVED_PENDING_PAYOUT và mở lại căn hộ (AVAILABLE).
 * BQL (MANAGER) sau đó thực hiện chi hoàn & tải chứng từ UNC tại POST /:id/cancel-payout.
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

    const rawMethod = req.body?.refund_method
      ? String(req.body.refund_method).trim().toUpperCase()
      : null;
    const effectiveMethod = rawMethod && ['BANK_TRANSFER', 'CASH'].includes(rawMethod) ? rawMethod : null;

    let optionalBankInfo = null;
    if (req.body?.refund_bank_info !== undefined) {
      const candidate = extractReservationBankPayload(req.body.refund_bank_info);
      if (Object.keys(candidate).length > 0) {
        const bankCheck = validateRefundBankInfo({
          refundAmount: 1,
          refundMethod: effectiveMethod || 'BANK_TRANSFER',
          bankInfo: candidate,
        });
        if (!bankCheck.ok) {
          return res.status(422).json({
            code: bankCheck.code,
            message: bankCheck.message,
          });
        }
        optionalBankInfo = bankCheck.normalizedBankInfo;
      }
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
      const preRow = rsvExist.rows[0];
      const approverAccess = await canActAsReservationApprover(req, preRow, 'reservation refund');
      if (!approverAccess.ok) {
        return res.status(403).json({
          code: approverAccess.code,
          message: approverAccess.message,
        });
      }

      if (!isReservationSettleable(preRow)) {
        return res.status(400).json({
          code: 'INVALID_STATUS',
          message: `Hồ sơ giữ chỗ đang ở trạng thái ${preRow.status}, chỉ phiếu HELD hoặc EXPIRED đã xác nhận tiền mới được xử lý.`,
        });
      }

      await client.query('BEGIN');

      const resCheck = await client.query('SELECT * FROM reservation WHERE id = $1 FOR UPDATE', [id]);
      if (resCheck.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          code: 'INVALID_STATUS',
          message: 'Phiếu giữ chỗ không còn ở trạng thái cho phép hoàn trả.',
        });
      }
      const currentRes = resCheck.rows[0];

      if (!isReservationSettleable(currentRes)) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          code: 'INVALID_STATUS',
          message: `Hồ sơ giữ chỗ đang ở trạng thái ${currentRes.status}, chỉ phiếu HELD hoặc EXPIRED đã xác nhận tiền mới được xử lý.`,
        });
      }

      if (BigInt(currentRes.hold_amount ?? 0) <= 0n) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          code: 'INVALID_HOLD_AMOUNT',
          message: 'Phiếu giữ chỗ không có số dư tiền cọc hợp lệ để hoàn trả.',
        });
      }

      const creatorId = currentRes.confirmed_by || currentRes.created_by;
      const fourEyes = await checkFourEyesOrWarn({
        orgId: req.user.org_id,
        actorId: req.user.sub,
        creatorId,
        entity: 'reservation',
        entityId: id,
        actionContext: 'RESERVATION_REFUND',
      });
      if (!fourEyes.allowed) {
        await client.query('ROLLBACK');
        return res.status(403).json({
          code: 'FOUR_EYES_VIOLATION',
          message: 'Quy tắc 4 mắt (AC-017 / Four-eyes): Người duyệt hoàn cọc giữ chỗ phải khác người đã tạo / xác nhận hồ sơ giữ chỗ (Chủ sở hữu, Quản lý khác hoặc SYS_ADMIN dự phòng).',
        });
      }

      const nowIso = new Date().toISOString();
      const refundSettlement = {
        ...(currentRes.cancel_settlement && typeof currentRes.cancel_settlement === 'object'
          ? currentRes.cancel_settlement
          : {}),
        previous_status: currentRes.status,
        approved_by: req.user.sub,
        approved_at: nowIso,
        direct_refund_approval: true,
      };

      const updated = await client.query(
        `UPDATE reservation
         SET status = 'APPROVED_PENDING_PAYOUT',
             refunded_amount = hold_amount,
             forfeited_amount = 0,
             cancel_reason = $3,
             refund_method = COALESCE($4, refund_method, 'BANK_TRANSFER'),
             refund_bank_info = COALESCE($5::jsonb, refund_bank_info),
             cancel_settlement = $6::jsonb,
             note = COALESCE(NULLIF(note, '') || E'\n', '') || $2,
             updated_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [
          id,
          `[Duyệt hoàn 100% cọc giữ chỗ — Chờ BQL chi hoàn]: ${trimmedReason}`,
          trimmedReason,
          effectiveMethod,
          optionalBankInfo ? JSON.stringify(optionalBankInfo) : null,
          JSON.stringify(refundSettlement),
        ]
      );

      await client.query('SELECT fn_sync_apartment_status_after_reservation($1)', [currentRes.apartment_id]);

      await client.query('SELECT fn_notify_reservation_staff($1, $2, $3, $4, $5)', [
        id,
        'BUILDING_MANAGERS',
        'RESERVATION_CANCEL_APPROVED_FOR_PAYOUT',
        'Đã duyệt hoàn 100% cọc giữ chỗ — Chờ chi hoàn & tải UNC',
        `Phiếu giữ chỗ khách ${currentRes.prospect_name} đã được duyệt hoàn ${Number(currentRes.hold_amount).toLocaleString('vi-VN')} ₫. Vui lòng thực chi và tải chứng từ UNC.`,
      ]);

      await client.query('SELECT fn_notify_reservation_prospect($1, $2, $3, $4)', [
        id,
        'RESERVATION_CANCEL_APPROVED',
        'Đã duyệt hoàn trả 100% tiền giữ chỗ',
        `Yêu cầu hoàn trả ${Number(currentRes.hold_amount).toLocaleString('vi-VN')} ₫ tiền giữ chỗ đã được phê duyệt. Vui lòng kiểm tra / cập nhật số tài khoản nhận hoàn để Ban quản lý chuyển khoản.`,
      ]);

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
            approved_at: nowIso,
            reason: trimmedReason,
            note: 'Phê duyệt hoàn trả 100% tiền đặt cọc giữ chỗ — chờ BQL chi hoàn kèm UNC',
          }),
        ]
      );

      await client.query('COMMIT');
      res.json({
        message: 'Đã phê duyệt hoàn trả 100% tiền giữ chỗ và mở lại căn hộ. Chờ BQL thực chi hoàn tiền & tải UNC.',
        data: updated.rows[0],
      });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('[Refund Reservation Error]:', err);
      res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi hoàn tiền giữ chỗ.' });
    } finally {
      await release();
    }
  }
);

export default router;
