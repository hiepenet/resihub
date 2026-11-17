# Đối Soát Giao Diện ReactJS vs Flutter Web bằng Chrome DevTools - Kế Hoạch Triển Khai

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sử dụng Chrome DevTools MCP để thu thập ảnh chụp đối ứng (screenshots), cây ngữ nghĩa (accessibility snapshots) và dữ liệu render thực tế giữa ReactJS (`localhost:3000`) và Flutter Web (`localhost:3001`), thực hiện deep dive tương tác 5 phân hệ phức tạp, và tổng hợp Báo cáo Khác biệt Giao diện (UI Difference Report) toàn diện.

**Architecture:** Tiếp cận theo Chiến lược Hybrid 2-Tier: Tầng 1 (Broad Sweep) tự động duyệt toàn bộ 23 phân hệ trên 2 kích thước Desktop (1440×900) và Mobile (375×812); Tầng 2 (Deep Dive) kiểm tra tương tác phi phá hủy trên 5 phân hệ cốt lõi (Dashboard Charts, FloorPlan Drawer, Four-Eyes Deposits Modal, Meter Batch Modal, Resident Portal Responsive); Tầng 3 tổng hợp và định lượng % tương đồng theo thang điểm 4 trụ cột.

**Tech Stack:** Chrome DevTools MCP (`new_page`, `navigate_page`, `resize_page`, `take_screenshot`, `take_snapshot`, `click`, `fill`, `evaluate_script`), Docker (ReactJS, Flutter Web Nginx/CanvasKit, Express API, PostgreSQL), Markdown & Mermaid Report Artifact.

