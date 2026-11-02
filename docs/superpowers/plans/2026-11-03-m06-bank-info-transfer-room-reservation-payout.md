# M05/M06 Bank-Info Fix, Four-Eyes Room Transfer & Separated Reservation Payout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the P0 nested `bank_info` JSON bug on deposit refund account updates, enforce the 4-step signed-scan + Four-Eyes approval workflow on room transfers with deposit carry-over (`FR-013`, `FR-017`, `FR-020`, `FR-025`, `AC-009.2`), and separate `OWNER` approval (`A`) from `MANAGER` UNC-backed payout (`CRU`) on reservation cancellations (`FR-067`, `PRD Mục 6.1–6.2`, `Mục 7.5`).

**Architecture:** `PATCH /api/v1/deposits/:id/bank-info` normalizes both nested `{ bank_info }` and flat payloads (preserving `bank_logo`) without touching `adminPool`. Migration `047_m06_transfer_room_and_reservation_payout.sql` adds room-transfer flags (`is_room_transfer`, `transfer_deposit`, partial unique index on open transfer drafts) to `contract`, adds `cancel_settlement JSONB` and explicit `CANCEL_PENDING_APPROVAL` / `APPROVED_PENDING_PAYOUT` statuses to `reservation`, tightens `rls_reservation_update` so `OWNER` / fallback `SYS_ADMIN` can never bypass `MANAGER` payout to reach `REFUNDED` / `PARTIALLY_REFUNDED`, and adds narrow `SECURITY DEFINER` RPCs for staff notifications and resident bank-info updates. Express routes (`contracts.js`, `reservations.js`, `reports.js`, `public.js`, `resident.js`) and React portals (`ContractDetailPage.jsx`, `ApartmentDetailPage.jsx`, `ReportsPage.jsx`, `OverviewTab.jsx`) expose the end-to-end workflows with exact VND ledger parity on `RP-07`.

**Tech Stack:** Node.js (ESM), Express 4, PostgreSQL 16 (`FORCE ROW LEVEL SECURITY` + `SECURITY DEFINER` helpers), `node:test`, React 19, TailwindCSS, Vite, Oxlint.

**Spec:** `docs/superpowers/specs/2026-11-03-m06-bank-info-transfer-room-reservation-payout-design.md`

## Global Constraints

- **Zero `adminPool` in `api/src/routes/deposits.js` (`NFR-008`):** `deposits.js` must contain `0` occurrences of `adminPool`; all queries run through `pool` / `getUserClient(req)` under `FORCE ROW LEVEL SECURITY`.
- **PRD Section 6.2 Strict RBAC Matrix:**
  - `MANAGER`: `CRU` on assigned buildings (`getManagerBuildingIds`), plus `A(gia hạn)` on non-discounted contract renewals (`POST /contracts/:id/renew` remains unchanged). Sole role allowed to propose reservation cancellation (`PATCH /reservations/:id/cancel-settle`) and execute reservation refund payout with UNC (`POST /reservations/:id/cancel-payout`).
  - `OWNER`: `R + A` on owned buildings (`getOwnerBuildingIds`). Approves/rejects `PENDING_APPROVAL` room-transfer/discounted contracts and `CANCEL_PENDING_APPROVAL` reservations; strictly blocked (`403` + PostgreSQL RLS) from `cancel-payout` and from directly setting `reservation.status` to `REFUNDED` or `PARTIALLY_REFUNDED`.
  - `SYS_ADMIN`: Read-only (`R`) on buildings with an active `OWNER` (`building_has_active_owner(building_id) = true`); allowed as fallback approver (`A`) only when `NOT building_has_active_owner(building_id)`.
- **Four-Eyes Principle (`PRD Mục 6.1–6.2`, `AC-017.3`, `R-23`):** Approver `actor_id` must differ from creator/submitter/proposer unless `system_setting('approval_config').allow_self_approval === true` (which logs `SELF_APPROVAL_WARNING` in `audit_log`).
- **Same-Building Room Transfer Isolation (`FR-013`, `FR-070`):** Room transfer (`POST /contracts/:id/transfer-room` and `PATCH /contracts/:id` when `is_room_transfer = true`) requires `targetApt.building_id === oldContract.building_id` (`422 CROSS_BUILDING_TRANSFER_NOT_ALLOWED`), preventing cross-owner deposit ledger leakage.
- **`RP-07` VND Conservation & Timezone (`Asia/Ho_Chi_Minh`):** All VND amounts are non-negative `BIGINT` integers; `reservation_summary` recognizes `forfeited_in_period` at `approved_at`, holds `pending_payout_amount = SUM(refunded_amount)` during `APPROVED_PENDING_PAYOUT`, and recognizes `refunded_in_period` at `payout_at`.

## Review Focus

