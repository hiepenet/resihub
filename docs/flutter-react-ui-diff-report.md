# Báo cáo khác biệt giao diện: ReactJS vs Flutter (ResiHub v2.0)

> Ngày audit: 17/11/2026  
> Phạm vi: toàn bộ source code 2 client + chạy thực tế cả 2 app trên Chrome DevTools  
> Kết luận ngắn: **số lượng màn hình khớp 27/27 + 8 tab, nhưng giao diện, nhãn và dữ liệu hiển thị KHÔNG khớp 1-1.** Báo cáo cũ `docs/flutter-ui-audit-report.md` (16/11/2026) khẳng định "100% UI/Labels/Data" — **không đúng**.

---

## 1. Cách audit

- **Chạy thật**: React Vite dev server `http://localhost:3000`; Flutter web `flutter run -d web-server --web-port 8080 --dart-define=API_BASE_URL=http://localhost:3000`. Cùng tài khoản `tenant1@resihub.vn / Demo@123456`, cùng viewport `1440×900` và `390×844`.
- **DevTools**: Emulation viewport, Accessibility tree, Console, Network. Chụp full-page đối chiếu.
- **Source**: đọc và đối chiếu từng file React (`frontend/src/**`) với file Flutter tương ứng (`flutter_resihub/lib/**`). Mọi điểm khác biệt đều có `file:line` ở cả 2 bên.
- Ảnh chụp lưu tại `docs/ui-diff-screenshots/`:
  - `react-overview-desktop-1440.png` / `flutter-overview-desktop-1440.png`
  - `react-overview-mobile-390.png` / `flutter-overview-mobile-390.png`

### Nhận xét tại thời điểm chạy thực tế

| Quan sát | React | Flutter |
|---|---|---|
| Hero tổng quan | Gradient + lời chào, badge "Căn hộ đang cư trú", 5 chip tiện nghi, ô thông số Diện tích / Loại phòng / Thời hạn HĐ | Gradient, mã căn + tòa nhà, badge trạng thái, 2 dòng "Hạn HĐ / Tiền thuê" |
| 4 thẻ KPI | Tiêu đề 2 dòng, số lớn, **footer có gạch ngang + subtext + link** ("Hóa đơn →", "Sổ cọc →"), cao ~170px | Tiêu đề + icon ở trên, giá trị ở dưới (`spaceBetween`), **không footer**, khoảng giữa trống (~100px) — đúng ảnh bạn gửi |
| 4 thẻ KPI (mobile) | 2 cột, vẫn có footer | 2 cột, vẫn trống lớn; mã hóa đơn dài bị cắt `INV-202610-VOP-...` |
| Lối tắt | 4 card lớn có icon + tiêu đề + mô tả ("Báo đã thanh toán", "Gửi yêu cầu sửa chữa"...) | 5 chip nhỏ ("Báo hỏng / Sự cố", "Thanh toán hóa đơn"...) |
| Phần dưới | Card "Hóa đơn kỳ gần nhất" + "Ban Quản Lý hỗ trợ" | **Không có** |
| Mobile | Có horizontal tab strip + bottom nav | Chỉ bottom nav ("Thêm" gộp 4 tab phụ) |
| Console | Không lỗi | 1 lần `RenderFlex overflow` tại `resident_shell.dart:748` trong lúc viewport khởi tạo rất nhỏ; reload sạch ở 1440 và 390 → **không còn lỗi** |

Tổng: **93 điểm khác biệt được ghi nhận** (65 resident + 28 còn lại). Dưới đây là bảng chi tiết.

---

## 2. Cổng cư dân — 65 điểm khác biệt

