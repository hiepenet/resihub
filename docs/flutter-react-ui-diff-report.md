# Báo cáo khác biệt giao diện: ReactJS vs Flutter (ResiHub v2.0)

> Ngày audit: 17/11/2026  
> Phạm vi: toàn bộ source code 2 client + chạy thực tế cả 2 app trên Chrome DevTools  
> Cập nhật trạng thái sau parity: 17/11/2026 (sau 17 commit `4186de9..f990a92`)  
> Kết luận ngắn: **số lượng màn hình khớp 27/27 + 8 tab, nhưng giao diện, nhãn và dữ liệu hiển thị KHÔNG khớp 1-1.** Báo cáo cũ `docs/flutter-ui-audit-report.md` (16/11/2026) khẳng định "100% UI/Labels/Data" — **không đúng**. Sau đợt parity: **67/93 điểm đã sửa, 3 điểm giữ nguyên theo quyết định (tính năng chỉ có ở Flutter), 23 điểm vẫn còn mở** (15 điểm Overview cổng cư dân + 8 điểm Dịch vụ). Không đạt 100%.

> **Cách đọc cột "Trạng thái sau parity":**
> - `✅ Đã sửa — Task N, <commit>`: code đã thay đổi và có test, theo ledger `.superpowers/sdd/2026-11-17-flutter-react-ui-parity/progress.md`.
> - `➖ Giữ nguyên (Flutter-only)`: khác biệt có chủ đích — Flutter có thêm tính năng hữu ích, theo quyết định "React là nguồn sự thật nhưng giữ tính năng Flutter hữu ích" (VietQR, lịch sử tín dụng, pull-to-refresh).
> - `❌ Còn mở — <lý do>`: chưa có thay đổi tương ứng trên branch này.

---

## 1. Cách audit

- **Chạy thật**: React Vite dev server `http://localhost:3000`; Flutter web `flutter run -d web-server --web-port 8080 --dart-define=API_BASE_URL=http://localhost:3000`. Cùng tài khoản `tenant1@resihub.vn / Demo@123456`, cùng viewport `1440×900` và `390×844`.
- **DevTools**: Emulation viewport, Accessibility tree, Console, Network. Chụp full-page đối chiếu.
- **Source**: đọc và đối chiếu từng file React (`frontend/src/**`) với file Flutter tương ứng (`flutter_resihub/lib/**`). Mọi điểm khác biệt đều có `file:line` ở cả 2 bên.
- Ảnh chụp lưu tại `docs/ui-diff-screenshots/`:
  - `react-overview-desktop-1440.png` / `flutter-overview-desktop-1440.png`
  - `react-overview-mobile-390.png` / `flutter-overview-mobile-390.png`
  - ⚠️ Các ảnh này vẫn là ảnh **trước parity**. Không được tự động tạo lại trong Task 18 (ruling: controller chịu trách nhiệm chụp lại làm bước verification). Xem mục 5.

### Nhận xét tại thời điểm chạy thực tế

| Quan sát | React | Flutter | Sau parity |
|---|---|---|---|
| Hero tổng quan | Gradient + lời chào, badge "Căn hộ đang cư trú", 5 chip tiện nghi, ô thông số Diện tích / Loại phòng / Thời hạn HĐ | Gradient, mã căn + tòa nhà, badge trạng thái, 2 dòng "Hạn HĐ / Tiền thuê" | **Không đổi** — Tasks 3/4/5 không landing, `overview_tab.dart` không bị đụng vào |
| 4 thẻ KPI | Tiêu đề 2 dòng, số lớn, **footer có gạch ngang + subtext + link** ("Hóa đơn →", "Sổ cọc →"), cao ~170px | Tiêu đề + icon ở trên, giá trị ở dưới (`spaceBetween`), **không footer**, khoảng giữa trống (~100px) | **Không đổi** — Task 2 không landing; `childAspectRatio: 1.4/1.3` vẫn còn ở `overview_tab.dart:532` |
| 4 thẻ KPI (mobile) | 2 cột, vẫn có footer | 2 cột, vẫn trống lớn; mã hóa đơn dài bị cắt | **Không đổi** |
| Lối tắt | 4 card lớn có icon + tiêu đề + mô tả ("Báo đã thanh toán", "Gửi yêu cầu sửa chữa"...) | 5 chip nhỏ ("Báo hỏng / Sự cố", "Thanh toán hóa đơn"...) | **Không đổi** — vẫn là "Lối tắt thao tác nhanh" ở `overview_tab.dart:583` |
| Phần dưới | Card "Hóa đơn kỳ gần nhất" + "Ban Quản Lý hỗ trợ" | **Không có** | **Không đổi** |
| Mobile | Có horizontal tab strip + bottom nav | Chỉ bottom nav ("Thêm" gộp 4 tab phụ) | Đã xử lý bởi Task 6 (`7f1152e`) — xem #1–#4 |
| Console | Không lỗi | 1 lần `RenderFlex overflow` tại `resident_shell.dart:748` trong lúc viewport khởi tạo rất nhỏ; reload sạch ở 1440 và 390 → **không còn lỗi** | Task 6 có test overflow ở 390px; full suite `flutter test` khi viết báo cáo này: **607 passed, 0 failed** |

