# Service Termination, Four-Eyes Invoice Adjustments & Credit Balance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver end-to-end PRD v2.0-compliant pre-start (`0 ₫`) and mid-term Pro-rata service cancellation (`TERMINATED`), early contract termination `RENT` + `SERVICE` invoice synchronization (`6A`), 3-scenario invoice lifecycle with Four-eyes post-`ISSUED` approvals (`ADJUSTED` / `VOID`), `credit_balance` ledger auto-offsetting, and deposit-separated move-out settlement across PostgreSQL RLS, Express API, and React UI.

**Architecture:** A PostgreSQL 16 migration standardizes status enums (`TERMINATED`, `ADJUSTED`, `VOID`), adds `invoice_adjustment` and `credit_balance` under strict `PRD 6.2` RLS (`MANAGER` `CRU`, `SYS_ADMIN` read-only + fallback approver, `OWNER` + 2nd `MANAGER` Four-eyes approval via narrow `SECURITY DEFINER` RPC `fn_resolve_invoice_adjustment`), and blocks `RESIDENT` access to `DRAFT` invoices. Two focused backend domain modules (`serviceBilling.js` for `Asia/Ho_Chi_Minh` Pro-rata & 3-tier `FR-065` pricing; `invoiceLifecycle.js` for 3-scenario `DRAFT` / 4-eyes sync and `credit_balance` FIFO ledger) power service, contract, invoice, payment, deposit-settlement, and KPI report routes, surfaced in Resident, Manager, and Owner portals.

**Tech Stack:** Node.js (ESM), Express 4, PostgreSQL 16 (`pg` with session-variable RLS via `getUserClient(req)`), `node:test`, React 19, Vite 8, Tailwind CSS, Zustand, Axios.

**Spec:** `docs/superpowers/specs/2026-11-02-service-cancellation-and-invoice-recalc-design.md`

## Global Constraints

- Physical status codes (`PRD Mục 13.2`): `service_subscription.status IN ('PENDING_APPROVAL', 'ACTIVE', 'CANCELLATION_PENDING', 'TERMINATED', 'REJECTED')`; `invoice.status IN ('DRAFT', 'ISSUED', 'PARTIALLY_PAID', 'PAID', 'OVERDUE', 'ADJUSTED', 'VOID')`; API routes normalize legacy input `'CANCELLED'` to `'TERMINATED'` (subscriptions) or `'VOID'` (invoices); do NOT rename `'CANCELLED'` on `contract`, `service_request`, `reservation`, or `announcement`.
- Timezone & rounding (`PRD Mục 10.3, 13.4`): all business `today` / period checks use `Asia/Ho_Chi_Minh` (`todayVietnamYmd()` in JS, `(NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date` in SQL); all VND charges round to nearest thousand via `roundVND` (`ROUND(x, -3)`); `end_date < start_date` (`start_date - 1 day`) represents `0` active days (`0 ₫`).
- Accounting & immutability invariants (`FR-034`, `FR-035`, `FR-068`, `Mục 13.3`, `NFR-016`): NEVER `UPDATE` or `DELETE` existing `invoice_line` rows once `invoice.status <> 'DRAFT'`; maintain `0 <= paid_amount <= total_amount` on `invoice` and `amount > 0` on `receivable` (`WRITTEN_OFF` when `0 ₫`); NEVER mix `credit_balance` refunds into `deposit_transaction` or deduct `RENT` debt from deposit principal.
- RBAC & RLS (`PRD Mục 6.1–6.2`, `NFR-008`, `AC-003.2`, `AC-019.1`): `MANAGER` has `CRU` on assigned buildings (`get_manager_building_ids()`); `SYS_ADMIN` is read-only (`R`) on services/invoices/payments/credits and only approves `invoice_adjustment` when `NOT building_has_active_owner(building_id)`; `OWNER` (`get_owner_building_ids()`) and 2nd `MANAGER` approve post-`ISSUED` adjustments ONLY through `fn_resolve_invoice_adjustment` (`SECURITY DEFINER`); `RESIDENT` never sees `DRAFT` invoices; business route queries MUST use `getUserClient(req)` (never `adminPool` RLS bypass) and financial `POST` endpoints MUST attach `idempotencyGuard()`.
- Workspace hygiene: NEVER stage, modify, or revert unrelated files on the branch (`api/test/depositRules.test.js`, `docs/BAO_CAO_RA_SOAT_THU_HOAN_COC_M06.md`, `docs/superpowers/plans/2026-11-02-m06-phase*.md`); coordinate migration numbering sequentially (`044_...sql` if `043` is latest when executed, or next sequential number if an M06 migration ran first).

## Review Focus

1. **Sequential post-`ISSUED` downward adjustments on an already-`PAID` invoice (e.g., `SERVICE` cancelled first, then contract terminated mid-month reducing `RENT` on the same invoice):** First approval clamps `invoice.paid_amount` to `nextTotal_1` and mints `credit_balance_1 = oldPaid - nextTotal_1`; second approval computes `excessPaid_2 = paid_amount_after_1 - nextTotal_2` so `credit_balance_1 + credit_balance_2 === originalPaid - nextTotal_2` with zero double-minting *(pinned in Task 1 & Task 6)*.
2. **Post-`ISSUED` negative adjustment exceeding net payable on an invoice that already consumed prior `credit_balance` (`credit_offset_amount > 0`):** `fn_resolve_invoice_adjustment` releases `LEAST(credit_offset_amount, ABS(rawTotal))` back to the source `credit_balance` rows (`AVAILABLE` / `PARTIALLY_APPLIED`), decrements `invoice.credit_offset_amount`, appends a balancing `ADJUSTMENT` line, and clamps `invoice.total_amount = 0` so resident credit is never destroyed and `total_amount >= 0` holds *(pinned in Task 1)*.
3. **Boundary dates on `31`-day months, leap-year February (`2028-02-29`), and `00:05–06:55` ICT (`17:05–23:55` UTC previous day):** `todayVietnamYmd` resolves the Vietnam calendar date (never UTC day-1), and `activeDays === daysInMonth` (`31/31` or `29/29`) charges exact `unitPrice * quantity` with `isProrated = false` and `delta = 0` *(pinned in Task 2)*.
4. **Repeated sync calls when a `PENDING_APPROVAL` adjustment already exists vs. resubmitting after `REJECTED`:** `currentlyAccounted` includes `PENDING_APPROVAL` `delta_amount` so re-running subscription/contract sync yields `delta = 0` instead of a `23505` unique-index error, whereas rejecting an adjustment releases the partial unique index so a corrected adjustment can be submitted *(pinned in Task 3 & Task 6)*.
5. **Move-out settlement when contract has `credit_balance` AND both `RENT` + `SERVICE` unpaid invoices + room damages exceeding `amount_held`:** Step 1 applies `credit_balance` to `SERVICE` debt, then `RENT` debt, then excess damages; Step 2 applies `deposit.amount_held` ONLY to damages and remaining `SERVICE` debt (never `RENT`, `FR-068`), converting uncovered `RENT` to `RECEIVABLE_AFTER_MOVE_OUT` while `SUM(deduct) + refund === heldBefore` in `deposit_transaction` *(pinned in Task 7)*.

---

## File Structure

- **Database Migration:**
  - Create: `api/src/db/migrations/044_service_termination_invoice_adjustments_and_credit_balance.sql` — schema changes, dynamic `pg_constraint` swaps, `invoice_adjustment`, `credit_balance`, `PRD 6.2` RLS policies, `rls_audit_log_select` expansion, and `fn_resolve_invoice_adjustment`.
  - Modify: `api/test/remediationR01ToR24.test.js:416-426` — update raw SQL fixture `'CANCELLED'` → `'TERMINATED'` to match new DB `CHECK`.
- **Backend Domain Services:**
  - Create: `api/src/services/serviceBilling.js` — `Asia/Ho_Chi_Minh` date helpers, status input normalizers, `FR-065` 3-tier price resolver, subscription & contract `RENT` Pro-rata calculators with `formula_meta`.
  - Modify: `api/src/services/invoiceSchedule.js:1-210` — preserve historical periods `1..N-1` for `TERMINATED` subscriptions and support 3-tier pricing + `'VOID'` / `'ADJUSTED'`.
  - Modify: `api/src/services/contractTemplate.js:81-90` — keep excluding `'TERMINATED'` / `'CANCELLED'` / `'REJECTED'` subscriptions cleanly.
  - Create: `api/src/services/invoiceLifecycle.js` — `credit_balance` FIFO apply/release/transfer helpers, `DRAFT` recalculation + empty-shell auto-`VOID` + `audit_log`, 3-scenario subscription sync, and `closeContractBillingAndSubscriptionsInTx` (`6A`).
