import crypto from 'node:crypto';
import express from 'express';
import { pool, adminPool, getUserClient } from '../db/client.js';
import { authenticateToken } from '../middleware/auth.js';
import { saveBase64Image } from '../services/imageUpload.js';
import { roundVND } from '../services/pricing.js';
import { normalizeVnPhone } from '../services/residentAccount.js';
import { validateAndNormalizeSubscriptionMeta } from '../services/serviceSubscriptionMeta.js';

const router = express.Router();

const SR_CATEGORIES = ['ELECTRICAL', 'PLUMBING', 'HVAC', 'FURNITURE', 'APPLIANCE', 'CLEANING', 'SECURITY', 'OTHER'];
const SR_PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT'];

function computeProrata(unitPrice, quantity, targetDateStr, mode = 'subscribe') {
  const dt = targetDateStr ? new Date(targetDateStr) : new Date();
  const year = dt.getFullYear();
  const month = dt.getMonth();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const day = dt.getDate();
  const activeDays = mode === 'cancel' ? day : Math.max(1, daysInMonth - day + 1);
  return roundVND((Number(unitPrice || 0) * Number(quantity || 1) * activeDays) / daysInMonth);
}

async function generateTrackingCode(queryFn) {
  const datePart = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const rand = Math.floor(1000 + Math.random() * 9000);
  const candidate = `SR-${datePart}-${rand}`;
  const dup = await queryFn('SELECT 1 FROM service_request WHERE tracking_code = $1', [candidate]);
  if (dup.rows.length === 0) return candidate;
  return `SR-${datePart}-${Math.floor(10000 + Math.random() * 90000)}`;
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
      .filter((r) => r.deposit_id && (r.deposit_settlement || ['SETTLEMENT_DRAFT', 'PENDING_APPROVAL', 'DISPUTED', 'PARTIALLY_REFUNDED', 'REFUNDED'].includes(r.deposit_status)))
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
         AND i.status IN ('ISSUED', 'OVERDUE', 'PARTIALLY_PAID')`,
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
           AND i.status IN ('ISSUED', 'OVERDUE', 'PARTIALLY_PAID')`,
        [personId, contract.contract_id]
      );
      currentAmountDue = Number(contractDebtRes.rows[0]?.invoice_due || 0);

      const latestInvRes = await pool.query(
        `SELECT i.id, i.invoice_code, i.period, i.due_date, i.total_amount, i.paid_amount, i.status
         FROM invoice i
         JOIN tenant t ON t.id = i.tenant_id
         WHERE t.person_id = $1 AND i.contract_id = $2 AND i.status <> 'DRAFT'
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
         WHERE t.person_id = $1 AND i.status <> 'DRAFT'
         ORDER BY i.period DESC, i.created_at DESC
         LIMIT 1`,
        [personId]
      );
      latestInvoice = latestInvRes.rows[0] || null;
    }

    // 3. Đặt cọc giữ chỗ (trả cả danh sách reservations lẫn bản ghi mới nhất reservation)
    let reservations = [];
    if (cleanPhone) {
      const reservationRes = await pool.query(
        `SELECT 
           r.id as reservation_id,
           r.prospect_name,
           r.hold_from,
           r.hold_amount,
           r.hold_until,
           r.status as reservation_status,
           r.note as reservation_note,
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
           AND r.status = 'HELD'
         ORDER BY r.created_at DESC`,
        [cleanPhone, userPhone, orgId]
      );
      reservations = reservationRes.rows;
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
        reservation,
        reservations,
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
 * Danh sách yêu cầu sửa chữa / báo hỏng đã gửi của cư dân
 */
router.get('/service-requests', authenticateToken, async (req, res) => {
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
          JOIN tenant t2 ON t2.id = c2.primary_tenant_id
          WHERE c2.id = $3 AND t2.person_id = $2
        )
      `;
    }

    const result = await pool.query(
      `SELECT sr.*,
              a.code as apartment_code,
              b.name as building_name,
              p_assigned.full_name as assigned_to_name
       FROM service_request sr
       JOIN apartment a ON a.id = sr.apartment_id
       JOIN building b ON b.id = sr.building_id
       LEFT JOIN app_user u_assigned ON u_assigned.id = sr.assigned_to
       LEFT JOIN person p_assigned ON p_assigned.id = u_assigned.person_id
       WHERE (
         sr.created_by = $1
         OR sr.apartment_id IN (
           SELECT c.apartment_id FROM contract c
           JOIN tenant t ON t.id = c.primary_tenant_id
           WHERE t.person_id = $2 AND c.status IN ('ACTIVE', 'RENEWAL_PENDING', 'TERMINATION_PENDING')
         )
       )
       ${contractScopeSql}
       ORDER BY sr.created_at DESC`,
      params
    );

    res.json({ data: result.rows });
  } catch (err) {
    console.error('[Resident Get Service Requests Error]:', err);
    res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi khi tải danh sách yêu cầu báo hỏng.' });
  }
});

/**
 * POST /api/v1/resident/service-requests (FR-042, AC-004.1, AC-004.2)
 * Cư dân gửi yêu cầu sửa chữa / báo hỏng vào bảng service_request (tối đa 3 ảnh, trả mã tra cứu)
 */
router.post('/service-requests', authenticateToken, async (req, res) => {
  const {
    title,
    category = 'OTHER',
    description,
    priority,
    urgency,
    apartment_id,
    contract_id,
    images = [],
    confirm_duplicate = false,
  } = req.body;

  if (!description?.trim()) {
    return res.status(400).json({ code: 'INVALID_INPUT', message: 'Vui lòng nhập mô tả chi tiết sự cố.' });
  }

  const normCategory = SR_CATEGORIES.includes(String(category).toUpperCase())
    ? String(category).toUpperCase()
    : 'OTHER';

  const rawPrio = String(priority || urgency || 'NORMAL').toUpperCase();
  const normPriority = SR_PRIORITIES.includes(rawPrio) ? rawPrio : 'NORMAL';

  if (Array.isArray(images) && images.length > 3) {
    return res.status(400).json({
      code: 'TOO_MANY_IMAGES',
      message: 'Chỉ được đính kèm tối đa 3 ảnh minh họa cho mỗi yêu cầu (AC-004.1).',
    });
  }

  const { client, release } = await getUserClient(req);
  try {
    // Xác định căn hộ đang thuê của cư dân (hỗ trợ contract_id hoặc apartment_id khi cư dân thuê nhiều căn)
    let targetAptQuery = `
      SELECT c.id as contract_id, c.apartment_id, c.building_id, b.org_id, a.code as apartment_code
      FROM contract c
      JOIN tenant t ON t.id = c.primary_tenant_id
      JOIN apartment a ON a.id = c.apartment_id
      JOIN building b ON b.id = c.building_id
      WHERE t.person_id = $1 AND c.status IN ('ACTIVE', 'RENEWAL_PENDING', 'TERMINATION_PENDING')
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

    const { apartment_id: aptId, building_id: bldgId, org_id: orgId } = aptRes.rows[0];

    // AC-004.2: Cảnh báo yêu cầu trùng danh mục đang mở trên cùng căn hộ trong 7 ngày qua
    if (!confirm_duplicate) {
      const dupCheck = await client.query(
        `SELECT id, tracking_code, title, status, created_at
         FROM service_request
         WHERE apartment_id = $1
           AND category = $2
           AND status IN ('NEW', 'ASSIGNED', 'IN_PROGRESS')
           AND created_at >= NOW() - INTERVAL '7 days'
         ORDER BY created_at DESC
         LIMIT 1`,
        [aptId, normCategory]
      );
      if (dupCheck.rows.length > 0) {
        return res.status(409).json({
          code: 'DUPLICATE_SERVICE_REQUEST',
          message: `Căn hộ đang có yêu cầu cùng hạng mục chờ xử lý (${dupCheck.rows[0].tracking_code}). Bạn vẫn muốn gửi thêm yêu cầu mới?`,
          existing_request: dupCheck.rows[0],
        });
      }
    }

    await client.query('BEGIN');

    const trackingCode = await generateTrackingCode((s, p) => client.query(s, p));
    const finalTitle = title?.trim() || `Báo hỏng ${normCategory} - ${description.trim().slice(0, 48)}`;

    const insRes = await client.query(
      `INSERT INTO service_request (
         org_id, building_id, apartment_id, created_by,
         title, category, description, priority, status, tracking_code, images
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'NEW', $9, '{}')
       RETURNING *`,
      [orgId, bldgId, aptId, req.user.sub, finalTitle, normCategory, description.trim(), normPriority, trackingCode]
    );
    const createdReq = insRes.rows[0];

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

    await client.query(
      `INSERT INTO audit_log (actor_id, action, entity, entity_id, after)
       VALUES ($1, 'CREATE', 'service_request', $2, $3)`,
      [req.user.sub, finalRow.id, JSON.stringify(finalRow)]
    );

    await client.query('COMMIT');

    res.status(201).json({
      message: `Đã tiếp nhận yêu cầu báo hỏng. Mã tra cứu của bạn là ${finalRow.tracking_code}.`,
      data: finalRow,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[Create Resident Service Request Error]:', err);
    res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi ghi nhận yêu cầu hỗ trợ.' });
  } finally {
    await release();
  }
});

/**
 * POST /api/v1/resident/service-requests/:id/rating (P5)
 * Cư dân đánh giá chất lượng xử lý (1-5 sao) sau khi sự cố đã được giải quyết
 */
router.post('/service-requests/:id/rating', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const { rating, rating_note } = req.body;
  const numRating = Number(rating);

  if (!Number.isInteger(numRating) || numRating < 1 || numRating > 5) {
    return res.status(400).json({ code: 'INVALID_RATING', message: 'Điểm đánh giá phải từ 1 đến 5 sao.' });
  }

  try {
    const srRes = await pool.query(
      `SELECT * FROM service_request WHERE id = $1 AND created_by = $2`,
      [id, req.user.sub]
    );
    if (srRes.rows.length === 0) {
      return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy yêu cầu báo hỏng của bạn.' });
    }
    const sr = srRes.rows[0];
    if (!['RESOLVED', 'CLOSED'].includes(sr.status)) {
      return res.status(409).json({
        code: 'NOT_RESOLVED',
        message: 'Chỉ có thể đánh giá sau khi yêu cầu đã được xử lý xong (RESOLVED).',
      });
    }

    const updated = await pool.query(
      `UPDATE service_request
       SET rating = $1, rating_note = $2, status = 'CLOSED', updated_at = NOW()
       WHERE id = $3
       RETURNING *`,
      [numRating, rating_note?.trim() || null, id]
    );

    res.json({ message: 'Cảm ơn bạn đã gửi đánh giá chất lượng dịch vụ!', data: updated.rows[0] });
  } catch (err) {
    console.error('[Rate Service Request Error]:', err);
    res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi khi lưu đánh giá.' });
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
        `SELECT * FROM invoice_line WHERE invoice_id = ANY($1::uuid[]) ORDER BY created_at ASC`,
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

    res.json({ data });
  } catch (err) {
    console.error('[Resident Invoices Error]:', err);
    res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi khi tải danh sách hóa đơn.' });
  }
});

