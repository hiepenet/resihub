import { env } from '../config/env.js';
import { resolveSupportedGeminiModel } from './aiRules.js';

const INTERACTIONS_API_REVISION = '2026-05-20';
const FALLBACK_FLASH_MODELS = [
  'gemini-3.6-flash',
  'gemini-3-flash-preview',
  'gemini-3.7-flash',
  'gemini-3.1-flash-lite',
  'gemini-3.5-flash-lite',
];
const MODEL_COOLDOWN_MS = 45 * 1000;
const DEFAULT_PER_ATTEMPT_TIMEOUT_MS = 8500;

let transportOverride = null;
let apiKeyOverride = null;
const modelCooldownUntil = new Map();

export function setGeminiTransportForTest(fn) {
  transportOverride = typeof fn === 'function' ? fn : null;
  modelCooldownUntil.clear();
}

export function setGeminiApiKeyOverrideForTest(keyOrNull) {
  apiKeyOverride = keyOrNull === null || keyOrNull === undefined ? null : String(keyOrNull);
}

export function isGeminiApiKeyConfigured() {
  const effectiveKey =
    apiKeyOverride !== null
      ? apiKeyOverride
      : String(process.env.GEMINI_API_KEY ?? env.geminiApiKey ?? '').trim();
  return Boolean(effectiveKey);
}

function resolveEffectiveApiKey() {
  if (apiKeyOverride !== null) {
    return apiKeyOverride.trim();
  }
  return String(process.env.GEMINI_API_KEY ?? env.geminiApiKey ?? '').trim();
}

function scrubSecrets(message, apiKey) {
  let clean = String(message || 'Lỗi kết nối dịch vụ AI.');
  if (apiKey) {
    clean = clean.split(apiKey).join('[REDACTED_KEY]');
  }
  clean = clean.replace(/AIza[0-9A-Za-z_-]{10,}/g, '[REDACTED_KEY]');
  return clean;
}

export function toInteractionsJsonSchema(schema) {
  if (!schema || typeof schema !== 'object') {
    return null;
  }

  const out = {};
  const rawType = schema.type;
  const isNullable = schema.nullable === true;

  if (Array.isArray(rawType)) {
    const normalized = rawType.map((t) => String(t).toLowerCase());
    if (isNullable && !normalized.includes('null')) {
      normalized.push('null');
    }
    out.type = normalized;
  } else if (typeof rawType === 'string' && rawType.trim()) {
    const lowerType = rawType.trim().toLowerCase();
    out.type = isNullable ? [lowerType, 'null'] : lowerType;
  }

  if (Array.isArray(schema.enum)) {
    out.enum = isNullable && !schema.enum.includes(null) ? [...schema.enum, null] : [...schema.enum];
  }

  if (schema.description) {
    out.description = String(schema.description);
  }

  if (schema.properties && typeof schema.properties === 'object') {
    out.properties = {};
    for (const [key, propSchema] of Object.entries(schema.properties)) {
      const converted = toInteractionsJsonSchema(propSchema);
      if (converted) {
        out.properties[key] = converted;
      }
    }
  }

  if (schema.items && typeof schema.items === 'object') {
    const convertedItems = toInteractionsJsonSchema(schema.items);
    if (convertedItems) {
      out.items = convertedItems;
    }
  }

  if (Array.isArray(schema.required) && schema.required.length > 0) {
    out.required = [...schema.required];
  }

  return out;
}

function resolveGenerationConfigForModel(modelSlug) {
  const lower = String(modelSlug || '').toLowerCase();
  if (
    lower === 'gemini-3.8-flash' ||
    lower === 'gemini-3.7-flash' ||
    lower === 'gemini-4-argon' ||
    lower === 'gemini-3.1-pro-preview'
  ) {
    return { thinking_level: 'low' };
  }
  if (
    lower === 'gemini-3.6-flash' ||
    lower === 'gemini-3.5-flash' ||
    lower === 'gemini-3.5-flash-lite' ||
    lower === 'gemini-3-flash-preview'
  ) {
    return { thinking_level: 'minimal' };
  }
  return null;
}

function markModelCongested(modelSlug) {
  if (transportOverride !== null) return;
  modelCooldownUntil.set(modelSlug, Date.now() + MODEL_COOLDOWN_MS);
}

function clearModelCongested(modelSlug) {
  if (transportOverride !== null) return;
  modelCooldownUntil.delete(modelSlug);
}

