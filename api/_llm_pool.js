// ============ LLM 端点资源池(可选多 Base URL/Key + 路由 + 熔断 + 故障转移)============
// 为什么存在(直接回应"3 路并发是否要 3 个 Base URL/Key/模型实例"):
//   · callChat 每次都用【独立 messages + 独立 fetch】,是无状态 HTTP → 3 并发不会串上下文、不需要 3 个模型实例。
//   · 一个 Key 通常够 3 并发;唯一风险是 429 限流(非正确性问题)。所以本池是【可选冗余】:
//     - 不配 endpoints → 退化为单 { baseUrl, apiKey }(现状,完全向后兼容);
//     - 配了多个 endpoints → 提供路由(轮询/最少在途)+ 连续失败熔断冷却 + 自动恢复,提升并发下的稳定性。
//   · 每个"请求上下文"天然隔离(各自 messages/AbortController/timeout),池只负责"这次请求用哪个端点连"。
//
// endpoint 形态:{ id, baseUrl, apiKey, weight?, enabled? }
// 运行时健康态(内存,进程级):{ inflight, fails, cooldownUntil }
//   连续失败达阈值 → 熔断冷却 COOLDOWN_MS;冷却到期自动半开重试(一次成功即清零恢复)。

const COOLDOWN_MS = 60 * 1000;   // 熔断冷却:连续失败达阈值后暂时不选它
const FAIL_THRESHOLD = 3;        // 连续失败多少次触发熔断

const health = new Map();        // id -> { inflight, fails, cooldownUntil }
function h(id) {
  let s = health.get(id);
  if (!s) { s = { inflight: 0, fails: 0, cooldownUntil: 0 }; health.set(id, s); }
  return s;
}

// 从运行时配置解析端点列表。config 来自 _llm_config.currentConfig()。
//   主端点(step-1 的 baseUrl/apiKey)始终作为 id 'default' 的一等成员参与池路由;
//   config.endpoints[] 里的附加端点在其后追加(按 enabled 过滤、按 id 去重)。
//   每个端点携带自己的 models:{chat,advisor,agent}——不同网关同一角色可能是不同模型名。
//   都没配 → 空数组(无端点可用)。
export function endpointsFrom(config) {
  const out = [];
  // 主端点:step-1 单端点,视为 id 'default',其模型取全局 config.models。
  if (config && config.baseUrl && config.apiKey) {
    out.push({
      id: 'default',
      baseUrl: String(config.baseUrl).replace(/\/+$/, ''),
      apiKey: config.apiKey,
      weight: 1,
      models: (config.models && typeof config.models === 'object') ? config.models : {},
    });
  }
  const eps = Array.isArray(config && config.endpoints) ? config.endpoints : null;
  if (eps && eps.length) {
    eps.forEach((e, i) => {
      if (!e || e.enabled === false) return;
      const baseUrl = String(e.baseUrl || '').replace(/\/+$/, '');
      const apiKey = e.apiKey || '';
      if (!baseUrl || !apiKey) return;
      const id = e.id || `ep${i}`;
      if (out.some((o) => o.id === id)) return;   // 与主端点或彼此 id 冲突则跳过
      out.push({
        id, baseUrl, apiKey,
        weight: Number(e.weight) > 0 ? Number(e.weight) : 1,
        models: (e.models && typeof e.models === 'object') ? e.models : {},
      });
    });
  }
  return out;
}

// 端点级模型解析:选定端点后按角色定模型。
//   端点自带 models[role] → 用之;否则回退全局 config.models[role];再回退传入的 fallback(通常是角色默认)。
export function modelForEndpoint(config, ep, role, fallback) {
  if (ep && ep.models && ep.models[role]) return ep.models[role];
  if (config && config.models && config.models[role]) return config.models[role];
  return fallback || '';
}

// 选一个端点:排除熔断中的;在可用端点里按【最少在途 × 权重】选负载最低者(round-robin 的加权推广)。
// 全部熔断时,退而选 cooldownUntil 最早到期者(半开探测),保证不至于完全无端点可用。
export function pickEndpoint(config, now = Date.now()) {
  const eps = endpointsFrom(config);
  if (!eps.length) return null;
  const usable = eps.filter((e) => h(e.id).cooldownUntil <= now);
  const pool = usable.length ? usable : eps;
  let best = null, bestScore = Infinity;
  for (const e of pool) {
    const s = h(e.id);
    const score = (s.inflight + 1) / (e.weight || 1);   // 在途越多、权重越低 → 分越高越不优先
    if (score < bestScore) { bestScore = score; best = e; }
  }
  return best;
}

