# SYS_ADMIN Delete Capabilities Across 4 Modules Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hoàn thiện đầy đủ chức năng Xóa có điều kiện (Guarded Hard Delete) cho vai trò `SYS_ADMIN` trên cả 4 phân hệ nền tảng (**Tòa/Khu/Tầng/Căn hộ**, **Cư dân & Hồ sơ**, **Người dùng & Phân quyền**, và **Cấu hình Hệ thống & Tích hợp**) tuân thủ chặt chẽ RLS, tính bất biến của dữ liệu lịch sử/kiểm toán, và tự động giải phóng bản ghi định danh `person` mồ côi.

**Architecture:** Mở/siết chính sách RLS trong `005_rls_enable_and_policies.sql` cho `zalo_group`, `meter`, `floor` và các bảng nền tảng. Tách bộ kiểm tra lịch sử phụ thuộc, dọn `person` mồ côi (kèm `app_user(RESIDENT)` tự sinh, `owner` rỗng, file `attachment`) và hằng số mặc định `system_setting` vào module dịch vụ tập trung `api/src/services/sysAdminDeleteGuards.js`, tích hợp vào 6 route Backend (`buildings.js`, `apartments.js`, `tenants.js`, `admin/users.js`, `settings.js`, `zalo-groups.js`). Trên Frontend, bổ sung method xóa/khôi phục mặc định trong các service kèm đồng bộ `queryCache` và gắn nút thao tác có `ConfirmDialog` trên 8 màn hình quản trị dành riêng cho `SYS_ADMIN`.

**Tech Stack:** Node.js (ESM), Express 4, PostgreSQL 16 (`FORCE ROW LEVEL SECURITY` + `resihub_app`), `node:test`, React 19, TailwindCSS, Vite, Oxlint.

**Spec:** `docs/superpowers/specs/2026-11-09-sys-admin-delete-design.md`

## Global Constraints

- **RBAC (PRD Mục 6.2 & AC-019.1):** Mọi thao tác `DELETE` trên 4 phân hệ chỉ dành riêng cho `SYS_ADMIN`. Các vai trò `MANAGER`, `OWNER`, `RESIDENT` bị chặn `403` (`DELETE_PROHIBITED` / `ACCESS_DENIED`) và bắt buộc ghi `logAccessDenied` (riêng `POST`/`PUT` trên `zalo-groups` mở cho `['SYS_ADMIN', 'MANAGER']`).
- **Thứ tự kiểm tra bảo mật:** Kiểm tra tồn tại bản ghi theo `req.user.org_id` trước (`404 NOT_FOUND` chống dò ID chéo tổ chức) -> kiểm tra vai trò `SYS_ADMIN` (`403` + `logAccessDenied`) -> kiểm tra ràng buộc lịch sử/tự khóa (`400` / `409`) -> thực thi trong transaction + ghi `audit_log` (`before` snapshot).
- **Bảo toàn bất biến `audit_log` & `ai_suggestion`:** Tuyệt đối không sửa đổi trigger `prevent_audit_log_modification()`. Bất kỳ `app_user` nào đã có dòng trong `audit_log` (`actor_id = id`) đều phải trả `409 USER_HAS_HISTORY` thay vì xóa gây lỗi FK `ON DELETE SET NULL`. Tòa nhà có dòng `ai_suggestion` phải bị chặn `400 BUILDING_NOT_EMPTY`.
- **Dọn `person` mồ côi an toàn:**
  - Khi xóa `tenant`: nếu `person_id` không còn `tenant` khác và không có `owner`, đồng thời `app_user` gắn `person_id` (do `ensureResidentAccount` tự sinh) **chỉ** có role `RESIDENT` và chưa có lịch sử/audit, tự động xóa luôn `app_user` đó + `attachment` + `person` để giải phóng SĐT/CCCD/Email ngay lập tức. Nếu `person_id` còn gắn vai trò nội bộ (`SYS_ADMIN`/`OWNER`/`MANAGER`) hoặc có lịch sử thì giữ nguyên `app_user` và `person`.
  - Khi xóa `app_user`: nếu `person_id` vẫn còn `tenant` thì giữ nguyên `tenant` và `person`; nếu không còn `app_user` và `tenant` nào, đồng thời dòng `owner` (nếu có) chưa gắn tòa nào (`building.owner_id`), phải `DELETE FROM owner` trước (do FK `NO ACTION`) rồi mới xóa `attachment` + `person`.
