import bcrypt from 'bcryptjs';
import { adminPool } from '../db/client.js';
import { getManagerBuildingIds, getOwnerBuildingIds } from './ownerScope.js';
import { maskEmail, maskIdNumber, maskName, maskPhone } from '../utils/piiMask.js';

/**
 * Chuẩn hóa số điện thoại Việt Nam về định dạng 10 chữ số bắt đầu bằng 0 (VD: 0912345678)
 * Khớp hoàn toàn với chuẩn lưu trữ của auth.js (OTP & Login)
 */
export function normalizeVnPhone(phone) {
  let clean = String(phone || '')
    .trim()
    .replace(/[\s\-\.\(\)]/g, '');
  if (clean.startsWith('+84')) {
    clean = '0' + clean.slice(3);
  } else if (clean.startsWith('84') && clean.length === 11) {
    clean = '0' + clean.slice(2);
  }
  return clean;
}

/**
 * Kiểm tra xem một hồ sơ person có nằm trong phạm vi tòa nhà / hồ sơ tự tạo hợp lệ của người gọi hay không.
 * Dùng để chặn dò quét SĐT / CCCD / Email xuyên tòa nhà hoặc dò thông tin tài khoản nội bộ (OWNER / SYS_ADMIN / STAFF).
 */
export async function checkPersonScopeForActor(personId, { actorId, orgId, roleCodes } = {}) {
  if (!personId || !actorId || !orgId) return false;

  let roles = Array.isArray(roleCodes) ? roleCodes : null;
  if (!roles) {
    const roleRes = await adminPool.query(
      `SELECT r.code
       FROM user_role ur
       JOIN role r ON r.id = ur.role_id
       WHERE ur.user_id = $1`,
      [actorId]
    );
    roles = roleRes.rows.map((r) => r.code);
  }

  if (roles.includes('SYS_ADMIN')) {
    return true;
  }

  const buildingIdSet = new Set();
  if (roles.includes('OWNER')) {
    const ownIds = await getOwnerBuildingIds(actorId, orgId);
    ownIds.forEach((id) => buildingIdSet.add(id));
  }
  if (roles.includes('MANAGER')) {
    const mgrIds = await getManagerBuildingIds(actorId, orgId);
    mgrIds.forEach((id) => buildingIdSet.add(id));
  }
  const buildingIds = Array.from(buildingIdSet);
  const isManager = roles.includes('MANAGER');

  const scopeRes = await adminPool.query(
    `SELECT 1
     FROM person p
     WHERE p.id = $1
       AND p.org_id = $2
       AND (
         (
           CARDINALITY($3::uuid[]) > 0
           AND (
             EXISTS (
               SELECT 1 FROM contract c
               JOIN tenant t ON t.id = c.primary_tenant_id
               WHERE t.person_id = p.id AND c.building_id = ANY($3::uuid[])
             )
             OR EXISTS (
               SELECT 1 FROM contract c
               JOIN contract_occupant co ON co.contract_id = c.id
               JOIN tenant t ON t.id = co.tenant_id
               WHERE t.person_id = p.id AND c.building_id = ANY($3::uuid[])
             )
             OR (
               p.phone IS NOT NULL
               AND EXISTS (
                 SELECT 1 FROM reservation rsv
                 WHERE rsv.phone = p.phone AND rsv.building_id = ANY($3::uuid[])
               )
             )
             OR EXISTS (
               SELECT 1 FROM tenant td
               WHERE td.person_id = p.id AND td.desired_building_id = ANY($3::uuid[])
             )
           )
         )
         OR (
           $4::boolean = TRUE
           AND (
             p.created_by = $5::uuid
             OR EXISTS (SELECT 1 FROM tenant ts WHERE ts.person_id = p.id AND ts.created_by = $5::uuid)
           )
           AND NOT EXISTS (
             SELECT 1 FROM contract c_other
             JOIN tenant t_other ON t_other.id = c_other.primary_tenant_id
             WHERE t_other.person_id = p.id
               AND NOT (c_other.building_id = ANY($3::uuid[]))
           )
           AND NOT EXISTS (
             SELECT 1 FROM contract c_occ
             JOIN contract_occupant co_other ON co_other.contract_id = c_occ.id
             JOIN tenant t_occ ON t_occ.id = co_other.tenant_id
             WHERE t_occ.person_id = p.id
               AND NOT (c_occ.building_id = ANY($3::uuid[]))
           )
         )
       )
     LIMIT 1`,
    [personId, orgId, buildingIds, isManager, actorId]
  );

  return scopeRes.rows.length > 0;
}

