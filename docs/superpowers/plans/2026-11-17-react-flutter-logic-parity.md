# React–Flutter Logic Parity (vòng 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Đưa 111 điểm khác biệt logic giữa React và Flutter về cùng một hành vi, giữ nguyên 14 cải tiến Flutter-only đã duyệt.

**Architecture:** React là nguồn sự thật cho payload/validate/phân quyền/deep-link. Flutter là nơi sửa chính. React chỉ sửa 3 điểm (R1–R3). Không đụng backend. Mỗi wave độc lập; các task cùng wave được thực hiện tuần tự nếu cùng file, song song nếu khác file.

**Tech Stack:** React 19 + Vite + Zustand (frontend), Flutter 3.6 + Riverpod + Dio + go_router (flutter_resihub), `flutter test` / `flutter analyze`, `oxlint` / `vite build`.

**Spec:**
- `docs/superpowers/specs/2026-11-17-react-flutter-logic-parity-design.md`
- `docs/superpowers/reports/2026-11-17-react-flutter-logic-audit.md` (nguồn `file:line`)

## Global Constraints

- Không thêm dependency mới. React **không có test runner** → verification React = `npm run lint && npm run build` + source assertion (`grep`). Không dựng test framework.
- Không sửa `api/`, không đổi schema DB, không đổi PRD.
- Không đụng 14 hạng mục K1–K14 (spec §4.1) và 3 điểm giữ nguyên #20/#38/#39 của vòng 1.
- Mọi payload Flutter phải khớp **key, kiểu, giá trị mặc định** của React.
- Mỗi đổi logic phức tạp có ít nhất 1 test chạy được. Mỗi task kết thúc bằng 1 commit.
- Chạy verification cuối mỗi wave: `flutter analyze && flutter test` (trong `flutter_resihub/`), `npm run lint && npm run build` (trong `frontend/`).

## Review Focus

| Input / condition | Hành vi mong đợi | Test pinned ở task |
|---|---|---|
| Tìm kiếm theo mã BIN 970436 trong BankSelect | Ra ngân hàng dù label không chứa mã | T1 |
| Chọn rồi muốn bỏ chọn dropdown | Có option `''` để clear | T1 |
| Payload hợp đồng `type` / `desired_date` | Không gửi `request_type` / `reason` | T7, T10 |
| Cư dân có `has_past_contract: true` | Nút Xóa bị disable, dù không còn HĐ active | T6 |
| Deep-link `?invoice_id=...&modal=pay` từ thông báo | Mở đúng modal hóa đơn | T13, T26 |

## File Structure

- `flutter_resihub/lib/shared/widgets/ui/app_select.dart` — search blob, clear option, auto-search, badge/logo (T1).
- `flutter_resihub/lib/shared/widgets/ui/app_input.dart` — `maxLength`, controller thay `initialValue` (T2, T6).
- `flutter_resihub/lib/core/utils/{zalo_format,money_input_helpers,ai_helpers,billing_helpers,meter_batch_photo_helpers}.dart` — edge case (T25).
- `flutter_resihub/lib/features/contracts/screens/{contracts_page,contract_detail_page}.dart` — form/payload/tab (T9, T10).
- `flutter_resihub/lib/features/deposits/widgets/deposit_detail_modal.dart` — refund method, STK, debt, pro-rata (T3).
- `flutter_resihub/lib/features/invoices/screens/invoices_page.dart` — filter CANCELLED (T4).
- `flutter_resihub/lib/features/buildings/widgets/floor_plan_view.dart` — zone/status/payment/evidence/date (T5).
- `flutter_resihub/lib/features/tenants/screens/{tenants_page,tenant_detail_page}.dart` — quyền xóa, shared lock, AI field (T6, T21).
- `flutter_resihub/lib/features/resident/**` — payload + deep-link (T7, T13, T26).
- `frontend/src/services/{api,queryCache}.js` — R1–R3 (T8).
- Test files theo cấu trúc `flutter_resihub/test/**` hiện hữu; file mới được liệt kê trong từng task.

---

## Wave 1 — Lỗi gãy chức năng (dropdown, payload, phân quyền)

### Task 0: Chốt baseline verification

**Files:** none
**Interfaces:** Produces: baseline recorded.

- [ ] **Step 1: Chạy baseline Flutter**

Run (từ `flutter_resihub/`): `flutter analyze && flutter test`
Expected: `flutter analyze` no issues; ghi lại số test pass/fail hiện tại làm baseline.

- [ ] **Step 2: Chạy baseline React**

Run (từ `frontend/`): `npm run lint && npm run build`
Expected: cả hai exit 0.

- [ ] **Step 3: Ghi baseline vào report**

Append vào `docs/superpowers/reports/2026-11-17-react-flutter-logic-audit.md` một dòng: ngày, số test Flutter pass/fail, trạng thái lint/build React.

- [ ] **Step 4: Commit**

`git add docs/superpowers/reports/... && git commit -m "chore(parity): record baseline verification"`

---

### Task 1: AppSelect — search BIN, clear option, auto-search, badge/logo (A1–A4)

**Files:**
- Modify: `flutter_resihub/lib/shared/widgets/ui/app_select.dart:79-84,103,132,201-227,283-290,360-386`
- Test: `flutter_resihub/test/shared/widgets/ui_primitives_test.dart`

**Interfaces:**
- Consumes: `AppSelectOption` (đã có `label`, `value`, `sublabel`, `badge`, `searchText`, `logo`).
- Produces: API public của `AppSelect` không đổi; search/blob behavior đổi.

- [ ] **Step 1: Viết test fail — search theo `searchText`**

