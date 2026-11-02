# Chuẩn hóa Giai đoạn 1 (P0) — An toàn Tiền cọc, Toàn vẹn Four-Eyes, Giữ chỗ & Idempotency-Key Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Khắc phục triệt để 5 cụm lỗi nghiêm trọng mức `P0` (`BUG-01`, `BUG-02`, `BUG-03`, `BUG-04`, `BUG-06`), khóa trần tiền cọc xuyên suốt từ Giữ chỗ / Chuyển phòng sang Sổ cọc, bảo toàn cân đối sổ cái `deposit_transaction` khi khấu trừ vượt cọc, thông báo bảng kê cho cư dân trước khi duyệt chi (`R-12`), và thực thi chống ghi trùng giao dịch tiền tệ `Idempotency-Key` (`GAP-04`, PRD Mục 14.3) trên toàn bộ Backend + Admin + Cổng cư dân của phân hệ `M06`.

**Architecture:** Siết chặt bất biến nghiệp vụ tại 3 tầng (PostgreSQL `CHECK` constraints `044` → Domain Service `depositSettlement.js` → Express Routes `deposits.js`, `contracts.js`, `resident.js`, `reservations.js`, `daily.js` kèm `idempotencyGuard()`). Khóa cứng trần `amount_held <= contract.deposit_amount` ở mọi ngả vào sổ cọc (`collect`, kích hoạt HĐ từ `reservation`, `transfer-room`); gửi thông báo bảng kê `SETTLEMENT_STATEMENT_READY` cho cư dân ngay khi trình duyệt và lưu chứng từ vào bảng `attachment`; đối chiếu toàn diện snapshot công nợ & hóa đơn mở lúc duyệt 4 mắt (`409 SETTLEMENT_SNAPSHOT_STALE`) và chặn trần bút toán `deduct` không vượt `heldBefore`; bắt buộc `bank_info` khi hoàn chuyển khoản `refund > 0`; đồng bộ trạng thái `DEDUCTED_FULL` trên toàn bộ API, PDF A4, khiếu nại, Cron job, Admin UI và Cổng cư dân; chuẩn hóa múi giờ `'Asia/Ho_Chi_Minh'`, cho phép xử lý `forfeit`/`refund` cả phiếu giữ chỗ `'EXPIRED'` (`FR-067`) kèm Four-Eyes + lý do bắt buộc, và mặc định bắt buộc `Idempotency-Key` khi `NODE_ENV=production`.

**Tech Stack:** Node.js (ESM), Express 4, PostgreSQL 16 (RLS + Constraints), `node:test`, React 19, Vite 8, Tailwind CSS.

**Spec:** `PRD - Quan ly Can ho va Nha cho thue v2.0.md` (`FR-013`, `FR-022`, `FR-023`, `FR-024`, `FR-025`, `FR-067`, `FR-068`, `AC-017.1..3`, Mục 6.2, Mục 7.4–7.5, Mục 13.2, Mục 13.4, Mục 14.3, `NFR-010`, `NFR-016`, `R-12`) & `docs/BAO_CAO_RA_SOAT_THU_HOAN_COC_M06.md` (`BUG-01..04`, `BUG-06`, `GAP-04`).
> **Ràng buộc phát hành Production (Release Gate với Giai đoạn 2):** Kế hoạch Giai đoạn 1 (`044`) này và kế hoạch Giai đoạn 2 (`045` — `docs/superpowers/plans/2026-11-02-m06-phase2-p1-owner-approval-payout-returned-rls.md`) **phải được phát hành đồng thời lên Production trong cùng đợt release**. Lý do: Giai đoạn 1 khóa chặt Four-Eyes trên `forfeit`/`refund`/`settlement`, còn Giai đoạn 2 mở quyền `OWNER = R + A(hoàn cọc)` theo PRD Mục 6.2 (tránh deadlock duyệt 4 mắt ở tòa chỉ có 1 `MANAGER`), tách bước chi tiền đính kèm UNC (`APPROVED_PENDING_PAYOUT -> payout`), kiểm tra biên bản bàn giao có ảnh (`GAP-03`), luồng `RETURNED` sai STK (`GAP-02`) và gỡ bỏ `adminPool` thực thi RLS (`BUG-05/07`).

## Global Constraints

- **Tiền tệ nguyên dương VND & Múi giờ chuẩn (`NFR-010`, `NFR-016`, PRD Mục 13.4):** Mọi số tiền thu cọc, khấu trừ, hoàn cọc, giữ chỗ lưu trữ và tính toán bằng số nguyên `BIGINT` / `BigInt` đơn vị `VND` (`> 0`), chuẩn hóa `trim()` thành số nguyên trước khi lưu JSONB/DB, từ chối số thực dấu phẩy động, `boolean`, mảng hoặc chuỗi rỗng/khoảng trắng. Mọi phép quy đổi ngày lịch (`YYYY-MM-DD`) ở giữ chỗ và điều kiện tất toán tính theo múi giờ `'Asia/Ho_Chi_Minh'`.
- **Trần tiền cọc xuyên suốt & Chứng từ thu cọc (`FR-013`, `FR-022`, `FR-025`, `FR-067`, `BUG-01`):**
  - `POST /api/v1/deposits/:id/transactions` chỉ chấp nhận `type = 'collect'` (`409 TRANSFER_INTERNAL_ONLY` nếu `type = 'transfer'`), `method` thuộc `['BANK_TRANSFER', 'CASH', 'CARD', 'EWALLET', 'E_WALLET', 'QR_CODE', 'OTHER']` (`400 INVALID_METHOD`), chỉ cho phép khi `deposit.status = 'HELD'` và `contract.status IN ('ACTIVE', 'RENEWAL_PENDING', 'TERMINATION_PENDING')`, lưu chứng từ `evidence` (nếu có) vào bảng `attachment`, và bắt buộc `BigInt(amount_held) + BigInt(amount) <= BigInt(contract.deposit_amount ?? 0)` kể cả khi `contract.deposit_amount = 0` (`422 DEPOSIT_EXCEEDS_CONTRACT_AMOUNT`).
  - Tại `contracts.js`: chặn tạo/kích hoạt hợp đồng gắn phiếu giữ chỗ khi `BigInt(contract.deposit_amount ?? 0) < BigInt(matchedRsv.hold_amount)` (`422 DEPOSIT_BELOW_RESERVATION_HOLD`); khi chuyển phòng (`POST /api/v1/contracts/:id/transfer-room` với `transfer_deposit = true`) mà `oldDep.amount_held > newContract.deposit_amount`, chỉ kết chuyển tối đa `transferAmt = min(heldAmt, targetDep)` sang HĐ mới và giữ phần dư `surplusAmt` trên sổ cọc cũ kèm `refund_due_date` chờ hoàn trả (đồng nhất với gia hạn HĐ).
- **Thông báo trước duyệt chi, Toàn vẹn Snapshot Four-Eyes & Cân đối Sổ cái (`FR-024`, `AC-017.2..3`, `R-12`, `BUG-02`):**
  - Khi `POST /api/v1/deposits/:id/settlement` chuyển sang `PENDING_APPROVAL`, lưu `items[].evidence` vào `attachment` và gửi ngay thông báo in-app `SETTLEMENT_STATEMENT_READY` cho cư dân đứng tên HĐ (`primary_tenant`) để cư dân đối chiếu và có quyền gửi `POST /:id/dispute` trước khi duyệt chi.
  - Khi `POST /api/v1/deposits/:id/settlement/approve`, khóa `FOR UPDATE` sổ cọc và các hóa đơn mở của HĐ; nếu lệch `serviceDebt`, `rentDebt`, `heldBefore` hoặc `open_invoice_snapshot`, bắt buộc rollback và trả `409 SETTLEMENT_SNAPSHOT_STALE`. Khi ghi `deposit_transaction(type='deduct')`, tổng số tiền khấu trừ ghi vào sổ cái cọc không bao giờ vượt quá `heldBefore` (phần vượt ghi nhận ở `settlement.shortfall` và `receivable` loại `RECEIVABLE_AFTER_MOVE_OUT`).
