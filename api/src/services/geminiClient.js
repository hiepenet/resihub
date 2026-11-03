import { env } from '../config/env.js';

let transportOverride = null;
let apiKeyOverride = null;

export function setGeminiTransportForTest(fn) {
  transportOverride = typeof fn === 'function' ? fn : null;
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

export async function callGeminiStructured({
  model = 'gemini-2.5-flash',
  systemInstruction = '',
  userPrompt = '',
  inlineFiles = [],
  responseSchema = null,
  timeoutMs = env.geminiTimeoutMs,
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
  const safeModel = encodeURIComponent(String(model || 'gemini-2.5-flash').trim());
  const url = `${baseUrl}/models/${safeModel}:generateContent`;

  const parts = [];
  for (const file of inlineFiles || []) {
    if (file?.mimeType && file?.base64Data) {
      parts.push({
        inline_data: {
          mime_type: file.mimeType,
          data: file.base64Data,
        },
      });
    }
  }
  parts.push({ text: String(userPrompt || '') });

  const requestBody = {
    ...(systemInstruction
      ? {
          system_instruction: {
            parts: [{ text: String(systemInstruction) }],
          },
        }
      : {}),
    contents: [
      {
        role: 'user',
        parts,
      },
    ],
    generationConfig: {
      temperature: 0.1,
      responseMimeType: 'application/json',
      ...(responseSchema ? { responseSchema } : {}),
    },
  };

  const controller = new AbortController();
  const effectiveTimeout = Math.max(500, Number(timeoutMs) || 20000);
  const timer = setTimeout(() => controller.abort(), effectiveTimeout);
  const startedAt = Date.now();
  const fetcher = transportOverride || globalThis.fetch;

  try {
    const response = await fetcher(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });

    const latencyMs = Math.max(0, Date.now() - startedAt);
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
      throw Object.assign(
        new Error(
          `Dịch vụ Gemini AI tạm thời không phản hồi hợp lệ (${scrubSecrets(errDetail, apiKey)}). Vui lòng thao tác thủ công.`
        ),
        {
          status: response.status === 429 ? 429 : 502,
          code: response.status === 429 ? 'AI_RATE_LIMITED' : 'AI_UPSTREAM_ERROR',
        }
      );
    }

    const payload = await response.json();
    const rawText =
      payload?.candidates?.[0]?.content?.parts
        ?.map((p) => p?.text || '')
        .join('')
        .trim() || '';

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
      const cleaned = rawText.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
      try {
        parsedJson = JSON.parse(cleaned);
      } catch {
        throw Object.assign(
          new Error('Đầu ra AI không đúng định dạng JSON cấu trúc. Vui lòng nhập thủ công.'),
          { status: 502, code: 'AI_INVALID_JSON' }
        );
      }
    }

    const usage = payload?.usageMetadata || {};
    const inputTokens = Math.max(0, Number(usage.promptTokenCount) || 0);
    const outputTokens = Math.max(0, Number(usage.candidatesTokenCount) || 0);
    const modelVersion = String(payload?.modelVersion || model);

    return {
      parsedJson,
      inputTokens,
      outputTokens,
      latencyMs,
      modelVersion,
    };
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
    clearTimeout(timer);
  }
}
