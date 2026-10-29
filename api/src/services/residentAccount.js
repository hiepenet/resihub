import bcrypt from 'bcryptjs';
import { adminPool } from '../db/client.js';

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
 * Khởi tạo hoặc tái sử dụng hồ sơ person + tenant bên trong transaction hiện hành (RLS client).
 * Nếu có CCCD/Hộ chiếu -> tenant.status = 'APPROVED'; thiếu CCCD -> 'PENDING'.
 */
export async function upsertPersonAndTenantInTx(
  client,
  {
    orgId,
    actorId,
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

  // PRD Mục 7.5 & FR-021: Trùng cư dân (cùng SĐT/CCCD) -> Chặn tạo mới, hiển thị bản ghi trùng, cho phép hợp nhất có audit
  if (matchedPerson) {
    const err = new Error(
      `Số điện thoại ${cleanPhone} đã tồn tại trong hệ thống (Hồ sơ: ${matchedPerson.full_name}). Theo quy định FR-021, hệ thống chặn tạo mới bản ghi trùng — vui lòng chọn hồ sơ có sẵn hoặc sử dụng tính năng Gộp hồ sơ.`
    );
    err.httpStatus = 409;
    err.code = 'DUPLICATE_PHONE';
    err.existing_person = {
      id: matchedPerson.id,
      full_name: matchedPerson.full_name,
      phone: matchedPerson.phone,
      id_number: matchedPerson.id_number,
      tenant_id: matchedPerson.tenant_id || null,
    };
    throw err;
  }

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
       WHERE p.org_id = $1 AND p.id_number = $2`,
      [orgId, cleanIdNumber]
    );
    if (dupIdRes.rows.length > 0) {
      const err = new Error(
        `Số CCCD/CMND ${cleanIdNumber} đã tồn tại trong hệ thống (Hồ sơ: ${dupIdRes.rows[0].full_name} - SĐT: ${dupIdRes.rows[0].phone || '—'}). Vui lòng chọn hồ sơ có sẵn hoặc gộp hồ sơ.`
      );
      err.httpStatus = 409;
      err.code = 'DUPLICATE_ID_NUMBER';
      err.existing_person = dupIdRes.rows[0];
      throw err;
    }
  }

  // Kiểm tra trùng Email với người khác trong cùng tổ chức
  if (cleanEmail) {
    const dupEmailRes = await adminPool.query(
      `SELECT id, full_name, phone FROM person
       WHERE org_id = $1 AND LOWER(email) = $2`,
      [orgId, cleanEmail]
    );
    if (dupEmailRes.rows.length > 0) {
      const err = new Error(
        `Email ${cleanEmail} đã được gắn cho hồ sơ khác (${dupEmailRes.rows[0].full_name} - SĐT: ${dupEmailRes.rows[0].phone || '—'}).`
      );
      err.httpStatus = 409;
      err.code = 'DUPLICATE_EMAIL';
      err.existing_person = dupEmailRes.rows[0];
      throw err;
    }
  }

  const newPersonRes = await client.query(
    `INSERT INTO person (org_id, full_name, phone, email, dob, id_number, address, nationality)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
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
    ]
  );
  const personId = newPersonRes.rows[0].id;
  const effectiveIdNumber = cleanIdNumber;

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
      `INSERT INTO tenant (person_id, org_id, type, status)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [personId, orgId, type, tenantStatus]
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

