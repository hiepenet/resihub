# Mid-Month Tenant Turnover Meter Reading & Utility Billing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable accurate, non-destructive meter reading recording, automatic baseline continuation, billed-reading immutability, per-contract utility invoicing, and per-contract deposit settlement checks when multiple contracts occupy the same apartment within a single `YYYY-MM` period (including mid-month move-outs, move-ins, and room transfers).

**Architecture:** Add nullable `contract_id` to `meter_reading` with partial unique indexes `(meter_id, period, contract_id) WHERE contract_id IS NOT NULL` and `(meter_id, period) WHERE contract_id IS NULL`, plus updated `RESIDENT` RLS isolation on `meter_reading` and `can_select_attachment`. Introduce deterministic contract-slot resolution, chained `previous_reading` lookup, billed-reading lock (`409 READING_ALREADY_BILLED`), monotonic successor cascade, and in-transaction `DRAFT` invoice utility-line synchronization across `serviceBilling.js`, `meterTurnoverContext.js`, `meters.js`, `invoices.js`, `deposits.js`, and `MeterReadingsPage.jsx`.

**Tech Stack:** Node.js ESM, Express 4, PostgreSQL 16 (`ENABLE` + `FORCE ROW LEVEL SECURITY`), React 19 + Vite + Tailwind CSS 3.4, Node.js `node:test` (`assert/strict`).

**Spec:** `d:\resihub\docs\superpowers\specs\2026-11-05-mid-month-tenant-turnover-meter-billing-design.md`

## Global Constraints

- **No manual `handover_reading` field**: New contracts in the same month always chain `previous_reading` directly from the latest prior reading of that meter (`contract_id IS NULL` is strictly for legacy rows or periods with zero overlapping contracts).
- **Billed reading immutability (`409 READING_ALREADY_BILLED`)**: Any `meter_reading` referenced by a non-`DRAFT`, non-`VOID`, non-`CANCELLED` invoice line — OR any `CONFIRMED` reading whose `contract_id` is finalized in `period` (including `0 kWh` / `0 m³` readings) — must never be overwritten or mutated.
- **Room-transfer deposit safety**: `deposit.status = 'TRANSFERRED'` must **not** mark an old contract's period as finalized (`is_period_finalized`), because room-transfer deposits transition to `'TRANSFERRED'` at approval time before final meter readings and final invoices are recorded on the vacated apartment.
- **PostgreSQL RLS preservation**: `generateInvoicesCore` (callable by `SYS_ADMIN` or cron) must only `SELECT` from `meter_reading` and never `UPDATE meter_reading` (since `rls_meter_reading_modify` permits only `MANAGER`). `RESIDENT` must only see `CONFIRMED` readings and meter photos belonging to `get_resident_contract_ids()` (or legacy `contract_id IS NULL` on their apartment).
- **No `BEFORE DELETE` superuser blockers**: Use `REFERENCES contract(id) ON DELETE SET NULL` and avoid delete triggers that break `adminPool` test cleanup in `api/test/*.test.js`.

## Review Focus

1. **Batch save (`POST /api/v1/meters/readings/batch`) containing a locked reading (`is_billed = true`)**: Attempting to overwrite a billed reading inside a batch transaction must roll back the entire batch with `409 READING_ALREADY_BILLED`, while `MeterReadingsPage.jsx` must exclude `period_reading_billed === true` rows from `dirtyValidRows`.
2. **Pre-move-in cancelled / non-billable contracts (`CANCELLED`, `DRAFT`, `PENDING_APPROVAL`, or `terminated_at < start_date`)**: Must be excluded from `overlapping_contracts` so they never create phantom turnover slots or steal `target_contract_id`.
3. **Decimal meter readings (`NUMERIC(12,2)`, e.g. `1000.25 -> 1015.75 -> 1040.50 m³`)**: JS floating-point subtraction must be rounded to 2 decimal places (`roundReadingDelta`) on both direct upsert and unlocked `nextRow` cascade so precision artifacts (`15.50000000000009`) never leak into `consumption` or `invoice_line`.
4. **Confirming a `DRAFT`/`FLAGGED` reading when a `DRAFT` invoice already exists (from `allow_missing_meter_readings: true`)**: `POST /meters/readings/:readingId/confirm` and `POST /meters/readings/confirm-batch` must sync the newly confirmed utility line onto the contract's `DRAFT` invoice in the same transaction so issuing that `DRAFT` invoice never bills stale `0 ₫`.
5. **`N >= 3` contracts in the same `YYYY-MM` period**: Slot ordering, partial unique index, chained `previous_reading`, and `generateInvoicesCore` must handle 3+ sequential contracts (`Slot 1/3 -> 2/3 -> 3/3`) without assuming at most 2 contracts.

