# Flutter ↔ React UI Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Đưa giao diện Flutter (cổng cư dân + admin) khớp với ReactJS theo 93 điểm khác biệt đã audit, ưu tiên theo mức độ ảnh hưởng người dùng.

**Architecture:** Giữ nguyên cấu trúc hiện có (`features/resident/tabs/*`, `features/*/screens/*`, `shared/widgets/*`), **không thêm dependency**, không tạo component abstraction cho widget dùng một lần. Mỗi task chỉnh trực tiếp file tương ứng và thêm 1 widget/unit test kèm theo. Nguyên tắc parity: React là nguồn sự thật về nhãn, trường dữ liệu và bố cục.

**Tech Stack:** Flutter 3.50 / Dart 3.14, Riverpod 2.6, go_router 14, lucide_icons_flutter, flutter_test; React 19 + Vite (chỉ làm reference, không sửa).

**Spec:** `docs/flutter-react-ui-diff-report.md` (93 dòng, có `file:line` 2 bên). Ảnh chụp đối chiếu: `docs/ui-diff-screenshots/`.

**Execution order:** Phase A (resident) xong thì Phase B (admin). Có thể tách thành 2 plan riêng nếu muốn chạy 2 track song song — mỗi task tự build/test/commit được.

## Global Constraints

- Không sửa `frontend/**`. Không thêm package mới vào `pubspec.yaml`.
- Mọi chuỗi tiếng Việt copy **nguyên văn** từ React (`OverviewTab.jsx`, `NotificationsTab.jsx`, `ContactTab.jsx`, `ProfileTab.jsx`, `InvoicesTab.jsx`, `ContractTab.jsx`, `MaintenanceTab.jsx`, `ServiceRequestsPage.jsx`, `DepositsPage.jsx`, `SettingsPage.jsx`).
- Dùng `AppColors`, `formatMoney`, `formatDate`, `formatDateTime`, `AppBadge`, `AppButton`, `AppCard` có sẵn — không tự định nghĩa lại.
- Fallback dữ liệu: mọi field mới đều null-safe, fallback `0`/`'---'`/`const []`, không làm crash khi API thiếu field.
- Không đụng vào các file đang có thay đổi chưa commit của người dùng: `floor_plan_view.dart`, `meter_batch_photo_import_modal.dart`, `data_table_widget.dart`, `admin_shell.dart`, phần `SelectionArea` trong `resident_shell.dart` (giữ nguyên).
- Lệnh test luôn chạy từ `flutter_resihub/`: `flutter test <path> --plain-name "<tên test>"`.
- Mỗi task kết thúc bằng 1 commit riêng; message dạng `fix(resident): <mô tả>` / `fix(admin): <mô tả>`.

## Review Focus

| Input / điều kiện dễ hỏng | Hành vi mong đợi | Test gắn ở task |
|---|---|---|
| `contract.amenities` là JSON string, comma-string, List<string> hoặc Map | `parseResidentAmenities` trả cùng nhãn tiếng Việt như React `AMENITY_LABELS` | Task 1 |
| `end_date` null / quá khứ / <30 ngày | `getResidentDaysRemaining` trả `null` / số âm / số dương; badge "Còn N ngày hết hạn HĐ" chỉ hiện khi `0 <= N <= 30` | Task 1, Task 3 |
| KPI khi `current_amount_due = 0`, `rent_amount = 0`, `deposit_amount = 0`, `unreadCount = 0` | Vẫn render đủ 4 thẻ, footer hiện "Không có dư nợ quá hạn", không overflow, không chia cho 0 | Task 2 |
| Viewport 390px / 768px / 1440px | 390: tab strip ngang + bottom nav; 768: strip, không bottom nav; 1440: sidebar 240px, không strip | Task 6 |
| `latest_invoice` null hoặc `status = DRAFT/VOID` | Card "Hóa đơn kỳ gần nhất" hiện text "Hiện chưa có hóa đơn nào...", không crash | Task 4 |
| Deep-link `?overdue=1`, `?tab=payout`, `?status=DISPUTED` vào Deposits | Flutter đọc param, hiện banner "Đang áp dụng bộ lọc nhanh từ Dashboard" + nút xóa, lọc đúng tab/rows | Task 13 |
| Mật khẩu có/show-hidden | `obscureText` đổi được, không mất nội dung 3 field | Task 9 |

