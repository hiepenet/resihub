import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { adminPool, pool } from '../db/client.js';
import { MAX_IMAGE_BYTES, MAX_CONTRACT_SCAN_BYTES } from './imageUpload.js';
import {
  currentVietnamPeriod,
  resolveChainedReadingBounds,
  selectTargetPeriodContract,
} from './serviceBilling.js';
import {
  loadApartmentPeriodContractsMap,
  loadMeterPeriodReadingsWithLocks,
} from './meterTurnoverContext.js';
import {
  PROMPT_VERSIONS,
  normalizeAiConfig,
  evaluateBudgetGate,
  parseDataUriPayload,
  buildExtractionDbPayload,
  computeFieldAcceptanceDiff,
  postValidateMeterOcr,
  postValidateTicketTriage,
  estimateGeminiCostVnd,
  buildGeminiPromptAndSchema,
} from './aiRules.js';
import { callGeminiStructured, isGeminiApiKeyConfigured } from './geminiClient.js';

const pendingBackgroundTasks = new Set();

export async function flushPendingAiTasksForTest() {
  while (pendingBackgroundTasks.size > 0) {
    await Promise.allSettled([...pendingBackgroundTasks]);
  }
}

function getVietnamMonthStartIso(period = currentVietnamPeriod()) {
  return `${period}-01T00:00:00+07:00`;
}

async function loadOrgAiConfigAndUsage(dbClient, orgId) {
  const period = currentVietnamPeriod();
  const monthStartIso = getVietnamMonthStartIso(period);

  const [cfgRes, usageRes] = await Promise.all([
    dbClient.query(
      `SELECT value FROM system_setting WHERE org_id = $1 AND key = 'ai_config' LIMIT 1`,
      [orgId]
    ),
    dbClient.query(
      `SELECT * FROM fn_get_org_monthly_ai_usage($1::uuid, $2::timestamptz)`,
      [orgId, monthStartIso]
    ),
  ]);

  const aiConfig = normalizeAiConfig(cfgRes.rows[0]?.value || {});
  const usageRow = usageRes.rows[0] || {};
  return {
    period,
    monthStartIso,
    aiConfig,
    monthlyCalls: Number(usageRow.total_calls || 0),
    monthlyTokensUsed: Number(usageRow.total_tokens || 0),
    monthlyCostVnd: Number(usageRow.total_cost_vnd || 0),
  };
}

async function notifySysAdminsBudgetWarningIfNeeded(
  orgId,
  { period, monthlyCostVnd, monthlyBudgetVnd, monthlyTokensUsed, monthlyTokenLimit, warnPercent }
) {
  const sysUsersRes = await adminPool.query(
    `SELECT DISTINCT ur.user_id
     FROM user_role ur
     JOIN role r ON r.id = ur.role_id
     JOIN app_user au ON au.id = ur.user_id
     LEFT JOIN person p ON p.id = au.person_id
     WHERE au.status = 'ACTIVE'
       AND r.code = 'SYS_ADMIN'
       AND COALESCE(p.org_id, r.org_id) = $1::uuid`,
    [orgId]
  );

  if (sysUsersRes.rows.length === 0) return;

  const costPct = Math.round((monthlyCostVnd / Math.max(1, monthlyBudgetVnd)) * 100);
  const tokenPct = Math.round((monthlyTokensUsed / Math.max(1, monthlyTokenLimit)) * 100);
  const maxPct = Math.max(costPct, tokenPct);

  const title = `[CẢNH BÁO CHI PHÍ AI] Đã dùng ${maxPct}% hạn mức AI kỳ ${period}`;
  const content = `Mức tiêu thụ AI Gateway kỳ ${period} đã vượt ngưỡng cảnh báo ${warnPercent}% (${monthlyCostVnd.toLocaleString('vi-VN')} / ${monthlyBudgetVnd.toLocaleString('vi-VN')} ₫; ${monthlyTokensUsed.toLocaleString('vi-VN')} token).`;
  const payload = {
    period,
    monthly_cost_vnd: monthlyCostVnd,
    monthly_budget_vnd: monthlyBudgetVnd,
    monthly_tokens_used: monthlyTokensUsed,
    monthly_token_limit: monthlyTokenLimit,
    warn_percent: warnPercent,
    link: '/admin/settings',
  };

  for (const row of sysUsersRes.rows) {
    await adminPool.query(
      `INSERT INTO notification (org_id, user_id, type, title, content, payload)
       SELECT $1::uuid, $2::uuid, 'AI_BUDGET_WARNING', $3::text, $4::text, $5::jsonb
       WHERE NOT EXISTS (
         SELECT 1 FROM notification n
         WHERE n.org_id = $1::uuid
           AND n.user_id = $2::uuid
           AND n.type = 'AI_BUDGET_WARNING'
           AND (n.payload->>'period') = $6::text
       )`,
      [orgId, row.user_id, title, content, JSON.stringify(payload), period]
    );
  }
}

async function checkGateOrThrow(dbClient, { orgId, taskType }) {
  const ctx = await loadOrgAiConfigAndUsage(dbClient, orgId);
  const gate = evaluateBudgetGate({
    aiConfig: ctx.aiConfig,
    taskType,
    monthlyTokensUsed: ctx.monthlyTokensUsed,
    monthlyCostVnd: ctx.monthlyCostVnd,
  });

  if (!gate.allowed) {
    throw Object.assign(new Error(gate.message), {
      status: gate.code === 'AI_BUDGET_EXCEEDED' ? 429 : 503,
      code: gate.code,
    });
  }

  return ctx;
}

