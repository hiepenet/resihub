# Thiết kế: Phí phạt chậm thanh toán – Carry-Forward & Bất biến hóa đơn

**Ngày:** 2026-11-05  
**Trạng thái:** DRAFT – chờ duyệt  
**Tác giả:** Agent (Antigravity)  
**Tham chiếu PRD:** FR-064, §5.3, §13.2, §13.5, §23-Q3  
**Tham chiếu spec trước:** `2026-11-02-service-cancellation-and-invoice-recalc-design.md` §4.3.6

---

## 1. Mục tiêu

| Mục tiêu | Nội dung |
|---|---|
| **G1** | Tuân thủ PRD §13.2 & §13.5: `subtotal_amount` và `total_amount` của hóa đơn đã ISSUED **không bao giờ thay đổi** sau khi phát hành |
| **G2** | Tuân thủ FR-064: phí phạt chậm 100.000 ₫/ngày sau 5 ngày quá hạn **xuất hiện dưới dạng dòng phí riêng trên hóa đơn kỳ kế tiếp** |
| **G3** | Carry-forward theo vòng: T chưa trả → phạt dồn sang T+1; T+1 vẫn chưa trả → phạt tiếp dồn sang T+2 (chỉ delta, không nhân đôi) |
| **G4** | Kỳ cuối hợp đồng (không có T+1): phí phạt vẫn được ghi nhận, không bị rơi mất; đưa vào tất toán cọc FR-024 |
| **G5** | Sửa Bug #1: `calculateContractOpenDebts` và `fn_apply_deposit_settlement_accounting` bỏ sót `'LATE_FEE'` trong `non_rent_gross` |
| **G6** | Sửa Bug #2: `fn_resolve_invoice_adjustment` tính `v_new_total` thiếu trừ `v_new_credit_offset` |
| **G7** | Giữ toàn bộ cơ chế 4-eyes waiver cho LATE_FEE (`invoice_adjustment.adjustment_target = 'LATE_FEE'`) |

## 2. Không thuộc phạm vi (Non-goals)

- Thay đổi luật phạt (mức 100.000 ₫/ngày, ân hạn 5 ngày) — đó là cấu hình `billing_config`
- Giải quyết câu hỏi mở PRD §23 Q3 về trần phạt tối đa — vẫn dùng `lateFeeCap` cấu hình
- Thay đổi giao diện thông báo quá hạn cho cư dân
- Migrate dữ liệu lịch sử LATE_FEE cũ đã được append lên hóa đơn gốc

---

## 3. Phân tích hiện trạng

### 3.1 Vấn đề

```
daily.js Step 7 (hiện tại):
  computeLateFeeAccrual(overdue_invoice) → deltaFee > 0
  → INSERT invoice_line(invoice_id=OVERDUE_INV, item_type='LATE_FEE', amount=deltaFee)
  → UPDATE invoice SET subtotal_amount += deltaFee, total_amount += deltaFee WHERE id=OVERDUE_INV
  → UPDATE receivable SET amount += deltaFee WHERE invoice_id=OVERDUE_INV
```

Vi phạm: `total_amount` của hóa đơn đã ISSUED/OVERDUE thay đổi mỗi ngày (PRD §13.2).

### 3.2 Lý do spec cũ chọn cách này (§4.3.6)

Spec `2026-11-02` §4.3.6 giải thích: cơ chế append-only lên hóa đơn gốc được giữ có chủ đích để xử lý kỳ cuối hợp đồng (không còn kỳ sau). Thiết kế này sẽ thay thế bằng giải pháp toàn diện hơn, giải quyết cả kỳ cuối mà không vi phạm bất biến.

---

## 4. Thiết kế mới

### 4.1 Luồng tổng quát

