# Week 6: Service Requests (M11) & Zalo-Ready Announcements (M13) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the complete PRD v2.0 Resident Breakdown & SLA Dispatch workflow (M11: `FR-042`–`FR-045`, `FR-047`, `AC-004.1`, `AC-004.2`, `RP-05`) and the Scoped Announcement + Ready-to-Paste Zalo Group workflow (M13: `FR-053`–`FR-056`, `FR-069`, `PRD 5.3`, `13.2`, `13.6`, `14.3`) across PostgreSQL RLS, Express APIs, daily escalation jobs, and React Admin/Resident portals.

**Architecture:** Extract pure state-machine, SLA deadline, duplicate-window, and deterministic Zalo message formatting helpers into standalone domain modules (`serviceRequestRules.js`, `zaloFormatter.js`). Extend PostgreSQL via migration `050` with SLA/hold/reopen/resolution columns on `service_request`, dedicated `zalo_group` (building & room scopes) and `announcement` (`DRAFT`/`SCHEDULED`/`SENT`/`CANCELLED` + `manual_sent_at`) tables under `FORCE ROW LEVEL SECURITY`, then wire idempotent user-scoped Express routes, daily SLA/schedule cron hooks, and Admin/Resident React views while preserving 100% backward compatibility with existing `/api/v1/service-requests` and `/api/v1/notifications` contracts.

**Tech Stack:** Node.js (ESM), Express 4, PostgreSQL (`pg` + 2-layer RLS via `getUserClient(req)` / `pool`), `node:test`, React 18, Vite, Zustand, Tailwind CSS.

**Spec:** `PRD - Quan ly Can ho va Nha cho thue v2.0.md` (Sections 5.3, 6.2, 7.3, 7.5, 9, 10.1 `FR-042`–`FR-047` & `FR-053`–`FR-056`, 10.2, 10.3 `FR-069`, 11 `AC-004.1`–`AC-004.2`, 13.2, 13.6, 14.3, 15.2 `RP-05`, 15.3) & `FRONTEND DEVELOPER Roadmap (Hiep).md` (Lines 59–61: Tuần 6).

## Global Constraints

- **4-Role RBAC (`PRD 6.2`):** On both M11 (`service_request`) and M13 (`announcement`, `zalo_group`, `notification` broadcast), `MANAGER` has building-scoped `CRU` (+ technician assignment), `OWNER` and `SYS_ADMIN` are strictly **Read-Only (`R`)** (`403` on writes), and `RESIDENT` has `C, R` on their own contract apartments plus self-cancel (`NEW -> CANCELLED`) and acceptance (`RESOLVED -> CLOSED` rating or `RESOLVED -> REOPENED`).
- **Multi-Building Isolation & Audit (`AC-019.1`):** Accessing or mutating a resource belonging to an unassigned/unowned building must return `403 ACCESS_DENIED` and write an `ACCESS_DENIED` entry to `audit_log`; non-existent UUIDs in the org return `404 NOT_FOUND`.
- **PostgreSQL `FORCE ROW LEVEL SECURITY`:** Every new and modified table (`service_request`, `announcement`, `zalo_group`, `notification`) must enforce `ENABLE` + `FORCE ROW LEVEL SECURITY`. Route mutations must execute through `getUserClient(req)` / `pool` (`req.user.sub` bound to `app.current_user_id`), never bypassing RLS via `adminPool`.
- **Idempotency (`PRD 14.3`):** Attach `idempotencyGuard()` to every `POST`, `PUT`, and `PATCH` write endpoint in M11 and M13, and send `Idempotency-Key` headers from Frontend mutation calls.
- **Vietnam Timezone (`Asia/Ho_Chi_Minh`):** Generate `SR-YYYYMMDD-XXXX` prefixes and SLA/schedule comparisons using Vietnam local dates (`todayVietnamYmd()` from `api/src/services/serviceBilling.js`), never UTC `new Date().toISOString().slice(0, 10)`.
- **Attachment Security (`PRD 14.4`):** Repair intake photos (`images`, max 3) and technician before/after evidence (`resolution_images`, max 3) must use `saveBase64Image` (`<= 5 MB`, JPEG/PNG/WebP magic-byte verified) with `owner_entity = 'service_request'` and serve through authenticated `/api/v1/attachments/:id/view`.
- **Scope Boundaries:** Do **not** call external Zalo OA/ZNS APIs (`PRD 5.3` & `19.2`: Phase 2), do **not** call Gemini LLM APIs (`Roadmap` Week 7 M15 owns `AI-03`/`AI-04`), and do **not** auto-generate repair `invoice_line` charges (`FR-046` deferred to keep clean separation from Week 5 billing).

## Review Focus

1. **Internal Note Confidentiality Leak (`PRD 9` & `FR-045`):** `MANAGER` internal remarks in `service_request.internal_note` must never appear in `GET /api/v1/resident/service-requests` payloads or `MaintenanceTab.jsx`; residents may only see `resolution_note` and `resolution_images` (tested in Task 3 & Task 5).
2. **24-Hour Duplicate Boundary & Household Occupant Access (`AC-004.2` & `PRD 10.2`):** Registered household members (`contract_occupant`, not only `primary_tenant_id`) must be able to view/create apartment requests; submitting the same `apartment_id` + `category` within `24h` while open (`NEW`/`ASSIGNED`/`IN_PROGRESS`/`ON_HOLD`/`REOPENED`) returns `409 DUPLICATE_SERVICE_REQUEST` with `existing_request` metadata unless `ignore_duplicate_warning === true`, whereas `> 24h` or `RESOLVED`/`CLOSED`/`CANCELLED` requests allow `201` (tested in Task 1 & Task 3).
3. **Reopen Window, Self-Cancel Guard & Original SLA Baseline (`FR-047`, `PRD 10.2`, `15.3`):** Resident `reopen` (`RESOLVED -> REOPENED`) is allowed only within `sla_config.reopen_window_days` (default `3` days), requires `reopen_reason` (`>= 5` chars), preserves the original `tracking_code` and `sla_due_at` without creating a new ticket, and rejects expired/closed tickets with `409`; resident self-cancel is blocked with `409` once status leaves `NEW` (tested in Task 1 & Task 3).
4. **Vietnam Midnight Tracking Code & Concurrent `23505` Retry (`AC-004.1`):** At `00:05` ICT (`17:05Z` previous UTC day), `SR-YYYYMMDD-XXXX` uses the new Vietnam date, and concurrent creations hitting `ux_service_request_tracking_code` retry sequence generation cleanly instead of returning `500` (tested in Task 1 & Task 3).
5. **Announcement 2-Step Confirmation, Deduplicated Occupant Fan-Out & Zalo URL Safety (`PRD 14.3`, `FR-053`, `FR-069`):** `POST /api/v1/announcements/:id/send` rejects missing `confirm_send: true` (`422 CONFIRMATION_REQUIRED`) and already-sent rows (`409 ALREADY_SENT`), fans out `notification` rows to active `app_user` accounts of both `primary_tenant_id` and `contract_occupant`s (deduplicated per `user_id`), and `zalo_group.invite_link` rejects `javascript:` or non-Zalo hosts (`422 INVALID_ZALO_LINK`, allowing only `https://zalo.me/...` or `https://chat.zalo.me/...`) (tested in Task 1 & Task 4).

## File Structure