function buildCandidateModelChain(requestedModel) {
  const primary = resolveSupportedGeminiModel(requestedModel || 'gemini-3.8-flash');
  const rawChain = [primary];
  for (const fb of FALLBACK_FLASH_MODELS) {
    if (!rawChain.includes(fb)) {
      rawChain.push(fb);
    }
  }

  if (transportOverride !== null) {
    return rawChain;
  }

  // Demote models currently on temporary congestion cooldown to the end of the list
  const now = Date.now();
  const healthy = [];
  const cooling = [];
  for (const slug of rawChain) {
    const until = modelCooldownUntil.get(slug) || 0;
    if (until > now) {
      cooling.push(slug);
    } else {
      if (until > 0) modelCooldownUntil.delete(slug);
      healthy.push(slug);
    }
  }
  return [...healthy, ...cooling];
}

function buildInteractionsInput(inlineFiles = [], userPrompt = '') {
  const inputItems = [];
  for (const file of inlineFiles || []) {
    if (!file?.mimeType || !file?.base64Data) continue;
    const mimeLower = String(file.mimeType).toLowerCase();
    if (mimeLower === 'application/pdf') {
      inputItems.push({
        type: 'document',
        data: file.base64Data,
        mime_type: 'application/pdf',
      });
    } else {
      inputItems.push({
        type: 'image',
        data: file.base64Data,
        mime_type: file.mimeType,
        resolution: 'medium',
      });
    }
  }
  inputItems.push({
    type: 'text',
    text: String(userPrompt || ''),
  });
  return inputItems;
}

function extractRawTextAndUsage(payload, fallbackModel) {
  if (Array.isArray(payload?.steps)) {
    const modelOutputSteps = payload.steps.filter((s) => s?.type === 'model_output');
    const rawText = modelOutputSteps
      .flatMap((s) => (Array.isArray(s.content) ? s.content : []))
      .filter((c) => !c?.type || c.type === 'text')
      .map((c) => c?.text || '')
      .join('')
      .trim();

    const usage = payload?.usage || {};
    const inputTokens = Math.max(0, Number(usage.total_input_tokens) || 0);
    const outputTokens = Math.max(
      0,
      (Number(usage.total_output_tokens) || 0) + (Number(usage.total_thought_tokens) || 0)
    );
    const modelVersion = String(payload?.model || fallbackModel);
    return { rawText, inputTokens, outputTokens, modelVersion };
  }

  const rawText =
    payload?.candidates?.[0]?.content?.parts
      ?.map((p) => p?.text || '')
      .join('')
      .trim() || '';
  const usage = payload?.usageMetadata || {};
  const inputTokens = Math.max(0, Number(usage.promptTokenCount) || 0);
  const outputTokens = Math.max(0, Number(usage.candidatesTokenCount) || 0);
  const modelVersion = String(payload?.modelVersion || payload?.model || fallbackModel);
  return { rawText, inputTokens, outputTokens, modelVersion };
}

function shouldFallbackToNextModel(statusCode) {
  return statusCode === 404 || statusCode === 429 || statusCode === 503;
}

