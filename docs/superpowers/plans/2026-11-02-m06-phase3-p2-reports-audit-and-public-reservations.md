# Chuẩn hóa Giai đoạn 3 (P2) — Báo cáo Sổ cọc `RP-07`/`RP-08`, Nhật ký Kiểm toán & Cổng Đặt giữ chỗ Công khai Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hoàn thiện toàn bộ nhóm tính năng `P2` của phân hệ Tiền cọc & Đặt giữ chỗ (`M06`) bám sát 100% PRD v2.0: xây dựng Báo cáo `RP-07 — Sổ cọc` (xuất Excel `.xlsx` & CSV UTF-8 BOM, kèm đối soát giữ chỗ), xuất CSV Nhật ký thao tác tài chính `RP-08`, KPI cảnh báo Dashboard có drill-down và báo cáo định kỳ đầu tháng gửi `OWNER` (`GAP-05`), tích hợp tab `"Lịch sử kiểm toán"` ngay trong chi tiết sổ cọc (`GAP-07`), quản trị cấu hình chính sách hủy giữ chỗ làm tròn hàng nghìn VND (`FR-005`/`FR-067`), và mở Trang chủ công khai `/` & `/explore` cho khách vãng lai đặt giữ chỗ xác thực OTP theo luồng nhân sự xác nhận sao kê thủ công `PENDING_CONFIRM` (`PRD 5.3`, `GAP-06`).

**Architecture:** Tổng hợp `RP-07` trực tiếp từ sổ cái bất biến `deposit_transaction` theo cột định danh cấu trúc `category IN ('TRANSFER_OUT', 'TRANSFER_IN')` (kèm fallback dữ liệu cũ) kết hợp khối đối soát phụ `reservation_summary` tách riêng tiền đang giữ (`HELD`) khỏi phiếu chờ đối chiếu sao kê (`PENDING_CONFIRM`), xuất tệp qua `api/src/utils/csv.js` (hỗ trợ cả `.xlsx` OpenXML chuẩn không phụ thuộc thư viện ngoài dùng `node:zlib` lẫn CSV UTF-8 BOM chống CSV/Excel Formula Injection). Mở rộng migration `046` nối tiếp `044` & `045` để: bổ sung `'receivable'` vào `rls_audit_log_select`, mở `rls_reservation_update` cho `'PARTIALLY_REFUNDED'`, mở `can_select_attachment` cho `owner_entity = 'reservation'`, chuẩn hóa `idempotency_key.scope_key` trên cột phẳng (`UNIQUE (org_id, scope_key, method, route_path, idem_key)`), và bổ sung trạng thái `'PENDING_CONFIRM'` / `'REJECTED'` / `'PARTIALLY_REFUNDED'` cho `reservation`. Tách dịch vụ OTP dùng chung `api/src/services/otpService.js` giữa `/api/v1/auth/otp/*` và `/api/v1/public/reservations/*`, thực thi giao dịch công khai qua `adminPool` có khóa `org_id` + bảo vệ hồ sơ `FR-021`/`isInternalPerson`, giữ căn hộ ở `'AVAILABLE'` cho tới khi `MANAGER` đối chiếu sao kê xác nhận `PATCH /api/v1/reservations/:id/confirm-payment` (`PRD 5.3`).

**Tech Stack:** Node.js (ESM, `node:zlib`, `node:crypto`), Express 4, PostgreSQL 16 (RLS + `FORCE ROW LEVEL SECURITY` + `SECURITY DEFINER` helpers), `node:test`, React 19, React Router 7, Vite 8, Tailwind CSS.

**Spec:** `PRD - Quan ly Can ho va Nha cho thue v2.0.md` (Mục 2 dòng 41, Mục 5.3 dòng 141, Mục 6.2 dòng 189–205, Mục 8.1 dòng 275–283, Mục 8.2 dòng 316, Mục 10.3 dòng 606, Mục 13.5–13.6 dòng 859 & 920, Mục 14.2–14.3 dòng 958 & 990, Mục 15.1–15.3 `RP-07` & `RP-08` dòng 1028–1074, Mục 17.1 dòng 1171, Mục 23.A.6 dòng 1418, `FR-002`, `FR-005` dòng 360, `FR-021` dòng 385, `FR-024` dòng 518, `FR-037` dòng 409, `FR-067` dòng 584, `FR-070` dòng 789, `AC-001.2` dòng 651, `AC-001.3` dòng 652, `R-02` dòng 1312) & `docs/BAO_CAO_RA_SOAT_THU_HOAN_COC_M06.md` (`GAP-05`, `GAP-06`, `GAP-07`).

**Prerequisite (Bắt buộc thực thi tuần tự trước Giai đoạn 3):**
1. Hiện cây migration trong repo đang dừng ở `043_service_subscription_vehicle_plates.sql`.
2. Phải hoàn tất **Giai đoạn 1** (`docs/superpowers/plans/2026-11-02-m06-phase1-p0-deposit-safety-and-reservations.md` — migration `044`, `DEDUCTED_FULL`, `isPositiveSafeIntegerVnd`, `validateRefundBankInfo`, `getTodayVnDateStr`, `idempotencyGuard`) và **Giai đoạn 2** (`docs/superpowers/plans/2026-11-02-m06-phase2-p1-owner-approval-payout-returned-rls.md` — migration `045`, `APPROVED_PENDING_PAYOUT`, `RETURNED`, `refund_reversal`, `fn_get_deposit_access_meta`, `fn_sync_apartment_status_after_reservation`, `building_has_active_owner`, gỡ `adminPool` khỏi `deposits.js`) trước khi chạy kế hoạch này.

## Global Constraints

