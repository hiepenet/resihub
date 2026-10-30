import express from 'express';
import { pool, adminPool, getUserClient } from '../db/client.js';
import { authenticateToken } from '../middleware/auth.js';
import { requireRole } from '../middleware/rbac.js';
import { saveBase64Image } from '../services/imageUpload.js';
import { isDiscountedPrice, mapPgError } from '../services/contractGuards.js';
import { refundDeadline } from '../services/deadlines.js';
import { splitDepositOpening } from '../services/depositSettlement.js';
import { buildDiff, nextStatusOnAmend } from '../services/amendment.js';
import { syncApartmentStatus } from '../services/apartmentStatus.js';
import { checkFourEyesOrWarn } from '../services/pricing.js';
import {
  getUserRoleCodes,
  getOwnerBuildingIds,
  getManagerBuildingIds,
  ownerBuildingFilter,
  managerBuildingFilter,
  logAccessDenied,
} from '../services/ownerScope.js';
import {
  normalizeVnPhone,
  checkPersonScopeForActor,
  isInternalPerson,
  upsertPersonAndTenantInTx,
  ensureResidentAccount,
} from '../services/residentAccount.js';

const router = express.Router();
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Kiểm tra quyền phạm vi tòa nhà trên một hợp đồng cụ thể (trước khi RLS lọc mất bản ghi thành 404).
 * Trả về { ok: true, meta } hoặc { ok: false, status, body }.
 */
async function checkContractAccess(req, contractId) {
  if (!UUID_REGEX.test(String(contractId || ''))) {
    return { ok: false, status: 404, body: { code: 'NOT_FOUND', message: 'Không tìm thấy hợp đồng.' } };
  }

  const metaRes = await adminPool.query(
    `SELECT c.id, c.building_id, b.org_id, t.person_id
     FROM contract c
     JOIN building b ON b.id = c.building_id
     JOIN tenant t ON t.id = c.primary_tenant_id
     WHERE c.id = $1`,
    [contractId]
  );

  if (metaRes.rows.length === 0 || metaRes.rows[0].org_id !== req.user.org_id) {
    return { ok: false, status: 404, body: { code: 'NOT_FOUND', message: 'Không tìm thấy hợp đồng.' } };
  }

  const meta = metaRes.rows[0];
  const userRoles = getUserRoleCodes(req);

  if (userRoles.includes('SYS_ADMIN')) {
    return { ok: true, meta };
  }

  if (userRoles.includes('OWNER')) {
    const ownedIds = await getOwnerBuildingIds(req.user.sub, req.user.org_id);
    if (ownedIds.includes(meta.building_id)) {
      return { ok: true, meta };
    }
    if (!userRoles.includes('MANAGER')) {
      await logAccessDenied(req, 'contract', contractId, 'OWNER does not own contract building');
      return {
        ok: false,
        status: 403,
        body: { code: 'ACCESS_DENIED', message: 'Bạn không sở hữu tòa nhà chứa hợp đồng này.' },
      };
    }
  }

  if (userRoles.includes('MANAGER')) {
    const mgrIds = await getManagerBuildingIds(req.user.sub, req.user.org_id);
    if (mgrIds.includes(meta.building_id)) {
      return { ok: true, meta };
    }
    await logAccessDenied(req, 'contract', contractId, 'MANAGER is not assigned to contract building');
    return {
      ok: false,
      status: 403,
      body: { code: 'ACCESS_DENIED', message: 'Bạn không có quyền quản lý hợp đồng của tòa nhà này.' },
    };
  }

  if (userRoles.includes('RESIDENT')) {
    const isPrimary = Boolean(req.user.person_id && meta.person_id === req.user.person_id);
    let isOccupant = false;
    if (!isPrimary && req.user.person_id) {
      const occRes = await adminPool.query(
        `SELECT 1
         FROM contract_occupant co
         JOIN tenant t ON t.id = co.tenant_id
         WHERE co.contract_id = $1 AND t.person_id = $2
         LIMIT 1`,
        [contractId, req.user.person_id]
      );
      isOccupant = occRes.rows.length > 0;
    }
    if (isPrimary || isOccupant) {
      return { ok: true, meta };
    }
    await logAccessDenied(req, 'contract', contractId, 'RESIDENT does not belong to contract');
    return {
      ok: false,
      status: 403,
      body: { code: 'ACCESS_DENIED', message: 'Bạn chỉ có quyền xem hợp đồng của chính mình.' },
    };
  }

  await logAccessDenied(req, 'contract', contractId, 'Unauthorized role for contract');
  return { ok: false, status: 403, body: { code: 'ACCESS_DENIED', message: 'Không có quyền truy cập hợp đồng.' } };
}

/**
 * GET /api/v1/contracts
 * - SYS_ADMIN: Xem toàn bộ hợp đồng trong tổ chức (R)
 * - OWNER: Xem hợp đồng thuộc các tòa mình sở hữu (100% Read-Only theo PRD 6.2)
 * - MANAGER: Xem hợp đồng thuộc tòa được gán (CRU)
 * - RESIDENT: Xem hợp đồng của chính mình (R)
 */
router.get('/', authenticateToken, requireRole(['SYS_ADMIN', 'OWNER', 'MANAGER', 'RESIDENT']), async (req, res) => {
  try {
    const orgId = req.user.org_id;
    const userRoles = getUserRoleCodes(req);
    const isSysAdmin = userRoles.includes('SYS_ADMIN');
    const isOwner = userRoles.includes('OWNER');
    const isManager = userRoles.includes('MANAGER');
    const isResident = userRoles.includes('RESIDENT');
    const { building_id, status } = req.query;

    if (building_id && !isSysAdmin) {
      if (isOwner) {
        const ownedIds = await getOwnerBuildingIds(req.user.sub, orgId);
        if (!ownedIds.includes(building_id)) {
          await logAccessDenied(req, 'building', building_id, 'OWNER requested contracts of unowned building');
          return res.status(403).json({ code: 'ACCESS_DENIED', message: 'Bạn không sở hữu tòa nhà này.' });
        }
      } else if (isManager) {
        const mgrIds = await getManagerBuildingIds(req.user.sub, orgId);
        if (!mgrIds.includes(building_id)) {
          await logAccessDenied(req, 'building', building_id, 'MANAGER requested contracts of unassigned building');
          return res.status(403).json({ code: 'ACCESS_DENIED', message: 'Bạn không được phân công quản lý tòa nhà này.' });
        }
      }
    }

    let sql = `SELECT c.*, 
        a.code as apartment_code, 
        b.name as building_name, 
        p.full_name as tenant_name, 
        p.phone as tenant_phone
       FROM contract c
       JOIN apartment a ON a.id = c.apartment_id
       JOIN building b ON b.id = c.building_id
       JOIN tenant t ON t.id = c.primary_tenant_id
       JOIN person p ON p.id = t.person_id
       WHERE b.org_id = $1`;
    const params = [orgId];

    if (isSysAdmin) {
      // SYS_ADMIN: Xem toàn bộ hợp đồng trong org
    } else if (isOwner) {
      const { sql: ownerSql } = await ownerBuildingFilter('c.building_id', req.user.sub, orgId, params);
      sql += ownerSql;
    } else if (isManager) {
      const { sql: mgrSql } = await managerBuildingFilter('c.building_id', req.user.sub, orgId, params);
      sql += mgrSql;
    } else if (isResident) {
      params.push(req.user.person_id);
      sql += ` AND p.id = $${params.length}`;
    }

    if (building_id) {
      params.push(building_id);
      sql += ` AND c.building_id = $${params.length}`;
    }

    if (status) {
      params.push(status);
      sql += ` AND c.status = $${params.length}`;
    }

    sql += ` ORDER BY c.created_at DESC`;
    const { client, release } = await getUserClient(req);
    try {
      const result = await client.query(sql, params);
      res.json({ data: result.rows });
    } finally {
      await release();
    }
  } catch (err) {
    console.error('[Contracts Error]:', err);
    res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi khi lấy danh sách hợp đồng.' });
  }
});

/**
 * GET /api/v1/contracts/requests (FR-019)
 * Danh sách đề nghị gia hạn/chấm dứt từ cư dân dành cho BQL/Chủ nhà/Admin (R)
 */
router.get('/requests', authenticateToken, requireRole(['SYS_ADMIN', 'OWNER', 'MANAGER']), async (req, res) => {
  try {
    const orgId = req.user.org_id;
    const userRoles = getUserRoleCodes(req);
    const isSysAdmin = userRoles.includes('SYS_ADMIN');
    const isOwner = userRoles.includes('OWNER');
    const isManager = userRoles.includes('MANAGER');
    const { building_id, status } = req.query;

    if (building_id && !isSysAdmin) {
      if (isOwner) {
        const ownedIds = await getOwnerBuildingIds(req.user.sub, orgId);
        if (!ownedIds.includes(building_id)) {
          await logAccessDenied(req, 'building', building_id, 'OWNER requested contract_requests of unowned building');
          return res.status(403).json({ code: 'ACCESS_DENIED', message: 'Bạn không sở hữu tòa nhà này.' });
        }
      } else if (isManager) {
        const mgrIds = await getManagerBuildingIds(req.user.sub, orgId);
        if (!mgrIds.includes(building_id)) {
          await logAccessDenied(req, 'building', building_id, 'MANAGER requested contract_requests of unassigned building');
          return res.status(403).json({ code: 'ACCESS_DENIED', message: 'Bạn không được phân công quản lý tòa nhà này.' });
        }
      }
    }

    let sql = `
      SELECT cr.id, cr.org_id, cr.contract_id, cr.building_id, cr.type, cr.desired_date, cr.note, cr.status, cr.created_by, cr.created_at, cr.updated_at,
             c.status as contract_status, c.start_date, c.end_date, c.rent_amount,
             a.code as apartment_code,
             b.name as building_name,
             p.full_name as resident_name,
             p.phone as resident_phone
      FROM contract_request cr
      JOIN contract c ON c.id = cr.contract_id
      JOIN apartment a ON a.id = c.apartment_id
      JOIN building b ON b.id = cr.building_id
      JOIN tenant t ON t.id = c.primary_tenant_id
      JOIN person p ON p.id = t.person_id
      WHERE cr.org_id = $1
    `;
    const params = [orgId];

    if (isSysAdmin) {
      // SYS_ADMIN: R toàn tổ chức
    } else if (isOwner) {
      const { sql: ownerSql } = await ownerBuildingFilter('cr.building_id', req.user.sub, orgId, params);
      sql += ownerSql;
    } else if (isManager) {
      const { sql: mgrSql } = await managerBuildingFilter('cr.building_id', req.user.sub, orgId, params);
      sql += mgrSql;
    }

    if (building_id) {
      params.push(building_id);
      sql += ` AND cr.building_id = $${params.length}`;
    }

    if (status) {
      params.push(status);
      sql += ` AND cr.status = $${params.length}`;
    }

    sql += ` ORDER BY cr.created_at DESC`;
    const { client, release } = await getUserClient(req);
    try {
      const result = await client.query(sql, params);
      res.json({ data: result.rows });
    } finally {
      await release();
    }
  } catch (err) {
    console.error('[Contract Requests Error]:', err);
    res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi khi lấy danh sách đề nghị hợp đồng.' });
  }
});

/**
 * POST /api/v1/contracts/requests/:id/approve (MANAGER, SYS_ADMIN theo AC-006.1 & Mục 6.2)
 * Phê duyệt đề nghị gia hạn/chấm dứt từ cư dân (OWNER 100% Read-Only)
 */
