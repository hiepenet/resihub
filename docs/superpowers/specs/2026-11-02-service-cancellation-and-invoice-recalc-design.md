# Thiết kế Hủy Dịch vụ (`TERMINATED`), Tính Phí Pro-rata, Xử lý Hóa đơn 3 Kịch bản (Phê duyệt 4 Mắt) & Sổ Tạm giữ `credit_balance`

**Ngày:** 2026-11-02  
**Quy mô:** Dự án liên phân hệ (Migration CSDL `044` + Engine tính phí 3 tầng & đồng bộ hóa đơn 3 kịch bản + Phê duyệt 4 mắt điều chỉnh/hủy hóa đơn sau phát hành + Đóng tự động theo vòng đời Hợp đồng + Tích hợp `credit_balance` & Quyết toán cuối kỳ + Giao diện Quản trị & Cư dân)  
**Tài liệu tham chiếu chuẩn:** `PRD - Quan ly Can ho va Nha cho thue v2.0.md` (`FR-006`, `FR-029`, `FR-033`, `FR-034`, `FR-035`, `FR-040`, `FR-065`, `FR-066`, `FR-068`, `AC-003.2`, `AC-015.3`, `AC-017.3`, `AC-020.1`, Mục `6.1`, `7.5`, `10.3`, `13.2`, `13.3`, `14.3`, `15.3`, `NFR-016`)

---

## 1. Mục đích & Lý do (Intent & Why)

Hệ thống hiện đang tồn tại các bất cập nghiệp vụ liên kết chặt chẽ với nhau trong vòng đời đăng ký dịch vụ (`service_subscription`), hóa đơn định kỳ (`invoice`), sổ số dư tạm giữ (`credit_balance`) và quyết toán cuối kỳ (`deposit`):

1. **Đặt cọc / kích hoạt hợp đồng trước ngày nhận phòng (`today < start_date`) nhưng muốn hủy dịch vụ (hoặc thanh lý hợp đồng sớm):**
   - Khi kích hoạt hợp đồng (`runActivationSideEffects` trong `api/src/routes/contracts.js`), các gói dịch vụ đi kèm được chuyển sang `ACTIVE` dù `start_date` nằm ở tương lai.
   - Trên giao diện Cư dân (`ServicesTab.jsx`) và Quản lý (`SubscriptionsPage.jsx`), ô chọn `end_date` khi hủy đang bị khóa tối thiểu `end_date >= max(today, start_date)`. Đồng thời hàm `computeProrata(..., 'cancel')` tại Backend đang lấy `end_date.getDate()` (tính từ mùng 1 đầu tháng), khiến dịch vụ **chưa sử dụng ngày nào** vẫn bị tính phí Pro-rata thay vì `0 ₫`.
   - Khi hợp đồng chấm dứt sớm (`terminate`, `terminate/approve`, `requests/:id/approve`, `transfer-room`) hoặc hết hạn tự nhiên (`daily.js`), các bản ghi `service_subscription` đang mở vẫn bị bỏ sót ở trạng thái `ACTIVE`.

2. **Hủy dịch vụ giữa kỳ sau nhiều tháng sử dụng (ví dụ dùng 5 tháng, hủy giữa tháng thứ 6) — Hóa đơn chưa đồng bộ theo 3 kịch bản PRD & lịch sử kỳ trước dễ bị rơi:**
   - Khi Quản lý xác nhận hủy dịch vụ (`PATCH /api/v1/service-subscriptions/:id`), hệ thống hiện chỉ cập nhật `service_subscription.prorata_amount` mà **không xử lý hóa đơn kỳ hiện tại** theo 3 kịch bản của PRD (`chưa sinh hóa đơn`, `DRAFT`, `đã phát hành`), cũng chưa ghi `audit_log` giá trị trước/sau.
   - Khi sinh hóa đơn (`generateInvoicesCore` trong `api/src/routes/invoices.js`) và dựng lịch dự kiến (`buildExpectedInvoiceSchedule` trong `api/src/services/invoiceSchedule.js`):
     - Đang loại bỏ các gói `CANCELLATION_PENDING` (làm hóa đơn sinh trước lúc Quản lý duyệt hủy bị rơi mất phí thành `0 ₫`), hoặc loại bỏ các gói đã hủy ở các kỳ quá khứ (làm bảng lịch dự kiến và việc sinh bù hóa đơn các tháng `1..5` bị mất phí khi hủy ở tháng thứ `6`).
     - Gói đăng ký giữa tháng và hủy ngay trong cùng tháng (ví dụ `10/11` → `20/11`) đang tính nhầm từ `01/11` (`20` ngày) thay vì khoảng giao thực tế `[10/11 .. 20/11]` (`11` ngày).
   - Các lỗ hổng tuân thủ PRD cần đóng đồng bộ trong cùng thiết kế:
     - Tên mã trạng thái vật lý trong CSDL đang dùng `CANCELLED` thay vì chuẩn PRD Mục `13.2` (`service_subscription.status = 'TERMINATED'`, `invoice.status` gồm `'ADJUSTED'` và `'VOID'`).
     - Rò rỉ hóa đơn `DRAFT` sang Cư dân ở RLS (`rls_invoice_select`, `rls_invoice_modify`), `GET /api/v1/invoices/:id`, `POST /api/v1/resident/payments/report` và `GET /api/v1/contracts/:id` (vi phạm `AC-003.2`).
     - Hóa đơn sau phát hành (`ISSUED` trở đi) đang cho sửa/xóa dòng `ADJUSTMENT` trực tiếp qua `PATCH /api/v1/invoices/:id/status` mà không có bước phê duyệt 4 mắt (`FR-034`, `FR-035`, `NFR-016`).
     - Chưa có bảng vật lý `credit_balance` (`Mục 13.2`, `FR-040`) để lưu khoản nộp thừa (từ thanh toán dư hoặc sau khi duyệt giảm phí trên hóa đơn đã đóng tiền), tự động bù trừ vào hóa đơn kỳ kế tiếp (`FR-033`) mà không làm giảm kép doanh thu báo cáo, và tách bạch với tiền cọc gốc khi quyết toán cuối kỳ (`FR-068`).

---

## 2. Mục tiêu & Giới hạn (Goals, Non-Goals, Anti-Goals)

### 2.1. Mục tiêu (Goals)
1. **Chuẩn hóa mã trạng thái CSDL theo đúng PRD Mục 13.2 (Quyết định 2 = Phương án B):**
   - `service_subscription.status`: chuyển `'CANCELLED'` → **`'TERMINATED'`** (`'PENDING_APPROVAL'`, `'ACTIVE'`, `'CANCELLATION_PENDING'`, `'TERMINATED'`, `'REJECTED'`).
   - `invoice.status`: chuyển `'CANCELLED'` → **`'VOID'`** và bổ sung **`'ADJUSTED'`** (`'DRAFT'`, `'ISSUED'`, `'PARTIALLY_PAID'`, `'PAID'`, `'OVERDUE'`, `'ADJUSTED'`, `'VOID'`).
2. **Hủy dịch vụ trước ngày bắt đầu sử dụng (`0 ₫`) & Đóng tự động theo vòng đời hợp đồng:**
   - Mở khóa hủy dịch vụ khi `today < start_date` (hoặc rút yêu cầu `PENDING_APPROVAL`) với `0` ngày sử dụng (`0 ₫`).
   - Tự động chuyển các `service_subscription` chưa kết thúc sang `'TERMINATED'` trên toàn bộ 6 luồng đóng/hết hạn hợp đồng (`cancel`, `terminate`, `terminate/approve`, `requests/:id/approve`, `transfer-room`, `daily.js` Bước 1a & 1b).
3. **Chuẩn hóa công thức Pro-rata, thứ tự ưu tiên đơn giá 3 tầng (`FR-065`), làm tròn `ROUND(x, -3)` & bảo toàn 100% các kỳ trước:**
   - Tính phí trên khoảng giao thực tế `[max(start_date, periodStart) .. min(end_date, periodEnd)]`.
   - Áp dụng thứ tự ưu tiên đơn giá **Giá hợp đồng (`contract_service_price`) → Giá tòa (`service_catalog` có `building_id`) → Giá mặc định tổ chức (`service_catalog` có `building_id IS NULL`)**; riêng các kỳ hóa đơn **đã phát hành** luôn khóa theo `unit_price` đã áp trên `invoice_line` của kỳ đó (`FR-065`).
   - Làm tròn `ROUND(x, -3)` (`roundVND`) đồng nhất cả Backend và Frontend; lưu công thức & tham chiếu vào `invoice_line` (`subscription_id`, `credit_id`, `formula_meta JSONB` + mô tả tường minh theo `AC-015.3`, `Mục 13.2`).
   - Hủy dịch vụ ở giữa tháng thứ `N` giữ nguyên **100%** dữ liệu và số tiền của các tháng `1 .. N-1`.
