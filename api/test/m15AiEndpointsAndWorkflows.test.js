import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import bcrypt from 'bcryptjs';

dotenv.config();

const APP_DB_URL =
  process.env.APP_DATABASE_URL ||
  'postgres://resihub_app:resihub_app_secret@127.0.0.1:5433/resihub';
process.env.APP_DATABASE_URL = APP_DB_URL;

const TINY_PNG_B64 =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

const TINY_PDF_B64 = `data:application/pdf;base64,${Buffer.from(
  '%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n',
  'utf8'
).toString('base64')}`;

test('M15 AI Gateway Endpoints, Human-Confirmation Hooks, Async Triage, RBAC & Cross-Building Isolation', async (t) => {
  const { adminPool, appPool } = await import('../src/db/client.js');
  const {
    setGeminiTransportForTest,
    setGeminiApiKeyOverrideForTest,
  } = await import('../src/services/geminiClient.js');
  const { flushPendingAiTasksForTest } = await import('../src/services/aiGateway.js');

  const { default: authRoute } = await import('../src/routes/auth.js');
  const { default: aiRoute } = await import('../src/routes/ai.js');
  const { default: settingsRoute } = await import('../src/routes/settings.js');
  const { default: tenantsRoute } = await import('../src/routes/tenants.js');
  const { default: contractsRoute } = await import('../src/routes/contracts.js');
  const { default: metersRoute } = await import('../src/routes/meters.js');
  const { default: serviceRequestsRoute } = await import('../src/routes/service-requests.js');
  const { default: residentRoute } = await import('../src/routes/resident.js');

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
  app.use('/api/v1/settings', settingsRoute);
  app.use('/api/v1/tenants', tenantsRoute);
  app.use('/api/v1/contracts', contractsRoute);
  app.use('/api/v1/meters', metersRoute);
  app.use('/api/v1/service-requests', serviceRequestsRoute);
  app.use('/api/v1/resident', residentRoute);

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

  async function loginEmail(email, password) {
    const res = await apiFetch('/api/v1/auth/login', null, {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
    assert.equal(res.status, 200, `Login failed for ${email}: ${JSON.stringify(res.body)}`);
    return { token: res.body.accessToken, user: res.body.user };
  }

  const suffix = `${Date.now().toString().slice(-6)}${Math.floor(Math.random() * 90 + 10)}`;
  let orgId = null;
  const cleanup = {
    suggestionIds: [],
    serviceRequestIds: [],
    meterReadingIds: [],
    meterIds: [],
    contractIds: [],
    apartmentIds: [],
    buildingIds: [],
    tenantIds: [],
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
      if (cleanup.serviceRequestIds.length > 0) {
        await c.query(
          `DELETE FROM notification WHERE (payload->>'service_request_id') = ANY($1::text[])`,
          [cleanup.serviceRequestIds]
        );
        await c.query(
          `DELETE FROM audit_log WHERE entity = 'service_request' AND entity_id = ANY($1::uuid[])`,
          [cleanup.serviceRequestIds]
        );
        await c.query(`DELETE FROM service_request WHERE id = ANY($1::uuid[])`, [
          cleanup.serviceRequestIds,
        ]);
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
      } else if (cleanup.meterReadingIds.length > 0) {
        await c.query(`DELETE FROM meter_reading WHERE id = ANY($1::uuid[])`, [
          cleanup.meterReadingIds,
        ]);
      }
      if (cleanup.contractIds.length > 0) {
        await c.query(
          `DELETE FROM notification WHERE (payload->>'contract_id') = ANY($1::text[])`,
          [cleanup.contractIds]
        );
        await c.query(
          `DELETE FROM deposit_transaction WHERE deposit_id IN (SELECT id FROM deposit WHERE contract_id = ANY($1::uuid[]))`,
          [cleanup.contractIds]
        );
        await c.query(`DELETE FROM deposit WHERE contract_id = ANY($1::uuid[])`, [
          cleanup.contractIds,
        ]);
        await c.query(`DELETE FROM contract_service_price WHERE contract_id = ANY($1::uuid[])`, [
          cleanup.contractIds,
        ]);
        await c.query(`DELETE FROM service_subscription WHERE contract_id = ANY($1::uuid[])`, [
          cleanup.contractIds,
        ]);
        await c.query(`DELETE FROM contract_occupant WHERE contract_id = ANY($1::uuid[])`, [
          cleanup.contractIds,
        ]);
        await c.query(`DELETE FROM contract WHERE id = ANY($1::uuid[])`, [cleanup.contractIds]);
      }
      if (cleanup.tenantIds.length > 0) {
        const tpRes = await c.query(
          `SELECT person_id FROM tenant WHERE id = ANY($1::uuid[])`,
          [cleanup.tenantIds]
        );
        for (const r of tpRes.rows) {
          if (!cleanup.personIds.includes(r.person_id)) cleanup.personIds.push(r.person_id);
        }
        await c.query(
          `DELETE FROM attachment WHERE owner_entity = 'tenant' AND owner_id = ANY($1::uuid[])`,
          [cleanup.tenantIds]
        );
        await c.query(`DELETE FROM tenant WHERE id = ANY($1::uuid[])`, [cleanup.tenantIds]);
      }
      if (cleanup.personIds.length > 0) {
        const auRes = await c.query(
          `SELECT id FROM app_user WHERE person_id = ANY($1::uuid[])`,
          [cleanup.personIds]
        );
        for (const r of auRes.rows) {
          if (!cleanup.userIds.includes(r.id)) cleanup.userIds.push(r.id);
        }
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
    } catch (cleanupErr) {
      await c.query('ROLLBACK').catch(() => {});
      console.error('[M15 Test Cleanup Error]:', cleanupErr.message);
    } finally {
      c.release();
      await appPool.end().catch(() => {});
      await adminPool.end().catch(() => {});
    }
  });

  setGeminiApiKeyOverrideForTest('AIzaSy_M15_ROUTE_TEST_SECRET_DO_NOT_LEAK');

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
        model: 'gemini-2.5-flash',
        tasks: {
          cccd_extract: true,
          contract_extract: true,
          meter_ocr: true,
          ticket_triage: true,
        },
        ocr_threshold: 0.85,
        triage_threshold: 0.65,
        extract_threshold: 0.75,
        monthly_token_limit: 50000000,
        monthly_budget_vnd: 50000000,
        warn_percent: 80,
        suggestion_ttl_hours: 72,
      }),
    ]
  );

  // Create isolated second building (M15B) to test cross-building 403 isolation
  const bldgBIns = await adminPool.query(
    `INSERT INTO building (org_id, owner_id, code, name, address)
     VALUES ($1, $2, $3, $4, 'Test Cross Building M15')
     RETURNING id`,
    [orgId, ownerId, `M15B-${suffix.slice(-4)}`, `Tòa M15-B ${suffix}`]
  );
  const vopBId = bldgBIns.rows[0].id;
  cleanup.buildingIds.push(vopBId);

  const vopAFloorRes = await adminPool.query(
    `SELECT id FROM floor WHERE building_id = $1 LIMIT 1`,
    [vopAId]
  );
  const vopAFloorId = vopAFloorRes.rows[0]?.id || null;

  // Create temp apartments in VOP-A (one AVAILABLE for AI-01 contract draft, one OCCUPIED for Resident AI-03) and VOP-B
  const aptAvailAIns = await adminPool.query(
    `INSERT INTO apartment (building_id, floor_id, code, area_m2, bedrooms, base_rent, status)
     VALUES ($1, $2, $3, 55, 2, 9500000, 'AVAILABLE')
     RETURNING id, code`,
    [vopAId, vopAFloorId, `A-AI01-${suffix}`]
  );
  const aptAvailAId = aptAvailAIns.rows[0].id;
  const aptAvailACode = aptAvailAIns.rows[0].code;
  cleanup.apartmentIds.push(aptAvailAId);

  const aptOccAIns = await adminPool.query(
    `INSERT INTO apartment (building_id, floor_id, code, area_m2, bedrooms, base_rent, status)
     VALUES ($1, $2, $3, 60, 2, 11000000, 'OCCUPIED')
     RETURNING id, code`,
    [vopAId, vopAFloorId, `A-AI03-${suffix}`]
  );
  const aptOccAId = aptOccAIns.rows[0].id;
  cleanup.apartmentIds.push(aptOccAId);

  const aptBIns = await adminPool.query(
    `INSERT INTO apartment (building_id, floor_id, code, area_m2, bedrooms, base_rent, status)
     VALUES ($1, NULL, $2, 50, 1, 8000000, 'OCCUPIED')
     RETURNING id`,
    [vopBId, `B-AI-${suffix}`]
  );
  const aptBId = aptBIns.rows[0].id;
  cleanup.apartmentIds.push(aptBId);

  // Create meters in VOP-A and VOP-B
  const meterAIns = await adminPool.query(
    `INSERT INTO meter (org_id, building_id, apartment_id, meter_type, meter_code, unit, unit_price, initial_reading)
     VALUES ($1, $2, $3, 'ELECTRICITY', $4, 'kWh', 3500, 1200)
     RETURNING id`,
    [orgId, vopAId, aptOccAId, `EL-M15A-${suffix}`]
  );
  const meterAId = meterAIns.rows[0].id;
  cleanup.meterIds.push(meterAId);

  const meterBIns = await adminPool.query(
    `INSERT INTO meter (org_id, building_id, apartment_id, meter_type, meter_code, unit, unit_price, initial_reading)
     VALUES ($1, $2, $3, 'ELECTRICITY', $4, 'kWh', 3500, 500)
     RETURNING id`,
    [orgId, vopBId, aptBId, `EL-M15B-${suffix}`]
  );
  const meterBId = meterBIns.rows[0].id;
  cleanup.meterIds.push(meterBId);

  // Create 4 isolated role accounts: SYS_ADMIN, OWNER (owns VOP-A), MANAGER (manages VOP-A only), RESIDENT (active contract in aptOccA)
  const rolesRes = await adminPool.query(
    `SELECT id, code FROM role WHERE org_id = $1 AND code IN ('SYS_ADMIN', 'OWNER', 'MANAGER', 'RESIDENT')`,
    [orgId]
  );
  const roleMap = Object.fromEntries(rolesRes.rows.map((r) => [r.code, r.id]));
  const pwPlain = `M15Pass@${suffix}`;
  const pwHash = await bcrypt.hash(pwPlain, 8);

  async function createActor(roleCode, label, buildingScopeId = null) {
    const phone = `09${Math.floor(10000000 + Math.random() * 89999999)}`;
    const email = `m15.${label.toLowerCase()}.${suffix}@resihub.test`;
    const pRes = await adminPool.query(
      `INSERT INTO person (org_id, full_name, phone, email)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [orgId, `M15 ${label} ${suffix}`, phone, email]
    );
    const personId = pRes.rows[0].id;
    cleanup.personIds.push(personId);

    const uRes = await adminPool.query(
      `INSERT INTO app_user (person_id, password_hash, status)
       VALUES ($1, $2, 'ACTIVE')
       RETURNING id`,
      [personId, pwHash]
    );
    const userId = uRes.rows[0].id;
    cleanup.userIds.push(userId);

    await adminPool.query(
      `INSERT INTO user_role (user_id, role_id, building_id)
       VALUES ($1, $2, $3)`,
      [userId, roleMap[roleCode], buildingScopeId]
    );

    const auth = await loginEmail(email, pwPlain);
    return { userId, personId, phone, email, token: auth.token };
  }

  const sysAdmin = await createActor('SYS_ADMIN', 'SysAdmin', null);
  const ownerActor = await createActor('OWNER', 'Owner', vopAId);
  const managerA = await createActor('MANAGER', 'ManagerA', vopAId);
  const residentA = await createActor('RESIDENT', 'ResidentA', vopAId);

  // Give residentA an ACTIVE contract on aptOccAId so POST /api/v1/resident/service-requests succeeds
  const resTenantIns = await adminPool.query(
    `INSERT INTO tenant (org_id, person_id, type, status)
     VALUES ($1, $2, 'primary', 'APPROVED')
     RETURNING id`,
    [orgId, residentA.personId]
  );
  const resTenantId = resTenantIns.rows[0].id;
  cleanup.tenantIds.push(resTenantId);

  const resContractIns = await adminPool.query(
    `INSERT INTO contract (
       apartment_id, building_id, primary_tenant_id, start_date, end_date,
       rent_amount, deposit_amount, billing_day, status
     ) VALUES ($1, $2, $3, CURRENT_DATE - INTERVAL '10 days', CURRENT_DATE + INTERVAL '350 days',
               11000000, 11000000, 5, 'ACTIVE')
     RETURNING id`,
    [aptOccAId, vopAId, resTenantId]
  );
  cleanup.contractIds.push(resContractIns.rows[0].id);

  // Also create a service_request in VOP-B to test cross-building 403 on /classify and /apply-triage
  const srBIns = await adminPool.query(
    `INSERT INTO service_request (
       org_id, building_id, apartment_id, created_by, title, category, description,
       priority, status, tracking_code
     ) VALUES ($1, $2, $3, $4, 'Hỏng đèn hành lang tòa B', 'ELECTRICAL', 'Chập đèn', 'NORMAL', 'NEW', $5)
     RETURNING id`,
    [orgId, vopBId, aptBId, sysAdmin.userId, `SRM15B${suffix}`]
  );
  const srBId = srBIns.rows[0].id;
  cleanup.serviceRequestIds.push(srBId);

  // =========================================================================
  // 0. Static check: server.js mounts /api/v1/ai
  // =========================================================================
  const serverSrc = await fs.readFile(path.resolve(process.cwd(), 'src/server.js'), 'utf8');
  assert.match(serverSrc, /\/api\/v1\/ai/, 'server.js must mount /api/v1/ai');

  // =========================================================================
  // 1. AI-01: CCCD & Contract PDF Extract -> Human Edit -> Confirm on Save
  // =========================================================================
  const cccdIdNum = `07920${suffix.slice(0, 7).padEnd(7, '3')}`;

  // Privacy gate check: privacy_acknowledged: false -> 422 PRIVACY_CONSENT_REQUIRED
  const noConsentRes = await apiFetch('/api/v1/ai/extract', managerA.token, {
    method: 'POST',
    body: JSON.stringify({
      document_type: 'CCCD',
      building_id: vopAId,
      files: [TINY_PNG_B64],
      privacy_acknowledged: false,
    }),
  });
  assert.equal(noConsentRes.status, 422);
  assert.equal(noConsentRes.body.code, 'PRIVACY_CONSENT_REQUIRED');

  const personCountBefore = Number(
    (await adminPool.query(`SELECT COUNT(*)::int AS cnt FROM person WHERE org_id = $1`, [orgId]))
      .rows[0].cnt
  );

  function mockGeminiOk(
    structuredPayload,
    { promptTokenCount = 240, candidatesTokenCount = 70 } = {}
  ) {
    setGeminiTransportForTest(async () => ({
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
        usageMetadata: { promptTokenCount, candidatesTokenCount },
      }),
    }));
  }

  mockGeminiOk(
    {
      full_name: `Nguyễn Văn AI ${suffix}`,
      id_number: cccdIdNum,
      dob: '1995-05-15',
      permanent_address: '123 Nguyễn Huệ, Quận 1, TP.HCM',
      confidence: 0.94,
      field_confidences: {
        full_name: 0.97,
        id_number: 0.96,
        dob: 0.89,
        permanent_address: 0.92,
      },
    },
    { promptTokenCount: 280, candidatesTokenCount: 90 }
  );

  const cccdRes = await apiFetch('/api/v1/ai/extract', managerA.token, {
    method: 'POST',
    body: JSON.stringify({
      document_type: 'CCCD',
      building_id: vopAId,
      files: [TINY_PNG_B64],
      privacy_acknowledged: true,
    }),
  });
  assert.equal(cccdRes.status, 200, `CCCD extract failed: ${JSON.stringify(cccdRes.body)}`);
  assert.equal(cccdRes.body.data.output.id_number, cccdIdNum);
  const cccdSuggestionId = cccdRes.body.data.suggestion_id;
  cleanup.suggestionIds.push(cccdSuggestionId);

  // Core principle (PRD 12.1): person count MUST NOT change before human confirmation!
  const personCountAfterExtract = Number(
    (await adminPool.query(`SELECT COUNT(*)::int AS cnt FROM person WHERE org_id = $1`, [orgId]))
      .rows[0].cnt
  );
  assert.equal(personCountAfterExtract, personCountBefore, 'AI extract must never mutate person');

  // Manager edits dob (1995-05-15 -> 1995-05-20) and saves via POST /api/v1/tenants with ai_suggestion_id
  const newTenantPhone = `09${Math.floor(10000000 + Math.random() * 89999999)}`;
  const createTenantRes = await apiFetch('/api/v1/tenants', managerA.token, {
    method: 'POST',
    body: JSON.stringify({
      full_name: cccdRes.body.data.output.full_name,
      phone: newTenantPhone,
      id_number: cccdIdNum,
      dob: '1995-05-20',
      address: cccdRes.body.data.output.permanent_address,
      privacy_consent: true,
      ai_suggestion_id: cccdSuggestionId,
    }),
  });
  assert.equal(createTenantRes.status, 201, `Create tenant failed: ${JSON.stringify(createTenantRes.body)}`);
  const createdTenantId = createTenantRes.body.data.id;
  cleanup.tenantIds.push(createdTenantId);

  const suggRowAfterTenant = (
    await adminPool.query(`SELECT * FROM ai_suggestion WHERE id = $1`, [cccdSuggestionId])
  ).rows[0];
  assert.equal(suggRowAfterTenant.status, 'EDITED_ACCEPTED');
  assert.equal(suggRowAfterTenant.target_entity_id, createdTenantId);
  assert.equal(suggRowAfterTenant.accepted_fields_count, 3);
  assert.equal(suggRowAfterTenant.total_fields_count, 4);
  assert.equal(
    JSON.stringify(suggRowAfterTenant.output).includes(cccdIdNum),
    false,
    'Raw CCCD number must never be persisted in ai_suggestion.output'
  );
  assert.equal(
    JSON.stringify(suggRowAfterTenant.edited_output || {}).includes(cccdIdNum),
    false,
    'Raw CCCD number must never be persisted in ai_suggestion.edited_output'
  );

  // SYS_ADMIN can extract CCCD and explicitly reject via /suggestions/:id/review, but gets 403 on CONTRACT
  const sysCccdRes = await apiFetch('/api/v1/ai/extract', sysAdmin.token, {
    method: 'POST',
    body: JSON.stringify({
      document_type: 'CCCD',
      files: [TINY_PNG_B64],
      privacy_acknowledged: true,
    }),
  });
  assert.equal(sysCccdRes.status, 200);
  cleanup.suggestionIds.push(sysCccdRes.body.data.suggestion_id);

  const rejectRes = await apiFetch(
    `/api/v1/ai/suggestions/${sysCccdRes.body.data.suggestion_id}/review`,
    sysAdmin.token,
    {
      method: 'POST',
      body: JSON.stringify({ decision: 'REJECT' }),
    }
  );
  assert.equal(rejectRes.status, 200);
  assert.equal(rejectRes.body.data.status, 'REJECTED');

  const sysContractForbidden = await apiFetch('/api/v1/ai/extract', sysAdmin.token, {
    method: 'POST',
    body: JSON.stringify({
      document_type: 'CONTRACT',
      building_id: vopAId,
      files: [TINY_PDF_B64],
      privacy_acknowledged: true,
    }),
  });
  assert.equal(sysContractForbidden.status, 403, 'SYS_ADMIN is CRUD on tenants only, R on contracts');

  // Contract PDF extract -> human confirm via POST /api/v1/contracts
  mockGeminiOk(
    {
      tenant_full_name: cccdRes.body.data.output.full_name,
      tenant_phone: newTenantPhone,
      tenant_id_number: cccdIdNum,
      apartment_code: aptAvailACode,
      start_date: '2027-01-01',
      end_date: '2027-12-31',
      rent_amount: 9500000,
      deposit_amount: 19000000,
      billing_day: 5,
      payment_due_days: 5,
      terms_note: 'Hợp đồng 12 tháng trích xuất từ PDF',
      confidence: 0.91,
    },
    { promptTokenCount: 520, candidatesTokenCount: 140 }
  );

  const contractCountBefore = Number(
    (await adminPool.query(`SELECT COUNT(*)::int AS cnt FROM contract WHERE building_id = $1`, [vopAId]))
      .rows[0].cnt
  );

  const contractExtractRes = await apiFetch('/api/v1/ai/extract', managerA.token, {
    method: 'POST',
    body: JSON.stringify({
      document_type: 'CONTRACT',
      building_id: vopAId,
      files: [TINY_PDF_B64],
      privacy_acknowledged: true,
    }),
  });
  assert.equal(contractExtractRes.status, 200, `Contract PDF extract failed: ${JSON.stringify(contractExtractRes.body)}`);
  const contractSuggestionId = contractExtractRes.body.data.suggestion_id;
  cleanup.suggestionIds.push(contractSuggestionId);

  const contractCountAfterExtract = Number(
    (await adminPool.query(`SELECT COUNT(*)::int AS cnt FROM contract WHERE building_id = $1`, [vopAId]))
      .rows[0].cnt
  );
  assert.equal(contractCountAfterExtract, contractCountBefore, 'Contract extract must not create contract row');

  const createContractRes = await apiFetch('/api/v1/contracts', managerA.token, {
    method: 'POST',
    body: JSON.stringify({
      apartment_id: aptAvailAId,
      building_id: vopAId,
      primary_tenant_id: createdTenantId,
      start_date: '2027-01-01',
      end_date: '2027-12-31',
      rent_amount: 9500000,
      deposit_amount: 19000000,
      billing_cycle: 'MONTHLY',
      billing_day: 5,
      payment_due_days: 5,
      note: 'Hợp đồng 12 tháng trích xuất từ PDF',
      ai_suggestion_id: contractSuggestionId,
    }),
  });
  assert.equal(createContractRes.status, 201, `Create contract failed: ${JSON.stringify(createContractRes.body)}`);
  cleanup.contractIds.push(createContractRes.body.data.id);

  const suggRowAfterContract = (
    await adminPool.query(`SELECT * FROM ai_suggestion WHERE id = $1`, [contractSuggestionId])
  ).rows[0];
  assert.equal(suggRowAfterContract.status, 'ACCEPTED');
  assert.equal(suggRowAfterContract.target_entity_id, createContractRes.body.data.id);

  // =========================================================================
  // 2. AI-02: Meter OCR Blurry (AC-014.1) vs Valid (AC-014.2) -> Batch Confirm
  // =========================================================================
  const ocrPeriod = '2026-11';

  // AC-014.1: Blurry photo (confidence 0.45) -> reading: null, needs_human_review: true
  mockGeminiOk(
    {
      reading: 1350,
      confidence: 0.45,
      reason: 'Mặt kính đồng hồ bị lóa đèn flash',
    },
    { promptTokenCount: 210, candidatesTokenCount: 45 }
  );

  const blurryOcrRes = await apiFetch('/api/v1/ai/meter-ocr', managerA.token, {
    method: 'POST',
    body: JSON.stringify({
      meter_id: meterAId,
      period: ocrPeriod,
      image_base64: TINY_PNG_B64,
    }),
  });
  assert.equal(blurryOcrRes.status, 200);
  assert.equal(blurryOcrRes.body.data.output.reading, null, 'AC-014.1: blurry OCR must return reading: null');
  assert.equal(blurryOcrRes.body.data.needs_human_review, true);
  cleanup.suggestionIds.push(blurryOcrRes.body.data.suggestion_id);

  // AC-014.2: Readable photo (reading 1350, confidence 0.96) -> zero meter_reading rows until batch confirm
  mockGeminiOk(
    {
      reading: 1350,
      confidence: 0.96,
      reason: 'Đọc rõ dãy số trên đồng hồ điện',
    },
    { promptTokenCount: 215, candidatesTokenCount: 40 }
  );

  const validOcrRes = await apiFetch('/api/v1/ai/meter-ocr', managerA.token, {
    method: 'POST',
    body: JSON.stringify({
      meter_id: meterAId,
      period: ocrPeriod,
      image_base64: TINY_PNG_B64,
    }),
  });
  assert.equal(validOcrRes.status, 200);
  assert.equal(validOcrRes.body.data.output.reading, 1350);
  assert.equal(validOcrRes.body.data.needs_human_review, false);
  const meterSuggestionId = validOcrRes.body.data.suggestion_id;
  cleanup.suggestionIds.push(meterSuggestionId);

  const mrBeforeConfirm = await adminPool.query(
    `SELECT id FROM meter_reading WHERE meter_id = $1 AND period = $2`,
    [meterAId, ocrPeriod]
  );
  assert.equal(mrBeforeConfirm.rows.length, 0, 'AC-014.2: meter_reading must remain empty before human save');

  const batchSaveRes = await apiFetch('/api/v1/meters/readings/batch', managerA.token, {
    method: 'POST',
    body: JSON.stringify({
      period: ocrPeriod,
      status: 'CONFIRMED',
      readings: [
        {
          meter_id: meterAId,
          reading_value: 1350,
          ai_suggestion_id: meterSuggestionId,
        },
      ],
    }),
  });
  assert.equal(batchSaveRes.status, 201, `Batch meter save failed: ${JSON.stringify(batchSaveRes.body)}`);
  assert.equal(batchSaveRes.body.data.length, 1);
  cleanup.meterReadingIds.push(batchSaveRes.body.data[0].id);

  const mrAfterConfirm = (
    await adminPool.query(`SELECT * FROM meter_reading WHERE id = $1`, [batchSaveRes.body.data[0].id])
  ).rows[0];
  assert.equal(Number(mrAfterConfirm.current_reading), 1350);
  assert.equal(mrAfterConfirm.source, 'AI');
  assert.equal(mrAfterConfirm.ai_suggestion_id, meterSuggestionId);

  const meterSuggAfter = (
    await adminPool.query(`SELECT status, target_entity_id FROM ai_suggestion WHERE id = $1`, [
      meterSuggestionId,
    ])
  ).rows[0];
  assert.equal(meterSuggAfter.status, 'ACCEPTED');
  assert.equal(meterSuggAfter.target_entity_id, mrAfterConfirm.id);

  // =========================================================================
  // 3. AI-03: Async Resident Triage, Non-Leakage, 1-Click Apply/Override & Timeout Resilience
  // =========================================================================
  mockGeminiOk(
    {
      category: 'PLUMBING',
      priority: 'HIGH',
      suggested_assignee_id: managerA.userId,
      summary: 'Rò rỉ mạnh đường ống nước dưới bồn rửa bếp, cần xử lý sớm',
      confidence: 0.91,
    },
    { promptTokenCount: 190, candidatesTokenCount: 65 }
  );

  const resTicketCreate = await apiFetch('/api/v1/resident/service-requests', residentA.token, {
    method: 'POST',
    body: JSON.stringify({
      category: 'OTHER',
      title: 'Vòi nước bồn rửa rỉ mạnh',
      description: 'Nước chảy thành dòng dưới tủ bếp căn hộ, nhờ kỹ thuật kiểm tra sớm.',
      priority: 'NORMAL',
      ignore_duplicate_warning: true,
    }),
  });
  assert.equal(resTicketCreate.status, 201, `Resident ticket create failed: ${JSON.stringify(resTicketCreate.body)}`);
  const srId1 = resTicketCreate.body.data.id;
  cleanup.serviceRequestIds.push(srId1);
  assert.equal(resTicketCreate.body.data.status, 'NEW');
  assert.equal('ai_triage_status' in resTicketCreate.body.data, false, 'Resident POST response must omit ai_*');

  await flushPendingAiTasksForTest();

  // Resident GET list must NOT leak any internal ai_* triage columns
  const resListCheck = await apiFetch('/api/v1/resident/service-requests', residentA.token);
  assert.equal(resListCheck.status, 200);
  const resTicketView = (resListCheck.body.data || []).find((r) => r.id === srId1);
  assert.ok(resTicketView, 'Resident should see own ticket');
  assert.equal('ai_summary' in resTicketView, false, 'Resident GET must not leak ai_summary');
  assert.equal('ai_triage_status' in resTicketView, false, 'Resident GET must not leak ai_triage_status');

  // Manager GET /:id sees AI suggestion ready for 1-click confirmation
  const mgrDetailRes = await apiFetch(`/api/v1/service-requests/${srId1}`, managerA.token);
  assert.equal(mgrDetailRes.status, 200);
  assert.equal(mgrDetailRes.body.data.status, 'NEW', 'Ticket status remains NEW until Manager confirms');
  assert.equal(mgrDetailRes.body.data.ai_triage_status, 'SUGGESTED');
  assert.equal(mgrDetailRes.body.data.ai_suggested_category, 'PLUMBING');
  assert.equal(mgrDetailRes.body.data.ai_suggested_priority, 'HIGH');
  assert.equal(mgrDetailRes.body.data.ai_suggested_assignee_id, managerA.userId);
  assert.ok(mgrDetailRes.body.data.ai_suggested_assignee_name, 'ai_suggested_assignee_name must be joined');
  if (mgrDetailRes.body.data.ai_suggestion_id) {
    cleanup.suggestionIds.push(mgrDetailRes.body.data.ai_suggestion_id);
  }

  // Manager overrides priority -> URGENT via POST /api/v1/service-requests/:id/apply-triage
  const applyTriageRes = await apiFetch(`/api/v1/service-requests/${srId1}/apply-triage`, managerA.token, {
    method: 'POST',
    body: JSON.stringify({
      category: 'PLUMBING',
      priority: 'URGENT',
      assigned_to: managerA.userId,
    }),
  });
  assert.equal(applyTriageRes.status, 200, `Apply triage failed: ${JSON.stringify(applyTriageRes.body)}`);
  assert.equal(applyTriageRes.body.data.category, 'PLUMBING');
  assert.equal(applyTriageRes.body.data.priority, 'URGENT');
  assert.equal(applyTriageRes.body.data.status, 'ASSIGNED');
  assert.equal(applyTriageRes.body.data.ai_triage_status, 'OVERRIDDEN');

  // Verify SLA due deadline shortened to 4 hours (URGENT)
  const createdMs = new Date(applyTriageRes.body.data.created_at).getTime();
  const slaDueMs = new Date(applyTriageRes.body.data.sla_due_at).getTime();
  const slaHours = (slaDueMs - createdMs) / (3600 * 1000);
  assert.ok(slaHours > 3.9 && slaHours < 4.1, `URGENT SLA must recalculate to 4h, got ${slaHours}h`);

  const triageSuggAfter = (
    await adminPool.query(`SELECT status FROM ai_suggestion WHERE id = $1`, [
      mgrDetailRes.body.data.ai_suggestion_id,
    ])
  ).rows[0];
  assert.equal(triageSuggAfter.status, 'EDITED_ACCEPTED');

  // Review Focus #5: Simulate Gemini timeout (AbortError) on background triage -> 201 immediately + FAILED status
  setGeminiTransportForTest(async () => {
    const abortErr = new Error('The operation was aborted');
    abortErr.name = 'AbortError';
    throw abortErr;
  });

  const resTicketTimeout = await apiFetch('/api/v1/resident/service-requests', residentA.token, {
    method: 'POST',
    body: JSON.stringify({
      category: 'ELECTRICAL',
      title: 'Ổ cắm phòng ngủ lỏng',
      description: 'Cắm sạc hơi lỏng phích cắm.',
      priority: 'LOW',
      ignore_duplicate_warning: true,
    }),
  });
  assert.equal(resTicketTimeout.status, 201, 'Resident ticket creation must succeed even if Gemini times out');
  const srId2 = resTicketTimeout.body.data.id;
  cleanup.serviceRequestIds.push(srId2);

  await flushPendingAiTasksForTest();

  const srTimeoutRow = (
    await adminPool.query(`SELECT status, ai_triage_status FROM service_request WHERE id = $1`, [srId2])
  ).rows[0];
  assert.equal(srTimeoutRow.status, 'NEW');
  assert.equal(srTimeoutRow.ai_triage_status, 'FAILED');

  // Manager can manually re-run AI triage via POST /api/v1/ai/classify once Gemini recovers
  mockGeminiOk(
    {
      category: 'ELECTRICAL',
      priority: 'NORMAL',
      suggested_assignee_id: managerA.userId,
      summary: 'Ổ cắm điện phòng ngủ bị lỏng tiếp điểm',
      confidence: 0.88,
    },
    { promptTokenCount: 160, candidatesTokenCount: 55 }
  );

  const manualClassifyRes = await apiFetch('/api/v1/ai/classify', managerA.token, {
    method: 'POST',
    body: JSON.stringify({ service_request_id: srId2 }),
  });
  assert.equal(manualClassifyRes.status, 200);
  assert.equal(manualClassifyRes.body.data.output.category, 'ELECTRICAL');
  cleanup.suggestionIds.push(manualClassifyRes.body.data.suggestion_id);

  // =========================================================================
  // 4. 4-Role RBAC, Cross-Building 403 + Audit Log, Usage KPIs & Settings Hygiene
  // =========================================================================
  for (const forbiddenActor of [ownerActor, residentA]) {
    const r1 = await apiFetch('/api/v1/ai/extract', forbiddenActor.token, {
      method: 'POST',
      body: JSON.stringify({ document_type: 'CCCD', files: [TINY_PNG_B64], privacy_acknowledged: true }),
    });
    assert.equal(r1.status, 403);

    const r2 = await apiFetch('/api/v1/ai/meter-ocr', forbiddenActor.token, {
      method: 'POST',
      body: JSON.stringify({ meter_id: meterAId, image_base64: TINY_PNG_B64 }),
    });
    assert.equal(r2.status, 403);

    const r3 = await apiFetch('/api/v1/ai/classify', forbiddenActor.token, {
      method: 'POST',
      body: JSON.stringify({ service_request_id: srId1 }),
    });
    assert.equal(r3.status, 403);

    const r4 = await apiFetch(`/api/v1/service-requests/${srId2}/apply-triage`, forbiddenActor.token, {
      method: 'POST',
      body: JSON.stringify({ category: 'ELECTRICAL', priority: 'NORMAL' }),
    });
    assert.equal(r4.status, 403);
  }

  // Cross-building 403 ACCESS_DENIED for MANAGER of VOP-A accessing VOP-B resources
  const crossExtract = await apiFetch('/api/v1/ai/extract', managerA.token, {
    method: 'POST',
    body: JSON.stringify({
      document_type: 'CONTRACT',
      building_id: vopBId,
      files: [TINY_PDF_B64],
      privacy_acknowledged: true,
    }),
  });
  assert.equal(crossExtract.status, 403);
  assert.equal(crossExtract.body.code, 'ACCESS_DENIED');

  const crossMeter = await apiFetch('/api/v1/ai/meter-ocr', managerA.token, {
    method: 'POST',
    body: JSON.stringify({ meter_id: meterBId, image_base64: TINY_PNG_B64 }),
  });
  assert.equal(crossMeter.status, 403);
  assert.equal(crossMeter.body.code, 'ACCESS_DENIED');

  const crossClassify = await apiFetch('/api/v1/ai/classify', managerA.token, {
    method: 'POST',
    body: JSON.stringify({ service_request_id: srBId }),
  });
  assert.equal(crossClassify.status, 403);
  assert.equal(crossClassify.body.code, 'ACCESS_DENIED');

  const crossApply = await apiFetch(`/api/v1/service-requests/${srBId}/apply-triage`, managerA.token, {
    method: 'POST',
    body: JSON.stringify({ category: 'ELECTRICAL', priority: 'HIGH' }),
  });
  assert.equal(crossApply.status, 403);
  assert.equal(crossApply.body.code, 'ACCESS_DENIED');

  const deniedLogs = await adminPool.query(
    `SELECT COUNT(*)::int AS cnt FROM audit_log WHERE actor_id = $1 AND action = 'ACCESS_DENIED'`,
    [managerA.userId]
  );
  assert.ok(deniedLogs.rows[0].cnt >= 3, 'Cross-building AI attempts must write ACCESS_DENIED audit_log');

  // Usage & G6 KPI endpoint: allowed for SYS_ADMIN, OWNER, MANAGER; 403 for RESIDENT
  const usageSys = await apiFetch('/api/v1/ai/usage', sysAdmin.token);
  assert.equal(usageSys.status, 200);
  assert.ok(usageSys.body.data.kpi_g6.total_extract_fields >= 4);
  assert.ok(usageSys.body.data.kpi_g6.exact_field_acceptance_rate_pct > 0);

  const usageResForbidden = await apiFetch('/api/v1/ai/usage', residentA.token);
  assert.equal(usageResForbidden.status, 403);

  // Settings hygiene: exposes ai_runtime.api_key_configured boolean, NEVER leaks raw API key
  const settingsGet = await apiFetch('/api/v1/settings', sysAdmin.token);
  assert.equal(settingsGet.status, 200);
  assert.equal(settingsGet.body.ai_runtime?.api_key_configured, true);
  assert.equal(
    JSON.stringify(settingsGet.body).includes('AIzaSy_M15_ROUTE_TEST_SECRET_DO_NOT_LEAK'),
    false,
    'GET /api/v1/settings must never leak GEMINI_API_KEY'
  );
});