---

### Task 1: Pure Turnover Slot & Chained Baseline Helpers (`serviceBilling.js`) + Migration `052`

**Files:**
- Create: `api/src/db/migrations/052_meter_reading_per_contract_turnover.sql`
- Modify: `api/src/services/serviceBilling.js`
- Create: `api/test/midMonthTurnoverPureAndSchema.test.js`

**Interfaces:**
- Produces in `api/src/services/serviceBilling.js`:
  - `FINALIZED_SETTLEMENT_DEPOSIT_STATUSES` (`['PENDING_APPROVAL', 'APPROVED_PENDING_PAYOUT', 'RETURNED', 'PARTIALLY_REFUNDED', 'REFUNDED', 'DEDUCTED_FULL', 'DISPUTED']` — excludes `'HELD'` and `'TRANSFERRED'`)
  - `roundReadingValue(val: number) -> number` (rounds finite number to 2 decimal places: `Math.round((Number(val) + Number.EPSILON) * 100) / 100`)
  - `buildPeriodOverlappingContracts(contracts: object[], periodYm: string) -> Array<{ contract_id: string, contract_code: string|null, tenant_name: string|null, building_id: string, apartment_id: string, status: string, start_date: string, last_active_day: string, overlap_start: string, overlap_end: string, is_room_transfer: boolean, is_period_finalized: boolean }>`
  - `selectTargetPeriodContract(overlappingContracts: object[], requestedContractId?: string|null) -> { targetContract: object|null, slotIndex: number, totalSlots: number }` (throws `{ status: 400, code: 'VALIDATION_ERROR' }` when `requestedContractId` is provided but not in `overlappingContracts`)
  - `resolveChainedReadingBounds({ priorPeriodReading, samePeriodReadings, nextPeriodReading, overlappingContracts, targetContractId, existingReadingId, initialReading }) -> { previousReading: number, nextReading: object|null }`
  - `validateChainedReadingInput({ currentReading, previousReading, nextReading }) -> { currentVal: number, consumption: number }` (throws `400 INVALID_READING` if `NaN`, `< previousReading`, or `> nextReading.current_reading`; throws `409 READING_ALREADY_BILLED` if `nextReading?.is_billed && currentVal !== Number(nextReading.previous_reading)`)
- Produces in DB (`052_meter_reading_per_contract_turnover.sql`):
  - Column `meter_reading.contract_id UUID REFERENCES contract(id) ON DELETE SET NULL`
  - Partial unique indexes `ux_meter_reading_period_contract` (`(meter_id, period, contract_id) WHERE contract_id IS NOT NULL`) and `ux_meter_reading_period_null_contract` (`(meter_id, period) WHERE contract_id IS NULL`)
  - Index `idx_meter_reading_contract_period` (`(contract_id, period) WHERE contract_id IS NOT NULL`)
  - Updated `rls_meter_reading_select` and `can_select_attachment` isolating `RESIDENT` by `contract_id`

- [ ] **Step 1: Write failing unit & schema/RLS tests in `api/test/midMonthTurnoverPureAndSchema.test.js`**

