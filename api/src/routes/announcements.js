import express from 'express';
import { getUserClient } from '../db/client.js';
import { authenticateToken } from '../middleware/auth.js';
import { requireRole } from '../middleware/rbac.js';
import { idempotencyGuard } from '../middleware/idempotency.js';
import {
  getUserRoleCodes,
  scopedBuildingFilter,
  checkBuildingAccess,
  logAccessDenied,
} from '../services/ownerScope.js';
import {
  ZALO_ANNOUNCEMENT_TEMPLATES,
  formatAnnouncementForZalo,
} from '../services/zaloFormatter.js';

const router = express.Router();

export const ANNOUNCEMENT_SCOPES = ['BUILDING', 'FLOOR', 'APARTMENT'];
export const ANNOUNCEMENT_DB_TYPES = [
  'ANNOUNCEMENT',
  'MAINTENANCE_NOTICE',
  'SECURITY_ALERT',
  'UTILITY_INTERRUPTION',
  'HOUSE_RULES',
  'SYSTEM',
];

export function normalizeAnnouncementType(rawType) {
  const code = String(rawType || 'ANNOUNCEMENT').trim().toUpperCase();
  if (ANNOUNCEMENT_DB_TYPES.includes(code)) return code;
  if (code === 'MAINTENANCE') return 'MAINTENANCE_NOTICE';
  if (code === 'SECURITY' || code === 'EMERGENCY') return 'SECURITY_ALERT';
  if (code === 'UTILITY' || code === 'WATER_ELECTRIC') return 'UTILITY_INTERRUPTION';
  if (code === 'RULES' || code === 'REGULATION') return 'HOUSE_RULES';
  return 'ANNOUNCEMENT';
}

export async function resolveOpsScope(queryFn, entity, id) {
  if (!id) return null;
  try {
    const res = await queryFn(
      `SELECT resource_id, org_id, building_id FROM fn_get_ops_resource_scope($1, $2)`,
      [entity, id]
    );
    return res.rows[0] || null;
  } catch (err) {
    if (err.code === '22P02') return null;
    throw err;
  }
}

export async function loadOrgContactConfig(queryFn, orgId) {
  if (!orgId) return {};
  const res = await queryFn(
    `SELECT value FROM system_setting WHERE org_id = $1 AND key = 'contact_config' LIMIT 1`,
    [orgId]
  );
  return res.rows[0]?.value || {};
}

export async function loadScopeLabels(queryFn, { building_id, floor_id, apartment_id }) {
  const bldgRes = await queryFn(
    `SELECT id, org_id, code AS building_code, name AS building_name FROM building WHERE id = $1 LIMIT 1`,
    [building_id]
  );
  const bldg = bldgRes.rows[0] || {};
  let floorName = '';
  let apartmentCode = '';

  if (floor_id) {
    const fRes = await queryFn(`SELECT name FROM floor WHERE id = $1 LIMIT 1`, [floor_id]);
    floorName = fRes.rows[0]?.name || '';
  }
  if (apartment_id) {
    const aRes = await queryFn(
      `SELECT a.code, f.name AS floor_name
       FROM apartment a
       LEFT JOIN floor f ON f.id = a.floor_id
       WHERE a.id = $1 LIMIT 1`,
      [apartment_id]
    );
    apartmentCode = aRes.rows[0]?.code || '';
    if (!floorName && aRes.rows[0]?.floor_name) {
      floorName = aRes.rows[0].floor_name;
    }
  }

  return {
    orgId: bldg.org_id || null,
    buildingCode: bldg.building_code || '',
    buildingName: bldg.building_name || '',
    floorName,
    apartmentCode,
  };
}

export async function resolveTargetZaloGroups(
  queryFn,
  { building_id, target_scope = 'BUILDING', floor_id = null, apartment_id = null }
) {
  if (!building_id) return [];
  const scope = String(target_scope || 'BUILDING').toUpperCase();

  if (scope === 'APARTMENT' && apartment_id) {
    const res = await queryFn(
      `SELECT zg.id, zg.scope, zg.name, zg.invite_link, zg.note, zg.apartment_id, a.code AS apartment_code
       FROM zalo_group zg
       LEFT JOIN apartment a ON a.id = zg.apartment_id
       WHERE zg.building_id = $1
         AND zg.is_active = TRUE
         AND (
           (zg.scope = 'APARTMENT' AND zg.apartment_id = $2)
           OR zg.scope = 'BUILDING'
         )
       ORDER BY (CASE WHEN zg.scope = 'APARTMENT' THEN 0 ELSE 1 END), zg.name ASC`,
      [building_id, apartment_id]
    );
    return res.rows;
  }

  if (scope === 'FLOOR' && floor_id) {
    const res = await queryFn(
      `SELECT zg.id, zg.scope, zg.name, zg.invite_link, zg.note, zg.apartment_id, a.code AS apartment_code
       FROM zalo_group zg
       LEFT JOIN apartment a ON a.id = zg.apartment_id
       WHERE zg.building_id = $1
         AND zg.is_active = TRUE
         AND (
           (zg.scope = 'APARTMENT' AND a.floor_id = $2)
           OR zg.scope = 'BUILDING'
         )
       ORDER BY (CASE WHEN zg.scope = 'APARTMENT' THEN 0 ELSE 1 END), a.code ASC NULLS LAST, zg.name ASC`,
      [building_id, floor_id]
    );
    return res.rows;
  }

  const res = await queryFn(
    `SELECT zg.id, zg.scope, zg.name, zg.invite_link, zg.note, zg.apartment_id, NULL::text AS apartment_code
     FROM zalo_group zg
     WHERE zg.building_id = $1
       AND zg.is_active = TRUE
       AND zg.scope = 'BUILDING'
     ORDER BY zg.name ASC`,
    [building_id]
  );
  return res.rows;
}

