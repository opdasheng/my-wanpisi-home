import type { ApiSettings, Asset, VisualAspectRatio } from '../types.ts';
import { loadApiSettings, resolveOpenAIBaseUrl } from './apiConfig.ts';
import { buildSeedanceBridgeRequestUrl } from './seedanceBridgeUrl.ts';

export type OpenAIImageQuality = 'auto' | 'low' | 'medium' | 'high';
export type OpenAIImageOutputFormat = 'png' | 'jpeg' | 'webp';
export type OpenAIImageModeration = 'auto' | 'low';

export type OpenAIImageGenerationReference = {
  sourceUrl: string;
  fileName?: string;
};

export type OpenAIImageGenerationRequest = {
  prompt: string;
  modelName?: string;
  size?: string;
  quality?: OpenAIImageQuality;
  outputFormat?: OpenAIImageOutputFormat;
  outputCompression?: number;
  moderation?: OpenAIImageModeration;
  n?: number;
  references?: OpenAIImageGenerationReference[];
  apiSettings?: ApiSettings;
};

export type OpenAIImageGenerationResult = {
  images: string[];
  raw: unknown;
};

type BridgeImagePayload = {
  [key: string]: unknown;
  data?: unknown;
  images?: unknown;
  output?: unknown;
};

type OpenAIImageCandidate = {
  base64?: string;
  dataUrl?: string;
  url?: string;
  source: string;
};

const OPENAI_ASPECT_RATIO_SIZE_VALUES = [
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
] as const;

function getGreatestCommonDivisor(first: number, second: number): number {
  let a = Math.abs(Math.round(first));
  let b = Math.abs(Math.round(second));

  while (b > 0) {
    const next = a % b;
    a = b;
    b = next;
  }

  return a || 1;
}

function getRuntimeEnv() {
  const viteEnv = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env || {};
  const processEnv = typeof globalThis !== 'undefined' && 'process' in globalThis
    ? ((globalThis as typeof globalThis & { process?: { env?: Record<string, string | undefined> } }).process?.env || {})
    : {};

  return {
    ...processEnv,
    ...viteEnv,
  };
}

function resolveOpenAIApiKey(apiSettings: ApiSettings) {
  const env = getRuntimeEnv();
  return (
    apiSettings.openai.apiKey.trim()
    || env.VITE_OPENAI_API_KEY
    || env.OPENAI_API_KEY
    || ''
  ).trim();
}

function isMissingOpenAIRouteError(errorMessage: string) {
  return /Cannot POST\s+\/api\/seedance\/openai\/images\//iu.test(errorMessage)
    || /HTTP 404/iu.test(errorMessage);
}

function getOpenAIBridgeCandidateUrls(path: string, apiSettings: ApiSettings) {
  const urls = [
    buildSeedanceBridgeRequestUrl(path),
    buildSeedanceBridgeRequestUrl(path, 'http://127.0.0.1:3211/api/seedance'),
  ];

  const configuredBridgeUrl = apiSettings.seedance.bridgeUrl.trim();
  if (configuredBridgeUrl) {
    urls.push(buildSeedanceBridgeRequestUrl(path, configuredBridgeUrl));
  }

  return Array.from(new Set(urls.filter(Boolean)));
}

async function postBridgeJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const text = await response.text();
  let payload: any = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { error: text || `HTTP ${response.status}` };
  }

  if (!response.ok) {
    throw new Error(payload?.error || payload?.message || `HTTP ${response.status}`);
  }

  return payload as T;
}

async function requestJson<T>(path: string, body: unknown, apiSettings: ApiSettings): Promise<T> {
  const urls = getOpenAIBridgeCandidateUrls(path, apiSettings);
  let lastError: unknown = null;

  for (let index = 0; index < urls.length; index += 1) {
    try {
      return await postBridgeJson<T>(urls[index], body);
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      const shouldTryNext = isMissingOpenAIRouteError(message) || message.includes('Failed to fetch');
      if (!shouldTryNext || index === urls.length - 1) {
        throw error;
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError || 'OpenAI bridge 请求失败。'));
}

function normalizeCount(value?: number) {
  if (!Number.isFinite(value)) {
    return 1;
  }
  return Math.max(1, Math.min(4, Math.round(Number(value))));
}

function normalizeCompression(value?: number) {
  if (!Number.isFinite(value)) {
    return undefined;
  }
  return Math.max(0, Math.min(100, Math.round(Number(value))));
}

function getMimeTypeForFormat(format: OpenAIImageOutputFormat = 'png') {
  if (format === 'jpeg') {
    return 'image/jpeg';
  }
  if (format === 'webp') {
    return 'image/webp';
  }
  return 'image/png';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function getStringValue(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

function pushOpenAIImageStringCandidate(candidates: OpenAIImageCandidate[], value: unknown, source: string) {
  const normalized = getStringValue(value);
  if (!normalized) {
    return;
  }

  if (/^data:image\//iu.test(normalized)) {
    candidates.push({ dataUrl: normalized, source });
    return;
  }

  if (/^(?:https?:)?\/\//iu.test(normalized) || normalized.startsWith('/')) {
    candidates.push({ url: normalized, source });
    return;
  }

  candidates.push({ base64: normalized, source });
}

function pushOpenAIImageUrlCandidate(candidates: OpenAIImageCandidate[], value: unknown, source: string) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => pushOpenAIImageUrlCandidate(candidates, item, `${source}[${index}]`));
    return;
  }

  const normalized = getStringValue(value);
  if (normalized) {
    candidates.push({ url: normalized, source });
  }
}

