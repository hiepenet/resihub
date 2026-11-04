import express from 'express';
import { pool, getUserClient } from '../db/client.js';
import { authenticateToken } from '../middleware/auth.js';
import { requireRole } from '../middleware/rbac.js';
import { idempotencyGuard } from '../middleware/idempotency.js';
import {
  getUserRoleCodes,
  getManagerBuildingIds,
  scopedBuildingFilter,
  checkBuildingAccess,
  logAccessDenied,
} from '../services/ownerScope.js';
import { formatAnnouncementForZalo } from '../services/zaloFormatter.js';
import {
  enrichNotificationsContext,
  filterNotificationsSqlClause,
} from '../services/notificationService.js';
import {
  ANNOUNCEMENT_SCOPES,
  normalizeAnnouncementType,
  resolveOpsScope,
  loadOrgContactConfig,
  loadScopeLabels,
  resolveTargetZaloGroups,
  fanOutAnnouncementInTx,
} from './announcements.js';

const router = express.Router();

/**
 * GET /api/v1/notifications
 * Lấy danh sách thông báo cá nhân, số lượng chưa đọc và lịch sử thông báo đã phát hành (FR-053 / M13)
 */
router.get('/', authenticateToken, async (req, res) => {
  const { client, release } = await getUserClient(req);
  try {
    const orgId = req.user.org_id;
    const userId = req.user.sub;
    const roles = getUserRoleCodes(req);
    const roleFilterSql = filterNotificationsSqlClause(roles);

    const listResult = await client.query(
      `SELECT * FROM notification
       WHERE org_id = $1 AND (user_id IS NULL OR user_id = $2)${roleFilterSql}
       ORDER BY created_at DESC
       LIMIT 80`,
      [orgId, userId]
    );

    const countResult = await client.query(
      `SELECT COUNT(*)::int AS unread_count FROM notification
       WHERE org_id = $1 AND (user_id IS NULL OR user_id = $2)${roleFilterSql} AND read_at IS NULL`,
      [orgId, userId]
    );

    const enrichedRows = await enrichNotificationsContext(listResult.rows, orgId);

    let sentHistory = [];
    if (roles.some((r) => ['SYS_ADMIN', 'OWNER', 'MANAGER'].includes(r))) {
      const params = [orgId];
      let bldgClause = '';
      if (!roles.includes('SYS_ADMIN')) {
        const { sql: scopeSql } = await scopedBuildingFilter(req, 'ann.building_id', params);
        bldgClause = scopeSql || '';
      }
      const sentRes = await client.query(
        `SELECT ann.id,
                ann.id AS announcement_id,
                ann.title,
                ann.body AS content,
                ann.type,
                jsonb_build_object(
                  'announcement_id', ann.id,
                  'target_scope', ann.target_scope,
                  'building_id', ann.building_id,
                  'floor_id', ann.floor_id,
                  'apartment_id', ann.apartment_id,
                  'sent_by', ann.created_by
                ) AS payload,
                COALESCE(ann.sent_at, ann.created_at) AS created_at,
                ann.recipient_count,
                (
                  SELECT COUNT(*)::int
                  FROM notification n
                  WHERE n.announcement_id = ann.id AND n.read_at IS NOT NULL
                ) AS read_count,
                ann.zalo_content,
                ann.manual_sent_at,
                b.code AS building_code,
                b.name AS building_name,
                f.name AS floor_name,
                a.code AS apartment_code
         FROM announcement ann
         JOIN building b ON b.id = ann.building_id
         LEFT JOIN floor f ON f.id = ann.floor_id
         LEFT JOIN apartment a ON a.id = ann.apartment_id
         WHERE ann.org_id = $1
           AND ann.status = 'SENT'
           ${bldgClause}
         ORDER BY COALESCE(ann.sent_at, ann.created_at) DESC
         LIMIT 40`,
        params
      );
      sentHistory = sentRes.rows;
    }

    res.json({
      data: enrichedRows,
      sent_history: sentHistory,
      unread_count: countResult.rows[0]?.unread_count || 0,
    });
  } catch (err) {
    console.error('[Notifications Error]:', err);
    res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi khi lấy danh sách thông báo.' });
  } finally {
    await release();
  }
});