/**
 * Shared transactional fan-out helper used across:
 * 1) POST /api/v1/announcements/:id/send (2-step confirmed send)
 * 2) POST /api/v1/notifications (legacy immediate broadcast)
 * 3) dispatchDueScheduledAnnouncements in daily.js (scheduled cron)
 *
 * Resolves deduplicated active app_user recipients across BOTH primary_tenant_id
 * and contract_occupant on ACTIVE / RENEWAL_PENDING / TERMINATION_PENDING contracts.
 */
export async function fanOutAnnouncementInTx(
  queryFn,
  {
    announcementRow,
    senderUserId = null,
    senderName = 'Ban Quản Lý',
    sentAt = new Date(),
  }
) {
  const scope = String(announcementRow.target_scope || 'BUILDING').toUpperCase();
  const params = [announcementRow.building_id];
  let scopeFilterSql = '';

  if (scope === 'APARTMENT' && announcementRow.apartment_id) {
    params.push(announcementRow.apartment_id);
    scopeFilterSql = ` AND c.apartment_id = $${params.length}`;
  } else if (scope === 'FLOOR' && announcementRow.floor_id) {
    params.push(announcementRow.floor_id);
    scopeFilterSql = ` AND a.floor_id = $${params.length}`;
  }

  const recRes = await queryFn(
    `SELECT DISTINCT u.id AS user_id
     FROM contract c
     JOIN apartment a ON a.id = c.apartment_id
     JOIN tenant t_member ON (
       t_member.id = c.primary_tenant_id
       OR EXISTS (
         SELECT 1 FROM contract_occupant co
         WHERE co.contract_id = c.id AND co.tenant_id = t_member.id
       )
     )
     JOIN app_user u ON u.person_id = t_member.person_id
     WHERE c.building_id = $1
       AND c.status IN ('ACTIVE', 'RENEWAL_PENDING', 'TERMINATION_PENDING')
       AND u.status = 'ACTIVE'
       ${scopeFilterSql}`,
    params
  );

  const recipientIds = recRes.rows.map((r) => r.user_id);

  let finalZaloContent = announcementRow.zalo_content;
  if (!finalZaloContent || !String(finalZaloContent).trim()) {
    const labels = await loadScopeLabels(queryFn, {
      building_id: announcementRow.building_id,
      floor_id: announcementRow.floor_id,
      apartment_id: announcementRow.apartment_id,
    });
    const contactConfig = await loadOrgContactConfig(queryFn, announcementRow.org_id);
    finalZaloContent = formatAnnouncementForZalo({
      type: announcementRow.type,
      title: announcementRow.title,
      body: announcementRow.body,
      targetScope: scope,
      buildingCode: labels.buildingCode,
      buildingName: labels.buildingName,
      floorName: labels.floorName,
      apartmentCode: labels.apartmentCode,
      contactConfig,
      scheduledOrSentAt: sentAt,
    });
  }

  const payloadMeta = {
    announcement_id: announcementRow.id,
    sent_by: senderUserId || announcementRow.created_by || null,
    sender_name: senderName || 'Ban Quản Lý',
    target_scope: scope,
    building_id: announcementRow.building_id,
    floor_id: announcementRow.floor_id || null,
    apartment_id: announcementRow.apartment_id || null,
    link: '/resident?tab=notifications',
  };

  let notificationsInserted = 0;
  let firstNotification = null;
  for (const uid of recipientIds) {
    const insNotif = await queryFn(
      `INSERT INTO notification (org_id, user_id, announcement_id, title, content, type, payload)
       SELECT $1::uuid, $2::uuid, $3::uuid, $4::text, $5::text, $6::text, $7::jsonb
       WHERE NOT EXISTS (
         SELECT 1 FROM notification n
         WHERE n.announcement_id = $3::uuid AND n.user_id = $2::uuid
       )
       RETURNING *`,
      [
        announcementRow.org_id,
        uid,
        announcementRow.id,
        announcementRow.title,
        announcementRow.body,
        announcementRow.type,
        JSON.stringify(payloadMeta),
      ]
    );
    if (insNotif.rowCount > 0) {
      notificationsInserted += insNotif.rowCount;
      if (!firstNotification) firstNotification = insNotif.rows[0];
    }
  }

  const updAnn = await queryFn(
    `UPDATE announcement
     SET status = 'SENT',
         sent_at = $1,
         recipient_count = $2,
         zalo_content = $3,
         updated_at = NOW()
     WHERE id = $4
     RETURNING *`,
    [sentAt, recipientIds.length, finalZaloContent, announcementRow.id]
  );

  return {
    announcement: updAnn.rows[0],
    recipientIds,
    notificationsInserted,
    firstNotification,
  };
}

