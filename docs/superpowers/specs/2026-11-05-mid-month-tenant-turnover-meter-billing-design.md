# Thiết kế: Chốt chỉ số Điện/Nước & Lập hóa đơn khi Đổi khách giữa tháng (Mid-Month Tenant Turnover)

- **Ngày tạo**: 2026-11-05
- **Phạm vi**: Database Migration (`052`), Backend (`meters.js`, `invoices.js`, `deposits.js`, `serviceBilling.js`, `apartments.js`, `resident.js`, `aiGateway.js`), Frontend (`MeterReadingsPage.jsx`)
- **Phân loại quy mô**: Project (liên tầng DB/RLS + Billing Engine + Deposit Settlement + UI)

---

## 1. Bối cảnh & Lý do (Intent & Why)

Trong vận hành thực tế căn hộ cho thuê, một căn hộ có thể phát sinh **2 hợp đồng khác nhau trong cùng một tháng dương lịch (`YYYY-MM`)**:
- **Ví dụ điển hình**:
  - `30/11`: Quản lý chốt chỉ số cuối kỳ `2026-11` là **`1.000 kWh`**.
  - `15/12`: **Khách cũ (Hợp đồng A)** trả phòng giữa tháng, Quản lý chụp và chốt công tơ bàn giao ra là **`1.100 kWh`** -> cần lập hóa đơn kỳ cuối `2026-12` thu `100 kWh` (`1.000 → 1.100`) và tất toán cọc cho Khách cũ.
  - `20/12`: **Khách mới (Hợp đồng B)** dọn vào ở cùng căn hộ đó.
  - `31/12`: Quản lý chốt chỉ số cuối kỳ `2026-12` là **`1.185 kWh`** -> cần lập hóa đơn `2026-12` cho Khách mới thu `85 kWh` (`1.100 → 1.185`), nối tiếp trực tiếp từ chỉ số chốt trả phòng của Khách cũ.

### Lỗi hiện tại trong hệ thống ResiHub
1. **Ràng buộc DB 1 dòng/kỳ (`024_meter_readings.sql:35`)**: Bảng `meter_reading` có `UNIQUE (meter_id, period)` nên mỗi công tơ chỉ lưu được tối đa 1 bản ghi trong kỳ `2026-12`.
2. **Ghi đè làm mất sản lượng (`api/src/routes/meters.js:472-483, 561-580`)**:
   - `previousReading` chỉ truy vấn `period < $2`, bỏ qua chỉ số đã chốt đầu/giữa tháng trong cùng kỳ `2026-12`.
   - `ON CONFLICT (meter_id, period) DO UPDATE` ghi đè trực tiếp lên dòng `1.100` thành `1.000 → 1.185` ngay cả khi hóa đơn của Khách cũ đã phát hành (`ISSUED`) hoặc thanh toán (`PAID`).
3. **Bỏ qua tính điện/nước cho Hợp đồng thứ 2 trong tháng (`api/src/routes/invoices.js:325-334, 400-412`)**:
   - Cổng kiểm tra thiếu chỉ số (`missingMetersRes`) và vòng lặp sinh dòng điện/nước (`alreadyBilledRes`) đều bỏ qua nếu trong cùng `(apartment_id, period)` đã có bất kỳ hợp đồng nào khác (`i2.contract_id <> c.id`) từng lên hóa đơn điện/nước. Hệ quả: Hóa đơn `2026-12` của Khách mới bị thu `0 ₫` điện/nước, còn sang kỳ `2027-01` hệ thống lấy mốc `1.185` -> **thất thoát vĩnh viễn `85 kWh`**.
4. **Hổng điều kiện tất toán cọc (`api/src/routes/deposits.js:253-286`)**:
   - `checkSettlementPreconditions` kiểm tra `meter_reading` theo `(meter_id, period)` mà không gắn với `contract_id`. Nếu Hợp đồng B cũng thanh lý sớm cuối tháng `12` khi chưa chốt công tơ riêng, hệ thống có thể nhìn nhầm bản ghi `CONFIRMED` của Hợp đồng A và cho phép tất toán cọc sai.

---

## 2. Mục tiêu, Phi mục tiêu & Điều cấm kỵ (Goals, Non-Goals, Anti-Goals)

