# Thiết kế Hủy Dịch vụ (`TERMINATED`), Đồng bộ Phí Dịch vụ & Tiền Thuê Sớm (`6A`), Xử lý Hóa đơn 3 Kịch bản (Duyệt 4 Mắt) & Sổ Tạm giữ `credit_balance`

**Ngày:** 2026-11-02  
**Phiên bản:** v3 (Đã rà soát đối chiếu toàn diện theo PRD v2.0)  
**Quy mô:** Dự án liên phân hệ (Migration CSDL & RLS chuẩn `PRD Mục 6.2` + Engine tính phí 3 tầng & đồng bộ hóa đơn 3 kịch bản cho cả `SERVICE` và `RENT` khi kết thúc hợp đồng sớm + Phê duyệt 4 mắt sau phát hành qua RPC hẹp `SECURITY DEFINER` + Sổ `credit_balance`, KPI `Mục 15.3` & Quyết toán cuối kỳ + Tab Audit & Giao diện Quản trị / Chủ nhà / Cư dân)  
**Tài liệu tham chiếu chuẩn:** `PRD - Quan ly Can ho va Nha cho thue v2.0.md` (`FR-006`, `FR-013`, `FR-029`, `FR-033`, `FR-034`, `FR-035`, `FR-040`, `FR-065`, `FR-066`, `FR-068`, `AC-003.2`, `AC-015.3`, `AC-017.3`, `AC-019.1`, `AC-020.1`, Mục `6.1`, `6.2`, `7.5`, `8.2`, `10.3`, `13`, `13.2`, `13.3`, `13.4`, `14.3`, `14.5`, `15.1–15.3`, `16.1–16.2`, `NFR-008`, `NFR-016`)

---

## 1. Mục đích & Lý do (Intent & Why)

Hệ thống hiện đang tồn tại các bất cập nghiệp vụ liên kết chặt chẽ với nhau trong vòng đời đăng ký dịch vụ (`service_subscription`), hợp đồng kết thúc sớm (`contract`), hóa đơn định kỳ (`invoice`), sổ số dư tạm giữ (`credit_balance`) và quyết toán cuối kỳ (`deposit`):

1. **Đặt cọc / kích hoạt hợp đồng trước ngày nhận phòng (`today < start_date`) nhưng muốn hủy dịch vụ hoặc thanh lý hợp đồng trước ngày ở:**
   - Khi kích hoạt hợp đồng (`runActivationSideEffects` trong `api/src/routes/contracts.js`), các gói dịch vụ đi kèm được chuyển sang `ACTIVE` dù `start_date` nằm ở tương lai.
   - Trên giao diện Cư dân (`ServicesTab.jsx`) và Quản lý (`SubscriptionsPage.jsx`), ô chọn `end_date` khi hủy đang bị khóa tối thiểu `end_date >= max(today, start_date)`. Đồng thời hàm `computeProrata(..., 'cancel')` tại Backend đang lấy `end_date.getDate()` (tính từ mùng 1 đầu tháng) và dùng ngày UTC `toISOString().slice(0, 10)`, khiến dịch vụ **chưa sử dụng ngày nào** vẫn bị tính phí Pro-rata thay vì `0 ₫`.
   - Khi hợp đồng chấm dứt trước hạn hoặc chuyển phòng (`cancel`, `terminate`, `terminate/approve`, `requests/:id/approve`, `transfer-room`) hoặc hết hạn tự nhiên (`daily.js`), các bản ghi `service_subscription` đang mở vẫn bị bỏ sót ở `ACTIVE`, và các hóa đơn đã sinh sẵn của kỳ thanh lý chưa được tự động đồng bộ lại cả dòng phí dịch vụ (`SERVICE`) lẫn dòng tiền thuê phòng (`RENT`).

2. **Hủy dịch vụ giữa kỳ sau nhiều tháng sử dụng (ví dụ dùng 5 tháng, hủy giữa tháng thứ 6) — Hóa đơn chưa đồng bộ theo 3 kịch bản PRD & lịch sử kỳ trước dễ bị rơi:**
   - Khi Quản lý xác nhận hủy dịch vụ (`PATCH /api/v1/service-subscriptions/:id`), hệ thống hiện chỉ cập nhật `service_subscription.prorata_amount` mà **không xử lý hóa đơn kỳ hiện tại** theo 3 kịch bản của PRD (`chưa sinh hóa đơn`, `DRAFT`, `đã phát hành`), cũng chưa ghi `audit_log` giá trị trước/sau.
   - Khi sinh hóa đơn (`generateInvoicesCore` trong `api/src/routes/invoices.js`) và dựng lịch dự kiến (`buildExpectedInvoiceSchedule` trong `api/src/services/invoiceSchedule.js`):
     - Đang loại bỏ các gói `CANCELLATION_PENDING` (làm hóa đơn sinh trước lúc Quản lý duyệt hủy bị rơi mất phí thành `0 ₫`), hoặc loại bỏ các gói đã hủy ở các kỳ quá khứ (làm bảng lịch dự kiến và việc sinh bù hóa đơn các tháng `1..5` bị mất phí khi hủy ở tháng thứ `6`).
     - Gói đăng ký giữa tháng và hủy ngay trong cùng tháng (ví dụ `10/11` → `20/11`) đang tính nhầm từ `01/11` (`20` ngày) thay vì khoảng giao thực tế `[10/11 .. 20/11]` (`11` ngày).
   - Các lỗ hổng tuân thủ PRD v2.0 cần đóng đồng bộ trong cùng thiết kế:
     - Tên mã trạng thái vật lý trong CSDL đang dùng `CANCELLED` thay vì chuẩn PRD Mục `13.2` (`service_subscription.status = 'TERMINATED'`, `invoice.status` gồm `'ADJUSTED'` và `'VOID'`).
     - Phân quyền RBAC & RLS trên dịch vụ/hóa đơn/thanh toán chưa sát `PRD Mục 6.1–6.2`: `SYS_ADMIN` đang giữ quyền ghi trực tiếp thay vì chỉ xem (`R`) và dự phòng duyệt khi tòa chưa có `OWNER`; `OWNER` chưa có quyền phê duyệt (`A`) đề nghị điều chỉnh/hủy hóa đơn sau phát hành của tòa mình sở hữu; một số truy vấn trong route vẫn dùng `adminPool` vượt qua RLS.
     - Rò rỉ hóa đơn `DRAFT` sang Cư dân ở RLS (`rls_invoice_select`, `rls_invoice_modify`), `GET /api/v1/invoices/:id`, `POST /api/v1/resident/payments/report` và `GET /api/v1/contracts/:id` (vi phạm `AC-003.2`).
     - Hóa đơn sau phát hành (`ISSUED` trở đi) đang cho sửa/xóa dòng `ADJUSTMENT` trực tiếp qua `PATCH /api/v1/invoices/:id/status` mà không có quy trình phê duyệt 4 mắt (`FR-034`, `FR-035`, `NFR-016`), thiếu tab `Lịch sử / Kiểm toán` trên chi tiết hóa đơn (`Mục 8.2`), và thiếu xác nhận 2 bước nhập lại `invoice_code` khi hủy hóa đơn (`Mục 16.2`).
     - Chưa có bảng vật lý `credit_balance` (`Mục 13.2`, `FR-040`) để lưu khoản nộp thừa, tự động bù trừ vào hóa đơn kỳ kế tiếp (`FR-033`) mà không làm giảm kép doanh thu báo cáo, tách biệt chỉ tiêu KPI `"Tiền thực thu"` (`Mục 15.3`) với giá trị hóa đơn đã tất toán theo kỳ (`Mục 15.1`), và tách bạch tuyệt đối với tiền cọc gốc khi quyết toán cuối kỳ (`FR-068`).

---

## 2. Mục tiêu & Giới hạn (Goals, Non-Goals, Anti-Goals)

### 2.1. Mục tiêu (Goals)
1. **Chuẩn hóa mã trạng thái CSDL & Quy ước thời gian theo đúng PRD Mục 13, 13.2, 13.4 (Quyết định 2 = Phương án B):**
   - `service_subscription.status`: chuyển `'CANCELLED'` → **`'TERMINATED'`** (`'PENDING_APPROVAL'`, `'ACTIVE'`, `'CANCELLATION_PENDING'`, `'TERMINATED'`, `'REJECTED'`).
   - `invoice.status`: chuyển `'CANCELLED'` → **`'VOID'`** và bổ sung **`'ADJUSTED'`** (`'DRAFT'`, `'ISSUED'`, `'PARTIALLY_PAID'`, `'PAID'`, `'OVERDUE'`, `'ADJUSTED'`, `'VOID'`).
   - Chuẩn hóa toàn bộ phép so sánh ngày hiện tại (`today`) trên vùng dịch vụ, hóa đơn, cư dân và job hàng ngày theo múi giờ **`Asia/Ho_Chi_Minh`** (`PRD Mục 13.4`) thay cho cắt chuỗi UTC `toISOString().slice(0, 10)`.
2. **Hủy dịch vụ trước ngày bắt đầu sử dụng (`0 ₫`) & Đồng bộ tự động cả `SERVICE` lẫn `RENT` khi Hợp đồng kết thúc sớm / chuyển phòng (Quyết định `6A`):**
   - Mở khóa hủy dịch vụ khi `today < start_date` (hoặc rút yêu cầu `PENDING_APPROVAL`) với `0` ngày sử dụng (`0 ₫`).
   - Trên toàn bộ 6 luồng kết thúc hợp đồng (`cancel`, `terminate`, `terminate/approve`, `requests/:id/approve`, `transfer-room`, `daily.js` Bước 1a & 1b): tự động chuyển các `service_subscription` đang mở sang `'TERMINATED'` **và** đồng bộ lại cả dòng phí dịch vụ (`SERVICE`) lẫn dòng tiền thuê phòng (`RENT`) trên các hóa đơn đã sinh từ kỳ kết thúc trở đi (hoặc toàn bộ các kỳ nếu hủy trước ngày nhận phòng `!movedIn` → `0 ₫`) theo đúng 3 kịch bản hóa đơn của PRD.
