# Week 7: AI Gateway & Human-in-the-Loop Suggestions (M15) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the server-side Gemini AI Gateway (M15) for the 3 MVP workflows — `AI-01` CCCD & Contract extraction (`FR-059`), `AI-02` Electricity/Water Meter OCR (`FR-030`, `FR-059`, `US-014`, `AC-014.1`, `AC-014.2`), and `AI-03` Service Request Triage (`FR-043`, `US-011`, `AC-011.1`, `AC-011.2`) — strictly enforcing **"AI đề xuất, người quyết định"** (`PRD 12.1`), `ai_suggestion` draft persistence, kill switches, monthly budget caps (`NFR-013`), and KPI `G6` tracking across PostgreSQL RLS, Express APIs, and React Admin screens.

**Architecture:** Isolate pure prompt/schema builders, closed-taxonomy & meter post-validators, PII redaction/hashing, and budget/kill-switch guards in `api/src/services/aiRules.js`, backed by a zero-SDK native `fetch` Gemini REST adapter (`geminiClient.js`) and transactional orchestrator (`aiGateway.js`). Add migration `051` for `ai_suggestion` (`FORCE ROW LEVEL SECURITY`), `meter_reading.source`, and non-disruptive `service_request` triage columns (`ai_*` keeping `status = 'NEW'`), expose `/api/v1/ai/*` suggestion-only endpoints, wire confirmation hooks into existing save routes (`meters.js`, `service-requests.js`, `tenants.js`, `contracts.js`), and build the reusable `AISuggestionField` + `AiGatewayConfigCard` components on the Frontend.

**Tech Stack:** Node.js 20 (ESM, native `fetch` + `AbortController`), Express 4, Google Gemini REST API (`v1beta` structured JSON `responseSchema`), PostgreSQL (`pg` + 2-layer `FORCE ROW LEVEL SECURITY`), `node:test`, React 18, Vite, Tailwind CSS, Lucide Icons.

**Spec:** `PRD - Quan ly Can ho va Nha cho thue v2.0.md` (Sections 4 `G6`, 6.2, 7.3, 7.5, 9 `M15`, 10.1 `FR-030`/`FR-043`/`FR-059`, 11 `US-011`/`US-014`/`AC-011.1`–`AC-014.2`, 12.1–12.5, 13.2, 13.5, 14.1, 14.3, 16.2, 16.5, 17 `NFR-007`/`NFR-013`, 18.1) & `FRONTEND DEVELOPER Roadmap (Hiep).md` (Tuần 7: Tích hợp AI Gateway M15).

## Global Constraints

- **"AI đề xuất, người quyết định" (`PRD 12.1 #1 & #2`, `14.3`, `18.1`):** Calling `/api/v1/ai/*` endpoints MUST NEVER insert or mutate business rows in `person`, `tenant`, `contract`, `meter_reading`, `invoice`, `payment`, or `service_request` business fields (`category`, `priority`, `assigned_to`, `status`). AI outputs are stored solely as `PENDING` drafts in `ai_suggestion` until a human explicitly saves/confirms.
- **Server-Only Gemini Calls & Secret Hygiene (`PRD 12.1 #6`, `14.1`, `NFR-007`):** Gemini is called exclusively from the Backend using `GEMINI_API_KEY` passed in the `x-goog-api-key` HTTP header (never in URL query strings or Frontend bundles). `/api/v1/settings` may return only a boolean `api_key_configured`, never the key or partial key.
- **4-Role RBAC & Building Isolation (`PRD 6.2`, `12.2`, `13.5`, `AC-019.1`):** `MANAGER` has building-scoped access to `AI-01`, `AI-02`, and `AI-03` (`SYS_ADMIN` may also use `AI-01` for `CCCD_EXTRACT` on org tenant CRUD and manages `ai_config`); `OWNER` is strictly Read-Only (`403` on all `/api/v1/ai/*` execution routes) and blocked by PostgreSQL RLS from reading `CCCD_EXTRACT`/`CONTRACT_EXTRACT` rows; `RESIDENT` has no direct `/api/v1/ai/*` access (`AI-03` triggers asynchronously in the background on resident ticket creation). Cross-building `MANAGER` requests return `403 ACCESS_DENIED` + `audit_log`.
- **PostgreSQL `FORCE ROW LEVEL SECURITY` (`NFR-008`):** `ai_suggestion` must have `ENABLE` + `FORCE ROW LEVEL SECURITY` with default-deny when `app.current_user_id` is unset, `DELETE` blocked (`USING (FALSE)` per `NFR-016`), and user-scoped mutations executed via `getUserClient(req)` / `pool`.
- **Data Minimization & PII Protection (`PRD 12.1 #4`, `12.5`, `13.2`):** Only `AI-01` (`CCCD_EXTRACT`, `CONTRACT_EXTRACT`) may send ID/contract documents to Gemini, requiring explicit `privacy_acknowledged: true` (`422 PRIVACY_CONSENT_REQUIRED`). `AI-02` sends only the meter photo + meter type/previous value (zero resident PII). `ai_suggestion.output` masks `id_number` and `phone` before DB persistence while storing per-field SHA-256 digests (`field_hashes`) to compute KPI `G6` acceptance rates accurately.
- **Uncertainty, Kill Switch & Monthly Budget Cap (`PRD 12.1 #3`, `12.5`, `NFR-013`):** Sub-threshold confidence returns `needs_human_review: true` (and `reading: null` for `AI-02` — never guessing). `ai_config` provides global `enabled` and per-task kill switches plus monthly token/VND caps with an automatic `80%` threshold `SYS_ADMIN` notification.
- **UX Component Standard (`PRD 16.2`, `16.4`, `16.5`):** AI-populated inputs must render inside `AISuggestionField` with a distinct background, dashed border (`border-dashed`), `"AI đề xuất"` badge, confidence percentage, `aria-live="polite"`, and explicit confirm/override handling.

## Review Focus

