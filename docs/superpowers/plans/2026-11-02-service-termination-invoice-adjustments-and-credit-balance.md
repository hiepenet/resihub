# Service Termination, Four-Eyes Invoice Adjustments & Credit Balance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver end-to-end PRD v2.0-compliant pre-start (`0 ₫`) and mid-term Pro-rata service cancellation (`TERMINATED`), early contract termination `RENT` + `SERVICE` invoice synchronization (`6A`), 3-scenario invoice lifecycle with Four-eyes post-`ISSUED` approvals (`ADJUSTED` / `VOID`), `credit_balance` ledger auto-offsetting, and M06-compatible two-step deposit-separated move-out settlement across PostgreSQL RLS, Express API, and React UI.

**Architecture:** Migration `047` standardizes status enums (`TERMINATED`, `ADJUSTED`, `VOID`), enforces `Unique(contract_id, period)` on active invoices (`PRD 13.3`), adds `invoice_adjustment` and `credit_balance` under strict `PRD 6.2` RLS (`MANAGER` `CRU`, `SYS_ADMIN` read-only + fallback approver, `OWNER` + 2nd `MANAGER` Four-eyes approval via narrow `SECURITY DEFINER` RPC `fn_resolve_invoice_adjustment`), upgrades M06 `045` settlement RPCs for two-step payout (`APPROVED_PENDING_PAYOUT` -> `payout` / `payout-returned`), and expands `046`'s `rls_audit_log_select` as a strict superset. Two backend domain modules (`serviceBilling.js` for `Asia/Ho_Chi_Minh` Pro-rata & 3-tier `FR-065` pricing; `invoiceLifecycle.js` for 3-scenario `DRAFT` / 4-eyes sync and `credit_balance` FIFO ledger) power service, contract, append-only `daily.js` late-fee, invoice, payment, deposit-settlement, and KPI/`RP-08` routes, surfaced across Admin, Owner, and Resident portals.

**Tech Stack:** Node.js (ESM), Express 4, PostgreSQL 16 (`pg` with session-variable RLS via `getUserClient(req)`), `node:test`, React 19, Vite 8, Tailwind CSS, Zustand, Axios.

**Spec:** `docs/superpowers/specs/2026-11-02-service-cancellation-and-invoice-recalc-design.md`

## Global Constraints

- Physical status codes (`PRD Mục 13.2`): `service_subscription.status IN ('PENDING_APPROVAL', 'ACTIVE', 'CANCELLATION_PENDING', 'TERMINATED', 'REJECTED')`; `invoice.status IN ('DRAFT', 'ISSUED', 'PARTIALLY_PAID', 'PAID', 'OVERDUE', 'ADJUSTED', 'VOID')`; normalize legacy input `'CANCELLED'` -> `'TERMINATED'` (subscriptions) or `'VOID'` (invoices) at both API and `BEFORE` trigger boundaries; do NOT rename `'CANCELLED'` on `contract`, `service_request`, `reservation`, or `announcement`.
- Timezone & rounding (`PRD Mục 10.3, 13.4`): all business `today` / period checks use `Asia/Ho_Chi_Minh` (`todayVietnamYmd()` in JS, `(NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date` in SQL); all VND charges round to nearest thousand via `roundVND` (`ROUND(x, -3)`); `end_date < start_date` (`start_date - 1 day`) represents `0` active days (`0 ₫`).
- Accounting & immutability invariants (`FR-034`, `FR-035`, `FR-068`, `Mục 13.3`, `NFR-016`): NEVER `UPDATE` or `DELETE` existing `invoice_line` rows once `invoice.status <> 'DRAFT'` (including `LATE_FEE` lines in `daily.js`); enforce `idx_invoice_unique_active_period` (`status <> 'VOID'`) and `0 <= paid_amount <= total_amount` on `invoice`, plus `amount > 0` on `receivable` (`WRITTEN_OFF` when `0 ₫`); NEVER mix `credit_balance` refunds into `deposit_transaction` (`RP-07`) or deduct `RENT` debt from deposit principal (`FR-068`).
- RBAC, RLS & Idempotency (`PRD Mục 6.1–6.2, 14.3`, `NFR-008`, `AC-003.2`, `AC-019.1`): `MANAGER` has `CRU` on assigned buildings (`get_manager_building_ids()`); `SYS_ADMIN` is read-only (`R`) on services/invoices/payments/credits and only approves `invoice_adjustment` when `NOT building_has_active_owner(building_id)`; `OWNER` (`get_owner_building_ids()`) and 2nd `MANAGER` approve post-`ISSUED` adjustments ONLY through `fn_resolve_invoice_adjustment` (`SECURITY DEFINER`); `RESIDENT` never sees `DRAFT` invoices; business route queries MUST use `getUserClient(req)` (never `adminPool` RLS bypass) and mutating financial/service endpoints (including `/api/v1/resident/*`) MUST attach `idempotencyGuard()`.
- Workspace hygiene: migration is numbered `047_service_termination_invoice_adjustments_and_credit_balance.sql` (following M06 `044`–`046`); NEVER stage, revert, or overwrite uncommitted M06 working-tree changes (`api/test/m06Phase*.test.js`, `docs/BAO_CAO_RA_SOAT_THU_HOAN_COC_M06.md`, `docs/superpowers/plans/2026-11-02-m06-phase*.md`).

## Review Focus

1. **Sequential post-`ISSUED` downward adjustments on an already-`PAID` invoice & `credit_offset_amount` release when `rawTotal < 0`:** First approval clamps `invoice.paid_amount` to `nextTotal_1` and mints `credit_balance_1 = oldPaid - nextTotal_1`; second approval computes `excessPaid_2 = paid_amount_after_1 - nextTotal_2` (zero double-minting). On an unpaid invoice with `credit_offset_amount > 0` where a negative adjustment drives `rawTotal < 0`, `fn_resolve_invoice_adjustment` releases `LEAST(credit_offset_amount, ABS(rawTotal))` back to source `credit_balance` rows (`AVAILABLE` / `PARTIALLY_APPLIED`) and clamps `total_amount = 0` *(pinned in Task 1 & Task 6)*.
2. **Append-only `LATE_FEE` accrual in `daily.js` Step 7 after a post-`ISSUED` adjustment neutralizes prior late fees:** `fn_resolve_invoice_adjustment` tags `LATE_FEE`-neutralizing `ADJUSTMENT` lines with `formula_meta->>'adjusts_item_type' = 'LATE_FEE'`, and `daily.js` computes `net_existing_late_fee` across both `LATE_FEE` and `adjusts_item_type = 'LATE_FEE'` lines, never `DELETE`s `invoice_line` rows, never accrues late fees when `unpaid_principal <= 0`, and only `INSERT`s `deltaFee > 0` *(pinned in Task 1 & Task 5)*.
3. **Boundary dates on `31`-day months, leap-year February (`2028-02-29`), and `00:05–06:55` ICT (`17:05–23:55` UTC previous day):** `todayVietnamYmd` resolves the Vietnam calendar date (never UTC day-1), and `activeDays === daysInMonth` (`31/31` or `29/29`) charges exact `unitPrice * quantity` with `isProrated = false` and `delta = 0` *(pinned in Task 2)*.
4. **Order B payment commutativity & idempotent adjustment re-sync:** When a resident has already submitted a `PENDING_CONFIRMATION` bank transfer before an invoice's `remaining` shrinks via 4-eyes downward adjustment, `PATCH /api/v1/payments/:id/confirm` still confirms the transfer and mints `OVERPAYMENT` `credit_balance` (matching Order A to the exact VND), while direct `POST /api/v1/payments` and `POST /api/v1/resident/payments/report` block `remaining <= 0` with `409 ALREADY_PAID`; re-running sync while an adjustment is `PENDING_APPROVAL` yields `delta = 0` instead of `23505` *(pinned in Task 3 & Task 6)*.
5. **M06 two-step deposit settlement when damages consume 100% of deposit (`deposit_refund_amount = 0`) while `credit_refund_amount > 0` (`total_payout_amount > 0`), plus `OWNER` `total_payout_amount = 0` RLS & mixed `RENT`/`SERVICE` debt:** `fn_apply_deposit_settlement_accounting` (`SECURITY DEFINER`) offsets `credit_balance` against `rentDebt` first (matching `v_paid_to_rent := LEAST(v_paid, v_rent_gross)`), then `serviceDebt`, then excess damages; when `total_payout_amount === 0`, `OWNER` approves and commits without RLS errors; when `deposit_refund_amount = 0` and `credit_refund_amount > 0`, `approve` transitions to `APPROVED_PENDING_PAYOUT`, `PATCH /:id/bank-info`, `POST /:id/payout`, and `POST /:id/payout-returned` succeed, and `deposit_transaction` records zero `refund` rows so `RP-07` `deduct + refund === heldBefore` holds strictly *(pinned in Task 1 & Task 7)*.

---

## File Structure

- **Database Migration (`047`):**
  - Create: `api/src/db/migrations/047_service_termination_invoice_adjustments_and_credit_balance.sql` — dynamic `pg_constraint` swaps, `idx_invoice_unique_active_period`, legacy `'CANCELLED'` normalization `BEFORE` triggers, `invoice_adjustment`, `credit_balance`, `PRD 6.2` RLS policies, `rls_audit_log_select` superset over `046`, `fn_resolve_invoice_adjustment`, and M06 settlement RPC upgrades (`fn_apply_deposit_settlement_accounting`, `fn_update_deposit_refund_bank_info`, `fn_restore_returned_settlement_credits`).
  - Modify: `api/test/remediationR01ToR24.test.js:416-426` — update raw SQL subscription fixture `'CANCELLED'` -> `'TERMINATED'`.
