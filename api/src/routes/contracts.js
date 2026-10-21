import express from 'express';
import { pool, getUserClient } from '../db/client.js';
import { authenticateToken } from '../middleware/auth.js';
import { requireRole } from '../middleware/rbac.js';
import { saveBase64Image } from '../services/imageUpload.js';
import { isDiscountedPrice, mapPgError } from '../services/contractGuards.js';
import { refundDeadline } from '../services/deadlines.js';
import { splitDepositOpening } from '../services/depositSettlement.js';
import { buildDiff, nextStatusOnAmend } from '../services/amendment.js';

const router = express.Router();

/**
 * GET /api/v1/contracts
 * - OWNER: Xem toàn bộ hợp đồng trong tổ chức (R)
 * - MANAGER: Xem hợp đồng thuộc các tòa do mình quản lý (CRU)
 * - RESIDENT: Xem hợp đồng của chính mình (R)
 */
router.get('/', authenticateToken, requireRole(['OWNER', 'MANAGER', 'RESIDENT']), async (req, res) => {
  try {
    const orgId = req.user.org_id;
    const userRoles = (req.user.roles || []).map((r) => (typeof r === 'string' ? r : r.code));
    const isOwner = userRoles.includes('OWNER');
    const isManager = userRoles.includes('MANAGER');
    const isResident = userRoles.includes('RESIDENT');

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

    if (isManager && !isOwner) {
      params.push(req.user.sub);
      sql += ` AND c.building_id IN (
        SELECT building_id FROM user_role WHERE user_id = $${params.length} AND building_id IS NOT NULL
      )`;
    } else if (isResident && !isOwner && !isManager) {
      params.push(req.user.person_id);
      sql += ` AND p.id = $${params.length}`;
    }

    sql += ` ORDER BY c.created_at DESC`;
    const result = await pool.query(sql, params);

    res.json({ data: result.rows });
  } catch (err) {
    console.error('[Contracts Error]:', err);
    res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi khi lấy danh sách hợp đồng.' });
  }
});

/**
 * GET /api/v1/contracts/requests (FR-019)
 * Danh sách đề nghị gia hạn/chấm dứt từ cư dân dành cho BQL/Chủ nhà
 */
