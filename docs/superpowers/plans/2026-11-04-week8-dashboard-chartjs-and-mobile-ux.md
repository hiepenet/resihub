# Week 8: Chart.js Dashboards (Revenue, Debt Aging, Occupancy) & Mobile-First Resident Portal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the 3 PRD-compliant Chart.js dashboard chart groups — **Revenue** (trend + stacked revenue by source), **Receivables Aging** (5 PRD aging buckets with drill-down), and **Occupancy** (monthly occupancy trend + current apartment status breakdown) — alongside a responsive, thumb-friendly **Mobile-First Resident Portal** (`≤ 2` taps to invoices & breakdown reporting, `≥ 44×44px` touch targets, safe-area bottom navigation, anti-zoom mobile inputs, and mobile bottom-sheet modals).

**Architecture:** Extract deterministic, timezone-safe (`Asia/Ho_Chi_Minh`) aggregation and normalization functions into `api/src/services/dashboardMetrics.js`, enrich `GET /api/v1/reports/dashboard` additively (preserving 100% backward compatibility with existing KPI and report tests under PostgreSQL RLS + `scopedBuildingFilter`), and build pure Chart.js dataset/empty-state builders in `frontend/src/utils/chartHelpers.js` consumed by `DashboardPage.jsx` and `ReportsPage.jsx` (with aging bucket drill-down wired into `PaymentsPage.jsx`). For the Resident Portal, replace the 8-tab horizontal scroll strip in `ResidentLayout.jsx` with a fixed 5-slot mobile bottom bar (`Tổng quan`, `Hóa đơn`, `Báo hỏng`, `Dịch vụ`, `Thêm` bottom-sheet drawer) backed by `frontend/src/utils/residentNavHelpers.js`, upgrade shared touch/a11y primitives (`Modal`, `Input`, `MoneyInput`, `Button`, `Tabs`, `StatsCard`), and refine mobile-first layouts across Resident tabs without violating `uiInformationCompleteness.test.js`.

**Tech Stack:** Node.js 20 (ESM), Express 4, PostgreSQL (`pg` + `FORCE ROW LEVEL SECURITY`), `node:test`, React 18, Vite, Tailwind CSS, `chart.js` (`^4.5.1`), `react-chartjs-2` (`^5.3.1`), Lucide Icons.

**Spec:** `PRD - Quan ly Can ho va Nha cho thue v2.0.md` (Sections 8.1, 10.1 `FR-038`/`FR-057`, 11 `AC-016.1`/`AC-018`/`AC-019.1`, 13.4, 15.1, 15.3, 16.1–16.4, 17 `NFR-015`) & `FRONTEND DEVELOPER Roadmap (Hiep).md` (Tuần 8: Dashboard Chart.js M14 & Hoàn thiện UI/UX).

## Global Constraints

- **Strict Scope Boundary:** Implement **only** the 3 Chart.js chart groups (Revenue, Receivables Aging, Occupancy) and the Responsive / Mobile-First Resident Portal + shared UI touch/accessibility refinements. Do **not** add out-of-scope maintenance/SLA/utility charts, Resident utility charts, or new `RP-04`/`RP-06` report tabs.
- **Backward Compatibility on `/api/v1/reports/dashboard` & `/summary`:** Existing response fields (`kpis.*`, `apartment_status_breakdown`, `revenue_12m`, `expiring_contracts`, `recent_service_requests`) and CSV/XLSX headers asserted in `api/test/settlementCreditAndKpiReports.test.js` MUST remain intact.
- **Vietnam Timezone & Integer VND Rules (`PRD 13.4`, `16.4`):** Period boundaries (`YYYY-MM`) and receivable overdue day diffs MUST use `'Asia/Ho_Chi_Minh'` (`getTodayVnDateStr()`), never UTC `new Date().toISOString().slice(0, 7)`. Monetary values are integer VND formatted as `100.000 ₫` (`formatMoney`) in tooltips and `tr ₫` / `tỷ ₫` (`formatCompactMoney`) on compact axes.
- **PRD Aging & Occupancy Formulas (`PRD 15.3`, `AC-016.1`):**
  - Aging buckets are strictly `current_not_due` (`Chưa đến hạn`, `days_overdue <= 0`), `'0_15'` (`1–15 ngày`), `'16_30'` (`16–30 ngày`), `'31_60'` (`31–60 ngày`), and `'over_60'` (`>60 ngày`) matching `PRD_AGING_BUCKETS` in `frontend/src/utils/billing.js`.
  - Occupancy excludes `INACTIVE` apartments from both numerator and denominator; `0` exploitable apartments yields `occupancy_rate: 0` and renders an `EmptyState` (`PRD 15.3`).
- **4-Role RBAC & Building Isolation (`PRD 6.2`, `13.5`, `AC-019.1`):** `/api/v1/reports/dashboard` is accessible only to `SYS_ADMIN`, `OWNER` (owned buildings only), and `MANAGER` (assigned buildings only) via `getUserClient(req)` + `scopedBuildingFilter` + `checkBuildingAccess`.
- **Mobile-First & Anti-Truncation UI Rules (`PRD 16.1`, `16.3`, `16.4`, `NFR-015`):**
  - Resident mobile bottom navigation keeps **Hóa đơn** and **Báo hỏng** within `≤ 2` taps from any screen, respects `env(safe-area-inset-bottom)`, and enforces `≥ 44×44px` touch targets on mobile interactive controls.
  - Mobile form inputs (`Input`, `MoneyInput`) use `16px` font size on `< 640px` (`text-base sm:text-sm`) to prevent iOS Safari viewport auto-zoom.
  - All anti-truncation and field-completeness assertions in `frontend/src/utils/__tests__/uiInformationCompleteness.test.js` MUST continue to pass.

## Review Focus

