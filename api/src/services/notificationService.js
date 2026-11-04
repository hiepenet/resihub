import { adminPool } from '../db/client.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(val) {
  return typeof val === 'string' && UUID_RE.test(val.trim());
}

/**
 * Trả về mệnh đề SQL bổ sung để loại trừ các thông báo mẫu nội bộ (`user_id IS NULL` có `link` bắt đầu bằng `/admin`)
 * khỏi tài khoản chỉ mang vai trò `RESIDENT`.
 */
export function filterNotificationsSqlClause(roleCodes = []) {
  const normalized = Array.isArray(roleCodes)
    ? roleCodes.map((r) => String(r || '').toUpperCase()).filter(Boolean)
    : [];
  const hasAdminRole = normalized.some((r) => ['SYS_ADMIN', 'OWNER', 'MANAGER'].includes(r));
  if (hasAdminRole) return '';
  if (normalized.includes('RESIDENT') || normalized.length === 0) {
    return ` AND (user_id IS NOT NULL OR COALESCE(payload->>'link', '') NOT LIKE '/admin%')`;
  }
  return '';
}

function normalizePayloadObject(rawPayload) {
  let obj = {};
  if (rawPayload && typeof rawPayload === 'object' && !Array.isArray(rawPayload)) {
    obj = { ...rawPayload };
  } else if (typeof rawPayload === 'string') {
    try {
      const parsed = JSON.parse(rawPayload);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        obj = { ...parsed };
      }
    } catch {
      obj = {};
    }
  }
  if (typeof obj.link === 'string' && obj.link.startsWith('/admin/service-requests')) {
    obj.link = obj.link.replace(/^\/admin\/service-requests/, '/admin/maintenance');
  }
  return obj;
}

function setIfMissing(target, key, val) {
  if (val && (!target[key] || String(target[key]).trim() === '')) {
    target[key] = val;
  }
}

/**
 * Làm giàu theo lô các định danh điều hướng (`contract_id`, `invoice_id`, `building_id`, `apartment_id`)
 * cho danh sách thông báo đọc từ `GET /api/v1/notifications`.
 * Chỉ truy vấn các bảng thực sự có UUID cần bổ sung và luôn giới hạn theo `orgId`.
 */
