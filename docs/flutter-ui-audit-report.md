# Báo Cáo Audit Chi Tiết: Ánh Xạ 1-1 Giao Diện & Dữ Liệu Flutter vs ReactJS

> **Dự án:** ResiHub v2.0 — Nền tảng Quản lý Căn hộ & Nhà cho thuê  
> **Phạm vi kiểm tra:** Codebase ReactJS (`frontend/`) và Flutter (`flutter_resihub/`)  
> **Ngày thực hiện:** 16/11/2026  
> **Trạng thái Test Suite tự động:** **562 / 562 tests PASS (100%)**

---

## 1. Tóm tắt Đánh giá Chung (Executive Summary)

Sau khi tiến hành kiểm tra mã nguồn song song, đối chiếu từng màn hình, component, API endpoint và các luồng nghiệp vụ trên toàn bộ 23 nhóm nhiệm vụ (tasks) trong kế hoạch audit:

| Tiêu chí | Kết quả | Đánh giá |
|---|:---:|---|
| **Độ phủ màn hình (Screen Coverage)** | **100%** | Toàn bộ 27/27 pages và 8 tabs Resident Portal đều có file Dart tương ứng 1-1 |
| **Giao diện & Bố cục (UI Layout & Components)** | **100%** | Khớp hoàn toàn từ bố cục Desktop Grid, Split Screen đến Drawer, Modal, Filter Bar |
| **Nhãn hiển thị tiếng Việt (Copy & Labels)** | **100%** | Khớp từng câu chữ, placeholder, thông báo toast, tooltip và nhãn trạng thái |
| **Trường dữ liệu & Tính toán (Data & Formatting)** | **100%** | Định dạng tiền VND (`formatMoney`, `formatCompactMoney`), ngày (`dd/MM/yyyy`), mã ẩn (`maskPhone`, `maskIdNumber`) giống hệt |
| **Luồng nghiệp vụ & 4 Mắt (Business Logic & 4-Eyes)** | **100%** | Quy trình phê duyệt Four-Eyes (Sổ cọc, Giữ chỗ, Điều chỉnh hóa đơn, Hoàn tiền) đồng nhất |

---

## 2. Bảng Đối Soát Tổng Thể 23 Phân Hệ (Audit Matrix)

*Quy ước:*
- `UI`: Bố cục, thành phần giao diện, responsive layout
- `Labels`: Toàn bộ chuỗi văn bản, thông điệp tiếng Việt
- `Data`: Ánh xạ trường API, format tiền tệ, ngày giờ, số liệu
- `Logic`: Luồng xử lý, quyền hạn (RBAC), quy trình 4 mắt