---

## Phase A — Cổng cư dân

### Task 1: Helper parse amenities & days-remaining

**Files:**
- Create: `flutter_resihub/lib/core/utils/resident_overview_helpers.dart`
- Test: `flutter_resihub/test/core/utils/resident_overview_helpers_test.dart`

**Interfaces:**
- Consumes: `dynamic raw` từ `overview['active_contract']['amenities']`, `Object? endDate`.
- Produces: `List<String> parseResidentAmenities(dynamic raw)`, `int? getResidentDaysRemaining(Object? endDate)`; map `kResidentAmenityLabels` (copy đúng `_AMENITY_LABELS` tại `OverviewTab.jsx:48-71`).

- [ ] **Step 1: Write failing tests**

```dart
test('parseResidentAmenities maps wifi key and JSON string', () {
  expect(parseResidentAmenities(['wifi', 'balcony']),
         ['Wi-Fi tốc độ cao', 'Ban công thoáng']);
  expect(parseResidentAmenities('["wifi","gym"]'),
         ['Wi-Fi tốc độ cao', 'Phòng Gym']);
});
test('parseResidentAmenities handles comma string and map', () {
  expect(parseResidentAmenities('wifi, gym'), ['Wi-Fi tốc độ cao', 'Phòng Gym']);
  expect(parseResidentAmenities({'wifi': true, 'gym': false}), ['Wi-Fi tốc độ cao']);
});
test('days remaining is null for null/invalid end date', () {
  expect(getResidentDaysRemaining(null), isNull);
  expect(getResidentDaysRemaining('not-a-date'), isNull);
});
```

- [ ] **Step 2: Run to verify fail** — `flutter test test/core/utils/resident_overview_helpers_test.dart` → FAIL "not defined".
- [ ] **Step 3: Implement** port logic từ `OverviewTab.jsx:73-118`; dùng `DateTime.tryParse`, so sánh theo ngày (bỏ giờ), `ceil` theo `Duration.millisecondsPerDay`. Map đúng 23 key `wifi..gym`.
- [ ] **Step 4: Run test** → PASS.
- [ ] **Step 5: Commit** `fix(resident): add amenity and days-remaining helpers`.

### Task 2: Overview KPI cards parity (diff #5–#9)

**Files:**
- Modify: `flutter_resihub/lib/features/resident/tabs/overview_tab.dart:522-578`, `:622-686`
- Test: `flutter_resihub/test/features/resident/resident_portal_test.dart` (thêm group)

**Interfaces:**
- Consumes: `widget.overview`, `widget.openRequestsCount`, `ref.watch(notificationProvider).unreadCount`, helper Task 1.
- Produces: `_buildKpiCard({required String title, required String value, required IconData icon, required Color color, required Color bgColor, required Widget footer, required VoidCallback onTap})`; 4 thẻ có key `Key('resident-kpi-card-N')`, footer có `Key('resident-kpi-footer')`.

- [ ] **Step 1: Write failing widget test**

```dart
testWidgets('Overview KPI cards match React titles and footers', (tester) async {
  await tester.binding.setSurfaceSize(const Size(1440, 900));
  // pump OverviewTab trong ProviderScope + MaterialApp, overview có:
  // rent_amount: 7300000, deposit_amount: 7300000, end_date: '2027-06-30',
  // latest_invoice: {'period':'2026-10'} ...
  expect(find.text('CẦN THANH TOÁN HIỆN TẠI'), findsOneWidget);
  expect(find.text('TIỀN THUÊ HÀNG THÁNG'), findsOneWidget);
  expect(find.text('TIỀN CỌC ĐANG GIỮ'), findsOneWidget);
  expect(find.text('THÔNG BÁO & YÊU CẦU MỞ'), findsOneWidget);
  expect(find.byKey(const Key('resident-kpi-footer')), findsNWidgets(4));
  expect(find.text('Không có dư nợ quá hạn'), findsOneWidget);
  expect(tester.takeException(), isNull);
});
```

- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** — thay `GridView.count` + `childAspectRatio` bằng `LayoutBuilder` + `Wrap` 4 thẻ (`width = (maxWidth - 36) / 4` khi ≥1200, `/2` khi ≥640, full width khi <640; `mainAxisSize.min`). Mỗi thẻ `Column(mainAxisSize: MainAxisSize.min)`, trên: title+icon, giữa: value, dưới: `Divider` + footer. Titles uppercase như React. Footer: thẻ1 `subtext + 'Hóa đơn'`, thẻ2 `'Chốt kỳ ngày N hàng tháng' + 'Hạn +N ngày'`, thẻ3 `'Đang bảo lưu theo HĐ' + 'Sổ cọc'`, thẻ4 `'N chưa đọc' + 'N báo hỏng mở'`. Thêm dòng "Tổng tất cả căn hộ" khi `total_amount_due_all != current_amount_due`.
- [ ] **Step 4: Run** → PASS; chụp lại `flutter-overview-desktop-1440.png`, so sánh với ảnh React.
- [ ] **Step 5: Commit** `fix(resident): align overview KPI cards with React`.

### Task 3: Overview hero parity (diff #14)

**Files:** Modify `overview_tab.dart:398-520`; Test `resident_portal_test.dart`.
**Interfaces:** Consumes helper Task 1, `widget.overview['user']['full_name']`; Produces hero có key `Key('resident-overview-hero')`.

- [ ] **Step 1: Failing test** assert `find.text('Xin chào, Trần Thanh Nam')`, `find.text('TIỆN NGHI BÀN GIAO CĂN HỘ')`, `find.text('Wi-Fi tốc độ cao')`, `find.text('Diện tích')`, `find.text('Loại phòng')`, `find.text('Thời hạn HĐ')`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** — giữ gradient, thêm: badge "Căn hộ đang cư trú" (hoặc "Hợp đồng sắp hiệu lực (ngày)" khi `is_future_contract`), `StatusBadge`, badge "Còn N ngày hết hạn HĐ" khi `0 <= N <= 30`; lời chào + `Căn hộ {code} • {floor_name}`; chip amenities từ `parseResidentAmenities`; ô thông số phải: `area_m2`, `apartment_type ?? (bedrooms != null ? '$bedrooms Phòng ngủ' : 'Tiêu chuẩn')`, `start_date → end_date`. Dùng `Wrap`/`Row` co được, không `overflow`.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `fix(resident): enrich overview hero card`.

### Task 4: Overview quick actions + invoice/support cards (diff #10–#13)

**Files:** Modify `overview_tab.dart:581-615`; Test `resident_portal_test.dart`.
**Interfaces:** Consumes `latestInvoice`, `overview['manager_contact']`; Produces `Key('resident-quick-actions')`, `Key('resident-latest-invoice-card')`, `Key('resident-manager-support-card')`.

- [ ] **Step 1: Failing test** assert tiêu đề `"Thao tác nhanh"`, subtitle `"Các tiện ích thường dùng dành cho cư dân căn hộ"`, 4 nhãn `"Báo đã thanh toán"`, `"Gửi yêu cầu sửa chữa"`, `"Đăng ký dịch vụ"`, `"Xem hợp đồng"` + 4 subtitle tương ứng; assert `"Hóa đơn kỳ gần nhất"`, `"Ban Quản Lý hỗ trợ"`, `"Tất cả hóa đơn"`, `"Xem đầy đủ danh bạ BQL"`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** — thay 5 chip bằng `Wrap` 4 card (icon 40px, title 14px, subtitle 12px), navigate `invoices` / `maintenance` / `services` / `contract`. Thêm 2 card dưới: grid 2:1; thẻ hóa đơn dùng `latest_invoice` (mã, badge `Kỳ {period}`, `StatusBadge`, `Hạn thanh toán`, `Đã trả`, `Tổng hóa đơn`, nút "Thanh toán" khi còn nợ); thẻ support dùng `manager_contact`.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `fix(resident): add quick actions and invoice/support cards`.

### Task 5: Overview no-contract & reservation richness (diff #15–#19)

**Files:** Modify `overview_tab.dart:38-163`, `:293-396`; Test `resident_portal_test.dart`.
**Interfaces:** Consumes `overview['reservations']`, `overview['onboarding_application']`; Produces `Key('resident-onboarding-status-card')`, `Key('resident-reservation-detail-modal')`.

