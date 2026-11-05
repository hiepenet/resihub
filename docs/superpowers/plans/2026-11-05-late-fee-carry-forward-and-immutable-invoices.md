# Late Fee Carry-Forward & Immutable Invoices — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor FR-064 late fee handling so issued invoices are immutable (§13.2), accrued fees carry forward to the next period's DRAFT invoice, and the final-period case is handled via a dedicated `LATE_FEE_SETTLEMENT` invoice; also fix Bug #1 (LATE_FEE excluded from deposit debt calc) and Bug #2 (`fn_resolve_invoice_adjustment` total inflation).

**Architecture:** A new `late_fee_accrual_tracker` table accumulates (upserts) daily late fee accruals per source invoice without touching the invoice itself. When a new billing-period DRAFT is generated, `generateInvoicesCore` reads pending tracker rows and injects a carry-forward `LATE_FEE` line. For contracts that have ended with no next period, the daily cron creates a standalone `LATE_FEE_SETTLEMENT` invoice. Both bugs are fixed inside a new migration `055` that also re-creates the two affected SQL functions via `CREATE OR REPLACE FUNCTION`.

**Tech Stack:** Node.js (ES modules), PostgreSQL 15, `adminPool` / `getUserClient` pattern, existing `computeLateFeeAccrual()` from `serviceBilling.js`, existing `issueDraftInvoiceInTx()` from `invoices.js`, `roundVND` from `pricing.js`.

**Spec:** `docs/superpowers/specs/2026-11-05-late-fee-carry-forward-and-immutable-invoices-design.md`

## Global Constraints

- `roundVND(x)` = `Math.round(x / 1000) * 1000` — use for every monetary delta
- Timezone: `Asia/Ho_Chi_Minh`; date-only fields stored as `date` (YYYY-MM-DD string in JS), never `timestamptz`
- `adminPool` only for cron/jobs; routes use `getUserClient` with RLS
- Never DELETE invoice_line, invoice, payment, receivable, credit_balance records (NFR-016)
- No BEFORE DELETE triggers on financial tables
- `audit_log`: INSERT only, never UPDATE/DELETE
- Late fees: `item_type = 'LATE_FEE'`; grace period default 5 days; rate default 100,000 ₫/day
- Anti-penalty-on-penalty: `LATE_FEE` lines on the destination invoice do NOT themselves generate new accruals (tracker only tracks source invoices that have non-LATE_FEE principal debt)
- Next migration number: **055** (`055_late_fee_carry_forward_and_immutable_invoices.sql`)
- `UNIQUE(contract_id, period)` on `invoice` table — `LATE_FEE_SETTLEMENT` invoices use `period = NULL` to avoid conflict
- All monetary amounts stored as `bigint` (integer VND)

## Review Focus

