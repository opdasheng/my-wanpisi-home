const taskEntryFields = [
  'task_id',
  'taskId',
  'id',
  'status',
  'state',
  'result',
  'results',
  'images',
  'image_urls',
  'imageUrls',
  'output',
  'outputs',
  'error',
  'last_error',
];

const imageStringFields = new Set([
  'b64_json',
  'result',
  'image_base64',
  'base64',
  'image',
  'data',
]);

const imageUrlFields = new Set([
  'url',
  'image_url',
  'imageUrl',
]);

const imageNestedFields = new Set([
  'result',
  'results',
  'images',
  'image_urls',
  'imageUrls',
  'output',
  'outputs',
  'items',
  'files',
  'data',
]);

const completeStatuses = new Set([
  'completed',
  'complete',
  'success',
  'succeeded',
  'succeed',
  'done',
  'finished',
  'finish',
  'generated',
  'generate_success',
  'task_success',
]);

const failedStatuses = new Set([
  'failed',
  'fail',
  'error',
  'errored',
  'cancelled',
  'canceled',
  'expired',
  'timeout',
  'timed_out',
  'rejected',
]);

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function getStringValue(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function shouldUseRootPayloadAsEntry(payload) {
  return isRecord(payload) && taskEntryFields.some((field) => field in payload);
}

export function getOpenAIResponseDataEntries(payload) {
  const data = payload?.data;
  if (Array.isArray(data)) {
    return data.filter(isRecord);
  }
  if (isRecord(data)) {
    return [data];
  }
  if (shouldUseRootPayloadAsEntry(payload)) {
    return [payload];
  }
  return [];
}

function getLikelyTaskId(entry) {
  const explicitId = getStringValue(entry?.task_id || entry?.taskId || entry?.taskID);
  if (explicitId) {
    return explicitId;
  }

  const fallbackId = getStringValue(entry?.id);
  const objectType = getStringValue(entry?.object).toLowerCase();
  if (/^task[_-]/iu.test(fallbackId) || objectType.includes('task')) {
    return fallbackId;
  }

  return '';
}

export function getOpenAIAsyncTaskIds(payload) {
  return getOpenAIResponseDataEntries(payload)
    .map(getLikelyTaskId)
    .filter(Boolean);
}

export function normalizeOpenAITaskStatus(status) {
  return getStringValue(status).toLowerCase().replace(/\s+/gu, '_');
}

export function isOpenAIAsyncTaskComplete(status) {
  return completeStatuses.has(normalizeOpenAITaskStatus(status));
}

export function isOpenAIAsyncTaskFailed(status) {
  return failedStatuses.has(normalizeOpenAITaskStatus(status));
}

export function getOpenAIAsyncTaskStatus(payload) {
  const status = getOpenAIResponseDataEntries(payload)
    .map((entry) => getStringValue(entry.status || entry.state || entry.gen_status || entry.genStatus))
    .find(Boolean);
  return status || '';
}

function getOpenAIErrorMessage(value) {
  if (typeof value === 'string') {
    return value.trim();
  }
  if (!isRecord(value)) {
    return '';
  }

  return getStringValue(value.message)
    || getStringValue(value.msg)
    || getStringValue(value.code)
    || getStringValue(value.type);
}

export function getOpenAIAsyncTaskError(payload) {
  const entry = getOpenAIResponseDataEntries(payload)[0] || {};
  return getOpenAIErrorMessage(entry.error)
    || getOpenAIErrorMessage(entry.last_error)
    || getOpenAIErrorMessage(payload?.error)
    || getStringValue(entry.message)
    || getStringValue(payload?.message)
    || '';
}

function isLikelyBase64Image(value) {
  const normalized = getStringValue(value).replace(/\s+/gu, '');
  return normalized.length > 50 && /^[A-Za-z0-9+/]+={0,2}$/u.test(normalized);
}

function hasImageStringCandidate(value, fieldName) {
  const normalized = getStringValue(value);
  if (!normalized) {
    return false;
  }

  const normalizedFieldName = String(fieldName || '').trim();
  if (/^data:image\//iu.test(normalized)) {
    return true;
  }
  if (imageUrlFields.has(normalizedFieldName) && /^(?:https?:)?\/\//iu.test(normalized)) {
    return true;
  }
  if (imageStringFields.has(normalizedFieldName) && isLikelyBase64Image(normalized)) {
    return true;
  }

  return false;
}

function hasImageCandidate(value, fieldName = '', depth = 0) {
  if (depth > 8) {
    return false;
  }

  if (Array.isArray(value)) {
    return value.some((item) => hasImageCandidate(item, fieldName, depth + 1));
  }

  if (!isRecord(value)) {
    return hasImageStringCandidate(value, fieldName);
  }

  return Object.entries(value).some(([key, nestedValue]) => {
    if (!imageStringFields.has(key) && !imageUrlFields.has(key) && !imageNestedFields.has(key)) {
      return false;
    }
    return hasImageCandidate(nestedValue, key, depth + 1);
  });
}

export function hasOpenAIAsyncTaskImageResult(payload) {
  return getOpenAIResponseDataEntries(payload).some((entry) => hasImageCandidate(entry));
}
