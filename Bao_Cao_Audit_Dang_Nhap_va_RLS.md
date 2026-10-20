# Báo cáo Audit: Nghiệp vụ Đăng nhập & Row Level Security (RLS)

**Mục đích:** Đối chiếu triển khai thực tế với PRD v2.0 về nghiệp vụ đăng nhập (OTP/Mật khẩu/Phiên) và phân quyền dữ liệu Tòa nhà / Căn hộ theo vai trò **OWNER / MANAGER / RESIDENT**, đánh giá "hệ thống đã hoạt động đúng nghiệp vụ chưa".

**Ngày audit:** 21/10/2026
**Tài liệu đối chiếu:** `PRD - Quan ly Can ho va Nha cho thue v2.0.md` (mục 6.2 — Ma trận RBAC, quy tắc bổ sung; mục 10 — FR-001..004, US-001/US-019 + AC-001.x/AC-019.1; mục 14.2 — Xác thực và phân quyền; NFR-008; R-08; phụ lục A-06/A-07). Trigger của audit: task "Tích hợp đăng nhập OTP qua SĐT + Thiết lập RLS để phân quyền Tòa/Căn theo OWNER, MANAGER, RESIDENT" (FRONTEND DEVELOPER Roadmap).

**Phạm vi đọc kiểm (static review):**
- Backend: `api/src/db/client.js`, `api/src/middleware/{auth,rbac,rateLimiter}.js`, `api/src/routes/{auth,buildings,apartments,contracts,tenants,reservations,deposits,resident,notifications}.js`
- DB: `api/src/db/migrations/002, 009, 010, 012`, `api/src/db/seed.js`
- Test: `api/test_rls_zero_leak.mjs`, `api/test_rbac_matrix.mjs`, `api/test_crud_scoping.mjs`, `api/test_phase1_compliance.mjs`
- Frontend: `frontend/src/router/index.jsx`, `frontend/src/stores/authStore.js`

**Hạn chế:** Database Docker (localhost:5433) **không chạy** tại thời điểm audit → không thể xác minh trực tiếp DB (pg_policies, dữ liệu seed) hay chạy `test_rls_zero_leak.mjs` live. Mọi kết luận dưới đây dựa trên code; lệnh tái lập kiểm chứng live ở mục 8.

---

## 1. Kết luận tổng quan

| Mảng | Kết luận | Ghi chú |
|---|---|---|
| Đăng nhập OTP (FR-001, FR-002) | 🟡 **Đ đạt phần lớn, còn lệch nghiệp vụ** | Đủ logic OTP 6 số/5 phút/5 lần sai/khóa 15 phút/3 tin giờ. Lệch: gửi OTP cho SĐT không tồn tại, không có người cai quản đăng ký tự động, không audit khi khóa |
| Đăng nhập email/mật khẩu (FR-003) | 🟡 Đạt cơ bản | Có bcrypt + trạng thái SUSPENDED; chưa có 2FA (PRD ghi "tùy chọn" — chậm hơn nhưng chấp nhận được ở phase này) |
| Phiên (14.2) | 🟡 Cơ bản khớp | 15m access + 7d refresh khớp PRD; **thiếu**: refresh không kiểm tra SUSPENDED, không có idle 30 phút cho role tài chính, logout không thu hồi token |
| RLS ở DB (NFR-008, mục 14.2, quy tắc "hai lớp") | 🔴 **Chưa hoạt động tại runtime** | Policy viết đúng chuẩn trong `010_rls_policies.sql` và test riêng cho RLS PASS, nhưng **app thật kết nối bằng superuser `postgres` và không bao giờ set user context** → toàn bộ RLS là dead code khi chạy thật. Bảo mật dữ liệu runtime phụ thuộc 100% vào scoping thủ công trong từng route |
| Scoping dữ liệu ở tầng API (bù cho RLS) | 🟡 Ba vai trò chính (Tòa/Căn/HĐ/Cọc) scope đúng; còn lỗ hổng lớn ở Tenants, Reservations, check-dup | Chi tiết bảng phát hiện ở mục 5 |
| Phân quyền UI (2 lớp frontend) | 🟢 Đạt | Router guard theo role, RootRedirect RESIDENT→/resident, ADMIN→/admin (đã sửa theo sprint retrospective) |

