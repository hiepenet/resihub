import express from 'express';
import { pool } from '../db/client.js';
import { authenticateToken } from '../middleware/auth.js';
import { requireRole } from '../middleware/rbac.js';

const router = express.Router();

/**
 * GET /api/v1/deposits
 * Quyền: OWNER (R+A), MANAGER (CRU), RESIDENT (R của mình)
 */
router.get('/', authenticateToken, requireRole(['OWNER', 'MANAGER', 'RESIDENT']), async (req, res) => {
  try {
    const orgId = req.user.org_id;
    const userRoles = (req.user.roles || []).map((r) => (typeof r === 'string' ? r : r.code));
    const isOwner = userRoles.includes('OWNER');
    const isManager = userRoles.includes('MANAGER');
    const isResident = userRoles.includes('RESIDENT');

    let sql = `SELECT d.*, 
        c.rent_amount, 
        c.start_date, 
        c.end_date, 
        c.building_id,
        a.code as apartment_code, 
        b.name as building_name, 
        p.full_name as tenant_name
       FROM deposit d
       JOIN contract c ON c.id = d.contract_id
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

    sql += ` ORDER BY d.created_at DESC`;
    const result = await pool.query(sql, params);

    res.json({ data: result.rows });
  } catch (err) {
    console.error('[Deposits Error]:', err);
    res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi khi lấy danh sách cọc.' });
  }
});

/**
 * POST /api/v1/deposits/:id/transactions
 * Thêm giao dịch cọc (collect, deduct, refund, transfer)
 */
router.post('/:id/transactions', authenticateToken, requireRole(['OWNER', 'MANAGER']), async (req, res) => {
  const { id } = req.params;
  const { type, amount, description, category } = req.body;

  if (!type || !amount) {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Loại giao dịch và số tiền là bắt buộc.' });
  }

  // PRD Rule: Tiền cọc TUYỆT ĐỐI KHÔNG ĐƯỢC CẤN TRỪ VÀO TIỀN THUÊ (Mục 5.3 / FR-068)
  if (type === 'deduct' && (category === 'rent' || (description && /tiền thuê|nợ thuê/i.test(description)))) {
    return res.status(400).json({
      code: 'RENT_OFFSET_PROHIBITED',
      message: 'Quy tắc an toàn PRD: Tiền cọc TUYỆT ĐỐI KHÔNG ĐƯỢC CẤN TRỪ VÀO TIỀN THUÊ hằng tháng.',
    });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const depositRes = await client.query('SELECT * FROM deposit WHERE id = $1', [id]);
    if (depositRes.rows.length === 0) {
      return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy sổ cọc.' });
    }

    const currentDeposit = depositRes.rows[0];
    let newAmount = BigInt(currentDeposit.amount_held);
    const txnAmount = BigInt(amount);

    if (type === 'collect') {
      newAmount += txnAmount;
    } else if (type === 'deduct' || type === 'refund') {
      if (txnAmount > newAmount) {
        return res.status(400).json({ code: 'INSUFFICIENT_FUNDS', message: 'Số tiền khấu trừ/hoàn trả vượt quá số dư cọc.' });
      }
      newAmount -= txnAmount;
    }

    const txnRes = await client.query(
      `INSERT INTO deposit_transaction (deposit_id, type, amount, description, approved_by, approved_at, created_by)
       VALUES ($1, $2, $3, $4, $5, NOW(), $5)
       RETURNING *`,
      [id, type, amount, description || '', req.user.sub]
    );

    const newStatus = newAmount === 0n && (type === 'refund' || type === 'deduct') ? 'REFUNDED' : 'HELD';

    await client.query(
      `UPDATE deposit SET amount_held = $1, status = $2, updated_at = NOW() WHERE id = $3`,
      [newAmount.toString(), newStatus, id]
    );

    // Audit log
    await client.query(
      `INSERT INTO audit_log (actor_id, action, entity, entity_id, after)
       VALUES ($1, 'CREATE', 'deposit_transaction', $2, $3)`,
      [req.user.sub, txnRes.rows[0].id, JSON.stringify(txnRes.rows[0])]
    );

    await client.query('COMMIT');
    res.status(201).json({ message: 'Ghi nhận giao dịch cọc thành công.', data: txnRes.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[Deposit Transaction Error]:', err);
    res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi ghi nhận giao dịch cọc.' });
  } finally {
    client.release();
  }
});

export default router;
