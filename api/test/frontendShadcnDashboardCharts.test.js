import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_SRC = path.resolve(__dirname, '../../frontend/src');

test('Task 1 — Shadcn CSS variable generator handles numeric keys (0_15) and rejects unsafe CSS injection', async () => {
  const {
    sanitizeChartKey,
    buildChartCssVariables,
    AGING_BUCKETS_CHART_CONFIG,
  } = await import('../../frontend/src/utils/chartHelpers.js');

  assert.equal(sanitizeChartKey('0_15'), '0_15');
  assert.equal(sanitizeChartKey('current_not_due'), 'current_not_due');
  assert.equal(sanitizeChartKey('bad;key{}<>'), 'badkey');

  const css = buildChartCssVariables('chart-aging', AGING_BUCKETS_CHART_CONFIG);
  assert.ok(css.includes('[data-chart="chart-aging"]'));
  assert.ok(css.includes('--color-current_not_due: #94a3b8;'));
  assert.ok(css.includes('--color-0_15: #38bdf8;'));
  assert.ok(css.includes('--color-over_60: #e11d48;'));

  // Malicious color payload must be stripped/ignored so <style> cannot break out
  const unsafeCss = buildChartCssVariables('chart-evil"><script>', {
    hacked: { label: 'Evil', color: 'red; } body { display: none } /*' },
    valid: { label: 'Safe', color: '#10b981' },
  });
  assert.equal(unsafeCss.includes('<script>'), false);
  assert.equal(unsafeCss.includes('display: none'), false);
  assert.ok(unsafeCss.includes('--color-valid: #10b981;'));
});

test('Task 1 — Recharts revenue bar builders map PRD 15.3 billed/collected and 5 RP-01 sources safely', async () => {
  const {
    REVENUE_COMPARISON_CHART_CONFIG,
    REVENUE_SOURCE_CHART_CONFIG,
    buildRevenueComparisonBarRows,
    buildRevenueSourceBarRows,
  } = await import('../../frontend/src/utils/chartHelpers.js');

  assert.ok(REVENUE_COMPARISON_CHART_CONFIG.billed?.color);
  assert.ok(REVENUE_COMPARISON_CHART_CONFIG.collected?.color);
  assert.deepEqual(Object.keys(REVENUE_SOURCE_CHART_CONFIG), [
    'rent',
    'electricity',
    'water',
    'service',
    'other',
  ]);

  const compRows = buildRevenueComparisonBarRows([
    { period: '2026-09', billed: 12_000_000, collected: 10_500_000, invoice_settled: 10_000_000 },
    { period: '2026-10', billed: NaN, collected: -500, invoice_settled: null },
  ]);
  assert.deepEqual(compRows, [
    {
      period: '2026-09',
      billed: 12_000_000,
      collected: 10_500_000,
      invoice_settled: 10_000_000,
    },
    {
      period: '2026-10',
      billed: 0,
      collected: 0,
      invoice_settled: 0,
    },
  ]);

  const srcRows = buildRevenueSourceBarRows([
    {
      period: '2026-10',
      rent: 6_000_000,
      electricity: 800_000,
      water: 200_000,
      service: 400_000,
      other: 100_000,
      total_billed: 7_500_000,
    },
    {
      period: '2026-11',
      rent: -100,
      electricity: undefined,
      water: NaN,
      service: 0,
      other: 50_000,
    },
  ]);
  assert.equal(srcRows[0].total_billed, 7_500_000);
  assert.equal(
    srcRows[0].rent +
      srcRows[0].electricity +
      srcRows[0].water +
      srcRows[0].service +
      srcRows[0].other,
    7_500_000
  );
  assert.deepEqual(srcRows[1], {
    period: '2026-11',
    rent: 0,
    electricity: 0,
    water: 0,
    service: 0,
    other: 50_000,
    total_billed: 50_000,
  });
});

test('Task 1 — Recharts aging bar builder maps 5 PRD buckets and resolves Recharts v3 click payloads', async () => {
  const {
    DASHBOARD_AGING_BUCKET_KEYS,
    buildReceivablesAgingBarRows,
    resolveAgingBarBucketKey,
  } = await import('../../frontend/src/utils/chartHelpers.js');

  const rows = buildReceivablesAgingBarRows({
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

  assert.deepEqual(
    rows.map((r) => r.key),
    DASHBOARD_AGING_BUCKET_KEYS
  );
  assert.deepEqual(
    rows.map((r) => r.amount),
    [1_000_000, 2_000_000, 3_000_000, 4_000_000, 5_000_000]
  );
  assert.deepEqual(
    rows.map((r) => r.count),
    [1, 2, 1, 3, 1]
  );
  assert.equal(rows[1].fill, 'var(--color-0_15)');

  // Recharts v3 BarRectangleItem shape: { payload: row }
  assert.equal(resolveAgingBarBucketKey({ payload: { key: '16_30' } }, 2, rows), '16_30');
  // Direct datum shape: { key: 'over_60' }
  assert.equal(resolveAgingBarBucketKey({ key: 'over_60' }, 4, rows), 'over_60');
  // Index fallback
  assert.equal(resolveAgingBarBucketKey(null, 1, rows), '0_15');
  // Unknown bucket key rejected
  assert.equal(resolveAgingBarBucketKey({ payload: { key: '999_days' } }, 99, rows), '');
});

test('Task 1 — Recharts occupancy bar builder clamps occupancy_rate to [0, 100] and UI Chart.jsx exists', async () => {
  const {
    OCCUPANCY_BAR_CHART_CONFIG,
    buildOccupancyBarRows,
  } = await import('../../frontend/src/utils/chartHelpers.js');

  assert.ok(OCCUPANCY_BAR_CHART_CONFIG.occupancy_rate?.color);

  const occRows = buildOccupancyBarRows([
    { period: '2026-08', occupied: 3, exploitable: 4, occupancy_rate: 75 },
    { period: '2026-09', occupied: 5, exploitable: 4, occupancy_rate: 125 },
    { period: '2026-10', occupied: 0, exploitable: 0, occupancy_rate: NaN },
  ]);

  assert.deepEqual(occRows, [
    { period: '2026-08', occupied: 3, exploitable: 4, occupancy_rate: 75 },
    { period: '2026-09', occupied: 5, exploitable: 4, occupancy_rate: 100 },
    { period: '2026-10', occupied: 0, exploitable: 0, occupancy_rate: 0 },
  ]);

  const chartUiPath = path.join(FRONTEND_SRC, 'components/ui/Chart.jsx');
  assert.equal(fs.existsSync(chartUiPath), true, 'Shadcn Chart.jsx primitive component must exist');
  const chartUiSrc = fs.readFileSync(chartUiPath, 'utf8');
  assert.ok(chartUiSrc.includes('export function ChartContainer'));
  assert.ok(chartUiSrc.includes('export function ChartTooltipContent'));
  assert.ok(chartUiSrc.includes('export function ChartLegendContent'));
  assert.ok(chartUiSrc.includes('ResponsiveContainer'));
});
