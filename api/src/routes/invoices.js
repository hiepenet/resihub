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
  todayVietnamYmd,
  currentVietnamPeriod,
  toDateOnlyYmd,
  addDaysYmd,
  getMonthBoundsYmd,
  resolveContractLastActiveDay,
  computeContractRentPeriodCharge,
  computeSubscriptionPeriodCharge,
  resolveUtilityUnitPrice,
} from '../services/serviceBilling.js';
import {
  recalculateDraftInvoiceTotalsInTx,
  applyAvailableCreditsInTx,
  releaseInvoiceCreditsInTx,
  notifyBuildingInvoiceAdjustmentApprovers,
  collectPriorUnbilledSubscriptionArrearsLinesInTx,
} from '../services/invoiceLifecycle.js';
import { notifyUser } from '../services/notificationService.js';

const router = express.Router();
const PERIOD_RE = /^\d{4}-\d{2}$/;

/**
 * Helper to batch-insert invoice_line rows using a single UNNEST query
 */
async function batchInsertInvoiceLinesInTx(client, invoiceId, lines) {
  if (!Array.isArray(lines) || lines.length === 0) return;
  const invoiceIds = [];
  const itemTypes = [];
  const descriptions = [];
  const quantities = [];
  const units = [];
  const unitPrices = [];
  const amounts = [];
  const subscriptionIds = [];
  const formulaMetas = [];

  for (const l of lines) {
    invoiceIds.push(invoiceId);
    itemTypes.push(l.item_type);
    descriptions.push(l.description);
    quantities.push(Number(l.quantity ?? 1));
    units.push(l.unit || 'lần');
    unitPrices.push(Math.round(Number(l.unit_price || 0)));
    amounts.push(Math.round(Number(l.amount || 0)));
    subscriptionIds.push(l.subscription_id || null);
    formulaMetas.push(JSON.stringify(l.formula_meta || {}));
  }

  await client.query(
    `INSERT INTO invoice_line (
       invoice_id, item_type, description, quantity, unit, unit_price, amount, subscription_id, formula_meta
     )
     SELECT * FROM UNNEST(
       $1::uuid[],
       $2::text[],
       $3::text[],
       $4::numeric[],
       $5::text[],
       $6::bigint[],
       $7::bigint[],
       $8::uuid[],
       $9::jsonb[]
     )`,
    [
      invoiceIds,
      itemTypes,
      descriptions,
      quantities,
      units,
      unitPrices,
      amounts,
      subscriptionIds,
      formulaMetas,
    ]
  );
}

/**
 * Shared helper to issue a DRAFT invoice in transaction (0 ₫ -> PAID, zero receivable)
 */
