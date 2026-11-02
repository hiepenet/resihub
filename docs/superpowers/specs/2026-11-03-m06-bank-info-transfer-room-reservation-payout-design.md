# Thiết kế Chuẩn hóa M05/M06: Sửa lỗi Cập nhật STK Hoàn cọc, Quy trình Phê duyệt Đổi phòng Kết chuyển Cọc (`FR-013`/`FR-025`/`AC-009.2`) & Tách Phê duyệt – Thực chi UNC khi Hủy Giữ chỗ (`FR-067`)

**Ngày lập:** `2026-11-03`  
**Tài liệu gốc đối chiếu:** `PRD - Quan ly Can ho va Nha cho thue v2.0.md` (`Mục 5.3`, `Mục 6.1–6.2`, `Mục 7.5`, `FR-013`–`FR-025`, `FR-067`, `AC-009.2`, `AC-017.1`–`AC-017.3`, `NFR-008`, `NFR-016`, `R-12`, `R-23`)

---

## 1. Mục tiêu & Lý do (Intent & Why)

Đợt chuẩn hóa này giải quyết triệt để **01 lỗi chặn luồng P0 trên giao diện** và **02 độ lệch quy trình nghiệp vụ – kiểm soát nội bộ** so với đặc tả `PRD v2.0`:

1. **Khôi phục luồng cập nhật STK nhận hoàn cọc trên trình duyệt (`FR-024`, `P0`):** Hai cổng Admin (`DepositsPage.jsx`) và Cư dân (`ContractTab.jsx`) đều gửi JSON lồng `{ bank_info: { ... } }` kèm `bank_logo`, trong khi `PATCH /api/v1/deposits/:id/bank-info` đang đọc phẳng từ `req.body`, gây lỗi `422 BANK_INFO_REQUIRED` 100% trên UI khi xử lý lệnh hoàn tiền bị trả lại (`RETURNED`) hoặc chờ chi (`APPROVED_PENDING_PAYOUT`).
2. **Đưa quy trình Đổi phòng & Kết chuyển cọc (`POST /api/v1/contracts/:id/transfer-room`) về đúng 100% chuẩn PRD (`Mục 5.3`, `Mục 6.2`, `FR-013`, `FR-014`, `FR-017`, `FR-020`, `FR-025`, `AC-009.2`):** Chấm dứt việc 1 `MANAGER` đơn lẻ tự đóng hợp đồng cũ, mở thẳng hợp đồng mới sang `ACTIVE` mà không có bản scan hợp đồng ký giấy và tự duyệt bút toán chuyển cọc `TRANSFER_OUT`/`TRANSFER_IN`.
3. **Tách bạch vai trò Phê duyệt (`A`) và Vận hành thực chi đính kèm UNC (`CRU`) khi Thanh lý hủy giữ chỗ (`FR-067`, `Mục 6.1–6.2`, `Mục 7.5`):** Chấm dứt tình trạng ở tòa nhà chỉ có `1 MANAGER + 1 OWNER`, `OWNER` (vai trò `R + A`, không làm thu ngân hằng ngày) bị ép phải trực tiếp chuyển khoản ngân hàng và tải ảnh UNC mới bấm duyệt hủy giữ chỗ được.

---

## 2. Goals, Non-Goals & Anti-Goals

### Goals
- Sửa `PATCH /api/v1/deposits/:id/bank-info` chấp nhận cả `{ bank_info: { ... } }` lẫn payload phẳng (tương thích ngược cho API client/test hiện hữu) và bảo toàn trường `bank_logo`.
- Chuẩn hóa đổi phòng (`FR-013` + `FR-017` + `FR-020` + `FR-025` + `AC-009.2`) theo chu trình 4 bước an toàn: `Tạo HĐ nháp chuyển phòng (DRAFT, giữ nguyên HĐ cũ ACTIVE) → Đính kèm bản scan HĐ ký mới → Trình kích hoạt (PENDING_APPROVAL) → OWNER / người duyệt dự phòng phê duyệt thực thi nguyên tử (TERMINATED HĐ cũ + ACTIVE HĐ mới + Kết chuyển cọc có approved_by = người duyệt)`.
- Cho phép tạo hợp đồng nháp chuyển phòng kể cả khi giá thuê phòng mới giảm `> 10%` so với `base_rent`, gom chung vào bước `OWNER` phê duyệt `PENDING_APPROVAL` (`FR-014`) thay vì chặn cứng `422` bắt tạo hợp đồng rời.
- Tách thanh lý hủy giữ chỗ (`FR-067`) thành chu trình chuẩn phân quyền: `MANAGER lập đề xuất (CANCEL_PENDING_APPROVAL) → OWNER / Four-Eyes phê duyệt (FORFEITED ngay nếu hoàn 0 ₫; hoặc APPROVED_PENDING_PAYOUT + giải phóng ngay căn hộ về AVAILABLE nếu hoàn > 0 ₫) → MANAGER thực chi & đính kèm UNC bắt buộc (REFUNDED / PARTIALLY_REFUNDED)`.
- Giữ vững ràng buộc PostgreSQL `FORCE ROW LEVEL SECURITY` hai lớp (UI + DB RLS) và `0` lần gọi `adminPool` trong `api/src/routes/deposits.js`.