async function evaluatePostCallBudgetAlert(orgId, ctx, addedTokens, addedCostVnd) {
  const nextTokens = ctx.monthlyTokensUsed + Math.max(0, Number(addedTokens) || 0);
  const nextCost = ctx.monthlyCostVnd + Math.max(0, Number(addedCostVnd) || 0);
  const postGate = evaluateBudgetGate({
    aiConfig: ctx.aiConfig,
    taskType: 'METER_OCR',
    monthlyTokensUsed: nextTokens,
    monthlyCostVnd: nextCost,
  });

  if (postGate.warning80Pct) {
    await notifySysAdminsBudgetWarningIfNeeded(orgId, {
      period: ctx.period,
      monthlyCostVnd: nextCost,
      monthlyBudgetVnd: ctx.aiConfig.monthly_budget_vnd,
      monthlyTokensUsed: nextTokens,
      monthlyTokenLimit: ctx.aiConfig.monthly_token_limit,
      warnPercent: ctx.aiConfig.warn_percent,
    }).catch((err) => {
      console.error('[AI Gateway] Failed to emit AI_BUDGET_WARNING:', err.message);
    });
  }
}

export async function runExtractSuggestion(
  dbClient,
  {
    actorId,
    orgId,
    buildingId = null,
    documentType = 'CCCD',
    filesBase64 = [],
    privacyAcknowledged = false,
  } = {}
) {
  const docTypeNorm = String(documentType || 'CCCD').trim().toUpperCase();
  if (!['CCCD', 'CONTRACT'].includes(docTypeNorm)) {
    throw Object.assign(new Error('Loại tài liệu trích xuất phải là CCCD hoặc CONTRACT.'), {
      status: 400,
      code: 'VALIDATION_ERROR',
    });
  }

  if (privacyAcknowledged !== true) {
    throw Object.assign(
      new Error(
        'Vui lòng xác nhận thông báo xử lý dữ liệu cá nhân/hợp đồng bằng AI trước khi trích xuất (PRD 12.5).'
      ),
      { status: 422, code: 'PRIVACY_CONSENT_REQUIRED' }
    );
  }

  const taskType = docTypeNorm === 'CONTRACT' ? 'CONTRACT_EXTRACT' : 'CCCD_EXTRACT';
  const targetEntity = docTypeNorm === 'CONTRACT' ? 'contract' : 'tenant';
  const maxFiles = docTypeNorm === 'CONTRACT' ? 3 : 2;
  const allowPdf = docTypeNorm === 'CONTRACT';
  const maxBytes = docTypeNorm === 'CONTRACT' ? MAX_CONTRACT_SCAN_BYTES : MAX_IMAGE_BYTES;

  if (!Array.isArray(filesBase64) || filesBase64.length === 0 || filesBase64.length > maxFiles) {
    throw Object.assign(
      new Error(`Vui lòng tải lên từ 1 đến ${maxFiles} tệp hợp lệ để trích xuất.`),
      { status: 400, code: 'VALIDATION_ERROR' }
    );
  }

  const parsedFiles = [];
  for (const item of filesBase64) {
    const parsed = parseDataUriPayload(item, { allowPdf, maxBytes });
    if (!parsed.valid) {
      throw Object.assign(new Error(parsed.message), {
        status: 400,
        code: parsed.code || 'VALIDATION_ERROR',
      });
    }
    parsedFiles.push(parsed);
  }

  const ctx = await checkGateOrThrow(dbClient, { orgId, taskType });
  const { systemInstruction, userPrompt, responseSchema } = buildGeminiPromptAndSchema(taskType);

  const geminiRes = await callGeminiStructured({
    model: ctx.aiConfig.model,
    systemInstruction,
    userPrompt,
    inlineFiles: parsedFiles,
    responseSchema,
  });

  const rawJson = geminiRes.parsedJson || {};
  const rawConf = Number(rawJson.confidence);
  const confidence = Number.isFinite(rawConf)
    ? Math.max(0, Math.min(1, Math.round(rawConf * 1000) / 1000))
    : 0;
  const fieldConfidences =
    rawJson.field_confidences && typeof rawJson.field_confidences === 'object'
      ? rawJson.field_confidences
      : {};

  const extractedFields =
    docTypeNorm === 'CCCD'
      ? {
          full_name: String(rawJson.full_name || '').trim(),
          id_number: String(rawJson.id_number || '').replace(/\D+/g, ''),
          dob: String(rawJson.dob || '').trim(),
          issue_date: String(rawJson.issue_date || '').trim(),
          permanent_address: String(rawJson.permanent_address || '').trim(),
        }
      : {
          tenant_full_name: String(rawJson.tenant_full_name || '').trim(),
          tenant_phone: String(rawJson.tenant_phone || '').replace(/[^\d+]/g, ''),
          tenant_id_number: String(rawJson.tenant_id_number || '').replace(/\D+/g, ''),
          apartment_code: String(rawJson.apartment_code || '').trim(),
          start_date: String(rawJson.start_date || '').trim(),
          end_date: String(rawJson.end_date || '').trim(),
          rent_amount:
            rawJson.rent_amount !== null && rawJson.rent_amount !== undefined
              ? Math.max(0, Math.round(Number(rawJson.rent_amount) || 0)) || null
              : null,
          deposit_amount:
            rawJson.deposit_amount !== null && rawJson.deposit_amount !== undefined
              ? Math.max(0, Math.round(Number(rawJson.deposit_amount) || 0)) || null
              : null,
          billing_day:
            rawJson.billing_day !== null && rawJson.billing_day !== undefined
              ? Math.min(31, Math.max(1, Math.round(Number(rawJson.billing_day) || 1)))
              : null,
          payment_due_days:
            rawJson.payment_due_days !== null && rawJson.payment_due_days !== undefined
              ? Math.max(0, Math.round(Number(rawJson.payment_due_days) || 0))
              : null,
          terms_note: String(rawJson.terms_note || '').trim(),
        };

  const warnings = [];
  const needsHumanReview = confidence < ctx.aiConfig.confidence_threshold;
  if (needsHumanReview) {
    warnings.push('LOW_CONFIDENCE_EXTRACTION');
  }

  const { redactedOutput, totalFieldsCount } = buildExtractionDbPayload(
    taskType,
    extractedFields,
    fieldConfidences
  );
  const usedModel = geminiRes.modelVersion || ctx.aiConfig.model;
  const estimatedCostVnd = estimateGeminiCostVnd({
    inputTokens: geminiRes.inputTokens,
    outputTokens: geminiRes.outputTokens,
    model: usedModel,
  });

  const inputRef = {
    document_type: docTypeNorm,
    file_count: parsedFiles.length,
    files: parsedFiles.map((f) => ({
      mime_type: f.mimeType,
      bytes: f.byteLength,
      sha256: f.sha256Hex,
    })),
    privacy_acknowledged: true,
  };

  const insRes = await dbClient.query(
    `INSERT INTO ai_suggestion (
      org_id, building_id, task_type, target_entity, input_ref, output, warnings,
      confidence, needs_human_review, total_fields_count, model, prompt_version,
      input_tokens, output_tokens, estimated_cost_vnd, latency_ms, status, created_by,
      expires_at
    ) VALUES (
      $1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb,
      $8, $9, $10, $11, $12,
      $13, $14, $15, $16, 'PENDING', $17,
      NOW() + make_interval(hours => $18::int)
    )
    RETURNING id, created_at, expires_at`,
    [
      orgId,
      buildingId || null,
      taskType,
      targetEntity,
      JSON.stringify(inputRef),
      JSON.stringify(redactedOutput),
      JSON.stringify(warnings),
      confidence,
      needsHumanReview,
      totalFieldsCount,
      usedModel,
      PROMPT_VERSIONS[taskType],
      geminiRes.inputTokens,
      geminiRes.outputTokens,
      estimatedCostVnd,
      geminiRes.latencyMs,
      actorId,
      ctx.aiConfig.suggestion_ttl_hours,
    ]
  );

  const suggestionId = insRes.rows[0].id;
  await dbClient.query(
    `INSERT INTO audit_log (actor_id, action, entity, entity_id, after)
     VALUES ($1, 'CREATE_AI_SUGGESTION', 'ai_suggestion', $2, $3::jsonb)`,
    [
      actorId,
      suggestionId,
      JSON.stringify({
        task_type: taskType,
        confidence,
        needs_human_review: needsHumanReview,
        model: usedModel,
      }),
    ]
  );

  await evaluatePostCallBudgetAlert(
    orgId,
    ctx,
    geminiRes.inputTokens + geminiRes.outputTokens,
    estimatedCostVnd
  );

  return {
    suggestion_id: suggestionId,
    task: taskType.toLowerCase(),
    output: extractedFields,
    field_confidences: fieldConfidences,
    confidence,
    needs_human_review: needsHumanReview,
    model: usedModel,
    warnings,
    expires_at: insRes.rows[0].expires_at,
  };
}

