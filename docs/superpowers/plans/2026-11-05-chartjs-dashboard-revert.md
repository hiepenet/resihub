# Chart.js Dashboard Revert Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Recharts/Shadcn charts in `DashboardPage.jsx` with Chart.js, rendering exactly 3 PRD §15.1-compliant charts (Revenue Line+toggle, Aging Bar, Occupancy Line).

**Architecture:** `chartHelpers.js` exports pure Chart.js dataset-builder functions; `DashboardPage.jsx` imports `Line`/`Bar` from `react-chartjs-2` and calls those builders inside `useMemo`; `Chart.jsx` (Shadcn/Recharts wrapper) is deleted; both test files are updated to assert Chart.js instead of Recharts.

**Tech Stack:** `chart.js ^4.5.1`, `react-chartjs-2 ^5.3.1` (already installed); remove `recharts ^3.10.1` and `react-is ^19.3.1`.

**Spec:** `docs/prd.md` §15.1 (Chart types per role); §15.3 (Drill-down links); §16.1 (VND formatting); §16.2 (EmptyState fallbacks).

## Global Constraints

- Chart.js only on DashboardPage — zero `recharts` or `react-is` imports after this change.
- Exactly 3 chart sections: Revenue (lg:col-span-7), Aging (lg:col-span-5), Occupancy (full-width).
- Revenue card: mode toggle `'trend'` (Line) | `'source'` (Stacked Bar). Toggle label "Xu hướng thu" / "Theo nguồn thu".
- Aging chart: Bar, 5 buckets per `DASHBOARD_AGING_BUCKET_META`, click drills to `/admin/payments?tab=aging&bucket=<key>`.
- Occupancy chart: Line, y-axis 0–100%, tooltip shows `occupied/exploitable`.
- **Do NOT** restore Doughnut chart (`buildApartmentStatusDoughnutData` must NOT be added).
- **Do NOT** touch: `ReportsPage.jsx`, `ResidentPortalPage.jsx`, `OverviewTab.jsx`, any API files.
- Keep all KPI cards, 7 alert-button strip, expiring-contracts widget, recent-requests widget unchanged.
- All money values formatted with `formatMoney`; axes use `formatCompactMoney`. Labels in Vietnamese.

## Review Focus

1. **Empty series with only `invoice_settled > 0`** — `hasRevenueChartData` must return `false` for `'trend'` mode when `billed` and `collected` are both 0 (chart would render all-zero line; EmptyState is correct). Test: Task 1, assertion on `hasRevenueChartData`.
2. **Aging bucket click with unknown index** — `onClick` must guard against `ctx.dataIndex` out of range so it never navigates with an empty bucket key. Test: Task 2 (chartHelpers), Task 4 (DashboardPage).
3. **Occupancy tooltip with `exploitable === 0`** — tooltip must not divide by zero; it shows the raw `occupied/exploitable` counts, not a computed rate. Test: Task 2, `buildOccupancyTrendChartData` with `exploitable: 0`.
4. **`hasRevenueChartData` 2-param call** — after removing the `mode` parameter default, callers that pass `revenueMode` as 3rd arg should still work (function accepts but ignores it, or the signature keeps the optional param). Confirm call site in DashboardPage passes only 2 args. Test: Task 4 assertion.
5. **`react-is` / `recharts` removed from bundle** — after `npm uninstall`, any file still importing from `recharts` would cause a build error. Verify no other frontend file imports `recharts` before uninstall. Test: Task 5 grep step.

---

### Task 1: Rewrite `chartHelpers.js` — Chart.js builder functions

**Files:**
- Modify: `frontend/src/utils/chartHelpers.js`
- Test: `api/test/frontendShadcnDashboardCharts.test.js` (will be updated in Task 3; run as-is first to capture baseline failures)