- **Backend Routes & Jobs:**
  - Modify: `api/src/routes/services.js` — `MANAGER`-only writes (`PRD 6.2`), `getUserClient(req)`, `idempotencyGuard()`, 3-tier price lookup, pre-start `0 ₫` / mid-term `TERMINATED` + 3-scenario invoice sync + reject-cancel + `audit_log`.
  - Modify: `api/src/routes/resident.js` — pre-start `0 ₫` cancel, `PENDING_APPROVAL` withdraw, `PATCH /services/:id/withdraw-cancel`, strict `DRAFT` hiding (`AC-003.2`), `available_credit_balance` in `/overview`.
  - Modify: `api/src/routes/contracts.js` — wire `closeContractBillingAndSubscriptionsInTx` (`6A`) into all 6 contract-ending paths, transfer `credit_balance` on `transfer-room` / `renew`, hide `DRAFT` invoices from `RESIDENT` in `GET /contracts/:id`, expose `available_credit_balance`.
  - Modify: `api/src/jobs/daily.js` — `Asia/Ho_Chi_Minh` dates, wire `closeContractBillingAndSubscriptionsInTx` into Steps 1a & 1b, include `'ADJUSTED'` with `paid_amount < total_amount` in Steps 6 & 7.
  - Modify: `api/src/routes/invoices.js` — `MANAGER`-only writes, `DRAFT` line CRUD (`POST/PATCH/DELETE /:id/lines`), `POST /:id/issue`, `PATCH /:id/status` (`ALREADY_PAID` before `REQUIRES_FOUR_EYES_ADJUSTMENT`, `confirm_invoice_code`), `POST /:id/adjust`, `GET /adjustments`, `POST /:id/adjustments/:adjId/approve` & `/reject`, `GET /:id/audit-logs`, `credit_balance` FIFO auto-offset in `generateInvoicesCore`.
  - Modify: `api/src/routes/payments.js` — `MANAGER`-only admin writes, `idempotencyGuard()`, block `DRAFT`/`VOID`, clamp `paid_amount <= total_amount` and mint `credit_balance` on overpayment.
  - Modify: `api/src/routes/deposits.js` & `api/src/services/depositSettlement.js` — `no_pending_invoice_adjustments` precondition, `'ADJUSTED'` open-debt support, Step 1 `credit_balance` offset/refund separated from Step 2 `deposit_transaction` principal (`FR-068`, `RP-07`).
  - Modify: `api/src/routes/reports.js` & `api/src/routes/admin/audit-logs.js` — `getUserClient(req)`, `billed` (`total_amount + credit_offset_amount`), `collected` (*Tiền thực thu* from `payment` in `Asia/Ho_Chi_Minh`, `PRD 15.3`), `invoice_settled` (`PRD 15.1`), and `GET /api/v1/reports/financial-audit-logs` (`RP-08`).
- **Frontend:**
  - Modify: `frontend/src/constants/statuses.js`, `frontend/src/utils/billing.js` (create), `frontend/src/services/api.js`, `frontend/src/services/invoices.service.js`, `frontend/src/services/services.service.js`, `frontend/src/services/resident.service.js`, `frontend/src/services/reports.service.js`, `frontend/src/hooks/usePermission.js`.
  - Modify: `frontend/src/pages/resident/tabs/ServicesTab.jsx`, `frontend/src/pages/resident/tabs/InvoicesTab.jsx`, `frontend/src/pages/admin/services/SubscriptionsPage.jsx`, `frontend/src/pages/admin/services/ServiceCatalogPage.jsx`, `frontend/src/pages/admin/invoices/InvoicesPage.jsx`, `frontend/src/pages/admin/invoices/InvoiceDetailPage.jsx`, `frontend/src/pages/admin/contracts/ContractDetailPage.jsx`, `frontend/src/pages/admin/deposits/DepositsPage.jsx`, `frontend/src/pages/admin/reports/ReportsPage.jsx`.

---

### Task 1: Database Migration, `PRD 6.2` RLS & `fn_resolve_invoice_adjustment` RPC

**Files:**
- Create: `api/src/db/migrations/044_service_termination_invoice_adjustments_and_credit_balance.sql`
- Modify: `api/test/remediationR01ToR24.test.js:416-426`
- Test: `api/test/migration044RlsAndRpc.test.js`

**Interfaces:**
- Consumes: existing SQL helpers `is_org_admin()`, `is_owner()`, `is_manager()`, `is_resident()`, `get_current_user_id()`, `get_current_user_org_id()`, `get_user_assigned_buildings()`, `get_owner_building_ids()`, `get_manager_building_ids()`, `get_resident_contract_ids()`, `get_resident_tenant_ids()`, and `building_has_active_owner(p_building_id UUID)` (`041_contract_owner_price_approval_rls.sql`).
- Produces:
  - `service_catalog` partial unique indexes `idx_service_catalog_org_default_code` (`WHERE building_id IS NULL`) & `idx_service_catalog_building_code` (`WHERE building_id IS NOT NULL`).
  - `service_subscription.status` enum `'TERMINATED'` (replacing `'CANCELLED'`).
  - `invoice.status` enums `'ADJUSTED'`, `'VOID'` (replacing `'CANCELLED'`), `invoice.credit_offset_amount BIGINT NOT NULL DEFAULT 0`, `invoice_paid_lte_total_check`.
  - `invoice_line` columns `subscription_id UUID`, `credit_id UUID`, `adjustment_id UUID`, `formula_meta JSONB`.
  - Tables `invoice_adjustment` and `credit_balance` with `ENABLE` + `FORCE ROW LEVEL SECURITY` and partial unique indexes (`idx_invoice_adj_pending_sub`, `idx_invoice_adj_pending_rent`, `idx_invoice_adj_pending_void`, `idx_credit_balance_unique_adj`, `idx_credit_balance_unique_payment`, `idx_credit_balance_contract_avail`).
  - `fn_resolve_invoice_adjustment(p_adjustment_id UUID, p_decision TEXT, p_rejection_reason TEXT DEFAULT NULL, p_allow_self_approval BOOLEAN DEFAULT FALSE) RETURNS JSONB` (`SECURITY DEFINER SET search_path = public, pg_temp`).

- [ ] **Step 1: Write the failing schema, RLS & RPC integration test in `api/test/migration044RlsAndRpc.test.js`**

