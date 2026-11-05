# Notification Action Routing & Auto-Modal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make clicking any notification across all 4 roles (`RESIDENT`, `MANAGER`, `OWNER`, `SYS_ADMIN`) and all 3 notification UI surfaces mark it as read, sync building/contract context, navigate to the exact operational screen, and automatically open the corresponding action or detail modal — while adding the 4 missing operational handoff notifications.

**Architecture:** Backend enriches historical and SQL-generated notification payloads in batch on `GET /api/v1/notifications`, filters `/admin*` org-wide seed rows out of pure-`RESIDENT` responses, and emits the 4 missing operational notifications (`PAYMENT_REPORTED`, `SERVICE_SUBSCRIPTION_REQUESTED` / `SERVICE_CANCELLATION_REQUESTED`, `CONTRACT_REQUEST_SUBMITTED`, `PENDING_CREDIT_REFUND` / `CREDIT_REFUND_PENDING`) plus 2-way 4-eyes feedback and `AI_BUDGET_EXCEEDED`. Frontend resolves every notification through a pure mapper (`notificationNavigation.js`) invoked by `useNotificationAction`, syncs `selectedBuildingId` / `target_contract_id`, opens `NotificationDetailModal` for pure broadcasts, and triggers one-shot modals on destination tabs/pages before cleaning transient URL params with `replace: true`.

**Tech Stack:** Node.js (ESM), Express, PostgreSQL (`pg` with RLS `pool` + `adminPool`), `node:test` + `node:assert/strict`, React 18, React Router v6 (`useSearchParams`, `useNavigate`), Zustand (`notificationStore`, `authStore`), Tailwind CSS.

**Spec:** `docs/superpowers/specs/2026-11-05-notification-action-routing-design.md`

## Global Constraints

- Do NOT write SQL migrations modifying existing `fn_notify_*` PL/pgSQL functions or adding new PostgreSQL tables.
- All new Node.js notification emissions MUST be wrapped in `try/catch` after transaction `COMMIT` (or non-fatally) using `adminPool` scoped strictly by `org_id` so RLS on `notification` (`rls_notification_insert`) never aborts resident or manager business mutations.
- `enrichNotificationsContext` MUST batch queries with `ANY($2::uuid[])` scoped by `WHERE org_id = $1`, validate UUID format before querying, and ONLY attach routing identifiers (`contract_id`, `invoice_id`, `building_id`, `apartment_id`, normalized `link`) — never `internal_note` or sensitive columns.
- Respect RBAC & Read-Only boundaries: `SYS_ADMIN` and `OWNER` remain read-only on `MANAGER` operational forms except `OWNER` Four-Eyes approvals and `SYS_ADMIN` `/admin/settings` access; never route `OWNER` or `MANAGER` to `/admin/settings`.
- Every destination page/tab auto-opening a modal from URL search params MUST clear one-shot trigger params (`modal`, `invoice_id`, `payment_id`, `credit_id`, `deposit_id`, `request_id`, `subscription_id`, `reservation_id`, `target_contract_id`) via `{ replace: true }` immediately after consuming them so closing the modal or pressing F5 never re-opens it.
- Preserve unrelated modified/untracked files in the working tree; stage only files belonging to each task.

## Review Focus

- Malformed, empty, or non-UUID string IDs in historical `notification.payload` (e.g. `invoice_id: "bad-id"`, `payload: null`) must be ignored cleanly without throwing PostgreSQL `22P02 invalid input syntax for type uuid` on `GET /api/v1/notifications` (tested in Task 1).
- Pure `RESIDENT` accounts must neither see nor count `user_id IS NULL` rows whose `payload->>'link'` starts with `/admin`, while multi-role or admin accounts (`MANAGER`, `OWNER`, `SYS_ADMIN`) still receive them and `unread_count` matches the filtered set (tested in Task 1).
- Role-gated and seed notifications lacking entity UUIDs (`AI_BUDGET_WARNING` clicked by `OWNER`/`MANAGER`, `DEPOSIT_SECURE` without `deposit_id`, `RESERVATION_NEW` without `apartment_id`, `CONTRACT_EXPIRING` without `contract_id`) must resolve to `kind: 'detail_modal'` with a safe fallback list URL rather than `/admin/settings` (`<AccessDenied />`) or `/admin/apartments/undefined` (tested in Task 3).
- Admin `TopBar` building filter mismatch (`selectedBuildingId` set to Building A while clicked notification belongs to Building B) must update `selectedBuildingId` before navigation so the destination page does not filter out the target record (tested in Task 3 & Task 4).
- Ended (`EXPIRED`/`TERMINATED`) contracts and co-occupants (`contract_occupant` where `overview.active_contract === null`) on `/resident` must still load and open the target invoice, settlement, or read-only A4 contract modal via `target_contract_id` without polluting the `ResidentLayout` active-contract switcher (tested in Task 5).

---

### Task 1: Backend Notification Enrichment, Role Scoping & Helper Service

**Files:**
- Create: `api/src/services/notificationService.js`
- Modify: `api/src/routes/notifications.js:30-111`
- Test: `api/test/notificationEnrichmentAndScoping.test.js`

