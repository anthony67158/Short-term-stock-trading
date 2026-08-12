// ============ /api/confirm_signal：智能交易确认闸门(前端调用入口)============
// 前端 alertStore 在某条 AI 价位预警进入「观察确认中(watching)」后,轮询调用本端点,
// 让【服务端】跑确定性信号 + LLM Judge(role:'judge'),判定真正交易时机是否到。
//   为什么放服务端:LLM 调用与密钥必须留在后端(合规),前端只拿结论(decision/reason)。
//
// 入参(POST JSON):{ alert:{code,name,type,op,value,note,actKind?,opQty?,timing?,phase?},
//                    advice?:{...AI建议对象,含 exitTiming/invalidation}, quote?:{price,pct,...} }
// 出参:{ ok, decision:'confirm'|'wait'|'invalid', confidence, reason, side, source }
//
// 匿名调用但有严格白名单校验和单实例来源限流，避免外部滥用 LLM/OSS。

import { applyCors, preflight } from './_lib.js';
import { ensureConfig } from './_llm_config.js';
import { judgeConfirmation, sideOf } from './_confirm.js';
import { t1GateForSide } from '../shared/t1AdvicePolicy.js';
import { buildJudgeAdviceContext } from '../shared/judgeAdviceContext.js';
import { buildJudgeKnowledgeActionAssessment } from '../shared/knowledgeAction.js';
import { authorizePaidRequest } from './_account_auth.js';

const rateWindows = new Map();
const RATE_WINDOW_MS = 60 * 1000;
const RATE_LIMIT = 60;
const finite = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};
const text = (value, max) => String(value || '').trim().slice(0, max);

export function sanitizeConfirmationBody(body) {
  const input = body && typeof body === 'object' ? body : {};
  const raw = input.alert && typeof input.alert === 'object' ? input.alert : {};
  const value = finite(raw.value);
  const watchingAt = finite(raw.watchingAt);
  const watchingPrice = finite(raw.watchingPrice);
  const now = Date.now();
  if (!/^\d{6}$/.test(String(raw.code || '')) ||
      raw.type !== 'price' ||
      !['gte', 'lte'].includes(raw.op) ||
      !(value > 0) ||
      !(watchingPrice > 0) ||
      !(watchingAt > 0) ||
      watchingAt > now + 60000 ||
      now - watchingAt > 24 * 60 * 60 * 1000 ||
      raw.phase !== 'watching') {
    return { ok: false, error: '确认请求字段无效' };
  }
  const alert = {
    id: text(raw.id, 100),
    code: String(raw.code),
    name: text(raw.name, 40),
    type: 'price',
    op: raw.op,
    value,
    note: text(raw.note, 80),
    actKind: ['add', 'reduce'].includes(raw.actKind) ? raw.actKind : undefined,
    opQty: text(raw.opQty, 30),
    timing: text(raw.timing, 1200),
    phase: 'watching',
    watchingAt,
    watchingPrice,
  };
  if (raw.judgeContext && typeof raw.judgeContext === 'object') {
    alert.judgeContext = buildJudgeAdviceContext(raw.judgeContext);
  }
  const sellableTodayQty = finite(raw.sellableTodayQty);
  const boughtTodayQty = finite(raw.boughtTodayQty);
  if (sellableTodayQty != null) alert.sellableTodayQty = Math.max(0, sellableTodayQty);
  if (boughtTodayQty != null) alert.boughtTodayQty = Math.max(0, boughtTodayQty);
  if (raw.nextTradeDay) alert.nextTradeDay = text(raw.nextTradeDay, 40);
  const adviceRaw = input.advice && typeof input.advice === 'object' ? input.advice : {};
  const advice = buildJudgeAdviceContext({
    ...(alert.judgeContext || {}),
    ...adviceRaw,
  });
  const quoteRaw = input.quote && typeof input.quote === 'object' ? input.quote : {};
  const quote = {
    price: finite(quoteRaw.price),
    pct: finite(quoteRaw.pct),
    prevClose: finite(quoteRaw.prevClose),
    tradeDate: text(quoteRaw.tradeDate, 10),
  };
  return { ok: true, value: { alert, advice, quote } };
}

function allowRequest(req, now = Date.now()) {
  const forwarded = String(req.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
  const source = forwarded || req.socket?.remoteAddress || 'unknown';
  const current = rateWindows.get(source);
  if (!current || now - current.startedAt >= RATE_WINDOW_MS) {
    if (rateWindows.size > 2000) {
      for (const [key, window] of rateWindows) {
        if (now - window.startedAt >= RATE_WINDOW_MS) rateWindows.delete(key);
      }
    }
    rateWindows.set(source, { startedAt: now, count: 1 });
    return true;
  }
  current.count += 1;
  return current.count <= RATE_LIMIT;
}

export default async function handler(req, res) {
  if (preflight(req, res)) return;
  applyCors(res);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  try {
    if (req.method && req.method !== 'POST') {
      return res.status(405).send(JSON.stringify({ ok: false, decision: 'wait', error: 'method_not_allowed' }));
    }
    const accountAuth = await authorizePaidRequest(req);
    if (!accountAuth.ok) {
      return res.status(accountAuth.error === '请先登录' ? 401 : 403)
        .send(JSON.stringify({
          ok: false,
          decision: 'wait',
          error: accountAuth.error,
        }));
    }
    if (!allowRequest(req)) {
      return res.status(429).send(JSON.stringify({ ok: false, decision: 'wait', error: 'rate_limited' }));
    }
    let body = req.body;
    if (typeof body === 'string') body = JSON.parse(body || '{}');
    const sanitized = sanitizeConfirmationBody(body);
    if (!sanitized.ok) {
      return res.status(422).send(JSON.stringify({ ok: false, decision: 'wait', error: sanitized.error }));
    }
    const { alert, advice, quote } = sanitized.value;
    const gate = alert.sellableTodayQty != null ? t1GateForSide(sideOf(alert), {
      liveQty: (alert.sellableTodayQty || 0) + (alert.boughtTodayQty || 0),
      boughtToday: alert.boughtTodayQty,
      sellableToday: alert.sellableTodayQty,
    }, alert.nextTradeDay) : null;
    if (gate?.blocked) {
      return res.status(200).send(JSON.stringify({
        ok: true,
        decision: 'wait',
        confidence: 100,
        reason: gate.reason,
        side: sideOf(alert),
        source: 't1',
        policy: 't1-blocked',
        knowledgeAction: buildJudgeKnowledgeActionAssessment(
          advice.knowledgeActionPlan || advice,
        ),
      }));
    }
    try { await ensureConfig({ maxAgeMs: 20000 }); } catch { /* 回退确定性信号 */ }
    const v = await judgeConfirmation({
      alert,
      name: alert.name,
      advice,
      quote,
    });
    return res.status(200).send(JSON.stringify({ ok: true, ...v }));
  } catch {
    // 出错时保守返回 wait,避免前端误发强提示
    return res.status(200).send(JSON.stringify({ ok: false, decision: 'wait', error: 'confirm_failed' }));
  }
}
