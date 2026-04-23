import type { OpenAIImageOutputFormat, OpenAIImageQuality, OpenAIImageModeration } from '../../services/openaiImageService.ts';

export type ImageCreationReference = {
  id: string;
  title: string;
  sourceUrl: string;
  fileName?: string;
};

export type ImageCreationOutput = {
  id: string;
  title: string;
  url: string;
  savedRelativePath: string;
  createdAt: string;
};

export type ImageCreationRecord = {
  id: string;
  groupId: string;
  groupName: string;
  title: string;
  prompt: string;
  provider: 'openai';
  model: string;
  createdAt: string;
  request: {
    size: string;
    quality: OpenAIImageQuality;
    outputFormat: OpenAIImageOutputFormat;
    outputCompression?: number;
    moderation: OpenAIImageModeration;
    n: number;
    referenceImageUrls: string[];
  };
  outputs: ImageCreationOutput[];
};

export type ImageCreationDraft = {
  title: string;
  groupMode: 'existing' | 'new';
  existingGroupId: string;
  newGroupName: string;
  prompt: string;
  size: string;
  quality: OpenAIImageQuality;
  outputFormat: OpenAIImageOutputFormat;
  outputCompression: number;
  moderation: OpenAIImageModeration;
  n: number;
  references: ImageCreationReference[];
};

export type ImageCreationGroupOption = {
  id: string;
  name: string;
};