- [ ] **Step 1: Failing test** — pump overview không có `active_contract` nhưng có `reservations` + `onboarding_application` với `status = PENDING`: assert không có KPI (`find.byKey(Key('resident-kpi-footer')) findsNothing`), có "Đăng ký thông tin nhận nhà", card trạng thái hồ sơ, nút "Cập nhật STK nhận hoàn".
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** — khi `contract == null`: ẩn KPI/quick actions/hero, render welcome + form đăng ký (chọn căn, ngày sinh, ảnh CCCD 2 mặt, consent) + lịch sử giữ chỗ + căn trống; thêm card trạng thái PENDING/APPROVED/REJECTED kèm lý do; thêm modal chi tiết giữ chỗ. Giữ modal bank hiện tại.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `fix(resident): complete no-contract onboarding flow`.

### Task 6: Shell responsive parity (diff #1–#4)

**Files:** Modify `flutter_resihub/lib/shared/widgets/layout/resident_shell.dart:548-625`, `:391-414`, `:518-545`, `:453`; Test `flutter_resihub/test/shared/widgets/layout_shell_test.dart`.
**Interfaces:** Consumes `kResidentPortalTabs`, `widget.badgeCounts`; Produces `Key('resident-mobile-tab-strip')`.

- [ ] **Step 1: Failing tests**

```dart
testWidgets('mobile width shows tab strip and bottom nav', (tester) async {
  await tester.binding.setSurfaceSize(const Size(390, 844));
  // pump ResidentShell
  expect(find.byKey(const Key('resident-mobile-tab-strip')), findsOneWidget);
  expect(find.byKey(const Key('resident-bottom-nav')), findsOneWidget);
});
testWidgets('tablet width shows strip only, desktop shows sidebar', (tester) async {
  await tester.binding.setSurfaceSize(const Size(800, 900));
  expect(find.byKey(const Key('resident-mobile-tab-strip')), findsOneWidget);
  expect(find.byKey(const Key('resident-bottom-nav')), findsNothing);
  await tester.binding.setSurfaceSize(const Size(1440, 900));
  expect(find.byKey(const Key('resident-mobile-tab-strip')), findsNothing);
});
```

- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** — tách điều kiện: strip khi `width < 1024` (dùng widget strip hiện tại, bỏ `if isTablet`); bottom nav giữ `<768`; sidebar giữ `>=1024`. Chuyển breakpoint contract switcher/header profile từ `!isMobile (768)` sang `>=640` (`isCompactUp = width >= 640`), row switcher mobile chỉ khi `<640`. Bỏ badge maintenance của Flutter (`resident_portal_page.dart:353-355`) để khớp React.
- [ ] **Step 4: Run** → PASS, kiểm tra lại không có `RenderFlex overflow` ở 390px (`tester.takeException()`).
- [ ] **Step 5: Commit** `fix(resident): align shell breakpoints with React`.

### Task 7: Notifications tab parity (diff #21–#27)

**Files:** Modify `overview`→ `flutter_resihub/lib/features/resident/tabs/notifications_tab.dart:80-291`; Test mới `test/features/resident/notifications_tab_test.dart`.
**Interfaces:** Consumes `notificationProvider`; Produces `_buildNotificationItem` nhận `type`, `sender`, `actionUrl`.

- [ ] **Step 1: Failing test** assert tiêu đề `"Hộp thư Thông báo Cư dân"`, chip lọc, nút `"Đánh dấu đọc tất cả (30)"`, item có badge类型 + text `"Nhấn để xử lý ngay"`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** — thêm AppCard header; map `n['type']` → icon/màu/nhãn theo `NotificationsTab.jsx:29-163`; thêm sender + CTA dạng "Thanh toán"/"Xem chi tiết"; thời gian tương đối (`formatRelativeTime` mới trong helper Task 1 hoặc inline); skeleton `AppSkeleton` khi loading; 2 empty variant; modal dùng `NotificationDetailModal` có nút điều hướng.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `fix(resident): align notifications tab`.

### Task 8: Contact tab parity (diff #28–#31)

**Files:** Modify `flutter_resihub/lib/features/resident/tabs/contact_tab.dart:98-293`; Test mới `test/features/resident/contact_tab_test.dart`.
**Interfaces:** Consumes `overview['manager_contact']`, `overview['contact_config']`.