1. **`PATCH /:id/bank-info` malformed `bank_info` shapes (e.g. `{ bank_info: null }`, `{ bank_info: [] }`, `{ bank_info: "string" }`):** Must safely fall back or return `422 BANK_INFO_REQUIRED` instead of throwing `TypeError` (`500`), while preserving `bank_logo` on valid nested and flat payloads. *(Pinned in Task 1)*
2. **Parent contract terminated or cancelled while a room-transfer contract sits in `DRAFT` or `PENDING_APPROVAL`:** Both `POST /contracts/:newId/activate` and `POST /contracts/:newId/approve` must lock `oldContract` (`FOR UPDATE`) and reject with `409 PARENT_CONTRACT_NOT_ACTIVE` without corrupting apartment or deposit state; `PATCH /contracts/:newId` on a room-transfer `DRAFT` must also block changing `apartment_id` to a different building or back to `oldContract.apartment_id`. *(Pinned in Task 3)*
3. **Midnight expiration race on reservations awaiting cancellation approval (`CANCEL_PENDING_APPROVAL`) vs. rejection after `hold_until`:** Cron `daily.js` must not overwrite `CANCEL_PENDING_APPROVAL` to `EXPIRED`, while `POST /reservations/:id/cancel-reject` after `hold_until < today` must restore `status = 'EXPIRED'` (not `'HELD'`) and release the apartment to `'AVAILABLE'`. *(Pinned in Task 4)*
4. **Direct `PATCH /reservations/:id/refund` when `refund_bank_info` was never collected:** `OWNER` calling `PATCH /:id/refund` transitions to `APPROVED_PENDING_PAYOUT` (releasing apartment to `AVAILABLE`); `MANAGER` calling `POST /:id/cancel-payout` with `BANK_TRANSFER` before STK is filled must receive `422 BANK_INFO_REQUIRED` until `RESIDENT` or `MANAGER` updates STK via `PATCH /reservations/:id/bank-info`. *(Pinned in Task 4)*
5. **`RP-07` partial-refund intermediate accounting (`APPROVED_PENDING_PAYOUT`):** For a `2,000,000 ₫` hold approved at `1,200,000 ₫` refund / `800,000 ₫` forfeit, `RP-07` before payout must report `active_held_amount = 0`, `pending_payout_amount = 1,200,000`, `forfeited_in_period = 800,000`, `refunded_in_period = 0` (exact `2,000,000 ₫` sum), and after `cancel-payout` report `pending_payout_amount = 0`, `forfeited_in_period = 800,000`, `refunded_in_period = 1,200,000`. *(Pinned in Task 4)*

---

## File Structure

- **Create:** `api/src/db/migrations/047_m06_transfer_room_and_reservation_payout.sql` — `contract` room-transfer columns & unique index; `reservation.cancel_settlement`, extended `reservation_status_check`, tightened `rls_reservation_update`, updated `fn_sync_apartment_status_after_reservation`, `fn_notify_reservation_staff`, and `fn_update_reservation_refund_bank_info`.
- **Modify:** `api/src/routes/deposits.js` — Support nested `{ bank_info }` + flat body and preserve `bank_logo` in `PATCH /:id/bank-info`.
- **Modify:** `api/src/routes/contracts.js` — Refactor `POST /:id/transfer-room` to create `DRAFT`, guard `PATCH /:id` on transfer drafts, route `is_room_transfer` through `PENDING_APPROVAL` on `activate`, support Four-Eyes fallback `MANAGER` on unowned buildings in `approve`/`reject`, and execute atomic old-contract termination + deposit carry-over at `approve`.
- **Modify:** `api/src/routes/reservations.js` — Convert `PATCH /:id/cancel-settle` to `MANAGER` proposal (`CANCEL_PENDING_APPROVAL`), add `POST /:id/cancel-approve`, `POST /:id/cancel-reject`, `POST /:id/cancel-payout`, `PATCH /:id/bank-info`, and align `PATCH /:id/refund` to `APPROVED_PENDING_PAYOUT`.
- **Modify:** `api/src/routes/reports.js`, `api/src/routes/public.js`, `api/src/routes/resident.js` — Update `RP-07` reservation conservation SQL & KPIs, public spam check, and resident overview reservation fields.
- **Modify:** `frontend/src/constants/statuses.js`, `frontend/src/utils/depositUiHelpers.js`, `frontend/src/services/buildings.service.js`, `frontend/src/services/resident.service.js`, `frontend/src/pages/admin/contracts/ContractDetailPage.jsx`, `frontend/src/pages/admin/apartments/ApartmentDetailPage.jsx`, `frontend/src/pages/admin/reports/ReportsPage.jsx`, `frontend/src/pages/resident/tabs/OverviewTab.jsx`.
- **Tests:**
  - Create: `api/test/m06TransferAndReservationRls.test.js`, `api/test/m06RoomTransferApprovalFlow.test.js`, `api/test/m06ReservationApprovePayoutFlow.test.js`, `frontend/src/utils/__tests__/m06TransferAndReservationUi.test.js`.
  - Modify: `api/test/m06Phase2PayoutAndReturnedFlow.test.js`, `api/test/depositCollectAndRefund.test.js`, `api/test/m06Phase1P0Fixes.test.js`, `api/test/m06Phase2OwnerApprovalAndEscalation.test.js`, `api/test/m06Phase3P2Features.test.js`, `api/test/m06PostReviewFixes.test.js`, `api/test/remediationR01ToR24.test.js`, `frontend/src/utils/__tests__/m06Phase3Ui.test.js`.

---

### Task 1: Fix P0 `PATCH /api/v1/deposits/:id/bank-info` Nested Payload & `bank_logo` Normalization

**Files:**
- Modify: `api/src/routes/deposits.js:2267-2345`
- Test: `api/test/m06Phase2PayoutAndReturnedFlow.test.js:585-620`

