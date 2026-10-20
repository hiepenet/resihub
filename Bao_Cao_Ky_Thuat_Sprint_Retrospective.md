# BÁO CÁO KỸ THUẬT (SPRINT RETROSPECTIVE)
**Giai đoạn 1: Nền tảng Full Stack, Database Schema & Phân quyền lõi**
*Dự án: ResiHub — Hệ thống Quản lý Căn hộ & Cho thuê*

---

## 1. Cấu trúc Cơ sở Dữ liệu (Database Schema)

Hệ thống sử dụng **PostgreSQL 16** với thiết kế chuẩn hóa, phân tách dữ liệu cá nhân (PII) và tài khoản xác thực, áp dụng Row Level Security (RLS) để cô lập dữ liệu.

### 1.1. Sơ đồ quan hệ thực thể (ERD)
```
[organization] 1 ──< N [building] 1 ──< N [floor] 1 ──< N [apartment]
       │                      │                                 │
       │                      │                                 │
       └──< N [role]          └──< N [reservation]              ├──< N [contract] 1 ── 1 [deposit]
               │                         │                               │
               └──< N [user_role] >──────┘                               └──< N [contract_service_price]
                           │
[person] 1 ── 1 [app_user] ┘
   │
   └──< N [tenant] ───────────────────────────────────────────────────────┘
```

### 1.2. Danh mục các bảng cốt lõi
1. **`organization`**: Định danh công ty/tổ chức quản lý bất động sản.
2. **`building`**: Thông tin tòa nhà (`name`, `code`, `address`, `status: ACTIVE/INACTIVE`). Ràng buộc `UNIQUE(org_id, code)`.
3. **`floor`**: Phân tầng tòa nhà (`level`: âm là hầm, 0 là trệt, dương là lầu). Ràng buộc `UNIQUE(building_id, level)`.
4. **`apartment`**: Căn hộ (`code`, `area_m2`, `base_rent`, `status: AVAILABLE/RESERVED/OCCUPIED/MAINTENANCE`). Ràng buộc `UNIQUE(building_id, code)`.
5. **`person`**: Dữ liệu định danh cá nhân độc lập (`full_name`, `phone`, `email`, `id_number`, `dob`). Ràng buộc `UNIQUE(org_id, phone)`.
6. **`app_user`**: Tài khoản hệ thống liên kết 1-1 với `person` (`auth_uid`, `password_hash`, `status: ACTIVE/SUSPENDED`).
7. **`role`**: Chuẩn hóa đúng 3 vai trò: `OWNER`, `MANAGER`, `RESIDENT`.
8. **`user_role`**: Phân quyền tài khoản theo vai trò và tòa nhà (`building_id`). Ràng buộc `UNIQUE(user_id, role_id, building_id)`.
9. **`tenant`**: Hồ sơ cư dân thuê nhà (`type: primary/occupant`, `status: PENDING/APPROVED/REJECTED/MOVED_OUT`).
10. **`reservation`**: Đặt cọc giữ chỗ khách tiềm năng (`hold_amount`, `hold_until`, `status: HELD/CONVERTED/FORFEITED/REFUNDED`).
11. **`contract`**: Hợp đồng thuê căn hộ (`start_date`, `end_date`, `rent_amount`, `billing_cycle`, `status: ACTIVE/TERMINATED`). Ràng buộc `CHECK (end_date > start_date)`.
12. **`deposit` & `deposit_transaction`**: Sổ cọc độc lập (`amount_held`, `status: HELD`), ghi nhận lịch sử thu, hoàn và khấu trừ hư hại tài sản.
13. **`notification` & `audit_log`**: Lưu trữ biến động thông báo và lịch sử thao tác hệ thống.

### 1.3. Các nguyên tắc kỹ thuật bắt buộc
- **Định dạng tiền tệ:** 100% cột tài chính sử dụng kiểu **`BIGINT`** (VNĐ), loại trừ hoàn toàn lỗi làm tròn số thực (`FLOAT/DOUBLE`).
- **Thời gian chuẩn:** Sử dụng **`TIMESTAMPTZ`** (UTC/GMT+7) cho mọi mốc thời gian.
- **Tính trọn vẹn dữ liệu (ACID):** Mọi tác vụ sinh dữ liệu kép (tạo tòa gán quyền, cọc giữ chỗ đổi trạng thái căn hộ) đều thực thi trong một `TRANSACTION` (`BEGIN ... COMMIT / ROLLBACK`).

---

## 2. Danh mục API Endpoints đã chốt

Hệ thống đã chuẩn hóa và kiểm thử thành công **24 RESTful API Endpoints**:

