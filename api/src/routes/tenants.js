import express from 'express';
import { pool, adminPool, getUserClient } from '../db/client.js';
import { authenticateToken } from '../middleware/auth.js';
import { requireRole } from '../middleware/rbac.js';
import { saveBase64Image } from '../services/imageUpload.js';
import {
  getUserRoleCodes,
  getOwnerBuildingIds,
  getManagerBuildingIds,
  logAccessDenied,
} from '../services/ownerScope.js';
import {
  normalizeVnPhone,
  checkPersonScopeForActor,
  isInternalPerson,
  hasContractOutsideManagerScope,
  upsertPersonAndTenantInTx,
  ensureResidentAccount,
} from '../services/residentAccount.js';
import {
  checkLookupRateLimit,
  maskEmail,
  maskIdNumber,
  maskName,
  maskPhone,
} from '../utils/piiMask.js';

const router = express.Router();
const checkDupBuckets = new Map();
const tenantLookupBuckets = new Map();

/**
 * GET /api/v1/tenants/check-dup
 * Kiểm tra trùng SĐT hoặc CCCD (FR-021) — có Rate Limit, kiểm tra phạm vi tòa nhà và che PII
 */
router.get('/check-dup', authenticateToken, requireRole(['SYS_ADMIN', 'OWNER', 'MANAGER']), async (req, res) => {
  const { phone, id_number } = req.query;
  const orgId = req.user.org_id;

  const rl = checkLookupRateLimit(checkDupBuckets, String(req.user.sub), 30, 5 * 60 * 1000);
  if (!rl.allowed) {
    return res.status(429).json({
      code: 'TOO_MANY_REQUESTS',
      message: `Bạn đã kiểm tra quá nhiều lần. Vui lòng thử lại sau ${rl.retryAfterSec} giây.`,
    });
  }

  try {
    let sql = `
      SELECT p.id, p.full_name, p.phone, p.id_number, p.email,
             (
               SELECT t.id FROM tenant t
               WHERE t.person_id = p.id AND t.org_id = p.org_id
                 AND t.status NOT IN ('MERGED', 'REJECTED')
               ORDER BY CASE WHEN t.type = 'primary' THEN 0 ELSE 1 END, t.created_at DESC
               LIMIT 1
             ) AS tenant_id
      FROM person p
      WHERE p.org_id = $1 AND (`;
    const params = [orgId];
    const conditions = [];

    if (phone) {
      const cleanPhone = normalizeVnPhone(phone);
      if (/^0[0-9]{9}$/.test(cleanPhone)) {
        params.push(cleanPhone);
        conditions.push(`p.phone = $${params.length}`);
      }
    }
    if (id_number && String(id_number).trim().length >= 8) {
      params.push(String(id_number).trim());
      conditions.push(`p.id_number = $${params.length}`);
    }

    if (conditions.length === 0) {
      return res.json({ isDuplicate: false, inScope: true, duplicates: [] });
    }

    sql += conditions.join(' OR ') + ')';
    sql += `
      AND NOT (
        EXISTS (SELECT 1 FROM tenant tm WHERE tm.person_id = p.id AND tm.status = 'MERGED')
        AND NOT EXISTS (SELECT 1 FROM tenant ta WHERE ta.person_id = p.id AND ta.status <> 'MERGED')
      )`;
    const result = await adminPool.query(sql, params);

    if (result.rows.length === 0) {
      return res.json({ isDuplicate: false, inScope: true, duplicates: [] });
    }

    const roleCodes = getUserRoleCodes(req);
    const inScopeRows = [];
    let hasValidResidentDup = false;
    for (const row of result.rows) {
      const internal = await isInternalPerson(row.id, orgId);
      if (internal) {
        continue;
      }
      hasValidResidentDup = true;
      const allowed = await checkPersonScopeForActor(row.id, {
        actorId: req.user.sub,
        orgId,
        roleCodes,
      });
      if (allowed && row.tenant_id) {
        inScopeRows.push({
          id: row.id,
          full_name: row.full_name,
          masked_name: maskName(row.full_name),
          phone: maskPhone(row.phone),
          masked_phone: maskPhone(row.phone),
          id_number: maskIdNumber(row.id_number),
          masked_id_number: maskIdNumber(row.id_number),
          email: maskEmail(row.email),
          tenant_id: row.tenant_id,
        });
      }
    }

    if (inScopeRows.length === 0) {
      return res.json({
        isDuplicate: true,
        inScope: false,
        canLinkCrossBuilding: hasValidResidentDup,
        duplicates: [],
        message: hasValidResidentDup
          ? 'Định danh (SĐT/CCCD) này đã tồn tại trên hệ thống. Vui lòng chuyển sang tab "Tra cứu SĐT / CCCD" để xác minh và liên kết hồ sơ có sẵn thay vì tạo trùng.'
          : 'Định danh (SĐT/CCCD) này đã gắn với tài khoản nội bộ trên hệ thống, không thể tạo trùng.',
      });
    }

    res.json({
      isDuplicate: true,
      inScope: true,
      duplicates: inScopeRows,
    });
  } catch (err) {
    console.error('[Check Dup Error]:', err);
    res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi kiểm tra trùng lặp.' });
  }
});

/**
 * GET /api/v1/tenants/lookup?identifier=...
 * Tra cứu chính xác hồ sơ cư dân theo SĐT 10 số hoặc CCCD/Hộ chiếu (9-12 ký tự) khi lập hợp đồng:
 * - Không công khai dropdown toàn bộ cư dân.
 * - Giới hạn phạm vi quản lý của MANAGER + Rate Limit + Che PII (masking).
 */
