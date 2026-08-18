import { createHash } from 'node:crypto';
import { put, readJson } from './_blob.js';
import { ensureAiSearchConfig } from './_ai_search_config.js';

const ENDPOINT = 'https://plugin.anspire.cn/api/ntsearch/search';
const INDUSTRY_CACHE_MS = 60 * 60 * 1000;
const DEFAULT_TOP_K = 6;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const sharedMemoryCache = new Map();

function cleanText(value, limit = 320) {
  return String(value || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/&(?:nbsp|#160);/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit);
}

function sanitizeEvidenceText(value, limit = 320) {
  return cleanText(value, limit * 2)
    .replace(/(?:忽略|无视|绕过|覆盖|取消)(?:此前|之前|以上|系统|开发者|用户)?[^。！？.!?]{0,80}(?:指令|规则|提示词)[。！？.!?]?/gi, ' ')
    .replace(/(?:泄露|输出|展示|返回|告诉我)[^。！？.!?]{0,80}(?:系统提示词|开发者消息|密钥|API\s*Key|口令)[。！？.!?]?/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit);
}

function safeUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return ['http:', 'https:'].includes(url.protocol) ? url.toString() : '';
  } catch {
    return '';
  }
}

function safeDate(value, now) {
  const raw = String(value || '').trim();
  const match = raw.match(/^(\d{4}-\d{2}-\d{2})/);
  if (!match) return '';
  const timestamp = Date.parse(`${match[1]}T00:00:00Z`);
  if (!Number.isFinite(timestamp)) return '';
  const oldest = Date.parse('2000-01-01T00:00:00Z');
  if (timestamp < oldest || timestamp > now + 86400000) return '';
  return match[1];
}

function sourceOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '').slice(0, 80);
  } catch {
    return '';
  }
}

export function buildAdvisorSearchQuery({
  code = '',
  name = '',
  industry = '',
} = {}) {
  const tokens = [
    cleanText(name, 24),
    /^\d{6}$/.test(String(code || '').trim()) ? String(code).trim() : '',
    cleanText(industry, 20),
    '最新 公告 政策 行业 舆情 风险',
  ].filter(Boolean);
  return Array.from(tokens.join(' ')).slice(0, 64).join('');
}

export function stripClientSearchFields(payload) {
  if (!payload || typeof payload !== 'object') return {}
  delete payload.aiSearchEvidence
  delete payload.aiSearchMeta
  delete payload.searchReference
  return payload
}

