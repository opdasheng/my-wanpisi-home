import type { OpenAIImageOutputFormat, OpenAIImageQuality } from '../../../services/openaiImageService.ts';

export type OpenAIImageSizeOption = {
  value: string;
  label: string;
  width?: number;
  height?: number;
  pricingKey?: '1024x1024' | '1024x1536' | '1536x1024';
  experimental?: boolean;
};

export type OpenAIImageCostEstimate = {
  totalUsd: number;
  totalCny: number;
  outputUsd: number;
  inputUsd: number;
  summary: string;
  detail: string;
  exactOutputPrice: boolean;
};

const TEXT_INPUT_USD_PER_MILLION = 5;
const IMAGE_INPUT_USD_PER_MILLION = 8;

const OFFICIAL_OUTPUT_PRICE_USD: Record<'1024x1024' | '1024x1536' | '1536x1024', Record<Exclude<OpenAIImageQuality, 'auto'>, number>> = {
  '1024x1024': {
    low: 0.006,
    medium: 0.053,
    high: 0.211,
  },
  '1024x1536': {
    low: 0.005,
    medium: 0.041,
    high: 0.165,
  },
  '1536x1024': {
    low: 0.005,
    medium: 0.041,
    high: 0.165,
  },
};

export const OPENAI_IMAGE_SIZE_OPTIONS: OpenAIImageSizeOption[] = [
  { value: 'auto', label: 'Auto' },
  { value: '1024x1024', label: '1024 x 1024', width: 1024, height: 1024, pricingKey: '1024x1024' },
  { value: '1536x1024', label: '1536 x 1024', width: 1536, height: 1024, pricingKey: '1536x1024' },
  { value: '1024x1536', label: '1024 x 1536', width: 1024, height: 1536, pricingKey: '1024x1536' },
  { value: '1536x864', label: '1536 x 864', width: 1536, height: 864 },
  { value: '864x1536', label: '864 x 1536', width: 864, height: 1536 },
  { value: '1344x1008', label: '1344 x 1008', width: 1344, height: 1008 },
  { value: '1008x1344', label: '1008 x 1344', width: 1008, height: 1344 },
  { value: '1792x768', label: '1792 x 768', width: 1792, height: 768 },
  { value: '2048x2048', label: '2048 x 2048', width: 2048, height: 2048, experimental: true },
  { value: '2048x1152', label: '2048 x 1152', width: 2048, height: 1152, experimental: true },
  { value: '3840x2160', label: '3840 x 2160', width: 3840, height: 2160, experimental: true },
  { value: '2160x3840', label: '2160 x 3840', width: 2160, height: 3840, experimental: true },
];

export const OPENAI_IMAGE_QUALITY_OPTIONS: Array<{ value: OpenAIImageQuality; label: string }> = [
  { value: 'auto', label: 'Auto' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
];

export const OPENAI_IMAGE_OUTPUT_FORMAT_OPTIONS: Array<{ value: OpenAIImageOutputFormat; label: string }> = [
  { value: 'png', label: 'PNG' },
  { value: 'jpeg', label: 'JPEG' },
  { value: 'webp', label: 'WebP' },
];

function formatUsd(value: number) {
  if (value >= 1) {
    return `$${value.toFixed(2)}`;
  }
  return `$${value.toFixed(4).replace(/0+$/u, '').replace(/\.$/u, '')}`;
}

function formatCny(value: number) {
  if (value >= 1) {
    return `¥${value.toFixed(2).replace(/\.00$/u, '')}`;
  }
  return `¥${value.toFixed(4).replace(/0+$/u, '').replace(/\.$/u, '')}`;
}

function getSizeOption(size: string) {
  return OPENAI_IMAGE_SIZE_OPTIONS.find((option) => option.value === size) || OPENAI_IMAGE_SIZE_OPTIONS[0];
}

function normalizeQuality(quality: OpenAIImageQuality): Exclude<OpenAIImageQuality, 'auto'> {
  return quality === 'auto' ? 'medium' : quality;
}

function estimateTextTokens(prompt: string) {
  const normalized = prompt.trim();
  if (!normalized) {
    return 0;
  }
  return Math.max(1, Math.ceil(normalized.length / 2));
}

function estimateReferenceImageTokens(referenceCount: number) {
  return Math.max(0, referenceCount) * 1024;
}

function getOrientationPricingKey(option: OpenAIImageSizeOption): '1024x1024' | '1024x1536' | '1536x1024' {
  if (option.pricingKey) {
    return option.pricingKey;
  }
  const width = option.width || 1024;
  const height = option.height || 1024;
  if (Math.abs(width - height) / Math.max(width, height) < 0.08) {
    return '1024x1024';
  }
  return height > width ? '1024x1536' : '1536x1024';
}

function getOutputPriceUsd(size: string, quality: OpenAIImageQuality) {
  const option = getSizeOption(size);
  const normalizedQuality = normalizeQuality(quality);
  if (option.pricingKey) {
    return {
      usd: OFFICIAL_OUTPUT_PRICE_USD[option.pricingKey][normalizedQuality],
      exact: quality !== 'auto',
    };
  }

  const key = getOrientationPricingKey(option);
  const baseline = OFFICIAL_OUTPUT_PRICE_USD[key][normalizedQuality];
  const baselinePixels = key === '1024x1024' ? 1024 * 1024 : 1024 * 1536;
  const pixels = (option.width || 1024) * (option.height || 1024);
  const scale = Math.max(0.25, pixels / baselinePixels);
  return {
    usd: baseline * scale,
    exact: false,
  };
}

export function estimateOpenAIImageCost(params: {
  prompt: string;
  size: string;
  quality: OpenAIImageQuality;
  n: number;
  referenceCount: number;
  usdToCnyRate: number;
  outputFormat?: OpenAIImageOutputFormat;
}) : OpenAIImageCostEstimate {
  const count = Math.max(1, Math.min(4, Math.round(Number(params.n) || 1)));
  const textTokens = estimateTextTokens(params.prompt);
  const referenceTokens = estimateReferenceImageTokens(params.referenceCount);
  const inputUsd = ((textTokens * TEXT_INPUT_USD_PER_MILLION) + (referenceTokens * IMAGE_INPUT_USD_PER_MILLION)) / 1_000_000;
  const output = getOutputPriceUsd(params.size, params.quality);
  const outputUsd = output.usd * count;
  const totalUsd = inputUsd + outputUsd;
  const totalCny = totalUsd * params.usdToCnyRate;
  const qualityLabel = params.quality === 'auto' ? 'Auto(按 Medium 估)' : params.quality;
  const sizeLabel = getSizeOption(params.size).label;
  const exactLabel = output.exact ? '官方表价格' : '估算价格';

  return {
    totalUsd,
    totalCny,
    outputUsd,
    inputUsd,
    exactOutputPrice: output.exact,
    summary: `${formatUsd(totalUsd)} / ${formatCny(totalCny)}`,
    detail: `${sizeLabel} · ${qualityLabel} · ${count} 张：输出 ${formatUsd(outputUsd)}（${exactLabel}）；文本约 ${textTokens} tokens，参考图约 ${referenceTokens} image tokens，输入约 ${formatUsd(inputUsd)}。`,
  };
}