- **Thông tin tài khoản hoàn cọc (`FR-024`, `BUG-03`):** `refund_method` chỉ thuộc `['BANK_TRANSFER', 'CASH']`. Khi `refund > 0n` và `refund_method === 'BANK_TRANSFER'`, bắt buộc `bank_info.bank_name`, `bank_info.account_number` (sau `trim()` khớp `/^[A-Za-z0-9]{4,25}$/`), và `bank_info.account_holder` khác rỗng (`422 INVALID_REFUND_METHOD` / `422 BANK_INFO_REQUIRED` / `422 INVALID_ACCOUNT_NUMBER`).
- **Đồng bộ trạng thái `DEDUCTED_FULL` (`FR-024`, `AC-017.2`, `BUG-04`):** Mở rộng `deposit.status` thêm `'DEDUCTED_FULL'` (*"Đã khấu trừ hết cọc"* — chi tiết hóa trạng thái tất toán `refund = 0` khi `totalDeductions > 0n || shortfall > 0n`), chỉ trả `'REFUNDED'` (*"Đã hoàn đủ 100%"*) khi không phát sinh khấu trừ hay thiếu hụt. Đồng bộ `'DEDUCTED_FULL'` tại `GET /:id/settlement`, `GET /:id/settlement/pdf`, `POST /:id/dispute`, `POST /:id/resolve-dispute` (`CONFIRM` khôi phục `'DEDUCTED_FULL'`; `ADJUST` chặn `409 ALREADY_PAID_OUT` do sổ cái bất biến `037`), `GET /api/v1/resident/overview`, `daily.js`, `DepositsPage.jsx` và `ContractTab.jsx`.
- **Đặt cọc giữ chỗ kể cả khi quá hạn (`FR-067`, `NFR-016`, PRD Mục 13.4, `BUG-06`):** `hold_amount` bắt buộc `NOT NULL` và nguyên dương `> 0` (`400 INVALID_HOLD_AMOUNT`); dọn sạch các dòng `HELD` lịch sử có `hold_amount <= 0` trước khi gắn `CHECK (...) NOT VALID` để không gây lỗi `23514` khi cron quét; `PATCH /api/v1/reservations/:id/convert` trả `409 MUST_CONVERT_VIA_CONTRACT_ACTIVATION`; cả `PATCH /api/v1/reservations/:id/forfeit` lẫn `PATCH /api/v1/reservations/:id/refund` đều chấp nhận phiếu ở trạng thái `['HELD', 'EXPIRED']` (có `hold_amount > 0`), bắt buộc `reason` không rỗng (`400 REASON_REQUIRED`), nối thêm lý do vào `reservation.note` bảo toàn ghi chú gốc, và kiểm tra 4 mắt `checkFourEyesOrWarn` (`403 FOUR_EYES_VIOLATION`).
- **Chống gửi đúp bắt buộc trên Production (`GAP-04`, PRD Mục 14.3):** `idempotencyGuard()` mặc định bắt buộc header `Idempotency-Key` khi `NODE_ENV === 'production'` (trừ khi cấu hình tường minh `REQUIRE_IDEMPOTENCY_KEY=false`, giữ mặc định tắt ở `dev`/`test` để tương thích ngược bộ test cũ). Gắn `idempotencyGuard()` lên toàn bộ route ghi ở `deposits.js` và `reservations.js`; trên Frontend xoay vòng `Idempotency-Key` mới cho mỗi lần mở form/modal hoặc ngay sau khi submit thành công `201` trong modal đa giao dịch.

## Review Focus

1. **Số tiền là số thập phân, `boolean`, mảng hoặc chuỗi khoảng trắng (`1000.5`, `true`, `' 1000000 '`, `'   '`) ở cả `collect` lẫn `settlement.items`:** Số không nguyên dương phải bị từ chối `400`/`422 INVALID_AMOUNT` (không làm tròn ngầm, không để `BigInt(1000.5)` ném `RangeError 500`), còn chuỗi nguyên dương có khoảng trắng `' 1000000 '` phải được chuẩn hóa thành số nguyên `1000000` trước khi ghi vào JSONB `settlement.items` (kiểm thử tại Task 1 & Task 2).
2. **Hợp đồng miễn cọc / giảm cọc từ Giữ chỗ hoặc Chuyển phòng & Tất toán vượt cọc (`heldBefore = 5.000.000`, `DAMAGE = 6.500.000`):** Thu bổ sung trên HĐ cọc `0 ₫` bị chặn `422 DEPOSIT_EXCEEDS_CONTRACT_AMOUNT`; kích hoạt HĐ có `deposit_amount < reservation.hold_amount` bị chặn `422 DEPOSIT_BELOW_RESERVATION_HOLD`; chuyển phòng sang căn có mức cọc thấp hơn tự tách phần dư ở lại sổ cọc cũ chờ hoàn; tất toán vượt cọc chỉ ghi `deposit_transaction(type='deduct', amount=5.000.000)` để sổ cọc không âm, ghi `1.500.000 ₫` vào `RECEIVABLE_AFTER_MOVE_OUT`, gửi trước thông báo `SETTLEMENT_STATEMENT_READY` cho cư dân, và in PDF A4 của hồ sơ `DEDUCTED_FULL` hiển thị đúng `5.000.000 ₫` (kiểm thử tại Task 2).
3. **Biến động hóa đơn ngầm giữa lúc biên bản tất toán đang `PENDING_APPROVAL`:** Kể cả khi khách trả bớt nợ dịch vụ, hoặc trả hóa đơn A `500k` đồng thời phát sinh hóa đơn B `500k` (tổng `serviceDebt` không đổi nhưng danh sách hóa đơn mở thay đổi), `POST /:id/settlement/approve` vẫn phải chặn `409 SETTLEMENT_SNAPSHOT_STALE` (kiểm thử tại Task 2).
4. **Phiếu giữ chỗ quá hạn (`status = 'EXPIRED'`) bởi `runDailyJobs()` và dòng dữ liệu lịch sử `hold_amount = 0`:** Phiếu giữ chỗ có tiền cọc thật sau khi cron đêm chuyển sang `'EXPIRED'` vẫn phải cho phép duyệt `forfeit` hoặc `refund` theo `FR-067` (không bị kẹt tiền vĩnh viễn); đồng thời dòng lịch sử `hold_amount = 0` không được làm sập `runDailyJobs()` bởi constraint `NOT VALID` `23514` (kiểm thử tại Task 1 & Task 3).
5. **Xoay vòng `Idempotency-Key` khi thu cọc nhiều đợt trong cùng một modal & mặc định bắt buộc trên Production (`NODE_ENV=production`):** Cùng khóa + cùng body trả lại bản ghi cũ kèm `Idempotent-Replayed: true`; cùng khóa khác `amount` trả `409 IDEMPOTENCY_KEY_CONFLICT`; thiếu header khi `NODE_ENV=production` (không set `REQUIRE_IDEMPOTENCY_KEY`) trả `400 IDEMPOTENCY_KEY_REQUIRED`; thu bổ sung 2 đợt liên tiếp trong cùng phiên mở modal `Sổ giao dịch` trên `DepositsPage.jsx` phải sinh khóa mới cho đợt 2 (kiểm thử tại Task 2, Task 3 & Task 4).

---

## File Structure

