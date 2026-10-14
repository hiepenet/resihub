# 📑 BÁO CÁO ĐÁNH GIÁ TIẾN ĐỘ & NGHIỆP VỤ GIAI ĐOẠN 1
**HỆ THỐNG QUẢN LÝ CĂN HỘ & NHÀ CHO THUÊ — RESIHUB**

> **Căn cứ đánh giá:**  
> 1. `FRONTEND DEVELOPER Roadmap (Hiep).md` — Lộ trình Giai đoạn 1 (Tuần 1 → Tuần 4)  
> 2. `PRD - Quan ly Can ho va Nha cho thue v2.0.md` — Đặc tả yêu cầu phiên bản v0.2 (18/09/2026)  
> 3. `Phase1_Plan_Chi_Tiet.md` — Kế hoạch triển khai & 13 quy trình nghiệp vụ (NV-01 → NV-13)  
> **Thời điểm lập báo cáo:** 15/10/2026  
> **Trạng thái hệ thống:** Đang chạy ổn định trên Docker Compose (PostgreSQL 16, Node.js API, React Frontend)

---

## 📌 PHẦN I: TỔNG QUAN ĐÁNH GIÁ THEO TIÊU CHÍ ROADMAP GIAI ĐOẠN 1

Theo mục **"Tiêu chí đánh giá Giai đoạn 1"** trong file `FRONTEND DEVELOPER Roadmap (Hiep).md`:

| # | Tiêu chí đánh giá Roadmap | Mức độ hoàn thành | Minh chứng kỹ thuật & Thực tế kiểm thử |
|---|---------------------------|:-----------------:|----------------------------------------|
| **1** | **Hệ thống chạy local, đăng nhập thành công bằng OTP giả lập** | **100% ĐẠT** (Vượt mức) | Docker Compose chạy 3 service: `resihub-postgres` (port 5433), `resihub-api` (port 5000), `resihub-frontend` (port 3000). Đã hỗ trợ 2 luồng: OTP giả lập (NV-01) có rate limit + lockout 15 phút, và Đăng nhập Email/Mật khẩu cho nhân viên (NV-02). |
| **2** | **Tạo thành công cây dữ liệu: Tòa nhà → Căn hộ → Cư dân → Hợp đồng → Cọc** | **100% ĐẠT** | Toàn bộ chuỗi nghiệp vụ xương sống đã được kết nối: Tạo tòa nhà (NV-03) → Thêm tầng (NV-04) → Tạo căn hộ (NV-05) → Tạo cư dân với check trùng SĐT (NV-07) → Lập hợp đồng chuyển căn sang `OCCUPIED` (NV-08) → Tự động sinh sổ cọc (NV-11). |
| **3** | **Code Backend (API) gọi trơn tru từ Frontend** | **100% ĐẠT** | Frontend kết nối Backend qua Vite Proxy (`/api` → `http://api:5000`), Axios interceptor tự động gán Bearer token, xử lý refresh token, và hiển thị thông báo lỗi/thành công trực quan. |

---

## 🎯 PHẦN II: CHI TIẾT ĐỐI SOÁT NGHIỆP VỤ THEO PRD V2.0 & ROADMAP

### 1. Phân hệ Xác thực & Tài khoản (M01, M02 / Tuần 1-2)

| Mã FR | Yêu cầu nghiệp vụ trong PRD v2.0 | Hiện trạng triển khai | Đánh giá nghiệp vụ |
|---|---|---|:---:|
| **FR-001** | Đăng nhập OTP qua số điện thoại cho cư dân và nhân sự. | Endpoint `POST /api/v1/auth/otp/request` & `/otp/verify`. Lưu OTP trong bộ nhớ, hết hạn 5 phút. Dev console log OTP. | ✅ **ĐẠT** |
| **FR-002** | Giới hạn tần suất OTP & phòng chống brute-force. | Rate-limit: 10 req/phút/IP, tối đa 3 lần/giờ/SĐT. Nhập sai 5 lần khóa tài khoản 15 phút. Phản hồi trung lập nếu SĐT chưa có trong hệ thống để tránh rò rỉ danh sách người dùng. | ✅ **ĐẠT** |
| **FR-003** | Đăng nhập bằng Email/Mật khẩu cho nhân viên nội bộ. | Endpoint `POST /api/v1/auth/login`. Mật khẩu băm qua `bcrypt`, kiểm tra tài khoản `ACTIVE` (chặn tài khoản `SUSPENDED`). | ✅ **ĐẠT** |
| **RBAC / RLS** | Phân quyền 6 vai trò: `SYS_ADMIN`, `OWNER`, `MANAGER`, `ACCOUNTANT`, `STAFF`, `RESIDENT`. | Middleware `requireRole` tại API và 9 migration RLS trong PostgreSQL (`009_rls.sql`). Phân quyền truy cập từng tòa nhà theo `user_role.building_id`. | ✅ **ĐẠT** |

