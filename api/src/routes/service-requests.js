import express from 'express';
import { pool, adminPool } from '../db/client.js';
import { authenticateToken } from '../middleware/auth.js';
import { requireRole } from '../middleware/rbac.js';
import { saveBase64Image } from '../services/imageUpload.js';
import {
  getUserRoleCodes,
  scopedBuildingFilter,
  checkBuildingAccess,
  logAccessDenied,
} from '../services/ownerScope.js';

const router = express.Router();

const VALID_CATEGORIES = ['ELECTRICAL', 'PLUMBING', 'HVAC', 'FURNITURE', 'APPLIANCE', 'CLEANING', 'SECURITY', 'OTHER'];
const VALID_PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT'];
const VALID_STATUSES = ['NEW', 'ASSIGNED', 'IN_PROGRESS', 'RESOLVED', 'CLOSED', 'CANCELLED'];

async function generateTrackingCode() {
  const datePart = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const rand = Math.floor(1000 + Math.random() * 9000);
  const candidate = `SR-${datePart}-${rand}`;
  const dup = await adminPool.query('SELECT 1 FROM service_request WHERE tracking_code = $1', [candidate]);
  if (dup.rows.length === 0) return candidate;
  return `SR-${datePart}-${Math.floor(10000 + Math.random() * 90000)}`;
}

/**
 * GET /api/v1/service-requests
 * Danh sách yêu cầu & báo hỏng (M11)
 */
router.get(
  '/',
  authenticateToken,
  requireRole(['SYS_ADMIN', 'OWNER', 'MANAGER', 'STAFF']),
  async (req, res) => {
    const { building_id, status, category, priority, search } = req.query;
    const orgId = req.user.org_id;

    try {
      if (building_id) {
        const ok = await checkBuildingAccess(req, building_id, 'service_request');
        if (!ok) {
          return res.status(403).json({
            code: 'ACCESS_DENIED',
            message: 'Bạn không có quyền truy cập yêu cầu của tòa nhà này.',
          });
        }
      }

      const params = [orgId];
      const { sql: scopeSql } = await scopedBuildingFilter(req, 'sr.building_id', params);

      let sql = `
        SELECT sr.*,
               a.code AS apartment_code,
               b.name AS building_name,
               b.code AS building_code,
               p_req.full_name AS requester_name,
               p_req.phone AS requester_phone,
               p_ass.full_name AS assigned_to_name,
               p_res.full_name AS resolved_by_name
        FROM service_request sr
        JOIN apartment a ON a.id = sr.apartment_id
        JOIN building b ON b.id = sr.building_id
        LEFT JOIN app_user au_req ON au_req.id = sr.created_by
        LEFT JOIN person p_req ON p_req.id = au_req.person_id
        LEFT JOIN app_user au_ass ON au_ass.id = sr.assigned_to
        LEFT JOIN person p_ass ON p_ass.id = au_ass.person_id
        LEFT JOIN app_user au_res ON au_res.id = sr.resolved_by
        LEFT JOIN person p_res ON p_res.id = au_res.person_id
        WHERE sr.org_id = $1
        ${scopeSql}
      `;

      if (building_id) {
        params.push(building_id);
        sql += ` AND sr.building_id = $${params.length}`;
      }
      if (status) {
        params.push(status);
        sql += ` AND sr.status = ANY(string_to_array($${params.length}, ','))`;
      }
      if (category) {
        params.push(category);
        sql += ` AND sr.category = $${params.length}`;
      }
      if (priority) {
        params.push(priority);
        sql += ` AND sr.priority = $${params.length}`;
      }
      if (search && search.trim()) {
        params.push(`%${search.trim()}%`);
        const idx = params.length;
        sql += ` AND (sr.tracking_code ILIKE $${idx} OR sr.title ILIKE $${idx} OR a.code ILIKE $${idx} OR COALESCE(p_req.full_name, '') ILIKE $${idx})`;
      }

      sql += ` ORDER BY
        CASE sr.priority WHEN 'URGENT' THEN 1 WHEN 'HIGH' THEN 2 WHEN 'NORMAL' THEN 3 ELSE 4 END ASC,
        sr.created_at DESC`;

      const result = await pool.query(sql, params);
      res.json({ data: result.rows });
    } catch (err) {
      console.error('[ServiceRequests List Error]:', err);
      res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi khi tải danh sách yêu cầu kỹ thuật.' });
    }
  }
);