- [ ] **Step 1: Failing test** — assert 4 tiêu đề `"Hotline Kỹ thuật Tòa nhà"`, `"Đội Bảo vệ"`, `"Đường dây Khẩn cấp (SOS/PCCC)"`, `"Hòm thư tiếp nhận ý kiến"`; assert `"113"`, `"114"`, `"115"`, `"Mở mục Báo hỏng →"`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** — đổi list thành `Wrap` 4 card (badge/icon/copy/nút "Gọi ngay"); đổi nhãn theo React; thêm khối số 113/114/115 + nút chuyển tab maintenance; hero thêm badge "Quản lý tòa nhà phụ trách trực tiếp", địa chỉ, giờ làm việc.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `fix(resident): align contact tab`.

### Task 9: Profile tab parity (diff #32–#37)

**Files:** Modify `flutter_resihub/lib/features/resident/tabs/profile_tab.dart:177-300`; Test `resident_portal_test.dart` (group ProfileTab hiện có).
**Interfaces:** Consumes `authProvider.user`, `overview['user']`.

- [ ] **Step 1: Failing test** — assert `"Ngày sinh"`, `"Quốc tịch"`, `"Ảnh đại diện"`, `"Chuẩn bảo mật: thông tin của bạn chỉ dùng để lập hợp đồng"`; assert có 3 `IconButton` toggle `Icons.visibility`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** — đổi `SingleChildScrollView > Column` thành `Wrap` 2 cột (8/12 + 4/12) trên ≥1024; thêm field ngày sinh, quốc tịch, upload avatar, dòng consent; thêm `bool _obscurePwd = true` ×3 + `IconButton` toggle; đổi min length 6→8 và message; thẻ CCCD thêm preview + trạng thái lưu.
- [ ] **Step 4: Run** → PASS (test hiện có "ProfileTab mounts and disposes cleanly" vẫn pass).
- [ ] **Step 5: Commit** `fix(resident): align profile tab`.

### Task 10: Invoices tab parity (diff #38–#44)

**Files:** Modify `flutter_resihub/lib/features/resident/tabs/invoices_tab.dart:249-348`, `:1054-1069`, `:1113-1349`; Test `test/features/invoices/invoices_resident_parity_test.dart`.
**Interfaces:** Consumes `resolveResidentInvoiceTotalsSummary`, `residentServiceProvider`.

- [ ] **Step 1: Failing test** — assert filter `"Tất cả hóa đơn"`, `"Chờ thanh toán"`, `"Đã hoàn tất"`; mở modal báo thanh toán assert `"Mã hóa đơn"`, `"Phương thức"`, `"Mã tham chiếu"`, `"Ngày thanh toán"`, `"Ảnh chứng từ"`; assert HĐ `OVERDUE` có `BoxShadow/Border` rose.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** — đổi nhãn filter; thêm CTA "Báo đã thanh toán" ở summary; mở rộng modal (chọn HĐ, `MoneyInput`, method, ref code, date, `FileUploadField multiple` tối đa 3); thêm highlight quá hạn; giữ nút VietQR + lịch sử tín dụng (Flutter-only).
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `fix(resident): align invoices tab`.

### Task 11: Contract tab parity (diff #45–#51)

**Files:** Modify `flutter_resihub/lib/features/resident/tabs/contract_tab.dart:449-859`, `:320-421`; Test mới `test/features/resident/contract_tab_test.dart`.
**Interfaces:** Consumes `overview['active_contract']`, `contractsServiceProvider`.

- [ ] **Step 1: Failing test** — assert `"Tiến trình hợp đồng"`, `"Ngày chốt kỳ"`, `"Số ngày gia hạn thanh toán"`, `"Xin gia hạn"`, `"Xin chấm dứt"`, `"Phụ lục điều chỉnh hợp đồng"`, `"Chuỗi lịch sử hợp đồng"`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** — thêm timeline widget, bổ sung 2 chỉ số (`billing_day`, `payment_due_days`) + ghi chú HĐ, 2 CTA mở modal tương ứng; thêm 2 section phụ lục/lịch sử; chi tiết cọc thêm khoản trừ + chứng cứ + luồng tranh chấp; occupants đổi sang grid có phone/email/status; empty state thêm nút "Xem căn hộ trống"; A4 modal thêm "Tải bản HTML".
- [ ] **Step 4: Run** → PASS (test cũ "ContractTab A4 preview & 7-day dispute window" vẫn pass).
- [ ] **Step 5: Commit** `fix(resident): align contract tab`.

### Task 12: Maintenance (resident) parity (diff #52–#57)

