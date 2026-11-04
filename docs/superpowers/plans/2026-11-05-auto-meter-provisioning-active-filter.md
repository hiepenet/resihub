# Auto-Provision Electricity/Water Meters on Active Contract & Active-Contract Filter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically provision default `ELECTRICITY` and `WATER` meters whenever a contract becomes `ACTIVE` (plus backfill existing active-contract apartments such as `VOP-D / A002`), allow safe handover `initial_reading` updates on untouched meters, and add an `ACTIVE`-contract filter to `GET /api/v1/meters` and `MeterReadingsPage.jsx`.

**Architecture:** Introduce an idempotent `ensureApartmentMetersInTx` helper in `api/src/services/meterProvisioning.js` invoked from `contracts.js` activation paths alongside a one-time backfill migration `053_auto_provision_meters_for_active_contracts.sql`. Extend `meters.js` so `POST /api/v1/meters` updates untouched (`0` readings) auto-created meters without `409` while `GET /api/v1/meters` exposes `has_active_contract` and filters by `active_contract=true|false`, wired to a new contract-status filter `Select` on `MeterReadingsPage.jsx`.

**Tech Stack:** Node.js ESM, Express 4, PostgreSQL 16 (`ENABLE` + `FORCE ROW LEVEL SECURITY`), React 19 + Vite + Tailwind CSS 3.4, Node.js `node:test` (`assert/strict`).

**Spec:** `d:\resihub\docs\superpowers\specs\2026-11-05-auto-meter-provisioning-active-filter-design.md`

## Global Constraints

- **Trigger only on `ACTIVE` contracts**: Never auto-create meters for empty (`AVAILABLE`) apartments that have no active contract.
- **Idempotent on existing meters**: Never fail with `23505` or `409 DUPLICATE_METER` or overwrite existing `meter` / `meter_reading` history when activating a contract on an apartment that already has `ELECTRICITY` and/or `WATER` meters.
- **RLS compatibility across `MANAGER` and `OWNER` activation flows**: `meter` has `FORCE ROW LEVEL SECURITY` (`rls_meter_modify` restricted to `MANAGER`); auto-provisioning must succeed both when `MANAGER` calls `POST /api/v1/contracts/:id/activate` (`client`) and when `OWNER` calls `POST /api/v1/contracts/:id/approve` (`adminClient`).
- **Default pricing & handover reading**: Auto-created meters pull `electricity_default_price` (fallback `3800`) and `water_default_price` (fallback `22000`) from `system_setting` (`key = 'billing_config'`), with `initial_reading = 0`, `EL-<building_code>-<apartment_code>` (`kWh`), and `WT-<building_code>-<apartment_code>` (`m³`).
- **Unified active-contract definition**: An apartment has an active contract iff `EXISTS (SELECT 1 FROM contract c WHERE c.apartment_id = m.apartment_id AND c.status IN ('ACTIVE', 'RENEWAL_PENDING', 'TERMINATION_PENDING'))`.

## Review Focus

1. **`OWNER` contract approval (`POST /api/v1/contracts/:id/approve`) under `FORCE ROW LEVEL SECURITY`**: Approving a discounted or room-transfer contract as `OWNER` must auto-create both `ELECTRICITY` and `WATER` meters on the target apartment without throwing PostgreSQL `42501` RLS errors.
2. **Pre-existing `meter_code` collision in the same building (`UNIQUE (building_id, meter_code)`)**: If another apartment in the building already claimed `EL-<bldg>-<apt>` via custom code, both `ensureApartmentMetersInTx` and migration `053` must append `-<aptIdShort>` so contract activation and migration never fail with `23505`.
3. **Successor contract activation on an apartment with existing meters and readings**: Activating Contract B after Contract A ends (or when only `ELECTRICITY` existed manually) must keep existing `meter.id`, `initial_reading`, `unit_price`, and `meter_reading` rows intact while creating only the missing `WATER` meter.
4. **Handover `initial_reading` update via `POST /api/v1/meters` before vs after first reading**: Calling `POST /api/v1/meters` on an auto-created meter with `0` `meter_reading` rows updates `initial_reading` & `unit_price` (`201`), whereas once any `meter_reading` (`DRAFT`, `FLAGGED`, or `CONFIRMED`) exists — or when custom `meter_code` collides with another meter — `POST /api/v1/meters` must return `409 DUPLICATE_METER`.
5. **Malformed or empty `active_contract` query values (`active_contract=invalid`, `active_contract=''`)**: Must be ignored safely (returning all scoped meters) rather than throwing SQL cast errors or hiding rows, while `active_contract=true` includes `ACTIVE` / `RENEWAL_PENDING` / `TERMINATION_PENDING` and excludes `TERMINATED` / `EXPIRED` / `DRAFT` / `CANCELLED`.

