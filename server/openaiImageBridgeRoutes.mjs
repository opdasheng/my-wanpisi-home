import { basename } from 'node:path';
import crypto from 'node:crypto';
import {
  getOpenAIAsyncTaskError,
  getOpenAIAsyncTaskIds,
  getOpenAIAsyncTaskStatus,
  hasOpenAIAsyncTaskImageResult,
  isOpenAIAsyncTaskComplete,
  isOpenAIAsyncTaskFailed,
  normalizeOpenAITaskStatus,
} from './openaiImageTaskPayload.mjs';

const defaultOpenAIBaseUrl = 'https://api.openai.com/v1';
const openAIAspectRatioSizeValues = [
  '1:1',
  '16:9',
  '9:16',
  '4:3',
  '3:4',
  '3:2',
  '2:3',
  '5:4',
  '4:5',
  '2:1',
  '1:2',
  '21:9',
  '9:21',
];

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function defaultNormalizeErrorMessage(error) {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error || 'Unknown error');
}

function getNetworkErrorDetail(error, normalizeErrorMessage) {
  const message = normalizeErrorMessage(error);
  const cause = error && typeof error === 'object' && 'cause' in error ? error.cause : null;
  const causeParts = cause && typeof cause === 'object'
    ? [
      cause.code,
      cause.errno,
      cause.syscall,
      cause.hostname,
      cause.address,
      cause.port,
    ].map((value) => String(value || '').trim()).filter(Boolean)
    : [];

  return causeParts.length > 0 ? `${message} (${causeParts.join(', ')})` : message;
}

function normalizeOpenAIBaseUrl(value) {
  const normalized = String(value || '').trim().replace(/\/+$/u, '');
  return normalized || defaultOpenAIBaseUrl;
}

function resolveOpenAIEndpoint(baseUrl, path) {
  const normalizedBaseUrl = normalizeOpenAIBaseUrl(baseUrl);
  const normalizedPath = String(path || '').trim().replace(/^\/+/u, '');
  return `${normalizedBaseUrl}/${normalizedPath}`;
}

function getGreatestCommonDivisor(first, second) {
  let a = Math.abs(Math.round(Number(first)));
  let b = Math.abs(Math.round(Number(second)));

  while (b > 0) {
    const next = a % b;
    a = b;
    b = next;
  }

  return a || 1;
}

function mapOpenAIImageSizeToAspectRatio(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized || normalized === 'auto') {
    return '';
  }

  if (openAIAspectRatioSizeValues.includes(normalized)) {
    return normalized;
  }

  const match = normalized.match(/^(\d+)\s*x\s*(\d+)$/u);
  if (!match) {
    return '';
  }

  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return '';
  }

  const divisor = getGreatestCommonDivisor(width, height);
  const reducedRatio = `${width / divisor}:${height / divisor}`;
  if (openAIAspectRatioSizeValues.includes(reducedRatio)) {
    return reducedRatio;
  }

  const targetRatio = width / height;
  const closest = openAIAspectRatioSizeValues
    .map((ratio) => {
      const [ratioWidth, ratioHeight] = ratio.split(':').map(Number);
      return {
        ratio,
        distance: Math.abs((ratioWidth / ratioHeight) - targetRatio),
      };
    })
    .sort((left, right) => left.distance - right.distance)[0];

  return closest && closest.distance <= 0.03 ? closest.ratio : '';
}

function getOpenAIImageSizeFallbackAspectRatio(body, imageRequest) {
  const request = body?.request && typeof body.request === 'object' ? body.request : {};
  return mapOpenAIImageSizeToAspectRatio(request.size_fallback_aspect_ratio)
    || mapOpenAIImageSizeToAspectRatio(imageRequest?.size);
}

function isOpenAIAspectRatioSizeError(error, normalizeErrorMessage) {
  const message = normalizeErrorMessage(error);
  return /invalid size/iu.test(message)
    && /allowed:/iu.test(message)
    && /1:1/iu.test(message)
    && /16:9/iu.test(message);
}

function getOpenAIConfig(body) {
  const config = body?.config && typeof body.config === 'object' ? body.config : {};
  const apiKey = String(config.apiKey || process.env.OPENAI_API_KEY || '').trim();
  if (!apiKey) {
    throw new Error('OpenAI API Key 未配置。');
  }

  return {
    apiKey,
    baseUrl: normalizeOpenAIBaseUrl(config.baseUrl || process.env.OPENAI_BASE_URL),
  };
}

