# Fix M03/M04 Business Logic — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sửa toàn bộ lỗi sai nghiệp vụ nhóm A và bổ sung chức năng nhóm B trong `Bao_Cao_Review_Nghiep_Vu_M03_M04.md`, mỗi lỗi một commit nhỏ.

**Architecture:** Thêm 1 module guard máy trạng thái thuần (pure function, test bằng `node:test`) dùng chung cho POST/PATCH căn hộ; sửa các route `contracts.js`/`apartments.js`/`tenants.js`/`buildings.js` theo guard; hợp đồng chuyển sang vòng đời đầy đủ DRAFT → kích hoạt (ký bản giấy, lưu bản scan) → ACTIVE; thêm bảng `zone` (Khu/Block) vào cây cấu trúc; 4 migration SQL nhỏ; 1 job hằng ngày in-process; bổ sung UI trên `BuildingsPage.jsx`, `TenantsPage.jsx`, `ContractsPage.jsx`, `ResidentPortalPage.jsx` theo đúng pattern hiện có.

**Tech Stack:** Node 22 (ESM) + Express 4 + pg; React 19 + Vite; PostgreSQL 16; test: `node:test` built-in (không thêm framework); verification API bằng curl + psql trên docker-compose.dev.

**Spec:** `D:\resihub\Bao_Cao_Review_Nghiep_Vu_M03_M04.md` (các mục A1–A9, B1–B9, C1–C4, C7) + `PRD - Quan ly Can ho va Nha cho thue v2.0.md` (FR-007, FR-008, FR-010, FR-012, FR-014, FR-018, FR-021, FR-067, mục 7.5, 13.3, 16.4).

## Global Constraints

- Tiền: BIGINT đơn vị VND, không float (PRD 13.4).
- Không xóa cứng bản ghi nghiệp vụ; hủy = đổi trạng thái + lý do (NFR-016).
- Mọi thay đổi dữ liệu ghi `audit_log` (actor_id, action, entity, entity_id, before, after) — dùng pattern có sẵn trong `apartments.js:115-119, 178-182`.
- Transaction ghi DB: dùng `getUserClient(req)` + BEGIN/COMMIT/ROLLBACK (RLS-bound); job chạy nền không có user context **phải dùng `adminPool`** (RLS default-deny sẽ chặn im lặng nếu dùng appPool).
- Lỗi API trả `{code, message}` bằng tiếng Việt, khớp style hiện có.
- Commit message theo convention repo: `fix(api): ...`, `feat(api,ui): ...`, `fix(db): ...` (xem `git log`).
- Không thêm dependency mới (không multer, không node-cron, không jest).
- Mọi query route đi qua `pool` (proxy RLS context) hoặc `getUserClient`; KHÔNG dùng `adminPool` trong route.

## Review Focus

Các rủi ro mà test của từng task phải ghim lại:

1. **Căn OCCUPIED còn HĐ ACTIVE bị đổi trạng thái tùy tiện** → mong đợi: 409, chỉ có terminate mới rời OCCUPIED (Task 3).
2. **2 request tạo hợp đồng đồng thời trên cùng căn** → exclusion constraint ở DB chặn (lỗi 23P01), không chỉ check ở ứng dụng (Task 4).
3. **Kích hoạt HĐ với start_date tương lai** → căn giữ RESERVED, job hằng ngày mới flip OCCUPIED; không flip ngay (Task 8, 9).
4. **Job chạy không có user context** → nếu đi qua appPool, RLS chặn 0 dòng im lặng; phải dùng adminPool (Task 9).
5. **CCCD trùng nhưng SĐT khác** → 409 chặn, không tạo person trùng; không tự ý reuse person khi tenant primary đã tồn tại (Task 11).
6. **Kích hoạt HĐ khi căn không còn AVAILABLE/RESERVED** (ai đó ký HĐ khác trước) → activate chặn 409, DRAFT không tự ăn căn (Task 8).
7. **HĐ DRAFT bị sửa sau khi ACTIVE** → PATCH chặn, chỉ phụ lục (PRD 490) (Task 7).
8. **PATCH trực tiếp target OCCUPIED/RESERVED** lách luồng HĐ/giữ chỗ → 409 `DIRECT_STATUS_CHANGE_PROHIBITED`; chỉ AVAILABLE ↔ MAINTENANCE ↔ INACTIVE được đổi tay (Task 3).
9. **Job/hành động flip căn RESERVED** (hết hạn giữ chỗ, forfeit, refund) phải NOT EXISTS kiểm không còn HELD mới/HĐ ghim — nếu không flip nhầm căn đang booked (Task 9).

**Quyết định mặc định đã chốt trong kế hoạch (đổi ý → nói trước khi thực hiện):**
- Ngưỡng "giá lệch khung" của PRD 486 chưa được chủ đầu tư chốt → hard-code **10%** so với `apartment.base_rent`, kèm `ponytail:` comment; tách config khi có quyết định chính thức (PRD mục 23).
- C9 (export khai báo tạm trú) loại khỏi kế hoạch — PRD ghi "cần xác nhận yêu cầu cụ thể".

---

### Task 1: Module máy trạng thái căn hộ (A2 — lõi)

**Files:**
- Create: `api/src/services/apartmentStatus.js`
- Create: `api/test/apartmentStatus.test.js`
- Modify: `api/package.json` (thêm `"test": "node --test test/"` vào scripts)

**Interfaces:**
- Produces: `APARTMENT_STATUSES: string[]`, `APARTMENT_TRANSITIONS: Record<string, string[]>`, `isTransitionAllowed(from: string, to: string): boolean` — Task 3, 6, 8 import từ đây.

- [ ] **Step 1: Write the failing test** `api/test/apartmentStatus.test.js`

```js
import { test } from 'node:test';
import assert from 'node:assert';
import { isTransitionAllowed, APARTMENT_TRANSITIONS, APARTMENT_STATUSES } from '../src/services/apartmentStatus.js';

test('AVAILABLE -> RESERVED/OCCUPIED/MAINTENANCE/INACTIVE hợp lệ', () => {
  for (const to of ['RESERVED', 'OCCUPIED', 'MAINTENANCE', 'INACTIVE']) {
    assert.equal(isTransitionAllowed('AVAILABLE', to), true);
  }
});
test('OCCUPIED chỉ được sang MAINTENANCE (rời OCCUPIED phải qua terminate)', () => {
  assert.equal(isTransitionAllowed('OCCUPIED', 'MAINTENANCE'), true);
  assert.equal(isTransitionAllowed('OCCUPIED', 'AVAILABLE'), false);
  assert.equal(isTransitionAllowed('OCCUPIED', 'INACTIVE'), false);
});
test('RESERVED -> AVAILABLE/OCCUPIED, không sang MAINTENANCE/INACTIVE', () => {
  assert.equal(isTransitionAllowed('RESERVED', 'AVAILABLE'), true);
  assert.equal(isTransitionAllowed('RESERVED', 'OCCUPIED'), true);
  assert.equal(isTransitionAllowed('RESERVED', 'MAINTENANCE'), false);
});
test('MAINTENANCE -> AVAILABLE/INACTIVE; INACTIVE -> AVAILABLE', () => {
  assert.equal(isTransitionAllowed('MAINTENANCE', 'AVAILABLE'), true);
  assert.equal(isTransitionAllowed('MAINTENANCE', 'INACTIVE'), true);
  assert.equal(isTransitionAllowed('INACTIVE', 'AVAILABLE'), true);
  assert.equal(isTransitionAllowed('INACTIVE', 'MAINTENANCE'), false);
});
test('no-op (to === from) và status lạ trả false', () => {
  assert.equal(isTransitionAllowed('AVAILABLE', 'AVAILABLE'), false);
  assert.equal(isTransitionAllowed('AVAILABLE', 'XYZ'), false);
});
test('đủ 5 trạng thái chuẩn FR-008', () => {
  assert.deepEqual(APARTMENT_STATUSES, ['AVAILABLE', 'RESERVED', 'OCCUPIED', 'MAINTENANCE', 'INACTIVE']);
  assert.deepEqual(Object.keys(APARTMENT_TRANSITIONS).sort(), [...APARTMENT_STATUSES].sort());
});
```

