import express from 'express';
import { pool, adminPool, getUserClient } from '../db/client.js';
import { authenticateToken } from '../middleware/auth.js';
import { requireRole } from '../middleware/rbac.js';
import { saveBase64Image } from '../services/imageUpload.js';
import { idempotencyGuard } from '../middleware/idempotency.js';
import { validateRefundBankInfo } from '../services/depositSettlement.js';
import {
  scopedBuildingFilter,
  checkBuildingAccess,
} from '../services/ownerScope.js';

export const receivablesRouter = express.Router();
const router = express.Router();

const VALID_METHODS = ['BANK_TRANSFER', 'CASH', 'CARD', 'EWALLET', 'E_WALLET', 'QR_CODE', 'OTHER'];

/**
 * Helper áp dụng số tiền thanh toán đã xác nhận vào Hóa đơn & Công nợ (FR-038, FR-039, FR-040)
 */
async function applyPaymentToInvoice(client, invoiceId, payAmount) {
  if (!invoiceId) return { overpayment: 0, invoice: null };

  const invRes = await client.query('SELECT * FROM invoice WHERE id = $1 FOR UPDATE', [invoiceId]);
  if (invRes.rows.length === 0) return { overpayment: 0, invoice: null };

  const inv = invRes.rows[0];
  const total = Number(inv.total_amount || 0);
  const currentPaid = Number(inv.paid_amount || 0);
  const remaining = Math.max(0, total - currentPaid);
  const overpayment = Math.max(0, Number(payAmount) - remaining);
  const newPaid = Math.min(total, currentPaid + Number(payAmount));
  const newStatus = newPaid >= total ? 'PAID' : 'PARTIALLY_PAID';

  const upInv = await client.query(
    `UPDATE invoice
     SET paid_amount = $1,
         status = $2,
         updated_at = NOW()
     WHERE id = $3
     RETURNING *`,
    [newPaid, newStatus, invoiceId]
  );

  // Đồng bộ bảng receivable
  await client.query(
    `UPDATE receivable
     SET paid_amount = LEAST(amount, $1),
         status = CASE WHEN $1 >= amount THEN 'PAID' ELSE 'PARTIALLY_PAID' END,
         updated_at = NOW()
     WHERE invoice_id = $2 AND status IN ('OPEN', 'PARTIALLY_PAID')`,
    [newPaid, invoiceId]
  );

  return { overpayment, invoice: upInv.rows[0] };
}

/**
 * GET /api/v1/payments
 * Danh sách giao dịch thanh toán (M10)
 */
router.get(
  '/',
  authenticateToken,
  requireRole(['SYS_ADMIN', 'OWNER', 'MANAGER']),
  async (req, res) => {
    const { building_id, status, method, overpayment_only, search } = req.query;
    const orgId = req.user.org_id;

    try {
      if (building_id) {
        const ok = await checkBuildingAccess(req, building_id, 'payment');
        if (!ok) {
          return res.status(403).json({ code: 'ACCESS_DENIED', message: 'Bạn không có quyền xem thanh toán tòa nhà này.' });
        }
      }

      const params = [orgId];
      const { sql: scopeSql } = await scopedBuildingFilter(req, 'py.building_id', params);

      let sql = `
        SELECT py.*,
               i.invoice_code,
               i.period AS invoice_period,
               i.total_amount AS invoice_total,
               a.code AS apartment_code,
               b.name AS building_name,
               b.code AS building_code,
               p.full_name AS tenant_name,
               p.phone AS tenant_phone,
               p_conf.full_name AS confirmed_by_name
        FROM payment py
        JOIN building b ON b.id = py.building_id
        LEFT JOIN invoice i ON i.id = py.invoice_id
        LEFT JOIN contract c ON c.id = COALESCE(py.contract_id, i.contract_id)
        LEFT JOIN apartment a ON a.id = COALESCE(i.apartment_id, c.apartment_id)
        LEFT JOIN tenant t ON t.id = COALESCE(py.tenant_id, i.tenant_id, c.primary_tenant_id)
        LEFT JOIN person p ON p.id = t.person_id
        LEFT JOIN app_user au ON au.id = py.confirmed_by
        LEFT JOIN person p_conf ON p_conf.id = au.person_id
        WHERE py.org_id = $1
        ${scopeSql}
      `;

      if (building_id) {
        params.push(building_id);
        sql += ` AND py.building_id = $${params.length}`;
      }
      if (status) {
        params.push(status);
        sql += ` AND py.status = ANY(string_to_array($${params.length}, ','))`;
      }
      if (method) {
        params.push(method);
        sql += ` AND py.method = $${params.length}`;
      }
      if (overpayment_only === 'true') {
        sql += ` AND py.overpayment_amount > 0`;
      }
      if (search && search.trim()) {
        params.push(`%${search.trim()}%`);
        const idx = params.length;
        sql += ` AND (py.payment_code ILIKE $${idx} OR COALESCE(i.invoice_code, '') ILIKE $${idx} OR COALESCE(p.full_name, '') ILIKE $${idx} OR COALESCE(a.code, '') ILIKE $${idx})`;
      }

      sql += ` ORDER BY
        CASE WHEN py.status = 'PENDING_CONFIRMATION' THEN 0 ELSE 1 END ASC,
        py.paid_at DESC, py.created_at DESC`;

      const result = await pool.query(sql, params);
      res.json({ data: result.rows });
    } catch (err) {
      console.error('[Payments List Error]:', err);
      res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi khi tải danh sách thanh toán.' });
    }
  }
);

