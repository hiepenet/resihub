# Week 5 Billing Engine & Invoices (M08, M09, FR-063..FR-066) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a production-grade, unit- and integration-tested Week 5 Billing & Invoice Engine covering pro-rata rent/service math, 3-tier price priority (Contract → Building → Default), M08 meter reading confirmation & 3-period rolling anomaly detection with strict `MANAGER`-only write RLS, daily Vietnam-time cron `DRAFT` invoice generation by `billing_day` with PostgreSQL advisory locking + 3-attempt retry, and `100.000 ₫/day` late-fee accrual after 5 grace days.

**Architecture:** Consolidate all financial, calendar, meter-anomaly, late-fee, and cron-schedule formulas into pure, zero-I/O ESM functions in `api/src/services/pricing.js` and `api/src/services/serviceBilling.js` backed by `>= 80%` unit test coverage (`NFR-014`). Wire these pure functions into `meters.js`, `deposits.js`, `invoices.js`, `contracts.js`, `services.js`, `resident.js`, and `daily.js` on top of an additive PostgreSQL 16 migration (`049`) that enforces `FORCE ROW LEVEL SECURITY`, the 4-role RBAC matrix (`PRD 6.2`), and 100% compatibility with all existing integration suites.

**Tech Stack:** Node.js 20+ ESM (`"type": "module"`), Express 4, PostgreSQL 16 (`pg` 8.13, `FORCE ROW LEVEL SECURITY`, `pg_try_advisory_lock`), `node:test` + `node:assert/strict`, React 18 + Vite + Tailwind CSS.

**Spec:**
- `PRD - Quan ly Can ho va Nha cho thue v2.0.md` (Sections 5.3, 6.2, 7.1, 7.2, 8 M08/M09/M10, 9.2 FR-033/FR-034, 10 FR-063..FR-066, 11 AC-003.1..AC-003.2 & AC-015.1..AC-015.3, 13.2, 13.6, 14.3, 14.5, 18.1, NFR-001, NFR-008, NFR-014, NFR-017)
- `docs/superpowers/specs/2026-11-02-service-cancellation-and-invoice-recalc-design.md` (Section 4.3.6 append-only `LATE_FEE` on overdue invoice & 4-eyes `invoice_adjustment`)

## Global Constraints

- **Currency & Rounding (`FR-063`, `PRD 10.3`):** All VND amounts stored as integer `BIGINT` (`>= 0` on totals); every pro-rata, utility, and fee computation rounds to nearest `1.000 ₫` via `roundVND(amount)` (`Math.round(amount / 1000) * 1000`, matching SQL `ROUND(x, -3)`). Never persist floating-point VND amounts.
- **Pro-Rata Denominator (`FR-063`, `AC-015.3`):** `roundVND(unit_price * quantity * active_days / days_in_month)` using the actual calendar days of that month (`28`, `29`, `30`, or `31`), inclusive of `start_date` and `lastActiveDayYmd` (`terminated_at` for early move-out; `child_start_date - 1 day` for room transfer; `end_date - 1 day` for half-open natural expiry; same-day move-in & move-out = `1` active day).
- **3-Tier Price Priority (`FR-065`):** `1. CONTRACT_OVERRIDE` (`contract_service_price` with `effective_from <= periodEndYmd`, latest `effective_from` wins, matching canonical aliases `ELECTRICITY`/`ELEC`, `WATER`/`DOMESTIC_WATER`, `INTERNET_FIBER`/`INTERNET`/`WIFI`, `MANAGEMENT_FEE`/`MANAGEMENT`/`COMMON_SERVICE`, `PARKING_MOTO`/`MOTORBIKE_PARKING`) → `2. SUBSCRIPTION_LOCKED` (when `subscription.is_price_locked === true`) → `3. BUILDING_CATALOG` (`service_catalog.building_id = contract.building_id` and `is_active = TRUE`) → `4. DEFAULT_CATALOG` (`service_catalog.building_id IS NULL` and `is_active = TRUE`; for metered utilities, `METER_CONFIG` `meter.unit_price > 0` sits between `BUILDING_CATALOG` and org `DEFAULT_CATALOG`).
- **Meter Reading Lifecycle & Anomaly (`PRD 7.1`, `13.2`, `FR-030`, `FR-031`, `AC-015.1`):** `meter_reading.status IN ('DRAFT', 'CONFIRMED', 'FLAGGED')`; `current_reading >= previous_reading` enforced; anomaly triggers when consumption deviates `> 30%` (configurable via `billing_config.meter_anomaly_threshold_pct`) vs the arithmetic mean of up to **3** prior `CONFIRMED` periods with `consumption > 0`; apartments with `ACTIVE` meters lacking `CONFIRMED` readings for `period` are skipped during invoice generation (`reason_code: 'MISSING_CONFIRMED_METER_READING'`) and block M06 final deposit settlement (`MISSING_FINAL_METER_READING`).
- **Invoice Lifecycle (`PRD 7.2`, `FR-033`, `FR-034`, `AC-003.1`, `AC-003.2`):** Cron and manual batch generation default to `DRAFT` (`auto_issue = false`); `DRAFT` invoices and unconfirmed meter readings are hidden from `RESIDENT`; utility `invoice_line.formula_meta` stores structured `{ meter_id, reading_id, previous_reading, current_reading, consumption, price_source }`; unique active invoice per `(contract_id, period)` enforced (`WHERE status <> 'VOID'`).
- **Late Payment Penalty (`FR-064`, Spec `2026-11-02` §4.3.6):** Append-only `LATE_FEE` lines directly on the overdue invoice at `100.000 ₫/day` (`billing_config.late_fee_per_day`) starting after `5` grace days (`billing_config.late_fee_grace_days`, i.e., `overdue_days > 5` → `(overdue_days - 5) * 100000`), optional `billing_config.late_fee_cap` (`null` = uncapped). Accrual locks the invoice row `FOR UPDATE`, stops accruing new penalties once principal is fully settled (`principalAmount <= paidAmount + creditOffsetAmount`), and computes `deltaFee = Math.max(0, expectedFee - grossAccruedLateFee)` so approved 4-eyes `LATE_FEE` waivers are never overwritten.
- **Timezone, Idempotency & Cron Reliability (`FR-066`, `PRD 14.3`, `14.5`, `NFR-017`):** All business dates/periods on Backend and Frontend computed in `Asia/Ho_Chi_Minh` (`UTC+7`), never `new Date().toISOString().slice(0, 10)` or `slice(0, 7)`; all M08/M09 write routes attach `idempotencyGuard()`; daily cron acquires session-level `pg_try_advisory_lock(73918205)`, retries up to `3` attempts with exponential backoff (`1s`, `2s`, `4s`) before alerting `SYS_ADMIN`, and logs execution metrics to `cron_job_run`.
- **RBAC & RLS (`PRD 6.2`, `NFR-008`, `036_simplify_roles.sql`, `048`):** Preserve the 4-role model (`SYS_ADMIN`, `OWNER`, `MANAGER`, `RESIDENT`) and `ENABLE` + `FORCE ROW LEVEL SECURITY` on all tables; `SYS_ADMIN` and `OWNER` are strictly **Read-Only** on M08 (`meter`, `meter_reading`) and M09 financial transactions (`MANAGER` only for M08 writes, using `req.user.sub` as actor UUID); `rls_audit_log_select` and `fn_get_finance_resource_scope` include `'meter'` and `'meter_reading'`.
- **Test Runner & Coverage (`NFR-014`):** Run backend tests serially via `node --test --test-concurrency=1` inside `d:\resihub\api`; verify `pricing.js` + `serviceBilling.js` line coverage `>= 80%` via `--experimental-test-coverage`.

## Review Focus

