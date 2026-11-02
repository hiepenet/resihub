# Thiết kế Hủy Dịch vụ (`TERMINATED`), Đồng bộ Phí Dịch vụ & Tiền Thuê Sớm (`6A`), Xử lý Hóa đơn 3 Kịch bản (Duyệt 4 Mắt) & Sổ Tạm giữ `credit_balance`

**Ngày:** 2026-11-02  
**Phiên bản:** v6 (Đã hoàn tất đối soát ma trận 3 chiều toàn diện giữa `PRD v2.0` × Cơ chế nội tại PostgreSQL `FORCE ROW LEVEL SECURITY` × Codebase thực tế gồm nhánh M06 `044`–`047` & toàn bộ kiểm thử tích hợp/UI — Khóa triệt để toàn bộ lỗ hổng P0/P1/P2 và 4 khoảng trống PRD còn sót ở `v5`)  
**Quy mô:** Dự án liên phân hệ (Migration CSDL `048` có backfill thanh toán thừa lịch sử, RLS 2 lớp chuẩn `PRD Mục 6.2` kèm `SET row_security = off` & `fn_lock_invoices_for_authorized_viewer` + RLS `attachment` cho minh chứng hoàn `credit_balance` + Engine tính phí 3 tầng `FR-065` (`is_price_locked`) & đồng bộ hóa đơn 3 kịch bản cho cả `SERVICE` và `RENT` khi kết thúc hợp đồng sớm / kích hoạt chuyển phòng M06 tương lai + Phê duyệt 4 mắt tự trị trong RPC `SECURITY DEFINER` cho cả Điều chỉnh hóa đơn & Hoàn `credit_balance` trực tiếp (`FR-040`) + Nhắc nợ tự động đa mốc `FR-039` (`-3/0/+3/+7/+15` ngày) + Danh sách `skipped_contracts` (`FR-033`, `AC-015.1`) + Gộp khách thuê `FR-021` + KPI `Mục 15.1–15.3`, Tuổi nợ `AC-016.1`, Xuất `.xlsx`/`CSV` `FR-058`, `RP-08` 12 thực thể & Quyết toán cuối kỳ 4 lượt bảo toàn `remaining_service_debt` không trừ đúp `RP-07` + Giao diện Quản trị / Chủ nhà / Cư dân)  
**Tài liệu tham chiếu chuẩn:** `PRD - Quan ly Can ho va Nha cho thue v2.0.md` (`FR-006`, `FR-013`, `FR-021`, `FR-024`, `FR-029`, `FR-033`, `FR-034`, `FR-035`, `FR-037`, `FR-038`, `FR-039`, `FR-040`, `FR-058`, `FR-064`, `FR-065`, `FR-066`, `FR-068`, `FR-070`, `AC-003.2`, `AC-015.1`, `AC-015.3`, `AC-016.1`, `AC-017.3`, `AC-019.1`, `AC-020.1`, Mục `6.1`, `6.2`, `7.5`, `8.2`, `10.1`, `10.3`, `12.4`, `13`, `13.2`, `13.3`, `13.4`, `14.3`, `14.5`, `15.1–15.3`, `16.1–16.2`, `NFR-008`, `NFR-010`, `NFR-016`)

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
     - Phân quyền RBAC & RLS trên dịch vụ/hóa đơn/thanh toán chưa sát `PRD Mục 6.1–6.2`: `SYS_ADMIN` đang giữ quyền ghi trực tiếp thay vì chỉ xem (`R`) và dự phòng duyệt khi tòa chưa có `OWNER`; `OWNER` chưa có quyền phê duyệt (`A`) đề nghị điều chỉnh/hủy hóa đơn sau phát hành của tòa mình sở hữu; `contract_service_price` còn thiếu `FORCE ROW LEVEL SECURITY`; một số truy vấn trong route vẫn dùng `adminPool` vượt qua RLS.
     - Rò rỉ hóa đơn `DRAFT` sang Cư dân ở RLS (`rls_invoice_select`, `rls_invoice_modify`), `GET /api/v1/invoices/:id`, `POST /api/v1/resident/payments/report` và `GET /api/v1/contracts/:id` (vi phạm `AC-003.2`).
     - Hóa đơn sau phát hành (`ISSUED` trở đi) đang cho sửa/xóa dòng `ADJUSTMENT` trực tiếp qua `PATCH /api/v1/invoices/:id/status` mà không có quy trình phê duyệt 4 mắt (`FR-034`, `FR-035`, `NFR-016`), thiếu tab `Lịch sử / Kiểm toán` trên chi tiết hóa đơn (`Mục 8.2`), và thiếu xác nhận 2 bước nhập lại `invoice_code` khi hủy hóa đơn (`Mục 16.2`).
     - Chưa có bảng vật lý `credit_balance` (`Mục 13.2`, `FR-040`) để lưu khoản nộp thừa (cả trên hóa đơn lẫn công nợ rời sau trả phòng), tự động bù trừ vào hóa đơn kỳ kế tiếp (`FR-033`) mà không làm giảm kép doanh thu báo cáo, tách biệt chỉ tiêu KPI `"Tiền thực thu"` (`Mục 15.3`) với giá trị hóa đơn đã tất toán theo kỳ (`Mục 15.1`), và tách bạch tuyệt đối với tiền cọc gốc khi quyết toán cuối kỳ (`FR-068`).
     - Cron job hàng ngày (`daily.js`) chưa có bước nhắc nợ tự động đa mốc `-3`, `0`, `+3`, `+7`, `+15` ngày quanh `due_date` (`FR-039`, `PRD Mục 10.1 & 12.4`); API sinh hóa đơn hàng loạt chưa trả danh sách hợp đồng bị bỏ qua kèm lý do (`FR-033`, `AC-015.1`); giao diện Công nợ / Báo cáo / Dashboard chưa hiển thị đúng 4 nhóm tuổi nợ quá hạn `0–15 / 16–30 / 31–60 / >60` ngày (`AC-016.1`) và chưa hỗ trợ xuất `.xlsx` cho `RP-08` / báo cáo tổng hợp (`FR-058`).

---

## 2. Mục tiêu & Giới hạn (Goals, Non-Goals, Anti-Goals)

### 2.1. Mục tiêu (Goals)
1. **Chuẩn hóa mã trạng thái CSDL & Quy ước thời gian theo đúng PRD Mục 13, 13.2, 13.4 (Quyết định 2 = Phương án B):**
   - `service_subscription.status`: chuyển `'CANCELLED'` → **`'TERMINATED'`** (`'PENDING_APPROVAL'`, `'ACTIVE'`, `'CANCELLATION_PENDING'`, `'TERMINATED'`, `'REJECTED'`).
   - `invoice.status`: chuyển `'CANCELLED'` → **`'VOID'`** và bổ sung **`'ADJUSTED'`** (`'DRAFT'`, `'ISSUED'`, `'PARTIALLY_PAID'`, `'PAID'`, `'OVERDUE'`, `'ADJUSTED'`, `'VOID'`).
   - Chuẩn hóa toàn bộ phép so sánh ngày hiện tại (`today`) trên vùng dịch vụ, hóa đơn, cư dân và job hàng ngày theo múi giờ **`Asia/Ho_Chi_Minh`** (`PRD Mục 13.4`) thay cho cắt chuỗi UTC `toISOString().slice(0, 10)`.
2. **Hủy dịch vụ trước ngày bắt đầu sử dụng (`0 ₫`) & Đồng bộ tự động cả `SERVICE` lẫn `RENT` khi Hợp đồng kết thúc sớm / kích hoạt chuyển phòng (Quyết định `6A`):**
   - Mở khóa hủy dịch vụ khi `today < start_date` (hoặc rút yêu cầu `PENDING_APPROVAL`) với `0` ngày sử dụng (`0 ₫`).
   - Trên toàn bộ 6 luồng kết thúc hợp đồng (`cancel`, `terminate`, `terminate/approve`, `requests/:id/approve`, kích hoạt hợp đồng chuyển phòng `is_room_transfer` bên trong `runActivationSideEffects` khi `POST /:id/approve` hoặc `POST /:id/activate`, và `daily.js` Bước 1a & 1b): tự động chuyển các `service_subscription` đang mở sang `'TERMINATED'` **và** đồng bộ lại cả dòng phí dịch vụ (`SERVICE`) lẫn dòng tiền thuê phòng (`RENT`) trên các hóa đơn đã sinh từ kỳ kết thúc trở đi (hoặc toàn bộ các kỳ nếu hủy trước ngày nhận phòng `!movedIn` → `0 ₫`, với hợp đồng cũ chuyển phòng luôn tra cứu trực tiếp `ch.start_date` của hợp đồng con chuyển phòng đã kích hoạt để tính biên nửa mở `lastActiveDay = addDaysYmd(ch.start_date, -1)` kể cả khi `c.terminated_at` bị kẹp về `today` trên hồ sơ chuyển phòng ngày tương lai) theo đúng 3 kịch bản hóa đơn của PRD.
3. **Chuẩn hóa công thức Pro-rata, thứ tự ưu tiên đơn giá 3 tầng nghiêm ngặt (`FR-065`), làm tròn `ROUND(x, -3)` & bảo toàn 100% các kỳ trước:**
   - Tính phí trên khoảng giao thực tế `[max(start_date, periodStart) .. min(end_date, periodEnd)]`.
   - Áp dụng thứ tự ưu tiên đơn giá 3 tầng đồng nhất 100% giữa sửa danh mục hiện hữu và thêm mới ghi đè tòa nhà: **Giá hợp đồng (`contract_service_price` có `effective_from <= periodEndYmd`, bao gồm ánh xạ alias chuẩn `INTERNET_FIBER` ↔ `INTERNET`, `MANAGEMENT_FEE`/`MANAGEMENT` ↔ `COMMON_SERVICE`, `PARKING_MOTO` ↔ `MOTORBIKE_PARKING`) → Giá khóa riêng trên gói đăng ký hợp đồng (`service_subscription.is_price_locked = TRUE`, xác định ngay tại thời điểm khởi tạo khi đơn giá đăng ký khác danh mục gốc) → Giá tòa (`service_catalog` có `building_id`) → Giá mặc định tổ chức (`service_catalog` có `building_id IS NULL`)**; riêng các kỳ hóa đơn **đã phát hành** luôn khóa theo `unit_price` đã áp trên `invoice_line` của kỳ đó (`FR-065`). Đồng thời sửa lỗi lặp dòng dịch vụ đã `TERMINATED` trên mẫu in Điều 5 (`contractTemplate.js`).
   - Làm tròn `ROUND(x, -3)` (`roundVND`) đồng nhất cả Backend và Frontend; lưu công thức & tham chiếu vào `invoice_line` (`subscription_id`, `credit_id`, `adjustment_id`, `formula_meta JSONB` + mô tả tường minh theo `AC-015.3`, `Mục 13.2`).
   - Hủy dịch vụ hoặc thanh lý hợp đồng ở giữa tháng thứ `N` giữ nguyên **100%** dữ liệu và số tiền của các tháng `1 .. N-1`.
