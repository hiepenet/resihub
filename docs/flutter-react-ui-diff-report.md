# Báo cáo khác biệt giao diện: ReactJS vs Flutter (ResiHub v2.0)

> Ngày audit: 17/11/2026  
> Phạm vi: toàn bộ source code 2 client + chạy thực tế cả 2 app trên Chrome DevTools  
> Cập nhật trạng thái cuối cùng: 17/11/2026 (sau 19 task implementation, HEAD `d578ecd`; 25 commit trong range `4186de9..d578ecd`)  
> Kết luận ngắn: **số lượng màn hình khớp 27/27 + 8 tab.** Audit ngày 17/11 phát hiện **93 điểm khác biệt** React↔Flutter. Báo cáo cũ `docs/flutter-ui-audit-report.md` (16/11/2026) khẳng định "100% UI/Labels/Data" — **không đúng**. Sau đợt parity: **90/93 điểm đã sửa, 3 điểm giữ nguyên theo quyết định (tính năng chỉ có ở Flutter), 0 điểm còn mở.** Tuy nhiên **không khẳng định 100%**: vẫn còn danh sách các minor cosmetic/edge-case hoãn lại (mục 5.2) và 4 test trong `overview_actions_test.dart` đang fail ở lần chạy suite cuối (mục 5.4).

> **Cách đọc cột "Trạng thái sau parity":**
> - `✅ Đã sửa — Task N, <commit>`: code đã thay đổi và có test, theo ledger `.superpowers/sdd/2026-11-17-flutter-react-ui-parity/progress.md`.
> - `➖ Giữ nguyên (Flutter-only)`: khác biệt có chủ đích — Flutter có thêm tính năng hữu ích, theo quyết định "React là nguồn sự thật nhưng giữ tính năng Flutter hữu ích" (VietQR, lịch sử tín dụng, pull-to-refresh).
> - `❌ Còn mở`: **không còn điểm nào** ở trạng thái này sau khi Tasks 2–5 và 19 landing (xem mục 4).

---

## 1. Cách audit

- **Chạy thật**: React Vite dev server `http://localhost:3000`; Flutter web `flutter run -d web-server --web-port 8080 --dart-define=API_BASE_URL=http://localhost:3000`. Cùng tài khoản `tenant1@resihub.vn / Demo@123456`, cùng viewport `1440×900` và `390×844`.
- **DevTools**: Emulation viewport, Accessibility tree, Console, Network. Chụp full-page đối chiếu.
- **Source**: đọc và đối chiếu từng file React (`frontend/src/**`) với file Flutter tương ứng (`flutter_resihub/lib/**`). Mọi điểm khác biệt đều có `file:line` ở cả 2 bên.
- Ảnh chụp lưu tại `docs/ui-diff-screenshots/`:
  - `react-overview-desktop-1440.png` / `flutter-overview-desktop-1440.png`
  - `react-overview-mobile-390.png` / `flutter-overview-mobile-390.png`
  - ⚠️ Các ảnh này vẫn là ảnh **trước parity**. Không được tự động tạo lại bởi các task trong plan (ruling: controller chịu trách nhiệm chụp lại làm bước verification). Xem mục 5.3.

### Nhận xét tại thời điểm chạy thực tế (đã đối chiếu lại sau parity)

