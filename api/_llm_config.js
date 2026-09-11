// ============ LLM 运行时配置层（OSS 持久化 + 环境变量回退）============
// 目的：让前端「AI 角色端点」入口能在线修改每个角色自己的 Base URL / API Key / 模型，
// 改完即时对全系统生效，无需重新部署。
//
// 存储：OSS 对象 config/llm.json（复用 _blob.js，与账号数据同桶）。
//   { roleEndpoints:{explain,assistant,daily,sector}, updatedAt }
// 读取优先级：OSS 配置 > 环境变量 > 内置默认。
//
// 关键约束：
//   - callChat / 三个 handler 都是同步读取模型与 BASE/KEY，故本层用【同步缓存】(currentConfig)，
//     由 ensureConfig() 异步预热/刷新缓存；handler 入口先 `await ensureConfig()` 再取值。
//   - API Key 只在后端与 OSS 之间流动，绝不回传前端（getMasked 只给掩码）。

import { put, readJson, hasStorage } from './_blob.js';
import { assertSafeRemoteUrl } from './_safe_remote_url.js';

const KEY_PATH = 'config/llm.json';
const hasOwn = (obj, key) => !!obj && Object.prototype.hasOwnProperty.call(obj, key);

// 模块化引擎负责交易决策，LLM只保留解释、助手、日报和板块研究四个物理角色。
// 旧角色只用于读取迁移，保存后不再作为配置入口。
export const ROLES = {
  explain: {
    envs: [
      'EXPLAIN_MODEL',
      'ADVISOR_MODEL',
      'PORTFOLIO_MODEL',
      'REVIEW_MODEL',
    ],
    def: 'DeepSeek-V4-Pro',
    label: '决策与组合解释',
  },
  assistant: {
    envs: ['ASSISTANT_MODEL', 'AGENT_MODEL'],
    def: 'Qwen3-Max-A',
    label: '智能体助手(需函数调用)',
  },
  daily:   { envs: ['DAILY_MODEL', 'AGENT_MODEL'], def: 'Qwen3-Max-A', label: '策略日报' },
  sector:  { envs: ['SECTOR_MODEL'],  def: 'gpt-5.6-terra',     label: '板块前瞻' },
};

export const ROLE_ENDPOINT_SLOTS = Object.freeze({
  explain: 2,
  assistant: 1,
  daily: 1,
  sector: 1,
});

export const LEGACY_ROLE_ALIASES = Object.freeze({
  advisor: 'explain',
  review: 'explain',
  portfolio: 'explain',
  agent: 'assistant',
  judge: 'explain',
})

const LEGACY_ROLE_SOURCES = Object.freeze({
  explain: ['advisor', 'portfolio', 'review', 'judge'],
  assistant: ['agent'],
  daily: ['daily', 'agent'],
  sector: ['sector'],
})

export function canonicalLlmRole(role) {
  return LEGACY_ROLE_ALIASES[role] || role
}

function legacyValue(source = {}, role) {
  for (const key of [role, ...(LEGACY_ROLE_SOURCES[role] || [])]) {
    if (source?.[key] != null && source[key] !== '') return source[key]
  }
  return undefined
}

