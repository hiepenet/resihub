import express from 'express';
import { adminPool } from '../db/client.js';
import { otpRequestLimiter } from '../middleware/rateLimiter.js';
import { idempotencyGuard } from '../middleware/idempotency.js';
import { requestPhoneOtp, verifyPhoneOtp, consumePhoneOtp } from '../services/otpService.js';
import {
  normalizeVnPhone,
  isInternalPerson,
  ensureResidentAccount,
} from '../services/residentAccount.js';
import {
  isPositiveSafeIntegerVnd,
  DEFAULT_RESERVATION_CANCEL_POLICY,
} from '../services/depositSettlement.js';
import {
  getOrgReservationCancelPolicy,
  persistReservationEvidence,
  getTodayVnDateStr,
} from './reservations.js';

const router = express.Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NEUTRAL_OTP_MESSAGE =
  'Nếu số điện thoại hợp lệ, mã xác thực OTP đã được gửi và có hiệu lực trong 5 phút.';

function normalizeCancelPolicyValue(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ...DEFAULT_RESERVATION_CANCEL_POLICY };
  }
  return {
    max_hold_days: Math.max(
      1,
      Number(raw.max_hold_days ?? DEFAULT_RESERVATION_CANCEL_POLICY.max_hold_days)
    ),
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
      Math.max(
        0,
        Number(raw.partial_refund_pct ?? DEFAULT_RESERVATION_CANCEL_POLICY.partial_refund_pct)
      )
    ),
    default_hold_amount: Math.max(
      0,
      Number(raw.default_hold_amount ?? DEFAULT_RESERVATION_CANCEL_POLICY.default_hold_amount)
    ),
  };
}

function sanitizePublicPaymentAccount(rawAcc) {
  if (!rawAcc || typeof rawAcc !== 'object') return null;
  const bankName = String(rawAcc.bank_name || '').trim();
  const bankBin = String(rawAcc.bank_bin || '').trim();
  const accountNumber = String(rawAcc.account_number || '').trim();
  const accountName = String(rawAcc.account_name || rawAcc.account_holder || '').trim();
  if (!bankName && !bankBin && !accountNumber && !accountName) return null;
  return {
    bank_name: bankName,
    bank_bin: bankBin,
    account_number: accountNumber,
    account_name: accountName,
  };
}

async function resolvePublicReservationIdemScope(req) {
  const aptId = String(req.body?.apartment_id || '').trim();
  const cleanPhone = normalizeVnPhone(req.body?.phone);
  if (!UUID_RE.test(aptId) || !/^0[0-9]{9}$/.test(cleanPhone)) {
    return null;
  }
  const aptOrgRes = await adminPool.query(
    `SELECT b.org_id
     FROM apartment a
     JOIN building b ON b.id = a.building_id
     WHERE a.id = $1
     LIMIT 1`,
    [aptId]
  );
  if (aptOrgRes.rows.length === 0) return null;
  return {
    orgId: aptOrgRes.rows[0].org_id,
    scopeKey: `public:${cleanPhone}`,
    actorId: null,
  };
}

/**
 * GET /api/v1/public/apartments
 * Danh mục tòa nhà & căn hộ trống công khai (FR-070, Sitemap H1/H2/H3)
 * Tuyệt đối không lộ PII cư dân hoặc ghi chú nội bộ.
 */