### Non-Goals
- **Không thay đổi luồng Gia hạn hợp đồng nối tiếp (`POST /api/v1/contracts/:id/renew`):** Theo bảng phân quyền `PRD Mục 6.2` (dòng 188: `Hợp đồng | MANAGER: CRU + A(gia hạn)`), `MANAGER` đã được cấp quyền `A(gia hạn)` đối với hợp đồng gia hạn đúng khung giá (`>= 90% base_rent`), và luồng `renew` hiện tại đã bắt buộc tạo `DRAFT` + tải bản scan (`AC-009.2`) + trình `OWNER` khi giảm giá `> 10%`.
- Không tích hợp cổng chi hộ ngân hàng tự động (ERP/Open Banking) — giữ đúng cơ chế kế toán/vận hành chuyển khoản và tải chứng từ UNC ở MVP (`PRD Mục 5.3`).

### Anti-Goals (Những điều tuyệt đối tránh dù code chạy được)
- **Không đóng sớm hợp đồng cũ (`TERMINATED`) khi mới tạo nháp đổi phòng:** Nếu `OWNER` từ chối phê duyệt hoặc khách đổi ý trước khi ký, hợp đồng cũ đang ở của cư dân không được phép bị hỏng trạng thái hay mất lịch sinh hóa đơn.
- **Không cho phép `OWNER` hoặc `SYS_ADMIN` trực tiếp chuyển `reservation.status` sang `REFUNDED` / `PARTIALLY_REFUNDED` khi chưa qua bước `MANAGER` thực chi kèm UNC:** Phải chặn ở cả tầng API và tầng PostgreSQL `rls_reservation_update` `WITH CHECK`.
- **Không giữ khóa căn hộ `RESERVED` trong lúc chờ kế toán chuyển khoản hoàn tiền giữ chỗ:** Ngay khi `OWNER` đã duyệt hủy (`APPROVED_PENDING_PAYOUT`), căn hộ phải được đồng bộ về `AVAILABLE` để BQL mở bán/cho thuê lại ngay.

---

## 3. Ràng buộc Hệ thống & Bảo mật (Constraints)

1. **`api/src/routes/deposits.js` tuyệt đối không dùng `adminPool` (`NFR-008`):** Mọi truy vấn chạy qua `pool` / `getUserClient(req)` dưới `FORCE ROW LEVEL SECURITY`.
2. **Ma trận RBAC `PRD Mục 6.2`:**
   - **Hợp đồng (`contract`) & Cọc (`deposit` / `reservation`):**
     - `MANAGER`: `CRU` trên tòa được phân công (`getManagerBuildingIds`).
     - `OWNER`: `R + A` trên tòa sở hữu (`getOwnerBuildingIds`).
     - `SYS_ADMIN`: Chỉ `R` trên tòa đã có `OWNER` hoạt động (`building_has_active_owner(building_id) = true`); chỉ được thực hiện `A` dự phòng khi tòa **chưa có** `OWNER` hoạt động (`NOT building_has_active_owner(building_id)`).
3. **Nguyên tắc Four-Eyes (`PRD Mục 6.1`, `6.2`, `AC-017.3`, `R-23`):** `actor_id` phê duyệt phải khác người lập/trình (`created_by` / `proposed_by`), trừ khi `system_setting('approval_config').allow_self_approval === true` (khi đó bắt buộc ghi `SELF_APPROVAL_WARNING` vào `audit_log`).
4. **Bất biến giao dịch tài chính (`037_deposit_txn_immutable.sql`) & Đối soát `RP-07`:** Bút toán `deposit_transaction` ở trạng thái `APPROVED` không bao giờ bị sửa/xóa; phương trình đối soát sổ cọc và báo cáo giữ chỗ `RP-07` phải cân khớp tại mọi trạng thái trung gian.
5. **Múi giờ & Tiền tệ:** Mọi mốc ngày nghiệp vụ tính theo `Asia/Ho_Chi_Minh`; số tiền VND là số nguyên không âm `BIGINT` (`ROUND(x, -3)` cho gợi ý chia cọc giữ chỗ theo chính sách).

---

## 4. Các Phương án Đã Cân nhắc & Lý do Chọn (Approaches)

### 4.1. Mục 1 — `PATCH /api/v1/deposits/:id/bank-info`
- **Phương án chọn (Duy nhất hợp lý):** Unwrap `req.body?.bank_info` nếu là object, ngược lại fallback về `req.body || {}`, rồi đưa thẳng vào `validateRefundBankInfo`. Vừa sửa dứt điểm lỗi `422` trên cả 2 giao diện Admin & Cư dân (bảo toàn `bank_logo`), vừa giữ tương thích ngược 100% cho các bài test/API client gửi phẳng.

