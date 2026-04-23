import express from 'express';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFile, cp, mkdir, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import crypto from 'node:crypto';
import { createAppStateStore } from './appStateStore.mjs';
import { buildAssetLibraryFileName } from './assetLibraryNaming.mjs';
import { registerArkAssetOpenApiRoutes } from './arkAssetOpenApi.mjs';
import { registerOpenAIImageBridgeRoutes } from './openaiImageBridgeRoutes.mjs';
import {
  getOpenAIAsyncTaskError,
  getOpenAIAsyncTaskIds,
  getOpenAIAsyncTaskStatus,
  hasOpenAIAsyncTaskImageResult,
  isOpenAIAsyncTaskComplete,
  isOpenAIAsyncTaskFailed,
  normalizeOpenAITaskStatus,
} from './openaiImageTaskPayload.mjs';

const execFileAsync = promisify(execFile);
const app = express();
const port = Number(process.env.SEEDANCE_BRIDGE_PORT || 3210);
const cliBin = (process.env.SEEDANCE_CLI_BIN || 'dreamina').trim() || 'dreamina';
const bridgeRoot = join(tmpdir(), 'renren-ai-video', 'seedance');
const persistentDataRoot = resolve(process.env.RENREN_APP_DATA_DIR || join(process.cwd(), 'local_data'));
const bridgeConfigPath = join(persistentDataRoot, 'bridge-config.json');
const appStateStore = createAppStateStore(join(persistentDataRoot, 'app-state.sqlite'));
const defaultAssetLibraryRoot = resolve(process.cwd(), 'local_asset_library');
const allowedVideoExtensions = new Set(['.mp4', '.mov', '.webm', '.mkv', '.avi']);
const supportedModelVersions = ['seedance2.0', 'seedance2.0fast', 'seedance2.0_vip', 'seedance2.0fast_vip'];
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

app.use(express.json({ limit: '100mb' }));
app.use((request, response, next) => {
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,OPTIONS,DELETE');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (request.method === 'OPTIONS') {
    response.status(204).end();
    return;
  }
  next();
});
registerArkAssetOpenApiRoutes(app);

function taskDir(submitId) {
  return join(bridgeRoot, 'tasks', submitId);
}

function uploadDir(projectId, uploadId) {
  return join(bridgeRoot, 'uploads', projectId, uploadId);
}

async function ensureDir(path) {
  await mkdir(path, { recursive: true });
}

async function pathExists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function normalizeErrorMessage(error) {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error || 'Unknown error');
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function extractJsonCandidate(text) {
  const trimmed = text.trim();
  if (!trimmed) {
    return '';
  }

  const directCandidates = [trimmed];
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    directCandidates.push(trimmed.slice(firstBrace, lastBrace + 1));
  }

  for (const candidate of directCandidates) {
    try {
      JSON.parse(candidate);
      return candidate;
    } catch {
      // Continue searching.
    }
  }

  return '';
}

function parseCommandJson(stdout, stderr) {
  const candidate = extractJsonCandidate(stdout) || extractJsonCandidate(`${stdout}\n${stderr}`);
  if (!candidate) {
    throw new Error((stderr || stdout || '命令未返回可解析 JSON').trim());
  }

  return JSON.parse(candidate);
}

async function runDreaminaJson(args) {
  try {
    const { stdout, stderr } = await execFileAsync(cliBin, args, {
      cwd: bridgeRoot,
      maxBuffer: 20 * 1024 * 1024,
    });

    return {
      payload: parseCommandJson(stdout, stderr),
      stdout,
      stderr,
      exitCode: 0,
    };
  } catch (error) {
    const stdout = error.stdout || '';
    const stderr = error.stderr || '';

    try {
      // Even if exit code is non-zero (e.g. CLI internal warning or bug),
      // the CLI might still have printed a valid JSON response before exiting.
      const payload = parseCommandJson(stdout, stderr);
      return {
        payload,
        stdout,
        stderr,
        exitCode: error.code || 1,
      };
    } catch {
      // If no valid JSON was found in the output, propagate the original error.
      throw error;
    }
  }
}

async function commandSucceeds(args) {
  try {
    await execFileAsync(cliBin, args, {
      cwd: bridgeRoot,
      maxBuffer: 2 * 1024 * 1024,
    });
    return true;
  } catch {
    return false;
  }
}