export async function enrichNotificationsContext(
  rows,
  orgId,
  { queryFn = (sql, params) => adminPool.query(sql, params) } = {}
) {
  if (!Array.isArray(rows) || rows.length === 0) return [];

  const cloned = rows.map((row) => ({
    ...row,
    payload: normalizePayloadObject(row?.payload),
  }));

  if (!isUuid(orgId)) return cloned;

  const needPaymentIds = new Set();
  const needInvoiceIds = new Set();
  const needCreditIds = new Set();
  const needDepositIds = new Set();
  const needSrIds = new Set();
  const needSubIds = new Set();
  const needRsvIds = new Set();
  const needContractIds = new Set();
  const needReqIds = new Set();
  const needTenantIds = new Set();

  for (const row of cloned) {
    const p = row.payload;
    if (isUuid(p.payment_id) && (!p.invoice_id || !p.contract_id || !p.building_id || !p.apartment_id)) {
      needPaymentIds.add(p.payment_id.trim());
    }
    if (isUuid(p.invoice_id) && (!p.contract_id || !p.building_id || !p.apartment_id)) {
      needInvoiceIds.add(p.invoice_id.trim());
    }
    if (isUuid(p.credit_id) && (!p.contract_id || !p.building_id || !p.apartment_id)) {
      needCreditIds.add(p.credit_id.trim());
    }
    if (isUuid(p.deposit_id) && (!p.contract_id || !p.building_id || !p.apartment_id)) {
      needDepositIds.add(p.deposit_id.trim());
    }
    if (isUuid(p.service_request_id) && (!p.contract_id || !p.building_id || !p.apartment_id)) {
      needSrIds.add(p.service_request_id.trim());
    }
    if (isUuid(p.subscription_id) && (!p.contract_id || !p.building_id || !p.apartment_id)) {
      needSubIds.add(p.subscription_id.trim());
    }
    if (isUuid(p.reservation_id) && (!p.building_id || !p.apartment_id)) {
      needRsvIds.add(p.reservation_id.trim());
    }
    if (isUuid(p.contract_id) && (!p.building_id || !p.apartment_id)) {
      needContractIds.add(p.contract_id.trim());
    }
    if (isUuid(p.request_id) && (!p.contract_id || !p.building_id || !p.apartment_id)) {
      needReqIds.add(p.request_id.trim());
    }
    if (isUuid(p.tenant_id) && (!p.building_id && !p.desired_building_id)) {
      needTenantIds.add(p.tenant_id.trim());
    }
  }

  const tasks = [];
  const maps = {
    payment: new Map(),
    invoice: new Map(),
    credit: new Map(),
    deposit: new Map(),
    sr: new Map(),
    sub: new Map(),
    rsv: new Map(),
    contract: new Map(),
    req: new Map(),
    tenant: new Map(),
  };

  if (needPaymentIds.size > 0) {
    tasks.push(
      queryFn(
        `SELECT p.id, p.invoice_id, COALESCE(p.contract_id, i.contract_id) AS contract_id,
                COALESCE(p.building_id, i.building_id) AS building_id, i.apartment_id
         FROM payment p
         LEFT JOIN invoice i ON i.id = p.invoice_id
         WHERE p.org_id = $1 AND p.id = ANY($2::uuid[])`,
        [orgId, [...needPaymentIds]]
      ).then((r) => r.rows.forEach((x) => maps.payment.set(x.id, x)))
    );
  }

  if (needInvoiceIds.size > 0) {
    tasks.push(
      queryFn(
        `SELECT i.id, i.contract_id, i.building_id, i.apartment_id
         FROM invoice i
         WHERE i.org_id = $1 AND i.id = ANY($2::uuid[])`,
        [orgId, [...needInvoiceIds]]
      ).then((r) => r.rows.forEach((x) => maps.invoice.set(x.id, x)))
    );
  }

  if (needCreditIds.size > 0) {
    tasks.push(
      queryFn(
        `SELECT cb.id, cb.contract_id, COALESCE(cb.building_id, c.building_id) AS building_id, c.apartment_id
         FROM credit_balance cb
         LEFT JOIN contract c ON c.id = cb.contract_id
         WHERE cb.org_id = $1 AND cb.id = ANY($2::uuid[])`,
        [orgId, [...needCreditIds]]
      ).then((r) => r.rows.forEach((x) => maps.credit.set(x.id, x)))
    );
  }

  if (needDepositIds.size > 0) {
    tasks.push(
      queryFn(
        `SELECT d.id, d.contract_id, c.building_id, c.apartment_id
         FROM deposit d
         JOIN contract c ON c.id = d.contract_id
         JOIN building b ON b.id = c.building_id
         WHERE b.org_id = $1 AND d.id = ANY($2::uuid[])`,
        [orgId, [...needDepositIds]]
      ).then((r) => r.rows.forEach((x) => maps.deposit.set(x.id, x)))
    );
  }

  if (needSrIds.size > 0) {
    tasks.push(
      queryFn(
        `SELECT sr.id, sr.building_id, sr.apartment_id, lc.contract_id
         FROM service_request sr
         LEFT JOIN LATERAL (
           SELECT c.id AS contract_id
           FROM contract c
           WHERE c.apartment_id = sr.apartment_id
           ORDER BY (c.status = 'ACTIVE') DESC, c.created_at DESC
           LIMIT 1
         ) lc ON TRUE
         WHERE sr.org_id = $1 AND sr.id = ANY($2::uuid[])`,
        [orgId, [...needSrIds]]
      ).then((r) => r.rows.forEach((x) => maps.sr.set(x.id, x)))
    );
  }

  if (needSubIds.size > 0) {
    tasks.push(
      queryFn(
        `SELECT ss.id, ss.contract_id, ss.building_id, ss.apartment_id
         FROM service_subscription ss
         WHERE ss.org_id = $1 AND ss.id = ANY($2::uuid[])`,
        [orgId, [...needSubIds]]
      ).then((r) => r.rows.forEach((x) => maps.sub.set(x.id, x)))
    );
  }

  if (needRsvIds.size > 0) {
    tasks.push(
      queryFn(
        `SELECT r.id, r.building_id, r.apartment_id
         FROM reservation r
         WHERE r.org_id = $1 AND r.id = ANY($2::uuid[])`,
        [orgId, [...needRsvIds]]
      ).then((r) => r.rows.forEach((x) => maps.rsv.set(x.id, x)))
    );
  }

  if (needContractIds.size > 0) {
    tasks.push(
      queryFn(
        `SELECT c.id, c.building_id, c.apartment_id
         FROM contract c
         JOIN building b ON b.id = c.building_id
         WHERE b.org_id = $1 AND c.id = ANY($2::uuid[])`,
        [orgId, [...needContractIds]]
      ).then((r) => r.rows.forEach((x) => maps.contract.set(x.id, x)))
    );
  }

  if (needReqIds.size > 0) {
    tasks.push(
      queryFn(
        `SELECT cr.id, cr.contract_id, COALESCE(cr.building_id, c.building_id) AS building_id, c.apartment_id
         FROM contract_request cr
         LEFT JOIN contract c ON c.id = cr.contract_id
         WHERE cr.org_id = $1 AND cr.id = ANY($2::uuid[])`,
        [orgId, [...needReqIds]]
      ).then((r) => r.rows.forEach((x) => maps.req.set(x.id, x)))
    );
  }

  if (needTenantIds.size > 0) {
    tasks.push(
      queryFn(
        `SELECT t.id, t.desired_building_id AS building_id, t.desired_apartment_id AS apartment_id
         FROM tenant t
         WHERE t.org_id = $1 AND t.id = ANY($2::uuid[])`,
        [orgId, [...needTenantIds]]
      ).then((r) => r.rows.forEach((x) => maps.tenant.set(x.id, x)))
    );
  }

  if (tasks.length > 0) {
    await Promise.all(tasks);
  }

  for (const row of cloned) {
    const p = row.payload;
    const applyCtx = (ctx) => {
      if (!ctx) return;
      setIfMissing(p, 'invoice_id', ctx.invoice_id);
      setIfMissing(p, 'contract_id', ctx.contract_id);
      setIfMissing(p, 'building_id', ctx.building_id);
      setIfMissing(p, 'apartment_id', ctx.apartment_id);
    };

    if (isUuid(p.payment_id)) applyCtx(maps.payment.get(p.payment_id.trim()));
    if (isUuid(p.invoice_id)) applyCtx(maps.invoice.get(p.invoice_id.trim()));
    if (isUuid(p.credit_id)) applyCtx(maps.credit.get(p.credit_id.trim()));
    if (isUuid(p.deposit_id)) applyCtx(maps.deposit.get(p.deposit_id.trim()));
    if (isUuid(p.service_request_id)) applyCtx(maps.sr.get(p.service_request_id.trim()));
    if (isUuid(p.subscription_id)) applyCtx(maps.sub.get(p.subscription_id.trim()));
    if (isUuid(p.reservation_id)) applyCtx(maps.rsv.get(p.reservation_id.trim()));
    if (isUuid(p.contract_id)) applyCtx(maps.contract.get(p.contract_id.trim()));
    if (isUuid(p.request_id)) applyCtx(maps.req.get(p.request_id.trim()));
    if (isUuid(p.tenant_id)) applyCtx(maps.tenant.get(p.tenant_id.trim()));
    if (!p.building_id && isUuid(p.desired_building_id)) {
      p.building_id = p.desired_building_id;
    }
    if (!p.apartment_id && isUuid(p.desired_apartment_id)) {
      p.apartment_id = p.desired_apartment_id;
    }
  }

  return cloned;
}

