import { useEffect, useRef, useState } from 'react';

import { loadPersistedAppState, savePersistedAppState } from '../../app/services/appStateStore.ts';
import type { ImageCreationRecord } from '../types.ts';

const IMAGE_CREATION_RECORDS_STATE_KEY = 'image_creation_records';
const IMAGE_CREATION_RECORDS_PERSIST_DELAY_MS = 500;

function normalizeImageCreationRecord(value: Partial<ImageCreationRecord>): ImageCreationRecord | null {
  const id = typeof value.id === 'string' && value.id.trim() ? value.id.trim() : '';
  const prompt = typeof value.prompt === 'string' ? value.prompt : '';
  if (!id || !prompt.trim()) {
    return null;
  }

  return {
    id,
    groupId: typeof value.groupId === 'string' && value.groupId.trim() ? value.groupId.trim() : `image-group:${id}`,
    groupName: typeof value.groupName === 'string' && value.groupName.trim() ? value.groupName.trim() : '未分组',
    title: typeof value.title === 'string' && value.title.trim() ? value.title.trim() : '图片制作',
    prompt,
    provider: 'openai',
    model: typeof value.model === 'string' && value.model.trim() ? value.model.trim() : 'gpt-image-2',
    createdAt: typeof value.createdAt === 'string' && value.createdAt.trim() ? value.createdAt.trim() : new Date().toISOString(),
    request: {
      size: typeof value.request?.size === 'string' && value.request.size.trim() ? value.request.size.trim() : 'auto',
      quality: value.request?.quality === 'low' || value.request?.quality === 'medium' || value.request?.quality === 'high' ? value.request.quality : 'auto',
      outputFormat: value.request?.outputFormat === 'jpeg' || value.request?.outputFormat === 'webp' ? value.request.outputFormat : 'png',
      outputCompression: typeof value.request?.outputCompression === 'number' ? value.request.outputCompression : undefined,
      moderation: value.request?.moderation === 'low' ? 'low' : 'auto',
      n: Number.isFinite(value.request?.n) ? Math.max(1, Math.min(4, Math.round(Number(value.request?.n)))) : 1,
      referenceImageUrls: Array.isArray(value.request?.referenceImageUrls)
        ? value.request.referenceImageUrls.map((item) => String(item || '').trim()).filter(Boolean)
        : [],
    },
    outputs: Array.isArray(value.outputs)
      ? value.outputs
        .map((output) => ({
          id: typeof output.id === 'string' && output.id.trim() ? output.id.trim() : crypto.randomUUID(),
          title: typeof output.title === 'string' && output.title.trim() ? output.title.trim() : '生成图片',
          url: typeof output.url === 'string' ? output.url.trim() : '',
          savedRelativePath: typeof output.savedRelativePath === 'string' ? output.savedRelativePath.trim() : '',
          createdAt: typeof output.createdAt === 'string' && output.createdAt.trim() ? output.createdAt.trim() : new Date().toISOString(),
        }))
        .filter((output) => output.url)
      : [],
  };
}

export function useImageCreationRecords(suspendPersistence = false) {
  const [records, setRecords] = useState<ImageCreationRecord[]>([]);
  const [isLoaded, setIsLoaded] = useState(false);
  const loadedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;

    const hydrate = async () => {
      try {
        const persisted = await loadPersistedAppState<ImageCreationRecord[]>(IMAGE_CREATION_RECORDS_STATE_KEY);
        if (cancelled) {
          return;
        }

        const nextRecords = Array.isArray(persisted.value)
          ? persisted.value
            .map((item) => normalizeImageCreationRecord(item))
            .filter((item): item is ImageCreationRecord => Boolean(item))
          : [];
        setRecords(nextRecords);
      } catch (error) {
        console.error('Failed to load image creation records', error);
      } finally {
        if (!cancelled) {
          loadedRef.current = true;
          setIsLoaded(true);
        }
      }
    };

    void hydrate();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!loadedRef.current || suspendPersistence) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      void (async () => {
        try {
          await savePersistedAppState(IMAGE_CREATION_RECORDS_STATE_KEY, records);
        } catch (error) {
          console.error('Failed to save image creation records', error);
        }
      })();
    }, IMAGE_CREATION_RECORDS_PERSIST_DELAY_MS);

    return () => window.clearTimeout(timeoutId);
  }, [records, suspendPersistence]);

  return {
    records,
    setRecords,
    isLoaded,
  };
}