function inferLoginStatus(errorText) {
  const normalized = errorText.toLowerCase();
  if (!normalized) {
    return 'unknown';
  }

  if (
    normalized.includes('login')
    || normalized.includes('relogin')
    || normalized.includes('session')
    || normalized.includes('credential')
    || normalized.includes('account')
    || normalized.includes('未登录')
  ) {
    return 'logged_out';
  }

  return 'error';
}

async function checkHealth() {
  const cliAvailable = await commandSucceeds(['-h']);
  if (!cliAvailable) {
    return {
      cliAvailable: false,
      loginStatus: 'unknown',
      modelVersions: supportedModelVersions,
      checkedAt: new Date().toISOString(),
      error: `未检测到 ${cliBin} 命令`,
    };
  }

  try {
    const { payload } = await runDreaminaJson(['user_credit']);

    return {
      cliAvailable: true,
      loginStatus: 'logged_in',
      modelVersions: supportedModelVersions,
      credit: payload,
      checkedAt: new Date().toISOString(),
    };
  } catch (error) {
    const message = normalizeErrorMessage(error);
    return {
      cliAvailable: true,
      loginStatus: inferLoginStatus(message),
      modelVersions: supportedModelVersions,
      checkedAt: new Date().toISOString(),
      error: message,
    };
  }
}

async function writeBase64File(targetPath, dataBase64) {
  await writeFile(targetPath, Buffer.from(dataBase64, 'base64'));
}

