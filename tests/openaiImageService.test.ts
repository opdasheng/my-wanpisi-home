import test from 'node:test';
import assert from 'node:assert/strict';

import { defaultApiSettings } from '../src/services/apiConfig.ts';
import { generateOpenAIImages, mapOpenAIImageSizeToAspectRatio } from '../src/services/openaiImageService.ts';

const mockPngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

test('generateOpenAIImages calls bridge generations without references', async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ input: string; body: any }> = [];

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ input: String(input), body: JSON.parse(String(init?.body || '{}')) });
    return new Response(JSON.stringify({ data: [{ b64_json: mockPngBase64 }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    const result = await generateOpenAIImages({
      prompt: 'test image',
      n: 1,
      size: '1024x1024',
      apiSettings: {
        ...defaultApiSettings,
        openai: {
          ...defaultApiSettings.openai,
          apiKey: 'test-key',
        },
        seedance: {
          ...defaultApiSettings.seedance,
          bridgeUrl: 'http://127.0.0.1:3210/api/seedance',
        },
      },
    });

    assert.equal(calls[0].input, '/api/seedance/openai/images/generations');
    assert.equal(calls[0].body.request.model, 'gpt-image-2');
    assert.equal(calls[0].body.request.prompt, 'test image');
    assert.equal(calls[0].body.request.size, '1024x1024');
    assert.equal(calls[0].body.request.size_fallback_aspect_ratio, '1:1');
    assert.equal(calls[0].body.config.apiKey, 'test-key');
    assert.equal(result.images[0].startsWith('data:image/png;base64,'), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('generateOpenAIImages calls bridge edits with references', async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ input: string; body: any }> = [];

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ input: String(input), body: JSON.parse(String(init?.body || '{}')) });
    return new Response(JSON.stringify({ data: [{ b64_json: mockPngBase64 }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    await generateOpenAIImages({
      prompt: 'use reference',
      references: [{ sourceUrl: 'data:image/png;base64,abc', fileName: 'ref.png' }],
      apiSettings: {
        ...defaultApiSettings,
        openai: {
          ...defaultApiSettings.openai,
          apiKey: 'test-key',
        },
        seedance: {
          ...defaultApiSettings.seedance,
          bridgeUrl: 'http://127.0.0.1:3210/api/seedance',
        },
      },
    });

    assert.equal(calls[0].input, '/api/seedance/openai/images/edits');
    assert.equal(calls[0].body.references[0].fileName, 'ref.png');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('generateOpenAIImages accepts Responses API image_generation_call payloads', async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async () => new Response(JSON.stringify({
    output: [
      {
        type: 'image_generation_call',
        status: 'completed',
        result: mockPngBase64,
      },
    ],
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })) as typeof fetch;

  try {
    const result = await generateOpenAIImages({
      prompt: 'responses payload',
      apiSettings: {
        ...defaultApiSettings,
        openai: {
          ...defaultApiSettings.openai,
          apiKey: 'test-key',
        },
      },
    });

    assert.equal(result.images[0].startsWith('data:image/png;base64,'), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('generateOpenAIImages accepts common OpenAI-compatible image fields', async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async () => new Response(JSON.stringify({
    images: [
      {
        image_base64: mockPngBase64,
      },
    ],
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })) as typeof fetch;

  try {
    const result = await generateOpenAIImages({
      prompt: 'compatible payload',
      apiSettings: {
        ...defaultApiSettings,
        openai: {
          ...defaultApiSettings.openai,
          apiKey: 'test-key',
        },
      },
    });

    assert.equal(result.images[0].startsWith('data:image/png;base64,'), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('generateOpenAIImages accepts APIMart task result image urls', async () => {
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    calls.push(String(input));
    return new Response(JSON.stringify({
      code: 200,
      data: {
        status: 'completed',
        task_id: 'task-1',
        result: {
          images: [
            {
              url: ['https://cdn.example.test/generated.png'],
            },
          ],
        },
      },
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    const result = await generateOpenAIImages({
      prompt: 'apimart payload',
      apiSettings: {
        ...defaultApiSettings,
        openai: {
          ...defaultApiSettings.openai,
          apiKey: 'test-key',
        },
      },
    });

    assert.equal(calls.length, 1);
    assert.equal(result.images[0], 'https://cdn.example.test/generated.png');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('generateOpenAIImages includes response shape when no image fields are present', async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async () => new Response(JSON.stringify({
    data: [
      {
        revised_prompt: 'prompt only',
      },
    ],
    usage: {
      total_tokens: 1,
    },
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })) as typeof fetch;

  try {
    await assert.rejects(
      () => generateOpenAIImages({
        prompt: 'empty payload',
        apiSettings: {
          ...defaultApiSettings,
          openai: {
            ...defaultApiSettings.openai,
            apiKey: 'test-key',
          },
        },
      }),
      /OpenAI 未返回图片结果。响应结构：rootKeys=data,usage; dataCount=1; dataFirstKeys=revised_prompt/u,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('mapOpenAIImageSizeToAspectRatio maps dimensions for aspect-ratio-only endpoints', () => {
  assert.equal(mapOpenAIImageSizeToAspectRatio('1024x1024'), '1:1');
  assert.equal(mapOpenAIImageSizeToAspectRatio('1536x1024'), '3:2');
  assert.equal(mapOpenAIImageSizeToAspectRatio('2048x1152'), '16:9');
  assert.equal(mapOpenAIImageSizeToAspectRatio('1792x768'), '21:9');
  assert.equal(mapOpenAIImageSizeToAspectRatio('9:16'), '9:16');
  assert.equal(mapOpenAIImageSizeToAspectRatio('auto'), undefined);
});

test('generateOpenAIImages falls back to local dev bridge when current proxy is missing the route', async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ input: string; body?: any }> = [];

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ input: String(input), body: JSON.parse(String(init?.body || '{}')) });
    if (calls.length === 1) {
      return new Response('<!DOCTYPE html><pre>Cannot POST /api/seedance/openai/images/generations</pre>', {
        status: 404,
        headers: { 'Content-Type': 'text/html' },
      });
    }

    return new Response(JSON.stringify({ data: [{ b64_json: mockPngBase64 }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    const result = await generateOpenAIImages({
      prompt: 'fallback image',
      apiSettings: {
        ...defaultApiSettings,
        openai: {
          ...defaultApiSettings.openai,
          apiKey: 'test-key',
        },
      },
    });

    assert.equal(calls[0].input, '/api/seedance/openai/images/generations');
    assert.equal(calls[1].input, 'http://127.0.0.1:3211/api/seedance/openai/images/generations');
    assert.equal(result.images.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