/**
 * POST /api/v1/payments
 * Kế toán / Quản lý ghi nhận thanh toán trực tiếp (FR-036, FR-040)
 */
router.post(
  '/',
  authenticateToken,
  requireRole(['SYS_ADMIN', 'MANAGER']),
  idempotencyGuard(),
  async (req, res) => {
    const { invoice_id, receivable_id, amount, method = 'BANK_TRANSFER', reference_code, note, proof_image } = req.body;
    const orgId = req.user.org_id;
    const numAmount = Math.round(Number(amount));

    if (!numAmount || numAmount <= 0) {
      return res.status(400).json({ code: 'INVALID_AMOUNT', message: 'Số tiền thanh toán phải lớn hơn 0.' });
    }
    if (!VALID_METHODS.includes(method)) {
      return res.status(400).json({ code: 'INVALID_METHOD', message: 'Phương thức thanh toán không hợp lệ.' });
    }
    if (!invoice_id && !receivable_id) {
      return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Vui lòng chọn hóa đơn hoặc khoản công nợ cần thu.' });
    }

    const { client, release } = await getUserClient(req);
    try {
      await client.query('BEGIN');

      let targetBuildingId = null;
      let targetInvoiceId = invoice_id || null;
      let targetContractId = null;
      let targetTenantId = null;

      if (targetInvoiceId) {
        const scopeRes = await client.query(
          `SELECT * FROM fn_get_finance_resource_scope('invoice', $1)`,
          [targetInvoiceId]
        );
        if (scopeRes.rows.length === 0) {
          await client.query('ROLLBACK');
          return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy hóa đơn.' });
        }
        const invMeta = await client.query('SELECT * FROM invoice WHERE id = $1', [targetInvoiceId]);
        const inv = invMeta.rows[0];
        if (inv.status === 'CANCELLED' || inv.status === 'VOID') {
          await client.query('ROLLBACK');
          return res.status(409).json({ code: 'INVALID_STATUS', message: 'Không thể thu tiền cho hóa đơn đã hủy.' });
        }
        targetBuildingId = inv.building_id;
        targetContractId = inv.contract_id;
        targetTenantId = inv.tenant_id;
      } else if (receivable_id) {
        const scopeRes = await client.query(
          `SELECT * FROM fn_get_finance_resource_scope('receivable', $1)`,
          [receivable_id]
        );
        if (scopeRes.rows.length === 0) {
          await client.query('ROLLBACK');
          return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy khoản công nợ.' });
        }
        const recMeta = await client.query('SELECT * FROM receivable WHERE id = $1', [receivable_id]);
        const rec = recMeta.rows[0];
        targetBuildingId = rec.building_id;
        targetInvoiceId = rec.invoice_id;
        targetContractId = rec.contract_id;
        targetTenantId = rec.tenant_id;
      }

      const ok = await checkBuildingAccess(req, targetBuildingId, 'payment');
      if (!ok) {
        await client.query('ROLLBACK');
        return res.status(403).json({ code: 'ACCESS_DENIED', message: 'Bạn không quản lý tòa nhà này.' });
      }

      let overpayment = 0;
      if (targetInvoiceId) {
        const res = await applyPaymentToInvoice(client, targetInvoiceId, numAmount);
        overpayment = res.overpayment;
      } else if (receivable_id) {
        const curRecRes = await client.query('SELECT * FROM receivable WHERE id = $1 FOR UPDATE', [receivable_id]);
        if (curRecRes.rows.length > 0) {
          const recRow = curRecRes.rows[0];
          const recAmt = Number(recRow.amount || 0);
          const recPaid = Number(recRow.paid_amount || 0);
          const remainingRec = Math.max(0, recAmt - recPaid);
          overpayment = Math.max(0, numAmount - remainingRec);
          const newRecPaid = Math.min(recAmt, recPaid + numAmount);
          const newRecStatus = newRecPaid >= recAmt ? 'PAID' : 'PARTIALLY_PAID';
          await client.query(
            `UPDATE receivable SET paid_amount = $1, status = $2, updated_at = NOW() WHERE id = $3`,
            [newRecPaid, newRecStatus, receivable_id]
          );
        }
      }

      const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      const payCode = `PAY-${dateStr}-${Math.floor(10000 + Math.random() * 90000)}`;

      const payIns = await client.query(
        `INSERT INTO payment (
           org_id, building_id, invoice_id, contract_id, tenant_id,
           payment_code, amount, overpayment_amount, method, reference_code,
           status, paid_at, note, reported_by, confirmed_by, confirmed_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'CONFIRMED', NOW(), $11, $12, $12, NOW())
         RETURNING *`,
        [
          orgId,
          targetBuildingId,
          targetInvoiceId,
          targetContractId,
          targetTenantId,
          payCode,
          numAmount,
          overpayment,
          method,
          reference_code?.trim() || null,
          note?.trim() || null,
          req.user.sub,
        ]
      );

      let paymentRow = payIns.rows[0];

      // Mint credit_balance if overpayment > 0 (Order A/B & Standalone receivable overpayment)
      if (overpayment > 0 && targetContractId) {
        await client.query(
          `INSERT INTO credit_balance (
             org_id, building_id, contract_id, tenant_id, source_invoice_id, source_payment_id,
             reason_type, amount, applied_amount, status, description, created_by
           ) VALUES (
             $1, $2, $3, $4, $5, $6,
             'OVERPAYMENT', $7, 0, 'AVAILABLE', $8, $9
           )`,
          [
            orgId,
            targetBuildingId,
            targetContractId,
            targetTenantId,
            targetInvoiceId,
            paymentRow.id,
            overpayment,
            targetInvoiceId
              ? `Thanh toán thừa hóa đơn #${paymentRow.payment_code}`
              : `Thanh toán thừa công nợ #${paymentRow.payment_code}`,
            req.user.sub,
          ]
        );
      }

      if (proof_image && typeof proof_image === 'string' && proof_image.startsWith('data:image/')) {
        const up = await saveBase64Image({
          imageBase64: proof_image,
          folder: 'payments',
          entityId: paymentRow.id,
          entity: 'payment',
          ownerId: paymentRow.id,
          req,
          query: (t, p) => client.query(t, p),
        });
        if (!up.error && up.attachment) {
          const url = `/api/v1/attachments/${up.attachment.id}/view`;
          const uRes = await client.query('UPDATE payment SET proof_images = $1 WHERE id = $2 RETURNING *', [[url], paymentRow.id]);
          paymentRow = uRes.rows[0];
        }
      }

      await client.query(
        `INSERT INTO audit_log (actor_id, action, entity, entity_id, after)
         VALUES ($1, 'CREATE_PAYMENT', 'payment', $2, $3)`,
        [req.user.sub, paymentRow.id, JSON.stringify(paymentRow)]
      );

      await client.query('COMMIT');
      res.status(201).json({
        message: overpayment > 0
          ? `Ghi nhận thanh toán thành công (Ghi nhận thanh toán thừa ${overpayment.toLocaleString('vi-VN')} ₫).`
          : 'Ghi nhận thanh toán thành công.',
        data: paymentRow,
      });
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('[Create Payment Error]:', err);
      res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi khi ghi nhận thanh toán.' });
    } finally {
      await release();
    }
  }
);