/**
 * Kiểm tra xem person_id có thuộc tài khoản nhân sự nội bộ / chủ sở hữu tòa nhà
 * (SYS_ADMIN, OWNER, MANAGER hoặc bảng owner) hay không.
 * Dùng để ẩn hoàn toàn nhân sự nội bộ khỏi luồng tra cứu & liên kết khách thuê.
 */
export async function isInternalPerson(personId, orgId) {
  if (!personId || !orgId) return false;
  const res = await adminPool.query(
    `SELECT 1
     FROM person p
     WHERE p.id = $1
       AND p.org_id = $2
       AND (
         EXISTS (
           SELECT 1
           FROM app_user au
           JOIN user_role ur ON ur.user_id = au.id
           JOIN role r ON r.id = ur.role_id
           WHERE au.person_id = p.id
             AND r.code IN ('SYS_ADMIN', 'OWNER', 'MANAGER')
         )
         OR EXISTS (
           SELECT 1 FROM owner o WHERE o.person_id = p.id
         )
       )
     LIMIT 1`,
    [personId, orgId]
  );
  return res.rows.length > 0;
}

/**
 * Kiểm tra xem hồ sơ person có đang gắn với hợp đồng đang mở
 * (DRAFT, PENDING_APPROVAL, ACTIVE, RENEWAL_PENDING, TERMINATION_PENDING)
 * tại tòa nhà nằm ngoài phạm vi quản lý của MANAGER đang thao tác hay không.
 * Dùng để khóa bảo vệ định danh gốc (Điểm 2 — Shared Profile Lock).
 */
export async function hasContractOutsideManagerScope(personId, { actorId, orgId, roleCodes } = {}) {
  if (!personId || !orgId) return false;

  let roles = Array.isArray(roleCodes) ? roleCodes : null;
  if (!roles && actorId) {
    const roleRes = await adminPool.query(
      `SELECT r.code
       FROM user_role ur
       JOIN role r ON r.id = ur.role_id
       WHERE ur.user_id = $1`,
      [actorId]
    );
    roles = roleRes.rows.map((r) => r.code);
  }
  roles = roles || [];

  if (roles.includes('SYS_ADMIN')) {
    return false;
  }

  const mgrIds = actorId ? await getManagerBuildingIds(actorId, orgId) : [];

  const checkRes = await adminPool.query(
    `SELECT 1
     FROM contract c
     WHERE c.status IN ('DRAFT', 'PENDING_APPROVAL', 'ACTIVE', 'RENEWAL_PENDING', 'TERMINATION_PENDING')
       AND NOT (c.building_id = ANY($2::uuid[]))
       AND (
         EXISTS (
           SELECT 1 FROM tenant t
           WHERE t.id = c.primary_tenant_id AND t.person_id = $1
         )
         OR EXISTS (
           SELECT 1 FROM contract_occupant co
           JOIN tenant t2 ON t2.id = co.tenant_id
           WHERE co.contract_id = c.id AND t2.person_id = $1
         )
       )
     LIMIT 1`,
    [personId, mgrIds]
  );

  return checkRes.rows.length > 0;
}

/**
 * Khởi tạo hoặc tái sử dụng hồ sơ person + tenant bên trong transaction hiện hành (RLS client).
 * Nếu có CCCD/Hộ chiếu -> tenant.status = 'APPROVED'; thiếu CCCD -> 'PENDING'.
 */
