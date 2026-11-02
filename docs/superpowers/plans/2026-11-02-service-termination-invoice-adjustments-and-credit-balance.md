# Service Termination, Four-Eyes Invoice Adjustments & Credit Balance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver end-to-end PRD v2.0-compliant pre-start (`0 ₫`) and mid-term Pro-rata service cancellation (`TERMINATED`), strict 3-tier `FR-065` pricing (`is_price_locked`), early contract termination & future M06 room-transfer `RENT` + `SERVICE` invoice synchronization (`6A`), 3-scenario invoice lifecycle with DB-enforced Four-eyes approvals (`ADJUSTED` / `VOID`), `FR-039` multi-stage automated debt reminders, `credit_balance` ledger auto-offsetting + Four-eyes direct refunds (`FR-040`), and M06-compatible two-step deposit-separated move-out settlement (`RP-07` / `RP-08` / `.xlsx` `FR-058`) across PostgreSQL `FORCE ROW LEVEL SECURITY`, Express API, and React UI.

**Architecture:** Migration `048` (following M06 `044`–`047`) creates `invoice_adjustment` and `credit_balance` first, backfills historical `CONFIRMED` overpayments before clamping `invoice.paid_amount <= total_amount`, standardizes status enums (`TERMINATED`, `ADJUSTED`, `VOID`), adds `service_subscription.is_price_locked` (`FR-065`), enforces `Unique(contract_id, period)` on active invoices (`PRD 13.3`), hardens 2-layer `PRD 6.2` RLS (including `FORCE RLS` on `contract_service_price`, `'RETURNED'` in `rls_deposit_update`, and `'credit_balance'`/`'invoice'`/`'invoice_adjustment'` in `can_select_attachment`), and provides `SECURITY DEFINER SET search_path = public, pg_temp SET row_security = off` RPCs (`fn_get_finance_resource_scope`, `fn_lock_invoices_for_authorized_viewer` avoiding `FORCE RLS` `FOR UPDATE` `0`-row filtering for `RESIDENT`/`OWNER`, `fn_notify_building_finance_actors` supporting trusted `adminPool`/`adminClient` callers on `notification(content, payload)`, 4-eyes `fn_resolve_invoice_adjustment` & `fn_resolve_credit_refund`, and 4-pass M06 settlement RPCs). Two domain modules (`serviceBilling.js` for `Asia/Ho_Chi_Minh` Pro-rata, M06 room-transfer child `start_date - 1` half-open cutoff & strict 3-tier `FR-065` pricing; `invoiceLifecycle.js` for 3-scenario `DRAFT` / 4-eyes sync and safe `credit_balance` FIFO/rollover ledger) power service, resident, invoice (`skipped_contracts` + `DRAFT` refresh), payment/attachment/tenant-merge (`AC-016.1`), contract, `daily.js` (Step 5 final-period billing, Steps 6–7 append-only `LATE_FEE`, Step 8 `-3/0/+3/+7/+15` debt reminders), post-credit `remaining_service_debt` deposit settlement, and Dashboard/Reports/Audit `.xlsx` + `CSV` routes and React portals.

**Tech Stack:** Node.js (ESM), Express 4, PostgreSQL 16 (`pg` with session-variable `FORCE ROW LEVEL SECURITY` via `getUserClient(req)`), `node:test`, React 19, Vite 8, Tailwind CSS, Zustand, Axios.

**Spec:** `docs/superpowers/specs/2026-11-02-service-cancellation-and-invoice-recalc-design.md` (`v6`)

## Global Constraints

- Physical status codes (`PRD Mục 13.2`): `service_subscription.status IN ('PENDING_APPROVAL', 'ACTIVE', 'CANCELLATION_PENDING', 'TERMINATED', 'REJECTED')`; `invoice.status IN ('DRAFT', 'ISSUED', 'PARTIALLY_PAID', 'PAID', 'OVERDUE', 'ADJUSTED', 'VOID')`; normalize legacy input `'CANCELLED'` -> `'TERMINATED'` (subscriptions) or `'VOID'` (invoices) at both API and `BEFORE` trigger boundaries; do NOT rename `'CANCELLED'` on `contract`, `service_request`, `reservation`, or `announcement`.
- Timezone, rounding, M06 room-transfer cutoff & strict 3-tier pricing (`PRD Mục 10.3, 13.4`, `FR-013`, `FR-065`): all business `today` / period / aging / reminder checks use `Asia/Ho_Chi_Minh` (`todayVietnamYmd()` in JS, `(NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date` in SQL); all VND charges round to nearest thousand via `roundVND` (`ROUND(x, -3)`); `end_date < start_date` (`start_date - 1 day`) represents `0` active days (`0 ₫`); standard catalog subscriptions persist `is_price_locked = FALSE`; whenever a contract has an activated room-transfer child (`ch.parent_contract_id = c.id AND ch.is_room_transfer = TRUE AND ch.status NOT IN ('DRAFT', 'PENDING_APPROVAL', 'CANCELLED')`), ALWAYS derive `lastActiveDayYmd = addDaysYmd(ch.start_date, -1)` from `ch.start_date` rather than `c.terminated_at` (which `contracts.js:2850-2864` clamps to `today` on future transfers).
- Accounting & immutability invariants (`FR-034`, `FR-035`, `FR-040`, `FR-068`, `Mục 13.3`, `NFR-016`): NEVER `UPDATE` or `DELETE` existing `invoice_line` rows once `invoice.status <> 'DRAFT'` (and do NOT add superuser-blocking `BEFORE DELETE` triggers on `invoice`/`payment`/`invoice_adjustment`/`credit_balance` that would break `adminPool` `t.after` test cleanups); backfill historical overpayments into `credit_balance` BEFORE enforcing `0 <= paid_amount <= total_amount`; enforce `idx_invoice_unique_active_period` (`status <> 'VOID'`) and `receivable.amount > 0` (`WRITTEN_OFF` when `0 ₫`); apply cross-bucket negative spill before `RENT`-first `credit_offset_amount` allocation; compute `remaining_service_debt = Math.max(0, serviceDebt - credit_applied_to_service)` and `covered_service_debt = Math.min(remaining_service_debt, remainingDepositAfterItems)` so deposit settlement NEVER double-deducts `UTILITY_DEBT` already paid by `credit_balance` (`RP-07`, `FR-068`).
- `FORCE ROW LEVEL SECURITY`, RBAC & Idempotency (`PRD Mục 6.1–6.2, 14.3`, `NFR-008`, `FR-070`, `AC-003.2`, `AC-017.3`, `AC-019.1`): every `SECURITY DEFINER` function in Migration `048` MUST specify `SECURITY DEFINER SET search_path = public, pg_temp SET row_security = off` + `GRANT EXECUTE ... TO resihub_app`; `RESIDENT` and `OWNER` flows that lock invoices (`resident.js` payment report, `deposits.js` settlement approve/payout) MUST call `fn_lock_invoices_for_authorized_viewer` instead of raw `SELECT ... FROM invoice ... FOR UPDATE`; `fn_notify_building_finance_actors` MUST support trusted internal sessions (`get_current_user_id() IS NULL AND current_user <> 'resihub_app'`) and write exact `011_notifications.sql` columns `(org_id, user_id, title, content, type, payload)`; mutating financial/service endpoints (`POST`/`PATCH`/`DELETE`) MUST attach `idempotencyGuard()`.
- Workspace & UI test hygiene: migration is `048_service_termination_invoice_adjustments_and_credit_balance.sql`; NEVER revert uncommitted M06 working-tree changes; preserve `cancelTarget` + `<VehiclePlatesBadges plates={cancelTarget.vehicle_plates}` proximity (`<= 400` chars) in `ServicesTab.jsx` (`parkingPlatesUi.test.js:170-174`) and `row.note` inside `title="Dịch vụ đi kèm theo hợp đồng"` in `ContractDetailPage.jsx` (`contractCreationUi.test.js:104-107`).

## Review Focus

1. **PostgreSQL `FORCE RLS` compatibility (`SET row_security = off`, `fn_lock_invoices_for_authorized_viewer`, trusted `adminPool`/`adminClient` notifications, & `attachment` RLS):** Under `FORCE ROW LEVEL SECURITY`, raw `SELECT ... FROM invoice ... FOR UPDATE` evaluates `rls_invoice_modify` (`MANAGER`-only) and silently returns `0` rows for `RESIDENT` and `OWNER`, while `SECURITY DEFINER` RPCs without `SET row_security = off` fail with `42501`. `fn_lock_invoices_for_authorized_viewer` lets `RESIDENT` (`POST /api/v1/resident/payments/report`) and `OWNER` (`POST /api/v1/deposits/:id/settlement/approve`) lock readable non-`VOID` invoices safely; `fn_notify_building_finance_actors` handles both `resihub_app` and trusted `adminPool`/`adminClient` (`daily.js`, `contracts.js:3336`) into `notification(org_id, user_id, title, content, type, payload)`; `can_select_attachment` + `attachments.js` serve `'credit_balance'` refund proof images *(pinned in Task 1, Task 4, Task 5 & Task 7)*.
2. **Post-credit `remaining_service_debt` / `covered_service_debt` (`RP-07` zero double-deduction) + 4-pass sequential accounting & cross-bucket spill:** When `credit_balance` pays part or all of `serviceDebt` in Pass 2 (`availableCredit = 1_500_000`, `rentDebt = 0`, `serviceDebt = 1_500_000`, `heldBefore = 5_000_000`), `remaining_service_debt` is `0` and `covered_service_debt` MUST be `0` (`deposit_refund_amount = 5_000_000`, `0` `UTILITY_DEBT` `deposit_transaction` rows, `RP-07` `closing_held === 0` after payout — never deducting raw pre-credit `serviceDebt` from deposit!) *(pinned in Task 1 & Task 7)*.
3. **Future-dated M06 4-step room transfer (`newStart > today` where `contracts.js:2850-2864` clamps `terminated_at = today`), `FR-065` `is_price_locked` symmetry, & `contractTemplate.js` Điều 5 deduplication:** When `OWNER` approves a room transfer starting `'2028-06-15'`, `oldContract` schedule (`GET /contracts/:oldId`), single-contract `POST /invoices/generate-batch` (`{ contract_id: oldId, period: '2028-06' }`), and `checkSettlementPreconditions` (`endPeriod`) all read `ch.start_date` (`'2028-06-15'`) to bill `oldContract` for exact `14/30` days (`01/06–14/06/2028`), never clamping to `today` and never double-billing `'2028-06-15'` *(pinned in Task 2, Task 5, Task 6 & Task 7)*.
4. **Sequential 4-eyes adjustments, `credit_offset_amount` release, active/ended/`0`-deposit direct credit refund split/reject, Order A/B + standalone `receivable` overpayment, & historical overpayment backfill:** Migration `048` backfills historical overpayments before clamping `paid_amount <= total_amount`; `PATCH /invoices/:id/status` checks `paid_amount > 0 -> 409 ALREADY_PAID` before `confirm_invoice_code` (`fullWebsiteWhiteBlackBox.test.js:1403`); standalone `receivable_id` overpayments and Order B bank-transfer confirmations mint `credit_balance` identically; `tenants.js` merge transfers `credit_balance.tenant_id` (`FR-021`) *(pinned in Task 1 & Task 5)*.
5. **Automated `FR-039` multi-stage debt reminders (`-3/0/+3/+7/+15` days), `daily.js` Step 5 `excludeSettledDeposits` + append-only `LATE_FEE` (`FR-064`), `AC-016.1` UI aging buckets, & `FR-058` `.xlsx` exports:** `runDailyJobs()` Step 8 emits idempotent `PAYMENT_REMINDER` notifications + `SEND_DEBT_REMINDER` `audit_log` rows across `-3, 0, 3, 7, 15` days without duplicating on re-run; Step 7 preserves `FR-064` late-fee waivers append-only; `PaymentsPage.jsx`, `ReportsPage.jsx`, `DashboardPage.jsx`, and `AuditLogsPage.jsx` render `AC-016.1` buckets, `invoice_settled` vs net `collected`, 4-eyes queue KPIs, and `.xlsx` + `CSV` exports *(pinned in Task 6, Task 7, Task 8 & Task 9)*.