**Interfaces:**
- Consumes: `validateRefundBankInfo({ refundAmount, refundMethod, bankInfo })` from `api/src/services/depositSettlement.js`, `fn_update_deposit_refund_bank_info(UUID, JSONB)` from Migration `045`.
- Produces: `PATCH /api/v1/deposits/:id/bank-info` accepting `{ bank_info: { bank_name, bank_code, bank_bin, bank_logo, account_number, account_holder } }` or flat `{ bank_name, bank_code, bank_bin, bank_logo, account_number, account_holder }` -> `200 { data: { deposit, settlement } }`.

- [ ] **Step 1: Write the failing nested-payload & `bank_logo` assertions in `api/test/m06Phase2PayoutAndReturnedFlow.test.js`**

Add assertions covering:
1. `{ bank_info: [] }` and `{ bank_info: null }` return `422` with `code: 'BANK_INFO_REQUIRED'` (not `500`).
2. `RESIDENT` sending nested `{ bank_info: { bank_name: 'Techcombank', bank_code: 'TCB', bank_bin: '970407', bank_logo: 'https://api.vietqr.io/img/TCB.png', account_number: '190366688899', account_holder: 'CU DAN P2T4 MOI' } }` (matching `ContractTab.jsx` & `DepositsPage.jsx`) returns `200` and persists `bank_logo: 'https://api.vietqr.io/img/TCB.png'` and `bank_bin: '970407'` in `body.data.settlement.bank_info`.
3. `MANAGER` sending flat `{ bank_name: 'MBBank', bank_code: 'MB', account_number: '0987654321', account_holder: 'CU DAN P2T4 MOI' }` continues to return `200` (backward compatibility).

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd d:\resihub\api; node --test test/m06Phase2PayoutAndReturnedFlow.test.js`
Expected: FAIL on nested `{ bank_info: { ... } }` returning `422 BANK_INFO_REQUIRED`.

- [ ] **Step 3: Update `PATCH /:id/bank-info` in `api/src/routes/deposits.js`**

Extract `rawBankPayload` as `req.body?.bank_info && typeof req.body.bank_info === 'object' && !Array.isArray(req.body.bank_info) ? req.body.bank_info : (req.body?.bank_info !== undefined ? {} : req.body || {})` and pass `bankInfo: rawBankPayload` directly to `validateRefundBankInfo`. Keep `0` `adminPool` usages in `deposits.js`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd d:\resihub\api; node --test test/m06Phase2PayoutAndReturnedFlow.test.js`
Expected: PASS (`0` failures).

- [ ] **Step 5: Commit**

```powershell
git add api/src/routes/deposits.js api/test/m06Phase2PayoutAndReturnedFlow.test.js
git commit -m "fix(m06): accept nested bank_info payload and preserve bank_logo on deposit bank-info update"
```

---

### Task 2: Migration `047` — Room-Transfer Columns, Reservation Approval/Payout Statuses, Strict RLS & `SECURITY DEFINER` RPCs

**Files:**
- Create: `api/src/db/migrations/047_m06_transfer_room_and_reservation_payout.sql`
- Create: `api/test/m06TransferAndReservationRls.test.js`

**Interfaces:**
- Consumes: `building_has_active_owner(UUID)`, `get_owner_building_ids()`, `get_manager_building_ids()`, `get_user_assigned_buildings()`, `get_current_user_id()`, `get_current_user_org_id()`, `get_current_user_person_id()` from Migrations `010`–`046`.
- Produces:
  - `contract.is_room_transfer BOOLEAN NOT NULL DEFAULT FALSE`, `contract.transfer_deposit BOOLEAN NOT NULL DEFAULT TRUE`, partial unique index `uq_contract_open_room_transfer` on `contract(parent_contract_id) WHERE is_room_transfer = TRUE AND status IN ('DRAFT', 'PENDING_APPROVAL')`.
  - `reservation.cancel_settlement JSONB`, `reservation_status_check` adding `'CANCEL_PENDING_APPROVAL'` and `'APPROVED_PENDING_PAYOUT'`.
  - `rls_reservation_update`:
    - `MANAGER` (`is_manager() AND building_id IN (SELECT building_id FROM get_manager_building_ids())`): `USING (status IN ('PENDING_CONFIRM', 'HELD', 'EXPIRED', 'CANCEL_PENDING_APPROVAL', 'APPROVED_PENDING_PAYOUT'))`, `WITH CHECK (status IN ('HELD', 'REJECTED', 'CONVERTED', 'CANCEL_PENDING_APPROVAL', 'APPROVED_PENDING_PAYOUT', 'FORFEITED', 'REFUNDED', 'PARTIALLY_REFUNDED', 'EXPIRED'))`.
    - `OWNER` on `get_owner_building_ids()` or `is_org_admin() AND NOT building_has_active_owner(building_id)`: `USING (status IN ('HELD', 'EXPIRED', 'CANCEL_PENDING_APPROVAL'))`, `WITH CHECK (status IN ('HELD', 'EXPIRED', 'APPROVED_PENDING_PAYOUT', 'FORFEITED'))`.
  - Updated `fn_sync_apartment_status_after_reservation(p_apartment_id UUID) RETURNS TEXT` keeping `'RESERVED'` for `r.status IN ('HELD', 'CANCEL_PENDING_APPROVAL') AND (r.hold_until IS NULL OR r.hold_until >= v_today_vn)` and releasing to `'AVAILABLE'` once `FORFEITED` or `APPROVED_PENDING_PAYOUT`.
  - `fn_notify_reservation_staff(p_reservation_id UUID, p_target_audience TEXT, p_type TEXT, p_title TEXT, p_body TEXT) RETURNS INT` (`p_target_audience IN ('APPROVERS', 'BUILDING_MANAGERS')`, `SECURITY DEFINER SET search_path = public, pg_temp`).
  - `fn_update_reservation_refund_bank_info(p_reservation_id UUID, p_bank_info JSONB) RETURNS reservation` (`SECURITY DEFINER SET search_path = public, pg_temp`: allows assigned `MANAGER` or active `RESIDENT` whose `person.phone = reservation.phone` in the same `org_id` to update `refund_bank_info` and set `refund_method = 'BANK_TRANSFER'` only when `status = 'APPROVED_PENDING_PAYOUT'` and `refunded_amount > 0`).

