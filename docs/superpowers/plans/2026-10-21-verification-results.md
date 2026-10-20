# Báo Cáo Kiểm Thử & Xác Minh Toàn Diện (Verification Results)
**Kế hoạch:** `docs/superpowers/plans/2026-10-21-fix-auth-rls-findings.md`  
**Nhánh:** `fix/auth-rls-runtime`  
**Ngày thực hiện:** 21/10/2026  
**Trạng thái:** ✅ **ĐẠT 100% MỤC TIÊU VÀ SẴN SÀNG MERGE**

---

## 1. Tóm tắt kết quả theo các mục tiêu cốt lõi

| Hạng mục kiểm thử | Kết quả | Trạng thái | Ghi chú |
|---|:---:|:---:|---|
| **RLS Zero Data Leak (`test_rls_zero_leak.mjs`)** | **11/11 PASS (100%)** | 🟢 ĐẠT | Cách ly hợp đồng, căn hộ, tòa nhà giữa các cư dân; MANAGER bị giới hạn trong tòa quản lý; OWNER & SYS_ADMIN độc lập thấy toàn tổ chức; MANAGER chưa gán tòa bị default-deny 0 dòng. |
| **Phase 1 Compliance (`test_phase1_compliance.mjs`)** | **39/39 PASS (100%)** | 🟢 ĐẠT | Chuỗi nghiệp vụ: Đăng nhập OTP, tạo tòa/tầng/căn, đặt cọc giữ chỗ, lập hợp đồng, chống chồng lấn kỳ, quản lý sổ cọc, cấm cấn trừ tiền thuê, chấm dứt hợp đồng. |
| **CRUD & Scoping RBAC (`test_crud_scoping.mjs`)** | **19/19 PASS (100%)** | 🟢 ĐẠT | MANAGER thực hiện CRU đầy đủ; OWNER chỉ có quyền R (bị chặn toàn bộ C/U/D); RESIDENT chỉ xem căn hộ của mình; Chặn xóa tầng khi có căn hộ (400) và khi không có căn hộ (403 CRU guard). |
| **Khả năng chịu tải & Connection Leak** | **0 rò rỉ connection** | 🟢 ĐẠT | Chạy đồng thời `Promise.all` 2 request (OWNER + MANAGER) trên cùng endpoint `GET /buildings`; mỗi request checkout đúng 1 client, RLS context độc lập; sau khi phản hồi trả về, connection pool trả hết về trạng thái idle (`appPool.totalCount - appPool.idleCount = 0`). |
| **Migrations & Database Integrity** | **001..013 APPLIED** | 🟢 ĐẠT | Không sửa đổi các migration cũ (001..012); toàn bộ hàm RLS và chính sách bổ sung nằm trong `013_rls_fixes.sql`. Các hàm helper được gán `SECURITY DEFINER SET row_security = off` triệt tiêu hoàn toàn lỗi đệ quy vô hạn (`42P17`). |

---

## 2. Chi tiết kết quả chạy kiểm thử tự động