4. **Xử lý hóa đơn chuẩn xác theo 3 kịch bản PRD, Phân quyền & RLS 2 lớp chuẩn `PRD Mục 6.1–6.2` (tương thích `FORCE ROW LEVEL SECURITY`), `Idempotency-Key`, Nhắc nợ `FR-039` & Duyệt 4 mắt tự trị trong CSDL (Quyết định 1 = Phương án A):**
   - **Kịch bản 1 (Chưa sinh hóa đơn kỳ hủy — trước `billing_day`):** Khi tới `billing_day` trong `daily.js` Bước 5 (`onlyOngoingContracts: false, excludeSettledDeposits: true` — bao phủ cả HĐ `TERMINATED`/`EXPIRED` trong kỳ nhưng loại trừ các HĐ đã vào/xong luồng tất toán cọc) hoặc khi chạy `generate-batch` (hỗ trợ lọc theo từng `contract_id`, làm mới tại chỗ bản `DRAFT` hiện hữu khi truyền `contract_id`, và trả kèm mảng `skipped_contracts` theo `FR-033` / `AC-015.1`), `generateInvoicesCore` tự tính Pro-rata cho các ngày hiệu lực trong kỳ (hoặc `0 ₫` nếu hủy trước ngày bắt đầu), tạo hóa đơn `DRAFT` kèm `audit_log` `CREATE_INVOICE`; các kỳ kế tiếp bỏ qua gói đã `TERMINATED`.
   - **Kịch bản 2 (Hóa đơn kỳ hiện tại đang `DRAFT`):** Khóa tuyệt đối không cho `RESIDENT` nhìn thấy hay báo thanh toán trên bản `DRAFT` (`AC-003.2`); cho phép `MANAGER` tòa nhà sửa trực tiếp dòng phí trên bản `DRAFT` (tự động cập nhật khi xác nhận `TERMINATED` dịch vụ / đóng hợp đồng sớm + API sửa dòng nháp cho vận hành rà soát theo `FR-033`, `FR-034`; nếu đóng hợp đồng trước ngày ở làm toàn bộ bản nháp về `0 ₫` và chưa thu tiền thì tự động chuyển bản nháp rỗng sang `'VOID'`) kèm ghi nhận bắt buộc `audit_log` giá trị `before`/`after` (`AC-020.1`).
   - **Kịch bản 3 (Hóa đơn kỳ hiện tại đã phát hành — `ISSUED` / `PARTIALLY_PAID` / `PAID` / `OVERDUE` / `ADJUSTED`):** Khóa bất biến không sửa/xóa trực tiếp (`FR-034`, `NFR-016`); mọi nghiệp vụ điều chỉnh giảm/tăng hoặc hủy hóa đơn (`VOID`) sau phát hành đều tạo bản ghi đề nghị `invoice_adjustment` (`PENDING_APPROVAL`) có lý do bắt buộc và **bắt buộc phê duyệt 4 mắt** bởi **`OWNER` của tòa nhà**, hoặc **`MANAGER` thứ hai cùng tòa**, hoặc **`SYS_ADMIN` duy nhất trong trường hợp tòa chưa có `OWNER` hoạt động** (`!building_has_active_owner(building_id)`), thực thi qua hàm RPC hẹp `SECURITY DEFINER SET search_path = public, pg_temp SET row_security = off` (`fn_resolve_invoice_adjustment`) **tự đọc trực tiếp cấu hình `system_setting('approval_config')` ngay trong SQL**.
   - Bổ sung Bước 8 trong `daily.js` gửi thông báo nhắc nợ tự động đa mốc `-3`, `0`, `+3`, `+7`, `+15` ngày quanh `due_date` có khử trùng idempotent theo từng mốc (`FR-039`, `PRD Mục 10.1 & 12.4`).
   - Gắn `idempotencyGuard()` (`Idempotency-Key`, `PRD Mục 14.3`) cho các `POST`/`PATCH`/`DELETE` tài chính, bảo vệ đa tòa trên danh mục mặc định `building_id IS NULL` (`FR-070`), dùng helper `fn_lock_invoices_for_authorized_viewer` cho thao tác khóa đọc hóa đơn của `RESIDENT`/`OWNER` dưới `FORCE ROW LEVEL SECURITY`, và loại bỏ việc dùng `adminPool` vượt RLS trong các route nghiệp vụ (`NFR-008`, `AC-019.1`).
5. **Sổ số dư tạm giữ `credit_balance` (Bù trừ tự động, Hoàn trực tiếp 4 mắt giữa kỳ & Tất toán cuối kỳ), KPI Doanh thu / Thực thu (`Mục 15.1–15.3`, `AC-016.1`, `FR-058`) & Tách bạch tuyệt đối với Tiền cọc (`FR-021`, `FR-024`, `FR-033`, `FR-040`, `FR-068`, `RP-07`, `RP-08`):**
   - Lưu mọi khoản cư dân nộp thừa (do thanh toán vượt trên hóa đơn hoặc công nợ rời sau trả phòng, do hóa đơn đã đóng tiền được duyệt điều chỉnh giảm `SERVICE` / `RENT`, và backfill đầy đủ dữ liệu thanh toán thừa lịch sử khi chạy Migration `048`) vào bảng `credit_balance`, đồng thời giữ chuẩn toàn vẹn `invoice.paid_amount <= invoice.total_amount` (`Mục 13.3`) và đồng bộ `tenant_id` khi gộp khách thuê trùng (`FR-021`).
   - **Đang trong thời hạn hợp đồng hoặc hợp đồng đã kết thúc (`0` cọc / đã tất toán cọc) (`FR-040` — *"bù trừ kỳ sau hoặc hoàn"*):** (a) tự động bù trừ `credit_balance` khi sinh hóa đơn `DRAFT` kỳ kế tiếp (`FR-033`), lưu `invoice.credit_offset_amount` để không trừ đúp doanh thu kỳ sau và hoàn lại hạn mức nếu bản `DRAFT` chưa thu tiền bị `VOID`; **hoặc** (b) cho phép `MANAGER` lập đề nghị hoàn tiền trực tiếp từ `credit_balance` (`PENDING_DIRECT_REFUND`, lưu minh chứng ảnh qua `attachment` với `owner_entity = 'credit_balance'`, hỗ trợ tách phần chưa áp trên dòng `PARTIALLY_APPLIED`, mở cho cả hợp đồng đang hoạt động lẫn hợp đồng `TERMINATED`/`EXPIRED` không có cọc hoặc đã tất toán xong cọc) và duyệt 4 mắt qua RPC `fn_resolve_credit_refund` → `'REFUNDED_DIRECT'`.
   - Tách rõ `collected` (*Tiền thực thu ròng* từ `payment` xác nhận trừ toàn bộ các khoản `credit_balance` đã thực chi hoàn trả `'REFUNDED_DIRECT'` và `'REFUNDED_IN_SETTLEMENT'` trong tháng theo `PRD 15.3`) và `invoice_settled` (*Giá trị hóa đơn kỳ đã tất toán* theo `PRD 15.1`), hiển thị đầy đủ trên cả `DashboardPage.jsx` lẫn `ReportsPage.jsx`, đồng thời đồng bộ 4 nhóm tuổi nợ quá hạn chuẩn `PRD FR-038 / AC-016.1` (`0–15`, `16–30`, `31–60`, `>60` ngày + `Chưa đến hạn`) trên cả API lẫn UI (`PaymentsPage.jsx`, `ReportsPage.jsx`) và hỗ trợ xuất cả `CSV` lẫn `.xlsx` (`FR-058`).
   - **Kỳ cuối / chấm dứt hợp đồng (`FR-024`, `FR-068`):** cảnh báo nổi bật + nút sinh/làm mới nhanh 1 chạm nếu kỳ kết thúc còn ngày ở thực tế chưa xuất hóa đơn (`unbilled_final_period`); xử lý bù trừ âm liên nhóm (`raw_service < 0` hoặc `raw_rent < 0`) trước khi phân bổ `credit_offset_amount` để bảo toàn đẳng thức `rent_effective + service_effective === total_amount`; hạch toán quyết toán qua **4 lượt tuần tự** trong `fn_apply_deposit_settlement_accounting` và truyền chính xác `covered_service_debt = Math.min(remaining_service_debt, remainingDepositAfterItems)` (trong đó `remaining_service_debt = Math.max(0, serviceDebt - credit_applied_to_service)`) để **không bao giờ khấu trừ đúp `UTILITY_DEBT` đã được `credit_balance` thanh toán ở Lượt 2**, bảo toàn tuyệt đối sổ cái tiền cọc (`RP-07`) và `FR-068`.

### 2.2. Không nằm trong phạm vi (Non-Goals)
- Không tự động lập điều chỉnh lùi vào hóa đơn đã `ISSUED` / `PAID` khi cư dân **đăng ký mới** một dịch vụ giữa kỳ sau khi hóa đơn kỳ đó đã phát hành (các kỳ chưa sinh hóa đơn hoặc đang `DRAFT` vẫn tính Pro-rata đầu vào bình thường).
- Không tự động chốt chỉ số đồng hồ điện/nước (`ELECTRICITY`, `WATER`) khi thanh lý hợp đồng sớm nếu vận hành chưa ghi chỉ số bàn giao (điện/nước tính theo chỉ số đồng hồ thực tế `meter_reading`, không tính Pro-rata theo ngày).
- Không tích hợp cổng chi hoàn tiền tự động qua ngân hàng hoặc gửi SMS/Email qua nhà cung cấp bên thứ ba (thông báo nhắc nợ `FR-039` và phê duyệt phát hành in-app qua bảng `notification` theo phạm vi MVP Mục `12.4`).
- Không thêm vai trò vật lý mới ngoài 4 vai trò hiện hành của hệ thống (`SYS_ADMIN`, `OWNER`, `MANAGER`, `RESIDENT` theo `036_simplify_roles.sql`), tuân thủ nghiêm ngặt `PRD Mục 6.1–6.2`.

### 2.3. Điều cần tránh (Anti-Goals)
- **Tuyệt đối không UPDATE hoặc DELETE dòng `invoice_line` cũ trên bất kỳ hóa đơn nào đã rời trạng thái `DRAFT`** (`FR-034`, `NFR-016`) — mọi điều chỉnh sau phát hành chỉ được phép ghi thêm dòng `ADJUSTMENT` mới sau khi đã qua phê duyệt 4 mắt.
- **Tuyệt đối không gắn `BEFORE DELETE` trigger chặn xóa cứng cấp superuser trên `invoice`, `payment`, `invoice_adjustment`, `credit_balance`** (vì sẽ phá vỡ khối dọn dữ liệu `t.after` qua `adminPool` của các bộ kiểm thử tích hợp hiện hữu); tính bất biến được khóa qua RLS (`resihub_app` không có policy `DELETE` trên `invoice`, `invoice_adjustment`, `credit_balance` và chỉ có `DELETE` trên `invoice_line` khi hóa đơn cha đang `DRAFT`) kết hợp chốt chặn `409 IMMUTABLE_AFTER_ISSUED` ở tầng API/RPC.
- **Tuyệt đối không cấp quyền RLS `INSERT`/`UPDATE`/`DELETE` đại trà trên `invoice`, `invoice_line`, `receivable` cho `OWNER` hoặc `SYS_ADMIN`**, và **không chạy `SELECT ... FROM invoice ... FOR UPDATE` trực tiếp trên phiên `RESIDENT` / `OWNER`** dưới `FORCE ROW LEVEL SECURITY` (phải đi qua `fn_lock_invoices_for_authorized_viewer`).
- **Không dùng `adminPool` để đọc/ghi dữ liệu nghiệp vụ trong route handler** nhằm tránh bỏ qua PostgreSQL RLS (`NFR-008`).
- **Không vi phạm `paid_amount <= total_amount`** trên `invoice` (`Mục 13.3`) và **không vi phạm `receivable.amount > 0`** trên `receivable` (`026_invoices_payments.sql`).
- **Không trừ đúp doanh thu báo cáo** giữa kỳ điều chỉnh hóa đơn cũ và kỳ áp dụng `credit_balance` tiếp theo, **không trừ đúp `UTILITY_DEBT` trên sổ cọc `deposit_transaction` đối với phần nợ dịch vụ đã được `credit_balance` thanh toán**, và **không ghi trộn hoàn trả `credit_balance` vào `deposit_transaction`** (`RP-07`, `FR-068`).
- **Không đổi tên `'CANCELLED'` của các thực thể khác** (`contract`, `service_request`, `reservation`, `announcement`) vốn vẫn dùng `'CANCELLED'` theo đúng PRD Mục `13.2`.

---

## 3. Ràng buộc kỹ thuật & Nghiệp vụ (Constraints)