4. **Xử lý hóa đơn chuẩn xác theo 3 kịch bản PRD & Duyệt 4 mắt sau phát hành (Quyết định 1 = Phương án A):**
   - **Kịch bản 1 (Chưa sinh hóa đơn kỳ hủy — trước `billing_day`):** Khi tới `billing_day` (hoặc chạy tay), `generateInvoicesCore` tự tính Pro-rata cho các ngày hiệu lực trong kỳ (hoặc `0 ₫` nếu hủy trước ngày bắt đầu), tạo hóa đơn `DRAFT`; các kỳ kế tiếp bỏ qua gói đã `TERMINATED`.
   - **Kịch bản 2 (Hóa đơn kỳ hiện tại đang `DRAFT`):** Khóa tuyệt đối không cho `RESIDENT` nhìn thấy hay báo thanh toán trên bản `DRAFT` (`AC-003.2`); cho phép sửa trực tiếp dòng phí trên bản `DRAFT` (tự động cập nhật khi Quản lý xác nhận `TERMINATED` dịch vụ + API sửa dòng nháp cho vận hành rà soát theo `FR-033`, `FR-034`) kèm ghi nhận bắt buộc `audit_log` giá trị `before`/`after` (`AC-020.1`).
   - **Kịch bản 3 (Hóa đơn kỳ hiện tại đã phát hành — `ISSUED` / `PARTIALLY_PAID` / `PAID` / `OVERDUE` / `ADJUSTED`):** Khóa bất biến không sửa/xóa trực tiếp (`FR-034`, `NFR-016`); mọi nghiệp vụ điều chỉnh giảm/tăng hoặc hủy hóa đơn (`VOID`) sau phát hành đều tạo bản ghi đề nghị `invoice_adjustment` (`PENDING_APPROVAL`) có lý do bắt buộc và **bắt buộc phê duyệt 4 mắt (`người lập ≠ người duyệt` qua `checkFourEyesOrWarn`)** trước khi ghi nhận dòng `ADJUSTMENT` mới, chuyển trạng thái `ADJUSTED` / `VOID`, đồng bộ `receivable` và kết chuyển tiền thừa (nếu có) vào `credit_balance`.
5. **Sổ số dư tạm giữ `credit_balance` & Tách bạch tuyệt đối với Tiền cọc (`FR-033`, `FR-040`, `FR-068`, `RP-07`):**
   - Lưu mọi khoản cư dân nộp thừa (do thanh toán vượt hoặc do hóa đơn đã đóng tiền được duyệt điều chỉnh giảm) vào bảng `credit_balance`, đồng thời giữ chuẩn toàn vẹn `invoice.paid_amount <= invoice.total_amount` (`Mục 13.3`).
   - Kỳ tiếp theo (khi chưa trả phòng): tự động bù trừ `credit_balance` khi sinh hóa đơn `DRAFT` (`FR-033`), lưu `invoice.credit_offset_amount` để báo cáo doanh thu (`reports.js`) không bị trừ đúp doanh thu kỳ sau, và hoàn lại hạn mức `credit_balance` nếu hóa đơn chưa thu tiền đó bị `VOID`.
   - Kỳ cuối / chấm dứt hợp đồng: đối trừ `credit_balance` vào công nợ mở trước, phần dư còn lại hoàn trả thành khoản mục riêng cạnh quyết toán cọc (**tuyệt đối không ghi trộn vào `deposit_transaction` tiền cọc gốc và không bao giờ dùng tiền cọc gốc cấn trừ tiền thuê `RENT` theo `FR-068`**).

### 2.2. Không nằm trong phạm vi (Non-Goals)
- Không tự động lập điều chỉnh lùi vào hóa đơn đã `ISSUED` / `PAID` khi cư dân **đăng ký mới** một dịch vụ giữa kỳ sau khi hóa đơn kỳ đó đã phát hành (các kỳ chưa sinh hóa đơn hoặc đang `DRAFT` vẫn tính Pro-rata đầu vào bình thường).
- Không tự động sửa hoặc sinh đề nghị điều chỉnh dòng tiền thuê phòng (`RENT`) hay điện/nước (`METERED`) trên các hóa đơn **đã được tạo sẵn từ trước** khi hợp đồng thanh lý sớm giữa kỳ hoặc chuyển phòng (cơ chế tự động tính lại trong tài liệu này chỉ tác động lên dòng phí dịch vụ `service_subscription`; nếu cần điều chỉnh tiền thuê của hóa đơn đã tạo, vận hành sửa trực tiếp dòng `RENT` khi hóa đơn còn `DRAFT` ở Kịch bản 2 hoặc lập đề nghị `ADJUST` / `VOID` duyệt 4 mắt qua `POST /api/v1/invoices/:id/adjust` ở Kịch bản 3). *(Các kỳ chưa sinh hóa đơn vẫn tính `RENT` Pro-rata tự động như hiện hành tại `generateInvoicesCore`).*
- Không tích hợp cổng chi hoàn tiền tự động qua ngân hàng.
- Không thay đổi mô hình 4 vai trò hiện hành của hệ thống (`SYS_ADMIN`, `OWNER`, `MANAGER`, `RESIDENT` theo `036_simplify_roles.sql`) — trong đó `MANAGER` thực hiện tác nghiệp kế toán/vận hành trên tòa được gán và cơ chế phê duyệt 4 mắt (`APPROVER`) được thực thi chéo giữa các `MANAGER` của tòa / `SYS_ADMIN` thông qua `checkFourEyesOrWarn`.

### 2.3. Điều cần tránh (Anti-Goals)
- **Tuyệt đối không UPDATE hoặc DELETE dòng `invoice_line` cũ trên bất kỳ hóa đơn nào đã rời trạng thái `DRAFT`** (`FR-034`, `NFR-016`) — mọi điều chỉnh sau phát hành chỉ được phép ghi thêm dòng `ADJUSTMENT` mới sau khi đã qua phê duyệt 4 mắt.
- **Không vi phạm `paid_amount <= total_amount`** trên `invoice` (`Mục 13.3`) và **không vi phạm `receivable.amount > 0`** trên `receivable` (`026_invoices_payments.sql`).
- **Không trừ đúp doanh thu báo cáo** giữa kỳ điều chỉnh hóa đơn cũ và kỳ áp dụng `credit_balance` tiếp theo.
- **Không ghi trộn hoàn trả `credit_balance` vào giao dịch gốc của sổ cọc (`deposit_transaction`)** để không làm lệch báo cáo sổ cái tiền cọc (`RP-07`) và không vi phạm `FR-068`.
- **Không đổi tên `'CANCELLED'` của các thực thể khác** (`contract`, `service_request`, `reservation`, `announcement`) vốn vẫn dùng `'CANCELLED'` theo đúng PRD Mục `13.2`.

---

## 3. Ràng buộc kỹ thuật & Nghiệp vụ (Constraints)

1. **PostgreSQL 16 & Row-Level Security (RLS):**
   - Các bảng mới (`invoice_adjustment`, `credit_balance`) bắt buộc bật `ENABLE ROW LEVEL SECURITY`, `FORCE ROW LEVEL SECURITY` và `GRANT ALL PRIVILEGES ... TO resihub_app`.
   - Phân quyền RLS chuẩn 4 vai trò:
     - `SYS_ADMIN` (`is_org_admin()`): toàn quyền trong tổ chức.
     - `OWNER`: **100% Read-Only** trên các tòa sở hữu (`get_user_assigned_buildings()`), bao gồm quyền đọc `audit_log` của `service_subscription`, `invoice_adjustment`, `credit_balance`.
     - `MANAGER`: đọc/ghi trên các tòa được phân công (`get_manager_building_ids()`).
     - `RESIDENT`: chỉ đọc dữ liệu gắn với hợp đồng của mình (`get_resident_contract_ids()`), và **tuyệt đối không đọc được hóa đơn `DRAFT`** (`status <> 'DRAFT'` ngay ở tầng RLS `rls_invoice_select`).
2. **Quy ước biểu diễn ngày `start_date` / `end_date` trên `service_subscription`:**
   - `end_date < start_date` (cụ thể `end_date = start_date - 1 day` khi hủy trước ngày bắt đầu sử dụng hoặc thu hồi yêu cầu `PENDING_APPROVAL`): biểu diễn **0 ngày sử dụng (`0 ₫`)**, phân biệt rạch ròi với `end_date === start_date` (**1 ngày sử dụng**).
   - `status = 'TERMINATED'` mà `end_date IS NULL` (dữ liệu lịch sử cũ): luôn coi là **0 ngày sử dụng (`0 ₫`)**.
   - `end_date >= start_date` (với `status = 'TERMINATED'`): khoảng ngày sử dụng thực tế tính gộp hai đầu `[start_date .. end_date]`.