export async function runMeterOcrSuggestion(
  dbClient,
  { actorId, orgId, buildingId, meterId, period = currentVietnamPeriod(), imageBase64 } = {}
) {
  const parsedImg = parseDataUriPayload(imageBase64, {
    allowPdf: false,
    maxBytes: MAX_IMAGE_BYTES,
  });
  if (!parsedImg.valid) {
    throw Object.assign(new Error(parsedImg.message), {
      status: 400,
      code: parsedImg.code || 'VALIDATION_ERROR',
    });
  }

  // Zero-PII query: chỉ lấy thông số đồng hồ & chỉ số lịch sử, tuyệt đối không JOIN tenant/person (PRD 12.3)
  const meterRes = await dbClient.query(
    `SELECT m.id, m.org_id, m.building_id, m.apartment_id, m.meter_type, m.meter_code, m.unit, m.initial_reading,
            a.code AS apartment_code
     FROM meter m
     JOIN apartment a ON a.id = m.apartment_id
     WHERE m.id = $1 AND m.org_id = $2
     LIMIT 1`,
    [meterId, orgId]
  );

  if (meterRes.rows.length === 0) {
    throw Object.assign(new Error('Không tìm thấy đồng hồ điện/nước.'), {
      status: 404,
      code: 'NOT_FOUND',
    });
  }
  const meter = meterRes.rows[0];
  const effectiveBuildingId = buildingId || meter.building_id;

  const [histRes, billingCfgRes, contractsByApt] = await Promise.all([
    dbClient.query(
      `SELECT period, current_reading, consumption, status
       FROM meter_reading
       WHERE meter_id = $1 AND period < $2
       ORDER BY period DESC, current_reading DESC, recorded_at DESC
       LIMIT 3`,
      [meter.id, period]
    ),
    dbClient.query(
      `SELECT value FROM system_setting WHERE org_id = $1 AND key = 'billing_config' LIMIT 1`,
      [orgId]
    ),
    loadApartmentPeriodContractsMap(dbClient, [meter.apartment_id], period),
  ]);

  const overlappingContracts = contractsByApt.get(String(meter.apartment_id)) || [];
  const samePeriodMap = await loadMeterPeriodReadingsWithLocks(
    dbClient,
    [meter.id],
    period,
    contractsByApt
  );
  const samePeriodReadings = samePeriodMap.get(String(meter.id)) || [];
  const { targetContract, slotIndex } = selectTargetPeriodContract(overlappingContracts);
  const targetContractId = targetContract ? targetContract.contract_id : null;
  const existingSlotRow = targetContractId
    ? samePeriodReadings.find((r) => String(r.contract_id) === String(targetContractId)) ||
      (slotIndex <= 1 ? samePeriodReadings.find((r) => !r.contract_id && !r.is_billed) : null)
    : samePeriodReadings.find((r) => !r.contract_id) || null;

  const { previousReading: previousValue } = resolveChainedReadingBounds({
    priorPeriodReading: histRes.rows[0] || null,
    samePeriodReadings,
    nextPeriodReading: null,
    overlappingContracts,
    targetContractId,
    existingReadingId: existingSlotRow?.id || null,
    initialReading: meter.initial_reading,
  });

  const confirmedConsumptions = histRes.rows
    .filter((r) => r.status === 'CONFIRMED' && Number(r.consumption) > 0)
    .map((r) => Number(r.consumption));
  const baselineAvgConsumption =
    confirmedConsumptions.length > 0
      ? confirmedConsumptions.reduce((acc, v) => acc + v, 0) / confirmedConsumptions.length
      : null;

  const anomalyThresholdPct =
    Number(billingCfgRes.rows[0]?.value?.meter_anomaly_threshold_pct) || 30;

  const ctx = await checkGateOrThrow(dbClient, { orgId, taskType: 'METER_OCR' });
  const { systemInstruction, userPrompt, responseSchema } = buildGeminiPromptAndSchema(
    'METER_OCR',
    {
      meterType: meter.meter_type,
      meterCode: meter.meter_code,
      previousValue,
    }
  );

  const geminiRes = await callGeminiStructured({
    model: ctx.aiConfig.model,
    systemInstruction,
    userPrompt,
    inlineFiles: [parsedImg],
    responseSchema,
  });

  const validated = postValidateMeterOcr({
    rawModelJson: geminiRes.parsedJson,
    previousValue,
    baselineAvgConsumption,
    anomalyThresholdPct,
    confidenceThreshold: ctx.aiConfig.meter_ocr_threshold,
  });

  const estimatedConsumption =
    validated.reading !== null && validated.reading >= previousValue
      ? Math.round((validated.reading - previousValue) * 100) / 100
      : null;

  const outputPayload = {
    reading: validated.reading,
    unit: meter.unit,
    previous_value: previousValue,
    estimated_consumption: estimatedConsumption,
    reason: validated.reason,
  };

  const usedModel = geminiRes.modelVersion || ctx.aiConfig.model;
  const estimatedCostVnd = estimateGeminiCostVnd({
    inputTokens: geminiRes.inputTokens,
    outputTokens: geminiRes.outputTokens,
    model: usedModel,
  });

  const insRes = await dbClient.query(
    `INSERT INTO ai_suggestion (
      org_id, building_id, task_type, target_entity, input_ref, output, warnings,
      confidence, needs_human_review, total_fields_count, model, prompt_version,
      input_tokens, output_tokens, estimated_cost_vnd, latency_ms, status, created_by,
      expires_at
    ) VALUES (
      $1, $2, 'METER_OCR', 'meter_reading', $3::jsonb, $4::jsonb, $5::jsonb,
      $6, $7, $8, $9, $10,
      $11, $12, $13, $14, 'PENDING', $15,
      NOW() + make_interval(hours => $16::int)
    )
    RETURNING id, expires_at`,
    [
      orgId,
      effectiveBuildingId,
      JSON.stringify({
        meter_id: meter.id,
        apartment_id: meter.apartment_id,
        period,
        sha256: parsedImg.sha256Hex,
      }),
      JSON.stringify(outputPayload),
      JSON.stringify(validated.warnings),
      validated.confidence,
      validated.needsHumanReview,
      validated.reading !== null ? 1 : 0,
      usedModel,
      PROMPT_VERSIONS.METER_OCR,
      geminiRes.inputTokens,
      geminiRes.outputTokens,
      estimatedCostVnd,
      geminiRes.latencyMs,
      actorId,
      ctx.aiConfig.suggestion_ttl_hours,
    ]
  );

  const suggestionId = insRes.rows[0].id;
  await dbClient.query(
    `INSERT INTO audit_log (actor_id, action, entity, entity_id, after)
     VALUES ($1, 'CREATE_AI_SUGGESTION', 'ai_suggestion', $2, $3::jsonb)`,
    [
      actorId,
      suggestionId,
      JSON.stringify({
        task_type: 'METER_OCR',
        meter_id: meter.id,
        reading: validated.reading,
        confidence: validated.confidence,
        needs_human_review: validated.needsHumanReview,
        model: usedModel,
      }),
    ]
  );

  await evaluatePostCallBudgetAlert(
    orgId,
    ctx,
    geminiRes.inputTokens + geminiRes.outputTokens,
    estimatedCostVnd
  );

  return {
    suggestion_id: suggestionId,
    task: 'meter_reading_ocr',
    output: outputPayload,
    confidence: validated.confidence,
    needs_human_review: validated.needsHumanReview,
    model: usedModel,
    warnings: validated.warnings,
    expires_at: insRes.rows[0].expires_at,
  };
}