Write `node:test` suite connecting via `adminPool` (setup/teardown) and `appPool` (`resihub_app` with `set_config('app.current_user_id', ...)`) asserting:
1. `service_catalog` allows same `code` across `building_id IS NULL` and two distinct buildings, while rejecting duplicate `(org_id, code)` where `building_id IS NULL`.
2. `RESIDENT` `SELECT` on `invoice` returns `0` rows when `status = 'DRAFT'` (`AC-003.2`) and `1` row once `status = 'ISSUED'`.
3. `SYS_ADMIN` and `OWNER` direct `INSERT`/`UPDATE` on `service_catalog`, `service_subscription`, `invoice`, `invoice_line`, `payment`, `receivable` are blocked by RLS (`rowCount === 0` or `42501`), while `SELECT` succeeds in scope (`PRD 6.2`).
4. `fn_resolve_invoice_adjustment`:
   - Rejects self-approval (`created_by = actor_id` with `p_allow_self_approval = false`) with SQL error containing `'SELF_APPROVAL'`.
   - Allows `OWNER` of `VOP-A` (and 2nd `MANAGER` of `VOP-A`) to approve `ADJUST` on an already-`PAID` invoice (`total = 10_200_000`, `paid = 10_200_000`, `delta = -100_000`) -> appends `ADJUSTMENT` line without mutating existing lines, sets `invoice.status = 'ADJUSTED'`, `total_amount = 10_100_000`, `paid_amount = 10_100_000`, and inserts `credit_balance` (`amount = 100_000`, `reason_type = 'SERVICE_TERMINATION'`).
   - **Review Focus #1 pin:** Approving a second `ADJUST` (`adjustment_target = 'RENT'`, `delta = -5_000_000`) on that same `ADJUSTED` invoice (`total = 10_100_000`, `paid = 10_100_000`) clamps `total_amount = 5_100_000`, `paid_amount = 5_100_000`, and mints `credit_balance = 5_000_000` (NOT `5_100_000`), so total minted credit across both approvals equals `5_100_000`.
   - **Review Focus #2 pin:** Approving `ADJUST` (`delta = -400_000`) on an unpaid `ISSUED` invoice with `subtotal_amount = 500_000`, `credit_offset_amount = 300_000`, `total_amount = 200_000` releases `200_000` back to the source `credit_balance` (`applied_amount` drops from `300_000` to `100_000`, `status = 'PARTIALLY_APPLIED'`), sets `invoice.credit_offset_amount = 100_000`, `invoice.total_amount = 0`, marks open `receivable` as `'WRITTEN_OFF'`, and never violates `total_amount >= 0`.
   - Blocks `SYS_ADMIN` from calling `fn_resolve_invoice_adjustment` on `VOP-A` (which has an active `OWNER`), and allows `SYS_ADMIN` on a temporary building with `owner_id IS NULL`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && node --test --test-concurrency=1 test/migration044RlsAndRpc.test.js`
Expected: FAIL (`relation "invoice_adjustment" does not exist` / `function fn_resolve_invoice_adjustment does not exist`).

- [ ] **Step 3: Write `api/src/db/migrations/044_service_termination_invoice_adjustments_and_credit_balance.sql` and update raw SQL fixture in `api/test/remediationR01ToR24.test.js:423`**

Implement Spec Section `5.1` (items `1`–`7`) in `044_service_termination_invoice_adjustments_and_credit_balance.sql`:
- Include commented Rollback SQL header (`PRD 14.5`).
- Use `DO $$ DECLARE r RECORD; BEGIN ... END $$;` querying `pg_constraint` (`contype = 'u'` on `service_catalog` covering `(org_id, code)`; `contype = 'c'` referencing `status` on `service_subscription` and `invoice`) before migrating `'CANCELLED'` -> `'TERMINATED'` on `service_subscription`, clamping any legacy `paid_amount > total_amount` on `invoice`, migrating `'CANCELLED'` -> `'VOID'` on `invoice`, and adding the new `CHECK` constraints + partial unique indexes.
- Create `invoice_adjustment` and `credit_balance` with exact columns/constraints from Spec `5.1.5`–`5.1.6`, `GRANT ALL PRIVILEGES ... TO resihub_app`, `ENABLE` + `FORCE ROW LEVEL SECURITY`.
- Replace RLS policies on `service_catalog`, `service_subscription`, `invoice`, `invoice_line`, `payment`, `receivable`, `invoice_adjustment`, `credit_balance`, and `audit_log` (`rls_audit_log_select`) per Spec `5.1.7`.
- Implement `fn_resolve_invoice_adjustment(p_adjustment_id UUID, p_decision TEXT, p_rejection_reason TEXT DEFAULT NULL, p_allow_self_approval BOOLEAN DEFAULT FALSE) RETURNS JSONB` (`SECURITY DEFINER SET search_path = public, pg_temp`) enforcing caller scope (`OWNER` of building, `MANAGER` of building, or `SYS_ADMIN` when `NOT building_has_active_owner(building_id)`), 4-eyes check, `VOID` credit release + `WRITTEN_OFF` receivable, `ADJUST` append-only `invoice_line` + `LATE_FEE` neutralization when unpaid principal `<= 0` + excess `credit_offset_amount` release when `rawTotal < 0` + `excessPaid` `credit_balance` creation + `audit_log` `before`/`after`. Grant `EXECUTE` to `resihub_app`.
- In `api/test/remediationR01ToR24.test.js:423`, change `'CANCELLED'` to `'TERMINATED'` in the direct `INSERT INTO service_subscription` fixture.

- [ ] **Step 4: Run migration and verify tests pass**

Run: `cd api && npm run migrate && node --test --test-concurrency=1 test/migration044RlsAndRpc.test.js test/rbacPrdAlignment.test.js`
Expected: Migration `044` applies cleanly and both test suites PASS (`0` failures).

- [ ] **Step 5: Commit**

```bash
git add api/src/db/migrations/044_service_termination_invoice_adjustments_and_credit_balance.sql api/test/migration044RlsAndRpc.test.js api/test/remediationR01ToR24.test.js
git commit -m "feat(db): add 044 migration for TERMINATED/VOID/ADJUSTED, 4-eyes RPC, credit_balance, and PRD 6.2 RLS"
```

---

### Task 2: Shared `Asia/Ho_Chi_Minh` Pro-Rata & 3-Tier Pricing Engine (`serviceBilling.js` & `invoiceSchedule.js`)

**Files:**
- Create: `api/src/services/serviceBilling.js`
- Modify: `api/src/services/invoiceSchedule.js:1-210`
- Modify: `api/src/services/contractTemplate.js:81-90`
- Test: `api/test/serviceBillingAndSchedule.test.js`

**Interfaces:**
- Consumes: `roundVND` from `api/src/services/pricing.js`.
- Produces (exported from `api/src/services/serviceBilling.js`):
  - `todayVietnamYmd(now?: Date): string`
  - `currentVietnamPeriod(now?: Date): string`
  - `toDateOnlyYmd(val: unknown): string`
  - `addDaysYmd(ymd: string, deltaDays: number): string`
  - `diffDaysYmd(startYmd: string, endYmd: string): number`
  - `getMonthBoundsYmd(periodYm: string): { monthStart: string, monthEnd: string, daysInMonth: number }`
  - `normalizeSubscriptionStatusInput(status: unknown): string`
  - `normalizeInvoiceStatusInput(status: unknown): string`
  - `resolveServiceUnitPrice({ subscription, contractBuildingId, periodEndYmd, contractServicePrices, catalogItems }): { unitPrice: number, priceSource: 'CONTRACT_OVERRIDE' | 'SUBSCRIPTION_SNAPSHOT' | 'BUILDING_CATALOG' | 'DEFAULT_CATALOG' }`
  - `resolveSubscriptionEffectiveWindow(subscription, options?: { includePendingApproval?: boolean }): { billable: boolean, effectiveStart: string | null, effectiveEnd: string | null }`
  - `computeSubscriptionPeriodCharge({ subscription, periodYm, boundStartYmd, boundEndYmd, contractBuildingId, contractServicePrices, catalogItems, lockedUnitPrice, lockedQuantity }): { activeDays: number, daysInMonth: number, isProrated: boolean, unitPrice: number, quantity: number, priceSource: string, rawAmount: number, amount: number, overlapStart: string | null, overlapEnd: string | null, description: string, formulaMeta: object }`
  - `resolveContractLastActiveDay(contract, options?: { explicitEndYmd?: string | null, isNaturalExpiry?: boolean, todayYmd?: string }): { movedIn: boolean, lastActiveDayYmd: string }`
  - `computeContractRentPeriodCharge({ contract, periodYm, lastActiveDayYmd, lockedRentAmount }): { activeDays: number, daysInMonth: number, isProrated: boolean, unitPrice: number, rawAmount: number, amount: number, overlapStart: string | null, overlapEnd: string | null, description: string, formulaMeta: object }`

- [ ] **Step 1: Write the failing unit tests in `api/test/serviceBillingAndSchedule.test.js`**

Write pure unit tests covering:
1. Pre-start cancellation (`start_date = '2026-12-01'`, `end_date = '2026-11-30'`, `status = 'TERMINATED'`) -> `activeDays = 0`, `amount = 0` in `'2026-11'`, `'2026-12'`, and `'2027-01'`; `end_date = '2026-12-01'` -> `activeDays = 1` (`1/31` month).
2. Mid-month subscribe + same-month cancel (`start_date = '2026-11-10'`, `end_date = '2026-11-20'`, `unit_price = 300_000`, `qty = 1`) -> `activeDays = 11` (`11/30`), `amount = 110_000` (NOT `20/30 = 200_000`).
3. 5-month usage + mid-month-6 cancel (`start_date = '2026-01-01'`, `end_date = '2026-06-15'`, `status = 'TERMINATED'`, `unit_price = 200_000`, `qty = 2`) -> Months `'2026-01'`..`'2026-05'` each return `amount = 400_000` (`isProrated = false`), `'2026-06'` returns `15/30 * 400_000 = 200_000` (`isProrated = true`, `formulaMeta.active_days = 15`), `'2026-07'` returns `0`; `buildExpectedInvoiceSchedule` preserves all 5 first months at `rent + 400_000`.
4. `FR-065` 3-tier price priority: `CONTRACT_OVERRIDE` (`contract_service_price` with `effective_from <= periodEndYmd`, including `INTERNET_FIBER -> INTERNET` and `MANAGEMENT_FEE -> COMMON_SERVICE` aliases) > `SUBSCRIPTION_SNAPSHOT` > `BUILDING_CATALOG` > `DEFAULT_CATALOG`; `lockedUnitPrice` overrides all when recalculating an already-`ISSUED` period.
5. **Review Focus #3 pin:** `todayVietnamYmd(new Date('2026-11-01T18:30:00.000Z')) === '2026-11-02'` (`01:30` ICT next day); terminating on `'2028-02-29'` (leap year, `29/29` days) or `'2026-07-31'` (`31/31` days) produces `isProrated = false` and exact `unitPrice * quantity` with zero rounding drift.
6. `computeContractRentPeriodCharge` & `resolveContractLastActiveDay`: pre-move-in termination (`start_date = '2026-12-01'`, `explicitEndYmd = '2026-11-10'`, `todayYmd = '2026-11-10'`) -> `movedIn = false`, `amount = 0`; mid-month termination (`start_date = '2026-06-01'`, `explicitEndYmd = '2026-06-12'`, `rent_amount = 12_000_000`) -> `12/30 * 12_000_000 = 4_800_000`; natural half-open expiry (`start_date = '2026-01-01'`, `end_date = '2027-01-01'`, `isNaturalExpiry = true`) -> `lastActiveDayYmd = '2026-12-31'`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && node --test --test-concurrency=1 test/serviceBillingAndSchedule.test.js`
Expected: FAIL (`Cannot find module '../src/services/serviceBilling.js'`).

- [ ] **Step 3: Implement `api/src/services/serviceBilling.js` and update `api/src/services/invoiceSchedule.js` & `api/src/services/contractTemplate.js`**

- Create `api/src/services/serviceBilling.js` implementing all exported functions from **Interfaces** per Spec Section `5.2`.
- Refactor `api/src/services/invoiceSchedule.js` to delegate subscription window/pricing/pro-rata math to `serviceBilling.js` (`includePendingApproval: true`), exclude `existingInvoices` only when `status IN ('VOID', 'CANCELLED')`, and preserve `TERMINATED` subscriptions across historical months `[start_date .. end_date]`.
- In `api/src/services/contractTemplate.js:83-85`, keep `status === 'PENDING_APPROVAL' || status === 'ACTIVE'` (so `'TERMINATED'`, `'CANCELLED'`, and `'REJECTED'` are all excluded).

- [ ] **Step 4: Run unit tests (new + existing schedule/template suites)**

Run: `cd api && node --test --test-concurrency=1 test/serviceBillingAndSchedule.test.js test/invoiceSchedule.test.js test/contractTemplate.test.js`
Expected: PASS (`0` failures).

- [ ] **Step 5: Commit**