router.get('/lookup', authenticateToken, requireRole(['SYS_ADMIN', 'MANAGER']), async (req, res) => {
  const raw = String(req.query.identifier || '').trim();
  if (!raw) {
    return res.status(400).json({
      code: 'MISSING_IDENTIFIER',
      message: 'Vui lòng nhập Số điện thoại (10 số) hoặc Số CCCD/Hộ chiếu của cư dân để tra cứu.',
    });
  }

  const rl = checkLookupRateLimit(tenantLookupBuckets, String(req.user.sub), 15, 5 * 60 * 1000);
  if (!rl.allowed) {
    return res.status(429).json({
      code: 'TOO_MANY_REQUESTS',
      message: `Bạn đã tra cứu quá nhiều lần. Vui lòng thử lại sau ${rl.retryAfterSec} giây.`,
    });
  }

  const normPhone = normalizeVnPhone(raw);
  const isPhone = /^0[0-9]{9}$/.test(normPhone);
  const cleanId = raw.replace(/\s+/g, '');
  const isIdNumber = !isPhone && /^[A-Za-z0-9]{9,12}$/.test(cleanId);

  if (!isPhone && !isIdNumber) {
    return res.status(422).json({
      code: 'INVALID_IDENTIFIER',
      message: 'Định dạng không hợp lệ. Vui lòng nhập đúng SĐT 10 chữ số (VD: 0912345678) hoặc Số CCCD/Hộ chiếu (9–12 ký tự).',
    });
  }

  try {
    const orgId = req.user.org_id;
    const matchCondition = isPhone ? 'p.phone = $2' : 'UPPER(p.id_number) = UPPER($2)';
    const matchValue = isPhone ? normPhone : cleanId;

    const personRes = await adminPool.query(
      `SELECT p.id, p.full_name, p.phone, p.email, p.id_number,
              t.id AS tenant_id, t.status AS tenant_status
       FROM person p
       LEFT JOIN LATERAL (
         SELECT t_sub.id, t_sub.status
         FROM tenant t_sub
         WHERE t_sub.person_id = p.id
           AND t_sub.org_id = p.org_id
           AND t_sub.status NOT IN ('MERGED', 'REJECTED')
         ORDER BY CASE WHEN t_sub.type = 'primary' THEN 0 ELSE 1 END, t_sub.created_at DESC
         LIMIT 1
       ) t ON TRUE
       WHERE p.org_id = $1
         AND ${matchCondition}
         AND NOT (
           EXISTS (SELECT 1 FROM tenant tm WHERE tm.person_id = p.id AND tm.status = 'MERGED')
           AND NOT EXISTS (SELECT 1 FROM tenant ta WHERE ta.person_id = p.id AND ta.status <> 'MERGED')
         )
       LIMIT 1`,
      [orgId, matchValue]
    );

    if (personRes.rows.length === 0) {
      return res.json({
        found: false,
        outOfScopeConflict: false,
        cross_building_link: false,
        tenant: null,
        data: null,
        normalizedPhone: isPhone ? normPhone : null,
        normalizedIdNumber: isIdNumber ? cleanId : null,
        message: 'Chưa tìm thấy hồ sơ cư dân khớp với SĐT / CCCD này. Bạn có thể chuyển sang tạo mới hồ sơ cư dân.',
      });
    }

    const row = personRes.rows[0];

    // Ẩn hoàn toàn nhân sự nội bộ & chủ đầu tư (SYS_ADMIN, OWNER, MANAGER, ACCOUNTANT, STAFF)
    const internal = await isInternalPerson(row.id, orgId);
    if (internal) {
      return res.json({
        found: false,
        outOfScopeConflict: false,
        cross_building_link: false,
        tenant: null,
        data: null,
        normalizedPhone: isPhone ? normPhone : null,
        normalizedIdNumber: isIdNumber ? cleanId : null,
        message: 'Chưa tìm thấy hồ sơ cư dân khớp với SĐT / CCCD này. Bạn có thể chuyển sang tạo mới hồ sơ cư dân.',
      });
    }

    let tenantId = row.tenant_id;
    let tenantStatus = row.tenant_status;

    // Nếu person cư dân đã tồn tại (VD: tự đăng ký tài khoản Cổng cư dân) nhưng chưa có dòng tenant primary
    if (!tenantId) {
      const initStatus = row.id_number ? 'APPROVED' : 'PENDING';
      const createdTenantRes = await adminPool.query(
        `INSERT INTO tenant (person_id, org_id, type, status, created_by)
         VALUES ($1, $2, 'primary', $3, $4)
         RETURNING id, status`,
        [row.id, orgId, initStatus, req.user.sub]
      );
      tenantId = createdTenantRes.rows[0].id;
      tenantStatus = createdTenantRes.rows[0].status;
    }

    const inScope = await checkPersonScopeForActor(row.id, {
      actorId: req.user.sub,
      orgId,
      roleCodes: getUserRoleCodes(req),
    });

    if (!inScope) {
      await adminPool.query(
        `INSERT INTO audit_log (actor_id, action, entity, entity_id, after)
         VALUES ($1, 'LOOKUP_TENANT_CROSS_SCOPE', 'tenant', $2, $3)`,
        [
          req.user.sub,
          tenantId,
          JSON.stringify({
            by: isPhone ? 'phone' : 'id_number',
            cross_building_link: true,
          }),
        ]
      );
    }

    const tenantPreview = {
      id: tenantId,
      person_id: row.id,
      ...(inScope ? { full_name: row.full_name } : {}),
      masked_name: maskName(row.full_name),
      masked_phone: maskPhone(row.phone),
      masked_email: maskEmail(row.email),
      masked_id_number: maskIdNumber(row.id_number),
      has_id_number: Boolean(row.id_number),
      status: tenantStatus,
      cross_building_link: !inScope,
    };

    return res.json({
      found: true,
      outOfScopeConflict: false,
      cross_building_link: !inScope,
      tenant: tenantPreview,
      data: tenantPreview,
      message: inScope
        ? 'Đã tìm thấy hồ sơ cư dân hợp lệ.'
        : 'Đã xác minh hồ sơ khách thuê trên hệ thống (đã che PII bảo mật). Bạn có thể liên kết để lập hợp đồng cho tòa nhà của mình.',
    });
  } catch (err) {
    console.error('[Tenant Lookup Error]:', err);
    res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi máy chủ khi tra cứu hồ sơ cư dân.' });
  }
});

