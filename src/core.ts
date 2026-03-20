import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { existsSync } from 'node:fs';
import type { AppConfig, ProviderName } from './config.ts';

type PromptOptions = {
  images?: string[];
  at?: string;
};

type RunResult = {
  provider: ProviderName;
  prompt: string;
  savedTo?: string;
  request?: {
    method: string;
    url: string;
    body: Record<string, unknown>;
  };
  raw?: unknown;
};

type RequestSpec = {
  method: 'GET' | 'POST';
  url: string;
  body?: Record<string, unknown>;
};

type AssetPayload =
  | { kind: 'url'; value: string }
  | { kind: 'base64'; value: string; mime?: string };

const successStates = new Set(['success', 'succeeded', 'completed', 'done', 'finished']);
const failureStates = new Set(['failed', 'error', 'cancelled', 'canceled', 'rejected']);

export async function fetchSeedanceTask(
  config: AppConfig,
  taskId: string
): Promise<RunResult> {
  ensureRuntimeConfig(config);

  for (let attempt = 1; attempt <= config.pollMaxAttempts; attempt += 1) {
    const statusUrl = withBaseUrl(
      config.apiBaseUrl,
      config.seedance.statusPath.replace('{id}', taskId)
    );
    const status = await requestJson(config, { method: 'GET', url: statusUrl });
    const state = pickStatus(status);

    if (state && failureStates.has(state)) {
      throw new Error(`Seedance 任务失败，状态: ${state}，任务 ID: ${taskId}`);
    }

    const asset = pickAsset(status);
    if (asset) {
      const savedTo = await saveAsset(config, 'seedance', asset, 'bin', config.seedance.assetsDir);
      return { provider: 'seedance', prompt: taskId, savedTo, raw: status };
    }

    if (state && successStates.has(state)) {
      throw new Error(
        `Seedance 任务成功了，但响应里没有找到视频地址，任务 ID: ${taskId}，请调整 \`src/core.ts\` 里的 pickAsset。`
      );
    }

    console.error(`[${attempt}/${config.pollMaxAttempts}] 任务状态: ${state ?? '未知'}，等待中…`);
    await sleep(config.pollIntervalMs);
  }

  throw new Error(`Seedance 轮询超时（任务 ID: ${taskId}），请增大 \`.env\` 里的 \`SEED_POLL_MAX_ATTEMPTS\` 或 \`SEED_POLL_INTERVAL_MS\`。`);
}

export async function runPrompt(
  config: AppConfig,
  provider: ProviderName,
  prompt: string,
  dryRun = false,
  options: PromptOptions = {}
): Promise<RunResult> {
  if (!prompt.trim()) {
    throw new Error('prompt 不能为空。');
  }

  const systemPrompt = await loadSystemPrompt(config.rootDir);
  const finalPrompt = systemPrompt ? `${systemPrompt}\n\n${prompt.trim()}` : prompt.trim();

  const action = provider === 'seedream' ? runSeedream : provider === 'seed3d' ? runSeed3d : runSeedance;
  return action(config, finalPrompt, dryRun, options);
}

async function runSeedream(
  config: AppConfig,
  prompt: string,
  dryRun: boolean,
  options: PromptOptions
): Promise<RunResult> {
  const atContent = options.at ? await readAtFile(config.rootDir, options.at) : '';
  const finalPrompt = atContent ? `${prompt}\n\n${atContent}` : prompt;

  const inputImages = options.images && options.images.length > 0
    ? options.images
    : (config.seedream.image ? [config.seedream.image] : []);

  const resolvedImages = await Promise.all(
    inputImages.map((img) => readImageInput(config.rootDir, img))
  );

  const imageField = resolvedImages.length === 1
    ? resolvedImages[0]
    : resolvedImages.length > 1
      ? resolvedImages
      : undefined;

  const request = {
    method: 'POST' as const,
    url: withBaseUrl(config.apiBaseUrl, config.seedream.path),
    body: {
      model: config.seedream.model,
      prompt: finalPrompt,
      size: config.seedream.size,
      output_format: config.seedream.outputFormat,
      ...(imageField !== undefined ? { image: imageField } : {}),
      ...(resolvedImages.length > 1 ? {
        sequential_image_generation: config.seedream.sequentialImageGeneration,
        sequential_image_generation_options: { max_images: config.seedream.maxImages }
      } : {}),
      watermark: config.seedream.watermark
    }
  };

  if (dryRun) {
    return { provider: 'seedream', prompt: finalPrompt, request };
  }

  const data = await requestJson(config, request);
  const asset = pickAsset(data);
  if (!asset) {
    throw new Error('Seedream 响应里没有找到可保存的图片结果，请按你的真实 API 调整 `src/core.ts` 里的 pickAsset。');
  }

  const savedTo = await saveAsset(config, 'seedream', asset, 'bin', config.seedream.assetsDir);
  return { provider: 'seedream', prompt: finalPrompt, savedTo, raw: data };
}