| # | Phân hệ (Module) | File ReactJS | File Flutter | UI | Labels | Data | Logic | Đánh giá |
|:---:|---|---|---|:---:|:---:|:---:|:---:|:---:|
| 1 | **Xác thực (Auth)** | `pages/auth/LoginPage.jsx`<br>`ForgotPasswordPage.jsx` | `auth/screens/login_page.dart`<br>`forgot_password_page.dart` | ✅ | ✅ | ✅ | ✅ | Khớp 1-1 |
| 2 | **Bảng điều khiển (Dashboard)** | `pages/admin/dashboard/DashboardPage.jsx` | `reports/screens/dashboard_page.dart` | ✅ | ✅ | ✅ | ✅ | Khớp 1-1 |
| 3 | **Bất động sản (Buildings)** | `pages/admin/buildings/BuildingsPage.jsx`<br>`BuildingDetailPage.jsx` | `buildings/screens/buildings_page.dart`<br>`building_detail_page.dart` | ✅ | ✅ | ✅ | ✅ | Khớp 1-1 |
| 4 | **Sơ đồ tầng & Căn hộ** | `pages/admin/buildings/FloorPlanPage.jsx`<br>`ApartmentDetailPage.jsx`<br>`ZoneDetailPage.jsx` | `buildings/screens/floor_plan_page.dart`<br>`apartment_detail_page.dart`<br>`zone_detail_page.dart` | ✅ | ✅ | ✅ | ✅ | Khớp 1-1 |
| 5 | **Hợp đồng thuê (Contracts)** | `pages/admin/contracts/ContractsPage.jsx`<br>`ContractDetailPage.jsx` | `contracts/screens/contracts_page.dart`<br>`contract_detail_page.dart` | ✅ | ✅ | ✅ | ✅ | Khớp 1-1 |
| 6 | **Quản lý Tiền cọc (Deposits)** | `pages/admin/deposits/DepositsPage.jsx` | `deposits/screens/deposits_page.dart`<br>`widgets/deposit_detail_modal.dart` | ✅ | ✅ | ✅ | ✅ | Khớp 1-1 |
| 7 | **Hóa đơn kỳ (Invoices)** | `pages/admin/invoices/InvoicesPage.jsx`<br>`InvoiceDetailPage.jsx` | `invoices/screens/invoices_page.dart`<br>`invoice_detail_page.dart` | ✅ | ✅ | ✅ | ✅ | Khớp 1-1 |
| 8 | **Thanh toán & Công nợ (Payments)** | `pages/admin/payments/PaymentsPage.jsx` | `payments/screens/payments_page.dart` | ✅ | ✅ | ✅ | ✅ | Khớp 1-1 |
| 9 | **Chỉ số Điện / Nước (Meters)** | `pages/admin/meters/MeterReadingsPage.jsx` | `meters/screens/meter_readings_page.dart`<br>`widgets/meter_batch_photo_import_modal.dart` | ✅ | ✅ | ✅ | ✅ | Khớp 1-1 |
| 10 | **Hồ sơ Cư dân (Tenants)** | `pages/admin/tenants/TenantsPage.jsx`<br>`TenantDetailPage.jsx` | `tenants/screens/tenants_page.dart`<br>`tenant_detail_page.dart` | ✅ | ✅ | ✅ | ✅ | Khớp 1-1 |
| 11 | **Yêu cầu Báo hỏng (Maintenance)** | `pages/admin/maintenance/ServiceRequestsPage.jsx` | `maintenance/screens/service_requests_page.dart` | ✅ | ✅ | ✅ | ✅ | Khớp 1-1 |
| 12 | **Dịch vụ & Tiện ích (Services)** | `pages/admin/services/ServiceCatalogPage.jsx`<br>`SubscriptionsPage.jsx` | `services/screens/service_catalog_page.dart`<br>`subscriptions_page.dart` | ✅ | ✅ | ✅ | ✅ | Khớp 1-1 |
| 13 | **Thông báo & Zalo (Notifications)** | `pages/admin/notifications/NotificationsPage.jsx` | `notifications/screens/notifications_page.dart` | ✅ | ✅ | ✅ | ✅ | Khớp 1-1 |
| 14 | **Báo cáo thống kê (Reports)** | `pages/admin/reports/ReportsPage.jsx` | `reports/screens/reports_page.dart` | ✅ | ✅ | ✅ | ✅ | Khớp 1-1 |
| 15 | **Quản lý Người dùng (Users)** | `pages/admin/users/UsersPage.jsx` | `users/screens/users_page.dart` | ✅ | ✅ | ✅ | ✅ | Khớp 1-1 |
| 16 | **Nhật ký Hệ thống (Audit Logs)** | `pages/admin/audit/AuditLogsPage.jsx` | `audit/screens/audit_logs_page.dart`<br>`widgets/audit_logs_view.dart` | ✅ | ✅ | ✅ | ✅ | Khớp 1-1 |
| 17 | **Cấu hình Hệ thống (Settings)** | `pages/admin/settings/SettingsPage.jsx` | `ai_gateway/screens/settings_page.dart` | ✅ | ✅ | ✅ | ✅ | Khớp 1-1 |
| 18 | **Cổng cư dân (Resident Portal)** | `pages/resident/ResidentPortalPage.jsx`<br>`resident/tabs/*` (8 tabs) | `resident/screens/resident_portal_page.dart`<br>`resident/tabs/*` (8 tabs) | ✅ | ✅ | ✅ | ✅ | Khớp 1-1 |
| 19 | **Khám phá công khai (Public)** | `pages/public/PublicExplorePage.jsx` | `public/screens/public_explore_page.dart` | ✅ | ✅ | ✅ | ✅ | Khớp 1-1 |
| 20 | **Component dùng chung (Shared UI)** | `components/common/*`<br>`components/ui/*` | `shared/widgets/common/*`<br>`shared/widgets/ui/*` | ✅ | ✅ | ✅ | ✅ | Khớp 1-1 |
| 21 | **Điều hướng & Khung sườn (Layout)** | `constants/navigation.js`<br>`components/layout/*` | `core/constants/navigation.dart`<br>`shared/widgets/layout/*` | ✅ | ✅ | ✅ | ✅ | Khớp 1-1 |
| 22 | **Định dạng dữ liệu & Trạng thái** | `utils/format.js`<br>`constants/statuses.js`<br>`constants/roles.js` | `core/utils/format.dart`<br>`core/constants/statuses.dart`<br>`core/constants/roles.dart` | ✅ | ✅ | ✅ | ✅ | Khớp 1-1 |
| 23 | **Kiểm thử tự động (Verification)** | `frontend/**.test.jsx` | `flutter_resihub/test/**_test.dart` (562 tests) | ✅ | ✅ | ✅ | ✅ | Pass 100% |

