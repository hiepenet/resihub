# Bulk Floor Creation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cho phép `SYS_ADMIN` và `MANAGER` khởi tạo hàng loạt tầng theo dải tầng có xem trước, tùy chỉnh tên/loại trừ tầng đặc thù và lưu nguyên tử qua RLS kèm `audit_log`.

**Architecture:** Tách logic sinh dải tầng, đặt tên mặc định và chuẩn hóa/kiểm tra trùng lặp vào service thuần `api/src/services/floorBulk.js`. Endpoint `POST /api/v1/buildings/:id/floors/bulk` trong `api/src/routes/buildings.js` kiểm tra RBAC tòa nhà, hỗ trợ `dry_run` và `skip_existing`, chèn toàn bộ tầng mới trong một transaction `getUserClient(req)` và ghi `audit_log` cho từng tầng. Ở frontend, component `FloorModal.jsx` gom 2 tab **Từng tầng** và **Hàng loạt** với bảng xem trước tương tác, tích hợp vào cả `FloorPlanPage.jsx` và `BuildingDetailPage.jsx`.

**Tech Stack:** Node.js (ESM), Express 4, PostgreSQL 16 (`FORCE ROW LEVEL SECURITY` + `getUserClient`), `node:test`, React 19, TailwindCSS, Vite, Oxlint.

**Spec:** `docs/superpowers/specs/2026-11-09-bulk-floor-creation-design.md`

## Global Constraints

- **RBAC (PRD Mục 6.2 & AC-019.1):** `SYS_ADMIN` tạo trên mọi tòa thuộc `org_id`; `MANAGER` chỉ tạo trên tòa được phân công (`checkBuildingAccess(req, id, 'create')`); `OWNER` và `RESIDENT` bị chặn `403` qua `requireRole(['SYS_ADMIN', 'MANAGER'])`. Mọi truy cập trái phép ghi `logAccessDenied`. Kiểm tra tồn tại/quyền tòa nhà trước khi kiểm tra payload.
- **Giới hạn dữ liệu:** Mỗi lần tạo `1..100` tầng; `level` là số nguyên chặt chẽ trong khoảng `-10..200` (từ chối số thực như `3.5`, chuỗi rỗng, boolean); `name` tối đa `100` ký tự; không chấp nhận trùng `level` ngay trong cùng payload (`422 DUPLICATE_LEVEL_IN_PAYLOAD`).
- **Quy tắc đặt tên mặc định:** `level < 0` → `Tầng hầm B${Math.abs(level)}`; `level === 0` → `Tầng Trệt`; `level > 0` → `${prefix} ${level}` (hoặc `${prefix}${level}` nếu tiền tố kết thúc bằng `-`, `_`, `/`, `.`; mặc định `Tầng ${level}`).
- **All-or-nothing & Audit:** Lưu trong một transaction `BEGIN ... COMMIT` qua `getUserClient(req)`; ghi 1 dòng `audit_log` (`action = 'CREATE'`, `entity = 'floor'`, `actor_id = req.user.sub`, `after = JSON.stringify(row)`) cho mỗi tầng được tạo.
- **Xử lý trùng DB (`UNIQUE (building_id, level)`):** Mặc định `skip_existing = false` trả `409 FLOOR_EXISTS` kèm `conflicts` và không ghi dòng nào; khi `skip_existing = true` thì lọc bỏ các tầng đã có, trả kèm danh sách `skipped`, chỉ chèn tầng mới (nếu tất cả đều đã tồn tại thì trả `200` với `created_count: 0`).
- **Tương thích ngược:** Không tạo migration mới; giữ nguyên hành vi `POST /api/v1/buildings/:id/floors`.

## Review Focus