async function loadAttachmentImagesForTriage(imageUrls = []) {
  const inlineFiles = [];
  if (!Array.isArray(imageUrls)) return inlineFiles;

  for (const rawUrl of imageUrls.slice(0, 2)) {
    const match = /\/attachments\/([0-9a-f-]{36})\/view/i.exec(String(rawUrl || ''));
    if (!match) continue;
    try {
      const attRes = await adminPool.query(
        `SELECT storage_path, mime FROM attachment WHERE id = $1 LIMIT 1`,
        [match[1]]
      );
      const att = attRes.rows[0];
      if (!att?.storage_path || !String(att.mime || '').startsWith('image/')) continue;
      const diskBytes = await readFile(path.resolve(process.cwd(), att.storage_path));
      if (diskBytes.length > 0 && diskBytes.length <= MAX_IMAGE_BYTES) {
        inlineFiles.push({
          mimeType: att.mime,
          base64Data: diskBytes.toString('base64'),
        });
      }
    } catch {
      // Non-fatal: continue triage using text description
    }
  }
  return inlineFiles;
}

export async function runTicketTriageSuggestion(
  dbClient,
  { actorId, orgId, buildingId, serviceRequestId, useBackgroundRpc = false } = {}
) {
  const srRes = await dbClient.query(
    `SELECT sr.id, sr.org_id, sr.building_id, sr.apartment_id, sr.category, sr.title, sr.description, sr.images,
            a.code AS apartment_code
     FROM service_request sr
     JOIN apartment a ON a.id = sr.apartment_id
     WHERE sr.id = $1 AND sr.org_id = $2
     LIMIT 1`,
    [serviceRequestId, orgId]
  );

  if (srRes.rows.length === 0) {
    throw Object.assign(new Error('Không tìm thấy yêu cầu báo hỏng.'), {
      status: 404,
      code: 'NOT_FOUND',
    });
  }
  const sr = srRes.rows[0];
  const effectiveBuildingId = buildingId || sr.building_id;

  let ctx;
  try {
    ctx = await checkGateOrThrow(dbClient, { orgId, taskType: 'TICKET_TRIAGE' });
  } catch (gateErr) {
    if (useBackgroundRpc) {
      await dbClient.query(
        `SELECT fn_record_background_ticket_triage(
          $1::uuid, 'SKIPPED', NULL, NULL, NULL, NULL, NULL,
          '{}'::jsonb, '[]'::jsonb, TRUE, 'gemini-3.8-flash', $2::text, 0, 0, 0, 0, $3::text
        )`,
        [sr.id, PROMPT_VERSIONS.TICKET_TRIAGE, gateErr.code || 'AI_DISABLED']
      );
      return {
        suggestion_id: null,
        task: 'ticket_triage',
        triage_status: 'SKIPPED',
        code: gateErr.code,
      };
    }
    throw gateErr;
  }

  const [historyRes, assigneesRes, inlineFiles] = await Promise.all([
    adminPool.query(
      `SELECT category, title, description, status
       FROM service_request
       WHERE apartment_id = $1 AND id <> $2
       ORDER BY created_at DESC
       LIMIT 5`,
      [sr.apartment_id, sr.id]
    ),
    adminPool.query(
      `SELECT DISTINCT au.id, p.full_name
       FROM app_user au
       JOIN person p ON p.id = au.person_id
       JOIN user_role ur ON ur.user_id = au.id
       JOIN role r ON r.id = ur.role_id
       WHERE au.status = 'ACTIVE'
         AND r.code = 'MANAGER'
         AND ur.building_id = $1
       ORDER BY p.full_name ASC`,
      [effectiveBuildingId]
    ),
    loadAttachmentImagesForTriage(sr.images),
  ]);

  const assignees = assigneesRes.rows;
  const { systemInstruction, userPrompt, responseSchema } = buildGeminiPromptAndSchema(
    'TICKET_TRIAGE',
    {
      apartmentCode: sr.apartment_code,
      title: sr.title,
      categoryHint: sr.category,
      description: sr.description,
      recentHistory: historyRes.rows,
      assignees,
    }
  );

  let geminiRes;
  try {
    geminiRes = await callGeminiStructured({
      model: ctx.aiConfig.model,
      systemInstruction,
      userPrompt,
      inlineFiles,
      responseSchema,
    });
  } catch (upstreamErr) {
    if (useBackgroundRpc) {
      await dbClient.query(
        `SELECT fn_record_background_ticket_triage(
          $1::uuid, 'FAILED', NULL, NULL, NULL, NULL, NULL,
          '{}'::jsonb, '[]'::jsonb, TRUE, $2::text, $3::text, 0, 0, 0, 0, $4::text
        )`,
        [
          sr.id,
          ctx.aiConfig.model,
          PROMPT_VERSIONS.TICKET_TRIAGE,
          upstreamErr.code || 'AI_UPSTREAM_ERROR',
        ]
      );
      return {
        suggestion_id: null,
        task: 'ticket_triage',
        triage_status: 'FAILED',
        code: upstreamErr.code || 'AI_UPSTREAM_ERROR',
      };
    }
    throw upstreamErr;
  }

  const validated = postValidateTicketTriage({
    rawModelJson: geminiRes.parsedJson,
    description: `${sr.title || ''} ${sr.description || ''}`,
    allowedAssigneeIds: assignees.map((a) => a.id),
    confidenceThreshold: ctx.aiConfig.triage_threshold,
  });

  const matchedAssignee = assignees.find((a) => a.id === validated.suggestedAssigneeId) || null;
  const outputPayload = {
    category: validated.category,
    priority: validated.priority,
    suggested_assignee_id: validated.suggestedAssigneeId,
    suggested_assignee_name: matchedAssignee?.full_name || null,
    summary: validated.summary,
    triage_status: validated.triageStatus,
  };

  const usedModel = geminiRes.modelVersion || ctx.aiConfig.model;
  const estimatedCostVnd = estimateGeminiCostVnd({
    inputTokens: geminiRes.inputTokens,
    outputTokens: geminiRes.outputTokens,
    model: usedModel,
  });

  let suggestionId = null;
  if (useBackgroundRpc) {
    const rpcRes = await dbClient.query(
      `SELECT fn_record_background_ticket_triage(
        $1::uuid, $2::text, $3::text, $4::text, $5::uuid, $6::text, $7::numeric,
        $8::jsonb, $9::jsonb, $10::boolean, $11::text, $12::text,
        $13::int, $14::int, $15::bigint, $16::int, NULL
      ) AS suggestion_id`,
      [
        sr.id,
        validated.triageStatus,
        validated.category,
        validated.priority,
        validated.suggestedAssigneeId,
        validated.summary,
        validated.confidence,
        JSON.stringify(outputPayload),
        JSON.stringify(validated.warnings),
        validated.needsHumanReview,
        usedModel,
        PROMPT_VERSIONS.TICKET_TRIAGE,
        geminiRes.inputTokens,
        geminiRes.outputTokens,
        estimatedCostVnd,
        geminiRes.latencyMs,
      ]
    );
    suggestionId = rpcRes.rows[0]?.suggestion_id || null;
  } else {
    const insRes = await dbClient.query(
      `INSERT INTO ai_suggestion (
        org_id, building_id, task_type, target_entity, target_entity_id,
        input_ref, output, warnings, confidence, needs_human_review, total_fields_count,
        model, prompt_version, input_tokens, output_tokens, estimated_cost_vnd, latency_ms,
        status, created_by, expires_at
      ) VALUES (
        $1, $2, 'TICKET_TRIAGE', 'service_request', $3,
        $4::jsonb, $5::jsonb, $6::jsonb, $7, $8, $9,
        $10, $11, $12, $13, $14, $15,
        'PENDING', $16, NOW() + make_interval(hours => $17::int)
      )
      RETURNING id`,
      [
        orgId,
        effectiveBuildingId,
        sr.id,
        JSON.stringify({ service_request_id: sr.id, apartment_id: sr.apartment_id }),
        JSON.stringify(outputPayload),
        JSON.stringify(validated.warnings),
        validated.confidence,
        validated.needsHumanReview,
        validated.category && validated.priority ? 2 : 0,
        usedModel,
        PROMPT_VERSIONS.TICKET_TRIAGE,
        geminiRes.inputTokens,
        geminiRes.outputTokens,
        estimatedCostVnd,
        geminiRes.latencyMs,
        actorId,
        ctx.aiConfig.suggestion_ttl_hours,
      ]
    );
    suggestionId = insRes.rows[0].id;

    await dbClient.query(
      `UPDATE service_request
       SET ai_suggestion_id = $1,
           ai_triage_status = $2,
           ai_summary = $3,
           ai_suggested_category = $4,
           ai_suggested_priority = $5,
           ai_suggested_assignee_id = $6,
           ai_confidence = $7,
           updated_at = NOW()
       WHERE id = $8`,
      [
        suggestionId,
        validated.triageStatus,
        validated.summary,
        validated.category,
        validated.priority,
        validated.suggestedAssigneeId,
        validated.confidence,
        sr.id,
      ]
    );

    await dbClient.query(
      `INSERT INTO audit_log (actor_id, action, entity, entity_id, after)
       VALUES ($1, 'CREATE_AI_SUGGESTION', 'ai_suggestion', $2, $3::jsonb)`,
      [
        actorId,
        suggestionId,
        JSON.stringify({
          task_type: 'TICKET_TRIAGE',
          service_request_id: sr.id,
          triage_status: validated.triageStatus,
          confidence: validated.confidence,
        }),
      ]
    );
  }

  await evaluatePostCallBudgetAlert(
    orgId,
    ctx,
    geminiRes.inputTokens + geminiRes.outputTokens,
    estimatedCostVnd
  );

  return {
    suggestion_id: suggestionId,
    task: 'ticket_triage',
    output: outputPayload,
    confidence: validated.confidence,
    needs_human_review: validated.needsHumanReview,
    model: ctx.aiConfig.model,
    warnings: validated.warnings,
  };
}