1. **API Key Leakage via URL Error Logs or Settings Payload (`NFR-007`, `PRD 12.1 #6`):** If `fetch` fails or times out against Gemini, passing `?key=...` in the URL would leak `GEMINI_API_KEY` into error logs; `geminiClient.js` must pass `x-goog-api-key` exclusively in headers, redact headers on error, return `503 AI_UNCONFIGURED` when `GEMINI_API_KEY` is unset, and `/api/v1/settings` must never expose any secret string (tested in Task 3 & Task 4).
2. **`OWNER` PII Exposure & Unmasked CCCD Persistence in `ai_suggestion` (`PRD 12.5`, `13.2`, `13.5`):** Even if an `OWNER` owns building `VOP-A`, querying `ai_suggestion` under `OWNER` RLS must return `0` rows for `CCCD_EXTRACT` and `CONTRACT_EXTRACT`, and the stored `ai_suggestion.output` JSONB in PostgreSQL must never contain unmasked 12-digit `id_number` or full `phone` values while still computing exact `accepted_fields_count` via `field_hashes` (tested in Task 1 & Task 2).
3. **Closed-Taxonomy Hallucination, Cost-Bearer Inference & Safety-Hazard Under-Triage (`PRD 12.3`, `AC-011.2`):** When Gemini invents an out-of-enum category (e.g., `'ELEVATOR'`), outputs `confidence < triage_threshold`, or includes a hallucinated `cost_bearer` field, `postValidateTicketTriage` must strip `cost_bearer`, mark `NEEDS_MANUAL_REVIEW` without setting invalid enums, and deterministically escalate `priority` to `'URGENT'` when description contains life-safety hazards (`rò điện`, `chập cháy`, `vỡ ống`, `ngập nước`, `rò khí gas`) (tested in Task 1 & Task 4).
4. **Blurry Meter OCR Hallucination & Zero-Side-Effect Guarantee (`AC-014.1`, `AC-014.2`, `PRD 18.1`):** Calling `POST /api/v1/ai/meter-ocr` with a low-confidence/blurry response must return `reading: null, needs_human_review: true` (never guessing digits), flag `reading < previous_value` as `needs_human_review: true` (`READING_LOWER_THAN_PREVIOUS`), and leave `meter_reading` row counts and values 100% untouched until `MANAGER` submits `/api/v1/meters/.../readings` (tested in Task 1, Task 3 & Task 4).
5. **Non-Blocking Resident Breakdown Intake Under AI Timeout / Budget Exhaustion (`AC-004.1`, `PRD 12.3`, `12.5`):** When Gemini times out, fails HTTP `429`/`500`, `ai_config.enabled === false`, or the monthly budget cap is exceeded, `POST /api/v1/resident/service-requests` must still succeed (`201`) immediately with `status = 'NEW'` and asynchronously stamp `ai_triage_status = 'FAILED'` or `'SKIPPED'` without throwing unhandled rejections (tested in Task 4).

## File Structure

- `api/src/services/aiRules.js` (Create): Pure M15 config normalizer, magic-byte file parser, Gemini JSON schemas & prompts, meter/triage post-validators, PII masking + SHA-256 field-acceptance diffing, and budget/kill-switch evaluators.
- `api/src/db/migrations/051_m15_ai_gateway_and_suggestions.sql` (Create): `ai_suggestion` table + indexes + `FORCE ROW LEVEL SECURITY`, `meter_reading.source` + `ai_suggestion_id`, `service_request` `ai_*` triage columns, `fn_record_background_ticket_triage` RPC, `fn_get_ops_resource_scope` extension, `rls_audit_log_select_m15`, and default `ai_config` seed.
- `api/src/config/env.js`, `api/.env.example`, `.env.example`, `docker-compose.yml` (Modify): Server-only `GEMINI_API_KEY`, `GEMINI_BASE_URL`, and `GEMINI_TIMEOUT_MS` configuration (including Docker Compose pass-through to `api` container).
- `api/src/services/geminiClient.js` (Create): Native `fetch` + `AbortController` Gemini `generateContent` REST client using `x-goog-api-key` header, structured JSON `responseSchema`, token metadata extraction, and injectable test transport.
- `api/src/services/aiGateway.js` (Create): Transactional AI Gateway orchestrating budget/kill-switch checks, `80%` budget warning notifications, `AI-01` (`CCCD_EXTRACT` / `CONTRACT_EXTRACT`), `AI-02` (`METER_OCR`), `AI-03` (`TICKET_TRIAGE`), suggestion review/acceptance diffing (`G6`), and stale suggestion expiry.
- `api/src/routes/ai.js` (Create): Express router `/api/v1/ai` (`/extract`, `/meter-ocr`, `/classify`, `/suggestions/:id/review`, `/usage`) with `aiRateLimiter`, `idempotencyGuard()`, and 4-role/building-scope enforcement.
- `api/src/routes/settings.js`, `api/src/routes/meters.js`, `api/src/routes/service-requests.js`, `api/src/routes/resident.js`, `api/src/routes/tenants.js`, `api/src/routes/contracts.js`, `api/src/jobs/daily.js`, `api/src/server.js` (Modify): Wire `ai_config` normalization, `source = 'AI'` + `ai_suggestion_id` confirmation hooks, non-blocking async `AI-03` triage on new tickets, 1-click triage apply/override, and daily `PENDING -> EXPIRED` cleanup.
- `frontend/src/utils/aiHelpers.js` (Create): Client-side image compression helper, confidence badge metadata, AI field state tracker, and Vietnamese error code mapper.
- `frontend/src/services/ai.service.js` (Create): Frontend API client for `/api/v1/ai/*` wrapped with `withIdempotency`.
- `frontend/src/components/ui/AISuggestionField.jsx` (Create): Reusable `PRD 16.2`/`16.5` wrapper with tinted background, dashed border, `"AI đề xuất"` badge, confidence pill, `aria-live="polite"`, and confirm/dismiss controls.
- `frontend/src/components/settings/AiGatewayConfigCard.jsx` (Create): Shared AI Gateway settings, kill switches, thresholds, monthly budget progress bar, and `G6` KPI card rendered in both `SettingsPage.jsx` and `UsersPage.jsx` (`Tab settings`).
- `frontend/src/pages/admin/settings/SettingsPage.jsx`, `frontend/src/pages/admin/users/UsersPage.jsx`, `frontend/src/pages/admin/tenants/TenantsPage.jsx`, `frontend/src/pages/admin/tenants/TenantDetailPage.jsx`, `frontend/src/pages/admin/contracts/ContractsPage.jsx`, `frontend/src/pages/admin/meters/MeterReadingsPage.jsx`, `frontend/src/pages/admin/maintenance/ServiceRequestsPage.jsx`, `frontend/src/services/serviceRequests.service.js` (Modify): End-to-end Admin UI integration for `AI-01`, `AI-02`, `AI-03`, and `ai_config`.

---

### Task 1: Pure AI Domain Rules, Schemas, Post-Validators & PII Hashing (`aiRules.js`)

**Files:**
- Create: `api/src/services/aiRules.js`
- Test: `api/test/week7AiRulesUnit.test.js`