- **Môi trường chạy test Backend:** Chạy từ thư mục `d:\resihub\api` để nạp `api/.env` có `APP_DATABASE_URL` (kiểm chứng `FORCE ROW LEVEL SECURITY` thật trên role `resihub_app`). Thực thi chồng lấp (async test song song với việc code task kế tiếp) để tối ưu thời gian.

## Review Focus

1. **Căn hộ mới tạo đã được hệ thống tự sinh 2 công tơ `meter` mặc định (`0` `meter_reading`):** Phải xóa sạch thành công dưới role `resihub_app` (nhờ `rls_meter_delete`), nhưng nếu đã có dù chỉ 1 `meter_reading` hoặc 1 `invoice` thì phải chặn `409 APARTMENT_HAS_HISTORY`. Đã ghim test trong Task 1.
2. **Hồ sơ cư dân tạo nhầm qua `POST /api/v1/tenants` tự sinh kèm `app_user(RESIDENT)`:** Sau khi `DELETE /api/v1/tenants/:id`, cả `tenant`, `app_user(RESIDENT)` rỗng và `person` đều phải được dọn sạch để tạo lại ngay cư dân mới trùng SĐT + CCCD mà không bị `409 DUPLICATE_PERSON`. Đã ghim test trong Task 2.
3. **Một `person` vừa là `MANAGER` nội bộ vừa có hồ sơ `tenant`:** Khi xóa `tenant`, tài khoản `MANAGER` và bản ghi `person` tuyệt đối không được mất; ngược lại khi xóa `app_user` chưa có lịch sử nhưng đang có `tenant`, hồ sơ `tenant` và `person` vẫn phải còn nguyên. Đã ghim test trong Task 2.
4. **Tài khoản `OWNER` tạo nhầm từ `POST /api/v1/admin/users` (chưa gán tòa vs đã gán tòa):** Khi chưa gán tòa, xóa `app_user` phải xóa sạch dòng `owner` trước rồi mới xóa `person` (không nổ lỗi FK `23503`); khi đã gán `building.owner_id` hoặc đã có dòng `audit_log`, phải trả `409 USER_HAS_HISTORY`. Đã ghim test trong Task 2.
5. **Khôi phục mặc định `system_setting` và phân quyền xóa `zalo_group`:** `MANAGER` được sửa `zalo_group` trên tòa mình nhưng bấm `DELETE /api/v1/zalo-groups/:id` phải nhận `403 DELETE_PROHIBITED`; `SYS_ADMIN` xóa `system_setting` phải trả về đúng `default_value` chuẩn từ seed và ghi `audit_log`. Đã ghim test trong Task 1.

---

## File Structure