- [ ] **Step 1: Write the failing schema & RLS test (`api/test/m06TransferAndReservationRls.test.js`)**

Cover these exact assertions:
1. Inserting two `DRAFT` contracts with `is_room_transfer = true` and the same `parent_contract_id` fails with PostgreSQL `23505` (`uq_contract_open_room_transfer`), whereas inserting a second one after the first is `CANCELLED` or `ACTIVE` succeeds.
2. Direct `appPool` RLS check as `OWNER` of `VOP-A`:
   - Updating a `CANCEL_PENDING_APPROVAL` reservation to `APPROVED_PENDING_PAYOUT` or `FORFEITED` succeeds (`rowCount = 1`).
   - Directly updating a reservation to `REFUNDED` or `PARTIALLY_REFUNDED` as `OWNER` fails RLS (`42501` or `rowCount = 0`).
3. `fn_sync_apartment_status_after_reservation`:
   - Keeps `apartment.status = 'RESERVED'` while `reservation.status = 'CANCEL_PENDING_APPROVAL'` and `hold_until >= CURRENT_DATE`.
   - Transitions `apartment.status` to `'AVAILABLE'` immediately when `reservation.status` becomes `'APPROVED_PENDING_PAYOUT'`.
4. `fn_update_reservation_refund_bank_info`:
   - Succeeds via `appPool` for the matching-phone `RESIDENT` on an `APPROVED_PENDING_PAYOUT` reservation (`refunded_amount > 0`), updating `refund_bank_info`.
   - Rejects (`42501`) another `RESIDENT` with a different phone number, and rejects (`22023` / `P0001`) when `status !== 'APPROVED_PENDING_PAYOUT'`.

- [ ] **Step 2: Run the migration check & test to verify it fails**

Run: `cd d:\resihub\api; node --test test/m06TransferAndReservationRls.test.js`
Expected: FAIL because columns/constraints/functions from Migration `047` do not exist yet.

- [ ] **Step 3: Create `api/src/db/migrations/047_m06_transfer_room_and_reservation_payout.sql` and apply migrations**

