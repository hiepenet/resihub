import express from 'express';
import { pool } from '../db/client.js';
import { authenticateToken } from '../middleware/auth.js';
import { requireRole } from '../middleware/rbac.js';

const router = express.Router();

/**
 * GET /api/v1/contracts
 * PRD 6.2: OWNER(R), MANAGER(CRU+A), ACCOUNTANT(R), SYS_ADMIN(R), RESIDENT(R của mình), STAFF(– BỊ CHẶN)
 */
router.get('/', authenticateToken, requireRole(['OWNER', 'MANAGER', 'ACCOUNTANT', 'SYS_ADMIN', 'RESIDENT']), async (req, res) => {
  try {
    const orgId = req.user.org_id;
    const userRoles = (req.user.roles || []).map((r) => (typeof r === 'string' ? r : r.code));
    const isResidentOnly = userRoles.includes('RESIDENT') && !userRoles.some((r) => ['SYS_ADMIN', 'MANAGER', 'OWNER', 'ACCOUNTANT'].includes(r));

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

    if (isResidentOnly) {
      params.push(req.user.person_id);
      sql += ` AND p.id = $2`;
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
router.get('/:id', authenticateToken, requireRole(['OWNER', 'MANAGER', 'ACCOUNTANT', 'SYS_ADMIN', 'RESIDENT']), async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query(
      `SELECT c.*, 
        a.code as apartment_code, 
        b.name as building_name, 
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
    const isResidentOnly = userRoles.includes('RESIDENT') && !userRoles.some((r) => ['SYS_ADMIN', 'MANAGER', 'OWNER', 'ACCOUNTANT'].includes(r));
    if (isResidentOnly && row.tenant_phone !== req.user.phone && row.tenant_email !== req.user.email) {
      return res.status(403).json({ code: 'FORBIDDEN', message: 'Bạn chỉ có quyền xem hợp đồng của chính mình.' });
    }

    res.json({ data: row });
  } catch (err) {
    console.error('[Get Contract Error]:', err);
    res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi khi lấy chi tiết hợp đồng.' });
  }
});

/**
 * POST /api/v1/contracts (NV-08 — TẠO HỢP ĐỒNG THUÊ)
 * PRD 6.2: Chỉ MANAGER và SYS_ADMIN được tạo hợp đồng (OWNER: R, STAFF: –)
 */
router.post('/', authenticateToken, requireRole(['MANAGER', 'SYS_ADMIN']), async (req, res) => {
  const {
    apartment_id,
    building_id,
    primary_tenant_id,
    start_date,
    end_date,
    rent_amount,
    billing_cycle,
    billing_day,
    deposit_amount,
    note,
  } = req.body;

  if (!apartment_id || !building_id || !primary_tenant_id || !start_date || !end_date || !rent_amount) {
    return res.status(400).json({
      code: 'VALIDATION_ERROR',
      message: 'Thiếu các trường bắt buộc (phòng, tòa nhà, người thuê, ngày bắt đầu, ngày kết thúc, giá thuê).',
    });
  }

  // Validate end_date > start_date
  if (new Date(end_date) <= new Date(start_date)) {
    return res.status(422).json({
      code: 'VALIDATION_ERROR',
      message: 'Ngày kết thúc hợp đồng phải lớn hơn ngày bắt đầu.',
    });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Rule: Chặn trùng lấn kỳ hạn trên cùng căn hộ (FR-014 / NV-08)
    const overlapCheck = await client.query(
      `SELECT id, start_date, end_date FROM contract
       WHERE apartment_id = $1 AND status = 'ACTIVE'
         AND NOT (end_date <= $2 OR start_date >= $3)`,
      [apartment_id, start_date, end_date]
    );

    if (overlapCheck.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        code: 'OVERLAP_CONTRACT',
        message: 'Đã tồn tại hợp đồng đang hiệu lực chồng lấn kỳ hạn trên căn hộ này.',
        conflicting_contract: overlapCheck.rows[0],
      });
    }

    // Tiền cọc mặc định là 1 tháng tiền thuê (PRD mục 10.3) nếu không nhập
    const finalDeposit = deposit_amount !== undefined ? deposit_amount : rent_amount;

    // 1. Tạo hợp đồng
    const contractRes = await client.query(
      `INSERT INTO contract (
        apartment_id, building_id, primary_tenant_id, start_date, end_date,
        rent_amount, billing_cycle, billing_day, deposit_amount, status,
        created_by, note
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'ACTIVE', $10, $11)
      RETURNING *`,
      [
        apartment_id,
        building_id,
        primary_tenant_id,
        start_date,
        end_date,
        rent_amount,
        billing_cycle || 'monthly',
        billing_day || 1,
        finalDeposit,
        req.user.sub,
        note || '',
      ]
    );

    const contract = contractRes.rows[0];

    // 2. Cập nhật trạng thái căn hộ -> OCCUPIED
    await client.query(
      `UPDATE apartment SET status = 'OCCUPIED', updated_at = NOW() WHERE id = $1`,
      [apartment_id]
    );

    // 3. Nếu có finalDeposit > 0, tự động mở sổ cọc HELD (NV-11)
    if (finalDeposit > 0) {
      await client.query(
        `INSERT INTO deposit (contract_id, amount_held, status)
         VALUES ($1, $2, 'HELD')`,
        [contract.id, finalDeposit]
      );
    }

    // 4. Ghi audit log
    await client.query(
      `INSERT INTO audit_log (actor_id, action, entity, entity_id, after)
       VALUES ($1, 'CREATE', 'contract', $2, $3)`,
      [req.user.sub, contract.id, JSON.stringify(contract)]
    );

    await client.query('COMMIT');
    res.status(201).json({ message: 'Tạo hợp đồng thành công.', data: contract });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[Create Contract Error]:', err);
    res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi máy chủ khi tạo hợp đồng.' });
  } finally {
    client.release();
  }
});

/**
 * POST /api/v1/contracts/:id/terminate
 * Chấm dứt hợp đồng thuê (NV-10)
 */
router.post('/:id/terminate', authenticateToken, requireRole(['OWNER', 'MANAGER', 'SYS_ADMIN']), async (req, res) => {
  const { id } = req.params;
  const { reason, note } = req.body;

  const client = await pool.connect();
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

    // 2. Chuyển căn hộ về AVAILABLE để sẵn sàng bàn giao / khai thác
    await client.query(
      `UPDATE apartment SET status = 'AVAILABLE', updated_at = NOW() WHERE id = $1`,
      [currentContract.apartment_id]
    );

    // 3. Ghi audit log
    await client.query(
      `INSERT INTO audit_log (actor_id, action, entity, entity_id, before, after)
       VALUES ($1, 'TERMINATE', 'contract', $2, $3, $4)`,
      [req.user.sub, id, JSON.stringify(currentContract), JSON.stringify(updatedRes.rows[0])]
    );

    await client.query('COMMIT');
    res.json({ message: 'Chấm dứt hợp đồng thành công. Căn hộ đã mở lại trạng thái sẵn sàng.', data: updatedRes.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[Terminate Contract Error]:', err);
    res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi chấm dứt hợp đồng.' });
  } finally {
    client.release();
  }
});

export default router;