**Mức độ rủi ro tổng:** Kịch bản lạm dụng thực tế hiện tại: một RESIDENT đăng ký tự động (SĐT bất kỳ + OTP dev) có thể dùng `GET /residents/check-dup` dò toàn bộ CCCD/SĐT trong tổ chức, và xem danh sách đặt cọc của toàn bộ tòa (tên + SĐT khách tiềm năng). Đây chính xác là rủi ro R-08 "rò rỉ dữ liệu cá nhân" mà PRD ngăn bằng RLS.

---

## 2. Nghiệp vụ Đăng nhập — đối chiếu từng yêu cầu PRD

### 2.1 Bảng đối chiếu

| Yêu cầu PRD | Mô tả | Triển khai (file) | Trạng thái |
|---|---|---|---|
| FR-001 (P0) | Đăng nhập OTP qua SĐT: Nhập SĐT → nhận OTP → tạo phiên | `routes/auth.js` `POST /otp/request`, `POST /otp/verify` | 🟢 Đạt |
| AC-001.1 | OTP 6 số, hiệu lực 5 phút | `auth.js:77-78` — `Math.random()` 6 số, TTL 5 phút | 🟢 Đạt |
| AC-001.2 | Sai 5 lần → khóa SĐT 15 phút **và ghi audit**; thông báo trung lập | `auth.js:146-159` — khóa 15 phút đúng, thông báo trung lập đúng | 🟡 **Đạt 2/3: KHÔNG có ghi audit_log khi khóa** — vi phạm AC-001.2 |
| AC-001.3 | SĐT không tồn tại → cùng thông điệp, **không gửi OTP** | `auth.js:91-95` — response trung lập ✅ **nhưng luôn sinh + gửi OTP cho mọi SĐT hợp lệ về format**, kể cả không nằm trong hệ thống | 🔴 Lệch nghiệp vụ (OTP gửi "vào trống console", hại thấp trong dev, nhưng logic luôn tạo tài khoản khi verify — xem D7) |
| FR-002 (P0) | Khóa tạm sau N lần sai, giới hạn gửi lại | 5 lần sai → khóa 15 phút (L146-153); 3 lần gửi/giờ/SĐT (L50-64); rate limit IP qua `otpRequestLimiter` | 🟢 Đạt. ⚠️ Lưu ý D9 (in-memory) |
| FR-003 (P0) | Đăng nhập email/mật khẩu cho nhân sự nội bộ | `auth.js` `POST /login` — bcrypt compare, chặn SUSPENDED | 🟢 Đạt (chưa có 2FA — PRD là "tùy chọn", chấp nhận MVP) |
| FR-004 (P0) | CRUD user, gán role **scope theo tòa** | **Chưa có module quản lý người dùng/vai trò** — chỉ có gán tự động MANAGER khi tạo tòa (`buildings.js:223-232`) và script `fix_roles.js`/`setup_resident_test_accounts.js` | 🔴 Chưa làm (thuộc M01, phase S1) |
| Phiên (14.2) | JWT ngắn hạn + refresh; idle 30 phút role tài chính; 7 ngày cư dân | 15m access + 7d refresh (`auth.js:20-24`) | 🟡 Khớp 1/3; không có idle-timeout theo vai trò |
| Đổi SĐT (14.2) | Xác thực OTP số cũ + số mới | Chưa triển khai | 🔴 Chưa làm (có thể để phase sau) |

### 2.2 Lưu ý bảo mật đăng nhập