Tổng: **93 điểm khác biệt được ghi nhận** (65 resident + 28 admin). Dưới đây là bảng chi tiết đã gắn trạng thái sau parity.

---

## 2. Cổng cư dân — 65 điểm khác biệt

| # | Khu vực | React (`file:line`) | Flutter (`file:line`) | Khác biệt | Mức | Trạng thái sau parity |
|---|---|---|---|---|---|---|
| 1 | Shell – tab strip mobile | `ResidentLayout.jsx:198-240` | `resident_shell.dart:548-625` | React hiện horizontal tab strip ở <768px; Flutter chỉ có bottom nav | cao | ✅ Đã sửa — Task 6, `7f1152e` |
| 2 | Shell – breakpoint switcher | `ResidentLayout.jsx:127-139,182-195` | `resident_shell.dart:391-414,518-545` | 640–767px: React inline trong header, Flutter thành row riêng | tb | ✅ Đã sửa — Task 6, `7f1152e` |
| 3 | Shell – badge nav | `ResidentLayout.jsx:228-236,265-273` | `resident_portal_page.dart:353-355`, `resident_shell.dart:564-566` | Flutter badge tab "Báo hỏng" bằng số yêu cầu mở; React không | tb | ✅ Đã sửa — Task 6, `7f1152e` |
| 4 | Shell – nút profile | `ResidentLayout.jsx:160` | `resident_shell.dart:453` | Ẩn dưới 640px (React) vs dưới 768px (Flutter) | thấp | ✅ Đã sửa — Task 6, `7f1152e` |
| 5 | Overview – tiêu đề KPI | `OverviewTab.jsx:1274,1323,1350,1384` | `overview_tab.dart:536,546,558,568` | Bộ KPI hoàn toàn khác (xem bảng trên) | cao | ❌ Còn mở — Task 2 được giao nhưng **không có commit**; `overview_tab.dart` không đổi |
| 6 | Overview – lưới KPI | `OverviewTab.jsx:1261` | `overview_tab.dart:523-532` | CSS grid `sm:grid-cols-2 xl:grid-cols-4` vs `GridView.count` + `childAspectRatio` cứng 1.4/1.3 | cao | ❌ Còn mở — Task 2 không landing (`:532` vẫn `childAspectRatio: 1.4/1.3`) |
| 7 | Overview – footer KPI | `OverviewTab.jsx:1301-1315,1337-1342,1364-1376,1395-1410` | `overview_tab.dart:640-682` | React có footer subtext + link; Flutter không → thẻ trống | cao | ❌ Còn mở — Task 2 không landing |
| 8 | Overview – icon KPI | `OverviewTab.jsx:1326,1353,1387` | `overview_tab.dart:550,560,570` | Wallet/ShieldCheck vs FileText/Wrench | cao | ❌ Còn mở — Task 2 không landing |
| 9 | Overview – tổng đa hợp đồng | `OverviewTab.jsx:1294-1298` | `overview_tab.dart:534-542` | Thiếu dòng "Tổng tất cả căn hộ" | tb | ❌ Còn mở — Task 2 không landing |
| 10 | Overview – thao tác nhanh | `OverviewTab.jsx:1414-1477` | `overview_tab.dart:581-615` | "Thao tác nhanh" 4 card có mô tả vs "Lối tắt thao tác nhanh" 5 chip | cao | ❌ Còn mở — Task 4 không có commit |
| 11 | Overview – CTA mobile | `OverviewTab.jsx:1240-1258` | — | Thiếu hàng nút mobile `sm:hidden` | tb | ❌ Còn mở — Task 4 không landing |
| 12 | Overview – hóa đơn/support | `OverviewTab.jsx:1479-1570` | — | Thiếu hoàn toàn 2 card cuối | cao | ❌ Còn mở — Task 4 không landing |
| 13 | Overview – banner tín dụng | `OverviewTab.jsx:1215-1238` | — | Thiếu banner "Xem hóa đơn" | tb | ❌ Còn mở — Task 4 không landing |
| 14 | Overview – hero | `OverviewTab.jsx:1089-1205` | `overview_tab.dart:398-520` | Thiếu lời chào, tiện nghi, ô thông số, cảnh báo hạn HĐ, tầng/địa chỉ | cao | ❌ Còn mở — Task 3 không có commit |
| 15 | Overview – trạng thái hồ sơ | `OverviewTab.jsx:462-582` | — | Thiếu card REJECTED/APPROVED/PENDING | cao | ❌ Còn mở — Task 5 không có commit |
| 16 | Overview – khi chưa có HĐ | `OverviewTab.jsx:1583-1830` | `overview_tab.dart:293-396,522-615` | React có welcome + form + lịch sử + căn trống; Flutter vẫn hiện KPI | cao | ❌ Còn mở — Task 5 không landing |
| 17 | Overview – thẻ giữ chỗ | `OverviewTab.jsx:903-1079` | `overview_tab.dart:293-396` | Nhiều ô dữ liệu hơn; khác nhãn ("Đăng ký thông tin nhận nhà" vs "Nộp hồ sơ thuê") | cao | ❌ Còn mở — Task 5 không landing |
| 18 | Overview – form nộp hồ sơ | `OverviewTab.jsx:311-459` | `overview_tab.dart:62-163` | React: chọn căn, ngày sinh, ảnh CCCD 2 mặt, consent; Flutter: phone/address/job/liên hệ khẩn cấp | cao | ❌ Còn mở — Task 5 không landing |
| 19 | Overview – modal chi tiết giữ chỗ | `OverviewTab.jsx:702-828` | — | Thiếu | tb | ❌ Còn mở — Task 5 không landing |
| 20 | Overview – pull-to-refresh | — | `overview_tab.dart:285-287` | Chỉ Flutter có | thấp | ➖ Giữ nguyên (Flutter-only) — tính năng hữu ích, không phải lỗi |
| 21 | Thông báo – tiêu đề | `NotificationsTab.jsx:194-197` | `notifications_tab.dart:99-120` | Flutter thiếu "Hộp thư Thông báo Cư dân" + subtitle | tb | ✅ Đã sửa — Task 7, `20d3f57` |
| 22 | Thông báo – nội dung item | `NotificationsTab.jsx:29-163,247-333` | `notifications_tab.dart:150-235` | Flutter không phân loại theo type, không badge/nhãn người gửi/CTA | cao | ✅ Đã sửa — Task 7, `20d3f57` |
| 23 | Thông báo – thời gian | `NotificationsTab.jsx:292-317` | `notifications_tab.dart:221-227` | Tương đối vs tuyệt đối; thiếu gợi ý "Nhấn để xử lý ngay" | tb | ✅ Đã sửa — Task 7, `20d3f57` (minor: test thời gian tương đối có thể flake qua nửa đêm) |
| 24 | Thông báo – skeleton | `NotificationsTab.jsx:225-230` | — | Thiếu | tb | ✅ Đã sửa — Task 7, `20d3f57` (minor: gate theo `filtered.isEmpty`) |
| 25 | Thông báo – empty state | `NotificationsTab.jsx:231-244` | `notifications_tab.dart:122-148` | 2 variant vs 1 | tb | ✅ Đã sửa — Task 7, `20d3f57` |
| 26 | Thông báo – modal | `NotificationsTab.jsx:340` | `notifications_tab.dart:49-77` | React có nút điều hướng sâu | tb | ✅ Đã sửa — Task 7, `20d3f57` |
| 27 | Thông báo – nút đọc all | `NotificationsTab.jsx:208` | `notifications_tab.dart:111` | "Đánh dấu đọc tất cả (N)" vs "Đọc tất cả" | thấp | ✅ Đã sửa — Task 7, `20d3f57` |
| 28 | Liên hệ – hotline | `ContactTab.jsx:135-372` | `contact_tab.dart:205-255` | Grid 4 card có badge + nút vs 1 cột danh sách | cao | ✅ Đã sửa — Task 8, `51a90e8` + fix `f2a97ad` |
| 29 | Liên hệ – nhãn | `ContactTab.jsx:146,209,267,326` | `contact_tab.dart:214,223,232,241` | Nhiều nhãn khác nhau | tb | ✅ Đã sửa — Task 8, `51a90e8`/`f2a97ad` |
| 30 | Liên hệ – số 113/114/115 | `ContactTab.jsx:310-313` | — | Thiếu | tb | ✅ Đã sửa — Task 8, `51a90e8`/`f2a97ad` |
| 31 | Liên hệ – hero | `ContactTab.jsx:83-133` | `contact_tab.dart:99-202` | Khác badge, thiếu địa chỉ/giờ làm việc trong hero | tb | ✅ Đã sửa — Task 8, `51a90e8`/`f2a97ad` |
| 32 | Hồ sơ – bố cục | `ProfileTab.jsx:197-199,393-395` | `profile_tab.dart:184-295` | 2 cột (8/12 + 4/12) vs 3 card xếp dọc | cao | ✅ Đã sửa — Task 9, `440a024` |
| 33 | Hồ sơ – trường | `ProfileTab.jsx:234-321` | `profile_tab.dart:193-219` | Thiếu ngày sinh, quốc tịch, avatar, dòng consent | cao | ✅ Đã sửa — Task 9, `440a024` |
| 34 | Hồ sơ – upload avatar | `ProfileTab.jsx:207-232` | — | Thiếu | cao | ✅ Đã sửa — Task 9, `440a024` |
| 35 | Hồ sơ – hiện/ẩn mật khẩu | `ProfileTab.jsx:416-459` | `profile_tab.dart:264-280` | Thiếu Eye/EyeOff | tb | ✅ Đã sửa — Task 9, `440a024` |
| 36 | Hồ sơ – độ dài mật khẩu | `ProfileTab.jsx:150` | `profile_tab.dart:154` | 8 vs 6 ký tự | thấp | ✅ Đã sửa — Task 9, `440a024` |
| 37 | Hồ sơ – ảnh CCCD | `ProfileTab.jsx:340-389` | `profile_tab.dart:236-255` | Thiếu preview + trạng thái lưu trữ | tb | ✅ Đã sửa — Task 9, `440a024` |
| 38 | Hóa đơn – nút VietQR | `InvoicesTab.jsx:534-609` | `invoices_tab.dart:928-938` | Chỉ Flutter có nút + modal QR | tb | ➖ Giữ nguyên (Flutter-only) — plan loại trừ rõ ràng |
| 39 | Hóa đơn – lịch sử tín dụng | `InvoicesTab.jsx:462-477` | `invoices_tab.dart:943-1052` | Chỉ Flutter có danh sách hiển thị | tb | ➖ Giữ nguyên (Flutter-only) — plan loại trừ rõ ràng |
| 40 | Hóa đơn – thẻ hóa đơn | `InvoicesTab.jsx:662-1013` | `invoices_tab.dart:1113-1349` | React thu gọn được, có icon dòng, công thức, ảnh công tơ, lịch sử thanh toán | cao | ✅ Đã sửa — Task 10, `32224dc` (phạm vi: filter/CTA/modal/highlight quá hạn; giữ VietQR + lịch sử tín dụng) |
| 41 | Hóa đơn – nhãn filter | `InvoicesTab.jsx:618-626` | `invoices_tab.dart:1064-1069` | Viết tắt "Chờ TT", "Đã TT" | tb | ✅ Đã sửa — Task 10, `32224dc` |
| 42 | Hóa đơn – CTA trên cùng | `InvoicesTab.jsx:493-501` | `invoices_tab.dart:641-779` | Thiếu "Báo đã thanh toán" ở summary | tb | ✅ Đã sửa — Task 10, `32224dc` |
| 43 | Hóa đơn – modal báo thanh toán | `InvoicesTab.jsx:1039-1110` | `invoices_tab.dart:269-289` | Thiếu chọn HĐ, phương thức, mã tham chiếu, ngày, tối đa 3 ảnh | cao | ✅ Đã sửa — Task 10, `32224dc` |
| 44 | Hóa đơn – highlight quá hạn | `InvoicesTab.jsx:665-668` | `invoices_tab.dart:1113-1126` | Flutter không tô viền đỏ HĐ quá hạn | tb | ✅ Đã sửa — Task 10, `32224dc` |
| 45 | Hợp đồng – thẻ tổng | `ContractTab.jsx:708-897` | `contract_tab.dart:506-588` | Thiếu timeline, 6 thông số, CTA gia hạn/chấm dứt | cao | ✅ Đã sửa — Task 11, `dd8cdad` + fix `19c567a` |
| 46 | Hợp đồng – lịch sử/phụ lục | `ContractTab.jsx:1390-1577` | — | Thiếu 2 mục | cao | ✅ Đã sửa — Task 11, `dd8cdad`/`19c567a` |
| 47 | Hợp đồng – quyết toán cọc | `ContractTab.jsx:961-1262` | `contract_tab.dart:670-812` | Thiếu chi tiết các khoản trừ, chứng cứ, tranh chấp | cao | ✅ Đã sửa — Task 11, `dd8cdad`/`19c567a` |
| 48 | Hợp đồng – thành viên | `ContractTab.jsx:865-896` | `contract_tab.dart:591-667` | Grid điện thoại/email/trạng thái vs danh sách CCCD bị che | tb | ✅ Đã sửa — Task 11, `dd8cdad`/`19c567a` |
| 49 | Hợp đồng – empty state | `ContractTab.jsx:693-705` | `contract_tab.dart:457-484` | Khác chữ, React có "Xem căn hộ trống" | tb | ✅ Đã sửa — Task 11, `dd8cdad`/`19c567a` |
| 50 | Hợp đồng – in A4 | `ContractTab.jsx:1731-1777` | `contract_tab.dart:98-120` | React có tải HTML + In/PDF | tb | ✅ Đã sửa — Task 11, `dd8cdad`/`19c567a` |
| 51 | Hợp đồng – modal yêu cầu | `ContractTab.jsx:1779-1878` | `contract_tab.dart:320-421` | Khác loại yêu cầu, React có ngày mong muốn | tb | ✅ Đã sửa — Task 11, `dd8cdad`/`19c567a` |
| 52 | Báo hỏng – header/filter | `MaintenanceTab.jsx:418-448,453-461` | `maintenance_tab.dart:464-483` | Thiếu 3 tab lọc | tb | ✅ Đã sửa — Task 12, `2e206c8` + fix `51f2f25` |
| 53 | Báo hỏng – thẻ yêu cầu | `MaintenanceTab.jsx:499-765` | `maintenance_tab.dart:515-618` | Thiếu mã tra cứu, 5 badge, vị trí/khung giờ, SLA, ảnh, kỹ thuật viên | cao | ✅ Đã sửa — Task 12, `2e206c8`/`51f2f25` |
| 54 | Báo hỏng – form tạo | `MaintenanceTab.jsx:789-852` | `maintenance_tab.dart:114-171` | 8 hạng mục/4 mức độ vs 5/3; thiếu vị trí, khung giờ | tb | ✅ Đã sửa — Task 12, `2e206c8`/`51f2f25` |
| 55 | Báo hỏng – trùng lặp | `MaintenanceTab.jsx:855-922` | — | Thiếu modal 409 DUPLICATE | tb | ✅ Đã sửa — Task 12, `2e206c8`/`51f2f25` |
| 56 | Báo hỏng – modal chi tiết/lightbox | `MaintenanceTab.jsx:1098-1215` | — | Thiếu | tb | ✅ Đã sửa — Task 12, `2e206c8`/`51f2f25` |
| 57 | Báo hỏng – mở lại | `MaintenanceTab.jsx:106,409-415` | `maintenance_tab.dart:524` | React dùng `sla_config.reopen_window_days` | tb | ✅ Đã sửa — Task 12, `2e206c8`/`51f2f25` |
| 58 | Dịch vụ – tiêu đề/layout | `ServicesTab.jsx:393-395,552-555` | `services_tab.dart:345,442` | Grid 2/3 cột vs danh sách 1 cột | cao | ❌ Còn mở — **không có task nào trong plan 1–17** nhận điểm #58–#65 |
| 59 | Dịch vụ – CTA header | `ServicesTab.jsx:396-402` | `services_tab.dart:344-350` | Thiếu "Đăng ký thêm dịch vụ" | tb | ❌ Còn mở — chưa gán task |
| 60 | Dịch vụ – thẻ đăng ký | `ServicesTab.jsx:426-501` | `services_tab.dart:361-433` | Thiếu icon danh mục, căn hộ, ngày, tổng tháng | tb | ❌ Còn mở — chưa gán task |
| 61 | Dịch vụ – lịch sử hủy | `ServicesTab.jsx:506-547` | — | Thiếu toggle | tb | ❌ Còn mở — chưa gán task |
| 62 | Dịch vụ – catalog | `ServicesTab.jsx:580-642` | `services_tab.dart:450-513` | Thiếu badge danh mục, "Đã đăng ký", "Tính theo chỉ số" | tb | ❌ Còn mở — chưa gán task |
| 63 | Dịch vụ – modal đăng ký | `ServicesTab.jsx:648-797` | `services_tab.dart:116-243` | Thiếu ngày bắt đầu, ghi chú, breakdown pro-rata | tb | ❌ Còn mở — chưa gán task |
| 64 | Dịch vụ – modal hủy | `ServicesTab.jsx:903-960` | `services_tab.dart:246-313` | Thiếu ngày kết thúc + pro-rata | tb | ❌ Còn mở — chưa gán task |
| 65 | Dịch vụ – modal chi tiết | `ServicesTab.jsx:799-901` | — | Thiếu | tb | ❌ Còn mở — chưa gán task |