### Database & Backend (`api/`)
- **Create:** `api/src/db/migrations/044_m06_p0_deposit_and_reservation_guards.sql` — Mở rộng `CHECK` constraint `deposit.status` thêm `'DEDUCTED_FULL'`; chuyển các dòng `reservation` lịch sử có `status = 'HELD' AND (hold_amount IS NULL OR hold_amount <= 0)` sang `'EXPIRED'`, bỏ `DEFAULT 0` trên `reservation.hold_amount` và gắn `chk_reservation_hold_amount_positive CHECK (hold_amount IS NOT NULL AND hold_amount > 0) NOT VALID`.
- **Modify:** `api/src/middleware/idempotency.js:30-32` & `api/.env.example` — Mặc định `mustRequire = true` khi `NODE_ENV === 'production'` (cho phép override qua `REQUIRE_IDEMPOTENCY_KEY`); tài liệu hóa rõ trong `.env.example`.
- **Modify:** `api/src/services/depositSettlement.js` — Thêm `isPositiveSafeIntegerVnd(value)`, `getTodayVnDateStr(dateInput)` và `isSettlementSnapshotStale(savedSettlement, liveState)`; cập nhật `validateDeduction` bắt buộc số nguyên dương VND; cập nhật `resolvePostSettlementStatus` trả `'DEDUCTED_FULL'` khi `refund === 0n && (totalDeductions > 0n || sf > 0n)`; thêm `validateRefundBankInfo({ refundAmount, refundMethod, bankInfo })`.
- **Modify:** `api/src/routes/deposits.js` — Gắn `idempotencyGuard()` vào 6 route `POST`; chuẩn hóa ngày theo múi giờ VN ở `checkSettlementPreconditions`; thêm helper `insertDepositAttachments` ghi bảng `attachment`; siết `POST /:id/transactions` (`BUG-01`); chuẩn hóa số nguyên `items[].amount`, validate `validateRefundBankInfo`, lưu `open_invoice_snapshot` và gửi thông báo `SETTLEMENT_STATEMENT_READY` cho cư dân tại `POST /:id/settlement` (`BUG-03`, `R-12`); trả `snapshot_stale` tại `GET /:id/settlement`, khóa `FOR UPDATE` hóa đơn mở, kiểm tra `isSettlementSnapshotStale` (`409 SETTLEMENT_SNAPSHOT_STALE`) và giới hạn trần `deposit_transaction(type='deduct') <= heldBefore` tại `POST /:id/settlement/approve` (`BUG-02`); đồng bộ `'DEDUCTED_FULL'` tại `GET /:id/settlement`, `GET /:id/settlement/pdf`, `POST /:id/dispute` và `POST /:id/resolve-dispute`.
- **Modify:** `api/src/routes/contracts.js:1503-1515,2662-2700,2890-2915,4696-4745` — Tách helper `findMatchingHeldReservation(dbClient, contract, req)` (chuẩn múi giờ `'Asia/Ho_Chi_Minh'`), chặn `deposit_amount < hold_amount` (`422 DEPOSIT_BELOW_RESERVATION_HOLD`) khi tạo HĐ có `reservation_id` và đầu `completeActivation` trước khi kích hoạt / trình duyệt giá HĐ; giới hạn `transferAmt = min(heldAmt, targetDep)` khi `transfer-room` có `transfer_deposit = true`, giữ phần dư `surplusAmt` trên sổ cọc cũ kèm `refund_due_date`.
- **Modify:** `api/src/routes/resident.js:170-175` — Bổ sung `'DEDUCTED_FULL'` vào điều kiện lọc `depositSettlements` trả về cho Cổng cư dân.
- **Modify:** `api/src/jobs/daily.js:40,85,376` — Bổ sung `'DEDUCTED_FULL'` vào `NOT IN ('REFUNDED', 'PARTIALLY_REFUNDED', 'DEDUCTED_FULL', 'TRANSFERRED')`.
- **Modify:** `api/src/routes/reservations.js` — Gắn `idempotencyGuard()`; dùng `getTodayVnDateStr()` và `(created_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date`; chặn `hold_amount` không nguyên dương; khóa `PATCH /:id/convert`; cho phép `['HELD', 'EXPIRED']` (với `hold_amount > 0`) + bắt buộc `reason` + nối ghi chú bảo toàn lịch sử + `checkFourEyesOrWarn` cho cả `PATCH /:id/forfeit` và `PATCH /:id/refund` (`BUG-06`, `FR-067`).
- **Modify:** `api/test/depositRules.test.js` — Unit test cho `isPositiveSafeIntegerVnd`, `getTodayVnDateStr`, `validateDeduction`, `resolvePostSettlementStatus` và `validateRefundBankInfo`.
- **Modify:** `api/test/depositCollectAndRefund.test.js:218-252,710-725` — Cập nhật `{ reason }` cho `refund`/`forfeit`, dùng `sysAdmin.token` cho `forfeit` 4 mắt, cập nhật kỳ vọng `'DEDUCTED_FULL'` và kiểm tra tổng `deduct` trong `deposit_transaction`.
- **Modify:** `api/test/remediationR01ToR24.test.js:462-490` — Bổ sung `refund_method: 'CASH'` cho `subSettle1` & `subSettle2`.
- **Modify:** `api/test/fullWebsiteWhiteBlackBox.test.js:850-856` — Đổi lời gọi `forfeit` sang `mgr2VopA.token` kèm `{ reason }`.
- **Create:** `api/test/m06Phase1P0Fixes.test.js` — Integration test toàn diện cho `BUG-01..04`, `BUG-06`, `GAP-04`, trần cọc liên phân hệ (`contracts.js`), thông báo `SETTLEMENT_STATEMENT_READY` và 5 kịch bản Review Focus.

### Frontend (`frontend/`)
- **Create:** `frontend/src/utils/idempotency.js` — Export dùng chung `createIdempotencyKey()`, `withIdempotency(options)` và `canCollectAdditionalDeposit(row)`.
- **Modify:** `frontend/src/services/contracts.service.js:1-17` — Chuyển sang import `createIdempotencyKey`, `withIdempotency` từ `../utils/idempotency`.
- **Modify:** `frontend/src/services/deposits.service.js` — Hỗ trợ tham số `options` đính kèm `withIdempotency(options)` cho `createTransaction`, `submitSettlement`, `approveSettlement`, `rejectSettlement`, `dispute`, `resolveDispute`.
- **Modify:** `frontend/src/services/resident.service.js:33-35` — Cập nhật `disputeDeposit(depositId, payload, options)` đính kèm `withIdempotency(options)`.
- **Modify:** `frontend/src/services/buildings.service.js:33-38` — Gỡ bỏ `convertReservation`; gắn `withIdempotency(options)` cho `createReservation`, `forfeitReservation`, `refundReservation`.
- **Modify:** `frontend/src/constants/statuses.js:52-60` — Thêm `DEDUCTED_FULL: { label: 'Đã khấu trừ hết cọc', variant: 'amber' }`, đổi nhãn `REFUNDED` thành `'Đã hoàn đủ 100%'`.
- **Modify:** `frontend/src/pages/admin/deposits/DepositsPage.jsx` — Dùng `canCollectAdditionalDeposit(row)` cho cả nút `Thu bổ sung` lẫn nhãn phụ `Còn phải thu`; chặn nhập vượt `shortage`; xoay mới `collectIdemKeyRef` mỗi lần mở form **và** ngay sau khi thu thành công `201`; bắt buộc `bankInfo` khi `liveCalc.refundAmount > 0 && refundMethod === 'BANK_TRANSFER'`; cảnh báo lệch snapshot trên màn hình duyệt; đồng bộ `'DEDUCTED_FULL'` tại mọi bộ lọc/nhãn/nút và điều hướng đúng tab sau `resolve-dispute`.
- **Modify:** `frontend/src/pages/resident/tabs/ContractTab.jsx:313-340,378-385,784-789,884-886` — Bao gồm `'DEDUCTED_FULL'` trong `inSettlementStatus`, `canDispute` và `isFinalized`; giữ `Idempotency-Key` theo phiên mở modal khiếu nại.
- **Modify:** `frontend/src/pages/admin/buildings/FloorPlanPage.jsx:260-305,850-857` & `frontend/src/pages/admin/apartments/ApartmentDetailPage.jsx:172-186,450-465` — Chặn `hold_amount <= 0` trên form giữ chỗ; hiển thị nút `Hoàn cọc` & `Tịch thu` cho cả phiếu `['HELD', 'EXPIRED']` (`hold_amount > 0`) kèm Modal nhập `reason` bắt buộc và `Idempotency-Key` theo phiên mở modal.
- **Create:** `frontend/src/utils/__tests__/m06Phase1Ui.test.js` — Unit test cho `idempotency.js`, `DEPOSIT_STATUS`, `canCollectAdditionalDeposit`, `buildings.service.js` và `resident.service.js`.

---

### Task 1: Chuẩn hóa Số nguyên VND, Ngày Múi giờ VN, Trạng thái `DEDUCTED_FULL`, Validate Tài khoản Hoàn cọc & Migration `044` (`BUG-03`, `BUG-04`)

**Files:**
- Create: `api/src/db/migrations/044_m06_p0_deposit_and_reservation_guards.sql`
- Modify: `api/src/services/depositSettlement.js`
- Modify: `api/test/depositRules.test.js`

**Interfaces:**
- Produces:
  - Giá trị `'DEDUCTED_FULL'` hợp lệ trong `deposit.status`; các dòng `reservation` lịch sử có `status = 'HELD' AND (hold_amount IS NULL OR hold_amount <= 0)` được chuyển trước sang `'EXPIRED'`; cột `reservation.hold_amount` bỏ `DEFAULT 0` và gắn constraint `chk_reservation_hold_amount_positive CHECK (hold_amount IS NOT NULL AND hold_amount > 0) NOT VALID`.
  - `isPositiveSafeIntegerVnd(value) -> boolean` (chỉ nhận `number` nguyên dương an toàn hoặc chuỗi chữ số nguyên dương `/^[1-9]\d*$/` sau `trim()`, từ chối `boolean`, mảng, số thực, `<= 0`).
  - `getTodayVnDateStr(dateInput = new Date()) -> string` (chuẩn hóa `Date` hoặc chuỗi ngày về `YYYY-MM-DD` theo `'Asia/Ho_Chi_Minh'`, trả `null` nếu đầu vào rỗng).
  - `validateDeduction(input)` sử dụng `isPositiveSafeIntegerVnd(input.amount)` (trả `{ ok: false, code: 'INVALID_AMOUNT' }` nếu là số thực `1000.5` hoặc `boolean`).
  - `resolvePostSettlementStatus({ refundAmount, outstandingDebt, items, shortfall }) -> 'REFUNDED' | 'PARTIALLY_REFUNDED' | 'DEDUCTED_FULL'`.
  - `validateRefundBankInfo({ refundAmount, refundMethod, bankInfo }) -> { ok: true, normalizedBankInfo: object } | { ok: false, code: 'INVALID_REFUND_METHOD' | 'BANK_INFO_REQUIRED' | 'INVALID_ACCOUNT_NUMBER', message: string }`.
  - `isSettlementSnapshotStale(savedSettlement, { serviceDebt, rentDebt, heldAmount, openInvoices }) -> boolean` (so khớp `outstanding_debt`, `rent_debt`, `deposit_held_before_settlement` và mảng chuẩn hóa `open_invoice_snapshot` theo `id` tăng dần).

