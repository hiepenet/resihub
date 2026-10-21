import express from 'express';
import { pool, getUserClient } from '../db/client.js';
import { authenticateToken } from '../middleware/auth.js';
import { requireRole } from '../middleware/rbac.js';
import { validateDeduction, computeRefund } from '../services/depositSettlement.js';

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
        c.status as contract_status,
        c.terminated_at,
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

/**
 * GET /api/v1/deposits/:id/settlement
 * # ponytail: outstanding_debt là input kế toán, thay bằng query invoice khi M09 dựng
 */
router.get('/:id/settlement', authenticateToken, requireRole(['OWNER', 'MANAGER', 'RESIDENT']), async (req, res) => {
  const { id } = req.params;
  const { client, release } = await getUserClient(req);
  try {
    const q = await client.query(
      `SELECT d.id, d.contract_id, d.amount_held, d.status, d.settlement, d.refund_due_date,
              c.status as contract_status, c.building_id, c.start_date, c.end_date, c.terminated_at,
              a.code as apartment_code, b.name as building_name, p.full_name as tenant_name
       FROM deposit d
       JOIN contract c ON c.id = d.contract_id
       JOIN apartment a ON a.id = c.apartment_id
       JOIN building b ON b.id = c.building_id
       JOIN tenant t ON t.id = c.primary_tenant_id
       JOIN person p ON p.id = t.person_id
       WHERE d.id = $1`,
      [id]
    );
    if (q.rows.length === 0) {
      return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy sổ cọc.' });
    }
    const row = q.rows[0];
    res.json({
      data: {
        deposit_id: row.id,
        contract_id: row.contract_id,
        amount_held: row.amount_held,
        status: row.status,
        contract_status: row.contract_status,
        terminated_at: row.terminated_at,
        settlement: row.settlement,
        refund_due_date: row.refund_due_date,
        apartment_code: row.apartment_code,
        building_name: row.building_name,
        tenant_name: row.tenant_name,
      }
    });
  } catch (err) {
    console.error('[Get Settlement Error]:', err);
    res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi khi tải hồ sơ tất toán.' });
  } finally {
    await release();
  }
});

/**
 * POST /api/v1/deposits/:id/settlement
 * Lập hồ sơ tất toán (MANAGER/OWNER)
 */
router.post('/:id/settlement', authenticateToken, requireRole(['OWNER', 'MANAGER']), async (req, res) => {
  const { id } = req.params;
  const { outstanding_debt = 0, items = [], refund_method = 'BANK_TRANSFER', bank_info = {} } = req.body;

  const { client, release } = await getUserClient(req);
  try {
    await client.query('BEGIN');

    const depRes = await client.query(
      `SELECT d.*, c.status as contract_status, c.building_id
       FROM deposit d
       JOIN contract c ON c.id = d.contract_id
       WHERE d.id = $1 FOR UPDATE`,
      [id]
    );

    if (depRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy sổ cọc.' });
    }

    const dep = depRes.rows[0];

    // Guard: deposit status phải ở HELD hoặc SETTLEMENT_DRAFT
    if (!['HELD', 'SETTLEMENT_DRAFT'].includes(dep.status)) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        code: 'DEPOSIT_NOT_HELD',
        message: 'Chỉ có thể lập hồ sơ tất toán cho khoản cọc đang giữ (HELD) hoặc bản nháp tất toán (SETTLEMENT_DRAFT).'
      });
    }

    // 🚨 Lỗi 2 Fix: Hợp đồng phải ở TERMINATED hoặc EXPIRED
    if (!['TERMINATED', 'EXPIRED'].includes(dep.contract_status)) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        code: 'CONTRACT_NOT_TERMINATED_OR_EXPIRED',
        message: 'Hợp đồng phải ở trạng thái TERMINATED hoặc EXPIRED mới được mở hồ sơ tất toán.'
      });
    }

    const debtNum = Number(outstanding_debt);
    if (isNaN(debtNum) || debtNum < 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        code: 'INVALID_DEBT',
        message: 'Công nợ tồn đọng không hợp lệ (phải >= 0).'
      });
    }

    if (!Array.isArray(items)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ code: 'INVALID_ITEMS', message: 'Danh sách khoản trừ không hợp lệ.' });
    }

    for (const item of items) {
      const v = validateDeduction(item);
      if (!v.ok) {
        await client.query('ROLLBACK');
        return res.status(422).json({ code: v.code, message: v.message });
      }
    }

    // Tính refund bằng computeRefund (AC-017)
    const { refund, shortfall } = computeRefund({
      depositAmount: dep.amount_held,
      outstandingDebt: debtNum,
      items
    });

    const settlementPayload = {
      items,
      outstanding_debt: debtNum,
      refund_amount: Number(refund),
      shortfall: Number(shortfall),
      refund_method,
      bank_info,
      created_by: req.user.sub,
      created_at: new Date().toISOString()
    };

    await client.query(
      `UPDATE deposit SET settlement = $1, status = 'PENDING_APPROVAL', updated_at = NOW() WHERE id = $2`,
      [JSON.stringify(settlementPayload), id]
    );

    await client.query(
      `INSERT INTO audit_log (actor_id, action, entity, entity_id, after)
       VALUES ($1, 'SETTLEMENT_SUBMIT', 'deposit', $2, $3)`,
      [req.user.sub, id, JSON.stringify(settlementPayload)]
    );

    await client.query('COMMIT');
    res.status(200).json({
      message: 'Đã gửi hồ sơ tất toán cọc, chờ OWNER phê duyệt.',
      data: { settlement: settlementPayload, status: 'PENDING_APPROVAL' }
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[Settlement Submit Error]:', err);
    res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi khi lập hồ sơ tất toán.' });
  } finally {
    await release();
  }
});