/**
 * PATCH /api/v1/payments/:id/confirm
 * Xác nhận chứng từ "Báo đã thanh toán" do cư dân gửi lên (FR-037)
 */
router.patch(
  '/:id/confirm',
  authenticateToken,
  requireRole(['SYS_ADMIN', 'MANAGER']),
  idempotencyGuard(),
  async (req, res) => {
    const { id } = req.params;
    const { note } = req.body;
    const orgId = req.user.org_id;

    const { client, release } = await getUserClient(req);
    try {
      const scopeRes = await client.query(
        `SELECT * FROM fn_get_finance_resource_scope('payment', $1)`,
        [id]
      );
      if (scopeRes.rows.length === 0) {
        return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy giao dịch thanh toán.' });
      }
      const payMeta = await client.query('SELECT * FROM payment WHERE id = $1', [id]);
      const pay = payMeta.rows[0];

      const ok = await checkBuildingAccess(req, pay.building_id, 'payment', id);
      if (!ok) {
        return res.status(403).json({ code: 'ACCESS_DENIED', message: 'Bạn không quản lý tòa nhà này.' });
      }
      if (pay.status !== 'PENDING_CONFIRMATION') {
        return res.status(409).json({ code: 'INVALID_STATUS', message: 'Giao dịch này không ở trạng thái chờ xác nhận.' });
      }

      await client.query('BEGIN');
      const { overpayment } = await applyPaymentToInvoice(client, pay.invoice_id, Number(pay.amount));

      const updated = await client.query(
        `UPDATE payment
         SET status = 'CONFIRMED',
             overpayment_amount = $1,
             note = COALESCE($2, note),
             confirmed_by = $3,
             confirmed_at = NOW()
         WHERE id = $4
         RETURNING *`,
        [overpayment, note?.trim() || null, req.user.sub, id]
      );

      if (overpayment > 0 && pay.contract_id) {
        await client.query(
          `INSERT INTO credit_balance (
             org_id, building_id, contract_id, tenant_id, source_invoice_id, source_payment_id,
             reason_type, amount, applied_amount, status, description, created_by
           ) VALUES (
             $1, $2, $3, $4, $5, $6,
             'OVERPAYMENT', $7, 0, 'AVAILABLE', $8, $9
           )
           ON CONFLICT (source_payment_id) WHERE source_payment_id IS NOT NULL AND status <> 'VOID'
           DO NOTHING`,
          [
            orgId,
            pay.building_id,
            pay.contract_id,
            pay.tenant_id,
            pay.invoice_id,
            id,
            overpayment,
            `Thanh toán thừa #${pay.payment_code}`,
            req.user.sub,
          ]
        );
      }

      if (pay.reported_by) {
        await adminPool.query(
          `INSERT INTO notification (org_id, user_id, title, content, type, payload)
           VALUES ($1, $2, $3, $4, 'PAYMENT_CONFIRMED', $5)`,
          [
            orgId,
            pay.reported_by,
            `Xác nhận thanh toán #${pay.payment_code}`,
            `Khoản thanh toán ${Number(pay.amount).toLocaleString('vi-VN')} ₫ của bạn đã được Ban quản lý đối soát và xác nhận.`,
            JSON.stringify({ payment_id: id, invoice_id: pay.invoice_id }),
          ]
        );
      }

      await client.query(
        `INSERT INTO audit_log (actor_id, action, entity, entity_id, before, after)
         VALUES ($1, 'CONFIRM_PAYMENT', 'payment', $2, $3, $4)`,
        [req.user.sub, id, JSON.stringify(pay), JSON.stringify(updated.rows[0])]
      );

      await client.query('COMMIT');
      res.json({ message: 'Đã xác nhận thanh toán thành công.', data: updated.rows[0] });
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('[Confirm Payment Error]:', err);
      res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi khi xác nhận thanh toán.' });
    } finally {
      await release();
    }
  }
);

