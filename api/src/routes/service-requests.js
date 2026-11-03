import express from 'express';
import { pool, getUserClient } from '../db/client.js';
import { authenticateToken } from '../middleware/auth.js';
import { requireRole } from '../middleware/rbac.js';
import { idempotencyGuard } from '../middleware/idempotency.js';
import { saveBase64Image } from '../services/imageUpload.js';
import {
  getUserRoleCodes,
  scopedBuildingFilter,
  checkBuildingAccess,
  logAccessDenied,
} from '../services/ownerScope.js';
import {
  SERVICE_REQUEST_OPEN_STATUSES,
  PREFERRED_SLOT_CODES,
  buildServiceRequestTrackingPrefix,
  computeServiceRequestSlaDeadlines,
  isWithinDuplicateWindow,
  validateServiceRequestTransition,
} from '../services/serviceRequestRules.js';
import { formatServiceRequestForRoomZalo } from '../services/zaloFormatter.js';

const router = express.Router();

const VALID_CATEGORIES = ['ELECTRICAL', 'PLUMBING', 'HVAC', 'FURNITURE', 'APPLIANCE', 'CLEANING', 'SECURITY', 'OTHER'];
const VALID_PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT'];
const VALID_STATUSES = [
  'NEW',
  'ASSIGNED',
  'IN_PROGRESS',
  'ON_HOLD',
  'RESOLVED',
  'REOPENED',
  'CLOSED',
  'CANCELLED',
];

function buildTrackingCandidate(now = new Date(), attempt = 0) {
  const prefix = buildServiceRequestTrackingPrefix(now);
  const digits = attempt === 0 ? Math.floor(1000 + Math.random() * 9000) : Math.floor(10000 + Math.random() * 90000);
  return `${prefix}${digits}`;
}

async function loadOrgSettingsMap(queryFn, orgId) {
  const res = await queryFn(
    `SELECT key, value FROM system_setting WHERE org_id = $1 AND key IN ('sla_config', 'contact_config')`,
    [orgId]
  );
  return Object.fromEntries(res.rows.map((r) => [r.key, r.value || {}]));
}

/**
 * GET /api/v1/service-requests
 * Danh sách yêu cầu & báo hỏng (M11)
 */