async function saveRawPayload(path, payload) {
  await writeFile(path, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

async function loadBridgeConfig() {
  try {
    const text = await readFile(bridgeConfigPath, 'utf8');
    return JSON.parse(text);
  } catch {
    return {};
  }
}

async function saveBridgeConfig(config) {
  await ensureDir(persistentDataRoot);
  await writeFile(bridgeConfigPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

function normalizeAssetLibraryRoot(path) {
  const trimmed = String(path || '').trim();
  return trimmed ? resolve(trimmed) : defaultAssetLibraryRoot;
}

function sanitizePathSegment(value, fallback = 'untitled') {
  const normalized = String(value || '')
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001F]+/gu, '-')
    .replace(/\s+/gu, ' ')
    .replace(/^\.+|\.+$/gu, '')
    .trim();

  const compact = normalized || fallback;
  return compact.slice(0, 80);
}

function sanitizeRelativePath(relativePath) {
  const segments = String(relativePath || '')
    .split(/[\\/]+/u)
    .map((segment) => segment.trim())
    .filter(Boolean);

  if (segments.length === 0 || segments.some((segment) => segment === '.' || segment === '..')) {
    throw new Error('资产文件路径无效。');
  }

  return segments.join('/');
}

function normalizeModelVersion(value) {
  const normalized = String(value || '').trim();
  return supportedModelVersions.includes(normalized) ? normalized : 'seedance2.0';
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

function isOpenAIAspectRatioSizeError(error) {
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

async function requestOpenAIJson(config, path, init, context = {}) {
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
    logOpenAIBridge('warn', requestId, 'network_error', {
      ...requestSummary,
      durationMs: Date.now() - startedAt,
      message: normalizeErrorMessage(error),
    });
    throw error;
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

async function requestOpenAITaskStatus(config, taskId, requestId, attempt) {
  return requestOpenAIJson(config, `/tasks/${encodeURIComponent(taskId)}?language=zh`, {
    method: 'GET',
  }, {
    requestId,
    requestSummary: {
      attempt,
      path: `/tasks/${taskId}`,
      taskId,
    },
  });
}

async function waitForOpenAIAsyncTaskResult(config, submissionPayload, requestId) {
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
        payload = await requestOpenAITaskStatus(config, taskId, requestId, `task_poll:${attempt}`);
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

async function requestOpenAIGenerationJson(config, imageRequest, sizeFallbackAspectRatio) {
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
    });
    return waitForOpenAIAsyncTaskResult(config, payload, requestId);
  } catch (error) {
    if (
      !sizeFallbackAspectRatio
      || imageRequest.size === sizeFallbackAspectRatio
      || !isOpenAIAspectRatioSizeError(error)
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
    });
    return waitForOpenAIAsyncTaskResult(config, payload, requestId);
  }
}

async function materializeOpenAIReferenceImages(references, request) {
  const normalizedReferences = Array.isArray(references) ? references : [];
  const images = [];

  for (let index = 0; index < normalizedReferences.length; index += 1) {
    const reference = normalizedReferences[index] || {};
    const payload = String(reference.sourceUrl || '').trim().startsWith('data:')
      ? extractBase64Payload({ dataUrl: reference.sourceUrl }, 'image')
      : await resolveAssetPayload(reference, 'image', request);
    validateAssetMimeType('image', payload.mimeType);
    const extension = getMimeExtension(payload.mimeType, 'image');
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

async function requestOpenAIEditJson(config, imageRequest, references, sizeFallbackAspectRatio) {
  if (shouldUseOpenAIImageUrlsReferenceMode(config)) {
    return requestOpenAIGenerationJson(config, {
      ...imageRequest,
      image_urls: buildOpenAIReferenceImageDataUrls(references),
    }, sizeFallbackAspectRatio);
  }

  const requestId = createOpenAILogId();
  try {
    const payload = await requestOpenAIJson(config, '/images/edits', {
      method: 'POST',
      body: buildOpenAIEditFormData(imageRequest, references),
    }, {
      requestId,
      requestSummary: summarizeOpenAIImageRequest('/images/edits', imageRequest, references.length, 'primary'),
    });
    return waitForOpenAIAsyncTaskResult(config, payload, requestId);
  } catch (error) {
    if (
      !sizeFallbackAspectRatio
      || imageRequest.size === sizeFallbackAspectRatio
      || !isOpenAIAspectRatioSizeError(error)
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
    });
    return waitForOpenAIAsyncTaskResult(config, payload, requestId);
  }
}

function getRequestOrigin(request) {
  const protocol = String(request.protocol || 'http').trim() || 'http';
  const host = String(request.get('host') || `127.0.0.1:${port}`).trim() || `127.0.0.1:${port}`;
  return `${protocol}://${host}`;
}

function resolveSourceUrl(sourceUrl, request) {
  const normalizedSourceUrl = String(sourceUrl || '').trim();
  if (!normalizedSourceUrl) {
    return '';
  }

  try {
    return new URL(normalizedSourceUrl).toString();
  } catch {
    return new URL(normalizedSourceUrl, `${getRequestOrigin(request)}/`).toString();
  }
}

function getMimeExtension(mimeType, kind) {
  const normalized = String(mimeType || '').toLowerCase();
  if (normalized.includes('png')) return 'png';
  if (normalized.includes('webp')) return 'webp';
  if (normalized.includes('gif')) return 'gif';
  if (normalized.includes('jpeg') || normalized.includes('jpg')) return 'jpg';
  if (normalized.includes('mpeg') || normalized.includes('mp3')) return 'mp3';
  if (normalized.includes('wav') || normalized.includes('wave')) return 'wav';
  if (normalized.includes('mp4')) return 'mp4';
  if (normalized.includes('quicktime')) return 'mov';
  if (normalized.includes('webm')) return 'webm';
  if (kind === 'video') return 'mp4';
  if (kind === 'audio') return 'mp3';
  return 'png';
}

function inferMimeTypeFromSourceUrl(sourceUrl, kind) {
  try {
    const parsed = new URL(sourceUrl);
    const candidates = [
      parsed.pathname,
      parsed.searchParams.get('path') || '',
      parsed.searchParams.get('filename') || '',
      parsed.searchParams.get('fileName') || '',
    ];
    for (const candidate of candidates) {
      const inferredType = detectContentType(candidate);
      if (inferredType && inferredType !== 'application/octet-stream') {
        return inferredType;
      }
    }
    return kind === 'video'
      ? 'video/mp4'
      : kind === 'audio'
        ? 'audio/mpeg'
        : 'image/png';
  } catch {
    return kind === 'video'
      ? 'video/mp4'
      : kind === 'audio'
        ? 'audio/mpeg'
        : 'image/png';
  }
}

function validateAssetMimeType(kind, mimeType) {
  const normalized = String(mimeType || '').toLowerCase();
  const isExpectedType = kind === 'video'
    ? normalized.startsWith('video/')
    : kind === 'audio'
      ? normalized.startsWith('audio/')
      : normalized.startsWith('image/');

  if (!isExpectedType) {
    throw new Error(
      kind === 'video'
        ? '写入的资源不是视频文件。'
        : kind === 'audio'
          ? '写入的资源不是音频文件。'
          : '写入的资源不是图片文件。'
    );
  }
}

function detectContentType(fileName) {
  const extension = extname(fileName).toLowerCase();
  if (extension === '.png') return 'image/png';
  if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg';
  if (extension === '.webp') return 'image/webp';
  if (extension === '.gif') return 'image/gif';
  if (extension === '.mp4') return 'video/mp4';
  if (extension === '.mov') return 'video/quicktime';
  if (extension === '.webm') return 'video/webm';
  if (extension === '.mp3') return 'audio/mpeg';
  if (extension === '.wav') return 'audio/wav';
  return 'application/octet-stream';
}

function isGenericContentType(mimeType) {
  const normalized = String(mimeType || '').toLowerCase();
  return !normalized || normalized === 'application/octet-stream' || normalized === 'binary/octet-stream';
}

function detectContentTypeFromBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) {
    return '';
  }

  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }
  if (buffer.subarray(0, 6).toString('ascii') === 'GIF87a' || buffer.subarray(0, 6).toString('ascii') === 'GIF89a') {
    return 'image/gif';
  }
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') {
    return 'image/webp';
  }
  if (buffer.length >= 12 && buffer.subarray(4, 8).toString('ascii') === 'ftyp') {
    return 'video/mp4';
  }
  if (buffer.length >= 4 && buffer[0] === 0x1a && buffer[1] === 0x45 && buffer[2] === 0xdf && buffer[3] === 0xa3) {
    return 'video/webm';
  }
  if (buffer.subarray(0, 3).toString('ascii') === 'ID3' || (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0)) {
    return 'audio/mpeg';
  }
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WAVE') {
    return 'audio/wav';
  }

  return '';
}

