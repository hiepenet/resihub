import express from 'express';
import { pool, adminPool, getUserClient } from '../db/client.js';
import { authenticateToken } from '../middleware/auth.js';
import { requireRole } from '../middleware/rbac.js';
import {
  scopedBuildingFilter,
  checkBuildingAccess,
} from '../services/ownerScope.js';
import { roundVND } from '../services/pricing.js';
import { idempotencyGuard } from '../middleware/idempotency.js';
import {
  toDateOnlyYmd,
  resolveContractLastActiveDay,
  computeContractRentPeriodCharge,
  computeSubscriptionPeriodCharge,
} from '../services/serviceBilling.js';
import {
  recalculateDraftInvoiceTotalsInTx,
  applyAvailableCreditsInTx,
  releaseInvoiceCreditsInTx,
  notifyBuildingInvoiceAdjustmentApprovers,
} from '../services/invoiceLifecycle.js';

const router = express.Router();
const PERIOD_RE = /^\d{4}-\d{2}$/;

/**
 * Shared helper to issue a DRAFT invoice in transaction (0 ₫ -> PAID, zero receivable)
 */
export async function issueDraftInvoiceInTx(
  client,
  { invoiceId, actorId = null, dueDate = null, note = null }
) {
  const invRes = await client.query('SELECT * FROM invoice WHERE id = $1 FOR UPDATE', [invoiceId]);
  if (invRes.rows.length === 0) {
    const err = new Error('Không tìm thấy hóa đơn.');
    err.code = 'NOT_FOUND';
    throw err;
  }
  const inv = invRes.rows[0];
  if (inv.status !== 'DRAFT') {
    const err = new Error('Chỉ có thể phát hành hóa đơn ở trạng thái DRAFT.');
    err.code = 'INVALID_STATUS';
    throw err;
  }

  const totalAmount = Number(inv.total_amount || 0);
  const targetStatus = totalAmount === 0 ? 'PAID' : 'ISSUED';
  const effectiveDueDate = dueDate || inv.due_date || new Date().toISOString().slice(0, 10);

  const upRes = await client.query(
    `UPDATE invoice
     SET status = $1,
         due_date = COALESCE($2, due_date),
         note = COALESCE($3, note),
         issued_by = $4,
         issued_at = NOW(),
         paid_amount = CASE WHEN $1 = 'PAID' THEN 0 ELSE paid_amount END,
         updated_at = NOW()
     WHERE id = $5
     RETURNING *`,
    [targetStatus, dueDate || null, note !== undefined ? note : null, actorId, invoiceId]
  );
  const updatedInv = upRes.rows[0];

  // If totalAmount > 0, insert receivable and send notification
  if (totalAmount > 0) {
    const recExist = await client.query('SELECT id FROM receivable WHERE invoice_id = $1 LIMIT 1', [invoiceId]);
    if (recExist.rows.length === 0) {
      await client.query(
        `INSERT INTO receivable (org_id, building_id, contract_id, tenant_id, invoice_id, type, amount, paid_amount, due_date, status, description)
         VALUES ($1, $2, $3, $4, $5, 'INVOICE_DEBT', $6, 0, $7, 'OPEN', $8)`,
        [
          inv.org_id,
          inv.building_id,
          inv.contract_id,
          inv.tenant_id,
          invoiceId,
          totalAmount,
          effectiveDueDate,
          `Công nợ hóa đơn ${inv.invoice_code} kỳ ${inv.period}`,
        ]
      );
    }

    if (inv.tenant_id) {
      const uRes = await adminPool.query(
        `SELECT au.id FROM app_user au JOIN tenant t ON t.person_id = au.person_id WHERE t.id = $1 LIMIT 1`,
        [inv.tenant_id]
      );
      if (uRes.rows[0]?.id) {
        await adminPool.query(
          `INSERT INTO notification (org_id, user_id, title, content, type, payload)
           VALUES ($1, $2, $3, $4, 'INVOICE_ISSUED', $5)`,
          [
            inv.org_id,
            uRes.rows[0].id,
            `Phát hành hóa đơn ${inv.invoice_code}`,
            `Hóa đơn kỳ ${inv.period} với tổng số tiền ${totalAmount.toLocaleString('vi-VN')} ₫ đã được phát hành.`,
            JSON.stringify({ invoice_id: invoiceId, invoice_code: inv.invoice_code }),
          ]
        );
      }
    }
  }

  await client.query(
    `INSERT INTO audit_log (actor_id, action, entity, entity_id, before, after)
     VALUES ($1, 'UPDATE_INVOICE_STATUS', 'invoice', $2, $3, $4)`,
    [actorId, invoiceId, JSON.stringify(inv), JSON.stringify(updatedInv)]
  );

  return updatedInv;
}

/**
 * Core batch invoice generator dùng chung cho API /generate-batch và Cron Job hằng ngày (FR-032, FR-033, FR-066, AC-015.1)
 */
