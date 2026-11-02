# M06 Phase 2 (P1): Owner Approval, Separated Payout & Voucher Evidence, RETURNED Reissue & Strict RLS Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Align M06 deposit collection, settlement, approval, disbursement, dispute, and reservation flows strictly with PRD v2.0 (`Mục 6.2`, `FR-024`, `FR-067`–`FR-068`, `R-12`, `NFR-008`, `NFR-016`) by eliminating `adminPool` RLS bypasses, enforcing `OWNER = R + A(hoàn cọc)` / `MANAGER = CRU` / `SYS_ADMIN = R` (fallback `A` only when a building has no active `OWNER`), requiring photo-backed apartment handover inspection and pre-payout resident statement notifications, separating approval (`APPROVED_PENDING_PAYOUT`) from voucher-backed payout execution (`POST /:id/payout`) while preserving pre-payout dispute `ADJUST` capability, supporting `RETURNED` bank-bounce reissue, and bounding post-settlement disputes to a single 7-day cycle.

**Architecture:** Migration `045_m06_owner_approval_and_returned_rls.sql` extends `deposit.status` (`APPROVED_PENDING_PAYOUT`, `RETURNED`) and `deposit_transaction` (`refund_reversal`, `reference_code`), tightens PostgreSQL RLS on `deposit`, `deposit_transaction`, `reservation`, and `audit_log` to match PRD Section 6.2, and introduces narrow `SECURITY DEFINER` functions (`SET search_path = public, pg_temp`) so `OWNER`, `MANAGER`, fallback `SYS_ADMIN`, and `RESIDENT` execute only their authorized workflow transitions while keeping `invoice`, `receivable`, and `apartment` strictly Read-Only (`R`) for `OWNER` at the table level. Express routes (`deposits.js`, `reservations.js`, `apartments.js`, `resident.js`), daily cron (`daily.js`), and React portals (`DepositsPage.jsx`, `ApartmentDetailPage.jsx`, `ContractTab.jsx`) separate 4-eyes approval from cash disbursement: when `refund_amount > 0`, ledger/invoice accounting is committed atomically at first `POST /:id/payout` (and immediately at `approve` when `refund_amount === 0`), keeping `037_deposit_txn_immutable.sql` intact, preserving exact `RP-07` ledger-to-`amount_held` parity at every state, and allowing pre-payout disputes to reopen `SETTLEMENT_DRAFT` via `ADJUST`.

**Tech Stack:** Node.js (ESM), Express 4, PostgreSQL 16 (RLS + `FORCE ROW LEVEL SECURITY` + `SECURITY DEFINER` helpers), `node:test`, React 19, Zustand, TailwindCSS, Vite.

**Spec:** `PRD - Quan ly Can ho va Nha cho thue v2.0.md` (`Mục 6.1–6.2`, `FR-008`, `FR-022`–`FR-025`, `FR-067`–`FR-068`, `NFR-008`, `NFR-015`–`NFR-016`, `R-12`), `docs/BAO_CAO_RA_SOAT_THU_HOAN_COC_M06.md` (`BUG-05`, `BUG-07`, `BUG-08`, `GAP-01`, `GAP-02`, `GAP-03`), and prerequisite `docs/superpowers/plans/2026-11-02-m06-phase1-p0-deposit-safety-and-reservations.md` (Migration `044`, `DEDUCTED_FULL`, `validateRefundBankInfo`, `idempotencyGuard`).
*(Note: Reporting & P2 enhancements — `RP-07` deposit ledger report/Excel export, Dashboard pending-refund KPI, monthly `OWNER` summary notification, inline `DepositsPage` Audit tab, and `FR-025` room-transfer UI — belong to M06 Phase 3 (`P2`, Migration `046`) and are out of scope for this plan.)*

## Global Constraints

