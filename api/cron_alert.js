// ============ 云端定时「盯盘预警」评估 + Web Push 下发(脱离浏览器) ============
// 背景:原预警只在浏览器标签打开时由前端 alertStore.evaluate 跑;关页面/切后台就停了。
//   本 handler 把「命中判定 + 推送」搬到服务端:FC Timer 在交易时段直接调用并遍历所有账号,
//   取其启用中预警涉及的实时报价,逐条判命中 → 命中即 web-push 给该账号所有设备(关页面也收)
//   → 并把命中的预警在 OSS 里标记 triggeredAt/enabled:false(与前端 markAlertTriggered 同口径),
//   保证同一规则不被重复推送(幂等)。
//
// 关键约束:
//   · 只读写 data.alerts / data.pushSubs,绝不动 plan/holding/closed/account(避免覆盖用户编辑)。
//   · hit()/describeAlert() 与前端 src/alertStore.js 完全同口径(到价须 price>0 防休市误触发等)。
//   · 鉴权:X-Cron-Key(= 环境变量 CRON_KEY),防匿名 HTTP 触发器滥用。未配置则放行(本地)。
//   · 失效订阅(410/404)自动从账号剔除,避免长期堆积。
//
// 触发:FC Timer 事件(生产)或 POST /api/cron_alert + X-Cron-Key(手动联调)
//   body:{ nick?:'仅跑某账号', roundMs?, budgetMs? }
//   本 handler 内部自循环:每分钟由 FC Timer 触发一次,单次内按 roundMs(默认 8s)连续评估多轮直到
//   耗尽 budgetMs(默认 55s)。Timer 事件使用 50s 预算,给相邻分钟调用留出收尾余量。

import { applyCors, preflight } from './_lib.js';
import { listAllAccounts, readAccount, writeAccount } from './account.js';
import quoteHandler from './quote.js';
import { sendPush } from './_push_send.js';
import { ensureConfig } from './_llm_config.js';
import { judgeConfirmation, sideOf } from './_confirm.js';
import { actionLabelOf } from '../shared/judgeAdviceContext.js';
import {
  positionGateForAlert,
  requiresPositionCheck,
  retirePositionAlert,
} from '../shared/alertPositionPolicy.js';
import { livePositionOf, t1StatusOf } from './_portfolio.js';
import {
  collectOutcomeSnapshots,
  duplicateSmartAlerts,
  resolveDecisionSide,
} from '../shared/confirmPolicy.js';
import { applyT1ToAlert } from '../shared/t1AdvicePolicy.js';
import {
  formatPriceLimitThreshold,
  isNearPriceLimit,
} from '../shared/priceLimitPolicy.js';
import { needsWorkerDispatch } from './_jobs.js';
import { scheduleAdviceWorker } from './cron_advice.js';
import {
  isCurrentAdvicePlan,
  queueAdviceReviewForVerdict,
} from './_advice_wakeup.js';
import { isAdviceReviewEnabled } from '../shared/adviceReviewPolicy.js';
import { isContinuousTrading } from '../shared/tradingCalendar.js';
import { buildAlertNotification } from '../shared/alertNotification.js';

const OP_LABEL = { gte: '≥', lte: '≤' };

// 单账号单轮「智能确认(LLM judge)」调用上限:watching 态预警很多时,若逐条 judge 会烧光 token/超时,
// 拖垮整轮拨测。超出预算的 watching 预警本轮跳过(维持 watching,下轮再判),保证每轮有界收敛。
const JUDGE_BUDGET_PER_ROUND = 4;
const JUDGE_INTERVAL_MS = { buy: 45000, sell: 30000, stop: 20000 };
const WATCHING_MAX_MS = 90 * 60 * 1000;

export { isCurrentAdvicePlan, queueAdviceReviewForVerdict };

export function shouldRunAlertCron(now = Date.now()) {
  return isContinuousTrading(now);
}