1. **PostgreSQL 16 & Row-Level Security (RLS) 2 lớp chuẩn `PRD Mục 6.2` tương thích `FORCE ROW LEVEL SECURITY` (`NFR-008`, `AC-017.3`, `AC-019.1`, `FR-070`):**
   - Các bảng mới (`invoice_adjustment`, `credit_balance`) và bảng `contract_service_price` bắt buộc bật đầy đủ `ENABLE ROW LEVEL SECURITY`, `FORCE ROW LEVEL SECURITY` và `GRANT ALL PRIVILEGES ... TO resihub_app`.
   - **Quy tắc bắt buộc cho mọi hàm `SECURITY DEFINER` trong Migration `048`:** Do các bảng tài chính đều bật `FORCE ROW LEVEL SECURITY`, mọi hàm RPC/helper `SECURITY DEFINER` trong `048` bắt buộc khai báo **`SECURITY DEFINER SET search_path = public, pg_temp SET row_security = off`** kèm `GRANT EXECUTE ON FUNCTION ... TO resihub_app;` (đồng nhất 100% với `045`–`047`).
   - **Quy tắc khóa dòng hóa đơn cho `RESIDENT` và `OWNER` dưới `FORCE ROW LEVEL SECURITY`:** Trong PostgreSQL, câu lệnh `SELECT ... FROM invoice ... FOR UPDATE` kiểm tra đồng thời cả policy `SELECT` lẫn policy `UPDATE` (`rls_invoice_modify`). Khi `rls_invoice_modify` chỉ mở cho `MANAGER`, mọi luồng của `RESIDENT` (`POST /api/v1/resident/payments/report`) hoặc `OWNER` (`POST /api/v1/deposits/:id/settlement/approve`) cần khóa chống race condition trên `invoice` bắt buộc gọi hàm hẹp `fn_lock_invoices_for_authorized_viewer` thay vì `SELECT ... FOR UPDATE` trực tiếp.
   - Ma trận quyền RLS cho nhóm Dịch vụ, Bảng giá hợp đồng, Hóa đơn, Điều chỉnh hóa đơn, Thanh toán, Công nợ, Số dư tạm giữ & Tệp đính kèm:
     - `SYS_ADMIN` (`is_org_admin()`): **chỉ đọc (`SELECT`)** toàn tổ chức trên `service_catalog`, `service_subscription`, `contract_service_price`, `invoice`, `invoice_line`, `payment`, `receivable`, `invoice_adjustment`, `credit_balance` (`PRD Mục 6.2` dòng 190–194); chỉ được thực thi phê duyệt/từ chối `invoice_adjustment` hoặc hoàn tiền `credit_balance` thông qua RPC `fn_resolve_invoice_adjustment` / `fn_resolve_credit_refund` khi `NOT building_has_active_owner(building_id)` (đồng nhất 100% với `041_contract_owner_price_approval_rls.sql`).
     - `OWNER` (`is_owner()` trên `get_owner_building_ids()`): **chỉ đọc (`SELECT`)** toàn bộ dữ liệu dịch vụ, bảng giá hợp đồng, hóa đơn, thanh toán, `invoice_adjustment`, `credit_balance`, `attachment` minh chứng tài chính, `audit_log` (12 thực thể tài chính) của tòa sở hữu; thực thi phê duyệt/từ chối 4 mắt qua các RPC hẹp `fn_resolve_invoice_adjustment` và `fn_resolve_credit_refund`.
     - `MANAGER` (`is_manager()` trên `get_manager_building_ids()`): quyền `CRU` vận hành & kế toán trên các tòa được phân công (quản lý danh mục dịch vụ tòa/mặc định — chặn sửa trực tiếp danh mục mặc định `building_id IS NULL` đang có gói đăng ký hiệu lực ở tòa nhà khác không thuộc phạm vi quản lý và chưa có bản ghi giá ghi đè tòa theo `FR-070`, cấu hình `contract_service_price`, duyệt/hủy `service_subscription`, xóa `service_subscription` trên hợp đồng nháp, sinh hóa đơn, sửa/xóa dòng `DRAFT`, phát hành, hủy `DRAFT`, lập đề nghị `invoice_adjustment`, lập đề nghị hoàn tiền `credit_balance`, ghi nhận/xác nhận/từ chối `payment`, đọc `audit_log` tài chính 12 thực thể của tòa quản lý, và phê duyệt chéo 4 mắt qua RPC khi `actor_id <> created_by`).
     - `RESIDENT`: chỉ đọc dữ liệu gắn với hợp đồng của mình (`get_resident_contract_ids()`), tạo yêu cầu đăng ký/hủy dịch vụ & báo thanh toán (`rls_payment_insert`), xem minh chứng hoàn `credit_balance` của hợp đồng mình, và **tuyệt đối không đọc được hóa đơn `DRAFT`** (`status <> 'DRAFT'` ngay ở tầng RLS `rls_invoice_select`).
   - Kiểm soát 4 mắt (`SELF_APPROVAL`) trong `fn_resolve_invoice_adjustment` và `fn_resolve_credit_refund` phải tự truy vấn trực tiếp bảng `system_setting` (`key = 'approval_config'`) ngay bên trong thân hàm `SECURITY DEFINER` (tuyệt đối không nhận cờ `allow_self_approval` từ tham số đầu vào).
   - Mọi truy cập trái phạm vi tòa nhà trên API trả thông báo trung tính (`403` / `404` chuẩn `PRD 14.3`) và ghi `audit_log` với `action = 'ACCESS_DENIED'` (`AC-019.1`).
2. **Quy ước múi giờ `Asia/Ho_Chi_Minh` & Biểu diễn ngày `start_date` / `end_date` (`PRD Mục 13.4`):**
   - Ngày hiện tại của nghiệp vụ luôn tính theo `Asia/Ho_Chi_Minh` (`todayVietnamYmd()` ở Node.js bằng `Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' })` và `(NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date` trong SQL).
   - `end_date < start_date` (cụ thể `end_date = start_date - 1 day` khi hủy trước ngày bắt đầu sử dụng hoặc thu hồi yêu cầu `PENDING_APPROVAL`): biểu diễn **0 ngày sử dụng (`0 ₫`)**, phân biệt rạch ròi với `end_date === start_date` (**1 ngày sử dụng**).
   - `status = 'TERMINATED'` mà `end_date IS NULL` (dữ liệu lịch sử cũ): luôn coi là **0 ngày sử dụng (`0 ₫`)**.
   - `end_date >= start_date` (với `status = 'TERMINATED'`): khoảng ngày sử dụng thực tế tính gộp hai đầu `[start_date .. end_date]`.
3. **Bất biến tài chính & Bảo toàn phương trình kế toán:**
   - Trên bảng `invoice`: luôn duy trì `0 <= paid_amount <= total_amount`. Khi khách chuyển khoản vượt `remaining_amount` hoặc khi hóa đơn đã thu tiền được duyệt điều chỉnh giảm làm `oldPaid > nextTotal`, phần vượt `oldPaid - nextTotal` được chuyển sang `credit_balance` và `invoice.paid_amount` được kẹp về `nextTotal`.
   - Trên bảng `invoice`: bổ sung cột `credit_offset_amount BIGINT NOT NULL DEFAULT 0 CHECK (credit_offset_amount >= 0)` ghi nhận tổng số tiền `credit_balance` kỳ trước đã cấn trừ vào hóa đơn này:
     - Số tiền khách thực tế cần thanh toán thêm cho hóa đơn = `total_amount - paid_amount` (khớp 100% với QR thanh toán, `receivable.amount` và công nợ mở).
     - Doanh thu phát sinh kinh tế của kỳ (`billed`) = `total_amount + credit_offset_amount` (trên các hóa đơn `status NOT IN ('DRAFT', 'VOID')`), bảo đảm **không bao giờ bị giảm trừ hai lần**.

---

## 4. Các phương án đã cân nhắc (Approaches)

### 4.1. Kiến trúc tổng thể (Đã chốt: Phương án 1)
1. **Phương án 1 — Tự động hóa khép kín chuẩn PRD từ Hủy trước hạn, Đồng bộ `SERVICE` + `RENT` (`6A`), Xử lý Hóa đơn 3 Kịch bản (có Duyệt 4 Mắt ở Kịch bản 3) đến Sổ `credit_balance` & Quyết toán cuối kỳ *(Đã chọn)*:**
   - Chuẩn hóa công thức giao khoảng thời gian, mở khóa hủy `0 ₫` trước `start_date`, xử lý trọn vẹn 3 kịch bản hóa đơn (`chưa sinh`, `DRAFT` sửa trực tiếp có `audit_log`, sau `ISSUED` tạo đề nghị `invoice_adjustment` duyệt 4 mắt), đồng bộ cả `SERVICE` lẫn `RENT` khi hợp đồng kết thúc sớm, lưu tiền dư vào `credit_balance` để bù trừ tự động kỳ kế tiếp, hoàn trực tiếp 4 mắt giữa kỳ hoặc đối trừ/hoàn trả tách biệt khi kết thúc hợp đồng.
   - *Ưu điểm:* Bám sát 100% đặc tả PRD v2.0, bất biến chứng từ sau phát hành, bảo toàn tuyệt đối các tháng quá khứ `1..N-1` và khớp từng đồng trên cả báo cáo doanh thu, tiền thực thu lẫn sổ cái tiền cọc.
2. **Phương án 2 — Bán tự động (chỉ sửa `DRAFT`, chặn/bắt tính tay sau phát hành):** Dễ sót khoản bù trừ của cư dân khi sang tháng mới hoặc khi tất toán cuối kỳ.
3. **Phương án 3 — Chỉ cho hủy dịch vụ từ đầu kỳ kế tiếp:** Trái với `FR-029` (yêu cầu tính Pro-rata theo số ngày thực tế khi hủy giữa kỳ).

### 4.2. Các quyết định thiết kế do Chủ dự án chốt trực tiếp
- **Cơ chế duyệt 4 mắt ở Kịch bản 3 (Hóa đơn đã phát hành):** **Chọn Phương án A** — Mọi điều chỉnh/hủy hóa đơn sau khi `ISSUED` đều tạo bản ghi chờ duyệt `PENDING_APPROVAL` và bắt buộc phê duyệt 4 mắt (`OWNER` tòa nhà, hoặc `MANAGER` thứ hai cùng tòa, hoặc `SYS_ADMIN` dự phòng khi tòa chưa có `OWNER`).
- **Tên mã trạng thái vật lý trong CSDL:** **Chọn Phương án B** — Chuẩn hóa CSDL và toàn bộ mã nguồn theo đúng PRD Mục `13.2`: `service_subscription.status` dùng `'TERMINATED'`; `invoice.status` dùng `'ADJUSTED'` và `'VOID'`; sổ số dư tạm giữ dùng tên bảng `'credit_balance'`.
- **Chuẩn hóa rà soát PRD:** **Đồng ý toàn bộ các điểm chuẩn hóa** (`RBAC Mục 6.2 + RPC SECURITY DEFINER`, `KPI Tiền thực thu Mục 15.3 + RP-08 + xuất .xlsx`, `Idempotency-Key + bỏ adminPool bypass`, `Tab Lịch sử/Audit + xác nhận 2 bước gõ invoice_code khi VOID`, `Múi giờ Asia/Ho_Chi_Minh + updated_by + dynamic constraint lookup`, `Nhắc nợ tự động đa mốc FR-039`) **và chọn Phương án `6A`** (tự động đồng bộ cả dòng `RENT` lẫn `SERVICE` trên các hóa đơn đã sinh khi hợp đồng hủy trước ngày ở / thanh lý sớm giữa kỳ / chuyển phòng).

### 4.3. Các quyết định kiến trúc chuyên sâu khóa chặt toàn bộ góc khuất kỹ thuật (`v4`–`v6`)
1. **Bảo vệ hóa đơn kỳ cuối chưa sinh, Làm mới bản `DRAFT` kỳ cuối & Tương thích Chuyển phòng 4 bước M06 kể cả ngày tương lai (`FR-024`, `FR-033`, `FR-066`, `FR-068`, `AC-015.1`):**
   - Bật `onlyOngoingContracts: false` kèm cờ `excludeSettledDeposits: true` trong `daily.js` Bước 5 (`auto-billing`); khi truyền `contract_id` đơn lẻ vào `generateInvoicesCore`, lọc `NOT EXISTS (... inv.status NOT IN ('VOID', 'DRAFT'))` để nếu kỳ đó đã có sẵn bản `DRAFT` thì tự động làm mới tại chỗ các dòng `RENT`/`SERVICE`/công tơ điện nước thay vì bỏ qua; đồng thời trả kèm mảng `skipped_contracts` (`{ contract_id, contract_code, apartment_code, reason }`) theo `FR-033` / `AC-015.1`.
   - Tương thích tuyệt đối với hành vi kẹp `terminated_at = todayVnStr` của nhánh M06 (`contracts.js:2850-2864`) khi duyệt chuyển phòng có `newContract.start_date` ở tương lai: trên `generateInvoicesCore` (`invoices.js`), `loadContractSubscriptionsAndSchedule` (`contracts.js`) và `checkSettlementPreconditions` (`deposits.js`), nếu hợp đồng có hợp đồng con chuyển phòng đã kích hoạt (`ch.parent_contract_id = c.id AND ch.is_room_transfer = TRUE AND ch.status NOT IN ('DRAFT', 'PENDING_APPROVAL', 'CANCELLED')`), hệ thống **bắt buộc truyền trực tiếp `explicitEndYmd: ch.start_date` kèm `isRoomTransfer: true`** vào `resolveContractLastActiveDay` (cho ra `lastActiveDayYmd = addDaysYmd(ch.start_date, -1)` và `endPeriod = lastActiveDayYmd.slice(0, 7)`) thay vì đọc `c.terminated_at`.
2. **Bù trừ âm liên nhóm (`Cross-Bucket Negative Spill`), Hạch toán 4 lượt tuần tự & Chống trừ đúp `UTILITY_DEBT` trên Sổ cọc `RP-07` (`FR-068`):**
   - Trong cả `fn_apply_deposit_settlement_accounting` (SQL) và `calculateContractOpenDebts` (JS), xử lý tràn âm liên nhóm (`raw_service < 0` tràn sang `rent_net`, `raw_rent < 0` tràn sang `service_net`) trước khi phân bổ `credit_offset_amount` ưu tiên `RENT`.
   - Trong `computeFinalSettlementWithCredit` (`depositSettlement.js`) và `deposits.js` (`commitSettlementAccounting`, `POST /:id/settlement/approve`, `POST /:id/payout`), tính tường minh **`remaining_service_debt = Math.max(0, serviceDebt - credit_applied_to_service)`** và **`covered_service_debt = Math.min(remaining_service_debt, Math.max(0, heldBefore - sumItems))`**. Tuyệt đối không truyền `serviceDebt` gốc trước-tín-dụng vào `p_covered_service_debt`, triệt tiêu 100% nguy cơ ghi khống `deposit_transaction` (`UTILITY_DEBT`) cho khoản nợ dịch vụ đã được `credit_balance` gạch ở Lượt 2!
