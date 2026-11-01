# Hoàn thiện 4 Hạng mục Tạo & Chỉnh sửa Hợp đồng (M05) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hoàn thiện nốt 4 điểm khuyết trong luồng Tạo & Chỉnh sửa hợp đồng thuê (`M05`) theo PRD v2.0: (1) hiển thị đầy đủ gói dịch vụ đi kèm, số lượng, biển số xe và giá Điện/Nước trên bản in hợp đồng A4, (2) cho phép nhập ghi chú/biển số xe và chỉnh sửa danh sách gói dịch vụ ngay trên hợp đồng nháp (`DRAFT`), (3) bổ sung cơ chế `Idempotency-Key` chống gửi đúp cho các POST trọng yếu của hợp đồng, và (4) hỗ trợ đính kèm ảnh CCCD mặt trước/sau ngay khi tạo nhanh cư dân mới trong modal hợp đồng.

**Architecture:** Tách logic kết xuất bảng dịch vụ Điều 5 bản in A4 thành hàm thuần `buildContractTemplateServiceRows` kết hợp dữ liệu từ `service_subscription`, `contract_service_price`, `meter` và `service_catalog` (có escape HTML chống XSS). Trích xuất hàm dùng chung `syncDraftContractServicesInTx` cho cả `POST /api/v1/contracts` và `PATCH /api/v1/contracts/:id` kèm cập nhật RLS `rls_service_sub_delete` để `MANAGER` thêm/sửa/xóa gói dịch vụ khi hợp đồng còn ở `DRAFT`. Bổ sung bảng `idempotency_key` cùng middleware `idempotencyGuard` (hỗ trợ cả replay kết quả chuyển trạng thái `409 PRICE_NEEDS_APPROVAL` và tương thích ngược với bộ test cũ khi chưa bật cờ bắt buộc cứng), đồng thời tích hợp lưu ảnh CCCD `id_image_front`/`id_image_back` nguyên tử trong luồng `new_tenant`.

**Tech Stack:** Node.js (ESM), Express 4, PostgreSQL 16 (Row-Level Security), `node:crypto`, `node:test`, React 19, Vite 8, Tailwind CSS.

**Spec:** `PRD - Quan ly Can ho va Nha cho thue v2.0.md` (Mục 7.1, 13.2, 13.5, 13.6, 14.3, FR-011, FR-014, FR-020, FR-027, FR-065)

## Global Constraints

- **Phân quyền `M05` (giữ nguyên từ Migration `041`):** Chỉ `MANAGER` thuộc tòa nhà được gán mới thực hiện tạo nháp, sửa nháp, đính kèm scan và kích hoạt hợp đồng; `SYS_ADMIN` chỉ đọc (`R`); `OWNER` của tòa nhà duyệt giá lệch khung (và tuyệt đối không được xem ảnh CCCD gốc `owner_entity = 'person'` theo PRD Mục `13.5`).
- **Trạng thái dịch vụ đi kèm (`FR-014`, `FR-027`, Mục `13.2`):** Gói dịch vụ gắn với hợp đồng `DRAFT` lưu trong `service_subscription` ở trạng thái `'PENDING_APPROVAL'`, lưu thông tin biển số xe / ghi chú gói tại cột `note` (tối đa `500` ký tự), chỉ cho phép sửa/xóa trực tiếp qua `PATCH /api/v1/contracts/:id` khi `contract.status = 'DRAFT'`.
- **Thứ tự ưu tiên đơn giá trên Bản in A4 & Hóa đơn (`FR-065`):** `contract_service_price` (giá riêng theo hợp đồng) → `service_subscription.unit_price` / `meter.unit_price` (giá đăng ký / đồng hồ căn hộ) → `service_catalog.unit_price` (giá danh mục tòa nhà/tổ chức).
- **Quy tắc `Idempotency-Key` (`PRD Mục 14.3`):** Khóa định danh theo bộ `(org_id, actor_id, method, route_path, idem_key)`, độ dài header `1..255` ký tự, TTL `24 giờ`. Cùng key + cùng SHA-256 request body trả lại đúng status và JSON đã lưu; cùng key + khác request body trả `409 IDEMPOTENCY_KEY_CONFLICT`; request đang xử lý song song cùng key trả `409 IDEMPOTENCY_IN_PROGRESS`. Khi biến môi trường `REQUIRE_IDEMPOTENCY_KEY=true`, thiếu header trả `400 IDEMPOTENCY_KEY_REQUIRED` (mặc định `false` để không phá vỡ 20 bộ test tích hợp hiện hữu gọi trực tiếp không kèm header).
- **Ảnh CCCD khi tạo nhanh cư dân (`FR-011`, `PRD 13.5`):** Chỉ chấp nhận `image/jpeg` hoặc `image/png`, dung lượng mỗi mặt tối đa `5MB` (`MAX_IMAGE_BYTES`), lưu vào `uploads/person/<personId>/`, ghi bản ghi `attachment` (`owner_entity = 'person'`) và nối JSON `{ attachmentId, side }` (`side IN ('front', 'back')`) vào `person.id_images`.

## Review Focus