---

## File Structure

- **Database Migration (`048`):**
  - Create: `api/src/db/migrations/048_service_termination_invoice_adjustments_and_credit_balance.sql` — dynamic `pg_constraint` swaps, `invoice_adjustment` & `credit_balance` created BEFORE historical overpayment backfill & `invoice_paid_lte_total_check`, `service_subscription.is_price_locked` + `BEFORE INSERT` auto-lock trigger, `idx_invoice_unique_active_period`, legacy `'CANCELLED'` normalization `BEFORE` triggers, `FORCE ROW LEVEL SECURITY` on `invoice_adjustment`, `credit_balance`, and `contract_service_price`, 2-layer `PRD 6.2` RLS policies (`rls_service_catalog_select`, `rls_contract_service_price_modify`, `rls_service_sub_delete` from `042_idempotency_and_draft_services_rls.sql`, `'DRAFT'`-only `DELETE` on `invoice_line`, `'RETURNED'` in `rls_deposit_update`), `can_select_attachment` (`046`) extended for `'credit_balance'`/`'invoice'`/`'invoice_adjustment'`, 12-entity `rls_audit_log_select`, and `SECURITY DEFINER SET search_path = public, pg_temp SET row_security = off` RPCs (`fn_get_finance_resource_scope`, `fn_lock_invoices_for_authorized_viewer`, `fn_notify_building_finance_actors`, `fn_resolve_invoice_adjustment`, `fn_resolve_credit_refund`, 4-pass `fn_apply_deposit_settlement_accounting`, `fn_update_deposit_refund_bank_info`, `fn_restore_returned_settlement_credits`, `fn_recommit_returned_settlement_credits`).
  - Modify: `api/test/remediationR01ToR24.test.js:416-426` — update raw SQL subscription fixture `'CANCELLED'` -> `'TERMINATED'`.
- **Backend Domain Services:**
  - Create: `api/src/services/serviceBilling.js` — `Asia/Ho_Chi_Minh` date helpers, status normalizers, strict `FR-065` 3-tier price resolver (`is_price_locked` + `effective_from <= periodEndYmd` + `PARKING_MOTO` alias), subscription & contract `RENT` Pro-rata calculators with `roomTransferChildStartDate` (`newStart - 1`) half-open cutoff and `formula_meta`.
  - Modify: `api/src/services/invoiceSchedule.js:1-210` — preserve historical periods `1..N-1` for `TERMINATED` subscriptions, accept `roomTransferChildStartDate`, and support 3-tier pricing + `'VOID'` / `'ADJUSTED'`.
  - Modify: `api/src/services/contractTemplate.js:81-112` — register `codeKey` + canonical aliases in `consumedPriceCodes` for all subscriptions before `continue` so Loop `#3` never re-prints terminated services in Điều 5.
  - Create: `api/src/services/invoiceLifecycle.js` — `credit_balance` FIFO apply/release/safe-transfer helpers, `DRAFT` recalculation + empty-shell auto-`VOID` + `audit_log`, 3-scenario subscription sync, and `closeContractBillingAndSubscriptionsInTx` (`6A`).
- **Backend Routes & Jobs:**
  - Modify: `api/src/routes/services.js` — `MANAGER`-only writes, `getUserClient(req)` + `fn_get_finance_resource_scope`, `idempotencyGuard()`, `ORG_DEFAULT_SHARED_ACROSS_BUILDINGS` guard (`FR-070`), `audit_log`, `is_price_locked` + 3-tier pricing, pre-start `0 ₫` / mid-term `TERMINATED` + 3-scenario invoice sync.
  - Modify: `api/src/routes/resident.js` — `getUserClient(req)`, `idempotencyGuard()` on mutating routes, `fn_lock_invoices_for_authorized_viewer` on `POST /payments/report`, building-override catalog deduplication + `resolveServiceUnitPrice` (`is_price_locked = false`), pre-start `0 ₫` cancel, `PATCH /services/:id/withdraw-cancel`, `'DRAFT'`/`'VOID'`/`'ADJUSTED'` filters (`AC-003.2`), `available_credit_balance` on `/overview`.
  - Modify: `api/src/routes/invoices.js` — `MANAGER`-only writes, `'VOID'`/`'DRAFT'` filters, `contractId` (`NOT IN ('VOID', 'DRAFT')` existing-`DRAFT` refresh) + `excludeSettledDeposits` + `roomTransferChildStartDate` (`newStart - 1` cutoff) + `skipped_contracts` (`FR-033`, `AC-015.1`) + `CREATE_INVOICE` `audit_log` in `generateInvoicesCore`, `DRAFT` line CRUD (`idempotencyGuard()`), `issueDraftInvoiceInTx` (`0 ₫ -> 'PAID'`), `POST /:id/adjust` (incl. `'LATE_FEE'`), `GET /adjustments`, 3-arg `fn_resolve_invoice_adjustment` `/approve` & `/reject`, `GET /:id/audit-logs`.
  - Modify: `api/src/routes/payments.js`, `api/src/routes/attachments.js:75-105`, `api/src/routes/tenants.js:701-728` — `MANAGER`-only admin writes + `idempotencyGuard()` + `getUserClient(req)`, Order B + standalone `receivable_id` overpayment `credit_balance` minting, 4-eyes `credit_balance` refund endpoints (`'DISPUTED'` guard + `saveBase64Image` `'credit_balance'` proof attachment), `'credit_balance'`/`'invoice'`/`'invoice_adjustment'` in `attachments.js`, `credit_balance.tenant_id` merge in `tenants.js` (`FR-021`), and `GET /api/v1/receivables` `aging_summary_prd` (`AC-016.1`).
  - Modify: `api/src/routes/contracts.js` — `is_price_locked`, wire `closeContractBillingAndSubscriptionsInTx` (`6A`) across all 5 route paths (`cancel` `:3842`, `terminate` `:2429`, `terminate/approve` `:2580`, `requests/:id/approve` `:813`, and M06 room-transfer inside `runActivationSideEffects` `:2792-2958` with `isRoomTransfer: true`, `roomTransferChildStartDate: sDateStr`, `adjustmentCreatorId: contract.created_by`), wire `transferContractCreditsInTx`, pass `roomTransferChildStartDate` in `loadContractSubscriptionsAndSchedule` (`:89-145`), hide `DRAFT` from `RESIDENT`, expose `available_credit_balance` & `credit_balances`.
  - Modify: `api/src/jobs/daily.js` — `Asia/Ho_Chi_Minh` dates, Steps 1a & 1b `6A` + deferred renewal `transferContractCreditsInTx`, Step 5 `onlyOngoingContracts: false, excludeSettledDeposits: true`, Steps 6 & 7 `'ADJUSTED'` + `MARK_INVOICE_OVERDUE` / `ACCRUE_LATE_FEE` `audit_log` + append-only `LATE_FEE`, and **Step 8 `FR-039` multi-stage debt reminders (`-3, 0, 3, 7, 15` days + `SEND_DEBT_REMINDER` `audit_log`)**.
  - Modify: `api/src/services/depositSettlement.js`, `api/src/routes/deposits.js`, `api/src/routes/reports.js`, `api/src/routes/admin/audit-logs.js`, `api/test/m06Phase3P2Features.test.js:931-938` — post-credit `remaining_service_debt` & `covered_service_debt` (`RP-07` zero double-deduction), `fn_lock_invoices_for_authorized_viewer` on `approve`/`payout`, `roomTransferChildStartDate` in `unbilled_final_period`, net `collected` & `invoice_settled` & `pending_invoice_adjustments`/`pending_credit_refunds` KPIs, 12-entity `FINANCIAL_AUDIT_ENTITIES`, and **`format=xlsx` (`toXlsxBuffer`, `FR-058`)** on `audit-logs.js` and `reports.js`.
- **Frontend:**
  - Task 8 (Core Helpers + Services, Invoices, Payments `AC-016.1` & Admin Notifications UI): `frontend/src/utils/billing.js`, `frontend/src/constants/statuses.js`, `frontend/src/services/api.js`, `frontend/src/hooks/usePermission.js`, `frontend/src/services/invoices.service.js`, `frontend/src/services/payments.service.js`, `frontend/src/services/services.service.js`, `frontend/src/pages/admin/services/ServiceCatalogPage.jsx`, `frontend/src/pages/admin/services/SubscriptionsPage.jsx`, `frontend/src/pages/admin/invoices/InvoicesPage.jsx`, `frontend/src/pages/admin/invoices/InvoiceDetailPage.jsx`, `frontend/src/pages/admin/payments/PaymentsPage.jsx`, `frontend/src/pages/admin/notifications/NotificationsPage.jsx`.
  - Task 9 (Resident Portal + Contract Credit Refund, Deposit `unbilled_final_period` / 2-Step Payout & Dashboard/Reports/Audit `.xlsx` UI): `frontend/src/services/resident.service.js`, `frontend/src/services/reports.service.js`, `frontend/src/services/audit.service.js`, `frontend/src/pages/resident/tabs/ServicesTab.jsx`, `frontend/src/pages/resident/tabs/InvoicesTab.jsx`, `frontend/src/pages/resident/tabs/OverviewTab.jsx`, `frontend/src/pages/resident/tabs/NotificationsTab.jsx`, `frontend/src/pages/admin/contracts/ContractDetailPage.jsx`, `frontend/src/pages/admin/deposits/DepositsPage.jsx`, `frontend/src/pages/admin/dashboard/DashboardPage.jsx`, `frontend/src/pages/admin/reports/ReportsPage.jsx`, `frontend/src/pages/admin/audit/AuditLogsPage.jsx`.

---

### Task 1: Migration `048`, `FORCE RLS`-Safe 2-Layer Policies, Historical Overpayment Backfill & Self-Contained 4-Eyes / 4-Pass Settlement RPCs

**Files:**
- Create: `api/src/db/migrations/048_service_termination_invoice_adjustments_and_credit_balance.sql`
- Modify: `api/test/remediationR01ToR24.test.js:416-426`
- Test: `api/test/migration048RlsAndRpc.test.js`

