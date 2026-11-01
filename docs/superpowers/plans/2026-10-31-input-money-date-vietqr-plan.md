# Chuẩn hóa Ô nhập tiền, Khoảng thời gian & Dropdown Ngân hàng VietQR — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Định dạng dấu chấm hàng nghìn (`100.000`, `1.000.000`) cho toàn bộ ô nhập tiền, chặn chọn ngày sau nhỏ hơn ngày trước kèm tự gợi ý ngày bắt đầu ngoài khoảng căn hộ đã thuê/giữ chỗ, và đồng bộ toàn bộ dropdown chọn ngân hàng theo danh sách VietQR.

**Architecture:** Xây dựng 3 khối dùng chung ở frontend (`moneyInput.js` + `MoneyInput.jsx`, `dateRange.js`, `vietqrBanks.js` + `useVietQrBanks.js` + `BankSelect.jsx`) và mở rộng danh mục dự phòng VietQR tại `api/src/routes/buildings.js`. Mọi logic tính toán phức tạp được tách thành hàm thuần ESM và kiểm thử tự động bằng `node --test` trước khi gắn vào các màn hình.

**Tech Stack:** React 19, TailwindCSS 3, Express 4, Node.js 22 (`node:test`, `oxlint`, `vite build`).

**Spec:** `docs/superpowers/specs/2026-10-31-input-money-date-vietqr-design.md`

## Global Constraints

- Không cài thêm thư viện ngoài ở `frontend` hay `api`.
- Giữ nguyên cấu trúc dữ liệu API (số tiền gửi lên backend vẫn là số nguyên sạch, không gửi chuỗi chứa dấu chấm).
- Không định dạng dấu chấm hàng nghìn cho các ô số không phải tiền (số tầng, diện tích `m²`, số phòng ngủ, chỉ số công tơ `kWh`/`m³`, số lượng dịch vụ, giờ/ngày SLA, `%`).
- Không tự động chạy `git commit` trộn vào 26 file chưa commit sẵn có trên nhánh đang làm việc của người dùng trừ khi người dùng yêu cầu.

## Review Focus

- Chuỗi số tiền trả về từ cột PostgreSQL `NUMERIC(14,2)` có dạng `"8500000.00"`: phải hiển thị đúng `"8.500.000"`, tuyệt đối không bị nhân 100 thành `"850.000.000"`.
- Nhập số âm ở ô điều chỉnh hóa đơn (`allowNegative = true`): gõ dấu `-` đầu tiên chưa có chữ số không được bắn `"NaN"` ra state tính nhẩm bên ngoài, và khi gõ tiếp `200000` phải hiển thị `"-200.000"`.
- Sửa một chữ số ở giữa chuỗi tiền (ví dụ sửa `"1.000.000"` thành `"12.000.000"`): vị trí con trỏ phải bám đúng sau chữ số vừa gõ thay vì nhảy về cuối ô.
- Nhiều khoảng hợp đồng/giữ chỗ nối tiếp hoặc chồng nhau (ví dụ `01/10 -> 01/12` rồi `02/12 -> 15/12`): ngày bắt đầu gợi ý từ `31/10` phải nhảy qua cả chuỗi bận tới `16/12`, không dừng ở `02/12`.
- Hồ sơ tòa nhà hoặc hoàn cọc cũ lưu tên ngân hàng tự gõ ngoài VietQR (ví dụ `"Ngân hàng liên doanh cũ"`): mở form chỉnh sửa vẫn phải giữ nguyên giá trị đó trên dropdown thay vì làm rỗng.

---

### Task 1: Bộ định dạng tiền tệ & Component `MoneyInput`

**Files:**
- Create: `frontend/src/utils/moneyInput.js`
- Create: `frontend/src/components/ui/MoneyInput.jsx`
- Test: `frontend/src/utils/__tests__/moneyInput.test.js`

