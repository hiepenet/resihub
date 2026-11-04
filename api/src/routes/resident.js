import crypto from 'node:crypto';
import express from 'express';
import { pool, adminPool, getUserClient } from '../db/client.js';
import { authenticateToken } from '../middleware/auth.js';
import { requireRole } from '../middleware/rbac.js';
import { idempotencyGuard } from '../middleware/idempotency.js';
import { saveBase64Image } from '../services/imageUpload.js';
import { roundVND } from '../services/pricing.js';
import { normalizeVnPhone } from '../services/residentAccount.js';
import { validateAndNormalizeSubscriptionMeta } from '../services/serviceSubscriptionMeta.js';
import {
  todayVietnamYmd,
  addDaysYmd,
  toDateOnlyYmd,
  resolveServiceUnitPrice,
  computeSubscriptionPeriodCharge,
} from '../services/serviceBilling.js';
import {
  SERVICE_REQUEST_OPEN_STATUSES,
  PREFERRED_SLOT_CODES,
  buildServiceRequestTrackingPrefix,
  computeServiceRequestSlaDeadlines,
  isWithinDuplicateWindow,
  validateServiceRequestTransition,
} from '../services/serviceRequestRules.js';
import { triggerAsyncTicketTriage } from '../services/aiGateway.js';
import { notifyBuildingManagers } from '../services/notificationService.js';

const router = express.Router();

const SR_CATEGORIES = ['ELECTRICAL', 'PLUMBING', 'HVAC', 'FURNITURE', 'APPLIANCE', 'CLEANING', 'SECURITY', 'OTHER'];
const SR_PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT'];

const RESIDENT_SR_SAFE_COLUMNS = `
  sr.id, sr.org_id, sr.building_id, sr.apartment_id, sr.tenant_id, sr.created_by, sr.assigned_to,
  sr.tracking_code, sr.category, sr.title, sr.description, sr.location_detail, sr.preferred_slot,
  sr.priority, sr.status, sr.images,
  sr.sla_response_due_at, sr.sla_due_at, sr.first_responded_at, sr.sla_breached_at,
  sr.hold_reason, sr.next_appointment_at,
  sr.resolution_note, sr.resolution_images, sr.resolved_at,
  sr.reopened_at, sr.reopen_reason, sr.reopen_count, sr.cancelled_reason,
  sr.rating, sr.rating_note, sr.created_at, sr.updated_at,
  (sr.status IN ('NEW', 'ASSIGNED', 'IN_PROGRESS', 'ON_HOLD', 'REOPENED')
   AND sr.sla_due_at IS NOT NULL AND sr.sla_due_at < NOW()) AS is_sla_overdue
`;

function sanitizeResidentServiceRequest(row) {
  if (!row || typeof row !== 'object') return row;
  const {
    internal_note: _omittedInternalNote,
    ai_suggestion_id: _omittedAiSuggestionId,
    ai_triage_status: _omittedAiTriageStatus,
    ai_suggested_category: _omittedAiCategory,
    ai_suggested_priority: _omittedAiPriority,
    ai_suggested_assignee_id: _omittedAiAssignee,
    ai_summary: _omittedAiSummary,
    ai_confidence: _omittedAiConfidence,
    ...safeRow
  } = row;
  return safeRow;
}

function buildTrackingCodeCandidate(attempt = 0) {
  const prefix = buildServiceRequestTrackingPrefix(new Date());
  if (attempt < 3) {
    return `${prefix}${Math.floor(1000 + Math.random() * 9000)}`;
  }
  return `${prefix}${Math.floor(10000 + Math.random() * 90000)}`;
}

async function loadResidentOrgSlaConfig(queryFn, orgId) {
  if (!orgId) return {};
  const res = await queryFn(
    `SELECT value FROM system_setting WHERE org_id = $1 AND key = 'sla_config' LIMIT 1`,
    [orgId]
  );
  return res.rows[0]?.value || {};
}

async function findResidentAccessibleServiceRequest(queryFn, srId, reqUser) {
  const res = await queryFn(
    `SELECT sr.*, a.code AS apartment_code, b.name AS building_name
     FROM service_request sr
     JOIN apartment a ON a.id = sr.apartment_id
     JOIN building b ON b.id = sr.building_id
     WHERE sr.id = $1
       AND (
         sr.created_by = $2
         OR sr.apartment_id IN (
           SELECT c.apartment_id
           FROM contract c
           WHERE c.status IN ('ACTIVE', 'RENEWAL_PENDING', 'TERMINATION_PENDING')
             AND (
               EXISTS (SELECT 1 FROM tenant t WHERE t.id = c.primary_tenant_id AND t.person_id = $3)
               OR EXISTS (
                 SELECT 1 FROM contract_occupant co
                 JOIN tenant tocc ON tocc.id = co.tenant_id
                 WHERE co.contract_id = c.id AND tocc.person_id = $3
               )
             )
         )
       )
     LIMIT 1`,
    [srId, reqUser.sub, reqUser.person_id]
  );
  return res.rows[0] || null;
}

/**
 * GET /api/v1/resident/overview
 * Cung cấp dữ liệu tổng hợp Cổng cư dân (P1, P2, P7, P8):
 * - Thông tin cá nhân (bao gồm address, nationality, avatar_url)
 * - Hợp đồng hiện tại + chuỗi lịch sử hợp đồng (parent_contract_id) + phụ lục
 * - Số tiền phải trả hiện tại (AC-002.1) & hóa đơn gần nhất
 * - Đặt cọc giữ chỗ, hồ sơ chờ duyệt, căn hộ trống, danh bạ BQL & cấu hình liên hệ
 */