**Interfaces:**
- Consumes: SQL helpers `is_org_admin()`, `is_owner()`, `is_manager()`, `is_resident()`, `get_current_user_id()`, `get_current_user_org_id()`, `get_user_assigned_buildings()`, `get_owner_building_ids()`, `get_manager_building_ids()`, `get_resident_contract_ids()`, `get_resident_tenant_ids()`, `building_has_active_owner(UUID)` (`041`), `rls_service_sub_delete` (`042_idempotency_and_draft_services_rls.sql`), `system_setting` (`key = 'approval_config'`), `notification(org_id, user_id, title, content, type, payload)` (`011`), M06 settlement RPCs & `rls_deposit_update` (`045`), `rls_audit_log_select` & `can_select_attachment` (`046`), and M06 room-transfer schema (`047`).
- Produces:
  - `service_catalog` partial unique indexes `idx_service_catalog_org_default_code` (`WHERE building_id IS NULL`) & `idx_service_catalog_building_code` (`WHERE building_id IS NOT NULL`).
  - `service_subscription.status` enum `'TERMINATED'`, `service_subscription.is_price_locked BOOLEAN NOT NULL` (backfilled & auto-populated when `NULL` via `trg_normalize_legacy_subscription_status`).
  - Tables `invoice_adjustment` (`adjustment_target IN ('SERVICE', 'RENT', 'LATE_FEE', 'MANUAL')`) and `credit_balance` (`parent_credit_id UUID`, `settlement_refund_amount BIGINT NOT NULL DEFAULT 0`, `refund_meta JSONB`, `refunded_at TIMESTAMPTZ`, `status IN ('AVAILABLE', 'PARTIALLY_APPLIED', 'APPLIED', 'PENDING_DIRECT_REFUND', 'REFUNDED_DIRECT', 'PENDING_SETTLEMENT_PAYOUT', 'REFUNDED_IN_SETTLEMENT', 'TRANSFERRED', 'VOID')`) created **BEFORE** clamping `invoice.paid_amount`, backfilling historical `CONFIRMED` overpayments (`payment.overpayment_amount > 0` or `invoice.paid_amount > invoice.total_amount` with `invoice.contract_id IS NOT NULL`) into `credit_balance` (`OVERPAYMENT`, `ON CONFLICT DO NOTHING`) BEFORE clamping `invoice.paid_amount = LEAST(GREATEST(0, paid_amount), GREATEST(0, total_amount))` and adding `invoice_paid_lte_total_check`.
  - `invoice.status` enums `'ADJUSTED'`, `'VOID'` + `trg_normalize_legacy_invoice_status`, `invoice.credit_offset_amount BIGINT NOT NULL DEFAULT 0`, `idx_invoice_unique_active_period ON invoice(contract_id, period) WHERE contract_id IS NOT NULL AND status <> 'VOID'`, and `invoice_line` columns `subscription_id UUID`, `credit_id UUID`, `adjustment_id UUID`, `formula_meta JSONB`.
  - `ENABLE` + `FORCE ROW LEVEL SECURITY` on `invoice_adjustment`, `credit_balance`, and `contract_service_price` (`ALTER TABLE contract_service_price FORCE ROW LEVEL SECURITY;`); 2-layer `PRD 6.2` RLS policies (`rls_invoice_modify` `INSERT`/`UPDATE` `MANAGER`-only, `rls_invoice_line_modify` `DELETE` allowed ONLY when parent `invoice.status = 'DRAFT'`, zero `BEFORE DELETE` superuser-blocking triggers, `rls_service_catalog_select`, `rls_contract_service_price_modify`, `rls_service_sub_delete`, `'RETURNED'` added to `rls_deposit_update` `WITH CHECK`, `can_select_attachment` extended for `'credit_balance'`, `'invoice'`, `'invoice_adjustment'` preserving `046` `person` PII block, and 12-entity `rls_audit_log_select`).
  - All `SECURITY DEFINER` RPCs declared with **`SECURITY DEFINER SET search_path = public, pg_temp SET row_security = off`** + `GRANT EXECUTE ... TO resihub_app`:
    - `fn_get_finance_resource_scope(p_entity TEXT, p_id UUID) RETURNS TABLE(resource_id UUID, org_id UUID, building_id UUID)`
    - `fn_lock_invoices_for_authorized_viewer(p_contract_id UUID DEFAULT NULL, p_invoice_id UUID DEFAULT NULL) RETURNS SETOF invoice`
    - `fn_notify_building_finance_actors(p_building_id UUID, p_type TEXT, p_title TEXT, p_message TEXT, p_metadata JSONB DEFAULT '{}'::jsonb, p_include_resident_user_id UUID DEFAULT NULL) RETURNS INT` (supports both `resihub_app` callers and trusted internal sessions `get_current_user_id() IS NULL AND current_user <> 'resihub_app'`; inserts into `notification(org_id, user_id, title, content, type, payload)`)
    - `fn_resolve_invoice_adjustment(p_adjustment_id UUID, p_decision TEXT, p_rejection_reason TEXT DEFAULT NULL) RETURNS JSONB`
    - `fn_resolve_credit_refund(p_credit_id UUID, p_decision TEXT, p_rejection_reason TEXT DEFAULT NULL) RETURNS JSONB`
    - `fn_apply_deposit_settlement_accounting(p_deposit_id UUID, p_covered_service_debt BIGINT, p_uncovered_items_shortfall BIGINT) RETURNS VOID`
    - `fn_update_deposit_refund_bank_info(p_deposit_id UUID, p_bank_info JSONB) RETURNS deposit`
    - `fn_restore_returned_settlement_credits(p_deposit_id UUID, p_reason TEXT) RETURNS INT`
    - `fn_recommit_returned_settlement_credits(p_deposit_id UUID) RETURNS INT`

- [ ] **Step 1: Write the failing schema, `FORCE RLS` & RPC integration test in `api/test/migration048RlsAndRpc.test.js`**

Write `node:test` suite connecting via `adminPool` and `appPool` (`resihub_app` with `set_config('app.current_user_id', ...)`) asserting:
1. `service_catalog` partial unique indexes, `service_subscription.is_price_locked` trigger auto-lock, `idx_invoice_unique_active_period` (`23505` on active duplicate, allowed after `'VOID'`), AND `adminPool` `DELETE` cleanup on `invoice` / `credit_balance` / `invoice_adjustment` succeeds cleanly without trigger errors.
2. **Review Focus #1 `FORCE RLS` pins:**
   - `RESIDENT` `SELECT` on `invoice` returns `0` rows on `'DRAFT'` (`AC-003.2`) and `1` row on `'ISSUED'`; calling `SELECT * FROM fn_lock_invoices_for_authorized_viewer(NULL, issuedInvoiceId)` as `RESIDENT` and `SELECT * FROM fn_lock_invoices_for_authorized_viewer(contractId, NULL)` as `OWNER` each lock and return `1` row (whereas raw `SELECT * FROM invoice WHERE id = $1 FOR UPDATE` returns `0` rows under `FORCE RLS`!), while `fn_lock_invoices_for_authorized_viewer` returns `0` rows on `'DRAFT'` for `RESIDENT` and `0` rows on an unassigned building for `OWNER`/`MANAGER`.
   - Calling `fn_notify_building_finance_actors` both as `MANAGER` via `appPool` AND as a trusted internal caller (`adminPool` with `app.current_user_id` unset) inserts valid rows into `notification(org_id, user_id, title, content, type, payload)` without `42501` or column-mismatch errors.
   - `can_select_attachment` allows `OWNER`, assigned `MANAGER`, and the contract's `RESIDENT` to read an `attachment` with `owner_entity = 'credit_balance'`, blocks another building's `MANAGER`/`RESIDENT`, and still blocks `OWNER` from reading `owner_entity = 'person'` (`046` PII guard preserved).
   - `SYS_ADMIN` and `OWNER` direct `INSERT`/`UPDATE`/`DELETE` on `service_catalog`, `service_subscription`, `contract_service_price` (`FORCE RLS` verified!), `invoice`, `invoice_line`, `payment`, `receivable`, `credit_balance` are blocked by RLS; `MANAGER` can `DELETE` `invoice_line` on `'DRAFT'` invoice but is blocked by RLS from `DELETE` on `'ISSUED'` `invoice_line`; `OWNER` and `MANAGER` read all 12 financial entities in `rls_audit_log_select`.
3. **Review Focus #4 RPC pins (`fn_resolve_invoice_adjustment` & `fn_resolve_credit_refund`):**
   - 3-arg `fn_resolve_invoice_adjustment` & `fn_resolve_credit_refund` enforce 4-eyes from `system_setting('approval_config')` (`SELF_APPROVAL` error when `false`, `SELF_APPROVAL_WARNING` `audit_log` when `true`), block `SYS_ADMIN` when `building_has_active_owner(building_id)` is `true`, allow `SYS_ADMIN` when `owner_id IS NULL`, and execute cleanly as `OWNER` under `FORCE RLS` (`SET row_security = off`).
   - Sequential downward `ADJUST`s (`-100_000`, `-5_000_000`) on `10_200_000` `PAID` invoice mint exact `5_100_000` `credit_balance`; `+150_000` upward `ADJUST` on `0 ₫` `'PAID'` invoice UPSERTs `OPEN` `receivable`; `-400_000` `ADJUST` on unpaid `ISSUED` invoice (`subtotal = 500_000, credit_offset_amount = 300_000`) releases `200_000` back to `credit_balance` with `credit_id = v_credit_row.id`; `LATE_FEE` waiver (`-200_000` on `300_000`) appends `formula_meta.adjusts_item_type = 'LATE_FEE'` and principal-zero neutralization appends only `-100_000`; `PARTIALLY_APPLIED` credit split/reject merges back into parent and approve sets `'REFUNDED_DIRECT'` (`refunded_at IS NOT NULL`).
