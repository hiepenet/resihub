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

test('Task 4 — residentNavHelpers: 4 primary + 4 secondary mobile tabs, unread badge & <=2 tap budget', async () => {
  const {
    PRIMARY_RESIDENT_MOBILE_TAB_IDS,
    SECONDARY_RESIDENT_MOBILE_TAB_IDS,
    resolveResidentMobileNavState,
    getResidentActionTapCount,
  } = await import('../../frontend/src/utils/residentNavHelpers.js');

  assert.deepEqual(PRIMARY_RESIDENT_MOBILE_TAB_IDS, [
    'overview',
    'invoices',
    'maintenance',
    'services',
  ]);
  assert.deepEqual(SECONDARY_RESIDENT_MOBILE_TAB_IDS, [
    'contract',
    'notifications',
    'contact',
    'profile',
  ]);

  const stNotif = resolveResidentMobileNavState({
    activeTab: 'notifications',
    unreadCount: 5,
  });
  assert.equal(stNotif.primaryTabs.length, 4);
  assert.equal(stNotif.secondaryTabs.length, 4);
  assert.equal(stNotif.isMoreActive, true);
  assert.equal(stNotif.moreBadgeCount, 5);
  assert.equal(stNotif.activeSecondaryTab?.id, 'notifications');

  const stInvZero = resolveResidentMobileNavState({
    activeTab: 'invoices',
    unreadCount: 0,
  });
  assert.equal(stInvZero.isMoreActive, false);
  assert.equal(stInvZero.moreBadgeCount, 0);
  assert.equal(stInvZero.activeSecondaryTab, null);

  const stInvUnread = resolveResidentMobileNavState({
    activeTab: 'invoices',
    unreadCount: 3,
  });
  assert.equal(stInvUnread.isMoreActive, false);
  assert.equal(stInvUnread.moreBadgeCount, 3);

  assert.equal(getResidentActionTapCount('view_invoices'), 1);
  assert.equal(getResidentActionTapCount('view_maintenance'), 1);
  assert.ok(getResidentActionTapCount('pay_invoice') <= 2);
  assert.ok(getResidentActionTapCount('create_maintenance') <= 2);
  assert.ok(getResidentActionTapCount('open_secondary_tab') <= 2);
});

test('Task 4 — Mobile-first Resident Portal, safe-area, 44px touch targets & WCAG a11y source checks', () => {
  const indexHtml = fs.readFileSync(
    path.resolve(__dirname, '../../frontend/index.html'),
    'utf8'
  );
  assert.ok(
    indexHtml.includes('viewport-fit=cover'),
    'index.html must include viewport-fit=cover for mobile safe areas'
  );

  const indexCss = fs.readFileSync(path.join(FRONTEND_SRC, 'index.css'), 'utf8');
  assert.ok(indexCss.includes('.pb-safe'), 'index.css must define .pb-safe');
  assert.ok(
    indexCss.includes('env(safe-area-inset-bottom'),
    'index.css must use env(safe-area-inset-bottom)'
  );

  const layoutSrc = fs.readFileSync(
    path.join(FRONTEND_SRC, 'components/layout/ResidentLayout.jsx'),
    'utf8'
  );
  assert.ok(
    layoutSrc.includes('resolveResidentMobileNavState'),
    'ResidentLayout must use resolveResidentMobileNavState'
  );
  assert.ok(
    layoutSrc.includes('grid-cols-5'),
    'ResidentLayout mobile bottom bar must use 5-column thumb grid'
  );
  assert.ok(
    layoutSrc.includes('min-h-[56px]'),
    'ResidentLayout mobile bottom bar must enforce >= 56px bar height'
  );
  assert.ok(
    layoutSrc.includes('pb-safe'),
    'ResidentLayout mobile bottom bar must respect iOS/Android safe area'
  );
  assert.equal(
    /<nav[^>]*overflow-x-auto/.test(layoutSrc),
    false,
    'ResidentLayout mobile bottom bar must not horizontally scroll 8 tabs'
  );

  const inputSrc = fs.readFileSync(
    path.join(FRONTEND_SRC, 'components/ui/Input.jsx'),
    'utf8'
  );
  assert.ok(inputSrc.includes('text-base sm:text-sm'), 'Input must prevent mobile iOS auto-zoom');
  assert.ok(inputSrc.includes('min-h-[44px]'), 'Input must have >=44px mobile touch height');
  assert.ok(inputSrc.includes('aria-invalid'), 'Input must expose aria-invalid');
  assert.ok(inputSrc.includes('aria-describedby'), 'Input must expose aria-describedby');

  const moneySrc = fs.readFileSync(
    path.join(FRONTEND_SRC, 'components/ui/MoneyInput.jsx'),
    'utf8'
  );
  assert.ok(moneySrc.includes('text-base sm:text-sm'), 'MoneyInput must prevent mobile iOS auto-zoom');
  assert.ok(moneySrc.includes('min-h-[44px]'), 'MoneyInput must have >=44px mobile touch height');
  assert.ok(moneySrc.includes('aria-invalid'), 'MoneyInput must expose aria-invalid');
  assert.ok(moneySrc.includes('aria-describedby'), 'MoneyInput must expose aria-describedby');

  const modalSrc = fs.readFileSync(
    path.join(FRONTEND_SRC, 'components/ui/Modal.jsx'),
    'utf8'
  );
  assert.ok(modalSrc.includes('role="dialog"'), 'Modal must declare role="dialog"');
  assert.ok(modalSrc.includes('aria-modal="true"'), 'Modal must declare aria-modal="true"');
  assert.ok(modalSrc.includes('aria-labelledby'), 'Modal must link title via aria-labelledby');
  assert.ok(
    modalSrc.includes('items-end sm:items-center'),
    'Modal must render as bottom-sheet on mobile (<640px)'
  );
  assert.ok(modalSrc.includes('aria-label='), 'Modal close buttons must have aria-label');

  const tabsSrc = fs.readFileSync(
    path.join(FRONTEND_SRC, 'components/ui/Tabs.jsx'),
    'utf8'
  );
  assert.ok(tabsSrc.includes('role="tablist"'), 'Tabs container must have role="tablist"');
  assert.ok(tabsSrc.includes('role="tab"'), 'Tab buttons must have role="tab"');
  assert.ok(tabsSrc.includes('aria-selected'), 'Tab buttons must have aria-selected');
  assert.ok(tabsSrc.includes('min-h-[44px]'), 'Tab buttons must meet 44px touch target on mobile');

  const overviewSrc = fs.readFileSync(
    path.join(FRONTEND_SRC, 'pages/resident/tabs/OverviewTab.jsx'),
    'utf8'
  );
  assert.ok(
    overviewSrc.includes("action: 'pay'"),
    'OverviewTab must offer 2-tap quick action to pay invoice'
  );
  assert.ok(
    overviewSrc.includes("action: 'new'"),
    'OverviewTab must offer 2-tap quick action to report breakdown'
  );
});