export function markStart(id) { h(id).inflight++; }
export function markSuccess(id) { const s = h(id); s.inflight = Math.max(0, s.inflight - 1); s.fails = 0; s.cooldownUntil = 0; }
export function markFailure(id, now = Date.now()) {
  const s = h(id);
  s.inflight = Math.max(0, s.inflight - 1);
  s.fails++;
  if (s.fails >= FAIL_THRESHOLD) s.cooldownUntil = now + COOLDOWN_MS;
}

// 池化 fetch:自动选端点 + 失败故障转移到下一个可用端点(最多试 maxTries 个)。
// 返回 { resp, endpoint }。resp 与原生 fetch 一致(或 { __err })。
// 注:调用方负责构造 body/headers 的其余部分——本函数只注入 baseUrl 与 Authorization。
// 端点级模型:若传入 role,则选定端点后按 modelForEndpoint 覆盖 body.model
//   (不同网关同一角色可能是不同模型名);modelFallback 为角色默认(端点与全局都没配时用)。
export async function poolFetch(config, path, { method = 'POST', body, signal, timeoutMs = 30000, role, modelFallback } = {}, maxTries = 2) {
  const eps = endpointsFrom(config);
  if (!eps.length) return { resp: { __err: new Error('no LLM endpoint configured') }, endpoint: null };
  const tried = new Set();
  let lastErr = null;
  const tries = Math.min(maxTries, eps.length);
  for (let i = 0; i < tries; i++) {
    let ep = pickEndpoint(config);
    if (ep && tried.has(ep.id)) {
      ep = eps.find((e) => !tried.has(e.id)) || ep;   // 换一个没试过的
    }
    if (!ep) break;
    tried.add(ep.id);
    markStart(ep.id);
    // 端点级模型:按选中端点重写 body.model(仅当 body 为对象且指定了 role)
    let sendBody = body;
    if (role && body && typeof body === 'object') {
      const m = modelForEndpoint(config, ep, role, modelFallback || body.model);
      if (m) sendBody = { ...body, model: m };
    }
    const ctrl = signal ? null : new AbortController();
    const useSignal = signal || (ctrl && ctrl.signal);
    const t = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
    let resp;
    try {
      resp = await fetch(`${ep.baseUrl}${path}`, {
        method, signal: useSignal,
        headers: { Authorization: `Bearer ${ep.apiKey}`, 'Content-Type': 'application/json' },
        body: typeof sendBody === 'string' ? sendBody : JSON.stringify(sendBody || {}),
      });
    } catch (e) { resp = { __err: e }; }
    if (t) clearTimeout(t);
    const errored = resp && resp.__err;
    const isAbort = errored && resp.__err && resp.__err.name === 'AbortError';
    const bad5xx = resp && !resp.__err && !resp.ok && resp.status >= 500;
    const rateLimited = resp && !resp.__err && resp.status === 429;
    // 成功或客户端主动超时(abort)→ 直接返回(abort 不换端点:是我们自己掐的)
    if (!errored && resp.ok) { markSuccess(ep.id); return { resp, endpoint: ep }; }
    if (isAbort) { markFailure(ep.id); return { resp, endpoint: ep }; }
    // 可转移错误(网络错/5xx/429)→ 记失败,尝试下一个端点
    if (errored || bad5xx || rateLimited) {
      markFailure(ep.id);
      lastErr = errored ? resp.__err : new Error(`HTTP ${resp.status}`);
      continue;
    }
    // 其它 4xx(如 400/401)→ 不重试(换端点也无意义),原样返回
    markFailure(ep.id);
    return { resp, endpoint: ep };
  }
  return { resp: { __err: lastErr || new Error('all endpoints failed') }, endpoint: null };
}

// 池健康快照(供 /api/llm_config 的 pool 视图 / 监控)——绝不含明文 Key。
export function poolStatus(config, now = Date.now()) {
  return endpointsFrom(config).map((e) => {
    const s = h(e.id);
    return {
      id: e.id, baseUrl: e.baseUrl, weight: e.weight,
      inflight: s.inflight, fails: s.fails,
      cooling: s.cooldownUntil > now, cooldownMsLeft: Math.max(0, s.cooldownUntil - now),
    };
  });
}