function resolveFetchedMimeType(sourceUrl, kind, responseMimeType, buffer) {
  const detectedMimeType = detectContentTypeFromBuffer(buffer);
  if (detectedMimeType) {
    return detectedMimeType;
  }

  const normalizedResponseMimeType = String(responseMimeType || '').trim();
  if (!isGenericContentType(normalizedResponseMimeType)) {
    return normalizedResponseMimeType;
  }

  return inferMimeTypeFromSourceUrl(sourceUrl, kind);
}

function extractBase64Payload(body, kind) {
  const dataUrl = String(body?.dataUrl || '').trim();
  if (dataUrl) {
    const match = dataUrl.match(/^data:(.+);base64,(.+)$/u);
    if (!match) {
      throw new Error('媒体数据格式无效。');
    }
    return {
      mimeType: match[1],
      dataBase64: match[2],
    };
  }

  const dataBase64 = String(body?.dataBase64 || '').trim();
  if (!dataBase64) {
    throw new Error('媒体内容不能为空。');
  }

  return {
    mimeType: String(body?.mimeType || '').trim() || (
      kind === 'video'
        ? 'video/mp4'
        : kind === 'audio'
          ? 'audio/mpeg'
          : 'image/png'
    ),
    dataBase64,
  };
}

async function resolveAssetPayload(body, kind, request) {
  const sourceUrl = String(body?.sourceUrl || '').trim();
  if (sourceUrl) {
    if (sourceUrl.startsWith('blob:')) {
      throw new Error('bridge 无法直接读取浏览器 blob 地址，请先转换为 data URL。');
    }

    const resolvedSourceUrl = resolveSourceUrl(sourceUrl, request);
    try {
      const response = await fetch(resolvedSourceUrl);
      if (!response.ok) {
        throw new Error(`读取媒体文件失败 (${response.status})`);
      }

      const responseMimeType = String(response.headers.get('content-type') || '').split(';')[0].trim();
      const buffer = Buffer.from(await response.arrayBuffer());
      const mimeType = resolveFetchedMimeType(resolvedSourceUrl, kind, responseMimeType, buffer);
      return {
        mimeType,
        dataBase64: buffer.toString('base64'),
      };
    } catch (error) {
      throw new Error(`读取媒体文件失败：${normalizeErrorMessage(error)}`);
    }
  }

  return extractBase64Payload(body, kind);
}

function buildUploadFileName(entry, index, kind, mimeType) {
  const requestedFileName = basename(String(entry?.filename || '').trim());
  const extension = getMimeExtension(mimeType, kind);
  const baseName = requestedFileName
    ? requestedFileName.replace(/\.[^.]+$/u, '')
    : `scene-${index + 1}`;
  return `${baseName}.${extension}`;
}

function resolveAssetLibraryAbsolutePath(rootPath, relativePath) {
  const safeRelativePath = sanitizeRelativePath(relativePath);
  const absolutePath = resolve(rootPath, ...safeRelativePath.split('/'));
  const normalizedRoot = rootPath.endsWith(sep) ? rootPath : `${rootPath}${sep}`;
  if (absolutePath !== rootPath && !absolutePath.startsWith(normalizedRoot)) {
    throw new Error('资产文件路径越界。');
  }

  return {
    safeRelativePath,
    absolutePath,
  };
}

