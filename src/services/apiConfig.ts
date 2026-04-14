import modelCatalogConfig from '../config/modelCatalog.json';
import type { ApiSettings, ModelSourceId, PromptLanguage } from '../types.ts';
import { normalizeSeedanceModelVersion } from '../features/seedance/modelVersions.ts';
import { loadPersistedAppState, savePersistedAppState } from '../features/app/services/appStateStore.ts';

export const API_SETTINGS_STATE_KEY = 'api_settings';

export type ModelRole = 'text' | 'image' | 'video';
export type FlowModelCategory = 'text' | 'image' | 'video';
export type ModelProviderId = 'gemini' | 'volcengine';
export type BillingType = 'per_image' | 'per_million_tokens';
export type BillingCurrency = 'CNY' | 'USD';
export interface ModelPricingConfig {
  type: BillingType;
  unitPriceCny?: number;
  unitPriceUsd?: number;
  currency?: BillingCurrency;
  unitPrice?: number;
}

type PricingCatalogConfig = {
  usdToCnyRate?: number;
};

type ProviderCatalog = {
  label: string;
  promptLanguage?: {
    default?: PromptLanguage;
    supported?: PromptLanguage[];
  };
  models: Record<ModelRole, ConfiguredModelCatalogItem[]>;
};

export interface ModelBillingRule {
  type: BillingType;
  currency: BillingCurrency;
  unitPrice: number;
}

export interface ModelSourceOption {
  id: ModelSourceId;
  label: string;
  providerLabel: string;
  value: string;
}

export interface ConfiguredModelCatalogItem {
  name: string;
  modelId: string;
  aliases?: readonly string[];
  pricing?: ModelPricingConfig;
}

export interface VolcengineModelCatalogItem {
  name: string;
  endpointId: string;
  aliases?: readonly string[];
  pricing?: ModelPricingConfig;
}

const MODEL_PROVIDER_CATALOG = modelCatalogConfig.providers as Record<ModelProviderId, ProviderCatalog>;
const PRICING_CATALOG_CONFIG = (modelCatalogConfig.pricingConfig || {}) as PricingCatalogConfig;
const FALLBACK_PROVIDER_PROMPT_LANGUAGE: Record<ModelProviderId, PromptLanguage> = {
  gemini: 'en',
  volcengine: 'zh',
};
const FALLBACK_USD_TO_CNY_RATE = 7.2;

function normalizeUsdToCnyRate(value?: number) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value;
  }
  return FALLBACK_USD_TO_CNY_RATE;
}

const USD_TO_CNY_RATE = normalizeUsdToCnyRate(PRICING_CATALOG_CONFIG.usdToCnyRate);

function normalizePromptLanguageList(values?: PromptLanguage[]): PromptLanguage[] {
  const normalized = (values || []).filter((value): value is PromptLanguage => value === 'zh' || value === 'en');
  if (normalized.length === 0) {
    return ['zh', 'en'];
  }
  return Array.from(new Set(normalized));
}

export function getProviderPromptLanguageCatalog(providerId: ModelProviderId): { default: PromptLanguage; supported: PromptLanguage[] } {
  const config = MODEL_PROVIDER_CATALOG[providerId].promptLanguage;
  const supported = normalizePromptLanguageList(config?.supported);
  const fallback = FALLBACK_PROVIDER_PROMPT_LANGUAGE[providerId];
  const defaultLanguage = (config?.default && supported.includes(config.default))
    ? config.default
    : (supported.includes(fallback) ? fallback : supported[0]);

  return {
    default: defaultLanguage,
    supported,
  };
}

export function getUsdToCnyExchangeRate() {
  return USD_TO_CNY_RATE;
}

export const VOLCENGINE_MODEL_CATALOG: Record<ModelRole, VolcengineModelCatalogItem[]> = {
  text: MODEL_PROVIDER_CATALOG.volcengine.models.text.map((item) => ({
    name: item.name,
    endpointId: item.modelId,
    aliases: item.aliases,
    pricing: item.pricing,
  })),
  image: MODEL_PROVIDER_CATALOG.volcengine.models.image.map((item) => ({
    name: item.name,
    endpointId: item.modelId,
    aliases: item.aliases,
    pricing: item.pricing,
  })),
  video: MODEL_PROVIDER_CATALOG.volcengine.models.video.map((item) => ({
    name: item.name,
    endpointId: item.modelId,
    aliases: item.aliases,
    pricing: item.pricing,
  })),
};

const ROLE_BY_SOURCE_ID: Record<Exclude<ModelSourceId, ''>, ModelRole> = {
  'gemini.textModel': 'text',
  'gemini.imageModel': 'image',
  'gemini.proImageModel': 'image',
  'gemini.fastVideoModel': 'video',
  'gemini.proVideoModel': 'video',
  'volcengine.textModel': 'text',
  'volcengine.imageModel': 'image',
  'volcengine.videoModel': 'video',
};

