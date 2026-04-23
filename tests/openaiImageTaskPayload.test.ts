import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getOpenAIAsyncTaskIds,
  getOpenAIAsyncTaskStatus,
  hasOpenAIAsyncTaskImageResult,
  isOpenAIAsyncTaskComplete,
  isOpenAIAsyncTaskFailed,
} from '../server/openaiImageTaskPayload.mjs';

const mockPngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

test('OpenAI task helpers read task ids from wrapped task submissions', () => {
  assert.deepEqual(getOpenAIAsyncTaskIds({
    data: {
      task_id: 'task_123',
      status: 'queued',
    },
  }), ['task_123']);
});

test('OpenAI task helpers read root task status payloads', () => {
  const payload = {
    id: 'task_123',
    status: 'finished',
    result: {
      images: [
        {
          url: ['https://cdn.example.test/generated.png'],
        },
      ],
    },
  };

  assert.equal(getOpenAIAsyncTaskStatus(payload), 'finished');
  assert.equal(hasOpenAIAsyncTaskImageResult(payload), true);
  assert.equal(isOpenAIAsyncTaskComplete(getOpenAIAsyncTaskStatus(payload)), true);
});

test('OpenAI task helpers accept root base64 image results', () => {
  assert.equal(hasOpenAIAsyncTaskImageResult({
    id: 'task_123',
    status: 'completed',
    result: mockPngBase64,
  }), true);
});

test('OpenAI task helpers do not treat normal response ids as async task ids', () => {
  assert.deepEqual(getOpenAIAsyncTaskIds({
    id: 'img_123',
    data: [],
  }), []);
});

test('OpenAI task helpers classify terminal failure statuses', () => {
  assert.equal(isOpenAIAsyncTaskFailed('timed out'), true);
  assert.equal(isOpenAIAsyncTaskFailed('rejected'), true);
});
