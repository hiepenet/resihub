# Kế hoạch khắc phục các điểm chưa đạt PRD v2.0 — M03 → M06

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Đưa nghiệp vụ M03–M06 về đúng PRD v2.0: phân quyền duyệt tài chính, luồng chấm dứt hợp đồng có duyệt, kênh email nhắc hợp đồng, bản ghi cọc `PENDING` ở DRAFT, ràng buộc cọc = 1 tháng tiền thuê và tạo căn hộ hàng loạt.

**Architecture:** Giữ nguyên mô hình 4 vai trò hiện tại (`SYS_ADMIN`, `OWNER`, `MANAGER`, `RESIDENT`) theo migration `036`; thay vì khôi phục `ACCOUNTANT`/`FIN_APPROVER`, chuyển toàn bộ quyền duyệt tài chính (tất toán cọc, chấm dứt hợp đồng) về `OWNER` của tòa nhà, `SYS_ADMIN` chỉ fallback khi tòa chưa có OWNER. Backend siết ràng buộc ở service/DB; frontend phản ánh đúng vai trò và trạng thái, không tự quyết định nghiệp vụ.

**Tech Stack:** Node.js ESM, Express 4, PostgreSQL (migrations SQL thuần), `node:test`; React 19 + Vite + Zustand + Tailwind; `nodemailer` (mới) cho email.

**Spec:** `PRD - Quan ly Can ho va Nha cho thue v2.0.md` (mục 6.2, 7.5, 10.1–10.2, 11, 13) và báo cáo `docs/BAO_CAO_TUAN_THU_PRD_M03_M06.md`.

## Global Constraints

- Chỉ dùng 4 vai trò hiện có; **không** thêm role mới trong kế hoạch này.
- Mọi API thay đổi tiền phải giữ `authenticateToken` + `idempotencyGuard()` và header `Idempotency-Key`.
- Tiền là số nguyên VND; không dùng float cho tính toán lưu trữ.
- Ngày nghiệp vụ theo múi giờ `Asia/Ho_Chi_Minh`; dùng các helper `toVnDateOnlyStr` / `getTodayVnDateStr` sẵn có.
- Trạng thái mới phải thêm vào `CHECK` constraint bằng migration, không sửa migration cũ đã chạy.
- Test backend chạy bằng `node --test` (không thêm framework); test frontend đặt tại `frontend/src/utils/__tests__/`.
- Toàn bộ thông điệp UI/API bằng tiếng Việt, giữ văn phong hiện có.
- Không phá dữ liệu cũ: hợp đồng đã tồn tại với cọc ≠ 1 tháng vẫn phải đọc/tất toán được; chỉ chặn khi tạo/sửa mới.

## Review Focus

- **Manager cố duyệt sau khi bị gỡ quyền** → phải nhận `403` rõ ràng, không rơi vào `500` hay tự động chuyển trạng thái.
- **Tòa nhà không có OWNER** → `SYS_ADMIN` vẫn duyệt được; tòa có OWNER → `SYS_ADMIN` bị `403`.
- **Hợp đồng DRAFT bị hủy trước khi kích hoạt** → không còn bản ghi cọc mồ côi; danh sách cọc của cư dân không đổi.
- **Hợp đồng cũ có cọc lệch 1 tháng** → vẫn xem/chấm dứt/tất toán bình thường; chỉ luồng tạo mới bị chặn.
- **SMTP chưa cấu hình ở dev/test** → job nhắc hợp đồng không được ném lỗi hay chặn các job khác.

---

### Task 1: M06 — Chỉ OWNER được duyệt tất toán cọc

**Files:**
- Modify: `api/src/routes/deposits.js:81-111` (`canActAsDepositApprover`)
- Modify: `frontend/src/hooks/usePermission.js:41`
- Modify: `frontend/src/utils/depositUiHelpers.js:92-114`
- Test: `api/test/m06OwnerOnlySettlementApproval.test.js` (create)
- Test: `frontend/src/utils/__tests__/m06OwnerOnlySettlementApprovalUi.test.js` (create)

**Interfaces:**
- Consumes: `getUserRoleCodes(req)`, `getOwnerBuildingIds`, `building_has_active_owner` từ `GET /deposits`.
- Produces: `canActAsDepositApprover(req, meta, depositId, actionLabel)` chỉ trả `{ok:true}` khi actor là `OWNER` thuộc tòa nhà, hoặc `SYS_ADMIN` khi `meta.building_has_active_owner === false`.
- Produces: `canActorApproveDepositRow({ isOwner, isSysAdmin, currentUserId, createdBy, buildingHasActiveOwner, allowSelfApproval })` bỏ tham số `isManager`.