/**
 * Gửi thông báo cho các MANAGER đang hoạt động của tòa nhà (fallback SYS_ADMIN toàn org nếu tòa chưa có MANAGER).
 */
export async function notifyBuildingManagers(
  orgId,
  buildingId,
  { title, content, type, payload = {} },
  { queryFn = (sql, params) => adminPool.query(sql, params) } = {}
) {
  if (!isUuid(orgId) || !title || !content || !type) return [];

  let recipients = [];
  if (isUuid(buildingId)) {
    const mgrRes = await queryFn(
      `SELECT DISTINCT ur.user_id
       FROM user_role ur
       JOIN role r ON r.id = ur.role_id
       JOIN app_user au ON au.id = ur.user_id
       JOIN person p ON p.id = au.person_id
       WHERE r.code = 'MANAGER'
         AND ur.building_id = $1
         AND p.org_id = $2
         AND au.status = 'ACTIVE'`,
      [buildingId, orgId]
    );
    recipients = mgrRes.rows.map((r) => r.user_id).filter(isUuid);
  }

  if (recipients.length === 0) {
    const admRes = await queryFn(
      `SELECT DISTINCT ur.user_id
       FROM user_role ur
       JOIN role r ON r.id = ur.role_id
       JOIN app_user au ON au.id = ur.user_id
       JOIN person p ON p.id = au.person_id
       WHERE r.code = 'SYS_ADMIN'
         AND p.org_id = $1
         AND au.status = 'ACTIVE'`,
      [orgId]
    );
    recipients = admRes.rows.map((r) => r.user_id).filter(isUuid);
  }

  const uniqueRecipients = [...new Set(recipients)];
  const serializedPayload = JSON.stringify(payload || {});
  for (const uid of uniqueRecipients) {
    await queryFn(
      `INSERT INTO notification (org_id, user_id, title, content, type, payload)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [orgId, uid, title, content, type, serializedPayload]
    );
  }
  return uniqueRecipients;
}

/**
 * Gửi thông báo cho cấp phê duyệt Four-Eyes của tòa nhà (ưu tiên OWNER của tòa/org, fallback MANAGER khác hoặc SYS_ADMIN).
 */
export async function notifyBuildingFourEyesApprovers(
  orgId,
  buildingId,
  excludeUserId,
  { title, content, type, payload = {} },
  { queryFn = (sql, params) => adminPool.query(sql, params) } = {}
) {
  if (!isUuid(orgId) || !title || !content || !type) return [];

  let recipients = [];
  if (isUuid(buildingId)) {
    const ownerRes = await queryFn(
      `SELECT DISTINCT ur.user_id
       FROM user_role ur
       JOIN role r ON r.id = ur.role_id
       JOIN app_user au ON au.id = ur.user_id
       JOIN person p ON p.id = au.person_id
       LEFT JOIN building b ON b.id = $1
       WHERE p.org_id = $2
         AND au.status = 'ACTIVE'
         AND r.code = 'OWNER'
         AND (ur.building_id = $1 OR ur.building_id IS NULL OR b.owner_id = ur.user_id)`,
      [buildingId, orgId]
    );
    recipients = ownerRes.rows
      .map((r) => r.user_id)
      .filter((uid) => isUuid(uid) && uid !== excludeUserId);
  }

  if (recipients.length === 0 && isUuid(buildingId)) {
    const peerMgrRes = await queryFn(
      `SELECT DISTINCT ur.user_id
       FROM user_role ur
       JOIN role r ON r.id = ur.role_id
       JOIN app_user au ON au.id = ur.user_id
       JOIN person p ON p.id = au.person_id
       WHERE p.org_id = $2
         AND au.status = 'ACTIVE'
         AND r.code = 'MANAGER'
         AND ur.building_id = $1`,
      [buildingId, orgId]
    );
    recipients = peerMgrRes.rows
      .map((r) => r.user_id)
      .filter((uid) => isUuid(uid) && uid !== excludeUserId);
  }

  if (recipients.length === 0) {
    const admRes = await queryFn(
      `SELECT DISTINCT ur.user_id
       FROM user_role ur
       JOIN role r ON r.id = ur.role_id
       JOIN app_user au ON au.id = ur.user_id
       JOIN person p ON p.id = au.person_id
       WHERE p.org_id = $1
         AND au.status = 'ACTIVE'
         AND r.code = 'SYS_ADMIN'`,
      [orgId]
    );
    recipients = admRes.rows
      .map((r) => r.user_id)
      .filter((uid) => isUuid(uid) && uid !== excludeUserId);
  }

  const uniqueRecipients = [...new Set(recipients)];
  const serializedPayload = JSON.stringify(payload || {});
  for (const uid of uniqueRecipients) {
    await queryFn(
      `INSERT INTO notification (org_id, user_id, title, content, type, payload)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [orgId, uid, title, content, type, serializedPayload]
    );
  }
  return uniqueRecipients;
}

/**
 * Gửi thông báo cá nhân cho 1 user cụ thể trong org.
 */
export async function notifyUser(
  orgId,
  userId,
  { title, content, type, payload = {} },
  { queryFn = (sql, params) => adminPool.query(sql, params) } = {}
) {
  if (!isUuid(orgId) || !isUuid(userId) || !title || !content || !type) return false;
  await queryFn(
    `INSERT INTO notification (org_id, user_id, title, content, type, payload)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [orgId, userId, title, content, type, JSON.stringify(payload || {})]
  );
  return true;
}
