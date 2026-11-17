# Thiết kế: Cân bằng logic React ↔ Flutter (vòng 2 — logic/payload)

> Ngày: 17/11/2026
> Trạng thái: CHỜ PHÊ DUYỆT
> Nguồn đầu vào: `docs/superpowers/reports/2026-11-17-react-flutter-logic-audit.md` (đối chiếu 6 luồng, có `file:line` cả hai bên).
> Số lượng chính xác: **97 việc cần sửa + 14 hạng mục giữ nguyên = 111 điểm**. Con số "~130" ở bản nháp là ước lượng, đã hiệu đính.

## 1. Ý định và lý do

Hai client React (`frontend/src/`) và Flutter (`flutter_resihub/lib/`) là bản song song của cùng một sản phẩm ResiHub v2.0. Vòng parity ngày 17/11 (`docs/flutter-react-ui-diff-report.md`) đã xử lý **93 khác biệt UI** (90 sửa, 3 giữ). Báo cáo đó **không** cover tầng logic: payload gửi API, validate, phân quyền, deep-link, option dropdown. Đợt rà soát mới phát hiện **~130 điểm** ở tầng này.

Mục tiêu: đưa hai client về cùng một logic, nhưng **không hạ cấp những chỗ Flutter làm tốt hơn**.

## 2. Mục tiêu / không mục tiêu / anti-goal

**Mục tiêu**
- Mọi option/value/label dropdown giống nhau (trừ tính năng Flutter-only đã duyệt).
- Mọi payload gửi backend có cùng key, cùng kiểu, cùng giá trị mặc định.
- Mọi rule validate và phân quyền giống nhau.
- Deep-link từ thông báo mở đúng modal/chi tiết ở cả hai.

**Không mục tiêu**
- Không đổi backend (`api/`), không đổi schema DB, không đổi PRD.
- Không làm lại 93 điểm UI parity đã xử lý.
- Không thêm dependency mới (đặc biệt không dựng test framework cho React).

**Anti-goal**
- Copy máy móc hành vi React sang Flutter ở những chỗ React rõ ràng thua (xem mục 4).
- Xóa tính năng chỉ có ở Flutter đã được duyệt ở vòng trước.
- "Sửa cho khớp" bằng cách cắt bớt chức năng React (mất AI scan, occupants, chart…).

## 3. Constraints

- React: không có test runner; verification = `npm run lint` + `npm run build`.
- Flutter: có ~45 file test; verification = `flutter test` + `flutter analyze`. Cần chốt baseline test trước khi sửa (báo cáo cũ có nhắc 4 test `overview_actions_test.dart` từng fail, sau đó được sửa — phải chạy lại để xác nhận).
- Git working tree sạch ở thời điểm viết doc.
- Mỗi đổi payload phải có 1 test Flutter tối thiểu kiểm tra key/value (ponytail: một check chạy được cho mỗi logic phức tạp).

## 4. Cách tiếp cận (đã chọn)

| Cách | Trade-off | Quyết định |
|---|---|---|
| 1. React là chuẩn, sửa Flutter theo 100% | Rẻ nhất nhưng xóa mất cải tiến Flutter | Loại |
| 2. Chọn cái đúng hơn từng điểm | Đúng sản phẩm nhất nhưng ~130 quyết định nhỏ, chậm | Loại |
| **3. Flutter sửa theo React ở phần thiếu/sai; giữ chỗ Flutter tốt hơn; chỉ sửa React ở 3 điểm rõ thua** | Một hướng sửa chính, không tự hạ cấp | **CHỌN** |

### 4.1 Giữ nguyên (Flutter-only / Flutter tốt hơn) — KHÔNG ĐỤNG