- **Backend Domain Services:**
  - Create: `api/src/services/serviceBilling.js` — `Asia/Ho_Chi_Minh` date helpers, status normalizers, `FR-065` 3-tier price resolver, subscription & contract `RENT` Pro-rata calculators with `formula_meta`.
  - Modify: `api/src/services/invoiceSchedule.js:1-210` — preserve historical periods `1..N-1` for `TERMINATED` subscriptions and support 3-tier pricing + `'VOID'` / `'ADJUSTED'`.
  - Modify: `api/src/services/contractTemplate.js:81-90` — exclude `'TERMINATED'` / `'CANCELLED'` / `'REJECTED'` subscriptions cleanly.
  - Create: `api/src/services/invoiceLifecycle.js` — `credit_balance` FIFO apply/release/transfer helpers, `DRAFT` recalculation + empty-shell auto-`VOID` + `audit_log`, 3-scenario subscription sync, and `closeContractBillingAndSubscriptionsInTx` (`6A`).
- **Backend Routes & Jobs:**
  - Modify: `api/src/routes/services.js` — `MANAGER`-only writes, `getUserClient(req)`, `idempotencyGuard()` on `POST`/`PATCH`, 3-tier price lookup, pre-start `0 ₫` / mid-term `TERMINATED` + 3-scenario invoice sync + reject-cancel + `audit_log`.
  - Modify: `api/src/routes/resident.js` — `idempotencyGuard()` on mutating routes, pre-start `0 ₫` cancel, `PENDING_APPROVAL` withdraw, `PATCH /services/:id/withdraw-cancel`, strict `'DRAFT'`/`'VOID'` filters (`AC-003.2`), `available_credit_balance` on `/overview`.
  - Modify: `api/src/routes/contracts.js` — wire `closeContractBillingAndSubscriptionsInTx` (`6A`) across all 6 contract-ending paths, wire `transferContractCreditsInTx` on `transfer-room` and inside `runActivationSideEffects` (`parent_contract_id`, covering both `MANAGER` `activate` and `OWNER` `approve-price`), hide `DRAFT` invoices from `RESIDENT`, expose `available_credit_balance`.
  - Modify: `api/src/jobs/daily.js` — `Asia/Ho_Chi_Minh` dates, wire `6A` into Steps 1a & 1b, include `'ADJUSTED'` (`paid_amount < total_amount`) in Steps 6 & 7, replace `DELETE FROM invoice_line WHERE item_type = 'LATE_FEE'` with append-only delta `LATE_FEE` insertion.
  - Modify: `api/src/routes/invoices.js` — `MANAGER`-only writes, exhaustive `'CANCELLED'` -> `'VOID'` & `!['DRAFT', 'VOID']` filters, `DRAFT` line CRUD, `POST /:id/issue`, `PATCH /:id/status`, `POST /:id/adjust`, `GET /adjustments`, 4-eyes `/approve` & `/reject`, `GET /:id/audit-logs`, `credit_balance` FIFO auto-offset + `23505` duplicate-period guard.
  - Modify: `api/src/routes/payments.js` — `MANAGER`-only admin writes, `idempotencyGuard()`, block `DRAFT`/`VOID` + `remaining <= 0` on direct `POST /`, allow `PATCH /:id/confirm` when `remaining <= 0` (Order B commutativity), clamp `paid_amount <= total_amount` and mint `OVERPAYMENT` `credit_balance`.
  - Modify: `api/src/services/depositSettlement.js`, `api/src/routes/deposits.js`, `api/src/routes/reports.js`, `api/src/routes/admin/audit-logs.js` — M06 two-step payout (`APPROVED_PENDING_PAYOUT` / `payout` / `payout-returned` / `bank-info`) with `credit_balance` separation (`FR-068`, `RP-07`), `available_credit` staleness guard, `PRD 15.1–15.3` KPIs, and unified 10-entity `FINANCIAL_AUDIT_ENTITIES` on `GET /api/v1/audit-logs?scope=financial` (`RP-08`).
- **Frontend:**
  - Task 8 (Core Helpers + Admin/Owner Services & Invoices UI): `frontend/src/utils/billing.js` (create, reusing `frontend/src/utils/idempotency.js`), `frontend/src/constants/statuses.js`, `frontend/src/services/api.js`, `frontend/src/hooks/usePermission.js`, `frontend/src/services/invoices.service.js`, `frontend/src/services/services.service.js`, `frontend/src/pages/admin/services/ServiceCatalogPage.jsx`, `frontend/src/pages/admin/services/SubscriptionsPage.jsx`, `frontend/src/pages/admin/invoices/InvoicesPage.jsx`, `frontend/src/pages/admin/invoices/InvoiceDetailPage.jsx`.
  - Task 9 (Resident Portal + Contract, Deposit 2-Step Payout & Reports/Audit UI): `frontend/src/services/resident.service.js`, `frontend/src/pages/resident/tabs/ServicesTab.jsx`, `frontend/src/pages/resident/tabs/InvoicesTab.jsx`, `frontend/src/pages/admin/contracts/ContractDetailPage.jsx`, `frontend/src/pages/admin/deposits/DepositsPage.jsx`, `frontend/src/pages/admin/reports/ReportsPage.jsx`, `frontend/src/pages/admin/audit/AuditLogsPage.jsx`.

---

### Task 1: Migration `047`, `PRD 6.2` RLS, `fn_resolve_invoice_adjustment` & M06 Settlement RPC Upgrades

**Files:**
- Create: `api/src/db/migrations/047_service_termination_invoice_adjustments_and_credit_balance.sql`
- Modify: `api/test/remediationR01ToR24.test.js:416-426`
- Test: `api/test/migration047RlsAndRpc.test.js`

**Interfaces:**
- Consumes: SQL helpers `is_org_admin()`, `is_owner()`, `is_manager()`, `is_resident()`, `get_current_user_id()`, `get_current_user_org_id()`, `get_user_assigned_buildings()`, `get_owner_building_ids()`, `get_manager_building_ids()`, `get_resident_contract_ids()`, `get_resident_tenant_ids()`, `building_has_active_owner(UUID)` (`041`), M06 settlement RPCs (`045`), and `rls_audit_log_select` (`046`).
- Produces:
  - `service_catalog` partial unique indexes `idx_service_catalog_org_default_code` (`WHERE building_id IS NULL`) & `idx_service_catalog_building_code` (`WHERE building_id IS NOT NULL`).
  - `service_subscription.status` enum `'TERMINATED'` + `trg_normalize_legacy_subscription_status` (`BEFORE INSERT OR UPDATE`: `'CANCELLED' -> 'TERMINATED'`).
  - `invoice.status` enums `'ADJUSTED'`, `'VOID'` + `trg_normalize_legacy_invoice_status` (`BEFORE INSERT OR UPDATE`: `'CANCELLED' -> 'VOID'`), `invoice.credit_offset_amount BIGINT NOT NULL DEFAULT 0`, `invoice_paid_lte_total_check`, and `idx_invoice_unique_active_period ON invoice(contract_id, period) WHERE contract_id IS NOT NULL AND status <> 'VOID'` (`PRD Mục 13.3`).
  - `invoice_line` columns `subscription_id UUID`, `credit_id UUID`, `adjustment_id UUID`, `formula_meta JSONB`.
  - Tables `invoice_adjustment` and `credit_balance` (`settlement_refund_amount BIGINT NOT NULL DEFAULT 0` included on `credit_balance` to track exact refunded portion per settlement for clean `RETURNED` reversal) with `ENABLE` + `FORCE ROW LEVEL SECURITY` and partial unique indexes (`idx_invoice_adj_pending_sub`, `idx_invoice_adj_pending_rent`, `idx_invoice_adj_pending_void`, `idx_credit_balance_unique_adj`, `idx_credit_balance_unique_payment`, `idx_credit_balance_contract_avail`).
  - `rls_audit_log_select` superset over `046`: preserves `building` (for `OWNER`) + `apartment`, `reservation`, `contract`, `deposit`, `deposit_transaction`, `receivable` (for `OWNER` & `MANAGER`) and adds `invoice`, `invoice_line`, `invoice_adjustment`, `payment`, `credit_balance`, `service_subscription` for BOTH `is_owner()` (`get_owner_building_ids()`) and `is_manager()` (`get_manager_building_ids()`).
  - `fn_resolve_invoice_adjustment(p_adjustment_id UUID, p_decision TEXT, p_rejection_reason TEXT DEFAULT NULL, p_allow_self_approval BOOLEAN DEFAULT FALSE) RETURNS JSONB` (`SECURITY DEFINER SET search_path = public, pg_temp`).
  - Upgraded `fn_apply_deposit_settlement_accounting(p_deposit_id UUID, p_covered_service_debt BIGINT, p_uncovered_items_shortfall BIGINT) RETURNS VOID`, `fn_update_deposit_refund_bank_info(p_deposit_id UUID, p_bank_info JSONB) RETURNS deposit`, and `fn_restore_returned_settlement_credits(p_deposit_id UUID, p_reason TEXT) RETURNS INT` (`SECURITY DEFINER SET search_path = public, pg_temp SET row_security = off`).

- [ ] **Step 1: Write the failing schema, RLS & RPC integration test in `api/test/migration047RlsAndRpc.test.js`**

