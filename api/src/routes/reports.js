import express from 'express';
import { pool, getUserClient } from '../db/client.js';
import { authenticateToken } from '../middleware/auth.js';
import { requireRole } from '../middleware/rbac.js';
import {
  scopedBuildingFilter,
  checkBuildingAccess,
} from '../services/ownerScope.js';
import { getTodayVnDateStr } from '../services/depositSettlement.js';
import { toUtf8BomCsv, toXlsxBuffer } from '../utils/csv.js';

const router = express.Router();

function buildLast12MonthsPeriods() {
  const periods = [];
  const now = new Date();
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    periods.push(`${yyyy}-${mm}`);
  }
  return periods;
}

/**
 * GET /api/v1/reports/dashboard
 * Tổng hợp KPI Dashboard + Biểu đồ doanh thu 12 tháng (AC-018) + Tỷ lệ trạng thái căn hộ + HĐ sắp hết hạn + Báo hỏng mới
 * + 5 KPI cảnh báo Sổ cọc & Giữ chỗ chờ xác nhận (GAP-05)
 */
router.get(
  '/dashboard',
  authenticateToken,
  requireRole(['SYS_ADMIN', 'OWNER', 'MANAGER']),
  async (req, res) => {
    const { building_id } = req.query;
    const orgId = req.user.org_id;

    const { client, release } = await getUserClient(req);
    try {
      if (building_id) {
        const ok = await checkBuildingAccess(req, building_id, 'report');
        if (!ok) {
          return res.status(403).json({ code: 'ACCESS_DENIED', message: 'Bạn không có quyền xem dữ liệu tòa nhà này.' });
        }
      }

      const currentPeriod = new Date().toISOString().slice(0, 7);
      const periods12 = buildLast12MonthsPeriods();

      // 1. Thống kê căn hộ theo trạng thái
      const aptParams = [orgId];
      const { sql: aptScope } = await scopedBuildingFilter(req, 'a.building_id', aptParams);
      let aptFilter = '';
      if (building_id) {
        aptParams.push(building_id);
        aptFilter = ` AND a.building_id = $${aptParams.length}`;
      }
      const aptStatsRes = await client.query(
        `SELECT a.status, COUNT(*)::int AS count
         FROM apartment a
         JOIN building b ON b.id = a.building_id
         WHERE b.org_id = $1 ${aptScope} ${aptFilter}
         GROUP BY a.status`,
        aptParams
      );

      const statusCounts = {
        AVAILABLE: 0,
        OCCUPIED: 0,
        RESERVED: 0,
        MAINTENANCE: 0,
        BLOCKED: 0,
        INACTIVE: 0,
      };
      let totalApts = 0;
      for (const row of aptStatsRes.rows) {
        statusCounts[row.status] = row.count;
        if (row.status !== 'INACTIVE') totalApts += row.count;
      }
      const occupancyRate = totalApts > 0 ? Number(((statusCounts.OCCUPIED / totalApts) * 100).toFixed(1)) : 0;

      // 2. Doanh thu 12 tháng từ bảng invoice (AC-018)
      const revParams = [orgId, periods12];
      const { sql: revScope } = await scopedBuildingFilter(req, 'i.building_id', revParams);
      let revFilter = '';
      if (building_id) {
        revParams.push(building_id);
        revFilter = ` AND i.building_id = $${revParams.length}`;
      }
      const revRes = await client.query(
        `SELECT i.period,
                COALESCE(SUM(i.total_amount + COALESCE(i.credit_offset_amount, 0)) FILTER (WHERE i.status NOT IN ('CANCELLED', 'DRAFT', 'VOID')), 0)::bigint AS billed,
                COALESCE(SUM(i.paid_amount) FILTER (WHERE i.status NOT IN ('CANCELLED', 'DRAFT', 'VOID')), 0)::bigint AS inv_paid,
                COALESCE(SUM(i.paid_amount + COALESCE(i.credit_offset_amount, 0)) FILTER (WHERE i.status NOT IN ('CANCELLED', 'DRAFT', 'VOID')), 0)::bigint AS invoice_settled
         FROM invoice i
         WHERE i.org_id = $1
           AND i.period = ANY($2::text[])
           ${revScope} ${revFilter}
         GROUP BY i.period`,
        revParams
      );

      // Thu thực tế từ bảng payment (CONFIRMED) trừ hoàn tiền cọc/hoàn trực tiếp từ credit_balance trong kỳ (RP-08)
      const pmtParams = [orgId, periods12];
      const { sql: pmtScope } = await scopedBuildingFilter(req, 'p.building_id', pmtParams);
      let pmtFilter = '';
      if (building_id) {
        pmtParams.push(building_id);
        pmtFilter = ` AND p.building_id = $${pmtParams.length}`;
      }
      const pmtRes = await client.query(
        `SELECT to_char(COALESCE(p.paid_at AT TIME ZONE 'Asia/Ho_Chi_Minh', p.created_at AT TIME ZONE 'Asia/Ho_Chi_Minh'), 'YYYY-MM') AS period,
                COALESCE(SUM(p.amount), 0)::bigint AS collected_gross
         FROM payment p
         WHERE p.org_id = $1
           AND p.status = 'CONFIRMED'
           AND to_char(COALESCE(p.paid_at AT TIME ZONE 'Asia/Ho_Chi_Minh', p.created_at AT TIME ZONE 'Asia/Ho_Chi_Minh'), 'YYYY-MM') = ANY($2::text[])
           ${pmtScope} ${pmtFilter}
         GROUP BY 1`,
        pmtParams
      );
      const pmtMap = new Map(pmtRes.rows.map((r) => [r.period, Number(r.collected_gross || 0)]));

      // Hoàn tiền trực tiếp hoặc qua quyết toán cọc từ credit_balance trong kỳ
      const refParams = [orgId, periods12];
      const { sql: refScope } = await scopedBuildingFilter(req, 'cb.building_id', refParams);
      let refFilter = '';
      if (building_id) {
        refParams.push(building_id);
        refFilter = ` AND cb.building_id = $${refParams.length}`;
      }
      const refRes = await client.query(
        `SELECT to_char(cb.refunded_at AT TIME ZONE 'Asia/Ho_Chi_Minh', 'YYYY-MM') AS period,
                COALESCE(SUM(
                  CASE WHEN cb.status = 'REFUNDED_DIRECT' THEN cb.amount
                       WHEN cb.status = 'REFUNDED_IN_SETTLEMENT' THEN cb.settlement_refund_amount
                       ELSE 0 END
                ), 0)::bigint AS refunded_amount
         FROM credit_balance cb
         WHERE cb.org_id = $1
           AND cb.refunded_at IS NOT NULL
           AND cb.status IN ('REFUNDED_DIRECT', 'REFUNDED_IN_SETTLEMENT')
           AND to_char(cb.refunded_at AT TIME ZONE 'Asia/Ho_Chi_Minh', 'YYYY-MM') = ANY($2::text[])
           ${refScope} ${refFilter}
         GROUP BY 1`,
        refParams
      );
      const refMap = new Map(refRes.rows.map((r) => [r.period, Number(r.refunded_amount || 0)]));

      const revMap = new Map();
      for (const r of revRes.rows) {
        const periodPmt = pmtMap.has(r.period) ? pmtMap.get(r.period) : Number(r.inv_paid || 0);
        const periodRef = refMap.get(r.period) || 0;
        const netCollected = Math.max(0, periodPmt - periodRef);
        revMap.set(r.period, {
          period: r.period,
          billed: Number(r.billed || 0),
          collected: netCollected,
          invoice_settled: Number(r.invoice_settled || 0),
        });
      }
      const revenue12m = periods12.map((p) => {
        if (revMap.has(p)) return revMap.get(p);
        const periodPmt = pmtMap.get(p) || 0;
        const periodRef = refMap.get(p) || 0;
        return {
          period: p,
          billed: 0,
          collected: Math.max(0, periodPmt - periodRef),
          invoice_settled: 0,
        };
      });
      const currentMonthRev = revenue12m[revenue12m.length - 1] || { billed: 0, collected: 0 };
      const prevMonthRev = revenue12m[revenue12m.length - 2] || { billed: 0, collected: 0 };
      const revenueGrowthPct = prevMonthRev.collected > 0
        ? Number((((currentMonthRev.collected - prevMonthRev.collected) / prevMonthRev.collected) * 100).toFixed(1))
        : 0;

      // 3. Tổng công nợ chưa thu
      const debtParams = [orgId];
      const { sql: debtScope } = await scopedBuildingFilter(req, 'r.building_id', debtParams);
      let debtFilter = '';
      if (building_id) {
        debtParams.push(building_id);
        debtFilter = ` AND r.building_id = $${debtParams.length}`;
      }
      const debtRes = await client.query(
        `SELECT COALESCE(SUM(r.amount - r.paid_amount), 0)::bigint AS unpaid_debt
         FROM receivable r
         WHERE r.org_id = $1
           AND r.status IN ('OPEN', 'PARTIALLY_PAID')
           ${debtScope} ${debtFilter}`,
        debtParams
      );
      const unpaidDebt = Number(debtRes.rows[0]?.unpaid_debt || 0);

      // 4. Yêu cầu đang chờ xử lý + 5 yêu cầu gần nhất
      const srParams = [orgId];
      const { sql: srScope } = await scopedBuildingFilter(req, 'sr.building_id', srParams);
      let srFilter = '';
      if (building_id) {
        srParams.push(building_id);
        srFilter = ` AND sr.building_id = $${srParams.length}`;
      }
      const [srCountRes, srRecentRes] = await Promise.all([
        client.query(
          `SELECT COUNT(*)::int AS pending_count
           FROM service_request sr
           WHERE sr.org_id = $1
             AND sr.status IN ('NEW', 'ASSIGNED', 'IN_PROGRESS')
             ${srScope} ${srFilter}`,
          srParams
        ),
        client.query(
          `SELECT sr.id, sr.tracking_code, sr.title, sr.category, sr.priority, sr.status, sr.created_at,
                  a.code AS apartment_code, b.name AS building_name, b.code AS building_code
           FROM service_request sr
           JOIN apartment a ON a.id = sr.apartment_id
           JOIN building b ON b.id = sr.building_id
           WHERE sr.org_id = $1 ${srScope} ${srFilter}
           ORDER BY sr.created_at DESC
           LIMIT 5`,
          srParams
        ),
      ]);

      // 5. Hợp đồng sắp hết hạn trong 30-45 ngày tới
      const expParams = [orgId];
      const { sql: expScope } = await scopedBuildingFilter(req, 'c.building_id', expParams);
      let expFilter = '';
      if (building_id) {
        expParams.push(building_id);
        expFilter = ` AND c.building_id = $${expParams.length}`;
      }
      const expRes = await client.query(
        `SELECT c.id, c.end_date, c.rent_amount,
                (c.end_date - CURRENT_DATE)::int AS days_left,
                a.code AS apartment_code,
                b.name AS building_name,
                b.code AS building_code,
                p.full_name AS tenant_name,
                p.phone AS tenant_phone
         FROM contract c
         JOIN apartment a ON a.id = c.apartment_id
         JOIN building b ON b.id = c.building_id
         JOIN tenant t ON t.id = c.primary_tenant_id
         JOIN person p ON p.id = t.person_id
         WHERE b.org_id = $1
           AND c.status = 'ACTIVE'
           AND c.end_date BETWEEN CURRENT_DATE AND (CURRENT_DATE + INTERVAL '45 days')
           ${expScope} ${expFilter}
         ORDER BY c.end_date ASC
         LIMIT 8`,
        expParams
      );

      // 6. KPI cảnh báo Sổ cọc & Giữ chỗ chờ xác nhận (GAP-05)
      const depKpiParams = [orgId, getTodayVnDateStr()];
      const { sql: depKpiScope } = await scopedBuildingFilter(req, 'c.building_id', depKpiParams);
      let depKpiFilter = '';
      if (building_id) {
        depKpiParams.push(building_id);
        depKpiFilter = ` AND c.building_id = $${depKpiParams.length}`;
      }
      const rsvKpiParams = [orgId];
      const { sql: rsvKpiScope } = await scopedBuildingFilter(req, 'r.building_id', rsvKpiParams);
      let rsvKpiFilter = '';
      if (building_id) {
        rsvKpiParams.push(building_id);
        rsvKpiFilter = ` AND r.building_id = $${rsvKpiParams.length}`;
      }

      const adjKpiParams = [orgId];
      const { sql: adjKpiScope } = await scopedBuildingFilter(req, 'i.building_id', adjKpiParams);
      let adjKpiFilter = '';
      if (building_id) {
        adjKpiParams.push(building_id);
        adjKpiFilter = ` AND i.building_id = $${adjKpiParams.length}`;
      }

      const cbKpiParams = [orgId];
      const { sql: cbKpiScope } = await scopedBuildingFilter(req, 'cb.building_id', cbKpiParams);
      let cbKpiFilter = '';
      if (building_id) {
        cbKpiParams.push(building_id);
        cbKpiFilter = ` AND cb.building_id = $${cbKpiParams.length}`;
      }

      const [depKpiRes, rsvKpiRes, adjKpiRes, cbKpiRes] = await Promise.all([
        client.query(
          `SELECT
             COUNT(*) FILTER (WHERE d.status = 'PENDING_APPROVAL')::int AS pending_deposit_approvals,
             COUNT(*) FILTER (WHERE d.status IN ('APPROVED_PENDING_PAYOUT', 'RETURNED'))::int AS pending_deposit_payouts,
             COUNT(*) FILTER (
               WHERE d.refund_due_date IS NOT NULL
                 AND d.refund_due_date < $2::date
                 AND d.status NOT IN ('REFUNDED', 'PARTIALLY_REFUNDED', 'DEDUCTED_FULL', 'TRANSFERRED')
             )::int AS overdue_deposit_refunds,
             COUNT(*) FILTER (WHERE d.status = 'DISPUTED')::int AS disputed_deposits
           FROM deposit d
           JOIN contract c ON c.id = d.contract_id
           JOIN building b ON b.id = c.building_id
           WHERE b.org_id = $1 ${depKpiScope} ${depKpiFilter}`,
          depKpiParams
        ),
        client.query(
          `SELECT
             COUNT(*) FILTER (WHERE r.status = 'PENDING_CONFIRM')::int AS pending_reservation_confirms,
             COUNT(*) FILTER (WHERE r.status = 'CANCEL_PENDING_APPROVAL')::int AS pending_reservation_approvals,
             COUNT(*) FILTER (WHERE r.status = 'APPROVED_PENDING_PAYOUT')::int AS pending_reservation_payouts
           FROM reservation r
           JOIN building b ON b.id = r.building_id
           WHERE b.org_id = $1
             AND r.status IN ('PENDING_CONFIRM', 'CANCEL_PENDING_APPROVAL', 'APPROVED_PENDING_PAYOUT')
             ${rsvKpiScope} ${rsvKpiFilter}`,
          rsvKpiParams
        ),
        client.query(
          `SELECT COUNT(*)::int AS pending_adjustments
           FROM invoice_adjustment ia
           JOIN invoice i ON i.id = ia.invoice_id
           WHERE i.org_id = $1 AND ia.status IN ('PENDING', 'PENDING_APPROVAL')
           ${adjKpiScope} ${adjKpiFilter}`,
          adjKpiParams
        ),
        client.query(
          `SELECT COUNT(*)::int AS pending_credit_refunds
           FROM credit_balance cb
           WHERE cb.org_id = $1 AND cb.status = 'PENDING_DIRECT_REFUND'
           ${cbKpiScope} ${cbKpiFilter}`,
          cbKpiParams
        ),
      ]);

      const depKpiRow = depKpiRes.rows[0] || {};
      const rsvKpiRow = rsvKpiRes.rows[0] || {};

      res.json({
        data: {
          kpis: {
            occupancy_rate: occupancyRate,
            total_apartments: totalApts,
            occupied_apartments: statusCounts.OCCUPIED,
            available_apartments: statusCounts.AVAILABLE,
            monthly_revenue: currentMonthRev.collected,
            monthly_billed: currentMonthRev.billed,
            revenue_growth_pct: revenueGrowthPct,
            current_period: currentPeriod,
            unpaid_debt: unpaidDebt,
            pending_requests: srCountRes.rows[0]?.pending_count || 0,
            pending_deposit_approvals: Number(depKpiRow.pending_deposit_approvals || 0),
            pending_deposit_payouts: Number(depKpiRow.pending_deposit_payouts || 0),
            overdue_deposit_refunds: Number(depKpiRow.overdue_deposit_refunds || 0),
            disputed_deposits: Number(depKpiRow.disputed_deposits || 0),
            pending_reservation_confirms: Number(rsvKpiRow.pending_reservation_confirms || 0),
            pending_reservation_approvals: Number(rsvKpiRow.pending_reservation_approvals || 0),
            pending_reservation_payouts: Number(rsvKpiRow.pending_reservation_payouts || 0),
            pending_invoice_adjustments: Number(adjKpiRes?.rows[0]?.pending_adjustments || 0),
            pending_credit_refunds: Number(cbKpiRes?.rows[0]?.pending_credit_refunds || 0),
          },
          apartment_status_breakdown: statusCounts,
          revenue_12m: revenue12m,
          expiring_contracts: expRes.rows,
          recent_service_requests: srRecentRes.rows,
        },
      });
    } catch (err) {
      console.error('[Reports Dashboard Error]:', err);
      res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi khi tổng hợp dữ liệu Dashboard.' });
    } finally {
      await release();
    }
  }
);