- [ ] **Step 2: Run test to verify it fails** — Run: `node --test api/test/` (chạy từ `D:\resihub`, dùng node ≥ 20). Expected: FAIL (module không tồn tại).
- [ ] **Step 3: Implement** `api/src/services/apartmentStatus.js` — export 3 hằng/hàm theo Interfaces; `APARTMENT_TRANSITIONS` như test; `isTransitionAllowed = (from, to) => from !== to && Boolean(APARTMENT_TRANSITIONS[from]?.includes(to))`. Thêm script `"test": "node --test test/"`.
- [ ] **Step 4: Run test to verify it passes** — Run: `npm test --prefix api`. Expected: PASS 6 test.
- [ ] **Step 5: Commit**

```bash
git add api/src/services/apartmentStatus.js api/test/apartmentStatus.test.js api/package.json
git commit -m "feat(api): them state machine guard cho trang thai can ho (A2)"
```

### Task 2: POST /apartments hardening (B4)

**Files:**
- Modify: `api/src/routes/apartments.js:72-129` (POST)

**Interfaces:**
- Consumes: không (guard nội tuyến trong route).
- Produces: lỗi mới `FLOOR_MISMATCH` (400).

- [ ] **Step 1: Sửa route POST** — (a) bỏ `status` khỏi danh sách field nhận từ client, hard-code `'AVAILABLE'` trong INSERT; (b) nếu có `floor_id`: query `SELECT 1 FROM floor WHERE id = $1 AND building_id = $2` → 0 dòng trả `400 {code:'FLOOR_MISMATCH', message:'Tầng không thuộc tòa nhà này.'}`; (c) `base_rent < 0` đã có, giữ. (Guard `zone_id` làm ở Task 12 — bảng zone chưa tồn tại ở task này, nhưng đã chốt trước mã lỗi `ZONE_MISMATCH` để nhất quán.)
- [ ] **Step 2: Verify** — chạy `docker compose -f docker-compose.dev.yml up -d` → `npm run migrate --prefix api && npm run seed --prefix api`; login: `curl -s -X POST localhost:3000/api/v1/auth/login -H "Content-Type: application/json" -d '{"email":"manager@resihub.vn","password":"password123"}'` → lấy token; tạo căn với floor_id của tòa khác → 400 FLOOR_MISMATCH; với payload `status:'OCCUPIED'` → DB vẫn là AVAILABLE (`psql -c "SELECT code,status FROM apartment ORDER BY created_at DESC LIMIT 1"`).
- [ ] **Step 3: Commit**

```bash
git add api/src/routes/apartments.js
git commit -m "fix(api): validate floor/zone thuoc cung toa + ep status AVAILABLE khi tao can ho (B4)"
```

### Task 3: PATCH /apartments/:id — guard chuyển trạng thái + xác nhận sửa diện tích (A2, A9)

**Files:**
- Modify: `api/src/routes/apartments.js:135-189` (PATCH)

**Interfaces:**
- Consumes: `isTransitionAllowed` (Task 1).
- Produces: lỗi mới `DIRECT_STATUS_CHANGE_PROHIBITED` (409), `INVALID_STATUS_TRANSITION` (409), `AREA_CHANGE_REQUIRES_CONFIRM` (409).

- [ ] **Step 1: Sửa route PATCH** — thứ tự guard trước UPDATE: (1) nếu `status` truyền lên thuộc `('OCCUPIED','RESERVED')` → 409 `DIRECT_STATUS_CHANGE_PROHIBITED` ("Không thể tự ý chuyển sang Đang thuê/Đã đặt cọc — trạng thái này chỉ được cập nhật tự động qua luồng Hợp đồng và Giữ chỗ"); (2) nếu `status` truyền lên và `isTransitionAllowed(before.status, status) === false` → 409 `INVALID_STATUS_TRANSITION` kèm message liệt kê trạng thái được phép — hợp lệ qua PATCH chỉ còn AVAILABLE ↔ MAINTENANCE, AVAILABLE ↔ INACTIVE, MAINTENANCE ↔ INACTIVE; (3) query `SELECT 1 FROM contract WHERE apartment_id = $1 AND status = 'ACTIVE'` — nếu có HĐ ACTIVE: chặn mọi đổi trạng thái (409 `INVALID_STATUS_TRANSITION`, message "Căn đang có hợp đồng hiệu lực, phải chấm dứt hợp đồng trước"), và nếu payload có `area_m2` khác giá trị cũ mà thiếu `confirm_recalculate_fees === true` → 409 `AREA_CHANGE_REQUIRES_CONFIRM`; (4) UPDATE như cũ.
- [ ] **Step 2: Verify** — curl: PATCH căn AVAILABLE `status:'OCCUPIED'` → 409 DIRECT_STATUS_CHANGE_PROHIBITED; PATCH căn OCCUPIED có HĐ ACTIVE với `status:'AVAILABLE'` → 409; PATCH căn AVAILABLE `status:'MAINTENANCE'` → 200; PATCH căn AVAILABLE đang có HĐ ACTIVE (nếu có) sửa `area_m2` không cờ → 409, thêm `confirm_recalculate_fees:true` → 200.
- [ ] **Step 3: Commit**

```bash
git add api/src/routes/apartments.js
git commit -m "fix(api): guard chuyen trang thai can ho + xac nhan sua dien tich khi co HD ACTIVE (A2, A9)"
```

### Task 4: Exclusion constraint + sửa overlap check (A4)

**Files:**
- Create: `api/src/db/migrations/014_contract_exclusion.sql`
- Modify: `api/src/routes/contracts.js:160-175`

**Interfaces:**
- Produces: DB constraint `contract_no_overlap` (lỗi 23P01 khi chèn chồng lấn).

- [ ] **Step 1: Migration** `014_contract_exclusion.sql`

```sql
-- A4: chặn chồng lấn kỳ thuê ở tầng DB (PRD 13.3), btree_gist đã bật ở 001
-- Constraint chỉ ghim bản ghi đã hiệu lực (ACTIVE/RENEWAL_PENDING); DRAFT bị chặn ở tầng app (Task 4, 8)
ALTER TABLE contract DROP CONSTRAINT IF EXISTS contract_no_overlap;
ALTER TABLE contract ADD CONSTRAINT contract_no_overlap
  EXCLUDE USING gist (
    apartment_id WITH =,
    daterange(start_date, end_date, '[)') WITH &&
  )
  WHERE (status IN ('ACTIVE','RENEWAL_PENDING'));
```