### Goals (Mục tiêu bắt buộc)
1. Cho phép ghi nhận, xác nhận (`CONFIRMED`) và lập hóa đơn điện/nước độc lập cho từng hợp đồng cùng thuê một căn hộ trong cùng kỳ `YYYY-MM` (2 hoặc nhiều lượt đổi khách/gia hạn hợp đồng mới trong cùng tháng).
2. **Tự động nối tiếp chỉ số (`previous_reading`)**: Hợp đồng sau trong cùng kỳ (hoặc kỳ kế tiếp) luôn lấy `previous_reading` nối tiếp trực tiếp từ `current_reading` gần nhất trước đó của công tơ (ví dụ nối thẳng từ `1.100` của Khách cũ).
3. **Khóa bất biến chỉ số đã lên hóa đơn phát hành**: Mọi bản ghi `meter_reading` đã được tham chiếu bởi hóa đơn có trạng thái khác `DRAFT`, `VOID`, `CANCELLED` đều bị khóa không cho sửa/ghi đè (`409 READING_ALREADY_BILLED`).
4. **Ràng buộc tất toán cọc chuẩn xác theo từng hợp đồng**: `checkSettlementPreconditions` kiểm tra đúng chỉ số công tơ kỳ cuối và hóa đơn kỳ cuối của chính hợp đồng đang tất toán.
5. **Tương thích ngược 100%**: Bảo toàn dữ liệu lịch sử (`contract_id IS NULL`), luồng nhập bảng hàng loạt trên `MeterReadingsPage.jsx`, quét ảnh AI OCR (`aiGateway.js`), Portal Cư dân (`resident.js`) và chi tiết căn hộ (`apartments.js`).

### Non-Goals (Phi mục tiêu — Đã chốt với người dùng)
- **Không** thêm trường nhập tay `handover_reading` khi tạo hoặc kích hoạt hợp đồng mới, và **không** tách đợt ghi công tơ chủ nhà ở khoảng trống giữa 2 hợp đồng trong cùng tháng: Người dùng đã quyết định luôn mặc định nối tiếp trực tiếp từ chỉ số chốt trả phòng của khách cũ sang khách mới (`contract_id IS NULL` chỉ dùng cho dữ liệu lịch sử cũ hoặc kỳ tháng mà căn hộ hoàn toàn không có hợp đồng nào giao thoa).
- **Không** tách riêng hóa đơn tiền nhà và hóa đơn điện/nước thành 2 hóa đơn cho cùng một hợp đồng trong một kỳ (giữ nguyên chuẩn PRD gộp chung 1 hóa đơn/hợp đồng/kỳ).

### Anti-Goals (Điều cấm kỵ — Nếu vi phạm coi như thất bại)
- Tuyệt đối không ghi đè bản ghi `meter_reading` đã lên hóa đơn phát hành (`ISSUED`, `PARTIALLY_PAID`, `PAID`, `OVERDUE`).
- Tuyệt đối không làm thất thoát hoặc tính trùng sản lượng (`kWh` / `m³`) giữa Khách cũ, Khách mới và kỳ tháng kế tiếp.
- Tuyệt đối không phá vỡ chính sách `ENABLE ROW LEVEL SECURITY` + `FORCE ROW LEVEL SECURITY` của PostgreSQL (đặc biệt: `SYS_ADMIN` chỉ có quyền `SELECT` trên `meter_reading`, không được thực hiện `UPDATE meter_reading` từ luồng sinh hóa đơn của `SYS_ADMIN`; Cư dân B không được xem ảnh/chỉ số công tơ riêng của Cư dân A).
- Không tạo trigger `BEFORE DELETE` chặn `adminPool` dọn dữ liệu trong bộ test tích hợp (`api/test/*.test.js`).

---

## 3. Ràng buộc Kỹ thuật & Bảo mật (Constraints)

1. **PostgreSQL RLS 2 lớp (`049_m08_m09_billing_engine_and_cron_lock.sql`)**:
   - `rls_meter_reading_modify` chỉ cho phép role `MANAGER` thuộc tòa nhà được phân công (`is_manager() AND building_id IN (...)`) thực hiện `INSERT/UPDATE/DELETE` trên `meter_reading`. Do đó, `generateInvoicesCore` (vốn có thể được gọi bởi `SYS_ADMIN` hoặc cron job) chỉ được `SELECT` từ `meter_reading`, không `UPDATE meter_reading`.
   - `rls_meter_reading_select` và hàm `SECURITY DEFINER` `can_select_attachment` phải giới hạn quyền của `RESIDENT` sao cho cư dân chỉ nhìn thấy bản ghi `meter_reading` (và ảnh đính kèm) có `status = 'CONFIRMED'` thuộc hợp đồng của chính mình (`contract_id IN (SELECT contract_id FROM get_resident_contract_ids())`), hoặc bản ghi lịch sử `contract_id IS NULL` của căn hộ mình đang/đã thuê.
2. **Quy ước ngày hiệu lực hợp đồng (`serviceBilling.js`)**:
   - Hợp đồng bình thường có `end_date` là mốc exclusive (`lastActiveDay = end_date - 1 day`), còn `terminated_at` là mốc inclusive (`lastActiveDay = terminated_at`), và hợp đồng chuyển phòng (`is_room_transfer`) cắt ngày theo `child.start_date - 1 day`. Mọi truy vấn xác định hợp đồng giao thoa với kỳ `YYYY-MM` phải tuân thủ nhất quán quy ước này (giống `invoices.js:260-284`).

---

## 4. Các Phương án đã Cân nhắc (Approaches Considered)