- **Modify:** `api/src/db/migrations/005_rls_enable_and_policies.sql` — cập nhật RLS cho `zalo_group` (`insert`, `update`, `delete`), thêm `rls_meter_delete` và siết `rls_floor_delete` cùng các policy `DELETE` theo `org_id` chỉ cho `is_org_admin()`.
- **Create:** `api/src/services/sysAdminDeleteGuards.js` — hàm kiểm tra phụ thuộc xóa cho `building`, `apartment`, `tenant`, `app_user`, hàm dọn `person` mồ côi + xóa file `uploads/` an toàn, và hằng số `DEFAULT_SYSTEM_SETTINGS`.
- **Modify:** `api/src/routes/buildings.js` — mở rộng điều kiện rỗng của `DELETE /:id` qua `checkBuildingEmptyForDelete`.
- **Modify:** `api/src/routes/apartments.js` — kiểm tra `404` theo `org_id` trước `403` và mở rộng kiểm tra lịch sử của `DELETE /:id` qua `checkApartmentHistoryForDelete`.
- **Modify:** `api/src/routes/settings.js` — thêm `DELETE /:key` khôi phục mặc định cấu hình.
- **Modify:** `api/src/routes/zalo-groups.js` — mở `POST /` & `PUT /:id` cho `SYS_ADMIN` và thêm `DELETE /:id` chỉ cho `SYS_ADMIN`.
- **Create:** `api/test/sysAdminDeleteRealEstateAndConfig.test.js` — integration test RLS cho Phân hệ 1 (Tòa/Tầng/Căn hộ) & Phân hệ 4 (`settings` & `zalo-groups`).
- **Modify:** `api/src/routes/tenants.js` — thêm `DELETE /:id` và `DELETE /:id/id-images/:attachment_id`.
- **Modify:** `api/src/routes/admin/users.js` — thêm `DELETE /:id` và chặn gỡ quyền `SYS_ADMIN` của chính mình / `SYS_ADMIN` cuối cùng trong `PATCH /:id`.
- **Create:** `api/test/sysAdminDeleteTenantsAndUsers.test.js` — integration test cho Phân hệ 2 (Cư dân & CCCD) & Phân hệ 3 (Người dùng & Phân quyền).
- **Modify:** `frontend/src/hooks/usePermission.js`, `frontend/src/services/queryCache.js`, `frontend/src/services/buildings.service.js`, `frontend/src/services/tenants.service.js`, `frontend/src/services/users.service.js`, `frontend/src/services/announcements.service.js` — bổ sung quyền & API client + đồng bộ xóa cache.
- **Modify:** `frontend/src/pages/admin/buildings/BuildingsPage.jsx`, `frontend/src/pages/admin/buildings/BuildingDetailPage.jsx`, `frontend/src/pages/admin/buildings/FloorPlanPage.jsx`, `frontend/src/pages/admin/apartments/ApartmentDetailPage.jsx` — gắn nút Xóa + `ConfirmDialog` cho Tòa, Tầng, Căn hộ.
- **Modify:** `frontend/src/pages/admin/tenants/TenantsPage.jsx`, `frontend/src/pages/admin/tenants/TenantDetailPage.jsx`, `frontend/src/pages/admin/users/UsersPage.jsx`, `frontend/src/pages/admin/settings/SettingsPage.jsx`, `frontend/src/components/settings/AiGatewayConfigCard.jsx`, `frontend/src/pages/admin/notifications/NotificationsPage.jsx` — gắn nút Xóa / Khôi phục mặc định + `ConfirmDialog` cho Cư dân, Ảnh CCCD, Người dùng, Cấu hình hệ thống và Nhóm Zalo.

---

### Task 1: RLS (`005`) + Backend Phân hệ 1 (Bất động sản) & Phân hệ 4 (Cấu hình & Nhóm Zalo)

**Files:**
- Modify: `api/src/db/migrations/005_rls_enable_and_policies.sql`
- Create: `api/src/services/sysAdminDeleteGuards.js`
- Modify: `api/src/routes/buildings.js`
- Modify: `api/src/routes/apartments.js`
- Modify: `api/src/routes/settings.js`
- Modify: `api/src/routes/zalo-groups.js`
- Test: `api/test/sysAdminDeleteRealEstateAndConfig.test.js`