Write idempotent DDL (`ADD COLUMN IF NOT EXISTS`, `CREATE UNIQUE INDEX IF NOT EXISTS`, constraint swap on `reservation`, `DROP POLICY IF EXISTS` + `CREATE POLICY rls_reservation_update`, `CREATE OR REPLACE FUNCTION` + `GRANT EXECUTE ... TO PUBLIC, resihub_app`) and apply via `npm run migrate` (or `src/db/migrate.js`).

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd d:\resihub\api; npm run migrate; node --test test/m06TransferAndReservationRls.test.js`
Expected: PASS (`0` failures).

- [ ] **Step 5: Commit**

```powershell
git add api/src/db/migrations/047_m06_transfer_room_and_reservation_payout.sql api/test/m06TransferAndReservationRls.test.js
git commit -m "feat(m06): add migration 047 for room-transfer flags and reservation payout RLS"
```

---

### Task 3: 4-Step Room Transfer & Deposit Carry-Over API (`DRAFT -> scan -> PENDING_APPROVAL -> approve -> ACTIVE`)

**Files:**
- Modify: `api/src/routes/contracts.js:2350-2470, 2725-3365, 4560-4880`
- Create: `api/test/m06RoomTransferApprovalFlow.test.js`
- Modify: `api/test/depositCollectAndRefund.test.js:705-740`, `api/test/m06Phase1P0Fixes.test.js:434-465`, `api/test/m06Phase3P2Features.test.js:508-530`, `api/test/m06PostReviewFixes.test.js:498-550`

**Interfaces:**
- Consumes: `contract.is_room_transfer`, `contract.transfer_deposit`, `uq_contract_open_room_transfer` from Task 2; `getOrgDepositRefundDays`, `refundDeadline`, `isDiscountedPrice`, `checkFourEyesOrWarn`.
- Produces:
  - `POST /api/v1/contracts/:id/transfer-room`: validates `targetApt.building_id === oldContract.building_id` (`422 CROSS_BUILDING_TRANSFER_NOT_ALLOWED`), `transferDate >= oldContract.start_date` (`422 INVALID_TRANSFER_DATE`), no open transfer (`409 PENDING_TRANSFER_EXISTS`), allows `> 10%` discount into `DRAFT`, keeps `oldContract.status = 'ACTIVE'`, inserts `newContract` (`status = 'DRAFT'`, `is_room_transfer = true`, `transfer_deposit = Boolean(transfer_deposit)`), returns `201 { data: { new_contract, old_contract_id, requires_scan: true, requires_approval: true } }`.
  - `PATCH /api/v1/contracts/:id`: when `contract.is_room_transfer === true`, accepts `transfer_deposit` updates in `DRAFT` and blocks changing `apartment_id` to `oldContract.apartment_id` (`400 SAME_APARTMENT`) or another building (`422 CROSS_BUILDING_TRANSFER_NOT_ALLOWED`).
  - `POST /api/v1/contracts/:id/activate`: enforces `MISSING_SIGNED_SCAN` (`409`), checks `oldContract.status === 'ACTIVE'` (`409 PARENT_CONTRACT_NOT_ACTIVE`) when `is_room_transfer`, and moves `is_room_transfer` contracts to `PENDING_APPROVAL` returning `409 { code: isDiscounted ? 'PRICE_NEEDS_APPROVAL' : 'TRANSFER_NEEDS_APPROVAL', data: pendingContract }`.
  - `POST /api/v1/contracts/:id/approve` & `POST /api/v1/contracts/:id/reject`: `requireRole(['OWNER', 'MANAGER', 'SYS_ADMIN'])` — on owned buildings only building `OWNER` may approve/reject; on unowned buildings (`!building_has_active_owner`) `SYS_ADMIN` or a Four-Eyes peer `MANAGER` (when `!isDiscountedPrice`) may approve/reject. On `approve` of `is_room_transfer`: atomically locks & terminates `oldContract` (`TERMINATED` at `sDateStr`, old apartment -> `MAINTENANCE`), activates `newContract` (`approved_by = req.user.sub`), executes `transfer_deposit` (`TRANSFER_OUT`/`TRANSFER_IN` with `approved_by = req.user.sub`, retaining `surplusAmt` as `HELD` with `refund_due_date` when `surplusAmt > 0`), and returns `{ data, remaining_collect, surplus_deposit_amount }`.

- [ ] **Step 1: Write the failing room-transfer lifecycle test (`api/test/m06RoomTransferApprovalFlow.test.js`)**

Cover these exact cases:
1. Cross-building `POST /:id/transfer-room` returns `422 CROSS_BUILDING_TRANSFER_NOT_ALLOWED`.
2. Valid `POST /:id/transfer-room` (including `> 10%` rent discount and `9,000,000 ₫` held -> `6,000,000 ₫` new deposit) returns `201` with `new_contract.status === 'DRAFT'`, `is_room_transfer === true`, while `oldContract.status` remains `'ACTIVE'` and `oldDep.amount_held` remains `'9000000'`.
3. Duplicate `POST /:id/transfer-room` while the first is in `DRAFT` returns `409 PENDING_TRANSFER_EXISTS`.
4. `POST /:newId/activate` before uploading signed scan fails `409 MISSING_SIGNED_SCAN` (`AC-009.2`).
5. After `POST /:newId/scan`, `POST /:newId/activate` transitions `newContract` to `PENDING_APPROVAL` (`409 TRANSFER_NEEDS_APPROVAL` for standard price, `409 PRICE_NEEDS_APPROVAL` for `> 10%` discount). `MANAGER` attempting `POST /:newId/approve` on a building with active `OWNER` fails `403 FORBIDDEN_NOT_BUILDING_OWNER`.
6. `OWNER` calling `POST /:newId/reject` with reason returns `newContract` to `DRAFT` while `oldContract` stays `ACTIVE`.
7. Re-submitting `activate` and `OWNER` calling `POST /:newId/approve` returns `200` with `surplus_deposit_amount: 3000000`, atomically setting `oldContract.status = 'TERMINATED'`, old apartment `MAINTENANCE`, `newContract.status = 'ACTIVE'`, `newContract.approved_by = owner.userId`, `oldDep` (`HELD`, `3,000,000 ₫`, `refund_due_date` set), `newDep` (`HELD`, `6,000,000 ₫`), and both `TRANSFER_OUT` & `TRANSFER_IN` having `approved_by === owner.userId`.
8. Parent-terminated race: if `oldContract` is terminated before `approve` (or `activate`) runs, `POST /:newId/approve` fails `409 PARENT_CONTRACT_NOT_ACTIVE` without activating `newContract`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd d:\resihub\api; node --test test/m06RoomTransferApprovalFlow.test.js`
Expected: FAIL (`transfer-room` currently activates immediately in 1 step and rejects `> 10%` discount with `422`).

- [ ] **Step 3: Implement the 4-step room-transfer workflow in `api/src/routes/contracts.js` and update the 4 existing room-transfer regression tests**

