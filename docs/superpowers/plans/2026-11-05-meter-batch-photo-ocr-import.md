# Batch Photo AI-02 Meter Reading Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build bulk utility-meter photo import (`<= 30` images/batch) powered by filename room matching + Gemini `AI-02` OCR (`reading` + `detected_meter_type`), an interactive review/reassignment modal, and batch save/confirm with meter photo evidence.

**Architecture:** Extend `POST /api/v1/ai/meter-ocr` and `runMeterOcrSuggestion` in a backwards-compatible way so Gemini returns optional `detected_meter_type` (`ELECTRICITY` | `WATER`) and can auto-resolve a room's meter when given `(building_id, apartment_id)` (or persist a building-scoped `ai_suggestion` when given `building_id` alone). On the frontend, extract pure filename-matching, bounded-concurrency queue (`concurrency = 2`), and row-validation helpers into `meterBatchPhotoHelpers.js`, and surface them through a dedicated `MeterBatchPhotoImportModal.jsx` wired into `MeterReadingsPage.jsx`.

**Tech Stack:** Node.js 22 (`node:test`), Express 4, PostgreSQL 16 (RLS), Gemini Interactions API (`gemini-3.8-flash`), React 19, Tailwind CSS 3, Vite 8.

**Spec:** `docs/superpowers/specs/2026-11-05-meter-batch-photo-ocr-import-design.md`

## Global Constraints

- **RBAC & Building Isolation (`PRD 6.2`):** Only `MANAGER` assigned to the target building may call `POST /api/v1/ai/meter-ocr` or `POST /api/v1/meters/readings/batch`; cross-building calls return `403 ACCESS_DENIED` and log `ACCESS_DENIED` in `audit_log`.
- **Human-in-the-Loop (`PRD 12.1`, `AC-014.1`, `AC-014.2`):** OCR never writes to `meter_reading`; blurry/low-confidence photos return `reading: null` + `needs_human_review: true`; database writes happen only when the manager clicks Save Draft (`DRAFT`) or Save & Confirm (`CONFIRMED`).
- **Zero-PII Prompt (`PRD 12.3`):** Never query or send `person` / `tenant` PII in `runMeterOcrSuggestion`.
- **Batch Limits & Rate Limit:** Max `30` photos per batch upload on the client, `2` concurrent OCR requests per queue tick, and `aiRateLimiter` set to `max: 60` per minute per user.
- **Backwards Compatibility:** Existing `POST /api/v1/ai/meter-ocr` callers passing `{ meter_id, period, contract_id, image_base64 }` and existing mocked Gemini responses omitting `detected_meter_type` must continue to work identically.

## Review Focus

1. **Prefix-collision on apartment codes in filenames (`A100` vs `A1001`):** Uploading `A1001_dien.jpg` in a building containing apartments `A10`, `A100`, and `A1001` must match `A1001` (longest alphanumeric-bounded match), never `A10` or `A100`. *(Pinned in Task 2)*
2. **Duplicate photos targeting the same meter in one batch:** Uploading two photos that both resolve to `EL-VOP-A-A1001` must flag both rows with `DUPLICATE_METER_TARGET` and exclude them from save until the manager reassigns or removes one. *(Pinned in Task 2)*
3. **Partial batch failures & Gemini timeout isolation:** If photo #2 out of 4 fails with HTTP 504/timeout or returns `reading: null` (`AC-014.1`), photos #1, #3, #4 still complete OCR and remain saveable without rollback or unhandled rejection. *(Pinned in Task 1 & Task 2)*
4. **Locked/billed contract slot protection:** If an uploaded photo matches a meter whose target contract slot in `period` is already billed (`is_billed` / `is_period_finalized`), the modal marks the row `LOCKED_BILLED` and excludes it from batch save. *(Pinned in Task 2)*
5. **Cross-building `building_id` / `apartment_id` spoofing on `/api/v1/ai/meter-ocr`:** A `MANAGER` of `VOP-A` passing `building_id` of `VOP-B` (or `building_id` of `VOP-A` paired with an `apartment_id` belonging to `VOP-B`) must receive `403 ACCESS_DENIED` / `404 NOT_FOUND` before calling Gemini. *(Pinned in Task 1)*

---

### Task 1: Backend AI-02 `detected_meter_type` & Building/Apartment-Scoped Meter Resolution

**Files:**
- Modify: `api/src/services/aiRules.js:410-495,658-679`
- Modify: `api/src/services/aiGateway.js:369-568`
- Modify: `api/src/routes/ai.js:138-215`
- Modify: `api/src/middleware/rateLimiter.js:44-58`
- Test: `api/test/meterBatchPhotoOcrBackend.test.js`