export function triggerAsyncTicketTriage({ actorId, orgId, buildingId, serviceRequestId }) {
  const jobPromise = (async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.current_user_id', $1, true)", [String(actorId)]);
      await runTicketTriageSuggestion(client, {
        actorId,
        orgId,
        buildingId,
        serviceRequestId,
        useBackgroundRpc: true,
      });
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('[AI-03 Async Triage Error]:', err.message);
    } finally {
      client.release();
    }
  })();

  pendingBackgroundTasks.add(jobPromise);
  jobPromise.finally(() => pendingBackgroundTasks.delete(jobPromise));
  return jobPromise;
}

export async function reviewAiSuggestion(
  dbClient,
  { suggestionId, actorId, decision = 'ACCEPT', finalValues = {}, targetEntityId = null } = {}
) {
  const decNorm = String(decision || 'ACCEPT').trim().toUpperCase();
  if (!['ACCEPT', 'REJECT'].includes(decNorm)) {
    throw Object.assign(new Error('Quyết định duyệt gợi ý AI phải là ACCEPT hoặc REJECT.'), {
      status: 400,
      code: 'VALIDATION_ERROR',
    });
  }

  let rowRes;
  try {
    rowRes = await dbClient.query(
      `SELECT * FROM ai_suggestion WHERE id = $1 FOR UPDATE`,
      [suggestionId]
    );
  } catch (err) {
    if (err?.code === '42501') {
      throw Object.assign(
        new Error('Bạn không có quyền duyệt hoặc cập nhật bản nháp gợi ý AI này.'),
        { status: 403, code: 'ACCESS_DENIED' }
      );
    }
    throw err;
  }
  if (rowRes.rows.length === 0) {
    const scopeCheck = await dbClient.query(
      `SELECT resource_id FROM fn_get_ops_resource_scope('ai_suggestion', $1::uuid)`,
      [suggestionId]
    );
    if (scopeCheck.rows.length > 0) {
      throw Object.assign(
        new Error('Bạn không có quyền duyệt hoặc cập nhật bản nháp gợi ý AI này.'),
        { status: 403, code: 'ACCESS_DENIED' }
      );
    }
    throw Object.assign(new Error('Không tìm thấy bản nháp gợi ý AI.'), {
      status: 404,
      code: 'NOT_FOUND',
    });
  }
  const row = rowRes.rows[0];

  if (targetEntityId !== null && targetEntityId !== undefined && String(targetEntityId).trim() !== '') {
    const rawTargetId = String(targetEntityId).trim();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rawTargetId)) {
      throw Object.assign(new Error('Mã bản ghi đích (target_entity_id) không hợp lệ.'), {
        status: 400,
        code: 'VALIDATION_ERROR',
      });
    }
    let targetScopeSql = null;
    if (row.target_entity === 'tenant') {
      targetScopeSql = `SELECT t.id, p.org_id, NULL::uuid AS building_id
                        FROM tenant t JOIN person p ON p.id = t.person_id
                        WHERE t.id = $1`;
    } else if (row.target_entity === 'contract') {
      targetScopeSql = `SELECT c.id, b.org_id, a.building_id
                        FROM contract c
                        JOIN apartment a ON a.id = c.apartment_id
                        JOIN building b ON b.id = a.building_id
                        WHERE c.id = $1`;
    } else if (row.target_entity === 'meter_reading') {
      targetScopeSql = `SELECT mr.id, m.org_id, m.building_id
                        FROM meter_reading mr
                        JOIN meter m ON m.id = mr.meter_id
                        WHERE mr.id = $1`;
    } else if (row.target_entity === 'service_request') {
      targetScopeSql = `SELECT sr.id, sr.org_id, sr.building_id
                        FROM service_request sr
                        WHERE sr.id = $1`;
    }

    if (targetScopeSql) {
      const targetScopeRes = await dbClient.query(targetScopeSql, [rawTargetId]);
      const targetScope = targetScopeRes.rows[0];
      if (
        !targetScope ||
        targetScope.org_id !== row.org_id ||
        (row.building_id && targetScope.building_id && targetScope.building_id !== row.building_id)
      ) {
        throw Object.assign(
          new Error('Bản ghi đích không tồn tại hoặc nằm ngoài phạm vi tòa nhà của gợi ý AI.'),
          { status: 403, code: 'ACCESS_DENIED' }
        );
      }
    }
  }

  if (row.status !== 'PENDING') {
    throw Object.assign(
      new Error(`Gợi ý AI đã ở trạng thái ${row.status}, không thể duyệt lại.`),
      { status: 409, code: 'SUGGESTION_NOT_PENDING' }
    );
  }

  if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) {
    await dbClient.query(
      `UPDATE ai_suggestion SET status = 'EXPIRED', updated_at = NOW() WHERE id = $1`,
      [suggestionId]
    );
    throw Object.assign(new Error('Bản nháp gợi ý AI đã hết hạn 72 giờ.'), {
      status: 409,
      code: 'SUGGESTION_EXPIRED',
    });
  }

  let nextStatus = 'REJECTED';
  let acceptedFieldsCount = 0;
  let totalFieldsCount = Number(row.total_fields_count || 0);
  let safeEditedOutput = null;

  if (decNorm === 'ACCEPT') {
    const storedHashes = row.output?.field_hashes;
    if (storedHashes && Object.keys(storedHashes).length > 0) {
      const diff = computeFieldAcceptanceDiff({
        fieldHashes: storedHashes,
        finalValues,
      });
      nextStatus = diff.status;
      acceptedFieldsCount = diff.acceptedFieldsCount;
      totalFieldsCount = diff.totalFieldsCount;
      const { redactedOutput } = buildExtractionDbPayload(row.task_type, finalValues, {});
      safeEditedOutput = redactedOutput;
    } else if (row.task_type === 'METER_OCR') {
      totalFieldsCount = row.output?.reading !== null && row.output?.reading !== undefined ? 1 : 0;
      const sameReading =
        totalFieldsCount === 1 &&
        finalValues?.reading_value !== undefined &&
        Math.abs(Number(finalValues.reading_value) - Number(row.output.reading)) < 0.001;
      acceptedFieldsCount = sameReading ? 1 : 0;
      nextStatus = totalFieldsCount === 0 || sameReading ? 'ACCEPTED' : 'EDITED_ACCEPTED';
      safeEditedOutput = finalValues || null;
    } else if (row.task_type === 'TICKET_TRIAGE') {
      const suggCat = row.output?.category || null;
      const suggPrio = row.output?.priority || null;
      totalFieldsCount = suggCat && suggPrio ? 2 : 0;
      let matched = 0;
      if (suggCat && finalValues?.category === suggCat) matched += 1;
      if (suggPrio && finalValues?.priority === suggPrio) matched += 1;
      acceptedFieldsCount = matched;
      nextStatus = totalFieldsCount > 0 && matched === totalFieldsCount ? 'ACCEPTED' : 'EDITED_ACCEPTED';
      safeEditedOutput = finalValues || null;
    } else {
      nextStatus = 'ACCEPTED';
    }
  }

  const updateRes = await dbClient.query(
    `UPDATE ai_suggestion
     SET status = $1,
         edited_output = COALESCE($2::jsonb, edited_output),
         accepted_fields_count = $3,
         total_fields_count = $4,
         target_entity_id = COALESCE($5::uuid, target_entity_id),
         reviewed_by = $6,
         reviewed_at = NOW(),
         updated_at = NOW()
     WHERE id = $7`,
    [
      nextStatus,
      safeEditedOutput ? JSON.stringify(safeEditedOutput) : null,
      acceptedFieldsCount,
      totalFieldsCount,
      targetEntityId || null,
      actorId,
      suggestionId,
    ]
  );
  if (updateRes.rowCount === 0) {
    throw Object.assign(
      new Error('Bạn không có quyền cập nhật bản nháp gợi ý AI này.'),
      { status: 403, code: 'ACCESS_DENIED' }
    );
  }

  await dbClient.query(
    `INSERT INTO audit_log (actor_id, action, entity, entity_id, after)
     VALUES ($1, 'REVIEW_AI_SUGGESTION', 'ai_suggestion', $2, $3::jsonb)`,
    [
      actorId,
      suggestionId,
      JSON.stringify({
        status: nextStatus,
        accepted_fields_count: acceptedFieldsCount,
        total_fields_count: totalFieldsCount,
        target_entity_id: targetEntityId || row.target_entity_id || null,
      }),
    ]
  );

  return {
    id: suggestionId,
    status: nextStatus,
    acceptedFieldsCount,
    totalFieldsCount,
  };
}