Trong `ui_primitives_test.dart`, thêm `testWidgets('AppSelect searches by searchText (BIN)', ...)`: dựng `AppSelect` với option có `label: 'Vietcombank'`, `searchText: '970436'`, `badge: 'VCB'`; mở dropdown, nhập `970436`; assert option hiển thị.
Run: `flutter test test/shared/widgets/ui_primitives_test.dart`
Expected: FAIL (option không hiện).

- [ ] **Step 2: Viết test fail — clear option + `searchable:false`**

Thêm 2 test: (a) option placeholder `''` hiển thị và chọn lại được; (b) truyền `searchable: false` với 6 option → **không** có ô search.
Run: lệnh trên. Expected: FAIL.

- [ ] **Step 3: Sửa `app_select.dart`**

`searchBlob` = `[label, sublabel, badge, searchText, value].join(' ')`; thêm option `value:''`; auto-search = `options.length > 5 || searchPlaceholder != null`, với `searchable == false` ép tắt; render `badge`/`logo` ở option row và trigger.

- [ ] **Step 4: Chạy test pass**

Run: `flutter test test/shared/widgets/ui_primitives_test.dart`
Expected: PASS cả 3 test mới.

- [ ] **Step 5: Commit**

`git commit -am "fix(parity): AppSelect search BIN, clear option, badge and logo (A1-A4)"`

---

### Task 2: ServiceSubscriptionMetaFields maxLength (A5)

**Files:**
- Modify: `flutter_resihub/lib/shared/widgets/common/service_subscription_meta_fields.dart:48-71`, `flutter_resihub/lib/shared/widgets/ui/app_input.dart:24-49`
- Test: `flutter_resihub/test/shared/widgets/ui_primitives_test.dart`

**Interfaces:**
- Consumes: `AppInput` signature hiện tại.
- Produces: `AppInput` có thêm param `maxLength` (optional int).

- [ ] **Step 1: Viết test fail**

`testWidgets('ServiceSubscriptionMetaFields enforces maxLength 30/500', ...)`: tìm field biển số, assert `maxLength == 30`; field ghi chú `maxLength == 500`.
Run: `flutter test test/shared/widgets/ui_primitives_test.dart`. Expected: FAIL.

- [ ] **Step 2: Thêm `maxLength` vào `AppInput` và truyền giá trị**

Signature: `AppInput({..., this.maxLength})`; truyền vào `TextFormField(maxLength: maxLength)`. Truyền 30/500 từ `service_subscription_meta_fields.dart`.

- [ ] **Step 3: Chạy test pass**

Run lệnh trên. Expected: PASS.

- [ ] **Step 4: Commit**

`git commit -am "fix(parity): add maxLength to service subscription fields (A5)"`

---

### Task 3: Deposit — phương thức hoàn trả, STK, outstanding_debt, bank_info, pro-rata (B17–B21)

**Files:**
- Modify: `flutter_resihub/lib/features/deposits/widgets/deposit_detail_modal.dart:131,222-229,323,337,345` (+ nút pro-rata)
- Test: `flutter_resihub/test/features/deposits/deposit_detail_modal_test.dart` (new)

**Interfaces:**
- Consumes: `PAYMENT_METHOD_OPTIONS` từ `core/constants/statuses.dart` (đã có BANK_TRANSFER/CASH).
- Produces: `_refundMethod` state; payload settle có `refund_method`, `bank_info`, `outstanding_debt`.

- [ ] **Step 1: Viết test fail — dropdown + điều kiện ẩn**

`testWidgets('refund method dropdown gates bank fields', ...)`: assert có dropdown với 2 option; chọn `CASH` → ô STK/ngân hàng biến mất; payload gửi `bank_info: {}`.
Run: `flutter test test/features/deposits/deposit_detail_modal_test.dart`. Expected: FAIL.

- [ ] **Step 2: Viết test fail — regex STK + debt**

`test('STK validation rejects 3 chars and 26 chars', ...)` using hàm validate được trích xuất; `test('settle uses liveCalc.serviceDebt', ...)`.

- [ ] **Step 3: Implement**

Thay hardcode `_refundMethod` bằng `DropdownButton`/`AppSelect` 2 option; wrap ô bank trong `if (_refundMethod == 'BANK_TRANSFER')`; regex `/^[A-Za-z0-9]{4,25}$/`; `outstanding_debt` lấy từ live calc; `bank_info: {}`; thêm nút "sinh hóa đơn Pro-rata kỳ cuối" gọi endpoint hiện có của React.

- [ ] **Step 4: Chạy test pass + analyze**

Run: `flutter test test/features/deposits/ && flutter analyze`. Expected: PASS, no issues.

- [ ] **Step 5: Commit**

`git commit -am "fix(parity): deposit refund method, STK regex, debt, pro-rata (B17-B21)"`

---

### Task 4: Invoice — filter CANCELLED, kỳ hóa đơn, phạm vi tòa (B22–B24)

**Files:**
- Modify: `flutter_resihub/lib/features/invoices/screens/invoices_page.dart:31-39,513-521,539-546,812-817`
- Test: `flutter_resihub/test/features/invoices/invoices_payments_test.dart`

**Interfaces:** Consumes `INVOICE_STATUS` từ `core/constants/statuses.dart`. Produces: filter có 8 option; ô kỳ hóa đơn validate `YYYY-MM`.

- [ ] **Step 1: Viết test fail**

`testWidgets('invoice status filter includes CANCELLED', ...)`: mở dropdown, `expect(find.text('Đã hủy'), findsOneWidget)`.
`testWidgets('period field rejects invalid YYYY-MM', ...)`.
`testWidgets('building scope shown only when no building selected', ...)`.
Run: `flutter test test/features/invoices/invoices_payments_test.dart`. Expected: FAIL.

- [ ] **Step 2: Implement B22–B24**