export async function generateInvoicesCore(
  client,
  {
    orgId,
    targetPeriod,
    buildingId = null,
    contractId = null,
    applyScope = null,
    matchBillingDays = null,
    onlyOngoingContracts = false,
    excludeSettledDeposits = false,
    autoIssue = false,
    actorId = null,
  }
) {
  // Đếm số HĐ tương lai chưa tới kỳ để phản hồi minh bạch trên UI (Điểm 4)
  const futureParams = [orgId, targetPeriod];
  let futureFilterSql = '';
  if (typeof applyScope === 'function') {
    const { sql } = await applyScope(futureParams);
    futureFilterSql += sql;
  }
  if (buildingId) {
    futureParams.push(buildingId);
    futureFilterSql += ` AND c.building_id = $${futureParams.length}`;
  }
  if (contractId) {
    futureParams.push(contractId);
    futureFilterSql += ` AND c.id = $${futureParams.length}`;
  }
  const futureCountRes = await client.query(
    `SELECT COUNT(*)::int AS cnt
     FROM contract c
     JOIN building b ON b.id = c.building_id
     WHERE b.org_id = $1
       AND c.status IN ('ACTIVE', 'RENEWAL_PENDING', 'TERMINATION_PENDING')
       AND c.start_date >= (($2 || '-01')::date + INTERVAL '1 month')::date
       ${futureFilterSql}`,
    futureParams
  );
  const skippedFutureCount = futureCountRes.rows[0]?.cnt || 0;

  // Lọc HĐ có giao thoa thực sự với kỳ
  const params = [orgId, targetPeriod];
  let filterSql = '';
  if (typeof applyScope === 'function') {
    const { sql } = await applyScope(params);
    filterSql += sql;
  }
  if (buildingId) {
    params.push(buildingId);
    filterSql += ` AND c.building_id = $${params.length}`;
  }
  if (contractId) {
    params.push(contractId);
    filterSql += ` AND c.id = $${params.length}`;
  }
  if (Array.isArray(matchBillingDays) && matchBillingDays.length > 0) {
    params.push(matchBillingDays);
    filterSql += ` AND c.billing_day = ANY($${params.length}::int[])`;
  }

  const statusClause = onlyOngoingContracts
    ? `c.status IN ('ACTIVE', 'RENEWAL_PENDING', 'TERMINATION_PENDING')`
    : `(
         c.status IN ('ACTIVE', 'RENEWAL_PENDING', 'TERMINATION_PENDING')
         OR (
           c.status = 'TERMINATED'
           AND COALESCE(rt.child_start_date - INTERVAL '1 day', c.terminated_at, c.end_date) >= ($2 || '-01')::date
           AND COALESCE(rt.child_start_date - INTERVAL '1 day', c.terminated_at, c.end_date) < (($2 || '-01')::date + INTERVAL '1 month')::date
         )
         OR (
           c.status = 'EXPIRED'
           AND COALESCE(c.terminated_at, c.end_date) > ($2 || '-01')::date
           AND COALESCE(c.terminated_at, c.end_date) < (($2 || '-01')::date + INTERVAL '1 month')::date
         )
       )`;

  let settledClause = '';
  if (excludeSettledDeposits) {
    settledClause = `
      AND NOT EXISTS (
        SELECT 1 FROM deposit d
        WHERE d.contract_id = c.id
          AND d.status IN ('PENDING_APPROVAL', 'APPROVED_PENDING_PAYOUT', 'RETURNED', 'DISPUTED')
      )
    `;
  }

  const invoiceExistsClause = contractId
    ? `NOT EXISTS (
         SELECT 1 FROM invoice inv
         WHERE inv.contract_id = c.id
           AND inv.period = $2
           AND inv.status NOT IN ('VOID', 'CANCELLED', 'DRAFT')
       )`
    : `NOT EXISTS (
         SELECT 1 FROM invoice inv
         WHERE inv.contract_id = c.id
           AND inv.period = $2
           AND inv.status NOT IN ('VOID', 'CANCELLED')
       )`;

  const contractSql = `
    SELECT c.*, a.code AS apartment_code, b.code AS building_code,
           au.id AS resident_user_id,
           ((($2 || '-01')::date + INTERVAL '1 month')::date - ($2 || '-01')::date)::int AS days_in_month,
           rt.child_start_date AS room_transfer_child_start_date
    FROM contract c
    JOIN apartment a ON a.id = c.apartment_id
    JOIN building b ON b.id = c.building_id
    LEFT JOIN tenant t ON t.id = c.primary_tenant_id
    LEFT JOIN app_user au ON au.person_id = t.person_id
    LEFT JOIN LATERAL (
      SELECT ch.start_date AS child_start_date
      FROM contract ch
      WHERE ch.parent_contract_id = c.id
        AND ch.is_room_transfer = TRUE
        AND ch.status NOT IN ('DRAFT', 'PENDING_APPROVAL', 'CANCELLED')
      ORDER BY ch.created_at DESC
      LIMIT 1
    ) rt ON TRUE
    WHERE b.org_id = $1
      AND ${statusClause}
      ${settledClause}
      AND c.start_date < (($2 || '-01')::date + INTERVAL '1 month')::date
      AND (
        (
          c.status = 'TERMINATED'
          AND COALESCE(rt.child_start_date - INTERVAL '1 day', c.terminated_at, c.end_date) >= ($2 || '-01')::date
          AND COALESCE(rt.child_start_date - INTERVAL '1 day', c.terminated_at, c.end_date) >= c.start_date
        )
        OR (
          c.status != 'TERMINATED'
          AND COALESCE(c.terminated_at, c.end_date) > ($2 || '-01')::date
          AND COALESCE(c.terminated_at, c.end_date) > c.start_date
        )
      )
      AND ${invoiceExistsClause}
      ${filterSql}
    ORDER BY c.start_date ASC, c.created_at ASC
  `;

  const contractsRes = await client.query(contractSql, params);
  const createdInvoices = [];
  const skippedContracts = [];
  let updatedDraftCount = 0;

  for (const c of contractsRes.rows) {
    const lines = [];

    // Room transfer cutoff & last active day resolution
    const roomTransferChildStartDate = c.room_transfer_child_start_date
      ? toDateOnlyYmd(c.room_transfer_child_start_date)
      : null;
    const resolvedActive = resolveContractLastActiveDay(c, {
      roomTransferChildStartDate,
      isRoomTransfer: Boolean(roomTransferChildStartDate),
    });

    const rentCharge = computeContractRentPeriodCharge({
      contract: c,
      periodYm: targetPeriod,
      lastActiveDayYmd: resolvedActive.lastActiveDayYmd,
    });

    if (rentCharge.amount > 0) {
      lines.push({
        item_type: 'RENT',
        description: rentCharge.description,
        quantity: rentCharge.isProrated
          ? Number((rentCharge.activeDays / rentCharge.daysInMonth).toFixed(4))
          : 1,
        unit: 'tháng',
        unit_price: rentCharge.unitPrice,
        amount: rentCharge.amount,
        formula_meta: rentCharge.formulaMeta,
      });
    }

    // FR-065 & R-10: Bảng giá dịch vụ/điện/nước ghi đè theo hợp đồng
    const cspRes = await client.query(
      `SELECT service_code, unit_price
       FROM contract_service_price
       WHERE contract_id = $1
         AND effective_from <= (($2 || '-01')::date + INTERVAL '1 month' - INTERVAL '1 day')::date
       ORDER BY effective_from DESC`,
      [c.id, targetPeriod]
    );
    const cspMap = new Map();
    for (const row of cspRes.rows) {
      const key = String(row.service_code || '').toUpperCase();
      if (key && !cspMap.has(key)) {
        cspMap.set(key, Number(row.unit_price));
      }
    }

    // Điện / Nước từ meter_reading kỳ này
    const mrRes = await client.query(
      `SELECT mr.consumption, mr.previous_reading, mr.current_reading, m.meter_type, m.unit, m.unit_price
       FROM meter_reading mr
       JOIN meter m ON m.id = mr.meter_id
       WHERE mr.apartment_id = $1 AND mr.period = $2`,
      [c.apartment_id, targetPeriod]
    );
    for (const mr of mrRes.rows) {
      const itemType = mr.meter_type === 'ELECTRICITY' ? 'ELECTRICITY' : 'WATER';
      const alreadyBilledRes = await client.query(
        `SELECT 1
         FROM invoice i2
         JOIN invoice_line il2 ON il2.invoice_id = i2.id
         WHERE i2.apartment_id = $1
           AND i2.period = $2
           AND i2.status NOT IN ('VOID', 'CANCELLED')
           AND i2.contract_id <> $3
           AND il2.item_type = $4
         LIMIT 1`,
        [c.apartment_id, targetPeriod, c.id, itemType]
      );
      if (alreadyBilledRes.rows.length > 0) continue;

      const cons = Number(mr.consumption || 0);
      const hasContractPrice = cspMap.has(itemType);
      const price = hasContractPrice ? cspMap.get(itemType) : Number(mr.unit_price || 0);
      const lineAmt = roundVND(cons * price);
      if (lineAmt > 0) {
        lines.push({
          item_type: itemType,
          description: `${itemType === 'ELECTRICITY' ? 'Tiền điện' : 'Tiền nước'} (${mr.previous_reading} → ${mr.current_reading} ${mr.unit})${hasContractPrice ? ' (Giá HĐ)' : ''}`,
          quantity: cons,
          unit: mr.unit,
          unit_price: price,
          amount: lineAmt,
          formula_meta: {
            meter_type: itemType,
            consumption: cons,
            unit_price: price,
            amount: lineAmt,
          },
        });
      }
    }

    // Dịch vụ tiện ích (service_subscription)
    const subRes = await client.query(
      `SELECT ss.*, sc.code AS service_code, sc.category AS service_category, sc.name AS service_name, sc.unit, sc.billing_type
       FROM service_subscription ss
       JOIN service_catalog sc ON sc.id = ss.service_id
       WHERE ss.contract_id = $1
         AND sc.billing_type != 'METERED'
         AND ss.status IN ('ACTIVE', 'PENDING_APPROVAL', 'CANCELLATION_PENDING', 'CANCELLED', 'TERMINATED')`,
      [c.id]
    );
    for (const sub of subRes.rows) {
      const subCharge = computeSubscriptionPeriodCharge({
        subscription: sub,
        periodYm: targetPeriod,
        contractBuildingId: c.building_id,
        contractServicePrices: cspRes.rows,
      });
      if (subCharge.amount > 0) {
        lines.push({
          item_type: 'SERVICE',
          description: subCharge.description,
          quantity: subCharge.quantity,
          unit: sub.unit || 'tháng',
          unit_price: subCharge.unitPrice,
          amount: subCharge.amount,
          subscription_id: sub.id,
          formula_meta: subCharge.formulaMeta,
        });
      }
    }

    const grossSubtotal = roundVND(lines.reduce((s, l) => s + Number(l.amount || 0), 0));

    // Billable check: AC-015.1
    if (lines.length === 0 || grossSubtotal <= 0) {
      skippedContracts.push({
        contract_id: c.id,
        contract_code: c.code || c.id,
        apartment_code: c.apartment_code,
        reason: 'Không có khoản phí nào phát sinh trong kỳ.',
      });
      continue;
    }

    // Existing DRAFT in-place refresh
    const existingDraftRes = await client.query(
      `SELECT * FROM invoice WHERE contract_id = $1 AND period = $2 AND status = 'DRAFT' FOR UPDATE`,
      [c.id, targetPeriod]
    );

    if (existingDraftRes.rows.length > 0) {
      const existingDraft = existingDraftRes.rows[0];

      await releaseInvoiceCreditsInTx(client, { invoiceId: existingDraft.id, actorId });

      await client.query(
        `DELETE FROM invoice_line
         WHERE invoice_id = $1
           AND item_type <> 'ADJUSTMENT'
           AND credit_id IS NULL`,
        [existingDraft.id]
      );

      for (const l of lines) {
        await client.query(
          `INSERT INTO invoice_line (invoice_id, item_type, description, quantity, unit, unit_price, amount, subscription_id, formula_meta)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            existingDraft.id,
            l.item_type,
            l.description,
            l.quantity,
            l.unit,
            l.unit_price,
            l.amount,
            l.subscription_id || null,
            JSON.stringify(l.formula_meta || {}),
          ]
        );
      }

      await recalculateDraftInvoiceTotalsInTx(client, { invoiceId: existingDraft.id, actorId });

      await applyAvailableCreditsInTx(client, {
        contractId: c.id,
        invoiceId: existingDraft.id,
        subtotalAmount: grossSubtotal,
        actorId,
      });

      const refreshedInv = await client.query('SELECT * FROM invoice WHERE id = $1', [existingDraft.id]);
      createdInvoices.push(refreshedInv.rows[0]);
      updatedDraftCount++;
      continue;
    }

    // Create new DRAFT invoice
    const dueDays = Number(c.payment_due_days || 5);
    const dueDate = new Date();
    dueDate.setDate(dueDate.getDate() + dueDays);
    const dueDateStr = dueDate.toISOString().slice(0, 10);

    const randSuffix = Math.floor(1000 + Math.random() * 9000);
    const invCode = `INV-${targetPeriod.replace('-', '')}-${c.building_code}-${c.apartment_code}-${randSuffix}`;
    const initStatus = autoIssue ? 'ISSUED' : 'DRAFT';

    let inv;
    await client.query('SAVEPOINT sp_gen_inv');
    try {
      const invIns = await client.query(
        `INSERT INTO invoice (
           org_id, building_id, apartment_id, contract_id, tenant_id,
           invoice_code, period, issue_date, due_date,
           subtotal_amount, adjustment_amount, total_amount, paid_amount,
           status, created_by, issued_by, issued_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_DATE, $8, $9, 0, $9, 0, $10, $11, $12, $13)
         RETURNING *`,
        [
          orgId,
          c.building_id,
          c.apartment_id,
          c.id,
          c.primary_tenant_id,
          invCode,
          targetPeriod,
          dueDateStr,
          grossSubtotal,
          initStatus,
          actorId,
          autoIssue ? actorId : null,
          autoIssue ? new Date().toISOString() : null,
        ]
      );
      inv = invIns.rows[0];

      for (const l of lines) {
        await client.query(
          `INSERT INTO invoice_line (invoice_id, item_type, description, quantity, unit, unit_price, amount, subscription_id, formula_meta)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            inv.id,
            l.item_type,
            l.description,
            l.quantity,
            l.unit,
            l.unit_price,
            l.amount,
            l.subscription_id || null,
            JSON.stringify(l.formula_meta || {}),
          ]
        );
      }

      // Apply FIFO credit balance
      await applyAvailableCreditsInTx(client, {
        contractId: c.id,
        invoiceId: inv.id,
        subtotalAmount: grossSubtotal,
        actorId,
      });

      const refreshedNewInv = await client.query('SELECT * FROM invoice WHERE id = $1', [inv.id]);
      inv = refreshedNewInv.rows[0];

      if (autoIssue) {
        await issueDraftInvoiceInTx(client, {
          invoiceId: inv.id,
          actorId,
          dueDate: dueDateStr,
        });
        const issuedRow = await client.query('SELECT * FROM invoice WHERE id = $1', [inv.id]);
        inv = issuedRow.rows[0];
      }

      await client.query(
        `INSERT INTO audit_log (actor_id, action, entity, entity_id, after)
         VALUES ($1, 'CREATE_INVOICE', 'invoice', $2, $3)`,
        [actorId, inv.id, JSON.stringify(inv)]
      );

      await client.query('RELEASE SAVEPOINT sp_gen_inv');
      createdInvoices.push(inv);
    } catch (insertErr) {
      await client.query('ROLLBACK TO SAVEPOINT sp_gen_inv');
      if (insertErr.code === '23505') {
        if (contractId) {
          const err = new Error('Hóa đơn cho kỳ này đã tồn tại.');
          err.code = 'INVOICE_PERIOD_ALREADY_EXISTS';
          err.status = 409;
          throw err;
        }
        continue;
      }
      throw insertErr;
    }
  }

  return {
    created_count: createdInvoices.length,
    updated_draft_count: updatedDraftCount,
    skipped_contracts: skippedContracts,
    warnings: [],
    data: createdInvoices,
    createdInvoices,
    skippedFutureCount,
  };
}