Refactor `POST /:id/transfer-room`, `PATCH /:id`, `completeActivation`, `runActivationSideEffects` (branching cleanly between `contract.is_room_transfer === true` vs standard renewal `parent_contract_id` so `renew` remains unchanged!), `POST /:id/approve`, and `POST /:id/reject`. Update the 4 existing `transfer-room` callers in `depositCollectAndRefund.test.js`, `m06Phase1P0Fixes.test.js`, `m06Phase3P2Features.test.js`, and `m06PostReviewFixes.test.js` to execute `transfer-room -> scan -> activate -> owner approve`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd d:\resihub\api; node --test test/m06RoomTransferApprovalFlow.test.js test/depositCollectAndRefund.test.js test/m06Phase1P0Fixes.test.js test/m06Phase3P2Features.test.js test/m06PostReviewFixes.test.js`
Expected: PASS (`0` failures).

- [ ] **Step 5: Commit**

```powershell
git add api/src/routes/contracts.js api/test/m06RoomTransferApprovalFlow.test.js api/test/depositCollectAndRefund.test.js api/test/m06Phase1P0Fixes.test.js api/test/m06Phase3P2Features.test.js api/test/m06PostReviewFixes.test.js
git commit -m "feat(m05,m06): require signed scan and four-eyes approval on room transfer with deposit carry-over"
```

---

### Task 4: Separated Reservation Cancel-Settlement (`Propose -> Approve/Reject -> Payout with UNC`), Direct-Refund Alignment, `RP-07` Conservation & Resident Overview

**Files:**
- Modify: `api/src/routes/reservations.js:75-95, 755-1295`
- Modify: `api/src/routes/reports.js:228-265, 418-455`
- Modify: `api/src/routes/public.js:476-490`
- Modify: `api/src/routes/resident.js:260-300`
- Create: `api/test/m06ReservationApprovePayoutFlow.test.js`
- Modify: `api/test/depositCollectAndRefund.test.js`, `api/test/m06Phase1P0Fixes.test.js`, `api/test/m06Phase2OwnerApprovalAndEscalation.test.js`, `api/test/m06Phase3P2Features.test.js`, `api/test/m06PostReviewFixes.test.js`, `api/test/remediationR01ToR24.test.js`

**Interfaces:**
- Consumes: `reservation.cancel_settlement`, `CANCEL_PENDING_APPROVAL`, `APPROVED_PENDING_PAYOUT`, `fn_notify_reservation_staff`, `fn_update_reservation_refund_bank_info`, `fn_sync_apartment_status_after_reservation` from Task 2.
- Produces:
  - `PATCH /api/v1/reservations/:id/cancel-settle` (`MANAGER`): proposes split + bank info (no UNC required) -> `status = 'CANCEL_PENDING_APPROVAL'`.
  - `POST /api/v1/reservations/:id/cancel-approve` (`OWNER`, Four-Eyes `MANAGER`, fallback `SYS_ADMIN`): `refunded_amount === 0` -> `FORFEITED` + apartment `AVAILABLE`; `refunded_amount > 0` -> `APPROVED_PENDING_PAYOUT` + apartment `AVAILABLE`.
  - `POST /api/v1/reservations/:id/cancel-reject` (`OWNER`, Four-Eyes `MANAGER`, fallback `SYS_ADMIN`): requires `reason`, restores `'EXPIRED'` (`hold_until < today`) or `'HELD'`, resets `refunded_amount = 0, forfeited_amount = 0`.
  - `POST /api/v1/reservations/:id/cancel-payout` (`MANAGER` only): requires `status === 'APPROVED_PENDING_PAYOUT'`, valid `refund_bank_info` + `>= 1` UNC in `refund_evidence` when `BANK_TRANSFER` (`422 REFUND_EVIDENCE_REQUIRED`), transitions to `'REFUNDED'` or `'PARTIALLY_REFUNDED'`.
  - `PATCH /api/v1/reservations/:id/bank-info` (`MANAGER`, `RESIDENT`): accepts nested `{ bank_info }` or flat payload via `fn_update_reservation_refund_bank_info`.
  - `PATCH /api/v1/reservations/:id/refund`: transitions `HELD`/`EXPIRED` -> `APPROVED_PENDING_PAYOUT` (releasing apartment to `AVAILABLE`, requiring subsequent `MANAGER` `cancel-payout` with UNC).
  - `GET /api/v1/reports/deposits/ledger` (`RP-07`): `reservation_summary` exposes `pending_payout_count` & `pending_payout_amount`, recognizes `forfeited_in_period` at `approved_at`, and `refunded_in_period` at `payout_at`.
  - `GET /api/v1/resident/overview`: includes `refund_method`, `refund_bank_info`, `cancel_settlement`, and surfaces `CANCEL_PENDING_APPROVAL` / `APPROVED_PENDING_PAYOUT` reservations.

- [ ] **Step 1: Write the failing reservation approve-payout & `RP-07` conservation test (`api/test/m06ReservationApprovePayoutFlow.test.js`)**

Cover these exact scenarios:
1. **`1 MANAGER + 1 OWNER` building (`FR-067` + `Mục 6.2`):**
   - `OWNER` calling `PATCH /:id/cancel-settle` is rejected `403` (`MANAGER` proposes).
   - `MANAGER` proposes partial refund (`hold = 2,000,000`, `refund = 1,200,000`, `forfeit = 800,000`, `BANK_TRANSFER` with STK, **no UNC**) -> `200 CANCEL_PENDING_APPROVAL`, apartment remains `RESERVED`.
   - Same `MANAGER` calling `POST /:id/cancel-approve` fails `403 FOUR_EYES_VIOLATION`; `SYS_ADMIN` calling `cancel-approve` on owned building fails `403 SYS_ADMIN_READ_ONLY_ON_OWNED_BUILDING`.
   - `OWNER` calling `POST /:id/cancel-approve` (with **no UNC**) succeeds `200 APPROVED_PENDING_PAYOUT`, immediately releasing `apartment.status` to `'AVAILABLE'`.
   - **Intermediate `RP-07` check:** `active_held_amount === 0`, `pending_payout_amount === 1200000`, `forfeited_in_period === 800000`, `refunded_in_period === 0`.
   - `RESIDENT` (matching phone) updates STK with nested `{ bank_info: { ..., bank_logo } }` via `PATCH /:id/bank-info` -> `200`, `MANAGER` receives `RESERVATION_BANK_INFO_UPDATED` notification.
   - `OWNER` calling `POST /:id/cancel-payout` fails `403`; `MANAGER` calling `cancel-payout` without UNC fails `422 REFUND_EVIDENCE_REQUIRED`; `MANAGER` calling `cancel-payout` with UNC (`TINY_PNG_B64`) succeeds `200 PARTIALLY_REFUNDED`.
   - **Post-payout `RP-07` check:** `pending_payout_amount === 0`, `forfeited_in_period === 800000`, `refunded_in_period === 1200000`.
2. **Zero-refund (`100%` forfeit) proposal:** `MANAGER` proposes `refund = 0, forfeit = 2,000,000` -> `OWNER` `cancel-approve` finalizes directly to `FORFEITED` in 1 approval step (no `cancel-payout` needed).
3. **Rejection & expired-hold edge case:** Proposing on an `EXPIRED` confirmed reservation (`hold_until < today`) -> `CANCEL_PENDING_APPROVAL` -> `OWNER` calls `POST /:id/cancel-reject` with reason -> restores `status = 'EXPIRED'` and keeps apartment `'AVAILABLE'`.
4. **Direct `PATCH /:id/refund` alignment:** `OWNER` calling `PATCH /:id/refund` transitions to `APPROVED_PENDING_PAYOUT` (without STK), `MANAGER` calling `cancel-payout` before STK fails `422 BANK_INFO_REQUIRED`, `RESIDENT` updates STK via `PATCH /:id/bank-info`, `MANAGER` `cancel-payout` with UNC finalizes `REFUNDED`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd d:\resihub\api; node --test test/m06ReservationApprovePayoutFlow.test.js`
Expected: FAIL (`404` on `/cancel-approve`, `/cancel-payout`, `/bank-info` and `422 REFUND_EVIDENCE_REQUIRED` on `MANAGER` proposal).