async function enrichAnnouncementRow(queryFn, row, contactConfigCache = new Map()) {
  const targetZaloGroups = await resolveTargetZaloGroups(queryFn, {
    building_id: row.building_id,
    target_scope: row.target_scope,
    floor_id: row.floor_id,
    apartment_id: row.apartment_id,
  });

  let zaloContent = row.zalo_content;
  if (!zaloContent || !String(zaloContent).trim()) {
    if (!contactConfigCache.has(row.org_id)) {
      contactConfigCache.set(row.org_id, await loadOrgContactConfig(queryFn, row.org_id));
    }
    zaloContent = formatAnnouncementForZalo({
      type: row.type,
      title: row.title,
      body: row.body,
      targetScope: row.target_scope,
      buildingCode: row.building_code || '',
      buildingName: row.building_name || '',
      floorName: row.floor_name || '',
      apartmentCode: row.apartment_code || '',
      contactConfig: contactConfigCache.get(row.org_id) || {},
      scheduledOrSentAt: row.sent_at || row.scheduled_at || row.created_at,
    });
  }

  return {
    ...row,
    read_count: Number(row.read_count || 0),
    recipient_count: Number(row.recipient_count || 0),
    zalo_content: zaloContent,
    target_zalo_groups: targetZaloGroups,
  };
}

async function fetchSingleEnrichedAnnouncement(queryFn, id) {
  const res = await queryFn(
    `SELECT ann.*,
            b.code AS building_code,
            b.name AS building_name,
            f.name AS floor_name,
            a.code AS apartment_code,
            p_creator.full_name AS created_by_name,
            p_manual.full_name AS manual_sent_by_name,
            (
              SELECT COUNT(*)::int
              FROM notification n
              WHERE n.announcement_id = ann.id AND n.read_at IS NOT NULL
            ) AS read_count
     FROM announcement ann
     JOIN building b ON b.id = ann.building_id
     LEFT JOIN floor f ON f.id = ann.floor_id
     LEFT JOIN apartment a ON a.id = ann.apartment_id
     LEFT JOIN app_user u_creator ON u_creator.id = ann.created_by
     LEFT JOIN person p_creator ON p_creator.id = u_creator.person_id
     LEFT JOIN app_user u_manual ON u_manual.id = ann.manual_sent_by
     LEFT JOIN person p_manual ON p_manual.id = u_manual.person_id
     WHERE ann.id = $1
     LIMIT 1`,
    [id]
  );
  if (res.rows.length === 0) return null;
  return enrichAnnouncementRow(queryFn, res.rows[0]);
}

/**
 * GET /api/v1/announcements/templates
 * Danh sách mẫu thông báo chuẩn hóa sẵn cho BQL & nhóm Zalo
 */
router.get('/templates', authenticateToken, (req, res) => {
  res.json({ data: ZALO_ANNOUNCEMENT_TEMPLATES });
});

/**
 * GET /api/v1/announcements (FR-053..FR-056, FR-069)
 * Danh sách thông báo theo tòa kèm bộ đếm đã đọc (read_count), zalo_content và target_zalo_groups
 */
