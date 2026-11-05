# Resident, Contract & Apartment Navigation Performance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate multi-second data loading and skeleton flashes when navigating between Resident Profiles (`M04`), Contracts (`M05`), and Buildings/Apartments (`M03`) across database RLS/SQL, backend API bundles, and frontend SWR caching + route preloading.

**Architecture:** Add missing PostgreSQL foreign-key/lookup indexes and replace per-row PL/pgSQL RLS scans (`can_select_person`, `can_select_tenant`, `rls_contract_select`, `rls_contract_occupant_select`) with zero-row-argument set-based `SECURITY DEFINER` helpers + `InitPlan` guards, while rewriting `GET /api/v1/tenants` to use set-based CTEs and server-side `building_id` filtering. Consolidate `ApartmentDetail` (`zones`) and `ContractDetail` (`occupants`, `amendments`, `service_prices`, `catalog_services`) payloads, lazy-load non-active `BuildingDetailPage` tabs, forward preloaded props into `FloorPlanView`, and introduce an auth-scoped client SWR `queryCache` + route chunk preloader.

**Tech Stack:** Node.js ESM, Express 4, PostgreSQL 16 (`ENABLE` + `FORCE ROW LEVEL SECURITY`), React 19 + Vite + Zustand + Axios, Node.js `node:test` (`assert/strict`).

**Spec:** `d:\resihub\docs\superpowers\specs\2026-11-05-resident-contract-apartment-navigation-perf-design.md`

## Global Constraints

- **GUC backward compatibility (`app.current_user_id` only):** All RLS helper functions and policies must derive role, org, and building scope exclusively from `get_current_user_id()` (`current_setting('app.current_user_id', true)`), with default-deny (`0` rows / `FALSE`) when unset or empty.
- **`INSERT ... RETURNING *` visibility under RLS:** `rls_person_select` and `rls_tenant_select` must preserve direct tuple-column checks (`person.created_by`, `tenant.created_by`, `tenant.desired_building_id`) alongside set-based `IN (SELECT ...)` helpers so uncommitted rows inserted by `MANAGER` or `RESIDENT` pass `FOR SELECT` checks during `INSERT ... RETURNING *`.
- **PII masking parity (`PRD 13.5`):** `OWNER` must receive masked `id_number` (`maskIdNumber`) on `GET /api/v1/tenants` and `GET /api/v1/contracts/:id` (`occupants`), and `RESIDENT` must receive masked `id_number` for co-occupants whose `person_id !== req.user.person_id`.
- **Zero cross-session cache leakage & fresh post-mutation reads:** Client `queryCache` keys must be scoped by authenticated user identity, purged immediately on `setAuthData` / `clearSession`, and invalidated automatically on mutating `POST` / `PATCH` / `PUT` / `DELETE` requests (with `{ force: true }` support for explicit reloads).
- **Zero new npm runtime dependencies:** Implement client SWR caching, in-flight deduplication, and route preloading using pure ES modules inside `frontend/src/` so Docker `resihub-frontend` works without container image rebuilds.

## Review Focus

1. **`INSERT INTO person / tenant ... RETURNING *` by `MANAGER` before any contract exists:** A newly inserted `person` or `tenant` (including a `tenant` row whose `created_by` is `NULL` while `person.created_by = v_user_id`) must remain visible to the creating `MANAGER` in `RETURNING *` and subsequent `SELECT`s, while remaining hidden from `MANAGER`s of other buildings.
2. **Out-of-scope `GET /api/v1/tenants?building_id=<otherBuildingId>` by `MANAGER` or `OWNER`:** Passing a `building_id` outside the caller's assigned/owned buildings must return `{ data: [] }` (never leaking tenants from the caller's other buildings or the target building), and invalid non-UUID `building_id` values must return `{ data: [] }` rather than `500 DB_ERROR` (`invalid input syntax for type uuid`).
3. **`OWNER` and `RESIDENT` PII masking inside bundled `GET /api/v1/contracts/:id` `occupants`:** Bundling `occupants` into `GET /api/v1/contracts/:id` must apply the exact same `maskIdNumber` logic as `GET /api/v1/contracts/:id/occupants` so neither `OWNER` nor co-occupant `RESIDENT`s ever see raw CCCD numbers of other residents.
4. **Cross-user cache bleed when switching accounts (`MANAGER` -> `OWNER` or `Logout` -> `Login`):** Cached unmasked `tenants` or `contracts` fetched by `MANAGER` must never be returned by `peekQueryCache` or `cachedFetch` after switching to `OWNER` or logging out.
5. **Failed in-flight request poisoning in `queryCache`:** A rejected HTTP promise (network error / `401` / `500`) must be evicted from both in-flight deduplication and data cache immediately so the very next retry triggers a fresh network request.