export async function upsertPersonAndTenantInTx(
  client,
  {
    orgId,
    actorId,
    actorRoles,
    fullName,
    phone,
    email,
    dob,
    idNumber,
    address,
    nationality,
    type = 'primary',
  }
) {
  const cleanName = String(fullName || '').trim();
  const cleanPhone = normalizeVnPhone(phone);
  const cleanEmail = email ? String(email).trim().toLowerCase() : null;
  const cleanIdNumber = idNumber ? String(idNumber).trim() : null;
  const cleanAddress = address ? String(address).trim() : null;
  const cleanNationality = nationality ? String(nationality).trim() : 'Việt Nam';
  const cleanDob = dob || null;

  if (!cleanName || !cleanPhone) {
    const err = new Error('Họ tên và số điện thoại khách thuê là bắt buộc.');
    err.httpStatus = 400;
    err.code = 'VALIDATION_ERROR';
    throw err;
  }

  if (!/^0[0-9]{9}$/.test(cleanPhone)) {
    const err = new Error(
      'Số điện thoại khách thuê không hợp lệ. Vui lòng nhập số điện thoại 10 chữ số (ví dụ: 0912345678).'
    );
    err.httpStatus = 400;
    err.code = 'INVALID_PHONE';
    throw err;
  }

  if (cleanEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
    const err = new Error('Địa chỉ Email của khách thuê không hợp lệ.');
    err.httpStatus = 400;
    err.code = 'INVALID_EMAIL';
    throw err;
  }

  // Kiểm tra person hiện có theo SĐT (sử dụng adminPool để phát hiện trùng lặp chính xác trong org - FR-021)
  const existingByPhone = await adminPool.query(
    `SELECT p.*,
            (
              SELECT t.id FROM tenant t
              WHERE t.person_id = p.id AND t.org_id = p.org_id
                AND t.status NOT IN ('MERGED', 'REJECTED')
              ORDER BY CASE WHEN t.type = 'primary' THEN 0 ELSE 1 END, t.created_at DESC
              LIMIT 1
            ) AS tenant_id
     FROM person p
     WHERE p.org_id = $1 AND p.phone = $2
     LIMIT 1`,
    [orgId, cleanPhone]
  );
  const matchedPerson = existingByPhone.rows[0] || null;

  // PRD Mục 7.5 & FR-021 & Bảo mật PII liên tòa:
  // - Nếu thuộc tòa nhà khác hoặc tài khoản nội bộ -> chặn 409 nhưng TUYỆT ĐỐI không tiết lộ tên/CCCD/Email.
  // - Nếu thuộc phạm vi quản lý và ĐÃ CÓ hồ sơ tenant hoạt động -> trả bản ghi trùng đã che PII để chọn/gộp.
  // - Nếu thuộc phạm vi quản lý nhưng mới chỉ là person sơ bộ (VD: sinh tự động từ Phiếu giữ chỗ FR-067, chưa có tenant)
  //   -> nâng cấp trực tiếp person sơ bộ đó thành hồ sơ tenant chính thức!
  let upgradingPerson = null;
  if (matchedPerson) {
    const internal = await isInternalPerson(matchedPerson.id, orgId);
    const inScope =
      !internal &&
      (await checkPersonScopeForActor(matchedPerson.id, {
        actorId,
        orgId,
        roleCodes: actorRoles,
      }));
    if (!inScope) {
      const err = new Error(
        `Số điện thoại ${cleanPhone} đã được đăng ký trên hệ thống ngoài phạm vi tòa nhà bạn quản lý. Không thể tạo trùng hồ sơ định danh.`
      );
      err.httpStatus = 409;
      err.code = 'DUPLICATE_PHONE';
      err.existing_person = { in_scope: false, tenant_id: null };
      throw err;
    }

    if (matchedPerson.tenant_id) {
      const err = new Error(
        `Số điện thoại ${cleanPhone} đã tồn tại trong phạm vi tòa nhà của bạn (Hồ sơ: ${maskName(matchedPerson.full_name)}). Theo quy định FR-021, hệ thống chặn tạo mới bản ghi trùng — vui lòng chọn hồ sơ có sẵn hoặc sử dụng tính năng Gộp hồ sơ.`
      );
      err.httpStatus = 409;
      err.code = 'DUPLICATE_PHONE';
      err.existing_person = {
        id: matchedPerson.id,
        full_name: matchedPerson.full_name,
        masked_name: maskName(matchedPerson.full_name),
        phone: maskPhone(matchedPerson.phone),
        masked_phone: maskPhone(matchedPerson.phone),
        id_number: maskIdNumber(matchedPerson.id_number),
        masked_id_number: maskIdNumber(matchedPerson.id_number),
        tenant_id: matchedPerson.tenant_id || null,
        in_scope: true,
      };
      throw err;
    }

    upgradingPerson = matchedPerson;
  }

  const excludePersonId = upgradingPerson?.id || '00000000-0000-0000-0000-000000000000';

  // Kiểm tra trùng CCCD với người khác trong cùng tổ chức
  if (cleanIdNumber) {
    const dupIdRes = await adminPool.query(
      `SELECT p.id, p.full_name, p.phone, p.id_number,
              (
                SELECT t.id FROM tenant t
                WHERE t.person_id = p.id AND t.org_id = p.org_id
                  AND t.status NOT IN ('MERGED', 'REJECTED')
                ORDER BY CASE WHEN t.type = 'primary' THEN 0 ELSE 1 END, t.created_at DESC
                LIMIT 1
              ) AS tenant_id
       FROM person p
       WHERE p.org_id = $1 AND p.id_number = $2 AND p.id <> $3`,
      [orgId, cleanIdNumber, excludePersonId]
    );
    if (dupIdRes.rows.length > 0) {
      const dupRow = dupIdRes.rows[0];
      const inScope = await checkPersonScopeForActor(dupRow.id, {
        actorId,
        orgId,
        roleCodes: actorRoles,
      });
      if (!inScope) {
        const err = new Error(
          'Số CCCD/CMND này đã được đăng ký trên hệ thống ngoài phạm vi tòa nhà bạn quản lý. Không thể tạo trùng hồ sơ định danh.'
        );
        err.httpStatus = 409;
        err.code = 'DUPLICATE_ID_NUMBER';
        err.existing_person = { in_scope: false, tenant_id: null };
        throw err;
      }

      const err = new Error(
        `Số CCCD/CMND đã tồn tại trong phạm vi tòa nhà của bạn (Hồ sơ: ${maskName(dupRow.full_name)} - SĐT: ${maskPhone(dupRow.phone) || '—'}). Vui lòng chọn hồ sơ có sẵn hoặc gộp hồ sơ.`
      );
      err.httpStatus = 409;
      err.code = 'DUPLICATE_ID_NUMBER';
      err.existing_person = {
        id: dupRow.id,
        full_name: dupRow.full_name,
        masked_name: maskName(dupRow.full_name),
        phone: maskPhone(dupRow.phone),
        masked_phone: maskPhone(dupRow.phone),
        id_number: maskIdNumber(dupRow.id_number),
        masked_id_number: maskIdNumber(dupRow.id_number),
        tenant_id: dupRow.tenant_id || null,
        in_scope: true,
      };
      throw err;
    }
  }

  // Kiểm tra trùng Email với người khác trong cùng tổ chức
  if (cleanEmail) {
    const dupEmailRes = await adminPool.query(
      `SELECT id, full_name, phone, email FROM person
       WHERE org_id = $1 AND LOWER(email) = $2 AND id <> $3`,
      [orgId, cleanEmail, excludePersonId]
    );
    if (dupEmailRes.rows.length > 0) {
      const dupRow = dupEmailRes.rows[0];
      const inScope = await checkPersonScopeForActor(dupRow.id, {
        actorId,
        orgId,
        roleCodes: actorRoles,
      });
      if (!inScope) {
        const err = new Error(
          `Email ${cleanEmail} đã được sử dụng trên hệ thống ngoài phạm vi tòa nhà bạn quản lý.`
        );
        err.httpStatus = 409;
        err.code = 'DUPLICATE_EMAIL';
        err.existing_person = { in_scope: false, tenant_id: null };
        throw err;
      }

      const err = new Error(
        `Email ${cleanEmail} đã được gắn cho hồ sơ khác trong phạm vi quản lý (${maskName(dupRow.full_name)} - SĐT: ${maskPhone(dupRow.phone) || '—'}).`
      );
      err.httpStatus = 409;
      err.code = 'DUPLICATE_EMAIL';
      err.existing_person = {
        id: dupRow.id,
        full_name: dupRow.full_name,
        masked_name: maskName(dupRow.full_name),
        phone: maskPhone(dupRow.phone),
        email: maskEmail(dupRow.email),
        in_scope: true,
      };
      throw err;
    }
  }

  let personId;
  let effectiveIdNumber;
  if (upgradingPerson) {
    const upPersonRes = await client.query(
      `UPDATE person
       SET full_name = $1,
           email = COALESCE($2, email),
           dob = COALESCE($3, dob),
           id_number = COALESCE($4, id_number),
           address = COALESCE($5, address),
           nationality = COALESCE($6, nationality)
       WHERE id = $7
       RETURNING *`,
      [
        cleanName,
        cleanEmail,
        cleanDob,
        cleanIdNumber,
        cleanAddress,
        cleanNationality,
        upgradingPerson.id,
      ]
    );
    personId = upPersonRes.rows[0].id;
    effectiveIdNumber = upPersonRes.rows[0].id_number;
  } else {
    const newPersonRes = await client.query(
      `INSERT INTO person (org_id, full_name, phone, email, dob, id_number, address, nationality, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        orgId,
        cleanName,
        cleanPhone,
        cleanEmail,
        cleanDob,
        cleanIdNumber,
        cleanAddress,
        cleanNationality,
        actorId || null,
      ]
    );
    personId = newPersonRes.rows[0].id;
    effectiveIdNumber = cleanIdNumber;
  }

  // Kiểm tra xem đã có bản ghi tenant (chưa bị MERGED/REJECTED) cho person này chưa
  const existingTenantRes = await client.query(
    `SELECT * FROM tenant
     WHERE person_id = $1 AND org_id = $2 AND type = $3
       AND status NOT IN ('MERGED', 'REJECTED')
     ORDER BY created_at DESC
     LIMIT 1`,
    [personId, orgId, type]
  );

  let tenantRow;
  let isNewTenant = false;

  if (existingTenantRes.rows.length === 0) {
    const tenantStatus = effectiveIdNumber ? 'APPROVED' : 'PENDING';
    const insTenant = await client.query(
      `INSERT INTO tenant (person_id, org_id, type, status, created_by)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [personId, orgId, type, tenantStatus, actorId || null]
    );
    tenantRow = insTenant.rows[0];
    isNewTenant = true;

    await client.query(
      `INSERT INTO audit_log (actor_id, action, entity, entity_id, after)
       VALUES ($1, 'CREATE', 'tenant', $2, $3)`,
      [actorId, tenantRow.id, JSON.stringify(tenantRow)]
    );
  } else {
    tenantRow = existingTenantRes.rows[0];
    if (tenantRow.status === 'PENDING' && effectiveIdNumber) {
      const upTenant = await client.query(
        `UPDATE tenant SET status = 'APPROVED', updated_at = NOW() WHERE id = $1 RETURNING *`,
        [tenantRow.id]
      );
      tenantRow = upTenant.rows[0];
    }
  }

  return {
    personId,
    cleanPhone,
    cleanEmail,
    tenant: tenantRow,
    isNewTenant,
  };
}