**Interfaces:**
- Produces:
  - `isUuid(val) -> boolean`
  - `filterNotificationsSqlClause(roleCodes) -> string`
  - `enrichNotificationsContext(rows, orgId, { queryFn } = {}) -> Promise<Array<object>>`
  - `notifyBuildingManagers(orgId, buildingId, { title, content, type, payload }, { queryFn } = {}) -> Promise<string[]>`
  - `notifyBuildingFourEyesApprovers(orgId, buildingId, excludeUserId, { title, content, type, payload }, { queryFn } = {}) -> Promise<string[]>`
  - `notifyUser(orgId, userId, { title, content, type, payload }, { queryFn } = {}) -> Promise<boolean>`

- [ ] **Step 1: Write the failing test in `api/test/notificationEnrichmentAndScoping.test.js`**

Test `enrichNotificationsContext` with mock `queryFn` verifying:
1. Enriches missing `contract_id`, `building_id`, `apartment_id`, `invoice_id` across `payment_id`, `invoice_id`, `credit_id`, `deposit_id`, `service_request_id`, `subscription_id`, `reservation_id`, `contract_id`, `tenant_id`.
2. Rewrites legacy `payload.link === '/admin/service-requests'` to `'/admin/maintenance'`.
3. Ignores `payload: null` and malformed non-UUID IDs (`invoice_id: 'not-a-uuid'`) without calling `queryFn` with invalid UUIDs.
4. `filterNotificationsSqlClause(['RESIDENT'])` excludes `user_id IS NULL AND COALESCE(payload->>'link', '') LIKE '/admin%'`, whereas `filterNotificationsSqlClause(['MANAGER'])` and `filterNotificationsSqlClause(['RESIDENT', 'MANAGER'])` return `''`.
5. Live API check (when DB reachable): `GET /api/v1/notifications` as a pure `RESIDENT` never returns `user_id === null` rows with `/admin*` links, and enriches an `INVOICE_ISSUED` row that only stored `{ invoice_id }` with `contract_id`, `building_id`, and `apartment_id`.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test api/test/notificationEnrichmentAndScoping.test.js`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `../src/services/notificationService.js`.

- [ ] **Step 3: Implement `api/src/services/notificationService.js` and wire `GET /api/v1/notifications` in `api/src/routes/notifications.js`**

In `api/src/services/notificationService.js`:
- Validate UUIDs via `/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i`.
- Batch-query only tables whose entity IDs are present and missing context keys (`payment JOIN invoice JOIN apartment`, `invoice JOIN apartment`, `credit_balance LEFT JOIN contract LEFT JOIN apartment`, `deposit JOIN contract JOIN apartment`, `service_request JOIN apartment LEFT JOIN LATERAL (SELECT id FROM contract WHERE apartment_id = sr.apartment_id AND deleted_at IS NULL ORDER BY (status = 'ACTIVE') DESC, created_at DESC LIMIT 1)`, `service_subscription JOIN contract JOIN apartment`, `reservation JOIN apartment`, `contract JOIN apartment`, `tenant LEFT JOIN apartment ON desired_apartment_id`). Every lookup filters `WHERE <tbl>.org_id = $1 AND <tbl>.id = ANY($2::uuid[])` via `adminPool.query` (default `queryFn`).
- Normalize `payload.link`: replace `/admin/service-requests` prefix with `/admin/maintenance`.
- Implement `notifyBuildingManagers`, `notifyBuildingFourEyesApprovers`, and `notifyUser` using `adminPool.query` (default `queryFn`), deduplicating recipient UUIDs.
In `api/src/routes/notifications.js`:
- Compute `roles = getUserRoleCodes(req)` before `listResult` and `countResult`, append `filterNotificationsSqlClause(roles)` to both `SELECT * FROM notification` and `SELECT COUNT(*)::int FROM notification`, and pass `listResult.rows` through `await enrichNotificationsContext(listResult.rows, orgId)`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test api/test/notificationEnrichmentAndScoping.test.js`
Expected: PASS (0 failures).

- [ ] **Step 5: Commit**

Stage only `api/src/services/notificationService.js`, `api/src/routes/notifications.js`, and `api/test/notificationEnrichmentAndScoping.test.js`, then commit with `feat(m13-api): enrich notification payloads on read and scope org seed rows`.

---

### Task 2: Backend Missing Operational Notification Emitters & Payload Normalization

**Files:**
- Modify: `api/src/routes/resident.js` (`POST /payments/report`, `POST /services`, `PATCH /services/:id/cancel`, `POST /contract-requests`)
- Modify: `api/src/routes/payments.js` (`PATCH /:id/confirm`, `PATCH /:id/reject`, `POST /credits/:id/refund`, `POST /credits/:id/refund/approve`, `POST /credits/:id/refund/reject`)
- Modify: `api/src/routes/invoices.js` (manual/bulk issue `INVOICE_ISSUED`, adjustment `/approve`, `/reject`)
- Modify: `api/src/routes/services.js` (`PATCH /subscriptions/:id/status` when `TERMINATED` / `ACTIVE` / `REJECTED`)
- Modify: `api/src/jobs/daily.js` (`SERVICE_REQUEST_SLA_BREACH` link `/admin/maintenance` + `building_id` in daily cron payloads)
- Modify: `api/src/services/aiGateway.js` (emit once-per-period `AI_BUDGET_EXCEEDED` for `SYS_ADMIN` when hard cap blocks AI)
- Test: `api/test/notificationFourMissingFlows.test.js`

