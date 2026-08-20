import { createHash } from 'node:crypto';
import { put, readJson } from './_blob.js';
import { ensureAiSearchConfig } from './_ai_search_config.js';

const ENDPOINT = 'https://open.feedcoopapi.com/search_api/global_search';
const INDUSTRY_CACHE_MS = 4 * 60 * 60 * 1000;
const INDUSTRY_FAILURE_COOLDOWN_MS = 15 * 60 * 1000;
const DEFAULT_TOP_K = 6;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const PROVIDER_QPS = 5;
const PROVIDER_RATE_WINDOW_MS = 1000;
const PROVIDER_RETRY_DELAY_MS = 250;
const sharedMemoryCache = new Map();
const sharedInflightSearch = new Map();
const sharedIndustryFailureCooldown = new Map();
const sharedRateLimitState = {
  tail: Promise.resolve(),
  starts: [],
};

function delay(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function waitForProviderSlot({
  state = sharedRateLimitState,
  now = Date.now,
  wait = delay,
} = {}) {
  const previous = state.tail || Promise.resolve();
  let release;
  state.tail = new Promise((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    const clockValue = Number(now());
    let effectiveNow = Number.isFinite(clockValue)
      ? clockValue
      : Date.now();
    const starts = (Array.isArray(state.starts) ? state.starts : [])
      .map(Number)
      .filter(Number.isFinite)
      .filter((startedAt) => startedAt > effectiveNow - PROVIDER_RATE_WINDOW_MS)
      .sort((a, b) => a - b);
    if (starts.length >= PROVIDER_QPS) {
      const waitMs = Math.max(
        0,
        starts[0] + PROVIDER_RATE_WINDOW_MS - effectiveNow,
      );
      if (waitMs > 0) {
        await wait(waitMs);
        const afterWait = Number(now());
        effectiveNow = Number.isFinite(afterWait)
          ? Math.max(afterWait, effectiveNow + waitMs)
          : effectiveNow + waitMs;
      }
    }
    state.starts = starts
      .filter((startedAt) => startedAt > effectiveNow - PROVIDER_RATE_WINDOW_MS);
    state.starts.push(effectiveNow);
  } finally {
    release();
  }
}

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
  const [year, month, day] = match[1].split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day
  ) return '';
  const timestamp = date.getTime();
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
    '最新 新闻 公告 公司动态 重大事项 舆情 风险',
    cleanText(industry, 20),
  ].filter(Boolean);
  return Array.from(tokens.join(' ')).slice(0, 64).join('');
}