export function normalizeAdvisorSearchResults(data, {
  now = Date.now(),
  limit = DEFAULT_TOP_K,
} = {}) {
  const results = Array.isArray(data?.results) ? data.results : [];
  const seen = new Set();
  const items = [];
  for (const raw of results) {
    const title = sanitizeEvidenceText(raw?.title, 160);
    const url = safeUrl(raw?.url);
    if (!title || !url) continue;
    const dedupeKey = `${title.toLowerCase()}|${url}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    const score = Number(raw?.score);
    items.push({
      title,
      summary: sanitizeEvidenceText(raw?.content || raw?.summary, 320),
      url,
      date: safeDate(raw?.date, Number(now)),
      score: Number.isFinite(score) ? Math.max(0, Math.min(1, score)) : null,
      src: `AI Search·${sourceOf(url) || '网页'}`,
      kind: 'ai_search',
      trusted: false,
    });
    if (items.length >= Math.max(1, Math.min(10, Number(limit) || DEFAULT_TOP_K))) break;
  }
  return items.sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
}

function cachePath(scope, value) {
  const digest = createHash('sha256')
    .update(`${scope}:${String(value || '').trim().toLowerCase()}`)
    .digest('hex')
    .slice(0, 32);
  return `cache/ai-search/v1/${scope}-${digest}.json`;
}

function cacheEnvelope(items, now, ttlMs) {
  return {
    schemaVersion: 'ai-search-cache.v1',
    savedAt: now,
    expiresAt: now + ttlMs,
    items,
  };
}

async function loadCache(scope, value, {
  now,
  memoryCache,
  readCache,
}) {
  if (!value) return null;
  const memoryKey = `${scope}:${String(value).trim().toLowerCase()}`;
  const memory = memoryCache.get(memoryKey);
  if (memory?.expiresAt > now && Array.isArray(memory.items)) return memory.items;
  try {
    const stored = await readCache(cachePath(scope, value));
    if (stored?.expiresAt > now && Array.isArray(stored.items)) {
      memoryCache.set(memoryKey, stored);
      return stored.items;
    }
  } catch {
    // 缓存故障不阻断军师。
  }
  return null;
}

async function saveCache(scope, value, items, ttlMs, {
  now,
  memoryCache,
  writeCache,
}) {
  if (!value || !items.length) return;
  const memoryKey = `${scope}:${String(value).trim().toLowerCase()}`;
  const envelope = cacheEnvelope(items, now, ttlMs);
  memoryCache.set(memoryKey, envelope);
  try {
    await writeCache(cachePath(scope, value), envelope);
  } catch {
    // 内存缓存仍可用；OSS 写失败不影响本次建议。
  }
}

function beijingTime(timestamp) {
  const date = new Date(timestamp + 8 * 3600000);
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`
    + ` ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
}

async function runtimeConfig(options = {}) {
  if (options.runtimeConfig && typeof options.runtimeConfig === 'object') {
    return options.runtimeConfig;
  }
  const hasExplicit = Object.prototype.hasOwnProperty.call(options, 'apiKey')
    || Object.prototype.hasOwnProperty.call(options, 'enabled');
  if (hasExplicit) {
    return {
      enabled: options.enabled !== false,
      apiKey: String(options.apiKey || ''),
      updatedAt: 0,
    };
  }
  return ensureAiSearchConfig();
}

async function requestSearch(query, {
  apiKey,
  fetchImpl,
  now,
  timeoutMs,
  topK,
}) {
  const limit = Math.max(1, Math.min(10, Number(topK) || DEFAULT_TOP_K));
  const params = new URLSearchParams({
    query,
    top_k: String(limit),
    FromTime: beijingTime(now - 7 * 86400000),
    ToTime: beijingTime(now),
    search_type: 'web',
    region_mode: '0',
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1000, Number(timeoutMs) || 5500));
  try {
    const response = await fetchImpl(`${ENDPOINT}?${params}`, {
      method: 'GET',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
      },
    });
    if (!response.ok) {
      return {
        items: [],
        status: `http-${response.status}`,
        billed: response.status < 400,
      };
    }
    const contentLength = Number(response.headers?.get?.('content-length'));
    if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
      return { items: [], status: 'response-too-large', billed: true };
    }
    const data = await response.json();
    return {
      items: normalizeAdvisorSearchResults(data, { now, limit }),
      query,
      status: 'network',
      billed: true,
      fetchedAt: new Date(now).toISOString(),
    };
  } catch (error) {
    return {
      items: [],
      status: error?.name === 'AbortError' ? 'timeout' : 'error',
      billed: false,
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchAiSearchReference({
  query = '',
  cacheScope = 'general',
  cacheKey = '',
  cacheMinutes = 30,
} = {}, options = {}) {
  const config = await runtimeConfig(options);
  if (config.enabled !== true || !String(config.apiKey || '').trim()) {
    return {
      items: [],
      status: 'disabled',
      billed: false,
      enabled: false,
      configUpdatedAt: Number(config.updatedAt) || 0,
    };
  }
  const normalizedQuery = Array.from(cleanText(query, 128)).slice(0, 64).join('');
  if (!normalizedQuery) {
    return { items: [], status: 'empty-query', billed: false, enabled: true };
  }
  const scope = /^[a-z][a-z0-9-]{0,31}$/i.test(String(cacheScope))
    ? String(cacheScope).toLowerCase()
    : 'general';
  const key = cleanText(cacheKey || normalizedQuery, 160);
  const now = Number((options.now || Date.now)());
  const memoryCache = options.memoryCache || sharedMemoryCache;
  const readCache = options.readCache || ((path) => readJson(path));
  const writeCache = options.writeCache || ((path, value) => put(path, JSON.stringify(value), {
    contentType: 'application/json',
    addRandomSuffix: false,
    cacheControlMaxAge: 0,
  }));
  const cacheOptions = { now, memoryCache, readCache, writeCache };
  const cachedItems = await loadCache(scope, key, cacheOptions);
  if (cachedItems?.length) {
    return {
      items: cachedItems,
      status: `${scope}-cache`,
      billed: false,
      enabled: true,
      configUpdatedAt: Number(config.updatedAt) || 0,
    };
  }
  if (options.cacheOnly === true) {
    return {
      items: [],
      status: 'cache-only-miss',
      billed: false,
      enabled: true,
      configUpdatedAt: Number(config.updatedAt) || 0,
    };
  }
  const result = await requestSearch(normalizedQuery, {
    apiKey: config.apiKey,
    fetchImpl: options.fetchImpl || fetch,
    now,
    timeoutMs: options.timeoutMs || 5500,
    topK: options.topK || DEFAULT_TOP_K,
  });
  await saveCache(
    scope,
    key,
    result.items,
    Math.max(1, Math.min(1440, Number(cacheMinutes) || 30)) * 60000,
    cacheOptions,
  );
  return {
    ...result,
    enabled: true,
    configUpdatedAt: Number(config.updatedAt) || 0,
  };
}

export function buildSearchReference(result) {
  if (!result?.enabled || !Array.isArray(result.items) || !result.items.length) {
    return null;
  }
  return {
    dimension: 'search',
    label: '检索参考',
    status: result.status || '',
    fetchedAt: result.fetchedAt || null,
    sources: result.items.slice(0, 8).map((item) => ({
      title: item.title,
      summary: item.summary,
      url: item.url,
      date: item.date,
      src: item.src,
      kind: 'ai_search',
    })),
  };
}

function industryOnlyItems(items, industry, name, code) {
  const industryText = cleanText(industry, 30).toLowerCase();
  if (!industryText) return [];
  const stockName = cleanText(name, 30).toLowerCase();
  const stockCode = String(code || '').trim();
  return items.filter((item) => {
    const text = `${item.title} ${item.summary}`.toLowerCase();
    return text.includes(industryText)
      && (!stockName || !text.includes(stockName))
      && (!stockCode || !text.includes(stockCode));
  });
}

export async function fetchAdvisorSearch({
  code = '',
  name = '',
  industry = '',
  reviewOrigin = '',
} = {}, options = {}) {
  const config = await runtimeConfig(options);
  if (config.enabled !== true || !String(config.apiKey || '').trim()) {
    return {
      items: [],
      status: 'disabled',
      billed: false,
      enabled: false,
      configUpdatedAt: Number(config.updatedAt) || 0,
    };
  }
  const clock = options.now || Date.now;
  const memoryCache = options.memoryCache || sharedMemoryCache;
  const readCache = options.readCache || ((key) => readJson(key));
  const writeCache = options.writeCache || ((key, value) => put(key, JSON.stringify(value), {
    contentType: 'application/json',
    addRandomSuffix: false,
    cacheControlMaxAge: 0,
  }));
  const now = Number(clock());
  const stockKey = /^\d{6}$/.test(String(code).trim())
    ? String(code).trim()
    : cleanText(name, 40);
  const cacheOptions = { now, memoryCache, readCache, writeCache };
  const stockCached = await loadCache('stock', stockKey, cacheOptions);
  if (stockCached?.length) {
    return { items: stockCached, status: 'stock-cache', billed: false };
  }
  const scheduled = ['auto', 'judge'].includes(String(reviewOrigin || ''));
  if (scheduled && industry) {
    const industryCached = await loadCache('industry', industry, cacheOptions);
    if (industryCached?.length) {
      return { items: industryCached, status: 'industry-cache', billed: false };
    }
  }
  if (scheduled) {
    return { items: [], status: 'scheduled-cache-miss', billed: false };
  }

  const result = await fetchAiSearchReference({
    query: buildAdvisorSearchQuery({ code, name, industry }),
    cacheScope: 'stock',
    cacheKey: stockKey,
    cacheMinutes: 30,
  }, {
    ...options,
    runtimeConfig: config,
    memoryCache,
    readCache,
    writeCache,
  });
  const industryItems = industryOnlyItems(result.items, industry, name, code);
  await saveCache('industry', industry, industryItems, INDUSTRY_CACHE_MS, cacheOptions);
  return result;
}