3. **Tương thích `FORCE ROW LEVEL SECURITY` toàn diện cho `SECURITY DEFINER` RPCs, `FOR UPDATE` khóa hóa đơn & `attachment` minh chứng (`NFR-008`, `AC-017.3`, `AC-019.1`):**
   - Mọi hàm `SECURITY DEFINER` trong Migration `048` đều khai báo `SET search_path = public, pg_temp SET row_security = off`.
   - Hàm `fn_notify_building_finance_actors` hỗ trợ cả phiên người dùng `resihub_app` lẫn phiên hệ thống tin cậy (`get_current_user_id() IS NULL AND current_user <> 'resihub_app'`, tự suy ra `v_org_id` từ `building`) để `daily.js` (`adminPool`) và `contracts.js:3336` (`adminClient` khi `OWNER` duyệt kích hoạt HĐ chuyển phòng) không bao giờ gặp lỗi `42501`, đồng thời ghi đúng tên cột vật lý của `011_notifications.sql` (`org_id, user_id, title, content, type, payload`).
   - Bổ sung `fn_lock_invoices_for_authorized_viewer` để `RESIDENT` (`POST /api/v1/resident/payments/report`) và `OWNER` (`POST /api/v1/deposits/:id/settlement/approve`) khóa dòng `invoice` an toàn không bị `rls_invoice_modify` lọc về `0` dòng; nâng cấp `can_select_attachment` (`046`) + `attachments.js` hỗ trợ `owner_entity IN ('credit_balance', 'invoice', 'invoice_adjustment')`; nâng cấp `rls_deposit_update` (`045`) bổ sung `'RETURNED'` vào `WITH CHECK`.
4. **Backfill thanh toán thừa lịch sử trong `048`, Đơn giá 3 tầng qua `is_price_locked`, Gộp khách thuê `FR-021` & Thanh toán vượt công nợ rời:**
   - Trong Migration `048`, khởi tạo bảng `credit_balance` và backfill toàn bộ khoản nộp thừa lịch sử từ các `payment` `'CONFIRMED'` có `overpayment_amount > 0` (hoặc `invoice.paid_amount > invoice.total_amount`) gắn `contract_id IS NOT NULL` **trước khi** chạy câu lệnh kẹp `invoice.paid_amount <= total_amount`.
   - Đồng bộ `UPDATE credit_balance SET tenant_id = $1 WHERE tenant_id = $2` trong `POST /api/v1/tenants/:id/merge` (`FR-021`), và ghi nhận `credit_balance` (`OVERPAYMENT`) khi khách thanh toán vượt trên công nợ rời `receivable_id` có gắn `contract_id`.
5. **Nhắc nợ tự động đa mốc `FR-039`, Nhật ký kiểm toán tự động, Tuổi nợ `AC-016.1` trên UI, `DashboardPage.jsx` & Xuất `.xlsx` `FR-058`:**
   - Bổ sung Bước 8 trong `daily.js` quét hóa đơn chưa thu đủ ở các mốc `-3` (trước hạn 3 ngày), `0` (đến hạn hôm nay) và `+3, +7, +15` ngày quá hạn (`system_setting('billing_config').reminder_days`), khử trùng theo `(user_id, invoice_id, reminder_stage)` và ghi `audit_log` `SEND_DEBT_REMINDER`.
   - Đồng bộ 4 nhóm tuổi nợ quá hạn `0–15 / 16–30 / 31–60 / >60` ngày + `Chưa đến hạn` lên cả `PaymentsPage.jsx` lẫn `ReportsPage.jsx`, bổ sung `invoice_settled` & thẻ chờ duyệt 4 mắt trên `DashboardPage.jsx`, và hỗ trợ xuất `.xlsx` (`toXlsxBuffer`) song song `CSV` trên `RP-08` (`GET /api/v1/audit-logs?scope=financial&format=xlsx`) và `/api/v1/reports/summary?format=xlsx`.
6. **Ghi chú đối chiếu tinh chỉnh chủ đích so với câu chữ PRD v2.0:**
   - *Về nơi ghi nhận phí phạt chậm (`FR-064` — PRD ghi "tính phí phạt tự động vào kỳ sau"):* Hệ thống giữ cơ chế ghi nhận nối tiếp dòng `LATE_FEE` append-only trực tiếp lên chính hóa đơn đang quá hạn để **hóa đơn kỳ cuối cùng** khi khách trả phòng nếu quá hạn vẫn tính được phí phạt mà không bị rơi mất do không còn kỳ sau, đồng thời bảo toàn 100% các bút toán miễn/giảm `FR-064`.
   - *Về trạng thái đăng ký dịch vụ (`Mục 13.2` — PRD liệt kê `REQUESTED | ACTIVE | TERMINATED | REJECTED`):* Hệ thống dùng `'PENDING_APPROVAL'` tương đương ngữ nghĩa 1-1 với `'REQUESTED'` của toàn codebase và duy trì thêm trạng thái trung gian `'CANCELLATION_PENDING'` để cư dân gửi/rút yêu cầu hủy trước khi Quản lý chốt `'TERMINATED'`.

---

## 5. Chi tiết thiết kế kỹ thuật

### 5.1. Migration Cơ sở dữ liệu & RLS (`048_service_termination_invoice_adjustments_and_credit_balance.sql`)

> **Lưu ý phối hợp đánh số Migration, Thứ tự chạy DDL & Rollback (`PRD Mục 14.5`):** Sau khi nhánh M06 bổ sung `044`–`047` tại `api/src/db/migrations/`, file migration của bản thiết kế này được đánh số **`048_service_termination_invoice_adjustments_and_credit_balance.sql`**. Toàn bộ thao tác gỡ/thay `CHECK` và `UNIQUE` constraint bên dưới phải tra cứu động qua `pg_constraint` trong khối `DO $$ ... END $$;` (không phụ thuộc cứng vào tên constraint mặc định) và đính kèm khối hướng dẫn SQL Rollback ở đầu file migration. **Thứ tự thực thi bắt buộc:** tạo `invoice_adjustment` và `credit_balance` trước, backfill các khoản thanh toán thừa lịch sử sang `credit_balance`, sau đó mới kẹp `invoice.paid_amount <= total_amount` và gắn `invoice_paid_lte_total_check`.

1. **Chuẩn hóa bảng giá dịch vụ 3 tầng trên `service_catalog` (`FR-065`):**
   - Dùng khối `DO $$` tra `pg_constraint` gỡ ràng buộc `UNIQUE (org_id, code)` cũ trên `service_catalog`, thay bằng bộ Partial Unique Index chuẩn:
     - `CREATE UNIQUE INDEX IF NOT EXISTS idx_service_catalog_org_default_code ON service_catalog(org_id, code) WHERE building_id IS NULL;`
     - `CREATE UNIQUE INDEX IF NOT EXISTS idx_service_catalog_building_code ON service_catalog(org_id, building_id, code) WHERE building_id IS NOT NULL;`

2. **Chuẩn hóa mã trạng thái `service_subscription.status` → `'TERMINATED'` & Cờ khóa đơn giá `is_price_locked` (`Mục 13.2`, `FR-065`):**
   - Bổ sung cột `is_price_locked BOOLEAN` (không gán `DEFAULT` tĩnh ở DDL để phân biệt lệnh chèn SQL thuần bỏ trống cột với lệnh chèn API).
   - Tra `pg_constraint` gỡ `CHECK` cũ trên `service_subscription.status`, chạy `UPDATE service_subscription SET status = 'TERMINATED' WHERE status = 'CANCELLED';`, backfill `UPDATE service_subscription ss SET is_price_locked = CASE WHEN ss.status = 'TERMINATED' AND ss.end_date IS NOT NULL THEN TRUE ELSE COALESCE((SELECT sc.unit_price <> ss.unit_price FROM service_catalog sc WHERE sc.id = ss.service_id), FALSE) END WHERE ss.is_price_locked IS NULL;`, áp `ALTER TABLE service_subscription ALTER COLUMN is_price_locked SET NOT NULL;`, gắn trigger chuẩn hóa đầu vào `BEFORE INSERT OR UPDATE` (`trg_normalize_legacy_subscription_status`: chuẩn hóa `'CANCELLED'` → `'TERMINATED'` **và** khi `TG_OP = 'INSERT' AND NEW.is_price_locked IS NULL` tự động gán `NEW.is_price_locked := CASE WHEN NEW.status = 'TERMINATED' AND NEW.end_date IS NOT NULL THEN TRUE ELSE COALESCE((SELECT sc.unit_price <> NEW.unit_price FROM service_catalog sc WHERE sc.id = NEW.service_id), FALSE) END`) và gắn `service_subscription_status_check CHECK (status IN ('PENDING_APPROVAL', 'ACTIVE', 'CANCELLATION_PENDING', 'TERMINATED', 'REJECTED'))`.

