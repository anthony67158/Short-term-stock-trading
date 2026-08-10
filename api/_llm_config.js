// ============ LLM 运行时配置层（OSS 持久化 + 环境变量回退）============
// 目的：让前端「AI 模型配置」入口能在线修改 Base URL / API Key / 各角色模型，
// 改完即时对全系统生效（对话、操盘军师、智能体、每日日报），无需重新部署。
//
// 存储：OSS 对象 config/llm.json（复用 _blob.js，与账号数据同桶）。
//   { baseUrl, apiKey, models:{chat,advisor,agent}, updatedAt }
// 读取优先级：OSS 配置 > 环境变量 > 内置默认。
//
// 关键约束：
//   - callChat / 三个 handler 都是同步读取模型与 BASE/KEY，故本层用【同步缓存】(currentConfig)，
//     由 ensureConfig() 异步预热/刷新缓存；handler 入口先 `await ensureConfig()` 再取值。
//   - API Key 只在后端与 OSS 之间流动，绝不回传前端（getMasked 只给掩码）。

import { put, readJson, hasStorage } from './_blob.js';

const KEY_PATH = 'config/llm.json';
const hasOwn = (obj, key) => !!obj && Object.prototype.hasOwnProperty.call(obj, key);

// 三个 AI 角色 → 各自的环境变量名与内置默认（与改造前 handler 里的默认保持一致）
// 注：已移除的功能(如「每日复盘日报」)不再单列模型角色；策略日报复用 agent 模型。
export const ROLES = {
  chat:    { envs: ['LLM_MODEL'],     def: 'DeepSeek-V3.2-Pro', label: '对话/盘面分析' },
  advisor: { envs: ['ADVISOR_MODEL'], def: 'DeepSeek-V4-Pro',   label: '操盘军师(深度研判)' },
  agent:   { envs: ['AGENT_MODEL'],   def: 'Qwen3-Max-A',       label: '智能体/策略日报(需函数调用)' },
  judge:   { envs: ['JUDGE_MODEL'],   def: 'gemini-2.5-flash',  label: '交易时机判定(确认闸门)' },
};

