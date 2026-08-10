// ============ 共享 LLM 层 ============
// 把 ai.js / agent.js / daily_report.js 里各写一份的 LLM 调用、SSE、
// 流解析、JSON 容错，统一收敛到这里。三个 handler 引用本模块，
// 各自保留自己的预算/超时编排逻辑（本层只提供无状态的原子能力）。

import { applyCors } from './_lib.js';
import { currentConfig } from './_llm_config.js';
import { markEndpointUnusable, markSuccess, modelForEndpoint, poolFetch } from './_llm_pool.js';

// ---- 环境读取 ----
// 优先用运行时配置（前端「AI 模型配置」写入 OSS，经 ensureConfig 预热到同步缓存）；
// 未预热或未配置时回退环境变量。handler 入口应先 await ensureConfig() 再调用。
export function llmEnv() {
  const c = currentConfig();
  return {
    BASE: c.baseUrl || process.env.LLM_BASE_URL,
    KEY: c.apiKey || process.env.LLM_API_KEY,
  };
}
export function llmReady() {
  const { BASE, KEY } = llmEnv();
  return !!(BASE && KEY);
}

// ---- 通用 chat completion 调用 ----
// 返回上游 fetch 的原始 Response；网络/abort 错误不抛出，包成 { __err }，
// 与三处调用点原有的 .catch((e)=>({__err:e})) 契约保持一致。
// caller 负责 clearTimeout（通过返回的 done()）与读取 resp.ok / resp.json / resp.body。
export async function callChat({
  model,
  messages,
  tools,
  toolChoice,
  temperature = 0.4,
  maxTokens = 1600,
  timeoutMs = 30000,
  stream = false,
  responseFormat,
  reasoning = false,
  signal,
  role,
  forceNoReason = false,
} = {}) {
  const ctrl = signal ? null : new AbortController();
  const useSignal = signal || (ctrl && ctrl.signal);
  const t = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;

  const bodyObj = {
    model,
    messages,
    temperature,
    max_tokens: maxTokens,
    stream: !!stream,
  };
  if (tools) {
    bodyObj.tools = tools;
    bodyObj.tool_choice = toolChoice || 'auto';
  } else if (toolChoice) {
    bodyObj.tool_choice = toolChoice;
  }
  if (responseFormat) bodyObj.response_format = responseFormat;
  // 深度思考:开启时按 OpenAI 兼容格式传 reasoning_effort=high(网关据此触发思维链)
  if (reasoning) bodyObj.reasoning_effort = 'high';

  const cfg = currentConfig();
  // 资源池路由:配了多端点 → 轮询/最少在途 + 故障转移 + 熔断;未配则退化为单 { BASE, KEY }(向后兼容)。
  // stream 模式下 poolFetch 仍返回上游 Response(其 body 可继续被 pumpStream/pumpChatStream 读取)。
  // 端点级模型:传入 role 时,poolFetch 会在选定端点后按该端点自己的模型名覆盖 body.model
  //   (不同网关同一角色可能是不同模型名);端点没配则回退全局/本次 model。
  // forceNoReason:硬关深度思考(优先级高于端点级/全局 reasoning 配置)——用于「思维链吃穿正文」
  //   后的补生成:此时必须让模型把整段生成用于正文 JSON,绝不能被端点级 reasoning 配置再次拉起 CoT。
  const { resp, endpoint, deferred } = await poolFetch(cfg, '/chat/completions', {
    method: 'POST', body: bodyObj, signal: useSignal, timeoutMs,
    role, modelFallback: model, reasonFallback: reasoning, forceNoReason, deferSuccess: !!stream,
  }, stream ? 1 : 2);   // 流式只试一个端点(半路换端点会丢已下发的 token);非流式允许一次故障转移

  let released = false;
  return {
    resp,
    endpoint: endpoint ? (endpoint.id === 'default' ? '主端点' : endpoint.id) : '',
    endpointId: endpoint?.id || '',
    selectedModel: modelForEndpoint(cfg, endpoint, role, model),
    done: (success = true) => {
      if (t) clearTimeout(t);
      if (deferred && endpoint && !released) {
        released = true;
        if (success) markSuccess(endpoint.id);
        else markEndpointUnusable(endpoint.id, Date.now(), true);
      }
    },
  };
}