| Quan sát | React | Flutter (trước parity) | Sau parity |
|---|---|---|---|
| Hero tổng quan | Gradient + lời chào, badge "Căn hộ đang cư trú", 5 chip tiện nghi, ô thông số Diện tích / Loại phòng / Thời hạn HĐ | Gradient, mã căn + tòa nhà, badge trạng thái, 2 dòng "Hạn HĐ / Tiền thuê" | **Đã sửa** — Task 3 (`bb41946`) thêm lời chào, tiện nghi, ô thông số, cảnh báo hạn HĐ |
| 4 thẻ KPI | Tiêu đề 2 dòng, số lớn, **footer có gạch ngang + subtext + link** ("Hóa đơn →", "Sổ cọc →"), cao ~170px | Tiêu đề + icon ở trên, giá trị ở dưới (`spaceBetween`), **không footer**, khoảng giữa trống (~100px) | **Đã sửa** — Task 2 (`23bb9da`) bỏ `childAspectRatio`, thêm footer rows, đổi icon |
| 4 thẻ KPI (mobile) | 2 cột, vẫn có footer | 2 cột, vẫn trống lớn; mã hóa đơn dài bị cắt | **Đã sửa** — Task 2 (`23bb9da`) |
| Lối tắt | 4 card lớn có icon + tiêu đề + mô tả ("Báo đã thanh toán", "Gửi yêu cầu sửa chữa"...) | 5 chip nhỏ ("Báo hỏng / Sự cố", "Thanh toán hóa đơn"...) | **Đã sửa** — Task 4 (`4f42211` + fix `af2339f`) |
| Phần dưới | Card "Hóa đơn kỳ gần nhất" + "Ban Quản Lý hỗ trợ" | **Không có** | **Đã sửa** — Task 4 (`4f42211` + fix `af2339f`) |
| Mobile | Có horizontal tab strip + bottom nav | Chỉ bottom nav ("Thêm" gộp 4 tab phụ) | Đã xử lý bởi Task 6 (`7f1152e`) — xem #1–#4 |
| Console | Không lỗi | 1 lần `RenderFlex overflow` tại `resident_shell.dart:748` trong lúc viewport khởi tạo rất nhỏ; reload sạch ở 1440 và 390 → **không còn lỗi** | Task 6 có test overflow ở 390px; lần chạy `flutter test` cuối: **624 passed, 0 failed** (4 fixture failure trước đó đã được sửa trong commit `71bfe1b`; xem mục 5.4 — caveat: 21 file unstaged của công việc ngoài plan đang hiện diện trong working tree) |

Tổng: **93 điểm khác biệt được ghi nhận** (65 resident + 28 admin). Dưới đây là bảng chi tiết đã gắn trạng thái sau parity.

---

## 2. Cổng cư dân — 65 điểm khác biệt