**Interfaces:**
- Produces in `api/src/services/sysAdminDeleteGuards.js`:
  - `VALID_SYSTEM_SETTING_KEYS: string[]` (`['billing_config', 'sla_config', 'contact_config', 'approval_config', 'reservation_cancel_policy', 'ai_config']`)
  - `DEFAULT_SYSTEM_SETTINGS: Record<string, object>`
  - `checkBuildingEmptyForDelete(queryable, buildingId: string): Promise<{ empty: boolean, counts: Record<string, number> }>`
  - `checkApartmentHistoryForDelete(queryable, apartmentId: string): Promise<{ hasHistory: boolean, reason?: string }>`
  - `checkTenantHistoryForDelete(queryable, opts: { tenantId: string, orgId: string, phone?: string | null }): Promise<{ hasHistory: boolean, reason?: string }>`
  - `checkUserHistoryForDelete(queryable, opts: { userId: string, personId: string, orgId: string, phone?: string | null, roleCodes?: string[] }): Promise<{ hasHistory: boolean, reason?: string }>`
  - `cleanupOrphanedPersonInTx(client, opts: { personId: string, orgId: string, allowAutoDeletePureResidentUser?: boolean }): Promise<{ personDeleted: boolean, residentUserDeleted: boolean, ownerDeleted: boolean, deletedPaths: string[] }>`
  - `unlinkStoragePathsBestEffort(storagePaths: string[]): Promise<void>`
- Produces HTTP endpoints:
  - `DELETE /api/v1/buildings/:id` (updated guard)
  - `DELETE /api/v1/apartments/:id` (updated org-check + history guard)
  - `DELETE /api/v1/settings/:key` → `200 { message, key, default_value, data, items, ai_runtime }`
  - `POST /api/v1/zalo-groups`, `PUT /api/v1/zalo-groups/:id` (allows `SYS_ADMIN` + `MANAGER`), `DELETE /api/v1/zalo-groups/:id` (allows `SYS_ADMIN` only → `200 { message, data }`)

- [ ] **Step 1: Write the failing integration test in `api/test/sysAdminDeleteRealEstateAndConfig.test.js`**
  Kiểm tra trên PostgreSQL RLS thật (`resihub_app`):
  1. `DELETE /api/v1/apartments/:id`: căn hộ không thuộc `org` trả `404`; `MANAGER` gọi trả `403 DELETE_PROHIBITED`; căn hộ mới tạo đã có 2 công tơ `meter` mặc định (`0` `meter_reading`) được `SYS_ADMIN` xóa sạch (`200` + `audit_log`); căn hộ có `meter_reading` hoặc `invoice` bị chặn `409 APARTMENT_HAS_HISTORY`.
  2. `DELETE /api/v1/buildings/:id`: tòa có `ai_suggestion` hoặc `service_catalog` riêng bị chặn `400 BUILDING_NOT_EMPTY`; sau khi dọn hết phụ thuộc thì `SYS_ADMIN` xóa thành công (`200`).
  3. `DELETE /api/v1/buildings/:id/floors/:floor_id`: `MANAGER` gọi bị chặn `403 DELETE_PROHIBITED` (cả ở tầng route lẫn RLS); `SYS_ADMIN` xóa tầng trống thành công (`200`).
  4. `DELETE /api/v1/settings/:key`: `MANAGER` bị chặn `403`; khóa lạ trả `400 INVALID_SETTING_KEY`; `SYS_ADMIN` tùy chỉnh `sla_config` rồi gọi `DELETE /api/v1/settings/sla_config` → `200`, xóa dòng tùy chỉnh trong DB, trả về `default_value` khớp chuẩn và ghi `audit_log` `RESET_SETTING`.
  5. `zalo-groups`: `SYS_ADMIN` tạo (`POST 201`) và sửa (`PUT 200`) nhóm Zalo thành công dưới RLS; `MANAGER` gọi `DELETE /api/v1/zalo-groups/:id` bị chặn `403 DELETE_PROHIBITED` + `logAccessDenied`; `SYS_ADMIN` gọi `DELETE` thành công (`200` + `audit_log`).

- [ ] **Step 2: Run integration test to verify RED**
  Run (in `d:\resihub\api`): `node --test test/sysAdminDeleteRealEstateAndConfig.test.js`
  Expected: FAIL (`404` trên `DELETE /api/v1/settings/:key` và `DELETE /api/v1/zalo-groups/:id`, `403` khi `SYS_ADMIN` `POST /api/v1/zalo-groups`).