**Interfaces:**
- Keeps: `DASHBOARD_AGING_BUCKET_KEYS`, `DASHBOARD_AGING_BUCKET_META`, `hasAgingChartData`, `hasOccupancyChartData`, `buildReportsBuildingAgingChartData`, `resolvePaymentsUrlQuery`
- Removes: `REVENUE_COMPARISON_CHART_CONFIG`, `REVENUE_SOURCE_CHART_CONFIG`, `REVENUE_SOURCE_KEYS`, `AGING_BUCKETS_CHART_CONFIG`, `OCCUPANCY_BAR_CHART_CONFIG`, `sanitizeChartKey`, `buildChartCssVariables`, `buildRevenueComparisonBarRows`, `buildRevenueSourceBarRows`, `getTopRevenueSourceKey`, `buildReceivablesAgingBarRows`, `resolveAgingBarBucketKey`, `buildOccupancyBarRows`
- Adds:
  - `buildRevenueTrendChartData(revenueSeries: Array) → { labels: string[], datasets: ChartDataset[] }` — 3 datasets (Phát hành/Tất toán/Thực thu), type Line
  - `buildRevenueBySourceChartData(sourceSeries: Array) → { labels: string[], datasets: ChartDataset[] }` — 5 datasets (rent/electricity/water/service/other), `stack: 'revenue_source'`
  - `buildReceivablesAgingChartData(receivablesAging: object) → { bucketKeys: string[], counts: number[], chartData: { labels: string[], datasets: ChartDataset[] } }`
  - `buildOccupancyTrendChartData(occupancySeries: Array) → { metaPoints: { occupied: number, exploitable: number }[], chartData: { labels: string[], datasets: ChartDataset[] } }`
  - `hasRevenueChartData(revenueSeries: Array, sourceSeries: Array) → boolean` — 2-param signature (no mode); returns `true` if either series has positive data

- [ ] **Step 1: Remove all Recharts-only exports from `chartHelpers.js`**

  Delete the following named exports (functions and constants):
  `REVENUE_COMPARISON_CHART_CONFIG`, `REVENUE_SOURCE_CHART_CONFIG`, `REVENUE_SOURCE_KEYS`,
  `AGING_BUCKETS_CHART_CONFIG`, `OCCUPANCY_BAR_CHART_CONFIG`,
  `sanitizeChartKey`, `buildChartCssVariables`,
  `buildRevenueComparisonBarRows`, `buildRevenueSourceBarRows`, `getTopRevenueSourceKey`,
  `buildReceivablesAgingBarRows`, `resolveAgingBarBucketKey`, `buildOccupancyBarRows`.

  Also remove the private helper `toNonNegativeNumber` only if it is not used by any kept function (it will be re-used by new builders — keep it).

- [ ] **Step 2: Rewrite `hasRevenueChartData` to 2-param signature**

  ```js
  export function hasRevenueChartData(revenueSeries = [], sourceSeries = []) {
    const revHasPositive = Array.isArray(revenueSeries) &&
      revenueSeries.some(r => Number(r?.billed || 0) > 0 || Number(r?.collected || 0) > 0);
    const srcHasPositive = Array.isArray(sourceSeries) &&
      sourceSeries.some(s =>
        Number(s?.rent || 0) > 0 || Number(s?.electricity || 0) > 0 ||
        Number(s?.water || 0) > 0 || Number(s?.service || 0) > 0 || Number(s?.other || 0) > 0
      );
    return revHasPositive || srcHasPositive;
  }
  ```

- [ ] **Step 3: Add `buildRevenueTrendChartData(revenueSeries)`**

  Signature: `(revenueSeries: Array) → { labels: string[], datasets: ChartDataset[] }`

  - `labels`: `revenueSeries.map(r => String(r?.period || r?.month || ''))`
  - `datasets`: 3 entries:
    1. `{ label: 'Phát hành', data: map(r => toNonNegativeNumber(r?.billed)), borderColor: '#0ea5e9', backgroundColor: 'rgba(14,165,233,0.1)', fill: true, tension: 0.3, pointRadius: 3 }`
    2. `{ label: 'Tất toán HĐ', data: map(r => toNonNegativeNumber(r?.invoice_settled)), borderColor: '#8b5cf6', backgroundColor: 'transparent', borderDash: [4,4], tension: 0.3, pointRadius: 3 }`
    3. `{ label: 'Thực thu', data: map(r => toNonNegativeNumber(r?.collected)), borderColor: '#10b981', backgroundColor: 'rgba(16,185,129,0.1)', fill: true, tension: 0.3, pointRadius: 3 }`