### 4.2. Mục 2 — Quy trình Đổi phòng Kết chuyển Cọc (`FR-013` / `FR-025` / `AC-009.2`)
- **Phương án 2A (ĐƯỢC CHỌN — Bám sát 100% PRD):** `POST /:id/transfer-room` tạo hợp đồng mới ở `DRAFT` (`is_room_transfer = true`, `transfer_deposit = boolean`, `parent_contract_id = oldContract.id`) mà **chưa đóng HĐ cũ** → `MANAGER` in & tải bản scan ký giấy (`POST /:newId/scan`, chặn `409 MISSING_SIGNED_SCAN` nếu thiếu) → `MANAGER` bấm kích hoạt (`POST /:newId/activate`) chuyển HĐ mới sang `PENDING_APPROVAL` → `OWNER` (hoặc dự phòng khi tòa khuyết chủ) bấm `POST /:newId/approve` để thực thi **nguyên tử** đóng HĐ cũ (`TERMINATED` + căn cũ `MAINTENANCE`), mở HĐ mới (`ACTIVE` + căn mới `OCCUPIED`/`RESERVED`), và kết chuyển sổ cọc với `approved_by = người duyệt`.
- **Phương án 2B (Loại bỏ):** Bắt tải bản scan ngay trong Modal Đổi phòng và tạo thẳng `PENDING_APPROVAL`. Bị loại vì trái quy trình vận hành thực tế tại `FR-014` (BQL cần lưu `DRAFT` để kết xuất/in hợp đồng giấy cho khách ký trước rồi mới có bản chụp tải lên).

### 4.3. Mục 3 — Tách Phê duyệt & Thực chi UNC khi Hủy Giữ chỗ (`FR-067`)
- **Phương án 3A (ĐƯỢC CHỌN — Trạng thái tường minh + JSONB `cancel_settlement`, đồng bộ kiến trúc Sổ cọc Phase 2):** Mở rộng `reservation.status` thêm `'CANCEL_PENDING_APPROVAL'` và `'APPROVED_PENDING_PAYOUT'` kết hợp cột `cancel_settlement JSONB`.
  - *Lý do vượt trội so với giữ ngầm trong `HELD`:* Nếu giữ `reservation.status = 'HELD'` sau khi `OWNER` đã duyệt hủy chờ chi, `fn_sync_apartment_status_after_reservation` sẽ tiếp tục khóa cứng căn hộ ở `RESERVED`, `findMatchingHeldReservation` có nguy cơ tự động gộp nhầm phiếu đã hủy vào hợp đồng mới, hoặc cron `daily.js` quét đè thành `EXPIRED` lúc nửa đêm. Dùng trạng thái tường minh giúp:
    1. Khi `CANCEL_PENDING_APPROVAL`: giữ khóa căn hộ (`RESERVED` nếu còn hạn), chặn cron nửa đêm ghi đè `EXPIRED`, chặn gộp nhầm vào hợp đồng.
    2. Khi `OWNER` duyệt (`cancel-approve`): nếu `refunded_amount === 0` → chốt ngay `FORFEITED` + mở căn `AVAILABLE`; nếu `refunded_amount > 0` → sang `APPROVED_PENDING_PAYOUT` + **mở ngay căn `AVAILABLE`**, đồng thời chưa cộng vào `refunded_in_period` của `RP-07` cho tới khi thực chi.
    3. Khi `MANAGER` thực chi (`cancel-payout` kèm UNC bắt buộc cho `BANK_TRANSFER`): chốt `REFUNDED` / `PARTIALLY_REFUNDED` và ghi nhận dòng tiền thực chi trên `RP-07`.

---

## 5. Thiết kế Chi tiết (Detailed Specification)

### 5.1. Sửa lỗi P0 tại `PATCH /api/v1/deposits/:id/bank-info`
- **File:** `api/src/routes/deposits.js`
- **Xử lý đầu vào:**
  ```js
  const rawBank =
    req.body?.bank_info && typeof req.body.bank_info === 'object' && !Array.isArray(req.body.bank_info)
      ? req.body.bank_info
      : req.body || {};
  const vBank = validateRefundBankInfo({
    refundAmount: 1,
    refundMethod: 'BANK_TRANSFER',
    bankInfo: rawBank,
  });
  ```
- **Kết quả:** `vBank.normalizedBankInfo` giữ đầy đủ `{ bank_name, bank_code, bank_bin, bank_logo, account_number, account_holder }`, lưu qua `fn_update_deposit_refund_bank_info($1, $2::jsonb)` dưới RLS của `MANAGER` hoặc `RESIDENT` chính.

---

### 5.2. Chuẩn hóa Đổi phòng & Kết chuyển Cọc (`FR-013`, `FR-014`, `FR-017`, `FR-020`, `FR-025`, `AC-009.2`)

#### A. Schema & Migration (`047_m06_transfer_room_and_reservation_payout.sql`)
- Mở rộng bảng `contract`:
  - `is_room_transfer BOOLEAN NOT NULL DEFAULT FALSE`
  - `transfer_deposit BOOLEAN NOT NULL DEFAULT TRUE`
- Index bảo vệ chống tạo trùng hồ sơ nháp đổi phòng đang mở trên cùng 1 hợp đồng gốc:
  - `CREATE UNIQUE INDEX IF NOT EXISTS uq_contract_open_room_transfer ON contract (parent_contract_id) WHERE is_room_transfer = TRUE AND status IN ('DRAFT', 'PENDING_APPROVAL');`

