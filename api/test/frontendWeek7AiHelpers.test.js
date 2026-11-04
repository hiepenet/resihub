import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_AI_CONFIG,
  mergeAiConfigState,
  getAiTriageBadgeMeta,
  canOneClickApplyAiTriage,
  formatConfidenceBadge,
  mapAiErrorToVietnamese,
  createAiFieldTracker,
  markFieldConfirmedOrEdited,
  compressImageFileToDataUri,
} from '../../frontend/src/utils/aiHelpers.js';

test('Task 5.1: formatConfidenceBadge formats percentage and classifies emerald / amber / rose tones', () => {
  const high = formatConfidenceBadge(0.92, 0.75);
  assert.equal(high.percentText, '92%');
  assert.equal(high.tone, 'emerald');
  assert.equal(high.isUncertain, false);

  const mid = formatConfidenceBadge(0.76, 0.75);
  assert.equal(mid.percentText, '76%');
  assert.equal(mid.tone, 'amber');
  assert.equal(mid.isUncertain, false);

  const low = formatConfidenceBadge(0.55, 0.75);
  assert.equal(low.percentText, '55%');
  assert.equal(low.tone, 'rose');
  assert.equal(low.isUncertain, true);

  const missing = formatConfidenceBadge(null, 0.75);
  assert.equal(missing.percentText, '0%');
  assert.equal(missing.isUncertain, true);
});

test('Task 5.2: mapAiErrorToVietnamese covers all 6 AI Gateway error codes with non-blaming Vietnamese guidance (PRD 16.2)', () => {
  const codes = [
    'AI_DISABLED',
    'AI_TASK_DISABLED',
    'AI_BUDGET_EXCEEDED',
    'AI_UNCONFIGURED',
    'AI_TIMEOUT',
    'PRIVACY_CONSENT_REQUIRED',
  ];

  for (const code of codes) {
    const mapped = mapAiErrorToVietnamese({
      response: { data: { code, message: `Server message for ${code}` } },
    });
    assert.ok(mapped.title && mapped.title.length > 5, `${code} must return Vietnamese title`);
    assert.ok(mapped.guidance && mapped.guidance.length > 10, `${code} must return clear guidance`);
    assert.equal(typeof mapped.canManualFallback, 'boolean');
  }

  const consentErr = mapAiErrorToVietnamese({ code: 'PRIVACY_CONSENT_REQUIRED' });
  assert.equal(consentErr.canManualFallback, false);

  const timeoutErr = mapAiErrorToVietnamese({ code: 'AI_TIMEOUT' });
  assert.equal(timeoutErr.canManualFallback, true);
});

test('Task 5.3: createAiFieldTracker & markFieldConfirmedOrEdited track AI suggested vs confirmed vs edited fields', () => {
  const tracker = createAiFieldTracker(
    '11111111-2222-3333-4444-555555555555',
    {
      full_name: 'Nguyễn Văn A',
      id_number: '079201001234',
      dob: '1995-05-15',
    },
    {
      full_name: 0.97,
      id_number: 0.95,
      dob: 0.71,
    }
  );

  assert.equal(tracker.suggestionId, '11111111-2222-3333-4444-555555555555');
  assert.equal(tracker.fields.full_name.active, true);
  assert.equal(tracker.fields.full_name.confirmed, false);
  assert.equal(tracker.fields.dob.confidence, 0.71);

  // Confirm without change
  const afterConfirm = markFieldConfirmedOrEdited(tracker, 'full_name', 'Nguyễn Văn A');
  assert.equal(afterConfirm.fields.full_name.confirmed, true);
  assert.equal(afterConfirm.fields.full_name.edited, false);

  // Edit value -> marks confirmed + edited
  const afterEdit = markFieldConfirmedOrEdited(afterConfirm, 'dob', '1995-05-20');
  assert.equal(afterEdit.fields.dob.confirmed, true);
  assert.equal(afterEdit.fields.dob.edited, true);
});

test('Task 5.4: compressImageFileToDataUri passes PDF data URI / buffer through unchanged in non-DOM environment', async () => {
  const pdfBytes = new Uint8Array(Buffer.from('%PDF-1.4 mock', 'utf8'));
  const fakePdfFile = {
    type: 'application/pdf',
    name: 'contract.pdf',
    arrayBuffer: async () => pdfBytes.buffer,
  };
  const dataUri = await compressImageFileToDataUri(fakePdfFile);
  assert.ok(dataUri.startsWith('data:application/pdf;base64,'));
});

test('Final Review Fix #1 & #2 & Important #2: AI triage enum helpers and DEFAULT_AI_CONFIG / mergeAiConfigState match backend schema', () => {
  // Important #2: exact parity with migration 051 & backend DEFAULT_AI_CONFIG
  assert.equal(DEFAULT_AI_CONFIG.model, 'gemini-3.8-flash');
  assert.equal(DEFAULT_AI_CONFIG.monthly_budget_vnd, 500000);
  assert.equal(DEFAULT_AI_CONFIG.monthly_token_limit, 2000000);
  assert.equal(DEFAULT_AI_CONFIG.ocr_threshold, 0.8);
  assert.equal(DEFAULT_AI_CONFIG.triage_threshold, 0.7);
  assert.equal(DEFAULT_AI_CONFIG.extract_threshold, 0.75);

  // Deprecated legacy model slugs auto-upgrade in UI state hydration
  assert.equal(mergeAiConfigState({ model: 'gemini-2.5-pro' }).model, 'gemini-3.8-flash');
  assert.equal(mergeAiConfigState({ model: 'gemini-2.5-flash' }).model, 'gemini-3.8-flash');
  assert.equal(mergeAiConfigState({ model: 'gemini-3.1-flash-lite' }).model, 'gemini-3.1-flash-lite');

  // Critical #2: mergeAiConfigState hydrates flat DB columns into UI state
  const hydrated = mergeAiConfigState({
    enabled: true,
    cccd_extract_enabled: false,
    contract_extract_enabled: true,
    meter_ocr_enabled: false,
    ticket_triage_enabled: true,
    meter_ocr_threshold: 0.92,
    confidence_threshold: 0.81,
    triage_threshold: 0.73,
  });
  assert.equal(hydrated.tasks.cccd_extract, false);
  assert.equal(hydrated.tasks.meter_ocr, false);
  assert.equal(hydrated.ocr_threshold, 0.92);
  assert.equal(hydrated.extract_threshold, 0.81);
  assert.equal(hydrated.triage_threshold, 0.73);

  // Critical #1: getAiTriageBadgeMeta & canOneClickApplyAiTriage recognize DB enums NEEDS_MANUAL_REVIEW and ACCEPTED
  const manualMeta = getAiTriageBadgeMeta('NEEDS_MANUAL_REVIEW');
  assert.equal(manualMeta?.variant, 'red');
  assert.equal(manualMeta?.needsManualWarning, true);

  const acceptedMeta = getAiTriageBadgeMeta('ACCEPTED');
  assert.equal(acceptedMeta?.variant, 'emerald');
  assert.equal(
    canOneClickApplyAiTriage({
      ai_suggested_category: 'PLUMBING',
      ai_suggested_priority: 'HIGH',
      ai_triage_status: 'ACCEPTED',
    }),
    false
  );
  assert.equal(
    canOneClickApplyAiTriage({
      ai_suggested_category: 'PLUMBING',
      ai_suggested_priority: 'HIGH',
      ai_triage_status: 'SUGGESTED',
    }),
    true
  );
});