- [ ] **Step 4: Add `buildRevenueBySourceChartData(sourceSeries)`**

  Signature: `(sourceSeries: Array) → { labels: string[], datasets: ChartDataset[] }`

  - `labels`: `sourceSeries.map(r => String(r?.period || ''))`
  - `datasets`: 5 entries, one per source key in order `['rent','electricity','water','service','other']`:
    - colors: `#0ea5e9`, `#f59e0b`, `#06b6d4`, `#10b981`, `#8b5cf6`
    - labels: `'Tiền thuê phòng'`, `'Tiền điện'`, `'Tiền nước'`, `'Phí dịch vụ'`, `'Phí trễ hạn & Khác'`
    - Each dataset: `{ label, data: map(r => toNonNegativeNumber(r?.[key])), backgroundColor: color, stack: 'revenue_source', borderRadius: 3, borderSkipped: false }`

- [ ] **Step 5: Add `buildReceivablesAgingChartData(receivablesAging)`**

  Signature: `(receivablesAging: object) → { bucketKeys: string[], counts: number[], chartData: { labels: string[], datasets: ChartDataset[] } }`

  - Normalize `receivablesAging?.buckets` using same null-filter as old `buildReceivablesAgingBarRows`
  - Return:
    - `bucketKeys`: `DASHBOARD_AGING_BUCKET_META.map(m => m.key)`
    - `counts`: amounts per bucket from `byKey` map
    - `chartData.labels`: `DASHBOARD_AGING_BUCKET_META.map(m => m.label)`
    - `chartData.datasets[0]`: `{ label: 'Dư nợ chưa thu', data: amounts[], backgroundColor: DASHBOARD_AGING_BUCKET_META.map(m => m.color), borderRadius: 4, borderSkipped: false }`

  `counts[i]` = `toNonNegativeNumber(byKey.get(meta.key)?.count)` for each bucket in order.

- [ ] **Step 6: Add `buildOccupancyTrendChartData(occupancySeries)`**

  Signature: `(occupancySeries: Array) → { metaPoints: { occupied: number, exploitable: number }[], chartData: { labels: string[], datasets: ChartDataset[] } }`

  - `metaPoints`: `occupancySeries.map(r => ({ occupied: toNonNegativeNumber(r?.occupied), exploitable: toNonNegativeNumber(r?.exploitable) }))`
  - `chartData.labels`: `occupancySeries.map(r => String(r?.period || ''))`
  - `chartData.datasets[0]`: `{ label: 'Tỷ lệ lấp đầy (%)', data: map(r => clamp(Number(r?.occupancy_rate), 0, 100) or 0 if NaN), borderColor: '#0ea5e9', backgroundColor: 'rgba(14,165,233,0.15)', fill: true, tension: 0.3, pointRadius: 4 }`

  clamp: `Number.isFinite(rawRate) ? Math.min(100, Math.max(0, rawRate)) : 0`

- [ ] **Step 7: Verify file exports are correct**

  Run:
  ```
  node -e "import('./frontend/src/utils/chartHelpers.js').then(m => console.log(Object.keys(m)))" 
  ```
  from `d:\resihub`.

  Expected output includes: `DASHBOARD_AGING_BUCKET_KEYS`, `DASHBOARD_AGING_BUCKET_META`, `hasRevenueChartData`, `hasAgingChartData`, `hasOccupancyChartData`, `buildRevenueTrendChartData`, `buildRevenueBySourceChartData`, `buildReceivablesAgingChartData`, `buildOccupancyTrendChartData`, `buildReportsBuildingAgingChartData`, `resolvePaymentsUrlQuery`.

  Expected to NOT include: `REVENUE_COMPARISON_CHART_CONFIG`, `sanitizeChartKey`, `buildChartCssVariables`, `buildRevenueComparisonBarRows`, `resolveAgingBarBucketKey`, etc.

- [ ] **Step 8: Commit**
  ```
  git add frontend/src/utils/chartHelpers.js
  git commit -m "refactor(charts): revert chartHelpers to Chart.js builders, drop Recharts configs"
  ```

---

### Task 2: Delete `Chart.jsx` (Shadcn/Recharts wrapper)

**Files:**
- Delete: `frontend/src/components/ui/Chart.jsx`

**Interfaces:**
- Consumes: nothing (file is being deleted)
- Produces: nothing (Chart.jsx will no longer exist; DashboardPage.jsx must not import from it after Task 4)

> [!WARNING]
> Verify no other file imports from `Chart.jsx` before deleting. Currently only `DashboardPage.jsx` imports it — Task 4 will update that file. If any other file imports `Chart.jsx`, it must be fixed first.

