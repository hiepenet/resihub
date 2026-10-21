import express from 'express';
import { pool, getUserClient } from '../db/client.js';
import { authenticateToken } from '../middleware/auth.js';
import { requireRole } from '../middleware/rbac.js';

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

  if (!apartment_id || !building_id || !primary_tenant_id || !start_date || !end_date || !rent_amount) {
    return res.status(422).json({
      code: 'VALIDATION_ERROR',
      message: 'Thiếu thông tin bắt buộc: Căn hộ, Tòa nhà, Khách thuê, Ngày bắt đầu, Ngày kết thúc hoặc Giá thuê.',
    });
  }

  // Kiểm tra quyền quản lý tòa nhà của Manager
  const checkMgr = await pool.query(
    'SELECT 1 FROM user_role WHERE user_id = $1 AND building_id = $2',
    [req.user.sub, building_id]
  );
  if (checkMgr.rows.length === 0) {
    return res.status(403).json({
      code: 'ACCESS_DENIED',
      message: 'Bạn không có quyền quản lý tòa nhà này để lập hợp đồng.',
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
    const aptCheck = await client.query(
      `SELECT status FROM apartment WHERE id = $1`,
      [apartment_id]
    );
    if (aptCheck.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy căn hộ.' });
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
        building_id,
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
    console.error('[Create Contract Error]:', err);
    res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi máy chủ khi tạo hợp đồng.' });
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
      const aptCheck = await client.query(`SELECT status FROM apartment WHERE id = $1`, [nextApartment]);
      if (aptCheck.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy căn hộ.' });
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
    console.error('[Update Draft Contract Error]:', err);
    res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi máy chủ khi cập nhật hợp đồng.' });
  } finally {
    await release();
  }
});

/**
 * POST /api/v1/contracts/:id/terminate
 * Chấm dứt hợp đồng thuê (NV-10)
 * Quyền: OWNER (R), MANAGER (CRU)
 */
router.post('/:id/terminate', authenticateToken, requireRole(['OWNER', 'MANAGER']), async (req, res) => {
  const { id } = req.params;
  const { reason, note } = req.body;

  const { client, release } = await getUserClient(req);
  try {
    await client.query('BEGIN');

    const contractCheck = await client.query('SELECT * FROM contract WHERE id = $1', [id]);
    if (contractCheck.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy hợp đồng.' });
    }

    const currentContract = contractCheck.rows[0];
    if (currentContract.status !== 'ACTIVE') {
      await client.query('ROLLBACK');
      return res.status(400).json({
        code: 'INVALID_STATUS',
        message: `Hợp đồng đang ở trạng thái ${currentContract.status}, chỉ hợp đồng ACTIVE mới có thể chấm dứt.`,
      });
    }

    // 1. Cập nhật contract sang TERMINATED
    const updatedRes = await client.query(
      `UPDATE contract SET status = 'TERMINATED', note = COALESCE($1, note), updated_at = NOW() WHERE id = $2 RETURNING *`,
      [note ? `${currentContract.note || ''} [Lý do chấm dứt: ${reason || ''} - ${note}]` : null, id]
    );

    // 2. Căn hộ chuyển MAINTENANCE (A1): chờ bàn giao/nghiệm thu mới về AVAILABLE, không khai thác ngay
    await client.query(
      `UPDATE apartment SET status = 'MAINTENANCE', updated_at = NOW() WHERE id = $1`,
      [currentContract.apartment_id]
    );

    // 3. Ghi audit log
    await client.query(
      `INSERT INTO audit_log (actor_id, action, entity, entity_id, before, after)
       VALUES ($1, 'TERMINATE', 'contract', $2, $3, $4)`,
      [req.user.sub, id, JSON.stringify(currentContract), JSON.stringify(updatedRes.rows[0])]
    );

    await client.query('COMMIT');
    res.json({ message: 'Chấm dứt hợp đồng thành công. Căn hộ chuyển sang trạng thái bảo trì, chờ bàn giao và tất toán cọc.', data: updatedRes.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[Terminate Contract Error]:', err);
    res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi chấm dứt hợp đồng.' });
  } finally {
    await release();
  }
});

export default router;