```
Hằng ngày (cron daily.js):
  Với mỗi hóa đơn OVERDUE/ISSUED/PARTIALLY_PAID có nợ gốc chưa trả:
    1. Tính accrual = computeLateFeeAccrual(...)  → deltaFee, expectedTotalLateFee
    2. Lưu vào bảng mới: late_fee_accrual_tracker
       (invoice_id, accrued_total, as_of_date, chargeable_days)
    3. KHÔNG sửa subtotal_amount / total_amount của hóa đơn gốc
    4. KHÔNG insert invoice_line vào hóa đơn gốc

Khi sinh hóa đơn kỳ T+1 (generateInvoicesCore):
  Với mỗi hợp đồng:
    1. Tìm tất cả tracker records của hợp đồng (invoice_id thuộc contract)
       WHERE carried_to_invoice_id IS NULL (chưa được carry forward)
    2. Tính tổng accrued_total (đã trừ những khoản đã được carry)
    3. INSERT invoice_line vào DRAFT hóa đơn T+1:
       (item_type='LATE_FEE', amount=total_pending_accrual, description='Phí phạt chậm kỳ trước dồn sang')
    4. Đánh dấu tracker records: carried_to_invoice_id = invoice_T+1_id
    5. recalculateDraftInvoiceTotalsInTx() như thường lệ

Kỳ cuối hợp đồng (contract.status = EXPIRED/TERMINATED, không có T+1):
  Tạo "Late Fee Settlement Invoice":
    → Hóa đơn đặc biệt loại LATE_FEE_SETTLEMENT (xem §4.4)
    → Sinh khi cron phát hiện contract đã kết thúc nhưng còn tracker chưa carried
    → Xuất hiện trong calculateContractOpenDebts → deposit settlement
```

### 4.2 Bảng mới: `late_fee_accrual_tracker`

```sql
CREATE TABLE late_fee_accrual_tracker (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                uuid NOT NULL REFERENCES organization(id),
  contract_id           uuid NOT NULL REFERENCES contract(id),
  invoice_id            uuid NOT NULL REFERENCES invoice(id),  -- hóa đơn gốc đang quá hạn
  accrued_total         bigint NOT NULL DEFAULT 0,             -- tổng phí phạt tích lũy tính đến as_of_date
  chargeable_days       int NOT NULL DEFAULT 0,
  as_of_date            date NOT NULL,                         -- ngày tính (effectiveDateYmd của cron)
  carried_to_invoice_id uuid REFERENCES invoice(id),           -- NULL = chưa carry, NOT NULL = đã được đưa vào T+1
  carried_at            timestamptz,
  created_at            timestamptz NOT NULL DEFAULT NOW(),
  updated_at            timestamptz NOT NULL DEFAULT NOW(),

  CONSTRAINT uq_lf_tracker_invoice_asof UNIQUE (invoice_id, as_of_date)
);
```

> **Lưu ý thiết kế:** Bảng này là `UPSERT` hằng ngày theo `(invoice_id, as_of_date)`. `accrued_total` tại ngày D = tổng phí phạt lũy kế tính đến ngày D (bằng `expectedTotalLateFee` từ `computeLateFeeAccrual`). Khi carry, chỉ carry delta = `accrued_total_D - đã_carry_trước`. Xem §4.3.

### 4.3 Carry-Forward Logic (chi tiết)

Mỗi tracker record lưu `accrued_total` = **lũy kế toàn bộ** đến `as_of_date`. Khi carry sang T+1:

```
amount_to_carry = tracker.accrued_total_latest
                - SUM(invoice_line.amount WHERE item_type='LATE_FEE' AND source_invoice_id=tracker.invoice_id AND invoice_id=T_prev)
```

Trong thực tế, để đơn giản và chắc chắn không double-count: tracker chỉ có **1 record per source invoice** (upsert, không phải append hằng ngày). Mỗi ngày cron **UPDATE** tracker để tăng `accrued_total`, không insert mới. Khi carry forward, dùng `accrued_total` tại thời điểm carry.

Nếu T+1 cũng bị quá hạn → T+2: `accrued_total` được tính lại trên tracker của T+1, bao gồm cả phần phạt mới phát sinh trong kỳ T+1. LATE_FEE line đã được đưa vào T+1 (từ kỳ T) không tạo thêm phạt mới (anti-penalty-on-penalty: `item_type='LATE_FEE'` không phải nợ gốc).

