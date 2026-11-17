# Báo cáo đối chiếu logic React ↔ Flutter (vòng 2 — logic/payload)

> Ngày: 17/11/2026
> Phạm vi: `frontend/src/**` ↔ `flutter_resihub/lib/**`, đọc tĩnh 6 luồng song song. Không chạy app, không sửa code.
> Đây là nguồn đầu vào của `docs/superpowers/specs/2026-11-17-react-flutter-logic-parity-design.md`.
> Báo cáo UI vòng 1: `docs/flutter-react-ui-diff-report.md` (93 điểm, 90 sửa / 3 giữ).
> Baseline thực thi (17/11/2026): Flutter 3.50.0 `flutter analyze` no issues, `flutter test` **626 passed**; React `npm run lint` warnings-only (exit 0), `npm run build` OK. `npm ci` đã chạy để có `node_modules` (không thêm dependency).

## Kết luận

Khớp một phần. Không thiếu màn hình nào. Khớp 100% ở constants/statuses/roles/navigation, 18 endpoint API + method + payload, 17 prefix Idempotency-Key, 27 flag permission. Lệch ở dropdown, payload, validate, phân quyền, deep-link. Inventory đếm được: **97 việc cần sửa + 14 hạng mục giữ nguyên**.

---

## 1. Hạ tầng & dropdown

### 1.1 `Select.jsx` ↔ `app_select.dart`

| React | Flutter | Khác biệt | Mức |
|---|---|---|---|
| `Select.jsx:77-79,118` searchBlob = `label+sublabel+badge+searchText+value` | `app_select.dart:283-290` chỉ `label+sublabel` | Search BIN trong BankSelect hỏng | 🔴 |
| `Select.jsx:51-62` placeholder là option `''` | `app_select.dart:79-84` không có | Không clear được lựa chọn | 🟠 |
| `Select.jsx:108-111` auto-search = `>5 \|\| searchPlaceholder`, `searchable=false` tắt hẳn | `app_select.dart:103,132` = `searchable \|\| >5` | Search hiện/tắt sai điều kiện | 🟠 |
| `Select.jsx:436-452` render `logo`+`badge` | `app_select.dart:360-386` bỏ hết | Mất nhãn BIN/logo | 🟠 |
| `Select.jsx:320-343` trigger hiện logo+badge | `app_select.dart:201-227` chỉ chữ | Cosmetic | ⚪ |

### 1.2 Khác

| React | Flutter | Khác biệt | Mức |
|---|---|---|---|
| `ServiceSubscriptionMetaFields.jsx:32,45` `maxLength` 30/500 | `service_subscription_meta_fields.dart:48-71`, `app_input.dart:24-49` không có | Gõ vượt 500 ký tự | 🟠 |
| `zaloFormat.js:80-93,200,238` Intl + `Asia/Ho_Chi_Minh`, `HH:mm dd/MM/yyyy` | `zalo_format.dart:205-209,250` giờ local, `dd/MM/yyyy HH:mm` | Lệch giờ + thứ tự | 🟠 |
| `billing.js:94` giữ thập phân | `billing_helpers.dart:149` `.toInt()` | Prorata 1.5 → 1 | ⚪ |
| `moneyInput.js:30,43` `Math.round` | `money_input_helpers.dart:40,55` `.round()` | Số âm `.5` khác | ⚪ |
| `aiHelpers.js:113,216` | `ai_helpers.dart:126,242` | threshold=0, hardcode code | ⚪ |
| `meterBatchPhotoHelpers.js:339,367,268,453` | `meter_batch_photo_helpers.dart:476,501,329,608` | 4 edge case | ⚪ |
| `validation/format/dateRange/permissions/notificationNavigation/residentNavHelpers/depositUiHelpers/idempotency/serviceSubscriptionMeta/vietqrBanks` | bản Dart tương ứng | **Khớp** | — |

---

## 2. Hợp đồng & tài chính