router.get('/overview', authenticateToken, async (req, res) => {
  try {
    const personId = req.user.person_id;
    const orgId = req.user.org_id;

    // 1. Lấy thông tin person (kèm trạng thái đồng ý dữ liệu cá nhân & ảnh CCCD)
    const personRes = await pool.query(
      'SELECT id, full_name, phone, email, dob, id_number, address, nationality, avatar_url, privacy_consent_at, privacy_policy_version, id_images FROM person WHERE id = $1',
      [personId]
    );
    const personRow = personRes.rows[0] || null;
    const user = personRow
      ? {
          id: personRow.id,
          full_name: personRow.full_name,
          phone: personRow.phone,
          email: personRow.email,
          dob: personRow.dob,
          id_number: personRow.id_number,
          address: personRow.address,
          nationality: personRow.nationality,
          avatar_url: personRow.avatar_url,
          privacy_consent_at: personRow.privacy_consent_at,
          privacy_policy_version: personRow.privacy_policy_version,
        }
      : {
          full_name: req.user.full_name || req.user.name || 'Cư dân',
          phone: req.user.phone || '',
          email: req.user.email || '',
        };

    let idImages = [];
    if (personId) {
      const attRes = await pool.query(
        `SELECT id AS attachment_id, mime FROM attachment
         WHERE owner_entity = 'person' AND owner_id = $1
         ORDER BY created_at ASC`,
        [personId]
      );
      const markers = (personRow?.id_images || [])
        .map((m) => {
          try {
            return JSON.parse(m);
          } catch {
            return null;
          }
        })
        .filter(Boolean);
      idImages = attRes.rows.map((img) => ({
        attachment_id: img.attachment_id,
        side: markers.find((m) => m.attachmentId === img.attachment_id)?.side || 'unknown',
      }));
    }

    const userPhone = user.phone || '';
    const cleanPhone = userPhone.startsWith('+84') ? '0' + userPhone.slice(3) : userPhone;

    // 2. Danh sách toàn bộ hợp đồng đang mở (ACTIVE / RENEWAL_PENDING / TERMINATION_PENDING) hỗ trợ đa căn hộ (Điểm 3)
    const contractRes = await pool.query(
      `SELECT 
         c.id as contract_id,
         c.parent_contract_id,
         c.start_date,
         c.end_date,
         c.terminated_at,
         c.rent_amount,
         c.billing_cycle,
         c.billing_day,
         c.payment_due_days,
         c.deposit_amount,
         c.status as contract_status,
         c.note as contract_note,
         c.created_at as contract_created_at,
         (c.start_date > CURRENT_DATE) as is_future_contract,
         a.id as apartment_id,
         a.code as apartment_code,
         a.area_m2,
         a.bedrooms,
         a.type as apartment_type,
         a.amenities,
         b.id as building_id,
         b.name as building_name,
         b.code as building_code,
         b.address as building_address,
         f.name as floor_name,
         d.id as deposit_id,
         d.amount_held as deposit_held_amount,
         d.status as deposit_status,
         d.settlement as deposit_settlement,
         d.refund_due_date as deposit_refund_due_date
       FROM contract c
       JOIN tenant t ON t.id = c.primary_tenant_id
       JOIN apartment a ON a.id = c.apartment_id
       JOIN building b ON b.id = c.building_id
       LEFT JOIN floor f ON f.id = a.floor_id
       LEFT JOIN deposit d ON d.contract_id = c.id
       WHERE t.person_id = $1 AND c.status IN ('ACTIVE', 'RENEWAL_PENDING', 'TERMINATION_PENDING')
       ORDER BY (CASE WHEN c.start_date <= CURRENT_DATE AND COALESCE(c.terminated_at, c.end_date) > CURRENT_DATE THEN 0 ELSE 1 END),
                c.start_date ASC,
                c.created_at DESC`,
      [personId]
    );

    const activeContracts = contractRes.rows;
    const requestedContractId = req.query.contract_id ? String(req.query.contract_id).trim() : null;
    const contract =
      (requestedContractId
        ? activeContracts.find((item) => item.contract_id === requestedContractId)
        : null) ||
      activeContracts[0] ||
      null;
    const hasContract = !!contract;

    // 2b. Lịch sử toàn bộ hợp đồng (bao gồm HĐ cũ đã gia hạn / kết thúc) & phụ lục & hồ sơ tất toán cọc
    const contractHistoryRes = await pool.query(
      `SELECT c.id, c.parent_contract_id, c.start_date, c.end_date, c.terminated_at, c.rent_amount, c.deposit_amount, c.status,
              a.code as apartment_code, b.name as building_name, c.created_at,
              d.id as deposit_id, d.amount_held as deposit_held_amount, d.status as deposit_status,
              d.settlement as deposit_settlement, d.refund_due_date as deposit_refund_due_date
       FROM contract c
       JOIN tenant t ON t.id = c.primary_tenant_id
       JOIN apartment a ON a.id = c.apartment_id
       JOIN building b ON b.id = c.building_id
       LEFT JOIN deposit d ON d.contract_id = c.id
       WHERE t.person_id = $1
       ORDER BY c.start_date DESC`,
      [personId]
    );
    const depositSettlements = contractHistoryRes.rows
      .filter(
        (r) =>
          r.deposit_id &&
          (r.deposit_settlement ||
            [
              'SETTLEMENT_DRAFT',
              'PENDING_APPROVAL',
              'APPROVED_PENDING_PAYOUT',
              'DISPUTED',
              'PARTIALLY_REFUNDED',
              'REFUNDED',
              'DEDUCTED_FULL',
              'RETURNED',
            ].includes(r.deposit_status))
      )
      .map((r) => ({
        deposit_id: r.deposit_id,
        contract_id: r.id,
        contract_status: r.status,
        apartment_code: r.apartment_code,
        building_name: r.building_name,
        amount_held: r.deposit_held_amount,
        deposit_status: r.deposit_status,
        refund_due_date: r.deposit_refund_due_date,
        settlement: r.deposit_settlement,
      }));

    let amendments = [];
    if (contract) {
      const amendRes = await pool.query(
        `SELECT cv.id, cv.version_no, cv.diff, cv.effective_from, cv.reason, cv.created_at
         FROM contract_version cv
         WHERE cv.contract_id = $1
           AND COALESCE(cv.diff->>'status', '') <> 'INITIAL_SNAPSHOT'
         ORDER BY cv.version_no DESC`,
        [contract.contract_id]
      );
      amendments = amendRes.rows;
    }

    // 2c. AC-002.1: Số tiền phải trả hiện tại (tách theo căn đang chọn + tổng dư nợ toàn bộ căn hộ)
    const totalDebtAllRes = await pool.query(
      `SELECT COALESCE(SUM(i.total_amount - i.paid_amount), 0)::bigint AS invoice_due
       FROM invoice i
       JOIN tenant t ON t.id = i.tenant_id
       WHERE t.person_id = $1
         AND i.status IN ('ISSUED', 'ADJUSTED', 'PARTIALLY_PAID', 'OVERDUE')`,
      [personId]
    );
    const totalAmountDueAll = Number(totalDebtAllRes.rows[0]?.invoice_due || 0);

    let currentAmountDue = totalAmountDueAll;
    let latestInvoice = null;
    if (contract) {
      const contractDebtRes = await pool.query(
        `SELECT COALESCE(SUM(i.total_amount - i.paid_amount), 0)::bigint AS invoice_due
         FROM invoice i
         JOIN tenant t ON t.id = i.tenant_id
         WHERE t.person_id = $1
           AND i.contract_id = $2
           AND i.status IN ('ISSUED', 'ADJUSTED', 'PARTIALLY_PAID', 'OVERDUE')`,
        [personId, contract.contract_id]
      );
      currentAmountDue = Number(contractDebtRes.rows[0]?.invoice_due || 0);

      const latestInvRes = await pool.query(
        `SELECT i.id, i.invoice_code, i.period, i.due_date, i.total_amount, i.paid_amount, i.status
         FROM invoice i
         JOIN tenant t ON t.id = i.tenant_id
         WHERE t.person_id = $1 AND i.contract_id = $2 AND i.status NOT IN ('DRAFT', 'VOID')
         ORDER BY i.period DESC, i.created_at DESC
         LIMIT 1`,
        [personId, contract.contract_id]
      );
      latestInvoice = latestInvRes.rows[0] || null;
    } else {
      const latestInvRes = await pool.query(
        `SELECT i.id, i.invoice_code, i.period, i.due_date, i.total_amount, i.paid_amount, i.status
         FROM invoice i
         JOIN tenant t ON t.id = i.tenant_id
         WHERE t.person_id = $1 AND i.status NOT IN ('DRAFT', 'VOID')
         ORDER BY i.period DESC, i.created_at DESC
         LIMIT 1`,
        [personId]
      );
      latestInvoice = latestInvRes.rows[0] || null;
    }

    let availableCreditBalance = 0;
    if (contract) {
      const creditRes = await pool.query(
        `SELECT COALESCE(SUM(amount - applied_amount), 0)::bigint AS available_credit
         FROM credit_balance
         WHERE contract_id = $1
           AND status IN ('AVAILABLE', 'PARTIALLY_APPLIED')
           AND (amount - applied_amount) > 0`,
        [contract.contract_id]
      );
      availableCreditBalance = Number(creditRes.rows[0]?.available_credit || 0);
    } else if (personId) {
      const creditRes = await pool.query(
        `SELECT COALESCE(SUM(cb.amount - cb.applied_amount), 0)::bigint AS available_credit
         FROM credit_balance cb
         JOIN tenant t ON t.id = cb.tenant_id
         WHERE t.person_id = $1
           AND cb.status IN ('AVAILABLE', 'PARTIALLY_APPLIED')
           AND (cb.amount - cb.applied_amount) > 0`,
        [personId]
      );
      availableCreditBalance = Number(creditRes.rows[0]?.available_credit || 0);
    }

    // 3. Đặt cọc giữ chỗ (trả cả danh sách reservations lẫn bản ghi mới nhất reservation)
    let reservations = [], reservationHistory = [];
    if (cleanPhone) {
      const reservationRes = await pool.query(
        `SELECT 
           r.id as reservation_id,
           r.prospect_name,
           r.hold_from,
           r.hold_amount,
           r.hold_until,
           r.status as reservation_status,
           r.source, r.method, r.evidence, r.rejected_reason, r.refunded_amount, r.forfeited_amount, r.cancel_reason, r.confirmed_at, r.note as reservation_note,
           r.refund_method, r.refund_bank_info, r.refund_evidence, r.cancel_settlement,
           r.created_at as reservation_created_at,
           a.id as apartment_id,
           a.code as apartment_code,
           a.area_m2,
           a.bedrooms,
           a.type as apartment_type,
           a.amenities,
           a.base_rent,
           f.name as floor_name,
           b.id as building_id,
           b.name as building_name,
           b.code as building_code,
           b.address as building_address
         FROM reservation r
         JOIN apartment a ON a.id = r.apartment_id
         JOIN building b ON b.id = r.building_id
         LEFT JOIN floor f ON f.id = a.floor_id
         WHERE r.org_id = $3
           AND (r.phone = $1 OR r.phone = $2)
           AND r.status IS NOT NULL
         ORDER BY r.created_at DESC`,
        [cleanPhone, userPhone, orgId]
      );
      reservationHistory = reservationRes.rows;
      const activeRsvStatuses = ['HELD', 'PENDING_CONFIRM', 'CANCEL_PENDING_APPROVAL', 'APPROVED_PENDING_PAYOUT'];
      const rsvRank = (st) => (st === 'HELD' ? 0 : st === 'APPROVED_PENDING_PAYOUT' ? 1 : st === 'CANCEL_PENDING_APPROVAL' ? 2 : 3);
      reservations = reservationHistory
        .filter((r) => activeRsvStatuses.includes(r.reservation_status))
        .sort(
          (a, b) =>
            rsvRank(a.reservation_status) - rsvRank(b.reservation_status) ||
            new Date(b.reservation_created_at).getTime() - new Date(a.reservation_created_at).getTime()
        );
    }
    const reservation = reservations[0] || null;

    // 4. Hồ sơ tự khai (PENDING / APPROVED chưa lên HĐ / REJECTED)
    // Dùng adminPool với điều kiện chặt t.person_id = $1 AND t.org_id = $2 để luôn lấy được mã căn/tên tòa mong muốn
    // ngay cả khi cư dân chưa có phiếu giữ chỗ (RLS chặn đọc trực tiếp bảng apartment/building trống).
    const onboardingAppRes = personId
      ? await adminPool.query(
          `SELECT t.id, t.status, t.desired_apartment_id, t.desired_building_id,
                  t.application_note, t.rejection_reason, t.created_at, t.updated_at,
                  da.code AS desired_apartment_code,
                  db.name AS desired_building_name
           FROM tenant t
           LEFT JOIN apartment da ON da.id = t.desired_apartment_id
           LEFT JOIN building db ON db.id = t.desired_building_id
           WHERE t.person_id = $1
             AND t.org_id = $2
             AND (
               t.status IN ('PENDING', 'REJECTED')
               OR (
                 t.status = 'APPROVED'
                 AND NOT EXISTS (SELECT 1 FROM contract c WHERE c.primary_tenant_id = t.id)
               )
             )
           ORDER BY (CASE WHEN t.status IN ('PENDING', 'REJECTED') THEN 0 ELSE 1 END) ASC,
                    t.updated_at DESC NULLS LAST,
                    t.created_at DESC
           LIMIT 1`,
          [personId, orgId]
        )
      : { rows: [] };
    const onboardingApplication = onboardingAppRes.rows[0] || null;
    const pendingApplication = onboardingApplication?.status === 'PENDING' ? onboardingApplication : null;

    // 5. Danh sách căn hộ trống khả dụng (bao gồm các căn hộ chính khách đang đặt cọc giữ chỗ nếu có)
    const reservedApartmentIds = reservations.map((r) => r.apartment_id).filter(Boolean);
    const availableAptsRes = await adminPool.query(
      `SELECT 
         a.id, a.code, a.area_m2, a.type, a.bedrooms, a.base_rent, a.amenities, a.status,
         b.id as building_id, b.name as building_name, b.address as building_address,
         f.name as floor_name
       FROM apartment a
       JOIN building b ON b.id = a.building_id
       LEFT JOIN floor f ON f.id = a.floor_id
       WHERE b.status = 'ACTIVE' AND b.org_id = $1
         AND (a.status = 'AVAILABLE' OR (CARDINALITY($2::uuid[]) > 0 AND a.id = ANY($2::uuid[])))
       ORDER BY (CASE WHEN CARDINALITY($2::uuid[]) > 0 AND a.id = ANY($2::uuid[]) THEN 0 ELSE 1 END) ASC,
                b.name ASC, a.code ASC
       LIMIT 12`,
      [orgId, reservedApartmentIds]
    );

    // 6. Danh bạ BQL & Cấu hình liên hệ từ system_setting (P7)
    const targetBuildingId = contract?.building_id || reservation?.building_id || null;
    let managerContactRes;
    if (targetBuildingId) {
      managerContactRes = await adminPool.query(
        `SELECT p.full_name, p.phone, p.email, b.name as building_name, b.address as building_address
         FROM user_role ur
         JOIN role r ON r.id = ur.role_id
         JOIN app_user au ON au.id = ur.user_id
         JOIN person p ON p.id = au.person_id
         JOIN building b ON b.id = ur.building_id
         WHERE r.code = 'MANAGER' AND ur.building_id = $1
         LIMIT 1`,
        [targetBuildingId]
      );
    }
    if (!managerContactRes || managerContactRes.rows.length === 0) {
      managerContactRes = await adminPool.query(
        `SELECT p.full_name, p.phone, p.email, b.name as building_name, b.address as building_address
         FROM user_role ur
         JOIN role r ON r.id = ur.role_id
         JOIN app_user au ON au.id = ur.user_id
         JOIN person p ON p.id = au.person_id
         LEFT JOIN building b ON b.id = ur.building_id
         WHERE r.code = 'MANAGER' AND p.org_id = $1
         LIMIT 1`,
        [orgId]
      );
    }

    const settingRes = await adminPool.query(
      `SELECT value FROM system_setting WHERE org_id = $1 AND key = 'contact_config' LIMIT 1`,
      [orgId]
    );
    const contactConfig = settingRes.rows[0]?.value || {
      working_hours: '08:00 – 18:00 (Thứ 2 – Thứ 7)',
      technical_hotline: '1900 6868',
      security_hotline: '1900 9119',
      emergency_phone: '0909 113 114',
      support_email: 'support@resihub.vn',
    };

    const managerContact = {
      ...(managerContactRes.rows[0] || {
        full_name: 'Ban Quản Lý ResiHub',
        phone: '0901234567',
        email: 'manager@resihub.vn',
      }),
      ...contactConfig,
    };

    res.json({
      data: {
        user,
        has_contract: hasContract,
        selected_contract_id: contract?.contract_id || null,
        active_contracts: activeContracts,
        active_contract: contract,
        contract,
        contract_history: contractHistoryRes.rows,
        deposit_settlements: depositSettlements,
        amendments,
        current_amount_due: currentAmountDue,
        total_amount_due_all: totalAmountDueAll,
        latest_invoice: latestInvoice,
        available_credit_balance: availableCreditBalance,
        reservation,
        reservations, reservation_history: reservationHistory,
        pending_application: pendingApplication,
        onboarding_application: onboardingApplication,
        id_images: idImages,
        available_apartments: availableAptsRes.rows,
        manager_contact: managerContact,
      },
    });
  } catch (err) {
    console.error('Lỗi lấy dữ liệu cổng cư dân:', err);
    res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi tải dữ liệu cổng cư dân.' });
  }
});

/**
 * POST /api/v1/resident/id-images (FR-012)
 * Cho phép cư dân tải lên ảnh CCCD mặt trước / mặt sau của chính mình
 */
router.post('/id-images', authenticateToken, async (req, res) => {
  const { image_base64, side } = req.body;
  const personId = req.user.person_id;

  if (!['front', 'back'].includes(side)) {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: "Mặt ảnh CCCD phải là 'front' hoặc 'back'." });
  }
  if (!personId) {
    return res.status(403).json({ code: 'FORBIDDEN', message: 'Không xác định được hồ sơ định danh cá nhân.' });
  }

  try {
    const saved = await saveBase64Image({
      imageBase64: image_base64,
      folder: 'person',
      entityId: personId,
      entity: 'person',
      ownerId: personId,
      req,
      query: (sql, params) => pool.query(sql, params),
    });
    if (saved.error) {
      return res.status(400).json(saved.error);
    }

    const marker = JSON.stringify({ attachmentId: saved.attachment.id, side });
    await pool.query(
      `UPDATE person SET id_images = array_append(COALESCE(id_images, '{}'), $1), updated_at = NOW() WHERE id = $2`,
      [marker, personId]
    );

    await pool.query(
      `INSERT INTO audit_log (actor_id, action, entity, entity_id, after)
       VALUES ($1, 'UPLOAD', 'attachment', $2, $3)`,
      [req.user.sub, saved.attachment.id, JSON.stringify({ side, owner: 'person', owner_id: personId, uploaded_by_resident: true })]
    );

    res.status(201).json({
      message: `Đã lưu ảnh CCCD mặt ${side === 'front' ? 'trước' : 'sau'}.`,
      data: { attachment_id: saved.attachment.id, side },
    });
  } catch (err) {
    console.error('[Resident Upload Id Image Error]:', err);
    res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi máy chủ khi lưu ảnh CCCD.' });
  }
});