// ---- 从环境变量拼出基线配置（OSS 无配置时的回退）----
function envConfig() {
  const models = {};
  const reasoning = {};
  for (const [role, m] of Object.entries(ROLES)) {
    let v = '';
    for (const e of m.envs) { if (process.env[e]) { v = process.env[e]; break; } }
    models[role] = v || m.def;
    reasoning[role] = role === 'sector';
  }
  const config = {
    baseUrl: process.env.LLM_BASE_URL || '',
    apiKey: process.env.LLM_API_KEY || '',
    models,
    reasoning,
    endpoints: [],   // 多端点资源池(默认空 → 走单 baseUrl/apiKey);由前端配置写入 OSS
    primaryMaxInflight: 2,
    source: 'env',
    updatedAt: 0,
  };
  if (process.env.JUDGE_BASE_URL && process.env.JUDGE_API_KEY) {
    config.judgeEndpoint = {
      baseUrl: String(process.env.JUDGE_BASE_URL).replace(/\/+$/, ''),
      apiKey: process.env.JUDGE_API_KEY,
      model: process.env.JUDGE_MODEL || ROLES.explain.def,
      reasoning: process.env.JUDGE_REASONING === 'true',
      enabled: true,
      source: 'env',
    };
  }
  if (process.env.SECTOR_BASE_URL && process.env.SECTOR_API_KEY) {
    config.sectorEndpoint = {
      baseUrl: String(process.env.SECTOR_BASE_URL).replace(/\/+$/, ''),
      apiKey: process.env.SECTOR_API_KEY,
      model: process.env.SECTOR_MODEL || ROLES.sector.def,
      reasoning: process.env.SECTOR_REASONING !== 'false',
      enabled: true,
      source: 'env',
    };
  }
  return config;
}

function normalizeJudgeEndpoint(raw, source = 'dedicated') {
  if (!raw || typeof raw !== 'object') return null;
  return {
    baseUrl: String(raw.baseUrl || '').replace(/\/+$/, ''),
    apiKey: String(raw.apiKey || ''),
    model: String(raw.model || ''),
    reasoning: !!raw.reasoning,
    enabled: raw.enabled !== false,
    source,
  };
}

function normalizeSectorEndpoint(raw, source = 'dedicated') {
  if (!raw || typeof raw !== 'object') return null;
  return {
    baseUrl: String(raw.baseUrl || '').replace(/\/+$/, ''),
    apiKey: String(raw.apiKey || ''),
    model: String(raw.model || ''),
    reasoning: raw.reasoning !== false,
    enabled: raw.enabled !== false,
    source,
  };
}

function normalizeRoleEndpoint(
  raw,
  role,
  index = 0,
  source = 'dedicated',
) {
  if (!raw || typeof raw !== 'object') return null;
  return {
    id: `${role}-${index + 1}`,
    role,
    slot: index + 1,
    baseUrl: String(raw.baseUrl || '').replace(/\/+$/, ''),
    apiKey: String(raw.apiKey || ''),
    model: String(raw.model || legacyValue(raw.models, role) || ''),
    reasoning: !!(
      raw.reasoning === true
      || legacyValue(raw.reasoning, role) === true
    ),
    enabled: raw.enabled !== false,
    source: raw.source || source,
  };
}

function explicitRoleEndpoints(config, role) {
  if (!config?.roleEndpoints) return null;
  const source = config.roleEndpoints;
  const limit = ROLE_ENDPOINT_SLOTS[role] || 1;
  if (hasOwn(source, role)) {
    const raw = Array.isArray(source[role])
      ? source[role]
      : [source[role]];
    return raw
      .slice(0, limit)
      .map((endpoint, index) =>
        normalizeRoleEndpoint(endpoint, role, index)
      )
      .filter(Boolean);
  }

  let foundLegacyRole = false;
  const migrated = [];
  const fingerprints = new Set();
  for (const legacyRole of (LEGACY_ROLE_SOURCES[role] || [])) {
    if (!hasOwn(source, legacyRole)) continue;
    foundLegacyRole = true;
    const raw = Array.isArray(source[legacyRole])
      ? source[legacyRole]
      : [source[legacyRole]];
    for (const endpoint of raw) {
      const normalized = normalizeRoleEndpoint(
        endpoint,
        role,
        migrated.length,
        `legacy-${legacyRole}`,
      );
      if (
        !normalized?.baseUrl
        || !normalized.apiKey
      ) continue;
      const fingerprint = [
        normalized.baseUrl,
        normalized.apiKey,
        normalized.model,
      ].join('|');
      if (fingerprints.has(fingerprint)) continue;
      fingerprints.add(fingerprint);
      migrated.push(normalized);
      if (migrated.length >= limit) return migrated;
    }
  }
  return foundLegacyRole ? migrated : null;
}

