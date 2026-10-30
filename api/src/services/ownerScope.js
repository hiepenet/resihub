import { adminPool } from '../db/client.js';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ZERO_UUID = '00000000-0000-0000-0000-000000000000';

/**
 * Trích xuất mảng mã vai trò từ req.user.roles
 */
export function getUserRoleCodes(req) {
  return (req?.user?.roles || []).map((r) => (typeof r === 'string' ? r : r.code));
}

/**
 * Lấy danh sách building_id mà OWNER sở hữu (qua owner.person_id).
 * Dùng chung cho tất cả routes cần scope OWNER theo building.
 *
 * @param {string} userId - app_user.id (req.user.sub)
 * @param {string} orgId  - org_id (req.user.org_id)
 * @returns {Promise<string[]>} Mảng building IDs
 */
export async function getOwnerBuildingIds(userId, orgId) {
  if (!userId || !orgId) return [];
  const result = await adminPool.query(
    `SELECT b.id
     FROM building b
     JOIN owner o ON o.id = b.owner_id
     JOIN person p ON p.id = o.person_id
     JOIN app_user au ON au.person_id = p.id
     WHERE au.id = $1 AND b.org_id = $2`,
    [userId, orgId]
  );
  return result.rows.map((r) => r.id);
}

/**
 * Lấy danh sách building_id được gán cho MANAGER (qua user_role.building_id).
 *
 * @param {string} userId - app_user.id (req.user.sub)
 * @param {string} orgId  - org_id (req.user.org_id)
 * @returns {Promise<string[]>} Mảng building IDs
 */
export async function getManagerBuildingIds(userId, orgId) {
  if (!userId || !orgId) return [];
  const result = await adminPool.query(
    `SELECT ur.building_id
     FROM user_role ur
     JOIN role r ON r.id = ur.role_id
     JOIN building b ON b.id = ur.building_id
     WHERE ur.user_id = $1
       AND r.code = 'MANAGER'
       AND b.org_id = $2
       AND ur.building_id IS NOT NULL`,
    [userId, orgId]
  );
  return result.rows.map((r) => r.building_id);
}

/**
 * Tạo SQL fragment để filter building cho OWNER.
 * Trả về { sql, params } sẵn sàng append vào query.
 */
export async function ownerBuildingFilter(buildingColumn, userId, orgId, existingParams) {
  const ids = await getOwnerBuildingIds(userId, orgId);
  if (ids.length === 0) {
    return { sql: ` AND FALSE`, params: existingParams };
  }
  existingParams.push(ids);
  return {
    sql: ` AND ${buildingColumn} = ANY($${existingParams.length}::uuid[])`,
    params: existingParams,
  };
}

/**
 * Tạo SQL fragment để filter building cho MANAGER.
 */
export async function managerBuildingFilter(buildingColumn, userId, orgId, existingParams) {
  const ids = await getManagerBuildingIds(userId, orgId);
  if (ids.length === 0) {
    return { sql: ` AND FALSE`, params: existingParams };
  }
  existingParams.push(ids);
  return {
    sql: ` AND ${buildingColumn} = ANY($${existingParams.length}::uuid[])`,
    params: existingParams,
  };
}

/**
 * Lấy danh sách building_id được gán cho ACCOUNTANT (qua user_role.building_id;
 * nếu ur.building_id IS NULL nghĩa là Kế toán toàn tổ chức -> trả toàn bộ tòa thuộc org).
 */
export async function getAccountantBuildingIds(userId, orgId) {
  if (!userId || !orgId) return [];
  const globalCheck = await adminPool.query(
    `SELECT 1
     FROM user_role ur
     JOIN role r ON r.id = ur.role_id
     WHERE ur.user_id = $1 AND r.code = 'ACCOUNTANT' AND ur.building_id IS NULL
     LIMIT 1`,
    [userId]
  );
  if (globalCheck.rows.length > 0) {
    const allBldgs = await adminPool.query(`SELECT id FROM building WHERE org_id = $1`, [orgId]);
    return allBldgs.rows.map((r) => r.id);
  }

  const result = await adminPool.query(
    `SELECT DISTINCT ur.building_id
     FROM user_role ur
     JOIN role r ON r.id = ur.role_id
     JOIN building b ON b.id = ur.building_id
     WHERE ur.user_id = $1
       AND r.code = 'ACCOUNTANT'
       AND b.org_id = $2
       AND ur.building_id IS NOT NULL`,
    [userId, orgId]
  );
  return result.rows.map((r) => r.building_id);
}

/**
 * Tạo SQL fragment để filter building cho ACCOUNTANT.
 */
export async function accountantBuildingFilter(buildingColumn, userId, orgId, existingParams) {
  const ids = await getAccountantBuildingIds(userId, orgId);
  if (ids.length === 0) {
    return { sql: ` AND FALSE`, params: existingParams };
  }
  existingParams.push(ids);
  return {
    sql: ` AND ${buildingColumn} = ANY($${existingParams.length}::uuid[])`,
    params: existingParams,
  };
}