| # | Khu vực | React (`file:line`) | Flutter (`file:line`) | Khác biệt | Mức |
|---|---|---|---|---|---|
| 1 | Shell – tab strip mobile | `ResidentLayout.jsx:198-240` | `resident_shell.dart:548-625` | React hiện horizontal tab strip ở <768px; Flutter chỉ có bottom nav | cao |
| 2 | Shell – breakpoint switcher | `ResidentLayout.jsx:127-139,182-195` | `resident_shell.dart:391-414,518-545` | 640–767px: React inline trong header, Flutter thành row riêng | tb |
| 3 | Shell – badge nav | `ResidentLayout.jsx:228-236,265-273` | `resident_portal_page.dart:353-355`, `resident_shell.dart:564-566` | Flutter badge tab "Báo hỏng" bằng số yêu cầu mở; React không | tb |
| 4 | Shell – nút profile | `ResidentLayout.jsx:160` | `resident_shell.dart:453` | Ẩn dưới 640px (React) vs dưới 768px (Flutter) | thấp |
| 5 | Overview – tiêu đề KPI | `OverviewTab.jsx:1274,1323,1350,1384` | `overview_tab.dart:536,546,558,568` | Bộ KPI hoàn toàn khác (xem bảng trên) | cao |
| 6 | Overview – lưới KPI | `OverviewTab.jsx:1261` | `overview_tab.dart:523-532` | CSS grid `sm:grid-cols-2 xl:grid-cols-4` vs `GridView.count` + `childAspectRatio` cứng 1.4/1.3 | cao |
| 7 | Overview – footer KPI | `OverviewTab.jsx:1301-1315,1337-1342,1364-1376,1395-1410` | `overview_tab.dart:640-682` | React có footer subtext + link; Flutter không → thẻ trống | cao |
| 8 | Overview – icon KPI | `OverviewTab.jsx:1326,1353,1387` | `overview_tab.dart:550,560,570` | Wallet/ShieldCheck vs FileText/Wrench | cao |
| 9 | Overview – tổng đa hợp đồng | `OverviewTab.jsx:1294-1298` | `overview_tab.dart:534-542` | Thiếu dòng "Tổng tất cả căn hộ" | tb |
| 10 | Overview – thao tác nhanh | `OverviewTab.jsx:1414-1477` | `overview_tab.dart:581-615` | "Thao tác nhanh" 4 card có mô tả vs "Lối tắt thao tác nhanh" 5 chip | cao |
| 11 | Overview – CTA mobile | `OverviewTab.jsx:1240-1258` | — | Thiếu hàng nút mobile `sm:hidden` | tb |
| 12 | Overview – hóa đơn/support | `OverviewTab.jsx:1479-1570` | — | Thiếu hoàn toàn 2 card cuối | cao |
| 13 | Overview – banner tín dụng | `OverviewTab.jsx:1215-1238` | — | Thiếu banner "Xem hóa đơn" | tb |
| 14 | Overview – hero | `OverviewTab.jsx:1089-1205` | `overview_tab.dart:398-520` | Thiếu lời chào, tiện nghi, ô thông số, cảnh báo hạn HĐ, tầng/địa chỉ | cao |
| 15 | Overview – trạng thái hồ sơ | `OverviewTab.jsx:462-582` | — | Thiếu card REJECTED/APPROVED/PENDING | cao |
| 16 | Overview – khi chưa có HĐ | `OverviewTab.jsx:1583-1830` | `overview_tab.dart:293-396,522-615` | React có welcome + form + lịch sử + căn trống; Flutter vẫn hiện KPI | cao |
| 17 | Overview – thẻ giữ chỗ | `OverviewTab.jsx:903-1079` | `overview_tab.dart:293-396` | Nhiều ô dữ liệu hơn; khác nhãn ("Đăng ký thông tin nhận nhà" vs "Nộp hồ sơ thuê") | cao |
| 18 | Overview – form nộp hồ sơ | `OverviewTab.jsx:311-459` | `overview_tab.dart:62-163` | React: chọn căn, ngày sinh, ảnh CCCD 2 mặt, consent; Flutter: phone/address/job/liên hệ khẩn cấp | cao |
| 19 | Overview – modal chi tiết giữ chỗ | `OverviewTab.jsx:702-828` | — | Thiếu | tb |
| 20 | Overview – pull-to-refresh | — | `overview_tab.dart:285-287` | Chỉ Flutter có | thấp |
| 21 | Thông báo – tiêu đề | `NotificationsTab.jsx:194-197` | `notifications_tab.dart:99-120` | Flutter thiếu "Hộp thư Thông báo Cư dân" + subtitle | tb |
| 22 | Thông báo – nội dung item | `NotificationsTab.jsx:29-163,247-333` | `notifications_tab.dart:150-235` | Flutter không phân loại theo type, không badge/nhãn người gửi/CTA | cao |
| 23 | Thông báo – thời gian | `NotificationsTab.jsx:292-317` | `notifications_tab.dart:221-227` | Tương đối vs tuyệt đối; thiếu gợi ý "Nhấn để xử lý ngay" | tb |
| 24 | Thông báo – skeleton | `NotificationsTab.jsx:225-230` | — | Thiếu | tb |
| 25 | Thông báo – empty state | `NotificationsTab.jsx:231-244` | `notifications_tab.dart:122-148` | 2 variant vs 1 | tb |
| 26 | Thông báo – modal | `NotificationsTab.jsx:340` | `notifications_tab.dart:49-77` | React có nút điều hướng sâu | tb |
| 27 | Thông báo – nút đọc all | `NotificationsTab.jsx:208` | `notifications_tab.dart:111` | "Đánh dấu đọc tất cả (N)" vs "Đọc tất cả" | thấp |
| 28 | Liên hệ – hotline | `ContactTab.jsx:135-372` | `contact_tab.dart:205-255` | Grid 4 card có badge + nút vs 1 cột danh sách | cao |
| 29 | Liên hệ – nhãn | `ContactTab.jsx:146,209,267,326` | `contact_tab.dart:214,223,232,241` | Nhiều nhãn khác nhau | tb |
| 30 | Liên hệ – số 113/114/115 | `ContactTab.jsx:310-313` | — | Thiếu | tb |
| 31 | Liên hệ – hero | `ContactTab.jsx:83-133` | `contact_tab.dart:99-202` | Khác badge, thiếu địa chỉ/giờ làm việc trong hero | tb |
| 32 | Hồ sơ – bố cục | `ProfileTab.jsx:197-199,393-395` | `profile_tab.dart:184-295` | 2 cột (8/12 + 4/12) vs 3 card xếp dọc | cao |
| 33 | Hồ sơ – trường | `ProfileTab.jsx:234-321` | `profile_tab.dart:193-219` | Thiếu ngày sinh, quốc tịch, avatar, dòng consent | cao |
| 34 | Hồ sơ – upload avatar | `ProfileTab.jsx:207-232` | — | Thiếu | cao |
| 35 | Hồ sơ – hiện/ẩn mật khẩu | `ProfileTab.jsx:416-459` | `profile_tab.dart:264-280` | Thiếu Eye/EyeOff | tb |
| 36 | Hồ sơ – độ dài mật khẩu | `ProfileTab.jsx:150` | `profile_tab.dart:154` | 8 vs 6 ký tự | thấp |
| 37 | Hồ sơ – ảnh CCCD | `ProfileTab.jsx:340-389` | `profile_tab.dart:236-255` | Thiếu preview + trạng thái lưu trữ | tb |
| 38 | Hóa đơn – nút VietQR | `InvoicesTab.jsx:534-609` | `invoices_tab.dart:928-938` | Chỉ Flutter có nút + modal QR | tb |
| 39 | Hóa đơn – lịch sử tín dụng | `InvoicesTab.jsx:462-477` | `invoices_tab.dart:943-1052` | Chỉ Flutter có danh sách hiển thị | tb |
| 40 | Hóa đơn – thẻ hóa đơn | `InvoicesTab.jsx:662-1013` | `invoices_tab.dart:1113-1349` | React thu gọn được, có icon dòng, công thức, ảnh công tơ, lịch sử thanh toán | cao |
| 41 | Hóa đơn – nhãn filter | `InvoicesTab.jsx:618-626` | `invoices_tab.dart:1064-1069` | Viết tắt "Chờ TT", "Đã TT" | tb |
| 42 | Hóa đơn – CTA trên cùng | `InvoicesTab.jsx:493-501` | `invoices_tab.dart:641-779` | Thiếu "Báo đã thanh toán" ở summary | tb |
| 43 | Hóa đơn – modal báo thanh toán | `InvoicesTab.jsx:1039-1110` | `invoices_tab.dart:269-289` | Thiếu chọn HĐ, phương thức, mã tham chiếu, ngày, tối đa 3 ảnh | cao |
| 44 | Hóa đơn – highlight quá hạn | `InvoicesTab.jsx:665-668` | `invoices_tab.dart:1113-1126` | Flutter không tô viền đỏ HĐ quá hạn | tb |
| 45 | Hợp đồng – thẻ tổng | `ContractTab.jsx:708-897` | `contract_tab.dart:506-588` | Thiếu timeline, 6 thông số, CTA gia hạn/chấm dứt | cao |
| 46 | Hợp đồng – lịch sử/phụ lục | `ContractTab.jsx:1390-1577` | — | Thiếu 2 mục | cao |
| 47 | Hợp đồng – quyết toán cọc | `ContractTab.jsx:961-1262` | `contract_tab.dart:670-812` | Thiếu chi tiết các khoản trừ, chứng cứ, tranh chấp | cao |
| 48 | Hợp đồng – thành viên | `ContractTab.jsx:865-896` | `contract_tab.dart:591-667` | Grid điện thoại/email/trạng thái vs danh sách CCCD bị che | tb |
| 49 | Hợp đồng – empty state | `ContractTab.jsx:693-705` | `contract_tab.dart:457-484` | Khác chữ, React có "Xem căn hộ trống" | tb |
| 50 | Hợp đồng – in A4 | `ContractTab.jsx:1731-1777` | `contract_tab.dart:98-120` | React có tải HTML + In/PDF | tb |
| 51 | Hợp đồng – modal yêu cầu | `ContractTab.jsx:1779-1878` | `contract_tab.dart:320-421` | Khác loại yêu cầu, React có ngày mong muốn | tb |
| 52 | Báo hỏng – header/filter | `MaintenanceTab.jsx:418-448,453-461` | `maintenance_tab.dart:464-483` | Thiếu 3 tab lọc | tb |
| 53 | Báo hỏng – thẻ yêu cầu | `MaintenanceTab.jsx:499-765` | `maintenance_tab.dart:515-618` | Thiếu mã tra cứu, 5 badge, vị trí/khung giờ, SLA, ảnh, kỹ thuật viên | cao |
| 54 | Báo hỏng – form tạo | `MaintenanceTab.jsx:789-852` | `maintenance_tab.dart:114-171` | 8 hạng mục/4 mức độ vs 5/3; thiếu vị trí, khung giờ | tb |
| 55 | Báo hỏng – trùng lặp | `MaintenanceTab.jsx:855-922` | — | Thiếu modal 409 DUPLICATE | tb |
| 56 | Báo hỏng – modal chi tiết/lightbox | `MaintenanceTab.jsx:1098-1215` | — | Thiếu | tb |
| 57 | Báo hỏng – mở lại | `MaintenanceTab.jsx:106,409-415` | `maintenance_tab.dart:524` | React dùng `sla_config.reopen_window_days` | tb |
| 58 | Dịch vụ – tiêu đề/layout | `ServicesTab.jsx:393-395,552-555` | `services_tab.dart:345,442` | Grid 2/3 cột vs danh sách 1 cột | cao |
| 59 | Dịch vụ – CTA header | `ServicesTab.jsx:396-402` | `services_tab.dart:344-350` | Thiếu "Đăng ký thêm dịch vụ" | tb |
| 60 | Dịch vụ – thẻ đăng ký | `ServicesTab.jsx:426-501` | `services_tab.dart:361-433` | Thiếu icon danh mục, căn hộ, ngày, tổng tháng | tb |
| 61 | Dịch vụ – lịch sử hủy | `ServicesTab.jsx:506-547` | — | Thiếu toggle | tb |
| 62 | Dịch vụ – catalog | `ServicesTab.jsx:580-642` | `services_tab.dart:450-513` | Thiếu badge danh mục, "Đã đăng ký", "Tính theo chỉ số" | tb |
| 63 | Dịch vụ – modal đăng ký | `ServicesTab.jsx:648-797` | `services_tab.dart:116-243` | Thiếu ngày bắt đầu, ghi chú, breakdown pro-rata | tb |
| 64 | Dịch vụ – modal hủy | `ServicesTab.jsx:903-960` | `services_tab.dart:246-313` | Thiếu ngày kết thúc + pro-rata | tb |
| 65 | Dịch vụ – modal chi tiết | `ServicesTab.jsx:799-901` | — | Thiếu | tb |

