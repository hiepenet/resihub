// Xem file đính kèm có kiểm soát (bản scan HĐ, ảnh CCCD): auth + kiểm quyền theo owner_entity
// + audit READ từng lần xem (PRD 17.1). KHÔNG serve thư mục uploads tĩnh — truy cập chỉ qua đây.
import express from 'express';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pool, adminPool } from '../db/client.js';
import { authenticateToken } from '../middleware/auth.js';
import {
  getUserRoleCodes,
  getOwnerBuildingIds,
  getManagerBuildingIds,
  logAccessDenied,
} from '../services/ownerScope.js';

const router = express.Router();
const UPLOADS_ROOT = path.join(process.cwd(), 'uploads');

router.get('/:id/view', authenticateToken, async (req, res) => {
  const { id } = req.params;
  try {
    const existRes = await adminPool.query('SELECT * FROM attachment WHERE id = $1', [id]);
    if (existRes.rows.length === 0) {
      return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy tệp đính kèm.' });
    }

    // Query lại qua pool (RLS) để đảm bảo chính sách RLS đồng thuận
    const attRes = await pool.query('SELECT * FROM attachment WHERE id = $1', [id]);
    if (attRes.rows.length === 0) {
      await logAccessDenied(req, 'attachment', id, 'RLS blocked attachment view');
      return res.status(403).json({ code: 'FORBIDDEN_ATTACHMENT', message: 'Bạn không có quyền xem tệp đính kèm này.' });
    }
    const att = attRes.rows[0];
    const roleCodes = getUserRoleCodes(req);
    const isSysAdmin = roleCodes.includes('SYS_ADMIN');
    const isOwner = roleCodes.includes('OWNER');
    const isManager = roleCodes.includes('MANAGER');
    const isResident = roleCodes.includes('RESIDENT');

    if (att.owner_entity === 'contract') {
      const cRes = await adminPool.query(
        `SELECT c.building_id, t.person_id
         FROM contract c
         JOIN building b ON b.id = c.building_id
         JOIN tenant t ON t.id = c.primary_tenant_id
         WHERE c.id = $1 AND b.org_id = $2`,
        [att.owner_id, req.user.org_id]
      );
      if (cRes.rows.length === 0) {
        return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy hợp đồng của tệp đính kèm.' });
      }
      const { building_id, person_id } = cRes.rows[0];
      if (!isSysAdmin) {
        if (isOwner) {
          const ownedIds = await getOwnerBuildingIds(req.user.sub, req.user.org_id);
          if (!ownedIds.includes(building_id)) {
            await logAccessDenied(req, 'attachment', id, 'OWNER viewed contract attachment of unowned building');
            return res.status(403).json({ code: 'FORBIDDEN_ATTACHMENT', message: 'Bạn không có quyền xem tệp đính kèm này.' });
          }
        } else if (isManager) {
          const mgrIds = await getManagerBuildingIds(req.user.sub, req.user.org_id);
          if (!mgrIds.includes(building_id)) {
            await logAccessDenied(req, 'attachment', id, 'MANAGER viewed contract attachment of unassigned building');
            return res.status(403).json({ code: 'FORBIDDEN_ATTACHMENT', message: 'Bạn không có quyền xem tệp đính kèm này.' });
          }
        } else if (isResident && person_id !== req.user.person_id) {
          await logAccessDenied(req, 'attachment', id, 'RESIDENT viewed another resident contract attachment');
          return res.status(403).json({ code: 'FORBIDDEN_ATTACHMENT', message: 'Bạn không có quyền xem tệp đính kèm này.' });
        }
      }
    } else if (att.owner_entity === 'person') {
      if (isOwner && !isSysAdmin && !isManager) {
        await logAccessDenied(req, 'attachment', id, 'OWNER attempted raw person CCCD attachment view');
        return res.status(403).json({
          code: 'FORBIDDEN_ATTACHMENT',
          message: 'Theo chính sách bảo mật dữ liệu cá nhân (PRD 13.5), Chủ đầu tư không truy cập trực tiếp ảnh giấy tờ gốc.',
        });
      }
      const ok = await pool.query(
        `SELECT 1 FROM person p WHERE p.id = $1 AND p.org_id = $2`,
        [att.owner_id, req.user.org_id]
      );
      if (ok.rows.length === 0) {
        await logAccessDenied(req, 'attachment', id, 'Forbidden PII attachment access');
        return res.status(403).json({ code: 'FORBIDDEN_ATTACHMENT', message: 'Bạn không có quyền xem tệp đính kèm này.' });
      }
    } else if (['service_request', 'payment', 'meter_reading', 'deposit', 'apartment', 'tenant'].includes(att.owner_entity)) {
      // Đã qua kiểm tra RLS can_select_attachment ở dòng 27 trên chính xác owner_entity & owner_id
    } else {
      return res.status(403).json({ code: 'FORBIDDEN_ATTACHMENT', message: 'Loại tệp đính kèm chưa hỗ trợ xem.' });
    }

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
      if (att.mime === 'application/pdf') {
        res.setHeader('Content-Disposition', `inline; filename="contract-scan-${String(att.id).slice(0, 8)}.pdf"`);
      }
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
