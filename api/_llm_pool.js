// ============ LLM 角色端点路由（角色隔离 + 熔断 + 故障转移）============
// 新配置按角色保存固定槽位：advisor 两路、review 四路，其余角色一路。请求只能进入自身角色槽位；
// 多路角色按最少在途选择，并在网络错误/5xx/429 后切换备用端点。
// 旧 baseUrl/endpoints 结构只在迁移期读取，保存新配置后不再跨角色共享。
//
// endpoint 形态:{ id, baseUrl, apiKey, weight?, enabled? }
// 运行时健康态(内存,进程级):{ inflight, fails, cooldownUntil }
//   连续失败达阈值 → 熔断冷却 COOLDOWN_MS;冷却到期自动半开重试(一次成功即清零恢复)。

import {
  ROLES,
  resolveJudgeEndpoint,
  resolveRoleEndpoints,
  resolveSectorEndpoint,
} from './_llm_config.js';

const COOLDOWN_MS = 60 * 1000;   // 熔断冷却:连续失败达阈值后暂时不选它
const FAIL_THRESHOLD = 3;        // 连续失败多少次触发熔断

const health = new Map();        // id -> { inflight, fails, cooldownUntil }
const roleCapacity = new Map();  // role -> { active, waiters[] }
const roleCursor = new Map();    // role -> next index among equally loaded endpoints
function h(id) {
  let s = health.get(id);
  if (!s) {
    s = {
      inflight: 0,
      fails: 0,
      cooldownUntil: 0,
      latencyMs: null,
      samples: 0,
    };
    health.set(id, s);
  }
  return s;
}

function roleGate(role) {
  let gate = roleCapacity.get(role);
  if (!gate) {
    gate = { active: 0, waiters: [] };
    roleCapacity.set(role, gate);
  }
  return gate;
}

function releaseRoleCapacity(role) {
  if (!role) return;
  const gate = roleGate(role);
  gate.active = Math.max(0, gate.active - 1);
  while (gate.waiters.length) {
    const next = gate.waiters[0];
    if (gate.active >= next.limit) break;
    gate.waiters.shift();
    if (next.signal && next.onAbort) {
      next.signal.removeEventListener('abort', next.onAbort);
    }
    gate.active++;
    next.resolve();
  }
}

function acquireRoleCapacity(role, limit, signal) {
  const releaseOnce = () => {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      releaseRoleCapacity(role);
    };
  };
  if (!role || limit <= 0) return Promise.resolve(() => {});
  const gate = roleGate(role);
  if (gate.active < limit) {
    gate.active++;
    return Promise.resolve(releaseOnce());
  }
  return new Promise((resolve, reject) => {
    const waiter = {
      limit,
      signal,
      onAbort: null,
      resolve: () => resolve(releaseOnce()),
    };
    if (signal) {
      waiter.onAbort = () => {
        const index = gate.waiters.indexOf(waiter);
        if (index >= 0) gate.waiters.splice(index, 1);
        const error = new Error('Aborted');
        error.name = 'AbortError';
        reject(error);
      };
      if (signal.aborted) {
        waiter.onAbort();
        return;
      }
      signal.addEventListener('abort', waiter.onAbort, { once: true });
    }
    gate.waiters.push(waiter);
  });
}

// 从旧版运行时配置解析端点列表。config 来自 _llm_config.currentConfig()。
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
  if (ep.role) return ep.role === role;
  if (role === 'judge') return ep.id === 'judge-dedicated';
  if (role === 'sector') return ep.id === 'sector-dedicated';
  if (ep.id === 'default') return true;
  return !!(ep.models && ep.models[role]);
}