router.get(
  '/',
  authenticateToken,
  requireRole(['SYS_ADMIN', 'OWNER', 'MANAGER']),
  async (req, res) => {
    const { building_id, status, category, priority, overdue_sla, search } = req.query;
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
               (
                 sr.status = ANY(ARRAY['NEW','ASSIGNED','IN_PROGRESS','ON_HOLD','REOPENED']::text[])
                 AND sr.sla_due_at IS NOT NULL
                 AND sr.sla_due_at < NOW()
               ) AS is_sla_overdue,
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
      if (String(overdue_sla || '').toLowerCase() === 'true') {
        params.push(SERVICE_REQUEST_OPEN_STATUSES);
        sql += ` AND sr.status = ANY($${params.length}::text[]) AND sr.sla_due_at IS NOT NULL AND sr.sla_due_at < NOW()`;
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
 * Quản lý tòa nhà tạo yêu cầu bảo trì cho căn hộ (MANAGER only - PRD 6.2)
 */
router.post(
  '/',
  authenticateToken,
  requireRole(['MANAGER']),
  idempotencyGuard(),
  async (req, res) => {
    const {
      apartment_id,
      title,
      category = 'OTHER',
      description,
      location_detail,
      preferred_slot,
      priority = 'NORMAL',
      images = [],
      ignore_duplicate_warning = false,
      confirm_duplicate = false,
    } = req.body;
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
    const normSlot = preferred_slot ? String(preferred_slot).trim().toUpperCase() : null;
    if (normSlot && !PREFERRED_SLOT_CODES.includes(normSlot)) {
      return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Khung giờ hẹn không hợp lệ.' });
    }
    if (Array.isArray(images) && images.length > 3) {
      return res.status(400).json({
        code: 'TOO_MANY_IMAGES',
        message: 'Chỉ được đính kèm tối đa 3 ảnh minh họa.',
      });
    }

    const { client, release } = await getUserClient(req);
    let inTx = false;
    try {
      const scopeRes = await client.query(
        `SELECT * FROM fn_get_ops_resource_scope('apartment', $1)`,
        [apartment_id]
      );
      if (scopeRes.rows.length === 0) {
        return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy căn hộ.' });
      }
      const { building_id: buildingId } = scopeRes.rows[0];
      const ok = await checkBuildingAccess(req, buildingId, 'service_request');
      if (!ok) {
        return res.status(403).json({
          code: 'ACCESS_DENIED',
          message: 'Bạn không quản lý tòa nhà của căn hộ này.',
        });
      }

      if (!ignore_duplicate_warning && !confirm_duplicate) {
        const dupCheck = await client.query(
          `SELECT id, tracking_code, title, status, created_at
           FROM service_request
           WHERE apartment_id = $1
             AND category = $2
             AND status = ANY($3::text[])
           ORDER BY created_at DESC
           LIMIT 1`,
          [apartment_id, category, SERVICE_REQUEST_OPEN_STATUSES]
        );
        if (
          dupCheck.rows.length > 0 &&
          isWithinDuplicateWindow({
            existingCreatedAt: dupCheck.rows[0].created_at,
            existingStatus: dupCheck.rows[0].status,
          })
        ) {
          return res.status(409).json({
            code: 'DUPLICATE_SERVICE_REQUEST',
            message: `Căn hộ đang có yêu cầu cùng hạng mục trong 24 giờ qua (${dupCheck.rows[0].tracking_code}).`,
            existing_request: dupCheck.rows[0],
          });
        }
      }

      const settingsMap = await loadOrgSettingsMap((s, p) => client.query(s, p), orgId);
      const now = new Date();
      const { slaResponseDueAt, slaDueAt } = computeServiceRequestSlaDeadlines({
        createdAt: now,
        priority,
        slaConfig: settingsMap.sla_config || {},
      });

      await client.query('BEGIN');
      inTx = true;

      let created = null;
      for (let attempt = 0; attempt < 5; attempt++) {
        const candidateCode = buildTrackingCandidate(now, attempt);
        await client.query('SAVEPOINT sp_mgr_sr_insert');
        try {
          const ins = await client.query(
            `INSERT INTO service_request (
               org_id, building_id, apartment_id, created_by,
               title, category, description, location_detail, preferred_slot,
               priority, status, tracking_code, sla_response_due_at, sla_due_at
             )
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'NEW', $11, $12, $13)
             RETURNING *`,
            [
              orgId,
              buildingId,
              apartment_id,
              req.user.sub,
              title.trim(),
              category,
              description.trim(),
              location_detail?.trim() || null,
              normSlot,
              priority,
              candidateCode,
              slaResponseDueAt.toISOString(),
              slaDueAt.toISOString(),
            ]
          );
          await client.query('RELEASE SAVEPOINT sp_mgr_sr_insert');
          created = ins.rows[0];
          break;
        } catch (insErr) {
          await client.query('ROLLBACK TO SAVEPOINT sp_mgr_sr_insert');
          if (insErr.code === '23505' && attempt < 4) continue;
          throw insErr;
        }
      }

      const savedUrls = [];
      const rawImages = Array.isArray(images) ? images.slice(0, 3) : [];
      for (const img of rawImages) {
        if (typeof img === 'string' && img.startsWith('data:image/')) {
          const uploaded = await saveBase64Image({
            imageBase64: img,
            folder: 'service_request',
            entityId: created.id,
            entity: 'service_request',
            ownerId: created.id,
            req,
            query: (t, p) => client.query(t, p),
          });
          if (uploaded.error) {
            await client.query('ROLLBACK');
            inTx = false;
            return res.status(400).json(uploaded.error);
          }
          savedUrls.push(`/api/v1/attachments/${uploaded.attachment.id}/view`);
        } else if (typeof img === 'string' && img.trim()) {
          savedUrls.push(img.trim());
        }
      }

      let finalRow = created;
      if (savedUrls.length > 0) {
        const up = await client.query(
          `UPDATE service_request SET images = $1 WHERE id = $2 RETURNING *`,
          [savedUrls, created.id]
        );
        finalRow = up.rows[0];
      }

      await client.query(
        `INSERT INTO audit_log (actor_id, action, entity, entity_id, after)
         VALUES ($1, 'CREATE_SERVICE_REQUEST', 'service_request', $2, $3)`,
        [req.user.sub, finalRow.id, JSON.stringify(finalRow)]
      );

      await client.query('COMMIT');
      inTx = false;

      res.status(201).json({ message: 'Tạo yêu cầu bảo trì thành công.', data: finalRow });
    } catch (err) {
      if (inTx) {
        await client.query('ROLLBACK').catch(() => {});
      }
      console.error('[Create ServiceRequest Error]:', err);
      res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi khi tạo yêu cầu bảo trì.' });
    } finally {
      await release();
    }
  }
);

/**
 * GET /api/v1/service-requests/:id
 * Chi tiết yêu cầu + nhân sự phân công + lịch sử audit + nhóm Zalo phòng & mẫu tin nhắn Zalo
 */
router.get(
  '/:id',
  authenticateToken,
  requireRole(['SYS_ADMIN', 'OWNER', 'MANAGER']),
  async (req, res) => {
    const { id } = req.params;
    const orgId = req.user.org_id;

    const { client, release } = await getUserClient(req);
    try {
      const scopeRes = await client.query(
        `SELECT * FROM fn_get_ops_resource_scope('service_request', $1)`,
        [id]
      );
      if (scopeRes.rows.length === 0) {
        return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy yêu cầu.' });
      }
      const buildingId = scopeRes.rows[0].building_id;
      const ok = await checkBuildingAccess(req, buildingId, 'service_request', id);
      if (!ok) {
        return res.status(403).json({ code: 'ACCESS_DENIED', message: 'Bạn không có quyền xem yêu cầu này.' });
      }

      const detailRes = await client.query(
        `SELECT sr.*,
                (
                  sr.status = ANY(ARRAY['NEW','ASSIGNED','IN_PROGRESS','ON_HOLD','REOPENED']::text[])
                  AND sr.sla_due_at IS NOT NULL
                  AND sr.sla_due_at < NOW()
                ) AS is_sla_overdue,
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
      if (detailRes.rows.length === 0) {
        return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy yêu cầu.' });
      }
      const sr = detailRes.rows[0];

      const assigneesRes = await client.query(
        `SELECT * FROM fn_list_building_assignees($1)`,
        [buildingId]
      );

      const timelineRes = await client.query(
        `SELECT al.id,
                al.actor_id,
                al.action,
                al.entity,
                al.entity_id,
                al.before,
                al.after,
                al.at,
                al.at AS created_at,
                p.full_name AS actor_name
         FROM audit_log al
         LEFT JOIN app_user au ON au.id = al.actor_id
         LEFT JOIN person p ON p.id = au.person_id
         WHERE al.entity = 'service_request'
           AND al.entity_id = $1
         ORDER BY al.id DESC
         LIMIT 50`,
        [id]
      );

      const zaloGroupRes = await client.query(
        `SELECT id, scope, building_id, apartment_id, name, invite_link, note
         FROM zalo_group
         WHERE building_id = $1
           AND is_active = TRUE
           AND (apartment_id = $2 OR scope = 'BUILDING')
         ORDER BY (CASE WHEN apartment_id = $2 THEN 0 ELSE 1 END), created_at ASC
         LIMIT 1`,
        [buildingId, sr.apartment_id]
      );
      const apartmentZaloGroup = zaloGroupRes.rows[0] || null;

      const settingsMap = await loadOrgSettingsMap((s, p) => client.query(s, p), orgId);
      const zaloRoomMessagePreview = formatServiceRequestForRoomZalo({
        trackingCode: sr.tracking_code,
        category: sr.category,
        title: sr.title,
        status: sr.status,
        apartmentCode: sr.apartment_code,
        buildingCode: sr.building_code,
        preferredSlot: sr.preferred_slot,
        nextAppointmentAt: sr.next_appointment_at,
        resolutionNote: sr.resolution_note,
        assigneeName: sr.assigned_to_name,
        contactConfig: settingsMap.contact_config || {},
      });

      res.json({
        data: {
          ...sr,
          available_assignees: assigneesRes.rows,
          audit_timeline: timelineRes.rows,
          apartment_zalo_group: apartmentZaloGroup,
          zalo_room_message_preview: zaloRoomMessagePreview,
        },
      });
    } catch (err) {
      console.error('[ServiceRequest Detail Error]:', err);
      res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi khi tải chi tiết yêu cầu.' });
    } finally {
      await release();
    }
  }
);

/**
 * PATCH /api/v1/service-requests/:id/status
 * Cập nhật trạng thái, người phụ trách, tạm hoãn, nghiệm thu & ghi chú nội bộ (MANAGER only - FR-044, FR-045)
 */
router.patch(
  '/:id/status',
  authenticateToken,
  requireRole(['MANAGER']),
  idempotencyGuard(),
  async (req, res) => {
    const { id } = req.params;
    const {
      status,
      assigned_to,
      internal_note,
      resolution_note,
      resolution_images,
      hold_reason,
      next_appointment_at,
      priority,
    } = req.body;
    const orgId = req.user.org_id;

    if (status && !VALID_STATUSES.includes(status)) {
      return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Trạng thái không hợp lệ.' });
    }
    if (priority && !VALID_PRIORITIES.includes(priority)) {
      return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Mức độ ưu tiên không hợp lệ.' });
    }
    if (Array.isArray(resolution_images) && resolution_images.length > 3) {
      return res.status(400).json({
        code: 'TOO_MANY_IMAGES',
        message: 'Chỉ được đính kèm tối đa 3 ảnh kết quả xử lý.',
      });
    }

    const { client, release } = await getUserClient(req);
    let inTx = false;
    try {
      const scopeRes = await client.query(
        `SELECT * FROM fn_get_ops_resource_scope('service_request', $1)`,
        [id]
      );
      if (scopeRes.rows.length === 0) {
        return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy yêu cầu.' });
      }
      const buildingId = scopeRes.rows[0].building_id;
      const ok = await checkBuildingAccess(req, buildingId, 'service_request', id);
      if (!ok) {
        return res.status(403).json({
          code: 'ACCESS_DENIED',
          message: 'Bạn không có quyền xử lý yêu cầu của tòa nhà này.',
        });
      }

      const existingRes = await client.query(`SELECT * FROM service_request WHERE id = $1`, [id]);
      if (existingRes.rows.length === 0) {
        return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy yêu cầu.' });
      }
      const before = existingRes.rows[0];

      const nextStatus = status || (assigned_to && before.status === 'NEW' ? 'ASSIGNED' : before.status);
      const effectiveHoldReason =
        hold_reason !== undefined ? (hold_reason ? String(hold_reason).trim() : '') : before.hold_reason || '';

      const transitionCheck = validateServiceRequestTransition({
        fromStatus: before.status,
        toStatus: nextStatus,
        actorRole: 'MANAGER',
        holdReason: effectiveHoldReason,
      });
      if (!transitionCheck.valid) {
        const httpCode = transitionCheck.code === 'HOLD_REASON_REQUIRED' ? 422 : 409;
        return res.status(httpCode).json({
          code: transitionCheck.code,
          message: transitionCheck.message,
        });
      }

      const nextAssigned = assigned_to !== undefined ? assigned_to || null : before.assigned_to;
      const nextInternalNote = internal_note !== undefined ? internal_note : before.internal_note;
      const nextResolutionNote =
        resolution_note !== undefined ? (resolution_note === null ? null : String(resolution_note).trim() || null) : before.resolution_note;
      const nextHoldReason =
        hold_reason !== undefined ? (effectiveHoldReason || null) : before.hold_reason;
      const nextAppointment =
        next_appointment_at !== undefined
          ? next_appointment_at || null
          : nextStatus === 'ON_HOLD'
          ? before.next_appointment_at
          : null;
      const nextPriority = priority || before.priority;

      const isResolving = nextStatus === 'RESOLVED' && before.status !== 'RESOLVED';
      const resolvedBy = isResolving ? req.user.sub : before.resolved_by;
      const resolvedAt = isResolving ? new Date().toISOString() : before.resolved_at;
      const firstRespondedAt =
        nextStatus !== 'NEW'
          ? before.first_responded_at || new Date().toISOString()
          : before.first_responded_at;

      let nextSlaDueAt = before.sla_due_at;
      if (nextPriority === 'URGENT' && before.priority !== 'URGENT') {
        const settingsMap = await loadOrgSettingsMap((s, p) => client.query(s, p), orgId);
        const { slaDueAt } = computeServiceRequestSlaDeadlines({
          createdAt: before.created_at,
          priority: 'URGENT',
          slaConfig: settingsMap.sla_config || {},
        });
        nextSlaDueAt = slaDueAt.toISOString();
      }

      await client.query('BEGIN');
      inTx = true;

      let nextResolutionImages = Array.isArray(before.resolution_images)
        ? before.resolution_images
        : [];
      if (Array.isArray(resolution_images)) {
        const savedResUrls = [];
        for (const img of resolution_images.slice(0, 3)) {
          if (typeof img === 'string' && img.startsWith('data:image/')) {
            const uploaded = await saveBase64Image({
              imageBase64: img,
              folder: 'service_request',
              entityId: id,
              entity: 'service_request',
              ownerId: id,
              req,
              query: (t, p) => client.query(t, p),
            });
            if (uploaded.error) {
              await client.query('ROLLBACK');
              inTx = false;
              return res.status(400).json(uploaded.error);
            }
            savedResUrls.push(`/api/v1/attachments/${uploaded.attachment.id}/view`);
          } else if (typeof img === 'string' && img.trim()) {
            savedResUrls.push(img.trim());
          }
        }
        nextResolutionImages = savedResUrls;
      }

      const updated = await client.query(
        `UPDATE service_request
         SET status = $1,
             assigned_to = $2,
             internal_note = $3,
             resolution_note = $4,
             resolution_images = $5::jsonb,
             hold_reason = $6,
             next_appointment_at = $7,
             priority = $8,
             resolved_by = $9,
             resolved_at = $10,
             first_responded_at = $11,
             sla_due_at = $12,
             updated_at = NOW()
         WHERE id = $13
         RETURNING *`,
        [
          nextStatus,
          nextAssigned,
          nextInternalNote,
          nextResolutionNote,
          JSON.stringify(nextResolutionImages),
          nextHoldReason,
          nextAppointment,
          nextPriority,
          resolvedBy,
          resolvedAt,
          firstRespondedAt,
          nextSlaDueAt,
          id,
        ]
      );
      const afterRow = updated.rows[0];

      await client.query(
        `INSERT INTO audit_log (actor_id, action, entity, entity_id, before, after)
         VALUES ($1, 'UPDATE_SERVICE_REQUEST', 'service_request', $2, $3, $4)`,
        [req.user.sub, id, JSON.stringify(before), JSON.stringify(afterRow)]
      );

      // Notify newly assigned technician/manager
      if (nextAssigned && nextAssigned !== before.assigned_to && nextAssigned !== req.user.sub) {
        await client.query(
          `INSERT INTO notification (org_id, user_id, title, content, type, payload)
           VALUES ($1, $2, $3, $4, 'SERVICE_REQUEST_ASSIGNED', $5::jsonb)`,
          [
            orgId,
            nextAssigned,
            `Được phân công xử lý #${before.tracking_code}`,
            `Bạn vừa được giao xử lý yêu cầu "${before.title}".`,
            JSON.stringify({
              sent_by: req.user.sub,
              service_request_id: id,
              tracking_code: before.tracking_code,
              status: nextStatus,
            }),
          ]
        );
      }

      // Notify resident (never include internal_note in notification content or payload!)
      if (before.created_by && (nextStatus !== before.status || resolution_note !== undefined)) {
        const statusTextMap = {
          ASSIGNED: 'đã được phân công kỹ thuật viên',
          IN_PROGRESS: 'đang được xử lý',
          ON_HOLD: `tạm hoãn / hẹn lại xử lý${nextHoldReason ? ` (Lý do: ${nextHoldReason})` : ''}`,
          RESOLVED: `đã hoàn thành xử lý${nextResolutionNote ? `: ${nextResolutionNote}` : ''} — mời bạn nghiệm thu và đánh giá`,
          CLOSED: 'đã đóng',
          CANCELLED: 'đã hủy',
        };
        const statusLabel = statusTextMap[nextStatus] || `chuyển sang ${nextStatus}`;
        await client.query(
          `INSERT INTO notification (org_id, user_id, title, content, type, payload)
           VALUES ($1, $2, $3, $4, 'MAINTENANCE_UPDATE', $5::jsonb)`,
          [
            orgId,
            before.created_by,
            `Cập nhật yêu cầu #${before.tracking_code}`,
            `Yêu cầu "${before.title}" của bạn ${statusLabel}.`,
            JSON.stringify({
              sent_by: req.user.sub,
              service_request_id: id,
              tracking_code: before.tracking_code,
              status: nextStatus,
            }),
          ]
        );
      }

      await client.query('COMMIT');
      inTx = false;

      res.json({ message: 'Cập nhật trạng thái yêu cầu thành công.', data: afterRow });
    } catch (err) {
      if (inTx) {
        await client.query('ROLLBACK').catch(() => {});
      }
      console.error('[ServiceRequest Update Error]:', err);
      res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi khi cập nhật yêu cầu.' });
    } finally {
      await release();
    }
  }
);

/**
 * POST /api/v1/service-requests/:id/rating
 * Đánh giá chất lượng xử lý (1-5 sao) — tương thích ngược cho cư dân gọi trực tiếp
 */
router.post('/:id/rating', authenticateToken, idempotencyGuard(), async (req, res) => {
  const { id } = req.params;
  const { rating, rating_note } = req.body;
  const numRating = Number(rating);

  if (!Number.isInteger(numRating) || numRating < 1 || numRating > 5) {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Điểm đánh giá phải từ 1 đến 5 sao.' });
  }

  const roles = getUserRoleCodes(req);
  if (roles.includes('SYS_ADMIN') || roles.includes('OWNER')) {
    return res.status(403).json({
      code: 'FORBIDDEN_ROLE',
      message: 'Vai trò hiện tại chỉ có quyền xem yêu cầu.',
    });
  }

  const { client, release } = await getUserClient(req);
  let inTx = false;
  try {
    const scopeRes = await client.query(
      `SELECT * FROM fn_get_ops_resource_scope('service_request', $1)`,
      [id]
    );
    if (scopeRes.rows.length === 0) {
      return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy yêu cầu.' });
    }

    const existingRes = await client.query(
      `SELECT sr.*, a.code AS apartment_code
       FROM service_request sr
       JOIN apartment a ON a.id = sr.apartment_id
       WHERE sr.id = $1`,
      [id]
    );
    if (existingRes.rows.length === 0) {
      await logAccessDenied(req, 'service_request', id, 'Unauthorized rating attempt');
      return res.status(403).json({ code: 'ACCESS_DENIED', message: 'Bạn không có quyền đánh giá yêu cầu này.' });
    }
    const sr = existingRes.rows[0];

    if (!['RESOLVED', 'CLOSED'].includes(sr.status)) {
      return res.status(409).json({
        code: 'INVALID_STATUS',
        message: 'Chỉ có thể đánh giá các yêu cầu đã hoàn thành xử lý (RESOLVED).',
      });
    }

    await client.query('BEGIN');
    inTx = true;

    const updated = await client.query(
      `UPDATE service_request
       SET rating = $1,
           rating_note = $2,
           status = 'CLOSED',
           updated_at = NOW()
       WHERE id = $3
       RETURNING *`,
      [numRating, rating_note?.trim() || null, id]
    );

    const { internal_note: _stripBefore, apartment_code: _aptCode, ...safeBefore } = sr;
    const { internal_note: _stripAfter, ...safeData } = updated.rows[0];

    await client.query(
      `SELECT fn_notify_service_request_managers($1, $2, $3, $4, $5::jsonb)`,
      [
        id,
        'SERVICE_REQUEST_RATED',
        `Cư dân căn ${sr.apartment_code} đánh giá ${numRating}/5 sao (${sr.tracking_code})`,
        rating_note?.trim()
          ? `Nhận xét: ${rating_note.trim()}`
          : `Đã nghiệm thu đóng phiếu ${sr.tracking_code}.`,
        JSON.stringify({
          rating: numRating,
          apartment_code: sr.apartment_code,
        }),
      ]
    );

    await client.query(
      `INSERT INTO audit_log (actor_id, action, entity, entity_id, before, after)
       VALUES ($1, 'RATE_SERVICE_REQUEST', 'service_request', $2, $3, $4)`,
      [req.user.sub, id, JSON.stringify(safeBefore), JSON.stringify(safeData)]
    );

    await client.query('COMMIT');
    inTx = false;

    res.json({ message: 'Cảm ơn bạn đã gửi đánh giá!', data: safeData });
  } catch (err) {
    if (inTx) {
      await client.query('ROLLBACK').catch(() => {});
    }
    console.error('[ServiceRequest Rating Error]:', err);
    res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi khi lưu đánh giá.' });
  } finally {
    await release();
  }
});

export default router;