| Phân hệ | Method | URI | Quyền hạn (RBAC) | Mô tả nghiệp vụ |
| :--- | :---: | :--- | :--- | :--- |
| **Xác thực** | `POST` | `/api/v1/auth/otp/request` | Public | Yêu cầu gửi OTP qua SĐT (Chống leak thông tin) |
| | `POST` | `/api/v1/auth/otp/verify` | Public | Xác thực OTP, cấp Access Token & Refresh Token |
| | `POST` | `/api/v1/auth/login` | Public | Đăng nhập nội bộ bằng Email/Password |
| | `POST` | `/api/v1/auth/refresh` | Public | Cấp mới Access Token từ Refresh Token |
| **Tòa nhà** | `GET` | `/api/v1/buildings` | OWNER, MANAGER, RESIDENT | Lấy danh sách tòa nhà theo phạm vi phân quyền |
| | `POST` | `/api/v1/buildings` | MANAGER | Tạo tòa nhà mới (Tự động gán quyền quản lý) |
| | `PATCH`| `/api/v1/buildings/:id/status`| MANAGER | Đổi trạng thái tòa nhà (Chặn nếu còn HĐ ACTIVE) |
| | `GET` | `/api/v1/buildings/:id/floors` | Authenticated | Danh sách tầng kèm số lượng căn hộ |
| | `POST` | `/api/v1/buildings/:id/floors` | MANAGER | Thêm tầng hầm/trệt/lầu (Chặn trùng level) |
| | `DELETE`| `/api/v1/buildings/:id/floors/:floor_id` | MANAGER | Chặn xóa nếu còn căn hộ (400) hoặc cấm xóa (403) |
| | `GET` | `/api/v1/buildings/:id/floor-map` | Authenticated | Sơ đồ ma trận tầng và trạng thái căn hộ |
| **Căn hộ** | `GET` | `/api/v1/apartments` | OWNER, MANAGER, RESIDENT | Danh sách căn hộ (lọc theo tòa, trạng thái) |
| | `POST` | `/api/v1/apartments` | MANAGER | Tạo căn hộ mới với giá thuê BigInt |
| | `PATCH`| `/api/v1/apartments/:id` | MANAGER | Cập nhật giá thuê, diện tích, tiện nghi |
| **Cọc giữ chỗ** | `POST` | `/api/v1/reservations` | MANAGER | Đặt cọc giữ chỗ (Tự động khóa căn sang RESERVED) |
| | `POST` | `/api/v1/reservations/:id/cancel` | MANAGER | Hủy cọc giữ chỗ (Tự động mở lại AVAILABLE) |
| **Hồ sơ cư dân**| `POST` | `/api/v1/tenants` | MANAGER | Tạo hồ sơ cư dân & duplicate check SĐT/CCCD |
| **Hợp đồng** | `POST` | `/api/v1/contracts` | MANAGER | Lập HĐ thuê (Chống chồng lấn kỳ hạn căn hộ) |
| | `POST` | `/api/v1/contracts/:id/terminate` | MANAGER | Chấm dứt hợp đồng (Mở lại căn sang AVAILABLE) |
| **Sổ cọc** | `GET` | `/api/v1/deposits` | OWNER, MANAGER | Xem sổ cọc độc lập của các hợp đồng |
| | `POST` | `/api/v1/deposits/:id/deduct` | MANAGER | Khấu trừ hư hại tài sản (Cấm cấn trừ tiền thuê) |
| **Cổng Cư Dân**| `GET` | `/api/v1/resident/overview` | RESIDENT | Dữ liệu cá nhân hóa (HĐ, cọc giữ chỗ, phòng trống) |
| | `POST` | `/api/v1/resident/rental-application` | RESIDENT | Tự khai hồ sơ CCCD nhận nhà (FR-012) |
| | `POST` | `/api/v1/resident/service-requests` | RESIDENT | Gửi yêu cầu sửa chữa, báo hỏng thiết bị (FR-042) |

---

## 3. Các lỗi AI thường gặp & Bài học kinh nghiệm Vibe Coding

Trong quá trình đồng hành cùng AI sinh code, 5 lỗi phổ biến đã được nhận diện, khắc phục và đúc kết thành quy chuẩn:

### 1. Nhầm lẫn bảng dữ liệu do thói quen suy đoán (Entity Confusion)
- **Lỗi của AI:** AI sinh lệnh `DELETE FROM app_user WHERE email = '...'` dẫn đến crash `column "email" does not exist`. AI suy đoán theo các hệ thống thông thường là user có sẵn cột email.
- **Thực tế hệ thống:** ResiHub chuẩn hóa tách biệt bảng định danh `person` (chứa `email`, `phone`, `id_number`) và bảng tài khoản xác thực `app_user` (chỉ chứa `person_id`, `password_hash`).
- **Bài học Vibe Coding:** Không để AI tự suy diễn schema. Phải chỉ định rõ ràng: *"Đọc file `002_organization_users.sql` trước, query qua bảng `person` sau đó xóa bằng khóa ngoại `person_id`."*

### 2. Tự bịa đặt tên bảng và cột (Hallucinated Table/Column Names)
- **Lỗi của AI:** Khi viết query lấy thông tin tiền cọc, AI gọi bảng `deposit_ledger` và cột `held_amount`. Runtime văng lỗi PostgreSQL `relation "deposit_ledger" does not exist`.
- **Thực tế hệ thống:** Bảng trong migration `006_deposits.sql` có tên là `deposit`, cột số tiền là `amount_held`.
- **Bài học Vibe Coding:** Bắt buộc AI sử dụng công cụ tìm kiếm codebase (`grep_search`) để kiểm chứng tên thực thể trước khi sinh mã.

### 3. Xung đột thứ tự kiểm tra nghiệp vụ và phân quyền (Validation Conflict)
- **Lỗi của AI:** Khi cài đặt endpoint xóa tầng: Do Manager chỉ có quyền `CRU` (không có quyền xóa `D`), AI đặt mã lỗi `403 DELETE_PROHIBITED` ở ngay dòng đầu tiên. Điều này làm trượt test case NV-04 (nếu tầng đang chứa căn hộ thì phải trả về lỗi `400 FLOOR_HAS_APARTMENTS`).
- **Thực tế hệ thống:** Kiểm tra tính hợp lệ dữ liệu kinh doanh (Business Validation) phải đứng trước kiểm tra phân quyền hành vi (Action Permission).
- **Bài học Vibe Coding:** Prompt cần nêu rõ thứ tự logic: *"Kiểm tra tầng có căn hộ hay không trước (nếu có trả về 400). Sau đó mới kiểm tra quyền xóa của role (trả về 403)."*

### 4. Lệch tuyến đường giao diện (Layout & Route Mismatch)
- **Lỗi của AI:** Sau khi đăng nhập bằng tài khoản cư dân, AI điều hướng mặc định về `/admin/dashboard`. Phân hệ admin được bảo vệ chỉ cho `OWNER` và `MANAGER`, khiến cư dân bị văng màn hình 403 cụt lủn với thanh sidebar trống trơn.
- **Thực tế hệ thống:** Cư dân là người dùng cuối (End-user), cần giao diện Cổng Cư Dân riêng (`ResidentLayout`) thân thiện, không có thanh sidebar của ban quản trị.
- **Bài học Vibe Coding:** Tách biệt layout ngay từ cấp thiết kế Router. Cung cấp cơ chế `RootRedirect` để điều hướng tự động: `RESIDENT` -> `/resident`; `OWNER/MANAGER` -> `/admin/dashboard`.

### 5. Quên cơ chế Atomic Transaction khi tạo tài nguyên có phân quyền
- **Lỗi của AI:** Khi Manager tạo tòa nhà mới, AI chỉ thực hiện `INSERT INTO building` mà quên ghi nhận vào bảng `user_role`. Hậu quả là Manager vừa tạo xong tòa nhà thì lại không có quyền truy cập tòa nhà đó.
- **Thực tế hệ thống:** Quá trình tạo tòa nhà và gán quyền quản lý là một chuỗi hành động nguyên tử (Atomic).
- **Bài học Vibe Coding:** Luôn yêu cầu AI bao bọc nghiệp vụ phức hợp trong một DB Transaction (`BEGIN ... COMMIT`) và tự động chèn bản ghi phân quyền `user_role` ngay trong cùng transaction đó.

---

### 💡 Quy tắc vàng cho Vibe Coding hiệu quả
> 1. **Context-First:** Luôn gắn kèm DDL/Schema và yêu cầu mã lỗi HTTP cụ thể trong câu prompt.
> 2. **Explicit Verification:** Đặt câu hỏi ngược lại cho AI: *"Tên bảng/cột này đã kiểm tra trong file migration nào?"*.
> 3. **Test-Driven:** Bắt buộc viết script kiểm thử tự động kiểm tra cả chiều thành công (`200/201`) lẫn chiều chặn lỗi (`400/403/409`) để đảm bảo chất lượng code sau mỗi lần sinh.