/**
 * POST /api/v1/resident/rental-application (FR-012)
 */
router.post('/rental-application', authenticateToken, async (req, res) => {
  const { full_name, id_number, dob, desired_apartment_id, note, privacy_consent } = req.body;
  const personId = req.user.person_id;
  const orgId = req.user.org_id;

  if (!full_name?.trim()) {
    return res.status(400).json({ code: 'INVALID_INPUT', message: 'Vui lòng nhập họ và tên.' });
  }

  if (privacy_consent !== true) {
    return res.status(400).json({
      code: 'PRIVACY_CONSENT_REQUIRED',
      message: 'Vui lòng xác nhận đồng ý với Chính sách bảo vệ dữ liệu cá nhân trước khi gửi hồ sơ.',
    });
  }

  const cleanIdNumber = id_number ? String(id_number).trim() : null;
  if (cleanIdNumber && !/^(?:[0-9]{9}|[0-9]{12}|[A-Za-z][0-9A-Za-z]{5,14})$/.test(cleanIdNumber)) {
    return res.status(400).json({
      code: 'VALIDATION_ERROR',
      message: 'Số CCCD / Hộ chiếu không hợp lệ (9 hoặc 12 chữ số, hoặc mã hộ chiếu hợp lệ).',
    });
  }

  if (cleanIdNumber) {
    const dupRes = await adminPool.query(
      'SELECT 1 FROM person WHERE org_id = $1 AND id <> $2 AND id_number = $3 LIMIT 1',
      [orgId, personId, cleanIdNumber]
    );
    if (dupRes.rows.length > 0) {
      return res.status(409).json({
        code: 'DUPLICATE_ID_NUMBER',
        message: 'Số CCCD/Hộ chiếu này đã tồn tại trên một hồ sơ cư dân khác trong hệ thống.',
      });
    }
  }

  let effectiveAptId = desired_apartment_id ? String(desired_apartment_id).trim() : null;
  let desiredBuildingId = null;
  let desiredAptCode = null;
  let desiredBuildingName = null;

  const selfPersonRes = await adminPool.query('SELECT phone FROM person WHERE id = $1 LIMIT 1', [personId]);
  const selfPhone = selfPersonRes.rows[0]?.phone || null;
  const cleanSelfPhone = normalizeVnPhone(selfPhone);

  if (!effectiveAptId && cleanSelfPhone) {
    const rsvRes = await adminPool.query(
      `SELECT apartment_id FROM reservation
       WHERE org_id = $1 AND (phone = $2 OR phone = $3) AND status = 'HELD'
       ORDER BY created_at DESC LIMIT 1`,
      [orgId, cleanSelfPhone, selfPhone]
    );
    effectiveAptId = rsvRes.rows[0]?.apartment_id || null;
  }

  if (effectiveAptId) {
    const aptRes = await adminPool.query(
      `SELECT a.id, a.code, a.status, a.building_id, b.name AS building_name
       FROM apartment a
       JOIN building b ON b.id = a.building_id
       WHERE a.id = $1 AND b.org_id = $2`,
      [effectiveAptId, orgId]
    );
    if (aptRes.rows.length === 0) {
      return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy căn hộ đăng ký.' });
    }
    const apt = aptRes.rows[0];
    if (!['AVAILABLE', 'RESERVED'].includes(apt.status)) {
      return res.status(409).json({
        code: 'APARTMENT_NOT_AVAILABLE',
        message: `Căn hộ ${apt.code} hiện không khả dụng để đăng ký thuê.`,
      });
    }
    if (apt.status === 'RESERVED') {
      const ownRsvRes = cleanSelfPhone
        ? await adminPool.query(
            `SELECT 1 FROM reservation
             WHERE org_id = $1 AND apartment_id = $2 AND status = 'HELD'
               AND (phone = $3 OR phone = $4)
             LIMIT 1`,
            [orgId, apt.id, cleanSelfPhone, selfPhone]
          )
        : { rows: [] };
      if (ownRsvRes.rows.length === 0) {
        return res.status(409).json({
          code: 'APARTMENT_RESERVED_BY_OTHER',
          message: `Căn hộ ${apt.code} hiện đang được giữ chỗ cho khách hàng khác.`,
        });
      }
    }
    desiredBuildingId = apt.building_id;
    desiredAptCode = apt.code;
    desiredBuildingName = apt.building_name;
  }

  const cleanNote = note !== undefined && note !== null ? String(note).trim() || null : null;

  const { client, release } = await getUserClient(req);
  try {
    await client.query('BEGIN');

    await client.query(
      `UPDATE person
       SET full_name = $1,
           id_number = COALESCE($2, id_number),
           dob = COALESCE($3::date, dob),
           privacy_consent_at = COALESCE(privacy_consent_at, NOW()),
           privacy_policy_version = 'v1.0',
           updated_at = NOW()
       WHERE id = $4`,
      [full_name.trim(), cleanIdNumber, dob || null, personId]
    );

    const tenantRes = await client.query(
      `SELECT id, status FROM tenant
       WHERE person_id = $1 AND status IN ('PENDING', 'REJECTED')
       ORDER BY updated_at DESC NULLS LAST, created_at DESC
       LIMIT 1`,
      [personId]
    );

    let tenantId;
    const isResubmit = tenantRes.rows[0]?.status === 'REJECTED';
    if (tenantRes.rows.length === 0) {
      const newTenant = await client.query(
        `INSERT INTO tenant (
           person_id, org_id, type, status,
           desired_apartment_id, desired_building_id, application_note, rejection_reason
         )
         VALUES ($1, $2, 'primary', 'PENDING', $3, $4, $5, NULL)
         RETURNING id`,
        [personId, orgId, effectiveAptId, desiredBuildingId, cleanNote]
      );
      tenantId = newTenant.rows[0].id;
    } else {
      tenantId = tenantRes.rows[0].id;
      await client.query(
        `UPDATE tenant
         SET status = 'PENDING',
             desired_apartment_id = COALESCE($1, desired_apartment_id),
             desired_building_id = COALESCE($2, desired_building_id),
             application_note = $3,
             rejection_reason = NULL,
             updated_at = NOW()
         WHERE id = $4`,
        [effectiveAptId, desiredBuildingId, cleanNote, tenantId]
      );
    }

    await client.query(
      `INSERT INTO audit_log (actor_id, action, entity, entity_id, after)
       VALUES ($1, $2, 'tenant_application', $3, $4)`,
      [
        req.user.sub,
        isResubmit ? 'RESUBMIT' : 'CREATE',
        tenantId,
        JSON.stringify({
          full_name: full_name.trim(),
          id_number: cleanIdNumber,
          desired_apartment_id: effectiveAptId,
          desired_building_id: desiredBuildingId,
          note: cleanNote,
          privacy_consent: true,
        }),
      ]
    );

    await client.query('COMMIT');

    // Gửi thông báo cho MANAGER phụ trách tòa nhà (hoặc SYS_ADMIN nếu tòa chưa có MANAGER)
    try {
      let recipients = [];
      if (desiredBuildingId) {
        const mgrRes = await adminPool.query(
          `SELECT DISTINCT ur.user_id
           FROM user_role ur
           JOIN role r ON r.id = ur.role_id
           JOIN app_user au ON au.id = ur.user_id
           WHERE r.code = 'MANAGER' AND ur.building_id = $1 AND au.status = 'ACTIVE'`,
          [desiredBuildingId]
        );
        recipients = mgrRes.rows.map((r) => r.user_id);
      }
      if (recipients.length === 0) {
        const admRes = await adminPool.query(
          `SELECT DISTINCT ur.user_id
           FROM user_role ur
           JOIN role r ON r.id = ur.role_id
           JOIN app_user au ON au.id = ur.user_id
           JOIN person p ON p.id = au.person_id
           WHERE r.code = 'SYS_ADMIN' AND p.org_id = $1 AND au.status = 'ACTIVE'`,
          [orgId]
        );
        recipients = admRes.rows.map((r) => r.user_id);
      }

      const notifTitle = isResubmit
        ? `Cư dân ${full_name.trim()} đã bổ sung lại hồ sơ đăng ký thuê`
        : `Hồ sơ đăng ký thuê mới từ ${full_name.trim()}`;
      const notifContent = desiredAptCode
        ? `Ứng viên ${full_name.trim()} vừa gửi hồ sơ đăng ký thuê căn ${desiredAptCode} (${desiredBuildingName || ''}). Vui lòng kiểm tra và phê duyệt.`
        : `Ứng viên ${full_name.trim()} vừa gửi hồ sơ tự khai trên Cổng cư dân. Vui lòng kiểm tra và phê duyệt.`;

      for (const uid of recipients) {
        await adminPool.query(
          `INSERT INTO notification (org_id, user_id, title, content, type, payload)
           VALUES ($1, $2, $3, $4, 'TENANT_APPLICATION', $5)`,
          [
            orgId,
            uid,
            notifTitle,
            notifContent,
            JSON.stringify({
              tenant_id: tenantId,
              desired_apartment_id: effectiveAptId,
              desired_building_id: desiredBuildingId,
              sent_by: req.user.sub,
            }),
          ]
        );
      }
    } catch (notifErr) {
      console.error('[Rental Application Notification Warning]:', notifErr);
    }

    res.status(201).json({
      message: 'Hồ sơ nhận nhà đã được gửi thành công. Ban Quản Lý sẽ liên hệ và duyệt hồ sơ trong thời gian sớm nhất!',
      data: { tenant_id: tenantId },
    });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') {
      return res.status(409).json({
        code: 'DUPLICATE_ID_NUMBER',
        message: 'Số CCCD/Hộ chiếu này đã tồn tại trên một hồ sơ cư dân khác trong hệ thống.',
      });
    }
    console.error('Lỗi nộp hồ sơ thuê nhà:', err);
    res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi nộp hồ sơ thuê nhà.' });
  } finally {
    await release();
  }
});

/**
 * GET /api/v1/resident/service-requests (M11, P5)
 * Danh sách yêu cầu sửa chữa / báo hỏng đã gửi của cư dân (hỗ trợ cả primary_tenant_id và contract_occupant, ẩn tuyệt đối internal_note)
 */
router.get('/service-requests', authenticateToken, requireRole(['RESIDENT']), async (req, res) => {
  const { client, release } = await getUserClient(req);
  try {
    const userId = req.user.sub;
    const personId = req.user.person_id;
    const contractId = req.query.contract_id ? String(req.query.contract_id).trim() : null;

    const params = [userId, personId];
    let contractScopeSql = '';
    if (contractId) {
      params.push(contractId);
      contractScopeSql = `
        AND sr.apartment_id IN (
          SELECT c2.apartment_id
          FROM contract c2
          WHERE c2.id = $3
            AND (
              EXISTS (SELECT 1 FROM tenant t2 WHERE t2.id = c2.primary_tenant_id AND t2.person_id = $2)
              OR EXISTS (
                SELECT 1 FROM contract_occupant co2
                JOIN tenant tocc2 ON tocc2.id = co2.tenant_id
                WHERE co2.contract_id = c2.id AND tocc2.person_id = $2
              )
            )
        )
      `;
    }

    const result = await client.query(
      `SELECT ${RESIDENT_SR_SAFE_COLUMNS},
              a.code AS apartment_code,
              b.name AS building_name,
              p_assigned.full_name AS assigned_to_name
       FROM service_request sr
       JOIN apartment a ON a.id = sr.apartment_id
       JOIN building b ON b.id = sr.building_id
       LEFT JOIN app_user u_assigned ON u_assigned.id = sr.assigned_to
       LEFT JOIN person p_assigned ON p_assigned.id = u_assigned.person_id
       WHERE (
         sr.created_by = $1
         OR sr.apartment_id IN (
           SELECT c.apartment_id
           FROM contract c
           WHERE c.status IN ('ACTIVE', 'RENEWAL_PENDING', 'TERMINATION_PENDING')
             AND (
               EXISTS (SELECT 1 FROM tenant t WHERE t.id = c.primary_tenant_id AND t.person_id = $2)
               OR EXISTS (
                 SELECT 1 FROM contract_occupant co
                 JOIN tenant tocc ON tocc.id = co.tenant_id
                 WHERE co.contract_id = c.id AND tocc.person_id = $2
               )
             )
         )
       )
       ${contractScopeSql}
       ORDER BY sr.created_at DESC`,
      params
    );

    res.json({ data: result.rows.map(sanitizeResidentServiceRequest) });
  } catch (err) {
    console.error('[Resident Get Service Requests Error]:', err);
    res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi khi tải danh sách yêu cầu báo hỏng.' });
  } finally {
    await release();
  }
});

