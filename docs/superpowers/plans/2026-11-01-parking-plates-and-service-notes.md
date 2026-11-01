# Tách Biển số xe Bắt buộc cho Dịch vụ Gửi xe & Ghi chú Dịch vụ Tùy chọn Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tách riêng và bắt buộc nhập đủ biển số xe (`vehicle_plates`) theo số lượng đối với dịch vụ Gửi xe / Đỗ xe (`category = 'PARKING'`), giữ ô `Ghi chú dịch vụ (tùy chọn)` độc lập cho mọi dịch vụ (bỏ chữ `/ Biển số xe`), đồng bộ xuyên suốt Tạo/Sửa hợp đồng nháp, Bản in A4, Quản lý gán dịch vụ và Cổng cư dân.

**Architecture:** Bổ sung cột `vehicle_plates TEXT[] NOT NULL DEFAULT '{}'` vào bảng `service_subscription` qua Migration `043` để lưu danh sách biển số tách biệt hoàn toàn với cột `note` (tránh mất biển số khi hủy dịch vụ ghi đè lý do hủy vào `note`). Đặt hàm chuẩn hóa dùng chung `validateAndNormalizeSubscriptionMeta` cho cả 3 nhóm API (`contracts.js`, `services.js`, `resident.js`) kèm cập nhật `contractTemplate.js`, đồng thời xây dựng helper + component dùng chung `ServiceSubscriptionMetaFields` cho 4 màn hình React.

**Tech Stack:** Node.js (ESM), Express 4, PostgreSQL 16 (RLS), `node:test`, React 19, Vite 8, Tailwind CSS.

**Spec:** `docs/superpowers/specs/2026-11-01-parking-plates-and-service-notes-design.md`

## Global Constraints

- **Phân loại dịch vụ gửi xe:** Chỉ các dịch vụ có `category === 'PARKING'` (không phân biệt hoa/thường) mới bắt buộc `vehicle_plates` và áp trần `1 <= quantity <= 10`; các dịch vụ `category !== 'PARKING'` (kể cả `QUANTITY` như dọn vệ sinh theo lần/tháng) không bị giới hạn trần 10 và luôn lưu `vehicle_plates = '{}'`.
- **Quy tắc biển số xe (`vehicle_plates`):** Phải là mảng có đúng `quantity` phần tử; mỗi biển số sau `trim()` có độ dài `2..30` ký tự (không ép regex cơ giới để cho phép `"Xe đạp"`, `"Chờ bấm biển"`), không được trùng nhau trong cùng 1 gói đăng ký (so sánh sau khi gộp khoảng trắng thừa + `toUpperCase()`).
- **Quy tắc ghi chú (`note`):** Tùy chọn cho mọi dịch vụ (cả `PARKING` lẫn khác `PARKING`), độ dài sau `trim()` tối đa `500` ký tự; nhãn hiển thị thống nhất là `"Ghi chú dịch vụ (tùy chọn)"` (không chứa `"/ Biển số xe"`).
- **Bảo toàn biển số khi hủy/cập nhật trạng thái:** `PATCH /api/v1/service-subscriptions/:id` và `PATCH /api/v1/resident/services/:id/cancel` khi cập nhật `note` (lý do hủy) phải giữ nguyên cột `vehicle_plates` đã lưu.
- **Tương thích ngược & Chống XSS bản in A4:** Bản ghi `service_subscription` cũ có `vehicle_plates = '{}'` vẫn hiển thị bình thường; mọi phần tử `vehicle_plates` và `note` trên `GET /api/v1/contracts/:id/template` phải đi qua `escapeTemplateHtml`.

## Review Focus