/**
 * GET /api/v1/tenants
 * Quyền theo PRD 6.2: SYS_ADMIN (CRUD), OWNER (R trên tòa sở hữu), MANAGER (CRU trên tòa quản lý)
 */
router.get('/', authenticateToken, requireRole(['SYS_ADMIN', 'OWNER', 'MANAGER']), async (req, res) => {
  try {
    const orgId = req.user.org_id;
    const userRoles = getUserRoleCodes(req);
    const isSysAdmin = userRoles.includes('SYS_ADMIN');
    const isOwner = userRoles.includes('OWNER');
    const isManager = userRoles.includes('MANAGER');

    let sql = `
      SELECT t.*, p.full_name, p.phone, p.email, p.dob, p.id_number, p.address, p.nationality, p.avatar_url,
             (
               SELECT json_build_object(
                 'contract_id', c.id,
                 'apartment_id', a.id,
                 'apartment_code', a.code,
                 'building_id', b.id,
                 'building_name', b.name,
                 'rent_amount', c.rent_amount,
                 'end_date', c.end_date,
                 'status', c.status
               )
               FROM contract c
               JOIN apartment a ON a.id = c.apartment_id
               JOIN building b ON b.id = c.building_id
               WHERE c.primary_tenant_id = t.id AND c.status IN ('ACTIVE', 'RENEWAL_PENDING', 'TERMINATION_PENDING')
               ORDER BY c.created_at DESC LIMIT 1
             ) AS active_contract
      FROM tenant t
      JOIN person p ON p.id = t.person_id
      WHERE t.org_id = $1
    `;
    const params = [orgId];

    if (isSysAdmin) {
      // SYS_ADMIN: Toàn bộ cư dân trong tổ chức
    } else if (isOwner) {
      const ownedBuildingIds = await getOwnerBuildingIds(req.user.sub, orgId);
      if (ownedBuildingIds.length === 0) {
        return res.json({ data: [] });
      }
      params.push(ownedBuildingIds);
      sql += ` AND (
        t.id IN (
          SELECT c.primary_tenant_id FROM contract c
          WHERE c.building_id = ANY($${params.length}::uuid[])
        )
        OR t.id IN (
          SELECT co.tenant_id FROM contract_occupant co
          JOIN contract c ON c.id = co.contract_id
          WHERE c.building_id = ANY($${params.length}::uuid[])
        )
        OR t.id IN (
          SELECT t2.id FROM tenant t2
          JOIN person p2 ON p2.id = t2.person_id
          JOIN reservation r ON r.phone = p2.phone
          WHERE r.building_id = ANY($${params.length}::uuid[])
        )
      )`;
    } else if (isManager) {
      const mgrBuildingIds = await getManagerBuildingIds(req.user.sub, orgId);
      if (mgrBuildingIds.length === 0) {
        return res.json({ data: [] });
      }
      params.push(mgrBuildingIds);
      const idx = params.length;
      params.push(req.user.sub);
      const actorIdx = params.length;
      sql += ` AND (
        t.id IN (
          SELECT c.primary_tenant_id FROM contract c
          WHERE c.building_id = ANY($${idx}::uuid[])
        )
        OR t.id IN (
          SELECT co.tenant_id FROM contract_occupant co
          JOIN contract c ON c.id = co.contract_id
          WHERE c.building_id = ANY($${idx}::uuid[])
        )
        OR t.id IN (
          SELECT t2.id FROM tenant t2
          JOIN person p2 ON p2.id = t2.person_id
          JOIN reservation r ON r.phone = p2.phone
          WHERE r.building_id = ANY($${idx}::uuid[])
        )
        OR (
          -- Hồ sơ cư dân chưa lên hợp đồng: CHỈ hiển thị hồ sơ do chính MANAGER này khởi tạo (không lộ sang tòa khác)
          (t.created_by = $${actorIdx}::uuid OR p.created_by = $${actorIdx}::uuid)
          AND NOT EXISTS (
            SELECT 1 FROM contract c_other
            WHERE c_other.primary_tenant_id = t.id
              AND NOT (c_other.building_id = ANY($${idx}::uuid[]))
          )
          AND NOT EXISTS (
            SELECT 1 FROM contract_occupant co_other
            JOIN contract c_occ ON c_occ.id = co_other.contract_id
            WHERE co_other.tenant_id = t.id
              AND NOT (c_occ.building_id = ANY($${idx}::uuid[]))
          )
        )
      )`;
    }

    sql += ` ORDER BY t.created_at DESC`;

    const result = await pool.query(sql, params);
    let rows = result.rows;

    if (!isSysAdmin && isManager && rows.length > 0) {
      const mgrBuildingIds = await getManagerBuildingIds(req.user.sub, orgId);
      const personIds = Array.from(new Set(rows.map((r) => r.person_id).filter(Boolean)));
      if (personIds.length > 0) {
        const sharedRes = await adminPool.query(
          `SELECT DISTINCT t_all.person_id
           FROM tenant t_all
           WHERE t_all.person_id = ANY($1::uuid[])
             AND (
               EXISTS (
                 SELECT 1 FROM contract c
                 WHERE c.primary_tenant_id = t_all.id
                   AND c.status IN ('DRAFT', 'PENDING_APPROVAL', 'ACTIVE', 'RENEWAL_PENDING', 'TERMINATION_PENDING')
                   AND NOT (c.building_id = ANY($2::uuid[]))
               )
               OR EXISTS (
                 SELECT 1 FROM contract_occupant co
                 JOIN contract c ON c.id = co.contract_id
                 WHERE co.tenant_id = t_all.id
                   AND c.status IN ('DRAFT', 'PENDING_APPROVAL', 'ACTIVE', 'RENEWAL_PENDING', 'TERMINATION_PENDING')
                   AND NOT (c.building_id = ANY($2::uuid[]))
               )
             )`,
          [personIds, mgrBuildingIds]
        );
        const sharedSet = new Set(sharedRes.rows.map((r) => r.person_id));
        rows = rows.map((r) => ({ ...r, is_shared_profile: sharedSet.has(r.person_id) }));
      }
    } else {
      rows = rows.map((r) => ({ ...r, is_shared_profile: false }));
    }

    res.json({ data: rows });
  } catch (err) {
    console.error('[Tenants Error]:', err);
    res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi lấy danh sách cư dân.' });
  }
});