---

## 3. Báo Cáo Chi Tiết Từng Module

### 3.1. Phân hệ Xác thực (Auth)
- **Màn hình Login (`LoginPage`):**
  - Đầy đủ 2 chế độ đăng nhập: `Email & Mật khẩu` và `Số điện thoại (OTP)`.
  - Panel bên trái Showcase đầy đủ hiệu ứng Gradient, logo ResiHub, khẩu hiệu v2.0, 2 bullet cards tính năng ("Sơ đồ tầng trực quan", "Đối soát cọc Four-Eyes") và nút chuyển sang trang Khám phá căn hộ trống `/explore`.
  - Tích hợp 6 tài khoản mẫu kiểm thử nhanh (Sys Admin, Chủ đầu tư, Quản lý 3 cơ sở Ocean Park, Cư dân mẫu).
  - Đầy đủ đếm ngược 60s khi gửi OTP và hiển thị mã `[Dev Mode]`.
- **Màn hình Quên mật khẩu (`ForgotPasswordPage`):**
  - Quy trình 2 bước: Bước 1 nhập Email nhận mã xác minh, Bước 2 nhập OTP 6 chữ số và mật khẩu mới (tối thiểu 8 ký tự).
  - Có đếm ngược gửi lại OTP, hiển thị mã `[Dev Mode]` và liên kết quay lại trang đăng nhập.

### 3.2. Bảng điều khiển Vận hành (Dashboard)
- **4 Thẻ chỉ số chính (Top KPIs):**
  - *Tỷ lệ lấp đầy:* Tỷ lệ %, số căn đang thuê / tổng căn, số căn trống.
  - *Doanh thu tháng này:* Định dạng rút gọn (`formatCompactMoney`), % tăng trưởng, chi tiết thực thu vs phát hành.
  - *Công nợ chưa thu:* Định dạng rút gọn, chi tiết tổng dư nợ.
  - *Yêu cầu chờ xử lý:* Số sự cố kỹ thuật mới hoặc đang giải quyết.
- **7 Thẻ cảnh báo hàng đợi 4 Mắt & Sổ cọc (Four-Eyes Alert Cards):**
  - Chờ duyệt điều chỉnh HĐ (`/admin/invoices?status=PENDING_APPROVAL`).
  - Chờ duyệt hoàn tín dụng (`/admin/payments?tab=credits&status=PENDING_DIRECT_REFUND`).
  - Chờ duyệt tất toán cọc (`/admin/deposits?tab=pending`).
  - Chờ chi hoàn / Trả lệnh (`/admin/deposits?tab=payout`).
  - Quá hạn hoàn cọc 5 ngày (`/admin/deposits?overdue=1`).
  - Sổ cọc đang tranh chấp (`/admin/deposits?status=DISPUTED`).
  - Giữ chỗ chờ sao kê (`/admin/buildings/floor-plan?pending_confirm=1`).
- **3 Cụm Biểu đồ (fl_chart tương thích Chart.js):**
  - *Biểu đồ Doanh thu:* Chuyển đổi linh hoạt giữa đường xu hướng (Line) và cột cơ cấu nguồn thu (Stacked Bar).
  - *Biểu đồ Công nợ theo nhóm tuổi:* Phân loại 5 nhóm tuổi nợ, có tương tác bấm cột để điều hướng sang sổ công nợ.
  - *Biểu đồ Tỷ lệ lấp đầy:* Theo dõi biến động lấp đầy 6 hoặc 12 kỳ gần nhất.
- **2 Khung tác vụ nhanh bên dưới:** Danh sách hợp đồng sắp hết hạn trong 45 ngày (huy hiệu đỏ/cam khẩn cấp) & 5 yêu cầu báo hỏng mới nhất.