// 兼容旧配置：优先迁移附加端点里的 models.judge，其次迁移主端点 judge 模型。
// 一旦显式保存 judgeEndpoint（包括 enabled:false），就绝不再回退通用池。
export function resolveJudgeEndpoint(config = {}) {
  if (hasOwn(config, 'judgeEndpoint')) {
    return normalizeJudgeEndpoint(config.judgeEndpoint, config.judgeEndpoint?.source || 'dedicated');
  }
  const legacy = (config.endpoints || []).find((endpoint) =>
    endpoint && endpoint.enabled !== false && endpoint.baseUrl && endpoint.apiKey && endpoint.models?.judge
  );
  if (legacy) {
    return normalizeJudgeEndpoint({
      baseUrl: legacy.baseUrl,
      apiKey: legacy.apiKey,
      model: legacy.models.judge,
      reasoning: !!legacy.reasoning?.judge,
      enabled: true,
    }, 'legacy-pool');
  }
  if (config.baseUrl && config.apiKey && config.models?.judge) {
    return normalizeJudgeEndpoint({
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      model: config.models.judge,
      reasoning: !!config.reasoning?.judge,
      enabled: true,
    }, 'legacy-main');
  }
  return null;
}

export function resolveSectorEndpoint(config = {}) {
  const explicit = explicitRoleEndpoints(config, 'sector');
  if (explicit) return explicit[0] || null;
  if (hasOwn(config, 'sectorEndpoint')) {
    return normalizeSectorEndpoint(
      config.sectorEndpoint,
      config.sectorEndpoint?.source || 'dedicated',
    );
  }
  const legacy = (config.endpoints || []).find((endpoint) =>
    endpoint
    && endpoint.enabled !== false
    && endpoint.baseUrl
    && endpoint.apiKey
    && endpoint.models?.sector
  );
  if (legacy) {
    return normalizeSectorEndpoint({
      baseUrl: legacy.baseUrl,
      apiKey: legacy.apiKey,
      model: legacy.models.sector,
      reasoning: legacy.reasoning?.sector !== false,
      enabled: true,
    }, 'legacy-pool');
  }
  if (config.baseUrl && config.apiKey && config.models?.sector) {
    return normalizeSectorEndpoint({
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      model: config.models.sector,
      reasoning: config.reasoning?.sector !== false,
      enabled: true,
    }, 'legacy-main');
  }
  return null;
}

export function resolveRoleEndpoints(config = {}, role) {
  role = canonicalLlmRole(role)
  if (!ROLES[role]) return [];
  const explicit = explicitRoleEndpoints(config, role);
  if (explicit) return explicit;
  if (role === 'sector') {
    const endpoint = resolveSectorEndpoint(config);
    return endpoint
      ? [normalizeRoleEndpoint(endpoint, role, 0, endpoint.source)]
      : [];
  }

  const model = legacyValue(config.models, role)
    || ROLES[role].def;
  const reasoning = legacyValue(config.reasoning, role)
    ?? false;
  const candidates = [];
  if (config.baseUrl && config.apiKey) {
    candidates.push(normalizeRoleEndpoint({
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      model,
      reasoning,
      enabled: true,
    }, role, 0, 'legacy-main'));
  }
  for (const endpoint of (config.endpoints || [])) {
    if (
      endpoint?.enabled === false
      || !endpoint?.baseUrl
      || !endpoint?.apiKey
      || !legacyValue(endpoint?.models, role)
    ) continue;
    candidates.push(normalizeRoleEndpoint({
      ...endpoint,
      model: legacyValue(endpoint.models, role),
      reasoning: legacyValue(endpoint.reasoning, role) === true,
    }, role, candidates.length, 'legacy-pool'));
  }
  if (role === 'explain') {
    const judge = resolveJudgeEndpoint(config);
    if (
      judge?.enabled !== false
      && judge?.baseUrl
      && judge?.apiKey
      && judge?.model
      && !candidates.some((endpoint) =>
        endpoint.baseUrl === judge.baseUrl
        && endpoint.apiKey === judge.apiKey
        && endpoint.model === judge.model
      )
    ) {
      candidates.push(normalizeRoleEndpoint(
        judge,
        role,
        candidates.length,
        judge.source || 'legacy-judge',
      ));
    }
  }
  return candidates
    .filter(Boolean)
    .slice(0, ROLE_ENDPOINT_SLOTS[role] || 1)
    .map((endpoint, index) => ({
      ...endpoint,
      id: `${role}-${index + 1}`,
      slot: index + 1,
    }));
}