- `api/src/services/serviceRequestRules.js` (Create): Pure M11 state machine, SLA deadline calculator, 24h duplicate predicate, reopen window validator, and ICT tracking-code prefix helper.
- `api/src/services/zaloFormatter.js` (Create): Pure M13 Vietnamese Zalo quick templates, building/room message formatters, and Zalo invite URL validator.
- `api/src/db/migrations/050_m11_m13_service_requests_sla_and_zalo_announcements.sql` (Create): Schema extensions for `service_request` & `notification`, new `zalo_group` & `announcement` tables, `fn_get_ops_resource_scope` RPC, and hardened 2-layer RLS policies.
- `api/src/routes/resident.js` (Modify): Occupant-aware M11 queries, 24h duplicate warning payload, `internal_note` stripping, manager notifications, resident `/cancel` and `/reopen` endpoints, `idempotencyGuard()`.
- `api/src/routes/service-requests.js` (Modify): `MANAGER`-only writes via `getUserClient(req)`, SLA computation, `ON_HOLD`/`REOPENED`/`resolution_note`/`resolution_images`, `?overdue_sla=true`, audit timeline + room Zalo group lookup on detail.
- `api/src/routes/zalo-groups.js` (Create): Building & apartment Zalo group directory API (`GET /`, `POST /`, `PUT /:id`).
- `api/src/routes/announcements.js` (Create): Announcement lifecycle API (`GET /`, `GET /templates`, `POST /`, `PUT /:id`, `POST /:id/send`, `POST /:id/mark-zalo-sent`).
- `api/src/routes/notifications.js`, `api/src/routes/reports.js`, `api/src/routes/settings.js`, `api/src/jobs/daily.js`, `api/src/server.js` (Modify): Mount new routers, link legacy `POST /api/v1/notifications` to `announcement`, normalize `sla_config.reopen_window_days`, add SLA breach metrics to `RP-05`, and run SLA breach escalation + scheduled announcement dispatch in `daily.js`.
- `frontend/src/utils/zaloFormat.js`, `frontend/src/services/announcements.service.js` (Create) & `frontend/src/constants/statuses.js`, `frontend/src/hooks/usePermission.js`, `frontend/src/services/resident.service.js`, `frontend/src/services/serviceRequests.service.js`, `frontend/src/pages/resident/ResidentPortalPage.jsx`, `frontend/src/pages/resident/tabs/MaintenanceTab.jsx`, `frontend/src/pages/resident/tabs/NotificationsTab.jsx`, `frontend/src/pages/admin/maintenance/ServiceRequestsPage.jsx`, `frontend/src/pages/admin/notifications/NotificationsPage.jsx`, `frontend/src/pages/admin/settings/SettingsPage.jsx` (Modify): Complete Resident & Admin UI for M11 & M13 + 1-click Zalo copy and manual-send confirmation.

---

### Task 1: Pure Domain Helpers — M11 Lifecycle/SLA Rules & M13 Zalo Formatter

**Files:**
- Create: `api/src/services/serviceRequestRules.js`
- Create: `api/src/services/zaloFormatter.js`
- Test: `api/test/week6DomainHelpersUnit.test.js`

**Interfaces:**
- Consumes: `todayVietnamYmd(now?: Date) -> string` from `api/src/services/serviceBilling.js`.
- Produces:
  - From `api/src/services/serviceRequestRules.js`:
    - `SERVICE_REQUEST_OPEN_STATUSES = ['NEW', 'ASSIGNED', 'IN_PROGRESS', 'ON_HOLD', 'REOPENED']`
    - `PREFERRED_SLOT_CODES = ['MORNING_08_12', 'AFTERNOON_13_17', 'EVENING_18_21', 'ANYTIME']`
    - `buildServiceRequestTrackingPrefix(now?: Date) -> string` (e.g. `'SR-20261101-'` in `Asia/Ho_Chi_Minh`)
    - `computeServiceRequestSlaDeadlines({ createdAt, priority = 'NORMAL', slaConfig = {} }) -> { slaResponseDueAt: Date, slaDueAt: Date, responseHours: number, resolveHours: number }` (`response_hours` default `2`; `urgent_resolve_hours` default `4` when `priority === 'URGENT'`, else `normal_resolve_hours` default `24`)
    - `isWithinDuplicateWindow({ existingCreatedAt, existingStatus, now = new Date(), windowHours = 24 }) -> boolean`
    - `validateServiceRequestTransition({ fromStatus, toStatus, actorRole, holdReason = '', reopenReason = '', resolvedAt = null, reopenWindowDays = 3, now = new Date() }) -> { valid: boolean, code?: string, message?: string }`
  - From `api/src/services/zaloFormatter.js`:
    - `ZALO_ANNOUNCEMENT_TEMPLATES`: array of `{ key, type, label, defaultTitle, bodyTemplate }` for `UTILITY_INTERRUPTION`, `MAINTENANCE_NOTICE`, `HOUSE_RULES`, `SECURITY_ALERT`, `GENERAL_ANNOUNCEMENT`
    - `validateZaloInviteLink(rawUrl?: string | null) -> { valid: boolean, normalized: string | null, code?: string, message?: string }` (empty/`null` -> `{ valid: true, normalized: null }`; non-empty must match `^https://(zalo\.me|chat\.zalo\.me)/[A-Za-z0-9._/-]+$`)
    - `formatAnnouncementForZalo({ type, title, body, targetScope, buildingCode, buildingName, floorName, apartmentCode, contactConfig, scheduledOrSentAt }) -> string`
    - `formatServiceRequestForRoomZalo({ trackingCode, category, title, status, apartmentCode, buildingCode, preferredSlot, nextAppointmentAt, resolutionNote, assigneeName, contactConfig }) -> string`

- [ ] **Step 1: Write failing unit tests in `api/test/week6DomainHelpersUnit.test.js`**