/**
 * PATCH /api/v1/payments/:id/reject
 * Từ chối chứng từ thanh toán không hợp lệ (FR-037)
 */
router.patch(
  '/:id/reject',
  authenticateToken,
  requireRole(['SYS_ADMIN', 'MANAGER']),
  idempotencyGuard(),
  async (req, res) => {
    const { id } = req.params;
    const { reason } = req.body;
    const orgId = req.user.org_id;

    if (!reason?.trim()) {
      return res.status(400).json({ code: 'REASON_REQUIRED', message: 'Vui lòng nhập lý do từ chối.' });
    }

    const { client, release } = await getUserClient(req);
    try {
      const scopeRes = await client.query(
        `SELECT * FROM fn_get_finance_resource_scope('payment', $1)`,
        [id]
      );
      if (scopeRes.rows.length === 0) {
        return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy giao dịch.' });
      }
      const payMeta = await client.query('SELECT * FROM payment WHERE id = $1', [id]);
      const pay = payMeta.rows[0];

      const ok = await checkBuildingAccess(req, pay.building_id, 'payment', id);
      if (!ok) {
        return res.status(403).json({ code: 'ACCESS_DENIED', message: 'Bạn không quản lý tòa nhà này.' });
      }
      if (pay.status !== 'PENDING_CONFIRMATION') {
        return res.status(409).json({ code: 'INVALID_STATUS', message: 'Chỉ có thể từ chối giao dịch đang chờ xác nhận.' });
      }

      await client.query('BEGIN');
      const up = await client.query(
        `UPDATE payment
         SET status = 'REJECTED',
             note = $1,
             confirmed_by = $2,
             confirmed_at = NOW()
         WHERE id = $3
         RETURNING *`,
        [`Từ chối: ${reason.trim()}`, req.user.sub, id]
      );

      if (pay.reported_by) {
        await adminPool.query(
          `INSERT INTO notification (org_id, user_id, title, content, type, payload)
           VALUES ($1, $2, $3, $4, 'PAYMENT_REJECTED', $5)`,
          [
            orgId,
            pay.reported_by,
            `Từ chối chứng từ #${pay.payment_code}`,
            `Chứng từ thanh toán của bạn chưa được chấp nhận. Lý do: ${reason.trim()}`,
            JSON.stringify({ payment_id: id }),
          ]
        );
      }

      await client.query(
        `INSERT INTO audit_log (actor_id, action, entity, entity_id, before, after)
         VALUES ($1, 'REJECT_PAYMENT', 'payment', $2, $3, $4)`,
        [req.user.sub, id, JSON.stringify(pay), JSON.stringify(up.rows[0])]
      );

      await client.query('COMMIT');
      res.json({ message: 'Đã từ chối chứng từ thanh toán.', data: up.rows[0] });
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('[Reject Payment Error]:', err);
      res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi khi từ chối thanh toán.' });
    } finally {
      await release();
    }
  }
);