### 4.4 Kỳ cuối hợp đồng: Late Fee Settlement Invoice

**Quyết định:** Khi contract `EXPIRED/TERMINATED` và còn tracker chưa carry, cron tạo một **hóa đơn tất toán phí phạt** (`invoice_type = 'LATE_FEE_SETTLEMENT'`).

**Lý do chọn cách này (PRD-aligned):**
- FR-024: deposit settlement phải capture **toàn bộ công nợ còn lại** — một invoice riêng đảm bảo nó xuất hiện trong `calculateContractOpenDebts`
- §13.2: invoice entity có trường `type`; thêm giá trị mới không phá vỡ schema
- Hóa đơn này có `receivable` riêng → hiện trên UI aging report đúng vị trí
- 4-eyes waiver vẫn áp dụng được (`invoice_adjustment.adjustment_target = 'LATE_FEE'`)
- PRD §23 Q3 chưa chốt về trần/dừng → ta tuân thủ: phạt đến ngày contract kết thúc (ngày `contract.actual_end_date` hoặc `end_date`)

**Schema:**
```sql
ALTER TABLE invoice ADD COLUMN IF NOT EXISTS invoice_type text
  NOT NULL DEFAULT 'REGULAR'
  CHECK (invoice_type IN ('REGULAR', 'LATE_FEE_SETTLEMENT'));
```

**Điều kiện tạo:**
```
Cron daily.js:
  Với mỗi contract có status IN ('EXPIRED', 'TERMINATED'):
    Tìm tracker records WHERE carried_to_invoice_id IS NULL AND contract_id = C
    IF EXISTS AND SUM(accrued_total) > 0:
      IF chưa tồn tại LATE_FEE_SETTLEMENT invoice cho contract này:
        INSERT invoice (invoice_type='LATE_FEE_SETTLEMENT', period=NULL hoặc period=kỳ cuối, status='DRAFT')
        INSERT invoice_line (item_type='LATE_FEE', amount=SUM accrued_total)
        issueDraftInvoiceInTx() → ISSUED → receivable OPEN
        UPDATE tracker: carried_to_invoice_id = new_invoice_id
      ELSE (đã tồn tại, cần update nếu accrual tăng thêm):
        UPDATE invoice_line và invoice total (chỉ được phép vì invoice này ở DRAFT trước khi issue)
```

**Ràng buộc:** `UNIQUE(contract_id, period)` không vi phạm vì `period = NULL` hoặc dùng period kỳ cuối + `invoice_type` làm key phụ.

**Hiển thị UI:** Trên `InvoiceDetailPage`, hóa đơn `LATE_FEE_SETTLEMENT` có badge "Phí phạt tất toán" màu cam, không có nút "Phát hành thủ công" (auto-issued bởi cron). Kế toán có thể lập `invoice_adjustment` với `adjustment_target='LATE_FEE'` để miễn/giảm.

---

## 5. Sửa Bug #1 — LATE_FEE thiếu trong tính nợ dịch vụ (Deposit Settlement)

### 5.1 Vị trí

| File | Dòng | Vấn đề |
|---|---|---|
| `api/src/routes/deposits.js` | ~131–135 | `non_rent_gross: il.item_type IN ('SERVICE','ELECTRICITY','WATER','OTHER')` thiếu `'LATE_FEE'` |
| `api/src/db/migrations/048_...sql` | ~1901–1905 | `v_raw_service: il.item_type IN ('SERVICE','ELECTRICITY','WATER','OTHER')` trong `fn_apply_deposit_settlement_accounting` thiếu `'LATE_FEE'` |

### 5.2 Fix

```sql
-- Trước:
il.item_type IN ('SERVICE', 'ELECTRICITY', 'WATER', 'OTHER')

-- Sau:
il.item_type IN ('SERVICE', 'ELECTRICITY', 'WATER', 'OTHER', 'LATE_FEE')
```

