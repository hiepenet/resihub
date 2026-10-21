import express from 'express';
import { pool, getUserClient } from '../db/client.js';
import { authenticateToken } from '../middleware/auth.js';
import { requireRole } from '../middleware/rbac.js';
import { saveBase64Image } from '../services/imageUpload.js';

const router = express.Router();

/**
 * GET /api/v1/tenants/check-dup
 * Kiểm tra trùng SĐT hoặc CCCD (FR-021)
 */
router.get('/check-dup', authenticateToken, requireRole(['OWNER', 'MANAGER']), async (req, res) => {
  const { phone, id_number } = req.query;
  const orgId = req.user.org_id;

  try {
    let sql = `SELECT id, full_name, phone FROM person WHERE org_id = $1 AND (`;
    const params = [orgId];
    const conditions = [];

    if (phone) {
      params.push(phone);
      conditions.push(`phone = $${params.length}`);
    }
    if (id_number) {
      params.push(id_number);
      conditions.push(`id_number = $${params.length}`);
    }

    if (conditions.length === 0) {
      return res.json({ isDuplicate: false, duplicates: [] });
    }

    sql += conditions.join(' OR ') + ')';
    const result = await pool.query(sql, params);

    res.json({
      isDuplicate: result.rows.length > 0,
      duplicates: result.rows,
    });
  } catch (err) {
    console.error('[Check Dup Error]:', err);
    res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi kiểm tra trùng lặp.' });
  }
});

/**
 * GET /api/v1/tenants
 * Quyền: OWNER (R), MANAGER (CRU)
 */
router.get('/', authenticateToken, requireRole(['OWNER', 'MANAGER']), async (req, res) => {
  try {
    const orgId = req.user.org_id;
    const userRoles = (req.user.roles || []).map((r) => (typeof r === 'string' ? r : r.code));
    const isOwner = userRoles.includes('OWNER');
    const isManager = userRoles.includes('MANAGER');

    let sql = `
      SELECT t.*, p.full_name, p.phone, p.email, p.dob, p.id_number
      FROM tenant t
      JOIN person p ON p.id = t.person_id
      WHERE t.org_id = $1
    `;
    const params = [orgId];

    if (isManager && !isOwner) {
      params.push(req.user.sub);
      sql += ` AND (
        t.id IN (
          SELECT c.primary_tenant_id FROM contract c
          WHERE c.building_id IN (SELECT building_id FROM user_role WHERE user_id = $${params.length} AND building_id IS NOT NULL)
        )
        OR t.id IN (
          SELECT co.tenant_id FROM contract_occupant co
          JOIN contract c ON c.id = co.contract_id
          WHERE c.building_id IN (SELECT building_id FROM user_role WHERE user_id = $${params.length} AND building_id IS NOT NULL)
        )
        OR NOT EXISTS (
          SELECT 1 FROM contract c WHERE c.primary_tenant_id = t.id
        )
      )`;
    }

    sql += ` ORDER BY t.created_at DESC`;

    const result = await pool.query(sql, params);

    res.json({ data: result.rows });
  } catch (err) {
    console.error('[Tenants Error]:', err);
    res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi lấy danh sách cư dân.' });
  }
});

/**
 * POST /api/v1/tenants
 * Quyền: Chỉ MANAGER có quyền tạo hồ sơ cư dân (CRU)
 */