---

### 2. Phân hệ Quản lý Bất động sản (M03 / Tuần 3)

| Mã FR | Yêu cầu nghiệp vụ trong PRD v2.0 | Hiện trạng triển khai | Đánh giá nghiệp vụ |
|---|---|---|:---:|
| **FR-007** | Khởi tạo Tòa nhà, Khu, Tầng. Quản lý đa tòa, đa chủ sở hữu (`owner_id`). | `POST /api/v1/buildings` lưu trữ tên, mã, địa chỉ, múi giờ, thông tin tài khoản nhận tiền (`payment_account`), điều khoản thuê (`lease_terms`). | ✅ **ĐẠT** |
| **FR-007** | Mã tòa duy nhất trong cùng tổ chức (`org_id`). | Endpoint real-time `GET /api/v1/buildings/check-code?code=...` kiểm tra trên sự kiện blur. Constraint `UNIQUE(org_id, code)` tầng DB chặn trùng mã (HTTP 409). | ✅ **ĐẠT** |
| **FR-007** | State machine của Tòa nhà: `ACTIVE` ↔ `INACTIVE`. Không xóa cứng. | `PATCH /api/v1/buildings/:id/status`. **Ràng buộc an toàn:** Chặn `INACTIVE` nếu tòa đang có hợp đồng `ACTIVE` (HTTP 400 `ACTIVE_CONTRACTS_EXIST`). | ✅ **ĐẠT** |
| **FR-007** | Checklist cấu hình tòa nhà sau khi tạo. | Tòa nhà mới tạo có 0 tầng sẽ hiển thị ngay banner màu vàng: *"🚀 Hoàn thiện cấu hình tòa để bắt đầu vận hành (Thêm tầng → Thêm căn hộ)"* kèm nút bấm dẫn nhanh. | ✅ **ĐẠT** |
| **FR-008** | Khởi tạo Căn hộ (mã căn, tầng, diện tích, loại phòng, số PN, giá niêm yết). | `POST /api/v1/apartments`. Mã căn unique trong tòa. Giá thuê lưu bằng `BIGINT` đơn vị VND. | ✅ **ĐẠT** |
| **FR-010** | Sơ đồ tầng trực quan (Interactive Floor Map) và trạng thái phòng. | API `GET /api/v1/buildings/:id/floor-map`. Frontend render layout trực quan dạng ô lưới căn hộ theo từng tầng với màu sắc trạng thái chuẩn PRD: `AVAILABLE` (Xanh lá), `OCCUPIED` (Xanh dương), `RESERVED` (Vàng cam), `MAINTENANCE` (Đỏ hồng), `INACTIVE` (Xám). Click vào căn mở Slide-over panel chi tiết. | ✅ **ĐẠT** |

---

### 3. Phân hệ Cư dân & Đặt cọc giữ chỗ (M04 / Tuần 3)