- [ ] **Step 3: Implement separated endpoints in `reservations.js`, update `reports.js`, `public.js`, `resident.js`, and update existing reservation regression tests**

Implement all endpoints in `api/src/routes/reservations.js`, update `RP-07` & KPI queries in `api/src/routes/reports.js`, spam filter in `api/src/routes/public.js`, overview projection in `api/src/routes/resident.js`, and align existing `cancel-settle` / `refund` test steps in `depositCollectAndRefund.test.js`, `m06Phase1P0Fixes.test.js`, `m06Phase2OwnerApprovalAndEscalation.test.js`, `m06Phase3P2Features.test.js`, `m06PostReviewFixes.test.js`, and `remediationR01ToR24.test.js`.

- [ ] **Step 4: Run full backend test suite to verify everything passes**

Run: `cd d:\resihub\api; npm test`
Expected: ALL backend test suites PASS (`0` failures), and `(Select-String -Path "src/routes/deposits.js" -Pattern "adminPool").Count` equals `0`.

- [ ] **Step 5: Commit**

```powershell
git add api/src/routes/reservations.js api/src/routes/reports.js api/src/routes/public.js api/src/routes/resident.js api/test/m06ReservationApprovePayoutFlow.test.js api/test/depositCollectAndRefund.test.js api/test/m06Phase1P0Fixes.test.js api/test/m06Phase2OwnerApprovalAndEscalation.test.js api/test/m06Phase3P2Features.test.js api/test/m06PostReviewFixes.test.js api/test/remediationR01ToR24.test.js
git commit -m "feat(m06): separate owner approval and manager UNC payout for reservation cancellations"
```

---

### Task 5: Admin & Resident Frontend Alignment (`ContractDetailPage`, `ApartmentDetailPage`, `ReportsPage`, `OverviewTab` & Pure UI Helpers)

**Files:**
- Modify: `frontend/src/constants/statuses.js:167-178`
- Modify: `frontend/src/utils/depositUiHelpers.js:80-140`
- Modify: `frontend/src/services/buildings.service.js:48-56`
- Modify: `frontend/src/services/resident.service.js`
- Modify: `frontend/src/pages/admin/contracts/ContractDetailPage.jsx`
- Modify: `frontend/src/pages/admin/apartments/ApartmentDetailPage.jsx`
- Modify: `frontend/src/pages/admin/reports/ReportsPage.jsx`
- Modify: `frontend/src/pages/resident/tabs/OverviewTab.jsx`
- Create: `frontend/src/utils/__tests__/m06TransferAndReservationUi.test.js`
- Modify: `frontend/src/utils/__tests__/m06Phase3Ui.test.js`