#### B. Luồng API tại `api/src/routes/contracts.js`
1. **`POST /api/v1/contracts/:id/transfer-room` (`requireRole(['MANAGER'])`):**
   - Kiểm tra `oldContract.status === 'ACTIVE'` (`409 CONTRACT_NOT_ACTIVE`), chưa có hồ sơ đổi phòng đang mở `DRAFT`/`PENDING_APPROVAL` từ `oldContract.id` (`409 PENDING_TRANSFER_EXISTS`), `new_apartment_id !== oldContract.apartment_id` (`400 SAME_APARTMENT`), `targetApt` thuộc `getManagerBuildingIds` (`403 ACCESS_DENIED`), **`targetApt.building_id === oldContract.building_id`** (`422 CROSS_BUILDING_TRANSFER_NOT_ALLOWED` — *Quyết định thiết kế theo `FR-013` & `FR-070`: cô lập sổ cái cọc theo từng tòa nhà / từng chủ sở hữu, khớp với UI `ContractDetailPage.jsx` chỉ chọn căn trống cùng tòa; tương tự chặn đổi sang căn khác tòa khi sửa nháp `PATCH /api/v1/contracts/:id` có `is_room_transfer = true`*), và `targetApt.status === 'AVAILABLE'` (`409 APARTMENT_NOT_AVAILABLE`).
   - Kiểm tra ngày: `transferDate >= toVnDateOnlyStr(oldContract.start_date)` (`422 INVALID_TRANSFER_DATE`), `finalEndDate > transferDate` (`422 INVALID_DATE_RANGE`), không chồng lấn kỳ hạn trên `new_apartment_id` (`409 OVERLAP_CONTRACT`), `finalRent > 0` (`422 INVALID_RENT_AMOUNT`).
   - **Cho phép giảm giá `> 10%`** so với `targetApt.base_rent` (không trả `422 DISCOUNTED_PRICE_REQUIRES_APPROVAL`, vì bước kích hoạt sẽ tự chuyển `PENDING_APPROVAL`).
   - Tạo `newContract` ở trạng thái **`DRAFT`** (`parent_contract_id = oldContract.id`, `is_room_transfer = true`, `transfer_deposit = Boolean(transfer_deposit)`), sao chép `contract_occupant` từ `oldContract`, ghi `audit_log(action = 'TRANSFER_ROOM_DRAFT')`. **Giữ nguyên `oldContract.status = 'ACTIVE'`**.
   - Trả `201`: `{ message, data: { new_contract, old_contract_id: oldContract.id, requires_scan: true, requires_approval: true } }`.

2. **`POST /api/v1/contracts/:id/scan` (`MANAGER`):**
   - Dùng nguyên cơ chế tải bản scan hợp đồng ký giấy hiện có (`AC-009.2`).

3. **`POST /api/v1/contracts/:id/activate` (`MANAGER`):**
   - Giữ nguyên toàn bộ chốt chặn `MISSING_SIGNED_SCAN` (`409`), `MISSING_IDENTITY_PAPER` (`409`), `TENANT_NOT_APPROVED` (`409`), trạng thái & chồng lấn căn đích.
   - Nếu `contract.is_room_transfer === true`:
     - Kiểm tra hợp đồng gốc `parent_contract_id` vẫn đang `ACTIVE` (`409 PARENT_CONTRACT_NOT_ACTIVE` nếu đã chấm dứt/hết hạn).
     - Chuyển `contract.status` từ `DRAFT` sang **`PENDING_APPROVAL`**, ghi `audit_log(action = 'SUBMIT_APPROVAL')` kèm lý do (`ROOM_TRANSFER` + `DEPOSIT_TRANSFER` / `DISCOUNTED_PRICE`), gửi thông báo cho `OWNER` của tòa nhà (hoặc người duyệt dự phòng khi tòa chưa có `OWNER` hoạt động).
     - Trả `409` với `code: isDiscounted ? 'PRICE_NEEDS_APPROVAL' : 'TRANSFER_NEEDS_APPROVAL'` và `data: pendingContract` (đồng nhất giao thức với `PRICE_NEEDS_APPROVAL` hiện có).

