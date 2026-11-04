import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pg from 'pg';
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';

dotenv.config({ path: fileURLToPath(new URL('../.env', import.meta.url)) });
dotenv.config();

if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = 'postgres://postgres:postgres@127.0.0.1:5433/resihub';
}
if (!process.env.APP_DATABASE_URL) {
  process.env.APP_DATABASE_URL =
    'postgres://resihub_app:resihub_app_secret@127.0.0.1:5433/resihub';
}

import {
  callGeminiStructured,
  setGeminiTransportForTest,
  setGeminiApiKeyOverrideForTest,
} from '../src/services/geminiClient.js';
import {
  runExtractSuggestion,
  runMeterOcrSuggestion,
  runTicketTriageSuggestion,
  reviewAiSuggestion,
  getOrgAiUsageSummary,
} from '../src/services/aiGateway.js';
import { expireStaleAiSuggestions } from '../src/jobs/daily.js';
import { adminPool, appPool } from '../src/db/client.js';

const TINY_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

async function withUserClient(userId, fn) {
  const client = await appPool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.current_user_id', $1, true)", [String(userId)]);
    const res = await fn(client);
    await client.query('COMMIT');
    return res;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

test('Task 3: geminiClient & aiGateway enforce header-only key, PII redaction, budget guard, G6 diff & expiry', async (t) => {
  const cleanup = {
    suggestionIds: [],
    notificationIds: [],
    auditIds: [],
  };
  let savedAiConfig = null;
  let orgId = null;

  t.after(async () => {
    setGeminiTransportForTest(null);
    setGeminiApiKeyOverrideForTest(null);
    if (orgId && savedAiConfig) {
      await adminPool
        .query(`UPDATE system_setting SET value = $1 WHERE org_id = $2 AND key = 'ai_config'`, [
          JSON.stringify(savedAiConfig),
          orgId,
        ])
        .catch(() => {});
    }
    for (const id of cleanup.notificationIds) {
      await adminPool.query('DELETE FROM notification WHERE id = $1', [id]).catch(() => {});
    }
    for (const id of cleanup.auditIds) {
      await adminPool.query('DELETE FROM audit_log WHERE id = $1', [id]).catch(() => {});
    }
    for (const id of cleanup.suggestionIds) {
      await adminPool.query('DELETE FROM audit_log WHERE entity = \'ai_suggestion\' AND entity_id = $1', [id]).catch(() => {});
      await adminPool.query('DELETE FROM ai_suggestion WHERE id = $1', [id]).catch(() => {});
    }
    await appPool.end().catch(() => {});
    await adminPool.end().catch(() => {});
  });

  const vopARes = await adminPool.query(`SELECT id, org_id FROM building WHERE code = 'VOP-A' LIMIT 1`);
  const vopAId = vopARes.rows[0].id;
  orgId = vopARes.rows[0].org_id;

  const cfgRes = await adminPool.query(
    `SELECT value FROM system_setting WHERE org_id = $1 AND key = 'ai_config' LIMIT 1`,
    [orgId]
  );
  savedAiConfig = cfgRes.rows[0]?.value || null;

  await adminPool.query(
    `INSERT INTO system_setting (org_id, key, value)
     VALUES ($1, 'ai_config', $2::jsonb)
     ON CONFLICT (org_id, key) DO UPDATE SET value = EXCLUDED.value`,
    [
      orgId,
      JSON.stringify({
        enabled: true,
        model: 'gemini-3.8-flash',
        ocr_threshold: 0.8,
        extract_threshold: 0.75,
        triage_threshold: 0.7,
        monthly_budget_vnd: 500000,
        monthly_token_limit: 2000000,
        warn_percent: 80,
        suggestion_ttl_hours: 72,
      }),
    ]
  );

  const mgrRes = await adminPool.query(`
    SELECT au.id FROM app_user au
    JOIN person p ON p.id = au.person_id
    WHERE p.email = 'manager.vop.a@resihub.vn' AND au.status = 'ACTIVE'
    LIMIT 1
  `);
  const mgrVopAId = mgrRes.rows[0].id;

  const meterRes = await adminPool.query(
    `SELECT m.id, m.meter_code, m.meter_type, p.full_name AS tenant_name, p.phone AS tenant_phone
     FROM meter m
     LEFT JOIN contract c ON c.apartment_id = m.apartment_id AND c.status = 'ACTIVE'
     LEFT JOIN tenant t ON t.id = c.primary_tenant_id
     LEFT JOIN person p ON p.id = t.person_id
     WHERE m.building_id = $1
     LIMIT 1`,
    [vopAId]
  );
  const meter = meterRes.rows[0];

  // 1. Header-only API key & missing-key guard (Review Focus #1)
  setGeminiApiKeyOverrideForTest('');
  await assert.rejects(
    () =>
      callGeminiStructured({
        model: 'gemini-2.5-flash',
        systemInstruction: 'sys',
        userPrompt: 'usr',
        responseSchema: { type: 'OBJECT', properties: { ok: { type: 'BOOLEAN' } } },
      }),
    (err) => err.status === 503 && err.code === 'AI_UNCONFIGURED'
  );

  const secretTestKey = 'AIzaSy_SECRET_NEVER_IN_URL_998877';
  setGeminiApiKeyOverrideForTest(secretTestKey);
  let capturedReq = null;

  setGeminiTransportForTest(async (url, init) => {
    capturedReq = { url, init };
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          modelVersion: 'gemini-2.5-flash-001',
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      full_name: 'Trần Thị Bích',
                      id_number: '001198004567',
                      dob: '1998-10-12',
                      issue_date: '2022-05-01',
                      permanent_address: 'Cầu Giấy, Hà Nội',
                      confidence: 0.96,
                      field_confidences: {
                        full_name: 0.98,
                        id_number: 0.97,
                        dob: 0.94,
                      },
                    }),
                  },
                ],
              },
            },
          ],
          usageMetadata: { promptTokenCount: 400, candidatesTokenCount: 80 },
        };
      },
    };
  });

  // 2. Privacy consent & PII-redacted AI-01 persistence (PRD 12.5, Review Focus #2)
  await assert.rejects(
    () =>
      withUserClient(mgrVopAId, (client) =>
        runExtractSuggestion(client, {
          actorId: mgrVopAId,
          orgId,
          buildingId: vopAId,
          documentType: 'CCCD',
          filesBase64: [TINY_PNG],
          privacyAcknowledged: false,
        })
      ),
    (err) => err.status === 422 && err.code === 'PRIVACY_CONSENT_REQUIRED'
  );

  const cccdRes = await withUserClient(mgrVopAId, (client) =>
    runExtractSuggestion(client, {
      actorId: mgrVopAId,
      orgId,
      buildingId: vopAId,
      documentType: 'CCCD',
      filesBase64: [TINY_PNG],
      privacyAcknowledged: true,
    })
  );
  cleanup.suggestionIds.push(cccdRes.suggestion_id);

  assert.equal(capturedReq.url.includes('key='), false, 'API key must NEVER be in URL query');
  assert.equal(capturedReq.init.headers['x-goog-api-key'], secretTestKey);
  assert.equal(cccdRes.output.id_number, '001198004567');

  const dbCccdRow = await adminPool.query(
    `SELECT output, status FROM ai_suggestion WHERE id = $1`,
    [cccdRes.suggestion_id]
  );
  assert.equal(dbCccdRow.rows[0].status, 'PENDING');
  assert.equal(
    JSON.stringify(dbCccdRow.rows[0].output).includes('001198004567'),
    false,
    'Raw CCCD number must be masked before storing in ai_suggestion.output'
  );

  // Simulated upstream failure must never leak secretTestKey in error message
  setGeminiTransportForTest(async () => {
    throw new Error(`Upstream socket reset for ${secretTestKey}`);
  });
  await assert.rejects(
    () =>
      callGeminiStructured({
        model: 'gemini-2.5-flash',
        systemInstruction: 'sys',
        userPrompt: 'usr',
        responseSchema: { type: 'OBJECT', properties: { ok: { type: 'BOOLEAN' } } },
      }),
    (err) => err.code === 'AI_UPSTREAM_ERROR' && !err.message.includes(secretTestKey)
  );

  // 3. Zero-PII AI-02 prompt & zero meter_reading mutation (Review Focus #4)
  let meterPromptBody = '';
  setGeminiTransportForTest(async (_url, init) => {
    meterPromptBody = String(init.body || '');
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          candidates: [
            {
              content: {
                parts: [{ text: JSON.stringify({ reading: 9876, confidence: 0.94, reason: 'Rõ nét' }) }],
              },
            },
          ],
          usageMetadata: { promptTokenCount: 300, candidatesTokenCount: 40 },
        };
      },
    };
  });

  const beforeReadingsCount = await adminPool.query(`SELECT COUNT(*)::int AS cnt FROM meter_reading WHERE meter_id = $1`, [
    meter.id,
  ]);
  const ocrRes = await withUserClient(mgrVopAId, (client) =>
    runMeterOcrSuggestion(client, {
      actorId: mgrVopAId,
      orgId,
      buildingId: vopAId,
      meterId: meter.id,
      period: '2099-11',
      imageBase64: TINY_PNG,
    })
  );
  cleanup.suggestionIds.push(ocrRes.suggestion_id);
  const afterReadingsCount = await adminPool.query(`SELECT COUNT(*)::int AS cnt FROM meter_reading WHERE meter_id = $1`, [
    meter.id,
  ]);

  assert.equal(afterReadingsCount.rows[0].cnt, beforeReadingsCount.rows[0].cnt, 'AI-02 must never write meter_reading');
  assert.equal(ocrRes.output.reading, 9876);
  if (meter.tenant_name) {
    assert.equal(meterPromptBody.includes(meter.tenant_name), false, 'Tenant name must not be sent to Gemini');
  }
  if (meter.tenant_phone) {
    assert.equal(meterPromptBody.includes(meter.tenant_phone), false, 'Tenant phone must not be sent to Gemini');
  }

  // 4. Acceptance diff (G6) & daily expiry (PRD 4 G6, 13.2)
  const reviewed = await withUserClient(mgrVopAId, (client) =>
    reviewAiSuggestion(client, {
      suggestionId: cccdRes.suggestion_id,
      actorId: mgrVopAId,
      decision: 'ACCEPT',
      finalValues: {
        full_name: 'Trần Thị Bích',
        id_number: '001198004567',
        dob: '1998-10-15', // edited 1 field!
        issue_date: '2022-05-01',
        permanent_address: 'Cầu Giấy, Hà Nội',
      },
    })
  );
  assert.equal(reviewed.status, 'EDITED_ACCEPTED');
  assert.equal(reviewed.acceptedFieldsCount, 4);
  assert.equal(reviewed.totalFieldsCount, 5);

  await adminPool.query(
    `UPDATE ai_suggestion SET expires_at = NOW() - INTERVAL '2 hours' WHERE id = $1`,
    [ocrRes.suggestion_id]
  );
  const expSummary = await expireStaleAiSuggestions(adminPool);
  assert.ok(expSummary.expiredCount >= 1);
  const expCheck = await adminPool.query(`SELECT status FROM ai_suggestion WHERE id = $1`, [
    ocrRes.suggestion_id,
  ]);
  assert.equal(expCheck.rows[0].status, 'EXPIRED');

  // 5. Kill switch, 80% warning notification & 100% budget cap (PRD 12.5, NFR-013)
  const usageBefore = await withUserClient(mgrVopAId, (client) =>
    getOrgAiUsageSummary(client, { orgId, buildingId: vopAId })
  );
  const currentCost = Number(usageBefore.monthly_cost_vnd || 0);

  // Set budget so currentCost is ~85% of cap -> next call triggers 80% warning!
  const warnCap = Math.max(20, Math.ceil((currentCost + 2) / 0.85));
  await adminPool.query(
    `UPDATE system_setting
     SET value = COALESCE(value, '{}'::jsonb) || jsonb_build_object('monthly_budget_vnd', $1::int, 'enabled', true)
     WHERE org_id = $2 AND key = 'ai_config'`,
    [warnCap, orgId]
  );

  const warnCall = await withUserClient(mgrVopAId, (client) =>
    runMeterOcrSuggestion(client, {
      actorId: mgrVopAId,
      orgId,
      buildingId: vopAId,
      meterId: meter.id,
      period: '2099-11',
      imageBase64: TINY_PNG,
    })
  );
  cleanup.suggestionIds.push(warnCall.suggestion_id);

  const warnNotifs = await adminPool.query(
    `SELECT id FROM notification WHERE org_id = $1 AND type = 'AI_BUDGET_WARNING'`,
    [orgId]
  );
  cleanup.notificationIds.push(...warnNotifs.rows.map((r) => r.id));
  assert.ok(warnNotifs.rows.length >= 1, 'Crossing 80% budget must notify SYS_ADMIN');

  // Set budget equal to currentCost -> blocks with AI_BUDGET_EXCEEDED
  await adminPool.query(
    `UPDATE system_setting
     SET value = COALESCE(value, '{}'::jsonb) || jsonb_build_object('monthly_budget_vnd', 1, 'enabled', true)
     WHERE org_id = $1 AND key = 'ai_config'`,
    [orgId]
  );
  await assert.rejects(
    () =>
      withUserClient(mgrVopAId, (client) =>
        runMeterOcrSuggestion(client, {
          actorId: mgrVopAId,
          orgId,
          buildingId: vopAId,
          meterId: meter.id,
          period: '2099-11',
          imageBase64: TINY_PNG,
        })
      ),
    (err) => err.status === 429 && err.code === 'AI_BUDGET_EXCEEDED'
  );

  // Global kill switch -> AI_DISABLED
  await adminPool.query(
    `UPDATE system_setting
     SET value = COALESCE(value, '{}'::jsonb) || '{"enabled": false, "monthly_budget_vnd": 500000}'::jsonb
     WHERE org_id = $1 AND key = 'ai_config'`,
    [orgId]
  );
  await assert.rejects(
    () =>
      withUserClient(mgrVopAId, (client) =>
        runMeterOcrSuggestion(client, {
          actorId: mgrVopAId,
          orgId,
          buildingId: vopAId,
          meterId: meter.id,
          period: '2099-11',
          imageBase64: TINY_PNG,
        })
      ),
    (err) => err.status === 503 && err.code === 'AI_DISABLED'
  );
});