- [ ] **Step 2: Sửa overlap check trong POST /contracts** — đổi điều kiện thành half-open khớp constraint: `status IN ('DRAFT','PENDING_APPROVAL','ACTIVE','RENEWAL_PENDING') AND (start_date < $3 AND end_date > $2)` ($2 = start_date mới, $3 = end_date mới) — trả 409 kèm `conflicts` (mã + tên bên thuê HĐ xung đột, PRD 486 "chặn kèm chỉ rõ hợp đồng xung đột").
- [ ] **Step 3: Verify** — `npm run migrate --prefix api`; tạo 2 HĐ chồng lấn trên cùng căn qua curl → lần 2 nhận 409 kèm mã HĐ xung đột; chèn trực tiếp HĐ ACTIVE chồng lấn bằng psql → lỗi 23P01 (constraint chặn); HĐ kết thúc 31/12 + HĐ mới bắt đầu 31/12 → không bị chặn (half-open).
- [ ] **Step 4: Commit**

```bash
git add api/src/db/migrations/014_contract_exclusion.sql api/src/routes/contracts.js
git commit -m "fix(db,api): exclusion constraint chong chong lan ky thue + overlap check dung enum (A4)"
```

### Task 5: Terminate → MAINTENANCE (A1)

**Files:**
- Modify: `api/src/routes/contracts.js:275-279`

- [ ] **Step 1: Sửa** — trong POST `/:id/terminate`, đổi `UPDATE apartment SET status = 'AVAILABLE'` thành `SET status = 'MAINTENANCE'`; sửa message response thành "…Căn hộ chuyển sang trạng thái bảo trì, chờ bàn giao và tất toán cọc.".
- [ ] **Step 2: Verify** — curl terminate 1 HĐ ACTIVE → `SELECT status FROM apartment WHERE id = ...` = 'MAINTENANCE'; sơ đồ tầng hiển thị ô đỏ "Bảo trì".
- [ ] **Step 3: Commit**

```bash
git add api/src/routes/contracts.js
git commit -m "fix(api): terminate chuyen can ho sang MAINTENANCE, AVAILABLE chi sau ban giao (A1)"
```

### Task 6: Handover endpoint + action MAINTENANCE/INACTIVE trong panel (B8, B2)

**Files:**
- Modify: `api/src/routes/apartments.js` (thêm endpoint mới)
- Modify: `frontend/src/pages/admin/buildings/BuildingsPage.jsx` (panel chi tiết, khoảng dòng 713-760)

**Interfaces:**
- Consumes: `isTransitionAllowed` (Task 1).
- Produces: `PATCH /api/v1/apartments/:id/handover` → `{ data: apartment, warnings?: string[] }`.

- [ ] **Step 1: Endpoint handover** — MANAGER-only; load căn + guard: hiện `'MAINTENANCE'` không có → 409 `INVALID_STATUS`; `SELECT 1 FROM contract WHERE apartment_id=$1 AND status='ACTIVE'` → có → 409; deposit `status='HELD'` còn lại → **không chặn**, thêm `warnings: ['Còn cọc đang giữ chưa tất toán']` vào response; `UPDATE apartment SET status='AVAILABLE'`; ghi audit action `'HANDOVER'`.
- [ ] **Step 2: UI panel** — trong `selectedApartment` panel thêm: nếu `status==='MAINTENANCE'` → nút "Xác nhận bàn giao & nghiệm thu phòng" (gọi handover) + nút "Chuyển sang Không kinh doanh" (PATCH status INACTIVE); nếu `status==='INACTIVE'` → nút "Kinh doanh lại" (PATCH status AVAILABLE). ConfirmDialog cho cả 3.
- [ ] **Step 3: Verify** — terminate 1 HĐ (căn về MAINTENANCE theo Task 5) → bấm bàn giao trong panel → căn về AVAILABLE, sơ đồ refresh; căn AVAILABLE → đặt MAINTENANCE → bàn giao lại.
- [ ] **Step 4: Commit**

```bash
git add api/src/routes/apartments.js frontend/src/pages/admin/buildings/BuildingsPage.jsx
git commit -m "feat(api,ui): endpoint ban giao can ho + hanh dong MAINTENANCE/INACTIVE tren so do (B8, B2)"
```

### Task 7: Tạo hợp đồng = DRAFT + sửa nháp (A3 — phần 1)

**Files:**
- Modify: `api/src/routes/contracts.js:113-239` (POST) + thêm PATCH `/:id`
- Modify: `api/src/routes/apartments.js:14-66` (GET — filter status)
- Modify: `frontend/src/pages/admin/contracts/ContractsPage.jsx:77-92` (loadApartments)

**Nghiệp vụ (PRD 485, 489, 490):** bước 5 "lưu DRAFT" — HĐ mới luôn tạo là `DRAFT`; căn hộ **không** đổi trạng thái ở bước này (chỉ đổi khi ACTIVE — Task 8); MANAGER chỉ C/R/U khi DRAFT.

**Interfaces:**
- Produces: POST /contracts → `status='DRAFT'`; `PATCH /api/v1/contracts/:id` (chỉ khi DRAFT); lỗi `CONTRACT_NOT_EDITABLE` (409).
- Consumes: overlap check (Task 4).

- [ ] **Step 1: Đổi POST** — (a) INSERT contract với `status='DRAFT'`; (b) bỏ khối `UPDATE apartment SET status='OCCUPIED'` (dòng 209-212) và khối tạo deposit + convert reservation (chuyển hết xuống Task 8 activate); (c) giữ overlap check + guard căn; (d) response trả contract kèm message "Đã lưu nháp. Tải bản ký, đính kèm bản scan rồi kích hoạt để hoàn tất.".
- [ ] **Step 2: Thêm PATCH /:id** — chỉ cho sửa khi `status='DRAFT'` (ngược lại 409 `CONTRACT_NOT_EDITABLE` — PRD 490 "sau ACTIVE chỉ sửa qua phụ lục"); nhận `{start_date?, end_date?, rent_amount?, billing_cycle?, billing_day?, deposit_amount?, apartment_id?, primary_tenant_id?, finalDeposit?}`; nếu đổi dates hoặc apartment → chạy lại overlap check + guard căn mới AVAILABLE/RESERVED; audit before/after.
- [ ] **Step 3: apartments GET hỗ trợ nhiều status** — đổi param `status` thành `a.status = ANY(string_to_array($n, ','))`, giữ tương thích giá trị đơn.
- [ ] **Step 4: ContractsPage** — `loadApartments` gọi `?status=AVAILABLE,RESERVED`; option label thêm đuôi `(Đã cọc giữ chỗ)` khi `a.status==='RESERVED'`; cột Trạng thái + badge DRAFT/PENDING_APPROVAL (màu xám/vàng); sau tạo → toast "Đã lưu nháp".
- [ ] **Step 5: Verify** — tạo HĐ → status DRAFT, căn vẫn AVAILABLE (psql); PATCH sửa tiền thuê khi DRAFT → 200; cọc giữ chỗ vẫn HELD sau khi tạo DRAFT.
- [ ] **Step 6: Commit**

```bash
git add api/src/routes/contracts.js api/src/routes/apartments.js frontend/src/pages/admin/contracts/ContractsPage.jsx
git commit -m "feat(api,ui): tao hop dong o trang thai DRAFT + sua nhap truoc khi ky (A3)"
```

### Task 8: Kích hoạt hợp đồng — bản ký, điều kiện ACTIVE, chuyển cọc giữ chỗ (A3 — phần 2, A5)

**Files:**
- Modify: `api/src/routes/contracts.js` (3 endpoint + helper nội bộ)
- Modify: `frontend/src/pages/admin/contracts/ContractsPage.jsx` (nút kích hoạt/hủy/duyệt, upload bản ký)