/**
 * POST /api/v1/resident/service-requests (FR-042, AC-004.1, AC-004.2)
 * Cư dân / người ở cùng gửi yêu cầu sửa chữa / báo hỏng (kiểm tra trùng 24h, tính SLA Việt Nam, tối đa 3 ảnh)
 */
router.post('/service-requests', authenticateToken, requireRole(['RESIDENT']), idempotencyGuard(), async (req, res) => {
  const {
    title,
    category = 'OTHER',
    description,
    location_detail,
    preferred_slot,
    priority,
    urgency,
    apartment_id,
    contract_id,
    images = [],
    ignore_duplicate_warning = false,
    confirm_duplicate = false,
  } = req.body || {};

  if (!description?.trim()) {
    return res.status(400).json({ code: 'INVALID_INPUT', message: 'Vui lòng nhập mô tả chi tiết sự cố.' });
  }

  const normCategory = SR_CATEGORIES.includes(String(category).toUpperCase())
    ? String(category).toUpperCase()
    : 'OTHER';

  const rawPrio = String(priority || urgency || 'NORMAL').toUpperCase();
  const normPriority = SR_PRIORITIES.includes(rawPrio) ? rawPrio : 'NORMAL';

  let normPreferredSlot = 'ANYTIME';
  if (preferred_slot !== undefined && preferred_slot !== null && String(preferred_slot).trim() !== '') {
    const slotUpper = String(preferred_slot).trim().toUpperCase();
    if (!PREFERRED_SLOT_CODES.includes(slotUpper)) {
      return res.status(400).json({
        code: 'INVALID_PREFERRED_SLOT',
        message: 'Khung giờ mong muốn không hợp lệ.',
      });
    }
    normPreferredSlot = slotUpper;
  }

  const normLocationDetail = location_detail?.trim() ? location_detail.trim() : null;

  if (Array.isArray(images) && images.length > 3) {
    return res.status(400).json({
      code: 'TOO_MANY_IMAGES',
      message: 'Chỉ được đính kèm tối đa 3 ảnh minh họa cho mỗi yêu cầu (AC-004.1).',
    });
  }

  const { client, release } = await getUserClient(req);
  let txStarted = false;
  try {
    let targetAptQuery = `
      SELECT c.id AS contract_id, c.apartment_id, c.building_id, b.org_id,
             a.code AS apartment_code, b.name AS building_name,
             COALESCE(
               (SELECT t_me.id FROM tenant t_me WHERE t_me.id = c.primary_tenant_id AND t_me.person_id = $1 LIMIT 1),
               (
                 SELECT tocc.id
                 FROM contract_occupant co
                 JOIN tenant tocc ON tocc.id = co.tenant_id
                 WHERE co.contract_id = c.id AND tocc.person_id = $1
                 LIMIT 1
               )
             ) AS caller_tenant_id
      FROM contract c
      JOIN apartment a ON a.id = c.apartment_id
      JOIN building b ON b.id = c.building_id
      WHERE c.status IN ('ACTIVE', 'RENEWAL_PENDING', 'TERMINATION_PENDING')
        AND (
          EXISTS (SELECT 1 FROM tenant t WHERE t.id = c.primary_tenant_id AND t.person_id = $1)
          OR EXISTS (
            SELECT 1 FROM contract_occupant co
            JOIN tenant tocc ON tocc.id = co.tenant_id
            WHERE co.contract_id = c.id AND tocc.person_id = $1
          )
        )
    `;
    const aptParams = [req.user.person_id];
    if (contract_id) {
      aptParams.push(contract_id);
      targetAptQuery += ` AND c.id = $${aptParams.length}`;
    }
    if (apartment_id) {
      aptParams.push(apartment_id);
      targetAptQuery += ` AND c.apartment_id = $${aptParams.length}`;
    }
    targetAptQuery += ` ORDER BY (CASE WHEN c.start_date <= CURRENT_DATE THEN 0 ELSE 1 END), c.created_at DESC LIMIT 1`;

    const aptRes = await client.query(targetAptQuery, aptParams);
    if (aptRes.rows.length === 0) {
      return res.status(409).json({
        code: 'NO_ACTIVE_APARTMENT',
        message: 'Bạn cần có hợp đồng thuê đang hiệu lực để gửi yêu cầu sửa chữa cho căn hộ.',
      });
    }

    const {
      apartment_id: aptId,
      building_id: bldgId,
      org_id: orgId,
      apartment_code: aptCode,
      caller_tenant_id: callerTenantId,
    } = aptRes.rows[0];

    // AC-004.2: Cảnh báo yêu cầu trùng danh mục đang mở trên cùng căn hộ trong 24 giờ qua
    const bypassDup = Boolean(ignore_duplicate_warning) || Boolean(confirm_duplicate);
    if (!bypassDup) {
      const dupCheck = await client.query(
        `SELECT id, tracking_code, title, status, created_at
         FROM service_request
         WHERE apartment_id = $1
           AND category = $2
           AND status = ANY($3::text[])
         ORDER BY created_at DESC
         LIMIT 1`,
        [aptId, normCategory, SERVICE_REQUEST_OPEN_STATUSES]
      );
      if (
        dupCheck.rows.length > 0 &&
        isWithinDuplicateWindow({
          existingCreatedAt: dupCheck.rows[0].created_at,
          existingStatus: dupCheck.rows[0].status,
          now: new Date(),
          windowHours: 24,
        })
      ) {
        return res.status(409).json({
          code: 'DUPLICATE_SERVICE_REQUEST',
          message: `Căn hộ đang có yêu cầu cùng hạng mục vừa gửi trong 24 giờ qua (${dupCheck.rows[0].tracking_code}). Bạn vẫn muốn gửi thêm yêu cầu mới?`,
          existing_request: dupCheck.rows[0],
        });
      }
    }

    const slaConfig = await loadResidentOrgSlaConfig((s, p) => client.query(s, p), orgId);
    const createdAt = new Date();
    const { slaResponseDueAt, slaDueAt } = computeServiceRequestSlaDeadlines({
      createdAt,
      priority: normPriority,
      slaConfig,
    });

    await client.query('BEGIN');
    txStarted = true;

    const finalTitle = title?.trim() || `Báo hỏng ${normCategory} - ${description.trim().slice(0, 48)}`;

    let createdReq = null;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const candidateCode = buildTrackingCodeCandidate(attempt);
      await client.query('SAVEPOINT sp_res_sr_tracking');
      try {
        const insRes = await client.query(
          `INSERT INTO service_request (
             org_id, building_id, apartment_id, tenant_id, created_by,
             title, category, description, location_detail, preferred_slot,
             priority, status, tracking_code, images,
             sla_response_due_at, sla_due_at, created_at, updated_at
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'NEW', $12, '{}', $13, $14, $15, $15)
           RETURNING *`,
          [
            orgId,
            bldgId,
            aptId,
            callerTenantId || null,
            req.user.sub,
            finalTitle,
            normCategory,
            description.trim(),
            normLocationDetail,
            normPreferredSlot,
            normPriority,
            candidateCode,
            slaResponseDueAt,
            slaDueAt,
            createdAt,
          ]
        );
        await client.query('RELEASE SAVEPOINT sp_res_sr_tracking');
        createdReq = insRes.rows[0];
        break;
      } catch (insErr) {
        await client.query('ROLLBACK TO SAVEPOINT sp_res_sr_tracking');
        if (insErr.code === '23505' && attempt < 4) {
          continue;
        }
        throw insErr;
      }
    }

    // Lưu ảnh đính kèm (tối đa 3 ảnh base64 hoặc URL)
    const savedImageUrls = [];
    if (Array.isArray(images)) {
      for (const img of images.slice(0, 3)) {
        if (typeof img === 'string' && img.startsWith('data:image/')) {
          const saved = await saveBase64Image({
            imageBase64: img,
            folder: 'service_request',
            entityId: createdReq.id,
            entity: 'service_request',
            ownerId: createdReq.id,
            req,
            query: (sql, params) => client.query(sql, params),
          });
          if (saved.error) {
            await client.query('ROLLBACK');
            txStarted = false;
            return res.status(400).json(saved.error);
          }
          savedImageUrls.push(`/api/v1/attachments/${saved.attachment.id}/view`);
        } else if (typeof img === 'string' && img.trim()) {
          savedImageUrls.push(img.trim());
        }
      }
    }

    let finalRow = createdReq;
    if (savedImageUrls.length > 0) {
      const updImg = await client.query(
        `UPDATE service_request SET images = $1 WHERE id = $2 RETURNING *`,
        [savedImageUrls, createdReq.id]
      );
      finalRow = updImg.rows[0];
    }

    const notifType = normPriority === 'URGENT' ? 'SERVICE_REQUEST_URGENT' : 'SERVICE_REQUEST_CREATED';
    const notifTitle =
      normPriority === 'URGENT'
        ? `[KHẨN CẤP] Báo hỏng căn ${aptCode} (${finalRow.tracking_code})`
        : `Yêu cầu sửa chữa mới căn ${aptCode} (${finalRow.tracking_code})`;
    const notifContent = `${finalTitle}${normLocationDetail ? ` — Vị trí: ${normLocationDetail}` : ''}.`;

    await client.query(
      `SELECT fn_notify_service_request_managers($1, $2, $3, $4, $5::jsonb)`,
      [
        finalRow.id,
        notifType,
        notifTitle,
        notifContent,
        JSON.stringify({
          priority: normPriority,
          category: normCategory,
          apartment_code: aptCode,
        }),
      ]
    );

    const safeData = sanitizeResidentServiceRequest(finalRow);
    await client.query(
      `INSERT INTO audit_log (actor_id, action, entity, entity_id, after)
       VALUES ($1, 'CREATE_SERVICE_REQUEST', 'service_request', $2, $3)`,
      [req.user.sub, finalRow.id, JSON.stringify(safeData)]
    );

    await client.query('COMMIT');
    txStarted = false;

    triggerAsyncTicketTriage({
      actorId: req.user.sub,
      orgId,
      buildingId: bldgId,
      serviceRequestId: finalRow.id,
    });

    res.status(201).json({
      message: `Đã tiếp nhận yêu cầu báo hỏng. Mã tra cứu của bạn là ${finalRow.tracking_code}.`,
      data: safeData,
    });
  } catch (err) {
    if (txStarted) {
      await client.query('ROLLBACK').catch(() => {});
    }
    console.error('[Create Resident Service Request Error]:', err);
    res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi ghi nhận yêu cầu hỗ trợ.' });
  } finally {
    await release();
  }
});

/**
 * POST /api/v1/resident/service-requests/:id/cancel (M11)
 * Cư dân tự hủy yêu cầu khi còn ở trạng thái NEW
 */