| # | Tính năng | Lý do |
|---|---|---|
| K1 | Refresh-token rotation: Flutter lưu `refreshToken` mới (`api_interceptors.dart:133-149`) | React giữ token cũ → rủi ro bảo mật |
| K2 | Scope cache Flutter tách `role+building` (`query_cache.dart:158-185`) | React dùng chung scope → lệch dữ liệu khi đổi tòa/vai trò |
| K3 | Rule invalidation `/api/v1/resident` + cache resident (`query_cache.dart:113-116`) | React thiếu → stale dữ liệu cư dân |
| K4 | `FlutterSecureStorage` cho token (`app_storage.dart`) | Bảo mật hơn localStorage |
| K5 | Public Dio có auto idempotency + cache invalidation (`dio_client.dart:76-94`) | React chỉ gắn thủ công ở `createReservation` |
| K6 | `AppEnv.apiBaseUrl` theo môi trường (`app_env.dart`) | React cố định `''` |
| K7 | Toast error 5s (`toast_provider.dart:83`) | UX tốt hơn 4s |
| K8 | OTP cooldown 60s + validate email/mã rỗng (`forgot_password_page.dart`) | React thiếu cả hai |
| K9 | OTP login `digitsOnly` + `LengthLimiting(6)` (`login_page.dart:836`) | React cho chữ lọt vào |
| K10 | Nút VietQR trong tab hóa đơn cư dân (`invoices_tab.dart:577`) | Tính năng Flutter-only đã duyệt vòng trước |
| K11 | Root `/` redirect sang `/explore`; alias `/admin/service-requests`; RoleGuard `toUpperCase()` | Hành viFlutter ổn định hơn |
| K12 | Polling thông báo định kỳ (`notification_bell.dart:44`) | React chỉ fetch khi gọi |
| K13 | BankSelect seed 44 ngân hàng dự phòng (`bank_select.dart:46`) | Chịu lỗi API tốt hơn |
| K14 | Pull-to-refresh + các tính năng Flutter-only khác đã ghi trong `docs/flutter-react-ui-diff-report.md` mục 3 | Đã duyệt vòng trước |

> Lưu ý: báo cáo parity cũ nhầm khi ghi "lịch sử tín dụng" là Flutter-only. Đã kiểm tra: `contract_detail_page.dart` **không có** tab `credits`, trong khi `ContractDetailPage.jsx:1665-1666,2447` có. Đây là **gap cần sửa** (mục 5.2/B9).

### 4.2 Sửa React (3 điểm duy nhất — vì React thua rõ)

| # | File | Đổi |
|---|---|---|
| R1 | `frontend/src/services/api.js:84-92` | Sau `/auth/refresh`, lưu `refreshToken` mới từ response vào localStorage (hiện React chỉ lưu `accessToken` + `user`) |
| R2 | `frontend/src/services/queryCache.js:13-37` | Key scope cache phải gồm `role` + `buildingId` theo `query_cache.dart:158-185` |
| R3 | `frontend/src/services/queryCache.js:160-182` | Thêm rule invalidation `/api/v1/resident` → `['resident','contracts','invoices','services','serviceRequests','deposits']` |

Ngoài R1–R3, React **không sửa**. Mọi việc còn lại nằm ở Flutter.

### 4.3 Giải đáp builder check (đã kiểm tra từ code/spec trong repo)

| Câu hỏi | Kết luận |
|---|---|
| Báo cáo nguồn ở đâu? Đếm lại ra 111 không phải 130? | Đã lưu báo cáo nguồn tại `docs/superpowers/reports/2026-11-17-react-flutter-logic-audit.md` (có `file:line` React lẫn Flutter). "~130" là ước lượng nháp; số đếm thực tế 97 sửa + 14 giữ = 111. Không có việc nào nằm ngoài inventory. |
| C14 có đảo rule xóa cư dân đã duyệt 09/11? | **Không.** `TenantsPage.jsx:728` hiện tại: `hasContractRef = Boolean(row.active_contract \|\| row.has_past_contract)` → disable cả khi chỉ có HĐ cũ. Plan `2026-11-09-sys-admin-delete.md:188` viết "disable nếu đang có hợp đồng hiệu lực", nhưng code React đã được mở rộng sau đó. Theo cách 3, code React hiện tại là đích. C14 giữ nguyên. |
| React đã xử lý hết deep-link E9 chưa? | **Đã đủ.** `OverviewTab.jsx:654-657` (apply/reservation_id), `ContractTab.jsx:573-641` (settlement/bank/renew/contract_view/deposit_view), `MaintenanceTab.jsx:200-204` (request_id), `InvoicesTab.jsx:291-296` (invoice_id/credit_id/modal=pay), `ServicesTab.jsx:99,203` (action=subscribe/subscription_id). Không cần task React mới; tuyên bố "chỉ sửa R1–R3" đứng vững. |
| B9 có phủ quyết "giữ nguyên #39"? | **Không.** #39 trong báo cáo UI vòng 1 là "lịch sử tín dụng" ở `invoices_tab.dart:943-1052` (tab hóa đơn **cư dân**) — giữ nguyên. B9 là tab `credits` ở `contract_detail_page.dart` (chi tiết hợp đồng **admin**), màn hình khác. Hai việc độc lập. |
| Các field mới đã có từ backend chưa? | **Có, không cần đổi backend.** `anomaly_threshold_pct` — React đọc ở `MeterReadingsPage.jsx:502,561,574` qua `resolveAnomalyThresholdPct` (`billing.js:518`); occupancy 3 dataset — `chartHelpers.js:155` build từ `occupancySeries` của reports API; ~10 field config — `UsersPage.jsx:57-59,401-439`; `proof_image` hoàn tiền — `ContractDetailPage.jsx:303,532`; FR-031 — rule client (`MeterBatchPhotoImportModal.jsx:781`, `billing.js:314`), không cần field API mới. |

