import express from 'express';
import { pool } from '../db/client.js';
import { authenticateToken } from '../middleware/auth.js';
import { requireRole } from '../middleware/rbac.js';
import {
  scopedBuildingFilter,
  checkBuildingAccess,
} from '../services/ownerScope.js';

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
 */
router.get(
  '/dashboard',
  authenticateToken,
  requireRole(['SYS_ADMIN', 'OWNER', 'MANAGER', 'STAFF', 'ACCOUNTANT']),
  async (req, res) => {
    const { building_id } = req.query;
    const orgId = req.user.org_id;

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
      const aptStatsRes = await pool.query(
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
      const revRes = await pool.query(
        `SELECT i.period,
                COALESCE(SUM(i.total_amount) FILTER (WHERE i.status != 'CANCELLED'), 0)::bigint AS billed,
                COALESCE(SUM(i.paid_amount) FILTER (WHERE i.status != 'CANCELLED'), 0)::bigint AS collected
         FROM invoice i
         WHERE i.org_id = $1
           AND i.period = ANY($2::text[])
           ${revScope} ${revFilter}
         GROUP BY i.period`,
        revParams
      );

      const revMap = new Map();
      for (const r of revRes.rows) {
        revMap.set(r.period, {
          period: r.period,
          billed: Number(r.billed || 0),
          collected: Number(r.collected || 0),
        });
      }
      const revenue12m = periods12.map((p) => revMap.get(p) || { period: p, billed: 0, collected: 0 });
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
      const debtRes = await pool.query(
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
        pool.query(
          `SELECT COUNT(*)::int AS pending_count
           FROM service_request sr
           WHERE sr.org_id = $1
             AND sr.status IN ('NEW', 'ASSIGNED', 'IN_PROGRESS')
             ${srScope} ${srFilter}`,
          srParams
        ),
        pool.query(
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

      // 5. Hợp đồng sắp hết hạn trong 30 ngày tới
      const expParams = [orgId];
      const { sql: expScope } = await scopedBuildingFilter(req, 'c.building_id', expParams);
      let expFilter = '';
      if (building_id) {
        expParams.push(building_id);
        expFilter = ` AND c.building_id = $${expParams.length}`;
      }
      const expRes = await pool.query(
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
  requireRole(['SYS_ADMIN', 'OWNER', 'MANAGER', 'ACCOUNTANT']),
  async (req, res) => {
    const { building_id } = req.query;
    const orgId = req.user.org_id;

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
      const revRes = await pool.query(
        `SELECT i.period,
                COUNT(*) FILTER (WHERE i.status != 'CANCELLED')::int AS invoice_count,
                COALESCE(SUM(i.total_amount) FILTER (WHERE i.status != 'CANCELLED'), 0)::bigint AS billed,
                COALESCE(SUM(i.paid_amount) FILTER (WHERE i.status != 'CANCELLED'), 0)::bigint AS collected,
                COALESCE(SUM(i.total_amount - i.paid_amount) FILTER (WHERE i.status NOT IN ('CANCELLED', 'PAID')), 0)::bigint AS outstanding
         FROM invoice i
         WHERE i.org_id = $1 AND i.period = ANY($2::text[]) ${revScope} ${revFilter}
         GROUP BY i.period`,
        revParams
      );
      const revMap = new Map(revRes.rows.map((r) => [r.period, {
        period: r.period,
        invoice_count: r.invoice_count,
        billed: Number(r.billed || 0),
        collected: Number(r.collected || 0),
        outstanding: Number(r.outstanding || 0),
      }]));
      const revenue12m = periods12.map((p) => revMap.get(p) || { period: p, invoice_count: 0, billed: 0, collected: 0, outstanding: 0 });

      // 2. Lấp đầy theo từng tòa nhà
      const occParams = [orgId];
      const { sql: occScope } = await scopedBuildingFilter(req, 'b.id', occParams);
      let occFilter = '';
      if (building_id) {
        occParams.push(building_id);
        occFilter = ` AND b.id = $${occParams.length}`;
      }
      const occRes = await pool.query(
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

      // 3. Báo cáo tuổi nợ theo tòa
      const ageParams = [orgId];
      const { sql: ageScope } = await scopedBuildingFilter(req, 'r.building_id', ageParams);
      let ageFilter = '';
      if (building_id) {
        ageParams.push(building_id);
        ageFilter = ` AND r.building_id = $${ageParams.length}`;
      }
      const ageRes = await pool.query(
        `SELECT b.code AS building_code,
                b.name AS building_name,
                COALESCE(SUM(r.amount - r.paid_amount) FILTER (WHERE (CURRENT_DATE - r.due_date) <= 30), 0)::bigint AS bucket_0_30,
                COALESCE(SUM(r.amount - r.paid_amount) FILTER (WHERE (CURRENT_DATE - r.due_date) BETWEEN 31 AND 60), 0)::bigint AS bucket_31_60,
                COALESCE(SUM(r.amount - r.paid_amount) FILTER (WHERE (CURRENT_DATE - r.due_date) BETWEEN 61 AND 90), 0)::bigint AS bucket_61_90,
                COALESCE(SUM(r.amount - r.paid_amount) FILTER (WHERE (CURRENT_DATE - r.due_date) > 90), 0)::bigint AS bucket_over_90,
                COALESCE(SUM(r.amount - r.paid_amount), 0)::bigint AS total_debt
         FROM receivable r
         JOIN building b ON b.id = r.building_id
         WHERE r.org_id = $1
           AND r.status IN ('OPEN', 'PARTIALLY_PAID')
           ${ageScope} ${ageFilter}
         GROUP BY b.id
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
      const slaRes = await pool.query(
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

      res.json({
        data: {
          revenue_12m: revenue12m,
          occupancy_by_building: occupancyByBuilding,
          aging_by_building: ageRes.rows.map((r) => ({
            ...r,
            bucket_0_30: Number(r.bucket_0_30),
            bucket_31_60: Number(r.bucket_31_60),
            bucket_61_90: Number(r.bucket_61_90),
            bucket_over_90: Number(r.bucket_over_90),
            total_debt: Number(r.total_debt),
          })),
          sla_by_category: slaRes.rows,
        },
      });
    } catch (err) {
      console.error('[Reports Summary Error]:', err);
      res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi khi tải báo cáo tổng hợp.' });
    }
  }
);

export default router;

