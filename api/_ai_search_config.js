import { hasStorage, put, readJson } from './_blob.js';

const CONFIG_PATH = 'config/doubao-search.json';
const API_KEY_PATTERN = /^[A-Za-z0-9_-]{20,200}$/;
const KEY_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;

export const AI_SEARCH_CACHE_POLICY = Object.freeze({
  stockMinutes: 30,
  industryMinutes: 240,
  industryFailureCooldownMinutes: 15,
  scheduledCacheOnly: true,
});

function maskKey(value) {
  const key = String(value || '');
  if (!key) return '';
  if (key.length <= 10) return '****';
  return `${key.slice(0, 3)}${'*'.repeat(Math.min(12, key.length - 7))}${key.slice(-4)}`;
}

export function envAiSearchConfig(env = process.env) {
  return {
    enabled: env.DOUBAO_SEARCH_ENABLED !== 'false',
    apiKey: String(env.DOUBAO_SEARCH_API_KEY || ''),
    keyName: String(env.DOUBAO_SEARCH_KEY_NAME || 'stock'),
    source: 'env',
    updatedAt: 0,
  };
}

export function mergeAiSearchConfig(base, stored) {
  if (!stored || typeof stored !== 'object') return { ...base };
  return {
    enabled: typeof stored.enabled === 'boolean'
      ? stored.enabled
      : base.enabled,
    apiKey: String(stored.apiKey || base.apiKey || ''),
    keyName: String(stored.keyName || base.keyName || 'stock'),
    source: stored.__stored ? 'oss' : (stored.source || base.source || 'env'),
    updatedAt: Number(stored.updatedAt) || Number(base.updatedAt) || 0,
  };
}

export function updateAiSearchConfig(current, patch = {}, now = Date.now()) {
  const nextKey = String(patch.apiKey || '').trim();
  if (nextKey && !API_KEY_PATTERN.test(nextKey)) {
    throw new Error('API Key 格式无效');
  }
  const nextKeyName = String(
    patch.keyName || current.keyName || 'stock',
  ).trim();
  if (!KEY_NAME_PATTERN.test(nextKeyName)) {
    throw new Error('API Key 名称格式无效');
  }
  const next = {
    enabled: typeof patch.enabled === 'boolean'
      ? patch.enabled
      : current.enabled !== false,
    apiKey: nextKey || String(current.apiKey || ''),
    keyName: nextKeyName,
    source: 'oss',
    updatedAt: Number(now),
  };
  if (next.enabled && !next.apiKey) {
    throw new Error('请先配置 API Key');
  }
  return next;
}

export function publicAiSearchConfig(config) {
  const key = String(config?.apiKey || '');
  return {
    enabled: config?.enabled === true,
    hasKey: !!key,
    apiKeyMask: maskKey(key),
    source: config?.source || 'env',
    provider: 'doubao-global',
    keyName: String(config?.keyName || 'stock').slice(0, 64),
    limits: {
      qps: 5,
      freeCallsPerMonth: 500,
    },
    updatedAt: Number(config?.updatedAt) || 0,
    cachePolicy: AI_SEARCH_CACHE_POLICY,
  };
}

let cached = null;
let loadedAt = 0;

export async function ensureAiSearchConfig({
  maxAgeMs = 0,
  env = process.env,
  storage = { hasStorage, readJson },
} = {}) {
  const now = Date.now();
  if (cached && now - loadedAt < Math.max(0, Number(maxAgeMs) || 0)) {
    return cached;
  }
  const base = envAiSearchConfig(env);
  if (!storage.hasStorage()) {
    cached = base;
    loadedAt = now;
    return cached;
  }
  try {
    const stored = await storage.readJson(CONFIG_PATH);
    if (stored && typeof stored === 'object') stored.__stored = true;
    cached = mergeAiSearchConfig(base, stored);
  } catch {
    cached = cached || base;
  }
  loadedAt = now;
  return cached;
}

export function currentAiSearchConfig(env = process.env) {
  return cached || envAiSearchConfig(env);
}

export async function saveAiSearchConfig(patch = {}, {
  now = Date.now(),
  storage = { hasStorage, put, readJson },
} = {}) {
  if (!storage.hasStorage()) throw new Error('存储未配置(OSS)，无法保存AI检索配置');
  const current = await ensureAiSearchConfig({
    maxAgeMs: 0,
    storage: {
      hasStorage: storage.hasStorage,
      readJson: storage.readJson || readJson,
    },
  });
  const next = updateAiSearchConfig(current, patch, now);
  await storage.put(CONFIG_PATH, JSON.stringify({
    enabled: next.enabled,
    apiKey: next.apiKey,
    keyName: next.keyName,
    updatedAt: next.updatedAt,
  }), {
    contentType: 'application/json',
    addRandomSuffix: false,
    cacheControlMaxAge: 0,
  });
  cached = next;
  loadedAt = Date.now();
  return cached;
}
