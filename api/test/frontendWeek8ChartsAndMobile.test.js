import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_SRC = path.resolve(__dirname, '../../frontend/src');

test('Task 3 — chartHelpers: empty-state detectors handle all-zero vs positive data accurately', async () => {
  const {
    hasRevenueChartData,
    hasAgingChartData,
    hasOccupancyChartData,
  } = await import('../../frontend/src/utils/chartHelpers.js');

  assert.equal(hasRevenueChartData([], []), false);
  assert.equal(
    hasRevenueChartData(
      [{ period: '2026-10', billed: 0, collected: 0, invoice_settled: 0 }],
      [{ period: '2026-10', rent: 0, electricity: 0, water: 0, service: 0, other: 0, total_billed: 0 }]
    ),
    false
  );
  assert.equal(
    hasRevenueChartData([{ period: '2026-10', billed: 5_000_000, collected: 0, invoice_settled: 0 }], []),
    true
  );

  assert.equal(hasAgingChartData(null), false);
  assert.equal(
    hasAgingChartData({
      total_debt: 0,
      buckets: [{ key: 'current_not_due', amount: 0, count: 0 }],
    }),
    false
  );
  assert.equal(
    hasAgingChartData({
      total_debt: 1_500_000,
      buckets: [{ key: '0_15', amount: 1_500_000, count: 1 }],
    }),
    true
  );

  assert.equal(hasOccupancyChartData(0, [{ period: '2026-10', exploitable: 0, occupancy_rate: 0 }]), false);
  assert.equal(hasOccupancyChartData(4, [{ period: '2026-10', exploitable: 4, occupancy_rate: 0 }]), true);
});

test('Task 3 — chartHelpers: revenue by source stacked datasets & PRD aging bucket builders', async () => {
  const {
    DASHBOARD_AGING_BUCKET_KEYS,
    buildRevenueTrendChartData,
    buildRevenueBySourceChartData,
    buildReceivablesAgingChartData,
    buildOccupancyTrendChartData,
    buildApartmentStatusDoughnutData,
    buildReportsBuildingAgingChartData,
    resolvePaymentsUrlQuery,
  } = await import('../../frontend/src/utils/chartHelpers.js');

  assert.deepEqual(DASHBOARD_AGING_BUCKET_KEYS, [
    'current_not_due',
    '0_15',
    '16_30',
    '31_60',
    'over_60',
  ]);

  const trend = buildRevenueTrendChartData([
    { period: '2026-10', billed: 10_000_000, invoice_settled: 8_000_000, collected: 7_500_000 },
  ]);
  assert.deepEqual(trend.labels, ['2026-10']);
  assert.equal(trend.datasets.length, 3);

  const srcChart = buildRevenueBySourceChartData([
    {
      period: '2026-10',
      rent: 6_000_000,
      electricity: 800_000,
      water: 200_000,
      service: 400_000,
      other: 100_000,
      total_billed: 7_500_000,
    },
  ]);
  assert.deepEqual(srcChart.labels, ['2026-10']);
  assert.equal(srcChart.datasets.length, 5);
  assert.ok(srcChart.datasets.every((ds) => ds.stack === 'revenue_source'));
  const sumAt0 = srcChart.datasets.reduce((sum, ds) => sum + ds.data[0], 0);
  assert.equal(sumAt0, 7_500_000);

  const aging = buildReceivablesAgingChartData({
    total_debt: 15_000_000,
    overdue_debt: 14_000_000,
    buckets: [
      { key: 'current_not_due', label: 'Chưa đến hạn', amount: 1_000_000, count: 1 },
      { key: '0_15', label: '1–15 ngày', amount: 2_000_000, count: 2 },
      { key: '16_30', label: '16–30 ngày', amount: 3_000_000, count: 1 },
      { key: '31_60', label: '31–60 ngày', amount: 4_000_000, count: 3 },
      { key: 'over_60', label: '>60 ngày', amount: 5_000_000, count: 1 },
    ],
  });
  assert.deepEqual(aging.bucketKeys, DASHBOARD_AGING_BUCKET_KEYS);
  assert.deepEqual(aging.counts, [1, 2, 1, 3, 1]);
  assert.deepEqual(aging.chartData.datasets[0].data, [
    1_000_000,
    2_000_000,
    3_000_000,
    4_000_000,
    5_000_000,
  ]);

  const occ = buildOccupancyTrendChartData([
    { period: '2026-09', occupied: 3, exploitable: 4, occupancy_rate: 75 },
    { period: '2026-10', occupied: 2, exploitable: 4, occupancy_rate: 50 },
  ]);
  assert.deepEqual(occ.chartData.labels, ['2026-09', '2026-10']);
  assert.deepEqual(occ.chartData.datasets[0].data, [75, 50]);
  assert.equal(occ.metaPoints[0].occupied, 3);

  const doughnut = buildApartmentStatusDoughnutData({
    OCCUPIED: 5,
    AVAILABLE: 3,
    RESERVED: 1,
    MAINTENANCE: 1,
    BLOCKED: 1,
    INACTIVE: 2,
  });
  assert.deepEqual(doughnut.datasets[0].data, [5, 3, 1, 1, 3]);

  const repAging = buildReportsBuildingAgingChartData([
    {
      building_code: 'BA',
      current_not_due: 500_000,
      bucket_0_15: 1_000_000,
      bucket_16_30: 2_000_000,
      bucket_31_60: 3_000_000,
      bucket_over_60: 4_000_000,
    },
  ]);
  assert.equal(repAging.datasets.length, 5);
  assert.deepEqual(
    repAging.datasets.map((d) => d.data[0]),
    [500_000, 1_000_000, 2_000_000, 3_000_000, 4_000_000]
  );

  assert.deepEqual(resolvePaymentsUrlQuery('?tab=aging&bucket=16_30'), {
    tab: 'aging',
    agingBucket: '16_30',
    creditStatus: '',
  });
  assert.deepEqual(resolvePaymentsUrlQuery('?tab=credits&status=PENDING_DIRECT_REFUND'), {
    tab: 'credits',
    agingBucket: '',
    creditStatus: 'PENDING_DIRECT_REFUND',
  });
  assert.deepEqual(resolvePaymentsUrlQuery('?tab=aging&bucket=INVALID_KEY'), {
    tab: 'aging',
    agingBucket: '',
    creditStatus: '',
  });
});