export function buildIndustrySearchQuery(industry = '') {
  const value = cleanText(industry, 28);
  if (!value) return '';
  return Array.from(
    `${value} 行业 最新 政策 景气 供需 价格 风险`,
  ).slice(0, 64).join('');
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
  const results = Array.isArray(data?.Result?.Documents)
    ? data.Result.Documents
    : [];
  const seen = new Set();
  const items = [];
  for (const raw of results) {
    const title = sanitizeEvidenceText(raw?.Title, 160);
    const url = safeUrl(raw?.Url);
    if (!title || !url) continue;
    const dedupeKey = `${title.toLowerCase()}|${url}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    const summary = (Array.isArray(raw?.Snippet) ? raw.Snippet : [])
      .filter((snippet) => snippet?.Type === 'text')
      .map((snippet) => snippet.Text)
      .filter(Boolean)
      .join(' ');
    const rawHost = cleanText(raw?.HostInfo?.Hostname, 80);
    const sanitizedHost = sanitizeEvidenceText(rawHost, 80);
    const host = (sanitizedHost === rawHost ? sanitizedHost : '')
      || sourceOf(url)
      || '网页';
    const authority = ['very_high', 'high', 'normal'].includes(
      String(raw?.HostInfo?.AuthorityLevel || ''),
    )
      ? String(raw.HostInfo.AuthorityLevel)
      : '';
    items.push({
      title,
      summary: sanitizeEvidenceText(summary, 320),
      url,
      date: safeDate(raw?.DocumentInfo?.PublishTime, Number(now)),
      score: null,
      src: `豆包搜索·${host}`,
      kind: 'doubao_search',
      authority,
      trusted: false,
    });
    if (items.length >= Math.max(1, Math.min(10, Number(limit) || DEFAULT_TOP_K))) break;
  }
  return items;
}

function cachePath(scope, value) {
  const digest = createHash('sha256')
    .update(`${scope}:${String(value || '').trim().toLowerCase()}`)
    .digest('hex')
    .slice(0, 32);
  return `cache/doubao-search/v1/${scope}-${digest}.json`;
}

function cacheEnvelope(items, now, ttlMs) {
  return {
    schemaVersion: 'doubao-search-cache.v1',
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

async function loadFailureCooldown(value, {
  now,
  failureCooldown,
  readCache,
}) {
  const key = String(value || '').trim().toLowerCase();
  if (!key) return false;
  const memoryExpiry = Number(failureCooldown.get(key)) || 0;
  if (memoryExpiry > now) return true;
  try {
    const stored = await readCache(
      cachePath('industry-failure', key),
    );
    if (Number(stored?.expiresAt) > now) {
      failureCooldown.set(key, Number(stored.expiresAt));
      return true;
    }
  } catch {
    // 冷却缓存故障不阻断正常检索。
  }
  return false;
}

async function saveFailureCooldown(value, {
  now,
  failureCooldown,
  writeCache,
}) {
  const key = String(value || '').trim().toLowerCase();
  if (!key) return;
  const envelope = cacheEnvelope(
    [],
    now,
    INDUSTRY_FAILURE_COOLDOWN_MS,
  );
  failureCooldown.set(key, envelope.expiresAt);
  try {
    await writeCache(
      cachePath('industry-failure', key),
      envelope,
    );
  } catch {
    // 内存冷却仍有效；OSS 写失败不影响本次建议。
  }
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
  rateLimitState,
  rateLimitNow,
  rateLimitDelay,
}) {
  await waitForProviderSlot({
    state: rateLimitState,
    now: rateLimitNow,
    wait: rateLimitDelay,
  });
  const limit = Math.max(1, Math.min(10, Number(topK) || DEFAULT_TOP_K));
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    Math.max(1000, Number(timeoutMs) || 8000),
  );
  try {
    const response = await fetchImpl(ENDPOINT, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        Query: query,
        SearchType: 'web',
        DocCount: limit,
        MaxSnippetLength: 500,
        MaxImageCountPerDoc: 0,
        Filter: { IcpHostOnly: true },
      }),
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
    const requestId = cleanText(
      data?.ResponseMetadata?.RequestId,
      100,
    );
    const metadataError = data?.ResponseMetadata?.Error;
    const errorCode = Number(
      data?.Result?.ErrorCode
      ?? metadataError?.CodeN
      ?? metadataError?.Code,
    );
    if (metadataError || (Number.isFinite(errorCode) && errorCode !== 0)) {
      const status = errorCode === 700429
        ? 'provider-rate-limited'
        : errorCode === 700901
          ? 'provider-invalid-key'
          : [10403, 10408, 10409, 10410].includes(errorCode)
            ? 'provider-not-authorized'
            : errorCode === 10412
              ? 'provider-quota-exhausted'
              : [10500, 10501].includes(errorCode)
                ? 'provider-temporary-error'
                : `provider-${Number.isFinite(errorCode) ? errorCode : 'error'}`;
      return {
        items: [],
        status,
        billed: false,
        requestId: requestId || null,
        errorCode: Number.isFinite(errorCode) ? errorCode : null,
      };
    }
    return {
      items: normalizeAdvisorSearchResults(data, { now, limit }),
      query,
      status: 'network',
      billed: true,
      fetchedAt: new Date(now).toISOString(),
      requestId: requestId || null,
      errorCode: 0,
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

async function requestSearchWithRetry(query, options) {
  const first = await requestSearch(query, options);
  if (![10500, 10501].includes(first.errorCode)) return first;
  await (options.retryDelay || delay)(
    Math.max(0, Number(options.retryDelayMs) || PROVIDER_RETRY_DELAY_MS),
  );
  const second = await requestSearch(query, options);
  return {
    ...second,
    retried: true,
  };
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
  const inflightSearch = options.inflightSearch || sharedInflightSearch;
  const flightKey = `${scope}:${key.toLowerCase()}`;
  const existing = inflightSearch.get(flightKey);
  if (existing) {
    const shared = await existing;
    return {
      ...shared,
      status: `${scope}-coalesced`,
      billed: false,
    };
  }
  const request = (async () => {
    const result = await requestSearchWithRetry(normalizedQuery, {
      apiKey: config.apiKey,
      fetchImpl: options.fetchImpl || fetch,
      now,
      timeoutMs: options.timeoutMs || 8000,
      topK: options.topK || DEFAULT_TOP_K,
      retryDelay: options.retryDelay,
      retryDelayMs: options.retryDelayMs,
      rateLimitState: options.rateLimitState,
      rateLimitNow: options.rateLimitNow,
      rateLimitDelay: options.rateLimitDelay,
    });
    await saveCache(
      scope,
      key,
      result.items,
      Math.max(
        1,
        Math.min(1440, Number(cacheMinutes) || 30),
      ) * 60000,
      cacheOptions,
    );
    return {
      ...result,
      enabled: true,
      configUpdatedAt: Number(config.updatedAt) || 0,
    };
  })();
  inflightSearch.set(flightKey, request);
  try {
    return await request;
  } finally {
    if (inflightSearch.get(flightKey) === request) {
      inflightSearch.delete(flightKey);
    }
  }
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
      kind: 'doubao_search',
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

export async function fetchIndustrySearchSupplement({
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
  const key = cleanText(industry, 40);
  if (!key) {
    return {
      items: [],
      status: 'empty-industry',
      billed: false,
      enabled: true,
    };
  }
  const clock = options.now || Date.now;
  const now = Number(clock());
  const memoryCache = options.memoryCache || sharedMemoryCache;
  const readCache = options.readCache || ((path) => readJson(path));
  const writeCache = options.writeCache || ((path, value) =>
    put(path, JSON.stringify(value), {
      contentType: 'application/json',
      addRandomSuffix: false,
      cacheControlMaxAge: 0,
    }));
  const cachedItems = await loadCache('industry', key, {
    now,
    memoryCache,
    readCache,
  });
  if (cachedItems?.length) {
    return {
      items: cachedItems,
      status: 'industry-cache',
      billed: false,
      enabled: true,
      configUpdatedAt: Number(config.updatedAt) || 0,
    };
  }
  const failureCooldown = options.failureCooldown
    || sharedIndustryFailureCooldown;
  const failureKey = key.toLowerCase();
  if (await loadFailureCooldown(failureKey, {
    now,
    failureCooldown,
    readCache,
  })) {
    return {
      items: [],
      status: 'industry-failure-cooldown',
      billed: false,
      enabled: true,
      configUpdatedAt: Number(config.updatedAt) || 0,
    };
  }
  const scheduled = ['auto', 'judge'].includes(
    String(reviewOrigin || ''),
  );
  const result = await fetchAiSearchReference({
    query: buildIndustrySearchQuery(key),
    cacheScope: 'industry',
    cacheKey: key,
    cacheMinutes: INDUSTRY_CACHE_MS / 60000,
  }, {
    ...options,
    runtimeConfig: config,
    memoryCache,
    readCache,
    writeCache,
    cacheOnly: scheduled,
  });
  if (result.items?.length) {
    failureCooldown.delete(failureKey);
  } else if (
    !scheduled
    && !['disabled', 'cache-only-miss'].includes(result.status)
  ) {
    await saveFailureCooldown(failureKey, {
      now,
      failureCooldown,
      writeCache,
    });
  }
  return result;
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
  const stockCacheKey = `v2:${stockKey}`;
  const cacheOptions = { now, memoryCache, readCache, writeCache };
  const stockCached = await loadCache('stock', stockCacheKey, cacheOptions);
  if (stockCached?.length) {
    return {
      items: stockCached,
      status: 'stock-cache',
      billed: false,
      enabled: true,
      configUpdatedAt: Number(config.updatedAt) || 0,
    };
  }
  const scheduled = ['auto', 'judge'].includes(String(reviewOrigin || ''));
  if (scheduled && industry) {
    const industryCached = await loadCache('industry', industry, cacheOptions);
    if (industryCached?.length) {
      return {
        items: industryCached,
        status: 'industry-cache',
        billed: false,
        enabled: true,
        configUpdatedAt: Number(config.updatedAt) || 0,
      };
    }
  }
  if (scheduled) {
    return {
      items: [],
      status: 'scheduled-cache-miss',
      billed: false,
      enabled: true,
      configUpdatedAt: Number(config.updatedAt) || 0,
    };
  }

  const result = await fetchAiSearchReference({
    query: buildAdvisorSearchQuery({ code, name, industry }),
    cacheScope: 'stock',
    cacheKey: stockCacheKey,
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

function mergeSearchItems(entries, limit = 10) {
  const seen = new Set();
  const items = [];
  for (const { scope, result } of entries) {
    for (const item of result?.items || []) {
      const key = item?.url
        ? `url:${item.url}`
        : `title:${String(item?.title || '').trim().toLowerCase()}`;
      if (!item?.title || seen.has(key)) continue;
      seen.add(key);
      items.push({ ...item, searchScope: scope });
      if (items.length >= limit) return items;
    }
  }
  return items;
}

export async function fetchAdvisorSearchBundle({
  code = '',
  name = '',
  industry = '',
  reviewOrigin = '',
  includeIndustry = false,
  industryFallback = false,
} = {}, options = {}) {
  const stockFetcher = options.stockFetcher
    || ((input) => fetchAdvisorSearch(input, options));
  const industryFetcher = options.industryFetcher
    || ((input) => fetchIndustrySearchSupplement(input, options));
  const fetchedStock = await stockFetcher({
    code,
    name,
    industry,
    reviewOrigin,
  }) || {
    items: [],
    status: 'unavailable',
    billed: false,
    enabled: false,
  };
  const stockUsedIndustryCache = fetchedStock.status === 'industry-cache';
  const stock = stockUsedIndustryCache
    ? {
      ...fetchedStock,
      items: [],
      status: 'scheduled-cache-miss',
    }
    : fetchedStock;
  const fetchedIndustry =
    (includeIndustry || industryFallback)
    && industry
    && !stockUsedIndustryCache
    ? await industryFetcher({ industry, reviewOrigin })
    : null;
  const industryResult = fetchedIndustry
    || (stockUsedIndustryCache ? fetchedStock : null);
  const results = [stock, industryResult].filter(Boolean);
  const scopedResults = [
    { scope: 'stock', result: stock },
    ...(industryResult
      ? [{ scope: 'industry', result: industryResult }]
      : []),
  ];
  const fetchedAt = results
    .map((result) => result.fetchedAt)
    .filter(Boolean)
    .sort()
    .at(-1) || null;
  return {
    items: mergeSearchItems(scopedResults),
    status: results
      .map((result, index) =>
        `${index === 0 ? 'stock' : 'industry'}:${result.status || 'unavailable'}`
      )
      .join('|'),
    billed: results.some((result) => result.billed === true),
    enabled: results.some((result) => result.enabled !== false),
    fetchedAt,
    requestId: stock.requestId || industryResult?.requestId || null,
    errorCode: stock.errorCode ?? industryResult?.errorCode ?? null,
    retried: results.some((result) => result.retried === true),
    stock,
    industry: industryResult,
  };
}