1. **Negative `ADJUSTMENT` Spill & `credit_offset_amount` Reconciliation in Revenue-by-Source (`PRD 15.1`, `15.3`, Migration `048`):** An `'ADJUSTED'` invoice can carry a negative `ADJUSTMENT` line (`formula_meta.adjusts_item_type = 'SERVICE'`) larger than raw `'SERVICE'` lines, plus `credit_offset_amount > 0` on `invoice`; `aggregateInvoiceLinesBySource` must map `adjusts_item_type`, spill negative bucket remainders across remaining positive buckets per invoice so no stacked bar segment is `< 0`, exclude `DRAFT`/`VOID`/`CANCELLED` invoices, and reconcile `rent + electricity + water + service + other === total_billed` (tested in Task 1 & Task 2).
2. **Zero-Apartment Division (`0/0`), `INACTIVE` Exclusion & Vietnam Month-Boundary Skew on Occupancy (`PRD 15.3`, `13.4`):** When a building has `0` apartments or only `INACTIVE` apartments, `buildMonthlyOccupancySeries` must return `occupancy_rate: 0` (never `NaN`/`Infinity`), exclude `INACTIVE` apartments across all periods, and align `period === currentPeriod` (anchored to `Asia/Ho_Chi_Minh`, including `00:30` ICT on the 1st of a month when UTC is still the previous month) with `kpis.occupancy_rate` (tested in Task 1 & Task 2).
3. **Cross-Building Leakage & Unauthorized Role Access on Enriched Dashboard Queries (`PRD 6.2`, `AC-019.1`):** Unscoped `GET /api/v1/reports/dashboard` called by `MANAGER` or `OWNER` of `Bldg A` must exclude `Bldg B` invoices, receivables, and contracts from `revenue_by_source`, `receivables_aging`, and `occupancy_12m`; passing `?building_id=<BldgB>` must return `403 ACCESS_DENIED`, and `RESIDENT` must receive `403` (tested in Task 2).
4. **Flat Zero Chart Axes Instead of `EmptyState` & Mismatched Aging Buckets (`PRD 15.3`, `16.2`, `AC-016.1`):** When all periods in range have `0` revenue, `total_debt === 0`, or `total_apartments === 0`, rendering empty axes violates `PRD 15.3`; `chartHelpers.js` + `DashboardPage.jsx` must switch to `EmptyState` with actionable navigation, and `ReportsPage.jsx` must stop plotting `0–30 / 31–60 / 61–90 / >90` so both pages display the exact 5 PRD buckets and drill down to `/admin/payments?tab=aging&bucket=<key>` (tested in Task 3).
5. **Secondary Mobile Tab Orphan State, Missing Unread Badge & `uiInformationCompleteness` Regressions (`PRD 8.1`, `16.1`, `16.3`, `16.4`):** Navigating to `contract`, `notifications`, `contact`, or `profile` on `< 1024px` must mark the `Thêm` bottom-bar trigger active, surface `unreadCount > 0` on both `Thêm` and the `Thông báo` drawer item, preserve `≤ 2` taps to `invoices`/`maintenance`, and keep `StatsCard.jsx`, `OverviewTab.jsx`, `MaintenanceTab.jsx`, `ContractTab.jsx`, and `ProfileTab.jsx` 100% compliant with `uiInformationCompleteness.test.js` (tested in Task 4).

## File Structure

- `api/src/services/dashboardMetrics.js` (Create): Pure Vietnam-timezone period generator (`6`/`12` months), invoice-line source aggregator with negative-adjustment spill handling, PRD 5-bucket aging normalizer, and monthly occupancy series builder.
- `api/src/routes/reports.js` (Modify): Validate optional `months` (`1..24`, default `12`), fix `currentPeriod` to `Asia/Ho_Chi_Minh`, and add `generated_at`, `selected_months`, `revenue_by_source`, `receivables_aging`, and `occupancy_12m` to `GET /api/v1/reports/dashboard`.
- `frontend/src/utils/chartHelpers.js` (Create): Pure Chart.js dataset/options builders, empty-state detectors, VND tooltip formatters, and PRD aging bucket mappers shared by `DashboardPage.jsx` and `ReportsPage.jsx`.
- `frontend/src/pages/admin/dashboard/DashboardPage.jsx` (Modify): Register `BarElement`, add `6 kỳ` / `12 kỳ` filter + `generated_at` subtitle, render the 3 Chart.js groups (Revenue Trend/Source toggle, Receivables Aging bar with click drill-down, Occupancy 12m line + Status doughnut) with `EmptyState` fallbacks and keyboard-accessible `StatsCard`s.
- `frontend/src/pages/admin/reports/ReportsPage.jsx` (Modify): Align `agingChartData` (`lines 319–350`) from legacy `0–30/61–90/>90` to the 5 PRD buckets via `buildReportsBuildingAgingChartData`.
- `frontend/src/pages/admin/payments/PaymentsPage.jsx` (Modify): Parse `?tab=aging&bucket=<key>` in `location.search` (`lines 222–238`) so Dashboard aging bar clicks open the `Công nợ` tab filtered to that exact bucket.
- `frontend/src/utils/residentNavHelpers.js` (Create): Pure mobile navigation model (`PRIMARY_RESIDENT_MOBILE_TAB_IDS`, `SECONDARY_RESIDENT_MOBILE_TAB_IDS`, `resolveResidentMobileNavState`, tap-depth & unread badge helpers).
- `frontend/index.html` & `frontend/src/index.css` (Modify): Add `viewport-fit=cover` and `.pb-safe` / `.mb-safe` CSS utilities using `env(safe-area-inset-bottom, 0px)` + `.no-scrollbar`.
- `frontend/src/components/layout/ResidentLayout.jsx` (Modify): Replace 8-tab horizontal scroll bar with fixed 5-slot mobile bottom bar + `Thêm` bottom-sheet drawer, unread badge indicator, and stacked `< 640px` multi-contract selector.
- `frontend/src/components/ui/Modal.jsx`, `frontend/src/components/ui/Input.jsx`, `frontend/src/components/ui/MoneyInput.jsx`, `frontend/src/components/ui/Button.jsx`, `frontend/src/components/ui/Tabs.jsx`, `frontend/src/components/common/StatsCard.jsx` (Modify): Mobile bottom-sheet modal layout, `≥ 44px` mobile touch targets, `text-base sm:text-sm` anti-zoom inputs, and WCAG 2.1 AA dialog/form/tab/button ARIA attributes.
- `frontend/src/pages/resident/tabs/OverviewTab.jsx`, `InvoicesTab.jsx`, `MaintenanceTab.jsx`, `ContractTab.jsx`, `ServicesTab.jsx`, `NotificationsTab.jsx`, `ContactTab.jsx`, `ProfileTab.jsx` (Modify): Thumb-zone 2-tap quick actions (`?tab=invoices&action=pay`, `?tab=maintenance&action=new`), stacked `< 640px` action bars, `≥ 44px` rating/call/preview controls, zero horizontal overflow at `360px`.
- `api/test/week8DashboardMetricsUnit.test.js`, `api/test/m14DashboardChartsApi.test.js`, `api/test/frontendWeek8ChartsAndMobile.test.js` (Create): Unit, API/RLS integration, and Frontend helper/source verification test suites.