## 5. Inventory công việc (builder planning từ đây)

Mức độ: 🔴 cao (sai payload/phân quyền/mất chức năng) · 🟠 tb · ⚪ thấp.
Quy ước: `React file:line` → `Flutter file:line`, hành vi đích = hành vi React.

### 5.A Nền tảng & dropdown

| ID | Mức | Đổi ở Flutter | Hành vi đích |
|---|---|---|---|
| A1 | 🔴 | `app_select.dart:283-290` | Search blob gồm `label+sublabel+badge+searchText+value` (sửa lỗi tìm BIN trong BankSelect) |
| A2 | 🟠 | `app_select.dart:79-84` | Thêm option placeholder `''` để clear lựa chọn |
| A3 | 🟠 | `app_select.dart:103,132` | Auto-search = `options>5 \|\| searchPlaceholder != null`; `searchable=false` phải tắt hẳn |
| A4 | 🟠 | `app_select.dart:360-386,201-227` | Render `logo` + `badge` ở option row và trigger |
| A5 | 🟠 | `service_subscription_meta_fields.dart:48-71` + `app_input.dart` | Truyền `maxLength` 30 (biển số) / 500 (ghi chú) |
| A6 | 🟠 | `core/utils/zalo_format.dart:205-209,250` | Dùng `Intl vi-VN` + `Asia/Ho_Chi_Minh`, thứ tự `HH:mm dd/MM/yyyy` |
| A7 | ⚪ | `billing_helpers.dart:149` | `previewSubscriptionProrata` giữ số thập phân (bỏ `.toInt()`) |
| A8 | ⚪ | `money_input_helpers.dart:40,55` | Làm tròn nửa lên/+∞ như `Math.round` JS |
| A9 | ⚪ | `ai_helpers.dart:126,242` | Chấp nhận `threshold=0`; giữ `code` gốc thay vì hardcode |
| A10 | ⚪ | `meter_batch_photo_helpers.dart:476,501,329,608` | 4 edge case: không có meter → không evaluate; phân biệt hoa thường; cancellation; `current_reading` null |

### 5.B Hợp đồng & tài chính

