import express from 'express';
import { pool, adminPool } from '../db/client.js';
import { authenticateToken } from '../middleware/auth.js';
import { requireRole } from '../middleware/rbac.js';
import { getUserRoleCodes, getManagerBuildingIds, getOwnerBuildingIds, logAccessDenied } from '../services/ownerScope.js';

const router = express.Router();

/**
 * GET /api/v1/notifications
 * Lấy danh sách thông báo và số lượng chưa đọc (FR-053 / M13)
 */
router.get('/', authenticateToken, async (req, res) => {
  try {
    const orgId = req.user.org_id;
    const userId = req.user.sub;

    const listResult = await pool.query(
      `SELECT * FROM notification
       WHERE org_id = $1 AND (user_id IS NULL OR user_id = $2)
       ORDER BY created_at DESC
       LIMIT 80`,
      [orgId, userId]
    );

    const countResult = await pool.query(
      `SELECT COUNT(*)::int as unread_count FROM notification
       WHERE org_id = $1 AND (user_id IS NULL OR user_id = $2) AND read_at IS NULL`,
      [orgId, userId]
    );

    // Nếu là SYS_ADMIN / MANAGER, trả thêm lịch sử thông báo đã phát hành (gom theo đợt broadcast)
    const roles = getUserRoleCodes(req);
    let sentHistory = [];
    if (roles.some((r) => ['SYS_ADMIN', 'MANAGER'].includes(r))) {
      const sentRes = await adminPool.query(
        `SELECT (ARRAY_AGG(n.id ORDER BY n.created_at DESC))[1] AS id,
                n.title,
                n.content,
                n.type,
                (ARRAY_AGG(n.payload ORDER BY n.created_at DESC))[1] AS payload,
                MAX(n.created_at) AS created_at,
                COUNT(*)::int AS recipient_count,
                b.code AS building_code,
                b.name AS building_name,
                f.name AS floor_name,
                a.code AS apartment_code
         FROM notification n
         LEFT JOIN building b ON b.id = NULLIF(n.payload->>'building_id', '')::uuid
         LEFT JOIN floor f ON f.id = NULLIF(n.payload->>'floor_id', '')::uuid
         LEFT JOIN apartment a ON a.id = NULLIF(n.payload->>'apartment_id', '')::uuid
         WHERE n.org_id = $1
           AND n.payload ? 'target_scope'
           AND (n.payload->>'sent_by' = $2 OR $3 = TRUE)
         GROUP BY n.title,
                  n.content,
                  n.type,
                  n.payload->>'target_scope',
                  n.payload->>'building_id',
                  n.payload->>'floor_id',
                  n.payload->>'apartment_id',
                  n.payload->>'sender_name',
                  date_trunc('minute', n.created_at),
                  b.code,
                  b.name,
                  f.name,
                  a.code
         ORDER BY MAX(n.created_at) DESC
         LIMIT 40`,
        [orgId, userId, roles.includes('SYS_ADMIN')]
      );
      sentHistory = sentRes.rows;
    }

    res.json({
      data: listResult.rows,
      sent_history: sentHistory,
      unread_count: countResult.rows[0]?.unread_count || 0,
    });
  } catch (err) {
    console.error('[Notifications Error]:', err);
    res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi khi lấy danh sách thông báo.' });
  }
});

/**
 * POST /api/v1/notifications (M13, FR-051)
 * Gửi thông báo theo nhóm nhận: toàn tổ chức (ALL), theo tòa (BUILDING), tầng (FLOOR), hoặc căn hộ (APARTMENT)
 * OWNER 100% Read-Only (PRD 6.1 & 6.2), chỉ SYS_ADMIN và MANAGER được phát thông báo vận hành.
 */
