import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_SRC = path.resolve(__dirname, '../../frontend/src');

test('Task 1 — Chart.js chartHelpers exports buildRevenueTrendChartData, buildReceivablesAgingChartData, buildOccupancyTrendChartData', async () => {
  const {
    DASHBOARD_AGING_BUCKET_KEYS,
    DASHBOARD_AGING_BUCKET_META,
    buildRevenueTrendChartData,
    buildRevenueBySourceChartData,
    buildReceivablesAgingChartData,
    buildOccupancyTrendChartData,
  } = await import('../../frontend/src/utils/chartHelpers.js');

  assert.equal(typeof buildRevenueTrendChartData, 'function');
  assert.equal(typeof buildRevenueBySourceChartData, 'function');
  assert.equal(typeof buildReceivablesAgingChartData, 'function');
  assert.equal(typeof buildOccupancyTrendChartData, 'function');

  // Revenue trend: 3 datasets for Line chart
  const trendResult = buildRevenueTrendChartData([
    { period: '2026-10', billed: 1000, collected: 900, invoice_settled: 800 },
  ]);
  assert.deepEqual(trendResult.labels, ['2026-10']);
  assert.equal(trendResult.datasets.length, 3);
  assert.equal(trendResult.datasets[0].label, 'Phát hành');
  assert.equal(trendResult.datasets[2].label, 'Thực thu');
  assert.equal(trendResult.datasets[0].data[0], 1000);
  assert.equal(trendResult.datasets[2].data[0], 900);

  // Aging: bucketKeys matches DASHBOARD_AGING_BUCKET_KEYS
  const agingResult = buildReceivablesAgingChartData({
    buckets: [{ key: '0_15', amount: 500, count: 1 }],
  });
  assert.deepEqual(agingResult.bucketKeys, DASHBOARD_AGING_BUCKET_KEYS);

  // Occupancy: metaPoints match per row
  const occResult = buildOccupancyTrendChartData([
    { period: '2026-10', occupied: 3, exploitable: 4, occupancy_rate: 75 },
  ]);
  assert.deepEqual(occResult.metaPoints[0], { occupied: 3, exploitable: 4 });
  assert.equal(occResult.chartData.datasets[0].data[0], 75);

  // Unused Recharts exports must NOT exist
  const mod = await import('../../frontend/src/utils/chartHelpers.js');
  assert.equal(mod.sanitizeChartKey, undefined, 'sanitizeChartKey must not be exported');
  assert.equal(mod.buildChartCssVariables, undefined, 'buildChartCssVariables must not be exported');
  assert.equal(mod.REVENUE_COMPARISON_CHART_CONFIG, undefined, 'REVENUE_COMPARISON_CHART_CONFIG must not be exported');
  assert.equal(mod.OCCUPANCY_BAR_CHART_CONFIG, undefined, 'OCCUPANCY_BAR_CHART_CONFIG must not be exported');
  assert.equal(mod.resolveAgingBarBucketKey, undefined, 'resolveAgingBarBucketKey must not be exported');
  assert.equal(mod.buildReceivablesAgingBarRows, undefined, 'buildReceivablesAgingBarRows must not be exported');
  assert.equal(mod.buildOccupancyBarRows, undefined, 'buildOccupancyBarRows must not be exported');

  // DASHBOARD_AGING_BUCKET_META still present
  assert.equal(DASHBOARD_AGING_BUCKET_META.length, 5);
});