| ID | Mức | Đổi ở Flutter | Hành vi đích |
|---|---|---|---|
| B1 | 🟠 | `contracts_page.dart:33-65,684-704` | Nhãn/label option dropdown theo React; option căn hộ kèm trạng thái, giá, sublabel, badge số HĐ/giữ chỗ |
| B2 | 🟠 | `contracts_page.dart:286-288,340-342` | Gán rent/deposit từ `base_rent` bằng parse số, không `formatMoney().replaceAll('.','')` |
| B3 | 🔴 | `contracts_page.dart:451-483` | Validate tạo HĐ đầy đủ: billing_day 1-31, payment_due_days 1-60, email/CCCD/password ≥8, occupant trùng SĐT, dịch vụ, chặn trùng định danh |
| B4 | 🔴 | `contracts_page.dart:684-704` | Render form "Thành viên ở cùng" + Select quan hệ + validate (hiện chỉ có ở detail) |
| B5 | 🔴 | `contracts_page.dart:1005-1038` | Chọn dịch vụ cấu hình `quantity/unit_price/vehicle_plates/note` + validate, gửi payload |
| B6 | 🔴 | `contracts_page.dart:339-410` | Lịch bận căn hộ: tự chọn ngày trống đầu tiên, chặn chồng lấn, hiển thị lịch HĐ/giữ chỗ |
| B7 | 🟠 | `contracts_page.dart:353-410` | Tra cứu cư dân onBlur/Enter, xử lý duplicate/cross-building, nút "Đổi/Nhập lại" |
| B8 | 🟠 | `contracts_page.dart` (thiếu) | AI quét hợp đồng CCCD/giấy tờ |
| B9 | 🔴 | `contract_detail_page.dart:1523` | Thêm 2 tab `schedule` + `credits` ("Sổ tín dụng & Hoàn tiền", modal hoàn tiền với bank_name/account_number/account_holder/proof_image). **Không đụng** #39 (lịch sử tín dụng ở `invoices_tab.dart`, đã giữ nguyên vòng 1) |
| B10 | 🟠 | `contract_detail_page.dart:1416` | Ô `service_code` dùng Select động thay vì AppInput text |
| B11 | 🔴 | `contract_detail_page.dart:292-301` | Payload sửa nháp gửi `services` + `service_prices` + clamp billing_day/payment_due_days |
| B12 | 🔴 | `contract_detail_page.dart:1684` | "Chốt trả phòng & Chấm dứt ngay" gọi `terminate` (không phải `approveTermination`) |
| B13 | 🟠 | `contract_detail_page.dart:125,1645` | Form chấm dứt: `isPreMoveIn`, 2 lý do mặc định, clamp ngày `[start,end]` |
| B14 | 🟠 | `contract_detail_page.dart:1515` | Đọc `allow_self_approval` từ settings thay vì hardcode false |
| B15 | 🟠 | `contract_detail_page.dart:392-403` | Phụ lục: chỉ gửi field thay đổi, kèm `note` trong `changes` |
| B16 | 🟠 | `contract_detail_page.dart:277-285` | Bắt riêng `PRICE_NEEDS_APPROVAL` / `TRANSFER_NEEDS_APPROVAL` |
| B17 | 🔴 | `deposit_detail_modal.dart:131,222` | Thêm Select "Phương thức hoàn trả" (`BANK_TRANSFER`/`CASH`); ô ngân hàng chỉ hiện khi `BANK_TRANSFER` |
| B18 | 🟠 | `deposit_detail_modal.dart:323` | Regex STK `/^[A-Za-z0-9]{4,25}$/` |
| B19 | 🟠 | `deposit_detail_modal.dart:337` | `outstanding_debt` dùng `liveCalc.serviceDebt` |
| B20 | 🟠 | `deposit_detail_modal.dart` (thiếu) | Nút "sinh hóa đơn Pro-rata kỳ cuối" khi tất toán |
| B21 | ⚪ | `deposit_detail_modal.dart:345` | `bank_info: {}` thay vì `null` khi không chuyển khoản |
| B22 | 🟠 | `invoices_page.dart:31-39` | Thêm `CANCELLED` vào filter trạng thái (8 giá trị) |
| B23 | 🟠 | `invoices_page.dart:513,812` | Ô "Kỳ hóa đơn" dùng date-month picker + validate `YYYY-MM` |
| B24 | ⚪ | `invoices_page.dart:539` | "Phạm vi tòa nhà" chỉ hiện khi `!selectedBuildingId` |

### 5.C Tòa nhà / căn hộ / cư dân