export async function getOrgAiUsageSummary(dbClient, { orgId, buildingId = null } = {}) {
  const ctx = await loadOrgAiConfigAndUsage(dbClient, orgId);

  const params = [orgId, ctx.monthStartIso];
  let bldgClause = '';
  if (buildingId) {
    params.push(buildingId);
    bldgClause = `AND s.building_id = $${params.length}::uuid`;
  }

  const kpiRes = await dbClient.query(
    `SELECT
       COUNT(*)::int AS visible_calls,
       COALESCE(SUM(accepted_fields_count) FILTER (
         WHERE task_type IN ('CCCD_EXTRACT', 'CONTRACT_EXTRACT')
           AND status IN ('ACCEPTED', 'EDITED_ACCEPTED')
       ), 0)::int AS accepted_extract_fields,
       COALESCE(SUM(total_fields_count) FILTER (
         WHERE task_type IN ('CCCD_EXTRACT', 'CONTRACT_EXTRACT')
           AND status IN ('ACCEPTED', 'EDITED_ACCEPTED')
       ), 0)::int AS total_extract_fields,
       COUNT(*) FILTER (
         WHERE task_type = 'TICKET_TRIAGE' AND status = 'ACCEPTED'
       )::int AS triage_kept_count,
       COUNT(*) FILTER (
         WHERE task_type = 'TICKET_TRIAGE' AND status IN ('ACCEPTED', 'EDITED_ACCEPTED', 'REJECTED')
       )::int AS triage_reviewed_count,
       COUNT(*) FILTER (WHERE task_type = 'CCCD_EXTRACT')::int AS cccd_calls,
       COUNT(*) FILTER (WHERE task_type = 'CONTRACT_EXTRACT')::int AS contract_calls,
       COUNT(*) FILTER (WHERE task_type = 'METER_OCR')::int AS meter_ocr_calls,
       COUNT(*) FILTER (WHERE task_type = 'TICKET_TRIAGE')::int AS triage_calls
     FROM ai_suggestion s
     WHERE s.org_id = $1::uuid
       AND s.created_at >= $2::timestamptz
       ${bldgClause}`,
    params
  );

  const k = kpiRes.rows[0] || {};
  const exactFieldAcceptanceRatePct =
    k.total_extract_fields > 0
      ? Math.round((k.accepted_extract_fields / k.total_extract_fields) * 1000) / 10
      : null;
  const triageKeepRatePct =
    k.triage_reviewed_count > 0
      ? Math.round((k.triage_kept_count / k.triage_reviewed_count) * 1000) / 10
      : null;

  const costPct =
    Math.round((ctx.monthlyCostVnd / Math.max(1, ctx.aiConfig.monthly_budget_vnd)) * 1000) / 10;
  const tokenPct =
    Math.round((ctx.monthlyTokensUsed / Math.max(1, ctx.aiConfig.monthly_token_limit)) * 1000) / 10;

  return {
    period: ctx.period,
    api_key_configured: isGeminiApiKeyConfigured(),
    enabled: ctx.aiConfig.enabled,
    model: ctx.aiConfig.model,
    monthly_calls: ctx.monthlyCalls,
    monthly_tokens_used: ctx.monthlyTokensUsed,
    monthly_token_limit: ctx.aiConfig.monthly_token_limit,
    monthly_token_pct: tokenPct,
    monthly_cost_vnd: ctx.monthlyCostVnd,
    monthly_budget_vnd: ctx.aiConfig.monthly_budget_vnd,
    monthly_budget_pct: costPct,
    warn_percent: ctx.aiConfig.warn_percent,
    warn_triggered:
      costPct >= ctx.aiConfig.warn_percent || tokenPct >= ctx.aiConfig.warn_percent,
    kpi_g6: {
      exact_field_acceptance_rate_pct: exactFieldAcceptanceRatePct,
      accepted_extract_fields: k.accepted_extract_fields || 0,
      total_extract_fields: k.total_extract_fields || 0,
      target_pct: 70,
      triage_keep_rate_pct: triageKeepRatePct,
      triage_kept_count: k.triage_kept_count || 0,
      triage_reviewed_count: k.triage_reviewed_count || 0,
      triage_target_pct: 80,
    },
    breakdown: {
      cccd_calls: k.cccd_calls || 0,
      contract_calls: k.contract_calls || 0,
      meter_ocr_calls: k.meter_ocr_calls || 0,
      triage_calls: k.triage_calls || 0,
    },
  };
}