- **Cân đối Sổ cái `RP-07`, Phân loại `category` Cấu trúc & Tách sổ Giữ chỗ (`GAP-05`, PRD Mục 15.2 dòng 1050):** Mọi kỳ báo cáo `[from_date, to_date]` bắt buộc thỏa đẳng thức kế toán trên từng sổ và toàn tòa: `opening_held + collected + transfer_in + refund_reversed - deducted - refunded - transfer_out === closing_held` (khi `to_date >= hôm nay`, `closing_held === SUM(deposit.amount_held)`, bao gồm cả các sổ đang ở `APPROVED_PENDING_PAYOUT` hoặc `RETURNED`). Bút toán `type = 'transfer'` được ghi kèm `category = 'TRANSFER_OUT' | 'TRANSFER_IN'` trong `contracts.js` (migration `046` backfill dữ liệu cũ; khi truy vấn dùng `COALESCE(dt.category, CASE WHEN dt.description ILIKE 'Chuyển kết dư%' THEN 'TRANSFER_OUT' ELSE 'TRANSFER_IN' END)`), **tuyệt đối không** dựa vào `deposit.status = 'TRANSFERRED'`. Khối `reservation_summary` chỉ cộng phiếu `'HELD'` đã xác nhận tiền vào `active_held_amount`, tách riêng phiếu `'PENDING_CONFIRM'` vào `pending_confirm_count` / `pending_confirm_amount`.
- **Xuất Excel `.xlsx` & CSV An toàn cho `RP-07` và `RP-08` (PRD Mục 15.2 dòng 1050–1051):** `RP-07` hỗ trợ cả `format=xlsx` (`application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`, đúng cột Định dạng `Excel` của PRD 15.2) lẫn `format=csv`; `RP-08` hỗ trợ `format=csv` kèm bộ lọc `scope=financial` (`entity IN ('invoice', 'payment', 'receivable', 'deposit', 'deposit_transaction', 'reservation')`). Mọi ô chuỗi bắt đầu bằng `=`, `+`, `-`, `@`, `\t`, `\r` đều bị tiền tố `'`; các chuỗi chữ số bắt đầu bằng `0` (SĐT, STK) được bảo toàn kiểu chuỗi (`inlineStr` trong `.xlsx`, tiền tố `'` bọc `"..."` trong `.csv` kèm UTF-8 BOM `\uFEFF`).
- **Drill-down Dashboard & Báo cáo định kỳ gửi Chủ nhà (`FR-024` dòng 518, PRD Mục 15.1 & 15.3 dòng 1074, `NFR-017`):** Các thẻ KPI cảnh báo trên `DashboardPage.jsx` dẫn thẳng tới danh sách bản ghi gốc kèm query filter (`/admin/deposits?tab=pending`, `?tab=payout`, `?overdue=1`, `?status=DISPUTED`) và `DepositsPage.jsx` tự động áp bộ lọc từ URL. `runDailyJobs()` gửi thông báo `MONTHLY_DEPOSIT_REPORT` kỳ tháng liền trước (`prevPeriod = YYYY-MM`) đúng `1 lần/tháng/tòa` cho `OWNER` đang `ACTIVE`.
- **Nhật ký kiểm toán Sổ cọc Xuyên suốt & RLS (`GAP-07`, PRD Mục 6.2 & 8.2):** Kế thừa `rls_audit_log_select` từ `038` & `045` và bổ sung thực thể `'receivable'` cho cả nhánh `is_owner()` và `is_manager()`. `GET /api/v1/deposits/:id/audit-logs` thực thi 100% qua `getUserClient(req)` + `fn_get_deposit_access_meta` (không dùng `adminPool` trong `deposits.js`), hợp nhất lịch sử của `deposit`, `deposit_transaction` thuộc sổ **và** `reservation` gốc (`d.source_reservation_id`).
- **Chính sách Hủy Giữ chỗ Làm tròn Hàng nghìn VND & RBAC PRD 6.2 (`FR-005`, `FR-067`, PRD Mục 10.3 dòng 606, Mục 23.A.6 dòng 1418, `R-02`):** Khóa `system_setting` `'reservation_cancel_policy'` lưu các tham số mặc định có thể cấu hình theo từng tổ chức `{ max_hold_days: 30, public_max_hold_days: 7, full_refund_before_days: 3, partial_refund_pct: 50, default_hold_amount: 2000000 }` (chờ CĐT chốt số chính thức theo PRD 23.A.6). Công thức gợi ý chia hoàn/phạt bắt buộc làm tròn đến **hàng nghìn VND** (`ROUND(x, -3)` qua `roundVND`, phần phạt `= hold_amount - refunded_amount`). `PATCH /:id/cancel-settle`, `forfeit`, `refund` chỉ cho phép người có quyền duyệt theo PRD 6.2 (`OWNER` tòa nhà, `MANAGER` thứ 2 thỏa Four-Eyes so với `COALESCE(confirmed_by, created_by)`, hoặc `SYS_ADMIN` **chỉ khi** `!building_has_active_owner(building_id)`), đồng bộ trạng thái phòng qua `fn_sync_apartment_status_after_reservation`, bắt buộc `validateRefundBankInfo` khi `refunded_amount > 0 && refund_method === 'BANK_TRANSFER'`, và gắn cờ `policy_override` vào `audit_log` nếu chia khác mức gợi ý của chính sách.
- **Đặt Giữ chỗ Công khai Theo Luồng Xác nhận Thủ công `PENDING_CONFIRM` (Phương án A — PRD Mục 2 dòng 41, Mục 5.3 dòng 141, `FR-021`, `FR-037`, `FR-070`, `AC-001.2`, `AC-001.3`, Mục 8.1, 13.5–13.6, 14.2–14.3, 17.1):**
  - Đường dẫn gốc `/` khi chưa đăng nhập hiển thị `PublicExplorePage` (`H1` Giới thiệu tòa nhà & tiện ích, `H2` Căn trống & bộ lọc, `H3` Đặt giữ chỗ online kèm VietQR/`payment_account` theo `building.org_id`, `L` Đăng nhập OTP).
  - Dùng chung `otpService` giữa `/api/v1/auth/otp/*` và `/api/v1/public/reservations/*` (`3 lần gửi/giờ/SĐT`, TTL `5 phút`, sai quá `5 lần` khóa SĐT `15 phút` trả `429 TOO_MANY_ATTEMPTS` + ghi `audit_log`, không mở bypass `123456` trên luồng đặt chỗ công khai). `POST /public/reservations/otp/request` luôn trả thông điệp trung lập đồng nhất (`AC-001.3`).
  - `POST /api/v1/public/reservations` chạy qua `idempotencyGuard` với cột phẳng `scope_key = 'public:' + cleanPhone` (replay trước khi tiêu thụ OTP) và transaction `adminPool.connect()` khóa chặt `org_id` từ căn hộ: chặn SĐT nhân sự nội bộ (`isInternalPerson` → `409 INTERNAL_ACCOUNT_PHONE`), không ghi đè `full_name`/`id_number` của `person` hiện hữu (`FR-021`), bắt buộc `privacy_consent === true` (`PRD 17.1`) + `evidence.length >= 1`, tạo `reservation(status='PENDING_CONFIRM', source='PUBLIC')` mà **chưa khóa căn hộ sang `RESERVED`**.
  - Chỉ khi `MANAGER` của tòa đối chiếu sao kê và gọi `PATCH /api/v1/reservations/:id/confirm-payment` thì phiếu mới chuyển sang `'HELD'` và căn hộ chuyển sang `'RESERVED'` (hoặc gọi `PATCH /:id/reject-payment` chuyển sang `'REJECTED'`, không ghi nhận tiền phạt).

## Review Focus

1. **Chuỗi hợp đồng gia hạn rồi chuyển phòng (`HĐ1 → HĐ2 → HĐ3`) kết hợp sổ chờ chi `APPROVED_PENDING_PAYOUT` và hoàn trả lệnh chi `RETURNED`:** Trên `dep2` (`status = 'TRANSFERRED'`, vừa có 1 dòng `TRANSFER_IN` vừa có 1 dòng `TRANSFER_OUT`), `GET /api/v1/reports/deposit-ledger` phải tính `transfer_in === transfer_out` và `closing_held === 0`; trên toàn tòa `closing_held` khớp tuyệt đối `SUM(deposit.amount_held)` và tệp xuất `.xlsx` / `.csv` đều escape công thức độc hại `=CMD|' /C calc'!A0` + giữ nguyên số `0` đầu của SĐT `0909123456` (kiểm thử tại Task 1 & Task 2).
2. **Chống khóa phòng ảo (Room-locking DoS) & Tranh chấp xác nhận sao kê khi 2 khách cùng đặt online 1 căn `AVAILABLE` (Phương án A — `PRD 5.3`):** Hai khách vãng lai gửi `POST /api/v1/public/reservations` hợp lệ cho cùng 1 căn `AVAILABLE` đều nhận `201` với `status = 'PENDING_CONFIRM'`, căn hộ vẫn `'AVAILABLE'` và `reservation_summary.active_held_amount` vẫn bằng `0`; khi `MANAGER` gọi `PATCH /:id/confirm-payment` cho khách 1 → khách 1 sang `'HELD'`, căn hộ sang `'RESERVED'`; `MANAGER` gọi tiếp `confirm-payment` cho khách 2 → bị chặn `409 APARTMENT_NOT_AVAILABLE`, sau đó gọi `reject-payment` → `'REJECTED'` với `forfeited_amount = 0` (kiểm thử tại Task 3).
3. **Bảo vệ danh tính nội bộ & Hồ sơ cư dân hiện hữu (`FR-021`) + Chia sẻ bộ đếm OTP chống lách luật (`AC-001.2`, `AC-001.3`):** Nhập sai OTP 3 lần ở `/api/v1/auth/otp/verify` rồi nhập sai thêm 2 lần ở `/api/v1/public/reservations` trên cùng SĐT phải kích hoạt khóa 15 phút ngay ở lần thứ 5 (`429 TOO_MANY_ATTEMPTS`); dùng SĐT của `OWNER`/`MANAGER` đặt giữ chỗ công khai bị chặn `409 INTERNAL_ACCOUNT_PHONE` (không bị gắn role `RESIDENT`); dùng SĐT cư dân đang có HĐ `ACTIVE` để đặt thêm căn mới không làm thay đổi `person.full_name` cũ (kiểm thử tại Task 3).
4. **Tương thích RLS `045` khi `OWNER` duyệt `cancel-settle` hoàn một phần (`PARTIALLY_REFUNDED`) & Làm tròn hàng nghìn `ROUND(x, -3)` (`PRD 6.2`, `PRD 10.3`):** Với `hold_amount = 1.050.000 ₫` và `partial_refund_pct = 33` (`346.500 ₫`), `computeSuggestedCancelSplit` phải làm tròn đến hàng nghìn thành `{ refunded_amount: 347000, forfeited_amount: 703000 }`; khi `OWNER` tòa nhà gọi `PATCH /:id/cancel-settle` trên phiếu `'HELD'` hoặc `'EXPIRED'` chưa hạch toán (kèm `refund_bank_info`), giao dịch qua `getUserClient(req)` thành công `200 PARTIALLY_REFUNDED` mà không dính lỗi RLS trên `reservation` hay `apartment`, trong khi `SYS_ADMIN` gọi trên tòa đã có `OWNER` active bị chặn `403` (kiểm thử tại Task 3 & Task 4).
5. **Replay `Idempotency-Key` trên cột phẳng `scope_key` cho cả route JWT và route công khai (không lỗi PostgreSQL `42P10`):** Ngay từ Task 1 khi migration `046` đổi sang `UNIQUE (org_id, scope_key, method, route_path, idem_key)`, các route có JWT (`POST /api/v1/reservations`, `POST /api/v1/deposits/:id/transactions`) phải ghi `scope_key = 'user:' + actorId` không ném `42P10`; ở Task 3, gửi lại `POST /api/v1/public/reservations` với cùng `Idempotency-Key` + cùng payload ngay sau khi vừa tạo `201` (OTP đã tiêu thụ) trả lại đúng phản hồi `201` kèm `Idempotent-Replayed: true` trước khi kiểm tra OTP (kiểm thử tại Task 1 & Task 3).

---

## File Structure