| ID | Mức | Đổi ở Flutter | Hành vi đích |
|---|---|---|---|
| C1 | 🟠 | `buildings_page.dart:137,709` | Thêm nút "Kích hoạt/Tạm ngưng" (hiện chỉ có ở detail) |
| C2 | 🟠 | `buildings_page.dart:817,898` | Default bank dùng `matchVietQrBank`; lookup owner normalize phone/email trước khi gửi |
| C3 | 🟠 | `building_detail_page.dart:377,495,550` | Fallback `lease_terms.payment_account`; `active_contract?.apartment_code`; `floors.length \|\| total_floors` |
| C4 | 🟠 | `floor_plan_view.dart:192,1334` | Thêm Select "Khu/Phân khu" khi thêm căn, gửi `zone_id` |
| C5 | 🔴 | `floor_plan_view.dart:1521` | Filter reservation chờ dùng `PENDING_CONFIRM` (không phải `PENDING_PAYMENT`) |
| C6 | 🔴 | `floor_plan_view.dart:1210` | Phương thức thu tiền dùng đủ 6 option |
| C7 | 🟠 | `floor_plan_view.dart:780,1685` | Gate nút bằng `canManagerConfirmReservationPayment`; drawer có nút xác nhận/từ chối |
| C8 | 🟠 | `floor_plan_view.dart:1234` | Upload `evidence` (max 5) + gửi trong payload |
| C9 | 🟠 | `floor_plan_view.dart:1237` | Ngày giữ chỗ dùng date picker + `min/max` + error |
| C10 | 🟠 | `floor_plan_view.dart:372` | Refresh `aptDetail` sau `confirmPayment`; dùng idempotency key; auto cập nhật hold dates |
| C11 | 🟠 | `floor_modal.dart:381,409` | Toggle `includeZero` theo `zeroTouched`; 4–5 preset; cho sửa `customNames` |
| C12 | 🔴 | `bulk_apartment_modal.dart:33,325` | Thêm field `bedrooms` mỗi unit (hiện cố định 1) |
| C13 | 🟠 | `bulk_apartment_modal.dart:288,155` | Input "Số căn mỗi tầng" (clamp 1–50); preview không gửi `dry_run` |
| C14 | 🔴 | `tenants_page.dart:1358,1377` + `tenant_detail_page.dart:807` | Xóa chỉ `isSysAdmin` + disable khi có `active_contract \|\| has_past_contract` (theo `TenantsPage.jsx:728`; kế thừa và mở rộng rule 09/11 — xem §4.3) |
| C15 | 🔴 | `tenants_page.dart:866` + `tenant_detail_page.dart:881` | Shared Profile Lock: banner + disable 4 field định danh; AI mapping bỏ qua field bị khóa |
| C16 | 🔴 | `tenants_page.dart:675` + `app_input.dart:88` | Dùng controller thay vì `initialValue` để AI điền CCCD hiện lên field |
| C17 | 🟠 | `tenants_page.dart:57,1522` + `tenant_detail_page.dart:244` | Dùng `MOVED_OUT` + `displayTenantStatus`; nút "Xem hồ sơ"/"Mở gộp"; card nguyện vọng; cột deposit + "Mở hợp đồng" |
| C18 | 🔴 | `apartment_detail_page.dart:381` | Xử lý 409 `AREA_CHANGE_REQUIRES_CONFIRM` → confirm → gửi lại `confirm_recalculate_fees:true` |
| C19 | 🟠 | `apartment_detail_page.dart:186,1770` | `cancelPolicy` merge thay vì replace; prepend type lạ; cảnh báo `policy_override` |

### 5.D Vận hành admin