**Spec:** [docs/superpowers/specs/2026-11-16-react-flutter-devtools-diff-design.md](file:///d:/resihub/docs/superpowers/specs/2026-11-16-react-flutter-devtools-diff-design.md)

## Global Constraints

- ReactJS chạy tại `http://localhost:3000` (Docker container `resihub-frontend`).
- Flutter Web chạy tại `http://localhost:3001` (Docker container `resihub-flutter-web`).
- Backend API chạy tại `http://localhost:5000` (Docker container `resihub-api`, DB connected).
- Tuyệt đối tuân thủ quy tắc kiểm thử tương tác phi phá hủy (Non-Destructive UI Inspection): không thực hiện commit/submit làm biến đổi trạng thái dữ liệu trong database chung.
- Các ảnh chụp được lưu trữ có hệ thống tại thư mục `docs/superpowers/reports/screenshots/` (chia thư mục con `react/` và `flutter/`).
- Đánh giá % tương đồng dựa trên Thang điểm 4 trụ cột (Bố cục 30%, Nhãn & Format 25%, Màu sắc 25%, Tương tác 20%), không dùng pixel diff tự động thô.

## Review Focus

1. **Sai lệch render font/glyph:** CanvasKit của Flutter Web có bị mờ, lệch baseline hoặc sai font so với Inter/Tailwind trên DOM ReactJS không?
2. **Định dạng số tiền VND & ngày tháng:** Các nhãn tiền tệ (`1.500.000 đ` vs `1,500,000 VND`), ngày (`dd/MM/yyyy`) có đồng nhất ở tất cả các thẻ và bảng không?
3. **Màu sắc 6 trạng thái phòng trên FloorPlan:** Màu sắc (Trống, Đang thuê, Giữ chỗ, Bảo trì, Khóa) có khớp mã hex / độ tương phản của ReactJS không?
4. **Hành vi trượt Drawer & bung Modal:** Drawer chi tiết phòng và Modal chi tiết cọc 4 mắt có căn chỉnh lề chính xác, có backdrop mờ và nút đóng hoạt động trơn tru không?
5. **Hiển thị Responsive trên màn hình Mobile (375×812):** Bảng dữ liệu có hỗ trợ cuộn ngang hoặc chuyển sang dạng card view, thanh điều hướng sidebar có tự động thu gọn vào hamburger menu không?

---

### Task 1: Thiết Lập Môi Trường & Thư Mục Lưu Trữ Bằng Chứng

**Files:**
- Create: `docs/superpowers/reports/screenshots/react/.gitkeep`
- Create: `docs/superpowers/reports/screenshots/flutter/.gitkeep`
- Test: Kiểm tra kết nối Chrome DevTools MCP và các cổng dịch vụ 3000, 3001, 5000.

- [ ] 1. Khởi tạo cấu trúc thư mục lưu trữ ảnh chụp màn hình: `docs/superpowers/reports/screenshots/react/` và `docs/superpowers/reports/screenshots/flutter/`.
- [ ] 2. Kiểm tra trạng thái sẵn sàng của 3 dịch vụ HTTP (`curl.exe -I http://localhost:3000`, `http://localhost:3001`, `http://localhost:5000/api/health`).
- [ ] 3. Thực hiện smoke-test khởi động trang với Chrome DevTools MCP (`new_page` trỏ tới `http://localhost:3000` và `http://localhost:3001`) để xác nhận viewport và công cụ hoạt động ổn định.

---

### Task 2: Tier 1 Broad Sweep - Xác Thực & Vận Hành Bất Động Sản (Desktop 1440×900)

**Files:**
- Test: Chrome DevTools MCP chụp ảnh và trích xuất snapshot trên các route Auth và Buildings.

- [ ] 1. **Màn hình Đăng nhập (`/login`):**
  - Mở trang trên ReactJS (`:3000/login`) ở kích thước 1440×900, chụp ảnh `react/01_login_desktop.png`.
  - Mở trang trên Flutter Web (`:3001/#/login` hoặc `:3001/login`), chụp ảnh `flutter/01_login_desktop.png`.
  - Trích xuất snapshot text và đối chiếu panel Showcase bên trái, 6 tài khoản mẫu và các nút đăng nhập OTP.
- [ ] 2. **Màn hình Quên mật khẩu (`/forgot-password`):**
  - Điều hướng tới `/forgot-password` trên cả 2 nền tảng.
  - Chụp ảnh `react/02_forgot_password_desktop.png` và `flutter/02_forgot_password_desktop.png`.
  - So sánh quy trình 2 bước và nút đếm ngược gửi lại OTP.
- [ ] 3. **Bảng điều khiển Vận hành (`/admin/dashboard`):**
  - Đăng nhập tài khoản `admin@resihub.vn` / `Password123!` trên cả 2 nền tảng.
  - Điều hướng đến `/admin/dashboard`, đợi nạp dữ liệu API hoàn tất.
  - Chụp ảnh `react/03_dashboard_desktop.png` và `flutter/03_dashboard_desktop.png`.
  - Ghi nhận so sánh 4 thẻ KPI đầu trang và 7 thẻ cảnh báo Four-Eyes.
- [ ] 4. **Danh sách Tòa nhà (`/admin/buildings`):**
  - Điều hướng tới `/admin/buildings`.
  - Chụp ảnh `react/04_buildings_desktop.png` và `flutter/04_buildings_desktop.png`.
  - So sánh lưới thẻ tòa nhà, tỷ lệ lấp đầy, badge địa chỉ và nút thêm tòa nhà.
- [ ] 5. **Chi tiết Tòa nhà (`/admin/buildings/1` hoặc tòa đầu tiên):**
  - Vào chi tiết tòa nhà đầu tiên, chụp ảnh `react/05_building_detail_desktop.png` và `flutter/05_building_detail_desktop.png`.
  - Kiểm tra 4 tabs: Tổng quan, Sơ đồ tầng, Cư dân, Hợp đồng.
- [ ] 6. **Sơ đồ tầng tổng quan (`/admin/buildings/floor-plan`):**
  - Điều hướng tới `/admin/buildings/floor-plan`.
  - Chụp ảnh `react/06_floor_plan_desktop.png` và `flutter/06_floor_plan_desktop.png`.
  - So sánh ma trận phòng theo tầng, thanh lọc phân khu và thanh chú giải 6 màu trạng thái.

---

### Task 3: Tier 1 Broad Sweep - Hợp Đồng, Tiền Cọc, Hóa Đơn & Kỹ Thuật (Desktop 1440×900)

**Files:**
- Test: Chrome DevTools MCP chụp ảnh và trích xuất snapshot trên các phân hệ Tài chính & Vận hành.

- [ ] 1. **Quản lý Hợp đồng (`/admin/contracts`):**
  - Điều hướng tới `/admin/contracts`.
  - Chụp ảnh `react/07_contracts_desktop.png` và `flutter/07_contracts_desktop.png`.
  - So sánh bảng danh sách hợp đồng, bộ lọc trạng thái, định dạng tiền thuê và cột hành động.
- [ ] 2. **Chi tiết Hợp đồng (`/admin/contracts/1` hoặc bản ghi đầu tiên):**
  - Vào chi tiết hợp đồng, chụp ảnh `react/08_contract_detail_desktop.png` và `flutter/08_contract_detail_desktop.png`.
  - So sánh thông tin các bên, điều khoản thanh toán và file scan đính kèm.
- [ ] 3. **Quản lý Sổ Cọc (`/admin/deposits`):**
  - Điều hướng tới `/admin/deposits`.
  - Chụp ảnh `react/09_deposits_desktop.png` và `flutter/09_deposits_desktop.png`.
  - So sánh các tab trạng thái ("Tất cả", "Chờ duyệt", "Chờ chi hoàn"), danh sách sổ cọc và badge trạng thái.
- [ ] 4. **Hóa Đơn Kỳ (`/admin/invoices`):**
  - Điều hướng tới `/admin/invoices`.
  - Chụp ảnh `react/10_invoices_desktop.png` và `flutter/10_invoices_desktop.png`.
  - So sánh danh sách hóa đơn, phân loại nợ/thanh toán, nút xuất hóa đơn và bộ lọc kỳ.
- [ ] 5. **Thu Tiền & Công Nợ (`/admin/payments`):**
  - Điều hướng tới `/admin/payments`.
  - Chụp ảnh `react/11_payments_desktop.png` và `flutter/11_payments_desktop.png`.
  - So sánh tab Phiếu thu, Sổ công nợ và Tín dụng cư dân.
- [ ] 6. **Chỉ số Điện / Nước (`/admin/meters`):**
  - Điều hướng tới `/admin/meters`.
  - Chụp ảnh `react/12_meters_desktop.png` và `flutter/12_meters_desktop.png`.
  - So sánh bảng nhập chỉ số tháng, tính toán sản lượng điện/nước tiêu thụ và cảnh báo bất thường.
- [ ] 7. **Yêu cầu Báo Hỏng / Bảo trì (`/admin/maintenance`):**
  - Điều hướng tới `/admin/maintenance`.
  - Chụp ảnh `react/13_maintenance_desktop.png` và `flutter/13_maintenance_desktop.png`.
  - So sánh danh sách phiếu bảo trì, mức độ khẩn cấp (Khẩn cấp / Cao / Bình thường) và người phụ trách.

---

### Task 4: Tier 1 Broad Sweep - Cư Dân, Dịch Vụ, Báo Cáo & Quản Trị Hệ Thống (Desktop 1440×900)

**Files:**
- Test: Chrome DevTools MCP chụp ảnh và trích xuất snapshot trên Cư dân, Báo cáo, Quản trị và Cổng cư dân.

- [ ] 1. **Hồ sơ Cư dân (`/admin/tenants`):**
  - Điều hướng tới `/admin/tenants`.
  - Chụp ảnh `react/14_tenants_desktop.png` và `flutter/14_tenants_desktop.png`.
  - So sánh danh sách cư dân, mã ẩn CCCD/SĐT và trạng thái tài khoản.
- [ ] 2. **Dịch vụ & Gói dịch vụ (`/admin/services` & `/admin/subscriptions`):**
  - Điều hướng tới `/admin/services`.
  - Chụp ảnh `react/15_services_desktop.png` và `flutter/15_services_desktop.png`.
  - So sánh danh mục dịch vụ (Điện, Nước, Gửi xe, Thu gom rác, Wifi).
- [ ] 3. **Báo cáo Thống kê (`/admin/reports`):**
  - Điều hướng tới `/admin/reports`.
  - Chụp ảnh `react/16_reports_desktop.png` và `flutter/16_reports_desktop.png`.
  - So sánh báo cáo dòng tiền, báo cáo công nợ và nút xuất Excel/PDF.
- [ ] 4. **Thông báo, Người dùng & Nhật ký Audit (`/admin/notifications`, `/admin/users`, `/admin/audit`):**
  - Chụp ảnh đối chiếu trang Thông báo (`react/17_notifications_desktop.png` vs `flutter/17_...`).
  - Chụp ảnh đối chiếu trang Người dùng (`react/18_users_desktop.png` vs `flutter/18_...`).
  - Chụp ảnh đối chiếu Nhật ký Hệ thống Audit Logs (`react/19_audit_desktop.png` vs `flutter/19_...`).
- [ ] 5. **Cấu hình Hệ thống & Cổng Khám phá (`/admin/settings`, `/explore`):**
  - Chụp ảnh đối chiếu trang Cấu hình (`react/20_settings_desktop.png` vs `flutter/20_...`).
  - Chụp ảnh đối chiếu trang Khám phá căn hộ trống Public Explore (`react/21_explore_desktop.png` vs `flutter/21_...`).
- [ ] 6. **Cổng Cư Dân Resident Portal (`/resident`):**
  - Đăng nhập tài khoản cư dân mẫu (`resident@resihub.vn`).
  - Điều hướng tới `/resident`.
  - Chụp ảnh đối chiếu trang tổng quan Resident Portal (`react/22_resident_portal_desktop.png` vs `flutter/22_...`).
  - Chụp lướt các tab Hợp đồng cư dân, Hóa đơn cư dân, Phiếu báo hỏng.

---

### Task 5: Tier 1 Broad Sweep - Kiểm Tra Responsive Mobile (Viewport 375×812)

**Files:**
- Test: Chrome DevTools MCP thay đổi viewport sang 375×812 và chụp ảnh các view tiêu biểu.

- [ ] 1. Thiết lập DevTools viewport `resize_page` thành 375×812 (tỷ lệ iPhone X / tiêu chuẩn Mobile).
- [ ] 2. **Mobile Login:** Chụp ảnh `react/m01_login_mobile.png` và `flutter/m01_login_mobile.png`. So sánh việc ẩn/hiện cột Showcase và layout form.
- [ ] 3. **Mobile Dashboard:** Chụp ảnh `react/m02_dashboard_mobile.png` và `flutter/m02_dashboard_mobile.png`. So sánh thu gọn sidebar thành Drawer/Hamburger, xếp chồng 4 KPI cards theo chiều dọc.
- [ ] 4. **Mobile FloorPlan:** Chụp ảnh `react/m03_floor_plan_mobile.png` và `flutter/m03_floor_plan_mobile.png`. So sánh thanh cuộn ngang lưới tầng và kích thước thẻ phòng.
- [ ] 5. **Mobile Invoices / Payments:** Chụp ảnh `react/m04_invoices_mobile.png` và `flutter/m04_invoices_mobile.png`. So sánh cách bảng dữ liệu chuyển sang dạng danh thiếp (Card view) trên màn hình hẹp.
- [ ] 6. **Mobile Resident Portal:** Chụp ảnh `react/m05_resident_mobile.png` và `flutter/m05_resident_mobile.png`. So sánh thanh điều hướng dưới đáy (Bottom Navigation) hoặc menu vuốt chạm.

---

### Task 6: Tier 2 Interactive Deep Dive - Kiểm Tra Tương Tác 5 Phân Hệ Trọng Yếu

**Files:**
- Test: Chrome DevTools MCP mô phỏng click, hover, form input và mở Modal/Drawer phi phá hủy.

- [ ] 1. **Deep Dive 1 - Dashboard & Biểu đồ thống kê:**
  - Trên màn hình Desktop, click nút chuyển đổi loại biểu đồ (từ Line sang Stacked Bar).
  - Hover chuột qua các cột doanh thu/công nợ để kích hoạt tooltip hiển thị số tiền VND.
  - Chụp ảnh so sánh trạng thái biểu đồ và tooltip giữa ReactJS và Flutter Web (`deepdive_01_charts.png`).
- [ ] 2. **Deep Dive 2 - Sơ đồ tầng & Drawer Chi tiết phòng:**
  - Tại `/admin/buildings/floor-plan`, click vào 1 thẻ căn hộ (ví dụ: căn P.201 hoặc căn bất kỳ đang có người ở).
  - Kiểm tra hiệu ứng mở Drawer từ cạnh phải màn hình.
  - Chụp ảnh so sánh nội dung chi tiết phòng, thông tin người thuê, lịch sử chỉ số điện nước và các nút thao tác nhanh ("Báo hỏng", "Đặt giữ chỗ") (`deepdive_02_floorplan_drawer.png`).
  - Bấm nút đóng (x) hoặc click ra ngoài backdrop để đóng Drawer an toàn.
- [ ] 3. **Deep Dive 3 - Sổ cọc & Four-Eyes Modal:**
  - Tại `/admin/deposits`, click vào 1 sổ cọc có trạng thái "Chờ duyệt" hoặc sổ cọc bất kỳ để mở Modal chi tiết cọc.
  - Chụp ảnh so sánh Modal chi tiết cọc (`deepdive_03_deposit_modal.png`): cấu trúc 2 cột, timeline duyệt 4 mắt, chứng từ UNC đính kèm, các nút hành động (Phê duyệt, Từ chối, Yêu cầu điều chỉnh).
  - Đóng Modal an toàn mà không bấm gửi form.
- [ ] 4. **Deep Dive 4 - Ghi chỉ số Điện / Nước & Modal Nhập theo lô:**
  - Tại `/admin/meters`, bấm nút "Nhập theo lô ảnh" (Batch Photo Import).
  - Kiểm tra Drawer/Modal mở ra, hiển thị bảng nhập chỉ số hàng loạt theo phòng.
  - Chụp ảnh so sánh (`deepdive_04_meter_batch.png`).
  - Đóng Modal an toàn.
- [ ] 5. **Deep Dive 5 - Cổng Cư Dân (Resident Portal Walkthrough):**
  - Chuyển tuần tự qua các tab: "Tổng quan" -> "Hóa đơn" -> "Báo hỏng".
  - Click thử nút "Tạo yêu cầu báo hỏng mới" để mở form báo sự cố (chọn loại sự cố, nhập mô tả, đính kèm ảnh).
  - Chụp ảnh so sánh giao diện form báo hỏng của cư dân (`deepdive_05_resident_request.png`).
  - Đóng form báo hỏng an toàn.

---

### Task 7: Phân Tích, Định Lượng & Xuất Báo Cáo Khác Biệt (UI Difference Report)

**Files:**
- Create: `docs/superpowers/reports/2026-11-16-ui-diff-report.md`
- Create Artifact: Báo cáo tương tác cho người dùng.

- [ ] 1. Tổng hợp toàn bộ bằng chứng ảnh chụp (Desktop & Mobile) và snapshot ngữ nghĩa thu thập được từ Task 2 - Task 6.
- [ ] 2. Đánh giá chấm điểm theo Thang 4 trụ cột:
  - *Trụ cột 1: Bố cục & Căn chỉnh (Layout & Proportion - Trọng số 30%)*
  - *Trụ cột 2: Nhãn & Định dạng dữ liệu (Copy & Data Formatting - Trọng số 25%)*
  - *Trụ cột 3: Hệ màu sắc & Trạng thái (Colors & Status Badges - Trọng số 25%)*
  - *Trụ cột 4: Trải nghiệm & Tương tác (UX & Responsive - Trọng số 20%)*
  - Tính toán điểm số % tương đồng tổng thể (Overall Similarity Score).
- [ ] 3. Lập Bảng Ma trận Đối Soát Chi Tiết 23 Phân Hệ (Đánh giá từng phân hệ: Khớp 1-1 / Lệch nhẹ / Cần tinh chỉnh).
- [ ] 4. Phân tích các đặc thù kỹ thuật của engine:
  - So sánh thời gian tải trang ban đầu (Initial Bundle / Engine boot: React Vite vs Flutter CanvasKit Wasm).
  - Độ sắc nét của font chữ và độ mượt khi cuộn trang (Scroll behavior).
  - Khả năng bôi đen chọn văn bản và thao tác chuột phải (Text selection & native browser context menu).
- [ ] 5. Soạn thảo danh sách khuyến nghị tinh chỉnh (Action Items & Fixes): Phân loại lỗi theo mức độ ưu tiên (High / Medium / Low) kèm file code cần sửa trong `flutter_resihub/`.
- [ ] 6. Xuất bản tài liệu `docs/superpowers/reports/2026-11-16-ui-diff-report.md`, tạo Artifact tổng kết và trình bày kết quả cho người dùng.