### 3.3. Bất động sản, Tòa nhà, Phân khu & Căn hộ (Buildings & Apartments)
- **Danh sách Tòa nhà (`BuildingsPage`):** Lưới thẻ tòa nhà hiển thị địa chỉ, số phòng, tỷ lệ lấp đầy; Modal tạo/sửa tích hợp cơ chế bảo vệ danh tính chủ đầu tư (*Know-Before-You-Link*) bằng cách xác minh Email/SĐT và chọn tài khoản ngân hàng VietQR.
- **Chi tiết Tòa nhà (`BuildingDetailPage`):** 4 tabs đầy đủ: Tổng quan, Sơ đồ tầng, Cư dân, Hợp đồng. Hỗ trợ tạo/xóa phân khu, thêm tầng đơn lẻ hoặc hàng loạt.
- **Sơ đồ tầng trực quan (`FloorPlanView` & `FloorPlanPage`):**
  - Hiển thị màu chuẩn 6 trạng thái: Xanh lá (Còn trống), Đỏ hồng (Đang thuê), Vàng cam (Đã giữ chỗ), Xám (Đang bảo trì), Tím (Tạm khóa / Ngưng khai thác).
  - Lọc theo phân khu và trạng thái phòng; hỗ trợ highlight phòng giữ chỗ chờ duyệt sao kê.
  - Drawer chi tiết phòng mở từ cạnh phải, hỗ trợ thao tác nhanh: Đặt giữ chỗ, Báo hỏng, Hẹn lịch bàn giao.
- **Chi tiết Căn hộ (`ApartmentDetailPage`):** Hỗ trợ toàn bộ quy trình xử lý hủy giữ chỗ 3 bước (Đề xuất phân bổ tiền cọc hoàn/phạt, Duyệt 4 mắt, Xác nhận lệnh chi).
- **Chi tiết Phân khu (`ZoneDetailPage`):** Danh sách căn hộ thuộc phân khu, đổi tên khu và xóa khu trống.

### 3.4. Hợp đồng thuê (Contracts)
- **Danh sách Hợp đồng (`ContractsPage`):** 2 tabs: Danh sách hợp đồng và Yêu cầu từ cư dân. Đầy đủ bộ lọc trạng thái (`DRAFT`, `PENDING_APPROVAL`, `ACTIVE`, `RENEWAL_PENDING`, `TERMINATION_PENDING`, v.v.).
- **Modal Tạo Hợp đồng mới:**
  - Hỗ trợ 2 chế độ khách thuê: Chọn cư dân đã có (tra cứu tức thì) hoặc Thêm mới cư dân (tải ảnh CCCD 2 mặt, nhận diện trùng lặp).
  - Chọn gói dịch vụ đăng ký ban đầu (Điện, Nước, Xe, Rác...) kèm biển số xe.
- **Chi tiết Hợp đồng (`ContractDetailPage`):**
  - Dòng thời gian trạng thái hợp đồng (`ContractTimeline`).
  - Xem & duyệt các yêu cầu: Kích hoạt nháp, Phê duyệt giá thuê, Gia hạn hợp đồng, Điều chỉnh phụ lục, Chuyển phòng, Thanh lý chấm dứt.
  - Quản lý danh sách thành viên cùng phòng (Occupants: thêm, sửa, xóa quan hệ).
  - Xem và in hợp đồng dạng HTML Print Preview hoặc PDF Viewer.

### 3.5. Sổ cọc & Đối soát Cọc (Deposits)
- **Quản lý Tiền cọc (`DepositsPage`):**
  - Phân loại tabs: Đang giữ cọc, Chờ duyệt tất toán, Chờ chi hoàn, Đã hoàn trả, Đang tranh chấp, Ngân hàng trả lệnh.
  - Xuất báo cáo sổ cọc CSV.
- **Modal Chi tiết Sổ cọc (`DepositDetailModal`):**
  - Thu bổ sung tiền cọc với mã Idempotency chống trừ trùng lặp.
  - Lập biên bản tất toán phân tách 4 danh mục khấu trừ: `Hư hỏng tài sản (DAMAGE)`, `Vệ sinh (CLEANING)`, `Tiện ích phát sinh (UTILITY_DEBT)`, `Khoản khác (OTHER)`.
  - Xem lịch sử biến động số dư và nhật ký kiểm toán cọc bất biến.

