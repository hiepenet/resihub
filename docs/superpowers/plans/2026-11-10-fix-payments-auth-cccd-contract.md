# Plan: Fix Payments Credits 500 + Fix Change-Password Mismatch + Improve CCCD Extraction

**Date:** 2026-11-10  
**Spec:** `docs/superpowers/specs/2026-11-10-fix-payments-auth-cccd-contract-design.md`  
**Status:** Ready for Execution  
**Estimated Tasks:** 3 independent tasks

---

## Overview

| Task | Type | File(s) | Risk |
|---|---|---|---|
| T1 | Bug Fix | `api/src/routes/payments.js` | Very Low |
| T2 | Bug Fix | `api/src/routes/auth.js` | Very Low |
| T3 | Feature | `frontend/src/pages/admin/contracts/ContractsPage.jsx` | Low |

> [!IMPORTANT]
> T1 và T2 độc lập hoàn toàn với nhau và với T3. Có thể thực hiện song song.
> T3 chỉ cần confirm spec trước khi execute (xem Decision Points trong spec).

---

## Task 1: Fix `GET /api/v1/payments/credits` → HTTP 500

**File:** `api/src/routes/payments.js`

### Steps

#### Step 1.1 — Viết failing test trước (TDD)
```bash
cd api && node --test --test-concurrency=1 test/payments_credits_bug.test.js
```
Test file mới: `api/test/payments_credits_bug.test.js`

Test phải xác nhận:
- `GET /api/v1/payments/credits` trả về HTTP 200 (không phải 500)  
- Response có dạng `{ data: [...] }` với mỗi item có trường `contract_code` dạng `HĐ-XXXXXXXX`

#### Step 1.2 — Áp dụng fix
Trong `api/src/routes/payments.js`, tìm đoạn query JOIN contract và sửa:

```sql
-- Trước:
c.code AS contract_code

-- Sau:
'HĐ-' || UPPER(LEFT(c.id::text, 8)) AS contract_code
```

#### Step 1.3 — Chạy test
```bash
cd api && node --test --test-concurrency=1 test/payments_credits_bug.test.js
```
Expect: PASS ✅

#### Step 1.4 — Chạy full test suite để kiểm tra regression
```bash
cd api && node --test --test-concurrency=1 test/*.test.js 2>&1 | tail -30
```

#### Step 1.5 — Commit
```
git add api/src/routes/payments.js api/test/payments_credits_bug.test.js
git commit -m "fix(payments): replace c.code with generated contract_code in credits query (#T1)"
```

**Verification:** `GET /api/v1/payments/credits` trả về 200.

---

## Task 2: Fix `POST /api/v1/auth/change-password` Field Name Mismatch

**File:** `api/src/routes/auth.js`

### Steps

#### Step 2.1 — Viết failing test trước (TDD)
Test file mới: `api/test/auth_change_password_bug.test.js`

Tests:
- `POST /api/v1/auth/change-password` với body `{ currentPassword, newPassword }` → HTTP 200 (không phải 400/422)
- `POST /api/v1/auth/reset-password` với body `{ email, code, newPassword }` → HTTP 200
- Backward compat: `{ old_password, new_password }` vẫn hoạt động

```bash
cd api && node --test --test-concurrency=1 test/auth_change_password_bug.test.js
```

#### Step 2.2 — Áp dụng fix

Trong `auth.js`, route `change-password`:

```js
// Trước:
const { old_password, new_password } = req.body;

// Sau:
const { old_password, new_password, currentPassword, newPassword } = req.body;
const resolvedOldPassword = old_password || currentPassword;
const resolvedNewPassword = new_password || newPassword;
```

Và dùng `resolvedOldPassword`/`resolvedNewPassword` thay cho `old_password`/`new_password` trong phần logic.

Trong `auth.js`, route `reset-password`:

```js
// Trước:
const { email, code, new_password } = req.body;

// Sau:
const { email, code, new_password, newPassword } = req.body;
const resolvedNewPassword = new_password || newPassword;
```

#### Step 2.3 — Chạy test
```bash
cd api && node --test --test-concurrency=1 test/auth_change_password_bug.test.js
```
Expect: PASS ✅

#### Step 2.4 — Regression
```bash
cd api && node --test --test-concurrency=1 test/*.test.js 2>&1 | tail -30
```

#### Step 2.5 — Commit
```
git add api/src/routes/auth.js api/test/auth_change_password_bug.test.js
git commit -m "fix(auth): accept camelCase currentPassword/newPassword in change/reset-password (#T2)"
```

**Verification:** Đăng nhập vào UI, đổi mật khẩu → thành công.

---

## Task 3: Improve CCCD Extraction in Contract Creation Modal

**File:** `frontend/src/pages/admin/contracts/ContractsPage.jsx`

> [!NOTE]
> Task này chỉ thay đổi UI frontend, không ảnh hưởng backend hay DB.
> Cần confirm Decision Points từ spec trước khi execute nếu chưa được approve.

### Sub-tasks

#### Step 3.1 — Thêm compression ảnh CCCD trước khi gửi AI

Trong hàm `handleExtractInlineCccdAi` (line ~1003):

```jsx
// Trước:
const files = [newTenantForm.id_image_front, newTenantForm.id_image_back].filter(Boolean);

// Sau (import compressImageFileToDataUri from '../../utils/aiHelpers' đã có):
const rawFiles = [newTenantForm.id_image_front, newTenantForm.id_image_back].filter(Boolean);
const files = await Promise.all(
  rawFiles.map((f) => compressImageFileToDataUri(f).catch(() => f))
);
```

