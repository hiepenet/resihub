# Kế hoạch Triển khai: Kiểm thử UAT Tuần 11–12 & Tối ưu Hiệu năng Hệ thống Tối đa

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tối ưu hóa toàn diện hệ thống ResiHub để mọi API đạt phản hồi `< 500ms` (đặc biệt rút ngắn sinh hóa đơn hàng loạt 52 căn từ `~4,750ms` xuống `< 150ms`), tải trang Frontend `< 2s`, và thực thi kịch bản UAT tự động khép kín vòng đời kỳ thu phí `2026-11` cho tòa **Vinhomes Ocean Park 1** (`VOP-1`, 52 hợp đồng đang hiệu lực).

**Architecture:**
1. **Batch Billing Engine Optimization (`generateInvoicesCore`)**: Thay thế mô hình N+1 truy vấn tuần tự trong vòng lặp hợp đồng (~1,500+ câu lệnh SQL/tòa) bằng cơ chế **Bulk Pre-fetch** (`ANY($1::uuid[])`) cho đồng hồ, chỉ số đã chốt, khóa chỉ số đã lên hóa đơn, bảng giá dịch vụ hợp đồng, đăng ký dịch vụ, truy thu kỳ trước, hóa đơn nháp hiện hữu, phí phạt chậm nộp và số dư credit; đồng thời chèn dòng hóa đơn (`invoice_line`) hàng loạt bằng `UNNEST`.
2. **Database Index & RLS Policy Tuning**: Tối ưu chính sách RLS trên `invoice_line` và `deposit_transaction` từ `IN (SELECT id FROM ...)` sang `EXISTS (SELECT 1 FROM ... WHERE id = ...)` để tận dụng Primary Key Index Lookup; bổ sung các composite index cho `invoice`, `payment`, `receivable`, `meter_reading`.
3. **HTTP Compression & Frontend Code-Splitting**: Bổ sung middleware nén Gzip/Brotli sử dụng `node:zlib` trong `api/src/server.js` (giảm kích thước payload JSON lớn hơn 90%) và cấu hình `manualChunks` trong `frontend/vite.config.js` để tách vendor chunks giúp thời gian tải trang `< 2s`.
4. **Closed-Loop UAT & Benchmark Suite (`2026-11`)**: Xây dựng bộ kiểm thử tích hợp tự động (`api/test/performance_uat_week11_12.test.js`) kiểm tra toàn bộ vòng đời kỳ `2026-11` cho 52 căn hộ tại `VOP-1` và xuất báo cáo đối soát + benchmark chi tiết.

**Tech Stack:** Node.js (ESM), Express, PostgreSQL (RLS, `pg`), React 18, Vite 5, `node:test`.

---

### Task 1: Thiết lập bộ kiểm thử TDD Hiệu năng & UAT Vòng đời Kỳ 2026-11 (RED Phase)

**Files:**
- Create: `d:\resihub\api\test\performance_uat_week11_12.test.js`

- [ ] **Step 1: Viết bài kiểm thử tích hợp hiệu năng & UAT khép kín kỳ `2026-11`**
  - Kiểm tra dữ liệu chuẩn Vinhomes (`VOP-1` có 52 hợp đồng `ACTIVE`, 104 chỉ số điện/nước `CONFIRMED` kỳ `2026-11`).
  - Kiểm tra nén HTTP (`Content-Encoding: gzip`) trên các API trả về danh sách lớn.
  - Kiểm tra SLA `< 500ms` cho toàn bộ API cốt lõi (`dashboard`, `summary`, `deposit-ledger`, `invoices`, `payments`, `receivables`, `meters`, `apartments`, `contracts`, `tenants`, `audit-logs`, `resident/overview`).
  - Kiểm tra SLA `< 500ms` cho `generateInvoicesCore` (52 căn tòa `VOP-1`, cả chế độ `autoIssue = false` và `autoIssue = true`).
  - Thực thi kịch bản UAT khép kín kỳ `2026-11` trên 52 căn tòa `VOP-1`:
    1. Kiểm tra chỉ số điện/nước đã chốt (`CONFIRMED`).
    2. Sinh hóa đơn nháp hàng loạt (`DRAFT`) cho 52 căn.
    3. Phát hành hàng loạt 52 hóa đơn (`DRAFT` → `ISSUED`), xác minh 52 khoản phải thu (`receivable`) được tạo chính xác.
    4. Gạch nợ / thanh toán (`POST /api/v1/payments`) và xác minh đối soát công nợ (`invoice.status`, `receivable.status`, `reports/dashboard`, `reports/summary`).
- [ ] **Step 2: Chạy kiểm thử để xác nhận trạng thái FAIL (RED)**
  - Run: `node --test test/performance_uat_week11_12.test.js` (tại `d:\resihub\api`)
  - Expected: FAIL ở kiểm tra nén Gzip và SLA `< 500ms` của `generateInvoicesCore` (hiện tại mất `~3,800ms - 4,750ms`).

---

### Task 2: Tối ưu hóa Engine Sinh Hóa đơn Hàng loạt (`generateInvoicesCore`) & Phát hành Hóa đơn

**Files:**
- Modify: `d:\resihub\api\src\routes\invoices.js`
- Modify: `d:\resihub\api\src\services\invoiceLifecycle.js`