router.get('/', authenticateToken, requireRole(['SYS_ADMIN', 'OWNER', 'MANAGER']), async (req, res) => {
  const { building_id, status, target_scope } = req.query;
  const { client, release } = await getUserClient(req);

  try {
    const queryFn = (sql, params) => client.query(sql, params);

    if (building_id) {
      const bldgScope = await resolveOpsScope(queryFn, 'building', building_id);
      if (!bldgScope) {
        return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy tòa nhà.' });
      }
      const allowed = await checkBuildingAccess(req, building_id);
      if (!allowed) {
        await logAccessDenied(req, 'announcement', building_id, 'Cross-building GET /announcements denied');
        return res.status(403).json({
          code: 'ACCESS_DENIED',
          message: 'Bạn không có quyền truy cập thông báo của tòa nhà này.',
        });
      }
    }

    const params = [req.user.org_id];
    const conditions = ['ann.org_id = $1'];

    const roles = getUserRoleCodes(req);
    if (!roles.includes('SYS_ADMIN')) {
      const { sql: scopeSql } = await scopedBuildingFilter(req, 'ann.building_id', params);
      if (scopeSql) {
        conditions.push(scopeSql.replace(/^\s*AND\s+/i, ''));
      }
    }

    if (building_id) {
      params.push(building_id);
      conditions.push(`ann.building_id = $${params.length}`);
    }

    if (status) {
      params.push(String(status).trim().toUpperCase());
      conditions.push(`ann.status = $${params.length}`);
    }

    if (target_scope && ANNOUNCEMENT_SCOPES.includes(String(target_scope).trim().toUpperCase())) {
      params.push(String(target_scope).trim().toUpperCase());
      conditions.push(`ann.target_scope = $${params.length}`);
    }

    const listRes = await client.query(
      `SELECT ann.*,
              b.code AS building_code,
              b.name AS building_name,
              f.name AS floor_name,
              a.code AS apartment_code,
              p_creator.full_name AS created_by_name,
              p_manual.full_name AS manual_sent_by_name,
              (
                SELECT COUNT(*)::int
                FROM notification n
                WHERE n.announcement_id = ann.id AND n.read_at IS NOT NULL
              ) AS read_count
       FROM announcement ann
       JOIN building b ON b.id = ann.building_id
       LEFT JOIN floor f ON f.id = ann.floor_id
       LEFT JOIN apartment a ON a.id = ann.apartment_id
       LEFT JOIN app_user u_creator ON u_creator.id = ann.created_by
       LEFT JOIN person p_creator ON p_creator.id = u_creator.person_id
       LEFT JOIN app_user u_manual ON u_manual.id = ann.manual_sent_by
       LEFT JOIN person p_manual ON p_manual.id = u_manual.person_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY ann.created_at DESC
       LIMIT 100`,
      params
    );

    const cache = new Map();
    const enriched = [];
    for (const row of listRes.rows) {
      enriched.push(await enrichAnnouncementRow(queryFn, row, cache));
    }

    res.json({ data: enriched });
  } catch (err) {
    console.error('[Get Announcements Error]:', err);
    res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi khi tải danh sách thông báo.' });
  } finally {
    await release();
  }
});

/**
 * POST /api/v1/announcements (FR-053, FR-054, FR-069)
 * Tạo bản nháp (DRAFT) hoặc hẹn giờ gửi (SCHEDULED) thông báo theo tòa / tầng / phòng
 */