1. **Vietnam midnight window (`00:00–06:59 +07:00`, when UTC is still the previous day/month):** Running cron, `POST /api/v1/invoices/generate-batch`, or Frontend `getCurrentPeriod()` at `2026-11-01T00:05:00+07:00` (`2026-10-31T17:05:00Z`) must resolve `period = '2026-11'`, `billing_day = 1`, `issue_date = '2026-11-01'`, and `due_date = '2026-11-06'` — never October UTC. *(Pinned in Task 1, Task 3 & Task 5)*
2. **Unlocked subscription & utility building-price fallback (`FR-065`):** When `service_subscription.is_price_locked === false` and no `contract_service_price` override exists, updating a building-specific `service_catalog` row (`building_id = contract.building_id`) must immediately reflect in `generateInvoicesCore`, `GET /api/v1/contracts/:id` `invoice_schedule`, and subscription pro-rata previews, while falling back to `meter.unit_price` / org default (`building_id IS NULL`) for other buildings. *(Pinned in Task 1 & Task 3)*
3. **Approved 4-eyes `LATE_FEE` waiver & principal-settled stop condition (`FR-064`):** When an overdue invoice accrues `300.000 ₫` in `LATE_FEE`, receives an approved `-200.000 ₫` `LATE_FEE` waiver (`ADJUSTMENT`), and stays unpaid on `due_date + 9` (`expectedFee = 400.000 ₫`), cron appends only `deltaFee = 100.000 ₫`; once principal (`subtotal` excluding `LATE_FEE` + non-`LATE_FEE` adjustments) is fully covered by `paid_amount + credit_offset_amount`, cron appends `0 ₫` so unpaid late fees never compound on themselves. *(Pinned in Task 1 & Task 4)*
4. **Leap-year vs non-leap February `billing_day` clamping (`FR-066`):** Contracts with `billing_day = 29`, `30`, or `31` must NOT trigger on `2028-02-28` (leap year — only `[28]` matches) and MUST trigger on `2028-02-29` (`[29, 30, 31]`), whereas on `2026-02-28` (non-leap) `[28, 29, 30, 31]` all trigger together once; `SettingsPage` must allow configuring `billing_day` across `1..31` (not clamped to `28`). *(Pinned in Task 1, Task 4 & Task 5)*
5. **Zero-consumption vacant months, cold start & RBAC/RLS isolation in M08 (`FR-031`, `PRD 6.2`):** Prior periods with `0` consumption (`[0, 100, 110]`) or empty history (`[]`) must average only positive `CONFIRMED` consumptions (`105`) without division by zero; `SYS_ADMIN` attempting `POST /api/v1/meters` or `/readings` gets `403`, and `RESIDENT` cannot read `DRAFT`/`FLAGGED` meter readings before confirmation. *(Pinned in Task 1 & Task 2)*

## File Structure

- `api/src/services/pricing.js` — Low-level VND rounding (`roundVND`), generic day pro-rata (`calcProrata`), and metered consumption math (`calcUtility`).
- `api/src/services/serviceBilling.js` — Pure domain engine for Vietnam calendar helpers, canonical service/utility aliases, rent/subscription pro-rata, 3-tier service & utility price resolution, `billing_day` clamping, Vietnam cron next-run timer math, late-fee accrual, and 3-period meter anomaly evaluation.
- `api/src/db/migrations/049_m08_m09_billing_engine_and_cron_lock.sql` — Additive schema & RLS migration: `meter_reading` confirmation columns (`status`, `confirmed_by`, `confirmed_at`, `baseline_avg_consumption`), hardened M08 RLS policies (`MANAGER`-only writes, `CONFIRMED`-only resident reads), `fn_get_finance_resource_scope` + `rls_audit_log_select` extensions for `meter`/`meter_reading`, `cron_job_run` table + RLS, and `billing_config` JSONB default keys.
- `api/src/routes/meters.js` & `api/src/routes/deposits.js` — M08 `MANAGER`-only write RBAC + `idempotencyGuard()`, RLS-scoped client usage (`pool` / `getUserClient`), Vietnam period defaults, 3-period rolling anomaly detection, `DRAFT`/`FLAGGED`/`CONFIRMED` lifecycle + `/confirm` & `/confirm-batch` routes, and M06 final-settlement check requiring `m.status = 'ACTIVE'` and `mr.status = 'CONFIRMED'`.
- `api/src/routes/settings.js` — Preserves and normalizes `billing_config` fields (`billing_day` `1..31`, `due_date_offset_days` / `payment_due_days`, `late_fee_grace_days`, `late_fee_per_day`, `late_fee_cap`, `meter_anomaly_threshold_pct`).
- `api/src/routes/invoices.js`, `api/src/routes/contracts.js`, `api/src/routes/services.js`, `api/src/routes/resident.js` — 3-tier `catalogItems` fallback for services & utilities, `AC-015.1` confirmed-meter gate, structured `formula_meta` readings (`AC-003.1`), Vietnam date helpers, and removal of legacy local-Date `computeProrata` in both `services.js` and `resident.js`.
- `api/src/jobs/daily.js` — Injectable `{ asOfDate, buildingId }` across all steps, session `pg_try_advisory_lock(73918205)`, 3-attempt retry with backoff + `SYS_ADMIN` failure alert (`PRD 14.5`), `cron_job_run` logging, deterministic `00:05` ICT scheduler with boot catch-up, `AC-015.1` manager notifications, and row-locked `FOR UPDATE` `computeLateFeeAccrual`.
- `frontend/src/utils/format.js`, `frontend/src/utils/billing.js`, `frontend/src/services/meters.service.js`, `frontend/src/pages/admin/invoices/InvoicesPage.jsx`, `frontend/src/pages/admin/meters/MeterReadingsPage.jsx`, `frontend/src/pages/admin/settings/SettingsPage.jsx` — Vietnam-timezone `getCurrentPeriod()`, `DRAFT`-first batch generation, M08 `DRAFT`/`FLAGGED`/`CONFIRMED` badges + `MANAGER`-only confirm actions, `billing_day` `1..31`, and late-fee/anomaly settings.
- `api/test/billingEngineUnit.test.js`, `api/test/m08MeterLifecycleAndAnomaly.test.js`, `api/test/m09InvoicePricingAndMeterGate.test.js`, `api/test/week5DailyCronAndLateFee.test.js`, `api/test/frontendBillingHelpers.test.js` — Unit and integration test suites.

---

### Task 1: Pure Billing, 3-Tier Utility/Service Pricing, Cron Day-Matching, Late Fee & Meter Anomaly Engine

**Files:**
- Modify: `api/src/services/pricing.js`
- Modify: `api/src/services/serviceBilling.js`
- Test: `api/test/billingEngineUnit.test.js`