export async function issueDraftInvoiceInTx(
  client,
  {
    invoiceId,
    actorId = null,
    dueDate = null,
    note = null,
    prefetchedInvoice = null,
    skipReceivableExistenceCheck = false,
    residentUserId = undefined,
  }
) {
  let inv = prefetchedInvoice;
  if (!inv) {
    const invRes = await client.query('SELECT * FROM invoice WHERE id = $1 FOR UPDATE', [invoiceId]);
    if (invRes.rows.length === 0) {
      const err = new Error('Không tìm thấy hóa đơn.');
      err.code = 'NOT_FOUND';
      throw err;
    }
    inv = invRes.rows[0];
  }
  if (inv.status !== 'DRAFT') {
    const err = new Error('Chỉ có thể phát hành hóa đơn ở trạng thái DRAFT.');
    err.code = 'INVALID_STATUS';
    throw err;
  }

  const totalAmount = Number(inv.total_amount || 0);
  const targetStatus = totalAmount === 0 ? 'PAID' : 'ISSUED';
  const effectiveDueDate = dueDate || inv.due_date || todayVietnamYmd();

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
    const periodLabel = inv.period ? `kỳ ${inv.period}` : 'tất toán phí phạt';
    let shouldInsertReceivable = true;
    if (!skipReceivableExistenceCheck) {
      const recExist = await client.query('SELECT id FROM receivable WHERE invoice_id = $1 LIMIT 1', [invoiceId]);
      shouldInsertReceivable = recExist.rows.length === 0;
    }
    if (shouldInsertReceivable) {
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
          `Công nợ hóa đơn ${inv.invoice_code} ${periodLabel}`,
        ]
      );
    }

    if (inv.tenant_id) {
      let targetUserId = residentUserId;
      if (targetUserId === undefined) {
        const uRes = await adminPool.query(
          `SELECT au.id FROM app_user au JOIN tenant t ON t.person_id = au.person_id WHERE t.id = $1 LIMIT 1`,
          [inv.tenant_id]
        );
        targetUserId = uRes.rows[0]?.id || null;
      }
      if (targetUserId) {
        await adminPool.query(
          `INSERT INTO notification (org_id, user_id, title, content, type, payload)
           VALUES ($1, $2, $3, $4, 'INVOICE_ISSUED', $5)`,
          [
            inv.org_id,
            targetUserId,
            `Phát hành hóa đơn ${inv.invoice_code}`,
            `Hóa đơn ${periodLabel} với tổng số tiền ${totalAmount.toLocaleString('vi-VN')} ₫ đã được phát hành.`,
            JSON.stringify({
              invoice_id: invoiceId,
              invoice_code: inv.invoice_code,
              contract_id: inv.contract_id,
              building_id: inv.building_id,
              apartment_id: inv.apartment_id,
            }),
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
 * Tạo và phát hành ngay hóa đơn tất toán phí phạt kỳ cuối (LATE_FEE_SETTLEMENT) cho hợp đồng đã kết thúc (Spec §4.4, FR-064, FR-024)
 */
export async function createLateFeeSettlementInvoiceInTx(
  client,
  {
    contractId,
    orgId,
    buildingId = null,
    apartmentId = null,
    tenantId = null,
    totalAccrual,
    sourceTrackerIds = [],
    effectiveDateYmd = null,
  }
) {
  let resolvedBuildingId = buildingId;
  let resolvedApartmentId = apartmentId;
  let resolvedTenantId = tenantId;

  if (!resolvedBuildingId || !resolvedApartmentId || !resolvedTenantId) {
    const cRes = await client.query(
      `SELECT building_id, apartment_id, primary_tenant_id FROM contract WHERE id = $1 LIMIT 1`,
      [contractId]
    );
    if (cRes.rows[0]) {
      resolvedBuildingId = resolvedBuildingId || cRes.rows[0].building_id;
      resolvedApartmentId = resolvedApartmentId || cRes.rows[0].apartment_id;
      resolvedTenantId = resolvedTenantId || cRes.rows[0].primary_tenant_id;
    }
  }

  const issueDateStr = effectiveDateYmd || todayVietnamYmd();
  const dueDateStr = addDaysYmd(issueDateStr, 7);
  const amt = roundVND(Number(totalAccrual || 0));
  const invCode = `LF-${String(contractId).slice(0, 8).toUpperCase()}-${issueDateStr.replace(/-/g, '')}-${Math.floor(1000 + Math.random() * 9000)}`;

  const invIns = await client.query(
    `INSERT INTO invoice (
       org_id, building_id, apartment_id, contract_id, tenant_id,
       invoice_type, period, invoice_code, issue_date, due_date,
       status, subtotal_amount, adjustment_amount, total_amount, paid_amount
     )
     VALUES ($1, $2, $3, $4, $5, 'LATE_FEE_SETTLEMENT', NULL, $6, $7::date, $8::date, 'DRAFT', $9, 0, $9, 0)
     RETURNING *`,
    [
      orgId,
      resolvedBuildingId,
      resolvedApartmentId,
      contractId,
      resolvedTenantId,
      invCode,
      issueDateStr,
      dueDateStr,
      amt,
    ]
  );
  const draftInv = invIns.rows[0];

  await client.query(
    `INSERT INTO invoice_line (
       invoice_id, item_type, description, quantity, unit, unit_price, amount, formula_meta
     )
     VALUES ($1, 'LATE_FEE', 'Phí phạt chậm thanh toán kỳ cuối (tất toán)', 1, 'kỳ', $2, $2, $3::jsonb)`,
    [
      draftInv.id,
      amt,
      JSON.stringify({
        settlement: true,
        source_tracker_ids: sourceTrackerIds,
        as_of_date: issueDateStr,
      }),
    ]
  );

  const issuedInv = await issueDraftInvoiceInTx(client, {
    invoiceId: draftInv.id,
    actorId: null,
    dueDate: dueDateStr,
  });

  await client.query(
    `INSERT INTO audit_log (actor_id, action, entity, entity_id, before, after)
     VALUES (NULL, 'CREATE_LATE_FEE_SETTLEMENT_INVOICE', 'invoice', $1, NULL, $2::jsonb)`,
    [issuedInv.id, JSON.stringify(issuedInv)]
  );

  return issuedInv;
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
    issueDateYmd = null,
    dueDate = null,
    actorId = null,
    allowMissingMeterReadings = false,
  }
) {
  const { monthEnd } = getMonthBoundsYmd(targetPeriod);
  const effectiveIssueDateYmd = issueDateYmd || todayVietnamYmd();

  const catalogRes = await client.query(
    `SELECT id, building_id, code, category, unit_price, is_active
     FROM service_catalog
     WHERE org_id = $1 AND is_active = TRUE`,
    [orgId]
  );
  const settingRes = await client.query(
    `SELECT value FROM system_setting WHERE org_id = $1 AND key = 'billing_config' LIMIT 1`,
    [orgId]
  );
  const catalogItems = catalogRes.rows;
  const billingConfig = settingRes.rows[0]?.value || {};
  const defaultDueOffsetDays = Number.isFinite(Number(billingConfig.due_date_offset_days))
    ? Math.max(0, Math.round(Number(billingConfig.due_date_offset_days)))
    : Number.isFinite(Number(billingConfig.payment_due_days))
    ? Math.max(0, Math.round(Number(billingConfig.payment_due_days)))
    : 5;
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
           AND (
             ${contractId ? 'TRUE OR ' : ''}(
               COALESCE(rt.child_start_date - INTERVAL '1 day', c.terminated_at, c.end_date) >= ($2 || '-01')::date
               AND COALESCE(rt.child_start_date - INTERVAL '1 day', c.terminated_at, c.end_date) < (($2 || '-01')::date + INTERVAL '1 month')::date
             )
             OR (
               rt.child_start_date IS NOT NULL
               AND c.terminated_at IS NOT NULL
               AND date_trunc('month', c.terminated_at)::date <= ($2 || '-01')::date
               AND (rt.child_start_date - INTERVAL '1 day')::date >= ($2 || '-01')::date
             )
           )
         )
         OR (
           c.status = 'EXPIRED'
           AND (
             ${contractId ? 'TRUE OR ' : ''}(
               COALESCE(c.terminated_at, c.end_date) > ($2 || '-01')::date
               AND COALESCE(c.terminated_at, c.end_date) < (($2 || '-01')::date + INTERVAL '1 month')::date
             )
           )
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
           AND COALESCE(inv.invoice_type, 'REGULAR') = 'REGULAR'
           AND inv.status NOT IN ('VOID', 'CANCELLED', 'DRAFT')
       )`
    : `NOT EXISTS (
         SELECT 1 FROM invoice inv
         WHERE inv.contract_id = c.id
           AND inv.period = $2
           AND COALESCE(inv.invoice_type, 'REGULAR') = 'REGULAR'
           AND inv.status NOT IN ('VOID', 'CANCELLED')
       )`;

  const contractSql = `
    SELECT c.*, a.code AS apartment_code, b.code AS building_code,
           ((($2 || '-01')::date + INTERVAL '1 month')::date - ($2 || '-01')::date)::int AS days_in_month,
           rt.child_start_date AS room_transfer_child_start_date
    FROM contract c
    JOIN apartment a ON a.id = c.apartment_id
    JOIN building b ON b.id = c.building_id
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

  if (contractsRes.rows.length === 0) {
    return {
      created_count: 0,
      updated_draft_count: 0,
      updatedDraftCount: 0,
      skipped_contracts: [],
      skippedContracts: [],
      warnings: [],
      data: [],
      createdInvoices: [],
      skippedFutureCount,
    };
  }

  // Bulk Pre-fetch for all candidate contracts (sequentially on client to avoid pg deprecation warning)
  const candidateContractIds = contractsRes.rows.map((c) => c.id);
  const candidateApartmentIds = [...new Set(contractsRes.rows.map((c) => c.apartment_id).filter(Boolean))];

  const bulkCspRes = await client.query(
    `SELECT contract_id, service_code, unit_price, effective_from::text AS effective_from_ymd
     FROM contract_service_price
     WHERE contract_id = ANY($1::uuid[])
     ORDER BY effective_from DESC`,
    [candidateContractIds]
  );
  const bulkSubRes = await client.query(
    `SELECT ss.*, sc.code AS service_code, sc.category AS service_category, sc.name AS service_name, sc.unit, sc.billing_type
     FROM service_subscription ss
     JOIN service_catalog sc ON sc.id = ss.service_id
     WHERE ss.contract_id = ANY($1::uuid[])
       AND sc.billing_type != 'METERED'
       AND ss.status IN ('ACTIVE', 'CANCELLATION_PENDING', 'CANCELLED', 'TERMINATED')`,
    [candidateContractIds]
  );
  const bulkDraftsRes = await client.query(
    `SELECT * FROM invoice
     WHERE contract_id = ANY($1::uuid[])
       AND period = $2
       AND COALESCE(invoice_type, 'REGULAR') = 'REGULAR'
       AND status = 'DRAFT'
     FOR UPDATE`,
    [candidateContractIds, targetPeriod]
  );
  const bulkTrackersRes = await client.query(
    `SELECT lft.contract_id, lft.id, lft.accrued_total, lft.carried_to_invoice_id
     FROM late_fee_accrual_tracker lft
     JOIN invoice src_i ON src_i.id = lft.invoice_id AND src_i.status <> 'VOID'
     WHERE lft.contract_id = ANY($1::uuid[])`,
    [candidateContractIds]
  );
  const bulkCreditsRes = await client.query(
    `SELECT DISTINCT contract_id
     FROM credit_balance
     WHERE contract_id = ANY($1::uuid[])
       AND status IN ('AVAILABLE', 'PARTIALLY_APPLIED')
       AND (amount - applied_amount) > 0`,
    [candidateContractIds]
  );
  const bulkActiveMetersRes = await client.query(
    `SELECT m.id, m.apartment_id, m.meter_type, m.meter_code, m.unit, m.unit_price,
            (m.created_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date::text AS created_date_ymd
     FROM meter m
     WHERE m.apartment_id = ANY($1::uuid[])
       AND m.status = 'ACTIVE'
     ORDER BY m.meter_type ASC`,
    [candidateApartmentIds]
  );
  const bulkConfirmedReadingsRes = await client.query(
    `SELECT mr.id, mr.meter_id, mr.apartment_id, mr.contract_id, mr.consumption,
            mr.previous_reading, mr.current_reading, mr.image_url, mr.recorded_at,
            m.meter_type, m.meter_code, m.unit, m.unit_price
     FROM meter_reading mr
     JOIN meter m ON m.id = mr.meter_id
     WHERE mr.apartment_id = ANY($1::uuid[])
       AND mr.period = $2
       AND mr.status = 'CONFIRMED'
       AND m.status = 'ACTIVE'
     ORDER BY m.id, mr.recorded_at DESC`,
    [candidateApartmentIds, targetPeriod]
  );
  const bulkPeriodInvLinesRes = await client.query(
    `SELECT i2.id AS invoice_id, i2.apartment_id, i2.contract_id,
            il2.item_type, (il2.formula_meta->>'reading_id') AS reading_id
     FROM invoice i2
     LEFT JOIN invoice_line il2 ON il2.invoice_id = i2.id AND il2.item_type IN ('ELECTRICITY', 'WATER')
     WHERE i2.apartment_id = ANY($1::uuid[])
       AND i2.period = $2
       AND i2.status NOT IN ('VOID', 'CANCELLED')`,
    [candidateApartmentIds, targetPeriod]
  );

  const cspByContract = new Map();
  for (const row of bulkCspRes.rows) {
    const cid = String(row.contract_id);
    if (!cspByContract.has(cid)) cspByContract.set(cid, []);
    cspByContract.get(cid).push(row);
  }

  const subsByContract = new Map();
  for (const row of bulkSubRes.rows) {
    const cid = String(row.contract_id);
    if (!subsByContract.has(cid)) subsByContract.set(cid, []);
    subsByContract.get(cid).push(row);
  }

  const existingDraftByContract = new Map();
  for (const row of bulkDraftsRes.rows) {
    existingDraftByContract.set(String(row.contract_id), row);
  }

  const trackersByContract = new Map();
  for (const row of bulkTrackersRes.rows) {
    const cid = String(row.contract_id);
    if (!trackersByContract.has(cid)) trackersByContract.set(cid, []);
    trackersByContract.get(cid).push(row);
  }

  const contractsWithAvailableCredits = new Set(
    bulkCreditsRes.rows.map((r) => String(r.contract_id))
  );

  const activeMetersByApt = new Map();
  for (const row of bulkActiveMetersRes.rows) {
    const aid = String(row.apartment_id);
    if (!activeMetersByApt.has(aid)) activeMetersByApt.set(aid, []);
    activeMetersByApt.get(aid).push(row);
  }

  const confirmedReadingsByApt = new Map();
  for (const row of bulkConfirmedReadingsRes.rows) {
    const aid = String(row.apartment_id);
    if (!confirmedReadingsByApt.has(aid)) confirmedReadingsByApt.set(aid, []);
    confirmedReadingsByApt.get(aid).push(row);
  }

  const periodInvLinesByApt = new Map();
  for (const row of bulkPeriodInvLinesRes.rows) {
    const aid = String(row.apartment_id);
    if (!periodInvLinesByApt.has(aid)) periodInvLinesByApt.set(aid, []);
    periodInvLinesByApt.get(aid).push(row);
  }

  // Pre-fetch resident user IDs via adminPool when autoIssue=true
  const residentUserByTenant = new Map();
  if (autoIssue) {
    const tenantIds = [...new Set(contractsRes.rows.map((c) => c.primary_tenant_id).filter(Boolean))];
    if (tenantIds.length > 0) {
      const resUsers = await adminPool.query(
        `SELECT t.id AS tenant_id, au.id AS user_id
         FROM tenant t
         JOIN app_user au ON au.person_id = t.person_id
         WHERE t.id = ANY($1::uuid[])`,
        [tenantIds]
      );
      for (const r of resUsers.rows) {
        residentUserByTenant.set(String(r.tenant_id), r.user_id);
      }
    }
  }

  // Only inspect prior subscription arrears for subscriptions created AFTER their start_date month end
  // (mid-month subscriptions registered after that prior period's invoice was already ISSUED/PAID)
  const subIdsToCheckArrears = [];
  const contractsWithCandidateArrears = new Set();
  for (const [cid, subs] of subsByContract.entries()) {
    const cRow = contractsRes.rows.find((x) => String(x.id) === cid);
    const cStartPeriod = cRow?.start_date ? toDateOnlyYmd(cRow.start_date).slice(0, 7) : '';
    for (const sub of subs) {
      if (!sub || String(sub.billing_type || '').toUpperCase() === 'METERED') continue;
      const startYmd = sub.start_date ? toDateOnlyYmd(sub.start_date) : '';
      if (!startYmd) continue;
      const startPeriod = startYmd.slice(0, 7);
      if (startPeriod >= targetPeriod) continue;
      // Subscriptions starting after contract start month or created after start_date may have unbilled prior periods
      const createdYmd = sub.created_at ? toDateOnlyYmd(sub.created_at) : '';
      if (startPeriod > cStartPeriod || (createdYmd && createdYmd > startYmd)) {
        subIdsToCheckArrears.push(sub.id);
        contractsWithCandidateArrears.add(cid);
      }
    }
  }

  const priorInvoicesByContract = new Map();
  const existingSubLinesByContract = new Map();
  if (contractsWithCandidateArrears.size > 0) {
    const candidateArrearsContractIds = [...contractsWithCandidateArrears];
    const priorInvRes = await client.query(
      `SELECT id, contract_id, period, status
       FROM invoice
       WHERE contract_id = ANY($1::uuid[])
         AND status NOT IN ('VOID', 'CANCELLED', 'DRAFT')
         AND period < $2
       ORDER BY period ASC`,
      [candidateArrearsContractIds, targetPeriod]
    );
    const existingSubLinesRes = await client.query(
      `SELECT il.invoice_id, i.contract_id, i.period AS invoice_period, i.status AS invoice_status,
              il.subscription_id, il.amount, il.formula_meta
       FROM invoice_line il
       JOIN invoice i ON i.id = il.invoice_id
       WHERE il.subscription_id = ANY($1::uuid[])
         AND i.status NOT IN ('VOID', 'CANCELLED')`,
      [subIdsToCheckArrears]
    );

    for (const row of priorInvRes.rows) {
      const cid = String(row.contract_id);
      if (!priorInvoicesByContract.has(cid)) priorInvoicesByContract.set(cid, []);
      priorInvoicesByContract.get(cid).push(row);
    }
    for (const row of existingSubLinesRes.rows) {
      const cid = String(row.contract_id);
      if (!existingSubLinesByContract.has(cid)) existingSubLinesByContract.set(cid, []);
      existingSubLinesByContract.get(cid).push(row);
    }
  }

  const pendingSimpleNewContracts = [];
  const pendingTrackersToUpdate = [];
  const useSingleContractSavepoint = Boolean(contractId);

  for (const c of contractsRes.rows) {
    const cidStr = String(c.id);
    const aidStr = String(c.apartment_id);
    const lines = [];

    // Room transfer cutoff & last active day resolution
    const roomTransferChildStartDate = c.room_transfer_child_start_date
      ? toDateOnlyYmd(c.room_transfer_child_start_date)
      : null;
    const resolvedActive = resolveContractLastActiveDay(c, {
      roomTransferChildStartDate,
      isRoomTransfer: Boolean(roomTransferChildStartDate),
    });
    const effectivePeriodEndYmd =
      resolvedActive.lastActiveDayYmd && resolvedActive.lastActiveDayYmd < monthEnd
        ? resolvedActive.lastActiveDayYmd
        : monthEnd;

    const aptMeters = activeMetersByApt.get(aidStr) || [];
    const aptReadings = confirmedReadingsByApt.get(aidStr) || [];
    const aptInvLines = periodInvLinesByApt.get(aidStr) || [];

    // AC-015.1: Cổng kiểm tra đồng hồ điện/nước đang hoạt động phải có chỉ số CONFIRMED trong kỳ cho đúng đợt hợp đồng
    if (!allowMissingMeterReadings) {
      const missingMeterTypes = [];
      for (const m of aptMeters) {
        if (m.created_date_ymd > effectivePeriodEndYmd) continue;
        const hasValidReading = aptReadings.some((mr) => {
          if (String(mr.meter_id) !== String(m.id)) return false;
          if (mr.contract_id && String(mr.contract_id) === cidStr) return true;
          if (!mr.contract_id) {
            const cons = Number(
              mr.consumption ?? Number(mr.current_reading || 0) - Number(mr.previous_reading || 0)
            );
            const claimedByOtherContract = aptInvLines.some((il) => {
              if (String(il.contract_id) === cidStr) return false;
              if (cons === 0) return true;
              return (
                il.item_type === m.meter_type &&
                (il.reading_id === String(mr.id) || il.reading_id === null)
              );
            });
            return !claimedByOtherContract;
          }
          return false;
        });
        if (!hasValidReading) {
          missingMeterTypes.push(m.meter_type);
        }
      }

      if (missingMeterTypes.length > 0) {
        skippedContracts.push({
          contract_id: c.id,
          contract_code: c.code || c.id,
          apartment_id: c.apartment_id,
          apartment_code: c.apartment_code,
          building_id: c.building_id,
          building_code: c.building_code,
          reason_code: 'MISSING_CONFIRMED_METER_READING',
          missing_meter_types: missingMeterTypes,
          reason: `Thiếu chỉ số đồng hồ đã xác nhận kỳ ${targetPeriod} (${missingMeterTypes.join(', ')}).`,
        });
        continue;
      }
    }

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
    const contractCspRows = (cspByContract.get(cidStr) || []).filter(
      (r) => r.effective_from_ymd <= effectivePeriodEndYmd
    );

    // Điện / Nước từ meter_reading đã xác nhận (CONFIRMED) của đúng đợt hợp đồng kỳ này
    const eligibleReadingsByMeter = new Map();
    for (const mr of aptReadings) {
      const isContractMatch = mr.contract_id && String(mr.contract_id) === cidStr;
      let isNullMatch = false;
      if (!mr.contract_id) {
        const claimedLine = aptInvLines.some(
          (il) =>
            String(il.contract_id) !== cidStr &&
            il.item_type === mr.meter_type &&
            (il.reading_id === String(mr.id) || il.reading_id === null)
        );
        isNullMatch = !claimedLine;
      }
      if (!isContractMatch && !isNullMatch) continue;

      const midStr = String(mr.meter_id);
      const currentBest = eligibleReadingsByMeter.get(midStr);
      if (!currentBest) {
        eligibleReadingsByMeter.set(midStr, mr);
      } else {
        const bestIsExact = currentBest.contract_id && String(currentBest.contract_id) === cidStr;
        if (isContractMatch && !bestIsExact) {
          eligibleReadingsByMeter.set(midStr, mr);
        }
      }
    }

    for (const mr of eligibleReadingsByMeter.values()) {
      const itemType = mr.meter_type === 'ELECTRICITY' ? 'ELECTRICITY' : 'WATER';
      const alreadyBilled = aptInvLines.some(
        (il) =>
          String(il.contract_id) !== cidStr &&
          il.item_type === itemType &&
          (il.reading_id === String(mr.id) || (!mr.contract_id && il.reading_id === null))
      );
      if (alreadyBilled) continue;

      const prevReadNum = Number(mr.previous_reading || 0);
      const currReadNum = Number(mr.current_reading || 0);
      const cons = Number(mr.consumption ?? currReadNum - prevReadNum);
      const { unitPrice: price, priceSource } = resolveUtilityUnitPrice({
        meterType: itemType,
        meterUnitPrice: mr.unit_price,
        contractBuildingId: c.building_id,
        periodEndYmd: effectivePeriodEndYmd,
        contractServicePrices: contractCspRows,
        catalogItems,
      });
      const lineAmt = roundVND(cons * price);
      if (lineAmt > 0) {
        lines.push({
          item_type: itemType,
          description: `${itemType === 'ELECTRICITY' ? 'Tiền điện' : 'Tiền nước'} (${prevReadNum} → ${currReadNum} ${mr.unit})${priceSource === 'CONTRACT_OVERRIDE' ? ' (Giá HĐ)' : ''}`,
          quantity: cons,
          unit: mr.unit,
          unit_price: price,
          amount: lineAmt,
          formula_meta: {
            meter_id: mr.meter_id,
            meter_code: mr.meter_code || null,
            reading_id: mr.id,
            contract_id: c.id,
            meter_type: itemType,
            previous_reading: prevReadNum,
            current_reading: currReadNum,
            consumption: cons,
            unit_price: price,
            amount: lineAmt,
            price_source: priceSource,
            image_url: mr.image_url || null,
          },
        });
      }
    }

    // Dịch vụ tiện ích (service_subscription)
    const contractSubs = subsByContract.get(cidStr) || [];
    for (const sub of contractSubs) {
      const subCharge = computeSubscriptionPeriodCharge({
        subscription: sub,
        periodYm: targetPeriod,
        boundEndYmd: effectivePeriodEndYmd,
        contractBuildingId: c.building_id,
        contractServicePrices: contractCspRows,
        catalogItems,
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

    // Carry-forward arrears for mid-month subscriptions registered after prior period's invoice was already ISSUED/PAID (Phương án A)
    const priorInvoices = priorInvoicesByContract.get(cidStr) || [];
    if (priorInvoices.length > 0 && contractSubs.length > 0) {
      const existingSubLines = existingSubLinesByContract.get(cidStr) || [];
      for (const sub of contractSubs) {
        if (!sub || String(sub.billing_type || '').toUpperCase() === 'METERED') continue;
        const startYmd = sub.start_date ? toDateOnlyYmd(sub.start_date) : '';
        if (!startYmd) continue;
        const startPeriod = startYmd.slice(0, 7);
        if (startPeriod >= targetPeriod) continue;

        for (const priorInv of priorInvoices) {
          if (priorInv.period < startPeriod) continue;
          const billedOnPriorInv = existingSubLines.some(
            (l) =>
              String(l.invoice_id) === String(priorInv.id) &&
              String(l.subscription_id) === String(sub.id) &&
              !Boolean(l.formula_meta?.carry_forward_arrears)
          );
          if (billedOnPriorInv) continue;

          const alreadyCarriedForward = existingSubLines.some(
            (l) =>
              String(l.subscription_id) === String(sub.id) &&
              l.invoice_period !== targetPeriod &&
              Boolean(l.formula_meta?.carry_forward_arrears) &&
              l.formula_meta?.arrears_for_period === priorInv.period
          );
          if (alreadyCarriedForward) continue;

          const arrearsCharge = computeSubscriptionPeriodCharge({
            subscription: sub,
            periodYm: priorInv.period,
            contractBuildingId: c.building_id,
            contractServicePrices: contractCspRows,
            catalogItems,
          });

          if (arrearsCharge.amount > 0) {
            lines.push({
              item_type: 'SERVICE',
              description: `Truy thu kỳ ${priorInv.period}: ${arrearsCharge.description}`,
              quantity: arrearsCharge.quantity,
              unit: sub.unit || 'tháng',
              unit_price: arrearsCharge.unitPrice,
              amount: arrearsCharge.amount,
              subscription_id: sub.id,
              formula_meta: {
                ...arrearsCharge.formulaMeta,
                carry_forward_arrears: true,
                arrears_for_period: priorInv.period,
                source_period_invoice_id: priorInv.id,
              },
            });
          }
        }
      }
    }

    // Existing DRAFT lookup (trước khi tổng hợp dòng để bảo toàn carry-forward LATE_FEE khi làm mới DRAFT)
    const existingDraft = existingDraftByContract.get(cidStr) || null;

    // Carry-forward: inject pending late fee accruals from prior overdue invoices of this contract (FR-064)
    const eligibleTrackers = (trackersByContract.get(cidStr) || []).filter(
      (t) =>
        !t.carried_to_invoice_id ||
        (existingDraft && String(t.carried_to_invoice_id) === String(existingDraft.id))
    );
    const totalAccrual = roundVND(
      eligibleTrackers.reduce((s, t) => s + Number(t.accrued_total || 0), 0)
    );
    const trackerIdsToCarry =
      totalAccrual > 0 ? eligibleTrackers.map((t) => t.id) : [];
    if (totalAccrual > 0 && trackerIdsToCarry.length > 0) {
      lines.push({
        item_type: 'LATE_FEE',
        description: 'Phí phạt chậm thanh toán kỳ trước (dồn sang kỳ này)',
        quantity: 1,
        unit: 'kỳ',
        unit_price: totalAccrual,
        amount: totalAccrual,
        formula_meta: {
          carry_forward: true,
          source_tracker_ids: trackerIdsToCarry,
        },
      });
    }

    const grossSubtotal = roundVND(lines.reduce((s, l) => s + Number(l.amount || 0), 0));

    // Billable check: AC-015.1
    if (lines.length === 0 || grossSubtotal <= 0) {
      skippedContracts.push({
        contract_id: c.id,
        contract_code: c.code || c.id,
        apartment_code: c.apartment_code,
        reason_code: 'ZERO_BILLABLE_AMOUNT',
        reason: 'Không có khoản phí nào phát sinh trong kỳ.',
      });
      continue;
    }

    // Existing DRAFT in-place refresh
    if (existingDraft) {
      await releaseInvoiceCreditsInTx(client, { invoiceId: existingDraft.id, actorId });

      await client.query(
        `DELETE FROM invoice_line
         WHERE invoice_id = $1
           AND item_type <> 'ADJUSTMENT'
           AND credit_id IS NULL`,
        [existingDraft.id]
      );

      await batchInsertInvoiceLinesInTx(client, existingDraft.id, lines);

      if (trackerIdsToCarry.length > 0) {
        await client.query(
          `UPDATE late_fee_accrual_tracker
           SET carried_to_invoice_id = $1,
               carried_at = COALESCE(carried_at, NOW()),
               updated_at = NOW()
           WHERE id = ANY($2::uuid[])`,
          [existingDraft.id, trackerIdsToCarry]
        );
      }

      const recalc = await recalculateDraftInvoiceTotalsInTx(client, { invoiceId: existingDraft.id, actorId });
      let finalDraftInv = recalc.invoice;

      if (contractsWithAvailableCredits.has(cidStr) || Number(existingDraft.credit_offset_amount || 0) > 0) {
        const creditRes = await applyAvailableCreditsInTx(client, {
          contractId: c.id,
          invoiceId: existingDraft.id,
          subtotalAmount: grossSubtotal,
          actorId,
        });
        if (creditRes.totalCreditUsed > 0) {
          const refreshedInv = await client.query('SELECT * FROM invoice WHERE id = $1', [existingDraft.id]);
          finalDraftInv = refreshedInv.rows[0];
        }
      }

      createdInvoices.push(finalDraftInv);
      updatedDraftCount++;
      continue;
    }

    // Create new DRAFT invoice
    const dueDays =
      c.payment_due_days !== undefined && c.payment_due_days !== null
        ? Math.max(0, Math.round(Number(c.payment_due_days)))
        : defaultDueOffsetDays;
    const dueDateStr = dueDate || addDaysYmd(effectiveIssueDateYmd, dueDays);

    const randSuffix = Math.floor(1000 + Math.random() * 9000);
    const invCode = `INV-${targetPeriod.replace('-', '')}-${c.building_code}-${c.apartment_code}-${randSuffix}`;

    const hasCreditsOrTrackers =
      contractsWithAvailableCredits.has(cidStr) || trackerIdsToCarry.length > 0;
    const canDeferBatchWrites = !useSingleContractSavepoint && !hasCreditsOrTrackers;

    if (canDeferBatchWrites) {
      pendingSimpleNewContracts.push({
        contract: c,
        cidStr,
        aidStr,
        invCode,
        dueDateStr,
        grossSubtotal,
        lines,
      });

      // Update in-memory periodInvLinesByApt so same-apartment turnover contracts in the same batch see newly billed readings
      for (const l of lines) {
        if (l.item_type === 'ELECTRICITY' || l.item_type === 'WATER') {
          if (!periodInvLinesByApt.has(aidStr)) periodInvLinesByApt.set(aidStr, []);
          periodInvLinesByApt.get(aidStr).push({
            invoice_id: null,
            apartment_id: c.apartment_id,
            contract_id: c.id,
            item_type: l.item_type,
            reading_id: l.formula_meta?.reading_id ? String(l.formula_meta.reading_id) : null,
          });
        }
      }
      continue;
    }

    let inv;
    await client.query('SAVEPOINT sp_gen_inv');
    try {
      const invIns = await client.query(
        `INSERT INTO invoice (
           org_id, building_id, apartment_id, contract_id, tenant_id,
           invoice_code, period, issue_date, due_date,
           subtotal_amount, adjustment_amount, total_amount, paid_amount,
           status, created_by
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::date, $9::date, $10, 0, $10, 0, 'DRAFT', $11)
         RETURNING *`,
        [
          orgId,
          c.building_id,
          c.apartment_id,
          c.id,
          c.primary_tenant_id,
          invCode,
          targetPeriod,
          effectiveIssueDateYmd,
          dueDateStr,
          grossSubtotal,
          actorId,
        ]
      );
      inv = invIns.rows[0];

      await batchInsertInvoiceLinesInTx(client, inv.id, lines);

      if (trackerIdsToCarry.length > 0) {
        await client.query(
          `UPDATE late_fee_accrual_tracker
           SET carried_to_invoice_id = $1,
               carried_at = NOW(),
               updated_at = NOW()
           WHERE id = ANY($2::uuid[])`,
          [inv.id, trackerIdsToCarry]
        );
      }

      // Apply FIFO credit balance only when contract has available credits
      if (contractsWithAvailableCredits.has(cidStr)) {
        const creditRes = await applyAvailableCreditsInTx(client, {
          contractId: c.id,
          invoiceId: inv.id,
          subtotalAmount: grossSubtotal,
          actorId,
        });
        if (creditRes.totalCreditUsed > 0) {
          const refreshedNewInv = await client.query('SELECT * FROM invoice WHERE id = $1', [inv.id]);
          inv = refreshedNewInv.rows[0];
        }
      }

      if (autoIssue) {
        inv = await issueDraftInvoiceInTx(client, {
          invoiceId: inv.id,
          actorId,
          dueDate: dueDateStr,
          prefetchedInvoice: inv,
          skipReceivableExistenceCheck: true,
          residentUserId: c.primary_tenant_id
            ? residentUserByTenant.get(String(c.primary_tenant_id)) || null
            : null,
        });
      }

      await client.query(
        `INSERT INTO audit_log (actor_id, action, entity, entity_id, after)
         VALUES ($1, 'CREATE_INVOICE', 'invoice', $2, $3)`,
        [actorId, inv.id, JSON.stringify(inv)]
      );

      await client.query('RELEASE SAVEPOINT sp_gen_inv');
      createdInvoices.push(inv);

      // Update in-memory periodInvLinesByApt so same-apartment turnover contracts in the same batch see newly billed readings
      for (const l of lines) {
        if (l.item_type === 'ELECTRICITY' || l.item_type === 'WATER') {
          if (!periodInvLinesByApt.has(aidStr)) periodInvLinesByApt.set(aidStr, []);
          periodInvLinesByApt.get(aidStr).push({
            invoice_id: inv.id,
            apartment_id: c.apartment_id,
            contract_id: c.id,
            item_type: l.item_type,
            reading_id: l.formula_meta?.reading_id ? String(l.formula_meta.reading_id) : null,
          });
        }
      }
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

  // Flush all deferred simple new invoices, lines, receivables, notifications, and audit logs in bulk UNNEST queries!
  if (pendingSimpleNewContracts.length > 0) {
    const bulkInitialStatuses = pendingSimpleNewContracts.map((item) =>
      autoIssue ? (item.grossSubtotal === 0 ? 'PAID' : 'ISSUED') : 'DRAFT'
    );
    const bulkInvRes = await client.query(
      `INSERT INTO invoice (
         org_id, building_id, apartment_id, contract_id, tenant_id,
         invoice_code, period, issue_date, due_date,
         subtotal_amount, adjustment_amount, total_amount, paid_amount,
         status, created_by, issued_by, issued_at
       )
       SELECT
         $1::uuid,
         u.building_id,
         u.apartment_id,
         u.contract_id,
         u.tenant_id,
         u.invoice_code,
         $2::text,
         $3::date,
         u.due_date,
         u.subtotal_amount,
         0,
         u.subtotal_amount,
         0,
         u.status,
         $4::uuid,
         CASE WHEN u.status IN ('ISSUED', 'PAID') THEN $4::uuid ELSE NULL END,
         CASE WHEN u.status IN ('ISSUED', 'PAID') THEN NOW() ELSE NULL END
       FROM UNNEST(
         $5::uuid[], $6::uuid[], $7::uuid[], $8::uuid[],
         $9::text[], $10::date[], $11::bigint[], $12::text[]
       ) AS u(building_id, apartment_id, contract_id, tenant_id, invoice_code, due_date, subtotal_amount, status)
       RETURNING *`,
      [
        orgId,
        targetPeriod,
        effectiveIssueDateYmd,
        actorId,
        pendingSimpleNewContracts.map((x) => x.contract.building_id),
        pendingSimpleNewContracts.map((x) => x.contract.apartment_id),
        pendingSimpleNewContracts.map((x) => x.contract.id),
        pendingSimpleNewContracts.map((x) => x.contract.primary_tenant_id),
        pendingSimpleNewContracts.map((x) => x.invCode),
        pendingSimpleNewContracts.map((x) => x.dueDateStr),
        pendingSimpleNewContracts.map((x) => x.grossSubtotal),
        bulkInitialStatuses,
      ]
    );

    const insertedByContractId = new Map(
      bulkInvRes.rows.map((invRow) => [String(invRow.contract_id), invRow])
    );

    const pendingLinesToInsert = [];
    const pendingReceivablesToInsert = [];
    const pendingNotificationsToInsert = [];
    const pendingAuditLogsToInsert = [];

    for (const item of pendingSimpleNewContracts) {
      const inv = insertedByContractId.get(item.cidStr);
      if (!inv) continue;
      createdInvoices.push(inv);

      for (const l of item.lines) {
        pendingLinesToInsert.push({
          invoice_id: inv.id,
          item_type: l.item_type,
          description: l.description,
          quantity: Number(l.quantity ?? 1),
          unit: l.unit || 'lần',
          unit_price: Math.round(Number(l.unit_price || 0)),
          amount: Math.round(Number(l.amount || 0)),
          subscription_id: l.subscription_id || null,
          formula_meta: JSON.stringify(l.formula_meta || {}),
        });
      }

      if (autoIssue) {
        const totalAmount = Number(inv.total_amount || 0);
        const periodLabel = inv.period ? `kỳ ${inv.period}` : 'tất toán phí phạt';
        if (totalAmount > 0) {
          pendingReceivablesToInsert.push({
            org_id: inv.org_id,
            building_id: inv.building_id,
            contract_id: inv.contract_id,
            tenant_id: inv.tenant_id,
            invoice_id: inv.id,
            amount: totalAmount,
            due_date: item.dueDateStr,
            description: `Công nợ hóa đơn ${inv.invoice_code} ${periodLabel}`,
          });

          const targetUserId = item.contract.primary_tenant_id
            ? residentUserByTenant.get(String(item.contract.primary_tenant_id)) || null
            : null;
          if (targetUserId) {
            pendingNotificationsToInsert.push({
              org_id: inv.org_id,
              user_id: targetUserId,
              title: `Phát hành hóa đơn ${inv.invoice_code}`,
              content: `Hóa đơn ${periodLabel} với tổng số tiền ${totalAmount.toLocaleString('vi-VN')} ₫ đã được phát hành.`,
              payload: JSON.stringify({
                invoice_id: inv.id,
                invoice_code: inv.invoice_code,
                contract_id: inv.contract_id,
                building_id: inv.building_id,
                apartment_id: inv.apartment_id,
              }),
            });
          }
        }

        const draftSnapshot = { ...inv, status: 'DRAFT', issued_by: null, issued_at: null };
        pendingAuditLogsToInsert.push({
          actor_id: actorId,
          action: 'UPDATE_INVOICE_STATUS',
          entity: 'invoice',
          entity_id: inv.id,
          before: JSON.stringify(draftSnapshot),
          after: JSON.stringify(inv),
        });
      }

      pendingAuditLogsToInsert.push({
        actor_id: actorId,
        action: 'CREATE_INVOICE',
        entity: 'invoice',
        entity_id: inv.id,
        before: null,
        after: JSON.stringify(inv),
      });
    }

    if (pendingLinesToInsert.length > 0) {
      await client.query(
        `INSERT INTO invoice_line (
           invoice_id, item_type, description, quantity, unit, unit_price, amount, subscription_id, formula_meta
         )
         SELECT * FROM UNNEST(
           $1::uuid[], $2::text[], $3::text[], $4::numeric[], $5::text[],
           $6::bigint[], $7::bigint[], $8::uuid[], $9::jsonb[]
         )`,
        [
          pendingLinesToInsert.map((x) => x.invoice_id),
          pendingLinesToInsert.map((x) => x.item_type),
          pendingLinesToInsert.map((x) => x.description),
          pendingLinesToInsert.map((x) => x.quantity),
          pendingLinesToInsert.map((x) => x.unit),
          pendingLinesToInsert.map((x) => x.unit_price),
          pendingLinesToInsert.map((x) => x.amount),
          pendingLinesToInsert.map((x) => x.subscription_id),
          pendingLinesToInsert.map((x) => x.formula_meta),
        ]
      );
    }

    if (pendingReceivablesToInsert.length > 0) {
      await client.query(
        `INSERT INTO receivable (
           org_id, building_id, contract_id, tenant_id, invoice_id, type, amount, paid_amount, due_date, status, description
         )
         SELECT
           u.org_id, u.building_id, u.contract_id, u.tenant_id, u.invoice_id,
           'INVOICE_DEBT', u.amount, 0, u.due_date, 'OPEN', u.description
         FROM UNNEST(
           $1::uuid[], $2::uuid[], $3::uuid[], $4::uuid[], $5::uuid[],
           $6::bigint[], $7::date[], $8::text[]
         ) AS u(org_id, building_id, contract_id, tenant_id, invoice_id, amount, due_date, description)`,
        [
          pendingReceivablesToInsert.map((x) => x.org_id),
          pendingReceivablesToInsert.map((x) => x.building_id),
          pendingReceivablesToInsert.map((x) => x.contract_id),
          pendingReceivablesToInsert.map((x) => x.tenant_id),
          pendingReceivablesToInsert.map((x) => x.invoice_id),
          pendingReceivablesToInsert.map((x) => x.amount),
          pendingReceivablesToInsert.map((x) => x.due_date),
          pendingReceivablesToInsert.map((x) => x.description),
        ]
      );
    }

    if (pendingNotificationsToInsert.length > 0) {
      await adminPool.query(
        `INSERT INTO notification (org_id, user_id, title, content, type, payload)
         SELECT u.org_id, u.user_id, u.title, u.content, 'INVOICE_ISSUED', u.payload
         FROM UNNEST(
           $1::uuid[], $2::uuid[], $3::text[], $4::text[], $5::jsonb[]
         ) AS u(org_id, user_id, title, content, payload)`,
        [
          pendingNotificationsToInsert.map((x) => x.org_id),
          pendingNotificationsToInsert.map((x) => x.user_id),
          pendingNotificationsToInsert.map((x) => x.title),
          pendingNotificationsToInsert.map((x) => x.content),
          pendingNotificationsToInsert.map((x) => x.payload),
        ]
      );
    }

    if (pendingAuditLogsToInsert.length > 0) {
      await client.query(
        `INSERT INTO audit_log (actor_id, action, entity, entity_id, before, after)
         SELECT * FROM UNNEST(
           $1::uuid[], $2::text[], $3::text[], $4::uuid[], $5::jsonb[], $6::jsonb[]
         )`,
        [
          pendingAuditLogsToInsert.map((x) => x.actor_id),
          pendingAuditLogsToInsert.map((x) => x.action),
          pendingAuditLogsToInsert.map((x) => x.entity),
          pendingAuditLogsToInsert.map((x) => x.entity_id),
          pendingAuditLogsToInsert.map((x) => x.before),
          pendingAuditLogsToInsert.map((x) => x.after),
        ]
      );
    }
  }

  return {
    created_count: createdInvoices.length,
    updated_draft_count: updatedDraftCount,
    updatedDraftCount,
    skipped_contracts: skippedContracts,
    skippedContracts,
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
        sql += ` AND COALESCE(i.period, to_char(COALESCE(i.issue_date::timestamp, i.created_at), 'YYYY-MM')) = $${params.length}`;
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

      sql += ` ORDER BY COALESCE(i.period, to_char(COALESCE(i.issue_date::timestamp, i.created_at), 'YYYY-MM')) DESC, i.created_at DESC`;

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
    const { building_id, contract_id, period, auto_issue = false, allow_missing_meter_readings = false } = req.body;
    const orgId = req.user.org_id;
    const targetPeriod = period && PERIOD_RE.test(period) ? period : currentVietnamPeriod();

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
          allowMissingMeterReadings: Boolean(allow_missing_meter_readings),
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
    if (String(item_type || '').toUpperCase() === 'LATE_FEE') {
      return res.status(409).json({
        code: 'LATE_FEE_LINE_READONLY',
        message: 'Phí phạt chậm thanh toán do hệ thống tự động tính và chỉ được miễn giảm qua phê duyệt 4 mắt.',
      });
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
      if (line.item_type === 'LATE_FEE' || String(item_type || '').toUpperCase() === 'LATE_FEE') {
        await client.query('ROLLBACK');
        return res.status(409).json({
          code: 'LATE_FEE_LINE_READONLY',
          message: 'Không thể chỉnh sửa trực tiếp dòng phí phạt chậm thanh toán; vui lòng phát hành hóa đơn và tạo đề nghị miễn giảm 4 mắt.',
        });
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
      if (line.item_type === 'LATE_FEE') {
        await client.query('ROLLBACK');
        return res.status(409).json({
          code: 'LATE_FEE_LINE_READONLY',
          message: 'Không thể xóa trực tiếp dòng phí phạt chậm thanh toán; vui lòng phát hành hóa đơn và tạo đề nghị miễn giảm 4 mắt.',
        });
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
          await client.query('SELECT fn_sync_late_fee_trackers_on_invoice_void($1)', [id]);

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

      try {
        const adjMeta = await adminPool.query(
          `SELECT ia.org_id, ia.building_id, ia.invoice_id, ia.created_by, i.invoice_code, i.contract_id
           FROM invoice_adjustment ia
           JOIN invoice i ON i.id = ia.invoice_id
           WHERE ia.id = $1
           LIMIT 1`,
          [adjId]
        );
        const row = adjMeta.rows[0];
        if (row && row.created_by && row.created_by !== req.user.sub) {
          await notifyUser(row.org_id, row.created_by, {
            title: `Đã phê duyệt điều chỉnh hóa đơn ${row.invoice_code}`,
            content: `Đề nghị điều chỉnh hóa đơn ${row.invoice_code} của bạn đã được phê duyệt.`,
            type: 'INVOICE_ADJUSTED',
            payload: {
              invoice_id: row.invoice_id,
              adjustment_id: adjId,
              contract_id: row.contract_id,
              building_id: row.building_id,
            },
          });
        }
      } catch (notifErr) {
        console.error('[Approve Adjustment Notification Warning]:', notifErr);
      }

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

      try {
        const adjMeta = await adminPool.query(
          `SELECT ia.org_id, ia.building_id, ia.invoice_id, ia.created_by, i.invoice_code, i.contract_id
           FROM invoice_adjustment ia
           JOIN invoice i ON i.id = ia.invoice_id
           WHERE ia.id = $1
           LIMIT 1`,
          [adjId]
        );
        const row = adjMeta.rows[0];
        if (row && row.created_by && row.created_by !== req.user.sub) {
          await notifyUser(row.org_id, row.created_by, {
            title: `Từ chối điều chỉnh hóa đơn ${row.invoice_code}`,
            content: `Đề nghị điều chỉnh hóa đơn ${row.invoice_code} của bạn đã bị từ chối. Lý do: ${reason.trim()}`,
            type: 'INVOICE_ADJUSTED',
            payload: {
              invoice_id: row.invoice_id,
              adjustment_id: adjId,
              contract_id: row.contract_id,
              building_id: row.building_id,
              decision: 'REJECTED',
            },
          });
        }
      } catch (notifErr) {
        console.error('[Reject Adjustment Notification Warning]:', notifErr);
      }

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