Test cases:
1. `buildPeriodOverlappingContracts` & `selectTargetPeriodContract`:
   - Excludes `DRAFT`, `PENDING_APPROVAL`, `CANCELLED`, and pre-move-in `TERMINATED` (`terminated_at < start_date`) contracts (Review Focus #2).
   - Handles 3 sequential contracts in `2026-12` (`01..08`, `10..18`, `20..31`), advancing `slotIndex` `1 -> 2 -> 3` as earlier contracts become `is_period_finalized: true`, and returning slot `3` when all 3 are finalized (Review Focus #5).
   - Treats `deposit_status = 'TRANSFERRED'` without a finalized invoice as `is_period_finalized === false`, while `deposit_status = 'PENDING_APPROVAL'` / `'REFUNDED'` / `'DEDUCTED_FULL'` on `TERMINATED` contracts marks `is_period_finalized === true`.
   - Rejects unknown explicit `requestedContractId` with `400 VALIDATION_ERROR`.
2. `resolveChainedReadingBounds` & `validateChainedReadingInput`:
   - Chains `1000.25 -> 1015.75 -> 1040.50` across 2 contracts in `2026-12` with exact 2-decimal consumption `15.5` and `24.75` (Review Focus #3).
   - Throws `409 READING_ALREADY_BILLED` when `nextReading.is_billed === true` and `currentReading !== nextReading.previous_reading`; throws `400 INVALID_READING` when `currentReading > nextReading.current_reading` on unlocked `nextReading`.
3. DB Schema & RLS check against PostgreSQL:
   - `meter_reading.contract_id` column exists, `ux_meter_reading_period_contract` allows 2 rows in the same `(meter_id, period)` with distinct `contract_id`s while rejecting duplicate `(meter_id, period, contract_id)` and duplicate `(meter_id, period) WHERE contract_id IS NULL`.
   - Under `SET LOCAL role = 'resihub_app'` + `RESIDENT` JWT claims for Resident B, `SELECT` on `meter_reading` and `can_select_attachment('meter_reading', rA.id, ...)` return hidden/`false` for Resident A's reading `rA` (`contract_id = A.id`) and visible/`true` for Resident B's reading `rB` (`contract_id = B.id`).

- [ ] **Step 2: Run test to verify RED failure**

Run: `cd d:\resihub\api; node --test test/midMonthTurnoverPureAndSchema.test.js`
Expected: FAIL (missing exports in `serviceBilling.js` and missing `contract_id` column on `meter_reading`).

- [ ] **Step 3: Implement pure helpers in `api/src/services/serviceBilling.js` and create `api/src/db/migrations/052_meter_reading_per_contract_turnover.sql`**

Apply migration via `cd d:\resihub\api; npm run migrate`.

- [ ] **Step 4: Run test to verify GREEN pass**

Run: `cd d:\resihub\api; node --test test/midMonthTurnoverPureAndSchema.test.js`
Expected: PASS (0 failures).

- [ ] **Step 5: Commit Task 1**

```powershell
git add api/src/db/migrations/052_meter_reading_per_contract_turnover.sql api/src/services/serviceBilling.js api/test/midMonthTurnoverPureAndSchema.test.js
git commit -m "feat(m08-db): add contract_id turnover support to meter_reading and pure chaining helpers"
```

---

### Task 2: Meter Reading Recording, Billed Lock, Successor Cascade & `DRAFT` Invoice Sync (`meterTurnoverContext.js`, `meters.js`, `aiGateway.js`, `apartments.js`)

**Files:**
- Create: `api/src/services/meterTurnoverContext.js`
- Modify: `api/src/routes/meters.js`
- Modify: `api/src/services/aiGateway.js:395-425`
- Modify: `api/src/routes/apartments.js:225-233`
- Create: `api/test/midMonthTurnoverMetersAndLock.test.js`

**Interfaces:**
- Consumes from Task 1 (`serviceBilling.js`): `FINALIZED_SETTLEMENT_DEPOSIT_STATUSES`, `roundReadingValue`, `buildPeriodOverlappingContracts`, `selectTargetPeriodContract`, `resolveChainedReadingBounds`, `validateChainedReadingInput`, `evaluateMeterReadingAnomaly`, `resolveUtilityUnitPrice`, `getMonthBoundsYmd`.
- Consumes from `invoiceLifecycle.js`: `recalculateDraftInvoiceTotalsInTx`, `applyAvailableCreditsInTx`.
- Produces in `api/src/services/meterTurnoverContext.js`:
  - `loadApartmentPeriodContractsMap(queryable, apartmentIds: string[], periodYm: string) -> Promise<Map<string, object[]>>`
  - `loadMeterPeriodReadingsWithLocks(queryable, meterIds: string[], periodYm: string, contractsByApt: Map) -> Promise<Map<string, object[]>>` (annotates each reading with `is_billed` covering both non-`DRAFT`/non-`VOID`/non-`CANCELLED` `invoice_line` match AND finalized-contract `CONFIRMED` lock including `0`-consumption readings)
  - `loadPriorAndNextMeterReadings(queryable, meterId: string, periodYm: string) -> Promise<{ priorReading: object|null, nextPeriodReading: object|null, baselineConsumptions: number[] }>`
  - `syncDraftInvoiceMeterLineInTx(client, { contractId, period, meter, readingRow, actorId }) -> Promise<void>` (when a `DRAFT` invoice exists for `(contractId, period)`, adds/updates `ELECTRICITY`/`WATER` `invoice_line` if `readingRow.status === 'CONFIRMED'` and `lineAmt > 0`, or removes that utility line if `consumption === 0` or `status !== 'CONFIRMED'`, then runs `recalculateDraftInvoiceTotalsInTx` + `applyAvailableCreditsInTx`)
- Produces in `api/src/routes/meters.js`:
  - `GET /api/v1/meters` returns per-meter `target_contract_id`, `target_contract_code`, `target_tenant_name`, `period_slot_index`, `period_total_slots`, `period_reading_billed`, `overlapping_contracts`, and computes `period_*` / `last_known_reading` / `effective_unit_price` for the resolved target slot.
  - `GET /api/v1/meters/readings` and `GET /api/v1/meters/:id/readings` join `contract c ON c.id = mr.contract_id` to expose `contract_code` and order by `mr.period DESC, mr.current_reading DESC, mr.recorded_at DESC`.
  - `POST /api/v1/meters/:id/readings` and `POST /api/v1/meters/readings/batch` accept optional `contract_id`, enforce `409 READING_ALREADY_BILLED`, adopt unbilled orphan `contract_id IS NULL` rows, cascade `previous_reading`/`consumption`/anomaly (`CONFIRMED -> FLAGGED` if abnormal without note) onto an unlocked `nextReading`, and call `syncDraftInvoiceMeterLineInTx`.
  - `POST /api/v1/meters/readings/:readingId/confirm` and `POST /api/v1/meters/readings/confirm-batch` call `syncDraftInvoiceMeterLineInTx` for each confirmed reading.

- [ ] **Step 1: Write failing integration tests in `api/test/midMonthTurnoverMetersAndLock.test.js`**

Test cases:
1. Mid-month turnover recording & slot progression: `30/11 (1000)` -> `Contract A` terminates `15/12`, records `1100` (`CONFIRMED`) -> while `Contract A` has no issued invoice, `GET /meters?period=2026-12` stays on `Contract A` (`period_reading_billed: false`); once `Contract A`'s `2026-12` invoice is `ISSUED`, `POST` overwrite on `Contract A` fails with `409 READING_ALREADY_BILLED` (including inside `POST /readings/batch`, rolling back the batch per Review Focus #1), and when `Contract B` (`start_date: 2026-12-20`) is active, `GET /meters?period=2026-12` advances to `Contract B` (`period_slot_index: 2`, `period_total_slots: 2`, `last_known_reading: 1100`, `period_reading_id: null`) and records `1185` (`consumption = 85`).
2. Zero-consumption lock: `Contract A` records `0 m³` (`50 -> 50`, `CONFIRMED`) on water meter; after `Contract A`'s `2026-12` invoice is `ISSUED` (with Rent + Electricity only), attempting to edit `Contract A`'s `0 m³` water reading returns `409 READING_ALREADY_BILLED`.
3. Explicit `contract_id` & unlocked successor cascade + `FLAGGED` downgrade + decimal precision: With both `R_A` (`1000.25 -> 1050.50`, unbilled) and `R_B` (`1050.50 -> 1185.75`, `CONFIRMED`, unbilled) in `2026-12` and 3-period baseline `100 kWh`, lowering `R_A` to `1020.25` cascades `R_B` to `previous_reading = 1020.25`, `consumption = 165.5` (`+65.5% > 30%` without note), downgrading `R_B.status` to `'FLAGGED'` (Review Focus #3). Once `R_B` is billed, editing `R_A` to `1030` fails with `409 READING_ALREADY_BILLED`.
4. `DRAFT` invoice auto-sync on edit & confirm (Review Focus #4): Generating a `DRAFT` invoice with `allow_missing_meter_readings: true`, recording a `DRAFT` reading `1100`, and calling `POST /meters/readings/:id/confirm` automatically adds the `ELECTRICITY` line to the `DRAFT` invoice; editing the `CONFIRMED` reading to `1120` while the invoice is still `DRAFT` updates the `DRAFT` invoice line & total in-place.
5. `apartments.js` `GET /apartments/:id` returns `latest_reading = 1185` (not `1100`), and AI OCR context resolves `previousValue = 1100` for Slot 2 in `2026-12`.

- [ ] **Step 2: Run test to verify RED failure**

Run: `cd d:\resihub\api; node --test test/midMonthTurnoverMetersAndLock.test.js`
Expected: FAIL (`ON CONFLICT (meter_id, period)` failure / missing `READING_ALREADY_BILLED` / missing `target_contract_id`).

- [ ] **Step 3: Implement `api/src/services/meterTurnoverContext.js` and update `meters.js`, `aiGateway.js`, and `apartments.js`**

Restart `resihub-api` container (`docker restart resihub-api`) if needed for live container parity after backend changes.

- [ ] **Step 4: Run test to verify GREEN pass**

Run: `cd d:\resihub\api; node --test test/midMonthTurnoverMetersAndLock.test.js`
Expected: PASS (0 failures).

- [ ] **Step 5: Commit Task 2**

```powershell
git add api/src/services/meterTurnoverContext.js api/src/routes/meters.js api/src/services/aiGateway.js api/src/routes/apartments.js api/test/midMonthTurnoverMetersAndLock.test.js
git commit -m "feat(m08-meters): support per-contract turnover readings, billed lock, cascade, and draft invoice sync"
```

---

### Task 3: Per-Contract Invoice Generation, Room-Transfer Cutoff, Deposit Preconditions & Resident Portal (`invoices.js`, `deposits.js`, `resident.js`)

**Files:**
- Modify: `api/src/routes/invoices.js:209-224, 311-354, 385-450`
- Modify: `api/src/routes/deposits.js:250-290`
- Modify: `api/src/routes/resident.js:1459-1495`
- Create: `api/test/midMonthTenantTurnoverMeterBilling.test.js`

**Interfaces:**
- Consumes from Task 1 & Task 2: `meter_reading.contract_id`, `formula_meta.reading_id`, `POST /api/v1/meters/:id/readings`.
- Updates in `api/src/routes/invoices.js`:
  - `statusClause`: allows room-transfer parent `TERMINATED` contracts (`rt.child_start_date IS NOT NULL`) to bill periods from `to_char(c.terminated_at, 'YYYY-MM')` through `rt.child_start_date - INTERVAL '1 day'` even when `rt.child_start_date - 1 day` falls in a subsequent month.
  - Missing-meter gate (`AC-015.1`): requires a `CONFIRMED` `meter_reading` matching `mr.contract_id = c.id` (or legacy `mr.contract_id IS NULL` not consumed by another contract's active invoice in `targetPeriod`), removing the cross-contract bypass.
  - Utility line builder: selects per-meter `CONFIRMED` reading for `c.id` (`mr.contract_id = c.id` preferred over unconsumed `mr.contract_id IS NULL`), removes cross-contract `alreadyBilledRes` skip, and records `contract_id: c.id` + `reading_id: mr.id` in `formula_meta`.
- Updates in `api/src/routes/deposits.js`:
  - `checkSettlementPreconditions`: scopes `missingMeterTypes` and `unbilledMeterTypes` to `mr.contract_id = contractRow.contract_id` (or unconsumed legacy `mr.contract_id IS NULL`), preserving header-level `invoice` check on `unbilledMeterTypes`.
- Updates in `api/src/routes/resident.js`:
  - `GET /api/v1/resident/invoices`: prioritizes `mr.id = formula_meta->>'reading_id'`, then `mr.contract_id = inv.contract_id`, then `mr.contract_id IS NULL`.

- [ ] **Step 1: Write failing end-to-end integration tests in `api/test/midMonthTenantTurnoverMeterBilling.test.js`**

Test cases:
1. Full user turnover scenario (`30/11 -> 15/12 -> 20/12 -> 31/12 -> 31/01`) + 3-contract turnover month (Review Focus #5):
   - `30/11`: `1000 kWh`.
   - `15/12`: `Contract A` terminates, records `1100 kWh`, generates & issues `2026-12` invoice (`100 kWh` + 15/31 pro-rata rent).
   - `20/12`: `Contract B` activates (with custom `contract_service_price` override `4.200 ₫/kWh`). Calling `POST /invoices/generate-batch` for `2026-12` **before** recording `B`'s reading skips `B` with `MISSING_CONFIRMED_METER_READING`.
   - `31/12`: `Contract B` records `1185 kWh` -> `generate-batch` creates `B`'s `2026-12` invoice billing `85 kWh * 4.200 ₫ = 357.000 ₫` (`1100 → 1185 kWh`) + 12/31 pro-rata rent.
   - `2027-01`: Next month reading `1300 kWh` chains from `1185 kWh` (`115 kWh`).
   - Also verifies a 3-contract month (`A`, `B`, `C` in one period) bills exact non-overlapping deltas summing to total meter delta.
2. Per-contract deposit settlement preconditions:
   - After `Contract A` settles `2026-12`, `Contract B` also terminates early on `28/12` before recording `B`'s reading -> `GET /deposits/:depB/settlement` reports `final_meters_recorded: false` and `POST` settlement returns `409 MISSING_FINAL_METER_READING` (cannot piggyback on `A`'s `2026-12` reading). After `B` confirms `1185 kWh` (`85 kWh > 0`) without issuing `B`'s invoice -> `409 UNBILLED_FINAL_METER_READING`; after issuing `B`'s invoice -> `ready: true`.
3. Room transfer (`transfer-room`) scenarios:
   - Mid-month room transfer (`Apt 1 -> Apt 2` on `15/12` with `transfer_deposit: true` setting `oldDep.status = 'TRANSFERRED'`): `Apt 1` still targets `oldContract` for move-out reading (`1000 -> 1060`), bills `oldContract`, and lets a new incoming tenant on `Apt 1` (`20/12`) chain from `1060`; meanwhile `Apt 2` (which had a prior tenant move out `10/12` at `500 kWh`) chains the transferred contract as Slot 2 from `500 -> 575 kWh`.
   - Scheduled future-month room transfer (`terminated_at` in `2028-11`, `child.start_date = '2028-12-15'`): `generate-batch` for `2028-11` still bills `oldContract`'s full November period AND `2028-12` bills `01/12..14/12`.
4. Resident Portal & Attachment isolation:
   - `GET /api/v1/resident/invoices` for Resident A and Resident B each returns their own `meter_image_url`, and `GET /api/v1/attachments/:attA/view` with Resident B's token is denied (`403`/`404`).

- [ ] **Step 2: Run test to verify RED failure**

Run: `cd d:\resihub\api; node --test test/midMonthTenantTurnoverMeterBilling.test.js`
Expected: FAIL (`Contract B` skipped utility billing / bypassed missing-meter gate / future room-transfer missed `2028-11`).

- [ ] **Step 3: Implement updates in `api/src/routes/invoices.js`, `api/src/routes/deposits.js`, and `api/src/routes/resident.js`**

- [ ] **Step 4: Run test to verify GREEN pass**

Run: `cd d:\resihub\api; node --test test/midMonthTenantTurnoverMeterBilling.test.js`
Expected: PASS (0 failures).

- [ ] **Step 5: Commit Task 3**

```powershell
git add api/src/routes/invoices.js api/src/routes/deposits.js api/src/routes/resident.js api/test/midMonthTenantTurnoverMeterBilling.test.js
git commit -m "feat(m09-billing): bill per-contract turnover meter readings and scope deposit preconditions"
```

---

### Task 4: Admin UI Turnover Badge, Locked-Row Guard & Modal Contract Selector (`billing.js`, `MeterReadingsPage.jsx`)

**Files:**
- Modify: `frontend/src/utils/billing.js`
- Modify: `frontend/src/pages/admin/meters/MeterReadingsPage.jsx`
- Create: `api/test/frontendMeterTurnoverUi.test.js`

**Interfaces:**
- Produces in `frontend/src/utils/billing.js`:
  - `isMeterRowLockedForEdit(row: object, canWriteMeters: boolean) -> boolean` (`!canWriteMeters || Boolean(row?.period_reading_billed)`)
  - `resolveMeterTurnoverBadgeMeta(row: object) -> { showContractTag: boolean, isMultiSlot: boolean, slotLabel: string|null, contractCode: string|null, tenantName: string|null }`
  - `resolveMeterSlotView(meter: object, selectedContractId?: string|null) -> object` (projects `overlapping_contracts` entry onto `meter` fields `period_reading_id`, `period_previous_reading`, `period_current_reading`, `period_reading_status`, `period_reading_billed`, `last_known_reading` when switching contracts inside the Detail Modal)
- Updates in `frontend/src/pages/admin/meters/MeterReadingsPage.jsx`:
  - Renders contract code & turnover slot badge (`Đợt 2/2`) in the Apartment/Meter cell.
  - Disables table input & AI scan button when `isMeterRowLockedForEdit(row, canWriteMeters)` is `true`, renders `Đã lập HĐ` badge, and excludes `period_reading_billed` rows from `dirtyValidRows` (Review Focus #1).
  - Adds contract `Select` inside the Detail Modal when `selectedMeter.overlapping_contracts?.length > 1`, passing `contract_id` on `recordReading`, disabling save buttons if the selected slot is already billed, and displaying `h.contract_code` in the modal history table.

- [ ] **Step 1: Write failing unit & source-contract tests in `api/test/frontendMeterTurnoverUi.test.js`**

Test cases:
1. `isMeterRowLockedForEdit` returns `true` whenever `row.period_reading_billed === true` (even for `MANAGER`), and `false` for unbilled rows when `canWriteMeters === true`.
2. `resolveMeterTurnoverBadgeMeta` formats `Đợt 2/2` when `period_total_slots === 2, period_slot_index === 2`, and `resolveMeterSlotView` switches baseline, current reading, status, and `period_reading_billed` accurately between Slot 1 (`billed`, `1000 -> 1100`) and Slot 2 (`unrecorded`, `prev = 1100`) in `overlapping_contracts`.
3. `MeterReadingsPage.jsx` wires `isMeterRowLockedForEdit`, `resolveMeterTurnoverBadgeMeta`, `resolveMeterSlotView`, excludes `period_reading_billed` from `dirtyValidRows`, passes `contract_id` in `handleSaveSingle`, and renders `contract_code` in the history table.

- [ ] **Step 2: Run test to verify RED failure**

Run: `cd d:\resihub\api; node --test test/frontendMeterTurnoverUi.test.js`
Expected: FAIL (missing exports in `frontend/src/utils/billing.js`).

- [ ] **Step 3: Implement helpers in `frontend/src/utils/billing.js` and UI updates in `frontend/src/pages/admin/meters/MeterReadingsPage.jsx`**

- [ ] **Step 4: Run frontend UI unit tests, Vite production build, and full backend test suite**

Run:
1. `cd d:\resihub\api; node --test test/frontendMeterTurnoverUi.test.js`
2. `cd d:\resihub\frontend; npm run build`
3. `cd d:\resihub\api; npm test`
Expected: All unit/integration suites PASS (0 failures) and `vite build` exits `0`.

- [ ] **Step 5: Commit Task 4**

```powershell
git add frontend/src/utils/billing.js frontend/src/pages/admin/meters/MeterReadingsPage.jsx api/test/frontendMeterTurnoverUi.test.js
git commit -m "feat(m08-ui): display turnover contract slots and lock billed readings on MeterReadingsPage"
```