3. **Bất biến tài chính & Bảo toàn phương trình kế toán:**
   - Trên bảng `invoice`: luôn duy trì `0 <= paid_amount <= total_amount`. Khi khách chuyển khoản vượt `remaining_amount` hoặc khi hóa đơn đã thu tiền được duyệt điều chỉnh giảm làm `oldPaid > nextTotal`, phần vượt `oldPaid - nextTotal` được chuyển sang `credit_balance` và `invoice.paid_amount` được kẹp về `nextTotal`.
   - Trên bảng `invoice`: bổ sung cột `credit_offset_amount BIGINT NOT NULL DEFAULT 0 CHECK (credit_offset_amount >= 0)` ghi nhận tổng số tiền `credit_balance` kỳ trước đã cấn trừ vào hóa đơn này. Nhờ đó:
     - Số tiền khách thực tế cần thanh toán thêm cho hóa đơn = `total_amount - paid_amount` (khớp 100% với QR thanh toán, `receivable.amount` và công nợ mở).
     - Doanh thu phát sinh thực tế của kỳ trên báo cáo (`RP-01`, `Dashboard`) = `total_amount + credit_offset_amount` (trên các hóa đơn `status NOT IN ('DRAFT', 'VOID')`), bảo đảm **không bao giờ bị giảm trừ hai lần**!

---

## 4. Các phương án đã cân nhắc (Approaches)

### 4.1. Kiến trúc tổng thể (Đã chốt: Phương án 1)
1. **Phương án 1 — Tự động hóa khép kín chuẩn PRD từ Hủy trước hạn, Xử lý Hóa đơn 3 Kịch bản (có Duyệt 4 Mắt ở Kịch bản 3) đến Sổ `credit_balance` & Quyết toán cuối kỳ *(Đã chọn)*:**
   - Chuẩn hóa công thức giao khoảng thời gian, mở khóa hủy `0 ₫` trước `start_date`, xử lý trọn vẹn 3 kịch bản hóa đơn (`chưa sinh`, `DRAFT` sửa trực tiếp có `audit_log`, sau `ISSUED` tạo đề nghị `invoice_adjustment` duyệt 4 mắt), lưu tiền dư vào `credit_balance` để bù trừ tự động kỳ kế tiếp hoặc hoàn trả tách biệt khi kết thúc hợp đồng.
   - *Ưu điểm:* Bám sát 100% đặc tả PRD v2.0, bất biến chứng từ sau phát hành, bảo toàn tuyệt đối các tháng quá khứ `1..N-1` và khớp từng đồng trên cả báo cáo doanh thu lẫn sổ cái tiền cọc.
2. **Phương án 2 — Bán tự động (chỉ sửa `DRAFT`, chặn/bắt tính tay sau phát hành):** Dễ sót khoản bù trừ của cư dân khi sang tháng mới hoặc khi tất toán cuối kỳ.
3. **Phương án 3 — Chỉ cho hủy dịch vụ từ đầu kỳ kế tiếp:** Trái với `FR-029` (yêu cầu tính Pro-rata theo số ngày thực tế khi hủy giữa kỳ).

### 4.2. Hai quyết định chuẩn hóa PRD do Chủ dự án chốt trực tiếp
- **Cơ chế duyệt 4 mắt ở Kịch bản 3 (Hóa đơn đã phát hành):** **Chọn Phương án A** — Mọi điều chỉnh/hủy hóa đơn sau khi `ISSUED` (kể cả điều chỉnh sinh ra từ nghiệp vụ hủy dịch vụ giữa kỳ lẫn điều chỉnh/hủy hóa đơn thủ công qua `/invoices/:id/adjust`) đều tạo bản ghi chờ duyệt `PENDING_APPROVAL` và bắt buộc người thứ hai (`MANAGER` khác cùng tòa hoặc `SYS_ADMIN`, kiểm tra qua `checkFourEyesOrWarn`) phê duyệt mới áp vào hóa đơn và sinh `credit_balance`.
- **Tên mã trạng thái vật lý trong CSDL:** **Chọn Phương án B** — Cập nhật migration CSDL và toàn bộ mã nguồn sang đúng chuẩn PRD Mục `13.2`: `service_subscription.status` dùng `'TERMINATED'`; `invoice.status` dùng `'ADJUSTED'` và `'VOID'`.

---

## 5. Chi tiết thiết kế kỹ thuật

### 5.1. Migration Cơ sở dữ liệu (`api/src/db/migrations/044_service_termination_invoice_adjustments_and_credit_balance.sql`)

1. **Chuẩn hóa bảng giá dịch vụ 3 tầng trên `service_catalog` (`FR-065`):**
   - Gỡ ràng buộc cũ `ALTER TABLE service_catalog DROP CONSTRAINT IF EXISTS service_catalog_org_id_code_key;` (vốn chặn tạo giá riêng theo từng tòa cùng mã `code`), thay bằng bộ Partial Unique Index chuẩn:
     - `CREATE UNIQUE INDEX IF NOT EXISTS idx_service_catalog_org_default_code ON service_catalog(org_id, code) WHERE building_id IS NULL;` (1 giá mặc định toàn tổ chức cho mỗi mã dịch vụ).
     - `CREATE UNIQUE INDEX IF NOT EXISTS idx_service_catalog_building_code ON service_catalog(org_id, building_id, code) WHERE building_id IS NOT NULL;` (mỗi tòa có thể cấu hình 1 giá ghi đè riêng cho mã dịch vụ đó).

2. **Chuẩn hóa mã trạng thái `service_subscription.status` → `'TERMINATED'` (`Mục 13.2`):**
   - `ALTER TABLE service_subscription DROP CONSTRAINT IF EXISTS service_subscription_status_check;`
   - `UPDATE service_subscription SET status = 'TERMINATED' WHERE status = 'CANCELLED';`
   - `ALTER TABLE service_subscription ADD CONSTRAINT service_subscription_status_check CHECK (status IN ('PENDING_APPROVAL', 'ACTIVE', 'CANCELLATION_PENDING', 'TERMINATED', 'REJECTED'));`
   - Cập nhật RLS `rls_service_sub_delete` (`042_idempotency_and_draft_services_rls.sql`): đổi `'CANCELLED'` thành `'TERMINATED'`.

3. **Chuẩn hóa mã trạng thái `invoice.status` → `'ADJUSTED'`, `'VOID'` & Ràng buộc toàn vẹn (`Mục 13.2`, `Mục 13.3`, `AC-003.2`):**
   - Bổ sung cột `credit_offset_amount BIGINT NOT NULL DEFAULT 0 CHECK (credit_offset_amount >= 0)` trên bảng `invoice`.
   - Chuẩn hóa dữ liệu cũ (nếu có dòng `paid_amount > total_amount` lịch sử từ thanh toán thừa trước đây): `UPDATE invoice SET paid_amount = LEAST(GREATEST(0, paid_amount), GREATEST(0, total_amount)) WHERE paid_amount > total_amount OR paid_amount < 0;`.
   - Thêm ràng buộc toàn vẹn `invoice_paid_lte_total_check CHECK (paid_amount >= 0 AND total_amount >= 0 AND paid_amount <= total_amount)` (`Mục 13.3`).
   - `ALTER TABLE invoice DROP CONSTRAINT IF EXISTS invoice_status_check;`
   - `UPDATE invoice SET status = 'VOID' WHERE status = 'CANCELLED';`
   - `ALTER TABLE invoice ADD CONSTRAINT invoice_status_check CHECK (status IN ('DRAFT', 'ISSUED', 'PARTIALLY_PAID', 'PAID', 'OVERDUE', 'ADJUSTED', 'VOID'));`
   - **Khóa rò rỉ `DRAFT` đối với `RESIDENT` (`AC-003.2`):**
     - Cập nhật `rls_invoice_select`: nhánh cư dân bắt buộc có `status <> 'DRAFT'`:
       ```sql
       CREATE POLICY rls_invoice_select ON invoice FOR SELECT USING (
         is_org_admin()
         OR building_id IN (SELECT building_id FROM get_user_assigned_buildings())
         OR (
           status <> 'DRAFT'
           AND (
             contract_id IN (SELECT contract_id FROM get_resident_contract_ids())
             OR tenant_id IN (SELECT tenant_id FROM get_resident_tenant_ids())
           )
         )
       );
       ```
     - Cập nhật `rls_invoice_modify`: gỡ nhánh `is_resident()` (cư dân chỉ tạo `payment` qua `rls_payment_insert`, tuyệt đối không sửa bảng `invoice`).

4. **Bổ sung cột tham chiếu & công thức giải trình trên `invoice_line` (`AC-015.3`, `Mục 13.2`):**
   - `subscription_id UUID REFERENCES service_subscription(id) ON DELETE SET NULL`
   - `credit_id UUID` (gắn FK tới `credit_balance(id) ON DELETE SET NULL`)
   - `adjustment_id UUID` (gắn FK tới `invoice_adjustment(id) ON DELETE SET NULL`)
   - `formula_meta JSONB` (lưu chi tiết công thức tính để giải trình trên UI/PDF: `{ billing_mode, price_source, unit_price, quantity, active_days, days_in_month, overlap_start, overlap_end, raw_amount, rounded_amount }`)