- [ ] **Step 1: Verify only DashboardPage imports `Chart.jsx`**

  Run:
  ```powershell
  Select-String -Path "d:\resihub\frontend\src\**\*.jsx","d:\resihub\frontend\src\**\*.js" -Pattern "components/ui/Chart" -Recurse
  ```
  Expected: only `DashboardPage.jsx` appears.

- [ ] **Step 2: Delete the file**
  ```powershell
  Remove-Item "d:\resihub\frontend\src\components\ui\Chart.jsx"
  ```

- [ ] **Step 3: Commit**
  ```
  git add -A
  git commit -m "chore(charts): delete Shadcn/Recharts Chart.jsx wrapper — no longer used"
  ```

---

### Task 3: Update test files to assert Chart.js instead of Recharts

**Files:**
- Modify: `api/test/frontendShadcnDashboardCharts.test.js`
- Modify: `api/test/frontendWeek8ChartsAndMobile.test.js` (lines 156–157 only)

**Interfaces:**
- Consumes: knowledge of new chartHelpers exports (from Task 1) and new DashboardPage shape (from Task 4)
- Produces: updated test expectations that the new Chart.js implementation will satisfy

> [!NOTE]
> Update tests BEFORE rewriting DashboardPage.jsx (Task 4), so each task ends with a passing or red-green transition. Tests in `frontendShadcnDashboardCharts.test.js` currently check Recharts/Shadcn artefacts — they must be rewritten to check Chart.js artefacts.