router.get('/apartments', async (req, res) => {
  try {
    const rawOrgId = req.query.org_id ? String(req.query.org_id).trim() : null;
    const rawBuildingId = req.query.building_id ? String(req.query.building_id).trim() : null;

    if (rawOrgId && !UUID_RE.test(rawOrgId)) {
      return res.status(400).json({ code: 'INVALID_ORG_ID', message: 'Mã tổ chức không hợp lệ.' });
    }
    if (rawBuildingId && !UUID_RE.test(rawBuildingId)) {
      return res.status(400).json({ code: 'INVALID_BUILDING_ID', message: 'Mã tòa nhà không hợp lệ.' });
    }

    const bConditions = [`b.status = 'ACTIVE'`];
    const bParams = [];
    if (rawOrgId) {
      bParams.push(rawOrgId);
      bConditions.push(`b.org_id = $${bParams.length}`);
    }
    if (rawBuildingId) {
      bParams.push(rawBuildingId);
      bConditions.push(`b.id = $${bParams.length}`);
    }

    const buildingsRes = await adminPool.query(
      `SELECT b.id, b.org_id, b.code, b.name, b.address, b.timezone, b.lease_terms
       FROM building b
       WHERE ${bConditions.join(' AND ')}
       ORDER BY b.name ASC`,
      bParams
    );

    const aptRes = await adminPool.query(
      `SELECT
         a.id,
         a.building_id,
         a.floor_id,
         a.zone_id,
         a.code,
         a.type,
         a.bedrooms,
         a.area_m2,
         a.base_rent,
         a.amenities,
         a.status,
         b.org_id,
         b.name AS building_name,
         b.code AS building_code,
         b.address AS building_address,
         f.name AS floor_name,
         z.name AS zone_name
       FROM apartment a
       JOIN building b ON b.id = a.building_id
       LEFT JOIN floor f ON f.id = a.floor_id
       LEFT JOIN zone z ON z.id = a.zone_id
       WHERE a.status = 'AVAILABLE'
         AND ${bConditions.join(' AND ')}
       ORDER BY b.name ASC, a.code ASC`,
      bParams
    );

    const orgIdSet = new Set();
    if (rawOrgId) orgIdSet.add(rawOrgId);
    for (const b of buildingsRes.rows) {
      if (b.org_id) orgIdSet.add(b.org_id);
    }
    const orgIds = Array.from(orgIdSet);

    const policiesByOrg = {};
    const billingConfigByOrg = {};
    const contactConfigByOrg = {};

    if (orgIds.length > 0) {
      const settingsRes = await adminPool.query(
        `SELECT org_id, key, value
         FROM system_setting
         WHERE org_id = ANY($1::uuid[])
           AND key IN ('reservation_cancel_policy', 'billing_config', 'contact_config')`,
        [orgIds]
      );
      for (const oid of orgIds) {
        policiesByOrg[oid] = { ...DEFAULT_RESERVATION_CANCEL_POLICY };
      }
      for (const sRow of settingsRes.rows) {
        if (sRow.key === 'reservation_cancel_policy') {
          policiesByOrg[sRow.org_id] = normalizeCancelPolicyValue(sRow.value);
        } else if (sRow.key === 'billing_config') {
          billingConfigByOrg[sRow.org_id] = sRow.value || {};
        } else if (sRow.key === 'contact_config') {
          contactConfigByOrg[sRow.org_id] = sRow.value || {};
        }
      }
    }

    const paymentAccounts = {};
    const sanitizedBuildings = buildingsRes.rows.map((b) => {
      const rawTerms = b.lease_terms && typeof b.lease_terms === 'object' ? b.lease_terms : {};
      const bPayAcc =
        sanitizePublicPaymentAccount(rawTerms.payment_account) ||
        sanitizePublicPaymentAccount(billingConfigByOrg[b.org_id]?.payment_account) ||
        sanitizePublicPaymentAccount(billingConfigByOrg[b.org_id]);
      paymentAccounts[b.id] = bPayAcc;

      return {
        id: b.id,
        org_id: b.org_id,
        code: b.code,
        name: b.name,
        address: b.address,
        timezone: b.timezone,
        payment_account: bPayAcc,
        contact_config: contactConfigByOrg[b.org_id] || null,
        lease_highlights: {
          min_lease_months: rawTerms.min_lease_months ?? null,
          deposit_months: rawTerms.deposit_months ?? null,
          curfew_note: rawTerms.curfew_note ?? null,
          pet_policy: rawTerms.pet_policy ?? null,
        },
      };
    });

    const primaryOrgId =
      rawOrgId || sanitizedBuildings[0]?.org_id || aptRes.rows[0]?.org_id || null;
    const primaryPolicy =
      (primaryOrgId && policiesByOrg[primaryOrgId]) || { ...DEFAULT_RESERVATION_CANCEL_POLICY };

    res.json({
      data: {
        buildings: sanitizedBuildings,
        apartments: aptRes.rows,
        policy: primaryPolicy,
        policies_by_org: policiesByOrg,
        payment_accounts: paymentAccounts,
      },
    });
  } catch (err) {
    console.error('[Public Apartments Catalog Error]:', err);
    res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi máy chủ khi tải danh sách căn hộ trống.' });
  }
});

/**
 * POST /api/v1/public/reservations/otp/request
 * Gửi OTP xác thực SĐT cho khách vãng lai đặt giữ chỗ online (AC-001.3)
 */