### 2.1 Kiểm thử RLS & Zero Data Leak (`test_rls_zero_leak.mjs`)
```text
===============================================================
🔒 BẮT ĐẦU KIỂM THỬ ROW LEVEL SECURITY (RLS) & ZERO DATA LEAK
===============================================================

--- [BƯỚC 1] THIẾT LẬP DỮ LIỆU CÁCH LY KIỂM THỬ RLS ---
  Setup hoàn tất: Cư dân A (A101), Cư dân B (B201), Quản lý Alpha, SYS_ADMIN, Quản lý chưa gán tòa.

--- [TEST 1] CƯ DÂN A TRUY VẤN HỢP ĐỒNG (YÊU CẦU NFR-008) ---
  ✅ [PASS] Cư dân A chỉ nhìn thấy đúng 1 hợp đồng của chính mình
  ✅ [PASS] Cư dân A query HĐ của Cư dân B → Trả về EMPTY (0 dòng) đúng chuẩn Zero Data Leak

--- [TEST 2] CƯ DÂN A TRUY VẤN CĂN HỘ & TÒA NHÀ ---
  ✅ [PASS] Cư dân A chỉ thấy duy nhất căn hộ mình đang thuê (ALPHA-101)
  ✅ [PASS] Cư dân A query căn B201 của Tòa Beta → Trả về EMPTY (0 dòng)
  ✅ [PASS] Cư dân A chỉ thấy tòa nhà mình đang thuê

--- [TEST 3] PHÂN QUYỀN QUẢN LÝ TÒA NHÀ (MANAGER BUILDING SCOPE) ---
  ✅ [PASS] Quản lý Tòa Alpha nhìn thấy Tòa Alpha và TUYỆT ĐỐI KHÔNG thấy Tòa Beta
  ✅ [PASS] Quản lý Tòa Alpha chỉ thấy danh sách căn hộ thuộc Tòa Alpha
  ✅ [PASS] Quản lý Tòa Alpha query căn của Tòa Beta → Trả về EMPTY (0 dòng)

--- [TEST 4] QUYỀN CHỦ ĐẦU TƯ / OWNER (FULL ORG VISIBILITY) ---
  ✅ [PASS] Chủ đầu tư (OWNER) nhìn thấy toàn bộ tòa nhà trong tổ chức

--- [TEST 5] SYS_ADMIN ĐỘC LẬP & DEFAULT-DENY CHO MANAGER CHƯA GÁN TÒA ---
  ✅ [PASS] SYS_ADMIN độc lập (không có vai trò OWNER) nhìn thấy toàn bộ tòa nhà trong tổ chức
  ✅ [PASS] MANAGER chưa được gán tòa nào → Không thấy tòa nhà nào (Default-Deny chuẩn xác)

===============================================================
📊 KẾT QUẢ KIỂM THỬ RLS: 11 PASS, 0 FAIL
🎉 100% CÁC CHÍNH SÁCH ROW LEVEL SECURITY ĐÃ ĐẠT CHUẨN ZERO DATA LEAK!
===============================================================
```