- **JWT secret fallback nằm trong code** (`auth.js:16-17`, `auth.js:14`): nếu quên biến môi trường khi lên prod,ai có source là tự làm được token. → Cao.
- `/otp/verify` trả `devOtp` về client khi `NODE_ENV !== 'production'` và nhận master OTP `123456` (L117) — dù chỉ dev, đây là cơ chế **một chữ cái cấu hình sai = bypass toàn bộ đăng nhập**; nên bắn qua biến môi trường riêng thay vì ràng buộc NODE_ENV.
- `/refresh` (`auth.js:375-402`) tạo access token mới **không truy vấn DB**: (a) không kiểm tra `app_user.status` → user bị SUSPENDED vẫn chạy tiếp trên chuyển đổi refresh token đến khi refresh token hết hạn 7 ngày; (b) roles lấy từ refresh token cũ → nháverse quyền bị gỡ vẫn có hiệu lực 15 phút *(15 phút không nghiêm, 7 ngày của refresh_token mới là điểm cần sửa — giải pháp: check status + reload roles khi refresh)*.
- OTP store `Map` in-memory (`auth.js:11`): restart Amazon mất hết mã đang chờ; chạy nhiều instance thì mã gửi bởi instance A khác xác minh tại instance B → chỉ dùng được cho deployment 1 tiến trình.

---

## 3. RLS — phân tích kiến trúc

### 3.1 Những gì đã làm đúng

- **Mô hình dữ liệu đúng thiết kế "RBAC + RLS theo org_id/building_id/contract_id"**: `organization` → `building(org_id, owner_id)` → `user_role(user_id, role_id, building_id)` (`002_organization_users.sql`, role table có `scope CHECK IN ('org','building')`).
- **`010_rls_policies.sql`** viết chuẩn PostgreSQL:
  - Turn on **FORCE RLS** cho 7 bảng: `building, apartment, contract, tenant, person, deposit, deposit_transaction` — FORCE áp cả table owner, chặt hơn ENABLE đơn thuần (sửa từ `009_rls.sql` từng chỉ ENABLE + policy `allow_all USING(true)` — đã được 010 DROP đúng).
  - Policy theo từng bảng, phân SELECT vs MODIFY, dùng các hàm `STABLE SECURITY DEFINER`: `get_current_user_id()` (từ `request.jwt.claim.sub` hoặc `app.current_user_id`), `is_org_admin()` (OWNER), `get_user_assigned_buildings()` (OWNER → toàn org, còn lại → user_role.building_id), `get_resident_tenant_ids()` (RESIDENT → tenant của mình).
  - Logic đúng ma trận 6.2: OWNER/SYS_ADMIN toàn tổ chức; MANAGER/STAFF theo tòa được gán; RESIDENT chỉ tòa/căn/hợp đồng theo `contract.primary_tenant_id`.
- **Test tự động cho policy** (`test_rls_zero_leak.mjs`) đúng kỹ thuật PostgreSQL: `BEGIN; SET ROLE resihub_app; SET LOCAL app.current_user_id = ...` — mô phỏng đúng cách Supabase/RSS sẽ chạy. Bao phủ: cư dân A không thấy hợp đồng/căn/tòa của cư dân B (zero-leak), MANAGER tòa A không thấy tòa B, OWNER/SYS_ADMIN thấy toàn org. Đây là test NFR-008 đã tính.

### 3.2 Lỗ hổng thứ nguyên — RLS không chạy khi ứng dụng thật phục vụ request

Sự việc gồm ba mảnh nối vào nhau:

1. `src/db/client.js:8-16` — pool kết nối bằng `postgres`/`postgres` (superuser) qua `DATABASE_URL` từ `.env`: `postgres://postgres:postgres@localhost:5433/resihub`.
2. **Superuser PostgreSQLalways BYPASS RLS** — mọi policy của 010 bị bỏ qua tập trung với các request thật, kể cả FORCE RLS.
3. Mã runtime (`src/`) **không bao giờ** `SET ROLE resihub_app` và **không bao giờ** `SET LOCAL app.current_user_id` — grep toàn bộ `src/` chỉ thấy hai lệnh này xuất hiện *duy nhất trong `test_rls_zero_leak.mjs`* (L174-175, 197-198, 227-228, 268-269).

