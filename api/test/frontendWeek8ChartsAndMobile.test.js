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

test('Task 3 — chartHelpers: PRD Chart.js builders, ReportsPage building aging & Payments URL query builders', async () => {
  const {
    DASHBOARD_AGING_BUCKET_KEYS,
    buildRevenueTrendChartData,
    buildRevenueBySourceChartData,
    buildReceivablesAgingChartData,
    buildOccupancyTrendChartData,
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

  // Revenue trend: 3 datasets for Line chart
  const trendData = buildRevenueTrendChartData([
    { period: '2026-10', billed: 10_000_000, invoice_settled: 8_000_000, collected: 7_500_000 },
  ]);
  assert.deepEqual(trendData.labels, ['2026-10']);
  assert.equal(trendData.datasets.length, 3);
  assert.equal(trendData.datasets[0].data[0], 10_000_000);
  assert.equal(trendData.datasets[2].data[0], 7_500_000);

  // Revenue by source: 5 stacked datasets
  const sourceData = buildRevenueBySourceChartData([
    {
      period: '2026-10',
      rent: 6_000_000,
      electricity: 800_000,
      water: 200_000,
      service: 400_000,
      other: 100_000,
    },
  ]);
  assert.equal(sourceData.datasets.length, 5);
  assert.equal(sourceData.datasets[0].data[0], 6_000_000);

  // Aging: 5 buckets with correct amounts and bucket keys
  const { bucketKeys, counts, chartData: agingData } = buildReceivablesAgingChartData({
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
  assert.deepEqual(agingData.datasets[0].data, [1_000_000, 2_000_000, 3_000_000, 4_000_000, 5_000_000]);
  assert.deepEqual(counts, [1, 2, 1, 3, 1]);

  // Occupancy: Line chart with rate clamped
  const { metaPoints, chartData: occData } = buildOccupancyTrendChartData([
    { period: '2026-09', occupied: 3, exploitable: 4, occupancy_rate: 75 },
    { period: '2026-10', occupied: 2, exploitable: 4, occupancy_rate: 50 },
  ]);
  assert.deepEqual(occData.datasets[0].data, [75, 50]);
  assert.deepEqual(metaPoints, [{ occupied: 3, exploitable: 4 }, { occupied: 2, exploitable: 4 }]);

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
  assert.ok(dashSrc.includes('ChartJS.register'), 'DashboardPage must register Chart.js components');
  assert.ok(dashSrc.includes('<Line') || dashSrc.includes('<Bar'), 'DashboardPage must render Chart.js Line or Bar');
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

test('Final Review Fix — Select mobile anti-zoom, empty-debt Quick Action guard & 44px WCAG icon buttons', () => {
  // Important #1: Select.jsx mobile anti-zoom (text-base), coarse-pointer focus guard, and >=44px touch targets
  const selectSrc = fs.readFileSync(
    path.join(FRONTEND_SRC, 'components/ui/Select.jsx'),
    'utf8'
  );
  assert.ok(
    selectSrc.includes('min-h-[44px]'),
    'Select trigger and options must enforce >=44px touch targets on mobile'
  );
  assert.ok(
    selectSrc.includes('text-base sm:text-xs'),
    'Select filter input must use 16px (text-base) on mobile to prevent iOS Safari auto-zoom'
  );
  assert.ok(
    selectSrc.includes('pointer: coarse'),
    'Select must avoid auto-focusing search input on coarse touch pointers'
  );

  // Important #2: OverviewTab & InvoicesTab must not trap paid-up residents in an empty payment modal
  const overviewSrc = fs.readFileSync(
    path.join(FRONTEND_SRC, 'pages/resident/tabs/OverviewTab.jsx'),
    'utf8'
  );
  assert.ok(
    overviewSrc.includes("currentAmountDue > 0 ? { action: 'pay' } : undefined"),
    'OverviewTab Quick Action must only pass { action: "pay" } when currentAmountDue > 0'
  );

  const invoicesSrc = fs.readFileSync(
    path.join(FRONTEND_SRC, 'pages/resident/tabs/InvoicesTab.jsx'),
    'utf8'
  );
  assert.ok(
    invoicesSrc.includes('if (unpaidInvoices.length > 0)'),
    'InvoicesTab action=pay effect must guard against opening an empty payment modal when unpaidInvoices is empty'
  );

  // Important #3: 44x44px touch targets & WCAG aria-label on ProfileTab, InvoicesTab meter preview, and NotificationBell
  assert.ok(
    invoicesSrc.includes('min-h-[44px]') && invoicesSrc.includes('aria-label="Xem ảnh chụp mặt đồng hồ'),
    'InvoicesTab meter-photo preview buttons must enforce >=44px touch target and aria-label'
  );

  const profileSrc = fs.readFileSync(
    path.join(FRONTEND_SRC, 'pages/resident/tabs/ProfileTab.jsx'),
    'utf8'
  );
  assert.ok(
    profileSrc.includes('Ẩn mật khẩu mới') && profileSrc.includes('Hiện mật khẩu mới'),
    'ProfileTab new-password visibility toggle must expose WCAG aria-label'
  );
  assert.equal(
    (profileSrc.match(/min-w-\[44px\] min-h-\[44px\]/g) || []).length >= 2,
    true,
    'ProfileTab both password visibility toggles must meet 44x44px touch target on mobile'
  );

  const bellSrc = fs.readFileSync(
    path.join(FRONTEND_SRC, 'components/common/NotificationBell.jsx'),
    'utf8'
  );
  assert.ok(
    bellSrc.includes('min-w-[44px] min-h-[44px]') &&
      bellSrc.includes('aria-label="Thông báo"') &&
      bellSrc.includes('aria-expanded={open}'),
    'NotificationBell trigger must meet 44x44px touch target and expose aria-label + aria-expanded'
  );
});

test('DevTools Responsive Fix — ResidentLayout keeps sticky top tablist visible when shrunk (<1024px) alongside mobile thumb bottom bar', () => {
  const layoutSrc = fs.readFileSync(
    path.join(FRONTEND_SRC, 'components/layout/ResidentLayout.jsx'),
    'utf8'
  );
  assert.ok(
    layoutSrc.includes('aria-label="Danh mục cổng cư dân"') &&
      layoutSrc.includes('role="tablist"') &&
      layoutSrc.includes('lg:hidden'),
    'ResidentLayout header must render sticky lg:hidden tablist so shrinking screen <1024px never loses Tổng quan / Hợp đồng / Hóa đơn bar'
  );
  assert.ok(
    layoutSrc.includes('md:hidden fixed bottom-0 inset-x-0'),
    'ResidentLayout must keep fixed 5-slot thumb bottom bar for phone viewports (<768px)'
  );

  const notifSrc = fs.readFileSync(
    path.join(FRONTEND_SRC, 'pages/resident/tabs/NotificationsTab.jsx'),
    'utf8'
  );
  assert.ok(
    notifSrc.includes('flex-col sm:flex-row sm:items-start justify-between'),
    'NotificationsTab item header must stack on <640px to prevent 360px right-edge overflow'
  );
});
