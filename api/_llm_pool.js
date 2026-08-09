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
      reasoning: (config.reasoning && typeof config.reasoning === 'object') ? config.reasoning : {},
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
        reasoning: (e.reasoning && typeof e.reasoning === 'object') ? e.reasoning : {},
      });
    });
  }
  return out;
}

// 端点级模型解析:选定端点后按角色定模型。
//   端点自带 models[role] → 用之;
//   仅【主端点 default】在缺省时回退全局 config.models[role](全局模型本就属于主端点网关);
//   【附加端点】绝不借用全局模型——不同网关服务的是各自的模型,把主端点的模型名(如 GPT-5.6)
//   发给一个并不提供该模型的网关只会报错。附加端点没配该角色模型 → 由 endpointServesRole 提前从
//   该角色的路由候选里剔除,故正常不会走到这里的 fallback;万一走到也只回退传入 fallback,不借全局。
export function modelForEndpoint(config, ep, role, fallback) {
  if (ep && ep.models && ep.models[role]) return ep.models[role];
  if (ep && ep.id === 'default' && config && config.models && config.models[role]) return config.models[role];
  return fallback || '';
}

// 某端点是否承接某角色(路由资格):
//   主端点(default)始终承接(用全局模型);附加端点仅在自带该角色模型时才承接。
//   → 保证请求只会被发到「确实提供对应模型」的网关,杜绝把主端点模型名硬塞给其它端点。
export function endpointServesRole(ep, role) {
  if (!ep) return false;
  if (!role) return true;
  if (ep.id === 'default') return true;
  return !!(ep.models && ep.models[role]);
}

// 承接某角色的【可用端点数】——用作「AI 操作建议」并发上限的权威来源:
//   系统并行生成的最大数量 = 用户为该角色配置的端点数(完全一致)。
//   role 传入时只数承接该角色的端点(附加端点须自带该角色模型;主端点始终算);
//   一个端点都没配(理论上主端点缺 base/key)→ 至少返回 1,避免并发上限为 0 导致完全不生成。
export function endpointCountForRole(config, role) {
  const all = endpointsFrom(config);
  const eps = role ? all.filter((e) => endpointServesRole(e, role)) : all;
  return Math.max(1, eps.length);
}

// 端点级深度思考解析:选定端点后按角色定是否启用 reasoning。
//   端点显式配了该角色(true/false)→ 用之;否则回退全局 config.reasoning[role];再回退传入 fallback。
//   注:附加端点 reasoning 里只存 true 的角色(见 _llm_config),故 undefined 即"该端点未单独指定"→ 回退全局。
export function reasoningForEndpoint(config, ep, role, fallback) {
  // ① 端点显式配了该角色(true/false)→ 用之(最高优先,用户对该端点的直接意愿)。
  if (ep && ep.reasoning && ep.reasoning[role] != null) return !!ep.reasoning[role];
  // ② 调用方明确要求开启(fallback=true)→ 尊重之。
  //    fallback 来自 callChat 的 effectiveReasoning——它已综合"全局 reasoning + 任一端点为该角色开了深度思考"
  //    算出本次真实生效值。故当它为 true 时,即便某角色的【全局默认】是 false(envConfig 把所有角色初始化为 false),
  //    也不能让这个"默认 false"把用户在端点上打开的深度思考意愿吞掉(此前 advisor 路由到 default 端点即被此吞掉)。
  if (fallback) return true;
  // ③ 否则回退全局配置。
  if (config && config.reasoning && config.reasoning[role] != null) return !!config.reasoning[role];
  return !!fallback;
}

// 选一个端点:排除熔断中的;在可用端点里按【最少在途 × 权重】选负载最低者(round-robin 的加权推广)。
// 全部熔断时,退而选 cooldownUntil 最早到期者(半开探测),保证不至于完全无端点可用。
// role:传入时只在【承接该角色】的端点里选(附加端点须自带该角色模型),避免把请求路由到不提供对应模型的网关。
//   若某角色只有主端点承接(附加端点都没配该角色模型),自然退化为单主端点。
export function pickEndpoint(config, now = Date.now(), role) {
  const all = endpointsFrom(config);
  if (!all.length) return null;
  // 优先在「承接该角色」的端点里选;但若没有任何端点承接(用户把该角色留空/主端点未填)——
  //   不能因此一个端点都不给,否则该角色所有请求全失败。退回全部端点做安全兜底(配合 modelFallback
  //   用角色默认模型名),保证可用性(恢复迁移前"留空=沿用主端点"的兜底效果)。
  const served = role ? all.filter((e) => endpointServesRole(e, role)) : all;
  const eps = served.length ? served : all;
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
export async function poolFetch(config, path, { method = 'POST', body, signal, timeoutMs = 30000, role, modelFallback, reasonFallback, forceNoReason = false } = {}, maxTries = 2) {
  const eps = endpointsFrom(config);
  if (!eps.length) return { resp: { __err: new Error('no LLM endpoint configured') }, endpoint: null };
  // 承接该角色的候选端点(附加端点须自带该角色模型;主端点始终承接)——路由/故障转移优先在其中进行。
  //   安全兜底:若没有任何端点承接该角色(用户把该角色留空),不再直接失败,而是退回全部端点,
  //   并用 modelFallback(角色默认模型名)发起,保证该角色永不"整体不可路由"(恢复迁移前可用性)。
  const served = role ? eps.filter((e) => endpointServesRole(e, role)) : eps;
  const roleEps = served.length ? served : eps;
  if (!roleEps.length) return { resp: { __err: new Error('no LLM endpoint configured') }, endpoint: null };
  const tried = new Set();
  let lastErr = null;
  const tries = Math.min(maxTries, roleEps.length);
  for (let i = 0; i < tries; i++) {
    let ep = pickEndpoint(config, Date.now(), role);
    if (ep && tried.has(ep.id)) {
      ep = roleEps.find((e) => !tried.has(e.id)) || ep;   // 换一个没试过的(承接该角色的)
    }
    if (!ep) break;
    tried.add(ep.id);
    markStart(ep.id);
    // 端点级模型 + 端点级深度思考:按选中端点重写 body(仅当 body 为对象且指定了 role)
    let sendBody = body;
    if (role && body && typeof body === 'object') {
      sendBody = { ...body };
      const m = modelForEndpoint(config, ep, role, modelFallback || body.model);
      if (m) sendBody.model = m;
      // 深度思考按端点解析:开→注入 reasoning_effort=high;关→删除(避免继承 callChat 的全局注入)
      // forceNoReason:硬关(优先级最高)——补生成场景绝不能让端点级/全局 reasoning 把 CoT 再拉起来。
      const wantReason = forceNoReason ? false : reasoningForEndpoint(config, ep, role, reasonFallback);
      if (wantReason) sendBody.reasoning_effort = 'high';
      else delete sendBody.reasoning_effort;
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