Hệ quả: **câu trả lời cho câu hỏi "RLS đã phân quyền đúng chưa" là — chưa, ở trạng thái này RLS chỉ tồn tại trong bài test riêng, không tồn tại trong hệ thống đang chạy.** Bài test PASS vì nó tự dựng 2 điều kiện (SET ROLE + SET context) mà runtime thật không có. Audit log hiện tại của trình đăng nhập (`Code: 'RLS đã bật'` trong báo cáo Phase 1) nắm đúng policy trên giấy, sai trên thực tế.

Bảo mật dữ liệu đang được bảo đảm một cách "trung gian" bằng scoping thủ công trong từng route (mục 5) — càng đúng cuốn "hai lớp" mục 6.2 thì class router càng là lớp phi-thiết-kế, vì lack RLS làm xuất hiện lớp đơn duy nhất, và mỗi route mới là một cơ hội quên scope → rò rỉ chéo tòa hoàn toàn (xanh chứng D2/D4 dưới đây đã xảy ra).

### 3.3 Chi tiết khác của policy cần chỉnh trước khi bật RLS thật

| # | Vấn đề | Vị trí/chi tiết | Ảnh hưởng |
|---|---|---|---|
| R1 | `is_org_admin()` trả **TRUE khi không có user context** (`010:49-52`) | Còn OK cho cron/migration, NHƯNG khi switch runtime sang `resihub_app` mà quên set context, RLS trắng tay toàn hệ thống — phải đổi thành `RETURN FALSE` + whitelist job riêng | Cao |
| R2 | `is_org_admin()` chỉ check `r.code = 'OWNER'`, **KHÔNG check SYS_ADMIN** (`010:54-60`) | User chỉ có role SYS_ADMIN sẽ **không thấy gì** dưới RLS (chỉnh sửa: `IN ('OWNER','SYS_ADMIN')`) — test 4 chỉ pass vì seed có user OWNER | TB |
| R3 | Policy chưa phủ đủ bảng | `floor`, `reservation`, `notification`, `audit_log`, `app_user`, `user_role` vẫn không RLS — NFR-008 yêu cầu "mọi bảng chứa dữ liệu theo tòa/hợp đồng"; floor/reservation có `building_id` | TB |
| R4 | Policy MODIFY kiểu "SELECT-derived" | `rls_deposit_modify: contract_id IN (SELECT id FROM contract)` — subquery này chạy **dưới RLS của contract**, tạo policy phụ thuộc tầng lên tầng: RESIDENT chỉ thấy các deposit của HĐ của mình (đúng), MANAGER qua scope tòa (đúng) — hiện đúng hành vi nhưng có thể bị phá khi sửa contract policy | Thấp (thiết kế) |
| R5 | Xuất hiện một mô hình câu lệnh modify chưa đủ | `tenant/person MODIFY` chỉ cho `is_org_admin()` → khi bật RLS thật, `POST /resident/rental-application` (cư dân tự update `person`, và POST `/otp/verify` tự INSERT `person` mới) sẽ **đrapper fail** → cần policy "self" + luồng BQL duyệt | TB |
| R6 | Test RLS không dọn dữ liệu | TEST 4 xóa dữ liệu test ngay trong transaction rồi release client không COMMIT/ROLLBACK → cleanup bị rollback, mỗi lần chạy test rải rác thêm 3 person + 2 building trong DB | Thấp |
| R7 | `resihub_app` password hard-code trong migration (`010:9`) | Nên tạo role `NOLOGIN` + dùng `SET ROLE` hoặc password từ secret | Thấp |

### 3.4 Lộ trình bật RLS thật (khuyến nghị tối giản)

1. `db/client.js`: đổi connection sang user `resihub_app` (đã GRANT ALL trong 010), hoặc gán `SET ROLE resihub_app` ngay khi check-out client từ pool (pool.js có `connection` hook).
2. Thêm middleware `rlsContext`: `SET LOCAL app.current_user_id = '${req.user.sub}'` trong mỗi transaction tea/và `BEGIN` cho mỗi pool client; sửa `is_org_admin()` bỏ-case-NULL thành FALSE.
3. Bổ sung policy cho `floor`, `reservation`, `user_role`, `app_user`, `audit_log` + policy self cho `person`/`tenant` (khoản R5).
4. Chạy lại `test_rls_zero_leak.mjs` **và một test mới gồm call API qua HTTP** (đang thiếu: test hiện kiểm RLS trực tiếp ở DB, không kiểm bảo đảm API thật đúng scope).

