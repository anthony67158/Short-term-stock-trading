// ============ 共享 LLM 层 ============
// 把 ai.js / agent.js / daily_report.js 里各写一份的 LLM 调用、SSE、
// 流解析、JSON 容错，统一收敛到这里。三个 handler 引用本模块，
// 各自保留自己的预算/超时编排逻辑（本层只提供无状态的原子能力）。

import { applyCors } from './_lib.js';

// ---- 环境读取 ----
export function llmEnv() {
  return {
    BASE: process.env.LLM_BASE_URL,
    KEY: process.env.LLM_API_KEY,
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
  signal,
} = {}) {
  const { BASE, KEY } = llmEnv();
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

  const resp = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    signal: useSignal,
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(bodyObj),
  }).catch((e) => ({ __err: e }));

  return { resp, done: () => { if (t) clearTimeout(t); } };
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