1. **Trùng biển số khác hoa/thường hoặc dư khoảng trắng trong cùng gói (VD: `["59a1-123.45", "  59A1-123.45 "]` với `quantity = 2`):** Phải bị chặn `422 DUPLICATE_VEHICLE_PLATE` ở Backend và báo lỗi đỏ dưới ô `#2` ở Frontend (kiểm thử tại Task 1 & Task 3).
2. **Payload HTML/XSS cài trong `vehicle_plates` (VD: `["59A1-<img src=x onerror=alert(1)>"]`) khi xuất mẫu in A4 (`GET /api/v1/contracts/:id/template`):** HTML trả về phải escape thành `&lt;img...&gt;`, tuyệt đối không render thẻ sống (kiểm thử tại Task 1 & Task 2).
3. **Cư dân gửi yêu cầu hủy gói gửi xe kèm lý do hủy (`PATCH /api/v1/resident/services/:id/cancel` với `note: 'Bán xe không gửi nữa'`):** Cột `note` đổi sang lý do hủy nhưng `vehicle_plates` vẫn giữ nguyên danh sách biển số xe đã đăng ký để bảo vệ thu hồi thẻ từ (kiểm thử tại Task 2).
4. **Dịch vụ `category !== 'PARKING'` có `billing_type = 'QUANTITY'` đặt `quantity = 12` hoặc gửi kèm `vehicle_plates: ['30A-111.11']`:** Không bị chặn bởi trần `10` xe của `PARKING` và tự động làm sạch `vehicle_plates` về `[]` trong DB (kiểm thử tại Task 1 & Task 2).
5. **Người dùng nhập 2 biển số khi `Số lượng = 2` rồi giảm `Số lượng` xuống `1` trên UI:** Payload gửi đi phải tự động cắt khớp đúng `quantity = 1` phần tử (`['59A1-111.11']`), không gửi dư phần tử thứ 2 gây lỗi lệch số lượng (kiểm thử tại Task 3).

---

## File Structure

### Database & Backend (`api/`)
- **Create:** `api/src/db/migrations/043_service_subscription_vehicle_plates.sql` — Thêm cột `vehicle_plates TEXT[] NOT NULL DEFAULT '{}'` vào bảng `service_subscription`.
- **Create:** `api/src/services/serviceSubscriptionMeta.js` — Xuất `MAX_PARKING_QUANTITY`, `isParkingCategory(category)` và `validateAndNormalizeSubscriptionMeta({ category, billingType, quantity, vehiclePlates, note })`.
- **Modify:** `api/src/services/contractTemplate.js` — Bổ sung mảng `vehiclePlates` vào từng dòng trả về của `buildContractTemplateServiceRows`.
- **Modify:** `api/src/routes/contracts.js` — Gọi `validateAndNormalizeSubscriptionMeta` trong `syncDraftContractServicesInTx`, lưu `vehicle_plates`, truy vấn `ss.vehicle_plates` và kết xuất `Biển số xe:` tách biệt với `Ghi chú:` trong `GET /:id/template`.
- **Modify:** `api/src/routes/services.js` — Gọi `validateAndNormalizeSubscriptionMeta` trong `POST /api/v1/service-subscriptions` và lưu `vehicle_plates`.
- **Modify:** `api/src/routes/resident.js` — Gọi `validateAndNormalizeSubscriptionMeta` trong `POST /api/v1/resident/services` và lưu `vehicle_plates`.
- **Create:** `api/test/serviceSubscriptionMeta.test.js` — Unit test cho `serviceSubscriptionMeta.js`.
- **Modify:** `api/test/contractTemplate.test.js` — Unit test cho `vehiclePlates` trên `buildContractTemplateServiceRows`.
- **Create:** `api/test/parkingPlatesSync.test.js` — Integration test toàn diện cho hợp đồng nháp, sửa nháp, bản in A4, quản lý gán dịch vụ, cư dân đăng ký & hủy dịch vụ gửi xe.
- **Modify:** `api/test/contractCreationFixes.test.js` & `api/test/contractRemainingFixes.test.js` — Bổ sung `vehicle_plates` hợp lệ cho các fixture `MOTORBIKE_PARKING` hiện có.