router.post('/requests/:id/approve', authenticateToken, requireRole(['SYS_ADMIN', 'MANAGER']), async (req, res) => {
  const { id } = req.params;
  if (!UUID_REGEX.test(String(id || ''))) {
    return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy đề nghị.' });
  }

  const metaRes = await adminPool.query(
    `SELECT id, org_id, building_id, type FROM contract_request WHERE id = $1`,
    [id]
  );
  if (metaRes.rows.length === 0 || metaRes.rows[0].org_id !== req.user.org_id) {
    return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy đề nghị.' });
  }
  const reqMeta = metaRes.rows[0];
  const userRoles = getUserRoleCodes(req);
  if (!userRoles.includes('SYS_ADMIN')) {
    const mgrIds = await getManagerBuildingIds(req.user.sub, req.user.org_id);
    if (!mgrIds.includes(reqMeta.building_id)) {
      await logAccessDenied(req, 'contract_request', id, 'MANAGER not assigned to contract_request building');
      return res.status(403).json({ code: 'ACCESS_DENIED', message: 'Bạn không được phân công quản lý tòa nhà của đề nghị này.' });
    }
  }

  const { client, release } = await getUserClient(req);

  try {
    await client.query('BEGIN');

    const reqRes = await client.query(
      `SELECT cr.*, c.apartment_id, a.code as apartment_code, b.name as building_name, c.primary_tenant_id
       FROM contract_request cr
       JOIN contract c ON c.id = cr.contract_id
       JOIN apartment a ON a.id = c.apartment_id
       JOIN building b ON b.id = cr.building_id
       WHERE cr.id = $1
       FOR UPDATE OF cr`,
      [id]
    );

    if (reqRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy đề nghị.' });
    }

    const requestItem = reqRes.rows[0];

    if (requestItem.status !== 'SUBMITTED') {
      await client.query('ROLLBACK');
      return res.status(409).json({ code: 'ALREADY_PROCESSED', message: 'Đề nghị này đã được xử lý trước đó.' });
    }

    const updatedRes = await client.query(
      `UPDATE contract_request
       SET status = 'APPROVED', updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [id]
    );

    await client.query(
      `INSERT INTO audit_log (actor_id, action, entity, entity_id, before, after)
       VALUES ($1, 'APPROVE', 'contract_request', $2, $3, $4)`,
      [
        req.user.sub,
        id,
        JSON.stringify({ status: requestItem.status }),
        JSON.stringify({ status: 'APPROVED' }),
      ]
    );

    let targetUserId = requestItem.created_by;
    if (!targetUserId) {
      const uRes = await client.query(
        `SELECT u.id as user_id
         FROM app_user u
         JOIN person p ON p.id = u.person_id
         JOIN tenant t ON t.person_id = p.id
         WHERE t.id = $1 LIMIT 1`,
        [requestItem.primary_tenant_id]
      );
      if (uRes.rows.length > 0) targetUserId = uRes.rows[0].user_id;
    }

    if (targetUserId) {
      const isTerm = requestItem.type === 'TERMINATION';
      const title = isTerm ? 'Phê duyệt đề nghị chấm dứt hợp đồng' : 'Phê duyệt đề nghị gia hạn hợp đồng';
      const content = isTerm
        ? `Ban Quản Lý đã phê duyệt đề nghị chấm dứt hợp đồng thuê căn hộ ${requestItem.apartment_code}. Vui lòng liên hệ BQL để thống nhất lịch bàn giao phòng và hoàn tất thủ tục tất toán.`
        : `Ban Quản Lý đã phê duyệt đề nghị gia hạn hợp đồng thuê căn hộ ${requestItem.apartment_code}. BQL sẽ sớm gửi phụ lục gia hạn hợp đồng đến bạn.`;

      await client.query(
        `INSERT INTO notification (org_id, user_id, title, content, type, payload)
         VALUES ($1, $2, $3, $4, 'CONTRACT_REQUEST_APPROVED', $5)`,
        [
          requestItem.org_id,
          targetUserId,
          title,
          content,
          JSON.stringify({ request_id: id, contract_id: requestItem.contract_id, link: '/resident' }),
        ]
      );
    }

    await client.query('COMMIT');

    res.json({
      message: 'Đã phê duyệt đề nghị của cư dân thành công.',
      data: updatedRes.rows[0],
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[Approve Contract Request Error]:', err);
    res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi khi phê duyệt đề nghị.' });
  } finally {
    await release();
  }
});

/**
 * POST /api/v1/contracts/requests/:id/reject (MANAGER, SYS_ADMIN theo AC-006.1 & Mục 6.2)
 * Từ chối đề nghị gia hạn/chấm dứt từ cư dân (OWNER 100% Read-Only)
 */
router.post('/requests/:id/reject', authenticateToken, requireRole(['SYS_ADMIN', 'MANAGER']), async (req, res) => {
  const { id } = req.params;
  const { reason } = req.body;
  if (!UUID_REGEX.test(String(id || ''))) {
    return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy đề nghị.' });
  }

  const metaRes = await adminPool.query(
    `SELECT id, org_id, building_id FROM contract_request WHERE id = $1`,
    [id]
  );
  if (metaRes.rows.length === 0 || metaRes.rows[0].org_id !== req.user.org_id) {
    return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy đề nghị.' });
  }
  const reqMeta = metaRes.rows[0];
  const userRoles = getUserRoleCodes(req);
  if (!userRoles.includes('SYS_ADMIN')) {
    const mgrIds = await getManagerBuildingIds(req.user.sub, req.user.org_id);
    if (!mgrIds.includes(reqMeta.building_id)) {
      await logAccessDenied(req, 'contract_request', id, 'MANAGER not assigned to contract_request building');
      return res.status(403).json({ code: 'ACCESS_DENIED', message: 'Bạn không được phân công quản lý tòa nhà của đề nghị này.' });
    }
  }

  const { client, release } = await getUserClient(req);

  try {
    await client.query('BEGIN');

    const reqRes = await client.query(
      `SELECT cr.*, c.apartment_id, a.code as apartment_code, b.name as building_name, c.primary_tenant_id
       FROM contract_request cr
       JOIN contract c ON c.id = cr.contract_id
       JOIN apartment a ON a.id = c.apartment_id
       JOIN building b ON b.id = cr.building_id
       WHERE cr.id = $1
       FOR UPDATE OF cr`,
      [id]
    );

    if (reqRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy đề nghị.' });
    }

    const requestItem = reqRes.rows[0];

    if (requestItem.status !== 'SUBMITTED') {
      await client.query('ROLLBACK');
      return res.status(409).json({ code: 'ALREADY_PROCESSED', message: 'Đề nghị này đã được xử lý trước đó.' });
    }

    const updatedNote = reason
      ? (requestItem.note ? `${requestItem.note}\n[Lý do từ chối]: ${reason.trim()}` : `[Lý do từ chối]: ${reason.trim()}`)
      : requestItem.note;

    const updatedRes = await client.query(
      `UPDATE contract_request
       SET status = 'REJECTED', note = $2, updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [id, updatedNote]
    );

    await client.query(
      `INSERT INTO audit_log (actor_id, action, entity, entity_id, before, after)
       VALUES ($1, 'REJECT', 'contract_request', $2, $3, $4)`,
      [
        req.user.sub,
        id,
        JSON.stringify({ status: requestItem.status }),
        JSON.stringify({ status: 'REJECTED', reason }),
      ]
    );

    let targetUserId = requestItem.created_by;
    if (!targetUserId) {
      const uRes = await client.query(
        `SELECT u.id as user_id
         FROM app_user u
         JOIN person p ON p.id = u.person_id
         JOIN tenant t ON t.person_id = p.id
         WHERE t.id = $1 LIMIT 1`,
        [requestItem.primary_tenant_id]
      );
      if (uRes.rows.length > 0) targetUserId = uRes.rows[0].user_id;
    }

    if (targetUserId) {
      const isTerm = requestItem.type === 'TERMINATION';
      const title = `Từ chối đề nghị ${isTerm ? 'chấm dứt' : 'gia hạn'} hợp đồng`;
      const content = `Đề nghị ${isTerm ? 'chấm dứt' : 'gia hạn'} hợp đồng thuê căn hộ ${requestItem.apartment_code} của bạn đã bị từ chối.${reason ? ' Lý do: ' + reason.trim() : ''}`;

      await client.query(
        `INSERT INTO notification (org_id, user_id, title, content, type, payload)
         VALUES ($1, $2, $3, $4, 'CONTRACT_REQUEST_REJECTED', $5)`,
        [
          requestItem.org_id,
          targetUserId,
          title,
          content,
          JSON.stringify({ request_id: id, contract_id: requestItem.contract_id, reason, link: '/resident' }),
        ]
      );
    }

    await client.query('COMMIT');

    res.json({
      message: 'Đã từ chối đề nghị của cư dân.',
      data: updatedRes.rows[0],
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[Reject Contract Request Error]:', err);
    res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi khi từ chối đề nghị.' });
  } finally {
    await release();
  }
});

/**
 * GET /api/v1/contracts/:id
 */
router.get('/:id', authenticateToken, requireRole(['SYS_ADMIN', 'OWNER', 'MANAGER', 'RESIDENT']), async (req, res) => {
  const { id } = req.params;
  try {
    const access = await checkContractAccess(req, id);
    if (!access.ok) {
      return res.status(access.status).json(access.body);
    }

    const { client, release } = await getUserClient(req);
    try {
      const result = await client.query(
        `SELECT c.*, 
          a.code as apartment_code, 
          b.name as building_name, 
          p.id as person_id,
          p.full_name as tenant_name, 
          p.phone as tenant_phone,
          p.email as tenant_email
         FROM contract c
         JOIN apartment a ON a.id = c.apartment_id
         JOIN building b ON b.id = c.building_id
         JOIN tenant t ON t.id = c.primary_tenant_id
         JOIN person p ON p.id = t.person_id
         WHERE c.id = $1`,
        [id]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy hợp đồng.' });
      }

      const chainRes = await client.query(
        `WITH RECURSIVE chain AS (
           SELECT id, parent_contract_id, start_date, end_date, rent_amount, status, apartment_id, 0 AS depth
           FROM contract WHERE id = $1
           UNION ALL
           SELECT c.id, c.parent_contract_id, c.start_date, c.end_date, c.rent_amount, c.status, c.apartment_id, ch.depth - 1
           FROM contract c JOIN chain ch ON c.id = ch.parent_contract_id
           WHERE ch.depth > -10
         ),
         children AS (
           SELECT id, parent_contract_id, start_date, end_date, rent_amount, status, apartment_id
           FROM contract WHERE parent_contract_id = $1
         )
         SELECT ch.*, a.code as apartment_code FROM (
           SELECT id, parent_contract_id, start_date, end_date, rent_amount, status, apartment_id FROM chain WHERE id <> $1
           UNION
           SELECT id, parent_contract_id, start_date, end_date, rent_amount, status, apartment_id FROM children
         ) ch
         JOIN apartment a ON a.id = ch.apartment_id
         ORDER BY ch.start_date DESC`,
        [id]
      );

      const attRes = await client.query(
        `SELECT id, storage_path, mime, size_bytes, created_at
         FROM attachment
         WHERE owner_entity = 'contract' AND owner_id = $1
         ORDER BY created_at DESC`,
        [id]
      );

      res.json({
        data: {
          ...result.rows[0],
          related_contracts: chainRes.rows,
          attachments: attRes.rows,
        },
      });
    } finally {
      await release();
    }
  } catch (err) {
    console.error('[Get Contract Error]:', err);
    res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi khi lấy chi tiết hợp đồng.' });
  }
});

/**
 * POST /api/v1/contracts (NV-08 — TẠO HỢP ĐỒNG THUÊ)
 * Quyền: Chỉ MANAGER có quyền tạo hợp đồng (CRU)
 */
router.post('/', authenticateToken, requireRole(['MANAGER']), async (req, res) => {
  const {
    apartment_id,
    building_id,
    primary_tenant_id,
    reservation_id,
    new_tenant,
    start_date,
    end_date,
    rent_amount,
    billing_day,
    deposit_amount,
    deposit_months,
    note,
  } = req.body;

  const hasExistingTenant = Boolean(primary_tenant_id);
  const hasNewTenant = Boolean(
    new_tenant && typeof new_tenant === 'object' && new_tenant.full_name && new_tenant.phone
  );

  if (!apartment_id || (!hasExistingTenant && !hasNewTenant) || !start_date || !end_date || !rent_amount) {
    return res.status(422).json({
      code: 'VALIDATION_ERROR',
      message: 'Thiếu thông tin bắt buộc: Căn hộ, Khách thuê (có sẵn hoặc tạo mới), Ngày bắt đầu, Ngày kết thúc hoặc Giá thuê.',
    });
  }

  if (hasNewTenant && new_tenant.password && String(new_tenant.password).length < 8) {
    return res.status(400).json({
      code: 'VALIDATION_ERROR',
      message: 'Mật khẩu đăng nhập ban đầu của cư dân phải từ 8 ký tự trở lên.',
    });
  }

  // Rule C2: Ngày kết thúc phải sau ngày bắt đầu
  const start = new Date(start_date);
  const end = new Date(end_date);
  if (end <= start) {
    return res.status(422).json({
      code: 'INVALID_DATE_RANGE',
      message: 'Ngày kết thúc hợp đồng phải sau ngày bắt đầu hợp đồng.',
    });
  }

  // Pre-check quyền tòa nhà qua adminPool trước khi RLS lọc căn hộ thành 404 (AC-019.1)
  if (!UUID_REGEX.test(String(apartment_id))) {
    return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy căn hộ.' });
  }
  const aptMeta = await adminPool.query(
    `SELECT a.id, a.building_id, b.org_id
     FROM apartment a JOIN building b ON b.id = a.building_id
     WHERE a.id = $1`,
    [apartment_id]
  );
  if (aptMeta.rows.length === 0 || aptMeta.rows[0].org_id !== req.user.org_id) {
    return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy căn hộ.' });
  }
  const mgrIds = await getManagerBuildingIds(req.user.sub, req.user.org_id);
  if (!mgrIds.includes(aptMeta.rows[0].building_id)) {
    await logAccessDenied(req, 'building', aptMeta.rows[0].building_id, 'MANAGER attempted to create contract in unassigned building');
    return res.status(403).json({
      code: 'ACCESS_DENIED',
      message: 'Bạn không có quyền quản lý tòa nhà này để lập hợp đồng.',
    });
  }

  const { client, release } = await getUserClient(req);
  try {
    await client.query('BEGIN');

    // Guard căn hộ: chỉ AVAILABLE hoặc RESERVED được lập hợp đồng (A3, PRD FR-014)
    // C5: derive building_id từ căn hộ để chống tạo hợp đồng chéo tòa
    const aptCheck = await client.query(
      `SELECT status, building_id, base_rent FROM apartment WHERE id = $1`,
      [apartment_id]
    );
    if (aptCheck.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy căn hộ.' });
    }

    const effectiveBuildingId = aptCheck.rows[0].building_id;

    // Chặn nếu body gửi building_id lệch với tòa của căn
    if (building_id && building_id !== effectiveBuildingId) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        code: 'BUILDING_MISMATCH',
        message: 'Tòa nhà được chọn không khớp với tòa nhà của căn hộ.',
      });
    }

    const todayRes = await client.query('SELECT CURRENT_DATE::text AS today');
    const todayStr = todayRes.rows[0].today;
    const sDateStr = String(start_date).slice(0, 10);
    const isFutureContract = sDateStr > todayStr;

    if (aptCheck.rows[0].status === 'INACTIVE') {
      await client.query('ROLLBACK');
      return res.status(409).json({
        code: 'INVALID_APARTMENT_STATUS',
        message: 'Căn hộ đang ngừng khai thác (INACTIVE), không thể lập hợp đồng.',
      });
    }

    if (!isFutureContract && !['AVAILABLE', 'RESERVED'].includes(aptCheck.rows[0].status)) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        code: 'INVALID_APARTMENT_STATUS',
        message: `Căn hộ đang ở trạng thái ${aptCheck.rows[0].status}, hợp đồng bắt đầu ngay chỉ ký được trên căn AVAILABLE hoặc RESERVED (hoặc chọn ngày bắt đầu trong tương lai để lập hợp đồng nối tiếp).`,
      });
    }

    // Rule C1 & NV-08: Chống chồng lấn kỳ hạn trên cùng căn hộ
    // Half-open [start, end) — HĐ kết thúc tại ngày D cho phép HĐ mới bắt đầu D (PRD 13.3)
    const overlapCheck = await client.query(
      `SELECT c.id, c.start_date, c.end_date, t.id AS tenant_id, p.full_name
       FROM contract c
       LEFT JOIN tenant t ON t.id = c.primary_tenant_id
       LEFT JOIN person p ON p.id = t.person_id
       WHERE c.apartment_id = $1
         AND c.status IN ('DRAFT', 'PENDING_APPROVAL', 'ACTIVE', 'RENEWAL_PENDING')
         AND (c.start_date < $3 AND c.end_date > $2)`,
      [apartment_id, start_date, end_date]
    );

    if (overlapCheck.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        code: 'OVERLAP_CONTRACT',
        message: 'Căn hộ đã có hợp đồng trong khoảng thời gian đã chọn.',
        conflicts: overlapCheck.rows.map((c) => ({
          contract_id: c.id,
          start_date: c.start_date,
          end_date: c.end_date,
          tenant: c.full_name,
        })),
      });
    }

    // Khởi tạo hồ sơ cư dân mới ngay trong cùng transaction nếu người dùng chọn "+ Tạo mới cư dân",
    // hoặc liên kết hồ sơ có sẵn qua Know-Before-You-Link (hỗ trợ đa tòa nhà nhưng chặn nhân sự nội bộ)
    let effectiveTenantId = primary_tenant_id;
    let inlineTenantResult = null;
    let linkedCrossBuilding = false;
    if (effectiveTenantId) {
      if (!UUID_REGEX.test(String(effectiveTenantId))) {
        await client.query('ROLLBACK');
        return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy hồ sơ cư dân.' });
      }
      const tMeta = await adminPool.query(
        'SELECT id, person_id, status FROM tenant WHERE id = $1 AND org_id = $2 LIMIT 1',
        [effectiveTenantId, req.user.org_id]
      );
      if (tMeta.rows.length === 0 || ['MERGED', 'REJECTED'].includes(tMeta.rows[0].status)) {
        await client.query('ROLLBACK');
        return res.status(404).json({ code: 'NOT_FOUND', message: 'Hồ sơ cư dân không tồn tại hoặc không còn hợp lệ.' });
      }
      const internal = await isInternalPerson(tMeta.rows[0].person_id, req.user.org_id);
      if (internal) {
        await client.query('ROLLBACK');
        await logAccessDenied(req, 'tenant', effectiveTenantId, 'MANAGER attempted to link internal staff/owner as tenant');
        return res.status(403).json({
          code: 'INVALID_TENANT_PROFILE',
          message: 'Không thể sử dụng tài khoản nhân sự nội bộ / chủ đầu tư làm khách thuê hợp đồng.',
        });
      }
      const inScope = await checkPersonScopeForActor(tMeta.rows[0].person_id, {
        actorId: req.user.sub,
        orgId: req.user.org_id,
        roleCodes: getUserRoleCodes(req),
      });
      linkedCrossBuilding = !inScope;
    } else if (hasNewTenant) {
      inlineTenantResult = await upsertPersonAndTenantInTx(client, {
        orgId: req.user.org_id,
        actorId: req.user.sub,
        actorRoles: getUserRoleCodes(req),
        fullName: new_tenant.full_name,
        phone: new_tenant.phone,
        email: new_tenant.email,
        dob: new_tenant.dob,
        idNumber: new_tenant.id_number,
        address: new_tenant.address,
        nationality: new_tenant.nationality,
        type: 'primary',
      });
      effectiveTenantId = inlineTenantResult.tenant.id;
    }

    // Tính toán tiền cọc
    let finalDeposit = 0;
    if (deposit_amount !== undefined && deposit_amount !== null) {
      finalDeposit = Number(deposit_amount);
    } else if (deposit_months) {
      finalDeposit = Number(rent_amount) * Number(deposit_months);
    }

    // 1. Tạo bản ghi contract — luôn DRAFT trước (A3, PRD 485: lưu DRAFT → tải bản ký → ACTIVE)
    const contractRes = await client.query(
      `INSERT INTO contract (
        apartment_id, building_id, primary_tenant_id, start_date, end_date,
        rent_amount, billing_day, deposit_amount, status, created_by, note
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'DRAFT', $9, $10)
       RETURNING *`,
      [
        apartment_id,
        effectiveBuildingId,
        effectiveTenantId,
        start_date,
        end_date,
        rent_amount,
        billing_day || 1,
        finalDeposit,
        req.user.sub,
        note || '',
      ]
    );

    const contract = contractRes.rows[0];

    // Căn hộ và cọc giữ chỗ KHÔNG đổi ở bước DRAFT: căn AVAILABLE/RESERVED giữ nguyên,
    // cọc giữ chỗ vẫn HELD — chỉ kích hoạt khi ACTIVE (Task 8, PRD 485 bước 6).

    // 2. Ghi audit log
    await client.query(
      `INSERT INTO audit_log (actor_id, action, entity, entity_id, after)
       VALUES ($1, 'CREATE', 'contract', $2, $3)`,
      [
        req.user.sub,
        contract.id,
        JSON.stringify({
          ...contract,
          ...(reservation_id && UUID_REGEX.test(String(reservation_id)) ? { reservation_id: String(reservation_id) } : {}),
          ...(linkedCrossBuilding ? { cross_building_link: true } : {}),
        }),
      ]
    );

    await client.query('COMMIT');

    // Tự động đảm bảo khách thuê đại diện có tài khoản app_user (ACTIVE) + role RESIDENT
    try {
      if (inlineTenantResult) {
        await ensureResidentAccount(inlineTenantResult.personId, {
          email: inlineTenantResult.cleanEmail,
          phone: inlineTenantResult.cleanPhone,
          password: new_tenant?.password,
        });
      } else if (effectiveTenantId) {
        const tpRes = await adminPool.query(
          `SELECT p.id AS person_id, p.email, p.phone
           FROM tenant t JOIN person p ON p.id = t.person_id
           WHERE t.id = $1 LIMIT 1`,
          [effectiveTenantId]
        );
        if (tpRes.rows.length > 0) {
          await ensureResidentAccount(tpRes.rows[0].person_id, {
            email: tpRes.rows[0].email,
            phone: tpRes.rows[0].phone,
          });
        }
      }
    } catch (acctErr) {
      console.error('[Contract Ensure Resident Account Warning]:', acctErr);
    }

    res.status(201).json({
      message: inlineTenantResult
        ? 'Đã tạo hồ sơ cư dân mới (kèm tài khoản Cổng cư dân) và lưu nháp hợp đồng thành công.'
        : 'Đã lưu nháp. Tải bản ký, đính kèm bản scan rồi kích hoạt để hoàn tất.',
      data: contract,
      ...(inlineTenantResult ? { created_tenant: inlineTenantResult.tenant } : {}),
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
    const mapped = mapPgError(err);
    if (mapped) {
      return res.status(mapped.status).json({ code: mapped.code, message: mapped.message });
    }
    console.error('[Create Contract Error]:', err);
    res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi máy chủ khi tạo hợp đồng.' });
  } finally {
    await release();
  }
});