function pushOpenAIImageRecordCandidates(
  candidates: OpenAIImageCandidate[],
  record: Record<string, unknown>,
  source: string,
  pushUnknown: (value: unknown, source: string) => void,
) {
  const base64Fields = ['b64_json', 'result', 'image_base64', 'base64', 'image', 'data'];
  for (const field of base64Fields) {
    pushOpenAIImageStringCandidate(candidates, record[field], `${source}.${field}`);
  }

  const urlFields = ['url', 'image_url', 'imageUrl'];
  for (const field of urlFields) {
    pushOpenAIImageUrlCandidate(candidates, record[field], `${source}.${field}`);
  }

  const nestedFields = ['result', 'results', 'images', 'image_urls', 'imageUrls', 'output', 'outputs', 'items', 'files'];
  for (const field of nestedFields) {
    const value = record[field];
    if (Array.isArray(value) || isRecord(value)) {
      pushUnknown(value, `${source}.${field}`);
    }
  }
}

function collectOpenAIImageCandidates(payload: BridgeImagePayload) {
  const candidates: OpenAIImageCandidate[] = [];

  const pushUnknown = (value: unknown, source: string) => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => pushUnknown(item, `${source}[${index}]`));
      return;
    }
    if (isRecord(value)) {
      pushOpenAIImageRecordCandidates(candidates, value, source, pushUnknown);
      return;
    }
    pushOpenAIImageStringCandidate(candidates, value, source);
  };

  pushUnknown(payload.data, 'data');
  pushUnknown(payload.images, 'images');
  pushUnknown(payload.output, 'output');

  if (isRecord(payload)) {
    pushOpenAIImageRecordCandidates(candidates, payload, 'root', pushUnknown);
  }

  return candidates;
}