export function roleEndpointSlots(config = {}, role) {
  role = canonicalLlmRole(role)
  if (!ROLES[role]) return [];
  const resolved = resolveRoleEndpoints(config, role);
  return Array.from(
    { length: ROLE_ENDPOINT_SLOTS[role] || 1 },
    (_, index) => {
      const endpoint = resolved[index];
      if (endpoint) {
        return normalizeRoleEndpoint(
          endpoint,
          role,
          index,
          endpoint.source,
        );
      }
      return normalizeRoleEndpoint({
        model: ROLES[role].def,
        reasoning: role === 'sector',
        enabled: false,
      }, role, index, 'unconfigured');
    },
  );
}

// 合并：OSS 覆盖 env，缺项回退 env/默认
function merge(base, over) {
  if (!over) return base;
  const models = { ...base.models };
  if (over.models) for (const role of Object.keys(ROLES)) {
    const value = legacyValue(over.models, role)
    if (value) models[role] = value;
  }
  const reasoning = { ...base.reasoning };
  if (over.reasoning) for (const role of Object.keys(ROLES)) {
    const value = legacyValue(over.reasoning, role)
    if (value != null) reasoning[role] = !!value;
  }
  // endpoints:多端点资源池。OSS 里存了(即使空数组)则以其为准;未存则保留 base(env 默认空)。
  const endpoints = Array.isArray(over.endpoints) ? over.endpoints : (base.endpoints || []);
  const merged = /** @type {any} */ ({
    baseUrl: over.baseUrl || base.baseUrl,
    apiKey: over.apiKey || base.apiKey,   // OSS 里没存 key 时保留 env key
    models,
    reasoning,
    endpoints,
    primaryMaxInflight: Math.max(
      1,
      Math.min(20, Number(over.primaryMaxInflight ?? base.primaryMaxInflight) || 2),
    ),
    source: over.__stored ? 'oss' : base.source,
    updatedAt: over.updatedAt || base.updatedAt,
  });
  if (hasOwn(over, 'roleEndpoints')) {
    merged.roleEndpoints = {};
    for (const role of Object.keys(ROLES)) {
      const previous = roleEndpointSlots(base, role);
      const migrated = explicitRoleEndpoints(over, role)
      const incoming = migrated || [];
      const explicitlyConfigured = migrated !== null;
      merged.roleEndpoints[role] = Array.from({
        length: ROLE_ENDPOINT_SLOTS[role],
      }, (_, index) => {
        const prior = previous[index] || {};
        const next = incoming[index];
        if (!next || typeof next !== 'object') {
          return explicitlyConfigured
            ? normalizeRoleEndpoint({
                model: ROLES[role].def,
                reasoning: role === 'sector',
                enabled: false,
              }, role, index, 'unconfigured')
            : prior;
        }
        return normalizeRoleEndpoint({
          ...prior,
          ...next,
          apiKey: next.apiKey || prior.apiKey || '',
        }, role, index, next.source || prior.source || 'dedicated');
      });
    }
  } else if (hasOwn(base, 'roleEndpoints')) {
    merged.roleEndpoints = base.roleEndpoints;
  }
  if (hasOwn(over, 'judgeEndpoint')) {
    const previous = resolveJudgeEndpoint(base) || {};
    const incoming = over.judgeEndpoint && typeof over.judgeEndpoint === 'object' ? over.judgeEndpoint : {};
    merged.judgeEndpoint = normalizeJudgeEndpoint({
      ...previous,
      ...incoming,
      apiKey: incoming.apiKey || previous.apiKey || '',
    }, incoming.source || 'dedicated');
  } else if (hasOwn(base, 'judgeEndpoint')) {
    merged.judgeEndpoint = resolveJudgeEndpoint(base);
  } else {
    merged.judgeEndpoint = resolveJudgeEndpoint(merged);
  }
  if (hasOwn(over, 'sectorEndpoint')) {
    const previous = resolveSectorEndpoint(base) || {};
    const incoming = over.sectorEndpoint && typeof over.sectorEndpoint === 'object' ? over.sectorEndpoint : {};
    merged.sectorEndpoint = normalizeSectorEndpoint({
      ...previous,
      ...incoming,
      apiKey: incoming.apiKey || previous.apiKey || '',
    }, incoming.source || 'dedicated');
  } else if (hasOwn(base, 'sectorEndpoint')) {
    merged.sectorEndpoint = resolveSectorEndpoint(base);
  } else {
    merged.sectorEndpoint = resolveSectorEndpoint(merged);
  }
  return merged;
}