1. **Số tầng không nguyên hoặc giả số (`"2.5"`, `true`, `""`, `null`):** `parseInt("2.5", 10)` dễ nuốt thành `2`; bộ chuẩn hóa phải kiểm tra số nguyên chặt chẽ và trả `422 VALIDATION_ERROR`. Đã ghim test trong Task 1.
2. **Dải âm sang dương bỏ tầng `0` chỉ còn 0 tầng hợp lệ (VD: `from_level = 0, to_level = 0, include_zero = false`):** Phải trả lỗi `422 VALIDATION_ERROR` thay vì mảng rỗng âm thầm. Đã ghim test trong Task 1.
3. **MANAGER gửi request vào tòa không được gán kèm payload lỗi:** Phải trả `403 ACCESS_DENIED` trước khi lộ lỗi `422` hay thông tin tầng tồn tại (AC-019.1). Đã ghim test trong Task 2.
4. **`dry_run: true` không ghi DB & không ghi `audit_log`:** Tổng số tầng và `audit_log` trước/sau `dry_run` phải giữ nguyên tuyệt đối. Đã ghim test trong Task 2.
5. **Tất cả các tầng trong dải đều đã tồn tại khi bật `skip_existing: true`:** API phải trả `200` (`created_count: 0`, `skipped_count: N`) mà không lỗi SQL rỗng, và nút submit trên UI bị vô hiệu hóa khi số tầng mới được chọn bằng `0`. Đã ghim test trong Task 2 và logic UI ở Task 3.

---

## File Structure

- **Create:** `api/src/services/floorBulk.js` — hàm thuần đặt tên mặc định, bung dải tầng và kiểm tra/chuẩn hóa payload bulk.
- **Create:** `api/test/floorBulk.test.js` — unit test `node:test` cho `floorBulk.js`.
- **Modify:** `api/src/routes/buildings.js` — thêm `POST /:id/floors/bulk` và dùng chung `defaultFloorName` cho `POST /:id/floors`.
- **Create:** `api/test/floorBulkCreate.test.js` — integration test kiểm chứng RBAC, `dry_run`, trùng tầng, `skip_existing`, transaction + `audit_log` trên PostgreSQL RLS thật.
- **Modify:** `frontend/src/services/buildings.service.js` — thêm `previewFloorsBulk` và `createFloorsBulk`.
- **Create:** `frontend/src/pages/admin/buildings/FloorModal.jsx` — modal 2 tab (**Từng tầng** / **Hàng loạt**) với gợi ý dải nối tiếp, bỏ tầng `0`, bỏ qua tầng cũ, tick/bỏ tick từng dòng và sửa tên riêng từng tầng.
- **Modify:** `frontend/src/pages/admin/buildings/FloorPlanPage.jsx` — thay modal đơn cũ bằng `FloorModal`, thêm CTA trên `EmptyState`, thêm callback `onFloorsChanged`.
- **Modify:** `frontend/src/pages/admin/buildings/BuildingDetailPage.jsx` — đồng bộ `onFloorsChanged` cho `Quy mô tầng` và thêm nút mở `FloorModal` tại thẻ Danh sách tầng (tab Khu).

---

### Task 1: Pure Floor-Range Generator & Validator

**Files:**
- Create: `api/src/services/floorBulk.js`
- Test: `api/test/floorBulk.test.js`

**Interfaces:**
- Produces:
  - `defaultFloorName(level: number, namePrefix?: string): string`
  - `expandFloorRange(opts: { fromLevel: unknown, toLevel: unknown, includeZero?: boolean, namePrefix?: string }): { ok: true, floors: Array<{ level: number, name: string }> } | { ok: false, code: string, message: string }`
  - `validateAndNormalizeBulkFloors(body: { floors?: Array<{ level: unknown, name?: unknown }>, from_level?: unknown, to_level?: unknown, include_zero?: boolean, name_prefix?: string }): { ok: true, drafts: Array<{ level: number, name: string }> } | { ok: false, code: string, message: string, conflicts?: Array<{ level: number }> }`

- [ ] **Step 1: Write the failing unit tests in `api/test/floorBulk.test.js`**
  Cover: `defaultFloorName` (hầm âm, trệt `0`, tầng dương với `"Tầng"`, `"Tầng "`, `"Lầu"`, `"F-"`), `expandFloorRange` (`-2..3` với `includeZero: false` và `includeZero: true`, lỗi `from > to`, vượt `-10..200`, vượt `100` tầng, `0..0` kèm `includeZero: false`), và `validateAndNormalizeBulkFloors` (chuẩn hóa mảng `floors`, giữ tên tùy chỉnh như `Tầng 12A`, phát hiện `DUPLICATE_LEVEL_IN_PAYLOAD`, từ chối `"2.5"` / `true` / `""` / tên quá `100` ký tự).