| Mã FR | Yêu cầu nghiệp vụ trong PRD v2.0 | Hiện trạng triển khai | Đánh giá nghiệp vụ |
|---|---|---|:---:|
| **FR-011** | Quản lý hồ sơ cư dân (đại diện hợp đồng `primary`, thành viên `occupant`). | Tách biệt bảng `person` (thông tin cá nhân) và `tenant` (vai trò trong tổ chức). Quản lý họ tên, SĐT, email, CCCD, ngày sinh. | ✅ **ĐẠT** |
| **FR-021** | Phát hiện trùng lặp hồ sơ cư dân qua SĐT / CCCD. | API `GET /api/v1/tenants/check-dup?phone=...`. Khi người dùng nhập SĐT đủ 10 số, hệ thống tự động kiểm tra sau 400ms debounce và hiển thị banner cảnh báo trùng lặp ngay trên form. | ✅ **ĐẠT** |
| **M04 (Cọc giữ chỗ)** | Đặt cọc giữ chỗ cho khách tiềm năng (`RESERVED`). | Đã tạo bảng CSDL `reservation` trong migration `004_tenants_reservations.sql` với các trạng thái `HELD`, `CONVERTED`, `FORFEITED`, `REFUNDED`, `EXPIRED`. Trạng thái căn hộ hỗ trợ `RESERVED`. | ⚠️ **CẦN BỔ SUNG UI** (Đã có DB Schema, cần thêm Drawer form riêng trên giao diện căn hộ) |

---

### 4. Phân hệ Hợp đồng thuê (M05 / Tuần 4)

| Mã FR | Yêu cầu nghiệp vụ trong PRD v2.0 | Hiện trạng triển khai | Đánh giá nghiệp vụ |
|---|---|---|:---:|
| **FR-014** | Lập hợp đồng thuê căn hộ: chọn căn, người thuê, ngày bắt đầu/kết thúc, kỳ thu tiền (`billing_day`), tiền thuê, tiền cọc. | Endpoint `POST /api/v1/contracts`. Kiểm tra ràng buộc hợp lệ, tự động chuyển căn hộ sang `OCCUPIED`, tự sinh bản ghi sổ cọc `deposit`. | ✅ **ĐẠT** |
| **FR-014** | Kiểm tra chồng lấn kỳ hạn thuê trên cùng căn hộ. | Ràng buộc DB `CHECK (end_date > start_date)`. Hợp đồng chỉ được tạo trên căn hộ có trạng thái `AVAILABLE`. | ⚠️ **CẦN NÂNG CẤP** (Nên bổ sung Exclusion Constraint `btree_gist` để chặn race condition chồng lấn kỳ hạn ở cấp độ microsecond) |
| **FR-015** | Gia hạn hợp đồng (Renewal). | Đã có schema bảng `contract_version` và trường `parent_contract_id`. | ⚠️ **CẦN BỔ SUNG UI** (Cần thêm nút bấm [Gia hạn] trên màn hình chi tiết hợp đồng) |
| **FR-017** | Chấm dứt hợp đồng & quy trình bàn giao. | Khi hợp đồng kết thúc/chấm dứt, căn hộ chuyển trạng thái và mở quy trình hoàn trả cọc. | ⚠️ **CẦN BỔ SUNG UI** (Cần thêm modal [Chấm dứt hợp đồng] và checklist bàn giao căn) |

---

### 5. Phân hệ Sổ cái Tiền cọc (M06 / Tuần 4)

| Mã FR | Yêu cầu nghiệp vụ trong PRD v2.0 | Hiện trạng triển khai | Đánh giá nghiệp vụ |
|---|---|---|:---:|
| **FR-022** | Mở sổ cọc riêng biệt theo từng hợp đồng (`deposit`). | API `GET /api/v1/deposits`. Bảng hiển thị số tiền cọc đang giữ, tiền thuê, căn hộ, khách thuê. | ✅ **ĐẠT** |
| **Quy tắc Cốt lõi PRD v2.0** | **Tiền cọc KHÔNG ĐƯỢC cấn trừ vào tiền thuê.** | Tách riêng hoàn toàn sổ cọc `deposit` khỏi hóa đơn tiền thuê. Tiền cọc chỉ dùng để bảo lãnh hợp đồng và khấu trừ hư hại tài sản khi kết thúc hợp đồng. | ✅ **ĐẠT TUYỆT ĐỐI** |
| **FR-023** | Ghi nhận giao dịch cọc: Thu thêm (`collect`), Khấu trừ hư hại (`deduct`), Hoàn cọc (`refund`). | Endpoint `POST /api/v1/deposits/:id/transactions`. Tính toán chính xác bằng `BigInt`. Kiểm tra số dư cọc: **Chặn không cho khấu trừ hoặc hoàn cọc vượt quá số dư hiện có** (HTTP 400 `INSUFFICIENT_FUNDS`). | ✅ **ĐẠT** |
| **FR-024** | Trạng thái tất toán cọc: chuyển sang `REFUNDED` khi số dư về 0. | Tự động cập nhật `status = 'REFUNDED'` khi hoàn trả hết tiền cọc cho cư dân. | ✅ **ĐẠT** |