---

## 3. Các màn hình còn lại — 28 điểm khác biệt

| # | Khu vực | React (`file:line`) | Flutter (`file:line`) | Khác biệt | Mức |
|---|---|---|---|---|---|
| 1 | Bảo trì – KPI | `ServiceRequestsPage.jsx:770-807` | `service_requests_page.dart:313-351` | 4 chỉ số khác nhau (Quá hạn SLA / Khẩn cấp chỉ có Flutter) | cao |
| 2 | Bảo trì – ảnh khi tạo | `ServiceRequestsPage.jsx:1089-1095,423` | `service_requests_page.dart:1916-2019` | Flutter thiếu field ảnh `images[]` | cao |
| 3 | Sổ cọc – drill-down Dashboard | `DepositsPage.jsx:346-368,405-417` | `deposits_page.dart:25-31,106-137` | Flutter bỏ qua `?tab=payout`, `?overdue=1`, `?status=DISPUTED` → 3 card cảnh báo thành link chết | cao |
| 4 | Cấu hình – ngưỡng chỉ số/nhắc nợ | `SettingsPage.jsx:722,736` | `settings_page.dart:609-664` | Thiếu 2 input | tb |
| 5 | Cấu hình – cửa sổ mở lại | `SettingsPage.jsx:838` | `settings_page.dart:691-717` | Thiếu input | tb |
| 6 | Cấu hình – hotline PCCC | `SettingsPage.jsx:898` | `settings_page.dart:744-770` | Thiếu input | tb |
| 7 | Bảo trì – cột bảng | `ServiceRequestsPage.jsx:589-712` | `service_requests_page.dart:770-846` | Thiếu cột "Phụ trách", "Đánh giá" | tb |
| 8 | Bảo trì – chi tiết | `ServiceRequestsPage.jsx:1379-1456` | `service_requests_page.dart:1254-1310` | Thiếu thời điểm tiếp nhận, hạn SLA, phản hồi đầu | tb |
| 9 | Bảo trì – group Zalo | `ServiceRequestsPage.jsx:1321-1377` | `service_requests_page.dart:1209-1247` | Thiếu link nhóm + preview tin nhắn | tb |
| 10 | Bảo trì – lightbox ảnh | `ServiceRequestsPage.jsx:1814-1830` | `service_requests_page.dart:1292-1307` | Ảnh Flutter không bấm được | tb |
| 11 | Bảo trì – filter | `ServiceRequestsPage.jsx:220-227,855-869` | `service_requests_page.dart:404-506` | React debounce 200ms + nút "Xóa bộ lọc" | tb |
| 12 | Bảo trì – thẻ Kanban | `ServiceRequestsPage.jsx:924-984` | `service_requests_page.dart:628-760` | Thiếu badge AI triage, "Mở lại xN", tên người gửi, sao đánh giá | tb |
| 13 | Bảo trì – trùng lặp | `ServiceRequestsPage.jsx:1104-1132` | `service_requests_page.dart:1866-1913` | React có link mở phiếu cũ; khác flag (`ignore_duplicate_warning` vs `force_duplicate`) | tb |
| 14 | Sổ cọc – KPI | `DepositsPage.jsx:1662-1695` | `deposits_page.dart:243-281` | Bộ 4 KPI khác, Flutter mất subtext/click drill-down | tb |
| 15 | Bảo trì – tiêu đề trang | `ServiceRequestsPage.jsx:725-726` | `service_requests_page.dart:250-252` | Khác tiêu đề & subtitle | tb |
| 16 | Bảo trì – chuyển chế độ | `ServiceRequestsPage.jsx:729-754` | `service_requests_page.dart:258-288` | React nút có chữ, Flutter chỉ icon | tb |
| 17 | Bảo trì – lý do mở lại/hủy | `ServiceRequestsPage.jsx:1466-1475` | `service_requests_page.dart:1136-1395` | Thiếu 2 block hiển thị | tb |
| 18 | Bảo trì – timeline audit | `ServiceRequestsPage.jsx:1770-1808` | `service_requests_page.dart:1347-1393` | Flutter in raw `action`, thiếu map nhãn + chuyển trạng thái | thấp |
| 19 | Bảo trì – nhãn action | `ServiceRequestsPage.jsx:1547,1580,1591` | `service_requests_page.dart:1572,1586,1603` | 3 nhãn khác | thấp |
| 20 | Bảo trì – AI triage | `ServiceRequestsPage.jsx:1206,1302` | `service_requests_page.dart:1435,1524` | Khác wording | thấp |
| 21 | Bảo trì – nút tạo | `ServiceRequestsPage.jsx:762` | `service_requests_page.dart:295-299` | "Tạo yêu cầu hộ cư dân" vs "+ Tiếp nhận yêu cầu" | thấp |
| 22 | Bảo trì – placeholder | `ServiceRequestsPage.jsx:816,905` | `service_requests_page.dart:404,607` | Khác chữ tìm kiếm/empty | thấp |
| 23 | Sổ cọc – tab/tiêu đề | `DepositsPage.jsx:1558-1569,1640-1657` | `deposits_page.dart:204-208,219-237` | Nhiều nhãn đổi; thiếu tab "Chờ chi hoàn" | thấp |
| 24 | Dashboard – subtitle/empty | `DashboardPage.jsx:462-463,512,573,589` | `dashboard_page.dart:385-386,427-428` | Flutter bỏ "(PRD 15.1 & 15.3)", "(RP-01)" và rút gọn chữ | thấp |
| 25 | Thanh toán – màu badge nợ | `PaymentsPage.jsx:70` | `payments_page.dart:64` | Nhóm 31–60 ngày: orange vs indigo | thấp |
| 26 | Thanh toán – header CSV | `PaymentsPage.jsx:524` | `payments_page.dart:630` | Thiếu "(AC-016.1)" | thấp |
| 27 | Đồng hồ – badge OCR | `MeterBatchPhotoImportModal.jsx:68,81,99` | `meter_batch_photo_import_modal.dart:400,404,410` | "Đã lập HĐ"→"Đã khóa HĐ" v.v. | thấp |
| 28 | Định dạng kỳ hiện tại | `format.js:61-72` | `format.dart:103-108` | React ép `Asia/Ho_Chi_Minh`; Flutter dùng giờ máy → lệch trên máy không GMT+7 | thấp |

---

## 4. Ưu tiên xử lý đề xuất

1. **Overview cổng cư dân** — đổi KPI sang đúng 4 chỉ số của React, bỏ `childAspectRatio`, thêm footer, bổ sung hero + 2 card cuối. Đây là lỗi trong ảnh bạn gửi và là khác biệt lớn nhất.
2. **Shell mobile** — thêm horizontal tab strip (<768px) và chỉnh breakpoint switcher 640px.
3. **Contract / Invoices / Maintenance** — bổ sung các trường dữ liệu và action còn thiếu (timeline, lịch sử thanh toán, SLA, ảnh, form báo thanh toán).
4. **Dashboard → Sổ cọc drill-down** — 3 link từ card cảnh báo hiện vô dụng trên Flutter.
5. **Cấu hình** — 4 input thiếu.
6. Còn lại là khác biệt nhãn/màu/layout có thể gom đợt nhỏ.

> Ghi chú: các file đang có thay đổi chưa commit trong worktree (`floor_plan_view.dart`, `resident_shell.dart` phần `SelectionArea`, ...) không bị đụng vào khi audit này.