- [ ] **Step 2: Run unit test to verify RED**
  Run: `node --test api/test/floorBulk.test.js`
  Expected: FAIL (`ERR_MODULE_NOT_FOUND` cho `../src/services/floorBulk.js`).

- [ ] **Step 3: Implement `api/src/services/floorBulk.js`**
  Viết hàm thuần không phụ thuộc DB/Express đáp ứng đúng chữ ký và các ràng buộc trong Global Constraints.

- [ ] **Step 4: Run unit test to verify GREEN**
  Run: `node --test api/test/floorBulk.test.js`
  Expected: PASS toàn bộ test cases.

---

### Task 2: Bulk Floor Creation API Endpoint & RLS Integration Tests

**Files:**
- Modify: `api/src/routes/buildings.js`
- Test: `api/test/floorBulkCreate.test.js`

**Interfaces:**
- Consumes: `defaultFloorName`, `validateAndNormalizeBulkFloors` từ `api/src/services/floorBulk.js`.
- Produces:
  - `POST /api/v1/buildings/:id/floors/bulk`
    - Request body: `{ floors?: Array<{ level: number, name?: string }>, from_level?: number, to_level?: number, include_zero?: boolean, name_prefix?: string, skip_existing?: boolean, dry_run?: boolean }`
    - `dry_run: true` → `200 { data, conflicts, skipped, total, valid }`
    - `dry_run: false` (conflict & `!skip_existing`) → `409 { code: 'FLOOR_EXISTS', message, conflicts }`
    - `dry_run: false` (success, `created_count > 0`) → `201 { message, created_count, skipped_count, skipped, data }`
    - `dry_run: false` (`skip_existing: true` & tất cả đều đã có) → `200 { message, created_count: 0, skipped_count, skipped, data: [] }`

- [ ] **Step 1: Write the failing integration test in `api/test/floorBulkCreate.test.js`**
  Khởi tạo tòa nhà tạm thời trong `t.before` và dọn sạch trong `t.after` qua `adminPool`; mount `buildingsRoute` lên `http.Server` cổng động (`0`) với `JWT_SECRET` từ `../src/config/env.js`. Kiểm tra:
  1. `OWNER` gọi bị chặn `403`; `MANAGER` tòa khác gọi bị chặn `403 ACCESS_DENIED` (kể cả khi gửi payload rỗng) và có `audit_log` `ACCESS_DENIED`.
  2. Tòa không tồn tại trả `404`.
  3. Payload trùng `level` trả `422 DUPLICATE_LEVEL_IN_PAYLOAD`.
  4. `dry_run: true` trả đúng danh sách xem trước + `valid: true` mà DB vẫn `0` tầng và `0` `audit_log` `CREATE`.
  5. `MANAGER` được gán tòa gọi commit tạo dải `-1..3` (bỏ tầng `0`, đổi tên tầng `3` thành `Tầng 3A`) → `201`, tạo đúng `4` tầng theo thứ tự `level ASC` và `4` dòng `audit_log` (`entity = 'floor'`, `action = 'CREATE'`).
  6. Gọi lại dải `1..5` với `skip_existing: false` → `409 FLOOR_EXISTS` kèm `conflicts` (`1, 2, 3`), tổng số tầng trong DB giữ nguyên `4` (all-or-nothing).
  7. Gọi dải `1..5` với `skip_existing: true` → `201`, `created_count: 2` (tầng `4, 5`), `skipped_count: 3`; gọi tiếp một lần nữa với `skip_existing: true` → `200`, `created_count: 0`, `skipped_count: 5`.

- [ ] **Step 2: Run integration test to verify RED**
  Run: `node --test api/test/floorBulkCreate.test.js`
  Expected: FAIL (`404` vì chưa có route `POST /:id/floors/bulk`).