---

### 6. Các yêu cầu phi chức năng (NFRs) cốt lõi

| Mã NFR | Yêu cầu | Thực tế triển khai | Kết quả |
|---|---|---|:---:|
| **NFR-001 / NFR-014** | **Độ chính xác tài chính tuyệt đối:** Không dùng số thực (float), không làm tròn sai lệch 1 đồng. | 100% cột tiền tệ trong DB dùng kiểu `BIGINT` đơn vị VND. Code xử lý tiền tệ dùng `BigInt`. Component `Money.jsx` định dạng dấu chấm phân cách chuẩn VNĐ (VD: `7.500.000 ₫`). | ✅ **XUẤT SẮC** |
| **NFR-010** | **Audit Log bất biến:** Lưu vết mọi thao tác thêm/sửa, không thể sửa/xóa log. | Bảng `audit_log` với Trigger PostgreSQL `prevent_audit_log_modification()` chặn hoàn toàn các lệnh `UPDATE` hoặc `DELETE`. Mọi hành động `CREATE`, `UPDATE` của tòa nhà, căn hộ, cư dân, hợp đồng, cọc đều được ghi log chi tiết (`actor_id`, `before`, `after`, `at`). | ✅ **XUẤT SẮC** |
| **NFR-016** | **Không xóa cứng (Soft-delete only):** Dữ liệu nghiệp vụ chỉ đổi trạng thái. | Toàn bộ các bảng nghiệp vụ (`building`, `apartment`, `contract`, `tenant`, `deposit`) đều dùng cơ chế chuyển đổi `status`, tuyệt đối không dùng lệnh `DELETE` trong API. | ✅ **XUẤT SẮC** |

---

## 📊 PHẦN III: BẢNG MA TRẬN ĐỐI SOÁT 13 QUY TRÌNH NGHIỆP VỤ (NV-01 → NV-13)

| Mã NV | Tên quy trình nghiệp vụ | Actor | Module | CSDL | API | Frontend UI | Đánh giá tổng thể |
|---|---|---|---|:---:|:---:|:---:|:---:|
| **NV-01** | Đăng nhập OTP qua SĐT | Tất cả | M02 | ✅ | ✅ | ✅ | **100% Hoàn thành** |
| **NV-02** | Đăng nhập Email/Mật khẩu | Nhân viên | M02 | ✅ | ✅ | ✅ | **100% Hoàn thành** |
| **NV-03** | Tạo tòa nhà mới | SYS_ADMIN | M03 | ✅ | ✅ | ✅ | **100% Hoàn thành** |
| **NV-04** | Thêm tầng vào tòa nhà | MANAGER | M03 | ✅ | ✅ | ✅ | **100% Hoàn thành** |
| **NV-05** | Tạo căn hộ mới | MANAGER | M03 | ✅ | ✅ | ✅ | **100% Hoàn thành** |
| **NV-06** | Đặt cọc giữ chỗ (Reservation) | MANAGER | M04 | ✅ | 🟡 | 🟡 | **70% (Đã có Schema, cần hoàn thiện UI)** |
| **NV-07** | Tạo hồ sơ cư dân & check trùng | MANAGER | M04 | ✅ | ✅ | ✅ | **100% Hoàn thành** |
| **NV-08** | Lập hợp đồng thuê mới | MANAGER | M05 | ✅ | ✅ | ✅ | **90% (Cần chuyển sang Wizard 3 bước)** |
| **NV-09** | Gia hạn hợp đồng | MANAGER | M05 | ✅ | 🟡 | 🟡 | **60% (Đã có Schema, cần hoàn thiện UI)** |
| **NV-10** | Chấm dứt hợp đồng & bàn giao | MANAGER | M05 | ✅ | 🟡 | 🟡 | **60% (Đã có Schema, cần hoàn thiện UI)** |
| **NV-11** | Thu tiền cọc hợp đồng | ACCOUNTANT | M06 | ✅ | ✅ | ✅ | **100% Hoàn thành** |
| **NV-12** | Ghi nhận khấu trừ cọc | MANAGER | M06 | ✅ | ✅ | ✅ | **90% (Đã có form khấu trừ, cần thêm duyệt)** |
| **NV-13** | Quyết toán & hoàn cọc | ACCOUNTANT | M06 | ✅ | ✅ | ✅ | **90% (Đã có xử lý hoàn cọc qua transaction)** |