**Nghiệp vụ (PRD 485, 486, 665 / AC-009.2, 231):**
- DRAFT → ACTIVE khi đủ điều kiện; thiếu điều kiện → chặn và nêu rõ điều kiện còn thiếu.
- Điều kiện chặn ACTIVE: (1) chưa đính kèm bản scan hợp đồng đã ký; (2) primary tenant thiếu CCCD ("thiếu giấy tờ tùy thân → cho lưu DRAFT nhưng chặn ACTIVE"); (3) căn không còn AVAILABLE/RESERVED; (4) chồng lấn kỳ hạn (re-check).
- Giá thuê thấp hơn ≥10% giá niêm yết (`apartment.base_rent`) → không ACTIVE ngay, chuyển `PENDING_APPROVAL`, chờ chủ đầu tư duyệt.
- Khi ACTIVE: cọc giữ chỗ HELD của căn → `CONVERTED`, cọc hợp đồng mở sổ kèm `source_reservation_id` (PRD 231, FR-067); căn → OCCUPIED (start_date ≤ hôm nay) hoặc RESERVED (tương lai).
- Hủy nháp: DRAFT/PENDING_APPROVAL → CANCELLED.

**Interfaces:**
- Produces:
  - `GET /api/v1/attachments/:id/view` (dùng chung cho Task 15) — authenticate → load attachment theo `id` → kiểm quyền theo `owner_entity` (`contract`: join contract→apartment→building qua `checkBuildingAccess`; `person`: `person.org_id` = org của user) + role OWNER/MANAGER → `res.sendFile(storage_path)`; **mỗi lần xem ghi audit `'READ'`** (PRD 17.1). KHÔNG nhận path từ client — chỉ theo id (chống path traversal)
  - `POST /api/v1/contracts/:id/scan` `{image_base64}` → lưu attachment (bản ký HĐ — FR-020)
  - `POST /api/v1/contracts/:id/activate` (MANAGER) → ACTIVE hoặc PENDING_APPROVAL
  - `POST /api/v1/contracts/:id/approve` (OWNER) → PENDING_APPROVAL → ACTIVE
  - `POST /api/v1/contracts/:id/cancel` `{reason}` → CANCELLED
  - Lỗi mới: `MISSING_SIGNED_SCAN`, `MISSING_IDENTITY_PAPER`, `INVALID_APARTMENT_STATUS`, `PRICE_NEEDS_APPROVAL`, `FORBIDDEN_ATTACHMENT`
- Consumes: bảng `attachment` (migration 007, không có RLS — endpoint tự kiểm quyền), `isTransitionAllowed`.