---

### Task 1: Auto-Meter Provisioning Service, Contract Activation Hooks & Migration `053`

**Files:**
- Create: `api/src/services/meterProvisioning.js`
- Create: `api/src/db/migrations/053_auto_provision_meters_for_active_contracts.sql`
- Modify: `api/src/routes/contracts.js:2875-2892,3307-3315,4471-4482,4558-4565`
- Create: `api/test/autoMeterProvisioningContract.test.js`

**Interfaces:**
- Produces in `api/src/services/meterProvisioning.js`:
  - `ACTIVE_CONTRACT_STATUSES = ['ACTIVE', 'RENEWAL_PENDING', 'TERMINATION_PENDING']`
  - `buildDefaultMeterCode(meterType: 'ELECTRICITY' | 'WATER', buildingCode: string, apartmentCode: string, collisionSuffix?: string) -> string`
  - `ensureApartmentMetersInTx(queryable, { apartmentId: string, actorId?: string | null }) -> Promise<{ created: object[], existing: object[] }>`
- Produces in DB (`053_auto_provision_meters_for_active_contracts.sql`):
  - Backfills missing `ELECTRICITY` and `WATER` meters (`status = 'ACTIVE'`, `initial_reading = 0`, org `billing_config` default prices) for every apartment currently having a contract in `('ACTIVE', 'RENEWAL_PENDING', 'TERMINATION_PENDING')`.

- [x] **Step 1: Write failing unit & integration tests in `api/test/autoMeterProvisioningContract.test.js`**