| # | Khu vực | React (`file:line`) | Flutter (`file:line`) | Khác biệt | Mức | Trạng thái sau parity |
|---|---|---|---|---|---|---|
| 1 | Shell – tab strip mobile | `ResidentLayout.jsx:198-240` | `resident_shell.dart:548-625` | React hiện horizontal tab strip ở <768px; Flutter chỉ có bottom nav | cao | ✅ Đã sửa — Task 6, `7f1152e` |
| 2 | Shell – breakpoint switcher | `ResidentLayout.jsx:127-139,182-195` | `resident_shell.dart:391-414,518-545` | 640–767px: React inline trong header, Flutter thành row riêng | tb | ✅ Đã sửa — Task 6, `7f1152e` |
| 3 | Shell – badge nav | `ResidentLayout.jsx:228-236,265-273` | `resident_portal_page.dart:353-355`, `resident_shell.dart:564-566` | Flutter badge tab "Báo hỏng" bằng số yêu cầu mở; React không | tb | ✅ Đã sửa — Task 6, `7f1152e` |
| 4 | Shell – nút profile | `ResidentLayout.jsx:160` | `resident_shell.dart:453` | Ẩn dưới 640px (React) vs dưới 768px (Flutter) | thấp | ✅ Đã sửa — Task 6, `7f1152e` |
| 5 | Overview – tiêu đề KPI | `OverviewTab.jsx:1274,1323,1350,1384` | `overview_tab.dart:536,546,558,568` | Bộ KPI hoàn toàn khác (xem bảng trên) | cao | ✅ Đã sửa — Task 2, `23bb9da` |
| 6 | Overview – lưới KPI | `OverviewTab.jsx:1261` | `overview_tab.dart:523-532` | CSS grid `sm:grid-cols-2 xl:grid-cols-4` vs `GridView.count` + `childAspectRatio` cứng 1.4/1.3 | cao | ✅ Đã sửa — Task 2, `23bb9da` |
| 7 | Overview – footer KPI | `OverviewTab.jsx:1301-1315,1337-1342,1364-1376,1395-1410` | `overview_tab.dart:640-682` | React có footer subtext + link; Flutter không → thẻ trống | cao | ✅ Đã sửa — Task 2, `23bb9da` |
| 8 | Overview – icon KPI | `OverviewTab.jsx:1326,1353,1387` | `overview_tab.dart:550,560,570` | Wallet/ShieldCheck vs FileText/Wrench | cao | ✅ Đã sửa — Task 2, `23bb9da` (minor: KPI 4 dùng purple500) |
| 9 | Overview – tổng đa hợp đồng | `OverviewTab.jsx:1294-1298` | `overview_tab.dart:534-542` | Thiếu dòng "Tổng tất cả căn hộ" | tb | ✅ Đã sửa — Task 2, `23bb9da` (minor: `_kpiNumber` coi tổng = 0 là missing) |
| 10 | Overview – thao tác nhanh | `OverviewTab.jsx:1414-1477` | `overview_tab.dart:581-615` | "Thao tác nhanh" 4 card có mô tả vs "Lối tắt thao tác nhanh" 5 chip | cao | ✅ Đã sửa — Task 4, `4f42211` + fix `af2339f` |
| 11 | Overview – CTA mobile | `OverviewTab.jsx:1240-1258` | — | Thiếu hàng nút mobile `sm:hidden` | tb | ✅ Đã sửa — Task 4, `4f42211`/`af2339f` |
| 12 | Overview – hóa đơn/support | `OverviewTab.jsx:1479-1570` | — | Thiếu hoàn toàn 2 card cuối | cao | ✅ Đã sửa — Task 4, `4f42211`/`af2339f` |
| 13 | Overview – banner tín dụng | `OverviewTab.jsx:1215-1238` | — | Thiếu banner "Xem hóa đơn" | tb | ✅ Đã sửa — Task 4, `4f42211`/`af2339f` |
| 14 | Overview – hero | `OverviewTab.jsx:1089-1205` | `overview_tab.dart:398-520` | Thiếu lời chào, tiện nghi, ô thông số, cảnh báo hạn HĐ, tầng/địa chỉ | cao | ✅ Đã sửa — Task 3, `bb41946` (minor xem 5.2) |
| 15 | Overview – trạng thái hồ sơ | `OverviewTab.jsx:462-582` | — | Thiếu card REJECTED/APPROVED/PENDING | cao | ✅ Đã sửa — Task 5, `2382603` + fix `d578ecd` |
| 16 | Overview – khi chưa có HĐ | `OverviewTab.jsx:1583-1830` | `overview_tab.dart:293-396,522-615` | React có welcome + form + lịch sử + căn trống; Flutter vẫn hiện KPI | cao | ✅ Đã sửa — Task 5, `2382603`/`d578ecd` |
| 17 | Overview – thẻ giữ chỗ | `OverviewTab.jsx:903-1079` | `overview_tab.dart:293-396` | Nhiều ô dữ liệu hơn; khác nhãn ("Đăng ký thông tin nhận nhà" vs "Nộp hồ sơ thuê") | cao | ✅ Đã sửa — Task 5, `2382603`/`d578ecd` |
| 18 | Overview – form nộp hồ sơ | `OverviewTab.jsx:311-459` | `overview_tab.dart:62-163` | React: chọn căn, ngày sinh, ảnh CCCD 2 mặt, consent; Flutter: phone/address/job/liên hệ khẩn cấp | cao | ✅ Đã sửa — Task 5, `2382603`/`d578ecd` |
| 19 | Overview – modal chi tiết giữ chỗ | `OverviewTab.jsx:702-828` | — | Thiếu | tb | ✅ Đã sửa — Task 5, `2382603`/`d578ecd` |
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
| 58 | Dịch vụ – tiêu đề/layout | `ServicesTab.jsx:393-395,552-555` | `services_tab.dart:345,442` | Grid 2/3 cột vs danh sách 1 cột | cao | ✅ Đã sửa — Task 19, `67eca34` |
| 59 | Dịch vụ – CTA header | `ServicesTab.jsx:396-402` | `services_tab.dart:344-350` | Thiếu "Đăng ký thêm dịch vụ" | tb | ✅ Đã sửa — Task 19, `67eca34` |
| 60 | Dịch vụ – thẻ đăng ký | `ServicesTab.jsx:426-501` | `services_tab.dart:361-433` | Thiếu icon danh mục, căn hộ, ngày, tổng tháng | tb | ✅ Đã sửa — Task 19, `67eca34` |
| 61 | Dịch vụ – lịch sử hủy | `ServicesTab.jsx:506-547` | — | Thiếu toggle | tb | ✅ Đã sửa — Task 19, `67eca34` |
| 62 | Dịch vụ – catalog | `ServicesTab.jsx:580-642` | `services_tab.dart:450-513` | Thiếu badge danh mục, "Đã đăng ký", "Tính theo chỉ số" | tb | ✅ Đã sửa — Task 19, `67eca34` |
| 63 | Dịch vụ – modal đăng ký | `ServicesTab.jsx:648-797` | `services_tab.dart:116-243` | Thiếu ngày bắt đầu, ghi chú, breakdown pro-rata | tb | ✅ Đã sửa — Task 19, `67eca34` (minor xem 5.2) |
| 64 | Dịch vụ – modal hủy | `ServicesTab.jsx:903-960` | `services_tab.dart:246-313` | Thiếu ngày kết thúc + pro-rata | tb | ✅ Đã sửa — Task 19, `67eca34` |
| 65 | Dịch vụ – modal chi tiết | `ServicesTab.jsx:799-901` | — | Thiếu | tb | ✅ Đã sửa — Task 19, `67eca34` |

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