router.post('/', authenticateToken, requireRole(['MANAGER']), idempotencyGuard(), async (req, res) => {
  const {
    building_id,
    target_scope = 'BUILDING',
    floor_id = null,
    apartment_id = null,
    type = 'ANNOUNCEMENT',
    title,
    body,
    content,
    zalo_content,
    scheduled_at = null,
  } = req.body || {};

  const bodyText = String(body ?? content ?? '').trim();
  if (!building_id || !title?.trim() || !bodyText) {
    return res.status(400).json({
      code: 'VALIDATION_ERROR',
      message: 'Vui lòng chọn tòa nhà và nhập đầy đủ tiêu đề, nội dung thông báo.',
    });
  }

  const normScope = String(target_scope || 'BUILDING').trim().toUpperCase();
  if (!ANNOUNCEMENT_SCOPES.includes(normScope)) {
    return res.status(400).json({
      code: 'VALIDATION_ERROR',
      message: 'Phạm vi nhận thông báo phải là BUILDING, FLOOR hoặc APARTMENT.',
    });
  }

  if (normScope === 'FLOOR' && !floor_id) {
    return res.status(400).json({
      code: 'VALIDATION_ERROR',
      message: 'Vui lòng chọn tầng khi phạm vi gửi là FLOOR.',
    });
  }
  if (normScope === 'APARTMENT' && !apartment_id) {
    return res.status(400).json({
      code: 'VALIDATION_ERROR',
      message: 'Vui lòng chọn căn hộ khi phạm vi gửi là APARTMENT.',
    });
  }

  let parsedSchedule = null;
  let initialStatus = 'DRAFT';
  if (scheduled_at !== null && scheduled_at !== undefined && String(scheduled_at).trim() !== '') {
    parsedSchedule = new Date(scheduled_at);
    if (Number.isNaN(parsedSchedule.getTime()) || parsedSchedule.getTime() <= Date.now()) {
      return res.status(422).json({
        code: 'INVALID_SCHEDULE_TIME',
        message: 'Thời điểm hẹn giờ phát hành phải nằm trong tương lai.',
      });
    }
    initialStatus = 'SCHEDULED';
  }

  const normType = normalizeAnnouncementType(type);
  const { client, release } = await getUserClient(req);
  let txStarted = false;

  try {
    const queryFn = (sql, params) => client.query(sql, params);
    const bldgScope = await resolveOpsScope(queryFn, 'building', building_id);
    if (!bldgScope) {
      return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy tòa nhà.' });
    }

    const allowed = await checkBuildingAccess(req, building_id);
    if (!allowed) {
      await logAccessDenied(req, 'announcement', building_id, 'MANAGER attempted POST /announcements on unassigned building');
      return res.status(403).json({
        code: 'ACCESS_DENIED',
        message: 'Bạn không được phân công quản lý tòa nhà này.',
      });
    }

    const effFloorId = normScope === 'FLOOR' ? floor_id : null;
    const effApartmentId = normScope === 'APARTMENT' ? apartment_id : null;

    if (effFloorId) {
      const fScope = await resolveOpsScope(queryFn, 'floor', effFloorId);
      if (!fScope || fScope.building_id !== building_id) {
        return res.status(422).json({
          code: 'FLOOR_BUILDING_MISMATCH',
          message: 'Tầng đã chọn không thuộc tòa nhà này.',
        });
      }
    }

    if (effApartmentId) {
      const aScope = await resolveOpsScope(queryFn, 'apartment', effApartmentId);
      if (!aScope || aScope.building_id !== building_id) {
        return res.status(422).json({
          code: 'APARTMENT_BUILDING_MISMATCH',
          message: 'Căn hộ đã chọn không thuộc tòa nhà này.',
        });
      }
    }

    const labels = await loadScopeLabels(queryFn, {
      building_id,
      floor_id: effFloorId,
      apartment_id: effApartmentId,
    });
    const contactConfig = await loadOrgContactConfig(queryFn, bldgScope.org_id);
    const computedZalo =
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
        scheduledOrSentAt: parsedSchedule || new Date(),
      });

    await client.query('BEGIN');
    txStarted = true;

    const insRes = await client.query(
      `INSERT INTO announcement (
         org_id, building_id, target_scope, floor_id, apartment_id,
         type, title, body, zalo_content, status, scheduled_at, created_by
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING *`,
      [
        bldgScope.org_id,
        building_id,
        normScope,
        effFloorId,
        effApartmentId,
        normType,
        title.trim(),
        bodyText,
        computedZalo,
        initialStatus,
        parsedSchedule,
        req.user.sub,
      ]
    );
    const created = insRes.rows[0];

    await client.query(
      `INSERT INTO audit_log (actor_id, action, entity, entity_id, after)
       VALUES ($1, 'CREATE_ANNOUNCEMENT', 'announcement', $2, $3)`,
      [req.user.sub, created.id, JSON.stringify(created)]
    );

    const enriched = await fetchSingleEnrichedAnnouncement(queryFn, created.id);

    await client.query('COMMIT');
    txStarted = false;

    res.status(201).json({
      message:
        initialStatus === 'SCHEDULED'
          ? 'Đã lên lịch phát hành thông báo.'
          : 'Đã lưu bản nháp thông báo và tạo sẵn nội dung Zalo.',
      data: enriched,
    });
  } catch (err) {
    if (txStarted) {
      await client.query('ROLLBACK').catch(() => {});
    }
    console.error('[Create Announcement Error]:', err);
    res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi khi lưu thông báo.' });
  } finally {
    await release();
  }
});

/**
 * PUT /api/v1/announcements/:id
 * Chỉnh sửa bản nháp / lịch hẹn gửi, hủy lịch hẹn, hoặc tinh chỉnh zalo_content
 */