5. **Tạo bảng `invoice_adjustment` (Phê duyệt 4 mắt cho điều chỉnh / hủy hóa đơn sau phát hành — `FR-034`, `FR-035`):**
   ```sql
   CREATE TABLE IF NOT EXISTS invoice_adjustment (
     id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     org_id           UUID NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
     building_id      UUID NOT NULL REFERENCES building(id) ON DELETE CASCADE,
     invoice_id       UUID NOT NULL REFERENCES invoice(id) ON DELETE CASCADE,
     subscription_id  UUID REFERENCES service_subscription(id) ON DELETE SET NULL,
     action_type      TEXT NOT NULL CHECK (action_type IN ('ADJUST', 'VOID')),
     delta_amount     BIGINT NOT NULL DEFAULT 0,
     reason           TEXT NOT NULL,
     formula_meta     JSONB,
     status           TEXT NOT NULL DEFAULT 'PENDING_APPROVAL'
                      CHECK (status IN ('PENDING_APPROVAL', 'APPROVED', 'REJECTED')),
     rejection_reason TEXT,
     created_by       UUID REFERENCES app_user(id) ON DELETE SET NULL,
     approved_by      UUID REFERENCES app_user(id) ON DELETE SET NULL,
     approved_at      TIMESTAMPTZ,
     created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CHECK (
       (action_type = 'VOID' AND delta_amount = 0)
       OR (action_type = 'ADJUST' AND delta_amount <> 0)
     )
   );
   ```
   - Partial Unique Index chống sinh trùng đề nghị đang chờ duyệt:
     - `idx_invoice_adj_pending_sub ON invoice_adjustment(invoice_id, subscription_id) WHERE subscription_id IS NOT NULL AND status = 'PENDING_APPROVAL'`
     - `idx_invoice_adj_pending_void ON invoice_adjustment(invoice_id) WHERE action_type = 'VOID' AND status = 'PENDING_APPROVAL'`
   - Bật RLS (`ENABLE` + `FORCE`) & `GRANT ALL PRIVILEGES`: `SYS_ADMIN` toàn quyền; `OWNER` chỉ đọc theo tòa sở hữu; `MANAGER` đọc/ghi theo tòa quản lý; `RESIDENT` chỉ đọc các bản ghi `status = 'APPROVED'` thuộc hóa đơn không nháp của mình.

6. **Tạo bảng `credit_balance` (Sổ số dư tạm giữ hợp đồng — `Mục 13.2`, `FR-033`, `FR-040`):**
   ```sql
   CREATE TABLE IF NOT EXISTS credit_balance (
     id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     org_id                UUID NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
     building_id           UUID NOT NULL REFERENCES building(id) ON DELETE CASCADE,
     contract_id           UUID NOT NULL REFERENCES contract(id) ON DELETE CASCADE,
     tenant_id             UUID REFERENCES tenant(id) ON DELETE SET NULL,
     subscription_id       UUID REFERENCES service_subscription(id) ON DELETE SET NULL,
     source_invoice_id     UUID REFERENCES invoice(id) ON DELETE SET NULL,
     source_adjustment_id  UUID REFERENCES invoice_adjustment(id) ON DELETE SET NULL,
     source_payment_id     UUID REFERENCES payment(id) ON DELETE SET NULL,
     settlement_deposit_id UUID REFERENCES deposit(id) ON DELETE SET NULL,
     reason_type           TEXT NOT NULL CHECK (reason_type IN ('SERVICE_TERMINATION', 'INVOICE_ADJUSTMENT', 'OVERPAYMENT', 'TRANSFERRED_IN')),
     amount                BIGINT NOT NULL CHECK (amount > 0),
     applied_amount        BIGINT NOT NULL DEFAULT 0 CHECK (applied_amount >= 0 AND applied_amount <= amount),
     status                TEXT NOT NULL DEFAULT 'AVAILABLE'
                           CHECK (status IN ('AVAILABLE', 'PARTIALLY_APPLIED', 'APPLIED', 'REFUNDED_IN_SETTLEMENT', 'TRANSFERRED', 'VOID')),
     description           TEXT NOT NULL,
     created_by            UUID REFERENCES app_user(id) ON DELETE SET NULL,
     created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
   );
   ```
   - Partial Unique Index chống nhân đôi tuyệt đối (Idempotency ở tầng DB):
     - `idx_credit_balance_unique_adj ON credit_balance(source_adjustment_id) WHERE source_adjustment_id IS NOT NULL AND status <> 'VOID'`
     - `idx_credit_balance_unique_payment ON credit_balance(source_payment_id) WHERE source_payment_id IS NOT NULL AND status <> 'VOID'`
     - `idx_credit_balance_contract_avail ON credit_balance(contract_id, created_at) WHERE status IN ('AVAILABLE', 'PARTIALLY_APPLIED')`
   - Bật RLS (`ENABLE` + `FORCE`) & `GRANT ALL PRIVILEGES`; mở rộng `rls_audit_log_select` để `OWNER` đọc được nhật ký của `service_subscription`, `invoice_adjustment`, `credit_balance` thuộc tòa nhà sở hữu.

---

### 5.2. Engine Phân giải Đơn giá 3 Tầng & Tính phí Pro-rata (`api/src/services/serviceBilling.js`)

Tập trung toàn bộ logic định giá, làm tròn và tính khoảng ngày hiệu lực vào module dùng chung `serviceBilling.js`:

1. **Phân giải đơn giá 3 tầng (`resolveServiceUnitPrice` — `FR-065`):**
   - **Với hóa đơn đã phát hành (`status != 'DRAFT'`) khi lập điều chỉnh:** lấy trực tiếp `unit_price` và `quantity` đã khóa trên dòng `invoice_line` (`item_type = 'SERVICE'`) của kỳ đó để sửa bảng giá về sau không bao giờ làm lệch số tiền kỳ đã phát hành (`FR-065`).
   - **Khi khởi tạo gói đăng ký dịch vụ (`services.js`, `resident.js`, `contracts.js`) và khi tính cho kỳ chưa phát hành (`DRAFT`, sinh hóa đơn mới, dựng lịch dự kiến):** phân giải theo thứ tự ưu tiên nghiêm ngặt:
     1. **Giá ghi đè trong hợp đồng (`PRICE_SOURCE = 'CONTRACT_OVERRIDE'`):** `contract_service_price` có `effective_from <= cuối_kỳ` (khớp `service_code` trực tiếp hoặc qua ánh xạ chuẩn `INTERNET_FIBER`/`INTERNET` → `INTERNET`, `MANAGEMENT_FEE`/`MANAGEMENT` → `COMMON_SERVICE`).
     2. **Đơn giá chốt riêng trên bản ghi đăng ký dịch vụ của hợp đồng (`PRICE_SOURCE = 'SUBSCRIPTION_SNAPSHOT'`):** nếu trên `service_subscription` đã có `unit_price` khác với đơn giá của dòng danh mục `service_catalog` được trỏ trực tiếp (ví dụ giá đã in vào Điều 5 hợp đồng ký hoặc dữ liệu gói đặc thù không tạo dòng `contract_service_price`), giữ đúng `sub.unit_price` đã thỏa thuận trên hợp đồng đó.
     3. **Giá riêng của tòa nhà → Giá mặc định của tổ chức (`BUILDING_CATALOG` → `DEFAULT_CATALOG`):** tra cứu bản ghi `service_catalog` đang hoạt động có `building_id = contract.building_id AND UPPER(code) = UPPER(sub.service_code)`, sau đó mới tới bản ghi mặc định `building_id IS NULL AND UPPER(code) = UPPER(sub.service_code)` (và fallback về `sub.unit_price` khi gọi hàm đồng bộ không truyền danh mục như trong unit test thuần của `buildExpectedInvoiceSchedule`).

2. **Quy tắc cửa sổ hiệu lực theo trạng thái (`resolveSubscriptionEffectiveWindow`):**
   - `REJECTED`: không tính phí (`activeDays = 0`, `amount = 0`).
   - `TERMINATED`:
     - Nếu `!sub.end_date || toDateStr(sub.end_date) < toDateStr(sub.start_date)` → hủy trước ngày bắt đầu hoặc thu hồi yêu cầu chưa duyệt → **`activeDays = 0`, `amount = 0` ở mọi kỳ**.
     - Ngược lại (`end_date >= start_date`) → khoảng hiệu lực đóng `[start_date .. end_date]` (tính gộp hai ngày đầu mút).
   - `ACTIVE` hoặc `CANCELLATION_PENDING` (hoặc `PENDING_APPROVAL` khi dựng lịch dự kiến của hợp đồng nháp):
     - Coi là đang mở `[start_date .. +∞)`. Khi gói còn ở `CANCELLATION_PENDING` (chờ Quản lý xác nhận), hóa đơn vẫn tính đủ như đang hoạt động; ngay khi Quản lý xác nhận chuyển sang `TERMINATED`, hệ thống xử lý lại theo kịch bản tương ứng của hóa đơn kỳ đó.