// ---- 带一次快速重试的非流式 chat 调用 ----
// 上游偶发网络抖动/5xx/非超时错误时,只要还有时间预算,自动重试一次(缩短超时),显著提升成功率。
// AbortError(客户端主动超时)不重试——那是我们自己掐的,重试只会更晚。stream 模式不在此重试(交由调用方流控)。
// budgetLeftMs: 传入当前剩余预算的取值函数或数值;为 0/负则不重试。
export async function callChatWithRetry(opts = {}, { retries = 1, budgetLeftMs } = {}) {
  const getLeft = typeof budgetLeftMs === 'function' ? budgetLeftMs : () => (budgetLeftMs == null ? Infinity : budgetLeftMs);
  let attempt = 0;
  while (true) {
    const { resp, done, endpoint, selectedModel } = await callChat(opts);
    const errored = resp && resp.__err;
    const isAbort = errored && resp.__err.name === 'AbortError';
    const badStatus = resp && !resp.__err && !resp.ok && resp.status >= 500;
    const retryable = (errored && !isAbort) || badStatus;
    // 还能重试 且 剩余时间够跑一次(至少留 6s) → 关掉当前 timer,重试
    if (retryable && attempt < retries && getLeft() > 6000) {
      done();
      attempt++;
      // 重试时把超时收紧到剩余预算内,避免二次调用又把预算耗光
      const tighter = Math.max(6000, Math.min(opts.timeoutMs || 30000, getLeft() - 2000));
      opts = { ...opts, timeoutMs: tighter };
      continue;
    }
    return { resp, done, endpoint, selectedModel, attempts: attempt + 1 };
  }
}

// ---- SSE 输出工厂 ----
// 设置 SSE 响应头并返回 { emit, phase }。调用方在需要流式时使用。
export function makeSSE(res) {
  applyCors(res); // 跨域直连:SSE 响应也需带 CORS 头
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // 禁止中间层缓冲，token 即时下发
  // ★iOS Safari 修复:阿里云 FC 平台层会给响应注入 Content-Disposition: attachment,
  //   iOS Safari 见 attachment 会把 SSE 当"文件下载"处理→只收一段就断、收不到 result。显式覆盖为 inline。
  res.setHeader('Content-Disposition', 'inline');
  const emit = (event, data) => {
    try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* 连接已断 */ }
  };
  const phase = (text) => emit('phase', { text });
  // ★心跳:长流(深度思考/多股日报)期间每 10s 发一个 SSE 注释行,保持 iOS/移动网络连接活跃。
  //   注释行(以 ':' 开头)不触发前端事件。返回 stop() 供收尾清理,避免 interval 泄漏。
  let hb = setInterval(() => { try { res.write(`: hb ${Date.now()}\n\n`); } catch { /* 断连 */ } }, 10000);
  if (hb && typeof hb.unref === 'function') hb.unref();
  const stopHeartbeat = () => { if (hb) { clearInterval(hb); hb = null; } };
  return { emit, phase, stopHeartbeat };
}

// ---- 读取上游 OpenAI 兼容 SSE 流 ----
// 逐个 content delta 通过 onPiece 回调转发；返回拼好的完整文本。
export async function pumpStream(resp, onPiece) {
  let full = '';
  if (!resp || !resp.body || typeof resp.body.getReader !== 'function') return full; // 上游无流体（错误响应/被中止）时安全返回空串
  const reader = resp.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buf = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line || !line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') return full;
      try {
        const j = JSON.parse(data);
        const piece = j.choices?.[0]?.delta?.content || '';
        if (piece) { full += piece; onPiece(piece); }
      } catch { /* 非完整 JSON 行，忽略 */ }
    }
  }
  return full;
}