---

### Task 1: Migration `054` (Indexes + Set-Based RLS) & `GET /api/v1/tenants` Query Optimization

**Files:**
- Create: `api/src/db/migrations/054_rls_and_tenant_navigation_perf.sql`
- Modify: `api/src/routes/tenants.js:326-505`
- Create: `api/test/tenantAndRlsNavigationPerf.test.js`

**Interfaces:**
- Produces in DB (`054_rls_and_tenant_navigation_perf.sql`):
  - Indexes: `idx_app_user_person_id`, `idx_contract_occupant_contract_id`, `idx_contract_occupant_tenant_id`, `idx_contract_parent_contract_id`, `idx_reservation_phone_building`, `idx_tenant_desired_building_id`, `idx_person_created_by`, `idx_tenant_created_by`
  - Functions (`STABLE SECURITY DEFINER SET row_security = off`): `get_accessible_person_ids()`, `get_other_building_contract_person_ids()`, `get_manager_created_person_ids()`, `get_accessible_tenant_ids()`, `get_other_building_contract_tenant_ids()`, plus optimized `can_select_person(...)` and `can_select_tenant(...)`
  - Updated `SELECT` policies: `rls_person_select`, `rls_tenant_select`, `rls_contract_select`, `rls_contract_occupant_select`
- Produces in HTTP API (`api/src/routes/tenants.js`):
  - `GET /api/v1/tenants?building_id=<optionalUuid>` returning `{ data: TenantRow[] }` with identical row shape (`active_contract`, `has_past_contract`, `is_shared_profile`, `id_number` masked for `OWNER`) in `< 150 ms` across `SYS_ADMIN`, `OWNER`, and `MANAGER`.

- [ ] **Step 1: Write failing schema, RLS parity, edge-case & latency tests in `api/test/tenantAndRlsNavigationPerf.test.js`**

Test cases:
1. Required indexes (`idx_app_user_person_id`, `idx_contract_occupant_contract_id`, `idx_contract_occupant_tenant_id`, `idx_contract_parent_contract_id`) exist in `pg_indexes`.
2. `EXPLAIN (ANALYZE, FORMAT JSON)` on `SELECT p.id FROM person p` under `resihub_app` as `MANAGER` executes in `< 50 ms` (vs baseline `2,207 ms`).
3. RLS parity & Review Focus #1:
   - Default-deny (`0` rows) on `person` and `tenant` when `app.current_user_id` is empty/reset.
   - `MANAGER` A running `INSERT INTO person (...) RETURNING *` followed by `INSERT INTO tenant (person_id, org_id, status) VALUES (..., NULL created_by) RETURNING *` succeeds and sees both rows, while `MANAGER` B (`other building`) sees `0` rows for both.
4. `GET /api/v1/tenants` latency, `building_id` scoping & Review Focus #2:
   - `SYS_ADMIN`, `OWNER`, and `MANAGER` each complete `GET /api/v1/tenants` in `< 200 ms` (single request) with valid `active_contract` (`member_role` `'primary'` / `'occupant'`) and boolean `has_past_contract`.
   - `GET /api/v1/tenants?building_id=<vopBuildingId>` returns only tenants linked to that building; `MANAGER` requesting an unassigned `building_id` or non-UUID `building_id=not-a-uuid` receives `200 { data: [] }`.
   - `OWNER` continues to receive masked `id_number` (`id_number_masked_for_owner: true`).

- [ ] **Step 2: Run test to verify RED failure**