4. **`POST /api/v1/contracts/:id/approve` & `POST /api/v1/contracts/:id/reject`:**
   - **Phân quyền người duyệt (`PRD Mục 6.2`):**
     - Tòa có `OWNER` hoạt động (`building_has_active_owner = true`): Chỉ `OWNER` của tòa nhà được duyệt/từ chối (`403 FORBIDDEN_NOT_BUILDING_OWNER` với các vai trò khác), kèm kiểm tra Four-Eyes (`checkFourEyesOrWarn`).
     - Tòa **chưa có** `OWNER` hoạt động (`building_has_active_owner = false`): Cho phép `SYS_ADMIN` dự phòng **hoặc** một `MANAGER` thứ hai được gán cùng tòa nhà (nếu không giảm giá `> 10%`) thực hiện duyệt/từ chối theo nguyên tắc Four-Eyes (`actor_id !== created_by && actor_id !== submitter_id`, trừ khi `allow_self_approval = true`). (Cập nhật `requireRole(['OWNER', 'MANAGER', 'SYS_ADMIN'])` và giữ chặt điều kiện `building_has_active_owner` + `isDiscountedPrice`).
   - **Thực thi nguyên tử khi `approve` hợp đồng có `is_room_transfer === true`:**
     - Khóa `oldContract` (`FOR UPDATE`), xác nhận `oldContract.status === 'ACTIVE'` (`409 PARENT_CONTRACT_NOT_ACTIVE`).
     - Đóng `oldContract`: `status = 'TERMINATED'`, `terminated_at = sDateStr`, nối ghi chú `[Chuyển sang căn <mã căn mới>]`; đặt căn cũ `status = 'MAINTENANCE'`.
     - Cập nhật `newContract`: `status = 'ACTIVE'`, `approved_by = req.user.sub`; đồng bộ căn mới (`OCCUPIED` nếu `sDateStr <= today`, `RESERVED` nếu tương lai).
     - Xử lý cọc theo `contract.transfer_deposit`:
       - Nếu `transfer_deposit === true`: khóa `oldDep` (`status = 'HELD'`), tính `transferAmt = min(heldAmt, targetDep)`, `surplusAmt = heldAmt - transferAmt`, `remainingCollect = max(0, targetDep - transferAmt)`.
         - Nếu `surplusAmt > 0`: giữ `oldDep.status = 'HELD'`, cập nhật `amount_held = surplusAmt` và `refund_due_date` theo `sla_config.deposit_refund_days`.
         - Nếu `surplusAmt === 0`: cập nhật `oldDep.amount_held = 0, status = 'TRANSFERRED'`.
         - Nếu `transferAmt > 0`: ghi `TRANSFER_OUT` trên `oldDep` và mở `newDep` (`amount_held = transferAmt`) kèm `TRANSFER_IN` với **`approved_by = req.user.sub`** (người duyệt `A`) và `created_by = contract.created_by || req.user.sub`.
         - Nếu `transferAmt === 0` và `targetDep > 0`: mở `newDep` (`amount_held = 0, status = 'HELD'`).
       - Nếu `transfer_deposit === false`: gán `refund_due_date` cho `oldDep` (`status = 'HELD'`) để tất toán riêng sau nghiệm thu căn cũ; mở `newDep` (`amount_held = 0, status = 'HELD'`) nếu `targetDep > 0`.
     - Ghi `audit_log(action = 'TRANSFER_ROOM')` trên hợp đồng gốc, trả thêm `surplus_deposit_amount` và `remaining_collect` trong JSON phản hồi.
   - **Khi `reject`:** Trả `newContract` về `DRAFT` kèm lý do; `oldContract` vẫn nguyên vẹn ở `ACTIVE`.

#### C. Giao diện `ContractDetailPage.jsx`
- Gỡ bỏ cảnh báo chặn cứng giảm giá `> 10%` trong `handleTransferSubmit` (đổi thành gợi ý thông tin rằng giá giảm `> 10%` sẽ trình Chủ nhà phê duyệt cùng hồ sơ đổi phòng).
- Sau khi tạo nháp đổi phòng thành công, điều hướng sang trang chi tiết hợp đồng mới (`/admin/contracts/:newId`), hiển thị rõ banner hướng dẫn 3 bước cho hợp đồng đổi phòng (`1. Đính kèm bản scan đã ký → 2. Bấm Trình kích hoạt đổi phòng → 3. Chờ Chủ sở hữu phê duyệt`).
- Xử lý mã phản hồi `TRANSFER_NEEDS_APPROVAL` tương tự `PRICE_NEEDS_APPROVAL` (hiển thị thông báo đã chuyển sang `PENDING_APPROVAL` chờ người có thẩm quyền phê duyệt), cập nhật nhãn nút duyệt thành ngữ cảnh phù hợp (`"Phê duyệt đổi phòng & kết chuyển cọc"` hoặc `"Phê duyệt HĐ giá ưu đãi"`), và hiển thị cảnh báo `surplus_deposit_amount` khi duyệt hoàn tất.

---

### 5.3. Tách Phê duyệt (`A`) & Thực chi UNC (`CRU`) khi Thanh lý Hủy Giữ chỗ (`FR-067`, `Mục 6.1–6.2`, `Mục 7.5`)

#### A. Schema, RLS & Hàm DB (`047_m06_transfer_room_and_reservation_payout.sql`)
1. **Mở rộng bảng `reservation`:**
   - Thêm cột `cancel_settlement JSONB`.
   - Mở rộng `reservation_status_check`:
     `('PENDING_CONFIRM', 'HELD', 'CANCEL_PENDING_APPROVAL', 'APPROVED_PENDING_PAYOUT', 'CONVERTED', 'FORFEITED', 'REFUNDED', 'PARTIALLY_REFUNDED', 'EXPIRED', 'REJECTED')`.
2. **Siết chặt `rls_reservation_update` đúng vai trò `PRD Mục 6.2`:**
   - `MANAGER` trên tòa được gán (`get_manager_building_ids()`): được cập nhật phục vụ vận hành (`PENDING_CONFIRM → HELD/REJECTED`, `HELD/EXPIRED → CANCEL_PENDING_APPROVAL/CONVERTED`, `APPROVED_PENDING_PAYOUT → REFUNDED/PARTIALLY_REFUNDED` hoặc cập nhật `refund_bank_info`, cũng như nhánh Four-Eyes `MANAGER` thứ 2 duyệt sang `APPROVED_PENDING_PAYOUT`/`FORFEITED` hoặc từ chối về `HELD`/`EXPIRED`).
   - `OWNER` trên tòa sở hữu (`get_owner_building_ids()`) hoặc `SYS_ADMIN` dự phòng khi `NOT building_has_active_owner(building_id)`:
     - `USING`: `status IN ('HELD', 'EXPIRED', 'CANCEL_PENDING_APPROVAL')`
     - `WITH CHECK`: **`status IN ('HELD', 'EXPIRED', 'APPROVED_PENDING_PAYOUT', 'FORFEITED')`** — khóa cứng ở tầng DB không cho `OWNER` / `SYS_ADMIN` nhảy tắt sang `REFUNDED` hay `PARTIALLY_REFUNDED`!
