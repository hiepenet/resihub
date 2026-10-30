import express from 'express';
import { pool, adminPool, getUserClient } from '../db/client.js';
import { authenticateToken } from '../middleware/auth.js';
import { requireRole } from '../middleware/rbac.js';
import {
  scopedBuildingFilter,
  checkBuildingAccess,
} from '../services/ownerScope.js';
import { roundVND } from '../services/pricing.js';

const router = express.Router();
const PERIOD_RE = /^\d{4}-\d{2}$/;

/**
 * Core batch invoice generator dùng chung cho API /generate-batch và Cron Job hằng ngày theo billing_day (FR-032, FR-033, FR-066, R-04, R-05, R-10, R-11, R-16)
 */
export async function generateInvoicesCore(
  client,
  {
    orgId,
    targetPeriod,
    buildingId = null,
    applyScope = null,
    matchBillingDays = null,
    onlyOngoingContracts = false,
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

  // Lọc HĐ có giao thoa thực sự với kỳ (mở rộng cho HĐ TERMINATED/EXPIRED kết thúc trong kỳ — R-04; tính inclusive ngày trả phòng — R-16)
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
  if (Array.isArray(matchBillingDays) && matchBillingDays.length > 0) {
    params.push(matchBillingDays);
    filterSql += ` AND c.billing_day = ANY($${params.length}::int[])`;
  }

  const statusClause = onlyOngoingContracts
    ? `c.status IN ('ACTIVE', 'RENEWAL_PENDING', 'TERMINATION_PENDING')`
    : `(
         c.status IN ('ACTIVE', 'RENEWAL_PENDING', 'TERMINATION_PENDING')
         OR (
           c.status IN ('TERMINATED', 'EXPIRED')
           AND COALESCE(c.terminated_at, c.end_date) > ($2 || '-01')::date
           AND COALESCE(c.terminated_at, c.end_date) < (($2 || '-01')::date + INTERVAL '1 month')::date
         )
       )`;

  const contractSql = `
    SELECT c.*, a.code AS apartment_code, b.code AS building_code,
           au.id AS resident_user_id,
           ((($2 || '-01')::date + INTERVAL '1 month')::date - ($2 || '-01')::date)::int AS days_in_month,
           (
             (LEAST(COALESCE(c.terminated_at, c.end_date), (($2 || '-01')::date + INTERVAL '1 month')::date)
              - GREATEST(c.start_date, ($2 || '-01')::date))::int
             + CASE
                 WHEN c.status IN ('TERMINATED', 'EXPIRED')
                  AND COALESCE(c.terminated_at, c.end_date) > ($2 || '-01')::date
                  AND COALESCE(c.terminated_at, c.end_date) < (($2 || '-01')::date + INTERVAL '1 month')::date
                 THEN 1
                 ELSE 0
               END
           ) AS active_days
    FROM contract c
    JOIN apartment a ON a.id = c.apartment_id
    JOIN building b ON b.id = c.building_id
    LEFT JOIN tenant t ON t.id = c.primary_tenant_id
    LEFT JOIN app_user au ON au.person_id = t.person_id
    WHERE b.org_id = $1
      AND ${statusClause}
      AND c.start_date < (($2 || '-01')::date + INTERVAL '1 month')::date
      AND COALESCE(c.terminated_at, c.end_date) > ($2 || '-01')::date
      AND COALESCE(c.terminated_at, c.end_date) > c.start_date
      AND NOT EXISTS (
        SELECT 1 FROM invoice inv
        WHERE inv.contract_id = c.id
          AND inv.period = $2
          AND inv.status != 'CANCELLED'
      )
      ${filterSql}
    ORDER BY c.start_date ASC, c.created_at ASC
  `;

  const contractsRes = await client.query(contractSql, params);
  const createdInvoices = [];

  for (const c of contractsRes.rows) {
    const lines = [];
    const fullRent = Number(c.rent_amount || 0);
    const daysInMonth = Math.max(1, Number(c.days_in_month || 30));
    const activeDays = Math.max(0, Math.min(daysInMonth, Number(c.active_days || daysInMonth)));
    if (activeDays <= 0) continue;

    const isProrataRent = activeDays < daysInMonth;
    const rentAmt = isProrataRent ? roundVND((fullRent * activeDays) / daysInMonth) : roundVND(fullRent);
    const rentDesc = isProrataRent
      ? `Tiền thuê căn hộ ${c.apartment_code} kỳ ${targetPeriod} (Pro-rata ${activeDays}/${daysInMonth} ngày)`
      : `Tiền thuê căn hộ ${c.apartment_code} kỳ ${targetPeriod}`;

    lines.push({
      item_type: 'RENT',
      description: rentDesc,
      quantity: isProrataRent ? Number((activeDays / daysInMonth).toFixed(4)) : 1,
      unit: 'tháng',
      unit_price: fullRent,
      amount: rentAmt,
    });

    // FR-065 & R-10: Bảng giá dịch vụ/điện/nước ghi đè theo hợp đồng (ưu tiên: giá hợp đồng -> giá đồng hồ/đăng ký -> giá danh mục)
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

    // Điện / Nước từ meter_reading kỳ này (chống thu trùng nếu căn hộ có 2 HĐ nối tiếp trong cùng tháng)
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
           AND i2.status != 'CANCELLED'
           AND il2.item_type = $3
         LIMIT 1`,
        [c.apartment_id, targetPeriod, itemType]
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
        });
      }
    }

    // Dịch vụ tiện ích đang ACTIVE hoặc vừa CANCELLED trong kỳ (R-04)
    const subRes = await client.query(
      `SELECT ss.*, sc.code AS service_code, sc.category AS service_category, sc.name AS service_name, sc.unit, sc.billing_type
       FROM service_subscription ss
       JOIN service_catalog sc ON sc.id = ss.service_id
       WHERE ss.contract_id = $1
         AND sc.billing_type != 'METERED'
         AND (
           ss.status = 'ACTIVE'
           OR (
             ss.status = 'CANCELLED'
             AND ss.end_date >= ($2 || '-01')::date
             AND ss.end_date < (($2 || '-01')::date + INTERVAL '1 month')::date
           )
         )`,
      [c.id, targetPeriod]
    );
    for (const sub of subRes.rows) {
      const codeKey = String(sub.service_code || '').toUpperCase();
      const catKey = String(sub.service_category || '').toUpperCase();
      let overrideUnitPrice = cspMap.has(codeKey) ? cspMap.get(codeKey) : undefined;
      if (overrideUnitPrice === undefined) {
        if (codeKey === 'INTERNET_FIBER' || catKey === 'INTERNET') {
          overrideUnitPrice = cspMap.get('INTERNET');
        } else if (codeKey === 'MANAGEMENT_FEE' || catKey === 'MANAGEMENT') {
          overrideUnitPrice = cspMap.get('COMMON_SERVICE');
        }
      }

      const effectiveUnitPrice =
        overrideUnitPrice !== undefined ? Number(overrideUnitPrice) : Number(sub.unit_price || 0);
      const qty = Number(sub.quantity || 1);
      const subStartPeriod = sub.start_date ? new Date(sub.start_date).toISOString().slice(0, 7) : '';
      const subEndPeriod = sub.end_date ? new Date(sub.end_date).toISOString().slice(0, 7) : '';
      const isCancelledThisPeriod = sub.status === 'CANCELLED' && subEndPeriod === targetPeriod;
      const isStartedThisPeriod = subStartPeriod === targetPeriod && Number(sub.prorata_amount) > 0;
      const useProrata = isCancelledThisPeriod || isStartedThisPeriod;

      let amt = roundVND(effectiveUnitPrice * qty);
      if (isCancelledThisPeriod) {
        if (overrideUnitPrice !== undefined && sub.end_date) {
          const endDay = new Date(sub.end_date).getDate();
          const subActiveDays = Math.max(1, Math.min(daysInMonth, endDay));
          amt = roundVND((effectiveUnitPrice * qty * subActiveDays) / daysInMonth);
        } else if (Number(sub.prorata_amount) > 0) {
          amt = roundVND(Number(sub.prorata_amount));
        }
      } else if (isStartedThisPeriod) {
        if (overrideUnitPrice !== undefined && sub.start_date) {
          const startDay = new Date(sub.start_date).getDate();
          const subActiveDays = Math.max(1, daysInMonth - startDay + 1);
          amt = roundVND((effectiveUnitPrice * qty * subActiveDays) / daysInMonth);
        } else {
          amt = roundVND(Number(sub.prorata_amount));
        }
      }

      if (amt > 0) {
        lines.push({
          item_type: 'SERVICE',
          description: `${sub.service_name}${useProrata ? ' (Pro-rata)' : ''}${overrideUnitPrice !== undefined ? ' (Giá HĐ)' : ''}`,
          quantity: qty,
          unit: sub.unit || 'tháng',
          unit_price: effectiveUnitPrice,
          amount: amt,
        });
      }
    }

    const subtotal = roundVND(lines.reduce((s, l) => s + Number(l.amount || 0), 0));
    const dueDays = Number(c.payment_due_days || 5);
    const dueDate = new Date();
    dueDate.setDate(dueDate.getDate() + dueDays);
    const dueDateStr = dueDate.toISOString().slice(0, 10);

    const randSuffix = Math.floor(1000 + Math.random() * 9000);
    const invCode = `INV-${targetPeriod.replace('-', '')}-${c.building_code}-${c.apartment_code}-${randSuffix}`;
    const initStatus = autoIssue ? 'ISSUED' : 'DRAFT';

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
        subtotal,
        initStatus,
        actorId,
        autoIssue ? actorId : null,
        autoIssue ? new Date().toISOString() : null,
      ]
    );
    const inv = invIns.rows[0];

    for (const l of lines) {
      await client.query(
        `INSERT INTO invoice_line (invoice_id, item_type, description, quantity, unit, unit_price, amount)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [inv.id, l.item_type, l.description, l.quantity, l.unit, l.unit_price, l.amount]
      );
    }

    if (autoIssue && subtotal > 0) {
      await client.query(
        `INSERT INTO receivable (org_id, building_id, contract_id, tenant_id, invoice_id, type, amount, paid_amount, due_date, status, description)
         VALUES ($1, $2, $3, $4, $5, 'INVOICE_DEBT', $6, 0, $7, 'OPEN', $8)`,
        [
          orgId,
          c.building_id,
          c.id,
          c.primary_tenant_id,
          inv.id,
          subtotal,
          dueDateStr,
          `Công nợ hóa đơn ${invCode} kỳ ${targetPeriod}`,
        ]
      );

      if (c.resident_user_id) {
        await adminPool.query(
          `INSERT INTO notification (org_id, user_id, title, content, type, payload)
           VALUES ($1, $2, $3, $4, 'INVOICE_ISSUED', $5)`,
          [
            orgId,
            c.resident_user_id,
            `Hóa đơn mới kỳ ${targetPeriod}`,
            `Hóa đơn ${invCode} cho căn ${c.apartment_code} với tổng số tiền ${subtotal.toLocaleString('vi-VN')} ₫ đã được phát hành.`,
            JSON.stringify({ invoice_id: inv.id, invoice_code: invCode, period: targetPeriod }),
          ]
        );
      }
    }

    createdInvoices.push(inv);
  }

  return { createdInvoices, skippedFutureCount };
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
          if (r.status !== 'CANCELLED') {
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
 * POST /api/v1/invoices/generate-batch
 * Sinh hóa đơn hàng loạt cho các hợp đồng ACTIVE trong kỳ (FR-032, FR-033)
 */
router.post(
  '/generate-batch',
  authenticateToken,
  requireRole(['SYS_ADMIN', 'MANAGER']),
  async (req, res) => {
    const { building_id, period, auto_issue = false } = req.body;
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

        const { createdInvoices, skippedFutureCount } = await generateInvoicesCore(client, {
          orgId,
          targetPeriod,
          buildingId: building_id || null,
          applyScope: (p) => scopedBuildingFilter(req, 'c.building_id', p),
          autoIssue: Boolean(auto_issue),
          actorId: req.user.sub,
        });

        await client.query('COMMIT');
        const skippedNote = skippedFutureCount > 0 ? ` (Đã bỏ qua ${skippedFutureCount} hợp đồng tương lai chưa tới kỳ).` : '';
        res.status(201).json({
          message:
            createdInvoices.length > 0
              ? `Đã sinh thành công ${createdInvoices.length} hóa đơn kỳ ${targetPeriod}.${skippedNote}`
              : `Tất cả hợp đồng đủ điều kiện trong kỳ ${targetPeriod} đều đã có hóa đơn.${skippedNote}`,
          created_count: createdInvoices.length,
          skipped_future_count: skippedFutureCount,
          data: createdInvoices,
        });
      } catch (innerErr) {
        await client.query('ROLLBACK');
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
 * PATCH /api/v1/invoices/:id/status
 * Phát hành (ISSUED), điều chỉnh số tiền (adjustment_amount), hoặc hủy hóa đơn (CANCELLED) (FR-034, FR-035)
 */
router.patch(
  '/:id/status',
  authenticateToken,
  requireRole(['SYS_ADMIN', 'MANAGER']),
  async (req, res) => {
    const { id } = req.params;
    const { status, adjustment_amount, adjustment_reason, note, due_date } = req.body;
    const orgId = req.user.org_id;

    const { client, release } = await getUserClient(req);
    try {
      const existRes = await adminPool.query(
        'SELECT * FROM invoice WHERE id = $1 AND org_id = $2',
        [id, orgId]
      );
      if (existRes.rows.length === 0) {
        return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy hóa đơn.' });
      }
      const inv = existRes.rows[0];
      const ok = await checkBuildingAccess(req, inv.building_id, 'invoice', id);
      if (!ok) {
        return res.status(403).json({ code: 'ACCESS_DENIED', message: 'Bạn không quản lý tòa nhà của hóa đơn này.' });
      }

      await client.query('BEGIN');

      // 1. Trường hợp điều chỉnh số tiền (FR-035)
      let nextAdj = inv.adjustment_amount;
      let nextTotal = Number(inv.total_amount);
      if (adjustment_amount !== undefined) {
        if (['PAID', 'CANCELLED'].includes(inv.status)) {
          await client.query('ROLLBACK');
          return res.status(409).json({ code: 'INVALID_STATUS', message: 'Không thể điều chỉnh hóa đơn đã thanh toán hoặc đã hủy.' });
        }
        nextAdj = Math.round(Number(adjustment_amount));
        nextTotal = Math.max(0, Number(inv.subtotal_amount) + nextAdj);

        await client.query(`DELETE FROM invoice_line WHERE invoice_id = $1 AND item_type = 'ADJUSTMENT'`, [id]);
        if (nextAdj !== 0) {
          await client.query(
            `INSERT INTO invoice_line (invoice_id, item_type, description, quantity, unit, unit_price, amount)
             VALUES ($1, 'ADJUSTMENT', $2, 1, 'lần', $3, $3)`,
            [id, adjustment_reason?.trim() || 'Điều chỉnh hóa đơn', nextAdj]
          );
        }
      }

      // 2. Trường hợp chuyển trạng thái
      let nextStatus = status || inv.status;
      if (nextStatus === 'CANCELLED') {
        if (Number(inv.paid_amount) > 0) {
          await client.query('ROLLBACK');
          return res.status(409).json({
            code: 'ALREADY_PAID',
            message: 'Không thể hủy hóa đơn đã phát sinh thanh toán.',
          });
        }
        await client.query(
          `UPDATE receivable SET status = 'WRITTEN_OFF', updated_at = NOW() WHERE invoice_id = $1 AND status = 'OPEN'`,
          [id]
        );
      }

      const isIssuing = nextStatus === 'ISSUED' && inv.status === 'DRAFT';
      const updated = await client.query(
        `UPDATE invoice
         SET status = $1,
             adjustment_amount = $2,
             total_amount = $3,
             due_date = COALESCE($4, due_date),
             note = COALESCE($5, note),
             issued_by = CASE WHEN $6 THEN $7::uuid ELSE issued_by END,
             issued_at = CASE WHEN $6 THEN NOW() ELSE issued_at END,
             updated_at = NOW()
         WHERE id = $8
         RETURNING *`,
        [
          nextStatus,
          nextAdj,
          nextTotal,
          due_date || null,
          note !== undefined ? note : null,
          isIssuing,
          req.user.sub,
          id,
        ]
      );

      const updatedInv = updated.rows[0];

      // Đồng bộ bảng receivable khi phát hành hoặc điều chỉnh
      if (isIssuing && nextTotal > 0) {
        const recExist = await client.query('SELECT id FROM receivable WHERE invoice_id = $1 LIMIT 1', [id]);
        if (recExist.rows.length === 0) {
          await client.query(
            `INSERT INTO receivable (org_id, building_id, contract_id, tenant_id, invoice_id, type, amount, paid_amount, due_date, status, description)
             VALUES ($1, $2, $3, $4, $5, 'INVOICE_DEBT', $6, 0, $7, 'OPEN', $8)`,
            [
              orgId,
              inv.building_id,
              inv.contract_id,
              inv.tenant_id,
              id,
              nextTotal,
              updatedInv.due_date,
              `Công nợ hóa đơn ${inv.invoice_code} kỳ ${inv.period}`,
            ]
          );
        }

        // Gửi thông báo phát hành cho cư dân
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
                orgId,
                uRes.rows[0].id,
                `Phát hành hóa đơn ${inv.invoice_code}`,
                `Hóa đơn kỳ ${inv.period} với tổng số tiền ${nextTotal.toLocaleString('vi-VN')} ₫ đã được phát hành.`,
                JSON.stringify({ invoice_id: id, invoice_code: inv.invoice_code }),
              ]
            );
          }
        }
      } else if (adjustment_amount !== undefined && nextStatus !== 'CANCELLED') {
        await client.query(
          `UPDATE receivable SET amount = $1, updated_at = NOW() WHERE invoice_id = $2 AND status IN ('OPEN', 'PARTIALLY_PAID')`,
          [Math.max(1, nextTotal), id]
        );
      }

      await client.query(
        `INSERT INTO audit_log (actor_id, action, entity, entity_id, before, after)
         VALUES ($1, 'UPDATE_INVOICE', 'invoice', $2, $3, $4)`,
        [req.user.sub, id, JSON.stringify(inv), JSON.stringify(updatedInv)]
      );

      await client.query('COMMIT');
      res.json({ message: 'Cập nhật hóa đơn thành công.', data: updatedInv });
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('[Invoice Update Error]:', err);
      res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi khi cập nhật hóa đơn.' });
    } finally {
      await release();
    }
  }
);

export default router;