- [ ] **Step 1: Rewrite `frontendShadcnDashboardCharts.test.js`**

  Replace the entire file. Keep the same 5 `test(...)` blocks but update assertions:

  **Test "Task 1 — Shadcn CSS variable generator..."** → rename to **"Task 1 — Chart.js chartHelpers exports buildRevenueTrendChartData, buildReceivablesAgingChartData, buildOccupancyTrendChartData"**
  - Import `buildRevenueTrendChartData`, `buildRevenueBySourceChartData`, `buildReceivablesAgingChartData`, `buildOccupancyTrendChartData`, `DASHBOARD_AGING_BUCKET_KEYS`, `DASHBOARD_AGING_BUCKET_META` from chartHelpers
  - Assert `buildRevenueTrendChartData` is a function
  - Assert `buildRevenueTrendChartData([{period:'2026-10', billed:1000, collected:900, invoice_settled:800}])` returns `{ labels: ['2026-10'], datasets: Array(3) }` with `datasets[0].label === 'Phát hành'`
  - Assert `buildReceivablesAgingChartData({buckets:[{key:'0_15',amount:500,count:1}]}).bucketKeys` deepEquals `DASHBOARD_AGING_BUCKET_KEYS`
  - Assert `buildOccupancyTrendChartData([{period:'2026-10',occupied:3,exploitable:4,occupancy_rate:75}]).metaPoints[0]` deepEquals `{occupied:3,exploitable:4}`

  **Test "Task 1 — Recharts revenue bar builders..."** → rename to **"Task 1 — buildRevenueBySourceChartData maps 5 RP-01 source datasets with stack id"**
  - Assert `buildRevenueBySourceChartData([{period:'2026-10',rent:6e6,electricity:8e5,water:2e5,service:4e5,other:1e5}])` returns `{ labels: ['2026-10'], datasets: Array(5) }`
  - Assert each dataset has `stack: 'revenue_source'`
  - Assert dataset labels are `['Tiền thuê phòng','Tiền điện','Tiền nước','Phí dịch vụ','Phí trễ hạn & Khác']`
  - Assert negative/NaN input is clamped to 0: `buildRevenueBySourceChartData([{period:'2026-11',rent:-100,electricity:undefined}]).datasets[0].data[0] === 0`

  **Test "Task 1 — Recharts aging bar builder..."** → rename to **"Task 1 — buildReceivablesAgingChartData maps 5 PRD buckets, colors and counts"**
  - Keep the same aging input fixture (5 buckets with amounts and counts)
  - Assert `bucketKeys` deepEquals `DASHBOARD_AGING_BUCKET_KEYS`
  - Assert `chartData.datasets[0].data` deepEquals `[1_000_000,2_000_000,3_000_000,4_000_000,5_000_000]`
  - Assert `counts` deepEquals `[1,2,1,3,1]`
  - Assert `chartData.datasets[0].backgroundColor[1]` equals `'#38bdf8'` (color for `0_15`)
  - **Remove** `resolveAgingBarBucketKey` assertions (function no longer exists)
  - **Remove** `rows[1].fill` assertion (no `fill` field in new structure)

  **Test "Task 1 — Recharts occupancy bar builder... and UI Chart.jsx exists"** → rename to **"Task 1 — buildOccupancyTrendChartData clamps rate [0,100] and Chart.jsx is deleted"**
  - Assert `buildOccupancyTrendChartData([{period:'2026-08',occupied:3,exploitable:4,occupancy_rate:75},{period:'2026-09',occupied:5,exploitable:4,occupancy_rate:125},{period:'2026-10',occupied:0,exploitable:0,occupancy_rate:NaN}])`:
    - `.chartData.datasets[0].data` deepEquals `[75, 100, 0]`
    - `.metaPoints` deepEquals `[{occupied:3,exploitable:4},{occupied:5,exploitable:4},{occupied:0,exploitable:0}]`
  - Assert `fs.existsSync(path.join(FRONTEND_SRC, 'components/ui/Chart.jsx')) === false` (file must NOT exist)

  **Test "Task 2 — DashboardPage uses strictly 3 Shadcn Recharts BarCharts..."** → rename to **"Task 2 — DashboardPage uses strictly 3 Chart.js charts aligned with PRD 15.1-15.3"**
  - Assert `dashSrc` does NOT include `'from \'recharts\''`
  - Assert `dashSrc` does NOT include `'ChartContainer'`
  - Assert `dashSrc` does NOT include `'<BarChart'`
  - Assert `dashSrc` does NOT include `'Doughnut'`, `'PieChart'`
  - Assert `dashSrc` does NOT include `'Cơ cấu trạng thái căn hộ'`
  - Assert `dashSrc` DOES include `"from 'react-chartjs-2'"`
  - Assert `dashSrc` DOES include `'ChartJS.register'`
  - Assert `dashSrc` DOES include `'<Line'`
  - Assert `dashSrc` DOES include `'<Bar'`
  - Assert count of `'<Line'` occurrences >= 2 (revenue trend + occupancy)
  - Assert `dashSrc` DOES include `'id="dashboard-revenue"'` (as a prop on the chart wrapper div or aria-label)
  - Assert `dashSrc` DOES include `'id="dashboard-aging"'`
  - Assert `dashSrc` DOES include `'id="dashboard-occupancy"'`
  - Assert `dashSrc` DOES include `'/admin/payments?tab=aging&bucket='`
  - Assert `dashSrc` DOES include `'<EmptyState'`
  - Assert `dashSrc` DOES include `'formatMoney('`

  **Test "Task 2 Polish — getTopRevenueSourceKey..."** → **delete this test** (function no longer exported)

  **Test "Final Review Fix — mode-aware hasRevenueChartData..."** → rename to **"Final Review — 2-param hasRevenueChartData, null-safe aging buckets, DashboardPage uses 2-param call"**
  - Assert `hasRevenueChartData([{period:'2026-10',billed:0,collected:0,invoice_settled:3e6}],[]) === false`
  - Assert `hasRevenueChartData([{period:'2026-10',billed:0,collected:4e6,invoice_settled:0}],[{period:'2026-10',rent:0,electricity:0,water:0,service:0,other:0}]) === true`
  - Assert null/undefined elements in `receivablesAging.buckets` don't throw (same as before)
  - Assert `dashSrc.includes('hasRevenueChartData(rev12m, revBySource)')` — 2-param call, no `revenueMode` third arg
  - **Remove** assertion about `ChartTooltipContent` label precedence (Chart.jsx deleted)

- [ ] **Step 2: Update `frontendWeek8ChartsAndMobile.test.js` Task 3 assertions**

  In the test at line 151 (`'Task 3 — DashboardPage, ReportsPage...'`), replace:
  ```js
  assert.ok(dashSrc.includes('ChartContainer'), 'DashboardPage must use Shadcn ChartContainer');
  assert.ok(dashSrc.includes('<BarChart'), 'DashboardPage must render Recharts <BarChart>');
  ```
  with:
  ```js
  assert.ok(dashSrc.includes('ChartJS.register'), 'DashboardPage must register Chart.js components');
  assert.ok(dashSrc.includes('<Line') || dashSrc.includes('<Bar'), 'DashboardPage must render Chart.js Line or Bar');
  ```
  Keep all other assertions in that test unchanged.