| ID | Mức | Đổi ở Flutter | Hành vi đích |
|---|---|---|---|
| D1 | 🔴 | `meter_readings_page.dart:138` | Filter `active_contract=true` mặc định như React |
| D2 | 🔴 | `meter_readings_page.dart:1091` | Inline edit chỉ số trên bảng + validate + AI gợi ý/confirm/dismiss |
| D3 | 🔴 | `meter_readings_page.dart:778` | Batch record "Lưu nháp"/"Lưu & Chốt" (`recordBatch`) |
| D4 | 🔴 | `meter_readings_page.dart:763` | `confirmReading` gửi `abnormal_note`, chặn khi biến động bất thường |
| D5 | 🟠 | `meter_readings_page.dart:804` | `confirmBatch` gửi `period` + `building_id` |
| D6 | 🟠 | `meter_readings_page.dart:262,42` | Ngưỡng bất thường đọc từ API `anomaly_threshold_pct` |
| D7 | 🟠 | `meter_readings_page.dart:32-44` | Option/label type + status theo React (bỏ `UNRECORDED`, dùng `{threshold}%`) |
| D8 | 🟠 | `meter_readings_page.dart` (thiếu) | Filter hợp đồng, filter "chỉ bất thường", lịch sử chỉ số trong modal |
| D9 | 🟠 | `meter_batch_photo_import_modal.dart:546` | Thêm cột "Ghi chú giải trình" + banner FR-031 + toast theo flagged/abnormal + badge AI + retry |
| D10 | 🔴 | `service_requests_page.dart:1308,1138` | Chuyển `next_appointment_at` sang ISO khi gửi và sang local input khi load |
| D11 | 🔴 | `service_requests_page.dart:2079` | Upload "Ảnh nghiệm thu" `resolution_images` (max 3) |
| D12 | 🟠 | `service_requests_page.dart:2158,2117,1902` | Select priority + category override; resolve từ `ON_HOLD`; điều kiện hiện AI card; `ai_summary` + manual warning |
| D13 | 🟠 | `service_catalog_page.dart:218,272,295,359` | Bỏ auto-set billing_type/unit; building select disabled khi edit + bỏ `building_id` khỏi payload update; is_active chỉ khi edit; xử lý `ORG_DEFAULT_SHARED_ACROSS_BUILDINGS` |
| D14 | 🔴 | `subscriptions_page.dart:283,939` | "Giữ lại dịch vụ" → `status: ACTIVE`; thêm action cho `CANCELLATION_PENDING` |
| D15 | 🔴 | `subscriptions_page.dart:353,375` | End date theo rule React + validate `getDateOrderError` |
| D16 | 🟠 | `subscriptions_page.dart:432,656` | Payload hủy kèm `cancel_reason`/`note`; validate meta mọi service + truyền errors vào field |
| D17 | 🔴 | `reports_page.dart:731` | Toggle Line/Bar phải đổi chart thật; thêm chart occupancy 3 dataset |
| D18 | 🟠 | `reports_page.dart:1140` | Đổi ngày tự fetch; các label/CSV theo React |
| D19 | 🟠 | `audit_logs_view.dart:121,723` | Selector `20/50/100`; điều kiện reset có `_scope`; modal có User-Agent |
| D20 | 🟠 | `notifications_page.dart:413,569,861` | `zalo_content.trim()` thay vì `null`; ngày dùng local input; inbox lọc theo tòa |
| D21 | 🔴 | `users_page.dart:1048-1174` | Bổ sung ~10 field tab Cấu hình (billing/SLA/contact) |
| D22 | 🟠 | `users_page.dart:204,370,551,624` | Status select khi edit; cho xóa role cuối; clamp + fallback `0`; reset `reminder_days_text` |
| D23 | 🟠 | `settings_page.dart:241,340,287,908` | Clamp mọi giá trị; fallback `monthly_budget_vnd=0`; reset map đúng; cron table 5 cột; deep link `?modal=ai\|cron` |
| D24 | ⚪ | `ai_gateway_config_card.dart:302,119` | Default `checked = Boolean(...)` thay vì `!= false` |

### 5.E Cổng cư dân / auth / public