Dùng `INVOICE_STATUS` thay map cứng 7 giá trị; thay `AppInput` bằng date-month picker + validate `YYYY-MM`; "Phạm vi tòa nhà" chỉ hiện khi `selectedBuildingId == null` (bỏ option `''` riêng).

- [ ] **Step 3: Chạy test pass**

Run lệnh trên. Expected: PASS.

- [ ] **Step 4: Commit**

`git commit -am "fix(parity): invoice filter, period picker, building scope (B22-B24)"`

---

### Task 5: FloorPlan — zone, status, payment methods, evidence, date, idempotency (C4–C10)

**Files:**
- Modify: `flutter_resihub/lib/features/buildings/widgets/floor_plan_view.dart:192,372,780,1210,1234,1237,1334,1521,1685`
- Test: `flutter_resihub/test/features/buildings/floor_plan_view_test.dart`

**Interfaces:**
- Consumes: `PAYMENT_METHOD_OPTIONS` (6), `createIdempotencyKey()` từ `core/utils/idempotency.dart`.
- Produces: payload create reservation có `zone_id`, `evidence`, `hold_from/hold_until`; filter status `PENDING_CONFIRM`.

- [ ] **Step 1: Viết 3 test fail**

Trong `floor_plan_view_test.dart`: (a) `expect` filter reservation dùng `'PENDING_CONFIRM'`; (b) dropdown phương thức có 6 option; (c) modal thêm căn có option zone và payload có `zone_id`.
Run: `flutter test test/features/buildings/floor_plan_view_test.dart`. Expected: FAIL.

- [ ] **Step 2: Sửa option + filter + zone select**

Đổi `PENDING_PAYMENT` → `PENDING_CONFIRM`; thay hardcode 2 option bằng `kPaymentMethodOptions`; thêm `AppSelect` zone khi `zones.isNotEmpty`, gán `_aptZoneId` vào payload.

- [ ] **Step 3: Thêm evidence upload + date picker + idempotency + refresh drawer**

`FileUpload` max 5 → `evidence`; `showDatePicker` với `min/max`; gắn idempotency key cho confirm/reject/create; sau confirm gọi fetch lại `aptDetail`.

- [ ] **Step 4: Chạy test pass + analyze**

Run: `flutter test test/features/buildings/ && flutter analyze`. Expected: PASS.

- [ ] **Step 5: Commit**

`git commit -am "fix(parity): floor plan zone, status, 6 payment methods, evidence (C4-C10)"`

---

### Task 6: Tenants — quyền xóa, Shared Profile Lock, AI field (C14–C16)

**Files:**
- Modify: `flutter_resihub/lib/features/tenants/screens/tenants_page.dart:675,866,1358,1377`, `flutter_resihub/lib/features/tenants/screens/tenant_detail_page.dart:807,881`, `flutter_resihub/lib/shared/widgets/ui/app_input.dart:88`
- Test: `flutter_resihub/test/features/tenants/tenants_page_test.dart`

**Interfaces:**
- Consumes: `isSysAdmin`, `canManageTenants` từ permission provider; `tenant.active_contract`, `tenant.has_past_contract`, `tenant.is_shared_profile`.
- Produces: `AppInput` hỗ trợ `controller` (bắt buộc khi cần cập nhật từ AI).

- [ ] **Step 1: Viết 3 test fail**

`testWidgets('delete disabled when has_past_contract', ...)`; `testWidgets('shared profile fields disabled for non-sysadmin', ...)`; `testWidgets('AI extracted CCCD appears in field', ...)` (dùng controller).
Run: `flutter test test/features/tenants/tenants_page_test.dart`. Expected: FAIL.

- [ ] **Step 2: Sửa quyền + lock**

Chỉ `isSysAdmin` thấy nút Xóa; `disabled = active_contract != null || has_past_contract == true`; banner lock + disable `full_name/phone/id_number/dob` nếu `is_shared_profile && !isSysAdmin`; AI mapping bỏ qua field bị khóa.

- [ ] **Step 3: Đổi `initialValue` → `controller`** cho field CCCD ở cả 2 trang.

- [ ] **Step 4: Chạy test pass + analyze**

Run: `flutter test test/features/tenants/ && flutter analyze`. Expected: PASS.

- [ ] **Step 5: Commit**

`git commit -am "fix(parity): tenant delete rights, shared profile lock, AI field (C14-C16)"`

---

### Task 7: Resident — payload hợp đồng/dịch vụ/profile (E1–E7)

**Files:**
- Modify: `flutter_resihub/lib/features/resident/tabs/contract_tab.dart:592,607,636,648`, `services_tab.dart:583,770`, `profile_tab.dart:126,167`
- Test: `flutter_resihub/test/features/resident/contract_tab_test.dart`, `services_tab_test.dart`, `profile_tab_test.dart` (new)

**Interfaces:**
- Consumes: `createContractRequest`, `subscribeService`, `cancelService`, `uploadIdImage` từ `resident_service.dart`; `authProvider.updateUser`.
- Produces: payload keys đúng React; auth state được cập nhật sau khi lưu profile.

- [ ] **Step 1: Viết test fail — key payload**

Trong `contract_tab_test.dart`: `test('contract request payload uses type and desired_date', ...)` assert map có `type`, `desired_date`, không có `request_type`/`reason`. Trong `services_tab_test.dart`: 2 test assert subscribe có `start_date/note/vehicle_plates`, cancel có `end_date/note`. Trong `profile_tab_test.dart`: `test('save profile updates auth user', ...)`.
Run: `flutter test test/features/resident/contract_tab_test.dart test/features/resident/services_tab_test.dart test/features/resident/profile_tab_test.dart`. Expected: FAIL.