### Database & Backend (`api/`)
- **Create:** `api/src/db/migrations/046_m06_p2_audit_rls_reservation_policy_and_public.sql` — Mở rộng `reservation` (`source`, `method`, `evidence`, `confirmed_by`, `confirmed_at`, `rejected_reason`, `refunded_amount`, `forfeited_amount`, `cancel_reason`, `refund_method`, `refund_bank_info`, `refund_evidence`; `status` thêm `'PENDING_CONFIRM'`, `'PARTIALLY_REFUNDED'`, `'REJECTED'`); backfill & chuẩn hóa `deposit_transaction.category` cho `transfer`; seed `'reservation_cancel_policy'` vào `system_setting`; cập nhật `rls_audit_log_select` thêm `'receivable'`; cập nhật `rls_reservation_update` mở `'PARTIALLY_REFUNDED'` cho `OWNER`/fallback `SYS_ADMIN`; cập nhật `can_select_attachment` thêm `owner_entity = 'reservation'`; thêm helper `SECURITY DEFINER` `fn_notify_reservation_prospect`; chuẩn hóa `idempotency_key` dùng cột phẳng `scope_key` (`UNIQUE (org_id, scope_key, method, route_path, idem_key)`).
- **Create:** `api/src/utils/csv.js` — Helper không phụ thuộc thư viện ngoài: `escapeCsvCell(value)`, `toUtf8BomCsv(headers, rows)` và `toXlsxBuffer(sheets)` (sinh tệp `.xlsx` OpenXML chuẩn bằng `node:zlib`, chống Formula Injection và bảo toàn số `0` đầu).
- **Create:** `api/src/services/otpService.js` — Quản lý tập trung bộ đếm gửi OTP (`3 lần/giờ/SĐT`), TTL `5 phút`, khóa sai `5 lần / 15 phút` + ghi `audit_log`, dùng chung cho `auth.js` và `public.js`.
- **Modify:** `api/src/routes/auth.js` — Chuyển `otpStore` & `phoneRequestTracker` sang dùng `api/src/services/otpService.js` để đồng nhất giới hạn OTP toàn hệ thống.
- **Modify:** `api/src/routes/contracts.js:2745-2805,4710-4745` — Ghi rõ `category = 'TRANSFER_OUT'` cho bút toán chuyển kết dư đi và `category = 'TRANSFER_IN'` cho bút toán nhận kết chuyển / chuyển từ giữ chỗ.
- **Modify:** `api/src/routes/reports.js` — Bổ sung KPI cọc & giữ chỗ (`pending_deposit_approvals`, `pending_deposit_payouts`, `overdue_deposit_refunds`, `disputed_deposits`, `pending_reservation_confirms`) vào `GET /dashboard`; thêm `GET /deposit-ledger` (`RP-07`, hỗ trợ `format = 'json' | 'csv' | 'xlsx'`).
- **Modify:** `api/src/jobs/daily.js` — Chuyển phiếu `reservation` đang `'PENDING_CONFIRM'` quá hạn `hold_until` sang `'REJECTED'` (không sang `'EXPIRED'`); bổ sung `sendMonthlyOwnerDepositReports` gửi `MONTHLY_DEPOSIT_REPORT` 1 lần/tháng/tòa cho `OWNER`.
- **Modify:** `api/src/routes/deposits.js` — Thêm `GET /:id/audit-logs` qua `getUserClient(req)` + `fn_get_deposit_access_meta` hợp nhất lịch sử của `deposit`, `deposit_transaction` và `source_reservation_id`.
- **Modify:** `api/src/routes/admin/audit-logs.js` — Hỗ trợ `scope=financial` và `format=csv` (`RP-08 — Nhật ký thao tác tài chính`, tối đa `5000` dòng qua `toUtf8BomCsv`).
- **Modify:** `api/src/middleware/idempotency.js` — Chuyển sang lưu & đối chiếu cột phẳng `scope_key` (`'user:' + actorId` cho route có JWT, hoặc `resolveScope(req)` với `actor_id = NULL` cho route công khai).
- **Modify:** `api/src/services/imageUpload.js` & `api/src/routes/attachments.js` — Cho phép `uploaded_by = req.user?.sub || null` trong `saveBase64Image` và thêm `'reservation'` vào danh sách `owner_entity` hợp lệ trong `GET /api/v1/attachments/:id/view`.
- **Modify:** `api/src/routes/reservations.js` — Lưu `method` + chứng từ `attachment` (`evidence`); đọc `max_hold_days` từ `system_setting`; thêm `GET /cancel-policy`, `PATCH /:id/confirm-payment`, `PATCH /:id/reject-payment`, `PATCH /:id/cancel-settle` (kèm mở xử lý `'EXPIRED'` đã xác nhận tiền cho `forfeit`/`refund`, tuân thủ RBAC PRD 6.2, `roundVND`, `validateRefundBankInfo` và `fn_sync_apartment_status_after_reservation`).
- **Create:** `api/src/routes/public.js` — Định nghĩa `GET /apartments` (đa tổ chức `FR-070`), `POST /reservations/otp/request` (`AC-001.3` trung lập) và `POST /reservations` (Phương án A `status = 'PENDING_CONFIRM'`, `adminPool` transaction khóa `org_id`, chặn `isInternalPerson`, bảo toàn `person` theo `FR-021`).
- **Modify:** `api/src/routes/resident.js:246-285` — Trả `reservation` cho phiếu đang `'HELD'` hoặc `'PENDING_CONFIRM'` và `reservation_history` gồm mọi trạng thái giữ chỗ của SĐT cư dân.
- **Modify:** `api/src/server.js` — Mount `publicRoutes` tại `/api/v1/public`.
- **Create:** `api/test/m06Phase3P2Features.test.js` — Integration test toàn diện cho `RP-07` (`.xlsx` & `.csv`), `RP-08` (`scope=financial`), Dashboard KPI, `MONTHLY_DEPOSIT_REPORT`, `GET /:id/audit-logs`, `cancel-settle`, luồng `PENDING_CONFIRM -> confirm-payment / reject-payment`, bảo vệ `FR-021`/`isInternalPerson`, OTP dùng chung và Idempotency `scope_key`.

### Frontend (`frontend/`)
- **Modify:** `frontend/src/services/reports.service.js` — Thêm `getDepositLedger(params)`, `exportDepositLedgerXlsx(params)` và `exportDepositLedgerCsv(params)` (`responseType: 'blob'`).
- **Modify:** `frontend/src/services/deposits.service.js` — Thêm `getAuditLogs(id)`.
- **Modify:** `frontend/src/services/audit.service.js` — Thêm `exportCsv(params)` (`responseType: 'blob'`).
- **Modify:** `frontend/src/services/buildings.service.js` — Thêm `getReservationCancelPolicy()`, `confirmReservationPayment(id, options)`, `rejectReservationPayment(id, data, options)`, `cancelSettleReservation(id, data, options)`; cập nhật `createReservation` nhận `method` & `evidence`.
- **Create:** `frontend/src/services/public.service.js` — Client gọi `/api/v1/public/apartments`, `/api/v1/public/reservations/otp/request`, `/api/v1/public/reservations` (tự gắn `Idempotency-Key`, không yêu cầu Bearer token).
- **Modify:** `frontend/src/constants/statuses.js` — Bổ sung `PENDING_CONFIRM`, `PARTIALLY_REFUNDED`, `REJECTED` vào `RESERVATION_STATUS`.
- **Modify:** `frontend/src/utils/depositUiHelpers.js` — Thêm các hàm thuần `computeSuggestedCancelSplit` (làm tròn hàng nghìn `ROUND(x, -3)`), `canSettleReservationCancel` và `canManagerConfirmReservationPayment`.
- **Modify:** `frontend/src/pages/admin/dashboard/DashboardPage.jsx` — Hiển thị dải thẻ KPI cảnh báo Cọc & Giữ chỗ chờ xác nhận có query drill-down sang `/admin/deposits` và `/admin/buildings/floor-plan`.
- **Modify:** `frontend/src/pages/admin/reports/ReportsPage.jsx` — Bổ sung tab `"Sổ cọc (RP-07)"` (bộ lọc, 6 thẻ cân đối Sổ cọc Hợp đồng, khối Đối soát Giữ chỗ `HELD` vs `PENDING_CONFIRM`, bảng chi tiết và nút `Xuất Excel (.xlsx)` + `Xuất CSV`).
- **Modify:** `frontend/src/pages/admin/deposits/DepositsPage.jsx` — Đọc query drill-down từ `useSearchParams()`, thêm nút `Xuất Excel RP-07` và tab `"Lịch sử kiểm toán"` bên trong Modal Chi tiết Sổ cọc.
- **Modify:** `frontend/src/pages/admin/audit/AuditLogsPage.jsx` — Thêm bộ lọc nhanh `"Phạm vi tài chính (RP-08)"` và nút `Xuất CSV Tài chính (RP-08)`.
- **Modify:** `frontend/src/pages/admin/settings/SettingsPage.jsx` — Bổ sung thẻ cấu hình `"Chính sách Đặt cọc Giữ chỗ (FR-005 / FR-067)"` cho `SYS_ADMIN`.
- **Modify:** `frontend/src/pages/admin/buildings/FloorPlanPage.jsx` & `frontend/src/pages/admin/apartments/ApartmentDetailPage.jsx` — Thêm chọn `Phương thức thu` + `Chứng từ` khi tạo giữ chỗ; hiển thị thao tác `Xác nhận tiền về` / `Từ chối biên lai` cho phiếu `PENDING_CONFIRM` (`MANAGER`) và modal `Thanh lý hủy theo chính sách` (có nhập TK nhận hoàn cọc khi `refunded_amount > 0`) cho phiếu `HELD` / `EXPIRED`.
- **Create:** `frontend/src/pages/public/PublicExplorePage.jsx` & **Modify:** `frontend/src/router/index.jsx`, `frontend/src/pages/auth/LoginPage.jsx` — Trang chủ công khai tại `/` và `/explore` theo Sitemap PRD Mục 8.1 (`H1`, `H2`, `H3`, `L`) hiển thị rõ trạng thái chờ BQL đối chiếu sao kê xác nhận sau khi gửi phiếu.
- **Create:** `frontend/src/utils/__tests__/m06Phase3Ui.test.js` — Unit test cho `computeSuggestedCancelSplit` (làm tròn hàng nghìn VND), `canSettleReservationCancel` (chặn `PENDING_CONFIRM` & `REJECTED`), `canManagerConfirmReservationPayment` và `RESERVATION_STATUS`.