**Interfaces:**
- Consumes: Existing `roundVND(amount)` in `api/src/services/pricing.js`; existing `todayVietnamYmd(now)`, `currentVietnamPeriod(now)`, `getMonthBoundsYmd`, `toDateOnlyYmd`, `diffDaysYmd`, `getCanonicalServiceAliases`, `resolveServiceUnitPrice`, `computeSubscriptionPeriodCharge`, `computeContractRentPeriodCharge` in `api/src/services/serviceBilling.js`.
- Produces:
  - From `api/src/services/pricing.js`:
    - `roundVND(amount: number) -> number`
    - `calcProrata({ monthlyPrice, quantity = 1, activeDays, daysInMonth }) -> number`
    - `calcUtility({ previousReading, currentReading, unitPrice }) -> number` (throws `RangeError('INVALID_READING')` when `currentReading < previousReading`)
  - From `api/src/services/serviceBilling.js`:
    - Updated `CANONICAL_ALIAS_GROUPS` including `['ELECTRICITY', 'ELEC']`, `['WATER', 'DOMESTIC_WATER']`, `['INTERNET_FIBER', 'INTERNET', 'WIFI']`, `['MANAGEMENT_FEE', 'MANAGEMENT', 'COMMON_SERVICE']`, `['PARKING_MOTO', 'MOTORBIKE_PARKING']`
    - `resolveUtilityUnitPrice({ meterType, meterUnitPrice, contractBuildingId, periodEndYmd, contractServicePrices = [], catalogItems = [], defaultUtilityPrice = 0 }) -> { unitPrice: number, priceSource: 'CONTRACT_OVERRIDE' | 'BUILDING_CATALOG' | 'METER_CONFIG' | 'DEFAULT_CATALOG' }`
    - `resolveBillingDaysForDate(asOfDateYmd: string) -> number[]` (e.g. `'2026-02-28' -> [28, 29, 30, 31]`, `'2028-02-28' -> [28]`, `'2028-02-29' -> [29, 30, 31]`, `'2026-04-30' -> [30, 31]`)
    - `computeNextVietnamDailyRunMs(nowDate?: Date, targetHour?: number, targetMinute?: number) -> number` (milliseconds `>= 1000` until next `HH:mm:00` in `UTC+7`)
    - `computeLateFeeAccrual({ dueDateYmd, asOfDateYmd, totalAmount, paidAmount = 0, creditOffsetAmount = 0, principalAmount = null, grossAccruedLateFee = 0, graceDays = 5, lateFeePerDay = 100000, maxLateFeeCap = null }) -> { isOverdue: boolean, principalSettled: boolean, overdueDays: number, chargeableDays: number, expectedTotalLateFee: number, deltaFee: number, capped: boolean }`
    - `evaluateMeterReadingAnomaly({ previousReading, currentReading, recentConsumptions = [], thresholdRatio = 0.3 }) -> { valid: boolean, code?: string, consumption: number, baselineAvg: number | null, varianceRatio: number | null, diffPct: number | null, isAbnormal: boolean }`

- [ ] **Step 1: Write the failing unit tests in `api/test/billingEngineUnit.test.js`**

Cover 100% of branches required by `PRD 18.1`, `NFR-001`, `NFR-014`, and all 5 `Review Focus` cases using pure in-memory inputs (zero DB connections):
- `roundVND`, `calcProrata`, `calcUtility`:
  - `roundVND`: `0`, `499 -> 0`, `500 -> 1000`, `3225806.45 -> 3226000`, `-333333.33 -> -333000`, `NaN -> 0`.
  - `calcProrata`: `activeDays = 0 -> 0`; full month `30/30 -> monthlyPrice * quantity`; `15/29` of `10.000.000 ₫ -> 5.172.000 ₫`; same-day move-in & move-out (`activeDays = 1`, `daysInMonth = 30`, `monthlyPrice = 9000000`) -> `300000`.
  - `calcUtility`: `previousReading = 1000, currentReading = 1200, unitPrice = 3853 -> roundVND(200 * 3853) = 771000`; `currentReading < previousReading` throws `RangeError` with `'INVALID_READING'`.