async function runSeedance(
  config: AppConfig,
  prompt: string,
  dryRun: boolean,
  options: PromptOptions
): Promise<RunResult> {
  const atContent = options.at ? await readAtFile(config.rootDir, options.at) : '';
  const finalPrompt = atContent ? `${prompt}\n\n${atContent}` : prompt;
  const inputImages = options.images && options.images.length > 0 ? options.images : (config.seedance.imageUrl ? [config.seedance.imageUrl] : []);
  const content: Array<Record<string, unknown>> = [
    {
      type: 'text',
      text: finalPrompt
    }
  ];

  // Seedance API: the first image gets role "first_frame", the second gets "last_frame".
  // Images without an explicit role count against a limit of one — assign roles to avoid the error.
  const roleMap: Array<string | undefined> = ['first_frame', 'last_frame'];
  const imagesToUse = inputImages.slice(0, 2);
  for (let i = 0; i < imagesToUse.length; i += 1) {
    const imageUrl = await readImageInput(config.rootDir, imagesToUse[i]);
    content.push({
      type: 'image_url',
      role: roleMap[i],
      image_url: {
        url: imageUrl
      }
    });
  }

  const createRequest = {
    method: 'POST' as const,
    url: withBaseUrl(config.apiBaseUrl, config.seedance.createPath),
    body: {
      model: config.seedance.model,
      content,
      generate_audio: config.seedance.generateAudio,
      ratio: config.seedance.ratio,
      duration: config.seedance.duration,
      watermark: config.seedance.watermark
    }
  };

  if (dryRun) {
    return { provider: 'seedance', prompt: finalPrompt, request: createRequest };
  }

  const created = await requestJson(config, createRequest);
  const directAsset = pickAsset(created);
  if (directAsset) {
    const savedTo = await saveAsset(config, 'seedance', directAsset, 'bin', config.seedance.assetsDir);
    return { provider: 'seedance', prompt: finalPrompt, savedTo, raw: created };
  }

  const taskId = pickTaskId(created);
  if (!taskId) {
    throw new Error('Seedance 创建响应里没有找到任务 ID，请按你的真实 API 调整 `src/core.ts` 里的 pickTaskId。');
  }

  for (let attempt = 1; attempt <= config.pollMaxAttempts; attempt += 1) {
    await sleep(config.pollIntervalMs);
    const statusUrl = withBaseUrl(
      config.apiBaseUrl,
      config.seedance.statusPath.replace('{id}', taskId)
    );
    const status = await requestJson(config, { method: 'GET', url: statusUrl });
    const state = pickStatus(status);

    if (state && failureStates.has(state)) {
      throw new Error(`Seedance 任务失败，状态: ${state}，任务 ID: ${taskId}`);
    }

    const asset = pickAsset(status);
    if (asset || (state && successStates.has(state))) {
      if (!asset) {
        throw new Error(`Seedance 任务成功了，但响应里没有找到视频地址，任务 ID: ${taskId}，请调整 \`src/core.ts\` 里的 pickAsset。`);
      }

      const savedTo = await saveAsset(config, 'seedance', asset, 'bin', config.seedance.assetsDir);
      return { provider: 'seedance', prompt: finalPrompt, savedTo, raw: status };
    }
  }

  throw new Error(`Seedance 轮询超时（任务 ID: ${taskId}），请增大 \`.env\` 里的 \`SEED_POLL_MAX_ATTEMPTS\` 或 \`SEED_POLL_INTERVAL_MS\`。`);
}