function summarizePayloadCollection(value: unknown) {
  if (Array.isArray(value)) {
    const firstRecord = value.find(isRecord);
    return {
      count: value.length,
      firstKeys: firstRecord ? Object.keys(firstRecord).slice(0, 12) : [],
    };
  }
  if (isRecord(value)) {
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

function summarizeOpenAIImagePayload(payload: BridgeImagePayload) {
  if (!isRecord(payload)) {
    return `payloadType=${typeof payload}`;
  }

  const rootKeys = Object.keys(payload).slice(0, 12);
  const dataSummary = summarizePayloadCollection(payload.data);
  const imagesSummary = summarizePayloadCollection(payload.images);
  const outputSummary = summarizePayloadCollection(payload.output);

  return [
    `rootKeys=${rootKeys.join(',') || 'none'}`,
    `dataCount=${dataSummary.count}`,
    `dataFirstKeys=${dataSummary.firstKeys.join(',') || 'none'}`,
    `imagesCount=${imagesSummary.count}`,
    `outputCount=${outputSummary.count}`,
    `outputFirstKeys=${outputSummary.firstKeys.join(',') || 'none'}`,
  ].join('; ');
}

async function normalizeImageResults(payload: BridgeImagePayload, outputFormat: OpenAIImageOutputFormat) {
  const mimeType = getMimeTypeForFormat(outputFormat);
  const images: string[] = [];
  const candidates = collectOpenAIImageCandidates(payload);

  for (const candidate of candidates) {
    if (candidate.dataUrl) {
      images.push(candidate.dataUrl);
      continue;
    }
    if (candidate.base64) {
      images.push(`data:${mimeType};base64,${candidate.base64}`);
      continue;
    }
    if (candidate.url) {
      images.push(candidate.url);
    }
  }

  if (images.length === 0) {
    const summary = summarizeOpenAIImagePayload(payload);
    console.warn('[OpenAIImageService] OpenAI response did not contain an image result.', summary);
    throw new Error(`OpenAI 未返回图片结果。响应结构：${summary}`);
  }

  return images;
}

export function mapOpenAIAspectRatioToSize(aspectRatio: VisualAspectRatio): string {
  if (aspectRatio === '9:16') {
    return '864x1536';
  }
  if (aspectRatio === '1:1') {
    return '1024x1024';
  }
  if (aspectRatio === '4:3') {
    return '1344x1008';
  }
  if (aspectRatio === '3:4') {
    return '1008x1344';
  }
  if (aspectRatio === '21:9') {
    return '1792x768';
  }
  return '1536x864';
}

export function mapOpenAIImageSizeToAspectRatio(size: string): string | undefined {
  const normalized = size.trim().toLowerCase();
  if (!normalized || normalized === 'auto') {
    return undefined;
  }

  if (OPENAI_ASPECT_RATIO_SIZE_VALUES.includes(normalized as (typeof OPENAI_ASPECT_RATIO_SIZE_VALUES)[number])) {
    return normalized;
  }

  const match = normalized.match(/^(\d+)\s*x\s*(\d+)$/u);
  if (!match) {
    return undefined;
  }

  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return undefined;
  }

  const divisor = getGreatestCommonDivisor(width, height);
  const reducedRatio = `${width / divisor}:${height / divisor}`;
  if (OPENAI_ASPECT_RATIO_SIZE_VALUES.includes(reducedRatio as (typeof OPENAI_ASPECT_RATIO_SIZE_VALUES)[number])) {
    return reducedRatio;
  }

  const target = width / height;
  const closest = OPENAI_ASPECT_RATIO_SIZE_VALUES
    .map((ratio) => {
      const [ratioWidth, ratioHeight] = ratio.split(':').map(Number);
      return {
        ratio,
        distance: Math.abs((ratioWidth / ratioHeight) - target),
      };
    })
    .sort((left, right) => left.distance - right.distance)[0];

  return closest && closest.distance <= 0.03 ? closest.ratio : undefined;
}

export function assetReferencesToOpenAIReferences(referenceAssets: Asset[] = [], baseImageUrl?: string): OpenAIImageGenerationReference[] {
  const seen = new Set<string>();
  const references: OpenAIImageGenerationReference[] = [];

  const append = (sourceUrl?: string, fileName?: string) => {
    const normalized = String(sourceUrl || '').trim();
    if (!normalized || seen.has(normalized)) {
      return;
    }
    seen.add(normalized);
    references.push({ sourceUrl: normalized, fileName });
  };

  append(baseImageUrl, 'base-image.png');
  referenceAssets.forEach((asset, index) => append(asset.imageUrl, `${asset.name || `reference-${index + 1}`}.png`));
  return references;
}

export async function generateOpenAIImages({
  prompt,
  modelName,
  size = 'auto',
  quality = 'auto',
  outputFormat = 'png',
  outputCompression,
  moderation = 'auto',
  n = 1,
  references = [],
  apiSettings = loadApiSettings(),
}: OpenAIImageGenerationRequest): Promise<OpenAIImageGenerationResult> {
  const normalizedPrompt = prompt.trim();
  if (!normalizedPrompt) {
    throw new Error('图片提示词不能为空。');
  }

  const apiKey = resolveOpenAIApiKey(apiSettings) || (apiSettings.mockApi.enabled ? 'mock-openai-key' : '');
  if (!apiKey) {
    throw new Error('OpenAI API Key 未配置，请先在 API 配置中填写。');
  }

  const normalizedReferences = references
    .map((reference) => ({
      sourceUrl: reference.sourceUrl.trim(),
      fileName: reference.fileName || '',
    }))
    .filter((reference) => reference.sourceUrl);
  const hasReferences = normalizedReferences.length > 0;
  const sizeFallbackAspectRatio = mapOpenAIImageSizeToAspectRatio(size);
  const request = {
    model: modelName?.trim() || apiSettings.openai.imageModel || 'gpt-image-2',
    prompt: normalizedPrompt,
    n: normalizeCount(n),
    size,
    quality,
    output_format: outputFormat,
    moderation,
    ...(sizeFallbackAspectRatio ? { size_fallback_aspect_ratio: sizeFallbackAspectRatio } : {}),
    ...(outputFormat === 'jpeg' || outputFormat === 'webp'
      ? { output_compression: normalizeCompression(outputCompression) }
      : {}),
  };

  const payload = await requestJson<BridgeImagePayload>(
    hasReferences ? '/openai/images/edits' : '/openai/images/generations',
    {
      config: {
        apiKey,
        baseUrl: resolveOpenAIBaseUrl(apiSettings.openai.baseUrl),
      },
      request,
      references: normalizedReferences,
    },
    apiSettings,
  );

  return {
    images: await normalizeImageResults(payload, outputFormat),
    raw: payload,
  };
}

export async function generateOpenAIStoryboardImage(
  prompt: string,
  aspectRatio: VisualAspectRatio,
  modelName?: string,
  referenceAssets: Asset[] = [],
  baseImageUrl?: string,
) {
  const result = await generateOpenAIImages({
    prompt,
    modelName,
    size: mapOpenAIAspectRatioToSize(aspectRatio),
    quality: 'auto',
    outputFormat: 'png',
    n: 1,
    references: assetReferencesToOpenAIReferences(referenceAssets, baseImageUrl),
  });
  return result.images[0];
}