| React | Flutter | Khác biệt | Mức |
|---|---|---|---|
| `ContractsPage.jsx:86-102,1885` nhãn option đầy đủ | `contracts_page.dart:33-65,684` rút gọn + option `''` | Nhãn/scoped option | 🟠 |
| `ContractsPage.jsx:375,643` `Math.round(base_rent)` | `contracts_page.dart:286,340` `formatMoney().replaceAll('.','')` | Gán giá dễ sai | 🟠 |
| `ContractsPage.jsx:1059-1186` validate đầy đủ | `contracts_page.dart:451` chỉ 4 check | Thiếu validate | 🔴 |
| `ContractsPage.jsx:2439` occupants + Select quan hệ | không render | Thiếu form | 🔴 |
| `ContractsPage.jsx:2766` cấu hình dịch vụ | `contracts_page.dart:1005` chỉ FilterChip | Thiếu quantity/note/plates | 🔴 |
| `ContractsPage.jsx:446` lịch bận | `contracts_page.dart:339` text input | Không chặn chồng lấn | 🔴 |
| `ContractsPage.jsx:662` lookup onBlur | `contracts_page.dart:353` nút thủ công | Thiếu duplicate flow | 🟠 |
| `ContractsPage.jsx:894` AI scan | không có | Thiếu | 🟠 |
| `ContractDetailPage.jsx:1665,2447` tab `credits` + `schedule` | `contract_detail_page.dart:1523` chỉ 4 tab | Thiếu 2 tab | 🔴 |
| `ContractDetailPage.jsx:3693` service_code Select | `contract_detail_page.dart:1416` text | Sai control | 🟠 |
| `ContractDetailPage.jsx:1157` payload sửa nháp | `contract_detail_page.dart:292` 8 field | Thiếu services/service_prices | 🔴 |
| `ContractDetailPage.jsx:1779` → `terminate` | `contract_detail_page.dart:1684` → `approveTermination` | Sai API | 🔴 |
| `ContractDetailPage.jsx:1427` 2 lý do + clamp | `contract_detail_page.dart:125` 1 lý do | Form chấm dứt | 🟠 |
| `ContractDetailPage.jsx:406` settings `allow_self_approval` | `contract_detail_page.dart:1515` hardcode false | Cứng hóa | 🟠 |
| `ContractDetailPage.jsx:1271` chỉ field đổi + note | `contract_detail_page.dart:392` gửi thô | Amendment | 🟠 |
| `ContractDetailPage.jsx:744` bắt riêng 2 code lỗi | `contract_detail_page.dart:277` gộp | Error handling | 🟠 |
| `DepositsPage.jsx:2560` Select phương thức hoàn trả | `deposit_detail_modal.dart:131` hardcode BANK_TRANSFER | Thiếu dropdown | 🔴 |
| `DepositsPage.jsx:2566` ô bank conditional | `deposit_detail_modal.dart:1390` vô điều kiện | Ẩn/hiện sai | 🟠 |
| `DepositsPage.jsx:827` regex STK | `deposit_detail_modal.dart:323` chỉ rỗng | Validate | 🟠 |
| `DepositsPage.jsx:729` `liveCalc.serviceDebt` | `deposit_detail_modal.dart:337` thô | Sai số tiền | 🟠 |
| `DepositsPage.jsx:202` pro-rata batch | không có | Thiếu | 🟠 |
| `DepositsPage.jsx:847` `bank_info: {}` | `deposit_detail_modal.dart:345` `null` | Payload | ⚪ |
| `InvoicesPage.jsx:35` 8 status (có CANCELLED) | `invoices_page.dart:31` 7 | Thiếu option | 🟠 |
| `InvoicesPage.jsx:465` `type=month` | `invoices_page.dart:513` text | Không validate | 🟠 |
| `InvoicesPage.jsx:549` scope condition | `invoices_page.dart:819` sai điều kiện | Ẩn/hiện | ⚪ |
| PaymentsPage / InvoiceDetailPage | bản Dart | **Khớp** | — |

---

## 3. Tòa nhà / căn hộ / cư dân