- `todayVietnamYmd` & `currentVietnamPeriod`: `new Date('2026-10-31T17:05:00.000Z')` (`00:05` Nov 1 ICT) returns `'2026-11-01'` and `'2026-11'` (*Review Focus #1*).
- `computeContractRentPeriodCharge`:
  - Full month (`2026-11-01`..`2026-11-30`, `10.000.000 ₫`) -> `activeDays = 30`, `isProrated = false`, `amount = 10000000`.
  - Mid-month move-in on 31-day month (`start_date = '2026-05-16'`, `rent_amount = 31000000`) -> `activeDays = 16`, `daysInMonth = 31`, `amount = 16000000`.
  - Early move-out day 10 on 30-day month (`lastActiveDayYmd = '2026-04-10'`, `rent_amount = 30000000`) -> `activeDays = 10`, `amount = 10000000` (`AC-015.3`).
  - Same-day move-in & termination (`start_date = '2026-04-10'`, `lastActiveDayYmd = '2026-04-10'`, `rent_amount = 30000000`) -> `activeDays = 1`, `amount = 1000000`.
  - Leap-year Feb (`2028-02`, 29 days, move-in `2028-02-15`, `rent_amount = 10000000`) vs non-leap Feb (`2026-02`, 28 days, move-in `2026-02-15`, `rent_amount = 10000000`) -> `5172000` vs `5000000`.
  - Future contract (`start_date = '2026-12-01'`, `periodYm = '2026-11'`) -> `activeDays = 0`, `amount = 0`.
- `resolveServiceUnitPrice`, `computeSubscriptionPeriodCharge` & `resolveUtilityUnitPrice` (*Review Focus #2*):
  - Tier 1 `CONTRACT_OVERRIDE` beats `SUBSCRIPTION_LOCKED`, `BUILDING_CATALOG`, `METER_CONFIG`, and `DEFAULT_CATALOG`, respecting `effective_from <= periodEndYmd` and aliases (`ELEC` ↔ `ELECTRICITY`, `WIFI` ↔ `INTERNET_FIBER`, `DOMESTIC_WATER` ↔ `WATER`).
  - Tier 2 `SUBSCRIPTION_LOCKED` (`is_price_locked = true`) beats `BUILDING_CATALOG`.
  - Unlocked subscription (`is_price_locked = false`) picks active `BUILDING_CATALOG` (`building_id = 'bldg-a'`) over stale `subscription.unit_price` and `DEFAULT_CATALOG` (`building_id = null`), ignores `is_active: false` catalog rows, and falls back to `DEFAULT_CATALOG` for `'bldg-b'`.
  - `resolveUtilityUnitPrice`: `CONTRACT_OVERRIDE` (`4500`) -> `BUILDING_CATALOG` (`4100`) -> `METER_CONFIG` (`4000` when `meterUnitPrice > 0`) -> `DEFAULT_CATALOG` (`3800`).
- `resolveBillingDaysForDate` & `computeNextVietnamDailyRunMs` (*Review Focus #4*):
  - `'2026-02-28'` -> `[28, 29, 30, 31]`; `'2028-02-28'` -> `[28]`; `'2028-02-29'` -> `[29, 30, 31]`; `'2026-04-30'` -> `[30, 31]`; `'2026-05-31'` -> `[31]`; `'2026-05-15'` -> `[15]`.
  - `computeNextVietnamDailyRunMs(new Date('2026-11-03T17:00:00Z'), 0, 5)` (`00:00` ICT -> `00:05` ICT) === `5 * 60 * 1000`; at `00:10` ICT (`2026-11-03T17:10:00Z`) === `(23 * 60 + 55) * 60 * 1000`.
- `computeLateFeeAccrual` (*Review Focus #3*):
  - `overdueDays` in `0..5` (`asOfDateYmd` up to `dueDateYmd + 5`) -> `expectedTotalLateFee = 0`, `deltaFee = 0` (`isOverdue = false` at `0`, `true` at `1..5`).
  - `overdueDays = 6` -> `chargeableDays = 1`, `expectedTotalLateFee = 100000`, `deltaFee = 100000`.
  - `overdueDays = 10`, `graceDays = 5` -> `chargeableDays = 5`, `expectedTotalLateFee = 500000` (`PRD 18.1`).
  - Partial payment (`paidAmount = 3000000`, `principalAmount = 10000000`, `totalAmount = 10000000`, `overdueDays = 7`) -> `expectedTotalLateFee = 200000`; full payment (`paidAmount >= totalAmount`) -> `isOverdue = false`, `deltaFee = 0`.
  - Principal settled (`principalAmount = 10000000`, `grossAccruedLateFee = 200000`, `totalAmount = 10200000`, `paidAmount = 10000000`, `overdueDays = 12`) -> `principalSettled = true`, `deltaFee = 0` (never compounds penalty on unpaid penalty).
  - Waiver preservation: `grossAccruedLateFee = 300000` (with `-200000` adjustment reducing `totalAmount`), on `overdueDays = 9` (`expectedTotalLateFee = 400000`) -> `deltaFee = 100000`; on `overdueDays = 7` (`expectedTotalLateFee = 200000 < 300000`) -> `deltaFee = 0`.
  - Optional cap: `maxLateFeeCap = 500000`, `overdueDays = 20` -> `expectedTotalLateFee = 500000`, `capped = true`.
- `evaluateMeterReadingAnomaly` (*Review Focus #5*):
  - `currentReading < previousReading` -> `{ valid: false, code: 'INVALID_READING' }`.
  - Cold start `recentConsumptions = []` or `[0, 0]` -> `{ valid: true, baselineAvg: null, isAbnormal: false }`.
  - Vacant month mixed with active months `recentConsumptions = [0, 100, 110]`, `previousReading = 500`, `currentReading = 605` -> `baselineAvg = 105`, `varianceRatio = 0`, `isAbnormal = false`.
  - 3-period rolling average `[90, 100, 110]` (`baselineAvg = 100`): `current = +130` (`+30.0%` exact boundary) -> `isAbnormal = false`; `current = +131` (`+31.0% > 30%`) -> `isAbnormal = true`; drop `current = +69` (`-31.0%`) -> `isAbnormal = true`.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --test-concurrency=1 test/billingEngineUnit.test.js` (cwd: `d:\resihub\api`)
Expected: FAIL with missing exports (`calcProrata`, `calcUtility`, `resolveUtilityUnitPrice`, `resolveBillingDaysForDate`, `computeNextVietnamDailyRunMs`, `computeLateFeeAccrual`, `evaluateMeterReadingAnomaly`).

- [ ] **Step 3: Implement pure billing & cron helpers in `api/src/services/pricing.js` and `api/src/services/serviceBilling.js`**

- In `api/src/services/pricing.js`: add `calcProrata` and `calcUtility` built on `roundVND`.
- In `api/src/services/serviceBilling.js`:
  - Expand `CANONICAL_ALIAS_GROUPS` with `['ELECTRICITY', 'ELEC']`, `['WATER', 'DOMESTIC_WATER']`, and `'WIFI'` in the internet group.
  - Filter out inactive catalog rows (`item.is_active === false`) and null-guard `(effB || '').localeCompare(effA || '')` when sorting multiple `contract_service_price` overrides inside `resolveServiceUnitPrice` and `resolveUtilityUnitPrice`.
  - Implement `resolveUtilityUnitPrice`, `resolveBillingDaysForDate`, `computeNextVietnamDailyRunMs`, `computeLateFeeAccrual` (computing `overdueDays = asOfDateYmd > dueDateYmd ? diffDaysYmd(dueDateYmd, asOfDateYmd) - 1 : 0` since `diffDaysYmd` is inclusive, and freezing `deltaFee = 0` when `principalAmount !== null && principalAmount <= paidAmount + creditOffsetAmount`), and `evaluateMeterReadingAnomaly`.

- [ ] **Step 4: Run unit tests & verify `>= 80%` coverage (`NFR-014`)**

Run 1: `node --test --test-concurrency=1 test/billingEngineUnit.test.js test/serviceBillingAndSchedule.test.js test/invoiceSchedule.test.js` (cwd: `d:\resihub\api`)
Run 2: `node --test --experimental-test-coverage --test-concurrency=1 test/billingEngineUnit.test.js test/serviceBillingAndSchedule.test.js test/invoiceSchedule.test.js` (cwd: `d:\resihub\api`)
Expected: PASS (0 failures), and line coverage on `pricing.js` and `serviceBilling.js` `>= 80%`.

- [ ] **Step 5: Commit**

```bash
git add api/src/services/pricing.js api/src/services/serviceBilling.js api/test/billingEngineUnit.test.js
git commit -m "feat(billing): add pure 3-tier pricing, late fee, meter anomaly and cron helpers with unit tests"
```

---

### Task 2: Database Migration `049`, M08 RBAC/RLS Hardening (`PRD 6.2`) & Meter Confirmation + 3-Period Anomaly API

**Files:**
- Create: `api/src/db/migrations/049_m08_m09_billing_engine_and_cron_lock.sql`
- Modify: `api/src/routes/meters.js`
- Modify: `api/src/routes/deposits.js:250-288`
- Modify: `api/src/routes/settings.js`
- Test: `api/test/m08MeterLifecycleAndAnomaly.test.js`

**Interfaces:**
- Consumes: `evaluateMeterReadingAnomaly`, `currentVietnamPeriod` from Task 1 (`api/src/services/serviceBilling.js`).
- Produces:
  - DB columns on `meter_reading`: `status TEXT NOT NULL DEFAULT 'CONFIRMED' CHECK (status IN ('DRAFT', 'CONFIRMED', 'FLAGGED'))`, `confirmed_by UUID REFERENCES app_user(id) ON DELETE SET NULL`, `confirmed_at TIMESTAMPTZ`, `baseline_avg_consumption NUMERIC(12,2)`.
  - Hardened DB RLS & RPC in migration `049`:
    - `rls_meter_modify` & `rls_meter_reading_modify`: restrict `INSERT/UPDATE/DELETE` strictly to `is_manager() AND building_id IN (SELECT building_id FROM get_manager_building_ids())` (`SYS_ADMIN` and `OWNER` are Read-Only per `PRD 6.2`).
    - `rls_meter_reading_select`: `is_org_admin() OR building_id IN (SELECT building_id FROM get_user_assigned_buildings()) OR (status = 'CONFIRMED' AND apartment_id IN (SELECT c.apartment_id FROM contract c WHERE c.id IN (SELECT contract_id FROM get_resident_contract_ids())))` (hides `DRAFT`/`FLAGGED` readings from `RESIDENT`).
    - `fn_get_finance_resource_scope`, `can_select_attachment` & `rls_audit_log_select`: extend `fn_get_finance_resource_scope` with `'apartment'`, `'meter'`, and `'meter_reading'`; extend `can_select_attachment` so `is_resident()` can view attachments of `CONFIRMED` `meter_reading` rows on their apartment (`FR-032`); and extend `rls_audit_log_select` with `'meter'` and `'meter_reading'` scoped by `building_id` so `checkBuildingAccess` (`404` vs `403 ACCESS_DENIED` per `AC-019.1`) and `OWNER`/`MANAGER` audit queries work under `FORCE ROW LEVEL SECURITY` without `adminPool`.
  - DB table `cron_job_run`: `(id UUID PK, job_name TEXT NOT NULL, run_date DATE NOT NULL, status TEXT CHECK ('RUNNING','SUCCEEDED','FAILED'), attempt_count INT NOT NULL DEFAULT 1, duration_ms INT, summary JSONB, error_message TEXT, started_at TIMESTAMPTZ, finished_at TIMESTAMPTZ)` with `ENABLE` + `FORCE ROW LEVEL SECURITY` (`rls_cron_job_run_select` for `is_org_admin()`).
  - `system_setting('billing_config')` merged defaults: `due_date_offset_days: 5`, `late_fee_grace_days: 5`, `late_fee_per_day: 100000`, `late_fee_cap: null`, `meter_anomaly_threshold_pct: 30` (merged via `jsonb` concatenation without overwriting existing org values).
  - HTTP endpoints in `api/src/routes/meters.js` (all write routes guarded by `requireRole(['MANAGER'])` + `idempotencyGuard()` and executing via `pool` / `getUserClient(req)` using `req.user.sub` as actor UUID):
    - `GET /api/v1/meters` & `GET /api/v1/meters/readings`: include `period_reading_status`, `period_confirmed_at`, `baseline_avg_consumption` (and optional `?status=DRAFT|CONFIRMED|FLAGGED` filter).
    - `POST /api/v1/meters/:id/readings` & `POST /api/v1/meters/readings/batch`: evaluate anomaly against up to 3 prior `CONFIRMED` periods (`consumption > 0`). Status resolution: if `status === 'DRAFT'`, save `'FLAGGED'` when `isAbnormal` else `'DRAFT'` (`confirmed_by = null`, `confirmed_at = null`); if `hold_if_abnormal === true` and `isAbnormal` and `!abnormal_note?.trim()`, save `'FLAGGED'`; otherwise (when `status` is omitted or `'CONFIRMED'`) save `'CONFIRMED'` (`confirmed_by = req.user.sub`, `confirmed_at = NOW()`).
    - `POST /api/v1/meters/readings/confirm-batch`: `{ period, building_id?, reading_ids? }` confirms eligible `DRAFT`/`FLAGGED` readings in transaction, returning `{ confirmed_count, skipped_abnormal_without_note }`.
    - `POST /api/v1/meters/readings/:readingId/confirm`: transitions `DRAFT` or `FLAGGED` reading to `CONFIRMED` (`confirmed_by = req.user.sub`, `confirmed_at = NOW()`), requiring non-empty `abnormal_note` (existing or in body) when `is_abnormal = true` (`422 ABNORMAL_NOTE_REQUIRED`).

- [ ] **Step 1: Write migration `049_m08_m09_billing_engine_and_cron_lock.sql` and failing integration test `api/test/m08MeterLifecycleAndAnomaly.test.js`**

Test cases in `api/test/m08MeterLifecycleAndAnomaly.test.js` (isolated temp apartment & meter with full `t.after` cleanup):
1. **3-period rolling baseline (`FR-031`):** Recording 3 `CONFIRMED` periods (`100`, `110`, `90` kWh -> mean `100` kWh), then recording period 4 with `125` kWh (`+25%` vs 3-period mean `100`, though `+38.9%` vs period 3's `90`) -> `is_abnormal = false`.
2. **`DRAFT`/`FLAGGED` lifecycle & resident RLS isolation (*Review Focus #5*):** Recording period 5 with `status: 'DRAFT'` and `current_reading` spiking `+50%` -> saved with `status = 'FLAGGED'`, `is_abnormal = true`, `confirmed_by = null`, `baseline_avg_consumption = 108.33`; querying `meter_reading` under `RESIDENT` RLS context sees `0` rows for period 5 until confirmed.
3. **Abnormal note enforcement (`PRD 13.2`):** `POST /api/v1/meters/readings/:readingId/confirm` without `abnormal_note` -> `422 ABNORMAL_NOTE_REQUIRED`; with `{ abnormal_note: 'Khách lắp thêm máy lạnh' }` -> `200`, `status = 'CONFIRMED'`, `confirmed_by === mgr.user.sub`, `CONFIRM_METER_READING` visible in `audit_log` to building `OWNER` and `MANAGER`.
4. **Batch confirm & M06 deposit precondition sync:** `POST /api/v1/meters/readings/confirm-batch` confirms normal `DRAFT` readings and skips abnormal ones without notes; an unconfirmed (`DRAFT`/`FLAGGED`) final-period reading still blocks `POST /api/v1/deposits/:id/settlement` with `409 MISSING_FINAL_METER_READING` until confirmed.
5. **RBAC `SYS_ADMIN` Read-Only (`PRD 6.2`) & Cross-Building `403` (`AC-019.1`):** `SYS_ADMIN` can `GET /api/v1/meters/readings` (`200`), but `POST /api/v1/meters` and `POST /api/v1/meters/:id/readings` with `SYS_ADMIN` token return `403`; a `MANAGER` of another building attempting `POST /api/v1/meters/:id/readings` or `/confirm` receives `403 ACCESS_DENIED` (not `404`).
6. **Settings persistence:** `PUT /api/v1/settings` & `GET /api/v1/settings` persist and return `due_date_offset_days`, `late_fee_grace_days`, `late_fee_per_day`, `late_fee_cap`, `meter_anomaly_threshold_pct`, and `billing_day = 31`.

- [ ] **Step 2: Apply migration `049` and run the new test to verify route assertions fail before route implementation**

Run: `npm run db:migrate` then `node --test --test-concurrency=1 test/m08MeterLifecycleAndAnomaly.test.js` (cwd: `d:\resihub\api`)
Expected: Migration `049` applies cleanly; test FAILS on 3-period anomaly, `SYS_ADMIN` `403`, & `/confirm` endpoints (`404`).

- [ ] **Step 3: Implement M08 updates in `api/src/routes/meters.js`, `api/src/routes/deposits.js`, and `api/src/routes/settings.js`**

- In `api/src/routes/meters.js`:
  - Replace UTC `getCurrentPeriod()` with `currentVietnamPeriod()` from `serviceBilling.js`.
  - Restrict all write routes (`POST /`, `POST /readings/batch`, `POST /:id/readings`, `POST /readings/confirm-batch`, `POST /readings/:readingId/confirm`) to `requireRole(['MANAGER'])` + `idempotencyGuard()`, resolve resource `building_id` via `fn_get_finance_resource_scope('apartment' | 'meter' | 'meter_reading', id)` on `pool` / `getUserClient(req)` before `checkBuildingAccess` (removing `adminPool`), and record `req.user.sub` for `recorded_by`, `confirmed_by`, and `audit_log.actor_id`.
  - Load `meter_anomaly_threshold_pct` from `system_setting('billing_config')` (default `30` -> `thresholdRatio = 0.3`), query up to 3 prior `CONFIRMED` readings (`consumption > 0`), call `evaluateMeterReadingAnomaly`, and persist `status`, `confirmed_by`, `confirmed_at`, `baseline_avg_consumption`.
  - Implement `POST /readings/confirm-batch` (registered BEFORE `/readings/:readingId/confirm`) and `POST /readings/:readingId/confirm` with `CONFIRM_METER_READING` audit log.
- In `api/src/routes/deposits.js` (`lines 253-284`): add `AND m.status = 'ACTIVE'` and `AND mr.status = 'CONFIRMED'` to `missingMeterTypes` and `unbilledMeterTypes` queries so M06 settlement aligns with M08 confirmation.
- In `api/src/routes/settings.js`: normalize and preserve `billing_day` (`1..31`), `due_date_offset_days`, `late_fee_grace_days`, `late_fee_per_day`, `late_fee_cap`, and `meter_anomaly_threshold_pct` on `PUT /api/v1/settings`.

- [ ] **Step 4: Run M08 + existing meter & deposit regression tests**

Run: `node --test --test-concurrency=1 test/m08MeterLifecycleAndAnomaly.test.js test/remediationR01ToR24.test.js test/m06PostReviewFixes.test.js test/sprint1And2Rebuild.test.js` (cwd: `d:\resihub\api`)
Expected: PASS (0 failures).

- [ ] **Step 5: Commit**

```bash
git add api/src/db/migrations/049_m08_m09_billing_engine_and_cron_lock.sql api/src/routes/meters.js api/src/routes/deposits.js api/src/routes/settings.js api/test/m08MeterLifecycleAndAnomaly.test.js
git commit -m "feat(m08): add meter confirmation lifecycle, 3-period anomaly, M08 RLS hardening and migration 049"
```

---

### Task 3: M09 Invoice Generation Engine — 3-Tier Catalog Fallback (`FR-065`), `AC-015.1` Confirmed Meter Gate & Vietnam Timezone

**Files:**
- Modify: `api/src/routes/invoices.js`
- Modify: `api/src/routes/contracts.js`
- Modify: `api/src/routes/services.js`
- Modify: `api/src/routes/resident.js`
- Test: `api/test/m09InvoicePricingAndMeterGate.test.js`

**Interfaces:**
- Consumes: `resolveUtilityUnitPrice`, `computeSubscriptionPeriodCharge`, `todayVietnamYmd`, `currentVietnamPeriod`, `addDaysYmd`, `getMonthBoundsYmd` from `api/src/services/serviceBilling.js`.
- Produces:
  - `generateInvoicesCore(client, { orgId, targetPeriod, buildingId, contractId, matchBillingDays, onlyOngoingContracts, excludeSettledDeposits, autoIssue, issueDateYmd, dueDate, actorId, applyScope, allowMissingMeterReadings = false }) -> Promise<{ createdInvoices, skippedContracts, skippedFutureCount, updatedDraftCount }>`
  - `skippedContracts` entries include `reason_code: 'MISSING_CONFIRMED_METER_READING' | 'ZERO_BILLABLE_AMOUNT'` and `missing_meter_types?: string[]`.
  - Utility `invoice_line.formula_meta`: `{ meter_id, reading_id, previous_reading, current_reading, consumption, price_source }`.

- [ ] **Step 1: Write the failing integration test `api/test/m09InvoicePricingAndMeterGate.test.js`**

Test cases (isolated temp contracts/apartments with full cleanup):
1. **3-Tier Subscription & Utility Pricing (`FR-065`, *Review Focus #2*):**
   - Org default `PARKING_MOTO` = `150.000 ₫`, Building `B1` override `PARKING_MOTO` = `200.000 ₫` in `service_catalog`.
   - Contract `C1` in `B1` has unlocked subscription (`is_price_locked = false`, initial `unit_price = 150000`) -> both `GET /api/v1/contracts/:id` `invoice_schedule` and `POST /api/v1/invoices/generate-batch` bill `200.000 ₫` (`price_source = 'BUILDING_CATALOG'`).
   - Adding `contract_service_price` override (`PARKING_MOTO = 120.000 ₫`, `effective_from <= periodEnd`) and refreshing `DRAFT` invoice -> bills `120.000 ₫` (`price_source = 'CONTRACT_OVERRIDE'`).
   - Electricity meter on `B1` with building-level `service_catalog` `ELECTRICITY = 4.100 ₫` vs contract override `ELEC = 4.500 ₫` -> resolves `4.100 ₫` before override and `4.500 ₫` after override, and `invoice_line.formula_meta` exposes `{ previous_reading, current_reading, consumption, price_source }` (`AC-003.1`).
2. **`AC-015.1` Missing / Unconfirmed Active Meter Gate:**
   - Apartment `A_METER` has an `ACTIVE` electricity meter (created before period end):
     - Case 2a: No reading in `period` -> `POST /api/v1/invoices/generate-batch` skips `C_METER` with `reason_code === 'MISSING_CONFIRMED_METER_READING'` and `missing_meter_types: ['ELECTRICITY']` while still generating `DRAFT` invoices for sibling contracts whose readings ARE `CONFIRMED`.
     - Case 2b: Reading exists in `period` with `status = 'DRAFT'` or `status = 'FLAGGED'` -> still skipped with `MISSING_CONFIRMED_METER_READING` and zero meter lines billed.
     - Case 2c: Confirming the reading via `POST /api/v1/meters/readings/:id/confirm` and re-running `generate-batch` -> generates the `DRAFT` invoice (`status = 'DRAFT'`) with both `RENT` and `ELECTRICITY` lines; resident `GET /api/v1/resident/invoices` still sees `0` drafts (`AC-003.2`).
3. **Vietnam Timezone Subscription Pro-Rata (`services.js` & `resident.js`) & Idempotency (`AC-015.2`):**
   - Resident `POST /api/v1/resident/services` and Manager `POST /api/v1/service-subscriptions` mid-month compute `prorata_amount` identically to `computeSubscriptionPeriodCharge`.
   - Re-running `POST /api/v1/invoices/generate-batch` for the building + period creates `0` duplicate invoices.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --test-concurrency=1 test/m09InvoicePricingAndMeterGate.test.js` (cwd: `d:\resihub\api`)
Expected: FAIL (`BUILDING_CATALOG` not applied in `generateInvoicesCore` / `contracts.js`, `formula_meta` missing reading bounds, and unconfirmed/missing active meters not gated).

- [ ] **Step 3: Implement M09 updates in `invoices.js`, `contracts.js`, `services.js`, and `resident.js`**

- In `api/src/routes/invoices.js`:
  - Replace all UTC `toISOString().slice(...)` calls — including `issueDraftInvoiceInTx` (`line 49`), `getCurrentPeriod()`, and `generateInvoicesCore` — with `currentVietnamPeriod()`, `todayVietnamYmd()`, and `addDaysYmd(effectiveIssueDateYmd, dueOffsetDays)` (reading `due_date_offset_days ?? payment_due_days` from `billing_config` / contract and allowing `issueDateYmd` override from `runDailyJobs`).
  - Query active `service_catalog` items once per `generateInvoicesCore` call (`SELECT id, building_id, code, category, unit_price, is_active FROM service_catalog WHERE org_id = $1 AND is_active = TRUE`).
  - Before building lines for contract `c`, compute `effectivePeriodEndYmd` (`min(monthEnd, lastActiveDayYmd)` when terminated/expired in period, else `monthEnd`). Query `ACTIVE` meters on `c.apartment_id` where `(m.created_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date <= $effectivePeriodEndYmd::date`: if any such meter lacks a `CONFIRMED` `meter_reading` in `targetPeriod` AND has not already been billed on another non-`VOID` invoice for `(c.apartment_id, targetPeriod, m.meter_type)` (and `!allowMissingMeterReadings`), push to `skippedContracts` (`reason_code: 'MISSING_CONFIRMED_METER_READING'`, `missing_meter_types`) and `continue`.
  - Select `service_code, unit_price, effective_from` from `contract_service_price` (`WHERE contract_id = $1 AND effective_from <= $effectivePeriodEndYmd::date`) so multi-row `effective_from` sorting in `resolveServiceUnitPrice` / `resolveUtilityUnitPrice` works accurately on mid-month terminations.
  - Filter `mrRes` query (`SELECT mr.id, mr.meter_id, mr.consumption, mr.previous_reading, mr.current_reading, m.meter_type, m.unit, m.unit_price ... AND mr.status = 'CONFIRMED'`), compute utility price via `resolveUtilityUnitPrice`, populate `formula_meta` with `{ meter_id: mr.meter_id, reading_id: mr.id, previous_reading: Number(mr.previous_reading), current_reading: Number(mr.current_reading), consumption: Number(consumption), price_source }`, and include `reason_code: 'ZERO_BILLABLE_AMOUNT'` when `grossSubtotal <= 0`.
  - Pass `catalogItems` and `boundEndYmd: effectivePeriodEndYmd` into `computeSubscriptionPeriodCharge`, and forward `allowMissingMeterReadings: Boolean(req.body?.allow_missing_meter_readings)` from `POST /generate-batch`.
- In `api/src/routes/contracts.js`: query `service_catalog` (`WHERE org_id = $1 AND is_active = TRUE`) inside `loadContractSubscriptionsAndSchedule` and pass `catalogItems` to `buildExpectedInvoiceSchedule`.
- In `api/src/routes/services.js` AND `api/src/routes/resident.js` (`lines 22-30` & `1403`): delete both duplicate legacy local-timezone `computeProrata` helpers and compute `prorata_amount` via `computeSubscriptionPeriodCharge` + `todayVietnamYmd()` + `catalogItems`.

- [ ] **Step 4: Run M09 + existing invoice/contract regression tests**

Run: `node --test --test-concurrency=1 test/m09InvoicePricingAndMeterGate.test.js test/invoiceFourEyesAndCreditBalance.test.js test/contractEarlyTerminationBillingSync.test.js test/multiBuildingAndFutureContract.test.js` (cwd: `d:\resihub\api`)
Expected: PASS (0 failures).

- [ ] **Step 5: Commit**

```bash
git add api/src/routes/invoices.js api/src/routes/contracts.js api/src/routes/services.js api/src/routes/resident.js api/test/m09InvoicePricingAndMeterGate.test.js
git commit -m "feat(m09): wire 3-tier catalog pricing, AC-015.1 confirmed-meter gate and Vietnam dates"
```

---

### Task 4: Daily Cron Scheduler (`FR-066`), Advisory Lock + 3-Attempt Retry (`PRD 14.5`) & Row-Locked Late Fee Accrual (`FR-064`)

**Files:**
- Modify: `api/src/jobs/daily.js`
- Test: `api/test/week5DailyCronAndLateFee.test.js`

**Interfaces:**
- Consumes: `resolveBillingDaysForDate`, `computeNextVietnamDailyRunMs`, `computeLateFeeAccrual`, `todayVietnamYmd` from Task 1 (`api/src/services/serviceBilling.js`); `generateInvoicesCore` from Task 3 (`api/src/routes/invoices.js`); `cron_job_run` table from Task 2.
- Produces (exported from `api/src/jobs/daily.js`):
  - `DAILY_JOB_ADVISORY_LOCK_KEY = 73918205`
  - `runDailyJobs(options?: { asOfDate?: string, buildingId?: string, maxRetries?: number, retryDelaysMs?: number[], stepHookForTest?: (attempt: number) => void }) -> Promise<{ skipped: boolean, reason?: string, runDate: string, attempts?: number, autoCreatedInvoices?: number, skippedMeterContracts?: number, overdueMarked?: number, lateFeeUpdated?: number }>`
  - `startDailyJobs(options?: { targetHour?: number, targetMinute?: number, runCatchUpOnBoot?: boolean }) -> { stop: () => void }` (matching `import { startDailyJobs } from './jobs/daily.js'` in `api/src/server.js:27`)

- [ ] **Step 1: Write the failing integration test `api/test/week5DailyCronAndLateFee.test.js`**

Create an isolated temporary building (`testBuildingId`) with full `t.after` cleanup (including `cron_job_run` and `notification` rows) so `{ asOfDate, buildingId: testBuildingId }` never mutates seeded contracts/invoices, and test:
1. **Short-month & leap-year `billing_day` cron generation (`FR-066`, *Review Focus #4*):**
   - Create contracts in `testBuildingId` with `billing_day = 15` and `billing_day = 31` on clean apartments.
   - `await runDailyJobs({ asOfDate: '2028-02-28', buildingId: testBuildingId })` (leap year Feb 28) -> generates `0` invoices for both.
   - `await runDailyJobs({ asOfDate: '2028-02-29', buildingId: testBuildingId })` (leap year Feb 29) -> generates `DRAFT` invoice (`status = 'DRAFT'`, `issue_date = '2028-02-29'`) ONLY for `billing_day = 31`, NOT for `billing_day = 15`.
   - Re-running `await runDailyJobs({ asOfDate: '2028-02-29', buildingId: testBuildingId })` -> idempotent (`0` new invoices), and `cron_job_run` records `SUCCEEDED` with `duration_ms >= 0`.
2. **`AC-015.1` Manager Notification on Cron Skip:**
   - Contract with `billing_day = 15` on apartment in `testBuildingId` with `ACTIVE` meter and no `2028-03` reading: `await runDailyJobs({ asOfDate: '2028-03-15', buildingId: testBuildingId })` skips invoice creation and inserts a `MISSING_METER_READING` notification for `testBuildingId`'s `MANAGER` once (re-running on `2028-03-15` does NOT duplicate the notification).
3. **PostgreSQL Advisory Lock & 3-Attempt Retry + `SYS_ADMIN` Alert (`PRD 14.5`):**
   - Hold `SELECT pg_advisory_lock(73918205)` on a separate `adminPool` client -> `await runDailyJobs({ asOfDate: '2028-03-15', buildingId: testBuildingId })` immediately returns `{ skipped: true, reason: 'LOCK_HELD' }`; unlock afterwards and verify `runDailyJobs` succeeds.
   - Inject transient failure via `stepHookForTest` that throws on attempts `1` and `2` then succeeds on attempt `3` (`retryDelaysMs: [5, 10, 20]`) -> resolves `SUCCEEDED` with `attempts === 3`.
   - Inject persistent failure across all `3` attempts (`maxRetries: 3`, `retryDelaysMs: [5, 10, 20]`) -> records `status = 'FAILED'` (`attempt_count = 3`) in `cron_job_run` and inserts a `CRON_JOB_FAILED` system alert notification for `SYS_ADMIN` before rejecting/returning error summary.
4. **Configurable Late Fee `100.000 ₫/day`, Waiver Preservation, Principal-Settled Stop & Cap (`FR-064`, *Review Focus #3*):**
   - `ISSUED` invoice in `testBuildingId` with `due_date = '2028-05-01'`, `subtotal = 10.000.000 ₫`:
     - `asOfDate = '2028-05-06'` (`overdueDays = 5`, within 5 grace days): status transitions to `OVERDUE`, `LATE_FEE` added = `0 ₫`, `total_amount = 10.000.000 ₫`.
     - `asOfDate = '2028-05-09'` (`overdueDays = 8` -> `3 * 100.000 = 300.000 ₫`): `LATE_FEE` line added = `300.000 ₫`, `total_amount = 10.300.000 ₫`, `receivable` synced.
     - Simulate approved `-200.000 ₫` `LATE_FEE` `ADJUSTMENT` waiver (`adjustment_amount = -200000`, `total_amount = 10.100.000 ₫`), then run `asOfDate = '2028-05-10'` (`overdueDays = 9` -> `expected = 400.000 ₫`, `grossAccrued = 300.000 ₫`) -> appends ONLY `deltaFee = 100.000 ₫` (`total_amount = 10.200.000 ₫`).
     - Set `billing_config.late_fee_cap = 500000`, run `asOfDate = '2028-05-25'` -> total accrued `LATE_FEE` caps at `500.000 ₫` (`deltaFee = 100.000 ₫`, `total_amount = 10.300.000 ₫`).
     - Simulate tenant paying `10.000.000 ₫` (`paid_amount = 10000000`, settling 100% of principal while `300.000 ₫` net late fee remains), clear cap (`late_fee_cap = null`), and run `asOfDate = '2028-05-30'` -> `deltaFee = 0` (`total_amount` stays `10.300.000 ₫`, no penalty-on-penalty). Restore `billing_config` in cleanup.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --test-concurrency=1 test/week5DailyCronAndLateFee.test.js` (cwd: `d:\resihub\api`)
Expected: FAIL (`runDailyJobs` ignores `{ asOfDate, buildingId }`, lacks `pg_try_advisory_lock` & 3-attempt retry, and lacks principal-settled/configurable late-fee logic).

- [ ] **Step 3: Implement advisory lock, 3-attempt retry, consistent `$effectiveDateYmd::date`, `cron_job_run` logging, manager skip notifications, row-locked late fees, and Vietnam scheduler in `api/src/jobs/daily.js`**

- Acquire a dedicated `lockClient = await adminPool.connect()` at the start of `runDailyJobs` and run `SELECT pg_try_advisory_lock($1) AS locked` with `DAILY_JOB_ADVISORY_LOCK_KEY = 73918205`. If `!locked`, release `lockClient` and return `{ skipped: true, reason: 'LOCK_HELD', runDate }`. Always run `SELECT pg_advisory_unlock($1)` + `lockClient.release()` in `finally`.
- Resolve `effectiveDateYmd = asOfDate || todayVietnamYmd()`. Replace hardcoded `CURRENT_DATE` and `NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh'` across **all** date-driven steps in `runDailyJobs` (Steps 2, 3a, 3b, 4, 5, 6, 7, 8, 9) with `$effectiveDateYmd::date`, and scope every step to `building_id = buildingId` whenever `buildingId` is passed.
- Wrap execution inside the held advisory lock in a retry loop (`maxRetries = 3`, default `retryDelaysMs = [1000, 2000, 4000]`): insert `cron_job_run` (`status = 'RUNNING'`), update `attempt_count`, `duration_ms`, `summary`, and `status = 'SUCCEEDED'` on completion; if all `maxRetries` attempts fail, update `cron_job_run` to `status = 'FAILED'` and insert a `CRON_JOB_FAILED` notification for active `SYS_ADMIN` users (`PRD 14.5`).
- In Step 5 (auto-billing): compute `matchDays = resolveBillingDaysForDate(effectiveDateYmd)` and `targetPeriod = effectiveDateYmd.slice(0, 7)`, pass `issueDateYmd: effectiveDateYmd` to `generateInvoicesCore`, and for any `skippedContracts` with `reason_code === 'MISSING_CONFIRMED_METER_READING'`, insert an idempotent `MISSING_METER_READING` notification to assigned building `MANAGER`s (`WHERE NOT EXISTS (...)`).
- In Step 6 (`OVERDUE`) & Step 7 (`LATE_FEE`): inside each `txClient` transaction, lock the invoice row (`SELECT ... FROM invoice WHERE id = $1 FOR UPDATE`), recompute `principalAmount` (sum of `invoice_line` excluding `LATE_FEE` and `ADJUSTMENT` lines targeting `'LATE_FEE'`) and `grossAccruedLateFee` (`SUM(amount) WHERE item_type = 'LATE_FEE' AND amount > 0`), load org `billing_config` (`late_fee_grace_days ?? 5`, `late_fee_per_day ?? 100000`, `late_fee_cap ?? null`), and apply `computeLateFeeAccrual`.
- Update `startDailyJobs` (imported by `api/src/server.js:27`): perform a boot catch-up check against `cron_job_run` (`job_name = 'DAILY_BILLING_SYNC' AND run_date = $today AND status = 'SUCCEEDED'`) and schedule next runs via recursive `setTimeout` + `computeNextVietnamDailyRunMs(new Date(), targetHour, targetMinute)` (`default 00:05` ICT) with `.unref?.()`.

- [ ] **Step 4: Run Cron + full daily-job regression tests**

Run: `node --test --test-concurrency=1 test/week5DailyCronAndLateFee.test.js test/m06Phase1P0Fixes.test.js test/m06Phase3P2Features.test.js test/m06ReservationApprovePayoutFlow.test.js test/residentTerminationFlow.test.js` (cwd: `d:\resihub\api`)
Expected: PASS (0 failures).

- [ ] **Step 5: Commit**

```bash
git add api/src/jobs/daily.js api/test/week5DailyCronAndLateFee.test.js
git commit -m "feat(cron): add advisory lock, 3x retry, Vietnam schedule, asOfDate injection and locked late fees"
```

---

### Task 5: Frontend M08 / M09 / Settings Alignment & Full End-to-End Regression Verification

**Files:**
- Modify: `frontend/src/utils/format.js`
- Modify: `frontend/src/utils/billing.js`
- Modify: `frontend/src/services/meters.service.js`
- Modify: `frontend/src/pages/admin/invoices/InvoicesPage.jsx`
- Modify: `frontend/src/pages/admin/meters/MeterReadingsPage.jsx`
- Modify: `frontend/src/pages/admin/settings/SettingsPage.jsx`
- Test: `api/test/frontendBillingHelpers.test.js`

**Interfaces:**
- Consumes: Backend endpoints from Tasks 2–4 (`POST /api/v1/meters/readings/:readingId/confirm`, `POST /api/v1/meters/readings/confirm-batch`, `POST /api/v1/invoices/generate-batch`, `GET/PUT /api/v1/settings`).
- Produces:
  - `getCurrentPeriod(now?: Date) -> string` (`'YYYY-MM'` in `Asia/Ho_Chi_Minh`) in `frontend/src/utils/format.js`.
  - `evaluateClientMeterAnomaly({ prevReading, currentReading, baselineAvg, thresholdPct = 30 })` & `summarizeSkippedContracts(skippedContracts)` in `frontend/src/utils/billing.js`.
  - `metersService.confirmReading(readingId, payload)` & `metersService.confirmBatch(payload)` in `frontend/src/services/meters.service.js`.

- [ ] **Step 1: Extend `api/test/frontendBillingHelpers.test.js` with failing UI helper tests**

Add assertions for:
- `getCurrentPeriod(new Date('2026-10-31T17:05:00.000Z')) === '2026-11'` (*Review Focus #1* Vietnam midnight window).
- `evaluateClientMeterAnomaly` (3-period `baselineAvg` comparison, `thresholdPct = 30`, negative consumption invalidation, cold-start `baselineAvg = null`).
- `summarizeSkippedContracts` formatting missing-meter apartment codes (`MISSING_CONFIRMED_METER_READING`) vs zero-billable contracts (`ZERO_BILLABLE_AMOUNT`).

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --test-concurrency=1 test/frontendBillingHelpers.test.js` (cwd: `d:\resihub\api`)
Expected: FAIL (`getCurrentPeriod` returns `'2026-10'` in UTC, and `evaluateClientMeterAnomaly` / `summarizeSkippedContracts` are not exported).

- [ ] **Step 3: Implement Frontend updates across `format.js`, `billing.js`, `meters.service.js`, `InvoicesPage.jsx`, `MeterReadingsPage.jsx`, and `SettingsPage.jsx`**

- `frontend/src/utils/format.js`: update `getCurrentPeriod(now = new Date())` (`lines 61-63`) to format `'YYYY-MM'` in `Asia/Ho_Chi_Minh` (`Intl.DateTimeFormat`) instead of `toISOString().slice(0, 7)`.
- `frontend/src/utils/billing.js`: export `evaluateClientMeterAnomaly` and `summarizeSkippedContracts`.
- `frontend/src/pages/admin/invoices/InvoicesPage.jsx`: change `autoIssue` initial state & modal reset (`lines 64, 123`) from `true` to `false` so batch generation defaults to `DRAFT` (`PRD 7.2`, `FR-033`, `FR-034`); surface `summarizeSkippedContracts(res.skipped_contracts)` in toast feedback when contracts are skipped (`AC-015.1`).
- `frontend/src/services/meters.service.js` & `frontend/src/pages/admin/meters/MeterReadingsPage.jsx`: add `confirmReading` and `confirmBatch`; compare against `row.baseline_avg_consumption ?? row.last_known_consumption`; render `DRAFT` / `FLAGGED` / `CONFIRMED` badges; gate all write/confirm buttons strictly to `MANAGER` role (hiding mutation controls for Read-Only `SYS_ADMIN` / `OWNER` per `PRD 6.2`); offer both "Lưu nháp" (`status: 'DRAFT'`) and "Lưu & Chốt chỉ số" (`status: 'CONFIRMED'`) plus a quick "Xác nhận chốt" action for `DRAFT`/`FLAGGED` rows.
- `frontend/src/pages/admin/settings/SettingsPage.jsx`: change `billing_day` upper bound (`lines 125, 353`) from `28` to `31` (`Math.min(31, ...)` with helper text for short-month clamping per `FR-066`), and add `due_date_offset_days`, `late_fee_grace_days` (default `5`), `late_fee_per_day` (default `100000`), `late_fee_cap` (optional `MoneyInput`, blank/`0` -> `null`), and `meter_anomaly_threshold_pct` (default `30`) to the `billing_config` card.

- [ ] **Step 4: Run Frontend helper tests, Billing coverage check, Vite production build, and the ENTIRE Backend test suite**

Run 1: `node --test --test-concurrency=1 test/frontendBillingHelpers.test.js` (cwd: `d:\resihub\api`)
Run 2: `node --test --experimental-test-coverage --test-concurrency=1 test/billingEngineUnit.test.js test/serviceBillingAndSchedule.test.js test/invoiceSchedule.test.js` (cwd: `d:\resihub\api`)
Run 3: `npm run build` (cwd: `d:\resihub\frontend`)
Run 4: `npm test` (cwd: `d:\resihub\api`)
Expected: All unit tests pass with `>= 80%` billing engine coverage (`NFR-014`), Vite production bundle builds cleanly, and 100% of backend integration suites (including `fullWebsiteWhiteBlackBox.test.js`) PASS with zero leaked DB rows.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/utils/format.js frontend/src/utils/billing.js frontend/src/services/meters.service.js frontend/src/pages/admin/invoices/InvoicesPage.jsx frontend/src/pages/admin/meters/MeterReadingsPage.jsx frontend/src/pages/admin/settings/SettingsPage.jsx api/test/frontendBillingHelpers.test.js
git commit -m "feat(ui): align M08 meter confirmation, M09 DRAFT-first batch billing, ICT period and late-fee settings"
```