/**
 * POST /api/v1/tenants
 * Quyền theo PRD 6.2: SYS_ADMIN hoặc MANAGER (CRU). OWNER chỉ có R.
 * Tự động chuẩn hóa SĐT và cấp tài khoản app_user (ACTIVE) + role RESIDENT.
 */
router.post('/', authenticateToken, requireRole(['SYS_ADMIN', 'MANAGER']), async (req, res) => {
  const { full_name, phone, email, dob, id_number, address, nationality, type, password } = req.body;
  const orgId = req.user.org_id;

  if (!full_name || !phone) {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Họ tên và số điện thoại là bắt buộc.' });
  }
  if (password && String(password).length < 8) {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Mật khẩu đăng nhập ban đầu phải từ 8 ký tự trở lên.' });
  }

  const { client, release } = await getUserClient(req);
  try {
    await client.query('BEGIN');

    const { personId, cleanPhone, cleanEmail, tenant } = await upsertPersonAndTenantInTx(client, {
      orgId,
      actorId: req.user.sub,
      actorRoles: getUserRoleCodes(req),
      fullName: full_name,
      phone,
      email,
      dob,
      idNumber: id_number,
      address,
      nationality,
      type: type || 'primary',
    });

    await client.query('COMMIT');

    // Khởi tạo tự động tài khoản Cổng cư dân (app_user + RESIDENT role) sau khi person đã COMMIT
    try {
      await ensureResidentAccount(personId, {
        email: cleanEmail,
        phone: cleanPhone,
        password,
      });
    } catch (acctErr) {
      console.error('[Ensure Resident Account Warning]:', acctErr);
    }

    res.status(201).json({
      message: tenant.status === 'PENDING'
        ? 'Tạo hồ sơ cư dân & cấp tài khoản Cổng cư dân thành công. Hồ sơ đang chờ bổ sung CCCD/hộ chiếu.'
        : 'Tạo hồ sơ cư dân & cấp tài khoản Cổng cư dân thành công.',
      data: tenant,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.httpStatus) {
      return res.status(err.httpStatus).json({
        code: err.code || 'VALIDATION_ERROR',
        message: err.message,
        ...(err.existing_person ? { existing_person: err.existing_person } : {}),
      });
    }
    console.error('[Create Tenant Error]:', err);
    if (err.code === '23505') {
      return res.status(409).json({
        code: 'DUPLICATE_DATA',
        message: 'Dữ liệu bị trùng lặp (Số CCCD, Email hoặc SĐT đã tồn tại trong hệ thống).',
      });
    }
    res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi máy chủ khi tạo hồ sơ cư dân.' });
  } finally {
    await release();
  }
});

/**
 * POST /api/v1/tenants/merge
 * Gộp 2 hồ sơ cư dân bị trùng lặp (FR-021 / P0)
 * Quyền theo PRD 6.2: SYS_ADMIN hoặc MANAGER (CRU). OWNER chỉ có quyền R.
 */
router.post('/merge', authenticateToken, requireRole(['SYS_ADMIN', 'MANAGER']), async (req, res) => {
  const { source_tenant_id, target_tenant_id, reason } = req.body;
  const orgId = req.user.org_id;
  const cleanReason = reason ? String(reason).trim() : '';

  if (!source_tenant_id || !target_tenant_id) {
    return res.status(400).json({
      code: 'VALIDATION_ERROR',
      message: 'Vui lòng cung cấp cả hồ sơ cần gộp (source) và hồ sơ đích (target).',
    });
  }

  if (source_tenant_id === target_tenant_id) {
    return res.status(400).json({
      code: 'INVALID_MERGE',
      message: 'Hồ sơ cần gộp và hồ sơ đích không được trùng nhau.',
    });
  }

  // PRD 14.3 & FR-021: Hợp nhất bản ghi trùng bắt buộc kèm lý do + audit log
  if (!cleanReason) {
    return res.status(400).json({
      code: 'REASON_REQUIRED',
      message: 'Vui lòng nhập lý do gộp hồ sơ để lưu vết kiểm toán (FR-021).',
    });
  }

  const userRoles = getUserRoleCodes(req);
  const isSysAdmin = userRoles.includes('SYS_ADMIN');
  const client = await adminPool.connect();

  try {
    await client.query('BEGIN');

    const sourceRes = await client.query(
      `SELECT t.*, p.full_name, p.phone, p.email, p.dob, p.id_number, p.address, p.id_images, p.id AS person_id
       FROM tenant t JOIN person p ON p.id = t.person_id
       WHERE t.id = $1 AND t.org_id = $2
       FOR UPDATE OF t, p`,
      [source_tenant_id, orgId]
    );
    const targetRes = await client.query(
      `SELECT t.*, p.full_name, p.phone, p.email, p.dob, p.id_number, p.address, p.id_images, p.id AS person_id
       FROM tenant t JOIN person p ON p.id = t.person_id
       WHERE t.id = $1 AND t.org_id = $2
       FOR UPDATE OF t, p`,
      [target_tenant_id, orgId]
    );

    if (sourceRes.rows.length === 0 || targetRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({
        code: 'NOT_FOUND',
        message: 'Không tìm thấy hồ sơ cư dân cần gộp hoặc hồ sơ đích.',
      });
    }

    const sourceTenant = sourceRes.rows[0];
    const targetTenant = targetRes.rows[0];

    if (sourceTenant.status === 'MERGED' || targetTenant.status === 'MERGED') {
      await client.query('ROLLBACK');
      return res.status(409).json({
        code: 'ALREADY_MERGED',
        message: 'Một trong hai hồ sơ đã được gộp trước đó.',
      });
    }

    // Kiểm tra phạm vi tòa nhà cho MANAGER (không được gộp cư dân thuộc tòa nhà ngoài phạm vi hoặc do BQL tòa khác khởi tạo)
    if (!isSysAdmin) {
      const sourceInScope = await checkPersonScopeForActor(sourceTenant.person_id, {
        actorId: req.user.sub,
        orgId,
        roleCodes: userRoles,
      });
      const targetInScope = await checkPersonScopeForActor(targetTenant.person_id, {
        actorId: req.user.sub,
        orgId,
        roleCodes: userRoles,
      });
      if (!sourceInScope || !targetInScope) {
        await client.query('ROLLBACK');
        await logAccessDenied(req, 'tenant', source_tenant_id, 'MANAGER attempted to merge tenant outside building scope');
        return res.status(403).json({
          code: 'ACCESS_DENIED',
          message: 'Hồ sơ cư dân thuộc tòa nhà ngoài phạm vi quản lý của bạn.',
        });
      }

      const sourceShared = await hasContractOutsideManagerScope(sourceTenant.person_id, {
        actorId: req.user.sub,
        orgId,
        roleCodes: userRoles,
      });
      if (sourceShared) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          code: 'SHARED_PROFILE_LOCKED',
          message: 'Không thể gộp hồ sơ nguồn đang gắn với hợp đồng hiệu lực khác trong hệ thống. Vui lòng liên hệ SYS_ADMIN.',
        });
      }
    }

    // 1. Chuyển toàn bộ liên kết nghiệp vụ (contract, occupant, invoice, payment, receivable) sang target_tenant_id
    await client.query(
      `UPDATE contract SET primary_tenant_id = $1, updated_at = NOW() WHERE primary_tenant_id = $2`,
      [target_tenant_id, source_tenant_id]
    );

    await client.query(
      `UPDATE contract_occupant SET tenant_id = $1 WHERE tenant_id = $2
       AND NOT EXISTS (
         SELECT 1 FROM contract_occupant co2 WHERE co2.contract_id = contract_occupant.contract_id AND co2.tenant_id = $1
       )`,
      [target_tenant_id, source_tenant_id]
    );
    await client.query(`DELETE FROM contract_occupant WHERE tenant_id = $1`, [source_tenant_id]);

    await client.query(
      `UPDATE invoice SET tenant_id = $1, updated_at = NOW() WHERE tenant_id = $2`,
      [target_tenant_id, source_tenant_id]
    );
    await client.query(
      `UPDATE payment SET tenant_id = $1 WHERE tenant_id = $2`,
      [target_tenant_id, source_tenant_id]
    );
    await client.query(
      `UPDATE receivable SET tenant_id = $1, updated_at = NOW() WHERE tenant_id = $2`,
      [target_tenant_id, source_tenant_id]
    );

    // 2. Xử lý giải phóng unique constraints trên person nguồn TRƯỚC KHI chuyển CCCD/Email sang person đích
    if (sourceTenant.person_id !== targetTenant.person_id) {
      const otherTenantsRes = await client.query(
        `SELECT COUNT(*)::int AS cnt FROM tenant WHERE person_id = $1 AND id <> $2 AND status <> 'MERGED'`,
        [sourceTenant.person_id, source_tenant_id]
      );
      const hasOtherActiveTenants = (otherTenantsRes.rows[0]?.cnt || 0) > 0;

      if (!hasOtherActiveTenants) {
        await client.query(
          `UPDATE person
           SET phone = NULL,
               id_number = NULL,
               email = NULL,
               full_name = CASE WHEN full_name LIKE '[ĐÃ GỘP]%' THEN full_name ELSE '[ĐÃ GỘP] ' || full_name END,
               updated_at = NOW()
           WHERE id = $1`,
          [sourceTenant.person_id]
        );
      }

      await client.query(
        `UPDATE attachment SET owner_id = $1 WHERE owner_entity = 'person' AND owner_id = $2`,
        [targetTenant.person_id, sourceTenant.person_id]
      );

      await client.query(
        `UPDATE person
         SET id_number = COALESCE(NULLIF(id_number, ''), $1),
             email = COALESCE(NULLIF(email, ''), $2),
             dob = COALESCE(dob, $3),
             address = COALESCE(NULLIF(address, ''), $4),
             updated_at = NOW()
         WHERE id = $5`,
        [
          hasOtherActiveTenants ? null : sourceTenant.id_number || null,
          hasOtherActiveTenants ? null : sourceTenant.email || null,
          sourceTenant.dob || null,
          sourceTenant.address || null,
          targetTenant.person_id,
        ]
      );
    }

    const effectiveTargetIdNumber = targetTenant.id_number || sourceTenant.id_number || null;
    if (effectiveTargetIdNumber && targetTenant.status === 'PENDING') {
      await client.query(
        `UPDATE tenant SET status = 'APPROVED', updated_at = NOW() WHERE id = $1`,
        [target_tenant_id]
      );
    }

    // 3. Đánh dấu hồ sơ nguồn MERGED & ghi Audit Log bất biến (NFR-016)
    await client.query(
      `UPDATE tenant SET status = 'MERGED', updated_at = NOW() WHERE id = $1`,
      [source_tenant_id]
    );

    await client.query(
      `INSERT INTO audit_log (actor_id, action, entity, entity_id, before, after)
       VALUES ($1, 'MERGE_TENANT', 'tenant', $2, $3, $4)`,
      [
        req.user.sub,
        target_tenant_id,
        JSON.stringify({ source: sourceTenant, target_before: targetTenant }),
        JSON.stringify({
          merged_tenant_id: target_tenant_id,
          source_tenant_id,
          reason: cleanReason,
        }),
      ]
    );

    await client.query('COMMIT');
    res.json({
      message: `Đã gộp thành công hồ sơ của ${sourceTenant.full_name} vào hồ sơ ${targetTenant.full_name}.`,
      data: {
        merged_tenant_id: target_tenant_id,
        source_tenant_id,
      },
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[Merge Tenant Error]:', err);
    res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi máy chủ khi gộp hồ sơ cư dân.' });
  } finally {
    client.release();
  }
});