1. **Ký tự đặc biệt / HTML injection trong ghi chú biển số xe hoặc tên người ở cùng khi xuất mẫu in A4 (`GET /:id/template`):** Chuỗi `note = '<script>alert(1)</script> 59A1-123.45'` trên `service_subscription` hoặc `occupant.full_name` phải được escape thành `&lt;script&gt;...` trong HTML trả về, không làm vỡ cấu trúc bảng in hoặc thực thi mã độc (kiểm thử tại Task 1).
2. **Dịch vụ đi kèm dùng đúng giá niêm yết danh mục (không sinh dòng trong `contract_service_price`) và dịch vụ đã `CANCELLED`:** Bản in A4 phải hiển thị đầy đủ gói dịch vụ `PENDING_APPROVAL`/`ACTIVE` kèm `quantity`, `unit_price`, thành tiền định kỳ và `note` dù bảng `contract_service_price` rỗng, đồng thời loại bỏ các gói `status IN ('CANCELLED', 'REJECTED')` (kiểm thử tại Task 1).
3. **`MANAGER` gỡ bớt gói dịch vụ hoặc xóa giá Điện/Nước ghi đè khi sửa hợp đồng nháp (`PATCH /:id`) dưới kết nối RLS:** `getUserClient(req)` của `MANAGER` phải xóa sạch được bản ghi `service_subscription` (`PENDING_APPROVAL`) bị bỏ chọn và xóa bản ghi `contract_service_price` tương ứng khi khôi phục về giá chuẩn tòa nhà mà không bị chặn bởi RLS `rls_service_sub_delete` hay để sót giá cũ (kiểm thử tại Task 2).
4. **Gửi lại `POST /api/v1/contracts/:id/activate` cùng `Idempotency-Key` trên hợp đồng giảm giá sâu (`< 90% base_rent`) hoặc đổi body cùng key:** Lần gọi lại cùng key + cùng body phải replay nguyên vẹn phản hồi `409 PRICE_NEEDS_APPROVAL` (vì lần đầu đã `COMMIT` chuyển sang `PENDING_APPROVAL`) thay vì báo nhầm `409 INVALID_STATUS`; nếu gửi cùng key nhưng sửa body phải chặn `409 IDEMPOTENCY_KEY_CONFLICT` (kiểm thử tại Task 3).
5. **Ảnh CCCD sai định dạng hoặc vượt quá `5MB` khi tạo mới cư dân inline (`new_tenant.id_image_front`):** `POST /api/v1/contracts` phải trả `400 VALIDATION_ERROR` và `ROLLBACK` toàn bộ giao dịch — không để lọt bản ghi mồ côi trong `person`, `tenant` hay `contract` (kiểm thử tại Task 4).

---

## File Structure

### Database & Backend (`api/`)
- **Create:** `api/src/db/migrations/042_idempotency_and_draft_services_rls.sql` — Tạo bảng `idempotency_key` (kèm index & quyền cho `resihub_app`) và mở rộng policy `rls_service_sub_delete` cho phép `MANAGER` tòa nhà được gán xóa `service_subscription` ở trạng thái `'PENDING_APPROVAL'` / `'CANCELLED'`.
- **Create:** `api/src/services/contractTemplate.js` — Cung cấp `escapeTemplateHtml(val)` và `buildContractTemplateServiceRows({ contractStartDate, subscriptions, servicePrices, meters, utilityCatalog })` phục vụ kết xuất Điều 5 bản in A4.
- **Create:** `api/src/middleware/idempotency.js` — Cung cấp `canonicalHashBody(body)` và middleware `idempotencyGuard({ requireHeader })` quản lý vòng đời khóa chống gửi đúp trong PostgreSQL.
- **Modify:** `api/src/routes/contracts.js` — Tích hợp `buildContractTemplateServiceRows` + escape HTML vào `GET /:id/template`; trích xuất `syncDraftContractServicesInTx` dùng chung cho `POST /` và `PATCH /:id` (hỗ trợ `services[].note`, thêm/sửa/gỡ dịch vụ & giá Điện/Nước trên `DRAFT`); gắn `idempotencyGuard()` cho các POST trọng yếu; lưu `id_image_front` / `id_image_back` khi tạo `new_tenant` và dọn điều kiện kiểm tra `userId` trong `notifyContractStakeholders`.
- **Create:** `api/test/contractTemplate.test.js` — Unit test cho `contractTemplate.js`.
- **Create:** `api/test/contractRemainingFixes.test.js` — Integration test đầu-cuối cho cả 4 hạng mục và toàn bộ 5 kịch bản `Review Focus`.

### Frontend (`frontend/`)
- **Modify:** `frontend/src/services/contracts.service.js` — Thêm helper sinh/truyền header `Idempotency-Key` cho `create`, `activate`, `approve`, `renew`, `terminate`, `transferRoom`.
- **Modify:** `frontend/src/pages/admin/contracts/ContractsPage.jsx` — Giữ `Idempotency-Key` ổn định cho mỗi lượt submit form tạo nháp; thêm ô `Ghi chú / Biển số xe` cho từng dịch vụ được chọn ở Bước 4; thêm 2 ô `FileUpload` ảnh CCCD mặt trước/sau (`JPG/PNG`, tối đa `5MB`) trong khối `+ Tạo cư dân mới`; hiển thị gợi ý tiền giữ chỗ dưới ô Tiền đặt cọc khi chọn phiếu giữ chỗ.
- **Modify:** `frontend/src/pages/admin/contracts/ContractDetailPage.jsx` — Hiển thị cột `Ghi chú / Biển số` ở bảng dịch vụ đi kèm; mở rộng Modal **Chỉnh sửa hợp đồng nháp** (`size="xl"`) cho phép chỉnh sửa danh sách `services[]` (số lượng, đơn giá, ghi chú/biển số) và giá Điện/Nước riêng (`service_prices[]`); truyền `Idempotency-Key` ổn định cho các thao tác Kích hoạt / Duyệt / Gia hạn / Chấm dứt / Chuyển phòng.
- **Modify:** `frontend/src/utils/__tests__/contractCreationUi.test.js` — Bổ sung các kiểm thử xác nhận `Idempotency-Key`, ô ghi chú biển số xe, upload ảnh CCCD inline và chỉnh sửa dịch vụ trong Modal Sửa nháp.