export function endpointsForRole(config, role) {
  if (role) {
    const dedicated = resolveRoleEndpoints(config, role)
      .filter((endpoint) =>
        endpoint
        && endpoint.enabled !== false
        && endpoint.baseUrl
        && endpoint.apiKey
        && endpoint.model
      )
      .map((endpoint, index) => ({
        id: endpoint.id || `${role}-${index + 1}`,
        role,
        slot: endpoint.slot || index + 1,
        baseUrl: endpoint.baseUrl,
        apiKey: endpoint.apiKey,
        weight: 1,
        models: { [role]: endpoint.model },
        reasoning: { [role]: !!endpoint.reasoning },
      }));
    if (
      dedicated.length
      || Object.prototype.hasOwnProperty.call(
        config?.roleEndpoints || {},
        role,
      )
    ) return dedicated;
  }
  if (role === 'judge') {
    const judge = resolveJudgeEndpoint(config);
    if (!judge || judge.enabled === false || !judge.baseUrl || !judge.apiKey || !judge.model) return [];
    return [{
      id: 'judge-dedicated',
      baseUrl: judge.baseUrl,
      apiKey: judge.apiKey,
      weight: 1,
      models: { judge: judge.model },
      reasoning: { judge: !!judge.reasoning },
    }];
  }
  if (role === 'sector') {
    const sector = resolveSectorEndpoint(config);
    if (!sector || sector.enabled === false || !sector.baseUrl || !sector.apiKey || !sector.model) return [];
    return [{
      id: 'sector-dedicated',
      baseUrl: sector.baseUrl,
      apiKey: sector.apiKey,
      weight: 1,
      models: { sector: sector.model },
      reasoning: { sector: !!sector.reasoning },
    }];
  }
  const all = endpointsFrom(config);
  if (!role) return all;
  const served = all.filter((endpoint) => endpointServesRole(endpoint, role));
  return served.length ? served : all;
}