/**
 * GET /api/v1/receivables (và /api/v1/payments/receivables)
 * Theo dõi công nợ & phân tích tuổi nợ Aging: 0-30, 31-60, 61-90, >90 ngày (FR-039)
 * kèm aging_summary_prd (AC-016.1): current_not_due, 0-15, 16-30, 31-60, >60
 */
receivablesRouter.get(
  '/',
  authenticateToken,
  requireRole(['SYS_ADMIN', 'OWNER', 'MANAGER']),
  async (req, res) => {
    const { building_id, status = 'OPEN,PARTIALLY_PAID', type } = req.query;
    const orgId = req.user.org_id;

    try {
      if (building_id) {
        const ok = await checkBuildingAccess(req, building_id, 'receivable');
        if (!ok) {
          return res.status(403).json({ code: 'ACCESS_DENIED', message: 'Bạn không có quyền xem công nợ tòa nhà này.' });
        }
      }

      const params = [orgId];
      const { sql: scopeSql } = await scopedBuildingFilter(req, 'r.building_id', params);

      let sql = `
        SELECT r.*,
               (r.amount - r.paid_amount) AS balance,
               GREATEST(0, (CURRENT_DATE - r.due_date))::int AS days_overdue,
               (CURRENT_DATE - r.due_date)::int AS days_diff,
               CASE
                 WHEN (CURRENT_DATE - r.due_date) <= 30 THEN '0_30'
                 WHEN (CURRENT_DATE - r.due_date) <= 60 THEN '31_60'
                 WHEN (CURRENT_DATE - r.due_date) <= 90 THEN '61_90'
                 ELSE 'OVER_90'
               END AS aging_bucket,
               i.invoice_code,
               i.period AS invoice_period,
               a.code AS apartment_code,
               b.name AS building_name,
               b.code AS building_code,
               p.full_name AS tenant_name,
               p.phone AS tenant_phone
        FROM receivable r
        JOIN building b ON b.id = r.building_id
        LEFT JOIN invoice i ON i.id = r.invoice_id
        LEFT JOIN contract c ON c.id = r.contract_id
        LEFT JOIN apartment a ON a.id = COALESCE(i.apartment_id, c.apartment_id)
        LEFT JOIN tenant t ON t.id = COALESCE(r.tenant_id, c.primary_tenant_id)
        LEFT JOIN person p ON p.id = t.person_id
        WHERE r.org_id = $1
        ${scopeSql}
      `;

      if (building_id) {
        params.push(building_id);
        sql += ` AND r.building_id = $${params.length}`;
      }
      if (status && status !== 'ALL') {
        params.push(status);
        sql += ` AND r.status = ANY(string_to_array($${params.length}, ','))`;
      }
      if (type) {
        params.push(type);
        sql += ` AND r.type = $${params.length}`;
      }

      sql += ` ORDER BY r.due_date ASC, r.created_at DESC`;

      const result = await pool.query(sql, params);
      const rows = result.rows;

      const agingSummary = {
        bucket_0_30: 0,
        bucket_31_60: 0,
        bucket_61_90: 0,
        bucket_over_90: 0,
        total_balance: 0,
      };

      const agingSummaryPrd = {
        current_not_due: 0,
        bucket_0_15: 0,
        bucket_16_30: 0,
        bucket_31_60: 0,
        bucket_over_60: 0,
        total_overdue_balance: 0,
        total_balance: 0,
      };

      for (const row of rows) {
        if (!['OPEN', 'PARTIALLY_PAID'].includes(row.status)) continue;
        const bal = Math.max(0, Number(row.balance || 0));
        agingSummary.total_balance += bal;
        agingSummaryPrd.total_balance += bal;

        if (row.aging_bucket === '0_30') agingSummary.bucket_0_30 += bal;
        else if (row.aging_bucket === '31_60') agingSummary.bucket_31_60 += bal;
        else if (row.aging_bucket === '61_90') agingSummary.bucket_61_90 += bal;
        else agingSummary.bucket_over_90 += bal;

        const daysDiff = Number(row.days_diff || 0);
        if (daysDiff <= 0) {
          agingSummaryPrd.current_not_due += bal;
        } else {
          agingSummaryPrd.total_overdue_balance += bal;
          if (daysDiff <= 15) agingSummaryPrd.bucket_0_15 += bal;
          else if (daysDiff <= 30) agingSummaryPrd.bucket_16_30 += bal;
          else if (daysDiff <= 60) agingSummaryPrd.bucket_31_60 += bal;
          else agingSummaryPrd.bucket_over_60 += bal;
        }
      }

      res.json({ data: rows, aging_summary: agingSummary, aging_summary_prd: agingSummaryPrd });
    } catch (err) {
      console.error('[Receivables List Error]:', err);
      res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi khi tải danh sách công nợ.' });
    }
  }
);