- [ ] **Step 3: Update `005_rls_enable_and_policies.sql`, apply via `node src/db/migrate.js`, and implement `sysAdminDeleteGuards.js` + routes (`buildings.js`, `apartments.js`, `settings.js`, `zalo-groups.js`)**
  Áp dụng chính sách RLS trong `005` vào DB, cài đặt đầy đủ `sysAdminDeleteGuards.js` (dùng chung cho cả Task 1 & Task 2) và cập nhật 4 file route của Phân hệ 1 & 4.

- [ ] **Step 4: Launch integration test asynchronously to verify GREEN while starting Task 2**
  Run async (`WaitMsBeforeAsync: 500`, in `d:\resihub\api`): `node --test test/sysAdminDeleteRealEstateAndConfig.test.js`
  Expected: PASS toàn bộ test cases (kiểm tra kết quả ngay khi background task báo hoàn tất trong lúc đang viết Task 2).

---

### Task 2: Backend Phân hệ 2 (Cư dân & Ảnh CCCD) & Phân hệ 3 (Người dùng & Phân quyền)

**Files:**
- Modify: `api/src/routes/tenants.js`
- Modify: `api/src/routes/admin/users.js`
- Test: `api/test/sysAdminDeleteTenantsAndUsers.test.js`

**Interfaces:**
- Consumes: `checkTenantHistoryForDelete`, `checkUserHistoryForDelete`, `cleanupOrphanedPersonInTx`, `unlinkStoragePathsBestEffort` từ `api/src/services/sysAdminDeleteGuards.js`.
- Produces HTTP endpoints:
  - `DELETE /api/v1/tenants/:id` → `200 { message, data, person_deleted, resident_user_deleted }`
  - `DELETE /api/v1/tenants/:id/id-images/:attachment_id` → `200 { message, attachment_id }`
  - `DELETE /api/v1/admin/users/:id` → `200 { message, data, person_deleted, owner_deleted }`
  - `PATCH /api/v1/admin/users/:id` (updated guard: `409 SELF_ROLE_REMOVAL_PROHIBITED` / `LAST_SYS_ADMIN_PROHIBITED`)

- [ ] **Step 1: Write the failing integration test in `api/test/sysAdminDeleteTenantsAndUsers.test.js`**
  Kiểm tra đầy đủ các tình huống thực tế:
  1. **Cư dân & Ảnh CCCD (`tenants`):**
     - `MANAGER` gọi `DELETE /api/v1/tenants/:id` hoặc `DELETE /api/v1/tenants/:id/id-images/:attId` bị chặn `403 DELETE_PROHIBITED` + `logAccessDenied`.
     - Tạo cư dân mới qua `POST /api/v1/tenants` (tự sinh kèm `app_user(RESIDENT)`), tải lên 1 ảnh CCCD → `SYS_ADMIN` xóa ảnh CCCD (`200`, mất khỏi `GET /:id/id-images` + ghi `audit_log`), sau đó `SYS_ADMIN` xóa cư dân (`200`, `person_deleted: true`, `resident_user_deleted: true`) → tạo lại cư dân mới cùng SĐT + CCCD thành công `201` (không lỗi trùng).
     - Cư dân có `reservation` cùng SĐT hoặc có `contract` bị chặn `409 TENANT_HAS_HISTORY`.
     - Nhân sự nội bộ (`MANAGER`) đồng thời có dòng `tenant` nháp: xóa `tenant` thành công nhưng giữ nguyên `app_user(MANAGER)` và `person` (`person_deleted: false`).
  2. **Người dùng & Phân quyền (`admin/users`):**
     - `MANAGER` gọi `DELETE /api/v1/admin/users/:id` bị chặn `403`.
     - `SYS_ADMIN` tự xóa chính mình → `409 SELF_DELETE_PROHIBITED`; tự gỡ role `SYS_ADMIN` của chính mình qua `PATCH` → `409`.
     - Tạo tài khoản `OWNER` mới qua `POST /api/v1/admin/users` (tự sinh dòng `owner`): khi chưa gán tòa, `SYS_ADMIN` xóa thành công (`200`, `owner_deleted: true`, `person_deleted: true`), tạo lại cùng Email/SĐT thành công `201`; khi đã gán vào `building.owner_id` hoặc đã có dòng trong `audit_log` (`actor_id`), xóa bị chặn `409 USER_HAS_HISTORY`.