/**
 * POST /api/v1/service-requests
 * Quản lý / nhân viên kỹ thuật tạo yêu cầu bảo trì cho căn hộ
 */
router.post(
  '/',
  authenticateToken,
  requireRole(['SYS_ADMIN', 'MANAGER', 'STAFF']),
  async (req, res) => {
    const { apartment_id, title, category = 'OTHER', description, priority = 'NORMAL', images = [] } = req.body;
    const orgId = req.user.org_id;

    if (!apartment_id || !title?.trim() || !description?.trim()) {
      return res.status(400).json({
        code: 'VALIDATION_ERROR',
        message: 'Căn hộ, tiêu đề và mô tả sự cố là bắt buộc.',
      });
    }
    if (!VALID_CATEGORIES.includes(category)) {
      return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Danh mục sự cố không hợp lệ.' });
    }
    if (!VALID_PRIORITIES.includes(priority)) {
      return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Mức độ ưu tiên không hợp lệ.' });
    }

    try {
      const aptCheck = await adminPool.query(
        `SELECT a.id, a.building_id, b.org_id
         FROM apartment a
         JOIN building b ON b.id = a.building_id
         WHERE a.id = $1 AND b.org_id = $2`,
        [apartment_id, orgId]
      );
      if (aptCheck.rows.length === 0) {
        return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy căn hộ.' });
      }
      const { building_id: buildingId } = aptCheck.rows[0];
      const ok = await checkBuildingAccess(req, buildingId, 'service_request');
      if (!ok) {
        return res.status(403).json({ code: 'ACCESS_DENIED', message: 'Bạn không quản lý tòa nhà của căn hộ này.' });
      }

      const trackingCode = await generateTrackingCode();
      const ins = await pool.query(
        `INSERT INTO service_request (
           org_id, building_id, apartment_id, created_by, title, category, description, priority, status, tracking_code
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'NEW', $9)
         RETURNING *`,
        [orgId, buildingId, apartment_id, req.user.sub, title.trim(), category, description.trim(), priority, trackingCode]
      );

      const created = ins.rows[0];
      const savedUrls = [];
      const rawImages = Array.isArray(images) ? images.slice(0, 3) : [];
      for (const img of rawImages) {
        if (typeof img === 'string' && img.startsWith('data:image/')) {
          const uploaded = await saveBase64Image({
            imageBase64: img,
            folder: 'service-requests',
            entityId: created.id,
            entity: 'service_request',
            ownerId: created.id,
            req,
            query: (t, p) => pool.query(t, p),
          });
          if (!uploaded.error && uploaded.attachment) {
            savedUrls.push(`/api/v1/attachments/${uploaded.attachment.id}/view`);
          }
        } else if (typeof img === 'string' && img.trim()) {
          savedUrls.push(img.trim());
        }
      }

      if (savedUrls.length > 0) {
        const up = await pool.query(
          `UPDATE service_request SET images = $1 WHERE id = $2 RETURNING *`,
          [savedUrls, created.id]
        );
        return res.status(201).json({ message: 'Tạo yêu cầu bảo trì thành công.', data: up.rows[0] });
      }

      res.status(201).json({ message: 'Tạo yêu cầu bảo trì thành công.', data: created });
    } catch (err) {
      console.error('[Create ServiceRequest Error]:', err);
      res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi khi tạo yêu cầu bảo trì.' });
    }
  }
);

/**
 * GET /api/v1/service-requests/:id
 * Chi tiết yêu cầu + danh sách nhân sự tòa nhà để phân công
 */