- [ ] **Step 2: Sửa option + form + payload**

Bỏ `TRANSFER_ROOM`; đổi field lý do → field ngày (default/min/max theo HĐ, required khi TERMINATION, validate thứ tự); payload đúng key; `uploadIdImage` dùng `image_base64`; sau lưu profile gọi `updateUser`.

- [ ] **Step 3: Chạy test pass + analyze**

Run: `flutter test test/features/resident/ && flutter analyze`. Expected: PASS.

- [ ] **Step 4: Commit**

`git commit -am "fix(parity): resident contract/service/profile payloads (E1-E7)"`

---

### Task 8: React — refresh rotation + cache scope + resident invalidation (R1–R3)

**Files:**
- Modify: `frontend/src/services/api.js:84-92`, `frontend/src/services/queryCache.js:13-37,160-182`
- Test: không có framework — source assertion.

**Interfaces:**
- Consumes: response `/auth/refresh` = `{accessToken, refreshToken?, user?}`.
- Produces: localStorage `refreshToken` được cập nhật; cache key có role/building; rule mới cho `/resident`.

- [ ] **Step 1: Source assertion trước khi sửa**

Run (từ `frontend/`): `grep -n "refreshToken" src/services/api.js`
Expected: chỉ thấy `localStorage.getItem('refreshToken')`, **không** có `setItem` sau refresh → xác nhận lỗi.

- [ ] **Step 2: Sửa R1**

Trong response interceptor, sau `const res = await refreshPromise`: `if (res.data.refreshToken) localStorage.setItem('refreshToken', res.data.refreshToken)`.

- [ ] **Step 3: Sửa R2/R3**

`queryCache.js`: key scope thêm role + buildingId (theo `query_cache.dart:158-185`); thêm rule `{ match: '/api/v1/resident', namespaces: [...] }` với 6 namespace như spec.

- [ ] **Step 4: Verification**

Run: `grep -n "setItem('refreshToken'\|/api/v1/resident\|role" src/services/api.js src/services/queryCache.js && npm run lint && npm run build`
Expected: grep ra 3 kết quả; lint/build exit 0.

- [ ] **Step 5: Commit**

`git commit -am "fix(parity): React refresh token rotation and cache scope (R1-R3)"`

**Wave 1 gate:** `flutter analyze && flutter test && npm run lint && npm run build` → xanh; cập nhật trạng thái 8 task vào report.

---

## Wave 2 — Form, validate và deep-link bị cắt

### Task 9: Tạo hợp đồng — validate, occupants, dịch vụ, lịch bận (B3–B6)

**Files:**
- Modify: `flutter_resihub/lib/features/contracts/screens/contracts_page.dart:339-410,451-483,684-704,1005-1038`
- Test: `flutter_resihub/test/features/contracts/contracts_page_test.dart` (new)

**Interfaces:**
- Consumes: `INLINE_RELATIONSHIP_OPTIONS`, apartment occupancy API, service catalog, tenant lookup.
- Produces: `createErrors` map; payload create có `occupants`, `services`.

- [ ] **Step 1: Viết test fail — validate**

`test('billing_day 0 and payment_due_days 61 rejected', ...)`; `test('duplicate occupant phone rejected', ...)`. Assert error map.
Run: `flutter test test/features/contracts/contracts_page_test.dart`. Expected: FAIL.

- [ ] **Step 2: Viết test fail — occupants + dịch vụ + lịch**

`testWidgets('create form renders occupant relationship select', ...)`; `testWidgets('occupied start date is rejected', ...)`.

- [ ] **Step 3: Implement toàn bộ B3–B6**

Validate đầy đủ; render occupants + select quan hệ; cấu hình dịch vụ `quantity/unit_price/vehicle_plates/note` + validate; fetch lịch bận, tự chọn ngày trống đầu tiên, chặn chồng lấn.

- [ ] **Step 4: Chạy test pass + analyze**

Run: `flutter test test/features/contracts/ && flutter analyze`. Expected: PASS.

- [ ] **Step 5: Commit**

`git commit -am "fix(parity): contract creation validation, occupants, services, schedule (B3-B6)"`

---

### Task 10: Chi tiết hợp đồng — 2 tab mới + payload + terminate (B9–B16)

**Files:**
- Modify: `flutter_resihub/lib/features/contracts/screens/contract_detail_page.dart:125,277,292,392,1416,1515,1523,1645,1684`
- Test: `flutter_resihub/test/features/contracts/contract_detail_parity_test.dart` (new)

**Interfaces:**
- Consumes: `getCreditLedger`/refund API đã có trong React (`ContractDetailPage.jsx:493-541`); settings `allow_self_approval`.
- Produces: tabs `schedule`, `credits`; payload edit có `services`, `service_prices`.

- [ ] **Step 1: Viết test fail — tabs**

`testWidgets('detail has 6 tabs including schedule and credits', ...)`. Run: `flutter test test/features/contracts/contract_detail_parity_test.dart`. Expected: FAIL.

- [ ] **Step 2: Viết test fail — payload + terminate**

`test('edit draft payload includes services and service_prices', ...)`; `testWidgets('final move-out calls terminate', ...)` assert endpoint.

- [ ] **Step 3: Implement B9–B16**

Thêm 2 tab (tái dùng widget thanh toán/hoàn tiền có sẵn); `service_code` dùng Select; payload/clamp; "chốt trả phòng" → `terminate`; `allow_self_approval` từ settings; amendment gửi field đổi + `note`; bắt riêng 2 code lỗi.

- [ ] **Step 4: Chạy test pass + analyze**

Run: `flutter test test/features/contracts/ && flutter analyze`. Expected: PASS.

- [ ] **Step 5: Commit**