let _cache = null;   // 已合并的当前配置（同步取）
let _loadedAt = 0;

export async function assertSafeLlmConfig(config = {}) {
  const candidates = [
    config.baseUrl,
    config.judgeEndpoint?.baseUrl,
    config.sectorEndpoint?.baseUrl,
    ...(Array.isArray(config.endpoints)
      ? config.endpoints.map((endpoint) => endpoint?.baseUrl)
      : []),
    ...Object.values(config.roleEndpoints || {})
      .flat()
      .map((endpoint) => endpoint?.baseUrl),
  ].filter(Boolean);
  await Promise.all(candidates.map((value) => assertSafeRemoteUrl(value)));
  return config;
}

// ---- 异步预热/刷新缓存：handler 入口 await 一次即可 ----
// maxAgeMs 内不重复读 OSS；读失败保留旧缓存或回退 env，绝不抛出。
export async function ensureConfig({ maxAgeMs = 20000 } = {}) {
  const now = Date.now();
  if (_cache && (now - _loadedAt) < maxAgeMs) return _cache;
  const base = envConfig();
  if (!hasStorage()) { _cache = base; _loadedAt = now; return _cache; }
  try {
    const stored = await readJson(KEY_PATH);
    if (stored && typeof stored === 'object') {
      await assertSafeLlmConfig(stored);
      stored.__stored = true;
    }
    _cache = merge(base, stored);
  } catch { _cache = _cache || base; }
  _loadedAt = now;
  return _cache;
}

// ---- 同步取当前配置（未预热则先给 env 基线，不阻塞）----
export function currentConfig() {
  return _cache || envConfig();
}

// ---- 同步取某角色模型 ----
export function getModel(role) {
  role = canonicalLlmRole(role)
  const c = currentConfig();
  const dedicated = resolveRoleEndpoints(c, role)
    .find((endpoint) =>
      endpoint.enabled !== false
      && endpoint.baseUrl
      && endpoint.apiKey
      && endpoint.model
    );
  if (dedicated) return dedicated.model;
  if (role === 'sector') {
    const endpoint = resolveSectorEndpoint(c);
    return endpoint && endpoint.enabled !== false && endpoint.baseUrl && endpoint.apiKey
      ? endpoint.model
      : ((c.models && c.models[role]) || ROLES.sector.def);
  }
  return (c.models && c.models[role]) || (ROLES[role] && ROLES[role].def) || '';
}

// ---- 同步取某角色是否开启深度思考(reasoning) ----
export function getReasoning(role) {
  role = canonicalLlmRole(role)
  const c = currentConfig();
  const dedicated = resolveRoleEndpoints(c, role)
    .filter((endpoint) =>
      endpoint.enabled !== false
      && endpoint.baseUrl
      && endpoint.apiKey
      && endpoint.model
    );
  if (dedicated.length) {
    return dedicated.some((endpoint) => endpoint.reasoning);
  }
  if (role === 'sector') {
    const endpoint = resolveSectorEndpoint(c);
    return endpoint
      ? !!(endpoint.enabled !== false && endpoint.reasoning)
      : !!(c.reasoning && c.reasoning[role]);
  }
  return !!(c.reasoning && c.reasoning[role]);
}