export const defaultApiSettings: ApiSettings = {
  gemini: {
    apiKey: '',
    promptLanguage: getProviderPromptLanguageCatalog('gemini').default,
    textModel: 'gemini-3-flash-preview',
    imageModel: 'gemini-2.5-flash-image',
    proImageModel: 'gemini-3.1-flash-image-preview',
    fastVideoModel: 'veo-3.1-fast-generate-preview',
    proVideoModel: 'veo-3.1-generate-preview',
  },
  volcengine: {
    enabled: true,
    apiKey: '',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    promptLanguage: getProviderPromptLanguageCatalog('volcengine').default,
    textModel: VOLCENGINE_MODEL_CATALOG.text[0].endpointId,
    imageModel: VOLCENGINE_MODEL_CATALOG.image[0].endpointId,
    videoModel: VOLCENGINE_MODEL_CATALOG.video[0].endpointId,
  },
  seedance: {
    enabled: true,
    apiModel: 'doubao-seedance-2-0-260128',
    fastApiModel: 'doubao-seedance-2-0-fast-260128',
    defaultExecutor: 'ark',
    cliModelVersion: 'seedance2.0',
    pollIntervalSec: 15,
    bridgeUrl: '',
  },
  tos: {
    enabled: false,
    region: 'cn-beijing',
    endpoint: 'https://tos-cn-beijing.volces.com',
    bucket: '',
    accessKeyId: '',
    accessKeySecret: '',
    pathPrefix: 'reference-videos/',
  },
  defaultModels: {
    text: 'gemini.textModel',
    image: 'gemini.imageModel',
    video: 'gemini.fastVideoModel',
  },
};

const MODEL_SOURCE_META: Record<Exclude<ModelSourceId, ''>, { label: string; providerLabel: string }> = {
  'gemini.textModel': { label: '文本模型', providerLabel: MODEL_PROVIDER_CATALOG.gemini.label },
  'gemini.imageModel': { label: '标准图像模型', providerLabel: MODEL_PROVIDER_CATALOG.gemini.label },
  'gemini.proImageModel': { label: '高质量图像模型', providerLabel: MODEL_PROVIDER_CATALOG.gemini.label },
  'gemini.fastVideoModel': { label: '快速视频模型', providerLabel: MODEL_PROVIDER_CATALOG.gemini.label },
  'gemini.proVideoModel': { label: '高质量视频模型', providerLabel: MODEL_PROVIDER_CATALOG.gemini.label },
  'volcengine.textModel': { label: '文本模型', providerLabel: MODEL_PROVIDER_CATALOG.volcengine.label },
  'volcengine.imageModel': { label: '图像模型', providerLabel: MODEL_PROVIDER_CATALOG.volcengine.label },
  'volcengine.videoModel': { label: '视频模型', providerLabel: MODEL_PROVIDER_CATALOG.volcengine.label },
};

const ROLE_SOURCE_IDS: Record<ModelRole, ModelSourceId[]> = {
  text: ['gemini.textModel', 'volcengine.textModel'],
  image: ['gemini.imageModel', 'gemini.proImageModel', 'volcengine.imageModel'],
  video: ['gemini.fastVideoModel', 'gemini.proVideoModel', 'volcengine.videoModel'],
};

export const DEFAULT_MODEL_ROLE_META: Record<ModelRole, { title: string; description: string }> = {
  text: { title: '文本模型', description: '用于简报、提示词和结构化文案生成' },
  image: { title: '生图模型', description: '用于资产图、首帧和尾帧生成' },
  video: { title: '视频模型', description: '用于镜头视频和转场视频生成' },
};
let cachedApiSettings: ApiSettings = defaultApiSettings;

function trimTrailingZeros(value: string) {
  return value.replace(/(\.\d*?[1-9])0+$/u, '$1').replace(/\.0+$/u, '');
}

function formatMoney(amount: number, currency: BillingCurrency) {
  const symbol = currency === 'USD' ? '$' : '¥';
  if (Number.isInteger(amount)) {
    return `${symbol}${amount}`;
  }
  if (amount >= 1) {
    return `${symbol}${trimTrailingZeros(amount.toFixed(2))}`;
  }
  return `${symbol}${trimTrailingZeros(amount.toFixed(4))}`;
}

function getProviderCatalog(providerId: ModelProviderId) {
  return MODEL_PROVIDER_CATALOG[providerId];
}

export function getProviderModelCatalog(providerId: ModelProviderId, role: ModelRole): ConfiguredModelCatalogItem[] {
  return getProviderCatalog(providerId).models[role];
}

function readModelSource(settings: ApiSettings, sourceId: ModelSourceId): string {
  if (!sourceId) {
    return '';
  }
  const [provider, field] = sourceId.split('.') as ['gemini' | 'volcengine', keyof ApiSettings['gemini']];
  const config = settings[provider] as unknown as Record<string, string>;
  return (config[field] || '').trim();
}

export function getProviderDisplayLabel(providerId: ModelProviderId) {
  return getProviderCatalog(providerId).label;
}

export function getModelRoleFromSourceId(sourceId: Exclude<ModelSourceId, ''>): ModelRole {
  return ROLE_BY_SOURCE_ID[sourceId];
}

export function findConfiguredModel(providerId: ModelProviderId, role: ModelRole, modelId: string): ConfiguredModelCatalogItem | undefined {
  const normalized = modelId.trim();
  if (!normalized) {
    return undefined;
  }
  return getProviderCatalog(providerId).models[role].find((item) => {
    const aliases = item.aliases ? [...item.aliases] : [];
    return item.modelId === normalized || aliases.includes(normalized);
  });
}

function normalizePriceValue(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return value;
}

function resolveModelPricing(rule?: ModelPricingConfig): ModelBillingRule | undefined {
  if (!rule || (rule.type !== 'per_image' && rule.type !== 'per_million_tokens')) {
    return undefined;
  }
  const cnyPrice = normalizePriceValue(rule.unitPriceCny);
  if (cnyPrice !== undefined) {
    return { type: rule.type, currency: 'CNY', unitPrice: cnyPrice };
  }
  const usdPriceFromNewField = normalizePriceValue(rule.unitPriceUsd);
  if (usdPriceFromNewField !== undefined) {
    return { type: rule.type, currency: 'CNY', unitPrice: usdPriceFromNew