- [ ] **Step 3: Implement `POST /:id/floors/bulk` in `api/src/routes/buildings.js`**
  Đặt route trước `POST /:id/floors`, kiểm tra `checkBuildingAccess(req, id, 'create')`, gọi `validateAndNormalizeBulkFloors`, đối chiếu tầng hiện hữu, hỗ trợ `dry_run` & `skip_existing`, thực thi `INSERT` nhiều dòng + ghi `audit_log` trong một transaction `getUserClient(req)`. Đồng thời dùng `defaultFloorName` cho `POST /:id/floors`.

- [ ] **Step 4: Run integration test to verify GREEN (overlap with Task 3 implementation while running)**
  Run: `node --test api/test/floorBulkCreate.test.js`
  Expected: PASS toàn bộ test cases.

---

### Task 3: Frontend Two-Mode `FloorModal` & Page Wiring

**Files:**
- Modify: `frontend/src/services/buildings.service.js`
- Create: `frontend/src/pages/admin/buildings/FloorModal.jsx`
- Modify: `frontend/src/pages/admin/buildings/FloorPlanPage.jsx`
- Modify: `frontend/src/pages/admin/buildings/BuildingDetailPage.jsx`

**Interfaces:**
- Consumes: `POST /api/v1/buildings/:id/floors` và `POST /api/v1/buildings/:id/floors/bulk`.
- Produces:
  - `buildingsService.previewFloorsBulk(id, payload)`
  - `buildingsService.createFloorsBulk(id, payload)`
  - `<FloorModal open={boolean} onClose={() => void} buildingId={string} existingFloors={Array<{ id, level, name }>} initialMode={'single' | 'bulk'} onCreated={(res) => void} />`

- [ ] **Step 1: Add `previewFloorsBulk` and `createFloorsBulk` in `frontend/src/services/buildings.service.js`**
  Gọi `POST /api/v1/buildings/${id}/floors/bulk` với `dry_run: true` và `dry_run: false`.

- [ ] **Step 2: Create `frontend/src/pages/admin/buildings/FloorModal.jsx`**
  Hỗ trợ 2 tab **Thêm hàng loạt** và **Từng tầng**:
  - Tự gợi ý `1 → 5` khi tòa chưa có tầng, hoặc `(maxLevel + 1) → (maxLevel + 5)` khi tòa đã có tầng.
  - Hỗ trợ đổi tiền tố tên tầng dương, checkbox **Bao gồm Tầng Trệt (0)** (tự tắt khi `from < 0 && to > 0`), checkbox **Tự động bỏ qua tầng đã tồn tại** (mặc định bật).
  - Bảng xem trước cho phép tick/bỏ tick từng tầng, sửa tên hiển thị từng tầng (giữ tên đã sửa khi đổi lựa chọn khác), hiển thị rõ trạng thái xung đột/bỏ qua và tổng số tầng mới sẽ tạo.
  - Phát sự kiện `window.dispatchEvent(new Event('resihub:buildings-updated'))` sau khi tạo thành công.

- [ ] **Step 3: Wire `FloorModal` into `FloorPlanPage.jsx` and `BuildingDetailPage.jsx`**
  - `FloorPlanPage.jsx`: thay modal thêm tầng đơn cũ bằng `FloorModal`, thêm nút **Thêm tầng hàng loạt** & **Thêm từng tầng** ngay trong `EmptyState` khi tòa chưa có tầng, gọi `loadFloorPlan({ force: true })` và `onFloorsChanged?.()` sau khi tạo.
  - `BuildingDetailPage.jsx`: truyền `onFloorsChanged={() => loadBuildingData({ force: true })}` xuống `FloorPlanView` để cập nhật ngay chỉ số **Quy mô tầng**, đồng thời hiển thị thẻ **Danh sách tầng** kèm nút **Thêm tầng** (mở thẳng tab hàng loạt hoặc đơn lẻ) trong tab **Danh sách Khu**.

- [ ] **Step 4: Verify Frontend Lint & Production Build + Full Backend Test Suite**
  Run: `npm --prefix frontend run lint && npm --prefix frontend run build` and `npm --prefix api test`
  Expected: `0` lỗi lint, Vite build thành công (`exit 0`), và toàn bộ test suite API xanh.