/**
 * GET /api/v1/contracts/:id/occupants — thành viên cùng ở theo hợp đồng (B6)
 */
router.get('/:id/occupants', authenticateToken, requireRole(['SYS_ADMIN', 'OWNER', 'MANAGER', 'RESIDENT']), async (req, res) => {
  const { id } = req.params;
  const access = await checkContractAccess(req, id);
  if (!access.ok) {
    return res.status(access.status).json(access.body);
  }
  const { client, release } = await getUserClient(req);
  try {
    const result = await client.query(
      `SELECT t.id AS tenant_id, p.full_name, p.phone, p.email, p.id_number, co.relationship
       FROM contract_occupant co
       JOIN tenant t ON t.id = co.tenant_id
       JOIN person p ON p.id = t.person_id
       WHERE co.contract_id = $1
       ORDER BY co.created_at ASC`,
      [id]
    );
    res.json({ data: result.rows });
  } catch (err) {
    console.error('[List Occupants Error]:', err);
    res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi khi tải thành viên cùng ở.' });
  } finally {
    await release();
  }
});

/**
 * POST /api/v1/contracts/:id/occupants — thêm thành viên cùng ở (B6): tái dùng person theo SĐT,
 * tạo tenant type='occupant' nếu chưa có, rồi gắn vào contract_occupant.
 */