/**
 * GET /api/v1/reports/deposit-ledger (RP-07 — Sổ cọc, PRD Mục 15.2)
 * Hỗ trợ format = 'json' | 'csv' | 'xlsx'
 * Bất biến kế toán:
 *   opening_held + collected + transfer_in + refund_reversed - deducted - refunded - transfer_out === closing_held
 *   (khi to_date >= hôm nay và không lọc status: closing_held === SUM(deposit.amount_held))
 */
router.get(
  '/deposit-ledger',
  authenticateToken,
  requireRole(['SYS_ADMIN', 'OWNER', 'MANAGER']),
  async (req, res) => {
    const { building_id, status, format = 'json' } = req.query;
    const orgId = req.user.org_id;
    const todayStr = getTodayVnDateStr();
    const fromDate = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.from_date || ''))
      ? String(req.query.from_date)
      : `${todayStr.slice(0, 7)}-01`;
    const toDate = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.to_date || ''))
      ? String(req.query.to_date)
      : todayStr;

    if (fromDate > toDate) {
      return res.status(400).json({
        code: 'INVALID_DATE_RANGE',
        message: 'Ngày bắt đầu (from_date) không được lớn hơn ngày kết thúc (to_date).',
      });
    }

    const { client, release } = await getUserClient(req);
    try {
      if (building_id) {
        const ok = await checkBuildingAccess(req, building_id, 'report');
        if (!ok) {
          return res.status(403).json({
            code: 'ACCESS_DENIED',
            message: 'Bạn không có quyền xem báo cáo sổ cọc của tòa nhà này.',
          });
        }
      }

      const ledgerParams = [orgId, fromDate, toDate];
      const { sql: bldScope } = await scopedBuildingFilter(req, 'c.building_id', ledgerParams);
      let extraFilter = '';
      if (building_id) {
        ledgerParams.push(building_id);
        extraFilter += ` AND c.building_id = $${ledgerParams.length}`;
      }
      if (status) {
        ledgerParams.push(String(status));
        extraFilter += ` AND d.status = $${ledgerParams.length}`;
      }

      const ledgerSql = `
        WITH txn_agg AS (
          SELECT
            dt.deposit_id,
            COALESCE(SUM(dt.amount) FILTER (
              WHERE dt.status = 'APPROVED'
                AND dt.type = 'collect'
                AND (dt.created_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date BETWEEN $2::date AND $3::date
            ), 0)::bigint AS collected_in_period,
            COALESCE(SUM(dt.amount) FILTER (
              WHERE dt.status = 'APPROVED'
                AND dt.type = 'transfer'
                AND COALESCE(dt.category, CASE WHEN dt.description ILIKE 'Chuyển kết dư%' THEN 'TRANSFER_OUT' ELSE 'TRANSFER_IN' END) = 'TRANSFER_IN'
                AND (dt.created_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date BETWEEN $2::date AND $3::date
            ), 0)::bigint AS transfer_in_period,
            COALESCE(SUM(dt.amount) FILTER (
              WHERE dt.status = 'APPROVED'
                AND dt.type = 'refund_reversal'
                AND (dt.created_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date BETWEEN $2::date AND $3::date
            ), 0)::bigint AS refund_reversed_in_period,
            COALESCE(SUM(dt.amount) FILTER (
              WHERE dt.status = 'APPROVED'
                AND dt.type = 'deduct'
                AND (dt.created_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date BETWEEN $2::date AND $3::date
            ), 0)::bigint AS deducted_in_period,
            COALESCE(SUM(dt.amount) FILTER (
              WHERE dt.status = 'APPROVED'
                AND dt.type = 'refund'
                AND (dt.created_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date BETWEEN $2::date AND $3::date
            ), 0)::bigint AS refunded_in_period,
            COALESCE(SUM(dt.amount) FILTER (
              WHERE dt.status = 'APPROVED'
                AND dt.type = 'transfer'
                AND COALESCE(dt.category, CASE WHEN dt.description ILIKE 'Chuyển kết dư%' THEN 'TRANSFER_OUT' ELSE 'TRANSFER_IN' END) = 'TRANSFER_OUT'
                AND (dt.created_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date BETWEEN $2::date AND $3::date
            ), 0)::bigint AS transfer_out_period,
            COALESCE(SUM(
              CASE
                WHEN dt.type IN ('collect', 'refund_reversal') THEN dt.amount
                WHEN dt.type = 'transfer' AND COALESCE(dt.category, CASE WHEN dt.description ILIKE 'Chuyển kết dư%' THEN 'TRANSFER_OUT' ELSE 'TRANSFER_IN' END) = 'TRANSFER_IN' THEN dt.amount
                WHEN dt.type IN ('deduct', 'refund') THEN -dt.amount
                WHEN dt.type = 'transfer' AND COALESCE(dt.category, CASE WHEN dt.description ILIKE 'Chuyển kết dư%' THEN 'TRANSFER_OUT' ELSE 'TRANSFER_IN' END) = 'TRANSFER_OUT' THEN -dt.amount
                ELSE 0
              END
            ) FILTER (
              WHERE dt.status = 'APPROVED'
                AND (dt.created_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date > $3::date
            ), 0)::bigint AS net_after_period
          FROM deposit_transaction dt
          GROUP BY dt.deposit_id
        )
        SELECT
          d.id AS deposit_id,
          d.contract_id,
          d.status AS deposit_status,
          d.amount_held,
          d.refund_due_date,
          d.updated_at,
          c.building_id,
          c.apartment_id,
          c.status AS contract_status,
          c.deposit_amount AS contract_deposit_amount,
          b.code AS building_code,
          b.name AS building_name,
          a.code AS apartment_code,
          p.full_name AS tenant_name,
          p.phone AS tenant_phone,
          COALESCE(ta.collected_in_period, 0)::bigint AS collected,
          COALESCE(ta.transfer_in_period, 0)::bigint AS transfer_in,
          COALESCE(ta.refund_reversed_in_period, 0)::bigint AS refund_reversed,
          COALESCE(ta.deducted_in_period, 0)::bigint AS deducted,
          COALESCE(ta.refunded_in_period, 0)::bigint AS refunded,
          COALESCE(ta.transfer_out_period, 0)::bigint AS transfer_out,
          COALESCE(ta.net_after_period, 0)::bigint AS net_after_period
        FROM deposit d
        JOIN contract c ON c.id = d.contract_id
        JOIN building b ON b.id = c.building_id
        JOIN apartment a ON a.id = c.apartment_id
        LEFT JOIN tenant t ON t.id = c.primary_tenant_id
        LEFT JOIN person p ON p.id = t.person_id
        LEFT JOIN txn_agg ta ON ta.deposit_id = d.id
        WHERE b.org_id = $1 ${bldScope} ${extraFilter}
        ORDER BY b.code ASC, a.code ASC, d.created_at DESC
      `;

      const rsvParams = [orgId, fromDate, toDate];
      const { sql: rsvScope } = await scopedBuildingFilter(req, 'r.building_id', rsvParams);
      let rsvFilter = '';
      if (building_id) {
        rsvParams.push(building_id);
        rsvFilter = ` AND r.building_id = $${rsvParams.length}`;
      }

      const rsvSql = `
        SELECT
          COUNT(*) FILTER (WHERE r.status IN ('HELD', 'CANCEL_PENDING_APPROVAL'))::int AS active_held_count,
          COALESCE(SUM(r.hold_amount) FILTER (WHERE r.status IN ('HELD', 'CANCEL_PENDING_APPROVAL')), 0)::bigint AS active_held_amount,
          COUNT(*) FILTER (WHERE r.status = 'PENDING_CONFIRM')::int AS pending_confirm_count,
          COALESCE(SUM(r.hold_amount) FILTER (WHERE r.status = 'PENDING_CONFIRM'), 0)::bigint AS pending_confirm_amount,
          COUNT(*) FILTER (WHERE r.status = 'APPROVED_PENDING_PAYOUT')::int AS pending_payout_count,
          COALESCE(SUM(r.refunded_amount) FILTER (WHERE r.status = 'APPROVED_PENDING_PAYOUT'), 0)::bigint AS pending_payout_amount,
          COALESCE(SUM(
            CASE
              WHEN r.status = 'REFUNDED' THEN COALESCE(NULLIF(r.refunded_amount, 0), r.hold_amount)
              WHEN r.status = 'PARTIALLY_REFUNDED' THEN r.refunded_amount
              ELSE 0
            END
          ) FILTER (
            WHERE r.status IN ('REFUNDED', 'PARTIALLY_REFUNDED')
              AND (COALESCE((r.cancel_settlement->>'payout_at')::timestamptz, r.updated_at) AT TIME ZONE 'Asia/Ho_Chi_Minh')::date BETWEEN $2::date AND $3::date
          ), 0)::bigint AS refunded_in_period,
          COALESCE(SUM(
            CASE
              WHEN r.status = 'FORFEITED' THEN COALESCE(NULLIF(r.forfeited_amount, 0), r.hold_amount)
              WHEN r.status IN ('APPROVED_PENDING_PAYOUT', 'PARTIALLY_REFUNDED') THEN COALESCE(r.forfeited_amount, 0)
              ELSE 0
            END
          ) FILTER (
            WHERE (
              r.status = 'FORFEITED'
              OR (r.status IN ('APPROVED_PENDING_PAYOUT', 'PARTIALLY_REFUNDED') AND COALESCE(r.forfeited_amount, 0) > 0)
            )
              AND (COALESCE((r.cancel_settlement->>'approved_at')::timestamptz, r.updated_at) AT TIME ZONE 'Asia/Ho_Chi_Minh')::date BETWEEN $2::date AND $3::date
          ), 0)::bigint AS forfeited_in_period
        FROM reservation r
        JOIN building b ON b.id = r.building_id
        WHERE b.org_id = $1 ${rsvScope} ${rsvFilter}
      `;

      const [ledgerRes, rsvRes] = await Promise.all([
        client.query(ledgerSql, ledgerParams),
        client.query(rsvSql, rsvParams),
      ]);

      const summary = {
        opening_held: 0,
        collected: 0,
        transfer_in: 0,
        refund_reversed: 0,
        deducted: 0,
        refunded: 0,
        transfer_out: 0,
        closing_held: 0,
        disputed_count: 0,
        disputed_amount: 0,
        pending_payout_count: 0,
        pending_payout_amount: 0,
        returned_count: 0,
        returned_amount: 0,
        overdue_count: 0,
      };

      const items = ledgerRes.rows.map((row) => {
        const currentHeld = Number(row.amount_held || 0);
        const netAfter = Number(row.net_after_period || 0);
        const collected = Number(row.collected || 0);
        const transferIn = Number(row.transfer_in || 0);
        const refundReversed = Number(row.refund_reversed || 0);
        const deducted = Number(row.deducted || 0);
        const refunded = Number(row.refunded || 0);
        const transferOut = Number(row.transfer_out || 0);

        const closingHeld = currentHeld - netAfter;
        const netInPeriod =
          collected + transferIn + refundReversed - deducted - refunded - transferOut;
        const openingHeld = closingHeld - netInPeriod;

        const dueStr = row.refund_due_date ? getTodayVnDateStr(row.refund_due_date) : null;
        const isOverdue = Boolean(
          dueStr &&
            dueStr < todayStr &&
            !['REFUNDED', 'PARTIALLY_REFUNDED', 'DEDUCTED_FULL', 'TRANSFERRED'].includes(
              row.deposit_status
            )
        );

        summary.opening_held += openingHeld;
        summary.collected += collected;
        summary.transfer_in += transferIn;
        summary.refund_reversed += refundReversed;
        summary.deducted += deducted;
        summary.refunded += refunded;
        summary.transfer_out += transferOut;
        summary.closing_held += closingHeld;

        if (row.deposit_status === 'DISPUTED') {
          summary.disputed_count += 1;
          summary.disputed_amount += currentHeld;
        }
        if (row.deposit_status === 'APPROVED_PENDING_PAYOUT') {
          summary.pending_payout_count += 1;
          summary.pending_payout_amount += currentHeld;
        }
        if (row.deposit_status === 'RETURNED') {
          summary.returned_count += 1;
          summary.returned_amount += currentHeld;
        }
        if (isOverdue) {
          summary.overdue_count += 1;
        }

        return {
          deposit_id: row.deposit_id,
          contract_id: row.contract_id,
          building_id: row.building_id,
          building_code: row.building_code,
          building_name: row.building_name,
          apartment_id: row.apartment_id,
          apartment_code: row.apartment_code,
          tenant_name: row.tenant_name || '',
          tenant_phone: row.tenant_phone || '',
          contract_status: row.contract_status,
          deposit_status: row.deposit_status,
          status: row.deposit_status,
          contract_deposit_amount: Number(row.contract_deposit_amount || 0),
          opening_held: openingHeld,
          collected,
          transfer_in: transferIn,
          refund_reversed: refundReversed,
          deducted,
          refunded,
          transfer_out: transferOut,
          closing_held: closingHeld,
          refund_due_date: dueStr,
          is_overdue: isOverdue,
          updated_at: row.updated_at,
        };
      });

      const rsvRow = rsvRes.rows[0] || {};
      const reservationSummary = {
        active_held_count: Number(rsvRow.active_held_count || 0),
        active_held_amount: Number(rsvRow.active_held_amount || 0),
        pending_confirm_count: Number(rsvRow.pending_confirm_count || 0),
        pending_confirm_amount: Number(rsvRow.pending_confirm_amount || 0),
        pending_payout_count: Number(rsvRow.pending_payout_count || 0),
        pending_payout_amount: Number(rsvRow.pending_payout_amount || 0),
        refunded_in_period: Number(rsvRow.refunded_in_period || 0),
        forfeited_in_period: Number(rsvRow.forfeited_in_period || 0),
      };

      const fmt = String(format || 'json').toLowerCase();
      if (fmt === 'csv' || fmt === 'xlsx') {
        const headers = [
          'Mã tòa',
          'Tên tòa nhà',
          'Mã căn hộ',
          'Khách thuê',
          'Số điện thoại',
          'Trạng thái HĐ',
          'Trạng thái sổ cọc',
          'Đầu kỳ (VND)',
          'Thu mới (VND)',
          'Nhận kết chuyển (VND)',
          'Hoàn trả lệnh chi (VND)',
          'Khấu trừ (VND)',
          'Đã hoàn chi (VND)',
          'Kết chuyển đi (VND)',
          'Cuối kỳ đang giữ (VND)',
          'Hạn hoàn cọc',
          'Quá hạn',
        ];

        const exportRows = items.map((it) => [
          it.building_code,
          it.building_name,
          it.apartment_code,
          it.tenant_name,
          String(it.tenant_phone || ''),
          it.contract_status,
          it.deposit_status,
          it.opening_held,
          it.collected,
          it.transfer_in,
          it.refund_reversed,
          it.deducted,
          it.refunded,
          it.transfer_out,
          it.closing_held,
          it.refund_due_date || '',
          it.is_overdue ? 'Quá hạn' : 'Bình thường',
        ]);

        // Tổng cộng dòng cuối trên Sheet 1
        exportRows.push([
          'TONG_CONG',
          `Kỳ ${fromDate} -> ${toDate}`,
          '',
          '',
          '',
          '',
          '',
          summary.opening_held,
          summary.collected,
          summary.transfer_in,
          summary.refund_reversed,
          summary.deducted,
          summary.refunded,
          summary.transfer_out,
          summary.closing_held,
          '',
          '',
        ]);

        if (fmt === 'csv') {
          const csvContent = toUtf8BomCsv(headers, exportRows);
          res.setHeader('Content-Type', 'text/csv; charset=utf-8');
          res.setHeader(
            'Content-Disposition',
            `attachment; filename="so-coc-rp07-${fromDate}-${toDate}.csv"`
          );
          return res.status(200).send(csvContent);
        }

        const rsvHeaders = [
          'Chỉ tiêu đối soát giữ chỗ',
          'Số lượng phiếu',
          'Số tiền (VND)',
        ];
        const rsvRows = [
          ['Giữ chỗ đang giữ / chờ duyệt hủy (HELD / CANCEL_PENDING_APPROVAL)', reservationSummary.active_held_count, reservationSummary.active_held_amount],
          ['Giữ chỗ đã duyệt chờ BQL chi hoàn (APPROVED_PENDING_PAYOUT)', reservationSummary.pending_payout_count, reservationSummary.pending_payout_amount],
          ['Giữ chỗ chờ đối chiếu sao kê (PENDING_CONFIRM)', reservationSummary.pending_confirm_count, reservationSummary.pending_confirm_amount],
          ['Hoàn trả giữ chỗ trong kỳ', '', reservationSummary.refunded_in_period],
          ['Tịch thu giữ chỗ trong kỳ', '', reservationSummary.forfeited_in_period],
        ];

        const xlsxBuf = toXlsxBuffer([
          { name: 'So coc RP-07', headers, rows: exportRows },
          { name: 'Doi soat giu cho', headers: rsvHeaders, rows: rsvRows },
        ]);
        res.setHeader(
          'Content-Type',
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        );
        res.setHeader(
          'Content-Disposition',
          `attachment; filename="so-coc-rp07-${fromDate}-${toDate}.xlsx"`
        );
        return res.status(200).send(xlsxBuf);
      }

      return res.json({
        data: {
          period: { from_date: fromDate, to_date: toDate },
          summary,
          reservation_summary: reservationSummary,
          items,
          rows: items,
        },
      });
    } catch (err) {
      console.error('[Reports Deposit Ledger Error]:', err);
      return res.status(500).json({
        code: 'DB_ERROR',
        message: 'Lỗi khi tổng hợp Báo cáo Sổ cọc (RP-07).',
      });
    } finally {
      await release();
    }
  }
);