// ---- 从环境变量拼出基线配置（OSS 无配置时的回退）----
function envConfig() {
  const models = {};
  const reasoning = {};
  for (const [role, m] of Object.entries(ROLES)) {
    let v = '';
    for (const e of m.envs) { if (process.env[e]) { v = process.env[e]; break; } }
    models[role] = v || m.def;
    reasoning[role] = false;   // 深度思考默认关闭
  }
  const config = {
    baseUrl: process.env.LLM_BASE_URL || '',
    apiKey: process.env.LLM_API_KEY || '',
    models,
    reasoning,
    endpoints: [],   // 多端点资源池(默认空 → 走单 baseUrl/apiKey);由前端配置写入 OSS
    source: 'env',
    updatedAt: 0,
  };
  if (process.env.JUDGE_BASE_URL && process.env.JUDGE_API_KEY) {
    config.judgeEndpoint = {
      baseUrl: String(process.env.JUDGE_BASE_URL).replace(/\/+$/, ''),
      apiKey: process.env.JUDGE_API_KEY,
      model: process.env.JUDGE_MODEL || ROLES.judge.def,
      reasoning: process.env.JUDGE_REASONING === 'true',
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

// 合并：OSS 覆盖 env，缺项回退 env/默认
function merge(base, over) {
  if (!over) return base;
  const models = { ...base.models };
  if (over.models) for (const role of Object.keys(ROLES)) {
    if (over.models[role]) models[role] = over.models[role];
  }
  const reasoning = { ...base.reasoning };
  if (over.reasoning) for (const role of Object.keys(ROLES)) {
    if (over.reasoning[role] != null) reasoning[role] = !!over.reasoning[role];
  }
  // endpoints:多端点资源池。OSS 里存了(即使空数组)则以其为准;未存则保留 base(env 默认空)。
  const endpoints = Array.isArray(over.endpoints) ? over.endpoints : (base.endpoints || []);
  const merged = {
    baseUrl: over.baseUrl || base.baseUrl,
    apiKey: over.apiKey || base.apiKey,   // OSS 里没存 key 时保留 env key
    models,
    reasoning,
    endpoints,
    source: over.__stored ? 'oss' : base.source,
    updatedAt: over.updatedAt || base.updatedAt,
  };
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
  return merged;
}

let _cache = null;   // 已合并的当前配置（同步取）
let _loadedAt = 0;

// ---- 异步预热/刷新缓存：handler 入口 await 一次即可 ----
// maxAgeMs 内不重复读 OSS；读失败保留旧缓存或回退 env，绝不抛出。
export async function ensureConfig({ maxAgeMs = 20000 } = {}) {
  const now = Date.now();
  if (_cache && (now - _loadedAt) < maxAgeMs) return _cache;
  const base = envConfig();
  if (!hasStorage()) { _cache = base; _loadedAt = now; return _cache; }
  try {
    const stored = await readJson(KEY_PATH);
    if (stored && typeof stored === 'object') stored.__stored = true;
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
  const c = currentConfig();
  if (role === 'judge') {
    const endpoint = resolveJudgeEndpoint(c);
    return endpoint && endpoint.enabled !== false && endpoint.baseUrl && endpoint.apiKey
      ? endpoint.model
      : '';
  }
  return (c.models && c.models[role]) || (ROLES[role] && ROLES[role].def) || '';
}

// ---- 同步取某角色是否开启深度思考(reasoning) ----
export function getReasoning(role) {
  const c = currentConfig();
  if (role === 'judge') {
    const endpoint = resolveJudgeEndpoint(c);
    return !!(endpoint && endpoint.enabled !== false && endpoint.reasoning);
  }
  return !!(c.reasoning && c.reasoning[role]);
}

// ---- 保存：写 OSS 并即时更新缓存。patch.apiKey 为空串时保留原 Key（前端不回传明文）----
export async function saveConfig(patch = {}) {
  const cur = await ensureConfig({ maxAgeMs: 0 });
  const next = {
    baseUrl: (patch.baseUrl != null && patch.baseUrl !== '') ? String(patch.baseUrl).replace(/\/+$/, '') : cur.baseUrl,
    apiKey: (patch.apiKey != null && patch.apiKey !== '') ? String(patch.apiKey) : cur.apiKey,
    models: { ...cur.models },
    reasoning: { ...cur.reasoning },
    endpoints: Array.isArray(cur.endpoints) ? cur.endpoints.slice() : [],
    judgeEndpoint: resolveJudgeEndpoint(cur),
    updatedAt: Date.now(),
  };
  if (patch.models) for (const role of Object.keys(ROLES)) {
    if (patch.models[role]) next.models[role] = String(patch.models[role]);
  }
  if (patch.reasoning) for (const role of Object.keys(ROLES)) {
    if (patch.reasoning[role] != null) next.reasoning[role] = !!patch.reasoning[role];
  }
  if (hasOwn(patch, 'judgeEndpoint')) {
    const previous = resolveJudgeEndpoint(cur) || {};
    const incoming = patch.judgeEndpoint && typeof patch.judgeEndpoint === 'object' ? patch.judgeEndpoint : {};
    const apiKey = (incoming.apiKey != null && incoming.apiKey !== '' && !/\*/.test(String(incoming.apiKey)))
      ? String(incoming.apiKey)
      : (previous.apiKey || '');
    next.judgeEndpoint = normalizeJudgeEndpoint({
      baseUrl: incoming.baseUrl ?? previous.baseUrl,
      apiKey,
      model: incoming.model ?? previous.model ?? ROLES.judge.def,
      reasoning: incoming.reasoning ?? previous.reasoning,
      enabled: incoming.enabled ?? previous.enabled ?? true,
    }, 'dedicated');
  }
  // endpoints:整组替换(前端传全量)。每项 apiKey 留空则沿用同 id 旧 key(前端只回传掩码 → 不覆盖)。
  //   每个端点可携带自己的 models:{chat,advisor,agent}——不同网关上同一角色可能是不同模型名。
  //   某角色留空 → 运行时回退到全局 models[role] → 再回退到角色默认(见 _llm_pool.modelForEndpoint)。
  if (Array.isArray(patch.endpoints)) {
    const prevById = new Map((cur.endpoints || []).map((e) => [e.id, e]));
    next.endpoints = patch.endpoints.map((e, i) => {
      const id = e.id || `ep${i}`;
      const prev = prevById.get(id) || {};
      const apiKey = (e.apiKey != null && e.apiKey !== '' && !/\*/.test(String(e.apiKey))) ? String(e.apiKey) : (prev.apiKey || '');
      // 端点级模型:前端传则以其为准(整项替换),未传则沿用旧值;仅保留非空角色。
      const epModels = {};
      const src = (e.models && typeof e.models === 'object') ? e.models : (prev.models || {});
      for (const role of Object.keys(ROLES)) {
        if (role === 'judge') continue;
        const v = src[role];
        if (v != null && String(v).trim()) epModels[role] = String(v).trim();
      }
      // 端点级深度思考:前端传则以其为准(整项替换),未传沿用旧值;仅保留 true 的角色(false=默认关,省空间)。
      const epReason = {};
      const rsrc = (e.reasoning && typeof e.reasoning === 'object') ? e.reasoning : (prev.reasoning || {});
      for (const role of Object.keys(ROLES)) {
        if (role === 'judge') continue;
        if (rsrc[role]) epReason[role] = true;
      }
      return {
        id,
        baseUrl: String(e.baseUrl || prev.baseUrl || '').replace(/\/+$/, ''),
        apiKey,
        weight: Number(e.weight) > 0 ? Number(e.weight) : 1,
        enabled: e.enabled !== false,
        models: epModels,
        reasoning: epReason,
      };
    }).filter((e) => e.baseUrl && e.apiKey);
  }
  if (!hasStorage()) throw new Error('存储未配置(OSS)，无法保存配置');
  // 覆盖写固定对象名（不加随机后缀，保证下次可读到同一路径）
  await put(KEY_PATH, JSON.stringify(next), { contentType: 'application/json', addRandomSuffix: false, cacheControlMaxAge: 0 });
  next.__stored = true;
  _cache = merge(envConfig(), next);
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
    baseUrl: c.baseUrl || '',
    apiKeyMask: maskKey(c.apiKey),
    hasKey: !!c.apiKey,
    models: c.models,
    reasoning: c.reasoning || {},
    judgeEndpoint: (() => {
      const endpoint = resolveJudgeEndpoint(c);
      if (!endpoint) return null;
      return {
        baseUrl: endpoint.baseUrl,
        apiKeyMask: maskKey(endpoint.apiKey),
        hasKey: !!endpoint.apiKey,
        model: endpoint.model,
        reasoning: !!endpoint.reasoning,
        enabled: endpoint.enabled !== false,
        source: endpoint.source,
      };
    })(),
    endpoints: (c.endpoints || []).map((e) => ({
      id: e.id, baseUrl: e.baseUrl || '', weight: e.weight || 1,
      enabled: e.enabled !== false, apiKeyMask: maskKey(e.apiKey), hasKey: !!e.apiKey,
      models: e.models && typeof e.models === 'object'
        ? Object.fromEntries(Object.entries(e.models).filter(([role]) => role !== 'judge'))
        : {},
      reasoning: e.reasoning && typeof e.reasoning === 'object'
        ? Object.fromEntries(Object.entries(e.reasoning).filter(([role]) => role !== 'judge'))
        : {},
    })),
    source: c.source,
    updatedAt: c.updatedAt || 0,
  };
}