Cover pure in-memory branches (zero DB connections) including *Review Focus #2, #3, #4, #5*:
- `buildServiceRequestTrackingPrefix(new Date('2026-10-31T17:05:00.000Z')) === 'SR-20261101-'` (*Review Focus #4* Vietnam midnight).
- `computeServiceRequestSlaDeadlines`: `NORMAL`/`HIGH` uses `24h` resolve (`slaConfig.normal_resolve_hours = 24`), `URGENT` uses `4h` resolve (`slaConfig.urgent_resolve_hours = 4`), `response_hours = 2`.
- `isWithinDuplicateWindow` (*Review Focus #2*): `23h59m` with `status = 'NEW'` or `'ON_HOLD'` -> `true`; `24h01m` -> `false`; `1h` ago with `status = 'RESOLVED'` / `'CLOSED'` / `'CANCELLED'` -> `false`.
- `validateServiceRequestTransition` (*Review Focus #3*):
  - `MANAGER`: `NEW -> ASSIGNED | IN_PROGRESS | ON_HOLD | RESOLVED | CANCELLED`; `ON_HOLD` without `holdReason` -> `{ valid: false, code: 'HOLD_REASON_REQUIRED' }`; `ON_HOLD` with `holdReason` -> `valid: true`; `REOPENED -> IN_PROGRESS | RESOLVED`; `CLOSED -> IN_PROGRESS` -> `{ valid: false, code: 'INVALID_STATUS_TRANSITION' }`.
  - `RESIDENT`: `NEW -> CANCELLED` -> `valid: true`; `ASSIGNED -> CANCELLED` -> `{ valid: false, code: 'INVALID_STATUS_TRANSITION' }`; `RESOLVED -> REOPENED` within `3` days with `reopenReason = 'Vẫn còn rỉ nước mạnh'` -> `valid: true`; `RESOLVED -> REOPENED` with `< 5` chars reason -> `{ valid: false, code: 'REOPEN_REASON_REQUIRED' }`; `RESOLVED -> REOPENED` at `3 days + 1 min` -> `{ valid: false, code: 'REOPEN_WINDOW_EXPIRED' }`.
- `validateZaloInviteLink` (*Review Focus #5*): accepts `null`/`''` and `'https://zalo.me/g/resihubvopa'`; rejects `'javascript:alert(1)'`, `'http://zalo.me/g/abc'`, and `'https://evil.example.com/zalo.me'` with `code: 'INVALID_ZALO_LINK'`.
- `formatAnnouncementForZalo` & `formatServiceRequestForRoomZalo`: building-scope output includes `[THÔNG BÁO BQL TÒA VOP-A]`, title, body, and technical hotline; `APARTMENT`-scope output greets `Phòng A101` specifically; room service-request helper formats tracking code, status, appointment/preferred slot, and resolution summary cleanly for mobile Zalo paste.

- [ ] **Step 2: Run unit test to verify it fails**

Run: `node --test --test-concurrency=1 test/week6DomainHelpersUnit.test.js` (cwd: `d:\resihub\api`)
Expected: FAIL (`ERR_MODULE_NOT_FOUND` for `serviceRequestRules.js` and `zaloFormatter.js`).

- [ ] **Step 3: Implement `api/src/services/serviceRequestRules.js` and `api/src/services/zaloFormatter.js`**

Implement all exported constants and functions matching the Interfaces signatures above, keeping them 100% pure (no DB imports) so both routes and unit tests can import them directly.

- [ ] **Step 4: Run unit tests to verify they pass**

Run: `node --test --test-concurrency=1 test/week6DomainHelpersUnit.test.js` (cwd: `d:\resihub\api`)
Expected: PASS (0 failures).

- [ ] **Step 5: Commit**

```bash
git add api/src/services/serviceRequestRules.js api/src/services/zaloFormatter.js api/test/week6DomainHelpersUnit.test.js
git commit -m "feat(m11,m13): add pure SLA/lifecycle rules and Zalo message formatter helpers"
```

---

### Task 2: Database Migration `050` — M11 SLA/Reopen Schema, M13 `announcement` + `zalo_group` Tables & 2-Layer RLS

**Files:**
- Create: `api/src/db/migrations/050_m11_m13_service_requests_sla_and_zalo_announcements.sql`
- Test: `api/test/migration050RlsAndSchema.test.js`

**Interfaces:**
- Consumes: Existing RLS helpers from migrations `019`–`049` (`is_org_admin()`, `is_owner()`, `is_manager()`, `is_resident()`, `get_current_user_id()`, `get_current_user_org_id()`, `get_owner_building_ids()`, `get_manager_building_ids()`, `get_user_assigned_buildings()`, `get_resident_contract_ids()`).
- Produces:
  - Extended `service_request` columns:
    - `location_detail TEXT`, `preferred_slot TEXT`, `sla_response_due_at TIMESTAMPTZ`, `sla_due_at TIMESTAMPTZ`, `first_responded_at TIMESTAMPTZ`, `sla_breached_at TIMESTAMPTZ`, `hold_reason TEXT`, `next_appointment_at TIMESTAMPTZ`, `resolution_note TEXT`, `resolution_images JSONB NOT NULL DEFAULT '[]'::jsonb`, `reopened_at TIMESTAMPTZ`, `reopen_reason TEXT`, `reopen_count INT NOT NULL DEFAULT 0`, `cancelled_reason TEXT`.
    - Updated status check constraint `service_request_status_check`: `status IN ('NEW', 'ASSIGNED', 'IN_PROGRESS', 'ON_HOLD', 'RESOLVED', 'REOPENED', 'CLOSED', 'CANCELLED')`.
    - Backfill `sla_response_due_at` and `sla_due_at` on existing rows from `created_at` (`+2h`, `+4h` urgent / `+24h` normal).
  - New `zalo_group` table (`PRD 13.6`):
    - `(id UUID PK DEFAULT gen_random_uuid(), org_id UUID NOT NULL REFERENCES org(id) ON DELETE CASCADE, building_id UUID NOT NULL REFERENCES building(id) ON DELETE CASCADE, apartment_id UUID REFERENCES apartment(id) ON DELETE CASCADE, scope TEXT NOT NULL CHECK (scope IN ('BUILDING', 'APARTMENT')), name TEXT NOT NULL, invite_link TEXT, note TEXT, is_active BOOLEAN NOT NULL DEFAULT TRUE, created_by UUID REFERENCES app_user(id) ON DELETE SET NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`
    - Constraint `chk_zalo_group_scope_target`: `(scope = 'BUILDING' AND apartment_id IS NULL) OR (scope = 'APARTMENT' AND apartment_id IS NOT NULL)`.
    - Unique index `ux_zalo_group_target_name` on `(building_id, COALESCE(apartment_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(btrim(name)))`.
  - New `announcement` table (`PRD 13.2` & `13.6`):
    - `(id UUID PK DEFAULT gen_random_uuid(), org_id UUID NOT NULL REFERENCES org(id) ON DELETE CASCADE, building_id UUID NOT NULL REFERENCES building(id) ON DELETE CASCADE, target_scope TEXT NOT NULL CHECK (target_scope IN ('BUILDING', 'FLOOR', 'APARTMENT')), floor_id UUID REFERENCES floor(id) ON DELETE SET NULL, apartment_id UUID REFERENCES apartment(id) ON DELETE SET NULL, audience JSONB NOT NULL DEFAULT '{}'::jsonb, type TEXT NOT NULL DEFAULT 'ANNOUNCEMENT' CHECK (type IN ('ANNOUNCEMENT', 'MAINTENANCE_NOTICE', 'SECURITY_ALERT', 'UTILITY_INTERRUPTION', 'HOUSE_RULES', 'SYSTEM')), title TEXT NOT NULL, body TEXT NOT NULL, zalo_content TEXT, channels TEXT[] NOT NULL DEFAULT ARRAY['IN_APP', 'ZALO_MANUAL'], status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'SCHEDULED', 'SENT', 'CANCELLED')), scheduled_at TIMESTAMPTZ, sent_at TIMESTAMPTZ, manual_sent_at TIMESTAMPTZ, manual_sent_by UUID REFERENCES app_user(id) ON DELETE SET NULL, manual_sent_groups JSONB NOT NULL DEFAULT '[]'::jsonb, recipient_count INT NOT NULL DEFAULT 0, created_by UUID REFERENCES app_user(id) ON DELETE SET NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`.
  - `notification.announcement_id UUID REFERENCES announcement(id) ON DELETE SET NULL` + index `idx_notification_announcement_id`.
  - `SECURITY DEFINER` RPCs granted to `resihub_app` (`SET search_path = public, pg_temp SET row_security = off`):
    - `fn_get_ops_resource_scope(p_entity TEXT, p_id UUID) RETURNS TABLE(resource_id UUID, org_id UUID, building_id UUID)` supporting `'service_request'`, `'announcement'`, `'zalo_group'`, `'apartment'`, `'floor'`, `'building'` (so routes distinguish `404` vs `403 ACCESS_DENIED` without `adminPool`).
    - `fn_notify_service_request_managers(p_service_request_id UUID, p_type TEXT, p_title TEXT, p_content TEXT, p_payload JSONB DEFAULT '{}'::jsonb) RETURNS INT`: verifies caller is either `is_manager()` on `sr.building_id` or `is_resident()` owning `sr` (`sr.created_by = get_current_user_id()` or `sr.apartment_id` in `get_resident_contract_ids()`), then inserts `notification` rows for all active `MANAGER` users assigned to `sr.building_id` (plus `sr.assigned_to`), enabling resident-to-manager alerts via `getUserClient(req)` without `adminPool` or weakening `rls_notification_insert`.
  - RLS policies (`ENABLE` + `FORCE ROW LEVEL SECURITY` + `GRANT SELECT, INSERT, UPDATE` to `resihub_app`):
    - `service_request`: `SELECT` for `is_org_admin()` OR `building_id IN (SELECT building_id FROM get_user_assigned_buildings())` OR `apartment_id IN (SELECT c.apartment_id FROM contract c WHERE c.id IN (SELECT contract_id FROM get_resident_contract_ids()))` OR `created_by = get_current_user_id()`; `INSERT` & `UPDATE` strictly for `is_manager() AND building_id IN (SELECT building_id FROM get_manager_building_ids())` OR `is_resident()` on own `get_resident_contract_ids()` apartments (`SYS_ADMIN` & `OWNER` blocked from write); `DELETE` blocked for non-superusers (`USING (FALSE)` — no hard deletes in production).
    - `zalo_group` & `announcement`: `SELECT` for `is_org_admin()` OR `building_id IN (SELECT building_id FROM get_user_assigned_buildings())` (plus `is_resident()` `SELECT` on `SENT` `announcement`s matching their building/floor/apartment); `INSERT` & `UPDATE` strictly for `is_manager() AND building_id IN (SELECT building_id FROM get_manager_building_ids())`.
    - `notification`: keep `rls_notification_insert` (`031`) intact so existing M06/M09 `SECURITY DEFINER` approval RPCs continue working, and extend `rls_notification_select` (`034`) so `is_manager()` and `is_owner()` can count/read `notification` rows linked to `announcement_id` on their assigned buildings (`FR-056` read-receipt counter).
    - Additive permissive policy `rls_audit_log_select_m11_m13` on `audit_log FOR SELECT` allowing `is_owner()` and `is_manager()` to read `entity IN ('service_request', 'announcement', 'zalo_group', 'notification')` scoped to their buildings without overwriting `049`'s `rls_audit_log_select`.
    - Merge `'{"reopen_window_days": 3}'::jsonb || COALESCE(value, '{}'::jsonb)` into `system_setting` where `key = 'sla_config'`.

- [ ] **Step 1: Write migration `050_m11_m13_service_requests_sla_and_zalo_announcements.sql` and failing/verification test `api/test/migration050RlsAndSchema.test.js`**

Test cases in `api/test/migration050RlsAndSchema.test.js` (using `appPool` with `SET app.current_user_id` + full `t.after` cleanup):
1. Schema & constraints: `ON_HOLD` and `REOPENED` accepted on `service_request`; `chk_zalo_group_scope_target` rejects `scope = 'BUILDING'` with non-null `apartment_id` and rejects `scope = 'APARTMENT'` with `apartment_id = NULL`; `sla_config` includes `reopen_window_days`.
2. `SYS_ADMIN` & `OWNER` Read-Only at RLS layer (`PRD 6.2`): both can `SELECT` `service_request`, `announcement`, and `zalo_group` within scope (`OWNER` isolated to owned buildings), and both are blocked (`0` rows / RLS error) on `INSERT`/`UPDATE` to `service_request`, `announcement`, and `zalo_group`.
3. `MANAGER` building isolation: `manager.vop.a@resihub.vn` can `INSERT`/`UPDATE` `service_request`, `announcement`, and `zalo_group` in `VOP-A`, fails RLS on `VOP-B`, and `fn_get_ops_resource_scope` resolves `building_id` across org buildings for `403` vs `404` checks.
4. `RESIDENT` primary tenant & `contract_occupant` RLS: both primary tenant and a registered `contract_occupant` can `SELECT` and `INSERT` `service_request` on their contract's apartment, see `SENT` announcements for their building, and cannot see `DRAFT` announcements or another apartment's `service_request`.
5. `audit_log` visibility: `OWNER` and `MANAGER` of `VOP-A` can `SELECT` `audit_log` rows for `entity IN ('service_request', 'announcement', 'zalo_group')` belonging to `VOP-A`, and `0` rows for `VSC-A`.

- [ ] **Step 2: Apply migration `050` and run `migration050RlsAndSchema.test.js`**

Run: `npm run migrate` then `node --test --test-concurrency=1 test/migration050RlsAndSchema.test.js` (cwd: `d:\resihub\api`)
Expected: Migration `050` applies cleanly and all 5 RLS/schema tests PASS (if any policy edge case fails, fix `050` idempotently and re-verify).

- [ ] **Step 3: Run existing RLS alignment suites to verify zero regressions**

Run: `node --test --test-concurrency=1 test/rbacPrdAlignment.test.js test/migration048RlsAndRpc.test.js` (cwd: `d:\resihub\api`)
Expected: PASS (0 failures).

- [ ] **Step 4: Commit**

```bash
git add api/src/db/migrations/050_m11_m13_service_requests_sla_and_zalo_announcements.sql api/test/migration050RlsAndSchema.test.js
git commit -m "feat(db): add migration 050 for M11 SLA/reopen, M13 announcements, zalo_group and RLS policies"
```

---

### Task 3: Backend M11 — Resident Breakdown Lifecycle, 24h Duplicate Check, Confidentiality & SLA Escalation

**Files:**
- Modify: `api/src/routes/resident.js:780-1035`
- Modify: `api/src/routes/service-requests.js`
- Modify: `api/src/routes/reports.js:206-225,906-927,1023-1032`
- Modify: `api/src/routes/settings.js:82-120`
- Modify: `api/src/jobs/daily.js`
- Test: `api/test/m11ResidentBreakdownAndSlaFlow.test.js`

**Interfaces:**
- Consumes: `buildServiceRequestTrackingPrefix`, `computeServiceRequestSlaDeadlines`, `isWithinDuplicateWindow`, `validateServiceRequestTransition`, `SERVICE_REQUEST_OPEN_STATUSES` from Task 1; `formatServiceRequestForRoomZalo` from Task 1; migration `050` columns, `fn_get_ops_resource_scope`, and `fn_notify_service_request_managers` from Task 2.
- Produces:
  - Resident endpoints in `api/src/routes/resident.js` (`requireRole(['RESIDENT'])`, `idempotencyGuard()` on writes, using `getUserClient(req)`):
    - `GET /api/v1/resident/service-requests`: supports both `primary_tenant_id` and `contract_occupant` contracts; explicitly selects safe columns (`id`, `tracking_code`, `building_id`, `apartment_id`, `tenant_id`, `category`, `title`, `description`, `location_detail`, `preferred_slot`, `priority`, `status`, `images`, `sla_response_due_at`, `sla_due_at`, `first_responded_at`, `hold_reason`, `next_appointment_at`, `resolution_note`, `resolution_images`, `resolved_at`, `reopened_at`, `reopen_reason`, `reopen_count`, `cancelled_reason`, `rating`, `rating_note`, `created_at`, `updated_at`, plus apartment/building/assignee labels) — **never returning `internal_note`**.
    - `POST /api/v1/resident/service-requests`: accepts `{ contract_id?, category, title?, description, location_detail?, preferred_slot?, priority?, images?, ignore_duplicate_warning? }`; checks 24h open duplicate on `(apartment_id, category)` returning `409 { code: 'DUPLICATE_SERVICE_REQUEST', message, existing_request: { id, tracking_code, title, status, created_at } }`; generates Vietnam `SR-YYYYMMDD-XXXX` with up to 5 retries on `23505`; computes `sla_response_due_at` & `sla_due_at` from org `sla_config`; calls `fn_notify_service_request_managers` (`SERVICE_REQUEST_URGENT` when `priority === 'URGENT'`, else `SERVICE_REQUEST_CREATED`); writes `CREATE_SERVICE_REQUEST` to `audit_log`.
    - `POST /api/v1/resident/service-requests/:id/cancel`: `{ cancel_reason? }` transitions own/contract request `NEW -> CANCELLED` (`409 INVALID_STATUS_TRANSITION` if `status !== 'NEW'`), writes `CANCEL_SERVICE_REQUEST` audit log.
    - `POST /api/v1/resident/service-requests/:id/reopen`: `{ reopen_reason }` transitions `RESOLVED -> REOPENED` within `sla_config.reopen_window_days` (default `3`), increments `reopen_count`, sets `reopened_at = NOW()`, preserves `tracking_code` and `sla_due_at`, calls `fn_notify_service_request_managers` (`SERVICE_REQUEST_REOPENED`), writes `REOPEN_SERVICE_REQUEST` audit log.
    - `POST /api/v1/resident/service-requests/:id/rating`: `{ rating, rating_note? }` transitions `RESOLVED -> CLOSED`, calls `fn_notify_service_request_managers` (`SERVICE_REQUEST_RATED`), writes `RATE_SERVICE_REQUEST` audit log.
  - Admin endpoints in `api/src/routes/service-requests.js`:
    - `GET /api/v1/service-requests`: supports `?building_id`, `?status`, `?priority`, `?category`, `?overdue_sla=true` (`status IN ('NEW','ASSIGNED','IN_PROGRESS','ON_HOLD','REOPENED') AND sla_due_at < NOW()`), `?search`; returns `is_sla_overdue` boolean and SLA fields.
    - `GET /api/v1/service-requests/:id`: includes `available_assignees`, `audit_timeline` (from `audit_log WHERE entity = 'service_request' AND entity_id = $1`), `apartment_zalo_group` (active `zalo_group` for `sr.apartment_id` or fallback building group), and `zalo_room_message_preview` via `formatServiceRequestForRoomZalo`.
    - `POST /api/v1/service-requests`: `requireRole(['MANAGER'])` + `idempotencyGuard()`; checks 24h duplicate unless `ignore_duplicate_warning === true`; computes SLA deadlines; executes on `getUserClient(req)`.
    - `PATCH /api/v1/service-requests/:id/status`: `requireRole(['MANAGER'])` + `idempotencyGuard()`; resolves building via `fn_get_ops_resource_scope('service_request', id)` (`404` vs `403 ACCESS_DENIED`); validates transitions via `validateServiceRequestTransition`; stamps `first_responded_at = COALESCE(first_responded_at, NOW())` when leaving `NEW`; handles `ON_HOLD` (`hold_reason`, `next_appointment_at`), `resolution_note`, `resolution_images` (up to 3 base64/existing URLs via `saveBase64Image`), `internal_note`; recalculates `sla_due_at` if priority escalates to `URGENT`; notifies resident (using `resolution_note` / `hold_reason`, never leaking `internal_note`) and newly assigned `assigned_to` (`SERVICE_REQUEST_ASSIGNED`); writes `UPDATE_SERVICE_REQUEST` audit log.
  - Cron & Settings & Reports:
    - `escalateOverdueServiceRequests(dbPool, { nowTs = new Date(), buildingId = null }) -> Promise<{ escalatedCount: number, notificationsSent: number }>` exported from `api/src/jobs/daily.js` and invoked inside `runDailyJobs`: finds open requests where `sla_due_at < $nowTs AND sla_breached_at IS NULL`, updates `sla_breached_at = $nowTs`, and inserts idempotent `SERVICE_REQUEST_SLA_BREACH` notifications for both building `MANAGER`s and the building `OWNER` (`PRD 10.2`).
    - `api/src/routes/settings.js`: normalize `sla_config` (`response_hours`, `urgent_resolve_hours`, `normal_resolve_hours`, `deposit_refund_days`, `reopen_window_days` positive integers).
    - `api/src/routes/reports.js`: include `'ON_HOLD', 'REOPENED'` in `pending_requests` / `open_count`, and add `sla_breached_count` + `on_time_rate_pct` to `sla_by_category` (`RP-05`).

- [ ] **Step 1: Write the failing integration test `api/test/m11ResidentBreakdownAndSlaFlow.test.js`**

Test cases (isolated temp contract/occupant/requests with full `t.after` cleanup):
1. **Resident + Occupant intake & Vietnam SLA (`FR-042`, `AC-004.1`, *Review Focus #2 & #4*):** Both primary tenant and a registered `contract_occupant` can submit requests with `location_detail`, `preferred_slot`, and photos; `sla_response_due_at` and `sla_due_at` are populated (`4h` for `URGENT`, `24h` for `NORMAL`); building `MANAGER` receives `SERVICE_REQUEST_URGENT` / `SERVICE_REQUEST_CREATED` notification.
2. **24h Duplicate Window (`AC-004.2`, *Review Focus #2*):** Second request in same apartment + category within 24h returns `409 DUPLICATE_SERVICE_REQUEST` with `existing_request.tracking_code`; retrying with `ignore_duplicate_warning: true` returns `201`; an open request backdated to `25 hours` ago does NOT block a new request (`201`).
3. **Confidentiality, `ON_HOLD`, Resolution Photos, Reopen & Self-Cancel (`FR-045`, `FR-047`, *Review Focus #1 & #3*):**
   - Resident can cancel a `NEW` request (`200 -> CANCELLED`), but cancelling an `ASSIGNED` request returns `409 INVALID_STATUS_TRANSITION`.
   - `MANAGER` transitions `NEW -> ON_HOLD` without `hold_reason` (`422`/`400 HOLD_REASON_REQUIRED`), then with `hold_reason` + `next_appointment_at` (`200`, `first_responded_at` stamped).
   - `MANAGER` transitions `ON_HOLD -> RESOLVED` with `internal_note: 'Bí mật nhà thầu 500k'`, `resolution_note: 'Đã thay phao bồn cầu mới'`, and `resolution_images: [TINY_PNG_BASE64]`.
   - `GET /api/v1/resident/service-requests` returns `resolution_note` and `resolution_images.length === 1`, while `row.internal_note` is `undefined` (*Review Focus #1*).
   - Resident reopens `RESOLVED -> REOPENED` (`reopen_count === 1`, original `tracking_code` & `sla_due_at` preserved); backdating `resolved_at` past `reopen_window_days` (`4` days ago) blocks reopen with `409 REOPEN_WINDOW_EXPIRED`.
4. **SLA Escalation (`FR-044`, `PRD 10.2`):** Backdating `sla_due_at` to `1 hour` ago and running `escalateOverdueServiceRequests(adminPool, { buildingId })` stamps `sla_breached_at`, sends `SERVICE_REQUEST_SLA_BREACH` notifications to both `MANAGER` and building `OWNER`, and re-running is idempotent (`escalatedCount === 0`).
5. **RBAC & Cross-Building `403` (`PRD 6.2`, `AC-019.1`):** `SYS_ADMIN` and `OWNER` receive `403` on `POST /api/v1/service-requests` and `PATCH /api/v1/service-requests/:id/status`; `MANAGER` of `VOP-A` patching a `VOP-B` request gets `403 ACCESS_DENIED` + `audit_log`.

- [ ] **Step 2: Run `m11ResidentBreakdownAndSlaFlow.test.js` to verify it fails**

Run: `node --test --test-concurrency=1 test/m11ResidentBreakdownAndSlaFlow.test.js` (cwd: `d:\resihub\api`)
Expected: FAIL (`internal_note` leaked, 7-day duplicate check, missing `/cancel` & `/reopen` routes, `SYS_ADMIN` allowed on write, missing `escalateOverdueServiceRequests`).

- [ ] **Step 3: Implement M11 updates in `resident.js`, `service-requests.js`, `reports.js`, `settings.js`, and `daily.js`**

Follow the exact endpoint contracts, SQL column projections, `getUserClient(req)` RLS execution, and `idempotencyGuard()` middleware specified in Interfaces. Ensure `PATCH /api/v1/service-requests/:id/status` remains 100% compatible with callers sending `{ status: 'RESOLVED', internal_note: '...' }` without `resolution_note` (defaulting `resolution_note` to `null`, never copying `internal_note` into `resolution_note`).

- [ ] **Step 4: Run M11 test + existing white/black-box regression suites**

Run: `node --test --test-concurrency=1 test/m11ResidentBreakdownAndSlaFlow.test.js test/sprint1And2Rebuild.test.js test/multiBuildingAndFutureContract.test.js` (cwd: `d:\resihub\api`)
Expected: PASS (0 failures).

- [ ] **Step 5: Commit**

```bash
git add api/src/routes/resident.js api/src/routes/service-requests.js api/src/routes/reports.js api/src/routes/settings.js api/src/jobs/daily.js api/test/m11ResidentBreakdownAndSlaFlow.test.js
git commit -m "feat(m11): implement resident breakdown SLA, 24h duplicate check, hold/reopen/cancel and escalation"
```

---

### Task 4: Backend M13 — Announcements, Zalo Group Directory, 2-Step Broadcast & Manual-Zalo-Sent Tracking

**Files:**
- Create: `api/src/routes/zalo-groups.js`
- Create: `api/src/routes/announcements.js`
- Modify: `api/src/routes/notifications.js`
- Modify: `api/src/jobs/daily.js`
- Modify: `api/src/server.js`
- Test: `api/test/m13AnnouncementsAndZaloCopy.test.js`

**Interfaces:**
- Consumes: `ZALO_ANNOUNCEMENT_TEMPLATES`, `validateZaloInviteLink`, `formatAnnouncementForZalo` from Task 1 (`api/src/services/zaloFormatter.js`); `zalo_group`, `announcement`, `notification.announcement_id`, `fn_get_ops_resource_scope` from Task 2.
- Produces:
  - `api/src/routes/zalo-groups.js` mounted at `/api/v1/zalo-groups`:
    - `GET /`: `requireRole(['SYS_ADMIN', 'OWNER', 'MANAGER'])`; filters `?building_id`, `?scope=BUILDING|APARTMENT`, `?apartment_id`, `?include_inactive=true`; enforces `403 ACCESS_DENIED` on out-of-scope `building_id`.
    - `POST /`: `requireRole(['MANAGER'])` + `idempotencyGuard()`; `{ building_id, scope, apartment_id?, name, invite_link?, note?, is_active? }`; validates `invite_link` via `validateZaloInviteLink` (`422 INVALID_ZALO_LINK`), verifies `apartment_id` belongs to `building_id`, inserts via `getUserClient(req)`, writes `CREATE_ZALO_GROUP` audit log.
    - `PUT /:id`: `requireRole(['MANAGER'])` + `idempotencyGuard()`; resolves building via `fn_get_ops_resource_scope('zalo_group', id)` (`404` vs `403 ACCESS_DENIED`), updates group fields & `updated_at`, writes `UPDATE_ZALO_GROUP` audit log.
  - `api/src/routes/announcements.js` mounted at `/api/v1/announcements`:
    - `GET /templates`: returns `{ data: ZALO_ANNOUNCEMENT_TEMPLATES }`.
    - `GET /`: `requireRole(['SYS_ADMIN', 'OWNER', 'MANAGER'])`; returns building-scoped announcements (`?building_id`, `?status`, `?target_scope`) enriched with exact `read_count` (`COUNT(n.id) FILTER (WHERE n.read_at IS NOT NULL)` via `notification.announcement_id`), `zalo_content` (computed if null), and matched `target_zalo_groups` (`zalo_group` rows matching the announcement's building or target floor/apartment rooms so `MANAGER` knows exactly which Zalo groups to paste into per `FR-069`).
    - `POST /`: `requireRole(['MANAGER'])` + `idempotencyGuard()`; `{ building_id, target_scope, floor_id?, apartment_id?, type?, title, body, zalo_content?, scheduled_at? }`; creates `DRAFT` (or `SCHEDULED` when future `scheduled_at` is provided, `422 INVALID_SCHEDULE_TIME` if `scheduled_at` is in the past), auto-populating `zalo_content` via `formatAnnouncementForZalo` when omitted, writes `CREATE_ANNOUNCEMENT` audit log.
    - `PUT /:id`: `requireRole(['MANAGER'])` + `idempotencyGuard()`; edits `DRAFT`/`SCHEDULED` (or updates `zalo_content` on `SENT`, or cancels `DRAFT`/`SCHEDULED -> CANCELLED`), writes `UPDATE_ANNOUNCEMENT` audit log.
    - `POST /:id/send`: `requireRole(['MANAGER'])` + `idempotencyGuard()`; enforces 2-step confirmation `req.body?.confirm_send === true` (`422 CONFIRMATION_REQUIRED` per `PRD 14.3`); rejects `SENT` (`409 ALREADY_SENT`) or `CANCELLED` (`409 ANNOUNCEMENT_CANCELLED`); resolves active `app_user` recipients across **both `contract.primary_tenant_id` and `contract_occupant`** (`DISTINCT u.id`) on `ACTIVE`/`RENEWAL_PENDING`/`TERMINATION_PENDING` contracts in target `BUILDING`/`FLOOR`/`APARTMENT`; inserts `notification` rows (`announcement_id = announcement.id`), updates `status = 'SENT'`, `sent_at = NOW()`, `recipient_count`, and writes `SEND_ANNOUNCEMENT` audit log.
    - `POST /:id/mark-zalo-sent`: `requireRole(['MANAGER'])` + `idempotencyGuard()`; `{ zalo_group_ids?: string[], note?: string }` sets `manual_sent_at = NOW()`, `manual_sent_by = req.user.sub`, merges checked groups into `manual_sent_groups`, and writes `MARK_ANNOUNCEMENT_ZALO_SENT` audit log (`FR-069`, `PRD 13.6`).
  - `dispatchDueScheduledAnnouncements(dbPool, { nowTs = new Date(), buildingId = null }) -> Promise<{ dispatchedCount: number, notificationsSent: number }>` in `api/src/jobs/daily.js` (with `FOR UPDATE SKIP LOCKED` on `status = 'SCHEDULED' AND scheduled_at <= $nowTs`).
  - Updated `api/src/routes/notifications.js`: `POST /api/v1/notifications` restricted to `requireRole(['MANAGER'])` + `idempotencyGuard()` (`SYS_ADMIN` & `OWNER` return `403` per `PRD 6.2`), internally creating a `SENT` `announcement` + linked `notification` rows (including `contract_occupant` accounts) and returning `{ message, recipient_count, announcement_id, zalo_content, target_zalo_groups }` while keeping `GET /api/v1/notifications` (`data`, `unread_count`, `sent_history`) 100% backward-compatible.

- [ ] **Step 1: Write the failing integration test `api/test/m13AnnouncementsAndZaloCopy.test.js`**

Test cases (isolated temp Zalo groups, announcements, and occupant accounts with full `t.after` cleanup):
1. **Zalo Group Directory & Link Validation (`FR-069`, `PRD 13.6`, *Review Focus #5*):** `MANAGER` creates a `BUILDING` Zalo group (`https://zalo.me/g/vopa_main`) and an `APARTMENT` Zalo group (`https://zalo.me/g/vopa_a101`); `javascript:alert(1)` link fails with `422 INVALID_ZALO_LINK`; `MANAGER` of `VOP-A` creating/reading `VOP-B` group gets `403 ACCESS_DENIED`; `OWNER` & `SYS_ADMIN` can `GET` (`200`) and get `403` on `POST`/`PUT`.
2. **Draft -> 2-Step Send Confirmation -> Primary + Occupant Fan-Out (`FR-053`..`FR-056`, `PRD 14.3`, *Review Focus #5*):**
   - `POST /api/v1/announcements` creates `DRAFT` with formatted `zalo_content` and matched `target_zalo_groups`.
   - `POST /api/v1/announcements/:id/send` without `confirm_send: true` returns `422 CONFIRMATION_REQUIRED`.
   - With `{ confirm_send: true }`, returns `200`, `status === 'SENT'`, both primary tenant and `contract_occupant` receive exactly 1 `notification` each (`announcement_id` linked), marking 1 read updates `GET /api/v1/announcements` `read_count === 1`, and calling `/send` again returns `409 ALREADY_SENT`.
3. **Manual Zalo Copy Tracking (`FR-069`, `PRD 13.6`):** `POST /api/v1/announcements/:id/mark-zalo-sent` with `{ zalo_group_ids: [bldgGroupId] }` stamps `manual_sent_at`, populates `manual_sent_groups`, and records `MARK_ANNOUNCEMENT_ZALO_SENT` in `audit_log` (visible to building `OWNER`).
4. **Scheduled Dispatch (`FR-054`):** Creating a `SCHEDULED` announcement and running `dispatchDueScheduledAnnouncements` after `scheduled_at` transitions `SCHEDULED -> SENT` and delivers notifications idempotently.
5. **Legacy `POST /api/v1/notifications` Compatibility & `SYS_ADMIN` Read-Only (`PRD 6.2`):** `MANAGER` calling `POST /api/v1/notifications` returns `201` with `announcement_id` & `zalo_content`; `SYS_ADMIN` and `OWNER` calling `POST /api/v1/notifications` return `403`.

- [ ] **Step 2: Run `m13AnnouncementsAndZaloCopy.test.js` to verify it fails**

Run: `node --test --test-concurrency=1 test/m13AnnouncementsAndZaloCopy.test.js` (cwd: `d:\resihub\api`)
Expected: FAIL (`404` on `/api/v1/zalo-groups` and `/api/v1/announcements`).

- [ ] **Step 3: Implement `zalo-groups.js`, `announcements.js`, `notifications.js`, `daily.js`, and mount in `server.js`**

Share a single transactional fan-out helper between `announcements.js`, `notifications.js`, and `daily.js` so recipient resolution (`primary_tenant_id` UNION `contract_occupant`, active `app_user`, deduplicated per `user_id`) and `zalo_content` formatting behave identically across immediate, 2-step, and scheduled sends.

- [ ] **Step 4: Run M13 test + full notification regression checks**

Run: `node --test --test-concurrency=1 test/m13AnnouncementsAndZaloCopy.test.js test/multiBuildingAndFutureContract.test.js test/residentOnboardingFlow.test.js` (cwd: `d:\resihub\api`)
Expected: PASS (0 failures).

- [ ] **Step 5: Commit**

```bash
git add api/src/routes/zalo-groups.js api/src/routes/announcements.js api/src/routes/notifications.js api/src/jobs/daily.js api/src/server.js api/test/m13AnnouncementsAndZaloCopy.test.js
git commit -m "feat(m13): add announcements lifecycle, Zalo group directory, 2-step send and manual Zalo tracking"
```

---

### Task 5: Frontend M11 & M13 + Zalo Copy UX & Full End-to-End Regression Verification

**Files:**
- Create: `frontend/src/utils/zaloFormat.js`
- Create: `frontend/src/services/announcements.service.js`
- Modify: `frontend/src/constants/statuses.js`
- Modify: `frontend/src/hooks/usePermission.js`
- Modify: `frontend/src/services/resident.service.js`
- Modify: `frontend/src/services/serviceRequests.service.js`
- Modify: `frontend/src/pages/resident/ResidentPortalPage.jsx`
- Modify: `frontend/src/pages/resident/tabs/MaintenanceTab.jsx`
- Modify: `frontend/src/pages/resident/tabs/NotificationsTab.jsx`
- Modify: `frontend/src/pages/admin/maintenance/ServiceRequestsPage.jsx`
- Modify: `frontend/src/pages/admin/notifications/NotificationsPage.jsx`
- Modify: `frontend/src/pages/admin/settings/SettingsPage.jsx`
- Test: `api/test/frontendWeek6Helpers.test.js`

**Interfaces:**
- Consumes: All Task 3 & Task 4 HTTP endpoints (`/api/v1/resident/service-requests`, `/api/v1/service-requests`, `/api/v1/announcements`, `/api/v1/zalo-groups`, `/api/v1/settings`).
- Produces:
  - `frontend/src/utils/zaloFormat.js`:
    - `ZALO_QUICK_TEMPLATES`, `buildZaloPreviewText(params)`, `buildRoomMaintenanceZaloText(detail)`, `isValidZaloGroupUrl(url)`, `computeSlaBadgeMeta({ status, slaDueAt, slaBreachedAt, now }) -> { state: 'ON_TRACK' | 'DUE_SOON' | 'OVERDUE' | 'COMPLETED', label: string, variant: string }`, and `copyTextToClipboard(text) -> Promise<boolean>` (`navigator.clipboard.writeText` with hidden `textarea` fallback).
  - `frontend/src/services/announcements.service.js`: `listAnnouncements`, `listTemplates`, `createAnnouncement`, `updateAnnouncement`, `sendAnnouncement`, `markZaloSent`, `listZaloGroups`, `createZaloGroup`, `updateZaloGroup` (all mutations wrapped with `withIdempotency`).
  - Updated `frontend/src/constants/statuses.js` & `usePermission.js`:
    - Add `ON_HOLD: { label: 'Tạm hoãn / Hẹn lại', variant: 'purple' }` and `REOPENED: { label: 'Mở lại xử lý', variant: 'red' }` to `SERVICE_REQUEST_STATUS`; add `ANNOUNCEMENT_STATUS` (`DRAFT`, `SCHEDULED`, `SENT`, `CANCELLED`) and `PREFERRED_SLOT_LABELS`.
    - Set `canHandleMaintenance: isManager` and `canSendNotifications: isManager` in `usePermission.js` so `SYS_ADMIN` and `OWNER` render strictly Read-Only (`PRD 6.2`, preserving `devtools-ui-suite.mjs` UI-05 assertions that `OWNER` sees zero `'Gửi thông báo'` / `'Phát hành thông báo'` buttons).

- [ ] **Step 1: Write failing Frontend helper unit tests in `api/test/frontendWeek6Helpers.test.js`**

Test `buildZaloPreviewText` (building vs apartment header/greeting), `buildRoomMaintenanceZaloText`, `isValidZaloGroupUrl` (`https://zalo.me/...` vs `javascript:`/`http:`), and `computeSlaBadgeMeta` (`OVERDUE` when `now > slaDueAt` on open request, `DUE_SOON` when `<= 60` mins left, `COMPLETED` on `RESOLVED`/`CLOSED` without false overdue badge).

- [ ] **Step 2: Run `frontendWeek6Helpers.test.js` to verify it fails**

Run: `node --test --test-concurrency=1 test/frontendWeek6Helpers.test.js` (cwd: `d:\resihub\api`)
Expected: FAIL (`ERR_MODULE_NOT_FOUND` for `frontend/src/utils/zaloFormat.js`).

- [ ] **Step 3: Implement Frontend M11, M13, and Zalo Copy UI updates**

- **Services & Permissions (`statuses.js`, `usePermission.js`, `resident.service.js`, `serviceRequests.service.js`, `announcements.service.js`, `zaloFormat.js`):**
  - Add `cancelServiceRequest(id, payload, options)` and `reopenServiceRequest(id, payload, options)` to `resident.service.js`, and wrap `createServiceRequest`, `rateServiceRequest`, `serviceRequestsService.create`, and `serviceRequestsService.updateStatus` with `withIdempotency`.
- **Resident Portal (`ResidentPortalPage.jsx`, `MaintenanceTab.jsx`, `NotificationsTab.jsx`):**
  - `ResidentPortalPage.jsx`: include `'ON_HOLD'` and `'REOPENED'` in `computeOpenRequests`.
  - `MaintenanceTab.jsx`:
    - Add `location_detail` (`Input`) and `preferred_slot` (`Select`: Sáng 08–12h, Chiều 13–17h, Tối 18–21h, Linh hoạt cả ngày) to the Create Request modal.
    - Upgrade the 24h Duplicate Warning modal (`AC-004.2`): show `existing_request.tracking_code` + title + status, with **"Xem yêu cầu đã gửi"** (opens/scrolls to that existing request detail) alongside **"Vẫn tiếp tục gửi mới"**.
    - Remove `req.internal_note` fallback (`line 427` — *Review Focus #1*): display only `req.resolution_note`, `req.resolution_images` (with `AuthImage` lightbox), and `req.hold_reason` / `req.next_appointment_at` when `ON_HOLD`, plus SLA due badge (`computeSlaBadgeMeta`).
    - On `NEW` cards: add **"Hủy yêu cầu"** confirmation action.
    - On `RESOLVED` cards (`FR-047`): offer both **"Nghiệm thu & Đánh giá (1–5 sao)"** (`-> CLOSED`) and **"Chưa đạt — Yêu cầu xử lý lại"** modal (`reopen_reason` -> `REOPENED`, disabled with tooltip once `reopen_window_days` expires).
  - `NotificationsTab.jsx`: add explicit icon/color badges in `getNotificationMeta` for `ANNOUNCEMENT`, `MAINTENANCE_NOTICE`, `UTILITY_INTERRUPTION`, `HOUSE_RULES`, `SECURITY_ALERT`, and `SERVICE_REQUEST_*`.
- **Admin Maintenance (`ServiceRequestsPage.jsx`) & Settings (`SettingsPage.jsx`):**
  - `ServiceRequestsPage.jsx`: add `ON_HOLD` and `REOPENED` to Kanban/table + filter bar + **"Quá hạn SLA"** toggle (`overdue_sla=true`); render SLA badge (`computeSlaBadgeMeta`) on cards/rows; in the Detail Modal, separate **"Kết quả xử lý gửi cư dân (`resolution_note`)"** + **"Ảnh nghiệm thu sau sửa chữa (`resolution_images`, tối đa 3 ảnh)"** from **"Ghi chú nội bộ BQL (`internal_note` — cư dân không xem được)"**; add `ON_HOLD` inputs (`hold_reason`, `next_appointment_at`); add **"Lịch sử xử lý"** (`audit_timeline`); and add **"Copy tin nhắn Zalo phòng"** button (copies `zalo_room_message_preview` and shows a link to open `apartment_zalo_group.invite_link` if configured).
  - `SettingsPage.jsx`: add `reopen_window_days` (`Số ngày cho phép cư dân mở lại yêu cầu sau khi hoàn tất`, default `3`) to the `sla_config` card.
- **Admin Notifications & Zalo Hub (`NotificationsPage.jsx`):**
  - Organize into 2 tabs: **"Thông báo & Xuất Zalo"** and **"Danh bạ Nhóm Zalo (`zalo_group`)"**.
  - In **"Thông báo & Xuất Zalo"** (mutation controls visible only when `canSendNotifications` is true):
    - Quick Template selector (`ZALO_QUICK_TEMPLATES`: Cắt điện/nước, Bảo trì thang máy/PCCC, Nhắc nội quy, Cảnh báo an ninh, Thông báo chung) auto-filling title, type, and body.
    - Scope selector (`Toàn tòa`, `Theo tầng`, `Từng phòng`), live **Xem trước nội dung chuẩn Zalo** (`zalo_content`, editable), and actions **"Lưu nháp (`DRAFT`)"**, **"Hẹn giờ gửi (`SCHEDULED`)"**, or **"Phát hành ngay"** — opening a **2-Step Confirmation Dialog (`PRD 14.3`)** summarizing target scope before calling `POST /api/v1/announcements/:id/send` with `{ confirm_send: true }`.
    - Announcement History table showing status (`DRAFT`/`SCHEDULED`/`SENT`/`CANCELLED`), `read_count / recipient_count` (`FR-056`), Zalo status badge (`Đã dán Zalo lúc ...` when `manual_sent_at` is set vs `Chưa dán Zalo`), and a prominent **"Sao chép dán Zalo"** button on every row.
    - **"Sao chép & Dán sang nhóm Zalo" Modal (`FR-069`)**: displays formatted `zalo_content`, 1-click **"Sao chép nội dung"** button with toast confirmation, checklist of matched `target_zalo_groups` (building group or room group with external **"Mở nhóm Zalo"** link `target="_blank" rel="noopener noreferrer"`), and **"Xác nhận đã gửi thủ công lên Zalo"** button calling `markZaloSent` to stamp `manual_sent_at`.
  - In **"Danh bạ Nhóm Zalo"**: filterable list by building & scope (`Nhóm Tòa` / `Nhóm Phòng`), plus Create/Edit modal for `MANAGER` (`scope`, `building_id`, `apartment_id` when room-scoped, `name`, `invite_link` validated against `zalo.me`, `note`, `is_active`).

- [ ] **Step 4: Run Frontend helper tests, Vite production build, and the ENTIRE Backend test suite**

Run 1: `node --test --test-concurrency=1 test/frontendWeek6Helpers.test.js test/week6DomainHelpersUnit.test.js` (cwd: `d:\resihub\api`)
Run 2: `npm run build` (cwd: `d:\resihub\frontend`)
Run 3: `npm test` (cwd: `d:\resihub\api`)
Expected: All unit tests pass, Vite production build succeeds with zero compile/import warnings, and 100% of backend integration suites (including `fullWebsiteWhiteBlackBox.test.js`, `rbacPrdAlignment.test.js`, `m11ResidentBreakdownAndSlaFlow.test.js`, and `m13AnnouncementsAndZaloCopy.test.js`) PASS with zero leaked test rows.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/utils/zaloFormat.js frontend/src/services/announcements.service.js frontend/src/constants/statuses.js frontend/src/hooks/usePermission.js frontend/src/services/resident.service.js frontend/src/services/serviceRequests.service.js frontend/src/pages/resident/ResidentPortalPage.jsx frontend/src/pages/resident/tabs/MaintenanceTab.jsx frontend/src/pages/resident/tabs/NotificationsTab.jsx frontend/src/pages/admin/maintenance/ServiceRequestsPage.jsx frontend/src/pages/admin/notifications/NotificationsPage.jsx frontend/src/pages/admin/settings/SettingsPage.jsx api/test/frontendWeek6Helpers.test.js
git commit -m "feat(ui): deliver M11 resident breakdown SLA/reopen UI and M13 Zalo copy + group directory workflow"
```