- [ ] **Step 1: Viết test backend thất bại**

Tạo `api/test/m06OwnerOnlySettlementApproval.test.js` theo mẫu in-process của `m06Phase2OwnerApprovalAndEscalation.test.js`: seed 1 tòa có OWNER + 1 MANAGER + hợp đồng `ACTIVE` có cọc `HELD`; MANAGER lập settlement (`POST /deposits/:id/settlement`) → `200`/`PENDING_APPROVAL`; sau đó:

```js
const mgrApprove = await apiFetch(`/api/v1/deposits/${depositId}/settlement/approve`, mgr.token, { method: 'POST' });
assert.equal(mgrApprove.status, 403, 'MANAGER không được duyệt tất toán khi tòa đã có OWNER');
const ownerApprove = await apiFetch(`/api/v1/deposits/${depositId}/settlement/approve`, owner.token, { method: 'POST' });
assert.equal(ownerApprove.status, 200);
```

- [ ] **Step 2: Chạy test để xác nhận fail**

Run: `npm --prefix api test -- m06OwnerOnlySettlementApproval`
Expected: FAIL — `mgrApprove.status === 200`.

- [ ] **Step 3: Sửa backend**

Trong `canActAsDepositApprover`, xóa nhánh `MANAGER` (dòng 87-90). Giữ nguyên nhánh `OWNER` và `SYS_ADMIN` fallback. Đổi `requireRole(['OWNER', 'MANAGER', 'SYS_ADMIN'])` ở 3 endpoint approve/reject/resolve-dispute thành `requireRole(['OWNER', 'SYS_ADMIN'])` (dòng 1404, 1676, 1866).

- [ ] **Step 4: Chạy lại test backend**

Run: `npm --prefix api test -- m06OwnerOnlySettlementApproval`
Expected: PASS.

- [ ] **Step 5: Viết test frontend thất bại**

Tạo test đọc source và test helper:

```js
assert.match(readSrc('../../hooks/usePermission.js'), /canApproveDepositRefund:\s*isOwner\s*\|\|\s*isSysAdmin/);
assert.equal(canActorApproveDepositRow({ isManager: true, isOwner: false, isSysAdmin: false }), false);
assert.equal(canActorApproveDepositRow({ isOwner: true }), true);
```

Run: `node --test frontend/src/utils/__tests__/m06OwnerOnlySettlementApprovalUi.test.js`
Expected: FAIL.

- [ ] **Step 6: Sửa frontend**

`usePermission.js`: `canApproveDepositRefund: isOwner || isSysAdmin`. `depositUiHelpers.js`: bỏ `isManager` khỏi destructuring và khỏi điều kiện `if (isOwner || isManager)` → chỉ `isOwner`; giữ `isSysAdmin && !buildingHasActiveOwner`. Trong `DepositsPage.jsx`, nhánh nút duyệt dùng `canApproveDepositRefund` (đã đúng), không cần sửa thêm.

- [ ] **Step 7: Chạy test frontend + commit**

Run: `node --test frontend/src/utils/__tests__/m06OwnerOnlySettlementApprovalUi.test.js`
Expected: PASS.

```bash
git add api/src/routes/deposits.js frontend/src/hooks/usePermission.js frontend/src/utils/depositUiHelpers.js api/test/m06OwnerOnlySettlementApproval.test.js frontend/src/utils/__tests__/m06OwnerOnlySettlementApprovalUi.test.js
git commit -m "fix(m06): only owner can approve deposit settlement"
```

---

### Task 2: M05 — Chấm dứt hợp đồng phải qua bước duyệt

**Files:**
- Create: `api/src/db/migrations/049_contract_termination_approval.sql`
- Create: `api/src/services/contractTermination.js`
- Modify: `api/src/routes/contracts.js:2502-2654` (`POST /:id/terminate`)
- Modify: `api/src/routes/contracts.js:2656-2777` (`POST /:id/terminate/approve`)
- Modify: `api/src/routes/contracts.js:2783-...` (`POST /:id/terminate/reject`)
- Modify: `api/src/routes/contracts.js:~874-1130` (resident request approve — set `termination_approved_at`)
- Modify: `api/src/jobs/daily.js:101-109` (chỉ auto-finalize khi đã duyệt)
- Modify: `frontend/src/hooks/usePermission.js` (thêm `canApproveTermination`)
- Modify: `frontend/src/pages/admin/contracts/ContractDetailPage.jsx:1686-1734`
- Test: `api/test/m05TerminationApproval.test.js` (create)
- Test: `frontend/src/utils/__tests__/m05TerminationApprovalUi.test.js` (create)