/**
 * GET /api/v1/reports/summary
 * Báo cáo chuyên sâu 4 chiều (M14): Doanh thu 12 tháng, Lấp đầy theo tòa, Công nợ Aging, SLA bảo trì
 */
router.get(
  '/summary',
  authenticateToken,
  requireRole(['SYS_ADMIN', 'OWNER', 'MANAGER']),
  async (req, res) => {
    const { building_id } = req.query;
    const orgId = req.user.org_id;

    const { client, release } = await getUserClient(req);
    try {
      if (building_id) {
        const ok = await checkBuildingAccess(req, building_id, 'report');
        if (!ok) {
          return res.status(403).json({ code: 'ACCESS_DENIED', message: 'Bạn không có quyền xem báo cáo tòa nhà này.' });
        }
      }

      const periods12 = buildLast12MonthsPeriods();

      // 1. Doanh thu 12 tháng
      const revParams = [orgId, periods12];
      const { sql: revScope } = await scopedBuildingFilter(req, 'i.building_id', revParams);
      let revFilter = '';
      if (building_id) {
        revParams.push(building_id);
        revFilter = ` AND i.building_id = $${revParams.length}`;
      }
      const revRes = await client.query(
        `SELECT i.period,
                COUNT(i.id)::int AS invoice_count,
                COALESCE(SUM(i.total_amount + COALESCE(i.credit_offset_amount, 0)) FILTER (WHERE i.status NOT IN ('CANCELLED', 'DRAFT', 'VOID')), 0)::bigint AS billed,
                COALESCE(SUM(i.paid_amount) FILTER (WHERE i.status NOT IN ('CANCELLED', 'DRAFT', 'VOID')), 0)::bigint AS collected,
                COALESCE(SUM(i.paid_amount + COALESCE(i.credit_offset_amount, 0)) FILTER (WHERE i.status NOT IN ('CANCELLED', 'DRAFT', 'VOID')), 0)::bigint AS invoice_settled,
                COALESCE(SUM(i.total_amount - i.paid_amount) FILTER (WHERE i.status NOT IN ('CANCELLED', 'DRAFT', 'VOID', 'PAID')), 0)::bigint AS outstanding
         FROM invoice i
         WHERE i.org_id = $1 AND i.period = ANY($2::text[]) ${revScope} ${revFilter}
         GROUP BY i.period`,
        revParams
      );
      const revMap = new Map(revRes.rows.map((r) => [r.period, {
        period: r.period,
        invoice_count: Number(r.invoice_count || 0),
        billed: Number(r.billed || 0),
        collected: Number(r.collected || 0),
        invoice_settled: Number(r.invoice_settled || 0),
        outstanding: Number(r.outstanding || 0),
      }]));
      const revenue12m = periods12.map((p) => revMap.get(p) || {
        period: p,
        invoice_count: 0,
        billed: 0,
        collected: 0,
        invoice_settled: 0,
        outstanding: 0,
      });

      // 2. Lấp đầy theo từng tòa nhà
      const occParams = [orgId];
      const { sql: occScope } = await scopedBuildingFilter(req, 'b.id', occParams);
      let occFilter = '';
      if (building_id) {
        occParams.push(building_id);
        occFilter = ` AND b.id = $${occParams.length}`;
      }
      const occRes = await client.query(
        `SELECT b.id AS building_id,
                b.code AS building_code,
                b.name AS building_name,
                COUNT(a.id) FILTER (WHERE a.status != 'INACTIVE')::int AS total_apartments,
                COUNT(a.id) FILTER (WHERE a.status = 'OCCUPIED')::int AS occupied,
                COUNT(a.id) FILTER (WHERE a.status = 'AVAILABLE')::int AS available,
                COUNT(a.id) FILTER (WHERE a.status = 'RESERVED')::int AS reserved,
                COUNT(a.id) FILTER (WHERE a.status = 'MAINTENANCE')::int AS maintenance
         FROM building b
         LEFT JOIN apartment a ON a.building_id = b.id
         WHERE b.org_id = $1 ${occScope} ${occFilter}
         GROUP BY b.id
         ORDER BY b.code ASC`,
        occParams
      );
      const occupancyByBuilding = occRes.rows.map((r) => ({
        ...r,
        occupancy_rate: r.total_apartments > 0 ? Number(((r.occupied / r.total_apartments) * 100).toFixed(1)) : 0,
      }));

      // 3. Báo cáo tuổi nợ theo tòa (AC-016.1 & RP-08)
      const ageParams = [orgId];
      const { sql: ageScope } = await scopedBuildingFilter(req, 'r.building_id', ageParams);
      let ageFilter = '';
      if (building_id) {
        ageParams.push(building_id);
        ageFilter = ` AND r.building_id = $${ageParams.length}`;
      }
      const ageRes = await client.query(
        `SELECT b.code AS building_code,
                b.name AS building_name,
                COALESCE(SUM(r.amount - r.paid_amount) FILTER (WHERE r.due_date >= CURRENT_DATE), 0)::bigint AS current_not_due,
                COALESCE(SUM(r.amount - r.paid_amount) FILTER (WHERE (CURRENT_DATE - r.due_date) BETWEEN 1 AND 15), 0)::bigint AS bucket_0_15,
                COALESCE(SUM(r.amount - r.paid_amount) FILTER (WHERE (CURRENT_DATE - r.due_date) BETWEEN 16 AND 30), 0)::bigint AS bucket_16_30,
                COALESCE(SUM(r.amount - r.paid_amount) FILTER (WHERE (CURRENT_DATE - r.due_date) BETWEEN 31 AND 60), 0)::bigint AS bucket_31_60,
                COALESCE(SUM(r.amount - r.paid_amount) FILTER (WHERE (CURRENT_DATE - r.due_date) > 60), 0)::bigint AS bucket_over_60,
                COALESCE(SUM(r.amount - r.paid_amount) FILTER (WHERE (CURRENT_DATE - r.due_date) <= 30), 0)::bigint AS bucket_0_30,
                COALESCE(SUM(r.amount - r.paid_amount) FILTER (WHERE (CURRENT_DATE - r.due_date) BETWEEN 61 AND 90), 0)::bigint AS bucket_61_90,
                COALESCE(SUM(r.amount - r.paid_amount) FILTER (WHERE (CURRENT_DATE - r.due_date) > 90), 0)::bigint AS bucket_over_90,
                COALESCE(SUM(r.amount - r.paid_amount), 0)::bigint AS total_debt
         FROM receivable r
         JOIN building b ON b.id = r.building_id
         WHERE r.org_id = $1
           AND r.status IN ('OPEN', 'PARTIALLY_PAID')
           ${ageScope} ${ageFilter}
         GROUP BY b.id, b.code, b.name
         ORDER BY total_debt DESC`,
        ageParams
      );

      // 4. Chỉ số SLA xử lý yêu cầu báo hỏng
      const slaParams = [orgId];
      const { sql: slaScope } = await scopedBuildingFilter(req, 'sr.building_id', slaParams);
      let slaFilter = '';
      if (building_id) {
        slaParams.push(building_id);
        slaFilter = ` AND sr.building_id = $${slaParams.length}`;
      }
      const slaRes = await client.query(
        `SELECT sr.category,
                COUNT(*)::int AS total_requests,
                COUNT(*) FILTER (WHERE sr.status IN ('RESOLVED', 'CLOSED'))::int AS resolved_count,
                COUNT(*) FILTER (WHERE sr.status IN ('NEW', 'ASSIGNED', 'IN_PROGRESS'))::int AS open_count,
                ROUND(AVG(EXTRACT(EPOCH FROM (sr.resolved_at - sr.created_at)) / 3600.0)::numeric, 1) AS avg_resolve_hours,
                ROUND(AVG(sr.rating)::numeric, 2) AS avg_rating
         FROM service_request sr
         WHERE sr.org_id = $1 ${slaScope} ${slaFilter}
         GROUP BY sr.category
         ORDER BY total_requests DESC`,
        slaParams
      );

      const agingFormatted = ageRes.rows.map((r) => ({
        building_code: r.building_code,
        building_name: r.building_name,
        current_not_due: Number(r.current_not_due || 0),
        bucket_0_15: Number(r.bucket_0_15 || 0),
        bucket_16_30: Number(r.bucket_16_30 || 0),
        bucket_31_60: Number(r.bucket_31_60 || 0),
        bucket_over_60: Number(r.bucket_over_60 || 0),
        bucket_0_30: Number(r.bucket_0_30 || 0),
        bucket_61_90: Number(r.bucket_61_90 || 0),
        bucket_over_90: Number(r.bucket_over_90 || 0),
        total_debt: Number(r.total_debt || 0),
      }));

      const exportFormat = String(req.query.format || '').toLowerCase();
      if (exportFormat === 'csv') {
        const headers = [
          'Mã tòa',
          'Tên tòa',
          'Chưa đến hạn',
          'Quá hạn 1-15 ngày',
          'Quá hạn 16-30 ngày',
          'Quá hạn 31-60 ngày',
          'Quá hạn >60 ngày',
          'Tổng nợ',
        ];
        const rows = agingFormatted.map((r) => [
          r.building_code,
          r.building_name,
          r.current_not_due,
          r.bucket_0_15,
          r.bucket_16_30,
          r.bucket_31_60,
          r.bucket_over_60,
          r.total_debt,
        ]);
        const csvContent = toUtf8BomCsv(headers, rows);
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', 'attachment; filename="bao-cao-tong-hop.csv"');
        return res.status(200).send(csvContent);
      }

      if (exportFormat === 'xlsx') {
        const revHeaders = ['Kỳ', 'Số HĐ', 'Tổng phát hành', 'Thực thu', 'Đã tất toán', 'Còn nợ'];
        const revRows = revenue12m.map((r) => [
          r.period,
          r.invoice_count,
          r.billed,
          r.collected,
          r.invoice_settled ?? r.collected,
          r.outstanding,
        ]);

        const occHeaders = ['Mã tòa', 'Tên tòa', 'Tổng căn', 'Đang ở', 'Trống', 'Giữ chỗ', 'Bảo trì', 'Tỷ lệ lấp đầy (%)'];
        const occRows = occupancyByBuilding.map((r) => [
          r.building_code,
          r.building_name,
          r.total_apartments,
          r.occupied,
          r.available,
          r.reserved,
          r.maintenance,
          r.occupancy_rate,
        ]);

        const ageHeaders = ['Mã tòa', 'Tên tòa', 'Chưa đến hạn', '1-15 ngày', '16-30 ngày', '31-60 ngày', '>60 ngày', 'Tổng nợ'];
        const ageRows = agingFormatted.map((r) => [
          r.building_code,
          r.building_name,
          r.current_not_due,
          r.bucket_0_15,
          r.bucket_16_30,
          r.bucket_31_60,
          r.bucket_over_60,
          r.total_debt,
        ]);

        const slaHeaders = ['Danh mục', 'Tổng yêu cầu', 'Đã xử lý', 'Đang xử lý', 'Thời gian TB (giờ)', 'Đánh giá'];
        const slaRows = slaRes.rows.map((r) => [
          r.category,
          r.total_requests,
          r.resolved_count,
          r.open_count,
          r.avg_resolve_hours,
          r.avg_rating,
        ]);

        const xlsxBuf = toXlsxBuffer([
          { name: 'Doanh thu 12 thang', headers: revHeaders, rows: revRows },
          { name: 'Lap day theo toa', headers: occHeaders, rows: occRows },
          { name: 'Tuoi no theo toa', headers: ageHeaders, rows: ageRows },
          { name: 'SLA bao tri', headers: slaHeaders, rows: slaRows },
        ]);

        res.setHeader(
          'Content-Type',
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        );
        res.setHeader('Content-Disposition', 'attachment; filename="bao-cao-tong-hop.xlsx"');
        return res.status(200).send(xlsxBuf);
      }

      res.json({
        data: {
          revenue_12m: revenue12m,
          occupancy_by_building: occupancyByBuilding,
          aging_by_building: agingFormatted,
          sla_by_category: slaRes.rows,
        },
      });
    } catch (err) {
      console.error('[Reports Summary Error]:', err);
      res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi khi tải báo cáo tổng hợp.' });
    } finally {
      await release();
    }
  }
);

export default router;
