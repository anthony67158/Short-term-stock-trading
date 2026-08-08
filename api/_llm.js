// ============ 共享 LLM 层 ============
// 把 ai.js / agent.js / daily_report.js 里各写一份的 LLM 调用、SSE、
// 流解析、JSON 容错，统一收敛到这里。三个 handler 引用本模块，
// 各自保留自己的预算/超时编排逻辑（本层只提供无状态的原子能力）。

import { applyCors } from './_lib.js';
import { currentConfig } from './_llm_config.js';
import { poolFetch } from './_llm_pool.js';

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
  const { resp } = await poolFetch(cfg, '/chat/completions', {
    method: 'POST', body: bodyObj, signal: useSignal, timeoutMs,
    role, modelFallback: model, reasonFallback: reasoning,
  }, stream ? 1 : 2);   // 流式只试一个端点(半路换端点会丢已下发的 token);非流式允许一次故障转移

  return { resp, done: () => { if (t) clearTimeout(t); } };
}

// ---- 带一次快速重试的非流式 chat 调用 ----
// 上游偶发网络抖动/5xx/非超时错误时,只要还有时间预算,自动重试一次(缩短超时),显著提升成功率。
// AbortError(客户端主动超时)不重试——那是我们自己掐的,重试只会更晚。stream 模式不在此重试(交由调用方流控)。
// budgetLeftMs: 传入当前剩余预算的取值函数或数值;为 0/负则不重试。
export async function callChatWithRetry(opts = {}, { retries = 1, budgetLeftMs } = {}) {
  const getLeft = typeof budgetLeftMs === 'function' ? budgetLeftMs : () => (budgetLeftMs == null ? Infinity : budgetLeftMs);
  let attempt = 0;
  while (true) {
    const { resp, done } = await callChat(opts);
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
    return { resp, done, attempts: attempt + 1 };
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
  const emit = (event, data) => {
    try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* 连接已断 */ }
  };
  const phase = (text) => emit('phase', { text });
  return { emit, phase };
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
// onReasoning(piece) / onContent(piece) 分别转发;返回 { content, reasoning, finishReason }。
// 用于「AI操作建议」把模型的推理过程实时下发前端展示(军师在想什么)。
export async function pumpChatStream(resp, { onReasoning, onContent } = {}) {
  let content = '', reasoning = '', finishReason = '';
  if (!resp || !resp.body || typeof resp.body.getReader !== 'function') return { content, reasoning, finishReason };
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
      if (data === '[DONE]') return { content, reasoning, finishReason };
      try {
        const j = JSON.parse(data);
        const delta = j.choices?.[0]?.delta || {};
        const rc = delta.reasoning_content || delta.reasoning || '';
        const cc = delta.content || '';
        if (rc) { reasoning += rc; if (typeof onReasoning === 'function') onReasoning(rc); }
        if (cc) { content += cc; if (typeof onContent === 'function') onContent(cc); }
        const fr = j.choices?.[0]?.finish_reason;
        if (fr) finishReason = fr;
      } catch { /* 非完整 JSON 行，忽略 */ }
    }
  }
  return { content, reasoning, finishReason };
}

// ---- LLM JSON 解析（容错）----
// 先剥离 ```json 包裹直接解析；失败则尝试补齐被 max_tokens 截断的尾部再解析。
// 返回 { value, salvaged }：value 为解析对象或 null；salvaged 标记是否走了补齐路径。
export function parseLLMJson(content) {
  const raw = content || '';
  try {
    const cleaned = raw.replace(/^```json\s*/i, '').replace(/```$/i, '').trim();
    return { value: JSON.parse(cleaned), salvaged: false };
  } catch { /* 进入补齐 */ }
  try {
    let s = raw.replace(/^```json\s*/i, '').replace(/```$/i, '').trim();
    // 去掉最后一个残缺的键值对，再按未闭合层级补齐引号/括号
    s = s.replace(/,\s*"[^"]*"\s*:\s*("[^"]*)?$/, '');
    const openBraces = (s.match(/\{/g) || []).length - (s.match(/\}/g) || []).length;
    const openBrackets = (s.match(/\[/g) || []).length - (s.match(/\]/g) || []).length;
    const quotes = (s.match(/(?<!\\)"/g) || []).length;
    if (quotes % 2 === 1) s += '"';
    s += ']'.repeat(Math.max(0, openBrackets)) + '}'.repeat(Math.max(0, openBraces));
    return { value: JSON.parse(s), salvaged: true };
  } catch {
    return { value: null, salvaged: false };
  }
}