**Interfaces:**
- Consumes: `callGeminiStructured`, `selectTargetPeriodContract`, `resolveChainedReadingBounds`, `loadApartmentPeriodContractsMap`, `loadMeterPeriodReadingsWithLocks`
- Produces:
  - `postValidateMeterOcr({ rawModelJson, expectedMeterType, previousValue, baselineAvgConsumption, anomalyThresholdPct, confidenceThreshold })` -> `{ reading, detectedMeterType: 'ELECTRICITY' | 'WATER' | null, confidence, reason, warnings, needsHumanReview }`
  - `POST /api/v1/ai/meter-ocr` accepting `{ meter_id?, building_id?, apartment_id?, period?, contract_id?, image_base64 }` and returning `data.output` with `{ reading, detected_meter_type, resolved_meter_id, resolved_meter_code, apartment_id, unit, previous_value, estimated_consumption, reason }`

- [ ] **Step 1: Write failing unit & integration tests in `api/test/meterBatchPhotoOcrBackend.test.js`**
  - Test `postValidateMeterOcr` normalizes `detected_meter_type` (`'ELECTRICITY' | 'WATER' | null`), keeps backwards compatibility when omitted, and appends `'METER_TYPE_MISMATCH'` + `needsHumanReview = true` when `expectedMeterType = 'ELECTRICITY'` but model returns `detected_meter_type = 'WATER'`.
  - Test `POST /api/v1/ai/meter-ocr` with `{ building_id, apartment_id, period, image_base64 }` (no `meter_id`) resolves the `WATER` meter of that apartment when Gemini returns `detected_meter_type: 'WATER'`, computes `previous_value` & `estimated_consumption`, and links cleanly when saved via `POST /api/v1/meters/readings/batch`.
  - Test `POST /api/v1/ai/meter-ocr` with `{ building_id, period, image_base64 }` alone returns `resolved_meter_id: null` + `detected_meter_type: 'ELECTRICITY'` + valid `suggestion_id`, and rejects cross-building `building_id` (`403 ACCESS_DENIED`) or mismatched `(building_id, apartment_id)` (`404 NOT_FOUND`).

- [ ] **Step 2: Run test to verify RED**
  - Run: `cd d:\resihub\api; node --test test/meterBatchPhotoOcrBackend.test.js`
  - Expected: FAIL (`VALIDATION_ERROR` requiring `meter_id` and missing `detectedMeterType`).

- [ ] **Step 3: Implement backend changes in `aiRules.js`, `aiGateway.js`, `routes/ai.js`, and `rateLimiter.js`**
  - Add optional `detected_meter_type` (`enum: ['ELECTRICITY', 'WATER']`, `nullable: true`) to `METER_OCR` schema/prompt in `aiRules.js` and `METER_TYPE_MISMATCH` check in `postValidateMeterOcr`.
  - Update `runMeterOcrSuggestion` in `aiGateway.js` and `POST /api/v1/ai/meter-ocr` in `routes/ai.js` to support `meter_id` OR `(building_id, optional apartment_id)` with strict `MANAGER` building scope validation.
  - Update `aiRateLimiter` in `rateLimiter.js` from `max: 20` to `max: 60`.

- [ ] **Step 4: Run backend tests to verify GREEN**
  - Run: `cd d:\resihub\api; node --test test/meterBatchPhotoOcrBackend.test.js test/week7AiRulesUnit.test.js test/m15AiEndpointsAndWorkflows.test.js`
  - Expected: PASS (`0` failures).

---

### Task 2: Frontend Filename Matcher, Bounded Queue & Batch Validation Helpers

**Files:**
- Create: `frontend/src/utils/meterBatchPhotoHelpers.js`
- Test: `api/test/frontendMeterBatchPhotoHelpers.test.js`

**Interfaces:**
- Consumes: `evaluateClientMeterAnomaly`, `computeMeterEstimatedAmount`, `isMeterRowLockedForEdit` from `frontend/src/utils/billing.js`
- Produces:
  - `MAX_BATCH_METER_PHOTOS` (`30`), `DEFAULT_OCR_CONCURRENCY` (`2`)
  - `matchMeterFromFilename(fileName, buildingMeters)` -> `{ matchKind: 'EXACT_METER' | 'APARTMENT_ONLY' | 'UNMATCHED', meterId: string | null, apartmentId: string | null, apartmentCode: string | null, meterTypeHint: 'ELECTRICITY' | 'WATER' | null }`
  - `resolveMeterAfterOcr({ item, ocrData, buildingMeters })` -> resolved `meterId` when `matchKind === 'APARTMENT_ONLY'` and `ocrData?.output?.resolved_meter_id` or `detected_meter_type` is returned
  - `runBoundedConcurrencyQueue(items, concurrency, workerFn, { signal } = {})` -> `Promise<Array<{ status: 'fulfilled' | 'rejected', value?, reason? }>>`
  - `evaluateBatchPhotoImportItems(items, buildingMeters, { anomalyThresholdPct, canWriteMeters })` -> `{ rows, summary, saveableRows }`
  - `buildBatchPhotoSavePayload({ saveableRows, period, targetStatus })` -> `{ period, status, hold_if_abnormal: true, readings }`