| React | Flutter | Khác biệt | Mức |
|---|---|---|---|
| `BuildingsPage.jsx` (chỉ detail có) | `buildings_page.dart:137` có nút status | Thừa ở Flutter | 🟠 |
| `BuildingsPage.jsx:107` `matchVietQrBank` | `buildings_page.dart:817` hardcode VCB | Default sai | 🟠 |
| `BuildingsPage.jsx:167` normalize phone/email | `buildings_page.dart:898` gửi raw | Lookup sai | 🟠 |
| `BuildingDetailPage.jsx:338,530,314` fallback 3 chỗ | `building_detail_page.dart:377,495,550` mất fallback | Hiển thị sai | 🟠 |
| `FloorPlanPage.jsx:1195` zone select | `floor_plan_view.dart:192` không có | `zone_id` null | 🔴 |
| `FloorPlanPage.jsx:864` `PENDING_CONFIRM` | `floor_plan_view.dart:1521` `PENDING_PAYMENT` | Lọc sai | 🔴 |
| `FloorPlanPage.jsx:1316` 6 phương thức | `floor_plan_view.dart:1210` 2 | Thiếu option | 🔴 |
| `FloorPlanPage.jsx:576` `canManagerConfirm…` | `floor_plan_view.dart:780` chỉ `isManager` | Phân quyền | 🟠 |
| `FloorPlanPage.jsx:1346` upload evidence | `floor_plan_view.dart:1234` không có | Thiếu ảnh | 🟠 |
| `FloorPlanPage.jsx:1326` date picker | `floor_plan_view.dart:1237` text | Validate | 🟠 |
| `FloorPlanPage.jsx:229` idempotency + refresh drawer | `floor_plan_view.dart:372` thiếu | Luồng | 🟠 |
| `FloorModal.jsx:117,379,597` includeZero + 5 preset + customNames | `floor_modal.dart:381,409,502` 2 preset, read-only | Thiếu use-case | 🔴 |
| `BulkApartmentModal.jsx:336` bedrooms | `bulk_apartment_modal.dart:33` cố định 1 | Thiếu field | 🔴 |
| `BulkApartmentModal.jsx:283` số căn/tầng | `bulk_apartment_modal.dart:288` thiếu | Thiếu | 🟠 |
| `TenantsPage.jsx:727` sysadmin + disable `active_contract \|\| has_past_contract` | `tenants_page.dart:1358` canManage + không disable | Phân quyền | 🔴 |
| `TenantsPage.jsx:1221` Shared Profile Lock | `tenants_page.dart:866` không có | Bảo vệ dữ liệu | 🔴 |
| `TenantsPage.jsx:1064` controlled value | `tenants_page.dart:675` `initialValue` | AI điền không hiện | 🔴 |
| `TenantsPage.jsx:75` MOVED_OUT + display helper | `tenants_page.dart:57` INACTIVE | Status | 🟠 |
| `TenantDetailPage.jsx:638,826` tương tự | `tenant_detail_page.dart:807,881` tương tự | Phân quyền | 🔴 |
| `TenantDetailPage.jsx:174,620,742,458` helper + card + cột | `tenant_detail_page.dart` thiếu | Hiển thị | 🟠 |
| `ApartmentDetailPage.jsx:191` 409 confirm | `apartment_detail_page.dart:381` toast chung | Không đổi được diện tích | 🔴 |
| `ApartmentDetailPage.jsx:107,2154,1733` merge + type + policy_override | `apartment_detail_page.dart:186,1770` thay thế | Luồng | 🟠 |

---

## 4. Vận hành admin