### Frontend (`frontend/`)
- **Create:** `frontend/src/utils/serviceSubscriptionMeta.js` — Xuất `MAX_PARKING_QUANTITY`, `isParkingService`, `syncVehiclePlatesArray`, `validateServiceMetaInput`.
- **Create:** `frontend/src/components/common/ServiceSubscriptionMetaFields.jsx` — Xuất component nhập liệu `ServiceSubscriptionMetaFields` và component hiển thị `VehiclePlatesBadges`.
- **Modify:** `frontend/src/pages/admin/contracts/ContractsPage.jsx` — Đồng bộ nhập/kiểm tra `vehicle_plates` + `note` khi tạo hợp đồng nháp.
- **Modify:** `frontend/src/pages/admin/contracts/ContractDetailPage.jsx` — Đồng bộ nạp/sửa `vehicle_plates` + `note` trong Modal Sửa hợp đồng nháp và hiển thị `VehiclePlatesBadges` ở bảng dịch vụ đi kèm.
- **Modify:** `frontend/src/pages/admin/services/SubscriptionsPage.jsx` — Đồng bộ nhập `vehicle_plates` + `note` khi gán dịch vụ, hiển thị `VehiclePlatesBadges` và lọc tìm kiếm theo biển số.
- **Modify:** `frontend/src/pages/resident/tabs/ServicesTab.jsx` — Đồng bộ nhập `vehicle_plates` + `note` khi cư dân đăng ký dịch vụ và hiển thị `VehiclePlatesBadges` trên thẻ dịch vụ.
- **Create:** `frontend/src/utils/__tests__/parkingPlatesUi.test.js` — Unit test cho `frontend/src/utils/serviceSubscriptionMeta.js` và kiểm thử cấu trúc UI trên cả 4 trang.

---

### Task 1: Migration `043`, Bộ chuẩn hóa `serviceSubscriptionMeta.js` & Cập nhật `contractTemplate.js`

**Files:**
- Create: `api/src/db/migrations/043_service_subscription_vehicle_plates.sql`
- Create: `api/src/services/serviceSubscriptionMeta.js`
- Modify: `api/src/services/contractTemplate.js:81-132`
- Create: `api/test/serviceSubscriptionMeta.test.js`
- Modify: `api/test/contractTemplate.test.js`

**Interfaces:**
- Consumes: `escapeTemplateHtml`, `buildContractTemplateServiceRows` từ `api/src/services/contractTemplate.js`.
- Produces:
  - Cột `service_subscription.vehicle_plates TEXT[] NOT NULL DEFAULT '{}'`.
  - `MAX_PARKING_QUANTITY = 10` trong `api/src/services/serviceSubscriptionMeta.js`.
  - `isParkingCategory(category: unknown) -> boolean` trong `api/src/services/serviceSubscriptionMeta.js`.
  - `validateAndNormalizeSubscriptionMeta({ category, billingType, quantity, vehiclePlates, note }) -> { quantity: number, vehiclePlates: string[], note: string | null }` (ném `Error` gắn `httpStatus = 422` và `code` thuộc `'INVALID_SERVICE_QUANTITY' | 'VEHICLE_PLATES_REQUIRED' | 'INVALID_VEHICLE_PLATES' | 'DUPLICATE_VEHICLE_PLATE' | 'INVALID_SERVICE_NOTE'`).
  - `buildContractTemplateServiceRows(...)` trả thêm `vehiclePlates: string[]` trên mỗi dòng kết quả.

- [ ] **Step 1: Viết unit test thất bại cho `serviceSubscriptionMeta.js` và `contractTemplate.js`**