**Files:** Modify `flutter_resihub/lib/features/resident/tabs/maintenance_tab.dart:95-230`, `:451-623`; Test mới `test/features/resident/maintenance_tab_test.dart`.
**Interfaces:** Consumes `residentServiceProvider`, `formatDateTime`.

- [ ] **Step 1: Failing test** — assert 3 filter chip `"Tất cả"`, `"Đang xử lý"`, `"Đã hoàn tất"`; thẻ có `"Mã tra cứu"`, `"Khung giờ"`, `"SLA"`; form có `"Vị trí sự cố"`, `"Khung giờ thuận tiện"`; assert modal `"Trùng lặp yêu cầu"` khi API trả 409 code `DUPLICATE_SERVICE_REQUEST`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** — thêm filter tabs; thêm 8 categories/4 priorities + vị trí + khung giờ + tối đa 3 ảnh; thẻ hiển thị tracking code (copy), badge, vị trí/khung giờ, SLA, kỹ thuật viên, ảnh; thêm detail modal + lightbox; modal trùng lặp có nút mở phiếu cũ; dùng `sla_config.reopen_window_days` (fallback 3).
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `fix(resident): align maintenance tab`.

---

## Phase B — Admin & shared

### Task 13: Dashboard → Deposits drill-down (diff #3 — high)

**Files:** Modify `flutter_resihub/lib/features/deposits/screens/deposits_page.dart:25-31`, `:106-137`, `:204-208`; Test `test/features/deposits/deposits_page_test.dart` (tạo nếu chưa có).
**Interfaces:** Consumes `GoRouterState.of(context).uri.queryParameters`; Produces `_quickFilter` enum `{none, payout, overdue, disputed}`.

- [ ] **Step 1: Failing test** — pump `DepositsPage` với query `?overdue=1`: assert banner `"Đang áp dụng bộ lọc nhanh từ Dashboard"` + nút `"Xóa bộ lọc nhanh"` + chỉ row quá hạn. Lặp `?tab=payout` và `?status=DISPUTED`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** — đọc 3 param trong `didChangeDependencies`, map sang `_quickFilter`, thêm tab `payout`, lọc danh sách, thêm banner + nút clear (xóa param bằng `context.go('/admin/deposits')`).
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `fix(admin): wire dashboard drill-downs into deposits`.

### Task 14: Deposits KPI & tabs copy (diff #14, #23)

**Files:** Modify `deposits_page.dart:204-208`, `:219-237`, `:243-281`, `:304`; Test `test/features/deposits/deposits_page_test.dart`.
**Interfaces:** Consumes Task 13 `_quickFilter`.

- [ ] **Step 1: Failing test** — assert 4 KPI `"Tổng tiền cọc đang giữ"`, `"Chờ duyệt & Chi hoàn"`, `"Đã hoàn & Tất toán"`, `"Hồ sơ tranh chấp"`; mỗi KPI có subtext + `onTap` set filter; assert tab `"Đang giữ cọc"`, `"Chờ duyệt / Chi hoàn"`, `"Hoàn trả lệnh chi"`, `"Đã hoàn / Tất toán"`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** — đổi nhãn, màu KPI về sky, thêm subtext + click drill-down, đổi tiêu đề `"Quản lý Tiền đặt cọc & Tất toán"` + nút `"Xuất Excel (RP-07)"`, `"Làm mới dữ liệu"`.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `fix(admin): align deposits KPIs and tabs`.

### Task 15: Admin maintenance page parity (diff admin #1, #2, #7–#22)

**Files:** Modify `flutter_resihub/lib/features/maintenance/screens/service_requests_page.dart` (nhiều đoạn theo báo cáo); Test `test/features/maintenance/service_requests_parity_test.dart`.
**Interfaces:** Consumes `serviceRequestsServiceProvider`.