Write `node:test` suite connecting via `adminPool` and `appPool` (`resihub_app` with `set_config('app.current_user_id', ...)`) asserting:
1. `service_catalog` allows same `code` across `building_id IS NULL` and two distinct buildings while blocking duplicate default `(org_id, code)`; `idx_invoice_unique_active_period` blocks a second non-`VOID` invoice on `(contract_id, period)` with `23505`, then allows inserting a replacement invoice once the first is set to `'VOID'` (including via legacy `UPDATE invoice SET status = 'CANCELLED'`, which stores physical `'VOID'`).
2. `RESIDENT` `SELECT` on `invoice` returns `0` rows when `status = 'DRAFT'` (`AC-003.2`) and `1` row once `status = 'ISSUED'`; `SYS_ADMIN` and `OWNER` direct `INSERT`/`UPDATE` on `service_catalog`, `service_subscription`, `invoice`, `invoice_line`, `payment`, `receivable`, `credit_balance` are blocked by RLS, while `rls_audit_log_select` lets both `OWNER` and `MANAGER` read `reservation`, `receivable`, `deposit`, `invoice`, `invoice_line`, `invoice_adjustment`, `credit_balance`, and `service_subscription` logs of their building (`046` superset).
3. `fn_resolve_invoice_adjustment`:
   - Rejects self-approval (`SELF_APPROVAL`), blocks `SYS_ADMIN` when `building_has_active_owner(building_id)` is `true`, and allows `SYS_ADMIN` when `owner_id IS NULL`.
   - **Review Focus #1 pin:** Approving two sequential downward `ADJUST` rows (`SERVICE` `-100_000`, then `RENT` `-5_000_000`) on a `PAID` invoice (`10_200_000`) leaves existing `invoice_line` rows untouched, sets `invoice.status = 'ADJUSTED'`, `total_amount = 5_100_000`, `paid_amount = 5_100_000`, and mints `100_000` + `5_000_000 = 5_100_000` total `credit_balance` (zero double-minting). Approving `ADJUST` (`-400_000`) on an unpaid `ISSUED` invoice (`subtotal = 500_000`, `credit_offset_amount = 300_000`, `total = 200_000`) releases `200_000` back to `credit_balance` (`PARTIALLY_APPLIED`, `applied_amount = 100_000`), sets `invoice.credit_offset_amount = 100_000`, `total_amount = 0`, and marks `receivable` `'WRITTEN_OFF'`.
   - **Review Focus #2 pin:** When an unpaid `OVERDUE` invoice has a `LATE_FEE` line (`200_000`) and principal is adjusted down to `0`, `fn_resolve_invoice_adjustment` appends a `-200_000` `ADJUSTMENT` line with `formula_meta->>'adjusts_item_type' = 'LATE_FEE'` without deleting the original `LATE_FEE` row.
4. **Review Focus #5 DB pin:** Calling `fn_apply_deposit_settlement_accounting` as `OWNER` on a `PENDING_APPROVAL` deposit with `total_payout_amount = 0`, an `'ADJUSTED'` open invoice, and `credit_balance` (`AVAILABLE`) succeeds without RLS error, offsets `credit_balance` (`rentDebt` -> `serviceDebt` -> excess damages), and `fn_update_deposit_refund_bank_info` succeeds when `deposit_refund_amount = 0` and `total_payout_amount = 400_000`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && node --test --test-concurrency=1 test/migration047RlsAndRpc.test.js`
Expected: FAIL (`relation "invoice_adjustment" does not exist` / `function fn_resolve_invoice_adjustment does not exist`).

- [ ] **Step 3: Write `api/src/db/migrations/047_service_termination_invoice_adjustments_and_credit_balance.sql` and update `api/test/remediationR01ToR24.test.js:424`**

Implement Spec Section `5.1` in `047_service_termination_invoice_adjustments_and_credit_balance.sql`:
- Add commented Rollback SQL header (`PRD 14.5`).
- Dynamically drop legacy `service_catalog` `(org_id, code)` unique constraint and `status` `CHECK` constraints on `service_subscription` & `invoice` via `pg_constraint`; migrate `'CANCELLED' -> 'TERMINATED'` / `'VOID'`; attach `BEFORE INSERT OR UPDATE OF status` normalization triggers; deduplicate any stale unpaid `DRAFT` duplicate `(contract_id, period)` rows (setting duplicates to `'VOID'`), then create `idx_invoice_unique_active_period`, `idx_service_catalog_org_default_code`, `idx_service_catalog_building_code`, `invoice.credit_offset_amount`, and `invoice_paid_lte_total_check`.
- Create `invoice_adjustment` and `credit_balance` (including `settlement_refund_amount BIGINT NOT NULL DEFAULT 0 CHECK (settlement_refund_amount >= 0 AND settlement_refund_amount <= amount)`), `invoice_line` reference columns, partial unique indexes, `GRANT ALL PRIVILEGES ... TO resihub_app`, `ENABLE` + `FORCE ROW LEVEL SECURITY`, `PRD 6.2` RLS policies, and the `046`-superset `rls_audit_log_select`.
- Implement `fn_resolve_invoice_adjustment`, upgraded `fn_apply_deposit_settlement_accounting` (reading `credit_applied_to_invoices`, `credit_applied_to_damages`, `credit_refund_amount` from `v_dep.settlement`, consuming `credit_balance` FIFO across `('ISSUED', 'ADJUSTED', 'PARTIALLY_PAID', 'OVERDUE')` open invoices where `v_paid_to_rent := LEAST(v_paid, v_rent_gross)`, marking `credit_refund_amount` as `'REFUNDED_IN_SETTLEMENT'` with `settlement_deposit_id = p_deposit_id` and `settlement_refund_amount`, then applying `p_covered_service_debt`), upgraded `fn_update_deposit_refund_bank_info` (`COALESCE((v_settlement->>'total_payout_amount')::bigint, (v_settlement->>'refund_amount')::bigint, 0) <= 0`), and `fn_restore_returned_settlement_credits(p_deposit_id, p_reason)`. Grant `EXECUTE` to `resihub_app`.
- In `api/test/remediationR01ToR24.test.js:424`, update `'CANCELLED'` -> `'TERMINATED'`.

- [ ] **Step 4: Run migration and verify tests pass**

Run: `cd api && npm run migrate && node --test --test-concurrency=1 test/migration047RlsAndRpc.test.js test/rbacPrdAlignment.test.js test/m06Phase2RlsAndDisputeWindow.test.js`
Expected: Migration `047` applies cleanly and all 3 suites PASS (`0` failures).

- [ ] **Step 5: Commit**

```bash
git add api/src/db/migrations/047_service_termination_invoice_adjustments_and_credit_balance.sql api/test/migration047RlsAndRpc.test.js api/test/remediationR01ToR24.test.js
git commit -m "feat(db): add migration 047 for TERMINATED/VOID/ADJUSTED, 4-eyes RPC, credit_balance, and M06 settlement RPC sync"
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
1. Pre-start cancellation (`start_date = '2026-12-01'`, `end_date = '2026-11-30'`, `status = 'TERMINATED'`) -> `activeDays = 0`, `amount = 0` in `'2026-11'`, `'2026-12'`, `'2027-01'`; `end_date = '2026-12-01'` -> `activeDays = 1` (`1/31` month).
2. Mid-month subscribe + same-month cancel (`start_date = '2026-11-10'`, `end_date = '2026-11-20'`, `unit_price = 300_000`, `qty = 1`) -> `activeDays = 11` (`11/30`), `amount = 110_000` (NOT `20/30 = 200_000`).
3. 5-month usage + mid-month-6 cancel (`start_date = '2026-01-01'`, `end_date = '2026-06-15'`, `status = 'TERMINATED'`, `unit_price = 200_000`, `qty = 2`) -> Months `'2026-01'`..`'2026-05'` each return `amount = 400_000` (`isProrated = false`), `'2026-06'` returns `200_000` (`15/30`, `isProrated = true`, `formulaMeta.active_days = 15`), `'2026-07'` returns `0`; `buildExpectedInvoiceSchedule` preserves all 5 first months at `rent + 400_000`.
4. `FR-065` 3-tier price priority (`CONTRACT_OVERRIDE` with `INTERNET_FIBER -> INTERNET` & `MANAGEMENT_FEE -> COMMON_SERVICE` aliases > `SUBSCRIPTION_SNAPSHOT` > `BUILDING_CATALOG` > `DEFAULT_CATALOG`), plus `lockedUnitPrice` override for already-`ISSUED` periods.
5. **Review Focus #3 pin:** `todayVietnamYmd(new Date('2026-11-01T18:30:00.000Z')) === '2026-11-02'` (`01:30` ICT next day); terminating on `'2028-02-29'` (`29/29`) or `'2026-07-31'` (`31/31`) yields `isProrated = false` and exact `unitPrice * quantity`.
6. `computeContractRentPeriodCharge` & `resolveContractLastActiveDay`: pre-move-in (`movedIn = false` -> `0 ₫`), mid-month (`12/30 * 12_000_000 = 4_800_000`), and natural half-open expiry (`'2027-01-01'` -> `lastActiveDayYmd = '2026-12-31'`).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && node --test --test-concurrency=1 test/serviceBillingAndSchedule.test.js`
Expected: FAIL (`Cannot find module '../src/services/serviceBilling.js'`).

