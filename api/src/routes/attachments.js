// Xem file đính kèm có kiểm soát (bản scan HĐ, ảnh CCCD): auth + kiểm quyền theo owner_entity
// + audit READ từng lần xem (PRD 17.1). KHÔNG serve thư mục uploads tĩnh — truy cập chỉ qua đây.
import express from 'express';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pool } from '../db/client.js';
import { authenticateToken } from '../middleware/auth.js';

const router = express.Router();
const UPLOADS_ROOT = path.join(process.cwd(), 'uploads');

router.get('/:id/view', authenticateToken, async (req, res) => {
  const { id } = req.params;
  try {
    const attRes = await pool.query('SELECT * FROM attachment WHERE id = $1', [id]);
    if (attRes.rows.length === 0) {
      return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy tệp đính kèm.' });
    }
    const att = attRes.rows[0];

    // Kiểm quyền theo loại chủ sở hữu tệp: MANAGER của tòa (contract) / tiếp cận PII XII (person)
    if (att.owner_entity === 'contract') {
      const ok = await pool.query(
        `SELECT 1
         FROM contract c
         JOIN user_role ur ON ur.building_id = c.building_id
         WHERE c.id = $1 AND ur.user_id = $2`,
        [att.owner_id, req.user.sub]
      );
      if (ok.rows.length === 0) {
        return res.status(403).json({ code: 'FORBIDDEN_ATTACHMENT', message: 'Bạn không có quyền xem tệp đính kèm này.' });
      }
    } else if (att.owner_entity === 'person') {
      // PII (CCCD): chỉ người trong cùng tổ chức của person
      const ok = await pool.query(
        `SELECT 1 FROM person p WHERE p.id = $1 AND p.org_id = $2`,
        [att.owner_id, req.user.org_id]
      );
      if (ok.rows.length === 0) {
        return res.status(403).json({ code: 'FORBIDDEN_ATTACHMENT', message: 'Bạn không có quyền xem tệp đính kèm này.' });
      }
    } else {
      return res.status(403).json({ code: 'FORBIDDEN_ATTACHMENT', message: 'Loại tệp đính kèm chưa hỗ trợ xem.' });
    }

    // Chặn path traversal: path trong DB phải nằm dưới uploads/<folder>/<id>/<file>.<ext>
    const safe = att.storage_path && att.storage_path.startsWith('uploads/') && !att.storage_path.includes('..');
    if (!safe) {
      return res.status(500).json({ code: 'BAD_STORAGE_PATH', message: 'Đường dẫn tệp không hợp lệ.' });
    }
    const absPath = path.join(process.cwd(), att.storage_path);
    if (!absPath.startsWith(UPLOADS_ROOT)) {
      return res.status(500).json({ code: 'BAD_STORAGE_PATH', message: 'Đường dẫn tệp không hợp lệ.' });
    }

    try {
      const buf = await readFile(absPath);
      await pool.query(
        `INSERT INTO audit_log (actor_id, action, entity, entity_id, after)
         VALUES ($1, 'READ', 'attachment', $2, $3)`,
        [req.user.sub, att.id, JSON.stringify({ storage_path: att.storage_path, owner_entity: att.owner_entity })]
      );
      res.contentType(att.mime || 'application/octet-stream');
      res.send(buf);
    } catch (readErr) {
      console.error('[Attachment Read Error]:', readErr.message);
      return res.status(404).json({ code: 'NOT_FOUND', message: 'Tệp không còn tồn tại trên máy chủ.' });
    }
  } catch (err) {
    console.error('[Attachment View Error]:', err);
    res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi máy chủ khi đọc tệp đính kèm.' });
  }
});

export default router;