router.post('/:id/occupants', authenticateToken, requireRole(['MANAGER']), async (req, res) => {
  const { id } = req.params;
  const { full_name, phone, relationship, email, dob, id_number } = req.body;

  if (!full_name || !phone) {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Họ tên và số điện thoại là bắt buộc.' });
  }

  const access = await checkContractAccess(req, id);
  if (!access.ok) {
    return res.status(access.status).json(access.body);
  }

  const { client, release } = await getUserClient(req);
  try {
    await client.query('BEGIN');

    const cleanPhone = normalizeVnPhone(phone);
    // Kiểm tra person trùng SĐT trong org (qua adminPool để không va phải unique constraint dưới RLS chéo tòa)
    const personRes = await adminPool.query(
      'SELECT * FROM person WHERE org_id = $1 AND phone = $2 LIMIT 1',
      [req.user.org_id, cleanPhone]
    );
    let personId;
    if (personRes.rows.length === 0) {
      personId = (await client.query(
        `INSERT INTO person (org_id, full_name, phone, email, dob, id_number, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [req.user.org_id, full_name, cleanPhone, email || null, dob || null, id_number || null, req.user.sub]
      )).rows[0].id;
    } else {
      personId = personRes.rows[0].id;
      const internal = await isInternalPerson(personId, req.user.org_id);
      if (internal) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          code: 'INVALID_OCCUPANT',
          message: 'Số điện thoại này thuộc tài khoản nhân sự nội bộ, không thể thêm làm thành viên lưu trú.',
        });
      }
      // Chỉ điền bổ sung các trường đang trống, không ghi đè định danh gốc đã có của hồ sơ dùng chung
      await adminPool.query(
        `UPDATE person SET
           email = COALESCE(NULLIF(email, ''), $1),
           dob = COALESCE(dob, $2),
           id_number = COALESCE(NULLIF(id_number, ''), $3)
         WHERE id = $4`,
        [email || null, dob || null, id_number || null, personId]
      );
    }

    // Tìm tenant occupant của person, chưa có thì tạo.
    // Lưu ý: nếu person vừa được tạo mới trong transaction `client` (chưa commit), phải INSERT tenant trên `client`
    // để thấy khóa ngoại `person_id`; nếu person đã tồn tại từ trước (có thể thuộc tòa khác), dùng `adminPool` để không bị vướng RLS chéo tòa trước khi gắn contract_occupant.
    let tenantId;
    if (personRes.rows.length === 0) {
      tenantId = (
        await client.query(
          `INSERT INTO tenant (person_id, org_id, type, status, created_by)
           VALUES ($1, $2, 'occupant', 'APPROVED', $3) RETURNING id`,
          [personId, req.user.org_id, req.user.sub]
        )
      ).rows[0].id;
    } else {
      const tenantRes = await adminPool.query(
        `SELECT * FROM tenant WHERE person_id = $1 AND org_id = $2 AND type = 'occupant' AND status NOT IN ('MERGED', 'REJECTED') LIMIT 1`,
        [personId, req.user.org_id]
      );
      if (tenantRes.rows.length === 0) {
        tenantId = (
          await adminPool.query(
            `INSERT INTO tenant (person_id, org_id, type, status, created_by)
             VALUES ($1, $2, 'occupant', 'APPROVED', $3) RETURNING id`,
            [personId, req.user.org_id, req.user.sub]
          )
        ).rows[0].id;
      } else {
        tenantId = tenantRes.rows[0].id;
      }
    }

    // Trùng thành viên trong cùng hợp đồng?
    const dup = await client.query(
      'SELECT 1 FROM contract_occupant WHERE contract_id = $1 AND tenant_id = $2',
      [id, tenantId]
    );
    if (dup.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ code: 'OCCUPANT_EXISTS', message: 'Người này đã là thành viên của hợp đồng.' });
    }

    await client.query(
      'INSERT INTO contract_occupant (contract_id, tenant_id, relationship) VALUES ($1, $2, $3)',
      [id, tenantId, relationship || 'family']
    );

    await client.query(
      `INSERT INTO audit_log (actor_id, action, entity, entity_id, after)
       VALUES ($1, 'CREATE', 'contract_occupant', $2, $3)`,
      [req.user.sub, id, JSON.stringify({ contract_id: id, tenant_id: tenantId, relationship })]
    );

    await client.query('COMMIT');
    try {
      await ensureResidentAccount(personId, { email, phone: cleanPhone });
    } catch (acctErr) {
      console.error('[Add Occupant Ensure Account Warning]:', acctErr);
    }
    res.status(201).json({
      message: 'Đã thêm thành viên cùng ở.',
      data: { contract_id: id, tenant_id: tenantId, person_id: personId, relationship: relationship || 'family' },
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[Add Occupant Error]:', err);
    res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi máy chủ khi thêm thành viên.' });
  } finally {
    await release();
  }
});

/**
 * DELETE /api/v1/contracts/:id/occupants/:tenant_id — gỡ khỏi hợp đồng,
 * KHÔNG xóa tenant/person (NFR-016: không xóa cứng hồ sơ).
 */
router.delete('/:id/occupants/:tenant_id', authenticateToken, requireRole(['MANAGER']), async (req, res) => {
  const { id, tenant_id } = req.params;
  const access = await checkContractAccess(req, id);
  if (!access.ok) {
    return res.status(access.status).json(access.body);
  }
  const { client, release } = await getUserClient(req);
  try {
    await client.query('BEGIN');

    const linkRes = await client.query(
      'SELECT 1 FROM contract_occupant WHERE contract_id = $1 AND tenant_id = $2',
      [id, tenant_id]
    );
    if (linkRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ code: 'NOT_FOUND', message: 'Người này không thuộc hợp đồng.' });
    }

    await client.query('DELETE FROM contract_occupant WHERE contract_id = $1 AND tenant_id = $2', [id, tenant_id]);
    await client.query(
      `INSERT INTO audit_log (actor_id, action, entity, entity_id, after)
       VALUES ($1, 'DELETE', 'contract_occupant', $2, $3)`,
      [req.user.sub, id, JSON.stringify({ contract_id: id, tenant_id })]
    );

    await client.query('COMMIT');
    res.json({ message: 'Đã gỡ thành viên khỏi hợp đồng. Hồ sơ cư dân được giữ nguyên.' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[Remove Occupant Error]:', err);
    res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi máy chủ khi gỡ thành viên.' });
  } finally {
    await release();
  }
});

/**
 * PATCH /api/v1/contracts/:id — sửa hợp đồng nháp (A3, PRD 490: MANAGER C/R/U khi DRAFT,
 * sau ACTIVE chỉ sửa qua phụ lục)
 */
router.patch('/:id', authenticateToken, requireRole(['MANAGER']), async (req, res) => {
  const { id } = req.params;
  const {
    start_date, end_date, rent_amount, billing_cycle, billing_day,
    deposit_amount, deposit_months, apartment_id, primary_tenant_id, note,
  } = req.body;

  const access = await checkContractAccess(req, id);
  if (!access.ok) {
    return res.status(access.status).json(access.body);
  }

  const { client, release } = await getUserClient(req);
  try {
    await client.query('BEGIN');

    const curRes = await client.query('SELECT * FROM contract WHERE id = $1', [id]);
    if (curRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy hợp đồng.' });
    }
    const cur = curRes.rows[0];

    if (cur.status !== 'DRAFT') {
      await client.query('ROLLBACK');
      return res.status(409).json({
        code: 'CONTRACT_NOT_EDITABLE',
        message: `Hợp đồng ở trạng thái ${cur.status} không được sửa trực tiếp. Sau ACTIVE yêu cầu thay đổi qua phụ lục hợp đồng.`,
      });
    }

    const nextApartment = apartment_id ?? cur.apartment_id;
    const nextStart = start_date ?? cur.start_date;
    const nextEnd = end_date ?? cur.end_date;
    const s = new Date(nextStart);
    const e = new Date(nextEnd);
    if (e <= s) {
      await client.query('ROLLBACK');
      return res.status(422).json({ code: 'INVALID_DATE_RANGE', message: 'Ngày kết thúc hợp đồng phải sau ngày bắt đầu hợp đồng.' });
    }

    // Đổi dates hoặc căn → chạy lại guard căn + chồng lấn
    if (apartment_id !== undefined || start_date !== undefined || end_date !== undefined) {
      const aptCheck = await client.query(`SELECT status, building_id FROM apartment WHERE id = $1`, [nextApartment]);
      if (aptCheck.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy căn hộ.' });
      }

      // Guard đổi căn hộ chéo tòa (Lưu ý 4):
      if (aptCheck.rows[0].building_id !== cur.building_id) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          code: 'CANNOT_CHANGE_BUILDING',
          message: 'Không thể chuyển căn hộ sang tòa nhà khác trên cùng hợp đồng nháp.',
        });
      }

      const todayRes = await client.query('SELECT CURRENT_DATE::text AS today');
      const todayStr = todayRes.rows[0].today;
      const nextStartStr = nextStart instanceof Date ? nextStart.toISOString().slice(0, 10) : String(nextStart).slice(0, 10);
      const isFutureContract = nextStartStr > todayStr;

      if (aptCheck.rows[0].status === 'INACTIVE') {
        await client.query('ROLLBACK');
        return res.status(409).json({
          code: 'INVALID_APARTMENT_STATUS',
          message: 'Căn hộ đang ngừng khai thác (INACTIVE), không thể gán cho hợp đồng.',
        });
      }

      if (!isFutureContract && !['AVAILABLE', 'RESERVED'].includes(aptCheck.rows[0].status)) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          code: 'INVALID_APARTMENT_STATUS',
          message: `Căn hộ đang ở trạng thái ${aptCheck.rows[0].status}, hợp đồng bắt đầu ngay chỉ gán được trên căn AVAILABLE hoặc RESERVED.`,
        });
      }
      const overlap = await client.query(
        `SELECT 1 FROM contract
         WHERE apartment_id = $1 AND id <> $2
           AND status IN ('DRAFT', 'PENDING_APPROVAL', 'ACTIVE', 'RENEWAL_PENDING')
           AND (start_date < $4 AND end_date > $3)`,
        [nextApartment, id, nextStart, nextEnd]
      );
      if (overlap.rows.length > 0) {
        await client.query('ROLLBACK');
        return res.status(409).json({ code: 'OVERLAP_CONTRACT', message: 'Căn hộ đã có hợp đồng trong khoảng thời gian đã chọn.' });
      }
    }

    if (primary_tenant_id) {
      if (!UUID_REGEX.test(String(primary_tenant_id))) {
        await client.query('ROLLBACK');
        return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy hồ sơ cư dân.' });
      }
      const tMeta = await adminPool.query(
        'SELECT id, person_id, status FROM tenant WHERE id = $1 AND org_id = $2 LIMIT 1',
        [primary_tenant_id, req.user.org_id]
      );
      if (tMeta.rows.length === 0 || ['MERGED', 'REJECTED'].includes(tMeta.rows[0].status)) {
        await client.query('ROLLBACK');
        return res.status(404).json({ code: 'NOT_FOUND', message: 'Hồ sơ cư dân không tồn tại hoặc không hợp lệ.' });
      }
      if (await isInternalPerson(tMeta.rows[0].person_id, req.user.org_id)) {
        await client.query('ROLLBACK');
        return res.status(403).json({ code: 'INVALID_TENANT_PROFILE', message: 'Không thể gắn tài khoản nhân sự nội bộ làm khách thuê.' });
      }
    }

    // Tính lại tiền cọc nếu đổi deposit
    let nextDeposit = cur.deposit_amount;
    if (deposit_amount !== undefined && deposit_amount !== null) {
      nextDeposit = Number(deposit_amount);
    } else if (deposit_months) {
      nextDeposit = Number(rent_amount ?? cur.rent_amount) * Number(deposit_months);
    }

    const updated = await client.query(
      `UPDATE contract
       SET start_date = $1, end_date = $2,
           rent_amount = COALESCE($3, rent_amount),
           billing_cycle = COALESCE($4, billing_cycle),
           billing_day = COALESCE($5, billing_day),
           deposit_amount = $6,
           apartment_id = $7,
           primary_tenant_id = COALESCE($8, primary_tenant_id),
           note = COALESCE($9, note),
           updated_at = NOW()
       WHERE id = $10 RETURNING *`,
      [
        nextStart, nextEnd,
        rent_amount ?? null, billing_cycle ?? null, billing_day ?? null,
        nextDeposit, nextApartment, primary_tenant_id ?? null, note ?? null, id,
      ]
    );

    await client.query(
      `INSERT INTO audit_log (actor_id, action, entity, entity_id, before, after)
       VALUES ($1, 'UPDATE', 'contract', $2, $3, $4)`,
      [req.user.sub, id, JSON.stringify(cur), JSON.stringify(updated.rows[0])]
    );

    await client.query('COMMIT');
    res.json({ message: 'Cập nhật hợp đồng nháp thành công.', data: updated.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    const mapped = mapPgError(err);
    if (mapped) {
      return res.status(mapped.status).json({ code: mapped.code, message: mapped.message });
    }
    console.error('[Update Draft Contract Error]:', err);
    res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi máy chủ khi cập nhật hợp đồng.' });
  } finally {
    await release();
  }
});

/**
 * POST /api/v1/contracts/:id/terminate
 * Chấm dứt hợp đồng thuê trực tiếp trong 1 bước bởi bộ máy vận hành nội bộ (FR-017, FR-068, Mục 6.2 — OWNER 100% Read-Only)
 * Quyền: MANAGER (trên tòa được gán) hoặc SYS_ADMIN. Bắt buộc lý do + ghi audit_log bất biến.
 * Hỗ trợ:
 *   - Đã vào ở (today >= start_date): start_date <= termDate <= end_date -> căn hộ sang MAINTENANCE chờ nghiệm thu.
 *   - Thanh lý sớm trước ngày nhận phòng (today < start_date): today <= termDate <= end_date -> bỏ qua MAINTENANCE,
 *     đồng bộ lại trạng thái căn hộ ngay (AVAILABLE / RESERVED / OCCUPIED).
 */
router.post('/:id/terminate', authenticateToken, requireRole(['SYS_ADMIN', 'MANAGER']), async (req, res) => {
  const { id } = req.params;
  const { terminated_date, reason, note } = req.body;
  const cleanReason = String(reason || note || '').trim();

  if (!cleanReason) {
    return res.status(400).json({
      code: 'REASON_REQUIRED',
      message: 'Vui lòng cung cấp lý do chấm dứt hợp đồng để lưu vết kiểm toán (FR-017).',
    });
  }

  const access = await checkContractAccess(req, id);
  if (!access.ok) {
    return res.status(access.status).json(access.body);
  }

  const { client, release } = await getUserClient(req);
  try {
    await client.query('BEGIN');

    const contractCheck = await client.query('SELECT * FROM contract WHERE id = $1 FOR UPDATE', [id]);
    if (contractCheck.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy hợp đồng.' });
    }

    const currentContract = contractCheck.rows[0];

    if (!['ACTIVE', 'TERMINATION_PENDING'].includes(currentContract.status)) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        code: 'INVALID_STATUS',
        message: `Hợp đồng đang ở trạng thái ${currentContract.status}, chỉ hợp đồng ACTIVE mới có thể chấm dứt.`,
      });
    }

    const todayRes = await client.query('SELECT CURRENT_DATE::text AS today');
    const todayStr = todayRes.rows[0].today;
    const termDate = terminated_date ? String(terminated_date).slice(0, 10) : todayStr;
    const sDate = currentContract.start_date.toISOString
      ? currentContract.start_date.toISOString().split('T')[0]
      : String(currentContract.start_date).slice(0, 10);
    const eDate = currentContract.end_date.toISOString
      ? currentContract.end_date.toISOString().split('T')[0]
      : String(currentContract.end_date).slice(0, 10);

    const isPreMoveInWindow = todayStr < sDate;
    const minAllowedDate = isPreMoveInWindow ? todayStr : sDate;

    if (termDate < minAllowedDate || termDate > eDate) {
      await client.query('ROLLBACK');
      return res.status(422).json({
        code: 'INVALID_TERMINATION_DATE',
        message: isPreMoveInWindow
          ? `Hợp đồng chưa tới ngày nhận phòng (${sDate}). Ngày thanh lý phải từ hôm nay (${todayStr}) đến hết ngày kết thúc (${eDate}).`
          : `Ngày chấm dứt phải nằm trong kỳ hạn hợp đồng (${sDate} – ${eDate}).`,
      });
    }

    const movedIn = sDate <= todayStr && termDate >= sDate;
    const tagPrefix = movedIn ? 'Chấm dứt hợp đồng' : 'Thanh lý trước ngày nhận phòng';
    const extraDetail = reason && note && String(reason).trim() !== String(note).trim()
      ? `${String(reason).trim()} - ${String(note).trim()}`
      : cleanReason;
    const reasonSuffix = `[${tagPrefix}: ${extraDetail}]`;
    const newNote = `${currentContract.note || ''} ${reasonSuffix}`.trim();

    // 1. Chuyển hợp đồng trực tiếp sang TERMINATED, ghi mốc ngày terminated_at
    const updatedRes = await client.query(
      `UPDATE contract
       SET status = 'TERMINATED', terminated_at = $1, note = $2, updated_at = NOW()
       WHERE id = $3 RETURNING *`,
      [termDate, newNote, id]
    );

    // 2. Đồng bộ trạng thái căn hộ:
    //    - Nếu khách đã nhận phòng -> MAINTENANCE chờ nghiệm thu.
    //    - Nếu thanh lý trước ngày nhận phòng -> giữ OCCUPIED (nếu có khách hiện tại) hoặc trả về AVAILABLE/RESERVED.
    const nextApartmentStatus = await syncApartmentStatus(client, currentContract.apartment_id, {
      enterMaintenance: movedIn,
    });

    // 3. Thiết lập hạn hoàn cọc +5 ngày (FR-068) trên sổ cọc đang HELD
    const { dueAt } = refundDeadline(termDate);
    await client.query(
      `UPDATE deposit SET refund_due_date = $1, updated_at = NOW()
       WHERE contract_id = $2 AND status = 'HELD'`,
      [dueAt, id]
    );

    // 4. Ghi audit log bất biến
    await client.query(
      `INSERT INTO audit_log (actor_id, action, entity, entity_id, before, after)
       VALUES ($1, 'TERMINATE', 'contract', $2, $3, $4)`,
      [
        req.user.sub,
        id,
        JSON.stringify(currentContract),
        JSON.stringify({
          ...updatedRes.rows[0],
          pre_move_in: !movedIn,
          apartment_status_after: nextApartmentStatus,
          refund_due_date: dueAt,
        }),
      ]
    );

    // 5. Gửi thông báo cho Cư dân
    const tenantUserRes = await adminPool.query(
      `SELECT u.id AS user_id FROM app_user u
       JOIN person p ON p.id = u.person_id
       JOIN tenant t ON t.person_id = p.id
       WHERE t.id = $1 LIMIT 1`,
      [currentContract.primary_tenant_id]
    );
    if (tenantUserRes.rows.length > 0) {
      await client.query(
        `INSERT INTO notification (org_id, user_id, title, content, type, payload)
         VALUES ((SELECT org_id FROM building WHERE id = $1), $2, $3, $4, 'CONTRACT_TERMINATED', $5)`,
        [
          currentContract.building_id,
          tenantUserRes.rows[0].user_id,
          movedIn ? 'Hợp đồng thuê đã được chấm dứt' : 'Hợp đồng tương lai đã được thanh lý sớm',
          movedIn
            ? `Hợp đồng thuê căn hộ của bạn đã chấm dứt từ ngày ${termDate}. BQL sẽ nghiệm thu căn hộ và thực hiện tất toán tiền cọc trong vòng 5 ngày.`
            : `Hợp đồng thuê tương lai của bạn đã được thanh lý trước ngày nhận phòng (ngày ghi nhận: ${termDate}). Sổ cọc sẽ được xử lý tất toán trong vòng 5 ngày.`,
          JSON.stringify({ contract_id: id, link: '/resident' }),
        ]
      );
    }

    await client.query('COMMIT');
    res.json({
      message: movedIn
        ? 'Đã chấm dứt hợp đồng thành công. Căn hộ chuyển sang bảo trì nghiệm thu và hạn hoàn cọc (+5 ngày) đã được mở.'
        : 'Đã thanh lý hợp đồng trước ngày nhận phòng. Sổ cọc đã mở hạn tất toán (+5 ngày) và trạng thái căn hộ được giữ chuẩn xác.',
      data: updatedRes.rows[0],
      apartment_status: nextApartmentStatus,
      refund_due_date: dueAt,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[Terminate Contract Error]:', err);
    res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi khi chấm dứt hợp đồng.' });
  } finally {
    await release();
  }
});

/**
 * POST /api/v1/contracts/:id/terminate/approve
 * Tương thích ngược cho bản ghi TERMINATION_PENDING cũ (nếu có) — chỉ nội bộ SYS_ADMIN / MANAGER (Four-eyes), gỡ OWNER
 */
router.post('/:id/terminate/approve', authenticateToken, requireRole(['SYS_ADMIN', 'MANAGER']), async (req, res) => {
  const { id } = req.params;
  const access = await checkContractAccess(req, id);
  if (!access.ok) {
    return res.status(access.status).json(access.body);
  }

  const { client, release } = await getUserClient(req);

  try {
    await client.query('BEGIN');

    const contractCheck = await client.query('SELECT * FROM contract WHERE id = $1 FOR UPDATE', [id]);
    if (contractCheck.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy hợp đồng.' });
    }

    const currentContract = contractCheck.rows[0];
    if (currentContract.status !== 'TERMINATION_PENDING') {
      await client.query('ROLLBACK');
      return res.status(409).json({
        code: 'INVALID_STATUS',
        message: `Hợp đồng đang ở trạng thái ${currentContract.status}. Chỉ hợp đồng TERMINATION_PENDING mới có thể duyệt chấm dứt.`,
      });
    }

    // Four-eyes: kiểm tra người đề xuất trong audit_log (Lỗi 1 Fix)
    const lastReq = await client.query(
      `SELECT actor_id FROM audit_log
       WHERE action = 'TERMINATE_REQUEST' AND entity = 'contract' AND entity_id = $1
       ORDER BY at DESC LIMIT 1`,
      [id]
    );
    if (lastReq.rows.length > 0 && lastReq.rows[0].actor_id === req.user.sub) {
      await client.query('ROLLBACK');
      return res.status(403).json({
        code: 'SELF_APPROVAL',
        message: 'Người đề xuất chấm dứt hợp đồng không được tự phê duyệt (Nguyên tắc Four-eyes).',
      });
    }

    // 1. Chuyển hợp đồng sang TERMINATED
    const updatedRes = await client.query(
      `UPDATE contract SET status = 'TERMINATED', updated_at = NOW() WHERE id = $1 RETURNING *`,
      [id]
    );

    // 2. Đồng bộ trạng thái căn hộ theo thời điểm bắt đầu thực tế
    const todayRes = await client.query('SELECT CURRENT_DATE::text AS today');
    const todayStr = todayRes.rows[0].today;
    const sDate = currentContract.start_date.toISOString
      ? currentContract.start_date.toISOString().split('T')[0]
      : String(currentContract.start_date).slice(0, 10);
    const termAt = currentContract.terminated_at
      ? (currentContract.terminated_at.toISOString ? currentContract.terminated_at.toISOString().split('T')[0] : String(currentContract.terminated_at).slice(0, 10))
      : todayStr;
    await syncApartmentStatus(client, currentContract.apartment_id, {
      enterMaintenance: sDate <= todayStr && termAt >= sDate,
    });

    // 3. Gán hạn hoàn cọc (refund_due_date = ngày chấm dứt + 5 ngày theo FR-068) trên sổ cọc
    const { dueAt } = refundDeadline(termAt);

    await client.query(
      `UPDATE deposit SET refund_due_date = $1, updated_at = NOW()
       WHERE contract_id = $2 AND status = 'HELD'`,
      [dueAt, id]
    );

    // 4. Ghi audit log
    await client.query(
      `INSERT INTO audit_log (actor_id, action, entity, entity_id, before, after)
       VALUES ($1, 'TERMINATE_APPROVE', 'contract', $2, $3, $4)`,
      [req.user.sub, id, JSON.stringify(currentContract), JSON.stringify(updatedRes.rows[0])]
    );

    // 5. Gửi thông báo cho Cư dân
    const tenantUserRes = await client.query(
      `SELECT u.id AS user_id FROM app_user u
       JOIN person p ON p.id = u.person_id
       JOIN tenant t ON t.person_id = p.id
       WHERE t.id = $1`,
      [currentContract.primary_tenant_id]
    );
    if (tenantUserRes.rows.length > 0) {
      await client.query(
        `INSERT INTO notification (org_id, user_id, title, content, type, payload)
         VALUES ((SELECT org_id FROM building WHERE id = $1), $2, $3, $4, 'CONTRACT_TERMINATED', $5)`,
        [
          currentContract.building_id,
          tenantUserRes.rows[0].user_id,
          'Hợp đồng thuê đã được phê duyệt chấm dứt',
          `Hợp đồng thuê căn hộ của bạn đã được phê duyệt chấm dứt (ngày kết thúc: ${termAt}). BQL sẽ tiến hành kiểm tra căn hộ và hoàn tất thủ tục tất toán cọc trong 3-5 ngày.`,
          JSON.stringify({ contract_id: id, link: '/resident' }),
        ]
      );
    }

    await client.query('COMMIT');
    res.json({
      message: 'Phê duyệt chấm dứt hợp đồng thành công. Căn hộ chuyển sang bảo trì và hạn hoàn cọc đã được thiết lập.',
      data: updatedRes.rows[0],
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[Approve Terminate Error]:', err);
    res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi khi phê duyệt chấm dứt hợp đồng.' });
  } finally {
    await release();
  }
});

/**
 * POST /api/v1/contracts/:id/terminate/reject
 * Từ chối đề xuất chấm dứt hợp đồng (quay lại ACTIVE) — nội bộ SYS_ADMIN / MANAGER (gỡ OWNER)
 */
router.post('/:id/terminate/reject', authenticateToken, requireRole(['SYS_ADMIN', 'MANAGER']), async (req, res) => {
  const { id } = req.params;
  const { reason } = req.body;

  if (!reason || !reason.trim()) {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Lý do từ chối là bắt buộc.' });
  }

  const access = await checkContractAccess(req, id);
  if (!access.ok) {
    return res.status(access.status).json(access.body);
  }

  const { client, release } = await getUserClient(req);
  try {
    await client.query('BEGIN');

    const contractCheck = await client.query('SELECT * FROM contract WHERE id = $1 FOR UPDATE', [id]);
    if (contractCheck.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy hợp đồng.' });
    }

    const currentContract = contractCheck.rows[0];
    if (currentContract.status !== 'TERMINATION_PENDING') {
      await client.query('ROLLBACK');
      return res.status(409).json({
        code: 'INVALID_STATUS',
        message: `Hợp đồng đang ở trạng thái ${currentContract.status}. Chỉ hợp đồng TERMINATION_PENDING mới có thể từ chối.`,
      });
    }

    const rejectNote = `[Từ chối chấm dứt: ${reason.trim()}]`;
    const updatedRes = await client.query(
      `UPDATE contract
       SET status = 'ACTIVE', terminated_at = NULL,
           note = COALESCE(note || ' ', '') || $1, updated_at = NOW()
       WHERE id = $2 RETURNING *`,
      [rejectNote, id]
    );

    await client.query(
      `INSERT INTO audit_log (actor_id, action, entity, entity_id, before, after)
       VALUES ($1, 'TERMINATE_REJECT', 'contract', $2, $3, $4)`,
      [req.user.sub, id, JSON.stringify(currentContract), JSON.stringify(updatedRes.rows[0])]
    );

    await client.query('COMMIT');
    res.json({
      message: 'Đã từ chối đề xuất chấm dứt hợp đồng. Hợp đồng trở lại trạng thái ACTIVE.',
      data: updatedRes.rows[0],
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[Reject Terminate Error]:', err);
    res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi khi từ chối đề xuất chấm dứt hợp đồng.' });
  } finally {
    await release();
  }
});

/**
 * Helper hoàn tất kích hoạt (dùng chung /activate và /approve) — A3 phần 2, A5.
 * Điều kiện chặn ACTIVE (PRD 486, AC-009.2): căn AVAILABLE/RESERVED, không chồng lấn,
 * đủ giấy tờ (CCCD) bên thuê chính. Giá lệch ≥10% so giá niêm yết → PENDING_APPROVAL.
 */
async function completeActivation(client, contract, res, req, { skipPriceCheck = false } = {}) {
  // 1. Kiểm tra trạng thái căn hộ (hợp đồng bắt đầu ngay đòi AVAILABLE/RESERVED; hợp đồng tương lai cho phép nối tiếp trên OCCUPIED/MAINTENANCE)
  const aptRes = await client.query(
    `SELECT a.status, a.base_rent, b.id AS building_id, CURRENT_DATE::text AS today
     FROM apartment a JOIN building b ON b.id = a.building_id
     WHERE a.id = $1`,
    [contract.apartment_id]
  );
  const apt = aptRes.rows[0];
  const sDateStr = contract.start_date.toISOString
    ? contract.start_date.toISOString().split('T')[0]
    : String(contract.start_date).slice(0, 10);
  const isFutureContract = sDateStr > apt.today;

  if (apt.status === 'INACTIVE') {
    return { error: { status: 409, code: 'INVALID_APARTMENT_STATUS', message: 'Căn hộ đang ngừng khai thác (INACTIVE), không thể kích hoạt hợp đồng.' } };
  }
  if (!isFutureContract && ['AVAILABLE', 'RESERVED'].indexOf(apt.status) === -1) {
    return { error: { status: 409, code: 'INVALID_APARTMENT_STATUS', message: `Căn hộ đang ở trạng thái ${apt.status}, không thể kích hoạt hợp đồng bắt đầu ngay.` } };
  }

  // 2. Chồng lấn kỳ hạn (re-check tại thời điểm ACTIVE; DB constraint ghim các HĐ hiệu lực)
  const overlapRes = await client.query(
    `SELECT c.id, c.start_date, c.end_date
     FROM contract c
     WHERE c.apartment_id = $1 AND c.id <> $2
       AND c.status IN ('DRAFT', 'PENDING_APPROVAL', 'ACTIVE', 'RENEWAL_PENDING')
       AND (c.start_date < $4 AND c.end_date > $3)`,
    [contract.apartment_id, contract.id, contract.start_date, contract.end_date]
  );
  if (overlapRes.rows.length > 0) {
    return { error: { status: 409, code: 'OVERLAP_CONTRACT', message: 'Căn hộ đã có hợp đồng trong khoảng thời gian này.', conflicts: overlapRes.rows } };
  }

  // 3. Giá lệch khung → PENDING_APPROVAL, chờ chủ đầu tư duyệt
  // Lượt /approve đã là quyết định duyệt — bỏ qua check giá (skipPriceCheck).
  if (!skipPriceCheck && isDiscountedPrice(contract.rent_amount, apt.base_rent)) {
    const pendingRes = await client.query(
      `UPDATE contract SET status = 'PENDING_APPROVAL', updated_at = NOW() WHERE id = $1 RETURNING *`,
      [contract.id]
    );
    await client.query(
      `INSERT INTO audit_log (actor_id, action, entity, entity_id, before, after)
       VALUES ($1, 'SUBMIT_APPROVAL', 'contract', $2, $3, $4)`,
      [req.user.sub, contract.id, JSON.stringify(contract), JSON.stringify(pendingRes.rows[0])]
    );
    // KHÔNG rollback ở caller — giữ PENDING_APPROVAL đã ghi (nhánh này phải COMMIT)
    return { needsApproval: pendingRes.rows[0] };
  }

  // 4. ACTIVE + chuyển cọc giữ chỗ / kết chuyển cọc gia hạn thành cọc hợp đồng (FR-067, R-03, R-19)
  const activeRes = await client.query(
    `UPDATE contract SET status = 'ACTIVE', updated_at = NOW() WHERE id = $1 RETURNING *`,
    [contract.id]
  );

  let preferredRsvId = req.body?.reservation_id || null;
  if (!preferredRsvId) {
    const createAudit = await adminPool.query(
      `SELECT after->>'reservation_id' AS reservation_id
       FROM audit_log
       WHERE entity = 'contract' AND entity_id = $1 AND action = 'CREATE'
       ORDER BY at DESC LIMIT 1`,
      [contract.id]
    );
    preferredRsvId = createAudit.rows[0]?.reservation_id || null;
  }

  let matchedRsv = null;
  if (preferredRsvId) {
    const rsvById = await client.query(
      `SELECT id, hold_amount FROM reservation
       WHERE id = $1 AND apartment_id = $2 AND status = 'HELD'
       LIMIT 1`,
      [preferredRsvId, contract.apartment_id]
    );
    matchedRsv = rsvById.rows[0] || null;
  } else if (contract.tenant_phone) {
    const startStr = contract.start_date?.toISOString
      ? contract.start_date.toISOString().slice(0, 10)
      : String(contract.start_date).slice(0, 10);
    const rsvByPhone = await client.query(
      `SELECT id, hold_amount FROM reservation
       WHERE apartment_id = $1
         AND status = 'HELD'
         AND regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g') = regexp_replace($2, '[^0-9]', '', 'g')
       ORDER BY
         CASE WHEN COALESCE(hold_from, created_at::date) <= $3::date AND hold_until >= $3::date THEN 0 ELSE 1 END,
         created_at DESC
       LIMIT 1`,
      [contract.apartment_id, String(contract.tenant_phone), startStr]
    );
    matchedRsv = rsvByPhone.rows[0] || null;
  }

  let parentDep = null;
  if (!matchedRsv && contract.parent_contract_id) {
    const pDepRes = await client.query(
      `SELECT * FROM deposit WHERE contract_id = $1 AND status = 'HELD' AND amount_held > 0 FOR UPDATE`,
      [contract.parent_contract_id]
    );
    parentDep = pDepRes.rows[0] || null;
  }

  const opensDeposit = Number(contract.deposit_amount) > 0 || Boolean(matchedRsv) || Boolean(parentDep);
  let remainingCollect = 0n;

  if (opensDeposit) {
    const existing = await client.query(`SELECT id FROM deposit WHERE contract_id = $1`, [contract.id]);
    if (existing.rows.length === 0) {
      if (parentDep) {
        const parentHeld = BigInt(parentDep.amount_held);
        const split = splitDepositOpening({
          depositAmount: contract.deposit_amount,
          holdAmount: parentHeld,
        });
        remainingCollect = split.remainingCollect;

        await client.query(
          `UPDATE deposit SET amount_held = 0, status = 'TRANSFERRED', updated_at = NOW() WHERE id = $1`,
          [parentDep.id]
        );
        await client.query(
          `INSERT INTO deposit_transaction (
             deposit_id, type, amount, description, method, status, approved_by, approved_at, created_by
           )
           VALUES ($1, 'transfer', $2, $3, 'TRANSFER', 'APPROVED', $4, NOW(), $4)`,
          [
            parentDep.id,
            parentHeld.toString(),
            `Chuyển kết dư tiền cọc sang hợp đồng gia hạn ${contract.id.slice(0, 8).toUpperCase()}`,
            req.user.sub,
          ]
        );

        const depRes = await client.query(
          `INSERT INTO deposit (contract_id, source_reservation_id, amount_held, status)
           VALUES ($1, NULL, $2, 'HELD')
           RETURNING id`,
          [contract.id, parentHeld.toString()]
        );
        await client.query(
          `INSERT INTO deposit_transaction (
             deposit_id, type, amount, description, method, status, approved_by, approved_at, created_by
           )
           VALUES ($1, 'transfer', $2, $3, 'TRANSFER', 'APPROVED', $4, NOW(), $4)`,
          [
            depRes.rows[0].id,
            parentHeld.toString(),
            `Nhận kết chuyển tiền cọc từ hợp đồng kỳ trước ${contract.parent_contract_id.slice(0, 8).toUpperCase()}`,
            req.user.sub,
          ]
        );
      } else {
        const holdAmount = matchedRsv ? matchedRsv.hold_amount : null;
        const split = splitDepositOpening({
          depositAmount: contract.deposit_amount,
          holdAmount,
        });
        remainingCollect = split.remainingCollect;

        const depRes = await client.query(
          `INSERT INTO deposit (contract_id, source_reservation_id, amount_held, status)
           VALUES ($1, $2, $3, 'HELD')
           RETURNING id`,
          [contract.id, matchedRsv?.id ?? null, split.openHeld.toString()]
        );

        const newDepositId = depRes.rows[0].id;

        if (split.openHeld > 0n && matchedRsv) {
          await client.query(
            `INSERT INTO deposit_transaction (
               deposit_id, type, amount, description, method, status, approved_by, approved_at, created_by
             )
             VALUES ($1, 'transfer', $2, 'Chuyển cọc giữ chỗ thành cọc hợp đồng', 'TRANSFER', 'APPROVED', $3, NOW(), $3)`,
            [newDepositId, split.openHeld.toString(), req.user.sub]
          );
        }
      }
    }
    if (matchedRsv) {
      await client.query(`UPDATE reservation SET status = 'CONVERTED', updated_at = NOW() WHERE id = $1`, [matchedRsv.id]);
    }
  }

  // 5. Đồng bộ trạng thái căn hộ thông minh (giữ OCCUPIED/MAINTENANCE nếu đang có khách/bảo trì; chuyển RESERVED nếu HĐ tương lai trên căn trống; OCCUPIED nếu bắt đầu hôm nay)
  await syncApartmentStatus(client, contract.apartment_id);

  await client.query(
    `INSERT INTO audit_log (actor_id, action, entity, entity_id, before, after)
     VALUES ($1, 'ACTIVATE', 'contract', $2, $3, $4)`,
    [req.user.sub, contract.id, JSON.stringify(contract), JSON.stringify(activeRes.rows[0])]
  );

  return { contract: activeRes.rows[0], remaining_collect: Number(remainingCollect) };
}

// Guard điều kiện chung trước khi gọi completeActivation
async function assertActivatable(client, contractId) {
  const cRes = await client.query(
    `SELECT c.*, t.id AS tenant_id, t.status AS tenant_status, p.id AS person_id, p.id_number, p.phone AS tenant_phone
     FROM contract c
     JOIN tenant t ON t.id = c.primary_tenant_id
     JOIN person p ON p.id = t.person_id
     WHERE c.id = $1`,
    [contractId]
  );
  return cRes.rows[0];
}

router.post('/:id/activate', authenticateToken, requireRole(['MANAGER']), async (req, res) => {
  const { id } = req.params;
  const access = await checkContractAccess(req, id);
  if (!access.ok) {
    return res.status(access.status).json(access.body);
  }

  const { client, release } = await getUserClient(req);
  try {
    await client.query('BEGIN');
    const contract = await assertActivatable(client, id);
    if (!contract) {
      await client.query('ROLLBACK');
      return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy hợp đồng.' });
    }
    if (contract.status !== 'DRAFT') {
      await client.query('ROLLBACK');
      return res.status(409).json({
        code: 'INVALID_STATUS',
        message: `Hợp đồng đang ở trạng thái ${contract.status}. Chỉ DRAFT mới được kích hoạt; PENDING_APPROVAL chờ chủ đầu tư duyệt.`,
      });
    }
    // AC-009.2: chưa có bản scan hợp đồng đã ký → chặn và nêu điều kiện thiếu
    const scanRes = await client.query(
      `SELECT 1 FROM attachment WHERE owner_entity = 'contract' AND owner_id = $1`,
      [id]
    );
    if (scanRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        code: 'MISSING_SIGNED_SCAN',
        message: 'Chưa đính kèm bản scan hợp đồng đã ký. Tải bản ký, scan rồi dùng "Đính kèm bản ký" trước khi kích hoạt.',
      });
    }
    // PRD 486: thiếu giấy tờ tùy thân → cho lưu DRAFT nhưng chặn ACTIVE
    if (!contract.id_number) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        code: 'MISSING_IDENTITY_PAPER',
        message: 'Thiếu thông tin CCCD/hộ chiếu của khách thuê chính. Cập nhật hồ sơ khách thuê trước khi kích hoạt.',
      });
    }
    // C3 / PRD 484: cư dân đại diện đã có hồ sơ APPROVED
    if (contract.tenant_status !== 'APPROVED') {
      await client.query('ROLLBACK');
      return res.status(409).json({
        code: 'TENANT_NOT_APPROVED',
        message: 'Khách thuê chính chưa được phê duyệt hồ sơ (yêu cầu trạng thái APPROVED). Vui lòng cập nhật và duyệt hồ sơ trước khi kích hoạt.',
      });
    }
    const result = await completeActivation(client, contract, res, req);
    if (result.needsApproval) {
      await client.query('COMMIT');
      return res.status(409).json({
        code: 'PRICE_NEEDS_APPROVAL',
        message: 'Giá thuê thấp hơn 10% so với giá niêm yết, hợp đồng chuyển sang chờ phê duyệt nội bộ (PENDING_APPROVAL — Quản lý khác hoặc SYS_ADMIN).',
        data: result.needsApproval,
      });
    }
    if (result.error) {
      await client.query('ROLLBACK');
      return res.status(result.error.status).json({
        code: result.error.code,
        message: result.error.message,
        conflicts: result.error.conflicts,
      });
    }
    await client.query('COMMIT');
    const msg = result.remaining_collect > 0
      ? `Kích hoạt hợp đồng thành công. Sổ cọc đã mở theo tiền thực giữ. Cần thu bổ sung ${result.remaining_collect.toLocaleString('vi-VN')} ₫ qua Sổ cọc.`
      : 'Kích hoạt hợp đồng thành công.';
    res.json({ message: msg, data: result.contract, remaining_collect: result.remaining_collect });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[Activate Contract Error]:', err);
    res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi máy chủ khi kích hoạt hợp đồng.' });
  } finally {
    await release();
  }
});

router.post('/:id/approve', authenticateToken, requireRole(['SYS_ADMIN', 'MANAGER']), async (req, res) => {
  const { id } = req.params;
  const access = await checkContractAccess(req, id);
  if (!access.ok) {
    return res.status(access.status).json(access.body);
  }

  const { client, release } = await getUserClient(req);
  try {
    await client.query('BEGIN');
    const contract = await assertActivatable(client, id);
    if (!contract) {
      await client.query('ROLLBACK');
      return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy hợp đồng.' });
    }
    if (contract.status !== 'PENDING_APPROVAL') {
      await client.query('ROLLBACK');
      return res.status(409).json({
        code: 'INVALID_STATUS',
        message: `Hợp đồng đang ở trạng thái ${contract.status}, chỉ hợp đồng chờ phê duyệt (PENDING_APPROVAL) mới được duyệt.`,
      });
    }

    // Kiểm tra lại đầy đủ điều kiện kích hoạt trước khi duyệt (R-12)
    const scanRes = await client.query(
      `SELECT 1 FROM attachment WHERE owner_entity = 'contract' AND owner_id = $1`,
      [id]
    );
    if (scanRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        code: 'MISSING_SIGNED_SCAN',
        message: 'Chưa đính kèm bản scan hợp đồng đã ký. Vui lòng đính kèm bản ký trước khi phê duyệt kích hoạt.',
      });
    }
    if (!contract.id_number) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        code: 'MISSING_IDENTITY_PAPER',
        message: 'Thiếu thông tin CCCD/hộ chiếu của khách thuê chính.',
      });
    }
    if (contract.tenant_status !== 'APPROVED') {
      await client.query('ROLLBACK');
      return res.status(409).json({
        code: 'TENANT_NOT_APPROVED',
        message: 'Khách thuê chính chưa được phê duyệt hồ sơ (yêu cầu trạng thái APPROVED).',
      });
    }

    // Nguyên tắc Four-eyes nội bộ (R-23): kiểm tra cấu hình allow_self_approval
    const submitAudit = await adminPool.query(
      `SELECT actor_id FROM audit_log
       WHERE entity = 'contract' AND entity_id = $1 AND action = 'SUBMIT_APPROVAL'
       ORDER BY at DESC LIMIT 1`,
      [id]
    );
    const submitterId = submitAudit.rows[0]?.actor_id || null;
    const matchedCreator =
      contract.created_by && String(contract.created_by) === String(req.user.sub)
        ? contract.created_by
        : submitterId && String(submitterId) === String(req.user.sub)
          ? submitterId
          : null;

    if (matchedCreator) {
      const fourEyes = await checkFourEyesOrWarn({
        orgId: req.user.org_id,
        actorId: req.user.sub,
        creatorId: matchedCreator,
        entity: 'contract',
        entityId: id,
        actionContext: 'CONTRACT_APPROVE',
      });
      if (!fourEyes.allowed) {
        await client.query('ROLLBACK');
        return res.status(403).json({
          code: 'SELF_APPROVAL',
          message: 'Nguyên tắc Four-eyes: Người lập / trình duyệt hợp đồng lệch khung giá không được tự phê duyệt. Vui lòng chuyển Quản lý khác hoặc Ban Giám đốc (SYS_ADMIN) phê duyệt.',
        });
      }
    }

    const result = await completeActivation(client, contract, res, req, { skipPriceCheck: true });
    if (result.needsApproval) {
      await client.query('COMMIT');
      return res.status(409).json({
        code: 'PRICE_NEEDS_APPROVAL',
        message: 'Giá vẫn thấp hơn khung cho phép, hợp đồng giữ trạng thái chờ phê duyệt.',
        data: result.needsApproval,
      });
    }
    if (result.error) {
      await client.query('ROLLBACK');
      return res.status(result.error.status).json({ code: result.error.code, message: result.error.message, conflicts: result.error.conflicts });
    }
    await client.query('COMMIT');
    const approveMsg = result.remaining_collect > 0
      ? `Đã phê duyệt và kích hoạt hợp đồng thành công. Sổ cọc đã mở theo tiền thực giữ. Cần thu bổ sung ${result.remaining_collect.toLocaleString('vi-VN')} ₫ qua Sổ cọc.`
      : 'Đã phê duyệt và kích hoạt hợp đồng thành công.';
    res.json({ message: approveMsg, data: result.contract, remaining_collect: result.remaining_collect });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[Approve Contract Error]:', err);
    res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi máy chủ khi phê duyệt hợp đồng.' });
  } finally {
    await release();
  }
});

/**
 * POST /api/v1/contracts/:id/reject — Từ chối phê duyệt hợp đồng lệch khung giá, trả về DRAFT để chỉnh sửa (R-12)
 */
router.post('/:id/reject', authenticateToken, requireRole(['SYS_ADMIN', 'MANAGER']), async (req, res) => {
  const { id } = req.params;
  const { reason } = req.body;
  if (!reason || !String(reason).trim()) {
    return res.status(400).json({ code: 'REASON_REQUIRED', message: 'Vui lòng cung cấp lý do từ chối phê duyệt hợp đồng.' });
  }

  const access = await checkContractAccess(req, id);
  if (!access.ok) {
    return res.status(access.status).json(access.body);
  }

  const { client, release } = await getUserClient(req);
  try {
    await client.query('BEGIN');
    const curRes = await client.query('SELECT * FROM contract WHERE id = $1 FOR UPDATE', [id]);
    if (curRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy hợp đồng.' });
    }
    const cur = curRes.rows[0];
    if (cur.status !== 'PENDING_APPROVAL') {
      await client.query('ROLLBACK');
      return res.status(409).json({
        code: 'INVALID_STATUS',
        message: `Hợp đồng đang ở trạng thái ${cur.status}. Chỉ hợp đồng PENDING_APPROVAL mới được từ chối phê duyệt để trả về DRAFT.`,
      });
    }

    const submitAudit = await adminPool.query(
      `SELECT actor_id FROM audit_log
       WHERE entity = 'contract' AND entity_id = $1 AND action = 'SUBMIT_APPROVAL'
       ORDER BY at DESC LIMIT 1`,
      [id]
    );
    const submitterId = submitAudit.rows[0]?.actor_id || null;
    const matchedCreator =
      cur.created_by && String(cur.created_by) === String(req.user.sub)
        ? cur.created_by
        : submitterId && String(submitterId) === String(req.user.sub)
          ? submitterId
          : null;

    if (matchedCreator) {
      const fourEyes = await checkFourEyesOrWarn({
        orgId: req.user.org_id,
        actorId: req.user.sub,
        creatorId: matchedCreator,
        entity: 'contract',
        entityId: id,
        actionContext: 'CONTRACT_REJECT',
      });
      if (!fourEyes.allowed) {
        await client.query('ROLLBACK');
        return res.status(403).json({
          code: 'SELF_APPROVAL',
          message: 'Nguyên tắc Four-eyes: Người lập / trình duyệt hợp đồng không được tự phê duyệt hoặc từ chối phê duyệt.',
        });
      }
    }

    const trimmedReason = String(reason).trim();
    const updatedNote = `${cur.note || ''} [Từ chối duyệt giá: ${trimmedReason}]`.trim();
    const updated = await client.query(
      `UPDATE contract SET status = 'DRAFT', note = $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
      [updatedNote, id]
    );
    await client.query(
      `INSERT INTO audit_log (actor_id, action, entity, entity_id, before, after)
       VALUES ($1, 'REJECT_APPROVAL', 'contract', $2, $3, $4)`,
      [
        req.user.sub,
        id,
        JSON.stringify(cur),
        JSON.stringify({ ...updated.rows[0], rejection_reason: trimmedReason }),
      ]
    );
    await client.query('COMMIT');
    res.json({
      message: 'Đã từ chối phê duyệt và trả hợp đồng về trạng thái bản nháp (DRAFT) để điều chỉnh.',
      data: updated.rows[0],
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[Reject Contract Approval Error]:', err);
    res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi máy chủ khi từ chối phê duyệt hợp đồng.' });
  } finally {
    await release();
  }
});

router.post('/:id/cancel', authenticateToken, requireRole(['MANAGER']), async (req, res) => {
  const { id } = req.params;
  const { reason } = req.body;
  const access = await checkContractAccess(req, id);
  if (!access.ok) {
    return res.status(access.status).json(access.body);
  }

  const { client, release } = await getUserClient(req);
  try {
    await client.query('BEGIN');
    const curRes = await client.query('SELECT * FROM contract WHERE id = $1 FOR UPDATE', [id]);
    if (curRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy hợp đồng.' });
    }
    const cur = curRes.rows[0];
    if (!['DRAFT', 'PENDING_APPROVAL'].includes(cur.status)) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        code: 'INVALID_STATUS',
        message: `Hợp đồng ở trạng thái ${cur.status} không thể hủy nháp. Chỉ DRAFT hoặc PENDING_APPROVAL được hủy.`,
      });
    }
    const updated = await client.query(
      `UPDATE contract SET status = 'CANCELLED', note = COALESCE($1, note), updated_at = NOW() WHERE id = $2 RETURNING *`,
      [reason ? `${cur.note || ''} [Lý do hủy: ${reason}]`.trim() : null, id]
    );
    await client.query(
      `INSERT INTO audit_log (actor_id, action, entity, entity_id, before, after)
       VALUES ($1, 'CANCEL', 'contract', $2, $3, $4)`,
      [req.user.sub, id, JSON.stringify(cur), JSON.stringify(updated.rows[0])]
    );
    await client.query('COMMIT');
    res.json({ message: 'Hủy hợp đồng nháp thành công.', data: updated.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[Cancel Contract Error]:', err);
    res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi máy chủ khi hủy hợp đồng.' });
  } finally {
    await release();
  }
});

/**
 * POST /api/v1/contracts/:id/scan — đính kèm bản scan hợp đồng đã ký (FR-020, AC-009.2)
 */
router.post('/:id/scan', authenticateToken, requireRole(['MANAGER']), async (req, res) => {
  const { id } = req.params;
  const { image_base64 } = req.body;
  const access = await checkContractAccess(req, id);
  if (!access.ok) {
    return res.status(access.status).json(access.body);
  }

  const { client, release } = await getUserClient(req);
  try {
    const saved = await saveBase64Image({
      imageBase64: image_base64,
      folder: 'contract',
      entityId: id,
      entity: 'contract',
      ownerId: id,
      req,
      query: (sql, params) => client.query(sql, params),
    });
    if (saved.error) {
      return res.status(400).json(saved.error);
    }
    await client.query(
      `INSERT INTO audit_log (actor_id, action, entity, entity_id, after)
       VALUES ($1, 'UPLOAD', 'attachment', $2, $3)`,
      [req.user.sub, saved.attachment.id, JSON.stringify(saved.attachment)]
    );
    res.status(201).json({ message: 'Đã đính kèm bản scan hợp đồng.', data: saved.attachment });
  } catch (err) {
    console.error('[Upload Contract Scan Error]:', err);
    res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi máy chủ khi đính kèm bản scan.' });
  } finally {
    await release();
  }
});

export const SERVICE_CODES = ['ELECTRICITY', 'WATER', 'INTERNET', 'MOTORBIKE_PARKING', 'ELECTRICBIKE_PARKING', 'TRASH', 'COMMON_SERVICE'];

/**
 * GET /api/v1/contracts/:id/service-prices (FR-065, C1)
 */
router.get('/:id/service-prices', authenticateToken, requireRole(['SYS_ADMIN', 'OWNER', 'MANAGER', 'RESIDENT']), async (req, res) => {
  const { id } = req.params;
  const access = await checkContractAccess(req, id);
  if (!access.ok) {
    return res.status(access.status).json(access.body);
  }
  const { client, release } = await getUserClient(req);
  try {
    const pricesRes = await client.query(
      `SELECT * FROM contract_service_price WHERE contract_id = $1 ORDER BY service_code, effective_from DESC`,
      [id]
    );
    res.json({ data: pricesRes.rows });
  } catch (err) {
    console.error('[Get Service Prices Error]:', err);
    res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi khi lấy đơn giá dịch vụ hợp đồng.' });
  } finally {
    await release();
  }
});

/**
 * POST /api/v1/contracts/:id/service-prices (FR-065, C1)
 * Quyền: SYS_ADMIN, MANAGER (CRU trên tòa được gán)
 */
router.post('/:id/service-prices', authenticateToken, requireRole(['SYS_ADMIN', 'MANAGER']), async (req, res) => {
  const { id } = req.params;
  const { service_code, unit_price, effective_from } = req.body;
  const normCode = typeof service_code === 'string' ? service_code.trim().toUpperCase() : '';

  let isValidCode = Boolean(normCode) && SERVICE_CODES.includes(normCode);
  if (!isValidCode && normCode) {
    const catCheck = await adminPool.query(
      'SELECT 1 FROM service_catalog WHERE org_id = $1 AND UPPER(code) = $2 LIMIT 1',
      [req.user.org_id, normCode]
    );
    isValidCode = catCheck.rows.length > 0;
  }

  if (!isValidCode) {
    return res.status(422).json({
      code: 'INVALID_SERVICE_CODE',
      message: `Mã dịch vụ không hợp lệ. Phải thuộc danh mục dịch vụ hoặc: ${SERVICE_CODES.join(', ')}.`
    });
  }

  const priceNum = Number(unit_price);
  if (unit_price === undefined || unit_price === null || isNaN(priceNum) || priceNum < 0) {
    return res.status(422).json({
      code: 'INVALID_UNIT_PRICE',
      message: 'Đơn giá dịch vụ phải lớn hơn hoặc bằng 0.'
    });
  }

  const access = await checkContractAccess(req, id);
  if (!access.ok) {
    return res.status(access.status).json(access.body);
  }

  const { client, release } = await getUserClient(req);
  try {
    await client.query('BEGIN');

    const cRes = await client.query('SELECT id, start_date FROM contract WHERE id = $1', [id]);
    if (cRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy hợp đồng.' });
    }

    const effFrom = effective_from || (cRes.rows[0].start_date.toISOString ? cRes.rows[0].start_date.toISOString().split('T')[0] : cRes.rows[0].start_date);

    const upsertRes = await client.query(
      `INSERT INTO contract_service_price (contract_id, service_code, unit_price, effective_from)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (contract_id, service_code, effective_from)
       DO UPDATE SET unit_price = EXCLUDED.unit_price
       RETURNING *`,
      [id, normCode, priceNum, effFrom]
    );

    await client.query(
      `INSERT INTO audit_log (actor_id, action, entity, entity_id, after)
       VALUES ($1, 'UPSERT_SERVICE_PRICE', 'contract_service_price', $2, $3)`,
      [req.user.sub, upsertRes.rows[0].id, JSON.stringify(upsertRes.rows[0])]
    );

    await client.query('COMMIT');
    res.status(200).json({ message: 'Cập nhật đơn giá dịch vụ thành công.', data: upsertRes.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[Upsert Service Price Error]:', err);
    res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi cập nhật đơn giá dịch vụ.' });
  } finally {
    await release();
  }
});

/**
 * DELETE /api/v1/contracts/:id/service-prices/:priceId (FR-065, C1)
 */
router.delete('/:id/service-prices/:priceId', authenticateToken, requireRole(['SYS_ADMIN', 'MANAGER']), async (req, res) => {
  const { id, priceId } = req.params;
  const access = await checkContractAccess(req, id);
  if (!access.ok) {
    return res.status(access.status).json(access.body);
  }
  const { client, release } = await getUserClient(req);
  try {
    await client.query('BEGIN');

    const delRes = await client.query(
      `DELETE FROM contract_service_price WHERE id = $1 AND contract_id = $2 RETURNING *`,
      [priceId, id]
    );

    if (delRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy đơn giá dịch vụ cần xóa.' });
    }

    await client.query(
      `INSERT INTO audit_log (actor_id, action, entity, entity_id, before)
       VALUES ($1, 'DELETE_SERVICE_PRICE', 'contract_service_price', $2, $3)`,
      [req.user.sub, priceId, JSON.stringify(delRes.rows[0])]
    );

    await client.query('COMMIT');
    res.json({ message: 'Đã xóa đơn giá dịch vụ theo hợp đồng.', data: delRes.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[Delete Service Price Error]:', err);
    res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi xóa đơn giá dịch vụ.' });
  } finally {
    await release();
  }
});

/**
 * GET /api/v1/contracts/:id/amendments (FR-016, C7)
 */
router.get('/:id/amendments', authenticateToken, requireRole(['SYS_ADMIN', 'OWNER', 'MANAGER', 'RESIDENT']), async (req, res) => {
  const { id } = req.params;
  const access = await checkContractAccess(req, id);
  if (!access.ok) {
    return res.status(access.status).json(access.body);
  }
  const { client, release } = await getUserClient(req);
  try {
    const versionsRes = await client.query(
      `SELECT cv.*, 
              p.email as approved_by_email,
              p.full_name as approved_by_name
       FROM contract_version cv
       LEFT JOIN app_user u ON u.id = cv.approved_by
       LEFT JOIN person p ON p.id = u.person_id
       WHERE cv.contract_id = $1
       ORDER BY cv.version_no DESC`,
      [id]
    );
    res.json({ data: versionsRes.rows });
  } catch (err) {
    console.error('[Get Amendments Error]:', err);
    res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi khi lấy danh sách phụ lục hợp đồng.' });
  } finally {
    await release();
  }
});

/**
 * POST /api/v1/contracts/:id/amendments (FR-016, FR-015, C7, Mục 6.2)
 * Đề xuất phụ lục hợp đồng (MANAGER lập trên tòa được gán) — Không áp dụng diff trước khi duyệt
 */
router.post('/:id/amendments', authenticateToken, requireRole(['MANAGER']), async (req, res) => {
  const { id } = req.params;
  const { changes, reason, effective_from } = req.body;

  if (!reason || !reason.trim()) {
    return res.status(400).json({ code: 'REASON_REQUIRED', message: 'Vui lòng cung cấp lý do lập phụ lục hợp đồng.' });
  }

  const access = await checkContractAccess(req, id);
  if (!access.ok) {
    return res.status(access.status).json(access.body);
  }

  const { client, release } = await getUserClient(req);
  try {
    await client.query('BEGIN');

    const cRes = await client.query('SELECT * FROM contract WHERE id = $1 FOR UPDATE', [id]);
    if (cRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy hợp đồng.' });
    }

    const cur = cRes.rows[0];

    // Chỉ áp dụng cho hợp đồng ACTIVE hoặc RENEWAL_PENDING (nếu đang chờ gia hạn)
    if (!['ACTIVE', 'RENEWAL_PENDING'].includes(cur.status)) {
      await client.query('ROLLBACK');
      return res.status(422).json({
        code: 'CONTRACT_NOT_ACTIVE',
        message: cur.status === 'DRAFT'
          ? 'Hợp đồng bản nháp (DRAFT) có thể chỉnh sửa trực tiếp bằng cập nhật, không cần lập phụ lục.'
          : `Hợp đồng đang ở trạng thái ${cur.status}, chỉ hợp đồng hiệu lực (ACTIVE) mới được lập phụ lục.`
      });
    }

    // Build diff
    const diffRes = buildDiff(cur, changes);
    if (!diffRes.ok) {
      await client.query('ROLLBACK');
      return res.status(422).json({ code: diffRes.code, message: diffRes.message });
    }

    // Re-check overlap nếu có thay đổi end_date mới (loại trừ chính hợp đồng này)
    if (changes.end_date) {
      const sDate = cur.start_date.toISOString ? cur.start_date.toISOString().split('T')[0] : String(cur.start_date);
      const newEndDate = changes.end_date;

      if (newEndDate <= sDate) {
        await client.query('ROLLBACK');
        return res.status(422).json({
          code: 'INVALID_END_DATE',
          message: 'Ngày kết thúc mới phải sau ngày bắt đầu hợp đồng.'
        });
      }

      const overlapRes = await client.query(
        `SELECT id, start_date, end_date FROM contract
         WHERE apartment_id = $1 AND id <> $2
           AND status IN ('DRAFT', 'PENDING_APPROVAL', 'ACTIVE', 'RENEWAL_PENDING')
           AND (start_date < $4 AND end_date > $3)`,
        [cur.apartment_id, id, sDate, newEndDate]
      );
      if (overlapRes.rows.length > 0) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          code: 'OVERLAP_CONTRACT',
          message: 'Thời hạn gia hạn mới bị trùng lấn với hợp đồng khác của căn hộ.',
          conflicts: overlapRes.rows
        });
      }
    }

    // Lấy số phiên bản tiếp theo
    const vRes = await client.query(
      `SELECT COALESCE(MAX(version_no), 0) + 1 AS next_no FROM contract_version WHERE contract_id = $1`,
      [id]
    );
    const nextVer = vRes.rows[0].next_no;

    const effDate = effective_from || new Date().toISOString().split('T')[0];

    const diffPayload = {
      ...diffRes.diff,
      status: 'PENDING',
      created_by: req.user.sub,
    };

    const insRes = await client.query(
      `INSERT INTO contract_version (contract_id, version_no, diff, effective_from, reason, approved_by)
       VALUES ($1, $2, $3, $4, $5, NULL)
       RETURNING *`,
      [id, nextVer, JSON.stringify(diffPayload), effDate, reason.trim()]
    );

    // Nếu gia hạn (thay đổi end_date), cập nhật trạng thái hợp đồng thành RENEWAL_PENDING
    if (changes.end_date) {
      await client.query(
        `UPDATE contract SET status = 'RENEWAL_PENDING', updated_at = NOW() WHERE id = $1`,
        [id]
      );
    }

    await client.query(
      `INSERT INTO audit_log (actor_id, action, entity, entity_id, after)
       VALUES ($1, 'CREATE_AMENDMENT', 'contract_version', $2, $3)`,
      [req.user.sub, insRes.rows[0].id, JSON.stringify(insRes.rows[0])]
    );

    await client.query('COMMIT');
    res.status(201).json({
      message: 'Đã lập đề xuất phụ lục hợp đồng, chờ phê duyệt nội bộ (Quản lý khác / SYS_ADMIN).',
      data: insRes.rows[0]
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[Create Amendment Error]:', err);
    res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi khi tạo phụ lục hợp đồng.' });
  } finally {
    await release();
  }
});

/**
 * POST /api/v1/contracts/:id/amendments/:versionId/approve (FR-016, C7)
 * Phê duyệt phụ lục hợp đồng nội bộ theo nguyên tắc Four-eyes (SYS_ADMIN hoặc MANAGER thứ 2 trong tòa — OWNER 100% Read-Only)
 */
router.post('/:id/amendments/:versionId/approve', authenticateToken, requireRole(['SYS_ADMIN', 'MANAGER']), async (req, res) => {
  const { id, versionId } = req.params;
  const access = await checkContractAccess(req, id);
  if (!access.ok) {
    return res.status(access.status).json(access.body);
  }

  const { client, release } = await getUserClient(req);
  try {
    await client.query('BEGIN');

    const vRes = await client.query(
      `SELECT * FROM contract_version WHERE id = $1 AND contract_id = $2 FOR UPDATE`,
      [versionId, id]
    );

    if (vRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy phụ lục hợp đồng.' });
    }

    const version = vRes.rows[0];
    if (version.approved_by) {
      await client.query('ROLLBACK');
      return res.status(409).json({ code: 'ALREADY_APPROVED', message: 'Phụ lục này đã được phê duyệt trước đó.' });
    }

    const diff = version.diff || {};
    if (diff.status === 'REJECTED') {
      await client.query('ROLLBACK');
      return res.status(409).json({ code: 'ALREADY_REJECTED', message: 'Phụ lục này đã bị từ chối trước đó.' });
    }

    // Nguyên tắc Four-eyes nội bộ (R-23): kiểm tra cấu hình allow_self_approval
    if (diff.created_by && String(diff.created_by) === String(req.user.sub)) {
      const fourEyes = await checkFourEyesOrWarn({
        orgId: req.user.org_id,
        actorId: req.user.sub,
        creatorId: diff.created_by,
        entity: 'contract_version',
        entityId: versionId,
        actionContext: 'AMENDMENT_APPROVE',
      });
      if (!fourEyes.allowed) {
        await client.query('ROLLBACK');
        return res.status(403).json({
          code: 'SELF_APPROVAL',
          message: 'Người lập phụ lục không được tự phê duyệt (Nguyên tắc Four-eyes). Vui lòng chuyển Quản lý khác hoặc Ban Giám đốc (SYS_ADMIN) phê duyệt.',
        });
      }
    }

    // Áp dụng các thay đổi từ diff vào bảng contract (Lưu ý 1)
    const updateClauses = [];
    const updateParams = [id];

    for (const field of ['end_date', 'rent_amount', 'deposit_amount', 'note']) {
      if (diff[field] && diff[field].new !== undefined) {
        updateParams.push(diff[field].new);
        updateClauses.push(`${field} = $${updateParams.length}`);
      }
    }

    // Đưa trạng thái hợp đồng về ACTIVE (nếu đang RENEWAL_PENDING hoặc giữ ACTIVE)
    updateClauses.push(`status = 'ACTIVE'`);
    updateClauses.push(`updated_at = NOW()`);

    await client.query(
      `UPDATE contract SET ${updateClauses.join(', ')} WHERE id = $1`,
      updateParams
    );

    // Cập nhật approved_by trong contract_version
    const updatedDiff = { ...diff, status: 'APPROVED', approved_at: new Date().toISOString() };
    const upRes = await client.query(
      `UPDATE contract_version
       SET approved_by = $1, diff = $2
       WHERE id = $3
       RETURNING *`,
      [req.user.sub, JSON.stringify(updatedDiff), versionId]
    );

    await client.query(
      `INSERT INTO audit_log (actor_id, action, entity, entity_id, after)
       VALUES ($1, 'APPROVE_AMENDMENT', 'contract_version', $2, $3)`,
      [req.user.sub, versionId, JSON.stringify(upRes.rows[0])]
    );

    await client.query('COMMIT');
    res.json({ message: 'Phê duyệt và áp dụng phụ lục hợp đồng thành công.', data: upRes.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[Approve Amendment Error]:', err);
    res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi khi phê duyệt phụ lục hợp đồng.' });
  } finally {
    await release();
  }
});

/**
 * POST /api/v1/contracts/:id/amendments/:versionId/reject (FR-016, C7)
 * Từ chối phụ lục hợp đồng nội bộ (SYS_ADMIN hoặc MANAGER — OWNER 100% Read-Only)
 */
router.post('/:id/amendments/:versionId/reject', authenticateToken, requireRole(['SYS_ADMIN', 'MANAGER']), async (req, res) => {
  const { id, versionId } = req.params;
  const { reason } = req.body;

  if (!reason || !reason.trim()) {
    return res.status(400).json({ code: 'REASON_REQUIRED', message: 'Vui lòng cung cấp lý do từ chối phụ lục.' });
  }

  const access = await checkContractAccess(req, id);
  if (!access.ok) {
    return res.status(access.status).json(access.body);
  }

  const { client, release } = await getUserClient(req);
  try {
    await client.query('BEGIN');

    const vRes = await client.query(
      `SELECT * FROM contract_version WHERE id = $1 AND contract_id = $2 FOR UPDATE`,
      [versionId, id]
    );

    if (vRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy phụ lục hợp đồng.' });
    }

    const version = vRes.rows[0];
    if (version.approved_by) {
      await client.query('ROLLBACK');
      return res.status(409).json({ code: 'ALREADY_APPROVED', message: 'Phụ lục này đã được phê duyệt, không thể từ chối.' });
    }

    const diff = version.diff || {};
    const updatedDiff = {
      ...diff,
      status: 'REJECTED',
      rejected_by: req.user.sub,
      rejected_at: new Date().toISOString(),
      rejection_reason: reason.trim(),
    };

    await client.query(
      `UPDATE contract_version SET diff = $1 WHERE id = $2`,
      [JSON.stringify(updatedDiff), versionId]
    );

    // Nếu contract đang ở RENEWAL_PENDING, đưa về ACTIVE
    await client.query(
      `UPDATE contract SET status = 'ACTIVE', updated_at = NOW() WHERE id = $1 AND status = 'RENEWAL_PENDING'`,
      [id]
    );

    await client.query(
      `INSERT INTO audit_log (actor_id, action, entity, entity_id, before, after)
       VALUES ($1, 'REJECT_AMENDMENT', 'contract_version', $2, $3, $4)`,
      [req.user.sub, versionId, JSON.stringify(diff), JSON.stringify(updatedDiff)]
    );

    await client.query('COMMIT');
    res.json({ message: 'Đã từ chối đề xuất phụ lục hợp đồng.' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[Reject Amendment Error]:', err);
    res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi khi từ chối phụ lục hợp đồng.' });
  } finally {
    await release();
  }
});

/**
 * GET /api/v1/contracts/:id/template (FR-020, C10)
 * Xuất mẫu hợp đồng thuê A4 chuẩn pháp lý (HTML printable)
 */
router.get('/:id/template', authenticateToken, requireRole(['SYS_ADMIN', 'OWNER', 'MANAGER', 'RESIDENT']), async (req, res) => {
  const { id } = req.params;
  const access = await checkContractAccess(req, id);
  if (!access.ok) {
    if (access.status === 403) {
      return res.status(403).send('<h1>403 Bạn không có quyền truy cập hợp đồng của tòa nhà này</h1>');
    }
    return res.status(404).send('<h1>404 Không tìm thấy hợp đồng</h1>');
  }

  const { client, release } = await getUserClient(req);
  try {
    const contractRes = await client.query(
      `SELECT c.*,
              a.code as apartment_code, a.area_m2, a.bedrooms,
              b.id as building_id, b.name as building_name, b.address as building_address,
              o.name as org_name,
              p.full_name as tenant_name, p.phone as tenant_phone, p.email as tenant_email,
              p.id_number as tenant_id_number, p.dob as tenant_dob
       FROM contract c
       JOIN apartment a ON a.id = c.apartment_id
       JOIN building b ON b.id = c.building_id
       JOIN organization o ON o.id = b.org_id
       JOIN tenant t ON t.id = c.primary_tenant_id
       JOIN person p ON p.id = t.person_id
       WHERE c.id = $1`,
      [id]
    );

    if (contractRes.rows.length === 0) {
      return res.status(404).send('<h1>404 Không tìm thấy hợp đồng</h1>');
    }

    const c = contractRes.rows[0];

    // Lấy thành viên cùng ở
    const occRes = await client.query(
      `SELECT co.relationship, p.full_name, p.phone, p.id_number
       FROM contract_occupant co
       JOIN tenant t ON t.id = co.tenant_id
       JOIN person p ON p.id = t.person_id
       WHERE co.contract_id = $1
       ORDER BY co.created_at ASC`,
      [id]
    );
    const occupants = occRes.rows;

    // Lấy bảng giá dịch vụ
    const spRes = await client.query(
      `SELECT service_code, unit_price, effective_from
       FROM contract_service_price
       WHERE contract_id = $1
       ORDER BY service_code ASC`,
      [id]
    );
    const servicePrices = spRes.rows;

    const fmtDate = (d) => {
      if (!d) return '—';
      const dt = new Date(d);
      return `${String(dt.getDate()).padStart(2, '0')}/${String(dt.getMonth() + 1).padStart(2, '0')}/${dt.getFullYear()}`;
    };

    const fmtMoney = (m) => {
      if (m == null) return '0 ₫';
      return Number(m).toLocaleString('vi-VN') + ' ₫';
    };

    const isDraft = c.status !== 'ACTIVE';
    const watermarkHtml = isDraft
      ? `<div class="watermark">DỰ THẢO - CHƯA KÍCH HOẠT</div>`
      : '';

    const contractCode = `HĐ-${c.id.slice(0, 8).toUpperCase()}`;

    const serviceCodeLabels = {
      ELECTRICITY: { name: 'Điện sinh hoạt', unit: 'kWh' },
      ELEC: { name: 'Điện sinh hoạt', unit: 'kWh' },
      WATER: { name: 'Nước sinh hoạt', unit: 'm³' },
      INTERNET: { name: 'Internet / Wifi', unit: 'tháng' },
      MOTORBIKE_PARKING: { name: 'Gửi xe máy xăng', unit: 'xe/tháng' },
      ELECTRICBIKE_PARKING: { name: 'Gửi xe đạp/máy điện', unit: 'xe/tháng' },
      TRASH: { name: 'Phí thu gom rác', unit: 'tháng' },
      COMMON_SERVICE: { name: 'Dịch vụ chung', unit: 'tháng' },
      CLEANING: { name: 'Vệ sinh & Rác thải', unit: 'tháng' },
      PARKING_MOTO: { name: 'Gửi xe máy', unit: 'xe/tháng' },
      PARKING_CAR: { name: 'Gửi xe ô tô', unit: 'xe/tháng' },
      MANAGEMENT: { name: 'Phí quản lý tòa nhà', unit: 'tháng' },
    };

    const serviceRowsHtml = servicePrices.length > 0
      ? servicePrices.map((sp, idx) => {
          const codeKey = sp.service_code;
          const meta = serviceCodeLabels[codeKey] || { name: codeKey, unit: 'tháng' };
          return `
            <tr>
              <td style="text-align:center;">${idx + 1}</td>
              <td><strong>${meta.name}</strong> (${codeKey})</td>
              <td style="text-align:center;">${meta.unit}</td>
              <td style="text-align:right; font-weight:600;">${fmtMoney(sp.unit_price)}</td>
              <td style="text-align:center;">${fmtDate(sp.effective_from)}</td>
            </tr>
          `;
        }).join('')
      : `
        <tr><td colspan="5" style="text-align:center; color:#666; font-style:italic;">Theo biểu phí tiêu chuẩn của tòa nhà.</td></tr>
      `;

    const occupantsHtml = occupants.length > 0
      ? `
        <p><strong>Người cùng lưu trú:</strong></p>
        <table class="bordered-table">
          <thead>
            <tr>
              <th style="width:40px;">STT</th>
              <th>Họ và tên</th>
              <th>Quan hệ</th>
              <th>Số điện thoại</th>
              <th>Số CCCD/Hộ chiếu</th>
            </tr>
          </thead>
          <tbody>
            ${occupants.map((occ, i) => `
              <tr>
                <td style="text-align:center;">${i + 1}</td>
                <td><strong>${occ.full_name}</strong></td>
                <td>${occ.relationship || 'Khác'}</td>
                <td>${occ.phone || '—'}</td>
                <td>${occ.id_number || '—'}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      `
      : '';

    const html = `<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8">
  <title>Hợp đồng thuê căn hộ - ${c.apartment_code}</title>
  <style>
    @page {
      size: A4;
      margin: 20mm 15mm 20mm 15mm;
    }
    * {
      box-sizing: border-box;
    }
    body {
      font-family: 'Times New Roman', Times, serif, 'Segoe UI', Arial, sans-serif;
      font-size: 13pt;
      line-height: 1.5;
      color: #111;
      margin: 0;
      padding: 0;
      background-color: #f1f5f9;
    }
    .page-container {
      max-width: 210mm;
      min-height: 297mm;
      margin: 20px auto;
      background: #fff;
      padding: 20mm 20mm;
      box-shadow: 0 4px 20px rgba(0,0,0,0.08);
      position: relative;
    }
    .header-section {
      text-align: center;
      margin-bottom: 25px;
    }
    .header-national {
      font-size: 12pt;
      font-weight: bold;
      text-transform: uppercase;
      margin-bottom: 4px;
    }
    .header-motto {
      font-size: 13pt;
      font-weight: bold;
      margin-bottom: 8px;
    }
    .divider {
      width: 160px;
      margin: 0 auto 20px auto;
      border-top: 1.5px solid #111;
    }
    .contract-title {
      font-size: 18pt;
      font-weight: bold;
      text-transform: uppercase;
      margin: 15px 0 5px 0;
    }
    .contract-code {
      font-size: 11pt;
      font-style: italic;
      color: #444;
      margin-bottom: 20px;
    }
    h3 {
      font-size: 13pt;
      text-transform: uppercase;
      border-bottom: 1px solid #ddd;
      padding-bottom: 4px;
      margin-top: 18px;
      margin-bottom: 8px;
    }
    p {
      margin: 6px 0;
      text-align: justify;
    }
    .field-row {
      display: flex;
      margin: 4px 0;
    }
    .field-label {
      width: 170px;
      font-weight: bold;
      flex-shrink: 0;
    }
    .field-value {
      flex: 1;
    }
    .bordered-table {
      width: 100%;
      border-collapse: collapse;
      margin: 12px 0;
      font-size: 12pt;
    }
    .bordered-table th, .bordered-table td {
      border: 1px solid #444;
      padding: 6px 10px;
    }
    .bordered-table th {
      background-color: #f8fafc;
      font-weight: bold;
      text-align: left;
    }
    .signature-grid {
      display: flex;
      justify-content: space-between;
      margin-top: 40px;
      page-break-inside: avoid;
    }
    .signature-box {
      width: 45%;
      text-align: center;
    }
    .signature-space {
      height: 90px;
    }
    .watermark {
      position: fixed;
      top: 40%;
      left: 15%;
      right: 15%;
      text-align: center;
      transform: rotate(-30deg);
      font-size: 42pt;
      font-weight: 900;
      color: rgba(220, 38, 38, 0.12);
      border: 5px dashed rgba(220, 38, 38, 0.22);
      padding: 20px 30px;
      border-radius: 12px;
      pointer-events: none;
      z-index: 1000;
      letter-spacing: 2px;
    }
    .toolbar {
      position: sticky;
      top: 0;
      background: #0f172a;
      color: #fff;
      padding: 12px 24px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      box-shadow: 0 4px 12px rgba(0,0,0,0.15);
      z-index: 9999;
    }
    .btn-print {
      background: #4f46e5;
      color: #fff;
      border: none;
      padding: 8px 18px;
      font-size: 14px;
      font-weight: 600;
      border-radius: 8px;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .btn-print:hover {
      background: #4338ca;
    }
    @media print {
      body {
        background: transparent;
      }
      .toolbar {
        display: none !important;
      }
      .page-container {
        box-shadow: none;
        margin: 0;
        padding: 0;
        width: 100%;
        max-width: none;
      }
    }
  </style>
</head>
<body>
  <div class="toolbar">
    <div style="font-weight:600; font-size:14px;">
      Mẫu hợp đồng thuê căn hộ: <strong>${c.apartment_code}</strong> — ${c.building_name} (${contractCode})
    </div>
    <button class="btn-print" onclick="window.print()">
      🖨️ In hợp đồng (Ctrl + P)
    </button>
  </div>

  <div class="page-container">
    ${watermarkHtml}

    <div class="header-section">
      <div class="header-national">CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM</div>
      <div class="header-motto">Độc lập – Tự do – Hạnh phúc</div>
      <div class="divider"></div>
      <div class="contract-title">HỢP ĐỒNG THUÊ CĂN HỘ</div>
      <div class="contract-code">Số: ${contractCode} / ${c.building_name}</div>
    </div>

    <p><em>Hôm nay, ngày ${new Date().getDate()} tháng ${new Date().getMonth() + 1} năm ${new Date().getFullYear()}, tại ${c.building_name}, chúng tôi gồm có:</em></p>

    <h3>BÊN CHO THUÊ (BÊN A)</h3>
    <div class="field-row">
      <div class="field-label">Đơn vị quản lý:</div>
      <div class="field-value"><strong>${c.org_name || 'Ban Quản Lý Tòa Nhà'}</strong></div>
    </div>
    <div class="field-row">
      <div class="field-label">Tòa nhà:</div>
      <div class="field-value">${c.building_name}</div>
    </div>
    <div class="field-row">
      <div class="field-label">Địa chỉ:</div>
      <div class="field-value">${c.building_address}</div>
    </div>

    <h3>BÊN THUÊ (BÊN B)</h3>
    <div class="field-row">
      <div class="field-label">Họ và tên:</div>
      <div class="field-value"><strong>${c.tenant_name}</strong></div>
    </div>
    <div class="field-row">
      <div class="field-label">Số CCCD / Hộ chiếu:</div>
      <div class="field-value">${c.tenant_id_number || '—'}</div>
    </div>
    <div class="field-row">
      <div class="field-label">Số điện thoại:</div>
      <div class="field-value">${c.tenant_phone}</div>
    </div>
    <div class="field-row">
      <div class="field-label">Email:</div>
      <div class="field-value">${c.tenant_email || '—'}</div>
    </div>

    ${occupantsHtml}

    <h3>ĐIỀU 1: ĐỐI TƯỢNG HỢP ĐỒNG VÀ MỤC ĐÍCH THUÊ</h3>
    <p>1.1. Bên A đồng ý cho Bên B thuê căn hộ số <strong>${c.apartment_code}</strong>, thuộc tòa nhà <strong>${c.building_name}</strong>, địa chỉ: ${c.building_address}.</p>
    <p>1.2. Diện tích sàn căn hộ: <strong>${c.area_m2 || '—'} m²</strong>, số phòng ngủ: <strong>${c.bedrooms || 1}</strong>.</p>
    <p>1.3. Mục đích thuê: Dùng để ở sinh hoạt hợp pháp, không sử dụng vào mục đích kinh doanh trái phép hoặc làm nơi chứa hàng nguy hiểm.</p>

    <h3>ĐIỀU 2: THỜI HẠN THUÊ</h3>
    <p>2.1. Thời hạn thuê bắt đầu từ ngày <strong>${fmtDate(c.start_date)}</strong> đến hết ngày <strong>${fmtDate(c.end_date)}</strong>.</p>
    <p>2.2. Trước khi hết hạn hợp đồng tối thiểu 30 ngày (theo AC-006.1), Bên B có quyền gửi đề nghị gia hạn hoặc chấm dứt hợp đồng qua Cổng cư dân để hai bên tiến hành ký phụ lục hoặc lập thủ tục tất toán.</p>

    <h3>ĐIỀU 3: GIÁ THUÊ VÀ PHƯƠNG THỨC THANH TOÁN</h3>
    <p>3.1. Giá thuê căn hộ: <strong>${fmtMoney(c.rent_amount)} / tháng</strong> (Bằng chữ: theo quy định thực tế).</p>
    <p>3.2. Chu kỳ thanh toán: <strong>${c.billing_cycle === 'quarterly' ? '3 tháng / lần' : 'Hàng tháng'}</strong>.</p>
    <p>3.3. Ngày phát hành hóa đơn định kỳ: Ngày <strong>${c.billing_day || 1}</strong> hàng tháng. Thời hạn thanh toán: Trong vòng <strong>${c.payment_due_days || 5}</strong> ngày kể từ ngày thông báo.</p>

    <h3>ĐIỀU 4: TIỀN ĐẶT CỌC BẢO ĐẢM VÀ QUY TẮC HOÀN TRẢ</h3>
    <p>4.1. Tiền đặt cọc bảo đảm thực hiện hợp đồng: <strong>${fmtMoney(c.deposit_amount)}</strong>.</p>
    <p>4.2. Số tiền cọc này được Bên A bảo lưu an toàn trong suốt thời gian hiệu lực của hợp đồng và không tính lãi.</p>
    <p>4.3. <strong>Quy tắc tất toán hoàn cọc:</strong> Khi hợp đồng kết thúc hoặc chấm dứt hợp lệ, Bên A lập hồ sơ tất toán trong vòng 3-5 ngày làm việc. Số tiền hoàn trả thực tế được tính theo công thức:</p>
    <p style="text-align:center; font-weight:bold; background:#f8fafc; padding:8px; border:1px solid #cbd5e1; border-radius:6px;">
      Tiền hoàn trả = Tiền cọc bảo đảm − Tổng khấu trừ hư hại vật chất − Công nợ dịch vụ tồn đọng
    </p>

    <h3>ĐIỀU 5: BIỂU PHÍ DỊCH VỤ VÀ TIỆN ÍCH</h3>
    <p>Các chi phí phát sinh hàng tháng theo chỉ số tiêu thụ hoặc mức cố định quy định dưới đây:</p>
    <table class="bordered-table">
      <thead>
        <tr>
          <th style="width:40px; text-align:center;">STT</th>
          <th>Dịch vụ</th>
          <th style="width:100px; text-align:center;">Đơn vị</th>
          <th style="width:140px; text-align:right;">Đơn giá áp dụng</th>
          <th style="width:120px; text-align:center;">Hiệu lực từ</th>
        </tr>
      </thead>
      <tbody>
        ${serviceRowsHtml}
      </tbody>
    </table>

    <h3>ĐIỀU 6: ĐIỀU KHOẢN THI HÀNH VÀ CAM KẾT CHUNG</h3>
    <p>6.1. Hai bên cam kết thực hiện đúng và đầy đủ các điều khoản đã thỏa thuận trong hợp đồng.</p>
    <p>6.2. Hợp đồng được lập thành 02 (hai) bản có giá trị pháp lý như nhau, mỗi bên giữ 01 bản để thực hiện.</p>

    <div class="signature-grid">
      <div class="signature-box">
        <strong>ĐẠI DIỆN BÊN A</strong><br>
        <em>(Ký, ghi rõ họ tên và đóng dấu)</em>
        <div class="signature-space"></div>
        <p><strong>${c.org_name || 'Ban Quản Lý'}</strong></p>
      </div>

      <div class="signature-box">
        <strong>ĐẠI DIỆN BÊN B</strong><br>
        <em>(Ký và ghi rõ họ tên)</em>
        <div class="signature-space"></div>
        <p><strong>${c.tenant_name}</strong></p>
      </div>
    </div>
  </div>
</body>
</html>`;

    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (err) {
    console.error('[Contract Template Error]:', err);
    res.status(500).send('<h1>500 Lỗi máy chủ khi tạo mẫu in hợp đồng</h1>');
  } finally {
    await release();
  }
});

/**
 * POST /api/v1/contracts/:id/renew (FR-015)
 * Gia hạn bằng cách tạo hợp đồng nối tiếp mới có parent_contract_id trỏ về hợp đồng hiện tại
 */
router.post('/:id/renew', authenticateToken, requireRole(['MANAGER']), async (req, res) => {
  const { id } = req.params;
  const { new_end_date, rent_amount, deposit_amount, note } = req.body;

  if (!new_end_date) {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Vui lòng cung cấp ngày kết thúc mới (new_end_date).' });
  }

  const access = await checkContractAccess(req, id);
  if (!access.ok) {
    return res.status(access.status).json(access.body);
  }

  const { client, release } = await getUserClient(req);
  try {
    await client.query('BEGIN');

    const curRes = await client.query('SELECT * FROM contract WHERE id = $1 FOR UPDATE', [id]);
    if (curRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy hợp đồng.' });
    }
    const cur = curRes.rows[0];
    if (!['ACTIVE', 'EXPIRED', 'RENEWAL_PENDING'].includes(cur.status)) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        code: 'INVALID_STATUS',
        message: `Chỉ hợp đồng ACTIVE, RENEWAL_PENDING hoặc EXPIRED mới có thể tạo bản gia hạn nối tiếp.`,
      });
    }

    const oldEndStr = cur.end_date.toISOString ? cur.end_date.toISOString().split('T')[0] : String(cur.end_date);
    if (new_end_date <= oldEndStr) {
      await client.query('ROLLBACK');
      return res.status(422).json({
        code: 'INVALID_DATE_RANGE',
        message: 'Ngày kết thúc gia hạn phải sau ngày kết thúc của hợp đồng hiện tại.',
      });
    }

    const overlapRes = await client.query(
      `SELECT id FROM contract
       WHERE apartment_id = $1 AND id <> $2
         AND status IN ('DRAFT', 'PENDING_APPROVAL', 'ACTIVE', 'RENEWAL_PENDING')
         AND (start_date < $4 AND end_date > $3)`,
      [cur.apartment_id, id, oldEndStr, new_end_date]
    );
    if (overlapRes.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        code: 'OVERLAP_CONTRACT',
        message: 'Kỳ hạn gia hạn bị trùng với một hợp đồng khác trên cùng căn hộ.',
      });
    }

    const nextRent = rent_amount !== undefined && rent_amount !== null ? Number(rent_amount) : Number(cur.rent_amount);
    const nextDeposit = deposit_amount !== undefined && deposit_amount !== null ? Number(deposit_amount) : Number(cur.deposit_amount);

    const newContractRes = await client.query(
      `INSERT INTO contract (
         apartment_id, building_id, primary_tenant_id,
         start_date, end_date, rent_amount, billing_cycle, billing_day, payment_due_days,
         deposit_amount, status, parent_contract_id, note, created_by
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'DRAFT', $11, $12, $13)
       RETURNING *`,
      [
        cur.apartment_id,
        cur.building_id,
        cur.primary_tenant_id,
        oldEndStr,
        new_end_date,
        nextRent,
        cur.billing_cycle || 'monthly',
        cur.billing_day || 1,
        cur.payment_due_days || 5,
        nextDeposit,
        cur.id,
        note || `Gia hạn nối tiếp từ hợp đồng ${cur.id.slice(0, 8).toUpperCase()}`,
        req.user.sub,
      ]
    );

    const newContract = newContractRes.rows[0];

    await client.query(
      `INSERT INTO contract_occupant (contract_id, tenant_id, relationship)
       SELECT $1, tenant_id, relationship FROM contract_occupant WHERE contract_id = $2`,
      [newContract.id, cur.id]
    );

    await client.query(
      `INSERT INTO audit_log (actor_id, action, entity, entity_id, before, after)
       VALUES ($1, 'RENEW_CONTRACT', 'contract', $2, $3, $4)`,
      [req.user.sub, newContract.id, JSON.stringify({ parent_contract_id: cur.id }), JSON.stringify(newContract)]
    );

    await client.query('COMMIT');
    res.status(201).json({
      message: 'Đã tạo hợp đồng gia hạn nối tiếp (gắn kết lịch sử parent_contract_id). Vui lòng tải bản ký để kích hoạt.',
      data: newContract,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[Renew Contract Error]:', err);
    res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi khi tạo hợp đồng gia hạn nối tiếp.' });
  } finally {
    await release();
  }
});

/**
 * POST /api/v1/contracts/:id/transfer-room (FR-013)
 * Chuyển phòng atomic trong một transaction:
 * - Đóng hợp đồng cũ (TERMINATED) & chuyển căn cũ sang MAINTENANCE
 * - Mở hợp đồng mới ACTIVE trên căn mới (gán parent_contract_id = id) & chuyển căn mới sang OCCUPIED
 * - Tùy chọn chuyển sổ cọc sang hợp đồng mới (transfer_deposit = true)
 */
router.post('/:id/transfer-room', authenticateToken, requireRole(['MANAGER']), async (req, res) => {
  const { id } = req.params;
  const {
    new_apartment_id,
    new_start_date,
    new_end_date,
    new_rent_amount,
    transfer_deposit = true,
    note,
  } = req.body;

  if (!new_apartment_id) {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Vui lòng chọn căn hộ mới cần chuyển tới (new_apartment_id).' });
  }

  const access = await checkContractAccess(req, id);
  if (!access.ok) {
    return res.status(access.status).json(access.body);
  }

  const mgrIds = await getManagerBuildingIds(req.user.sub, req.user.org_id);

  const { client, release } = await getUserClient(req);
  try {
    const targetAptMeta = await adminPool.query(
      `SELECT a.*, b.org_id FROM apartment a JOIN building b ON b.id = a.building_id WHERE a.id = $1`,
      [new_apartment_id]
    );
    if (targetAptMeta.rows.length === 0 || targetAptMeta.rows[0].org_id !== req.user.org_id) {
      return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy căn hộ đích.' });
    }
    const targetApt = targetAptMeta.rows[0];

    if (!mgrIds.includes(targetApt.building_id)) {
      await logAccessDenied(req, 'apartment', new_apartment_id, 'MANAGER attempted transfer-room to unassigned building');
      return res.status(403).json({
        code: 'ACCESS_DENIED',
        message: 'Bạn không có quyền chuyển phòng sang tòa nhà ngoài phạm vi quản lý.',
      });
    }

    await client.query('BEGIN');

    const oldRes = await client.query('SELECT * FROM contract WHERE id = $1 FOR UPDATE', [id]);
    if (oldRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy hợp đồng hiện tại.' });
    }
    const oldContract = oldRes.rows[0];

    if (oldContract.status !== 'ACTIVE') {
      await client.query('ROLLBACK');
      return res.status(409).json({
        code: 'CONTRACT_NOT_ACTIVE',
        message: 'Chỉ hợp đồng đang hiệu lực (ACTIVE) mới có thể thực hiện chuyển phòng.',
      });
    }

    if (oldContract.apartment_id === new_apartment_id) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        code: 'SAME_APARTMENT',
        message: 'Căn hộ mới phải khác căn hộ đang ở hiện tại.',
      });
    }

    const newAptLock = await client.query('SELECT * FROM apartment WHERE id = $1 FOR UPDATE', [new_apartment_id]);
    if (newAptLock.rows.length === 0 || newAptLock.rows[0].status !== 'AVAILABLE') {
      await client.query('ROLLBACK');
      return res.status(409).json({
        code: 'APARTMENT_NOT_AVAILABLE',
        message: `Căn hộ đích đang ở trạng thái ${newAptLock.rows[0]?.status || 'UNKNOWN'}, chỉ căn AVAILABLE mới có thể chuyển đến.`,
      });
    }

    const transferDate = new_start_date || new Date().toISOString().slice(0, 10);
    const oldEndStr = oldContract.end_date.toISOString
      ? oldContract.end_date.toISOString().split('T')[0]
      : String(oldContract.end_date);
    const finalEndDate = new_end_date || oldEndStr;

    if (finalEndDate <= transferDate) {
      await client.query('ROLLBACK');
      return res.status(422).json({
        code: 'INVALID_DATE_RANGE',
        message: 'Ngày kết thúc hợp đồng mới phải sau ngày chuyển phòng.',
      });
    }

    // Kiểm tra chống chồng lấn trên căn mới
    const overlapRes = await client.query(
      `SELECT id FROM contract
       WHERE apartment_id = $1
         AND status IN ('DRAFT', 'PENDING_APPROVAL', 'ACTIVE', 'RENEWAL_PENDING')
         AND (start_date < $3 AND end_date > $2)`,
      [new_apartment_id, transferDate, finalEndDate]
    );
    if (overlapRes.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        code: 'OVERLAP_CONTRACT',
        message: 'Căn hộ đích đã có lịch hợp đồng trùng với khoảng thời gian chuyển đến.',
      });
    }

    // 1. Đóng hợp đồng cũ & đặt căn cũ sang MAINTENANCE
    await client.query(
      `UPDATE contract
       SET status = 'TERMINATED',
           terminated_at = $1,
           note = COALESCE(note || ' ', '') || $2,
           updated_at = NOW()
       WHERE id = $3`,
      [transferDate, `[Chuyển sang căn ${newAptLock.rows[0].code}]`, oldContract.id]
    );

    await client.query(
      `UPDATE apartment SET status = 'MAINTENANCE', updated_at = NOW() WHERE id = $1`,
      [oldContract.apartment_id]
    );

    // 2. Tạo hợp đồng mới ACTIVE trên căn mới, liên kết parent_contract_id
    const finalRent = new_rent_amount !== undefined && new_rent_amount !== null
      ? Number(new_rent_amount)
      : Number(newAptLock.rows[0].base_rent || oldContract.rent_amount);

    const newContractRes = await client.query(
      `INSERT INTO contract (
         apartment_id, building_id, primary_tenant_id,
         start_date, end_date, rent_amount, billing_cycle, billing_day, payment_due_days,
         deposit_amount, status, parent_contract_id, note, created_by
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'ACTIVE', $11, $12, $13)
       RETURNING *`,
      [
        new_apartment_id,
        newAptLock.rows[0].building_id,
        oldContract.primary_tenant_id,
        transferDate,
        finalEndDate,
        finalRent,
        oldContract.billing_cycle || 'monthly',
        oldContract.billing_day || 1,
        oldContract.payment_due_days || 5,
        oldContract.deposit_amount,
        oldContract.id,
        note || `Chuyển phòng từ hợp đồng ${oldContract.id.slice(0, 8).toUpperCase()}`,
        req.user.sub,
      ]
    );
    const newContract = newContractRes.rows[0];

    await client.query(
      `UPDATE apartment
       SET status = CASE WHEN $2::date <= CURRENT_DATE THEN 'OCCUPIED' ELSE 'RESERVED' END,
           updated_at = NOW()
       WHERE id = $1`,
      [new_apartment_id, transferDate]
    );

    // Sao chép người ở cùng
    await client.query(
      `INSERT INTO contract_occupant (contract_id, tenant_id, relationship)
       SELECT $1, tenant_id, relationship FROM contract_occupant WHERE contract_id = $2`,
      [newContract.id, oldContract.id]
    );

    // 3. Chuyển sổ cọc (nếu chọn transfer_deposit)
    let transferredDeposit = null;
    if (transfer_deposit) {
      const oldDepRes = await client.query(
        `SELECT * FROM deposit WHERE contract_id = $1 AND status = 'HELD' FOR UPDATE`,
        [oldContract.id]
      );
      if (oldDepRes.rows.length > 0) {
        const oldDep = oldDepRes.rows[0];
        const heldAmt = oldDep.amount_held;

        await client.query(
          `UPDATE deposit SET amount_held = 0, status = 'TRANSFERRED', updated_at = NOW() WHERE id = $1`,
          [oldDep.id]
        );

        await client.query(
          `INSERT INTO deposit_transaction (
             deposit_id, type, amount, description, method, status, approved_by, approved_at, created_by
           )
           VALUES ($1, 'transfer', $2, $3, 'TRANSFER', 'APPROVED', $4, NOW(), $4)`,
          [
            oldDep.id,
            heldAmt,
            `Chuyển kết dư tiền cọc sang hợp đồng căn mới ${newAptLock.rows[0].code} (FR-013)`,
            req.user.sub,
          ]
        );

        const newDepRes = await client.query(
          `INSERT INTO deposit (contract_id, amount_held, status)
           VALUES ($1, $2, 'HELD')
           RETURNING *`,
          [newContract.id, heldAmt]
        );
        transferredDeposit = newDepRes.rows[0];

        await client.query(
          `INSERT INTO deposit_transaction (
             deposit_id, type, amount, description, method, status, approved_by, approved_at, created_by
           )
           VALUES ($1, 'transfer', $2, $3, 'TRANSFER', 'APPROVED', $4, NOW(), $4)`,
          [
            transferredDeposit.id,
            heldAmt,
            `Chuyển tiền cọc sang căn hộ mới ${newAptLock.rows[0].code} (FR-013)`,
            req.user.sub,
          ]
        );
      }
    }

    await client.query(
      `INSERT INTO audit_log (actor_id, action, entity, entity_id, before, after)
       VALUES ($1, 'TRANSFER_ROOM', 'contract', $2, $3, $4)`,
      [
        req.user.sub,
        newContract.id,
        JSON.stringify({ old_contract_id: oldContract.id, old_apartment_id: oldContract.apartment_id }),
        JSON.stringify({ new_contract: newContract, transfer_deposit, transferred_deposit_id: transferredDeposit?.id || null }),
      ]
    );

    await client.query('COMMIT');
    res.status(201).json({
      message: `Chuyển phòng sang căn ${newAptLock.rows[0].code} thành công!`,
      data: {
        old_contract_id: oldContract.id,
        new_contract: newContract,
        transferred_deposit: transferredDeposit,
      },
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[Transfer Room Error]:', err);
    res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi máy chủ khi thực hiện chuyển phòng.' });
  } finally {
    await release();
  }
});

export default router;