/**
 * GET /api/v1/tenants/:id — Chi tiết hồ sơ cư dân kèm lịch sử hợp đồng & thành viên cùng ở
 */
router.get('/:id', authenticateToken, requireRole(['SYS_ADMIN', 'OWNER', 'MANAGER']), async (req, res) => {
  const { id } = req.params;
  try {
    const tRes = await pool.query(
      `SELECT t.*, p.full_name, p.phone, p.email, p.dob, p.id_number, p.address, p.nationality, p.avatar_url
       FROM tenant t
       JOIN person p ON p.id = t.person_id
       WHERE t.id = $1 AND t.org_id = $2`,
      [id, req.user.org_id]
    );
    if (tRes.rows.length === 0) {
      return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy hồ sơ cư dân.' });
    }
    const tenant = tRes.rows[0];

    const contractsRes = await pool.query(
      `SELECT c.*, a.code as apartment_code, b.name as building_name
       FROM contract c
       JOIN apartment a ON a.id = c.apartment_id
       JOIN building b ON b.id = c.building_id
       WHERE c.primary_tenant_id = $1
       ORDER BY c.start_date DESC`,
      [id]
    );

    const activeContractId = contractsRes.rows.find((c) => c.status === 'ACTIVE')?.id || contractsRes.rows[0]?.id;
    let occupants = [];
    if (activeContractId) {
      const occRes = await pool.query(
        `SELECT co.relationship, t.id as tenant_id, p.full_name, p.phone, p.id_number
         FROM contract_occupant co
         JOIN tenant t ON t.id = co.tenant_id
         JOIN person p ON p.id = t.person_id
         WHERE co.contract_id = $1`,
        [activeContractId]
      );
      occupants = occRes.rows;
    }

    const isSharedProfile = await hasContractOutsideManagerScope(tenant.person_id, {
      actorId: req.user.sub,
      orgId: req.user.org_id,
      roleCodes: getUserRoleCodes(req),
    });

    res.json({
      data: {
        ...tenant,
        is_shared_profile: isSharedProfile,
        contracts: contractsRes.rows,
        occupants,
      },
    });
  } catch (err) {
    console.error('[Get Tenant Detail Error]:', err);
    res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi khi tải chi tiết cư dân.' });
  }
});