- [ ] **Step 1: Viết unit test thất bại trong `api/test/depositRules.test.js`**

```javascript
import {
  isPositiveSafeIntegerVnd,
  getTodayVnDateStr,
  validateDeduction,
  computeRefund,
  splitDepositOpening,
  resolvePostSettlementStatus,
  validateRefundBankInfo,
  isSettlementSnapshotStale,
} from '../src/services/depositSettlement.js';

test('isPositiveSafeIntegerVnd, getTodayVnDateStr & validateDeduction: chặn số thập phân/boolean, chuẩn ngày giờ VN', () => {
  assert.equal(isPositiveSafeIntegerVnd(500000), true);
  assert.equal(isPositiveSafeIntegerVnd(' 1000000 '), true);
  for (const bad of [0, -100, 1000.5, '1000.5', '1e5', '', '   ', true, false, null, undefined, [1000]]) {
    assert.equal(isPositiveSafeIntegerVnd(bad), false, `Phải từ chối giá trị: ${JSON.stringify(bad)}`);
  }
  assert.equal(getTodayVnDateStr(new Date('2026-11-01T18:30:00Z')), '2026-11-02');
  assert.equal(getTodayVnDateStr('2026-11-02'), '2026-11-02');
  assert.equal(
    validateDeduction({ category: 'DAMAGE', amount: 1000.5, description: 'Lẻ xu', evidence: ['a.png'] }).code,
    'INVALID_AMOUNT'
  );
  assert.equal(
    validateDeduction({ category: 'DAMAGE', amount: true, description: 'Boolean', evidence: ['a.png'] }).code,
    'INVALID_AMOUNT'
  );
});

test('resolvePostSettlementStatus: hoàn 100% -> REFUNDED; hoàn 1 phần -> PARTIALLY_REFUNDED; trừ sạch cọc -> DEDUCTED_FULL; cọc 0 không trừ -> REFUNDED', () => {
  assert.equal(resolvePostSettlementStatus({ refundAmount: 10000000n, outstandingDebt: 0n, items: [], shortfall: 0n }), 'REFUNDED');
  assert.equal(resolvePostSettlementStatus({ refundAmount: 8000000n, outstandingDebt: 1200000n, items: [{ amount: 800000n }], shortfall: 0n }), 'PARTIALLY_REFUNDED');
  assert.equal(resolvePostSettlementStatus({ refundAmount: 0n, outstandingDebt: 0n, items: [{ amount: 5000000n }], shortfall: 0n }), 'DEDUCTED_FULL');
  assert.equal(resolvePostSettlementStatus({ refundAmount: 0n, outstandingDebt: 3000000n, items: [{ amount: 4000000n }], shortfall: 2000000n }), 'DEDUCTED_FULL');
  assert.equal(resolvePostSettlementStatus({ refundAmount: 0n, outstandingDebt: 0n, items: [], shortfall: 0n }), 'REFUNDED');
});

test('validateRefundBankInfo: bắt buộc STK hợp lệ khi refund > 0 và BANK_TRANSFER; bỏ qua khi CASH hoặc refund = 0', () => {
  assert.equal(validateRefundBankInfo({ refundAmount: 5000000, refundMethod: 'FOO', bankInfo: {} }).code, 'INVALID_REFUND_METHOD');
  assert.equal(validateRefundBankInfo({ refundAmount: 5000000, refundMethod: 'BANK_TRANSFER', bankInfo: {} }).code, 'BANK_INFO_REQUIRED');
  assert.equal(
    validateRefundBankInfo({
      refundAmount: 5000000,
      refundMethod: 'BANK_TRANSFER',
      bankInfo: { bank_name: 'VCB', account_number: ' 0011-0099 ', account_holder: 'NGUYEN VAN A' },
    }).code,
    'INVALID_ACCOUNT_NUMBER'
  );
  const okBank = validateRefundBankInfo({
    refundAmount: 5000000,
    refundMethod: 'BANK_TRANSFER',
    bankInfo: { bank_name: ' Vietcombank ', account_number: ' 001100999888 ', account_holder: ' NGUYEN VAN A ' },
  });
  assert.equal(okBank.ok, true);
  assert.equal(okBank.normalizedBankInfo.account_number, '001100999888');
  assert.equal(validateRefundBankInfo({ refundAmount: 0, refundMethod: 'BANK_TRANSFER', bankInfo: {} }).ok, true);
  assert.equal(validateRefundBankInfo({ refundAmount: 5000000, refundMethod: 'CASH', bankInfo: {} }).ok, true);
});

test('isSettlementSnapshotStale: phát hiện đổi hóa đơn mở dù tổng serviceDebt không đổi', () => {
  const saved = {
    outstanding_debt: 500000,
    rent_debt: 0,
    deposit_held_before_settlement: 5000000,
    open_invoice_snapshot: [{ id: 'inv-1', remaining: 500000, service_unpaid: 500000, rent_unpaid: 0 }],
  };
  assert.equal(
    isSettlementSnapshotStale(saved, {
      serviceDebt: 500000,
      rentDebt: 0,
      heldAmount: 5000000,
      openInvoices: [{ id: 'inv-1', remaining: 500000, service_unpaid: 500000, rent_unpaid: 0 }],
    }),
    false
  );
  assert.equal(
    isSettlementSnapshotStale(saved, {
      serviceDebt: 500000,
      rentDebt: 0,
      heldAmount: 5000000,
      openInvoices: [{ id: 'inv-2', remaining: 500000, service_unpaid: 500000, rent_unpaid: 0 }],
    }),
    true
  );
});
```

- [ ] **Step 2: Chạy unit test để xác nhận FAIL**

Run: `cd d:\resihub\api; node --test test/depositRules.test.js`
Expected: FAIL (`isPositiveSafeIntegerVnd`, `getTodayVnDateStr`, `validateRefundBankInfo`, `isSettlementSnapshotStale` chưa được export; `resolvePostSettlementStatus` chưa trả `'DEDUCTED_FULL'`).

- [ ] **Step 3: Tạo migration `044_m06_p0_deposit_and_reservation_guards.sql` và cập nhật `depositSettlement.js`**

Trong `api/src/db/migrations/044_m06_p0_deposit_and_reservation_guards.sql`:
- Dò động và gỡ `CHECK` constraint hiện tại của `deposit.status` qua `pg_constraint` trên bảng `deposit` (`pg_get_constraintdef(oid) ILIKE '%SETTLEMENT_DRAFT%'`), sau đó thêm `chk_deposit_status CHECK (status IN ('HELD','PARTIALLY_REFUNDED','REFUNDED','DEDUCTED_FULL','SETTLEMENT_DRAFT','PENDING_APPROVAL','DISPUTED','TRANSFERRED'))`.
- Trước khi gắn constraint trên `reservation`, chạy `UPDATE reservation SET status = 'EXPIRED', updated_at = NOW() WHERE status = 'HELD' AND (hold_amount IS NULL OR hold_amount <= 0);` (đồng bộ trả `apartment.status = 'AVAILABLE'` nếu căn đang `'RESERVED'` mà không còn phiếu `'HELD'` hay HĐ hiệu lực) để `runDailyJobs()` không bao giờ `UPDATE` trúng dòng `0 ₫` lịch sử gây lỗi `23514`.
- Thực hiện `ALTER TABLE reservation ALTER COLUMN hold_amount DROP DEFAULT;`, `ALTER TABLE reservation DROP CONSTRAINT IF EXISTS chk_reservation_hold_amount_positive;` và `ALTER TABLE reservation ADD CONSTRAINT chk_reservation_hold_amount_positive CHECK (hold_amount IS NOT NULL AND hold_amount > 0) NOT VALID;`.