/**
 * GET /api/v1/payments/credits
 * Danh sách số dư tín dụng (credit_balance)
 */
router.get(
  '/credits',
  authenticateToken,
  requireRole(['SYS_ADMIN', 'OWNER', 'MANAGER']),
  async (req, res) => {
    const { building_id, contract_id, tenant_id, status, search } = req.query;
    const orgId = req.user.org_id;

    try {
      if (building_id) {
        const ok = await checkBuildingAccess(req, building_id, 'credit_balance');
        if (!ok) {
          return res.status(403).json({ code: 'ACCESS_DENIED', message: 'Bạn không có quyền xem số dư tòa nhà này.' });
        }
      }

      const params = [orgId];
      const { sql: scopeSql } = await scopedBuildingFilter(req, 'cb.building_id', params);

      let sql = `
        SELECT cb.*,
               (cb.amount - cb.applied_amount) AS available_amount,
               b.name AS building_name,
               b.code AS building_code,
               a.code AS apartment_code,
               c.code AS contract_code,
               p.full_name AS tenant_name,
               p.phone AS tenant_phone
        FROM credit_balance cb
        JOIN building b ON b.id = cb.building_id
        LEFT JOIN contract c ON c.id = cb.contract_id
        LEFT JOIN apartment a ON a.id = c.apartment_id
        LEFT JOIN tenant t ON t.id = cb.tenant_id
        LEFT JOIN person p ON p.id = t.person_id
        WHERE cb.org_id = $1
        ${scopeSql}
      `;

      if (building_id) {
        params.push(building_id);
        sql += ` AND cb.building_id = $${params.length}`;
      }
      if (contract_id) {
        params.push(contract_id);
        sql += ` AND cb.contract_id = $${params.length}`;
      }
      if (tenant_id) {
        params.push(tenant_id);
        sql += ` AND cb.tenant_id = $${params.length}`;
      }
      if (status) {
        params.push(status);
        sql += ` AND cb.status = ANY(string_to_array($${params.length}, ','))`;
      }
      if (search && search.trim()) {
        params.push(`%${search.trim()}%`);
        const idx = params.length;
        sql += ` AND (COALESCE(p.full_name, '') ILIKE $${idx} OR COALESCE(a.code, '') ILIKE $${idx} OR cb.description ILIKE $${idx})`;
      }

      sql += ` ORDER BY cb.created_at DESC`;

      const result = await pool.query(sql, params);
      res.json({ data: result.rows });
    } catch (err) {
      console.error('[Credits List Error]:', err);
      res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi khi tải danh sách số dư tín dụng.' });
    }
  }
);

/**
 * POST /api/v1/payments/credits/:id/refund
 * Đề nghị hoàn trả số dư tín dụng (4-eyes workflow)
 */
