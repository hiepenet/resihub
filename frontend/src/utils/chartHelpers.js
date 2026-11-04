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

export const REVENUE_COMPARISON_CHART_CONFIG = {
  billed: {
    label: 'Doanh thu phát hành',
    color: '#0ea5e9',
  },
  collected: {
    label: 'Tiền thực thu',
    color: '#10b981',
  },
};

export const REVENUE_SOURCE_CHART_CONFIG = {
  rent: {
    label: 'Tiền thuê phòng',
    color: '#0ea5e9',
  },
  electricity: {
    label: 'Tiền điện',
    color: '#f59e0b',
  },
  water: {
    label: 'Tiền nước',
    color: '#06b6d4',
  },
  service: {
    label: 'Phí dịch vụ',
    color: '#10b981',
  },
  other: {
    label: 'Phí trễ hạn & Khác',
    color: '#8b5cf6',
  },
};

export const AGING_BUCKETS_CHART_CONFIG = Object.fromEntries(
  DASHBOARD_AGING_BUCKET_META.map((m) => [
    m.key,
    { label: m.label, color: m.color },
  ])
);

export const OCCUPANCY_BAR_CHART_CONFIG = {
  occupancy_rate: {
    label: 'Tỷ lệ lấp đầy (%)',
    color: '#0ea5e9',
  },
};

const SAFE_CSS_COLOR_RE =
  /^(#[0-9a-fA-F]{3,8}|(?:rgb|rgba|hsl|hsla|oklch)\([0-9a-zA-Z.,%\s/-]+\)|var\(--[a-zA-Z0-9_-]+\))$/;

export function sanitizeChartKey(key = '') {
  return String(key || '').replace(/[^a-zA-Z0-9_-]/g, '');
}

export function buildChartCssVariables(chartId = '', config = {}) {
  const safeId = sanitizeChartKey(chartId);
  if (!safeId || !config || typeof config !== 'object') return '';

  const declarations = [];
  for (const [rawKey, item] of Object.entries(config)) {
    const safeKey = sanitizeChartKey(rawKey);
    const rawColor = typeof item?.color === 'string' ? item.color.trim() : '';
    if (!safeKey || !rawColor || !SAFE_CSS_COLOR_RE.test(rawColor)) continue;
    declarations.push(`  --color-${safeKey}: ${rawColor};`);
  }

  if (declarations.length === 0) return '';
  return `[data-chart="${safeId}"] {\n${declarations.join('\n')}\n}`;
}

function toNonNegativeNumber(val) {
  const n = Number(val);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function hasRevenueChartData(
  revenueSeries = [],
  sourceSeries = [],
  mode = ''
) {
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
        Number(s?.total_billed || 0) > 0 ||
        Number(s?.rent || 0) > 0 ||
        Number(s?.electricity || 0) > 0 ||
        Number(s?.water || 0) > 0 ||
        Number(s?.service || 0) > 0 ||
        Number(s?.other || 0) > 0
    );

  if (mode === 'comparison') return revHasPositive;
  if (mode === 'source') return srcHasPositive;
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

export function buildRevenueComparisonBarRows(revenueSeries = []) {
  const rows = Array.isArray(revenueSeries) ? revenueSeries : [];
  return rows.map((r) => ({
    period: String(r?.period || r?.month || ''),
    billed: toNonNegativeNumber(r?.billed),
    collected: toNonNegativeNumber(r?.collected),
    invoice_settled: toNonNegativeNumber(r?.invoice_settled),
  }));
}

export const REVENUE_SOURCE_KEYS = [
  'rent',
  'electricity',
  'water',
  'service',
  'other',
];

export function getTopRevenueSourceKey(row = {}) {
  for (let i = REVENUE_SOURCE_KEYS.length - 1; i >= 0; i -= 1) {
    const k = REVENUE_SOURCE_KEYS[i];
    if (Number(row?.[k] || 0) > 0) return k;
  }
  return '';
}

export function buildRevenueSourceBarRows(sourceSeries = []) {
  const rows = Array.isArray(sourceSeries) ? sourceSeries : [];
  return rows.map((r) => {
    const rent = toNonNegativeNumber(r?.rent);
    const electricity = toNonNegativeNumber(r?.electricity);
    const water = toNonNegativeNumber(r?.water);
    const service = toNonNegativeNumber(r?.service);
    const other = toNonNegativeNumber(r?.other);
    const sum = rent + electricity + water + service + other;
    const explicitTotal = Number(r?.total_billed);
    return {
      period: String(r?.period || ''),
      rent,
      electricity,
      water,
      service,
      other,
      total_billed:
        Number.isFinite(explicitTotal) && explicitTotal > 0 ? explicitTotal : sum,
    };
  });
}

export function buildReceivablesAgingBarRows(receivablesAging = {}) {
  const rawBuckets = Array.isArray(receivablesAging?.buckets)
    ? receivablesAging.buckets
    : [];
  const byKey = new Map(
    rawBuckets
      .filter((b) => b && typeof b === 'object' && b.key)
      .map((b) => [b.key, b])
  );

  return DASHBOARD_AGING_BUCKET_META.map((meta) => {
    const matched = byKey.get(meta.key);
    const safeKey = sanitizeChartKey(meta.key);
    return {
      key: meta.key,
      label: matched?.label || meta.label,
      amount: toNonNegativeNumber(matched?.amount),
      count: toNonNegativeNumber(matched?.count),
      fill: `var(--color-${safeKey})`,
    };
  });
}

export function resolveAgingBarBucketKey(barItem, index, rows = []) {
  const candidate =
    barItem?.payload?.key ??
    barItem?.key ??
    (Array.isArray(rows) && Number.isInteger(index) ? rows[index]?.key : '');
  return DASHBOARD_AGING_BUCKET_KEYS.includes(candidate) ? candidate : '';
}

export function buildOccupancyBarRows(occupancySeries = []) {
  const rows = Array.isArray(occupancySeries) ? occupancySeries : [];
  return rows.map((r) => {
    const rawRate = Number(r?.occupancy_rate);
    const clampedRate = Number.isFinite(rawRate)
      ? Math.min(100, Math.max(0, rawRate))
      : 0;
    return {
      period: String(r?.period || ''),
      occupied: toNonNegativeNumber(r?.occupied),
      exploitable: toNonNegativeNumber(r?.exploitable),
      occupancy_rate: clampedRate,
    };
  });
}

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