- [ ] **Step 1: Tối ưu `generateInvoicesCore` trong `d:\resihub\api\src\routes\invoices.js`**
  - Pre-fetch hàng loạt trước vòng lặp hợp đồng bằng `ANY($1::uuid[])`:
    - Danh sách đồng hồ `ACTIVE` và chỉ số `CONFIRMED` trong kỳ của tất cả `apartmentIds`.
    - Tập hợp `meter_reading_id` và `(contract_id, meter_type)` đã được lập hóa đơn trong `targetPeriod`.
    - Bảng giá dịch vụ hợp đồng (`contract_service_price`) của tất cả `contractIds`.
    - Đăng ký dịch vụ (`service_subscription` kèm `service_catalog`) của tất cả `contractIds`.
    - Dữ liệu truy thu dịch vụ kỳ trước (`priorUnbilledSubscriptionArrears`) chỉ truy vấn cho các hợp đồng có `service_subscription.start_date` thuộc kỳ trước `targetPeriod`, gom nhóm theo `contract_id`.
    - Hóa đơn `DRAFT` hiện hữu của `(contractIds, targetPeriod)`.
    - Các khoản `late_fee_accrual_tracker` trạng thái `PENDING` của `contractIds`.
    - Tập hợp `contract_id` có `credit_balance` khả dụng (`status IN ('AVAILABLE', 'PARTIALLY_USED') AND remaining_amount > 0`) để chỉ gọi `applyAvailableCreditsInTx` khi thực sự có số dư credit.
  - Thay thế vòng lặp `INSERT INTO invoice_line` từng dòng bằng câu lệnh `INSERT INTO invoice_line ... SELECT * FROM UNNEST(...)` (1 câu lệnh/hóa đơn).
  - Loại bỏ câu lệnh `SELECT * FROM invoice WHERE id = $1` dư thừa khi không có thay đổi từ `applyAvailableCreditsInTx` hoặc khi `issueDraftInvoiceInTx` đã trả về bản ghi cập nhật.
- [ ] **Step 2: Tối ưu `issueDraftInvoiceInTx` trong `d:\resihub\api\src\services\invoiceLifecycle.js`**
  - Cho phép truyền tùy chọn `prefetchedInvoice` (khi vừa tạo mới trong cùng transaction) và gộp/tối ưu truy vấn tạo `receivable`, `notification`, `audit_log` để giảm số round-trip SQL.

---

### Task 3: Tối ưu hóa Database Indexes, RLS Policies & HTTP Compression Middleware

**Files:**
- Modify: `d:\resihub\api\src\db\migrations\003_constraints_and_indexes.sql`
- Modify: `d:\resihub\api\src\db\migrations\005_rls_enable_and_policies.sql`
- Modify: `d:\resihub\api\src\server.js`

- [ ] **Step 1: Tối ưu RLS Policies trong `005_rls_enable_and_policies.sql`**
  - Cập nhật `rls_invoice_line_select` từ `invoice_id IN (SELECT id FROM invoice)` sang `EXISTS (SELECT 1 FROM invoice i WHERE i.id = invoice_line.invoice_id)`.
  - Cập nhật `rls_deposit_txn_select` từ `deposit_id IN (SELECT id FROM deposit)` sang `EXISTS (SELECT 1 FROM deposit d WHERE d.id = deposit_transaction.deposit_id)`.
- [ ] **Step 2: Bổ sung Composite Indexes trong `003_constraints_and_indexes.sql`**
  - Thêm `idx_invoice_org_period_status ON invoice(org_id, period, status)`.
  - Thêm `idx_payment_org_status_paid_at ON payment(org_id, status, paid_at DESC)`.
  - Thêm `idx_receivable_org_status_due ON receivable(org_id, status, due_date)`.
  - Chạy `npm run migrate` để áp dụng ngay vào PostgreSQL.
- [ ] **Step 3: Bổ sung HTTP Compression Middleware (`gzip`/`deflate`) trong `d:\resihub\api\src\server.js`**
  - Sử dụng `node:zlib` tích hợp sẵn của Node.js để nén phản hồi JSON/text khi client gửi header `Accept-Encoding: gzip`.

---

### Task 4: Tối ưu hóa Frontend Build & Thời gian Tải trang (`< 2s`)

**Files:**
- Modify: `d:\resihub\frontend\vite.config.js`

- [ ] **Step 1: Cấu hình Code-Splitting (`manualChunks`) trong `d:\resihub\frontend\vite.config.js`**
  - Tách `react-vendor` (`react`, `react-dom`, `react-router-dom`), `chart-vendor` (`chart.js`, `react-chartjs-2`), và `icons-vendor` (`lucide-react`) để giảm kích thước chunk khởi tạo ban đầu và tăng hiệu quả tải song song + caching.
- [ ] **Step 2: Kiểm tra `npm run build` và đo thời gian tải trang thực tế**
  - Xác minh build thành công không còn cảnh báo chunk lớn và thời gian tải trang `< 2s`.

---

### Task 5: Chạy Kiểm thử Toàn diện & Xuất Biên bản Benchmark + Đối soát UAT Kỳ 2026-11

**Files:**
- Create Artifact: `C:\Users\minhd\.gemini\antigravity\brain\5bf94229-33d2-4b95-873b-df1f1938aea2\uat_performance_benchmark_report.md`

- [ ] **Step 1: Chạy lại bộ kiểm thử hiệu năng & UAT (`performance_uat_week11_12.test.js`) — xác nhận GREEN**
- [ ] **Step 2: Chạy toàn bộ bộ kiểm thử hồi quy của dự án (`npm test` trong `d:\resihub\api`) — xác nhận 100% PASS**
- [ ] **Step 3: Khôi phục trạng thái dữ liệu chuẩn và xuất Biên bản Kiểm thử Hiệu năng & UAT Kỳ 2026-11 (`uat_performance_benchmark_report.md`)**