| ID | Mức | Đổi ở Flutter | Hành vi đích |
|---|---|---|---|
| E1 | 🔴 | `contract_tab.dart:592` | Bỏ option `TRANSFER_ROOM` |
| E2 | 🔴 | `contract_tab.dart:607,636` | Form đề nghị HĐ dùng field **ngày** với default/min/max theo HĐ, required khi TERMINATION, validate thứ tự |
| E3 | 🔴 | `contract_tab.dart:648` | Payload `{contract_id, type, desired_date, note}` |
| E4 | 🔴 | `services_tab.dart:583` | Đăng ký gửi `start_date`, `note`, `vehicle_plates[]` (không phải `metadata.license_plate`) |
| E5 | 🔴 | `services_tab.dart:770` | Hủy gửi `{end_date, note}` |
| E6 | 🔴 | `profile_tab.dart:167` | `uploadIdImage` gửi `image_base64` (đồng nhất với `overview_tab.dart:2678`) |
| E7 | 🟠 | `profile_tab.dart:167-168` | Sau lưu profile gọi `updateUser` để header/auth không cũ |
| E8 | 🔴 | `overview_tab.dart:43-176` vs `2545-2874` | Thống nhất 2 form đăng ký thuê về 1 form (chọn căn, ngày sinh, ảnh CCCD, ghi chú, consent) |
| E9 | 🔴 | `resident_portal_page.dart` + các tab | Truyền và xử lý deep-link: `?modal=apply/reservation_id`, settlement/bank/renew/contract_view/deposit_view, `?request_id`, `?invoice_id/credit_id/modal=pay`, `?action=subscribe/subscription_id`. React đã có đủ mọi biến thể (§4.3) |
| E10 | 🟠 | `notification_bell.dart:50` | Gọi `syncBuildingFilterBeforeNavigate` trước khi điều hướng |
| E11 | 🟠 | `resident_portal_page.dart:191` | `Future.wait` → xử lý từng kết quả kiểu `allSettled`; validate `target_contract_id` trong active contracts |
| E12 | 🟠 | `invoices_tab.dart:81,37` | Nguồn tài khoản thanh toán: gọi `buildings.list()` + `users.getSettings()`, ưu tiên building → settings → overview |
| E13 | 🟠 | `contract_tab.dart:535`, `overview_tab.dart:253`, `contract_tab.dart:437` | Gửi `{bank_info}` + idempotency key cho cập nhật TK hoàn cọc / hoàn giữ chỗ / khiếu nại |
| E14 | 🟠 | `public_explore_page.dart:1113` | "Giữ đến ngày" cho phép sửa với `min/max` |
| E15 | ⚪ | `public_explore_page.dart:1094,843,480` | `public_max_hold_days` clamp như React; OTP reservation giới hạn 6 ký tự; footer năm động |

### 5.F React-side + cleanup

| ID | Mức | File | Đổi |
|---|---|---|---|
| R1–R3 | 🟠 | `api.js`, `queryCache.js` | Như mục 4.2 |
| F1 | ⚪ | `tenants_service.dart:7`, `meters_service.dart:8` | TTL về 25s / 20s như React (giữ rule cache mở rộng của Flutter) |
| F2 | 🟠 | 16/18 service Flutter | Thay hardcode `'/api/v1/...'` bằng `ApiEndpoints.*` (không đổi hành vi; dễ bảo trì) |

## 6. Ưu tiên wave (builder có thể điều chỉnh)

1. **Wave 1 — A1–A5 + B17/B22/C5/C6/C14/C15/E1–E6/R1–R3**: lỗi dropdown + sai key payload + phân quyền + option thừa. Đây là nhóm "gãy chức năng".
2. **Wave 2 — B3–B16, C4/C12/C18, D10–D16, E8/E9**: form/validate/deep-link bị cắt.
3. **Wave 3 — D1–D9, D17–D24, C1–C3/C7–C11/C13/C17/C19, B1/B2/B7/B8/B20**: độ đầy đủ field & tiểu tiết.
4. **Wave 4 — A6–A10, E10–E15, F1/F2**: edge case + cleanup.

Các wave độc lập theo feature → có thể chạy song song agent theo domain, nhưng **mỗi file chỉ một agent sửa** để tránh conflict.

## 7. Verification

- Sau mỗi wave: `flutter analyze`, `flutter test`, `npm run lint`, `npm run build`.
- Với mỗi đổi payload: 1 test asserting key/value (ví dụ `services_tab_test.dart`, `contract_tab_test.dart`, `deposit_detail_modal` tương đương).
- Với mỗi đổi dropdown: widget test kiểm tra option list + search theo BIN + clear option.
- Cuối cùng: chạy lại audit so sánh 6 domain để confirm không còn item mở, cập nhật `docs/flutter-react-ui-diff-report.md` với phần "vòng 2 — logic".

## 8. Để lại cho builder

- Chia task cụ thể, thứ tự trong từng wave, tên test file.
- Quyết định cách render 2 tab mới `schedule`/`credits` (tái dùng widget có sẵn trong `payments_page.dart`/`deposits_page.dart` nếu được).
- B8 (AI scan hợp đồng) và D2 (inline edit đồng hồ): nếu quá tải, tách wave riêng và báo trước thay vì cắt chức năng.
- Mọi câu hỏi "có cần đổi backend / có đảo quyết định vòng 1 / React có thiếu không" đã được trả lời ở §4.3 — không hỏi lại người dùng.
