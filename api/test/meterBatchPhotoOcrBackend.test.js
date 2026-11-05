import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import bcrypt from 'bcryptjs';

import {
  postValidateMeterOcr,
  buildGeminiPromptAndSchema,
} from '../src/services/aiRules.js';

dotenv.config();

const APP_DB_URL =
  process.env.APP_DATABASE_URL ||
  'postgres://resihub_app:resihub_app_secret@127.0.0.1:5433/resihub';
process.env.APP_DATABASE_URL = APP_DB_URL;

const TINY_PNG_B64 =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

test('Unit: postValidateMeterOcr & buildGeminiPromptAndSchema support detected_meter_type and METER_TYPE_MISMATCH', () => {
  const promptSpec = buildGeminiPromptAndSchema('METER_OCR', {
    meterType: null,
    meterCode: null,
    apartmentCode: 'A1001',
    previousValue: null,
  });
  assert.ok(
    promptSpec.responseSchema?.properties?.detected_meter_type,
    'METER_OCR schema must expose detected_meter_type'
  );
  assert.equal(promptSpec.responseSchema.properties.detected_meter_type.nullable, true);

  // Backwards compatibility: omitted detected_meter_type -> null, no mismatch warning
  const legacyRes = postValidateMeterOcr({
    rawModelJson: { reading: 1350, confidence: 0.95, reason: 'Đọc rõ' },
    expectedMeterType: 'ELECTRICITY',
    previousValue: 1200,
  });
  assert.equal(legacyRes.reading, 1350);
  assert.equal(legacyRes.detectedMeterType, null);
  assert.equal(legacyRes.needsHumanReview, false);
  assert.deepEqual(legacyRes.warnings, []);

  // Normalized detected_meter_type matching expected -> clean
  const matchedRes = postValidateMeterOcr({
    rawModelJson: {
      reading: 145.5,
      detected_meter_type: 'water',
      confidence: 0.94,
      reason: 'Đồng hồ nước m³',
    },
    expectedMeterType: 'WATER',
    previousValue: 110,
  });
  assert.equal(matchedRes.reading, 145.5);
  assert.equal(matchedRes.detectedMeterType, 'WATER');
  assert.equal(matchedRes.needsHumanReview, false);
  assert.deepEqual(matchedRes.warnings, []);

  // Mismatch: expected ELECTRICITY, detected WATER -> METER_TYPE_MISMATCH + needsHumanReview
  const mismatchRes = postValidateMeterOcr({
    rawModelJson: {
      reading: 145,
      detected_meter_type: 'WATER',
      confidence: 0.96,
      reason: 'Mặt đồng hồ nước m³',
    },
    expectedMeterType: 'ELECTRICITY',
    previousValue: 100,
  });
  assert.equal(mismatchRes.reading, 145);
  assert.equal(mismatchRes.detectedMeterType, 'WATER');
  assert.equal(mismatchRes.needsHumanReview, true);
  assert.ok(mismatchRes.warnings.includes('METER_TYPE_MISMATCH'));

  // Low confidence / blurry photo still preserves valid detectedMeterType if recognized
  const blurryRes = postValidateMeterOcr({
    rawModelJson: {
      reading: null,
      detected_meter_type: 'ELECTRICITY',
      confidence: 0.35,
      reason: 'Mặt kính lóa sáng',
    },
  });
  assert.equal(blurryRes.reading, null);
  assert.equal(blurryRes.detectedMeterType, 'ELECTRICITY');
  assert.equal(blurryRes.needsHumanReview, true);
  assert.ok(blurryRes.warnings.includes('LOW_CONFIDENCE_OR_UNREADABLE'));
});

