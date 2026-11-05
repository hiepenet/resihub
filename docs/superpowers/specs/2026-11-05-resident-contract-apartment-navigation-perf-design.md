# Resident, Contract & Apartment Navigation Performance Optimization — Design Spec

**Date:** 2026-11-05
**Scope:** Database indexes & PostgreSQL Row-Level Security (RLS), Express Backend API (`tenants.js`, `contracts.js`, `apartments.js`, `services.js`), and React Frontend caching, waterfall elimination, and route chunk preloading across Resident Profiles (`M04`), Contracts (`M05`), and Buildings/Apartments (`M03`).

---

## 1. Problem Statement & Empirical Baseline

Switching between **Hồ sơ cư dân** (`/admin/tenants`, `/admin/tenants/:id`), **Hợp đồng** (`/admin/contracts`, `/admin/contracts/:id`), and **Căn hộ / Bất động sản** (`/admin/buildings`, `/admin/buildings/:id`, `/admin/apartments/:id`) currently takes **2.5s – 5.2s** per navigation despite a small dataset (`person`: `1,925`, `app_user`: `2,017`, `apartment`: `474`, `tenant`: `192`, `contract`: `170`).

Measured bottlenecks:
1. **`GET /api/v1/tenants` (`2,507 ms` single / `3,373–5,190 ms` under `<StrictMode>`):**
   - `rls_person_select` and `rls_tenant_select` invoke `PL/pgSQL` functions `can_select_person` and `can_select_tenant` per row (`254,333` buffer hits on `Seq Scan on person` for `MANAGER`), compounded by missing indexes on `app_user(person_id)` and `contract_occupant(contract_id, tenant_id)`.
   - Correlated subqueries `active_contract` and `has_past_contract` use `c.primary_tenant_id = t.id OR EXISTS (SELECT 1 FROM contract_occupant ...)`, defeating `idx_contract_primary_tenant_id` (`154,882` buffer hits even for `SYS_ADMIN`), while `rls_contract_select` calls `is_org_admin()` per row instead of via an `InitPlan`.
   - `GET /api/v1/tenants` ignores `req.query.building_id`.
2. **2-Stage Waterfall & Blocking Tab Loads on Apartments / Buildings (`BuildingDetailPage` -> `FloorPlanView`):**
   - `BuildingDetailPage` blocks initial `overview` render on `tenantsService.list({ building_id })` and `contractsService.list({ building_id })` even though neither is displayed on the `overview` tab, then mounts `FloorPlanView`, which re-fetches `buildingsService.getById` and `buildingsService.listZones` in a second waterfall.
   - `ContractDetailPage` fires 6 HTTP requests (5 parallel + 1 sequential `servicesService.listCatalog` waterfall).
   - `ApartmentDetailPage` fires 4 HTTP requests including a sequential `getApartment(id)` -> `listZones(building_id)` waterfall.
3. **Zero Client Cache / Request Deduplication / Route Preloading:**
   - Every route change unmounts local `useState`, displays `<PageSkeleton />`, and re-fetches from scratch; React `<StrictMode>` doubles every mount request concurrently; lazy route modules incur ~250ms first-hit fetch/transform latency.

---

## 2. Architecture & Design Decisions

### 2.1 Group 1 — Database Indexes, Set-Based RLS & `GET /api/v1/tenants` Rewrite
- **Migration `054_rls_and_tenant_navigation_perf.sql`:**
  - Add missing B-tree indexes: `idx_app_user_person_id`, `idx_contract_occupant_contract_id`, `idx_contract_occupant_tenant_id`, `idx_contract_parent_contract_id`, `idx_reservation_phone_building`, `idx_tenant_desired_building_id`, `idx_person_created_by`, `idx_tenant_created_by`.
  - Introduce zero-row-argument `STABLE SECURITY DEFINER SET row_security = off` set-returning helpers (`get_accessible_person_ids()`, `get_other_building_contract_person_ids()`, `get_accessible_tenant_ids()`, `get_other_building_contract_tenant_ids()`, `get_manager_created_person_ids()`) derived strictly from `get_current_user_id()` (`app.current_user_id` GUC — preserving 100% compatibility with existing `appPool` middleware and RLS test suites).
  - Rewrite `rls_person_select`, `rls_tenant_select`, `rls_contract_select`, and `rls_contract_occupant_select` using `(SELECT is_org_admin())` `InitPlan` + `IN (SELECT ...)` hashed `SubPlan`s while retaining direct tuple-column checks (`person.created_by`, `tenant.created_by`, `tenant.desired_building_id`) so `INSERT ... RETURNING *` within uncommitted statements continues to work for `MANAGER` and `RESIDENT`.
  - Optimize `can_select_person` and `can_select_tenant` in place for RPC callers (`040`, `046`, `048`, `049`, `052`).