---

## 4. Phân quyền dữ liệu runtime hiện tại (theo vai trò: OWNER / MANAGER / RESIDENT)

Phần này đánh giá **scoping thủ công trong route** — lớp bảo mật duy nhất thực sự hoạt động của hệ thống lúc này.

### 4.1 Tòa nhà (`routes/buildings.js`) — 🟢 Đạt

| Hành động | OWNER | MANAGER | RESIDENT | PRD 6.2 |
|---|---|---|---|---|
| GET / | org → toàn bộ tòa (L114-129) | scope `user_role.building_id` (L131-136) | scope qua contract.tenant (L137-145) | ✅ |
| POST / | 403 | được + tự gán quyền + audit (L162-240) | — | ✅ |
| GET /:id | `checkBuildingAccess` L14-65, `org_id` bắt buộc | ✅ theo building scope | ✅ theo contract | ✅ |
| PATCH status | 403 | scoped + chặn khi còn HĐ ACTIVE + audit | — | ✅ |
| DELETE floor | → luôn 403 `DELETE_PROHIBITED` | (chưa check access scope — D18) | — | ✅ |

### 4.2 Căn hộ (`routes/apartments.js`) — 🟢 Đạt

- GET: ENTRY 3 role đúng scope giống buildings.
- POST/PATCH: `requireRole MANAGER` + check `user_role.building_id` không được (L85-94, L141-153) + audit before/after (FR tương thích AC-020.1).
- DELETE: luôn 403 (đúng quy tắc CRU).

### 4.3 Hợp đồng (`routes/contracts.js`) — 🟢 Đạt cơ bản

- GET /: OWNER toàn org + MANAGER scope tòa + RESIDENT theo `p.id = person_id` ✅.
- GET /:id: MANAGER check tòa; RESIDENT so khớp `tenant_phone`/`tenant_email` với JWT (L95-99) — **so khớp phone/email thay vì person_id**: nếu cư dân hợp lệ có `phone` NULL trong DB → bị block lỗi sai left (không rò rỉ dữ liệu, chỉ UX). Khuyến nghị so `p.id = person_id`.
- POST + terminate: MANAGER/OWNER + chặn chồng lấn kỳ hạn.

### 4.4 Cọn — Cọc (`routes/deposits.js`) — 🟢 Đạt

- GET: 3 role + scope ngược từ contract theo building hoặc person_id (L37-45) ✅.
- POST transactions: OWNER/MANAGER + ràng buộc "cấm cấn trừ tiền thuê" theo FR-068 (L69-71) ✅.

### 4.5 Hành lang Cư dân (`routes/resident.js`) — 🟡 Scope OK dữ liệu cá nhân, lệch nhỏ

- overview: hợp đồng/cọc/hồ sơ đều filter theo `person_id` của chính user ✅; reservation theo SĐT ✅.
- ⚠️ `manager_contact` (L137-146): `WHERE r.code='MANAGER' LIMIT 1` — **không scope theo tòa**, trả lộ contact (tên/SĐT/email) của **BQL tòa bất kỳ** cho cư dân — nhỏ nhưng lệch nguyên tắc PII.
- ⚠️ `available_apartments` (L123-134): trả căn trống **toàn bộ tổ chức**, không filter theo tòa của cư dân. Nếu đây là hành chủ định "khám phá căn trống" → khai báo allow-list, nếu không → phạm vi lộng cho RESIDENT.
- service-requests chỉ ghi vào `audit_log`, chưa có bảng parity `service_request` thực → dữ liệu chỉ ở dạng audit entry (module FR-042 chưa có hoàn chỉnh).

### 4.6 Frontend (router + store) — 🟢 Đạt