| Phương án | Mô tả | Đánh đổi (Trade-offs) | Quyết định |
|---|---|---|---|
| **Phương án 1 (Đã chọn)** | Gắn `contract_id` (nullable) vào `meter_reading`, thay `UNIQUE (meter_id, period)` bằng Partial Unique Index theo `(meter_id, period, contract_id)` và `(meter_id, period) WHERE contract_id IS NULL`. Tự động xác định hợp đồng mục tiêu theo thứ tự thời gian trong kỳ, tự nối tiếp `previous_reading`, khóa bản ghi đã lập hóa đơn phát hành, và khớp theo `contract_id` khi sinh hóa đơn / tất toán cọc. | Sửa vừa đủ từ DB -> API -> UI bảng chỉ số; giữ nguyên thiết kế `period = YYYY-MM` trên toàn hệ thống báo cáo, công nợ, Portal cư dân và AI OCR. | **Người dùng đã chọn** |
| **Phương án 2** | Giữ nguyên `period` nhưng thêm cột `reading_seq` (`1, 2, 3...`) hoặc `reading_type` (`MONTHLY`, `MOVE_OUT`) không gắn trực tiếp `contract_id`. | Khó biết chắc lượt chốt nào thuộc hợp đồng nào khi có 2–3 biến động hợp đồng trong tháng hoặc khi sinh hóa đơn hàng loạt / kiểm tra điều kiện tất toán cọc. | Loại |
| **Phương án 3** | Bỏ khái niệm chốt theo kỳ `YYYY-MM`, chuyển sang sổ cái sự kiện đo đếm theo timestamp bất kỳ (`meter_event_ledger`) và tính hóa đơn bằng cách gom các khoảng đo chưa thanh toán. | Phải viết lại toàn bộ màn hình `MeterReadingsPage`, bộ lọc theo tháng, cảnh báo bất thường 3 kỳ, cron sinh hóa đơn và schema báo cáo. Rủi ro hồi quy quá lớn. | Loại |

---

## 5. Thiết kế Chi tiết

### 5.1. Quyết định từ Người dùng vs. Đề xuất kỹ thuật của Builder

- **Quyết định của Người dùng**:
  1. Chọn **Phương án 1** (gắn `contract_id` cho bản ghi chỉ số trong kỳ, khóa bản ghi đã lập hóa đơn, khớp theo hợp đồng khi tính hóa đơn).
  2. **Không dùng `handover_reading` nhập tay**: Mặc định nối tiếp luôn từ chỉ số chốt trả phòng của khách cũ.
- **Quyết định kỹ thuật của Builder (Our calls)**:
  1. **Quy tắc tự động chuyển "ô nhập hiện tại" trên `MeterReadingsPage`**: Khi một căn hộ có 2 hợp đồng giao thoa trong cùng kỳ `YYYY-MM` (HĐ A rồi đến HĐ B), API `GET /api/v1/meters` và `POST /readings` (khi không truyền `contract_id` tường minh) sẽ chọn **hợp đồng đầu tiên theo thứ tự thời gian chưa khóa thanh toán kỳ đó** (`is_period_finalized === false`, tức chưa có hóa đơn `status NOT IN ('DRAFT', 'VOID', 'CANCELLED')` trong kỳ và — nếu HĐ đã kết thúc — sổ cọc chưa bước vào hồ sơ tất toán cuối kỳ; lưu ý **không** coi `deposit.status = 'TRANSFERRED'` của chuyển phòng là đã khóa kỳ vì cọc được kết chuyển ngay lúc duyệt chuyển phòng trước khi chốt công tơ căn cũ). Ngay khi HĐ A phát hành hóa đơn kỳ cuối (hoặc bước vào tất toán cọc), ô nhập của căn hộ trên bảng kỳ `YYYY-MM` tự động chuyển sang HĐ B với `Chỉ số cũ = current_reading của HĐ A`. Ngoài ra, modal **Chi tiết** của đồng hồ sẽ hiển thị dropdown chọn hợp đồng nếu trong kỳ có `>= 2` hợp đồng giao thoa để Quản lý vẫn có thể chủ động chọn HĐ B ngay cả khi hóa đơn HĐ A đang ở trạng thái nháp.
  2. **Khóa cả bản ghi sản lượng bằng `0` (`0 kWh` / `0 m³`) khi hợp đồng đã chốt kỳ**: Vì `generateInvoicesCore` không tạo dòng `invoice_line` khi `consumption = 0`, quy tắc khóa `is_billed = true` sẽ khóa mọi bản ghi `CONFIRMED` gắn với `contract_id` ngay khi hợp đồng đó đã `is_period_finalized === true` (có hóa đơn phát hành trong kỳ hoặc cọc đã vào quy trình tất toán), không để lọt trường hợp sửa nhầm chỉ số `0 m³` sau khi khách cũ đã thanh lý xong.
  3. **Bảo toàn tính đơn điệu chuỗi chỉ số (Monotonic Chain) & Cảnh báo bất thường dây chuyền**:
     - Nếu sửa/chèn một bản ghi chưa khóa mà phía sau nó đã có bản ghi kế tiếp (`nextRow`) **đã khóa (`is_billed === true`)**, hệ thống chặn `409 READING_ALREADY_BILLED` nếu `current_reading` mới làm thay đổi `nextRow.previous_reading`.
     - Nếu `nextRow` liền kề **chưa khóa (`is_billed === false`)**, hệ thống tự động cập nhật lại `nextRow.previous_reading`, `nextRow.consumption`, chạy lại `evaluateMeterReadingAnomaly` cho `nextRow`; nếu `nextRow` phát sinh bất thường (`>30%`) mà chưa có `abnormal_note`, hạ trạng thái `nextRow` từ `CONFIRMED` về `FLAGGED` để Quản lý kiểm tra lại.
  4. **Tự động đồng bộ hóa đơn `DRAFT` khi sửa/xác nhận lại chỉ số công tơ**: Nếu hợp đồng của bản ghi vừa sửa/xác nhận (hoặc của `nextRow` vừa được cập nhật dây chuyền) đang có sẵn hóa đơn `DRAFT` trong kỳ đó, `meters.js` sẽ tự động cập nhật lại dòng `ELECTRICITY`/`WATER` trên hóa đơn `DRAFT` đó và gọi `recalculateDraftInvoiceTotalsInTx` + `applyAvailableCreditsInTx` ngay trong cùng transaction để hóa đơn nháp không bao giờ bị lệch số cũ.
  5. **Tính bất thường 3 kỳ (`evaluateMeterReadingAnomaly`)**: Đường cơ sở trung bình 3 kỳ (`baseline_avg_consumption`) lấy tối đa 3 bản ghi `CONFIRMED` có `consumption > 0` của các kỳ trước (`period < $period`, sắp xếp `period DESC, current_reading DESC, recorded_at DESC`).