```bash
git add api/src/services/serviceBilling.js api/src/services/invoiceSchedule.js api/src/services/contractTemplate.js api/test/serviceBillingAndSchedule.test.js
git commit -m "feat(billing): add Vietnam-TZ pro-rata and FR-065 3-tier pricing engine preserving prior periods"
```

---

### Task 3: Invoice 3-Scenario Sync, Early Contract `6A` Sync & `credit_balance` Ledger (`invoiceLifecycle.js`)

**Files:**
- Create: `api/src/services/invoiceLifecycle.js`
- Test: `api/test/invoiceLifecycleSync.test.js`

**Interfaces:**
- Consumes: `serviceBilling.js` exports from Task 2; `roundVND` from `api/src/services/pricing.js`.
- Produces (exported from `api/src/services/invoiceLifecycle.js`):
  - `applyAvailableCreditsInTx(client, { contractId, invoiceId, subtotalAmount, actorId }): Promise<{ totalCreditUsed: number, appliedItems: Array<{ creditId: string, amount: number, lineId: string }> }>`
  - `releaseInvoiceCreditsInTx(client, { invoiceId, maxReleaseAmount?: number | null, actorId }): Promise<{ releasedAmount: number, remainingCreditOffset: number }>`
  - `recalculateDraftInvoiceTotalsInTx(client, { invoiceId, actorId, autoVoidIfZero?: boolean, voidReason?: string | null }): Promise<{ invoice: object, lines: object[], releasedCreditAmount: number, autoVoided: boolean }>`
  - `syncSubscriptionTerminationInvoicesInTx(client, { subscription, contract, actorId, reason }): Promise<{ scenario: 'UNBILLED' | 'DRAFT_UPDATED' | 'ADJUSTMENT_CREATED' | 'MIXED' | 'NO_CHANGE', updatedDraftInvoiceIds: string[], voidedDraftInvoiceIds: string[], createdAdjustments: object[] }>`
  - `closeContractBillingAndSubscriptionsInTx(client, { contract, explicitEndYmd?: string | null, isNaturalExpiry?: boolean, actorId, reason }): Promise<{ movedIn: boolean, lastActiveDayYmd: string, terminatedSubscriptionIds: string[], updatedDraftInvoiceIds: string[], voidedDraftInvoiceIds: string[], createdAdjustments: object[] }>`
  - `transferContractCreditsInTx(client, { fromContractId, toContractId, toBuildingId, actorId, reason }): Promise<{ transferredTotal: number, count: number }>`
  - `notifyBuildingInvoiceAdjustmentApprovers(clientOrPool, { orgId, buildingId, invoiceId, invoiceCode, adjustmentId, actionType, deltaAmount, actorId }): Promise<void>`

- [ ] **Step 1: Write the failing DB-backed service tests in `api/test/invoiceLifecycleSync.test.js`**

Write `node:test` integration tests running inside `appPool` transactions as `MANAGER` (`manager.vop.a@resihub.vn`) asserting:
1. **Scenario 1 (Unbilled):** `syncSubscriptionTerminationInvoicesInTx` when no invoice exists for the termination period returns `scenario = 'UNBILLED'` and touches zero invoices.
2. **Scenario 2 (`DRAFT` invoice):** Updating a `TERMINATED` subscription (`end_date = '2026-06-15'`) mutates ONLY the `'2026-06'` `DRAFT` `SERVICE` line to `15/30` Pro-rata (or deletes the line when `expectedAmount === 0`), leaves `'2026-01'`..`'2026-05'` `PAID` invoices untouched (`delta === 0`), releases excess `credit_balance` if `subtotal_amount < credit_offset_amount`, and writes an `UPDATE_DRAFT_INVOICE_LINES` `audit_log` with `before` and `after` snapshots (`AC-020.1`).
3. **Scenario 3 (Post-`ISSUED` invoice):** When `'2026-06'` invoice is `ISSUED` or `PAID`, `syncSubscriptionTerminationInvoicesInTx` leaves existing `invoice_line` rows 100% immutable and inserts a `PENDING_APPROVAL` row in `invoice_adjustment` (`adjustment_target = 'SERVICE'`, `action_type = 'ADJUST'`, `delta_amount < 0`) referencing the locked `unit_price` from `invoice_line` (`FR-065`).
4. **Option `6A` (`closeContractBillingAndSubscriptionsInTx`):**
   - Pre-move-in termination (`!movedIn`) sets open subscriptions to `'TERMINATED'` with `end_date = start_date - 1`, auto-`VOID`s unpaid `0 ₫` `DRAFT` invoices (`autoVoidIfZero: true`), creates a single `PENDING_APPROVAL` `VOID` `invoice_adjustment` for unpaid `ISSUED` invoices with `expectedTotal === 0`, and creates `SERVICE` + `RENT` `ADJUST` rows if `paid_amount > 0`.
   - Mid-month termination (`movedIn = true`, `explicitEndYmd = '2026-06-12'`) preserves Months `1..5` 100% and creates `PENDING_APPROVAL` `ADJUST` rows for BOTH `RENT` (`adjustment_target = 'RENT'`) and `SERVICE` (`adjustment_target = 'SERVICE'`) on an already-`ISSUED` Month `6` invoice.
5. **Review Focus #4 pin:** Calling `syncSubscriptionTerminationInvoicesInTx` or `closeContractBillingAndSubscriptionsInTx` a second time while the `PENDING_APPROVAL` adjustment is still pending computes `currentlyAccounted` including `PENDING_APPROVAL` `delta_amount` (`delta === 0`) and inserts zero duplicate rows (no `23505` crash).
6. `transferContractCreditsInTx` marks source `AVAILABLE`/`PARTIALLY_APPLIED` credits `'TRANSFERRED'` (`applied_amount = amount`) and creates matching `'AVAILABLE'` (`reason_type = 'TRANSFERRED_IN'`) credit on the destination contract.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && node --test --test-concurrency=1 test/invoiceLifecycleSync.test.js`
Expected: FAIL (`Cannot find module '../src/services/invoiceLifecycle.js'`).

- [ ] **Step 3: Implement `api/src/services/invoiceLifecycle.js`**

Implement all exported functions in `api/src/services/invoiceLifecycle.js` per Spec Sections `5.3.2`, `5.4`, and `5.5.2`:
- Lock target contract invoices (`status <> 'VOID'`) with `FOR UPDATE`.
- Compute `currentlyAccounted = originalLineSum + approvedAdjustmentSum + pendingAdjustmentSum` per subscription (`item_type = 'SERVICE'` / `subscription_id`) and for `RENT` (`item_type = 'RENT'` / `adjustment_target = 'RENT'`).
- On `DRAFT`: snapshot `before`, update/delete `SERVICE`/`RENT` lines, call `recalculateDraftInvoiceTotalsInTx` (releasing surplus `credit_balance` FIFO-reverse if `subtotal < credit_offset_amount`, and transitioning to `'VOID'` when `autoVoidIfZero && subtotal === 0 && paid_amount === 0`), write `audit_log`.
- On post-`ISSUED` (`ISSUED`, `PARTIALLY_PAID`, `PAID`, `OVERDUE`, `ADJUSTED`): never touch `invoice_line`; insert `invoice_adjustment` (`VOID` when `expectedTotal === 0 && paid_amount === 0` and no non-zero metered lines remain, else `ADJUST` per negative `delta`), write `CREATE_INVOICE_ADJUSTMENT` `audit_log`, and notify active `OWNER`s + other `MANAGER`s of `building_id` (or `SYS_ADMIN` when `NOT building_has_active_owner`).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd api && node --test --test-concurrency=1 test/invoiceLifecycleSync.test.js`
Expected: PASS (`0` failures).

- [ ] **Step 5: Commit**

```bash
git add api/src/services/invoiceLifecycle.js api/test/invoiceLifecycleSync.test.js
git commit -m "feat(invoices): implement 3-scenario invoice sync, 6A contract rent/service closure, and credit_balance helpers"
```

---

### Task 4: Service Catalog & Subscription Cancellation Routes (`services.js` & `resident.js`)

**Files:**
- Modify: `api/src/routes/services.js:1-605`
- Modify: `api/src/routes/resident.js:15-160, 720-1120`
- Test: `api/test/serviceCancellationFlow.test.js`

**Interfaces:**
- Consumes: `serviceBilling.js` (Task 2), `invoiceLifecycle.js` (Task 3), `idempotencyGuard()` from `api/src/middleware/idempotency.js`, `getUserClient(req)` from `api/src/db/client.js`.
- Produces:
  - `POST /api/v1/service-catalog`, `PATCH /api/v1/service-catalog/:id` — `requireRole(['MANAGER'])`, `idempotencyGuard()` on `POST`, building-scoped or default catalog (`PRD 6.2`).
  - `POST /api/v1/service-subscriptions`, `PATCH /api/v1/service-subscriptions/:id` — `requireRole(['MANAGER'])`, `idempotencyGuard()` on `POST`, 3-tier `FR-065` unit price resolution, `status: 'TERMINATED'` (accepting `'CANCELLED'` alias), `zero_usage?: boolean` option, reject-cancel (`CANCELLATION_PENDING -> ACTIVE`), `audit_log` `before`/`after`, returns `{ message, data, invoice_sync }`.
  - `PATCH /api/v1/resident/services/:id/cancel` — pre-`start_date` `0 ₫` (`end_date = start_date - 1`), `PENDING_APPROVAL -> TERMINATED` immediate withdraw, mid-term `ACTIVE -> CANCELLATION_PENDING` (`todayVietnamYmd() <= end_date <= contract.end_date`).
  - `PATCH /api/v1/resident/services/:id/withdraw-cancel` — `CANCELLATION_PENDING -> ACTIVE` (`end_date = NULL`, `prorata_amount = NULL`).
  - `GET /api/v1/resident/overview`, `GET /api/v1/resident/invoices`, `POST /api/v1/resident/payments/report` — exclude `DRAFT` and `VOID` appropriately (`AC-003.2`) and return `available_credit_balance` on `/overview`.