// —— 与前端 alertStore.describeAlert 同口径 ——
function describeAlert(a) {
  if (a.type === 'limitup') return `临近涨停(涨幅≥${formatPriceLimitThreshold(a, true)}%)`;
  if (a.type === 'limitdown') return `临近跌停(跌幅≥${formatPriceLimitThreshold(a, true)}%)`;
  // 行动点预警(补仓/减仓):补仓点 ≤ X元 · 补1手
  if (a.type === 'price' && a.actKind) {
    const l = a.actKind === 'add' ? '补仓点' : '减仓点';
    const qty = a.opQty ? ' · ' + a.opQty : '';
    return `${l} ${OP_LABEL[a.op] || ''} ${a.value}元${qty}`;
  }
  const label = { price: '到价', pct: '涨跌幅', vol: '量比', turnover: '换手率' }[a.type] || a.type;
  const unit = { price: '元', pct: '%', turnover: '%' }[a.type] || '';
  return `${label} ${OP_LABEL[a.op] || ''} ${a.value}${unit}`;
}

// —— 与前端 alertStore.hit 同口径 ——
function hit(a, q) {
  if (!q) return null;
  const cmp = (v, op, t) => (op === 'lte' ? v <= t : v >= t);
  switch (a.type) {
    case 'price': {
      if (q.price == null || !(Number(q.price) > 0)) return null; // 休市/异常返回 0 不误触
      if (cmp(q.price, a.op, a.value)) return `现价 ${q.price} ${OP_LABEL[a.op]} ${a.value}`;
      return null;
    }
    case 'pct':
      if (q.pct == null) return null;
      return cmp(q.pct, a.op, a.value) ? `涨跌幅 ${Number(q.pct).toFixed(2)}% ${OP_LABEL[a.op]} ${a.value}%` : null;
    case 'vol':
      if (q.volRatio == null) return null;
      return cmp(q.volRatio, a.op, a.value) ? `量比 ${Number(q.volRatio).toFixed(2)} ${OP_LABEL[a.op]} ${a.value}` : null;
    case 'turnover':
      if (q.turnover == null) return null;
      return cmp(q.turnover, a.op, a.value) ? `换手 ${Number(q.turnover).toFixed(2)}% ${OP_LABEL[a.op]} ${a.value}%` : null;
    case 'limitup': {
      const security = { code: q.code || a.code, name: q.name || a.name, pct: q.pct };
      return isNearPriceLimit(security, 'up') ? `${q.name || a.name || ''} 涨幅 ${Number(q.pct).toFixed(2)}%,临近/触及涨停` : null;
    }
    case 'limitdown': {
      const security = { code: q.code || a.code, name: q.name || a.name, pct: q.pct };
      return isNearPriceLimit(security, 'down') ? `${q.name || a.name || ''} 跌幅 ${Number(q.pct).toFixed(2)}%,临近/触及跌停` : null;
    }
    default:
      return null;
  }
}

export function cloudAlertsForEvaluation(alerts = [], settings = {}) {
  return alerts.filter((alert) =>
    alert
    && alert.enabled
    && !alert.triggeredAt
    && (
      (!alert.candCode && !alert.actCode)
      || isAdviceReviewEnabled(settings, alert.code)
    )
  );
}

// 进程内调用 quote handler 取实时报价 map(code→q)
function invokeQuote(codes) {
  return new Promise((resolve) => {
    const chunks = [];
    let timer = null;
    const res = {
      statusCode: 200, _h: {},
      setHeader() {}, getHeader() {}, status(c) { this.statusCode = c; return this; },
      write(s) { chunks.push(String(s)); return true; },
      send(p) { finish(p); return this; },
      json(o) { finish(o); return this; },
      end(p) { finish(p != null ? p : null); return this; },
    };
    let done = false;
    function finish(p) {
      if (done) return;
      done = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      let out = p;
      if (typeof out === 'string') { try { out = JSON.parse(out); } catch { /* keep */ } }
      if (out == null && chunks.length) { try { out = JSON.parse(chunks.join('')); } catch { out = null; } }
      const map = {};
      for (const it of (out && out.list) || []) if (it && it.code) map[it.code] = it;
      resolve(map);
    }
    timer = setTimeout(() => finish(null), 12000);
    if (timer && typeof timer.unref === 'function') timer.unref();
    try {
      const r = quoteHandler({ method: 'GET', query: { codes: codes.join(',') }, headers: {} }, res);
      if (r && typeof r.then === 'function') r.catch(() => finish(null));
    } catch { finish(null); }
  });
}