- [ ] **Step 2: Run integration test to verify RED**
  Run (in `d:\resihub\api`): `node --test test/sysAdminDeleteTenantsAndUsers.test.js`
  Expected: FAIL (`404` trên `DELETE /api/v1/tenants/:id` và `DELETE /api/v1/admin/users/:id`).

- [ ] **Step 3: Implement `DELETE` endpoints & role guards in `api/src/routes/tenants.js` and `api/src/routes/admin/users.js`**
  Cài đặt các route theo đúng đặc tả trong Spec Mục 5.2.C & 5.2.D, gọi các hàm kiểm tra và dọn `person` từ `sysAdminDeleteGuards.js`.

- [ ] **Step 4: Launch integration test asynchronously to verify GREEN while starting Task 3**
  Run async (`WaitMsBeforeAsync: 500`, in `d:\resihub\api`): `node --test test/sysAdminDeleteTenantsAndUsers.test.js`
  Expected: PASS toàn bộ test cases (kiểm tra kết quả ngay khi hoàn tất trong lúc đang triển khai Task 3).

---

### Task 3: Frontend Permissions, API Services & Real Estate Delete UI (Phân hệ 1)

**Files:**
- Modify: `frontend/src/hooks/usePermission.js`
- Modify: `frontend/src/services/queryCache.js`
- Modify: `frontend/src/services/buildings.service.js`
- Modify: `frontend/src/services/tenants.service.js`
- Modify: `frontend/src/services/users.service.js`
- Modify: `frontend/src/services/announcements.service.js`
- Modify: `frontend/src/pages/admin/buildings/BuildingsPage.jsx`
- Modify: `frontend/src/pages/admin/buildings/BuildingDetailPage.jsx`
- Modify: `frontend/src/pages/admin/buildings/FloorPlanPage.jsx`
- Modify: `frontend/src/pages/admin/apartments/ApartmentDetailPage.jsx`

**Interfaces:**
- Produces in `usePermission()`: `canManageZaloGroups: isSysAdmin || isManager`, `canDeleteZaloGroups: isSysAdmin`
- Produces in services:
  - `tenantsService.remove(id)` & `tenantsService.deleteIdImage(id, attachmentId)`
  - `usersService.remove(id)` & `usersService.resetSetting(key)`
  - `announcementsService.deleteZaloGroup(id)`

- [ ] **Step 1: Update `usePermission.js`, `queryCache.js`, and all 4 Frontend service modules**
  Thêm quyền Zalo Group trong `usePermission.js`, bổ sung liên kết xóa cache chéo `tenants <-> users` và `/api/v1/zalo-groups` trong `queryCache.js`, và thêm các hàm gọi API `DELETE` tương ứng.

- [ ] **Step 2: Wire Delete UI + `ConfirmDialog` for Buildings, Floors, and Apartments**
  - `BuildingsPage.jsx` & `BuildingDetailPage.jsx`: thêm nút **Xóa** cho `canManageBuildings` (chỉ bật khi tòa rỗng `0` khu, `0` tầng, `0` căn; disable kèm `title` giải thích khi có dữ liệu; xóa xong đồng bộ `buildingStore` + `resihub:buildings-updated` + điều hướng `/admin/buildings`).
  - `BuildingDetailPage.jsx` (Danh sách tầng) & `FloorPlanPage.jsx` (thanh tiêu đề mỗi tầng): thêm nút **Xóa tầng** cho `canManageBuildings` khi tầng chưa có căn hộ (`0` căn; disable kèm `title` khi đang có căn hộ).
  - `ApartmentDetailPage.jsx`: thêm nút **Xóa căn hộ** cho `canManageBuildings` (disable khi `OCCUPIED` / `RESERVED`), xác nhận qua `ConfirmDialog`, xóa xong làm mới cache và quay về sơ đồ tầng của tòa nhà.