- [ ] **Step 1: Write the failing API integration tests in `api/test/serviceCancellationFlow.test.js`**

Write integration tests against the running API asserting:
1. `SYS_ADMIN` gets `403` when calling `POST /api/v1/service-catalog` or `PATCH /api/v1/service-subscriptions/:id` (`PRD 6.2`), while `GET` succeeds.
2. Resident & Manager pre-`start_date` cancellation (`start_date` in next month): Resident `PATCH /api/v1/resident/services/:id/cancel` with `{}` sets `status = 'CANCELLATION_PENDING'`, `end_date = start_date - 1`, `prorata_amount = 0`; Resident `PATCH /api/v1/resident/services/:id/withdraw-cancel` restores `'ACTIVE'`; Resident cancels again and Manager `PATCH /api/v1/service-subscriptions/:id` `{ status: 'TERMINATED' }` finalizes `prorata_amount = 0` and writes `audit_log`.
3. Mid-term cancellation across all 3 PRD invoice scenarios:
   - Scenario 1 (no invoice yet): `invoice_sync.scenario === 'UNBILLED'`.
   - Scenario 2 (`DRAFT` invoice exists): `DRAFT` line updates immediately to Pro-rata `roundVND` amount and `RESIDENT` cannot see the `DRAFT` invoice on `/resident/invoices`, `/resident/overview`, or `/resident/payments/report` (`404`/`409`).
   - Scenario 3 (`PAID` invoice exists after 5 `PAID` prior months): Months `1..5` remain untouched, Month `6` gets a `PENDING_APPROVAL` `invoice_adjustment`, and `PATCH` on an already-`TERMINATED` subscription returns `409 INVALID_STATUS`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && node --test --test-concurrency=1 test/serviceCancellationFlow.test.js`
Expected: FAIL (`SYS_ADMIN` allowed / pre-start cancel rejected with `422` / `withdraw-cancel` `404` / no `invoice_sync`).

- [ ] **Step 3: Update `api/src/routes/services.js` and `api/src/routes/resident.js`**

- In `api/src/routes/services.js`:
  - Restrict `POST /service-catalog`, `PATCH /service-catalog/:id`, `POST /service-subscriptions`, `PATCH /service-subscriptions/:id` to `requireRole(['MANAGER'])`; attach `idempotencyGuard()` to both `POST` routes; replace business `adminPool` queries with `getUserClient(req)` (keeping `logAccessDenied` neutral `403`/`404` checks).
  - Resolve unit price via `resolveServiceUnitPrice` (`FR-065`) on subscription creation.
  - In `PATCH /service-subscriptions/:id`: normalize `'CANCELLED'` -> `'TERMINATED'`; reject mutating already `'TERMINATED'` / `'REJECTED'` rows (`409 INVALID_STATUS`); support `zero_usage === true` or `todayVietnamYmd() < subStart` (`end_date = addDaysYmd(subStart, -1)`, `prorata_amount = 0`); support rejecting a cancel request (`CANCELLATION_PENDING -> ACTIVE`, `end_date = null`); when transitioning to `'TERMINATED'`, call `syncSubscriptionTerminationInvoicesInTx` inside the same transaction and write `audit_log` `before`/`after`.
- In `api/src/routes/resident.js`:
  - Replace UTC `computeProrata` / `new Date().toISOString().slice(0, 10)` with `serviceBilling.js` (`todayVietnamYmd`, `computeSubscriptionPeriodCharge`, `resolveServiceUnitPrice`).
  - Update `PATCH /services/:id/cancel` for `PENDING_APPROVAL -> TERMINATED` and `todayVietnamYmd() < subStart` (`0 ₫`); add `PATCH /services/:id/withdraw-cancel`.
  - Ensure `GET /overview`, `GET /invoices`, and `POST /payments/report` filter `status <> 'DRAFT'` and compute `current_amount_due` over `('ISSUED', 'ADJUSTED', 'PARTIALLY_PAID', 'OVERDUE')`, returning `available_credit_balance` (`SUM(amount - applied_amount)` of `AVAILABLE`/`PARTIALLY_APPLIED` `credit_balance` rows for the active contract) in `GET /overview`.

- [ ] **Step 4: Run new + existing service tests**

Run: `cd api && node --test --test-concurrency=1 test/serviceCancellationFlow.test.js test/parkingPlatesSync.test.js`
Expected: PASS (`0` failures — including `parkingPlatesSync.test.js` sending legacy `{ status: 'CANCELLED' }`).

- [ ] **Step 5: Commit**

```bash
git add api/src/routes/services.js api/src/routes/resident.js api/test/serviceCancellationFlow.test.js
git commit -m "feat(services): add pre-start 0 VND cancel, withdraw-cancel, TERMINATED 3-scenario sync, and PRD 6.2 RBAC"
```

---

### Task 5: Contract Early-Termination `6A` Sync, Credit Transfer & Daily Cron (`contracts.js` & `daily.js`)

**Files:**
- Modify: `api/src/routes/contracts.js:89-135, 870-948, 1166-1250, 2320-2585, 3341-3389, 4404-4798`
- Modify: `api/src/jobs/daily.js:1-360`
- Modify: `api/test/contractCreationFixes.test.js:626-631`
- Test: `api/test/contractEarlyTerminationBillingSync.test.js`

**Interfaces:**
- Consumes: `closeContractBillingAndSubscriptionsInTx`, `transferContractCreditsInTx` from `api/src/services/invoiceLifecycle.js` (Task 3); `todayVietnamYmd`, `addDaysYmd` from `api/src/services/serviceBilling.js` (Task 2).
- Produces:
  - Automatic `SERVICE` + `RENT` closure (`invoice_sync`) across all 6 contract-ending paths:
    1. `POST /api/v1/contracts/:id/cancel`
    2. `POST /api/v1/contracts/:id/terminate`
    3. `POST /api/v1/contracts/:id/terminate/approve`
    4. `POST /api/v1/contracts/requests/:id/approve` (`TERMINATED_NOW` branch)
    5. `POST /api/v1/contracts/:id/transfer-room` (plus `transferContractCreditsInTx` when `transfer_deposit !== false`)
    6. `runDailyJobs()` in `api/src/jobs/daily.js` (Step 1a `TERMINATION_PENDING -> TERMINATED` & Step 1b `ACTIVE`/`RENEWAL_PENDING -> EXPIRED`)
  - `GET /api/v1/contracts/:id` hides `DRAFT` invoices when `req.user` is `RESIDENT` (`AC-003.2`) and returns `available_credit_balance` + `pending_invoice_adjustments_count`.
  - `runDailyJobs()` Steps 5, 6, 7 use `Asia/Ho_Chi_Minh` dates and include `'ADJUSTED'` invoices only when `paid_amount < total_amount` (never marking fully settled `'ADJUSTED'` invoices `OVERDUE` or charging `LATE_FEE`).

- [ ] **Step 1: Write the failing integration tests in `api/test/contractEarlyTerminationBillingSync.test.js`**

Write integration tests asserting:
1. Pre-move-in `POST /api/v1/contracts/:id/terminate` on a future `ACTIVE` contract with an open subscription, one unpaid `DRAFT` invoice, and one unpaid `ISSUED` invoice -> subscription flips to `'TERMINATED'` (`end_date = start_date - 1`, `prorata_amount = 0`), the `DRAFT` invoice auto-transitions to `'VOID'`, and the `ISSUED` invoice receives a `PENDING_APPROVAL` `VOID` `invoice_adjustment`.
2. Mid-month `POST /api/v1/contracts/:id/terminate` (`terminated_date = '2028-06-12'`) after `'2028-05'` (`PAID`) and `'2028-06'` (`PAID` full month `RENT` + `SERVICE`) -> `'2028-05'` stays `100%` untouched; `'2028-06'` receives `PENDING_APPROVAL` `ADJUST` rows for BOTH `RENT` (`-18/30` month) and `SERVICE` (`-18/30` month).
3. `POST /api/v1/contracts/:id/transfer-room` with `transfer_deposit: true` closes old contract subscriptions/invoices via `6A` AND transfers available `credit_balance` from the old contract (`'TRANSFERRED'`) to the new contract (`'AVAILABLE'`, `reason_type = 'TRANSFERRED_IN'`).
4. `GET /api/v1/contracts/:id` called by `RESIDENT` omits `DRAFT` invoices from `invoice_schedule` / `existingInvoices` (`AC-003.2`).
5. `runDailyJobs()` does NOT flip an `'ADJUSTED'` invoice with `paid_amount === total_amount` to `'OVERDUE'`, while an `'ADJUSTED'` invoice past `due_date` with `paid_amount < total_amount` flips to `'OVERDUE'`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && node --test --test-concurrency=1 test/contractEarlyTerminationBillingSync.test.js`
Expected: FAIL (subscriptions remain `'ACTIVE'`, `DRAFT` not auto-voided, no `RENT`/`SERVICE` adjustments created).