router.post(
  '/credits/:id/refund',
  authenticateToken,
  requireRole(['MANAGER']),
  idempotencyGuard(),
  async (req, res) => {
    const { id } = req.params;
    const { refund_amount, refund_method, bank_name, bank_account_number, bank_account_holder, reason, proof_image } = req.body;
    const orgId = req.user.org_id;

    const { client, release } = await getUserClient(req);
    try {
      await client.query('BEGIN');

      const scopeRes = await client.query(
        `SELECT * FROM fn_get_finance_resource_scope('credit_balance', $1)`,
        [id]
      );
      if (scopeRes.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy số dư tín dụng.' });
      }
      const scope = scopeRes.rows[0];

      const ok = await checkBuildingAccess(req, scope.building_id, 'credit_balance', id);
      if (!ok) {
        await client.query('ROLLBACK');
        return res.status(403).json({ code: 'ACCESS_DENIED', message: 'Bạn không quản lý tòa nhà này.' });
      }

      const cbRes = await client.query('SELECT * FROM credit_balance WHERE id = $1 FOR UPDATE', [id]);
      if (cbRes.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy số dư tín dụng.' });
      }
      const cb = cbRes.rows[0];

      if (!['AVAILABLE', 'PARTIALLY_APPLIED'].includes(cb.status)) {
        await client.query('ROLLBACK');
        return res.status(409).json({ code: 'INVALID_STATUS', message: 'Số dư tín dụng không ở trạng thái khả dụng.' });
      }

      const availableAmt = Number(cb.amount) - Number(cb.applied_amount);
      const reqRefundAmt = refund_amount !== undefined ? Math.round(Number(refund_amount)) : availableAmt;

      if (!reqRefundAmt || reqRefundAmt <= 0 || reqRefundAmt > availableAmt) {
        await client.query('ROLLBACK');
        return res.status(400).json({ code: 'INVALID_AMOUNT', message: `Số tiền hoàn phải lớn hơn 0 và không vượt quá số dư khả dụng (${availableAmt.toLocaleString('vi-VN')} ₫).` });
      }

      // Check deposit status: blocking 409 SETTLEMENT_IN_PROGRESS if deposit is PENDING_APPROVAL, APPROVED_PENDING_PAYOUT, RETURNED, or DISPUTED uncommitted
      if (cb.contract_id) {
        const depCheck = await client.query(
          `SELECT id, status, settlement FROM deposit WHERE contract_id = $1`,
          [cb.contract_id]
        );
        for (const dep of depCheck.rows) {
          const inProgress = ['PENDING_APPROVAL', 'APPROVED_PENDING_PAYOUT', 'RETURNED'].includes(dep.status) ||
            (dep.status === 'DISPUTED' && !dep.settlement?.accounting_committed_at);
          if (inProgress) {
            await client.query('ROLLBACK');
            return res.status(409).json({
              code: 'SETTLEMENT_IN_PROGRESS',
              message: 'Hợp đồng đang trong quá trình tất toán hoặc khiếu nại cọc chưa kết chuyển kế toán.',
            });
          }
        }
      }

      const bankValidation = validateRefundBankInfo({
        refundAmount: reqRefundAmt,
        refundMethod: refund_method || 'BANK_TRANSFER',
        bankInfo: {
          bank_name: bank_name || req.body.bankInfo?.bank_name,
          account_number: bank_account_number || req.body.bankInfo?.account_number || req.body.bankInfo?.account_no,
          account_holder: bank_account_holder || req.body.bankInfo?.account_holder,
        },
      });
      if (!bankValidation.ok) {
        await client.query('ROLLBACK');
        return res.status(400).json({ code: bankValidation.code || 'VALIDATION_ERROR', message: bankValidation.message || 'Thông tin ngân hàng không hợp lệ.' });
      }

      // Prepare target credit ID: if partial split, child credit row will hold the proof
      let targetCreditRow = null;
      const isPartialSplit = reqRefundAmt < availableAmt || Number(cb.applied_amount) > 0;

      if (isPartialSplit) {
        const newApplied = Number(cb.applied_amount) + reqRefundAmt;
        const newStatus = newApplied >= Number(cb.amount) ? 'APPLIED' : 'PARTIALLY_APPLIED';
        await client.query(
          `UPDATE credit_balance
           SET applied_amount = $1, status = $2, updated_by = $3, updated_at = NOW()
           WHERE id = $4`,
          [newApplied, newStatus, req.user.sub, cb.id]
        );

        const childIns = await client.query(
          `INSERT INTO credit_balance (
             org_id, building_id, contract_id, tenant_id, parent_credit_id,
             reason_type, amount, applied_amount, status, description, created_by
           ) VALUES (
             $1, $2, $3, $4, $5,
             $6, $7, 0, 'PENDING_DIRECT_REFUND', $8, $9
           ) RETURNING *`,
          [
            orgId,
            cb.building_id,
            cb.contract_id,
            cb.tenant_id,
            cb.id,
            cb.reason_type,
            reqRefundAmt,
            `Đề nghị hoàn số dư tín dụng từ #${cb.id.slice(0, 8)}`,
            req.user.sub,
          ]
        );
        targetCreditRow = childIns.rows[0];
      } else {
        const upRes = await client.query(
          `UPDATE credit_balance
           SET status = 'PENDING_DIRECT_REFUND', updated_by = $1, updated_at = NOW()
           WHERE id = $2 RETURNING *`,
          [req.user.sub, cb.id]
        );
        targetCreditRow = upRes.rows[0];
      }

      // Proof image saving
      let proofUrl = null;
      if (proof_image && typeof proof_image === 'string') {
        const up = await saveBase64Image({
          imageBase64: proof_image,
          folder: 'credit_balances',
          entityId: targetCreditRow.id,
          entity: 'credit_balance',
          ownerId: targetCreditRow.id,
          req,
          query: (t, p) => client.query(t, p),
          allowPdf: true,
        });
        if (up.error) {
          await client.query('ROLLBACK');
          return res.status(400).json(up.error);
        }
        if (up.attachment) {
          proofUrl = `/api/v1/attachments/${up.attachment.id}/view`;
        }
      }

      const refundMeta = {
        bank_name: bank_name?.trim(),
        bank_account_number: bank_account_number?.trim(),
        bank_account_holder: bank_account_holder?.trim()?.toUpperCase(),
        reason: reason?.trim() || null,
        proof_image: proofUrl,
        requested_by: req.user.sub,
        requested_at: new Date().toISOString(),
      };

      const finalUp = await client.query(
        `UPDATE credit_balance SET refund_meta = $1 WHERE id = $2 RETURNING *`,
        [JSON.stringify(refundMeta), targetCreditRow.id]
      );
      targetCreditRow = finalUp.rows[0];

      await client.query(
        `INSERT INTO audit_log (actor_id, action, entity, entity_id, after)
         VALUES ($1, 'CREATE_CREDIT_REFUND', 'credit_balance', $2, $3)`,
        [req.user.sub, targetCreditRow.id, JSON.stringify(targetCreditRow)]
      );

      await client.query('COMMIT');
      res.status(201).json({
        message: 'Đã tạo yêu cầu hoàn trả số dư tín dụng thành công.',
        data: targetCreditRow,
      });
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('[Credit Refund Error]:', err);
      res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi khi tạo yêu cầu hoàn tiền số dư.' });
    } finally {
      await release();
    }
  }
);