---

### 5.2. Database Migration: `052_meter_reading_per_contract_turnover.sql`

1. **Thêm cột `contract_id`**:
   ```sql
   ALTER TABLE meter_reading
     ADD COLUMN IF NOT EXISTS contract_id UUID REFERENCES contract(id) ON DELETE SET NULL;
   ```
   *(Dùng `ON DELETE SET NULL` để bảo toàn lịch sử số đo công tơ và không gây lỗi khóa ngoại khi test cleanup xóa hợp đồng).*

2. **Backfill dữ liệu hiện có (An toàn & Idempotent)**:
   - **Bước 1 (Từ `invoice_line` đã sinh)**: Cập nhật `mr.contract_id = inv.contract_id` cho các dòng `meter_reading` đang có `contract_id IS NULL` mà khớp với `(il.formula_meta->>'reading_id')::uuid = mr.id` trên hóa đơn `inv.status NOT IN ('VOID', 'CANCELLED')`.
   - **Bước 2 (Từ hợp đồng duy nhất giao thoa kỳ)**: Với các dòng còn `contract_id IS NULL`, nếu trong `(mr.apartment_id, mr.period)` chỉ có **đúng 1** hợp đồng hợp lệ giao thoa kỳ đó (`status IN ('ACTIVE', 'RENEWAL_PENDING', 'TERMINATION_PENDING', 'TERMINATED', 'EXPIRED')`), gán `mr.contract_id = c.id`. Các dòng của căn hộ trống hoặc mơ hồ giữ nguyên `contract_id IS NULL`.

3. **Thay thế Unique Constraint bằng Partial Unique Indexes**:
   - Tìm và xóa động constraint `UNIQUE (meter_id, period)` trên bảng `meter_reading` (thường mang tên `meter_reading_meter_id_period_key` trong `pg_constraint`).
   - Tạo 2 partial unique index + 1 lookup index:
     ```sql
     CREATE UNIQUE INDEX IF NOT EXISTS ux_meter_reading_period_contract
       ON meter_reading (meter_id, period, contract_id)
       WHERE contract_id IS NOT NULL;

     CREATE UNIQUE INDEX IF NOT EXISTS ux_meter_reading_period_null_contract
       ON meter_reading (meter_id, period)
       WHERE contract_id IS NULL;

     CREATE INDEX IF NOT EXISTS idx_meter_reading_contract_period
       ON meter_reading (contract_id, period)
       WHERE contract_id IS NOT NULL;
     ```

4. **Cập nhật RLS (`rls_meter_reading_select` & `can_select_attachment`)**:
   - `rls_meter_reading_select`: Nhánh `RESIDENT` chỉ cho phép `SELECT` khi `status = 'CONFIRMED'` và:
     - `(contract_id IS NOT NULL AND contract_id IN (SELECT contract_id FROM get_resident_contract_ids()))`
     - `OR (contract_id IS NULL AND apartment_id IN (SELECT c.apartment_id FROM contract c WHERE c.id IN (SELECT contract_id FROM get_resident_contract_ids())))`
   - `can_select_attachment`: Cập nhật nhánh `ELSIF p_owner_entity = 'meter_reading'` cho `is_resident()` với đúng điều kiện `contract_id` tương tự (giữ nguyên toàn bộ các nhánh entity khác từ migration `049`).

---