**Interfaces:**
- Consumes from Task 1: `notifyBuildingManagers`, `notifyBuildingFourEyesApprovers`, `notifyUser` from `api/src/services/notificationService.js`.
- Produces notification `type` + `payload` contracts:
  - `PAYMENT_REPORTED`: `{ payment_id, invoice_id, contract_id, building_id, apartment_id, amount }` -> building `MANAGER`s.
  - `SERVICE_SUBSCRIPTION_REQUESTED`: `{ subscription_id, service_id, contract_id, building_id, apartment_id, status: 'PENDING_APPROVAL' }` -> building `MANAGER`s.
  - `SERVICE_CANCELLATION_REQUESTED`: `{ subscription_id, service_id, contract_id, building_id, apartment_id, status: 'CANCELLATION_PENDING' }` -> building `MANAGER`s.
  - `SERVICE_TERMINATED`: `{ subscription_id, contract_id, building_id, status: 'TERMINATED' }` -> `RESIDENT` when manager terminates a subscription.
  - `CONTRACT_REQUEST_SUBMITTED`: `{ request_id, contract_id, building_id, apartment_id, request_type }` -> building `MANAGER`s.
  - `PENDING_CREDIT_REFUND`: `{ credit_id, contract_id, building_id, refund_amount }` -> building `OWNER` / Four-Eyes approvers; `CREDIT_REFUND_PENDING`: `{ credit_id, contract_id, building_id, refund_amount }` -> `RESIDENT`.
  - 4-eyes resolution feedback to requesting `MANAGER` (`requested_by !== req.user.sub`): `CREDIT_REFUNDED` / `CREDIT_REFUND_REJECTED` on credit refund approve/reject, and `INVOICE_ADJUSTED` on invoice adjustment approve/reject.
  - `AI_BUDGET_EXCEEDED`: `{ period, spent_usd, monthly_cap_usd }` -> active `SYS_ADMIN`s once per `YYYY-MM` period when hard cap rejects an AI call.

- [ ] **Step 1: Write the failing test in `api/test/notificationFourMissingFlows.test.js`**

Write integration + source-contract tests verifying:
1. Resident `POST /api/v1/resident/payments/report` creates a `PAYMENT_REPORTED` notification for the building's `MANAGER` containing `{ payment_id, invoice_id, contract_id, building_id }`.
2. Resident `POST /api/v1/resident/services` emits `SERVICE_SUBSCRIPTION_REQUESTED`, and `PATCH /api/v1/resident/services/:id/cancel` on an `ACTIVE` subscription emits `SERVICE_CANCELLATION_REQUESTED` to building `MANAGER` with `{ subscription_id, contract_id, building_id }`.
3. Resident `POST /api/v1/resident/contract-requests` emits `CONTRACT_REQUEST_SUBMITTED` to building `MANAGER` with `{ request_id, contract_id, building_id, request_type }`.
4. Manager `POST /api/v1/payments/credits/:id/refund` emits `PENDING_CREDIT_REFUND` to building `OWNER` and `CREDIT_REFUND_PENDING` to `RESIDENT` with `{ credit_id, contract_id, building_id }`; `OWNER` approving emits `CREDIT_REFUNDED` back to the requesting `MANAGER`.
5. `api/src/jobs/daily.js` uses `/admin/maintenance` (never `/admin/service-requests`), and `aiGateway.js` emits `AI_BUDGET_EXCEEDED` once per period when hard cap blocks AI.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test api/test/notificationFourMissingFlows.test.js`
Expected: FAIL because the 4 missing notification types and `AI_BUDGET_EXCEEDED` are not emitted yet.

- [ ] **Step 3: Implement emitters and payload normalizations across backend routes/jobs/services**

Add post-COMMIT `try/catch` notification calls in `resident.js`, `payments.js`, `invoices.js`, `services.js`, update `daily.js` `/admin/maintenance` + `building_id` fields, and add deduplicated `AI_BUDGET_EXCEEDED` emission in `aiGateway.js`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test api/test/notificationFourMissingFlows.test.js`
Expected: PASS (0 failures).

- [ ] **Step 5: Commit**

Stage only the modified Task 2 files (excluding `api/src/routes/services.js` if another session still has unrelated unstaged hunks in it, or stage cleanly once clean) and commit with `feat(m13-api): emit 4 missing operational notifications and normalize payloads`.

---

### Task 3: Frontend Action Resolver (`notificationNavigation.js`) & Org-Notification Read Persistence (`notificationStore.js`)

**Files:**
- Create: `frontend/src/utils/notificationNavigation.js`
- Modify: `frontend/src/stores/notificationStore.js`
- Test: `api/test/frontendNotificationNavigationUnit.test.js`