Trong `api/src/services/depositSettlement.js`:
- Export `isPositiveSafeIntegerVnd(val)`: trả `true` nếu `(typeof val === 'number' && Number.isSafeInteger(val) && val > 0)` hoặc `(typeof val === 'string' && /^[1-9]\d*$/.test(val.trim()) && Number.isSafeInteger(Number(val.trim())))`.
- Export `getTodayVnDateStr(dateInput = new Date())`: nếu `!dateInput` trả `null`; nếu `dateInput instanceof Date` định dạng bằng `new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }).format(dateInput)`; nếu là chuỗi `'YYYY-MM-DD...'` trả `String(dateInput).slice(0, 10)`.
- Cập nhật `validateDeduction(input)` dùng `!isPositiveSafeIntegerVnd(amount)` → trả `{ ok: false, code: 'INVALID_AMOUNT', message: 'Số tiền khấu trừ phải là số nguyên dương VND.' }`.
- Cập nhật `resolvePostSettlementStatus`: nếu `refund === 0n && (totalDeductions > 0n || sf > 0n)` trả `'DEDUCTED_FULL'`; nếu `refund > 0n && (totalDeductions > 0n || sf > 0n)` trả `'PARTIALLY_REFUNDED'`; ngược lại trả `'REFUNDED'`.
- Export `validateRefundBankInfo({ refundAmount, refundMethod = 'BANK_TRANSFER', bankInfo = {} })`: kiểm tra `['BANK_TRANSFER', 'CASH'].includes(refundMethod)` (`INVALID_REFUND_METHOD`), chuẩn hóa `trim()` trên `bank_name`, `account_number`, `account_holder` (giữ lại `bank_code`, `bank_bin`, `bank_logo` nếu có); khi `BigInt(refundAmount ?? 0) > 0n && refundMethod === 'BANK_TRANSFER'`, bắt buộc cả 3 trường khác rỗng (`BANK_INFO_REQUIRED`) và `/^[A-Za-z0-9]{4,25}$/.test(account_number)` (`INVALID_ACCOUNT_NUMBER`).
- Export `isSettlementSnapshotStale(savedSettlement, { serviceDebt, rentDebt, heldAmount, openInvoices = [] })`: trả `true` nếu lệch `serviceDebt` vs `savedSettlement.outstanding_debt`, `rentDebt` vs `savedSettlement.rent_debt`, `heldAmount` vs `savedSettlement.deposit_held_before_settlement`, hoặc nếu `Array.isArray(savedSettlement.open_invoice_snapshot)` mà JSON chuẩn hóa theo `id` của `openInvoices` khác `savedSettlement.open_invoice_snapshot`.

- [ ] **Step 4: Chạy migrate và chạy lại unit test xác nhận PASS**

Run: `cd d:\resihub\api; npm run migrate; node --test test/depositRules.test.js`
Expected: Migration `044` thành công và toàn bộ test trong `depositRules.test.js` PASS.

- [ ] **Step 5: Commit Task 1**

```bash
git add api/src/db/migrations/044_m06_p0_deposit_and_reservation_guards.sql api/src/services/depositSettlement.js api/test/depositRules.test.js
git commit -m "feat(m06): add DEDUCTED_FULL status, VN date & integer VND guards, and migration 044"
```

---

### Task 2: Khóa Trần Tiền cọc Xuyên suốt (`deposits.js` + `contracts.js`), Thông báo Trước Chi (`R-12`), Cân đối Sổ cái Vượt Cọc, Đồng bộ `DEDUCTED_FULL` & `idempotencyGuard` (`BUG-01..04`, `GAP-04`)

**Files:**
- Modify: `api/src/middleware/idempotency.js:30-32`
- Modify: `api/.env.example`
- Modify: `api/src/routes/deposits.js`
- Modify: `api/src/routes/contracts.js:1503-1515,2662-2700,2890-2915,4696-4745`
- Modify: `api/src/routes/resident.js:170-175`
- Modify: `api/src/jobs/daily.js:40,85,376`
- Modify: `api/test/depositCollectAndRefund.test.js:710-725`
- Modify: `api/test/remediationR01ToR24.test.js:462-490`
- Create: `api/test/m06Phase1P0Fixes.test.js`

**Interfaces:**
- Consumes: `isPositiveSafeIntegerVnd`, `getTodayVnDateStr`, `validateRefundBankInfo`, `resolvePostSettlementStatus`, `isSettlementSnapshotStale` từ `api/src/services/depositSettlement.js`; `idempotencyGuard` từ `api/src/middleware/idempotency.js`.
- Produces:
  - `idempotencyGuard(options)`: `mustRequire = options.requireHeader ?? (process.env.REQUIRE_IDEMPOTENCY_KEY !== undefined ? process.env.REQUIRE_IDEMPOTENCY_KEY === 'true' : process.env.NODE_ENV === 'production')` (bắt buộc mặc định trên `production` theo PRD Mục 14.3).
  - Helper nội bộ `insertDepositAttachments(client, { ownerEntity = 'deposit', ownerId, evidenceUrls, uploadedBy })` trong `deposits.js`: lưu các đường dẫn chứng từ hợp lệ vào bảng `attachment (owner_entity, owner_id, storage_path, uploaded_by)` cho cả `collect` (`FR-022`) và `settlement.items` (`FR-024`).
  - `POST /api/v1/deposits/:id/transactions` (có `idempotencyGuard()`):
    - `type === 'transfer'` → `409 TRANSFER_INTERNAL_ONLY`.
    - `!isPositiveSafeIntegerVnd(amount)` → `400 INVALID_AMOUNT`; chuẩn hóa `txnAmount = BigInt(String(amount).trim())`.
    - `method` thiếu (`400 METHOD_REQUIRED`) hoặc không thuộc `['BANK_TRANSFER', 'CASH', 'CARD', 'EWALLET', 'E_WALLET', 'QR_CODE', 'OTHER']` → `400 INVALID_METHOD`.
    - `deposit.status !== 'HELD'` hoặc `!['ACTIVE', 'RENEWAL_PENDING', 'TERMINATION_PENDING'].includes(contract_status)` → `409 DEPOSIT_NOT_COLLECTIBLE`.
    - `BigInt(amount_held) + txnAmount > BigInt(contract_deposit_amount ?? 0)` (kể cả khi `contract_deposit_amount = 0`) → `422 DEPOSIT_EXCEEDS_CONTRACT_AMOUNT`.
  - Trần cọc liên phân hệ trong `api/src/routes/contracts.js`:
    - `POST /api/v1/contracts` (khi truyền `reservation_id`) và `completeActivation` (trước khi chuyển `PENDING_APPROVAL` hoặc `ACTIVE`): nếu phiếu giữ chỗ `HELD` khớp của HĐ có `BigInt(finalDeposit) < BigInt(matchedRsv.hold_amount)` → trả `422 DEPOSIT_BELOW_RESERVATION_HOLD`.
    - `POST /api/v1/contracts/:id/transfer-room` (khi `transfer_deposit === true`): tính `targetDep = BigInt(newContract.deposit_amount ?? 0)`, `transferAmt = targetDep > 0n ? (heldAmt > targetDep ? targetDep : heldAmt) : 0n`, `surplusAmt = heldAmt - transferAmt`; nếu `surplusAmt > 0n` giữ `oldDep` ở `status = 'HELD'`, `amount_held = surplusAmt` kèm `refund_due_date` để hoàn trả phần chênh lệch, chỉ kết chuyển `transferAmt` sang sổ cọc HĐ mới.
  - `POST /api/v1/deposits/:id/settlement` (có `idempotencyGuard()`): chuẩn hóa `items` (`amount: Number(String(item.amount).trim())`), gọi `validateRefundBankInfo` (`422` khi sai/thiếu), lưu `open_invoice_snapshot`, ghi `attachment`, và gửi thông báo in-app `type = 'SETTLEMENT_STATEMENT_READY'` tới `primary_tenant` của HĐ (`R-12`).
  - `GET /api/v1/deposits/:id/settlement`: trả thêm `snapshot_stale: boolean` (tính bằng `isSettlementSnapshotStale` khi `status === 'PENDING_APPROVAL'`).
  - `POST /api/v1/deposits/:id/settlement/approve` (có `idempotencyGuard()`): khóa `FOR UPDATE` các hóa đơn mở của HĐ; trả `409 SETTLEMENT_SNAPSHOT_STALE` nếu `isSettlementSnapshotStale(...) === true`; giới hạn tổng `deposit_transaction(type='deduct')` không vượt `heldBefore`.
  - Đồng bộ `'DEDUCTED_FULL'` tại `GET /:id/settlement`, `GET /:id/settlement/pdf`, `POST /:id/dispute`, `POST /:id/resolve-dispute`, `GET /api/v1/resident/overview` và `runDailyJobs()`.

- [ ] **Step 1: Viết integration test thất bại trong `api/test/m06Phase1P0Fixes.test.js` (Phần Sổ cọc & Trần cọc Hợp đồng)**