4. **Review Focus #2 DB pins (4-pass sequential accounting + cross-bucket negative spill):**
   - Multi-invoice 4-pass test (`'2026-05'` `SERVICE = 1M`, `'2026-06'` `RENT = 4M`, `available_credit = 1M`, `p_covered_service_debt = 1M`): Pass 1 applies `1M` credit to Invoice 2 `RENT` and Pass 4 applies `1M` deposit to Invoice 1 `SERVICE`; when `available_credit = 1_500_000`, `RENT = 0`, `SERVICE = 1_500_000`, and `p_covered_service_debt = 0` (post-credit `remaining_service_debt = 0`), Pass 2 pays `1_500_000` `SERVICE` from `credit_balance` and Pass 4 deducts `0` from deposit; cross-bucket spill (`MANUAL -1.5M` on `SERVICE 0.5M + RENT 10M`) yields `service_effective = 0, rent_effective = 9M`; `fn_update_deposit_refund_bank_info`, `fn_restore_returned_settlement_credits`, and `fn_recommit_returned_settlement_credits` succeed under `FORCE RLS`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && node --test --test-concurrency=1 test/migration048RlsAndRpc.test.js`
Expected: FAIL (`relation "invoice_adjustment" does not exist` / `function fn_lock_invoices_for_authorized_viewer does not exist`).

- [ ] **Step 3: Write `api/src/db/migrations/048_service_termination_invoice_adjustments_and_credit_balance.sql` and update `api/test/remediationR01ToR24.test.js:424`**

Implement Spec Section `5.1` in `048_service_termination_invoice_adjustments_and_credit_balance.sql` (following exact DDL order: create `invoice_adjustment` & `credit_balance` -> backfill historical overpayments -> clamp `invoice.paid_amount` -> constraints/indexes -> `FORCE RLS` & policies -> `SET row_security = off` RPCs) and update `'CANCELLED'` -> `'TERMINATED'` at `api/test/remediationR01ToR24.test.js:424`.

- [ ] **Step 4: Run migration and verify tests pass**

Run: `cd api && npm run migrate && node --test --test-concurrency=1 test/migration048RlsAndRpc.test.js test/rbacPrdAlignment.test.js test/m06Phase2RlsAndDisputeWindow.test.js test/m06TransferAndReservationRls.test.js`
Expected: Migration `048` applies cleanly and all 4 suites PASS (`0` failures).

- [ ] **Step 5: Commit**

```bash
git add api/src/db/migrations/048_service_termination_invoice_adjustments_and_credit_balance.sql api/test/migration048RlsAndRpc.test.js api/test/remediationR01ToR24.test.js
git commit -m "feat(db): add migration 048 with FORCE RLS-safe RPCs, credit_balance backfill, and 4-pass settlement sync"
```

---

### Task 2: Shared `Asia/Ho_Chi_Minh` Pro-Rata, Future Room-Transfer Cutoff & Strict 3-Tier Pricing Engine (`serviceBilling.js`, `invoiceSchedule.js`, `contractTemplate.js`)

**Files:**
- Create: `api/src/services/serviceBilling.js`
- Modify: `api/src/services/invoiceSchedule.js:1-210`
- Modify: `api/src/services/contractTemplate.js:81-112`
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
  - `resolveServiceUnitPrice({ subscription, contractBuildingId, periodEndYmd, contractServicePrices, catalogItems }): { unitPrice: number, priceSource: 'CONTRACT_OVERRIDE' | 'SUBSCRIPTION_LOCKED' | 'BUILDING_CATALOG' | 'DEFAULT_CATALOG' }`
  - `resolveSubscriptionEffectiveWindow(subscription, options?: { includePendingApproval?: boolean }): { billable: boolean, effectiveStart: string | null, effectiveEnd: string | null }`
  - `computeSubscriptionPeriodCharge({ subscription, periodYm, boundStartYmd, boundEndYmd, contractBuildingId, contractServicePrices, catalogItems, lockedUnitPrice, lockedQuantity }): { activeDays: number, daysInMonth: number, isProrated: boolean, unitPrice: number, quantity: number, priceSource: string, rawAmount: number, amount: number, overlapStart: string | null, overlapEnd: string | null, description: string, formulaMeta: object }`
  - `resolveContractLastActiveDay(contract, options?: { explicitEndYmd?: string | null, roomTransferChildStartDate?: string | null, isNaturalExpiry?: boolean, isRoomTransfer?: boolean, todayYmd?: string }): { movedIn: boolean, lastActiveDayYmd: string }` (when `roomTransferChildStartDate` or `isRoomTransfer` is supplied, ALWAYS computes `lastActiveDayYmd = addDaysYmd(roomTransferChildStartDate || explicitEndYmd, -1)` ignoring clamped `contract.terminated_at`)
  - `computeContractRentPeriodCharge({ contract, periodYm, lastActiveDayYmd, lockedRentAmount }): { activeDays: number, daysInMonth: number, isProrated: boolean, unitPrice: number, rawAmount: number, amount: number, overlapStart: string | null, overlapEnd: string | null, description: string, formulaMeta: object }`

- [ ] **Step 1: Write the failing unit tests in `api/test/serviceBillingAndSchedule.test.js`**

Write pure unit tests covering:
1. Pre-start cancellation (`start_date = '2026-12-01'`, `end_date = '2026-11-30'`, `status = 'TERMINATED'`) -> `activeDays = 0, amount = 0`; `end_date = '2026-12-01'` -> `activeDays = 1`.
2. Mid-month subscribe + same-month cancel (`10/11` -> `20/11`, `unit_price = 300_000`) -> `activeDays = 11` (`110_000`, NOT `200_000`).
3. 5-month usage + mid-month-6 cancel (`'2026-01-01'`..`'2026-06-15'`) -> Months `1..5` full charge, Month `6` `15/30` Pro-rata, Month `7` `0 ₫`, and `buildExpectedInvoiceSchedule` preserves Months `1..5`.
4. **Review Focus #3 pins (`FR-065` `is_price_locked` symmetry, `contractTemplate.js` Điều 5 deduplication, & clamped `terminated_at` future room-transfer cutoff):**
   - `is_price_locked === false` resolves updated default catalog and newly inserted building catalog override identically (`150_000`), while `is_price_locked === true` preserves `sub.unit_price`; `effective_from <= periodEndYmd` + `INTERNET_FIBER`/`MANAGEMENT_FEE`/`PARKING_MOTO` aliases work bidirectionally.
   - `buildContractTemplateServiceRows` with a `TERMINATED` `INTERNET_FIBER` subscription + `contract_service_price` for `INTERNET` omits the terminated service from Điều 5.
   - When `contract.terminated_at = '2026-11-03'` (clamped to `today` by M06) while `roomTransferChildStartDate = '2028-06-15'`, BOTH `resolveContractLastActiveDay(contract, { roomTransferChildStartDate: '2028-06-15', isRoomTransfer: true })` AND `buildExpectedInvoiceSchedule({ contract, roomTransferChildStartDate: '2028-06-15', ... })` compute `lastActiveDayYmd = '2028-06-14'` (`14/30` days in `'2028-06'`, NOT clamped `'2026-11-03'`)!

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && node --test --test-concurrency=1 test/serviceBillingAndSchedule.test.js`
Expected: FAIL (`Cannot find module '../src/services/serviceBilling.js'`).

- [ ] **Step 3: Implement `api/src/services/serviceBilling.js` and update `api/src/services/invoiceSchedule.js` & `api/src/services/contractTemplate.js`**

Implement all exported functions in `serviceBilling.js`, update `invoiceSchedule.js` (accepting optional `roomTransferChildStartDate` and preserving `TERMINATED` historical months), and update `contractTemplate.js:82-111` to register all non-`METERED` subscription codes/aliases in `consumedPriceCodes` before `continue`.

- [ ] **Step 4: Run unit tests (new + existing schedule/template suites)**

Run: `cd api && node --test --test-concurrency=1 test/serviceBillingAndSchedule.test.js test/invoiceSchedule.test.js test/contractTemplate.test.js`
Expected: PASS (`0` failures).

- [ ] **Step 5: Commit**

```bash
git add api/src/services/serviceBilling.js api/src/services/invoiceSchedule.js api/src/services/contractTemplate.js api/test/serviceBillingAndSchedule.test.js
git commit -m "feat(billing): add Vietnam-TZ pro-rata, future room-transfer cutoff, and FR-065 3-tier pricing engine"
```

---

### Task 3: Invoice 3-Scenario Sync, Early Contract `6A` Sync & `credit_balance` Ledger (`invoiceLifecycle.js`)

**Files:**
- Create: `api/src/services/invoiceLifecycle.js`
- Test: `api/test/invoiceLifecycleSync.test.js`

**Interfaces:**
- Consumes: `serviceBilling.js` exports (Task 2); `roundVND` from `api/src/services/pricing.js`; `fn_notify_building_finance_actors` (Task 1).
- Produces (exported from `api/src/services/invoiceLifecycle.js`):
  - `applyAvailableCreditsInTx(client, { contractId, invoiceId, subtotalAmount, actorId }): Promise<{ totalCreditUsed: number, appliedItems: Array<{ creditId: string, amount: number, lineId: string }> }>`
  - `releaseInvoiceCreditsInTx(client, { invoiceId, maxReleaseAmount?: number | null, actorId }): Promise<{ releasedAmount: number, remainingCreditOffset: number }>`
  - `recalculateDraftInvoiceTotalsInTx(client, { invoiceId, actorId, autoVoidIfZero?: boolean, voidReason?: string | null }): Promise<{ invoice: object, lines: object[], releasedCreditAmount: number, autoVoided: boolean }>`
  - `syncSubscriptionTerminationInvoicesInTx(client, { subscription, contract, actorId, reason }): Promise<{ scenario: 'UNBILLED' | 'DRAFT_UPDATED' | 'ADJUSTMENT_CREATED' | 'MIXED' | 'NO_CHANGE', updatedDraftInvoiceIds: string[], voidedDraftInvoiceIds: string[], createdAdjustments: object[] }>`
  - `closeContractBillingAndSubscriptionsInTx(client, { contract, explicitEndYmd?: string | null, roomTransferChildStartDate?: string | null, isNaturalExpiry?: boolean, isRoomTransfer?: boolean, actorId, adjustmentCreatorId?: string | null, reason }): Promise<{ movedIn: boolean, lastActiveDayYmd: string, terminatedSubscriptionIds: string[], updatedDraftInvoiceIds: string[], voidedDraftInvoiceIds: string[], createdAdjustments: object[] }>`
  - `transferContractCreditsInTx(client, { fromContractId, toContractId, toBuildingId, retainAmount?: number, actorId, reason }): Promise<{ transferredTotal: number, retainedTotal: number, count: number }>`
  - `notifyBuildingInvoiceAdjustmentApprovers(client, { orgId, buildingId, invoiceId, invoiceCode, adjustmentId, actionType, deltaAmount, actorId }): Promise<void>`

- [ ] **Step 1: Write the failing DB-backed service tests in `api/test/invoiceLifecycleSync.test.js`**

Write `node:test` integration tests running inside `appPool` (`MANAGER`) AND `adminPool` (simulating `contracts.js:3336` `adminClient` / `daily.js`) asserting:
1. Scenario 1 (`UNBILLED`), Scenario 2 (`DRAFT` updated with `UPDATE_DRAFT_INVOICE_LINES` `audit_log` + surplus `credit_balance` release + Months `1..5` untouched), and Scenario 3 (post-`ISSUED` immutable `invoice_line` + `PENDING_APPROVAL` `invoice_adjustment` + `fn_notify_building_finance_actors` succeeding on both `appPool` and `adminPool`!).
2. Option `6A` (`closeContractBillingAndSubscriptionsInTx`): pre-move-in (`!movedIn` -> `0 ₫`, auto-`VOID` empty `DRAFT`, `PENDING_APPROVAL` `VOID` on unpaid `ISSUED`), mid-month (`period >= lastActiveDayYmd.slice(0, 7)` only, ad-hoc `subscription_id IS NULL` lines untouched), and idempotent second call (`delta === 0`, zero duplicate `PENDING_APPROVAL` rows).
3. `transferContractCreditsInTx` retains `retainAmount` on source contract and transfers only excess credit; `releaseInvoiceCreditsInTx` only mutates `status` on `('AVAILABLE', 'PARTIALLY_APPLIED', 'APPLIED')`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && node --test --test-concurrency=1 test/invoiceLifecycleSync.test.js`
Expected: FAIL (`Cannot find module '../src/services/invoiceLifecycle.js'`).

- [ ] **Step 3: Implement `api/src/services/invoiceLifecycle.js`**

Implement all exported functions per **Interfaces** and Spec Sections `5.3.2`, `5.4`, and `5.5.2`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd api && node --test --test-concurrency=1 test/invoiceLifecycleSync.test.js`
Expected: PASS (`0` failures).

- [ ] **Step 5: Commit**

```bash
git add api/src/services/invoiceLifecycle.js api/test/invoiceLifecycleSync.test.js
git commit -m "feat(invoices): implement 3-scenario invoice sync, 6A contract closure, and credit_balance helpers"
```

---