---

### Task 1: Pure M14 Chart Aggregation & Normalization Helpers (`dashboardMetrics.js`)

**Files:**
- Create: `api/src/services/dashboardMetrics.js`
- Test: `api/test/week8DashboardMetricsUnit.test.js`

**Interfaces:**
- Consumes: Pure inputs only (zero DB imports).
- Produces (from `api/src/services/dashboardMetrics.js`):
  - `REVENUE_SOURCE_KEYS = ['rent', 'electricity', 'water', 'service', 'other']`
  - `AGING_BUCKET_DEFS = [{ key: 'current_not_due', label: 'Chưa đến hạn' }, { key: '0_15', label: '1–15 ngày' }, { key: '16_30', label: '16–30 ngày' }, { key: '31_60', label: '31–60 ngày' }, { key: 'over_60', label: '>60 ngày' }]`
  - `parseDashboardMonthsParam(rawMonths) -> { valid: boolean, months?: number, code?: 'VALIDATION_ERROR', message?: string }` (defaults `undefined`/`null`/`''` to `12`; accepts integers `1..24`; rejects `'abc'`, `0`, `25`, `-6`)
  - `buildRecentMonthsPeriods(todayVnYmd, months = 12) -> string[]` (returns `months` ascending `'YYYY-MM'` strings ending at `todayVnYmd.slice(0, 7)`)
  - `getPeriodEndYmd(periodYm) -> string` (returns exact `'YYYY-MM-DD'` month-end date, handling leap-year February accurately)
  - `aggregateInvoiceLinesBySource({ invoices = [], lines = [], periods = [] }) -> Array<{ period: string, rent: number, electricity: number, water: number, service: number, other: number, total_billed: number }>`
  - `normalizeReceivablesAging(rawRow = {}) -> { buckets: Array<{ key: string, label: string, amount: number, count: number }>, total_debt: number, overdue_debt: number, total_count: number }`
  - `buildMonthlyOccupancySeries({ periods = [], currentPeriod, totalExploitableApartments = 0, currentOccupiedCount = 0, monthlyOccupiedByPeriod = {} }) -> Array<{ period: string, occupied: number, exploitable: number, occupancy_rate: number }>`

- [ ] **Step 1: Write failing unit tests in `api/test/week8DashboardMetricsUnit.test.js`**