function positionContextOf(data, code) {
  const holding = Array.isArray(data?.holding) ? data.holding : [];
  const status = t1StatusOf(holding, data?.closed || [], code);
  return {
    verified: true,
    liveQty: status.liveQty,
    boughtToday: status.boughtToday,
    sellableToday: status.sellableToday,
    holdingIds: new Set(
      holding
        .filter((item) =>
          String(item?.code) === String(code) &&
          !!livePositionOf([item], code)
        )
        .map((item) => String(item.id)),
    ),
  };
}

function retireIfPositionChanged(alert, context, now = Date.now()) {
  const gate = positionGateForAlert(alert, context);
  if (gate.allowed || gate.transient) return gate;
  Object.assign(alert, retirePositionAlert(alert, gate, now));
  return gate;
}

async function verifyLatestPosition(nick, alert) {
  if (!requiresPositionCheck(alert)) {
    return { allowed: true, context: null };
  }
  try {
    const latest = await readAccount(nick);
    if (!latest?.data) throw new Error('account snapshot missing');
    const context = positionContextOf(latest.data, alert.code);
    return { ...positionGateForAlert(alert, context), context };
  } catch {
    const context = { verified: false };
    return { ...positionGateForAlert(alert, context), context };
  }
}

function alertStamp(alert) {
  return Math.max(
    Number(alert?.retiredAt) || 0,
    Number(alert?.supersededAt) || 0,
    Number(alert?.triggeredAt) || 0,
    Number(alert?.lastJudgeAt) || 0,
    Number(alert?.watchingAt) || 0,
    Number(alert?.rearmedAt) || 0,
    Number(alert?.outcomeUpdatedAt) || 0,
    Number(alert?.positionCheckedAt) || 0,
  );
}

async function persistProcessedAccount(
  processed,
  deadEndpoints = [],
  storage = null,
  wakeups = [],
) {
  const latest = storage
    ? await readAccount(processed.nick, storage)
    : await readAccount(processed.nick);
  if (!latest?.data) throw new Error('账号最新快照读取失败');
  const processedData = processed.data || {};
  const processedAlerts = new Map(
    (processedData.alerts || [])
      .filter((alert) => alert?.id)
      .map((alert) => [alert.id, alert]),
  );
  latest.data.alerts = (latest.data.alerts || []).map((alert) => {
    const server = processedAlerts.get(alert?.id);
    return server && alertStamp(server) > alertStamp(alert) ? server : alert;
  });

  const dead = new Set(deadEndpoints);
  latest.data.pushSubs = (latest.data.pushSubs || [])
    .filter((subscription) => !dead.has(subscription?.endpoint));

  const decisions = new Map(
    (latest.data.decisionLog || [])
      .filter((event) => event?.id)
      .map((event) => [event.id, event]),
  );
  for (const event of (processedData.decisionLog || [])) {
    if (!event?.id) continue;
    const current = decisions.get(event.id);
    const eventStamp = Math.max(Number(event.outcomeUpdatedAt) || 0, Number(event.at) || 0);
    const currentStamp = Math.max(Number(current?.outcomeUpdatedAt) || 0, Number(current?.at) || 0);
    if (!current || eventStamp > currentStamp) decisions.set(event.id, event);
  }
  latest.data.decisionLog = [...decisions.values()]
    .sort((a, b) => (b.at || 0) - (a.at || 0))
    .slice(0, 1000);
  let adviceQueued = 0;
  for (const wakeup of wakeups) {
    const queued = queueAdviceReviewForVerdict(
      latest.data,
      wakeup?.alert,
      wakeup?.verdict,
      wakeup?.at,
    );
    if (queued.queued) adviceQueued++;
  }
  const workerNeeded = adviceQueued > 0 && needsWorkerDispatch(latest.data);
  if (storage) await writeAccount(latest, storage);
  else await writeAccount(latest);
  return { adviceQueued, workerNeeded };
}