- [ ] **Step 1: Định tuyến đọc file đính kèm** — đặt trong `contracts.js` hoặc file `api/src/routes/attachments.js` mới (mount `/api/v1/attachments` trong server.js — rõ nghĩa hơn vì Task 15 tái dùng); logic theo Interfaces: authenticate → SELECT attachment theo id (404 nếu không có) → kiểm quyền theo `owner_entity` → `res.sendFile(path.resolve(attachment.storage_path))` với root cố định `api/uploads/` → audit `'READ'` (entity `attachment`). Lỗi quyền → 403 `FORBIDDEN_ATTACHMENT`.
- [ ] **Step 1b: POST /:id/scan** — MANAGER-only; validate base64 (≤5MB, `data:image/(jpeg|png);base64,`); ghi file `api/uploads/contract/<contractId>/<uuid>.jpg` (mkdir recursive); INSERT `attachment (owner_entity='contract', owner_id=contractId, storage_path, mime)`; audit `'UPLOAD'`.
- [ ] **Step 2: Helper `completeActivation(client, contract, req, res)`** — dùng chung cho activate + approve: (a) re-check căn `SELECT status FROM apartment WHERE id=$1` không trong ('AVAILABLE','RESERVED') → 409 `INVALID_APARTMENT_STATUS`; (b) overlap re-check như Task 4 → 409 kèm HĐ xung đột; (c) giá: `rent_amount < apartment.base_rent * 0.9` → `UPDATE contract SET status='PENDING_APPROVAL'` + response 409 `PRICE_NEEDS_APPROVAL` (`# ponytail: ngưỡng 10% hard-code, PRD mục 23 chờ chủ đầu tư chốt — tách config khi có`); (d) đạt → `UPDATE contract SET status='ACTIVE'`; (e) nếu căn RESERVED: reservation HELD mới nhất → `UPDATE reservation SET status='CONVERTED'`, INSERT deposit `amount_held = contract.deposit_amount > 0 ? deposit_amount : rsv.hold_amount`, `source_reservation_id = rsv.id`, `status='HELD'`; (f) `UPDATE apartment SET status = CASE WHEN contract.start_date <= CURRENT_DATE THEN 'OCCUPIED' ELSE 'RESERVED' END`; (g) audit `'ACTIVATE'` trước/sau.
- [ ] **Step 3: POST /:id/activate** — MANAGER; guard `status IN ('DRAFT')` (PENDING_APPROVAL đi qua /approve); kiểm tra thứ tự điều kiện và trả lỗi **cụ thể từng điều kiện còn thiếu** (AC-009.2): chưa có attachment `owner_entity='contract'` → 409 `MISSING_SIGNED_SCAN` ("Chưa đính kèm bản scan hợp đồng đã ký"); primary tenant `person.id_number` null/rỗng → 409 `MISSING_IDENTITY_PAPER`; xong gọi `completeActivation`.
- [ ] **Step 4: POST /:id/approve** — role OWNER (kiểm tra `req.user.role_code`, sai → 403); guard `status='PENDING_APPROVAL'`; gọi `completeActivation`.
- [ ] **Step 5: POST /:id/cancel** — MANAGER; `status IN ('DRAFT','PENDING_APPROVAL')` → 409 nếu không; `UPDATE contract SET status='CANCELLED', cancellation_reason=$2`; căn hộ và cọc giữ chỗ **không đụng** (DRAFT chưa chiếm căn; giữ chỗ vẫn HELD — mất cọc theo FR-067 là thao tác forfeit riêng trên reservations, không tự kích khi hủy nháp); audit.
- [ ] **Step 6: UI ContractsPage** — hàng DRAFT: nút "Đính kèm bản ký" (FileReader → base64 → POST /scan; sau upload lưu attachment id hiển thị link "Xem bản scan" → GET /attachments/:id/view) + "Kích hoạt" (POST /activate; lỗi 409 hiện `message` từ server — đã nêu đủ điều kiện thiếu) + "Hủy" (ConfirmDialog + reason); hàng PENDING_APPROVAL: badge vàng + nếu user là OWNER → nút "Duyệt" (POST /approve); hàng ACTIVE không có nút sửa.
- [ ] **Step 7: Verify** — (1) activate khi chưa có bản scan → 409 MISSING_SIGNED_SCAN; (2) upload scan → GET /attachments/:id/view trả đúng ảnh + 1 dòng audit READ; activate với tenant thiếu CCCD → 409 MISSING_IDENTITY_PAPER; (3) đủ điều kiện → ACTIVE, căn OCCUPIED (start_date hôm nay), reservation CONVERTED, `deposit.source_reservation_id IS NOT NULL`; (4) rent_amount < 90% base_rent → PENDING_APPROVAL, login OWNER → /approve → ACTIVE; (5) activate HĐ start_date tương lai → căn RESERVED (Review Focus #3); (6) cancel DRAFT → CANCELLED, cọc giữ chỗ vẫn HELD.
- [ ] **Step 8: Commit**

```bash
git add api/src/routes/contracts.js frontend/src/pages/admin/contracts/ContractsPage.jsx
git commit -m "feat(api,ui): kich hoat HD - dieu kien ban ky/giay to, PENDING_APPROVAL khi le gia, chuyen coc giu cho (A3, A5)"
```

### Task 9: Job hằng ngày — hết hạn HĐ, flip RESERVED↔OCCUPIED, hết hạn giữ chỗ (B5, hoàn tất A5)

**Files:**
- Create: `api/src/jobs/daily.js`
- Modify: `api/src/server.js` (import + start)

**Interfaces:**
- Produces: `runDailyJobs(): Promise<void>`, `startDailyJobs(): void` — server.js gọi sau `app.listen`.

- [ ] **Step 1: Implement** `api/src/jobs/daily.js` — dùng **`adminPool`** (job không có user context, RLS sẽ chặn appPool — Review Focus #4); chạy tuần tự 4 câu, mỗi câu log `[DailyJob] <tên>: <rowCount>`:
  1. `UPDATE contract SET status='EXPIRED', updated_at=NOW() WHERE status IN ('ACTIVE','RENEWAL_PENDING') AND end_date < CURRENT_DATE`
  2. `UPDATE apartment SET status='OCCUPIED', updated_at=NOW() WHERE status='RESERVED' AND id IN (SELECT apartment_id FROM contract WHERE status='ACTIVE' AND start_date <= CURRENT_DATE)` — flip các căn ACTIVE từ Task 8 với start_date tương lai
  3. `UPDATE reservation SET status='EXPIRED', updated_at=NOW() WHERE status='HELD' AND hold_until IS NOT NULL AND hold_until < CURRENT_DATE`
  4. `UPDATE apartment a SET status='AVAILABLE', updated_at=NOW() WHERE a.status='RESERVED' AND NOT EXISTS (SELECT 1 FROM reservation r WHERE r.apartment_id = a.id AND r.status='HELD') AND NOT EXISTS (SELECT 1 FROM contract c WHERE c.apartment_id = a.id AND c.status IN ('ACTIVE','RENEWAL_PENDING'))` — **bắt buộc NOT EXISTS** (review round 2): câu `IN (SELECT apartment_id FROM reservation WHERE status='EXPIRED' ...)` cũ sẽ flip nhầm căn đang có reservation HELD mới hoặc HĐ tương lai ghim ở RESERVED
  - `# ponytail:` in-process interval, tách worker container + distributed lock khi chạy đa instance (PRD 12.4)
  - `startDailyJobs()`: chạy 1 lần lúc boot rồi `setInterval(runDailyJobs, 24*60*60*1000)`.
- [ ] **Step 1b: Harden 2 flip vô điều kiện trong reservations.js** — `POST /:id/forfeit` (dòng ~230) và `POST /:id/refund` (dòng ~283) hiện `UPDATE apartment SET status='AVAILABLE'` vô điều kiện sau khi reservation rời HELD; bọc cùng điều kiện NOT EXISTS như câu 4 trên (chỉ flip khi căn không còn HELD reservation khác và không HĐ đang ghim) — cùng một dạng bẫy logic như câu 4, sửa một lần tại nguồn.
- [ ] **Step 2: Wire vào server.js** — import + gọi `startDailyJobs()` sau listen.
- [ ] **Step 3: Verify** — seed 1 HĐ ACTIVE với `end_date` = hôm qua (psql UPDATE) → chạy `node -e "import('./api/src/jobs/daily.js').then(m=>m.runDailyJobs())"` → HĐ thành EXPIRED; reservation `hold_until` hôm qua → EXPIRED và căn về AVAILABLE; **bẫy logic:** tạo mới 1 reservation HELD trên căn X rồi seed 1 reservation EXPIRED cũ trên X (psql UPDATE status) → chạy job → căn X vẫn RESERVED (không bị flip nhầm); xem log 4 dòng rowCount.
- [ ] **Step 4: Commit**

```bash
git add api/src/jobs/daily.js api/src/server.js api/src/routes/reservations.js
git commit -m "feat(api): job hang ngay - het han HD, flip RESERVED-OCCUPIED an toan, het han giu cho (B5, A5)"
```

### Task 10: PATCH /tenants/:id — duyệt hồ sơ + sửa hồ sơ (A6, A8)

**Files:**
- Modify: `api/src/routes/tenants.js` (thêm PATCH)
- Modify: `frontend/src/pages/admin/tenants/TenantsPage.jsx`

**Interfaces:**
- Produces: `PATCH /api/v1/tenants/:id` body `{status?, type?, full_name?, email?, dob?, id_number?}` → `{ data: { tenant, person } }`.
- Consumes: policy RLS đã có sẵn — **không cần migration mới** (`013_rls_fixes.sql:543-559`: `rls_tenant_update` cho is_org_admin, `is_manager() AND tenant.org_id = get_current_user_org_id()`, và resident id của mình — đã xác minh; `rls_person_update` đã cho MANAGER — 013:477-493).

- [ ] **Step 1: Endpoint** — MANAGER-only, `getUserClient` + transaction; load tenant+person (404 nếu không có); `status` nếu truyền phải thuộc `('PENDING','APPROVED','REJECTED','MOVED_OUT')` → 400 `INVALID_STATUS`; UPDATE person các trường được truyền, UPDATE tenant `status`/`type`; audit before/after cho cả `tenant` (entity `'tenant'`). Migration 015_tenant_policy_fixes.sql trong bản plan trước đã **bỏ** — policy tồn tại rồi, tạo thêm sẽ trùng/rủi xung đột.
- [ ] **Step 2: UI TenantsPage** — thêm cột Thao tác: hàng `PENDING` → nút "Duyệt" (gửi `{status:'APPROVED'}`) + "Từ chối" (`{status:'REJECTED'}`); hàng bất kỳ + MANAGER → "Sửa" mở modal tái dùng form tạo (PATCH).
- [ ] **Step 3: Verify** — cư dân nộp hồ sơ FR-012 (POST /resident/rental-application) → danh sách tenants hiện hàng PENDING → Duyệt → status APPROVED; sửa email cư dân → person đổi, audit có before/after.
- [ ] **Step 4: Commit**

```bash
git add api/src/routes/tenants.js frontend/src/pages/admin/tenants/TenantsPage.jsx
git commit -m "feat(api,ui): PATCH ho so cu dan - duyet PENDING + cap nhat thong tin (A6, A8)"
```

### Task 11: FR-021 — chặn trùng CCCD + tenant primary trùng (A7)

**Files:**
- Create: `api/src/db/migrations/015_unique_person_idnumber.sql`
- Modify: `api/src/routes/tenants.js` (POST + check-dup)
- Modify: `frontend/src/pages/admin/tenants/TenantsPage.jsx` (banner dup)

**Interfaces:**
- Produces: lỗi 409 `DUPLICATE_ID_NUMBER`, 409 `TENANT_ALREADY_PRIMARY`; check-dup nhận thêm `id_number`.

- [ ] **Step 1: Migration** `015_unique_person_idnumber.sql`:

```sql
-- A7 / PRD 13.3: chống trùng CCCD trong cùng org (null/rỗng được phép trùng)
CREATE UNIQUE INDEX IF NOT EXISTS uq_person_org_idnumber
  ON person(org_id, id_number)
  WHERE id_number IS NOT NULL AND id_number <> '';
-- Nếu migrate fail do dữ liệu cũ trùng CCCD, tìm bằng:
-- SELECT org_id, id_number, count(*) FROM person WHERE id_number IS NOT NULL GROUP BY 1,2 HAVING count(*) > 1;
```

- [ ] **Step 2: POST /tenants** — (a) query person khớp `phone = $2 OR (id_number = $3 AND id_number IS NOT NULL)`; nếu có bản ghi chỉ khớp id_number (khác phone) → ROLLBACK + 409 `DUPLICATE_ID_NUMBER` kèm `duplicates` (không tự tạo); (b) nếu reuse person: kiểm tra tenant cùng person **cùng type** đã tồn tại → 409 `TENANT_ALREADY_PRIMARY` (message: "Hồ sơ này đã là chủ hộ thuê, hãy chọn hồ sơ có sẵn khi lập hợp đồng"); (c) khi reuse → audit action `'MERGE'` entity `'person'` ghi `{merged_into: personId, payload}` (FR-021 yêu cầu merge có audit).
- [ ] **Step 3: check-dup + UI** — `GET /check-dup` đã hỗ trợ `id_number` param; TenantsPage: debounce gửi cả `phone` và `id_number` (khi đủ 9 ký tự), banner cảnh báo hiển thị cả 2 loại trùng.
- [ ] **Step 4: Verify** — tạo cư dân CCCD X + SĐT A; tạo tiếp CCCD X + SĐT B → 409 DUPLICATE_ID_NUMBER; tạo 2 lần cùng SĐT type=primary → lần 2 409 TENANT_ALREADY_PRIMARY; audit_log có bản ghi MERGE.
- [ ] **Step 5: Commit**

```bash
git add api/src/db/migrations/015_unique_person_idnumber.sql api/src/routes/tenants.js frontend/src/pages/admin/tenants/TenantsPage.jsx
git commit -m "fix(db,api,ui): FR-021 chan trung CCCD + chan tenant primary trung + audit merge (A7)"
```

### Task 12: Khu/Block trong cây cấu trúc tòa (B1, FR-007)

**Files:**
- Create: `api/src/db/migrations/016_zone.sql`
- Modify: `api/src/routes/buildings.js` (CRUD zone)
- Modify: `api/src/routes/apartments.js` (POST nhận `zone_id`)
- Modify: `frontend/src/pages/admin/buildings/BuildingsPage.jsx` (quản lý khu + chọn khu khi tạo căn)

**Nghiệp vụ (PRD 305, 330, 365, 186):** cây **Tòa nhà · Khu/Block · Tầng · Căn hộ**; FR-007: MANAGER khởi tạo tòa/khu/tầng, **mã định danh duy nhất**, trạng thái `ACTIVE/INACTIVE`; dòng 186: MANAGER CRU, OWNER/RESIDENT R.

**Interfaces:**
- Produces:
  - `POST /api/v1/buildings/:id/zones` `{code, name?}` → 201
  - `PATCH /api/v1/buildings/:id/zones/:zone_id` `{name?, status?}` (status ∈ ACTIVE/INACTIVE)
  - GET `/buildings/:id` trả thêm `zones: [{id, code, name, status}]`
  - POST /apartments nhận `zone_id` (guard ZONE_MISMATCH — Task 2 đã chèn sẵn)
- Lỗi: `ZONE_EXISTS` (409, trùng code trong tòa), `INVALID_ZONE_STATUS` (400).

- [ ] **Step 1: Migration** `016_zone.sql`:

```sql
-- B1 / FR-007: phân khu (Khu/Block) trong tòa nhà
CREATE TABLE IF NOT EXISTS zone (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID NOT NULL REFERENCES organization(id),
  building_id UUID NOT NULL REFERENCES building(id),
  code        TEXT NOT NULL,
  name        TEXT,
  status      TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (building_id, code)
);
ALTER TABLE apartment ADD COLUMN IF NOT EXISTS zone_id UUID REFERENCES zone(id);
-- RLS: sao chép trọn bộ policy của bảng floor (migration 010/013), đổi tên rls_floor_* -> rls_zone_*
```

- [ ] **Step 2: Routes zone** trong `buildings.js` — (a) POST: MANAGER qua `checkBuildingAccess(..., 'update')`, validate code không rỗng, catch unique violation → 409 `ZONE_EXISTS`; audit `'CREATE'`; (b) PATCH: guard zone thuộc building; `status` whitelist; audit before/after; (c) bổ sung `zones` vào GET detail + GET list (query song song như floors).
- [ ] **Step 3: apartments.js** — POST/PATCH nhận `zone_id` (guard đã chèn ở Task 2; PATCH validate tương tự nếu truyền `zone_id`).
- [ ] **Step 4: UI BuildingsPage** — (a) section "Khu/Block" trong trang tòa: bảng zone (code, tên, trạng thái) + nút "Thêm khu" (modal code+tên) + nút bật/tắt ACTIVE; (b) modal tạo căn hộ: select "Khu" (load từ GET /buildings/:id); (c) panel chi tiết căn hiển thị dòng "Khu: <code>" khi có.
- [ ] **Step 5: Verify** — tạo zone "Khu A" code `A` → 201; tạo trùng code `A` cùng tòa → 409 ZONE_EXISTS; tạo căn gắn zone → panel hiện "Khu: A"; PATCH zone INACTIVE → vẫn hiển thị nhưng mờ; curl tạo căn với zone_id của tòa khác → 400 ZONE_MISMATCH.
- [ ] **Step 6: Commit**

```bash
git add api/src/db/migrations/016_zone.sql api/src/routes/buildings.js api/src/routes/apartments.js frontend/src/pages/admin/buildings/BuildingsPage.jsx
git commit -m "feat(api,ui): quan ly khu/block trong cay cau truc toa - FR-007 (B1)"
```

### Task 13: PATCH tòa nhà / tầng + đồng bộ Building Switcher (B3)

**Files:**
- Modify: `api/src/routes/buildings.js` (thêm PATCH tòa, PATCH tầng, GET owners)
- Modify: `frontend/src/pages/admin/buildings/BuildingsPage.jsx` (modal sửa + chọn owner)
- Modify: `frontend/src/pages/admin/contracts/ContractsPage.jsx` (lắng nghe `buildingChanged`)

**Interfaces:**
- Produces: `PATCH /api/v1/buildings/:id` `{name?, address?, owner_id?, timezone?, lease_terms?, payment_account?}`; `PATCH /api/v1/buildings/:id/floors/:floor_id` `{level?, name?}`; `GET /api/v1/buildings/owners` → `{data:[{id, full_name}]}`.
- Consumes: event `buildingChanged` + key `resihub_selected_building_id` từ `TopBar.jsx:24,92` (đã tồn tại).

- [ ] **Step 1: API** — (a) `GET /owners`: MANAGER/OWNER read, `SELECT id, full_name FROM owner WHERE org_id=$1` (đặt **trước** route `/:id` để không bị nuốt); (b) PATCH tòa: MANAGER qua `checkBuildingAccess(..., 'update')`; validate `owner_id` bằng `SELECT 1 FROM owner WHERE id=$1 AND org_id=$2` → sai → 400 `INVALID_OWNER`; code KHÔNG cho sửa; audit before/after; (c) PATCH tầng: guard tầng thuộc tòa + dup check `level` (409 `FLOOR_EXISTS` tái dùng), audit.
- [ ] **Step 2: UI BuildingsPage** — nút "Sửa" trên hàng bảng tòa + trong header sơ đồ (mở modal tái dùng form NV-03, trừ ô mã); select "Chủ sở hữu" (từ GET /owners) trong modal tạo + sửa; nút sửa tầng (level + name) cạnh tên tầng.
- [ ] **Step 3: Đồng bộ switcher** — ContractsPage (và DepositsPage nếu có chọn tòa): `useEffect` đọc `localStorage.getItem('resihub_selected_building_id')` lúc mount + `window.addEventListener('buildingChanged', ...)` để set tòa đang chọn; cleanup listener khi unmount.
- [ ] **Step 4: Verify** — sửa tên tòa → bảng + pill refresh; chọn owner ngoài org qua curl → 400; chuyển tòa trên TopBar → ContractsPage danh sách HĐ đổi theo.
- [ ] **Step 5: Commit**

```bash
git add api/src/routes/buildings.js frontend/src/pages/admin/buildings/BuildingsPage.jsx frontend/src/pages/admin/contracts/ContractsPage.jsx
git commit -m "feat(api,ui): PATCH toa/tang + chon chu so huu + dong bo building switcher (B3)"
```

### Task 14: Quản lý thành viên cùng ở theo hợp đồng (B6)

**Files:**
- Modify: `api/src/routes/contracts.js` (2 endpoint)
- Modify: `frontend/src/pages/admin/contracts/ContractsPage.jsx` (modal thành viên)

**Interfaces:**
- Produces: `GET /api/v1/contracts/:id/occupants` → `{data:[{tenant_id, full_name, phone, relationship, type}]}`; `POST /api/v1/contracts/:id/occupants` `{full_name, phone, relationship, email?, dob?, id_number?}` → 201; `DELETE /api/v1/contracts/:id/occupants/:tenant_id` → 200 (xóa dòng `contract_occupant`, tenant giữ nguyên — gỡ khỏi hợp đồng chứ không xóa hồ sơ, NFR-016).

- [ ] **Step 1: API GET/POST** — cả 2 MANAGER-only + guard tòa (mẫu `checkMgr` ở contracts.js:135-144). GET: `SELECT co.relationship, t.id as tenant_id, p.full_name, p.phone FROM contract_occupant co JOIN tenant t ON t.id=co.tenant_id JOIN person p ON p.id=t.person_id WHERE co.contract_id=$1`. POST: tái dùng logic person-by-phone của tenants.js (reuse nếu trùng SĐT, tenant type=`'occupant'`), rồi `INSERT INTO contract_occupant (contract_id, tenant_id, relationship)`; transaction + audit; tenant `status='APPROVED'`.
- [ ] **Step 2: API DELETE occupants/:tenant_id** — MANAGER + guard tòa; guard tenant thuộc đúng hợp đồng này (`SELECT 1 FROM contract_occupant WHERE contract_id=$1 AND tenant_id=$2` → 404 nếu không); `DELETE FROM contract_occupant WHERE contract_id=$1 AND tenant_id=$2`; **không** xóa tenant/person; audit `'DELETE'` entity `'contract_occupant'`.
- [ ] **Step 3: UI** — nút "Thành viên" mỗi hàng hợp đồng → modal: danh sách thành viên (tên, SĐT, quan hệ, nút "Gỡ" cho từng người) + form thêm (họ tên*, SĐT*, quan hệ*, email, CCCD).
- [ ] **Step 4: Verify** — thêm occupant "Vợ" cho 1 HĐ → GET trả đúng; SĐT trùng với person có sẵn → reuse, không tạo person mới; gỡ occupant → mất khỏi danh sách nhưng tenant/person còn nguyên trong DB (psql).
- [ ] **Step 5: Commit**

```bash
git add api/src/routes/contracts.js frontend/src/pages/admin/contracts/ContractsPage.jsx
git commit -m "feat(api,ui): quan ly thanh vien cung o theo hop dong - contract_occupant (B6)"
```

### Task 15: Upload ảnh CCCD có kiểm soát PII (B7)

**Files:**
- Modify: `api/src/routes/tenants.js` (2 endpoint)
- Modify: `frontend/src/pages/admin/tenants/TenantsPage.jsx` (upload trong modal sửa)
- Modify: `.gitignore` (thêm `api/uploads/`)

**Interfaces:**
- Consumes: `GET /api/v1/attachments/:id/view` (Task 8 Step 1 — dùng chung, đã có auth + audit `'READ'`).
- Produces: `POST /api/v1/tenants/:id/id-images` `{image_base64, side: 'front'|'back'}` → `{data:{attachmentId}}`; `GET /api/v1/tenants/:id/id-images` → `{data:[{attachment_id, side}]}` — trả **id để UI render `<img src="/api/v1/attachments/<id>/view">`** (path trên đĩa không dùng được cho frontend vì thư mục uploads không serve static).

- [ ] **Step 1: POST endpoint** — MANAGER-only; validate: `image_base64` decode ≤ 5MB và prefix `data:image/(jpeg|png);base64,`; ghi file vào `api/uploads/person/<personId>/<uuid>.jpg` (mkdir recursive, `node:fs/promises`); `UPDATE person SET id_images = array_append(id_images, $2)`; INSERT `attachment (owner_entity='person', owner_id=personId, storage_path, mime, size_bytes)`; audit `'UPLOAD'`. KHÔNG phục vụ thư mục này tĩnh — chỉ đọc qua `GET /attachments/:id/view` của Task 8.
- [ ] **Step 2: GET endpoint** — MANAGER-only; trả danh sách `{attachment_id, side}` query từ bảng `attachment` theo `owner_entity='person'` (+ audit `'READ'` nhóm ở đây, view endpoint đã audit từng lần xem ảnh).
- [ ] **Step 3: UI** — trong modal sửa cư dân: 2 ô upload (mặt trước/sau), `FileReader` → base64, hiển thị thumbnail ảnh đã có qua `/attachments/<id>/view` + nút xem to.
- [ ] **Step 4: Verify** — upload ảnh ~1MB → 200, file tồn tại trên đĩa, `person.id_images` có 1 phần tử, bảng `attachment` có dòng; upload >5MB → 400; GET lần 2 → audit có 2 dòng READ; mở `/attachments/<id>/view` → ảnh render, quyền RESIDENT → 403 FORBIDDEN_ATTACHMENT.
- [ ] **Step 5: Commit**

```bash
git add api/src/routes/tenants.js frontend/src/pages/admin/tenants/TenantsPage.jsx .gitignore
git commit -m "feat(api,ui): upload anh CCCD co audit truy cap, luu attachment (B7)"
```

### Task 16: Hồ sơ cá nhân tự phục vụ trên Cổng cư dân (B9)

**Files:**
- Modify: `api/src/routes/resident.js` (PATCH profile)
- Modify: `frontend/src/pages/resident/ResidentPortalPage.jsx` (form hồ sơ)

**Interfaces:**
- Produces: `PATCH /api/v1/resident/profile` `{full_name?, email?, dob?}` → `{data: person}` — **không** nhận `phone`/`id_number` (đổi SĐT/CCCD phải qua quy trình xác minh riêng — PRD 14.2).

- [ ] **Step 1: Endpoint** — `UPDATE person SET full_name=COALESCE($1,full_name), email=COALESCE($2,email), dob=COALESCE($3::date,dob) WHERE id=get_current_user_person_id()`; audit `'UPDATE'` entity `'person'` (RLS: `rls_person_update` đã cho `id = get_current_user_person_id()` — 013:477-493, không cần policy mới).
- [ ] **Step 2: UI** — trong ResidentPortalPage thêm card "Hồ sơ cá nhân" (prefill từ `overview.user`), nút Lưu gọi PATCH, toast thành công.
- [ ] **Step 3: Verify** — cư dân đăng nhập portal, sửa email → GET /resident/overview trả email mới; gửi kèm `phone` → bị bỏ qua (không đổi).
- [ ] **Step 4: Commit**

```bash
git add api/src/routes/resident.js frontend/src/pages/resident/ResidentPortalPage.jsx
git commit -m "feat(api,ui): ho so ca nhan tu phuc vu tren cong cu dan (B9)"
```

### Task 17: Nhóm C — dọn lỗi nhỏ (mỗi mục 1 commit)

**Files:** `frontend/src/pages/admin/buildings/BuildingsPage.jsx`, `api/src/routes/apartments.js`, `api/src/routes/buildings.js`

- [ ] **C1 — hiển thị amenities thật** (`BuildingsPage.jsx:701-709`): amenities là object JSONB dạng `{"wifi":true,"air_conditioner":true}` (xem seed.js:137) → render `Object.entries(apt.amenities||{}).filter(([,v])=>v)` với map nhãn `{wifi:'Wifi', air_conditioner:'Điều hòa', water_heater:'Nóng lạnh', smart_lock:'Khóa từ'}`, key lạ giữ nguyên. Commit: `fix(ui): hien thi amenities that tu du lieu thay vi cung (C1)`
- [ ] **C2 — gợi ý mã kế tiếp** (`apartments.js:123-125`): bắt `23505` → query `SELECT code FROM apartment WHERE building_id=$1 ORDER BY code DESC LIMIT 1`, tăng hậu tố số (VD `A105` → "Gợi ý: A106"), nhét vào message lỗi. Commit: `fix(api): goi y ma can ke tiep khi bi trung ma (C2)`
- [ ] **C3 — audit khi tạo tầng** (`buildings.js:458-465`): thêm INSERT `audit_log ('CREATE','floor',...)` sau khi tạo. Commit: `fix(api): ghi audit log khi tao tang (C3)`
- [ ] **C4 — text actor sai** (`BuildingsPage.jsx:773`): "Actor: SYS_ADMIN · Module: M03" → "Actor: MANAGER · Module: M03". Commit: `fix(ui): sua text actor trong modal tao toa (C4)`
- [ ] **C7 — chặn tạm dừng tòa khi còn giữ chỗ** (`buildings.js:308-320`): thêm đếm `SELECT COUNT(*) FROM reservation WHERE building_id=$1 AND status='HELD'` → >0 → 400 `RESERVED_APARTMENTS_EXIST` (message cùng kiểu với ACTIVE_CONTRACTS_EXIST). Commit: `fix(api): chan tam dung toa khi con can dang giu cho (C7)`
- [ ] **Verify cả batch:** tạo tầng → audit có dòng floor; căn trùng mã → lỗi có gợi ý; tòa còn reservation HELD → chặn tạm dừng.

---

## Phạm vi loại trừ (chờ chốt — không làm trong đợt này)

| Mục | Lý do |
|---|---|
| C9 Export khai báo tạm trú | PRD ghi "cần xác nhận yêu cầu cụ thể"; thiếu trường quê quán trong schema |

## Phụ thuộc giữa các task

- Task 1 → 3, 6, 8 (import `isTransitionAllowed`).
- Task 2 chỉ guard `floor_id` (bảng zone chưa tồn tại ở Task 2); guard `zone_id` + mã lỗi `ZONE_MISMATCH` hiện thực hóa ở Task 12 Step 3.
- Task 4 (overlap) → 7 (POST dùng), 8 (activate re-check dùng).
- Task 7 → 8 (POST tạo DRAFT trước, activate sau).
- Task 8 Step 1 (endpoint `GET /attachments/:id/view` + mount `/api/v1/attachments`) → 15 (Task 15 chỉ gọi lại, không định nghĩa endpoint mới).
- Task 8 → 9 (job flip các căn RESERVED do activate để lại; NOT EXISTS guard của câu 4 + Step 1b harden cùng một điều kiện).
- Task 10 không tạo migration (RLS đã có — 013:543-559, đã xác minh).
- Task 12 (zone) → 13 (GET owners đặt trước route /:id — chèn route mới không phá zone).
- Task 10 → 11 (PATCH tenants trước, dup-check sau — cùng file `tenants.js`).
- Task 15 dùng bảng `attachment` đã có (007); Task 8 Step 1 tạo pattern upload base64 + view dùng chung.

## Self-review checklist (đã chạy, cập nhật theo review round 2)

- **Spec coverage:** A1(T5), A2(T1,3), A3(T7,8 — luồng DRAFT đầy đủ: tạo nháp, sửa nháp, bản ký, điều kiện chặn ACTIVE, PENDING_APPROVAL, approve, cancel), A4(T4), A5(T8,9), A6(T10), A7(T11), A8(T10), A9(T3), **B1(T12 — bảng zone + CRUD + apartment.zone_id + UI)**, B2(T6), B3(T13), B4(T2), B5(T9), B6(T14 — có cả gỡ thành viên), B7(T15 — có endpoint view ảnh), B8(T6), B9(T16), C1–C4, C7(T17) — đủ. Chỉ C9 loại trừ có lý do.
- **Type consistency:** `isTransitionAllowed`, `APARTMENT_TRANSITIONS` đặt ở Task 1, dùng ở T3/T6/T8 — tên khớp; map của T1 vẫn cho phép AVAILABLE→OCCUPIED/RESERVED (module dùng cho luồng HĐ/giữ chỗ), nhưng **route PATCH chặn riêng** target đó (T3 Step 1.1) — hai tầng guard tách bạch đúng trách nhiệm. `buildingChanged` + `resihub_selected_building_id` khớp TopBar.jsx hiện có. Bảng `attachment` + `person.id_images` đã tồn tại (007, 002) — đã grep xác nhận.
- **Schema thật:** bảng tổ chức là `organization` (002:4), PK `gen_random_uuid()` — Migration 016 đã khớp; `rls_tenant_update` đã cấp `is_manager()` (013:543-559) — không tạo policy trùng.
- **Review Focus:** #1 → T3 verify; #2 → T4 verify (psql 23P01); #3 → T8/T9 verify; #4 → T9 dùng adminPool + verify log; #5 → T11 verify; #6 → T8 Step 7.(3b) activate khi căn bị chiếm; #7 → T7 Step 2 PATCH chặn khi khác DRAFT; #8 → T3 Step 2 verify (PATCH OCCUPIED → 409); #9 → T9 Step 3 verify bẫy (căn có EXPIRED cũ + HELD mới vẫn giữ RESERVED).
- **PRD đối chiếu:** 485 (lưu DRAFT → tải bản ký → ACTIVE, căn → OCCUPIED), 486 (chặn chồng lấn/giá lệch/thiếu giấy tờ), 665 AC-009.2 (chặn ACTIVE khi chưa có bản ký), 490 (MANAGER C/R/U khi DRAFT), 231 (cọc giữ chỗ → cọc hợp đồng khi ký), 305/365 (Khu/Block, mã duy nhất, ACTIVE/INACTIVE), 17.1 #5 (audit từng lần đọc PII ở endpoint view) — mọi điều kiện activate đều bám nguyên văn PRD.
- **Số migration dãy liên tục:** 014 exclusion (T4), 015 unique CCCD (T11), 016 zone (T12) — không task nào chèn giữa.
