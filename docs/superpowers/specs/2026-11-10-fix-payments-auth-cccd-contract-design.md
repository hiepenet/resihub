# Design Spec: Fix Payments Credits 500, Fix Change-Password Field Mismatch, Improve CCCD Extraction in Contract Modal

**Date:** 2026-11-10  
**Author:** AI Assistant  
**Status:** Draft — Awaiting Approval  
**References:** API Test Report (82/83 passed), api_test_report.md

---

## 1. Bug Fix — `GET /api/v1/payments/credits` → HTTP 500

### Root Cause
File: `api/src/routes/payments.js` (lines ~674–686)

SQL query:
```sql
SELECT c.code AS contract_code  -- ❌ 'code' column does not exist on 'contract' table
FROM contract c ...
```

The `contract` table schema (`002_core_tables.sql`) has no `code` column. Other routes generate a human-readable contract code using the pattern:
```sql
'HĐ-' || UPPER(LEFT(c.id::text, 8)) AS contract_code
```
(confirmed in `meters.js` line ~599–601)

### Fix
Replace in the SQL query at `payments.js`:
```sql
-- Before:
c.code AS contract_code

-- After:
'HĐ-' || UPPER(LEFT(c.id::text, 8)) AS contract_code
```

### Scope
- 1 file: `api/src/routes/payments.js`
- 1 SQL expression changed, no schema change, no migration needed
- Risk: **Very Low** — isolated fix, same pattern used in other routes

---

## 2. Bug Fix — `POST /api/v1/auth/change-password` Field Name Mismatch

### Root Cause
**Frontend** (`auth.service.js`) sends:
```json
{ "currentPassword": "...", "newPassword": "..." }
```

**Backend** (`auth.js` line ~581) reads:
```js
const { old_password, new_password } = req.body;
```
Result: Both `old_password` and `new_password` are `undefined` → cannot verify old password → HTTP 400 or silent fail.

**Also:** `POST /api/v1/auth/reset-password` backend reads `new_password` but frontend sends `newPassword`.

### Fix Strategy
**Fix the backend** to accept camelCase field names (match the existing frontend contract). No frontend changes needed.

**`auth.js` — change-password route:**
```js
// Before:
const { old_password, new_password } = req.body;

// After:
const { old_password, new_password, currentPassword, newPassword } = req.body;
const resolvedOldPassword = old_password || currentPassword;
const resolvedNewPassword = new_password || newPassword;
```

**`auth.js` — reset-password route:**
```js
// Before:
const { email, code, new_password } = req.body;

// After:
const { email, code, new_password, newPassword } = req.body;
const resolvedNewPassword = new_password || newPassword;
```

### Why Backend Fix (not Frontend)
- Frontend code is "correct" by modern camelCase API convention
- Backend was written in snake_case; accepting both is backward-compatible
- No other known callers to break

### Scope
- 1 file: `api/src/routes/auth.js`
- 2 destructuring expressions changed
- Risk: **Very Low** — additive change, both old and new field names accepted

---

## 3. Feature Update — CCCD Extraction in Contract Creation Modal

### Current State
The contract creation modal (`ContractsPage.jsx`) already supports:
- Upload 2 CCCD images (front/back) via `FileUpload` component (JPG/PNG, max 5MB)
- Privacy consent checkbox before extraction
- "Trích xuất CCCD bằng AI" button → calls `POST /api/v1/ai/extract` with `document_type: 'CCCD'`
- Backend AI returns: `full_name, id_number, dob, issue_date, permanent_address`
- Frontend currently maps: `full_name → full_name`, `id_number → id_number`, `dob → dob`, `permanent_address → address`

### Gap Analysis

| AI Output Field | Currently Mapped | Form Field |
|---|---|---|
| `full_name` | ✅ Yes | `newTenantForm.full_name` |
| `id_number` | ✅ Yes | `newTenantForm.id_number` |
| `dob` | ✅ Yes | `newTenantForm.dob` |
| `permanent_address` | ✅ Yes | `newTenantForm.address` |
| `issue_date` | ❌ **Missing** | No matching form field |

