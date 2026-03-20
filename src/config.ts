import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export type ProviderName = 'seedream' | 'seedance' | 'seed3d';

export type AppConfig = {
  rootDir: string;
  assetsDir: string;
  apiBaseUrl: string;
  apiKey: string;
  timeoutMs: number;
  pollIntervalMs: number;
  pollMaxAttempts: number;
  extraHeaders: Record<string, string>;
  defaultProvider: ProviderName;
  seedream: {
    model: string;
    path: string;
    size: string;
    image: string;
    outputFormat: string;
    watermark: boolean;
    assetsDir: string;
    sequentialImageGeneration: string;
    maxImages: number;
  };
  seedance: {
    model: string;
    createPath: string;
    statusPath: string;
    duration: number;
    imageUrl: string;
    generateAudio: boolean;
    ratio: string;
    watermark: boolean;
    assetsDir: string;
  };
  seed3d: {
    model: string;
    createPath: string;
    statusPath: string;
    subdivisionLevel: string;
    fileFormat: string;
    assetsDir: string;
  };
};

const providerNames = new Set<ProviderName>(['seedream', 'seedance', 'seed3d']);

export function loadConfig(rootDir = process.cwd()): AppConfig {
  const fileEnv = readEnvFile(resolve(rootDir, '.env'));
  const env = { ...fileEnv, ...process.env };
  const defaultProvider = normalizeProvider(env.SEED_PROVIDER) ?? 'seedream';

  const defaultAssetsDir = env.SEED_ASSETS_DIR || 'assets';

  return {
    rootDir,
    assetsDir: resolve(rootDir, defaultAssetsDir),
    apiBaseUrl: trimSlash(env.SEED_API_BASE_URL || ''),
    apiKey: env.SEED_API_KEY || '',
    timeoutMs: toNumber(env.SEED_TIMEOUT_MS, 120000),
    pollIntervalMs: toNumber(env.SEED_POLL_INTERVAL_MS, 5000),
    pollMaxAttempts: toNumber(env.SEED_POLL_MAX_ATTEMPTS, 60),
    extraHeaders: parseJsonObject(env.SEED_EXTRA_HEADERS),
    defaultProvider,
    seedream: {
      model: env.SEEDREAM_MODEL || 'doubao-seedream-5-0-260128',
      path: env.SEEDREAM_PATH || '/images/generations',
      size: env.SEEDREAM_SIZE || '2K',
      image: env.SEEDREAM_IMAGE || '',
      outputFormat: env.SEEDREAM_OUTPUT_FORMAT || 'png',
      watermark: toBoolean(env.SEEDREAM_WATERMARK, false),
      assetsDir: resolve(rootDir, env.SEEDREAM_ASSETS_DIR || defaultAssetsDir),
      sequentialImageGeneration: env.SEEDREAM_SEQUENTIAL_IMAGE_GENERATION || 'auto',
      maxImages: toNumber(env.SEEDREAM_MAX_IMAGES, 1)
    },
    seedance: {
      model: env.SEEDANCE_MODEL || 'doubao-seedance-1-5-pro-251215',
      createPath: env.SEEDANCE_CREATE_PATH || '/contents/generations/tasks',
      statusPath: env.SEEDANCE_STATUS_PATH || '/contents/generations/tasks/{id}',
      duration: toNumber(env.SEEDANCE_DURATION, 5),
      imageUrl: env.SEEDANCE_IMAGE_URL || '',
      generateAudio: toBoolean(env.SEEDANCE_GENERATE_AUDIO, true),
      ratio: env.SEEDANCE_RATIO || 'adaptive',
      watermark: toBoolean(env.SEEDANCE_WATERMARK, false),
      assetsDir: resolve(rootDir, env.SEEDANCE_ASSETS_DIR || defaultAssetsDir)
    },
    seed3d: {
      model: env.SEED3D_MODEL || 'doubao-seed3d-1-0-250928',
      createPath: env.SEED3D_CREATE_PATH || '/contents/generations/tasks',
      statusPath: env.SEED3D_STATUS_PATH || '/contents/generations/tasks/{id}',
      subdivisionLevel: env.SEED3D_SUBDIVISION_LEVEL || 'medium',
      fileFormat: env.SEED3D_FILE_FORMAT || 'glb',
      assetsDir: resolve(rootDir, env.SEED3D_ASSETS_DIR || defaultAssetsDir)
    }
  };
}

export function normalizeProvider(value?: string): ProviderName | null {
  if (!value) return null;
  return providerNames.has(value as ProviderName) ? (value as ProviderName) : null;
}

function readEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};

  return readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .reduce<Record<string, string>>((acc, line) => {
      const text = line.trim();
      if (!text || text.startsWith('#')) return acc;

      const index = text.indexOf('=');
      if (index === -1) return acc;

      const key = text.slice(0, index).trim();
      const rawValue = text.slice(index + 1).trim();
      acc[key] = stripQuotes(rawValue);
      return acc;
    }, {});
}

function stripQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  return value;
}

function toNumber(value: string | undefined, fallback: number): number {
  const result = Number(value);
  return Number.isFinite(result) ? result : fallback;
}

function toBoolean(value: string | undefined, fallback: boolean): boolean {
  if (!value) return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return fallback;
}

function parseJsonObject(value: string | undefined): Record<string, string> {
  if (!value) return {};

  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};

    return Object.fromEntries(
      Object.entries(parsed).map(([key, item]) => [key, String(item)])
    );
  } catch {
    return {};
  }
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/, '');
}
