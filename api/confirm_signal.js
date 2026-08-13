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
import { positionGateForAlert } from '../shared/alertPositionPolicy.js';
import { buildJudgeAdviceContext } from '../shared/judgeAdviceContext.js';
import { buildJudgeKnowledgeActionAssessment } from '../shared/knowledgeAction.js';
import { authorizePaidRequest } from './_account_auth.js';
import { livePositionOf, t1StatusOf } from './_portfolio.js';
import { readAccount, writeAccount } from './account.js';
import {
  isCurrentAdvicePlan,
  queueAdviceReviewForVerdict,
} from './_advice_wakeup.js';
import { scheduleAdviceWorker } from './cron_advice.js';

const rateWindows = new Map();
const RATE_WINDOW_MS = 60 * 1000;
const RATE_LIMIT = 60;
const finite = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};
const text = (value, max) => String(value || '').trim().slice(0, max);

export function applyConfirmationVerdict(
  data,
  requestAlert,
  verdict,
  quotePrice,
  now = Date.now(),
) {
  const alerts = Array.isArray(data?.alerts) ? data.alerts : [];
  const stored = alerts.find((alert) => alert?.id === requestAlert?.id);
  if (!stored) return { queued: false, reason: 'alert-missing' };
  if (!stored.enabled || stored.phase !== 'watching') {
    return { queued: false, reason: 'alert-not-watching' };
  }
  const requestPlanId = String(requestAlert?.judgeContext?.planId || '');
  const storedPlanId = String(stored?.judgeContext?.planId || '');
  if (
    String(requestAlert?.code || '') !== String(stored.code || '')
    || (requestPlanId && requestPlanId !== storedPlanId)
  ) {
    return { queued: false, reason: 'stale-request' };
  }
  if (!isCurrentAdvicePlan(stored, data?.advice?.[stored.code])) {
    stored.enabled = false;
    stored.phase = 'superseded';
    stored.supersededAt = now;
    stored.triggeredMsg = '军师主计划已更新，旧执行确认自动撤销';
    return { queued: false, reason: 'stale-plan' };
  }
  if (!['confirm', 'invalid'].includes(verdict?.decision)) {
    return { queued: false, reason: 'non-decisive' };
  }
  stored.enabled = false;
  stored.phase = verdict.decision === 'confirm' ? 'confirmed' : 'invalid';
  stored.triggeredAt = now;
  stored.triggeredMsg = verdict.decision === 'confirm'
    ? `执行确认:${verdict.reason || ''}`
    : `已失效:${verdict.reason || ''}`;
  stored.lastJudgeAt = now;
  stored.lastJudgeDecision = verdict.decision;
  stored.lastJudgeConfidence = verdict.confidence ?? null;
  stored.decisionPrice = Number.isFinite(Number(quotePrice))
    ? Number(quotePrice)
    : null;
  const queued = queueAdviceReviewForVerdict(data, stored, verdict, now);
  return queued;
}

async function persistConfirmationVerdict(account, alert, verdict, quotePrice) {
  if (!account?.nick || !['confirm', 'invalid'].includes(verdict?.decision)) return;
  const fresh = await readAccount(account.nick);
  if (!fresh?.data) return;
  const queued = applyConfirmationVerdict(
    fresh.data,
    alert,
    verdict,
    quotePrice,
  );
  await writeAccount(fresh);
  if (queued.workerNeeded) {
    try { await scheduleAdviceWorker(account.nick); } catch { /* 5分钟定时器兜底 */ }
  }
}

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
  if (raw.planId) alert.planId = text(raw.planId, 120);
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
    const accountData = accountAuth.account?.data;
    const realStatus = accountData
      ? t1StatusOf(accountData.holding || [], accountData.closed || [], alert.code)
      : null;
    const position = accountData ? {
      verified: true,
      liveQty: realStatus.liveQty,
      sellableToday: realStatus.sellableToday,
      holdingIds: new Set(
        (accountData.holding || [])
          .filter((holding) =>
            String(holding?.code) === String(alert.code) &&
            !!livePositionOf([holding], alert.code)
          )
          .map((holding) => String(holding.id)),
      ),
    } : null;
    const positionGate = position ? positionGateForAlert(alert, position) : null;
    if (positionGate && !positionGate.allowed) {
      const verdict = {
        ok: true,
        decision: 'invalid',
        confidence: 100,
        reason: positionGate.reason,
        side: sideOf(alert),
        source: 'account',
        policy: positionGate.policy,
        knowledgeAction: buildJudgeKnowledgeActionAssessment(
          advice.knowledgeActionPlan || advice,
        ),
      };
      try {
        await persistConfirmationVerdict(
          accountAuth.account,
          alert,
          verdict,
          quote.price,
        );
      } catch { /* 前端仍收到保守判定，云端Timer兜底 */ }
      return res.status(200).send(JSON.stringify(verdict));
    }
    const clientStatus = alert.sellableTodayQty != null ? {
      liveQty: (alert.sellableTodayQty || 0) + (alert.boughtTodayQty || 0),
      boughtToday: alert.boughtTodayQty,
      sellableToday: alert.sellableTodayQty,
    } : null;
    const gate = (realStatus || clientStatus)
      ? t1GateForSide(sideOf(alert), realStatus || clientStatus, alert.nextTradeDay)
      : null;
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
      position,
    });
    try {
      await persistConfirmationVerdict(
        accountAuth.account,
        alert,
        v,
        quote.price,
      );
    } catch { /* 前端仍收到判定，云端Timer兜底 */ }
    return res.status(200).send(JSON.stringify({ ok: true, ...v }));
  } catch {
    // 出错时保守返回 wait,避免前端误发强提示
    return res.status(200).send(JSON.stringify({ ok: false, decision: 'wait', error: 'confirm_failed' }));
  }
}