// ---- 读取上游 SSE 流：同时捕获【思维链 reasoning_content】与【正文 content】增量 ----
// gpt 系推理模型在 stream 模式下,思维链走 delta.reasoning_content,正文走 delta.content。
// ★但很多【OpenAI 兼容网关】(尤其 DeepSeek-R1 / QwQ 系及自建端点)不单独给 reasoning_content,
//   而是把思维链【内联在 delta.content 里,用 <think>…</think> 包裹】。若不识别这种形态:
//   ① 前端拿不到 reasoning 事件 → "军师推理过程"空;② <think> 块混进 content → JSON 解析失败 → 建议为空。
//   故这里做一个跨 chunk 的 <think> 状态机:标签内文本当作 reasoning 转发,标签外才计入 content。
// onReasoning(piece) / onContent(piece) 分别转发;返回 { content, reasoning, finishReason }。
// 用于「AI操作建议」把模型的推理过程实时下发前端展示(军师在想什么)。
export async function pumpChatStream(resp, { onReasoning, onContent } = {}) {
  let content = '', reasoning = '', finishReason = '';
  if (!resp || !resp.body || typeof resp.body.getReader !== 'function') return { content, reasoning, finishReason };
  const reader = resp.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buf = '';
  // <think> 内联思维链状态机(跨增量保持):inThink 是否在标签内;pend 缓存可能被 chunk 边界切断的半个标签
  let inThink = false, pend = '';
  const feedContent = (piece) => {   // piece 是 delta.content 增量;按 <think>/</think> 拆分:标签内→reasoning,标签外→content
    let s = pend + piece; pend = '';
    while (s) {
      if (!inThink) {
        const open = s.indexOf('<think>');
        if (open < 0) {
          // 可能有半个 "<think" 卡在结尾——留到下次拼接,避免误判
          const tail = s.match(/<(t(h(i(n(k)?)?)?)?)?$/);
          if (tail) { const cut = s.length - tail[0].length; const out = s.slice(0, cut); pend = s.slice(cut); if (out) { content += out; if (typeof onContent === 'function') onContent(out); } }
          else { content += s; if (typeof onContent === 'function') onContent(s); }
          return;
        }
        const out = s.slice(0, open); if (out) { content += out; if (typeof onContent === 'function') onContent(out); }
        s = s.slice(open + 7); inThink = true;
      } else {
        const close = s.indexOf('</think>');
        if (close < 0) {
          const tail = s.match(/<(\/(t(h(i(n(k)?)?)?)?)?)?$/);
          if (tail) { const cut = s.length - tail[0].length; const out = s.slice(0, cut); pend = s.slice(cut); if (out) { reasoning += out; if (typeof onReasoning === 'function') onReasoning(out); } }
          else { reasoning += s; if (typeof onReasoning === 'function') onReasoning(s); }
          return;
        }
        const out = s.slice(0, close); if (out) { reasoning += out; if (typeof onReasoning === 'function') onReasoning(out); }
        s = s.slice(close + 8); inThink = false;
      }
    }
  };
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line || !line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') { if (pend) { content += pend; if (typeof onContent === 'function') onContent(pend); pend = ''; } return { content, reasoning, finishReason }; }
      try {
        const j = JSON.parse(data);
        const delta = j.choices?.[0]?.delta || {};
        const rc = delta.reasoning_content || delta.reasoning || '';
        const cc = delta.content || '';
        if (rc) { reasoning += rc; if (typeof onReasoning === 'function') onReasoning(rc); }
        if (cc) feedContent(cc);   // 内联 <think> 拆分:标签内计入 reasoning,标签外计入 content
        const fr = j.choices?.[0]?.finish_reason;
        if (fr) finishReason = fr;
      } catch { /* 非完整 JSON 行，忽略 */ }
    }
  }
  if (pend) { content += pend; if (typeof onContent === 'function') onContent(pend); pend = ''; }
  return { content, reasoning, finishReason };
}