test('Task 1 — buildRevenueBySourceChartData maps 5 RP-01 source datasets with stack id', async () => {
  const {
    buildRevenueBySourceChartData,
  } = await import('../../frontend/src/utils/chartHelpers.js');

  const result = buildRevenueBySourceChartData([
    {
      period: '2026-10',
      rent: 6_000_000,
      electricity: 800_000,
      water: 200_000,
      service: 400_000,
      other: 100_000,
    },
  ]);
  assert.deepEqual(result.labels, ['2026-10']);
  assert.equal(result.datasets.length, 5);
  assert.deepEqual(
    result.datasets.map((d) => d.label),
    ['Tiền thuê phòng', 'Tiền điện', 'Tiền nước', 'Phí dịch vụ', 'Phí trễ hạn & Khác']
  );
  result.datasets.forEach((ds) => {
    assert.equal(ds.stack, 'revenue_source', `Dataset "${ds.label}" must have stack: 'revenue_source'`);
  });

  // Negative/NaN clamped to 0
  const badResult = buildRevenueBySourceChartData([
    { period: '2026-11', rent: -100, electricity: undefined, water: NaN, service: 0, other: 50_000 },
  ]);
  assert.equal(badResult.datasets[0].data[0], 0, 'rent -100 must clamp to 0');
  assert.equal(badResult.datasets[1].data[0], 0, 'undefined electricity must clamp to 0');
  assert.equal(badResult.datasets[2].data[0], 0, 'NaN water must clamp to 0');
  assert.equal(badResult.datasets[4].data[0], 50_000, 'other 50000 must pass through');
});