- [ ] **Step 3: Run tests to confirm they fail (baseline — DashboardPage not yet updated)**

  ```
  cd d:\resihub\api
  node --test test/frontendShadcnDashboardCharts.test.js test/frontendWeek8ChartsAndMobile.test.js
  ```
  Expected: Task 2 / Task 3 tests FAIL (DashboardPage still uses recharts), Task 1 tests pass (chartHelpers already updated).

- [ ] **Step 4: Commit**
  ```
  git add api/test/frontendShadcnDashboardCharts.test.js api/test/frontendWeek8ChartsAndMobile.test.js
  git commit -m "test(charts): update test assertions from Recharts to Chart.js for DashboardPage"
  ```

---

### Task 4: Rewrite `DashboardPage.jsx` to use Chart.js

**Files:**
- Modify: `frontend/src/pages/admin/dashboard/DashboardPage.jsx`

**Interfaces:**
- Consumes (from Task 1): `buildRevenueTrendChartData`, `buildRevenueBySourceChartData`, `buildReceivablesAgingChartData`, `buildOccupancyTrendChartData`, `hasRevenueChartData` (2-param), `hasAgingChartData`, `hasOccupancyChartData`, `DASHBOARD_AGING_BUCKET_KEYS`
- Produces: JSX with exactly `<Line>` (×2: revenue-trend + occupancy) and `<Bar>` (×2: revenue-source stacked + aging) from `react-chartjs-2`

- [ ] **Step 1: Update imports**

  Remove:
  - All `recharts` imports (`BarChart`, `Bar`, `CartesianGrid`, `XAxis`, `YAxis`, `Cell`)
  - All `Chart.jsx` imports (`ChartContainer`, `ChartTooltip`, `ChartTooltipContent`, `ChartLegend`, `ChartLegendContent`)
  - From chartHelpers: `REVENUE_COMPARISON_CHART_CONFIG`, `REVENUE_SOURCE_CHART_CONFIG`, `REVENUE_SOURCE_KEYS`, `AGING_BUCKETS_CHART_CONFIG`, `OCCUPANCY_BAR_CHART_CONFIG`, `buildRevenueComparisonBarRows`, `buildRevenueSourceBarRows`, `getTopRevenueSourceKey`, `buildReceivablesAgingBarRows`, `resolveAgingBarBucketKey`, `buildOccupancyBarRows`

  Add:
  ```js
  import {
    Chart as ChartJS,
    CategoryScale, LinearScale, PointElement, LineElement,
    BarElement, Title, Tooltip, Legend, Filler,
  } from 'chart.js';
  import { Line, Bar } from 'react-chartjs-2';
  ```
  ```js
  ChartJS.register(
    CategoryScale, LinearScale, PointElement, LineElement,
    BarElement, Title, Tooltip, Legend, Filler
  );
  ```
  Add from chartHelpers:
  ```js
  import {
    DASHBOARD_AGING_BUCKET_KEYS,
    hasRevenueChartData, hasAgingChartData, hasOccupancyChartData,
    buildRevenueTrendChartData, buildRevenueBySourceChartData,
    buildReceivablesAgingChartData, buildOccupancyTrendChartData,
  } from '../../../utils/chartHelpers';
  ```

- [ ] **Step 2: Update state and useMemo**

  - Change `revenueMode` initial value from `'comparison'` to `'trend'`
  - Replace 4 recharts `useMemo` calls with Chart.js equivalents:
    ```js
    const revenueTrendData = useMemo(() => buildRevenueTrendChartData(rev12m), [rev12m]);
    const revenueSourceData = useMemo(() => buildRevenueBySourceChartData(revBySource), [revBySource]);
    const agingChart = useMemo(() => buildReceivablesAgingChartData(agingInfo), [agingInfo]);
    const occupancyTrend = useMemo(() => buildOccupancyTrendChartData(occ12m), [occ12m]);
    ```
  - Change `showRevenueChart` call from 3-param to 2-param:
    ```js
    const showRevenueChart = hasRevenueChartData(rev12m, revBySource);
    ```