**Interfaces:**
- Consumes: `maskIdNumber`, `maskPhone` from `api/src/utils/piiMask.js`; `MAX_IMAGE_BYTES`, `MAX_CONTRACT_SCAN_BYTES` from `api/src/services/imageUpload.js`.
- Produces (from `api/src/services/aiRules.js`):
  - `AI_TASK_TYPES = ['CCCD_EXTRACT', 'CONTRACT_EXTRACT', 'METER_OCR', 'TICKET_TRIAGE']`
  - `AI_SUGGESTION_STATUSES = ['PENDING', 'ACCEPTED', 'EDITED_ACCEPTED', 'REJECTED', 'EXPIRED', 'FAILED']`
  - `CLOSED_TICKET_CATEGORIES = ['ELECTRICAL', 'PLUMBING', 'HVAC', 'FURNITURE', 'APPLIANCE', 'CLEANING', 'SECURITY', 'OTHER']`
  - `CLOSED_TICKET_PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT']`
  - `PROMPT_VERSIONS = { CCCD_EXTRACT: 'cccd-v1.0', CONTRACT_EXTRACT: 'contract-v1.0', METER_OCR: 'meter-v1.0', TICKET_TRIAGE: 'triage-v1.0' }`
  - `DEFAULT_AI_CONFIG` (`enabled: true`, `cccd_extract_enabled: true`, `contract_extract_enabled: true`, `meter_ocr_enabled: true`, `ticket_triage_enabled: true`, `model: 'gemini-2.5-flash'`, `confidence_threshold: 0.75`, `meter_ocr_threshold: 0.8`, `triage_threshold: 0.7`, `monthly_budget_vnd: 500000`, `monthly_token_limit: 2000000`, `warn_percent: 80`, `suggestion_ttl_hours: 72`)
  - `normalizeAiConfig(incoming, existing = {}) -> object` (throws `{ status: 400, code: 'VALIDATION_ERROR' }` on out-of-range thresholds `(0, 1]`, invalid model slug, or non-positive limits)
  - `evaluateBudgetGate({ aiConfig, taskType, monthlyTokensUsed = 0, monthlyCostVnd = 0 }) -> { allowed: boolean, warning80Pct: boolean, code?: 'AI_DISABLED' | 'AI_TASK_DISABLED' | 'AI_BUDGET_EXCEEDED', message?: string }`
  - `parseDataUriPayload(dataUri, { allowPdf = false, maxBytes = MAX_IMAGE_BYTES }) -> { valid: boolean, mimeType?: string, base64Data?: string, byteLength?: number, sha256Hex?: string, code?: string, message?: string }` (verifies magic bytes for JPEG `FFD8FF`, PNG `89504E47`, WebP `RIFF....WEBP`, and PDF `%PDF-` when `allowPdf === true`)
  - `buildExtractionDbPayload(taskType, extractedFields, fieldConfidences) -> { redactedOutput: object, fieldHashes: Record<string, string>, totalFieldsCount: number }` (masks `id_number` & `phone` in `redactedOutput` while computing normalized SHA-256 `fieldHashes` for every non-empty extracted field)
  - `computeFieldAcceptanceDiff({ fieldHashes = {}, finalValues = {} }) -> { acceptedFieldsCount: number, totalFieldsCount: number, status: 'ACCEPTED' | 'EDITED_ACCEPTED' }`
  - `postValidateMeterOcr({ rawModelJson, previousValue = null, baselineAvgConsumption = null, anomalyThresholdPct = 30, confidenceThreshold = 0.8 }) -> { reading: number | null, confidence: number, reason: string, needsHumanReview: boolean, warnings: string[] }`
  - `postValidateTicketTriage({ rawModelJson, description = '', allowedAssigneeIds = [], confidenceThreshold = 0.7 }) -> { category: string | null, priority: string | null, suggestedAssigneeId: string | null, summary: string, confidence: number, needsHumanReview: boolean, triageStatus: 'SUGGESTED' | 'NEEDS_MANUAL_REVIEW', warnings: string[] }`
  - `estimateGeminiCostVnd({ inputTokens = 0, outputTokens = 0, model = 'gemini-2.5-flash' }) -> number`
  - `buildGeminiPromptAndSchema(taskType, context) -> { systemInstruction: string, userPrompt: string, responseSchema: object }`

- [ ] **Step 1: Write failing unit tests in `api/test/week7AiRulesUnit.test.js`**

