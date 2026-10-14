import express from 'express';
import { pool } from '../db/client.js';
import { authenticateToken } from '../middleware/auth.js';
import { requireRole } from '../middleware/rbac.js';

const router = express.Router();

/**
 * GET /api/v1/contracts
 */
router.get('/', authenticateToken, async (req, res) => {
  try {
    const orgId = req.user.org_id;
    const result = await pool.query(
      `SELECT c.*, 
        a.code as apartment_code, 
        b.name as building_name, 
        p.full_name as tenant_name, 
        p.phone as tenant_phone
       FROM contract c
       JOIN apartment a ON a.id = c.apartment_id
       JOIN building b ON b.id = c.building_id
       JOIN tenant t ON t.id = c.primary_tenant_id
       JOIN person p ON p.id = t.person_id
       WHERE b.org_id = $1
       ORDER BY c.created_at DESC`,
      [orgId]
    );

    res.json({ data: result.rows });
  } catch (err) {
    console.error('[Contracts Error]:', err);
    res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi khi lấy danh sách hợp đồng.' });
  }
});

/**
 * POST /api/v1/contracts
 */
router.post('/', authenticateToken, requireRole(['OWNER', 'MANAGER', 'SYS_ADMIN']), async (req, res) => {
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

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

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
        deposit_amount || 0,
        req.user.sub,
        note || '',
      ]
    );

    const contract = contractRes.rows[0];

    // 2. Cập nhật trạng thái căn hộ -> OCCUPIED
    await client.query(
      `UPDATE apartment SET status = 'OCCUPIED' WHERE id = $1`,
      [apartment_id]
    );

    // 3. Nếu có deposit_amount > 0, tự động mở sổ cọc
    if (deposit_amount > 0) {
      await client.query(
        `INSERT INTO deposit (contract_id, amount_held, status)
         VALUES ($1, $2, 'HELD')`,
        [contract.id, deposit_amount]
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

export default router;