function getDownloadsDirectory() {
  return resolve(process.env.XDG_DOWNLOAD_DIR || join(homedir(), 'Downloads'));
}

async function resolveAvailableDestination(directory, fileName, reservedNames = new Set()) {
  const parsedExtension = extname(fileName);
  const baseName = basename(fileName, parsedExtension) || 'video';
  let candidateName = fileName;
  let counter = 1;

  while (reservedNames.has(candidateName) || await pathExists(join(directory, candidateName))) {
    candidateName = `${baseName}-${counter}${parsedExtension}`;
    counter += 1;
  }

  reservedNames.add(candidateName);
  return join(directory, candidateName);
}

async function getAssetLibraryConfig() {
  await ensureDir(persistentDataRoot);
  const config = await loadBridgeConfig();
  const rootPath = normalizeAssetLibraryRoot(config.assetLibraryRootPath);
  await ensureDir(rootPath);

  return {
    rootPath,
    defaultRootPath: defaultAssetLibraryRoot,
    usingDefaultPath: rootPath === defaultAssetLibraryRoot,
  };
}

async function updateAssetLibraryConfig(rootPathInput, migrateExistingFiles = true) {
  const previous = await getAssetLibraryConfig();
  const nextRootPath = normalizeAssetLibraryRoot(rootPathInput);

  if (migrateExistingFiles && previous.rootPath !== nextRootPath && await pathExists(previous.rootPath)) {
    await ensureDir(nextRootPath);
    await cp(previous.rootPath, nextRootPath, {
      recursive: true,
      force: true,
    });
  } else {
    await ensureDir(nextRootPath);
  }

  await saveBridgeConfig({
    assetLibraryRootPath: nextRootPath === defaultAssetLibraryRoot ? '' : nextRootPath,
  });

  return getAssetLibraryConfig();
}

function buildAssetLibraryRelativePath(body, mimeType) {
  const kind = body?.kind === 'video' ? 'video' : 'image';
  const groupFolder = sanitizePathSegment(body?.groupName, '未分组');
  const projectFolder = sanitizePathSegment(body?.projectName, '未命名项目');
  const mediaFolder = kind === 'video' ? 'videos' : 'images';
  const fileName = buildAssetLibraryFileName({
    assetId: body?.assetId,
    title: body?.title,
    fileName: body?.fileName,
    mimeType,
    kind,
    sanitizePathSegment,
    getMimeExtension,
  });

  return `${groupFolder}/${projectFolder}/${mediaFolder}/${fileName}`;
}

async function listDownloadedFiles(submitId) {
  const directory = taskDir(submitId);
  await ensureDir(directory);
  const entries = await readdir(directory);
  const files = [];

  for (const entry of entries) {
    const absolutePath = join(directory, entry);
    const fileStat = await stat(absolutePath);
    if (!fileStat.isFile()) {
      continue;
    }
    if (!allowedVideoExtensions.has(extname(entry).toLowerCase())) {
      continue;
    }
    files.push({
      name: entry,
      url: `/api/seedance/file/${encodeURIComponent(submitId)}/${encodeURIComponent(entry)}`,
      size: fileStat.size,
    });
  }

  return files.sort((left, right) => left.name.localeCompare(right.name));
}

app.get('/api/seedance/health', async (_request, response) => {
  try {
    await ensureDir(bridgeRoot);
    response.json(await checkHealth());
  } catch (error) {
    response.status(500).json({
      cliAvailable: false,
      loginStatus: 'error',
      modelVersions: supportedModelVersions,
      checkedAt: new Date().toISOString(),
      error: normalizeErrorMessage(error),
    });
  }
});

app.post('/api/seedance/state/reset', (_request, response) => {
  try {
    response.json({
      ok: true,
      ...appStateStore.reset(),
    });
  } catch (error) {
    response.status(500).json({
      error: normalizeErrorMessage(error),
    });
  }
});

app.get('/api/seedance/state/:key', (request, response) => {
  try {
    const entry = appStateStore.get(request.params.key);
    response.json(entry || {
      key: String(request.params.key || '').trim(),
      value: null,
      updatedAt: null,
    });
  } catch (error) {
    response.status(400).json({
      error: normalizeErrorMessage(error),
    });
  }
});