Test cases:
1. `buildDefaultMeterCode`: formats `EL-VOP-D-A002` and `WT-VOP-D-A002`, and appends `-<SUFFIX>` when `collisionSuffix` is supplied.
2. `MANAGER` direct activation (`POST /api/v1/contracts/:id/activate`): activating a `DRAFT` contract on a fresh apartment with `0` meters automatically creates `ELECTRICITY` (`kWh`, org `electricity_default_price`, `initial_reading = 0`) and `WATER` (`m³`, org `water_default_price`, `initial_reading = 0`) plus `AUTO_CREATE_METER` audit logs.
3. `OWNER` price-discount approval (`POST /api/v1/contracts/:id/approve`): approving a `PENDING_APPROVAL` contract as `OWNER` creates both `ELECTRICITY` and `WATER` meters under `FORCE ROW LEVEL SECURITY` without `42501` errors (Review Focus #1).
4. Idempotency & partial provisioning + `meter_code` collision safety (Review Focus #2 & #3):
   - If another apartment in the same building already took `EL-<bldg>-<aptCode>`, activating the contract still succeeds (`200`) and creates the electricity meter with `-<aptId6>` suffix.
   - If the apartment already has an `ELECTRICITY` meter (`initial_reading = 1250` + a `CONFIRMED` reading `1300`) before activating a new contract after prior termination, activation keeps `ELECTRICITY` (`id`, `initial_reading = 1250`, reading `1300`) untouched and only creates the missing `WATER` meter; activating a third contract when both exist creates `0` duplicates.
5. Migration `053` verification: every apartment in DB with a contract in `('ACTIVE', 'RENEWAL_PENDING', 'TERMINATION_PENDING')` (including `VOP-D / A002` if present) has both `ELECTRICITY` and `WATER` meters.

- [x] **Step 2: Run test to verify RED failure**

Run: `cd d:\resihub\api; node --test test/autoMeterProvisioningContract.test.js`
Expected: FAIL (`ERR_MODULE_NOT_FOUND` for `../src/services/meterProvisioning.js`).

- [x] **Step 3: Implement `api/src/services/meterProvisioning.js`, `053_auto_provision_meters_for_active_contracts.sql`, and wire `api/src/routes/contracts.js`**

Apply migration via `cd d:\resihub\api; npm run migrate`.

- [x] **Step 4: Run test to verify GREEN pass**

Run: `cd d:\resihub\api; node --test test/autoMeterProvisioningContract.test.js`
Expected: PASS (0 failures).

- [x] **Step 5: Commit Task 1**

```powershell
git add docs/superpowers/specs/2026-11-05-auto-meter-provisioning-active-filter-design.md docs/superpowers/plans/2026-11-05-auto-meter-provisioning-active-filter.md api/src/services/meterProvisioning.js api/src/db/migrations/053_auto_provision_meters_for_active_contracts.sql api/src/routes/contracts.js api/test/autoMeterProvisioningContract.test.js
git commit -m "feat(m06-m08): auto-provision electricity and water meters on contract activation"
```

---

### Task 2: Untouched Meter Initial-Reading Update & `active_contract` Filter in `meters.js`

**Files:**
- Modify: `api/src/routes/meters.js:85-175,380-472`
- Create: `api/test/metersActiveContractFilterAndInit.test.js`

**Interfaces:**
- Consumes from Task 1 (`api/src/services/meterProvisioning.js`): `ACTIVE_CONTRACT_STATUSES`.
- Produces in `api/src/routes/meters.js`:
  - `GET /api/v1/meters?active_contract=true|false`:
    - Exposes `has_active_contract: boolean` on every returned meter row.
    - Filters to apartments with a contract in `ACTIVE_CONTRACT_STATUSES` when `active_contract === 'true'`, without one when `active_contract === 'false'`, and ignores any other value.
  - `POST /api/v1/meters`:
    - When `(apartment_id, meter_type)` already exists with `0` rows in `meter_reading`, updates `initial_reading`, `unit_price`, `status = 'ACTIVE'`, and explicit `meter_code` (if provided), logs `UPDATE_INITIAL_METER`, and returns `201 { data }`.
    - When `(apartment_id, meter_type)` already has `>= 1` `meter_reading` row (or custom `meter_code` collides with another meter), returns `409 DUPLICATE_METER`.

- [x] **Step 1: Write failing integration tests in `api/test/metersActiveContractFilterAndInit.test.js`**

Test cases:
1. Untouched auto-created meter handover update vs recorded meter protection (Review Focus #4):
   - Activating a contract auto-creates `ELECTRICITY` (`initial_reading = 0`); calling `POST /api/v1/meters` with `{ apartment_id, meter_type: 'ELECTRICITY', unit_price: 4100, initial_reading: 1500 }` returns `201` with the same `meter.id`, `initial_reading = 1500`, `unit_price = 4100`.
   - Recording a `DRAFT` reading `1550` on that meter and calling `POST /api/v1/meters` again returns `409 DUPLICATE_METER` and preserves `initial_reading = 1500`.
   - Passing a `meter_code` already owned by another apartment's meter returns `409 DUPLICATE_METER`.
2. `GET /api/v1/meters` `active_contract` filter & `has_active_contract` flag (Review Focus #5):
   - Across 3 apartments in the same test building (`AptActive` with `ACTIVE` contract, `AptRenewal` with `RENEWAL_PENDING` contract, `AptEnded` with only `TERMINATED` contract + meters):
     - Default (`no active_contract`): returns all 6 meters with `has_active_contract === true` for `AptActive` & `AptRenewal` and `false` for `AptEnded`.
     - `active_contract=true`: returns only the 4 meters of `AptActive` and `AptRenewal`.
     - `active_contract=false`: returns only the 2 meters of `AptEnded`.
     - `active_contract=invalid` and `active_contract=`: safely return all 6 meters without error.

- [x] **Step 2: Run test to verify RED failure**

Run: `cd d:\resihub\api; node --test test/metersActiveContractFilterAndInit.test.js`
Expected: FAIL (`409 DUPLICATE_METER` on untouched meter update and `has_active_contract` undefined / unfiltered on `GET /api/v1/meters`).

- [x] **Step 3: Update `GET /api/v1/meters` and `POST /api/v1/meters` in `api/src/routes/meters.js`**

- [x] **Step 4: Run test to verify GREEN pass**

Run: `cd d:\resihub\api; node --test test/metersActiveContractFilterAndInit.test.js`
Expected: PASS (0 failures).

- [x] **Step 5: Commit Task 2**

```powershell
git add api/src/routes/meters.js api/test/metersActiveContractFilterAndInit.test.js
git commit -m "feat(m08-api): add active_contract meter filter and allow initial_reading setup on untouched meters"
```

---

### Task 3: Frontend Active-Contract Filter on `MeterReadingsPage.jsx` & Cross-Suite Regression Verification

**Files:**
- Modify: `frontend/src/utils/billing.js`
- Modify: `frontend/src/pages/admin/meters/MeterReadingsPage.jsx:140-228,722-795`
- Modify (if needed for auto-provisioned meters on contract activation): `api/test/contractEarlyTerminationBillingSync.test.js`, `api/test/m06PostReviewFixes.test.js`
- Create: `api/test/frontendMeterActiveContractFilter.test.js`

**Interfaces:**
- Consumes from Task 2 (`GET /api/v1/meters`): query parameter `active_contract` (`'true' | 'false'`) and row field `has_active_contract: boolean`.
- Produces in `frontend/src/utils/billing.js`:
  - `METER_CONTRACT_FILTER_OPTIONS`: `[{ value: '', label: 'Tất cả căn hộ' }, { value: 'true', label: 'Đang có hợp đồng ACTIVE' }, { value: 'false', label: 'Chưa có hợp đồng ACTIVE' }]`
  - `buildMeterListQueryParams({ buildingId, meterType, statusFilter, activeContractFilter, period, search }) -> object`

- [x] **Step 1: Write failing unit & source-wiring tests in `api/test/frontendMeterActiveContractFilter.test.js`**

Test cases:
1. `METER_CONTRACT_FILTER_OPTIONS` contains `''`, `'true'` (`'Đang có hợp đồng ACTIVE'`), and `'false'` (`'Chưa có hợp đồng ACTIVE'`).
2. `buildMeterListQueryParams` maps `activeContractFilter = 'true'` -> `active_contract: 'true'`, `'false'` -> `active_contract: 'false'`, and omits `active_contract` for `''` or invalid strings while trimming `search`.
3. `MeterReadingsPage.jsx` wires `activeContractFilter` state, `METER_CONTRACT_FILTER_OPTIONS` `<Select>`, and `buildMeterListQueryParams` into `metersService.list(...)`.

- [x] **Step 2: Run test to verify RED failure**

Run: `cd d:\resihub\api; node --test test/frontendMeterActiveContractFilter.test.js`
Expected: FAIL (`METER_CONTRACT_FILTER_OPTIONS` / `buildMeterListQueryParams` not exported from `billing.js`).

- [x] **Step 3: Implement helpers in `frontend/src/utils/billing.js` and wire filter UI in `frontend/src/pages/admin/meters/MeterReadingsPage.jsx`**

Also check M06/M08/M09 integration suites where `activate`/`approve` now auto-creates both meters, updating any rent-only or single-meter test assumptions cleanly if needed.

- [x] **Step 4: Run frontend unit test, `vite build`, and M06/M08/M09 regression suites**

Run:
- `cd d:\resihub\api; node --test test/frontendMeterActiveContractFilter.test.js test/frontendMeterTurnoverUi.test.js`
- `cd d:\resihub\frontend; npm run build`
- `cd d:\resihub\api; node --test --test-concurrency=1 test/autoMeterProvisioningContract.test.js test/metersActiveContractFilterAndInit.test.js test/m08MeterLifecycleAndAnomaly.test.js test/m09InvoicePricingAndMeterGate.test.js test/midMonthTurnoverMetersAndLock.test.js test/midMonthTenantTurnoverMeterBilling.test.js test/m06PostReviewFixes.test.js test/contractEarlyTerminationBillingSync.test.js`
Expected: PASS (0 failures) and `vite build` exit 0.

- [x] **Step 5: Commit Task 3**

```powershell
git add frontend/src/utils/billing.js frontend/src/pages/admin/meters/MeterReadingsPage.jsx api/test/frontendMeterActiveContractFilter.test.js
git commit -m "feat(m08-ui): add active contract filter on MeterReadingsPage"
```