**Interfaces:**
- Produces from `frontend/src/utils/notificationNavigation.js`:
  - `resolveNotificationAction(notification, { role, isAdminPortal } = {}) -> { kind: 'navigate' | 'detail_modal', url: string | null, fallbackUrl?: string | null, buildingId: string | null, contractId: string | null, actionLabel: string }`
  - `NOTIFICATION_TRIGGER_PARAMS`: `['modal', 'invoice_id', 'payment_id', 'credit_id', 'deposit_id', 'request_id', 'subscription_id', 'reservation_id', 'target_contract_id']`
  - `stripNotificationTriggerParams(searchParams) -> URLSearchParams`
- Produces from `frontend/src/stores/notificationStore.js`:
  - `readOrgNotifStorageKey(userId) -> string` (`resihub:read-org-notifs:${userId}`)
  - Merges locally-read `user_id === null` notification IDs into `notifications` (`read_at`) and recomputes `unreadCount` on `fetchNotifications`, `markAsRead`, and `markAllAsRead`.

- [ ] **Step 1: Write the failing test in `api/test/frontendNotificationNavigationUnit.test.js`**

Test every row of Section 5.2 of the spec across `RESIDENT`, `MANAGER`, `OWNER`, and `SYS_ADMIN`:
1. All Resident mappings: `INVOICE_ISSUED`/`PAYMENT_REMINDER`/`PAYMENT_REJECTED` -> `/resident?tab=invoices&target_contract_id=...&invoice_id=...&modal=pay`; `PAYMENT_CONFIRMED`/`INVOICE_ADJUSTED`/`INVOICE_VOIDED` -> `modal=detail`; `CREDIT_REFUND_PENDING`/`CREDIT_APPLIED` without `invoice_id` -> `credit_id=...&modal=credit`; `SETTLEMENT_STATEMENT_READY`/`DISPUTE_RESOLVED`/`SETTLEMENT_REJECTED` -> `tab=contract&...&modal=settlement`; `SETTLEMENT_APPROVED`/`SETTLEMENT_READY_FOR_PAYOUT`/`DEPOSIT_PAYOUT_RETURNED` -> `modal=bank`; `CONTRACT_EXPIRY`/`CONTRACT_EXPIRING` -> `modal=renew`; `CONTRACT_ACTIVATED`/`CONTRACT_TERMINATED`/`CONTRACT_REQUEST_APPROVED`/`CONTRACT_REQUEST_REJECTED` -> `modal=contract_view`; `DEPOSIT_PAYOUT_COMPLETED`/`DEPOSIT_WARNING_3D` -> `modal=deposit_view`; `MAINTENANCE_UPDATE`/`SERVICE_REQUEST_*` -> `tab=maintenance&...&modal=detail`; `SERVICE_UPDATE`/`SERVICE_TERMINATED` -> `tab=services&...&modal=detail`; `TENANT_APPLICATION_REJECTED` -> `tab=overview&modal=apply`; `RESERVATION_*`/`TENANT_APPLICATION_APPROVED` -> `tab=overview&...&modal=reservation`; `ANNOUNCEMENT`/`UTILITY_INTERRUPTION`/`SYSTEM` -> `kind: 'detail_modal'`.
2. All Admin mappings across `MANAGER`, `OWNER`, `SYS_ADMIN`: `SERVICE_REQUEST_*` -> `/admin/maintenance?request_id=...`; `PAYMENT_REPORTED` -> `/admin/payments?tab=transactions&payment_id=...&modal=review`; `PENDING_CREDIT_REFUND`/`CREDIT_REFUND_*` -> `/admin/payments?tab=credits&credit_id=...&modal=credit`; `SERVICE_SUBSCRIPTION_REQUESTED`/`SERVICE_CANCELLATION_REQUESTED` -> `/admin/services/subscriptions?subscription_id=...&modal=review`; `INVOICE_ADJUSTMENT_PENDING`/`INVOICE_ADJUSTED`/`INVOICE_ISSUED`/`PAYMENT_REMINDER` -> `/admin/invoices/<iid>?modal=auto`; `CONTRACT_REQUEST_SUBMITTED` -> `/admin/contracts?tab=requests&request_id=...&modal=request`; `CONTRACT_PENDING_APPROVAL`/`CONTRACT_PRICE_REJECTED`/`CONTRACT_BILLING_SCHEDULED`/`CONTRACT_EXPIRY`/`CONTRACT_ACTIVATED` -> `/admin/contracts/<cid>?modal=auto`; `SETTLEMENT_*`/`DEPOSIT_*` -> `/admin/deposits?deposit_id=...&modal=settlement`; `PUBLIC_RESERVATION_PENDING_CONFIRM`/`RESERVATION_*` -> `/admin/apartments/<aid>?reservation_id=...&modal=reservation`; `TENANT_APPLICATION` -> `/admin/tenants/<tid>?modal=approval`; `MISSING_METER_READING` -> `/admin/meters?period=...&contract_id=...&modal=record`; `MONTHLY_DEPOSIT_REPORT` -> `/admin/reports?tab=deposit-ledger&...&modal=summary`.
3. Edge cases from Review Focus: `AI_BUDGET_WARNING` / `AI_BUDGET_EXCEEDED` / `CRON_JOB_FAILED` resolves to `/admin/settings?modal=ai|cron` ONLY for `SYS_ADMIN`, and `kind: 'detail_modal'` for `OWNER` and `MANAGER`; seed notifications missing UUIDs (`DEPOSIT_SECURE` without `deposit_id`, `RESERVATION_NEW` without `apartment_id`, `CONTRACT_EXPIRING` without `contract_id`) resolve to `kind: 'detail_modal'` with `fallbackUrl` (`/admin/deposits`, `/admin/buildings`, `/admin/contracts`).
4. `stripNotificationTriggerParams` removes all one-shot params while keeping `tab`, `contract_id`, `period`, `from_date`, `to_date`.
5. `notificationStore` localStorage helper marks `user_id === null` rows as read persistently across re-fetches for a given `userId` without affecting another `userId`.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test api/test/frontendNotificationNavigationUnit.test.js`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `../../frontend/src/utils/notificationNavigation.js`.

- [ ] **Step 3: Implement `frontend/src/utils/notificationNavigation.js` and update `frontend/src/stores/notificationStore.js`**

Implement pure `resolveNotificationAction`, `stripNotificationTriggerParams`, and exported pure org-read state helpers in `notificationStore.js` (reading current `user?.id || user?.sub` via `useAuthStore.getState()` when persisting `user_id == null` read IDs).

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test api/test/frontendNotificationNavigationUnit.test.js`
Expected: PASS (0 failures).

