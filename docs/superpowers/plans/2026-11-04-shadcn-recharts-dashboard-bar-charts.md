# Shadcn / Recharts Dashboard Bar Charts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Chart.js on `DashboardPage.jsx` with Shadcn Charts built on Recharts (`BarChart`), rendering strictly the 3 PRD-specified column charts (Doanh thu, Công nợ, Lấp đầy) and removing all unrelated charts (Apartment Status Doughnut and Line charts) from the dashboard.

**Architecture:** Introduce `frontend/src/components/ui/Chart.jsx` implementing Shadcn UI's `ChartContainer`, `ChartStyle`, `ChartTooltip`, `ChartTooltipContent`, `ChartLegend`, and `ChartLegendContent` primitives over `recharts` (`ResponsiveContainer`, `BarChart`, `Bar`, `CartesianGrid`, `XAxis`, `YAxis`, `Cell`). Refactor `frontend/src/utils/chartHelpers.js` to produce sanitized Recharts flat row arrays and Shadcn `ChartConfig` objects aligned with PRD Section 15 (`15.1`–`15.3`) and `16.1`–`16.2`, while keeping `buildReportsBuildingAgingChartData` and `resolvePaymentsUrlQuery` intact for `ReportsPage.jsx` and `PaymentsPage.jsx`.

**Tech Stack:** React 19 (`19.2.8`), `recharts` (`^3.10.1`) + `react-is` (`^19.2.0`), Tailwind CSS 3.4, Node.js `node:test` (`assert/strict`).

**Spec:** `d:\resihub\PRD - Quan ly Can ho va Nha cho thue v2.0.md` (Sections `15.1` Dashboard theo vai trò, `15.2` RP-01/RP-02/RP-03, `15.3` Định nghĩa KPI & Nguyên tắc trình bày số liệu, `16.1` Định dạng VND đầy đủ, `16.2` Empty/Loading states, `AC-016.1`).

## Global Constraints

- Only **3 chart cards** may exist on `DashboardPage.jsx`: (1) **Biểu đồ cột Doanh thu**, (2) **Biểu đồ cột Công nợ theo nhóm tuổi nợ**, and (3) **Biểu đồ cột Tỷ lệ lấp đầy**.
- All 3 dashboard charts must use **Shadcn Charts (`Chart.jsx`) + Recharts `BarChart` (biểu đồ cột)** — zero `chart.js` / `react-chartjs-2` imports, zero `<Doughnut>` / `<PieChart>`, and zero `<Line>` / `<LineChart>` on `DashboardPage.jsx`.
- PRD 15.3 Revenue KPI separation: Dashboard revenue chart must show both **Doanh thu phát hành (`billed`)** and **Tiền thực thu (`collected`)** per period (default grouped column view) AND support switching to **Theo nguồn thu** stacked columns (`rent`, `electricity`, `water`, `service`, `other` per PRD 15.1 & RP-01).
- PRD 15.3 & AC-016.1 Aging buckets: Debt column chart must render the exact 5 buckets (`current_not_due`, `0_15`, `16_30`, `31_60`, `over_60`) with click drill-down to `/admin/payments?tab=aging&bucket=<key>`.
- PRD 15.3 Occupancy KPI: Occupancy column chart must plot end-of-period `occupancy_rate` (`0–100%`) with tooltip showing `occupied/exploitable` exploitable apartments and click drill-down to `/admin/buildings`.
- PRD 16.1 & 16.2: Tooltips must format money in full VND (`formatMoney`, e.g. `1.250.000 ₫`); empty datasets must render `<EmptyState />` explaining why and offering the next action instead of blank axes.
- Keep `ReportsPage.jsx` and `PaymentsPage.jsx` working without regression.

## Review Focus