/**
 * Lấy danh sách building_id được gán cho STAFF / ACCOUNTANT / MANAGER (qua user_role.building_id;
 * riêng ACCOUNTANT / STAFF nếu ur.building_id IS NULL -> toàn bộ tòa thuộc org).
 */
export async function getStaffBuildingIds(userId, orgId) {
  if (!userId || !orgId) return [];
  const globalCheck = await adminPool.query(
    `SELECT 1
     FROM user_role ur
     JOIN role r ON r.id = ur.role_id
     WHERE ur.user_id = $1
       AND r.code IN ('STAFF', 'ACCOUNTANT')
       AND ur.building_id IS NULL
     LIMIT 1`,
    [userId]
  );
  if (globalCheck.rows.length > 0) {
    const allBldgs = await adminPool.query(`SELECT id FROM building WHERE org_id = $1`, [orgId]);
    return allBldgs.rows.map((r) => r.id);
  }

  const result = await adminPool.query(
    `SELECT DISTINCT ur.building_id
     FROM user_role ur
     JOIN role r ON r.id = ur.role_id
     JOIN building b ON b.id = ur.building_id
     WHERE ur.user_id = $1
       AND r.code IN ('MANAGER', 'STAFF', 'ACCOUNTANT')
       AND b.org_id = $2
       AND ur.building_id IS NOT NULL`,
    [userId, orgId]
  );
  return result.rows.map((r) => r.building_id);
}

/**
 * Lấy danh sách building_id mà user (OWNER / MANAGER / STAFF / ACCOUNTANT) được phép truy cập.
 * Nếu là SYS_ADMIN trả null (nghĩa là toàn bộ org).
 */
export async function getAccessibleBuildingIds(req) {
  const roles = getUserRoleCodes(req);
  if (roles.includes('SYS_ADMIN')) return null;

  const userId = req.user?.sub;
  const orgId = req.user?.org_id;
  const idSet = new Set();

  if (roles.includes('OWNER')) {
    const ownIds = await getOwnerBuildingIds(userId, orgId);
    ownIds.forEach((id) => idSet.add(id));
  }
  if (roles.some((r) => ['MANAGER', 'STAFF', 'ACCOUNTANT'].includes(r))) {
    const staffIds = await getStaffBuildingIds(userId, orgId);
    staffIds.forEach((id) => idSet.add(id));
  }
  return Array.from(idSet);
}

/**
 * Tạo SQL fragment tự động theo vai trò (SYS_ADMIN / OWNER / MANAGER / STAFF / ACCOUNTANT).
 */
export async function scopedBuildingFilter(req, buildingColumn, existingParams) {
  const ids = await getAccessibleBuildingIds(req);
  if (ids === null) {
    return { sql: '', params: existingParams };
  }
  if (ids.length === 0) {
    return { sql: ' AND FALSE', params: existingParams };
  }
  existingParams.push(ids);
  return {
    sql: ` AND ${buildingColumn} = ANY($${existingParams.length}::uuid[])`,
    params: existingParams,
  };
}

/**
 * Kiểm tra quyền truy cập buildingId cụ thể, nếu không hợp lệ tự động logAccessDenied (AC-019.1).
 * Trả về true nếu hợp lệ, false nếu bị từ chối.
 */
export async function checkBuildingAccess(req, buildingId, entity = 'building', entityId = null) {
  if (!buildingId) return true;
  const ids = await getAccessibleBuildingIds(req);
  if (ids === null) return true;
  if (ids.includes(buildingId)) return true;
  await logAccessDenied(
    req,
    entity,
    entityId || buildingId,
    `User attempted unauthorized access to building ${buildingId}`
  );
  return false;
}

/**
 * Ghi sự kiện ACCESS_DENIED vào audit_log khi truy cập trái phép theo AC-019.1 & PRD 7.5.
 * Sử dụng adminPool để đảm bảo luôn ghi được ngay cả khi transaction bị ROLLBACK hoặc RLS chặn.
 */
export async function logAccessDenied(req, entity, entityId, reason) {
  try {
    const actorId = req?.user?.sub || req?.user?.id || null;
    const safeEntityId = entityId && UUID_REGEX.test(String(entityId)) ? String(entityId) : ZERO_UUID;
    const rawIp = req?.headers?.['x-forwarded-for']?.split(',')[0]?.trim() || req?.ip || null;
    const userAgent = req?.headers?.['user-agent'] || null;

    await adminPool.query(
      `INSERT INTO audit_log (actor_id, action, entity, entity_id, after, ip, user_agent)
       VALUES ($1, 'ACCESS_DENIED', $2, $3, $4, $5, $6)`,
      [
        actorId,
        entity || 'unknown',
        safeEntityId,
        JSON.stringify({
          reason: reason || 'Forbidden resource access',
          method: req?.method || null,
          path: req?.originalUrl || null,
          requested_entity_id: entityId || null,
          roles: getUserRoleCodes(req),
        }),
        rawIp,
        userAgent,
      ]
    );
  } catch (err) {
    console.warn('[Audit AccessDenied Warning]:', err.message);
  }
}