3. **Chuẩn hóa công thức Pro-rata, thứ tự ưu tiên đơn giá 3 tầng (`FR-065`), làm tròn `ROUND(x, -3)` & bảo toàn 100% các kỳ trước:**
   - Tính phí trên khoảng giao thực tế `[max(start_date, periodStart) .. min(end_date, periodEnd)]`.
   - Áp dụng thứ tự ưu tiên đơn giá **Giá hợp đồng (`contract_service_price`) → Giá chốt riêng trên gói đăng ký hợp đồng (nếu khác danh mục gốc) → Giá tòa (`service_catalog` có `building_id`) → Giá mặc định tổ chức (`service_catalog` có `building_id IS NULL`)**; riêng các kỳ hóa đơn **đã phát hành** luôn khóa theo `unit_price` đã áp trên `invoice_line` của kỳ đó (`FR-065`).
   - Làm tròn `ROUND(x, -3)` (`roundVND`) đồng nhất cả Backend và Frontend; lưu công thức & tham chiếu vào `invoice_line` (`subscription_id`, `credit_id`, `adjustment_id`, `formula_meta JSONB` + mô tả tường minh theo `AC-015.3`, `Mục 13.2`).
   - Hủy dịch vụ hoặc thanh lý hợp đồng ở giữa tháng thứ `N` giữ nguyên **100%** dữ liệu và số tiền của các tháng `1 .. N-1`.
4. **Xử lý hóa đơn chuẩn xác theo 3 kịch bản PRD, Phân quyền chuẩn `PRD Mục 6.1–6.2`, `Idempotency-Key` & Duyệt 4 mắt sau phát hành (Quyết định 1 = Phương án A):**
   - **Kịch bản 1 (Chưa sinh hóa đơn kỳ hủy — trước `billing_day`):** Khi tới `billing_day` (hoặc chạy tay), `generateInvoicesCore` tự tính Pro-rata cho các ngày hiệu lực trong kỳ (hoặc `0 ₫` nếu hủy trước ngày bắt đầu), tạo hóa đơn `DRAFT`; các kỳ kế tiếp bỏ qua gói đã `TERMINATED`.
   - **Kịch bản 2 (Hóa đơn kỳ hiện tại đang `DRAFT`):** Khóa tuyệt đối không cho `RESIDENT` nhìn thấy hay báo thanh toán trên bản `DRAFT` (`AC-003.2`); cho phép `MANAGER` tòa nhà sửa trực tiếp dòng phí trên bản `DRAFT` (tự động cập nhật khi xác nhận `TERMINATED` dịch vụ / đóng hợp đồng sớm + API sửa dòng nháp cho vận hành rà soát theo `FR-033`, `FR-034`; nếu đóng hợp đồng trước ngày ở làm toàn bộ bản nháp về `0 ₫` và chưa thu tiền thì tự động chuyển bản nháp rỗng sang `'VOID'`) kèm ghi nhận bắt buộc `audit_log` giá trị `before`/`after` (`AC-020.1`).
   - **Kịch bản 3 (Hóa đơn kỳ hiện tại đã phát hành — `ISSUED` / `PARTIALLY_PAID` / `PAID` / `OVERDUE` / `ADJUSTED`):** Khóa bất biến không sửa/xóa trực tiếp (`FR-034`, `NFR-016`); mọi nghiệp vụ điều chỉnh giảm/tăng hoặc hủy hóa đơn (`VOID`) sau phát hành đều tạo bản ghi đề nghị `invoice_adjustment` (`PENDING_APPROVAL`) có lý do bắt buộc và **bắt buộc phê duyệt 4 mắt** bởi **`OWNER` của tòa nhà**, hoặc **`MANAGER` thứ hai cùng tòa** (`actorId !== creatorId` qua `checkFourEyesOrWarn`), hoặc **`SYS_ADMIN` duy nhất trong trường hợp tòa chưa có `OWNER` hoạt động** (`!building_has_active_owner(building_id)`), thực thi qua hàm RPC hẹp `SECURITY DEFINER` để `OWNER` và `SYS_ADMIN` không bao giờ có quyền ghi trực tiếp lên bảng `invoice`/`invoice_line`/`receivable`.
   - Gắn `idempotencyGuard()` (`Idempotency-Key`, `PRD Mục 14.3`) cho các `POST` tài chính và loại bỏ việc dùng `adminPool` vượt RLS trong các route nghiệp vụ (`NFR-008`, `AC-019.1`).
5. **Sổ số dư tạm giữ `credit_balance`, KPI Doanh thu / Thực thu (`Mục 15.1–15.3`) & Tách bạch tuyệt đối với Tiền cọc (`FR-033`, `FR-040`, `FR-068`, `RP-07`, `RP-08`):**
   - Lưu mọi khoản cư dân nộp thừa (do thanh toán vượt hoặc do hóa đơn đã đóng tiền được duyệt điều chỉnh giảm `SERVICE` / `RENT`) vào bảng `credit_balance`, đồng thời giữ chuẩn toàn vẹn `invoice.paid_amount <= invoice.total_amount` (`Mục 13.3`).
   - Kỳ tiếp theo (khi chưa trả phòng): tự động bù trừ `credit_balance` khi sinh hóa đơn `DRAFT` (`FR-033`), lưu `invoice.credit_offset_amount` để báo cáo doanh thu (`billed`) không bị trừ đúp doanh thu kỳ sau, tách rõ `collected` (*Tiền thực thu* từ `payment` xác nhận trong tháng theo `PRD 15.3`) và `invoice_settled` (*Giá trị hóa đơn kỳ đã tất toán* phục vụ biểu đồ đối chiếu công nợ kỳ theo `PRD 15.1`), đồng thời hoàn lại hạn mức `credit_balance` nếu hóa đơn chưa thu tiền đó bị `VOID`.
   - Kỳ cuối / chấm dứt hợp đồng: đối trừ `credit_balance` vào công nợ mở trước, phần dư còn lại hoàn trả thành khoản mục riêng cạnh quyết toán cọc (**tuyệt đối không ghi trộn vào `deposit_transaction` tiền cọc gốc và không bao giờ dùng tiền cọc gốc cấn trừ tiền thuê `RENT` theo `FR-068`**).

### 2.2. Không nằm trong phạm vi (Non-Goals)
- Không tự động lập điều chỉnh lùi vào hóa đơn đã `ISSUED` / `PAID` khi cư dân **đăng ký mới** một dịch vụ giữa kỳ sau khi hóa đơn kỳ đó đã phát hành (các kỳ chưa sinh hóa đơn hoặc đang `DRAFT` vẫn tính Pro-rata đầu vào bình thường).
- Không tự động chốt chỉ số đồng hồ điện/nước (`ELECTRICITY`, `WATER`) khi thanh lý hợp đồng sớm nếu vận hành chưa ghi chỉ số bàn giao (điện/nước tính theo chỉ số đồng hồ thực tế `meter_reading`, không tính Pro-rata theo ngày).
- Không tích hợp cổng chi hoàn tiền tự động qua ngân hàng.
- Không thêm vai trò vật lý mới ngoài 4 vai trò hiện hành của hệ thống (`SYS_ADMIN`, `OWNER`, `MANAGER`, `RESIDENT` theo `036_simplify_roles.sql`), trong đó ma trận quyền tuân thủ nghiêm ngặt `PRD Mục 6.1–6.2`: `MANAGER` đảm nhiệm vận hành & kế toán (`CRU`) trên tòa được phân công; `OWNER` xem (`R`) và phê duyệt 4 mắt (`A`) trên tòa sở hữu; `SYS_ADMIN` chỉ xem (`R`) trên dữ liệu dịch vụ/hóa đơn/thanh toán toàn tổ chức và chỉ dự phòng duyệt (`A`) khi tòa nhà chưa có `OWNER` hoạt động.

### 2.3. Điều cần tránh (Anti-Goals)
- **Tuyệt đối không UPDATE hoặc DELETE dòng `invoice_line` cũ trên bất kỳ hóa đơn nào đã rời trạng thái `DRAFT`** (`FR-034`, `NFR-016`) — mọi điều chỉnh sau phát hành chỉ được phép ghi thêm dòng `ADJUSTMENT` mới sau khi đã qua phê duyệt 4 mắt.
- **Tuyệt đối không cấp quyền RLS `INSERT`/`UPDATE`/`DELETE` đại trà trên `invoice`, `invoice_line`, `receivable` cho `OWNER` hoặc `SYS_ADMIN`**; thao tác duyệt điều chỉnh sau phát hành phải đi qua hàm `SECURITY DEFINER` kiểm soát chặt đầu vào và trạng thái.
- **Không dùng `adminPool` để đọc/ghi dữ liệu nghiệp vụ trong route handler** nhằm tránh bỏ qua PostgreSQL RLS (`NFR-008`).
- **Không vi phạm `paid_amount <= total_amount`** trên `invoice` (`Mục 13.3`) và **không vi phạm `receivable.amount > 0`** trên `receivable` (`026_invoices_payments.sql`).
- **Không trừ đúp doanh thu báo cáo** giữa kỳ điều chỉnh hóa đơn cũ và kỳ áp dụng `credit_balance` tiếp theo, và **không trộn lẫn chỉ tiêu tiền thực thu (`payment`) với số bù trừ nội bộ (`credit_offset_amount`)** trên KPI `Mục 15.3`.
- **Không ghi trộn hoàn trả `credit_balance` vào giao dịch gốc của sổ cọc (`deposit_transaction`)** để không làm lệch báo cáo sổ cái tiền cọc (`RP-07`) và không vi phạm `FR-068`.
- **Không đổi tên `'CANCELLED'` của các thực thể khác** (`contract`, `service_request`, `reservation`, `announcement`) vốn vẫn dùng `'CANCELLED'` theo đúng PRD Mục `13.2`.

---

## 3. Ràng buộc kỹ thuật & Nghiệp vụ (Constraints)

1. **PostgreSQL 16 & Row-Level Security (RLS) chuẩn `PRD Mục 6.2` (`NFR-008`, `AC-019.1`):**
   - Các bảng mới (`invoice_adjustment`, `credit_balance`) bắt buộc bật `ENABLE ROW LEVEL SECURITY`, `FORCE ROW LEVEL SECURITY` và `GRANT ALL PRIVILEGES ... TO resihub_app`.
   - Ma trận quyền RLS cho nhóm Dịch vụ, Bảng giá, Hóa đơn, Điều chỉnh hóa đơn, Thanh toán, Công nợ & Số dư tạm giữ:
     - `SYS_ADMIN` (`is_org_admin()`): **chỉ đọc (`SELECT`)** toàn tổ chức trên `service_catalog`, `service_subscription`, `invoice`, `invoice_line`, `payment`, `receivable`, `invoice_adjustment`, `credit_balance` (`PRD Mục 6.2` dòng 190–194); chỉ được thực thi phê duyệt/từ chối `invoice_adjustment` thông qua RPC `fn_resolve_invoice_adjustment` khi `NOT building_has_active_owner(building_id)` (đồng nhất 100% với `041_contract_owner_price_approval_rls.sql`).
     - `OWNER` (`is_owner()` trên `get_owner_building_ids()`): **chỉ đọc (`SELECT`)** toàn bộ dữ liệu dịch vụ, hóa đơn, thanh toán, `invoice_adjustment`, `credit_balance`, `audit_log` của tòa sở hữu; thực thi phê duyệt/từ chối `invoice_adjustment` (`PENDING_APPROVAL` → `APPROVED` | `REJECTED`) duy nhất qua RPC hẹp `fn_resolve_invoice_adjustment`.
     - `MANAGER` (`is_manager()` trên `get_manager_building_ids()`): quyền `CRU` vận hành & kế toán trên các tòa được phân công (quản lý danh mục dịch vụ tòa/mặc định, duyệt/hủy `service_subscription`, sinh hóa đơn, sửa/xóa dòng `DRAFT`, phát hành, hủy `DRAFT`, lập đề nghị `invoice_adjustment`, ghi nhận/xác nhận `payment`, đọc `audit_log` tài chính của tòa quản lý, và phê duyệt chéo 4 mắt `invoice_adjustment` qua `fn_resolve_invoice_adjustment` khi `actor_id <> created_by`).
     - `RESIDENT`: chỉ đọc dữ liệu gắn với hợp đồng của mình (`get_resident_contract_ids()`), tạo yêu cầu đăng ký/hủy dịch vụ & báo thanh toán (`rls_payment_insert`), và **tuyệt đối không đọc được hóa đơn `DRAFT`** (`status <> 'DRAFT'` ngay ở tầng RLS `rls_invoice_select`).
   - Mọi truy cập trái phạm vi tòa nhà trên API trả thông báo trung tính (`403` / `404` chuẩn `PRD 14.3`) và ghi `audit_log` với `action = 'ACCESS_DENIED'` (`AC-019.1`).