// ---- 保存：写 OSS 并即时更新缓存。patch.apiKey 为空串时保留原 Key（前端不回传明文）----
export async function saveConfig(patch = {}) {
  const cur = await ensureConfig({ maxAgeMs: 0 });
  const next = {
    models: { ...cur.models },
    reasoning: { ...cur.reasoning },
    roleEndpoints: Object.fromEntries(
      Object.keys(ROLES).map((role) => [
        role,
        roleEndpointSlots(cur, role),
      ]),
    ),
    updatedAt: Date.now(),
  };
  if (patch.models) for (const role of Object.keys(ROLES)) {
    if (patch.models[role]) next.models[role] = String(patch.models[role]);
  }
  if (patch.reasoning) for (const role of Object.keys(ROLES)) {
    if (patch.reasoning[role] != null) next.reasoning[role] = !!patch.reasoning[role];
  }
  if (patch.roleEndpoints && typeof patch.roleEndpoints === 'object') {
    for (const role of Object.keys(ROLES)) {
      const previous = roleEndpointSlots(cur, role);
      const incoming = Array.isArray(patch.roleEndpoints[role])
        ? patch.roleEndpoints[role]
        : [];
      next.roleEndpoints[role] = Array.from({
        length: ROLE_ENDPOINT_SLOTS[role],
      }, (_, index) => {
        const prior = previous[index] || {};
        const value = incoming[index] || {};
        const apiKey = (
          value.apiKey != null
          && value.apiKey !== ''
          && !/\*/.test(String(value.apiKey))
        )
          ? String(value.apiKey)
          : (prior.apiKey || '');
        return normalizeRoleEndpoint({
          ...prior,
          ...value,
          apiKey,
          model: value.model || prior.model || ROLES[role].def,
        }, role, index, 'dedicated');
      });
    }
    for (const [role, endpoints] of Object.entries(next.roleEndpoints)) {
      const primary = endpoints.find((endpoint) =>
        endpoint.enabled !== false && endpoint.model
      ) || endpoints[0];
      if (!primary) continue;
      next.models[role] = primary.model || next.models[role];
      next.reasoning[role] = !!primary.reasoning;
    }
  }
  if (!hasStorage()) throw new Error('存储未配置(OSS)，无法保存配置');
  await assertSafeLlmConfig(next);
  // 覆盖写固定对象名（不加随机后缀，保证下次可读到同一路径）
  await put(KEY_PATH, JSON.stringify(next), { contentType: 'application/json', addRandomSuffix: false, cacheControlMaxAge: 0 });
  next.__stored = true;
  _cache = merge(envConfig(), { ...next, __stored: true });
  _loadedAt = Date.now();
  return _cache;
}

// ---- API Key 掩码：只保留末 4 位 ----
export function maskKey(k) {
  const s = String(k || '');
  if (!s) return '';
  if (s.length <= 8) return '****';
  return s.slice(0, 3) + '****' + s.slice(-4);
}

// ---- 给前端的安全视图（绝不含明文 Key）----
export function publicView() {
  const c = currentConfig();
  return {
    models: c.models,
    reasoning: c.reasoning || {},
    roleEndpoints: Object.fromEntries(
      Object.keys(ROLES).map((role) => [
        role,
        roleEndpointSlots(c, role).map((endpoint) => ({
          id: endpoint.id,
          role,
          slot: endpoint.slot,
          baseUrl: endpoint.baseUrl,
          apiKeyMask: maskKey(endpoint.apiKey),
          hasKey: !!endpoint.apiKey,
          model: endpoint.model,
          reasoning: !!endpoint.reasoning,
          enabled: endpoint.enabled !== false,
          source: endpoint.source,
        })),
      ]),
    ),
    source: c.source,
    updatedAt: c.updatedAt || 0,
  };
}