- `RoleRoute` guard từng route; `/admin/*` chỉ cho `[OWNER, MANAGER]`, `/resident` chỉ `[RESIDENT]` — khớp bài học trong Sprint Retrospective (RootRedirect).
- Role lấy cố định từ CSDL (JWT), chặn `setActiveRole` từ client.
- ⚠️ `getCurrentRole` lấy `roles[0]` — nếu một user có nhiều role (MANAGER + RESIDENT), vai trò "đầu danh sách" quyết định màn hình → về sau multi-role là các vai trù tối con; hiện là safe (1 role 1 user ở Phase 1).
- ⚠️ Token/code user lưu `localStorage` → XSS sẽ dễ thiệt hại; nhưng có `AccessDenied` và ProtectedRoute đã đủ cho Phase 1.

---

## 5. Bảng Phát hiện (Findings) — xếp hạng theo nghiêm trọng

### 🔴 Mức CAO

| ID | Phát hiện | Vị trí | Đối chiếu PRD | Khuyến nghị |
|---|---|---|---|---|
| **D1** | **RLS không hoạt động tại runtime** — pool nối bằng superuser `postgres`, runtime không set `app.current_user_id`, mọi policy 010 là dead code | `db/client.js:14`; grep toàn `src/`; `010_rls_policies.sql` | 14.2 "RLS PostgreSQL theo org_id/building_id/contract_id"; NFR-008 "RLS bật trên mọi bảng"; quy tắc 6.2 "hai lớp, không tin client" | Trình theo 3.4: switch role + middleware context + bổ sung policy; chấm dứt trạng thái "test-only RLS" |
| **D2** | **`GET /tenants/check-dup` không phân quyền, trả về toàn bộ dòng `person`** kèm đầy đủ PII (name, phone, email, dob, **id_number/CCCD**) khi khớp điều kiện → cư dân tự đăng ký có thể dò toàn bộ CCCD/SĐT tổ chức | `tenants.js:12-45` | R-08 Rủi ro rò rỉ PII; AC-019.1; US-001-STAFF "không thấy CCCD..." | Thêm `requireRole(['MANAGER'])` + scope theo building + chỉ trả `{isDuplicate}` (không trả rows) |
| **D3** | `GET /tenants` (OWNER/MANAGER) **MANAGER không scope theo tòa** — `WHERE t.org_id = $1` → MANAGER tòa A thấy PII toàn bộ cư dân toàn bộ tòa | `tenants.js:51-63` | 6.2 bảng Cư dân: MANAGER R theo tòa; AC-019.1 "không lộ dữ liệu tòa B" | Thêm `AND t.person_id IN (...) HĐ tòa tôi quản lý` hoặc join contract scope building |
| **D4** | `GET /reservations` không `requireRole` cũng không scope theo building — mọi vai trò (kể cả RESIDENT) xem toàn bộ đặt cọc giữ chỗ (tên khách + SĐT) của org | `reservations.js:12-49` | 6.2 "Cọc: RESIDENT R"; PII khách tiềm năng | `requireRole(['OWNER','MANAGER'])` + scope building cho MANAGER; RESIDENT → chỉ reservation theo phone của mình |
| **D5** | JWT secret default hard-code, đặc biệt khi `.env` thiếu | `routes/auth.js:16`, `middleware/auth.js:14` | 14.5 "bí mật lưu secret manager"; R-08 | Remove fallback; fail fast startup nếu thiếu `JWT_SECRET` |

### 🟠 Mức TRUNG BÌNH