test('Integration: POST /api/v1/ai/meter-ocr supports room-only & building-only resolution, batch save linking, and strict building isolation', async (t) => {
  const { adminPool, appPool } = await import('../src/db/client.js');
  const {
    setGeminiTransportForTest,
    setGeminiApiKeyOverrideForTest,
  } = await import('../src/services/geminiClient.js');
  const { flushPendingAiTasksForTest } = await import('../src/services/aiGateway.js');

  const { default: authRoute } = await import('../src/routes/auth.js');
  const { default: aiRoute } = await import('../src/routes/ai.js');
  const { default: metersRoute } = await import('../src/routes/meters.js');

  const app = express();
  app.use(
    cors({
      origin: '*',
      methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key', 'X-Test-Ai-Rate-Limit'],
      exposedHeaders: ['Idempotent-Replayed'],
    })
  );
  app.use(express.json({ limit: '20mb' }));
  app.use('/api/v1/auth', authRoute);
  app.use('/api/v1/ai', aiRoute);
  app.use('/api/v1/meters', metersRoute);

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const API_BASE = `http://127.0.0.1:${server.address().port}`;

  async function apiFetch(urlPath, token, options = {}) {
    const method = (options.method || 'GET').toUpperCase();
    const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) && !headers['Idempotency-Key']) {
      headers['Idempotency-Key'] = crypto.randomUUID();
    }
    const res = await fetch(`${API_BASE}${urlPath}`, { ...options, method, headers });
    const text = await res.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = { raw: text };
    }
    return { status: res.status, headers: res.headers, body };
  }

  const suffix = `${Date.now().toString().slice(-6)}${Math.floor(Math.random() * 90 + 10)}`;
  let orgId = null;
  const cleanup = {
    suggestionIds: [],
    meterIds: [],
    apartmentIds: [],
    buildingIds: [],
    userIds: [],
    personIds: [],
    origAiConfig: null,
  };

  t.after(async () => {
    await flushPendingAiTasksForTest().catch(() => {});
    setGeminiTransportForTest(null);
    setGeminiApiKeyOverrideForTest(null);
    await new Promise((resolve) => server.close(resolve));

    const c = await adminPool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.allow_test_cleanup', 'true', true)`);

      if (orgId && cleanup.origAiConfig) {
        await c.query(
          `UPDATE system_setting SET value = $2::jsonb WHERE org_id = $1 AND key = 'ai_config'`,
          [orgId, JSON.stringify(cleanup.origAiConfig)]
        );
      }
      if (cleanup.meterIds.length > 0) {
        await c.query(
          `DELETE FROM attachment WHERE owner_entity = 'meter_reading'
             AND owner_id IN (SELECT id FROM meter_reading WHERE meter_id = ANY($1::uuid[]))`,
          [cleanup.meterIds]
        );
        await c.query(`DELETE FROM meter_reading WHERE meter_id = ANY($1::uuid[])`, [
          cleanup.meterIds,
        ]);
        await c.query(`DELETE FROM meter WHERE id = ANY($1::uuid[])`, [cleanup.meterIds]);
      }
      const allActorIds = [...new Set(cleanup.userIds)];
      if (allActorIds.length > 0) {
        await c.query(
          `DELETE FROM ai_suggestion WHERE created_by = ANY($1::uuid[]) OR reviewed_by = ANY($1::uuid[])`,
          [allActorIds]
        );
        await c.query(`DELETE FROM idempotency_key WHERE actor_id = ANY($1::uuid[])`, [
          allActorIds,
        ]);
        await c.query(`DELETE FROM notification WHERE user_id = ANY($1::uuid[])`, [allActorIds]);
        await c.query(`DELETE FROM audit_log WHERE actor_id = ANY($1::uuid[])`, [allActorIds]);
        await c.query(`DELETE FROM user_role WHERE user_id = ANY($1::uuid[])`, [allActorIds]);
        await c.query(`DELETE FROM app_user WHERE id = ANY($1::uuid[])`, [allActorIds]);
      }
      if (cleanup.suggestionIds.length > 0) {
        await c.query(`DELETE FROM ai_suggestion WHERE id = ANY($1::uuid[])`, [
          cleanup.suggestionIds,
        ]);
      }
      if (cleanup.apartmentIds.length > 0) {
        await c.query(`DELETE FROM apartment WHERE id = ANY($1::uuid[])`, [cleanup.apartmentIds]);
      }
      if (cleanup.buildingIds.length > 0) {
        await c.query(`DELETE FROM building WHERE id = ANY($1::uuid[])`, [cleanup.buildingIds]);
      }
      if (cleanup.personIds.length > 0) {
        await c.query(`DELETE FROM person WHERE id = ANY($1::uuid[])`, [cleanup.personIds]);
      }
      await c.query('COMMIT');
    } finally {
      c.release();
      await appPool.end().catch(() => {});
      await adminPool.end().catch(() => {});
    }
  });

  setGeminiApiKeyOverrideForTest('AIzaSy_BATCH_METER_OCR_TEST_KEY');

  const bldgRes = await adminPool.query(
    `SELECT id, org_id, owner_id FROM building WHERE code = 'VOP-A' LIMIT 1`
  );
  assert.ok(bldgRes.rows.length > 0, 'VOP-A must exist');
  const vopAId = bldgRes.rows[0].id;
  orgId = bldgRes.rows[0].org_id;
  const ownerId = bldgRes.rows[0].owner_id;

  const origCfgRes = await adminPool.query(
    `SELECT value FROM system_setting WHERE org_id = $1 AND key = 'ai_config' LIMIT 1`,
    [orgId]
  );
  cleanup.origAiConfig = origCfgRes.rows[0]?.value || null;

  await adminPool.query(
    `INSERT INTO system_setting (org_id, key, value)
     VALUES ($1, 'ai_config', $2::jsonb)
     ON CONFLICT (org_id, key) DO UPDATE SET value = EXCLUDED.value`,
    [
      orgId,
      JSON.stringify({
        enabled: true,
        model: 'gemini-3.8-flash',
        tasks: {
          cccd_extract: true,
          contract_extract: true,
          meter_ocr: true,
          ticket_triage: true,
        },
        ocr_threshold: 0.8,
        triage_threshold: 0.65,
        extract_threshold: 0.75,
        monthly_token_limit: 50000000,
        monthly_budget_vnd: 50000000,
        warn_percent: 80,
        suggestion_ttl_hours: 72,
      }),
    ]
  );

  // Create second building VOP-B for cross-building 403 / 404 isolation
  const bldgBIns = await adminPool.query(
    `INSERT INTO building (org_id, owner_id, code, name, address)
     VALUES ($1, $2, $3, $4, 'Test Cross Building Batch OCR')
     RETURNING id`,
    [orgId, ownerId, `BMO-${suffix.slice(-4)}`, `Tòa Batch OCR ${suffix}`]
  );
  const vopBId = bldgBIns.rows[0].id;
  cleanup.buildingIds.push(vopBId);

  const floorRes = await adminPool.query(
    `SELECT id FROM floor WHERE building_id = $1 LIMIT 1`,
    [vopAId]
  );
  const vopAFloorId = floorRes.rows[0]?.id || null;

  const aptAIns = await adminPool.query(
    `INSERT INTO apartment (building_id, floor_id, code, area_m2, bedrooms, base_rent, status)
     VALUES ($1, $2, $3, 60, 2, 10000000, 'OCCUPIED')
     RETURNING id, code`,
    [vopAId, vopAFloorId, `A-BMO-${suffix}`]
  );
  const aptAId = aptAIns.rows[0].id;
  cleanup.apartmentIds.push(aptAId);

  const aptBIns = await adminPool.query(
    `INSERT INTO apartment (building_id, floor_id, code, area_m2, bedrooms, base_rent, status)
     VALUES ($1, NULL, $2, 50, 1, 8000000, 'OCCUPIED')
     RETURNING id`,
    [vopBId, `B-BMO-${suffix}`]
  );
  const aptBId = aptBIns.rows[0].id;
  cleanup.apartmentIds.push(aptBId);

  const elecMeterIns = await adminPool.query(
    `INSERT INTO meter (org_id, building_id, apartment_id, meter_type, meter_code, unit, unit_price, initial_reading)
     VALUES ($1, $2, $3, 'ELECTRICITY', $4, 'kWh', 3800, 1200)
     RETURNING id, meter_code`,
    [orgId, vopAId, aptAId, `EL-BMO-${suffix}`]
  );
  const elecMeterId = elecMeterIns.rows[0].id;
  const elecMeterCode = elecMeterIns.rows[0].meter_code;
  cleanup.meterIds.push(elecMeterId);

  const waterMeterIns = await adminPool.query(
    `INSERT INTO meter (org_id, building_id, apartment_id, meter_type, meter_code, unit, unit_price, initial_reading)
     VALUES ($1, $2, $3, 'WATER', $4, 'm³', 22000, 110)
     RETURNING id, meter_code`,
    [orgId, vopAId, aptAId, `WT-BMO-${suffix}`]
  );
  const waterMeterId = waterMeterIns.rows[0].id;
  const waterMeterCode = waterMeterIns.rows[0].meter_code;
  cleanup.meterIds.push(waterMeterId);

  const mgrRoleRes = await adminPool.query(
    `SELECT id FROM role WHERE org_id = $1 AND code = 'MANAGER' LIMIT 1`,
    [orgId]
  );
  const mgrRoleId = mgrRoleRes.rows[0].id;
  const pwPlain = `BatchOcr@${suffix}`;
  const pwHash = await bcrypt.hash(pwPlain, 8);
  const mgrEmail = `bmo.mgr.${suffix}@resihub.test`;
  const mgrPhone = `09${Math.floor(10000000 + Math.random() * 89999999)}`;

  const pRes = await adminPool.query(
    `INSERT INTO person (org_id, full_name, phone, email)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [orgId, `Manager Batch OCR ${suffix}`, mgrPhone, mgrEmail]
  );
  cleanup.personIds.push(pRes.rows[0].id);

  const uRes = await adminPool.query(
    `INSERT INTO app_user (person_id, password_hash, status)
     VALUES ($1, $2, 'ACTIVE')
     RETURNING id`,
    [pRes.rows[0].id, pwHash]
  );
  const mgrUserId = uRes.rows[0].id;
  cleanup.userIds.push(mgrUserId);

  await adminPool.query(
    `INSERT INTO user_role (user_id, role_id, building_id) VALUES ($1, $2, $3)`,
    [mgrUserId, mgrRoleId, vopAId]
  );

  const loginRes = await apiFetch('/api/v1/auth/login', null, {
    method: 'POST',
    body: JSON.stringify({ email: mgrEmail, password: pwPlain }),
  });
  assert.equal(loginRes.status, 200);
  const mgrToken = loginRes.body.accessToken;

  let geminiCallCount = 0;
  function mockGemini(structuredPayload) {
    setGeminiTransportForTest(async () => {
      geminiCallCount += 1;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          candidates: [
            {
              content: {
                parts: [{ text: JSON.stringify(structuredPayload) }],
              },
            },
          ],
          usageMetadata: { promptTokenCount: 210, candidatesTokenCount: 55 },
        }),
      };
    });
  }

  // 1) Missing both meter_id and building_id -> 400 VALIDATION_ERROR before Gemini
  mockGemini({ reading: 100, confidence: 0.95, reason: 'unused' });
  const missingBothRes = await apiFetch('/api/v1/ai/meter-ocr', mgrToken, {
    method: 'POST',
    body: JSON.stringify({ period: '2026-11', image_base64: TINY_PNG_B64 }),
  });
  assert.equal(missingBothRes.status, 400);
  assert.equal(missingBothRes.body.code, 'VALIDATION_ERROR');
  assert.equal(geminiCallCount, 0);

  // 2) Cross-building building_id -> 403 ACCESS_DENIED + audit_log before Gemini
  const crossBldgRes = await apiFetch('/api/v1/ai/meter-ocr', mgrToken, {
    method: 'POST',
    body: JSON.stringify({
      building_id: vopBId,
      period: '2026-11',
      image_base64: TINY_PNG_B64,
    }),
  });
  assert.equal(crossBldgRes.status, 403);
  assert.equal(crossBldgRes.body.code, 'ACCESS_DENIED');
  assert.equal(geminiCallCount, 0);

  // 3) Valid building_id (VOP-A) paired with apartment_id from VOP-B -> 404 NOT_FOUND before Gemini
  const crossAptRes = await apiFetch('/api/v1/ai/meter-ocr', mgrToken, {
    method: 'POST',
    body: JSON.stringify({
      building_id: vopAId,
      apartment_id: aptBId,
      period: '2026-11',
      image_base64: TINY_PNG_B64,
    }),
  });
  assert.equal(crossAptRes.status, 404);
  assert.equal(crossAptRes.body.code, 'NOT_FOUND');
  assert.equal(geminiCallCount, 0);

  // 4) Room-only mode ({ building_id, apartment_id }) -> AI detects WATER and auto-resolves waterMeterId!
  mockGemini({
    reading: 145,
    detected_meter_type: 'WATER',
    confidence: 0.96,
    reason: 'Đọc rõ dãy số 00145 m³ trên đồng hồ nước',
  });
  const roomOnlyRes = await apiFetch('/api/v1/ai/meter-ocr', mgrToken, {
    method: 'POST',
    body: JSON.stringify({
      building_id: vopAId,
      apartment_id: aptAId,
      period: '2026-11',
      image_base64: TINY_PNG_B64,
    }),
  });
  assert.equal(roomOnlyRes.status, 200, JSON.stringify(roomOnlyRes.body));
  const waterSug = roomOnlyRes.body.data;
  cleanup.suggestionIds.push(waterSug.suggestion_id);
  assert.equal(waterSug.output.reading, 145);
  assert.equal(waterSug.output.detected_meter_type, 'WATER');
  assert.equal(waterSug.output.resolved_meter_id, waterMeterId);
  assert.equal(waterSug.output.resolved_meter_code, waterMeterCode);
  assert.equal(waterSug.output.apartment_id, aptAId);
  assert.equal(waterSug.output.previous_value, 110);
  assert.equal(waterSug.output.estimated_consumption, 35);

  // AC-014.2: OCR never writes to meter_reading
  const mrCheck = await adminPool.query(
    `SELECT COUNT(*)::int AS cnt FROM meter_reading WHERE meter_id = ANY($1::uuid[])`,
    [[elecMeterId, waterMeterId]]
  );
  assert.equal(mrCheck.rows[0].cnt, 0);

  // 5) Building-only mode ({ building_id }) for unmatched filename like IMG_4021.jpg
  mockGemini({
    reading: 1380,
    detected_meter_type: 'ELECTRICITY',
    confidence: 0.93,
    reason: 'Đọc rõ 1380 kWh trên công tơ điện',
  });
  const bldgOnlyRes = await apiFetch('/api/v1/ai/meter-ocr', mgrToken, {
    method: 'POST',
    body: JSON.stringify({
      building_id: vopAId,
      period: '2026-11',
      image_base64: TINY_PNG_B64,
    }),
  });
  assert.equal(bldgOnlyRes.status, 200, JSON.stringify(bldgOnlyRes.body));
  const elecSug = bldgOnlyRes.body.data;
  cleanup.suggestionIds.push(elecSug.suggestion_id);
  assert.equal(elecSug.output.reading, 1380);
  assert.equal(elecSug.output.detected_meter_type, 'ELECTRICITY');
  assert.equal(elecSug.output.resolved_meter_id, null);

  // 6) Batch save both photos (waterSug unedited -> ACCEPTED, elecSug reassigned & edited 1380->1385 -> EDITED_ACCEPTED)
  const batchSaveRes = await apiFetch('/api/v1/meters/readings/batch', mgrToken, {
    method: 'POST',
    body: JSON.stringify({
      period: '2026-11',
      status: 'CONFIRMED',
      hold_if_abnormal: true,
      readings: [
        {
          meter_id: waterMeterId,
          current_reading: 145,
          image_base64: TINY_PNG_B64,
          ai_suggestion_id: waterSug.suggestion_id,
        },
        {
          meter_id: elecMeterId,
          current_reading: 1385,
          image_base64: TINY_PNG_B64,
          ai_suggestion_id: elecSug.suggestion_id,
        },
      ],
    }),
  });
  assert.equal(batchSaveRes.status, 201, JSON.stringify(batchSaveRes.body));
  assert.equal(batchSaveRes.body.data.length, 2);

  const sugStatusRes = await adminPool.query(
    `SELECT id, status, target_entity_id FROM ai_suggestion WHERE id = ANY($1::uuid[])`,
    [[waterSug.suggestion_id, elecSug.suggestion_id]]
  );
  const statusById = Object.fromEntries(sugStatusRes.rows.map((r) => [r.id, r]));
  assert.equal(statusById[waterSug.suggestion_id].status, 'ACCEPTED');
  assert.ok(statusById[waterSug.suggestion_id].target_entity_id);
  assert.equal(statusById[elecSug.suggestion_id].status, 'EDITED_ACCEPTED');
  assert.ok(statusById[elecSug.suggestion_id].target_entity_id);

  // Verify meter_reading rows saved image_url evidence
  const savedReadingsRes = await adminPool.query(
    `SELECT meter_id, current_reading, status, image_url FROM meter_reading WHERE meter_id = ANY($1::uuid[])`,
    [[waterMeterId, elecMeterId]]
  );
  assert.equal(savedReadingsRes.rows.length, 2);
  for (const row of savedReadingsRes.rows) {
    assert.equal(row.status, 'CONFIRMED');
    assert.ok(row.image_url, `Expected image_url saved for meter ${row.meter_id}`);
  }

  // 7) Known meter_id mode with mismatched dial (expected ELECTRICITY, Gemini sees WATER)
  mockGemini({
    reading: 1500,
    detected_meter_type: 'WATER',
    confidence: 0.94,
    reason: 'Mặt đồng hồ nước m³',
  });
  const mismatchOcrRes = await apiFetch('/api/v1/ai/meter-ocr', mgrToken, {
    method: 'POST',
    body: JSON.stringify({
      meter_id: elecMeterId,
      period: '2026-11',
      image_base64: TINY_PNG_B64,
    }),
  });
  assert.equal(mismatchOcrRes.status, 200);
  cleanup.suggestionIds.push(mismatchOcrRes.body.data.suggestion_id);
  assert.equal(mismatchOcrRes.body.data.output.resolved_meter_id, elecMeterId);
  assert.equal(mismatchOcrRes.body.data.output.resolved_meter_code, elecMeterCode);
  assert.equal(mismatchOcrRes.body.data.needs_human_review, true);
  assert.ok(mismatchOcrRes.body.data.warnings.includes('METER_TYPE_MISMATCH'));
});