3. **Công thức tính phí trong kỳ `targetPeriod = 'YYYY-MM'` (`computeSubscriptionPeriodCharge`):**
   - Gọi `[boundStart .. boundEnd]` là biên ngày của kỳ trong tháng (mặc định `[monthStart .. monthEnd]`, tổng số ngày thực tế của tháng là `daysInMonth` từ `28..31`; với `invoiceSchedule.js` kẹp theo `[periodStart .. periodEnd]` của hợp đồng):
     - `overlapStart = max(sub.start_date, boundStart)`
     - `overlapEnd = effectiveEnd ? min(effectiveEnd, boundEnd) : boundEnd`
     - Nếu `overlapEnd < overlapStart` → `activeDays = 0`, `amount = 0`, `isProrated = false`.
     - Ngược lại:
       - `activeDays = diffDaysYmd(overlapStart, overlapEnd) + 1`
       - `rawAmount = (activeDays >= daysInMonth) ? (effectiveUnitPrice * quantity) : ((effectiveUnitPrice * quantity * activeDays) / daysInMonth)`
       - `amount = roundVND(rawAmount)` (làm tròn hàng nghìn `ROUND(x, -3)` theo `Mục 10.3`).
   - Trả kèm `formula_meta` và chuỗi giải trình công thức (ví dụ: `"Gửi xe máy (Pro-rata 15/30 ngày: 01/06–15/06/2026 × 2 SL × 200.000 ₫ ≈ 200.000 ₫)"`) để ghi vào `invoice_line` (`AC-015.3`).

4. **Bảo toàn tuyệt đối các kỳ quá khứ (`1 .. N-1`):**
   - Cập nhật truy vấn lọc gói dịch vụ trong `generateInvoicesCore` (`api/src/routes/invoices.js`) và `buildExpectedInvoiceSchedule` (`api/src/services/invoiceSchedule.js`): lấy mọi gói `status IN ('ACTIVE', 'CANCELLATION_PENDING')` hoặc `(status = 'TERMINATED' AND end_date IS NOT NULL AND end_date >= start_date AND end_date >= monthStart)` có `start_date <= monthEnd`.
   - Hệ quả kiểm chứng: nếu cư dân dùng dịch vụ suốt 5 tháng đầu, đến ngày `15` của tháng thứ `6` mới hủy (`TERMINATED`, `end_date = 15/tháng_6`):
     - Tháng `1..5`: `overlap = [01/M .. cuối_tháng_M]` → `activeDays === daysInMonth` → `expectedAmount === currentlyBilled` → `delta === 0` (**không chạm tới hóa đơn tháng 1–5, kể cả khi xem lại lịch dự kiến hay chạy sinh bù kỳ cũ**).
     - Tháng `6`: tính đúng `15` ngày thực dùng.
     - Tháng `7` trở đi: `end_date < 01/tháng_7` → không đưa vào hóa đơn nữa.

---

### 5.3. Luồng Hủy Dịch vụ (`TERMINATED`) & Đóng Tự động Theo Vòng đời Hợp đồng

1. **Ghi nhận hủy dịch vụ trên API (`resident.js` & `services.js`):**
   - Tương thích ngược đầu vào: nếu request gửi `status = 'CANCELLED'`, chuẩn hóa tự động sang `'TERMINATED'`.
   - **Rút yêu cầu chưa duyệt (`sub.status === 'PENDING_APPROVAL'`):** Cư dân (`PATCH /api/v1/resident/services/:id/cancel`) hoặc Quản lý hủy chuyển thẳng sang `'TERMINATED'`, `end_date = addDaysYmd(subStart, -1)`, `prorata_amount = 0`, ghi `audit_log`.
   - **Hủy trước ngày bắt đầu sử dụng (`today < subStart` trên gói `ACTIVE` / `CANCELLATION_PENDING`):**
     - Cư dân gửi yêu cầu hủy: không ép chọn ngày `>= subStart`; gán `end_date = addDaysYmd(subStart, -1)`, `prorata_amount = 0`, chuyển sang `'CANCELLATION_PENDING'`.
     - Quản lý hủy / xác nhận hủy (`PATCH /api/v1/service-subscriptions/:id` → `'TERMINATED'`): nếu `end_date < subStart` (mặc định khi `today < subStart`), chốt `end_date = addDaysYmd(subStart, -1)`, `prorata_amount = 0`.
   - **Hủy sau khi đã vào kỳ sử dụng (`today >= subStart`):**
     - Cư dân gửi yêu cầu hủy: yêu cầu `today <= effEnd <= contractEnd` (chặn cư dân tự lùi ngày quá khứ), chuyển sang `'CANCELLATION_PENDING'`. Cho phép cư dân **Rút yêu cầu hủy** (`PATCH /api/v1/resident/services/:id/withdraw-cancel`: `'CANCELLATION_PENDING'` → `'ACTIVE'`, `end_date = NULL`) khi Quản lý chưa duyệt.
     - Quản lý xác nhận hủy (`PATCH /api/v1/service-subscriptions/:id`):
       - Cho phép chọn `end_date` bàn giao thực tế (`subStart <= end_date <= contractEnd`), hoặc tích chọn *"Chưa phát sinh sử dụng thực tế (0 ₫)"* (`end_date = addDaysYmd(subStart, -1)`, `prorata_amount = 0`).
       - Cho phép Quản lý từ chối hủy (giữ lại dịch vụ): `'CANCELLATION_PENDING'` → `'ACTIVE'`, `end_date = NULL`.
     - Chặn sửa đổi các bản ghi đã kết thúc (`'TERMINATED'` hoặc `'REJECTED'` → `409 INVALID_STATUS`).
     - Mọi thao tác cập nhật trên `PATCH /api/v1/service-subscriptions/:id` đều bắt buộc ghi `audit_log` (`before` / `after`).

2. **Đóng tự động đăng ký dịch vụ khi Hợp đồng kết thúc (`closeContractSubscriptionsInTx`):**
   - Gắn vào cùng DB transaction của toàn bộ 6 luồng kết thúc hợp đồng:
     1. `POST /api/v1/contracts/:id/cancel` (hủy nháp/chờ duyệt → đặt `end_date = start_date - 1 day`, `prorata_amount = 0`, `status = 'TERMINATED'`).
     2. `POST /api/v1/contracts/:id/terminate` (thanh lý trực tiếp trước hoặc sau ngày nhận phòng).
     3. `POST /api/v1/contracts/:id/terminate/approve` (phê duyệt thanh lý).
     4. `POST /api/v1/contracts/requests/:id/approve` (nhánh `TERMINATED_NOW`).
     5. `POST /api/v1/contracts/:id/transfer-room` (đóng hợp đồng căn cũ khi chuyển phòng).
     6. `runDailyJobs()` trong `api/src/jobs/daily.js` (Bước 1a: `TERMINATION_PENDING` → `TERMINATED`; Bước 1b: `ACTIVE`/`RENEWAL_PENDING` → `EXPIRED`).
   - Quy tắc tính `lastActiveDay` của hợp đồng:
     - Nếu chưa nhận phòng (`!movedIn`): `end_date = addDaysYmd(sub.start_date, -1)`, `prorata_amount = 0`.
     - Nếu đã nhận phòng: với hợp đồng kết thúc ngày mùng 1 đầu tháng theo nửa mở `[start_date, end_date)` (`DD === '01' && rawEnd > contract.start_date`) thì `lastActiveDay = addDaysYmd(rawEnd, -1)` (khớp 100% với quy tắc tính `RENT`); các trường hợp còn lại `lastActiveDay = rawEnd`. Cập nhật `status = 'TERMINATED'` và kích hoạt ngay bộ xử lý hóa đơn 3 kịch bản cho từng gói vừa đóng.

---

### 5.4. Xử lý Hóa đơn theo 3 Kịch bản PRD, Duyệt 4 Mắt & Sổ `credit_balance`

Khi một gói `service_subscription` chuyển sang `'TERMINATED'` (trong cùng DB transaction):
- Tìm các hóa đơn không bị hủy (`status != 'VOID'`) của `sub.contract_id` có dòng `SERVICE` thuộc `sub.id` (ưu tiên `il.subscription_id = sub.id`; fallback an toàn theo tên dịch vụ cho các hóa đơn sinh trước migration `044`), khóa `FOR UPDATE`.
- Với mỗi hóa đơn `inv` kỳ `inv.period`:
  - Tính `expectedCharge = computeSubscriptionPeriodCharge(...)` (dùng đơn giá 3 tầng nếu `inv.status === 'DRAFT'`; dùng đơn giá & số lượng đã khóa trên dòng `SERVICE` của hóa đơn đó nếu `inv.status !== 'DRAFT'` theo `FR-065`).
  - Tính tổng tiền đã tính + đang chờ duyệt của gói đó trên hóa đơn:
    `currentlyAccounted = sum(SERVICE lines của sub) + sum(ADJUSTMENT lines đã duyệt của sub) + sum(invoice_adjustment PENDING_APPROVAL của sub)`.
  - `delta = roundVND(expectedCharge.amount - currentlyAccounted)`.
  - Nếu `delta >= 0`: bỏ qua (bảo toàn 100% các kỳ trước).
  - Nếu `delta < 0`: xử lý theo đúng trạng thái của `inv`:

#### 5.4.1. Kịch bản 1 — Hóa đơn kỳ hiện tại CHƯA được sinh (hủy trước `billing_day`)
- Không có bản ghi `invoice` của kỳ hiện tại trong danh sách cần điều chỉnh.
- Đến `billing_day` của hợp đồng (`FR-066`) hoặc khi chạy sinh hóa đơn thủ công (`FR-033`), `generateInvoicesCore` tự động đọc gói `TERMINATED` có giao với kỳ đó, tính tiền Pro-rata chính xác (hoặc bỏ qua nếu `0 ₫`), ghi `subscription_id` + `formula_meta` vào `invoice_line` và tạo hóa đơn ở trạng thái `DRAFT`. Từ kỳ sau trở đi không còn đưa vào hóa đơn.

#### 5.4.2. Kịch bản 2 — Hóa đơn kỳ hiện tại đang ở trạng thái nháp (`DRAFT`)
- **Tự động cập nhật dòng phí trên bản `DRAFT` khi xác nhận `TERMINATED` dịch vụ:**
  - Chụp `beforeSnapshot` (hóa đơn + danh sách `invoice_line` trước khi sửa).
  - Nếu `expectedCharge.amount === 0`: xóa dòng `SERVICE` của `sub.id` khỏi bản `DRAFT`.
  - Nếu `expectedCharge.amount > 0`: cập nhật dòng `SERVICE` của `sub.id` (`amount = expectedCharge.amount`, `description = expectedCharge.description`, `formula_meta = expectedCharge.formula_meta`, `subscription_id = sub.id`).
  - Tính lại tổng bản `DRAFT` (`recalculateDraftInvoiceTotals`): nếu bản `DRAFT` đang có dòng cấn trừ `credit_balance` (`credit_offset_amount > 0`) mà `subtotal_amount` mới giảm thấp hơn `credit_offset_amount`, tự động nhả phần `credit_balance` dư về lại trạng thái `'AVAILABLE'` / `'PARTIALLY_APPLIED'` để không làm âm hóa đơn hoặc mất tín dụng của cư dân.
  - Ghi `audit_log` bắt buộc (`action = 'UPDATE_DRAFT_INVOICE_LINES'`, `entity = 'invoice'`, `before = beforeSnapshot`, `after = afterSnapshot`) theo `AC-020.1`.
- **Hỗ trợ Kế toán / Quản lý rà soát & sửa trực tiếp dòng phí trên bản `DRAFT` trước khi phát hành (`FR-033`, `FR-034`, `AC-020.1`):**
  - Bổ sung các endpoint chỉ cho phép thao tác khi `invoice.status === 'DRAFT'` (trả `409 IMMUTABLE_AFTER_ISSUED` nếu đã phát hành):
    - `POST /api/v1/invoices/:id/lines` (thêm dòng phí nháp mới).
    - `PATCH /api/v1/invoices/:id/lines/:lineId` (sửa mô tả, số lượng, đơn giá dòng phí nháp — tự làm tròn `roundVND`).
    - `DELETE /api/v1/invoices/:id/lines/:lineId` (xóa dòng phí nháp; nếu xóa dòng `credit_id`, hoàn trả ngay `applied_amount` về `credit_balance`).
    - `POST /api/v1/invoices/:id/issue` (alias chuẩn REST theo PRD Mục `14.3` bên cạnh `PATCH /api/v1/invoices/:id/status` với `status = 'ISSUED'`).
  - Mọi thao tác thêm/sửa/xóa dòng trên bản `DRAFT` đều ghi `audit_log` đầy đủ giá trị `before` và `after` (`AC-020.1`).
  - Khi hủy một hóa đơn `DRAFT` (`status = 'VOID'`): cho phép Quản lý thực hiện trực tiếp kèm lý do bắt buộc (vì hóa đơn nháp chưa từng phát hành cho cư dân), hoàn trả toàn bộ `credit_balance` đã tạm gắn trên bản `DRAFT` và ghi `audit_log`.

#### 5.4.3. Kịch bản 3 — Hóa đơn kỳ hiện tại ĐÃ phát hành (`ISSUED`, `PARTIALLY_PAID`, `PAID`, `OVERDUE`, `ADJUSTED`)
- **Khóa chỉnh sửa trực tiếp (`FR-034`, `NFR-016`):**
  - Trên `PATCH /api/v1/invoices/:id/status`, chặn mọi yêu cầu truyền `adjustment_amount` hoặc chuyển sang `'VOID'` khi `inv.status !== 'DRAFT'` (`409 REQUIRES_FOUR_EYES_ADJUSTMENT`).
- **Tạo đề nghị điều chỉnh / hủy chờ phê duyệt 4 mắt (`invoice_adjustment`):**
  1. **Tự động khi xác nhận `TERMINATED` dịch vụ (hoặc đóng hợp đồng):** chèn bản ghi `invoice_adjustment` với `action_type = 'ADJUST'`, `subscription_id = sub.id`, `delta_amount = delta` (số âm đã làm tròn `roundVND`), `reason` giải trình rõ ngày kết thúc & công thức Pro-rata, `formula_meta = expectedCharge.formula_meta`, `status = 'PENDING_APPROVAL'`, `created_by = actorId` (`NULL` nếu do job tự động `daily.js` tạo). Gửi thông báo `INVOICE_ADJUSTMENT_PENDING` tới các `MANAGER` khác của tòa và `SYS_ADMIN`.
  2. **Thủ công qua `POST /api/v1/invoices/:id/adjust` (`FR-035`, `Mục 14.3`):**
     - Hỗ trợ `Idempotency-Key` (tái sử dụng bảng `idempotency_key` từ `042`).
     - Nhận `{ action_type: 'ADJUST' | 'VOID', delta_amount, reason }`, bắt buộc có `reason` không rỗng.
     - Nếu `action_type = 'VOID'`: yêu cầu `inv.paid_amount === 0` (`409 ALREADY_PAID` nếu đã có tiền thanh toán).
     - Lưu `invoice_adjustment (status = 'PENDING_APPROVAL', created_by = req.user.sub)`, ghi `audit_log` và gửi thông báo chờ duyệt.
  3. **Danh sách & Phê duyệt / Từ chối 4 mắt:**
     - `GET /api/v1/invoices/adjustments` (lọc theo `building_id`, `status`, `invoice_id`) và trả kèm mảng `adjustments` trong `GET /api/v1/invoices/:id`.
     - `POST /api/v1/invoices/:id/adjustments/:adjId/approve` & `POST /api/v1/invoices/:id/adjustments/:adjId/reject`:
       - Quyền: `SYS_ADMIN` hoặc `MANAGER` phụ trách tòa (`OWNER` chỉ đọc).
       - **Kiểm tra 4 mắt bắt buộc:** gọi `checkFourEyesOrWarn({ orgId, actorId: req.user.sub, creatorId: adj.created_by, entity: 'invoice_adjustment', entityId: adj.id, actionContext: 'INVOICE_ADJUST_APPROVE' })`. Nếu `!allowed` → trả `403 SELF_APPROVAL` (*"Nguyên tắc 4 mắt: Người lập đề nghị điều chỉnh/hủy hóa đơn không được tự phê duyệt."*).
       - **Khi duyệt `action_type = 'VOID'`:**
         - Khóa `invoice FOR UPDATE`, kiểm tra lại `paid_amount === 0`.
         - Hoàn trả toàn bộ `credit_balance` đã cấn trừ trên hóa đơn đó (`applied_amount -= ABS(line.amount)`, cập nhật `status` về `'AVAILABLE'` / `'PARTIALLY_APPLIED'`, đặt `invoice.credit_offset_amount = 0`).
         - Chuyển `invoice.status = 'VOID'`, chuyển `receivable` đang mở sang `'WRITTEN_OFF'`.
       - **Khi duyệt `action_type = 'ADJUST'`:**
         - Khóa `invoice FOR UPDATE`. **Giữ nguyên bất biến 100% các dòng `invoice_line` cũ**; chỉ `INSERT` thêm dòng `invoice_line` mới (`item_type = 'ADJUSTMENT'`, `subscription_id = adj.subscription_id`, `adjustment_id = adj.id`, `amount = adj.delta_amount`, `description = adj.reason`, `formula_meta = adj.formula_meta`).
         - Nếu hóa đơn chưa thu tiền (`paid_amount === 0`), đang có dòng `LATE_FEE` cũ nhưng sau khi giảm phí gốc thì phần gốc `<= 0`: tự động ghi thêm dòng `ADJUSTMENT` triệt tiêu phần `LATE_FEE` đó (không xóa dòng cũ để giữ bất biến append-only).
         - Nếu hóa đơn có `credit_offset_amount > 0` mà tổng phí sau điều chỉnh âm (`rawTotal < 0`), tự động hoàn lại phần `Math.min(credit_offset_amount, Math.abs(rawTotal))` về bản ghi `credit_balance` gốc và ghi thêm dòng điều chỉnh cân bằng để không làm thất thoát tín dụng của cư dân.
         - Tính `nextTotal = Math.max(0, subtotal_amount + adjustment_amount)` và đối chiếu với `oldPaid = Number(inv.paid_amount)`:
           - **Nếu `oldPaid < nextTotal`:** đặt `invoice.total_amount = nextTotal`, `invoice.status = 'ADJUSTED'`; đồng bộ `receivable.amount = nextTotal`, `receivable.paid_amount = oldPaid`, `receivable.status = (oldPaid > 0 ? 'PARTIALLY_PAID' : 'OPEN')`.
           - **Nếu `oldPaid >= nextTotal` (bao gồm hóa đơn đã `PAID` trước đó hoặc `PARTIALLY_PAID` nay đã đủ/dư, hoặc giảm về `0 ₫`):**
             - Tính tiền nộp thừa phát sinh: `excessPaid = oldPaid - nextTotal`.
             - Kẹp `invoice.paid_amount = nextTotal` (đảm bảo `paid_amount <= total_amount`), đặt `invoice.total_amount = nextTotal`, `invoice.status = 'ADJUSTED'` (với `remaining_amount = 0`).
             - Nếu `nextTotal === 0`: chuyển `receivable` mở sang `'WRITTEN_OFF'` (tuyệt đối không gán `receivable.amount = 0`). Nếu `nextTotal > 0`: cập nhật `receivable` thành `amount = nextTotal, paid_amount = nextTotal, status = 'PAID'`.
             - **Nếu `excessPaid > 0`:** ghi nhận ngay bản ghi mới vào bảng `credit_balance` (`amount = excessPaid`, `applied_amount = 0`, `status = 'AVAILABLE'`, `reason_type = adj.subscription_id ? 'SERVICE_TERMINATION' : 'INVOICE_ADJUSTMENT'`, `source_invoice_id = inv.id`, `source_adjustment_id = adj.id`, `subscription_id = adj.subscription_id`).
       - **Khi từ chối đề nghị (`POST /api/v1/invoices/:id/adjustments/:adjId/reject`) *[Quyết định kỹ thuật đề xuất — Builder Call]*:**
         - Bắt buộc có `reason` không rỗng (`rejection_reason`).
         - Chuyển `invoice_adjustment.status = 'REJECTED'`, ghi `approved_by = req.user.sub`, `approved_at = NOW()`, ghi `audit_log` (`REJECT_INVOICE_ADJUSTMENT`) — **giữ nguyên `service_subscription.status = 'TERMINATED'`** (vì việc thu thẻ/ngừng cung cấp dịch vụ vật lý của Quản lý là quyết định vận hành độc lập; từ chối bút toán điều chỉnh chỉ có nghĩa không giảm trừ mức tiền đó trên hóa đơn đã phát hành, đồng thời giải phóng Partial Unique Index `PENDING_APPROVAL` để kế toán/quản lý có thể lập lại đề nghị điều chỉnh khác với mức tiền/lý do chuẩn xác hơn qua `POST /api/v1/invoices/:id/adjust`).
       - Ghi `audit_log` (`before` / `after`) và gửi thông báo cho cư dân (`INVOICE_ADJUSTED` / `INVOICE_VOIDED`) khi phê duyệt thành công.