// 承接某角色的【可用端点数】。advisor 的数量是一次性生成并发上限的权威来源。
// 通用生成角色保留最小 1，避免任务调度器因配置缺失进入零并发死锁；
// 真正调用前仍由 llmReady(role)/poolFetch 拒绝无可用端点的请求。
export function endpointCountForRole(config, role) {
  const eps = endpointsForRole(config, role);
  if (['review', 'judge', 'sector'].includes(role)) return eps.length;
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

// 选一个端点:排除熔断中的;按【在途数 × 已测延迟 × 权重】选择。
// 已有成功测速时不强制把下一条单任务送去未知端点；未知端点使用已测最慢值的
// 1.25 倍作为保守估值，只在快端点繁忙时用于扩容。
// 全部熔断时,退而选 cooldownUntil 最早到期者(半开探测),保证不至于完全无端点可用。
// role:传入时只在【承接该角色】的端点里选(附加端点须自带该角色模型),避免把请求路由到不提供对应模型的网关。
//   若某角色只有主端点承接(附加端点都没配该角色模型),自然退化为单主端点。
export function pickEndpoint(config, now = Date.now(), role) {
  const eps = endpointsForRole(config, role);
  if (!eps.length) return null;
  const usable = eps.filter((e) => h(e.id).cooldownUntil <= now);
  const pool = usable.length ? usable : eps;
  const measuredLatencies = pool
    .map((endpoint) => Number(h(endpoint.id).latencyMs))
    .filter((latency) => Number.isFinite(latency) && latency > 0);
  const unmeasuredLatency = measuredLatencies.length
    ? Math.max(...measuredLatencies) * 1.25
    : 1;
  let bestScore = Infinity;
  const candidates = [];
  for (const e of pool) {
    const s = h(e.id);
    const latencyFactor = s.latencyMs || unmeasuredLatency;
    const score = (
      (s.inflight + 1) * latencyFactor
    ) / (e.weight || 1);
    if (score < bestScore) {
      bestScore = score;
      candidates.length = 0;
      candidates.push(e);
    } else if (score === bestScore) {
      candidates.push(e);
    }
  }
  const cursorKey = role || 'default';
  const cursor = roleCursor.get(cursorKey) || 0;
  const best = candidates[cursor % candidates.length] || pool[0];
  roleCursor.set(cursorKey, cursor + 1);
  return best;
}

export function markStart(id) { h(id).inflight++; }
export function markSuccess(id, latencyMs = null) {
  const s = h(id);
  s.inflight = Math.max(0, s.inflight - 1);
  s.fails = 0;
  s.cooldownUntil = 0;
  const elapsed = Number(latencyMs);
  if (Number.isFinite(elapsed) && elapsed > 0) {
    s.latencyMs = s.latencyMs == null
      ? elapsed
      : Math.round(s.latencyMs * 0.7 + elapsed * 0.3);
    s.samples++;
  }
}
export function markFailure(id, now = Date.now()) {
  const s = h(id);
  s.inflight = Math.max(0, s.inflight - 1);
  s.fails++;
  if (s.fails >= FAIL_THRESHOLD) s.cooldownUntil = now + COOLDOWN_MS;
}
export function markEndpointUnusable(id, now = Date.now(), releaseInflight = false) {
  const state = h(id);
  if (releaseInflight) state.inflight = Math.max(0, state.inflight - 1);
  state.fails = Math.max(state.fails, FAIL_THRESHOLD);
  state.cooldownUntil = now + COOLDOWN_MS;
}

export function resetPoolHealthForTests() {
  health.clear();
  roleCapacity.clear();
  roleCursor.clear();
}

// 池化 fetch:自动选端点 + 失败故障转移到下一个可用端点(最多试 maxTries 个)。
// 返回 { resp, endpoint }。resp 与原生 fetch 一致(或 { __err })。
// 注:调用方负责构造 body/headers 的其余部分——本函数只注入 baseUrl 与 Authorization。
// 端点级模型:若传入 role,则选定端点后按 modelForEndpoint 覆盖 body.model
//   (不同网关同一角色可能是不同模型名);modelFallback 为角色默认(端点与全局都没配时用)。
export async function poolFetch(config, path, {
  method = 'POST', body, signal, timeoutMs = 30000, role, modelFallback,
  reasonFallback, reasoningEffort = 'medium',
  forceNoReason = false, forceReason = false, deferSuccess = false,
  headerTimeoutMs = timeoutMs,
} = {}, maxTries = 2) {
  const roleEps = endpointsForRole(config, role);
  if (!roleEps.length) return { resp: { __err: new Error('no LLM endpoint configured') }, endpoint: null };
  let releaseRole = () => {};
  try {
    releaseRole = await acquireRoleCapacity(
      role,
      roleEps.length,
      signal,
    );
  } catch (error) {
    return { resp: { __err: error }, endpoint: null };
  }
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
    const attemptStartedAt = Date.now();
    // 端点级模型 + 端点级深度思考:按选中端点重写 body(仅当 body 为对象且指定了 role)
    let sendBody = body;
    if (role && body && typeof body === 'object') {
      sendBody = { ...body };
      const m = modelForEndpoint(config, ep, role, modelFallback || body.model);
      if (m) sendBody.model = m;
      // 深度思考按端点解析：开时注入调用方给定的有界强度，关时删除。
      // forceNoReason:显式发送 none，避免删除字段后由网关恢复默认深度推理。
      const wantReason = forceReason
          ? true
          : reasoningForEndpoint(config, ep, role, reasonFallback);
      if (forceNoReason) sendBody.reasoning_effort = 'none';
      else if (wantReason) sendBody.reasoning_effort = reasoningEffort;
      else delete sendBody.reasoning_effort;
    }
    const ctrl = new AbortController();
    let headerTimedOut = false;
    const useSignal = signal && typeof AbortSignal.any === 'function'
      ? AbortSignal.any([signal, ctrl.signal])
      : (signal || ctrl.signal);
    const headerBudget = Math.max(
      250,
      Math.min(
        Number(timeoutMs) || 30000,
        roleEps.length > 1
          ? Number(headerTimeoutMs) || Number(timeoutMs) || 30000
          : Number(timeoutMs) || 30000,
      ),
    );
    const t = setTimeout(() => {
      const idleAlternative = roleEps.some((candidate) => {
        if (
          tried.has(candidate.id)
          || h(candidate.id).cooldownUntil > Date.now()
        ) return false;
        return h(candidate.id).inflight === 0;
      });
      // 所有备用端点都在服务其它任务时，切换只会把请求塞到繁忙端点，
      // 同时丢掉当前已排队的上游请求。此时继续等待当前端点，由总预算兜底。
      if (i + 1 >= tries || !idleAlternative) return;
      headerTimedOut = true;
      ctrl.abort();
    }, headerBudget);
    let resp;
    try {
      resp = await fetch(`${ep.baseUrl}${path}`, {
        method, signal: useSignal,
        headers: { Authorization: `Bearer ${ep.apiKey}`, 'Content-Type': 'application/json' },
        body: typeof sendBody === 'string' ? sendBody : JSON.stringify(sendBody || {}),
      });
    } catch (e) { resp = { __err: e }; }
    clearTimeout(t);
    const errored = resp && resp.__err;
    const isAbort = errored && resp.__err && resp.__err.name === 'AbortError';
    const bad5xx = resp && !resp.__err && !resp.ok && resp.status >= 500;
    const rateLimited = resp && !resp.__err && resp.status === 429;
    // 成功或客户端主动超时(abort)→ 直接返回(abort 不换端点:是我们自己掐的)
    if (!errored && resp.ok) {
      if (deferSuccess) {
        return {
          resp,
          endpoint: ep,
          deferred: true,
          attemptStartedAt,
          releaseRole,
        };
      }
      markSuccess(ep.id, Date.now() - attemptStartedAt);
      releaseRole();
      return { resp, endpoint: ep, deferred: false };
    }
    if (
      isAbort
      && headerTimedOut
      && !signal?.aborted
      && i + 1 < tries
    ) {
      markFailure(ep.id);
      lastErr = new Error('LLM response header timeout');
      continue;
    }
    if (isAbort) {
      markFailure(ep.id);
      releaseRole();
      return { resp, endpoint: ep };
    }
    // 可转移错误(网络错/5xx/429)→ 记失败,尝试下一个端点
    if (errored || bad5xx || rateLimited) {
      markFailure(ep.id);
      lastErr = errored ? resp.__err : new Error(`HTTP ${resp.status}`);
      continue;
    }
    // 其它 4xx(如 400/401)→ 不重试(换端点也无意义),原样返回
    markFailure(ep.id);
    releaseRole();
    return { resp, endpoint: ep };
  }
  releaseRole();
  return { resp: { __err: lastErr || new Error('all endpoints failed') }, endpoint: null };
}