3. **Tạo bảng `invoice_adjustment` (Phê duyệt 4 mắt cho điều chỉnh / miễn giảm phạt chậm / hủy hóa đơn sau phát hành — `FR-034`, `FR-035`, `FR-064`, `Mục 13`):**
   ```sql
   CREATE TABLE IF NOT EXISTS invoice_adjustment (
     id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     org_id            UUID NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
     building_id       UUID NOT NULL REFERENCES building(id) ON DELETE CASCADE,
     invoice_id        UUID NOT NULL REFERENCES invoice(id) ON DELETE CASCADE,
     subscription_id   UUID REFERENCES service_subscription(id) ON DELETE SET NULL,
     adjustment_target TEXT NOT NULL DEFAULT 'MANUAL'
                       CHECK (adjustment_target IN ('SERVICE', 'RENT', 'LATE_FEE', 'MANUAL')),
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
     - `idx_invoice_adj_pending_late_fee ON invoice_adjustment(invoice_id) WHERE adjustment_target = 'LATE_FEE' AND status = 'PENDING_APPROVAL'`
     - `idx_invoice_adj_pending_void ON invoice_adjustment(invoice_id) WHERE action_type = 'VOID' AND status = 'PENDING_APPROVAL'`

4. **Tạo bảng `credit_balance` (Sổ số dư tạm giữ hợp đồng: bù trừ tự động, hoàn trực tiếp 4 mắt giữa kỳ & quyết toán cuối kỳ — `Mục 13`, `Mục 13.2`, `FR-033`, `FR-040`):**
   ```sql
   CREATE TABLE IF NOT EXISTS credit_balance (
     id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     org_id                   UUID NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
     building_id              UUID NOT NULL REFERENCES building(id) ON DELETE CASCADE,
     contract_id              UUID NOT NULL REFERENCES contract(id) ON DELETE CASCADE,
     tenant_id                UUID REFERENCES tenant(id) ON DELETE SET NULL,
     subscription_id          UUID REFERENCES service_subscription(id) ON DELETE SET NULL,
     source_invoice_id        UUID REFERENCES invoice(id) ON DELETE SET NULL,
     source_adjustment_id     UUID REFERENCES invoice_adjustment(id) ON DELETE SET NULL,
     source_payment_id        UUID REFERENCES payment(id) ON DELETE SET NULL,
     parent_credit_id         UUID REFERENCES credit_balance(id) ON DELETE SET NULL,
     settlement_deposit_id    UUID REFERENCES deposit(id) ON DELETE SET NULL,
     settlement_refund_amount BIGINT NOT NULL DEFAULT 0 CHECK (settlement_refund_amount >= 0 AND settlement_refund_amount <= amount),
     refund_meta              JSONB,
     refunded_at              TIMESTAMPTZ,
     reason_type              TEXT NOT NULL CHECK (reason_type IN (
                                'SERVICE_TERMINATION',
                                'CONTRACT_TERMINATION_RENT',
                                'INVOICE_ADJUSTMENT',
                                'OVERPAYMENT',
                                'TRANSFERRED_IN'
                              )),
     amount                   BIGINT NOT NULL CHECK (amount > 0),
     applied_amount           BIGINT NOT NULL DEFAULT 0 CHECK (applied_amount >= 0 AND applied_amount <= amount),
     status                   TEXT NOT NULL DEFAULT 'AVAILABLE'
                              CHECK (status IN (
                                'AVAILABLE',
                                'PARTIALLY_APPLIED',
                                'APPLIED',
                                'PENDING_DIRECT_REFUND',
                                'REFUNDED_DIRECT',
                                'PENDING_SETTLEMENT_PAYOUT',
                                'REFUNDED_IN_SETTLEMENT',
                                'TRANSFERRED',
                                'VOID'
                              )),
     description              TEXT NOT NULL,
     created_by               UUID REFERENCES app_user(id) ON DELETE SET NULL,
     updated_by               UUID REFERENCES app_user(id) ON DELETE SET NULL,
     created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
   );
   ```
   - Partial Unique Index chống nhân đôi tuyệt đối (Idempotency ở tầng DB):
     - `idx_credit_balance_unique_adj ON credit_balance(source_adjustment_id) WHERE source_adjustment_id IS NOT NULL AND status <> 'VOID'`
     - `idx_credit_balance_unique_payment ON credit_balance(source_payment_id) WHERE source_payment_id IS NOT NULL AND status <> 'VOID'`
     - `idx_credit_balance_contract_avail ON credit_balance(contract_id, created_at) WHERE status IN ('AVAILABLE', 'PARTIALLY_APPLIED')`

5. **Backfill thanh toán thừa lịch sử, Chuẩn hóa mã trạng thái `invoice.status` → `'ADJUSTED'`, `'VOID'` & Ràng buộc toàn vẹn (`Mục 13.2`, `Mục 13.3`):**
   - Bổ sung cột `credit_offset_amount BIGINT NOT NULL DEFAULT 0 CHECK (credit_offset_amount >= 0)` trên bảng `invoice`.
   - **Backfill bảo toàn 100% tiền nộp thừa lịch sử trước khi kẹp `paid_amount`:** chèn vào `credit_balance` (`reason_type = 'OVERPAYMENT'`, `status = 'AVAILABLE'`, `ON CONFLICT DO NOTHING`) cho các giao dịch `payment p JOIN invoice i ON i.id = p.invoice_id` có `p.status = 'CONFIRMED' AND p.overpayment_amount > 0 AND i.contract_id IS NOT NULL` (và phần chênh lệch dư còn lại nếu `i.paid_amount > i.total_amount AND i.contract_id IS NOT NULL` chưa có dòng `credit_balance` tương ứng).
   - Sau khi đã backfill xong vào `credit_balance`, chuẩn hóa `UPDATE invoice SET paid_amount = LEAST(GREATEST(0, paid_amount), GREATEST(0, total_amount)) WHERE paid_amount > total_amount OR paid_amount < 0;` và gắn ràng buộc `invoice_paid_lte_total_check CHECK (paid_amount >= 0 AND total_amount >= 0 AND paid_amount <= total_amount)` (`Mục 13.3`).
   - Tra `pg_constraint` gỡ `CHECK` cũ trên `invoice.status`, chạy `UPDATE invoice SET status = 'VOID' WHERE status = 'CANCELLED';`, gắn trigger chuẩn hóa đầu vào `BEFORE INSERT OR UPDATE OF status` (`'CANCELLED'` → `'VOID'`) và gắn `invoice_status_check CHECK (status IN ('DRAFT', 'ISSUED', 'PARTIALLY_PAID', 'PAID', 'OVERDUE', 'ADJUSTED', 'VOID'))`.
   - Khử trùng an toàn các bản nháp `DRAFT` chưa thu tiền bị trùng `(contract_id, period)` (chuyển bản nháp cũ trùng sang `'VOID'`) rồi tạo `CREATE UNIQUE INDEX IF NOT EXISTS idx_invoice_unique_active_period ON invoice(contract_id, period) WHERE contract_id IS NOT NULL AND status <> 'VOID';` (`PRD Mục 13.3`).

6. **Bổ sung cột tham chiếu & công thức giải trình trên `invoice_line` (`AC-015.3`, `Mục 13.2`):**
   - `subscription_id UUID REFERENCES service_subscription(id) ON DELETE SET NULL`
   - `credit_id UUID REFERENCES credit_balance(id) ON DELETE SET NULL`
   - `adjustment_id UUID REFERENCES invoice_adjustment(id) ON DELETE SET NULL`
   - `formula_meta JSONB` (`{ billing_mode, price_source, unit_price, quantity, active_days, days_in_month, overlap_start, overlap_end, raw_amount, rounded_amount }`)

7. **Chuẩn hóa RLS 2 lớp theo `PRD Mục 6.2`, Tương thích `FORCE ROW LEVEL SECURITY` & Các hàm RPC `SECURITY DEFINER`:**
   - **Khóa rò rỉ `DRAFT` đối với `RESIDENT` (`AC-003.2`), bật `FORCE RLS` trên `contract_service_price` & Gỡ quyền ghi của `SYS_ADMIN` / `RESIDENT` trên bảng tài chính (`PRD Mục 6.2`):**
     - `rls_invoice_select`: `is_org_admin() OR building_id IN (SELECT building_id FROM get_user_assigned_buildings()) OR (status <> 'DRAFT' AND (contract_id IN (SELECT contract_id FROM get_resident_contract_ids()) OR tenant_id IN (SELECT tenant_id FROM get_resident_tenant_ids())))`.
     - `rls_invoice_modify` & `rls_invoice_line_modify`: trên `invoice`, tách rõ chỉ mở `INSERT`/`UPDATE` cho `MANAGER` trên `get_manager_building_ids()` (không mở `DELETE` cho `resihub_app`); trên `invoice_line`, mở `INSERT`/`UPDATE` cho `MANAGER` trên `get_manager_building_ids()` và chỉ mở `DELETE` khi hóa đơn cha đang `status = 'DRAFT'` (`EXISTS (SELECT 1 FROM invoice i WHERE i.id = invoice_line.invoice_id AND i.status = 'DRAFT' AND i.building_id IN (SELECT building_id FROM get_manager_building_ids()))`). Gỡ cả `is_org_admin()` lẫn `is_resident()`.
     - `rls_service_catalog_select` & `rls_service_catalog_modify`: thu hẹp `rls_service_catalog_select` thành `org_id = get_current_user_org_id() AND (is_org_admin() OR building_id IS NULL OR building_id IN (SELECT building_id FROM get_user_assigned_buildings()) OR building_id IN (SELECT c.building_id FROM contract c WHERE c.id IN (SELECT contract_id FROM get_resident_contract_ids())))` (`FR-070`); `rls_service_catalog_modify` chỉ mở cho `is_manager() AND org_id = get_current_user_org_id() AND (building_id IS NULL OR building_id IN (SELECT building_id FROM get_manager_building_ids()))`.
     - `contract_service_price`: chạy `ALTER TABLE contract_service_price FORCE ROW LEVEL SECURITY;` (bổ sung phần còn thiếu của `019_rls_policies.sql`) và cập nhật `rls_contract_service_price_modify` chỉ cho phép `is_manager()` trên `get_manager_building_ids()`.
     - `rls_service_sub_insert` / `rls_service_sub_update` / `rls_service_sub_delete`: giữ nhánh cư dân gửi đăng ký/yêu cầu hủy hợp lệ của mình và nhánh `MANAGER` trên `get_manager_building_ids()`; cập nhật tường minh `rls_service_sub_delete` của `042_idempotency_and_draft_services_rls.sql` (đổi `'CANCELLED'` → `'TERMINATED'` và gỡ `is_org_admin()`).
     - `rls_payment_insert` / `rls_payment_update` & `rls_receivable_modify`: chỉ cho phép `MANAGER` thuộc `get_manager_building_ids()` (cùng nhánh `RESIDENT` gửi báo thanh toán ở `rls_payment_insert` trên hóa đơn `status <> 'DRAFT'`); gỡ `is_org_admin()`.
     - `rls_deposit_update` (`045_m06_owner_approval_and_returned_rls.sql`): bổ sung `'RETURNED'` vào danh sách trạng thái `WITH CHECK` của nhánh `is_owner()` để `OWNER` xử lý khiếu nại quyết toán trên hồ sơ đang `'RETURNED'` không bao giờ gặp lỗi RLS `42501`.
     - `can_select_attachment` (`046_m06_p2_audit_rls_reservation_policy_and_public.sql`): bảo toàn 100% logic chặn PII `person` đối với `OWNER` của `046` và bổ sung các nhánh `ELSIF p_owner_entity = 'credit_balance'`, `'invoice'`, `'invoice_adjustment'` (cho phép `is_org_admin()` cùng org, `OWNER`/`MANAGER` thuộc `get_user_assigned_buildings()`, và `RESIDENT` thuộc `get_resident_contract_ids()` / `get_resident_tenant_ids()` với điều kiện `status <> 'DRAFT'` trên `invoice` và `status = 'APPROVED'` trên `invoice_adjustment`).
     - `invoice_adjustment` & `credit_balance`: bật `ENABLE` + `FORCE ROW LEVEL SECURITY` + `GRANT ALL PRIVILEGES ... TO resihub_app`; `SELECT` mở cho `is_org_admin()`, `get_user_assigned_buildings()` (`OWNER` + `MANAGER`), và `RESIDENT` trên hợp đồng của mình (với `invoice_adjustment` chỉ hiển thị cho cư dân khi `status = 'APPROVED'`); `INSERT` trên `invoice_adjustment` và `INSERT`/`UPDATE` trên `credit_balance` trong luồng vận hành thường nhật chỉ mở cho `MANAGER` của `get_manager_building_ids()`.
   - **Bộ 3 hàm helper hẹp `SECURITY DEFINER SET search_path = public, pg_temp SET row_security = off`:**
     - `fn_get_finance_resource_scope(p_entity TEXT, p_id UUID) RETURNS TABLE(resource_id UUID, org_id UUID, building_id UUID)`: chỉ trả dòng khi `org_id = get_current_user_org_id()`, giúp các route `invoices.js`, `payments.js`, `services.js` phân biệt rạch ròi tài nguyên không tồn tại (`404`) với tài nguyên thuộc tòa nhà khác ngoài phạm vi quản lý/sở hữu (`403` + ghi `audit_log` `ACCESS_DENIED` theo `AC-019.1`) mà không cần dùng `adminPool`.
     - `fn_lock_invoices_for_authorized_viewer(p_contract_id UUID DEFAULT NULL, p_invoice_id UUID DEFAULT NULL) RETURNS SETOF invoice`: xác thực người gọi có quyền đọc từng hóa đơn mục tiêu (`(get_current_user_id() IS NULL AND current_user <> 'resihub_app')` HOẶC `(org_id = get_current_user_org_id() AND (is_org_admin() OR building_id IN (SELECT building_id FROM get_user_assigned_buildings()) OR (status <> 'DRAFT' AND (contract_id IN (SELECT contract_id FROM get_resident_contract_ids()) OR tenant_id IN (SELECT tenant_id FROM get_resident_tenant_ids())))))`), khóa `FOR UPDATE` các dòng `status <> 'VOID'` khớp điều kiện (`contract_id = p_contract_id` / `id = p_invoice_id`) và trả về dòng đã khóa — giải quyết triệt để việc PostgreSQL `FORCE ROW LEVEL SECURITY` chặn `SELECT ... FROM invoice ... FOR UPDATE` đối với `RESIDENT` và `OWNER`.
     - `fn_notify_building_finance_actors(p_building_id UUID, p_type TEXT, p_title TEXT, p_message TEXT, p_metadata JSONB DEFAULT '{}'::jsonb, p_include_resident_user_id UUID DEFAULT NULL) RETURNS INT`: chấp nhận cả người gọi `resihub_app` hợp lệ thuộc tòa/org lẫn phiên nội bộ tin cậy (`get_current_user_id() IS NULL AND current_user <> 'resihub_app'`, tự đọc `v_org_id` từ `building WHERE id = p_building_id`) để `daily.js` và `contracts.js:3336` (`adminClient`) gọi an toàn; ghi vào bảng `notification` theo **đúng cột vật lý của `011_notifications.sql`: `(org_id, user_id, title, content, type, payload)`** (ánh xạ `p_message → content` và `p_metadata → payload`).
   - **Hàm RPC hẹp `fn_resolve_invoice_adjustment(p_adjustment_id UUID, p_decision TEXT, p_rejection_reason TEXT DEFAULT NULL)` (`SECURITY DEFINER SET search_path = public, pg_temp SET row_security = off`):**
     - Xác thực `v_actor_id := get_current_user_id()` là `OWNER` của `adj.building_id`, hoặc `MANAGER` được gán `adj.building_id`, hoặc `SYS_ADMIN` khi `NOT building_has_active_owner(adj.building_id)`.
     - Tự đọc `system_setting` (`WHERE org_id = adj.org_id AND key = 'approval_config'`); nếu `adj.created_by = v_actor_id` và `allow_self_approval` chưa bật → `RAISE EXCEPTION 'SELF_APPROVAL' USING ERRCODE = '42501'`; nếu `TRUE` → ghi `audit_log` (`action = 'SELF_APPROVAL_WARNING'`).
     - Thực thi nguyên tử: cập nhật `invoice_adjustment`, chèn dòng `invoice_line` mới (`ADJUSTMENT`; gắn `{"adjusts_item_type":"LATE_FEE"}` nếu `adj.adjustment_target = 'LATE_FEE'`), tự triệt tiêu append-only phần `net_existing_late_fee` còn lại nếu hóa đơn chưa thu tiền mà nợ gốc về `0`, nhả `credit_offset_amount` dư về `credit_balance` (gắn `credit_id = v_credit_row.id` trên dòng cân bằng dương, chỉ đổi `status` trên dòng thuộc `('AVAILABLE', 'PARTIALLY_APPLIED', 'APPLIED')`), cập nhật `invoice`, `UPSERT` `receivable` (kể cả khi hóa đơn `0 ₫` trước đó chưa có dòng `receivable`), tạo `credit_balance` nếu `oldPaid > nextTotal` (tự động chuyển tiếp sang hợp đồng con đang hiệu lực `parent_contract_id = inv.contract_id` nếu hợp đồng nguồn đã kết thúc sạch nợ và cọc đã `TRANSFERRED`/không cọc), chèn `notification(org_id, user_id, title, content, type, payload)` cho cư dân và ghi `audit_log` `before`/`after`.
   - **Hàm RPC hẹp `fn_resolve_credit_refund(p_credit_id UUID, p_decision TEXT, p_rejection_reason TEXT DEFAULT NULL)` (`SECURITY DEFINER SET search_path = public, pg_temp SET row_security = off`):**
     - Áp dụng cùng quy tắc chủ thể duyệt và tự đọc `system_setting('approval_config')` kiểm tra 4 mắt đối với `COALESCE(NULLIF(cb.refund_meta->>'requested_by', '')::uuid, cb.updated_by, cb.created_by)`.
     - Trên dòng `'PENDING_DIRECT_REFUND'`: khi `'APPROVED'` chuyển sang `'REFUNDED_DIRECT'`, `applied_amount = amount`, `refunded_at = NOW()`; khi `'REJECTED'` (bắt buộc `p_rejection_reason` không rỗng) gộp trả `cb.amount` về dòng cha đang mở (`parent_credit_id`) và đánh dấu dòng con `'VOID'` (hoặc khôi phục dòng gốc về `'PARTIALLY_APPLIED'`/`'AVAILABLE'`), gửi `notification(org_id, user_id, title, content, type, payload)` cho cư dân và ghi `audit_log`.
   - **Mở rộng bộ hàm tất toán cọc M06 (`045`) theo 4 lượt tuần tự & `rls_audit_log_select` (`046` + `RP-08` 12 thực thể):**
     - Nâng cấp `fn_apply_deposit_settlement_accounting(p_deposit_id UUID, p_covered_service_debt BIGINT, p_uncovered_items_shortfall BIGINT)` (`SECURITY DEFINER SET search_path = public, pg_temp SET row_security = off`, giữ nguyên tên 3 tham số): bổ sung `'ADJUSTED'` vào tập hóa đơn mở; tính `raw_rent` và `raw_service` qua `LEFT JOIN invoice_adjustment ia ON ia.id = il.adjustment_id`, xử lý tràn âm liên nhóm (`raw_service < 0` tràn sang `rent_net`, `raw_rent < 0` tràn sang `service_net`) trước khi phân bổ `credit_offset_amount` ưu tiên `RENT`, và thực thi **4 lượt tuần tự** (`Lượt 1`: `credit_balance` → toàn bộ nợ `RENT`; `Lượt 2`: `credit_balance` → toàn bộ nợ `SERVICE`; `Lượt 3`: `credit_balance` → hư hỏng vượt cọc + chốt `'REFUNDED_IN_SETTLEMENT'`, `refunded_at = NOW()`; `Lượt 4`: tiền cọc gốc `p_covered_service_debt` → phần nợ `SERVICE` còn lại sau Lượt 2 + kết chuyển `RECEIVABLE_AFTER_MOVE_OUT` dùng `p_uncovered_items_shortfall` hậu-tín-dụng).
     - Nâng cấp `fn_update_deposit_refund_bank_info`, `fn_restore_returned_settlement_credits` (`-> 'PENDING_SETTLEMENT_PAYOUT'`, `refunded_at = NULL`), và `fn_recommit_returned_settlement_credits` (`-> 'REFUNDED_IN_SETTLEMENT'`, `refunded_at = NOW()`), tất cả đều có `SET row_security = off`.
     - Mở rộng `rls_audit_log_select` (`046`) bao phủ đủ **12 thực thể tài chính** (`invoice`, `invoice_line`, `invoice_adjustment`, `payment`, `credit_balance`, `receivable`, `deposit`, `deposit_transaction`, `reservation`, `service_subscription`, `service_catalog`, `contract_service_price`) cùng `building`, `apartment`, `contract` cho cả `is_owner()` và `is_manager()` (kèm fallback `before->>'invoice_id'` và `before->>'contract_id'` khi `DELETE`).

---

### 5.2. Engine Phân giải Đơn giá 3 Tầng & Tính phí Pro-rata (`api/src/services/serviceBilling.js`)

1. **Helper ngày theo múi giờ Việt Nam (`todayVietnamYmd` — `PRD Mục 13.4`):**
   - Dùng `Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)` trả về `'YYYY-MM-DD'`.

2. **Phân giải đơn giá 3 tầng nghiêm ngặt (`resolveServiceUnitPrice` — `FR-065`):**
   - **Với hóa đơn đã phát hành (`status != 'DRAFT'`) khi lập điều chỉnh:** lấy trực tiếp `unit_price` và `quantity` đã khóa trên dòng `invoice_line` của kỳ đó.
   - **Khi khởi tạo gói đăng ký dịch vụ và khi tính cho kỳ chưa phát hành (`DRAFT`, sinh hóa đơn mới, dựng lịch dự kiến):**
     1. **Giá ghi đè trong hợp đồng (`CONTRACT_OVERRIDE`):** `contract_service_price` có `effective_from <= periodEndYmd` (ưu tiên `effective_from DESC`, hỗ trợ alias hai chiều `INTERNET_FIBER`/`INTERNET` ↔ `INTERNET`, `MANAGEMENT_FEE`/`MANAGEMENT` ↔ `COMMON_SERVICE`, `PARKING_MOTO` ↔ `MOTORBIKE_PARKING`).
     2. **Đơn giá khóa riêng trên gói đăng ký hợp đồng (`SUBSCRIPTION_LOCKED`):** chỉ áp dụng khi `Boolean(subscription.is_price_locked) === true`.
     3. **Giá riêng tòa nhà → Giá mặc định tổ chức (`BUILDING_CATALOG` → `DEFAULT_CATALOG`):** ưu tiên bản ghi `service_catalog` có `building_id = contract.building_id`, sau đó tới `building_id IS NULL`.

3. **Quy tắc cửa sổ hiệu lực (`resolveSubscriptionEffectiveWindow`) & Công thức tính phí (`computeSubscriptionPeriodCharge`, `computeContractRentPeriodCharge`):**
   - `REJECTED` hoặc `TERMINATED` có `!end_date || end_date < start_date`: `activeDays = 0, amount = 0`.
   - `TERMINATED` có `end_date >= start_date`: khoảng đóng `[start_date .. end_date]`.
   - `ACTIVE` / `CANCELLATION_PENDING` (và `PENDING_APPROVAL` trên lịch dự kiến): khoảng mở `[start_date .. +∞)`.
   - Tính giao `[overlapStart .. overlapEnd]` với `[boundStart .. boundEnd]`, `activeDays = diffDaysYmd(overlapStart, overlapEnd) + 1`, `rawAmount = activeDays >= daysInMonth ? unitPrice * quantity : (unitPrice * quantity * activeDays) / daysInMonth`, `amount = roundVND(rawAmount)`, trả kèm `formulaMeta` và `description` tường minh (`AC-015.3`).
   - Bảo toàn 100% các kỳ quá khứ `1 .. N-1` và khử lặp dòng dịch vụ `TERMINATED` trên Điều 5 mẫu in hợp đồng (`contractTemplate.js`).

---

### 5.3. Luồng Hủy Dịch vụ (`TERMINATED`) & Đồng bộ `SERVICE` + `RENT` Khi Hợp đồng Kết thúc (`6A`)

1. **Ghi nhận hủy dịch vụ, Khử trùng danh mục Cư dân & Bảo vệ danh mục đa tòa (`resident.js` & `services.js`):**
   - Chuẩn hóa đầu vào `'CANCELLED' → 'TERMINATED'`; gói đăng ký chuẩn từ danh mục lưu `is_price_locked = FALSE`.
   - Trên `GET/POST /api/v1/resident/services`: lọc `(building_id IS NULL OR building_id = c.building_id)`, khử trùng theo `UPPER(code)` ưu tiên `building_id = c.building_id`, và phân giải đơn giá qua `resolveServiceUnitPrice`.
   - Hỗ trợ rút yêu cầu `PENDING_APPROVAL` (`0 ₫`), hủy trước `start_date` (`end_date = addDaysYmd(subStart, -1)`, `0 ₫`), hủy giữa kỳ (`CANCELLATION_PENDING` + `PATCH /api/v1/resident/services/:id/withdraw-cancel`), tùy chọn `zero_usage` hoặc từ chối hủy bên Quản lý, chặn sửa gói đã `TERMINATED`/`REJECTED` (`409 INVALID_STATUS`).
   - Chặn `403 ORG_DEFAULT_SHARED_ACROSS_BUILDINGS` (+ `ACCESS_DENIED` `audit_log`) khi `MANAGER` sửa dòng `service_catalog` mặc định (`building_id IS NULL`) đang được gói đăng ký hiệu lực ở tòa ngoài phạm vi quản lý tham chiếu mà tòa đó chưa có bản ghi ghi đè riêng (`FR-070`).

2. **Đóng tự động đăng ký dịch vụ & Đồng bộ cả `SERVICE` lẫn `RENT` khi Hợp đồng kết thúc (`closeContractBillingAndSubscriptionsInTx` — Quyết định `6A`):**
   - Gắn vào cùng DB transaction của toàn bộ 6 luồng kết thúc hợp đồng (`cancel` tại `contracts.js:3842-3850`, `terminate` tại `:2429`, `terminate/approve` tại `:2580`, `requests/:id/approve` tại `:813`, kích hoạt hợp đồng chuyển phòng `is_room_transfer` trong `runActivationSideEffects` tại `:2792-2958` gán `adjustmentCreatorId = contract.created_by`, và `daily.js` Bước 1a & 1b).
   - **Quy tắc chống lệch biên ngày chuyển phòng tương lai (tương thích `contracts.js:2850-2864`):** Khi `newContract.start_date > todayVnStr`, nhánh M06 kẹp cột vật lý `oldContract.terminated_at = todayVnStr` trong DB. Do đó, mọi nơi tính `lastActiveDay` của hợp đồng cũ — gồm `runActivationSideEffects`, `generateInvoicesCore` (`invoices.js`), `loadContractSubscriptionsAndSchedule` (`contracts.js`), và `checkSettlementPreconditions` (`deposits.js`) — nếu phát hiện hợp đồng con chuyển phòng đã kích hoạt (`SELECT ch.start_date FROM contract ch WHERE ch.parent_contract_id = c.id AND ch.is_room_transfer = TRUE AND ch.status NOT IN ('DRAFT', 'PENDING_APPROVAL', 'CANCELLED') ORDER BY ch.created_at DESC LIMIT 1`) **bắt buộc truyền `explicitEndYmd: ch.start_date` và `isRoomTransfer: true`** vào `resolveContractLastActiveDay` để nhận đúng `lastActiveDayYmd = addDaysYmd(ch.start_date, -1)` (biên nửa mở `[oldStart, newStart)`, không bao giờ cắt nhầm về `today` hay thu trùng ngày chuyển phòng!).

---

### 5.4. Xử lý Hóa đơn theo 3 Kịch bản PRD, `Idempotency-Key`, Duyệt 4 Mắt & Sổ `credit_balance`

1. **Kịch bản 1 — Hóa đơn kỳ hiện tại CHƯA sinh (`generateInvoicesCore` trong `api/src/routes/invoices.js` — `FR-033`, `FR-066`, `AC-015.1`):**
   - Trong `daily.js` Bước 5 (`onlyOngoingContracts: false, excludeSettledDeposits: true`) và `POST /api/v1/invoices/generate-batch` (`MANAGER` + `idempotencyGuard()`, nhận tùy chọn `contract_id`):
     - Khi truyền `contract_id`, mệnh đề lọc dùng `NOT EXISTS (... inv.status NOT IN ('VOID', 'DRAFT'))` để nếu kỳ mục tiêu đã có sẵn bản `DRAFT` thì hàm tải hợp đồng đó lên và **làm mới tại chỗ** các dòng `RENT`/`SERVICE`/công tơ điện nước + `recalculateDraftInvoiceTotalsInTx` ngay trên bản `DRAFT` hiện hữu.
     - Trả về đầy đủ `{ created_count, updated_draft_count, skipped_contracts: Array<{ contract_id, contract_code, apartment_code, reason }>, warnings, data }` để giao diện hiển thị rõ các hợp đồng bị bỏ qua cùng nguyên nhân theo đúng `FR-033` và `AC-015.1`.

2. **Kịch bản 2 — Hóa đơn đang ở trạng thái nháp (`DRAFT` — `FR-033`, `FR-034`, `AC-020.1`, `Mục 16.1–16.2`):**
   - Tự động cập nhật/xóa dòng phí trên bản `DRAFT`, bảo toàn dòng chiết khấu thủ công (`credit_id IS NULL`) tách biệt với dòng cấn trừ tín dụng (`credit_id IS NOT NULL`), hoàn trả `credit_balance` dư nếu `subtotal_amount + manualAdj < credit_offset_amount`, tự chuyển bản `DRAFT` rỗng `0 ₫` chưa thu tiền sang `'VOID'` khi đóng hợp đồng sớm, và ghi `audit_log` `before`/`after`.
   - Cung cấp bộ API dòng nháp cho `MANAGER` (đều gắn `idempotencyGuard()`): `POST /api/v1/invoices/:id/lines`, `PATCH /api/v1/invoices/:id/lines/:lineId`, `DELETE /api/v1/invoices/:id/lines/:lineId`, và `POST /api/v1/invoices/:id/issue`.
   - Phát hành hóa đơn `0 ₫` qua `issueDraftInvoiceInTx` chuyển thẳng sang `'PAID'` (không tạo `receivable` `0 ₫`).
   - Trên `PATCH /api/v1/invoices/:id/status`: kiểm tra **`targetStatus === 'VOID' && Number(inv.paid_amount) > 0 → 409 ALREADY_PAID` ở bước đầu tiên** (bảo toàn tương thích với `fullWebsiteWhiteBlackBox.test.js:1403-1408`), trước khi kiểm tra `confirm_invoice_code` (trên `DRAFT`) hoặc `409 REQUIRES_FOUR_EYES_ADJUSTMENT` (trên hóa đơn đã phát hành).

3. **Kịch bản 3 — Hóa đơn đã phát hành (`ISSUED`, `PARTIALLY_PAID`, `PAID`, `OVERDUE`, `ADJUSTED` — `FR-034`, `FR-035`, `FR-064`, `Mục 16.2`):**
   - Khóa sửa/xóa trực tiếp; mọi điều chỉnh giảm/tăng, miễn/giảm phí phạt chậm (`adjustment_target = 'LATE_FEE'`) hoặc hủy (`VOID`, yêu cầu `paid_amount === 0` và khớp `confirm_invoice_code` khi truyền từ UI) đều tạo `invoice_adjustment` (`PENDING_APPROVAL`) qua `POST /api/v1/invoices/:id/adjust` và duyệt/từ chối 4 mắt qua `POST /api/v1/invoices/:id/adjustments/:adjId/approve` | `/reject` gọi `fn_resolve_invoice_adjustment`.
   - Bổ sung `GET /api/v1/invoices/:id/audit-logs` phục vụ Tab `Lịch sử / Kiểm toán` trực tiếp trên chi tiết hóa đơn (`PRD Mục 8.2`).

---

### 5.5. Vòng đời `credit_balance`, Gộp khách thuê (`FR-021`), Nhắc nợ tự động (`FR-039`), Quyết toán cuối kỳ (`FR-068`), KPI Báo cáo (`Mục 15.1–15.3`, `AC-016.1`) & Xuất `.xlsx` (`FR-058`)

1. **Ghi thu / Xác nhận / Từ chối thanh toán, Minh chứng đính kèm & Hoàn `credit_balance` trực tiếp 4 mắt (`payments.js`, `attachments.js`, `tenants.js` — `FR-021`, `FR-037`, `FR-040`):**
   - Gắn `idempotencyGuard()` và `getUserClient(req)` trên `POST /api/v1/payments`, `PATCH /api/v1/payments/:id/confirm`, `PATCH /api/v1/payments/:id/reject` (ghi `REJECT_PAYMENT` `audit_log`), và `POST /api/v1/resident/payments/report` (khóa đọc hóa đơn qua `fn_lock_invoices_for_authorized_viewer(NULL, invoice_id)` để `RESIDENT` không bị `FORCE RLS` lọc về `0` dòng!).
   - Bảo đảm tính giao hoán Order A / Order B trên hóa đơn, **và** hỗ trợ ghi nhận `credit_balance` (`OVERPAYMENT`) cả khi khách thanh toán vượt trên công nợ rời sau trả phòng (`invoice_id IS NULL AND receivable_id IS NOT NULL` mà `rec.contract_id IS NOT NULL`).
   - Trên `POST /api/v1/tenants/:id/merge` (`api/src/routes/tenants.js:701-728`, `FR-021`): bổ sung `UPDATE credit_balance SET tenant_id = $1, updated_at = NOW() WHERE tenant_id = $2` trong cùng transaction gộp khách thuê.
   - Trên `POST /api/v1/payments/credits/:id/refund` (`MANAGER` + `idempotencyGuard()`):
     - Cho phép thực hiện trên cả hợp đồng đang hiệu lực lẫn hợp đồng `TERMINATED`/`EXPIRED` (`0` cọc hoặc đã tất toán cọc); chặn `409 SETTLEMENT_IN_PROGRESS` nếu hợp đồng có hồ sơ cọc đang ở `('PENDING_APPROVAL', 'APPROVED_PENDING_PAYOUT', 'RETURNED')` hoặc `('DISPUTED' khi !dep.settlement?.accounting_committed_at)`.
     - Nếu request gửi `proof_image` dạng base64, lưu qua `saveBase64Image({ entity: 'credit_balance', entityId: targetCreditId, ... })` để ghi đường dẫn chuẩn `/api/v1/attachments/${saved.attachment.id}/view` vào `refund_meta.proof_image`, đồng thời bổ sung `'credit_balance'`, `'invoice'`, `'invoice_adjustment'` vào danh sách `owner_entity` hợp lệ trong `api/src/routes/attachments.js:86`.

2. **Tự động bù trừ `credit_balance` FIFO vào hóa đơn kỳ kế tiếp (`FR-033`, `FR-040`):**
   - Khóa FIFO các dòng `status IN ('AVAILABLE', 'PARTIALLY_APPLIED') ORDER BY created_at ASC FOR UPDATE`, chèn dòng `ADJUSTMENT` âm gắn `credit_id`, cập nhật `invoice.credit_offset_amount = totalCreditUsed`, `total_amount = subtotal - totalCreditUsed`.

3. **Nhắc nợ tự động đa mốc (`FR-039`), Bất biến `LATE_FEE` (`FR-064`), Tuổi nợ `AC-016.1`, KPI `Mục 15.1–15.3` & Xuất `.xlsx` (`FR-058`):**
   - **Bước 8 mới trong `api/src/jobs/daily.js` — Nhắc nợ tự động đa mốc (`FR-039`, `PRD Mục 10.1 & 12.4`):**
     - Quét các hóa đơn chưa thanh toán đủ `i.status IN ('ISSUED', 'PARTIALLY_PAID', 'OVERDUE', 'ADJUSTED') AND i.paid_amount < i.total_amount` theo ngày Việt Nam `todayVn = (NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date`, tính `daysDiff = (todayVn - i.due_date)::int`.
     - Đọc mảng ngày nhắc quá hạn từ `system_setting('billing_config').reminder_days` (mặc định `[3, 7, 15]`) kết hợp với mốc nhắc trước hạn `-3` ngày (`PRE_DUE_3D`) và mốc đến hạn `0` ngày (`DUE_TODAY`) để phủ trọn 5 mốc `-3`, `0`, `+3`, `+7`, `+15` ngày của `FR-039`.
     - Khử trùng idempotent qua `NOT EXISTS (SELECT 1 FROM notification n WHERE n.user_id = resident_user_id AND n.type = 'PAYMENT_REMINDER' AND n.payload->>'invoice_id' = i.id::text AND n.payload->>'reminder_stage' = stage_key)`, chèn `notification(org_id, user_id, title, content, type, payload)` (`type = 'PAYMENT_REMINDER'`) và ghi `audit_log` (`action = 'SEND_DEBT_REMINDER'`, `actor_id = NULL`, `entity = 'invoice'`, `entity_id = i.id`).
   - `daily.js` Bước 6 & 7: ghi `audit_log` `MARK_INVOICE_OVERDUE` & `ACCRUE_LATE_FEE` (`actor_id = NULL`), tính `deltaFee = GREATEST(0, expectedFee - gross_accrued_late_fee)` append-only (không bao giờ `DELETE` dòng `LATE_FEE` cũ hay xóa mất khoản miễn/giảm `FR-064`).
   - `GET /api/v1/receivables` (`payments.js`): trả kèm `aging_summary_prd` (`current_not_due`, `bucket_0_15`, `bucket_16_30`, `bucket_31_60`, `bucket_over_60`, `total_overdue_balance`, `total_balance` theo `AC-016.1`) bên cạnh `aging_summary` cũ.
   - `reports.js` (`/dashboard`, `/summary`) & `admin/audit-logs.js` (`RP-08`):
     - `billed` = `SUM(i.total_amount + i.credit_offset_amount) FILTER (WHERE i.status NOT IN ('DRAFT', 'VOID'))`.
     - `collected` (*Tiền thực thu ròng*, `PRD 15.3`) = `GREATEST(0, SUM(p.amount CONFIRMED) - SUM(cb.amount REFUNDED_DIRECT) - SUM(cb.settlement_refund_amount REFUNDED_IN_SETTLEMENT WHERE refunded_at IS NOT NULL))` theo tháng `Asia/Ho_Chi_Minh`.
     - `invoice_settled` (`PRD 15.1`) = `SUM(i.paid_amount + i.credit_offset_amount) FILTER (WHERE i.status NOT IN ('DRAFT', 'VOID'))`.
     - Trên `/dashboard`: trả cả `invoice_settled` trong `revenue_12m` và cả hai chỉ số hàng đợi 4 mắt `pending_invoice_adjustments` + `pending_credit_refunds` trong `kpis`.
     - **Hỗ trợ xuất `.xlsx` chuẩn OpenXML (`toXlsxBuffer` trong `api/src/utils/csv.js`) song song với `CSV` (`FR-058`, `PRD 15.2`):** trên `GET /api/v1/audit-logs?scope=financial&format=xlsx` (`RP-08`, đủ 12 thực thể tài chính, mở cho `SYS_ADMIN`, `OWNER`, và `MANAGER` khi `scope=financial`) và `GET /api/v1/reports/summary?section=revenue|aging|all&format=xlsx|csv` (`RP-01`, `RP-02` xuất đầy đủ 4 nhóm tuổi nợ `0–15 / 16–30 / 31–60 / >60` ngày).

4. **Quyết toán cuối kỳ 2 bước chuẩn M06 — Chống trừ đúp `UTILITY_DEBT` & Tách bạch tuyệt đối `credit_balance` với Tiền cọc (`depositSettlement.js`, `deposits.js` — `FR-024`, `FR-040`, `FR-068`, `RP-07`):**
   - Trong `checkSettlementPreconditions` (`deposits.js`): xác định `lastActiveDayYmd` qua `resolveContractLastActiveDay` (có tra cứu hợp đồng con chuyển phòng `is_room_transfer` để lấy đúng `addDaysYmd(ch.start_date, -1)` và `endPeriod = lastActiveDayYmd.slice(0, 7)`), bổ sung điều kiện chặn cứng `no_pending_invoice_adjustments` + `no_pending_credit_refunds` và trường cảnh báo phi-chặn `unbilled_final_period: { has_unbilled_period, period: endPeriod, active_days }`.
   - Khóa dòng hóa đơn trong `POST /:id/settlement/approve` và `POST /:id/payout` qua `SELECT * FROM fn_lock_invoices_for_authorized_viewer($1, NULL)` để `OWNER` không bao giờ bị `FORCE RLS` lọc rỗng dòng.
   - **Công thức bất biến chống trừ đúp `UTILITY_DEBT` (`computeFinalSettlementWithCredit` trong `api/src/services/depositSettlement.js` & `deposits.js`):**
     - `credit_applied_to_rent = Math.min(availableCredit, rentDebt)`
     - `credit_applied_to_service = Math.min(availableCredit - credit_applied_to_rent, serviceDebt)`
     - `remaining_rent_debt = Math.max(0, rentDebt - credit_applied_to_rent)`
     - **`remaining_service_debt = Math.max(0, serviceDebt - credit_applied_to_service)`**
     - `credit_applied_to_damages = Math.min(availableCredit - credit_applied_to_rent - credit_applied_to_service, Math.max(0, sumItems - heldBefore))`
     - `credit_refund_amount = Math.max(0, availableCredit - credit_applied_to_rent - credit_applied_to_service - credit_applied_to_damages)`
     - `remainingDepositAfterItems = Math.max(0, heldBefore - sumItems)`
     - **`covered_service_debt = Math.min(remainingDepositAfterItems, remaining_service_debt)`** *(tuyệt đối dùng `remaining_service_debt` hậu-tín-dụng, KHÔNG dùng `serviceDebt` gốc!)*
     - `deposit_refund_amount = Math.max(0, remainingDepositAfterItems - covered_service_debt)`
     - `uncovered_items_shortfall = Math.max(0, sumItems - heldBefore - credit_applied_to_damages)`
     - `total_payout_amount = deposit_refund_amount + credit_refund_amount`
   - Trong `commitSettlementAccounting` (`deposits.js:1209`), `POST /:id/settlement/approve` (`:1419`) và `POST /:id/payout` (`:1982`): chỉ ghi `deposit_transaction` (`type = 'deduct', category = 'UTILITY_DEBT'`) và truyền tham số `p_covered_service_debt` bằng chính xác **`covered_service_debt`** hậu-tín-dụng; chỉ ghi `deposit_transaction` (`type = 'refund'`) khi `deposit_refund_amount > 0`, bảo toàn tuyệt đối `closing_held` trên báo cáo sổ cọc `RP-07`.

---

### 5.6. Giao diện Frontend & Trải nghiệm Xác nhận An toàn (`PRD Mục 8.2`, `15.1–15.3`, `16.1`, `16.2`)

1. **Hằng số trạng thái (`statuses.js`), `Idempotency-Key` (`api.js`), Thông báo (`NotificationsPage.jsx`, `NotificationsTab.jsx`) & Quyền (`usePermission.js`):**
   - `SUBSCRIPTION_STATUS` (`TERMINATED`), `INVOICE_STATUS` (`ADJUSTED`, `VOID`), `INVOICE_ADJUSTMENT_STATUS`, `CREDIT_BALANCE_STATUS`, helper `roundVND`, `todayVietnamYmd`, `previewSubscriptionProrata`, `canConfirmInvoiceVoid`, `canActorApproveInvoiceAdjustment`, `canActorApproveCreditRefund`, `resolveSettlementPayoutSummary`.
   - `api.js` request interceptor: tự động gán `Idempotency-Key` khi `!config.headers['Idempotency-Key']` trên mọi request `POST`/`PATCH`/`DELETE` tới `/api/v1/invoices`, `/api/v1/payments`, `/api/v1/service-catalog`, `/api/v1/service-subscriptions`, `/api/v1/contracts`, `/api/v1/deposits`, `/api/v1/resident` (tái sử dụng khóa khi tự động thử lại do `401`, sinh khóa mới khi người dùng sửa form sau lỗi `4xx`).
   - `NotificationsPage.jsx` & `NotificationsTab.jsx`: bổ sung nhãn & điều hướng cho `CREDIT_APPLIED`, `CREDIT_REFUND_PENDING`, `CREDIT_REFUNDED`, `CREDIT_REFUND_REJECTED`, `INVOICE_ADJUSTMENT_PENDING`, `INVOICE_ADJUSTED`, `INVOICE_VOIDED`, `SERVICE_TERMINATED`, `PAYMENT_REMINDER` (`upper.includes('CREDIT')` điều hướng về tab `invoices` của Cư dân).

2. **Cổng Cư dân (`ServicesTab.jsx`, `InvoicesTab.jsx`, `OverviewTab.jsx`):**
   - `ServicesTab.jsx`: mở khóa hủy `0 ₫` trước `start_date`, dùng `previewSubscriptionProrata` (`roundVND`), bổ sung `max={contractEffectiveEndStr}` cho ô ngày hủy, nút *"Rút yêu cầu hủy"*, đưa `'TERMINATED'` vào danh sách lịch sử, **và bảo toàn cấu trúc `cancelTarget` đi kèm `<VehiclePlatesBadges plates={cancelTarget.vehicle_plates}` trong phạm vi 400 ký tự để tương thích 100% với `parkingPlatesUi.test.js:170-174`**.
   - `InvoicesTab.jsx` & `OverviewTab.jsx`: hiển thị thẻ `available_credit_balance`, loại trừ cả `'DRAFT'` lẫn `'VOID'` khỏi tổng phí tóm tắt, mở nút *"Thanh toán"* / *"Báo đã thanh toán"* cho cả trạng thái `'ADJUSTED'` khi `remaining > 0` (`OverviewTab.jsx:1077, 1285`, `InvoicesTab.jsx:206, 247-256, 506`), và hiển thị giải trình công thức `formula_meta`.

3. **Cổng Quản trị & Chủ nhà (`ServiceCatalogPage.jsx`, `SubscriptionsPage.jsx`, `InvoicesPage.jsx`, `InvoiceDetailPage.jsx`, `PaymentsPage.jsx`, `ContractDetailPage.jsx`, `DepositsPage.jsx`, `DashboardPage.jsx`, `ReportsPage.jsx`, `AuditLogsPage.jsx`):**
   - `SubscriptionsPage.jsx`: thêm bộ lọc `{ value: 'TERMINATED', label: 'Đã chấm dứt' }`, dùng `previewSubscriptionProrata`, tùy chọn `zero_usage (0 ₫)`, nút *"Giữ lại dịch vụ"*, và thông báo kết quả đồng bộ hóa đơn 3 kịch bản.
   - `InvoicesPage.jsx` & `InvoiceDetailPage.jsx`: trình sửa dòng nháp `DRAFT` (`MANAGER`), hộp thoại xác nhận ngữ cảnh khi phát hành (`PRD 16.1`), hộp thoại xác nhận 2 bước gõ lại `invoice_code` khi `VOID` (`PRD 16.2`), hộp thoại lập/duyệt/từ chối 4 mắt `invoice_adjustment` (gồm cả `LATE_FEE` `FR-064`), và Tab `Lịch sử / Kiểm toán` (`PRD 8.2`).
   - **`PaymentsPage.jsx` (`AC-016.1`):** bổ sung `'ADJUSTED'` vào bộ lọc hóa đơn mở khi tạo phiếu thu, đồng thời nâng cấp tab Công nợ phải thu (`Receivables`) — gồm thẻ tổng hợp, bộ lọc nhóm tuổi nợ, nhãn trên bảng và xuất CSV/Excel — sang đúng 4 nhóm quá hạn chuẩn `PRD AC-016.1`: **`Chưa đến hạn` / `0–15 ngày` / `16–30 ngày` / `31–60 ngày` / `>60 ngày`** (đọc từ `aging_summary_prd`).
   - `ContractDetailPage.jsx`: dùng `<StatusBadge status={row.status} domain="subscription" />` (**giữ nguyên `row.note` trong khối `title="Dịch vụ đi kèm theo hợp đồng"` để tương thích 100% với `contractCreationUi.test.js:104-107`**), gắn link `/admin/invoices/${row.actual_invoice.id}` trên lịch dự kiến, và hiển thị sổ `credit_balance` kèm thao tác lập/duyệt/từ chối hoàn tiền trực tiếp 4 mắt (`FR-040`).
   - `DepositsPage.jsx`: bổ sung `credit_balance` vào `AUDIT_ENTITY_META`, hiển thị tách bạch `deposit_refund_amount` / `credit_refund_amount` / `total_payout_amount`, cảnh báo đề nghị chờ duyệt, và băng cảnh báo vàng + nút 1 chạm **"Sinh hóa đơn Pro-rata kỳ cuối"** khi `unbilled_final_period.has_unbilled_period === true`.
   - **`DashboardPage.jsx`, `ReportsPage.jsx` & `AuditLogsPage.jsx` (`PRD 15.1–15.3`, `AC-016.1`, `FR-058`):**
     - `DashboardPage.jsx`: vẽ đồng thời `billed`, `invoice_settled` (*Giá trị hóa đơn kỳ đã tất toán*, `PRD 15.1`) và `collected` (*Tiền thực thu ròng*, `PRD 15.3`), kèm thẻ chỉ báo hàng đợi chờ duyệt 4 mắt (`pending_invoice_adjustments` và `pending_credit_refunds`) có drill-down trực tiếp.
     - `ReportsPage.jsx`: cập nhật Tab Doanh thu (`RP-01`) hiển thị & xuất `CSV`/`.xlsx` cho `billed`, `invoice_settled`, `collected`, `credit_refunded`; cập nhật Tab Công nợ (`RP-02`) hiển thị & xuất `CSV`/`.xlsx` theo đúng 4 nhóm quá hạn `0–15`, `16–30`, `31–60`, `>60` ngày + `Chưa đến hạn` (`AC-016.1`); nhúng Tab `'financial-audit'` (*Nhật ký tài chính `RP-08`*) dùng `<AuditLogsView lockedScope="financial" />`.
     - `AuditLogsPage.jsx`: đủ 12 thực thể tài chính trong `ENTITY_OPTIONS`, hỗ trợ cả **Xuất CSV** lẫn **Xuất Excel (`.xlsx`)** (`format=xlsx`, `FR-058`).

---

## 6. Ma trận Truy vết Đặc tả PRD v2.0 (PRD Traceability Matrix)

| Mã tham chiếu PRD v2.0 | Yêu cầu cốt lõi trong PRD | Mục Thiết kế (`Spec v6`) |
|---|---|---|
| `Mục 6.1–6.2`, `NFR-008`, `AC-019.1`, `FR-070` | `SYS_ADMIN` chỉ đọc (`R`) trên dịch vụ/hóa đơn/thanh toán (dự phòng `A` khi tòa chưa có `OWNER`); `OWNER` xem & duyệt (`R, A`); `MANAGER` `CRU` theo tòa; RLS 2 lớp tương thích `FORCE RLS`; chặn sửa danh mục mặc định dùng chung liên tòa | `3.1`, `5.1.7`, `5.3.1` |
| `Mục 8.2`, `16.1`, `16.2` | Hộp thoại xác nhận ngữ cảnh khi phát hành hóa đơn; xác nhận 2 bước nhập lại `invoice_code` khi `VOID`; Tab `Lịch sử / Kiểm toán` trên chi tiết hóa đơn | `5.4.2`, `5.4.3`, `5.6.3` |
| `Mục 10.1`, `12.4`, `FR-039` | Nhắc nợ tự động đa mốc `-3`, `0`, `+3`, `+7`, `+15` ngày quanh `due_date` (khử trùng idempotent + `audit_log`) | `5.5.3` |
| `Mục 10.3`, `13.2`, `13.3`, `13.4` | Làm tròn `ROUND(x, -3)`; mã trạng thái `TERMINATED`, `ADJUSTED`, `VOID`; bảng `credit_balance`; `Unique(contract_id, period)` active; `paid_amount <= total_amount`; múi giờ `Asia/Ho_Chi_Minh` | `3.2–3.3`, `5.1.2–5.1.6`, `5.2` |
| `Mục 14.3`, `14.5` | `Idempotency-Key` trên thao tác tài chính; Migration tuần tự có Rollback SQL & backfill an toàn | `5.1`, `5.4`, `5.5.1`, `5.6.1` |
| `FR-006`, `NFR-010`, `AC-020.1` | Ghi `audit_log` `before`/`after` đầy đủ cho sửa dòng `DRAFT`, duyệt 4 mắt, danh mục/đăng ký dịch vụ, từ chối thanh toán và cron tự động | `5.1.7`, `5.3.1`, `5.4.2`, `5.5.3` |
| `FR-013`, `FR-021`, `FR-024`, `FR-068` | Chuyển phòng 4 bước M06 (biên nửa mở `newStart - 1` kể cả ngày tương lai), gộp `tenant_id` trên `credit_balance`, quyết toán 4 lượt không trừ đúp `UTILITY_DEBT`, không dùng cọc trừ `RENT` | `5.1.7`, `5.3.2`, `5.5.1`, `5.5.4` |
| `FR-029`, `FR-065`, `AC-015.3` | Hủy dịch vụ Pro-rata theo ngày thực tế (`0 ₫` trước ngày ở), bảng giá 3 tầng nghiêm ngặt (`is_price_locked`), lưu công thức giải trình trên `invoice_line` | `5.1.1–5.1.2`, `5.2`, `5.3.1` |
| `FR-033`, `FR-066`, `AC-003.2`, `AC-015.1` | Sinh hóa đơn kỳ cuối (`excludeSettledDeposits`), làm mới `DRAFT` theo `contract_id`, trả `skipped_contracts`, ẩn tuyệt đối `DRAFT` khỏi `RESIDENT` | `5.1.7`, `5.4.1`, `5.4.2` |
| `FR-034`, `FR-035`, `FR-064`, `AC-017.3`, `NFR-016` | Khóa bất biến sau `ISSUED`, phê duyệt 4 mắt tự trị trong SQL cho điều chỉnh/hủy/miễn giảm `LATE_FEE`, append-only `LATE_FEE` | `5.1.3`, `5.1.7`, `5.4.3`, `5.5.3` |
| `FR-037`, `FR-038`, `FR-040`, `AC-016.1` | Giao hoán thanh toán Order A/B, nộp thừa vào `credit_balance` (bù trừ kỳ sau hoặc hoàn 4 mắt kèm ảnh minh chứng), 4 nhóm tuổi nợ `0–15 / 16–30 / 31–60 / >60` trên API & UI | `5.1.4`, `5.5.1–5.5.3`, `5.6.3` |
| `Mục 15.1–15.3`, `FR-058`, `RP-07`, `RP-08` | Tách `billed`, `invoice_settled`, `collected` ròng trên Dashboard & Reports; giữ sạch sổ cọc `RP-07`; `RP-08` đủ 12 thực thể tài chính; xuất cả `CSV` và `.xlsx` | `5.5.3`, `5.5.4`, `5.6.3` |

---

## 7. Phần để bước lập kế hoạch & thi công quyết định (Left to the Builder)

- Cách tổ chức chi tiết các hàm nội bộ trong `api/src/services/serviceBilling.js` và `api/src/services/invoiceLifecycle.js` (miễn đảm bảo các thao tác đổi trạng thái, cập nhật bản nháp, lập/duyệt điều chỉnh 4 mắt qua RPC `fn_resolve_invoice_adjustment`, lập/duyệt hoàn tiền `credit_balance` 4 mắt qua RPC `fn_resolve_credit_refund`, khóa đọc hóa đơn qua `fn_lock_invoices_for_authorized_viewer`, cập nhật `receivable`, `credit_balance` và ghi `audit_log` luôn thực thi nguyên tử trong cùng PostgreSQL transaction dưới RLS).
- Cấu trúc chi tiết payload `invoice_sync` và `skipped_contracts` để giao diện hiển thị thông báo hướng dẫn bước tiếp theo rõ ràng.
- Cách chia tách bộ kiểm thử tự động (`node --test`) bao phủ đầy đủ toàn bộ các ràng buộc trong Mục `5` và Ma trận Truy vết Mục `6`.