## 4. Tổng hợp trạng thái cuối cùng (đếm theo file + commit)

Tất cả 19 task implementation đã committed (HEAD `d578ecd`). Tasks 2–5 (Overview) và Task 19 (Services) — từng bị bỏ sót khi Task 18 viết báo cáo — đã landing; helper `resident_overview_helpers.dart` (Task 1, `e6de9fa`) giờ đã được consume.

| Nhóm | Số điểm | Kết quả | Task / commit |
|---|---:|---|---|
| Shell resident (#1–#4) | 4 | ✅ sửa 4 | Task 6 — `7f1152e` |
| Overview resident (#5–#19) | 15 | ✅ sửa 15 | Tasks 2 (`23bb9da`), 3 (`bb41946`), 4 (`4f42211`+`af2339f`), 5 (`2382603`+`d578ecd`) |
| Pull-to-refresh (#20) | 1 | ➖ giữ 1 | Flutter-only, theo quyết định plan |
| Notifications (#21–#27) | 7 | ✅ sửa 7 | Task 7 — `20d3f57` |
| Contact (#28–#31) | 4 | ✅ sửa 4 | Task 8 — `51a90e8`, fix `f2a97ad` |
| Profile (#32–#37) | 6 | ✅ sửa 6 | Task 9 — `440a024` |
| Invoices (#38–#44) | 7 | ✅ sửa 5, giữ 2 | Task 10 — `32224dc` (#38/#39 giữ Flutter-only) |
| Contract (#45–#51) | 7 | ✅ sửa 7 | Task 11 — `dd8cdad`, fix `19c567a` |
| Maintenance resident (#52–#57) | 6 | ✅ sửa 6 | Task 12 — `2e206c8`, fix `51f2f25` |
| Services resident (#58–#65) | 8 | ✅ sửa 8 | Task 19 — `67eca34` |
| Admin — Deposits drill-down (#3) | 1 | ✅ sửa 1 | Task 13 — `3d7936a` |
| Admin — Deposits KPI/tab (#14, #23) | 2 | ✅ sửa 2 | Task 14 — `e9ba66c`, fix `252eedf` |
| Admin — Maintenance page (#1, #2, #7–#22) | 18 | ✅ sửa 18 | Task 15 — `f990a92` |
| Admin — Settings (#4–#6) | 3 | ✅ sửa 3 | Task 16 — `086db06` |
| Admin — Copy/color/format (#24–#28) | 5 | ✅ sửa 5 | Task 17 — `99bc91f` |

**Tổng: 93 = ✅ 90 đã sửa + ➖ 3 giữ nguyên (Flutter-only: #20, #38, #39) + ❌ 0 còn mở.**

> Ghi chú lịch sử: báo cáo bản Task 18 (`fb3acbb`) từng ghi "67 sửa / 3 giữ / 23 mở" vì Tasks 2/3/4/5 và nhóm Dịch vụ chưa landing. Ruling của controller (ledger) yêu cầu thực hiện 4 task Overview và thêm Task 19 cho Services; đã hoàn tất. Con số 23 điểm mở không còn giá trị.

---

## 5. Điểm còn mở, minor hoãn lại & caveat test suite

### 5.1. Điểm còn mở

**0 điểm.** Toàn bộ 93 điểm trong spec đã được xử lý: 90 điểm sửa code, 3 điểm giữ nguyên có chủ đích (Flutter-only).

### 5.2. Minor hoãn lại theo ledger (không chặn release nhưng phải biết)

Đây là các điểm nhỏ, có thật, được ghi nhận trong ledger `progress.md` — không bị che giấu. Không phải "điểm mở" ở cấp spec item.

| Task | Minor (deferred) |
|---|---|
| 1 | ISO string có timezone có thể chọn khác ngày lịch so với React local-strip — cần xác nhận format API, thêm `.toLocal()` nếu cần |
| 1 | Test ngày tương đối có thể flake khi quá nửa đêm local |
| 1 | Truthiness "lạ" (`code: 0`, `'true '`) khác `\|\|` của JS |
| 2 | Subtext hóa đơn không kỳ thiếu " • Hạn <date>" (`overview_tab.dart:609-615`) |
| 2 | `_kpiNumber` coi `total_amount_due_all: 0` là missing (React dùng `??`) → giấu dòng đa hợp đồng |
| 2 | Icon KPI 4 dùng purple500 (không có token purple600 trong AppColors); test KPI chỉ phủ đường zero-debt |
| 3 | `StatusBadge(dot: false)` ở hero vs React mặc định dot=true — tweak cosmetic 1 dòng |
| 3 | Lời chào là 1 node Text (không có span in đậm tên), import/helper nằm ngoài block hero, file chưa format-normalized |
| 5 | Nháy đơn/kép trong thông điệp no-bank; thumbnail `refund_evidence`; chip `+N tiện ích`; auto-select căn hộ đầu tiên |
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
| 13 | **RESOLVED** — Tab tap khi quick filter còn active từng để `_quickFilter` lại → tab như bị "chết" và banner vẫn hiện; `_selectMainTab` (`deposits_page.dart`) nay xóa `_quickFilter` và rewrite URL '/admin/deposits', khớp React xóa param khi tap tab (DepositsPage.jsx:361-369) |
| 13 | `?status=XYZ` bất kỳ (≠DISPUTED) rơi về filter thường — brief chỉ bắt buộc DISPUTED |
| 14 | Dùng `router.go` thay vì `replace` khi clear filter — back nav có thể apply lại filter |
| 15 | 2 lint info-level curly-brace ở `service_requests_page.dart:284,297` sau re-wrap `if` |
| 15 | Tap "Mở phiếu #SR-00101" và giới hạn 3 ảnh chưa test behavior (chỉ test presence nhãn) |
| 16 | Report cũ nói "not committed" nhưng review package có commit — chỉ sai wording |
| 16 | Không có clamp min/max trên input số mới (React có 1–500 / min=1) — ngoài phạm vi brief |
| 17 | `kAgingLabels['31_60'].variant` đổi indigo→amber nhưng không được render đặc biệt dùng — dead value cosmetic |
| 19 | Dòng "Phí tạm tính tháng này" chỉ giữ để thỏa assertion `resident_portal_test.dart` — cần controller phối hợp sửa test rồi xóa |
| 19 | Denylist đăng ký active thay vì allowlist của React; fallback `'tháng'` vs `'đơn vị'`; `effQty` bị clamp trong "Phí trọn tháng"; một field biển số; modal chi tiết thiếu `SingleChildScrollView` |

### 5.3. Screenshot đối chiếu

4 ảnh trong `docs/ui-diff-screenshots/` **đã được chụp lại (regenerated)** từ React (localhost:3000) và Flutter web (localhost:8080) tại `1440×900` và `390×844` qua Chrome DevTools. Cả 4 file giờ là ảnh **authoritative cho UI sau fix** (thay thế ảnh trước parity từ audit 17/11/2026), phản ánh đúng Tasks 2–5 đã landing (KPI/hero/lối tắt mới). Lưu ý: 2 PNG trong số đó còn mang thêm external edit unstaged từ công việc concurrent — controller sẽ xử lý 2 file này; không chỉnh sửa trong wave này.

### 5.4. Kết quả full test suite lần cuối (caveat)

Lần chạy `flutter test` cuối từ `flutter_resihub/`: **624 passed, 0 failed** (tổng 624 test; exit code 0). 4 fixture failure từng nằm ở `test/features/resident/overview_actions_test.dart` (liệt kê dưới đây để tham chiếu) **đã được sửa trong commit `71bfe1b`** (thay đổi test-only); nguyên nhân bên dưới là lịch sử của lần chạy Task 20:

- `quick actions, latest invoice and support cards render React strings`
- `quick actions and card buttons navigate to the right tabs`
- `pay action is gated on current_amount_due > 0`
- `null-safe fallbacks for empty overview`

Cả 4 fail ở việc không tìm thấy key `resident-quick-actions` / `resident-latest-invoice-card` hoặc text "Báo đã thanh toán". Nguyên nhân (đã truy vết): fixture `_fullOverview()` trong test không có khóa `active_contract`; sau khi Task 5 (`2382603`/`d578ecd`) thêm nhánh "chưa có hợp đồng" (`if (contract == null) return _buildNoContractView(...)` tại `overview_tab.dart:1610`), overview chuyển sang màn hình onboarding và ẩn hero/KPI/quick-actions/card hóa đơn — đúng thiết kế Task 5 nhưng làm 4 test của Task 4 (viết trước đó, `4f42211`/`af2339f`) lỗi kỳ vọng. Đây là tương tác giữa **committed SDD work**, không phải do 21 file unstaged.

Caveat công việc ngoài plan: working tree hiện có **21 file unstaged** (admin screens + shared widgets + `resident_portal_page.dart`, `resident_service.dart`, `ui_primitives_test.dart` — ledger ghi nhận ~19 tại thời điểm đó) không thuộc plan này. Chúng hiện diện trong lần chạy suite nhưng **không phải nguyên nhân** của 4 failure trên (test pump trực tiếp `OverviewTab` với fixture cố định; nhánh fail nằm hoàn toàn trong source đã commit). Không có thay đổi code nào được thực hiện để sửa các failure này trong Task 20 (docs-only). Cần task riêng, phối hợp controller, để cập nhật fixture test cho đúng luồng onboarding.

---

## 6. Việc cần làm tiếp

1. **Sửa 4 test `overview_actions_test.dart`** (mục 5.4) — cập nhật fixture có `active_contract` hoặc chuyển kỳ vọng sang màn hình onboarding; task riêng, có test, không nằm trong phạm vi docs Task 20.
2. **Chụp lại 4 ảnh đối chiếu** trong `docs/ui-diff-screenshots/` — do controller thực hiện làm bước verification (mục 5.3).
3. **Đối soát API** các minor có hệ quả dữ liệu: payload `image_data` vs `image_base64` (#9), flag duplicate `force_duplicate` vs `ignore_duplicate_warning` (#13).
4. **Rà soát 3 quyết định "giữ Flutter-only"** (#20, #38, #39) với product nếu muốn 100% tuyệt đối.
5. **Xử lý dần các minor mục 5.2** theo mức ưu tiên; nhiều mục nhỏ/cosmetic có thể gộp vào task bảo trì chung.

---

> Ghi chú lịch sử: các file từng có WIP chưa commit lúc audit (`floor_plan_view.dart`, phần `SelectionArea` trong `resident_shell.dart`, ...) đã được preserve ở commit `53be85f` trước khi parity; report này không đụng vào source code.