// 池健康快照(供 /api/llm_config 的 pool 视图 / 监控)——绝不含明文 Key。
export function poolStatus(config, now = Date.now()) {
  const endpoints = Object.keys(ROLES)
    .flatMap((role) => endpointsForRole(config, role));
  return endpoints.map((e) => {
    const s = h(e.id);
    return {
      id: e.id, role: e.role || '', slot: e.slot || null,
      baseUrl: e.baseUrl, weight: e.weight,
      inflight: s.inflight, fails: s.fails,
      latencyMs: s.latencyMs,
      latencySamples: s.samples,
      cooling: s.cooldownUntil > now, cooldownMsLeft: Math.max(0, s.cooldownUntil - now),
    };
  });
}

export function judgeEndpointStatus(config, now = Date.now()) {
  const endpoint = endpointsForRole(config, 'judge')[0];
  if (!endpoint) return null;
  const state = h(endpoint.id);
  return {
    id: endpoint.id,
    baseUrl: endpoint.baseUrl,
    inflight: state.inflight,
    fails: state.fails,
    cooling: state.cooldownUntil > now,
    cooldownMsLeft: Math.max(0, state.cooldownUntil - now),
  };
}

export function sectorEndpointStatus(config, now = Date.now()) {
  const endpoint = endpointsForRole(config, 'sector')[0];
  if (!endpoint) return null;
  const state = h(endpoint.id);
  return {
    id: endpoint.id,
    baseUrl: endpoint.baseUrl,
    inflight: state.inflight,
    fails: state.fails,
    cooling: state.cooldownUntil > now,
    cooldownMsLeft: Math.max(0, state.cooldownUntil - now),
  };
}