/**
 * GET /api/v1/invoices
 * Danh sách hóa đơn theo kỳ, tòa nhà, trạng thái (M09)
 */
router.get(
  '/',
  authenticateToken,
  requireRole(['SYS_ADMIN', 'OWNER', 'MANAGER']),
  async (req, res) => {
    const { building_id, period, status, search } = req.query;
    const orgId = req.user.org_id;

    try {
      if (building_id) {
        const ok = await checkBuildingAccess(req, building_id, 'invoice');
        if (!ok) {
          return res.status(403).json({ code: 'ACCESS_DENIED', message: 'Bạn không có quyền truy cập hóa đơn tòa nhà này.' });
        }
      }

      const params = [orgId];
      const { sql: scopeSql } = await scopedBuildingFilter(req, 'i.building_id', params);

      let sql = `
        SELECT i.*,
               (i.total_amount - i.paid_amount) AS remaining_amount,
               a.code AS apartment_code,
               b.name AS building_name,
               b.code AS building_code,
               p.full_name AS tenant_name,
               p.phone AS tenant_phone
        FROM invoice i
        JOIN apartment a ON a.id = i.apartment_id
        JOIN building b ON b.id = i.building_id
        LEFT JOIN tenant t ON t.id = i.tenant_id
        LEFT JOIN person p ON p.id = t.person_id
        WHERE i.org_id = $1
        ${scopeSql}
      `;

      if (building_id) {
        params.push(building_id);
        sql += ` AND i.building_id = $${params.length}`;
      }
      if (period) {
        params.push(period);
        sql += ` AND i.period = $${params.length}`;
      }
      if (status) {
        params.push(status);
        sql += ` AND i.status = ANY(string_to_array($${params.length}, ','))`;
      }
      if (search && search.trim()) {
        params.push(`%${search.trim()}%`);
        const idx = params.length;
        sql += ` AND (i.invoice_code ILIKE $${idx} OR a.code ILIKE $${idx} OR COALESCE(p.full_name, '') ILIKE $${idx})`;
      }

      sql += ` ORDER BY i.period DESC, i.created_at DESC`;

      const result = await pool.query(sql, params);
      const rows = result.rows;

      const summary = rows.reduce(
        (acc, r) => {
          if (r.status !== 'CANCELLED' && r.status !== 'VOID') {
            acc.total_billed += Number(r.total_amount || 0);
            acc.total_paid += Number(r.paid_amount || 0);
            acc.total_unpaid += Math.max(0, Number(r.total_amount || 0) - Number(r.paid_amount || 0));
          }
          return acc;
        },
        { total_billed: 0, total_paid: 0, total_unpaid: 0 }
      );

      res.json({ data: rows, summary });
    } catch (err) {
      console.error('[Invoices List Error]:', err);
      res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi khi tải danh sách hóa đơn.' });
    }
  }
);