- **`GET /api/v1/tenants` (`api/src/routes/tenants.js`):**
  - Replace correlated `active_contract` and `has_past_contract` subqueries with set-based CTEs (`tenant_contract_links`, `active_contracts`, `past_contracts`) using `UNION` of `contract.primary_tenant_id` and `contract_occupant.tenant_id`.
  - Implement server-side `req.query.building_id` filtering (enforcing `OWNER` and `MANAGER` building scope, returning `{ data: [] }` when out of scope).
  - Eliminate redundant `tenant t2 JOIN person p2` in reservation scope filters and reuse `mgrBuildingIds` without querying twice.

### 2.2 Group 2 — Detail Endpoint Bundle Consolidation & Waterfall Elimination
- **Additive Backend Bundles (100% backward-compatible):**
  - `GET /api/v1/apartments/:id`: Include `zones` (building zones with `total_apartments`) inside the existing parallel `Promise.all`.
  - `GET /api/v1/contracts/:id`: Include `occupants` (reusing exact `OWNER` and `RESIDENT` `maskIdNumber` PII rules), `amendments`, `service_prices`, and `catalog_services` (active org service catalog) in the response payload.
  - `GET /api/v1/service-catalog`: Accept both `active_only=true` and `is_active=true`.
- **Frontend Waterfall Removal:**
  - `BuildingDetailPage.jsx`: Load only `[getById, listZones, listFloors]` on initial `overview` mount; lazy-load `contracts` and `tenants` only when the user selects `tab === 'contracts'` or `tab === 'tenants'`. Pass `initialBuilding` and `initialZones` to embedded `FloorPlanView` so `FloorPlanView` skips duplicate `getById` and `listZones` requests.
  - `ContractDetailPage.jsx`: Load contract detail (consuming bundled `occupants`, `amendments`, `service_prices`, `catalog_services`) + cached `usersService.getSettings()` in a single parallel pass without sequential `listCatalog` waterfall.
  - `ApartmentDetailPage.jsx`: Consume bundled `d.zones` directly from `getApartment(id)` (falling back to `listZones` only if absent).

### 2.3 Group 3 — Auth-Scoped Client SWR Cache, In-Flight Deduplication & Route Preloading
- **Zero-Dependency `queryCache.js` (`frontend/src/services/queryCache.js`):**
  - Scoped by authenticated user identity (`user.sub || user.id || accessToken` fingerprint) so cached entries never leak across users/roles; cleared automatically in `authStore.setAuthData` and `authStore.clearSession`.
  - Deduplicates concurrent identical in-flight GET promises (neutralizing `<StrictMode>` double-mounts).
  - Supports `ttlMs` (fresh window, default `20_000 ms` for dynamic resources, `120_000 ms` for settings/policies/catalog), `maxStaleMs` (`300_000 ms` for instant synchronous `peekQueryCache` initial state with silent background revalidation), `{ force: true }` bypass for explicit reloads, and namespace invalidation on mutations (`api.js` mutating response interceptor + service mutation wrappers).
- **Route Preloading (`frontend/src/router/routePreloaders.js`):**
  - Centralize lazy dynamic imports so `Sidebar` preloads route chunks on `onMouseEnter` / `onFocus`, and `AdminLayout` warms the core navigation chunks (`Buildings`, `FloorPlan`, `ApartmentDetail`, `Tenants`, `TenantDetail`, `Contracts`, `ContractDetail`) during browser idle time.

---

## 3. Security, Privacy & Regression Invariants
1. **Strict RBAC & RLS Parity:** Default-deny when `app.current_user_id` is unset; zero cross-building leakage for `MANAGER` or `OWNER`; `RESIDENT` sees only self, own contracts, and assigned building managers.
2. **PII Masking Preservation:** `OWNER` continues to receive masked `id_number` (`maskIdNumber`) on `GET /api/v1/tenants` and `GET /api/v1/contracts/:id` (`occupants`), and `RESIDENT` continues to have non-self co-occupant `id_number` masked.
3. **Zero Stale Post-Mutation UI:** Every `POST`/`PATCH`/`PUT`/`DELETE` invalidates affected client cache namespaces immediately, and post-action `load*({ force: true })` handlers fetch fresh server data.
4. **Cross-Session Isolation:** Logging out or switching accounts clears `queryCache` synchronously before rendering the next route.