/**
 * PATCH /api/v1/tenants/:id — sửa hồ sơ + duyệt cư dân (A8, FR-021 & Điểm 2 Shared Profile Lock)
 */
router.patch('/:id', authenticateToken, requireRole(['SYS_ADMIN', 'MANAGER']), async (req, res) => {
  const { id } = req.params;
  const { full_name, phone, email, dob, id_number, address, nationality, action } = req.body;
  const orgId = req.user.org_id;
  const userRoles = getUserRoleCodes(req);
  const isSysAdmin = userRoles.includes('SYS_ADMIN');

  const { client, release } = await getUserClient(req);
  try {
    await client.query('BEGIN');

    const tenantRes = await client.query(
      `SELECT t.*, p.full_name, p.phone, p.email, p.dob, p.id_number, p.address, p.nationality
       FROM tenant t JOIN person p ON p.id = t.person_id
       WHERE t.id = $1 AND t.org_id = $2`,
      [id, orgId]
    );
    if (tenantRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy cư dân.' });
    }
    const tenant = tenantRes.rows[0];

    const isSharedProfile = !isSysAdmin
      ? await hasContractOutsideManagerScope(tenant.person_id, {
          actorId: req.user.sub,
          orgId,
          roleCodes: userRoles,
        })
      : false;

    if (action === 'approve' || action === 'reject') {
      if (tenant.status !== 'PENDING') {
        await client.query('ROLLBACK');
        return res.status(409).json({
          code: 'INVALID_STATUS',
          message: `Hồ sơ đang ở trạng thái ${tenant.status}, chỉ hồ sơ PENDING mới được duyệt/từ chối.`,
        });
      }
      if (action === 'reject' && isSharedProfile) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          code: 'SHARED_PROFILE_LOCKED',
          message: 'Hồ sơ định danh này đang gắn với hợp đồng hiệu lực khác trong hệ thống, không thể từ chối hồ sơ dùng chung.',
        });
      }
      const nextStatus = action === 'approve' ? 'APPROVED' : 'REJECTED';
      const incomingIdNum = id_number !== undefined && id_number !== null ? String(id_number).trim() : null;
      if (
        isSharedProfile &&
        tenant.id_number &&
        incomingIdNum &&
        incomingIdNum !== String(tenant.id_number).trim()
      ) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          code: 'SHARED_PROFILE_LOCKED',
          message: 'Hồ sơ định danh này đang gắn với hợp đồng hiệu lực khác trong hệ thống. Chỉ Cư dân (trên Cổng cư dân) hoặc SYS_ADMIN mới được thay đổi CCCD gốc.',
        });
      }
      const finalIdNumber = incomingIdNum || tenant.id_number;
      if (action === 'approve' && !finalIdNumber) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          code: 'MISSING_IDENTITY_PAPER',
          message: 'Thiếu CCCD/hộ chiếu — cập nhật thông tin giấy tờ trước khi duyệt (FR-021).',
        });
      }
      const upd = await client.query(
        `UPDATE tenant SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
        [nextStatus, id]
      );
      if (incomingIdNum && !tenant.id_number) {
        await client.query(`UPDATE person SET id_number = $1 WHERE id = $2`, [finalIdNumber, tenant.person_id]);
      } else if (incomingIdNum && !isSharedProfile) {
        await client.query(`UPDATE person SET id_number = $1 WHERE id = $2`, [finalIdNumber, tenant.person_id]);
      }
      await client.query(
        `INSERT INTO audit_log (actor_id, action, entity, entity_id, before, after)
         VALUES ($1, $2, 'tenant', $3, $4, $5)`,
        [req.user.sub, action === 'approve' ? 'APPROVE' : 'REJECT', id, JSON.stringify(tenant), JSON.stringify(upd.rows[0])]
      );
      await client.query('COMMIT');
      return res.json({ message: nextStatus === 'APPROVED' ? 'Đã duyệt hồ sơ cư dân.' : 'Đã từ chối hồ sơ cư dân.', data: upd.rows[0] });
    }

    const normDate = (d) => {
      if (!d) return '';
      if (d instanceof Date) return d.toISOString().slice(0, 10);
      return String(d).slice(0, 10);
    };

    if (isSharedProfile) {
      const lockedFields = [];
      if (
        tenant.full_name &&
        full_name !== undefined &&
        String(full_name || '').trim() !== String(tenant.full_name).trim()
      ) {
        lockedFields.push('full_name');
      }
      if (
        tenant.phone &&
        phone !== undefined &&
        normalizeVnPhone(phone) !== normalizeVnPhone(tenant.phone)
      ) {
        lockedFields.push('phone');
      }
      if (
        tenant.id_number &&
        id_number !== undefined &&
        String(id_number || '').trim() !== String(tenant.id_number).trim()
      ) {
        lockedFields.push('id_number');
      }
      if (
        tenant.dob &&
        dob !== undefined &&
        normDate(dob) !== normDate(tenant.dob)
      ) {
        lockedFields.push('dob');
      }

      if (lockedFields.length > 0) {
        await client.query('ROLLBACK');
        await adminPool.query(
          `INSERT INTO audit_log (actor_id, action, entity, entity_id, after)
           VALUES ($1, 'SHARED_PROFILE_EDIT_BLOCKED', 'tenant', $2, $3)`,
          [req.user.sub, id, JSON.stringify({ locked_fields: lockedFields })]
        );
        return res.status(409).json({
          code: 'SHARED_PROFILE_LOCKED',
          locked_fields: lockedFields,
          message:
            'Hồ sơ định danh này đang gắn với hợp đồng hiệu lực khác trong hệ thống. Chỉ Cư dân (trên Cổng cư dân) hoặc SYS_ADMIN mới được thay đổi Họ tên / SĐT / CCCD / Ngày sinh gốc.',
        });
      }
    }

    const nextPerson = {
      full_name: full_name !== undefined ? String(full_name).trim() : tenant.full_name,
      phone: phone !== undefined ? normalizeVnPhone(phone) : tenant.phone,
      email: email !== undefined ? (email ? String(email).trim().toLowerCase() : null) : tenant.email,
      dob: dob !== undefined ? (dob || null) : tenant.dob,
      id_number: id_number !== undefined ? (id_number ? String(id_number).trim() : null) : tenant.id_number,
      address: address !== undefined ? address : tenant.address,
      nationality: nationality !== undefined ? nationality : tenant.nationality,
    };
    if (!nextPerson.full_name || !nextPerson.phone) {
      await client.query('ROLLBACK');
      return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Họ tên và số điện thoại không được để trống.' });
    }

    const dup = await adminPool.query(
      `SELECT 1 FROM person
       WHERE org_id = $1 AND id <> $2 AND (
         phone = $3 OR ($4::text IS NOT NULL AND id_number = $4)
       ) LIMIT 1`,
      [orgId, tenant.person_id, nextPerson.phone, nextPerson.id_number || null]
    );
    if (dup.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        code: 'DUPLICATE_PERSON',
        message: 'SĐT hoặc CCCD đã tồn tại trên một hồ sơ khác trong tổ chức.',
      });
    }

    await client.query(
      `UPDATE person SET full_name = $1, phone = $2, email = $3, dob = $4, id_number = $5, address = $6, nationality = $7, updated_at = NOW()
       WHERE id = $8 RETURNING id`,
      [nextPerson.full_name, nextPerson.phone, nextPerson.email, nextPerson.dob, nextPerson.id_number, nextPerson.address, nextPerson.nationality, tenant.person_id]
    );

    await client.query(
      `INSERT INTO audit_log (actor_id, action, entity, entity_id, before, after)
       VALUES ($1, 'UPDATE', 'tenant', $2, $3, $4)`,
      [req.user.sub, id, JSON.stringify(tenant), JSON.stringify({ ...tenant, ...nextPerson })]
    );

    await client.query('COMMIT');
    res.json({ message: 'Cập nhật hồ sơ cư dân thành công.', data: { ...tenant, ...nextPerson } });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[Update Tenant Error]:', err);
    res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi máy chủ khi cập nhật cư dân.' });
  } finally {
    await release();
  }
});

/**
 * POST /api/v1/tenants/:id/id-images — upload ảnh CCCD (B7, L1)
 */
router.post('/:id/id-images', authenticateToken, requireRole(['SYS_ADMIN', 'MANAGER']), async (req, res) => {
  const { id } = req.params;
  const { image_base64, side } = req.body;

  if (!['front', 'back'].includes(side)) {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: "Cạnh ảnh phải là 'front' hoặc 'back'." });
  }

  try {
    const tenantRes = await pool.query(
      `SELECT t.*, p.id AS person_id, p.id_images AS id_images FROM tenant t JOIN person p ON p.id = t.person_id
       WHERE t.id = $1 AND t.org_id = $2`,
      [id, req.user.org_id]
    );
    if (tenantRes.rows.length === 0) {
      return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy cư dân.' });
    }
    const personId = tenantRes.rows[0].person_id;

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
      `UPDATE person SET id_images = array_append(COALESCE(id_images, '{}'), $1) WHERE id = $2`,
      [marker, personId]
    );

    await pool.query(
      `INSERT INTO audit_log (actor_id, action, entity, entity_id, after)
       VALUES ($1, 'UPLOAD', 'attachment', $2, $3)`,
      [req.user.sub, saved.attachment.id, JSON.stringify({ side, owner: 'person', owner_id: personId })]
    );

    res.status(201).json({ message: 'Đã lưu ảnh CCCD.', data: { attachment_id: saved.attachment.id, side } });
  } catch (err) {
    console.error('[Upload Id Image Error]:', err);
    res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi máy chủ khi lưu ảnh CCCD.' });
  }
});

/**
 * GET /api/v1/tenants/:id/id-images — danh sách ảnh CCCD
 */
router.get('/:id/id-images', authenticateToken, requireRole(['SYS_ADMIN', 'OWNER', 'MANAGER']), async (req, res) => {
  const { id } = req.params;
  try {
    const tenantRes = await pool.query(
      `SELECT t.*, p.id AS person_id, p.id_images AS id_images FROM tenant t JOIN person p ON p.id = t.person_id
       WHERE t.id = $1 AND t.org_id = $2`,
      [id, req.user.org_id]
    );
    if (tenantRes.rows.length === 0) {
      return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy cư dân.' });
    }
    const images = await pool.query(
      `SELECT id AS attachment_id, storage_path, mime FROM attachment
       WHERE owner_entity = 'person' AND owner_id = $1 ORDER BY created_at ASC`,
      [tenantRes.rows[0].person_id]
    );
    const markers = (tenantRes.rows[0].id_images || [])
      .map((m) => { try { return JSON.parse(m); } catch { return null; } })
      .filter(Boolean);
    const data = images.rows.map((img) => ({
      attachment_id: img.attachment_id,
      side: markers.find((m) => m.attachmentId === img.attachment_id)?.side || 'unknown',
    }));
    res.json({ data });
  } catch (err) {
    console.error('[List Id Images Error]:', err);
    res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi máy chủ khi tải ảnh CCCD.' });
  }
});

export default router;