- [ ] **Step 3: Run `oxlint` asynchronously while starting Task 4**
  Run async (`WaitMsBeforeAsync: 500`, in `d:\resihub\frontend`): `npm run lint`
  Expected: `0` errors.

---

### Task 4: Frontend Delete / Reset UI cho Phân hệ 2 (Cư dân), Phân hệ 3 (Người dùng) & Phân hệ 4 (Cấu hình & Nhóm Zalo)

**Files:**
- Modify: `frontend/src/pages/admin/tenants/TenantsPage.jsx`
- Modify: `frontend/src/pages/admin/tenants/TenantDetailPage.jsx`
- Modify: `frontend/src/pages/admin/users/UsersPage.jsx`
- Modify: `frontend/src/pages/admin/settings/SettingsPage.jsx`
- Modify: `frontend/src/components/settings/AiGatewayConfigCard.jsx`
- Modify: `frontend/src/pages/admin/notifications/NotificationsPage.jsx`

**Interfaces:**
- Consumes: `tenantsService.remove`, `tenantsService.deleteIdImage`, `usersService.remove`, `usersService.resetSetting`, `announcementsService.deleteZaloGroup`, `canManageZaloGroups`, `canDeleteZaloGroups`.

- [ ] **Step 1: Wire Delete Tenant & Delete CCCD Image UI (`TenantsPage.jsx`, `TenantDetailPage.jsx`)**
  Thêm nút **Xóa** / **Xóa hồ sơ** cho `isSysAdmin` (disable kèm tooltip nếu đang có hợp đồng hiệu lực) trên cả trang danh sách và chi tiết cư dân; thêm nút **Xóa ảnh** trên từng thẻ ảnh CCCD đã tải lên tại `TenantDetailPage.jsx` cho `isSysAdmin`, xác nhận qua `ConfirmDialog`.

- [ ] **Step 2: Wire Delete User & Role Removal + Reset System Settings UI (`UsersPage.jsx`, `SettingsPage.jsx`, `AiGatewayConfigCard.jsx`)**
  - Trên `UsersPage.jsx`: thêm nút **Xóa** (`Trash2`, disable với `isSelf`) tại cột Thao tác cho `canManageUsers` kèm `ConfirmDialog`; cho phép gỡ các dòng vai trò thừa trong modal phân quyền.
  - Trên `AiGatewayConfigCard.jsx`, `SettingsPage.jsx` và tab `settings` của `UsersPage.jsx`: thêm nút **"Khôi phục mặc định"** trên từng thẻ cấu hình (`ai_config`, `approval_config`, `billing_config`, `sla_config`, `contact_config`, `reservation_cancel_policy`) cho `SYS_ADMIN`, mở `ConfirmDialog`, gọi `usersService.resetSetting(key)` và cập nhật lại state form về giá trị mặc định ngay lập tức.

- [ ] **Step 3: Wire SYS_ADMIN Manage & Delete Zalo Group UI (`NotificationsPage.jsx`)**
  Đổi điều kiện hiển thị nút Thêm/Chỉnh sửa nhóm Zalo ở tab `zalo_groups` từ `canSendNotifications` sang `canManageZaloGroups`, và thêm nút **Xóa** nhóm Zalo (chỉ hiển thị khi `canDeleteZaloGroups`) kèm `ConfirmDialog`.

---

### Task 5: Kiểm thử Hồi quy Toàn diện & Build Production

**Files:**
- Verify: `api/test/*.test.js`
- Verify: `frontend/src/**`

- [ ] **Step 1: Run Frontend `oxlint` & `vite build` alongside Backend regression tests**
  - Run in `d:\resihub\frontend`: `npm run lint && npm run build` → Expected: exit code `0`.
  - Run in `d:\resihub\api`: `node --test test/sysAdminDeleteRealEstateAndConfig.test.js test/sysAdminDeleteTenantsAndUsers.test.js` cùng bộ test RBAC/tòa nhà/cư dân liên quan (`npm test`) → Expected: `0` failures.