3. **Cập nhật `fn_sync_apartment_status_after_reservation(p_apartment_id UUID)`:**
   - Giữ căn hộ ở `'RESERVED'` khi tồn tại phiếu `r.status IN ('HELD', 'CANCEL_PENDING_APPROVAL') AND (r.hold_until IS NULL OR r.hold_until >= v_today_vn)`.
   - Ngay khi phiếu chuyển sang `'FORFEITED'` hoặc `'APPROVED_PENDING_PAYOUT'`, hàm tự động giải phóng căn hộ về `'AVAILABLE'` (nếu không còn hợp đồng hay phiếu giữ chỗ hợp lệ khác).
4. **Các hàm `SECURITY DEFINER` hẹp cho thông báo & cập nhật STK dưới RLS (`SET search_path = public, pg_temp`):**
   - `fn_notify_reservation_staff`: Cho phép gửi thông báo `RESERVATION_CANCEL_PENDING_APPROVAL` tới `OWNER` tòa nhà (hoặc `MANAGER` khác / `SYS_ADMIN` khi tòa khuyết chủ) và `RESERVATION_CANCEL_APPROVED_FOR_PAYOUT` / `RESERVATION_CANCEL_REJECTED` tới `MANAGER` tòa nhà mà không cần `adminPool`.
   - `fn_update_reservation_refund_bank_info(p_reservation_id UUID, p_bank_info JSONB) RETURNS reservation`: Cho phép `MANAGER` được phân công tòa nhà hoặc `RESIDENT` có SĐT trùng `reservation.phone` (trong cùng `org_id`) cập nhật `refund_bank_info` và đặt `refund_method = 'BANK_TRANSFER'` khi `reservation.status = 'APPROVED_PENDING_PAYOUT'` và `refunded_amount > 0` mà không mở quyền `UPDATE reservation` trực tiếp cho `RESIDENT` ở tầng bảng.

#### B. Luồng API tại `api/src/routes/reservations.js`
1. **Bước 1 — Lập đề xuất hủy giữ chỗ: `PATCH /api/v1/reservations/:id/cancel-settle` (`requireRole(['MANAGER'])`):**
   - Chỉ `MANAGER` quản lý tòa nhà của phiếu giữ chỗ được lập đề xuất (`403 FORBIDDEN_BUILDING` nếu ngoài phạm vi).
   - Chỉ nhận phiếu đang thỏa `isReservationSettleable` (`HELD`, hoặc `EXPIRED` đã xác nhận tiền, chưa có `refunded_amount + forfeited_amount > 0`).
   - Kiểm tra `reason` bắt buộc (`400 REASON_REQUIRED`), `refunded_amount + forfeited_amount === hold_amount` (`422 INVALID_CANCEL_SPLIT`).
   - Nếu `refunded_amount > 0`: kiểm tra `refund_method` (`BANK_TRANSFER` | `CASH`) và `refund_bank_info` qua `validateRefundBankInfo` (`422` nếu thiếu/sai STK). **Không bắt buộc `refund_evidence` (UNC) ở bước này.**
   - Cập nhật `status = 'CANCEL_PENDING_APPROVAL'`, lưu `refunded_amount`, `forfeited_amount`, `cancel_reason`, `refund_method`, `refund_bank_info`, và `cancel_settlement`:
     `{ previous_status, proposed_by, proposed_at, policy_suggested_split, policy_override, approved_by: null, approved_at: null, payout_by: null, payout_at: null, reference_code: null }`.
   - Gửi thông báo cho `OWNER` (hoặc người duyệt dự phòng), ghi `audit_log(action = 'CANCEL_SETTLE_PROPOSE')`.

2. **Bước 2a — Phê duyệt phương án hoàn/phạt: `POST /api/v1/reservations/:id/cancel-approve` (`requireRole(['OWNER', 'MANAGER', 'SYS_ADMIN'])`):**
   - Kiểm tra thẩm quyền duyệt qua `canActAsReservationApprover` (chặn `SYS_ADMIN` nếu tòa đã có `OWNER` hoạt động: `403 SYS_ADMIN_READ_ONLY_ON_OWNED_BUILDING`; chặn `MANAGER` tự duyệt khi tòa đã có `OWNER` hoạt động? Lưu ý: giữ đúng `canActAsReservationApprover` + Four-Eyes `PRD 6.1`: `OWNER` tòa nhà hoặc `MANAGER` thứ 2 khác người lập đề xuất/xác nhận, dự phòng `SYS_ADMIN` khi tòa khuyết chủ).
   - Bắt buộc `status === 'CANCEL_PENDING_APPROVAL'` (`409 INVALID_STATUS`).
   - Kiểm tra **Four-Eyes (`checkFourEyesOrWarn`)** giữa `req.user.sub` và `proposerId = cancel_settlement.proposed_by || confirmed_by || created_by` (`403 FOUR_EYES_VIOLATION` nếu trùng người lập đề xuất mà `allow_self_approval = false`).
   - Phân nhánh theo `refunded_amount`:
     - **`refunded_amount === 0` (Phạt cọc 100%):** Chuyển thẳng `status = 'FORFEITED'`, ghi nhận `approved_by` / `approved_at` trong `cancel_settlement`, gọi `fn_sync_apartment_status_after_reservation` (giải phóng căn về `AVAILABLE`), thông báo cho khách (`fn_notify_reservation_prospect`), ghi `audit_log(action = 'CANCEL_SETTLE_APPROVE')`.
     - **`refunded_amount > 0` (Có hoàn tiền):** Chuyển `status = 'APPROVED_PENDING_PAYOUT'`, ghi nhận `approved_by` / `approved_at`, **gọi ngay `fn_sync_apartment_status_after_reservation` để mở căn hộ về `AVAILABLE`**, gửi thông báo cho `MANAGER` tòa nhà đi chuyển khoản & tải UNC (`RESERVATION_CANCEL_APPROVED_FOR_PAYOUT`), ghi `audit_log(action = 'CANCEL_SETTLE_APPROVE')`.