### 5.3. Dịch vụ Xác định Hợp đồng Mục tiêu & Nối tiếp Chỉ số (`serviceBilling.js` & `meters.js`)

Tạo các helper dùng chung (tách phần logic thuần vào `api/src/services/serviceBilling.js` để dễ unit test và phần truy vấn DB vào helper dùng bởi `meters.js` / `aiGateway.js`):

1. **Truy vấn danh sách hợp đồng giao thoa kỳ `(apartment_id, period)`**:
   - Lọc hợp đồng thuộc căn hộ có `status IN ('ACTIVE', 'RENEWAL_PENDING', 'TERMINATION_PENDING', 'TERMINATED', 'EXPIRED')` có ít nhất 1 ngày hiệu lực nằm trong `[monthStart .. monthEnd]` (dùng `resolveContractLastActiveDay` kèm `room_transfer_child_start_date`, loại bỏ hợp đồng `movedIn === false`).
   - Sắp xếp tăng dần theo thời gian: `overlapStart ASC, start_date ASC, created_at ASC`.
   - Đánh dấu mỗi hợp đồng `is_period_finalized`:
     - `true` nếu hợp đồng đã có hóa đơn kỳ `period` ở trạng thái `NOT IN ('DRAFT', 'VOID', 'CANCELLED')`, hoặc hợp đồng đã kết thúc (`TERMINATED`/`EXPIRED`) và sổ cọc đã vào hồ sơ tất toán (`d.status IN ('PENDING_APPROVAL', 'APPROVED_PENDING_PAYOUT', 'RETURNED', 'PARTIALLY_REFUNDED', 'REFUNDED', 'DEDUCTED_FULL', 'DISPUTED')` — **không** tính `'TRANSFERRED'` vì khi chuyển phòng cọc kết chuyển ngay lúc duyệt trước khi ghi chỉ số công tơ căn cũ).

2. **Chọn `targetContract` cho `(meter, period, requestedContractId?)`**:
   - Nếu client gửi `contract_id` hợp lệ: kiểm tra hợp đồng đó thuộc đúng `meter.apartment_id` và giao thoa `period` (nếu sai trả `400 VALIDATION_ERROR`).
   - Nếu không truyền `contract_id`:
     - Nếu không có hợp đồng nào giao thoa `period`: `targetContract = null`.
     - Nếu có hợp đồng giao thoa: chọn **hợp đồng đầu tiên có `is_period_finalized === false`**. Nếu tất cả đều đã `is_period_finalized === true`, chọn **hợp đồng cuối cùng** trong kỳ.

3. **Kiểm tra khóa hóa đơn (`isReadingBilled`) & Đồng bộ hóa đơn nháp (`DRAFT`)**:
   - Một bản ghi `meter_reading` (`mr`) được coi là **đã khóa (`is_billed = true`)** nếu thỏa **một trong hai** điều kiện:
     - **(a)** Tồn tại `invoice_line il` thuộc `invoice inv` (`inv.status NOT IN ('DRAFT', 'VOID', 'CANCELLED')`, `il.item_type = m.meter_type`) sao cho `(il.formula_meta->>'reading_id') = mr.id::text` HOẶC (`il.formula_meta->>'reading_id'` trống VÀ `inv.apartment_id = mr.apartment_id` VÀ `inv.period = mr.period` VÀ `(mr.contract_id = inv.contract_id OR mr.contract_id IS NULL)`).
     - **(b)** `mr.status = 'CONFIRMED'` VÀ `mr.contract_id IS NOT NULL` VÀ hợp đồng `mr.contract_id` đã `is_period_finalized === true` trong `mr.period` (giúp khóa chặt cả bản ghi có `consumption = 0` không sinh dòng `invoice_line`).
   - Nếu `upsertSingleReading` rơi vào dòng `existingRow` có `is_billed === true`: ném lỗi HTTP `409` với `code: 'READING_ALREADY_BILLED'`.
   - **Nhận diện dòng mồ côi chưa khóa (`contract_id IS NULL`)**: Nếu `targetContract` khác `null`, chưa có bản ghi riêng cho `targetContract.id`, nhưng trong `(meter_id, period)` đang có sẵn 1 bản ghi `contract_id IS NULL` **chưa bị khóa** (ví dụ Quản lý ghi nháp đầu tháng trước khi kích hoạt hợp đồng đầu tiên trong kỳ), `upsertSingleReading` sẽ gắn `contract_id = targetContract.id` và cập nhật trực tiếp dòng đó thay vì tạo dòng trùng.
   - **Đồng bộ hóa đơn `DRAFT` trong cùng transaction**: Khi `MANAGER` lưu mới, sửa hoặc xác nhận (`confirmReading` / `confirmBatch`) một bản ghi `meter_reading` (bao gồm cả `nextRow` được cập nhật dây chuyền), nếu hợp đồng tương ứng đang có hóa đơn `status = 'DRAFT'` ở kỳ đó, hệ thống tự động cập nhật/thêm/xóa dòng `item_type = m.meter_type` trên hóa đơn `DRAFT` (theo trạng thái `CONFIRMED` & đơn giá `resolveUtilityUnitPrice`) rồi gọi `recalculateDraftInvoiceTotalsInTx` + `applyAvailableCreditsInTx`.