Run: `cd d:\resihub\api; node --test test/tenantAndRlsNavigationPerf.test.js`
Expected: FAIL (missing `idx_app_user_person_id` index, `EXPLAIN` > `50 ms`, `GET /api/v1/tenants` > `200 ms` and ignores `building_id`).

- [ ] **Step 3: Create `api/src/db/migrations/054_rls_and_tenant_navigation_perf.sql`, run `npm run migrate`, and rewrite `GET /api/v1/tenants` in `api/src/routes/tenants.js`**

Apply migration via `cd d:\resihub\api; npm run migrate` and verify `resihub-api` reloads `tenants.js`.

- [ ] **Step 4: Run test to verify GREEN pass**

Run: `cd d:\resihub\api; node --test test/tenantAndRlsNavigationPerf.test.js`
Expected: PASS (0 failures).

---

### Task 2: Backend Detail Payload Consolidation (`apartments.js`, `contracts.js`, `services.js`)

**Files:**
- Modify: `api/src/routes/apartments.js:188-253`
- Modify: `api/src/routes/contracts.js:133-204,1256-1346,2054-2094`
- Modify: `api/src/routes/services.js:34-54`
- Create: `api/test/detailBundleConsolidation.test.js`

**Interfaces:**
- Produces in `GET /api/v1/apartments/:id`:
  - Adds `zones: Array<{ id, building_id, code, name, total_apartments, ... }>` to `res.body.data`.
- Produces in `GET /api/v1/contracts/:id`:
  - Adds `occupants: Array<{ tenant_id, status, full_name, phone, email, id_number, relationship }>` (via shared `fetchContractOccupantsForViewer(contractId, req)`), `amendments: Array<object>`, `service_prices: Array<object>`, and `catalog_services: Array<object>` to `res.body.data`.
- Produces in `GET /api/v1/service-catalog`:
  - Filters `sc.is_active = TRUE` when either `active_only === 'true'` or `is_active === 'true'`.

- [ ] **Step 1: Write failing integration tests in `api/test/detailBundleConsolidation.test.js`**

Test cases:
1. `GET /api/v1/apartments/:id` returns `Array.isArray(body.data.zones) === true` sorted by `code ASC` with `total_apartments` integer counts matching `GET /api/v1/buildings/:buildingId/zones`.
2. `GET /api/v1/contracts/:id` returns `occupants`, `amendments`, `service_prices`, and `catalog_services` arrays in a single request matching the standalone sub-resource endpoints.
3. Review Focus #3 (PII masking): When an occupant with an `id_number` exists on the contract, `MANAGER` sees the full `id_number` in `GET /api/v1/contracts/:id` `data.occupants`, whereas `OWNER` sees the masked `id_number` (`*`) matching `GET /api/v1/contracts/:id/occupants`.
4. `GET /api/v1/service-catalog?is_active=true` excludes inactive catalog items (`is_active === false`).

- [ ] **Step 2: Run test to verify RED failure**

Run: `cd d:\resihub\api; node --test test/detailBundleConsolidation.test.js`
Expected: FAIL (`body.data.zones` is `undefined` on `GET /api/v1/apartments/:id` and `body.data.occupants` is `undefined` on `GET /api/v1/contracts/:id`).

- [ ] **Step 3: Implement bundled queries in `apartments.js`, `contracts.js`, and `is_active` support in `services.js`**

Share `fetchContractOccupantsForViewer(contractId, req)` between `GET /:id` and `GET /:id/occupants` in `contracts.js`.

- [ ] **Step 4: Run test to verify GREEN pass**

Run: `cd d:\resihub\api; node --test test/detailBundleConsolidation.test.js`
Expected: PASS (0 failures).

---

### Task 3: Auth-Scoped Client SWR Query Cache, Request Deduplication & Service Wiring

**Files:**
- Create: `frontend/src/services/queryCache.js`
- Modify: `frontend/src/stores/authStore.js`
- Modify: `frontend/src/services/api.js`
- Modify: `frontend/src/services/tenants.service.js`
- Modify: `frontend/src/services/contracts.service.js`
- Modify: `frontend/src/services/buildings.service.js`
- Modify: `frontend/src/services/services.service.js`
- Modify: `frontend/src/services/users.service.js`
- Create: `api/test/frontendQueryCacheUnit.test.js`