---

## 3. Các màn hình còn lại — 28 điểm khác biệt

| # | Khu vực | React (`file:line`) | Flutter (`file:line`) | Khác biệt | Mức | Trạng thái sau parity |
|---|---|---|---|---|---|---|
| 1 | Bảo trì – KPI | `ServiceRequestsPage.jsx:770-807` | `service_requests_page.dart:313-351` | 4 chỉ số khác nhau (Quá hạn SLA / Khẩn cấp chỉ có Flutter) | cao | ✅ Đã sửa — Task 15, `f990a92` |
| 2 | Bảo trì – ảnh khi tạo | `ServiceRequestsPage.jsx:1089-1095,423` | `service_requests_page.dart:1916-2019` | Flutter thiếu field ảnh `images[]` | cao | ✅ Đã sửa — Task 15, `f990a92` |
| 3 | Sổ cọc – drill-down Dashboard | `DepositsPage.jsx:346-368,405-417` | `deposits_page.dart:25-31,106-137` | Flutter bỏ qua `?tab=payout`, `?overdue=1`, `?status=DISPUTED` → 3 card cảnh báo thành link chết | cao | ✅ Đã sửa — Task 13, `3d7936a` |
| 4 | Cấu hình – ngưỡng chỉ số/nhắc nợ | `SettingsPage.jsx:722,736` | `settings_page.dart:609-664` | Thiếu 2 input | tb | ✅ Đã sửa — Task 16, `086db06` |
| 5 | Cấu hình – cửa sổ mở lại | `SettingsPage.jsx:838` | `settings_page.dart:691-717` | Thiếu input | tb | ✅ Đã sửa — Task 16, `086db06` |
| 6 | Cấu hình – hotline PCCC | `SettingsPage.jsx:898` | `settings_page.dart:744-770` | Thiếu input | tb | ✅ Đã sửa — Task 16, `086db06` |
| 7 | Bảo trì – cột bảng | `ServiceRequestsPage.jsx:589-712` | `service_requests_page.dart:770-846` | Thiếu cột "Phụ trách", "Đánh giá" | tb | ✅ Đã sửa — Task 15, `f990a92` |
| 8 | Bảo trì – chi tiết | `ServiceRequestsPage.jsx:1379-1456` | `service_requests_page.dart:1254-1310` | Thiếu thời điểm tiếp nhận, hạn SLA, phản hồi đầu | tb | ✅ Đã sửa — Task 15, `f990a92` |
| 9 | Bảo trì – group Zalo | `ServiceRequestsPage.jsx:1321-1377` | `service_requests_page.dart:1209-1247` | Thiếu link nhóm + preview tin nhắn | tb | ✅ Đã sửa — Task 15, `f990a92` |
| 10 | Bảo trì – lightbox ảnh | `ServiceRequestsPage.jsx:1814-1830` | `service_requests_page.dart:1292-1307` | Ảnh Flutter không bấm được | tb | ✅ Đã sửa — Task 15, `f990a92` |
| 11 | Bảo trì – filter | `ServiceRequestsPage.jsx:220-227,855-869` | `service_requests_page.dart:404-506` | React debounce 200ms + nút "Xóa bộ lọc" | tb | ✅ Đã sửa — Task 15, `f990a92` |
| 12 | Bảo trì – thẻ Kanban | `ServiceRequestsPage.jsx:924-984` | `service_requests_page.dart:628-760` | Thiếu badge AI triage, "Mở lại xN", tên người gửi, sao đánh giá | tb | ✅ Đã sửa — Task 15, `f990a92` |
| 13 | Bảo trì – trùng lặp | `ServiceRequestsPage.jsx:1104-1132` | `service_requests_page.dart:1866-1913` | React có link mở phiếu cũ; khác flag (`ignore_duplicate_warning` vs `force_duplicate`) | tb | ✅ Đã sửa — Task 15, `f990a92`. Ruling ledger: giữ flag Flutter hiện tại vì không xác minh được contract API; link "Mở phiếu #..." đã thêm |
| 14 | Sổ cọc – KPI | `DepositsPage.jsx:1662-1695` | `deposits_page.dart:243-281` | Bộ 4 KPI khác, Flutter mất subtext/click drill-down | tb | ✅ Đã sửa — Task 14, `e9ba66c` + fix `252eedf` |
| 15 | Bảo trì – tiêu đề trang | `ServiceRequestsPage.jsx:725-726` | `service_requests_page.dart:250-252` | Khác tiêu đề & subtitle | tb | ✅ Đã sửa — Task 15, `f990a92` |
| 16 | Bảo trì – chuyển chế độ | `ServiceRequestsPage.jsx:729-754` | `service_requests_page.dart:258-288` | React nút có chữ, Flutter chỉ icon | tb | ✅ Đã sửa — Task 15, `f990a92` |
| 17 | Bảo trì – lý do mở lại/hủy | `ServiceRequestsPage.jsx:1466-1475` | `service_requests_page.dart:1136-1395` | Thiếu 2 block hiển thị | tb | ✅ Đã sửa — Task 15, `f990a92` |
| 18 | Bảo trì – timeline audit | `ServiceRequestsPage.jsx:1770-1808` | `service_requests_page.dart:1347-1393` | Flutter in raw `action`, thiếu map nhãn + chuyển trạng thái | thấp | ✅ Đã sửa — Task 15, `f990a92` |
| 19 | Bảo trì – nhãn action | `ServiceRequestsPage.jsx:1547,1580,1591` | `service_requests_page.dart:1572,1586,1603` | 3 nhãn khác | thấp | ✅ Đã sửa — Task 15, `f990a92` |
| 20 | Bảo trì – AI triage | `ServiceRequestsPage.jsx:1206,1302` | `service_requests_page.dart:1435,1524` | Khác wording | thấp | ✅ Đã sửa — Task 15, `f990a92` |
| 21 | Bảo trì – nút tạo | `ServiceRequestsPage.jsx:762` | `service_requests_page.dart:295-299` | "Tạo yêu cầu hộ cư dân" vs "+ Tiếp nhận yêu cầu" | thấp | ✅ Đã sửa — Task 15, `f990a92` |
| 22 | Bảo trì – placeholder | `ServiceRequestsPage.jsx:816,905` | `service_requests_page.dart:404,607` | Khác chữ tìm kiếm/empty | thấp | ✅ Đã sửa — Task 15, `f990a92` |
| 23 | Sổ cọc – tab/tiêu đề | `DepositsPage.jsx:1558-1569,1640-1657` | `deposits_page.dart:204-208,219-237` | Nhiều nhãn đổi; thiếu tab "Chờ chi hoàn" | thấp | ✅ Đã sửa — Task 14, `e9ba66c`/`252eedf` |
| 24 | Dashboard – subtitle/empty | `DashboardPage.jsx:462-463,512,573,589` | `dashboard_page.dart:385-386,427-428` | Flutter bỏ "(PRD 15.1 & 15.3)", "(RP-01)" và rút gọn chữ | thấp | ✅ Đã sửa — Task 17, `99bc91f` |
| 25 | Thanh toán – màu badge nợ | `PaymentsPage.jsx:70` | `payments_page.dart:64` | Nhóm 31–60 ngày: orange vs indigo | thấp | ✅ Đã sửa — Task 17, `99bc91f` (minor: variant `amber` không được dùng bởi render đặc biệt) |
| 26 | Thanh toán – header CSV | `PaymentsPage.jsx:524` | `payments_page.dart:630` | Thiếu "(AC-016.1)" | thấp | ✅ Đã sửa — Task 17, `99bc91f` |
| 27 | Đồng hồ – badge OCR | `MeterBatchPhotoImportModal.jsx:68,81,99` | `meter_batch_photo_import_modal.dart:400,404,410` | "Đã lập HĐ"→"Đã khóa HĐ" v.v. | thấp | ✅ Đã sửa — Task 17, `99bc91f` (phần WIP người dùng đã được preserve ở `53be85f`, giữ nguyên) |
| 28 | Định dạng kỳ hiện tại | `format.js:61-72` | `format.dart:103-108` | React ép `Asia/Ho_Chi_Minh`; Flutter dùng giờ máy → lệch trên máy không GMT+7 | thấp | ✅ Đã sửa — Task 17, `99bc91f` |