**Interfaces:**
- Consumes: Task 3 & Task 4 API contracts.
- Produces:
  - `RESERVATION_STATUS.CANCEL_PENDING_APPROVAL` (`{ label: 'Chờ duyệt hủy giữ chỗ', variant: 'amber' }`) and `RESERVATION_STATUS.APPROVED_PENDING_PAYOUT` (`{ label: 'Chờ chi hoàn giữ chỗ', variant: 'sky' }`).
  - `depositUiHelpers.js`:
    - `canProposeReservationCancel(reservation, { isManager })` -> `Boolean`
    - `canApproveReservationCancel(reservation, { isOwner, isManager, isSysAdmin, currentUserId, buildingHasActiveOwner, allowSelfApproval })` -> `Boolean`
    - `canPayoutReservationCancel(reservation, { isManager })` -> `Boolean`
    - `canResidentUpdateReservationBankInfo(reservation)` -> `Boolean`
  - `buildingsService`: `approveReservationCancel(id, payload, options)`, `rejectReservationCancel(id, payload, options)`, `payoutReservationCancel(id, payload, options)`, `updateReservationBankInfo(id, payload, options)`.
  - `residentService`: `updateReservationRefundBankInfo(id, payload, options)`.
  - `ContractDetailPage.jsx`: allows `> 10%` discounted rent in room-transfer modal (showing informational banner that `OWNER` will approve), handles `TRANSFER_NEEDS_APPROVAL` on `activate`, displays room-transfer step banner on `DRAFT`/`PENDING_APPROVAL` (`is_room_transfer`), context-aware approve button label (`"Phê duyệt đổi phòng & kết chuyển cọc"`), and surplus deposit toast upon `approve`.
  - `ApartmentDetailPage.jsx`: separates `MANAGER` Proposal Modal (no UNC upload), `OWNER`/Approver Review Modal (`Duyệt` / `Từ chối` with `policy_override` warning), and `MANAGER` Payout Modal (`Chi hoàn & Tải UNC` + `Sửa STK`).
  - `ReportsPage.jsx`: displays `pending_payout_amount` / `pending_payout_count` in the `RP-07` reservation reconciliation section.
  - `OverviewTab.jsx`: displays `CANCEL_PENDING_APPROVAL` / `APPROVED_PENDING_PAYOUT` reservation cards and a `"Cập nhật STK nhận hoàn"` `BankSelect` modal (`{ bank_info: { ..., bank_logo } }`) when `canResidentUpdateReservationBankInfo(r)` is true.

- [ ] **Step 1: Write the failing frontend UI helper tests (`frontend/src/utils/__tests__/m06TransferAndReservationUi.test.js`)**

Assert:
1. `RESERVATION_STATUS` defines `CANCEL_PENDING_APPROVAL` (`amber`) and `APPROVED_PENDING_PAYOUT` (`sky`).
2. `canProposeReservationCancel` returns `true` only for `isManager: true` on settleable `HELD`/`EXPIRED` rows (`false` for `OWNER` and `SYS_ADMIN`, `false` once in `CANCEL_PENDING_APPROVAL` or `APPROVED_PENDING_PAYOUT`).
3. `canApproveReservationCancel` enforces Four-Eyes against `cancel_settlement.proposed_by || confirmed_by || created_by` (allowing self-approval only when `allowSelfApproval: true`), allows `OWNER` on owned buildings, blocks `SYS_ADMIN` when `buildingHasActiveOwner: true`, and allows fallback `SYS_ADMIN` when `buildingHasActiveOwner: false`.
4. `canPayoutReservationCancel` returns `true` only when `isManager: true`, `status === 'APPROVED_PENDING_PAYOUT'`, and `Number(refunded_amount) > 0` (`false` for `OWNER`).
5. `canResidentUpdateReservationBankInfo` returns `true` only when `reservation_status === 'APPROVED_PENDING_PAYOUT'` (or `status === 'APPROVED_PENDING_PAYOUT'`) and `Number(refunded_amount) > 0`.

- [ ] **Step 2: Run the frontend unit test to verify it fails**

Run: `cd d:\resihub\frontend; node --test src/utils/__tests__/m06TransferAndReservationUi.test.js`
Expected: FAIL (`SyntaxError: The requested module '../depositUiHelpers.js' does not provide an export named 'canProposeReservationCancel'`).

- [ ] **Step 3: Implement status constants, pure UI helpers, service methods, and page components (`ContractDetailPage.jsx`, `ApartmentDetailPage.jsx`, `ReportsPage.jsx`, `OverviewTab.jsx`)**

Note: use explicit `.js` extensions on all relative imports inside `frontend/src/utils/` so both Node ESM (`node --test`) and Vite bundle cleanly.

- [ ] **Step 4: Run all frontend unit tests, linter & production build, and rebuild Docker containers**

Run:
```powershell
cd d:\resihub\frontend
node --test src/utils/__tests__/*.test.js
npm run lint
npm run build
cd d:\resihub
docker compose up -d --build api frontend
```
Expected: All `11/11` frontend test files PASS, `oxlint` `0` errors, `vite build` succeeds, and `resihub-api` + `resihub-frontend` containers start healthy.

- [ ] **Step 5: Commit**

```powershell
git add frontend/src/constants/statuses.js frontend/src/utils/depositUiHelpers.js frontend/src/services/buildings.service.js frontend/src/services/resident.service.js frontend/src/pages/admin/contracts/ContractDetailPage.jsx frontend/src/pages/admin/apartments/ApartmentDetailPage.jsx frontend/src/pages/admin/reports/ReportsPage.jsx frontend/src/pages/resident/tabs/OverviewTab.jsx frontend/src/utils/__tests__/m06Phase3Ui.test.js frontend/src/utils/__tests__/m06TransferAndReservationUi.test.js
git commit -m "feat(ui): update contract room-transfer, reservation approve-payout, RP-07 and resident bank-info modals"
```