router.post('/reservations/otp/request', otpRequestLimiter, async (req, res) => {
  const cleanPhone = normalizeVnPhone(req.body?.phone);
  if (!/^0[0-9]{9}$/.test(cleanPhone)) {
    return res.status(400).json({
      code: 'INVALID_PHONE',
      message: 'Số điện thoại không hợp lệ. Vui lòng nhập đúng 10 chữ số (ví dụ: 0912345678).',
    });
  }

  const otpRes = requestPhoneOtp(cleanPhone, { store: true });
  if (!otpRes.ok) {
    return res.status(otpRes.status).json({
      code: otpRes.code,
      message: otpRes.message,
    });
  }

  console.log(`\n========================================`);
  console.log(`🔑 [PUBLIC RESERVATION OTP] SĐT: ${cleanPhone} | Mã OTP: ${otpRes.otp}`);
  console.log(`========================================\n`);

  const responsePayload = {
    message: NEUTRAL_OTP_MESSAGE,
  };
  if (process.env.NODE_ENV !== 'production') {
    responsePayload.devOtp = otpRes.otp;
  }

  return res.json(responsePayload);
});

/**
 * POST /api/v1/public/reservations
 * Khách vãng lai gửi yêu cầu giữ chỗ online kèm biên lai chuyển khoản (Phương án A: PENDING_CONFIRM)
 */