1. **CSS custom property injection safety & numeric-prefix bucket keys (`0_15`, `16_30`, `31_60`):** `sanitizeChartKey` in `Chart.jsx` must strip unsafe characters while producing deterministic `--color-<key>` CSS variables matching `var(--color-0_15)` used by Aging `<Cell>` fills, and reject malformed color strings so `<style>` injection cannot corrupt CSS.
2. **Non-finite / negative / missing API fields in Recharts rows:** `NaN`, `null`, `undefined`, or negative values in `revenue_12m`, `revenue_by_source`, `receivables_aging`, or `occupancy_12m` (e.g. `occupancy_rate > 100` or `NaN` when `exploitable === 0`) must be clamped/coerced to finite numbers (`0..100` for occupancy rate, `>= 0` for bar heights) so Recharts SVG `<rect>` never throws `NaN` attribute warnings.
3. **Recharts v3 `<Bar onClick>` payload shape:** Recharts 3 passes `(barRectangleItem, index, event)` where original datum lives on `barRectangleItem.payload` (or `barRectangleItem` in unit calls). `resolveAgingBarBucketKey(barItem, index, rows)` must resolve the bucket key across both shapes and ignore unknown keys.
4. **Zero-data empty-state threshold when API returns 12 zero-filled periods:** `GET /api/v1/reports/dashboard` returns 6 or 12 period rows even when a building has 0 invoices; `hasRevenueChartData`, `hasAgingChartData`, and `hasOccupancyChartData` must return `false` on all-zero arrays so `<EmptyState />` renders per PRD 15.3 & 16.2.
5. **Docker container `node_modules` volume sync:** `docker-compose.yml` mounts `/app/node_modules` as an anonymous volume on `resihub-frontend`; installing `recharts` on the host alone would break live HMR at `http://localhost:3000` unless also installed inside `resihub-frontend`.

---

### Task 1: Shadcn Charts (`Chart.jsx`) Primitives, Recharts Dependency & PRD Bar-Data Helpers

**Files:**
- Modify: `frontend/package.json`
- Create: `frontend/src/components/ui/Chart.jsx`
- Modify: `frontend/src/utils/chartHelpers.js`
- Create: `api/test/frontendShadcnDashboardCharts.test.js`
- Modify: `api/test/frontendWeek8ChartsAndMobile.test.js:50-163`

**Interfaces:**
- Produces in `frontend/src/components/ui/Chart.jsx`:
  - `sanitizeChartKey(key: string) -> string`
  - `buildChartCssVariables(chartId: string, config: Record<string, { label?: string, color?: string }>) -> string`
  - `ChartContainer({ id?, className?, config, children, ...props })`
  - `ChartTooltip` (Recharts `Tooltip`)
  - `ChartTooltipContent({ active, payload, label, labelFormatter?, formatter?, footerFormatter?, indicator?, hideLabel?, hideIndicator?, className? })`
  - `ChartLegend` (Recharts `Legend`)
  - `ChartLegendContent({ payload, verticalAlign?, hideIcon?, className? })`
  - `useChart() -> { config }`
- Produces in `frontend/src/utils/chartHelpers.js`:
  - `REVENUE_COMPARISON_CHART_CONFIG`, `REVENUE_SOURCE_CHART_CONFIG`, `AGING_BUCKETS_CHART_CONFIG`, `OCCUPANCY_BAR_CHART_CONFIG`
  - `buildRevenueComparisonBarRows(revenueSeries) -> Array<{ period, billed, collected, invoice_settled }>`
  - `buildRevenueSourceBarRows(sourceSeries) -> Array<{ period, rent, electricity, water, service, other, total_billed }>`
  - `buildReceivablesAgingBarRows(receivablesAging) -> Array<{ key, label, amount, count, fill }>`
  - `resolveAgingBarBucketKey(barItem, index, rows) -> string`
  - `buildOccupancyBarRows(occupancySeries) -> Array<{ period, occupancy_rate, occupied, exploitable }>`
  - Preserves: `DASHBOARD_AGING_BUCKET_KEYS`, `DASHBOARD_AGING_BUCKET_META`, `hasRevenueChartData`, `hasAgingChartData`, `hasOccupancyChartData`, `buildReportsBuildingAgingChartData`, `resolvePaymentsUrlQuery`

- [ ] **Step 1: Install `recharts` and `react-is` in `frontend/` and sync `resihub-frontend` container**

