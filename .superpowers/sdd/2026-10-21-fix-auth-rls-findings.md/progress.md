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

(append per task)