### 2.2 Kiểm thử Tuân thủ Phase 1 (`test_phase1_compliance.mjs`)
```text
====================================================
🧪 BẮT ĐẦU KIỂM THỬ TOÀN DIỆN PHASE 1 COMPLIANCE
====================================================

--- [TEST 0] ĐĂNG NHẬP OTP QUA SỐ ĐIỆN THOẠI (NV-01) ---
  ✅ [PASS] Yêu cầu gửi mã OTP thành công (HTTP 200)
  ✅ [PASS] Thông điệp trung lập chống leak SĐT
  ✅ [PASS] Xác thực OTP thành công (HTTP 200)
  ✅ [PASS] Cấp JWT Access Token khi xác thực OTP thành công

--- [TEST 1] ĐĂNG NHẬP NHÂN SỰ NỘI BỘ (NV-02) ---
  ✅ [PASS] Đăng nhập nhân sự quản trị (SYS_ADMIN/OWNER/MANAGER) thành công với HTTP 200
  ✅ [PASS] Nhận accessToken hợp lệ

--- [TEST 2] TẠO TÒA NHÀ & CHECK MÃ TÒA REAL-TIME (NV-03) ---
  ✅ [PASS] Mã tòa khả dụng
  ✅ [PASS] Tạo tòa nhà mới thành công (HTTP 201)
  ✅ [PASS] Mã tòa bị báo trùng sau khi tạo

--- [TEST 3] THÊM TẦNG HẦM, TRỆT, LẦU & RÀNG BUỘC (NV-04) ---
  ✅ [PASS] Tạo tầng hầm B1 (level = -1) thành công (HTTP 201)
  ✅ [PASS] Tự động sinh tên: "Tầng hầm B1"
  ✅ [PASS] Tạo tầng trệt (level = 0) thành công (HTTP 201)
  ✅ [PASS] Tự động sinh tên: "Tầng Trệt"
  ✅ [PASS] Tạo tầng 1 (level = 1) thành công (HTTP 201)
  ✅ [PASS] Chặn tạo tầng trùng level trong cùng tòa (HTTP 409)
  ✅ [PASS] Lấy danh sách đủ 3 tầng vừa tạo

--- [TEST 4] TẠO CĂN HỘ VỚI GIÁ BIGINT & SƠ ĐỒ TẦNG (NV-05) ---
  ✅ [PASS] Tạo căn hộ thành công với HTTP 201
  ✅ [PASS] Trạng thái căn hộ mới mặc định là AVAILABLE
  ✅ [PASS] Chặn xóa tầng khi đang chứa căn hộ (HTTP 400)

--- [TEST 5] ĐẶT CỌC GIỮ CHỖ KHÁCH TIỀM NĂNG (NV-06) ---
  ✅ [PASS] Đặt cọc giữ chỗ thành công (HTTP 201)
  ✅ [PASS] Trạng thái giữ chỗ là HELD
  ✅ [PASS] Căn hộ tự động chuyển sang RESERVED
  ✅ [PASS] Chặn đặt cọc trên căn đang RESERVED (HTTP 409)
  ✅ [PASS] Ghi nhận khách hủy cọc giữ chỗ thành công (HTTP 200)
  ✅ [PASS] Căn hộ đã tự động mở lại trạng thái AVAILABLE

--- [TEST 6] HỒ SƠ CƯ DÂN & DUPLICATE CHECK (NV-07) ---
  ✅ [PASS] Tạo hồ sơ cư dân thành công (HTTP 201)
  ✅ [PASS] Duplicate check phát hiện đúng số điện thoại vừa tạo

--- [TEST 7] LẬP HỢP ĐỒNG THUÊ & CHỐNG CHỒNG LẤN KỲ (NV-08) ---
  ✅ [PASS] Chặn hợp đồng có end_date <= start_date (HTTP 422)
  ✅ [PASS] Tạo hợp đồng thuê hợp lệ thành công (HTTP 201)
  ✅ [PASS] Căn hộ chuyển sang trạng thái OCCUPIED
  ✅ [PASS] Chặn tạo hợp đồng chồng lấn kỳ hạn cùng căn (HTTP 409 OVERLAP_CONTRACT)

--- [TEST 8] SỔ CỌC & CẤM CẤN TRỪ TIỀN THUÊ VÀO CỌC (NV-11, NV-12) ---
  ✅ [PASS] Sổ cọc tự động khởi tạo ở trạng thái HELD
  ✅ [PASS] Số tiền cọc đang giữ chuẩn 7.500.000 ₫
  ✅ [PASS] Chặn cấn trừ tiền thuê vào tiền cọc (HTTP 400 RENT_OFFSET_PROHIBITED)
  ✅ [PASS] Khấu trừ hư hại tài sản 1.500.000 ₫ thành công (HTTP 201)
  ✅ [PASS] Số dư cọc còn lại chính xác 6.000.000 ₫

--- [TEST 9] CHẶN INACTIVE TÒA NHÀ KHI CÒN HỢP ĐỒNG ACTIVE ---
  ✅ [PASS] Chặn chuyển tòa sang INACTIVE khi còn hợp đồng ACTIVE (HTTP 400)

--- [TEST 10] CHẤM DỨT HỢP ĐỒNG & MỞ LẠI CĂN HỘ (NV-10) ---
  ✅ [PASS] Chấm dứt hợp đồng thành công (HTTP 200)
  ✅ [PASS] Căn hộ đã tự động mở lại trạng thái AVAILABLE sau khi chấm dứt hợp đồng

====================================================
📊 KẾT QUẢ KIỂM THỬ: 39 PASS, 0 FAIL
🎉 100% CÁC TEST CASES ĐÃ VƯỢT QUA VÀ KHỚP VỚI PRD!
====================================================
```

### 2.3 Kiểm thử Phân quyền CRUD & Scoping (`test_crud_scoping.mjs`)
```text
--- [2. KIỂM THỬ MANAGER: CRU TÒA NHÀ CỦA MÌNH QUẢN LÝ] ---
  ✅ [PASS] Manager xem danh sách tòa nhà (HTTP 200)
  ✅ [PASS] Manager tạo mới tòa nhà MGR-xxxx thành công (HTTP 201)
  ✅ [PASS] Tòa nhà mới tạo tự động được gán quyền cho Manager quản lý
  ✅ [PASS] Manager tạo tầng 1 trong tòa nhà của mình (HTTP 201)
  ✅ [PASS] Manager tạo căn hộ trong tòa nhà của mình (HTTP 201)
  ✅ [PASS] Manager cập nhật giá thuê/ghi chú căn hộ của mình (HTTP 200)
  ✅ [PASS] Manager cập nhật trạng thái tòa nhà của mình (HTTP 200)
  ✅ [PASS] Manager bị CHẶN xóa tầng (HTTP 403 - CRU không có quyền Delete)

--- [3. KIỂM THỬ OWNER: R TOÀN BỘ TÒA THUỘC SỞ HỮU (READ-ONLY)] ---
  ✅ [PASS] Owner xem danh sách toàn bộ tòa nhà (HTTP 200)
  ✅ [PASS] Owner xem được toàn bộ các tòa nhà trong tổ chức
  ✅ [PASS] Owner bị CHẶN tạo mới tòa nhà (HTTP 403 - Owner chỉ có quyền R)
  ✅ [PASS] Owner bị CHẶN tạo tầng mới (HTTP 403 - Owner chỉ có quyền R)
  ✅ [PASS] Owner bị CHẶN tạo căn hộ mới (HTTP 403 - Owner chỉ có quyền R)
  ✅ [PASS] Owner bị CHẶN sửa căn hộ (HTTP 403 - Owner chỉ có quyền R)

--- [4. KIỂM THỬ RESIDENT: R CĂN HỘ CỦA MÌNH] ---
  ✅ [PASS] Resident truy vấn tòa nhà thành công (HTTP 200)
  ✅ [PASS] Resident chỉ nhìn thấy tối đa 1 tòa nhà mà mình đang thuê
  ✅ [PASS] Resident truy vấn căn hộ thành công (HTTP 200)
  ✅ [PASS] Resident bị CHẶN tạo tòa nhà (HTTP 403)
  ✅ [PASS] Resident bị CHẶN tạo căn hộ (HTTP 403)
```