function shouldUseOpenAIImageUrlsReferenceMode(config) {
  try {
    const host = new URL(normalizeOpenAIBaseUrl(config?.baseUrl)).hostname.toLowerCase();
    return host === 'api.apimart.ai' || host.endsWith('.apimart.ai');
  } catch {
    return false;
  }
}

function normalizeOpenAIJsonRequest(body) {
  const request = body?.request && typeof body.request === 'object' ? body.request : {};
  const model = String(request.model || 'gpt-image-2').trim() || 'gpt-image-2';
  const prompt = String(request.prompt || '').trim();
  if (!prompt) {
    throw new Error('图片提示词不能为空。');
  }

  const result = {
    model,
    prompt,
  };

  const optionalStringFields = ['size', 'quality', 'output_format', 'background', 'moderation'];
  for (const field of optionalStringFields) {
    const value = String(request[field] || '').trim();
    if (value) {
      result[field] = value;
    }
  }

  const n = Number(request.n);
  if (Number.isFinite(n) && n > 0) {
    result.n = Math.max(1, Math.min(10, Math.round(n)));
  }

  const compression = Number(request.output_compression);
  if (Number.isFinite(compression)) {
    result.output_compression = Math.max(0, Math.min(100, Math.round(compression)));
  }

  return result;
}

function createOpenAILogId() {
  return crypto.randomUUID().slice(0, 8);
}

function summarizeOpenAIBaseUrl(baseUrl) {
  try {
    const parsed = new URL(normalizeOpenAIBaseUrl(baseUrl));
    return `${parsed.origin}${parsed.pathname.replace(/\/+$/u, '')}`;
  } catch {
    return normalizeOpenAIBaseUrl(baseUrl);
  }
}

function summarizeOpenAIImageRequest(path, imageRequest, referenceCount, attempt) {
  const imageUrls = Array.isArray(imageRequest?.image_urls) ? imageRequest.image_urls : [];
  return {
    attempt,
    path,
    model: imageRequest?.model,
    size: imageRequest?.size,
    quality: imageRequest?.quality,
    output_format: imageRequest?.output_format,
    moderation: imageRequest?.moderation,
    n: imageRequest?.n,
    promptChars: String(imageRequest?.prompt || '').length,
    referenceCount: Math.max(referenceCount, imageUrls.length),
  };
}

function getOpenAIImageTaskPollingOptions() {
  const initialDelayMs = Number(process.env.OPENAI_IMAGE_TASK_INITIAL_DELAY_MS);
  const intervalMs = Number(process.env.OPENAI_IMAGE_TASK_POLL_INTERVAL_MS);
  const timeoutMs = Number(process.env.OPENAI_IMAGE_TASK_TIMEOUT_MS);

  return {
    initialDelayMs: Number.isFinite(initialDelayMs) ? Math.max(0, initialDelayMs) : 10000,
    intervalMs: Number.isFinite(intervalMs) ? Math.max(1000, intervalMs) : 4000,
    timeoutMs: Number.isFinite(timeoutMs) ? Math.max(5000, timeoutMs) : 300000,
  };
}

function summarizeOpenAICollection(value) {
  if (Array.isArray(value)) {
    const firstRecord = value.find((item) => item && typeof item === 'object' && !Array.isArray(item));
    return {
      count: value.length,
      firstKeys: firstRecord ? Object.keys(firstRecord).slice(0, 12) : [],
    };
  }

  if (value && typeof value === 'object') {
    return {
      count: 1,
      firstKeys: Object.keys(value).slice(0, 12),
    };
  }

  return {
    count: value === undefined ? 0 : 1,
    firstKeys: [],
  };
}

function summarizeOpenAIResponsePayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return {
      payloadType: typeof payload,
    };
  }

  const dataSummary = summarizeOpenAICollection(payload.data);
  const imagesSummary = summarizeOpenAICollection(payload.images);
  const outputSummary = summarizeOpenAICollection(payload.output);

  return {
    rootKeys: Object.keys(payload).slice(0, 12),
    dataCount: dataSummary.count,
    dataFirstKeys: dataSummary.firstKeys,
    imagesCount: imagesSummary.count,
    imagesFirstKeys: imagesSummary.firstKeys,
    outputCount: outputSummary.count,
    outputFirstKeys: outputSummary.firstKeys,
    usageKeys: payload.usage && typeof payload.usage === 'object' ? Object.keys(payload.usage).slice(0, 12) : [],
  };
}

