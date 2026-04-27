import type { FastTaskStatus, FastVideoInput } from '../types/fastTypes.ts';

export interface SubmitHappyHorseParams {
  prompt: string;
  imageSources: string[];
  model: string;
  options: {
    ratio: FastVideoInput['aspectRatio'];
    duration: number;
    videoResolution: '480p' | '720p' | '1080p';
  };
  apiKey: string;
  baseUrl?: string;
}

const DEFAULT_BASE_URL = 'https://dashscope.aliyuncs.com/api/v1';

function resolveAliyunBaseUrl(baseUrl?: string) {
  let safeBaseUrl = baseUrl || DEFAULT_BASE_URL;
  // 阿里云的 GET /tasks/{task_id} 接口未配置 CORS OPTIONS 预检响应，浏览器直接调用会抛出 CORS 异常
  // 自动将默认公网地址转为走 vite proxy
  if (safeBaseUrl === 'https://dashscope.aliyuncs.com/api/v1' && typeof window !== 'undefined') {
    safeBaseUrl = '/api/aliyun/api/v1';
  }
  return safeBaseUrl;
}

function generateId() {
  return `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

async function uploadHappyHorseMedia(urlOrData: string, model: string, apiKey: string, baseUrl?: string): Promise<string> {
  const res = await fetch(urlOrData);
  if (!res.ok) {
    throw new Error(`Failed to fetch local media: ${res.statusText}`);
  }
  const blob = await res.blob();
  const ext = blob.type.split('/')[1] || 'png';
  const fileName = `${generateId()}.${ext}`;

  const policyUrl = `${resolveAliyunBaseUrl(baseUrl)}/uploads?action=getPolicy&model=${model}`;
  const policyRes = await fetch(policyUrl, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
    },
  });

  if (!policyRes.ok) {
    const errorText = await policyRes.text().catch(() => '');
    throw new Error(`Failed to get DashScope upload policy: HTTP ${policyRes.status} ${errorText}`);
  }

  const policyJson = await policyRes.json();
  if (policyJson.code && policyJson.code !== 'Success') {
    throw new Error(`Failed to get DashScope upload policy: ${policyJson.message || policyJson.code}`);
  }

  const data = policyJson.data;
  const formData = new FormData();
  formData.append('OSSAccessKeyId', data.oss_access_key_id || data['OSSAccessKeyId']);
  formData.append('Signature', data.signature || data['Signature']);
  formData.append('policy', data.policy);
  const key = `${data.upload_dir}/${fileName}`;
  formData.append('key', key);

  const acl = data.x_oss_object_acl || data['x-oss-object-acl'];
  if (acl) formData.append('x-oss-object-acl', acl);

  const forbidOverwrite = data.x_oss_forbid_overwrite || data['x-oss-forbid-overwrite'];
  if (forbidOverwrite) formData.append('x-oss-forbid-overwrite', String(forbidOverwrite));

  formData.append('success_action_status', '200');
  formData.append('x-oss-content-type', blob.type || 'image/png');
  formData.append('file', blob);

  const uploadRes = await fetch(data.upload_host, {
    method: 'POST',
    body: formData,
  });

  if (!uploadRes.ok) {
    const errorText = await uploadRes.text().catch(() => '');
    throw new Error(`Failed to upload media to DashScope OSS: HTTP ${uploadRes.status} ${errorText}`);
  }

  return `oss://${key}`;
}

export async function submitHappyHorseTask(params: SubmitHappyHorseParams) {
  const { prompt, imageSources, model, options, apiKey, baseUrl } = params;
  const endpoint = `${resolveAliyunBaseUrl(baseUrl)}/services/aigc/video-generation/video-synthesis`;

  const isImageToVideo = imageSources.length > 0;
  const resolutionMap: Record<string, string> = {
    '480p': '720P',
    '720p': '720P',
    '1080p': '1080P',
  };
  const resolution = resolutionMap[options.videoResolution] || '1080P';

  const payload: any = {
    model,
    input: {
      prompt,
    },
    parameters: {
      resolution,
      ratio: options.ratio,
      duration: Math.max(3, Math.min(15, options.duration)),
      watermark: false,
    },
  };

  if (isImageToVideo) {
    const uploadedUrls = await Promise.all(
      imageSources.map((urlOrData) => uploadHappyHorseMedia(urlOrData, model, apiKey, baseUrl))
    );
    payload.input.media = uploadedUrls.map((url) => ({
      type: 'reference_image',
      url,
    }));
  }

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'X-DashScope-Async': 'enable',
      'X-DashScope-OssResourceResolve': 'enable',
    },
    body: JSON.stringify(payload),
  });

  const text = await response.text();
  let data: any = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { message: text || `HTTP ${response.status}` };
  }

  if (!response.ok || data.code) {
    throw new Error(data.message || data.code || `HTTP ${response.status}`);
  }

  return {
    submitId: data.output.task_id,
    genStatus: 'queued',
    raw: data,
  };
}

export async function fetchHappyHorseTask(taskId: string, apiKey: string, baseUrl?: string) {
  const endpoint = `${resolveAliyunBaseUrl(baseUrl)}/tasks/${taskId}`;
  const response = await fetch(endpoint, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
    },
  });

  const text = await response.text();
  let data: any = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { message: text || `HTTP ${response.status}` };
  }

  if (!response.ok || (data.code && data.code !== 'Success')) {
    throw new Error(data.message || data.code || `HTTP ${response.status}`);
  }

  const output = data.output || {};
  const statusMap: Record<string, string> = {
    'PENDING': 'queued',
    'RUNNING': 'generating',
    'SUCCEEDED': 'completed',
    'FAILED': 'failed',
    'CANCELED': 'cancelled',
    'UNKNOWN': 'failed',
  };

  const mappedStatus = statusMap[output.task_status] || 'failed';

  return {
    submitId: taskId,
    genStatus: mappedStatus,
    downloadedFiles: mappedStatus === 'completed' && output.video_url
      ? [{ name: 'video.mp4', url: output.video_url }]
      : [],
    raw: data,
    error: mappedStatus === 'failed' ? { message: output.message || data.message || '任务失败' } : undefined,
  };
}