router.post('/', authenticateToken, requireRole(['SYS_ADMIN', 'MANAGER']), async (req, res) => {
  const { title, content, type = 'ANNOUNCEMENT', target_scope = 'BUILDING', building_id, floor_id, apartment_id } = req.body;
  const orgId = req.user.org_id;
  const roles = getUserRoleCodes(req);
  const isSysAdmin = roles.includes('SYS_ADMIN');
  const isManager = roles.includes('MANAGER');

  if (!title?.trim() || !content?.trim()) {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Tiêu đề và nội dung thông báo là bắt buộc.' });
  }

  try {
    if (target_scope === 'ALL' && !isSysAdmin) {
      return res.status(403).json({
        code: 'FORBIDDEN_SCOPE',
        message: 'Chỉ Quản trị hệ thống (SYS_ADMIN) được gửi thông báo toàn tổ chức.',
      });
    }

    if (building_id && !isSysAdmin && isManager) {
      const mgrIds = await getManagerBuildingIds(req.user.sub, orgId);
      if (!mgrIds.includes(building_id)) {
        await logAccessDenied(req, 'building', building_id, 'MANAGER attempted notification on unassigned building');
        return res.status(403).json({ code: 'ACCESS_DENIED', message: 'Bạn không quản lý tòa nhà này.' });
      }
    }

    const payloadMeta = {
      sent_by: req.user.sub,
      sender_name: req.user.full_name || 'Ban Quản Lý',
      target_scope,
      building_id: building_id || null,
      floor_id: floor_id || null,
      apartment_id: apartment_id || null,
    };

    if (target_scope === 'ALL') {
      const ins = await pool.query(
        `INSERT INTO notification (org_id, user_id, title, content, type, payload)
         VALUES ($1, NULL, $2, $3, $4, $5)
         RETURNING *`,
        [orgId, title.trim(), content.trim(), type, JSON.stringify(payloadMeta)]
      );
      return res.status(201).json({
        message: 'Đã phát hành thông báo tới toàn bộ hệ thống.',
        data: ins.rows[0],
        recipient_count: 'ALL',
      });
    }

    // Tìm danh sách user_id của cư dân đang thuê thuộc phạm vi tòa / tầng / căn
    let userSql = `
      SELECT DISTINCT au.id AS user_id
      FROM contract c
      JOIN apartment a ON a.id = c.apartment_id
      JOIN tenant t ON t.id = c.primary_tenant_id
      JOIN app_user au ON au.person_id = t.person_id
      JOIN building b ON b.id = c.building_id
      WHERE b.org_id = $1
        AND c.status IN ('ACTIVE', 'RENEWAL_PENDING', 'TERMINATION_PENDING')
    `;
    const params = [orgId];

    if (apartment_id) {
      params.push(apartment_id);
      userSql += ` AND c.apartment_id = $${params.length}`;
    } else if (floor_id) {
      params.push(floor_id);
      userSql += ` AND a.floor_id = $${params.length}`;
    } else if (building_id) {
      params.push(building_id);
      userSql += ` AND c.building_id = $${params.length}`;
    } else if (isManager) {
      const mgrIds = await getManagerBuildingIds(req.user.sub, orgId);
      params.push(mgrIds);
      userSql += ` AND c.building_id = ANY($${params.length}::uuid[])`;
    }

    const recipientsRes = await adminPool.query(userSql, params);
    const recipientIds = recipientsRes.rows.map((r) => r.user_id);

    const inserted = [];
    if (recipientIds.length === 0) {
      // Vẫn lưu 1 bản ghi cho chính người gửi để theo dõi lịch sử
      const selfIns = await pool.query(
        `INSERT INTO notification (org_id, user_id, title, content, type, payload)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [orgId, req.user.sub, title.trim(), content.trim(), type, JSON.stringify({ ...payloadMeta, note: 'Không có cư dân đang thuê trong nhóm chọn' })]
      );
      inserted.push(selfIns.rows[0]);
    } else {
      for (const uid of recipientIds) {
        const rIns = await pool.query(
          `INSERT INTO notification (org_id, user_id, title, content, type, payload)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING *`,
          [orgId, uid, title.trim(), content.trim(), type, JSON.stringify(payloadMeta)]
        );
        inserted.push(rIns.rows[0]);
      }
    }

    res.status(201).json({
      message: `Đã gửi thông báo thành công tới ${recipientIds.length} cư dân.`,
      data: inserted[0],
      recipient_count: recipientIds.length,
    });
  } catch (err) {
    console.error('[Create Notification Error]:', err);
    res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi khi tạo và gửi thông báo.' });
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