| ID | Phát hiện | Vị trí | Đối chiếu | Khuyến nghị |
|---|---|---|---|---|
| **D6** | `/otp/request` luôn gửi OTP cho mọi SĐT hợp lệ (kể cả không tồn tại) — vi phạm AC-001.3 "không gửi OTP"; cộng `/otp/verify` **tự tạo `person` + `app_user` + role RESIDENT cho SĐT lạ** (self-registration không có ai chủ quản) | `auth.js:77-95, 167-209` | AC-001.3; luồng 7.1 " kích hoạt tài khoản cư dân" sau Bàn giao | Kiểm tra SĐT có tồn tại (person/tenant ACTIVE) trước khi xin OTP; verify phải chặn khi không có hồ sơ sẵn — cho phép RESIDENT đăng ký qua luồng FR-012 riêng |
| **D7** | `/refresh` không kiểm tra `app_user.status`, roles giữ từ refresh token cũ → user SUSPENDED/gỡ quyền còn chạy tiếp đến khi refresh hết hạn 7 ngày | `auth.js:375-402` | 14.2 "phiên", AC-019.1 đúng mục nghĩa | Reload `app_user.status` + refresh roles từ DB mỗi lần refresh |
| **D8** | **Không có audit_log khi khóa SĐT 15 phút** | `auth.js:148-154` | AC-001.2 "ghi audit" | INSERT audit_log khi lock |
| **D9** | OTP + rate tracker in-memory | `auth.js:11-14` | FR-002 vận hành | Chấp nhận 1 instance; khi scale/ restart → chuyển bộ nhớ sang Redis/bảng `otp_challenge` |
| **D10** | RLS policy chưa đoan chu SYS_ADMIN + TRUE-when-no-context | `010_rls_policies.sql:49-60` | 6.2 "OWNER/SYS_ADMIN xem toàn bộ" | Sửa cả 2 hàm; thêm test case SYS_ADMIN-riêng |
| **D11** | `is_org_admin()` bỏ qua kiểm ATTACK-VECTOR — Manager tạo nhiều `user_role` trùng role qua `POST /buildings` chỉ thêm building_id (đang safe vì INSERT only vào building mình tạo) | `buildings.js:223-232` | — | OK giai đoạn này; lưu ý khi có module FR-004 |
| **D12** | `GET /contracts/:id` RESIDENT so khớp phone/email thay vì `person_id` — đủ chặn chính xác, nhưng user.pmh 'phone NULL' bị block lỗi sai | `contracts.js:95-99` | US-002 | So `p.id = req.user.person_id` |
| **D13** | RLS chưa phủ `floor`, `reservation`, `notification`, `audit_log`, `user_role`, `app_user` | `010_rls_policies.sql` | NFR-008 | Bổ sung policy từng bảng khi bật RLS thật |

### 🟡 Mức THẤP

| ID | Phát hiện | Vị trí | Khuyến nghị |
|---|---|---|---|
| D14 | `DELETE /buildings/:id/floors/:floor_id` chỉ authenticate — không check tòa/floor scope; kết quả chỉ là số căn hộ (info leak nhẹ) | `buildings.js:475-495` | Thêm `checkBuildingAccess('delete')` trước |
| D15 | `PATCH /notifications/:id/read` thiếu `user_id`/`org_id` check → cư dân mark-read thông báo của người khác | `notifications.js:44-59` | Thêm `AND user_id = user` / NULL |
| D16 | `manager_contact` trong resident/overview không scope tòa, trả contact của một BQL bất kỳ | `resident.js:137-146` | Filter theo building của hợp đồng cư dân |
| D17 | `available_apartments` trả toàn org | `resident.js:123-134` | Cần xác nhận chủ định; nếu không → filter theo tòa cư dân |
| D18 | Logout không thu hồi token (không blacklist/shorten refresh) | `auth.js:414-416` | Chấp nhận Phase 1; cân nhắc access token TTL ngắn + rotation refresh |
| D19 | Test RLS leak dữ liệu test (transaction chưa commit) | `test_rls_zero_leak.mjs:279-286` | COMMIT hoặc di chuyển cleanup ra ngoài transaction |
| D20 | Chưa có `audit_log` cho thay đổi phi tra/danh sách, và không kiểm tra thay đổi quyền có eid — module FR-004 chưa có nên chưa được đánh giá |

### ✅ Các tính năng đã đối chiếu PASS (summarize)