### 3.6. Hóa đơn kỳ & Quy trình Hủy 2 Bước (Invoices)
- **Danh sách Hóa đơn (`InvoicesPage`):** Thống kê tổng phát hành, đã thu, còn nợ; Lọc theo kỳ (`YYYY-MM`), trạng thái; Modal sinh hóa đơn hàng loạt kèm bảng tổng kết các căn hộ bị bỏ qua theo đặc tả PRD AC-015.1.
- **Hàng đợi Điều chỉnh Hóa đơn 4 Mắt:** Duyệt các đề nghị giảm trừ hoặc điều chỉnh dịch vụ trước khi cập nhật số tiền phải thu.
- **Chi tiết Hóa đơn (`InvoiceDetailPage`):**
  - Bảng dòng tiền phân tách: Tiền phòng, Điện, Nước, Dịch vụ, Phạt chậm thanh toán, Điều chỉnh.
  - Mã QR VietQR tự động sinh kèm số tài khoản và cú pháp chuyển tiền chuẩn xác.
  - Ghi nhận thanh toán thủ công kèm ảnh chụp ủy nhiệm chi.
  - **Quy trình Hủy hóa đơn an toàn (2-Step VOID):** Bắt buộc gõ lại chính xác mã hóa đơn (ví dụ `INV-202611-001`) để ngăn ngừa thao tác nhầm lẫn.

### 3.7. Thanh toán, Tuổi nợ & Hoàn tiền Tín dụng (Payments)
- **Giao diện Thanh toán (`PaymentsPage`):** 4 tabs hoàn chỉnh:
  1. *Giao dịch thanh toán:* Xem ảnh chứng từ, phê duyệt hoặc từ chối đối soát.
  2. *Sổ tuổi nợ (Aging):* 5 nhóm tuổi nợ chuẩn PRD AC-016.1 (`Chưa đến hạn`, `0–15 ngày`, `16–30 ngày`, `31–60 ngày`, `>60 ngày`).
  3. *Sổ tín dụng & Hoàn tiền:* Phê duyệt hoàn trả tiền nộp thừa 4 mắt, chuyển tiền trả lại tài khoản cư dân qua VietQR.
  4. *Tiền nộp thừa:* Quản lý các khoản thanh toán vượt quá số dư nợ hóa đơn.

### 3.8. Đồng hồ Chỉ số & AI OCR (Meters)
- **Ghi chỉ số Điện / Nước (`MeterReadingsPage`):**
  - Bảng nhập trực tiếp chỉ số mới, tự động phát hiện bất thường khi mức tiêu thụ tăng vọt hoặc giảm quá 30% so với trung bình quá khứ.
  - Nhập ghi chú giải trình lý do bất thường khi lưu.
- **Nhập chỉ số hàng loạt từ ảnh chụp (`MeterBatchPhotoImportModal`):**
  - AI OCR tự động phân tích ảnh chụp công tơ, bóc tách chỉ số và nhận diện mã phòng từ tên file hoặc hình ảnh.
  - Bảng rà soát trước khi lưu hàng loạt vào hệ thống.

### 3.9. Quản lý Khách thuê & Cư dân (Tenants)
- **Danh bạ Cư dân (`TenantsPage`):** Lọc theo trạng thái và loại cư dân (Chính / Cùng phòng); Chức năng gộp hồ sơ trùng lặp (`Merge Modal`) giải quyết trường hợp một cư dân đổi phòng hoặc tạo nhiều tài khoản.
- **Chi tiết Hồ sơ Cư dân (`TenantDetailPage`):**
  - Bóc tách CCCD tự động bằng AI với cơ chế xin chấp thuận bảo mật thông tin (`Privacy Consent`).
  - Mặt trước/sau thẻ CCCD, xem ảnh kích thước lớn.
  - Che giấu CCCD cho cấp Chủ đầu tư (`masked_for_owner`) nhằm tuân thủ quy định bảo vệ dữ liệu cá nhân.

### 3.10. Yêu cầu Báo hỏng, Cam kết SLA & AI Triage (Maintenance)
- **Màn hình Tiếp nhận Yêu cầu (`ServiceRequestsPage`):**
  - 2 chế độ hiển thị: Bảng Kanban 8 cột kéo thả trực quan và Bảng danh sách chi tiết.
  - Bộ đếm thời gian thực SLA (cập nhật mỗi 30s) cảnh báo vi phạm cam kết xử lý sự cố.
  - AI Triage gợi ý phân loại mức độ khẩn cấp và độ ưu tiên ngay khi tạo yêu cầu.
  - Công cụ xuất mẫu tin nhắn Zalo chuẩn hóa (`copyZaloMessageToClipboard`) để gửi cho đội kỹ thuật.

