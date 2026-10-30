import express from 'express';
import { pool, adminPool, getUserClient } from '../db/client.js';
import { authenticateToken } from '../middleware/auth.js';
import { requireRole } from '../middleware/rbac.js';
import { validateDeduction, computeRefund, resolvePostSettlementStatus } from '../services/depositSettlement.js';
import {
  getUserRoleCodes,
  getOwnerBuildingIds,
  getManagerBuildingIds,
  logAccessDenied,
} from '../services/ownerScope.js';
import { checkFourEyesOrWarn } from '../services/pricing.js';

const router = express.Router();

async function getOperatorReadBuildingIds(userId, orgId, roleCodes) {
  const ids = new Set();
  if (roleCodes.includes('OWNER')) {
    (await getOwnerBuildingIds(userId, orgId)).forEach((id) => ids.add(id));
  }
  if (roleCodes.includes('MANAGER')) {
    (await getManagerBuildingIds(userId, orgId)).forEach((id) => ids.add(id));
  }
  return Array.from(ids);
}

async function getDepositWriteBuildingIds(userId, orgId, roleCodes) {
  const ids = new Set();
  if (roleCodes.includes('MANAGER')) {
    (await getManagerBuildingIds(userId, orgId)).forEach((id) => ids.add(id));
  }
  return Array.from(ids);
}

/**
 * Tổng hợp tự động công nợ hóa đơn đang mở của hợp đồng (R-06):
 * - serviceDebt: công nợ dịch vụ / điện / nước / phạt chậm (KHÔNG gồm RENT) -> được đối trừ tự động vào tiền cọc.
 * - rentDebt: công nợ tiền thuê phòng (RENT) -> TUYỆT ĐỐI KHÔNG đối trừ vào tiền cọc.
 */
async function calculateContractOpenDebts(client, contractId) {
  const invRes = await client.query(
    `SELECT i.id,
            i.invoice_code,
            i.period,
            i.total_amount,
            i.paid_amount,
            i.status,
            COALESCE(SUM(il.amount) FILTER (WHERE il.item_type = 'RENT'), 0)::bigint AS rent_gross,
            COALESCE(SUM(il.amount) FILTER (WHERE il.item_type <> 'RENT'), 0)::bigint AS non_rent_gross
     FROM invoice i
     LEFT JOIN invoice_line il ON il.invoice_id = i.id
     WHERE i.contract_id = $1
       AND i.status IN ('ISSUED', 'PARTIALLY_PAID', 'OVERDUE')
     GROUP BY i.id
     ORDER BY i.period ASC, i.created_at ASC`,
    [contractId]
  );

  let serviceDebt = 0;
  let rentDebt = 0;
  const openInvoices = [];

  for (const row of invRes.rows) {
    const total = Math.max(0, Number(row.total_amount || 0));
    const paid = Math.max(0, Number(row.paid_amount || 0));
    const remaining = Math.max(0, total - paid);
    if (remaining <= 0) continue;

    const rentGross = Math.max(0, Number(row.rent_gross || 0));
    const nonRentGross = Math.max(0, Number(row.non_rent_gross || 0));

    let invRentUnpaid = 0;
    let invServiceUnpaid = 0;

    if (rentGross === 0 && nonRentGross === 0) {
      // Trường hợp hóa đơn không có dòng chi tiết -> coi như dịch vụ/khác
      invServiceUnpaid = remaining;
    } else {
      // Phân bổ phần đã trả ưu tiên cho RENT trước để nợ dịch vụ/điện nước còn lại khớp thực tế
      const paidToRent = Math.min(paid, rentGross);
      const paidToNonRent = Math.max(0, paid - paidToRent);
      invRentUnpaid = Math.max(0, Math.min(remaining, rentGross - paidToRent));
      invServiceUnpaid = Math.max(0, remaining - invRentUnpaid);
      if (nonRentGross === 0) {
        invRentUnpaid = remaining;
        invServiceUnpaid = 0;
      } else if (rentGross === 0) {
        invServiceUnpaid = remaining;
        invRentUnpaid = 0;
      } else if (paidToNonRent > 0) {
        invServiceUnpaid = Math.max(0, nonRentGross - paidToNonRent);
        invRentUnpaid = Math.max(0, remaining - invServiceUnpaid);
      }
    }

    serviceDebt += invServiceUnpaid;
    rentDebt += invRentUnpaid;
    openInvoices.push({
      id: row.id,
      invoice_code: row.invoice_code,
      period: row.period,
      total_amount: total,
      paid_amount: paid,
      remaining,
      rent_unpaid: invRentUnpaid,
      service_unpaid: invServiceUnpaid,
    });
  }

  return {
    serviceDebt: Math.round(serviceDebt),
    rentDebt: Math.round(rentDebt),
    openInvoices,
  };
}

/**
 * Kiểm tra điều kiện tiên quyết trước khi lập hồ sơ tất toán cọc (R-06 / Mục 3.7):
 * 1) Hợp đồng đã kết thúc (TERMINATED / EXPIRED)
 * 2) Nếu hợp đồng đã nhận phòng và căn hộ có đồng hồ điện/nước khởi tạo trước/trong ngày kết thúc -> phải có chỉ số kỳ cuối
 * 3) Không còn hóa đơn DRAFT chưa phát hành/chưa hủy trên hợp đồng
 */
async function checkSettlementPreconditions(client, contractRow) {
  const contractEnded = ['TERMINATED', 'EXPIRED'].includes(contractRow.contract_status);

  const toDateStr = (val) => {
    if (!val) return null;
    if (val instanceof Date) return val.toISOString().slice(0, 10);
    return String(val).slice(0, 10);
  };

  const startStr = toDateStr(contractRow.start_date);
  const endRefStr = toDateStr(contractRow.terminated_at) || toDateStr(contractRow.end_date);
  const endPeriod = endRefStr ? endRefStr.slice(0, 7) : null;
  const movedIn = Boolean(startStr && endRefStr && endRefStr >= startStr);

  let missingMeterTypes = [];
  if (movedIn && endRefStr && endPeriod && contractRow.apartment_id) {
    const meterRes = await client.query(
      `SELECT m.meter_type
       FROM meter m
       WHERE m.apartment_id = $1
         AND m.created_at::date <= $2::date
         AND NOT EXISTS (
           SELECT 1 FROM meter_reading mr
           WHERE mr.meter_id = m.id
             AND mr.period >= $3
         )`,
      [contractRow.apartment_id, endRefStr, endPeriod]
    );
    missingMeterTypes = meterRes.rows.map((r) => r.meter_type);
  }
  const finalMetersRecorded = missingMeterTypes.length === 0;

  const draftInvRes = await client.query(
    `SELECT COUNT(*)::int AS cnt
     FROM invoice
     WHERE contract_id = $1 AND status = 'DRAFT'`,
    [contractRow.contract_id]
  );
  const draftInvoiceCount = draftInvRes.rows[0]?.cnt || 0;
  const noDraftInvoices = draftInvoiceCount === 0;

  return {
    ready: contractEnded && finalMetersRecorded && noDraftInvoices,
    contract_ended: contractEnded,
    final_meters_recorded: finalMetersRecorded,
    missing_meter_types: missingMeterTypes,
    no_draft_invoices: noDraftInvoices,
    draft_invoice_count: draftInvoiceCount,
  };
}