2. **Quy ước múi giờ `Asia/Ho_Chi_Minh` & Biểu diễn ngày `start_date` / `end_date` (`PRD Mục 13.4`):**
   - Ngày hiện tại của nghiệp vụ luôn tính theo `Asia/Ho_Chi_Minh` (`todayVietnamYmd()` ở Node.js bằng `Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' })` và `(NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date` trong SQL) để khung giờ `00:00–06:59` sáng Việt Nam không bao giờ bị lùi 1 ngày so với UTC.
   - `end_date < start_date` (cụ thể `end_date = start_date - 1 day` khi hủy trước ngày bắt đầu sử dụng hoặc thu hồi yêu cầu `PENDING_APPROVAL`): biểu diễn **0 ngày sử dụng (`0 ₫`)**, phân biệt rạch ròi với `end_date === start_date` (**1 ngày sử dụng**).
   - `status = 'TERMINATED'` mà `end_date IS NULL` (dữ liệu lịch sử cũ): luôn coi là **0 ngày sử dụng (`0 ₫`)**.
   - `end_date >= start_date` (với `status = 'TERMINATED'`): khoảng ngày sử dụng thực tế tính gộp hai đầu `[start_date .. end_date]`.
3. **Bất biến tài chính & Bảo toàn phương trình kế toán:**
   - Trên bảng `invoice`: luôn duy trì `0 <= paid_amount <= total_amount`. Khi khách chuyển khoản vượt `remaining_amount` hoặc khi hóa đơn đã thu tiền được duyệt điều chỉnh giảm làm `oldPaid > nextTotal`, phần vượt `oldPaid - nextTotal` được chuyển sang `credit_balance` và `invoice.paid_amount` được kẹp về `nextTotal`.
   - Trên bảng `invoice`: bổ sung cột `credit_offset_amount BIGINT NOT NULL DEFAULT 0 CHECK (credit_offset_amount >= 0)` ghi nhận tổng số tiền `credit_balance` kỳ trước đã cấn trừ vào hóa đơn này:
     - Số tiền khách thực tế cần thanh toán thêm cho hóa đơn = `total_amount - paid_amount` (khớp 100% với QR thanh toán, `receivable.amount` và công nợ mở).
     - Doanh thu phát sinh kinh tế của kỳ (`billed`) = `total_amount + credit_offset_amount` (trên các hóa đơn `status NOT IN ('DRAFT', 'VOID')`), bảo đảm **không bao giờ bị giảm trừ hai lần**!

---

## 4. Các phương án đã cân nhắc (Approaches)

### 4.1. Kiến trúc tổng thể (Đã chốt: Phương án 1)
1. **Phương án 1 — Tự động hóa khép kín chuẩn PRD từ Hủy trước hạn, Đồng bộ `SERVICE` + `RENT` (`6A`), Xử lý Hóa đơn 3 Kịch bản (có Duyệt 4 Mắt ở Kịch bản 3) đến Sổ `credit_balance` & Quyết toán cuối kỳ *(Đã chọn)*:**
   - Chuẩn hóa công thức giao khoảng thời gian, mở khóa hủy `0 ₫` trước `start_date`, xử lý trọn vẹn 3 kịch bản hóa đơn (`chưa sinh`, `DRAFT` sửa trực tiếp có `audit_log`, sau `ISSUED` tạo đề nghị `invoice_adjustment` duyệt 4 mắt), đồng bộ cả `SERVICE` lẫn `RENT` khi hợp đồng kết thúc sớm, lưu tiền dư vào `credit_balance` để bù trừ tự động kỳ kế tiếp hoặc hoàn trả tách biệt khi kết thúc hợp đồng.
   - *Ưu điểm:* Bám sát 100% đặc tả PRD v2.0, bất biến chứng từ sau phát hành, bảo toàn tuyệt đối các tháng quá khứ `1..N-1` và khớp từng đồng trên cả báo cáo doanh thu, tiền thực thu lẫn sổ cái tiền cọc.
2. **Phương án 2 — Bán tự động (chỉ sửa `DRAFT`, chặn/bắt tính tay sau phát hành):** Dễ sót khoản bù trừ của cư dân khi sang tháng mới hoặc khi tất toán cuối kỳ.
3. **Phương án 3 — Chỉ cho hủy dịch vụ từ đầu kỳ kế tiếp:** Trái với `FR-029` (yêu cầu tính Pro-rata theo số ngày thực tế khi hủy giữa kỳ).

### 4.2. Các quyết định thiết kế do Chủ dự án chốt trực tiếp
- **Cơ chế duyệt 4 mắt ở Kịch bản 3 (Hóa đơn đã phát hành):** **Chọn Phương án A** — Mọi điều chỉnh/hủy hóa đơn sau khi `ISSUED` đều tạo bản ghi chờ duyệt `PENDING_APPROVAL` và bắt buộc phê duyệt 4 mắt (`OWNER` tòa nhà, hoặc `MANAGER` thứ hai cùng tòa qua `checkFourEyesOrWarn`, hoặc `SYS_ADMIN` dự phòng khi tòa chưa có `OWNER`).
- **Tên mã trạng thái vật lý trong CSDL:** **Chọn Phương án B** — Chuẩn hóa CSDL và toàn bộ mã nguồn theo đúng PRD Mục `13.2`: `service_subscription.status` dùng `'TERMINATED'`; `invoice.status` dùng `'ADJUSTED'` và `'VOID'`; sổ số dư tạm giữ dùng tên bảng `'credit_balance'`.
- **Chuẩn hóa rà soát PRD lần 2:** **Đồng ý toàn bộ 5 điểm chuẩn hóa** (`RBAC Mục 6.2 + RPC SECURITY DEFINER`, `KPI Tiền thực thu Mục 15.3 + RP-08`, `Idempotency-Key + bỏ adminPool bypass`, `Tab Lịch sử/Audit + xác nhận 2 bước gõ invoice_code khi VOID`, `Múi giờ Asia/Ho_Chi_Minh + updated_by + dynamic constraint lookup`) **và chọn Phương án `6A`** (tự động đồng bộ cả dòng `RENT` lẫn `SERVICE` trên các hóa đơn đã sinh khi hợp đồng hủy trước ngày ở / thanh lý sớm giữa kỳ / chuyển phòng).

---

## 5. Chi tiết thiết kế kỹ thuật

### 5.1. Migration Cơ sở dữ liệu & RLS (`044_service_termination_invoice_adjustments_and_credit_balance.sql`)

> **Lưu ý phối hợp đánh số Migration & Rollback (`PRD Mục 14.5`):** Hiện nhánh `main` đang dừng ở `043_service_subscription_vehicle_plates.sql`. Nếu thi công bản thiết kế này trước các kế hoạch M06 chưa chạy thì đặt số `044_...sql`; nếu các migration của M06 đã chạy trước thì đánh số nối tiếp ngay sau migration cuối cùng hiện có trong `api/src/db/migrations/`. Toàn bộ thao tác gỡ/thay `CHECK` và `UNIQUE` constraint bên dưới phải tra cứu động qua `pg_constraint` trong khối `DO $$ ... END $$;` (không phụ thuộc cứng vào tên constraint mặc định) và đính kèm khối hướng dẫn SQL Rollback ở đầu file migration.

1. **Chuẩn hóa bảng giá dịch vụ 3 tầng trên `service_catalog` (`FR-065`):**
   - Dùng khối `DO $$` tra `pg_constraint` gỡ ràng buộc `UNIQUE (org_id, code)` cũ trên `service_catalog` (vốn chặn tạo giá riêng theo từng tòa cùng mã `code`), thay bằng bộ Partial Unique Index chuẩn:
     - `CREATE UNIQUE INDEX IF NOT EXISTS idx_service_catalog_org_default_code ON service_catalog(org_id, code) WHERE building_id IS NULL;` (1 giá mặc định toàn tổ chức cho mỗi mã dịch vụ).
     - `CREATE UNIQUE INDEX IF NOT EXISTS idx_service_catalog_building_code ON service_catalog(org_id, building_id, code) WHERE building_id IS NOT NULL;` (mỗi tòa có thể cấu hình 1 giá ghi đè riêng cho mã dịch vụ đó).

2. **Chuẩn hóa mã trạng thái `service_subscription.status` → `'TERMINATED'` (`Mục 13.2`):**
   - Tra `pg_constraint` gỡ `CHECK` cũ trên `service_subscription.status`, chạy `UPDATE service_subscription SET status = 'TERMINATED' WHERE status = 'CANCELLED';`, và gắn `service_subscription_status_check CHECK (status IN ('PENDING_APPROVAL', 'ACTIVE', 'CANCELLATION_PENDING', 'TERMINATED', 'REJECTED'))`.