- [ ] **Step 3: Implement `api/src/services/serviceBilling.js` and update `api/src/services/invoiceSchedule.js` & `api/src/services/contractTemplate.js`**

- Create `api/src/services/serviceBilling.js` implementing all exported functions from **Interfaces** per Spec Section `5.2`.
- Refactor `api/src/services/invoiceSchedule.js` to delegate subscription window/pricing/pro-rata math to `serviceBilling.js` (`includePendingApproval: true`), exclude `existingInvoices` only when `status IN ('VOID', 'CANCELLED')`, and preserve `TERMINATED` subscriptions across historical months `[start_date .. end_date]`.
- Confirm `api/src/services/contractTemplate.js:83-85` keeps `status === 'PENDING_APPROVAL' || status === 'ACTIVE'` (excluding `'TERMINATED'`, `'CANCELLED'`, `'REJECTED'`).

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
- Consumes: `serviceBilling.js` exports (Task 2); `roundVND` from `api/src/services/pricing.js`.
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
2. **Scenario 2 (`DRAFT` invoice):** Updating a `TERMINATED` subscription (`end_date = '2026-06-15'`) mutates ONLY the `'2026-06'` `DRAFT` `SERVICE` line to `15/30` Pro-rata (or deletes the line when `0 ₫`), leaves `'2026-01'`..`'2026-05'` `PAID` invoices untouched (`delta === 0`), releases surplus `credit_balance` if `subtotal_amount < credit_offset_amount`, and writes `UPDATE_DRAFT_INVOICE_LINES` `audit_log` (`before`/`after`, `AC-020.1`).
3. **Scenario 3 (Post-`ISSUED` invoice):** When `'2026-06'` invoice is `ISSUED` or `PAID`, `syncSubscriptionTerminationInvoicesInTx` leaves existing `invoice_line` rows immutable and inserts a `PENDING_APPROVAL` `invoice_adjustment` (`adjustment_target = 'SERVICE'`, `action_type = 'ADJUST'`, `delta_amount < 0`) using the locked `unit_price` on `invoice_line` (`FR-065`).
4. **Option `6A` (`closeContractBillingAndSubscriptionsInTx`):**
   - Pre-move-in (`!movedIn`): sets open subscriptions to `'TERMINATED'` (`end_date = start_date - 1`), auto-`VOID`s unpaid `0 ₫` `DRAFT` invoices across all periods, creates a `PENDING_APPROVAL` `VOID` `invoice_adjustment` for unpaid `ISSUED` invoices with `expectedTotal === 0`, and creates `SERVICE` + `RENT` `ADJUST` rows if `paid_amount > 0`.
   - Mid-month (`movedIn = true`, `explicitEndYmd = '2026-06-12'`): **only inspects invoices with `period >= '2026-06'`** (preserving `'2026-01'`..`'2026-05'` and any manual ad-hoc `SERVICE` lines where `subscription_id IS NULL` 100% untouched), creating `PENDING_APPROVAL` `ADJUST` rows for BOTH `RENT` and recurring `SERVICE` on an already-`ISSUED` `'2026-06'` invoice.
5. **Review Focus #4 re-sync pin:** Calling `syncSubscriptionTerminationInvoicesInTx` or `closeContractBillingAndSubscriptionsInTx` a second time while `PENDING_APPROVAL` rows exist computes `currentlyAccounted` including `PENDING_APPROVAL` `delta_amount` (`delta === 0`) and inserts zero duplicates.
6. `transferContractCreditsInTx` marks source `AVAILABLE`/`PARTIALLY_APPLIED` credits `'TRANSFERRED'` and creates matching `'AVAILABLE'` (`reason_type = 'TRANSFERRED_IN'`) credit on the destination contract.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && node --test --test-concurrency=1 test/invoiceLifecycleSync.test.js`
Expected: FAIL (`Cannot find module '../src/services/invoiceLifecycle.js'`).

- [ ] **Step 3: Implement `api/src/services/invoiceLifecycle.js`**

Implement all exported functions per Spec Sections `5.3.2`, `5.4`, and `5.5.2`:
- Lock target contract invoices (`status <> 'VOID'`, and `AND period >= lastActiveDayYmd.slice(0, 7)` when `movedIn === true` in `closeContractBillingAndSubscriptionsInTx`) with `FOR UPDATE`.
- Match subscription lines via `il.subscription_id = sub.id` (falling back for pre-`047` rows to `il.subscription_id IS NULL AND il.item_type = 'SERVICE' AND il.description ILIKE '%' || sub.service_name || '%'`, never touching unrelated ad-hoc `SERVICE` lines when `movedIn === true`).
- Compute `currentlyAccounted = originalLineSum + approvedAdjustmentSum + pendingAdjustmentSum`; skip whenever `delta >= 0`.
- On `DRAFT`: snapshot `before`, update/delete `SERVICE`/`RENT` lines, call `recalculateDraftInvoiceTotalsInTx` (releasing surplus `credit_balance` FIFO-reverse and transitioning to `'VOID'` when `autoVoidIfZero && subtotal === 0 && paid_amount === 0`), write `audit_log`.
- On post-`ISSUED`: insert `invoice_adjustment` (`VOID` when `expectedTotal === 0 && paid_amount === 0` and no non-zero metered/ad-hoc lines remain, else `ADJUST` per negative `delta`), write `CREATE_INVOICE_ADJUSTMENT` `audit_log`, and notify active `OWNER`s + other `MANAGER`s of `building_id` (or `SYS_ADMIN` when `NOT building_has_active_owner`).

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
- Modify: `api/src/routes/services.js:1-434`
- Modify: `api/src/routes/resident.js:15-265, 995-1360`
- Test: `api/test/serviceCancellationFlow.test.js`

**Interfaces:**
- Consumes: `serviceBilling.js` (Task 2), `invoiceLifecycle.js` (Task 3), `idempotencyGuard()` from `api/src/middleware/idempotency.js`, `getUserClient(req)` from `api/src/db/client.js`.
- Produces:
  - `POST /api/v1/service-catalog`, `PATCH /api/v1/service-catalog/:id` — `requireRole(['MANAGER'])`, `idempotencyGuard()` on `POST`, building-scoped or default catalog (`PRD 6.2`).
  - `POST /api/v1/service-subscriptions`, `PATCH /api/v1/service-subscriptions/:id` — `requireRole(['MANAGER'])`, `idempotencyGuard()` on BOTH `POST` and `PATCH`, 3-tier `FR-065` unit price resolution, `status: 'TERMINATED'` (`'CANCELLED'` alias accepted), `zero_usage?: boolean`, reject-cancel (`CANCELLATION_PENDING -> ACTIVE`), `audit_log` `before`/`after`, returns `{ message, data, invoice_sync }`.
  - `POST /api/v1/resident/services`, `PATCH /api/v1/resident/services/:id/cancel`, `PATCH /api/v1/resident/services/:id/withdraw-cancel`, `POST /api/v1/resident/payments/report` — all attached with `idempotencyGuard()` (`PRD 14.3`).
  - `GET /api/v1/resident/overview` (`resident.js:240, 251` `latestInvRes` filtering `i.status NOT IN ('DRAFT', 'VOID')`, `current_amount_due` over `('ISSUED', 'ADJUSTED', 'PARTIALLY_PAID', 'OVERDUE')`, returning `available_credit_balance`), `GET /api/v1/resident/invoices` (`resident.js:1007` filtering `i.status <> 'DRAFT'`), and `POST /api/v1/resident/payments/report` (`resident.js:1074` rejecting `inv.status IN ('DRAFT', 'VOID')` with `409 INVALID_STATUS` and `Number(inv.total_amount) - Number(inv.paid_amount) <= 0` with `409 ALREADY_PAID`).

- [ ] **Step 1: Write the failing API integration tests in `api/test/serviceCancellationFlow.test.js`**

Write integration tests asserting:
1. `SYS_ADMIN` gets `403` on `POST /api/v1/service-catalog` and `PATCH /api/v1/service-subscriptions/:id` (`PRD 6.2`), while `GET` succeeds.
2. Resident & Manager pre-`start_date` cancellation (`start_date` in next month) + `Idempotency-Key` replay: Resident `PATCH /api/v1/resident/services/:id/cancel` with `Idempotency-Key` sets `CANCELLATION_PENDING`, `end_date = start_date - 1`, `prorata_amount = 0` (replaying same key returns `Idempotent-Replayed: true`); `PATCH /withdraw-cancel` restores `ACTIVE`; cancelling again + Manager `PATCH /api/v1/service-subscriptions/:id` `{ status: 'TERMINATED' }` finalizes `0 ₫` and logs `audit_log`.
3. Mid-term cancellation across all 3 scenarios:
   - Scenario 1 (unbilled): `invoice_sync.scenario === 'UNBILLED'`.
   - Scenario 2 (`DRAFT`): `DRAFT` line updates to Pro-rata `roundVND`, `RESIDENT` cannot see `DRAFT` or `VOID` as `latest_invoice` on `/resident/overview`, on `/resident/invoices`, or on `/resident/payments/report`.
   - Scenario 3 (`PAID` Month `6` after 5 `PAID` months): Months `1..5` stay untouched, Month `6` gets a `PENDING_APPROVAL` `invoice_adjustment`, and mutating an already-`TERMINATED` subscription returns `409 INVALID_STATUS`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && node --test --test-concurrency=1 test/serviceCancellationFlow.test.js`