**Interfaces:**
- Produces:
  - `normalizeMoneyPropValue(value, { allowNegative = false }) -> string` (chuỗi số nguyên sạch `""`, `"0"`, `"100000"`, `"-200000"`)
  - `formatMoneyInputDisplay(value, { allowNegative = false }) -> string` (chuỗi hiển thị `"100.000"`, `"-1.000.000"`, `""`, `"-"`)
  - `parseMoneyUserEdit(displayText, caretIndex, { allowNegative = false }) -> { rawValue: string, displayValue: string, nextCaretIndex: number, isTransientMinus: boolean }`
  - `MoneyInput({ value, onChange, allowNegative = false, name, id, ...inputProps })`

- [ ] **Step 1: Viết unit test thất bại cho `moneyInput.js`**
  Kiểm tra: `formatMoneyInputDisplay` với `100000` -> `"100.000"`, `1000000` -> `"1.000.000"`, chuỗi Postgres `"8500000.00"` -> `"8.500.000"`, số âm `"-200000"` (`allowNegative: true` -> `"-200.000"`, `allowNegative: false` -> `"200.000"`), dấu `"-"` tạm thời (`isTransientMinus: true`, `rawValue: ""`), và bảo toàn vị trí con trỏ khi chèn chữ số vào giữa `"1.000.000"`.
- [ ] **Step 2: Chạy test xác nhận FAIL**
  Run: `node --test frontend/src/utils/__tests__/moneyInput.test.js`
  Expected: FAIL (`ERR_MODULE_NOT_FOUND`)
- [ ] **Step 3: Cài đặt `frontend/src/utils/moneyInput.js` và `frontend/src/components/ui/MoneyInput.jsx`**
  `MoneyInput` bọc `Input`, dùng `type="text"` + `inputMode={allowNegative ? "text" : "numeric"}`, khôi phục `selectionStart/selectionEnd` qua `useLayoutEffect`, và phát `onChange` với `target.value = rawValue`.
- [ ] **Step 4: Chạy test xác nhận PASS**
  Run: `node --test frontend/src/utils/__tests__/moneyInput.test.js`
  Expected: PASS (0 failures)

---

### Task 2: Bộ hàm kiểm tra khoảng thời gian & Gợi ý ngày trống căn hộ (`dateRange.js`)

**Files:**
- Create: `frontend/src/utils/dateRange.js`
- Test: `frontend/src/utils/__tests__/dateRange.test.js`

**Interfaces:**
- Produces:
  - `addDaysStr(dateStr, days) -> string` (`YYYY-MM-DD`)
  - `maxDateStr(...dates) -> string`
  - `extractApartmentBusyIntervals( { contracts = [], reservations = [] }, { excludeContractId, excludeReservationId, todayStr } ) -> Array<{ from: string, to: string, kind: 'contract' | 'reservation', label: string }>`
  - `findFirstAvailableStartDate(baseDateStr, busyIntervals) -> string`
  - `findOverlappingBusyIntervals(startStr, endStr, busyIntervals, { inclusiveEnd = false }) -> Array`
  - `getDateOrderError(startStr, endStr, { strictAfter = false, startLabel = 'Ngày bắt đầu', endLabel = 'Ngày kết thúc' }) -> string`
  - `syncFilterDateRange(nextFrom, currentTo) -> { fromDate: string, toDate: string }`