/**
 * Đảm bảo cư dân đã được cấp tài khoản app_user (ACTIVE) + vai trò RESIDENT
 * để có thể đăng nhập ngay bằng SĐT + OTP (hoặc Email + Mật khẩu nếu có) trên Cổng cư dân.
 * Gọi SAU KHI transaction tạo person/tenant đã COMMIT.
 */
export async function ensureResidentAccount(personId, { email, phone, password } = {}) {
  if (!personId) return null;

  const cleanEmail = email ? String(email).trim().toLowerCase() : null;
  const cleanPhone = phone ? normalizeVnPhone(phone) : null;
  const passwordHash =
    password && String(password).length >= 8 ? await bcrypt.hash(String(password), 10) : null;

  const existingUserRes = await adminPool.query(
    'SELECT * FROM app_user WHERE person_id = $1 LIMIT 1',
    [personId]
  );

  let userId;
  if (existingUserRes.rows.length === 0) {
    let authUid = cleanEmail || (cleanPhone ? `user_${cleanPhone}` : `user_${personId.slice(0, 8)}`);
    const uidDup = await adminPool.query('SELECT 1 FROM app_user WHERE auth_uid = $1 LIMIT 1', [authUid]);
    if (uidDup.rows.length > 0) {
      authUid = `resident_${personId.replace(/-/g, '').slice(0, 12)}`;
    }

    const insUser = await adminPool.query(
      `INSERT INTO app_user (person_id, auth_uid, password_hash, status)
       VALUES ($1, $2, $3, 'ACTIVE')
       RETURNING id`,
      [personId, authUid, passwordHash]
    );
    userId = insUser.rows[0].id;
  } else {
    userId = existingUserRes.rows[0].id;
    if (passwordHash && !existingUserRes.rows[0].password_hash) {
      await adminPool.query(
        'UPDATE app_user SET password_hash = $1 WHERE id = $2',
        [passwordHash, userId]
      );
    }
  }

  const roleRes = await adminPool.query("SELECT id FROM role WHERE code = 'RESIDENT' LIMIT 1");
  if (roleRes.rows.length > 0) {
    const roleId = roleRes.rows[0].id;
    const hasRoleRes = await adminPool.query(
      'SELECT 1 FROM user_role WHERE user_id = $1 AND role_id = $2 LIMIT 1',
      [userId, roleId]
    );
    if (hasRoleRes.rows.length === 0) {
      await adminPool.query(
        'INSERT INTO user_role (user_id, role_id, building_id) VALUES ($1, $2, NULL)',
        [userId, roleId]
      );
    }
  }

  return userId;
}