3. **Chuẩn hóa mã trạng thái `invoice.status` → `'ADJUSTED'`, `'VOID'` & Ràng buộc toàn vẹn (`Mục 13.2`, `Mục 13.3`):**
   - Bổ sung cột `credit_offset_amount BIGINT NOT NULL DEFAULT 0 CHECK (credit_offset_amount >= 0)` trên bảng `invoice`.
   - Chuẩn hóa dữ liệu cũ (nếu có dòng `paid_amount > total_amount` lịch sử từ thanh toán thừa trước đây): `UPDATE invoice SET paid_amount = LEAST(GREATEST(0, paid_amount), GREATEST(0, total_amount)) WHERE paid_amount > total_amount OR paid_amount < 0;`.
   - Thêm ràng buộc toàn vẹn `invoice_paid_lte_total_check CHECK (paid_amount >= 0 AND total_amount >= 0 AND paid_amount <= total_amount)` (`Mục 13.3`).
   - Tra `pg_constraint` gỡ `CHECK` cũ trên `invoice.status`, chạy `UPDATE invoice SET status = 'VOID' WHERE status = 'CANCELLED';`, và gắn `invoice_status_check CHECK (status IN ('DRAFT', 'ISSUED', 'PARTIALLY_PAID', 'PAID', 'OVERDUE', 'ADJUSTED', 'VOID'))`.

4. **Bổ sung cột tham chiếu & công thức giải trình trên `invoice_line` (`AC-015.3`, `Mục 13.2`):**
   - `subscription_id UUID REFERENCES service_subscription(id) ON DELETE SET NULL`
   - `credit_id UUID` (gắn FK tới `credit_balance(id) ON DELETE SET NULL`)
   - `adjustment_id UUID` (gắn FK tới `invoice_adjustment(id) ON DELETE SET NULL`)
   - `formula_meta JSONB` (lưu chi tiết công thức tính để giải trình trên UI/PDF: `{ billing_mode, price_source, unit_price, quantity, active_days, days_in_month, overlap_start, overlap_end, raw_amount, rounded_amount }`)

5. **Tạo bảng `invoice_adjustment` (Phê duyệt 4 mắt cho điều chỉnh / hủy hóa đơn sau phát hành — `FR-034`, `FR-035`, `Mục 13`):**
   ```sql
   CREATE TABLE IF NOT EXISTS invoice_adjustment (
     id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     org_id            UUID NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
     building_id       UUID NOT NULL REFERENCES building(id) ON DELETE CASCADE,
     invoice_id        UUID NOT NULL REFERENCES invoice(id) ON DELETE CASCADE,
     subscription_id   UUID REFERENCES service_subscription(id) ON DELETE SET NULL,
     adjustment_target TEXT NOT NULL DEFAULT 'MANUAL'
                       CHECK (adjustment_target IN ('SERVICE', 'RENT', 'MANUAL')),
     action_type       TEXT NOT NULL CHECK (action_type IN ('ADJUST', 'VOID')),
     delta_amount      BIGINT NOT NULL DEFAULT 0,
     reason            TEXT NOT NULL,
     formula_meta      JSONB,
     status            TEXT NOT NULL DEFAULT 'PENDING_APPROVAL'
                       CHECK (status IN ('PENDING_APPROVAL', 'APPROVED', 'REJECTED')),
     rejection_reason  TEXT,
     created_by        UUID REFERENCES app_user(id) ON DELETE SET NULL,
     updated_by        UUID REFERENCES app_user(id) ON DELETE SET NULL,
     approved_by       UUID REFERENCES app_user(id) ON DELETE SET NULL,
     approved_at       TIMESTAMPTZ,
     created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CHECK (
       (action_type = 'VOID' AND delta_amount = 0)
       OR (action_type = 'ADJUST' AND delta_amount <> 0)
     )
   );
   ```
   - Partial Unique Index chống sinh trùng đề nghị đang chờ duyệt:
     - `idx_invoice_adj_pending_sub ON invoice_adjustment(invoice_id, subscription_id) WHERE subscription_id IS NOT NULL AND status = 'PENDING_APPROVAL'`
     - `idx_invoice_adj_pending_rent ON invoice_adjustment(invoice_id) WHERE adjustment_target = 'RENT' AND status = 'PENDING_APPROVAL'`
     - `idx_invoice_adj_pending_void ON invoice_adjustment(invoice_id) WHERE action_type = 'VOID' AND status = 'PENDING_APPROVAL'`