- [ ] **Step 5: Commit**

Stage `frontend/src/utils/notificationNavigation.js`, `frontend/src/stores/notificationStore.js`, and `api/test/frontendNotificationNavigationUnit.test.js`, then commit with `feat(m13-ui): add unified notification action resolver and org-notif read persistence`.

---

### Task 4: Unified Notification Click Surfaces (`NotificationDetailModal`, `useNotificationAction`, Bell & Inboxes)

**Files:**
- Create: `frontend/src/components/common/NotificationDetailModal.jsx`
- Create: `frontend/src/hooks/useNotificationAction.js`
- Modify: `frontend/src/components/common/NotificationBell.jsx`
- Modify: `frontend/src/components/layout/TopBar.jsx`
- Modify: `frontend/src/pages/admin/notifications/NotificationsPage.jsx`
- Modify: `frontend/src/pages/resident/tabs/NotificationsTab.jsx`
- Test: `api/test/frontendNotificationSurfacesWiring.test.js`

**Interfaces:**
- Consumes from Task 3: `resolveNotificationAction` from `frontend/src/utils/notificationNavigation.js`, `useNotificationStore`.
- Produces:
  - `useNotificationAction({ onAfterNavigate } = {}) -> { handleNotificationClick, detailNotification, closeDetailModal, getActionMeta }`
  - `NotificationDetailModal({ notification, open, onClose, fallbackUrl, fallbackLabel, onNavigateFallback })`

- [ ] **Step 1: Write the failing test in `api/test/frontendNotificationSurfacesWiring.test.js`**

Verify behavior & wiring contracts:
1. Pure `syncBuildingFilterBeforeNavigate(targetBuildingId, { selectedBuildingId, buildings, isSysAdmin, setSelectedBuilding })` exported from `useNotificationAction.js`: if `selectedBuildingId` is non-empty and `!== targetBuildingId`, switches to `targetBuildingId` if present in `buildings` (or if `isSysAdmin`), else resets to `''`; leaves `selectedBuildingId === ''` untouched so global view stays global unless filtered to a conflicting building.
2. `TopBar.jsx` passes `onViewAll={() => navigate('/admin/notifications?tab=inbox')}` to `NotificationBell`.
3. `NotificationBell.jsx`, `NotificationsPage.jsx` (inbox tab + `?tab=inbox` URL sync), and `NotificationsTab.jsx` all invoke `useNotificationAction` and mount `NotificationDetailModal`.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test api/test/frontendNotificationSurfacesWiring.test.js`
Expected: FAIL (`useNotificationAction.js` and `NotificationDetailModal.jsx` do not exist).

- [ ] **Step 3: Implement `NotificationDetailModal.jsx`, `useNotificationAction.js`, and wire `NotificationBell.jsx`, `TopBar.jsx`, `NotificationsPage.jsx`, `NotificationsTab.jsx`**

- `useNotificationAction` marks unread notifications as read (`markAsRead(n.id)`), resolves action via `resolveNotificationAction(n, { role, isAdminPortal })`, syncs `selectedBuildingId` in `useAuthStore` when `isAdminPortal && action.buildingId`, and either calls `navigate(action.url)` or opens `NotificationDetailModal` (`detailNotification`).
- `NotificationBell` renders an action hint chip (`action.actionLabel`) on items, closes the popover before navigating, and mounts `NotificationDetailModal` outside the popover conditional so it stays visible when the dropdown closes.
- `NotificationsPage` syncs `activeTab` from `searchParams.get('tab')` (`inbox` / `announcements` / `sent` / `zalo-groups`) and triggers `handleNotificationClick(n)` when clicking inbox rows (plus an explicit action button).
- `NotificationsTab` triggers `handleNotificationClick(n)` when clicking resident notification cards and displays a contextual CTA badge (`Thanh toán ngay →`, `Xem bảng kê →`, `Xem chi tiết →`, etc.).

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test api/test/frontendNotificationSurfacesWiring.test.js`
Expected: PASS (0 failures).