- [ ] **Step 1: Viết unit test thất bại cho `dateRange.js`**
  Kiểm tra:
  - Ví dụ thực tế từ spec: `today = "2026-10-31"`, hợp đồng `"2026-10-01" -> "2026-12-01"` => `findFirstAvailableStartDate` trả về `"2026-12-02"`.
  - Hai khoảng bận nối tiếp `"2026-10-01" -> "2026-12-01"` và `"2026-12-02" -> "2026-12-15"` => trả về `"2026-12-16"`.
  - Hợp đồng `TERMINATION_PENDING` có `terminated_at = "2026-11-15"` (< `end_date = "2027-06-01"`) => khoảng bận chỉ tính tới `"2026-11-15"`, ngày trống đầu tiên là `"2026-11-16"`.
  - Bỏ qua đúng `excludeReservationId` khi khách giữ chỗ chuyển sang ký hợp đồng.
  - `getDateOrderError`: `strictAfter: true` báo lỗi khi `end <= start`; `strictAfter: false` cho phép `end === start` nhưng báo lỗi khi `end < start`.
  - `syncFilterDateRange`: khi `nextFrom = "2026-11-10"` > `currentTo = "2026-11-05"` => trả về `{ fromDate: "2026-11-10", toDate: "2026-11-10" }`.
- [ ] **Step 2: Chạy test xác nhận FAIL**
  Run: `node --test frontend/src/utils/__tests__/dateRange.test.js`
  Expected: FAIL (`ERR_MODULE_NOT_FOUND`)
- [ ] **Step 3: Cài đặt `frontend/src/utils/dateRange.js`**
- [ ] **Step 4: Chạy test xác nhận PASS**
  Run: `node --test frontend/src/utils/__tests__/dateRange.test.js`
  Expected: PASS (0 failures)

---

### Task 3: Danh mục Ngân hàng VietQR đầy đủ & Component `BankSelect`

**Files:**
- Modify: `api/src/routes/buildings.js:21-35`
- Create: `frontend/src/utils/vietqrBanks.js`
- Create: `frontend/src/hooks/useVietQrBanks.js`
- Create: `frontend/src/components/common/BankSelect.jsx`
- Test: `frontend/src/utils/__tests__/vietqrBanks.test.js`

**Interfaces:**
- Produces:
  - `buildVietQrBankOptions(banks, currentBankInfo) -> Array<SelectOption>`
  - `matchVietQrBank(banks, paymentAccount) -> VietQrBank | null`
  - `useVietQrBanks() -> { banks: Array, loading: boolean, reload: () => Promise }`
  - `BankSelect({ label, value, bankMeta, onBankChange, required, disabled, error, hint, placeholder })`

- [ ] **Step 1: Viết unit test thất bại cho `vietqrBanks.js`**
  Kiểm tra: ánh xạ danh sách VietQR sang option có `value` (`shortName`), `label` (`"Vietcombank (VCB)"`), `sublabel` (tên đầy đủ), `badge` (`"BIN 970436"`), `logo`, `searchText`; khớp ngược từ `bank_code`/`bank_bin`/`bank_name`; và giữ nguyên ngân hàng tự gõ cũ nếu không nằm trong danh sách VietQR.
- [ ] **Step 2: Chạy test xác nhận FAIL**
  Run: `node --test frontend/src/utils/__tests__/vietqrBanks.test.js`
  Expected: FAIL (`ERR_MODULE_NOT_FOUND`)
- [ ] **Step 3: Mở rộng `FALLBACK_VIETQR_BANKS` trong `api/src/routes/buildings.js` (~43 ngân hàng VietQR phổ biến) và cài đặt `vietqrBanks.js`, `useVietQrBanks.js`, `BankSelect.jsx`**
- [ ] **Step 4: Chạy test xác nhận PASS**
  Run: `node --test frontend/src/utils/__tests__/vietqrBanks.test.js`
  Expected: PASS (0 failures)

---

### Task 4: Tích hợp `MoneyInput`, `BankSelect` & `dateRange` vào toàn bộ trang Quản trị và Cư dân