/**
 * POST /api/v1/payments/credits/:id/refund/approve
 * Phê duyệt hoàn số dư tín dụng (fn_resolve_credit_refund)
 */
router.post(
  '/credits/:id/refund/approve',
  authenticateToken,
  requireRole(['OWNER', 'MANAGER', 'SYS_ADMIN']),
  idempotencyGuard(),
  async (req, res) => {
    const { id } = req.params;
    const { client, release } = await getUserClient(req);
    try {
      await client.query('BEGIN');
      const rpcRes = await client.query(
        `SELECT fn_resolve_credit_refund($1, 'APPROVED') AS result`,
        [id]
      );
      await client.query('COMMIT');
      res.json({ message: 'Phê duyệt hoàn số dư tín dụng thành công.', data: rpcRes.rows[0]?.result });
    } catch (err) {
      await client.query('ROLLBACK');
      if (err.code === '42501' && err.message?.includes('SELF_APPROVAL')) {
        return res.status(403).json({ code: 'SELF_APPROVAL', message: 'Người tạo yêu cầu hoàn tiền không được tự phê duyệt.' });
      }
      if (err.code === '42501') {
        return res.status(403).json({ code: 'FORBIDDEN', message: 'Bạn không có quyền duyệt yêu cầu hoàn tiền này.' });
      }
      if (err.code === 'P0002') {
        return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy yêu cầu hoàn tiền.' });
      }
      if (err.code === 'P0001') {
        return res.status(409).json({ code: err.message || 'INVALID_STATUS', message: 'Trạng thái yêu cầu không hợp lệ hoặc đã xử lý.' });
      }
      if (err.code === '22023') {
        return res.status(422).json({ code: err.message || 'VALIDATION_ERROR', message: 'Dữ liệu không hợp lệ.' });
      }
      console.error('[Approve Credit Refund Error]:', err);
      res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi khi phê duyệt hoàn số dư.' });
    } finally {
      await release();
    }
  }
);

/**
 * POST /api/v1/payments/credits/:id/refund/reject
 * Từ chối hoàn số dư tín dụng (fn_resolve_credit_refund)
 */
router.post(
  '/credits/:id/refund/reject',
  authenticateToken,
  requireRole(['OWNER', 'MANAGER', 'SYS_ADMIN']),
  idempotencyGuard(),
  async (req, res) => {
    const { id } = req.params;
    const { reason } = req.body;
    if (!reason?.trim()) {
      return res.status(422).json({ code: 'MISSING_REASON', message: 'Vui lòng cung cấp lý do từ chối.' });
    }

    const { client, release } = await getUserClient(req);
    try {
      await client.query('BEGIN');
      const rpcRes = await client.query(
        `SELECT fn_resolve_credit_refund($1, 'REJECTED', $2) AS result`,
        [id, reason.trim()]
      );
      await client.query('COMMIT');
      res.json({ message: 'Đã từ chối yêu cầu hoàn số dư tín dụng.', data: rpcRes.rows[0]?.result });
    } catch (err) {
      await client.query('ROLLBACK');
      if (err.code === '42501' && err.message?.includes('SELF_APPROVAL')) {
        return res.status(403).json({ code: 'SELF_APPROVAL', message: 'Người tạo yêu cầu hoàn tiền không được tự phê duyệt.' });
      }
      if (err.code === '42501') {
        return res.status(403).json({ code: 'FORBIDDEN', message: 'Bạn không có quyền từ chối yêu cầu hoàn tiền này.' });
      }
      if (err.code === 'P0002') {
        return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy yêu cầu hoàn tiền.' });
      }
      if (err.code === 'P0001') {
        return res.status(409).json({ code: err.message || 'INVALID_STATUS', message: 'Trạng thái yêu cầu không hợp lệ hoặc đã xử lý.' });
      }
      if (err.code === '22023') {
        return res.status(422).json({ code: err.message || 'VALIDATION_ERROR', message: 'Dữ liệu không hợp lệ hoặc thiếu lý do từ chối.' });
      }
      console.error('[Reject Credit Refund Error]:', err);
      res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi khi từ chối hoàn số dư.' });
    } finally {
      await release();
    }
  }
);

router.use('/receivables', receivablesRouter);

export default router;