- [ ] **Step 3: Rewrite Revenue chart section (lg:col-span-7)**

  - Toggle button labels: `'trend'` → "Xu hướng thu", `'source'` → "Theo nguồn thu" (update `aria-pressed` checks and `onClick` handlers from `'comparison'` → `'trend'`)
  - Replace `<ChartContainer id="dashboard-revenue" ...>` + `<BarChart>` with:
    ```jsx
    <div id="dashboard-revenue" className="h-72 px-2 pb-2">
      {revenueMode === 'trend'
        ? <Line data={revenueTrendData} options={REVENUE_TREND_OPTIONS} />
        : <Bar data={revenueSourceData} options={REVENUE_SOURCE_OPTIONS} />
      }
    </div>
    ```
  - Define `REVENUE_TREND_OPTIONS` (module-level const) — Chart.js options object:
    ```js
    const REVENUE_TREND_OPTIONS = {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { position: 'top', labels: { boxWidth: 12, font: { size: 11 } } },
        tooltip: {
          callbacks: {
            label: ctx => `${ctx.dataset.label}: ${formatMoney(ctx.parsed.y)}`,
          },
        },
      },
      scales: {
        x: { grid: { display: false } },
        y: { ticks: { callback: v => formatCompactMoney(v) }, grid: { color: '#f1f5f9' } },
      },
    };
    ```
  - Define `REVENUE_SOURCE_OPTIONS` (module-level const):
    ```js
    const REVENUE_SOURCE_OPTIONS = {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { position: 'top', labels: { boxWidth: 12, font: { size: 11 } } },
        tooltip: {
          callbacks: {
            label: ctx => `${ctx.dataset.label}: ${formatMoney(ctx.parsed.y)}`,
            footer: items => {
              const total = items.reduce((s, i) => s + i.parsed.y, 0);
              return `Tổng phát hành: ${formatMoney(total)}`;
            },
          },
        },
      },
      scales: {
        x: { stacked: true, grid: { display: false } },
        y: { stacked: true, ticks: { callback: v => formatCompactMoney(v) }, grid: { color: '#f1f5f9' } },
      },
    };
    ```
  - Revenue chart card click drill-down: add an `onClick={() => navigate('/admin/invoices')}` on the `<div id="dashboard-revenue">` wrapper (or on the `<Bar>`/`<Line>` via chartjs `onClick` plugin option — keep drill-down to `/admin/invoices`).

- [ ] **Step 4: Rewrite Aging chart section (lg:col-span-5)**

  Replace `<ChartContainer id="dashboard-aging" ...>` + `<BarChart>` with:
  ```jsx
  <div id="dashboard-aging" className="h-72 px-2 pb-2">
    <Bar data={agingChart.chartData} options={agingOptions} />
  </div>
  ```
  Define `agingOptions` as a `useMemo` (needs `agingChart.bucketKeys` and `agingChart.counts` in closure):
  ```js
  const agingOptions = useMemo(() => ({
    responsive: true, maintainAspectRatio: false,
    plugins: {
      legend: { display: false },
      tooltip: {
        callbacks: {
          label: ctx => {
            const amount = formatMoney(ctx.parsed.y);
            const count = agingChart.counts[ctx.dataIndex] ?? 0;
            return `${amount} (${count} khoản)`;
          },
        },
      },
    },
    scales: {
      x: { grid: { display: false } },
      y: { ticks: { callback: v => formatCompactMoney(v) }, grid: { color: '#f1f5f9' } },
    },
    onClick: (_evt, elements) => {
      if (!elements.length) return;
      const idx = elements[0].index;
      const bKey = agingChart.bucketKeys[idx] ?? '';
      if (bKey && DASHBOARD_AGING_BUCKET_KEYS.includes(bKey)) {
        navigate(`/admin/payments?tab=aging&bucket=${bKey}`);
      }
    },
    onHover: (_evt, elements, chart) => {
      chart.canvas.style.cursor = elements.length ? 'pointer' : 'default';
    },
  }), [agingChart, navigate]);
  ```