app.put('/api/seedance/state/:key', (request, response) => {
  try {
    response.json(appStateStore.set(request.params.key, request.body?.value ?? null));
  } catch (error) {
    response.status(400).json({
      error: normalizeErrorMessage(error),
    });
  }
});

registerOpenAIImageBridgeRoutes(app, {
  normalizeErrorMessage,
  resolveAssetPayload,
  validateAssetMimeType,
  extractBase64Payload,
  getMimeExtension,
});

app.get('/api/seedance/assets/config', async (_request, response) => {
  try {
    response.json(await getAssetLibraryConfig());
  } catch (error) {
    response.status(500).json({
      error: normalizeErrorMessage(error),
    });
  }
});

app.post('/api/seedance/assets/config', async (request, response) => {
  try {
    response.json(await updateAssetLibraryConfig(
      request.body?.rootPath,
      request.body?.migrateExistingFiles !== false,
    ));
  } catch (error) {
    response.status(500).json({
      error: normalizeErrorMessage(error),
    });
  }
});

app.post('/api/seedance/assets/save', async (request, response) => {
  try {
    const kind = request.body?.kind === 'video' ? 'video' : 'image';
    const { rootPath } = await getAssetLibraryConfig();
    const { mimeType, dataBase64 } = await resolveAssetPayload(request.body, kind, request);
    validateAssetMimeType(kind, mimeType);
    const relativePath = buildAssetLibraryRelativePath(request.body, mimeType);
    const { safeRelativePath, absolutePath } = resolveAssetLibraryAbsolutePath(rootPath, relativePath);

    await ensureDir(dirname(absolutePath));
    await writeFile(absolutePath, Buffer.from(dataBase64, 'base64'));

    response.json({
      rootPath,
      relativePath: safeRelativePath,
      absolutePath,
      fileName: basename(absolutePath),
      kind,
      url: `/api/seedance/assets/file?path=${encodeURIComponent(safeRelativePath)}&t=${Date.now()}`,
    });
  } catch (error) {
    response.status(500).json({
      error: normalizeErrorMessage(error),
    });
  }
});

app.get('/api/seedance/assets/file', async (request, response) => {
  try {
    const relativePath = String(request.query.path || '').trim();
    const { rootPath } = await getAssetLibraryConfig();
    const { absolutePath } = resolveAssetLibraryAbsolutePath(rootPath, relativePath);
    const fileBuffer = await readFile(absolutePath);
    const fileName = basename(absolutePath);
    response.setHeader('Content-Type', detectContentType(fileName));
    response.send(fileBuffer);
  } catch (error) {
    response.status(404).json({
      error: normalizeErrorMessage(error),
    });
  }
});

app.post('/api/seedance/assets/copy-to-downloads', async (request, response) => {
  try {
    const relativePaths = Array.isArray(request.body?.relativePaths)
      ? request.body.relativePaths.map((item) => String(item || '').trim()).filter(Boolean)
      : [];

    if (relativePaths.length === 0) {
      throw new Error('没有可复制的视频文件。');
    }

    const { rootPath } = await getAssetLibraryConfig();
    const downloadsDir = getDownloadsDirectory();
    await ensureDir(downloadsDir);
    const reservedNames = new Set();
    const copiedFiles = [];

    for (const relativePath of relativePaths) {
      const { safeRelativePath, absolutePath } = resolveAssetLibraryAbsolutePath(rootPath, relativePath);
      const fileStat = await stat(absolutePath);
      if (!fileStat.isFile()) {
        throw new Error(`资产不是文件：${safeRelativePath}`);
      }
      const destinationPath = await resolveAvailableDestination(downloadsDir, basename(absolutePath), reservedNames);
      await copyFile(absolutePath, destinationPath);
      copiedFiles.push({
        relativePath: safeRelativePath,
        destinationPath,
        fileName: basename(destinationPath),
      });
    }

    response.json({
      downloadsDir,
      copiedFiles,
    });
  } catch (error) {
    response.status(500).json({
      error: normalizeErrorMessage(error),
    });
  }
});

