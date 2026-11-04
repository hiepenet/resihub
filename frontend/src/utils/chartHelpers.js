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

export function hasRevenueChartData(revenueSeries = [], sourceSeries = []) {
  const revHasPositive =
    Array.isArray(revenueSeries) &&
    revenueSeries.some(
      (r) =>
        Number(r?.billed || 0) > 0 ||
        Number(r?.collected || 0) > 0 ||
        Number(r?.invoice_settled || 0) > 0
    );
  if (revHasPositive) return true;

  return (
    Array.isArray(sourceSeries) &&
    sourceSeries.some(
      (s) =>
        Number(s?.total_billed || 0) > 0 ||
        Number(s?.rent || 0) > 0 ||
        Number(s?.electricity || 0) > 0 ||
        Number(s?.water || 0) > 0 ||
        Number(s?.service || 0) > 0 ||
        Number(s?.other || 0) > 0
    )
  );
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

export function buildRevenueTrendChartData(revenueSeries = []) {
  const rows = Array.isArray(revenueSeries) ? revenueSeries : [];
  return {
    labels: rows.map((r) => r.period || r.month || ''),
    datasets: [
      {
        label: 'Phát hành (Billed)',
        data: rows.map((r) => Number(r?.billed || 0)),
        borderColor: '#6366f1',
        borderDash: [5, 5],
        backgroundColor: 'transparent',
        tension: 0.35,
        pointRadius: 2,
      },
      {
        label: 'Tất toán hóa đơn (Invoice Settled)',
        data: rows.map((r) => Number(r?.invoice_settled || 0)),
        borderColor: '#10b981',
        backgroundColor: 'transparent',
        tension: 0.35,
        pointRadius: 3,
      },
      {
        label: 'Thực thu ròng (Collected)',
        data: rows.map((r) => Number(r?.collected || 0)),
        borderColor: '#0ea5e9',
        backgroundColor: 'rgba(14, 165, 233, 0.12)',
        fill: true,
        tension: 0.35,
        pointRadius: 3,
      },
    ],
  };
}

export function buildRevenueBySourceChartData(sourceSeries = []) {
  const rows = Array.isArray(sourceSeries) ? sourceSeries : [];
  return {
    labels: rows.map((r) => r.period || ''),
    datasets: [
      {
        label: 'Tiền phòng',
        data: rows.map((r) => Number(r?.rent || 0)),
        backgroundColor: '#0ea5e9',
        stack: 'revenue_source',
        borderRadius: 2,
      },
      {
        label: 'Điện',
        data: rows.map((r) => Number(r?.electricity || 0)),
        backgroundColor: '#f59e0b',
        stack: 'revenue_source',
        borderRadius: 2,
      },
      {
        label: 'Nước',
        data: rows.map((r) => Number(r?.water || 0)),
        backgroundColor: '#06b6d4',
        stack: 'revenue_source',
        borderRadius: 2,
      },
      {
        label: 'Dịch vụ',
        data: rows.map((r) => Number(r?.service || 0)),
        backgroundColor: '#10b981',
        stack: 'revenue_source',
        borderRadius: 2,
      },
      {
        label: 'Phí trễ hạn & Khác',
        data: rows.map((r) => Number(r?.other || 0)),
        backgroundColor: '#8b5cf6',
        stack: 'revenue_source',
        borderRadius: 2,
      },
    ],
  };
}

export function buildReceivablesAgingChartData(receivablesAging = {}) {
  const rawBuckets = Array.isArray(receivablesAging?.buckets)
    ? receivablesAging.buckets
    : [];
  const byKey = new Map(rawBuckets.map((b) => [b.key, b]));

  const bucketKeys = DASHBOARD_AGING_BUCKET_META.map((m) => m.key);
  const labels = DASHBOARD_AGING_BUCKET_META.map(
    (m) => byKey.get(m.key)?.label || m.label
  );
  const amounts = DASHBOARD_AGING_BUCKET_META.map((m) =>
    Number(byKey.get(m.key)?.amount || 0)
  );
  const counts = DASHBOARD_AGING_BUCKET_META.map((m) =>
    Number(byKey.get(m.key)?.count || 0)
  );
  const colors = DASHBOARD_AGING_BUCKET_META.map((m) => m.color);

  return {
    bucketKeys,
    counts,
    chartData: {
      labels,
      datasets: [
        {
          label: 'Dư nợ chưa thu',
          data: amounts,
          backgroundColor: colors,
          borderRadius: 6,
          maxBarThickness: 48,
        },
      ],
    },
  };
}

export function buildOccupancyTrendChartData(occupancySeries = []) {
  const rows = Array.isArray(occupancySeries) ? occupancySeries : [];
  const metaPoints = rows.map((r) => ({
    period: r.period || '',
    occupied: Number(r?.occupied || 0),
    exploitable: Number(r?.exploitable || 0),
    occupancy_rate: Number(r?.occupancy_rate || 0),
  }));

  return {
    metaPoints,
    chartData: {
      labels: metaPoints.map((m) => m.period),
      datasets: [
        {
          label: 'Tỷ lệ lấp đầy (%)',
          data: metaPoints.map((m) => m.occupancy_rate),
          borderColor: '#0ea5e9',
          backgroundColor: 'rgba(14, 165, 233, 0.14)',
          fill: true,
          tension: 0.35,
          pointRadius: 3,
        },
      ],
    },
  };
}

export function buildApartmentStatusDoughnutData(breakdown = {}) {
  const b = breakdown || {};
  return {
    labels: ['Đang thuê', 'Còn trống', 'Đã giữ chỗ', 'Đang bảo trì', 'Ngưng khai thác'],
    datasets: [
      {
        data: [
          Number(b.OCCUPIED || 0),
          Number(b.AVAILABLE || 0),
          Number(b.RESERVED || 0),
          Number(b.MAINTENANCE || 0),
          Number(b.BLOCKED || 0) + Number(b.INACTIVE || 0),
        ],
        backgroundColor: ['#f43f5e', '#10b981', '#f59e0b', '#64748b', '#a855f7'],
        borderWidth: 2,
        borderColor: '#ffffff',
      },
    ],
  };
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