---

### 5.5. Vòng đời `credit_balance`, Báo cáo Doanh thu & Quyết toán cuối kỳ

1. **Khi xác nhận thanh toán vượt hóa đơn (`applyPaymentToInvoice` trong `api/src/routes/payments.js`):**
   - Chặn thu tiền trên hóa đơn `status IN ('DRAFT', 'VOID')` hoặc hóa đơn đã thu đủ `total_amount - paid_amount <= 0`.
   - Khi `currentPaid + payAmount > total_amount`:
     - Kẹp `invoice.paid_amount = total_amount` (`Mục 13.3`), chuyển `invoice.status = 'PAID'`.
     - Ghi `overpayment = currentPaid + payAmount - total_amount` vào `payment.overpayment_amount` **và** tạo bản ghi `credit_balance` (`reason_type = 'OVERPAYMENT'`, `source_payment_id = payment.id`, `source_invoice_id = invoice.id`, `amount = overpayment`, `status = 'AVAILABLE'`) nếu hóa đơn gắn với `contract_id`.
   - Bảo đảm **tính giao hoán tuyệt đối**: dù khách thanh toán trước rồi mới duyệt điều chỉnh giảm dịch vụ, hay duyệt điều chỉnh giảm dịch vụ trước rồi mới xác nhận biên lai thanh toán của khách, `total_amount`, `paid_amount` và `credit_balance` đều ra kết quả giống hệt nhau tới từng đồng.

2. **Tự động bù trừ `credit_balance` vào hóa đơn kỳ kế tiếp (`generateInvoicesCore` trong `api/src/routes/invoices.js` — `FR-033`, `FR-040`):**
   - Sau khi tính xong `subtotal` của hóa đơn kỳ mới, khóa FIFO các khoản `credit_balance` khả dụng của hợp đồng (`status IN ('AVAILABLE', 'PARTIALLY_APPLIED') ORDER BY created_at ASC FOR UPDATE`).
   - Với mỗi khoản `credit` khi còn phần cần trừ (`remainingToOffset > 0`):
     - `useAmt = Math.min(credit.amount - credit.applied_amount, remainingToOffset)`.
     - Chèn dòng `invoice_line`: `item_type = 'ADJUSTMENT'`, `credit_id = credit.id`, `amount = -useAmt`, `unit_price = -useAmt`, `description = "Bù trừ từ số dư tạm giữ (credit_balance): " + credit.description`, `formula_meta = { credit_id: credit.id, applied_amount: useAmt }`.
     - Cập nhật `credit.applied_amount += useAmt`, `credit.status = (applied_amount >= amount ? 'APPLIED' : 'PARTIALLY_APPLIED')`.
   - Lưu trên `invoice`: `subtotal_amount = subtotal`, `adjustment_amount = -totalCreditUsed`, `credit_offset_amount = totalCreditUsed`, `total_amount = subtotal - totalCreditUsed`.
   - Nếu phát hành mà `total_amount === 0` (số dư `credit_balance` bù trừ trọn 100% hóa đơn kỳ mới): chuyển `invoice.status = 'PAID'` ngay khi phát hành, không tạo `receivable` `0 ₫`.

3. **Cập nhật truy vấn công nợ, quá hạn & báo cáo cho trạng thái `'ADJUSTED'` và `'VOID'`:**
   - `daily.js` (Bước 6 & 7): xét `status IN ('ISSUED', 'PARTIALLY_PAID', 'ADJUSTED') AND paid_amount < total_amount` (bảo đảm hóa đơn `'ADJUSTED'` đã đóng đủ tiền `paid_amount = total_amount` không bao giờ bị chuyển sang `'OVERDUE'` hay cộng `LATE_FEE`, trong khi hóa đơn `'ADJUSTED'` còn nợ quá hạn vẫn tính quá hạn/phạt chậm chuẩn xác).
   - `resident.js` (`current_amount_due`, `reportPayment`), `deposits.js` (`calculateContractOpenDebts`, `checkSettlementPreconditions` — bổ sung kiểm tra không còn `invoice_adjustment` đang `PENDING_APPROVAL` trước khi tất toán cọc): tính dư nợ mở bằng `GREATEST(0, total_amount - paid_amount)` trên tập trạng thái `('ISSUED', 'ADJUSTED', 'PARTIALLY_PAID', 'OVERDUE')`.
   - `reports.js` (`/dashboard` và `/summary`) *[Quyết định kỹ thuật đề xuất — Builder Call]*:
     - Loại cả `'DRAFT'` và `'VOID'` khỏi doanh thu phát hành (`status NOT IN ('DRAFT', 'VOID')` theo PRD `Mục 15.3`).
     - `billed = SUM(i.total_amount + i.credit_offset_amount) FILTER (WHERE i.status NOT IN ('DRAFT', 'VOID'))` (bảo toàn đúng doanh thu kinh tế từng kỳ, không giảm trừ kép khi áp `credit_balance`).
     - `collected = SUM(i.paid_amount + i.credit_offset_amount) FILTER (WHERE i.status NOT IN ('DRAFT', 'VOID'))` (tổng giá trị hóa đơn của kỳ đã được thanh toán bằng tiền hoặc tất toán từ `credit_balance`, giúp đẳng thức kế toán theo kỳ `billed = collected + outstanding` luôn đúng tuyệt đối và không bị hụt doanh thu đã thu ở kỳ có cấn trừ `credit_balance`).
     - `outstanding = SUM(GREATEST(0, i.total_amount - i.paid_amount)) FILTER (WHERE i.status IN ('ISSUED', 'ADJUSTED', 'PARTIALLY_PAID', 'OVERDUE'))`.