function escapeHtml(val) {
  return String(val ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * GET /api/v1/deposits
 * Quyền theo mô hình 4 vai trò (R-01):
 * - SYS_ADMIN: R toàn tổ chức
 * - OWNER: R (100% Read-Only trên tòa sở hữu)
 * - MANAGER: R trên tòa được phân công
 * - RESIDENT: R sổ cọc của mình
 */
router.get(
  '/',
  authenticateToken,
  requireRole(['SYS_ADMIN', 'OWNER', 'MANAGER', 'RESIDENT']),
  async (req, res) => {
    try {
      const orgId = req.user.org_id;
      const userRoles = getUserRoleCodes(req);
      const isSysAdmin = userRoles.includes('SYS_ADMIN');
      const isOperator = userRoles.some((r) => ['OWNER', 'MANAGER'].includes(r));
      const isResident = userRoles.includes('RESIDENT');

      let sql = `SELECT d.*, 
          c.deposit_amount,
          c.rent_amount, 
          c.start_date, 
          c.end_date, 
          c.status as contract_status,
          c.terminated_at,
          c.building_id,
          a.code as apartment_code, 
          b.name as building_name, 
          b.code as building_code,
          p.full_name as tenant_name
         FROM deposit d
         JOIN contract c ON c.id = d.contract_id
         JOIN apartment a ON a.id = c.apartment_id
         JOIN building b ON b.id = c.building_id
         JOIN tenant t ON t.id = c.primary_tenant_id
         JOIN person p ON p.id = t.person_id
         WHERE b.org_id = $1`;
      const params = [orgId];

      if (isSysAdmin) {
        // SYS_ADMIN: Xem toàn bộ sổ cọc trong org
      } else if (isOperator) {
        const bIds = await getOperatorReadBuildingIds(req.user.sub, orgId, userRoles);
        if (bIds.length === 0) {
          sql += ' AND 1 = 0';
        } else {
          params.push(bIds);
          sql += ` AND c.building_id = ANY($${params.length}::uuid[])`;
        }
      } else if (isResident) {
        params.push(req.user.person_id);
        sql += ` AND (
          p.id = $${params.length}
          OR EXISTS (
            SELECT 1 FROM contract_occupant co
            JOIN tenant t_occ ON t_occ.id = co.tenant_id
            WHERE co.contract_id = c.id AND t_occ.person_id = $${params.length}
          )
        )`;
      }

      sql += ` ORDER BY d.created_at DESC`;
      const result = await pool.query(sql, params);

      res.json({ data: result.rows });
    } catch (err) {
      console.error('[Deposits Error]:', err);
      res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi khi lấy danh sách cọc.' });
    }
  }
);

/**
 * GET /api/v1/deposits/:id/transactions
 * Lịch sử biến động sổ cọc (thu cọc, khấu trừ, hoàn cọc)
 */
router.get(
  '/:id/transactions',
  authenticateToken,
  requireRole(['SYS_ADMIN', 'OWNER', 'MANAGER', 'RESIDENT']),
  async (req, res) => {
    const { id } = req.params;
    try {
      const existRes = await adminPool.query(
        `SELECT d.id, d.contract_id, c.building_id, t.person_id
         FROM deposit d
         JOIN contract c ON c.id = d.contract_id
         JOIN building b ON b.id = c.building_id
         JOIN tenant t ON t.id = c.primary_tenant_id
         WHERE d.id = $1 AND b.org_id = $2`,
        [id, req.user.org_id]
      );
      if (existRes.rows.length === 0) {
        return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy sổ cọc.' });
      }
      const meta = existRes.rows[0];
      const roleCodes = getUserRoleCodes(req);

      if (!roleCodes.includes('SYS_ADMIN')) {
        if (roleCodes.some((r) => ['OWNER', 'MANAGER'].includes(r))) {
          const allowedIds = await getOperatorReadBuildingIds(req.user.sub, req.user.org_id, roleCodes);
          if (!allowedIds.includes(meta.building_id)) {
            await logAccessDenied(req, 'deposit', id, 'Operator accessed deposit transactions outside building scope');
            return res.status(403).json({ code: 'ACCESS_DENIED', message: 'Bạn không có quyền truy cập sổ cọc của tòa nhà này.' });
          }
        } else if (roleCodes.includes('RESIDENT') && meta.person_id !== req.user.person_id) {
          const occCheck = await adminPool.query(
            `SELECT 1 FROM contract_occupant co
             JOIN tenant t_occ ON t_occ.id = co.tenant_id
             WHERE co.contract_id = $1 AND t_occ.person_id = $2
             LIMIT 1`,
            [meta.contract_id, req.user.person_id]
          );
          if (occCheck.rows.length === 0) {
            await logAccessDenied(req, 'deposit', id, 'RESIDENT accessed another resident deposit transactions');
            return res.status(403).json({ code: 'ACCESS_DENIED', message: 'Bạn không có quyền xem sổ cọc này.' });
          }
        }
      }

      const txns = await pool.query(
        `SELECT dt.*,
                p_created.full_name AS created_by_name,
                p_approved.full_name AS approved_by_name
         FROM deposit_transaction dt
         LEFT JOIN app_user au_c ON au_c.id = dt.created_by
         LEFT JOIN person p_created ON p_created.id = au_c.person_id
         LEFT JOIN app_user au_a ON au_a.id = dt.approved_by
         LEFT JOIN person p_approved ON p_approved.id = au_a.person_id
         WHERE dt.deposit_id = $1
         ORDER BY dt.created_at DESC`,
        [id]
      );
      res.json({ data: txns.rows });
    } catch (err) {
      console.error('[Deposit Transactions List Error]:', err);
      res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi khi tải lịch sử giao dịch cọc.' });
    }
  }
);

/**
 * POST /api/v1/deposits/:id/transactions
 * Thu bổ sung cọc / chuyển cọc giữ chỗ: MANAGER, SYS_ADMIN (OWNER 100% Read-Only)
 */
router.post(
  '/:id/transactions',
  authenticateToken,
  requireRole(['SYS_ADMIN', 'MANAGER']),
  async (req, res) => {
    const { id } = req.params;
    const { type, amount, description, method, evidence } = req.body;

    if (type === 'deduct' || type === 'refund') {
      return res.status(409).json({
        code: 'MUST_USE_SETTLEMENT',
        message: 'Khấu trừ/hoàn cọc chỉ thực hiện qua hồ sơ tất toán có phê duyệt (FR-024).',
      });
    }

    if (type !== 'collect' && type !== 'transfer') {
      return res.status(400).json({
        code: 'INVALID_TRANSACTION_TYPE',
        message: 'Loại giao dịch không hợp lệ. Chỉ chấp nhận collect hoặc transfer.',
      });
    }

    const numAmount = Number(amount);
    if (!amount || isNaN(numAmount) || numAmount <= 0) {
      return res.status(400).json({
        code: 'INVALID_AMOUNT',
        message: 'Số tiền giao dịch phải lớn hơn 0.',
      });
    }

    if (type === 'collect' && !method) {
      return res.status(400).json({
        code: 'METHOD_REQUIRED',
        message: 'Phương thức thanh toán là bắt buộc khi thu tiền cọc (vd: BANK_TRANSFER, CASH).',
      });
    }

    const { client, release } = await getUserClient(req);
    try {
      const depCheck = await adminPool.query(
        `SELECT d.id, c.building_id
         FROM deposit d JOIN contract c ON c.id = d.contract_id
         JOIN building b ON b.id = c.building_id
         WHERE d.id = $1 AND b.org_id = $2`,
        [id, req.user.org_id]
      );
      if (depCheck.rows.length === 0) {
        return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy sổ cọc.' });
      }
      const roleCodes = getUserRoleCodes(req);
      if (!roleCodes.includes('SYS_ADMIN')) {
        const writeIds = await getDepositWriteBuildingIds(req.user.sub, req.user.org_id, roleCodes);
        if (!writeIds.includes(depCheck.rows[0].building_id)) {
          await logAccessDenied(req, 'deposit', id, 'Operator attempted deposit transaction on unassigned building');
          return res.status(403).json({ code: 'ACCESS_DENIED', message: 'Bạn không có quyền quản lý sổ cọc của tòa nhà này.' });
        }
      }

      await client.query('BEGIN');

      const depositRes = await client.query('SELECT * FROM deposit WHERE id = $1 FOR UPDATE', [id]);
      if (depositRes.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy sổ cọc.' });
      }

      const currentDeposit = depositRes.rows[0];
      if (!['HELD', 'SETTLEMENT_DRAFT'].includes(currentDeposit.status)) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          code: 'DEPOSIT_NOT_COLLECTIBLE',
          message: `Sổ cọc đang ở trạng thái ${currentDeposit.status}, chỉ cho phép ghi nhận thu bổ sung/kết chuyển khi đang HELD hoặc SETTLEMENT_DRAFT.`,
        });
      }

      const txnAmount = BigInt(Math.round(numAmount));
      const newAmount = BigInt(currentDeposit.amount_held) + txnAmount;

      const evidenceList = Array.isArray(evidence) ? evidence.filter(Boolean) : [];
      const txnRes = await client.query(
        `INSERT INTO deposit_transaction (
           deposit_id, type, amount, description, method, evidence, status, approved_by, approved_at, created_by
         )
         VALUES ($1, $2, $3, $4, $5, $6, 'APPROVED', $7, NOW(), $7)
         RETURNING *`,
        [
          id,
          type,
          txnAmount.toString(),
          description || (type === 'collect' ? 'Thu bổ sung cọc' : 'Chuyển đổi cọc giữ chỗ'),
          method || (type === 'transfer' ? 'TRANSFER' : 'OTHER'),
          evidenceList,
          req.user.sub,
        ]
      );

      await client.query(
        `UPDATE deposit SET amount_held = $1, status = $2, updated_at = NOW() WHERE id = $3`,
        [newAmount.toString(), currentDeposit.status, id]
      );

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
  }
);