Cover pure in-memory logic (zero DB/network calls) including *Review Focus #2, #3, #4*:
- `normalizeAiConfig`: merges defaults cleanly; rejects `confidence_threshold: 1.5`, `confidence_threshold: 0`, `monthly_budget_vnd: -100`, `warn_percent: 120`, and `model: '../bad'` with `status === 400` and `code === 'VALIDATION_ERROR'`.
- `evaluateBudgetGate`: returns `AI_DISABLED` when `enabled === false`; `AI_TASK_DISABLED` when `meter_ocr_enabled === false` for `METER_OCR`; `AI_BUDGET_EXCEEDED` when `monthlyCostVnd >= monthly_budget_vnd` or `monthlyTokensUsed >= monthly_token_limit`; `allowed: true, warning80Pct: true` at `82%` of budget.
- `parseDataUriPayload`: accepts valid JPEG/PNG magic bytes and valid `%PDF-1.7` when `allowPdf: true`; rejects fake PDF (`data:application/pdf;base64,SGVsbG8=`) and PDF when `allowPdf: false` with `code: 'VALIDATION_ERROR'`.
- `buildExtractionDbPayload` & `computeFieldAcceptanceDiff` (*Review Focus #2*): given `{ full_name: 'Nguyễn Văn A', id_number: '001099012345', phone: '0901234567', dob: '1999-05-20' }`, `redactedOutput.id_number` does NOT contain `'001099012345'` and `redactedOutput.phone` does NOT contain `'0901234567'`; `computeFieldAcceptanceDiff` returns `{ acceptedFieldsCount: 4, totalFieldsCount: 4, status: 'ACCEPTED' }` when unchanged and `{ acceptedFieldsCount: 3, totalFieldsCount: 4, status: 'EDITED_ACCEPTED' }` when `dob` is edited by the user.
- `postValidateMeterOcr` (*Review Focus #4*):
  - `{ reading: 1234, confidence: 0.65 }` (`< 0.8`) -> `reading === null`, `needsHumanReview === true`, `warnings` includes `'LOW_CONFIDENCE_OR_UNREADABLE'`.
  - `{ reading: 1200, confidence: 0.95 }` with `previousValue: 1250` -> `reading === 1200`, `needsHumanReview === true`, `warnings` includes `'READING_LOWER_THAN_PREVIOUS'`.
  - `{ reading: 1500, confidence: 0.95 }` with `previousValue: 1200`, `baselineAvgConsumption: 150`, `anomalyThresholdPct: 30` -> `needsHumanReview === true`, `warnings` includes `'CONSUMPTION_ANOMALY_HIGH'`.
  - `{ reading: 1320, confidence: 0.94 }` with `previousValue: 1200`, `baselineAvgConsumption: 110` -> `reading === 1320`, `needsHumanReview === false`, `warnings.length === 0`.
- `postValidateTicketTriage` (*Review Focus #3*):
  - Out-of-taxonomy `category: 'ELEVATOR_REPAIR'` -> `category === null`, `triageStatus === 'NEEDS_MANUAL_REVIEW'`, `needsHumanReview === true`.
  - Hallucinated `cost_bearer: 'TENANT'` in `rawModelJson` is stripped (`'cost_bearer' in result === false`).
  - `suggested_assignee_id` not in `allowedAssigneeIds` -> `suggestedAssigneeId === null`.
  - Description `'Ổ cắm phòng ngủ bị rò điện đánh tia lửa'` with model returning `priority: 'NORMAL'`, `confidence: 0.9` -> escalates `priority === 'URGENT'` with warning `'SAFETY_HAZARD_ESCALATED'`.

- [ ] **Step 2: Run unit tests to verify they fail**

Run: `node --test --test-concurrency=1 test/week7AiRulesUnit.test.js` (cwd: `d:\resihub\api`)
Expected: FAIL (`ERR_MODULE_NOT_FOUND` for `api/src/services/aiRules.js`).

- [ ] **Step 3: Implement `api/src/services/aiRules.js`**

Implement all exported constants, schemas, prompts, redaction/hash helpers, and post-validators matching the Interfaces block with zero DB or network imports.

- [ ] **Step 4: Run unit tests to verify they pass**

Run: `node --test --test-concurrency=1 test/week7AiRulesUnit.test.js` (cwd: `d:\resihub\api`)
Expected: PASS (0 failures).

- [ ] **Step 5: Commit**

```bash
git add api/src/services/aiRules.js api/test/week7AiRulesUnit.test.js
git commit -m "feat(m15): add pure AI rules, schemas, post-validators and PII hash diffing"
```

---

### Task 2: Database Migration `051` — `ai_suggestion`, `meter_reading.source`, `service_request` Triage Columns & 2-Layer RLS

**Files:**
- Create: `api/src/db/migrations/051_m15_ai_gateway_and_suggestions.sql`
- Test: `api/test/migration051AiGatewayRls.test.js`

**Interfaces:**
- Consumes: Existing RLS helpers (`is_org_admin()`, `is_owner()`, `is_manager()`, `is_resident()`, `get_current_user_id()`, `get_current_user_org_id()`, `get_owner_building_ids()`, `get_manager_building_ids()`, `fn_get_ops_resource_scope`).
- Produces:
  - New `ai_suggestion` table:
    - `(id UUID PK DEFAULT gen_random_uuid(), org_id UUID NOT NULL REFERENCES org(id) ON DELETE CASCADE, building_id UUID REFERENCES building(id) ON DELETE CASCADE, task_type TEXT NOT NULL CHECK (task_type IN ('CCCD_EXTRACT', 'CONTRACT_EXTRACT', 'METER_OCR', 'TICKET_TRIAGE')), target_entity TEXT NOT NULL CHECK (target_entity IN ('tenant', 'contract', 'meter_reading', 'service_request')), target_entity_id UUID, input_ref JSONB NOT NULL DEFAULT '{}'::jsonb, output JSONB NOT NULL DEFAULT '{}'::jsonb, edited_output JSONB, warnings JSONB NOT NULL DEFAULT '[]'::jsonb, confidence NUMERIC(4,3) CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)), needs_human_review BOOLEAN NOT NULL DEFAULT TRUE, accepted_fields_count INT NOT NULL DEFAULT 0 CHECK (accepted_fields_count >= 0), total_fields_count INT NOT NULL DEFAULT 0 CHECK (total_fields_count >= 0), model TEXT NOT NULL, prompt_version TEXT NOT NULL, input_tokens INT NOT NULL DEFAULT 0 CHECK (input_tokens >= 0), output_tokens INT NOT NULL DEFAULT 0 CHECK (output_tokens >= 0), estimated_cost_vnd BIGINT NOT NULL DEFAULT 0 CHECK (estimated_cost_vnd >= 0), latency_ms INT CHECK (latency_ms IS NULL OR latency_ms >= 0), status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'ACCEPTED', 'EDITED_ACCEPTED', 'REJECTED', 'EXPIRED', 'FAILED')), error_code TEXT, created_by UUID REFERENCES app_user(id) ON DELETE SET NULL, reviewed_by UUID REFERENCES app_user(id) ON DELETE SET NULL, reviewed_at TIMESTAMPTZ, expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '72 hours'), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`
    - Constraint `chk_ai_suggestion_building_scope`: `(task_type IN ('CCCD_EXTRACT', 'CONTRACT_EXTRACT')) OR (building_id IS NOT NULL)`.
    - Indexes: `idx_ai_suggestion_org_created (org_id, created_at DESC)`, `idx_ai_suggestion_building_task (building_id, task_type, status)`, `idx_ai_suggestion_target (target_entity, target_entity_id)`, `idx_ai_suggestion_pending_exp (status, expires_at) WHERE status = 'PENDING'`.
  - Extended `meter_reading` (`PRD 13.2`):
    - `source TEXT NOT NULL DEFAULT 'MANUAL' CHECK (source IN ('MANUAL', 'AI', 'IOT'))`
    - `ai_suggestion_id UUID REFERENCES ai_suggestion(id) ON DELETE SET NULL`
  - Extended `service_request` (`FR-043`, `AC-011.1`, `AC-011.2`):
    - `ai_suggestion_id UUID REFERENCES ai_suggestion(id) ON DELETE SET NULL`
    - `ai_triage_status TEXT CHECK (ai_triage_status IS NULL OR ai_triage_status IN ('PENDING', 'SUGGESTED', 'NEEDS_MANUAL_REVIEW', 'ACCEPTED', 'OVERRIDDEN', 'FAILED', 'SKIPPED'))`
    - `ai_summary TEXT`, `ai_suggested_category TEXT`, `ai_suggested_priority TEXT`, `ai_suggested_assignee_id UUID REFERENCES app_user(id) ON DELETE SET NULL`, `ai_confidence NUMERIC(4,3)`
  - `FORCE ROW LEVEL SECURITY` on `ai_suggestion` (`GRANT SELECT, INSERT, UPDATE ON ai_suggestion TO resihub_app`, zero `DELETE`):
    - `rls_ai_suggestion_select`:
      - `is_org_admin() AND org_id = get_current_user_org_id()`
      - OR `is_manager() AND org_id = get_current_user_org_id() AND (building_id IN (SELECT building_id FROM get_manager_building_ids()) OR (building_id IS NULL AND created_by = get_current_user_id()))`
      - OR `is_owner() AND org_id = get_current_user_org_id() AND building_id IN (SELECT building_id FROM get_owner_building_ids()) AND task_type IN ('METER_OCR', 'TICKET_TRIAGE')` (*Review Focus #2*: `OWNER` never sees `CCCD_EXTRACT` or `CONTRACT_EXTRACT`)
    - `rls_ai_suggestion_insert` & `rls_ai_suggestion_update`:
      - `(is_manager() AND org_id = get_current_user_org_id() AND (building_id IN (SELECT building_id FROM get_manager_building_ids()) OR (building_id IS NULL AND task_type IN ('CCCD_EXTRACT', 'CONTRACT_EXTRACT'))))`
      - OR `(is_org_admin() AND org_id = get_current_user_org_id() AND task_type = 'CCCD_EXTRACT')`
    - `rls_ai_suggestion_delete`: `FOR DELETE USING (FALSE)`
  - `SECURITY DEFINER` RPCs (`SET search_path = public, pg_temp SET row_security = off`, granted to `resihub_app`):
    - Updated `fn_get_ops_resource_scope(p_entity TEXT, p_id UUID)` adding `'ai_suggestion'` and `'meter'` (`JOIN apartment ON meter.apartment_id = apartment.id`) alongside existing entities.
    - `fn_get_org_monthly_ai_usage(p_org_id UUID, p_month_start TIMESTAMPTZ) RETURNS TABLE(total_calls BIGINT, total_tokens BIGINT, total_cost_vnd BIGINT)`: returns org-wide monthly token/cost totals for budget gating without cross-building blind spots.
    - `fn_record_background_ticket_triage(...) RETURNS UUID`: records async `TICKET_TRIAGE` `ai_suggestion` and updates `service_request`'s `ai_*` columns when triggered after a `RESIDENT` creates a `service_request` (without granting `RESIDENT` direct RLS access to `ai_suggestion`).
  - Additive `rls_audit_log_select_m15` on `audit_log` for `entity = 'ai_suggestion'` + `system_setting` seed for `key = 'ai_config'`.

- [ ] **Step 1: Write migration `051_m15_ai_gateway_and_suggestions.sql` and test `api/test/migration051AiGatewayRls.test.js`**

Test cases in `api/test/migration051AiGatewayRls.test.js` (using `appPool` with `SET app.current_user_id` + full `t.after` cleanup):
1. Default-deny & constraints: unset `app.current_user_id` sees `0` rows; `METER_OCR` with `building_id = NULL` fails `chk_ai_suggestion_building_scope`; `meter_reading.source` defaults to `'MANUAL'` and rejects `'UNKNOWN'`; `DELETE FROM ai_suggestion` fails/deletes `0` rows.
2. `OWNER` PII isolation (*Review Focus #2*): on owned building `VOP-A`, `OWNER` can `SELECT` `METER_OCR` and `TICKET_TRIAGE` rows (`2` rows), gets `0` rows for `CCCD_EXTRACT` and `CONTRACT_EXTRACT` on the exact same building `VOP-A`, gets `0` rows on unowned `VSC-A`, and fails `INSERT`/`UPDATE` on all `ai_suggestion` rows.
3. `MANAGER` building isolation: `MANAGER` of `VOP-A` can `INSERT`/`UPDATE`/`SELECT` all 4 task types in `VOP-A` (and `building_id = NULL` own `CCCD_EXTRACT`), fails RLS on `VOP-B`, and `fn_get_ops_resource_scope('meter', meterId)` + `fn_get_ops_resource_scope('ai_suggestion', suggestionId)` resolve `building_id` accurately.
4. `SYS_ADMIN` scope: can `INSERT` `CCCD_EXTRACT` (for tenant CRUD), is blocked from `INSERT`ing `METER_OCR` or `TICKET_TRIAGE` (`PRD 6.2` operational read-only), and can `SELECT` org-wide `ai_suggestion` rows for KPI/cost audit.
5. `RESIDENT` isolation & `fn_record_background_ticket_triage`: `RESIDENT` sees `0` rows in `ai_suggestion` directly, while `fn_record_background_ticket_triage` stamps `ai_triage_status = 'SUGGESTED'` on the resident's `NEW` `service_request` without altering `service_request.status` or `category`.

- [ ] **Step 2: Apply migration `051` and run `migration051AiGatewayRls.test.js`**

Run: `npm run migrate` then `node --test --test-concurrency=1 test/migration051AiGatewayRls.test.js` (cwd: `d:\resihub\api`)
Expected: Migration `051` applies cleanly and all 5 RLS/schema test groups PASS.

- [ ] **Step 3: Run existing RLS & schema suites to confirm zero regressions**

Run: `node --test --test-concurrency=1 test/migration050RlsAndSchema.test.js test/rbacPrdAlignment.test.js` (cwd: `d:\resihub\api`)
Expected: PASS (0 failures).

- [ ] **Step 4: Commit**

```bash
git add api/src/db/migrations/051_m15_ai_gateway_and_suggestions.sql api/test/migration051AiGatewayRls.test.js
git commit -m "feat(db): add migration 051 for ai_suggestion, meter source, ticket triage columns and RLS"
```

---

### Task 3: Gemini Server Client (`geminiClient.js`) & Transactional AI Gateway Service (`aiGateway.js`)

**Files:**
- Modify: `api/src/config/env.js`
- Modify: `api/.env.example`
- Modify: `.env.example`
- Modify: `docker-compose.yml`
- Create: `api/src/services/geminiClient.js`
- Create: `api/src/services/aiGateway.js`
- Modify: `api/src/jobs/daily.js`
- Test: `api/test/aiGatewayService.test.js`

**Interfaces:**
- Consumes: `aiRules.js` (Task 1); `ai_suggestion`, `fn_get_org_monthly_ai_usage`, `fn_record_background_ticket_triage` (Task 2).
- Produces:
  - `api/src/config/env.js`: `geminiApiKey: process.env.GEMINI_API_KEY || ''`, `geminiBaseUrl: process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta'`, `geminiTimeoutMs: Number(process.env.GEMINI_TIMEOUT_MS || 20000)`.
  - `api/src/services/geminiClient.js`:
    - `callGeminiStructured({ model, systemInstruction, userPrompt, inlineFiles = [], responseSchema, timeoutMs }) -> Promise<{ parsedJson: object, inputTokens: number, outputTokens: number, latencyMs: number, modelVersion: string }>` (sends `x-goog-api-key` header — never query param; throws structured `{ status: 503, code: 'AI_UNCONFIGURED' }`, `{ status: 504, code: 'AI_TIMEOUT' }`, or `{ status: 502, code: 'AI_UPSTREAM_ERROR' }` with redacted error messages).
    - `setGeminiTransportForTest(mockFn | null) -> void` (allows tests to intercept outbound requests and inspect URL/headers/body deterministically).
  - `api/src/services/aiGateway.js`:
    - `runExtractSuggestion(dbClient, { actorId, orgId, buildingId = null, documentType, filesBase64, privacyAcknowledged }) -> Promise<AiSuggestionResponse>` (`documentType`: `'CCCD' | 'CONTRACT'`; requires `privacyAcknowledged === true` else `422 PRIVACY_CONSENT_REQUIRED`).
    - `runMeterOcrSuggestion(dbClient, { actorId, orgId, buildingId, meterId, period, imageBase64 }) -> Promise<AiSuggestionResponse>` (queries only `meter`, `apartment.code`, and last 3 `meter_reading` values — zero `person`/`tenant` PII).
    - `runTicketTriageSuggestion(dbClient, { actorId, orgId, buildingId, serviceRequestId, useBackgroundRpc = false }) -> Promise<AiSuggestionResponse>`
    - `reviewAiSuggestion(dbClient, { suggestionId, actorId, decision, finalValues = {}, targetEntityId = null }) -> Promise<{ id: string, status: string, acceptedFieldsCount: number, totalFieldsCount: number }>`
    - `getOrgAiUsageSummary(dbClient, { orgId, buildingId = null }) -> Promise<object>` (returns monthly tokens, cost VND, budget cap, `warn_triggered`, and `G6` field/triage acceptance metrics).
  - `api/src/jobs/daily.js`: `expireStaleAiSuggestions(dbPool, { nowTs = new Date() }) -> Promise<{ expiredCount: number }>` wired into `executeDailySteps`.

- [ ] **Step 1: Write failing service tests in `api/test/aiGatewayService.test.js`**

Test cases (using `setGeminiTransportForTest` + real PostgreSQL user-scoped `appPool` client + full `t.after` cleanup):
1. **Header-only API key & missing-key guard (*Review Focus #1*):** Inspecting the intercepted request URL confirms `?key=` is absent and `headers['x-goog-api-key']` carries the test key; when `geminiApiKey` is temporarily blank, `runMeterOcrSuggestion` rejects with `code: 'AI_UNCONFIGURED'` (`503`), and simulated network failure error messages never contain the API key string.
2. **Privacy consent & PII-redacted `AI-01` persistence (`PRD 12.5`, *Review Focus #2*):** `runExtractSuggestion` with `privacyAcknowledged: false` throws `422 PRIVACY_CONSENT_REQUIRED`; with `privacyAcknowledged: true`, HTTP return payload contains extracted `{ full_name, id_number: '001099012345', dob }`, while `SELECT output FROM ai_suggestion WHERE id = $1` has masked `id_number` and `status = 'PENDING'`.
3. **Zero-PII `AI-02` prompt & zero `meter_reading` mutation (*Review Focus #4*):** Intercepted Gemini payload for `runMeterOcrSuggestion` contains meter type + previous reading (`1200`) and zero tenant name/phone/CCCD; `meter_reading` count before and after `runMeterOcrSuggestion` is identical.
4. **Kill switch, monthly budget cap & 80% `SYS_ADMIN` warning (`PRD 12.5`, `NFR-013`):** Crossing `80%` of `monthly_budget_vnd` inserts one idempotent `AI_BUDGET_WARNING` notification for `SYS_ADMIN`; reaching `100%` blocks subsequent calls with `429 AI_BUDGET_EXCEEDED`; setting `ai_config.enabled = false` blocks calls with `503 AI_DISABLED`.
5. **Acceptance diff (`G6`) & daily expiry (`PRD 4 G6`, `13.2`):** Calling `reviewAiSuggestion` with 1 edited field out of 4 sets `status = 'EDITED_ACCEPTED'`, `accepted_fields_count = 3`, `total_fields_count = 4`; backdating `expires_at` on a `PENDING` row and running `expireStaleAiSuggestions` transitions it to `'EXPIRED'`.

- [ ] **Step 2: Run `aiGatewayService.test.js` to verify it fails**

Run: `node --test --test-concurrency=1 test/aiGatewayService.test.js` (cwd: `d:\resihub\api`)
Expected: FAIL (`ERR_MODULE_NOT_FOUND` for `geminiClient.js` and `aiGateway.js`).

- [ ] **Step 3: Implement `env.js`, `.env.example`, `geminiClient.js`, `aiGateway.js`, and `expireStaleAiSuggestions` in `daily.js`**

Follow the exact Interfaces signatures, ensuring `x-goog-api-key` header usage, `AbortController` timeout cleanup in `finally`, idempotent `AI_BUDGET_WARNING` per `(org_id, YYYY-MM)`, and `getUserClient(req)` compatibility.

- [ ] **Step 4: Run `aiGatewayService.test.js` to verify all tests pass**

Run: `node --test --test-concurrency=1 test/aiGatewayService.test.js` (cwd: `d:\resihub\api`)
Expected: PASS (0 failures).

- [ ] **Step 5: Commit**

```bash
git add api/src/config/env.js api/.env.example .env.example docker-compose.yml api/src/services/geminiClient.js api/src/services/aiGateway.js api/src/jobs/daily.js api/test/aiGatewayService.test.js
git commit -m "feat(m15): add Gemini REST client, AI gateway orchestrator, budget guard and expiry job"
```

---

### Task 4: Express `/api/v1/ai` Routes & Human-Confirmation Hooks in Existing Workflows

**Files:**
- Create: `api/src/routes/ai.js`
- Modify: `api/src/middleware/rateLimiter.js`
- Modify: `api/src/routes/settings.js`
- Modify: `api/src/routes/meters.js`
- Modify: `api/src/routes/service-requests.js`
- Modify: `api/src/routes/resident.js`
- Modify: `api/src/routes/tenants.js`
- Modify: `api/src/routes/contracts.js`
- Modify: `api/src/server.js`
- Test: `api/test/m15AiEndpointsAndWorkflows.test.js`

**Interfaces:**
- Consumes: `aiGateway.js` & `geminiClient.js` (Task 3); `normalizeAiConfig` (Task 1); migration `051` columns & RPCs (Task 2).
- Produces:
  - `api/src/middleware/rateLimiter.js`: `aiRateLimiter` (`20` requests / `60s` per authenticated user in prod, bypass/high cap in test unless `x-test-rate-limit: 1`).
  - `api/src/routes/ai.js` mounted at `/api/v1/ai`:
    - `POST /api/v1/ai/extract`: `requireRole(['SYS_ADMIN', 'MANAGER'])` + `aiRateLimiter` + `idempotencyGuard()`; `{ document_type: 'CCCD' | 'CONTRACT', building_id?, files: string[], privacy_acknowledged: boolean }` (`SYS_ADMIN` restricted to `CCCD` -> `403` on `CONTRACT`); enforces `403 ACCESS_DENIED` + `audit_log` on out-of-scope `building_id`.
    - `POST /api/v1/ai/meter-ocr`: `requireRole(['MANAGER'])` + `aiRateLimiter` + `idempotencyGuard()`; `{ meter_id, period?, image_base64 }`; resolves building via `fn_get_ops_resource_scope('meter', meter_id)` (`404` vs `403 ACCESS_DENIED`).
    - `POST /api/v1/ai/classify`: `requireRole(['MANAGER'])` + `aiRateLimiter` + `idempotencyGuard()`; `{ service_request_id }`; resolves building via `fn_get_ops_resource_scope('service_request', service_request_id)` (`404` vs `403 ACCESS_DENIED`).
    - `POST /api/v1/ai/suggestions/:id/review`: `requireRole(['SYS_ADMIN', 'MANAGER'])` + `idempotencyGuard()`; `{ decision: 'ACCEPT' | 'REJECT', final_values?, target_entity_id? }`.
    - `GET /api/v1/ai/usage`: `requireRole(['SYS_ADMIN', 'OWNER', 'MANAGER'])`; returns monthly token/VND usage vs cap + `G6` acceptance rates scoped to caller's role/buildings.
  - Confirmation & Triage Hooks:
    - `settings.js`: `GET /api/v1/settings` includes `ai_runtime: { api_key_configured: Boolean(env.geminiApiKey) }`; `PUT /api/v1/settings` validates `ai_config` via `normalizeAiConfig`.
    - `meters.js`: `POST /api/v1/meters/:id/readings` and `POST /api/v1/meters/readings/batch` accept optional `ai_suggestion_id`; when provided, persist `source = 'AI'` + `ai_suggestion_id` on `meter_reading` and finalize `reviewAiSuggestion` (`ACCEPTED` / `EDITED_ACCEPTED`) in the same user-scoped transaction (defaulting `source = 'MANUAL'` when omitted).
    - `resident.js` & `service-requests.js`:
      - `POST /api/v1/resident/service-requests` and `POST /api/v1/service-requests`: trigger non-blocking background `AI-03` triage after commit (`await flushPendingAiTasksForTest()` helper exported from `aiGateway.js` so integration tests can deterministically await background completion without `sleep`!).
      - `GET /api/v1/service-requests` & `GET /api/v1/service-requests/:id`: return `ai_suggestion_id`, `ai_triage_status`, `ai_summary`, `ai_suggested_category`, `ai_suggested_priority`, `ai_suggested_assignee_id`, `ai_suggested_assignee_name`, `ai_confidence` (while `GET /api/v1/resident/service-requests` continues omitting all internal `ai_*` fields).
      - `POST /api/v1/service-requests/:id/apply-triage` (`requireRole(['MANAGER'])` + `idempotencyGuard()`): `{ category?, priority?, assigned_to? }` applies or overrides the AI triage suggestion in 1 click (`AC-011.1`), recomputes `sla_due_at` if `priority` changes to/from `URGENT`, transitions `NEW -> ASSIGNED` when `assigned_to` is provided (stamping `first_responded_at`), updates `ai_triage_status` (`ACCEPTED` if unchanged vs `OVERRIDDEN`), and finalizes `ai_suggestion`.
    - `tenants.js` (`POST /`, `PUT /:id`) & `contracts.js` (`POST /`): accept optional `ai_suggestion_id` and call `reviewAiSuggestion` inside the save transaction to link `target_entity_id` and record field-level acceptance for KPI `G6`.

- [ ] **Step 1: Write failing integration test `api/test/m15AiEndpointsAndWorkflows.test.js`**

Test cases (isolated temp records + `setGeminiTransportForTest` + `flushPendingAiTasksForTest` + full `t.after` cleanup):
1. **AI-01 CCCD & Contract PDF Extract -> Human Edit -> Save (`FR-059`, `PRD 4 G6`):**
   - `MANAGER` calls `POST /api/v1/ai/extract` (`document_type: 'CCCD'`, `privacy_acknowledged: true`) -> `200`, `person` count unchanged; `MANAGER` edits `dob` and calls `POST /api/v1/tenants` with `ai_suggestion_id` -> `201`, `ai_suggestion` transitions to `EDITED_ACCEPTED` with `target_entity_id = newTenant.id`.
   - `MANAGER` calls `POST /api/v1/ai/extract` (`document_type: 'CONTRACT'`, valid `%PDF-1.4` base64, `privacy_acknowledged: true`) -> `200` with draft fields, `contract` count unchanged until `POST /api/v1/contracts` is called with `ai_suggestion_id`.
2. **AI-02 Meter OCR Blurry (`AC-014.1`) vs Valid (`AC-014.2`) -> Batch Confirm (*Review Focus #4*):**
   - Blurry mock (`confidence: 0.45`) -> `POST /api/v1/ai/meter-ocr` returns `200` with `output.reading === null, needs_human_review === true`, `meter_reading` unchanged.
   - Readable mock (`reading: 1350, confidence: 0.96`) -> returns `output.reading === 1350`, `meter_reading` still unchanged (`0` new rows); `MANAGER` then calls `POST /api/v1/meters/readings/batch` with `{ meter_id, reading_value: 1350, ai_suggestion_id }` -> `meter_reading` persisted with `source === 'AI'` and `ai_suggestion.status === 'ACCEPTED'`.
3. **AI-03 Async Resident Triage, Timeout Resilience & 1-Click Manager Apply/Override (`AC-011.1`, `AC-011.2`, *Review Focus #3 & #5*):**
   - Resident submits `"Vòi nước bồn rửa rỉ mạnh"` -> `201` immediately (`status === 'NEW'`); after `flushPendingAiTasksForTest()`, `GET /api/v1/service-requests/:id` (`MANAGER`) shows `ai_triage_status === 'SUGGESTED'`, `ai_suggested_category === 'PLUMBING'`, while `GET /api/v1/resident/service-requests` (`RESIDENT`) does not leak `ai_*` fields.
   - `MANAGER` calls `POST /api/v1/service-requests/:id/apply-triage` overriding `priority: 'URGENT'` -> `sla_due_at` shortens to `4h`, `ai_triage_status === 'OVERRIDDEN'`, `ai_suggestion.status === 'EDITED_ACCEPTED'`.
   - Simulating a Gemini timeout (`AbortError`) during another Resident `POST /api/v1/resident/service-requests` still returns `201` immediately and stamps `ai_triage_status === 'FAILED'` asynchronously without breaking the queue (*Review Focus #5*).
4. **4-Role RBAC, Cross-Building `403` & Settings Secret Hygiene (*Review Focus #1*):**
   - `OWNER` and `RESIDENT` receive `403` on `/api/v1/ai/extract`, `/api/v1/ai/meter-ocr`, and `/api/v1/ai/classify`.
   - `MANAGER` of `VOP-A` calling `/api/v1/ai/meter-ocr` or `/api/v1/ai/classify` on `VOP-B` resources receives `403 ACCESS_DENIED` + `audit_log`.
   - `GET /api/v1/settings` returns `ai_runtime.api_key_configured` boolean and never contains `GEMINI_API_KEY`.

- [ ] **Step 2: Run `m15AiEndpointsAndWorkflows.test.js` to verify it fails**

Run: `node --test --test-concurrency=1 test/m15AiEndpointsAndWorkflows.test.js` (cwd: `d:\resihub\api`)
Expected: FAIL (`404` on `/api/v1/ai/*` and `/apply-triage`).

- [ ] **Step 3: Implement `ai.js` and wire confirmation/triage hooks across `rateLimiter.js`, `settings.js`, `meters.js`, `service-requests.js`, `resident.js`, `tenants.js`, `contracts.js`, and `server.js`**

Preserve 100% backward compatibility whenever `ai_suggestion_id` is omitted so all Weeks 1–6 endpoints and tests behave identically.

- [ ] **Step 4: Run M15 integration suite + core meter/service-request/tenant/contract regression suites**

Run: `node --test --test-concurrency=1 test/m15AiEndpointsAndWorkflows.test.js test/m08MeterLifecycleAndAnomaly.test.js test/m11ResidentBreakdownAndSlaFlow.test.js test/residentOnboardingFlow.test.js` (cwd: `d:\resihub\api`)
Expected: PASS (0 failures).

- [ ] **Step 5: Commit**

```bash
git add api/src/routes/ai.js api/src/middleware/rateLimiter.js api/src/routes/settings.js api/src/routes/meters.js api/src/routes/service-requests.js api/src/routes/resident.js api/src/routes/tenants.js api/src/routes/contracts.js api/src/server.js api/test/m15AiEndpointsAndWorkflows.test.js
git commit -m "feat(api): add /api/v1/ai gateway routes and human-confirmation hooks for M04, M05, M08 and M11"
```

---

### Task 5: Frontend `AISuggestionField`, Dual Settings `AiGatewayConfigCard` & Admin UI Integration

**Files:**
- Create: `frontend/src/utils/aiHelpers.js`
- Create: `frontend/src/services/ai.service.js`
- Create: `frontend/src/components/ui/AISuggestionField.jsx`
- Create: `frontend/src/components/settings/AiGatewayConfigCard.jsx`
- Modify: `frontend/src/services/serviceRequests.service.js`
- Modify: `frontend/src/pages/admin/settings/SettingsPage.jsx`
- Modify: `frontend/src/pages/admin/users/UsersPage.jsx`
- Modify: `frontend/src/pages/admin/tenants/TenantsPage.jsx`
- Modify: `frontend/src/pages/admin/tenants/TenantDetailPage.jsx`
- Modify: `frontend/src/pages/admin/contracts/ContractsPage.jsx`
- Modify: `frontend/src/pages/admin/meters/MeterReadingsPage.jsx`
- Modify: `frontend/src/pages/admin/maintenance/ServiceRequestsPage.jsx`
- Test: `api/test/frontendWeek7AiHelpers.test.js`

**Interfaces:**
- Consumes: `/api/v1/ai/*`, `/api/v1/settings`, `/api/v1/meters/*`, `/api/v1/service-requests/:id/apply-triage`, `/api/v1/tenants`, `/api/v1/contracts` from Task 4.
- Produces:
  - `frontend/src/utils/aiHelpers.js`:
    - `formatConfidenceBadge(confidence, threshold = 0.75) -> { percentText: string, tone: 'emerald' | 'amber' | 'rose', label: string, isUncertain: boolean }`
    - `mapAiErrorToVietnamese(error) -> { title: string, guidance: string, canManualFallback: boolean }` (`AI_DISABLED`, `AI_TASK_DISABLED`, `AI_BUDGET_EXCEEDED`, `AI_UNCONFIGURED`, `AI_TIMEOUT`, `PRIVACY_CONSENT_REQUIRED`)
    - `createAiFieldTracker(suggestionId, suggestedMap, fieldConfidences = {}) -> object` + `markFieldConfirmedOrEdited(tracker, fieldKey, newValue) -> object`
    - `compressImageFileToDataUri(file, { maxDimension = 1600, quality = 0.82 }) -> Promise<string>` (passes PDFs through unchanged via `fileToBase64`, downscales large camera photos on `<canvas>` in browser).
  - `frontend/src/services/ai.service.js`: `extractDocument`, `ocrMeterReading`, `classifyServiceRequest`, `reviewSuggestion`, `getUsageSummary` (mutations wrapped with `withIdempotency`); `serviceRequests.service.js`: add `applyTriage(id, payload)`.
  - `frontend/src/components/ui/AISuggestionField.jsx`:
    - Props: `{ active, confirmed, confidence, threshold, warningText, onConfirm, onDismiss, children }` — renders `border-dashed border-amber-400 bg-amber-50/50` when `active && !confirmed`, `"AI đề xuất"` badge (`Sparkles` Lucide icon) + confidence `%`, `aria-live="polite"`, and `"Xác nhận"` / `"Xóa gợi ý"` buttons (`PRD 16.2` & `16.5`).
  - `frontend/src/components/settings/AiGatewayConfigCard.jsx`:
    - Shared configuration + usage/KPI panel embedded in **both** `SettingsPage.jsx` and `UsersPage.jsx` (`activeTab === 'settings'`), editable only by `SYS_ADMIN` (`usePermission`).

- [ ] **Step 1: Write failing Frontend helper tests in `api/test/frontendWeek7AiHelpers.test.js`**

Test `formatConfidenceBadge` (`0.92` -> `92%` emerald, `0.76` -> `76%` amber, `0.55` -> uncertain rose), `mapAiErrorToVietnamese` (all 6 AI error codes produce clear non-blaming Vietnamese recovery guidance per `PRD 16.2`), and `createAiFieldTracker` / `markFieldConfirmedOrEdited` state transitions.

- [ ] **Step 2: Run `frontendWeek7AiHelpers.test.js` to verify it fails**

Run: `node --test --test-concurrency=1 test/frontendWeek7AiHelpers.test.js` (cwd: `d:\resihub\api`)
Expected: FAIL (`ERR_MODULE_NOT_FOUND` for `frontend/src/utils/aiHelpers.js`).

- [ ] **Step 3: Implement `aiHelpers.js`, `ai.service.js`, `AISuggestionField.jsx`, `AiGatewayConfigCard.jsx`, and wire AI-01, AI-02, AI-03 into Admin pages**

- **Dual Settings (`SettingsPage.jsx` & `UsersPage.jsx`):** Render `<AiGatewayConfigCard />` showing server key connection badge (`ai_runtime.api_key_configured`), master Kill Switch, 4 task switches, confidence thresholds, monthly budget/token bar (amber/rose alert at `>= 80%`), and live `G6` acceptance KPIs.
- **AI-01 (`TenantsPage.jsx`, `TenantDetailPage.jsx`, `ContractsPage.jsx`):**
  - In Tenant create/edit modals (and inline tenant creation inside `ContractsPage.jsx`): add privacy processing acknowledgement checkbox + **"Trích xuất từ ảnh CCCD (AI)"** button when CCCD image(s) are uploaded; wrap `full_name`, `id_number`, `dob`, and `note` in `<AISuggestionField />`; attach `ai_suggestion_id` on save.
  - In `ContractsPage.jsx` Create Draft modal: add **"Quét hợp đồng giấy / PDF bằng AI"** uploader (`accept="image/jpeg,image/png,application/pdf"`, `maxSizeMB={10}`) + privacy checkbox -> pre-fills draft `start_date`, `end_date`, `rent_amount`, `deposit_amount`, `billing_day`, `payment_due_days`, `note` (and matched apartment/tenant hints) inside `<AISuggestionField />`; pass `ai_suggestion_id` on `POST /api/v1/contracts`.
- **AI-02 (`MeterReadingsPage.jsx`):**
  - Add inline **"Ảnh AI"** camera button per row in the batch reading table and **"Đọc chỉ số bằng AI"** in the Single Meter Detail modal (visible only when `canRecordMeters` is true).
  - On `reading === null` (`AC-014.1`): keep input blank and display warning `"AI không chắc chắn do ảnh mờ/lóa — vui lòng nhập tay"`.
  - On valid reading (`AC-014.2`): populate draft input wrapped in `<AISuggestionField />` (`Chờ xác nhận`) + display post-check warnings (`< kỳ trước` / `bất thường`), sending `ai_suggestion_id` only when `MANAGER` clicks **"Lưu nháp"** / **"Chốt chỉ số"**.
- **AI-03 (`ServiceRequestsPage.jsx`):**
  - Show `"AI đề xuất"` / `"Cần phân loại thủ công"` (`AC-011.2`) pills on cards/table rows.
  - In the Detail Drawer (mutation buttons gated by `canHandleMaintenance` so `OWNER` & `SYS_ADMIN` remain strictly Read-Only): display the AI Triage card (`ai_summary`, suggested category, priority, suggested assignee, confidence `%`) with 1-click **"Áp dụng đề xuất AI"** (`AC-011.1`), **"Chạy lại phân loại AI"**, and inline override controls calling `serviceRequestsService.applyTriage`.

- [ ] **Step 4: Run Frontend helper tests, Vite production build, and the full Backend test suite**

Run 1: `node --test --test-concurrency=1 test/frontendWeek7AiHelpers.test.js test/week7AiRulesUnit.test.js` (cwd: `d:\resihub\api`)
Run 2: `npm run build` (cwd: `d:\resihub\frontend`)
Run 3: `npm test` (cwd: `d:\resihub\api`)
Expected: All unit tests PASS, `vite build` succeeds with 0 errors, and 100% of backend test suites (including `migration051AiGatewayRls.test.js`, `aiGatewayService.test.js`, `m15AiEndpointsAndWorkflows.test.js`, `rbacPrdAlignment.test.js`, and `fullWebsiteWhiteBlackBox.test.js`) PASS with zero leaked test rows.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/utils/aiHelpers.js frontend/src/services/ai.service.js frontend/src/components/ui/AISuggestionField.jsx frontend/src/components/settings/AiGatewayConfigCard.jsx frontend/src/services/serviceRequests.service.js frontend/src/pages/admin/settings/SettingsPage.jsx frontend/src/pages/admin/users/UsersPage.jsx frontend/src/pages/admin/tenants/TenantsPage.jsx frontend/src/pages/admin/tenants/TenantDetailPage.jsx frontend/src/pages/admin/contracts/ContractsPage.jsx frontend/src/pages/admin/meters/MeterReadingsPage.jsx frontend/src/pages/admin/maintenance/ServiceRequestsPage.jsx api/test/frontendWeek7AiHelpers.test.js
git commit -m "feat(ui): add AISuggestionField, AI Gateway settings card and Admin AI-01/02/03 workflows"
```
