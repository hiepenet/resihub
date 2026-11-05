export const DASHBOARD_AGING_BUCKET_KEYS = [
  'current_not_due',
  '0_15',
  '16_30',
  '31_60',
  'over_60',
];

export const DASHBOARD_AGING_BUCKET_META = [
  { key: 'current_not_due', label: 'Chưa đến hạn', color: '#94a3b8' },
  { key: '0_15', label: '1–15 ngày', color: '#38bdf8' },
  { key: '16_30', label: '16–30 ngày', color: '#fbbf24' },
  { key: '31_60', label: '31–60 ngày', color: '#f97316' },
  { key: 'over_60', label: '>60 ngày', color: '#e11d48' },
];

function toNonNegativeNumber(val) {
  const n = Number(val);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// ─── Revenue ────────────────────────────────────────────────────────────────

/**
 * Builds Chart.js Line dataset for 12-month revenue trend (PRD §15.1).
 * Returns 3 datasets: Phát hành (billed), Tất toán HĐ (invoice_settled), Thực thu (collected).
 *
 * @param {Array} revenueSeries - Array of { period, billed, collected, invoice_settled }
 * @returns {{ labels: string[], datasets: object[] }}
 */
export function buildRevenueTrendChartData(revenueSeries = []) {
  const rows = Array.isArray(revenueSeries) ? revenueSeries : [];
  const labels = rows.map((r) => String(r?.period || r?.month || ''));

  return {
    labels,
    datasets: [
      {
        label: 'Phát hành',
        data: rows.map((r) => toNonNegativeNumber(r?.billed)),
        borderColor: '#0ea5e9',
        backgroundColor: 'rgba(14,165,233,0.1)',
        fill: true,
        tension: 0.3,
        pointRadius: 3,
      },
      {
        label: 'Tất toán HĐ',
        data: rows.map((r) => toNonNegativeNumber(r?.invoice_settled)),
        borderColor: '#8b5cf6',
        backgroundColor: 'transparent',
        borderDash: [4, 4],
        tension: 0.3,
        pointRadius: 3,
      },
      {
        label: 'Thực thu',
        data: rows.map((r) => toNonNegativeNumber(r?.collected)),
        borderColor: '#10b981',
        backgroundColor: 'rgba(16,185,129,0.1)',
        fill: true,
        tension: 0.3,
        pointRadius: 3,
      },
    ],
  };
}

const REVENUE_SOURCE_DEFS = [
  { key: 'rent', label: 'Tiền thuê phòng', color: '#0ea5e9' },
  { key: 'electricity', label: 'Tiền điện', color: '#f59e0b' },
  { key: 'water', label: 'Tiền nước', color: '#06b6d4' },
  { key: 'service', label: 'Phí dịch vụ', color: '#10b981' },
  { key: 'other', label: 'Phí trễ hạn & Khác', color: '#8b5cf6' },
];

/**
 * Builds Chart.js Stacked Bar dataset for revenue by source (PRD §15.1 RP-01).
 * Returns 5 datasets: rent, electricity, water, service, other — all with stack: 'revenue_source'.
 *
 * @param {Array} sourceSeries - Array of { period, rent, electricity, water, service, other }
 * @returns {{ labels: string[], datasets: object[] }}
 */
export function buildRevenueBySourceChartData(sourceSeries = []) {
  const rows = Array.isArray(sourceSeries) ? sourceSeries : [];
  const labels = rows.map((r) => String(r?.period || ''));

  return {
    labels,
    datasets: REVENUE_SOURCE_DEFS.map(({ key, label, color }) => ({
      label,
      data: rows.map((r) => toNonNegativeNumber(r?.[key])),
      backgroundColor: color,
      stack: 'revenue_source',
      borderRadius: 3,
      borderSkipped: false,
    })),
  };
}

// ─── Receivables Aging ───────────────────────────────────────────────────────

/**
 * Builds Chart.js Bar dataset for receivables aging (PRD §15.1 — 5 buckets).
 * Returns bucketKeys, counts (per-bucket invoice count), and chartData for Chart.js Bar.
 *
 * @param {object} receivablesAging - { buckets: [{ key, label, amount, count }], ... }
 * @returns {{ bucketKeys: string[], counts: number[], chartData: { labels: string[], datasets: object[] } }}
 */
export function buildReceivablesAgingChartData(receivablesAging = {}) {
  const rawBuckets = Array.isArray(receivablesAging?.buckets)
    ? receivablesAging.buckets
    : [];
  const byKey = new Map(
    rawBuckets
      .filter((b) => b && typeof b === 'object' && b.key)
      .map((b) => [b.key, b])
  );

  const bucketKeys = DASHBOARD_AGING_BUCKET_META.map((m) => m.key);
  const amounts = DASHBOARD_AGING_BUCKET_META.map((m) =>
    toNonNegativeNumber(byKey.get(m.key)?.amount)
  );
  const counts = DASHBOARD_AGING_BUCKET_META.map((m) =>
    toNonNegativeNumber(byKey.get(m.key)?.count)
  );

  return {
    bucketKeys,
    counts,
    chartData: {
      labels: DASHBOARD_AGING_BUCKET_META.map((m) => m.label),
      datasets: [
        {
          label: 'Dư nợ chưa thu',
          data: amounts,
          backgroundColor: DASHBOARD_AGING_BUCKET_META.map((m) => m.color),
          borderRadius: 4,
          borderSkipped: false,
        },
      ],
    },
  };
}

// ─── Occupancy ───────────────────────────────────────────────────────────────

/**
 * Builds Chart.js Line dataset for 12-month occupancy trend (PRD §15.1).
 * Returns metaPoints (occupied/exploitable per period) and chartData for Chart.js Line.
 *
 * @param {Array} occupancySeries - Array of { period, occupied, exploitable, occupancy_rate }
 * @returns {{ metaPoints: { occupied: number, exploitable: number }[], chartData: { labels: string[], datasets: object[] } }}
 */
export function buildOccupancyTrendChartData(occupancySeries = []) {
  const rows = Array.isArray(occupancySeries) ? occupancySeries : [];
  const labels = rows.map((r) => String(r?.period || ''));
  const metaPoints = rows.map((r) => ({
    occupied: toNonNegativeNumber(r?.occupied),
    exploitable: toNonNegativeNumber(r?.exploitable),
  }));

  return {
    metaPoints,
    chartData: {
      labels,
      datasets: [
        {
          label: 'Tỷ lệ lấp đầy (%)',
          data: rows.map((r) => {
            const rawRate = Number(r?.occupancy_rate);
            return Number.isFinite(rawRate)
              ? Math.min(100, Math.max(0, rawRate))
              : 0;
          }),
          borderColor: '#0ea5e9',
          backgroundColor: 'rgba(14,165,233,0.15)',
          fill: true,
          tension: 0.3,
          pointRadius: 4,
        },
      ],
    },
  };
}

// ─── Guard helpers ───────────────────────────────────────────────────────────

export function hasRevenueChartData(revenueSeries = [], sourceSeries = []) {
  const revHasPositive =
    Array.isArray(revenueSeries) &&
    revenueSeries.some(
      (r) =>
        Number(r?.billed || 0) > 0 ||
        Number(r?.collected || 0) > 0
    );

  const srcHasPositive =
    Array.isArray(sourceSeries) &&
    sourceSeries.some(
      (s) =>
        Number(s?.rent || 0) > 0 ||
        Number(s?.electricity || 0) > 0 ||
        Number(s?.water || 0) > 0 ||
        Number(s?.service || 0) > 0 ||
        Number(s?.other || 0) > 0
    );

  return revHasPositive || srcHasPositive;
}

export function hasAgingChartData(receivablesAging) {
  if (!receivablesAging || typeof receivablesAging !== 'object') return false;
  if (Number(receivablesAging.total_debt || 0) > 0) return true;
  return (
    Array.isArray(receivablesAging.buckets) &&
    receivablesAging.buckets.some((b) => Number(b?.amount || 0) > 0)
  );
}

export function hasOccupancyChartData(totalApartments = 0, occupancySeries = []) {
  if (Number(totalApartments || 0) > 0) return true;
  return (
    Array.isArray(occupancySeries) &&
    occupancySeries.some((o) => Number(o?.exploitable || 0) > 0)
  );
}

// ─── Reports (keep for ReportsPage.jsx) ─────────────────────────────────────

export function buildReportsBuildingAgingChartData(agingByBuildingRows = []) {
  const rows = Array.isArray(agingByBuildingRows) ? agingByBuildingRows : [];
  return {
    labels: rows.map((r) => r.building_code || r.building_name || ''),
    datasets: [
      {
        label: 'Chưa đến hạn',
        data: rows.map((r) => Number(r?.current_not_due || 0)),
        backgroundColor: '#94a3b8',
        borderRadius: 4,
      },
      {
        label: '1–15 ngày',
        data: rows.map((r) => Number(r?.bucket_0_15 || 0)),
        backgroundColor: '#38bdf8',
        borderRadius: 4,
      },
      {
        label: '16–30 ngày',
        data: rows.map((r) => Number(r?.bucket_16_30 || 0)),
        backgroundColor: '#fbbf24',
        borderRadius: 4,
      },
      {
        label: '31–60 ngày',
        data: rows.map((r) => Number(r?.bucket_31_60 || 0)),
        backgroundColor: '#f97316',
        borderRadius: 4,
      },
      {
        label: '>60 ngày',
        data: rows.map((r) => Number(r?.bucket_over_60 || 0)),
        backgroundColor: '#e11d48',
        borderRadius: 4,
      },
    ],
  };
}

// ─── Payments page (keep for PaymentsPage.jsx) ───────────────────────────────

export function resolvePaymentsUrlQuery(searchStr = '') {
  const params = new URLSearchParams(String(searchStr || ''));
  const rawTab = params.get('tab');
  const creditStatus = params.get('status') || '';
  const rawBucket = params.get('bucket') || '';
  const agingBucket = DASHBOARD_AGING_BUCKET_KEYS.includes(rawBucket) ? rawBucket : '';

  let tab = null;
  if (rawTab === 'aging' || agingBucket) {
    tab = 'aging';
  } else if (
    rawTab === 'credits' ||
    rawTab === 'refunds' ||
    creditStatus === 'PENDING_DIRECT_REFUND'
  ) {
    tab = 'credits';
  } else if (rawTab === 'overpayments' || rawTab === 'transactions') {
    tab = rawTab;
  }

  return {
    tab,
    agingBucket,
    creditStatus,
  };
}