---

### Task 1: Hoàn thiện Điều 5 Bản in Hợp đồng A4 (`GET /api/v1/contracts/:id/template`)

**Files:**
- Create: `api/src/services/contractTemplate.js`
- Modify: `api/src/routes/contracts.js:3770-3875,4127-4143`
- Create: `api/test/contractTemplate.test.js`

**Interfaces:**
- Consumes: dữ liệu truy vấn từ `service_subscription JOIN service_catalog`, `contract_service_price`, `meter`, `service_catalog` trong `api/src/routes/contracts.js`.
- Produces:
  - `escapeTemplateHtml(value: unknown) -> string` trong `api/src/services/contractTemplate.js`.
  - `buildContractTemplateServiceRows({ contractStartDate, subscriptions, servicePrices, meters, utilityCatalog }) -> Array<{ name: string, code: string, note: string, quantityLabel: string, unitPrice: number, amountLabel: string, effectiveFrom: string }>` trong `api/src/services/contractTemplate.js`.

- [ ] **Step 1: Viết unit test thất bại cho `contractTemplate.js`**

Tạo `api/test/contractTemplate.test.js` kiểm tra:
1. Gói dịch vụ `PENDING_APPROVAL` / `ACTIVE` dùng giá chuẩn danh mục (`contract_service_price` rỗng) vẫn trả ra đủ dòng với `quantityLabel = '2 xe/tháng'`, `unitPrice = 120000`, `amountLabel = '240.000 ₫/kỳ'` và `note = '59A1-123.45'`; gói `CANCELLED` / `REJECTED` bị loại bỏ (Review Focus #2).
2. Khi có `contract_service_price` ghi đè mã dịch vụ (hoặc `ELECTRICITY` / `WATER`), đơn giá dòng tương ứng lấy theo giá ghi đè; khi không có ghi đè Điện/Nước, lấy theo `meter.unit_price` (hoặc fallback `utilityCatalog`) với `amountLabel = 'Theo chỉ số đồng hồ'`.
3. `escapeTemplateHtml` chuyển đổi đầy đủ `&`, `<`, `>`, `"`, `'` thành HTML entities an toàn (Review Focus #1).

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  escapeTemplateHtml,
  buildContractTemplateServiceRows,
} from '../src/services/contractTemplate.js';

test('buildContractTemplateServiceRows includes default-priced subscriptions, meter rates, overrides, and excludes CANCELLED', () => {
  const rows = buildContractTemplateServiceRows({
    contractStartDate: '2026-11-01',
    subscriptions: [
      {
        service_code: 'MOTORBIKE_PARKING',
        service_name: 'Gửi xe máy hầm B1',
        service_category: 'PARKING',
        billing_type: 'QUANTITY',
        unit: 'xe/tháng',
        quantity: 2,
        unit_price: 120000,
        start_date: '2026-11-01',
        status: 'PENDING_APPROVAL',
        note: '59A1-123.45, 59B2-678.90',
      },
      {
        service_code: 'CLEANING_WEEKLY',
        service_name: 'Dọn vệ sinh',
        billing_type: 'QUANTITY',
        unit: 'lần/tháng',
        quantity: 1,
        unit_price: 150000,
        status: 'CANCELLED',
      },
    ],
    servicePrices: [{ service_code: 'ELECTRICITY', unit_price: 3500, effective_from: '2026-11-01' }],
    meters: [
      { meter_type: 'ELECTRICITY', unit: 'kWh', unit_price: 3800 },
      { meter_type: 'WATER', unit: 'm³', unit_price: 22000 },
    ],
    utilityCatalog: [],
  });

  assert.equal(rows.length, 3);
  assert.equal(rows[0].code, 'MOTORBIKE_PARKING');
  assert.equal(rows[0].quantityLabel, '2 xe/tháng');
  assert.equal(rows[0].unitPrice, 120000);
  assert.equal(rows[0].note, '59A1-123.45, 59B2-678.90');
  assert.match(rows[0].amountLabel, /240\.000/);

  const elec = rows.find((r) => r.code === 'ELECTRICITY');
  const water = rows.find((r) => r.code === 'WATER');
  assert.equal(elec.unitPrice, 3500);
  assert.equal(water.unitPrice, 22000);
  assert.equal(water.amountLabel, 'Theo chỉ số đồng hồ');
});

test('escapeTemplateHtml neutralizes XSS payloads in notes and names', () => {
  assert.equal(
    escapeTemplateHtml('<script>alert("xss")</script>'),
    '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;'
  );
});
```

- [ ] **Step 2: Chạy unit test để xác nhận thất bại**

Run: `node --test api/test/contractTemplate.test.js`
Expected: FAIL với lỗi `Cannot find module '../src/services/contractTemplate.js'`.

- [ ] **Step 3: Triển khai `api/src/services/contractTemplate.js` và tích hợp vào `GET /api/v1/contracts/:id/template`**

1. Trong `api/src/services/contractTemplate.js`:
   - Cài đặt `escapeTemplateHtml(val)` và `buildContractTemplateServiceRows(...)`:
     - Lọc `subscriptions` có `status IN ('PENDING_APPROVAL', 'ACTIVE')` và `billing_type !== 'METERED'`.
     - Tra cứu đơn giá ghi đè từ `servicePrices` (khớp `service_code`, bao gồm alias `INTERNET_FIBER -> INTERNET`, `MANAGEMENT_FEE -> COMMON_SERVICE` giống hệt `invoices.js:214-223`).
     - Với mỗi gói đăng ký: tính `effectiveUnitPrice`, `lineTotal = effectiveUnitPrice * quantity`, định dạng `amountLabel = fmtMoney(lineTotal) + '/tháng'`.
     - Bổ sung dòng `ELECTRICITY` và `WATER` (ưu tiên `servicePrices` → `meters` → `utilityCatalog`), với `quantityLabel = '1 ' + unit` và `amountLabel = 'Theo chỉ số đồng hồ'`.
     - Bổ sung các dòng `servicePrices` độc lập chưa nằm trong các mã đã xuất ở trên để tương thích ngược.
2. Trong `api/src/routes/contracts.js` (`GET /:id/template`):
   - Truy vấn thêm `service_subscription JOIN service_catalog`, `meter` (`WHERE apartment_id = $1 AND status = 'ACTIVE'`) và `service_catalog` (`WHERE org_id = (SELECT org_id FROM building WHERE id = $1) AND code IN ('ELECTRICITY', 'WATER') AND is_active = TRUE`).
   - Escape toàn bộ chuỗi người dùng nhập (`tenant_name`, `occupants`, `c.note`, `row.name`, `row.note`) qua `escapeTemplateHtml`.
   - Cập nhật bảng Điều 5 gồm 6 cột: `STT` | `Dịch vụ & Ghi chú` | `Số lượng / ĐVT` | `Đơn giá áp dụng` | `Thành tiền / Cách tính` | `Hiệu lực từ`.

- [ ] **Step 4: Chạy lại unit test để xác nhận PASS**

Run: `node --test api/test/contractTemplate.test.js`
Expected: PASS (2/2 tests).

- [ ] **Step 5: Commit Task 1**

```bash
git add api/src/services/contractTemplate.js api/src/routes/contracts.js api/test/contractTemplate.test.js
git commit -m "feat(contracts): render subscribed services, notes, and utility rates in A4 print template"
```

---

### Task 2: Chỉnh sửa Gói dịch vụ đi kèm (`services[]`), Biển số xe (`note`) & Đơn giá riêng trên Hợp đồng nháp (`PATCH /:id` + RLS)

**Files:**
- Create: `api/src/db/migrations/042_idempotency_and_draft_services_rls.sql`
- Modify: `api/src/routes/contracts.js:1280-1436,1902-2120`
- Create: `api/test/contractRemainingFixes.test.js`

**Interfaces:**
- Consumes: bảng `service_catalog`, `service_subscription`, `contract_service_price`, hàm `roundVND` (`pricing.js`) và `loadContractSubscriptionsAndSchedule` (`contracts.js`).
- Produces:
  - Migration `042_idempotency_and_draft_services_rls.sql`:
    - Cập nhật policy `rls_service_sub_delete` trên `service_subscription` cho phép `building_id IN (SELECT building_id FROM get_manager_building_ids()) AND status IN ('PENDING_APPROVAL', 'CANCELLED')`.
    - Khởi tạo bảng `idempotency_key` (dùng tiếp ở Task 3) để gom thành đúng 1 file migration duy nhất.
  - Hàm nội bộ `syncDraftContractServicesInTx(client, { contractId, orgId, buildingId, apartmentId, startDateStr, actorId, services, servicePrices, replaceExistingSubscriptions })` trong `api/src/routes/contracts.js`.
  - Mở rộng `PATCH /api/v1/contracts/:id`: nhận tùy chọn `services?: Array<{ service_id, quantity?, unit_price?, custom_unit_price?, note? }>` và `service_prices?: Array<{ service_code, unit_price: number | null, effective_from? }>`, trả kèm `{ data, service_subscriptions, invoice_schedule }`.

- [ ] **Step 1: Viết migration `042_idempotency_and_draft_services_rls.sql` và integration test thất bại cho `PATCH /:id` dịch vụ nháp**

1. Tạo `api/src/db/migrations/042_idempotency_and_draft_services_rls.sql`:
```sql
-- 042_idempotency_and_draft_services_rls.sql
-- 1. Cho phép MANAGER tòa nhà được phân công xóa các gói service_subscription chưa kích hoạt (PENDING_APPROVAL / CANCELLED) khi chỉnh sửa hợp đồng DRAFT
DROP POLICY IF EXISTS rls_service_sub_delete ON service_subscription;
CREATE POLICY rls_service_sub_delete ON service_subscription FOR DELETE USING (
  is_org_admin()
  OR (
    building_id IN (SELECT building_id FROM get_manager_building_ids())
    AND status IN ('PENDING_APPROVAL', 'CANCELLED')
  )
);

-- 2. Bảng lưu khóa chống gửi đúp Idempotency-Key (PRD Mục 14.3)
CREATE TABLE IF NOT EXISTS idempotency_key (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        UUID NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  actor_id      UUID NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  idem_key      TEXT NOT NULL,
  method        TEXT NOT NULL,
  route_path    TEXT NOT NULL,
  request_hash  TEXT NOT NULL,
  state         TEXT NOT NULL DEFAULT 'IN_PROGRESS' CHECK (state IN ('IN_PROGRESS', 'COMPLETED')),
  status_code   INTEGER,
  response_body JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at    TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '24 hours'),
  UNIQUE (org_id, actor_id, method, route_path, idem_key)
);