app.post('/api/seedance/submit', async (request, response) => {
  try {
    const projectId = String(request.body?.projectId || '').trim() || 'fast-project';
    const prompt = String(request.body?.prompt || '').trim();
    const modelVersion = normalizeModelVersion(request.body?.options?.modelVersion);
    const ratio = String(request.body?.options?.ratio || '16:9').trim() || '16:9';
    const duration = Math.max(4, Math.min(15, Number(request.body?.options?.duration) || 10));
    const requestedResolution = String(request.body?.options?.videoResolution || '720p').trim();
    const videoResolution = requestedResolution === '480p' || requestedResolution === '1080p' ? requestedResolution : '720p';
    const images = Array.isArray(request.body?.images) ? request.body.images : [];
    const videos = Array.isArray(request.body?.videos) ? request.body.videos : [];
    const audios = Array.isArray(request.body?.audios) ? request.body.audios : [];

    if (!prompt) {
      response.status(400).json({ error: '视频提示词不能为空。' });
      return;
    }

    const hasVisualAsset = images.length > 0 || videos.length > 0;
    if (!hasVisualAsset && audios.length > 0) {
      response.status(400).json({ error: '不能只提交音频，至少需要 1 个图片或视频素材。' });
      return;
    }

    const uploadId = crypto.randomUUID();
    const workingDir = uploadDir(projectId, uploadId);
    await ensureDir(workingDir);

    const imagePaths = [];
    const videoPaths = [];
    const audioPaths = [];
    for (let index = 0; index < images.length; index += 1) {
      const image = images[index];
      const { mimeType, dataBase64 } = await resolveAssetPayload(image, 'image', request);
      validateAssetMimeType('image', mimeType);
      const safeName = basename(buildUploadFileName(image, index, 'image', mimeType));
      const targetPath = join(workingDir, safeName);
      await writeBase64File(targetPath, dataBase64);
      imagePaths.push(targetPath);
    }
    for (let index = 0; index < videos.length; index += 1) {
      const video = videos[index];
      const { mimeType, dataBase64 } = await resolveAssetPayload(video, 'video', request);
      validateAssetMimeType('video', mimeType);
      const safeName = basename(buildUploadFileName(video, index, 'video', mimeType));
      const targetPath = join(workingDir, safeName);
      await writeBase64File(targetPath, dataBase64);
      videoPaths.push(targetPath);
    }
    for (let index = 0; index < audios.length; index += 1) {
      const audio = audios[index];
      const { mimeType, dataBase64 } = await resolveAssetPayload(audio, 'audio', request);
      validateAssetMimeType('audio', mimeType);
      const safeName = basename(buildUploadFileName(audio, index, 'audio', mimeType));
      const targetPath = join(workingDir, safeName);
      await writeBase64File(targetPath, dataBase64);
      audioPaths.push(targetPath);
    }

    const submitCommand = hasVisualAsset ? 'multimodal2video' : 'text2video';
    const args = [
      submitCommand,
      ...imagePaths.flatMap((imagePath) => ['--image', imagePath]),
      ...videoPaths.flatMap((videoPath) => ['--video', videoPath]),
      ...audioPaths.flatMap((audioPath) => ['--audio', audioPath]),
      `--prompt=${prompt}`,
      `--model_version=${modelVersion}`,
      `--ratio=${ratio}`,
      `--video_resolution=${videoResolution}`,
      `--duration=${duration}`,
      '--poll=0',
    ];

    const { payload } = await runDreaminaJson(args);
    const submitId = String(payload?.submit_id || payload?.submitId || '').trim();
    const genStatus = String(payload?.gen_status || payload?.genStatus || '').trim();

    if (!submitId) {
      throw new Error('Dreamina 未返回 submit_id。');
    }

    await ensureDir(taskDir(submitId));
    await saveRawPayload(join(taskDir(submitId), 'submit.json'), payload);

    response.json({
      submitId,
      genStatus,
      raw: payload,
    });
  } catch (error) {
    response.status(500).json({
      error: normalizeErrorMessage(error),
    });
  }
});