| React | Flutter | Khác biệt | Mức |
|---|---|---|---|
| `MeterReadingsPage.jsx:482` `active_contract=true` mặc định | `meter_readings_page.dart:138` không có | Danh sách khác | 🔴 |
| `MeterReadingsPage.jsx:288` inline edit + AI | `meter_readings_page.dart:1091` Text chỉ đọc | Thiếu | 🔴 |
| `MeterReadingsPage.jsx:764` batch record 2 nút | `meter_readings_page.dart:778` chỉ confirmBatch | Thiếu | 🔴 |
| `MeterReadingsPage.jsx:838` abnormal_note | `meter_readings_page.dart:763` không gửi | Chốt sai | 🔴 |
| `MeterReadingsPage.jsx:819` period + building_id | `meter_readings_page.dart:804` thiếu | Payload | 🟠 |
| `MeterReadingsPage.jsx:501` threshold từ API | `meter_readings_page.dart:262` hardcode 30 | Cấu hình | 🟠 |
| `MeterReadingsPage.jsx:1264` type/status options | `meter_readings_page.dart:32` khác + thừa UNRECORDED | Option | 🟠 |
| `MeterReadingsPage.jsx:1285,1243` filter hợp đồng/abnormal | không có | Thiếu | 🟠 |
| `MeterBatchPhotoImportModal.jsx:799` cột ghi chú | `meter_batch_photo_import_modal.dart:546` không có | Sai FR-031 | 🔴 |
| `MeterBatchPhotoImportModal.jsx:773,499,854,1016` banner/toast/badge/retry | bản Dart thiếu | AI + hậu kiểm | 🟠 |
| `ServiceRequestsPage.jsx:550,350` ISO + local input | `service_requests_page.dart:1308,1138` chuỗi thô | Sai datetime | 🔴 |
| `ServiceRequestsPage.jsx:1676` resolution_images | `service_requests_page.dart:2079` không có upload | Thiếu ảnh | 🔴 |
| `ServiceRequestsPage.jsx:1614,1572,1286,1199` priority/category/AI card | `service_requests_page.dart:2158,1902,1484` thiếu | AI + update | 🟠 |
| `ServiceCatalogPage.jsx:499,528,563,218` | `service_catalog_page.dart:218,272,295,359` | Auto-set / edit / lỗi | 🟠 |
| `SubscriptionsPage.jsx:353` ACTIVE | `subscriptions_page.dart:283` REJECTED | Sai action | 🔴 |
| `SubscriptionsPage.jsx:504` CANCELLATION_PENDING action | `subscriptions_page.dart:939` không có | Thiếu action | 🔴 |
| `SubscriptionsPage.jsx:268,294` end date + validate | `subscriptions_page.dart:353,375` today, không validate | Sai date | 🔴 |
| `SubscriptionsPage.jsx:324,885` reason/note | `subscriptions_page.dart:432` thiếu | Payload | 🟠 |
| `ReportsPage.jsx:604` toggle chart | `reports_page.dart:731` chỉ đổi highlight | Chart không đổi | 🔴 |
| `ReportsPage.jsx:329` occupancy chart | `reports_page.dart:853` chỉ progress | Thiếu chart | 🟠 |
| `ReportsPage.jsx:219` tự fetch | `reports_page.dart:1140` bấm Lọc | UX | 🟠 |
| `AuditLogsPage.jsx:491` limit selector | `audit_logs_view.dart:121` cố định 20 | Thiếu | 🟠 |
| `NotificationsPage.jsx:421,552,750` | `notifications_page.dart:413,569,861` | zalo/date/filter tòa | 🟠 |
| `UsersPage.jsx:821-1051` ~15 field config | `users_page.dart:1048-1174` ~5 field | Thiếu ~10 field | 🔴 |
| `UsersPage.jsx:1106,276,465,437` status/xóa role/fallback/clamp | `users_page.dart:204,370,576,551` | Phân quyền + số | 🟠 |
| `SettingsPage.jsx:244,374,342,1000,132` | `settings_page.dart:241,340,287,908` | Clamp/fallback/cron/deep link | 🟠 |
| `AiGatewayConfigCard.jsx:182` `Boolean()` | `ai_gateway_config_card.dart:302` `!= false` | Default khác | ⚪ |
| Dashboard & constants dùng chung | bản Dart | **Khớp** | — |

---

## 5. Cổng cư dân / auth / public