3. **Bước 2b — Từ chối đề xuất hủy: `POST /api/v1/reservations/:id/cancel-reject` (`requireRole(['OWNER', 'MANAGER', 'SYS_ADMIN'])`):**
   - Kiểm tra `canActAsReservationApprover` + Four-Eyes + bắt buộc `reason` (`400 REASON_REQUIRED`) trên phiếu `CANCEL_PENDING_APPROVAL`.
   - Khôi phục `status` về `'EXPIRED'` (nếu `hold_until < getTodayVnDateStr()`) hoặc `'HELD'`, đặt lại `refunded_amount = 0, forfeited_amount = 0`, lưu `rejected_by`, `rejected_at`, `rejected_reason` vào `cancel_settlement`, đồng bộ trạng thái căn hộ, báo cho `MANAGER`, ghi `audit_log(action = 'CANCEL_SETTLE_REJECT')`.

4. **Bước 3 — Thực chi hoàn tiền & Tải UNC: `POST /api/v1/reservations/:id/cancel-payout` (`requireRole(['MANAGER'])`):**
   - Chỉ `MANAGER` quản lý tòa nhà được thực thi (`OWNER` và `SYS_ADMIN` bị chặn `403`).
   - Yêu cầu `status === 'APPROVED_PENDING_PAYOUT'` và `refunded_amount > 0` (`409 INVALID_STATUS`).
   - Kiểm tra lại `refund_bank_info` (nếu `refund_method === 'BANK_TRANSFER'`), và **bắt buộc đính kèm ít nhất 01 chứng từ UNC hợp lệ trong `refund_evidence`** (`422 REFUND_EVIDENCE_REQUIRED` khi `refund_method === 'BANK_TRANSFER'`). Hỗ trợ `reference_code` (mã giao dịch ngân hàng) và `note`.
   - Lưu tệp qua `persistReservationEvidence`, chuyển `status` sang `'REFUNDED'` (`forfeited_amount === 0`) hoặc `'PARTIALLY_REFUNDED'` (`forfeited_amount > 0`), lưu `payout_by`, `payout_at`, `reference_code` vào `cancel_settlement`, thông báo cho khách (`fn_notify_reservation_prospect`), ghi `audit_log(action = 'CANCEL_SETTLE_PAYOUT')`.

5. **Cập nhật STK thụ hưởng trước khi chi & Đóng lỗ hổng route tắt `PATCH /:id/refund`:**
   - Thêm `PATCH /api/v1/reservations/:id/bank-info` (`requireRole(['MANAGER', 'RESIDENT'])`) gọi `fn_update_reservation_refund_bank_info` cho phép `MANAGER` tòa nhà hoặc khách có trùng SĐT trên phiếu `APPROVED_PENDING_PAYOUT` cập nhật lại `refund_bank_info` (chấp nhận cả `{ bank_info }` lẫn phẳng, giữ đủ `bank_logo`) và gửi thông báo cho `MANAGER` tòa nhà nếu khách tự cập nhật.
   - Chuẩn hóa route tắt `PATCH /api/v1/reservations/:id/refund`: khi `OWNER` / người duyệt gọi `PATCH /:id/refund` trên phiếu `HELD`/`EXPIRED` (duyệt hoàn 100% trực tiếp), hệ thống chuyển sang **`APPROVED_PENDING_PAYOUT`** (`refunded_amount = hold_amount, forfeited_amount = 0, refund_method = COALESCE(body.refund_method, 'BANK_TRANSFER')`, lưu `cancel_settlement = { approved_by, approved_at, direct_refund_approval: true }`, giải phóng căn hộ về `AVAILABLE`) thay vì nhảy tắt sang `REFUNDED` không UNC; sau đó khách/BQL cập nhật STK (nếu `BANK_TRANSFER` chưa có STK) và `MANAGER` gọi `POST /:id/cancel-payout` kèm UNC để hoàn tất `REFUNDED`. Route `PATCH /:id/forfeit` (`refunded_amount = 0`, không chi tiền) giữ nguyên chốt thẳng `FORFEITED`.