async function runSeed3d(
  config: AppConfig,
  prompt: string,
  dryRun: boolean,
  options: PromptOptions
): Promise<RunResult> {
  if (!options.images || options.images.length === 0) {
    throw new Error('seed3d 需要 --image 参数指定本地图片路径。');
  }

  const atContent = options.at ? await readAtFile(config.rootDir, options.at) : '';
  const imageUrl = await readImageInput(config.rootDir, options.images[0]);

  const textParts = [`--subdivisionlevel ${config.seed3d.subdivisionLevel} --fileformat ${config.seed3d.fileFormat}`];
  if (prompt) textParts.push(prompt);
  if (atContent) textParts.push(atContent);
  const textContent = textParts.join(' ');

  const content: Array<Record<string, unknown>> = [
    { type: 'text', text: textContent },
    { type: 'image_url', image_url: { url: imageUrl } }
  ];

  const createRequest = {
    method: 'POST' as const,
    url: withBaseUrl(config.apiBaseUrl, config.seed3d.createPath),
    body: {
      model: config.seed3d.model,
      content
    }
  };

  if (dryRun) {
    return { provider: 'seed3d', prompt: textContent, request: createRequest };
  }

  const created = await requestJson(config, createRequest);
  const taskId = pickTaskId(created);
  if (!taskId) {
    throw new Error('Seed3D 创建响应里没有找到任务 ID，请按你的真实 API 调整 `src/core.ts` 里的 pickTaskId。');
  }

  for (let attempt = 1; attempt <= config.pollMaxAttempts; attempt += 1) {
    await sleep(config.pollIntervalMs);
    const statusUrl = withBaseUrl(
      config.apiBaseUrl,
      config.seed3d.statusPath.replace('{id}', taskId)
    );
    const status = await requestJson(config, { method: 'GET', url: statusUrl });
    const state = pickStatus(status);

    if (state && failureStates.has(state)) {
      throw new Error(`Seed3D 任务失败，状态: ${state}`);
    }

    const asset = pickAsset(status);
    if (asset || (state && successStates.has(state))) {
      if (!asset) {
        throw new Error('Seed3D 任务成功了，但响应里没有找到文件地址，请调整 `src/core.ts` 里的 pickAsset。');
      }
      const savedTo = await saveAsset(config, 'seed3d', asset, config.seed3d.fileFormat, config.seed3d.assetsDir);
      return { provider: 'seed3d', prompt: textContent, savedTo, raw: status };
    }
  }

  throw new Error('Seed3D 轮询超时，请增大 `.env` 里的 `SEED_POLL_MAX_ATTEMPTS` 或 `SEED_POLL_INTERVAL_MS`。');
}

async function requestJson(config: AppConfig, spec: RequestSpec): Promise<unknown> {
  ensureRuntimeConfig(config);

  const response = await fetch(spec.url, {
    method: spec.method,
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
      ...config.extraHeaders
    },
    body: spec.body ? JSON.stringify(spec.body) : undefined,
    signal: AbortSignal.timeout(config.timeoutMs)
  });

  if (!response.ok) {
    throw new Error(`请求失败: ${response.status} ${response.statusText}\n${await response.text()}`);
  }

  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    return response.json();
  }

  return { content: await response.text() };
}