---

## 4. Tổng hợp trạng thái sau parity (đếm theo file + commit)

Kiểm chứng bằng `git diff --stat 4186de9 f990a92 -- flutter_resihub/lib`: 16 file được sửa; **`overview_tab.dart` và `services_tab.dart` không nằm trong đó**.

| Nhóm | Số điểm | Kết quả | Task / commit |
|---|---:|---|---|
| Shell resident (#1–#4) | 4 | ✅ sửa 4 | Task 6 — `7f1152e` |
| Overview resident (#5–#19) | 15 | ❌ mở 15 | Tasks 2/3/4/5 — **không có commit**; helper Task 1 (`e6de9fa`, file `resident_overview_helpers.dart`) tồn tại nhưng **không được import/consume** ở bất kỳ đâu |
| Pull-to-refresh (#20) | 1 | ➖ giữ 1 | Flutter-only, theo quyết định plan |
| Notifications (#21–#27) | 7 | ✅ sửa 7 | Task 7 — `20d3f57` |
| Contact (#28–#31) | 4 | ✅ sửa 4 | Task 8 — `51a90e8`, fix `f2a97ad` |
| Profile (#32–#37) | 6 | ✅ sửa 6 | Task 9 — `440a024` |
| Invoices (#38–#44) | 7 | ✅ sửa 5, giữ 2 | Task 10 — `32224dc` (#38/#39 giữ Flutter-only) |
| Contract (#45–#51) | 7 | ✅ sửa 7 | Task 11 — `dd8cdad`, fix `19c567a` |
| Maintenance resident (#52–#57) | 6 | ✅ sửa 6 | Task 12 — `2e206c8`, fix `51f2f25` |
| Services resident (#58–#65) | 8 | ❌ mở 8 | **Không có task nào trong plan 1–17**; `services_tab.dart` không đổi |
| Admin — Deposits drill-down (#3) | 1 | ✅ sửa 1 | Task 13 — `3d7936a` |
| Admin — Deposits KPI/tab (#14, #23) | 2 | ✅ sửa 2 | Task 14 — `e9ba66c`, fix `252eedf` |
| Admin — Maintenance page (#1, #2, #7–#22) | 18 | ✅ sửa 18 | Task 15 — `f990a92` |
| Admin — Settings (#4–#6) | 3 | ✅ sửa 3 | Task 16 — `086db06` |
| Admin — Copy/color/format (#24–#28) | 5 | ✅ sửa 5 | Task 17 — `99bc91f` |

**Tổng: 93 = ✅ 67 đã sửa + ➖ 3 giữ nguyên (Flutter-only) + ❌ 23 còn mở (15 Overview + 8 Dịch vụ).**

> ⚠️ Ledger `progress.md` ghi nhận hoàn thành 13 task / 17; không có dòng "Task 2/3/4/5: complete". Ghi chú "93/93 điểm được gán vào Task 1–17" trong plan self-review là **không chính xác** khi đối chiếu với task definitions (không có task Dịch vụ) và với actual commits (không có commit overview). Controller cần xác nhận lại trước khi coi đây là "đã xong 93/93".

---

## 5. Điểm còn mở & các minor hoãn lại (không claim 100%)

### 5.1. Điểm còn mở (23)

- **Overview cổng cư dân — 15 điểm (#5–#19)**: Tasks 2/3/4/5 chưa từng landing. Hệ quả: KPI vẫn `GridView.count` + `childAspectRatio`, không có footer; hero thiếu lời chào/tiện nghi/ô thông số; vẫn là 5 chip "Lối tắt thao tác nhanh"; thiếu 2 card cuối; luồng không-có-HĐ/đặt giữ chỗ chưa đầy đủ. File helper `resident_overview_helpers.dart` (Task 1, `e6de9fa`) bị **dead code** — không có file nào import.
- **Dịch vụ cổng cư dân — 8 điểm (#58–#65)**: `services_tab.dart` không thay đổi; không có task nào trong plan 1–17 nhận nhóm này. Cần mở task mới.

### 5.2. Minor hoãn lại theo ledger (không chặn release nhưng phải biết)

| Task | Minor (deferred) |
|---|---|
| 1 | ISO string có timezone có thể chọn khác ngày lịch so với React local-strip — cần xác nhận format API, thêm `.toLocal()` nếu cần |
| 1 | Test ngày tương đối có thể flake khi quá nửa đêm local |
| 1 | Truthiness "lạ" (`code: 0`, `'true '`) khác `\|\|` của JS |
| 6 | `dart format` toàn file (~320 dòng) làm nhiễu diff functional; không ảnh hưởng đúng đắn |
| 6 | Test dùng `tester.view.physicalSize` thay vì `setSurfaceSize` — có lý do (harness overflow), vẫn là 390px logical |
| 7 | Skeleton gate theo `filtered.isEmpty` thay vì toàn bộ thông báo — flash thoáng qua khi refresh filter UNREAD |
| 7 | Màu type `indigo` dùng `secondary700`, React dùng indigo-600 (`secondary600` có sẵn) |
| 9 | Assertion mount/dispose nới thành `findsWidgets` do va chạm placeholder số điện thoại — khôi phục `findsOneWidget` với số test riêng |
| 9 | Payload upload CCCD dùng key `image_data` vs React `image_base64` — cần task riêng để đối soát API |
| 9 | Icon field & native date input chưa port — ngoài phạm vi brief |
| 10 | 2 hint string tự tạo (`Mã hóa đơn:`, `Ngày thanh toán`) — báo cáo này ghi nhận compromise |
| 10 | `_paymentMethods` trùng `kPaymentMethodOptions` trong `statuses.dart` |
| 10 | Hint "Bằng số:" bị stale khi gõ (`MoneyInput onChanged` thiếu `setModalState`) |
| 10 | Payload ngày `toUtc()` đẩy nửa đêm VN sang ngày UTC trước — cosmetic |
| 11 | Tên file "Bản in" trong lịch sử khác tên A4 hợp đồng — mirrors React, cosmetic |
| 11 | Chuyển `AppCard` làm thay đổi nhẹ border/shadow/gap |
| 12 | Prefix code/SLA trần, thiếu banner no-contract + empty CTA + rating note, nút reopen hết hạn chưa disable, timer reset copy-code — ngoài phạm vi brief |
| 13 | Tab tap khi quick filter còn active để `_quickFilter` lại → tab như bị "chết" và banner vẫn hiện; React xóa param khi tap tab (DepositsPage.jsx:361-369) |
| 13 | `?status=XYZ` bất kỳ (≠DISPUTED) rơi về filter thường — brief chỉ bắt buộc DISPUTED |
| 14 | Dùng `router.go` thay vì `replace` khi clear filter — back nav có thể apply lại filter |
| 15 | 2 lint info-level curly-brace ở `service_requests_page.dart:284,297` sau re-wrap `if` |
| 15 | Tap "Mở phiếu #SR-00101" và giới hạn 3 ảnh chưa test behavior (chỉ test presence nhãn) |
| 16 | Report cũ nói "not committed" nhưng review package có commit — chỉ sai wording |
| 16 | Không có clamp min/max trên input số mới (React có 1–500 / min=1) — ngoài phạm vi brief |
| 17 | `kAgingLabels['31_60'].variant` đổi indigo→amber nhưng không được render đặc biệt dùng — dead value cosmetic |

### 5.3. Screenshot đối chiếu

4 ảnh trong `docs/ui-diff-screenshots/` vẫn là ảnh **trước parity** (audit 17/11/2026). Task 18 **không tự tạo lại** (ruling: controller chịu trách nhiệm regeneration làm bước verification). Controller cần chụp lại 4 ảnh tại `1440×900` và `390×844` để phản ánh trạng thái sau fix — đặc biệt `<flutter-overview-*-1440/390.png>` vẫn cho thấy KPI/hero cũ vì Tasks 2–5 chưa landing.

---

## 6. Việc cần làm tiếp (đã cập nhật so với bản audit)

1. **Ưu tiên cao nhất: Overview cổng cư dân (#5–#19)** — implement lại Tasks 2/3/4/5 hoặc gộp thành task mới; consume `resident_overview_helpers.dart` đang dead code; chụp lại ảnh overview.
2. **Dịch vụ cổng cư dân (#58–#65)** — mở task mới, chuyển layout grid, thêm CTA/badge/modal theo React.
3. Rà soát 3 quyết định "giữ Flutter-only" (#20, #38, #39) với product nếu muốn 100% tuyệt đối.
4. Xử lý dần minor mục 5.2, đặc biệt payload `image_data` vs `image_base64` (#9) và flag duplicate (#13) cần đối soát API.

---

> Ghi chú lịch sử: các file từng có WIP chưa commit lúc audit (`floor_plan_view.dart`, phần `SelectionArea` trong `resident_shell.dart`, ...) đã được preserve ở commit `53be85f` trước khi parity; report này không đụng vào source code.