`git commit -am "fix(parity): contract detail tabs, payload, terminate, approval (B9-B16)"`

---

### Task 11: Bulk apartment — bedrooms + số căn/tầng (C12–C13)

**Files:**
- Modify: `flutter_resihub/lib/features/buildings/widgets/bulk_apartment_modal.dart:33,155,288,325-408`
- Test: `flutter_resihub/test/features/buildings/bulk_apartment_modal_test.dart` (new)

**Interfaces:** Consumes: `BulkUnitRow`. Produces: `bedrooms` per unit, `unitsPerFloor` (clamp 1–50).

- [ ] **Step 1: Viết test fail**

`test('payload bedrooms defaults 1 and is editable', ...)`; `test('unitsPerFloor clamps 1..50', ...)`.
Run: `flutter test test/features/buildings/bulk_apartment_modal_test.dart`. Expected: FAIL.
- [ ] **Step 2: Implement** — thêm field `bedrooms`, input "Số căn mỗi tầng" có clamp, preview không gửi `dry_run`.
- [ ] **Step 3: Chạy test pass** — Expected: PASS.
- [ ] **Step 4: Commit** — `git commit -am "fix(parity): bulk apartment bedrooms and units per floor (C12-C13)"`

---

### Task 12: Apartment detail — xác nhận đổi diện tích 409 (C18)

**Files:**
- Modify: `flutter_resihub/lib/features/buildings/screens/apartment_detail_page.dart:381`
- Test: `flutter_resihub/test/features/buildings/apartment_detail_page_test.dart`

**Interfaces:** Consumes: HTTP 409 `AREA_CHANGE_REQUIRES_CONFIRM`. Produces: retry với `confirm_recalculate_fees: true`.

- [ ] **Step 1: Viết test fail**

`test('409 AREA_CHANGE_REQUIRES_CONFIRM retries with confirm flag', ...)` assert payload lần 2.
Run: `flutter test test/features/buildings/apartment_detail_page_test.dart`. Expected: FAIL.
- [ ] **Step 2: Implement** — bắt riêng 409 + code → ConfirmDialog → gửi lại kèm flag.
- [ ] **Step 3: Chạy test pass** — Expected: PASS.
- [ ] **Step 4: Commit** — `git commit -am "fix(parity): apartment area change 409 confirm (C18)"`

---

### Task 13: Service requests — datetime, ảnh nghiệm thu, AI override (D10–D12)

**Files:**
- Modify: `flutter_resihub/lib/features/maintenance/screens/service_requests_page.dart:1138,1308,1484,1902,2079,2117,2158`
- Test: `flutter_resihub/test/features/maintenance/service_requests_parity_test.dart`

**Interfaces:** Consumes: `toISOString` behavior từ React (`ServiceRequestsPage.jsx:550`). Produces: payload `next_appointment_at` ISO, `resolution_images`.

- [ ] **Step 1: Viết test fail**

`test('next_appointment_at sent as ISO', ...)`; `testWidgets('resolution images upload field exists', ...)`.
Run: `flutter test test/features/maintenance/`. Expected: FAIL.
- [ ] **Step 2: Implement D10–D12**

Convert datetime local ↔ ISO; FileUpload `resolution_images` max 3; select priority + category override; cho resolve từ `ON_HOLD`; AI card chỉ hiện khi có triage/status mở; thêm `ai_summary` + manual warning.
- [ ] **Step 3: Chạy test pass + analyze** — Expected: PASS.
- [ ] **Step 4: Commit** — `git commit -am "fix(parity): service request datetime, resolution images, AI (D10-D12)"`

---

### Task 14: Subscriptions — giữ dịch vụ, action hủy, ngày kết thúc (D14–D16)

**Files:**
- Modify: `flutter_resihub/lib/features/services/screens/subscriptions_page.dart:283,353,375,432,656,939`
- Test: `flutter_resihub/test/features/services/subscriptions_page_test.dart` (new)

**Interfaces:** Consumes: `validateServiceMetaInput`, `getDateOrderError` từ `core/utils/service_subscription_meta.dart`. Produces: keep-service → `ACTIVE`.

- [ ] **Step 1: Viết test fail**

`test('keep service sends status ACTIVE not REJECTED', ...)`; `test('CANCELLATION_PENDING row has 2 actions', ...)`; `test('end date respects end_date/start_date', ...)`.
Run: `flutter test test/features/services/`. Expected: FAIL.
- [ ] **Step 2: Implement D14–D16**

Đổi handler; thêm action trên bảng; end date rule + validate ngày; payload hủy có `cancel_reason/note`; validate meta mọi service + truyền errors.
- [ ] **Step 3: Chạy test pass** — Expected: PASS.
- [ ] **Step 4: Commit** — `git commit -am "fix(parity): subscription keep-service, cancel actions, dates (D14-D16)"`

---

### Task 15: Service catalog — auto-set, building edit, is_active, lỗi org (D13)

**Files:**
- Modify: `flutter_resihub/lib/features/services/screens/service_catalog_page.dart:218,272,295,327,345,359,390`
- Test: `flutter_resihub/test/features/services/service_catalog_page_test.dart` (new)

**Interfaces:** Consumes: `ORG_DEFAULT_SHARED_ACROSS_BUILDINGS` error code.

- [ ] **Step 1: Viết test fail** — `test('changing category does not rewrite billing_type/unit', ...)`. Run: `flutter test test/features/services/service_catalog_page_test.dart`. Expected: FAIL.
- [ ] **Step 2: Implement D13** — bỏ auto-set; building select disabled khi edit + bỏ `building_id` khỏi payload; `is_active` chỉ khi edit; xử lý riêng lỗi org; validate `unit_price >= 0`; uppercase code; description rỗng → `null`.
- [ ] **Step 3: Chạy test pass** — Expected: PASS.
- [ ] **Step 4: Commit** — `git commit -am "fix(parity): service catalog form behavior (D13)"`