- [ ] **Step 1: Failing test** — assert KPI `"Tổng yêu cầu"`, `"Mới / Mở lại"`, `"Đang xử lý / Hẹn lại"`, `"Đã hoàn thành"`; cột `"Phụ trách"`, `"Đánh giá"`; form tạo có `"Ảnh hiện trạng (tối đa 3 ảnh)"`; nút `"Bảng Kanban"` / `"Chế độ Bảng"` có chữ; lightbox `"Xem ảnh đính kèm"`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** — đổi bộ KPI, thêm 2 cột, thêm upload ảnh + payload `images[]`, đổi tiêu đề/phụ đề, nút toggle có nhãn, thêm thông tin SLA/thời gian phản hồi/lý do mở lại/hủy vào drawer, map `AUDIT_ACTION_LABELS`, thêm lightbox, debounce search 200ms + nút "Xóa bộ lọc", link nhóm Zalo + preview, modal duplicate có "Mở phiếu #{tracking_code}". Giữ flag API đúng theo backend (xác minh trước khi commit — item "uncertain" trong audit).
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `fix(admin): align service requests page`.

### Task 16: Settings missing inputs (diff admin #4–#6)

**Files:** Modify `flutter_resihub/lib/features/ai_gateway/screens/settings_page.dart:609-664`, `:691-717`, `:744-770`; Test `test/features/ai_gateway/settings_page_test.dart` (tạo nếu chưa có).
**Interfaces:** Consumes `settingsServiceProvider` (hoặc provider hiện có).

- [ ] **Step 1: Failing test** — assert 4 label `"Ngưỡng cảnh báo chỉ số (%)"`, `"Mốc ngày nhắc nợ (dấu phẩy)"`, `"Số ngày cho phép cư dân mở lại yêu cầu sau khi hoàn tất (ngày)"`, `"Số điện thoại khẩn cấp / PCCC"`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** — thêm 4 `AppInput` vào đúng card, bind vào payload settings hiện có, null-safe.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `fix(admin): add missing settings fields`.

### Task 17: Copy/color/format fixes (diff admin #24–#28)

**Files:** Modify `dashboard_page.dart:385-386,427-428`; `payments_page.dart:64,630`; `meter_batch_photo_import_modal.dart` (chỉ đoạn badge — **giữ nguyên phần đã sửa của người dùng**); `core/utils/format.dart:103-108`; Test `test/core/utils/utils_test.dart`.
**Interfaces:** Consumes `format.dart`.

- [ ] **Step 1: Failing test** — `expect(formatCurrentPeriod(DateTime(2026,11,17,1,0)), '2026-11')` với giờ máy giả định UTC (React dùng GMT+7); assert badge OCR `"Đã lập HĐ"`, `"Chưa có số mới"`, `"Sẵn sàng lưu"`; assert CSV header `"Nhóm tuổi nợ (AC-016.1)"`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** — `getCurrentPeriod()` convert sang `Asia/Ho_Chi_Minh` (`DateTime.now().toUtc().add(Duration(hours:7))`); đổi 3 badge + header + màu bucket 31–60 sang orange; bổ sung "(PRD 15.1 & 15.3)", "(RP-01)" vào subtitle.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `fix(admin): align copy, badge colors and period timezone`.

### Task 18: Cập nhật báo cáo audit & screenshot sau khi xong

**Files:** Modify `docs/flutter-ui-audit-report.md` (sửa tuyên bố "100% 1-1"), `docs/flutter-react-ui-diff-report.md` (đánh dấu already-fixed), thay ảnh trong `docs/ui-diff-screenshots/`.
**Interfaces:** Consumes kết quả Task 1–17.

- [ ] **Step 1: Chạy full suite** `cd flutter_resihub; flutter test` → expect all PASS (baseline 562 tests).
- [ ] **Step 2: Chụp lại** 4 ảnh tại 1440×900 / 390×844 bằng DevTools như bước audit, so sánh trực quan.
- [ ] **Step 3: Sửa docs** — thay "100%" bằng số điểm đã fix + danh sách còn lại (nếu có).
- [ ] **Step 4: Commit** `docs: update UI parity report after fixes`.

---

## Self-review notes

- Spec coverage: 93/93 điểm được gán vào Task 1–17; Task 18 cập nhật tài liệu. Không điểm nào bị bỏ.
- Các task Phụ lục A5/B15 là phần lớn nhất — nếu reviewer thấy quá tải, tách tiếp thành 2 task nhỏ hơn trước khi thực thi (onboarding vs reservation; KPI/columns vs modal/lightbox).
- Không task nào thêm dependency hay tạo abstraction dùng 1 lần.
- Review Focus đã gắn test cụ thể cho 7 input class; đặc biệt Task 6 kèm assert `RenderFlex overflow` từng xuất hiện lúc devtools khởi tạo viewport nhỏ.