async function saveAsset(
  config: AppConfig,
  provider: ProviderName,
  asset: AssetPayload,
  fallbackExt: string,
  targetDir = config.assetsDir
): Promise<string> {
  await mkdir(targetDir, { recursive: true });

  if (asset.kind === 'base64') {
    const output = join(targetDir, `${formatTimestamp()}-${provider}.${resolveExtension(asset, fallbackExt)}`);
    await writeFile(output, Buffer.from(asset.value, 'base64'));
    return output;
  }

  const response = await fetch(asset.value, { signal: AbortSignal.timeout(config.timeoutMs) });
  if (!response.ok) {
    throw new Error(`下载资源失败: ${response.status} ${response.statusText}`);
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  const output = join(
    targetDir,
    `${formatTimestamp()}-${provider}.${resolveUrlAssetExtension(
      asset.value,
      response.headers.get('content-type'),
      fallbackExt
    )}`
  );
  await writeFile(output, bytes);
  return output;
}

function ensureRuntimeConfig(config: AppConfig): void {
  if (!config.apiBaseUrl) {
    throw new Error('缺少 `.env` 配置: SEED_API_BASE_URL');
  }

  if (!config.apiKey) {
    throw new Error('缺少 `.env` 配置: SEED_API_KEY');
  }
}

function withBaseUrl(baseUrl: string, path: string): string {
  if (/^https?:\/\//.test(path)) return path;
  return `${baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
}

function pickAsset(payload: unknown): AssetPayload | null {
  const url = firstString(payload, [
    ['content', 'video_url'],
    ['content', 'file_url'],
    ['data', 0, 'url'],
    ['data', 'url'],
    ['output', 0, 'url'],
    ['output', 'url'],
    ['result', 'url'],
    ['result', 'video_url'],
    ['result', 'image_url'],
    ['url'],
    ['video_url'],
    ['image_url']
  ]);

  if (url) return { kind: 'url', value: url };

  const base64 = firstString(payload, [
    ['data', 0, 'b64_json'],
    ['data', 'b64_json'],
    ['result', 'base64'],
    ['base64']
  ]);

  if (!base64) return null;

  const mime = firstString(payload, [
    ['data', 0, 'mime_type'],
    ['result', 'mime_type'],
    ['mime_type']
  ]) ?? undefined;

  return { kind: 'base64', value: base64, mime };
}

function pickTaskId(payload: unknown): string | null {
  return (
    firstString(payload, [
      ['id'],
      ['task_id'],
      ['taskId'],
      ['data', 'id'],
      ['data', 'task_id'],
      ['result', 'id'],
      ['result', 'task_id']
    ]) ?? null
  );
}

function pickStatus(payload: unknown): string | null {
  const value =
    firstString(payload, [
      ['status'],
      ['state'],
      ['data', 'status'],
      ['data', 'state'],
      ['result', 'status'],
      ['result', 'state']
    ]) ?? null;

  return value?.toLowerCase() ?? null;
}

function firstString(payload: unknown, paths: Array<Array<string | number>>): string | null {
  for (const path of paths) {
    const value = get(payload, path);
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function get(payload: unknown, path: Array<string | number>): unknown {
  let current = payload;
  for (const key of path) {
    if (current === null || current === undefined) return undefined;
    if (typeof key === 'number') {
      if (!Array.isArray(current)) return undefined;
      current = current[key];
      continue;
    }

    if (typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function resolveExtension(asset: AssetPayload, fallback: string): string {
  if (asset.kind === 'url') return fallback;

  if (!asset.mime) return fallback;
  const extension = normalizeExtensionFromMime(asset.mime);
  return extension || fallback;
}

function resolveUrlAssetExtension(url: string, contentType: string | null, fallback: string): string {
  const clean = url.split('?')[0];
  const fromUrl = extname(clean).replace('.', '').toLowerCase();
  if (fromUrl) return fromUrl;

  const fromContentType = normalizeExtensionFromMime(contentType);
  return fromContentType || fallback;
}

function normalizeExtensionFromMime(value: string | null | undefined): string {
  if (!value) return '';

  const mime = value.split(';', 1)[0]?.trim().toLowerCase();
  if (!mime) return '';
  if (mime === 'image/jpeg') return 'jpg';
  if (mime === 'image/svg+xml') return 'svg';
  if (mime === 'video/quicktime') return 'mov';

  return mime.split('/')[1]?.toLowerCase() || '';
}

function formatTimestamp(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

async function readAtFile(rootDir: string, inputPath: string): Promise<string> {
  const filePath = resolve(rootDir, inputPath);
  const normalizedRoot = rootDir.endsWith(sep) ? rootDir : `${rootDir}${sep}`;
  if (filePath !== rootDir && !filePath.startsWith(normalizedRoot)) {
    throw new Error('`--at` 只能读取当前 workspace 内的文件。');
  }
  return readFile(filePath, 'utf8');
}

async function readImageInput(rootDir: string, inputPath: string): Promise<string> {
  if (/^(https?:)?\/\//.test(inputPath) || inputPath.startsWith('data:')) {
    return inputPath;
  }

  const filePath = resolve(rootDir, inputPath);
  const normalizedRoot = rootDir.endsWith(sep) ? rootDir : `${rootDir}${sep}`;
  if (filePath !== rootDir && !filePath.startsWith(normalizedRoot)) {
    throw new Error('`--image` 只能读取当前 workspace 内的文件。');
  }

  const bytes = await readFile(filePath);
  return `data:${mimeFromPath(filePath)};base64,${bytes.toString('base64')}`;
}

function mimeFromPath(filePath: string): string {
  const extension = extname(filePath).toLowerCase();
  if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg';
  if (extension === '.png') return 'image/png';
  if (extension === '.webp') return 'image/webp';
  if (extension === '.gif') return 'image/gif';
  if (extension === '.bmp') return 'image/bmp';
  if (extension === '.svg') return 'image/svg+xml';
  return 'application/octet-stream';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function loadSystemPrompt(rootDir: string): Promise<string> {
  const filePath = join(rootDir, 'system-prompt.md');
  if (!existsSync(filePath)) return '';

  const raw = await readFile(filePath, 'utf8');
  // Strip markdown headings, HTML comments, and collapse blank lines
  const content = raw
    .split(/\r?\n/)
    .filter((line) => {
      const t = line.trim();
      if (!t) return false;
      if (t.startsWith('#')) return false;          // markdown headings (template labels)
      if (t.startsWith('<!--') || t.endsWith('-->') || /<!--.*-->/.test(t)) return false;
      return true;
    })
    .join('\n')
    .trim();

  return content;
}