---

### Task 1: Migration `046`, Idempotency `scope_key`, Helper Xuất `.xlsx`/`.csv`, Báo cáo `RP-07` & Báo cáo Tháng Gửi `OWNER` (`GAP-05`)

**Files:**
- Create: `api/src/db/migrations/046_m06_p2_audit_rls_reservation_policy_and_public.sql`
- Modify: `api/src/middleware/idempotency.js`
- Create: `api/src/utils/csv.js`
- Modify: `api/src/routes/contracts.js:2745-2805,4710-4745`
- Modify: `api/src/routes/reports.js`
- Modify: `api/src/jobs/daily.js`
- Create: `api/test/m06Phase3P2Features.test.js`

**Interfaces:**
- Consumes: `DEDUCTED_FULL` (`044`), `APPROVED_PENDING_PAYOUT`, `RETURNED`, `refund_reversal`, `rls_audit_log_select`, `rls_reservation_update` (`045`), `can_select_attachment` (`040`), `idempotency_key` (`042`).
- Produces:
  - Schema & RLS trong `046`:
    - `reservation`: thêm `source TEXT NOT NULL DEFAULT 'INTERNAL' CHECK (source IN ('INTERNAL','PUBLIC'))`, `method TEXT DEFAULT 'BANK_TRANSFER'`, `evidence TEXT[] NOT NULL DEFAULT '{}'`, `confirmed_by UUID REFERENCES app_user(id)`, `confirmed_at TIMESTAMPTZ`, `rejected_reason TEXT`, `refunded_amount BIGINT NOT NULL DEFAULT 0 CHECK (refunded_amount >= 0)`, `forfeited_amount BIGINT NOT NULL DEFAULT 0 CHECK (forfeited_amount >= 0)`, `cancel_reason TEXT`, `refund_method TEXT CHECK (refund_method IS NULL OR refund_method IN ('BANK_TRANSFER','CASH'))`, `refund_bank_info JSONB`, `refund_evidence TEXT[] NOT NULL DEFAULT '{}'`; mở rộng `reservation_status_check` thành `('PENDING_CONFIRM','HELD','CONVERTED','FORFEITED','REFUNDED','PARTIALLY_REFUNDED','EXPIRED','REJECTED')`.
    - `deposit_transaction`: backfill `category = CASE WHEN description ILIKE 'Chuyển kết dư%' THEN 'TRANSFER_OUT' ELSE 'TRANSFER_IN' END` cho các dòng `type = 'transfer' AND category IS NULL`.
    - `system_setting`: seed `'reservation_cancel_policy'` = `'{"max_hold_days":30,"public_max_hold_days":7,"full_refund_before_days":3,"partial_refund_pct":50,"default_hold_amount":2000000}'::jsonb` cho mọi `organization`.
    - `rls_audit_log_select`: kế thừa nguyên vẹn `038` & `045`, bổ sung thêm nhánh `entity = 'receivable'` (theo `receivable.building_id`) cho cả `is_owner()` và `is_manager()`.
    - `rls_reservation_update`: giữ quyền `is_manager()` trên `get_manager_building_ids()` và mở rộng `WITH CHECK` cho nhánh `is_owner()` / fallback `is_org_admin()` (khi `NOT building_has_active_owner(building_id)`) thành `status IN ('REFUNDED', 'FORFEITED', 'PARTIALLY_REFUNDED')`.
    - `can_select_attachment`: giữ toàn bộ quy tắc của `040` (kể cả chặn `OWNER` đọc `person` theo PRD 13.5) và thêm nhánh `p_owner_entity = 'reservation'` cho `is_manager() OR is_owner()` (`r.building_id IN (SELECT building_id FROM get_user_assigned_buildings())`) và `is_resident()` (`r.phone = (SELECT phone FROM person WHERE id = get_current_user_person_id())`).
    - `fn_notify_reservation_prospect(p_reservation_id UUID, p_type TEXT, p_title TEXT, p_body TEXT) RETURNS INT` (`SECURITY DEFINER SET search_path = public, pg_temp`): kiểm tra người gọi có quyền trên `reservation.building_id`, tìm `app_user` `ACTIVE` theo `reservation.phone` trong cùng `org_id` và chèn `notification`.
    - `idempotency_key`: thêm `scope_key TEXT`, backfill `'user:' || actor_id::text`, đặt `scope_key SET NOT NULL`, `actor_id DROP NOT NULL`, gỡ constraint cũ trên `(org_id, actor_id, method, route_path, idem_key)` và thêm constraint phẳng `CONSTRAINT uq_idempotency_key_scope UNIQUE (org_id, scope_key, method, route_path, idem_key)`.
  - `idempotencyGuard({ requireHeader?, resolveScope?: (req) => Promise<{ orgId: string, scopeKey: string } | null> | { orgId: string, scopeKey: string } | null })` trong `api/src/middleware/idempotency.js`:
    - Với route có JWT: `orgId = req.user.org_id`, `actorId = req.user.sub || req.user.id`, `scopeKey = 'user:' + actorId`.
    - Với route công khai: gọi `resolveScope(req)` lấy `{ orgId, scopeKey }` (`actorId = null`).
    - Thực thi `DELETE` / `INSERT ... ON CONFLICT (org_id, scope_key, method, route_path, idem_key) DO NOTHING` / `SELECT` thống nhất trên `(org_id, scope_key, method, route_path, idem_key)` (không bao giờ gây lỗi `42P10`).
  - `api/src/utils/csv.js`:
    - `sanitizeSpreadsheetFormula(str: string) -> string` (tiền tố `'` khi khớp `/^[=+\-@\t\r]/`).
    - `escapeCsvCell(value: unknown) -> string` và `toUtf8BomCsv(headers: string[], rows: Array<Array<unknown>>) -> string`.
    - `toXlsxBuffer(sheets: Array<{ name: string, headers: string[], rows: Array<Array<unknown>> }>) -> Buffer` (tạo ZIP OpenXML `.xlsx` hợp lệ qua `zlib.deflateRawSync`, số nguyên/số thực an toàn ghi `<c t="n">`, chuỗi & SĐT/STK bắt đầu bằng `0` ghi `<c t="inlineStr">` đã qua `sanitizeSpreadsheetFormula`).
  - `GET /api/v1/reports/dashboard`: `data.kpis` bổ sung `pending_deposit_approvals`, `pending_deposit_payouts`, `overdue_deposit_refunds`, `disputed_deposits`, `pending_reservation_confirms`.
  - `GET /api/v1/reports/deposit-ledger` (`SYS_ADMIN`, `OWNER`, `MANAGER`):
    - Query: `{ building_id?, from_date?, to_date?, status?, format?: 'json' | 'csv' | 'xlsx' }`.
    - JSON response: `{ data: { period: { from_date, to_date }, summary: { opening_held, collected, transfer_in, refund_reversed, deducted, refunded, transfer_out, closing_held, disputed_count, disputed_amount, pending_payout_count, pending_payout_amount, overdue_count }, reservation_summary: { active_held_count, active_held_amount, pending_confirm_count, pending_confirm_amount, refunded_in_period, forfeited_in_period }, items: Array<DepositLedgerRow> } }`.
  - `sendMonthlyOwnerDepositReports(pool, refDate?)` trong `api/src/jobs/daily.js`.

- [ ] **Step 1: Viết integration test thất bại trong `api/test/m06Phase3P2Features.test.js` (Phần `RP-07` JSON/CSV/XLSX, Chuỗi kết chuyển 3 HĐ, Dashboard KPI & Monthly Report)**