/**
 * POST /api/v1/deposits/:id/settlement/approve
 * OWNER phê duyệt hồ sơ tất toán (Four-eyes)
 */
router.post('/:id/settlement/approve', authenticateToken, requireRole(['OWNER']), async (req, res) => {
  const { id } = req.params;
  const { client, release } = await getUserClient(req);
  try {
    await client.query('BEGIN');

    const depRes = await client.query(
      `SELECT d.*, c.primary_tenant_id, c.building_id
       FROM deposit d
       JOIN contract c ON c.id = d.contract_id
       WHERE d.id = $1 FOR UPDATE`,
      [id]
    );

    if (depRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy sổ cọc.' });
    }

    const dep = depRes.rows[0];

    if (dep.status === 'DISPUTED') {
      await client.query('ROLLBACK');
      return res.status(409).json({
        code: 'SETTLEMENT_DISPUTED',
        message: 'Hồ sơ tất toán đang trong tình trạng tranh chấp, không thể phê duyệt (FR-024).'
      });
    }

    if (dep.status !== 'PENDING_APPROVAL') {
      await client.query('ROLLBACK');
      return res.status(409).json({
        code: 'NOT_PENDING_APPROVAL',
        message: 'Chỉ có thể phê duyệt hồ sơ tất toán đang chờ duyệt (PENDING_APPROVAL).'
      });
    }

    const settlement = dep.settlement;
    if (!settlement) {
      await client.query('ROLLBACK');
      return res.status(400).json({ code: 'NO_SETTLEMENT_DATA', message: 'Không có dữ liệu tất toán.' });
    }

    // Four-eyes check: AC-017.3
    if (settlement.created_by && settlement.created_by === req.user.sub) {
      await client.query('ROLLBACK');
      return res.status(403).json({
        code: 'SELF_APPROVAL',
        message: 'Nguyên tắc Four-eyes: Người tạo hồ sơ tất toán không được tự duyệt.'
      });
    }

    // Ghi nhận từng khoản khấu trừ vào deposit_transaction
    const items = settlement.items || [];
    for (const item of items) {
      await client.query(
        `INSERT INTO deposit_transaction (
           deposit_id, type, amount, category, description, evidence, status, method, approved_by, approved_at, created_by
         )
         VALUES ($1, 'deduct', $2, $3, $4, $5, 'APPROVED', $6, $7, NOW(), $8)`,
        [
          id,
          item.amount,
          item.category,
          item.description,
          item.evidence || [],
          item.method || 'OTHER',
          req.user.sub,
          settlement.created_by || req.user.sub
        ]
      );
    }

    // Ghi nhận hoàn cọc nếu có refund_amount > 0
    if (settlement.refund_amount > 0) {
      await client.query(
        `INSERT INTO deposit_transaction (
           deposit_id, type, amount, description, status, method, approved_by, approved_at, created_by
         )
         VALUES ($1, 'refund', $2, $3, 'APPROVED', $4, $5, NOW(), $6)`,
        [
          id,
          settlement.refund_amount,
          'Hoàn trả tiền cọc sau tất toán',
          settlement.refund_method || 'BANK_TRANSFER',
          req.user.sub,
          settlement.created_by || req.user.sub
        ]
      );
    }

    // 🚨 Lỗi 3 Fix: Đưa dứt điểm số dư cọc về 0 khi tất toán thành công (AC-017.1)
    await client.query(
      `UPDATE deposit SET amount_held = 0, status = 'REFUNDED', updated_at = NOW() WHERE id = $1`,
      [id]
    );

    // Audit log
    await client.query(
      `INSERT INTO audit_log (actor_id, action, entity, entity_id, after)
       VALUES ($1, 'SETTLEMENT_APPROVE', 'deposit', $2, $3)`,
      [req.user.sub, id, JSON.stringify(settlement)]
    );

    // Notification cho cư dân
    try {
      const uRes = await client.query(
        `SELECT u.id as user_id 
         FROM tenant t
         JOIN app_user u ON u.person_id = t.person_id
         WHERE t.id = $1`,
        [dep.primary_tenant_id]
      );
      if (uRes.rows.length > 0) {
        await client.query(
          `INSERT INTO notification (user_id, title, content, type, payload)
           VALUES ($1, 'Hồ sơ tất toán cọc đã được phê duyệt', 'Chủ nhà đã phê duyệt tất toán cọc cho hợp đồng của bạn.', 'SETTLEMENT_APPROVED', $2)`,
          [uRes.rows[0].user_id, JSON.stringify({ deposit_id: id, settlement })]
        );
      }
    } catch (nErr) {
      console.warn('[Notification settlement approve warning]:', nErr.message);
    }

    await client.query('COMMIT');
    res.json({ message: 'Phê duyệt hồ sơ tất toán thành công.', data: { id, status: 'REFUNDED' } });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[Settlement Approve Error]:', err);
    res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi khi phê duyệt hồ sơ tất toán.' });
  } finally {
    await release();
  }
});