router.get('/requests', authenticateToken, requireRole(['OWNER', 'MANAGER']), async (req, res) => {
  try {
    const orgId = req.user.org_id;
    const userRoles = (req.user.roles || []).map((r) => (typeof r === 'string' ? r : r.code));
    const isOwner = userRoles.includes('OWNER');
    const isManager = userRoles.includes('MANAGER');
    const { building_id, status } = req.query;

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

    if (isManager && !isOwner) {
      params.push(req.user.sub);
      sql += ` AND cr.building_id IN (
        SELECT building_id FROM user_role WHERE user_id = $${params.length} AND building_id IS NOT NULL
      )`;
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
    const result = await pool.query(sql, params);
    res.json({ data: result.rows });
  } catch (err) {
    console.error('[Contract Requests Error]:', err);
    res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi khi lấy danh sách đề nghị hợp đồng.' });
  }
});

/**
 * POST /api/v1/contracts/requests/:id/approve (OWNER)
 * Phê duyệt đề nghị gia hạn/chấm dứt từ cư dân
 */
router.post('/requests/:id/approve', authenticateToken, requireRole(['OWNER']), async (req, res) => {
  const { id } = req.params;
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
 * POST /api/v1/contracts/requests/:id/reject (OWNER)
 * Từ chối đề nghị gia hạn/chấm dứt từ cư dân
 */
router.post('/requests/:id/reject', authenticateToken, requireRole(['OWNER']), async (req, res) => {
  const { id } = req.params;
  const { reason } = req.body;
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
router.get('/:id', authenticateToken, requireRole(['OWNER', 'MANAGER', 'RESIDENT']), async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query(
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

    const row = result.rows[0];
    const userRoles = (req.user.roles || []).map((r) => (typeof r === 'string' ? r : r.code));
    const isOwner = userRoles.includes('OWNER');
    const isManager = userRoles.includes('MANAGER');
    const isResident = userRoles.includes('RESIDENT');

    if (isManager && !isOwner) {
      const checkMgr = await pool.query(
        'SELECT 1 FROM user_role WHERE user_id = $1 AND building_id = $2',
        [req.user.sub, row.building_id]
      );
      if (checkMgr.rows.length === 0) {
        return res.status(403).json({ code: 'FORBIDDEN', message: 'Bạn không có quyền quản lý hợp đồng của tòa nhà này.' });
      }
    } else if (isResident && !isOwner && !isManager) {
      if (row.person_id !== req.user.person_id) {
        return res.status(403).json({ code: 'FORBIDDEN', message: 'Bạn chỉ có quyền xem hợp đồng của chính mình.' });
      }
    }

    res.json({ data: row });
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
    start_date,
    end_date,
    rent_amount,
    billing_day,
    deposit_amount,
    deposit_months,
    note,
  } = req.body;

  if (!apartment_id || !primary_tenant_id || !start_date || !end_date || !rent_amount) {
    return res.status(422).json({
      code: 'VALIDATION_ERROR',
      message: 'Thiếu thông tin bắt buộc: Căn hộ, Khách thuê, Ngày bắt đầu, Ngày kết thúc hoặc Giá thuê.',
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

    // Kiểm tra quyền quản lý tòa nhà của Manager
    const checkMgr = await client.query(
      'SELECT 1 FROM user_role WHERE user_id = $1 AND building_id = $2',
      [req.user.sub, effectiveBuildingId]
    );
    if (checkMgr.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(403).json({
        code: 'ACCESS_DENIED',
        message: 'Bạn không có quyền quản lý tòa nhà này để lập hợp đồng.',
      });
    }

    if (!['AVAILABLE', 'RESERVED'].includes(aptCheck.rows[0].status)) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        code: 'INVALID_APARTMENT_STATUS',
        message: `Căn hộ đang ở trạng thái ${aptCheck.rows[0].status}, chỉ căn AVAILABLE hoặc RESERVED mới ký được hợp đồng.`,
      });
    }

    // Rule C1 & NV-08: Chống chồng lấn kỳ hạn trên cùng căn hộ
    // Half-open [start, end) — HĐ kết thúc tại ngày D cho phép HĐ mới bắt đầu D (PRD 13.3)
    const overlapCheck = await client.query(
      `SELECT c.id, c.start_date, c.end_date, t.id AS tenant_id, p.full_name
       FROM contract c
       JOIN tenant t ON t.id = c.primary_tenant_id
       JOIN person p ON p.id = t.person_id
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
        primary_tenant_id,
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
      [req.user.sub, contract.id, JSON.stringify(contract)]
    );

    await client.query('COMMIT');
    res.status(201).json({ message: 'Đã lưu nháp. Tải bản ký, đính kèm bản scan rồi kích hoạt để hoàn tất.', data: contract });
  } catch (err) {
    await client.query('ROLLBACK');
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
router.get('/:id/occupants', authenticateToken, requireRole(['MANAGER']), async (req, res) => {
  const { id } = req.params;
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

  const { client, release } = await getUserClient(req);
  try {
    await client.query('BEGIN');

    // Guard tòa (mẫu checkMgr)
    const contractRes = await client.query('SELECT * FROM contract WHERE id = $1', [id]);
    if (contractRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy hợp đồng.' });
    }
    const contract = contractRes.rows[0];
    const okRes = await client.query(
      'SELECT 1 FROM user_role WHERE user_id = $1 AND building_id = $2',
      [req.user.sub, contract.building_id]
    );
    if (okRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(403).json({ code: 'ACCESS_DENIED', message: 'Bạn không có quyền quản lý hợp đồng này.' });
    }

    // Tái dùng person trùng SĐT trong org, không thì tạo mới
    let personRes = await client.query(
      'SELECT * FROM person WHERE org_id = $1 AND phone = $2',
      [req.user.org_id, phone]
    );
    let personId;
    if (personRes.rows.length === 0) {
      personId = (await client.query(
        `INSERT INTO person (org_id, full_name, phone, email, dob, id_number)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [req.user.org_id, full_name, phone, email || null, dob || null, id_number || null]
      )).rows[0].id;
    } else {
      personId = personRes.rows[0].id;
      // Bổ sung thông tin còn thiếu vào person có sẵn
      await client.query(
        `UPDATE person SET
           full_name = COALESCE($1, full_name),
           email = COALESCE($2, email),
           dob = COALESCE($3, dob),
           id_number = COALESCE($4, id_number)
         WHERE id = $5`,
        [full_name || null, email || null, dob || null, id_number || null, personId]
      );
    }

    // Tìm tenant occupant của person, chưa có thì tạo
    let tenantRes = await client.query(
      `SELECT * FROM tenant WHERE person_id = $1 AND org_id = $2 AND type = 'occupant' LIMIT 1`,
      [personId, req.user.org_id]
    );
    let tenantId;
    if (tenantRes.rows.length === 0) {
      tenantId = (await client.query(
        `INSERT INTO tenant (person_id, org_id, type, status)
         VALUES ($1, $2, 'occupant', 'APPROVED') RETURNING id`,
        [personId, req.user.org_id]
      )).rows[0].id;
    } else {
      tenantId = tenantRes.rows[0].id;
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
    res.status(201).json({ message: 'Đã thêm thành viên cùng ở.', data: { contract_id: id, tenant_id: tenantId, relationship: relationship || 'family' } });
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
  const { client, release } = await getUserClient(req);
  try {
    await client.query('BEGIN');

    const contractRes = await client.query('SELECT * FROM contract WHERE id = $1', [id]);
    if (contractRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy hợp đồng.' });
    }
    const okRes = await client.query(
      'SELECT 1 FROM user_role WHERE user_id = $1 AND building_id = $2',
      [req.user.sub, contractRes.rows[0].building_id]
    );
    if (okRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(403).json({ code: 'ACCESS_DENIED', message: 'Bạn không có quyền quản lý hợp đồng này.' });
    }

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

  const { client, release } = await getUserClient(req);
  try {
    await client.query('BEGIN');

    const curRes = await client.query('SELECT * FROM contract WHERE id = $1', [id]);
    if (curRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy hợp đồng.' });
    }
    const cur = curRes.rows[0];

    // C6: Guard quyền quản lý tòa nhà của Manager
    const checkMgr = await client.query(
      'SELECT 1 FROM user_role WHERE user_id = $1 AND building_id = $2',
      [req.user.sub, cur.building_id]
    );
    if (checkMgr.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(403).json({
        code: 'ACCESS_DENIED',
        message: 'Bạn không có quyền quản lý tòa nhà của hợp đồng này.',
      });
    }

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

      if (!['AVAILABLE', 'RESERVED'].includes(aptCheck.rows[0].status)) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          code: 'INVALID_APARTMENT_STATUS',
          message: `Căn hộ đang ở trạng thái ${aptCheck.rows[0].status}, chỉ căn AVAILABLE hoặc RESERVED mới gán được cho nháp hợp đồng.`,
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
 * Đề xuất chấm dứt hợp đồng thuê (FR-017, C8, D4)
 * Quyền: OWNER (R), MANAGER (CRU)
 * Hợp đồng chuyển sang TERMINATION_PENDING, căn hộ vẫn OCCUPIED, chờ OWNER phê duyệt
 */
router.post('/:id/terminate', authenticateToken, requireRole(['OWNER', 'MANAGER']), async (req, res) => {
  const { id } = req.params;
  const { terminated_date, reason, note } = req.body;

  const { client, release } = await getUserClient(req);
  try {
    await client.query('BEGIN');

    const contractCheck = await client.query('SELECT * FROM contract WHERE id = $1', [id]);
    if (contractCheck.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy hợp đồng.' });
    }

    const currentContract = contractCheck.rows[0];

    // Guard quyền theo tòa nếu là Manager
    const userRoles = (req.user.roles || []).map((r) => (typeof r === 'string' ? r : r.code));
    if (userRoles.includes('MANAGER') && !userRoles.includes('OWNER')) {
      const checkMgr = await client.query(
        'SELECT 1 FROM user_role WHERE user_id = $1 AND building_id = $2',
        [req.user.sub, currentContract.building_id]
      );
      if (checkMgr.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(403).json({ code: 'ACCESS_DENIED', message: 'Bạn không có quyền quản lý tòa nhà của hợp đồng này.' });
      }
    }

    if (currentContract.status !== 'ACTIVE') {
      await client.query('ROLLBACK');
      return res.status(400).json({
        code: 'INVALID_STATUS',
        message: `Hợp đồng đang ở trạng thái ${currentContract.status}, chỉ hợp đồng ACTIVE mới có thể đề xuất chấm dứt.`,
      });
    }

    const termDate = terminated_date || new Date().toISOString().split('T')[0];
    const sDate = currentContract.start_date.toISOString ? currentContract.start_date.toISOString().split('T')[0] : String(currentContract.start_date);
    const eDate = currentContract.end_date.toISOString ? currentContract.end_date.toISOString().split('T')[0] : String(currentContract.end_date);

    if (termDate < sDate || termDate > eDate) {
      await client.query('ROLLBACK');
      return res.status(422).json({
        code: 'INVALID_TERMINATION_DATE',
        message: 'Ngày chấm dứt phải nằm trong kỳ hạn của hợp đồng.',
      });
    }

    const reasonSuffix = reason ? `[Đề xuất chấm dứt: ${reason}${note ? ' - ' + note : ''}]` : (note ? `[Đề xuất chấm dứt: ${note}]` : '');
    const newNote = reasonSuffix ? `${currentContract.note || ''} ${reasonSuffix}`.trim() : currentContract.note;

    // 1. Chuyển hợp đồng sang TERMINATION_PENDING, ghi mốc ngày terminated_at
    const updatedRes = await client.query(
      `UPDATE contract
       SET status = 'TERMINATION_PENDING', terminated_at = $1, note = $2, updated_at = NOW()
       WHERE id = $3 RETURNING *`,
      [termDate, newNote, id]
    );

    // Căn hộ giữ nguyên trạng thái OCCUPIED cho tới khi OWNER duyệt chính thức

    // 2. Ghi audit log
    await client.query(
      `INSERT INTO audit_log (actor_id, action, entity, entity_id, before, after)
       VALUES ($1, 'TERMINATE_REQUEST', 'contract', $2, $3, $4)`,
      [req.user.sub, id, JSON.stringify(currentContract), JSON.stringify(updatedRes.rows[0])]
    );

    await client.query('COMMIT');
    res.json({
      message: 'Đã gửi đề xuất chấm dứt hợp đồng. Đang chờ Chủ đầu tư (OWNER) phê duyệt.',
      data: updatedRes.rows[0],
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[Terminate Request Error]:', err);
    res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi khi đề xuất chấm dứt hợp đồng.' });
  } finally {
    await release();
  }
});

/**
 * POST /api/v1/contracts/:id/terminate/approve
 * Phê duyệt chấm dứt hợp đồng thuê (FR-017, C8, D4)
 * Quyền: Chỉ OWNER có quyền duyệt
 * Ràng buộc Four-eyes: Người đề xuất không được tự duyệt
 */
router.post('/:id/terminate/approve', authenticateToken, requireRole(['OWNER']), async (req, res) => {
  const { id } = req.params;
  const { client, release } = await getUserClient(req);

  try {
    await client.query('BEGIN');

    const contractCheck = await client.query('SELECT * FROM contract WHERE id = $1', [id]);
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

    // 2. Căn hộ chuyển sang MAINTENANCE chờ nghiệm thu bàn giao
    await client.query(
      `UPDATE apartment SET status = 'MAINTENANCE', updated_at = NOW() WHERE id = $1`,
      [currentContract.apartment_id]
    );

    // 3. Gán hạn hoàn cọc (refund_due_date = ngày chấm dứt + 5 ngày theo FR-068) trên sổ cọc
    const termAt = currentContract.terminated_at
      ? (currentContract.terminated_at.toISOString ? currentContract.terminated_at.toISOString().split('T')[0] : String(currentContract.terminated_at))
      : new Date().toISOString().split('T')[0];
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
 * Từ chối đề xuất chấm dứt hợp đồng (quay lại ACTIVE)
 * Quyền: Chỉ OWNER
 */
router.post('/:id/terminate/reject', authenticateToken, requireRole(['OWNER']), async (req, res) => {
  const { id } = req.params;
  const { reason } = req.body;

  if (!reason || !reason.trim()) {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Lý do từ chối là bắt buộc.' });
  }

  const { client, release } = await getUserClient(req);
  try {
    await client.query('BEGIN');

    const contractCheck = await client.query('SELECT * FROM contract WHERE id = $1', [id]);
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
  // 1. Căn phải còn AVAILABLE/RESERVED (ai đó có thể đã ký căn này trước)
  const aptRes = await client.query(
    `SELECT a.status, a.base_rent, b.id AS building_id
     FROM apartment a JOIN building b ON b.id = a.building_id
     WHERE a.id = $1`,
    [contract.apartment_id]
  );
  const apt = aptRes.rows[0];
  if (['AVAILABLE', 'RESERVED'].indexOf(apt.status) === -1) {
    return { error: { status: 409, code: 'INVALID_APARTMENT_STATUS', message: `Căn hộ đang ở trạng thái ${apt.status}, không thể kích hoạt hợp đồng.` } };
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

  // 4. ACTIVE + chuyển cọc giữ chỗ thành cọc hợp đồng (FR-067)
  const activeRes = await client.query(
    `UPDATE contract SET status = 'ACTIVE', updated_at = NOW() WHERE id = $1 RETURNING *`,
    [contract.id]
  );

  const rsvRes = await client.query(
    `SELECT id, hold_amount FROM reservation
     WHERE apartment_id = $1 AND status = 'HELD'
     ORDER BY created_at DESC LIMIT 1`,
    [contract.apartment_id]
  );

  const opensDeposit = contract.deposit_amount > 0 || rsvRes.rows.length > 0;
  let remainingCollect = 0n;

  if (opensDeposit) {
    const existing = await client.query(`SELECT id FROM deposit WHERE contract_id = $1`, [contract.id]);
    if (existing.rows.length === 0) {
      const holdAmount = rsvRes.rows.length > 0 ? rsvRes.rows[0].hold_amount : null;
      const split = splitDepositOpening({
        depositAmount: contract.deposit_amount,
        holdAmount,
      });
      remainingCollect = split.remainingCollect;

      const depRes = await client.query(
        `INSERT INTO deposit (contract_id, source_reservation_id, amount_held, status)
         VALUES ($1, $2, $3, 'HELD')
         RETURNING id`,
        [contract.id, rsvRes.rows[0]?.id ?? null, split.openHeld.toString()]
      );

      const newDepositId = depRes.rows[0].id;

      if (split.openHeld > 0n && rsvRes.rows.length > 0) {
        await client.query(
          `INSERT INTO deposit_transaction (
             deposit_id, type, amount, description, method, status, approved_by, approved_at, created_by
           )
           VALUES ($1, 'transfer', $2, 'Chuyển cọc giữ chỗ thành cọc hợp đồng', 'TRANSFER', 'APPROVED', $3, NOW(), $3)`,
          [newDepositId, split.openHeld.toString(), req.user.sub]
        );
      }
    }
    if (rsvRes.rows.length > 0) {
      await client.query(`UPDATE reservation SET status = 'CONVERTED', updated_at = NOW() WHERE id = $1`, [rsvRes.rows[0].id]);
    }
  }

  // 5. Căn hộ: ACTIVE ngay hôm nay → OCCUPIED; start_date tương lai → RESERVED, job hằng ngày sẽ flip
  await client.query(
    `UPDATE apartment SET status = CASE WHEN $2::date <= CURRENT_DATE THEN 'OCCUPIED' ELSE 'RESERVED' END,
     updated_at = NOW() WHERE id = $1`,
    [contract.apartment_id, contract.start_date]
  );

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
    `SELECT c.*, t.id AS tenant_id, t.status AS tenant_status, p.id AS person_id, p.id_number
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
        message: 'Giá thuê thấp hơn 10% so với giá niêm yết, hợp đồng chuyển sang chờ chủ đầu tư phê duyệt (PENDING_APPROVAL).',
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

router.post('/:id/approve', authenticateToken, requireRole(['OWNER']), async (req, res) => {
  const { id } = req.params;
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

router.post('/:id/cancel', authenticateToken, requireRole(['MANAGER']), async (req, res) => {
  const { id } = req.params;
  const { reason } = req.body;
  const { client, release } = await getUserClient(req);
  try {
    await client.query('BEGIN');
    const curRes = await client.query('SELECT * FROM contract WHERE id = $1', [id]);
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
  try {
    const contractRes = await pool.query('SELECT id, building_id FROM contract WHERE id = $1', [id]);
    if (contractRes.rows.length === 0 || contractRes.rows[0].building_id === null) {
      return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy hợp đồng.' });
    }
    const ok = await pool.query(
      `SELECT 1 FROM user_role WHERE user_id = $1 AND building_id = $2`,
      [req.user.sub, contractRes.rows[0].building_id]
    );
    if (ok.rows.length === 0) {
      return res.status(403).json({ code: 'ACCESS_DENIED', message: 'Bạn không có quyền quản lý hợp đồng này.' });
    }
    const saved = await saveBase64Image({
      imageBase64: image_base64,
      folder: 'contract',
      entityId: id,
      entity: 'contract',
      ownerId: id,
      req,
      query: (sql, params) => pool.query(sql, params),
    });
    if (saved.error) {
      return res.status(400).json(saved.error);
    }
    await pool.query(
      `INSERT INTO audit_log (actor_id, action, entity, entity_id, after)
       VALUES ($1, 'UPLOAD', 'attachment', $2, $3)`,
      [req.user.sub, saved.attachment.id, JSON.stringify(saved.attachment)]
    );
    res.status(201).json({ message: 'Đã đính kèm bản scan hợp đồng.', data: saved.attachment });
  } catch (err) {
    console.error('[Upload Contract Scan Error]:', err);
    res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi máy chủ khi đính kèm bản scan.' });
  }
});

export const SERVICE_CODES = ['INTERNET', 'MOTORBIKE_PARKING', 'ELECTRICBIKE_PARKING', 'TRASH', 'COMMON_SERVICE'];

/**
 * GET /api/v1/contracts/:id/service-prices (FR-065, C1)
 */
router.get('/:id/service-prices', authenticateToken, requireRole(['OWNER', 'MANAGER', 'RESIDENT']), async (req, res) => {
  const { id } = req.params;
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
 */
router.post('/:id/service-prices', authenticateToken, requireRole(['OWNER', 'MANAGER']), async (req, res) => {
  const { id } = req.params;
  const { service_code, unit_price, effective_from } = req.body;

  if (!service_code || !SERVICE_CODES.includes(service_code)) {
    return res.status(422).json({
      code: 'INVALID_SERVICE_CODE',
      message: `Mã dịch vụ không hợp lệ. Phải thuộc: ${SERVICE_CODES.join(', ')}.`
    });
  }

  const priceNum = Number(unit_price);
  if (unit_price === undefined || unit_price === null || isNaN(priceNum) || priceNum < 0) {
    return res.status(422).json({
      code: 'INVALID_UNIT_PRICE',
      message: 'Đơn giá dịch vụ phải lớn hơn hoặc bằng 0.'
    });
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
      [id, service_code, priceNum, effFrom]
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
 * # ponytail: chưa chặn theo invoice vì M09 chưa dựng — thêm guard khi M09 có kỳ phát hành < effective_from thay đổi
 */
router.delete('/:id/service-prices/:priceId', authenticateToken, requireRole(['OWNER', 'MANAGER']), async (req, res) => {
  const { id, priceId } = req.params;
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
router.get('/:id/amendments', authenticateToken, requireRole(['OWNER', 'MANAGER', 'RESIDENT']), async (req, res) => {
  const { id } = req.params;
  const { client, release } = await getUserClient(req);
  try {
    const versionsRes = await client.query(
      `SELECT cv.*, 
              u.email as approved_by_email,
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
 * POST /api/v1/contracts/:id/amendments (FR-016, FR-015, C7)
 * Đề xuất phụ lục hợp đồng (MANAGER/OWNER) — Lưu ý 1: Không áp dụng diff trước khi duyệt
 */
router.post('/:id/amendments', authenticateToken, requireRole(['OWNER', 'MANAGER']), async (req, res) => {
  const { id } = req.params;
  const { changes, reason, effective_from } = req.body;

  if (!reason || !reason.trim()) {
    return res.status(400).json({ code: 'REASON_REQUIRED', message: 'Vui lòng cung cấp lý do lập phụ lục hợp đồng.' });
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
      message: 'Đã lập đề xuất phụ lục hợp đồng, chờ Chủ đầu tư (OWNER) phê duyệt.',
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
 * OWNER phê duyệt và áp dụng phụ lục vào hợp đồng
 */
router.post('/:id/amendments/:versionId/approve', authenticateToken, requireRole(['OWNER']), async (req, res) => {
  const { id, versionId } = req.params;
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
 * OWNER từ chối phụ lục hợp đồng
 */
router.post('/:id/amendments/:versionId/reject', authenticateToken, requireRole(['OWNER']), async (req, res) => {
  const { id, versionId } = req.params;
  const { reason } = req.body;

  if (!reason || !reason.trim()) {
    return res.status(400).json({ code: 'REASON_REQUIRED', message: 'Vui lòng cung cấp lý do từ chối phụ lục.' });
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
      `INSERT INTO audit_log (actor_id, action, entity, entity_id, note, after)
       VALUES ($1, 'REJECT_AMENDMENT', 'contract_version', $2, $3, $4)`,
      [req.user.sub, versionId, reason.trim(), JSON.stringify(updatedDiff)]
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
router.get('/:id/template', authenticateToken, requireRole(['OWNER', 'MANAGER']), async (req, res) => {
  const { id } = req.params;
  try {
    const contractRes = await pool.query(
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

    // Kiểm tra quyền theo tòa nếu là MANAGER
    const userRoles = (req.user.roles || []).map((r) => (typeof r === 'string' ? r : r.code));
    if (userRoles.includes('MANAGER') && !userRoles.includes('OWNER')) {
      const checkMgr = await pool.query(
        'SELECT 1 FROM user_role WHERE user_id = $1 AND building_id = $2',
        [req.user.sub, c.building_id]
      );
      if (checkMgr.rows.length === 0) {
        return res.status(403).send('<h1>403 Bạn không có quyền truy cập tòa nhà này</h1>');
      }
    }

    // Lấy thành viên cùng ở
    const occRes = await pool.query(
      `SELECT co.relationship, p.full_name, p.phone, p.id_number
       FROM contract_occupant co
       JOIN person p ON p.id = co.person_id
       WHERE co.contract_id = $1
       ORDER BY co.created_at ASC`,
      [id]
    );
    const occupants = occRes.rows;

    // Lấy bảng giá dịch vụ
    const spRes = await pool.query(
      `SELECT code, custom_price, effective_from
       FROM contract_service_price
       WHERE contract_id = $1
       ORDER BY code ASC`,
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
      ELEC: { name: 'Điện sinh hoạt', unit: 'kWh' },
      WATER: { name: 'Nước sinh hoạt', unit: 'm³' },
      INTERNET: { name: 'Internet / Wifi', unit: 'tháng' },
      CLEANING: { name: 'Vệ sinh & Rác thải', unit: 'tháng' },
      PARKING_MOTO: { name: 'Gửi xe máy', unit: 'xe/tháng' },
      PARKING_CAR: { name: 'Gửi xe ô tô', unit: 'xe/tháng' },
      MANAGEMENT: { name: 'Phí quản lý tòa nhà', unit: 'tháng' },
    };

    const serviceRowsHtml = servicePrices.length > 0
      ? servicePrices.map((sp, idx) => {
          const meta = serviceCodeLabels[sp.code] || { name: sp.code, unit: 'tháng' };
          return `
            <tr>
              <td style="text-align:center;">${idx + 1}</td>
              <td><strong>${meta.name}</strong> (${sp.code})</td>
              <td style="text-align:center;">${meta.unit}</td>
              <td style="text-align:right; font-weight:600;">${fmtMoney(sp.custom_price)}</td>
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
  }
});

export default router;