Áp dụng ở **cả 2 vị trí**. Trong migration `055`, re-define `fn_apply_deposit_settlement_accounting` với fix này (hoặc patch bằng `CREATE OR REPLACE FUNCTION`).

---

## 6. Sửa Bug #2 — `fn_resolve_invoice_adjustment` thiếu trừ credit_offset

### 6.1 Vị trí

`api/src/db/migrations/048_...sql` ~dòng 1443 trong `fn_resolve_invoice_adjustment`:

```sql
-- Hiện tại (SAI):
v_new_total := GREATEST(0, v_new_subtotal + v_new_adjustment);

-- Đúng:
v_new_total := GREATEST(0, v_new_subtotal + v_new_adjustment - v_inv.credit_offset_amount);
```

### 6.2 Fix

Trong migration `055`, dùng `CREATE OR REPLACE FUNCTION fn_resolve_invoice_adjustment` với dòng fix trên.

---

## 7. Thay đổi kỹ thuật chi tiết

### 7.1 Migration `055_late_fee_carry_forward.sql`

1. `CREATE TABLE late_fee_accrual_tracker` (§4.2)
2. `ALTER TABLE invoice ADD COLUMN invoice_type text DEFAULT 'REGULAR' CHECK(...)`
3. `CREATE OR REPLACE FUNCTION fn_resolve_invoice_adjustment` — patch Bug #2
4. `CREATE OR REPLACE FUNCTION fn_apply_deposit_settlement_accounting` — patch Bug #1
5. Indexes: `idx_lf_tracker_contract`, `idx_lf_tracker_invoice`, `idx_lf_tracker_pending` (WHERE `carried_to_invoice_id IS NULL`)
6. RLS policies cho `late_fee_accrual_tracker` (MANAGER/ACCOUNTANT read; cron qua adminPool write)

### 7.2 `daily.js` Step 7 — Refactor

**Trước:** Insert `invoice_line` + UPDATE `invoice.subtotal_amount/total_amount` + UPDATE `receivable`  
**Sau:**

```js
// Thay toàn bộ UPDATE invoice và INSERT invoice_line bằng:
await txClient.query(
  `INSERT INTO late_fee_accrual_tracker
     (org_id, contract_id, invoice_id, accrued_total, chargeable_days, as_of_date)
   VALUES ($1, $2, $3, $4, $5, $6)
   ON CONFLICT (invoice_id, as_of_date) DO UPDATE
     SET accrued_total = EXCLUDED.accrued_total,
         chargeable_days = EXCLUDED.chargeable_days,
         updated_at = NOW()`,
  [inv.org_id, inv.contract_id, inv.id, accrual.expectedTotalLateFee, accrual.chargeableDays, effectiveDateYmd]
);
// Giữ audit_log ACCRUE_LATE_FEE
// KHÔNG UPDATE invoice subtotal/total
// KHÔNG INSERT invoice_line trực tiếp
// KHÔNG UPDATE receivable
```

**Thêm sau loop Step 7:** Bước 7b — Tạo LATE_FEE_SETTLEMENT cho kỳ cuối (xem §4.4).

### 7.3 `daily.js` Bước mới 7b — Final Period Settlement Invoice

```js
// Với mỗi contract EXPIRED/TERMINATED có pending tracker:
const finalContracts = await adminPool.query(`
  SELECT DISTINCT lft.contract_id, lft.org_id,
                  SUM(lft.accrued_total) AS total_pending
  FROM late_fee_accrual_tracker lft
  JOIN contract c ON c.id = lft.contract_id
  WHERE lft.carried_to_invoice_id IS NULL
    AND c.status IN ('EXPIRED', 'TERMINATED')
    AND ($1::uuid IS NULL OR c.building_id = $1)
  GROUP BY lft.contract_id, lft.org_id
  HAVING SUM(lft.accrued_total) > 0