- [ ] **Step 1: Write failing unit tests in `api/test/frontendMeterBatchPhotoHelpers.test.js`**
  - Cover `A1001_dien.jpg` vs `A100` / `A10` prefix collision (`EXACT_METER`), `EL-VOP-A-A1001.png` (`EXACT_METER`), `A1001 (1).jpg` (`APARTMENT_ONLY` -> auto-resolves via `resolveMeterAfterOcr`), `IMG_4021.jpg` (`UNMATCHED`), duplicate target meter detection (`DUPLICATE_METER_TARGET`), locked/billed meter exclusion (`LOCKED_BILLED`), `>30%` abnormal note handling, and `runBoundedConcurrencyQueue` max active concurrency `<= 2` with error isolation.

- [ ] **Step 2: Run test to verify RED**
  - Run: `cd d:\resihub\api; node --test test/frontendMeterBatchPhotoHelpers.test.js`
  - Expected: FAIL (`ERR_MODULE_NOT_FOUND`).

- [ ] **Step 3: Implement `frontend/src/utils/meterBatchPhotoHelpers.js`**
  - Implement pure deterministic matching, queue execution, validation states, and batch save payload builder.

- [ ] **Step 4: Run test to verify GREEN**
  - Run: `cd d:\resihub\api; node --test test/frontendMeterBatchPhotoHelpers.test.js`
  - Expected: PASS (`0` failures).

---

### Task 3: `MeterBatchPhotoImportModal.jsx` UI & `MeterReadingsPage.jsx` Integration

**Files:**
- Create: `frontend/src/components/meters/MeterBatchPhotoImportModal.jsx`
- Modify: `frontend/src/pages/admin/meters/MeterReadingsPage.jsx`
- Modify: `api/test/frontendMeterBatchPhotoHelpers.test.js`

**Interfaces:**
- Consumes: Task 1 `/api/v1/ai/meter-ocr` response fields (`resolved_meter_id`, `detected_meter_type`, `reading`, `confidence`) and Task 2 helpers from `meterBatchPhotoHelpers.js`, plus `aiService.ocrMeterReading`, `metersService.list`, `metersService.recordBatch`, `buildingsService.list`, `compressImageFileToDataUri`.
- Produces: `<MeterBatchPhotoImportModal open onClose initialBuildingId period anomalyThresholdPct canWriteMeters onSaved />` wired into `MeterReadingsPage.jsx`.

- [ ] **Step 1: Add failing UI integration source assertions in `api/test/frontendMeterBatchPhotoHelpers.test.js`**
  - Assert `MeterBatchPhotoImportModal.jsx` enforces `MAX_BATCH_METER_PHOTOS`, renders building `<Select>` + per-row meter `<Select>`, supports per-photo retry (`Thử lại`), and calls `metersService.recordBatch`.
  - Assert `MeterReadingsPage.jsx` renders the **`Import ảnh AI`** trigger button inside `canWriteMeters` and mounts `<MeterBatchPhotoImportModal`.

- [ ] **Step 2: Run test to verify RED**
  - Run: `cd d:\resihub\api; node --test test/frontendMeterBatchPhotoHelpers.test.js`
  - Expected: FAIL (`MeterBatchPhotoImportModal.jsx` missing).

- [ ] **Step 3: Implement `MeterBatchPhotoImportModal.jsx` and wire into `MeterReadingsPage.jsx`**
  - Build responsive modal (`size="full"`) with building selector, naming guide, multi-image upload (`<= 30`), live OCR progress bar (`concurrency = 2`), thumbnail preview, meter reassignment `<Select>`, editable reading & abnormal note inputs, per-row retry/remove buttons, and `Lưu nháp` / `Lưu & Chốt` footer buttons.
  - Wire button & modal state into `MeterReadingsPage.jsx`.

- [ ] **Step 4: Run frontend tests & Vite production build to verify GREEN**
  - Run: `cd d:\resihub\api; node --test test/frontend*.test.js` and `cd d:\resihub\frontend; npm run build`
  - Expected: All frontend tests PASS (`0` failures) and Vite build exits `0`.

---

### Task 4: Whole-Branch Verification & Code Review

**Files:**
- Verify all modified/created files across `api/` and `frontend/`

- [ ] **Step 1: Run full regression suite across M08 & M15**
  - Run: `cd d:\resihub\api; node --test test/meterBatchPhotoOcrBackend.test.js test/frontend*.test.js test/week7AiRulesUnit.test.js test/aiGatewayService.test.js test/m15AiEndpointsAndWorkflows.test.js test/autoProvisionMeters.test.js`
  - Expected: 100% PASS (`0` failures).

- [ ] **Step 2: Dispatch fresh `research` code-reviewer subagent (`Model: 'pro'`)**
  - Review whole diff against `docs/superpowers/specs/2026-11-05-meter-batch-photo-ocr-import-design.md` and the 5 `Review Focus` items; resolve any Critical/Important findings via RED->GREEN TDD.