- [ ] **Step 3: Wire `6A` & credit transfer in `api/src/routes/contracts.js`, update `api/src/jobs/daily.js`, and update `api/test/contractCreationFixes.test.js:630`**

- In `api/src/routes/contracts.js`:
  - Update `loadContractSubscriptionsAndSchedule(contract, { client, hideDraftInvoices = false })` to query via `client` (not `adminPool`), filter `status <> 'VOID'` (plus `AND status <> 'DRAFT'` when `hideDraftInvoices` is `true` for `RESIDENT`), pass `catalogItems` for 3-tier pricing, and return `available_credit_balance`.
  - Wire `closeContractBillingAndSubscriptionsInTx` inside the existing DB transaction of `cancel`, `terminate`, `terminate/approve`, `requests/:id/approve` (`TERMINATED_NOW`), and `transfer-room`; include `invoice_sync` in the JSON response.
  - On `transfer-room` (when `transfer_deposit` is truthy) and on `activate` of a `renew` child contract (`parent_contract_id` whose parent is `EXPIRED`/`TERMINATED` with `transfer_deposit`), call `transferContractCreditsInTx`.
  - Replace UTC date slicing (`new Date().toISOString().slice(0, 10)`) in termination/transfer paths with `todayVietnamYmd()`.
- In `api/src/jobs/daily.js`:
  - Replace UTC date helpers with `todayVietnamYmd()` / `(NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date`.
  - In Step 1a (`TERMINATION_PENDING -> TERMINATED`) and Step 1b (`ACTIVE`/`RENEWAL_PENDING -> EXPIRED`), call `closeContractBillingAndSubscriptionsInTx` (`isNaturalExpiry: true` on Step 1b).
  - In Steps 6 & 7, update status filter to `status IN ('ISSUED', 'PARTIALLY_PAID', 'ADJUSTED') AND paid_amount < total_amount`.
- In `api/test/contractCreationFixes.test.js:630`, update `assert.equal(cancelledSubs.rows[0]?.status, 'TERMINATED')`.

- [ ] **Step 4: Run new + existing contract test suites**

Run: `cd api && node --test --test-concurrency=1 test/contractEarlyTerminationBillingSync.test.js test/contractCreationFixes.test.js test/multiBuildingAndFutureContract.test.js`
Expected: PASS (`0` failures).

- [ ] **Step 5: Commit**

```bash
git add api/src/routes/contracts.js api/src/jobs/daily.js api/test/contractEarlyTerminationBillingSync.test.js api/test/contractCreationFixes.test.js
git commit -m "feat(contracts): sync RENT and SERVICE invoices across all 6 contract-ending paths and transfer credit_balance"
```

---

### Task 6: Invoices `DRAFT` Line CRUD, Four-Eyes Post-`ISSUED` Approvals, Audit Endpoint & Payments Commutativity (`invoices.js` & `payments.js`)

**Files:**
- Modify: `api/src/routes/invoices.js:1-698`
- Modify: `api/src/routes/payments.js:1-460`
- Test: `api/test/invoiceFourEyesAndCreditBalance.test.js`

**Interfaces:**
- Consumes: `fn_resolve_invoice_adjustment` (Task 1), `serviceBilling.js` (Task 2), `invoiceLifecycle.js` (Task 3), `checkFourEyesOrWarn` & `roundVND` from `api/src/services/pricing.js`, `idempotencyGuard()` from `api/src/middleware/idempotency.js`.
- Produces:
  - `POST /api/v1/invoices/generate-batch` (`MANAGER` + `idempotencyGuard()`): uses `serviceBilling.js` (`TERMINATED` overlap + `FR-065` 3-tier price + `formula_meta` + `subscription_id`) and `applyAvailableCreditsInTx` FIFO `credit_balance` offset (`FR-033`); if `auto_issue && total_amount === 0`, issues directly as `'PAID'` with zero `receivable`.
  - `POST /api/v1/invoices/:id/lines` (`MANAGER` + `idempotencyGuard()`), `PATCH /api/v1/invoices/:id/lines/:lineId` (`MANAGER`), `DELETE /api/v1/invoices/:id/lines/:lineId` (`MANAGER`) — `DRAFT` only (`409 IMMUTABLE_AFTER_ISSUED` otherwise), writes `audit_log` `before`/`after` (`AC-020.1`).
  - `POST /api/v1/invoices/:id/issue` (`MANAGER` + `idempotencyGuard()`) — issues `DRAFT` (`'PAID'` if `total_amount === 0`, else `'ISSUED'` + `receivable`).
  - `PATCH /api/v1/invoices/:id/status` (`MANAGER`): normalizes `'CANCELLED'` -> `'VOID'`; checks `if (targetStatus === 'VOID' && Number(inv.paid_amount) > 0) return 409 ALREADY_PAID` **before** checking `if (inv.status !== 'DRAFT') return 409 REQUIRES_FOUR_EYES_ADJUSTMENT`; on `DRAFT -> VOID`, enforces `confirm_invoice_code === inv.invoice_code` when `confirm_invoice_code !== undefined`, releases any applied `credit_balance`, and writes `audit_log`.
  - `POST /api/v1/invoices/:id/adjust` (`MANAGER` + `idempotencyGuard()`) — creates `PENDING_APPROVAL` `invoice_adjustment` (`action_type: 'ADJUST' | 'VOID'`, mandatory `reason`, `confirm_invoice_code === inv.invoice_code` required when `action_type === 'VOID'`, `409 ALREADY_PAID` if `VOID` and `paid_amount > 0`).
  - `GET /api/v1/invoices/adjustments` (`SYS_ADMIN`, `OWNER`, `MANAGER` scoped via RLS) & `adjustments` array + `has_building_owner` included in `GET /api/v1/invoices/:id` (blocking `RESIDENT` from `DRAFT` with `404`).
  - `POST /api/v1/invoices/:id/adjustments/:adjId/approve` & `POST /api/v1/invoices/:id/adjustments/:adjId/reject` (`OWNER`, `MANAGER`, `SYS_ADMIN` + `idempotencyGuard()`) — validates building scope + fallback `SYS_ADMIN` rule, runs `checkFourEyesOrWarn`, executes `SELECT fn_resolve_invoice_adjustment($1, $2, $3, $4)` under `getUserClient(req)`, sends resident notification `INVOICE_ADJUSTED` / `INVOICE_VOIDED`.
  - `GET /api/v1/invoices/:id/audit-logs` (`SYS_ADMIN`, `OWNER`, `MANAGER` scoped via RLS) — returns enriched chronological audit trail across `invoice`, `invoice_line`, `invoice_adjustment`, `payment`, and `credit_balance` linked to `:id`.
  - `POST /api/v1/payments`, `PATCH /api/v1/payments/:id/confirm`, `PATCH /api/v1/payments/:id/reject` (`MANAGER` only, `idempotencyGuard()` on `POST`) — blocks `DRAFT`/`VOID`, clamps `invoice.paid_amount <= total_amount`, and inserts `credit_balance` (`reason_type = 'OVERPAYMENT'`, `source_payment_id`) when `currentPaid + payAmount > total_amount`.

- [ ] **Step 1: Write the failing API integration tests in `api/test/invoiceFourEyesAndCreditBalance.test.js`**

Write integration tests asserting:
1. `DRAFT` line CRUD (`POST/PATCH/DELETE /invoices/:id/lines`) updates `subtotal_amount`/`total_amount` with `roundVND` and records `before`/`after` in `GET /api/v1/invoices/:id/audit-logs`; once `POST /invoices/:id/issue` is called, `PATCH/DELETE /lines` and post-`ISSUED` `PATCH /:id/status` return `409` (`IMMUTABLE_AFTER_ISSUED` / `ALREADY_PAID` / `REQUIRES_FOUR_EYES_ADJUSTMENT`).
2. Four-eyes matrix on `POST /invoices/:id/adjustments/:adjId/approve`:
   - Creator `mgrVopA` self-approving gets `403 SELF_APPROVAL`.
   - `SYS_ADMIN` approving on `VOP-A` (has active `OWNER`) gets `403`.
   - `OWNER` of `VOP` (`owner.vop@resihub.vn`) and 2nd `MANAGER` (`mgr2VopA`) can approve; `OWNER` attempting direct `POST /invoices/:id/adjust` or `PATCH /invoices/:id/status` gets `403`.
3. **Review Focus #1 & #4 + Commutativity pin:**
   - Order A (Resident pays `10_400_000` first -> `PAID`, then `SERVICE` adjustment `-200_000` approved -> `ADJUSTED` + `credit_balance = 200_000`, then `RENT` adjustment `-5_000_000` approved -> `credit_balance += 5_000_000`) produces identical `total_amount = 5_200_000`, `paid_amount = 5_200_000`, and total `credit_balance = 5_200_000` as Order B (adjustments approved while `ISSUED`, then `10_400_000` payment confirmed -> `OVERPAYMENT` `credit_balance = 5_200_000`).
   - Rejecting a `PENDING_APPROVAL` adjustment requires `reason`, sets `status = 'REJECTED'`, and allows `mgrVopA` to submit a new `POST /invoices/:id/adjust` without unique-index conflict.