**Interfaces:**
- Produces: cột `contract.termination_approved_at TIMESTAMPTZ` (NULL = chưa duyệt).
- Produces: `finalizeTerminationInTx(client, { contract, termDate, actorId, reason })` trong `services/contractTermination.js` — cập nhật `TERMINATED`, đồng bộ căn hộ, gán `refund_due_date`, ghi audit, đóng billing/subscription. Dùng chung cho approve và cron.
- Produces: `POST /contracts/:id/terminate` (MANAGER) → `200` với `status = 'TERMINATION_PENDING'`, `termination_approved_at = NULL`.
- Produces: `POST /contracts/:id/terminate/approve` (OWNER/SYS_ADMIN) → nếu `terminated_at <= hôm nay` thì `TERMINATED`, ngược lại giữ `TERMINATION_PENDING` + set `termination_approved_at`.

- [ ] **Step 1: Viết migration**

```sql
ALTER TABLE contract ADD COLUMN IF NOT EXISTS termination_approved_at TIMESTAMPTZ;
UPDATE contract SET termination_approved_at = updated_at
WHERE status = 'TERMINATION_PENDING' AND termination_approved_at IS NULL;
```

- [ ] **Step 2: Viết test backend thất bại**

Trong `api/test/m05TerminationApproval.test.js` (in-process như Task 1):
1. MANAGER gọi terminate với ngày hôm nay → `200`, DB `status='TERMINATION_PENDING'`, `termination_approved_at IS NULL`, hợp đồng **chưa** `TERMINATED`.
2. MANAGER gọi terminate/approve → `403`.
3. OWNER gọi terminate/approve → `200`, `status='TERMINATED'`.
4. Tạo hợp đồng thứ hai, MANAGER terminate với ngày tương lai; chạy `runDailyJobs()` khi chưa duyệt → vẫn `TERMINATION_PENDING`; OWNER duyệt rồi chạy lại khi tới ngày → `TERMINATED`.

- [ ] **Step 3: Chạy test để xác nhận fail**

Run: `npm --prefix api test -- m05TerminationApproval`
Expected: FAIL ở bước 1 (hiện trả `TERMINATED`).

- [ ] **Step 4: Tách service `contractTermination.js`**

Chuyển nguyên khối xử lý cuối (dòng 2566-2636: update TERMINATED, syncApartmentStatus, refund_due_date, audit, notification, closeContractBillingAndSubscriptionsInTx) vào `finalizeTerminationInTx`. Cron `daily.js` gọi lại service này thay vì lặp code (nếu tách cron quá lớn, giữ cron nguyên và chỉ thêm điều kiện `termination_approved_at IS NOT NULL` — chấp nhận trùng lặp có kiểm soát).

- [ ] **Step 5: Sửa route terminate thành "gửi yêu cầu"**

Validate ngày/lý do như hiện tại; `UPDATE contract SET status='TERMINATION_PENDING', terminated_at=$1, termination_approved_at=NULL, note=$2`; ghi audit `TERMINATE_REQUEST`; gửi notification cho OWNER tòa nhà (`user_role` role OWNER) và cư dân; **không** đổi trạng thái căn hộ, **không** đóng billing, **không** set `refund_due_date`. Trả message "Đã gửi yêu cầu chấm dứt, chờ Chủ sở hữu phê duyệt."

- [ ] **Step 6: Sửa route approve/reject**

`approve`: `requireRole(['OWNER','SYS_ADMIN'])`; yêu cầu `status='TERMINATION_PENDING'` và `termination_approved_at IS NULL`; giữ four-eyes theo `audit_log TERMINATE_REQUEST`; nếu `terminated_at <= today` gọi `finalizeTerminationInTx`, ngược lại chỉ set `termination_approved_at=NOW()` + audit `TERMINATE_APPROVE`. `reject`: cùng role; set `status='ACTIVE'`, `termination_approved_at=NULL`, giữ `terminated_at` để audit, lý do bắt buộc.