/**
 * POST /api/v1/notifications (M13, PRD 6.2)
 * Gửi thông báo vận hành ngay theo tòa (BUILDING), tầng (FLOOR) hoặc căn hộ (APARTMENT).
 * Chỉ MANAGER của tòa được phép phát thông báo (SYS_ADMIN và OWNER 100% Read-Only -> 403).
 */
router.post('/', authenticateToken, requireRole(['MANAGER']), idempotencyGuard(), async (req, res) => {
  const {
    title,
    content,
    body,
    type = 'ANNOUNCEMENT',
    target_scope = 'BUILDING',
    building_id,
    floor_id = null,
    apartment_id = null,
    zalo_content,
  } = req.body || {};

  const bodyText = String(content ?? body ?? '').trim();
  const orgId = req.user.org_id;

  if (!title?.trim() || !bodyText) {
    return res.status(400).json({
      code: 'VALIDATION_ERROR',
      message: 'Tiêu đề và nội dung thông báo là bắt buộc.',
    });
  }

  let normScope = String(target_scope || 'BUILDING').trim().toUpperCase();
  if (normScope === 'ALL') {
    return res.status(403).json({
      code: 'FORBIDDEN_SCOPE',
      message: 'Quản lý tòa nhà chỉ được gửi thông báo trong phạm vi tòa nhà được phân công.',
    });
  }
  if (apartment_id) normScope = 'APARTMENT';
  else if (floor_id && normScope !== 'APARTMENT') normScope = 'FLOOR';

  if (!ANNOUNCEMENT_SCOPES.includes(normScope)) {
    return res.status(400).json({
      code: 'VALIDATION_ERROR',
      message: 'Phạm vi nhận thông báo phải là BUILDING, FLOOR hoặc APARTMENT.',
    });
  }

  const { client, release } = await getUserClient(req);
  let txStarted = false;

  try {
    const queryFn = (sql, params) => client.query(sql, params);
    let targetBuildingId = building_id || null;

    if (targetBuildingId) {
      const bScope = await resolveOpsScope(queryFn, 'building', targetBuildingId);
      if (!bScope) {
        return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy tòa nhà.' });
      }
    } else if (apartment_id) {
      const aScope = await resolveOpsScope(queryFn, 'apartment', apartment_id);
      if (!aScope) {
        return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy căn hộ.' });
      }
      targetBuildingId = aScope.building_id;
    } else if (floor_id) {
      const fScope = await resolveOpsScope(queryFn, 'floor', floor_id);
      if (!fScope) {
        return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy tầng.' });
      }
      targetBuildingId = fScope.building_id;
    } else {
      const mgrIds = await getManagerBuildingIds(req.user.sub, orgId);
      if (mgrIds.length === 0) {
        return res.status(403).json({
          code: 'ACCESS_DENIED',
          message: 'Bạn chưa được phân công quản lý tòa nhà nào.',
        });
      }
      targetBuildingId = mgrIds[0];
    }

    const allowed = await checkBuildingAccess(req, targetBuildingId);
    if (!allowed) {
      await logAccessDenied(req, 'notification', targetBuildingId, 'MANAGER attempted POST /notifications on unassigned building');
      return res.status(403).json({
        code: 'ACCESS_DENIED',
        message: 'Bạn không quản lý tòa nhà này.',
      });
    }

    const effFloorId = normScope === 'FLOOR' ? floor_id : null;
    const effApartmentId = normScope === 'APARTMENT' ? apartment_id : null;

    if (effFloorId) {
      const fScope = await resolveOpsScope(queryFn, 'floor', effFloorId);
      if (!fScope || fScope.building_id !== targetBuildingId) {
        return res.status(422).json({
          code: 'FLOOR_BUILDING_MISMATCH',
          message: 'Tầng đã chọn không thuộc tòa nhà này.',
        });
      }
    }
    if (effApartmentId) {
      const aScope = await resolveOpsScope(queryFn, 'apartment', effApartmentId);
      if (!aScope || aScope.building_id !== targetBuildingId) {
        return res.status(422).json({
          code: 'APARTMENT_BUILDING_MISMATCH',
          message: 'Căn hộ đã chọn không thuộc tòa nhà này.',
        });
      }
    }

    const normType = normalizeAnnouncementType(type);
    const labels = await loadScopeLabels(queryFn, {
      building_id: targetBuildingId,
      floor_id: effFloorId,
      apartment_id: effApartmentId,
    });
    const contactConfig = await loadOrgContactConfig(queryFn, orgId);
    const nowDt = new Date();
    const formattedZalo =
      zalo_content?.trim() ||
      formatAnnouncementForZalo({
        type: normType,
        title: title.trim(),
        body: bodyText,
        targetScope: normScope,
        buildingCode: labels.buildingCode,
        buildingName: labels.buildingName,
        floorName: labels.floorName,
        apartmentCode: labels.apartmentCode,
        contactConfig,
        scheduledOrSentAt: nowDt,
      });

    await client.query('BEGIN');
    txStarted = true;

    const annIns = await client.query(
      `INSERT INTO announcement (
         org_id, building_id, target_scope, floor_id, apartment_id,
         type, title, body, zalo_content, status, created_by
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'DRAFT', $10)
       RETURNING *`,
      [
        orgId,
        targetBuildingId,
        normScope,
        effFloorId,
        effApartmentId,
        normType,
        title.trim(),
        bodyText,
        formattedZalo,
        req.user.sub,
      ]
    );

    const { announcement: sentAnnouncement, recipientIds, firstNotification } =
      await fanOutAnnouncementInTx(queryFn, {
        announcementRow: annIns.rows[0],
        senderUserId: req.user.sub,
        senderName: req.user.full_name || 'Ban Quản Lý',
        sentAt: nowDt,
      });

    await client.query(
      `INSERT INTO audit_log (actor_id, action, entity, entity_id, after)
       VALUES ($1, 'SEND_ANNOUNCEMENT', 'announcement', $2, $3)`,
      [req.user.sub, sentAnnouncement.id, JSON.stringify(sentAnnouncement)]
    );

    const targetZaloGroups = await resolveTargetZaloGroups(queryFn, {
      building_id: targetBuildingId,
      target_scope: normScope,
      floor_id: effFloorId,
      apartment_id: effApartmentId,
    });

    await client.query('COMMIT');
    txStarted = false;

    res.status(201).json({
      message: `Đã gửi thông báo thành công tới ${recipientIds.length} cư dân.`,
      data: firstNotification || sentAnnouncement,
      recipient_count: recipientIds.length,
      announcement_id: sentAnnouncement.id,
      zalo_content: sentAnnouncement.zalo_content,
      target_zalo_groups: targetZaloGroups,
    });
  } catch (err) {
    if (txStarted) {
      await client.query('ROLLBACK').catch(() => {});
    }
    console.error('[Create Notification Error]:', err);
    res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi khi tạo và gửi thông báo.' });
  } finally {
    await release();
  }
});