Expected: FAIL (`SYS_ADMIN` allowed / pre-start cancel `422` / `withdraw-cancel` `404` / `VOID` leaked in `latestInvRes`).

- [ ] **Step 3: Update `api/src/routes/services.js` and `api/src/routes/resident.js`**

- Refactor `api/src/routes/services.js` per **Interfaces** (using `getUserClient(req)` instead of `pool`/`adminPool` for business queries, `MANAGER`-only writes, `idempotencyGuard()`, `serviceBilling.js` 3-tier pricing & `todayVietnamYmd()`, and `syncSubscriptionTerminationInvoicesInTx`).
- Refactor `api/src/routes/resident.js` per **Interfaces** (attaching `idempotencyGuard()` to `POST /services`, `PATCH /services/:id/cancel`, `PATCH /services/:id/withdraw-cancel`, `POST /payments/report`; updating lines `240, 251, 1007, 1074, 1319, 1331` for `'DRAFT'`/`'VOID'`/`'TERMINATED'`; exposing `available_credit_balance` on `GET /overview`).

- [ ] **Step 4: Run new + existing service & resident tests**

Run: `cd api && node --test --test-concurrency=1 test/serviceCancellationFlow.test.js test/parkingPlatesSync.test.js test/residentOnboardingFlow.test.js`
Expected: PASS (`0` failures).

- [ ] **Step 5: Commit**

```bash
git add api/src/routes/services.js api/src/routes/resident.js api/test/serviceCancellationFlow.test.js
git commit -m "feat(services,resident): add pre-start 0 VND cancel, withdraw-cancel, idempotency, and TERMINATED 3-scenario sync"
```

---

### Task 5: Contract Early-Termination `6A` Sync, Renewal/Transfer Credit Carryover & Append-Only `daily.js` (`contracts.js` & `daily.js`)

**Files:**
- Modify: `api/src/routes/contracts.js:89-140, 2724-2795, 2960-2998, 3380-3435, 3600-3950, 4400-4820`
- Modify: `api/src/jobs/daily.js:1-375`
- Modify: `api/test/contractCreationFixes.test.js:626-631`
- Test: `api/test/contractEarlyTerminationBillingSync.test.js`

**Interfaces:**
- Consumes: `closeContractBillingAndSubscriptionsInTx`, `transferContractCreditsInTx` from `api/src/services/invoiceLifecycle.js` (Task 3); `todayVietnamYmd` from `api/src/services/serviceBilling.js` (Task 2).
- Produces:
  - Automatic `6A` `SERVICE` + `RENT` closure (`invoice_sync`) across all 6 contract-ending paths: `cancel` (`contracts.js:3415`), `terminate`, `terminate/approve`, `requests/:id/approve` (`TERMINATED_NOW`), `transfer-room`, and `runDailyJobs()` Steps 1a & 1b.
  - `transferContractCreditsInTx` wired in `POST /:id/transfer-room` (when `transfer_deposit !== false`) AND **inside `runActivationSideEffects(dbClient, contract, ...)` (`contracts.js:2731`)** when `!matchedRsv && contract.parent_contract_id` so BOTH `MANAGER` `POST /:id/activate` (`client`) and `OWNER` `POST /:id/approve-price` (`adminClient`) carry over `credit_balance` from `parent_contract_id` without RLS errors.
  - `loadContractSubscriptionsAndSchedule` (`contracts.js:125`): filters `status <> 'VOID'` (and `AND status <> 'DRAFT'` when `req.user` is `RESIDENT`, `AC-003.2`), returns `available_credit_balance` and `pending_invoice_adjustments_count`.
  - Append-only `LATE_FEE` in `api/src/jobs/daily.js` Step 7 (`lines 227-305`): **removes `DELETE FROM invoice_line WHERE invoice_id = $1 AND item_type = 'LATE_FEE'`**, computes `net_existing_late_fee = COALESCE(SUM(il.amount) FILTER (WHERE il.item_type = 'LATE_FEE' OR il.formula_meta->>'adjusts_item_type' = 'LATE_FEE'), 0)`, checks `unpaid_principal = GREATEST(0, (i.total_amount - net_existing_late_fee) - i.paid_amount) > 0`, and **INSERTs** an append-only delta `LATE_FEE` line only when `deltaFee = expectedFee - net_existing_late_fee > 0`.

- [ ] **Step 1: Write the failing integration tests in `api/test/contractEarlyTerminationBillingSync.test.js`**