// ---- LLM JSON 解析（容错）----
// 军师深度思考场景实测两类"脏 JSON"(均 finish_reason=stop,非 token/时间截断):
//   ① 模型在字符串值里写了【未转义的英文双引号】,如  代码"AAPL"是美股…  → 破坏 JSON 但对象其实闭合完整;
//   ② 思维链正文漏进 content、或模型自然停在半个 JSON → 对象未闭合。
// 解析分四级,越往后越"抢救":
//   A 直接解析(剥 ```json 包裹)              → salvaged=false repaired=false
//   B 从前后噪声里抠一个【平衡闭合】的 {…}    → salvaged=true  repaired=false(对象完整,不算截断)
//   C 转义修复(把字符串内未转义的 " → \" 、裸换行/制表符 → \n/\t)后再抠平衡对象
//                                            → salvaged=true  repaired=false(只是脏,不算截断)
//   D 转义修复后仍未闭合(真残缺)→ 补引号/补括号 → salvaged=true  repaired=true(正文真被截断)
// 返回 { value, salvaged, repaired }:repaired=true 才代表正文真的残缺(供上层判 truncated)。
export function parseLLMJson(content) {
  let raw = content || '';
  // ★防御:内联思维链 <think>…</think>(含被截断的未闭合 <think>)先剥掉,否则 JSON 解析必失败。
  raw = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/<think>[\s\S]*$/i, '').trim();

  // —— A: 直接解析 ——
  try {
    const cleaned = raw.replace(/^```json\s*/i, '').replace(/```$/i, '').trim();
    return { value: JSON.parse(cleaned), salvaged: false, repaired: false };
  } catch { /* 下一级 */ }

  const start = raw.indexOf('{');
  if (start < 0) return { value: null, salvaged: false, repaired: false };

  // 在给定串上,从头找到第一个 depth 归零的闭合位置(尊重字符串与转义);无则返回 -1。
  const findBalancedEnd = (s) => {
    let depth = 0, inStr = false, esc = false;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
      if (ch === '"') inStr = true;
      else if (ch === '{') depth++;
      else if (ch === '}') { depth--; if (depth === 0) return i; }
    }
    return -1;
  };

  // —— B: 抠平衡闭合对象(应对模型在 JSON 前后夹带说明文字/思维链) ——
  {
    const end = findBalancedEnd(raw.slice(start));
    if (end >= 0) {
      try { return { value: JSON.parse(raw.slice(start, start + end + 1)), salvaged: true, repaired: false }; }
      catch { /* 内部有未转义引号,进入 C */ }
    }
  }

  // —— C: 转义修复 —— 把字符串值内【未转义的英文双引号】改写为 \" ,裸换行/制表符转义。
  //   判定"是内容引号还是收尾引号":看该 " 之后第一个非空白字符,若是 : , } ] 或串尾 → 视为收尾;否则视为内容引号,转义之。
  const seg = raw.slice(start);
  const repairQuotes = (str) => {
    const out = []; let inStr = false, esc = false;
    for (let i = 0; i < str.length; i++) {
      const ch = str[i];
      if (!inStr) { out.push(ch); if (ch === '"') inStr = true; continue; }
      if (esc) { out.push(ch); esc = false; continue; }
      if (ch === '\\') { out.push(ch); esc = true; continue; }
      if (ch === '"') {
        let j = i + 1; while (j < str.length && ' \t\r\n'.includes(str[j])) j++;
        const nxt = j < str.length ? str[j] : '';
        if (nxt === '' || nxt === ':' || nxt === ',' || nxt === '}' || nxt === ']') { out.push(ch); inStr = false; }
        else out.push('\\"');   // 字符串内容里的裸引号 → 转义
        continue;
      }
      if (ch === '\n') { out.push('\\n'); continue; }
      if (ch === '\r') { continue; }
      if (ch === '\t') { out.push('\\t'); continue; }
      out.push(ch);
    }
    return out.join('');
  };
  const fixed = repairQuotes(seg);
  {
    const end = findBalancedEnd(fixed);
    if (end >= 0) {
      try { return { value: JSON.parse(fixed.slice(0, end + 1)), salvaged: true, repaired: false }; }
      catch { /* 进入 D */ }
    }
  }

  // —— D: 真残缺(未闭合)—— 补齐未闭合引号/括号后解析;这才是真截断,repaired=true。
  const padAndParse = (s) => {
    let depth = 0, inStr = false, esc = false;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
      if (ch === '"') inStr = true;
      else if (ch === '{') depth++;
      else if (ch === '}') depth--;
    }
    let cand = s;
    if (inStr) cand += '"';
    cand += '}'.repeat(Math.max(0, depth));
    return JSON.parse(cand);
  };
  try { return { value: padAndParse(fixed), salvaged: true, repaired: true }; }
  catch { /* 再退一步:去掉尾部残缺键值对后补齐 */ }
  try {
    const trimmed = fixed.replace(/,\s*"[^"]*"\s*:\s*("[^"]*)?$/, '');
    return { value: padAndParse(trimmed), salvaged: true, repaired: true };
  } catch {
    return { value: null, salvaged: false, repaired: false };
  }
}