#### C. Đồng bộ Báo cáo `RP-07`, Cron, Cổng Cư dân & UI `ApartmentDetailPage.jsx`
- **`api/src/routes/public.js`:** Chặn spam giữ chỗ công khai theo SĐT khi `status IN ('PENDING_CONFIRM', 'HELD', 'CANCEL_PENDING_APPROVAL')`.
- **`api/src/routes/reports.js` & `ReportsPage.jsx` (*Quyết định thiết kế bảo toàn 100% số dư VND ở mọi trạng thái*):**
  - Dashboard KPI bổ sung `pending_reservation_approvals` (`CANCEL_PENDING_APPROVAL`) và `pending_reservation_payouts` (`APPROVED_PENDING_PAYOUT`).
  - `RP-07` (`reservation_summary`) đảm bảo định luật bảo toàn `hold_amount` tại mọi thời điểm:
    - `active_held_count` / `active_held_amount`: các phiếu `status IN ('HELD', 'CANCEL_PENDING_APPROVAL')` (toàn bộ `hold_amount` đang khóa giữ chỗ).
    - `pending_payout_count` / `pending_payout_amount`: các phiếu `status = 'APPROVED_PENDING_PAYOUT'`, tính bằng `SUM(r.refunded_amount)` (phần nghĩa vụ tiền mặt còn đang chờ BQL chuyển trả khách).
    - `forfeited_in_period`: ghi nhận ngay phần phạt hủy đã được `OWNER` chốt duyệt (`status IN ('FORFEITED', 'APPROVED_PENDING_PAYOUT', 'PARTIALLY_REFUNDED')` và `r.forfeited_amount > 0` hoặc `FORFEITED`), lọc ngày theo `COALESCE((r.cancel_settlement->>'approved_at')::timestamptz, r.updated_at)`. Như vậy với phiếu `2.000.000 ₫` hoàn `1.200.000 ₫` / phạt `800.000 ₫`, ngay khi `OWNER` duyệt: `pending_payout_amount = 1.200.000 ₫` + `forfeited_in_period = 800.000 ₫` = `2.000.000 ₫` (không hụt 1 đồng nào!).
    - `refunded_in_period`: chỉ ghi nhận khi `MANAGER` đã thực chi kèm UNC (`status IN ('REFUNDED', 'PARTIALLY_REFUNDED')`), lọc ngày theo `COALESCE((r.cancel_settlement->>'payout_at')::timestamptz, r.updated_at)`.
  - Trên `ReportsPage.jsx`, bổ sung hiển thị dòng/thẻ phụ cho `pending_payout_amount` (`pending_payout_count` phiếu đã duyệt hủy chờ chi hoàn) trong khối Đối soát Tiền đặt giữ chỗ.
- **`api/src/routes/resident.js` & `resident.service.js` & `OverviewTab.jsx` & `statuses.js` (*Quyết định thiết kế khép kín UX Cổng cư dân*):**
  - Bổ sung nhãn tiếng Việt trong `RESERVATION_STATUS` (`statuses.js`): `CANCEL_PENDING_APPROVAL: { label: 'Chờ duyệt hủy giữ chỗ', variant: 'amber' }`, `APPROVED_PENDING_PAYOUT: { label: 'Chờ chi hoàn giữ chỗ', variant: 'sky' }`.
  - `GET /api/v1/resident/overview` trả thêm `refund_method`, `refund_bank_info`, `cancel_settlement` cho các bản ghi giữ chỗ của khách; hiển thị phiếu đang `CANCEL_PENDING_APPROVAL` / `APPROVED_PENDING_PAYOUT` trên `OverviewTab.jsx` kèm nút + Modal `BankSelect` **"Cập nhật STK nhận hoàn"** (gọi `PATCH /api/v1/reservations/:id/bank-info`) khi `reservation_status === 'APPROVED_PENDING_PAYOUT'` và `refunded_amount > 0`.
- **`ApartmentDetailPage.jsx` & `depositUiHelpers.js` & `buildings.service.js`:**
  - `MANAGER` thấy nút **"Đề xuất thanh lý hủy"** trên phiếu `HELD` / `EXPIRED` (Modal đề xuất chỉ nhập tỷ lệ hoàn/phạt + phương thức hoàn + STK nhận hoàn + lý do, **không** bắt tải UNC).
  - `OWNER` (hoặc người duyệt hợp lệ theo Four-Eyes) thấy nút **"Duyệt thanh lý hủy"** / **"Từ chối"** trên phiếu `CANCEL_PENDING_APPROVAL` (hiển thị rõ cảnh báo nếu `policy_override = true` lệch chính sách cấu hình).
  - `MANAGER` thấy nút **"Chi hoàn & Tải UNC"** (và **"Sửa STK"**) trên phiếu `APPROVED_PENDING_PAYOUT`, mở Modal xác nhận thực chi khóa cứng số tiền đã duyệt và bắt buộc đính kèm ảnh UNC khi `BANK_TRANSFER`.

---

## 6. Phần để ngỏ cho Người triển khai (Left to the Builder)
- Cách bố cục chi tiết các thẻ thông tin phụ trong Modal Duyệt / Thực chi trên `ApartmentDetailPage.jsx` và banner hướng dẫn trên `ContractDetailPage.jsx` miễn sao dùng đúng bộ component dùng chung (`Modal`, `Button`, `StatusBadge`, `BankSelect`, `FileUpload`, `MoneyInput`) và thông điệp tiếng Việt chuẩn xác.
- Tách hàm nội bộ dùng chung giữa `activate` và `approve` trong `api/src/routes/contracts.js` để tránh lặp logic chuyển phòng.