Run in `d:\resihub\frontend`: `npm install recharts react-is` and `docker exec resihub-frontend npm install recharts react-is --no-save`
Expected: `recharts` and `react-is` added to `frontend/package.json` dependencies with exit code `0`.

- [ ] **Step 2: Write failing unit tests in `api/test/frontendShadcnDashboardCharts.test.js` and update `api/test/frontendWeek8ChartsAndMobile.test.js`**

Test cases in `api/test/frontendShadcnDashboardCharts.test.js`:
1. `Chart.jsx` exports Shadcn primitives and `buildChartCssVariables` generates scoped `[data-chart="..."] { --color-0_15: #38bdf8; ... }` while stripping unsafe CSS characters (Review Focus #1).
2. `buildRevenueComparisonBarRows` & `buildRevenueSourceBarRows` map PRD 15.3 `billed` vs `collected` and 5 RP-01 revenue sources, coercing `NaN`/negative inputs to `0` (Review Focus #2).
3. `buildReceivablesAgingBarRows` & `resolveAgingBarBucketKey` map all 5 PRD aging buckets with `var(--color-<key>)` fills and resolve bucket keys across Recharts v3 `{ payload: { key } }`, direct `{ key }`, and fallback `index`, returning `''` for invalid keys (Review Focus #3).
4. `buildOccupancyBarRows` clamps `occupancy_rate` into finite `[0, 100]` and preserves `occupied` / `exploitable` counts (Review Focus #2).

- [ ] **Step 3: Run test suite to verify RED failure**

Run: `cd d:\resihub\api; node --test test/frontendShadcnDashboardCharts.test.js`
Expected: FAIL (`ERR_MODULE_NOT_FOUND` for `frontend/src/components/ui/Chart.jsx` and missing Recharts helper exports).

- [ ] **Step 4: Implement `frontend/src/components/ui/Chart.jsx` and Recharts builders in `frontend/src/utils/chartHelpers.js`**

Implement Shadcn `ChartContainer`, `ChartStyle` (`buildChartCssVariables` + `sanitizeChartKey`), `ChartTooltip`, `ChartTooltipContent` (supporting `formatter` and `footerFormatter`), `ChartLegend`, `ChartLegendContent`, and the pure bar-row + config builders in `chartHelpers.js`.

- [ ] **Step 5: Run tests to verify GREEN**

Run: `cd d:\resihub\api; node --test test/frontendShadcnDashboardCharts.test.js`
Expected: PASS (`0` failures).

- [ ] **Step 6: Commit Task 1**

```bash
git add frontend/package.json frontend/package-lock.json frontend/src/components/ui/Chart.jsx frontend/src/utils/chartHelpers.js api/test/frontendShadcnDashboardCharts.test.js
git commit -m "feat(ui-chart): add Shadcn Recharts Chart primitives and PRD dashboard bar helpers"
```

---

### Task 2: Migrate `DashboardPage.jsx` to Strictly 3 PRD Shadcn/Recharts Bar Charts & Remove Unrelated Charts

**Files:**
- Modify: `frontend/src/pages/admin/dashboard/DashboardPage.jsx`
- Modify: `api/test/frontendShadcnDashboardCharts.test.js`
- Modify: `api/test/frontendWeek8ChartsAndMobile.test.js:50-210`

**Interfaces:**
- Consumes from Task 1:
  - `ChartContainer`, `ChartTooltip`, `ChartTooltipContent`, `ChartLegend`, `ChartLegendContent` from `frontend/src/components/ui/Chart.jsx`
  - `REVENUE_COMPARISON_CHART_CONFIG`, `REVENUE_SOURCE_CHART_CONFIG`, `AGING_BUCKETS_CHART_CONFIG`, `OCCUPANCY_BAR_CHART_CONFIG`, `buildRevenueComparisonBarRows`, `buildRevenueSourceBarRows`, `buildReceivablesAgingBarRows`, `resolveAgingBarBucketKey`, `buildOccupancyBarRows`, `hasRevenueChartData`, `hasAgingChartData`, `hasOccupancyChartData` from `frontend/src/utils/chartHelpers.js`

- [ ] **Step 1: Add failing source/integration tests in `api/test/frontendShadcnDashboardCharts.test.js` and update `api/test/frontendWeek8ChartsAndMobile.test.js`**

Assert on `DashboardPage.jsx`:
1. Zero imports of `chart.js` or `react-chartjs-2`; zero `<Line`, `<Doughnut`, `<PieChart`, or `"Cơ cấu trạng thái căn hộ"`.
2. Imports `ChartContainer`, `ChartTooltip`, `ChartTooltipContent`, `ChartLegend`, `ChartLegendContent` from `components/ui/Chart` and `BarChart`, `Bar`, `CartesianGrid`, `XAxis`, `YAxis`, `Cell` from `recharts`.
3. Renders strictly 3 `<ChartContainer` instances corresponding to the 3 PRD charts: Doanh thu (with `comparison` grouped `billed`/`collected` bars + `source` stacked 5-source bars), Công nợ (5 PRD aging columns + `/admin/payments?tab=aging&bucket=` drill-down via `resolveAgingBarBucketKey`), and Lấp đầy (`0–100%` occupancy columns + `/admin/buildings` drill-down).
4. Preserves `<EmptyState` fallbacks (Review Focus #4) and full VND `formatMoney` tooltips.

- [ ] **Step 2: Run tests to verify RED failure**

Run: `cd d:\resihub\api; node --test test/frontendShadcnDashboardCharts.test.js test/frontendWeek8ChartsAndMobile.test.js`
Expected: FAIL (`DashboardPage.jsx` still imports `chart.js` / `react-chartjs-2` and renders `<Line>` and `<Doughnut>`).

- [ ] **Step 3: Refactor `frontend/src/pages/admin/dashboard/DashboardPage.jsx`**

Replace all Chart.js imports, state, and chart JSX with the 3 Shadcn `ChartContainer` + Recharts `BarChart` cards:
1. **Biểu đồ cột Doanh thu (`lg:col-span-7`):** Mode `comparison` (default: `billed` vs `collected` grouped columns, tooltip also displaying `Tất toán HĐ` via `footerFormatter`, bar click -> `/admin/invoices`) and Mode `source` (`stackId="revenue_source"` 5 RP-01 sources, `footerFormatter` showing `Tổng phát hành kỳ`).
2. **Biểu đồ cột Công nợ theo nhóm tuổi nợ (`lg:col-span-5`):** 5 columns with `<Cell key={entry.key} fill={entry.fill} />`, tooltip displaying `formatMoney(value)` + `(${item.payload.count} khoản)`, and `onClick={(barItem, idx) => ...}` navigating to `/admin/payments?tab=aging&bucket=${bKey}`.
3. **Biểu đồ cột Tỷ lệ lấp đầy (`col-span-full`):** Full-width column chart (`domain={[0, 100]}`, `%` ticks), tooltip displaying `${value}% (${pt.occupied}/${pt.exploitable} căn đang khai thác)`, bar click -> `/admin/buildings`. Delete the Apartment Status Doughnut card completely.

- [ ] **Step 4: Run tests, lint, production build, and live Chrome DevTools visual check**

Run:
- `cd d:\resihub\api; node --test test/frontendShadcnDashboardCharts.test.js test/frontendWeek8ChartsAndMobile.test.js test/m14DashboardChartsApi.test.js test/week8DashboardMetricsUnit.test.js`
- `cd d:\resihub\frontend; node --test (Get-ChildItem src/utils/__tests__/*.test.js).FullName; npm run lint; npm run build`
Expected: `0` test failures, `0` lint errors, clean Vite production build (`exit 0`), and live `http://localhost:3000/admin` renders strictly 3 `.recharts-wrapper` column charts with `0` console/runtime errors.

- [ ] **Step 5: Commit Task 2**

```bash
git add frontend/src/pages/admin/dashboard/DashboardPage.jsx api/test/frontendShadcnDashboardCharts.test.js api/test/frontendWeek8ChartsAndMobile.test.js
git commit -m "feat(m14-dashboard): replace Chart.js with 3 PRD Shadcn Recharts bar charts and remove extra charts"
```