- [ ] **Step 5: Commit**

Stage Task 4 files and commit with `feat(m13-ui): wire notification action hook and detail modal across bell and inboxes`.

---

### Task 5: Resident Portal Deep-Link Context & Auto-Modal Triggers

**Files:**
- Modify: `frontend/src/pages/resident/ResidentPortalPage.jsx`
- Modify: `frontend/src/pages/resident/tabs/InvoicesTab.jsx`
- Modify: `frontend/src/pages/resident/tabs/ContractTab.jsx`
- Modify: `frontend/src/pages/resident/tabs/MaintenanceTab.jsx`
- Modify: `frontend/src/pages/resident/tabs/ServicesTab.jsx`
- Modify: `frontend/src/pages/resident/tabs/OverviewTab.jsx`
- Test: `api/test/frontendResidentNotificationModals.test.js`

**Interfaces:**
- Consumes from Task 3: `stripNotificationTriggerParams` from `frontend/src/utils/notificationNavigation.js`.
- URL search param contracts on `/resident`:
  - `ResidentPortalPage.jsx`: reads `target_contract_id`; if `target_contract_id` matches an entry in `overview.active_contracts`, switches `contract_id` to `target_contract_id`; passes `deepLinkTargetContractId` down to tabs (or tabs read `useSearchParams()` directly) so ended (`EXPIRED`/`TERMINATED`) contracts still resolve without altering `ResidentLayout` active contract selector.
  - `InvoicesTab.jsx`: handles `modal=pay` (opens `payModalOpen` pre-selecting `invoice_id` if unpaid/actionable, else opens **Invoice Detail Modal**), `modal=detail` (opens **Invoice Detail Modal** showing line items, payments, adjustments, and a quick "Báo đã thanh toán" button if unpaid; fetches `residentService.getInvoices({ contract_id: targetContractId })` when `target_contract_id` differs from active `contractId`), and `modal=credit` (opens **Credit Balance Detail Modal** for `credit_id`).
  - `ContractTab.jsx`: mounts A4 template `<Modal open={templateOpen}>` outside the EmptyState early-return so co-occupants (`contract_occupant` with `active_contract === null`) can view `GET /api/v1/contracts/:target_contract_id/template`; handles `modal=settlement` (opens settlement detail / `disputeModalOpen` if within dispute window), `modal=bank` (opens `bankModalOpen` if bank info editable, else settlement/deposit detail modal), `modal=renew` (opens `reqModalOpen` with `type: 'RENEWAL'` if contract `ACTIVE`, else `templateOpen`), `modal=contract_view` (opens `templateOpen` for `target_contract_id || contract.id`), `modal=deposit_view` (opens **Deposit & Transactions Detail Modal**).
  - `MaintenanceTab.jsx`: handles `request_id` + `modal=detail` (if `RESOLVED` and `!rating` -> opens `ratingTarget` modal; else opens **Service Request Progress Detail Modal** with status timeline, technician note, and Cancel / Reopen / Rate action buttons).
  - `ServicesTab.jsx`: handles `subscription_id` + `modal=detail` (opens **Service Subscription Detail Modal** with unit price, metadata/plates, status, and Cancel / Re-subscribe button).
  - `OverviewTab.jsx`: handles `modal=apply` (opens `applyModalOpen`) and `reservation_id` + `modal=reservation` (opens `applyModalOpen` if `HELD` without application, bank info modal if refund requires bank info, else **Reservation Detail Modal**).

- [ ] **Step 1: Write the failing test in `api/test/frontendResidentNotificationModals.test.js`**

Test helper selection logic & tab deep-link contracts:
1. Active vs ended `target_contract_id` resolution on `ResidentPortalPage` (switches `contract_id` only when in `active_contracts`, preserves ended `target_contract_id` for tab-level fetch).
2. `InvoicesTab` opens `pay` modal for `ISSUED`/`OVERDUE`/`PARTIAL` invoices, falls back to read-only invoice detail modal for `PAID`/`VOID`, and supports `modal=credit`.
3. `ContractTab` renders A4 template modal even when `overview.active_contract` is `null` (co-occupant `contract_occupant`), handles `modal=settlement|bank|renew|contract_view|deposit_view`, and cleans trigger params via `stripNotificationTriggerParams` + `{ replace: true }`.
4. `MaintenanceTab`, `ServicesTab`, and `OverviewTab` each consume their deep-link modal params and strip trigger params with `{ replace: true }`.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test api/test/frontendResidentNotificationModals.test.js`
Expected: FAIL because resident tabs do not consume deep-link modal params yet.

- [ ] **Step 3: Implement deep-link modal opening and one-shot param cleanup across `ResidentPortalPage.jsx` and all 5 Resident tabs**

Use existing UI primitives (`Modal`, `Badge`, `StatusBadge`, `Button`, `AuthImage`) and guard one-shot consumption so params are cleaned immediately via `setSearchParams(stripNotificationTriggerParams(prev), { replace: true })`. Show `toast.info('Bản ghi liên quan không còn tồn tại hoặc đã thay đổi trạng thái.')` if a targeted ID is missing.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test api/test/frontendResidentNotificationModals.test.js`
Expected: PASS (0 failures).