CREATE INDEX IF NOT EXISTS idx_idempotency_key_expires ON idempotency_key(expires_at);
GRANT ALL PRIVILEGES ON TABLE idempotency_key TO resihub_app;
```
2. Tạo `api/test/contractRemainingFixes.test.js` với subtest kiểm tra:
   - `MANAGER` tạo `DRAFT` kèm 2 dịch vụ (`MOTORBIKE_PARKING` qty `2`, `note: '59A1-123.45'` giá danh mục + `INTERNET_FIBER` giá ưu đãi `180000`) và `service_prices: [{ service_code: 'ELECTRICITY', unit_price: 3600 }]`.
   - Kiểm tra `GET /:id/template` chứa `'59A1-123.45'`, `'2 xe/tháng'` và `'3.600'`.
   - `MANAGER` gọi `PATCH /api/v1/contracts/:id` cập nhật `services` (bỏ `INTERNET_FIBER`, đổi `MOTORBIKE_PARKING` sang qty `1`, `note: '59X3-999.99'`) và truyền `service_prices: [{ service_code: 'ELECTRICITY', unit_price: null }]` để khôi phục giá điện chuẩn (Review Focus #3).
   - Xác nhận DB `service_subscription` chỉ còn đúng 1 dòng `MOTORBIKE_PARKING` (`quantity = 1`, `note = '59X3-999.99'`), `contract_service_price` đã gỡ cả `INTERNET_FIBER` lẫn `ELECTRICITY`, và `invoice_schedule` cập nhật lại đúng `expected_fixed_services = 120000`.

- [ ] **Step 2: Chạy migration & chạy test để xác nhận thất bại**

Run: `node api/src/db/migrate.js && node --test api/test/contractRemainingFixes.test.js`
Expected: Migration `042` chạy thành công; test FAIL tại bước `PATCH /api/v1/contracts/:id` do endpoint chưa xử lý `services[]` và `service_prices[]`.

- [ ] **Step 3: Triển khai `syncDraftContractServicesInTx` và mở rộng `PATCH /api/v1/contracts/:id`**

Trong `api/src/routes/contracts.js`:
1. Viết `syncDraftContractServicesInTx(client, { contractId, orgId, buildingId, apartmentId, startDateStr, actorId, services, servicePrices, replaceExistingSubscriptions = false })`:
   - Validate `note` (nếu có, cắt khoảng trắng, dài `> 500` trả `422 INVALID_SERVICE_NOTE`).
   - Khi `replaceExistingSubscriptions === true` và `services !== undefined`:
     - Lấy danh sách mã `sc.code` của các `service_subscription` `PENDING_APPROVAL` hiện có trên hợp đồng.
     - `DELETE FROM service_subscription WHERE contract_id = $1 AND status = 'PENDING_APPROVAL'`.
     - Xóa các dòng `contract_service_price` thuộc các mã `sc.code` cũ đó để tránh treo giá ghi đè của gói vừa bỏ chọn.
   - Chèn mới từng phần tử của `services[]` (tính `prorata_amount` theo `startDateStr`, lưu `note`, chỉ ghi `contract_service_price` khi `effectivePrice !== catalogPrice` hoặc có `custom_unit_price`).
   - Với `servicePrices[]`: nếu `unit_price === null || unit_price === ''`, chạy `DELETE FROM contract_service_price WHERE contract_id = $1 AND service_code = $2`; ngược lại validate `>= 0` và `INSERT ... ON CONFLICT DO UPDATE`.
2. Dùng `syncDraftContractServicesInTx` tại cả `POST /api/v1/contracts` và `PATCH /api/v1/contracts/:id` (nếu `PATCH /:id` không truyền `services`, giữ nguyên logic cập nhật `start_date`/`apartment_id`/`prorata_amount` cho các subscription hiện có). Trả thêm `service_subscriptions` và `invoice_schedule` trong response `PATCH /:id`.

- [ ] **Step 4: Chạy lại integration test để xác nhận PASS**

Run: `node --test api/test/contractRemainingFixes.test.js`
Expected: PASS.

- [ ] **Step 5: Commit Task 2**

```bash
git add api/src/db/migrations/042_idempotency_and_draft_services_rls.sql api/src/routes/contracts.js api/test/contractRemainingFixes.test.js
git commit -m "feat(contracts): allow editing draft service subscriptions, vehicle notes, and meter price overrides"
```

---

### Task 3: Middleware `Idempotency-Key` cho các API Tác nghiệp Hợp đồng (`PRD Mục 14.3`)

**Files:**
- Create: `api/src/middleware/idempotency.js`
- Modify: `api/src/routes/contracts.js:1030,2792,2915,3015,4181,4299`
- Modify: `api/test/contractRemainingFixes.test.js`

**Interfaces:**
- Consumes: `adminPool` từ `api/src/db/client.js`, bảng `idempotency_key` từ Migration `042`.
- Produces:
  - `canonicalHashBody(body: unknown) -> string` (SHA-256 hex ổn định không phụ thuộc thứ tự key object).
  - `idempotencyGuard(options?: { requireHeader?: boolean }) -> express.RequestHandler` trong `api/src/middleware/idempotency.js`.
  - Áp dụng trên 6 route `POST` của `api/src/routes/contracts.js`: `/`, `/:id/activate`, `/:id/approve`, `/:id/renew`, `/:id/terminate`, `/:id/transfer-room`.

- [ ] **Step 1: Bổ sung integration test thất bại cho `Idempotency-Key` trong `api/test/contractRemainingFixes.test.js`**

Kiểm tra đủ 5 trường hợp:
1. Gửi 2 lần `POST /api/v1/contracts` với cùng `Idempotency-Key` và cùng payload → cả 2 lần trả `201` với cùng `data.id`, chỉ có đúng 1 hợp đồng được tạo trong DB và lần 2 có header `Idempotent-Replayed: true`.
2. Gửi lại cùng `Idempotency-Key` nhưng thay đổi `rent_amount` → nhận `409 IDEMPOTENCY_KEY_CONFLICT` (Review Focus #4).
3. Trên hợp đồng giảm giá `< 90% base_rent` đã đính kèm scan, gửi 2 lần `POST /api/v1/contracts/:id/activate` với cùng `Idempotency-Key` → cả 2 lần đều trả `409` với `code: 'PRICE_NEEDS_APPROVAL'` (lần 2 có `Idempotent-Replayed: true`), không bị biến thành `INVALID_STATUS` (Review Focus #4).
4. Header `Idempotency-Key` dài `> 255` ký tự → nhận `400 INVALID_IDEMPOTENCY_KEY`.
5. Khi bật `process.env.REQUIRE_IDEMPOTENCY_KEY = 'true'` (khôi phục lại trong `t.after`), gọi `POST /api/v1/contracts` thiếu header → nhận `400 IDEMPOTENCY_KEY_REQUIRED`.

- [ ] **Step 2: Chạy test để xác nhận thất bại**

Run: `node --test api/test/contractRemainingFixes.test.js`
Expected: FAIL do chưa gắn `idempotencyGuard` (lần gọi thứ 2 tạo trùng bị văng `OVERLAP_CONTRACT` thay vì `201` replay).

- [ ] **Step 3: Triển khai `api/src/middleware/idempotency.js` và gắn vào `contracts.js`**

1. Trong `api/src/middleware/idempotency.js`:
   - Đọc `req.get('Idempotency-Key')`. Nếu không có header: kiểm tra `options.requireHeader ?? (process.env.REQUIRE_IDEMPOTENCY_KEY === 'true')` → nếu `true` trả `400 IDEMPOTENCY_KEY_REQUIRED`, ngược lại `return next()`.
   - Kiểm tra độ dài sau `trim()` trong `1..255` → vi phạm trả `400 INVALID_IDEMPOTENCY_KEY`.
   - Chuẩn hóa `routePath = req.baseUrl + req.path`, tính `requestHash = canonicalHashBody(req.body)`.
   - Xóa dòng hết hạn (`DELETE FROM idempotency_key WHERE org_id = $1 AND actor_id = $2 AND method = $3 AND route_path = $4 AND idem_key = $5 AND expires_at <= NOW()`).
   - Thực hiện `INSERT INTO idempotency_key (...) VALUES (...) ON CONFLICT DO NOTHING RETURNING id`:
     - Nếu không chèn được (đã tồn tại): `SELECT *` dòng hiện có:
       - Nếu `request_hash !== requestHash` → trả `409 IDEMPOTENCY_KEY_CONFLICT`.
       - Nếu `state === 'IN_PROGRESS'` → trả `409 IDEMPOTENCY_IN_PROGRESS`.
       - Nếu `state === 'COMPLETED'` → đặt `res.set('Idempotent-Replayed', 'true')` và trả `res.status(row.status_code).json(row.response_body)`.
     - Nếu chèn thành công (`recordId`): bọc `res.json(payload)`:
       - Nếu `(res.statusCode >= 200 && res.statusCode < 300)` hoặc `payload?.code === 'PRICE_NEEDS_APPROVAL'`, cập nhật `state = 'COMPLETED', status_code = $1, response_body = $2`.
       - Ngược lại (lỗi validate `4xx` chưa commit hoặc lỗi `5xx`), xóa dòng `recordId` để client sửa lỗi hoặc thử lại bình thường. (Thêm `res.on('close', ...)` dọn dòng `IN_PROGRESS` nếu kết nối đứt trước khi phản hồi).
2. Gắn `idempotencyGuard()` sau `requireRole(...)` trên 6 route `POST` của `api/src/routes/contracts.js` (`/`, `/:id/activate`, `/:id/approve`, `/:id/renew`, `/:id/terminate`, `/:id/transfer-room`).

- [ ] **Step 4: Chạy lại integration test và kiểm tra hồi quy với `contractCreationFixes.test.js`**

Run: `node --test api/test/contractRemainingFixes.test.js api/test/contractCreationFixes.test.js`
Expected: PASS 100%.

- [ ] **Step 5: Commit Task 3**

```bash
git add api/src/middleware/idempotency.js api/src/routes/contracts.js api/test/contractRemainingFixes.test.js
git commit -m "feat(contracts): add Idempotency-Key middleware for contract write transitions"
```

---

### Task 4: Đính kèm Ảnh CCCD Mặt trước/sau khi Tạo mới Cư dân Inline (`new_tenant`) & Dọn `notifyContractStakeholders`

**Files:**
- Modify: `api/src/routes/contracts.js:164-179,1213-1230`
- Modify: `api/test/contractRemainingFixes.test.js`

**Interfaces:**
- Consumes: `saveBase64Image`, `IMAGE_MIME_RE`, `MAX_IMAGE_BYTES` từ `api/src/services/imageUpload.js`.
- Produces:
  - Mở rộng `new_tenant` trong `POST /api/v1/contracts`: nhận tùy chọn `id_image_front?: string` và `id_image_back?: string` (`data:image/jpeg|png;base64,...`, tối đa `5MB`/ảnh).
  - Bản ghi `attachment` (`owner_entity = 'person'`, `owner_id = personId`) + cập nhật `person.id_images` (`{ attachmentId, side }`) tương thích 100% với `GET /api/v1/tenants/:id/id-images`.

- [ ] **Step 1: Bổ sung integration test thất bại cho upload ảnh CCCD inline & rollback nguyên tử trong `api/test/contractRemainingFixes.test.js`**

Kiểm tra:
1. Gọi `POST /api/v1/contracts` với `new_tenant` có `id_image_front` và `id_image_back` là chuỗi PNG base64 hợp lệ → trả `201`; gọi tiếp `GET /api/v1/tenants/:primary_tenant_id/id-images` trả đủ 2 ảnh với `side: 'front'` và `side: 'back'`; `OWNER` cố xem qua `GET /api/v1/attachments/:attId/view` vẫn bị chặn `403` theo PRD `13.5`.
2. Gọi `POST /api/v1/contracts` với `new_tenant.id_image_front = 'data:application/pdf;base64,...'` (sai định dạng ảnh CCCD) → trả `400 VALIDATION_ERROR` và kiểm tra DB xác nhận SĐT của `new_tenant` **không** bị lưu sót trong bảng `person` hay `contract` (Review Focus #5).

- [ ] **Step 2: Chạy test để xác nhận thất bại**

Run: `node --test api/test/contractRemainingFixes.test.js`
Expected: FAIL do `POST /api/v1/contracts` hiện bỏ qua `id_image_front` / `id_image_back` (`id-images` trả mảng rỗng).

- [ ] **Step 3: Triển khai lưu ảnh CCCD inline trong `POST /api/v1/contracts` và sửa `notifyContractStakeholders`**

Trong `api/src/routes/contracts.js`:
1. Ngay sau `inlineTenantResult = await upsertPersonAndTenantInTx(...)` trong `POST /api/v1/contracts`:
   - Kiểm tra `new_tenant.id_image_front` (`side = 'front'`) và `new_tenant.id_image_back` (`side = 'back'`).
   - Với mỗi ảnh được truyền (không rỗng): gọi `saveBase64Image({ imageBase64, folder: 'person', entityId: inlineTenantResult.personId, entity: 'person', ownerId: inlineTenantResult.personId, req, query: (sql, params) => client.query(sql, params) })`.
   - Nếu `saved.error`: ném lỗi `{ httpStatus: 400, code: saved.error.code, message: saved.error.message }` để khối `catch` thực hiện `await client.query('ROLLBACK')` sạch sẽ (kèm `unlink` file vừa ghi nếu có).
   - Cập nhật `UPDATE person SET id_images = array_append(COALESCE(id_images, '{}'), $1) WHERE id = $2` và ghi `audit_log` (`action = 'UPLOAD'`, `entity = 'attachment'`).
2. Tại `notifyContractStakeholders` (`contracts.js:165-177`):
   - Đổi `if (acct?.userId)` thành `const ensuredUserId = typeof acct === 'string' ? acct : acct?.userId; if (ensuredUserId) { residentUserIds.add(String(ensuredUserId)); continue; }` để tránh luôn chạy câu `SELECT` thừa khi `ensureResidentAccount` đã trả về `userId`.

- [ ] **Step 4: Chạy lại integration test để xác nhận PASS**

Run: `node --test api/test/contractRemainingFixes.test.js`
Expected: PASS.

- [ ] **Step 5: Commit Task 4**

```bash
git add api/src/routes/contracts.js api/test/contractRemainingFixes.test.js
git commit -m "feat(contracts): support inline CCCD front/back upload for new tenants on contract creation"
```

---

### Task 5: Cập nhật Giao diện Tạo & Chỉnh sửa Hợp đồng (`ContractsPage.jsx`, `ContractDetailPage.jsx`, `contracts.service.js`)

**Files:**
- Modify: `frontend/src/services/contracts.service.js`
- Modify: `frontend/src/pages/admin/contracts/ContractsPage.jsx`
- Modify: `frontend/src/pages/admin/contracts/ContractDetailPage.jsx`
- Modify: `frontend/src/utils/__tests__/contractCreationUi.test.js`

**Interfaces:**
- Consumes:
  - Backend payload mới từ Task 2, Task 3, Task 4 (`services[].note`, `PATCH /:id` nhận `services` + `service_prices`, header `Idempotency-Key`, `new_tenant.id_image_front` / `id_image_back`).
  - Component `FileUpload` từ `frontend/src/components/ui/FileUpload.jsx` và `servicesService.list` từ `frontend/src/services/services.service.js`.
- Produces:
  - Helper `createIdempotencyKey()` & truyền `{ headers: { 'Idempotency-Key': key } }` trong `frontend/src/services/contracts.service.js`.
  - Ô nhập `Ghi chú / Biển số xe`, 2 ô đính kèm ảnh CCCD mặt trước/sau khi tạo mới cư dân, và gợi ý tiền cọc giữ chỗ trong `ContractsPage.jsx`.
  - Hiển thị cột `Ghi chú / Biển số` và chỉnh sửa đầy đủ gói dịch vụ đi kèm + giá Điện/Nước riêng trong Modal **Chỉnh sửa hợp đồng nháp** trên `ContractDetailPage.jsx`.

- [ ] **Step 1: Bổ sung UI test thất bại trong `frontend/src/utils/__tests__/contractCreationUi.test.js`**

Thêm các kiểm thử xác nhận:
1. `contracts.service.js` xuất `createIdempotencyKey` và đính kèm header `'Idempotency-Key'` trong `create`, `activate`, `approve`, `renew`, `terminate`, `transferRoom`.
2. `ContractsPage.jsx` có trường `id_image_front` / `id_image_back` (sử dụng `FileUpload` với `maxSizeMB={5}`) trong nhánh `tenantMode === 'new'` và gửi `note` trong từng phần tử `servicesPayload`.
3. `ContractDetailPage.jsx` hiển thị `row.note` ở bảng `Dịch vụ đi kèm theo hợp đồng` và gửi `services` + `service_prices` trong `handleSaveDraft` (`contractsService.update`).

- [ ] **Step 2: Chạy UI test để xác nhận thất bại**

Run: `node --test frontend/src/utils/__tests__/contractCreationUi.test.js`
Expected: FAIL ở các subtest mới.

- [ ] **Step 3: Triển khai cập nhật Frontend trên 3 file**

1. `frontend/src/services/contracts.service.js`:
   - Tạo `export function createIdempotencyKey()` (dùng `globalThis.crypto?.randomUUID?.()` kèm fallback timestamp + random hex) và helper `withIdempotency(idempotencyKey)`.
   - Cập nhật `create(payload, options)`, `activate(id, payload, options)`, `approve(id, payload, options)`, `renew(id, payload, options)`, `terminate(id, payload, options)`, `transferRoom(id, payload, options)` luôn gắn header `'Idempotency-Key': options?.idempotencyKey || createIdempotencyKey()`.
2. `frontend/src/pages/admin/contracts/ContractsPage.jsx`:
   - Lưu `createIdemKeyRef` (khởi tạo lại khi mở modal hoặc khi người dùng sửa form; giữ nguyên nếu mạng rớt để bấm Lưu lại không tạo bản trùng).
   - Trong `newTenantForm`, thêm `id_image_front: ''`, `id_image_back: ''` và 2 component `FileUpload` (`accept="image/jpeg,image/png"`, `maxSizeMB={5}`, nhãn `"Ảnh CCCD / Hộ chiếu mặt trước (tùy chọn)"` và `"Ảnh CCCD mặt sau (tùy chọn)"`), gửi vào `payload.new_tenant` khi có chọn ảnh.
   - Trong khối dịch vụ Bước 4, thêm trường `note` cho mỗi dịch vụ đang tích chọn (`placeholder` gợi ý biển số xe nếu `svc.category === 'PARKING'`, ngược lại gợi ý ghi chú gói) và gửi `note` trong `servicesPayload`.
   - Dưới ô `Tiền đặt cọc bảo đảm`, khi `createForm.reservation_id` khớp phiếu giữ chỗ đang chọn, hiển thị rõ gợi ý số tiền giữ chỗ đã thu để tránh nhập nhầm.
3. `frontend/src/pages/admin/contracts/ContractDetailPage.jsx`:
   - Bổ sung cột `Ghi chú / Biển số` (`row.note || '—'`) vào `DataTable` dịch vụ đi kèm ở tab `schedule`.
   - Mở rộng `handleOpenEditDraft` và Modal **Chỉnh sửa hợp đồng nháp** (`size="xl"`): tải `servicesService.list()`, dựng state `draftSelectedServices` (khởi tạo từ `serviceSubscriptions` đang `PENDING_APPROVAL`/`ACTIVE`) + `draftCustomMeterPrices` (khởi tạo từ `servicePrices` mã `ELECTRICITY` / `WATER`), và gửi cả `services` + `service_prices` trong `contractsService.update(id, ...)`.
   - Giữ `actionIdemKeyRef` cho từng lượt mở hộp thoại Kích hoạt / Duyệt / Gia hạn / Chấm dứt / Chuyển phòng và truyền vào `contractsService`.

- [ ] **Step 4: Chạy toàn bộ bộ test Frontend + Backend và kiểm tra `vite build`**

Run:
```powershell
node --test frontend/src/utils/__tests__/contractCreationUi.test.js
npm --prefix frontend run build
node --test api/test/contractTemplate.test.js api/test/invoiceSchedule.test.js api/test/contractCreationFixes.test.js api/test/contractRemainingFixes.test.js
```
Expected: Tất cả unit test, integration test và `vite build` đều PASS không có lỗi.

- [ ] **Step 5: Commit Task 5**

```bash
git add frontend/src/services/contracts.service.js frontend/src/pages/admin/contracts/ContractsPage.jsx frontend/src/pages/admin/contracts/ContractDetailPage.jsx frontend/src/utils/__tests__/contractCreationUi.test.js
git commit -m "feat(ui): add service notes, draft service editing, inline CCCD upload, and Idempotency-Key"
```