function logOpenAIBridge(level, requestId, event, details) {
  const logger = level === 'warn' ? console.warn : console.info;
  logger(`[OpenAIBridge] ${requestId} ${event} ${JSON.stringify(details)}`);
}

async function requestOpenAIJson(config, path, init, context = {}, normalizeErrorMessage = defaultNormalizeErrorMessage) {
  const requestId = context.requestId || createOpenAILogId();
  const startedAt = Date.now();
  const endpoint = resolveOpenAIEndpoint(config.baseUrl, path);
  const requestSummary = {
    baseUrl: summarizeOpenAIBaseUrl(config.baseUrl),
    ...(context.requestSummary || {}),
  };

  logOpenAIBridge('info', requestId, 'request', requestSummary);

  let response;
  try {
    response = await fetch(endpoint, {
      ...init,
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        ...(init.headers || {}),
      },
    });
  } catch (error) {
    const detail = getNetworkErrorDetail(error, normalizeErrorMessage);
    logOpenAIBridge('warn', requestId, 'network_error', {
      ...requestSummary,
      durationMs: Date.now() - startedAt,
      message: detail,
    });
    throw new Error(`OpenAI 网络请求失败（${requestSummary.baseUrl}${path}）：${detail}`);
  }

  const text = await response.text();
  let payload = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { rawText: text };
  }

  const responseSummary = summarizeOpenAIResponsePayload(payload);
  const durationMs = Date.now() - startedAt;
  if (!response.ok) {
    const message = payload?.error?.message || payload?.message || text || `HTTP ${response.status}`;
    logOpenAIBridge('warn', requestId, 'response_error', {
      ...requestSummary,
      status: response.status,
      durationMs,
      message,
      response: responseSummary,
    });
    throw new Error(`OpenAI 请求失败: ${message}`);
  }

  logOpenAIBridge('info', requestId, 'response_ok', {
    ...requestSummary,
    status: response.status,
    durationMs,
    response: responseSummary,
  });

  return payload;
}

async function requestOpenAITaskStatus(config, taskId, requestId, attempt, normalizeErrorMessage) {
  return requestOpenAIJson(config, `/tasks/${encodeURIComponent(taskId)}?language=zh`, {
    method: 'GET',
  }, {
    requestId,
    requestSummary: {
      attempt,
      path: `/tasks/${taskId}`,
      taskId,
    },
  }, normalizeErrorMessage);
}

async function waitForOpenAIAsyncTaskResult(config, submissionPayload, requestId, normalizeErrorMessage) {
  const taskIds = getOpenAIAsyncTaskIds(submissionPayload);
  if (taskIds.length === 0) {
    return submissionPayload;
  }

  const { initialDelayMs, intervalMs, timeoutMs } = getOpenAIImageTaskPollingOptions();
  const deadlineMs = Date.now() + timeoutMs;
  const results = new Map();
  let attempt = 0;
  let lastPollError = '';
  let lastTaskStatus = '';

  logOpenAIBridge('info', requestId, 'task_submitted', {
    taskIds,
    initialDelayMs,
    intervalMs,
    timeoutMs,
  });

  if (initialDelayMs > 0) {
    await sleep(initialDelayMs);
  }

  while (Date.now() <= deadlineMs) {
    attempt += 1;

    for (const taskId of taskIds) {
      if (results.has(taskId)) {
        continue;
      }

      let payload;
      try {
        payload = await requestOpenAITaskStatus(config, taskId, requestId, `task_poll:${attempt}`, normalizeErrorMessage);
      } catch (error) {
        lastPollError = normalizeErrorMessage(error);
        logOpenAIBridge('warn', requestId, 'task_poll_error', {
          taskId,
          attempt,
          message: lastPollError,
        });
        continue;
      }

      const status = normalizeOpenAITaskStatus(getOpenAIAsyncTaskStatus(payload));
      const hasImageResult = hasOpenAIAsyncTaskImageResult(payload);
      if (status) {
        lastTaskStatus = status;
      }
      logOpenAIBridge('info', requestId, 'task_status', {
        taskId,
        attempt,
        status: status || 'unknown',
        hasImageResult,
      });

      if (hasImageResult || isOpenAIAsyncTaskComplete(status)) {
        results.set(taskId, payload);
        continue;
      }

      if (isOpenAIAsyncTaskFailed(status)) {
        const message = getOpenAIAsyncTaskError(payload) || `OpenAI 图片任务失败：${status || taskId}`;
        throw new Error(`OpenAI 图片任务失败: ${message}`);
      }
    }

    if (results.size === taskIds.length) {
      if (taskIds.length === 1) {
        return results.get(taskIds[0]);
      }

      const taskResults = taskIds.map((taskId) => results.get(taskId));
      return {
        code: 200,
        data: taskResults.map((payload) => payload?.data || payload),
        task_results: taskResults,
      };
    }

    await sleep(intervalMs);
  }

  const timeoutDetails = [
    lastTaskStatus ? `最后任务状态：${lastTaskStatus}` : '',
    lastPollError ? `最后一次查询错误：${lastPollError}` : '',
  ].filter(Boolean).join('；');
  throw new Error(`OpenAI 图片任务超时，未在 ${Math.round(timeoutMs / 1000)} 秒内完成：${taskIds.join(', ')}${timeoutDetails ? `；${timeoutDetails}` : ''}`);
}