- [ ] **Step 5: Commit**

Stage Task 5 files and commit with `feat(m13-resident): auto-open target action and detail modals from notifications`.

---

### Task 6: Admin Finance, Services, Maintenance & System Auto-Modal Triggers

**Files:**
- Modify: `frontend/src/pages/admin/maintenance/ServiceRequestsPage.jsx`
- Modify: `frontend/src/pages/admin/payments/PaymentsPage.jsx`
- Modify: `frontend/src/pages/admin/services/SubscriptionsPage.jsx`
- Modify: `frontend/src/pages/admin/invoices/InvoiceDetailPage.jsx`
- Modify: `frontend/src/pages/admin/deposits/DepositsPage.jsx`
- Modify: `frontend/src/pages/admin/meters/MeterReadingsPage.jsx`
- Modify: `frontend/src/pages/admin/reports/ReportsPage.jsx`
- Modify: `frontend/src/pages/admin/settings/SettingsPage.jsx`
- Test: `api/test/frontendAdminOpsNotificationModals.test.js`

**Interfaces:**
- Consumes from Task 3: `stripNotificationTriggerParams` from `frontend/src/utils/notificationNavigation.js`.
- URL search param contracts:
  - `ServiceRequestsPage.jsx`: `?request_id=<srid>` -> calls `openDetailDrawer({ id: srid })` and strips `request_id`.
  - `PaymentsPage.jsx`: `?tab=transactions&payment_id=<pid>&modal=review` -> switches tab to `transactions`, finds or fetches payment `pid`, opens `reviewPayment` modal (read-only view if already processed or `OWNER`/`SYS_ADMIN`, Confirm/Reject actions if `PENDING` + `MANAGER`); `?tab=credits&credit_id=<crid>&modal=credit` -> switches tab to `credits` and opens **Credit Refund Review / Detail Modal** (Four-Eyes Approve/Reject if `PENDING_DIRECT_REFUND` + eligible approver, Initiate Refund if `AVAILABLE` + `MANAGER`, else read-only detail).
  - `SubscriptionsPage.jsx`: `?subscription_id=<subid>&modal=review` -> clears restrictive status filter if needed, finds `subid`; if `CANCELLATION_PENDING` and `canManageServices` -> opens `cancelTarget` pro-rata termination modal; else opens **Subscription Review / Detail Modal** (Approve / Reject buttons when `PENDING_APPROVAL` and `canManageServices`, read-only details otherwise).
  - `InvoiceDetailPage.jsx`: `?modal=auto` -> after invoice loads, if there is a `PENDING_APPROVAL` adjustment -> opens **Invoice Adjustment Review Modal** (with Approve/Reject buttons when user can approve Four-Eyes); else if invoice is unpaid (`ISSUED`/`OVERDUE`/`PARTIAL`) and `canManageFinance` -> opens `payOpen` modal; else opens **Invoice Summary Modal**.
  - `DepositsPage.jsx`: `?deposit_id=<did>&modal=settlement` -> finds deposit `did` (fetching unfiltered list if needed), switches `activeTab` to match deposit state, and opens `handleOpenSettlement(dep)` if settlement/dispute/payout relevant or `handleOpenTransactions(dep)` if `HELD` on an active contract.
  - `MeterReadingsPage.jsx`: `?period=<YYYY-MM>&contract_id=<cid>&modal=record` -> syncs `period` state from query param, locates first unrecorded meter of `contract_id` (or first meter of `contract_id`), opens `openSingleModal(meter)`.
  - `ReportsPage.jsx`: `?tab=deposit-ledger&from_date=...&to_date=...&modal=summary` -> syncs `activeTab = 'deposit-ledger'` and date range, opens **Monthly Deposit Report Summary Modal** with KPI totals and direct Export Excel RP-07 button.
  - `SettingsPage.jsx`: `?modal=ai` or `?modal=cron` -> scrolls to AI / System section and opens **AI Budget Alert Detail Modal** or **Cron Health Detail Modal** for `SYS_ADMIN`.

- [ ] **Step 1: Write the failing test in `api/test/frontendAdminOpsNotificationModals.test.js`**

Write tests verifying URL param handling, RBAC-safe modal mode selection (action vs read-only detail), and `stripNotificationTriggerParams` `{ replace: true }` cleanup across all 8 Admin pages.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test api/test/frontendAdminOpsNotificationModals.test.js`
Expected: FAIL because the 8 Admin pages do not yet consume deep-link modal params.

- [ ] **Step 3: Implement auto-modal triggers and one-shot URL cleanup across the 8 Admin pages**

Preserve all existing modal workflows and RBAC checks (`usePermission()`), adding clean detail/review modals where a row previously only had inline table buttons (`PaymentsPage` credit row, `SubscriptionsPage` pending row, `InvoiceDetailPage` pending adjustment, `ReportsPage` monthly deposit summary, `SettingsPage` AI/cron alert).

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test api/test/frontendAdminOpsNotificationModals.test.js`
Expected: PASS (0 failures).