Tạo `api/test/serviceSubscriptionMeta.test.js` và thêm case vào `api/test/contractTemplate.test.js`:
1. `PARKING` với `quantity = 2` và `vehiclePlates = [' 59A1-123.45 ', 'Xe đạp #2']`, `note = 'Hầm B1'` → trả `{ quantity: 2, vehiclePlates: ['59A1-123.45', 'Xe đạp #2'], note: 'Hầm B1' }`.
2. `PARKING` thiếu `vehiclePlates` hoặc số phần tử khác `quantity` → ném `422` (`VEHICLE_PLATES_REQUIRED` / `INVALID_VEHICLE_PLATES`); phần tử `< 2` hoặc `> 30` ký tự → `422 INVALID_VEHICLE_PLATES`; `quantity > 10` → `422 INVALID_SERVICE_QUANTITY`.
3. `PARKING` trùng biển số khác hoa/thường & khoảng trắng `['59a1-123.45', '  59A1-123.45 ']` → ném `422 DUPLICATE_VEHICLE_PLATE` (Review Focus #1).
4. Dịch vụ `CLEANING` (`billingType = 'QUANTITY'`, `quantity = 12`, gửi kèm `vehiclePlates: ['30A-111.11']`) → cho phép `quantity = 12` và trả `vehiclePlates: []` (Review Focus #4); `FIXED` tự ép `quantity = 1`; `note > 500` ký tự → ném `422 INVALID_SERVICE_NOTE`.
5. `buildContractTemplateServiceRows` trích xuất sạch mảng `vehicle_plates: ['59A1-123.45', '59B2-678.90']` sang `row.vehiclePlates` độc lập với `row.note`.

- [ ] **Step 2: Chạy unit test để xác nhận thất bại**

Run: `node --test api/test/serviceSubscriptionMeta.test.js api/test/contractTemplate.test.js`
Expected: FAIL với lỗi `Cannot find module '../src/services/serviceSubscriptionMeta.js'`.

- [ ] **Step 3: Tạo Migration `043`, cài đặt `serviceSubscriptionMeta.js` và cập nhật `contractTemplate.js`**

1. Tạo `api/src/db/migrations/043_service_subscription_vehicle_plates.sql`:
```sql
-- 043_service_subscription_vehicle_plates.sql
-- Tách mảng biển số xe (vehicle_plates) riêng khỏi cột ghi chú (note) cho dịch vụ gửi/đỗ xe
ALTER TABLE service_subscription
  ADD COLUMN IF NOT EXISTS vehicle_plates TEXT[] NOT NULL DEFAULT '{}';
```
2. Cài đặt `api/src/services/serviceSubscriptionMeta.js` theo đúng chữ ký và mã lỗi ở Step 1.
3. Trong `api/src/services/contractTemplate.js`: chuẩn hóa `sub?.vehicle_plates` (lọc chuỗi không rỗng đã `trim`) gán vào `vehiclePlates` trên các dòng dịch vụ đăng ký (và `[]` cho các dòng Điện/Nước/giá lẻ).

- [ ] **Step 4: Chạy migration và chạy lại unit test để xác nhận PASS**

Run: `node api/src/db/migrate.js && node --test api/test/serviceSubscriptionMeta.test.js api/test/contractTemplate.test.js`
Expected: Migration `043` thành công; toàn bộ unit test PASS.

- [ ] **Step 5: Commit Task 1**

```bash
git add api/src/db/migrations/043_service_subscription_vehicle_plates.sql api/src/services/serviceSubscriptionMeta.js api/src/services/contractTemplate.js api/test/serviceSubscriptionMeta.test.js api/test/contractTemplate.test.js
git commit -m "feat(services): add vehicle_plates column and subscription metadata validator"
```

---

### Task 2: Đồng bộ API Hợp đồng (`contracts.js`), Quản lý dịch vụ (`services.js`) & Cổng cư dân (`resident.js`)

**Files:**
- Modify: `api/src/routes/contracts.js:218-287,3973-4048`
- Modify: `api/src/routes/services.js:222-314`
- Modify: `api/src/routes/resident.js:1189-1286`
- Create: `api/test/parkingPlatesSync.test.js`
- Modify: `api/test/contractCreationFixes.test.js:563-567,732-736`
- Modify: `api/test/contractRemainingFixes.test.js:212-278`

**Interfaces:**
- Consumes: `validateAndNormalizeSubscriptionMeta` từ `api/src/services/serviceSubscriptionMeta.js` và `buildContractTemplateServiceRows`, `escapeTemplateHtml` từ `api/src/services/contractTemplate.js` (Task 1).
- Produces:
  - `POST /api/v1/contracts` & `PATCH /api/v1/contracts/:id`: nhận `services[].vehicle_plates?: string[]` và `services[].note?: string`, lưu cột `vehicle_plates` + `note` vào `service_subscription`.
  - `GET /api/v1/contracts/:id/template`: hiển thị `Biển số xe: ...` (đã escape HTML) và `Ghi chú: ...` trong bảng Điều 5.
  - `POST /api/v1/service-subscriptions` & `POST /api/v1/resident/services`: nhận `vehicle_plates?: string[]` và `note?: string`, trả `422` khi vi phạm quy tắc `PARKING`, lưu `vehicle_plates` vào DB.

- [ ] **Step 1: Viết integration test thất bại `api/test/parkingPlatesSync.test.js` và cập nhật fixture cũ**

Trong `api/test/parkingPlatesSync.test.js`, kiểm tra đủ 6 kịch bản:
1. `POST /api/v1/contracts` với `MOTORBIKE_PARKING` (`quantity: 2`) thiếu `vehicle_plates` hoặc chỉ gửi 1 biển số → trả `422` (`VEHICLE_PLATES_REQUIRED` / `INVALID_VEHICLE_PLATES`).
2. `POST /api/v1/contracts` với `MOTORBIKE_PARKING` (`quantity: 2`, `vehicle_plates: ['59A1-123.45', '59B2-<img src=x onerror=alert(1)>']`, `note: 'Thẻ từ #01, #02'`) + `INTERNET_FIBER` (`note: 'Gói 300M'`, gửi kèm rác `vehicle_plates: ['IGNORE']`) → trả `201`; `INTERNET_FIBER` lưu `vehicle_plates = []` (Review Focus #4); `GET /api/v1/contracts/:id/template` chứa `'Biển số xe:'`, `'59A1-123.45'`, `'&lt;img src=x onerror=alert(1)&gt;'` (không lọt thẻ `<img` sống — Review Focus #2) và `'Thẻ từ #01, #02'`.
3. `PATCH /api/v1/contracts/:id` trên hợp đồng `DRAFT` đổi `MOTORBIKE_PARKING` sang `quantity: 1`, `vehicle_plates: ['Xe đạp điện #1']`, `note: ''` → trả `200`, `service_subscriptions[0].vehicle_plates` đúng `['Xe đạp điện #1']` và `note === null`.
4. `POST /api/v1/service-subscriptions` (MANAGER gán dịch vụ lẻ) cho `CAR_PARKING` thiếu biển số bị chặn `422`; có đủ `vehicle_plates: ['51K-888.88']` → trả `201` kèm `data.vehicle_plates = ['51K-888.88']`.
5. `POST /api/v1/resident/services` (RESIDENT đăng ký thêm xe trên HĐ `ACTIVE`) thiếu biển số hoặc trùng biển số bị chặn `422`; gửi `quantity: 2, vehicle_plates: ['29B1-111.11', '29B1-222.22'], note: 'Xe gia đình'` → trả `201`.
6. Cư dân gọi `PATCH /api/v1/resident/services/:id/cancel` với `{ end_date, note: 'Bán xe không gửi nữa' }` → `note` đổi thành `'Bán xe không gửi nữa'` nhưng `vehicle_plates` vẫn giữ nguyên `['29B1-111.11', '29B1-222.22']` (Review Focus #3).

Đồng thời cập nhật các dòng gửi `MOTORBIKE_PARKING` trong `api/test/contractCreationFixes.test.js` và `api/test/contractRemainingFixes.test.js` có truyền `vehicle_plates` hợp lệ theo `quantity`.

- [ ] **Step 2: Chạy integration test để xác nhận thất bại**

Run: `node --test api/test/parkingPlatesSync.test.js`
Expected: FAIL vì `POST /api/v1/contracts` chưa chặn thiếu `vehicle_plates` (trả `201` thay vì `422`).

- [ ] **Step 3: Tích hợp `validateAndNormalizeSubscriptionMeta` & `vehicle_plates` vào `contracts.js`, `services.js`, `resident.js`**

1. `api/src/routes/contracts.js`:
   - Trong `syncDraftContractServicesInTx`: gọi `validateAndNormalizeSubscriptionMeta({ category: cat.category, billingType: cat.billing_type, quantity: svcItem.quantity, vehiclePlates: svcItem.vehicle_plates, note: svcItem.note })`, lưu `meta.quantity`, `meta.vehiclePlates`, `meta.note` vào `INSERT INTO service_subscription (... quantity, unit_price, start_date, prorata_amount, status, note, vehicle_plates, requested_by)`.
   - Trong `GET /:id/template`: thêm `ss.vehicle_plates` vào `SELECT`, kết xuất dòng `<div ...><strong>Biển số xe:</strong> ${escapeTemplateHtml(row.vehiclePlates.join(', '))}</div>` khi `row.vehiclePlates.length > 0` ngay trước `noteHtml`.
2. `api/src/routes/services.js`:
   - Trong `POST /api/v1/service-subscriptions`: gọi `validateAndNormalizeSubscriptionMeta` với `svc.category`, `svc.billing_type`, `req.body.quantity`, `req.body.vehicle_plates`, `req.body.note` (bắt lỗi `err.httpStatus` trả JSON `422`), lưu `vehicle_plates` vào `service_subscription`.
3. `api/src/routes/resident.js`:
   - Trong `POST /api/v1/resident/services`: gọi `validateAndNormalizeSubscriptionMeta` với `svc.category`, `svc.billing_type`, `req.body.quantity`, `req.body.vehicle_plates`, `req.body.note` (bắt lỗi `err.httpStatus` trả JSON `422`), lưu `vehicle_plates` vào `service_subscription`.

- [ ] **Step 4: Chạy bộ integration test để xác nhận PASS**

Run: `node --test api/test/parkingPlatesSync.test.js api/test/contractCreationFixes.test.js api/test/contractRemainingFixes.test.js`
Expected: PASS 100%.

- [ ] **Step 5: Commit Task 2**

```bash
git add api/src/routes/contracts.js api/src/routes/services.js api/src/routes/resident.js api/test/parkingPlatesSync.test.js api/test/contractCreationFixes.test.js api/test/contractRemainingFixes.test.js
git commit -m "feat(api): enforce vehicle_plates on parking subscriptions across contracts, admin, and resident APIs"
```

---

### Task 3: Đồng bộ Giao diện Frontend trên 4 Màn hình (`ContractsPage`, `ContractDetailPage`, `SubscriptionsPage`, `ServicesTab`)

**Files:**
- Create: `frontend/src/utils/serviceSubscriptionMeta.js`
- Create: `frontend/src/components/common/ServiceSubscriptionMetaFields.jsx`
- Modify: `frontend/src/pages/admin/contracts/ContractsPage.jsx`
- Modify: `frontend/src/pages/admin/contracts/ContractDetailPage.jsx`
- Modify: `frontend/src/pages/admin/services/SubscriptionsPage.jsx`
- Modify: `frontend/src/pages/resident/tabs/ServicesTab.jsx`
- Create: `frontend/src/utils/__tests__/parkingPlatesUi.test.js`

**Interfaces:**
- Consumes: API payload `vehicle_plates: string[]` và `note?: string` từ Task 2.
- Produces:
  - `frontend/src/utils/serviceSubscriptionMeta.js`:
    - `MAX_PARKING_QUANTITY = 10`
    - `isParkingService(svcOrCategory: unknown) -> boolean`
    - `syncVehiclePlatesArray(plates: string[] | undefined, nextQuantity: number | string) -> string[]`
    - `validateServiceMetaInput({ isParking, quantity, vehiclePlates, note }) -> { valid: boolean, plateErrors: string[], quantityError: string, noteError: string, cleanPlates: string[], cleanNote: string }`
  - `frontend/src/components/common/ServiceSubscriptionMetaFields.jsx`:
    - `ServiceSubscriptionMetaFields({ isParking, quantity, vehiclePlates, note, plateErrors, noteError, onPlateChange, onNoteChange })`
    - `VehiclePlatesBadges({ plates, className })`

- [ ] **Step 1: Viết unit & UI test thất bại trong `frontend/src/utils/__tests__/parkingPlatesUi.test.js`**

Kiểm tra:
1. `syncVehiclePlatesArray(['59A1-111.11', '59B2-222.22'], 1)` cắt còn đúng `['59A1-111.11']` (Review Focus #5); tăng lên `3` mở rộng thành `['59A1-111.11', '59B2-222.22', '']`; kẹp tối đa `10`.
2. `validateServiceMetaInput` báo lỗi từng ô khi bỏ trống hoặc trùng biển số khác hoa/thường (`['59a1-123.45', ' 59A1-123.45 ']` — Review Focus #1), và bỏ qua `vehiclePlates` khi `isParking === false`.
3. `ServiceSubscriptionMetaFields.jsx` hiển thị nhãn `"Biển số xe"` / `"Biển số xe #"` có `required` chỉ khi `isParking` là `true`, và luôn dùng nhãn `"Ghi chú dịch vụ (tùy chọn)"` (không còn chuỗi `"Ghi chú dịch vụ / Biển số xe (tùy chọn)"` trên bất kỳ trang nào).
4. Cả 4 màn hình (`ContractsPage.jsx`, `ContractDetailPage.jsx`, `SubscriptionsPage.jsx`, `ServicesTab.jsx`) đều import & sử dụng `ServiceSubscriptionMetaFields` và truyền `vehicle_plates` trong payload API.

- [ ] **Step 2: Chạy test để xác nhận thất bại**

Run: `node --test frontend/src/utils/__tests__/parkingPlatesUi.test.js`
Expected: FAIL với lỗi `Cannot find module '../serviceSubscriptionMeta.js'`.

- [ ] **Step 3: Cài đặt `serviceSubscriptionMeta.js`, `ServiceSubscriptionMetaFields.jsx` và cập nhật 4 màn hình**

1. Cài đặt `frontend/src/utils/serviceSubscriptionMeta.js` và `frontend/src/components/common/ServiceSubscriptionMetaFields.jsx` (dùng `Input` và `Badge` có sẵn của dự án).
2. Cập nhật `ContractsPage.jsx`:
   - Lưu `vehicle_plates: ['']` trong `selectedServices[svc.id]`; khi đổi `quantity` của gói `PARKING` (đặt `max={isParking ? MAX_PARKING_QUANTITY : undefined}`), đồng bộ mảng qua `syncVehiclePlatesArray`.
   - Validate bằng `validateServiceMetaInput` trong `handleCreateSubmit` (lưu lỗi vào `createErrors` để hiện đỏ dưới từng ô biển số/ghi chú và chặn submit nếu không hợp lệ), gửi `vehicle_plates: meta.cleanPlates` (khi `isParking`) + `note` trong `servicesPayload`.
3. Cập nhật `ContractDetailPage.jsx`:
   - Trong `handleOpenEditDraft`: nạp `vehicle_plates` từ `sub.vehicle_plates` qua `syncVehiclePlatesArray`.
   - Trong Modal Sửa hợp đồng nháp & `handleSaveDraft`: dùng `ServiceSubscriptionMetaFields` + `validateServiceMetaInput` (hiện lỗi đỏ ngay dưới ô nếu thiếu/trùng biển số) và gửi `vehicle_plates` + `note`.
   - Ở cột `Biển số / Ghi chú` của bảng dịch vụ đi kèm: hiển thị `VehiclePlatesBadges` kèm dòng `row.note` bên dưới.
4. Cập nhật `SubscriptionsPage.jsx`:
   - Trong `assignForm`, thêm `vehicle_plates: ['']` và state lỗi `assignErrors`; khi đổi dịch vụ hoặc `quantity`, đồng bộ qua `syncVehiclePlatesArray`; dùng `ServiceSubscriptionMetaFields` thay cho ô `Input` ghi chú cũ; validate trước khi gọi `servicesService.createSubscription` (truyền `vehicle_plates`).
   - Hiển thị `VehiclePlatesBadges` trên bảng danh sách đăng ký và bổ sung tìm kiếm theo `(s.vehicle_plates || []).join(' ')` trong `filteredData`.
5. Cập nhật `ServicesTab.jsx`:
   - Trong `subForm`, thêm `vehicle_plates: ['']` và state lỗi `subErrors`; đặt `max={isParking ? MAX_PARKING_QUANTITY : 20}`; dùng `ServiceSubscriptionMetaFields` thay cho ô ghi chú cũ; validate và truyền `vehicle_plates` vào `residentService.subscribeService`.
   - Hiển thị `VehiclePlatesBadges` trên cả thẻ dịch vụ đang hoạt động lẫn danh sách lịch sử dịch vụ đã hủy.

- [ ] **Step 4: Chạy UI test, `vite build` và toàn bộ test suite để xác nhận PASS**

Run:
```powershell
node --test frontend/src/utils/__tests__/*.test.js
npm --prefix frontend run build
node --test api/test/serviceSubscriptionMeta.test.js api/test/contractTemplate.test.js api/test/parkingPlatesSync.test.js api/test/contractCreationFixes.test.js api/test/contractRemainingFixes.test.js
```
Expected: Tất cả unit test, integration test và `vite build` đều PASS 0 lỗi.

- [ ] **Step 5: Commit Task 3**

```bash
git add frontend/src/utils/serviceSubscriptionMeta.js frontend/src/components/common/ServiceSubscriptionMetaFields.jsx frontend/src/pages/admin/contracts/ContractsPage.jsx frontend/src/pages/admin/contracts/ContractDetailPage.jsx frontend/src/pages/admin/services/SubscriptionsPage.jsx frontend/src/pages/resident/tabs/ServicesTab.jsx frontend/src/utils/__tests__/parkingPlatesUi.test.js
git commit -m "feat(ui): require per-vehicle license plates for parking services and separate optional service notes"
```