### Task 4: Service Catalog Multi-Building Guard & `FORCE RLS`-Safe Resident Payment/Service Routes (`services.js` & `resident.js`)

**Files:**
- Modify: `api/src/routes/services.js:1-434`
- Modify: `api/src/routes/resident.js:15-265, 995-1360`
- Test: `api/test/serviceCancellationFlow.test.js`

**Interfaces:**
- Consumes: `fn_get_finance_resource_scope`, `fn_lock_invoices_for_authorized_viewer` (Task 1), `serviceBilling.js` (Task 2), `invoiceLifecycle.js` (Task 3), `idempotencyGuard()` from `api/src/middleware/idempotency.js`, `getUserClient(req)` from `api/src/db/client.js`.
- Produces:
  - `POST /api/v1/service-catalog`, `PATCH /api/v1/service-catalog/:id` — `requireRole(['MANAGER'])`, `idempotencyGuard()`, `getUserClient(req)` + `fn_get_finance_resource_scope` (`AC-019.1`), `403 ORG_DEFAULT_SHARED_ACROSS_BUILDINGS` (+ `ACCESS_DENIED` `audit_log`) on `building_id IS NULL` when referenced by active/pending subscriptions in unassigned buildings without a building override (`FR-070`), and `audit_log` `before`/`after`.
  - `POST /api/v1/service-subscriptions`, `PATCH /api/v1/service-subscriptions/:id` — `requireRole(['MANAGER'])`, `idempotencyGuard()`, `is_price_locked`, 3-tier `FR-065` pricing, `'TERMINATED'` (`'CANCELLED'` alias), `zero_usage`, reject-cancel (`CANCELLATION_PENDING -> ACTIVE`), `audit_log`, returns `{ message, data, invoice_sync }`.
  - `GET /api/v1/resident/services`, `POST /api/v1/resident/services`, `PATCH /api/v1/resident/services/:id/cancel`, `PATCH /api/v1/resident/services/:id/withdraw-cancel` — `getUserClient(req)`, `idempotencyGuard()` on mutating routes, building-override catalog deduplication + `resolveServiceUnitPrice` (`is_price_locked = false`), pre-start `0 ₫` cancel, `PENDING_APPROVAL` withdraw.
  - `GET /api/v1/resident/overview` (`resident.js:217, 231, 240, 251` filtering `status NOT IN ('DRAFT', 'VOID')`, `current_amount_due` over `('ISSUED', 'ADJUSTED', 'PARTIALLY_PAID', 'OVERDUE')`, returning `available_credit_balance`), `GET /api/v1/resident/invoices` (`resident.js:1017` filtering `i.status <> 'DRAFT'`), and **`POST /api/v1/resident/payments/report` (`resident.js:1073-1095` locking target invoice via `SELECT * FROM fn_lock_invoices_for_authorized_viewer(NULL, $1)` so `RESIDENT` never hits `FORCE RLS` `0`-row `FOR UPDATE` filtering, rejecting `inv.status IN ('DRAFT', 'VOID')` with `409 INVALID_STATUS` and `total_amount - paid_amount <= 0` with `409 ALREADY_PAID`)**.

- [ ] **Step 1: Write the failing API integration tests in `api/test/serviceCancellationFlow.test.js`**

Write integration tests asserting:
1. `SYS_ADMIN` gets `403` on `POST /api/v1/service-catalog` and `PATCH /api/v1/service-subscriptions/:id` (`PRD 6.2`); `MANAGER` catalog `POST`/`PATCH` logs `audit_log`, returns `403` on unassigned building, returns `403 ORG_DEFAULT_SHARED_ACROSS_BUILDINGS` on shared org-default row (`FR-070`), and returns `200` on unshared org-default row.
2. Pre-`start_date` cancel + `Idempotency-Key` replay (`Idempotent-Replayed: true`) + `PATCH /withdraw-cancel` + Manager `TERMINATED` (`0 ₫`).
3. Mid-term 3 scenarios (`UNBILLED`, `DRAFT` hidden from `RESIDENT` across `/overview`, `/invoices`, `/payments/report`, and `PAID` Month 6 creating `PENDING_APPROVAL` `invoice_adjustment` while keeping Months `1..5` intact), **PLUS Review Focus #1 pin: `RESIDENT` calling `POST /api/v1/resident/payments/report` on an `ISSUED` invoice succeeds with `201` (`PENDING_CONFIRMATION`) under `FORCE ROW LEVEL SECURITY` (never returning `404`!)**.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && node --test --test-concurrency=1 test/serviceCancellationFlow.test.js`
Expected: FAIL (`SYS_ADMIN` allowed / `ORG_DEFAULT_SHARED_ACROSS_BUILDINGS` missing / `RESIDENT` `payments/report` `404` under `rls_invoice_modify` / pre-start cancel `422`).

- [ ] **Step 3: Update `api/src/routes/services.js` and `api/src/routes/resident.js`**

Implement all route updates per **Interfaces** using `getUserClient(req)` and `fn_lock_invoices_for_authorized_viewer`.

- [ ] **Step 4: Run new + existing service & resident tests**

Run: `cd api && node --test --test-concurrency=1 test/serviceCancellationFlow.test.js test/parkingPlatesSync.test.js test/residentOnboardingFlow.test.js`
Expected: PASS (`0` failures).

- [ ] **Step 5: Commit**

```bash
git add api/src/routes/services.js api/src/routes/resident.js api/test/serviceCancellationFlow.test.js
git commit -m "feat(services,resident): add 0 VND pre-start cancel, multi-building catalog guard, and FORCE RLS-safe resident payment report"
```

---

### Task 5: Invoices `DRAFT` Line CRUD (`skipped_contracts` & `DRAFT` Refresh), Four-Eyes Approvals, Attachment RLS, Tenant Merge & Payments (`invoices.js`, `payments.js`, `attachments.js`, `tenants.js`)

**Files:**
- Modify: `api/src/routes/invoices.js:1-738`
- Modify: `api/src/routes/payments.js:1-520`
- Modify: `api/src/routes/attachments.js:75-105`
- Modify: `api/src/routes/tenants.js:701-728`
- Test: `api/test/invoiceFourEyesAndCreditBalance.test.js`

**Interfaces:**
- Consumes: `fn_get_finance_resource_scope`, `fn_notify_building_finance_actors`, `fn_resolve_invoice_adjustment`, `fn_resolve_credit_refund`, `can_select_attachment` (Task 1), `serviceBilling.js` (Task 2), `invoiceLifecycle.js` (Task 3), `saveBase64Image` from `api/src/utils/upload.js`, `validateRefundBankInfo` from `api/src/services/depositSettlement.js`, `idempotencyGuard()`, `getUserClient(req)`.
- Produces:
  - Upgraded `generateInvoicesCore(client, { orgId, targetPeriod, buildingId, contractId = null, matchBillingDays, onlyOngoingContracts, excludeSettledDeposits = false, autoIssue, actorId, applyScope })` in `api/src/routes/invoices.js`:
    - When `contractId` is supplied, filters `NOT EXISTS (... inv.status NOT IN ('VOID', 'DRAFT'))` (instead of `inv.status <> 'VOID'`) so an existing `DRAFT` invoice for `(contractId, targetPeriod)` is fetched and refreshed in-place (`RENT`/`SERVICE`/metered `ELECTRICITY` & `WATER` + `recalculateDraftInvoiceTotalsInTx`).
    - Joins/subqueries `room_transfer_child_start_date` (`SELECT ch.start_date FROM contract ch WHERE ch.parent_contract_id = c.id AND ch.is_room_transfer = TRUE AND ch.status NOT IN ('DRAFT', 'PENDING_APPROVAL', 'CANCELLED') ORDER BY ch.created_at DESC LIMIT 1`) and passes `roomTransferChildStartDate` + `isRoomTransfer: Boolean(roomTransferChildStartDate)` to `resolveContractLastActiveDay` (never using clamped `c.terminated_at`).
    - Returns `{ created_count, updated_draft_count, skipped_contracts: Array<{ contract_id, contract_code, apartment_code, reason }>, warnings, data }` (`FR-033`, `AC-015.1`), persists `subscription_id` + `formula_meta`, applies FIFO `applyAvailableCreditsInTx`, writes `CREATE_INVOICE` `audit_log`, and catches `23505` gracefully.
  - `POST /api/v1/invoices/:id/lines`, `PATCH /api/v1/invoices/:id/lines/:lineId`, `DELETE /api/v1/invoices/:id/lines/:lineId`, `POST /api/v1/invoices/:id/issue` — all `MANAGER` + `idempotencyGuard()`; shared `issueDraftInvoiceInTx` (`0 ₫ -> 'PAID'`, zero `receivable`).
  - `PATCH /api/v1/invoices/:id/status` (`MANAGER` + `idempotencyGuard()`): normalizes `'CANCELLED' -> 'VOID'`; **Check #1: `targetStatus === 'VOID' && Number(inv.paid_amount) > 0 -> 409 ALREADY_PAID`** (preserving `fullWebsiteWhiteBlackBox.test.js:1403-1408`); Check #2: `inv.status !== 'DRAFT'` with `adjustment_amount` or `VOID` -> `409 REQUIRES_FOUR_EYES_ADJUSTMENT`; on `DRAFT`, deletes ONLY `credit_id IS NULL` manual `ADJUSTMENT` lines before `recalculateDraftInvoiceTotalsInTx` and checks `confirm_invoice_code` when supplied.
  - `POST /api/v1/invoices/:id/adjust`, `GET /api/v1/invoices/adjustments`, `POST /api/v1/invoices/:id/adjustments/:adjId/approve` & `/reject` (`fn_resolve_invoice_adjustment`), and `GET /api/v1/invoices/:id/audit-logs`.
  - `api/src/routes/payments.js`:
    - `POST /api/v1/payments`, `PATCH /api/v1/payments/:id/confirm`, `PATCH /api/v1/payments/:id/reject` (`MANAGER` + `idempotencyGuard()` + `getUserClient(req)`): Order B commutativity on invoices, **PLUS standalone `receivable_id` (`invoice_id IS NULL` & `rec.contract_id IS NOT NULL`) overpayment minting into `credit_balance` (`OVERPAYMENT`)**, plus `REJECT_PAYMENT` `audit_log`.
    - `GET /api/v1/receivables` returning both `aging_summary` and `aging_summary_prd` (`AC-016.1`).
    - `GET /api/v1/payments/credits`, `POST /api/v1/payments/credits/:id/refund` (`MANAGER` + `idempotencyGuard()`, blocking `409 SETTLEMENT_IN_PROGRESS` when deposit is in `('PENDING_APPROVAL', 'APPROVED_PENDING_PAYOUT', 'RETURNED')` OR `('DISPUTED' && !dep.settlement?.accounting_committed_at)`, persisting base64 `proof_image` via `saveBase64Image({ entity: 'credit_balance', ... })`), and `POST /api/v1/payments/credits/:id/refund/approve` & `/reject` (`fn_resolve_credit_refund`).
  - `api/src/routes/attachments.js:86`: adds `'credit_balance'`, `'invoice'`, `'invoice_adjustment'` to allowed `att.owner_entity` list.
  - `api/src/routes/tenants.js:701-728` (`POST /api/v1/tenants/:id/merge`, `FR-021`): adds `UPDATE credit_balance SET tenant_id = $1, updated_at = NOW() WHERE tenant_id = $2`.