6. **Tạo bảng `credit_balance` (Sổ số dư tạm giữ hợp đồng — `Mục 13`, `Mục 13.2`, `FR-033`, `FR-040`):**
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
     reason_type           TEXT NOT NULL CHECK (reason_type IN (
                             'SERVICE_TERMINATION',
                             'CONTRACT_TERMINATION_RENT',
                             'INVOICE_ADJUSTMENT',
                             'OVERPAYMENT',
                             'TRANSFERRED_IN'
                           )),
     amount                BIGINT NOT NULL CHECK (amount > 0),
     applied_amount        BIGINT NOT NULL DEFAULT 0 CHECK (applied_amount >= 0 AND applied_amount <= amount),
     status                TEXT NOT NULL DEFAULT 'AVAILABLE'
                           CHECK (status IN ('AVAILABLE', 'PARTIALLY_APPLIED', 'APPLIED', 'REFUNDED_IN_SETTLEMENT', 'TRANSFERRED', 'VOID')),
     description           TEXT NOT NULL,
     created_by            UUID REFERENCES app_user(id) ON DELETE SET NULL,
     updated_by            UUID REFERENCES app_user(id) ON DELETE SET NULL,
     created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
   );
   ```
   - Partial Unique Index chống nhân đôi tuyệt đối (Idempotency ở tầng DB):
     - `idx_credit_balance_unique_adj ON credit_balance(source_adjustment_id) WHERE source_adjustment_id IS NOT NULL AND status <> 'VOID'`
     - `idx_credit_balance_unique_payment ON credit_balance(source_payment_id) WHERE source_payment_id IS NOT NULL AND status <> 'VOID'`
     - `idx_credit_balance_contract_avail ON credit_balance(contract_id, created_at) WHERE status IN ('AVAILABLE', 'PARTIALLY_APPLIED')`

7. **Chuẩn hóa RLS theo `PRD Mục 6.2` & Hàm RPC phê duyệt 4 mắt hẹp `SECURITY DEFINER`:**
   - **Khóa rò rỉ `DRAFT` đối với `RESIDENT` (`AC-003.2`) & Gỡ quyền ghi của `SYS_ADMIN` / `RESIDENT` trên bảng tài chính (`PRD Mục 6.2`):**
     - `rls_invoice_select`: `is_org_admin() OR building_id IN (SELECT building_id FROM get_user_assigned_buildings()) OR (status <> 'DRAFT' AND (contract_id IN (SELECT contract_id FROM get_resident_contract_ids()) OR tenant_id IN (SELECT tenant_id FROM get_resident_tenant_ids())))`.
     - `rls_invoice_modify` & `rls_invoice_line_modify`: chỉ cho phép `MANAGER` trên các tòa được phân công (`building_id IN (SELECT building_id FROM get_manager_building_ids())`); gỡ cả `is_org_admin()` lẫn `is_resident()`.
     - `rls_service_catalog_modify`: chỉ cho phép `is_manager() AND org_id = get_current_user_org_id() AND (building_id IS NULL OR building_id IN (SELECT building_id FROM get_manager_building_ids()))` (gỡ `is_org_admin()` ghi danh mục dịch vụ theo `PRD 6.2` dòng 190).
     - `rls_service_sub_insert` / `rls_service_sub_update` / `rls_service_sub_delete`: giữ nhánh cư dân gửi đăng ký/yêu cầu hủy hợp lệ của mình và nhánh `MANAGER` trên `get_manager_building_ids()` (đổi `'CANCELLED'` → `'TERMINATED'` ở `rls_service_sub_delete`); gỡ `is_org_admin()` khỏi quyền ghi trực tiếp.
     - `rls_payment_insert` / `rls_payment_update` & `rls_receivable_modify`: chỉ cho phép `MANAGER` thuộc `get_manager_building_ids()` (cùng nhánh `RESIDENT` gửi báo thanh toán ở `rls_payment_insert` trên hóa đơn `status <> 'DRAFT'`); gỡ `is_org_admin()`.
     - `invoice_adjustment` & `credit_balance`: bật `ENABLE` + `FORCE ROW LEVEL SECURITY`; `SELECT` mở cho `is_org_admin()`, `get_user_assigned_buildings()` (`OWNER` + `MANAGER`), và `RESIDENT` trên hợp đồng của mình (với `invoice_adjustment` chỉ hiển thị cho cư dân khi `status = 'APPROVED'`); `INSERT` trên `invoice_adjustment` và `INSERT`/`UPDATE` trên `credit_balance` trong luồng vận hành thường nhật chỉ mở cho `MANAGER` của `get_manager_building_ids()`.
   - **Hàm RPC hẹp `fn_resolve_invoice_adjustment(p_adjustment_id UUID, p_decision TEXT, p_rejection_reason TEXT DEFAULT NULL, p_allow_self_approval BOOLEAN DEFAULT FALSE)` (`SECURITY DEFINER SET search_path = public, pg_temp`):**
     - Xác thực `v_actor_id := get_current_user_id()` bắt buộc là một trong 3 chủ thể duyệt hợp lệ của `adj.building_id`:
       1. `OWNER` đang hoạt động của tòa (`adj.building_id IN (SELECT building_id FROM get_owner_building_ids())`), hoặc
       2. `MANAGER` được gán tòa (`adj.building_id IN (SELECT building_id FROM get_manager_building_ids())`), hoặc
       3. `SYS_ADMIN` (`is_org_admin()`) **chỉ khi** `NOT building_has_active_owner(adj.building_id)`.
     - Kiểm tra nguyên tắc 4 mắt ngay trong hàm: nếu `adj.created_by IS NOT NULL AND adj.created_by = v_actor_id AND NOT p_allow_self_approval` → raise lỗi `SELF_APPROVAL`.
     - Thực thi nguyên tử toàn bộ cập nhật `invoice_adjustment`, chèn dòng `invoice_line` mới (`ADJUSTMENT`), cập nhật `invoice` (`total_amount`, `paid_amount`, `credit_offset_amount`, `status`), đồng bộ `receivable`, tạo bản ghi `credit_balance` (nếu dư tiền đã đóng) và ghi `audit_log` giá trị `before`/`after`. Nhờ đó `OWNER` và `SYS_ADMIN` duyệt 4 mắt an toàn mà **vẫn bị chặn 100% nếu cố tình chạy câu lệnh `UPDATE invoice` trực tiếp**!
   - **Mở rộng `rls_audit_log_select` (`038` + `RP-08` + Tab Audit Hóa đơn):**
     - Bảo toàn toàn bộ nhánh hiện có của `038_audit_log_deposit_owner_scope.sql` (`building`, `apartment`, `reservation`, `contract`, `deposit`, `deposit_transaction`, `invoice`, `payment`) và mở rộng thêm các thực thể `invoice_line`, `invoice_adjustment`, `credit_balance`, `service_subscription` cho **cả `is_owner()` (trên `get_owner_building_ids()`) lẫn `is_manager()` (trên `get_manager_building_ids()`)** để Quản lý và Chủ nhà xem được trọn vẹn lịch sử kiểm toán của hóa đơn (kể cả các dòng do đồng nghiệp, Chủ nhà hoặc job tự động tạo).

---

### 5.2. Engine Phân giải Đơn giá 3 Tầng & Tính phí Pro-rata (`api/src/services/serviceBilling.js`)

Tập trung toàn bộ logic múi giờ `Asia/Ho_Chi_Minh`, định giá 3 tầng, làm tròn và tính khoảng ngày hiệu lực vào module dùng chung `serviceBilling.js`:

1. **Helper ngày theo múi giờ Việt Nam (`todayVietnamYmd` — `PRD Mục 13.4`):**
   - Chuẩn hóa `todayVietnamYmd(now = new Date())` dùng `Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)` trả về `'YYYY-MM-DD'`. Thay thế toàn bộ `new Date().toISOString().slice(0, 10)` tại `services.js`, `resident.js`, `invoices.js`, `contracts.js`, `daily.js`.

2. **Phân giải đơn giá 3 tầng (`resolveServiceUnitPrice` — `FR-065`):**
   - **Với hóa đơn đã phát hành (`status != 'DRAFT'`) khi lập điều chỉnh:** lấy trực tiếp `unit_price` và `quantity` đã khóa trên dòng `invoice_line` (`item_type = 'SERVICE'` hoặc `'RENT'`) của kỳ đó để sửa bảng giá về sau không bao giờ làm lệch số tiền kỳ đã phát hành (`FR-065`).
   - **Khi khởi tạo gói đăng ký dịch vụ (`services.js`, `resident.js`, `contracts.js`) và khi tính cho kỳ chưa phát hành (`DRAFT`, sinh hóa đơn mới, dựng lịch dự kiến):** phân giải theo thứ tự ưu tiên nghiêm ngặt:
     1. **Giá ghi đè trong hợp đồng (`PRICE_SOURCE = 'CONTRACT_OVERRIDE'`):** `contract_service_price` có `effective_from <= cuối_kỳ` (khớp `service_code` trực tiếp hoặc qua ánh xạ chuẩn `INTERNET_FIBER`/`INTERNET` → `INTERNET`, `MANAGEMENT_FEE`/`MANAGEMENT` → `COMMON_SERVICE`).
     2. **Đơn giá chốt riêng trên bản ghi đăng ký dịch vụ của hợp đồng (`PRICE_SOURCE = 'SUBSCRIPTION_SNAPSHOT'`):** nếu trên `service_subscription` đã có `unit_price` khác với đơn giá của dòng danh mục `service_catalog` được trỏ trực tiếp (ví dụ giá thỏa thuận riêng đã in vào Điều 5 hợp đồng ký), giữ đúng `sub.unit_price` của hợp đồng đó.
     3. **Giá riêng của tòa nhà → Giá mặc định của tổ chức (`BUILDING_CATALOG` → `DEFAULT_CATALOG`):** tra cứu bản ghi `service_catalog` đang hoạt động có `building_id = contract.building_id AND UPPER(code) = UPPER(sub.service_code)`, sau đó mới tới bản ghi mặc định `building_id IS NULL AND UPPER(code) = UPPER(sub.service_code)` (và fallback về `sub.unit_price` khi gọi hàm đồng bộ thuần không truyền danh mục).

3. **Quy tắc cửa sổ hiệu lực theo trạng thái (`resolveSubscriptionEffectiveWindow`):**
   - `REJECTED`: không tính phí (`activeDays = 0`, `amount = 0`).
   - `TERMINATED`:
     - Nếu `!sub.end_date || toDateStr(sub.end_date) < toDateStr(sub.start_date)` → hủy trước ngày bắt đầu hoặc thu hồi yêu cầu chưa duyệt → **`activeDays = 0`, `amount = 0` ở mọi kỳ**.
     - Ngược lại (`end_date >= start_date`) → khoảng hiệu lực đóng `[start_date .. end_date]` (tính gộp hai ngày đầu mút).
   - `ACTIVE` hoặc `CANCELLATION_PENDING` (hoặc `PENDING_APPROVAL` khi dựng lịch dự kiến của hợp đồng nháp):
     - Coi là đang mở `[start_date .. +∞)`. Khi gói còn ở `CANCELLATION_PENDING` (chờ Quản lý xác nhận), hóa đơn vẫn tính đủ như đang hoạt động; ngay khi Quản lý xác nhận chuyển sang `TERMINATED`, hệ thống xử lý lại theo kịch bản tương ứng của hóa đơn kỳ đó.

4. **Công thức tính phí trong kỳ `targetPeriod = 'YYYY-MM'` (`computeSubscriptionPeriodCharge` & `computeContractRentPeriodCharge`):**
   - Gọi `[boundStart .. boundEnd]` là biên ngày của kỳ trong tháng (`[monthStart .. monthEnd]`, tổng số ngày thực tế của tháng là `daysInMonth` từ `28..31`; với `invoiceSchedule.js` kẹp theo `[periodStart .. periodEnd]` của hợp đồng):
     - `overlapStart = max(effectiveStart, boundStart)`
     - `overlapEnd = effectiveEnd ? min(effectiveEnd, boundEnd) : boundEnd`
     - Nếu `overlapEnd < overlapStart` → `activeDays = 0`, `amount = 0`, `isProrated = false`.
     - Ngược lại:
       - `activeDays = diffDaysYmd(overlapStart, overlapEnd) + 1`
       - `rawAmount = (activeDays >= daysInMonth) ? (effectiveUnitPrice * quantity) : ((effectiveUnitPrice * quantity * activeDays) / daysInMonth)`
       - `amount = roundVND(rawAmount)` (làm tròn hàng nghìn `ROUND(x, -3)` theo `Mục 10.3`).
   - Trả kèm `formula_meta` và chuỗi giải trình công thức (ví dụ: `"Gửi xe máy (Pro-rata 15/30 ngày: 01/06–15/06/2026 × 2 SL × 200.000 ₫ ≈ 200.000 ₫)"` hoặc `"Tiền thuê phòng (Pro-rata thanh lý sớm 12/30 ngày: 01/06–12/06/2026 × 12.000.000 ₫ ≈ 4.800.000 ₫)"`) để ghi vào `invoice_line` (`AC-015.3`).

5. **Bảo toàn tuyệt đối các kỳ quá khứ (`1 .. N-1`):**
   - Cập nhật truy vấn lọc gói dịch vụ trong `generateInvoicesCore` (`api/src/routes/invoices.js`) và `buildExpectedInvoiceSchedule` (`api/src/services/invoiceSchedule.js`): lấy mọi gói `status IN ('ACTIVE', 'CANCELLATION_PENDING')` hoặc `(status = 'TERMINATED' AND end_date IS NOT NULL AND end_date >= start_date AND end_date >= monthStart)` có `start_date <= monthEnd`.
   - Hệ quả kiểm chứng: nếu cư dân dùng dịch vụ suốt 5 tháng đầu, đến ngày `15` của tháng thứ `6` mới hủy (`TERMINATED`, `end_date = 15/tháng_6`):
     - Tháng `1..5`: `overlap = [01/M .. cuối_tháng_M]` → `activeDays === daysInMonth` → `expectedAmount === currentlyBilled` → `delta === 0` (**không chạm tới hóa đơn tháng 1–5, kể cả khi xem lại lịch dự kiến hay chạy sinh bù kỳ cũ**).
     - Tháng `6`: tính đúng `15` ngày thực dùng.
     - Tháng `7` trở đi: `end_date < 01/tháng_7` → không đưa vào hóa đơn nữa.

---

### 5.3. Luồng Hủy Dịch vụ (`TERMINATED`) & Đồng bộ `SERVICE` + `RENT` Khi Hợp đồng Kết thúc (`6A`)

1. **Ghi nhận hủy dịch vụ trên API (`resident.js` & `services.js` — thực thi qua `getUserClient(req)`):**
   - Tương thích ngược đầu vào: nếu request gửi `status = 'CANCELLED'`, chuẩn hóa tự động sang `'TERMINATED'`.
   - **Rút yêu cầu chưa duyệt (`sub.status === 'PENDING_APPROVAL'`):** Cư dân (`PATCH /api/v1/resident/services/:id/cancel`) hoặc Quản lý hủy chuyển thẳng sang `'TERMINATED'`, `end_date = addDaysYmd(subStart, -1)`, `prorata_amount = 0`, ghi `audit_log`.
   - **Hủy trước ngày bắt đầu sử dụng (`todayVietnam < subStart` trên gói `ACTIVE` / `CANCELLATION_PENDING`):**
     - Cư dân gửi yêu cầu hủy: không ép chọn ngày `>= subStart`; gán `end_date = addDaysYmd(subStart, -1)`, `prorata_amount = 0`, chuyển sang `'CANCELLATION_PENDING'`.
     - Quản lý hủy / xác nhận hủy (`PATCH /api/v1/service-subscriptions/:id` → `'TERMINATED'`): nếu `end_date < subStart` (mặc định khi `todayVietnam < subStart`), chốt `end_date = addDaysYmd(subStart, -1)`, `prorata_amount = 0`.
   - **Hủy sau khi đã vào kỳ sử dụng (`todayVietnam >= subStart`):**
     - Cư dân gửi yêu cầu hủy: yêu cầu `todayVietnam <= effEnd <= contractEnd` (chặn cư dân tự lùi ngày quá khứ), chuyển sang `'CANCELLATION_PENDING'`. Cho phép cư dân **Rút yêu cầu hủy** (`PATCH /api/v1/resident/services/:id/withdraw-cancel`: `'CANCELLATION_PENDING'` → `'ACTIVE'`, `end_date = NULL`) khi Quản lý chưa duyệt.
     - Quản lý xác nhận hủy (`PATCH /api/v1/service-subscriptions/:id`):
       - Cho phép chọn `end_date` bàn giao thực tế (`subStart <= end_date <= contractEnd`), hoặc tích chọn *"Chưa phát sinh sử dụng thực tế (0 ₫)"* (`end_date = addDaysYmd(subStart, -1)`, `prorata_amount = 0`).
       - Cho phép Quản lý từ chối hủy (giữ lại dịch vụ): `'CANCELLATION_PENDING'` → `'ACTIVE'`, `end_date = NULL`.
     - Chặn sửa đổi các bản ghi đã kết thúc (`'TERMINATED'` hoặc `'REJECTED'` → `409 INVALID_STATUS`).
     - Mọi thao tác cập nhật trên `PATCH /api/v1/service-subscriptions/:id` đều bắt buộc ghi `audit_log` (`before` / `after`).

2. **Đóng tự động đăng ký dịch vụ & Đồng bộ cả `SERVICE` lẫn `RENT` khi Hợp đồng kết thúc (`closeContractBillingAndSubscriptionsInTx` — Quyết định `6A`):**
   - Gắn vào cùng DB transaction của toàn bộ 6 luồng kết thúc hợp đồng:
     1. `POST /api/v1/contracts/:id/cancel` (hủy nháp/chờ duyệt → đặt `end_date = start_date - 1 day`, `prorata_amount = 0`, `status = 'TERMINATED'`).
     2. `POST /api/v1/contracts/:id/terminate` (thanh lý trực tiếp trước hoặc sau ngày nhận phòng).
     3. `POST /api/v1/contracts/:id/terminate/approve` (phê duyệt thanh lý).
     4. `POST /api/v1/contracts/requests/:id/approve` (nhánh `TERMINATED_NOW`).
     5. `POST /api/v1/contracts/:id/transfer-room` (đóng hợp đồng căn cũ khi chuyển phòng).
     6. `runDailyJobs()` trong `api/src/jobs/daily.js` (Bước 1a: `TERMINATION_PENDING` → `TERMINATED`; Bước 1b: `ACTIVE`/`RENEWAL_PENDING` → `EXPIRED`).
   - **Quy tắc xác định `lastActiveDay` của hợp đồng:**
     - Nếu chưa nhận phòng (`!movedIn`, tức `rawEnd < contract.start_date` hoặc thanh lý trước ngày `start_date`): hợp đồng có **0 ngày ở thực tế** (`lastActiveDay = addDaysYmd(contract.start_date, -1)`).
     - Nếu đã nhận phòng (`movedIn`): với hợp đồng hết hạn tự nhiên ngày mùng 1 đầu tháng theo nửa mở `[start_date, end_date)` (`DD === '01' && rawEnd > contract.start_date` ở luồng hết hạn tự nhiên) thì `lastActiveDay = addDaysYmd(rawEnd, -1)` (khớp 100% với quy tắc tính `RENT`); với thanh lý sớm / chuyển phòng có ngày bàn giao cụ thể `terminationDate >= contract.start_date` thì `lastActiveDay = terminationDate`.
   - **Đồng bộ khép kín trong cùng transaction (`6A`):**
     1. Chuyển toàn bộ `service_subscription` đang mở (`PENDING_APPROVAL`, `ACTIVE`, `CANCELLATION_PENDING`) của hợp đồng sang `'TERMINATED'` với `end_date` kẹp không vượt quá `lastActiveDay` (`addDaysYmd(sub.start_date, -1)` nếu `!movedIn` hoặc `lastActiveDay < sub.start_date`).
     2. Rà soát toàn bộ các hóa đơn `status != 'VOID'` đã sinh của hợp đồng:
        - Tính `expectedServiceCharge` cho từng gói dịch vụ và `expectedRentCharge` cho dòng `RENT` theo cửa sổ hiệu lực `[contract.start_date .. lastActiveDay]` (`0 ₫` nếu `!movedIn` hoặc kỳ hóa đơn bắt đầu sau `lastActiveDay`; Pro-rata theo số ngày ở thực tế nếu kỳ kết thúc rơi giữa tháng; giữ nguyên 100% nếu kỳ hóa đơn nằm trọn trước `lastActiveDay`).
        - **Nếu hóa đơn đang `DRAFT` (Kịch bản 2):** cập nhật/xóa trực tiếp dòng `SERVICE` và dòng `RENT`, tính lại tổng bản nháp và hoàn lại `credit_balance` dư (nếu có). Đặc biệt, nếu sau khi đồng bộ mà toàn bộ các dòng thu phí của bản `DRAFT` đều bằng `0 ₫` (`subtotal_amount === 0`) và `paid_amount === 0` (ví dụ hủy trước ngày ở hoặc bản nháp của kỳ tương lai sau ngày trả phòng), tự động chuyển bản `DRAFT` rỗng đó sang `'VOID'` (ghi `audit_log` `before`/`after`) để không chặn điều kiện tiên quyết `no_draft_invoices` khi lập quyết toán cọc!
        - **Nếu hóa đơn đã phát hành (Kịch bản 3):**
          - Trường hợp toàn bộ kỳ hóa đơn không còn phát sinh khoản phải thu nào (`expectedTotal === 0`, ví dụ thanh lý trước ngày ở hoặc hóa đơn kỳ tương lai chưa phát sinh điện/nước) **và** `paid_amount === 0`: tự động tạo 1 đề nghị `invoice_adjustment` (`action_type = 'VOID'`, `status = 'PENDING_APPROVAL'`) chờ duyệt 4 mắt.
          - Các trường hợp còn lại (giảm Pro-rata giữa kỳ hoặc khách đã đóng tiền trước `paid_amount > 0`): tự động tạo đề nghị `invoice_adjustment` (`action_type = 'ADJUST'`, `status = 'PENDING_APPROVAL'`) cho từng gói `SERVICE` có `delta < 0` (`adjustment_target = 'SERVICE'`) **và** cho dòng `RENT` có `delta < 0` (`adjustment_target = 'RENT'`). Khi được duyệt 4 mắt, phần tiền thuê/dịch vụ khách đã đóng dư sẽ tự động kết chuyển vào `credit_balance` (`reason_type = 'CONTRACT_TERMINATION_RENT'` / `'SERVICE_TERMINATION'`) để đối trừ/hoàn trả minh bạch ở bước quyết toán cuối kỳ mà không bao giờ xâm phạm tiền cọc gốc (`FR-068`).

---

### 5.4. Xử lý Hóa đơn theo 3 Kịch bản PRD, `Idempotency-Key`, Duyệt 4 Mắt & Sổ `credit_balance`

Khi một gói `service_subscription` chuyển sang `'TERMINATED'` (hoặc khi `closeContractBillingAndSubscriptionsInTx` chạy ở mục `5.3.2`):
- Khóa `FOR UPDATE` các hóa đơn `status != 'VOID'` của hợp đồng.
- Với mỗi mục phí cần đồng bộ (`SERVICE` của `sub.id`, và `RENT` nếu hợp đồng kết thúc sớm):
  - Tính tổng tiền đã tính + đang chờ duyệt của mục đó trên hóa đơn:
    `currentlyAccounted = sum(dòng gốc của mục) + sum(dòng ADJUSTMENT đã duyệt của mục) + sum(invoice_adjustment PENDING_APPROVAL của mục)`.
  - `delta = roundVND(expectedAmount - currentlyAccounted)`.
  - Nếu `delta >= 0`: bỏ qua (bảo toàn 100% các kỳ trước).
  - Nếu `delta < 0`: xử lý theo đúng trạng thái của `inv`:

#### 5.4.1. Kịch bản 1 — Hóa đơn kỳ hiện tại CHƯA được sinh (hủy trước `billing_day`)
- Không có bản ghi `invoice` của kỳ hiện tại trong danh sách cần điều chỉnh.
- Đến `billing_day` của hợp đồng (`FR-066`) hoặc khi chạy `POST /api/v1/invoices/generate-batch` (`FR-033`, có `idempotencyGuard()`), `generateInvoicesCore` tự động tính Pro-rata chính xác cho các ngày hiệu lực trong kỳ (hoặc bỏ qua nếu `0 ₫`), ghi `subscription_id` + `formula_meta` vào `invoice_line` và tạo hóa đơn ở trạng thái `DRAFT`. Từ kỳ sau trở đi không còn đưa vào hóa đơn.

#### 5.4.2. Kịch bản 2 — Hóa đơn kỳ hiện tại đang ở trạng thái nháp (`DRAFT`)
- **Tự động cập nhật dòng phí trên bản `DRAFT`:**
  - Chụp `beforeSnapshot` (hóa đơn + danh sách `invoice_line` trước khi sửa).
  - Nếu `expectedAmount === 0`: xóa dòng phí tương ứng khỏi bản `DRAFT`.
  - Nếu `expectedAmount > 0`: cập nhật dòng phí (`amount = expectedAmount`, `description`, `formula_meta`, `subscription_id`).
  - Tính lại tổng bản `DRAFT` (`recalculateDraftInvoiceTotals`): nếu bản `DRAFT` đang có dòng cấn trừ `credit_balance` (`credit_offset_amount > 0`) mà `subtotal_amount` mới giảm thấp hơn `credit_offset_amount`, tự động nhả phần `credit_balance` dư về lại trạng thái `'AVAILABLE'` / `'PARTIALLY_APPLIED'` để không làm âm hóa đơn hoặc mất tín dụng của cư dân.
  - Ghi `audit_log` bắt buộc (`action = 'UPDATE_DRAFT_INVOICE_LINES'`, `entity = 'invoice'`, `before = beforeSnapshot`, `after = afterSnapshot`) theo `AC-020.1`.
- **Hỗ trợ Quản lý / Kế toán tòa nhà rà soát & sửa trực tiếp dòng phí trên bản `DRAFT` trước khi phát hành (`FR-033`, `FR-034`, `AC-020.1`):**
  - Bổ sung các endpoint chỉ cho phép `MANAGER` tòa nhà thao tác khi `invoice.status === 'DRAFT'` (trả `409 IMMUTABLE_AFTER_ISSUED` nếu đã phát hành):
    - `POST /api/v1/invoices/:id/lines` (có `idempotencyGuard()` — thêm dòng phí nháp mới).
    - `PATCH /api/v1/invoices/:id/lines/:lineId` (sửa mô tả, số lượng, đơn giá dòng phí nháp — tự làm tròn `roundVND`).
    - `DELETE /api/v1/invoices/:id/lines/:lineId` (xóa dòng phí nháp; nếu xóa dòng `credit_id`, hoàn trả ngay `applied_amount` về `credit_balance`).
    - `POST /api/v1/invoices/:id/issue` (có `idempotencyGuard()` — alias chuẩn REST theo PRD Mục `14.3` bên cạnh `PATCH /api/v1/invoices/:id/status` với `status = 'ISSUED'`).
  - Mọi thao tác thêm/sửa/xóa dòng trên bản `DRAFT` đều ghi `audit_log` đầy đủ giá trị `before` và `after` (`AC-020.1`).
  - Khi hủy một hóa đơn `DRAFT` (`status = 'VOID'`): cho phép `MANAGER` tòa nhà thực hiện trực tiếp kèm lý do bắt buộc và mã xác nhận `confirm_invoice_code === invoice.invoice_code` (khi gọi từ thao tác hủy chủ động trên UI theo `PRD Mục 16.2`), hoàn trả toàn bộ `credit_balance` đã tạm gắn trên bản `DRAFT` và ghi `audit_log`.

#### 5.4.3. Kịch bản 3 — Hóa đơn kỳ hiện tại ĐÃ phát hành (`ISSUED`, `PARTIALLY_PAID`, `PAID`, `OVERDUE`, `ADJUSTED`)
- **Khóa chỉnh sửa trực tiếp (`FR-034`, `FR-035`, `NFR-016`):**
  - Trên `PATCH /api/v1/invoices/:id/status` (chuẩn hóa tương thích ngược `status = 'CANCELLED'` → `'VOID'`):
    1. Nếu `targetStatus === 'VOID' && Number(inv.paid_amount) > 0`: trả ngay `409 ALREADY_PAID` (giữ đúng mã lỗi nghiệp vụ của `FR-035`).
    2. Nếu `inv.status !== 'DRAFT'` mà request truyền `adjustment_amount` hoặc `targetStatus === 'VOID'`: trả `409 REQUIRES_FOUR_EYES_ADJUSTMENT` hướng dẫn lập đề nghị qua `POST /api/v1/invoices/:id/adjust`.
- **Tạo đề nghị điều chỉnh / hủy chờ phê duyệt 4 mắt (`invoice_adjustment`):**
  1. **Tự động khi xác nhận `TERMINATED` dịch vụ hoặc kết thúc hợp đồng sớm:** chèn bản ghi `invoice_adjustment` (`adjustment_target = 'SERVICE' | 'RENT'`, `action_type = 'ADJUST' | 'VOID'`, `delta_amount`, `reason` giải trình rõ ngày kết thúc & công thức Pro-rata, `formula_meta`, `status = 'PENDING_APPROVAL'`, `created_by = actorId`, `updated_by = actorId`). Gửi thông báo `INVOICE_ADJUSTMENT_PENDING` tới `OWNER` của tòa nhà và các `MANAGER` khác cùng tòa (hoặc `SYS_ADMIN` nếu tòa chưa có `OWNER`).
  2. **Thủ công qua `POST /api/v1/invoices/:id/adjust` (`FR-035`, `Mục 14.3`, `Mục 16.2`):**
     - Bắt buộc qua `idempotencyGuard()` (`Idempotency-Key`), chỉ mở cho `MANAGER` của tòa nhà.
     - Nhận `{ action_type: 'ADJUST' | 'VOID', delta_amount, reason, confirm_invoice_code }`, bắt buộc có `reason` không rỗng.
     - Nếu `action_type = 'VOID'`: kiểm tra `inv.paid_amount === 0` (`409 ALREADY_PAID` nếu đã thu tiền) và nếu có truyền `confirm_invoice_code` (bắt buộc trên UI theo `PRD Mục 16.2`) thì phải khớp chính xác `inv.invoice_code`.
     - Lưu `invoice_adjustment (status = 'PENDING_APPROVAL', created_by = req.user.sub, updated_by = req.user.sub)`, ghi `audit_log` và gửi thông báo chờ duyệt.
  3. **Danh sách & Phê duyệt / Từ chối 4 mắt (`OWNER` tòa nhà / `MANAGER` thứ hai cùng tòa / `SYS_ADMIN` dự phòng):**
     - `GET /api/v1/invoices/adjustments` (lọc theo `building_id`, `status`, `invoice_id`) và trả kèm mảng `adjustments` trong `GET /api/v1/invoices/:id`.
     - `POST /api/v1/invoices/:id/adjustments/:adjId/approve` & `POST /api/v1/invoices/:id/adjustments/:adjId/reject` (đều gắn `idempotencyGuard()`):
       - **Quyền phê duyệt (`PRD Mục 6.1–6.2`):** `OWNER` sở hữu tòa nhà đó, hoặc `MANAGER` được phân công tòa nhà đó, hoặc `SYS_ADMIN` **chỉ khi** tòa chưa có `OWNER` hoạt động (`!building_has_active_owner(building_id)`).
       - **Kiểm tra 4 mắt bắt buộc:** gọi `checkFourEyesOrWarn({ orgId, actorId: req.user.sub, creatorId: adj.created_by, entity: 'invoice_adjustment', entityId: adj.id, actionContext: 'INVOICE_ADJUST_APPROVE' })`. Nếu `!allowed` → trả `403 SELF_APPROVAL` (*"Nguyên tắc 4 mắt: Người lập đề nghị điều chỉnh/hủy hóa đơn không được tự phê duyệt."*).
       - **Thực thi nguyên tử qua RPC `fn_resolve_invoice_adjustment`:**
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
               - **Nếu `excessPaid > 0`:** ghi nhận ngay bản ghi mới vào bảng `credit_balance` (`amount = excessPaid`, `applied_amount = 0`, `status = 'AVAILABLE'`, `reason_type = adj.adjustment_target === 'SERVICE' ? 'SERVICE_TERMINATION' : (adj.adjustment_target === 'RENT' ? 'CONTRACT_TERMINATION_RENT' : 'INVOICE_ADJUSTMENT')`, `source_invoice_id = inv.id`, `source_adjustment_id = adj.id`, `subscription_id = adj.subscription_id`).
         - **Khi từ chối đề nghị (`reject`):**
           - Bắt buộc có `reason` không rỗng (`rejection_reason`).
           - Chuyển `invoice_adjustment.status = 'REJECTED'`, ghi `approved_by = req.user.sub`, `updated_by = req.user.sub`, `approved_at = NOW()`, ghi `audit_log` (`REJECT_INVOICE_ADJUSTMENT`) — giữ nguyên trạng thái vật lý đã kết thúc của `service_subscription` / `contract` và giải phóng Partial Unique Index `PENDING_APPROVAL` để vận hành có thể lập lại đề nghị điều chỉnh khác chuẩn xác hơn nếu cần.
         - Gửi thông báo cho cư dân (`INVOICE_ADJUSTED` / `INVOICE_VOIDED`) khi phê duyệt thành công.

---

### 5.5. Vòng đời `credit_balance`, KPI Báo cáo (`Mục 15.1–15.3`) & Quyết toán cuối kỳ

1. **Khi xác nhận thanh toán vượt hóa đơn (`applyPaymentToInvoice` trong `api/src/routes/payments.js` — gắn `idempotencyGuard()` cho `POST /payments`):**
   - Chặn thu tiền trên hóa đơn `status IN ('DRAFT', 'VOID')` hoặc hóa đơn đã thu đủ `total_amount - paid_amount <= 0`.
   - Khi `currentPaid + payAmount > total_amount`:
     - Kẹp `invoice.paid_amount = total_amount` (`Mục 13.3`), chuyển `invoice.status = 'PAID'`.
     - Ghi `overpayment = currentPaid + payAmount - total_amount` vào `payment.overpayment_amount` **và** tạo bản ghi `credit_balance` (`reason_type = 'OVERPAYMENT'`, `source_payment_id = payment.id`, `source_invoice_id = invoice.id`, `amount = overpayment`, `status = 'AVAILABLE'`) nếu hóa đơn gắn với `contract_id`.
   - Bảo đảm **tính giao hoán tuyệt đối**: dù khách thanh toán trước rồi mới duyệt điều chỉnh giảm phí, hay duyệt điều chỉnh giảm phí trước rồi mới xác nhận biên lai thanh toán của khách, `total_amount`, `paid_amount` và `credit_balance` đều ra kết quả giống hệt nhau tới từng đồng.

2. **Tự động bù trừ `credit_balance` vào hóa đơn kỳ kế tiếp (`generateInvoicesCore` trong `api/src/routes/invoices.js` — `FR-033`, `FR-040`):**
   - Sau khi tính xong `subtotal` của hóa đơn kỳ mới, khóa FIFO các khoản `credit_balance` khả dụng của hợp đồng (`status IN ('AVAILABLE', 'PARTIALLY_APPLIED') ORDER BY created_at ASC FOR UPDATE`).
   - Với mỗi khoản `credit` khi còn phần cần trừ (`remainingToOffset > 0`):
     - `useAmt = Math.min(credit.amount - credit.applied_amount, remainingToOffset)`.
     - Chèn dòng `invoice_line`: `item_type = 'ADJUSTMENT'`, `credit_id = credit.id`, `amount = -useAmt`, `unit_price = -useAmt`, `description = "Bù trừ từ số dư tạm giữ (credit_balance): " + credit.description`, `formula_meta = { credit_id: credit.id, applied_amount: useAmt }`.
     - Cập nhật `credit.applied_amount += useAmt`, `credit.updated_by = actorId`, `credit.status = (applied_amount >= amount ? 'APPLIED' : 'PARTIALLY_APPLIED')`.
   - Lưu trên `invoice`: `subtotal_amount = subtotal`, `adjustment_amount = -totalCreditUsed`, `credit_offset_amount = totalCreditUsed`, `total_amount = subtotal - totalCreditUsed`.
   - Nếu phát hành mà `total_amount === 0` (số dư `credit_balance` bù trừ trọn 100% hóa đơn kỳ mới): chuyển `invoice.status = 'PAID'` ngay khi phát hành, không tạo `receivable` `0 ₫`.

3. **Cập nhật truy vấn công nợ, quá hạn, KPI báo cáo (`PRD Mục 15.1–15.3`) & `RP-08`:**
   - `daily.js` (Bước 6 & 7): xét `status IN ('ISSUED', 'PARTIALLY_PAID', 'ADJUSTED') AND paid_amount < total_amount` theo ngày Việt Nam `Asia/Ho_Chi_Minh` (bảo đảm hóa đơn `'ADJUSTED'` đã đóng đủ tiền `paid_amount = total_amount` không bao giờ bị chuyển sang `'OVERDUE'` hay cộng `LATE_FEE`, trong khi hóa đơn `'ADJUSTED'` còn nợ quá hạn vẫn tính quá hạn/phạt chậm chuẩn xác).
   - `resident.js` (`current_amount_due`, `reportPayment`), `deposits.js` (`calculateContractOpenDebts`, `checkSettlementPreconditions` — bổ sung điều kiện `no_pending_invoice_adjustments` đảm bảo không còn `invoice_adjustment` đang `PENDING_APPROVAL` trước khi tất toán cọc): tính dư nợ mở bằng `GREATEST(0, total_amount - paid_amount)` trên tập trạng thái `('ISSUED', 'ADJUSTED', 'PARTIALLY_PAID', 'OVERDUE')`.
   - `reports.js` (`/dashboard`, `/summary`, `/audit-logs` — thực thi qua `getUserClient(req)` dưới RLS):
     - Loại cả `'DRAFT'` và `'VOID'` khỏi doanh thu phát hành (`status NOT IN ('DRAFT', 'VOID')` theo `PRD Mục 15.3` dòng 1060).
     - `billed` (*Doanh thu ghi nhận kỳ*, `PRD 15.3` dòng 1060) = `SUM(i.total_amount + i.credit_offset_amount) FILTER (WHERE i.status NOT IN ('DRAFT', 'VOID'))` gom theo `i.period`.
     - `collected` (*Tiền thực thu*, `PRD 15.3` dòng 1061) = `SUM(p.amount)` của các giao dịch `payment` có `p.status = 'CONFIRMED'` gom theo tháng thanh toán múi giờ Việt Nam `TO_CHAR(p.paid_at AT TIME ZONE 'Asia/Ho_Chi_Minh', 'YYYY-MM')` (nhờ vậy KPI `monthly_revenue` trên Dashboard Chủ nhà / Quản lý phản ánh đúng 100% dòng tiền thực thu xác nhận trong tháng, không bị cộng ảo bởi khoản cấn trừ nội bộ `credit_offset_amount`).
     - `invoice_settled` (*Giá trị hóa đơn kỳ đã tất toán*, phục vụ biểu đồ Kế toán *"Đã thu vs phải thu theo kỳ"* `PRD 15.1` dòng 1028) = `SUM(i.paid_amount + i.credit_offset_amount) FILTER (WHERE i.status NOT IN ('DRAFT', 'VOID'))` gom theo `i.period`, bảo toàn đẳng thức đối chiếu công nợ kỳ `billed === invoice_settled + outstanding`.
     - `outstanding` (*Tổng công nợ đang mở*, `PRD 15.3` dòng 1062) = `SUM(GREATEST(0, i.total_amount - i.paid_amount)) FILTER (WHERE i.status IN ('ISSUED', 'ADJUSTED', 'PARTIALLY_PAID', 'OVERDUE'))`.
     - Báo cáo `RP-08` (*Nhật ký thao tác tài chính*, `PRD 15.2` dòng 1051): bao phủ đầy đủ `('invoice', 'invoice_line', 'invoice_adjustment', 'payment', 'credit_balance', 'deposit', 'deposit_transaction', 'service_subscription')`.

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

### 5.6. Giao diện Frontend & Trải nghiệm Xác nhận An toàn (`PRD Mục 8.2`, `16.1`, `16.2`)

1. **Chuẩn hóa hằng số trạng thái (`frontend/src/constants/statuses.js`), `Idempotency-Key` & Hàm `roundVND` / `todayVietnamYmd`:**
   - `SUBSCRIPTION_STATUS`: bổ sung `TERMINATED: { label: 'Đã chấm dứt', variant: 'slate' }` (giữ alias `CANCELLED` dự phòng cho an toàn hiển thị).
   - `INVOICE_STATUS`: đổi sang `ADJUSTED: { label: 'Đã điều chỉnh', variant: 'indigo' }`, `VOID: { label: 'Đã hủy bỏ (Void)', variant: 'slate' }` (giữ alias `CANCELLED` dự phòng).
   - Bổ sung `INVOICE_ADJUSTMENT_STATUS` (`PENDING_APPROVAL`, `APPROVED`, `REJECTED`), helper `roundVND` và `todayVietnamYmd` dùng chung trên Frontend để mọi phép tính xem trước Pro-rata khớp 100% với Backend, đồng thời tự động đính kèm header `Idempotency-Key` trên các lời gọi `POST` tài chính.

2. **Cổng Cư dân (`ServicesTab.jsx`, `InvoicesTab.jsx`):**
   - `ServicesTab.jsx`:
     - Khi `sub.status === 'PENDING_APPROVAL'` hoặc `todayVietnam < subStart`: mở khóa hủy ngay không cần nhập ngày `>= subStart`, hiển thị rõ thông báo *"Dịch vụ chưa bắt đầu sử dụng — Hủy trước ngày bắt đầu sẽ không phát sinh chi phí (0 ₫)"*.
     - Khi `todayVietnam >= subStart`: tính trước Pro-rata bằng `roundVND` trên khoảng `[max(subStart, monthStart) .. end_date]`; bổ sung nút *"Rút yêu cầu hủy"* khi gói đang ở `CANCELLATION_PENDING`.
   - `InvoicesTab.jsx`:
     - Hiển thị thẻ số dư *"Số dư tạm giữ (`credit_balance`) sẽ tự động bù trừ kỳ tới"* (trả về từ `/api/v1/resident/me`).
     - Cập nhật bộ lọc tab và nút *"Báo đã thanh toán"* theo `remaining = Math.max(0, total_amount - paid_amount) > 0` để hỗ trợ trọn vẹn trạng thái `'ADJUSTED'` và `'VOID'`; hiển thị giải trình công thức Pro-rata / điều chỉnh trên từng dòng hóa đơn.

3. **Cổng Quản trị & Chủ nhà (`SubscriptionsPage.jsx`, `InvoicesPage.jsx`, `InvoiceDetailPage.jsx`, `ContractDetailPage.jsx`, `DepositsPage.jsx`):**
   - `SubscriptionsPage.jsx`:
     - Hỗ trợ xác nhận hủy `0 ₫` khi `todayVietnam < subStart`, tùy chọn *"Chưa phát sinh sử dụng thực tế (0 ₫)"*, nút *"Giữ lại dịch vụ (Từ chối hủy)"*, và hiển thị thông báo kết quả xử lý hóa đơn tương ứng với 3 kịch bản (ví dụ: *"Đã cập nhật ngay hóa đơn nháp INV-..."* hoặc *"Đã tạo đề nghị điều chỉnh -200.000 ₫ trên hóa đơn INV-... (chờ phê duyệt 4 mắt)"*).
   - `InvoicesPage.jsx` & `InvoiceDetailPage.jsx`:
     - **Khi hóa đơn đang `DRAFT` (dành cho `MANAGER` tòa nhà):** hiển thị giao diện thêm / sửa / xóa trực tiếp từng dòng phí nháp. Khi bấm *"Phát hành (ISSUED)"*, hiển thị hộp thoại xác nhận ngữ cảnh nêu rõ kỳ hóa đơn, tổng số tiền và cảnh báo khóa chỉnh sửa trực tiếp sau phát hành (`PRD Mục 16.1`).
     - **Xác nhận 2 bước gõ lại mã `invoice_code` khi Hủy hóa đơn (`VOID` — `PRD Mục 16.2`):** cả khi hủy trực tiếp bản nháp `DRAFT` lẫn khi lập đề nghị `VOID` cho hóa đơn đã phát hành, hộp thoại bắt buộc người thao tác nhập chính xác mã hóa đơn (`invoice_code`) cùng lý do hủy mới mở khóa nút xác nhận.
     - **Khi hóa đơn đã phát hành (`ISSUED` trở đi):** ẩn sửa trực tiếp; cung cấp nút *"Lập điều chỉnh / Hủy hóa đơn (4 mắt)"* cho `MANAGER` gọi `POST /api/v1/invoices/:id/adjust`. Hiển thị danh sách `invoice_adjustment` ngay trên trang chi tiết hóa đơn (và bộ lọc *"Chờ duyệt điều chỉnh"* trên `InvoicesPage.jsx`) với nút **Phê duyệt / Từ chối** mở cho **`OWNER` của tòa nhà**, **`MANAGER` thứ hai cùng tòa** (`user.sub !== adj.created_by`), hoặc **`SYS_ADMIN` khi tòa chưa gắn `OWNER`**.
     - **Tab `Lịch sử / Kiểm toán` trực tiếp trên `InvoiceDetailPage.jsx` (`PRD Mục 8.2` dòng 316):** gọi endpoint mới `GET /api/v1/invoices/:id/audit-logs` hiển thị dòng thời gian toàn bộ lịch sử tạo nháp, sửa dòng nháp (`before`/`after`), phát hành, lập/duyệt/từ chối điều chỉnh 4 mắt, thanh toán và kết chuyển `credit_balance` của hóa đơn đó.
   - `ContractDetailPage.jsx` & `DepositsPage.jsx`:
     - `ContractDetailPage.jsx`: hiển thị số dư `credit_balance` khả dụng của hợp đồng và cập nhật bảng lịch dự kiến khớp trạng thái `'TERMINATED'` / `'VOID'` / `'ADJUSTED'`.
     - `DepositsPage.jsx`: hiển thị tách bạch phần hoàn trả tiền cọc gốc (`deposit_refund_amount`), phần đối trừ/hoàn trả `credit_balance` (`credit_refund_amount`) và tổng thực chi hoàn lại cho cư dân (`total_payout_amount`), đồng thời cảnh báo rõ nếu hợp đồng còn đề nghị điều chỉnh hóa đơn `PENDING_APPROVAL` chưa duyệt xong trước khi lập tất toán cọc.

---

## 6. Phần để bước lập kế hoạch & thi công quyết định (Left to the Builder)

- Cách tổ chức chi tiết các hàm nội bộ trong `api/src/services/serviceBilling.js` và `api/src/services/invoiceLifecycle.js` (miễn đảm bảo các thao tác đổi trạng thái, cập nhật bản nháp, lập/duyệt điều chỉnh 4 mắt qua RPC `fn_resolve_invoice_adjustment`, cập nhật `receivable`, `credit_balance` và ghi `audit_log` luôn thực thi nguyên tử trong cùng PostgreSQL transaction dưới RLS).
- Cấu trúc chi tiết payload `invoice_sync_result` trả về kèm trong `PATCH /api/v1/service-subscriptions/:id` và các API kết thúc hợp đồng để giao diện hiển thị thông báo hướng dẫn bước tiếp theo rõ ràng.
- Cách chia tách bộ kiểm thử tự động (`node --test`) bao phủ đầy đủ:
  1. Công thức Pro-rata theo múi giờ `Asia/Ho_Chi_Minh` & bảng giá 3 tầng `FR-065` (bao gồm hủy `0 ₫` trước `start_date`).
  2. Bảo toàn 100% 5 tháng đầu khi hủy dịch vụ hoặc thanh lý hợp đồng giữa tháng thứ 6 (`6A`).
  3. Chặn rò rỉ `DRAFT` đối với `RESIDENT` ở cả API lẫn RLS (`AC-003.2`) và sửa dòng `DRAFT` có `audit_log` `before`/`after` (`AC-020.1`).
  4. Ma trận quyền `PRD Mục 6.2` & duyệt 4 mắt `invoice_adjustment`: `OWNER` tòa nhà duyệt thành công (nhưng bị RLS chặn nếu `UPDATE invoice` trực tiếp), `MANAGER` thứ hai duyệt thành công, người lập tự duyệt bị chặn `403 SELF_APPROVAL`, `SYS_ADMIN` chỉ xem (`R`) trên tòa đã có `OWNER` và chỉ dự phòng duyệt trên tòa chưa có `OWNER`.
  5. `Idempotency-Key` chống gửi đúp, tính giao hoán thanh toán & điều chỉnh sinh `credit_balance`, bù trừ kỳ kế tiếp không trừ đúp doanh thu, tách bạch `collected` (*Tiền thực thu* `Mục 15.3`) với `invoice_settled` (`Mục 15.1`), và quyết toán cuối kỳ tách bạch `credit_balance` với tiền cọc gốc (`FR-068`).