- [ ] **Step 7: Sửa resident request approve + cron**

Tại `POST /contracts/requests/:id/approve`, khi set `TERMINATION_PENDING` thêm `termination_approved_at = NOW()`. Tại `jobs/daily.js`, thêm `AND termination_approved_at IS NOT NULL` vào query dòng 102-108.

- [ ] **Step 8: Chạy test backend**

Run: `npm --prefix api test -- m05TerminationApproval`
Expected: PASS.

- [ ] **Step 9: Sửa frontend**

- `usePermission.js`: thêm `canApproveTermination: isOwner || isSysAdmin`.
- `ContractDetailPage.jsx`:
  - Nút của MANAGER đổi nhãn "Gửi yêu cầu chấm dứt"; toast dùng message backend.
  - Khối `TERMINATION_PENDING` (dòng 1721) đổi điều kiện hiển thị nút duyệt/từ chối sang `canApproveTermination && !contract.termination_approved_at`; nút duyệt gọi `setConfirmState({open:true,type:'approve_termination'})`, nút hủy gọi `setRejectTermOpen(true)`.
  - Banner: nếu `termination_approved_at` null → "Chờ Chủ sở hữu duyệt"; nếu có → "Đã duyệt – chờ ngày trả phòng".
- `statuses.js`: giữ nhãn `TERMINATION_PENDING` hiện tại, không thêm trạng thái mới.

- [ ] **Step 10: Viết test frontend + chạy**

```js
assert.match(readSrc('../../hooks/usePermission.js'), /canApproveTermination:\s*isOwner\s*\|\|\s*isSysAdmin/);
assert.match(readSrc('../../pages/admin/contracts/ContractDetailPage.jsx'), /termination_approved_at/);
```

Run: `node --test frontend/src/utils/__tests__/m05TerminationApprovalUi.test.js`
Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add api/src/db/migrations/049_contract_termination_approval.sql api/src/services/contractTermination.js api/src/routes/contracts.js api/src/jobs/daily.js frontend/src/hooks/usePermission.js frontend/src/pages/admin/contracts/ContractDetailPage.jsx api/test/m05TerminationApproval.test.js frontend/src/utils/__tests__/m05TerminationApprovalUi.test.js
git commit -m "feat(m05): require owner approval before terminating a contract"
```

---

### Task 3: M05 — Gửi email nhắc hợp đồng sắp hết hạn (FR-018)

**Files:**
- Modify: `api/package.json` (thêm `nodemailer`)
- Modify: `api/.env.example`
- Create: `api/src/services/mailer.js`
- Modify: `api/src/jobs/daily.js:811-890`
- Test: `api/test/mailer.test.js` (create)

**Interfaces:**
- Produces: `isMailerConfigured() -> boolean` (true khi có `SMTP_HOST` và `SMTP_FROM`).
- Produces: `sendMail({ to, subject, html, text }) -> Promise<{ skipped: true } | { messageId: string }>`; không throw khi chưa cấu hình, chỉ `console.warn` một lần.
- Produces: `__setTransportForTest(transport)` để test bơm transport giả.

- [ ] **Step 1: Cài dependency + env mẫu**

Run: `npm --prefix api install nodemailer`
Thêm vào `api/.env.example`:

```
SMTP_HOST=
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=
SMTP_PASS=
SMTP_FROM="ResiHub <no-reply@resihub.vn>"
```

- [ ] **Step 2: Viết test thất bại**

`api/test/mailer.test.js`:

```js
test('mailer skips safely when SMTP is not configured', async () => {
  delete process.env.SMTP_HOST;
  const { sendMail } = await import('../src/services/mailer.js');
  assert.deepEqual(await sendMail({ to: 'a@b.c', subject: 'x', text: 'y' }), { skipped: true });
});