**Interfaces:**
- Produces in `frontend/src/services/queryCache.js`:
  - `buildCacheKey(namespace: string, parts?: unknown) -> string`
  - `setQueryCacheScopeResolver(fn: () => string) -> void`
  - `peekQueryCache(key: string, options?: { maxStaleMs?: number }) -> { data: any, isFresh: boolean, updatedAt: number } | null`
  - `cachedFetch(key: string, fetcher: () => Promise<any>, options?: { ttlMs?: number, maxStaleMs?: number, force?: boolean }) -> Promise<any>`
  - `invalidateQueryCache(prefixes?: string | string[]) -> void`
  - `invalidateRelatedNamespacesForUrl(url: string) -> void`
  - `clearQueryCache() -> void`
- Service GET methods (`tenantsService.list/getById/getIdImages`, `contractsService.list/getById/listRequests`, `buildingsService.list/getById/getFloorMap/listFloors/listZones/listApartments/getApartment/getReservationCancelPolicy`, `servicesService.listCatalog`, `usersService.getSettings`) accept optional `{ force?: boolean }` (as last param or inside `options`) and expose `peek*` helpers (`tenantsService.peekList`, `tenantsService.peekById`, `contractsService.peekList`, `contractsService.peekById`, `buildingsService.peekList`, `buildingsService.peekById`, `buildingsService.peekFloorMap`, `buildingsService.peekApartment`) for synchronous zero-skeleton initial render.

- [ ] **Step 1: Write failing unit tests in `api/test/frontendQueryCacheUnit.test.js`**

Test cases:
1. Concurrent `cachedFetch` calls with identical key share one in-flight `fetcher()` invocation (`calls === 1`) — neutralizing `<StrictMode>` double-mounts.
2. Fresh TTL hit returns cached value without invoking `fetcher()` again; `{ force: true }` bypasses fresh cache and updates stored value.
3. Expired TTL (`ttlMs` elapsed, within `maxStaleMs`) returns `{ data, isFresh: false }` from `peekQueryCache` while `cachedFetch` fetches fresh data.
4. Review Focus #4 (Cross-user isolation): Switching scope from `'user-mgr'` to `'user-owner'` makes `peekQueryCache` return `null` and `cachedFetch` invoke `fetcher()` afresh; `clearQueryCache()` wipes all scopes.
5. Review Focus #5 (Failed request recovery): Rejecting `fetcher()` is not cached and evicts the in-flight entry so the immediate next `cachedFetch` retries cleanly.
6. `invalidateRelatedNamespacesForUrl('/api/v1/contracts/123/approve')` invalidates `contracts`, `apartments`, `buildings`, `tenants`, and `deposits` entries while keeping unrelated `settings` intact.

- [ ] **Step 2: Run test to verify RED failure**

Run: `cd d:\resihub\api; node --test test/frontendQueryCacheUnit.test.js`
Expected: FAIL (`Cannot find module '../../frontend/src/services/queryCache.js'`).

- [ ] **Step 3: Implement `queryCache.js` and wire `authStore.js`, `api.js`, and the 5 frontend service modules**

Ensure `authStore.setAuthData` and `authStore.clearSession` call `clearQueryCache()`, and `api.js` response interceptor calls `invalidateRelatedNamespacesForUrl(response.config?.url)` on `POST`/`PATCH`/`PUT`/`DELETE`.

- [ ] **Step 4: Run test to verify GREEN pass**

Run: `cd d:\resihub\api; node --test test/frontendQueryCacheUnit.test.js`
Expected: PASS (0 failures).

---

### Task 4: Frontend Waterfall Elimination, Instant Cache-Seeded Pages & Route Chunk Preloading