4. Next-period `POST /invoices/generate-batch` with `Idempotency-Key`:
   - Replaying the exact same `Idempotency-Key` + payload replays `201` without duplicating invoices (`PRD 14.3`).
   - Automatically offsets available `credit_balance` FIFO (`credit_offset_amount > 0`, `ADJUSTMENT` line with `credit_id`), and when `credit_balance` covers `100%` of the new invoice (`total_amount === 0`), issuing marks it `'PAID'` with zero `receivable`.
   - Voiding an unpaid `DRAFT` invoice (`confirm_invoice_code: inv.invoice_code`) restores the consumed `credit_balance` back to `'AVAILABLE'`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && node --test --test-concurrency=1 test/invoiceFourEyesAndCreditBalance.test.js`
Expected: FAIL (`404` on `/lines`, `/adjust`, `/audit-logs`).

- [ ] **Step 3: Implement route updates in `api/src/routes/invoices.js` and `api/src/routes/payments.js`**

- Refactor `api/src/routes/invoices.js` per **Interfaces** and Spec Sections `5.4.1`–`5.4.3` & `5.5.2` (using `getUserClient(req)` instead of `adminPool` for business queries, `MANAGER`-only writes, `idempotencyGuard()` on `POST`s, `has_building_owner` via `getBuildingActiveOwnerUserIds` / `building_has_active_owner`, and `GET /:id/audit-logs`).
- Refactor `api/src/routes/payments.js` per **Interfaces** and Spec Section `5.5.1` (`requireRole(['MANAGER'])` on admin `POST /`, `PATCH /:id/confirm`, `PATCH /:id/reject`; `idempotencyGuard()` on `POST /`; `getUserClient(req)`; `credit_balance` minting on overpayment with `paid_amount <= total_amount`).

- [ ] **Step 4: Run new + existing white-box/black-box invoice & payment suites**

Run: `cd api && node --test --test-concurrency=1 test/invoiceFourEyesAndCreditBalance.test.js test/fullWebsiteWhiteBlackBox.test.js test/remediationR01ToR24.test.js`
Expected: PASS (`0` failures — verifying `ALREADY_PAID` on `{ status: 'CANCELLED' }` at `fullWebsiteWhiteBlackBox.test.js:1404` and `DRAFT -> ISSUED` adjustment at `:1334` remain 100% green).

- [ ] **Step 5: Commit**

```bash
git add api/src/routes/invoices.js api/src/routes/payments.js api/test/invoiceFourEyesAndCreditBalance.test.js
git commit -m "feat(invoices,payments): add DRAFT line CRUD, 4-eyes post-ISSUED adjustments, invoice audit trail, and credit_balance offset"
```

---

### Task 7: Deposit Final Settlement (`credit_balance` Separation) & KPI Reports / `RP-08` (`deposits.js` & `reports.js`)

**Files:**
- Modify: `api/src/services/depositSettlement.js:1-220`
- Modify: `api/src/routes/deposits.js:90-260, 740-1240`
- Modify: `api/src/routes/reports.js:1-369`
- Modify: `api/src/routes/admin/audit-logs.js:1-141`
- Test: `api/test/settlementCreditAndKpiReports.test.js`

**Interfaces:**
- Consumes: `credit_balance` & `invoice_adjustment` tables (Task 1), `todayVietnamYmd` / `currentVietnamPeriod` from `api/src/services/serviceBilling.js` (Task 2).
- Produces:
  - `checkSettlementPreconditions` in `deposits.js`: adds `no_pending_invoice_adjustments` (`409 PENDING_INVOICE_ADJUSTMENT` if any contract invoice has `invoice_adjustment.status = 'PENDING_APPROVAL'`), and updates `calculateContractOpenDebts` to include `'ADJUSTED'` invoices (`status IN ('ISSUED', 'ADJUSTED', 'PARTIALLY_PAID', 'OVERDUE')`).
  - `computeFinalSettlementWithCredit({ heldBefore, availableCredit, serviceDebt, rentDebt, items })` in `api/src/services/depositSettlement.js` & settlement execution in `GET /:id/settlement`, `POST /:id/settlement`, `POST /:id/settlement/approve`, `GET /:id/settlement/pdf`:
    - Step 1 (`credit_balance`): offsets `serviceDebt` first, then `rentDebt`, then excess damages (`Math.max(0, sumItems - heldBefore)`), and marks remaining credit `'REFUNDED_IN_SETTLEMENT'` (`credit_refund_amount`).
    - Step 2 (`deposit_transaction`): records `deduct` ONLY for `items` (up to `heldBefore`) and remaining `serviceDebt` (NEVER `rentDebt`, `FR-068`), and `refund` for `deposit_refund_amount = Math.max(0, heldBefore - sumItems - coveredServiceDebt)` so `SUM(deduct) + refund === heldBefore` (`RP-07`); stores `available_credit`, `credit_applied_to_invoices`, `credit_applied_to_damages`, `credit_refund_amount`, `deposit_refund_amount`, `total_payout_amount = deposit_refund_amount + credit_refund_amount` in `deposit.settlement`.
  - `GET /api/v1/reports/dashboard` & `GET /api/v1/reports/summary` (executed via `getUserClient(req)`):
    - `billed` = `SUM(i.total_amount + i.credit_offset_amount) FILTER (WHERE i.status NOT IN ('DRAFT', 'VOID'))` by `i.period`.
    - `collected` (*Tiền thực thu*, `PRD 15.3`) = `SUM(p.amount)` of `CONFIRMED` `payment` rows grouped by `TO_CHAR(p.paid_at AT TIME ZONE 'Asia/Ho_Chi_Minh', 'YYYY-MM')`.
    - `invoice_settled` (`PRD 15.1`) = `SUM(i.paid_amount + i.credit_offset_amount) FILTER (WHERE i.status NOT IN ('DRAFT', 'VOID'))` by `i.period` (`billed === invoice_settled + outstanding`).
  - `GET /api/v1/reports/financial-audit-logs` (`RP-08` for `SYS_ADMIN`, `OWNER`, `MANAGER` via RLS `getUserClient(req)`): filters `audit_log.entity IN ('invoice', 'invoice_line', 'invoice_adjustment', 'payment', 'credit_balance', 'deposit', 'deposit_transaction', 'service_subscription')`.

- [ ] **Step 1: Write the failing settlement & KPI report tests in `api/test/settlementCreditAndKpiReports.test.js`**

Write integration tests asserting:
1. `POST /api/v1/deposits/:id/settlement` returns `409 PENDING_INVOICE_ADJUSTMENT` while an `invoice_adjustment` on the contract is `PENDING_APPROVAL`.
2. **Review Focus #5 pin:** Contract has `deposit.amount_held = 10_000_000`, `availableCredit = 3_000_000`, unpaid `SERVICE` debt `= 1_000_000`, unpaid `RENT` debt `= 5_000_000`, and damage `items = 2_000_000`:
   - Step 1 uses `3_000_000` `credit_balance` to pay `1_000_000` `SERVICE` debt + `2_000_000` of `RENT` debt (`credit_refund_amount = 0`).
   - Step 2 deducts `2_000_000` damages from `deposit_transaction` and refunds `deposit_refund_amount = 8_000_000` (`FR-068`: NEVER deducts the remaining `3_000_000` `RENT` debt from deposit!).
   - Remaining `3_000_000` `RENT` debt becomes `RECEIVABLE_AFTER_MOVE_OUT`, and `deposit_transaction` `deduct (2M) + refund (8M) === 10M` (`RP-07`).
   - Second sub-case (`availableCredit = 4_000_000`, zero debt, zero damages, `heldBefore = 10_000_000`): `deposit_refund_amount = 10_000_000` in `deposit_transaction`, `credit_refund_amount = 4_000_000` (`credit_balance.status = 'REFUNDED_IN_SETTLEMENT'`), `total_payout_amount = 14_000_000`.
3. KPI Reports (`GET /api/v1/reports/dashboard` & `/summary`):
   - Month M1 invoice (`10_000_000` paid in M1, then `-2_000_000` adjustment approved -> `credit_balance = 2_000_000`) + Month M2 invoice (`subtotal = 10_000_000`, `credit_offset_amount = 2_000_000`, `total_amount = 8_000_000`, resident pays `8_000_000` in M2):
     - M1 `billed = 8_000_000`; M2 `billed = 10_000_000` (no double revenue deduction!), M2 `collected = 8_000_000` (*Tiền thực thu* cash in M2, `PRD 15.3`), M2 `invoice_settled = 10_000_000` (`billed === invoice_settled + outstanding`, `PRD 15.1`); `DRAFT` and `VOID` invoices are excluded from `billed`.
4. `GET /api/v1/reports/financial-audit-logs` (`RP-08`) allows `MANAGER` and `OWNER` to read financial audit logs of their assigned/owned building only.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && node --test --test-concurrency=1 test/settlementCreditAndKpiReports.test.js`
Expected: FAIL (`no_pending_invoice_adjustments` missing, `credit_balance` ignored in settlement, `reports.js` `billed` missing `credit_offset_amount` and `/financial-audit-logs` `404`).

- [ ] **Step 3: Implement settlement & KPI report updates in `depositSettlement.js`, `deposits.js`, `reports.js`, and `admin/audit-logs.js`**