/**
 * GET /api/v1/invoices/adjustments
 * Danh sách yêu cầu điều chỉnh hóa đơn (Mục 16.2, FR-034, FR-035)
 */
router.get(
  '/adjustments',
  authenticateToken,
  requireRole(['SYS_ADMIN', 'OWNER', 'MANAGER']),
  async (req, res) => {
    const { building_id, status, invoice_id } = req.query;
    const orgId = req.user.org_id;

    try {
      if (building_id) {
        const ok = await checkBuildingAccess(req, building_id, 'invoice_adjustment');
        if (!ok) {
          return res.status(403).json({ code: 'ACCESS_DENIED', message: 'Bạn không có quyền truy cập yêu cầu điều chỉnh của tòa nhà này.' });
        }
      }

      const params = [orgId];
      const { sql: scopeSql } = await scopedBuildingFilter(req, 'ia.building_id', params);

      let sql = `
        SELECT ia.*,
               i.invoice_code,
               i.period AS invoice_period,
               i.total_amount AS invoice_total,
               i.paid_amount AS invoice_paid,
               a.code AS apartment_code,
               b.name AS building_name,
               b.code AS building_code,
               p_creator.full_name AS created_by_name,
               p_resolver.full_name AS approved_by_name
        FROM invoice_adjustment ia
        JOIN building b ON b.id = ia.building_id
        JOIN invoice i ON i.id = ia.invoice_id
        JOIN apartment a ON a.id = i.apartment_id
        LEFT JOIN app_user u_creator ON u_creator.id = ia.created_by
        LEFT JOIN person p_creator ON p_creator.id = u_creator.person_id
        LEFT JOIN app_user u_resolver ON u_resolver.id = ia.approved_by
        LEFT JOIN person p_resolver ON p_resolver.id = u_resolver.person_id
        WHERE ia.org_id = $1
        ${scopeSql}
      `;

      if (building_id) {
        params.push(building_id);
        sql += ` AND ia.building_id = $${params.length}`;
      }
      if (invoice_id) {
        params.push(invoice_id);
        sql += ` AND ia.invoice_id = $${params.length}`;
      }
      if (status) {
        params.push(status);
        sql += ` AND ia.status = ANY(string_to_array($${params.length}, ','))`;
      }

      sql += ` ORDER BY ia.created_at DESC`;

      const result = await pool.query(sql, params);
      res.json({ data: result.rows });
    } catch (err) {
      console.error('[Invoice Adjustments List Error]:', err);
      res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi khi tải danh sách yêu cầu điều chỉnh.' });
    }
  }
);

/**
 * POST /api/v1/invoices/generate-batch
 * Sinh hóa đơn hàng loạt hoặc theo từng hợp đồng (FR-032, FR-033, AC-015.1)
 */
router.post(
  '/generate-batch',
  authenticateToken,
  requireRole(['MANAGER']),
  idempotencyGuard(),
  async (req, res) => {
    const { building_id, contract_id, period, auto_issue = false } = req.body;
    const orgId = req.user.org_id;
    const targetPeriod = period && PERIOD_RE.test(period) ? period : new Date().toISOString().slice(0, 7);

    try {
      if (building_id) {
        const ok = await checkBuildingAccess(req, building_id, 'invoice');
        if (!ok) {
          return res.status(403).json({ code: 'ACCESS_DENIED', message: 'Bạn không quản lý tòa nhà này.' });
        }
      }

      const { client, release } = await getUserClient(req);
      try {
        await client.query('BEGIN');

        const result = await generateInvoicesCore(client, {
          orgId,
          targetPeriod,
          buildingId: building_id || null,
          contractId: contract_id || null,
          applyScope: (p) => scopedBuildingFilter(req, 'c.building_id', p),
          autoIssue: Boolean(auto_issue),
          actorId: req.user.sub,
        });

        await client.query('COMMIT');
        const skippedNote = result.skippedFutureCount > 0 ? ` (Đã bỏ qua ${result.skippedFutureCount} hợp đồng tương lai chưa tới kỳ).` : '';
        res.status(201).json({
          message:
            result.created_count > 0 || result.updated_draft_count > 0
              ? `Đã xử lý thành công (${result.created_count} tạo mới, ${result.updated_draft_count} cập nhật nháp) kỳ ${targetPeriod}.${skippedNote}`
              : `Tất cả hợp đồng đủ điều kiện trong kỳ ${targetPeriod} đều đã có hóa đơn.${skippedNote}`,
          created_count: result.created_count,
          updated_draft_count: result.updated_draft_count,
          skipped_future_count: result.skippedFutureCount,
          skipped_contracts: result.skipped_contracts,
          warnings: result.warnings,
          data: result.data,
        });
      } catch (innerErr) {
        await client.query('ROLLBACK');
        if (innerErr.code === 'INVOICE_PERIOD_ALREADY_EXISTS' || innerErr.status === 409) {
          return res.status(409).json({
            code: 'INVOICE_PERIOD_ALREADY_EXISTS',
            message: innerErr.message || 'Hóa đơn cho kỳ này đã tồn tại.',
          });
        }
        throw innerErr;
      } finally {
        await release();
      }
    } catch (err) {
      console.error('[Generate Batch Invoices Error]:', err);
      res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi khi sinh hóa đơn hàng loạt.' });
    }
  }
);