1. **Carry-forward on a T+1 invoice that also becomes overdue** — the tracker for the T invoice is marked `carried_to_invoice_id = T+1`. The T+1 invoice's own accrual is tracked in a separate tracker row for T+1. When T+2 is generated, only T+1's tracker is pending (T's tracker is already carried). No double-counting. *(Covered by Task 5 test 5c.)*
2. **4-eyes LATE_FEE waiver on a carry-forward LATE_FEE line in T+1** — `invoice_adjustment` with `adjustment_target='LATE_FEE'` is applied to the T+1 invoice. The tracker for T is already marked carried and is unaffected. The existing `fn_resolve_invoice_adjustment` handles this correctly (Bug #2 fix ensures totals are right). *(Covered by Task 6 test 6b.)*
3. **Contract with LATE_FEE_SETTLEMENT invoice that also gets a 4-eyes waiver** — kế toán creates an `invoice_adjustment` on the settlement invoice; `fn_resolve_invoice_adjustment` runs; tracker stays carried; `calculateContractOpenDebts` reads the updated total. *(Covered by Task 6 test 6c.)*
4. **Deposit settlement when both regular OVERDUE and LATE_FEE_SETTLEMENT exist** — `calculateContractOpenDebts` must include both; `serviceDebt` correctly counts LATE_FEE lines from both invoice types. *(Covered by Task 7 test 7b.)*
5. **Cron idempotency: running Step 7 twice on the same day** — `UPSERT (invoice_id, as_of_date)` means the second run updates the same row to the same value; no duplicate tracker rows. *(Covered by Task 3 test 3c.)*

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `api/src/db/migrations/055_late_fee_carry_forward_and_immutable_invoices.sql` | **Create** | DDL for `late_fee_accrual_tracker`, `invoice.invoice_type` column; Bug #2 fix in `fn_resolve_invoice_adjustment`; Bug #1 fix in `fn_apply_deposit_settlement_accounting`; RLS policies |
| `api/src/jobs/daily.js` | **Modify** lines 515–697 | Replace Step 7 body: stop mutating issued invoices; upsert tracker instead. Add Step 7b: create `LATE_FEE_SETTLEMENT` for ended contracts |
| `api/src/routes/invoices.js` | **Modify** `generateInvoicesCore` | Inject pending tracker accruals as `LATE_FEE` line into new DRAFT; mark tracker carried |
| `api/src/routes/deposits.js` | **Modify** line 132 | Add `'LATE_FEE'` to `non_rent_gross` filter (Bug #1 JS side) |
| `api/src/routes/invoices.js` (export) | **Modify** | Export `createLateFeeSettlementInvoiceInTx` helper reused by daily.js Step 7b |
| `api/test/week5DailyCronAndLateFee.test.js` | **Modify** tests 4a–4e | Rewrite to assert tracker upsert + invoice total immutability |
| `api/test/contractEarlyTerminationBillingSync.test.js` | **Modify** test 4b | Assert LATE_FEE lines on T+1 invoice, not on original OVERDUE invoice |
| `api/test/fullWebsiteWhiteBlackBox.test.js` | **Modify** lines 1832–1855 | Rewrite R-11 assertion: tracker updated, invoice total unchanged |
| `api/test/migration048RlsAndRpc.test.js` | **Modify** | Add test for Bug #2 fix: `fn_resolve_invoice_adjustment` with `credit_offset_amount > 0` |

---

## Task 1: Migration 055 — DDL + Bug #2 Fix + Bug #1 SQL Fix

**Files:**
- Create: `api/src/db/migrations/055_late_fee_carry_forward_and_immutable_invoices.sql`
- Test: `api/test/migration048RlsAndRpc.test.js` (extend existing file)

**Interfaces:**
- Produces:
  - Table `late_fee_accrual_tracker(id, org_id, contract_id, invoice_id, accrued_total bigint, chargeable_days int, as_of_date date, carried_to_invoice_id uuid, carried_at timestamptz, created_at, updated_at)` with `UNIQUE(invoice_id, as_of_date)` and `idx_lf_tracker_pending WHERE carried_to_invoice_id IS NULL`
  - Column `invoice.invoice_type text NOT NULL DEFAULT 'REGULAR' CHECK(invoice_type IN ('REGULAR','LATE_FEE_SETTLEMENT'))`
  - Fixed `fn_resolve_invoice_adjustment`: line 1443 → `v_new_total := GREATEST(0, v_new_subtotal + v_new_adjustment - v_inv.credit_offset_amount)`
  - Fixed `fn_apply_deposit_settlement_accounting`: `il.item_type IN ('SERVICE','ELECTRICITY','WATER','OTHER','LATE_FEE')` in `v_raw_service` calculation

- [ ] **Step 1: Write failing test for Bug #2 (LATE_FEE waiver + credit_offset inflation)**

```js
// In migration048RlsAndRpc.test.js — add inside the existing describe block
test('fn_resolve_invoice_adjustment: LATE_FEE waiver with credit_offset_amount does not inflate total', async () => {
  // Setup: invoice with subtotal=1000000, credit_offset_amount=200000, total_amount=800000
  // Apply LATE_FEE waiver of -300000
  // Expected: v_new_total = GREATEST(0, (1000000) + (-300000) - 200000) = 500000
  // Bug: without fix, total = GREATEST(0, 1000000 + (-300000)) = 700000 (inflated by 200000)
  const { rows } = await adminPool.query(
    `SELECT fn_resolve_invoice_adjustment($1, $2, 'APPROVE', NULL) AS result`,
    [testInvoiceId, testAdjId]
  );
  const after = await adminPool.query('SELECT total_amount, credit_offset_amount FROM invoice WHERE id=$1', [testInvoiceId]);
  assert.equal(Number(after.rows[0].total_amount), 500000, 'Bug #2: total must deduct credit_offset_amount');
});
```

- [ ] **Step 2: Run test to verify it fails**

```
cd d:\resihub\api && node --test test/migration048RlsAndRpc.test.js 2>&1 | Select-String "LATE_FEE waiver"
```
Expected: FAIL — either `700000 !== 500000` or test infrastructure error.

- [ ] **Step 3: Write `055_late_fee_carry_forward_and_immutable_invoices.sql`**

Sections in order:
1. `ALTER TABLE invoice ADD COLUMN IF NOT EXISTS invoice_type text NOT NULL DEFAULT 'REGULAR' CHECK(invoice_type IN ('REGULAR','LATE_FEE_SETTLEMENT'))` — add after `IF NOT EXISTS` guard.
2. `CREATE TABLE IF NOT EXISTS late_fee_accrual_tracker(...)` with all columns per spec §4.2 and `UNIQUE(invoice_id, as_of_date)`.
3. Three indexes: `idx_lf_tracker_contract ON late_fee_accrual_tracker(contract_id)`, `idx_lf_tracker_invoice ON late_fee_accrual_tracker(invoice_id)`, `idx_lf_tracker_pending ON late_fee_accrual_tracker(contract_id) WHERE carried_to_invoice_id IS NULL`.
4. RLS: `ALTER TABLE late_fee_accrual_tracker ENABLE ROW LEVEL SECURITY`. Policy: authenticated users with MANAGER/ACCOUNTANT/OWNER roles in same org can SELECT; no INSERT/UPDATE/DELETE via RLS (cron uses `adminPool`).
5. `CREATE OR REPLACE FUNCTION fn_resolve_invoice_adjustment(...)` — copy from migration 048 verbatim, change **only** line 1443:
   - From: `v_new_total := GREATEST(0, v_new_subtotal + v_new_adjustment);`
   - To: `v_new_total := GREATEST(0, v_new_subtotal + v_new_adjustment - v_inv.credit_offset_amount);`
6. `CREATE OR REPLACE FUNCTION fn_apply_deposit_settlement_accounting(...)` — copy from migration 048, change **only** the `item_type IN (...)` list for `v_raw_service` at line ~1902:
   - From: `il.item_type IN ('SERVICE', 'ELECTRICITY', 'WATER', 'OTHER')`
   - To: `il.item_type IN ('SERVICE', 'ELECTRICITY', 'WATER', 'OTHER', 'LATE_FEE')`

- [ ] **Step 4: Apply migration to test DB**

```
cd d:\resihub\api && node -e "
import('./src/db/client.js').then(({adminPool})=>
  adminPool.query(require('fs').readFileSync('./src/db/migrations/055_late_fee_carry_forward_and_immutable_invoices.sql','utf8'))
  .then(()=>{console.log('OK');process.exit(0)})
  .catch(e=>{console.error(e.message);process.exit(1)})
)"
```
Expected: `OK` with no errors.

- [ ] **Step 5: Run test to verify Bug #2 fix passes**

```
cd d:\resihub\api && node --test test/migration048RlsAndRpc.test.js 2>&1 | Select-String "LATE_FEE waiver|pass|fail"
```
Expected: PASS — `total_amount = 500000`.

- [ ] **Step 6: Verify `late_fee_accrual_tracker` table and `invoice.invoice_type` column exist**

```
cd d:\resihub\api && node -e "
import('./src/db/client.js').then(({adminPool})=>Promise.all([
  adminPool.query(\"SELECT column_name FROM information_schema.columns WHERE table_name='late_fee_accrual_tracker' ORDER BY ordinal_position\"),
  adminPool.query(\"SELECT column_name FROM information_schema.columns WHERE table_name='invoice' AND column_name='invoice_type'\")
]).then(([t,c])=>{console.log('tracker cols:',t.rows.map(r=>r.column_name).join(','));console.log('invoice_type:',c.rowCount);process.exit(0)}))"
```
Expected: tracker columns listed; `invoice_type` count = 1.

- [ ] **Step 7: Commit**

```
git add api/src/db/migrations/055_late_fee_carry_forward_and_immutable_invoices.sql api/test/migration048RlsAndRpc.test.js
git commit -m "feat(migration): 055 — late_fee_accrual_tracker, invoice_type, fix fn_resolve Bug#2, fix fn_apply_deposit Bug#1"
```

---

## Task 2: Bug #1 Fix — `deposits.js` JS-side

**Files:**
- Modify: `api/src/routes/deposits.js:132`
- Test: `api/test/contractEarlyTerminationBillingSync.test.js` (extend)

**Interfaces:**
- Consumes: existing `calculateContractOpenDebts(client, contractId)` function at line 118
- Produces: `calculateContractOpenDebts` now counts `LATE_FEE` invoice lines in `serviceDebt` (not `rentDebt` and not ignored)

- [ ] **Step 1: Write failing test**

```js
// Add to contractEarlyTerminationBillingSync.test.js
test('calculateContractOpenDebts: LATE_FEE lines counted in serviceDebt not rentDebt', async () => {
  // Setup: invoice with RENT=5000000, LATE_FEE=300000, paid=0
  // Expected: serviceDebt includes 300000, rentDebt = 5000000
  const result = await calculateContractOpenDebts(adminClient, testContractId);
  assert.ok(result.serviceDebt >= 300000, 'LATE_FEE must be counted in serviceDebt');
  assert.equal(result.rentDebt, 5000000, 'rentDebt must only count RENT lines');
});
```

- [ ] **Step 2: Run test to verify it fails**

```
cd d:\resihub\api && node --test test/contractEarlyTerminationBillingSync.test.js 2>&1 | Select-String "LATE_FEE lines counted"
```
Expected: FAIL — `serviceDebt` does not include 300000 (LATE_FEE excluded from filter).

- [ ] **Step 3: Fix `deposits.js` line 132**

In `calculateContractOpenDebts`, change:
```js
// From:
WHERE (il.item_type IN ('SERVICE', 'ELECTRICITY', 'WATER', 'OTHER')
// To:
WHERE (il.item_type IN ('SERVICE', 'ELECTRICITY', 'WATER', 'OTHER', 'LATE_FEE')
```
No other changes to the function.

- [ ] **Step 4: Run test to verify it passes**

```
cd d:\resihub\api && node --test test/contractEarlyTerminationBillingSync.test.js 2>&1 | Select-String "LATE_FEE lines counted|pass|fail"
```
Expected: PASS.

- [ ] **Step 5: Commit**

```
git add api/src/routes/deposits.js api/test/contractEarlyTerminationBillingSync.test.js
git commit -m "fix(deposits): Bug#1 — add LATE_FEE to non_rent_gross filter in calculateContractOpenDebts"
```

---

## Task 3: Refactor `daily.js` Step 7 — Tracker Upsert (Stop Mutating Invoices)

**Files:**
- Modify: `api/src/jobs/daily.js:515–697` (Step 7 body)
- Test: `api/test/week5DailyCronAndLateFee.test.js` (rewrite tests 4a–4e)

**Interfaces:**
- Consumes: `computeLateFeeAccrual({dueDateYmd, asOfDateYmd, totalAmount, paidAmount, creditOffsetAmount, principalAmount, grossAccruedLateFee, graceDays, lateFeePerDay, maxLateFeeCap})` → `{deltaFee, expectedTotalLateFee, chargeableDays, overdueDays, ...}` from `serviceBilling.js`
- Produces:
  - `late_fee_accrual_tracker` row upserted per overdue invoice per cron run: `(invoice_id, as_of_date, accrued_total=expectedTotalLateFee, chargeable_days, org_id, contract_id)`
  - `invoice.subtotal_amount`, `invoice.total_amount`, `invoice.paid_amount` **unchanged**
  - `invoice_line` with `item_type='LATE_FEE'` **NOT inserted into source invoice**
  - `audit_log` row: `action='ACCRUE_LATE_FEE_TRACKER'`, `entity='late_fee_accrual_tracker'`

> **Note on grossAccruedLateFee:** With the new design, the tracker's `accrued_total` represents the total expected fee from `computeLateFeeAccrual`. The `grossAccruedLateFee` input to `computeLateFeeAccrual` must now be fetched from the tracker (not from invoice_line), so it reflects what has already been committed to accrual: `SELECT accrued_total FROM late_fee_accrual_tracker WHERE invoice_id=$1 ORDER BY as_of_date DESC LIMIT 1`. If no tracker row exists, `grossAccruedLateFee = 0`.

- [ ] **Step 1: Rewrite tests 4a–4e in `week5DailyCronAndLateFee.test.js`**

```js
// 4a. Run cron asOfDate = 2028-05-06 (5 grace days → 0 chargeable days): no tracker row
await runDailySteps(asOf('2028-05-06'));
const trackerA = await adminPool.query('SELECT * FROM late_fee_accrual_tracker WHERE invoice_id=$1', [invId]);
assert.equal(trackerA.rowCount, 0, '4a: no tracker before grace period ends');
const invA = await adminPool.query('SELECT total_amount FROM invoice WHERE id=$1', [invId]);
assert.equal(Number(invA.rows[0].total_amount), 10000000, '4a: total_amount immutable');

// 4b. asOfDate = 2028-05-09 (8 overdue days → 3 chargeable → 300,000 ₫)
await runDailySteps(asOf('2028-05-09'));
const trackerB = await adminPool.query('SELECT accrued_total FROM late_fee_accrual_tracker WHERE invoice_id=$1 ORDER BY as_of_date DESC LIMIT 1', [invId]);
assert.equal(Number(trackerB.rows[0].accrued_total), 300000, '4b: tracker accrued_total=300000');
const invB = await adminPool.query('SELECT total_amount FROM invoice WHERE id=$1', [invId]);
assert.equal(Number(invB.rows[0].total_amount), 10000000, '4b: total_amount still immutable');

// 4c. Waiver -200,000 → tracker unaffected; next run accrues 100,000 delta (now day 10)
// (waiver is on the destination invoice, not source; tracker continues)
await runDailySteps(asOf('2028-05-10'));
const trackerC = await adminPool.query('SELECT accrued_total FROM late_fee_accrual_tracker WHERE invoice_id=$1 ORDER BY as_of_date DESC LIMIT 1', [invId]);
assert.equal(Number(trackerC.rows[0].accrued_total), 400000, '4c: tracker accrued_total=400000 (day 10)');

// 4d. late_fee_cap=500000: tracker caps at 500000 on day 2028-05-25 (20 chargeable > cap)
await setConfig({ late_fee_cap: 500000 });
await runDailySteps(asOf('2028-05-25'));
const trackerD = await adminPool.query('SELECT accrued_total FROM late_fee_accrual_tracker WHERE invoice_id=$1 ORDER BY as_of_date DESC LIMIT 1', [invId]);
assert.equal(Number(trackerD.rows[0].accrued_total), 500000, '4d: tracker capped at 500000');

// 4e. Principal paid in full → computeLateFeeAccrual returns deltaFee=0; tracker NOT updated beyond cap
await adminPool.query('UPDATE invoice SET paid_amount=10000000 WHERE id=$1', [invId]);
await runDailySteps(asOf('2028-05-30'));
const trackerE = await adminPool.query('SELECT accrued_total FROM late_fee_accrual_tracker WHERE invoice_id=$1 ORDER BY as_of_date DESC LIMIT 1', [invId]);
assert.equal(Number(trackerE.rows[0].accrued_total), 500000, '4e: tracker stays at cap after principal paid');
const invE = await adminPool.query('SELECT total_amount FROM invoice WHERE id=$1', [invId]);
assert.equal(Number(invE.rows[0].total_amount), 10000000, '4e: total_amount still never changed');
```

- [ ] **Step 2: Run tests 4a–4e to verify they fail**

```
cd d:\resihub\api && node --test test/week5DailyCronAndLateFee.test.js 2>&1 | Select-String "4a|4b|4c|4d|4e|immutable"
```
Expected: all 4a–4e FAIL (old behavior inserts invoice_lines and mutates total).

- [ ] **Step 3: Refactor `daily.js` Step 7 body (lines 515–697)**

Replace the inner `txClient` block content. Keep:
- The outer query selecting `lateCandidates` (overdue invoices with `paid_amount < total_amount`)
- The `cfg = orgBillingConfigMap.get(cand.org_id)` lookup
- The `BEGIN` / `FOR UPDATE` lock on the invoice
- The `lineAggRes` query that computes `grossAccruedFee` and `principalAmount` — **modify** to also read latest tracker: `SELECT accrued_total FROM late_fee_accrual_tracker WHERE invoice_id=$1 ORDER BY as_of_date DESC LIMIT 1`, use this as `grossAccruedLateFee` instead of `grossAccruedFee` from invoice_line sum.
- `computeLateFeeAccrual(...)` call — unchanged
- `audit_log` INSERT — change `action` to `'ACCRUE_LATE_FEE_TRACKER'`, `entity` to `'late_fee_accrual_tracker'`

Replace the three write statements (INSERT invoice_line, UPDATE invoice, UPDATE receivable) with a single UPSERT:
```sql
INSERT INTO late_fee_accrual_tracker
  (org_id, contract_id, invoice_id, accrued_total, chargeable_days, as_of_date)
VALUES ($1, $2, $3, $4, $5, $6)
ON CONFLICT (invoice_id, as_of_date) DO UPDATE
  SET accrued_total = EXCLUDED.accrued_total,
      chargeable_days = EXCLUDED.chargeable_days,
      updated_at = NOW()
```
Parameters: `[inv.org_id, inv.contract_id, inv.id, accrual.expectedTotalLateFee, accrual.chargeableDays, effectiveDateYmd]`

- [ ] **Step 4: Run tests 4a–4e to verify they pass**

```
cd d:\resihub\api && node --test test/week5DailyCronAndLateFee.test.js 2>&1 | Select-String "4a|4b|4c|4d|4e|pass|fail"
```
Expected: all PASS.

- [ ] **Step 5: Run full `week5` test suite to check no regressions**

```
cd d:\resihub\api && node --test test/week5DailyCronAndLateFee.test.js 2>&1 | tail -20
```
Expected: 0 failures.

- [ ] **Step 6: Commit**

```
git add api/src/jobs/daily.js api/test/week5DailyCronAndLateFee.test.js
git commit -m "refactor(daily): Step7 — upsert late_fee_accrual_tracker instead of mutating issued invoice"
```

---

## Task 4: `daily.js` Step 7b — LATE_FEE_SETTLEMENT Invoice for Ended Contracts

**Files:**
- Modify: `api/src/jobs/daily.js` (add Step 7b after Step 7 loop)
- Modify: `api/src/routes/invoices.js` (add + export `createLateFeeSettlementInvoiceInTx`)
- Test: `api/test/week5DailyCronAndLateFee.test.js` (add test 4f)

**Interfaces:**
- Consumes:
  - `issueDraftInvoiceInTx(client, {invoiceId, actorId, dueDate})` from `invoices.js` — existing export
  - `late_fee_accrual_tracker` rows with `carried_to_invoice_id IS NULL`
  - `contract.status IN ('EXPIRED','TERMINATED')`
- Produces:
  - `createLateFeeSettlementInvoiceInTx(client, {contractId, orgId, buildingId, tenantId, totalAccrual, sourceTrackerIds, effectiveDateYmd}) → {invoice}` exported from `invoices.js`
  - New `invoice` row with `invoice_type='LATE_FEE_SETTLEMENT'`, `period=NULL`, `status='ISSUED'`
  - New `invoice_line` row with `item_type='LATE_FEE'`, `amount=totalAccrual`
  - New `receivable` row `status='OPEN'` (via `issueDraftInvoiceInTx`)
  - `late_fee_accrual_tracker` rows updated: `carried_to_invoice_id=newInvoiceId`, `carried_at=NOW()`
  - `audit_log` row: `action='CREATE_LATE_FEE_SETTLEMENT_INVOICE'`

- [ ] **Step 1: Write failing test 4f**

```js
// In week5DailyCronAndLateFee.test.js, add test 4f:
test('4f: Step 7b creates LATE_FEE_SETTLEMENT invoice for ended contract with pending tracker', async () => {
  // Setup: contract EXPIRED, invoice OVERDUE with tracker accrued_total=300000, carried_to_invoice_id=NULL
  // Run cron
  await runDailySteps(asOf('2028-06-15'));
  // Assert: new LATE_FEE_SETTLEMENT invoice exists
  const settlement = await adminPool.query(
    `SELECT * FROM invoice WHERE contract_id=$1 AND invoice_type='LATE_FEE_SETTLEMENT'`,
    [expiredContractId]
  );
  assert.equal(settlement.rowCount, 1, '4f: settlement invoice created');
  assert.equal(settlement.rows[0].status, 'ISSUED', '4f: auto-issued');
  assert.equal(Number(settlement.rows[0].total_amount), 300000, '4f: total = accrued tracker amount');
  // Assert: receivable OPEN
  const rec = await adminPool.query(`SELECT * FROM receivable WHERE invoice_id=$1`, [settlement.rows[0].id]);
  assert.equal(rec.rows[0].status, 'OPEN', '4f: receivable OPEN');
  // Assert: tracker carried
  const tracker = await adminPool.query(`SELECT carried_to_invoice_id FROM late_fee_accrual_tracker WHERE invoice_id=$1`, [overdueInvId]);
  assert.equal(tracker.rows[0].carried_to_invoice_id, settlement.rows[0].id, '4f: tracker.carried_to_invoice_id set');
  // Assert: idempotent — run cron again, no second settlement invoice
  await runDailySteps(asOf('2028-06-16'));
  const settlement2 = await adminPool.query(`SELECT * FROM invoice WHERE contract_id=$1 AND invoice_type='LATE_FEE_SETTLEMENT'`, [expiredContractId]);
  assert.equal(settlement2.rowCount, 1, '4f: idempotent — only 1 settlement invoice');
});
```

- [ ] **Step 2: Run test 4f to verify it fails**

```
cd d:\resihub\api && node --test test/week5DailyCronAndLateFee.test.js 2>&1 | Select-String "4f"
```
Expected: FAIL.

- [ ] **Step 3: Implement `createLateFeeSettlementInvoiceInTx` in `invoices.js`**

Signature: `export async function createLateFeeSettlementInvoiceInTx(client, {contractId, orgId, buildingId, apartmentId, tenantId, totalAccrual, sourceTrackerIds, effectiveDateYmd})`

Logic:
1. `INSERT INTO invoice (org_id, building_id, apartment_id, contract_id, tenant_id, invoice_type, period, invoice_code, issue_date, due_date, status, subtotal_amount, total_amount, paid_amount) VALUES (..., 'LATE_FEE_SETTLEMENT', NULL, <generate code>, $effectiveDateYmd, $effectiveDateYmd + 7 days, 'DRAFT', $totalAccrual, $totalAccrual, 0) RETURNING *`
2. `INSERT INTO invoice_line (invoice_id, item_type, description, quantity, unit, unit_price, amount, formula_meta) VALUES (newId, 'LATE_FEE', 'Phí phạt chậm thanh toán kỳ cuối (tất toán)', 1, 'kỳ', $totalAccrual, $totalAccrual, $formulaMeta)`
3. Call `issueDraftInvoiceInTx(client, {invoiceId: newId, actorId: null, dueDate: effectiveDateYmd + 7})`
4. `INSERT INTO audit_log (..., 'CREATE_LATE_FEE_SETTLEMENT_INVOICE', 'invoice', newId, ...)`
5. Return the issued invoice row

Invoice code: `'LF-' + contractId.slice(0,8).toUpperCase() + '-' + effectiveDateYmd.replace(/-/g,'')`

- [ ] **Step 4: Implement Step 7b in `daily.js`** (after the Step 7 for-loop)

```js
// Step 7b: Create LATE_FEE_SETTLEMENT for ended contracts with pending tracker
const finalContracts = await adminPool.query(`
  SELECT lft.contract_id, lft.org_id,
         SUM(lft.accrued_total) AS total_pending,
         ARRAY_AGG(lft.id) AS tracker_ids,
         c.building_id, c.apartment_id, c.primary_tenant_id AS tenant_id
  FROM late_fee_accrual_tracker lft
  JOIN contract c ON c.id = lft.contract_id
  WHERE lft.carried_to_invoice_id IS NULL
    AND c.status IN ('EXPIRED','TERMINATED')
    AND ($1::uuid IS NULL OR c.building_id = $1)
  GROUP BY lft.contract_id, lft.org_id, c.building_id, c.apartment_id, c.primary_tenant_id
  HAVING SUM(lft.accrued_total) > 0
`, [buildingId]);

for (const fc of finalContracts.rows) {
  // Idempotency check
  const existing = await adminPool.query(
    `SELECT id FROM invoice WHERE contract_id=$1 AND invoice_type='LATE_FEE_SETTLEMENT' LIMIT 1`,
    [fc.contract_id]
  );
  if (existing.rowCount > 0) continue;

  const txClient = await adminPool.connect();
  try {
    await txClient.query('BEGIN');
    const newInv = await createLateFeeSettlementInvoiceInTx(txClient, {
      contractId: fc.contract_id, orgId: fc.org_id, buildingId: fc.building_id,
      apartmentId: fc.apartment_id, tenantId: fc.tenant_id,
      totalAccrual: Number(fc.total_pending),
      sourceTrackerIds: fc.tracker_ids, effectiveDateYmd
    });
    await txClient.query(
      `UPDATE late_fee_accrual_tracker SET carried_to_invoice_id=$1, carried_at=NOW(), updated_at=NOW()
       WHERE id = ANY($2)`,
      [newInv.id, fc.tracker_ids]
    );
    await txClient.query('COMMIT');
  } catch(e) {
    await txClient.query('ROLLBACK').catch(()=>{});
    console.error('[DailyJob] Step7b LATE_FEE_SETTLEMENT error:', e.message);
  } finally { txClient.release(); }
}
```

- [ ] **Step 5: Run test 4f to verify it passes**

```
cd d:\resihub\api && node --test test/week5DailyCronAndLateFee.test.js 2>&1 | Select-String "4f|pass|fail"
```
Expected: PASS.

- [ ] **Step 6: Commit**

```
git add api/src/jobs/daily.js api/src/routes/invoices.js api/test/week5DailyCronAndLateFee.test.js
git commit -m "feat(daily): Step7b — LATE_FEE_SETTLEMENT invoice for ended contracts; add createLateFeeSettlementInvoiceInTx"
```

---

## Task 5: `generateInvoicesCore` — Carry-Forward LATE_FEE Lines into New DRAFT

**Files:**
- Modify: `api/src/routes/invoices.js` — `generateInvoicesCore` function
- Test: `api/test/contractEarlyTerminationBillingSync.test.js` (add tests 5a–5c)

**Interfaces:**
- Consumes: `late_fee_accrual_tracker` rows with `carried_to_invoice_id IS NULL` for the contract being billed
- Produces: When a DRAFT invoice is created for period T+1 and the contract has pending tracker rows:
  - `invoice_line` with `item_type='LATE_FEE'`, `amount=SUM(accrued_total)` on the new T+1 invoice
  - `late_fee_accrual_tracker` rows updated: `carried_to_invoice_id = T+1_invoice_id`, `carried_at = NOW()`
  - `recalculateDraftInvoiceTotalsInTx` called after (existing; sums all lines including the new LATE_FEE line)

- [ ] **Step 1: Write failing test 5a — carry-forward on period generation**

```js
// In contractEarlyTerminationBillingSync.test.js
test('5a: generateInvoicesCore carries pending late_fee_accrual_tracker into new DRAFT', async () => {
  // Setup: contract ACTIVE, invoice T (period=2028-04) OVERDUE, tracker accrued_total=300000, carried_to_invoice_id=NULL
  // Run generateInvoicesCore for period 2028-05
  await generateInvoicesCore(adminClient, { contractId, orgId, targetPeriod: '2028-05', ... });
  // Assert: new 2028-05 DRAFT has LATE_FEE line = 300000
  const lines = await adminPool.query(`SELECT item_type, amount FROM invoice_line il JOIN invoice i ON i.id=il.invoice_id WHERE i.contract_id=$1 AND i.period='2028-05' AND il.item_type='LATE_FEE'`, [contractId]);
  assert.equal(lines.rowCount, 1, '5a: carry-forward LATE_FEE line created in T+1');
  assert.equal(Number(lines.rows[0].amount), 300000, '5a: carry-forward amount = tracker accrued_total');
  // Assert: tracker marked carried
  const tracker = await adminPool.query(`SELECT carried_to_invoice_id FROM late_fee_accrual_tracker WHERE contract_id=$1 AND carried_to_invoice_id IS NOT NULL`, [contractId]);
  assert.equal(tracker.rowCount, 1, '5a: tracker.carried_to_invoice_id set');
});
```

- [ ] **Step 2: Write failing test 5b — carry-forward does NOT double-count on second generate**

```js
test('5b: generateInvoicesCore does not carry again if tracker already carried', async () => {
  // After 5a: tracker is carried to 2028-05. Run generateInvoicesCore again for 2028-05 (should be idempotent — no duplicate LATE_FEE line since the DRAFT already exists)
  // If 2028-05 DRAFT already exists, generateInvoicesCore should skip (existing behavior via UNIQUE(contract_id, period))
  // Check: still only 1 LATE_FEE line on 2028-05 invoice
  const lines = await adminPool.query(`SELECT COUNT(*) AS cnt FROM invoice_line il JOIN invoice i ON i.id=il.invoice_id WHERE i.contract_id=$1 AND i.period='2028-05' AND il.item_type='LATE_FEE'`, [contractId]);
  assert.equal(Number(lines.rows[0].cnt), 1, '5b: no duplicate LATE_FEE line on re-run');
});
```

- [ ] **Step 3: Write failing test 5c — rolling: T+1 also overdue, T+2 gets both T and T+1 fees**

```js
test('5c: rolling carry-forward — T+2 invoice gets T+1 accrual (not T, already carried)', async () => {
  // Setup: T+1 (2028-05) invoice ISSUED and now overdue; tracker for T+1 accrued_total=200000
  // Run generateInvoicesCore for 2028-06 (T+2)
  await generateInvoicesCore(adminClient, { contractId, orgId, targetPeriod: '2028-06', ... });
  const lines = await adminPool.query(`SELECT amount FROM invoice_line il JOIN invoice i ON i.id=il.invoice_id WHERE i.contract_id=$1 AND i.period='2028-06' AND il.item_type='LATE_FEE'`, [contractId]);
  assert.equal(lines.rowCount, 1, '5c: T+2 has LATE_FEE carry from T+1 only');
  assert.equal(Number(lines.rows[0].amount), 200000, '5c: amount = T+1 tracker accrued (not T, already carried)');
});
```

- [ ] **Step 4: Run tests 5a–5c to verify they fail**

```
cd d:\resihub\api && node --test test/contractEarlyTerminationBillingSync.test.js 2>&1 | Select-String "5a|5b|5c"
```
Expected: all FAIL.

- [ ] **Step 5: Modify `generateInvoicesCore` in `invoices.js`**

Inside the per-contract loop, **after** the new `invoice` row is inserted (variable `newInvoiceId`) and **before** `recalculateDraftInvoiceTotalsInTx`:

```js
// Carry-forward: inject pending late fee accruals from prior overdue invoices of this contract
const pendingTracker = await client.query(`
  SELECT SUM(accrued_total)::bigint AS total_accrual,
         ARRAY_AGG(id) AS tracker_ids
  FROM late_fee_accrual_tracker
  WHERE contract_id = $1 AND carried_to_invoice_id IS NULL
`, [contractRow.id]);
const totalAccrual = Number(pendingTracker.rows[0]?.total_accrual || 0);
if (totalAccrual > 0) {
  const trackerIds = pendingTracker.rows[0].tracker_ids;
  await client.query(`
    INSERT INTO invoice_line (invoice_id, item_type, description, quantity, unit, unit_price, amount, formula_meta)
    VALUES ($1, 'LATE_FEE', 'Phí phạt chậm thanh toán kỳ trước (dồn sang kỳ này)', 1, 'kỳ', $2, $2, $3::jsonb)
  `, [newInvoiceId, totalAccrual, JSON.stringify({ carry_forward: true, source_tracker_ids: trackerIds })]);
  await client.query(`
    UPDATE late_fee_accrual_tracker
    SET carried_to_invoice_id = $1, carried_at = NOW(), updated_at = NOW()
    WHERE id = ANY($2)
  `, [newInvoiceId, trackerIds]);
}
```

- [ ] **Step 6: Run tests 5a–5c to verify they pass**

```
cd d:\resihub\api && node --test test/contractEarlyTerminationBillingSync.test.js 2>&1 | Select-String "5a|5b|5c|pass|fail"
```
Expected: all PASS.

- [ ] **Step 7: Commit**

```
git add api/src/routes/invoices.js api/test/contractEarlyTerminationBillingSync.test.js
git commit -m "feat(invoices): carry-forward late_fee_accrual_tracker into new DRAFT in generateInvoicesCore"
```

---

## Task 6: Update `contractEarlyTerminationBillingSync` test 4b + 4-eyes waiver tests

**Files:**
- Modify: `api/test/contractEarlyTerminationBillingSync.test.js` test 4b (currently pins LATE_FEE on source invoice)
- Test additions: 6b (waiver on carry-forward line), 6c (waiver on LATE_FEE_SETTLEMENT invoice)

**Interfaces:**
- Consumes: `fn_resolve_invoice_adjustment` (now with Bug #2 fix from Task 1)
- Produces: `contractEarlyTerminationBillingSync.test.js` test 4b asserts LATE_FEE lines on T+1 (not on original OVERDUE invoice)

- [ ] **Step 1: Rewrite test 4b**

```js
// 4b (new): LATE_FEE lines appear on the NEXT invoice, not on the original OVERDUE invoice
// Assert OVERDUE invoice has no LATE_FEE lines (tracker only)
const overdueLines = await adminPool.query(`SELECT item_type FROM invoice_line WHERE invoice_id=$1 AND item_type='LATE_FEE'`, [overdueInvoiceId]);
assert.equal(overdueLines.rowCount, 0, '4b: no LATE_FEE lines on original OVERDUE invoice');
// Assert tracker exists
const tracker = await adminPool.query(`SELECT accrued_total FROM late_fee_accrual_tracker WHERE invoice_id=$1`, [overdueInvoiceId]);
assert.ok(tracker.rowCount > 0, '4b: tracker row exists for OVERDUE invoice');
// Generate next period invoice
// Assert LATE_FEE line on next period invoice
const nextLines = await adminPool.query(`SELECT amount FROM invoice_line il JOIN invoice i ON i.id=il.invoice_id WHERE i.contract_id=$1 AND il.item_type='LATE_FEE' AND i.invoice_type='REGULAR'`, [contractId]);
assert.ok(nextLines.rowCount >= 1, '4b: LATE_FEE carry-forward line on T+1 invoice');
```

- [ ] **Step 2: Write test 6b — 4-eyes waiver on carry-forward LATE_FEE line in T+1**

```js
test('6b: 4-eyes LATE_FEE waiver approved on T+1 invoice correctly adjusts total (Bug#2 fix)', async () => {
  // T+1 invoice: total=10300000 (10000000 rent + 300000 carry LATE_FEE), credit_offset_amount=200000
  // Create invoice_adjustment: amount=-300000, adjustment_target='LATE_FEE'
  // Approve → fn_resolve_invoice_adjustment
  // Expected: total = GREATEST(0, 10300000 + (-300000) - 200000) = 9800000
  const after = await adminPool.query(`SELECT total_amount, credit_offset_amount FROM invoice WHERE id=$1`, [t1InvoiceId]);
  assert.equal(Number(after.rows[0].total_amount), 9800000, '6b: Bug#2 fix — credit_offset deducted from new total');
});
```

- [ ] **Step 3: Write test 6c — waiver on LATE_FEE_SETTLEMENT invoice**

```js
test('6c: 4-eyes LATE_FEE waiver on LATE_FEE_SETTLEMENT invoice reduces receivable', async () => {
  // LATE_FEE_SETTLEMENT invoice: total=300000, status=ISSUED
  // Create invoice_adjustment: amount=-100000, adjustment_target='LATE_FEE'
  // Approve → fn_resolve_invoice_adjustment
  // Expected: total=200000; receivable.amount=200000; tracker.carried_to_invoice_id unchanged
  const afterInv = await adminPool.query(`SELECT total_amount FROM invoice WHERE id=$1`, [settlementInvId]);
  assert.equal(Number(afterInv.rows[0].total_amount), 200000, '6c: settlement invoice total reduced');
  const afterRec = await adminPool.query(`SELECT amount FROM receivable WHERE invoice_id=$1`, [settlementInvId]);
  assert.equal(Number(afterRec.rows[0].amount), 200000, '6c: receivable reduced');
});
```

- [ ] **Step 4: Run tests 4b, 6b, 6c to verify they fail**

```
cd d:\resihub\api && node --test test/contractEarlyTerminationBillingSync.test.js 2>&1 | Select-String "4b|6b|6c"
```
Expected: FAIL.

- [ ] **Step 5: Run tests again after prior tasks' code changes are in place**

No new code needed here — relies on Task 1 (Bug #2 fix), Task 3 (Step 7 refactor), Task 4 (settlement invoice), Task 5 (carry-forward).

```
cd d:\resihub\api && node --test test/contractEarlyTerminationBillingSync.test.js 2>&1 | tail -20
```
Expected: all PASS.

- [ ] **Step 6: Commit**

```
git add api/test/contractEarlyTerminationBillingSync.test.js
git commit -m "test(termination): rewrite test 4b + add 6b/6c for carry-forward and waiver correctness"
```

---

## Task 7: Fix `fullWebsiteWhiteBlackBox.test.js` R-11 + Deposit Settlement Test

**Files:**
- Modify: `api/test/fullWebsiteWhiteBlackBox.test.js` lines 1832–1855 (R-11 assertion)
- Test addition 7b: deposit settlement with LATE_FEE in serviceDebt

**Interfaces:**
- Consumes: refactored Step 7 from Task 3; `calculateContractOpenDebts` with Bug #1 fix from Task 2
- Produces: R-11 asserts tracker updated + invoice total unchanged; 7b asserts deposit settlement captures LATE_FEE correctly

- [ ] **Step 1: Rewrite R-11 assertion in `fullWebsiteWhiteBlackBox.test.js` lines 1832–1855**

```js
// OLD (now wrong):
assert.equal(Number(overdueCheck.rows[0].total_amount), 5700000, 'R-11: Phải tự động cộng phạt...');

// NEW (correct behavior):
// Invoice total_amount immutable
assert.equal(Number(overdueCheck.rows[0].status), 'OVERDUE', 'R-11: status → OVERDUE');
assert.equal(Number(overdueCheck.rows[0].total_amount), 5500000, 'R-11: total_amount bất biến (không cộng phạt vào hóa đơn gốc)');
// Tracker updated
const tracker = await adminPool.query(`SELECT accrued_total FROM late_fee_accrual_tracker WHERE invoice_id=$1 ORDER BY as_of_date DESC LIMIT 1`, [finalInvId]);
assert.ok(tracker.rowCount > 0, 'R-11: tracker row created');
assert.equal(Number(tracker.rows[0].accrued_total), 200000, 'R-11: tracker.accrued_total = 2 ngày × 100.000 ₫');
```

- [ ] **Step 2: Write test 7b — deposit settlement includes LATE_FEE in serviceDebt**

```js
test('7b: deposit settlement — LATE_FEE in invoice counted as serviceDebt (Bug#1)', async () => {
  // Contract TERMINATED; invoice with RENT=5000000 + LATE_FEE=300000, paid=0
  const debts = await calculateContractOpenDebts(adminClient, contractId);
  assert.equal(debts.rentDebt, 5000000, '7b: rentDebt = RENT only');
  assert.ok(debts.serviceDebt >= 300000, '7b: serviceDebt includes LATE_FEE');
});
```

- [ ] **Step 3: Run fullWebsite + termination tests to verify**

```
cd d:\resihub\api && node --test test/fullWebsiteWhiteBlackBox.test.js 2>&1 | tail -30
```
Expected: 0 failures (R-11 updated, 7b passes).

```
cd d:\resihub\api && node --test test/contractEarlyTerminationBillingSync.test.js 2>&1 | tail -20
```
Expected: 0 failures.

- [ ] **Step 4: Commit**

```
git add api/test/fullWebsiteWhiteBlackBox.test.js
git commit -m "test(e2e): update R-11 assertion for immutable invoice total; add 7b deposit serviceDebt LATE_FEE"
```

---

## Task 8: Verification — Full Test Suite

**Files:** No new files. Run all affected test suites.

**Interfaces:** All prior tasks must be merged before this task.

- [ ] **Step 1: Run `week5DailyCronAndLateFee`**

```
cd d:\resihub\api && node --test test/week5DailyCronAndLateFee.test.js 2>&1 | tail -30
```
Expected: 0 failures.

- [ ] **Step 2: Run `contractEarlyTerminationBillingSync`**

```
cd d:\resihub\api && node --test test/contractEarlyTerminationBillingSync.test.js 2>&1 | tail -30
```
Expected: 0 failures.

- [ ] **Step 3: Run `migration048RlsAndRpc`**

```
cd d:\resihub\api && node --test test/migration048RlsAndRpc.test.js 2>&1 | tail -20
```
Expected: 0 failures (Bug #2 test passes).

- [ ] **Step 4: Run `fullWebsiteWhiteBlackBox`**

```
cd d:\resihub\api && node --test test/fullWebsiteWhiteBlackBox.test.js 2>&1 | tail -30
```
Expected: 0 failures.

- [ ] **Step 5: Run `invoiceFourEyesAndCreditBalance`** (regression check for 4-eyes waiver)

```
cd d:\resihub\api && node --test test/invoiceFourEyesAndCreditBalance.test.js 2>&1 | tail -20
```
Expected: 0 failures.

- [ ] **Step 6: Final commit + tag**

```
git add -A
git commit -m "chore: verified full test suite — late fee carry-forward + immutable invoices complete"
git tag late-fee-carry-forward-v1
```

---

## Self-Review

### 1. Spec Coverage

| Spec section | Task |
|---|---|
| §4 — tracker upsert (not invoice mutation) | Task 3 |
| §4.2 — `late_fee_accrual_tracker` DDL | Task 1 |
| §4.3 — carry-forward in `generateInvoicesCore` | Task 5 |
| §4.4 — `LATE_FEE_SETTLEMENT` for ended contracts | Task 4 |
| §5 — Bug #1 JS fix (`deposits.js`) | Task 2 |
| §5 — Bug #1 SQL fix (`fn_apply_deposit_settlement_accounting`) | Task 1 |
| §6 — Bug #2 (`fn_resolve_invoice_adjustment`) | Task 1 |
| §7.5 — `calculateContractOpenDebts` LATE_FEE coverage | Tasks 2 + 7 |
| §7.6 — UI badge for LATE_FEE_SETTLEMENT | ⚠️ **Gap** — added below |
| §8 — Test updates | Tasks 3, 5, 6, 7 |

**Gap found:** §7.6 (UI `InvoiceDetailPage.jsx`) not covered. Added as Task 9.

### 2. Step Scan

All steps name one action with a checkable result. No "handle edge cases" lines. ✓

### 3. Type Consistency

- `createLateFeeSettlementInvoiceInTx` defined in Task 4, consumed in Task 4 Step 4. ✓
- `late_fee_accrual_tracker` columns defined in Task 1, used in Tasks 3, 4, 5. ✓
- `invoice_type = 'LATE_FEE_SETTLEMENT'` defined in Task 1 migration, used in Tasks 4, 7. ✓

### 4. Review Focus Coverage

| RF# | Test |
|---|---|
| RF1 — rolling carry-forward | Task 5 test 5c |
| RF2 — 4-eyes waiver on carry-forward | Task 6 test 6b |
| RF3 — waiver on settlement invoice | Task 6 test 6c |
| RF4 — deposit settlement with both OVERDUE + settlement invoice | Task 7 test 7b |
| RF5 — cron idempotency | Task 3 test 4c / Task 4 test 4f idempotent check |

---

## Task 9: UI — `InvoiceDetailPage.jsx` Badge for LATE_FEE_SETTLEMENT

**Files:**
- Modify: `api/frontend/src/pages/admin/invoices/InvoiceDetailPage.jsx`

**Interfaces:**
- Consumes: `invoice.invoice_type` field returned by GET `/api/v1/invoices/:id`
- Produces:
  - Badge "Phí phạt tất toán" (orange/amber) when `invoice.invoice_type === 'LATE_FEE_SETTLEMENT'`
  - "Phát hành" button hidden for `invoice_type === 'LATE_FEE_SETTLEMENT'` (auto-issued by cron)
  - On `OVERDUE` regular invoices: informational note "Phí phạt đang tích lũy — sẽ được đưa vào hóa đơn kỳ kế tiếp" (no amount shown)

- [ ] **Step 1: Ensure API returns `invoice_type`**

Check `GET /api/v1/invoices/:id` SELECT query includes `invoice_type`. If missing, add `invoice_type` to the SELECT columns.

- [ ] **Step 2: Add `invoice_type` badge in `InvoiceDetailPage.jsx`**

After the existing status badge, add:
```jsx
{invoice.invoice_type === 'LATE_FEE_SETTLEMENT' && (
  <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-amber-100 text-amber-800">
    Phí phạt tất toán
  </span>
)}
```

- [ ] **Step 3: Hide "Phát hành" button for settlement invoices**

Wrap the issue button condition:
```jsx
{invoice.status === 'DRAFT' && invoice.invoice_type !== 'LATE_FEE_SETTLEMENT' && (
  <button onClick={handleIssue}>Phát hành</button>
)}
```

- [ ] **Step 4: Add informational note on OVERDUE regular invoices**

```jsx
{invoice.status === 'OVERDUE' && invoice.invoice_type === 'REGULAR' && (
  <div className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded p-3 mt-2">
    ℹ️ Phí phạt chậm thanh toán đang tích lũy và sẽ được đưa vào hóa đơn kỳ kế tiếp.
  </div>
)}
```

- [ ] **Step 5: Manual smoke test**

Navigate to an OVERDUE invoice → see note. Navigate to a LATE_FEE_SETTLEMENT invoice → see badge, no "Phát hành" button.

- [ ] **Step 6: Commit**

```
git add frontend/src/pages/admin/invoices/InvoiceDetailPage.jsx api/src/routes/invoices.js
git commit -m "feat(ui): InvoiceDetailPage — LATE_FEE_SETTLEMENT badge, hide issue btn, OVERDUE accrual note"
```
