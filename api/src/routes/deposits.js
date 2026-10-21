import express from 'express';
import { pool, getUserClient } from '../db/client.js';
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
 * Thêm giao dịch cọc (chỉ cho phép collect hoặc transfer)
 * deduct/refund chỉ được thực hiện qua luồng /settlement có phê duyệt (FR-024)
 */
router.post('/:id/transactions', authenticateToken, requireRole(['OWNER', 'MANAGER']), async (req, res) => {
  const { id } = req.params;
  const { type, amount, description, method } = req.body;

  if (type === 'deduct' || type === 'refund') {
    return res.status(409).json({
      code: 'MUST_USE_SETTLEMENT',
      message: 'Khấu trừ/hoàn cọc chỉ thực hiện qua hồ sơ tất toán có phê duyệt (FR-024).'
    });
  }

  if (type !== 'collect' && type !== 'transfer') {
    return res.status(400).json({
      code: 'INVALID_TRANSACTION_TYPE',
      message: 'Loại giao dịch không hợp lệ. Chỉ chấp nhận collect hoặc transfer.'
    });
  }

  const numAmount = Number(amount);
  if (!amount || isNaN(numAmount) || numAmount <= 0) {
    return res.status(400).json({
      code: 'INVALID_AMOUNT',
      message: 'Số tiền giao dịch phải lớn hơn 0.'
    });
  }

  if (type === 'collect' && !method) {
    return res.status(400).json({
      code: 'METHOD_REQUIRED',
      message: 'Phương thức thanh toán là bắt buộc khi thu tiền cọc (vd: BANK_TRANSFER, CASH).'
    });
  }

  const { client, release } = await getUserClient(req);
  try {
    await client.query('BEGIN');

    const depositRes = await client.query('SELECT * FROM deposit WHERE id = $1 FOR UPDATE', [id]);
    if (depositRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy sổ cọc.' });
    }

    const currentDeposit = depositRes.rows[0];
    const txnAmount = BigInt(amount);
    const newAmount = BigInt(currentDeposit.amount_held) + txnAmount;

    const txnRes = await client.query(
      `INSERT INTO deposit_transaction (
         deposit_id, type, amount, description, method, status, approved_by, approved_at, created_by
       )
       VALUES ($1, $2, $3, $4, $5, 'APPROVED', $6, NOW(), $6)
       RETURNING *`,
      [
        id,
        type,
        amount,
        description || (type === 'collect' ? 'Thu bổ sung cọc' : 'Chuyển đổi cọc giữ chỗ'),
        method || (type === 'transfer' ? 'TRANSFER' : 'OTHER'),
        req.user.sub
      ]
    );

    const newStatus = currentDeposit.status === 'DISPUTED' ? 'DISPUTED' : 'HELD';

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
    await release();
  }
});

export default router;