router.get(
  '/:id',
  authenticateToken,
  requireRole(['SYS_ADMIN', 'OWNER', 'MANAGER', 'STAFF']),
  async (req, res) => {
    const { id } = req.params;
    const orgId = req.user.org_id;

    try {
      const meta = await adminPool.query(
        'SELECT id, building_id FROM service_request WHERE id = $1 AND org_id = $2',
        [id, orgId]
      );
      if (meta.rows.length === 0) {
        return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy yêu cầu.' });
      }
      const ok = await checkBuildingAccess(req, meta.rows[0].building_id, 'service_request', id);
      if (!ok) {
        return res.status(403).json({ code: 'ACCESS_DENIED', message: 'Bạn không có quyền xem yêu cầu này.' });
      }

      const detailRes = await pool.query(
        `SELECT sr.*,
                a.code AS apartment_code,
                b.name AS building_name,
                b.code AS building_code,
                p_req.full_name AS requester_name,
                p_req.phone AS requester_phone,
                p_ass.full_name AS assigned_to_name,
                p_res.full_name AS resolved_by_name
         FROM service_request sr
         JOIN apartment a ON a.id = sr.apartment_id
         JOIN building b ON b.id = sr.building_id
         LEFT JOIN app_user au_req ON au_req.id = sr.created_by
         LEFT JOIN person p_req ON p_req.id = au_req.person_id
         LEFT JOIN app_user au_ass ON au_ass.id = sr.assigned_to
         LEFT JOIN person p_ass ON p_ass.id = au_ass.person_id
         LEFT JOIN app_user au_res ON au_res.id = sr.resolved_by
         LEFT JOIN person p_res ON p_res.id = au_res.person_id
         WHERE sr.id = $1`,
        [id]
      );

      const assigneesRes = await adminPool.query(
        `SELECT DISTINCT au.id, p.full_name, p.phone, r.code AS role_code
         FROM app_user au
         JOIN person p ON p.id = au.person_id
         JOIN user_role ur ON ur.user_id = au.id
         JOIN role r ON r.id = ur.role_id
         WHERE p.org_id = $1
           AND au.status = 'ACTIVE'
           AND (
             (r.code IN ('MANAGER', 'STAFF') AND ur.building_id = $2)
             OR r.code = 'SYS_ADMIN'
           )
         ORDER BY p.full_name ASC`,
        [orgId, meta.rows[0].building_id]
      );

      res.json({
        data: {
          ...detailRes.rows[0],
          available_assignees: assigneesRes.rows,
        },
      });
    } catch (err) {
      console.error('[ServiceRequest Detail Error]:', err);
      res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi khi tải chi tiết yêu cầu.' });
    }
  }
);

/**
 * PATCH /api/v1/service-requests/:id/status
 * Cập nhật trạng thái, người phụ trách, ghi chú nội bộ (FR-044, FR-045)
 */