**Problem 1:** `issue_date` (ngày cấp CCCD) is extracted by AI but **never shown or stored**. The `person` table has no `issue_date` column, so we can't persist it. However, the user should at least see it displayed for reference when reviewing the AI extraction.

**Problem 2:** `FileUpload` sends files as raw base64 (via `fileToBase64`), not compressed. For large phone photos, this can cause slow uploads and potentially exceed the backend's `MAX_IMAGE_BYTES` limit.

**Problem 3:** When extraction fails or confidence is low, the error message is shown inline (`inlineCccdError.title: inlineCccdError.guidance`) without clear visual separation — hard to read.

**Problem 4:** After CCCD extraction succeeds, there's no visual indicator on the form fields showing which fields were AI-filled (the `AISuggestionField` wrapper is used for CONTRACT extraction but not for CCCD extraction in `tenantMode === 'new'`).

### Proposed Improvements

#### 3.1 Display Extracted `issue_date` as Read-Only Reference
- Add `issue_date` to the `mapped` object in `handleExtractInlineCccdAi`
- Show it as a read-only label below the `dob` field when CCCD extraction has run
- Label: "Ngày cấp CCCD (AI trích xuất — không lưu, chỉ để tham khảo)"
- Style: indigo badge / info text

#### 3.2 Add Image Compression Before Send
- Use existing `compressImageFileToDataUri()` from `aiHelpers.js`
- Apply compression **before** `extractDocument()` is called (inside `handleExtractInlineCccdAi`)
- Currently: `files = [newTenantForm.id_image_front, newTenantForm.id_image_back].filter(Boolean)`
- Files from `FileUpload` are already base64 data URIs (via `fileToBase64` → not File objects)
- Since they're already `data:image/...;base64,...` strings, `compressImageFileToDataUri` will pass through unless oversized
- **Action:** Call `compressImageFileToDataUri(dataUri)` on each file before including in the `files` array → reduces payload size

#### 3.3 Wrap AI-Extracted Tenant Fields with `AISuggestionField`
- Currently, when `tenantMode === 'new'` and CCCD extraction runs, the form fields show AI values but without the dashed-border "AI suggestion" visual indicator
- Wrap `full_name`, `id_number`, `dob`, `address` inputs in `<AISuggestionField>` using `inlineCccdTracker` (already tracked in state) — same pattern as the contract field tracker
- Call `setInlineCccdTracker(markFieldConfirmedOrEdited(...))` when user edits a field

#### 3.4 Improve Error Display for CCCD Extraction Failure
- Current: `<p className="text-xs text-amber-800">{title}: {guidance}</p>`
- Change to a dismissible error card with an icon (Warning icon) for better visibility
- Show a "Nhập tay" (manual entry) link/button that dismisses the error without further action

### Schema: No DB Changes
The `person` table does not have `issue_date`. We will display it as a transient UI-only field (read-only reference label). No migration needed.

### Files Changed
| File | Change |
|---|---|
| `frontend/src/pages/admin/contracts/ContractsPage.jsx` | Map `issue_date`, compress images, wrap fields in AISuggestionField, improve error UI |
| `frontend/src/utils/aiHelpers.js` | No change (use existing `compressImageFileToDataUri`) |

### Risk
**Low** — UI-only changes in one component. No backend changes, no DB migrations.

---

## Decision Points for Approval

1. **Bug 1:** Fix approach is unambiguous — approve?
2. **Bug 2:** Backend fix accepted (both snake_case and camelCase) — or prefer frontend-only fix?
3. **CCCD 3.1:** Show `issue_date` as read-only label — approve? Or skip since it's not persisted?
4. **CCCD 3.3:** Add `AISuggestionField` wrappers for CCCD fields — approve?
5. **CCCD 3.4:** Improve error display — approve?