async function requestOpenAIGenerationJson(config, imageRequest, sizeFallbackAspectRatio, normalizeErrorMessage) {
  const requestId = createOpenAILogId();
  try {
    const payload = await requestOpenAIJson(config, '/images/generations', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(imageRequest),
    }, {
      requestId,
      requestSummary: summarizeOpenAIImageRequest('/images/generations', imageRequest, 0, 'primary'),
    }, normalizeErrorMessage);
    return waitForOpenAIAsyncTaskResult(config, payload, requestId, normalizeErrorMessage);
  } catch (error) {
    if (
      !sizeFallbackAspectRatio
      || imageRequest.size === sizeFallbackAspectRatio
      || !isOpenAIAspectRatioSizeError(error, normalizeErrorMessage)
    ) {
      throw error;
    }

    const payload = await requestOpenAIJson(config, '/images/generations', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ...imageRequest,
        size: sizeFallbackAspectRatio,
      }),
    }, {
      requestId,
      requestSummary: summarizeOpenAIImageRequest('/images/generations', {
        ...imageRequest,
        size: sizeFallbackAspectRatio,
      }, 0, `size_fallback:${imageRequest.size || 'none'}->${sizeFallbackAspectRatio}`),
    }, normalizeErrorMessage);
    return waitForOpenAIAsyncTaskResult(config, payload, requestId, normalizeErrorMessage);
  }
}

async function materializeOpenAIReferenceImages(references, request, deps) {
  const normalizedReferences = Array.isArray(references) ? references : [];
  const images = [];

  for (let index = 0; index < normalizedReferences.length; index += 1) {
    const reference = normalizedReferences[index] || {};
    const payload = String(reference.sourceUrl || '').trim().startsWith('data:')
      ? deps.extractBase64Payload({ dataUrl: reference.sourceUrl }, 'image')
      : await deps.resolveAssetPayload(reference, 'image', request);
    deps.validateAssetMimeType('image', payload.mimeType);
    const extension = deps.getMimeExtension(payload.mimeType, 'image');
    const fileName = basename(String(reference.fileName || reference.filename || `reference-${index + 1}.${extension}`).trim()) || `reference-${index + 1}.${extension}`;
    images.push({
      mimeType: payload.mimeType,
      data: Buffer.from(payload.dataBase64, 'base64'),
      fileName,
    });
  }

  return images;
}

function appendOpenAIFormValue(formData, key, value) {
  if (value === undefined || value === null || value === '') {
    return;
  }
  formData.append(key, String(value));
}

function buildOpenAIEditFormData(imageRequest, references) {
  const formData = new FormData();
  for (const reference of references) {
    formData.append('image[]', new Blob([reference.data], { type: reference.mimeType }), reference.fileName);
  }

  Object.entries(imageRequest).forEach(([key, value]) => appendOpenAIFormValue(formData, key, value));
  return formData;
}

