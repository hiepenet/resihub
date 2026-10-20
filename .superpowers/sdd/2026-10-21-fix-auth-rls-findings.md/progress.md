# SDD ledger — plan: docs/superpowers/plans/2026-10-21-fix-auth-rls-findings.md

Workspace: D:\resihub\.superpowers\sdd\2026-10-21-fix-auth-rls-findings.md\
Branch: fix/auth-rls-runtime (cut from develop)

## Rulings (4 tinh chỉnh cuối từ partner — đã duyệt, ghi nhận như quyết định plan)

- T7: getUserClient(req) reuse `req.dbClient` nếu middleware đã cấp (release no-op; res finish/close của middleware chịu trách nhiệm RESET+release) — tránh giữ 2 connection/request. Fallback set_config khi gọi ngoài middleware. Cost if wrong: release kiến trúc 2 tầng (middleware + route) có thể hold connection quá lâu nếu route quên finally — gate bằng T9 2b pool empty check.
- T4: GET /tenants manager-scope thêm nhánh `OR NOT EXISTS (contract primary của tenant)` — cư dân mới chưa HĐ vẫn phải thấy trong dropdown lập hợp đồng (ContractsPage.jsx:265).
- T6: predicate "own-building-set" cho app_user/user_role/person là UNION của (tòa có HĐ) và (tòa có reservation theo SĐT mình) — lấy hạt cọc giữ chỗ (0900000005) vẫn thấy BQL.
- T1/T3: thêm `import 'dotenv/config';` đầu server.js + routes/auth.js + middleware/auth.js — import độc lập file không văng khi thiếu env.
- Task 3 Step 3b: test compliance OTP đổi fixture `0907778899`.

## Pre-flight: shared interfaces

- T6 (013_rls_fixes.sql) phục vụ T7 runtime: T7 chỉ hoạt động khi policy của T6 cho phép các INSERT办主任 flows (building-INSERT manager, tenant-INSERT manager, person INSERT manager/self). T7 implement sẽ đọc T6 commit trước.
- T3 sửa auth.js trước T7; T7 đổi `pool`→`adminPool` trong auth.js — T3 viết dùng pool, T7 đổi import. Không xung đột nhưng T7 phải quét lại auth.js.
- T2 refresh writes dùng pool; T7 đổi adminPool — same as above.

## Task log

- [x] **Task 0 (Commit `e6fe853`):** Cập nhật báo cáo audit, retrospective, kế hoạch fix và progress ledger.
- [x] **Task 1 (Commit `d6df3b0`):** (D5) Fail-fast khi thiếu JWT_SECRET/JWT_REFRESH_SECRET qua `api/src/config/env.js`; import `dotenv/config` đầu `server.js`, `routes/auth.js`, `middleware/auth.js`.
- [x] **Task 2 (Commit `71ea76a`):** (D7) Refresh token kiểm tra `app_user.status === 'ACTIVE'` và nạp fresh roles từ `user_role JOIN role`.
- [x] **Task 3 (Commit `46dd81e`):** (D6+D8) Chặn enum SĐT ở `/otp/request`, loại bỏ self-register ở `/otp/verify`, ghi audit log khi khóa tài khoản; cập nhật fixture test compliance sang `0907778899`.
- [x] **Task 4 (Commit `f20e6b8`):** (D2+D3+D4) Role-gating `/tenants/check-dup` (chỉ OWNER/MANAGER, ẩn CCCD/dob); Manager scoping cho `GET /tenants` (bao gồm uncontracted tenants theo Ruling #2) và `GET /reservations`.
- [x] **Task 5 (Commit `1553611`):** (D12+D14+D15+D16) Match hợp đồng theo `person_id`; guard xóa tầng với `checkBuildingAccess`; scope notification theo `user_id` và `org_id`; liên hệ BQL theo tòa cư dân đang ở.
- [x] **Task 6 (Commit `0c60e89`):** Migration `013_rls_fixes.sql` bao phủ RLS cho `floor`, `reservation`, `notification`, `app_user`, `user_role`, `audit_log`; hỗ trợ `SYS_ADMIN` và default-deny khi context NULL; dùng helper `SECURITY DEFINER SET row_security = off` triệt tiêu lỗi đệ quy `42P17`.
- [x] **Task 7 (Commit `caed793`):** (D1) Bật RLS thật tại runtime: Dual pool (`appPool` role `resihub_app` + `adminPool`), 1 client per request qua `userScope` (`AsyncLocalStorage`), Proxy pool tự động định tuyến query, 11 vị trí transaction thủ công chuyển sang `getUserClient(req)` tái sử dụng `req.dbClient` (Ruling #1).
- [x] **Task 8 (Commit `e3936c1`):** Hoàn thiện `test_rls_zero_leak.mjs`: Test case SYS_ADMIN độc lập (không có OWNER) và default-deny cho MANAGER chưa gán tòa; dọn dẹp sạch sẽ dữ liệu kiểm thử ngoài transaction.
- [x] **Task 9 (Commit `827282a` + Verification Document):** Chạy toàn bộ regression test suite:
  - `test_rls_zero_leak.mjs`: 11/11 PASS (100%)
  - `test_phase1_compliance.mjs`: 39/39 PASS (100%)
  - `test_crud_scoping.mjs`: 19/19 PASS (100%)
  - Zero connection leak sau tải đồng thời `Promise.all`.
  - Biên soạn báo cáo: `docs/superpowers/plans/2026-10-21-verification-results.md`.