/**
 * POST /api/v1/resident/payments/report (FR-037, P3)
 * Cư dân báo đã chuyển khoản thanh toán hóa đơn + đính kèm chứng từ
 */
router.post('/payments/report', authenticateToken, async (req, res) => {
  const { invoice_id, amount, method = 'BANK_TRANSFER', reference_code, paid_at, note, proof_images = [] } = req.body;
  const numAmount = Number(amount);

  if (!invoice_id || !numAmount || numAmount <= 0) {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Vui lòng chọn hóa đơn và nhập số tiền thanh toán hợp lệ.' });
  }

  const { client, release } = await getUserClient(req);
  try {
    const invRes = await client.query(
      `SELECT i.*, t.person_id
       FROM invoice i
       JOIN tenant t ON t.id = i.tenant_id
       WHERE i.id = $1 AND t.person_id = $2`,
      [invoice_id, req.user.person_id]
    );
    if (invRes.rows.length === 0) {
      return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy hóa đơn cần thanh toán.' });
    }
    const inv = invRes.rows[0];
    if (inv.status === 'PAID' || inv.status === 'CANCELLED') {
      return res.status(409).json({ code: 'INVOICE_CLOSED', message: 'Hóa đơn này đã hoàn tất hoặc đã hủy.' });
    }

    await client.query('BEGIN');

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
 */
router.get('/services', authenticateToken, async (req, res) => {
  try {
    const orgId = req.user.org_id;
    const personId = req.user.person_id;
    const contractId = req.query.contract_id ? String(req.query.contract_id).trim() : null;

    const catalogRes = await pool.query(
      `SELECT * FROM service_catalog WHERE org_id = $1 AND is_active = TRUE ORDER BY category, name`,
      [orgId]
    );

    const subParams = [personId];
    let subFilter = '';
    if (contractId) {
      subParams.push(contractId);
      subFilter = ' AND ss.contract_id = $2';
    }

    const subsRes = await pool.query(
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
        catalog: catalogRes.rows,
        subscriptions: subsRes.rows,
      },
    });
  } catch (err) {
    console.error('[Resident Services Error]:', err);
    res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi khi tải thông tin dịch vụ.' });
  }
});

/**
 * POST /api/v1/resident/services (FR-027, FR-029)
 * Cư dân đăng ký dịch vụ mới (kèm tính phí pro-rata kỳ đầu, hỗ trợ chọn contract_id)
 */
router.post('/services', authenticateToken, async (req, res) => {
  const { service_id, quantity = 1, start_date, note, vehicle_plates, contract_id } = req.body;
  if (!service_id) {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Vui lòng chọn dịch vụ cần đăng ký.' });
  }

  try {
    const cParams = [req.user.person_id];
    let cFilter = '';
    if (contract_id) {
      cParams.push(contract_id);
      cFilter = ' AND c.id = $2';
    }

    const contractRes = await pool.query(
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

    const svcRes = await pool.query(
      `SELECT * FROM service_catalog WHERE id = $1 AND org_id = $2 AND is_active = TRUE`,
      [service_id, c.org_id]
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
    const effStart = start_date || new Date().toISOString().slice(0, 10);
    const prorata = computeProrata(svc.unit_price, qty, effStart, 'subscribe');

    const ins = await pool.query(
      `INSERT INTO service_subscription (
         org_id, building_id, apartment_id, contract_id, service_id,
         quantity, unit_price, start_date, prorata_amount, status, note, vehicle_plates, requested_by
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'PENDING_APPROVAL', $10, $11, $12)
       RETURNING *`,
      [
        c.org_id,
        c.building_id,
        c.apartment_id,
        c.contract_id,
        svc.id,
        qty,
        svc.unit_price,
        effStart,
        prorata,
        meta.note,
        meta.vehiclePlates,
        req.user.sub,
      ]
    );

    res.status(201).json({
      message: 'Đã gửi yêu cầu đăng ký dịch vụ, chờ Ban Quản Lý phê duyệt.',
      data: ins.rows[0],
    });
  } catch (err) {
    if (err.httpStatus) {
      return res.status(err.httpStatus).json({ code: err.code, message: err.message });
    }
    console.error('[Resident Subscribe Service Error]:', err);
    res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi khi đăng ký dịch vụ.' });
  }
});

/**
 * PATCH /api/v1/resident/services/:id/cancel (FR-029)
 * Cư dân yêu cầu hủy dịch vụ (tính pro-rata tới ngày kết thúc)
 */
router.patch('/services/:id/cancel', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const { end_date, note } = req.body;

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

    const subRes = await pool.query(
      `SELECT ss.*
       FROM service_subscription ss
       JOIN contract c ON c.id = ss.contract_id
       JOIN tenant t ON t.id = c.primary_tenant_id
       WHERE ss.id = $1 AND t.person_id = $2`,
      [id, req.user.person_id]
    );
    if (subRes.rows.length === 0) {
      return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy đăng ký dịch vụ.' });
    }
    const sub = subRes.rows[0];
    const effEnd = end_date || new Date().toISOString().slice(0, 10);
    const nextStatus = sub.status === 'PENDING_APPROVAL' ? 'CANCELLED' : 'CANCELLATION_PENDING';
    const prorata = computeProrata(sub.unit_price, sub.quantity, effEnd, 'cancel');

    const upd = await pool.query(
      `UPDATE service_subscription
       SET status = $1, end_date = $2, prorata_amount = $3, note = COALESCE($4, note), updated_at = NOW()
       WHERE id = $5
       RETURNING *`,
      [nextStatus, effEnd, prorata, cleanCancelNote, id]
    );

    res.json({
      message: nextStatus === 'CANCELLED' ? 'Đã hủy yêu cầu đăng ký dịch vụ.' : 'Đã gửi yêu cầu hủy dịch vụ tới Ban Quản Lý.',
      data: upd.rows[0],
    });
  } catch (err) {
    if (err.httpStatus) {
      return res.status(err.httpStatus).json({ code: err.code, message: err.message });
    }
    console.error('[Resident Cancel Service Error]:', err);
    res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi khi hủy dịch vụ.' });
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
      `SELECT c.id, c.building_id, b.org_id, c.end_date, a.code as apartment_code
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