app.get('/api/seedance/task/:submitId', async (request, response) => {
  try {
    const submitId = String(request.params.submitId || '').trim();
    if (!submitId) {
      response.status(400).json({ error: 'submitId 不能为空。' });
      return;
    }

    const directory = taskDir(submitId);
    await ensureDir(directory);

    let payload;
    let fallbackUsed = false;

    try {
      // Priority 1: Use query_result (WITHOUT --download_dir to avoid CLI bug)
      const result = await runDreaminaJson([
        'query_result',
        `--submit_id=${submitId}`,
      ]);
      payload = result.payload;
    } catch (queryError) {
      console.warn(`[SeedanceBridge] query_result failed for ${submitId}, attempting list_task fallback:`, normalizeErrorMessage(queryError));

      try {
        // Priority 2: Fallback to list_task (only provides status, NO download)
        const listResult = await runDreaminaJson([
          'list_task',
          `--submit_id=${submitId}`,
        ]);

        const tasks = Array.isArray(listResult.payload) ? listResult.payload : [];
        const task = tasks.find((t) => t.submit_id === submitId || t.submitId === submitId);

        if (!task) {
          throw new Error('未在任务列表中找到该任务 ID。');
        }

        payload = task;
        fallbackUsed = true;
      } catch (fallbackError) {
        // Both failed, throw the original query_result error so user knows the first failure reason
        throw queryError;
      }
    }


    // Custom media downloader to bypass CLI bug where --download_dir creates corrupt files
    if (payload && payload.result_json) {
      const { videos = [], images = [] } = payload.result_json;
      
      for (let i = 0; i < videos.length; i++) {
        const url = videos[i].video_url;
        if (url) {
          const extension = videos[i].format ? `.${videos[i].format.replace(/^\./, '')}` : '.mp4';
          const fileName = `${submitId}_video_${i + 1}${extension}`;
          const filePath = resolve(directory, fileName);
          
          let needsDownload = true;
          try {
            const stats = await stat(filePath);
            if (stats.size > 200000) { // 200KB min size heuristic for a video
              needsDownload = false;
            }
          } catch {}
          
          if (needsDownload) {
            try {
              const res = await fetch(url);
              if (res.ok) {
                const buffer = await res.arrayBuffer();
                await writeFile(filePath, Buffer.from(buffer));
              }
            } catch (err) {
              console.warn(`[SeedanceBridge] failed to fetch video ${fileName}:`, err);
            }
          }
        }
      }
      
      for (let i = 0; i < images.length; i++) {
        const url = images[i].image_url;
        if (url) {
          const fileName = `${submitId}_image_${i + 1}.png`;
          const filePath = resolve(directory, fileName);
          
          let needsDownload = true;
          try {
            const stats = await stat(filePath);
            if (stats.size > 1000) {
              needsDownload = false;
            }
          } catch {}
          
          if (needsDownload) {
            try {
              const res = await fetch(url);
              if (res.ok) {
                const buffer = await res.arrayBuffer();
                await writeFile(filePath, Buffer.from(buffer));
              }
            } catch (err) {
              console.warn(`[SeedanceBridge] failed to fetch image ${fileName}:`, err);
            }
          }
        }
      }
    }

    await saveRawPayload(join(directory, 'result.json'), payload);
    response.json({
      submitId,
      genStatus: payload?.gen_status || payload?.genStatus || '',
      queueInfo: payload?.queue_info || payload?.queueInfo || {},
      downloadedFiles: await listDownloadedFiles(submitId),
      fallbackUsed,
      raw: payload,
    });
  } catch (error) {
    response.status(500).json({
      error: normalizeErrorMessage(error),
    });
  }
});

app.get('/api/seedance/file/:submitId/:filename', async (request, response) => {
  try {
    const submitId = String(request.params.submitId || '').trim();
    const requestedFileName = basename(String(request.params.filename || '').trim());
    if (!submitId || !requestedFileName) {
      response.status(400).json({ error: '文件参数无效。' });
      return;
    }

    const absolutePath = resolve(taskDir(submitId), requestedFileName);
    const fileBuffer = await readFile(absolutePath);
    response.setHeader('Content-Type', 'video/mp4');
    response.send(fileBuffer);
  } catch (error) {
    response.status(404).json({
      error: normalizeErrorMessage(error),
    });
  }
});

app.delete('/api/seedance/file/:submitId/:filename', async (request, response) => {
  try {
    const submitId = String(request.params.submitId || '').trim();
    const requestedFileName = basename(String(request.params.filename || '').trim());
    if (!submitId || !requestedFileName) {
      response.status(400).json({ error: '文件参数无效。' });
      return;
    }

    await unlink(resolve(taskDir(submitId), requestedFileName));
    response.json({ ok: true });
  } catch (error) {
    response.status(404).json({
      error: normalizeErrorMessage(error),
    });
  }
});

async function start() {
  await ensureDir(bridgeRoot);
  app.listen(port, '127.0.0.1', () => {
    console.log(`Seedance bridge listening on http://127.0.0.1:${port}`);
  });
}

start().catch((error) => {
  console.error('Failed to start Seedance bridge', error);
  process.exitCode = 1;
});