`, [buildingId]);

for (const fc of finalContracts.rows) {
  // Check chưa tồn tại LATE_FEE_SETTLEMENT invoice
  const existing = await adminPool.query(`
    SELECT id FROM invoice
    WHERE contract_id = $1 AND invoice_type = 'LATE_FEE_SETTLEMENT'
    LIMIT 1
  `, [fc.contract_id]);
  
  if (existing.rows.length > 0) continue; // idempotent

  // Tạo invoice LATE_FEE_SETTLEMENT
  const txClient = await adminPool.connect();
  try {
    await txClient.query('BEGIN');
    // INSERT invoice + invoice_line + issueDraftInvoiceInTx + UPDATE tracker
    // ... (chi tiết trong implementation plan)
    await txClient.query('COMMIT');
  } catch(e) {
    await txClient.query('ROLLBACK');
  } finally {
    txClient.release();
  }
}
```

### 7.4 `generateInvoicesCore` — Inject LATE_FEE Lines

Thêm vào cuối vòng lặp từng contract, **sau khi tạo xong invoice DRAFT** và **trước khi** `recalculateDraftInvoiceTotalsInTx`:

```js
// Tìm pending tracker cho contract này (hóa đơn kỳ trước chưa carry)
const pendingTracker = await client.query(`
  SELECT SUM(accrued_total) AS total_accrual,
         MAX(chargeable_days) AS max_days,
         STRING_AGG(invoice_id::text, ',') AS source_invoice_ids
  FROM late_fee_accrual_tracker
  WHERE contract_id = $1
    AND carried_to_invoice_id IS NULL
`, [contractId]);

const totalAccrual = Number(pendingTracker.rows[0]?.total_accrual || 0);
if (totalAccrual > 0) {
  await client.query(`
    INSERT INTO invoice_line (invoice_id, item_type, description, quantity, unit, unit_price, amount, formula_meta)
    VALUES ($1, 'LATE_FEE', $2, 1, 'kỳ', $3, $3, $4::jsonb)
  `, [newInvoiceId, `Phí phạt chậm thanh toán kỳ trước (dồn sang kỳ này)`, totalAccrual,
      JSON.stringify({ source_invoice_ids: pendingTracker.rows[0].source_invoice_ids, carry_forward: true })]);
  
  // Đánh dấu tracker đã carry
  await client.query(`
    UPDATE late_fee_accrual_tracker
    SET carried_to_invoice_id = $1, carried_at = NOW(), updated_at = NOW()
    WHERE contract_id = $2 AND carried_to_invoice_id IS NULL
  `, [newInvoiceId, contractId]);
}
```

### 7.5 `calculateContractOpenDebts` (`deposits.js`) — Bug #1 Fix

Thêm `'LATE_FEE'` vào danh sách `item_type` cho `non_rent_gross`. Cũng bao gồm `LATE_FEE_SETTLEMENT` invoices trong truy vấn (vì chúng có `invoice_type` khác nhưng vẫn là công nợ của hợp đồng).

### 7.6 UI — `InvoiceDetailPage.jsx`

1. Thêm badge `invoice_type === 'LATE_FEE_SETTLEMENT'` → "Phí phạt tất toán" (màu orange)
2. Trên hóa đơn `OVERDUE`, hiển thị note informational: "Phí phạt đang tích lũy — sẽ được đưa vào hóa đơn kỳ kế tiếp" (không hiện tổng tiền phạt tạm tính để tránh nhầm lẫn với total_amount)
3. Ẩn nút "Phát hành" trên hóa đơn `LATE_FEE_SETTLEMENT` (auto-issued bởi cron)

---

## 8. Tác động đến Tests

| Test file | Tests cần sửa | Hướng sửa |
|---|---|---|
| `week5DailyCronAndLateFee.test.js` | 4a–4e: pin behavior Step 7 append trực tiếp vào hóa đơn gốc | Sửa để kiểm tra `late_fee_accrual_tracker` được cập nhật; hóa đơn gốc KHÔNG thay đổi total |
| `contractEarlyTerminationBillingSync.test.js` | 4b: pin LATE_FEE lines on existing invoice | Sửa để kiểm tra LATE_FEE lines xuất hiện trên T+1 invoice hoặc LATE_FEE_SETTLEMENT |
| `fullWebsiteWhiteBlackBox.test.js` | R-11: OVERDUE + direct LATE_FEE accrual | Sửa assertion: total_amount bất biến; tracker có record; sau khi generate T+1 thì invoice_line LATE_FEE xuất hiện trên T+1 |
| `migration048RlsAndRpc.test.js` | Test `fn_resolve_invoice_adjustment` với credit_offset | Thêm test case: LATE_FEE waiver + credit_offset_amount > 0 → total_amount tính đúng |