function buildOpenAIReferenceImageDataUrls(references) {
  return references.map((reference) => `data:${reference.mimeType};base64,${reference.data.toString('base64')}`);
}

async function requestOpenAIEditJson(config, imageRequest, references, sizeFallbackAspectRatio, normalizeErrorMessage) {
  if (shouldUseOpenAIImageUrlsReferenceMode(config)) {
    return requestOpenAIGenerationJson(config, {
      ...imageRequest,
      image_urls: buildOpenAIReferenceImageDataUrls(references),
    }, sizeFallbackAspectRatio, normalizeErrorMessage);
  }

  const requestId = createOpenAILogId();
  try {
    const payload = await requestOpenAIJson(config, '/images/edits', {
      method: 'POST',
      body: buildOpenAIEditFormData(imageRequest, references),
    }, {
      requestId,
      requestSummary: summarizeOpenAIImageRequest('/images/edits', imageRequest, references.length, 'primary'),
    }, normalizeErrorMessage);
    return waitForOpenAIAsyncTaskResult(config, payload, requestId, normalizeErrorMessage);
  } catch (error) {
    if (
      !sizeFallbackAspectRatio
      || imageRequest.size === sizeFallbackAspectRatio
      || !isOpenAIAspectRatioSizeError(error, normalizeErrorMessage)
    ) {
      throw error;
    }

    const payload = await requestOpenAIJson(config, '/images/edits', {
      method: 'POST',
      body: buildOpenAIEditFormData({
        ...imageRequest,
        size: sizeFallbackAspectRatio,
      }, references),
    }, {
      requestId,
      requestSummary: summarizeOpenAIImageRequest('/images/edits', {
        ...imageRequest,
        size: sizeFallbackAspectRatio,
      }, references.length, `size_fallback:${imageRequest.size || 'none'}->${sizeFallbackAspectRatio}`),
    }, normalizeErrorMessage);
    return waitForOpenAIAsyncTaskResult(config, payload, requestId, normalizeErrorMessage);
  }
}

function requireDependency(deps, name) {
  if (typeof deps[name] !== 'function') {
    throw new Error(`OpenAI bridge route dependency is missing: ${name}`);
  }
}

export function registerOpenAIImageBridgeRoutes(app, deps = {}) {
  const routeDeps = {
    normalizeErrorMessage: deps.normalizeErrorMessage || defaultNormalizeErrorMessage,
    resolveAssetPayload: deps.resolveAssetPayload,
    validateAssetMimeType: deps.validateAssetMimeType,
    extractBase64Payload: deps.extractBase64Payload,
    getMimeExtension: deps.getMimeExtension,
  };

  for (const name of ['resolveAssetPayload', 'validateAssetMimeType', 'extractBase64Payload', 'getMimeExtension']) {
    requireDependency(routeDeps, name);
  }

  app.post('/api/seedance/openai/images/generations', async (request, response) => {
    try {
      const config = getOpenAIConfig(request.body);
      const imageRequest = normalizeOpenAIJsonRequest(request.body);
      const sizeFallbackAspectRatio = getOpenAIImageSizeFallbackAspectRatio(request.body, imageRequest);
      const payload = await requestOpenAIGenerationJson(config, imageRequest, sizeFallbackAspectRatio, routeDeps.normalizeErrorMessage);
      response.json(payload);
    } catch (error) {
      response.status(500).json({
        error: routeDeps.normalizeErrorMessage(error),
      });
    }
  });

  app.post('/api/seedance/openai/images/edits', async (request, response) => {
    try {
      const config = getOpenAIConfig(request.body);
      const imageRequest = normalizeOpenAIJsonRequest(request.body);
      const references = await materializeOpenAIReferenceImages(request.body?.references, request, routeDeps);
      if (references.length === 0) {
        response.status(400).json({ error: '至少需要 1 张参考图。' });
        return;
      }

      const sizeFallbackAspectRatio = getOpenAIImageSizeFallbackAspectRatio(request.body, imageRequest);
      const payload = await requestOpenAIEditJson(config, imageRequest, references, sizeFallbackAspectRatio, routeDeps.normalizeErrorMessage);
      response.json(payload);
    } catch (error) {
      response.status(500).json({
        error: routeDeps.normalizeErrorMessage(error),
      });
    }
  });
}