router.post(
  '/reservations',
  idempotencyGuard({ resolveScope: resolvePublicReservationIdemScope }),
  async (req, res) => {
    const {
      apartment_id,
      prospect_name,
      phone,
      otp,
      hold_amount,
      hold_from,
      hold_until,
      privacy_consent,
      evidence,
      note,
    } = req.body || {};

    const cleanPhone = normalizeVnPhone(phone);
    if (!/^0[0-9]{9}$/.test(cleanPhone)) {
      return res.status(400).json({
        code: 'INVALID_PHONE',
        message: 'Số điện thoại không hợp lệ. Vui lòng nhập đúng 10 chữ số (ví dụ: 0912345678).',
      });
    }

    const aptId = String(apartment_id || '').trim();
    if (!UUID_RE.test(aptId) || !String(prospect_name || '').trim()) {
      return res.status(400).json({
        code: 'VALIDATION_ERROR',
        message: 'Căn hộ và họ tên người đặt giữ chỗ là bắt buộc.',
      });
    }

    if (!String(otp ?? '').trim()) {
      return res.status(400).json({
        code: 'OTP_REQUIRED',
        message: 'Vui lòng nhập mã xác thực OTP 6 chữ số.',
      });
    }

    // Xác thực OTP dùng chung (không mở bypass dev master 123456 trên luồng công khai)
    const otpCheck = await verifyPhoneOtp(cleanPhone, otp, {
      allowDevMasterOtp: false,
      lockAuditAction: 'PUBLIC_OTP_LOCK',
      dbPool: adminPool,
      consumeOnSuccess: false,
    });
    if (!otpCheck.ok) {
      return res.status(otpCheck.status).json({
        code: otpCheck.code,
        message: otpCheck.message,
      });
    }

    if (privacy_consent !== true) {
      return res.status(422).json({
        code: 'PRIVACY_CONSENT_REQUIRED',
        message:
          'Vui lòng đồng ý chính sách bảo vệ dữ liệu cá nhân (Nghị định 13/2023/NĐ-CP) trước khi gửi yêu cầu giữ chỗ.',
      });
    }

    if (!Array.isArray(evidence) || evidence.filter((x) => String(x || '').trim()).length === 0) {
      return res.status(422).json({
        code: 'EVIDENCE_REQUIRED',
        message:
          'Vui lòng tải lên ít nhất 1 ảnh chụp biên lai chuyển khoản (UNC) để Ban quản lý đối chiếu sao kê.',
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

    const aptPreRes = await adminPool.query(
      `SELECT a.id, a.building_id, b.org_id, b.status AS building_status
       FROM apartment a
       JOIN building b ON b.id = a.building_id
       WHERE a.id = $1
       LIMIT 1`,
      [aptId]
    );
    if (aptPreRes.rows.length === 0 || aptPreRes.rows[0].building_status !== 'ACTIVE') {
      return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy căn hộ khả dụng.' });
    }
    const orgId = aptPreRes.rows[0].org_id;

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
        message:
          'Khoảng thời gian giữ chỗ không hợp lệ (ngày kết thúc phải sau ngày bắt đầu và không nằm trong quá khứ).',
      });
    }

    const policy = await getOrgReservationCancelPolicy(orgId);
    const publicMaxHoldDays = Number(policy.public_max_hold_days || 7);
    const diffDays = Math.round(
      (holdUntilDate.getTime() - holdFromDate.getTime()) / (24 * 60 * 60 * 1000)
    );
    if (diffDays > publicMaxHoldDays) {
      return res.status(400).json({
        code: 'HOLD_DURATION_EXCEEDED',
        message: `Thời hạn đặt giữ chỗ trực tuyến tối đa không quá ${publicMaxHoldDays} ngày.`,
      });
    }

    const client = await adminPool.connect();
    try {
      await client.query('BEGIN');

      const aptLockRes = await client.query(
        `SELECT a.*, b.org_id, b.name AS building_name, b.code AS building_code
         FROM apartment a
         JOIN building b ON b.id = a.building_id
         WHERE a.id = $1 AND b.status = 'ACTIVE'
         FOR UPDATE OF a`,
        [aptId]
      );
      if (aptLockRes.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy căn hộ.' });
      }
      const apt = aptLockRes.rows[0];

      if (apt.status !== 'AVAILABLE') {
        await client.query('ROLLBACK');
        return res.status(409).json({
          code: 'APARTMENT_NOT_AVAILABLE',
          message: 'Căn hộ hiện không còn trống để nhận đặt giữ chỗ mới.',
        });
      }

      const activeOccupationRes = await client.query(
        `SELECT 1 FROM contract
         WHERE apartment_id = $1
           AND status IN ('ACTIVE', 'RENEWAL_PENDING', 'TERMINATION_PENDING')
         UNION ALL
         SELECT 1 FROM reservation
         WHERE apartment_id = $1
           AND status IN ('HELD', 'CANCEL_PENDING_APPROVAL')
         LIMIT 1`,
        [aptId]
      );
      if (activeOccupationRes.rows.length > 0) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          code: 'APARTMENT_NOT_AVAILABLE',
          message: 'Căn hộ đã được giữ chỗ hoặc đang có hợp đồng thuê hiệu lực.',
        });
      }

      // Kiểm tra SĐT nhân sự nội bộ (SYS_ADMIN / OWNER / MANAGER / bảng owner)
      const existingPersonRes = await client.query(
        `SELECT id, full_name, phone
         FROM person
         WHERE org_id = $1 AND phone = $2
         FOR UPDATE`,
        [orgId, cleanPhone]
      );
      const existingPerson = existingPersonRes.rows[0] || null;
      if (existingPerson) {
        const internal = await isInternalPerson(existingPerson.id, orgId);
        if (internal) {
          await client.query('ROLLBACK');
          consumePhoneOtp(cleanPhone);
          return res.status(409).json({
            code: 'INTERNAL_ACCOUNT_PHONE',
            message:
              'Số điện thoại này thuộc tài khoản vận hành nội bộ, không thể dùng cho biểu mẫu đặt giữ chỗ khách thuê.',
          });
        }
      }

      // Chặn spam: 1 SĐT chỉ có tối đa 1 phiếu đang hoạt động (PENDING_CONFIRM, HELD, hoặc đang chờ duyệt hủy CANCEL_PENDING_APPROVAL) trong cùng tổ chức
      const dupPhoneRsv = await client.query(
        `SELECT id
         FROM reservation
         WHERE org_id = $1
           AND phone = $2
           AND status IN ('PENDING_CONFIRM', 'HELD', 'CANCEL_PENDING_APPROVAL')
         LIMIT 1`,
        [orgId, cleanPhone]
      );
      if (dupPhoneRsv.rows.length > 0) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          code: 'PHONE_ALREADY_HAS_ACTIVE_RESERVATION',
          message:
            'Số điện thoại này đang có một yêu cầu giữ chỗ chờ xác nhận hoặc đang giữ phòng hiệu lực.',
        });
      }

      // Phương án A: tạo reservation ở trạng thái PENDING_CONFIRM, GIỮ NGUYÊN apartment.status = 'AVAILABLE'
      const insRsvRes = await client.query(
        `INSERT INTO reservation (
           org_id, building_id, apartment_id, prospect_name, phone, hold_amount,
           hold_from, hold_until, status, source, method, confirmed_by, confirmed_at, note, created_by
         ) VALUES (
           $1::uuid, $2, $3, $4, $5, $6,
           $7, $8, 'PENDING_CONFIRM', 'PUBLIC', 'BANK_TRANSFER', NULL, NULL, $9, NULL
         )
         RETURNING *`,
        [
          orgId,
          apt.building_id,
          apt.id,
          String(prospect_name).trim(),
          cleanPhone,
          normalizedHoldAmount,
          holdFromStr,
          holdUntilStr,
          note ? String(note).trim() : '',
        ]
      );
      let reservation = insRsvRes.rows[0];

      const savedEvidence = await persistReservationEvidence(
        client,
        { user: null },
        reservation.id,
        evidence
      );
      const updRsvRes = await client.query(
        `UPDATE reservation SET evidence = $2 WHERE id = $1 RETURNING *`,
        [reservation.id, savedEvidence]
      );
      reservation = updRsvRes.rows[0];

      // Bảo vệ FR-021: nếu person đã tồn tại thì CHỈ cập nhật privacy_consent_at (tuyệt đối không ghi đè full_name / id_number)
      let personId;
      if (existingPerson) {
        personId = existingPerson.id;
        await client.query(
          `UPDATE person
           SET privacy_consent_at = COALESCE(privacy_consent_at, NOW()),
               privacy_policy_version = COALESCE(privacy_policy_version, 'v1.0')
           WHERE id = $1`,
          [personId]
        );
      } else {
        const insPerson = await client.query(
          `INSERT INTO person (
             org_id, full_name, phone, privacy_consent_at, privacy_policy_version, created_by
           ) VALUES ($1, $2, $3, NOW(), 'v1.0', NULL)
           RETURNING id`,
          [orgId, String(prospect_name).trim(), cleanPhone]
        );
        personId = insPerson.rows[0].id;
      }

      // Chỉ tạo hồ sơ tenant sơ bộ (PENDING) khi cư dân chưa có tenant APPROVED/PENDING
      const existingTenantRes = await client.query(
        `SELECT id
         FROM tenant
         WHERE person_id = $1
           AND org_id = $2
           AND status IN ('APPROVED', 'PENDING')
         LIMIT 1`,
        [personId, orgId]
      );
      if (existingTenantRes.rows.length === 0) {
        await client.query(
          `INSERT INTO tenant (
             person_id, org_id, type, status, desired_apartment_id, desired_building_id, created_by
           ) VALUES ($1, $2, 'primary', 'PENDING', $3, $4, NULL)`,
          [personId, orgId, apt.id, apt.building_id]
        );
      }

      // Gửi thông báo cho MANAGER của tòa nhà đối chiếu sao kê xác nhận tiền về
      await client.query(
        `INSERT INTO notification (org_id, user_id, title, content, type, payload)
         SELECT DISTINCT
           $1::uuid,
           au.id,
           $2,
           $3,
           'PUBLIC_RESERVATION_PENDING_CONFIRM',
           $4::jsonb
         FROM user_role ur
         JOIN role r ON r.id = ur.role_id
         JOIN app_user au ON au.id = ur.user_id
         WHERE r.code = 'MANAGER'
           AND ur.building_id = $5
           AND au.status = 'ACTIVE'`,
        [
          orgId,
          `Yêu cầu giữ chỗ mới chờ xác nhận sao kê — Căn ${apt.code}`,
          `Khách ${String(prospect_name).trim()} (${cleanPhone}) vừa gửi biên lai chuyển khoản giữ chỗ ${normalizedHoldAmount.toLocaleString('vi-VN')} đ cho căn ${apt.code} (${apt.building_name}). Vui lòng kiểm tra sao kê ngân hàng để xác nhận hoặc từ chối.`,
          JSON.stringify({
            reservation_id: reservation.id,
            apartment_id: apt.id,
            apartment_code: apt.code,
            building_id: apt.building_id,
            hold_amount: normalizedHoldAmount,
            phone: cleanPhone,
          }),
          apt.building_id,
        ]
      );

      await client.query(
        `INSERT INTO audit_log (actor_id, action, entity, entity_id, after)
         VALUES (NULL, 'PUBLIC_CREATE', 'reservation', $1, $2::jsonb)`,
        [reservation.id, JSON.stringify(reservation)]
      );

      await client.query('COMMIT');
      consumePhoneOtp(cleanPhone);

      if (personId) {
        try {
          await ensureResidentAccount(personId, { phone: cleanPhone });
        } catch (acctErr) {
          console.error('[Public Reservation Ensure Resident Account Warning]:', acctErr);
        }
      }

      return res.status(201).json({
        message:
          'Đã ghi nhận yêu cầu giữ chỗ trực tuyến. Ban quản lý tòa nhà sẽ đối chiếu sao kê và phản hồi sớm nhất.',
        data: reservation,
      });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      if (err.httpStatus) {
        return res.status(err.httpStatus).json({ code: err.code, message: err.message });
      }
      console.error('[Public Create Reservation Error]:', err);
      return res.status(500).json({
        code: 'DB_ERROR',
        message: 'Lỗi máy chủ khi gửi yêu cầu đặt giữ chỗ trực tuyến.',
      });
    } finally {
      client.release();
    }
  }
);

export default router;