async function processAccount(acc) {
  const data = acc.data || {};
  const alerts = Array.isArray(data.alerts) ? data.alerts : [];
  const subs = Array.isArray(data.pushSubs) ? data.pushSubs : [];
  const adviceMap = (data.advice && typeof data.advice === 'object') ? data.advice : {};
  // 智能确认默认开启;账号显式关掉(settings.smartConfirm===false)则回退「见价即强推」旧行为。
  const smartOn = !(data.settings && data.settings.smartConfirm === false);
  let changed = false, hits = 0, sent = 0;
  const wakeups = [];

  // 第一层硬清理：每轮先按刚从 OSS 读取的账本淘汰已清仓、持仓 ID 已消失的旧预警。
  for (const alert of alerts) {
    if (!alert?.enabled || alert.triggeredAt || !requiresPositionCheck(alert)) continue;
    const gate = retireIfPositionChanged(alert, positionContextOf(data, alert.code));
    if (!gate.allowed && !gate.transient) changed = true;
  }

  // 同股、同方向、同价位的 AI 预警只保留信息更完整的一条，避免重复弱提醒和重复 Judge。
  for (const duplicate of duplicateSmartAlerts(alerts, sideOf)) {
    const alert = alerts.find((item) => item.id === duplicate.id);
    if (!alert) continue;
    alert.enabled = false;
    alert.phase = 'superseded';
    alert.supersededAt = Date.now();
    alert.supersededBy = duplicate.primaryId;
    alert.triggeredMsg = '与同价同方向智能预警合并';
    changed = true;
  }

  // armed/watching 均需处理:enabled && 未最终触发(confirmed)
  const active = cloudAlertsForEvaluation(alerts, data.settings);
  const outcomePending = alerts.filter((alert) =>
    alert?.phase === 'confirmed' &&
    alert.triggeredAt &&
    Date.now() - alert.triggeredAt <= 45 * 60 * 1000 &&
    !alert.judgeOutcomes?.m30 &&
    (
      (!alert.candCode && !alert.actCode)
      || isAdviceReviewEnabled(data.settings, alert.code)
    )
  );
  const sidePriority = { stop: 3, sell: 2, buy: 1 };
  // 是否执行云端闭环与浏览器通知权限无关；没有 Push 订阅时仍确认并更新军师，只是不发系统通知。
  const activeForEvaluation = active.slice().sort((a, b) => {
    const aWatching = a.phase === 'watching' ? 1 : 0;
    const bWatching = b.phase === 'watching' ? 1 : 0;
    if (aWatching !== bWatching) return bWatching - aWatching;
    const sideDiff = (sidePriority[sideOf(b)] || 0) - (sidePriority[sideOf(a)] || 0);
    if (sideDiff) return sideDiff;
    return (a.lastJudgeAt || 0) - (b.lastJudgeAt || 0);
  });
  if (!activeForEvaluation.length && !outcomePending.length) {
    return { changed, hits, sent, judgeCalls: 0, deadEndpoints: [], wakeups };
  }

  const codes = [...new Set([...activeForEvaluation, ...outcomePending].map((a) => a.code))];
  const quoteMap = await invokeQuote(codes);

  const dead = new Set();
  const collectDead = (r) => { sent += r.sent; for (const ep of r.deadEndpoints) dead.add(ep); };
  let judgeCalls = 0;  // 本轮已消耗的 LLM judge 次数(受 JUDGE_BUDGET_PER_ROUND 上限约束)

  // 强提示后的后验表现：买入看后续上涨，卖出/止损看后续下跌，正数代表判定方向正确。
  for (const alert of outcomePending) {
    const quote = quoteMap[alert.code];
    if (!(Number(quote?.price) > 0)) continue;
    const outcome = collectOutcomeSnapshots(alert, quote.price);
    if (!outcome.changed) continue;
    alert.judgeOutcomes = outcome.outcomes;
    alert.outcomeUpdatedAt = Date.now();
    const judgeEvent = (data.decisionLog || []).find((event) =>
      event?.kind === 'judge' && event.alertId === alert.id
    );
    if (judgeEvent) {
      judgeEvent.judgeOutcomes = outcome.outcomes;
      judgeEvent.outcomeUpdatedAt = alert.outcomeUpdatedAt;
    }
    changed = true;
  }

  // 该预警是否走智能二段确认:仅对【价位类 + AI 派生(带 phase 字段)】启用;
  //   手动到价/涨跌幅/量比/涨跌停等 → 无 phase → 老逻辑(见价即强推)。
  const isSmart = (a) => smartOn && a.type === 'price' && !!a.phase && a.phase !== 'confirmed' && a.phase !== 'invalid';

  for (const storedAlert of activeForEvaluation) {
    const t1Alert = applyT1ToAlert(
      storedAlert,
      t1StatusOf(data.holding || [], data.closed || [], storedAlert.code),
    );
    if (JSON.stringify(t1Alert) !== JSON.stringify(storedAlert)) {
      Object.assign(storedAlert, t1Alert);
      storedAlert.positionCheckedAt = Date.now();
      changed = true;
    }
    const a = storedAlert;
    if (a.t1Blocked) continue;
    const q = quoteMap[a.code];
    if (!isSmart(a)) {
      // —— 老逻辑:命中即强推并停用(向后兼容,不受智能确认影响)——
      const msg = hit(a, q);
      if (!msg) continue;
      const latest = await verifyLatestPosition(acc.nick, a);
      if (!latest.allowed) {
        if (!latest.transient) {
          Object.assign(a, retirePositionAlert(a, latest));
          changed = true;
        }
        continue;
      }
      const latestT1 = latest.context ? applyT1ToAlert(a, latest.context) : a;
      if (latestT1.t1Blocked) {
        Object.assign(a, latestT1);
        a.positionCheckedAt = Date.now();
        changed = true;
        continue;
      }
      hits++;
      const notification = buildAlertNotification({
        alert: a,
        quote: q,
        stage: 'trigger',
        reason: msg,
      });
      collectDead(await sendPush(subs, { ...notification, code: a.code, tag: 'alert-' + a.id, url: '/' }));
      a.triggeredAt = Date.now(); a.triggeredMsg = msg; a.enabled = false;
      changed = true;
      continue;
    }

    // —— 智能二段确认 ——
    if (a.phase === 'armed' || !a.phase) {
      // 阶段一:价格触及关键价位 → 发【弱提醒】,进入「观察确认中」,继续监控真正时机(不停用)
      const msg = hit(a, q);
      if (!msg) continue;
      const latest = await verifyLatestPosition(acc.nick, a);
      if (!latest.allowed) {
        if (!latest.transient) {
          Object.assign(a, retirePositionAlert(a, latest));
          changed = true;
        }
        continue;
      }
      const latestT1 = latest.context ? applyT1ToAlert(a, latest.context) : a;
      if (latestT1.t1Blocked) {
        Object.assign(a, latestT1);
        a.positionCheckedAt = Date.now();
        changed = true;
        continue;
      }
      hits++;
      const notification = buildAlertNotification({
        alert: a,
        quote: q,
        stage: 'watch',
        reason: msg,
      });
      collectDead(await sendPush(subs, { ...notification, code: a.code, tag: 'watch-' + a.id, url: '/' }));
      a.phase = 'watching'; a.watchingAt = Date.now(); a.watchingPrice = Number(q?.price) || null; a.watchingMsg = msg;
      changed = true;
      continue;
    }

    if (a.phase === 'watching') {
      const now = Date.now();
      const side = sideOf(a);
      if (!isCurrentAdvicePlan(a, adviceMap[a.code])) {
        a.enabled = false;
        a.phase = 'superseded';
        a.supersededAt = now;
        a.triggeredMsg = '军师主计划已更新，旧执行确认自动撤销';
        changed = true;
        continue;
      }
      const age = a.watchingAt ? now - a.watchingAt : 0;
      // 长时间没有形成确认且价格已离开触发区：重新武装，等待下一次真正触价。
      if (age > WATCHING_MAX_MS && !hit(a, q)) {
        a.phase = 'armed';
        a.watchingAt = null;
        a.watchingPrice = null;
        a.watchingMsg = '';
        a.lastJudgeAt = null;
        a.rearmedAt = now;
        changed = true;
        continue;
      }
      // 阶段二:调用智能确认闸门,判定真正交易时机是否到。
      // ★预算护栏:本轮 judge 调用达上限 → 跳过(维持 watching,下轮再判),避免 watching 堆积时烧光 token/超时。
      if (judgeCalls >= JUDGE_BUDGET_PER_ROUND) continue;
      // 现价缺失(接口异常/休市返回空)时不判定,省一次无谓的 judge 调用。
      if (!q || q.price == null || !(Number(q.price) > 0)) continue;
      if (a.lastJudgeAt && now - a.lastJudgeAt < (JUDGE_INTERVAL_MS[side] || 45000)) continue;
      const beforeJudge = await verifyLatestPosition(acc.nick, a);
      if (!beforeJudge.allowed) {
        if (!beforeJudge.transient) {
          Object.assign(a, retirePositionAlert(a, beforeJudge));
          changed = true;
        }
        continue;
      }
      const latestT1 = beforeJudge.context ? applyT1ToAlert(a, beforeJudge.context) : a;
      if (latestT1.t1Blocked) {
        Object.assign(a, latestT1);
        a.positionCheckedAt = Date.now();
        changed = true;
        continue;
      }
      judgeCalls++;
      let verdict = null;
      try {
        verdict = await judgeConfirmation({
          alert: a,
          name: a.name,
          advice: adviceMap[a.code] && adviceMap[a.code].advice,
          quote: q,
          position: beforeJudge.context,
        });
      } catch (e) { verdict = { decision: 'wait', reason: '确认判定异常:' + String(e && e.message || e) }; }
      if (!verdict) continue;
      a.lastJudgeAt = now;
      a.lastJudgeDecision = verdict.decision;
      a.lastJudgeConfidence = verdict.confidence ?? null;
      a.lastJudgePolicy = verdict.policy || null;
      a.lastJudgePrice = Number(q.price);
      a.lastKnowledgeAction = verdict.knowledgeAction || a.lastKnowledgeAction || null;
      a.judgeCount = (Number(a.judgeCount) || 0) + 1;
      changed = true;
      if (verdict.decision === 'confirm' || verdict.decision === 'invalid') {
        const beforePush = await verifyLatestPosition(acc.nick, a);
        if (!beforePush.allowed) {
          if (!beforePush.transient) {
            Object.assign(a, retirePositionAlert(a, beforePush));
            changed = true;
          }
          continue;
        }
        const pushT1 = beforePush.context ? applyT1ToAlert(a, beforePush.context) : a;
        if (pushT1.t1Blocked) {
          Object.assign(a, pushT1);
          a.positionCheckedAt = Date.now();
          changed = true;
          continue;
        }
      }
      if (verdict.decision === 'confirm') {
        hits++;
        const actZh = actionLabelOf(a);
        const notification = buildAlertNotification({
          alert: a,
          quote: q,
          stage: 'confirm',
          reason: verdict.reason || '多项信号共振确认',
        });
        collectDead(await sendPush(subs, { ...notification, code: a.code, tag: 'confirm-' + a.id, url: '/' }));
        a.phase = 'confirmed'; a.triggeredAt = Date.now(); a.triggeredMsg = `确认${actZh}:${verdict.reason || ''}`; a.enabled = false;
        a.decisionPrice = Number(q.price);
        const decisionSide = resolveDecisionSide(verdict, side);
        a.decisionSide = decisionSide;
        a.judgeOutcomes = {};
        const judgeEvent = {
          id: `judge:${a.id}`,
          kind: 'judge',
          alertId: a.id,
          at: a.triggeredAt,
          code: a.code,
          name: a.name || a.code,
          decisionSide,
          decisionPrice: a.decisionPrice,
          confidence: verdict.confidence ?? null,
          policy: verdict.policy || null,
          reason: verdict.reason || '',
          knowledgeAction: verdict.knowledgeAction || null,
          judgeOutcomes: {},
        };
        data.decisionLog = [
          judgeEvent,
          ...(data.decisionLog || []).filter((event) => event?.id !== judgeEvent.id),
        ].slice(0, 1000);
        wakeups.push({ alert: { ...a }, verdict, at: a.triggeredAt });
        changed = true;
      } else if (verdict.decision === 'invalid') {
        // 交易逻辑已被破坏(如买点却已放量跌破失效价)→ 撤下该点位,发一次说明,不再纠缠
        const notification = buildAlertNotification({
          alert: a,
          quote: q,
          stage: 'invalid',
          reason: verdict.reason || '关键条件已破坏',
        });
        collectDead(await sendPush(subs, { ...notification, code: a.code, tag: 'invalid-' + a.id, url: '/' }));
        a.phase = 'invalid'; a.triggeredAt = Date.now(); a.triggeredMsg = `已失效:${verdict.reason || ''}`; a.enabled = false;
        wakeups.push({ alert: { ...a }, verdict, at: a.triggeredAt });
        changed = true;
      }
      // wait → 维持 watching,静默继续观察
    }
  }
  if (dead.size) { data.pushSubs = subs.filter((s) => !dead.has(s.endpoint)); changed = true; }
  return { changed, hits, sent, judgeCalls, deadEndpoints: [...dead], wakeups };
}