| React | Flutter | Khác biệt | Mức |
|---|---|---|---|
| `ContractTab.jsx:1820` 2 option | `contract_tab.dart:592` thêm TRANSFER_ROOM | Option thừa | 🔴 |
| `ContractTab.jsx:1842` field ngày | `contract_tab.dart:607` field lý do | Form khác | 🔴 |
| `ContractTab.jsx:349` `{type, desired_date}` | `contract_tab.dart:648` `{request_type, reason}` | Sai key | 🔴 |
| `ServicesTab.jsx:322` `{start_date,note,vehicle_plates}` | `services_tab.dart:583` `{metadata.license_plate}` | Sai key | 🔴 |
| `ServicesTab.jsx:375` `{end_date,note}` | `services_tab.dart:770` `{cancellation_reason}` | Sai key | 🔴 |
| `ProfileTab.jsx:186` `image_base64` | `profile_tab.dart:167` `image_data` | Sai key | 🔴 |
| `ProfileTab.jsx:126` updateUser | `profile_tab.dart:167` thiếu | State cũ | 🟠 |
| `OverviewTab.jsx:311` 1 form | `overview_tab.dart:43` + `2545` 2 form | Form không thống nhất | 🔴 |
| `OverviewTab.jsx:654`, `ContractTab.jsx:573`, `InvoicesTab.jsx:291`, `MaintenanceTab.jsx:200`, `ServicesTab.jsx:202` deep-link | Flutter thiếu/không truyền | Deep-link rớt | 🔴 |
| `useNotificationAction.js:45` sync building filter | `notification_bell.dart:50` thiếu | Sai dữ liệu sau click | 🟠 |
| `ResidentPortalPage.jsx:57` allSettled | `resident_portal_page.dart:191` Future.wait | 1 lỗi mất cả 2 | 🟠 |
| `InvoicesTab.jsx:184` building+settings source | `invoices_tab.dart:81` chỉ overview | Nguồn TK thanh toán | 🟠 |
| `ContractTab.jsx:400`, `OverviewTab.jsx:628` `{bank_info}` + idem | Flutter flat, không idem | Payload | 🟠 |
| `PublicExplorePage.jsx:783` date editable | `public_explore_page.dart:1113` readOnly | Không sửa được ngày | 🟠 |
| Bảo trì / thanh toán / public filter / login / contact | bản Dart | **Khớp** | — |

---

## 6. Service / API / router / state

**Khớp 1:1:** 18 endpoint + method + payload, 17 prefix Idempotency-Key (`api.js:14-32` ↔ `api_interceptors.dart:11-29`), 27 flag permission, điều hướng sau login, read-notification (storage key + cap 200 + công thức unread).

| React | Flutter | Khác biệt | Mức |
|---|---|---|---|
| `api.js:85` không lưu refreshToken mới | `api_interceptors.dart:133` lưu | Rotation | 🟠 |
| `queryCache.js:13` scope không có role/building | `query_cache.dart:158` có | Stale khi đổi tòa | 🟠 |
| `queryCache.js:160` thiếu rule `/resident` | `query_cache.dart:113` có | Stale resident | 🟠 |
| `tenants.service.js:4` TTL 25s | `tenants_service.dart:7` 60s | TTL | ⚪ |
| `meters.service.js:5` TTL 20s | `meters_service.dart:8` 60s | TTL | ⚪ |
| `public.service.js:4` idempotency thủ công | `dio_client.dart:76` auto | Flutter tốt hơn | KEEP |
| `api.js:6` baseURL `''` | `app_env.dart` theo env | Flutter tốt hơn | KEEP |
| `toastStore.js:7` 4s | `toast_provider.dart:83` error 5s | Flutter tốt hơn | KEEP |
| 16/18 service Flutter hardcode path | `api_endpoints.dart` có canonical | Bảo trì | 🟠 |
| `router/index.jsx` không có alias service-requests | `app_router.dart:374` có | Flutter tốt hơn | KEEP |