Cover pure in-memory math including *Review Focus #1 & #2*:
- `parseDashboardMonthsParam`: `undefined -> { valid: true, months: 12 }`, `'6' -> { valid: true, months: 6 }`, `'0'` / `'99'` / `'foo'` -> `{ valid: false, code: 'VALIDATION_ERROR' }`.
- `buildRecentMonthsPeriods` (*Review Focus #2*): `buildRecentMonthsPeriods('2026-03-01', 6)` returns `['2025-10', '2025-11', '2025-12', '2026-01', '2026-02', '2026-03']`; `getPeriodEndYmd('2024-02') === '2024-02-29'` and `getPeriodEndYmd('2026-02') === '2026-02-28'`.
- `aggregateInvoiceLinesBySource` (*Review Focus #1*):
  - Maps `RENT -> rent`, `ELECTRICITY -> electricity`, `WATER -> water`, `SERVICE -> service`, `LATE_FEE` + `OTHER` -> `other`.
  - Ignores invoices with `status` in `['DRAFT', 'VOID', 'CANCELLED']`.
  - Given an `'ADJUSTED'` invoice (`total_amount: 3_000_000, credit_offset_amount: 1_000_000` -> gross billed `4_000_000`) with lines `RENT = 5_000_000`, `SERVICE = 1_000_000`, and `ADJUSTMENT = -2_000_000` (`formula_meta: { adjusts_item_type: 'SERVICE' }`), `service` clamps to `0`, the `-1_000_000` remainder spills onto `rent` (`4_000_000`), every bucket is `>= 0`, and `rent + electricity + water + service + other === 4_000_000 === total_billed`.
- `normalizeReceivablesAging`: maps `current_not_due`, `bucket_0_15`, `bucket_16_30`, `bucket_31_60`, `bucket_over_60` and their counts; computes `total_debt` = sum of all 5 buckets and `overdue_debt` = sum of the 4 overdue buckets.
- `buildMonthlyOccupancySeries` (*Review Focus #2*):
  - When `totalExploitableApartments === 0`, returns `occupied: 0, exploitable: 0, occupancy_rate: 0` (not `NaN`).
  - For past periods (`< currentPeriod`), uses `monthlyOccupiedByPeriod[p]` clamped to `[0, totalExploitableApartments]` rounded to 1 decimal (`3 / 8 -> 37.5`).
  - For `period === currentPeriod`, uses `currentOccupiedCount` so the latest point matches `kpis.occupancy_rate` 100%.

- [ ] **Step 2: Run unit tests to verify they fail**

Run: `node --test --test-concurrency=1 test/week8DashboardMetricsUnit.test.js` (cwd: `d:\resihub\api`)
Expected: FAIL (`ERR_MODULE_NOT_FOUND` for `api/src/services/dashboardMetrics.js`).

- [ ] **Step 3: Implement `api/src/services/dashboardMetrics.js`**

Implement all exported constants and pure functions matching the Interfaces block. Spill negative bucket remainders deterministically in order `['other', 'service', 'water', 'electricity', 'rent']` (and if lines on a legacy seeded invoice sum below/above `invoiceBilled = total_amount + credit_offset_amount`, reconcile any residual positive delta into `other` so `total_billed` always matches invoice `billed`).

- [ ] **Step 4: Run unit tests to verify they pass**

Run: `node --test --test-concurrency=1 test/week8DashboardMetricsUnit.test.js` (cwd: `d:\resihub\api`)
Expected: PASS (0 failures).

- [ ] **Step 5: Commit**

```bash
git add api/src/services/dashboardMetrics.js api/test/week8DashboardMetricsUnit.test.js
git commit -m "feat(m14): add pure dashboard metrics helpers for revenue sources, PRD aging and occupancy"
```

---

### Task 2: Enrich `GET /api/v1/reports/dashboard` with Revenue-by-Source, PRD Aging & Occupancy Trend (`reports.js`)

**Files:**
- Modify: `api/src/routes/reports.js:1-371`
- Test: `api/test/m14DashboardChartsApi.test.js`

**Interfaces:**
- Consumes: `parseDashboardMonthsParam`, `buildRecentMonthsPeriods`, `getPeriodEndYmd`, `aggregateInvoiceLinesBySource`, `normalizeReceivablesAging`, `buildMonthlyOccupancySeries` from `api/src/services/dashboardMetrics.js`; `getTodayVnDateStr` from `api/src/services/depositSettlement.js`.
- Produces (on `GET /api/v1/reports/dashboard?building_id=<uuid>&months=<6|12>`):
  - HTTP `400 { code: 'VALIDATION_ERROR', message }` when `months` is invalid.
  - Additive fields inside `res.body.data` alongside all existing fields:
    - `generated_at: string` (ISO timestamp)
    - `selected_months: number` (`6` or `12`, default `12`)
    - `revenue_by_source: Array<{ period: string, rent: number, electricity: number, water: number, service: number, other: number, total_billed: number }>`
    - `receivables_aging: { buckets: Array<{ key: 'current_not_due' | '0_15' | '16_30' | '31_60' | 'over_60', label: string, amount: number, count: number }>, total_debt: number, overdue_debt: number, total_count: number }`
    - `occupancy_12m: Array<{ period: string, occupied: number, exploitable: number, occupancy_rate: number }>`

- [ ] **Step 1: Write failing API & RLS integration tests in `api/test/m14DashboardChartsApi.test.js`**

Follow the ephemeral Express + isolated org + full `t.after` cleanup pattern from `api/test/settlementCreditAndKpiReports.test.js`, covering *Review Focus #1, #2, #3*:
1. **Revenue by Source & Period Filter (`months=6` vs default `12`, *Review Focus #1*):**
   - Seed `Bldg A` with issued/paid/adjusted invoices containing `RENT`, `ELECTRICITY`, `WATER`, `SERVICE`, `LATE_FEE`, negative `ADJUSTMENT` (`adjusts_item_type: 'SERVICE'`), plus a `DRAFT` and `VOID` invoice.
   - Verify `DRAFT`/`VOID` lines are excluded, `revenue_by_source` for the period has non-negative buckets summing to `kpis.monthly_billed`, `?months=6` returns `revenue_12m.length === 6`, `revenue_by_source.length === 6`, `occupancy_12m.length === 6`, and `?months=0` returns `400 VALIDATION_ERROR`.
2. **Receivables Aging 5 PRD Buckets:**
   - Seed 5 `OPEN`/`PARTIALLY_PAID` receivables on `Bldg A` at `todayVn + 4d`, `todayVn - 10d`, `todayVn - 20d`, `todayVn - 45d`, `todayVn - 75d` + 1 `PAID` receivable.
   - Verify `receivables_aging.buckets` matches exact keys `['current_not_due', '0_15', '16_30', '31_60', 'over_60']`, exact unpaid balances & counts, excludes `PAID`, and `receivables_aging.total_debt === kpis.unpaid_debt`.
3. **Monthly Occupancy Series & `INACTIVE` / Empty-Building Handling (*Review Focus #2*):**
   - Seed `Bldg A` with 4 exploitable apartments (`2 OCCUPIED`, `2 AVAILABLE`) + `1 INACTIVE` apartment, and historical contracts active 2 months ago (`3` apartments) vs 1 month ago (`1` apartment).
   - Verify `exploitable === 4` (`INACTIVE` excluded), past months reflect `3/4 (75%)` and `1/4 (25%)`, current month reflects `2/4 (50%) === kpis.occupancy_rate`, and an empty `Bldg Empty` (`0` apartments) returns `occupancy_rate === 0` across all months.
4. **4-Role RBAC & Building Isolation (*Review Focus #3*):**
   - Seed `Bldg B` (same org, unassigned to `Manager A` and unowned by `Owner A`) with `50.000.000 ₫` revenue and debt.
   - Unscoped `/api/v1/reports/dashboard` for `Manager A` and `Owner A` excludes `Bldg B` completely; `?building_id=<BldgB>` returns `403 ACCESS_DENIED`; `RESIDENT` receives `403`.

- [ ] **Step 2: Run `m14DashboardChartsApi.test.js` to verify it fails**

Run: `node --test --test-concurrency=1 test/m14DashboardChartsApi.test.js` (cwd: `d:\resihub\api`)
Expected: FAIL (`revenue_by_source`, `receivables_aging`, `occupancy_12m`, and `months` validation missing).

- [ ] **Step 3: Implement enriched `/api/v1/reports/dashboard` in `api/src/routes/reports.js`**

- Replace `new Date().toISOString().slice(0, 7)` and `buildLast12MonthsPeriods()` in `/dashboard` with `const todayVn = getTodayVnDateStr(); const currentPeriod = todayVn.slice(0, 7);` and `buildRecentMonthsPeriods(todayVn, parsedMonths.months)`.
- Query scoped non-`DRAFT`/`VOID`/`CANCELLED` invoices + `invoice_line` (`il.item_type`, `il.amount`, `il.formula_meta`) for `periods` and compute `revenue_by_source` via `aggregateInvoiceLinesBySource`.
- Query scoped `receivable` (`status IN ('OPEN', 'PARTIALLY_PAID')`) using `$2::date` (`todayVn`) for the 5 PRD bucket sums + counts and normalize via `normalizeReceivablesAging`.
- Query historical contract occupancy counts per period in `periods` (`SELECT p.period, COUNT(DISTINCT c.apartment_id)::int AS occupied_count FROM unnest($2::text[]) AS p(period) LEFT JOIN contract c ... JOIN apartment a ON a.id = c.apartment_id AND a.status <> 'INACTIVE' WHERE c.status IN ('ACTIVE', 'RENEWAL_PENDING', 'TERMINATION_PENDING', 'EXPIRED', 'TERMINATED') AND c.start_date <= (date_trunc('month', (p.period || '-01')::date) + INTERVAL '1 month - 1 day')::date AND COALESCE(c.terminated_at, c.end_date) >= (date_trunc('month', (p.period || '-01')::date) + INTERVAL '1 month - 1 day')::date`) and build `occupancy_12m` via `buildMonthlyOccupancySeries`.

- [ ] **Step 4: Run new API tests + existing KPI/report regression suite**

Run: `node --test --test-concurrency=1 test/m14DashboardChartsApi.test.js test/settlementCreditAndKpiReports.test.js` (cwd: `d:\resihub\api`)
Expected: PASS (0 failures).

- [ ] **Step 5: Commit**

```bash
git add api/src/routes/reports.js api/test/m14DashboardChartsApi.test.js
git commit -m "feat(api): enrich /reports/dashboard with revenue sources, PRD aging buckets and occupancy trend"
```

---

### Task 3: Frontend Chart.js Trio (Revenue, Debt Aging, Occupancy), Empty States & Drill-Down (`DashboardPage`, `ReportsPage`, `PaymentsPage`)

**Files:**
- Create: `frontend/src/utils/chartHelpers.js`
- Modify: `frontend/src/pages/admin/dashboard/DashboardPage.jsx`
- Modify: `frontend/src/pages/admin/reports/ReportsPage.jsx:319-350`
- Modify: `frontend/src/pages/admin/payments/PaymentsPage.jsx:222-238`
- Modify: `frontend/src/components/common/StatsCard.jsx`
- Test: `api/test/frontendWeek8ChartsAndMobile.test.js`

**Interfaces:**
- Consumes: `GET /api/v1/reports/dashboard` (`revenue_12m`, `revenue_by_source`, `receivables_aging`, `occupancy_12m`, `apartment_status_breakdown`, `generated_at`, `selected_months`) from Task 2; `formatMoney`, `formatCompactMoney` from `frontend/src/utils/format.js`; `PRD_AGING_BUCKETS` from `frontend/src/utils/billing.js`.
- Produces (from `frontend/src/utils/chartHelpers.js`):
  - `DASHBOARD_AGING_BUCKET_KEYS = ['current_not_due', '0_15', '16_30', '31_60', 'over_60']`
  - `hasRevenueChartData(revenueSeries = [], sourceSeries = []) -> boolean`
  - `hasAgingChartData(receivablesAging) -> boolean`
  - `hasOccupancyChartData(totalApartments = 0, occupancySeries = []) -> boolean`
  - `buildRevenueTrendChartData(revenueSeries = []) -> object` (`Line` chart data: `Phát hành`, `Tất toán hóa đơn`, `Thực thu ròng`)
  - `buildRevenueBySourceChartData(sourceSeries = []) -> object` (`Bar` stacked chart data: `Tiền phòng`, `Điện`, `Nước`, `Dịch vụ`, `Phí trễ hạn & Khác` with `stack: 'revenue_source'`)
  - `buildReceivablesAgingChartData(receivablesAging = {}) -> { chartData: object, bucketKeys: string[], counts: number[] }` (`Bar` chart data for the 5 PRD buckets)
  - `buildOccupancyTrendChartData(occupancySeries = []) -> { chartData: object, metaPoints: Array<{ occupied: number, exploitable: number, occupancy_rate: number }> }` (`Line` chart data `0..100%`)
  - `buildApartmentStatusDoughnutData(breakdown = {}) -> object` (`Doughnut` chart data)
  - `buildReportsBuildingAgingChartData(agingByBuildingRows = []) -> object` (5 PRD datasets `current_not_due`, `bucket_0_15`, `bucket_16_30`, `bucket_31_60`, `bucket_over_60` for `ReportsPage.jsx`)
  - `resolvePaymentsUrlQuery(searchStr = '') -> { tab: string | null, creditStatus: string, agingBucket: string }` (parses `?tab=aging&bucket=0_15` as well as `?tab=credits&status=PENDING_DIRECT_REFUND`)

- [ ] **Step 1: Write failing Frontend chart tests in `api/test/frontendWeek8ChartsAndMobile.test.js`**

Assert pure chart builders & *Review Focus #4*:
- `hasRevenueChartData`, `hasAgingChartData`, `hasOccupancyChartData` return `false` for all-zero series / `0` apartments and `true` as soon as any positive VND amount or exploitable apartment exists.
- `buildRevenueBySourceChartData` produces 5 datasets all carrying `stack: 'revenue_source'` matching period sums.
- `buildReceivablesAgingChartData` maps the exact 5 PRD bucket labels & keys `['current_not_due', '0_15', '16_30', '31_60', 'over_60']`; `resolvePaymentsUrlQuery('?tab=aging&bucket=16_30')` returns `{ tab: 'aging', agingBucket: '16_30', creditStatus: '' }`.
- `buildReportsBuildingAgingChartData` maps `current_not_due`, `bucket_0_15`, `bucket_16_30`, `bucket_31_60`, `bucket_over_60` (and source scan of `ReportsPage.jsx` confirms legacy `bucket_61_90` / `bucket_over_90` are no longer plotted).
- Source scan of `DashboardPage.jsx` confirms `BarElement` is registered in `ChartJS.register(...)` and `<EmptyState` is rendered for empty chart fallbacks.

- [ ] **Step 2: Run `frontendWeek8ChartsAndMobile.test.js` to verify it fails**

Run: `node --test --test-concurrency=1 test/frontendWeek8ChartsAndMobile.test.js` (cwd: `d:\resihub\api`)
Expected: FAIL (`ERR_MODULE_NOT_FOUND` for `frontend/src/utils/chartHelpers.js`).

- [ ] **Step 3: Implement `chartHelpers.js` and update `DashboardPage.jsx`, `ReportsPage.jsx`, `PaymentsPage.jsx`, and `StatsCard.jsx`**

- In `DashboardPage.jsx`:
  - Register `BarElement` in `ChartJS.register(...)` and import `Bar` from `react-chartjs-2` + `EmptyState`.
  - Add `months` state (`12` default, toggle buttons `6 kỳ` / `12 kỳ` in `PageHeader` actions alongside `Làm mới`, passing `{ building_id, months }` to `reportsService.getDashboard`) and display `Cập nhật lúc ${formatDateTime(data?.generated_at)}` in subtitle when present (`PRD 15.3`).
  - **Chart 1 — Doanh thu (`Card` with mode switch `'trend'` Xu hướng thu [`Line`] vs `'source'` Theo nguồn thu [`Bar` stacked]):** format tooltips with `formatMoney`, Y-axis ticks with `formatCompactMoney`, and render `EmptyState` (`title="Chưa phát sinh doanh thu trong giai đoạn này"`, action button `"Quản lý hóa đơn"` -> `/admin/invoices`) when `!hasRevenueChartData(...)`.
  - **Chart 2 — Công nợ theo nhóm tuổi nợ (`Card` with `Bar` chart):** render the 5 PRD buckets, show invoice count + `formatMoney` in tooltip, wire Chart.js `onClick` element hit to `navigate(\`/admin/payments?tab=aging&bucket=\${bucketKeys[idx]}\`)`, and render positive `EmptyState` (`title="Không có công nợ tồn đọng"`) when `!hasAgingChartData(...)`.
  - **Chart 3 — Tỷ lệ lấp đầy & Cơ cấu căn hộ (`Line` monthly occupancy `%` `min: 0, max: 100` + `Doughnut` current status breakdown):** tooltip shows `${rate}% (${occupied}/${exploitable} căn đang khai thác)`, with `EmptyState` (`title="Chưa có căn hộ khai thác"`, action `"Thiết lập tòa nhà"` -> `/admin/buildings`) when `!hasOccupancyChartData(...)`.
- In `ReportsPage.jsx:319-350`: replace `agingChartData` body with `buildReportsBuildingAgingChartData(reportData.aging_by_building)`.
- In `PaymentsPage.jsx:222-238`: use `resolvePaymentsUrlQuery(location.search)` so `?tab=aging&bucket=<key>` activates `setActiveTab('aging')` and `setAgingBucketFilter(agingBucket)`.
- In `StatsCard.jsx`: add `role={onClick ? 'button' : undefined}`, `tabIndex={onClick ? 0 : undefined}`, and `onKeyDown` (`Enter`/`Space` triggers `onClick`) without adding `truncate` to `value` or `subtext`.

- [ ] **Step 4: Run Frontend chart tests + existing UI completeness tests**

Run 1: `node --test --test-concurrency=1 test/frontendWeek8ChartsAndMobile.test.js` (cwd: `d:\resihub\api`)
Run 2: `node --test src/utils/__tests__/uiInformationCompleteness.test.js` (cwd: `d:\resihub\frontend`)
Expected: PASS (0 failures).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/utils/chartHelpers.js frontend/src/pages/admin/dashboard/DashboardPage.jsx frontend/src/pages/admin/reports/ReportsPage.jsx frontend/src/pages/admin/payments/PaymentsPage.jsx frontend/src/components/common/StatsCard.jsx api/test/frontendWeek8ChartsAndMobile.test.js
git commit -m "feat(m14-ui): add Chart.js revenue source, PRD debt aging and occupancy charts with drill-down"
```

---

### Task 4: Mobile-First Resident Portal Navigation, Touch Targets, Safe-Area & Responsive Tabs

**Files:**
- Create: `frontend/src/utils/residentNavHelpers.js`
- Modify: `frontend/index.html`
- Modify: `frontend/src/index.css`
- Modify: `frontend/src/components/layout/ResidentLayout.jsx`
- Modify: `frontend/src/components/ui/Modal.jsx`
- Modify: `frontend/src/components/ui/Input.jsx`
- Modify: `frontend/src/components/ui/MoneyInput.jsx`
- Modify: `frontend/src/components/ui/Button.jsx`
- Modify: `frontend/src/components/ui/Tabs.jsx`
- Modify: `frontend/src/pages/resident/tabs/OverviewTab.jsx`
- Modify: `frontend/src/pages/resident/tabs/InvoicesTab.jsx`
- Modify: `frontend/src/pages/resident/tabs/MaintenanceTab.jsx`
- Modify: `frontend/src/pages/resident/tabs/ContractTab.jsx`
- Modify: `frontend/src/pages/resident/tabs/ServicesTab.jsx`
- Modify: `frontend/src/pages/resident/tabs/NotificationsTab.jsx`
- Modify: `frontend/src/pages/resident/tabs/ContactTab.jsx`
- Modify: `frontend/src/pages/resident/tabs/ProfileTab.jsx`
- Test: `api/test/frontendWeek8ChartsAndMobile.test.js`

**Interfaces:**
- Consumes: `RESIDENT_PORTAL_TABS` from `frontend/src/constants/navigation.js`; `unreadCount` from `useNotificationStore`.
- Produces (from `frontend/src/utils/residentNavHelpers.js`):
  - `PRIMARY_RESIDENT_MOBILE_TAB_IDS = ['overview', 'invoices', 'maintenance', 'services']`
  - `SECONDARY_RESIDENT_MOBILE_TAB_IDS = ['contract', 'notifications', 'contact', 'profile']`
  - `resolveResidentMobileNavState({ activeTab = 'overview', unreadCount = 0, tabs = RESIDENT_PORTAL_TABS }) -> { primaryTabs: Array<object>, secondaryTabs: Array<object>, isMoreActive: boolean, moreBadgeCount: number, activeSecondaryTab: object | null }`
  - `getResidentActionTapCount(targetAction) -> number` (`'view_invoices' -> 1`, `'pay_invoice' -> 2`, `'view_maintenance' -> 1`, `'create_maintenance' -> 2`, `'open_secondary_tab' -> 2`)

- [ ] **Step 1: Extend `api/test/frontendWeek8ChartsAndMobile.test.js` with failing Mobile-First Resident Portal tests**

Add unit + component source assertions covering *Review Focus #5* and `PRD 16.1–16.4`:
- `resolveResidentMobileNavState`:
  - Returns exact 4 primary tabs (`overview`, `invoices`, `maintenance`, `services`) and 4 secondary tabs (`contract`, `notifications`, `contact`, `profile`).
  - When `activeTab === 'notifications'` and `unreadCount === 5`, `isMoreActive === true`, `moreBadgeCount === 5`, and `activeSecondaryTab.id === 'notifications'`.
  - When `activeTab === 'invoices'` and `unreadCount === 0`, `isMoreActive === false` and `moreBadgeCount === 0`.
  - `getResidentActionTapCount('pay_invoice') <= 2` and `getResidentActionTapCount('create_maintenance') <= 2` (`PRD 16.1`).
- Source & accessibility checks:
  - `frontend/index.html` contains `viewport-fit=cover`; `frontend/src/index.css` defines `.pb-safe` with `env(safe-area-inset-bottom`.
  - `ResidentLayout.jsx` uses `resolveResidentMobileNavState`, renders a `grid-cols-5` fixed bottom bar (`min-h-[56px]`, `pb-safe`) without `overflow-x-auto` cramming all 8 tabs, and opens a `Modal` / bottom-sheet drawer for secondary tabs showing `unreadCount` on `notifications` + logout action.
  - `Input.jsx` and `MoneyInput.jsx` apply `text-base sm:text-sm` and `min-h-[44px]` on mobile plus `aria-invalid` and `aria-describedby`.
  - `Modal.jsx` applies `role="dialog"`, `aria-modal="true"`, `aria-labelledby`, mobile bottom-sheet positioning (`items-end sm:items-center`), and `aria-label` on close buttons.
  - `Tabs.jsx` applies `role="tablist"`, `role="tab"`, `aria-selected`, and `min-h-[44px]`.

- [ ] **Step 2: Run `frontendWeek8ChartsAndMobile.test.js` to verify new mobile assertions fail**

Run: `node --test --test-concurrency=1 test/frontendWeek8ChartsAndMobile.test.js` (cwd: `d:\resihub\api`)
Expected: FAIL (`ERR_MODULE_NOT_FOUND` for `frontend/src/utils/residentNavHelpers.js`).

- [ ] **Step 3: Implement `residentNavHelpers.js`, Safe-Area / Touch UI Primitives, `ResidentLayout.jsx` Bottom Bar & Resident Tab Mobile Polish**

1. **Viewport & Safe Area (`frontend/index.html`, `frontend/src/index.css`):**
   - Update viewport meta to `width=device-width, initial-scale=1.0, viewport-fit=cover`.
   - Add `.pb-safe { padding-bottom: env(safe-area-inset-bottom, 0px); }`, `.mb-safe { margin-bottom: env(safe-area-inset-bottom, 0px); }`, and `.no-scrollbar` utility rules in `index.css`.
2. **UI Primitives (`Input.jsx`, `MoneyInput.jsx`, `Button.jsx`, `Modal.jsx`, `Tabs.jsx`):**
   - `Input.jsx` & `MoneyInput.jsx`: add `errorId`/`hintId` via `useId()`, wire `aria-invalid={Boolean(error)}` + `aria-describedby`, and use `min-h-[44px] sm:min-h-0 sm:h-9 text-base sm:text-sm` so mobile inputs meet `44px` tap targets and never trigger iOS Safari auto-zoom.
   - `Button.jsx`: update mobile touch heights (`sm`: `min-h-[40px] sm:min-h-0 sm:h-8`, `md`: `min-h-[44px] sm:min-h-0 sm:h-9`, `lg`: `min-h-[48px] sm:min-h-0 sm:h-11`).
   - `Modal.jsx`: add `useId()` `titleId`, `role="dialog"`, `aria-modal="true"`, `aria-labelledby={title ? titleId : undefined}`, `aria-label="Đóng hộp thoại"` + `min-w-[44px] min-h-[44px] sm:min-w-0 sm:min-h-0` on close buttons, and mobile bottom-sheet framing (`items-end sm:items-center p-0 sm:p-4`, panel `rounded-t-2xl sm:rounded-2xl max-h-[92dvh] sm:max-h-[90vh]`, footer `pb-safe`).
   - `Tabs.jsx`: add `role="tablist"` on container, `role="tab"`, `aria-selected={isActive}`, and `min-h-[44px] sm:min-h-0` on tab buttons with `no-scrollbar`.
3. **Mobile-First `ResidentLayout.jsx` (`PRD 8.1`, `16.1`, `16.3`):**
   - Increase bottom clearance on root wrapper (`pb-24 lg:pb-0`) so content is never hidden behind the fixed bottom bar.
   - Move the multi-contract `<Select>` onto a clean full-width second row inside `<header>` on `< 640px` (`sm:hidden` vs `hidden sm:block`) so `360px` screens never overflow horizontally.
   - Replace the 8-tab horizontal scroll `<nav>` with a fixed `grid-cols-5` bottom bar (`min-h-[56px] pb-safe`): 4 primary tabs (`Tổng quan`, `Hóa đơn`, `Báo hỏng`, `Dịch vụ`) + 5th `Thêm` trigger (`MoreHorizontal` icon, highlighted when `isMoreActive === true`, showing badge when `moreBadgeCount > 0`) opening a mobile bottom-sheet `<Modal>` listing `Hợp đồng & Cọc`, `Thông báo` (with `unreadCount` badge), `Danh bạ BQL`, `Hồ sơ cá nhân`, and `Đăng xuất` (each item `min-h-[48px]`).
4. **Mobile-First Polish Across Resident Tabs (`OverviewTab`, `InvoicesTab`, `MaintenanceTab`, `ContractTab`, `ServicesTab`, `NotificationsTab`, `ContactTab`, `ProfileTab`):**
   - `OverviewTab.jsx`: add a thumb-friendly 2-column mobile Quick Action strip at the top for active contracts (**Thanh toán hóa đơn** -> `onNavigateTab('invoices', { action: 'pay' })` and **Báo hỏng ngay** -> `onNavigateTab('maintenance', { action: 'new' })`, `min-h-[48px]`), ensuring 2-tap completion from landing; preserve zero `truncate` on KPI values/subtitles and `total_amount_due_all`.
   - `InvoicesTab.jsx`: stack invoice card header & action buttons cleanly on `< 640px` (`w-full sm:w-auto` on `"Báo đã thanh toán"`), enlarge meter-photo and receipt preview tap areas (`min-h-[44px]`).
   - `MaintenanceTab.jsx`: make `"Gửi yêu cầu báo hỏng"` `w-full sm:w-auto` on `< 640px`, add `min-w-[44px] min-h-[44px]` tap targets on 1–5 star rating buttons, and preserve `internal_note` & `resolved_at` display.
   - `ContractTab.jsx`, `ServicesTab.jsx`, `NotificationsTab.jsx`, `ContactTab.jsx`, `ProfileTab.jsx`: stack header/card CTAs (`flex-col sm:flex-row`, `w-full sm:w-auto` on `< 640px`), enforce `min-h-[44px]` on `tel:` / Zalo contact buttons in `ContactTab.jsx`, and preserve `deposit_refund_due_date` and `id_images` rendering.

- [ ] **Step 4: Run full Frontend & Backend verification suites**

Run 1: `node --test --test-concurrency=1 test/frontendWeek8ChartsAndMobile.test.js test/week8DashboardMetricsUnit.test.js test/m14DashboardChartsApi.test.js` (cwd: `d:\resihub\api`)
Run 2: `node --test src/utils/__tests__/*.test.js` (cwd: `d:\resihub\frontend`)
Run 3: `npm run lint` and `npm run build` (cwd: `d:\resihub\frontend`)
Run 4: `npm test` (cwd: `d:\resihub\api`)
Expected: All unit/integration/UI tests PASS, `eslint` and `vite build` exit `0`, and 100% of backend test suites pass with zero leaked test rows.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/utils/residentNavHelpers.js frontend/index.html frontend/src/index.css frontend/src/components/layout/ResidentLayout.jsx frontend/src/components/ui/Modal.jsx frontend/src/components/ui/Input.jsx frontend/src/components/ui/MoneyInput.jsx frontend/src/components/ui/Button.jsx frontend/src/components/ui/Tabs.jsx frontend/src/pages/resident/tabs/OverviewTab.jsx frontend/src/pages/resident/tabs/InvoicesTab.jsx frontend/src/pages/resident/tabs/MaintenanceTab.jsx frontend/src/pages/resident/tabs/ContractTab.jsx frontend/src/pages/resident/tabs/ServicesTab.jsx frontend/src/pages/resident/tabs/NotificationsTab.jsx frontend/src/pages/resident/tabs/ContactTab.jsx frontend/src/pages/resident/tabs/ProfileTab.jsx api/test/frontendWeek8ChartsAndMobile.test.js
git commit -m "feat(resident-ux): mobile-first bottom nav, 44px touch targets, bottom-sheet modals and responsive tabs"
```
