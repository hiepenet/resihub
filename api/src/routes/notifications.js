import express from 'express';
import { pool } from '../db/client.js';
import { authenticateToken } from '../middleware/auth.js';

const router = express.Router();

/**
 * GET /api/v1/notifications
 * Lấy danh sách thông báo và số lượng chưa đọc (FR-053 / M13 / PRD 13.2)
 */
router.get('/', authenticateToken, async (req, res) => {
  try {
    const orgId = req.user.org_id;
    const userId = req.user.sub;

    const listResult = await pool.query(
      `SELECT * FROM notification
       WHERE org_id = $1 AND (user_id IS NULL OR user_id = $2)
       ORDER BY created_at DESC
       LIMIT 50`,
      [orgId, userId]
    );

    const countResult = await pool.query(
      `SELECT COUNT(*)::int as unread_count FROM notification
       WHERE org_id = $1 AND (user_id IS NULL OR user_id = $2) AND read_at IS NULL`,
      [orgId, userId]
    );

    res.json({
      data: listResult.rows,
      unread_count: countResult.rows[0]?.unread_count || 0,
    });
  } catch (err) {
    console.error('[Notifications Error]:', err);
    res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi khi lấy danh sách thông báo.' });
  }
});

/**
 * PATCH /api/v1/notifications/:id/read
 * Đánh dấu 1 thông báo là đã đọc
 */
router.patch('/:id/read', authenticateToken, async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query(
      `UPDATE notification
       SET read_at = NOW()
       WHERE id = $1 AND read_at IS NULL
       RETURNING *`,
      [id]
    );

    res.json({ message: 'Đã đánh dấu đã đọc.', data: result.rows[0] || null });
  } catch (err) {
    console.error('[Mark Read Error]:', err);
    res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi khi cập nhật trạng thái đã đọc.' });
  }
});

/**
 * POST /api/v1/notifications/read-all
 * Đánh dấu tất cả thông báo là đã đọc
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