Kiểm tra:
1. Chuỗi nghiệp vụ trên cùng tòa gồm: Đặt giữ chỗ → Kích hoạt `HĐ1` (`category = 'TRANSFER_IN'` + `collect`) → Gia hạn sang `HĐ2` (`dep1` ghi `TRANSFER_OUT`, `dep2` ghi `TRANSFER_IN`) → Chuyển phòng sang `HĐ3` (`dep2` ghi `TRANSFER_OUT` và mang `dep2.status = 'TRANSFERRED'`, `dep3` ghi `TRANSFER_IN`), cộng thêm 1 sổ đang `APPROVED_PENDING_PAYOUT` và 1 sổ `RETURNED` (`refund_reversal`): gọi `GET /api/v1/reports/deposit-ledger?building_id=...` → dòng `dep2` có `transfer_in === transfer_out` và `closing_held === 0`; toàn tòa thỏa `opening_held + collected + transfer_in + refund_reversed - deducted - refunded - transfer_out === closing_held === SUM(deposit.amount_held)`; `reservation_summary` tách đúng `active_held_amount` (`HELD`) và `pending_confirm_amount` (`PENDING_CONFIRM`) (Review Focus #1).
2. Gọi `GET /api/v1/reports/deposit-ledger?format=csv` và `?format=xlsx` khi dữ liệu chứa `=CMD|' /C calc'!A0` và SĐT `0909123456`:
   - Bản `.csv` bắt đầu bằng `\uFEFF` và chứa `"'=CMD|' /C calc'!A0"` cùng `"'0909123456"`.
   - Bản `.xlsx` trả `Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`, có magic header ZIP `PK\x03\x04`, giải nén `xl/worksheets/sheet1.xml` thấy chuỗi công thức đã được tiền tố `'` và `0909123456` nằm trong `<c ... t="inlineStr"><is><t>0909123456</t></is></c>` (không bị mất số `0` đầu) (Review Focus #1).
3. `GET /api/v1/reports/dashboard` trả đủ 5 KPI mới theo đúng phạm vi tòa nhà của `OWNER` / `MANAGER` / `SYS_ADMIN`.
4. `runDailyJobs()` chuyển phiếu `reservation` đang `'PENDING_CONFIRM'` có `hold_until < CURRENT_DATE` sang `'REJECTED'` (không sang `'EXPIRED'`), và gửi đúng `1` thông báo `MONTHLY_DEPOSIT_REPORT` cho `OWNER` khi chạy lặp 2 lần trong cùng tháng.
5. Gửi lặp 2 lần `POST /api/v1/deposits/:id/transactions` (route có JWT) với cùng `Idempotency-Key` sau khi migration `046` đổi sang `uq_idempotency_key_scope` → không ném `42P10`, lưu đúng `scope_key = 'user:' + actorId` và lần 2 trả `idempotent-replayed: 'true'` (Review Focus #5).

- [ ] **Step 2: Chạy test xác nhận FAIL**

Run: `cd d:\resihub\api; node --test test/m06Phase3P2Features.test.js`
Expected: FAIL (`404` trên `/api/v1/reports/deposit-ledger` và chưa có migration `046`).

- [ ] **Step 3: Tạo migration `046`, cập nhật `idempotency.js`, viết `api/src/utils/csv.js`, cập nhật `contracts.js`, `reports.js` và `daily.js`**

- Tạo `api/src/db/migrations/046_m06_p2_audit_rls_reservation_policy_and_public.sql` đầy đủ 8 mục trong `Interfaces`, đồng thời cập nhật ngay `api/src/middleware/idempotency.js` sang cột phẳng `scope_key` (`'user:' + actorId` cho route có JWT và hỗ trợ `resolveScope(req)` cho route công khai) để mọi route có `idempotencyGuard()` hoạt động liền mạch không lỗi `42P10`.
- Cập nhật `contracts.js` gắn `category = 'TRANSFER_OUT' | 'TRANSFER_IN'` cho mọi câu `INSERT INTO deposit_transaction` có `type = 'transfer'`.
- Viết `api/src/utils/csv.js` triển khai `sanitizeSpreadsheetFormula`, `escapeCsvCell`, `toUtf8BomCsv` và `toXlsxBuffer` (tạo 5 entry chuẩn `[Content_Types].xml`, `_rels/.rels`, `xl/workbook.xml`, `xl/_rels/workbook.xml.rels`, `xl/worksheets/sheet1..N.xml` đóng gói ZIP CRC32 + `zlib.deflateRawSync`).
- Cập nhật `api/src/routes/reports.js` (`GET /dashboard` & `GET /deposit-ledger` hỗ trợ `json`, `csv`, `xlsx`) và `api/src/jobs/daily.js` (xử lý quá hạn `PENDING_CONFIRM -> REJECTED` + `sendMonthlyOwnerDepositReports`).

- [ ] **Step 4: Chạy migrate và chạy test xác nhận PASS**

Run: `cd d:\resihub\api; npm run migrate; node --test test/m06Phase3P2Features.test.js`
Expected: Migration `046` thành công và toàn bộ subtest Task 1 PASS.

- [ ] **Step 5: Commit Task 1**

```bash
git add api/src/db/migrations/046_m06_p2_audit_rls_reservation_policy_and_public.sql api/src/middleware/idempotency.js api/src/utils/csv.js api/src/routes/contracts.js api/src/routes/reports.js api/src/jobs/daily.js api/test/m06Phase3P2Features.test.js
git commit -m "feat(reports): add migration 046, scope_key idempotency, RP-07 ledger with XLSX/CSV export, dashboard KPIs, and owner monthly digest"
```

---

### Task 2: Nhật ký Kiểm toán Sổ cọc Xuyên suốt (`GAP-07`), Xuất CSV Tài chính `RP-08` & Giao diện `RP-07` / `RP-08` / Drill-down Dashboard

**Files:**
- Modify: `api/src/routes/deposits.js`
- Modify: `api/src/routes/admin/audit-logs.js`
- Modify: `api/test/m06Phase3P2Features.test.js`
- Modify: `frontend/src/services/reports.service.js`
- Modify: `frontend/src/services/deposits.service.js`
- Modify: `frontend/src/services/audit.service.js`
- Modify: `frontend/src/pages/admin/dashboard/DashboardPage.jsx`
- Modify: `frontend/src/pages/admin/reports/ReportsPage.jsx`
- Modify: `frontend/src/pages/admin/deposits/DepositsPage.jsx`
- Modify: `frontend/src/pages/admin/audit/AuditLogsPage.jsx`

**Interfaces:**
- Consumes: `rls_audit_log_select` từ migration `046`, `fn_get_deposit_access_meta` từ `045`, `toUtf8BomCsv` từ `api/src/utils/csv.js` (Task 1).
- Produces:
  - `GET /api/v1/deposits/:id/audit-logs` (`SYS_ADMIN`, `OWNER`, `MANAGER`, thực thi 100% qua `getUserClient(req)` + `fn_get_deposit_access_meta`, không dùng `adminPool`): trả `{ data: Array<{ id, action, entity, entity_id, before, after, at, actor_id, actor_name, actor_roles }> }` gồm các dòng `entity = 'deposit'`, `entity = 'deposit_transaction'` thuộc sổ, `entity = 'receivable'` (`receivable.deposit_id = $1`) và `entity = 'reservation'` khớp `source_reservation_id`.
  - `GET /api/v1/audit-logs` (`SYS_ADMIN`, `OWNER`): nhận thêm `scope?: 'financial'` (lọc `al.entity IN ('invoice', 'payment', 'receivable', 'deposit', 'deposit_transaction', 'reservation')`) và `format?: 'csv'` (`RP-08` PRD Mục 15.2 dòng 1051, xuất tối đa `5000` dòng qua `toUtf8BomCsv`).
  - `reportsService.getDepositLedger(params)`, `reportsService.exportDepositLedgerXlsx(params)`, `reportsService.exportDepositLedgerCsv(params)`, `depositsService.getAuditLogs(id)`, `auditService.exportCsv(params)`.

- [ ] **Step 1: Bổ sung subtest cho `GET /api/v1/deposits/:id/audit-logs` và `GET /api/v1/audit-logs?scope=financial&format=csv` (`RP-08`) vào `api/test/m06Phase3P2Features.test.js`**

Kiểm tra:
1. Kiểm tra tĩnh `deposits.js` vẫn giữ **0** tham chiếu tới `adminPool` (bảo toàn bất biến Giai đoạn 2 `BUG-07`).
2. **Cả `MANAGER` lẫn `OWNER`** của tòa nhà gọi `GET /api/v1/deposits/:id/audit-logs` trên sổ cọc được kết chuyển từ giữ chỗ → nhận đầy đủ cả dòng `entity = 'reservation'` (lúc đặt chỗ), `entity = 'deposit_transaction'` (`collect` / `transfer`) và `entity = 'deposit'` (`SETTLEMENT_SUBMIT`, `SETTLEMENT_APPROVE`...) sắp xếp `at DESC, id DESC`.
3. `RESIDENT` gọi `GET /api/v1/deposits/:id/audit-logs` → `403`; `MANAGER` hoặc `OWNER` của tòa khác gọi → `403 ACCESS_DENIED`.
4. `OWNER` gọi `GET /api/v1/audit-logs?scope=financial&format=csv` → nhận `200` `text/csv; charset=utf-8` bắt đầu bằng `\uFEFF`, chứa đủ các thao tác trên `invoice`, `payment`, `receivable`, `deposit`, `deposit_transaction`, `reservation` thuộc tòa mình sở hữu, loại trừ các log phi tài chính (`building`, `service_request`), và escape an toàn ô công thức.

- [ ] **Step 2: Chạy test xác nhận FAIL**

Run: `cd d:\resihub\api; node --test test/m06Phase3P2Features.test.js`
Expected: FAIL (`404` trên `/api/v1/deposits/:id/audit-logs` và `audit-logs` chưa lọc `scope=financial` / xuất CSV).

- [ ] **Step 3: Cài đặt API Audit Log / `RP-08` CSV và cập nhật `DashboardPage.jsx`, `ReportsPage.jsx`, `DepositsPage.jsx`, `AuditLogsPage.jsx`**

- Trong `api/src/routes/deposits.js`: thêm `GET /:id/audit-logs` kiểm tra phạm vi bằng `fn_get_deposit_access_meta($1)` trên `client`, lấy `source_reservation_id` từ `deposit`, truy vấn `audit_log` cho cả 4 nguồn (`deposit`, `deposit_transaction`, `receivable` có `deposit_id = $1`, và `reservation` gốc) kèm thông tin người thao tác.
- Trong `api/src/routes/admin/audit-logs.js`: hỗ trợ `scope === 'financial'` và nhánh `format === 'csv'` (`LIMIT 5000` không `OFFSET`, trả qua `toUtf8BomCsv`).
- Cập nhật `reports.service.js`, `deposits.service.js`, `audit.service.js`.
- Trong `DashboardPage.jsx`: hiển thị các thẻ cảnh báo dẫn kèm query drill-down (`/admin/deposits?tab=pending`, `/admin/deposits?tab=payout`, `/admin/deposits?overdue=1`, `/admin/deposits?status=DISPUTED`, và `/admin/buildings/floor-plan?pending_confirm=1` khi `pending_reservation_confirms > 0`).
- Trong `DepositsPage.jsx`: đọc `useSearchParams()` khi mở trang để tự động chọn đúng tab/trạng thái/bộ lọc quá hạn từ Dashboard; thêm nút `Xuất Excel (RP-07)` trên thanh công cụ và tab `"Sổ giao dịch"` | `"Lịch sử kiểm toán"` ngay trong Modal Chi tiết Sổ cọc.
- Trong `ReportsPage.jsx`: thêm tab `"Sổ cọc (RP-07)"` (bộ lọc, thẻ cân đối sổ cái, khối đối soát Giữ chỗ `HELD` & `PENDING_CONFIRM`, bảng chi tiết, nút `Xuất Excel (.xlsx)` và `Xuất CSV`).
- Trong `AuditLogsPage.jsx`: thêm tùy chọn lọc `"Tất cả tài chính (RP-08)"` (`scope=financial`) và nút `Xuất CSV Tài chính (RP-08)`.

- [ ] **Step 4: Chạy test Backend và build Frontend xác nhận PASS**

Run: `cd d:\resihub\api; node --test test/m06Phase3P2Features.test.js; cd d:\resihub\frontend; npm run build`
Expected: Test Backend PASS và Vite build `0 errors`.

- [ ] **Step 5: Commit Task 2**

```bash
git add api/src/routes/deposits.js api/src/routes/admin/audit-logs.js api/test/m06Phase3P2Features.test.js frontend/src/services/reports.service.js frontend/src/services/deposits.service.js frontend/src/services/audit.service.js frontend/src/pages/admin/dashboard/DashboardPage.jsx frontend/src/pages/admin/reports/ReportsPage.jsx frontend/src/pages/admin/deposits/DepositsPage.jsx frontend/src/pages/admin/audit/AuditLogsPage.jsx
git commit -m "feat(m06): add full-origin deposit audit timeline, RP-07 Excel/CSV UI, RP-08 financial CSV, and dashboard drill-down"
```

---

### Task 3: Dịch vụ OTP Dùng chung, Thanh lý Hủy Làm tròn Hàng nghìn & API Đặt giữ chỗ Công khai `PENDING_CONFIRM` (`GAP-06`)

**Files:**
- Create: `api/src/services/otpService.js`
- Modify: `api/src/routes/auth.js`
- Modify: `api/src/services/imageUpload.js`
- Modify: `api/src/routes/attachments.js`
- Modify: `api/src/services/depositSettlement.js`
- Modify: `api/src/routes/reservations.js`
- Create: `api/src/routes/public.js`
- Modify: `api/src/routes/resident.js:246-285`
- Modify: `api/src/server.js`
- Modify: `api/test/m06Phase3P2Features.test.js`

**Interfaces:**
- Consumes: Bảng `reservation`, `system_setting('reservation_cancel_policy')`, `rls_reservation_update`, `can_select_attachment`, `fn_notify_reservation_prospect`, `uq_idempotency_key_scope` và `idempotencyGuard({ resolveScope })` từ Task 1; `validateRefundBankInfo`, `isPositiveSafeIntegerVnd` (`044`); `fn_sync_apartment_status_after_reservation`, `building_has_active_owner` (`045`); `roundVND` (`api/src/services/pricing.js`); `isInternalPerson`, `ensureResidentAccount`, `normalizeVnPhone` (`api/src/services/residentAccount.js`).
- Produces:
  - `api/src/services/otpService.js`:
    - `requestPhoneOtp(cleanPhone, { now? }) -> { ok: true, otp: string, expiresAt: number } | { ok: false, status: 429, code: 'RATE_LIMIT_EXCEEDED' | 'ACCOUNT_LOCKED', message: string }`.
    - `verifyPhoneOtp(cleanPhone, otp, { allowDevMasterOtp?: boolean, lockAuditAction?: string, dbPool }) -> Promise<{ ok: true } | { ok: false, status: 400 | 429, code: 'OTP_NOT_FOUND' | 'OTP_EXPIRED' | 'OTP_INVALID' | 'TOO_MANY_ATTEMPTS', message: string }>` (chia sẻ chung `otpStore` & `phoneRequestTracker` giữa `auth.js` và `public.js`; `allowDevMasterOtp` mặc định `false` trên `public.js`).
  - `computeSuggestedCancelSplit({ holdAmount, holdUntil, todayStr, policy }) -> { refunded_amount: number, forfeited_amount: number }` export từ `api/src/services/depositSettlement.js` (dùng `roundVND` làm tròn đến hàng nghìn VND theo PRD 10.3: hoàn `100%` nếu `daysLeft >= full_refund_before_days`; hoàn `Math.min(holdAmount, Math.max(0, roundVND(holdAmount * partial_refund_pct / 100)))` nếu `0 <= daysLeft < full_refund_before_days`; hoàn `0` nếu `daysLeft < 0`; `forfeited_amount = holdAmount - refunded_amount`).
  - Các endpoint quản trị giữ chỗ trong `api/src/routes/reservations.js`:
    - `POST /api/v1/reservations`: lưu `source = 'INTERNAL'`, `method`, `evidence` qua `persistReservationEvidence`, kiểm tra `holdUntil - holdFrom <= policy.max_hold_days` (`30` ngày).
    - `GET /api/v1/reservations/cancel-policy` (`SYS_ADMIN`, `OWNER`, `MANAGER`): trả `reservation_cancel_policy` của `req.user.org_id`.
    - `PATCH /api/v1/reservations/:id/confirm-payment` (`MANAGER` của tòa, `idempotencyGuard()`, `getUserClient(req)`): chỉ nhận `status === 'PENDING_CONFIRM'`, kiểm tra căn hộ vẫn đang `AVAILABLE` và chưa có HĐ `ACTIVE` / giữ chỗ `HELD` khác (`409 APARTMENT_NOT_AVAILABLE`), cập nhật `status = 'HELD'`, `confirmed_by = req.user.sub`, `confirmed_at = NOW()`, gọi `SELECT fn_sync_apartment_status_after_reservation($1)` sang `'RESERVED'`, gọi `fn_notify_reservation_prospect` (`RESERVATION_PAYMENT_CONFIRMED`) và ghi `audit_log('CONFIRM_PAYMENT')`.
    - `PATCH /api/v1/reservations/:id/reject-payment` (`MANAGER` của tòa, `idempotencyGuard()`, `getUserClient(req)`): bắt buộc `reason` (`400 REASON_REQUIRED`), chỉ nhận `status === 'PENDING_CONFIRM'`, cập nhật `status = 'REJECTED'`, `rejected_reason = trimmedReason`, `refunded_amount = 0`, `forfeited_amount = 0`, gọi `fn_notify_reservation_prospect` (`RESERVATION_PAYMENT_REJECTED`) và ghi `audit_log('REJECT_PAYMENT')`.
    - `PATCH /api/v1/reservations/:id/cancel-settle` (`OWNER`, `MANAGER`, `SYS_ADMIN` theo đúng RBAC PRD 6.2 — `SYS_ADMIN` bị chặn `403` khi `building_has_active_owner = true`; kiểm tra Four-Eyes với `creatorId = currentRes.confirmed_by || currentRes.created_by`; `idempotencyGuard()`):
      - Chỉ nhận `status === 'HELD'` hoặc `(status === 'EXPIRED' && (currentRes.source !== 'PUBLIC' || Boolean(currentRes.confirmed_at)))` khi `Number(refunded_amount) + Number(forfeited_amount) === 0` (`400 INVALID_STATUS` nếu sai; đồng bộ điều kiện này cho cả `PATCH /:id/forfeit` và `PATCH /:id/refund`).
      - Kiểm tra `refunded_amount + forfeited_amount === Number(hold_amount)` (`422 INVALID_CANCEL_SPLIT`), `reason` bắt buộc (`400 REASON_REQUIRED`), và khi `refunded_amount > 0` bắt buộc `validateRefundBankInfo({ refundAmount: refunded_amount, refundMethod: refund_method || 'BANK_TRANSFER', bankInfo: refund_bank_info })` (`422`), lưu `refund_evidence` nếu có.
      - Cập nhật `status` (`'REFUNDED'` / `'FORFEITED'` / `'PARTIALLY_REFUNDED'`), gọi `SELECT fn_sync_apartment_status_after_reservation($1)`, ghi `audit_log('CANCEL_SETTLE')` kèm `{ policy_suggested_split, policy_override }`.
  - Public API `/api/v1/public` (`api/src/routes/public.js`):
    - `GET /apartments`: nhận `org_id?`, `building_id?`; trả `{ data: { buildings, apartments, policy, policies_by_org, payment_accounts } }` (đa tổ chức `FR-070`, không lộ PII cư dân hay `note` nội bộ).
    - `POST /reservations/otp/request` (`otpRequestLimiter`): dùng `requestPhoneOtp`, luôn trả thông điệp trung lập đồng nhất (`AC-001.3`, chỉ trả `devOtp` khi `NODE_ENV !== 'production'`).
    - `POST /reservations` (`idempotencyGuard({ resolveScope })` tra `org_id` từ `apartment_id` và `scopeKey = 'public:' + cleanPhone`):
      - Xác thực OTP qua `verifyPhoneOtp(..., { allowDevMasterOtp: false, lockAuditAction: 'PUBLIC_OTP_LOCK' })` (`400 OTP_INVALID` / `429 TOO_MANY_ATTEMPTS`).
      - Kiểm tra `privacy_consent === true` (`422 PRIVACY_CONSENT_REQUIRED`), `evidence.length >= 1` (`422 EVIDENCE_REQUIRED`), `isPositiveSafeIntegerVnd(hold_amount)` (`400 INVALID_HOLD_AMOUNT`), `holdUntil - holdFrom <= policy.public_max_hold_days` (`400 HOLD_DURATION_EXCEEDED`).
      - Chạy transaction trên `const client = await adminPool.connect()` (vì chưa có JWT dưới `FORCE ROW LEVEL SECURITY`, khóa cứng `org_id = apt.org_id`):
        - Chặn SĐT nhân sự nội bộ qua `isInternalPerson(client, { phone: cleanPhone })` (`409 INTERNAL_ACCOUNT_PHONE`).
        - Khóa `SELECT a.*, b.org_id FROM apartment a JOIN building b ON b.id = a.building_id WHERE a.id = $1 FOR UPDATE OF a` (`409 APARTMENT_NOT_AVAILABLE` nếu `a.status !== 'AVAILABLE'`).
        - Chặn SĐT đã có phiếu `status IN ('PENDING_CONFIRM', 'HELD')` (`409 PHONE_ALREADY_HAS_ACTIVE_RESERVATION`).
        - Tạo `reservation(status = 'PENDING_CONFIRM', source = 'PUBLIC', created_by = NULL, method = 'BANK_TRANSFER')`, lưu biên lai vào `attachment(owner_entity = 'reservation', uploaded_by = NULL)` (**giữ nguyên `apartment.status = 'AVAILABLE'`** cho tới khi `MANAGER` xác nhận sao kê — Phương án A).
        - Nếu `person` chưa tồn tại thì tạo mới kèm `privacy_consent_at = NOW(), privacy_policy_version = 'v1.0'`; nếu đã tồn tại thì **chỉ** cập nhật `privacy_consent_at = COALESCE(privacy_consent_at, NOW())` (tuyệt đối không ghi đè `full_name` / `id_number` theo `FR-021`); chỉ tạo `tenant(status = 'PENDING', desired_apartment_id, desired_building_id)` khi chưa có `tenant` ở `status IN ('APPROVED', 'PENDING')`; gọi `ensureResidentAccount` và gửi thông báo `PUBLIC_RESERVATION_PENDING_CONFIRM` cho `MANAGER` tòa nhà.

- [ ] **Step 1: Bổ sung subtest cho OTP dùng chung, Luồng `PENDING_CONFIRM` (Phương án A), Bảo vệ `FR-021`/`isInternalPerson`, `ROUND(x, -3)` và `cancel-settle` vào `api/test/m06Phase3P2Features.test.js`**

Kiểm tra:
1. `computeSuggestedCancelSplit` với `holdAmount = 1_050_000`, `partial_refund_pct = 33`, `daysLeft = 1` trả `{ refunded_amount: 347000, forfeited_amount: 703000 }` (làm tròn hàng nghìn `ROUND(x, -3)` theo PRD 10.3 — Review Focus #4).
2. Bộ đếm OTP dùng chung: nhập sai OTP 3 lần tại `/api/v1/auth/otp/verify` rồi nhập sai thêm 2 lần tại `/api/v1/public/reservations` (kể cả truyền `'123456'` khi không phải OTP thực) → lần thứ 5 bị khóa ngay với `429 TOO_MANY_ATTEMPTS` và ghi `audit_log` (Review Focus #3).
3. Bảo vệ danh tính (`FR-021` & RBAC): dùng SĐT của `OWNER` hoặc `MANAGER` đặt giữ chỗ online → `409 INTERNAL_ACCOUNT_PHONE` (không phát sinh role `RESIDENT` hay `tenant`); dùng SĐT của cư dân đang có HĐ `ACTIVE` đặt thêm căn mới → `201 PENDING_CONFIRM` nhưng `person.full_name` gốc được giữ nguyên không bị đổi (Review Focus #3).
4. Luồng Phương án A & chống khóa phòng ảo: 2 khách vãng lai từ 2 SĐT mới cùng gửi `POST /api/v1/public/reservations` vào cùng 1 căn `AVAILABLE` → cả 2 nhận `201` (`status = 'PENDING_CONFIRM'`), căn hộ vẫn `'AVAILABLE'`; replay request khách 1 với cùng `Idempotency-Key` trả `201` kèm `idempotent-replayed: 'true'` (Review Focus #5); `MANAGER` gọi `PATCH /:id/confirm-payment` cho khách 1 → `200 HELD`, căn hộ sang `'RESERVED'`; `MANAGER` gọi tiếp `confirm-payment` cho khách 2 → `409 APARTMENT_NOT_AVAILABLE`; `MANAGER` gọi `PATCH /:id/reject-payment` cho khách 2 → `200 REJECTED` (`forfeited_amount = 0`) (Review Focus #2).
5. Quy tắc 4 mắt & RBAC PRD 6.2 trên `cancel-settle`: chính `MANAGER` vừa `confirm-payment` tự gọi `PATCH /:id/cancel-settle` → bị chặn `403 FOUR_EYES_VIOLATION`; `SYS_ADMIN` gọi trên tòa có `OWNER` active → bị chặn `403`; `OWNER` gọi hoàn một phần `BANK_TRANSFER` thiếu `refund_bank_info` → `422 BANK_INFO_REQUIRED`, truyền đủ `refund_bank_info` → `200 PARTIALLY_REFUNDED` và căn hộ về `'AVAILABLE'` không lỗi RLS; phiếu `'EXPIRED'` (đã xác nhận tiền) gọi `cancel-settle` lần 1 → `200`, gọi lần 2 → `400 INVALID_STATUS`, còn phiếu `'REJECTED'` gọi `cancel-settle` → `400 INVALID_STATUS` (Review Focus #4).
6. Khách đặt chỗ đăng nhập cổng cư dân qua OTP → `GET /api/v1/resident/overview` hiển thị phiếu ở cả lúc `PENDING_CONFIRM`, lúc `HELD` và trong `reservation_history` sau khi `PARTIALLY_REFUNDED`.

- [ ] **Step 2: Chạy test xác nhận FAIL**

Run: `cd d:\resihub\api; node --test test/m06Phase3P2Features.test.js`
Expected: FAIL (`404` trên `/api/v1/public/*`, `/confirm-payment`, `/reject-payment`, `/cancel-settle`).

- [ ] **Step 3: Triển khai `otpService.js`, cập nhật `auth.js`, `imageUpload.js`, `attachments.js`, `depositSettlement.js`, `reservations.js`, `resident.js`, tạo `public.js` và mount vào `server.js`**

- Triển khai đầy đủ các chữ ký, quy tắc bảo mật và RBAC đã chốt trong phần `Interfaces` của Task 3.

- [ ] **Step 4: Chạy toàn bộ bộ kiểm thử M06 (Giai đoạn 1 + Giai đoạn 2 + Giai đoạn 3) và các bộ test hồi quy liên quan**

Run: `cd d:\resihub\api; node --test test/m06Phase3P2Features.test.js test/m06Phase2RlsAndDisputeWindow.test.js test/m06Phase2OwnerApprovalAndEscalation.test.js test/m06Phase2HandoverPrecondition.test.js test/m06Phase2PayoutAndReturnedFlow.test.js test/m06Phase1P0Fixes.test.js test/depositCollectAndRefund.test.js test/depositRules.test.js test/vietQrAndOccupancySchedule.test.js test/residentTerminationFlow.test.js`
Expected: Toàn bộ 10 bộ test PASS 100% (không gãy bất kỳ luồng OTP, RLS `045` hay giữ chỗ nội bộ 8–29 ngày nào).

- [ ] **Step 5: Commit Task 3**

```bash
git add api/src/services/otpService.js api/src/routes/auth.js api/src/services/imageUpload.js api/src/routes/attachments.js api/src/services/depositSettlement.js api/src/routes/reservations.js api/src/routes/public.js api/src/routes/resident.js api/src/server.js api/test/m06Phase3P2Features.test.js
git commit -m "feat(reservations): add PENDING_CONFIRM manual verification flow, shared OTP guard, rounded split policy, and public booking API"
```

---

### Task 4: Giao diện Cấu hình Chính sách (`SettingsPage`), Xác nhận Sao kê / Thanh lý Giữ chỗ & Trang chủ Công khai `/` (`/explore`) (`GAP-06`)

**Files:**
- Modify: `frontend/src/constants/statuses.js`
- Modify: `frontend/src/utils/depositUiHelpers.js`
- Modify: `frontend/src/services/buildings.service.js`
- Create: `frontend/src/services/public.service.js`
- Modify: `frontend/src/pages/admin/settings/SettingsPage.jsx`
- Modify: `frontend/src/pages/admin/buildings/FloorPlanPage.jsx`
- Modify: `frontend/src/pages/admin/apartments/ApartmentDetailPage.jsx`
- Create: `frontend/src/pages/public/PublicExplorePage.jsx`
- Modify: `frontend/src/router/index.jsx`
- Modify: `frontend/src/pages/auth/LoginPage.jsx`
- Create: `frontend/src/utils/__tests__/m06Phase3Ui.test.js`

**Interfaces:**
- Consumes: Các endpoint `/api/v1/reservations/cancel-policy`, `/api/v1/reservations/:id/confirm-payment`, `/api/v1/reservations/:id/reject-payment`, `/api/v1/reservations/:id/cancel-settle`, `/api/v1/settings`, `/api/v1/public/*` từ Task 3; `canActorApproveReservationRow` từ `frontend/src/utils/depositUiHelpers.js` (`045`).
- Produces:
  - `RESERVATION_STATUS` trong `frontend/src/constants/statuses.js`:
    - `PENDING_CONFIRM: { label: 'Chờ xác nhận chuyển khoản', variant: 'amber' }`
    - `PARTIALLY_REFUNDED: { label: 'Hoàn một phần', variant: 'amber' }`
    - `REJECTED: { label: 'Từ chối xác nhận', variant: 'red' }`
  - Các helper thuần bổ sung trong `frontend/src/utils/depositUiHelpers.js`:
    - `computeSuggestedCancelSplit({ holdAmount, holdUntil, todayStr, policy }) -> { refunded_amount: number, forfeited_amount: number }` (làm tròn `refunded_amount` đến hàng nghìn VND `Math.round(raw / 1000) * 1000`, `forfeited_amount = holdAmount - refunded_amount`).
    - `canManagerConfirmReservationPayment(reservation, { isManager }) -> boolean` (`true` khi `isManager && reservation?.status === 'PENDING_CONFIRM'`).
    - `canSettleReservationCancel(reservation) -> boolean` (`true` khi `(reservation?.status === 'HELD' || (reservation?.status === 'EXPIRED' && (reservation?.source !== 'PUBLIC' || Boolean(reservation?.confirmed_at))))` và `Number(reservation?.refunded_amount || 0) + Number(reservation?.forfeited_amount || 0) === 0`).
  - Route `/` (khi chưa đăng nhập) và `/explore` render `PublicExplorePage.jsx` theo Sitemap PRD Mục 8.1.

- [ ] **Step 1: Viết unit test Frontend `frontend/src/utils/__tests__/m06Phase3Ui.test.js`**

Kiểm tra:
1. `computeSuggestedCancelSplit`:
   - Hủy trước hạn `>= 3 ngày` → hoàn `100%`.
   - Hủy sát hạn `1 ngày` với `holdAmount = 2_000_000, partial_refund_pct = 50` → `{ refunded_amount: 1000000, forfeited_amount: 1000000 }`; với `holdAmount = 1_050_000, partial_refund_pct = 33` → làm tròn hàng nghìn `{ refunded_amount: 347000, forfeited_amount: 703000 }` (tổng luôn khớp `holdAmount`).
   - Quá hạn `< 0 ngày` → hoàn `0`, phạt `100%`.
2. `canSettleReservationCancel` trả `true` cho `'HELD'` và `'EXPIRED'` (đã xác nhận tiền) chưa hạch toán, nhưng trả **`false`** cho `'PENDING_CONFIRM'`, `'REJECTED'`, `'EXPIRED'` công khai chưa từng xác nhận tiền (`source === 'PUBLIC' && !confirmed_at`), `'PARTIALLY_REFUNDED'`, `'REFUNDED'`, `'FORFEITED'`, `'CONVERTED'`.
3. `canManagerConfirmReservationPayment` chỉ trả `true` khi `isManager === true && status === 'PENDING_CONFIRM'`; `RESERVATION_STATUS` có đủ `PENDING_CONFIRM`, `PARTIALLY_REFUNDED`, `REJECTED`.

- [ ] **Step 2: Chạy test Frontend xác nhận FAIL**

Run: `cd d:\resihub\frontend; node --test src/utils/__tests__/m06Phase3Ui.test.js`
Expected: FAIL (`computeSuggestedCancelSplit`, `canSettleReservationCancel`, `canManagerConfirmReservationPayment` và các trạng thái mới chưa tồn tại).

- [ ] **Step 3: Cập nhật `SettingsPage.jsx`, Giao diện Xác nhận / Thanh lý Giữ chỗ và Xây dựng Trang chủ Công khai `/` (`/explore`)**

- Cập nhật `statuses.js`, `depositUiHelpers.js`, `buildings.service.js`, và tạo `public.service.js` (tự gắn `Idempotency-Key` từ `frontend/src/utils/idempotency.js`).
- Trong `SettingsPage.jsx`: thêm thẻ `"Chính sách Đặt cọc Giữ chỗ (FR-005 / FR-067)"` đọc & lưu khóa `reservation_cancel_policy` (kèm chú thích làm tròn hàng nghìn VND theo PRD 10.3).
- Trong `FloorPlanPage.jsx` và `ApartmentDetailPage.jsx`:
  - Form tạo giữ chỗ nội bộ có chọn `Phương thức thu`, điền mặc định `default_hold_amount` từ chính sách và tải ảnh biên lai (`evidence`).
  - Với phiếu `status === 'PENDING_CONFIRM'`: hiển thị xem ảnh UNC qua `AuthImage`, nút `Xác nhận tiền về (Giữ phòng)` và nút `Từ chối biên lai` (nhập lý do bắt buộc) dành cho `MANAGER`.
  - Với phiếu thỏa `canSettleReservationCancel(row)` và `canActorApproveReservationRow(..., creatorId: row.confirmed_by || row.created_by)`: mở modal `Thanh lý hủy theo chính sách` tự động điền gợi ý từ `computeSuggestedCancelSplit`, bắt buộc nhập thông tin tài khoản nhận hoàn (`BankSelect` + STK + Chủ TK) khi `refunded_amount > 0 && refund_method === 'BANK_TRANSFER'`, và giữ nguyên `Idempotency-Key` theo phiên mở modal.
- Tạo `PublicExplorePage.jsx` theo Sitemap PRD Mục 8.1 (`H1` Giới thiệu tòa nhà & tiện ích, `H2` Bộ lọc & danh sách căn hộ `AVAILABLE`, `H3` Modal Đặt giữ chỗ online hiển thị `payment_account`/VietQR theo tòa + chính sách hủy của tổ chức `policies_by_org[building.org_id]` + xác thực OTP 6 số + checkbox đồng ý dữ liệu cá nhân `PRD 17.1` + upload biên lai UNC, màn hình hoàn tất thông báo rõ *"Yêu cầu giữ chỗ đang chờ Ban quản lý đối chiếu sao kê xác nhận"* kèm nút dẫn sang Đăng nhập OTP Cổng cư dân `L`).
- Cập nhật `router/index.jsx` (`RootRedirect` tại `/` render `PublicExplorePage` khi `!isAuthenticated`, thêm `/explore`) và `LoginPage.jsx` (liên kết quay về `/explore`).

- [ ] **Step 4: Chạy toàn bộ unit test Frontend (Giai đoạn 1 + 2 + 3), lint và build kiểm tra production**

Run: `cd d:\resihub\frontend; node --test src/utils/__tests__/m06Phase1Ui.test.js src/utils/__tests__/m06Phase2Ui.test.js src/utils/__tests__/m06Phase3Ui.test.js; npm run lint; npm run build`
Expected: Toàn bộ 3 bộ unit test PASS, `0` lỗi lint và Vite build thành công `0 errors`.

- [ ] **Step 5: Commit Task 4**

```bash
git add frontend/src/constants/statuses.js frontend/src/utils/depositUiHelpers.js frontend/src/services/buildings.service.js frontend/src/services/public.service.js frontend/src/pages/admin/settings/SettingsPage.jsx frontend/src/pages/admin/buildings/FloorPlanPage.jsx frontend/src/pages/admin/apartments/ApartmentDetailPage.jsx frontend/src/pages/public/PublicExplorePage.jsx frontend/src/router/index.jsx frontend/src/pages/auth/LoginPage.jsx frontend/src/utils/__tests__/m06Phase3Ui.test.js
git commit -m "feat(frontend): add reservation policy settings, PENDING_CONFIRM verification & split settlement UI, and public storefront at /"
```