Kiểm tra đủ các trường hợp:
1. Gửi `type = 'transfer'` vào `POST /:id/transactions` → `409 TRANSFER_INTERNAL_ONLY`.
2. Gửi `amount = 1000.5` hoặc `amount = true` vào `POST /:id/transactions` → `400 INVALID_AMOUNT`; gửi `items: [{ amount: 1000.5, ... }]` vào `POST /:id/settlement` → `422 INVALID_AMOUNT` (không bị `500`); gửi `items: [{ amount: ' 500000 ', ... }]` được chuẩn hóa thành số nguyên `500000` trong `settlement.items[0].amount` và tạo bản ghi trong bảng `attachment` (Review Focus #1).
3. Thu vượt `contract.deposit_amount` (`10.000.000 ₫`) **và** thu cọc trên hợp đồng miễn cọc (`contract.deposit_amount = 0`) → `422 DEPOSIT_EXCEEDS_CONTRACT_AMOUNT`; kích hoạt HĐ gắn phiếu giữ chỗ `2.000.000 ₫` nhưng `deposit_amount = 1.000.000 ₫` → `422 DEPOSIT_BELOW_RESERVATION_HOLD`; chuyển phòng (`transfer_deposit: true`) từ HĐ đang giữ `9.000.000 ₫` sang HĐ mới có `deposit_amount = 6.000.000 ₫` → sổ cọc mới nhận đúng `6.000.000 ₫`, sổ cọc cũ giữ lại `3.000.000 ₫` (`status = 'HELD'`, có `refund_due_date`) (Review Focus #2).
4. Sổ cọc đang `SETTLEMENT_DRAFT` gọi `collect` → `409 DEPOSIT_NOT_COLLECTIBLE`.
5. Gửi lặp 2 lần cùng `Idempotency-Key` cho `collect` → chỉ tạo 1 dòng `deposit_transaction`, lần 2 có header `idempotent-replayed: 'true'`; cùng key khác `amount` → `409 IDEMPOTENCY_KEY_CONFLICT`; khi đặt `NODE_ENV = 'production'` (và xóa `REQUIRE_IDEMPOTENCY_KEY`) mà không gửi header → `400 IDEMPOTENCY_KEY_REQUIRED` (khôi phục biến môi trường trong `finally`) (Review Focus #5).
6. Trình tất toán `BANK_TRANSFER` khi `refund > 0` nhưng thiếu `bank_info` hoặc `account_number = '0011-0099'` → `422 BANK_INFO_REQUIRED` / `422 INVALID_ACCOUNT_NUMBER`.
7. Khi `POST /:id/settlement` thành công (`PENDING_APPROVAL`), hệ thống tạo ngay thông báo `notification` có `type = 'SETTLEMENT_STATEMENT_READY'` gửi cho `app_user` của cư dân đứng tên HĐ (`R-12`).
8. Sau khi trình tất toán (`PENDING_APPROVAL`), kiểm tra cả 3 biến động: (a) phát hành thêm hóa đơn dịch vụ, (b) khách trả bớt nợ dịch vụ, (c) khách trả `500.000 ₫` ở hóa đơn cũ đồng thời phát sinh hóa đơn mới `500.000 ₫` (tổng `serviceDebt` giữ nguyên nhưng `open_invoice_snapshot` thay đổi — Review Focus #3) → `POST /:id/settlement/approve` đều chặn `409 SETTLEMENT_SNAPSHOT_STALE`; từ chối về `SETTLEMENT_DRAFT`, trình lại số mới rồi duyệt → `200`.
9. Tất toán vượt cọc (`heldBefore = 5.000.000 ₫`, hư hỏng `6.500.000 ₫`, `refund = 0`, `shortfall = 1.500.000 ₫`) → sau khi duyệt:
   - `status === 'DEDUCTED_FULL'`.
   - Tổng `SUM(amount)` của `deposit_transaction WHERE deposit_id = $1 AND type = 'deduct'` đúng bằng `5.000.000` (không ghi lố `6.500.000`), còn `receivable` ghi đúng `1.500.000`.
   - `GET /api/v1/deposits/:id/settlement/pdf` hiển thị đúng `5.000.000` ở mục *Tiền đặt cọc bảo lưu thực tế*.
   - `GET /api/v1/resident/overview` trả về bản ghi `deposit_settlements` có `deposit_status === 'DEDUCTED_FULL'`.
   - Cư dân gửi `POST /:id/dispute` → `200 DISPUTED`; giải quyết `ADJUST` bị chặn `409 ALREADY_PAID_OUT`; giải quyết `CONFIRM` khôi phục đúng `'DEDUCTED_FULL'` (Review Focus #2).

- [ ] **Step 2: Chạy test mới để xác nhận FAIL**

Run: `cd d:\resihub\api; node --test test/m06Phase1P0Fixes.test.js`
Expected: FAIL trên các kiểm tra `TRANSFER_INTERNAL_ONLY`, `DEPOSIT_EXCEEDS_CONTRACT_AMOUNT`, `DEPOSIT_BELOW_RESERVATION_HOLD`, `BANK_INFO_REQUIRED`, `SETTLEMENT_STATEMENT_READY`, `SETTLEMENT_SNAPSHOT_STALE`, `DEDUCTED_FULL`.

- [ ] **Step 3: Cập nhật `idempotency.js`, `.env.example`, `deposits.js`, `contracts.js`, `resident.js`, `daily.js` và 2 file test hồi quy**

- Trong `api/src/middleware/idempotency.js` và `api/.env.example`: mặc định bắt buộc `Idempotency-Key` khi `NODE_ENV === 'production'` nếu không cấu hình `REQUIRE_IDEMPOTENCY_KEY`; ghi chú rõ quy tắc PRD Mục 14.3 trong `api/.env.example`.
- Trong `api/src/routes/deposits.js`:
  - Dùng `getTodayVnDateStr` trong `checkSettlementPreconditions` thay cho `val.toISOString().slice(0, 10)` để không lệch lùi 1 ngày ở múi giờ `+07:00`; thêm `insertDepositAttachments(client, { ownerEntity, ownerId, evidenceUrls, uploadedBy })`.
  - Gắn `idempotencyGuard()` vào cả 6 route `POST` (`/:id/transactions`, `/:id/settlement`, `/:id/settlement/approve`, `/:id/settlement/reject`, `/:id/dispute`, `/:id/resolve-dispute`).
  - Tại `POST /:id/transactions`: chặn `type === 'transfer'` (`409 TRANSFER_INTERNAL_ONLY`), kiểm tra `isPositiveSafeIntegerVnd(amount)`, chuẩn hóa `txnAmount = BigInt(String(amount).trim())`, validate `method`, khóa `FOR UPDATE OF d`, kiểm tra `d.status === 'HELD'` + HĐ đang mở, kiểm tra `newAmount > BigInt(currentDeposit.contract_deposit_amount ?? 0)` (`422 DEPOSIT_EXCEEDS_CONTRACT_AMOUNT`), và lưu `evidence` qua `insertDepositAttachments`.
  - Tại `POST /:id/settlement`: chuẩn hóa số nguyên `normalizedItems`, gọi `validateRefundBankInfo`, lưu `vBank.normalizedBankInfo` + `open_invoice_snapshot` vào `settlementPayload`, ghi `attachment` cho `normalizedItems`, và gửi thông báo `SETTLEMENT_STATEMENT_READY` tới `primary_tenant` của HĐ.
  - Tại `GET /:id/settlement` và `POST /:id/settlement/approve`: dùng chung `isSettlementSnapshotStale`; ở `approve` khóa `FOR UPDATE` các dòng `invoice` mở của `dep.contract_id`, trả `409 SETTLEMENT_SNAPSHOT_STALE` nếu stale; duy trì `let remainingDepositToDeduct = heldBefore` khi lặp qua `items` để mỗi dòng `deposit_transaction(type='deduct')` chỉ ghi `Math.min(remainingDepositToDeduct, itemAmt)` (bỏ qua dòng `0 ₫`), phần còn lại chuyển cho `coveredServiceDebt`.
  - Bổ sung `'DEDUCTED_FULL'` tại `GET /:id/settlement` (dòng `513`), `GET /:id/settlement/pdf` (dòng `618`) và `POST /:id/dispute` (dòng `1404`).
- Trong `api/src/routes/contracts.js`:
  - Tách helper `findMatchingHeldReservation(dbClient, contract, req)` (dòng `2662-2700`, dùng `(created_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date`); tại `POST /api/v1/contracts` (khi có `reservation_id` hợp lệ) và đầu `completeActivation` (trước bước `PENDING_APPROVAL` và `ACTIVE`), nếu `matchedRsv` có `BigInt(contract.deposit_amount ?? 0) < BigInt(matchedRsv.hold_amount)` trả `{ error: { status: 422, code: 'DEPOSIT_BELOW_RESERVATION_HOLD', message: ... } }` và truyền `matchedRsv` xuống `runActivationSideEffects` để không truy vấn lặp.
  - Tại `POST /api/v1/contracts/:id/transfer-room` (`transfer_deposit === true`, dòng `4696-4745`): tính `transferAmt = min(heldAmt, targetDep)` và `surplusAmt = heldAmt - transferAmt` giống luồng gia hạn HĐ (`dòng 2718-2738`).
- Trong `api/src/routes/resident.js:171` và `api/src/jobs/daily.js:40,85,376`: thêm `'DEDUCTED_FULL'` vào danh sách trạng thái tất toán.
- Cập nhật `api/test/depositCollectAndRefund.test.js:715` (`assert.equal(sfApprove.body.data.status, 'DEDUCTED_FULL')` + assert tổng `deduct` trong `deposit_transaction` bằng `5000000`) và `api/test/remediationR01ToR24.test.js:464,488` (thêm `refund_method: 'CASH'`).

- [ ] **Step 4: Chạy lại bộ test mới và các bộ test hồi quy liên quan để xác nhận PASS**

Run: `cd d:\resihub\api; node --test test/m06Phase1P0Fixes.test.js test/depositCollectAndRefund.test.js test/remediationR01ToR24.test.js`
Expected: Toàn bộ test PASS 100%.

- [ ] **Step 5: Commit Task 2**

```bash
git add api/src/middleware/idempotency.js api/.env.example api/src/routes/deposits.js api/src/routes/contracts.js api/src/routes/resident.js api/src/jobs/daily.js api/test/m06Phase1P0Fixes.test.js api/test/depositCollectAndRefund.test.js api/test/remediationR01ToR24.test.js
git commit -m "fix(deposits): enforce cross-module deposit ceiling, pre-payout notice, snapshot/ledger guards, DEDUCTED_FULL, and idempotency"
```

---

### Task 3: Chuẩn hóa Đặt cọc Giữ chỗ (`HELD` & `EXPIRED`) theo `FR-067` & `NFR-016` + Gắn `idempotencyGuard` (`BUG-06`, `GAP-04`)

**Files:**
- Modify: `api/src/routes/reservations.js`
- Modify: `api/test/depositCollectAndRefund.test.js:218-252`
- Modify: `api/test/fullWebsiteWhiteBlackBox.test.js:850-856`
- Modify: `api/test/m06Phase1P0Fixes.test.js`

**Interfaces:**
- Consumes: `idempotencyGuard` từ `api/src/middleware/idempotency.js`; `checkFourEyesOrWarn` từ `api/src/services/pricing.js`; `isPositiveSafeIntegerVnd`, `getTodayVnDateStr` từ `api/src/services/depositSettlement.js`.
- Produces:
  - Các biểu thức SQL fallback ngày tạo trong `reservations.js` đổi từ `created_at::date` sang `(created_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date`; re-export `getTodayVnDateStr` từ `depositSettlement.js`.
  - `POST /api/v1/reservations` (có `idempotencyGuard()`): từ chối `!isPositiveSafeIntegerVnd(hold_amount)` bằng `400 INVALID_HOLD_AMOUNT`; tính `todayStr = getTodayVnDateStr()`.
  - `PATCH /api/v1/reservations/:id/convert`: trả `409 MUST_CONVERT_VIA_CONTRACT_ACTIVATION`.
  - `PATCH /api/v1/reservations/:id/forfeit` và `PATCH /api/v1/reservations/:id/refund` (đều có `idempotencyGuard()`):
    - Cho phép xử lý phiếu có `status` thuộc `['HELD', 'EXPIRED']` (`FR-067` *"khách hủy hoặc quá hạn"*) và `BigInt(currentRes.hold_amount ?? 0) > 0n` (trả `409 INVALID_HOLD_AMOUNT` nếu chạm dòng lịch sử `0 ₫`).
    - Bắt buộc `req.body?.reason?.trim()` (`400 REASON_REQUIRED`), kiểm tra `checkFourEyesOrWarn` (`403 FOUR_EYES_VIOLATION` nếu người duyệt trùng `created_by` và `!allow_self_approval`), nối thêm lý do hủy vào `reservation.note` (`COALESCE(NULLIF(note, '') || E'\n', '') || $tag`) bảo toàn ghi chú gốc (`NFR-016`), và ghi `audit_log`.

- [ ] **Step 1: Bổ sung subtest cho `reservations.js` vào `api/test/m06Phase1P0Fixes.test.js`**

Kiểm tra:
1. `POST /api/v1/reservations` với `hold_amount: 0`, `hold_amount: -500000`, `hold_amount: 1000.5` hoặc không truyền `hold_amount` → `400 INVALID_HOLD_AMOUNT`.
2. `PATCH /api/v1/reservations/:id/convert` → `409 MUST_CONVERT_VIA_CONTRACT_ACTIVATION` (phiếu giữ nguyên `HELD` để không mất kết chuyển khi kích hoạt HĐ).
3. `PATCH /api/v1/reservations/:id/forfeit` và `PATCH /api/v1/reservations/:id/refund` thiếu `reason` → `400 REASON_REQUIRED`; gọi bởi chính `MANAGER` đã tạo phiếu → `403 FOUR_EYES_VIOLATION`; gọi bởi `SYS_ADMIN` kèm `{ reason: 'Khách báo không thuê nữa' }` → `200`, đồng thời `reservation.note` vẫn giữ nguyên ghi chú ban đầu và nối thêm lý do hủy.
4. Phiếu giữ chỗ có tiền cọc sau khi bị `runDailyJobs()` chuyển sang `status = 'EXPIRED'` vẫn gọi được `PATCH /:id/forfeit` (hoặc `PATCH /:id/refund`) với phê duyệt 4 mắt + `reason` → `200 FORFEITED` / `200 REFUNDED` (`FR-067`, Review Focus #4).
5. Gửi lặp `POST /api/v1/reservations` với cùng `Idempotency-Key` → trả lại đúng bản ghi giữ chỗ đầu tiên kèm `Idempotent-Replayed: true` (Review Focus #5).

- [ ] **Step 2: Chạy test xác nhận FAIL**

Run: `cd d:\resihub\api; node --test test/m06Phase1P0Fixes.test.js`
Expected: FAIL trên các kiểm tra `INVALID_HOLD_AMOUNT`, `MUST_CONVERT_VIA_CONTRACT_ACTIVATION`, `REASON_REQUIRED`, `FOUR_EYES_VIOLATION` ở `forfeit`, và xử lý phiếu `'EXPIRED'`.

- [ ] **Step 3: Cập nhật `reservations.js` và cập nhật các lệnh test `refund`/`forfeit` cũ**

- Trong `api/src/routes/reservations.js`:
  - Import & re-export `getTodayVnDateStr` từ `../services/depositSettlement.js`; đổi `created_at::date` ở dòng `90, 215, 219` sang `(r.created_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date` / `(created_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date`.
  - Gắn `idempotencyGuard()` vào `POST /`, `PATCH /:id/forfeit`, `PATCH /:id/refund`.
  - Validate `!isPositiveSafeIntegerVnd(hold_amount)` → `400 INVALID_HOLD_AMOUNT`, truyền `Number(String(hold_amount).trim())` vào `INSERT`.
  - Khóa `PATCH /:id/convert` trả `409 MUST_CONVERT_VIA_CONTRACT_ACTIVATION`.
  - Tại cả `PATCH /:id/forfeit` và `PATCH /:id/refund`: cho phép `['HELD', 'EXPIRED'].includes(currentRes.status)` (kèm guard `BigInt(currentRes.hold_amount ?? 0) > 0n`); kiểm tra `const trimmedReason = String(req.body?.reason || '').trim(); if (!trimmedReason)` → `400 REASON_REQUIRED`; gọi `checkFourEyesOrWarn` (`403 FOUR_EYES_VIOLATION`); cập nhật `note = COALESCE(NULLIF(note, '') || E'\n', '') || $2` (với tiền tố `[Tịch thu cọc]: ` hoặc `[Hoàn cọc giữ chỗ]: `) và lưu `reason: trimmedReason` vào `audit_log`.
- Trong `api/test/depositCollectAndRefund.test.js:219-252`: truyền `{ reason: '...' }` vào `selfRefundRsv` & `okRefundRsv`; kiểm tra `manager.token` tự gọi `forfeit` bị `403 FOUR_EYES_VIOLATION` rồi dùng `sysAdmin.token` kèm `{ reason: 'Khách hủy giữ chỗ quá hạn ký HĐ' }` → `200 FORFEITED`.
- Trong `api/test/fullWebsiteWhiteBlackBox.test.js:851-854`: đổi lời gọi `forfeit` sang dùng `mgr2VopA.token` kèm `body: JSON.stringify({ reason: 'Khách báo hủy giữ chỗ trước khi ký HĐ' })`.

- [ ] **Step 4: Chạy lại toàn bộ các file test liên quan xác nhận PASS**

Run: `cd d:\resihub\api; node --test test/m06Phase1P0Fixes.test.js test/depositCollectAndRefund.test.js test/fullWebsiteWhiteBlackBox.test.js`
Expected: PASS 100%.

- [ ] **Step 5: Commit Task 3**

```bash
git add api/src/routes/reservations.js api/test/m06Phase1P0Fixes.test.js api/test/depositCollectAndRefund.test.js api/test/fullWebsiteWhiteBlackBox.test.js
git commit -m "fix(reservations): enforce positive hold_amount, EXPIRED cancel support, four-eyes & reason, VN timezone, and idempotency"
```

---

### Task 4: Đồng bộ Giao diện Admin & Cổng Cư dân với Quy tắc P0 và Xoay vòng `Idempotency-Key` (`BUG-01..04`, `BUG-06`, `GAP-04`)

**Files:**
- Create: `frontend/src/utils/idempotency.js`
- Modify: `frontend/src/services/contracts.service.js:1-17`
- Modify: `frontend/src/services/deposits.service.js`
- Modify: `frontend/src/services/resident.service.js:33-35`
- Modify: `frontend/src/services/buildings.service.js:33-38`
- Modify: `frontend/src/constants/statuses.js:52-60`
- Modify: `frontend/src/pages/admin/deposits/DepositsPage.jsx`
- Modify: `frontend/src/pages/resident/tabs/ContractTab.jsx:313-340,378-385,784-789,884-886`
- Modify: `frontend/src/pages/admin/buildings/FloorPlanPage.jsx:260-305,850-857`
- Modify: `frontend/src/pages/admin/apartments/ApartmentDetailPage.jsx:172-186,450-465`
- Create: `frontend/src/utils/__tests__/m06Phase1Ui.test.js`

**Interfaces:**
- Produces:
  - `createIdempotencyKey() -> string`, `withIdempotency(options) -> { headers: { 'Idempotency-Key': string } }` và `canCollectAdditionalDeposit(row) -> boolean` trong `frontend/src/utils/idempotency.js`.
  - `canCollectAdditionalDeposit(row)` chỉ trả `true` khi `row.status === 'HELD'`, `['ACTIVE', 'RENEWAL_PENDING', 'TERMINATION_PENDING'].includes(row.contract_status)`, và `Number(row.deposit_amount || 0) > Number(row.amount_held || 0)`.
  - `DEPOSIT_STATUS.DEDUCTED_FULL = { label: 'Đã khấu trừ hết cọc', variant: 'amber' }`, `DEPOSIT_STATUS.REFUNDED = { label: 'Đã hoàn đủ 100%', variant: 'emerald' }`.

- [ ] **Step 1: Viết kiểm thử đơn vị Frontend `frontend/src/utils/__tests__/m06Phase1Ui.test.js`**

Kiểm tra:
1. `createIdempotencyKey()` sinh chuỗi khác rỗng (2 lần gọi liên tiếp sinh 2 khóa khác nhau phục vụ xoay vòng khóa khi thu nhiều đợt — Review Focus #5) và `withIdempotency({ idempotencyKey: 'fixed-key' })` giữ nguyên `'fixed-key'`.
2. `DEPOSIT_STATUS.DEDUCTED_FULL` tồn tại với nhãn `'Đã khấu trừ hết cọc'` và `DEPOSIT_STATUS.REFUNDED.label === 'Đã hoàn đủ 100%'`.
3. `canCollectAdditionalDeposit` trả `false` khi `status === 'SETTLEMENT_DRAFT'`, khi `contract_status === 'TERMINATED'` / `'EXPIRED'`, khi `deposit_amount === 0`, hoặc khi `amount_held >= deposit_amount`; chỉ trả `true` khi `status === 'HELD'` + HĐ đang mở + `amount_held < deposit_amount`.
4. `buildings.service.js` không còn export `convertReservation`; `resident.service.js` nhận tham số `options` trên `disputeDeposit` (`residentService.disputeDeposit.length >= 2`).

- [ ] **Step 2: Chạy test Frontend xác nhận FAIL**

Run: `cd d:\resihub\frontend; node --test src/utils/__tests__/m06Phase1Ui.test.js`
Expected: FAIL (`idempotency.js` và `DEDUCTED_FULL` chưa tồn tại).

- [ ] **Step 3: Cập nhật các file Frontend và kiểm tra build Vite**

- Tạo `frontend/src/utils/idempotency.js`, cập nhật `contracts.service.js`, `deposits.service.js`, `resident.service.js` (`disputeDeposit: (depositId, payload, options = {}) => api.post(..., payload, withIdempotency(options))`), và `buildings.service.js` (xóa `convertReservation`, gắn `withIdempotency(options)`).
- Cập nhật `DEPOSIT_STATUS` trong `frontend/src/constants/statuses.js`.
- Trong `DepositsPage.jsx`:
  - Lưu `idemKeyRef` sinh mới mỗi khi mở modal Tất toán / Từ chối / Khiếu nại / Giải quyết khiếu nại / Duyệt hoàn cọc; riêng form `Thu bổ sung` bên trong modal `Sổ giao dịch` (`txnModalOpen` giữ mở sau khi thu), sinh mới `collectIdemKeyRef.current = createIdempotencyKey()` **cả khi bấm mở `showCollectForm` lẫn ngay sau khi `createTransaction` thành công** để thu cọc đợt 2 trong cùng phiên mở modal không bị đụng khóa cũ.
  - Dùng `canCollectAdditionalDeposit(row)` cho cả việc hiển thị nút `Thu bổ sung` (trên bảng và trong modal `Sổ giao dịch`) **lẫn** nhãn phụ `Còn phải thu` (dòng `724`); chặn submit nếu `!Number.isInteger(amt) || amt <= 0 || amt > shortage`.
  - Khi `liveCalc.refundAmount > 0 && refundMethod === 'BANK_TRANSFER'`, đánh dấu `required` cho Ngân hàng / Số tài khoản / Chủ tài khoản và chặn submit ở `handleSubmitSettlement` nếu trống hoặc STK không khớp `/^[A-Za-z0-9]{4,25}$/`.
  - Ở chế độ xem biên bản chờ duyệt (`PENDING_APPROVAL`), nếu `Boolean(settlementDetail?.snapshot_stale)` (hoặc lệch `calculated_service_debt`, `calculated_rent_debt`, `amount_held`), hiển thị cảnh báo biến động dữ liệu và disable nút `Phê duyệt hoàn cọc` (yêu cầu bấm `Từ chối biên bản` để lập lại số mới).
  - Bổ sung `'DEDUCTED_FULL'` tại tất cả vị trí: `tabCounts.refunded` (dòng `208`), `filteredDeposits` (dòng `225`), `isSettledRow` (dòng `715`), điều kiện hiện nút `Biên bản tất toán` (dòng `834`), điều kiện hiện nút `In bảng kê A4` (dòng `856` & `1199`), và `isFinalized` (dòng `1776`); tại `handleSubmitResolveDispute` (dòng `625`), điều hướng `setActiveTab` theo trạng thái thực trả về (`nextStatus === 'PENDING_APPROVAL' ? 'pending' : nextStatus === 'SETTLEMENT_DRAFT' ? 'held' : 'refunded'`).
- Trong `ContractTab.jsx`:
  - Bổ sung `'DEDUCTED_FULL'` vào `inSettlementStatus` (dòng `378`), `canDispute` (dòng `784`) và `isFinalized` (dòng `884`).
  - Sinh mới `disputeIdemKeyRef.current = createIdempotencyKey()` trong `handleOpenDisputeModal` và truyền `{ idempotencyKey: disputeIdemKeyRef.current }` vào `residentService.disputeDeposit(...)`.
- Trong `FloorPlanPage.jsx` và `ApartmentDetailPage.jsx`:
  - Chặn submit tạo giữ chỗ nếu `!Number.isInteger(Number(resForm.hold_amount)) || Number(resForm.hold_amount) <= 0` và gắn `Idempotency-Key` theo phiên mở drawer/modal.
  - Trên `ApartmentDetailPage.jsx` (dòng `453`), hiển thị nút `Hoàn cọc` & `Tịch thu` cho các phiếu `['HELD', 'EXPIRED'].includes(r.status) && Number(r.hold_amount || 0) > 0`, mở Modal xác nhận có ô nhập lý do bắt buộc (`reason`) và truyền `Idempotency-Key` theo phiên mở modal.

- [ ] **Step 4: Chạy test Frontend và chạy `npm run build` để xác nhận không lỗi biên dịch**

Run: `cd d:\resihub\frontend; node --test src/utils/__tests__/m06Phase1Ui.test.js; npm run build`
Expected: Test PASS và Vite build thành công `0 errors`.

- [ ] **Step 5: Commit Task 4**

```bash
git add frontend/src/utils/ frontend/src/services/contracts.service.js frontend/src/services/deposits.service.js frontend/src/services/resident.service.js frontend/src/services/buildings.service.js frontend/src/constants/statuses.js frontend/src/pages/admin/deposits/DepositsPage.jsx frontend/src/pages/resident/tabs/ContractTab.jsx frontend/src/pages/admin/buildings/FloorPlanPage.jsx frontend/src/pages/admin/apartments/ApartmentDetailPage.jsx
git commit -m "feat(frontend): enforce P0 deposit/reservation guards, EXPIRED actions, DEDUCTED_FULL sync, and rotating idempotency keys"
```