- [ ] **Step 1: Write the failing API integration tests in `api/test/invoiceFourEyesAndCreditBalance.test.js`**

Write integration tests asserting:
1. `DRAFT` line CRUD (`POST/PATCH/DELETE /invoices/:id/lines`), `credit_id IS NOT NULL` preservation on `PATCH /invoices/:id/status` `{ adjustment_amount }`, `paid_amount > 0` returning `409 ALREADY_PAID` even without `confirm_invoice_code`, `skipped_contracts` array returned by `POST /invoices/generate-batch` when a contract has `0` billable charges (`AC-015.1`), and existing-`DRAFT` in-place refresh when `{ contract_id, period }` is passed after meter readings are recorded!
2. Four-eyes RBAC & `FR-064` `LATE_FEE` waiver matrix (`403 SELF_APPROVAL`, `SYS_ADMIN` `403` on `VOP-A`, `OWNER` & `mgr2VopA` `200`).
3. Order A vs Order B payment commutativity, **standalone `receivable_id` overpayment minting `credit_balance` (`OVERPAYMENT`)**, `PATCH /payments/:id/reject` (`REJECT_PAYMENT` `audit_log`), and `GET /api/v1/receivables` `aging_summary_prd` (`AC-016.1`).
4. Active & ended/`0`-deposit 4-eyes `credit_balance` refund with base64 `proof_image` (`GET /api/v1/attachments/:attId/view` returns `200` for `OWNER`, `MANAGER`, and `RESIDENT`, and `403`/`404` for unassigned building staff), split/reject merge-back, `'DISPUTED'` uncommitted deposit returning `409 SETTLEMENT_IN_PROGRESS`, AND `POST /api/v1/tenants/:targetId/merge` migrating `credit_balance.tenant_id` (`FR-021`).
5. FIFO `credit_balance` auto-offset on next period, `0 ₫` issuance -> `'PAID'` with zero `receivable`, and `DRAFT -> VOID` restoring `credit_balance`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && node --test --test-concurrency=1 test/invoiceFourEyesAndCreditBalance.test.js`
Expected: FAIL (`404` on `/lines`, `/adjust`, `/payments/credits/:id/refund`, `skipped_contracts` missing).

- [ ] **Step 3: Implement updates in `invoices.js`, `payments.js`, `attachments.js`, and `tenants.js`**

Implement all updates per **Interfaces** using `getUserClient(req)`.

- [ ] **Step 4: Run new + existing invoice, payment, attachment & tenant suites**

Run: `cd api && node --test --test-concurrency=1 test/invoiceFourEyesAndCreditBalance.test.js test/sprint1And2Rebuild.test.js`
Expected: PASS (`0` failures).

- [ ] **Step 5: Commit**

```bash
git add api/src/routes/invoices.js api/src/routes/payments.js api/src/routes/attachments.js api/src/routes/tenants.js api/test/invoiceFourEyesAndCreditBalance.test.js
git commit -m "feat(invoices,payments): add DRAFT CRUD, 4-eyes adjustments/credit refunds, attachment RLS, and tenant merge sync"
```

---

### Task 6: Contract `6A` Sync (Future Room-Transfer Cutoff), Renewal Credit Carryover, `daily.js` Final-Period Billing, Append-Only `LATE_FEE` & `FR-039` Debt Reminders (`contracts.js` & `daily.js`)

**Files:**
- Modify: `api/src/routes/contracts.js:89-145, 813-1060, 2429-2998, 3330-3520, 3817-3865, 4880-5170`
- Modify: `api/src/jobs/daily.js:1-649`
- Modify: `api/test/contractCreationFixes.test.js:626-631`
- Test: `api/test/contractEarlyTerminationBillingSync.test.js`

**Interfaces:**
- Consumes: `closeContractBillingAndSubscriptionsInTx`, `transferContractCreditsInTx` (Task 3); `todayVietnamYmd`, `currentVietnamPeriod`, `addDaysYmd` (Task 2); upgraded `generateInvoicesCore` (Task 5).
- Produces:
  - Automatic `6A` `SERVICE` + `RENT` closure across all 6 contract-ending paths: `cancel` (`contracts.js:3842-3850`), `terminate` (`:2429`), `terminate/approve` (`:2580`), `requests/:id/approve` (`:813`), M06 4-step room-transfer activation inside `runActivationSideEffects` (`:2792-2958`, passing `isRoomTransfer: true`, `roomTransferChildStartDate: sDateStr`, `adjustmentCreatorId: contract.created_by`), and `runDailyJobs()` Steps 1a & 1b.
  - `loadContractSubscriptionsAndSchedule` (`contracts.js:89-145`): queries active room-transfer child `start_date` (`roomTransferChildStartDate`) and passes it to `buildExpectedInvoiceSchedule`, hides `DRAFT`/`VOID` from `RESIDENT` (`AC-003.2`), and returns `available_credit_balance`, `credit_balances`, and `pending_invoice_adjustments_count`.
  - Safe `transferContractCreditsInTx` inside `runActivationSideEffects` and `daily.js` Step 1b.
  - `api/src/jobs/daily.js`:
    - Step 5: `onlyOngoingContracts: false, excludeSettledDeposits: true` (`FR-066`).
    - Steps 6 & 7: `'ADJUSTED'` (`paid_amount < total_amount`), `MARK_INVOICE_OVERDUE` & `ACCRUE_LATE_FEE` `audit_log` rows (`actor_id = NULL`), and append-only `deltaFee = GREATEST(0, expectedFee - gross_accrued_late_fee)` (`FR-064`).
    - **Step 8 (`FR-039`, `PRD Mục 10.1 & 12.4` — Automated Multi-Stage Debt Reminders):** queries unpaid `('ISSUED', 'PARTIALLY_PAID', 'OVERDUE', 'ADJUSTED')` invoices (`paid_amount < total_amount`) against `todayVn = (NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date`, matching `daysDiff = (todayVn - i.due_date)::int` across `-3` (`PRE_DUE_3D`), `0` (`DUE_TODAY`), and post-due `reminder_days` from `system_setting('billing_config')` (default `[3, 7, 15]` -> `OVERDUE_3D`, `OVERDUE_7D`, `OVERDUE_15D`), deduplicating idempotently via `NOT EXISTS (SELECT 1 FROM notification n WHERE n.user_id = resident_user_id AND n.type = 'PAYMENT_REMINDER' AND n.payload->>'invoice_id' = i.id::text AND n.payload->>'reminder_stage' = stage_key)` and inserting `notification(org_id, user_id, title, content, type, payload)` + `SEND_DEBT_REMINDER` `audit_log` (`actor_id = NULL`).

- [ ] **Step 1: Write the failing integration tests in `api/test/contractEarlyTerminationBillingSync.test.js`**

Write integration tests asserting:
1. Pre-move-in & mid-month `POST /api/v1/contracts/:id/terminate` (`6A` preserving prior months and syncing `RENT` + `SERVICE`).
2. **Review Focus #3 future room-transfer pin:** `POST /api/v1/contracts/:id/transfer-room` (`new_start_date = '2028-06-15'`, `transfer_deposit: true`) + scan + submit + `OWNER` `POST /api/v1/contracts/:newId/approve` (running via `adminClient` at `:3336`):
   - Even though `oldContract.terminated_at` in DB was clamped to `today`, **BOTH `GET /api/v1/contracts/:oldId` (`invoice_schedule` for `'2028-06'`) AND `POST /api/v1/invoices/generate-batch` (`{ contract_id: oldId, period: '2028-06' }`) bill `oldContract` for exact `14/30` days (`01/06–14/06/2028`), while `newContract` bills `16/30` days (`15/06–30/06/2028`) = `30/30` days total!**
   - Early-activated `renew` keeps `credit_balance` on `oldContract` while `ACTIVE`, then rolls excess credit to `newContract` when `runDailyJobs()` Step 1b expires `oldContract`.
3. `RESIDENT` `GET /api/v1/contracts/:id` hides `DRAFT`/`VOID` (`AC-003.2`).
4. **Review Focus #5 pins (`daily.js` Step 5 `excludeSettledDeposits`, Steps 6–7 append-only `LATE_FEE` + `FR-064` waiver, & Step 8 `FR-039` multi-stage debt reminders):**
   - Step 5 auto-bills unsettled `TERMINATED` contract on `billing_day` and skips settled-deposit contract.
   - Step 7 preserves `-200_000` `LATE_FEE` waiver across Day 8 -> Day 9 (`deltaFee = 100_000`) and writes `MARK_INVOICE_OVERDUE` / `ACCRUE_LATE_FEE` `audit_log` rows.
   - Step 8 (`FR-039`): seeding unpaid issued invoices with `due_date` at `todayVn + 3`, `todayVn`, `todayVn - 3`, `todayVn - 7`, and `todayVn - 15` emits exact `1` `PAYMENT_REMINDER` notification + `1` `SEND_DEBT_REMINDER` `audit_log` per stage on the first `runDailyJobs()` run, and emits **`0` duplicates** when `runDailyJobs()` is called a second time on the same day!

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && node --test --test-concurrency=1 test/contractEarlyTerminationBillingSync.test.js`
Expected: FAIL (future room-transfer schedule clamped to `today` / `LATE_FEE` deleted / Step 8 `PAYMENT_REMINDER` missing).

- [ ] **Step 3: Implement updates in `api/src/routes/contracts.js`, `api/src/jobs/daily.js`, and `api/test/contractCreationFixes.test.js:630`**

Implement all updates per **Interfaces** (preserving M06 reservation expiration in `daily.js` and `contract.status = 'CANCELLED'` at `contracts.js:3842`, updating subscription `'CANCELLED'` -> `'TERMINATED'` at `contracts.js:3847` and `contractCreationFixes.test.js:630`).

- [ ] **Step 4: Run new + existing contract, M06 room-transfer & daily job test suites**

Run: `cd api && node --test --test-concurrency=1 test/contractEarlyTerminationBillingSync.test.js test/contractCreationFixes.test.js test/multiBuildingAndFutureContract.test.js test/m06RoomTransferApprovalFlow.test.js`
Expected: PASS (`0` failures).

- [ ] **Step 5: Commit**

```bash
git add api/src/routes/contracts.js api/src/jobs/daily.js api/test/contractEarlyTerminationBillingSync.test.js api/test/contractCreationFixes.test.js
git commit -m "feat(contracts,jobs): add 6A sync with future room-transfer cutoff, append-only LATE_FEE, and FR-039 debt reminders"
```

---

### Task 7: M06 Two-Step Deposit Settlement (`remaining_service_debt` `RP-07` Guard, `FORCE RLS` Locks, `unbilled_final_period`) & KPI / `RP-08` `.xlsx` Reports (`deposits.js`, `reports.js`, `audit-logs.js`)

**Files:**
- Modify: `api/src/services/depositSettlement.js:1-331`
- Modify: `api/src/routes/deposits.js:110-270, 735-2458`
- Modify: `api/src/routes/reports.js:1-840`
- Modify: `api/src/routes/admin/audit-logs.js:1-215`
- Modify: `api/test/m06Phase3P2Features.test.js:931-938`
- Test: `api/test/settlementCreditAndKpiReports.test.js`

**Interfaces:**
- Consumes: `fn_lock_invoices_for_authorized_viewer`, `fn_apply_deposit_settlement_accounting`, `fn_update_deposit_refund_bank_info`, `fn_restore_returned_settlement_credits`, `fn_recommit_returned_settlement_credits` (Task 1); `todayVietnamYmd`, `currentVietnamPeriod`, `resolveContractLastActiveDay` (Task 2); `toUtf8BomCsv`, `toXlsxBuffer` from `api/src/utils/csv.js`.
- Produces:
  - `computeFinalSettlementWithCredit({ heldBefore, availableCredit, serviceDebt, rentDebt, items })` in `api/src/services/depositSettlement.js`:
    - Returns `{ credit_applied_to_rent, credit_applied_to_service, credit_applied_to_invoices, credit_applied_to_damages, credit_refund_amount, remaining_rent_debt, remaining_service_debt, covered_service_debt, uncovered_items_shortfall, deposit_refund_amount, refund_amount, total_payout_amount, shortfall, outstanding_debt, rent_debt }` where **`remaining_service_debt = Math.max(0, serviceDebt - credit_applied_to_service)`** and **`covered_service_debt = Math.min(Math.max(0, heldBefore - sumItems), remaining_service_debt)`** (`RP-07` zero double-deduction invariant!).
  - `isSettlementSnapshotStale(savedSettlement, liveState)`: compares `availableCredit` against `savedSettlement.available_credit` in addition to `serviceDebt`, `rentDebt`, `heldAmount`, and `openInvoices`.
  - `api/src/routes/deposits.js`:
    - `calculateContractOpenDebts`: `'ADJUSTED'` included + cross-bucket negative spill + `RENT`-first `credit_offset_amount` allocation matching `fn_apply_deposit_settlement_accounting` 100%.
    - `checkSettlementPreconditions` (`:201`): derives `lastActiveDayYmd` via `resolveContractLastActiveDay` (including `roomTransferChildStartDate`) and `endPeriod = lastActiveDayYmd.slice(0, 7)` (so `'2026-06-01'` transfer yields `endPeriod = '2026-05'`), adds blocking `no_pending_invoice_adjustments` + `no_pending_credit_refunds`, and returns non-blocking `unbilled_final_period: { has_unbilled_period, period: endPeriod, active_days }`.
    - `POST /:id/settlement/approve` (`:1324, 1419`), `commitSettlementAccounting` (`:1209`), & `POST /:id/payout` (`:1957, 1982`): **locks contract invoices via `SELECT * FROM fn_lock_invoices_for_authorized_viewer($1, NULL)`** (never raw `SELECT ... FROM invoice ... FOR UPDATE` on `OWNER` session!), and **computes `coveredServiceDebt = Math.min(remainingServiceDebt, remainingDepositToDeduct)` using post-credit `remainingServiceDebt = Math.max(0, liveDebts.serviceDebt - creditAppliedToService)`** (NEVER passing raw `liveDebts.serviceDebt`!).
    - `POST /:id/payout-returned` & `GET /:id/settlement/pdf` & `GET /:id/audit-logs`: full 2-step M06 `credit_balance` separation (`DEDUCTED_FULL -> RETURNED` when `creditRefundAmt > 0`, `RP-07` purity).
  - `GET /api/v1/reports/dashboard` & `GET /api/v1/reports/summary` (`reports.js` via `getUserClient(req)`):
    - `billed`, net `collected` (subtracting `REFUNDED_DIRECT` + paid-out `REFUNDED_IN_SETTLEMENT`), `invoice_settled`, `AC-016.1` aging buckets (`current_not_due`, `bucket_0_15`, `bucket_16_30`, `bucket_31_60`, `bucket_over_60`), BOTH `pending_invoice_adjustments` and `pending_credit_refunds` in `/dashboard` `kpis`, AND **`?format=csv` / `?format=xlsx` (`toXlsxBuffer`, `FR-058`)** on `/summary` (`section=revenue|aging|all`).
  - `GET /api/v1/audit-logs` (`admin/audit-logs.js` + `api/test/m06Phase3P2Features.test.js:931-938`): 12-entity `FINANCIAL_AUDIT_ENTITIES`, allows `MANAGER` when `scope === 'financial'`, and supports **both `format=csv` and `format=xlsx` (`toXlsxBuffer`, `Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`, `FR-058`)**.

- [ ] **Step 1: Write the failing settlement & KPI report tests in `api/test/settlementCreditAndKpiReports.test.js`**

Write integration tests asserting:
1. `409 PENDING_INVOICE_ADJUSTMENT`, `409 PENDING_CREDIT_REFUND`, `unbilled_final_period` (`has_unbilled_period: true -> false` after `generate-batch`), and `409 SETTLEMENT_SNAPSHOT_STALE` when `available_credit` changes.
2. **Review Focus #1 & #2 pins:**
   - **Case A0 (`'ADJUSTED'` mixed `RENT` + `SERVICE` debt split & cross-bucket negative spill):** exact match between JS preview and SQL `fn_apply_deposit_settlement_accounting`.
   - **Case A1 (Zero `UTILITY_DEBT` double-deduction & `OWNER` `FORCE RLS` approve when `total_payout_amount > 0`):** `heldBefore = 5_000_000`, `availableCredit = 1_500_000`, `rentDebt = 0`, `serviceDebt = 1_500_000`, `items = []` -> `remaining_service_debt = 0`, `covered_service_debt = 0`, `deposit_refund_amount = 5_000_000`, `credit_refund_amount = 0`; **`OWNER` calling `POST /api/v1/deposits/:id/settlement/approve` succeeds (`200`, `'APPROVED_PENDING_PAYOUT'`) under `FORCE RLS`**, and after `MANAGER` `POST /:id/payout`, `deposit_transaction` has **zero `UTILITY_DEBT` `deduct` rows** (only `1` `refund` row of `5_000_000`), and `GET /api/v1/reports/deposit-ledger` (`RP-07`) has `closing_held === 0`!
   - **Case A (`total_payout_amount === 0` approved by `OWNER`)** & **Case B (`deposit_refund_amount = 0`, `credit_refund_amount = 1_800_000 > 0` -> `APPROVED_PENDING_PAYOUT` -> `bank-info` -> `settlement/pdf` -> `payout` -> `DEDUCTED_FULL` with `0` `deposit_transaction` `refund` rows -> `payout-returned` -> `RETURNED` -> `payout` reissue)**.
3. KPI Reports (`/dashboard` & `/summary`): `billed = 8M / 10M`, net `collected = 7.5M` (`credit_refunded_direct = 1M`, `credit_refunded_settlement = 0.5M`), `invoice_settled = 10M`, `pending_invoice_adjustments` & `pending_credit_refunds` counts on `/dashboard`, AND `GET /api/v1/reports/summary?section=aging&format=xlsx` returns `200` with PK zip magic bytes `0x50 0x4B` (`FR-058`).
4. `GET /api/v1/audit-logs?scope=financial` returns all **12** `FINANCIAL_AUDIT_ENTITIES` for `OWNER` and `MANAGER` across JSON, `&format=csv`, AND `&format=xlsx` (`0x50 0x4B` valid `.xlsx` buffer, `FR-058`), while unscoped `/audit-logs` returns `403` for `MANAGER`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && node --test --test-concurrency=1 test/settlementCreditAndKpiReports.test.js`
Expected: FAIL (`UTILITY_DEBT` double-deducted / `OWNER` `FOR UPDATE` `0` rows / `format=xlsx` unsupported / `scope=financial` `403` for `MANAGER`).

- [ ] **Step 3: Implement updates in `depositSettlement.js`, `deposits.js`, `reports.js`, `admin/audit-logs.js`, and `api/test/m06Phase3P2Features.test.js:931-938`**

Implement all settlement, `remaining_service_debt` / `covered_service_debt`, `fn_lock_invoices_for_authorized_viewer`, `unbilled_final_period`, KPI, 12-entity `RP-08`, and `format=xlsx` updates per **Interfaces**.

- [ ] **Step 4: Run new + all existing M06 & white-box regression suites**

Run: `cd api && node --test --test-concurrency=1 test/settlementCreditAndKpiReports.test.js test/depositCollectAndRefund.test.js test/m06Phase1P0Fixes.test.js test/m06Phase2OwnerApprovalAndEscalation.test.js test/m06Phase2PayoutAndReturnedFlow.test.js test/m06Phase3P2Features.test.js test/m06RoomTransferApprovalFlow.test.js test/m06TransferAndReservationRls.test.js test/fullWebsiteWhiteBlackBox.test.js`
Expected: PASS (`0` failures across every single M06 and white-box test!).

- [ ] **Step 5: Commit**

```bash
git add api/src/services/depositSettlement.js api/src/routes/deposits.js api/src/routes/reports.js api/src/routes/admin/audit-logs.js api/test/m06Phase3P2Features.test.js api/test/settlementCreditAndKpiReports.test.js
git commit -m "feat(settlement,reports): prevent RP-07 utility double-deduction, add FORCE RLS locks, PRD KPIs, and xlsx exports"
```

---

### Task 8: Frontend Billing/RBAC Helpers & Admin/Owner Services, Invoices, `AC-016.1` Receivables & Notifications UI

**Files:**
- Create: `frontend/src/utils/billing.js`
- Modify: `frontend/src/constants/statuses.js:1-175`
- Modify: `frontend/src/services/api.js:1-79`
- Modify: `frontend/src/hooks/usePermission.js:25-52`
- Modify: `frontend/src/services/invoices.service.js:1-20`
- Modify: `frontend/src/services/payments.service.js:1-20`
- Modify: `frontend/src/services/services.service.js:1-20`
- Modify: `frontend/src/pages/admin/services/ServiceCatalogPage.jsx`
- Modify: `frontend/src/pages/admin/services/SubscriptionsPage.jsx`
- Modify: `frontend/src/pages/admin/invoices/InvoicesPage.jsx`
- Modify: `frontend/src/pages/admin/invoices/InvoiceDetailPage.jsx`
- Modify: `frontend/src/pages/admin/payments/PaymentsPage.jsx`
- Modify: `frontend/src/pages/admin/notifications/NotificationsPage.jsx:31-41`
- Test: `api/test/frontendBillingHelpers.test.js`

**Interfaces:**
- Consumes: `createIdempotencyKey`, `withIdempotency` from `frontend/src/utils/idempotency.js`; backend endpoints from Tasks 4 & 5.
- Produces:
  - `frontend/src/utils/billing.js` (re-exporting `createIdempotencyKey` & `withIdempotency`): `roundVND`, `todayVietnamYmd`, `previewSubscriptionProrata`, `canConfirmInvoiceVoid`, `canActorApproveInvoiceAdjustment`, `canActorApproveCreditRefund`, `resolvePrdAgingBucket(daysOverdue)`.
  - `frontend/src/constants/statuses.js`: `SUBSCRIPTION_STATUS.TERMINATED`, `INVOICE_STATUS.ADJUSTED` & `VOID`, `INVOICE_ADJUSTMENT_STATUS`, `CREDIT_BALANCE_STATUS`.
  - `frontend/src/services/api.js`: Axios request interceptor auto-attaching `Idempotency-Key` when `!config.headers['Idempotency-Key']` on mutating `POST`/`PATCH`/`DELETE` requests to `/api/v1/invoices`, `/api/v1/payments`, `/api/v1/service-catalog`, `/api/v1/service-subscriptions`, `/api/v1/contracts`, `/api/v1/deposits`, and `/api/v1/resident`.
  - `frontend/src/hooks/usePermission.js`: `canManageServiceCatalog: isManager`, `canManageServices: isManager`, `canManageInvoices: isManager`, `canManagePayments: isManager`, `canApproveInvoiceAdjustments: isOwner || isManager || isSysAdmin`, `canApproveCreditRefunds: isOwner || isManager || isSysAdmin`, `canViewFinancialAuditLogs: isSysAdmin || isOwner || isManager`.
  - `PaymentsPage.jsx`: `'ADJUSTED'` in `openCreateModal` (`:229`) **AND full `AC-016.1` Receivables aging upgrade (`:59-64, 868-960`) displaying & exporting `Chưa đến hạn`, `0–15 ngày`, `16–30 ngày`, `31–60 ngày`, `>60 ngày` from `aging_summary_prd`**.
  - `SubscriptionsPage.jsx` (`TERMINATED` filter pill + `previewSubscriptionProrata`), `InvoicesPage.jsx` (`skipped_contracts` summary display on batch generation per `AC-015.1`), `InvoiceDetailPage.jsx` (`DRAFT` line editor, contextual issue confirm `PRD 16.1`, 2-step `VOID` `PRD 16.2`, 4-eyes `ADJUST`/`LATE_FEE`, `Lịch sử / Kiểm toán` tab `PRD 8.2`), and `NotificationsPage.jsx` (`CREDIT_*`, `INVOICE_ADJUSTMENT_*`, `INVOICE_ADJUSTED`, `INVOICE_VOIDED`, `SERVICE_TERMINATED`, `PAYMENT_REMINDER` labels).

- [ ] **Step 1: Write failing unit tests for frontend billing, `AC-016.1` aging bucket, 2-step `VOID`, and 4-eyes helpers in `api/test/frontendBillingHelpers.test.js`**

Import `../../frontend/src/utils/billing.js` and `../../frontend/src/constants/statuses.js` in `node:test`, asserting:
1. All new status maps exist with `CANCELLED` display fallback; `billing.js` re-exports `createIdempotencyKey` from `./idempotency.js`.
2. `previewSubscriptionProrata` returns `0 ₫` when `endDate < startDate` and `11/30` days (`roundVND`) for `10/11 -> 20/11`.
3. `resolvePrdAgingBucket(daysOverdue)` maps `<= 0 -> 'current_not_due'`, `1..15 -> '0_15'`, `16..30 -> '16_30'`, `31..60 -> '31_60'`, `> 60 -> 'over_60'` (`AC-016.1`).
4. `canConfirmInvoiceVoid`, `canActorApproveInvoiceAdjustment`, and `canActorApproveCreditRefund` enforce 2-step `invoice_code` + non-empty `reason` and 4-eyes / `SYS_ADMIN` fallback rules.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && node --test --test-concurrency=1 test/frontendBillingHelpers.test.js`
Expected: FAIL (`Cannot find module '../../frontend/src/utils/billing.js'`).

- [ ] **Step 3: Implement shared frontend helpers, `api.js` interceptor, and Admin/Owner Services, Invoices, Payments & Notifications pages**

Implement all helpers and UI updates per **Interfaces**.

- [ ] **Step 4: Run helper unit tests and frontend lint/build check**

Run: `cd api && node --test --test-concurrency=1 test/frontendBillingHelpers.test.js && cd ../frontend && npm run lint && npm run build`
Expected: `frontendBillingHelpers.test.js` PASS, `oxlint` `0` errors, `vite build` succeeds cleanly.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/utils/billing.js frontend/src/constants/statuses.js frontend/src/services/api.js frontend/src/hooks/usePermission.js frontend/src/services/invoices.service.js frontend/src/services/payments.service.js frontend/src/services/services.service.js frontend/src/pages/admin/services/ServiceCatalogPage.jsx frontend/src/pages/admin/services/SubscriptionsPage.jsx frontend/src/pages/admin/invoices/InvoicesPage.jsx frontend/src/pages/admin/invoices/InvoiceDetailPage.jsx frontend/src/pages/admin/payments/PaymentsPage.jsx frontend/src/pages/admin/notifications/NotificationsPage.jsx api/test/frontendBillingHelpers.test.js
git commit -m "feat(frontend): add billing/4-eyes helpers, DRAFT line editor, AC-016.1 receivables aging, and invoice audit tab"
```

---

### Task 9: Frontend Resident Portal, Contract Credit Refund UI, M06 Deposit Payout UI, `DashboardPage.jsx` KPIs & Reports/Audit `.xlsx` Export (`FR-058`)

**Files:**
- Modify: `frontend/src/services/resident.service.js:1-45`
- Modify: `frontend/src/services/reports.service.js`
- Modify: `frontend/src/services/audit.service.js`
- Modify: `frontend/src/pages/resident/tabs/ServicesTab.jsx`
- Modify: `frontend/src/pages/resident/tabs/InvoicesTab.jsx`
- Modify: `frontend/src/pages/resident/tabs/OverviewTab.jsx`
- Modify: `frontend/src/pages/resident/tabs/NotificationsTab.jsx:24-78`
- Modify: `frontend/src/pages/admin/contracts/ContractDetailPage.jsx`
- Modify: `frontend/src/pages/admin/deposits/DepositsPage.jsx`
- Modify: `frontend/src/pages/admin/dashboard/DashboardPage.jsx`
- Modify: `frontend/src/pages/admin/reports/ReportsPage.jsx`
- Modify: `frontend/src/pages/admin/audit/AuditLogsPage.jsx`
- Test: `api/test/frontendBillingHelpers.test.js`

**Interfaces:**
- Consumes: `billing.js`, `statuses.js`, `invoicesService`, `paymentsService` (Task 8); backend endpoints from Tasks 4, 5, 6, 7.
- Produces:
  - `residentService.withdrawCancelService(id)` (`PATCH /api/v1/resident/services/:id/withdraw-cancel`), `reportsService.exportSummaryXlsx(params)` & `reportsService.exportSummaryCsv(params)` (`responseType: 'blob'`), and `auditService.exportXlsx(params)` alongside existing `auditService.exportCsv(params)`.
  - Resident `ServicesTab.jsx` (`0 ₫` pre-start cancel unlock, `previewSubscriptionProrata`, `max={contractEffectiveEndStr}`, *"Rút yêu cầu hủy"*, `'TERMINATED'` history filter, **preserving `cancelTarget` within 400 chars of `<VehiclePlatesBadges plates={cancelTarget.vehicle_plates}` per `parkingPlatesUi.test.js:170-174`**), `InvoicesTab.jsx` & `OverviewTab.jsx` (`:1077, 1285`, excluding `'DRAFT'`/`'VOID'` from summary totals, enabling pay action on `'ADJUSTED'` when `remaining > 0`, `available_credit_balance` banner, `formula_meta` breakdown), and `NotificationsTab.jsx` (`CREDIT_*` -> `invoices` tab routing + `PAYMENT_REMINDER` / `INVOICE_ADJUSTED` labels).
  - `ContractDetailPage.jsx`: `<StatusBadge status={row.status} domain="subscription" />` (**preserving `row.note` inside `title="Dịch vụ đi kèm theo hợp đồng"` per `contractCreationUi.test.js:104-107`**), `/admin/invoices/${row.actual_invoice.id}` link on schedule, and `credit_balances` card + 4-eyes direct refund request/approve/reject modal (with optional proof image upload, `FR-040`).
  - `DepositsPage.jsx`: `credit_balance` in `AUDIT_ENTITY_META` (`:76-81`), separated `deposit_refund_amount` / `credit_refund_amount` / `total_payout_amount`, pending adjustment/refund warnings, and 1-click **"Sinh hóa đơn Pro-rata kỳ cuối"** banner when `unbilled_final_period?.has_unbilled_period === true`.
  - **`DashboardPage.jsx` (`PRD 15.1–15.3`):** plots `billed`, `invoice_settled`, and net `collected` on the 12-month revenue chart, and renders Four-eyes pending queue drill-down cards/badges for `pending_invoice_adjustments` (`-> /admin/invoices`) and `pending_credit_refunds` (`-> /admin/payments`).
  - **`ReportsPage.jsx` & `AuditLogsPage.jsx` (`AC-016.1`, `FR-058`, `RP-08`):**
    - `ReportsPage.jsx`: Tab Doanh thu (`RP-01`) renders & exports (`CSV` + `.xlsx`) `billed`, `invoice_settled`, net `collected`, `credit_refunded`; Tab Công nợ (`RP-02`) renders & exports (`CSV` + `.xlsx`) the 4 PRD overdue buckets (`0–15`, `16–30`, `31–60`, `>60` ngày + `Chưa đến hạn`); embeds `<AuditLogsView lockedScope="financial" />` as `'financial-audit'` tab (`RP-08`).
    - `AuditLogsPage.jsx`: all 12 financial entities in `ENTITY_OPTIONS`, `lockedScope` + `?scope=` support, and **both Xuất CSV & Xuất Excel (`.xlsx`)** buttons (`FR-058`).

- [ ] **Step 1: Extend `api/test/frontendBillingHelpers.test.js` with `resolveSettlementPayoutSummary` assertions**

Add unit test verifying `resolveSettlementPayoutSummary(settlement)` returns `{ depositRefund, creditRefund, totalPayout, requiresUncPayout: totalPayout > 0 }` including when `depositRefund === 0 && creditRefund > 0`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && node --test --test-concurrency=1 test/frontendBillingHelpers.test.js`
Expected: FAIL (`resolveSettlementPayoutSummary is not a function`).

- [ ] **Step 3: Implement `resolveSettlementPayoutSummary` and update Resident, Contract, Deposit, Dashboard, Reports, and Audit UI pages**

Implement all updates per **Interfaces** and Spec Section `5.6`.

- [ ] **Step 4: Run full verification gate (helper + UI contract tests, frontend lint + Vite build, and full backend test suite)**

Run: `cd api && node --test --test-concurrency=1 test/frontendBillingHelpers.test.js test/parkingPlatesUi.test.js test/contractCreationUi.test.js && cd ../frontend && npm run lint && npm run build && cd ../api && npm test`
Expected: `parkingPlatesUi.test.js` + `contractCreationUi.test.js` + `frontendBillingHelpers.test.js` PASS, `oxlint` `0` errors, `vite build` succeeds cleanly, and `npm test` passes across all suites (`0` failures).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/utils/billing.js frontend/src/services/resident.service.js frontend/src/services/reports.service.js frontend/src/services/audit.service.js frontend/src/pages/resident/tabs/ServicesTab.jsx frontend/src/pages/resident/tabs/InvoicesTab.jsx frontend/src/pages/resident/tabs/OverviewTab.jsx frontend/src/pages/resident/tabs/NotificationsTab.jsx frontend/src/pages/admin/contracts/ContractDetailPage.jsx frontend/src/pages/admin/deposits/DepositsPage.jsx frontend/src/pages/admin/dashboard/DashboardPage.jsx frontend/src/pages/admin/reports/ReportsPage.jsx frontend/src/pages/admin/audit/AuditLogsPage.jsx api/test/frontendBillingHelpers.test.js
git commit -m "feat(frontend): complete resident 0 VND cancel, credit refunds, Dashboard/RP-02 AC-016.1 KPIs, and RP-08 xlsx export"
```