- OTP flow, rate-limit 3/giờ/SĐT + IP, lock 5 lần / 15 phút — logic + thông điệp chính xác FR-002 / AC-001.1-2 (trừ audit).
- Login email/password + bcrypt + kiểm tra SUSPENDED + source PII từ DB — FR-003.
- JWT 15m + refresh 7d — 14.2.
- Scoping OWNER/MANAGER/RESIDENT trên **buildings, apartments, contracts (list), deposits** — giống ma trận 6.2: OWNER R toàn tổ chức; MANAGER CRU theo tòa được gán (user_role.building_id); RESIDENT R theo hợp đồng/hợp đồng của mình. POST/PATCH đều kiểm tra quyền quản lý tòa + ghi audit_log.
- Màn hình frontend guard đúng vai trò + `AccessDenied` + RootRedirect — khớp bài học Sprint Retrospective.
- RBAC standard 3+ vai trò chuẩn化了 (012 REMOVE deprecated) — Báo cáo Sprint mốc "Chuẩn hóa đúng 3 vai trò OWNER/MANAGER/RESIDENT" đạt.

---

## 6. So với PRD — bất cập cấu trúc lớn

1. **"Hai lớp: UI + RLS, không tin client" (6.2/217)** — hiện chỉ đạt 1 lớp và là **UI + route-level**, không phải RLS. Đây là enjoy-meaning khoảng cách lớn nhất để "hệ thống hoạt động đúng nghiệp vụ".
2. **RBAC chỉ có hàm `requireRole` (role-code) — chưa có "cấu trúc quyền" từng module** (guest `permission` bảng chưa được dùng trong mã), và chưa có **FR-004 quản lý người dùng + gán role theo tòa** (phase S1 chưa hoàn thành vì vậy RESIDENT/OWNER phải config thủ công bằng script JS).
3. **Bảo mật RLS áp dụng các bảng chính, các bảng dữ liệu theo tòa như Đặt cọc giữ chỗ không nằm trong chính sách 010.**
4. **Đổi SĐT (14.2), idle-30 phút cho vai trò tài chính, 2FA** — chưa làm (ít mức nghèo khổ hơn và xếp hạng có thể chuyển Phase 2 với chú thích "Chưa làm trong S1").

---

## 7. Verdict cho một audit "hệ thống đã hoạt động đúng nghiệp vụ chưa"

**Câu trả lời: Đạt cải thiện (các luồng traffic hiện tại scope tốt) — NHƯNG chưa hoàn thành nhiệm vụ cốt lõi của Công việc hiện tại (Hiep): "Thiết lập RLS để đảm bảo dữ liệu Tòa/Căn phân quyền theo OWNER/MANAGER/RESIDENT" — vì RLS đang là dead code khi hệ thống thực phục vụ người dùng thực.**

- Nếu ngân sách thời gian hạn chế: đa số rủi ro mức cao phát hiện ở đây sẽ bị đóng bởi ưu tiên làm **3 việc** (giám sát tốc độ nhất):
  1. Runtime RLS thật: switch role + middleware `app.current_user_id` (D1) + sửa policy `(D10, D13)`;
  2. Ch untersuch3 API lún PII: `tenants/check-dup`, `GET /tenants` scope, `GET /reservations` (D2, D3, D4);
  3. Quy trình `/refresh` kiểm `status` + tạo lại roles (D7).

## 8. Lệnh tái lập kiểm chứng (khi DB Docker online)

```bash
docker compose -f docker-compose.dev.yml up -d
cd api && node src/db/migrate.js && node src/db/seed.js
node test_rls_zero_leak.mjs          # RLS pass ở tầng DB
node test_rbac_matrix.mjs            # RBAC qua HTTP (cần API chạy: node src/server.js)
node test_crud_scoping.mjs
```

Kiểm tra trực diện "RLS dead code tại runtime": chạy API → login bằng user MANAGER (tòa A) → `GET /api/v1/buildings` chỉ thấy tòa A (gián tiếp scope route), và dùng SQL probe `SET ROLE resihub_app; SET LOCAL app.current_user_id = '...user A...'; SELECT * FROM contract;` để đối chứng policy đang đúng.

---

*Phía dưới báo cáo: không có bằng chứng runtime (DB offline) — các mục 1-7 dựa trên phân tích tĩnh; mục 8 để phục hồi tính chính xác tập kiểm sự thật đầy đủ.*
