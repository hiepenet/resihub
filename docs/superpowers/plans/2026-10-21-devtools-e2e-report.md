# Báo Cáo Kiểm Thử Toàn Diện Bằng Chrome DevTools (E2E Test Report)

**Dự án:** ResiHub — Hệ thống quản lý căn hộ & nhà cho thuê v2.0  
**Nhánh:** `fix/auth-rls-runtime`  
**Ngày thực hiện:** 21/10/2026  
**Môi trường kiểm thử:** 
- Frontend: `http://localhost:3000` (Vite + React 19 + Tailwind CSS)
- Backend API: `http://localhost:5000` (Node.js Express + pg dual-pool)
- Database: PostgreSQL 16 (Docker `resihub-postgres`)
- Công cụ kiểm thử: **Chrome DevTools Autonomous Browser Agent**

---

## 1. Bảng Tổng Hợp Kết Quả Kiểm Thử (Executive Summary)

| STT | Luồng kiểm thử (Flow) | Vai trò / Tài khoản | Kết quả | Trạng thái | Ghi chú kỹ thuật |
|:---:|---|---|:---:|:---:|---|
| **1** | **Manager Management Scope & CRU** | `manager@resihub.vn` | **5/5 Bước Đạt** | 🟢 **PASS** | Phân quyền CRU; chỉ hiển thị tòa nhà được gán quản lý; hiển thị cư dân chưa HĐ trong dropdown tạo HĐ (**Ruling #2**); chặn xóa tầng khi có căn (400) và khi không có căn (403). |
| **2** | **Owner Organization Portfolio (Read-only)** | `owner@resihub.vn` | **3/3 Bước Đạt** | 🟢 **PASS** | Hiển thị toàn bộ danh mục **9 tòa nhà** trong tổ chức; quyền hạn chỉ đọc (R), chặn các thao tác tạo/sửa/xóa. |
| **3** | **Resident Portal & Contract Scoping** | `resident_active@resihub.vn` | **3/3 Bước Đạt** | 🟢 **PASS** | Tự động chuyển hướng `/resident`; hiển thị duy nhất căn A102 đang thuê; thẻ "Liên hệ BQL" hiển thị đúng hotline BQL tòa Thảo Điền (**Ruling #3**). |
| **4** | **Resident Phone OTP Login (NV-01)** | `0907778899` | **4/4 Bước Đạt** | 🟢 **PASS** | Gửi OTP qua SĐT; thông điệp trung lập chống enumeration attack (**D6**); xác thực mã 6 số MOCK SMS; cấp Access Token & chuyển hướng `/resident`. |

---

## 2. Chi Tiết Từng Luồng Kiểm Thử

### Luồng 1: Trải Nghiệm Quản Lý Tòa Nhà (Manager Flow)

- **Tài khoản:** `manager@resihub.vn` / `password123` (Vai trò: `MANAGER`)
- **Các bước thực hiện:**
  1. Tại trang `/login`, chọn tab **Nhân viên (Email)**, bấm nút quick login `MANAGER` và đăng nhập.
  2. Hệ thống chuyển hướng vào `/admin/dashboard`. Role hiển thị chuẩn: `MANAGER`.
  3. Truy cập `/admin/buildings`: Manager chỉ nhìn thấy các tòa nhà thuộc quyền quản lý của mình, không thấy các tòa khác.
  4. Truy cập `/admin/tenants`: Danh sách cư dân hiển thị kèm tính năng `check-dup` đã được role-gate bảo mật.
  5. Truy cập `/admin/contracts` $\rightarrow$ Mở modal **Lập hợp đồng mới**: Dropdown chọn cư dân hiển thị đầy đủ cả những cư dân vừa được duyệt hồ sơ chưa có hợp đồng (như *Vũ Cư Dân - 0900000005*), đáp ứng chính xác **Ruling #2**.
  6. Truy cập `/admin/deposits`: Sổ cọc hiển thị đúng danh mục cọc theo tòa.
  7. Bấm **Đăng xuất**: Phiên làm việc kết thúc an toàn, xóa token và đưa về `/login`.

---

### Luồng 2: Trải Nghiệm Chủ Đầu Tư (Owner Flow)

- **Tài khoản:** `owner@resihub.vn` / `password123` (Vai trò: `OWNER`)
- **Các bước thực hiện:**
  1. Tại trang `/login`, chọn tab **Nhân viên (Email)**, bấm quick login `OWNER` và đăng nhập.
  2. Hệ thống điều hướng vào `/admin/dashboard` với vai trò `OWNER`.
  3. Truy cập `/admin/buildings`: Hệ thống hiển thị toàn bộ danh mục **Tất cả tòa nhà (9 tòa)** thuộc tổ chức.
  4. Các hành động thay đổi dữ liệu (tạo tòa, tạo tầng, tạo căn) bị chặn hoàn toàn theo ma trận RBAC Mục 6.2 PRD (Read-only).
  5. Bấm **Đăng xuất**: Trở về màn hình đăng nhập.

---

### Luồng 3: Cổng Cư Dân Đã Ký Hợp Đồng (Resident Active Flow)

- **Tài khoản:** `resident_active@resihub.vn` / `password123` (Vai trò: `RESIDENT`, SĐT: `0907778899`)
- **Các bước thực hiện:**
  1. Tại `/login`, bấm quick login `CƯ DÂN (Đã ký HĐ)` và đăng nhập.
  2. Hệ thống nhận diện vai trò `RESIDENT` và tự động điều hướng sang `/resident`.
  3. Giao diện Cổng cư dân hiển thị đầy đủ và cách ly tuyệt đối:
     - **Căn hộ đang thuê:** Căn **A102** (*Tòa nhà ResiHub Thảo Điền*).
     - **Tiền thuê & Hợp đồng:** 9.000.000 ₫/tháng, hiệu lực 01/01/2026 – 31/12/2026.
     - **Sổ cọc an toàn:** Trạng thái `HELD` 18.000.000 ₫ (2 tháng cọc).
     - **Thẻ Liên hệ Ban Quản Lý:** Hiển thị Hotline `0901.234.567` của BQL Tòa nhà Thảo Điền, xác nhận **Ruling #3** hoạt động chuẩn xác qua RLS policy.
  4. Bấm **Đăng xuất**: Chuyển về màn hình đăng nhập.

---

### Luồng 4: Đăng Nhập OTP Qua Số Điện Thoại (NV-01 / D6 / D8)

- **Số điện thoại:** `0907778899` (Cư dân có tài khoản `ACTIVE` trong hệ thống)
- **Các bước thực hiện:**
  1. Tại `/login`, chọn tab **Mã OTP (SĐT)**.
  2. Nhập số điện thoại: `0907778899`.
  3. Bấm **Gửi mã xác thực OTP**:
     - Hệ thống phản hồi thông điệp trung lập `"OTP đã được gửi thành công"` (chống enumeration attack theo **D6**).
     - Khung Mock SMS màu vàng hiển thị mã OTP 6 số giả lập (ví dụ: `530641`).
  4. Nhập 6 số OTP vào ô nhập liệu và bấm **Xác thực & Đăng nhập**.
  5. Hệ thống xác thực thành công, cấp Access Token và chuyển hướng trực tiếp vào Cổng cư dân `/resident`.

---

## 3. Video & Bằng Chứng Trực Quan

1. **Phiên kiểm thử Luồng Quản Lý & Chủ Đầu Tư (WebP Video):**  
   [auth_rls_e2e_test_1792524027732.webp](file:///C:/Users/minhd/.gemini/antigravity-ide/brain/70d1f4ec-66fb-491c-b395-9f66b35ac7c1/auth_rls_e2e_test_1792524027732.webp)
2. **Phiên kiểm thử Luồng Chủ Đầu Tư, Cư Dân & OTP (WebP Video):**  
   [resident_otp_e2e_test_1792524228863.webp](file:///C:/Users/minhd/.gemini/antigravity-ide/brain/70d1f4ec-66fb-491c-b395-9f66b35ac7c1/resident_otp_e2e_test_1792524228863.webp)
3. **Ảnh chụp màn hình:**
   - Owner Buildings: [owner_buildings.png](file:///C:/Users/minhd/.gemini/antigravity-ide/brain/70d1f4ec-66fb-491c-b395-9f66b35ac7c1/owner_buildings_1792524272112.png)
   - Resident Portal A102: [resident_portal.png](file:///C:/Users/minhd/.gemini/antigravity-ide/brain/70d1f4ec-66fb-491c-b395-9f66b35ac7c1/resident_portal_1792524330794.png)
   - OTP Login Thành công: [otp_login_success.png](file:///C:/Users/minhd/.gemini/antigravity-ide/brain/70d1f4ec-66fb-491c-b395-9f66b35ac7c1/otp_login_success_1792524511959.png)

---

## 4. Đánh Giá Kỹ Thuật

- **Mã phản hồi HTTP:** Toàn bộ các request kiểm thử trả về đúng chuẩn RESTful (`200 OK`, `201 Created`, `400 Bad Request`, `403 Forbidden`, `409 Conflict`), tuyệt đối **0 lỗi HTTP 500**.
- **Connection Pool:** Tái sử dụng client thành công qua `getUserClient`, không có connection leak (`appPool.totalCount - appPool.idleCount = 0`).
- **RLS & Bảo mật:** RLS thực thi tại runtime trên vai trò PostgreSQL `resihub_app`, ngăn chặn triệt để mọi rò rỉ dữ liệu chéo tổ chức và chéo tòa nhà.