4. **Tính `previousReading` nối tiếp (Chained Baseline)**:
   - Lấy tất cả bản ghi `meter_reading` của `meter_id` thuộc:
     - Các kỳ trước (`period < $period`), VÀ
     - Các bản ghi trong cùng kỳ (`period = $period`) đứng **trước** vị trí của `targetContract` (hoặc khác `existingRow.id` và đã ghi nhận cho hợp đồng trước đó / `contract_id IS NULL` đã khóa).
   - Chọn bản ghi gần nhất theo thứ tự `period DESC, current_reading DESC, recorded_at DESC LIMIT 1`.
   - Nếu có: `previousReading = Number(prevRow.current_reading)`. Nếu không có: `previousReading = Number(meter.initial_reading || 0)`.
   - Kiểm tra đơn điệu:
     - Nếu `currentVal < previousReading` -> `400 INVALID_READING`.
     - Nếu tồn tại bản ghi đứng **sau** (`nextRow` liền kề ở cùng kỳ của hợp đồng sau, hoặc ở `period > $period`):
       - Nếu `nextRow` đã khóa (`is_billed === true`) và `currentVal !== Number(nextRow.previous_reading)` -> `409 READING_ALREADY_BILLED` (không cho phép sửa làm hở hoặc trùng sản lượng với đợt sau đã khóa).
       - Nếu `currentVal > Number(nextRow.current_reading)` -> `400 INVALID_READING`.
       - Nếu `nextRow` liền kề chưa bị khóa (`is_billed === false`), cập nhật lại `nextRow.previous_reading = currentVal`, `nextRow.consumption = Number(nextRow.current_reading) - currentVal`, tính lại `evaluateMeterReadingAnomaly` cho `nextRow` (nếu `nextRow.is_abnormal === true` mà chưa có `abnormal_note` thì chuyển `nextRow.status` về `'FLAGGED'`, xóa `confirmed_by`/`confirmed_at`), và đồng bộ hóa đơn `DRAFT` của `nextRow` nếu có.

---

### 5.4. Sinh Hóa đơn theo Hợp đồng (`api/src/routes/invoices.js` — `generateInvoicesCore`)

0. **Sửa điều kiện lọc hợp đồng gốc chuyển phòng đặt lịch sang tháng sau (`dòng 214–218`)**:
   - Hiện tại khi ngày `25/11` Chủ nhà duyệt chuyển phòng có hiệu lực từ `15/12`, `contracts.js:3005` đổi `oldContract.status = 'TERMINATED'` và `terminated_at = '2026-11-25'` ngay lúc duyệt, trong khi cư dân vẫn ở căn cũ đến hết `14/12` (`rt.child_start_date - 1 day = '2026-12-14'`). Do `statusClause` hiện ràng buộc `lastActiveDay < month_next`, khi cuối tháng sinh hóa đơn kỳ `2026-11`, `'2026-12-14' < '2026-12-01'` trả về `FALSE` làm bỏ sót hóa đơn tháng `11` của căn cũ!
   - Sửa nhánh `c.status = 'TERMINATED'` trong `statusClause`: cho phép khớp khi `lastActiveDay` nằm trong kỳ `$2` **hoặc** khi `rt.child_start_date IS NOT NULL` và kỳ `$2` nằm trong đoạn từ tháng `c.terminated_at` tới `lastActiveDay` (hoặc khi truyền trực tiếp `contract_id`). Nhờ vậy hợp đồng chuyển phòng đặt lịch trước vẫn sinh đủ cả hóa đơn tháng hiện tại (`2026-11`) lẫn hóa đơn tháng chuyển đi (`01/12..14/12`) mà không ảnh hưởng các hợp đồng thanh lý cũ của những tháng trước.