export default async function handler(req, res) {
  if (preflight(req, res)) return;
  applyCors(res);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  const CRON_KEY = process.env.CRON_KEY;
  if (CRON_KEY) {
    const given = req.headers['x-cron-key'] || (req.query && req.query.key) || (req.body && req.body.key);
    if (given !== CRON_KEY) { res.statusCode = 401; return res.end(JSON.stringify({ ok: false, error: 'unauthorized' })); }
  }
  if (!shouldRunAlertCron()) {
    return res.end(JSON.stringify({ ok: true, skipped: 'outside-trading-hours' }));
  }
  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const onlyNick = body.nick ? String(body.nick) : null;
  const started = Date.now();

  // —— 内部自循环:FC Timer 最细为 1 分钟粒度,想「更快」就让单次调用在函数内
  //    连续跑多轮。每轮重新拉账号(拿最新 phase/新加的预警)→评估→写回,轮间 sleep 后再来一轮,
  //    直到耗尽时间预算。这样有效监控频率 = 轮间隔(默认 8s),不再受 cron 粒度限制。
  //    可调(env 优先,body 可临时覆盖):
  //      CRON_ALERT_ROUND_MS   轮间隔毫秒(默认 8000,下限 3000 防烧 token)
  //      CRON_ALERT_BUDGET_MS  单次总预算毫秒(默认 55000,须小于 FC timeout)
  const clampInt = (v, def, lo, hi) => {
    const n = parseInt(v, 10);
    if (!Number.isFinite(n)) return def;
    return Math.max(lo, Math.min(hi, n));
  };
  const roundMs = clampInt(body.roundMs != null ? body.roundMs : process.env.CRON_ALERT_ROUND_MS, 8000, 3000, 60000);
  const budgetMs = clampInt(body.budgetMs != null ? body.budgetMs : process.env.CRON_ALERT_BUDGET_MS, 55000, 5000, 110000);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  try {
    // 预热 LLM 运行时配置(judge 端点/模型),供智能确认闸门使用;失败不阻断(闸门会回退确定性信号)。
    try { await ensureConfig({ maxAgeMs: 20000 }); } catch { /* ignore */ }

    let totalHits = 0, totalSent = 0, totalJudgeCalls = 0, totalAdviceQueued = 0, touched = 0, rounds = 0, lastAccounts = 0;
    // 至少跑 1 轮;之后只要「距开始 + 一轮最坏耗时」仍在预算内就继续。
    while (true) {
      rounds++;
      let accounts = await listAllAccounts();
      if (onlyNick) accounts = accounts.filter((a) => a.nick === onlyNick);
      lastAccounts = accounts.length;
      for (const acc of accounts) {
        let r;
        try { r = await processAccount(acc); } catch (e) { r = { changed: false, hits: 0, sent: 0, error: String(e.message || e) }; }
        if (r.changed) {
          touched++;
          try {
            const persisted = await persistProcessedAccount(
              acc,
              r.deadEndpoints || [],
              null,
              r.wakeups || [],
            );
            totalAdviceQueued += persisted.adviceQueued || 0;
            if (persisted.workerNeeded) {
              try { await scheduleAdviceWorker(acc.nick); } catch { /* 5分钟兜底续跑 */ }
            }
          } catch { /* ignore */ }
        }
        totalHits += r.hits || 0; totalSent += r.sent || 0;
        totalJudgeCalls += r.judgeCalls || 0;
      }
      // 预算判断:若「再睡一轮 + 预留一轮评估余量」会超预算,则收尾退出。
      const elapsed = Date.now() - started;
      if (elapsed + roundMs + 3000 >= budgetMs) break;
      await sleep(roundMs);
    }
    return res.end(JSON.stringify({ ok: true, accounts: lastAccounts, hits: totalHits, sent: totalSent, judgeCalls: totalJudgeCalls, adviceQueued: totalAdviceQueued, touched, rounds, roundMs, elapsedMs: Date.now() - started }));
  } catch (e) {
    return res.end(JSON.stringify({ ok: false, error: String(e.message || e), elapsedMs: Date.now() - started }));
  }
}

export const __test = {
  alertStamp,
  describeAlert,
  hit,
  persistProcessedAccount,
  positionContextOf,
  retireIfPositionChanged,
}