/**
 * GET /api/v1/invoices/:id
 * Chi tiết hóa đơn kèm các dòng chi tiết (lines) và lịch sử thanh toán (payments)
 */
router.get(
  '/:id',
  authenticateToken,
  requireRole(['SYS_ADMIN', 'OWNER', 'MANAGER', 'RESIDENT']),
  async (req, res) => {
    const { id } = req.params;
    const orgId = req.user.org_id;

    try {
      const meta = await adminPool.query(
        'SELECT id, building_id, tenant_id FROM invoice WHERE id = $1 AND org_id = $2',
        [id, orgId]
      );
      if (meta.rows.length === 0) {
        return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy hóa đơn.' });
      }

      const invRes = await pool.query(
        `SELECT i.*,
                (i.total_amount - i.paid_amount) AS remaining_amount,
                a.code AS apartment_code,
                a.area_m2,
                b.name AS building_name,
                b.code AS building_code,
                b.address AS building_address,
                p.full_name AS tenant_name,
                p.phone AS tenant_phone,
                p.email AS tenant_email
         FROM invoice i
         JOIN apartment a ON a.id = i.apartment_id
         JOIN building b ON b.id = i.building_id
         LEFT JOIN tenant t ON t.id = i.tenant_id
         LEFT JOIN person p ON p.id = t.person_id
         WHERE i.id = $1`,
        [id]
      );
      if (invRes.rows.length === 0) {
        return res.status(403).json({ code: 'ACCESS_DENIED', message: 'Bạn không có quyền xem hóa đơn này.' });
      }

      const [linesRes, paymentsRes] = await Promise.all([
        pool.query('SELECT * FROM invoice_line WHERE invoice_id = $1 ORDER BY created_at ASC', [id]),
        pool.query(
          `SELECT py.*, p_conf.full_name AS confirmed_by_name
           FROM payment py
           LEFT JOIN app_user au ON au.id = py.confirmed_by
           LEFT JOIN person p_conf ON p_conf.id = au.person_id
           WHERE py.invoice_id = $1
           ORDER BY py.created_at DESC`,
          [id]
        ),
      ]);

      res.json({
        data: {
          ...invRes.rows[0],
          lines: linesRes.rows,
          payments: paymentsRes.rows,
        },
      });
    } catch (err) {
      console.error('[Invoice Detail Error]:', err);
      res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi khi tải chi tiết hóa đơn.' });
    }
  }
);

/**
 * POST /api/v1/invoices/:id/lines
 * Thêm dòng chi tiết trên hóa đơn DRAFT (FR-033, FR-034)
 */