- [ ] **Step 5: Rewrite Occupancy chart section (full-width Card)**

  Replace `<ChartContainer id="dashboard-occupancy" ...>` + `<BarChart>` with:
  ```jsx
  <div id="dashboard-occupancy" className="h-64 px-2 pb-2">
    <Line data={occupancyTrend.chartData} options={occupancyOptions} />
  </div>
  ```
  Define `occupancyOptions` as a `useMemo` (needs `occupancyTrend.metaPoints`):
  ```js
  const occupancyOptions = useMemo(() => ({
    responsive: true, maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { position: 'top', labels: { boxWidth: 12, font: { size: 11 } } },
      tooltip: {
        callbacks: {
          label: ctx => {
            const pt = occupancyTrend.metaPoints[ctx.dataIndex];
            return `${ctx.parsed.y}% (${pt?.occupied ?? 0}/${pt?.exploitable ?? 0} căn đang khai thác)`;
          },
          title: items => `Cuối kỳ ${items[0]?.label ?? ''}`,
        },
      },
    },
    scales: {
      x: { grid: { display: false } },
      y: { min: 0, max: 100, ticks: { callback: v => `${v}%` }, grid: { color: '#f1f5f9' } },
    },
    onClick: () => navigate('/admin/buildings'),
    onHover: (_evt, elements, chart) => {
      chart.canvas.style.cursor = elements.length ? 'pointer' : 'default';
    },
  }), [occupancyTrend, navigate]);
  ```

- [ ] **Step 6: Verify no recharts or Chart.jsx references remain in DashboardPage.jsx**

  ```powershell
  Select-String -Path "d:\resihub\frontend\src\pages\admin\dashboard\DashboardPage.jsx" -Pattern "recharts|ChartContainer|ChartTooltip|ChartLegend|REVENUE_COMPARISON|REVENUE_SOURCE_CHART|OCCUPANCY_BAR"
  ```
  Expected: 0 matches.

- [ ] **Step 7: Commit**
  ```
  git add frontend/src/pages/admin/dashboard/DashboardPage.jsx
  git commit -m "feat(dashboard): revert charts to Chart.js Line/Bar per PRD §15.1 — revenue trend, aging bar, occupancy line"
  ```

---

### Task 5: Remove `recharts` and `react-is` from `package.json`

**Files:**
- Modify: `frontend/package.json`

**Interfaces:**
- Consumes: nothing
- Produces: `frontend/package.json` with `recharts` and `react-is` removed from `dependencies`

> [!CAUTION]
> Run the grep check in Step 1 before uninstalling to avoid breaking any other file that may import from recharts.

- [ ] **Step 1: Verify no other frontend file imports recharts**

  ```powershell
  Select-String -Path "d:\resihub\frontend\src\**\*.jsx","d:\resihub\frontend\src\**\*.js","d:\resihub\frontend\src\**\*.tsx","d:\resihub\frontend\src\**\*.ts" -Pattern "from 'recharts'" -Recurse
  ```
  Expected: 0 matches (DashboardPage.jsx was updated in Task 4, Chart.jsx was deleted in Task 2).

- [ ] **Step 2: Remove from package.json**

  Edit `frontend/package.json`:
  - Remove line: `"recharts": "^3.10.1"`
  - Remove line: `"react-is": "^19.3.1"`

- [ ] **Step 3: Run npm uninstall (if running in host/non-Docker context)**

  ```
  cd d:\resihub\frontend
  npm uninstall recharts react-is
  ```
  If Docker container is running:
  ```
  docker exec resihub-frontend npm uninstall recharts react-is --no-save
  ```

- [ ] **Step 4: Commit**
  ```
  git add frontend/package.json frontend/package-lock.json
  git commit -m "chore(deps): remove recharts and react-is from frontend dependencies"
  ```

---

### Task 6: Verification

**Files:** no changes — verification only.

- [ ] **Step 1: Run the two chart test files and confirm all tests pass**

  ```
  cd d:\resihub\api
  node --test test/frontendShadcnDashboardCharts.test.js test/frontendWeek8ChartsAndMobile.test.js
  ```
  Expected: all tests PASS.

- [ ] **Step 2: Run uiInformationCompleteness test**

  ```
  cd d:\resihub\frontend
  node --test src/utils/__tests__/uiInformationCompleteness.test.js
  ```
  Expected: PASS (no changes to info-completeness assertions).

- [ ] **Step 3: Verify frontend build is clean (import-level check)**

  ```
  cd d:\resihub\frontend
  npx vite build --mode development 2>&1 | Select-String -Pattern "error|Error|Cannot find"
  ```
  Expected: 0 error lines. If Docker is used instead, run the equivalent inside the container.

- [ ] **Step 4: Final commit (if any fixup needed from Step 1–3)**

  If all pass with no changes needed:
  ```
  git tag charts-chartjs-revert-verified
  ```