1. **Cổng kiểm tra thiếu chỉ số xác nhận (`AC-015.1`, dòng 312–353)**:
   - Với từng hợp đồng `c` đang xét trong `targetPeriod`:
   - Bỏ điều kiện cũ `AND NOT EXISTS (... i2.contract_id <> $4 ...)` vốn làm Hợp đồng B lọt qua cổng kiểm tra dù chưa chốt chỉ số riêng!
   - Thay bằng kiểm tra công tơ `m` (`status = 'ACTIVE'`, `created_at <= effectivePeriodEndYmd`) đã có bản ghi `CONFIRMED` dành cho `c` chưa:
     ```sql
     EXISTS (
       SELECT 1 FROM meter_reading mr
       WHERE mr.meter_id = m.id
         AND mr.period = $3
         AND mr.status = 'CONFIRMED'
         AND (
           mr.contract_id = $4
           OR (
             mr.contract_id IS NULL
             AND NOT EXISTS (
               SELECT 1 FROM invoice i2
               JOIN invoice_line il2 ON il2.invoice_id = i2.id
               WHERE i2.apartment_id = $1
                 AND i2.period = $3
                 AND i2.status NOT IN ('VOID', 'CANCELLED')
                 AND i2.contract_id <> $4
                 AND il2.item_type = m.meter_type
                 AND (
                   (il2.formula_meta->>'reading_id') = mr.id::text
                   OR (il2.formula_meta->>'reading_id') IS NULL
                 )
             )
           )
         )
     )
     ```
   - Ý nghĩa:
     - Nếu `mr` có `contract_id = c.id` và `CONFIRMED` -> Hợp lệ cho `c`.
     - Nếu `mr` là dữ liệu cũ `contract_id IS NULL` và chưa bị hợp đồng khác tiêu thụ -> Hợp lệ cho `c` (tương thích ngược 100%).
     - Nếu `mr` thuộc Hợp đồng A (`mr.contract_id = A.id` hoặc đã lên hóa đơn của A), thì khi xét Hợp đồng B (`c.id = B.id`), hệ thống thấy Hợp đồng B **chưa có** bản ghi `CONFIRMED` của riêng mình -> chặn sinh hóa đơn B với `MISSING_CONFIRMED_METER_READING` cho tới khi Quản lý chốt chỉ số của B!

2. **Truy vấn bản ghi tính dòng Điện / Nước (`dòng 386–449`)**:
   - Với mỗi công tơ `ACTIVE` của `c.apartment_id`, chọn tối đa 1 bản ghi `CONFIRMED` trong `targetPeriod` khớp với `c.id` theo thứ tự ưu tiên:
     1. `mr.contract_id = c.id`
     2. `mr.contract_id IS NULL` chưa được tham chiếu bởi hóa đơn hiệu lực của hợp đồng khác trong cùng kỳ.
   - Bỏ đoạn `alreadyBilledRes` chặn chéo giữa các hợp đồng khác nhau; chỉ chặn nếu chính bản ghi `mr.id` đó đã được lập trên một hóa đơn hiệu lực khác (`status NOT IN ('VOID', 'CANCELLED')` và `i2.contract_id <> c.id`).
   - Giữ nguyên logic tính giá bậc ưu tiên `resolveUtilityUnitPrice` theo `c.id` (`CONTRACT_OVERRIDE` -> `BUILDING_CATALOG` -> `METER_CONFIG` -> `DEFAULT_CATALOG`) và lưu `reading_id: mr.id`, `contract_id: c.id` trong `formula_meta`.

---

### 5.5. Điều kiện Tất toán Tiền cọc (`api/src/routes/deposits.js` — `checkSettlementPreconditions`)

1. **`missingMeterTypes` (dòng 253–267)**:
   - Kiểm tra mỗi công tơ `ACTIVE` (`m.created_at::date <= endRefStr::date`) phải có bản ghi `CONFIRMED` ở `mr.period = endPeriod` thuộc về `contractRow.contract_id` (hoặc `mr.contract_id IS NULL` chưa bị hợp đồng khác tiêu thụ trong `endPeriod`, hoặc có bản ghi `CONFIRMED` ở `mr.period > endPeriod` nếu chốt muộn sang đầu kỳ sau khi không có hợp đồng mới xen vào).
   - Nhờ đó, nếu Hợp đồng A đã chốt `2026-12` (`contract_id = A.id`), Hợp đồng B kết thúc ngày `28/12` sẽ **không** thể dùng ké chỉ số của Hợp đồng A để lách cổng `MISSING_FINAL_METER_READING`.

2. **`unbilledMeterTypes` (dòng 270–286)**:
   - Chỉ xét bản ghi `mr` (`mr.period = endPeriod AND mr.status = 'CONFIRMED'`) của chính `contractRow.contract_id` (hoặc `mr.contract_id IS NULL` tương ứng chưa thuộc/chưa lên hóa đơn của hợp đồng khác trong cùng kỳ) có `COALESCE(mr.consumption, mr.current_reading - mr.previous_reading, 0) > 0`.
   - Giữ nguyên kiểm tra ở **cấp header hóa đơn** (`NOT EXISTS (SELECT 1 FROM invoice inv WHERE inv.contract_id = $4 AND inv.period >= $3 AND inv.status NOT IN ('DRAFT', 'CANCELLED', 'VOID'))`) để bảo toàn 100% tương thích với luồng `allow_missing_meter_readings` và bộ test hiện hữu (`fullWebsiteWhiteBlackBox.test.js`).

---

### 5.6. Các Truy vấn Phụ trợ & Giao diện (`apartments.js`, `resident.js`, `aiGateway.js`, `MeterReadingsPage.jsx`)

1. **`api/src/routes/apartments.js` (dòng 226–229)**:
   - Đổi `ORDER BY mr.period DESC LIMIT 1` thành `ORDER BY mr.period DESC, mr.current_reading DESC, mr.recorded_at DESC LIMIT 1` để chi tiết căn hộ luôn hiển thị chỉ số mới nhất thực sự trong tháng có 2 đợt chốt.