**Files:**
- Create: `frontend/src/router/routePreloaders.js`
- Modify: `frontend/src/router/index.jsx`
- Modify: `frontend/src/components/layout/Sidebar.jsx`
- Modify: `frontend/src/components/layout/AdminLayout.jsx`
- Modify: `frontend/src/pages/admin/buildings/BuildingDetailPage.jsx`
- Modify: `frontend/src/pages/admin/buildings/FloorPlanPage.jsx`
- Modify: `frontend/src/pages/admin/buildings/BuildingsPage.jsx`
- Modify: `frontend/src/pages/admin/apartments/ApartmentDetailPage.jsx`
- Modify: `frontend/src/pages/admin/contracts/ContractsPage.jsx`
- Modify: `frontend/src/pages/admin/contracts/ContractDetailPage.jsx`
- Modify: `frontend/src/pages/admin/tenants/TenantsPage.jsx`
- Modify: `frontend/src/pages/admin/tenants/TenantDetailPage.jsx`
- Create: `api/test/frontendNavigationWaterfallsAndPreload.test.js`

**Interfaces:**
- Consumes from Task 2 & Task 3:
  - Bundled `zones` in `buildingsService.getApartment(id)` and bundled `occupants`, `amendments`, `service_prices`, `catalog_services` in `contractsService.getById(id)`
  - `peek*` & `{ force: true }` methods on `tenantsService`, `contractsService`, `buildingsService`, `servicesService`, `usersService`
- Produces in `frontend/src/router/routePreloaders.js`:
  - `ROUTE_IMPORT_MAP`, `preloadRouteChunk(path: string) -> void`, `preloadCoreAdminNavigationChunks() -> void`
- Produces in `FloorPlanView`:
  - Accepts optional `initialBuilding` and `initialZones` props when `embedded === true`, skipping duplicate `buildingsService.getById` and `buildingsService.listZones` calls.

- [ ] **Step 1: Write failing verification tests in `api/test/frontendNavigationWaterfallsAndPreload.test.js`**

Test cases:
1. `routePreloaders.js` exports `preloadRouteChunk` and `preloadCoreAdminNavigationChunks`, covering `/admin/buildings`, `/admin/tenants`, and `/admin/contracts` (plus detail chunks), and `Sidebar.jsx` triggers `preloadRouteChunk(item.path)` on pointer hover/focus while `AdminLayout.jsx` schedules idle preloading.
2. `BuildingDetailPage.jsx` does NOT call `tenantsService.list` or `contractsService.list` inside initial `loadBuildingData`; loads them lazily when `tab === 'tenants'` or `tab === 'contracts'`, and passes `initialBuilding={building}` + `initialZones={zones}` into `<FloorPlanView />`.
3. `FloorPlanPage.jsx` (`FloorPlanView`) reuses `initialBuilding` / `initialZones` when provided instead of re-calling `buildingsService.getById` / `buildingsService.listZones`.
4. `ContractDetailPage.jsx` consumes bundled `occupants`, `amendments`, `service_prices`, and `catalog_services` from `contractsService.getById(id)` without a sequential `await servicesService.listCatalog(...)` waterfall, and `ApartmentDetailPage.jsx` consumes `d.zones` directly from `buildingsService.getApartment(id)`.
5. Target pages (`TenantsPage`, `TenantDetailPage`, `ContractsPage`, `ContractDetailPage`, `BuildingsPage`, `BuildingDetailPage`, `FloorPlanPage`, `ApartmentDetailPage`) seed initial state via service `peek*` cache helpers so cached route transitions start with `loading = false` (no `<PageSkeleton />` flash) and pass `{ force: true }` on mutation reloads.

- [ ] **Step 2: Run test to verify RED failure**

Run: `cd d:\resihub\api; node --test test/frontendNavigationWaterfallsAndPreload.test.js`
Expected: FAIL (missing `routePreloaders.js` and waterfalls still present in page components).

- [ ] **Step 3: Implement `routePreloaders.js` and update router, layout, and the 8 target admin pages**

Verify frontend static analysis & production bundle with `npm run lint` and `npm run build` in `d:\resihub\frontend`.

- [ ] **Step 4: Run test + frontend lint/build + full regression suite to verify GREEN pass**

Run:
- `cd d:\resihub\api; node --test test/frontendNavigationWaterfallsAndPreload.test.js`
- `cd d:\resihub\frontend; npm run lint; npm run build`
- `cd d:\resihub\api; npm test`
Expected: PASS (0 test failures, 0 lint errors, clean Vite build, live benchmark `< 100 ms` across target endpoints).