/**
 * GET /api/v1/deposits/:id/settlement
 */
router.get(
  '/:id/settlement',
  authenticateToken,
  requireRole(['SYS_ADMIN', 'OWNER', 'MANAGER', 'RESIDENT']),
  async (req, res) => {
    const { id } = req.params;
    const { client, release } = await getUserClient(req);
    try {
      const existRes = await adminPool.query(
        `SELECT d.id, d.contract_id, c.building_id, t.person_id
         FROM deposit d
         JOIN contract c ON c.id = d.contract_id
         JOIN building b ON b.id = c.building_id
         JOIN tenant t ON t.id = c.primary_tenant_id
         WHERE d.id = $1 AND b.org_id = $2`,
        [id, req.user.org_id]
      );
      if (existRes.rows.length === 0) {
        return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy sổ cọc.' });
      }
      const meta = existRes.rows[0];
      const roleCodes = getUserRoleCodes(req);

      if (!roleCodes.includes('SYS_ADMIN')) {
        if (roleCodes.some((r) => ['OWNER', 'MANAGER'].includes(r))) {
          const allowedIds = await getOperatorReadBuildingIds(req.user.sub, req.user.org_id, roleCodes);
          if (!allowedIds.includes(meta.building_id)) {
            await logAccessDenied(req, 'deposit', id, 'Operator accessed settlement outside building scope');
            return res.status(403).json({ code: 'ACCESS_DENIED', message: 'Bạn không có quyền xem hồ sơ tất toán của tòa nhà này.' });
          }
        } else if (roleCodes.includes('RESIDENT') && meta.person_id !== req.user.person_id) {
          const occCheck = await adminPool.query(
            `SELECT 1 FROM contract_occupant co
             JOIN tenant t_occ ON t_occ.id = co.tenant_id
             WHERE co.contract_id = $1 AND t_occ.person_id = $2
             LIMIT 1`,
            [meta.contract_id, req.user.person_id]
          );
          if (occCheck.rows.length === 0) {
            await logAccessDenied(req, 'deposit', id, 'RESIDENT accessed another resident settlement');
            return res.status(403).json({ code: 'ACCESS_DENIED', message: 'Bạn không có quyền xem sổ cọc này.' });
          }
        }
      }

      const q = await adminPool.query(
        `SELECT d.id, d.contract_id, d.amount_held, d.status, d.settlement, d.refund_due_date,
                c.deposit_amount, c.status as contract_status, c.building_id, c.apartment_id,
                c.start_date, c.end_date, c.terminated_at,
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
      const debts = await calculateContractOpenDebts(adminPool, row.contract_id);
      const preconditions = await checkSettlementPreconditions(adminPool, row);

      // Khi sổ cọc đã tất toán (PARTIALLY_REFUNDED / REFUNDED), ưu tiên số liệu đã chốt trong settlement
      const isSettled = ['PARTIALLY_REFUNDED', 'REFUNDED'].includes(row.status);
      const effectiveServiceDebt = isSettled && row.settlement
        ? Number(row.settlement.outstanding_debt || 0)
        : debts.serviceDebt;
      const effectiveRentDebt = isSettled && row.settlement?.rent_debt !== undefined
        ? Number(row.settlement.rent_debt || 0)
        : debts.rentDebt;

      res.json({
        data: {
          deposit_id: row.id,
          contract_id: row.contract_id,
          deposit_amount: row.deposit_amount,
          amount_held: row.amount_held,
          status: row.status,
          contract_status: row.contract_status,
          terminated_at: row.terminated_at,
          settlement: row.settlement,
          refund_due_date: row.refund_due_date,
          apartment_code: row.apartment_code,
          building_name: row.building_name,
          tenant_name: row.tenant_name,
          calculated_service_debt: effectiveServiceDebt,
          calculated_rent_debt: effectiveRentDebt,
          preconditions,
        },
      });
    } catch (err) {
      console.error('[Get Settlement Error]:', err);
      res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi khi tải hồ sơ tất toán.' });
    } finally {
      await release();
    }
  }
);

/**
 * GET /api/v1/deposits/:id/settlement/pdf
 * Xuất biên bản tất toán tiền cọc định dạng HTML chuẩn A4 có thể in/lưu PDF (R-24)
 */
router.get(
  '/:id/settlement/pdf',
  authenticateToken,
  requireRole(['SYS_ADMIN', 'OWNER', 'MANAGER', 'RESIDENT']),
  async (req, res) => {
    const { id } = req.params;
    try {
      const q = await adminPool.query(
        `SELECT d.*,
                c.deposit_amount, c.rent_amount, c.start_date, c.end_date, c.terminated_at,
                c.status AS contract_status, c.building_id,
                a.code AS apartment_code,
                b.name AS building_name, b.address AS building_address, b.org_id,
                o.name AS org_name,
                t.person_id,
                p.full_name AS tenant_name, p.phone AS tenant_phone, p.id_number AS tenant_id_number
         FROM deposit d
         JOIN contract c ON c.id = d.contract_id
         JOIN apartment a ON a.id = c.apartment_id
         JOIN building b ON b.id = c.building_id
         JOIN organization o ON o.id = b.org_id
         JOIN tenant t ON t.id = c.primary_tenant_id
         JOIN person p ON p.id = t.person_id
         WHERE d.id = $1 AND b.org_id = $2`,
        [id, req.user.org_id]
      );
      if (q.rows.length === 0) {
        return res.status(404).send('<h1>404 Không tìm thấy sổ cọc</h1>');
      }
      const row = q.rows[0];
      const roleCodes = getUserRoleCodes(req);

      if (!roleCodes.includes('SYS_ADMIN')) {
        if (roleCodes.some((r) => ['OWNER', 'MANAGER'].includes(r))) {
          const allowedIds = await getOperatorReadBuildingIds(req.user.sub, req.user.org_id, roleCodes);
          if (!allowedIds.includes(row.building_id)) {
            await logAccessDenied(req, 'deposit', id, 'Operator accessed settlement PDF outside building scope');
            return res.status(403).send('<h1>403 Bạn không có quyền truy cập biên bản tất toán này</h1>');
          }
        } else if (roleCodes.includes('RESIDENT') && row.person_id !== req.user.person_id) {
          const occCheck = await adminPool.query(
            `SELECT 1 FROM contract_occupant co
             JOIN tenant t_occ ON t_occ.id = co.tenant_id
             WHERE co.contract_id = $1 AND t_occ.person_id = $2
             LIMIT 1`,
            [row.contract_id, req.user.person_id]
          );
          if (occCheck.rows.length === 0) {
            await logAccessDenied(req, 'deposit', id, 'RESIDENT accessed another resident settlement PDF');
            return res.status(403).send('<h1>403 Bạn không có quyền truy cập biên bản tất toán này</h1>');
          }
        }
      }

      const settlement = row.settlement || {};
      const items = Array.isArray(settlement.items) ? settlement.items : [];
      const fmtMoney = (v) => `${Number(v || 0).toLocaleString('vi-VN')} ₫`;
      const fmtDate = (d) => {
        if (!d) return '—';
        const dt = new Date(d);
        if (isNaN(dt.getTime())) return String(d);
        return `${String(dt.getDate()).padStart(2, '0')}/${String(dt.getMonth() + 1).padStart(2, '0')}/${dt.getFullYear()}`;
      };

      const heldForCalc = ['PARTIALLY_REFUNDED', 'REFUNDED'].includes(row.status)
        ? Number(settlement.deposit_held_before_settlement ?? row.deposit_amount ?? 0)
        : Number(row.amount_held || 0);
      const serviceDebt = Number(settlement.outstanding_debt || 0);
      const rentDebt = Number(settlement.rent_debt || 0);
      const sumItems = items.reduce((s, it) => s + Number(it.amount || 0), 0);
      const refundAmount = Number(settlement.refund_amount ?? Math.max(0, heldForCalc - serviceDebt - sumItems));
      const shortfall = Number(settlement.shortfall ?? Math.max(0, serviceDebt + sumItems - heldForCalc));

      const categoryLabel = {
        DAMAGE: 'Hư hỏng tài sản',
        CLEANING: 'Phí vệ sinh bàn giao',
        UTILITY_DEBT: 'Công nợ tiện ích',
        OTHER: 'Khác',
      };

      const itemRowsHtml = items.length > 0
        ? items
            .map(
              (it, idx) => `
          <tr>
            <td style="text-align:center;">${idx + 1}</td>
            <td>${escapeHtml(categoryLabel[it.category] || it.category)}</td>
            <td>${escapeHtml(it.description)}</td>
            <td style="text-align:right; font-weight:600;">${fmtMoney(it.amount)}</td>
          </tr>`
            )
            .join('')
        : `<tr><td colspan="4" style="text-align:center; color:#64748b; font-style:italic;">Không phát sinh khấu trừ hư hỏng / vệ sinh bàn giao.</td></tr>`;

      const html = `<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8" />
  <title>Biên bản tất toán tiền cọc - ${escapeHtml(row.apartment_code)}</title>
  <style>
    @page { size: A4; margin: 18mm 15mm; }
    * { box-sizing: border-box; }
    body { font-family: 'Times New Roman', serif; font-size: 12.5pt; line-height: 1.5; color: #0f172a; margin: 0; background: #f1f5f9; }
    .toolbar { position: sticky; top: 0; background: #0f172a; color: #fff; padding: 10px 24px; display: flex; justify-content: space-between; align-items: center; z-index: 999; }
    .btn-print { background: #4f46e5; color: #fff; border: none; padding: 8px 16px; border-radius: 8px; font-weight: 600; cursor: pointer; }
    .sheet { max-width: 210mm; min-height: 297mm; margin: 20px auto; background: #fff; padding: 18mm; box-shadow: 0 4px 20px rgba(0,0,0,0.08); }
    .header { text-align: center; margin-bottom: 20px; }
    .title { font-size: 16pt; font-weight: bold; text-transform: uppercase; margin: 12px 0 4px; }
    h3 { font-size: 12.5pt; text-transform: uppercase; border-bottom: 1px solid #cbd5e1; padding-bottom: 4px; margin-top: 18px; }
    table { width: 100%; border-collapse: collapse; margin: 10px 0; font-size: 12pt; }
    th, td { border: 1px solid #334155; padding: 6px 10px; }
    th { background: #f8fafc; text-align: left; }
    .summary-row td { font-weight: bold; }
    .signatures { display: flex; justify-content: space-between; margin-top: 36px; page-break-inside: avoid; }
    .sig-box { width: 45%; text-align: center; }
    .sig-space { height: 80px; }
    @media print {
      body { background: #fff; }
      .toolbar { display: none !important; }
      .sheet { box-shadow: none; margin: 0; padding: 0; max-width: none; }
    }
  </style>
</head>
<body>
  <div class="toolbar">
    <div>Biên bản tất toán tiền cọc — Căn <strong>${escapeHtml(row.apartment_code)}</strong> (${escapeHtml(row.building_name)})</div>
    <button class="btn-print" onclick="window.print()">In / Lưu PDF (Ctrl + P)</button>
  </div>
  <div class="sheet">
    <div class="header">
      <div style="font-weight:bold;">CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM</div>
      <div style="font-weight:bold;">Độc lập – Tự do – Hạnh phúc</div>
      <div class="title">BIÊN BẢN TẤT TOÁN &amp; ĐỐI CHIẾU TIỀN ĐẶT CỌC</div>
      <div style="font-size:11pt; color:#475569;">Mã sổ cọc: ${escapeHtml(row.id.slice(0, 8).toUpperCase())} — Trạng thái: ${escapeHtml(row.status)}</div>
    </div>

    <h3>I. Thông tin hợp đồng &amp; các bên</h3>
    <p><strong>Đơn vị quản lý:</strong> ${escapeHtml(row.org_name)} — Tòa nhà: <strong>${escapeHtml(row.building_name)}</strong> (${escapeHtml(row.building_address)})</p>
    <p><strong>Căn hộ:</strong> ${escapeHtml(row.apartment_code)} | <strong>Thời hạn HĐ:</strong> ${fmtDate(row.start_date)} – ${fmtDate(row.end_date)} | <strong>Ngày kết thúc thực tế:</strong> ${fmtDate(row.terminated_at || row.end_date)}</p>
    <p><strong>Khách thuê đại diện:</strong> ${escapeHtml(row.tenant_name)} | <strong>SĐT:</strong> ${escapeHtml(row.tenant_phone)} | <strong>CCCD/HC:</strong> ${escapeHtml(row.tenant_id_number || '—')}</p>

    <h3>II. Chi tiết khấu trừ biên bản bàn giao</h3>
    <table>
      <thead>
        <tr>
          <th style="width:45px; text-align:center;">STT</th>
          <th style="width:170px;">Danh mục</th>
          <th>Nội dung / Hiện trạng nghiệm thu</th>
          <th style="width:140px; text-align:right;">Số tiền</th>
        </tr>
      </thead>
      <tbody>
        ${itemRowsHtml}
      </tbody>
    </table>

    <h3>III. Tổng hợp đối trừ &amp; kết quả tất toán</h3>
    <table>
      <tbody>
        <tr>
          <td>1. Tiền đặt cọc bảo lưu thực tế</td>
          <td style="width:160px; text-align:right; font-weight:bold;">${fmtMoney(heldForCalc)}</td>
        </tr>
        <tr>
          <td>2. Tổng khấu trừ hư hỏng / vệ sinh bàn giao</td>
          <td style="text-align:right;">${fmtMoney(sumItems)}</td>
        </tr>
        <tr>
          <td>3. Công nợ dịch vụ / điện / nước tồn đọng (đối trừ vào cọc)</td>
          <td style="text-align:right;">${fmtMoney(serviceDebt)}</td>
        </tr>
        <tr>
          <td>4. Công nợ tiền thuê phòng tồn đọng <em>(KHÔNG trừ vào tiền cọc — thanh toán riêng)</em></td>
          <td style="text-align:right;">${fmtMoney(rentDebt)}</td>
        </tr>
        <tr class="summary-row" style="background:#ecfdf5;">
          <td>5. SỐ TIỀN HOÀN TRẢ CHO KHÁCH THUÊ (1 − 2 − 3)</td>
          <td style="text-align:right; color:#047857;">${fmtMoney(refundAmount)}</td>
        </tr>
        ${
          shortfall > 0
            ? `<tr class="summary-row" style="background:#fff1f2;">
          <td>6. Công nợ vượt cọc cần thu thêm sau trả phòng</td>
          <td style="text-align:right; color:#be123c;">${fmtMoney(shortfall)}</td>
        </tr>`
            : ''
        }
      </tbody>
    </table>

    <p><strong>Phương thức hoàn trả:</strong> ${escapeHtml(settlement.refund_method || 'BANK_TRANSFER')} ${
      settlement.bank_info?.bank_name
        ? `— Ngân hàng: ${escapeHtml(settlement.bank_info.bank_name)} | STK: ${escapeHtml(settlement.bank_info.account_number || settlement.bank_info.account_no || '')} | Chủ TK: ${escapeHtml(settlement.bank_info.account_holder || '')}`
        : ''
    }</p>
    <p><strong>Hạn hoàn cọc theo quy định:</strong> ${fmtDate(row.refund_due_date)}</p>

    <div class="signatures">
      <div class="sig-box">
        <strong>ĐẠI DIỆN BAN QUẢN LÝ</strong><br />
        <em>(Ký và ghi rõ họ tên)</em>
        <div class="sig-space"></div>
      </div>
      <div class="sig-box">
        <strong>KHÁCH THUÊ XÁC NHẬN</strong><br />
        <em>(Ký và ghi rõ họ tên)</em>
        <div class="sig-space"></div>
        <div><strong>${escapeHtml(row.tenant_name)}</strong></div>
      </div>
    </div>
  </div>
</body>
</html>`;

      res.set('Content-Type', 'text/html; charset=utf-8');
      res.send(html);
    } catch (err) {
      console.error('[Settlement PDF Error]:', err);
      res.status(500).send('<h1>500 Lỗi máy chủ khi xuất biên bản tất toán</h1>');
    }
  }
);

/**
 * POST /api/v1/deposits/:id/settlement
 * Lập hồ sơ tất toán cọc (FR-024, R-06):
 * MANAGER / SYS_ADMIN lập hồ sơ -> SYS_ADMIN hoặc MANAGER khác phê duyệt nội bộ (Four-eyes).
 * OWNER 100% Read-Only.
 * Công nợ dịch vụ/điện nước được tự động tổng hợp từ CSDL; công nợ tiền thuê KHÔNG trừ vào cọc.
 */
router.post(
  '/:id/settlement',
  authenticateToken,
  requireRole(['SYS_ADMIN', 'MANAGER']),
  async (req, res) => {
    const { id } = req.params;
    const { items = [], refund_method = 'BANK_TRANSFER', bank_info = {} } = req.body;

    const { client, release } = await getUserClient(req);
    try {
      const depCheck = await adminPool.query(
        `SELECT d.id, c.building_id
         FROM deposit d JOIN contract c ON c.id = d.contract_id
         JOIN building b ON b.id = c.building_id
         WHERE d.id = $1 AND b.org_id = $2`,
        [id, req.user.org_id]
      );
      if (depCheck.rows.length === 0) {
        return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy sổ cọc.' });
      }
      const roleCodes = getUserRoleCodes(req);
      if (!roleCodes.includes('SYS_ADMIN')) {
        const writeIds = await getDepositWriteBuildingIds(req.user.sub, req.user.org_id, roleCodes);
        if (!writeIds.includes(depCheck.rows[0].building_id)) {
          await logAccessDenied(req, 'deposit', id, 'Operator attempted settlement submit on unassigned building');
          return res.status(403).json({ code: 'ACCESS_DENIED', message: 'Bạn không có quyền lập tất toán cho tòa nhà này.' });
        }
      }

      await client.query('BEGIN');

      const depRes = await client.query(
        `SELECT d.*, c.status as contract_status, c.building_id, c.apartment_id,
                c.start_date, c.end_date, c.terminated_at
         FROM deposit d
         JOIN contract c ON c.id = d.contract_id
         WHERE d.id = $1 FOR UPDATE OF d`,
        [id]
      );

      if (depRes.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy sổ cọc.' });
      }

      const dep = depRes.rows[0];

      if (!['HELD', 'SETTLEMENT_DRAFT'].includes(dep.status)) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          code: 'DEPOSIT_NOT_HELD',
          message: 'Chỉ có thể lập hồ sơ tất toán cho khoản cọc đang giữ (HELD) hoặc bản nháp tất toán (SETTLEMENT_DRAFT).',
        });
      }

      const preconditions = await checkSettlementPreconditions(client, dep);
      if (!preconditions.contract_ended) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          code: 'CONTRACT_NOT_TERMINATED_OR_EXPIRED',
          message: 'Hợp đồng phải ở trạng thái TERMINATED hoặc EXPIRED mới được mở hồ sơ tất toán.',
        });
      }
      if (!preconditions.final_meters_recorded) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          code: 'MISSING_FINAL_METER_READING',
          message: `Chưa ghi đủ chỉ số công tơ kỳ cuối (${preconditions.missing_meter_types.join(', ')}) cho căn hộ trước khi lập tất toán cọc.`,
          missing_meter_types: preconditions.missing_meter_types,
        });
      }
      if (!preconditions.no_draft_invoices) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          code: 'UNPUBLISHED_INVOICE',
          message: 'Hợp đồng đang còn hóa đơn bản nháp (DRAFT) chưa phát hành hoặc chưa hủy. Vui lòng xử lý dứt điểm trước khi tất toán cọc.',
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

      const { serviceDebt, rentDebt } = await calculateContractOpenDebts(client, dep.contract_id);

      const { refund, shortfall } = computeRefund({
        depositAmount: dep.amount_held,
        outstandingDebt: serviceDebt,
        items,
      });

      const prevSettlement = dep.settlement || {};
      const settlementPayload = {
        items,
        outstanding_debt: serviceDebt,
        service_debt: serviceDebt,
        rent_debt: rentDebt,
        deposit_held_before_settlement: Number(dep.amount_held),
        refund_amount: Number(refund),
        shortfall: Number(shortfall),
        refund_method,
        bank_info,
        created_by: req.user.sub,
        created_at: new Date().toISOString(),
        dispute_thread: Array.isArray(prevSettlement.dispute_thread) ? prevSettlement.dispute_thread : [],
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
        message: 'Đã gửi hồ sơ tất toán cọc, chờ phê duyệt nội bộ (Quản lý / SYS_ADMIN).',
        data: { settlement: settlementPayload, status: 'PENDING_APPROVAL' },
      });
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('[Settlement Submit Error]:', err);
      res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi khi lập hồ sơ tất toán.' });
    } finally {
      await release();
    }
  }
);

/**
 * POST /api/v1/deposits/:id/settlement/approve
 * Phê duyệt nội bộ Four-eyes bởi SYS_ADMIN hoặc MANAGER (kiểm tra allow_self_approval — R-23).
 * Đối trừ tự động công nợ dịch vụ vào hóa đơn mở, giữ riêng công nợ tiền thuê (R-06).
 */
router.post(
  '/:id/settlement/approve',
  authenticateToken,
  requireRole(['SYS_ADMIN', 'MANAGER']),
  async (req, res) => {
    const { id } = req.params;
    const { client, release } = await getUserClient(req);
    try {
      const depCheck = await adminPool.query(
        `SELECT d.id, c.building_id
         FROM deposit d JOIN contract c ON c.id = d.contract_id
         JOIN building b ON b.id = c.building_id
         WHERE d.id = $1 AND b.org_id = $2`,
        [id, req.user.org_id]
      );
      if (depCheck.rows.length === 0) {
        return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy sổ cọc.' });
      }
      const roleCodes = getUserRoleCodes(req);
      if (!roleCodes.includes('SYS_ADMIN')) {
        const mgrIds = await getManagerBuildingIds(req.user.sub, req.user.org_id);
        if (!mgrIds.includes(depCheck.rows[0].building_id)) {
          await logAccessDenied(req, 'deposit', id, 'MANAGER attempted settlement approve on unassigned building');
          return res.status(403).json({ code: 'ACCESS_DENIED', message: 'Bạn không quản lý tòa nhà của sổ cọc này.' });
        }
      }

      await client.query('BEGIN');

      const depRes = await client.query(
        `SELECT d.*, c.primary_tenant_id, c.building_id
         FROM deposit d
         JOIN contract c ON c.id = d.contract_id
         WHERE d.id = $1 FOR UPDATE OF d`,
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
          message: 'Hồ sơ tất toán đang trong tình trạng tranh chấp, không thể phê duyệt (FR-024).',
        });
      }

      if (dep.status !== 'PENDING_APPROVAL') {
        await client.query('ROLLBACK');
        return res.status(409).json({
          code: 'NOT_PENDING_APPROVAL',
          message: 'Chỉ có thể phê duyệt hồ sơ tất toán đang chờ duyệt (PENDING_APPROVAL).',
        });
      }

      const settlement = dep.settlement;
      if (!settlement) {
        await client.query('ROLLBACK');
        return res.status(400).json({ code: 'NO_SETTLEMENT_DATA', message: 'Không có dữ liệu tất toán.' });
      }

      if (settlement.created_by && String(settlement.created_by) === String(req.user.sub)) {
        const fourEyes = await checkFourEyesOrWarn({
          orgId: req.user.org_id,
          actorId: req.user.sub,
          creatorId: settlement.created_by,
          entity: 'deposit',
          entityId: id,
          actionContext: 'SETTLEMENT_APPROVE',
        });
        if (!fourEyes.allowed) {
          await client.query('ROLLBACK');
          return res.status(403).json({
            code: 'SELF_APPROVAL',
            message: 'Nguyên tắc Four-eyes: Người tạo hồ sơ tất toán không được tự duyệt.',
          });
        }
      }

      const heldBefore = Math.max(0, Number(dep.amount_held || 0));
      const items = Array.isArray(settlement.items) ? settlement.items : [];
      const sumItems = items.reduce((s, it) => s + Math.max(0, Number(it.amount || 0)), 0);

      // Tính lại công nợ thực tế ngay tại thời điểm duyệt để đối trừ chuẩn xác vào hóa đơn đang mở
      const liveDebts = await calculateContractOpenDebts(client, dep.contract_id);
      const serviceDebt = liveDebts.serviceDebt;
      const rentDebt = liveDebts.rentDebt;

      const { refund: recomputedRefund, shortfall: recomputedShortfall } = computeRefund({
        depositAmount: heldBefore,
        outstandingDebt: serviceDebt,
        items,
      });
      const refundAmount = Number(recomputedRefund);
      const shortfallAmount = Number(recomputedShortfall);

      // 1. Ghi nhận khấu trừ hư hỏng / vệ sinh bàn giao
      for (const item of items) {
        await client.query(
          `INSERT INTO deposit_transaction (
             deposit_id, type, amount, category, description, evidence, status, method, approved_by, approved_at, created_by
           )
           VALUES ($1, 'deduct', $2, $3, $4, $5, 'APPROVED', $6, $7, NOW(), $8)`,
          [
            id,
            Math.round(Number(item.amount)),
            item.category,
            item.description,
            item.evidence || [],
            item.method || 'OTHER',
            req.user.sub,
            settlement.created_by || req.user.sub,
          ]
        );
      }

      // 2. Đối trừ tự động công nợ dịch vụ / điện / nước từ phần tiền cọc còn lại (KHÔNG đụng vào nợ tiền thuê)
      const depositAfterItems = Math.max(0, heldBefore - sumItems);
      const coveredServiceDebt = Math.min(serviceDebt, depositAfterItems);

      if (coveredServiceDebt > 0) {
        await client.query(
          `INSERT INTO deposit_transaction (
             deposit_id, type, amount, category, description, evidence, status, method, approved_by, approved_at, created_by
           )
           VALUES ($1, 'deduct', $2, 'UTILITY_DEBT', $3, $4, 'APPROVED', 'TRANSFER', $5, NOW(), $6)`,
          [
            id,
            Math.round(coveredServiceDebt),
            'Đối trừ tự động công nợ dịch vụ/điện nước từ tiền đặt cọc (R-06)',
            [],
            req.user.sub,
            settlement.created_by || req.user.sub,
          ]
        );
      }

      // Gạch nợ phần dịch vụ được cọc chi trả trên các hóa đơn mở, và chuyển các khoản nợ hóa đơn còn lại (gồm nợ RENT hoặc phần dịch vụ vượt cọc) sang RECEIVABLE_AFTER_MOVE_OUT
      let remainingCover = coveredServiceDebt;
      for (const inv of liveDebts.openInvoices) {
        let applyAmt = 0;
        if (remainingCover > 0 && inv.service_unpaid > 0) {
          applyAmt = Math.min(remainingCover, inv.service_unpaid);
          remainingCover -= applyAmt;
        }
        const newPaid = inv.paid_amount + applyAmt;
        const newStatus = newPaid >= inv.total_amount ? 'PAID' : applyAmt > 0 || inv.paid_amount > 0 ? 'PARTIALLY_PAID' : undefined;

        if (applyAmt > 0) {
          await client.query(
            `UPDATE invoice
             SET paid_amount = $1,
                 status = $2,
                 updated_at = NOW()
             WHERE id = $3`,
            [newPaid, newStatus, inv.id]
          );
        }

        const stillUnpaid = Math.max(0, inv.total_amount - newPaid);
        if (stillUnpaid === 0) {
          await client.query(
            `UPDATE receivable
             SET paid_amount = amount,
                 status = 'PAID',
                 deposit_id = COALESCE(deposit_id, $1),
                 updated_at = NOW()
             WHERE invoice_id = $2 AND status IN ('OPEN', 'PARTIALLY_PAID')`,
            [id, inv.id]
          );
        } else {
          const recUpd = await client.query(
            `UPDATE receivable
             SET paid_amount = LEAST(amount, $1),
                 status = CASE WHEN $1 > 0 THEN 'PARTIALLY_PAID' ELSE 'OPEN' END,
                 type = 'RECEIVABLE_AFTER_MOVE_OUT',
                 deposit_id = COALESCE(deposit_id, $2),
                 updated_at = NOW()
             WHERE invoice_id = $3 AND status IN ('OPEN', 'PARTIALLY_PAID')
             RETURNING id`,
            [newPaid, id, inv.id]
          );
          if (recUpd.rows.length === 0) {
            await client.query(
              `INSERT INTO receivable (
                 org_id, building_id, contract_id, tenant_id, invoice_id, deposit_id,
                 type, amount, paid_amount, due_date, status, description
               )
               VALUES ($1, $2, $3, $4, $5, $6, 'RECEIVABLE_AFTER_MOVE_OUT', $7, $8, CURRENT_DATE + INTERVAL '7 days', $9, $10)`,
              [
                req.user.org_id,
                dep.building_id,
                dep.contract_id,
                dep.primary_tenant_id,
                inv.id,
                id,
                inv.total_amount,
                newPaid,
                newPaid > 0 ? 'PARTIALLY_PAID' : 'OPEN',
                `Công nợ hóa đơn ${inv.invoice_code} còn tồn đọng sau trả phòng (gồm tiền thuê không cấn trừ cọc / dịch vụ vượt cọc)`,
              ]
            );
          }
        }
      }

      // 3. Ghi nhận hoàn trả tiền cọc còn dư
      if (refundAmount > 0) {
        await client.query(
          `INSERT INTO deposit_transaction (
             deposit_id, type, amount, description, status, method, approved_by, approved_at, created_by
           )
           VALUES ($1, 'refund', $2, $3, 'APPROVED', $4, $5, NOW(), $6)`,
          [
            id,
            refundAmount,
            'Hoàn trả tiền cọc sau tất toán',
            settlement.refund_method || 'BANK_TRANSFER',
            req.user.sub,
            settlement.created_by || req.user.sub,
          ]
        );
      }

      // 4. Khi riêng các khoản khấu trừ hư hỏng/vệ sinh đã vượt tiền cọc (uncoveredItemsShortfall > 0), sinh công nợ sau trả phòng không trùng lặp với hóa đơn
      const uncoveredItemsShortfall = Math.max(0, sumItems - heldBefore);
      if (uncoveredItemsShortfall > 0) {
        await client.query(
          `INSERT INTO receivable (
             org_id, building_id, contract_id, tenant_id, deposit_id, type, amount, due_date, status, description
           )
           VALUES ($1, $2, $3, $4, $5, 'RECEIVABLE_AFTER_MOVE_OUT', $6, CURRENT_DATE + INTERVAL '7 days', 'OPEN', $7)`,
          [
            req.user.org_id,
            dep.building_id,
            dep.contract_id,
            dep.primary_tenant_id,
            id,
            Math.round(uncoveredItemsShortfall),
            'Công nợ phát sinh sau tất toán tiền cọc vượt mức cọc đang giữ (FR-024)',
          ]
        );
      }

      const finalStatus = resolvePostSettlementStatus({
        refundAmount,
        outstandingDebt: serviceDebt,
        items,
        shortfall: shortfallAmount,
      });

      const finalizedSettlement = {
        ...settlement,
        outstanding_debt: serviceDebt,
        service_debt: serviceDebt,
        rent_debt: rentDebt,
        deposit_held_before_settlement: heldBefore,
        covered_service_debt: coveredServiceDebt,
        refund_amount: refundAmount,
        shortfall: shortfallAmount,
        approved_by: req.user.sub,
        approved_at: new Date().toISOString(),
      };

      await client.query(
        `UPDATE deposit SET amount_held = 0, status = $1, settlement = $2, updated_at = NOW() WHERE id = $3`,
        [finalStatus, JSON.stringify(finalizedSettlement), id]
      );

      await client.query(
        `INSERT INTO audit_log (actor_id, action, entity, entity_id, after)
         VALUES ($1, 'SETTLEMENT_APPROVE', 'deposit', $2, $3)`,
        [req.user.sub, id, JSON.stringify({ ...finalizedSettlement, final_status: finalStatus })]
      );

      try {
        const uRes = await adminPool.query(
          `SELECT u.id as user_id 
           FROM tenant t
           JOIN app_user u ON u.person_id = t.person_id
           WHERE t.id = $1`,
          [dep.primary_tenant_id]
        );
        if (uRes.rows.length > 0) {
          await adminPool.query(
            `INSERT INTO notification (org_id, user_id, title, content, type, payload)
             VALUES ($1, $2, 'Hồ sơ tất toán cọc đã được phê duyệt', 'Ban Quản Lý đã phê duyệt tất toán cọc cho hợp đồng của bạn.', 'SETTLEMENT_APPROVED', $3)`,
            [req.user.org_id, uRes.rows[0].user_id, JSON.stringify({ deposit_id: id, settlement: finalizedSettlement, status: finalStatus })]
          );
        }
      } catch (nErr) {
        console.warn('[Notification settlement approve warning]:', nErr.message);
      }

      await client.query('COMMIT');
      res.json({ message: 'Phê duyệt hồ sơ tất toán thành công.', data: { id, status: finalStatus, settlement: finalizedSettlement } });
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('[Settlement Approve Error]:', err);
      res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi khi phê duyệt hồ sơ tất toán.' });
    } finally {
      await release();
    }
  }
);

/**
 * POST /api/v1/deposits/:id/settlement/reject
 * Từ chối hồ sơ tất toán (Four-eyes bởi SYS_ADMIN hoặc MANAGER). OWNER 100% Read-Only.
 */
router.post(
  '/:id/settlement/reject',
  authenticateToken,
  requireRole(['SYS_ADMIN', 'MANAGER']),
  async (req, res) => {
    const { id } = req.params;
    const { reason } = req.body;

    if (!reason || !reason.trim()) {
      return res.status(400).json({ code: 'REASON_REQUIRED', message: 'Vui lòng cung cấp lý do từ chối hồ sơ tất toán.' });
    }

    const { client, release } = await getUserClient(req);
    try {
      const depCheck = await adminPool.query(
        `SELECT d.id, c.building_id
         FROM deposit d JOIN contract c ON c.id = d.contract_id
         JOIN building b ON b.id = c.building_id
         WHERE d.id = $1 AND b.org_id = $2`,
        [id, req.user.org_id]
      );
      if (depCheck.rows.length === 0) {
        return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy sổ cọc.' });
      }
      const roleCodes = getUserRoleCodes(req);
      if (!roleCodes.includes('SYS_ADMIN')) {
        const mgrIds = await getManagerBuildingIds(req.user.sub, req.user.org_id);
        if (!mgrIds.includes(depCheck.rows[0].building_id)) {
          await logAccessDenied(req, 'deposit', id, 'MANAGER attempted settlement reject on unassigned building');
          return res.status(403).json({ code: 'ACCESS_DENIED', message: 'Bạn không quản lý tòa nhà của sổ cọc này.' });
        }
      }

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

      if (dep.settlement?.created_by && String(dep.settlement.created_by) === String(req.user.sub)) {
        const fourEyes = await checkFourEyesOrWarn({
          orgId: req.user.org_id,
          actorId: req.user.sub,
          creatorId: dep.settlement.created_by,
          entity: 'deposit',
          entityId: id,
          actionContext: 'SETTLEMENT_REJECT',
        });
        if (!fourEyes.allowed) {
          await client.query('ROLLBACK');
          return res.status(403).json({
            code: 'SELF_APPROVAL',
            message: 'Nguyên tắc Four-eyes: Người tạo hồ sơ tất toán không được tự phê duyệt/từ chối.',
          });
        }
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
        `INSERT INTO audit_log (actor_id, action, entity, entity_id, after)
         VALUES ($1, 'SETTLEMENT_REJECT', 'deposit', $2, $3)`,
        [req.user.sub, id, JSON.stringify(updatedSettlement)]
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
  }
);

/**
 * POST /api/v1/deposits/:id/dispute
 * Khiếu nại / ghi nhận tranh chấp bảng kê tất toán cọc (R-07):
 * Mở cho SYS_ADMIN, MANAGER (tòa nhà) và RESIDENT (chính chủ hợp đồng).
 * Hỗ trợ từ PENDING_APPROVAL, PARTIALLY_REFUNDED hoặc REFUNDED.
 */
router.post(
  '/:id/dispute',
  authenticateToken,
  requireRole(['SYS_ADMIN', 'MANAGER', 'RESIDENT']),
  async (req, res) => {
    const { id } = req.params;
    const { reason } = req.body;

    if (!reason || !String(reason).trim()) {
      return res.status(400).json({ code: 'REASON_REQUIRED', message: 'Vui lòng cung cấp lý do tranh chấp / khiếu nại.' });
    }

    const adminClient = await adminPool.connect();
    try {
      const depCheck = await adminClient.query(
        `SELECT d.id, d.contract_id, c.building_id, t.person_id, a.code AS apartment_code
         FROM deposit d
         JOIN contract c ON c.id = d.contract_id
         JOIN apartment a ON a.id = c.apartment_id
         JOIN building b ON b.id = c.building_id
         JOIN tenant t ON t.id = c.primary_tenant_id
         WHERE d.id = $1 AND b.org_id = $2`,
        [id, req.user.org_id]
      );
      if (depCheck.rows.length === 0) {
        return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy sổ cọc.' });
      }
      const meta = depCheck.rows[0];
      const roleCodes = getUserRoleCodes(req);

      let actorRole = 'SYS_ADMIN';
      if (roleCodes.includes('SYS_ADMIN')) {
        actorRole = 'SYS_ADMIN';
      } else if (roleCodes.includes('MANAGER')) {
        actorRole = 'MANAGER';
        const mgrIds = await getManagerBuildingIds(req.user.sub, req.user.org_id);
        if (!mgrIds.includes(meta.building_id)) {
          await logAccessDenied(req, 'deposit', id, 'MANAGER attempted dispute on unassigned building');
          return res.status(403).json({ code: 'ACCESS_DENIED', message: 'Bạn không có quyền quản lý sổ cọc của tòa nhà này.' });
        }
      } else if (roleCodes.includes('RESIDENT')) {
        actorRole = 'RESIDENT';
        if (meta.person_id !== req.user.person_id) {
          await logAccessDenied(req, 'deposit', id, 'RESIDENT attempted dispute on another resident deposit');
          return res.status(403).json({ code: 'ACCESS_DENIED', message: 'Chỉ cư dân đại diện hợp đồng mới được gửi khiếu nại tất toán cọc.' });
        }
      }

      await adminClient.query('BEGIN');

      const depRes = await adminClient.query('SELECT * FROM deposit WHERE id = $1 FOR UPDATE', [id]);
      if (depRes.rows.length === 0) {
        await adminClient.query('ROLLBACK');
        return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy sổ cọc.' });
      }

      const dep = depRes.rows[0];
      if (!['PENDING_APPROVAL', 'PARTIALLY_REFUNDED', 'REFUNDED'].includes(dep.status)) {
        await adminClient.query('ROLLBACK');
        return res.status(409).json({
          code: 'INVALID_STATUS',
          message: `Chỉ có thể gửi khiếu nại cho hồ sơ đang chờ duyệt hoặc vừa tất toán (hiện tại: ${dep.status}).`,
        });
      }

      const prevSettlement = dep.settlement || {};
      const prevThread = Array.isArray(prevSettlement.dispute_thread) ? prevSettlement.dispute_thread : [];
      const trimmedReason = String(reason).trim();

      const updatedSettlement = {
        ...prevSettlement,
        previous_status_before_dispute: dep.status,
        disputed_by: req.user.sub,
        disputed_by_role: actorRole,
        disputed_at: new Date().toISOString(),
        dispute_reason: trimmedReason,
        dispute_thread: [
          ...prevThread,
          {
            type: 'DISPUTE',
            at: new Date().toISOString(),
            by: req.user.sub,
            role: actorRole,
            message: trimmedReason,
          },
        ],
      };

      await adminClient.query(
        `UPDATE deposit SET status = 'DISPUTED', settlement = $1, updated_at = NOW() WHERE id = $2`,
        [JSON.stringify(updatedSettlement), id]
      );

      await adminClient.query(
        `INSERT INTO audit_log (actor_id, action, entity, entity_id, after)
         VALUES ($1, 'SETTLEMENT_DISPUTE', 'deposit', $2, $3)`,
        [req.user.sub, id, JSON.stringify(updatedSettlement)]
      );

      // Thông báo cho các Quản lý tòa nhà khi cư dân gửi khiếu nại
      if (actorRole === 'RESIDENT') {
        try {
          const mgrRes = await adminClient.query(
            `SELECT DISTINCT ur.user_id
             FROM user_role ur
             JOIN role r ON r.id = ur.role_id
             WHERE ur.building_id = $1 AND r.code = 'MANAGER'`,
            [meta.building_id]
          );
          for (const mgr of mgrRes.rows) {
            await adminClient.query(
              `INSERT INTO notification (org_id, user_id, title, content, type, payload)
               VALUES ($1, $2, $3, $4, 'DEPOSIT_DISPUTED', $5)`,
              [
                req.user.org_id,
                mgr.user_id,
                `Khiếu nại tất toán cọc căn ${meta.apartment_code}`,
                `Cư dân đã gửi ý kiến không đồng ý với bảng kê tất toán cọc: "${trimmedReason}"`,
                JSON.stringify({ deposit_id: id, contract_id: meta.contract_id }),
              ]
            );
          }
        } catch (nErr) {
          console.warn('[Dispute notification warning]:', nErr.message);
        }
      }

      await adminClient.query('COMMIT');
      res.json({
        message: 'Đã ghi nhận khiếu nại và chuyển hồ sơ cọc sang trạng thái tranh chấp (DISPUTED).',
        data: { id, status: 'DISPUTED', settlement: updatedSettlement },
      });
    } catch (err) {
      await adminClient.query('ROLLBACK').catch(() => {});
      console.error('[Settlement Dispute Error]:', err);
      res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi khi ghi nhận tranh chấp cọc.' });
    } finally {
      adminClient.release();
    }
  }
);

/**
 * POST /api/v1/deposits/:id/resolve-dispute
 * Giải quyết tranh chấp tất toán cọc (R-07):
 * - resolution = 'ADJUST': Mở lại về SETTLEMENT_DRAFT để lập lại bảng kê (chỉ khi amount_held > 0, chưa chi hoàn cọc).
 * - resolution = 'CONFIRM': Giữ nguyên bảng kê & đóng tranh chấp (trả về PENDING_APPROVAL nếu chưa chi hoàn cọc để duyệt Four-eyes, hoặc REFUNDED/PARTIALLY_REFUNDED nếu đã chi hoàn cọc).
 */
router.post(
  '/:id/resolve-dispute',
  authenticateToken,
  requireRole(['SYS_ADMIN', 'MANAGER']),
  async (req, res) => {
    const { id } = req.params;
    const { resolution, reason } = req.body;

    if (!['ADJUST', 'CONFIRM'].includes(resolution)) {
      return res.status(400).json({
        code: 'INVALID_RESOLUTION',
        message: 'Phương án giải quyết không hợp lệ. Chỉ chấp nhận ADJUST (mở lại sửa bảng kê) hoặc CONFIRM (xác nhận giữ nguyên).',
      });
    }
    if (!reason || !String(reason).trim()) {
      return res.status(400).json({
        code: 'REASON_REQUIRED',
        message: 'Vui lòng nhập nội dung phản hồi / biên bản giải quyết khiếu nại.',
      });
    }

    const { client, release } = await getUserClient(req);
    try {
      const depCheck = await adminPool.query(
        `SELECT d.id, c.building_id, c.primary_tenant_id
         FROM deposit d JOIN contract c ON c.id = d.contract_id
         JOIN building b ON b.id = c.building_id
         WHERE d.id = $1 AND b.org_id = $2`,
        [id, req.user.org_id]
      );
      if (depCheck.rows.length === 0) {
        return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy sổ cọc.' });
      }
      const meta = depCheck.rows[0];
      const roleCodes = getUserRoleCodes(req);
      if (!roleCodes.includes('SYS_ADMIN')) {
        const mgrIds = await getManagerBuildingIds(req.user.sub, req.user.org_id);
        if (!mgrIds.includes(meta.building_id)) {
          await logAccessDenied(req, 'deposit', id, 'MANAGER attempted resolve-dispute on unassigned building');
          return res.status(403).json({ code: 'ACCESS_DENIED', message: 'Bạn không quản lý tòa nhà của sổ cọc này.' });
        }
      }

      await client.query('BEGIN');

      const depRes = await client.query('SELECT * FROM deposit WHERE id = $1 FOR UPDATE', [id]);
      if (depRes.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy sổ cọc.' });
      }

      const dep = depRes.rows[0];
      if (dep.status !== 'DISPUTED') {
        await client.query('ROLLBACK');
        return res.status(409).json({
          code: 'NOT_DISPUTED',
          message: `Chỉ có thể giải quyết tranh chấp khi sổ cọc đang ở trạng thái DISPUTED (hiện tại: ${dep.status}).`,
        });
      }

      const heldNow = Number(dep.amount_held || 0);
      if (resolution === 'ADJUST' && heldNow <= 0) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          code: 'ALREADY_PAID_OUT',
          message: 'Sổ cọc đã thực hiện hạch toán chi trả (amount_held = 0), không thể mở lại bản nháp để sửa sổ cái bất biến. Vui lòng chọn xác nhận hoặc lập phiếu thu/chi điều chỉnh riêng.',
        });
      }

      const prevSettlement = dep.settlement || {};
      const prevThread = Array.isArray(prevSettlement.dispute_thread) ? prevSettlement.dispute_thread : [];
      const trimmedReason = String(reason).trim();

      let nextStatus = 'SETTLEMENT_DRAFT';
      if (resolution === 'CONFIRM') {
        if (heldNow > 0) {
          nextStatus = 'PENDING_APPROVAL';
        } else {
          nextStatus = resolvePostSettlementStatus({
            refundAmount: prevSettlement.refund_amount,
            outstandingDebt: prevSettlement.outstanding_debt,
            items: prevSettlement.items || [],
            shortfall: prevSettlement.shortfall,
          });
        }
      }

      const updatedSettlement = {
        ...prevSettlement,
        dispute_resolved_by: req.user.sub,
        dispute_resolved_at: new Date().toISOString(),
        dispute_resolution: resolution,
        dispute_resolution_reason: trimmedReason,
        dispute_thread: [
          ...prevThread,
          {
            type: 'RESOLUTION',
            resolution,
            at: new Date().toISOString(),
            by: req.user.sub,
            role: roleCodes.includes('SYS_ADMIN') ? 'SYS_ADMIN' : 'MANAGER',
            message: trimmedReason,
          },
        ],
      };

      await client.query(
        `UPDATE deposit SET status = $1, settlement = $2, updated_at = NOW() WHERE id = $3`,
        [nextStatus, JSON.stringify(updatedSettlement), id]
      );

      await client.query(
        `INSERT INTO audit_log (actor_id, action, entity, entity_id, after)
         VALUES ($1, 'SETTLEMENT_RESOLVE_DISPUTE', 'deposit', $2, $3)`,
        [req.user.sub, id, JSON.stringify({ resolution, next_status: nextStatus, reason: trimmedReason })]
      );

      try {
        const uRes = await adminPool.query(
          `SELECT u.id as user_id FROM tenant t JOIN app_user u ON u.person_id = t.person_id WHERE t.id = $1`,
          [meta.primary_tenant_id]
        );
        if (uRes.rows.length > 0) {
          await adminPool.query(
            `INSERT INTO notification (org_id, user_id, title, content, type, payload)
             VALUES ($1, $2, 'Phản hồi giải quyết khiếu nại tất toán cọc', $3, 'DISPUTE_RESOLVED', $4)`,
            [
              req.user.org_id,
              uRes.rows[0].user_id,
              `Ban Quản Lý đã xử lý khiếu nại tất toán cọc (${resolution === 'ADJUST' ? 'Mở lại điều chỉnh bảng kê' : 'Xác nhận giữ nguyên kết quả'}): "${trimmedReason}"`,
              JSON.stringify({ deposit_id: id, status: nextStatus, resolution }),
            ]
          );
        }
      } catch (nErr) {
        console.warn('[Resolve dispute notification warning]:', nErr.message);
      }

      await client.query('COMMIT');
      res.json({
        message:
          resolution === 'ADJUST'
            ? 'Đã mở lại hồ sơ tất toán (SETTLEMENT_DRAFT) để điều chỉnh bảng kê và trình duyệt lại.'
            : `Đã xác nhận kết quả giải quyết khiếu nại, chuyển trạng thái sang ${nextStatus}.`,
        data: { id, status: nextStatus, settlement: updatedSettlement },
      });
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('[Resolve Dispute Error]:', err);
      res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi khi giải quyết khiếu nại tất toán cọc.' });
    } finally {
      await release();
    }
  }
);

export default router;