router.put('/:id', authenticateToken, requireRole(['MANAGER']), idempotencyGuard(), async (req, res) => {
  const { id } = req.params;
  const {
    target_scope,
    floor_id,
    apartment_id,
    type,
    title,
    body,
    content,
    zalo_content,
    scheduled_at,
    status,
  } = req.body || {};

  const { client, release } = await getUserClient(req);
  let txStarted = false;

  try {
    const queryFn = (sql, params) => client.query(sql, params);
    const annScope = await resolveOpsScope(queryFn, 'announcement', id);
    if (!annScope) {
      return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy thông báo.' });
    }

    const allowed = await checkBuildingAccess(req, annScope.building_id);
    if (!allowed) {
      await logAccessDenied(req, 'announcement', id, 'MANAGER attempted PUT /announcements/:id on unassigned building');
      return res.status(403).json({
        code: 'ACCESS_DENIED',
        message: 'Bạn không được phân công quản lý tòa nhà này.',
      });
    }

    const curRes = await client.query(`SELECT * FROM announcement WHERE id = $1 LIMIT 1`, [id]);
    if (curRes.rows.length === 0) {
      return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy thông báo.' });
    }
    const existing = curRes.rows[0];

    if (existing.status === 'CANCELLED') {
      return res.status(409).json({
        code: 'ANNOUNCEMENT_CANCELLED',
        message: 'Thông báo đã hủy không thể chỉnh sửa.',
      });
    }

    // Nếu đã SENT, chỉ cho phép cập nhật zalo_content
    if (existing.status === 'SENT') {
      if (zalo_content === undefined) {
        return res.status(409).json({
          code: 'ALREADY_SENT',
          message: 'Thông báo đã phát hành không thể sửa nội dung gốc (chỉ có thể chỉnh bản copy Zalo).',
        });
      }

      await client.query('BEGIN');
      txStarted = true;
      const updSent = await client.query(
        `UPDATE announcement SET zalo_content = $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
        [String(zalo_content).trim(), id]
      );
      await client.query(
        `INSERT INTO audit_log (actor_id, action, entity, entity_id, before, after)
         VALUES ($1, 'UPDATE_ANNOUNCEMENT', 'announcement', $2, $3, $4)`,
        [req.user.sub, id, JSON.stringify(existing), JSON.stringify(updSent.rows[0])]
      );
      const enrichedSent = await fetchSingleEnrichedAnnouncement(queryFn, id);
      await client.query('COMMIT');
      txStarted = false;
      return res.json({ message: 'Đã cập nhật nội dung Zalo.', data: enrichedSent });
    }

    const requestedStatus = status ? String(status).trim().toUpperCase() : null;
    if (requestedStatus === 'CANCELLED') {
      await client.query('BEGIN');
      txStarted = true;
      const cancelRes = await client.query(
        `UPDATE announcement SET status = 'CANCELLED', updated_at = NOW() WHERE id = $1 RETURNING *`,
        [id]
      );
      await client.query(
        `INSERT INTO audit_log (actor_id, action, entity, entity_id, before, after)
         VALUES ($1, 'UPDATE_ANNOUNCEMENT', 'announcement', $2, $3, $4)`,
        [req.user.sub, id, JSON.stringify(existing), JSON.stringify(cancelRes.rows[0])]
      );
      const enrichedCancel = await fetchSingleEnrichedAnnouncement(queryFn, id);
      await client.query('COMMIT');
      txStarted = false;
      return res.json({ message: 'Đã hủy thông báo nháp / lịch hẹn.', data: enrichedCancel });
    }

    const nextScope = target_scope
      ? String(target_scope).trim().toUpperCase()
      : existing.target_scope;
    if (!ANNOUNCEMENT_SCOPES.includes(nextScope)) {
      return res.status(400).json({
        code: 'VALIDATION_ERROR',
        message: 'Phạm vi nhận thông báo không hợp lệ.',
      });
    }

    const nextFloorId =
      nextScope === 'FLOOR' ? (floor_id !== undefined ? floor_id : existing.floor_id) : null;
    const nextAptId =
      nextScope === 'APARTMENT'
        ? apartment_id !== undefined
          ? apartment_id
          : existing.apartment_id
        : null;

    if (nextScope === 'FLOOR' && !nextFloorId) {
      return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Vui lòng chọn tầng.' });
    }
    if (nextScope === 'APARTMENT' && !nextAptId) {
      return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Vui lòng chọn căn hộ.' });
    }

    const nextType = type !== undefined ? normalizeAnnouncementType(type) : existing.type;
    const nextTitle = title !== undefined ? String(title).trim() : existing.title;
    const rawBodyInput = body !== undefined ? body : content;
    const nextBody = rawBodyInput !== undefined ? String(rawBodyInput).trim() : existing.body;

    let nextScheduledAt = existing.scheduled_at;
    let nextStatus = existing.status;
    if (scheduled_at !== undefined) {
      if (scheduled_at === null || String(scheduled_at).trim() === '') {
        nextScheduledAt = null;
        nextStatus = 'DRAFT';
      } else {
        const parsed = new Date(scheduled_at);
        if (Number.isNaN(parsed.getTime()) || parsed.getTime() <= Date.now()) {
          return res.status(422).json({
            code: 'INVALID_SCHEDULE_TIME',
            message: 'Thời điểm hẹn giờ phát hành phải nằm trong tương lai.',
          });
        }
        nextScheduledAt = parsed;
        nextStatus = 'SCHEDULED';
      }
    }

    const labels = await loadScopeLabels(queryFn, {
      building_id: existing.building_id,
      floor_id: nextFloorId,
      apartment_id: nextAptId,
    });
    const contactConfig = await loadOrgContactConfig(queryFn, existing.org_id);
    const nextZaloContent =
      zalo_content !== undefined && String(zalo_content).trim()
        ? String(zalo_content).trim()
        : formatAnnouncementForZalo({
            type: nextType,
            title: nextTitle,
            body: nextBody,
            targetScope: nextScope,
            buildingCode: labels.buildingCode,
            buildingName: labels.buildingName,
            floorName: labels.floorName,
            apartmentCode: labels.apartmentCode,
            contactConfig,
            scheduledOrSentAt: nextScheduledAt || new Date(),
          });

    await client.query('BEGIN');
    txStarted = true;

    const updRes = await client.query(
      `UPDATE announcement
       SET target_scope = $1,
           floor_id = $2,
           apartment_id = $3,
           type = $4,
           title = $5,
           body = $6,
           zalo_content = $7,
           scheduled_at = $8,
           status = $9,
           updated_at = NOW()
       WHERE id = $10
       RETURNING *`,
      [
        nextScope,
        nextFloorId,
        nextAptId,
        nextType,
        nextTitle,
        nextBody,
        nextZaloContent,
        nextScheduledAt,
        nextStatus,
        id,
      ]
    );

    await client.query(
      `INSERT INTO audit_log (actor_id, action, entity, entity_id, before, after)
       VALUES ($1, 'UPDATE_ANNOUNCEMENT', 'announcement', $2, $3, $4)`,
      [req.user.sub, id, JSON.stringify(existing), JSON.stringify(updRes.rows[0])]
    );

    const enriched = await fetchSingleEnrichedAnnouncement(queryFn, id);
    await client.query('COMMIT');
    txStarted = false;

    res.json({ message: 'Đã cập nhật thông báo.', data: enriched });
  } catch (err) {
    if (txStarted) {
      await client.query('ROLLBACK').catch(() => {});
    }
    console.error('[Update Announcement Error]:', err);
    res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi khi cập nhật thông báo.' });
  } finally {
    await release();
  }
});

/**
 * POST /api/v1/announcements/:id/send (FR-054, FR-055, PRD 14.3)
 * Phát hành thông báo 2 bước (bắt buộc confirm_send === true) tới cả người thuê chính và người ở cùng
 */
router.post('/:id/send', authenticateToken, requireRole(['MANAGER']), idempotencyGuard(), async (req, res) => {
  const { id } = req.params;
  const { client, release } = await getUserClient(req);
  let txStarted = false;

  try {
    const queryFn = (sql, params) => client.query(sql, params);
    const annScope = await resolveOpsScope(queryFn, 'announcement', id);
    if (!annScope) {
      return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy thông báo.' });
    }

    const allowed = await checkBuildingAccess(req, annScope.building_id);
    if (!allowed) {
      await logAccessDenied(req, 'announcement', id, 'MANAGER attempted POST /announcements/:id/send on unassigned building');
      return res.status(403).json({
        code: 'ACCESS_DENIED',
        message: 'Bạn không được phân công quản lý tòa nhà này.',
      });
    }

    await client.query('BEGIN');
    txStarted = true;

    const lockRes = await client.query(
      `SELECT * FROM announcement WHERE id = $1 FOR UPDATE`,
      [id]
    );
    if (lockRes.rows.length === 0) {
      await client.query('ROLLBACK');
      txStarted = false;
      return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy thông báo.' });
    }
    const existing = lockRes.rows[0];

    if (existing.status === 'SENT') {
      await client.query('ROLLBACK');
      txStarted = false;
      return res.status(409).json({
        code: 'ALREADY_SENT',
        message: 'Thông báo này đã được phát hành trước đó.',
      });
    }

    if (existing.status === 'CANCELLED') {
      await client.query('ROLLBACK');
      txStarted = false;
      return res.status(409).json({
        code: 'ANNOUNCEMENT_CANCELLED',
        message: 'Thông báo đã bị hủy, không thể phát hành.',
      });
    }

    if (req.body?.confirm_send !== true) {
      await client.query('ROLLBACK');
      txStarted = false;
      return res.status(422).json({
        code: 'CONFIRMATION_REQUIRED',
        message: 'Vui lòng xác nhận bước 2 (confirm_send: true) trước khi gửi thông báo tới cư dân.',
      });
    }

    const { announcement: sentRow, recipientIds } = await fanOutAnnouncementInTx(queryFn, {
      announcementRow: existing,
      senderUserId: req.user.sub,
      senderName: req.user.full_name || 'Ban Quản Lý',
      sentAt: new Date(),
    });

    await client.query(
      `INSERT INTO audit_log (actor_id, action, entity, entity_id, before, after)
       VALUES ($1, 'SEND_ANNOUNCEMENT', 'announcement', $2, $3, $4)`,
      [req.user.sub, id, JSON.stringify(existing), JSON.stringify(sentRow)]
    );

    const enriched = await fetchSingleEnrichedAnnouncement(queryFn, id);

    await client.query('COMMIT');
    txStarted = false;

    res.json({
      message: `Đã phát hành thông báo trong ứng dụng tới ${recipientIds.length} cư dân. Bạn có thể sao chép nội dung để dán sang nhóm Zalo.`,
      data: enriched,
    });
  } catch (err) {
    if (txStarted) {
      await client.query('ROLLBACK').catch(() => {});
    }
    console.error('[Send Announcement Error]:', err);
    res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi khi phát hành thông báo.' });
  } finally {
    await release();
  }
});

/**
 * POST /api/v1/announcements/:id/mark-zalo-sent (FR-069, PRD 13.6)
 * BQL đánh dấu đã copy & dán thông báo sang các nhóm Zalo tương ứng (ghi audit_log cho OWNER giám sát)
 */
router.post('/:id/mark-zalo-sent', authenticateToken, requireRole(['MANAGER']), idempotencyGuard(), async (req, res) => {
  const { id } = req.params;
  const { zalo_group_ids = [], note = null } = req.body || {};

  const { client, release } = await getUserClient(req);
  let txStarted = false;

  try {
    const queryFn = (sql, params) => client.query(sql, params);
    const annScope = await resolveOpsScope(queryFn, 'announcement', id);
    if (!annScope) {
      return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy thông báo.' });
    }

    const allowed = await checkBuildingAccess(req, annScope.building_id);
    if (!allowed) {
      await logAccessDenied(req, 'announcement', id, 'MANAGER attempted mark-zalo-sent on unassigned building');
      return res.status(403).json({
        code: 'ACCESS_DENIED',
        message: 'Bạn không được phân công quản lý tòa nhà này.',
      });
    }

    await client.query('BEGIN');
    txStarted = true;

    const curRes = await client.query(`SELECT * FROM announcement WHERE id = $1 FOR UPDATE`, [id]);
    if (curRes.rows.length === 0) {
      await client.query('ROLLBACK');
      txStarted = false;
      return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy thông báo.' });
    }
    const existing = curRes.rows[0];

    const nowIso = new Date().toISOString();
    let selectedSnapshots = [];
    if (Array.isArray(zalo_group_ids) && zalo_group_ids.length > 0) {
      const grpRes = await client.query(
        `SELECT zg.id, zg.name, zg.scope, zg.invite_link, zg.apartment_id, a.code AS apartment_code
         FROM zalo_group zg
         LEFT JOIN apartment a ON a.id = zg.apartment_id
         WHERE zg.building_id = $1 AND zg.id = ANY($2::uuid[])`,
        [existing.building_id, zalo_group_ids]
      );
      selectedSnapshots = grpRes.rows.map((g) => ({
        id: g.id,
        name: g.name,
        scope: g.scope,
        invite_link: g.invite_link || null,
        apartment_code: g.apartment_code || null,
        sent_at: nowIso,
      }));
    }

    const prevGroups = Array.isArray(existing.manual_sent_groups) ? existing.manual_sent_groups : [];
    const mergedMap = new Map();
    for (const item of prevGroups) {
      if (item?.id) mergedMap.set(item.id, item);
    }
    for (const item of selectedSnapshots) {
      mergedMap.set(item.id, item);
    }
    const mergedGroups = Array.from(mergedMap.values());

    const updRes = await client.query(
      `UPDATE announcement
       SET manual_sent_at = NOW(),
           manual_sent_by = $1,
           manual_sent_groups = $2::jsonb,
           updated_at = NOW()
       WHERE id = $3
       RETURNING *`,
      [req.user.sub, JSON.stringify(mergedGroups), id]
    );
    const updated = updRes.rows[0];

    await client.query(
      `INSERT INTO audit_log (actor_id, action, entity, entity_id, before, after)
       VALUES ($1, 'MARK_ANNOUNCEMENT_ZALO_SENT', 'announcement', $2, $3, $4)`,
      [
        req.user.sub,
        id,
        JSON.stringify({
          manual_sent_at: existing.manual_sent_at,
          manual_sent_groups: existing.manual_sent_groups,
        }),
        JSON.stringify({
          manual_sent_at: updated.manual_sent_at,
          manual_sent_by: updated.manual_sent_by,
          manual_sent_groups: updated.manual_sent_groups,
          note: note?.trim() || null,
        }),
      ]
    );

    const enriched = await fetchSingleEnrichedAnnouncement(queryFn, id);

    await client.query('COMMIT');
    txStarted = false;

    res.json({
      message: 'Đã xác nhận gửi thông báo lên nhóm Zalo.',
      data: enriched,
    });
  } catch (err) {
    if (txStarted) {
      await client.query('ROLLBACK').catch(() => {});
    }
    console.error('[Mark Zalo Sent Error]:', err);
    res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi khi cập nhật trạng thái gửi nhóm Zalo.' });
  } finally {
    await release();
  }
});

export default router;