router.patch(
  '/:id/status',
  authenticateToken,
  requireRole(['SYS_ADMIN', 'MANAGER', 'STAFF']),
  async (req, res) => {
    const { id } = req.params;
    const { status, assigned_to, internal_note, priority } = req.body;
    const orgId = req.user.org_id;

    if (status && !VALID_STATUSES.includes(status)) {
      return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Trạng thái không hợp lệ.' });
    }
    if (priority && !VALID_PRIORITIES.includes(priority)) {
      return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Mức độ ưu tiên không hợp lệ.' });
    }

    try {
      const existingRes = await adminPool.query(
        'SELECT * FROM service_request WHERE id = $1 AND org_id = $2',
        [id, orgId]
      );
      if (existingRes.rows.length === 0) {
        return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy yêu cầu.' });
      }
      const before = existingRes.rows[0];
      const ok = await checkBuildingAccess(req, before.building_id, 'service_request', id);
      if (!ok) {
        return res.status(403).json({ code: 'ACCESS_DENIED', message: 'Bạn không có quyền xử lý yêu cầu của tòa nhà này.' });
      }

      const nextStatus = status || (assigned_to && before.status === 'NEW' ? 'ASSIGNED' : before.status);
      const nextAssigned = assigned_to !== undefined ? (assigned_to || null) : before.assigned_to;
      const nextNote = internal_note !== undefined ? internal_note : before.internal_note;
      const nextPriority = priority || before.priority;

      const isResolving = nextStatus === 'RESOLVED' && before.status !== 'RESOLVED';
      const resolvedBy = isResolving ? req.user.sub : before.resolved_by;
      const resolvedAt = isResolving ? new Date().toISOString() : before.resolved_at;

      const updated = await pool.query(
        `UPDATE service_request
         SET status = $1,
             assigned_to = $2,
             internal_note = $3,
             priority = $4,
             resolved_by = $5,
             resolved_at = $6,
             updated_at = NOW()
         WHERE id = $7
         RETURNING *`,
        [nextStatus, nextAssigned, nextNote, nextPriority, resolvedBy, resolvedAt, id]
      );

      await pool.query(
        `INSERT INTO audit_log (actor_id, action, entity, entity_id, before, after)
         VALUES ($1, 'UPDATE_STATUS', 'service_request', $2, $3, $4)`,
        [req.user.sub, id, JSON.stringify(before), JSON.stringify(updated.rows[0])]
      );

      // Gửi thông báo cho cư dân tạo yêu cầu khi trạng thái thay đổi
      if (before.created_by && nextStatus !== before.status) {
        const statusTextMap = {
          ASSIGNED: 'đã được phân công kỹ thuật viên',
          IN_PROGRESS: 'đang được xử lý',
          RESOLVED: 'đã hoàn thành xử lý — mời bạn nghiệm thu và đánh giá',
          CLOSED: 'đã đóng',
          CANCELLED: 'đã hủy',
        };
        const statusLabel = statusTextMap[nextStatus] || `chuyển sang ${nextStatus}`;
        await adminPool.query(
          `INSERT INTO notification (org_id, user_id, title, content, type, payload)
           VALUES ($1, $2, $3, $4, 'MAINTENANCE_UPDATE', $5)`,
          [
            orgId,
            before.created_by,
            `Cập nhật yêu cầu #${before.tracking_code}`,
            `Yêu cầu "${before.title}" của bạn ${statusLabel}.`,
            JSON.stringify({ service_request_id: id, tracking_code: before.tracking_code, status: nextStatus }),
          ]
        );
      }

      res.json({ message: 'Cập nhật trạng thái yêu cầu thành công.', data: updated.rows[0] });
    } catch (err) {
      console.error('[ServiceRequest Update Error]:', err);
      res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi khi cập nhật yêu cầu.' });
    }
  }
);

/**
 * POST /api/v1/service-requests/:id/rating
 * Đánh giá chất lượng xử lý (1-5 sao) (FR-046)
 */
router.post('/:id/rating', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const { rating, rating_note } = req.body;
  const numRating = Number(rating);

  if (!Number.isInteger(numRating) || numRating < 1 || numRating > 5) {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Điểm đánh giá phải từ 1 đến 5 sao.' });
  }

  try {
    const existingRes = await adminPool.query(
      'SELECT * FROM service_request WHERE id = $1 AND org_id = $2',
      [id, req.user.org_id]
    );
    if (existingRes.rows.length === 0) {
      return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy yêu cầu.' });
    }
    const sr = existingRes.rows[0];
    const roles = getUserRoleCodes(req);

    if (!roles.includes('SYS_ADMIN') && sr.created_by !== req.user.sub) {
      const ok = await checkBuildingAccess(req, sr.building_id, 'service_request', id);
      if (!ok) {
        await logAccessDenied(req, 'service_request', id, 'Unauthorized rating attempt');
        return res.status(403).json({ code: 'ACCESS_DENIED', message: 'Bạn không có quyền đánh giá yêu cầu này.' });
      }
    }

    if (!['RESOLVED', 'CLOSED'].includes(sr.status)) {
      return res.status(409).json({
        code: 'INVALID_STATUS',
        message: 'Chỉ có thể đánh giá các yêu cầu đã hoàn thành xử lý (RESOLVED).',
      });
    }

    const updated = await pool.query(
      `UPDATE service_request
       SET rating = $1,
           rating_note = $2,
           status = 'CLOSED',
           updated_at = NOW()
       WHERE id = $3
       RETURNING *`,
      [numRating, rating_note?.trim() || null, id]
    );

    res.json({ message: 'Cảm ơn bạn đã gửi đánh giá!', data: updated.rows[0] });
  } catch (err) {
    console.error('[ServiceRequest Rating Error]:', err);
    res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi khi lưu đánh giá.' });
  }
});

export default router;