---

## 🔍 PHẦN IV: CÁC ĐIỂM CẦN NÂNG CẤP TIẾP THEO ĐỂ HOÀN THIỆN 100% GIAI ĐOẠN 1

Dù **chuỗi dữ liệu cốt lõi (Happy Path) đã chạy 100% thành công**, để hệ thống đạt mức độ hoàn hảo phục vụ nghiệm thu Giai đoạn 1 và chuẩn bị bước sang Giai đoạn 2 (Tính tiền hóa đơn & AI), cần hoàn thiện các hạng mục sau:

1. **NV-06 (Đặt cọc giữ chỗ):** Bổ sung nút `[Đặt giữ chỗ]` trên Card căn hộ `AVAILABLE` ở màn hình Sơ đồ tầng để mở form thu tiền giữ chỗ cho khách tiềm năng.
2. **NV-08 (Wizard Hợp đồng 3 bước):** Nâng cấp modal lập hợp đồng hiện tại thành Wizard 3 bước:
   - Bước 1: Chọn căn & Khách thuê (kèm danh sách thành viên hộ).
   - Bước 2: Thời hạn, Giá thuê, Tiền cọc, Ngày chốt kỳ (`billing_day`), Số ngày ân hạn.
   - Bước 3: Chọn biểu phí dịch vụ đi kèm (Điện, Nước, Xe máy, Internet) với tính năng ghi đè đơn giá theo hợp đồng.
3. **NV-09 & NV-10 (Gia hạn & Chấm dứt hợp đồng):** Bổ sung 2 nút hành động trực tiếp trên dòng hợp đồng trong bảng danh sách:
   - Nút `[↻ Gia hạn]`: Tự động kế thừa thông tin và cộng tiếp ngày bắt đầu.
   - Nút `[🔴 Chấm dứt]`: Chọn ngày thanh lý, kích hoạt checklist bàn giao và liên kết sang quyết toán cọc.
4. **Cơ chế Four-Eyes (Người lập ≠ Người duyệt):** Bật cờ kiểm tra `approved_by != created_by` đối với các giao dịch khấu trừ cọc vượt ngưỡng và kích hoạt hợp đồng có giá thuê lệch khung.

---

## 🏆 KẾT LUẬN

Hệ thống **ResiHub MVP đã hoàn thành xuất sắc các mục tiêu cốt lõi của Giai đoạn 1** theo đúng Roadmap Frontend Developer và PRD v2.0:
- Toàn bộ hạ tầng Docker (PostgreSQL, Express API, React Vite) hoạt động ổn định.
- Luồng dữ liệu xương sống từ **Tổ chức → Tòa nhà → Tầng → Căn hộ → Cư dân → Hợp đồng → Sổ cọc** đã được thiết lập chặt chẽ, có kiểm soát ràng buộc dữ liệu và ghi vết Audit Log bất biến.
- Các quy tắc kinh doanh quan trọng nhất của chủ đầu tư (tiền lưu `BIGINT` VND, không xóa cứng dữ liệu, cọc không cấn trừ vào tiền thuê, mã tòa kiểm tra real-time) đều đã được hiện thực hóa và kiểm thử tự động thành công.