2. **`api/src/services/aiGateway.js` (AI OCR công tơ, dòng 396–414)**:
   - Khi đọc ảnh OCR công tơ kỳ `period`, lấy `previousValue` từ bản ghi gần nhất đứng trước lượt ghi hiện tại (bao gồm cả bản ghi đã khóa của khách cũ trong cùng kỳ `period`, sắp xếp `period DESC, current_reading DESC, recorded_at DESC`), giúp hậu kiểm AI (`reading >= previousValue`) hoạt động chính xác cho đợt 2 trong tháng!

3. **`api/src/routes/resident.js` (dòng 1466–1491)**:
   - Trong `LEFT JOIN LATERAL` lấy ảnh đồng hồ cho dòng hóa đơn của cư dân: ưu tiên 1 là `mr.id = (il.formula_meta->>'reading_id')::uuid`; ưu tiên 2 là `mr.contract_id = inv.contract_id`; ưu tiên 3 mới đến fallback legacy `mr.contract_id IS NULL`. Đảm bảo Cư dân A và Cư dân B mỗi người luôn thấy đúng ảnh công tơ của hóa đơn mình.

4. **`GET /api/v1/meters`, `GET /api/v1/meters/:id/readings` & `MeterReadingsPage.jsx`**:
   - `GET /api/v1/meters` trả về cho mỗi đồng hồ các trường ngữ cảnh của lượt chốt đang mở:
     - `target_contract_id`, `target_contract_code`, `target_tenant_name`
     - `period_slot_index` (`1`, `2`, ...) & `period_total_slots` (số hợp đồng giao thoa trong kỳ)
     - `period_reading_billed` (`true` nếu dòng đang hiển thị đã lên hóa đơn phát hành -> khóa ô nhập trên bảng)
     - `overlapping_contracts`: mảng tóm tắt các hợp đồng giao thoa kỳ `[{ contract_id, contract_code, tenant_name, status, overlap_start, overlap_end, reading_id, current_reading, previous_reading, reading_status, is_billed }]`
     - Các trường hiện tại (`period_reading_id`, `period_previous_reading`, `period_current_reading`, `last_known_reading`, `effective_unit_price`...) được tính đúng theo `target_contract_id` để toàn bộ công thức client có sẵn trên `MeterReadingsPage.jsx` chạy trơn tru không cần đổi cấu trúc bảng!
   - Trên `MeterReadingsPage.jsx`:
     - Cột **Căn hộ / Công tơ**: Hiển thị thêm nhãn nhỏ gọn mã hợp đồng/khách đang áp dụng; nếu `period_total_slots > 1` hoặc `period_slot_index > 1`, hiển thị badge nổi bật nhẹ (VD: `Đợt 2 • HĐ {code}`) để Quản lý nhận biết ngay căn này có đổi khách trong tháng và chỉ số cũ đang nối tiếp từ đợt 1.
     - Cột **Chỉ số mới**: Nếu `period_reading_billed === true`, disable ô input và hiển thị trạng thái `Đã lập HĐ` để tránh sửa nhầm; các dòng đã khóa không bị đưa vào `dirtyValidRows` khi bấm Lưu hàng loạt.
     - Modal **Chi tiết công tơ**:
       - Nếu `overlapping_contracts.length > 1`, hiển thị `Select` **Đợt hợp đồng trong kỳ** để Quản lý có thể xem hoặc ghi nhận chỉ số cho từng hợp đồng cụ thể trong tháng.
       - Bảng **Lịch sử ghi chỉ số** hiển thị thêm mã hợp đồng (`contract_code`) bên dưới cột `Kỳ` (VD: `2026-12` + nhãn `HĐ-001` / `HĐ-002`), sắp xếp theo `period DESC, current_reading DESC, recorded_at DESC`.

---

## 6. Phần để lại cho Builder khi Lập kế hoạch & Thi công (Left to the Builder)

- Tên hàm nội bộ và cấu trúc tách file helper giữa `api/src/services/serviceBilling.js` và `api/src/routes/meters.js`.
- Chi tiết SQL tối ưu hóa batch enrichment trong `GET /api/v1/meters` (tránh N+1 query khi tải danh sách công tơ cả tòa nhà).
- Cách trình bày badge Tailwind chi tiết trên `MeterReadingsPage.jsx` tuân thủ hệ thống component sẵn có (`Badge`, `Select`, `Input`).
- Bộ test tích hợp đầy đủ (`api/test/midMonthTenantTurnoverMeterBilling.test.js`) kiểm chứng trọn vẹn kịch bản `30/11 (1000) -> 15/12 Khách cũ trả phòng (1100) -> phát hành HĐ Khách cũ -> 20/12 Khách mới vào -> 31/12 chốt (1185) -> phát hành HĐ Khách mới -> 2027-01 nối tiếp từ 1185`, chặn ghi đè `409 READING_ALREADY_BILLED`, kiểm tra RLS Cư dân A/B, và điều kiện tất toán cọc từng hợp đồng.