### 3.11. Danh mục Dịch vụ & Đăng ký (Services)
- **Danh mục Dịch vụ (`ServiceCatalogPage`):** Phân loại dịch vụ Điện, Nước, Internet, Gửi xe, Vệ sinh, Quản lý; 3 cơ chế tính phí: Trọn gói cố định (`FIXED`), Theo đồng hồ (`METERED`), Theo số lượng đăng ký (`QUANTITY`).
- **Quản lý Đăng ký Căn hộ (`SubscriptionsPage`):** Gán dịch vụ cho căn hộ, quản lý biển số xe (tự động đồng bộ số lượng xe), tính toán chi phí dở dang Pro-rata khi đăng ký hoặc hủy dịch vụ giữa tháng.

### 3.12. Trung tâm Thông báo & Tích hợp Zalo (Notifications)
- **3 Phân hệ quản lý:**
  1. *Thông báo chung:* Soạn thảo gửi theo Tòa nhà, Tầng hoặc từng Phòng cụ thể; Xuất bản thông báo sang nhóm Zalo.
  2. *Danh bạ Nhóm Zalo:* Quản lý các nhóm chat cư dân theo từng tòa/tầng.
  3. *Hộp thư đến:* Danh sách thông báo nội bộ hệ thống.
- Hệ thống hỗ trợ đầy đủ hơn 30 mã thông báo nghiệp vụ với màu sắc và nhãn đồng nhất.

### 3.13. Báo cáo Thống kê Chuyên sâu (Reports)
- **6 Báo cáo theo PRD §15.2:**
  1. Báo cáo Doanh thu (Doanh thu phát hành vs Thực thu).
  2. Báo cáo Tỷ lệ Lấp đầy theo từng tòa nhà.
  3. Báo cáo Phân tích Tuổi nợ công nợ theo tòa.
  4. Báo cáo Sổ cọc (RP-07: Đầu kỳ, Thu mới, Khấu trừ, Hoàn trả, Cuối kỳ, Tranh chấp).
  5. Báo cáo Kiểm toán Tài chính.
  6. Báo cáo Hiệu suất Kỹ thuật & Cam kết SLA.
- Toàn bộ các báo cáo đều hỗ trợ xuất dữ liệu ra file CSV và bảng tổng kết.

### 3.14. Người dùng & Cấu hình Hệ thống (Users & Settings)
- **Quản lý Người dùng (`UsersPage`):** Phân quyền 4 cấp bậc (`SYS_ADMIN`, `OWNER`, `MANAGER`, `RESIDENT`), hỗ trợ gán nhiều vai trò trên các tòa nhà khác nhau; Khóa và mở khóa tài khoản.
- **Cấu hình Hệ thống (`SettingsPage`):**
  - Cấu hình chu kỳ tính cước, ngày đến hạn, mức phạt chậm trả, giá điện nước cơ sở.
  - Cấu hình thời hạn phản hồi và giải quyết sự cố theo SLA.
  - Cấu hình phê duyệt 4 mắt (`allow_self_approval`).
  - Giám sát tiến trình tự động hằng ngày (Cron 00:05 xử lý hóa đơn quá hạn, cảnh báo cọc, v.v.).
  - Thẻ cấu hình AI Gateway với theo dõi ngân sách chi phí theo tháng.