---

## 9. Trả lời câu hỏi mở: Kỳ cuối hợp đồng

**Câu hỏi:** Khi hợp đồng đã kết thúc (EXPIRED/TERMINATED) và không còn hóa đơn kỳ kế tiếp để dồn phạt vào, hệ thống xử lý thế nào?

**Quyết định (PRD-aligned):**

> Cron tạo một **hóa đơn tất toán phí phạt** (`invoice_type = 'LATE_FEE_SETTLEMENT'`) với `period = NULL` (hoặc period của kỳ cuối + suffix), tự động phát hành (ISSUED), tạo `receivable OPEN`. Hóa đơn này xuất hiện trong `calculateContractOpenDebts` → deposit settlement (FR-024). Kế toán có thể lập `invoice_adjustment` để miễn/giảm (4-eyes, FR-064). Hóa đơn này bất biến sau khi ISSUED (§13.2). Cron chạy idempotent — chỉ tạo 1 lần.

**Lý do PRD-aligned:**
- FR-024: "Khấu trừ > cọc → phần thiếu thành công nợ RECEIVABLE_AFTER_MOVE_OUT" — LATE_FEE_SETTLEMENT invoice là công nợ chính xác dạng này
- §13.2: invoice entity được thiết kế capture mọi loại công nợ tài chính
- §13.5: "Bất biến sau phát hành/duyệt; chỉ điều chỉnh bằng bút toán mới" — đúng với thiết kế 4-eyes waiver
- §23 Q3 (mở): phạt tính đến ngày contract kết thúc, không tiếp tục sau move-out

---

## 10. Rủi ro và Giảm thiểu

| Rủi ro | Khả năng | Giảm thiểu |
|---|---|---|
| Migrate data: hóa đơn cũ đã có LATE_FEE lines append lên | Trung bình | Không cần migrate — cơ chế cũ và mới coexist: tracker chỉ áp cho invoice OVERDUE từ ngày deploy migration `055` trở đi |
| Double-count nếu tracker và invoice_line cũ cùng tồn tại | Thấp (nếu không migrate) | Carry-forward chỉ đọc tracker, không đọc invoice_line cũ của invoice gốc |
| UNIQUE(contract_id, period) vi phạm cho LATE_FEE_SETTLEMENT | Thấp | period = NULL thoát khỏi constraint (hoặc dùng generated period riêng); cần kiểm tra constraint DB |
| `calculateContractOpenDebts` đọc cả LATE_FEE_SETTLEMENT lẫn tracker chưa carry | Có thể double-count | Chỉ cộng invoice-based debt (LATE_FEE_SETTLEMENT đã ISSUED); tracker chưa carry chỉ là "phạt đang tích lũy chưa hóa đơn" — KHÔNG đưa vào settlement |

---

## 11. Phụ lục: Trạng thái machine cho tracker

```
[Khởi tạo hằng ngày bởi cron]
  invoice OVERDUE → UPSERT tracker(invoice_id, as_of_date, accrued_total)

[Khi sinh hóa đơn T+1 bình thường]
  tracker.carried_to_invoice_id = T+1_invoice_id  → state: CARRIED

[Khi contract kết thúc, không có T+1]
  Tạo LATE_FEE_SETTLEMENT invoice → tracker.carried_to_invoice_id = settlement_invoice_id → state: CARRIED

[Khi LATE_FEE được miễn/giảm (4-eyes)]
  invoice_adjustment trên LATE_FEE_SETTLEMENT hoặc T+1 invoice
  tracker không thay đổi (immutable after carried)
```