test('mailer sends through injected transport', async () => {
  const { sendMail, __setTransportForTest } = await import('../src/services/mailer.js');
  const sent = [];
  __setTransportForTest({ sendMail: async (msg) => { sent.push(msg); return { messageId: 'm1' }; } });
  const res = await sendMail({ to: 'a@b.c', subject: 'x', text: 'y' });
  assert.equal(sent.length, 1);
  assert.equal(res.messageId, 'm1');
});
```

Run: `npm --prefix api test -- mailer`
Expected: FAIL — module chưa tồn tại.

- [ ] **Step 3: Tạo `mailer.js`**

Chọn transport: nếu `__testTransport` có thì dùng; nếu không và `!isMailerConfigured()` trả `{skipped:true}`; ngược lại tạo `nodemailer.createTransport({host, port, secure, auth})` một lần (lazy singleton) và gửi.

- [ ] **Step 4: Chạy test mailer**

Run: `npm --prefix api test -- mailer`
Expected: PASS.

- [ ] **Step 5: Gắn vào job FR-018**

Trong khối 811-890, sau khi insert notification:
- Lấy email MANAGER: join `app_user → person` theo `user_id` ở query dòng 827.
- Lấy email cư dân ở query dòng 841.
- Với mỗi email, gọi `sendMail` với tiêu đề `[ResiHub] Hợp đồng ${apartment_code} sắp hết hạn trong ${daysLeft} ngày`, nội dung nêu ngày kết thúc và link `/admin/contracts` hoặc `/resident`.
- Bọc `try/catch` từng email; lỗi chỉ `console.error`, không làm fail job.

- [ ] **Step 6: Kiểm tra không hồi quy job**

Run: `npm --prefix api test -- week5DailyCronAndLateFee`
Expected: PASS (không có SMTP thì mailer skip).

- [ ] **Step 7: Commit**

```bash
git add api/package.json api/package-lock.json api/.env.example api/src/services/mailer.js api/src/jobs/daily.js api/test/mailer.test.js
git commit -m "feat(m05): send email reminders for expiring contracts"
```

---

### Task 4: M05 — Tạo bản ghi cọc `PENDING` khi lưu hợp đồng DRAFT

**Files:**
- Create: `api/src/db/migrations/050_deposit_pending_status.sql`
- Modify: `api/src/routes/contracts.js:1624-1647` (sau khi insert contract)
- Modify: `api/src/routes/contracts.js:3126-3220` (activation dùng lại bản ghi PENDING)
- Modify: `api/src/routes/contracts.js:3948-...` (`POST /:id/cancel`)
- Modify: `api/src/routes/deposits.js:483-500` (loại `PENDING` khỏi danh sách mặc định)
- Test: `api/test/contractDraftDepositPending.test.js` (create)

**Interfaces:**
- Produces: mỗi contract `DRAFT` có đúng 1 `deposit(contract_id, amount_held=0, status='PENDING')`.
- Produces: khi activate, bản ghi `PENDING` được `UPDATE` thành `HELD` (không tạo bản ghi thứ hai).
- Produces: khi cancel DRAFT, bản ghi `PENDING` bị xóa.

- [ ] **Step 1: Viết migration**

```sql
ALTER TABLE deposit DROP CONSTRAINT IF EXISTS deposit_status_check;
ALTER TABLE deposit ADD CONSTRAINT deposit_status_check CHECK (status IN (
  'PENDING','HELD','SETTLEMENT_DRAFT','PENDING_APPROVAL','APPROVED_PENDING_PAYOUT',
  'PARTIALLY_REFUNDED','REFUNDED','DEDUCTED_FULL','RETURNED','TRANSFERRED','DISPUTED'
));
```

(Giữ đủ các trạng thái đã được migration 045/018 mở rộng; đối chiếu lại danh sách trong DB trước khi chạy.)

- [ ] **Step 2: Viết test thất bại**

`api/test/contractDraftDepositPending.test.js`:
1. Tạo hợp đồng DRAFT → DB có `deposit.status='PENDING'`, `amount_held=0`.
2. `GET /api/v1/deposits` (MANAGER) → không chứa bản ghi PENDING.
3. Activate → vẫn chỉ 1 bản ghi, `status='HELD'`, `amount_held = deposit_amount`.
4. Hợp đồng DRAFT thứ hai → cancel → không còn bản ghi deposit.

- [ ] **Step 3: Chạy test để xác nhận fail**

Run: `npm --prefix api test -- contractDraftDepositPending`
Expected: FAIL — chưa có bản ghi deposit.

- [ ] **Step 4: Sửa luồng tạo hợp đồng**

Ngay sau `INSERT INTO contract ... RETURNING *` (dòng 1647), thêm:

```sql
INSERT INTO deposit (contract_id, amount_held, status) VALUES ($1, 0, 'PENDING')
```

Không tạo `deposit_transaction`.

- [ ] **Step 5: Sửa luồng kích hoạt**

Trong khối `if (opensDeposit)`, thay `if (existing.rows.length === 0) { ... }` bằng:
- Nếu tồn tại bản ghi `status='PENDING'`: dùng chính id đó, `UPDATE deposit SET amount_held=..., status='HELD', source_reservation_id=...` theo đúng các nhánh hiện có (parentDep / matchedRsv / không nguồn), sau đó insert transaction như cũ.
- Nếu không tồn tại: giữ nguyên nhánh insert hiện tại.
- Nếu tồn tại bản ghi `HELD`: giữ nguyên hành vi bỏ qua.

- [ ] **Step 6: Sửa luồng cancel + danh sách**

`POST /:id/cancel`: sau khi set `CANCELLED`, `DELETE FROM deposit WHERE contract_id=$1 AND status='PENDING'`.
`GET /deposits`: thêm `AND d.status <> 'PENDING'` vào WHERE mặc định.

- [ ] **Step 7: Chạy test + commit**

Run: `npm --prefix api test -- contractDraftDepositPending`
Expected: PASS.

```bash
git add api/src/db/migrations/050_deposit_pending_status.sql api/src/routes/contracts.js api/src/routes/deposits.js api/test/contractDraftDepositPending.test.js
git commit -m "feat(m05): open pending deposit record when saving draft contract"
```

---

### Task 5: M05 — Cưỡng chế cọc = 1 tháng tiền thuê

**Files:**
- Create: `api/src/services/depositPolicy.js`
- Modify: `api/src/routes/contracts.js:1597-1603` (create)
- Modify: `api/src/routes/contracts.js:2344-2348` (PATCH)
- Modify: `api/src/routes/contracts.js:5072-5078` (renew)
- Modify: `api/src/routes/contracts.js:5295-...` (transfer-room)
- Modify: `api/src/routes/contracts.js:3532-...` (activate guard)
- Create: `frontend/src/utils/contractDeposit.js`
- Modify: `frontend/src/pages/admin/contracts/ContractsPage.jsx:214-227` + form deposit input
- Modify: `frontend/src/pages/admin/contracts/ContractDetailPage.jsx` (edit/renew/amend/transfer deposit inputs)
- Test: `api/test/depositOneMonthRule.test.js` (create)
- Test: `frontend/src/utils/__tests__/contractDepositRule.test.js` (create)

**Interfaces:**
- Produces: `assertDepositEqualsRent(rentAmount, depositAmount) -> { ok: boolean, expected: number }` trong `services/depositPolicy.js`.
- Produces: `normalizeDepositAmount(rentAmount) -> number` trong `frontend/src/utils/contractDeposit.js`.
- Produces: lỗi API `422 DEPOSIT_MUST_EQUAL_ONE_MONTH_RENT` với message nêu số tiền đúng.

- [ ] **Step 1: Viết test backend thất bại**

`api/test/depositOneMonthRule.test.js`:
1. `POST /contracts` với `rent_amount=10000000`, `deposit_amount=8000000` → `422 DEPOSIT_MUST_EQUAL_ONE_MONTH_RENT`.
2. `deposit_amount=10000000` → `201`.
3. Bỏ trống `deposit_amount` → `201` và `deposit_amount === rent_amount`.
4. Hợp đồng cũ có cọc lệch (seed SQL trực tiếp) → `GET /contracts/:id` vẫn `200`.

Run: `npm --prefix api test -- depositOneMonthRule`
Expected: FAIL.

- [ ] **Step 2: Tạo `depositPolicy.js` + áp dụng**

`assertDepositEqualsRent(rent, deposit)`: `expected = Math.round(Number(rent))`, `ok = Number(deposit) === expected` (bỏ qua nếu `deposit` null để caller tự gán expected).
Thay khối 1597-1603: `finalDeposit = deposit_amount == null ? Number(rent_amount) : Number(deposit_amount)`; nếu `!ok` trả 422. Bỏ hoàn toàn nhánh `deposit_months` (giữ field nhận nhưng bỏ qua, không nhân).
Áp dụng cùng kiểm tra ở PATCH, renew, transfer-room khi một trong hai trường `rent_amount`/`deposit_amount` thay đổi. Ở `activate`, kiểm tra lại `contract.deposit_amount === contract.rent_amount`, nếu lệch trả `422` (bảo vệ dữ liệu bị sửa trực tiếp).

- [ ] **Step 3: Chạy test backend**

Run: `npm --prefix api test -- depositOneMonthRule`
Expected: PASS.

- [ ] **Step 4: Viết test frontend thất bại**

```js
assert.equal(normalizeDepositAmount(10_000_000), 10_000_000);
assert.equal(normalizeDepositAmount('abc'), 0);
assert.match(readSrc('../../pages/admin/contracts/ContractsPage.jsx'), /readOnly/);
```

Run: `node --test frontend/src/utils/__tests__/contractDepositRule.test.js`
Expected: FAIL.

- [ ] **Step 5: Sửa frontend**

- `ContractsPage` form tạo: khi `rent_amount` đổi, set `deposit_amount = normalizeDepositAmount(rent_amount)`; input cọc `readOnly` + hint "Theo quy định: cọc = 1 tháng tiền thuê".
- `ContractDetailPage`: các input `editDraftForm.deposit_amount`, `renewForm.deposit_amount`, `amendForm.deposit_amount`, `transferForm.new_deposit_amount` chuyển sang `readOnly` và tự đồng bộ khi rent đổi; nếu backend trả 422 thì hiển thị message.

- [ ] **Step 6: Chạy test frontend + commit**

Run: `node --test frontend/src/utils/__tests__/contractDepositRule.test.js`
Expected: PASS.

```bash
git add api/src/services/depositPolicy.js api/src/routes/contracts.js frontend/src/utils/contractDeposit.js frontend/src/pages/admin/contracts/ContractsPage.jsx frontend/src/pages/admin/contracts/ContractDetailPage.jsx api/test/depositOneMonthRule.test.js frontend/src/utils/__tests__/contractDepositRule.test.js
git commit -m "feat(m05): enforce deposit equal to one month rent"
```

---

### Task 6: M03 — Tạo căn hộ hàng loạt theo mẫu tầng (FR-009)

**Files:**
- Modify: `api/src/routes/apartments.js` (thêm route trước `GET /:id`)
- Modify: `frontend/src/services/buildings.service.js`
- Modify: `frontend/src/pages/admin/buildings/FloorPlanPage.jsx`
- Test: `api/test/apartmentBulkCreate.test.js` (create)
- Test: `frontend/src/utils/__tests__/apartmentBulkUi.test.js` (create)

**Interfaces:**
- Produces: `POST /api/v1/apartments/bulk` body `{ building_id, floor_id, code_prefix, start_number, count, type, bedrooms, area_m2, base_rent, zone_id? }` → `201 { created: [...], count }`.
- Produces: mã căn = `${code_prefix}${String(start_number + i).padStart(2, '0')}`.
- Produces: nếu bất kỳ mã nào đã tồn tại → `409 APARTMENT_CODE_EXISTS` kèm `codes`, không insert bản ghi nào.
- Produces: `buildingsService.createApartmentsBulk(payload)`.

- [ ] **Step 1: Viết test backend thất bại**

`api/test/apartmentBulkCreate.test.js`: tạo 3 căn `A01,A02,A03` cùng tầng → `201`, DB đủ 3, mỗi căn có `audit_log CREATE`; gọi lại cùng payload → `409`, DB vẫn 3 căn; `count=0` → `400`.

Run: `npm --prefix api test -- apartmentBulkCreate`
Expected: FAIL — 404.

- [ ] **Step 2: Implement route**

`requireRole(['SYS_ADMIN','MANAGER'])`; validate `count` 1..100, `area_m2 > 0`, `base_rent >= 0`; kiểm tra quyền tòa nhà như `POST /`; sinh mã, kiểm tra trùng bằng 1 query `= ANY($codes)`; nếu trùng trả 409; insert trong transaction; ghi audit `BULK_CREATE` một lần với danh sách id.

- [ ] **Step 3: Chạy test backend**

Run: `npm --prefix api test -- apartmentBulkCreate`
Expected: PASS.

- [ ] **Step 4: Thêm service + UI**

- `buildings.service.js`: `createApartmentsBulk: (payload) => api.post('/api/v1/apartments/bulk', payload).then(r => r.data)`.
- `FloorPlanPage.jsx`: nút "Tạo hàng loạt" cạnh "Thêm căn hộ"; modal gồm `code_prefix`, `start_number`, `count`, các thuộc tính dùng chung (type, bedrooms, area_m2, base_rent, floor_id, zone_id); hiển thị preview 3 mã đầu; submit gọi service, toast `Đã tạo N căn hộ`, reload floor plan.

- [ ] **Step 5: Viết test frontend + chạy**

```js
assert.match(readSrc('../../services/buildings.service.js'), /createApartmentsBulk/);
assert.match(readSrc('../../pages/admin/buildings/FloorPlanPage.jsx'), /Tạo hàng loạt/);
```

Run: `node --test frontend/src/utils/__tests__/apartmentBulkUi.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add api/src/routes/apartments.js frontend/src/services/buildings.service.js frontend/src/pages/admin/buildings/FloorPlanPage.jsx api/test/apartmentBulkCreate.test.js frontend/src/utils/__tests__/apartmentBulkUi.test.js
git commit -m "feat(m03): bulk create apartments by floor pattern"
```

---

### Task 7: Đồng bộ tài liệu PRD với mô hình 4 vai trò & trạng thái mới

**Files:**
- Modify: `PRD - Quan ly Can ho va Nha cho thue v2.0.md` (mục 6.1, 6.2, 10.2 FR-017/FR-024, mục 13)
- Modify: `docs/BAO_CAO_TUAN_THU_PRD_M03_M06.md`

- [ ] **Step 1:** Sửa bảng vai trò 6.1: bỏ `ACCOUNTANT`, `FIN_APPROVER`; ghi rõ "OWNER duyệt tất toán cọc và chấm dứt hợp đồng; SYS_ADMIN fallback khi tòa chưa có OWNER".
- [ ] **Step 2:** Sửa actor FR-017/FR-024 tương ứng; bổ sung `PENDING` vào state deposit, `termination_approved_at` vào mục 13.
- [ ] **Step 3:** Cập nhật báo cáo tuân thủ: đánh dấu các mục đã đóng sau khi code xong.
- [ ] **Step 4: Commit**

```bash
git add "PRD - Quan ly Can ho va Nha cho thue v2.0.md" docs/BAO_CAO_TUAN_THU_PRD_M03_M06.md
git commit -m "docs: align PRD role matrix and statuses with implementation"
```

---

### Task 8: Kiểm thử hồi quy toàn bộ

**Files:**
- Modify khi cần: các test cũ có assertion quyền MANAGER duyệt cọc/chấm dứt (`api/test/remediationR01ToR24.test.js:501`, `api/test/fullWebsiteWhiteBlackBox.test.js:1743`, `api/test/multiBuildingAndFutureContract.test.js:663`, `api/test/depositCollectAndRefund.test.js:526`).

- [ ] **Step 1:** Chạy toàn bộ backend: `npm --prefix api test` — Expected: PASS (DB local cổng 5433). Với test cũ khẳng định MANAGER được duyệt, sửa kỳ vọng sang `403` (hành vi mới đúng PRD), không nới quyền lại.
- [ ] **Step 2:** Chạy test frontend: `node --test frontend/src/utils/__tests__` — Expected: PASS.
- [ ] **Step 3:** Chạy lint + build: `npm --prefix frontend run lint` và `npm --prefix frontend run build` — Expected: PASS.
- [ ] **Step 4:** Kiểm tra thủ công 2 luồng: MANAGER lập tất toán → OWNER duyệt → MANAGER chi; MANAGER gửi chấm dứt → OWNER duyệt → cron/chi tiết chuyển `TERMINATED`.
- [ ] **Step 5: Commit test adjustments**

```bash
git add api/test
git commit -m "test: align legacy assertions with owner-only approvals"
```

---

## Self-Review

- **Spec coverage:** FR-009 → Task 6; FR-014 (cọc PENDING, cọc 1 tháng) → Task 4, 5; FR-017 → Task 2; FR-018 → Task 3; FR-024 + 6.2 role matrix → Task 1; tài liệu lệch → Task 7. Không còn mục "Thiếu/Lệch" nào trong báo cáo chưa có task.
- **Không đụng:** FR-007/008/010/011/012/019/021/022/023/067/068 vốn đã đạt; các mục P2 mang tính mở rộng (NOTE-M04) không nằm trong phạm vi sửa.
- **Rủi ro đã tính:** test cũ khẳng định MANAGER duyệt (Task 8), dữ liệu cọc lệch 1 tháng có sẵn (Global Constraints), SMTP trống (Task 3), hợp đồng DRAFT bị hủy (Task 4).
- **Thứ tự bắt buộc:** Task 1 → 2 độc lập; Task 4 phải trước Task 5 (cùng vùng create contract); Task 8 chạy sau cùng.