/**
 * POST /api/v1/deposits/:id/settlement/reject
 * OWNER từ chối hồ sơ tất toán (chuyển về SETTLEMENT_DRAFT)
 */
router.post('/:id/settlement/reject', authenticateToken, requireRole(['OWNER']), async (req, res) => {
  const { id } = req.params;
  const { reason } = req.body;

  if (!reason || !reason.trim()) {
    return res.status(400).json({ code: 'REASON_REQUIRED', message: 'Vui lòng cung cấp lý do từ chối hồ sơ tất toán.' });
  }

  const { client, release } = await getUserClient(req);
  try {
    await client.query('BEGIN');

    const depRes = await client.query('SELECT * FROM deposit WHERE id = $1 FOR UPDATE', [id]);
    if (depRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy sổ cọc.' });
    }

    const dep = depRes.rows[0];
    if (dep.status !== 'PENDING_APPROVAL') {
      await client.query('ROLLBACK');
      return res.status(409).json({ code: 'NOT_PENDING_APPROVAL', message: 'Chỉ có thể từ chối hồ sơ đang chờ duyệt.' });
    }

    const updatedSettlement = {
      ...(dep.settlement || {}),
      rejected_by: req.user.sub,
      rejected_at: new Date().toISOString(),
      rejection_reason: reason.trim(),
    };

    await client.query(
      `UPDATE deposit SET status = 'SETTLEMENT_DRAFT', settlement = $1, updated_at = NOW() WHERE id = $2`,
      [JSON.stringify(updatedSettlement), id]
    );

    await client.query(
      `INSERT INTO audit_log (actor_id, action, entity, entity_id, note, after)
       VALUES ($1, 'SETTLEMENT_REJECT', 'deposit', $2, $3, $4)`,
      [req.user.sub, id, reason.trim(), JSON.stringify(updatedSettlement)]
    );

    await client.query('COMMIT');
    res.json({ message: 'Đã từ chối hồ sơ tất toán, chuyển về trạng thái nháp.', data: { id, status: 'SETTLEMENT_DRAFT' } });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[Settlement Reject Error]:', err);
    res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi khi từ chối hồ sơ tất toán.' });
  } finally {
    await release();
  }
});

/**
 * POST /api/v1/deposits/:id/dispute
 * Chuyển hồ sơ sang tranh chấp (DISPUTED)
 */
router.post('/:id/dispute', authenticateToken, requireRole(['OWNER', 'MANAGER']), async (req, res) => {
  const { id } = req.params;
  const { reason } = req.body;

  if (!reason || !reason.trim()) {
    return res.status(400).json({ code: 'REASON_REQUIRED', message: 'Vui lòng cung cấp lý do tranh chấp.' });
  }

  const { client, release } = await getUserClient(req);
  try {
    await client.query('BEGIN');

    const depRes = await client.query('SELECT * FROM deposit WHERE id = $1 FOR UPDATE', [id]);
    if (depRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy sổ cọc.' });
    }

    const dep = depRes.rows[0];
    if (dep.status !== 'PENDING_APPROVAL') {
      await client.query('ROLLBACK');
      return res.status(409).json({ code: 'INVALID_STATUS', message: 'Chỉ có thể ghi nhận tranh chấp từ hồ sơ chờ duyệt (PENDING_APPROVAL).' });
    }

    const updatedSettlement = {
      ...(dep.settlement || {}),
      disputed_by: req.user.sub,
      disputed_at: new Date().toISOString(),
      dispute_reason: reason.trim(),
    };

    await client.query(
      `UPDATE deposit SET status = 'DISPUTED', settlement = $1, updated_at = NOW() WHERE id = $2`,
      [JSON.stringify(updatedSettlement), id]
    );

    await client.query(
      `INSERT INTO audit_log (actor_id, action, entity, entity_id, note, after)
       VALUES ($1, 'SETTLEMENT_DISPUTE', 'deposit', $2, $3, $4)`,
      [req.user.sub, id, reason.trim(), JSON.stringify(updatedSettlement)]
    );

    await client.query('COMMIT');
    res.json({ message: 'Đã chuyển hồ sơ cọc sang trạng thái tranh chấp (DISPUTED).', data: { id, status: 'DISPUTED' } });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[Settlement Dispute Error]:', err);
    res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi khi ghi nhận tranh chấp cọc.' });
  } finally {
    await release();
  }
});

export default router;