- Add `computeFinalSettlementWithCredit` to `api/src/services/depositSettlement.js` and wire it into `GET /:id/settlement`, `POST /:id/settlement`, `POST /:id/settlement/approve`, and `GET /:id/settlement/pdf` in `api/src/routes/deposits.js` alongside the `no_pending_invoice_adjustments` precondition check.
- Update `api/src/routes/reports.js` to run under `getUserClient(req)`, compute `billed`, `collected`, `invoice_settled`, and `outstanding` per Spec Section `5.5.3`, and expose `GET /api/v1/reports/financial-audit-logs` (`RP-08`). Ensure `api/src/routes/admin/audit-logs.js` supports filtering the new financial entities cleanly.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd api && node --test --test-concurrency=1 test/settlementCreditAndKpiReports.test.js`
Expected: PASS (`0` failures).

- [ ] **Step 5: Commit**

```bash
git add api/src/services/depositSettlement.js api/src/routes/deposits.js api/src/routes/reports.js api/src/routes/admin/audit-logs.js api/test/settlementCreditAndKpiReports.test.js
git commit -m "feat(settlement,reports): separate credit_balance in deposit settlement and align PRD 15.1-15.3 KPIs and RP-08"
```

---

### Task 8: Frontend Portals — Resident, Manager & Owner UI (`PRD 8.2`, `16.1`, `16.2`)

**Files:**
- Create: `frontend/src/utils/billing.js`
- Modify: `frontend/src/constants/statuses.js:1-160`
- Modify: `frontend/src/services/api.js:1-40`
- Modify: `frontend/src/services/invoices.service.js:1-15`
- Modify: `frontend/src/services/services.service.js:1-15`
- Modify: `frontend/src/services/resident.service.js:1-40`
- Modify: `frontend/src/services/reports.service.js`
- Modify: `frontend/src/hooks/usePermission.js:25-51`
- Modify: `frontend/src/pages/resident/tabs/ServicesTab.jsx`
- Modify: `frontend/src/pages/resident/tabs/InvoicesTab.jsx`
- Modify: `frontend/src/pages/admin/services/SubscriptionsPage.jsx`
- Modify: `frontend/src/pages/admin/services/ServiceCatalogPage.jsx`
- Modify: `frontend/src/pages/admin/invoices/InvoicesPage.jsx`
- Modify: `frontend/src/pages/admin/invoices/InvoiceDetailPage.jsx`
- Modify: `frontend/src/pages/admin/contracts/ContractDetailPage.jsx`
- Modify: `frontend/src/pages/admin/deposits/DepositsPage.jsx`
- Modify: `frontend/src/pages/admin/reports/ReportsPage.jsx`
- Test: `api/test/frontendBillingHelpers.test.js`

**Interfaces:**
- Consumes: all backend endpoints & response payloads from Tasks 4–7.
- Produces:
  - `frontend/src/utils/billing.js`: `roundVND(amount)`, `todayVietnamYmd(now)`, `previewSubscriptionProrata({ unitPrice, quantity, startDate, endDate, mode })`, `generateIdempotencyKey()`.
  - `frontend/src/services/api.js`: Axios request interceptor auto-attaching `Idempotency-Key` (`crypto.randomUUID()`) on mutating `POST` requests to `/api/v1/invoices`, `/api/v1/payments`, `/api/v1/service-catalog`, `/api/v1/service-subscriptions`, `/api/v1/contracts`, `/api/v1/deposits` when not already set (preserving the same key across `401` token-refresh retries on `originalRequest`).
  - `frontend/src/hooks/usePermission.js`: `canManageServiceCatalog: isManager`, `canManageServices: isManager`, `canManageInvoices: isManager`, `canManagePayments: isManager`, `canApproveInvoiceAdjustments: isOwner || isManager || isSysAdmin`.
  - `invoicesService`: `addLine`, `updateLine`, `deleteLine`, `issue`, `createAdjustment`, `listAdjustments`, `approveAdjustment`, `rejectAdjustment`, `getAuditLogs`.
  - `residentService`: `withdrawCancelService(id)`.

- [ ] **Step 1: Write failing unit tests for shared frontend billing/status helpers in `api/test/frontendBillingHelpers.test.js`**

Import `../../frontend/src/utils/billing.js` and `../../frontend/src/constants/statuses.js` in `node:test`, asserting:
1. `SUBSCRIPTION_STATUS.TERMINATED`, `INVOICE_STATUS.ADJUSTED`, `INVOICE_STATUS.VOID`, and `INVOICE_ADJUSTMENT_STATUS.PENDING_APPROVAL` exist alongside legacy `CANCELLED` display fallback.
2. `previewSubscriptionProrata` uses `todayVietnamYmd`, `roundVND` (`ROUND(x, -3)`), returns `0 ₫` (`activeDays = 0`) when `endDate < startDate`, and computes `[max(startDate, monthStart) .. endDate]` (`11/30` days for `10/11 -> 20/11`) matching `serviceBilling.js` 100%.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && node --test --test-concurrency=1 test/frontendBillingHelpers.test.js`
Expected: FAIL (`Cannot find module '../../frontend/src/utils/billing.js'`).

- [ ] **Step 3: Implement frontend utilities, services, RBAC hooks, and UI pages**

Implement Spec Section `5.6`:
- Create `frontend/src/utils/billing.js`; update `frontend/src/constants/statuses.js`, `frontend/src/services/api.js` (`Idempotency-Key` header), `invoices.service.js`, `services.service.js`, `resident.service.js`, `reports.service.js`, and `usePermission.js`.
- **Resident Portal (`ServicesTab.jsx`, `InvoicesTab.jsx`):**
  - `ServicesTab.jsx`: unlock `0 ₫` cancel when `status === 'PENDING_APPROVAL'` or `todayVietnamYmd() < subStart` with explicit banner *"Dịch vụ chưa bắt đầu sử dụng — Hủy trước ngày bắt đầu sẽ không phát sinh chi phí (0 ₫)"*; use `previewSubscriptionProrata`; add *"Rút yêu cầu hủy"* button for `CANCELLATION_PENDING`; include `'TERMINATED'` in history filter.
  - `InvoicesTab.jsx`: display `available_credit_balance` banner from `overview`; support `'ADJUSTED'` and `'VOID'` badges/filters; render `formula_meta` / Pro-rata explanation beneath invoice lines.
- **Admin / Owner Portal:**
  - `SubscriptionsPage.jsx` & `ServiceCatalogPage.jsx`: `MANAGER`-only write buttons (`R` view for `SYS_ADMIN` / `OWNER`), pre-start `0 ₫` / `zero_usage` checkbox, *"Giữ lại dịch vụ (Từ chối hủy)"* action, toast displaying `invoice_sync` result across the 3 scenarios.
  - `InvoicesPage.jsx` & `InvoiceDetailPage.jsx`:
    - On `DRAFT` (`MANAGER`): inline add/edit/delete line controls; contextual confirmation dialog on *"Phát hành hóa đơn"* (`PRD 16.1` showing period, total, and immutability warning).
    - On `VOID` (both `DRAFT` direct void and post-`ISSUED` `VOID` request): 2-step confirmation modal requiring exact typing of `invoice.invoice_code` + mandatory reason (`PRD 16.2`).
    - On post-`ISSUED`: hide direct edit; show *"Lập điều chỉnh / Hủy hóa đơn (4 mắt)"* modal (`POST /invoices/:id/adjust`) for `MANAGER`; render `invoice_adjustment` list (plus *"Chờ duyệt điều chỉnh"* filter on `InvoicesPage.jsx`) with **Phê duyệt / Từ chối** buttons enabled for `OWNER`, 2nd `MANAGER` (`String(user?.id || user?.sub) !== String(adj.created_by)`), or `SYS_ADMIN` when `!invoice.has_building_owner`.
    - Add inline **`Lịch sử / Kiểm toán`** tab on `InvoiceDetailPage.jsx` (`PRD 8.2`) fetching `invoicesService.getAuditLogs(id)` with `before`/`after` diff badges.
  - `ContractDetailPage.jsx`, `DepositsPage.jsx`, `ReportsPage.jsx`: display contract `available_credit_balance`; show separated `deposit_refund_amount`, `credit_refund_amount`, `total_payout_amount`, and `PENDING_APPROVAL` invoice-adjustment warning on `DepositsPage.jsx`; show `billed` vs `collected` (*Tiền thực thu*) vs `invoice_settled` + `RP-08` financial audit tab on `ReportsPage.jsx`.

- [ ] **Step 4: Run frontend helper tests, linter, production build, and full backend regression suite**

Run: `cd frontend && npm run lint && npm run build && cd ../api && npm test`
Expected: `oxlint` 0 errors, `vite build` succeeds cleanly, and `npm test` passes across all backend suites (`0` failures).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/utils/billing.js frontend/src/constants/statuses.js frontend/src/services/api.js frontend/src/services/invoices.service.js frontend/src/services/services.service.js frontend/src/services/resident.service.js frontend/src/services/reports.service.js frontend/src/hooks/usePermission.js frontend/src/pages/resident/tabs/ServicesTab.jsx frontend/src/pages/resident/tabs/InvoicesTab.jsx frontend/src/pages/admin/services/SubscriptionsPage.jsx frontend/src/pages/admin/services/ServiceCatalogPage.jsx frontend/src/pages/admin/invoices/InvoicesPage.jsx frontend/src/pages/admin/invoices/InvoiceDetailPage.jsx frontend/src/pages/admin/contracts/ContractDetailPage.jsx frontend/src/pages/admin/deposits/DepositsPage.jsx frontend/src/pages/admin/reports/ReportsPage.jsx api/test/frontendBillingHelpers.test.js
git commit -m "feat(frontend): add 0 VND pre-start cancel, DRAFT line editor, 4-eyes approval UI, 2-step VOID confirm, and audit tab"
```