router.post('/service-requests/:id/cancel', authenticateToken, requireRole(['RESIDENT']), idempotencyGuard(), async (req, res) => {
  const { id } = req.params;
  const { cancel_reason } = req.body || {};

  const { client, release } = await getUserClient(req);
  let txStarted = false;
  try {
    const sr = await findResidentAccessibleServiceRequest((s, p) => client.query(s, p), id, req.user);
    if (!sr) {
      return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy yêu cầu báo hỏng của bạn.' });
    }

    const check = validateServiceRequestTransition({
      fromStatus: sr.status,
      toStatus: 'CANCELLED',
      actorRole: 'RESIDENT',
    });
    if (!check.valid) {
      return res.status(409).json({ code: check.code, message: check.message });
    }

    await client.query('BEGIN');
    txStarted = true;

    const updatedRes = await client.query(
      `UPDATE service_request
       SET status = 'CANCELLED',
           cancelled_reason = $1,
           updated_at = NOW()
       WHERE id = $2
       RETURNING *`,
      [cancel_reason?.trim() || null, id]
    );
    const safeBefore = sanitizeResidentServiceRequest(sr);
    const safeAfter = sanitizeResidentServiceRequest(updatedRes.rows[0]);

    await client.query(
      `INSERT INTO audit_log (actor_id, action, entity, entity_id, before, after)
       VALUES ($1, 'CANCEL_SERVICE_REQUEST', 'service_request', $2, $3, $4)`,
      [req.user.sub, id, JSON.stringify(safeBefore), JSON.stringify(safeAfter)]
    );

    await client.query('COMMIT');
    txStarted = false;

    res.json({
      message: 'Đã hủy yêu cầu sửa chữa.',
      data: safeAfter,
    });
  } catch (err) {
    if (txStarted) {
      await client.query('ROLLBACK').catch(() => {});
    }
    console.error('[Cancel Resident Service Request Error]:', err);
    res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi khi hủy yêu cầu báo hỏng.' });
  } finally {
    await release();
  }
});

/**
 * POST /api/v1/resident/service-requests/:id/reopen (FR-047)
 * Cư dân mở lại phiếu RESOLVED trong thời hạn reopen_window_days
 */
router.post('/service-requests/:id/reopen', authenticateToken, requireRole(['RESIDENT']), idempotencyGuard(), async (req, res) => {
  const { id } = req.params;
  const { reopen_reason } = req.body || {};

  const { client, release } = await getUserClient(req);
  let txStarted = false;
  try {
    const sr = await findResidentAccessibleServiceRequest((s, p) => client.query(s, p), id, req.user);
    if (!sr) {
      return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy yêu cầu báo hỏng của bạn.' });
    }

    const slaConfig = await loadResidentOrgSlaConfig((s, p) => client.query(s, p), sr.org_id);
    const reopenWindowDays =
      Number(slaConfig?.reopen_window_days) > 0 ? Number(slaConfig.reopen_window_days) : 3;

    const check = validateServiceRequestTransition({
      fromStatus: sr.status,
      toStatus: 'REOPENED',
      actorRole: 'RESIDENT',
      reopenReason: reopen_reason,
      resolvedAt: sr.resolved_at,
      reopenWindowDays,
      now: new Date(),
    });
    if (!check.valid) {
      const httpStatus = check.code === 'REOPEN_REASON_REQUIRED' ? 400 : 409;
      return res.status(httpStatus).json({ code: check.code, message: check.message });
    }

    await client.query('BEGIN');
    txStarted = true;

    const trimmedReason = String(reopen_reason).trim();
    const updatedRes = await client.query(
      `UPDATE service_request
       SET status = 'REOPENED',
           reopened_at = NOW(),
           reopen_reason = $1,
           reopen_count = COALESCE(reopen_count, 0) + 1,
           updated_at = NOW()
       WHERE id = $2
       RETURNING *`,
      [trimmedReason, id]
    );
    const safeBefore = sanitizeResidentServiceRequest(sr);
    const safeAfter = sanitizeResidentServiceRequest(updatedRes.rows[0]);

    await client.query(
      `SELECT fn_notify_service_request_managers($1, $2, $3, $4, $5::jsonb)`,
      [
        id,
        'SERVICE_REQUEST_REOPENED',
        `[Mở lại] Căn ${sr.apartment_code} yêu cầu xử lý lại (${sr.tracking_code})`,
        `Lý do mở lại: ${trimmedReason}`,
        JSON.stringify({
          reopen_count: safeAfter.reopen_count,
          apartment_code: sr.apartment_code,
        }),
      ]
    );

    await client.query(
      `INSERT INTO audit_log (actor_id, action, entity, entity_id, before, after)
       VALUES ($1, 'REOPEN_SERVICE_REQUEST', 'service_request', $2, $3, $4)`,
      [req.user.sub, id, JSON.stringify(safeBefore), JSON.stringify(safeAfter)]
    );

    await client.query('COMMIT');
    txStarted = false;

    res.json({
      message: 'Đã gửi yêu cầu xử lý lại cho Ban quản lý.',
      data: safeAfter,
    });
  } catch (err) {
    if (txStarted) {
      await client.query('ROLLBACK').catch(() => {});
    }
    console.error('[Reopen Resident Service Request Error]:', err);
    res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi khi mở lại yêu cầu báo hỏng.' });
  } finally {
    await release();
  }
});

/**
 * POST /api/v1/resident/service-requests/:id/rating (P5, FR-047)
 * Cư dân đánh giá chất lượng xử lý (1-5 sao) và nghiệm thu đóng phiếu (RESOLVED -> CLOSED)
 */
router.post('/service-requests/:id/rating', authenticateToken, requireRole(['RESIDENT']), idempotencyGuard(), async (req, res) => {
  const { id } = req.params;
  const { rating, rating_note } = req.body || {};
  const numRating = Number(rating);

  if (!Number.isInteger(numRating) || numRating < 1 || numRating > 5) {
    return res.status(400).json({ code: 'INVALID_RATING', message: 'Điểm đánh giá phải từ 1 đến 5 sao.' });
  }

  const { client, release } = await getUserClient(req);
  let txStarted = false;
  try {
    const sr = await findResidentAccessibleServiceRequest((s, p) => client.query(s, p), id, req.user);
    if (!sr) {
      return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy yêu cầu báo hỏng của bạn.' });
    }
    if (!['RESOLVED', 'CLOSED'].includes(sr.status)) {
      return res.status(409).json({
        code: 'NOT_RESOLVED',
        message: 'Chỉ có thể đánh giá sau khi yêu cầu đã được xử lý xong (RESOLVED).',
      });
    }

    await client.query('BEGIN');
    txStarted = true;

    const updatedRes = await client.query(
      `UPDATE service_request
       SET rating = $1,
           rating_note = $2,
           status = 'CLOSED',
           updated_at = NOW()
       WHERE id = $3
       RETURNING *`,
      [numRating, rating_note?.trim() || null, id]
    );
    const safeBefore = sanitizeResidentServiceRequest(sr);
    const safeAfter = sanitizeResidentServiceRequest(updatedRes.rows[0]);

    await client.query(
      `SELECT fn_notify_service_request_managers($1, $2, $3, $4, $5::jsonb)`,
      [
        id,
        'SERVICE_REQUEST_RATED',
        `Cư dân căn ${sr.apartment_code} đánh giá ${numRating}/5 sao (${sr.tracking_code})`,
        rating_note?.trim() ? `Nhận xét: ${rating_note.trim()}` : `Đã nghiệm thu đóng phiếu ${sr.tracking_code}.`,
        JSON.stringify({
          rating: numRating,
          apartment_code: sr.apartment_code,
        }),
      ]
    );

    await client.query(
      `INSERT INTO audit_log (actor_id, action, entity, entity_id, before, after)
       VALUES ($1, 'RATE_SERVICE_REQUEST', 'service_request', $2, $3, $4)`,
      [req.user.sub, id, JSON.stringify(safeBefore), JSON.stringify(safeAfter)]
    );

    await client.query('COMMIT');
    txStarted = false;

    res.json({
      message: 'Cảm ơn bạn đã gửi đánh giá chất lượng dịch vụ!',
      data: safeAfter,
    });
  } catch (err) {
    if (txStarted) {
      await client.query('ROLLBACK').catch(() => {});
    }
    console.error('[Rate Service Request Error]:', err);
    res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi khi lưu đánh giá.' });
  } finally {
    await release();
  }
});

/**
 * GET /api/v1/resident/invoices (P3, US-003)
 * Danh sách hóa đơn & lịch sử thanh toán của cư dân
 */
router.get('/invoices', authenticateToken, async (req, res) => {
  try {
    const personId = req.user.person_id;
    const contractId = req.query.contract_id ? String(req.query.contract_id).trim() : null;
    const params = [personId];
    let contractFilter = '';
    if (contractId) {
      params.push(contractId);
      contractFilter = ' AND i.contract_id = $2';
    }

    const invRes = await pool.query(
      `SELECT i.*,
              a.code as apartment_code,
              b.name as building_name
       FROM invoice i
       JOIN apartment a ON a.id = i.apartment_id
       JOIN building b ON b.id = i.building_id
       JOIN tenant t ON t.id = i.tenant_id
       WHERE t.person_id = $1 AND i.status <> 'DRAFT'${contractFilter}
       ORDER BY i.period DESC, i.created_at DESC`,
      params
    );

    const invoiceIds = invRes.rows.map((r) => r.id);
    let linesByInv = {};
    let paymentsByInv = {};

    if (invoiceIds.length > 0) {
      const linesRes = await pool.query(
        `SELECT il.*,
                COALESCE(mr_join.image_url, NULLIF(il.formula_meta->>'image_url', '')) AS meter_image_url,
                COALESCE(mr_join.meter_code, NULLIF(il.formula_meta->>'meter_code', '')) AS meter_code
         FROM invoice_line il
         JOIN invoice inv ON inv.id = il.invoice_id
         LEFT JOIN LATERAL (
           SELECT mr.image_url, m.meter_code
           FROM meter_reading mr
           JOIN meter m ON m.id = mr.meter_id
           WHERE il.item_type IN ('ELECTRICITY', 'WATER')
             AND mr.status = 'CONFIRMED'
             AND (
               (
                 (il.formula_meta->>'reading_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                 AND mr.id = (il.formula_meta->>'reading_id')::uuid
               )
               OR (
                 mr.apartment_id = inv.apartment_id
                 AND mr.period = inv.period
                 AND m.meter_type = il.item_type
                 AND (mr.contract_id = inv.contract_id OR mr.contract_id IS NULL)
               )
             )
           ORDER BY (
             CASE
               WHEN (il.formula_meta->>'reading_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                    AND mr.id = (il.formula_meta->>'reading_id')::uuid
                 THEN 0
               WHEN mr.contract_id = inv.contract_id
                 THEN 1
               ELSE 2
             END
           ) ASC, mr.recorded_at DESC
           LIMIT 1
         ) mr_join ON TRUE
         WHERE il.invoice_id = ANY($1::uuid[])
         ORDER BY il.created_at ASC`,
        [invoiceIds]
      );
      for (const l of linesRes.rows) {
        if (!linesByInv[l.invoice_id]) linesByInv[l.invoice_id] = [];
        linesByInv[l.invoice_id].push(l);
      }

      const payRes = await pool.query(
        `SELECT * FROM payment WHERE invoice_id = ANY($1::uuid[]) ORDER BY paid_at DESC`,
        [invoiceIds]
      );
      for (const p of payRes.rows) {
        if (!paymentsByInv[p.invoice_id]) paymentsByInv[p.invoice_id] = [];
        paymentsByInv[p.invoice_id].push(p);
      }
    }

    const data = invRes.rows.map((inv) => ({
      ...inv,
      lines: linesByInv[inv.id] || [],
      payments: paymentsByInv[inv.id] || [],
    }));

    const creditParams = [personId];
    let creditFilter = '';
    if (contractId) {
      creditParams.push(contractId);
      creditFilter = ' AND cb.contract_id = $2';
    }
    const creditRes = await pool.query(
      `SELECT cb.id, cb.contract_id, cb.building_id, cb.reason_type, cb.amount, cb.applied_amount,
              (cb.amount - cb.applied_amount) AS available_amount,
              cb.status, cb.description, cb.refund_method, cb.refund_meta, cb.created_at, cb.updated_at,
              a.code AS apartment_code, b.name AS building_name
       FROM credit_balance cb
       JOIN tenant t ON t.id = cb.tenant_id
       LEFT JOIN contract c ON c.id = cb.contract_id
       LEFT JOIN apartment a ON a.id = c.apartment_id
       LEFT JOIN building b ON b.id = cb.building_id
       WHERE t.person_id = $1${creditFilter}
       ORDER BY cb.created_at DESC`,
      creditParams
    );

    res.json({ data, credit_balances: creditRes.rows });
  } catch (err) {
    console.error('[Resident Invoices Error]:', err);
    res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi khi tải danh sách hóa đơn.' });
  }
});