**Files:**
- Modify: `frontend/src/pages/admin/buildings/BuildingsPage.jsx` (`BankSelect`)
- Modify: `frontend/src/pages/admin/deposits/DepositsPage.jsx` (`BankSelect` cho hoàn cọc + `MoneyInput` cho thu thêm & khấu trừ)
- Modify: `frontend/src/pages/admin/apartments/ApartmentDetailPage.jsx` (`MoneyInput` cho `base_rent`)
- Modify: `frontend/src/pages/admin/buildings/FloorPlanPage.jsx` (`MoneyInput` + gợi ý ngày giữ chỗ ngoài khoảng bận + khóa `min`/`max` + báo lỗi đỏ)
- Modify: `frontend/src/pages/admin/contracts/ContractsPage.jsx` (`MoneyInput` + sửa tự động chọn ngày bắt đầu ngoài khoảng đã thuê/giữ chỗ + khóa `min` + báo lỗi đỏ)
- Modify: `frontend/src/pages/admin/contracts/ContractDetailPage.jsx` (`MoneyInput` trên 8 ô tiền + kiểm tra khoảng ngày trống & ngày sau >= ngày trước cho sửa nháp, gia hạn, phụ lục, chuyển phòng, thanh lý, đơn giá dịch vụ)
- Modify: `frontend/src/pages/admin/audit/AuditLogsPage.jsx` (khóa `min` & tự đồng bộ `toDate = fromDate` khi `fromDate > toDate`)
- Modify: `frontend/src/pages/admin/invoices/InvoiceDetailPage.jsx` (`MoneyInput` có `allowNegative` cho điều chỉnh + `MoneyInput` thu tiền + khóa `min` và báo lỗi cho `due_date`)
- Modify: `frontend/src/pages/admin/payments/PaymentsPage.jsx` (`MoneyInput` cho `amount`)
- Modify: `frontend/src/pages/admin/services/ServiceCatalogPage.jsx` (`MoneyInput` cho `unit_price`)
- Modify: `frontend/src/pages/admin/services/SubscriptionsPage.jsx` (khóa `min` và báo lỗi đỏ cho `cancelEndDate` so với `start_date`)
- Modify: `frontend/src/pages/admin/meters/MeterReadingsPage.jsx` (`MoneyInput` cho `unit_price`)
- Modify: `frontend/src/pages/admin/settings/SettingsPage.jsx` (`MoneyInput` cho giá điện/nước mặc định)
- Modify: `frontend/src/pages/admin/users/UsersPage.jsx` (`MoneyInput` cho giá điện/nước mặc định)
- Modify: `frontend/src/pages/resident/tabs/InvoicesTab.jsx` (`MoneyInput` cho `payForm.amount` + hiển thị logo ngân hàng nếu có)
- Modify: `frontend/src/pages/resident/tabs/ContractTab.jsx` (khóa `min`/`max` và báo lỗi đỏ cho `desired_date` khi gia hạn hoặc chấm dứt)
- Modify: `frontend/src/pages/resident/tabs/ServicesTab.jsx` (khóa `min = max(today, start_date)` và báo lỗi đỏ cho `end_date` khi hủy dịch vụ)

**Interfaces:**
- Consumes: Task 1 (`MoneyInput`), Task 2 (`dateRange.js`), Task 3 (`BankSelect`, `matchVietQrBank`, `useVietQrBanks`)

- [ ] **Step 1: Thay thế toàn bộ 19 ô nhập tiền bằng `MoneyInput` trên 12 trang**
- [ ] **Step 2: Thay thế chọn ngân hàng bằng `BankSelect` tại `BuildingsPage.jsx` và `DepositsPage.jsx` (kèm hiển thị logo/mã ngân hàng nếu có trên biên bản tất toán & `InvoicesTab.jsx`)**
- [ ] **Step 3: Tích hợp `dateRange.js` cho gợi ý ngày bắt đầu trống & chặn ngày sau < ngày trước trên toàn bộ 8 trang có khoảng thời gian**
- [ ] **Step 4: Chạy toàn bộ unit tests, `npm run lint` và `npm run build` tại `frontend`**
  Run: `node --test frontend/src/utils/__tests__/*.test.js && npm --prefix frontend run lint && npm --prefix frontend run build`
  Expected: PASS (0 test failures, 0 lint errors, Vite production build exit 0)