test('Task 3 — DashboardPage, ReportsPage, PaymentsPage & StatsCard source integration checks', () => {
  const dashSrc = fs.readFileSync(
    path.join(FRONTEND_SRC, 'pages/admin/dashboard/DashboardPage.jsx'),
    'utf8'
  );
  assert.ok(dashSrc.includes('BarElement'), 'DashboardPage must register BarElement in ChartJS');
  assert.ok(dashSrc.includes('<Bar'), 'DashboardPage must render Chart.js <Bar /> charts');
  assert.ok(dashSrc.includes('<EmptyState'), 'DashboardPage must render EmptyState fallbacks when chart data is zero');
  assert.ok(dashSrc.includes('/admin/payments?tab=aging&bucket='), 'DashboardPage aging chart must drill down to PaymentsPage aging bucket');

  const repSrc = fs.readFileSync(
    path.join(FRONTEND_SRC, 'pages/admin/reports/ReportsPage.jsx'),
    'utf8'
  );
  assert.ok(
    repSrc.includes('buildReportsBuildingAgingChartData'),
    'ReportsPage must use buildReportsBuildingAgingChartData for 5 PRD aging buckets'
  );
  assert.equal(
    repSrc.includes('bucket_61_90'),
    false,
    'ReportsPage must not plot legacy bucket_61_90'
  );
  assert.equal(
    repSrc.includes('bucket_over_90'),
    false,
    'ReportsPage must not plot legacy bucket_over_90'
  );

  const paySrc = fs.readFileSync(
    path.join(FRONTEND_SRC, 'pages/admin/payments/PaymentsPage.jsx'),
    'utf8'
  );
  assert.ok(
    paySrc.includes('resolvePaymentsUrlQuery'),
    'PaymentsPage must parse ?tab=aging&bucket=<key> via resolvePaymentsUrlQuery'
  );

  const statsSrc = fs.readFileSync(
    path.join(FRONTEND_SRC, 'components/common/StatsCard.jsx'),
    'utf8'
  );
  assert.ok(statsSrc.includes('tabIndex'), 'StatsCard must be keyboard focusable when clickable');
  assert.ok(statsSrc.includes('onKeyDown'), 'StatsCard must support Enter/Space activation');
  assert.equal(statsSrc.includes('truncate'), false, 'StatsCard must never truncate KPI values or subtext');
});