/**
 * PATCH /api/v1/notifications/:id/read
 */
router.patch('/:id/read', authenticateToken, async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query(
      `UPDATE notification
       SET read_at = NOW()
       WHERE id = $1 AND org_id = $2 AND (user_id = $3 OR user_id IS NULL) AND read_at IS NULL
       RETURNING *`,
      [id, req.user.org_id, req.user.sub]
    );

    res.json({ message: 'Đã đánh dấu đã đọc.', data: result.rows[0] || null });
  } catch (err) {
    console.error('[Mark Read Error]:', err);
    res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi khi cập nhật trạng thái đã đọc.' });
  }
});

/**
 * POST /api/v1/notifications/read-all
 */
router.post('/read-all', authenticateToken, async (req, res) => {
  try {
    const orgId = req.user.org_id;
    const userId = req.user.sub;

    await pool.query(
      `UPDATE notification
       SET read_at = NOW()
       WHERE org_id = $1 AND (user_id IS NULL OR user_id = $2) AND read_at IS NULL`,
      [orgId, userId]
    );

    res.json({ message: 'Đã đánh dấu tất cả thông báo là đã đọc.' });
  } catch (err) {
    console.error('[Mark All Read Error]:', err);
    res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi khi đánh dấu tất cả đã đọc.' });
  }
});

export default router;