4. **Quyết toán cuối kỳ khi chấm dứt hợp đồng & Kết chuyển khi chuyển phòng (`deposits.js`, `contracts.js` — `FR-040`, `FR-068`, `RP-07`):**
   - **Tách bạch hoàn toàn `credit_balance` và Tiền cọc gốc (`deposit`):**
     - Trong `GET /:id/settlement`, `POST /:id/settlement`, `POST /:id/settlement/approve` và `GET /:id/settlement/pdf`:
       1. Khóa các khoản `credit_balance` khả dụng của hợp đồng (`availableCredit`).
       2. **Bước 1 — Đối trừ `credit_balance` (`FR-040`):** Vì `credit_balance` là tiền cư dân đã nộp dư từ các hóa đơn trước (không phải tiền cọc), ưu tiên dùng `availableCredit` gạch nợ các hóa đơn mở của hợp đồng trước (ưu tiên phần dịch vụ/điện nước trước, sau đó đến phần tiền thuê còn thiếu nếu có; cập nhật `invoice.paid_amount` & `receivable`), tiếp đó bù phần chi phí hư hỏng vượt tiền cọc (nếu `sumItems > heldBefore`). Phần `credit_balance` vẫn còn dư sau khi đã hết sạch nghĩa vụ (`creditRefundAmount`) được đánh dấu `status = 'REFUNDED_IN_SETTLEMENT'`, `applied_amount = amount`, `settlement_deposit_id = dep.id`.
       3. **Bước 2 — Tất toán tiền cọc gốc (`FR-068`, `RP-07`):** Sổ giao dịch cọc `deposit_transaction` **chỉ ghi nhận đúng dòng tiền của tiền cọc gốc `heldBefore`**:
          - `deduct` hư hỏng/vệ sinh (`items`) và `UTILITY_DEBT` cho phần nợ dịch vụ còn lại sau Bước 1 (**tuyệt đối không chạm vào nợ `RENT` theo `FR-068`**).
          - `refund` đúng phần tiền cọc gốc còn dư `depositRefundAmount = max(0, heldBefore - sumItems - remainingServiceDebtAfterCredit)` (nhờ vậy tổng `deduct + refund` trên `deposit_transaction` luôn khớp 100% với `collect` trên báo cáo sổ cọc `RP-07`).
       4. Lưu vào JSON `deposit.settlement` đầy đủ các trường tách bạch: `available_credit`, `credit_applied_to_invoices`, `credit_applied_to_damages`, `credit_refund_amount`, `deposit_refund_amount`, `total_payout_amount = deposit_refund_amount + credit_refund_amount` để hiển thị minh bạch trên UI và Biên bản PDF A4.
   - **Khi Chuyển phòng (`transfer-room` có `transfer_deposit = true`) hoặc Gia hạn có kết chuyển cọc:**
     - Chốt các khoản `credit_balance` khả dụng còn lại trên hợp đồng cũ sang `'TRANSFERRED'` và tạo bản ghi `'AVAILABLE'` (`reason_type = 'TRANSFERRED_IN'`) tương ứng sang hợp đồng mới để tự động bù trừ vào kỳ hóa đơn tiếp theo của cư dân.

---

### 5.6. Giao diện Frontend

1. **Chuẩn hóa hằng số trạng thái (`frontend/src/constants/statuses.js`) & Hàm làm tròn `roundVND`:**
   - `SUBSCRIPTION_STATUS`: bổ sung `TERMINATED: { label: 'Đã chấm dứt', variant: 'slate' }` (giữ alias `CANCELLED` dự phòng cho an toàn hiển thị).
   - `INVOICE_STATUS`: đổi sang `ADJUSTED: { label: 'Đã điều chỉnh', variant: 'indigo' }`, `VOID: { label: 'Đã hủy bỏ (Void)', variant: 'slate' }` (giữ alias `CANCELLED` dự phòng).
   - Bổ sung `INVOICE_ADJUSTMENT_STATUS` (`PENDING_APPROVAL`, `APPROVED`, `REJECTED`) và helper `roundVND` dùng chung trên Frontend để mọi phép tính xem trước Pro-rata làm tròn hàng nghìn khớp 100% với Backend.

2. **Cổng Cư dân (`ServicesTab.jsx`, `InvoicesTab.jsx`):**
   - `ServicesTab.jsx`:
     - Khi `sub.status === 'PENDING_APPROVAL'` hoặc `today < subStart`: mở khóa hủy ngay không cần nhập ngày `>= subStart`, hiển thị rõ thông báo *"Dịch vụ chưa bắt đầu sử dụng — Hủy trước ngày bắt đầu sẽ không phát sinh chi phí (0 ₫)"*.
     - Khi `today >= subStart`: tính trước Pro-rata bằng `roundVND` trên khoảng `[max(subStart, monthStart) .. end_date]`; bổ sung nút *"Rút yêu cầu hủy"* khi gói đang ở `CANCELLATION_PENDING`.
   - `InvoicesTab.jsx`:
     - Hiển thị thẻ số dư *"Số dư tạm giữ (`credit_balance`) sẽ tự động bù trừ kỳ tới"* (trả về từ `/api/v1/resident/me`).
     - Cập nhật bộ lọc tab và nút *"Báo đã thanh toán"* theo `remaining = Math.max(0, total_amount - paid_amount) > 0` để hỗ trợ trọn vẹn trạng thái `'ADJUSTED'` và `'VOID'`; hiển thị giải trình công thức Pro-rata / điều chỉnh trên từng dòng hóa đơn.

3. **Cổng Quản trị (`SubscriptionsPage.jsx`, `InvoicesPage.jsx`, `InvoiceDetailPage.jsx`, `ContractDetailPage.jsx`, `DepositsPage.jsx`):**
   - `SubscriptionsPage.jsx`:
     - Hỗ trợ xác nhận hủy `0 ₫` khi `today < subStart`, tùy chọn *"Chưa phát sinh sử dụng thực tế (0 ₫)"*, nút *"Giữ lại dịch vụ (Từ chối hủy)"*, và hiển thị thông báo kết quả xử lý hóa đơn tương ứng với 3 kịch bản (ví dụ: *"Đã cập nhật ngay hóa đơn nháp INV-..."* hoặc *"Đã tạo đề nghị điều chỉnh -200.000 ₫ trên hóa đơn INV-... (chờ phê duyệt 4 mắt)"*).
   - `InvoicesPage.jsx` & `InvoiceDetailPage.jsx`:
     - **Khi hóa đơn đang `DRAFT`:** hiển thị giao diện thêm / sửa / xóa trực tiếp từng dòng phí nháp trước khi bấm *"Phát hành (ISSUED)"* hoặc *"Hủy nháp (VOID)"*.
     - **Khi hóa đơn đã phát hành (`ISSUED` trở đi):** ẩn sửa trực tiếp; cung cấp nút *"Lập điều chỉnh / Hủy hóa đơn (4 mắt)"* gọi `POST /api/v1/invoices/:id/adjust`. Hiển thị danh sách `invoice_adjustment` ngay trên trang chi tiết hóa đơn (và tab/bộ lọc *"Chờ duyệt điều chỉnh"* trên `InvoicesPage.jsx`) với nút **Phê duyệt / Từ chối** dành cho người duyệt khác người lập (`MANAGER` thứ hai / `SYS_ADMIN`).
     - Hiển thị rõ dòng bù trừ `credit_balance` (`credit_offset_amount`) và công thức tính trên `invoice_line`.
   - `ContractDetailPage.jsx` & `DepositsPage.jsx`:
     - `ContractDetailPage.jsx`: hiển thị số dư `credit_balance` khả dụng của hợp đồng và cập nhật bảng lịch dự kiến khớp trạng thái `'TERMINATED'` / `'VOID'` / `'ADJUSTED'`.
     - `DepositsPage.jsx`: hiển thị tách bạch phần hoàn trả tiền cọc gốc (`deposit_refund_amount`), phần đối trừ/hoàn trả `credit_balance` (`credit_refund_amount`) và tổng thực chi hoàn lại cho cư dân (`total_payout_amount`), đồng thời cảnh báo nếu hợp đồng còn đề nghị điều chỉnh hóa đơn `PENDING_APPROVAL` chưa duyệt xong trước khi lập tất toán cọc.

---

## 6. Phần để bước lập kế hoạch & thi công quyết định (Left to the Builder)

- Cách tổ chức chi tiết các hàm nội bộ trong `api/src/services/serviceBilling.js` và `api/src/services/invoiceLifecycle.js` (miễn đảm bảo các thao tác đổi trạng thái, cập nhật bản nháp, lập/duyệt điều chỉnh 4 mắt, cập nhật `receivable`, `credit_balance` và ghi `audit_log` luôn thực thi nguyên tử trong cùng PostgreSQL transaction).
- Cấu trúc chi tiết payload `invoice_sync_result` trả về kèm trong `PATCH /api/v1/service-subscriptions/:id` để giao diện hiển thị toast hướng dẫn bước tiếp theo rõ ràng.
- Cách chia tách bộ kiểm thử tự động (`node --test`) bao phủ: công thức Pro-rata & bảng giá 3 tầng `FR-065`, bảo toàn 5 tháng đầu khi hủy giữa tháng thứ 6, rò rỉ `DRAFT` đối với `RESIDENT` (`AC-003.2`), sửa dòng `DRAFT` có `audit_log` (`AC-020.1`), quy trình duyệt 4 mắt `invoice_adjustment` (`SELF_APPROVAL` vs người thứ hai duyệt), tính giao hoán thanh toán & điều chỉnh sinh `credit_balance`, bù trừ kỳ kế tiếp không trừ đúp doanh thu, và quyết toán cuối kỳ tách bạch `credit_balance` với tiền cọc gốc (`FR-068`).