Write integration tests asserting:
1. Pre-move-in `POST /api/v1/contracts/:id/terminate` flips open subscriptions to `'TERMINATED'` (`0 ₫`), auto-`VOID`s unpaid `DRAFT` invoices, and creates a `PENDING_APPROVAL` `VOID` `invoice_adjustment` for unpaid `ISSUED` invoices.
2. Mid-month `POST /api/v1/contracts/:id/terminate` (`terminated_date = '2028-06-12'`) preserves `'2028-05'` (`PAID`) 100% and creates `PENDING_APPROVAL` `ADJUST` rows for BOTH `RENT` and `SERVICE` on `'2028-06'` (`PAID`).
3. Credit transfer across BOTH `transfer-room` (`transfer_deposit: true`) AND `renew` with `>10%` rent deviation activated by `OWNER` via `POST /api/v1/contracts/:id/approve-price` (`parent_contract_id` `credit_balance` -> `'TRANSFERRED'`, child contract -> `'AVAILABLE'`, `reason_type = 'TRANSFERRED_IN'`, zero RLS error).
4. `GET /api/v1/contracts/:id` as `RESIDENT` omits `DRAFT` and `VOID` invoices (`AC-003.2`).
5. **Review Focus #2 pin (`daily.js` Step 7 append-only `LATE_FEE`):**
   - Day 8 overdue (`3` chargeable days after 5 grace days) inserts `LATE_FEE` line `#1` (`300_000`); Day 10 overdue (`5` chargeable days) **keeps line `#1` intact** (`COUNT(LATE_FEE) === 2`) and appends delta line `#2` (`200_000`, total net late fee `500_000`).
   - After an approved adjustment reduces principal to `0` and neutralizes `-500_000` (`formula_meta.adjusts_item_type = 'LATE_FEE'`), re-running `runDailyJobs()` touches zero lines (`unpaid_principal === 0`, invoice stays `'ADJUSTED'` at `0 ₫`, never flipped to `'OVERDUE'`).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && node --test --test-concurrency=1 test/contractEarlyTerminationBillingSync.test.js`
Expected: FAIL (`DELETE FROM invoice_line` mutates old `LATE_FEE` row, `approve-price` renewal doesn't transfer `credit_balance`, `6A` not wired).

- [ ] **Step 3: Implement updates in `api/src/routes/contracts.js`, `api/src/jobs/daily.js`, and `api/test/contractCreationFixes.test.js:630`**

- Update `api/src/routes/contracts.js` per **Interfaces** (replacing `status <> 'CANCELLED'` at `:125` with `status <> 'VOID'`, subscription `'CANCELLED'` at `:3415` with `'TERMINATED'` while preserving `contract.status = 'CANCELLED'` at `:3410`, wiring `closeContractBillingAndSubscriptionsInTx` into all 5 route termination/transfer paths, and wiring `transferContractCreditsInTx` in `transfer-room` + `runActivationSideEffects`).
- Update `api/src/jobs/daily.js` per **Interfaces** (`Asia/Ho_Chi_Minh` dates, Steps 1a & 1b `closeContractBillingAndSubscriptionsInTx`, Steps 6 & 7 `'ADJUSTED'` filter with `paid_amount < total_amount`, and append-only `LATE_FEE` delta insertion with `receivable.amount` sync and zero `DELETE`/`UPDATE` on `invoice_line`).
- Update `api/test/contractCreationFixes.test.js:630` (`'CANCELLED'` -> `'TERMINATED'`).

- [ ] **Step 4: Run new + existing contract & daily job test suites**

Run: `cd api && node --test --test-concurrency=1 test/contractEarlyTerminationBillingSync.test.js test/contractCreationFixes.test.js test/multiBuildingAndFutureContract.test.js`
Expected: PASS (`0` failures).

- [ ] **Step 5: Commit**

```bash
git add api/src/routes/contracts.js api/src/jobs/daily.js api/test/contractEarlyTerminationBillingSync.test.js api/test/contractCreationFixes.test.js
git commit -m "feat(contracts,jobs): wire 6A billing sync, renewal/transfer credit carryover, and append-only LATE_FEE"
```

---

### Task 6: Invoices `DRAFT` Line CRUD, Four-Eyes Post-`ISSUED` Approvals, Audit Endpoint & Payments Commutativity (`invoices.js` & `payments.js`)

**Files:**
- Modify: `api/src/routes/invoices.js:1-698`
- Modify: `api/src/routes/payments.js:1-520`
- Test: `api/test/invoiceFourEyesAndCreditBalance.test.js`

**Interfaces:**
- Consumes: `fn_resolve_invoice_adjustment` (Task 1), `serviceBilling.js` (Task 2), `invoiceLifecycle.js` (Task 3), `checkFourEyesOrWarn` & `roundVND` from `api/src/services/pricing.js`, `idempotencyGuard()` from `api/src/middleware/idempotency.js`.
- Produces:
  - Exhaustive `'VOID'` / `'DRAFT'` query updates in `api/src/routes/invoices.js`: `:109` (`inv.status <> 'VOID'`), `:173` (`i2.status <> 'VOID'`), `:206, 230` (`TERMINATED` overlap via `serviceBilling.js`), `:412` (`!['DRAFT', 'VOID'].includes(r.status)` so `DRAFT` never inflates list summary totals), `:593, 612, 693` (`VOID` / `ADJUSTED`), plus graceful catch of `err.code === '23505'` on `idx_invoice_unique_active_period` in `generateInvoicesCore` (skipping concurrent duplicate period instead of `500`).
  - `POST /api/v1/invoices/generate-batch` (`MANAGER` + `idempotencyGuard()`): FIFO `applyAvailableCreditsInTx` (`FR-033`), issuing as `'PAID'` with zero `receivable` when `auto_issue && total_amount === 0`.
  - `POST /api/v1/invoices/:id/lines` (`MANAGER` + `idempotencyGuard()`), `PATCH /api/v1/invoices/:id/lines/:lineId` (`MANAGER`), `DELETE /api/v1/invoices/:id/lines/:lineId` (`MANAGER`) — `DRAFT` only (`409 IMMUTABLE_AFTER_ISSUED`), writes `audit_log` `before`/`after` (`AC-020.1`).
  - `POST /api/v1/invoices/:id/issue` (`MANAGER` + `idempotencyGuard()`) & `PATCH /api/v1/invoices/:id/status` (`MANAGER` + `idempotencyGuard()`, normalizing `'CANCELLED' -> 'VOID'`, checking `paid_amount > 0 -> 409 ALREADY_PAID` **before** `inv.status !== 'DRAFT' -> 409 REQUIRES_FOUR_EYES_ADJUSTMENT`, enforcing `confirm_invoice_code === inv.invoice_code` when supplied on `DRAFT -> VOID`).
  - `POST /api/v1/invoices/:id/adjust` (`MANAGER` + `idempotencyGuard()`), `GET /api/v1/invoices/adjustments`, `POST /api/v1/invoices/:id/adjustments/:adjId/approve` & `/reject` (`OWNER`, `MANAGER`, `SYS_ADMIN` + `idempotencyGuard()`, executing `fn_resolve_invoice_adjustment`), and `GET /api/v1/invoices/:id/audit-logs` (returning chronological logs across `invoice`, `invoice_line`, `invoice_adjustment`, `payment`, `credit_balance`).
  - Payment distinction in `api/src/routes/payments.js`:
    - `POST /api/v1/payments` (`MANAGER` + `idempotencyGuard()`): rejects BOTH `inv.status IN ('DRAFT', 'VOID')` (`409 INVALID_STATUS`) AND `Number(inv.total_amount) - Number(inv.paid_amount) <= 0` (`409 ALREADY_PAID`).
    - `PATCH /api/v1/payments/:id/confirm` (`MANAGER` + `idempotencyGuard()`): rejects **ONLY** `inv.status IN ('DRAFT', 'VOID')`; if `remaining` shrank to `0` (or `< pay.amount`) due to an approved downward adjustment after the resident already transferred funds, `applyPaymentToInvoice` clamps `invoice.paid_amount = inv.total_amount`, sets `status = 'PAID'` (or keeps `'ADJUSTED'` when `total_amount === 0`), and mints `credit_balance` (`reason_type = 'OVERPAYMENT'`, `source_payment_id = pay.id`, `amount = currentPaid + payAmount - inv.total_amount`).

- [ ] **Step 1: Write the failing API integration tests in `api/test/invoiceFourEyesAndCreditBalance.test.js`**

Write integration tests asserting:
1. `DRAFT` line CRUD (`POST/PATCH/DELETE /invoices/:id/lines`) updates totals with `roundVND`, excludes `DRAFT` from `GET /invoices` summary debt totals, and logs `before`/`after` in `GET /invoices/:id/audit-logs`; post-`ISSUED` direct edits/voids return `409` (`IMMUTABLE_AFTER_ISSUED` / `ALREADY_PAID` / `REQUIRES_FOUR_EYES_ADJUSTMENT`).
2. Four-eyes RBAC matrix: self-approval -> `403 SELF_APPROVAL`; `SYS_ADMIN` on `VOP-A` -> `403`; `OWNER` of `VOP` and 2nd `MANAGER` (`mgr2VopA`) -> `200`; `OWNER` direct `POST /:id/adjust` -> `403`; `reject` frees the partial unique index for resubmission.
3. **Review Focus #1 & #4 (Order A vs Order B Commutativity) pin:**
   - **Order A:** Direct payment `10_400_000` -> `PAID` (subsequent direct `POST /payments` on same `PAID` invoice returns `409 ALREADY_PAID`), then `SERVICE` `-200_000` + `RENT` `-5_000_000` adjustments approved -> `total_amount = 5_200_000`, `paid_amount = 5_200_000`, total `credit_balance = 5_200_000`.
   - **Order B:** Resident reports `10_400_000` bank transfer (`PENDING_CONFIRMATION`) while invoice is `ISSUED`, then `SERVICE` `-200_000` + `RENT` `-5_000_000` (or full `-10_400_000` down to `0 ₫`) adjustments are approved, then Manager calls `PATCH /api/v1/payments/:id/confirm` -> succeeds (`200`) and produces identical `total_amount`, `paid_amount`, and `credit_balance` as Order A!
4. Next-period `POST /invoices/generate-batch` with `Idempotency-Key` auto-offsets `credit_balance` FIFO (`credit_offset_amount`), issues `0 ₫` net invoices directly as `'PAID'`, and restores `credit_balance` when an unpaid `DRAFT` is voided (`confirm_invoice_code`).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && node --test --test-concurrency=1 test/invoiceFourEyesAndCreditBalance.test.js`
Expected: FAIL (`404` on `/lines`, `/adjust`, `/audit-logs`, `credit_balance` not minted/offset).

- [ ] **Step 3: Implement route updates in `api/src/routes/invoices.js` and `api/src/routes/payments.js`**

Implement all routes and query filters in `api/src/routes/invoices.js` and `api/src/routes/payments.js` per **Interfaces** using `getUserClient(req)` (never `adminPool` for business queries).

- [ ] **Step 4: Run new + existing white-box/black-box invoice & payment suites**

Run: `cd api && node --test --test-concurrency=1 test/invoiceFourEyesAndCreditBalance.test.js test/remediationR01ToR24.test.js`
Expected: PASS (`0` failures).

- [ ] **Step 5: Commit**

```bash
git add api/src/routes/invoices.js api/src/routes/payments.js api/test/invoiceFourEyesAndCreditBalance.test.js
git commit -m "feat(invoices,payments): add DRAFT line CRUD, 4-eyes adjustments, Order A/B commutativity, and credit_balance offset"
```

---

### Task 7: M06 Two-Step Deposit Settlement (`credit_balance` Separation) & KPI / `RP-08` Reports (`deposits.js`, `reports.js`, `audit-logs.js`)

**Files:**
- Modify: `api/src/services/depositSettlement.js:1-331`
- Modify: `api/src/routes/deposits.js:110-270, 920-2420`
- Modify: `api/src/routes/reports.js:1-826`
- Modify: `api/src/routes/admin/audit-logs.js:1-215`
- Test: `api/test/settlementCreditAndKpiReports.test.js`