- **Prerequisite Phase 1 (`044`):** `DEDUCTED_FULL` status, `validateRefundBankInfo` (`/^[A-Za-z0-9]{4,25}$/`), `isSettlementSnapshotStale` & `resolvePostSettlementStatus` in `api/src/services/depositSettlement.js`, `insertDepositAttachments` in `api/src/routes/deposits.js`, `POST /:id/transactions` blocking `type = 'transfer'` (`409 TRANSFER_INTERNAL_ONLY`), `NFR-016` Four-Eyes + mandatory `reason` on reservation `forfeit`/`refund`, `idempotencyGuard` in `api/src/middleware/idempotency.js`, and `createIdempotencyKey` / `withIdempotency` in `frontend/src/utils/idempotency.js` are already present and must be reused.
- **PRD Section 6.2 Strict RBAC Matrix on Deposits & Reservations (`BUG-08`, `NFR-016`):**
  - `MANAGER` (`CRU` on assigned buildings via `getManagerBuildingIds`): sole role allowed to create reservations (`POST /reservations`), collect additional deposits (`POST /:id/transactions` with `type = 'collect'`), submit settlement statements (`POST /:id/settlement`), execute payout with voucher (`POST /:id/payout`), mark bank bounce (`POST /:id/payout-returned`), and reopen `ADJUST` disputes before accounting commitment (`!settlement.accounting_committed_at`).
  - `OWNER` (`R + A(hoàn cọc)` on owned buildings via `getOwnerBuildingIds`): primary approver for `POST /:id/settlement/approve`, `POST /:id/settlement/reject` (on `PENDING_APPROVAL` or `APPROVED_PENDING_PAYOUT` before payout), Four-Eyes `POST /:id/resolve-dispute` (`CONFIRM`, or `ADJUST` before payout), `PATCH /reservations/:id/refund`, and `PATCH /reservations/:id/forfeit` (`FR-067`, `NFR-016`). `OWNER` remains 100% blocked (`403` + RLS) from `CRU` actions and from direct `INSERT/UPDATE/DELETE` on `apartment`, `invoice`, and `receivable`.
  - Four-Eyes internal approval (`PRD Mục 6.1`, `NFR-016`, `R-23`): a second `MANAGER` assigned to the same building (`actorId !== creatorId`) may also approve/reject settlement or refund/forfeit reservations (or self-approve with `SELF_APPROVAL_WARNING` in `audit_log` only when org setting `approval_config.allow_self_approval === true`).
  - `SYS_ADMIN` (`R` org-wide per `PRD Mục 6.2` line 189): strictly Read-Only (`403` on all deposit/reservation `CRU`, and `403` on `A` whenever `building_has_active_owner(building_id) = true`), acting as fallback approver (`A`) **only** when a building has no active `OWNER` (`!building_has_active_owner(building_id)`), matching `041_contract_owner_price_approval_rls.sql`.
  - `RESIDENT` (`R` on `get_resident_contract_ids()`): read-only on ledger/statement/PDF, plus scoped workflow actions via `SECURITY DEFINER` RPCs (`POST /:id/dispute` and `PATCH /:id/bank-info` on primary tenant's `APPROVED_PENDING_PAYOUT` / `RETURNED` deposit).
- **Zero `adminPool` in `api/src/routes/deposits.js` (`BUG-07`, `NFR-008`):** Remove `adminPool` import from `deposits.js`; every query must execute through `pool` / `getUserClient(req)` (`appPool` with `app.current_user_id` under `FORCE ROW LEVEL SECURITY`).
- **Immutable Ledger, Deferred Pre-Payout Accounting & `RP-07` Parity (`037_deposit_txn_immutable.sql`, `FR-024`, `R-12`, `GAP-01`, `GAP-02`):** `trg_deposit_txn_immutable` forbids `UPDATE`/`DELETE` on `deposit_transaction` where `status = 'APPROVED'`, and Phase 3 `RP-07` requires `opening_held + collected + transfer_in + refund_reversed - deducted - refunded - transfer_out === closing_held === SUM(deposit.amount_held)` at every state. Therefore:
  1. `POST /:id/settlement` (`MANAGER`) transitions `HELD/SETTLEMENT_DRAFT -> PENDING_APPROVAL` (`accounting_committed_at: null`) and immediately notifies **both** contract `RESIDENT` (`SETTLEMENT_STATEMENT_READY` — `R-12` *"bảng kê khấu trừ gửi cư dân trước khi chi"*) and building `OWNER` (`SETTLEMENT_PENDING_APPROVAL`, or `BUILDING_MANAGERS` if `!building_has_active_owner`).
  2. `POST /:id/settlement/approve` (`OWNER` / Four-Eyes approver):
     - If `refund_amount === 0` (no payout step): immediately writes capped `deduct` `deposit_transaction` rows (`SUM(deduct) === heldBefore`), calls `fn_apply_deposit_settlement_accounting`, sets `accounting_committed_at = NOW()`, `amount_held = 0`, and finalizes to `DEDUCTED_FULL` (or `REFUNDED` when `0 ₫` deposit had zero deductions).
     - If `refund_amount > 0`: verifies no open-invoice drift (`409 SETTLEMENT_SNAPSHOT_STALE`) and Four-Eyes (`403 SELF_APPROVAL`), records `approved_by` + `approved_at` in `settlement`, keeps `amount_held = deposit_held_before_settlement` (actual cash still held in deposit account), and transitions to `APPROVED_PENDING_PAYOUT` **without** writing `deduct` or `refund` ledger rows yet.
  3. `POST /:id/payout` (`MANAGER`):
     - First-time payout (`status === 'APPROVED_PENDING_PAYOUT'`, `!settlement.accounting_committed_at`): requires `evidence` (`>= 1` UNC file) when `method === 'BANK_TRANSFER'` (`422 PAYOUT_EVIDENCE_REQUIRED`), verifies `SETTLEMENT_SNAPSHOT_STALE` (`409`), commits capped `deduct` rows (`approved_by = settlement.approved_by`, `approved_at = settlement.approved_at`) + `fn_apply_deposit_settlement_accounting` + immutable `deposit_transaction(type='refund', status='APPROVED', evidence, reference_code)`, sets `accounting_committed_at = NOW()`, `payout_at = NOW()`, `amount_held = 0`, and transitions to `REFUNDED` / `PARTIALLY_REFUNDED`.
     - Reissue payout (`status === 'RETURNED'`, `Boolean(settlement.accounting_committed_at)`): skips already-committed deductions/invoices, requires `evidence` (`422 PAYOUT_EVIDENCE_REQUIRED` for `BANK_TRANSFER`) + valid `bank_info`, inserts the new immutable `deposit_transaction(type='refund', amount=amount_held, status='APPROVED')`, sets `amount_held = 0`, records `reissued_at` / `reissue_history`, and transitions to `REFUNDED` / `PARTIALLY_REFUNDED`.
- **Mandatory Handover Inspection With Photo (`GAP-03`, `FR-024`, `R-12`):** When a contract has `movedIn === true`, `POST /:id/settlement` must fail with `409 MISSING_APARTMENT_INSPECTION` unless either an `audit_log(entity='apartment', action='HANDOVER')` on `at::date >= eff_end_date` contains `>= 1` photo in `after.evidence`, or `inspection_evidence` (`>= 1` photo) is supplied on the settlement.
- **Dispute Locking, Pre-Payout `ADJUST` & 7-Day Single-Cycle Window (`FR-024` line 510, `R-12` line 1326, `BUG-05`):**
  - While `status === 'DISPUTED'`, both `POST /:id/settlement/approve` and `POST /:id/payout` return `409 SETTLEMENT_DISPUTED`.
  - Before accounting is committed (`!settlement.accounting_committed_at`, i.e., dispute raised from `PENDING_APPROVAL` or `APPROVED_PENDING_PAYOUT`), `POST /:id/resolve-dispute` with `resolution = 'ADJUST'` clears `approved_by`/`approved_at` and reopens `SETTLEMENT_DRAFT` so `MANAGER` can revise deductions and resubmit for approval. Once `Boolean(settlement.accounting_committed_at)` (`PARTIALLY_REFUNDED`, `REFUNDED`, `DEDUCTED_FULL`), `ADJUST` returns `409 { code: 'ALREADY_PAID_OUT' }`.
  - Post-settlement disputes (`PARTIALLY_REFUNDED`, `REFUNDED`, `DEDUCTED_FULL`) are accepted only within `7 days` of `COALESCE(payout_at, approved_at)` (`409 DISPUTE_WINDOW_EXPIRED` afterwards) and at most once after finalization (`post_settlement_dispute_closed = true` after Four-Eyes `CONFIRM` -> `409 DISPUTE_ALREADY_FINALIZED`).
- **Monetary Precision & Vietnamese UI Copy:** All VND amounts remain integer `BIGINT` (`>= 0`); all user-facing API messages and UI labels must be idiomatic Vietnamese with diacritics.

## Review Focus

1. **Immutability trigger (`037_deposit_txn_immutable.sql`) & `RP-07` ledger parity vs. UNC voucher attachment:** Creating `refund` (or partial `deduct`) rows at `approve` time when `refund_amount > 0` would either violate `trg_deposit_txn_immutable` on later UNC upload or break pre-payout `ADJUST` (`FR-024`). `approve` must defer ledger/invoice commit to `POST /:id/payout` when `refund_amount > 0` (committing immediately only when `refund_amount === 0`), and `POST /:id/payout` must require `evidence` (`422 PAYOUT_EVIDENCE_REQUIRED` for `BANK_TRANSFER`) before writing immutable rows. *(Pinned in Task 4)*
2. **Pre-payout vs. post-payout dispute resolution (`FR-024` line 510, `R-12` line 1326):** Disputing at `APPROVED_PENDING_PAYOUT` must block `POST /:id/payout` (`409 SETTLEMENT_DISPUTED`), allow `ADJUST -> SETTLEMENT_DRAFT` (clearing `approved_by`/`approved_at` so revised statements require fresh Four-Eyes approval), and require Four-Eyes (`403 SELF_APPROVAL` on creator) when resolving `CONFIRM -> APPROVED_PENDING_PAYOUT`; once `accounting_committed_at` is set, `ADJUST` must fail `409 ALREADY_PAID_OUT`. *(Pinned in Task 1 & Task 4)*
3. **`SYS_ADMIN` attempting deposit `CRU` or `A` on a building that already has an active `OWNER` (`PRD Mục 6.2`):** `SYS_ADMIN` must receive `403` on `collect`, `settlement`, `payout`, `payout-returned`, `POST /reservations`, and on `approve`/`reject`/`refund`/`forfeit` when `building_has_active_owner = true`, succeeding as fallback approver (`200`) only on buildings with `owner_id IS NULL` (or inactive `OWNER`). *(Pinned in Task 2)*
4. **`OWNER` approval side-effects on `invoice`, `receivable`, and `apartment` under `FORCE ROW LEVEL SECURITY`:** `OWNER` approving a zero-refund settlement (`DEDUCTED_FULL`, offsetting open `invoice` service debt without touching `RENT` and upserting `RECEIVABLE_AFTER_MOVE_OUT`) or refunding/forfeiting a reservation (`RESERVED -> AVAILABLE`) must succeed via narrow `SECURITY DEFINER` helpers while raw `UPDATE invoice / receivable / apartment` by `OWNER` remains blocked (`0 rows` / RLS error). *(Pinned in Task 1 & Task 2)*
5. **Infinite post-settlement dispute loops & invalid `payout-returned` on zero-refund settlements:** Re-submitting `POST /:id/dispute` after a post-settlement dispute was closed with Four-Eyes `CONFIRM` must fail `409 DISPUTE_ALREADY_FINALIZED` even within 7 days; calling `POST /:id/payout-returned` on `DEDUCTED_FULL` (`refund_amount = 0`) must fail `409 INVALID_DEPOSIT_STATUS_FOR_RETURN`. *(Pinned in Task 1 & Task 4)*

---

## File Structure

- **Create:** `api/src/db/migrations/045_m06_owner_approval_and_returned_rls.sql` — Schema extensions (`APPROVED_PENDING_PAYOUT`, `RETURNED`, `refund_reversal`, `reference_code`), PRD 6.2 RLS policies (`deposit`, `deposit_transaction`, `reservation`, `audit_log`), and narrow `SECURITY DEFINER` functions (`fn_get_deposit_access_meta`, `fn_apply_deposit_settlement_accounting`, `fn_sync_apartment_status_after_reservation`, `fn_submit_deposit_dispute`, `fn_update_deposit_refund_bank_info`, `fn_notify_deposit_event`).
- **Modify:** `api/src/routes/deposits.js` — Remove `adminPool`, enforce PRD 6.2 RBAC + Four-Eyes, `saveBase64Image`-backed evidence normalization, pre-payout `RESIDENT`/`OWNER` notifications, handover precondition, deferred-accounting `APPROVED_PENDING_PAYOUT -> payout -> payout-returned -> bank-info` lifecycle, pre-payout `ADJUST` support, post-settlement PDF/detail snapshot reads, and 7-day single-cycle dispute guard.
- **Modify:** `api/src/routes/reservations.js` — Restrict `POST /` to `MANAGER`, allow `OWNER` + Four-Eyes `MANAGER` + fallback `SYS_ADMIN` (with mandatory `reason` per `NFR-016`) on `forfeit` and `refund` via `fn_sync_apartment_status_after_reservation`, expose `building_has_active_owner`.
- **Modify:** `api/src/routes/apartments.js` — Remove `adminPool` in `PATCH /:id/handover`, restrict to `['SYS_ADMIN', 'MANAGER']` (`PRD 6.2`), and store `{ note, checklist, evidence, keep_maintenance }` via `saveBase64Image` (`attachment`) + `audit_log.after`.
- **Modify:** `api/src/routes/resident.js` — Include `'APPROVED_PENDING_PAYOUT'`, `'DEDUCTED_FULL'`, and `'RETURNED'` in `GET /overview` `depositSettlements` filter.
- **Modify:** `api/src/jobs/daily.js` — Extract & export `runOverdueDepositSettlementAlerts()`, exclude `'DEDUCTED_FULL'` across all 3 overdue deposit filters (`lines 40, 85, 376`), and notify active building `OWNER`s on `DEPOSIT_OVERDUE_5D`.
- **Create:** `frontend/src/utils/depositUiHelpers.js` — Pure permission, status-action, and 7-day dispute window helpers shared by Admin & Resident portals.
- **Modify:** `frontend/src/constants/statuses.js`, `frontend/src/hooks/usePermission.js`, `frontend/src/services/deposits.service.js`, `frontend/src/services/resident.service.js`, `frontend/src/services/buildings.service.js`, `frontend/src/pages/admin/apartments/ApartmentDetailPage.jsx`, `frontend/src/pages/admin/deposits/DepositsPage.jsx`, `frontend/src/pages/resident/tabs/ContractTab.jsx`.
- **Tests:**
  - Create: `api/test/m06Phase2RlsAndDisputeWindow.test.js`, `api/test/m06Phase2OwnerApprovalAndEscalation.test.js`, `api/test/m06Phase2HandoverPrecondition.test.js`, `api/test/m06Phase2PayoutAndReturnedFlow.test.js`, `frontend/src/utils/__tests__/m06Phase2Ui.test.js`.
  - Modify (align Phase 1 & existing E2E regression assertions with PRD 6.2, handover inspection & separated payout): `api/test/m06Phase1P0Fixes.test.js`, `api/test/depositCollectAndRefund.test.js`, `api/test/fullWebsiteWhiteBlackBox.test.js`, `api/test/multiBuildingAndFutureContract.test.js`, `api/test/remediationR01ToR24.test.js`.

---

### Task 1: Migration `045` (Schema, Strict PRD 6.2 RLS & `SECURITY DEFINER` Helpers), Eliminate `adminPool` in `deposits.js` & 7-Day Single-Cycle Dispute Guard (`BUG-05`, `BUG-07`, `NFR-008`)

**Files:**
- Create: `api/src/db/migrations/045_m06_owner_approval_and_returned_rls.sql`
- Modify: `api/src/routes/deposits.js`
- Create: `api/test/m06Phase2RlsAndDisputeWindow.test.js`

**Interfaces:**
- Consumes: `building_has_active_owner(UUID)` (`041`), `get_owner_building_ids()`, `get_manager_building_ids()`, `get_resident_contract_ids()`, `get_resident_tenant_ids()`, `DEDUCTED_FULL` (`044`), `getUserClient(req)` (`api/src/db/client.js`), `saveBase64Image` (`api/src/services/imageUpload.js`), `checkFourEyesOrWarn` (`api/src/services/pricing.js`).
- Produces:
  - `deposit.status` CHECK: `('HELD','SETTLEMENT_DRAFT','PENDING_APPROVAL','APPROVED_PENDING_PAYOUT','PARTIALLY_REFUNDED','REFUNDED','DEDUCTED_FULL','TRANSFERRED','DISPUTED','RETURNED')`
  - `deposit_transaction.type` CHECK: `('collect','deduct','refund','transfer','refund_reversal')`; column `deposit_transaction.reference_code TEXT`
  - SQL RPCs (`SECURITY DEFINER SET search_path = public, pg_temp`):
    - `fn_get_deposit_access_meta(p_deposit_id UUID) RETURNS TABLE(deposit_id UUID, contract_id UUID, apartment_id UUID, building_id UUID, org_id UUID, building_has_active_owner BOOLEAN, is_contract_resident BOOLEAN, is_primary_resident BOOLEAN, latest_photo_handover_at TIMESTAMPTZ)`
    - `fn_apply_deposit_settlement_accounting(p_deposit_id UUID, p_covered_service_debt BIGINT, p_uncovered_items_shortfall BIGINT) RETURNS VOID`
    - `fn_sync_apartment_status_after_reservation(p_apartment_id UUID) RETURNS TEXT`
    - `fn_submit_deposit_dispute(p_deposit_id UUID, p_reason TEXT) RETURNS deposit`
    - `fn_update_deposit_refund_bank_info(p_deposit_id UUID, p_bank_info JSONB) RETURNS deposit`
    - `fn_notify_deposit_event(p_deposit_id UUID, p_target_audience TEXT, p_type TEXT, p_title TEXT, p_content TEXT, p_payload JSONB DEFAULT '{}'::jsonb, p_specific_user_id UUID DEFAULT NULL) RETURNS INT`

- [ ] **Step 1: Write the failing RLS, `adminPool`-elimination & 7-day single-cycle dispute test (`api/test/m06Phase2RlsAndDisputeWindow.test.js`)**

Cover these exact assertions:
1. Static check: `fs.readFileSync('src/routes/deposits.js', 'utf8')` contains **zero** occurrences of `adminPool`.
2. Direct `appPool` RLS check:
   - `OWNER` of `VOP-A` **cannot** directly `UPDATE invoice`, `INSERT INTO receivable`, `UPDATE apartment`, or `UPDATE deposit` when `deposit.status = 'HELD'` (`0 rows` or `42501`).
   - `SYS_ADMIN` **cannot** directly `INSERT INTO deposit_transaction` or `UPDATE deposit` on `VOP-A` (where `building_has_active_owner(vopAId) = true`) via `appPool`.
   - Co-occupant (`contract_occupant`) `RESIDENT` calling `GET /api/v1/deposits/:id/transactions`, `GET /api/v1/deposits/:id/settlement`, and `GET /api/v1/deposits/:id/settlement/pdf` receives `200` (not `404` from `INNER JOIN tenant/person` RLS filtering).
   - Unassigned `MANAGER` (`VOP-B`) accessing a `VOP-A` deposit receives `403 ACCESS_DENIED` and writes an `ACCESS_DENIED` row to `audit_log`.
3. Dispute window & single-cycle lock (`BUG-05`):
   - When `settlement.payout_at` (or `approved_at` on `DEDUCTED_FULL`) is older than `7 days` (`NOW() - INTERVAL '8 days'`), `POST /api/v1/deposits/:id/dispute` by `RESIDENT` fails with `409` and `code: 'DISPUTE_WINDOW_EXPIRED'`.
   - Within `7 days` of finalization (`accounting_committed_at` set), `RESIDENT` disputes (`200 DISPUTED`, appending `{ type: 'DISPUTE', ... }` to `settlement.dispute_thread` and logging `SETTLEMENT_DISPUTE` in `audit_log`); `POST /:id/resolve-dispute` with `{ resolution: 'ADJUST' }` fails `409 ALREADY_PAID_OUT`; settlement creator (`MANAGER_A`) attempting `{ resolution: 'CONFIRM' }` fails `403 SELF_APPROVAL`; `OWNER` resolving with `{ resolution: 'CONFIRM', notes: '...' }` succeeds (`200`), restores the finalized status, and sets `settlement.post_settlement_dispute_closed = true`.
   - Immediately re-submitting `POST /api/v1/deposits/:id/dispute` by `RESIDENT` (even within the 7-day window) fails with `409` and `code: 'DISPUTE_ALREADY_FINALIZED'`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd d:\resihub\api; node --test test/m06Phase2RlsAndDisputeWindow.test.js`
Expected: FAIL (`deposits.js` still imports `adminPool`, migration `045` and dispute guards do not exist yet).

- [ ] **Step 3: Create `api/src/db/migrations/045_m06_owner_approval_and_returned_rls.sql`**

Implement in `045_m06_owner_approval_and_returned_rls.sql`:
1. Dynamically drop existing `status` CHECK constraints on `deposit` and recreate `deposit_status_check` allowing all 10 statuses listed in `Interfaces`.
2. Add `reference_code TEXT` to `deposit_transaction`; dynamically drop existing `type` CHECK constraints on `deposit_transaction` and recreate `deposit_transaction_type_check` allowing `('collect','deduct','refund','transfer','refund_reversal')`.
3. Recreate RLS policies per PRD Section 6.2:
   - `rls_deposit_insert`: `is_manager()` scoped to `c.building_id IN (SELECT building_id FROM get_manager_building_ids())`.
   - `rls_deposit_update`:
     - `is_manager()` scoped to `get_manager_building_ids()`, OR
     - `(is_owner() AND c.building_id IN (SELECT building_id FROM get_owner_building_ids()))` and fallback `(is_org_admin() AND NOT building_has_active_owner(c.building_id))` restricted in `USING` to `deposit.status IN ('PENDING_APPROVAL', 'APPROVED_PENDING_PAYOUT', 'DISPUTED')` and in `WITH CHECK` to `deposit.status IN ('SETTLEMENT_DRAFT', 'PENDING_APPROVAL', 'APPROVED_PENDING_PAYOUT', 'PARTIALLY_REFUNDED', 'REFUNDED', 'DEDUCTED_FULL')`.
   - `rls_deposit_txn_insert`:
     - `is_manager()` scoped to `get_manager_building_ids()`, OR
     - `(is_owner() on get_owner_building_ids() OR (is_org_admin() AND NOT building_has_active_owner(c.building_id)))` **only when `deposit_transaction.type = 'deduct'`** (needed when `OWNER`/fallback `SYS_ADMIN` approves a `refund_amount = 0` `DEDUCTED_FULL` settlement).
   - `rls_reservation_insert`: `is_manager()` on `get_manager_building_ids()`.
   - `rls_reservation_update`: `is_manager()` on `get_manager_building_ids()`, OR (`is_owner()` on `get_owner_building_ids()` / fallback `is_org_admin()` when `NOT building_has_active_owner(building_id)`) with `USING (status IN ('HELD', 'EXPIRED'))` and `WITH CHECK (status IN ('REFUNDED', 'FORFEITED'))`.
   - `rls_audit_log_select`: preserve `SYS_ADMIN` and `OWNER` rules from `038_audit_log_deposit_owner_scope.sql`, and add `is_manager()` read access for `entity IN ('apartment','deposit','deposit_transaction','reservation')` scoped to `get_manager_building_ids()`.
   - Do **not** add `is_owner()` to `rls_invoice_modify`, `rls_receivable_modify`, or `rls_apartment_update`.
4. Create the 6 narrow `SECURITY DEFINER SET search_path = public, pg_temp` functions listed in `Interfaces`, granting `EXECUTE` to `PUBLIC` (or `resihub_app` if role exists):
   - `fn_get_deposit_access_meta`: verifies `b.org_id = get_current_user_org_id()`, computes `latest_photo_handover_at` from `audit_log` (`entity = 'apartment'`, `action = 'HANDOVER'`, `entity_id = c.apartment_id`, `at::date >= COALESCE(c.terminated_at, c.end_date)::date`, `jsonb_array_length(COALESCE(after->'evidence', '[]'::jsonb)) >= 1`), and returns `{ deposit_id, contract_id, apartment_id, building_id, org_id, building_has_active_owner, is_contract_resident, is_primary_resident, latest_photo_handover_at }` with zero financial/PII columns.
   - `fn_apply_deposit_settlement_accounting`: verifies caller is authorized (`OWNER` of building, `MANAGER` of building, or fallback `SYS_ADMIN` when `NOT building_has_active_owner(c.building_id)`) and deposit is in `('PENDING_APPROVAL','APPROVED_PENDING_PAYOUT','PARTIALLY_REFUNDED','REFUNDED','DEDUCTED_FULL')`; replicates the exact per-invoice `RENT` (`item_type = 'RENT'`) vs `non-RENT` (`item_type <> 'RENT'`) split from `deposits.js:40-109, 1074-1178`:
     1. Iterates open `invoice` rows (`ISSUED`, `PARTIALLY_PAID`, `OVERDUE`) for `d.contract_id` ordered `period ASC, created_at ASC FOR UPDATE`.
     2. Computes `inv_rent_unpaid` and `inv_service_unpaid` (`paid_amount` covers `RENT` first), allocates `p_covered_service_debt` FIFO **only** against `inv_service_unpaid` (never touching `RENT` per `R-06`), updates `invoice.paid_amount` & `status` (`PAID` / `PARTIALLY_PAID`) + writes `audit_log(action='SETTLEMENT_OFFSET', entity='invoice')`.
     3. For any remaining unpaid balance on that invoice (`new_remaining = total_amount - new_paid > 0`, including `RENT` + uncovered service debt), updates `receivable WHERE invoice_id = inv.id AND status IN ('OPEN', 'PARTIALLY_PAID')` (`amount_due = GREATEST(paid_amount, total_amount)`, `status = CASE WHEN new_paid > 0 THEN 'PARTIALLY_PAID' ELSE status END`), inserting a new `receivable` (`source_type = 'RECEIVABLE_AFTER_MOVE_OUT'`, `invoice_id = inv.id`, `due_date = CURRENT_DATE + 7`) **only if `NOT FOUND`**.
     4. When `p_uncovered_items_shortfall > 0` (`GREATEST(0, sum_items - held_before)`), inserts one contract-level `receivable` (`source_type = 'RECEIVABLE_AFTER_MOVE_OUT'`, `invoice_id = NULL`, `amount_due = p_uncovered_items_shortfall`, `due_date = CURRENT_DATE + 7`).
   - `fn_sync_apartment_status_after_reservation`: verifies caller is `MANAGER`/`OWNER`/fallback `SYS_ADMIN` of `a.building_id`; mirrors `api/src/services/apartmentStatus.js` (`BLOCKED`/`INACTIVE` unchanged; active contract -> `OCCUPIED`; active `HELD` reservation -> `RESERVED`; existing `MAINTENANCE` -> `MAINTENANCE`; else -> `AVAILABLE`).
   - `fn_submit_deposit_dispute`: verifies caller's contract is in `get_resident_contract_ids()`; rejects `'DISPUTE_ALREADY_FINALIZED'` when `settlement->>'post_settlement_dispute_closed' = 'true'`; rejects `'DISPUTE_NOT_ALLOWED'` if `status NOT IN ('PENDING_APPROVAL','APPROVED_PENDING_PAYOUT','PARTIALLY_REFUNDED','REFUNDED','DEDUCTED_FULL')`; when `COALESCE(settlement->>'accounting_committed_at', '') <> ''` or `status IN ('PARTIALLY_REFUNDED','REFUNDED','DEDUCTED_FULL')`, enforces `NOW() <= COALESCE((settlement->>'payout_at')::timestamptz, (settlement->>'approved_at')::timestamptz) + INTERVAL '7 days'` else raises `'DISPUTE_WINDOW_EXPIRED'`; stores `previous_status_before_dispute`, appends `{ "type": "DISPUTE", "at": ..., "by": get_current_user_id(), "role": "RESIDENT", "message": p_reason }` to `settlement->'dispute_thread'`, sets `status = 'DISPUTED'`, writes `audit_log(action = 'SETTLEMENT_DISPUTE', entity = 'deposit')`, returns `deposit`.
   - `fn_update_deposit_refund_bank_info`: verifies caller is `MANAGER` of `c.building_id` or primary `RESIDENT` (`c.primary_tenant_id IN (SELECT tenant_id FROM get_resident_tenant_ids())`), `status IN ('APPROVED_PENDING_PAYOUT','RETURNED')`, and `COALESCE((settlement->>'refund_amount')::bigint, 0) > 0`; updates `settlement.bank_info`, writes `audit_log(action = 'UPDATE_BANK_INFO', entity = 'deposit')`, returns `deposit`.
   - `fn_notify_deposit_event`: verifies caller has access to `p_deposit_id` in `get_current_user_org_id()`, resolves target `ACTIVE` `app_user.id`s (`RESIDENT`, `BUILDING_OWNERS`, `BUILDING_MANAGERS`, or `SPECIFIC_USER`), inserts into `notification (org_id, user_id, title, content, type, payload)` (matching `011_notifications.sql`), returns inserted count.

- [ ] **Step 4: Remove `adminPool` from `api/src/routes/deposits.js` and enforce snapshot/dispute/evidence helpers**

In `api/src/routes/deposits.js`:
1. Change line 2 import to `import { pool, getUserClient } from '../db/client.js';` and import `saveBase64Image` from `'../services/imageUpload.js'`.
2. Upgrade Phase 1's `insertDepositAttachments` / add `normalizeAndPersistEvidence(client, { entity, ownerId, folder, evidence, req })`: for each string in `evidence`, if it starts with `'data:'`, call `saveBase64Image({ imageBase64: item, folder, entityId: ownerId, entity, ownerId, req, query: client.query.bind(client), allowPdf: true })` (`uploaded_by = req.user.sub`) and replace it with `/api/v1/attachments/${saved.attachment.id}/view`; if it is an external `http(s)://...` URL, insert an `attachment(owner_entity, owner_id, storage_path, uploaded_by = req.user.sub)` record while keeping the `http(s)://...` URL in `evidence` (preserving existing `/api/v1/attachments/...` URLs without re-inserting).
3. Replace every `adminPool` existence/scope check with `SELECT * FROM fn_get_deposit_access_meta($1)` on `pool` / `client` (`0 rows` -> `404 NOT_FOUND`; unauthorized building/contract -> `await logAccessDenied(...)` + `403 ACCESS_DENIED`).
4. Change `INNER JOIN tenant t ... JOIN person p` to `LEFT JOIN tenant t ON t.id = c.primary_tenant_id LEFT JOIN person p ON p.id = t.person_id` in `GET /`, `GET /:id/transactions`, `GET /:id/settlement`, and `GET /:id/settlement/pdf` (using `escapeHtml(row.tenant_name || 'Khách thuê')` in PDF) so co-occupants (`contract_occupant`) are never filtered out by `rls_tenant_select` / `rls_person_select`.
5. Replace all `adminPool` notification queries with `SELECT fn_notify_deposit_event(...)` via `client.query`.
6. In `GET /:id/settlement` and `GET /:id/settlement/pdf`, define `isAccountingCommitted = Boolean(saved?.accounting_committed_at) || ['PARTIALLY_REFUNDED', 'REFUNDED', 'DEDUCTED_FULL', 'RETURNED'].includes(row.status)` so `effectiveServiceDebt`, `effectiveRentDebt`, and `heldForCalc` (`saved.deposit_held_before_settlement`) read settled snapshots once invoices/ledger have been committed, and compute `snapshot_stale` (via `isSettlementSnapshotStale`) for both `'PENDING_APPROVAL'` and `'APPROVED_PENDING_PAYOUT'`.
7. Refactor `POST /:id/dispute` to call `SELECT * FROM fn_submit_deposit_dispute($1, $2)`, mapping `'DISPUTE_WINDOW_EXPIRED'` -> `409 { code: 'DISPUTE_WINDOW_EXPIRED' }`, `'DISPUTE_ALREADY_FINALIZED'` -> `409 { code: 'DISPUTE_ALREADY_FINALIZED' }`, and `'DISPUTE_NOT_ALLOWED'` -> `409 { code: 'INVALID_STATUS_FOR_DISPUTE' }`.
8. In `POST /:id/resolve-dispute`:
   - If `resolution === 'ADJUST'`: block with `409 { code: 'ALREADY_PAID_OUT' }` whenever `Boolean(settlement.accounting_committed_at)` (or `previous_status_before_dispute` in `['PARTIALLY_REFUNDED', 'REFUNDED', 'DEDUCTED_FULL']`); when `!settlement.accounting_committed_at` (including disputes raised from `APPROVED_PENDING_PAYOUT`), clear `approved_by` and `approved_at` and transition to `'SETTLEMENT_DRAFT'`.
   - If `resolution === 'CONFIRM'` and `Boolean(settlement.approved_at)`: run `checkFourEyesOrWarn({ orgId: req.user.org_id, actorId: req.user.sub, creatorId: settlement.created_by, entity: 'deposit', entityId: id, actionContext: 'RESOLVE_DISPUTE_CONFIRM' })` (`!allowed` -> `403 { code: 'SELF_APPROVAL' }`); if `Boolean(settlement.accounting_committed_at)`, set `post_settlement_dispute_closed: true` on `settlement`.

- [ ] **Step 5: Run migration and verify tests pass**

Run: `cd d:\resihub\api; npm run migrate; node --test test/m06Phase2RlsAndDisputeWindow.test.js`
Expected: PASS (all subtests green, zero `adminPool` references in `deposits.js`).

- [ ] **Step 6: Commit**

```bash
git add api/src/db/migrations/045_m06_owner_approval_and_returned_rls.sql api/src/routes/deposits.js api/test/m06Phase2RlsAndDisputeWindow.test.js
git commit -m "feat(m06): enforce strict PRD 6.2 deposit RLS, drop adminPool, bound dispute window"
```

---

### Task 2: Strict PRD 6.2 Role Matrix (`OWNER` `R + A`, `MANAGER` `CRU`, `SYS_ADMIN` `R` + Fallback), Pre-Payout Statement Notification (`R-12`) & 5-Day Overdue Owner Escalation (`BUG-08`, `FR-068`)

**Files:**
- Modify: `api/src/routes/deposits.js`
- Modify: `api/src/routes/reservations.js`
- Modify: `api/src/jobs/daily.js`
- Create: `api/test/m06Phase2OwnerApprovalAndEscalation.test.js`
- Modify: `api/test/m06Phase1P0Fixes.test.js`, `api/test/depositCollectAndRefund.test.js`, `api/test/fullWebsiteWhiteBlackBox.test.js`, `api/test/multiBuildingAndFutureContract.test.js`, `api/test/remediationR01ToR24.test.js`

**Interfaces:**
- Consumes: `fn_get_deposit_access_meta`, `fn_notify_deposit_event`, `fn_sync_apartment_status_after_reservation`, `building_has_active_owner(UUID)` from Task 1; `checkFourEyesOrWarn` (`api/src/services/pricing.js`).
- Produces:
  - Helper `canActAsDepositApprover(req, { buildingId, buildingHasActiveOwner, entity, entityId }) -> Promise<boolean>` in `deposits.js` (and equivalent check in `reservations.js`): allows owning `OWNER`, assigned `MANAGER` of `buildingId` (subject to `checkFourEyesOrWarn` against `created_by` on approval/refund), or `SYS_ADMIN` **only when `!buildingHasActiveOwner`** (logging `ACCESS_DENIED` and returning `false` otherwise).
  - `GET /api/v1/deposits` and `GET /api/v1/reservations` include `building_has_active_owner: boolean` on each row.
  - Pre-payout notifications on `POST /:id/settlement`: `SETTLEMENT_STATEMENT_READY` (to `RESIDENT`) + `SETTLEMENT_PENDING_APPROVAL` (to `BUILDING_OWNERS`, or `BUILDING_MANAGERS` if `!building_has_active_owner`).
  - Rejection notification on `POST /:id/settlement/reject` (accepted on `PENDING_APPROVAL` and `APPROVED_PENDING_PAYOUT` while `!settlement.accounting_committed_at`, clearing `approved_by`/`approved_at`): `SETTLEMENT_REJECTED` (to `settlement.created_by`).
  - Exported `runOverdueDepositSettlementAlerts()` in `api/src/jobs/daily.js`: excludes `'DEDUCTED_FULL'` across all 3 overdue deposit filters (`lines 40, 85, 376`), and sends `DEPOSIT_OVERDUE_5D` to active building `OWNER`s as well as `MANAGER`s (notifying `SYS_ADMIN` only when `!building_has_active_owner`).

- [ ] **Step 1: Write the failing `OWNER` approval, `SYS_ADMIN = R` & 5-day escalation test (`api/test/m06Phase2OwnerApprovalAndEscalation.test.js`)**

Cover these exact assertions:
1. On `VOP-A` (`building_has_active_owner = true`):
   - `SYS_ADMIN` gets `403` on `POST /api/v1/deposits/:id/transactions`, `POST /api/v1/deposits/:id/settlement`, `POST /api/v1/deposits/:id/settlement/approve`, `POST /api/v1/deposits/:id/settlement/reject`, `POST /api/v1/reservations`, `PATCH /api/v1/reservations/:id/refund`, and `PATCH /api/v1/reservations/:id/forfeit`.
   - `OWNER` of `VOP-A` gets `403` on `POST /api/v1/deposits/:id/transactions`, `POST /api/v1/deposits/:id/settlement`, and `POST /api/v1/reservations`.
   - `MANAGER` submits `POST /:id/settlement` -> immediately creates `SETTLEMENT_STATEMENT_READY` notification for contract `RESIDENT` (`R-12`) AND `SETTLEMENT_PENDING_APPROVAL` notification for `VOP-A` `OWNER` (`FR-024`).
   - Unrelated `OWNER` (owning another building) gets `403 ACCESS_DENIED` on `approve`/`reject`.
   - `VOP-A` `OWNER` calls `POST /:id/settlement/reject` (`200 SETTLEMENT_DRAFT`) -> notifies creator `MANAGER` with `SETTLEMENT_REJECTED`; after resubmission, `VOP-A` `OWNER` calls `POST /:id/settlement/approve` -> `200`.
   - `VOP-A` `OWNER` calls `PATCH /api/v1/reservations/:id/refund` and `PATCH /api/v1/reservations/:id/forfeit` (with `{ reason: '...' }` per `NFR-016`) -> `200`, and `apartment.status` transitions `RESERVED -> AVAILABLE` without RLS error (while creator `MANAGER` gets `403 FOUR_EYES_VIOLATION` on both `refund` and `forfeit`).
2. On a temporary building created with `owner_id = NULL` (`building_has_active_owner = false`):
   - `SYS_ADMIN` still gets `403` on `CRU` (`collect`, `settlement`), **but succeeds (`200`)** as fallback approver on `POST /:id/settlement/approve` and `PATCH /api/v1/reservations/:id/refund`.
3. `runOverdueDepositSettlementAlerts()` (`FR-068`):
   - Terminated contract `>= 5` days ago with unsettled deposit (`HELD`, `PENDING_APPROVAL`, `APPROVED_PENDING_PAYOUT`, or `RETURNED`) creates a `DEPOSIT_OVERDUE_5D` notification for `VOP-A`'s active `OWNER`.
   - Deposit with `status = 'DEDUCTED_FULL'` produces **zero** overdue notifications.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd d:\resihub\api; node --test test/m06Phase2OwnerApprovalAndEscalation.test.js`
Expected: FAIL (`SYS_ADMIN` currently allowed on `VOP-A`, `OWNER` blocked `403`, `SETTLEMENT_STATEMENT_READY` and `OWNER` `5D` notifications missing).

- [ ] **Step 3: Implement PRD 6.2 RBAC & notifications in `deposits.js`, `reservations.js`, and `daily.js`, and align regression tests**

1. **`api/src/routes/deposits.js`:**
   - Change `POST /:id/transactions` and `POST /:id/settlement` middleware to `requireRole(['MANAGER'])` (scoped to `getManagerBuildingIds`).
   - Change `POST /:id/settlement/approve` and `POST /:id/settlement/reject` middleware to `requireRole(['OWNER', 'MANAGER', 'SYS_ADMIN'])`, guarded by `canActAsDepositApprover` (`OWNER` on `getOwnerBuildingIds`, `MANAGER` on `getManagerBuildingIds`, or `SYS_ADMIN` only when `!meta.building_has_active_owner`, else `logAccessDenied` + `403 SYS_ADMIN_READ_ONLY_ON_OWNED_BUILDING`) + `checkFourEyesOrWarn` (`403 SELF_APPROVAL` if creator).
   - Allow `POST /:id/settlement/reject` (with mandatory `reason`) when `status IN ('PENDING_APPROVAL', 'APPROVED_PENDING_PAYOUT')` and `!settlement.accounting_committed_at`, clearing `approved_by`/`approved_at` and setting `status = 'SETTLEMENT_DRAFT'`.
   - Change `POST /:id/resolve-dispute` middleware to `requireRole(['OWNER', 'MANAGER', 'SYS_ADMIN'])`:
     - Pre-payout dispute (`!settlement.accounting_committed_at`): `ADJUST` allows assigned `MANAGER` or approver via `canActAsDepositApprover` (clears `approved_by`/`approved_at` -> `SETTLEMENT_DRAFT`); `CONFIRM` allows assigned `MANAGER` or `canActAsDepositApprover` when `!settlement.approved_at`, and requires `canActAsDepositApprover` + `checkFourEyesOrWarn` when `Boolean(settlement.approved_at)`.
     - Post-payout dispute (`Boolean(settlement.accounting_committed_at)`): `ADJUST` returns `409 ALREADY_PAID_OUT`; `CONFIRM` requires `canActAsDepositApprover` + `checkFourEyesOrWarn`.
   - Include `building_has_active_owner(c.building_id) AS building_has_active_owner` in `GET /api/v1/deposits`.
   - In `POST /:id/settlement`, invoke `fn_notify_deposit_event` for `'RESIDENT'` (`SETTLEMENT_STATEMENT_READY`) and `'BUILDING_OWNERS'` (`SETTLEMENT_PENDING_APPROVAL`, falling back to `'BUILDING_MANAGERS'` when `!meta.building_has_active_owner`).
   - In `POST /:id/settlement/reject`, invoke `fn_notify_deposit_event` (`'SPECIFIC_USER'`, `SETTLEMENT_REJECTED`, `settlement.created_by`).
2. **`api/src/routes/reservations.js`:**
   - Include `building_has_active_owner(r.building_id) AS building_has_active_owner` in `GET /`.
   - Restrict `POST /` to `requireRole(['MANAGER'])` on `getManagerBuildingIds`.
   - Update both `PATCH /:id/forfeit` and `PATCH /:id/refund` (`FR-067`, `NFR-016`) to `requireRole(['OWNER', 'MANAGER', 'SYS_ADMIN'])`: preserve Phase 1's mandatory `reason` (`400 REASON_REQUIRED`), `['HELD', 'EXPIRED']` status support, and `checkFourEyesOrWarn` (`403 FOUR_EYES_VIOLATION` on creator), allow owning `OWNER`, Four-Eyes `MANAGER` of `building_id`, or fallback `SYS_ADMIN` **only when `!building_has_active_owner`**, and replace `syncApartmentStatus(client, currentRes.apartment_id)` with `await client.query('SELECT fn_sync_apartment_status_after_reservation($1)', [currentRes.apartment_id])`.
3. **`api/src/jobs/daily.js`:**
   - Extract the overdue deposit settlement block (`lines 360–445`) into an exported `export async function runOverdueDepositSettlementAlerts()` and invoke it inside `runDailyJobs()`.
   - Update all 3 overdue deposit filters (`lines 40, 85, and 376`) to `d.status NOT IN ('REFUNDED', 'PARTIALLY_REFUNDED', 'DEDUCTED_FULL', 'TRANSFERRED')`.
   - When `daysOverdue >= 5`, fetch active `OWNER` `app_user.id`s of `row.building_id` (`building -> owner -> app_user WHERE status = 'ACTIVE'`) and send `DEPOSIT_OVERDUE_5D` to them (only notifying `SYS_ADMIN` when the building has no active `OWNER`).
4. **Update outdated "Phương án 2" assertions in Phase 1 & existing regression tests:**
   - `api/test/m06Phase1P0Fixes.test.js`: replace `sysAdmin.token` with `owner.token` (or Four-Eyes `mgr2` token) on `VOP-A` settlement `reject`/`approve` and reservation `forfeit`/`refund` assertions.
   - `api/test/depositCollectAndRefund.test.js`: replace `sysAdmin.token` with `owner.token` on `VOP-A` reservation `refund`/`forfeit` (lines 226, 247) and settlement `reject`/`approve` calls (lines 507, 544, 562, 710); update `postConfirm` (line 606) from `manager.token` (creator) to `owner.token` (Four-Eyes approver).
   - `api/test/fullWebsiteWhiteBlackBox.test.js` (lines 1756–1767): assert `sysAdmin.token` gets `403` on `VOP-A` `approve`, `mgrVopA.token` (second manager, Four-Eyes) calls `POST /:id/settlement/reject` -> `200 SETTLEMENT_DRAFT`, `mgr2VopA.token` resubmits -> `200 PENDING_APPROVAL`, and `ownerVop.token` calls `POST /:id/settlement/approve` -> `200 DEDUCTED_FULL` (since `refund = 0` on line 1702).
   - `api/test/multiBuildingAndFutureContract.test.js` (lines 654–675): assert `sysAdmin.token` gets `403` on `VOP-A` (since `ownerVop` is active) and `ownerVop.token` approves with `200`.
   - `api/test/remediationR01ToR24.test.js` (line 273): change `refundRsvB` on `VOP-A` from `sysAdmin.token` to `ownerVop.token`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd d:\resihub\api; node --test test/m06Phase2OwnerApprovalAndEscalation.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add api/src/routes/deposits.js api/src/routes/reservations.js api/src/jobs/daily.js api/test/m06Phase2OwnerApprovalAndEscalation.test.js api/test/m06Phase1P0Fixes.test.js api/test/depositCollectAndRefund.test.js api/test/fullWebsiteWhiteBlackBox.test.js api/test/multiBuildingAndFutureContract.test.js api/test/remediationR01ToR24.test.js
git commit -m "feat(m06): align OWNER R+A and SYS_ADMIN R deposit permissions, pre-payout notice and 5d escalation"
```

---

### Task 3: Mandatory Apartment Handover Inspection With Photo Evidence Before Settlement (`GAP-03`, `FR-024`, `R-12`)

**Files:**
- Modify: `api/src/routes/apartments.js:577-653`
- Modify: `api/src/routes/deposits.js` (`checkSettlementPreconditions`, `GET /:id/settlement`, `POST /:id/settlement`)
- Create: `api/test/m06Phase2HandoverPrecondition.test.js`
- Modify: `api/test/m06Phase1P0Fixes.test.js`, `api/test/depositCollectAndRefund.test.js`, `api/test/fullWebsiteWhiteBlackBox.test.js`, `api/test/multiBuildingAndFutureContract.test.js`, `api/test/remediationR01ToR24.test.js`

**Interfaces:**
- Consumes: `fn_get_deposit_access_meta.latest_photo_handover_at` & `normalizeAndPersistEvidence` (`saveBase64Image`) from Task 1.
- Produces:
  - `PATCH /api/v1/apartments/:id/handover` (`['SYS_ADMIN', 'MANAGER']` per `PRD 6.2`, zero `adminPool`) body: `{ note?: string, checklist?: Array<{ item: string, ok: boolean, note?: string }>, evidence?: string[], keep_maintenance?: boolean }` — normalizes `evidence` via `saveBase64Image` (`attachment` with `owner_entity='apartment', uploaded_by=req.user.sub`) and writes `audit_log.after = { ...apartmentRow, inspection_note, checklist, evidence }`.
  - `checkSettlementPreconditions` fields: `apartment_inspected: boolean`, `handover_recorded_at: string | null`.
  - `POST /api/v1/deposits/:id/settlement` optional body field `inspection_evidence?: string[]` (persisted on `settlement.inspection_evidence`); returns `409 { code: 'MISSING_APARTMENT_INSPECTION', preconditions }` when `movedIn === true` and neither `latest_photo_handover_at` nor `inspection_evidence` (`length >= 1`) exists.

- [ ] **Step 1: Write the failing handover precondition test (`api/test/m06Phase2HandoverPrecondition.test.js`)**

Cover these exact assertions:
1. Terminated contract (`movedIn = true`, meters & invoices clear, apartment in `MAINTENANCE`, no handover):
   - `GET /api/v1/deposits/:id/settlement` returns `preconditions.apartment_inspected === false` and `preconditions.ready === false`.
   - `POST /api/v1/deposits/:id/settlement` without `inspection_evidence` returns `409` with `code: 'MISSING_APARTMENT_INSPECTION'`.
2. Calling `PATCH /api/v1/apartments/:id/handover` with `{ note: 'Tường xước nhẹ' }` (no photos) still releases an empty `MAINTENANCE` room to `AVAILABLE` (`200`, backward-compatible for `M03`), **but** `preconditions.apartment_inspected` remains `false` for `M06` settlement because `R-12` requires photo evidence (*"Bắt buộc biên bản kiểm tra có ảnh"*).
3. Calling `PATCH /api/v1/apartments/:id/handover` with `{ note: 'Nghiệm thu phòng', evidence: ['https://example.com/handover-1.jpg'], keep_maintenance: true }` keeps apartment in `MAINTENANCE` while recording `HANDOVER` with photo -> `GET /:id/settlement` (for both `MANAGER` and `RESIDENT`) returns `preconditions.apartment_inspected === true`, and `POST /:id/settlement` succeeds (`200`).
4. On a second terminated contract without prior `PATCH /apartments/:id/handover`, passing `inspection_evidence: [TINY_PNG_B64]` directly in `POST /:id/settlement` succeeds (`200`), writes an `attachment` row, and persists `/api/v1/attachments/<id>/view` in `settlement.inspection_evidence`.
5. Early-terminated contract before `start_date` (`movedIn === false`) passes `checkSettlementPreconditions` with `apartment_inspected === true` without requiring photos.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd d:\resihub\api; node --test test/m06Phase2HandoverPrecondition.test.js`
Expected: FAIL (`POST /:id/settlement` currently succeeds with `200` even without inspection photos).

- [ ] **Step 3: Implement photo-backed handover inspection & settlement precondition, and update regression fixtures**

1. **`api/src/routes/apartments.js` (`PATCH /:id/handover`):**
   - Restrict middleware to `requireRole(['SYS_ADMIN', 'MANAGER'])` (`PRD 6.2`) and replace `adminPool.query` on line 587 with `getUserClient(req)` / `pool` scope check (`getManagerBuildingIds` for `MANAGER`).
   - Parse `{ note, checklist, evidence, keep_maintenance } = req.body || {}`.
   - Inside transaction on `client`: normalize `evidence` via `saveBase64Image` (`folder: 'handovers', entity: 'apartment', ownerId: id`) when `data:` base64 is passed (preserving `http(s)://` / `/api/v1/attachments/` URLs as-is); if `!keep_maintenance`, call `syncApartmentStatus(client, id, { leaveMaintenance: true })`; insert `audit_log` (`action = 'HANDOVER'`, `entity = 'apartment'`, `entity_id = id`, `after = JSON.stringify({ ...updatedApt, inspection_note: note || null, checklist: Array.isArray(checklist) ? checklist : [], evidence: evidenceList })`).
2. **`api/src/routes/deposits.js`:**
   - Extend `checkSettlementPreconditions(client, contractRow, { latestPhotoHandoverAt = null, existingSettlement = null, incomingInspectionEvidence = null } = {})`:
     - When `!movedIn`, `apartmentInspected = true`.
     - When `movedIn`, combine `Boolean(latestPhotoHandoverAt)` with `incomingInspectionEvidence` / `existingSettlement?.inspection_evidence` (`length >= 1`) to compute `apartmentInspected`, and include `apartmentInspected` in `ready`.
   - In `POST /:id/settlement`, preserve existing validation order so error-code tests remain intact:
     1. `contract_ended` -> `409`
     2. `final_meters_recorded` -> `409`
     3. `no_draft_invoices` -> `409`
     4. `items` array & `validateDeduction` -> `400` / `422` (`RENT_DEDUCTION_FORBIDDEN`, `EVIDENCE_REQUIRED`)
     5. `apartment_inspected` -> `409 { code: 'MISSING_APARTMENT_INSPECTION', message: 'Chưa có biên bản kiểm tra bàn giao phòng kèm hình ảnh sau khi hợp đồng kết thúc (FR-024, R-12).', preconditions }`
     6. `validateRefundBankInfo` -> `422`
     Normalize `items[].evidence` and `inspection_evidence` via `normalizeAndPersistEvidence`, and save `inspection_evidence` into `settlement` JSONB.
3. **Update regression test fixtures (`movedIn = true` settlements):**
   - `api/test/m06Phase1P0Fixes.test.js`: pass `inspection_evidence: ['https://example.com/handover-p0.png']` to `movedIn = true` settlement submissions.
   - `api/test/depositCollectAndRefund.test.js`: call `PATCH /api/v1/apartments/${apt1Id}/handover` (`manager.token`, `{ note: 'Nghiệm thu bàn giao', evidence: ['https://example.com/handover-apt1.png'], keep_maintenance: true }`) right before `preSettle` (line 441) so `preSettle` asserts `preconditions.ready === true`; add `inspection_evidence: ['https://example.com/handover-apt2.png']` to `sfSubmit` (`dep2`, line 692).
   - `api/test/fullWebsiteWhiteBlackBox.test.js`: call `PATCH /api/v1/apartments/${testApt1Id}/handover` (`mgr2VopA.token`, `{ note: 'Nghiệm thu bàn giao', evidence: [TINY_PNG_BASE64], keep_maintenance: true }`) right before `getSettlePre` (line 1696) so `getSettlePre` asserts `preconditions.ready === true`.
   - `api/test/multiBuildingAndFutureContract.test.js` (line 632) & `api/test/remediationR01ToR24.test.js` (lines 462 & 486): pass `inspection_evidence: [TINY_PNG_B64]` (and `refund_method: 'CASH'` on `remediationR01ToR24.test.js` lines 464 & 488).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd d:\resihub\api; node --test test/m06Phase2HandoverPrecondition.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add api/src/routes/apartments.js api/src/routes/deposits.js api/test/m06Phase2HandoverPrecondition.test.js api/test/m06Phase1P0Fixes.test.js api/test/depositCollectAndRefund.test.js api/test/fullWebsiteWhiteBlackBox.test.js api/test/multiBuildingAndFutureContract.test.js api/test/remediationR01ToR24.test.js
git commit -m "feat(m06): enforce photo-backed apartment handover inspection before deposit settlement"
```

---

### Task 4: Separated Payout Execution (`APPROVED_PENDING_PAYOUT -> POST /:id/payout`), Deferred Accounting Commit, Pre-Payout `ADJUST` & `RETURNED` Reissue (`GAP-01`, `GAP-02`, `FR-024`, `R-12`, `NFR-016`)

**Files:**
- Modify: `api/src/routes/deposits.js`
- Modify: `api/src/routes/resident.js:170-183`
- Create: `api/test/m06Phase2PayoutAndReturnedFlow.test.js`
- Modify: `api/test/m06Phase1P0Fixes.test.js`, `api/test/depositCollectAndRefund.test.js`, `api/test/multiBuildingAndFutureContract.test.js`, `api/test/remediationR01ToR24.test.js`

**Interfaces:**
- Consumes: `idempotencyGuard()` (`api/src/middleware/idempotency.js`), `validateRefundBankInfo` & `resolvePostSettlementStatus` (`api/src/services/depositSettlement.js`), `fn_apply_deposit_settlement_accounting`, `fn_update_deposit_refund_bank_info`, `fn_notify_deposit_event`, `normalizeAndPersistEvidence` (Task 1).
- Produces:
  - Shared internal helper `commitSettlementAccounting(client, { depositId, settlement, heldBefore, actorId })`: writes capped item `deduct` rows (`SUM(deduct) + refund_amount === heldBefore` per Phase 1 `BUG-02` invariant, `approved_by = settlement.approved_by || actorId`, `approved_at = settlement.approved_at || NOW()`, `created_by = settlement.created_by || actorId`) + `UTILITY_DEBT` `deduct` row (`coveredServiceDebt`), and invokes `SELECT fn_apply_deposit_settlement_accounting($1, $2, $3)` (`depositId`, `coveredServiceDebt`, `uncoveredItemsShortfall = Math.max(0, sumItems - heldBefore)`).
  - Updated `POST /api/v1/deposits/:id/settlement/approve`:
    - `refund_amount === 0` -> runs `commitSettlementAccounting`, sets `accounting_committed_at = nowIso`, `amount_held = 0`, `status = 'DEDUCTED_FULL' | 'REFUNDED'`, notifies `RESIDENT` (`SETTLEMENT_APPROVED`).
    - `refund_amount > 0` -> verifies `SETTLEMENT_SNAPSHOT_STALE` + `checkFourEyesOrWarn`, stores `approved_by` + `approved_at` with `accounting_committed_at: null`, keeps `amount_held = deposit_held_before_settlement`, sets `status = 'APPROVED_PENDING_PAYOUT'` (zero `deposit_transaction` rows written yet), notifies `RESIDENT` (`SETTLEMENT_APPROVED`) + `BUILDING_MANAGERS` (`SETTLEMENT_READY_FOR_PAYOUT`).
  - `POST /api/v1/deposits/:id/payout` (`MANAGER`, `idempotencyGuard()`):
    - Body: `{ evidence?: string[], reference_code?: string, method?: 'BANK_TRANSFER' | 'CASH', note?: string }`
    - Rejects `409 SETTLEMENT_DISPUTED` if `status === 'DISPUTED'`; rejects `409 INVALID_STATUS_FOR_PAYOUT` unless `status IN ('APPROVED_PENDING_PAYOUT', 'RETURNED')` and `BigInt(amount_held) > 0n`.
    - Rejects `422 PAYOUT_EVIDENCE_REQUIRED` when `refundMethod === 'BANK_TRANSFER'` and `evidence` has `< 1` item; validates `settlement.bank_info` via `validateRefundBankInfo`.
    - When `!settlement.accounting_committed_at` (`APPROVED_PENDING_PAYOUT` first disbursement): verifies open-invoice snapshot (`409 SETTLEMENT_SNAPSHOT_STALE` if drifted since submission) and calls `commitSettlementAccounting` before inserting the `refund` row (`amount = settlement.refund_amount`).
    - When `Boolean(settlement.accounting_committed_at)` (`RETURNED` reissue): skips `commitSettlementAccounting` and inserts only the new `refund` row (`amount = amount_held`).
    - Normalizes `evidence` via `normalizeAndPersistEvidence`, inserts immutable `deposit_transaction(type='refund', amount, method, evidence, reference_code, status='APPROVED')`, sets `amount_held = 0`, transitions to `REFUNDED` / `PARTIALLY_REFUNDED`, records `accounting_committed_at`, `payout_at`, `payout_by`, `payout_evidence`, `payout_reference_code` (plus `reissued_at` / `reissue_history` if prior status was `'RETURNED'`), notifies `RESIDENT` (`DEPOSIT_PAYOUT_COMPLETED` or `DEPOSIT_PAYOUT_REISSUED`).
  - `POST /api/v1/deposits/:id/payout-returned` (`MANAGER`, `idempotencyGuard()`):
    - Body: `{ reason: string, reference_code?: string }`
    - Allowed only when `status IN ('REFUNDED', 'PARTIALLY_REFUNDED')`, `BigInt(amount_held) === 0n`, and `Number(settlement?.refund_amount || 0) > 0` (else `409 INVALID_DEPOSIT_STATUS_FOR_RETURN`).
    - Inserts immutable `deposit_transaction(type='refund_reversal', amount=refund_amount, reference_code, status='APPROVED')`, restores `amount_held = refund_amount`, sets `status = 'RETURNED'`, notifies `RESIDENT` (`DEPOSIT_PAYOUT_RETURNED`).
  - `PATCH /api/v1/deposits/:id/bank-info` (`MANAGER` or primary `RESIDENT`, `idempotencyGuard()`):
    - Body: `{ bank_name: string, bank_code?: string, bank_bin?: string, account_number: string, account_holder: string }`
    - Allowed when `status IN ('APPROVED_PENDING_PAYOUT', 'RETURNED')` and `Number(settlement?.refund_amount || 0) > 0`; validates via `validateRefundBankInfo` (`422`), calls `fn_update_deposit_refund_bank_info`, and if actor is `RESIDENT`, notifies `'BUILDING_MANAGERS'` (`DEPOSIT_BANK_INFO_UPDATED`).
  - `GET /api/v1/resident/overview` (`api/src/routes/resident.js:171`): includes `'APPROVED_PENDING_PAYOUT'`, `'DEDUCTED_FULL'`, and `'RETURNED'` in `depositSettlements`.

- [ ] **Step 1: Write the failing separated payout, UNC voucher, pre-payout `ADJUST`/`CONFIRM` & `RETURNED` reissue test (`api/test/m06Phase2PayoutAndReturnedFlow.test.js`)**

Cover these exact assertions:
1. `OWNER` approves a settlement (`held = 10_000_000`, `deduct = 2_500_000`, `refund_amount = 7_500_000`, `refund_method = 'BANK_TRANSFER'`):
   - `deposit.status` becomes `'APPROVED_PENDING_PAYOUT'`, `deposit.amount_held` stays `'10000000'` (matching ledger balance before disbursement), and **zero** `deduct`/`refund` `deposit_transaction` rows exist yet.
   - `OWNER` or `SYS_ADMIN` attempting `POST /:id/payout` receives `403`.
   - `MANAGER` calling `POST /:id/payout` with empty `evidence: []` fails `422 PAYOUT_EVIDENCE_REQUIRED`.
2. Pre-payout dispute lock & `ADJUST` / `CONFIRM` (`FR-024` line 510, `R-12` line 1326):
   - While in `'APPROVED_PENDING_PAYOUT'`, `RESIDENT` calls `POST /:id/dispute` -> `200 DISPUTED`.
   - `MANAGER` calling `POST /:id/payout` with valid UNC fails `409 SETTLEMENT_DISPUTED`.
   - `MANAGER` calling `POST /:id/resolve-dispute` with `{ resolution: 'ADJUST', notes: 'Điều chỉnh giảm phí vệ sinh' }` **succeeds (`200 SETTLEMENT_DRAFT`)**, clearing `approved_by`/`approved_at`; `MANAGER` resubmits (`refund_amount = 7_800_000`) -> `PENDING_APPROVAL`, and `OWNER` re-approves -> `APPROVED_PENDING_PAYOUT`.
   - `RESIDENT` disputes a second time at `'APPROVED_PENDING_PAYOUT'` -> `200 DISPUTED`; settlement creator `MANAGER` calling `{ resolution: 'CONFIRM' }` fails `403 SELF_APPROVAL`; `OWNER` calling `{ resolution: 'CONFIRM', notes: 'Đã đối chiếu biên bản bàn giao' }` restores `'APPROVED_PENDING_PAYOUT'`.
3. Payout execution, accounting commit & idempotency:
   - `MANAGER` calls `POST /:id/payout` with `{ evidence: [TINY_PNG_B64], reference_code: 'FT26306001' }` and `Idempotency-Key` -> `200 PARTIALLY_REFUNDED`, `amount_held === '0'`, `deduct` (`2_200_000`) + `refund` (`7_800_000`, `reference_code = 'FT26306001'`) rows created (`APPROVED`), `attachment` row persisted, `GET /api/v1/resident/overview` surfaces the settled deposit, and replaying the same `Idempotency-Key` does not duplicate ledger rows.
   - Post-payout dispute + `ADJUST` now fails `409 ALREADY_PAID_OUT`.
4. `RETURNED` bank-bounce & reissue lifecycle (`FR-024` line 510):
   - Calling `POST /:id/payout-returned` on a `DEDUCTED_FULL` (`refund_amount = 0`) deposit fails `409 INVALID_DEPOSIT_STATUS_FOR_RETURN`.
   - `MANAGER` calls `POST /:id/payout-returned` on the `PARTIALLY_REFUNDED` deposit with `{ reason: 'Sai tên chủ tài khoản thụ hưởng' }` -> `200 RETURNED`, `amount_held === '7800000'`, `deposit_transaction(type='refund_reversal', amount=7800000)` inserted, `DEPOSIT_PAYOUT_RETURNED` notification sent to `RESIDENT`.
   - Non-primary occupant gets `403` on `PATCH /:id/bank-info`; primary `RESIDENT` updates bank account via `PATCH /:id/bank-info` -> `200` (notifying `BUILDING_MANAGERS`), malformed account (`'12-34'` or `'< 4'` chars `'123'`) fails `422 INVALID_ACCOUNT_NUMBER`.
   - `MANAGER` executes reissue via `POST /:id/payout` with `{ evidence: ['https://example.com/unc-2.png'], reference_code: 'FT26306002' }` -> `200 PARTIALLY_REFUNDED`, `amount_held === '0'`, ledger preserves all immutable entries (`collect`, `deduct`, first `refund`, `refund_reversal`, second `refund` — zero rows mutated and deductions not double-counted).

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd d:\resihub\api; node --test test/m06Phase2PayoutAndReturnedFlow.test.js`
Expected: FAIL (`approve` still jumps straight to `PARTIALLY_REFUNDED`, `/payout`, `/payout-returned`, `/bank-info` return `404`).

- [ ] **Step 3: Implement deferred-accounting `approve`, `POST /:id/payout`, `POST /:id/payout-returned`, `PATCH /:id/bank-info`, `resident.js` filter, and update regression tests**

1. Extract `commitSettlementAccounting` and update `POST /:id/settlement/approve` in `api/src/routes/deposits.js` per `Interfaces`.
2. Add `POST /:id/payout`, `POST /:id/payout-returned`, and `PATCH /:id/bank-info` in `api/src/routes/deposits.js` matching the exact contracts in `Interfaces`, wrapped with `idempotencyGuard()`.
3. Update `api/src/routes/resident.js:171` to include `'APPROVED_PENDING_PAYOUT'`, `'DEDUCTED_FULL'`, and `'RETURNED'` in `depositSettlements`.
4. Update Phase 1 & existing E2E regression tests where `refund_amount > 0`:
   - `api/test/m06Phase1P0Fixes.test.js`: where a test approves a settlement with `refund_amount > 0`, assert `'APPROVED_PENDING_PAYOUT'` (and execute `POST /:id/payout` when testing finalized post-payout state); `DEDUCTED_FULL` (`refund = 0`) remains finalized directly at `approve`.
   - `api/test/depositCollectAndRefund.test.js` (around line 562): assert `approve1` (`owner.token`) transitions `dep1` to `'APPROVED_PENDING_PAYOUT'` (`amount_held = '10000000'`), then call `POST /api/v1/deposits/${dep1.id}/payout` (`manager.token`, `{ evidence: ['https://example.com/unc-dep1.png'], reference_code: 'UNC-DEP1' }`) and assert `'PARTIALLY_REFUNDED'` (`amount_held = '0'`, open invoice offset & `RECEIVABLE_AFTER_MOVE_OUT` verified right after `payout`). (`dep2` at line 710 has `refund_amount = 0`, so it goes straight to `'DEDUCTED_FULL'` on `approve`.)
   - `api/test/multiBuildingAndFutureContract.test.js` (around line 669): assert `ownerVop` `approve` returns `'APPROVED_PENDING_PAYOUT'`, followed by `mgrA` `POST /:id/payout` with `{ evidence: [TINY_PNG_B64], reference_code: 'UNC-MGR-A' }` returning `'PARTIALLY_REFUNDED'`.
   - `api/test/remediationR01ToR24.test.js` (line 499): assert `selfAppAllowed` returns `200` (`'APPROVED_PENDING_PAYOUT'`) and logs `SELF_APPROVAL_WARNING`.

- [ ] **Step 4: Run backend test suite to verify everything passes**

Run: `cd d:\resihub\api; node --test test/m06Phase2PayoutAndReturnedFlow.test.js test/m06Phase1P0Fixes.test.js test/depositCollectAndRefund.test.js test/fullWebsiteWhiteBlackBox.test.js test/multiBuildingAndFutureContract.test.js test/remediationR01ToR24.test.js test/rbacPrdAlignment.test.js`
Expected: PASS across both new and existing E2E regression suites.

- [ ] **Step 5: Commit**

```bash
git add api/src/routes/deposits.js api/src/routes/resident.js api/test/m06Phase2PayoutAndReturnedFlow.test.js api/test/m06Phase1P0Fixes.test.js api/test/depositCollectAndRefund.test.js api/test/multiBuildingAndFutureContract.test.js api/test/remediationR01ToR24.test.js
git commit -m "feat(m06): separate payout execution with mandatory UNC voucher and add RETURNED reissue flow"
```

---

### Task 5: Frontend Admin & Resident Portal Updates (`OWNER` Approval UI, `MANAGER` Payout/UNC & Handover Modals, `RETURNED` Bank-Update & 7-Day Dispute Badge)

**Files:**
- Create: `frontend/src/utils/depositUiHelpers.js`
- Modify: `frontend/src/constants/statuses.js:52-60`
- Modify: `frontend/src/hooks/usePermission.js:33-50`
- Modify: `frontend/src/services/deposits.service.js`
- Modify: `frontend/src/services/resident.service.js`
- Modify: `frontend/src/services/buildings.service.js:31`
- Modify: `frontend/src/pages/admin/apartments/ApartmentDetailPage.jsx`
- Modify: `frontend/src/pages/admin/deposits/DepositsPage.jsx`
- Modify: `frontend/src/pages/resident/tabs/ContractTab.jsx`
- Create: `frontend/src/utils/__tests__/m06Phase2Ui.test.js`

**Interfaces:**
- Consumes: Task 1–4 API endpoints (`/payout`, `/payout-returned`, `/bank-info`, `/apartments/:id/handover`), `building_has_active_owner`, `APPROVED_PENDING_PAYOUT`, `DEDUCTED_FULL`, `RETURNED`, `refund_reversal`, `post_settlement_dispute_closed`.
- Produces:
  - `DEPOSIT_STATUS` in `frontend/src/constants/statuses.js`:
    - `APPROVED_PENDING_PAYOUT: { label: 'Đã duyệt - Chờ chi tiền', variant: 'amber' }`
    - `DEDUCTED_FULL: { label: 'Đã khấu trừ hết cọc', variant: 'amber' }`
    - `RETURNED: { label: 'Ngân hàng hoàn trả lệnh chi', variant: 'red' }`
  - Pure helpers in `frontend/src/utils/depositUiHelpers.js`:
    - `canActorApproveDepositRow({ isOwner, isManager, isSysAdmin, currentUserId, createdBy, buildingHasActiveOwner }) -> boolean`
    - `canActorApproveReservationRow({ isOwner, isManager, isSysAdmin, currentUserId, createdBy, buildingHasActiveOwner }) -> boolean`
    - `getResidentDisputeWindowState(deposit, nowMs = Date.now()) -> { canDispute: boolean, daysRemaining: number | null, lockedReason: string | null }`
    - `canResidentUpdateRefundBankInfo(deposit) -> boolean`
  - `usePermission()` flags: `canSettleDeposits: isManager`, `canExecuteDepositPayout: isManager`, `canApproveDepositRefund: isOwner || isManager || isSysAdmin`.
  - `depositsService` (forwarding `withIdempotency(options)`): `executePayout(id, payload, options = {})`, `markPayoutReturned(id, payload, options = {})`, `updateRefundBankInfo(id, payload, options = {})`.
  - `residentService` (forwarding `withIdempotency(options)`): `updateDepositRefundBankInfo(depositId, payload, options = {})`.
  - `buildingsService`: `handoverApartment(id, payload = {})`.

- [ ] **Step 1: Write the failing frontend unit test (`frontend/src/utils/__tests__/m06Phase2Ui.test.js`)**

Test pure modules (`statuses.js` and `depositUiHelpers.js`) using `node:test`:
1. `DEPOSIT_STATUS` defines `APPROVED_PENDING_PAYOUT`, `DEDUCTED_FULL`, and `RETURNED` with Vietnamese labels.
2. `canActorApproveDepositRow` & `canActorApproveReservationRow` (`NFR-016` Four-Eyes + `PRD 6.2`):
   - Return `true` for `isOwner: true` (when `createdBy !== currentUserId`), `true` for second `MANAGER` (`isManager: true, createdBy !== currentUserId`), and `false` for creator `MANAGER` (`createdBy === currentUserId`).
   - Return **`false`** for `isSysAdmin: true` when `buildingHasActiveOwner: true`, and **`true`** when `buildingHasActiveOwner: false`.
3. `getResidentDisputeWindowState`:
   - Returns `canDispute: true` for `PENDING_APPROVAL` and `APPROVED_PENDING_PAYOUT`.
   - Returns `canDispute: true` with `daysRemaining` (`1..7`) for `PARTIALLY_REFUNDED` within 7 days of `payout_at`, `canDispute: false` (`lockedReason: 'EXPIRED'`) after 7 days, and `canDispute: false` (`lockedReason: 'FINALIZED'`) when `settlement.post_settlement_dispute_closed === true` even if only 1 day has elapsed.
4. `canResidentUpdateRefundBankInfo`: returns `true` only when `status` is `'APPROVED_PENDING_PAYOUT'` or `'RETURNED'` and `Number(settlement?.refund_amount || 0) > 0`.

- [ ] **Step 2: Run the frontend unit test to verify it fails**

Run: `cd d:\resihub\frontend; node --test src/utils/__tests__/m06Phase2Ui.test.js`
Expected: FAIL (`depositUiHelpers.js` does not exist and `DEPOSIT_STATUS` lacks new keys).

- [ ] **Step 3: Implement statuses, permission helpers, API services, Admin modals & Resident portal updates**

1. Create `frontend/src/utils/depositUiHelpers.js` and update `frontend/src/constants/statuses.js`, `frontend/src/hooks/usePermission.js`, `frontend/src/services/deposits.service.js`, `frontend/src/services/resident.service.js`, and `frontend/src/services/buildings.service.js` per `Interfaces` (using `createIdempotencyKey` / `withIdempotency` from Phase 1's `frontend/src/utils/idempotency.js` on modal open).
2. Update `frontend/src/pages/admin/apartments/ApartmentDetailPage.jsx`:
   - Replace one-click `handleHandover` with a Handover Inspection `Modal` (`FileUpload` for `evidence`, `note`, and `keep_maintenance` checkbox — visible to `MANAGER` / `SYS_ADMIN` per `PRD 6.2`) calling `buildingsService.handoverApartment(id, payload)`.
   - Gate reservation `refund` and `forfeit` buttons on `['HELD', 'EXPIRED'].includes(r.status) && Number(r.hold_amount || 0) > 0` via `canActorApproveReservationRow` (using `r.building_has_active_owner ?? apt.building_has_active_owner`).
3. Update `frontend/src/pages/admin/deposits/DepositsPage.jsx`:
   - Add `refund_reversal: { label: 'Ngân hàng trả lại lệnh chi', variant: 'amber', sign: '+' }` to `TXN_TYPE_META`; include `APPROVED_PENDING_PAYOUT` and `RETURNED` in workflow tabs (`pending` / `returned`) and `DEDUCTED_FULL` in settled tab.
   - Add `inspection_evidence` `FileUpload` and `preconditions.apartment_inspected` status indicator in the `MANAGER` settlement form.
   - Gate `Approve` / `Reject` buttons via `canActorApproveDepositRow` (allowing `Reject` on both `PENDING_APPROVAL` and `APPROVED_PENDING_PAYOUT` before payout, and keeping `SYS_ADMIN` Read-Only on owned buildings); enable `ADJUST` on `DISPUTED` whenever `!settlement?.accounting_committed_at`.
   - Add **Payout Execution Modal** (`canExecuteDepositPayout`, shown for `APPROVED_PENDING_PAYOUT` and `RETURNED` when `status !== 'DISPUTED'`): warns & disables payout if `settlementDetail?.snapshot_stale === true` (prompting `Reject` to recalculate), requires `FileUpload` (`evidence` UNC) when `BANK_TRANSFER`, accepts `reference_code`, calls `depositsService.executePayout` with per-modal `Idempotency-Key`.
   - Add **Mark Returned Modal** (`depositsService.markPayoutReturned` on `REFUNDED` / `PARTIALLY_REFUNDED` with `refund_amount > 0`) and **Update Bank Info Modal** (`BankSelect` + account fields calling `depositsService.updateRefundBankInfo` on `APPROVED_PENDING_PAYOUT` / `RETURNED`).
4. Update `frontend/src/pages/resident/tabs/ContractTab.jsx`:
   - Add `refund_reversal` to `DEPOSIT_TX_LABELS` and include `'APPROVED_PENDING_PAYOUT'`, `'DEDUCTED_FULL'`, `'RETURNED'` in fallback `settlementRows` filter (`lines 378–384`).
   - Use `getResidentDisputeWindowState` to render the `Khiếu nại bảng kê` button (`PENDING_APPROVAL`, `APPROVED_PENDING_PAYOUT`, or countdown within 7 days of payout) vs. locked badge (`Đã chốt giải quyết khiếu nại` / `Đã hết thời hạn khiếu nại 7 ngày`).
   - Show clear status banners for `APPROVED_PENDING_PAYOUT` (*"Chủ nhà đã duyệt bảng kê — Ban quản lý đang thực hiện chuyển khoản hoàn cọc"*) and `RETURNED` (*"Ngân hàng hoàn trả lệnh chuyển tiền — vui lòng cập nhật lại tài khoản thụ hưởng"*), a **Cập nhật TK nhận hoàn cọc** modal (`BankSelect` -> `residentService.updateDepositRefundBankInfo`) when `canResidentUpdateRefundBankInfo` is true, and `AuthImage` preview + `payout_reference_code` once `payout_evidence` is present.

- [ ] **Step 4: Run frontend unit tests, lint, production build, and full backend test suite**

Run:
1. `cd d:\resihub\frontend; node --test src/utils/__tests__/m06Phase2Ui.test.js`
2. `cd d:\resihub\frontend; npm run lint; npm run build`
3. `cd d:\resihub\api; npm test`
Expected: PASS with 0 test failures, 0 lint errors, and clean Vite production bundle.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/utils/depositUiHelpers.js frontend/src/constants/statuses.js frontend/src/hooks/usePermission.js frontend/src/services/deposits.service.js frontend/src/services/resident.service.js frontend/src/services/buildings.service.js frontend/src/pages/admin/apartments/ApartmentDetailPage.jsx frontend/src/pages/admin/deposits/DepositsPage.jsx frontend/src/pages/resident/tabs/ContractTab.jsx frontend/src/utils/__tests__/m06Phase2Ui.test.js
git commit -m "feat(m06-ui): add OWNER approval, MANAGER UNC payout, handover photo modal and RETURNED bank-update UI"
```