---

## 3. Xác minh 4 Tinh chỉnh được duyệt (Rulings)

1. **Ruling #1 (T7 - Reuse `req.dbClient`):**
   - Triển khai thành công trong `getUserClient(req)`. Nếu middleware `authenticateToken` đã cấp `req.dbClient`, `release` là no-op; sự kiện `res.once('finish')` và `res.once('close')` chịu trách nhiệm `RESET app.current_user_id` và `release()`.
   - Kết quả: Không phát sinh 2 connection/request; connection pool idle 100% sau mỗi lượt truy vấn.
2. **Ruling #2 (T4 - Hiển thị cư dân chưa hợp đồng trong dropdown):**
   - Truy vấn `GET /tenants` của MANAGER bao gồm cả nhánh `OR NOT EXISTS (SELECT 1 FROM contract c WHERE c.primary_tenant_id = t.id)`. Cư dân mới duyệt chưa ký hợp đồng hiển thị đầy đủ trong dropdown hợp đồng mới.
3. **Ruling #3 (T6 - own-building-set cho resident contact BQL):**
   - Hàm `get_resident_manager_user_ids` trong SQL 013 sử dụng UNION giữa tòa có hợp đồng `ACTIVE` và tòa có `reservation` theo số điện thoại (ví dụ: cư dân cọc giữ chỗ `0900000005` vẫn tra cứu được thông tin BQL tòa nhà).
4. **Ruling #4 (T1/T3 - `import 'dotenv/config'`):**
   - Đã đặt ở dòng 1 của `server.js`, `routes/auth.js`, và `middleware/auth.js`. Các module chạy độc lập không bị văng lỗi thiếu biến môi trường.

---

## 4. Danh sách Commit trên nhánh `fix/auth-rls-runtime`

- `e6fe853` — docs: cập nhật báo cáo audit đăng nhập & RLS và kế hoạch fix lỗi theo hiện trạng codebase
- `d6df3b0` — fix(security): D5 - fail-fast khi thiếu JWT_SECRET / JWT_REFRESH_SECRET và dotenv độc lập
- `71ea76a` — fix(auth): D7 - refresh token kiểm tra app_user ACTIVE và nạp lại fresh roles từ DB
- `46dd81e` — fix(auth): D6+D8 - chặn enum SĐT ở otp/request, bỏ self-register ở otp/verify, audit lock
- `f20e6b8` — fix(api): D2+D3+D4 - role gate check-dup (chỉ OWNER/MANAGER), scope /tenants và /reservations
- `1553611` — fix(api): D12+D14+D15+D16 - hợp đồng theo person_id, guard xóa tầng, notification theo user, contact BQL theo tòa
- `0c60e89` — fix(db): Task 6 - 013_rls_fixes.sql SYS_ADMIN/NULL context, RLS phu floor/reservation/notification/app_user/user_role/audit_log, self & INSERT policies
- `caed793` — feat(security): D1 - bat RLS runtime: pool resihub_app + 1 client/request (set_config session) + 11 transaction thu cong co context + adminPool cho auth/seed/migrate
- `e3936c1` — test(db): Task 8 - fix leak du lieu test + them case SYS_ADMIN rieng va default-deny cho MANAGER chua gan toa
- `827282a` — fix(api): polish building creation pre-assignment, delete floor guard and resident setup tool