router.post(
  '/:id/lines',
  authenticateToken,
  requireRole(['MANAGER']),
  idempotencyGuard(),
  async (req, res) => {
    const { id } = req.params;
    const { item_type = 'OTHER', description, quantity = 1, unit = 'lần', unit_price = 0, amount } = req.body;

    if (!description?.trim()) {
      return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Vui lòng nhập mô tả dòng chi tiết.' });
    }

    const numQty = Number(quantity || 1);
    const numPrice = Math.round(Number(unit_price || 0));
    const numAmount = amount !== undefined ? Math.round(Number(amount)) : roundVND(numQty * numPrice);

    const { client, release } = await getUserClient(req);
    try {
      await client.query('BEGIN');

      const scopeRes = await client.query(
        `SELECT * FROM fn_get_finance_resource_scope('invoice', $1)`,
        [id]
      );
      if (scopeRes.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy hóa đơn.' });
      }
      const scope = scopeRes.rows[0];

      const ok = await checkBuildingAccess(req, scope.building_id, 'invoice', id);
      if (!ok) {
        await client.query('ROLLBACK');
        return res.status(403).json({ code: 'ACCESS_DENIED', message: 'Bạn không quản lý tòa nhà của hóa đơn này.' });
      }

      const invRes = await client.query('SELECT * FROM invoice WHERE id = $1 FOR UPDATE', [id]);
      const inv = invRes.rows[0];
      if (inv.status !== 'DRAFT') {
        await client.query('ROLLBACK');
        return res.status(409).json({ code: 'INVALID_STATUS', message: 'Chỉ có thể thêm dòng trên hóa đơn nháp (DRAFT).' });
      }

      const insLine = await client.query(
        `INSERT INTO invoice_line (invoice_id, item_type, description, quantity, unit, unit_price, amount)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
        [id, item_type, description.trim(), numQty, unit || 'lần', numPrice, numAmount]
      );
      const newLine = insLine.rows[0];

      const recalc = await recalculateDraftInvoiceTotalsInTx(client, { invoiceId: id, actorId: req.user.sub });

      await client.query('COMMIT');
      res.status(201).json({
        message: 'Thêm dòng chi tiết thành công.',
        data: {
          line: newLine,
          invoice: recalc.invoice,
        },
      });
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('[Add Invoice Line Error]:', err);
      res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi khi thêm dòng chi tiết.' });
    } finally {
      await release();
    }
  }
);

/**
 * PATCH /api/v1/invoices/:id/lines/:lineId
 * Sửa dòng chi tiết trên hóa đơn DRAFT (FR-033, FR-034)
 */
router.patch(
  '/:id/lines/:lineId',
  authenticateToken,
  requireRole(['MANAGER']),
  idempotencyGuard(),
  async (req, res) => {
    const { id, lineId } = req.params;
    const { item_type, description, quantity, unit, unit_price, amount } = req.body;

    const { client, release } = await getUserClient(req);
    try {
      await client.query('BEGIN');

      const scopeRes = await client.query(
        `SELECT * FROM fn_get_finance_resource_scope('invoice', $1)`,
        [id]
      );
      if (scopeRes.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy hóa đơn.' });
      }
      const scope = scopeRes.rows[0];

      const ok = await checkBuildingAccess(req, scope.building_id, 'invoice', id);
      if (!ok) {
        await client.query('ROLLBACK');
        return res.status(403).json({ code: 'ACCESS_DENIED', message: 'Bạn không quản lý tòa nhà của hóa đơn này.' });
      }

      const invRes = await client.query('SELECT * FROM invoice WHERE id = $1 FOR UPDATE', [id]);
      const inv = invRes.rows[0];
      if (inv.status !== 'DRAFT') {
        await client.query('ROLLBACK');
        return res.status(409).json({ code: 'INVALID_STATUS', message: 'Chỉ có thể sửa dòng trên hóa đơn nháp (DRAFT).' });
      }

      const lineRes = await client.query('SELECT * FROM invoice_line WHERE id = $1 AND invoice_id = $2', [lineId, id]);
      if (lineRes.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy dòng chi tiết.' });
      }
      const line = lineRes.rows[0];

      if (line.credit_id) {
        await client.query('ROLLBACK');
        return res.status(409).json({ code: 'CREDIT_LINE_READONLY', message: 'Không thể chỉnh sửa trực tiếp dòng bù trừ số dư tín dụng.' });
      }

      const nextQty = quantity !== undefined ? Number(quantity) : line.quantity;
      const nextPrice = unit_price !== undefined ? Math.round(Number(unit_price)) : line.unit_price;
      const nextAmount = amount !== undefined ? Math.round(Number(amount)) : roundVND(nextQty * nextPrice);

      const upLine = await client.query(
        `UPDATE invoice_line
         SET item_type = COALESCE($1, item_type),
             description = COALESCE($2, description),
             quantity = $3,
             unit = COALESCE($4, unit),
             unit_price = $5,
             amount = $6
         WHERE id = $7
         RETURNING *`,
        [item_type || null, description?.trim() || null, nextQty, unit || null, nextPrice, nextAmount, lineId]
      );

      const recalc = await recalculateDraftInvoiceTotalsInTx(client, { invoiceId: id, actorId: req.user.sub });

      await client.query('COMMIT');
      res.json({
        message: 'Cập nhật dòng chi tiết thành công.',
        data: {
          line: upLine.rows[0],
          invoice: recalc.invoice,
        },
      });
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('[Update Invoice Line Error]:', err);
      res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi khi cập nhật dòng chi tiết.' });
    } finally {
      await release();
    }
  }
);

/**
 * DELETE /api/v1/invoices/:id/lines/:lineId
 * Xóa dòng chi tiết trên hóa đơn DRAFT (FR-033, FR-034)
 */
router.delete(
  '/:id/lines/:lineId',
  authenticateToken,
  requireRole(['MANAGER']),
  idempotencyGuard(),
  async (req, res) => {
    const { id, lineId } = req.params;

    const { client, release } = await getUserClient(req);
    try {
      await client.query('BEGIN');

      const scopeRes = await client.query(
        `SELECT * FROM fn_get_finance_resource_scope('invoice', $1)`,
        [id]
      );
      if (scopeRes.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy hóa đơn.' });
      }
      const scope = scopeRes.rows[0];

      const ok = await checkBuildingAccess(req, scope.building_id, 'invoice', id);
      if (!ok) {
        await client.query('ROLLBACK');
        return res.status(403).json({ code: 'ACCESS_DENIED', message: 'Bạn không quản lý tòa nhà của hóa đơn này.' });
      }

      const invRes = await client.query('SELECT * FROM invoice WHERE id = $1 FOR UPDATE', [id]);
      const inv = invRes.rows[0];
      if (inv.status !== 'DRAFT') {
        await client.query('ROLLBACK');
        return res.status(409).json({ code: 'INVALID_STATUS', message: 'Chỉ có thể xóa dòng trên hóa đơn nháp (DRAFT).' });
      }

      const lineRes = await client.query('SELECT * FROM invoice_line WHERE id = $1 AND invoice_id = $2', [lineId, id]);
      if (lineRes.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy dòng chi tiết.' });
      }
      const line = lineRes.rows[0];

      if (line.credit_id) {
        await client.query('ROLLBACK');
        return res.status(409).json({ code: 'CREDIT_LINE_READONLY', message: 'Không thể xóa trực tiếp dòng bù trừ số dư tín dụng.' });
      }

      await client.query('DELETE FROM invoice_line WHERE id = $1', [lineId]);

      const recalc = await recalculateDraftInvoiceTotalsInTx(client, { invoiceId: id, actorId: req.user.sub });

      await client.query('COMMIT');
      res.json({
        message: 'Đã xóa dòng chi tiết thành công.',
        data: { invoice: recalc.invoice },
      });
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('[Delete Invoice Line Error]:', err);
      res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi khi xóa dòng chi tiết.' });
    } finally {
      await release();
    }
  }
);

/**
 * POST /api/v1/invoices/:id/issue
 * Phát hành hóa đơn DRAFT (0 ₫ -> PAID, zero receivable) (FR-034)
 */
router.post(
  '/:id/issue',
  authenticateToken,
  requireRole(['MANAGER']),
  idempotencyGuard(),
  async (req, res) => {
    const { id } = req.params;
    const { due_date, note } = req.body;

    const { client, release } = await getUserClient(req);
    try {
      await client.query('BEGIN');

      const scopeRes = await client.query(
        `SELECT * FROM fn_get_finance_resource_scope('invoice', $1)`,
        [id]
      );
      if (scopeRes.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy hóa đơn.' });
      }
      const scope = scopeRes.rows[0];

      const ok = await checkBuildingAccess(req, scope.building_id, 'invoice', id);
      if (!ok) {
        await client.query('ROLLBACK');
        return res.status(403).json({ code: 'ACCESS_DENIED', message: 'Bạn không quản lý tòa nhà của hóa đơn này.' });
      }

      const issuedInv = await issueDraftInvoiceInTx(client, {
        invoiceId: id,
        actorId: req.user.sub,
        dueDate: due_date,
        note,
      });

      await client.query('COMMIT');
      res.json({
        message: 'Phát hành hóa đơn thành công.',
        data: issuedInv,
      });
    } catch (err) {
      await client.query('ROLLBACK');
      if (err.code === 'INVALID_STATUS') {
        return res.status(409).json({ code: 'INVALID_STATUS', message: err.message });
      }
      console.error('[Issue Invoice Error]:', err);
      res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi khi phát hành hóa đơn.' });
    } finally {
      await release();
    }
  }
);

/**
 * PATCH /api/v1/invoices/:id/status
 * Phát hành, điều chỉnh manual adjustment hoặc hủy hóa đơn nháp (FR-034, FR-035)
 */
router.patch(
  '/:id/status',
  authenticateToken,
  requireRole(['MANAGER']),
  idempotencyGuard(),
  async (req, res) => {
    const { id } = req.params;
    const { status, adjustment_amount, adjustment_reason, note, due_date, confirm_invoice_code } = req.body;

    const { client, release } = await getUserClient(req);
    try {
      await client.query('BEGIN');

      const scopeRes = await client.query(
        `SELECT * FROM fn_get_finance_resource_scope('invoice', $1)`,
        [id]
      );
      if (scopeRes.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy hóa đơn.' });
      }
      const scope = scopeRes.rows[0];

      const ok = await checkBuildingAccess(req, scope.building_id, 'invoice', id);
      if (!ok) {
        await client.query('ROLLBACK');
        return res.status(403).json({ code: 'ACCESS_DENIED', message: 'Bạn không quản lý tòa nhà của hóa đơn này.' });
      }

      const invRes = await client.query('SELECT * FROM invoice WHERE id = $1 FOR UPDATE', [id]);
      if (invRes.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy hóa đơn.' });
      }
      const inv = invRes.rows[0];

      let targetStatus = status || inv.status;
      if (targetStatus === 'CANCELLED') {
        targetStatus = 'VOID';
      }

      // Check #1 FIRST: targetStatus === 'VOID' && Number(inv.paid_amount) > 0 -> 409 ALREADY_PAID
      // Preserves fullWebsiteWhiteBlackBox.test.js:1403-1408!
      if (targetStatus === 'VOID' && Number(inv.paid_amount || 0) > 0) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          code: 'ALREADY_PAID',
          message: 'Không thể hủy hóa đơn đã phát sinh thanh toán.',
        });
      }

      // Check #2: inv.status !== 'DRAFT' with adjustment_amount or VOID -> 409 REQUIRES_FOUR_EYES_ADJUSTMENT
      if (inv.status !== 'DRAFT') {
        if (adjustment_amount !== undefined || targetStatus === 'VOID') {
          await client.query('ROLLBACK');
          return res.status(409).json({
            code: 'REQUIRES_FOUR_EYES_ADJUSTMENT',
            message: 'Hóa đơn đã phát hành yêu cầu lập đề nghị điều chỉnh qua quy trình duyệt 4 mắt.',
          });
        }
      }

      // If DRAFT status:
      if (inv.status === 'DRAFT') {
        if (targetStatus === 'ISSUED') {
          const issuedInv = await issueDraftInvoiceInTx(client, {
            invoiceId: id,
            actorId: req.user.sub,
            dueDate: due_date,
            note,
          });
          await client.query('COMMIT');
          return res.json({ message: 'Phát hành hóa đơn thành công.', data: issuedInv });
        }

        if (targetStatus === 'VOID') {
          if (confirm_invoice_code && confirm_invoice_code.trim() !== inv.invoice_code) {
            await client.query('ROLLBACK');
            return res.status(422).json({ code: 'CONFIRM_CODE_MISMATCH', message: 'Mã xác nhận hủy hóa đơn không khớp.' });
          }

          await releaseInvoiceCreditsInTx(client, { invoiceId: id, actorId: req.user.sub });

          const voidedRes = await client.query(
            `UPDATE invoice
             SET status = 'VOID',
                 subtotal_amount = 0,
                 adjustment_amount = 0,
                 total_amount = 0,
                 credit_offset_amount = 0,
                 updated_at = NOW()
             WHERE id = $1
             RETURNING *`,
            [id]
          );

          await client.query(
            `INSERT INTO audit_log (actor_id, action, entity, entity_id, before, after)
             VALUES ($1, 'UPDATE_INVOICE_STATUS', 'invoice', $2, $3, $4)`,
            [req.user.sub, id, JSON.stringify(inv), JSON.stringify(voidedRes.rows[0])]
          );

          await client.query('COMMIT');
          return res.json({ message: 'Đã hủy hóa đơn nháp thành công.', data: voidedRes.rows[0] });
        }

        if (adjustment_amount !== undefined) {
          const nextAdj = Math.round(Number(adjustment_amount));
          await client.query(
            `DELETE FROM invoice_line
             WHERE invoice_id = $1 AND item_type = 'ADJUSTMENT' AND credit_id IS NULL`,
            [id]
          );

          if (nextAdj !== 0) {
            await client.query(
              `INSERT INTO invoice_line (invoice_id, item_type, description, quantity, unit, unit_price, amount)
               VALUES ($1, 'ADJUSTMENT', $2, 1, 'lần', $3, $3)`,
              [id, adjustment_reason?.trim() || 'Điều chỉnh thủ công', nextAdj]
            );
          }

          const recalc = await recalculateDraftInvoiceTotalsInTx(client, { invoiceId: id, actorId: req.user.sub });
          await client.query('COMMIT');
          return res.json({ message: 'Cập nhật điều chỉnh thành công.', data: recalc.invoice });
        }
      }

      const updated = await client.query(
        `UPDATE invoice
         SET due_date = COALESCE($1, due_date),
             note = COALESCE($2, note),
             updated_at = NOW()
         WHERE id = $3
         RETURNING *`,
        [due_date || null, note !== undefined ? note : null, id]
      );

      await client.query('COMMIT');
      res.json({ message: 'Cập nhật hóa đơn thành công.', data: updated.rows[0] });
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('[Invoice Status Error]:', err);
      res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi khi cập nhật trạng thái hóa đơn.' });
    } finally {
      await release();
    }
  }
);

/**
 * POST /api/v1/invoices/:id/adjust
 * Lập đề nghị điều chỉnh hóa đơn đã phát hành (FR-034, FR-035, FR-064)
 */
router.post(
  '/:id/adjust',
  authenticateToken,
  requireRole(['MANAGER']),
  idempotencyGuard(),
  async (req, res) => {
    const { id } = req.params;
    const { adjustment_target = 'AMOUNT', action_type, delta_amount, reason, confirm_invoice_code } = req.body;
    const orgId = req.user.org_id;

    if (!reason?.trim()) {
      return res.status(400).json({ code: 'REASON_REQUIRED', message: 'Vui lòng nhập lý do điều chỉnh.' });
    }
    const validTargets = ['AMOUNT', 'LATE_FEE'];
    if (!validTargets.includes(adjustment_target)) {
      return res.status(400).json({ code: 'INVALID_TARGET', message: 'Mục tiêu điều chỉnh không hợp lệ (AMOUNT hoặc LATE_FEE).' });
    }
    const validActions = ['INCREASE', 'DECREASE', 'WAIVE', 'VOID'];
    if (!validActions.includes(action_type)) {
      return res.status(400).json({ code: 'INVALID_ACTION', message: 'Hành động điều chỉnh không hợp lệ (INCREASE, DECREASE, WAIVE, VOID).' });
    }

    const { client, release } = await getUserClient(req);
    try {
      await client.query('BEGIN');

      const scopeRes = await client.query(
        `SELECT * FROM fn_get_finance_resource_scope('invoice', $1)`,
        [id]
      );
      if (scopeRes.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy hóa đơn.' });
      }
      const scope = scopeRes.rows[0];

      const ok = await checkBuildingAccess(req, scope.building_id, 'invoice', id);
      if (!ok) {
        await client.query('ROLLBACK');
        return res.status(403).json({ code: 'ACCESS_DENIED', message: 'Bạn không quản lý tòa nhà của hóa đơn này.' });
      }

      const invRes = await client.query('SELECT * FROM invoice WHERE id = $1 FOR UPDATE', [id]);
      const inv = invRes.rows[0];

      if (inv.status === 'DRAFT') {
        await client.query('ROLLBACK');
        return res.status(409).json({ code: 'INVALID_STATUS', message: 'Hóa đơn DRAFT được sửa trực tiếp qua bộ API dòng nháp, không cần lập yêu cầu duyệt 4 mắt.' });
      }
      if (['CANCELLED', 'VOID'].includes(inv.status)) {
        await client.query('ROLLBACK');
        return res.status(409).json({ code: 'INVALID_STATUS', message: 'Không thể điều chỉnh hóa đơn đã hủy.' });
      }

      const rawAction = String(action_type || 'ADJUST').trim().toUpperCase();
      const mappedActionType = rawAction === 'VOID' ? 'VOID' : 'ADJUST';

      let targetUpper = String(adjustment_target || 'MANUAL').trim().toUpperCase();
      if (!['SERVICE', 'RENT', 'LATE_FEE', 'MANUAL'].includes(targetUpper)) {
        targetUpper = 'MANUAL';
      }

      if (mappedActionType === 'VOID' && Number(inv.paid_amount || 0) > 0) {
        await client.query('ROLLBACK');
        return res.status(409).json({ code: 'ALREADY_PAID', message: 'Không thể hủy hóa đơn đã phát sinh thanh toán.' });
      }

      if (confirm_invoice_code && confirm_invoice_code.trim() !== inv.invoice_code) {
        await client.query('ROLLBACK');
        return res.status(422).json({ code: 'CONFIRM_CODE_MISMATCH', message: 'Mã xác nhận hóa đơn không khớp.' });
      }

      const numDelta = mappedActionType === 'VOID' ? 0 : (delta_amount !== undefined ? Math.round(Number(delta_amount)) : 0);
      if (mappedActionType === 'ADJUST' && numDelta === 0) {
        await client.query('ROLLBACK');
        return res.status(422).json({ code: 'INVALID_DELTA', message: 'Số tiền điều chỉnh không được bằng 0.' });
      }

      const insAdj = await client.query(
        `INSERT INTO invoice_adjustment (
           org_id, building_id, invoice_id, adjustment_target, action_type, delta_amount, reason, status, created_by
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'PENDING_APPROVAL', $8)
         RETURNING *`,
        [orgId, inv.building_id, id, targetUpper, mappedActionType, numDelta, reason.trim(), req.user.sub]
      );
      const adjRow = insAdj.rows[0];

      await notifyBuildingInvoiceAdjustmentApprovers(client, {
        orgId,
        buildingId: inv.building_id,
        invoiceId: id,
        invoiceCode: inv.invoice_code,
        adjustmentId: adjRow.id,
        actionType: mappedActionType,
        deltaAmount: numDelta,
        actorId: req.user.sub,
      });

      await client.query(
        `INSERT INTO audit_log (actor_id, action, entity, entity_id, after)
         VALUES ($1, 'CREATE_INVOICE_ADJUSTMENT', 'invoice_adjustment', $2, $3)`,
        [req.user.sub, adjRow.id, JSON.stringify(adjRow)]
      );

      await client.query('COMMIT');
      res.status(201).json({
        message: 'Đã lập đề nghị điều chỉnh hóa đơn thành công. Đang chờ cấp trên phê duyệt.',
        data: adjRow,
      });
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('[Invoice Adjust Error]:', err);
      res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi khi lập đề nghị điều chỉnh hóa đơn.' });
    } finally {
      await release();
    }
  }
);

/**
 * POST /api/v1/invoices/:id/adjustments/:adjId/approve
 * Phê duyệt điều chỉnh hóa đơn (fn_resolve_invoice_adjustment)
 */
router.post(
  '/:id/adjustments/:adjId/approve',
  authenticateToken,
  requireRole(['OWNER', 'MANAGER', 'SYS_ADMIN']),
  idempotencyGuard(),
  async (req, res) => {
    const { adjId } = req.params;
    const { client, release } = await getUserClient(req);
    try {
      await client.query('BEGIN');
      const rpcRes = await client.query(
        `SELECT fn_resolve_invoice_adjustment($1, 'APPROVED') AS result`,
        [adjId]
      );
      await client.query('COMMIT');
      res.json({ message: 'Phê duyệt điều chỉnh hóa đơn thành công.', data: rpcRes.rows[0]?.result });
    } catch (err) {
      await client.query('ROLLBACK');
      if (err.code === '42501' && err.message?.includes('SELF_APPROVAL')) {
        return res.status(403).json({ code: 'SELF_APPROVAL', message: 'Người tạo đề xuất không được tự phê duyệt yêu cầu điều chỉnh hóa đơn.' });
      }
      if (err.code === '42501') {
        return res.status(403).json({ code: 'FORBIDDEN', message: 'Bạn không có quyền duyệt yêu cầu điều chỉnh này.' });
      }
      if (err.code === 'P0002') {
        return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy yêu cầu điều chỉnh.' });
      }
      if (err.code === 'P0001') {
        return res.status(409).json({ code: err.message || 'INVALID_STATUS', message: 'Trạng thái yêu cầu không hợp lệ hoặc đã xử lý.' });
      }
      if (err.code === '22023') {
        return res.status(422).json({ code: err.message || 'VALIDATION_ERROR', message: 'Dữ liệu không hợp lệ.' });
      }
      console.error('[Approve Adjustment Error]:', err);
      res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi khi phê duyệt điều chỉnh hóa đơn.' });
    } finally {
      await release();
    }
  }
);

/**
 * POST /api/v1/invoices/:id/adjustments/:adjId/reject
 * Từ chối điều chỉnh hóa đơn (fn_resolve_invoice_adjustment)
 */
router.post(
  '/:id/adjustments/:adjId/reject',
  authenticateToken,
  requireRole(['OWNER', 'MANAGER', 'SYS_ADMIN']),
  idempotencyGuard(),
  async (req, res) => {
    const { adjId } = req.params;
    const { reason } = req.body;
    if (!reason?.trim()) {
      return res.status(422).json({ code: 'MISSING_REASON', message: 'Vui lòng cung cấp lý do từ chối.' });
    }

    const { client, release } = await getUserClient(req);
    try {
      await client.query('BEGIN');
      const rpcRes = await client.query(
        `SELECT fn_resolve_invoice_adjustment($1, 'REJECTED', $2) AS result`,
        [adjId, reason.trim()]
      );
      await client.query('COMMIT');
      res.json({ message: 'Đã từ chối đề nghị điều chỉnh hóa đơn.', data: rpcRes.rows[0]?.result });
    } catch (err) {
      await client.query('ROLLBACK');
      if (err.code === '42501' && err.message?.includes('SELF_APPROVAL')) {
        return res.status(403).json({ code: 'SELF_APPROVAL', message: 'Người tạo đề xuất không được tự phê duyệt yêu cầu điều chỉnh hóa đơn.' });
      }
      if (err.code === '42501') {
        return res.status(403).json({ code: 'FORBIDDEN', message: 'Bạn không có quyền từ chối yêu cầu điều chỉnh này.' });
      }
      if (err.code === 'P0002') {
        return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy yêu cầu điều chỉnh.' });
      }
      if (err.code === 'P0001') {
        return res.status(409).json({ code: err.message || 'INVALID_STATUS', message: 'Trạng thái yêu cầu không hợp lệ hoặc đã xử lý.' });
      }
      if (err.code === '22023') {
        return res.status(422).json({ code: err.message || 'VALIDATION_ERROR', message: 'Dữ liệu không hợp lệ hoặc thiếu lý do từ chối.' });
      }
      console.error('[Reject Adjustment Error]:', err);
      res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi khi từ chối điều chỉnh hóa đơn.' });
    } finally {
      await release();
    }
  }
);

/**
 * GET /api/v1/invoices/:id/audit-logs
 * Nhật ký kiểm toán / lịch sử thao tác của hóa đơn (PRD 8.2)
 */
router.get(
  '/:id/audit-logs',
  authenticateToken,
  requireRole(['SYS_ADMIN', 'OWNER', 'MANAGER']),
  async (req, res) => {
    const { id } = req.params;

    try {
      const scopeRes = await pool.query(
        `SELECT * FROM fn_get_finance_resource_scope('invoice', $1)`,
        [id]
      );
      if (scopeRes.rows.length === 0) {
        return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy hóa đơn.' });
      }
      const scope = scopeRes.rows[0];

      const ok = await checkBuildingAccess(req, scope.building_id, 'invoice', id);
      if (!ok) {
        return res.status(403).json({ code: 'ACCESS_DENIED', message: 'Bạn không có quyền truy cập kiểm toán hóa đơn này.' });
      }

      const logsRes = await pool.query(
        `SELECT al.*, p.full_name AS actor_name, p.email AS actor_email
         FROM audit_log al
         LEFT JOIN app_user au ON au.id = al.actor_id
         LEFT JOIN person p ON p.id = au.person_id
         WHERE (al.entity = 'invoice' AND al.entity_id = $1)
            OR (al.entity = 'invoice_adjustment' AND al.after->>'invoice_id' = $1::text)
            OR (al.entity = 'invoice_line' AND al.after->>'invoice_id' = $1::text)
         ORDER BY al.at DESC`,
        [id]
      );

      res.json({ data: logsRes.rows });
    } catch (err) {
      console.error('[Invoice Audit Logs Error]:', err);
      res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi khi tải lịch sử kiểm toán hóa đơn.' });
    }
  }
);

export default router;