- [ ] **Step 5: Commit**

Stage Task 6 files and commit with `feat(m13-admin): auto-open finance, maintenance, service, meter, report, and settings modals`.

---

### Task 7: Admin Contracts, Apartments & Tenants Auto-Modal Triggers + End-to-End Verification

**Files:**
- Modify: `frontend/src/pages/admin/contracts/ContractsPage.jsx`
- Modify: `frontend/src/pages/admin/contracts/ContractDetailPage.jsx`
- Modify: `frontend/src/pages/admin/apartments/ApartmentDetailPage.jsx`
- Modify: `frontend/src/pages/admin/tenants/TenantDetailPage.jsx`
- Test: `api/test/notificationEndToEndRouting.test.js`

**Interfaces:**
- Consumes from Task 1–6: `stripNotificationTriggerParams`, `resolveNotificationAction`, `enrichNotificationsContext`, and all 4 new backend notification flows.
- URL search param contracts:
  - `ContractsPage.jsx`: `?tab=requests&request_id=<rid>&modal=request` -> switches `activeTab` to `'requests'`, locates request `rid`, and opens **Contract Request Review Modal** (with Approve / Reject actions for `PENDING` + `MANAGER`, or read-only detail if already processed / `OWNER` / `SYS_ADMIN`).
  - `ContractDetailPage.jsx`: `?modal=auto` -> once `contract` loads: if `contract.status === 'PENDING_APPROVAL'` -> opens **Contract / Room-Transfer Four-Eyes Approval Modal** (or `templateOpen` + approval bar for read-only viewer); if `contract.status === 'DRAFT'` and `contract.price_rejection_reason` -> opens **Price Rejection & A4 Contract Modal**; otherwise calls `handleOpenTemplate()` (`templateOpen = true`).
  - `ApartmentDetailPage.jsx`: `?reservation_id=<rid>&modal=reservation` -> switches active tab to reservations if tabbed, finds reservation `rid` in `apt.reservations`: if `PENDING_CONFIRM` -> opens **Reservation Payment Proof Review Modal** (receipt `AuthImage` + Confirm / Reject buttons for `MANAGER`, read-only for `OWNER`/`SYS_ADMIN`); if `CANCEL_PENDING_APPROVAL` -> opens `reviewCancelModal`; if `APPROVED_PENDING_PAYOUT` -> opens `payoutCancelModal`; otherwise opens **Reservation Detail Modal**.
  - `TenantDetailPage.jsx`: `?modal=approval` -> once `tenant` loads: if `tenant.profile_status === 'PENDING'` (or `status === 'PENDING_APPROVAL'`) and `canManageTenants` -> opens `approvalDialog` (`open: true, action: 'approve'`) or **Tenant Application Review Modal** showing CCCD images + Approve / Reject buttons; otherwise opens **Tenant Identity Summary Modal** (respecting `maskedForOwner`).

- [ ] **Step 1: Write the failing test in `api/test/notificationEndToEndRouting.test.js`**

Write tests covering:
1. `ContractsPage`, `ContractDetailPage`, `ApartmentDetailPage`, and `TenantDetailPage` deep-link modal handling and `replace: true` URL cleanup.
2. End-to-end integration flow: trigger each of the 4 operational handoffs -> call `GET /api/v1/notifications` as the recipient role -> pass the returned notification row into `resolveNotificationAction` -> assert exact destination URL, `buildingId` context, and target modal query parameter!

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test api/test/notificationEndToEndRouting.test.js`
Expected: FAIL because the 4 detail/list pages do not yet consume deep-link modal params.

- [ ] **Step 3: Implement auto-modal triggers in `ContractsPage.jsx`, `ContractDetailPage.jsx`, `ApartmentDetailPage.jsx`, and `TenantDetailPage.jsx`**

Read each file fresh right before editing so existing `peek*` cache code is preserved intact.

- [ ] **Step 4: Run full test & build verification**

Run:
1. `node --test api/test/notificationEnrichmentAndScoping.test.js api/test/notificationFourMissingFlows.test.js api/test/frontendNotificationNavigationUnit.test.js api/test/frontendNotificationSurfacesWiring.test.js api/test/frontendResidentNotificationModals.test.js api/test/frontendAdminOpsNotificationModals.test.js api/test/notificationEndToEndRouting.test.js`
2. `npm --prefix frontend run build`
3. Restart `resihub-api` Docker container if running (`docker restart resihub-api`) so live API routes serve the new notification enrichment and emitters, and re-run the E2E test against live API.
Expected: All tests PASS (0 failures) and Vite production build exits 0.

- [ ] **Step 5: Commit**

Stage Task 7 files cleanly and commit with `feat(m13-admin): auto-open contract, apartment reservation, and tenant approval modals`.

