import express from 'express';
import { pool } from '../db/client.js';
import { authenticateToken } from '../middleware/auth.js';
import { requireRole } from '../middleware/rbac.js';

const router = express.Router();

/**
 * GET /api/v1/deposits
 */
router.get('/', authenticateToken, async (req, res) => {
  try {
    const orgId = req.user.org_id;
    const result = await pool.query(
      `SELECT d.*, 
        c.rent_amount, 
        c.start_date, 
        c.end_date, 
        a.code as apartment_code, 
        b.name as building_name, 
        p.full_name as tenant_name
       FROM deposit d
       JOIN contract c ON c.id = d.contract_id
       JOIN apartment a ON a.id = c.apartment_id
       JOIN building b ON b.id = c.building_id
       JOIN tenant t ON t.id = c.primary_tenant_id
       JOIN person p ON p.id = t.person_id
       WHERE b.org_id = $1
       ORDER BY d.created_at DESC`,
      [orgId]
    );

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
router.post('/:id/transactions', authenticateToken, requireRole(['OWNER', 'ACCOUNTANT', 'MANAGER', 'SYS_ADMIN']), async (req, res) => {
  const { id } = req.params;
  const { type, amount, description } = req.body;

  if (!type || !amount) {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Loại giao dịch và số tiền là bắt buộc.' });
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