router.post('/', authenticateToken, requireRole(['MANAGER']), async (req, res) => {
  const { full_name, phone, email, dob, id_number, type } = req.body;
  const orgId = req.user.org_id;

  if (!full_name || !phone) {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Họ tên và số điện thoại là bắt buộc.' });
  }

  const { client, release } = await getUserClient(req);
  try {
    await client.query('BEGIN');

    // 1. Tạo hoặc lấy person
    let personRes = await client.query('SELECT * FROM person WHERE org_id = $1 AND phone = $2', [orgId, phone]);
    let personId;
    if (personRes.rows.length === 0) {
      const newPerson = await client.query(
        `INSERT INTO person (org_id, full_name, phone, email, dob, id_number)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id`,
        [orgId, full_name, phone, email || null, dob || null, id_number || null]
      );
      personId = newPerson.rows[0].id;
    } else {
      personId = personRes.rows[0].id;
    }

    // 2. Tạo tenant — thiếu CCCD/hộ chiếu thì PENDING, đủ giấy tờ mới APPROVED (A6, FR-021)
    const tenantStatus = id_number ? 'APPROVED' : 'PENDING';
    const tenantRes = await client.query(
      `INSERT INTO tenant (person_id, org_id, type, status)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [personId, orgId, type || 'primary', tenantStatus]
    );

    // Audit log
    await client.query(
      `INSERT INTO audit_log (actor_id, action, entity, entity_id, after)
       VALUES ($1, 'CREATE', 'tenant', $2, $3)`,
      [req.user.sub, tenantRes.rows[0].id, JSON.stringify(tenantRes.rows[0])]
    );

    await client.query('COMMIT');
    res.status(201).json({
      message: tenantStatus === 'PENDING'
        ? 'Tạo hồ sơ cư dân thành công. Hồ sơ đang chờ duyệt vì thiếu CCCD/hộ chiếu.'
        : 'Tạo hồ sơ cư dân thành công.',
      data: tenantRes.rows[0],
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[Create Tenant Error]:', err);
    res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi máy chủ khi tạo hồ sơ cư dân.' });
  } finally {
    await release();
  }
});

/**
 * PATCH /api/v1/tenants/:id — sửa hồ sơ + duyệt cư dân (A8, FR-021)
 * body: { full_name?, phone?, email?, dob?, id_number?, action?: 'approve' | 'reject' }
 */
router.patch('/:id', authenticateToken, requireRole(['MANAGER']), async (req, res) => {
  const { id } = req.params;
  const { full_name, phone, email, dob, id_number, action } = req.body;
  const orgId = req.user.org_id;

  const { client, release } = await getUserClient(req);
  try {
    await client.query('BEGIN');

    const tenantRes = await client.query(
      `SELECT t.*, p.full_name, p.phone, p.email, p.dob, p.id_number
       FROM tenant t JOIN person p ON p.id = t.person_id
       WHERE t.id = $1 AND t.org_id = $2`,
      [id, orgId]
    );
    if (tenantRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy cư dân.' });
    }
    const tenant = tenantRes.rows[0];

    // Duyệt / từ chối
    if (action === 'approve' || action === 'reject') {
      if (tenant.status !== 'PENDING') {
        await client.query('ROLLBACK');
        return res.status(409).json({
          code: 'INVALID_STATUS',
          message: `Hồ sơ đang ở trạng thái ${tenant.status}, chỉ hồ sơ PENDING mới được duyệt/từ chối.`,
        });
      }
      const nextStatus = action === 'approve' ? 'APPROVED' : 'REJECTED';
      const finalIdNumber = id_number ?? tenant.id_number;
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
      // Duyệt kèm bổ sung giấy tờ ngay trong request
      if (id_number) {
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

    // Sửa thông tin (A8) — chọn trường cho phép
    const nextPerson = {
      full_name: full_name ?? tenant.full_name,
      phone: phone ?? tenant.phone,
      email: email ?? tenant.email,
      dob: dob ?? tenant.dob,
      id_number: id_number ?? tenant.id_number,
    };
    if (!nextPerson.full_name || !nextPerson.phone) {
      await client.query('ROLLBACK');
      return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Họ tên và số điện thoại không được để trống.' });
    }

    // FR-021: SĐT/CCCD mới không được trùng người khác trong tổ chức
    const dup = await client.query(
      `SELECT 1 FROM person
       WHERE org_id = $1 AND id <> $2 AND (
         phone = $3 OR (id_number IS NOT NULL AND id_number = $4)
       ) LIMIT 1`,
      [orgId, tenant.person_id, nextPerson.phone, nextPerson.id_number]
    );
    if (dup.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        code: 'DUPLICATE_PERSON',
        message: 'SĐT hoặc CCCD đã tồn tại trên một cư dân khác trong tổ chức.',
      });
    }

    const updPerson = await client.query(
      `UPDATE person SET full_name = $1, phone = $2, email = $3, dob = $4, id_number = $5
       WHERE id = $6 RETURNING id`,
      [nextPerson.full_name, nextPerson.phone, nextPerson.email, nextPerson.dob, nextPerson.id_number, tenant.person_id]
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
 * body: { image_base64, side: 'front'|'back' } — lưu disk + attachment, KHÔNG serve tĩnh,
 * xem ảnh chỉ qua GET /api/v1/attachments/:id/view (auth + audit READ).
 */
router.post('/:id/id-images', authenticateToken, requireRole(['MANAGER']), async (req, res) => {
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

    // Đánh dấu cạnh ảnh trong person.id_images: [{attachmentId, side}] dạng text mảng JSON
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
 * GET /api/v1/tenants/:id/id-images — danh sách ảnh (trả attachment_id để UI render qua /attachments/:id/view)
 */
router.get('/:id/id-images', authenticateToken, requireRole(['OWNER', 'MANAGER']), async (req, res) => {
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
    // Lấy side từ marker trong person.id_images
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