---

### Task 16: Reports — toggle chart + occupancy chart (D17–D18)

**Files:**
- Modify: `flutter_resihub/lib/features/reports/screens/reports_page.dart:731,853,1140,1574`
- Test: `flutter_resihub/test/features/reports/chart_helpers_test.dart`, `reports_page_test.dart` (new)

**Interfaces:** Consumes: `buildOccupancyTrendChartData(occupancySeries)` từ `features/reports/utils/chart_helpers.dart:155`.

- [ ] **Step 1: Viết test fail** — `testWidgets('bar mode renders BarChart', ...)`; `test('occupancy series builds 3 datasets', ...)`.
Run: `flutter test test/features/reports/`. Expected: FAIL.
- [ ] **Step 2: Implement D17–D18** — switch Line/Bar thật; thay progress bằng stacked Bar chart; đổi ngày tự fetch; label/CSV theo React.
- [ ] **Step 3: Chạy test pass** — Expected: PASS.
- [ ] **Step 4: Commit** — `git commit -am "fix(parity): reports chart toggle and occupancy chart (D17-D18)"`

---

### Task 17: Users — tab cấu hình đầy đủ field (D21–D22)

**Files:**
- Modify: `flutter_resihub/lib/features/users/screens/users_page.dart:204,370,551,576,624,1048-1174`
- Test: `flutter_resihub/test/features/users/users_settings_test.dart`

**Interfaces:** Consumes: DEFAULT_BILLING_CONFIG fields từ React (`UsersPage.jsx:57-59`). Produces: ~15 field config.

- [ ] **Step 1: Viết test fail** — `testWidgets('config tab has SLA and contact field groups', ...)` assert ≥10 field mới. Run: `flutter test test/features/users/users_settings_test.dart`. Expected: FAIL.
- [ ] **Step 2: Implement D21–D22** — bổ sung field; status select khi edit; cho xóa role cuối; clamp + fallback 0; reset `reminder_days_text` đúng.
- [ ] **Step 3: Chạy test pass** — Expected: PASS.
- [ ] **Step 4: Commit** — `git commit -am "fix(parity): users config fields and permissions (D21-D22)"`

---

### Task 18: Resident — thống nhất form đăng ký + deep-link (E8–E9)

**Files:**
- Modify: `flutter_resihub/lib/features/resident/tabs/overview_tab.dart:43-176,2545-2874`, `resident_portal_page.dart:138-194`, `contract_tab.dart:573-653`, `invoices_tab.dart:37,291`, `maintenance_tab.dart:102`, `services_tab.dart:91`
- Test: `test/features/resident/overview_onboarding_test.dart`, `resident_portal_test.dart`, `contract_tab_test.dart`, `invoices_tab_test.dart` (new), `maintenance_tab_test.dart`, `services_tab_test.dart`

**Interfaces:** Consumes: `NotificationActionResult.buildingId`, params từ `GoRouter` (`go_router.dart`). Produces: mọi入口 dùng 1 form; deep-link truyền tới tab.