Lý do: Giảm kích thước payload gửi lên AI gateway, tránh lỗi `MAX_IMAGE_BYTES` với ảnh chụp điện thoại độ phân giải cao.

#### Step 3.2 — Hiển thị `issue_date` được AI trích xuất (read-only reference)

Thêm `issue_date` vào `mapped` object trong `handleExtractInlineCccdAi`:

```js
const mapped = {
  full_name: ...,
  id_number: ...,
  dob: ...,
  address: ...,
  issue_date: out.issue_date ? String(out.issue_date).slice(0, 10) : '', // ← THÊM
};
```

Thêm `issue_date` vào `inlineCccdTracker` confidence map.

Thêm vào state: `newTenantForm` không cần lưu `issue_date` (không có DB column). Thay vào đó, lưu riêng vào state `inlineCccdExtractedIssueDate`.

Hiển thị label bên dưới field `dob`:
```jsx
{inlineCccdExtractedIssueDate && (
  <p className="text-[11px] text-indigo-700 mt-1">
    <Sparkles className="inline w-3 h-3 mr-1" />
    Ngày cấp CCCD (AI): <strong>{formatDateVN(inlineCccdExtractedIssueDate)}</strong>
    <span className="text-slate-400 ml-1">(tham khảo — không lưu)</span>
  </p>
)}
```

Reset `inlineCccdExtractedIssueDate` trong `handleOpenCreate` và khi đổi `tenantMode`.

#### Step 3.3 — Bọc các field AI-filled bằng `AISuggestionField` (CCCD mode)

Hiện tại `AISuggestionField` đã được import và dùng cho CONTRACT extraction. Áp dụng tương tự cho các field sau khi CCCD extraction thành công:
- `full_name` (line ~2300)
- `id_number` (line ~2250)
- `dob` (line ~2359)
- `address` (line ~2377)

Pattern (giống CONTRACT fields đã có):
```jsx
<AISuggestionField
  tracker={inlineCccdTracker}
  fieldKey="full_name"
  onDismiss={() => dismissInlineCccdField('full_name')}
  onConfirm={(v) => setInlineCccdTracker(markFieldConfirmedOrEdited(inlineCccdTracker, 'full_name', v))}
>
  <Input
    label="Họ và tên"
    value={newTenantForm.full_name}
    onChange={(e) => {
      setNewTenantForm((p) => ({ ...p, full_name: e.target.value }));
      setInlineCccdTracker(markFieldConfirmedOrEdited(inlineCccdTracker, 'full_name', e.target.value));
    }}
  />
</AISuggestionField>
```

Thêm hàm `dismissInlineCccdField` tương tự `dismissContractAiField`.

#### Step 3.4 — Cải thiện hiển thị lỗi CCCD extraction

Thay thế:
```jsx
{inlineCccdError ? (
  <p className="text-xs text-amber-800">{inlineCccdError.title}: {inlineCccdError.guidance}</p>
) : null}
```

Bằng:
```jsx
{inlineCccdError ? (
  <div className="flex items-start gap-2 p-2.5 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-800">
    <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0 text-amber-600" />
    <div className="flex-1 min-w-0">
      <p className="font-medium">{inlineCccdError.title}</p>
      <p className="text-amber-700 mt-0.5">{inlineCccdError.guidance}</p>
    </div>
    <button
      type="button"
      onClick={() => setInlineCccdError(null)}
      className="text-amber-400 hover:text-amber-600 shrink-0"
    >
      <X className="w-3.5 h-3.5" />
    </button>
  </div>
) : null}
```

#### Step 3.5 — Manual test
1. Mở modal tạo HĐ → chọn "Tạo cư dân mới" → upload ảnh CCCD → tick consent → click "Trích xuất CCCD bằng AI"
2. Xác nhận các field được fill + có viền nét đứt AISuggestionField  
3. Xác nhận `issue_date` hiển thị bên dưới dob
4. Thử với ảnh lớn (>2MB) → xác nhận compression hoạt động
5. Simulate lỗi AI → xác nhận error card mới hiển thị và có nút X

#### Step 3.6 — Commit
```
git add frontend/src/pages/admin/contracts/ContractsPage.jsx
git commit -m "feat(contracts): improve CCCD extraction UX — issue_date display, compression, AISuggestionField, better error card (#T3)"
```

---

## Execution Checklist

- [ ] **T1** — Viết test `payments_credits_bug.test.js`
- [ ] **T1** — Fix `payments.js` SQL
- [ ] **T1** — Tests PASS + no regression
- [ ] **T2** — Viết test `auth_change_password_bug.test.js`
- [ ] **T2** — Fix `auth.js` destructuring
- [ ] **T2** — Tests PASS + no regression
- [ ] **T3** — Confirm Decision Points (spec 3.1–3.4)
- [ ] **T3** — Implement 4 sub-tasks (3.1→3.4)
- [ ] **T3** — Manual test trong browser
- [ ] **All** — `git push` + redeploy to `http://103.249.117.229:59038/`
- [ ] **All** — Run deployed API test suite → 83/83 PASS

---

## Deployment Notes

```bash
# Restart API after T1 + T2 fixes:
docker compose -f docker-compose.prod.yml restart api

# Rebuild frontend after T3:
docker compose -f docker-compose.prod.yml build frontend
docker compose -f docker-compose.prod.yml up -d frontend
```

---

## Execution Method Options

**Option A — Subagent-driven (recommended for speed):**
T1 và T2 chạy song song bằng 2 subagent, T3 chạy sau khi cả hai xong.

**Option B — Inline sequential:**
Thực hiện T1 → T2 → T3 trong session này.