export async function callGeminiStructured({
  model = 'gemini-3.8-flash',
  systemInstruction = '',
  userPrompt = '',
  inlineFiles = [],
  responseSchema = null,
  timeoutMs = env.geminiTimeoutMs,
  perAttemptTimeoutMs = DEFAULT_PER_ATTEMPT_TIMEOUT_MS,
} = {}) {
  const apiKey = resolveEffectiveApiKey();
  if (!apiKey) {
    throw Object.assign(
      new Error(
        'Máy chủ chưa cấu hình GEMINI_API_KEY. Vui lòng nhập dữ liệu thủ công hoặc cấu hình khóa trên server.'
      ),
      { status: 503, code: 'AI_UNCONFIGURED' }
    );
  }

  const baseUrl = String(process.env.GEMINI_BASE_URL || env.geminiBaseUrl || '')
    .trim()
    .replace(/\/+$/, '');
  const url = `${baseUrl}/interactions`;

  const inputItems = buildInteractionsInput(inlineFiles, userPrompt);
  const jsonSchema = toInteractionsJsonSchema(responseSchema);
  const candidateModels = buildCandidateModelChain(model);

  const overallController = new AbortController();
  const effectiveTimeout = Math.max(500, Number(timeoutMs) || 45000);
  const safePerAttempt = Math.max(50, Number(perAttemptTimeoutMs) || DEFAULT_PER_ATTEMPT_TIMEOUT_MS);
  const overallTimer = setTimeout(() => overallController.abort(), effectiveTimeout);
  const startedAt = Date.now();
  const fetcher = transportOverride || globalThis.fetch;

  try {
    let lastHttpFailure = null;

    for (let idx = 0; idx < candidateModels.length; idx += 1) {
      if (overallController.signal.aborted) {
        const abortErr = new Error('The operation was aborted');
        abortErr.name = 'AbortError';
        throw abortErr;
      }

      const candidateModel = candidateModels[idx];
      const hasNextCandidate = idx < candidateModels.length - 1;
      const genCfg = resolveGenerationConfigForModel(candidateModel);

      const requestBody = {
        model: candidateModel,
        store: false,
        ...(systemInstruction ? { system_instruction: String(systemInstruction) } : {}),
        input: inputItems,
        ...(genCfg ? { generation_config: genCfg } : {}),
        response_format: {
          type: 'text',
          mime_type: 'application/json',
          ...(jsonSchema ? { schema: jsonSchema } : {}),
        },
      };

      const elapsedMs = Date.now() - startedAt;
      const remainingMs = Math.max(50, effectiveTimeout - elapsedMs);
      const attemptBudgetMs = hasNextCandidate ? Math.min(remainingMs, safePerAttempt) : remainingMs;

      let attemptTimedOut = false;
      const attemptController = new AbortController();
      const onOverallAbort = () => attemptController.abort();
      overallController.signal.addEventListener('abort', onOverallAbort, { once: true });
      const attemptTimer = setTimeout(() => {
        attemptTimedOut = true;
        attemptController.abort();
      }, attemptBudgetMs);

      let response;
      try {
        response = await fetcher(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': apiKey,
            'Api-Revision': INTERACTIONS_API_REVISION,
          },
          body: JSON.stringify(requestBody),
          signal: attemptController.signal,
        });
      } catch (fetchErr) {
        clearTimeout(attemptTimer);
        overallController.signal.removeEventListener('abort', onOverallAbort);

        if (
          fetchErr?.name === 'AbortError' &&
          attemptTimedOut &&
          !overallController.signal.aborted &&
          hasNextCandidate
        ) {
          markModelCongested(candidateModel);
          continue;
        }
        throw fetchErr;
      }

      clearTimeout(attemptTimer);
      overallController.signal.removeEventListener('abort', onOverallAbort);

      if (!response.ok) {
        let errDetail = `HTTP ${response.status}`;
        try {
          const errJson = await response.json();
          if (errJson?.error?.message) {
            errDetail = `${errDetail}: ${errJson.error.message}`;
          }
        } catch {
          // ignore non-json upstream body
        }

        lastHttpFailure = Object.assign(
          new Error(
            `Dịch vụ Gemini AI tạm thời không phản hồi hợp lệ (${scrubSecrets(errDetail, apiKey)}). Vui lòng thao tác thủ công.`
          ),
          {
            status: response.status === 429 ? 429 : 502,
            code: response.status === 429 ? 'AI_RATE_LIMITED' : 'AI_UPSTREAM_ERROR',
          }
        );

        if (shouldFallbackToNextModel(response.status)) {
          markModelCongested(candidateModel);
          if (hasNextCandidate) {
            continue;
          }
        }
        throw lastHttpFailure;
      }

      clearModelCongested(candidateModel);
      const latencyMs = Math.max(0, Date.now() - startedAt);
      const payload = await response.json();
      const { rawText, inputTokens, outputTokens, modelVersion } = extractRawTextAndUsage(
        payload,
        candidateModel
      );

      if (!rawText) {
        throw Object.assign(
          new Error('Mô hình AI không trả về dữ liệu đọc được. Vui lòng nhập thủ công.'),
          { status: 502, code: 'AI_EMPTY_RESPONSE' }
        );
      }

      let parsedJson;
      try {
        parsedJson = JSON.parse(rawText);
      } catch {
        const cleaned = rawText
          .replace(/^```json\s*/i, '')
          .replace(/```\s*$/i, '')
          .trim();
        try {
          parsedJson = JSON.parse(cleaned);
        } catch {
          throw Object.assign(
            new Error('Đầu ra AI không đúng định dạng JSON cấu trúc. Vui lòng nhập thủ công.'),
            { status: 502, code: 'AI_INVALID_JSON' }
          );
        }
      }

      return {
        parsedJson,
        inputTokens,
        outputTokens,
        latencyMs,
        modelVersion,
      };
    }

    throw (
      lastHttpFailure ||
      Object.assign(new Error('Dịch vụ Gemini AI tạm thời không phản hồi hợp lệ.'), {
        status: 502,
        code: 'AI_UPSTREAM_ERROR',
      })
    );
  } catch (err) {
    if (err?.name === 'AbortError') {
      throw Object.assign(
        new Error('Yêu cầu phân tích AI quá thời gian chờ. Hệ thống đã chuyển về chế độ nhập thủ công.'),
        { status: 504, code: 'AI_TIMEOUT' }
      );
    }
    if (err?.code && err?.status) {
      err.message = scrubSecrets(err.message, apiKey);
      throw err;
    }
    throw Object.assign(
      new Error(`Không thể kết nối dịch vụ AI: ${scrubSecrets(err?.message, apiKey)}`),
      { status: 502, code: 'AI_UPSTREAM_ERROR' }
    );
  } finally {
    clearTimeout(overallTimer);
  }
}