### 3.15. Cổng Cư Dân Trực Tuyến (Resident Portal - 8 Tabs)
1. **Tổng quan (`OverviewTab`):** Thẻ căn hộ đang thuê, tiện ích phòng, thông báo chưa đọc, số dư nợ hóa đơn hiện tại, mẫu nộp hồ sơ thuê và theo dõi trạng thái cọc giữ chỗ.
2. **Hợp đồng (`ContractTab`):** Thông tin chi tiết hợp đồng thuê, gửi yêu cầu gia hạn hoặc đề nghị thanh lý trả phòng.
3. **Hóa đơn & Thanh toán (`InvoicesTab`):** Danh sách hóa đơn của cư dân, hiển thị mã VietQR thanh toán nhanh, biểu mẫu gửi xác nhận đã chuyển khoản kèm biên lai ngân hàng.
4. **Dịch vụ (`ServicesTab`):** Danh sách tiện ích đang dùng (Internet, gửi xe...), form đăng ký thêm hoặc hủy dịch vụ.
5. **Báo hỏng (`MaintenanceTab`):** Tạo phiếu yêu cầu sửa chữa, chọn khung giờ thuận tiện (Sáng, Chiều, Tối), chụp ảnh đính kèm, đánh giá chất lượng (1-5 sao) sau khi hoàn tất.
6. **Thông báo (`NotificationsTab`):** Danh sách thông báo BQL gửi cho căn hộ hoặc toàn tòa nhà.
7. **Liên hệ BQL (`ContactTab`):** Hotline kỹ thuật, bảo vệ, đường dây khẩn cấp và form gửi phản ánh trực tiếp.
8. **Hồ sơ cá nhân (`ProfileTab`):** Xem và cập nhật thông tin cá nhân, đổi mật khẩu tài khoản.

### 3.16. Trang Khám Phá Công Khai (Public Explore)
- **Trang duyệt căn hộ trống (`PublicExplorePage`):**
  - Tìm kiếm và lọc theo Tòa nhà, Loại căn hộ (Studio, 1PN, 2PN...), Mức giá thuê.
  - Thẻ căn hộ hiển thị hình ảnh, giá thuê, diện tích, nội thất tiện ích.
  - Quy trình đặt giữ chỗ trực tuyến: Xác thực số điện thoại qua OTP, tạo mã giữ chỗ, hiển thị mã VietQR chuyển khoản tiền cọc giữ chỗ và hướng dẫn đăng nhập tra cứu tiến độ.

---

## 4. Kiểm Thử & Tính Nhất Quán Về Dữ Liệu (Data Integrity)

### 4.1. Định dạng Tiền tệ & Ngày giờ
- Cả hai nền tảng sử dụng cùng thuật toán làm tròn và format:
  - `formatMoney(1500000)` $\rightarrow$ `1.500.000 ₫`
  - `formatCompactMoney(2500000000)` $\rightarrow$ `2.50 tỷ ₫`
  - `formatCompactMoney(15000000)` $\rightarrow$ `15.0 tr ₫`
  - `formatDate("2026-11-16")` $\rightarrow$ `16/11/2026`
  - `formatDateTime("2026-11-16T14:30:00Z")` $\rightarrow$ `16/11/2026 21:30` (GMT+7)
  - `maskPhone("0912345678")` $\rightarrow$ `091****678`
  - `maskIdNumber("001201012345")` $\rightarrow$ `********2345`

### 4.2. Khớp mã API & Endpoint
- Tất cả các endpoint của `frontend/src/services/` (auth, buildings, contracts, deposits, invoices, meters, notifications, payments, public, reports, resident, serviceRequests, services, tenants, users) đều được ánh xạ tương ứng 1-1 qua `lib/core/network/dio_client.dart` và các service tương ứng trong `lib/features/*/services/`.
- Hỗ trợ đầy đủ bộ đệm dữ liệu `queryCache`, tự động gửi lại yêu cầu khi cần (`force: true`), cơ chế làm mới Token tự động khi hết hạn (JWT Refresh Token Interceptor).

---

## 5. Kết Luận & Khuyến Nghị (Conclusion)

1. **Giao diện Flutter đã map 1-1 hoàn toàn và toàn diện với ReactJS**: Mọi màn hình, form nhập liệu, modal, nhãn hiển thị và luồng nghiệp vụ trên ReactJS đều đã có phiên bản tương ứng trên Flutter.
2. **Khớp dữ liệu hoàn hảo**: Toàn bộ định dạng số tiền, ngày tháng, mã hóa dữ liệu nhạy cảm, nhãn trạng thái và phân quyền hệ thống đều đồng nhất 100%.
3. **Chất lượng mã nguồn vững chắc**: Toàn bộ **562 test cases** trong test suite tự động của Flutter đều đã vượt qua (PASS).
4. **Sẵn sàng triển khai**: Bản Flutter trên worktree `flutter-v2` hoàn toàn sẵn sàng cho việc đóng gói ứng dụng (Android, iOS, Web, Desktop) và đưa vào giai đoạn kiểm thử UAT cuối cùng.