**Interfaces:**
- Consumes: upgraded `fn_apply_deposit_settlement_accounting`, `fn_update_deposit_refund_bank_info`, `fn_restore_returned_settlement_credits` (Task 1); `todayVietnamYmd` / `currentVietnamPeriod` (Task 2).
- Produces:
  - `computeFinalSettlementWithCredit({ heldBefore, availableCredit, serviceDebt, rentDebt, items })` in `api/src/services/depositSettlement.js`:
    - Step 1 (`credit_balance` — tenant's overpaid invoice cash, `FR-040`): offsets `rentDebt` first (matching `v_paid_to_rent := LEAST(v_paid, v_rent_gross)`), then `serviceDebt`, then excess damages (`Math.max(0, sumItems - heldBefore)`), yielding `credit_applied_to_invoices`, `credit_applied_to_damages`, and `credit_refund_amount`.
    - Step 2 (`deposit` — strict `FR-068` & `RP-07`): applies `heldBefore` ONLY to `items` and `remainingServiceDebt` (NEVER `remainingRentDebt`), yielding `deposit_refund_amount = Math.max(0, heldBefore - sumItems - remainingServiceDebt)`, `shortfall = Math.max(0, sumItems + remainingServiceDebt - heldBefore - credit_applied_to_damages)`, and `total_payout_amount = deposit_refund_amount + credit_refund_amount` (keeping `refund_amount = deposit_refund_amount`, `outstanding_debt = serviceDebt`, `rent_debt = rentDebt`).
  - `isSettlementSnapshotStale(savedSettlement, liveState)` in `depositSettlement.js`: compares `availableCredit` against `savedSettlement.available_credit` (when defined) in addition to `serviceDebt`, `rentDebt`, `heldAmount`, and `openInvoices`.
  - Full M06 Phase 2 compatibility in `api/src/routes/deposits.js`:
    - `calculateContractOpenDebts` (`:121`) & `FOR UPDATE` invoice locks (`:1291, 1919`): include `'ADJUSTED'` in `('ISSUED', 'ADJUSTED', 'PARTIALLY_PAID', 'OVERDUE')`.
    - `checkSettlementPreconditions`: adds `no_pending_invoice_adjustments` (`409 PENDING_INVOICE_ADJUSTMENT` when `invoice_adjustment.status = 'PENDING_APPROVAL'` exists on contract).
    - `POST /:id/settlement` & `POST /:id/settlement/approve`: `validateRefundBankInfo` validates `refundAmount: total_payout_amount`; `approve` commits immediately via `commitSettlementAccounting` ONLY when `total_payout_amount === 0`, and transitions to `'APPROVED_PENDING_PAYOUT'` (`accounting_committed_at = null`) whenever `total_payout_amount > 0`.
    - `POST /:id/payout`: allows payout when `BigInt(dep.amount_held || 0) > 0n || Math.round(Number(dep.settlement?.credit_refund_amount || 0)) > 0`; inserts `deposit_transaction(type = 'refund', amount = depositRefundAmount)` **ONLY when `depositRefundAmount > 0`** (`RP-07` purity!); finalizes `credit_refund_amount` via `fn_apply_deposit_settlement_accounting` + `audit_log`.
    - `POST /:id/payout-returned`: allows return when `totalPayoutAmt > 0`; inserts `deposit_transaction(type = 'refund_reversal')` and restores `deposit.amount_held = depositRefundAmount` ONLY when `depositRefundAmount > 0`; calls `fn_restore_returned_settlement_credits` when `creditRefundAmount > 0`.
    - `GET /:id/audit-logs` (`:2396`): includes `al.entity = 'credit_balance' AND al.entity_id IN (SELECT cb.id FROM credit_balance cb WHERE cb.settlement_deposit_id = $1::uuid)`.
  - `GET /api/v1/reports/dashboard` & `GET /api/v1/reports/summary` (`reports.js` via `getUserClient(req)`): excludes `'DRAFT'` and `'VOID'` (`:92, 93, 709-712`); computes `billed` (`SUM(total_amount + credit_offset_amount)`), `collected` (*Tiền thực thu* from `CONFIRMED` `payment` in `Asia/Ho_Chi_Minh`, `PRD 15.3`), `invoice_settled` (`SUM(paid_amount + credit_offset_amount)`, `PRD 15.1`), and `outstanding` (including `'ADJUSTED'`).
  - Unified `RP-08` in `api/src/routes/admin/audit-logs.js` (zero duplicate endpoint): exports `FINANCIAL_AUDIT_ENTITIES = ['invoice', 'invoice_line', 'invoice_adjustment', 'payment', 'credit_balance', 'receivable', 'deposit', 'deposit_transaction', 'reservation', 'service_subscription']` on `GET /api/v1/audit-logs?scope=financial` (JSON + `format=csv`); allows `SYS_ADMIN` & `OWNER` on all scopes and `MANAGER` specifically when `scope === 'financial'` (returning `403` for `MANAGER` when `scope !== 'financial'`).

- [ ] **Step 1: Write the failing settlement & KPI report tests in `api/test/settlementCreditAndKpiReports.test.js`**

Write integration tests asserting:
1. `POST /api/v1/deposits/:id/settlement` returns `409 PENDING_INVOICE_ADJUSTMENT` while an `invoice_adjustment` is `PENDING_APPROVAL`, and `409 SETTLEMENT_SNAPSHOT_STALE` on `approve`/`payout` if `available_credit` changes after submission.
2. **Review Focus #5 pins:**
   - **Case A (`total_payout_amount === 0` approved by `OWNER`):** `heldBefore = 5_000_000`, `availableCredit = 2_000_000`, `rentDebt = 3_000_000`, `serviceDebt = 1_500_000`, `DAMAGE = 3_500_000` -> Step 1 `credit_balance` pays `2_000_000` of `rentDebt` (leaving `1_000_000` `RECEIVABLE_AFTER_MOVE_OUT` rent debt); Step 2 `deposit` deducts `3_500_000` damage + `1_500_000` service debt (`total_payout_amount = 0`); `OWNER` approves immediately -> `DEDUCTED_FULL` with zero RLS error!
   - **Case B (Damages consume 100% of deposit `deposit_refund_amount = 0`, while `credit_refund_amount = 1_800_000 > 0`):** `heldBefore = 6_000_000`, `DAMAGE = 6_000_000`, `availableCredit = 1_800_000`, zero debt -> `approve` transitions to `'APPROVED_PENDING_PAYOUT'` (`total_payout_amount = 1_800_000`); Resident updates bank account via `PATCH /:id/bank-info` (`200`); Manager executes `POST /:id/payout` with UNC -> status becomes `'DEDUCTED_FULL'`, `credit_balance.status === 'REFUNDED_IN_SETTLEMENT'`, AND `deposit_transaction` has ONLY the `6_000_000` `deduct` row (`0` `refund` rows, so `RP-07` ledger `closing_held === 0` with zero distortion!); `POST /:id/payout-returned` -> `'RETURNED'` (restores `credit_balance`) -> re-issue `POST /:id/payout` -> `'DEDUCTED_FULL'` again!
3. KPI Reports (`GET /api/v1/reports/dashboard` & `/summary`): M1 (`10M` paid, `-2M` adjusted -> `2M` credit) + M2 (`10M` subtotal, `2M` credit offset, `8M` cash paid in M2) -> M1 `billed = 8M`, M2 `billed = 10M`, M2 `collected = 8M` (*Tiền thực thu*, `PRD 15.3`), M2 `invoice_settled = 10M` (`PRD 15.1`), `DRAFT`/`VOID` excluded.
4. `GET /api/v1/audit-logs?scope=financial` (`&format=csv`) returns all 10 `FINANCIAL_AUDIT_ENTITIES` for `OWNER` and building-scoped `MANAGER`, while `GET /api/v1/audit-logs?limit=5` (without `scope=financial`) still returns `403` for `MANAGER`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && node --test --test-concurrency=1 test/settlementCreditAndKpiReports.test.js`
Expected: FAIL (`no_pending_invoice_adjustments` missing, `deposit_refund_amount = 0` + `credit_refund_amount > 0` rejected at `/bank-info` & `/payout`, `scope=financial` `403` for `MANAGER`).

- [ ] **Step 3: Implement updates in `depositSettlement.js`, `deposits.js`, `reports.js`, and `admin/audit-logs.js`**

Implement all settlement, payout, `payout-returned`, `RP-07`-safe ledger, KPI, and `RP-08` updates per **Interfaces** and Spec Sections `5.5.3`–`5.5.4`.

- [ ] **Step 4: Run new + all existing M06 & white-box regression suites**

Run: `cd api && node --test --test-concurrency=1 test/settlementCreditAndKpiReports.test.js test/depositCollectAndRefund.test.js test/m06Phase1P0Fixes.test.js test/m06Phase2OwnerApprovalAndEscalation.test.js test/m06Phase2PayoutAndReturnedFlow.test.js test/m06Phase3P2Features.test.js test/fullWebsiteWhiteBlackBox.test.js`
Expected: PASS (`0` failures across every single M06 and white-box test!).

- [ ] **Step 5: Commit**

```bash
git add api/src/services/depositSettlement.js api/src/routes/deposits.js api/src/routes/reports.js api/src/routes/admin/audit-logs.js api/test/settlementCreditAndKpiReports.test.js
git commit -m "feat(settlement,reports): integrate credit_balance with M06 2-step payout, PRD 15.1-15.3 KPIs, and 10-entity RP-08"
```

---

### Task 8: Frontend Billing/RBAC Helpers & Admin/Owner Services + Invoices UI (`PRD 8.2`, `16.1`, `16.2`)

**Files:**
- Create: `frontend/src/utils/billing.js`
- Modify: `frontend/src/constants/statuses.js:1-175`
- Modify: `frontend/src/services/api.js:1-79`
- Modify: `frontend/src/hooks/usePermission.js:25-52`
- Modify: `frontend/src/services/invoices.service.js:1-20`
- Modify: `frontend/src/services/services.service.js:1-20`
- Modify: `frontend/src/pages/admin/services/ServiceCatalogPage.jsx`
- Modify: `frontend/src/pages/admin/services/SubscriptionsPage.jsx`
- Modify: `frontend/src/pages/admin/invoices/InvoicesPage.jsx`
- Modify: `frontend/src/pages/admin/invoices/InvoiceDetailPage.jsx`
- Test: `api/test/frontendBillingHelpers.test.js`

**Interfaces:**
- Consumes: `createIdempotencyKey`, `withIdempotency` from `frontend/src/utils/idempotency.js`; backend endpoints from Tasks 4 & 6.
- Produces:
  - `frontend/src/utils/billing.js` (re-exporting `createIdempotencyKey` & `withIdempotency` from `./idempotency.js` — zero duplicate implementation!):
    - `roundVND(amount)`
    - `todayVietnamYmd(now)`
    - `previewSubscriptionProrata({ unitPrice, quantity, startDate, endDate })`
    - `canConfirmInvoiceVoid(typedCode, expectedInvoiceCode, reason)`
    - `canActorApproveInvoiceAdjustment({ currentUserId, roleCodes, adjustment, hasBuildingOwner })`
  - `frontend/src/services/api.js`: Axios request interceptor auto-attaching `Idempotency-Key` (`createIdempotencyKey()`) on mutating `POST`/`PATCH` requests to `/api/v1/invoices`, `/api/v1/payments`, `/api/v1/service-catalog`, `/api/v1/service-subscriptions`, `/api/v1/contracts`, `/api/v1/deposits`, and `/api/v1/resident` when not already set (preserving the key across `401` refresh retries).
  - `frontend/src/hooks/usePermission.js`: `canManageServiceCatalog: isManager`, `canManageServices: isManager`, `canManageInvoices: isManager`, `canManagePayments: isManager`, `canApproveInvoiceAdjustments: isOwner || isManager || isSysAdmin`, `canViewFinancialAuditLogs: isSysAdmin || isOwner || isManager`.
  - `invoicesService`: `addLine`, `updateLine`, `deleteLine`, `issue`, `createAdjustment`, `listAdjustments`, `approveAdjustment`, `rejectAdjustment`, `getAuditLogs`.

- [ ] **Step 1: Write failing unit tests for frontend billing, 2-step `VOID`, and 4-eyes helpers in `api/test/frontendBillingHelpers.test.js`**

Import `../../frontend/src/utils/billing.js` and `../../frontend/src/constants/statuses.js` in `node:test`, asserting:
1. `SUBSCRIPTION_STATUS.TERMINATED`, `INVOICE_STATUS.ADJUSTED`, `INVOICE_STATUS.VOID`, and `INVOICE_ADJUSTMENT_STATUS.PENDING_APPROVAL` exist alongside `CANCELLED` display fallback; `billing.js` reuses `createIdempotencyKey` from `frontend/src/utils/idempotency.js`.
2. `previewSubscriptionProrata` uses `todayVietnamYmd` and `roundVND` (`ROUND(x, -3)`), returns `0 ₫` (`activeDays = 0`) when `endDate < startDate`, and computes `[max(startDate, monthStart) .. endDate]` (`11/30` days for `10/11 -> 20/11`) matching `serviceBilling.js` 100%.
3. `canConfirmInvoiceVoid` returns `false` unless `String(typedCode || '').trim() === expectedInvoiceCode` AND `String(reason || '').trim().length > 0` (`PRD 16.2`).
4. `canActorApproveInvoiceAdjustment` returns `false` when `adjustment.status !== 'PENDING_APPROVAL'` or `String(currentUserId) === String(adjustment.created_by)` (4-eyes), returns `false` for `SYS_ADMIN`-only when `hasBuildingOwner === true`, and returns `true` for `OWNER`, 2nd `MANAGER`, or `SYS_ADMIN` when `hasBuildingOwner === false`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && node --test --test-concurrency=1 test/frontendBillingHelpers.test.js`
Expected: FAIL (`Cannot find module '../../frontend/src/utils/billing.js'`).

- [ ] **Step 3: Implement shared frontend helpers, `api.js` interceptor, and Admin/Owner Services + Invoices pages**

- Create `frontend/src/utils/billing.js`; update `statuses.js`, `api.js` (including `/api/v1/resident`), `usePermission.js`, `invoices.service.js`, and `services.service.js`.
- Update `ServiceCatalogPage.jsx` & `SubscriptionsPage.jsx` (`MANAGER`-only writes, pre-start `0 ₫` / `zero_usage` checkbox, *"Giữ lại dịch vụ (Từ chối hủy)"*, `invoice_sync` 3-scenario toast).
- Update `InvoicesPage.jsx` & `InvoiceDetailPage.jsx`:
  - `DRAFT` (`MANAGER`): inline add/edit/delete line controls + contextual *"Phát hành hóa đơn"* confirmation modal (`PRD 16.1`).
  - `VOID` (both `DRAFT` direct void and post-`ISSUED` `VOID` request): 2-step modal gated by `canConfirmInvoiceVoid` (`PRD 16.2`).
  - Post-`ISSUED`: *"Lập điều chỉnh / Hủy hóa đơn (4 mắt)"* modal (`MANAGER`), *"Chờ duyệt điều chỉnh"* filter, **Phê duyệt / Từ chối** buttons gated by `canActorApproveInvoiceAdjustment`, and inline **`Lịch sử / Kiểm toán`** tab (`PRD 8.2`) rendering `before`/`after` diffs from `invoicesService.getAuditLogs(id)`.

- [ ] **Step 4: Run helper unit tests and frontend lint/build check**

Run: `cd api && node --test --test-concurrency=1 test/frontendBillingHelpers.test.js && cd ../frontend && npm run lint && npm run build`
Expected: `frontendBillingHelpers.test.js` PASS, `oxlint` `0` errors, `vite build` succeeds cleanly.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/utils/billing.js frontend/src/constants/statuses.js frontend/src/services/api.js frontend/src/hooks/usePermission.js frontend/src/services/invoices.service.js frontend/src/services/services.service.js frontend/src/pages/admin/services/ServiceCatalogPage.jsx frontend/src/pages/admin/services/SubscriptionsPage.jsx frontend/src/pages/admin/invoices/InvoicesPage.jsx frontend/src/pages/admin/invoices/InvoiceDetailPage.jsx api/test/frontendBillingHelpers.test.js
git commit -m "feat(frontend): add billing/4-eyes helpers, DRAFT line editor, 2-step VOID confirm, and invoice audit tab"
```

---

### Task 9: Frontend Resident Portal, Contract Credit View, M06 Deposit Payout UI & KPI / `RP-08` Pages

**Files:**
- Modify: `frontend/src/services/resident.service.js:1-45`
- Modify: `frontend/src/pages/resident/tabs/ServicesTab.jsx`
- Modify: `frontend/src/pages/resident/tabs/InvoicesTab.jsx`
- Modify: `frontend/src/pages/admin/contracts/ContractDetailPage.jsx`
- Modify: `frontend/src/pages/admin/deposits/DepositsPage.jsx`
- Modify: `frontend/src/pages/admin/reports/ReportsPage.jsx`
- Modify: `frontend/src/pages/admin/audit/AuditLogsPage.jsx`

**Interfaces:**
- Consumes: `billing.js` & `statuses.js` (Task 8); backend endpoints from Tasks 4, 5, 6, 7; `auditService` (`GET /api/v1/audit-logs?scope=financial`).
- Produces:
  - `residentService.withdrawCancelService(id)` calling `PATCH /api/v1/resident/services/:id/withdraw-cancel`.
  - Resident `ServicesTab.jsx` (`0 ₫` pre-start cancel unlock + banner, `previewSubscriptionProrata`, *"Rút yêu cầu hủy"*, `'TERMINATED'` history filter) & `InvoicesTab.jsx` (`available_credit_balance` banner from `/api/v1/resident/overview`, `'ADJUSTED'`/`'VOID'` filters, `formula_meta` Pro-rata breakdown).
  - `ContractDetailPage.jsx` (`available_credit_balance` card + `'TERMINATED'`/`'VOID'`/`'ADJUSTED'` schedule badges).
  - `DepositsPage.jsx` (M06 two-step payout aware: displays `available_credit`, `credit_applied_to_invoices`, `credit_applied_to_damages`, `deposit_refund_amount`, `credit_refund_amount`, and `total_payout_amount` across `PENDING_APPROVAL`, `APPROVED_PENDING_PAYOUT`, UNC `payout` modal, and `RETURNED` bank-update/reissue flows; shows `PENDING_APPROVAL` `invoice_adjustment` precondition warning).
  - `ReportsPage.jsx` & `AuditLogsPage.jsx`: renders `billed` vs `collected` (*Tiền thực thu*, `PRD 15.3`) vs `invoice_settled` (`PRD 15.1`), adds `invoice_line`, `invoice_adjustment`, `credit_balance`, `service_subscription` to `ENTITY_OPTIONS` in `AuditLogsPage.jsx`, and links/surfaces `RP-08` CSV export via `/api/v1/audit-logs?scope=financial`.

- [ ] **Step 1: Extend `api/test/frontendBillingHelpers.test.js` with payout-display & resident status assertions**

Add pure helper tests in `api/test/frontendBillingHelpers.test.js` verifying a `resolveSettlementPayoutSummary(settlement)` helper exported from `frontend/src/utils/billing.js` (computing `{ depositRefund, creditRefund, totalPayout, requiresUncPayout: totalPayout > 0 }` including when `depositRefund === 0 && creditRefund > 0`).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && node --test --test-concurrency=1 test/frontendBillingHelpers.test.js`
Expected: FAIL (`resolveSettlementPayoutSummary is not a function`).

- [ ] **Step 3: Implement `resolveSettlementPayoutSummary` and update Resident, Contract, Deposit Payout, Reports, and Audit UI pages**

- Export `resolveSettlementPayoutSummary` in `frontend/src/utils/billing.js`.
- Update `resident.service.js`, `ServicesTab.jsx`, `InvoicesTab.jsx`, `ContractDetailPage.jsx`, `DepositsPage.jsx`, `ReportsPage.jsx`, and `AuditLogsPage.jsx` per **Interfaces** and Spec Section `5.6.2`–`5.6.3`.

- [ ] **Step 4: Run full verification gate (helper tests, frontend lint + Vite build, and full backend test suite)**

Run: `cd frontend && npm run lint && npm run build && cd ../api && npm test`
Expected: `oxlint` `0` errors, `vite build` succeeds cleanly, and `npm test` passes across all suites (`0` failures).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/utils/billing.js frontend/src/services/resident.service.js frontend/src/pages/resident/tabs/ServicesTab.jsx frontend/src/pages/resident/tabs/InvoicesTab.jsx frontend/src/pages/admin/contracts/ContractDetailPage.jsx frontend/src/pages/admin/deposits/DepositsPage.jsx frontend/src/pages/admin/reports/ReportsPage.jsx frontend/src/pages/admin/audit/AuditLogsPage.jsx api/test/frontendBillingHelpers.test.js
git commit -m "feat(frontend): complete resident 0 VND cancel, credit_balance banners, M06 2-step payout breakdown, and RP-08 UI"
```