test('Task 1 — buildReceivablesAgingChartData maps 5 PRD buckets, colors and counts', async () => {
  const {
    DASHBOARD_AGING_BUCKET_KEYS,
    buildReceivablesAgingChartData,
  } = await import('../../frontend/src/utils/chartHelpers.js');

  const { bucketKeys, counts, chartData } = buildReceivablesAgingChartData({
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

  assert.deepEqual(bucketKeys, DASHBOARD_AGING_BUCKET_KEYS);
  assert.deepEqual(chartData.datasets[0].data, [1_000_000, 2_000_000, 3_000_000, 4_000_000, 5_000_000]);
  assert.deepEqual(counts, [1, 2, 1, 3, 1]);
  // Color for index 1 (0_15) must be #38bdf8
  assert.equal(chartData.datasets[0].backgroundColor[1], '#38bdf8');

  // Null/undefined elements inside buckets must not throw TypeError
  const safeResult = buildReceivablesAgingChartData({
    total_debt: 2_000_000,
    buckets: [null, undefined, { key: '0_15', amount: 2_000_000, count: 1 }],
  });
  assert.equal(safeResult.chartData.datasets[0].data[1], 2_000_000);
});

test('Task 1 — buildOccupancyTrendChartData clamps rate [0,100] and Chart.jsx is deleted', async () => {
  const {
    buildOccupancyTrendChartData,
  } = await import('../../frontend/src/utils/chartHelpers.js');

  const { metaPoints, chartData } = buildOccupancyTrendChartData([
    { period: '2026-08', occupied: 3, exploitable: 4, occupancy_rate: 75 },
    { period: '2026-09', occupied: 5, exploitable: 4, occupancy_rate: 125 },
    { period: '2026-10', occupied: 0, exploitable: 0, occupancy_rate: NaN },
  ]);

  assert.deepEqual(chartData.datasets[0].data, [75, 100, 0]);
  assert.deepEqual(metaPoints, [
    { occupied: 3, exploitable: 4 },
    { occupied: 5, exploitable: 4 },
    { occupied: 0, exploitable: 0 },
  ]);

  // Chart.jsx must NOT exist (deleted in Task 2)
  const chartUiPath = path.join(FRONTEND_SRC, 'components/ui/Chart.jsx');
  assert.equal(fs.existsSync(chartUiPath), false, 'Shadcn Chart.jsx must be deleted — no longer used');
});

test('Task 2 — DashboardPage uses strictly Chart.js Line/Bar charts aligned with PRD 15.1-15.3', () => {
  const dashSrc = fs.readFileSync(
    path.join(FRONTEND_SRC, 'pages/admin/dashboard/DashboardPage.jsx'),
    'utf8'
  );

  // Must NOT use recharts or Shadcn chart primitives
  assert.equal(dashSrc.includes("from 'recharts'"), false, 'DashboardPage must not import from recharts');
  assert.equal(dashSrc.includes('ChartContainer'), false, 'DashboardPage must not use Shadcn ChartContainer');
  assert.equal(dashSrc.includes('<BarChart'), false, 'DashboardPage must not render Recharts <BarChart>');
  assert.equal(dashSrc.includes('Doughnut'), false, 'DashboardPage must not render Doughnut chart');
  assert.equal(dashSrc.includes('PieChart'), false, 'DashboardPage must not render PieChart');
  assert.equal(
    dashSrc.includes('Cơ cấu trạng thái căn hộ'),
    false,
    'DashboardPage must remove the unrelated Apartment Status Doughnut card'
  );

  // Must use Chart.js
  assert.ok(dashSrc.includes("from 'react-chartjs-2'"), 'DashboardPage must import from react-chartjs-2');
  assert.ok(dashSrc.includes('ChartJS.register'), 'DashboardPage must register Chart.js components');
  assert.ok(dashSrc.includes('<Line'), 'DashboardPage must render Chart.js <Line>');
  assert.ok(dashSrc.includes('<Bar'), 'DashboardPage must render Chart.js <Bar>');

  // At least 2 Line charts (revenue trend + occupancy)
  const lineCount = (dashSrc.match(/<Line\b/g) || []).length;
  assert.ok(lineCount >= 2, `DashboardPage must render at least 2 <Line> charts, got ${lineCount}`);

  // Chart section identifiers
  assert.ok(dashSrc.includes('id="dashboard-revenue"'), 'Must include Revenue chart id');
  assert.ok(dashSrc.includes('id="dashboard-aging"'), 'Must include Debt Aging chart id');
  assert.ok(dashSrc.includes('id="dashboard-occupancy"'), 'Must include Occupancy chart id');

  // PRD 15.3 drill-downs
  assert.ok(
    dashSrc.includes('/admin/payments?tab=aging&bucket='),
    'Aging chart must drill down to PaymentsPage aging bucket'
  );

  // EmptyState fallbacks and VND formatting
  assert.ok(dashSrc.includes('<EmptyState'), 'DashboardPage must keep EmptyState fallbacks');
  assert.ok(dashSrc.includes('formatMoney('), 'DashboardPage tooltips must format money in full VND');
});

test('Final Review — 2-param hasRevenueChartData, null-safe aging buckets, DashboardPage uses 2-param call', async () => {
  const {
    hasRevenueChartData,
    buildReceivablesAgingChartData,
  } = await import('../../frontend/src/utils/chartHelpers.js');

  // invoice_settled-only row must NOT trigger chart display (billed=0, collected=0)
  assert.equal(
    hasRevenueChartData(
      [{ period: '2026-10', billed: 0, collected: 0, invoice_settled: 3_000_000 }],
      []
    ),
    false
  );

  // collected > 0 with zero sources → hasRevenue = true
  assert.equal(
    hasRevenueChartData(
      [{ period: '2026-10', billed: 0, collected: 4_000_000, invoice_settled: 0 }],
      [{ period: '2026-10', rent: 0, electricity: 0, water: 0, service: 0, other: 0 }]
    ),
    true
  );

  // Both zero → false
  assert.equal(
    hasRevenueChartData([], []),
    false
  );

  // Null/undefined elements inside receivablesAging.buckets must not throw TypeError
  const agingRows = buildReceivablesAgingChartData({
    total_debt: 2_000_000,
    buckets: [null, undefined, { key: '0_15', amount: 2_000_000, count: 1 }],
  });
  assert.equal(agingRows.chartData.datasets[0].data[1], 2_000_000);

  // DashboardPage must use 2-param call (no revenueMode 3rd arg)
  const dashSrc = fs.readFileSync(
    path.join(FRONTEND_SRC, 'pages/admin/dashboard/DashboardPage.jsx'),
    'utf8'
  );
  assert.ok(
    dashSrc.includes('hasRevenueChartData(rev12m, revBySource)'),
    'DashboardPage must call hasRevenueChartData with 2 params (rev12m, revBySource)'
  );
});