- [ ] **Step 1: Viết test fail** — `testWidgets('all onboarding entrypoints use consent form', ...)`; 5 test deep-link theo Review Focus + spec E9.
Run: `flutter test test/features/resident/`. Expected: FAIL.
- [ ] **Step 2: Implement E8** — xoá/gộp `_openApplicationModal` vào form chung (chọn căn, ngày sinh, ảnh CCCD, ghi chú, consent).
- [ ] **Step 3: Implement E9** — truyền params từ trang chủ xuống tab; xử lý từng biến thể như React.
- [ ] **Step 4: Chạy test pass + analyze** — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -am "fix(parity): unified onboarding form and deep links (E8-E9)"`

**Wave 2 gate:** full `flutter test` + `flutter analyze` + React lint/build xanh; update report.

---

## Wave 3 — Độ đầy đủ field và tiểu tiết

### Task 19: MeterReadings — filter, inline edit, batch, ngưỡng (D1–D8)

**Files:**
- Modify: `flutter_resihub/lib/features/meters/screens/meter_readings_page.dart:32-44,138,262,372-419,439,604,763,778,804,1091,1122`
- Test: `flutter_resihub/test/features/meters/meter_readings_page_test.dart` (new)

**Interfaces:** Consumes: `resolveAnomalyThresholdPct(rawPct)` từ `core/utils/billing_helpers.dart`, `recordBatch`, `confirmBatch`.

- [ ] **Step 1: Viết test fail** — 4 test: filter mặc định `active_contract=true`; inline edit hiện ô nhập; có 2 nút batch; `confirmBatch` payload có `period`/`building_id`; ngưỡng từ API.
Run: `flutter test test/features/meters/`. Expected: FAIL.
- [ ] **Step 2: Implement D1–D8** — theo spec; bỏ `UNRECORDED`; label `{threshold}%`; thêm filter hợp đồng/abnormal/lịch sử.
- [ ] **Step 3: Chạy test pass + analyze** — Expected: PASS.
- [ ] **Step 4: Commit** — `git commit -am "fix(parity): meter readings filter, inline edit, batch, threshold (D1-D8)"`

---

### Task 20: Batch photo import — note, FR-031, badge, retry (D9)

**Files:**
- Modify: `flutter_resihub/lib/features/meters/widgets/meter_batch_photo_import_modal.dart:98,176,366,546,581`
- Test: `flutter_resihub/test/features/meters/meters_batch_ocr_test.dart`

**Interfaces:** Consumes: `buildBatchPhotoSavePayload` tương đương React (`MeterBatchPhotoImportModal.jsx:990-1010`).

- [ ] **Step 1: Viết test fail** — `test('save payload includes abnormal_note per row', ...)`; `testWidgets('FR-031 banner appears', ...)`.
Run: `flutter test test/features/meters/meters_batch_ocr_test.dart`. Expected: FAIL.
- [ ] **Step 2: Implement D9** — cột note; banner; toast theo flagged/abnormal; badge AI; retry từng dòng; default building theo React.
- [ ] **Step 3: Chạy test pass** — Expected: PASS.
- [ ] **Step 4: Commit** — `git commit -am "fix(parity): batch photo note and FR-031 (D9)"`

---

### Task 21: Audit — limit selector, reset, User-Agent (D19)

**Files:**
- Modify: `flutter_resihub/lib/features/audit/widgets/audit_logs_view.dart:121,143,353-490,652-684,723`
- Test: `flutter_resihub/test/features/audit/audit_logs_view_test.dart` (new)

**Interfaces:** Consumes: `lockedScope`. Produces: `_limit` state.

- [ ] **Step 1: Viết test fail** — `testWidgets('limit selector 20/50/100 exists', ...)`. Run: `flutter test test/features/audit/`. Expected: FAIL.
- [ ] **Step 2: Implement D19** — đổi `final` → state + selector; điều kiện reset có `_scope`; modal thêm User-Agent.
- [ ] **Step 3: Chạy test pass** — Expected: PASS.
- [ ] **Step 4: Commit** — `git commit -am "fix(parity): audit limit selector and reset (D19)"`

---

### Task 22: Notifications — zalo content, scheduled date, inbox filter (D20)

**Files:**
- Modify: `flutter_resihub/lib/features/notifications/screens/notifications_page.dart:413,569,861,935,1182`
- Test: `flutter_resihub/test/features/notifications/announcements_test.dart`

**Interfaces:** Consumes: `toLocalDateTimeInputValue` equivalent, `selectedBuildingId`.

- [ ] **Step 1: Viết test fail** — `test('zalo_content trimmed not null', ...)`; `test('inbox filtered by building_id', ...)`.
Run: `flutter test test/features/notifications/`. Expected: FAIL.
- [ ] **Step 2: Implement D20** — trim; local datetime input; lọc inbox theo tòa; label "mới"; option căn kèm status.
- [ ] **Step 3: Chạy test pass** — Expected: PASS.
- [ ] **Step 4: Commit** — `git commit -am "fix(parity): notification compose and inbox filter (D20)"`

---

### Task 23: Settings — clamp, cron, deep link, AI default (D23–D24)

**Files:**
- Modify: `flutter_resihub/lib/features/ai_gateway/screens/settings_page.dart:241,287,340,908`, `flutter_resihub/lib/features/ai_gateway/widgets/ai_gateway_config_card.dart:119,302`
- Test: `flutter_resihub/test/features/ai_gateway/settings_page_test.dart`

**Interfaces:** Consumes: settings keys từ React (`SettingsPage.jsx:41,244-338`).

- [ ] **Step 1: Viết test fail** — `test('due 0 clamps to 1', ...)`; `test('monthly_budget fallback 0', ...)`; `test('AI task default false', ...)`.
Run: `flutter test test/features/ai_gateway/`. Expected: FAIL.
- [ ] **Step 2: Implement D23–D24** — clamp mọi giá trị; fallback 0; reset map đúng; cron 5 cột; deep link `?modal=ai|cron`; `Boolean()` default.
- [ ] **Step 3: Chạy test pass** — Expected: PASS.
- [ ] **Step 4: Commit** — `git commit -am "fix(parity): settings clamp, cron, AI defaults (D23-D24)"`

---

### Task 24: Buildings — status button, bank match, lookup, fallbacks (C1–C3)

**Files:**
- Modify: `flutter_resihub/lib/features/buildings/screens/buildings_page.dart:137,817,898,984`, `building_detail_page.dart:377,495,550`
- Test: `flutter_resihub/test/features/buildings/buildings_page_test.dart`

**Interfaces:** Consumes: `matchVietQrBank`, `normalizePhone`/`isValidPhone` từ `core/utils/`.

- [ ] **Step 1: Viết test fail** — `test('default bank resolved from VietQR list', ...)`; `test('lookup sends normalized phone', ...)`.
Run: `flutter test test/features/buildings/buildings_page_test.dart`. Expected: FAIL.
- [ ] **Step 2: Implement C1–C3** — nút status; bank match; normalize lookup; 3 fallback; uppercase code onChange.
- [ ] **Step 3: Chạy test pass** — Expected: PASS.
- [ ] **Step 4: Commit** — `git commit -am "fix(parity): building status, bank match, lookup, fallbacks (C1-C3)"`

---

### Task 25: FloorModal + tenant/apartment/contract misc (C11, C17, C19, B1–B2, B7–B8)

**Files:**
- Modify: `flutter_resihub/lib/features/buildings/widgets/floor_modal.dart:117,379,597`, `tenant_detail_page.dart:174,244,458,620,728,742`, `apartment_detail_page.dart:107,186,1733,1770`, `contracts_page.dart:86-102,375,643,662,894`
- Test: `test/features/buildings/floor_modal_test.dart` (new), `tenants_page_test.dart`, `apartment_detail_page_test.dart`, `contracts_page_test.dart`

**Interfaces:** Không đổi public API.

- [ ] **Step 1: Viết test fail** — 5 test nhỏ theo spec (includeZero toggle, 5 preset, customNames edit, cancelPolicy merge, contract label đầy đủ).
Run: `flutter test test/features/buildings/ test/features/contracts/`. Expected: FAIL.
- [ ] **Step 2: Implement** — theo spec từng item. B8 (AI scan) nếu quá tải → tách task riêng Wave 4 và báo trước (spec §8).
- [ ] **Step 3: Chạy test pass + analyze** — Expected: PASS.
- [ ] **Step 4: Commit** — `git commit -am "fix(parity): floor modal, tenant/apartment/contract details (C11,C17,C19,B1-B8)"`

**Wave 3 gate:** full suite xanh; update report.

---

## Wave 4 — Edge case, residentmisc, cleanup

### Task 26: Core utils edge cases (A6–A10)

**Files:**
- Modify: `flutter_resihub/lib/core/utils/{zalo_format,money_input_helpers,ai_helpers,billing_helpers,meter_batch_photo_helpers}.dart`
- Test: `flutter_resihub/test/core/utils/utils_test.dart`, `domain_helpers_test.dart`

**Interfaces:** Consumes: `Intl` date format; Produces: `zalo_format` output khớp React.

- [ ] **Step 1: Viết test fail** — `test('zalo preview uses Asia/Ho_Chi_Minh and HH:mm dd/MM', ...)`; `test('prorata keeps 1.5', ...)`; `test('negative half rounds toward +inf', ...)`.
Run: `flutter test test/core/utils/`. Expected: FAIL.
- [ ] **Step 2: Implement A6–A10** — theo spec; giữ nguyên 4 edge case meter batch.
- [ ] **Step 3: Chạy test pass + analyze** — Expected: PASS.
- [ ] **Step 4: Commit** — `git commit -am "fix(parity): core utils edge cases (A6-A10)"`

---

### Task 27: Resident misc — sync building, allSettled, bank_info, date (E10–E15)

**Files:**
- Modify: `flutter_resihub/lib/shared/widgets/common/notification_bell.dart:50`, `resident_portal_page.dart:74,191`, `invoices_tab.dart:37,81`, `contract_tab.dart:400,437,521`, `overview_tab.dart:253`, `public_explore_page.dart:843,1094,1113`
- Test: `test/core/utils/notification_navigation_test.dart`, `resident_portal_test.dart`, `contract_tab_test.dart`, `public_explore_test.dart`

**Interfaces:** Consumes: `syncBuildingFilterBeforeNavigate` (`core/utils/notification_navigation.dart:88`).

- [ ] **Step 1: Viết test fail** — `test('notification click syncs building filter', ...)`; `test('one failed fetch does not drop other result', ...)`; `test('bank_info payload is nested + idempotent', ...)`.
Run: `flutter test test/core/utils/ test/features/resident/`. Expected: FAIL.
- [ ] **Step 2: Implement E10–E15** — gọi helper; `allSettled` equivalent; nguồn tài khoản thanh toán; `{bank_info}` + idempotency; date editable; clamp hold days; OTP 6 ký tự; footer năm động.
- [ ] **Step 3: Chạy test pass + analyze** — Expected: PASS.
- [ ] **Step 4: Commit** — `git commit -am "fix(parity): resident misc deep links, bank info, dates (E10-E15)"`

---

### Task 28: Cleanup — TTL + ApiEndpoints (F1–F2)

**Files:**
- Modify: `flutter_resihub/lib/features/tenants/services/tenants_service.dart:7`, `meters_service.dart:8`, và 16 service files hardcode `'/api/v1/...'`
- Test: `test/features/tenants/tenants_service_test.dart`, `test/features/buildings/buildings_service_test.dart`

**Interfaces:** Consumes: `ApiEndpoints` (`core/constants/api_endpoints.dart`). Produces: không đổi hành vi.

- [ ] **Step 1: Viết test fail** — `test('tenant cache TTL is 25s', ...)`; `test('meter cache TTL is 20s', ...)`. Run: `flutter test test/features/tenants/`. Expected: FAIL.
- [ ] **Step 2: Implement F1–F2** — TTL 25s/20s; thay mọi hardcode path bằng `ApiEndpoints.*` (giữ nguyên path).
- [ ] **Step 3: Chạy test pass + analyze** — Expected: PASS.
- [ ] **Step 4: Commit** — `git commit -am "fix(parity): cache TTL and canonical endpoints (F1-F2)"`

---

## Final gate (sau 4 wave)

- [ ] **Step 1: Full verification**

Run (từ repo root): `cd flutter_resihub && flutter analyze && flutter test`; `cd ../frontend && npm run lint && npm run build`
Expected: analyze no issues, tất cả test pass, lint/build exit 0.

- [ ] **Step 2: Re-audit 6 domain**

Đọc lại `docs/superpowers/reports/2026-11-17-react-flutter-logic-audit.md`, đối chiếu từng dòng với code hiện tại; đánh dấu `✅` cho 97 item, giữ `➖` cho 14 item K1–K14.

- [ ] **Step 3: Cập nhật report tổng**

Append mục "Vòng 2 — logic": 97/97 sửa, 14 giữ, 0 mở; cập nhật `docs/flutter-react-ui-diff-report.md` đường dẫn chéo.

- [ ] **Step 4: Commit cuối**

`git commit -am "docs(parity): close v2 logic parity (97 fixed, 14 kept)"`

## Self-review checklist (đã kiểm tra khi viết)

- Spec coverage: 97 item inventory → T1–T28 cover hết; K1–K14 không task nào đụng; R1–R3 ở T8.
- Mỗi task có ≥1 test fail → pass (React dùng source assertion do constraint).
- Không task nào sửa cùng file trong cùng wave mà không gộp (floor_plan_view gộp T5; contract_detail gộp T10).
- Review Focus: 5 input class đều có test (T1, T1, T7/T10, T6, T18/T27).
- Không thêm dependency, không đụng backend, không đụng #20/#38/#39.