/**
 * POST /api/v1/resident/payments/report (FR-037, P3, FORCE RLS safe)
 * Cư dân báo đã chuyển khoản thanh toán hóa đơn + đính kèm chứng từ
 */
router.post('/payments/report', authenticateToken, idempotencyGuard(), async (req, res) => {
  const { invoice_id, amount, method = 'BANK_TRANSFER', reference_code, paid_at, note, proof_images = [] } = req.body;
  const numAmount = Number(amount);

  if (!invoice_id || !numAmount || numAmount <= 0) {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Vui lòng chọn hóa đơn và nhập số tiền thanh toán hợp lệ.' });
  }

  const { client, release } = await getUserClient(req);
  try {
    await client.query('BEGIN');

    // 1. Pre-check status (DRAFT hidden per AC-003.2, VOID rejected with 409 INVALID_STATUS)
    const checkRes = await client.query(
      `SELECT i.id, i.status, i.total_amount, i.paid_amount
       FROM invoice i
       WHERE i.id = $1`,
      [invoice_id]
    );
    if (checkRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy hóa đơn cần thanh toán.' });
    }
    const preCheck = checkRes.rows[0];
    if (preCheck.status === 'VOID' || preCheck.status === 'DRAFT') {
      await client.query('ROLLBACK');
      return res.status(409).json({ code: 'INVALID_STATUS', message: 'Hóa đơn ở trạng thái không thể thanh toán.' });
    }
    if (Number(preCheck.total_amount) - Number(preCheck.paid_amount) <= 0 || preCheck.status === 'PAID') {
      await client.query('ROLLBACK');
      return res.status(409).json({ code: 'ALREADY_PAID', message: 'Hóa đơn này đã được thanh toán đầy đủ.' });
    }

    // 2. Lock invoice row safely under FORCE RLS via fn_lock_invoices_for_authorized_viewer
    const lockRes = await client.query(
      `SELECT * FROM fn_lock_invoices_for_authorized_viewer(NULL, $1)`,
      [invoice_id]
    );
    if (lockRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy hóa đơn cần thanh toán.' });
    }
    const inv = lockRes.rows[0];
    if (inv.status === 'VOID' || inv.status === 'DRAFT') {
      await client.query('ROLLBACK');
      return res.status(409).json({ code: 'INVALID_STATUS', message: 'Hóa đơn ở trạng thái không thể thanh toán.' });
    }
    if (Number(inv.total_amount) - Number(inv.paid_amount) <= 0 || inv.status === 'PAID') {
      await client.query('ROLLBACK');
      return res.status(409).json({ code: 'ALREADY_PAID', message: 'Hóa đơn này đã được thanh toán đầy đủ.' });
    }

    const paymentId = crypto.randomUUID();
    const savedProofs = [];
    if (Array.isArray(proof_images)) {
      for (const img of proof_images.slice(0, 3)) {
        if (typeof img === 'string' && img.startsWith('data:image/')) {
          const saved = await saveBase64Image({
            imageBase64: img,
            folder: 'payment',
            entityId: paymentId,
            entity: 'payment',
            ownerId: paymentId,
            req,
            query: (sql, params) => client.query(sql, params),
          });
          if (saved.error) {
            await client.query('ROLLBACK');
            return res.status(400).json(saved.error);
          }
          savedProofs.push(`/api/v1/attachments/${saved.attachment.id}/view`);
        } else if (typeof img === 'string' && img.trim()) {
          savedProofs.push(img.trim());
        }
      }
    }

    const payCode = `PAY-R-${Date.now().toString().slice(-7)}-${Math.floor(100 + Math.random() * 900)}`;
    const insPay = await client.query(
      `INSERT INTO payment (
         id, org_id, building_id, invoice_id, contract_id, tenant_id,
         payment_code, amount, method, reference_code, status, paid_at, note, proof_images, reported_by
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'PENDING_CONFIRMATION', COALESCE($11::timestamptz, NOW()), $12, $13, $14)
       RETURNING *`,
      [
        paymentId,
        inv.org_id,
        inv.building_id,
        inv.id,
        inv.contract_id,
        inv.tenant_id,
        payCode,
        Math.round(numAmount),
        method,
        reference_code?.trim() || null,
        paid_at || null,
        note?.trim() || null,
        savedProofs,
        req.user.sub,
      ]
    );
    const finalPay = insPay.rows[0];

    await client.query(
      `INSERT INTO audit_log (actor_id, action, entity, entity_id, after)
       VALUES ($1, 'REPORT_PAYMENT', 'payment', $2, $3)`,
      [req.user.sub, finalPay.id, JSON.stringify(finalPay)]
    );

    await client.query('COMMIT');

    try {
      const aptMetaRes = await adminPool.query(
        `SELECT a.code AS apartment_code, i.invoice_code
         FROM invoice i
         LEFT JOIN apartment a ON a.id = i.apartment_id
         WHERE i.id = $1
         LIMIT 1`,
        [inv.id]
      );
      const aptCode = aptMetaRes.rows[0]?.apartment_code || '';
      const invCode = aptMetaRes.rows[0]?.invoice_code || inv.invoice_code || '';
      await notifyBuildingManagers(inv.org_id, inv.building_id, {
        title: `Cư dân báo đã thanh toán ${invCode ? `#${invCode}` : ''}`.trim(),
        content: `Cư dân${aptCode ? ` phòng ${aptCode}` : ''} vừa gửi chứng từ thanh toán ${Math.round(numAmount).toLocaleString('vi-VN')} ₫${invCode ? ` cho hóa đơn ${invCode}` : ''}. Vui lòng đối soát và xác nhận.`,
        type: 'PAYMENT_REPORTED',
        payload: {
          payment_id: finalPay.id,
          invoice_id: inv.id,
          contract_id: inv.contract_id,
          building_id: inv.building_id,
          apartment_id: inv.apartment_id || null,
          amount: Math.round(numAmount),
        },
      });
    } catch (notifErr) {
      console.error('[Report Payment Notification Warning]:', notifErr);
    }

    res.status(201).json({
      message: 'Đã gửi thông báo thanh toán kèm chứng từ. Ban Quản Lý sẽ đối soát và xác nhận sớm nhất!',
      data: finalPay,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[Report Payment Error]:', err);
    res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi khi gửi xác nhận thanh toán.' });
  } finally {
    await release();
  }
});

/**
 * GET /api/v1/resident/services (M07, P4)
 * Danh mục dịch vụ khả dụng & các gói dịch vụ cư dân đang đăng ký
 * FR-065 & Spec 5.3.1: lọc (building_id IS NULL OR building_id = c.building_id),
 * khử trùng theo UPPER(code) ưu tiên building_id = c.building_id, và phân giải đơn giá qua resolveServiceUnitPrice
 */
router.get('/services', authenticateToken, async (req, res) => {
  const { client, release } = await getUserClient(req);
  try {
    const orgId = req.user.org_id;
    const personId = req.user.person_id;
    const contractId = req.query.contract_id ? String(req.query.contract_id).trim() : null;

    // Lấy hợp đồng hiệu lực của cư dân để biết building_id
    const cParams = [personId];
    let cFilter = '';
    if (contractId) {
      cParams.push(contractId);
      cFilter = ' AND c.id = $2';
    }
    const cRes = await client.query(
      `SELECT c.id as contract_id, c.building_id, c.apartment_id
       FROM contract c
       JOIN tenant t ON t.id = c.primary_tenant_id
       WHERE t.person_id = $1 AND c.status IN ('ACTIVE', 'RENEWAL_PENDING')${cFilter}
       ORDER BY (CASE WHEN c.start_date <= CURRENT_DATE THEN 0 ELSE 1 END), c.created_at DESC
       LIMIT 1`,
      cParams
    );
    const activeContract = cRes.rows[0] || null;
    const targetBuildingId = activeContract?.building_id || null;

    // Lấy danh mục dịch vụ: building_id IS NULL hoặc building_id = targetBuildingId
    let catSql = `SELECT * FROM service_catalog WHERE org_id = $1 AND is_active = TRUE`;
    const catParams = [orgId];
    if (targetBuildingId) {
      catParams.push(targetBuildingId);
      catSql += ` AND (building_id IS NULL OR building_id = $2)
                 ORDER BY (CASE WHEN building_id = $2 THEN 0 ELSE 1 END) ASC, category ASC, name ASC`;
    } else {
      catSql += ` AND building_id IS NULL ORDER BY category ASC, name ASC`;
    }

    const catalogRaw = await client.query(catSql, catParams);

    // Khử trùng theo UPPER(code) ưu tiên building_id = c.building_id
    const seenCodes = new Set();
    const deduplicatedCatalog = [];
    for (const item of catalogRaw.rows) {
      const codeKey = (item.code || '').trim().toUpperCase();
      if (!seenCodes.has(codeKey)) {
        seenCodes.add(codeKey);
        deduplicatedCatalog.push(item);
      }
    }

    // Phân giải đơn giá 3 tầng
    let contractServicePrices = [];
    if (activeContract) {
      const cspRes = await client.query(
        'SELECT * FROM contract_service_price WHERE contract_id = $1',
        [activeContract.contract_id]
      );
      contractServicePrices = cspRes.rows;
    }

    const todayYmd = todayVietnamYmd();
    for (const item of deduplicatedCatalog) {
      const priceRes = resolveServiceUnitPrice({
        subscription: { service_code: item.code, service_category: item.category, is_price_locked: false },
        contractBuildingId: targetBuildingId,
        periodEndYmd: todayYmd,
        contractServicePrices,
        catalogItems: deduplicatedCatalog,
      });
      item.resolved_unit_price = priceRes.unitPrice;
      item.price_source = priceRes.priceSource;
    }

    const subParams = [personId];
    let subFilter = '';
    if (contractId) {
      subParams.push(contractId);
      subFilter = ' AND ss.contract_id = $2';
    }

    const subsRes = await client.query(
      `SELECT ss.*, sc.code as service_code, sc.name as service_name, sc.unit, sc.category,
              a.code as apartment_code, b.name as building_name
       FROM service_subscription ss
       JOIN service_catalog sc ON sc.id = ss.service_id
       JOIN apartment a ON a.id = ss.apartment_id
       JOIN contract c ON c.id = ss.contract_id
       JOIN building b ON b.id = c.building_id
       JOIN tenant t ON t.id = c.primary_tenant_id
       WHERE t.person_id = $1${subFilter}
       ORDER BY ss.created_at DESC`,
      subParams
    );

    res.json({
      data: {
        catalog: deduplicatedCatalog,
        subscriptions: subsRes.rows,
      },
    });
  } catch (err) {
    console.error('[Resident Services Error]:', err);
    res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi khi tải thông tin dịch vụ.' });
  } finally {
    await release();
  }
});

/**
 * POST /api/v1/resident/services (FR-027, FR-029, FR-065)
 * Cư dân đăng ký dịch vụ mới (kèm tính phí pro-rata kỳ đầu, hỗ trợ chọn contract_id)
 */
router.post('/services', authenticateToken, idempotencyGuard(), async (req, res) => {
  const { service_id, quantity = 1, start_date, note, vehicle_plates, contract_id } = req.body;
  if (!service_id) {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Vui lòng chọn dịch vụ cần đăng ký.' });
  }

  const { client, release } = await getUserClient(req);
  try {
    const cParams = [req.user.person_id];
    let cFilter = '';
    if (contract_id) {
      cParams.push(contract_id);
      cFilter = ' AND c.id = $2';
    }

    const contractRes = await client.query(
      `SELECT c.id as contract_id, c.apartment_id, c.building_id, b.org_id
       FROM contract c
       JOIN tenant t ON t.id = c.primary_tenant_id
       JOIN building b ON b.id = c.building_id
       WHERE t.person_id = $1 AND c.status IN ('ACTIVE', 'RENEWAL_PENDING')${cFilter}
       ORDER BY (CASE WHEN c.start_date <= CURRENT_DATE THEN 0 ELSE 1 END), c.created_at DESC LIMIT 1`,
      cParams
    );
    if (contractRes.rows.length === 0) {
      return res.status(409).json({ code: 'NO_ACTIVE_CONTRACT', message: 'Bạn cần có hợp đồng đang hiệu lực để đăng ký dịch vụ.' });
    }
    const c = contractRes.rows[0];

    const svcRes = await client.query(
      `SELECT * FROM service_catalog
       WHERE id = $1 AND org_id = $2 AND is_active = TRUE
         AND (building_id IS NULL OR building_id = $3)`,
      [service_id, c.org_id, c.building_id]
    );
    if (svcRes.rows.length === 0) {
      return res.status(404).json({ code: 'NOT_FOUND', message: 'Dịch vụ không tồn tại hoặc đã ngừng cung cấp.' });
    }
    const svc = svcRes.rows[0];
    const meta = validateAndNormalizeSubscriptionMeta({
      category: svc.category,
      billingType: svc.billing_type,
      quantity,
      vehiclePlates: vehicle_plates,
      note,
    });
    const qty = meta.quantity;
    const effStart = start_date || todayVietnamYmd();

    // Resolve 3-tier unit price (standard subscription is_price_locked = false)
    const cspRes = await client.query(
      'SELECT * FROM contract_service_price WHERE contract_id = $1',
      [c.contract_id]
    );
    const catRes = await client.query(
      'SELECT * FROM service_catalog WHERE org_id = $1 AND is_active = TRUE',
      [c.org_id]
    );
    const priceRes = resolveServiceUnitPrice({
      subscription: { service_code: svc.code, service_category: svc.category, is_price_locked: false },
      contractBuildingId: c.building_id,
      periodEndYmd: effStart,
      contractServicePrices: cspRes.rows,
      catalogItems: catRes.rows,
    });
    const unitPrice = priceRes.unitPrice;
    const effStartYmd = toDateOnlyYmd(effStart) || todayVietnamYmd();
    const prorata = computeSubscriptionPeriodCharge({
      subscription: {
        service_code: svc.code,
        service_category: svc.category,
        service_name: svc.name,
        billing_type: svc.billing_type,
        quantity: qty,
        unit_price: unitPrice,
        is_price_locked: false,
        start_date: effStartYmd,
        status: 'ACTIVE',
      },
      periodYm: effStartYmd.slice(0, 7),
      contractBuildingId: c.building_id,
      contractServicePrices: cspRes.rows,
      catalogItems: catRes.rows,
    }).amount;

    const ins = await client.query(
      `INSERT INTO service_subscription (
         org_id, building_id, apartment_id, contract_id, service_id,
         quantity, unit_price, is_price_locked, start_date, prorata_amount, status, note, vehicle_plates, requested_by
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, FALSE, $8, $9, 'PENDING_APPROVAL', $10, $11, $12)
       RETURNING *`,
      [
        c.org_id,
        c.building_id,
        c.apartment_id,
        c.contract_id,
        svc.id,
        qty,
        unitPrice,
        effStart,
        prorata,
        meta.note,
        meta.vehiclePlates,
        req.user.sub,
      ]
    );
    const newSub = ins.rows[0];

    await client.query(
      `INSERT INTO audit_log (actor_id, action, entity, entity_id, after)
       VALUES ($1, 'REQUEST_SERVICE_SUBSCRIPTION', 'service_subscription', $2, $3)`,
      [req.user.sub, newSub.id, JSON.stringify(newSub)]
    );

    try {
      const aptCodeRes = await adminPool.query('SELECT code FROM apartment WHERE id = $1 LIMIT 1', [
        c.apartment_id,
      ]);
      const aptCode = aptCodeRes.rows[0]?.code || '';
      await notifyBuildingManagers(c.org_id, c.building_id, {
        title: `Yêu cầu đăng ký dịch vụ "${svc.name}"${aptCode ? ` — Phòng ${aptCode}` : ''}`,
        content: `Cư dân${aptCode ? ` căn ${aptCode}` : ''} vừa gửi yêu cầu đăng ký dịch vụ "${svc.name}" (SL: ${qty}). Vui lòng kiểm tra và phê duyệt.`,
        type: 'SERVICE_SUBSCRIPTION_REQUESTED',
        payload: {
          subscription_id: newSub.id,
          service_id: svc.id,
          contract_id: c.contract_id,
          building_id: c.building_id,
          apartment_id: c.apartment_id,
          status: newSub.status,
        },
      });
    } catch (notifErr) {
      console.error('[Subscribe Service Notification Warning]:', notifErr);
    }

    res.status(201).json({
      message: 'Đã gửi yêu cầu đăng ký dịch vụ, chờ Ban Quản Lý phê duyệt.',
      data: newSub,
    });
  } catch (err) {
    if (err.httpStatus) {
      return res.status(err.httpStatus).json({ code: err.code, message: err.message });
    }
    console.error('[Resident Subscribe Service Error]:', err);
    res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi khi đăng ký dịch vụ.' });
  } finally {
    await release();
  }
});

/**
 * PATCH /api/v1/resident/services/:id/cancel (FR-029, Spec 5.3.1)
 * Cư dân yêu cầu hủy dịch vụ (tính pro-rata tới ngày kết thúc, 0 ₫ nếu hủy trước start_date hoặc rút PENDING_APPROVAL)
 */
router.patch('/services/:id/cancel', authenticateToken, idempotencyGuard(), async (req, res) => {
  const { id } = req.params;
  const { end_date, note } = req.body;

  const { client, release } = await getUserClient(req);
  try {
    const cleanCancelNote =
      note !== undefined && note !== null
        ? validateAndNormalizeSubscriptionMeta({
            category: 'OTHER',
            billingType: 'FIXED',
            quantity: 1,
            note,
          }).note
        : null;

    await client.query('BEGIN');

    const subRes = await client.query(
      `SELECT ss.*
       FROM service_subscription ss
       JOIN contract c ON c.id = ss.contract_id
       JOIN tenant t ON t.id = c.primary_tenant_id
       WHERE ss.id = $1 AND t.person_id = $2
       FOR UPDATE OF ss`,
      [id, req.user.person_id]
    );
    if (subRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy đăng ký dịch vụ.' });
    }
    const sub = subRes.rows[0];

    // Block mutating already TERMINATED or REJECTED
    if (sub.status === 'TERMINATED' || sub.status === 'REJECTED') {
      await client.query('ROLLBACK');
      return res.status(409).json({ code: 'INVALID_STATUS', message: 'Không thể hủy dịch vụ đã kết thúc hoặc bị từ chối.' });
    }
    if (sub.status === 'CANCELLATION_PENDING') {
      await client.query('ROLLBACK');
      return res.status(409).json({ code: 'INVALID_STATUS', message: 'Yêu cầu hủy dịch vụ đang chờ Ban Quản Lý xử lý.' });
    }

    const subStartYmd = toDateOnlyYmd(sub.start_date);
    const todayVnYmd = todayVietnamYmd();
    const reqEndYmd = end_date ? toDateOnlyYmd(end_date) : null;

    let nextStatus;
    let effEnd;
    let prorata;

    if (sub.status === 'PENDING_APPROVAL') {
      // Withdrawing unapproved subscription -> TERMINATED with 0 VND
      nextStatus = 'TERMINATED';
      effEnd = addDaysYmd(subStartYmd, -1);
      prorata = 0;
    } else {
      // ACTIVE subscription cancellation request
      nextStatus = 'CANCELLATION_PENDING';
      if ((reqEndYmd && reqEndYmd < subStartYmd) || (!reqEndYmd && todayVnYmd < subStartYmd)) {
        // Pre-start cancellation: 0 VND
        effEnd = addDaysYmd(subStartYmd, -1);
        prorata = 0;
      } else {
        effEnd = reqEndYmd || todayVnYmd;
        const cancelSvcRes = await client.query('SELECT code AS service_code, name AS service_name, category AS service_category, billing_type FROM service_catalog WHERE id = $1', [sub.service_id]);
        const cancelCspRes = sub.contract_id
          ? await client.query('SELECT * FROM contract_service_price WHERE contract_id = $1', [sub.contract_id])
          : { rows: [] };
        const cancelCatRes = await client.query('SELECT * FROM service_catalog WHERE org_id = $1 AND is_active = TRUE', [sub.org_id]);
        prorata = computeSubscriptionPeriodCharge({
          subscription: { ...sub, ...(cancelSvcRes.rows[0] || {}), end_date: effEnd, status: 'CANCELLATION_PENDING' },
          periodYm: effEnd.slice(0, 7),
          contractBuildingId: sub.building_id,
          contractServicePrices: cancelCspRes.rows,
          catalogItems: cancelCatRes.rows,
        }).amount;
      }
    }

    const upd = await client.query(
      `UPDATE service_subscription
       SET status = $1, end_date = $2, prorata_amount = $3, note = COALESCE($4, note), updated_at = NOW()
       WHERE id = $5
       RETURNING *`,
      [nextStatus, effEnd, prorata, cleanCancelNote, id]
    );
    const updatedRow = upd.rows[0];

    await client.query(
      `INSERT INTO audit_log (actor_id, action, entity, entity_id, before, after)
       VALUES ($1, 'CANCEL_SERVICE_SUBSCRIPTION', 'service_subscription', $2, $3, $4)`,
      [req.user.sub, id, JSON.stringify(sub), JSON.stringify(updatedRow)]
    );

    await client.query('COMMIT');

    if (nextStatus === 'CANCELLATION_PENDING') {
      try {
        const metaRes = await adminPool.query(
          `SELECT sc.name AS service_name, a.code AS apartment_code
           FROM service_subscription ss
           LEFT JOIN service_catalog sc ON sc.id = ss.service_id
           LEFT JOIN apartment a ON a.id = ss.apartment_id
           WHERE ss.id = $1
           LIMIT 1`,
          [id]
        );
        const svcName = metaRes.rows[0]?.service_name || 'dịch vụ tiện ích';
        const aptCode = metaRes.rows[0]?.apartment_code || '';
        await notifyBuildingManagers(sub.org_id, sub.building_id, {
          title: `Yêu cầu hủy dịch vụ "${svcName}"${aptCode ? ` — Phòng ${aptCode}` : ''}`,
          content: `Cư dân${aptCode ? ` căn ${aptCode}` : ''} vừa gửi yêu cầu hủy dịch vụ "${svcName}" từ ngày ${effEnd}. Vui lòng kiểm tra và xác nhận phí pro-rata.`,
          type: 'SERVICE_CANCELLATION_REQUESTED',
          payload: {
            subscription_id: updatedRow.id,
            service_id: sub.service_id,
            contract_id: sub.contract_id,
            building_id: sub.building_id,
            apartment_id: sub.apartment_id,
            status: nextStatus,
          },
        });
      } catch (notifErr) {
        console.error('[Cancel Service Notification Warning]:', notifErr);
      }
    }

    res.json({
      message: nextStatus === 'TERMINATED' ? 'Đã hủy yêu cầu đăng ký dịch vụ.' : 'Đã gửi yêu cầu hủy dịch vụ tới Ban Quản Lý.',
      data: updatedRow,
    });
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {}
    if (err.httpStatus) {
      return res.status(err.httpStatus).json({ code: err.code, message: err.message });
    }
    console.error('[Resident Cancel Service Error]:', err);
    res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi khi hủy dịch vụ.' });
  } finally {
    await release();
  }
});

/**
 * PATCH /api/v1/resident/services/:id/withdraw-cancel (Spec 5.3.1)
 * Cư dân rút lại yêu cầu hủy dịch vụ (chuyển CANCELLATION_PENDING -> ACTIVE, xóa end_date)
 */
router.patch('/services/:id/withdraw-cancel', authenticateToken, idempotencyGuard(), async (req, res) => {
  const { id } = req.params;

  const { client, release } = await getUserClient(req);
  try {
    await client.query('BEGIN');

    const subRes = await client.query(
      `SELECT ss.*
       FROM service_subscription ss
       JOIN contract c ON c.id = ss.contract_id
       JOIN tenant t ON t.id = c.primary_tenant_id
       WHERE ss.id = $1 AND t.person_id = $2
       FOR UPDATE OF ss`,
      [id, req.user.person_id]
    );
    if (subRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy đăng ký dịch vụ.' });
    }
    const sub = subRes.rows[0];

    if (sub.status !== 'CANCELLATION_PENDING') {
      await client.query('ROLLBACK');
      return res.status(409).json({
        code: 'INVALID_STATUS',
        message: 'Chỉ có thể rút yêu cầu hủy khi đang ở trạng thái chờ hủy.',
      });
    }

    const upd = await client.query(
      `UPDATE service_subscription
       SET status = 'ACTIVE', end_date = NULL, updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [id]
    );
    const updatedRow = upd.rows[0];

    await client.query(
      `INSERT INTO audit_log (actor_id, action, entity, entity_id, before, after)
       VALUES ($1, 'WITHDRAW_CANCEL_SERVICE_SUBSCRIPTION', 'service_subscription', $2, $3, $4)`,
      [req.user.sub, id, JSON.stringify(sub), JSON.stringify(updatedRow)]
    );

    await client.query('COMMIT');

    res.json({
      message: 'Đã rút yêu cầu hủy dịch vụ thành công.',
      data: updatedRow,
    });
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {}
    if (err.httpStatus) {
      return res.status(err.httpStatus).json({ code: err.code, message: err.message });
    }
    console.error('[Resident Withdraw Cancel Service Error]:', err);
    res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi khi rút yêu cầu hủy dịch vụ.' });
  } finally {
    await release();
  }
});

/**
 * PATCH /api/v1/resident/profile (P8)
 * Cư dân chỉnh sửa hồ sơ cá nhân của mình (RU)
 */
router.patch('/profile', authenticateToken, async (req, res) => {
  const { full_name, phone, email, dob, id_number, address, nationality, avatar_base64 } = req.body;
  const personId = req.user.person_id;
  const orgId = req.user.org_id;

  const { client, release } = await getUserClient(req);
  try {
    await client.query('BEGIN');

    if (phone || id_number) {
      const dup = await adminPool.query(
        `SELECT id FROM person
         WHERE org_id = $1 AND id <> $2
           AND (($3::text IS NOT NULL AND phone = $3) OR ($4::text IS NOT NULL AND id_number = $4))
         LIMIT 1`,
        [orgId, personId, phone?.trim() || null, id_number?.trim() || null]
      );
      if (dup.rows.length > 0) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          code: 'DUPLICATE_PERSON_DATA',
          message: 'Số điện thoại hoặc số CCCD đã được sử dụng bởi một hồ sơ khác.',
        });
      }
    }

    let avatarUrl = null;
    if (avatar_base64 && typeof avatar_base64 === 'string' && avatar_base64.startsWith('data:image/')) {
      const saved = await saveBase64Image({
        imageBase64: avatar_base64,
        folder: 'person',
        entityId: personId,
        entity: 'person',
        ownerId: personId,
        req,
        query: (sql, params) => client.query(sql, params),
      });
      if (saved.error) {
        await client.query('ROLLBACK');
        return res.status(400).json(saved.error);
      }
      avatarUrl = `/api/v1/attachments/${saved.attachment.id}/view`;
    }

    const upd = await client.query(
      `UPDATE person
       SET full_name = COALESCE($1, full_name),
           phone = COALESCE($2, phone),
           email = COALESCE($3, email),
           dob = COALESCE($4::date, dob),
           id_number = COALESCE($5, id_number),
           address = COALESCE($6, address),
           nationality = COALESCE($7, nationality),
           avatar_url = COALESCE($8, avatar_url),
           updated_at = NOW()
       WHERE id = $9
       RETURNING id, full_name, phone, email, dob, id_number, address, nationality, avatar_url`,
      [
        full_name?.trim() || null,
        phone?.trim() || null,
        email?.trim() || null,
        dob || null,
        id_number?.trim() || null,
        address?.trim() || null,
        nationality?.trim() || null,
        avatarUrl,
        personId,
      ]
    );

    await client.query(
      `INSERT INTO audit_log (actor_id, action, entity, entity_id, after)
       VALUES ($1, 'UPDATE_PROFILE', 'person', $2, $3)`,
      [req.user.sub, personId, JSON.stringify(upd.rows[0])]
    );

    await client.query('COMMIT');
    res.json({ message: 'Cập nhật hồ sơ cá nhân thành công.', data: upd.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[Resident Update Profile Error]:', err);
    res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi khi cập nhật hồ sơ cá nhân.' });
  } finally {
    await release();
  }
});

/**
 * GET /api/v1/resident/contract-requests (FR-019)
 */
router.get('/contract-requests', authenticateToken, async (req, res) => {
  try {
    const personId = req.user.person_id;
    const userId = req.user.sub;
    const contractId = req.query.contract_id ? String(req.query.contract_id).trim() : null;

    const params = [userId, personId];
    let contractFilter = '';
    if (contractId) {
      params.push(contractId);
      contractFilter = ' AND cr.contract_id = $3';
    }

    const query = `
      SELECT cr.id, cr.type, cr.desired_date, cr.note, cr.status, cr.created_at, cr.updated_at,
             c.id as contract_id,
             a.code as apartment_code,
             b.name as building_name
      FROM contract_request cr
      JOIN contract c ON c.id = cr.contract_id
      JOIN apartment a ON a.id = c.apartment_id
      JOIN building b ON b.id = cr.building_id
      WHERE (
        cr.created_by = $1
        OR c.primary_tenant_id IN (SELECT id FROM tenant WHERE person_id = $2)
      )
      ${contractFilter}
      ORDER BY cr.created_at DESC
    `;
    const result = await pool.query(query, params);
    res.json({ data: result.rows });
  } catch (err) {
    console.error('Lỗi lấy danh sách đề nghị:', err);
    res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi lấy danh sách đề nghị hợp đồng.' });
  }
});

/**
 * POST /api/v1/resident/contract-requests (FR-019, AC-006.1)
 */
router.post('/contract-requests', authenticateToken, async (req, res) => {
  const { type, desired_date, note, contract_id } = req.body;
  if (!['RENEWAL', 'TERMINATION'].includes(type)) {
    return res.status(400).json({ code: 'INVALID_TYPE', message: 'Loại đề nghị phải là RENEWAL hoặc TERMINATION.' });
  }

  try {
    const personId = req.user.person_id;
    const userId = req.user.sub;

    const cParams = [personId];
    let cFilter = '';
    if (contract_id) {
      cParams.push(contract_id);
      cFilter = ' AND c.id = $2';
    }

    const contractRes = await pool.query(
      `SELECT c.id, c.building_id, c.apartment_id, b.org_id, c.end_date, a.code as apartment_code
       FROM contract c
       JOIN tenant t ON t.id = c.primary_tenant_id
       JOIN apartment a ON a.id = c.apartment_id
       JOIN building b ON b.id = c.building_id
       WHERE t.person_id = $1 AND c.status IN ('ACTIVE', 'RENEWAL_PENDING')${cFilter}
       ORDER BY (CASE WHEN c.start_date <= CURRENT_DATE THEN 0 ELSE 1 END), c.created_at DESC
       LIMIT 1`,
      cParams
    );

    if (contractRes.rows.length === 0) {
      return res.status(404).json({ code: 'CONTRACT_NOT_FOUND', message: 'Bạn không có hợp đồng thuê nào đang hiệu lực để gửi đề nghị.' });
    }

    const contract = contractRes.rows[0];

    if (type === 'TERMINATION') {
      if (!desired_date) {
        return res.status(422).json({ code: 'INVALID_DATE', message: 'Vui lòng chọn ngày mong muốn chấm dứt hợp đồng.' });
      }
      const todayRes = await pool.query('SELECT CURRENT_DATE::text AS today');
      const todayStr = todayRes.rows[0].today;
      const desiredStr = String(desired_date).slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(desiredStr) || desiredStr < todayStr) {
        return res.status(422).json({ code: 'INVALID_DATE', message: 'Ngày mong muốn chấm dứt phải từ hôm nay trở đi.' });
      }
    }

    const insertRes = await pool.query(
      `INSERT INTO contract_request (org_id, contract_id, building_id, type, desired_date, note, status, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, 'SUBMITTED', $7)
       RETURNING *`,
      [contract.org_id, contract.id, contract.building_id, type, desired_date || null, note?.trim() || null, userId]
    );

    await pool.query(
      `INSERT INTO audit_log (actor_id, action, entity, entity_id, after)
       VALUES ($1, 'CREATE', 'contract_request', $2, $3)`,
      [userId, insertRes.rows[0].id, JSON.stringify({ type, desired_date, note, contract_id: contract.id })]
    );

    try {
      const reqLabel = type === 'TERMINATION' ? 'chấm dứt hợp đồng' : 'gia hạn hợp đồng';
      await notifyBuildingManagers(contract.org_id, contract.building_id, {
        title: `Đề nghị ${reqLabel} — Phòng ${contract.apartment_code}`,
        content: `Cư dân căn ${contract.apartment_code} vừa gửi đề nghị ${reqLabel}${desired_date ? ` (ngày mong muốn: ${String(desired_date).slice(0, 10)})` : ''}. Vui lòng xem xét và phản hồi.`,
        type: 'CONTRACT_REQUEST_SUBMITTED',
        payload: {
          request_id: insertRes.rows[0].id,
          contract_id: contract.id,
          building_id: contract.building_id,
          apartment_id: contract.apartment_id,
          request_type: type,
        },
      });
    } catch (notifErr) {
      console.error('[Contract Request Notification Warning]:', notifErr);
    }

    const noticeNotice = type === 'TERMINATION'
      ? 'Theo quy định (AC-006.1), đề nghị chấm dứt cần báo trước tối thiểu 30 ngày để BQL sắp xếp kiểm tra bàn giao phòng.'
      : 'BQL sẽ liên hệ để thống nhất điều khoản gia hạn và lập phụ lục hợp đồng.';

    res.status(201).json({
      message: 'Gửi đề nghị thành công. ' + noticeNotice,
      data: insertRes.rows[0],
      notice_period_info: noticeNotice,
    });
  } catch (err) {
    console.error('Lỗi gửi đề nghị hợp đồng:', err);
    res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi gửi đề nghị hợp đồng.' });
  }
});

/**
 * GET /api/v1/resident/deposit-transactions (D9, AC-024.1)
 */
router.get('/deposit-transactions', authenticateToken, async (req, res) => {
  try {
    const personId = req.user.person_id;
    const contractId = req.query.contract_id ? String(req.query.contract_id).trim() : null;

    const params = [personId];
    let contractFilter = '';
    if (contractId) {
      params.push(contractId);
      contractFilter = ' AND c.id = $2';
    }

    const contractRes = await pool.query(
      `SELECT c.id as contract_id, c.status as contract_status, c.deposit_amount, c.start_date, c.end_date,
              d.id as deposit_id, d.amount_held, d.status as deposit_status, d.settlement,
              a.code as apartment_code, b.name as building_name
       FROM contract c
       JOIN tenant t ON t.id = c.primary_tenant_id
       JOIN apartment a ON a.id = c.apartment_id
       JOIN building b ON b.id = c.building_id
       LEFT JOIN deposit d ON d.contract_id = c.id
       WHERE t.person_id = $1${contractFilter}
       ORDER BY (CASE WHEN c.status IN ('ACTIVE', 'RENEWAL_PENDING', 'TERMINATION_PENDING') THEN 0 ELSE 1 END),
                (CASE WHEN c.start_date <= CURRENT_DATE THEN 0 ELSE 1 END),
                c.created_at DESC
       LIMIT 1`,
      params
    );

    if (contractRes.rows.length === 0) {
      return res.json({ data: { contract: null, deposit: null, transactions: [] } });
    }

    const contractInfo = contractRes.rows[0];
    let transactions = [];

    if (contractInfo.deposit_id) {
      const txRes = await pool.query(
        `SELECT id, type, amount, category, method, evidence, description AS note, description, status, created_at
         FROM deposit_transaction
         WHERE deposit_id = $1 AND status = 'APPROVED'
         ORDER BY created_at ASC`,
        [contractInfo.deposit_id]
      );
      transactions = txRes.rows;
    }

    res.json({
      data: {
        contract: {
          id: contractInfo.contract_id,
          status: contractInfo.contract_status,
          deposit_amount: contractInfo.deposit_amount,
          start_date: contractInfo.start_date,
          end_date: contractInfo.end_date,
          apartment_code: contractInfo.apartment_code,
          building_name: contractInfo.building_name,
        },
        deposit: contractInfo.deposit_id ? {
          id: contractInfo.deposit_id,
          amount_held: contractInfo.amount_held,
          status: contractInfo.deposit_status,
          settlement: contractInfo.settlement,
        } : null,
        transactions,
      },
    });
  } catch (err) {
    console.error('Lỗi lấy sổ cọc cư dân:', err);
    res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi lấy thông tin sổ cọc.' });
  }
});

export default router;
